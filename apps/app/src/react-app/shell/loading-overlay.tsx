/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { RecoveryActionResult, RecoveryRelease, StartFailureAnswer } from "@/app/lib/desktop";
import type { DenAppVersionMetadata, DenDesktopConfig } from "@/app/lib/den";
import { readFreshDenAppVersionMetadata } from "@/app/lib/version-gate";
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { bootOverlayCanHide, useBootState, useBootOverlayVisible } from "./boot-state";
import { useCloudWorkspaceStatus } from "./cloud-workspace-overlay";
import { shouldSuppressBootOverlayForGateway } from "./cloud-workspace-status";
import { OwDotTicker } from "./dot-ticker";

async function loadRecoveryPolicy(
  refreshDesktopConfig: () => Promise<DenDesktopConfig>,
): Promise<{ metadata: DenAppVersionMetadata; policy: DenDesktopConfig } | null> {
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 10_000));
  return Promise.race([
    Promise.all([readFreshDenAppVersionMetadata(), refreshDesktopConfig()])
      .then(([metadata, policy]) => ({ metadata, policy }))
      .catch(() => null),
    timeout,
  ]);
}

// One start-failure report per page load (Try again reloads the page).
let startFailureReported: Promise<StartFailureAnswer | null> | null = null;

export const RESET_APP_DATA_CONFIRM =
  "Reset app data?\n\nmarsai.click moves its local settings (workspace list, local server data) into a backup folder, nothing is deleted, and restarts. Your chats, sign-in and project files stay. After the restart you can restore the previous data.";
export const RESET_APP_DATA_CONFIRM_WITH_CHATS =
  "Reset app data?\n\nmarsai.click's local chat database looks damaged. marsai.click moves its local data, including chat history, into a backup folder, nothing is deleted, and restarts. Your sign-in and project files stay. After the restart you can restore the previous data.";

/**
 * Quiet, opaque boot overlay. Solid surface fill so nothing bleeds through.
 * A minimal typographic beat plus a small dot ticker. Fades once both the
 * boot hook and the first route load are ready.
 */
