import { useSyncExternalStore } from "react";

import { desktopRestrictionNotice, type DesktopAppRestrictionChecker } from "../../../app/cloud/desktop-app-restrictions";

import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

import { t } from "../../../i18n";
import {
  getMcpServerName,
  isBuiltInMarsExtension,
  COMPUTER_USE_PAUSED,
  MCP_QUICK_CONNECT,
  type McpDirectoryInfo,
} from "../../../app/constants";
import { extensionResource } from "../../../app/extensions";
import {
  mintCloudControlMcpToken,
  readDenSettings,
} from "../../../app/lib/den";
import { createClient, unwrap } from "../../../app/lib/opencode";
import { finishPerf, perfNow, recordPerfLog } from "../../../app/lib/perf-log";
import {
  assertDesktopWebUrl,
  openDesktopUrl,
  readOpencodeConfig,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../../../app/lib/desktop";
import { toSessionTransportDirectory } from "../../../app/lib/session-scope";
import {
  normalizeMcpSlug,
  parseMcpServersFromContent,
  removeMcpFromConfig,
  validateMcpServerName,
} from "../../../app/mcp";
import {
  buildMarsWorkspaceBaseUrl,
  type MarsServerClient,
} from "../../../app/lib/mars-server";
import type {
  Client,
  McpServerEntry,
  McpStatusMap,
  ReloadReason,
  ReloadTrigger,
} from "../../../app/types";
import { isDesktopRuntime, normalizeDirectoryPath, safeStringify } from "../../../app/utils";
import { conflictsWithMarsConnect } from "./mcp-connection-boundary";

import type { MarsServerStore } from "./mars-server-store";
import { attemptSilentMcpReauth } from "./mcp-silent-reauth";
import {
  createMcpStatusSynchronizer,
  resolveObservedMcpStatus,
  type McpStatusRefreshToken,
} from "./mcp-status-synchronization";
import {
  CLOUD_MCP_SERVER_NAME,
  readCloudMcpUserState,
} from "./cloud-mcp-user-state";
import {
  clearCloudMcpDisabledIntent,
  cloudMcpDisplaySummary,
  recordCloudMcpDisabledIntent,
  runMarsCloudMcpReconciler,
  type CloudMcpOperationContext,
} from "./cloud-mcp-reconciler";

type SetStateAction<T> = T | ((current: T) => T);

// Re-mint when less than a day of token validity remains. Must be well
// below the minted token TTL (7 days, DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS in
// den-api): when the two were equal, the marker was stale the instant it
// was written and every sync tick re-wrote the MCP config.
const CLOUD_MCP_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const LOCAL_MARS_SERVER_RECOVERY_TIMEOUT_MS = 30_000;
const MARS_UI_MCP_UNAVAILABLE = "UI control requires the marsai.click desktop app. Restart marsai.click or reinstall the app.";
const COMPUTER_USE_HELPER_UNAVAILABLE = "Computer Use helper app is unavailable. Restart marsai.click or reinstall the app.";
const COMPUTER_USE_CONNECT_TIMEOUT_MS = 15_000;
const COMPUTER_USE_RECONNECT_COOLDOWN_MS = 30_000;
const MCP_DISABLED_BY_POLICY = "MCP servers are disabled in MarsAI.";

async function withLocalMarsServerRecoveryTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(t("mcp.connect_failed"))), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function observedMcpStatus(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("status" in value)) return null;
  const status = value.status;
  return typeof status === "string" ? status : null;
}

async function waitForMcpConnected(
  client: Client,
  name: string,
  directory: string,
): Promise<boolean> {
  const deadline = Date.now() + COMPUTER_USE_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = unwrap(await client.mcp.status({ directory })) as Record<string, unknown>;
      const status = observedMcpStatus(response[name]);
      if (status === "connected") return true;
      if (status === "failed" || status === "needs_auth" || status === "needs_client_registration" || status === "disabled") {
        return false;
      }
    } catch {
      // The engine may not expose status until the helper transport starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export type ConnectionsStoreSnapshot = {
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  mcpAuthModalOpen: boolean;
  mcpAuthEntry: McpDirectoryInfo | null;
  mcpAuthNeedsReload: boolean;
  /** False when the server reports managed OAuth secure storage is unavailable. */
  managedOAuthAvailable: boolean;
};

type MutableState = ConnectionsStoreSnapshot;

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;

export type McpConnectResult =
  | { ok: true }
  | { ok: false; error: string };

