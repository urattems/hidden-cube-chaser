// Replays saved corner-map frames (mm_<epoch ms>.png) through the vision window, with Questlog
// positions from a probe file as priors, and writes the fixes to tools\vision-test.log.
// Usage: electron.exe tools\vision-test.js <frames dir> <probe-objects.json> [--scale=<s>]
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const scaleArg = process.argv.find((a) => a.startsWith("--scale="));
const [framesDir, probeFile] = process.argv.filter((a) => !a.startsWith("--")).slice(-2);
const logFile = path.join(__dirname, "vision-test.log");
fs.writeFileSync(logFile, "");
const log = (line) => fs.appendFileSync(logFile, line + "\n");

app.whenReady().then(() => {
  let selves = JSON.parse(fs.readFileSync(probeFile, "utf8")).selves;
  let frames = fs
    .readdirSync(framesDir)
    .filter((n) => /^mm_\d+\.png$/.test(n))
    .sort()
    .map((name) => {
      let at = Number(name.slice(3, -4));
      let self = selves.reduce((a, b) => (Math.abs(b.at - at) < Math.abs(a.at - at) ? b : a));
      return { name, at, url: pathToFileURL(path.join(framesDir, name)).href, prior: { x: self.x, y: self.y, accuracy: self.accuracy } };
    });
  let win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, "..", "src", "vision", "preload.js"), backgroundThrottling: false },
  });
  ipcMain.on("vision-result", (_e, r) => {
    if (r.status === "test-done") return app.quit();
    let pos = r.x === undefined ? "" : ` world=(${(r.x / 100).toFixed(1)}, ${(r.y / 100).toFixed(1)}) m`;
    log(`${r.name ?? ""} ${r.status}${pos} score=${r.score?.toFixed?.(3)} patches=${r.patches} scale=${r.scale?.toFixed?.(3)} map=${r.mapKey} ${r.ms} ms${r.error ? " " + r.error : ""}`);
  });
  win.webContents.on("console-message", (_e, level, message) => log(`[console] ${message}`));
  win.loadFile(path.join(__dirname, "..", "src", "vision", "vision.html"));
  win.webContents.on("did-finish-load", () => {
    let maps = path.join(process.env.LOCALAPPDATA, "Aion2MapOverlayData", "maps");
    win.webContents.send("vision-config", {
      mapsUrl: pathToFileURL(maps).href,
      anchor: { x: 0.5, y: 0.5 },
      scale: scaleArg ? Number(scaleArg.slice(8)) : undefined,
      testFrames: frames,
    });
  });
  setTimeout(() => {
    log("timeout");
    app.quit();
  }, 180000);
});
