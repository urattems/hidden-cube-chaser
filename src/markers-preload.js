const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("markers", {
  onUpdate: (callback) => ipcRenderer.on("markers", (_event, list) => callback(list)),
});