export function createConnectionsStore(options: {
  checkDesktopAppRestriction: DesktopAppRestrictionChecker;
  client: () => Client | null;
  setClient: (value: Client | null) => void;
  projectDir: () => string;
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  marsServer: MarsServerStore;
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  localMarsServerRecoveryTimeoutMs?: number;
  setProjectDir?: (value: string) => void;
  developerMode: () => boolean;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const listeners = new Set<() => void>();

  let started = false;
  let disposed = false;
  let lastWorkspaceContextKey = "";
  let lastProjectDir = "";
  let snapshot: ConnectionsStoreSnapshot;
  const mcpStatusSynchronizer = createMcpStatusSynchronizer();
  const authStatusPolls = new Set<string>();
  const computerUseReconnectAt = new Map<string, number>();
  const computerUseReconnectInFlight = new Set<string>();

  let state: MutableState = {
    mcpServers: [],
    mcpStatus: null,
    mcpLastUpdatedAt: null,
    mcpStatuses: {},
    mcpConnectingName: null,
    selectedMcp: null,
    mcpAuthModalOpen: false,
    mcpAuthEntry: null,
    mcpAuthNeedsReload: false,
    managedOAuthAvailable: true,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const refreshSnapshot = () => {
    snapshot = {
      mcpServers: state.mcpServers,
      mcpStatus: state.mcpStatus,
      mcpLastUpdatedAt: state.mcpLastUpdatedAt,
      mcpStatuses: state.mcpStatuses,
      mcpConnectingName: state.mcpConnectingName,
      selectedMcp: state.selectedMcp,
      mcpAuthModalOpen: state.mcpAuthModalOpen,
      mcpAuthEntry: state.mcpAuthEntry,
      mcpAuthNeedsReload: state.mcpAuthNeedsReload,
      managedOAuthAvailable: state.managedOAuthAvailable,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const reconnectConfiguredComputerUse = (
    client: Client,
    directory: string,
    entries: McpServerEntry[],
    observedStatuses: Record<string, unknown>,
  ) => {
    if (COMPUTER_USE_PAUSED || !isDesktopRuntime() || options.workspaceType() !== "local" || !directory) return;
    const entry = entries.find((candidate) => candidate.name === "computer-use" || candidate.id === "computer-use");
    if (!entry || entry.config.type !== "local" || entry.config.enabled === false) return;
    if (state.mcpConnectingName) return;

    const status = observedMcpStatus(observedStatuses[entry.name] ?? observedStatuses[entry.id ?? ""]);
    if (status && status !== "disconnected" && status !== "failed") return;
    const key = `${directory}\u0000${entry.name}`;
    if (computerUseReconnectInFlight.has(key)) return;
    const lastAttemptAt = computerUseReconnectAt.get(key) ?? 0;
    if (Date.now() - lastAttemptAt < COMPUTER_USE_RECONNECT_COOLDOWN_MS) return;
    computerUseReconnectAt.set(key, Date.now());
    computerUseReconnectInFlight.add(key);
    const displayName = MCP_QUICK_CONNECT.find((candidate) => candidate.id === "computer-use")?.name ?? "Computer Use";
    mutateState((current) => ({ ...current, mcpConnectingName: displayName, mcpStatus: null }));

    void (async () => {
      try {
        await client.mcp.connect({ name: entry.name, directory });
        const connected = await waitForMcpConnected(client, entry.name, directory);
        if (!connected) setStateField("mcpStatus", "Computer Use is still starting. Refresh the status if it does not connect.");
      } catch (error) {
        setStateField("mcpStatus", error instanceof Error ? error.message : "Computer Use could not reconnect.");
      } finally {
        computerUseReconnectInFlight.delete(key);
        setStateField("mcpConnectingName", null);
        await refreshMcpServers();
      }
    })();
  };

  const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
    typeof next === "function" ? (next as (value: T) => T)(current) : next;

  const getWorkspaceContextKey = () => {
    const workspaceId = options.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(options.selectedWorkspaceRoot().trim());
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    const workspaceType = options.workspaceType();
    return `${workspaceType}:${workspaceId}:${root}:${runtimeWorkspaceId}`;
  };

  const getMarsSnapshot = () => options.marsServer.getSnapshot();

  const mcpDisabledByPolicy = () => {
    const current = getMarsSnapshot();
    // A GUI without an Mars policy-bearing server must fail closed.
    return current.marsServerStatus !== "connected"
      || current.marsServerCapabilities?.mcp?.read !== true;
  };

  const resolveMarsWorkspaceId = async () => {
    const current = options.runtimeWorkspaceId()?.trim();
    if (current) return current;
    const marsSnapshot = getMarsSnapshot();
    if (marsSnapshot.marsServerStatus !== "connected" || !marsSnapshot.marsServerClient) {
      return null;
    }
    const ensured = (await options.ensureRuntimeWorkspaceId?.())?.trim();
    if (ensured) return ensured;
    return options.workspaceType() === "local" ? options.selectedWorkspaceId().trim() || null : null;
  };

  const resolveConfigMarsTarget = async (mode: "read" | "write") => {
    const marsSnapshot = getMarsSnapshot();
    const marsClient = marsSnapshot.marsServerClient;
    const marsWorkspaceId = await resolveMarsWorkspaceId();
    const hasMarsTarget =
      marsSnapshot.marsServerStatus === "connected" &&
      Boolean(marsClient && marsWorkspaceId);
    const canUseMarsServer =
      hasMarsTarget &&
      marsSnapshot.marsServerCapabilities?.config?.[mode] !== false;
    return {
      marsClient,
      marsWorkspaceId,
      hasMarsTarget,
      canUseMarsServer,
    };
  };

  const resolveMcpMarsTarget = async (mode: "read" | "write") => {
    let marsSnapshot = getMarsSnapshot();
    let marsClient = marsSnapshot.marsServerClient;
    let marsWorkspaceId = await resolveMarsWorkspaceId();
    if ((!marsClient || !marsWorkspaceId || marsSnapshot.marsServerStatus !== "connected")
      && isDesktopRuntime()
      && options.workspaceType() === "local") {
      marsClient = await withLocalMarsServerRecoveryTimeout(
        options.marsServer.ensureLocalMarsServerClient(),
        options.localMarsServerRecoveryTimeoutMs ?? LOCAL_MARS_SERVER_RECOVERY_TIMEOUT_MS,
      );
      marsSnapshot = getMarsSnapshot();
      marsWorkspaceId = options.runtimeWorkspaceId()?.trim()
        || (await options.ensureRuntimeWorkspaceId?.())?.trim()
        || options.selectedWorkspaceId().trim()
        || null;
    }
    const hasMarsTarget =
      Boolean(marsClient && marsWorkspaceId);
    const canUseMarsServer =
      hasMarsTarget &&
      marsSnapshot.marsServerCapabilities?.mcp?.[mode] !== false;
    return {
      marsClient,
      marsWorkspaceId,
      hasMarsTarget,
      canUseMarsServer,
    };
  };

  const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const next: McpStatusMap = {};
    for (const entry of entries) {
      const resolved = resolveObservedMcpStatus(status, entry);
      if (resolved && resolved.status !== "disconnected") next[entry.name] = resolved;
    }
    return next;
  };

  const readMcpConfigFile = async (scope: "project" | "global"): Promise<OpencodeConfigFile | null> => {
    const projectDir = options.projectDir().trim();
    const { marsClient, marsWorkspaceId, hasMarsTarget, canUseMarsServer } =
      await resolveConfigMarsTarget("read");

    if (canUseMarsServer && marsClient && marsWorkspaceId) {
      return marsClient.readOpencodeConfigFile(marsWorkspaceId, scope);
    }

    if (hasMarsTarget) {
      return null;
    }

    if (options.workspaceType() !== "local" || !isDesktopRuntime()) {
      return null;
    }

    return readOpencodeConfig(scope, projectDir) as Promise<OpencodeConfigFile>;
  };

  const ensureActiveClient = async () => {
    let activeClient = options.client();
    if (activeClient) {
      return activeClient;
    }

    const marsSnapshot = getMarsSnapshot();
    const marsBaseUrl = marsSnapshot.marsServerBaseUrl.trim();
    const token = marsSnapshot.marsServerAuth.token?.trim();
    if (!marsBaseUrl || !token) {
      return null;
    }

    const mountedBaseUrl =
      buildMarsWorkspaceBaseUrl(marsBaseUrl, await resolveMarsWorkspaceId()) ?? marsBaseUrl;
    activeClient = createClient(`${mountedBaseUrl.replace(/\/+$/, "")}/opencode`, undefined, {
      token,
      mode: "mars",
    });
    options.setClient(activeClient);
    return activeClient;
  };

  const resolveWritableMarsTarget = async () => {
    return resolveMcpMarsTarget("write");
  };

  const resolveCloudMcpOperationContext = async (fallbackUrl?: string | null): Promise<CloudMcpOperationContext | null> => {
    const settings = readDenSettings();
    const workspaceId = await resolveMarsWorkspaceId();
    const serverBaseUrl = getMarsSnapshot().marsServerClient?.baseUrl.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!workspaceId || !serverBaseUrl || !orgId) return null;
    return {
      denBaseUrl: settings.baseUrl,
      serverBaseUrl,
      workspaceId,
      orgId,
      denAuthToken: settings.authToken ?? null,
      orgSlug: settings.activeOrgSlug,
      orgName: settings.activeOrgName,
      fallbackUrl,
    };
  };

  const resolveProjectDir = async (activeClient: Client | null, currentProjectDir: string) => {
    let resolvedProjectDir = currentProjectDir;
    if (!resolvedProjectDir && activeClient) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = toSessionTransportDirectory(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          options.setProjectDir?.(discovered);
        }
      } catch {
        // ignore
      }
    }

    return resolvedProjectDir;
  };

  const listMcpFromMarsServer = async (projectDir: string) => {
    const marsSnapshot = getMarsSnapshot();
    const { marsClient, marsWorkspaceId, hasMarsTarget, canUseMarsServer } =
      await resolveMcpMarsTarget("read");
    const canTryMarsServer = canUseMarsServer;

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-check", {
      workspaceType: options.workspaceType(),
      projectDir: projectDir || null,
      marsStatus: marsSnapshot.marsServerStatus,
      hasMarsClient: Boolean(marsClient),
      marsWorkspaceId: marsWorkspaceId ?? null,
      canReadMcp: marsSnapshot.marsServerCapabilities?.mcp?.read ?? null,
      canTryMarsServer,
    });

    if (hasMarsTarget && !canTryMarsServer) {
      throw new Error("marsai.click server cannot read MCP config for this workspace.");
    }

    if (!canTryMarsServer || !marsClient || !marsWorkspaceId) return null;

    let response = await marsClient.listMcp(marsWorkspaceId);
    // Upgrade the enabled bundled helper when a local workspace is opened.
    // Never enable a disabled entry, rewrite a custom command, or target a remote worker.
    if (isDesktopRuntime() && options.workspaceType() === "local") {
      const computer = response.items.find((entry) => entry.name === "computer-use");
      const config = computer?.config;
      const command = config?.command;
      if (config?.type === "local" && config.enabled !== false && Array.isArray(command)
        && typeof command[0] === "string" && command[0].endsWith("/ComputerUse")
        && ((command.length === 2 && command[1] === "mcp") || (command.length === 3 && command[1] === "relay"))) {
        const currentCommand = await resolveDesktopCommand("getComputerUseMcpCommand", COMPUTER_USE_HELPER_UNAVAILABLE);
        const bundled = currentCommand && (command[0] === currentCommand[0]
          || command[0].endsWith("/marsai.click Computer Use.app/Contents/MacOS/ComputerUse"));
        if (bundled && JSON.stringify(command) !== JSON.stringify(currentCommand)) {
          const writable = await resolveWritableMarsTarget();
          if (writable.canUseMarsServer && writable.marsClient && writable.marsWorkspaceId === marsWorkspaceId
            && !mcpMutationDenied(true)) {
            await writable.marsClient.addMcp(marsWorkspaceId, { name: "computer-use", config: { ...config, command: currentCommand } });
            response = await marsClient.listMcp(marsWorkspaceId);
          }
        }
      }
    }
    const next = response.items.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
      managedOAuth: entry.managedOAuth,
    }));
    const engineSync = response.engineSync ?? null;

    let nextStatuses: McpStatusMap = {};
    let observedStatuses: Record<string, unknown> = {};
    // Read through the same workspace mount as configuration. The chat client
    // can still point at the previous/default workspace during restoration.
    try {
      observedStatuses = await marsClient.getMcpStatus(marsWorkspaceId);
      nextStatuses = filterConfiguredStatuses(observedStatuses as McpStatusMap, next);
    } catch {
      nextStatuses = {};
    }

    for (const entry of next) {
      const managed = entry.managedOAuth;
      if (!managed) continue;
      if (!managed.enabled) {
        nextStatuses[entry.name] = { status: "disabled" };
      } else if (managed.status === "reconnect_required") {
        nextStatuses[entry.name] = { status: "reconnect_required" };
      } else if (managed.status === "needs_auth" || managed.status === "connecting") {
        nextStatuses[entry.name] = { status: "needs_auth" };
      } else if (!nextStatuses[entry.name]) {
        nextStatuses[entry.name] = { status: "connected" };
      }
    }

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-result", {
      count: next.length,
      names: next.map((entry) => entry.name),
      sources: next.map((entry) => entry.source ?? "unknown"),
      engineSyncStatus: engineSync?.status ?? null,
    });

    return {
      next,
      nextStatuses,
      observedStatuses,
      engineSync,
      managedOAuthAvailable: response.managedOAuthState?.available ?? true,
    };
  };

  const resolveDesktopCommand = async (
    commandName: "getComputerUseMcpCommand" | "getMarsUiMcpCommand",
    unavailableMessage: string,
  ) => {
    try {
      const command = await window.__MARS_ELECTRON__?.invokeDesktop?.(commandName);
      if (Array.isArray(command) && command.every((part) => typeof part === "string") && command.length > 0) {
        return command;
      }
    } catch (error) {
      // Built-in local MCPs ship inside the desktop app. Never fall back to a
      // catalog command that would resolve a package from a registry.
      throw error instanceof Error ? error : new Error(unavailableMessage);
    }
    return null;
  };

  const isMarsUiMcpEntry = (entry: McpDirectoryInfo) =>
    extensionResource(entry.extensionManifest, "mcp")?.localCommandRef === "mars.uiMcp"
      || entry.serverName === "mars-ui";

  const resolveLocalMcpCommand = async (entry: McpDirectoryInfo) => {
    const mcpResource = extensionResource(entry.extensionManifest, "mcp");
    if (mcpResource?.localCommandRef === "mars.computerUseMcp") {
      const command = await resolveDesktopCommand("getComputerUseMcpCommand", COMPUTER_USE_HELPER_UNAVAILABLE);
      if (!command) throw new Error("Computer Use is unavailable on this desktop. Check its setup page.");
      return command;
    }
    if (isMarsUiMcpEntry(entry)) {
      const command = await resolveDesktopCommand("getMarsUiMcpCommand", MARS_UI_MCP_UNAVAILABLE);
      if (!command) throw new Error(MARS_UI_MCP_UNAVAILABLE);
      return command;
    }
    return entry.command;
  };

  const resolveLocalMcpEnvironment = async (entry: McpDirectoryInfo) => {
    if (extensionResource(entry.extensionManifest, "mcp")?.localCommandRef === "mars.computerUseMcp") {
      const environment = await window.__MARS_ELECTRON__?.invokeDesktop?.("getComputerUseMcpEnvironment");
      if (!environment) throw new Error(COMPUTER_USE_HELPER_UNAVAILABLE);
      return environment;
    }
    if (!isMarsUiMcpEntry(entry)) return undefined;
    // Required, not best-effort: packaged launches run the app's own binary and
    // need ELECTRON_RUN_AS_NODE=1 from this environment to act as Node.
    let environment: unknown;
    try {
      environment = await window.__MARS_ELECTRON__?.invokeDesktop?.("getMarsUiMcpEnvironment");
    } catch (error) {
      throw error instanceof Error ? error : new Error(MARS_UI_MCP_UNAVAILABLE);
    }
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw new Error(MARS_UI_MCP_UNAVAILABLE);
    }
    return Object.fromEntries(
      Object.entries(environment).filter((item): item is [string, string] =>
        typeof item[0] === "string" && typeof item[1] === "string"
      ),
    );
  };

  /**
   * Quiet self-heal for remote OAuth MCPs stuck in "Sign in needed": the
   * engine only refreshes tokens reactively (once per transport), so an
   * expired access token strands the entry until the user clicks Sign in.
   * `mcp.connect` retries the stored refresh-token grant on a fresh
   * transport — silently, never opening a browser or modal. Mirrors
   * syncCloudControlMcp, but for user-added connectors.
   */
  async function healUnhealthyMcpEntries(
    servers: McpServerEntry[],
    statuses: McpStatusMap,
    refreshToken: McpStatusRefreshToken,
  ) {
    if (disposed || snapshot.mcpAuthModalOpen || snapshot.mcpConnectingName) return;
    const activeClient = options.client();
    const projectDir = options.projectDir().trim();
    if (!activeClient || !projectDir) return;
    const attempted = await attemptSilentMcpReauth({
      client: activeClient,
      directory: projectDir,
      servers,
      statuses,
    }).catch(() => false);
    if (!attempted || disposed || !mcpStatusSynchronizer.isCurrent(refreshToken)) return;
    // Re-enter the ordered refresh path. A self-heal launched from an older
    // snapshot must never publish its late status over a newer OAuth result.
    await refreshMcpServers();
  }

  async function refreshMcpServers() {
    if (mcpDisabledByPolicy()) {
      mutateState((current) => ({
        ...current,
        mcpServers: [],
        mcpStatuses: {},
        mcpStatus: MCP_DISABLED_BY_POLICY,
        mcpLastUpdatedAt: Date.now(),
      }));
      return;
    }
    if (disposed) return;

    const refreshToken = mcpStatusSynchronizer.beginRefresh(getWorkspaceContextKey());
    const isCurrentRefresh = () => !disposed && mcpStatusSynchronizer.isCurrent(refreshToken);
    const projectDir = options.projectDir().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";

    try {
      if (isCurrentRefresh()) setStateField("mcpStatus", null);
      const serverResult = await listMcpFromMarsServer(projectDir);
      if (serverResult) {
        // Surface engine registration failures instead of leaving users
        // staring at an MCP that silently shows as disconnected.
        const failedNames = serverResult.engineSync?.status === "failed"
          ? serverResult.engineSync.failures.map((failure) => failure.name).join(", ")
          : "";
        const projectedStatuses = mcpStatusSynchronizer.project(
          refreshToken,
          serverResult.nextStatuses,
          serverResult.next,
        );
        if (!projectedStatuses) return;
        mutateState((current) => ({
          ...current,
          mcpServers: serverResult.next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: projectedStatuses,
          managedOAuthAvailable: serverResult.managedOAuthAvailable,
          mcpStatus: failedNames
            ? `Some MCPs could not be registered with the engine: ${failedNames}. They may appear disconnected — try reloading the engine.`
            : serverResult.next.length ? null : "No MCP servers configured yet.",
        }));
        const activeClient = options.client();
        if (activeClient && projectDir) {
          reconnectConfiguredComputerUse(activeClient, projectDir, serverResult.next, serverResult.observedStatuses);
        }
        void healUnhealthyMcpEntries(serverResult.next, projectedStatuses, refreshToken);
        return;
      }
    } catch (error) {
      recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-error", {
        message: error instanceof Error ? error.message : String(error),
      });
      const serverTarget = await resolveMcpMarsTarget("read").catch(() => null);
      if (!isCurrentRefresh()) return;
      if (isRemoteWorkspace || serverTarget?.hasMarsTarget) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
        }));
        return;
      }
    }

    if (isRemoteWorkspace) {
      if (!isCurrentRefresh()) return;
      mutateState((current) => ({
        ...current,
        mcpStatus: "marsai.click server unavailable. MCP config is read-only.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    if (!isDesktopRuntime()) {
      if (!isCurrentRefresh()) return;
      mutateState((current) => ({
        ...current,
        mcpStatus: "MCP configuration is only available for local workspaces.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    if (!projectDir) {
      if (!isCurrentRefresh()) return;
      mutateState((current) => ({
        ...current,
        mcpStatus: "Pick a workspace folder to load MCP servers.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    try {
      if (isCurrentRefresh()) setStateField("mcpStatus", null);
      recordPerfLog(options.developerMode(), "mcp.refresh", "desktop-project-fallback", {
        projectDir,
      });
      const [globalConfig, projectConfig] = await Promise.all([
        readOpencodeConfig("global", projectDir) as Promise<OpencodeConfigFile>,
        readOpencodeConfig("project", projectDir) as Promise<OpencodeConfigFile>,
      ]);
      const globalServers = globalConfig.exists && globalConfig.content
        ? parseMcpServersFromContent(globalConfig.content).map((entry) => ({
          ...entry,
          source: "config.global" as const,
        }))
        : [];
      const projectServers = projectConfig.exists && projectConfig.content
        ? parseMcpServersFromContent(projectConfig.content)
        : [];
      const projectNames = new Set(projectServers.map((entry) => entry.name));
      const fileServers = [
        ...globalServers.filter((entry) => !projectNames.has(entry.name)),
        ...projectServers,
      ];
      // Runtime-DB MCPs (source "config.remote") only exist on the marsai.click
      // server. Keep the last-known entries instead of silently dropping them
      // while the server is briefly unreachable (startup race) — otherwise
      // enabled MCPs like mars-ui render as "off".
      const fileNames = new Set(fileServers.map((entry) => entry.name));
      const runtimeServers = state.mcpServers.filter(
        (entry) => entry.source === "config.remote" && !fileNames.has(entry.name),
      );
      const next = [...fileServers, ...runtimeServers];

      recordPerfLog(options.developerMode(), "mcp.refresh", "desktop-project-fallback-result", {
        globalConfigPath: globalConfig.path,
        projectConfigPath: projectConfig.path,
        count: next.length,
        names: next.map((entry) => entry.name),
        sources: next.map((entry) => entry.source ?? "unknown"),
      });

      if (!globalConfig.exists && !projectConfig.exists && runtimeServers.length === 0) {
        if (!isCurrentRefresh()) return;
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: "No opencode.json found yet. Create one by connecting an MCP.",
        }));
        return;
      }

      let nextStatuses = state.mcpStatuses;
      let observedStatuses: Record<string, unknown> = {};
      const activeClient = options.client();
      if (activeClient) {
        try {
          observedStatuses = unwrap(await activeClient.mcp.status({ directory: projectDir })) as Record<string, unknown>;
          nextStatuses = filterConfiguredStatuses(observedStatuses as McpStatusMap, next);
        } catch {
          nextStatuses = {};
        }
      }

      const projectedStatuses = mcpStatusSynchronizer.project(refreshToken, nextStatuses, next);
      if (!projectedStatuses) return;
      mutateState((current) => ({
        ...current,
        mcpServers: next,
        mcpLastUpdatedAt: Date.now(),
        mcpStatuses: projectedStatuses,
        mcpStatus: next.length ? null : "No MCP servers configured yet.",
      }));
      if (activeClient) reconnectConfiguredComputerUse(activeClient, projectDir, next, observedStatuses);
      void healUnhealthyMcpEntries(next, projectedStatuses, refreshToken);
    } catch (error) {
      if (!isCurrentRefresh()) return;
      mutateState((current) => ({
        ...current,
        mcpServers: [],
        mcpStatuses: {},
        mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
      }));
    }
  }

  function mcpMutationDenied(builtIn: boolean) {
    if (mcpDisabledByPolicy()) {
      setStateField("mcpStatus", MCP_DISABLED_BY_POLICY);
      return MCP_DISABLED_BY_POLICY;
    }
    const restriction = builtIn ? "allowBuiltInExtensions" : "allowManageExtensions";
    if (!options.checkDesktopAppRestriction({ restriction })) return null;
    const message = desktopRestrictionNotice(restriction);
    setStateField("mcpStatus", message);
    return message;
  }

  function builtInMcp(name: string) {
    return MCP_QUICK_CONNECT.find((entry) =>
      isBuiltInMarsExtension(entry) && getMcpServerName(entry) === name,
    );
  }

  async function connectMcp(entry: McpDirectoryInfo): Promise<McpConnectResult> {
    const policyError = mcpMutationDenied(false);
    if (policyError) return { ok: false, error: policyError };
    const builtIn = builtInMcp(getMcpServerName(entry));
    // Use catalog configuration for built-ins; caller-supplied metadata must
    // not turn an arbitrary URL or command into an allowed built-in.
    if (builtIn) entry = builtIn;
    // Cloud repair uses the signed-in organization's reconciler below, not
    // caller-supplied MCP configuration. Existing service access stays usable.
    if (entry.managedBy !== "mars-connect") {
      const error = mcpMutationDenied(Boolean(builtIn));
      if (error) return { ok: false, error };
    }
    const startedAt = perfNow();
    const marsSnapshot = getMarsSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && marsSnapshot.marsServerStatus === "connected");
    const projectDir = options.projectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(options.developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const { marsClient, marsWorkspaceId, hasMarsTarget, canUseMarsServer } =
      await resolveWritableMarsTarget();

    if (isRemoteWorkspace && !canUseMarsServer) {
      const error = "marsai.click server unavailable. MCP config is read-only.";
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "mars-server-unavailable",
      });
      return { ok: false, error };
    }

    if (hasMarsTarget && !canUseMarsServer) {
      const error = "marsai.click server MCP config is read-only.";
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "mars-server-read-only",
      });
      return { ok: false, error };
    }

    if (!canUseMarsServer && !isDesktopRuntime()) {
      const error = t("mcp.desktop_required");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return { ok: false, error };
    }

    if (!isRemoteWorkspace && !projectDir && !canUseMarsServer) {
      const error = t("mcp.pick_workspace_first");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return { ok: false, error };
    }

    const activeClient = canUseMarsServer ? options.client() ?? await ensureActiveClient().catch(() => null) : await ensureActiveClient();
    if (!activeClient && !canUseMarsServer) {
      const error = t("mcp.connect_server_first");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return { ok: false, error };
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseMarsServer) {
      const error = t("mcp.pick_workspace_first");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return { ok: false, error };
    }

    const slug = entry.id ?? getMcpServerName(entry);
    const action = snapshot.mcpServers.some((server) => server.name === slug) ? "updated" : "added";

    if (conflictsWithMarsConnect(entry)) {
      const error = t("mcp.name_reserved_mars_connect");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "mars-connect-name-reserved",
      });
      return { ok: false, error };
    }

    try {
      mutateState((current) => ({ ...current, mcpStatus: null, mcpConnectingName: entry.name }));

      if (entry.managedBy === "mars-connect") {
        if (slug !== CLOUD_MCP_SERVER_NAME) {
          throw new Error("marsai.click Connect MCP metadata is invalid.");
        }
        if (!canUseMarsServer || !marsClient || !marsWorkspaceId) {
          throw new Error("marsai.click server is required to repair agent access to connected services.");
        }
        const context = await resolveCloudMcpOperationContext(null);
        if (!context) {
          throw new Error("Sign in to marsai.click Cloud and choose an organization first.");
        }
        clearCloudMcpDisabledIntent(context);
        const result = await runMarsCloudMcpReconciler({
          mode: "repair",
          client: marsClient,
          context: { ...context, trigger: "desktop-explicit-connect" },
          mintToken: mintCloudControlMcpToken,
          force: true,
          refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
        });
        await refreshMcpServers();
        if (result.health?.usable) {
          setStateField("mcpStatus", t("mcp.connected"));
          finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
            name: entry.name,
            type: entryType,
            slug,
          });
          return { ok: true };
        }
        const summary = cloudMcpDisplaySummary({
          signedIn: Boolean(context.denAuthToken?.trim()),
          orgSelected: Boolean(context.orgId.trim()),
          connecting: false,
          health: result.health,
        });
        setStateField("mcpStatus", `${summary.stageLabel}. ${summary.recommendedAction}`);
        finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
          name: entry.name,
          type: entryType,
          error: summary.stageLabel,
        });
        return { ok: false, error: `${summary.stageLabel}. ${summary.recommendedAction}` };
      }

      if (entry.managedOAuth) {
        if (isRemoteWorkspace || !isDesktopRuntime()) {
          throw new Error("marsai.click-managed MCP OAuth is currently available for local desktop workspaces only.");
        }
        if (entryType !== "remote" || !entry.url) {
          throw new Error("marsai.click-managed OAuth requires a remote MCP URL.");
        }
        if (!canUseMarsServer || !marsClient || !marsWorkspaceId) {
          throw new Error("The local marsai.click server is required for managed MCP sign-in.");
        }
        const result = await marsClient.addManagedMcp(marsWorkspaceId, {
          name: slug,
          url: entry.url,
          oauth: {
            applicationType: "native",
            requestedScopes: entry.oauthConfig?.scope?.split(/\s+/).filter(Boolean),
            clientId: entry.oauthConfig?.clientId,
            clientSecret: entry.oauthConfig?.clientSecret,
          },
        });
        const connected = await waitForManagedMcpAuthorization(
          marsClient,
          marsWorkspaceId,
          slug,
          result,
        );
        options.markReloadRequired?.("mcp", { type: "mcp", name: slug, action });
        await refreshMcpServers();
        if (connected) setStateField("mcpStatus", t("mcp.connected"));
        finishPerf(options.developerMode(), "mcp.connect", connected ? "done" : "blocked", startedAt, {
          name: entry.name,
          type: entryType,
          slug,
        });
        return connected
          ? { ok: true }
          : {
              ok: false,
              error: state.mcpStatus ?? "MCP sign-in is still pending. Finish it in your browser, then refresh connections.",
            };
      }

      // Resolve dynamic URLs for built-in MCPs
      let resolvedUrl = entry.url;
      let resolvedHeaders: Record<string, string> | undefined;
      if (!resolvedUrl && entry.serverName === "mars-ui") {
        try {
          const bridgeInfo = await window.__MARS_ELECTRON__?.invokeDesktop?.("getUiControlBridgeInfo");
          if (bridgeInfo?.baseUrl) {
            resolvedUrl = `${bridgeInfo.baseUrl}/mcp`;
            if (bridgeInfo.token) {
              resolvedHeaders = { Authorization: `Bearer ${bridgeInfo.token}` };
            }
          }
        } catch {
          // Bridge not available
        }
      }

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!resolvedUrl) {
          throw new Error("Missing MCP URL. Is the marsai.click desktop app running?");
        }
        mcpEntryConfig["url"] = resolvedUrl;
        if (resolvedHeaders) {
          mcpEntryConfig["headers"] = resolvedHeaders;
          // Header-authed entries must not trigger OAuth auto-detection;
          // otherwise opencode reports "needs_auth" despite valid headers.
          mcpEntryConfig["oauth"] = false;
        }
        if (!resolvedHeaders) {
          if (entry.oauthConfig) {
            mcpEntryConfig["oauth"] = entry.oauthConfig;
          } else if (entry.oauth) {
            mcpEntryConfig["oauth"] = {};
          }
        }
      }

      if (entryType === "local") {
        const command = await resolveLocalMcpCommand(entry);
        if (!command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = command;
        const environment = await resolveLocalMcpEnvironment(entry);
        if (environment) {
          mcpEntryConfig["environment"] = environment;
        }
      }

      if (canUseMarsServer && marsClient && marsWorkspaceId) {
        await marsClient.addMcp(marsWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        const configFile = await readOpencodeConfig("project", resolvedProjectDir) as OpencodeConfigFile;

        const raw = configFile.exists && configFile.content?.trim()
          ? configFile.content
          : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

        const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
        parse(raw, parseErrors, { allowTrailingComma: true });
        if (parseErrors.length > 0) {
          const details = parseErrors
            .map((entry) => printParseErrorCode(entry.error))
            .join(", ");
          throw new Error(`Failed to parse opencode config: ${details}`);
        }

        let updated = raw;
        const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
        updated = applyEdits(
          updated,
          modify(updated, ["$schema"], "https://opencode.ai/config.json", { formattingOptions }),
        );
        updated = applyEdits(
          updated,
          modify(updated, ["mcp", slug], mcpEntryConfig, { formattingOptions }),
        );

        const writeResult = await writeOpencodeConfig(
          "project",
          resolvedProjectDir,
          updated.endsWith("\n") ? updated : `${updated}\n`,
        ) as { ok: boolean; stderr?: string; stdout?: string };
        if (!writeResult.ok) {
          throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
        }
      }

      if (canUseMarsServer && marsClient && marsWorkspaceId) {
        // The marsai.click server is the source of truth for workspace-scoped MCP
        // config in the React port. Avoid also calling the OpenCode SDK's MCP
        // hot-add endpoint here: when the SDK client is rooted at the aggregate
        // `/opencode` route it can resolve to an internal `local_*` workspace
        // id that the marsai.click server does not expose, producing a confusing
        // `workspace_not_found` after the config write already succeeded.
      } else {
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        const mcpAddConfig =
          entryType === "remote"
            ? {
                type: "remote" as const,
                url: resolvedUrl ?? entry.url!,
                enabled: true,
                ...(resolvedHeaders ? { headers: resolvedHeaders, oauth: false as const } : {}),
                ...(!resolvedHeaders && entry.oauthConfig ? { oauth: entry.oauthConfig } : {}),
                ...(!resolvedHeaders && !entry.oauthConfig && entry.oauth ? { oauth: {} } : {}),
              }
            : {
                type: "local" as const,
                command: (mcpEntryConfig["command"] as string[]) ?? entry.command!,
                // Keep the resolved environment: the bundled UI-control MCP
                // runs the app binary and needs ELECTRON_RUN_AS_NODE=1.
                ...(mcpEntryConfig["environment"]
                  ? { environment: mcpEntryConfig["environment"] as Record<string, string> }
                  : {}),
                enabled: true,
              };

        unwrap(
          await activeClient.mcp.add({
            directory: resolvedProjectDir,
            name: slug,
            config: mcpAddConfig,
          }),
        );
        if (entryType === "local" && slug === "computer-use") {
          await activeClient.mcp.connect({ name: slug, directory: resolvedProjectDir });
          if (!(await waitForMcpConnected(activeClient, slug, resolvedProjectDir))) {
            throw new Error("Computer Use is still starting. Refresh the status if it does not connect.");
          }
        }
      }
      options.markReloadRequired?.("mcp", { type: "mcp", name: slug, action });
      await refreshMcpServers();

      // OAuth is auto-detected: open the sign-in modal when the directory
      // entry declares OAuth up front, or when the engine reports the fresh
      // remote entry as needing auth. Custom apps no longer ask the user to
      // know whether their server uses OAuth.
      let needsAuth = Boolean(entry.oauth) && !resolvedHeaders;
      if (!needsAuth && entryType === "remote" && !resolvedHeaders) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const detected = snapshot.mcpStatuses[slug]?.status;
          if (detected === "needs_auth" || detected === "needs_client_registration") {
            needsAuth = true;
            break;
          }
          if (detected === "connected" || detected === "failed" || detected === "disabled") break;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await refreshMcpServers();
        }
      }

      if (needsAuth) {
        mutateState((current) => ({
          ...current,
          mcpAuthEntry: entry,
          mcpAuthNeedsReload: true,
          mcpAuthModalOpen: true,
        }));
      } else {
        setStateField("mcpStatus", t("mcp.connected"));
      }

      await refreshMcpServers();
      finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
      return { ok: true };
    } catch (error) {
      console.error("[mcp.connect] failed", entry.name, error);
      const message = error instanceof Error ? error.message : t("mcp.connect_failed");
      setStateField("mcpStatus", message);
      finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      return { ok: false, error: message };
    } finally {
      setStateField("mcpConnectingName", null);
    }
  }

  /**
   * Background reconciliation for the Den cloud MCP: when the desktop is
   * signed in to marsai.click Cloud with an active org, keep the
   * `mars-cloud` MCP entry configured with a fresh first-party token.
   * Quiet by design — a failed mint never opens the OAuth modal.
   *
   * `force` bypasses the freshness marker: used by the user-facing Refresh
   * button so "make my cloud connection current NOW" is one click (re-mint
   * token + rewrite config + reconnect) instead of sign-out/sign-in or
   * waiting for the marker to expire.
   */
  async function syncCloudControlMcp(options?: { force?: boolean }): Promise<"synced" | "unchanged" | "skipped"> {
    if (mcpDisabledByPolicy()) {
      setStateField("mcpStatus", MCP_DISABLED_BY_POLICY);
      return "skipped";
    }
    const settings = readDenSettings();
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!orgId || !settings.authToken?.trim()) return "skipped";
    const workspaceId = await resolveMarsWorkspaceId();
    if (!workspaceId) return "skipped";
    const marsClient = getMarsSnapshot().marsServerClient;
    const serverBaseUrl = marsClient?.baseUrl.trim() ?? "";
    if (!marsClient || !serverBaseUrl) return "skipped";

    const entry = MCP_QUICK_CONNECT.find((candidate) => candidate.serverName === CLOUD_MCP_SERVER_NAME);
    if (!entry) return "skipped";
    const scope = { denBaseUrl: settings.baseUrl, serverBaseUrl, orgId, workspaceId };

    // Respect explicit user intent for this exact workspace/org/server/deployment.
    if (readCloudMcpUserState(scope) !== null) return "skipped";
    const configuredEntry = snapshot.mcpServers.find((server) => server.name === CLOUD_MCP_SERVER_NAME);
    if (configuredEntry?.config.enabled === false) return "skipped";

    const result = await runMarsCloudMcpReconciler({
      mode: "repair",
      client: marsClient,
      context: {
        ...scope,
        denAuthToken: settings.authToken,
        orgSlug: settings.activeOrgSlug,
        orgName: settings.activeOrgName,
        fallbackUrl: configuredEntry?.config.url ?? entry.url,
        trigger: options?.force ? "desktop-settings-force" : "desktop-settings-background",
      },
      mintToken: mintCloudControlMcpToken,
      force: options?.force,
      refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
    });
    if (result.status === "unchanged" || result.status === "ready") return "unchanged";
    if (result.health?.usable) {
      await refreshMcpServers();
      return "synced";
    }
    return "skipped";
  }

  async function waitForManagedMcpAuthorization(
    marsClient: MarsServerClient,
    workspaceId: string,
    name: string,
    result: { status: "connected" } | { status: "needs_auth"; authorizeUrl: string },
  ): Promise<boolean> {
    if (result.status === "connected") return true;
    await openDesktopUrl(assertDesktopWebUrl(result.authorizeUrl));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const connection = await marsClient.getManagedMcp(workspaceId, name);
      if (connection.status === "connected") return true;
      if (connection.status === "reconnect_required") {
        throw new Error(connection.lastError || "MCP sign-in needs to be restarted.");
      }
    }
    setStateField("mcpStatus", "MCP sign-in is still pending. Finish it in your browser, then refresh connections.");
    return false;
  }

  async function authorizeMcp(entry: McpServerEntry) {
    if (mcpMutationDenied(Boolean(builtInMcp(entry.name)))) return;
    if (entry.managedOAuth) {
      try {
        const { marsClient, marsWorkspaceId, canUseMarsServer } = await resolveWritableMarsTarget();
        if (!canUseMarsServer || !marsClient || !marsWorkspaceId) {
          throw new Error("The local marsai.click server is required for managed MCP sign-in.");
        }
        mutateState((current) => ({ ...current, mcpStatus: null, mcpConnectingName: entry.name }));
        const result = await marsClient.connectManagedMcp(marsWorkspaceId, entry.name);
        const connected = await waitForManagedMcpAuthorization(marsClient, marsWorkspaceId, entry.name, result);
        await refreshMcpServers();
        if (connected) setStateField("mcpStatus", t("mcp.connected"));
      } catch (error) {
        setStateField("mcpStatus", error instanceof Error ? error.message : t("mcp.connect_failed"));
      } finally {
        setStateField("mcpConnectingName", null);
      }
      return;
    }
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setStateField("mcpStatus", t("mcp.login_unavailable"));
      return;
    }

    const matchingQuickConnect = MCP_QUICK_CONNECT.find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    mutateState((current) => ({
      ...current,
      mcpAuthEntry:
        matchingQuickConnect ?? {
          name: entry.name,
          description: "",
          type: "remote",
          url: entry.config.url,
          oauth: true,
        },
      mcpAuthNeedsReload: false,
      mcpAuthModalOpen: true,
    }));
  }

  async function logoutMcpAuth(name: string) {
    if (mcpMutationDenied(Boolean(builtInMcp(name)))) return;
    const marsSnapshot = getMarsSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && marsSnapshot.marsServerStatus === "connected");
    const projectDir = options.projectDir().trim();

    const { marsClient, marsWorkspaceId, hasMarsTarget, canUseMarsServer } =
      await resolveWritableMarsTarget();

    if (isRemoteWorkspace && !canUseMarsServer) {
      setStateField("mcpStatus", "marsai.click server unavailable. MCP auth is read-only.");
      return;
    }

    if (hasMarsTarget && !canUseMarsServer) {
      setStateField("mcpStatus", "marsai.click server MCP auth is read-only.");
      return;
    }

    if (!canUseMarsServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", t("mcp.desktop_required"));
      return;
    }

    const activeClient = canUseMarsServer ? options.client() : await ensureActiveClient();
    if (!activeClient && !canUseMarsServer) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      return;
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseMarsServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      return;
    }

    const safeName = validateMcpServerName(name);
    setStateField("mcpStatus", null);

    try {
      if (canUseMarsServer && marsClient && marsWorkspaceId) {
        await marsClient.logoutMcpAuth(marsWorkspaceId, safeName);
      } else {
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      await refreshMcpServers();
      setStateField("mcpStatus", t("mcp.logout_success").replace("{server}", safeName));
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.logout_failed"),
      );
    }
  }

  async function removeMcp(name: string) {
    if (mcpMutationDenied(Boolean(builtInMcp(name)))) return;
    try {
      setStateField("mcpStatus", null);

      const { marsClient, marsWorkspaceId, hasMarsTarget, canUseMarsServer } =
        await resolveWritableMarsTarget();

      if (canUseMarsServer && marsClient && marsWorkspaceId) {
        await marsClient.removeMcp(marsWorkspaceId, name);
      } else {
        if (hasMarsTarget) {
          setStateField("mcpStatus", "marsai.click server MCP config is read-only.");
          return;
        }
        const projectDir = options.projectDir().trim();
        if (!projectDir) {
          setStateField("mcpStatus", t("mcp.pick_workspace_first"));
          return;
        }
        await removeMcpFromConfig(projectDir, name);
      }

      if (name === CLOUD_MCP_SERVER_NAME) {
        const context = await resolveCloudMcpOperationContext(null);
        if (context) recordCloudMcpDisabledIntent(context, "removed");
      }
      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "removed" });
      await refreshMcpServers();
      if (snapshot.selectedMcp === name) {
        setStateField("selectedMcp", null);
      }
      setStateField("mcpStatus", null);
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.remove_failed"),
      );
    }
  }

  function notifyMcpReloading() {
    setStateField("mcpStatus", t("mcp.reloading_status"));
  }

  // OpenCode reconnects MCP servers asynchronously after /instance/dispose,
  // so an immediate mcp.status query returns stale "disconnected". Poll on
  // a backoff until every enabled MCP reaches a terminal status, with the
  // banner up the whole time so users see continuous feedback.
  async function pollMcpServersAfterReload(): Promise<void> {
    if (disposed) return;
    notifyMcpReloading();
    await refreshMcpServers();

    const settled = (statuses: McpStatusMap, servers: McpServerEntry[]) => {
      const expected = servers.filter((s) => s.config.enabled !== false);
      if (expected.length === 0) return true;
      return expected.every((server) => {
        const status = statuses[server.name]?.status;
        return status === "connected" || status === "needs_auth" || status === "failed";
      });
    };

    const delays = [400, 800, 1500, 2500, 4000];
    for (const delay of delays) {
      if (disposed) return;
      if (settled(snapshot.mcpStatuses, snapshot.mcpServers)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await refreshMcpServers();
    }

    if (disposed) return;
    // Only clear the reloading banner if it's still ours. refreshMcpServers
    // may have already replaced it with a real message (e.g. "No MCP servers").
    if (snapshot.mcpStatus === t("mcp.reloading_status")) {
      setStateField("mcpStatus", null);
    }
  }

  // Server-only path. Local fallback would rewrite opencode.jsonc whole and
  // clobber inline comments — settings-route.tsx already gates the prop so
  // this never gets called when the server is unavailable. Reload UX comes
  // from the existing reload-required popup; no extra banner here.
  async function setMcpEnabled(name: string, enabled: boolean) {
    if (mcpMutationDenied(Boolean(builtInMcp(name)))) return;
    try {
      const { marsClient, marsWorkspaceId, canUseMarsServer } =
        await resolveWritableMarsTarget();

      if (!canUseMarsServer || !marsClient || !marsWorkspaceId) {
        setStateField("mcpStatus", t("mcp.toggle_requires_server"));
        return;
      }

      await marsClient.setMcpEnabled(marsWorkspaceId, name, enabled);
      if (name === CLOUD_MCP_SERVER_NAME) {
        const context = await resolveCloudMcpOperationContext(null);
        if (enabled) {
          if (context) clearCloudMcpDisabledIntent(context);
        } else if (context) {
          recordCloudMcpDisabledIntent(context, "disabled");
        }
      }
      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "updated" });
      await refreshMcpServers();
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.toggle_failed"),
      );
    }
  }

  function closeMcpAuthModal() {
    mutateState((current) => ({
      ...current,
      mcpAuthModalOpen: false,
      mcpAuthEntry: null,
      mcpAuthNeedsReload: false,
    }));
  }

  function recordMcpAuthenticated(name: string) {
    const workspaceContextKey = getWorkspaceContextKey();
    mcpStatusSynchronizer.recordAuthenticated(workspaceContextKey, name);
    const normalizedName = normalizeMcpSlug(name);
    const configuredName = state.mcpServers.find((entry) => (
      normalizeMcpSlug(entry.id ?? entry.name) === normalizedName
      || normalizeMcpSlug(entry.name) === normalizedName
    ))?.name ?? name;
    mutateState((current) => ({
      ...current,
      mcpStatuses: {
        ...current.mcpStatuses,
        [configuredName]: { status: "connected" },
      },
    }));

    const pollKey = `${workspaceContextKey}\n${normalizedName}`;
    if (authStatusPolls.has(pollKey)) return;
    authStatusPolls.add(pollKey);
    void (async () => {
      const delays = [0, 250, 500, 1_000, 2_000, 4_000];
      try {
        for (const delay of delays) {
          if (disposed || !mcpStatusSynchronizer.isPending(workspaceContextKey, name)) return;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          if (disposed) return;
          await refreshMcpServers();
        }
      } finally {
        authStatusPolls.delete(pollKey);
      }
    })();
  }

  async function completeMcpAuthModal() {
    closeMcpAuthModal();
    await refreshMcpServers();
  }

  const syncFromOptions = () => {
    const workspaceContextKey = getWorkspaceContextKey();
    const projectDir = options.projectDir().trim();
    const changed =
      workspaceContextKey !== lastWorkspaceContextKey || projectDir !== lastProjectDir;

    lastWorkspaceContextKey = workspaceContextKey;
    lastProjectDir = projectDir;

    if (!started || disposed || !changed) {
      return;
    }

    if (!isDesktopRuntime() && getMarsSnapshot().marsServerStatus !== "connected") {
      return;
    }

    void refreshMcpServers();
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;
    syncFromOptions();
  };

  const dispose = () => {
    disposed = true;
    started = false;
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    get mcpServers() {
      return snapshot.mcpServers;
    },
    get mcpStatus() {
      return snapshot.mcpStatus;
    },
    get mcpLastUpdatedAt() {
      return snapshot.mcpLastUpdatedAt;
    },
    get mcpStatuses() {
      return snapshot.mcpStatuses;
    },
    get mcpConnectingName() {
      return snapshot.mcpConnectingName;
    },
    get selectedMcp() {
      return snapshot.selectedMcp;
    },
    setSelectedMcp(value: SetStateAction<string | null>) {
      const resolved = applyStateAction(state.selectedMcp, value);
      setStateField("selectedMcp", resolved);
    },
    quickConnect: MCP_QUICK_CONNECT,
    readMcpConfigFile,
    refreshMcpServers,
    connectMcp,
    syncCloudControlMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    setMcpEnabled,
    notifyMcpReloading,
    pollMcpServersAfterReload,
    get mcpAuthModalOpen() {
      return snapshot.mcpAuthModalOpen;
    },
    get mcpAuthEntry() {
      return snapshot.mcpAuthEntry;
    },
    get mcpAuthNeedsReload() {
      return snapshot.mcpAuthNeedsReload;
    },
    closeMcpAuthModal,
    recordMcpAuthenticated,
    completeMcpAuthModal,
  };
}

export function useConnectionsStoreSnapshot(store: ConnectionsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
