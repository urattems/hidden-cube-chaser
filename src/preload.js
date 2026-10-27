const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chaser", {
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
});
