// Signed-out gate: without a MarsAI API key the app has no models to offer,
// so a blurred modal asks for one (sk-mars-… from marsai.click/app/keys)
// before the composer is usable. The sidebar footer reopens it after a dismiss.

import React from "react";
import { create } from "zustand";

import {
  marsAccountConnectApiKey,
  marsAccountStatus,
} from "../../app/lib/desktop";
import { refreshAccountStatus, useAccountStatusStore } from "../../app/lib/quality";

type ApiKeyGateStore = {
  /** Explicitly opened (sidebar footer) or auto-opened by the signed-out check. */
  open: boolean;
  /** The user closed the auto-opened gate; never auto-open again this run. */
  dismissed: boolean;
  show: () => void;
  dismiss: () => void;
  hide: () => void;
};

export const useApiKeyGate = create<ApiKeyGateStore>((set) => ({
  open: false,
  dismissed: false,
  show: () => set({ open: true }),
  dismiss: () => set({ open: false, dismissed: true }),
  hide: () => set({ open: false }),
}));

export function openApiKeyGate(): void {
  useApiKeyGate.getState().show();
}

export function ApiKeyGate() {
  const status = useAccountStatusStore((store) => store.status);
  const open = useApiKeyGate((store) => store.open);
  const dismissed = useApiKeyGate((store) => store.dismissed);
  const show = useApiKeyGate((store) => store.show);
  const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    const refresh = () => void refreshAccountStatus(marsAccountStatus);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const signedOut = status !== null && status.gatewayConfigured && status.connected !== true;

  React.useEffect(() => {
    if (signedOut && !dismissed && !open) show();
  }, [signedOut, dismissed, open, show]);

  if (!signedOut || !open) return null;

  async function connect() {
    const key = apiKey.trim();
    if (!key || busy) return;
    setBusy(true);
    setMessage("Checking the API key…");
    try {
      await marsAccountConnectApiKey({ apiKey: key });
      await refreshAccountStatus(marsAccountStatus);
      useApiKeyGate.getState().hide();
      setApiKey("");
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The API key could not be connected.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-background/60 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Add your MarsAI API key"
      data-testid="api-key-gate"
    >
      <div className="w-full max-w-sm rounded-2xl border border-dls-border bg-dls-surface p-6 shadow-xl">
        <div className="text-[15px] font-semibold text-dls-text">Add your MarsAI API key</div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-dls-secondary">
          Paste a key from{" "}
          <a
            href="https://marsai.click/app/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-dls-text underline underline-offset-2 hover:opacity-80"
          >
            marsai.click/app/keys
          </a>
          . It starts with <span className="font-mono">sk-mars-</span>. New accounts get 15M free AI
          credits for Claude, DeepSeek, Qwen, MiniMax, GLM Flash and more.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <input
            type="password"
            className="h-9 min-w-0 flex-1 rounded-md border border-dls-border bg-dls-background px-2.5 text-[13px] text-dls-text outline-none focus:border-ring"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-mars-…"
            autoComplete="off"
            autoFocus
            data-testid="api-key-gate-input"
          />
          <button
            type="submit"
            disabled={busy || !apiKey.trim()}
            className="rounded-lg bg-dls-text px-4 py-2 text-[13px] font-medium text-dls-background disabled:opacity-50"
            data-testid="api-key-gate-connect"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
        {message ? (
          <div className="mt-2 text-[11px] text-dls-secondary" role="status" data-testid="api-key-gate-message">
            {message}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => useApiKeyGate.getState().dismiss()}
          className="mt-4 text-[11px] text-dls-secondary underline underline-offset-2 hover:text-dls-text"
          data-testid="api-key-gate-dismiss"
        >
          I&apos;ll add it later
        </button>
      </div>
    </div>
  );
}
