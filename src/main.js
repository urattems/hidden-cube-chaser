const { app, BrowserWindow, Menu, Tray, nativeImage, screen, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { QuestlogWorker, DEFAULT_ASAR } = require("./questlog-worker");
const { MapOverlayExport } = require("./map-overlay-export");
const { MAPS } = require("./geometry");
const { MinimapTracker, mapOverlayRegion, mapsAvailable, pickRegion } = require("./minimap");

app.setName("Hidden Cube Chaser");
if (!app.requestSingleInstanceLock()) app.exit(0);

const USER_DIR = app.getPath("userData");
const LOG_FILE = path.join(USER_DIR, "chaser.log");
const SETTINGS_FILE = path.join(USER_DIR, "settings.json");
const WORKER_DIR = path.join(USER_DIR, "worker");
const ICON = path.join(__dirname, "..", "assets", "icon.png");
const OVERLAY_SIZE = { width: 340, height: 470 };
const PUSH_INTERVAL_MS = 100;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_AGE_MS = 6 * 60 * 60 * 1000;
// Folders the worker fills with fight history we never read; Questlog's own grew to 1.8 GB.
const PURGED_DIRS = ["combat-logs", "encounters", "dummies", "drops", "pvp", "runs", "training", "nightmares"];
// A corner-map fix older than this falls back to Questlog's estimate.
const MINIMAP_FRESH_MS = 1500;
const MINIMAP_ACCURACY = 100; // cm: the reference map has about 1 px per metre

const DEFAULT_SETTINGS = {
  bounds: undefined,
  arrowMode: "movement", // "north" | "movement" (north-up while standing still)
  // Exact position read from the game's corner map. region/anchor unset = Map Overlay's ones;
  // scale (reference px per screen px) and mapKey are learnt on the first fix and kept.
  minimap: { enabled: true, region: undefined, anchor: undefined, scale: undefined, mapKey: undefined },
  chime: true,
  sonar: true,
  volume: 0.6,
  mapOverlayExport: true,
  streamable: false, // hidden from OBS/Discord/screenshots until switched on, like Map Overlay
  alwaysShow: false, // keep a small status panel up while the game runs, even with no cube
  questlogAsar: DEFAULT_ASAR,
  loginItemInitialized: false,
};

// --- logging & settings -------------------------------------------------------------------

fs.mkdirSync(USER_DIR, { recursive: true });
try {
  if (fs.statSync(LOG_FILE).size > 1 << 20) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
} catch {}
function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function loadSettings() {
  try {
    // A file saved by hand from Windows PowerShell starts with a BOM, which JSON.parse rejects.
    let text = fs.readFileSync(SETTINGS_FILE, "utf8").replace(/^﻿/, "");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(text) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
let settings = loadSettings();
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  pushState(true);
  rebuildTray();
  updateMinimap();
}

function saveMinimap(patch) {
  saveSettings({ minimap: { ...settings.minimap, ...patch } });
}

function purgeWorkerHistory() {
  let cutoff = Date.now() - PURGE_AGE_MS;
  for (let dir of PURGED_DIRS) {
    let full = path.join(WORKER_DIR, "aion-2", dir);
    let names;
    try {
      names = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (let name of names) {
      let file = path.join(full, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { recursive: true, force: true });
      } catch {} // the worker may hold the current file open
    }
  }
}

// --- live state ---------------------------------------------------------------------------

const live = {
  status: { state: "starting" },
  game: false,
  cubes: [],
  positions: undefined,
  minimap: { status: "off" }, // last vision result, and `fix` while it holds one
};
let editMode = false;
let demo;

// The corner map's exact fix while fresh, else Questlog's estimate.
function fusedSelf(estimate) {
  let fix = live.minimap.fix;
  if (fix && Date.now() - fix.at < MINIMAP_FRESH_MS)
    return { x: Math.round(fix.x), y: Math.round(fix.y), z: estimate?.z, accuracy: MINIMAP_ACCURACY, at: fix.at, source: "minimap" };
  return estimate && { ...estimate, source: "estimate" };
}

function cubeCoordinates(cube, objects) {
  let object = objects?.find((o) => o.entity === cube.entity);
  if (object) return { x: object.x, y: object.y };
  let [x, y] = String(cube.id).split(":").map(Number);
  return { x, y };
}

function snapshot() {
  if (demo) return demo.state();
  let positions = live.positions ?? {};
  let cubes = live.cubes.map((c) => ({
    key: c.id,
    entity: c.entity,
    look: c.look,
    spawned: c.spawned,
    taken: c.takenAt !== undefined,
    since: c.createdAt ?? c.seenAt,
    rise: c.rise,
    ...cubeCoordinates(c, positions.objects),
  }));
  // Questlog learns the map on a map change; the corner map knows it as soon as it is matched.
  let map = positions.map ?? Number(Object.keys(MAPS).find((id) => MAPS[id].key === live.minimap.mapKey));
  return {
    status: live.status,
    game: live.game,
    map: Number.isFinite(map) ? map : undefined,
    mapName: MAPS[map]?.name,
    self: fusedSelf(positions.self),
    minimap: live.minimap.status,
    cubes,
  };
}

let overlay;
let lastPushed = "";
let pushTimer;
function pushState(force = false) {
  if (pushTimer && !force) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    let state = { ...snapshot(), edit: editMode, demo: !!demo, settings };
    let text = JSON.stringify(state);
    if (text !== lastPushed) {
      lastPushed = text;
      overlay?.webContents.send("state", state);
    }
    updateVisibility(state);
    exportToMapOverlay(state);
  }, PUSH_INTERVAL_MS);
}

