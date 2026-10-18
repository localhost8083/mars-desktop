import { useCallback, useEffect, useRef, useState } from "react";

import type { MarsServerClient, MarsWorkspaceBox, MarsWorkspaceBoxProgress } from "@/app/lib/mars-server";

export type LinuxSandboxClient = Pick<MarsServerClient, "getWorkspaceBox" | "setWorkspaceBox" | "setWorkspaceBoxBackend" | "resetWorkspaceBox" | "retryWorkspaceBox">;

export const LINUX_SANDBOX_HELP = "Commands run in a Linux container for this project. Your files stay in this folder; installs are kept per project.";

/** What the user can do next when no sandbox backend works here: one step, with a command to copy when there is one. */
export type LinuxSandboxNextStep = { title: string; detail: string; command: string | null };

/** Everything the status row shows. `tone` picks its icon and colour. */
export type LinuxSandboxView = {
  tone: "off" | "busy" | "ready" | "attention" | "error";
  title: string;
  detail: string | null;
  /** A bar while the image downloads: `value` 0–100, null when the size is not known yet. */
  progress: { value: number | null; label: string } | null;
  step: LinuxSandboxNextStep | null;
  /** The row's button: try again, look again, or switch the backend back to automatic. */
  action: { kind: "retry" | "check" | "auto-backend"; label: string } | null;
  /** The raw error, behind "Show details". */
  errorDetail: string | null;
};

/** A change the user made that the server has not answered yet (the switch already shows it). */
export type LinuxSandboxPending = "on" | "off" | "backend" | "reset" | "retry" | null;

const RUNS_HERE = "Commands run on this computer for now.";
const LOAD_FAILED = "The sandbox status could not be loaded.";

function runtimeLabel(box: MarsWorkspaceBox): string | null {
  const backend = box.backend;
  if (backend?.id) return [backend.label ?? backend.id, backend.version].filter(Boolean).join(" ");
  if (box.runtime?.ok && box.runtime.name) return [box.runtime.name, box.runtime.version].filter(Boolean).join(" ");
  return null;
}

function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 100 ? `${Math.round(mb)}` : mb >= 10 ? mb.toFixed(0) : mb.toFixed(1);
}

/** The download bar: bytes when the server knows the layer sizes, else layers, else the image's rough size. */
export function linuxSandboxProgress(progress: MarsWorkspaceBoxProgress | null | undefined): { value: number | null; label: string } {
  if (progress?.bytesTotal && progress.bytesDone !== null) {
    const value = Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100));
    return { value, label: `${megabytes(progress.bytesDone)} of ${megabytes(progress.bytesTotal)} MB · ${value}%` };
  }
  if (progress && progress.layersTotal > 0) {
    const value = Math.min(100, Math.round((progress.layersDone / progress.layersTotal) * 100));
    return { value, label: `${progress.layersDone} of ${progress.layersTotal} parts · ${value}%` };
  }
  return { value: null, label: "Starting the download…" };
}

