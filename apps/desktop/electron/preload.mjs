import { contextBridge, ipcRenderer, webUtils } from "electron";

const NATIVE_DEEP_LINK_EVENT = "mars:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "mars:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "mars:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "mars:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "mars:native-menu:zoom";
const AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT = "mars:automation-runner:credential-rejected";
const FINISH_GUARD_EVENT = "mars:finish-guard:finish";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.marsShell = "electron";
    root.classList.add("mars-electron");
    if (process.platform === "darwin") {
      root.classList.add("mars-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("mars-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("mars-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("mars:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
}

// Capture before message-bubble menus, but leave files, app routes, editable
// text, and ordinary clicks to their existing handlers.
window.addEventListener("contextmenu", (event) => {
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (!anchor || anchor.isContentEditable || anchor.hasAttribute("download")) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!/^(https?:)?\/\//i.test(href)) return;
  let url;
  try { url = new URL(anchor.href); } catch { return; }
  if (!["http:", "https:"].includes(url.protocol)) return;
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send("mars:browser:linkContextMenu", {
    url: url.href,
    point: { x: event.clientX, y: event.clientY },
    sessionId: anchor.closest("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? null,
  });
}, { capture: true });

let desktopBootstrap = null;
let desktopDistribution = null;
try {
  desktopBootstrap = ipcRenderer.sendSync("mars:desktop-bootstrap-sync");
  desktopDistribution = ipcRenderer.sendSync("mars:desktop-distribution-sync");
} catch {
  desktopBootstrap = null;
  desktopDistribution = null;
}

contextBridge.exposeInMainWorld("__MARS_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("mars:desktop", command, ...args);
  },
  automationRunner: {
    onCredentialRejected(callback) {
      const handler = () => callback();
      ipcRenderer.on(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
      return () => ipcRenderer.removeListener(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
    },
  },
  fileSystem: {
    getPathForFile(file) {
      return webUtils.getPathForFile(file);
    },
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("mars:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("mars:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("mars:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("mars:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("mars:system:askMicrophoneAccess");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("mars:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("mars:migration:ack");
    },
  },
  brandIcon: {
    apply(url) {
      return ipcRenderer.invoke("mars:desktop", "__applyBrandIcon", url ?? null);
    },
    getState() {
      return ipcRenderer.invoke("mars:desktop", "__getBrandIconState");
    },
  },
  dev: {
    evalRelaunch() {
      return ipcRenderer.invoke("mars:desktop", "__evalRelaunch");
    },
  },
  startup: {
    /** The window shows "couldn't start": one report per attempt, answered with the hint to show. */
    reportFailure(input) {
      return ipcRenderer.invoke("mars:desktop", "startupReportFailure", input ?? {});
    },
    /** Clear read-only marks on the local databases, then restart. */
    repairStore() {
      return ipcRenderer.invoke("mars:desktop", "startupRepairStore");
    },
    /** Move the local start state into a backup folder on restart, then restart. */
    resetAppData() {
      return ipcRenderer.invoke("mars:desktop", "startupResetAppData");
    },
  },
  nuke: {
    preview(options) {
      return ipcRenderer.invoke("mars:desktop", "nukeMarsAndOpencodeConfigPreview", options);
    },
    execute(options) {
      return ipcRenderer.invoke("mars:desktop", "nukeMarsAndOpencodeConfigAndExit", options);
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("mars:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("mars:updater:setChannel", channel);
    },
    check(channel, targetVersion) {
      return ipcRenderer.invoke("mars:updater:check", channel, targetVersion);
    },
    download() {
      return ipcRenderer.invoke("mars:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("mars:updater:installAndRestart");
    },
    /** Reveal a downloaded Linux package in the file manager. */
    showDownloaded() {
      return ipcRenderer.invoke("mars:updater:showDownloaded");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("mars:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("mars:updater:download-progress", handler);
      };
    },
  },
  updateGate: {
    /** The mandatory-update state (update-gate.mjs): "none", "required" or "blocked". */
    get() {
      return ipcRenderer.invoke("mars:update-gate:get");
    },
    /** Reads the account profile again and resolves the state it leaves. */
    refresh() {
      return ipcRenderer.invoke("mars:update-gate:refresh");
    },
    onChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("mars:update-gate:changed", handler);
      return () => {
        ipcRenderer.removeListener("mars:update-gate:changed", handler);
      };
    },
  },
  recovery: {
    recordHealthy() {
      return ipcRenderer.invoke("mars:recovery:recordHealthy");
    },
    list(policy) {
      return ipcRenderer.invoke("mars:recovery:list", policy);
    },
    restorePrevious() {
      return ipcRenderer.invoke("mars:recovery:restorePrevious");
    },
    use(id) {
      return ipcRenderer.invoke("mars:recovery:use", id);
    },
  },
  browser: {
    show(bounds, sessionId) { return ipcRenderer.invoke("mars:browser:show", bounds, sessionId); },
    hide() { return ipcRenderer.invoke("mars:browser:hide"); },
    openUrl(url, provider, options) { return ipcRenderer.invoke("mars:browser:openUrl", url, provider, options); },
    setVisibleSession(sessionId) { return ipcRenderer.invoke("mars:browser:setVisibleSession", sessionId); },
    navigate(url) { return ipcRenderer.invoke("mars:browser:navigate", url); },
    back() { return ipcRenderer.invoke("mars:browser:back"); },
    forward() { return ipcRenderer.invoke("mars:browser:forward"); },
    reload() { return ipcRenderer.invoke("mars:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("mars:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("mars:browser:state"); },
    createTab(url, sessionId) { return ipcRenderer.invoke("mars:browser:createTab", url, sessionId); },
    closeTab(tabId) { return ipcRenderer.invoke("mars:browser:closeTab", tabId); },
    suspendTab(tabId) { return ipcRenderer.invoke("mars:browser:suspendTab", tabId); },
    restoreTab(tabId, sessionId) { return ipcRenderer.invoke("mars:browser:restoreTab", tabId, sessionId); },
    releaseTab(tabId, sessionId) { return ipcRenderer.invoke("mars:browser:releaseTab", tabId, sessionId); },
    closeAllTabs() { return ipcRenderer.invoke("mars:browser:closeAllTabs"); },
    closeSessionTabs(sessionId) { return ipcRenderer.invoke("mars:browser:closeSessionTabs", sessionId); },
    selectTab(tabId) { return ipcRenderer.invoke("mars:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("mars:browser:reorderTabs", tabIds); },
    approve(tabId, approvalId, allowed) { return ipcRenderer.invoke("mars:browser:approve", tabId, approvalId, allowed); },
    taskControl(tabId, action) { return ipcRenderer.invoke("mars:browser:taskControl", tabId, action); },
    listTabs() { return ipcRenderer.invoke("mars:browser:listTabs"); },
    listWebMcpTools(args) { return ipcRenderer.invoke("mars:browser:webmcpListTools", args); },
    executeWebMcpTool(args) { return ipcRenderer.invoke("mars:browser:webmcpExecuteTool", args); },
    setProxy(proxy) { return ipcRenderer.invoke("mars:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("mars:browser:getProxy"); },
    setControlEnabled(enabled) { return ipcRenderer.invoke("mars:browser:setControlEnabled", enabled); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("mars:browser:tabContextMenu", tabId, point); },
    destroy() { return ipcRenderer.invoke("mars:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("mars:browser:state", handler);
      return () => ipcRenderer.removeListener("mars:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("mars:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("mars:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("mars:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("mars:browser:panel-closed", handler);
    },
  },
  browserLogins: {
    disableForManagedContext() { return ipcRenderer.invoke("mars:browser-logins:disableForManagedContext"); },
    sources() { return ipcRenderer.invoke("mars:browser-logins:sources"); },
    preview(request) { return ipcRenderer.invoke("mars:browser-logins:preview", request); },
    configure(request) { return ipcRenderer.invoke("mars:browser-logins:configure", request); },
    state() { return ipcRenderer.invoke("mars:browser-logins:state"); },
    syncNow() { return ipcRenderer.invoke("mars:browser-logins:syncNow"); },
    pause() { return ipcRenderer.invoke("mars:browser-logins:pause"); },
    resume() { return ipcRenderer.invoke("mars:browser-logins:resume"); },
    stopSite(site) { return ipcRenderer.invoke("mars:browser-logins:stopSite", site); },
    disconnect(request) { return ipcRenderer.invoke("mars:browser-logins:disconnect", request); },
    signedInSites() { return ipcRenderer.invoke("mars:browser-logins:signedIn"); },
    forgetSite(site) { return ipcRenderer.invoke("mars:browser-logins:forgetSite", site); },
    forgetAll() { return ipcRenderer.invoke("mars:browser-logins:forgetAll"); },
    ...(process.env.MARS_EVAL_BROWSER_LOGIN_SYNC === "1" ? {
      writeTestStore(request) { return ipcRenderer.invoke("mars:browser-logins:writeTestStore", request); },
      testWitnessUrl() { return ipcRenderer.invoke("mars:browser-logins:testWitnessUrl"); },
    } : {}),
  },
  terminal: {
    shells() { return ipcRenderer.invoke("mars:terminal:shells"); },
    create(options) { return ipcRenderer.invoke("mars:terminal:create", options); },
    killWorkspace(workspaceId) { return ipcRenderer.invoke("mars:terminal:killWorkspace", workspaceId); },
    write(terminalId, data) { return ipcRenderer.invoke("mars:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("mars:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("mars:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("mars:terminal:data", handler);
      return () => ipcRenderer.removeListener("mars:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("mars:terminal:exit", handler);
      return () => ipcRenderer.removeListener("mars:terminal:exit", handler);
    },
  },
  meta: {
    desktopBootstrap,
    distribution: desktopDistribution,
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
    evalFatalBootstrapFailure: process.env.MARS_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE ?? null,
  },
});

if (
  process.env.MARS_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE
  && (process.env.MARS_EVAL_RECOVERY_CANDIDATES || process.env.MARS_EVAL_RECOVERY_RELEASES)
) {
  contextBridge.exposeInMainWorld("__marsRecoveryControl", {
    snapshot() {
      return ipcRenderer.invoke("mars:recovery:evalSnapshot");
    },
    select(id) {
      return ipcRenderer.invoke("mars:recovery:use", id);
    },
  });
}

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

// The finish guard's "Finish it" (turn-guard.mjs): the open session fills its composer.
ipcRenderer.on(FINISH_GUARD_EVENT, (_event, detail) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FINISH_GUARD_EVENT, { detail }));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}
