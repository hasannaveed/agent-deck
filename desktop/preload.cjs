const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "switchboardDesktop",
  Object.freeze({
    getState: () => ipcRenderer.invoke("desktop:get-state"),
    togglePinned: () => ipcRenderer.invoke("desktop:toggle-pinned"),
    minimize: () => ipcRenderer.invoke("desktop:minimize"),
    hide: () => ipcRenderer.invoke("desktop:hide"),
    focusSession: (sessionId) => ipcRenderer.invoke("desktop:focus-session", sessionId),
    linkSession: (sessionId) => ipcRenderer.invoke("desktop:link-session", sessionId),
    onStateChanged: (callback) => {
      if (typeof callback !== "function") return;
      ipcRenderer.on("desktop:state-changed", (_event, state) => callback(state));
    },
  }),
);