function commandIn(reason: string | null | undefined): string | null {
  return reason ? /`([^`]+)`/.exec(reason)?.[1] ?? null : null;
}

/** A short title for a reason the backend probe gave (with its command, when it names one). */
function stepFor(reason: string, platform: string | undefined): LinuxSandboxNextStep | null {
  const command = commandIn(reason);
  if (/sandbox enable/.test(reason)) return { title: "Allow the sandbox on this computer", detail: "Ubuntu blocks it until an admin allows it once. Run this in a terminal (Mars CLI), then check again.", command };
  if (/usermod -aG docker/.test(reason)) return { title: "Let this user run Docker", detail: "Run this in a terminal, log out and back in, then check again.", command };
  if (/wsl --install/.test(reason)) return { title: "Turn on WSL 2", detail: "Run this in PowerShell as administrator, restart the computer, then check again.", command: "wsl --install --no-distribution" };
  if (/wsl --update/.test(reason)) return { title: "Update WSL", detail: "Run this in PowerShell, then check again.", command };
  if (/podman machine start/.test(reason)) return { title: "Start the Podman machine", detail: "Run this in a terminal, then check again.", command };
  if (/apt install bubblewrap/.test(reason)) return { title: "Install bubblewrap", detail: "Run this in a terminal (or use your system's package), then check again.", command };
  if (/Docker Desktop is installed but not running|Docker is installed but not running/.test(reason)) {
    return { title: "Start your container app", detail: "Open Docker Desktop, OrbStack or colima, wait until it is running, then check again.", command: null };
  }
  if (/another macOS user/.test(reason)) {
    return { title: "Start your container app", detail: "Docker here belongs to another account on this Mac. Open Docker Desktop, OrbStack or colima in this account, then check again.", command: null };
  }
  if (/Docker daemon is not running/.test(reason)) return { title: "Start Docker", detail: "Run this in a terminal, then check again.", command: "sudo systemctl start docker" };
  return null;
}

/**
 * The one next step when no backend works here: the first fix a backend's
 * probe names (in the order they are tried), else the usual setup for this
 * computer's OS.
 */
export function linuxSandboxNextStep(box: MarsWorkspaceBox): LinuxSandboxNextStep {
  const platform = box.platform;
  const reasons = [...(box.backend?.alternatives ?? []).map((alt) => alt.reason), box.runtime?.reason ?? null].filter((reason): reason is string => Boolean(reason));
  for (const reason of reasons) {
    const step = stepFor(reason, platform);
    if (step) return step;
  }
  if (platform === "win32") return { title: "Turn on WSL 2", detail: "Run this in PowerShell as administrator, restart the computer, then check again. Docker Desktop or Podman work too.", command: "wsl --install --no-distribution" };
  if (platform === "darwin") return { title: "Install a container app", detail: "colima is free and installs with Homebrew; OrbStack and Docker Desktop work too. Then check again.", command: "brew install colima docker && colima start" };
  if (platform === "linux") return { title: "Install Podman or Docker", detail: "Run this in a terminal (or use your system's package), then check again.", command: "sudo apt install podman" };
  return { title: "No sandbox backend works here", detail: box.runtime?.reason ?? "No container runtime was found on this computer.", command: null };
}

/** The status row: what the sandbox is doing now, or why it is not used and what to do. */
export function linuxSandboxView(box: MarsWorkspaceBox, pending: LinuxSandboxPending = null): LinuxSandboxView {
  const base = { progress: null, step: null, action: null, errorDetail: null };
  if (pending === "on") return { ...base, tone: "busy", title: "Turning on…", detail: RUNS_HERE.replace(" for now", " until the sandbox is ready") };
  if (pending === "off") return { ...base, tone: "busy", title: "Turning off…", detail: null };
  if (pending === "reset") return { ...base, tone: "busy", title: "Resetting the sandbox…", detail: "Removing its container and installs." };
  if (pending === "retry") return { ...base, tone: "busy", title: "Trying again…", detail: null };
  if (!box.on) {
    if (box.source === "env") return { ...base, tone: "off", title: "Off for this app", detail: "Set by MARS_BOX where the app is launched." };
    if (box.hostBuilds?.native) return { ...base, tone: "attention", title: "Off for this project", detail: box.hostBuilds.notice };
    // A buildathon project: turned off here (less reproducible), or the event offers the sandbox.
    if (box.notice) return { ...base, tone: "attention", title: box.source === "project" ? "Off for this project" : "Off", detail: box.notice };
    return { ...base, tone: "off", title: "Off", detail: "Commands run on this computer." };
  }
  const using = runtimeLabel(box);
  switch (box.state) {
    case "downloading":
      return { ...base, tone: "busy", title: "Downloading the sandbox (once)", detail: RUNS_HERE.replace(" for now", " until it is ready"), progress: linuxSandboxProgress(box.progress) };
    case "starting":
      return { ...base, tone: "busy", title: "Starting the sandbox…", detail: using ? `Using ${using}. This takes a few seconds.` : "This takes a few seconds." };
    case "ready":
      // On by choice in a folder with this computer's builds: the warning; on macOS / Windows: that chats run in Linux.
      if (box.hostBuilds && !box.hostBuilds.native) return { ...base, tone: "attention", title: "Ready", detail: box.hostBuilds.notice };
      return { ...base, tone: "ready", title: "Ready", detail: box.boxNotice ?? (using ? `Commands run in a Linux container (${using}).` : "Commands run in a Linux container.") };
    case "failed":
      return { ...base, tone: "error", title: "The sandbox could not start", detail: RUNS_HERE, action: { kind: "retry", label: "Try again" }, errorDetail: box.error ?? box.notice };
    case "unavailable": {
      if (box.backendSetting.value === "native") {
        return { ...base, tone: "attention", title: "The backend is set to Off", detail: "Commands run on this computer. Choose Automatic to use the sandbox.", action: { kind: "auto-backend", label: "Use automatic" } };
      }
      if (box.runtime?.ok) {
        // A backend works, but this project went on without the box (its helpers, a start that timed out).
        return { ...base, tone: "attention", title: "The sandbox is not running", detail: RUNS_HERE, action: { kind: "retry", label: "Try again" }, errorDetail: box.notice?.replace(/^Sandbox off for now: /, "").replace(/\.$/, "") ?? box.error };
      }
      const step = linuxSandboxNextStep(box);
      return { ...base, tone: "attention", title: step.title, detail: RUNS_HERE, step, action: { kind: "check", label: "Check again" }, errorDetail: box.runtime?.reason ?? null };
    }
    case "off":
      return { ...base, tone: "off", title: "Off", detail: box.notice ?? "Commands run on this computer." };
  }
}

/** The backend in use and how it was picked, for the Advanced section. */
export function linuxSandboxBackendSummary(box: MarsWorkspaceBox): string {
  if (box.backendSetting.value === "native") return "Set to Off: commands run on this computer.";
  const using = runtimeLabel(box);
  if (!using) return "No backend works on this computer yet.";
  if (box.backendSetting.source === "env") return `Using ${using} (set by MARS_BOX_BACKEND).`;
  return box.backendSetting.value === "auto" ? `Using ${using}, picked automatically.` : `Using ${using}.`;
}

/** The backend choices for the picker: "Automatic (recommended)" first. */
export function linuxSandboxBackendChoices(box: MarsWorkspaceBox): Array<{ value: string; label: string }> {
  return box.backendSetting.choices.map((choice) => ({ value: choice.id, label: choice.id === "auto" ? "Automatic (recommended)" : choice.label }));
}

/** States that change on their own: asked about again quickly while they last. */
const MOVING = new Set<MarsWorkspaceBox["state"]>(["downloading", "starting"]);
/** Poll every second while the sandbox moves, slower after a minute (a long download). */
const FAST_POLL_MS = 1_000;
const SLOW_POLL_MS = 3_000;
const FAST_FOR_MS = 60_000;

export function linuxSandboxMoving(box: MarsWorkspaceBox | null): boolean {
  return Boolean(box?.on && MOVING.has(box.state));
}

export type LinuxSandboxProblem = { message: string; retry: (() => void) | null };

/**
 * The selected workspace's sandbox: its status (asked again every second
 * while it moves, and when the window comes back), the switch (shown at
 * once, before the server answers), the backend, Retry and Reset.
 */
export function useLinuxSandbox(client: LinuxSandboxClient | null, workspaceId: string | null, { fresh: freshOnOpen = true }: { fresh?: boolean } = {}) {
  const [box, setBox] = useState<MarsWorkspaceBox | null>(null);
  const [pending, setPending] = useState<LinuxSandboxPending>(null);
  const [problem, setProblem] = useState<LinuxSandboxProblem | null>(null);
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const movingSince = useRef<number | null>(null);

  const load = useCallback(async (fresh = false) => {
    if (!client || !workspaceId) return;
    const startedAt = sequence.current;
    const value = await client.getWorkspaceBox(workspaceId, { fresh }).catch(() => null);
    if (sequence.current !== startedAt) return;
    if (value) {
      setBox(value);
      setProblem((current) => (current?.message === LOAD_FAILED ? null : current));
    } else {
      setProblem({ message: LOAD_FAILED, retry: () => void load(true) });
    }
  }, [client, workspaceId]);

  // Another project: start from nothing. The same project with a new client (the engine
  // reloaded after the switch): keep what is shown and ask again, so nothing flickers.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (shownFor.current !== workspaceId) {
      shownFor.current = workspaceId;
      sequence.current += 1;
      setBox(null);
      setPending(null);
      setProblem(null);
      setNotice("");
    }
    void load(freshOnOpen);
  }, [load, freshOnOpen, workspaceId]);

  // While it moves: every second for a minute, then every 3 s.
  const moving = linuxSandboxMoving(box);
  useEffect(() => {
    if (!moving) {
      movingSince.current = null;
      return;
    }
    movingSince.current ??= Date.now();
    const delay = Date.now() - movingSince.current < FAST_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [box, moving, load]);

  // Back to the window (a runtime started or installed meanwhile): look again.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !pending) void load(freshOnOpen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [freshOnOpen, load, pending]);

  /** One change at a time; an answer to an older request never overwrites a newer one. */
  const change = useCallback(async (kind: Exclude<LinuxSandboxPending, null>, act: () => Promise<MarsWorkspaceBox | null>, failure: string, again: () => void) => {
    if (!client || !workspaceId || pending) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setPending(kind);
    setProblem(null);
    setNotice("");
    try {
      const result = await act();
      if (sequence.current !== startedAt) return;
      if (result) setBox(result);
    } catch {
      if (sequence.current !== startedAt) return;
      setProblem({ message: failure, retry: again });
    } finally {
      if (sequence.current === startedAt) setPending(null);
    }
  }, [client, pending, workspaceId]);

  const setEnabled = useCallback((enabled: boolean) => {
    if (!client || !workspaceId) return Promise.resolve();
    return change(enabled ? "on" : "off", async () => {
      const result = await client.setWorkspaceBox(workspaceId, enabled ? "on" : "off");
      if (result.engine.status === "failed") setNotice("Saved. The engine did not confirm the change: use Reload in Settings > Advanced.");
      return result;
    }, enabled ? "The sandbox could not be turned on." : "The sandbox could not be turned off.", () => void setEnabled(enabled));
  }, [change, client, workspaceId]);

  const setBackend = useCallback((backend: string) => {
    if (!client || !workspaceId) return Promise.resolve();
    return change("backend", () => client.setWorkspaceBoxBackend(workspaceId, backend), "The backend could not be saved.", () => void setBackend(backend));
  }, [change, client, workspaceId]);

  const retry = useCallback(() => {
    if (!client || !workspaceId) return Promise.resolve();
    return change("retry", () => client.retryWorkspaceBox(workspaceId), "The sandbox could not be asked to try again.", () => void retry());
  }, [change, client, workspaceId]);

  const reset = useCallback(() => {
    if (!client || !workspaceId) return Promise.resolve();
    return change("reset", async () => {
      const result = await client.resetWorkspaceBox(workspaceId);
      setNotice(result.removed ? "Sandbox reset. The next command starts a fresh one." : "There was no sandbox to reset.");
      return client.getWorkspaceBox(workspaceId, { fresh: true }).catch(() => null);
    }, "The sandbox could not be reset.", () => void reset());
  }, [change, client, workspaceId]);

  const refresh = useCallback(() => load(true), [load]);

  return { box, pending, problem, notice, setEnabled, setBackend, retry, reset, refresh };
}

export type LinuxSandboxState = ReturnType<typeof useLinuxSandbox>;