export function LoadingOverlay() {
  const visible = useBootOverlayVisible();
  const { phase, routeReady, message, error } = useBootState();
  const cloudWorkspace = useCloudWorkspaceStatus();
  const suppressForGateway = shouldSuppressBootOverlayForGateway({
    gatewayMode: cloudWorkspace.gatewayMode,
    signedIn: cloudWorkspace.visible,
    variant: cloudWorkspace.viewModel.variant,
  });
  const { config: desktopPolicy, refreshFresh: refreshDesktopPolicy } = useDesktopConfig();
  const [releases, setReleases] = useState<RecoveryRelease[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [actionState, setActionState] = useState<string | null>(null);
  const [failureAnswer, setFailureAnswer] = useState<StartFailureAnswer | null>(null);

  useEffect(() => {
    if (!error) return;
    const report = window.__MARS_ELECTRON__?.startup?.reportFailure;
    if (!report) return;
    let cancelled = false;
    startFailureReported ??= report({ message: error }).catch(() => null);
    void startFailureReported.then((answer) => {
      if (!cancelled) setFailureAnswer(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [error]);

  useEffect(() => {
    if (!error) return;
    let cancelled = false;
    const bridge = window.__MARS_ELECTRON__?.recovery;
    if (!bridge?.list) return;
    const cachedPolicy = {
      versions: [],
      minimumVersion: "0.0.0",
      ...(Array.isArray(desktopPolicy.allowedDesktopVersions)
        ? { allowedVersions: desktopPolicy.allowedDesktopVersions }
        : {}),
    };
    void bridge.list(cachedPolicy)
      .then((result) => {
        if (!cancelled && result.ok) setReleases(result.releases);
      })
      .catch(() => undefined);
    if (window.__marsRecoveryControl) {
      return () => {
        cancelled = true;
      };
    }
    void loadRecoveryPolicy(refreshDesktopPolicy)
      .then((fresh) => fresh ? bridge.list?.({
        versions: fresh.metadata.publishedDesktopVersions,
        minimumVersion: fresh.metadata.minAppVersion,
        ...(Array.isArray(fresh.policy.allowedDesktopVersions)
          ? { allowedVersions: fresh.policy.allowedDesktopVersions }
          : {}),
      }) : null)
      .then((result) => {
        if (!cancelled && result?.ok) setReleases(result.releases);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktopPolicy, error, refreshDesktopPolicy]);

  const runRecovery = async (action: (() => Promise<RecoveryActionResult>) | undefined) => {
    if (!action) return;
    setActionState("Preparing verified recovery…");
    try {
      const result = await action();
      setActionState(result.ok
        ? result.message ?? "Recovery is ready."
        : result.reason ?? "Recovery could not be started. Please retry.");
    } catch {
      setActionState("Recovery could not be started. Please retry.");
    }
  };

  const useRelease = window.__MARS_ELECTRON__?.recovery?.use;
  const resetAppData = window.__MARS_ELECTRON__?.startup?.resetAppData;
  const repairStore = failureAnswer?.canRepairStore ? window.__MARS_ELECTRON__?.startup?.repairStore : undefined;
  const hint = failureAnswer?.hint ?? null;
  const leadWithReset = failureAnswer?.leadWithReset === true;
  const resetButton = (primary: boolean) => (
    <button
      type="button"
      data-testid="start-failure-reset"
      className={primary
        ? "rounded-md bg-dls-accent px-3 py-2 font-medium text-[var(--dls-accent-fg)]"
        : "rounded-md border border-dls-border px-3 py-2 font-medium text-dls-primary"}
      onClick={() => {
        if (!resetAppData) return;
        const confirmText = failureAnswer?.resetIncludesChats ? RESET_APP_DATA_CONFIRM_WITH_CHATS : RESET_APP_DATA_CONFIRM;
        if (!window.confirm(confirmText)) return;
        setActionState("Restarting with fresh app data…");
        void resetAppData()
          .then((result) => {
            if (result.backupDir) {
              setActionState(`Restarting with fresh app data. Your previous app data is kept in ${result.backupDir}; after the restart, choose Restore previous app data to go back to it.`);
            }
          })
          .catch(() => setActionState("Reset could not be started. Please retry."));
      }}
    >
      Reset app data
    </button>
  );

  if (!visible || (suppressForGateway && !error)) return null;

  const fading = bootOverlayCanHide(phase, routeReady);

  return (
    <div
      className={`pointer-events-auto fixed inset-0 z-[1000] flex items-center justify-center bg-dls-surface transition-opacity duration-[160ms] ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!fading}
      role="status"
    >
      <div className="flex w-full max-w-[320px] flex-col items-center gap-4 px-6 text-center">
        {error ? (
          <div className="flex w-full flex-col gap-3 text-[12px] leading-5">
            <div className="text-base font-medium text-dls-primary">marsai.click couldn't start</div>
            {hint ? (
              <div className="flex flex-col gap-1 rounded-md border border-dls-border px-3 py-2 text-left" data-testid="start-failure-hint">
                <div className="font-medium text-dls-primary">{hint.title}</div>
                <div className="text-dls-secondary">{hint.body}</div>
              </div>
            ) : (
              <div className="text-dls-secondary">Try again. If it keeps failing, return to a version that works on this computer.</div>
            )}
            {resetAppData && leadWithReset ? resetButton(true) : null}
            {repairStore ? (
              <button
                type="button"
                className="rounded-md bg-dls-accent px-3 py-2 font-medium text-[var(--dls-accent-fg)]"
                data-testid="start-failure-repair-store"
                onClick={() => {
                  setActionState("Fixing access to marsai.click's local data and restarting…");
                  void repairStore()
                    .then((result) => {
                      if (!result.ok) setActionState("Some files could not be changed. Restarting anyway; if it still can't start, use Reset app data.");
                    })
                    .catch(() => setActionState("The fix could not be started. Use Reset app data."));
                }}
              >
                Fix and restart
              </button>
            ) : null}
            <button
              type="button"
              className={repairStore || leadWithReset
                ? "rounded-md border border-dls-border px-3 py-2 font-medium text-dls-primary"
                : "rounded-md bg-dls-accent px-3 py-2 font-medium text-[var(--dls-accent-fg)]"}
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
            <button
              type="button"
              disabled={!releases.some((release) => release.marking === "previous")}
              className="rounded-md border border-dls-border px-3 py-2 font-medium text-dls-primary disabled:opacity-50"
              onClick={() => void runRecovery(window.__MARS_ELECTRON__?.recovery?.restorePrevious)}
            >
              Restore previous version
            </button>
            <button
              type="button"
              className="rounded-md border border-dls-border px-3 py-2 font-medium text-dls-primary"
              onClick={() => setShowPicker((value) => !value)}
            >
              Pick another version
            </button>
            {showPicker ? (
              <div className="flex flex-col gap-2">
                {releases.map((release) => (
                  <div key={release.id} className="flex items-center gap-2">
                    {release.marking === "current" ? (
                      <div className="flex-1 rounded-md border border-dls-border px-3 py-2 text-left text-dls-secondary">
                        {release.version}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="flex-1 rounded-md border border-dls-border px-3 py-2 text-left text-dls-primary"
                        onClick={() => void runRecovery(
                          useRelease
                            ? () => useRelease(release.id)
                            : undefined,
                        )}
                      >
                        Use {release.version}
                      </button>
                    )}
                    {release.marking ? <span className="text-dls-secondary">{release.marking}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {resetAppData && !leadWithReset ? resetButton(false) : null}
            {actionState ? <div className="text-dls-secondary">{actionState}</div> : null}
            <details className="text-left text-dls-secondary">
              <summary className="cursor-pointer">Technical details</summary>
              <div className="mt-2 break-words">{error}</div>
            </details>
          </div>
        ) : (
          <>
            <OwDotTicker size="md" />
            <div className="text-[12px] leading-5 text-dls-secondary">
              {message || "Preparing workspace"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
