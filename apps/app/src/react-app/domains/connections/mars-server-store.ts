import { useSyncExternalStore } from "react";

import { t } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  marsServerInfo,
  marsServerRestart,
  type MarsServerInfo,
} from "../../../app/lib/desktop";
import {
  getMarsGatewayOrigin,
  readMarsGatewayDenToken,
} from "../../../app/lib/gateway-runtime";
import {
  clearMarsServerSettings,
  createMarsServerClient,
  isLoopbackMarsServerUrl,
  normalizeMarsServerUrl,
  readMarsServerSettings,
  writeMarsServerSettings,
  type MarsAuditEntry,
  type MarsServerCapabilities,
  type MarsServerClient,
  type MarsServerDiagnostics,
  type MarsServerError,
  type MarsServerSettings,
  type MarsServerStatus,
} from "../../../app/lib/mars-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  marsHostUrl: string;
  marsToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type MarsServerStoreSnapshot = {
  marsServerSettings: MarsServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  marsServerUrl: string;
  marsServerBaseUrl: string;
  marsServerAuth: { token?: string; hostToken?: string };
  marsServerClient: MarsServerClient | null;
  marsServerStatus: MarsServerStatus;
  marsServerCapabilities: MarsServerCapabilities | null;
  marsServerReady: boolean;
  marsServerWorkspaceReady: boolean;
  resolvedMarsCapabilities: MarsServerCapabilities | null;
  marsServerCanWriteSkills: boolean;
  marsServerCanWritePlugins: boolean;
  marsServerHostInfo: MarsServerInfo | null;
  marsServerDiagnostics: MarsServerDiagnostics | null;
  marsReconnectBusy: boolean;
  marsAuditEntries: MarsAuditEntry[];
  marsAuditStatus: "idle" | "loading" | "error";
  marsAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type MarsServerStore = ReturnType<typeof createMarsServerStore>;

type CreateMarsServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  marsServerSettings: MarsServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  marsServerUrl: string;
  marsServerStatus: MarsServerStatus;
  marsServerCapabilities: MarsServerCapabilities | null;
  marsServerCheckedAt: number | null;
  marsServerHostInfo: MarsServerInfo | null;
  marsServerHostInfoReady: boolean;
  marsServerDiagnostics: MarsServerDiagnostics | null;
  marsReconnectBusy: boolean;
  marsAuditEntries: MarsAuditEntry[];
  marsAuditStatus: "idle" | "loading" | "error";
  marsAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

function sameMarsServerSnapshot(
  current: MarsServerStoreSnapshot,
  next: MarsServerStoreSnapshot,
): boolean {
  return (
    current.marsServerSettings === next.marsServerSettings &&
    current.shareRemoteAccessBusy === next.shareRemoteAccessBusy &&
    current.shareRemoteAccessError === next.shareRemoteAccessError &&
    current.marsServerUrl === next.marsServerUrl &&
    current.marsServerBaseUrl === next.marsServerBaseUrl &&
    current.marsServerAuth.token === next.marsServerAuth.token &&
    current.marsServerAuth.hostToken === next.marsServerAuth.hostToken &&
    current.marsServerClient === next.marsServerClient &&
    current.marsServerStatus === next.marsServerStatus &&
    current.marsServerCapabilities === next.marsServerCapabilities &&
    current.marsServerReady === next.marsServerReady &&
    current.marsServerWorkspaceReady === next.marsServerWorkspaceReady &&
    current.resolvedMarsCapabilities === next.resolvedMarsCapabilities &&
    current.marsServerCanWriteSkills === next.marsServerCanWriteSkills &&
    current.marsServerCanWritePlugins === next.marsServerCanWritePlugins &&
    current.marsServerHostInfo === next.marsServerHostInfo &&
    current.marsServerDiagnostics === next.marsServerDiagnostics &&
    current.marsReconnectBusy === next.marsReconnectBusy &&
    current.marsAuditEntries === next.marsAuditEntries &&
    current.marsAuditStatus === next.marsAuditStatus &&
    current.marsAuditError === next.marsAuditError &&
    current.devtoolsWorkspaceId === next.devtoolsWorkspaceId
  );
}

export function createMarsServerStore(options: CreateMarsServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: MarsServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let consecutiveHealthFailures = 0;
  let visibilityChangeHandler: (() => void) | null = null;
  let snapshot: MarsServerStoreSnapshot | undefined;

  let state: MutableState = {
    marsServerSettings: readMarsServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    marsServerUrl: "",
    marsServerStatus: "disconnected",
    marsServerCapabilities: null,
    marsServerCheckedAt: null,
    marsServerHostInfo: null,
    marsServerHostInfoReady: !isDesktopRuntime(),
    marsServerDiagnostics: null,
    marsReconnectBusy: false,
    marsAuditEntries: [],
    marsAuditStatus: "idle",
    marsAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const gatewayOrigin = getMarsGatewayOrigin();
    if (gatewayOrigin) return normalizeMarsServerUrl(gatewayOrigin) ?? "";

    const pref = options.startupPreference();
    const hostInfo = state.marsServerHostInfo;
    const settingsUrl = normalizeMarsServerUrl(state.marsServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackMarsServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const gatewayOrigin = getMarsGatewayOrigin();
    if (gatewayOrigin) {
      const token = readMarsGatewayDenToken().trim();
      return { token: token || undefined, hostToken: undefined };
    }

    const pref = options.startupPreference();
    const hostInfo = state.marsServerHostInfo;
    const settingsUrl = normalizeMarsServerUrl(state.marsServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.marsServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.marsServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackMarsServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackMarsServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackMarsServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createMarsServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = (): boolean => {
    const marsServerBaseUrl = getBaseUrl().trim();
    const marsServerAuth = getAuth();
    const marsServerClient = getClient();
    const marsServerReady = state.marsServerStatus === "connected";
    const marsServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedMarsCapabilities = state.marsServerCapabilities;

    const pref = options.startupPreference();
    const info = state.marsServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeMarsServerUrl(state.marsServerSettings.urlOverride ?? "") ?? "";

    let marsServerUrl = hostUrl || settingsUrl;
    if (pref === "local") marsServerUrl = hostUrl;
    if (pref === "server") marsServerUrl = settingsUrl;
    state.marsServerUrl = marsServerUrl;

    const nextSnapshot: MarsServerStoreSnapshot = {
      marsServerSettings: state.marsServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      marsServerUrl,
      marsServerBaseUrl,
      marsServerAuth,
      marsServerClient,
      marsServerStatus: state.marsServerStatus,
      marsServerCapabilities: state.marsServerCapabilities,
      marsServerReady,
      marsServerWorkspaceReady,
      resolvedMarsCapabilities,
      marsServerCanWriteSkills:
        marsServerReady &&
        (resolvedMarsCapabilities?.skills?.write ?? false),
      marsServerCanWritePlugins:
        marsServerReady &&
        (resolvedMarsCapabilities?.plugins?.write ?? false),
      marsServerHostInfo: state.marsServerHostInfo,
      marsServerDiagnostics: state.marsServerDiagnostics,
      marsReconnectBusy: state.marsReconnectBusy,
      marsAuditEntries: state.marsAuditEntries,
      marsAuditStatus: state.marsAuditStatus,
      marsAuditError: state.marsAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
    };
    if (snapshot && sameMarsServerSnapshot(snapshot, nextSnapshot)) return false;
    snapshot = nextSnapshot;
    return true;
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    if (refreshSnapshot()) emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const setMarsServerSettings = (next: SetStateAction<MarsServerSettings>) => {
    const resolved = applyStateAction(state.marsServerSettings, next);
    mutateState((current) => ({ ...current, marsServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateMarsServerSettings = (next: MarsServerSettings) => {
    const stored = writeMarsServerSettings(next);
    mutateState((current) => ({ ...current, marsServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetMarsServerSettings = () => {
    clearMarsServerSettings();
    mutateState((current) => ({ ...current, marsServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.marsServerHostInfoReady;

  const shouldRetryStartupCheck = (status: MarsServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkMarsServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createMarsServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as MarsServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as MarsServerStatus, capabilities: null };
      }
      return { status: "disconnected" as MarsServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as MarsServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as MarsServerStatus, capabilities };
    } catch (error) {
      const resolved = error as MarsServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as MarsServerStatus, capabilities: null };
      }
      return { status: "disconnected" as MarsServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) {
      queueHealthCheck(healthDelayMs);
      return;
    }
    if (shouldWaitForLocalHostInfo()) {
      queueHealthCheck(250);
      return;
    }
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      consecutiveHealthFailures = 0;
      mutateState((current) => ({
        ...current,
        marsServerStatus: "disconnected",
        marsServerCapabilities: null,
        marsServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkMarsServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await marsServerInfo() as MarsServerInfo;
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            marsServerHostInfo: info,
            marsServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkMarsServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      const previousStatus = state.marsServerStatus;
      const previousCapabilities = state.marsServerCapabilities;
      const healthy = result.status === "connected" || result.status === "limited";
      if (healthy) {
        consecutiveHealthFailures = 0;
        healthDelayMs = 10_000;
      } else {
        consecutiveHealthFailures += 1;
        healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      }

      const preservePrevious =
        !healthy &&
        consecutiveHealthFailures < 3 &&
        (previousStatus === "connected" || previousStatus === "limited");

      mutateState((current) => ({
        ...current,
        marsServerStatus: preservePrevious ? previousStatus : result.status,
        marsServerCapabilities: preservePrevious ? previousCapabilities : result.capabilities,
        marsServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        marsServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    if (refreshSnapshot()) emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.marsServerHostInfo?.port;
    if (!port) return;
    if (state.marsServerSettings.portOverride === port) return;

    updateMarsServerSettings({
      ...state.marsServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);
    visibilityChangeHandler = () => {
      if (!options.documentVisible()) return;
      consecutiveHealthFailures = 0;
      queueHealthCheck(0);
    };
    window.addEventListener("visibilitychange", visibilityChangeHandler);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await marsServerInfo() as MarsServerInfo;
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            marsServerHostInfo: info,
            marsServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            marsServerHostInfo: null,
            marsServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("marsServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.marsServerStatus === "disconnected") {
        setStateField("marsServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("marsServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("marsServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          marsAuditEntries: [],
          marsAuditStatus: "idle",
          marsAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          marsAuditEntries: [],
          marsAuditStatus: "idle",
          marsAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        marsAuditStatus: "loading",
        marsAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            marsAuditEntries: Array.isArray(result.items) ? result.items : [],
            marsAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            marsAuditEntries: [],
            marsAuditStatus: "error",
            marsAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load"),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    if (visibilityChangeHandler && typeof window !== "undefined") {
      window.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testMarsServerConnection = async (next: MarsServerSettings) => {
    const derived = normalizeMarsServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        marsServerStatus: "disconnected",
        marsServerCapabilities: null,
        marsServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkMarsServer(derived, next.token);
    consecutiveHealthFailures = result.status === "disconnected" ? consecutiveHealthFailures + 1 : 0;
    mutateState((current) => ({
      ...current,
      marsServerStatus: result.status,
      marsServerCapabilities: result.capabilities,
      marsServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "mars";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            marsHostUrl: derived,
            marsToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectMarsServer = async () => {
    if (state.marsReconnectBusy) return false;
    setStateField("marsReconnectBusy", true);

    try {
      let hostInfo = state.marsServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await marsServerInfo() as MarsServerInfo;
          mutateState((current) => ({ ...current, marsServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("marsServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const liveHostToken = hostInfo.hostToken?.trim() ?? "";
        const settings = state.marsServerSettings;
        if (
          (settings.token?.trim() ?? "") !== liveToken ||
          (settings.hostToken?.trim() ?? "") !== liveHostToken
        ) {
          updateMarsServerSettings({
            ...settings,
            token: liveToken,
            hostToken: liveHostToken || undefined,
          });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          marsServerStatus: "disconnected",
          marsServerCapabilities: null,
          marsServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkMarsServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        marsServerStatus: result.status,
        marsServerCapabilities: result.capabilities,
        marsServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("marsReconnectBusy", false);
    }
  };

  async function ensureLocalMarsServerClient(): Promise<MarsServerClient | null> {
    const healthyClientFromInfo = async (
      info: MarsServerInfo | null,
    ): Promise<MarsServerClient | null> => {
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const token = info?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) return null;
      const candidate = createMarsServerClient({
        baseUrl,
        token,
        hostToken: info?.hostToken?.trim() || undefined,
      });
      try {
        await candidate.health();
      } catch {
        return null;
      }
      return candidate;
    };

    const cached = await healthyClientFromInfo(state.marsServerHostInfo);
    if (cached) {
      if (options.startupPreference() !== "server") {
        await reconnectMarsServer();
      }
      return cached;
    }

    if (!isDesktopRuntime()) return null;

    // A store that has not observed the server yet (a fresh route mount)
    // must not treat it as dead: the restart below tears down the embedded
    // server AND its managed engine, killing every live run. Ask the desktop
    // bridge for the live server first and restart only when that running
    // server is genuinely unreachable.
    let hostInfo: MarsServerInfo | null = null;
    try {
      hostInfo = await marsServerInfo() as MarsServerInfo;
      mutateState((current) => ({
        ...current,
        marsServerHostInfo: hostInfo,
        marsServerHostInfoReady: true,
      }));
    } catch {
      hostInfo = null;
    }
    const live = await healthyClientFromInfo(hostInfo);
    if (live) {
      if (options.startupPreference() !== "server") {
        await reconnectMarsServer();
      }
      return live;
    }

    try {
      // Not a user action: the desktop keeps a server that still answers it
      // and only replaces one that is really gone.
      hostInfo = await marsServerRestart({
        reason: "renderer_health_check_failed",
        source: "mars-server-store",
        remoteAccessEnabled: state.marsServerSettings.remoteAccessEnabled === true,
      }) as MarsServerInfo;
      mutateState((current) => ({ ...current, marsServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectMarsServer();
    }

    return createMarsServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.marsServerSettings;
    const next: MarsServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateMarsServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker"));
        }
        await reconnectMarsServer();
      }
    } catch (error) {
      updateMarsServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access"),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => {
    if (!snapshot) throw new Error("marsai.click server snapshot was not initialized.");
    return snapshot;
  };

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    setMarsServerSettings,
    updateMarsServerSettings,
    resetMarsServerSettings,
    saveShareRemoteAccess,
    checkMarsServer,
    testMarsServerConnection,
    reconnectMarsServer,
    ensureLocalMarsServerClient,
  };
}

export function useMarsServerStoreSnapshot(store: MarsServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
