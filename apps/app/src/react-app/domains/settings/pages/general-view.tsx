/** @jsxImportSource react */
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Coffee,
  Cog,
  FolderLock,
  Mic,
  Paintbrush,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  UserRoundCheck,
} from "lucide-react";

import type { KeepAwakeState, MarsAccountSignOutReason } from "@mars/types/desktop-ipc";

import { Switch } from "@/components/ui/switch";
import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import {
  keepAwakeSet,
  keepAwakeStatus,
  marsAccountConnectApiKey,
  marsAccountSignOut,
  marsAccountStatus,
} from "../../../../app/lib/desktop";
import type { MarsRuntimeApprovals } from "../../../../app/lib/mars-server";
import { marsUsageSummary } from "../../../../app/lib/mars-usage";
import { isElectronRuntime } from "../../../../app/utils";
import {
  FULL_PERMISSIONS_HELP,
  approvalsEnvironmentHint,
  useApprovalMode,
  type ApprovalsClient,
} from "../approval-mode";
import { DiagnosticsSection } from "./diagnostics-section";
import { BEST_PRACTICES_HELP, useBestPractices, type BestPracticesClient } from "../best-practices";
import { useLinuxSandbox, type LinuxSandboxClient } from "../linux-sandbox";
import { LinuxSandboxCard } from "../linux-sandbox-card";
import { BuildathonTrackCard } from "../../buildathon/buildathon";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  /** Server client for the Approvals card; the card is hidden without one. */
  marsClient?: ApprovalsClient | null;
  /** Global guides do not depend on workspace selection or history loading. */
  bestPracticesClient?: BestPracticesClient | null;
  /** Workspace whose engine is reloaded after the approval mode changes. */
  runtimeWorkspaceId?: string | null;
  /** The Linux sandbox card (per project); hidden without a client or a selected workspace. */
  linuxSandboxClient?: LinuxSandboxClient | null;
  sandboxWorkspaceId?: string | null;
  /** The selected local project, for its buildathon track (shown to enrolled accounts only). */
  buildathonProject?: { path: string; name: string } | null;
  /** Builds the sanitized diagnostics bundle with the route's context. */
  buildDiagnosticsBundle?: () => Promise<string>;
};

type NativeAccountStatus = Awaited<ReturnType<typeof marsAccountStatus>>;

type SettingsCardDefinition = { tab: SettingsTab; icon: typeof Sparkles } & (
  | { title: string; desc: string }
  | { titleKey: string; descKey: string }
);

const workspaceCards: SettingsCardDefinition[] = [
  { tab: "preferences", icon: Cog, title: "Preferences", desc: "Default model, reasoning, and compaction." },
  { tab: "permissions", icon: FolderLock, title: "Permissions", desc: "Authorized folders and file access." },
  { tab: "advanced", icon: Wrench, title: "Advanced", desc: "Runtime, engine, recovery, and developer options." },
];

const globalCards: SettingsCardDefinition[] = [
  { tab: "ai", icon: Sparkles, title: "AI Providers", desc: "Connect services that provide AI models." },
  { tab: "appearance", icon: Paintbrush, title: "Appearance", desc: "Theme, font size, and display." },
  { tab: "voice", icon: Mic, title: "Voice", desc: "Dictation, microphone, and hotkey." },
  { tab: "environment", icon: Terminal, title: "Environment", desc: "Environment variables and paths." },
  { tab: "updates", icon: RefreshCcw, title: "Updates", desc: "App version and update channel." },
];

function cardTitle(card: SettingsCardDefinition) {
  return "titleKey" in card ? t(card.titleKey) : card.title;
}

function cardDescription(card: SettingsCardDefinition) {
  return "descKey" in card ? t(card.descKey) : card.desc;
}

function SettingsCard(props: {
  icon: typeof Sparkles;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex items-center gap-3 rounded-2xl border border-dls-border bg-dls-surface p-4 text-left transition-colors hover:bg-dls-hover"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
        <props.icon size={16} className="text-dls-secondary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-dls-text">{props.title}</div>
        <div className="text-[11px] text-dls-secondary">{props.desc}</div>
      </div>
      <ArrowRight size={14} className="shrink-0 text-dls-secondary" />
    </button>
  );
}

