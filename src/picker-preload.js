const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("picker", {
  done: (rect) => ipcRenderer.send("picker-done", rect),
  cancel: () => ipcRenderer.send("picker-cancel"),
});
