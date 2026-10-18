import {
  engineInfo,
  engineStart,
  marsServerInfo,
  type EngineInfo,
  type MarsServerInfo,
} from "../../app/lib/desktop";
import {
  readMarsServerSettings,
  writeMarsServerSettings,
  type MarsServerSettings,
} from "../../app/lib/mars-server";
import { safeStringify } from "../../app/utils";
import { recordInspectorEvent } from "../../app/lib/app-inspector";
import type { BootPhaseId } from "./boot-state";

type LocalWorkspaceLike = {
  id: string;
  name?: string | null;
  displayNameResolved?: string | null;
  path?: string | null;
  workspaceType?: "local" | "remote" | string | null;
};

type EnsureDesktopLocalMarsOptions = {
  route: "session" | "settings";
  workspace: LocalWorkspaceLike | null | undefined;
  allWorkspaces: LocalWorkspaceLike[];
};

function emitMarsSettingsChanged() {
  try {
    window.dispatchEvent(new CustomEvent("mars-server-settings-changed"));
  } catch {
    // ignore browser event dispatch failures
  }
}

/** Matches the boot sequence's definition of a usable local server: running,
 * with a base URL and at least one token the route can authenticate with. */
export function isReadyLocalMarsServerInfo(
  info: MarsServerInfo | null | undefined,
): info is MarsServerInfo {
  return Boolean(
    info?.running === true &&
      info.baseUrl?.trim() &&
      (info.ownerToken?.trim() || info.clientToken?.trim()),
  );
}

export const LOCAL_MARS_READINESS_MAX_ATTEMPTS = 20;
export const LOCAL_MARS_READINESS_RETRY_DELAY_MS = 500;

export function marsServerSettingsChanged(
  previous: MarsServerSettings,
  next: MarsServerSettings,
): boolean {
  return previous.urlOverride !== next.urlOverride
    || previous.portOverride !== next.portOverride
    || previous.token !== next.token
    || previous.hostToken !== next.hostToken
    || (previous.remoteAccessEnabled === true) !== (next.remoteAccessEnabled === true);
}

/**
 * Poll the local server bridge until it reports a ready server. A restart
 * (app update, remote-access toggle, slow cold start) briefly answers with
 * `running: false` or without a base URL/tokens; that window is a readiness
 * gap, not a failure. Bounded: returns the last observed info (ready or not)
 * after `maxAttempts` polls so callers decide how to report exhaustion.
 */
export async function waitForReadyLocalMarsServerInfo(options?: {
  fetchInfo?: () => Promise<MarsServerInfo | null>;
  maxAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<MarsServerInfo | null> {
  const fetchInfo =
    options?.fetchInfo ?? (() => marsServerInfo() as Promise<MarsServerInfo | null>);
  const maxAttempts = Math.max(1, options?.maxAttempts ?? LOCAL_MARS_READINESS_MAX_ATTEMPTS);
  const wait =
    options?.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));

  let lastInfo: MarsServerInfo | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await wait(LOCAL_MARS_READINESS_RETRY_DELAY_MS);
    lastInfo = await fetchInfo().catch(() => null);
    if (isReadyLocalMarsServerInfo(lastInfo)) return lastInfo;
  }
  return lastInfo;
}

export type DesktopLocalReconnectInput = {
  desktopRuntime: boolean;
  bootPhase: BootPhaseId;
  bootRouteReady: boolean;
  routeLoading: boolean;
  hasClient: boolean;
  connectionPending: boolean;
  workspaceType: string | null | undefined;
};

/**
 * Gate for the session route's local reconnect effect. Reconnect must not
 * start while desktop runtime bootstrap is still in flight — the boot
 * sequence owns starting the server, and probing `marsServerInfo`
 * mid-bootstrap is what surfaced "did not report a base URL" errors during
 * app updates. It runs only once boot completed (`ready`), definitively
 * failed (`error`), or is idle after the route already became interactive
 * (dev HMR remounts the boot provider without re-running boot).
 */
export function shouldAttemptDesktopLocalReconnect(input: DesktopLocalReconnectInput): boolean {
  if (!input.desktopRuntime) return false;
  const bootSettled =
    input.bootPhase === "ready" ||
    input.bootPhase === "error" ||
    (input.bootPhase === "idle" && input.bootRouteReady);
  if (!bootSettled) return false;
  if (input.routeLoading) return false;
  if (input.hasClient && !input.connectionPending) return false;
  return input.workspaceType === "local";
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : "Unknown error";
}

export async function ensureDesktopLocalMarsConnection(
  options: EnsureDesktopLocalMarsOptions,
) {
  const workspace = options.workspace;
  const workspaceRoot = workspace?.path?.trim() ?? "";
  if (!workspace || workspace.workspaceType !== "local" || !workspaceRoot) {
    return null;
  }

  const workspacePaths = Array.from(
    new Set(
      options.allWorkspaces.flatMap((item) => {
        const path = item.workspaceType === "local" ? item.path?.trim() ?? "" : "";
        return path ? [path] : [];
      }),
    ),
  );
  if (!workspacePaths.includes(workspaceRoot)) {
    workspacePaths.unshift(workspaceRoot);
  }

  recordInspectorEvent("route.local_mars.ensure.start", {
    route: options.route,
    workspaceId: workspace.id,
    workspaceRoot,
  });

  try {
    const engine = await engineInfo().catch(() => null) as EngineInfo | null;
    let startedEngine = false;
    if (!engine?.running || !engine.baseUrl) {
      await engineStart(workspaceRoot, {
        runtime: "direct",
        workspacePaths,
        marsRemoteAccess: readMarsServerSettings().remoteAccessEnabled === true,
      });
      startedEngine = true;
    }

    // The server publishes its base URL and tokens asynchronously after a
    // (re)start, so gate on observed readiness with bounded retries instead
    // of failing on the first empty answer.
    const info = await waitForReadyLocalMarsServerInfo();
    if (!isReadyLocalMarsServerInfo(info) || !info.baseUrl) {
      throw new Error("marsai.click server did not become ready after activation.");
    }

    const previousSettings = readMarsServerSettings();
    const nextSettings = writeMarsServerSettings({
      urlOverride: info.baseUrl,
      token: info.ownerToken?.trim() || info.clientToken?.trim() || undefined,
      hostToken: info.hostToken?.trim() || undefined,
      portOverride: info.port ?? undefined,
      remoteAccessEnabled: info.remoteAccessEnabled === true,
    });
    if (startedEngine || marsServerSettingsChanged(previousSettings, nextSettings)) {
      emitMarsSettingsChanged();
    }

    recordInspectorEvent("route.local_mars.ensure.success", {
      route: options.route,
      workspaceId: workspace.id,
      workspaceRoot,
      baseUrl: info.baseUrl,
    });

    return info;
  } catch (error) {
    const message = describeError(error);
    console.error(`[${options.route}-route] local workspace reconnect failed`, error);
    recordInspectorEvent("route.local_mars.ensure.error", {
      route: options.route,
      workspaceId: workspace.id,
      workspaceRoot,
      message,
    });
    throw new Error(message);
  }
}
