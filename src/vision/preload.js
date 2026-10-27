const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vision", {
  onConfig: (callback) => ipcRenderer.on("vision-config", (_event, config) => callback(config)),
  onPrior: (callback) => ipcRenderer.on("vision-prior", (_event, prior) => callback(prior)),
  report: (result) => ipcRenderer.send("vision-result", result),
});
