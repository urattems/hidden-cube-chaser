// Runs the vision window that reads the game's corner map, and the region picker.
// The region defaults to the one already calibrated in Aion 2 - Map Overlay.
const { BrowserWindow, desktopCapturer, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { EventEmitter } = require("events");

const MAP_OVERLAY_DIR = path.join(process.env.LOCALAPPDATA ?? "", "Aion2MapOverlayData");
const MAPS_DIR = path.join(MAP_OVERLAY_DIR, "maps");
const RESTART_MS = 15000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

// Map Overlay's capture region (physical screen px) and player anchor, if it has one.
function mapOverlayRegion() {
  let region = readJson(path.join(MAP_OVERLAY_DIR, "state.json"))?.region;
  if (!region?.width || !region?.height) return undefined;
  let s = readJson(path.join(MAP_OVERLAY_DIR, "settings.json")) ?? {};
  return {
    region: { x: region.left, y: region.top, width: region.width, height: region.height },
    anchor: { x: s.player_anchor_x ?? 0.5, y: s.player_anchor_y ?? 0.5 },
  };
}

function mapsAvailable() {
  return ["verteron", "altgard"].some((k) => fs.existsSync(path.join(MAPS_DIR, k, "tiles", "5")));
}

class MinimapTracker extends EventEmitter {
  // dumpPath: diagnostics, saves the first captured region there as PNG.
  constructor(log, dumpPath) {
    super();
    this.log = log;
    this.dumpPath = dumpPath;
    this.win = undefined;
    this.key = undefined;
    ipcMain.on("vision-result", (event, result) => {
      if (!this.win || event.sender !== this.win.webContents) return;
      if (result.status === "stalled") return this.restart();
      if (result.status !== "dump") return this.emit("result", result);
      fs.writeFileSync(this.dumpPath, Buffer.from(result.png));
      this.log(`minimap frame saved to ${this.dumpPath} (stream ${result.video.join("x")})`);
    });
  }

  // wanted: { region, anchor, scale, mapKey } or undefined to stop.
  async update(wanted) {
    let key = wanted && JSON.stringify([wanted.region, wanted.anchor]);
    if (key === this.key) return;
    this.stop();
    this.key = key;
    this.wanted = wanted;
    if (!wanted) return;
    try {
      await this.start(wanted);
    } catch (e) {
      this.log(`minimap start failed: ${e.message}`);
      this.emit("result", { status: "error", error: e.message });
    }
  }

  async start({ region, anchor, scale, mapKey }) {
    // Region is in physical px of the virtual screen; the stream is one display at physical size.
    let dip = screen.screenToDipRect(null, region);
    let display = screen.getDisplayMatching(dip);
    let origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
    let size = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    let sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    let source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source) throw new Error("no screen to capture");

    let win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, "vision", "preload.js"), backgroundThrottling: false },
    });
    this.win = win;
    win.webContents.on("console-message", (e, _level, message) => this.log(`[vision] ${message ?? e.message}`));
    win.webContents.on("render-process-gone", (_e, details) => this.log(`vision window gone: ${details.reason}`));
    await win.loadFile(path.join(__dirname, "vision", "vision.html"));
    if (this.win !== win) return;
    win.webContents.send("vision-config", {
      sourceId: source.id,
      display: size,
      region: { x: region.x - origin.x, y: region.y - origin.y, w: region.width, h: region.height },
      anchor,
      scale,
      mapKey,
      mapsUrl: pathToFileURL(MAPS_DIR).href,
      dump: !!this.dumpPath,
    });
    this.log(`minimap tracking ${JSON.stringify(region)} on display ${display.id} (${size.width}x${size.height})`);
  }

  // The screen capture died: start over with a fresh source, as switching the tracking off and on
  // does. At most every RESTART_MS, so a desktop left still does not churn windows.
  restart() {
    if (Date.now() - (this.restartedAt ?? 0) < RESTART_MS) return;
    this.restartedAt = Date.now();
    this.log("minimap capture stalled, restarting it");
    let wanted = this.wanted;
    this.key = undefined;
    this.update(wanted);
  }

  prior(prior) {
    this.win?.webContents.send("vision-prior", prior);
  }

  stop() {
    this.win?.destroy();
    this.win = undefined;
    this.key = undefined;
  }
}

// One translucent window per display; resolves with the dragged rectangle in physical px.
function pickRegion() {
  return new Promise((resolve) => {
    let windows = [];
    let finish = (rect) => {
      ipcMain.removeListener("picker-done", onDone);
      ipcMain.removeListener("picker-cancel", onCancel);
      for (let w of windows) if (!w.isDestroyed()) w.destroy();
      resolve(rect);
    };
    let onDone = (event, r) => {
      let win = BrowserWindow.fromWebContents(event.sender);
      let b = win.getBounds();
      finish(screen.dipToScreenRect(win, { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height }));
    };
    let onCancel = () => finish(undefined);
    ipcMain.on("picker-done", onDone);
    ipcMain.on("picker-cancel", onCancel);
    for (let display of screen.getAllDisplays()) {
      let w = new BrowserWindow({
        ...display.bounds,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreenable: false,
        webPreferences: { preload: path.join(__dirname, "picker-preload.js") },
      });
      w.setAlwaysOnTop(true, "screen-saver");
      w.loadFile(path.join(__dirname, "picker.html"));
      windows.push(w);
    }
  });
}

module.exports = { MinimapTracker, mapOverlayRegion, mapsAvailable, pickRegion };