export type AccountSignOutOutcome = {
  remoteRevoked: boolean;
  /** Absent when the desktop bridge predates the outcome reasons. */
  reason?: MarsAccountSignOutReason;
};

/**
 * The settings line shown after sign-out. It names the account server and
 * says exactly what happened to the remote device session.
 */
export function accountSignOutMessage(outcome: AccountSignOutOutcome, server?: string | null): string {
  const host = server?.trim() || "the account server";
  switch (outcome.reason) {
    case "revoked":
      return `Signed out on this device and revoked its device session on ${host}.`;
    case "already_revoked":
      return `Signed out on this device. ${host} had already revoked this device session.`;
    case "endpoint_missing":
      return `Signed out on this device. ${host} has no remote sign-out endpoint, so the device session was not revoked there.`;
    case "unreachable":
      return `Signed out on this device. ${host} could not be reached, so the device session was not revoked there.`;
    default:
      return outcome.remoteRevoked
        ? `Signed out on this device and revoked its device session on ${host}.`
        : `Signed out on this device. The device session on ${host} could not be revoked.`;
  }
}

/** Names the account server the app is connected to, or will connect to on sign-in. */
export function accountServerLine(account: Pick<NativeAccountStatus, "connected" | "gatewayHost">): string | null {
  const host = account.gatewayHost?.trim();
  if (!host) return null;
  return account.connected ? `Connected to ${host}` : `Account server: ${host}`;
}

/**
 * Settings > General > Approvals. The mode, busy flag and status come from
 * useApprovalMode, which the composer's "Full permissions" switch shares.
 */
export function ApprovalsCard(props: {
  approvals: MarsRuntimeApprovals | null;
  busy: boolean;
  status: string;
  onToggle: (enabled: boolean) => void;
}) {
  const hint = props.approvals ? approvalsEnvironmentHint(props.approvals) : null;
  const full = props.approvals?.mode === "full";
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
        Approvals
      </div>
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <ShieldCheck size={17} className={full ? "text-amber-400" : "text-dls-secondary"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-dls-text">Full permissions</div>
          <div className="text-[11px] text-dls-secondary">{FULL_PERMISSIONS_HELP}</div>
          {hint ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" data-testid="approvals-env-hint">{hint}</div>
          ) : null}
          {props.status ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" data-testid="approvals-status">{props.status}</div>
          ) : null}
        </div>
        <Switch
          aria-label="Full permissions"
          checked={full}
          disabled={props.busy || !props.approvals || hint !== null}
          onCheckedChange={props.onToggle}
        />
      </div>
    </div>
  );
}

export function BestPracticesCard(props: {
  enabled: boolean | null;
  busy: boolean;
  status: string;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">Best practices</div>
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Sparkles size={17} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-dls-text">Best practices</div>
          <div id="best-practices-help" className="text-[11px] text-dls-secondary">{BEST_PRACTICES_HELP}</div>
          {props.status ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" role="status" data-testid="best-practices-status">{props.status}</div>
          ) : null}
        </div>
        <Switch
          aria-label="Best practices"
          aria-describedby="best-practices-help"
          checked={props.enabled === true}
          disabled={props.busy || props.enabled === null}
          onCheckedChange={props.onToggle}
        />
      </div>
    </div>
  );
}

export const KEEP_AWAKE_TITLE = "Keep this computer awake while the agent works";
export const KEEP_AWAKE_HELP = "Your computer won't go to sleep while a turn runs, or while the app finishes up as it quits. The screen can still turn off and lock.";

/** Settings > General > Keep awake: a desktop setting (keep-awake.mjs), on by default. */
export function KeepAwakeCard(props: {
  state: KeepAwakeState | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const hint = props.state?.forcedOff
    ? "Off for this launch: MARS_KEEP_AWAKE=0 is set."
    : props.state && !props.state.available
      ? "Not available in this session (remote login or CI)."
      : null;
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">Power</div>
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Coffee size={17} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-dls-text">{KEEP_AWAKE_TITLE}</div>
          <div id="keep-awake-help" className="text-[11px] text-dls-secondary">{KEEP_AWAKE_HELP}</div>
          {hint ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" role="status" data-testid="keep-awake-status">{hint}</div>
          ) : null}
        </div>
        <Switch
          aria-label={KEEP_AWAKE_TITLE}
          aria-describedby="keep-awake-help"
          checked={props.state?.enabled === true}
          disabled={props.busy || props.state === null}
          onCheckedChange={props.onToggle}
        />
      </div>
    </div>
  );
}

