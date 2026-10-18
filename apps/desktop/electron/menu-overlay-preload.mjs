import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("mars:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

ipcRenderer.on("mars:menu-overlay:hide", () => {
  latestRequest = null;
  showCallback?.(null);
});

contextBridge.exposeInMainWorld("__MARS_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("mars:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("mars:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("mars:menu-overlay:close", { requestId });
  },
});