function updateVisibility(state) {
  if (!overlay) return;
  let wanted = editMode || state.demo || (state.game && (state.cubes.length > 0 || settings.alwaysShow));
  if (wanted === overlay.isVisible()) return;
  if (wanted) overlay.showInactive();
  else overlay.hide();
  let b = overlay.getBounds();
  log(`overlay ${wanted ? "shown" : "hidden"} at ${b.x},${b.y} (${state.cubes.length} cube(s))`);
}

const exporter = new MapOverlayExport(log);
function exportToMapOverlay(state) {
  if (!settings.mapOverlayExport || state.demo) return;
  let open = state.cubes.filter((c) => !c.taken && Number.isFinite(c.x));
  exporter.update(state.map, open);
}

// --- corner map -------------------------------------------------------------------------------

const minimap = new MinimapTracker(log, process.argv.find((a) => a.startsWith("--dump-minimap="))?.slice(15));
const MINIMAP_FR = {
  off: "désactivée",
  "no-region": "zone non choisie",
  "no-maps": "cartes de Map Overlay absentes",
  waiting: "en attente du jeu",
  "no-prior": "en attente de la position Questlog",
  "no-map": "carte non gérée ici",
  searching: "calibrage…",
  fix: "position exacte",
  lost: "non trouvée (cachée ?)",
  error: "erreur",
};

function minimapRegion() {
  let { region, anchor } = settings.minimap;
  if (region) return { region, anchor: anchor ?? { x: 0.5, y: 0.5 }, from: "chaser" };
  let fromOverlay = mapOverlayRegion();
  return fromOverlay && { ...fromOverlay, from: "map-overlay" };
}

function minimapStatus(status) {
  if (status === live.minimap.status) return;
  log(`minimap ${status}`);
  live.minimap.status = status;
  rebuildTray();
}

function updateMinimap() {
  let chosen = minimapRegion();
  let blocker = !settings.minimap.enabled
    ? "off"
    : !chosen
      ? "no-region"
      : !mapsAvailable()
        ? "no-maps"
        : !live.game
          ? "waiting"
          : undefined;
  if (blocker) {
    minimap.update(undefined);
    live.minimap.fix = undefined;
    minimapStatus(blocker);
    return;
  }
  // Calibrations saved by older versions could fall outside the zoom range the locator accepts.
  let scale = settings.minimap.scale >= 0.3 && settings.minimap.scale <= 1.2 ? settings.minimap.scale : undefined;
  minimap.update({ ...chosen, scale, mapKey: settings.minimap.mapKey });
}

minimap.on("result", (r) => {
  if (r.status === "fix") {
    live.minimap.fix = { x: r.x, y: r.y, at: r.at };
    live.minimap.mapKey = r.mapKey;
    if (r.scale !== settings.minimap.scale || r.mapKey !== settings.minimap.mapKey) {
      log(`minimap calibrated: scale ${r.scale.toFixed(3)} on ${r.mapKey}`);
      saveMinimap({ scale: r.scale, mapKey: r.mapKey });
    }
  } else if (r.status === "error") {
    log(`minimap error: ${r.error}`);
  }
  minimapStatus(r.status);
  pushState();
});

async function chooseMinimapRegion() {
  let region = await pickRegion();
  if (!region) return;
  log(`minimap region chosen: ${JSON.stringify(region)}`);
  saveMinimap({ region, anchor: { x: 0.5, y: 0.5 }, scale: undefined });
}

// --- demo -----------------------------------------------------------------------------------