function useKeepAwake() {
  const [state, setState] = useState<KeepAwakeState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isElectronRuntime()) return;
    void keepAwakeStatus().then(setState).catch(() => setState(null));
  }, []);
  async function setEnabled(enabled: boolean) {
    setBusy(true);
    try {
      setState(await keepAwakeSet(enabled));
    } catch {
      setState(await keepAwakeStatus().catch(() => null));
    } finally {
      setBusy(false);
    }
  }
  return { state, busy, setEnabled };
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  const [account, setAccount] = useState<NativeAccountStatus | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const approvalsClient = props.marsClient ?? null;
  const approvalMode = useApprovalMode(approvalsClient, props.runtimeWorkspaceId ?? null);
  const bestPracticesClient = props.bestPracticesClient ?? null;
  const bestPractices = useBestPractices(bestPracticesClient);
  const linuxSandboxClient = props.linuxSandboxClient ?? null;
  const linuxSandbox = useLinuxSandbox(linuxSandboxClient, props.sandboxWorkspaceId ?? null);
  const keepAwake = useKeepAwake();

  useEffect(() => {
    if (!isElectronRuntime()) return;
    void marsAccountStatus().then(setAccount).catch(() => setAccount({ connected: false, gatewayConfigured: false }));
  }, []);

  async function connectApiKey(key: string) {
    setAccountBusy(true);
    setAccountMessage("Checking the API key…");
    try {
      await marsAccountConnectApiKey({ apiKey: key });
      setAccount(await marsAccountStatus());
      setApiKey("");
      setApiKeyOpen(false);
      setAccountMessage("API key connected. MarsAI models are ready.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "The API key could not be connected.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function signOutAccount() {
    setAccountBusy(true);
    // Capture the server before sign-out: afterwards the status reports the
    // default server the next sign-in will use, not the one just left.
    const server = account?.gatewayHost ?? null;
    try {
      const result = await marsAccountSignOut();
      const next = await marsAccountStatus().catch(() => null);
      setAccount(next ?? { connected: false, gatewayConfigured: account?.gatewayConfigured ?? false });
      setAccountMessage(accountSignOutMessage(result, server));
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "The account could not be signed out.");
    } finally {
      setAccountBusy(false);
    }
  }

  const serverLine = account ? accountServerLine(account) : null;
  const usage = account?.connected && account.usage ? marsUsageSummary(account.usage) : null;

  return (
    <div className="w-full max-w-3xl space-y-8">
      {isElectronRuntime() && account && (
        <div className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
            Account
          </div>
          <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
              <UserRoundCheck size={17} className={account.connected ? "text-emerald-400" : "text-dls-secondary"} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-dls-text">
                {account.connected ? account.displayName || account.email || "Connected" : "Sign in to your account"}
              </div>
              {account.connected && account.email ? (
                <div className="truncate text-[11px] text-dls-secondary">{account.email}</div>
              ) : null}
              {serverLine ? (
                <div className="truncate text-[11px] text-dls-secondary" data-testid="account-server">
                  {serverLine}
                </div>
              ) : null}
              <div className="mt-0.5 text-[11px] text-dls-secondary">
                {accountMessage || (account.connected
                  ? usage
                    ? usage.line
                    : "marsai.click models are ready on this Mac."
                  : account.gatewayConfigured
                    ? account.reauthorizationRequired
                      ? account.keyringUnavailable
                        ? "Your system keyring is not available right now. Sign in again to continue."
                        : "Your session expired. Sign in again to continue."
                      : "Sign in in your browser, then return here."
                    : "The marsai.click account service has not been configured for this build.")}
              </div>
              {account.connected && account.credentialStorage === "file" ? (
                <div className="mt-0.5 text-[11px] text-dls-secondary" data-testid="account-credential-storage">
                  Signed in. No system keyring is available, so the sign-in is kept in a private file on this computer.
                </div>
              ) : null}
              {usage ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-dls-hover" aria-label={`${Math.round(usage.percent)}% used`}>
                  <div
                    className="h-full rounded-full bg-[#b9f45a]"
                    style={{ width: `${usage.percent}%` }}
                  />
                </div>
              ) : null}
            </div>
            {account.connected ? (
              <button type="button" disabled={accountBusy} onClick={() => void signOutAccount()} className="rounded-lg border border-dls-border px-3 py-2 text-[12px] text-dls-secondary hover:bg-dls-hover disabled:opacity-50">
                Sign out
              </button>
            ) : null}
          </div>
          {!account.connected && account.gatewayConfigured ? (
            <div className="rounded-2xl border border-dls-border bg-dls-surface p-4">
              <div className="text-[12px] font-medium text-dls-text">Connect with an API key</div>
              <div className="mt-0.5 text-[11px] text-dls-secondary">
                Paste a MarsAI API key from marsai.click/app/keys. It starts with sk-mars-.
              </div>
              <form
                className="mt-2 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const key = apiKey.trim();
                  if (key && !accountBusy) void connectApiKey(key);
                }}
              >
                <input
                  type="password"
                  className="h-8 min-w-0 flex-1 rounded-md border border-dls-border bg-dls-background px-2 text-[12px] text-dls-text outline-none focus:border-ring"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-mars-…"
                  autoComplete="off"
                  data-testid="account-api-key-input"
                />
                <button
                  type="submit"
                  disabled={accountBusy || !apiKey.trim()}
                  className="rounded-lg bg-dls-text px-3 py-1.5 text-[12px] font-medium text-dls-background disabled:opacity-50"
                >
                  Connect
                </button>
              </form>
            </div>
          ) : null}
        </div>
      )}
      {/* Workspace settings */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          Workspace
        </div>
        <div className="grid grid-cols-2 gap-2">
          {workspaceCards.map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={cardTitle(card)}
              desc={cardDescription(card)}
              onClick={() => props.onNavigateTab(card.tab)}
            />
          ))}
        </div>
      </div>

      {/* Global settings */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          Global
        </div>
        <div className="grid grid-cols-2 gap-2">
          {globalCards.map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={cardTitle(card)}
              desc={cardDescription(card)}
              onClick={() => props.onNavigateTab(card.tab)}
            />
          ))}
        </div>
      </div>

      {approvalsClient ? (
        <ApprovalsCard
          approvals={approvalMode.approvals}
          busy={approvalMode.busy}
          status={approvalMode.status}
          onToggle={(enabled) => void approvalMode.setFullPermissions(enabled)}
        />
      ) : null}

      {bestPracticesClient ? (
        <BestPracticesCard
          enabled={bestPractices.setting?.enabled ?? null}
          busy={bestPractices.busy}
          status={bestPractices.status}
          onToggle={(enabled) => void bestPractices.setEnabled(enabled)}
        />
      ) : null}

      {isElectronRuntime() ? (
        <KeepAwakeCard
          state={keepAwake.state}
          busy={keepAwake.busy}
          onToggle={(enabled) => void keepAwake.setEnabled(enabled)}
        />
      ) : null}

      {props.buildathonProject ? (
        <BuildathonTrackCard projectPath={props.buildathonProject.path} projectName={props.buildathonProject.name} />
      ) : null}

      {linuxSandboxClient && props.sandboxWorkspaceId ? (
        <LinuxSandboxCard
          box={linuxSandbox.box}
          pending={linuxSandbox.pending}
          problem={linuxSandbox.problem}
          notice={linuxSandbox.notice}
          onToggle={(enabled) => void linuxSandbox.setEnabled(enabled)}
          onRetry={() => void linuxSandbox.retry()}
          onReset={() => void linuxSandbox.reset()}
          onBackend={(backend) => void linuxSandbox.setBackend(backend)}
        />
      ) : null}

      <DiagnosticsSection buildBundle={props.buildDiagnosticsBundle} />
    </div>
  );
}
