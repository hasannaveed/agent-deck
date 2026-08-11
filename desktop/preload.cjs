const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "switchboardDesktop",
  Object.freeze({
    getState: () => ipcRenderer.invoke("desktop:get-state"),
    minimize: () => ipcRenderer.invoke("desktop:minimize"),
    hide: () => ipcRenderer.invoke("desktop:hide"),
    expand: () => ipcRenderer.invoke("desktop:expand"),
    focusSession: (sessionId) => ipcRenderer.invoke("desktop:focus-session", sessionId),
    linkSession: (sessionId) => ipcRenderer.invoke("desktop:link-session", sessionId),
    onStateChanged: (callback) => {
      if (typeof callback !== "function") return;
      ipcRenderer.on("desktop:state-changed", (_event, state) => callback(state));
    },
  }),
);