function startDemo() {
  let started = Date.now();
  let cube = { x: 15000, y: -24000 };
  let start = { x: cube.x - 4800, y: cube.y + 3600 }; // 60 m to the south-west
  demo = {
    state: () => {
      let t = (Date.now() - started) / 1000;
      let progress = Math.min(1, t / 40);
      let self = {
        x: Math.round(start.x + (cube.x - start.x) * progress * 0.97),
        y: Math.round(start.y + (cube.y - start.y) * progress * 0.97),
        z: 5000,
        // The first half shows Questlog's estimate, the rest the corner map's exact track.
        accuracy: progress > 0.5 ? MINIMAP_ACCURACY : 1700,
        source: progress > 0.5 ? "minimap" : "estimate",
        at: Date.now(),
      };
      return {
        status: { state: "capturing" },
        game: true,
        map: 1010,
        mapName: "Verteron (démo)",
        self,
        cubes: [
          { key: "demo-1", look: "gold", spawned: true, taken: t > 44, since: started - 4000, rise: 3, ...cube },
          { key: "demo-2", look: "red", spawned: false, taken: false, since: started - 90000, rise: -1, x: cube.x + 9000, y: cube.y + 6000 },
        ],
      };
    },
  };
  let timer = setInterval(() => pushState(), 200);
  setTimeout(() => {
    clearInterval(timer);
    demo = undefined;
    pushState(true);
    rebuildTray();
  }, 50000);
  rebuildTray();
}

// --- windows & tray -------------------------------------------------------------------------

function defaultBounds() {
  let area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width / 2 - OVERLAY_SIZE.width / 2),
    y: area.y + 90,
    ...OVERLAY_SIZE,
  };
}

function createOverlay() {
  let bounds = { ...defaultBounds(), ...settings.bounds, ...OVERLAY_SIZE };
  overlay = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.setIgnoreMouseEvents(true);
  overlay.setContentProtection(!settings.streamable);
  overlay.loadFile(path.join(__dirname, "overlay.html"));
  overlay.webContents.on("did-finish-load", () => {
    lastPushed = "";
    pushState(true);
  });
  overlay.on("moved", () => saveSettings({ bounds: overlay.getBounds() }));
}

function setEditMode(on) {
  editMode = on;
  overlay.setIgnoreMouseEvents(!on);
  overlay.setFocusable(on);
  pushState(true);
  rebuildTray();
}

let tray;
const STATUS_FR = {
  starting: "Démarrage…",
  "waiting-for-game": "En attente d'Aion 2",
  capturing: "Capture active",
  replaying: "Relecture",
  "no-npcap": "Npcap n'est pas installé",
  "npcap-stopped": "Le service Npcap est arrêté",
  "npcap-admin-only": "Npcap exige l'administrateur",
  "no-questlog": "Questlog introuvable",
  "worker-restarting": "Redémarrage du décodeur…",
  error: "Erreur de capture",
  unsupported: "Non supporté",
};

function statusLine() {
  let s = live.status;
  let text = STATUS_FR[s.state] ?? s.state;
  if (s.state === "capturing") text += ` · ${live.cubes.filter((c) => c.takenAt === undefined).length} cube(s)`;
  if (s.error) text += ` · ${String(s.error).slice(0, 60)}`;
  return text;
}

function rebuildTray() {
  if (!tray) return;
  let minimapLine = `Mini-carte : ${MINIMAP_FR[live.minimap.status] ?? live.minimap.status}`;
  tray.setToolTip(`Hidden Cube Chaser\n${statusLine()}\n${minimapLine}`);
  let chosen = minimapRegion();
  let check = (label, key) => ({
    label,
    type: "checkbox",
    checked: !!settings[key],
    click: (item) => saveSettings({ [key]: item.checked }),
  });
  let radio = (label, value) => ({
    label,
    type: "radio",
    checked: settings.arrowMode === value,
    click: () => saveSettings({ arrowMode: value }),
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLine(), enabled: false },
      { label: minimapLine, enabled: false },
      { type: "separator" },
      { label: editMode ? "Verrouiller l'overlay" : "Déplacer l'overlay", click: () => setEditMode(!editMode) },
      { label: "Aperçu (démo 50 s)", enabled: !demo, click: startDemo },
      {
        label: "Recentrer l'overlay",
        click: () => {
          overlay.setBounds(defaultBounds());
          saveSettings({ bounds: overlay.getBounds() });
        },
      },
      { type: "separator" },
      { label: "Flèche", enabled: false },
      radio("Nord de la carte en haut", "north"),
      radio("Sens de déplacement (nord à l'arrêt)", "movement"),
      { type: "separator" },
      {
        label: "Lire la mini-carte (position exacte)",
        type: "checkbox",
        checked: settings.minimap.enabled,
        click: (item) => saveMinimap({ enabled: item.checked }),
      },
      {
        label: `Zone : ${chosen ? (chosen.from === "chaser" ? "choisie dans Chaser" : "celle de Map Overlay") : "aucune"}`,
        enabled: false,
      },
      { label: "Sélectionner la zone de la mini-carte…", click: chooseMinimapRegion },
      {
        label: "Reprendre la zone de Map Overlay",
        enabled: !!settings.minimap.region && !!mapOverlayRegion(),
        click: () => saveMinimap({ region: undefined, anchor: undefined, scale: undefined }),
      },
      {
        label: "Recalibrer le zoom de la mini-carte",
        click: () => {
          saveMinimap({ scale: undefined });
          minimap.update(undefined); // restart with no scale
          updateMinimap();
        },
      },
      { type: "separator" },
      check("Toujours afficher (même sans cube)", "alwaysShow"),
      check("Son à l'apparition d'un cube", "chime"),
      check("Sonar de proximité", "sonar"),
      check("Marqueur dans Map Overlay", "mapOverlayExport"),
      {
        label: "Visible en stream / enregistrement",
        type: "checkbox",
        checked: settings.streamable,
        click: (item) => {
          overlay.setContentProtection(!item.checked);
          saveSettings({ streamable: item.checked });
        },
      },
      {
        label: "Lancer avec Windows",
        type: "checkbox",
        checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
        click: (item) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }),
      },
      { type: "separator" },
      { label: "Ouvrir le journal", click: () => shell.openPath(LOG_FILE) },
      { label: "Quitter", click: () => app.quit() },
    ]),
  );
}

function loginItemOptions() {
  // Unpackaged, Windows must start electron.exe with this app's folder as its argument; the
  // portable build's exe loads its own resources\app.
  let args = app.isPackaged ? [] : [path.resolve(__dirname, "..")];
  return { name: "Hidden Cube Chaser", path: process.execPath, args };
}

// --- startup --------------------------------------------------------------------------------

let worker;
app.whenReady().then(() => {
  log(`starting, electron ${process.versions.electron}`);
  // Start with Windows like Questlog does, once; the tray menu turns it off for good.
  if (!settings.loginItemInitialized) {
    app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: true });
    saveSettings({ loginItemInitialized: true });
  }
  createOverlay();
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.on("click", () => tray.popUpContextMenu());
  rebuildTray();

  purgeWorkerHistory();
  setInterval(purgeWorkerHistory, PURGE_INTERVAL_MS);

  worker = new QuestlogWorker({ asarPath: settings.questlogAsar, dataDir: WORKER_DIR, log });
  worker.on("status", (status) => {
    live.status = status;
    rebuildTray();
    pushState();
  });
  worker.on("game", (running) => {
    live.game = running;
    log(`game ${running ? "running" : "closed"}`);
    updateMinimap();
    pushState();
  });
  worker.on("data", (procedurePath, data) => {
    if (procedurePath === "capture.status") {
      if (data.state !== live.status.state) log(`capture ${data.state}${data.error ? ` ${data.error}` : ""}`);
      live.status = data;
      rebuildTray();
    } else if (procedurePath === "hiddenCubes") {
      let before = new Set(live.cubes.map((c) => c.id));
      for (let c of data) if (!before.has(c.id)) log(`cube ${c.look} ${c.id} spawned=${c.spawned}`);
      live.cubes = data;
      rebuildTray();
    } else if (procedurePath === "map.positions") {
      if (data.map !== live.positions?.map) log(`map ${data.map}`);
      live.positions = data;
      let self = data.self;
      if (self) minimap.prior({ x: self.x, y: self.y, accuracy: self.accuracy, map: data.map });
    }
    pushState();
  });
  for (let p of ["capture.status", "hiddenCubes", "map.positions"]) worker.subscribe(p);
  worker.start();

  if (process.argv.includes("--demo")) startDemo();
  // Diagnostics: --snapshot=<file.png> [--snapshot-after=<s>] saves the overlay as rendered, then quits.
  let snapshot = process.argv.find((a) => a.startsWith("--snapshot="))?.slice(11);
  if (snapshot) {
    let after = Number(process.argv.find((a) => a.startsWith("--snapshot-after="))?.slice(17) ?? 8);
    setTimeout(async () => {
      fs.writeFileSync(snapshot, (await overlay.webContents.capturePage()).toPNG());
      app.quit();
    }, after * 1000);
  }
});

app.on("second-instance", () => tray?.popUpContextMenu());
app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => {
  worker?.stop();
  minimap.stop();
});
