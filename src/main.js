const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, screen, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { QuestlogWorker, DEFAULT_ASAR } = require("./questlog-worker");
const { MapOverlayExport } = require("./map-overlay-export");
const { MAPS } = require("./geometry");
const { MinimapTracker, mapOverlayRegion, mapsAvailable, pickRegion } = require("./minimap");
const { Updater } = require("./updater");
const { locateCube, groupSpots } = require("./cube-spots");
const { SCALE_MIN, SCALE_MAX } = require("./vision/locator");

app.setName("Hidden Cube Chaser");
app.setAppUserModelId("Hidden Cube Chaser"); // Windows shows no notifications for an app without one
if (!app.requestSingleInstanceLock()) app.exit(0);

const USER_DIR = app.getPath("userData");
const LOG_FILE = path.join(USER_DIR, "chaser.log");
const SETTINGS_FILE = path.join(USER_DIR, "settings.json");
const WORKER_DIR = path.join(USER_DIR, "worker");
const ICON = path.join(__dirname, "..", "assets", "icon.png");
const OVERLAY_SIZE = { width: 340, height: 540 };
const PUSH_INTERVAL_MS = 100;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_AGE_MS = 6 * 60 * 60 * 1000;
// The game, when it gets the focus back, can end up above our topmost window; put it back on top
// this often while it shows. It cannot take the focus (focusable: false), so the game keeps it.
const RAISE_INTERVAL_MS = 2000;
const UPDATE_FIRST_CHECK_MS = 15 * 1000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Folders the worker fills with fight history we never read; Questlog's own grew to 1.8 GB.
const PURGED_DIRS = ["combat-logs", "encounters", "dummies", "drops", "pvp", "runs", "training", "nightmares"];
// A corner-map fix older than this falls back to Questlog's estimate.
const MINIMAP_FRESH_MS = 1500;
const MINIMAP_ACCURACY = 100; // cm: the reference map has about 1 px per metre

const DEFAULT_SETTINGS = {
  bounds: undefined,
  compass: false, // the dial arrow: the corner-map markers guide better than a movement heading
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
  respawnSpots: false, // once a cube is opened, mark the spots of its group it may come back on
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

// Cubes keep the number they got when first seen ("Cube 1", "Cube 2") until none is left.
let cubeNumbers = new Map();
function cubeNumber(cube) {
  if (!cubeNumbers.has(cube.id)) cubeNumbers.set(cube.id, Math.max(0, ...cubeNumbers.values()) + 1);
  return cubeNumbers.get(cube.id);
}

function cubeCoordinates(cube, objects) {
  let object = objects?.find((o) => o.entity === cube.entity);
  if (object) return { x: object.x, y: object.y };
  let [x, y] = String(cube.id).split(":").map(Number);
  return { x, y };
}

// --- where an opened cube comes back ----------------------------------------------------------
// A cube that is opened respawns on one of the spots of its group, sometimes within seconds.
// Spots we pass close to with no cube announced are empty for now; the respawn can come later, so
// that only holds for a while.
const RESPAWN_SHOW_MS = 30 * 60 * 1000;
const CHECK_RADIUS_CM = 3000; // well inside the ~40 m the server announces cubes within
const CHECKED_FOR_MS = 5 * 60 * 1000;

let spotOf = new Map(); // cube id -> its spot, or null when on none
let respawns = new Map(); // group -> { map, group, label, opened, since, known: Set of cube ids, checked: Map index -> at }

function cubeSpot(id, map) {
  if (!spotOf.has(id)) {
    let [x, y] = String(id).split(":").map(Number);
    spotOf.set(id, locateCube(x, y, map) ?? null);
  }
  return spotOf.get(id);
}

function trackRespawns(map, self) {
  let now = Date.now();
  for (let cube of live.cubes) {
    let spot = cubeSpot(cube.id, map);
    if (!spot) continue;
    let pending = respawns.get(spot.group);
    if (cube.takenAt !== undefined && !pending) {
      log(`cube opened on ${spot.group} #${spot.index + 1}/${spot.count}`);
      respawns.set(spot.group, {
        map: spot.map,
        group: spot.group,
        label: spot.label,
        opened: spot.index,
        since: now,
        known: new Set(live.cubes.map((c) => c.id)),
        checked: new Map(),
      });
    } else if (cube.takenAt === undefined && pending && !pending.known.has(cube.id)) {
      log(`cube back on ${spot.group} #${spot.index + 1} after ${Math.round((now - pending.since) / 1000)} s`);
      respawns.delete(spot.group);
    }
  }
  for (let [group, r] of respawns) {
    if (now - r.since > RESPAWN_SHOW_MS || (map !== undefined && r.map !== map)) {
      respawns.delete(group);
      continue;
    }
    for (let [i, at] of r.checked) if (now - at > CHECKED_FOR_MS) r.checked.delete(i);
    if (self?.source !== "minimap") continue; // the estimate is too loose to clear a spot
    let occupied = new Set(
      live.cubes
        .filter((c) => c.takenAt === undefined)
        .map((c) => cubeSpot(c.id, map))
        .filter((s) => s?.group === group)
        .map((s) => s.index),
    );
    groupSpots(r.map, group).forEach(([x, y], i) => {
      if (!occupied.has(i) && Math.hypot(x - self.x, y - self.y) <= CHECK_RADIUS_CM) r.checked.set(i, now);
    });
  }
}

// The candidate spots to show, and one line per group for the overlay.
function respawnState() {
  if (!settings.respawnSpots) return { spots: [], respawns: [] };
  let spots = [];
  let summary = [];
  for (let r of respawns.values()) {
    let all = groupSpots(r.map, r.group);
    all.forEach(([x, y, z], i) => spots.push({ key: `${r.group}#${i}`, x, y, z, checked: r.checked.has(i) }));
    summary.push({ label: r.label, total: all.length, left: all.length - r.checked.size, since: r.since });
  }
  return { spots, respawns: summary };
}

function snapshot() {
  if (demo) return demo.state();
  let positions = live.positions ?? {};
  // Questlog learns the map on a map change; the corner map knows it as soon as it is matched.
  let map = positions.map ?? Number(Object.keys(MAPS).find((id) => MAPS[id].key === live.minimap.mapKey));
  map = Number.isFinite(map) ? map : undefined;
  let self = fusedSelf(positions.self);
  trackRespawns(map, self);
  if (live.cubes.length === 0) cubeNumbers.clear();
  let byAge = [...live.cubes].sort((a, b) => (a.createdAt ?? a.seenAt) - (b.createdAt ?? b.seenAt));
  for (let c of byAge) cubeNumber(c);
  let cubes = live.cubes.map((c) => {
    let spot = cubeSpot(c.id, map);
    return {
      key: c.id,
      n: cubeNumber(c),
      entity: c.entity,
      look: c.look,
      spawned: c.spawned,
      taken: c.takenAt !== undefined,
      since: c.createdAt ?? c.seenAt,
      rise: c.rise,
      spot: spot ? { label: spot.label, n: spot.index + 1, of: spot.count } : undefined,
      ...cubeCoordinates(c, positions.objects),
    };
  });
  return {
    status: live.status,
    game: live.game,
    map,
    mapName: MAPS[map]?.name,
    self,
    minimap: live.minimap.status,
    cubes,
    ...respawnState(),
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
    let markerList = updateMarkers(state);
    state.markersShown = !!markerList?.length;
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
  let wanted =
    editMode || state.demo || (state.game && (state.cubes.length > 0 || state.respawns?.length > 0 || settings.alwaysShow));
  if (wanted === overlay.isVisible()) return;
  if (wanted) overlay.showInactive();
  else overlay.hide();
  let b = overlay.getBounds();
  log(`overlay ${wanted ? "shown" : "hidden"} at ${b.x},${b.y} (${state.cubes.length} cube(s))`);
}

// --- cubes drawn on the game's corner map -----------------------------------------------------

const REF_PX_PER_CM = 8192 / 8160 / 100; // reference map px per world cm
let markersWin;

function createMarkersWindow() {
  markersWin = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "markers-preload.js"), backgroundThrottling: false },
  });
  markersWin.setAlwaysOnTop(true, "screen-saver");
  markersWin.setIgnoreMouseEvents(true);
  // Always out of screen captures: the vision window captures this very region, and markers in
  // it would be matched against the map.
  markersWin.setContentProtection(true);
  markersWin.loadFile(path.join(__dirname, "markers.html"));
}

// Where each cube sits on the corner map, from the latest exact fix: the fix is the world point
// under the anchor pixel, and the calibrated zoom turns metres into screen pixels.
function updateMarkers(state) {
  if (!markersWin) return undefined;
  let fix = live.minimap.fix;
  let chosen = minimapRegion();
  let usable =
    !state.demo && state.game && chosen && live.minimap.scale && fix && Date.now() - fix.at < MINIMAP_FRESH_MS;
  let list = [];
  if (usable) {
    let dip = screen.screenToDipRect(null, chosen.region);
    let scaleFactor = screen.getDisplayMatching(dip).scaleFactor;
    let bounds = markersWin.getBounds();
    if (bounds.x !== dip.x || bounds.y !== dip.y || bounds.width !== dip.width || bounds.height !== dip.height)
      markersWin.setBounds(dip);
    let k = REF_PX_PER_CM / live.minimap.scale / scaleFactor; // CSS px per world cm
    let ax = chosen.anchor.x * dip.width;
    let ay = chosen.anchor.y * dip.height;
    let place = (p) => ({
      x: ax + (p.x - fix.x) * k,
      y: ay + (p.y - fix.y) * k,
      distance: Math.hypot(p.x - fix.x, p.y - fix.y) / 100,
    });
    // Candidate spots first, so the cubes are drawn over them.
    let spots = (state.spots ?? []).map((s) => ({ key: s.key, kind: "spot", checked: s.checked, ...place(s) }));
    let nearest = spots.filter((s) => !s.checked).sort((a, b) => a.distance - b.distance)[0];
    if (nearest) nearest.nearest = true;
    list = spots.concat(
      state.cubes
        .filter((c) => Number.isFinite(c.x))
        .map((c) => ({ key: c.key, kind: "cube", n: c.n, look: c.look, taken: c.taken, ...place(c) })),
    );
  }
  markersWin.webContents.send("markers", list);
  if (list.length && !markersWin.isVisible()) markersWin.showInactive();
  if (!list.length && markersWin.isVisible()) markersWin.hide();
  return list;
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
  let scale = settings.minimap.scale >= SCALE_MIN && settings.minimap.scale <= SCALE_MAX ? settings.minimap.scale : undefined;
  minimap.update({ ...chosen, scale, mapKey: settings.minimap.mapKey });
}

minimap.on("result", (r) => {
  if (r.status === "fix") {
    live.minimap.fix = { x: r.x, y: r.y, at: r.at };
    live.minimap.mapKey = r.mapKey;
    live.minimap.scale = r.scale;
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
  // The zoom stays: it does not depend on the region, and a wrong one recalibrates after a few misses.
  saveMinimap({ region, anchor: { x: 0.5, y: 0.5 } });
}

// --- updates --------------------------------------------------------------------------------

const updater = new Updater(log);
let notifiedVersion;
updater.on("change", (state) => {
  rebuildTray();
  if (state.status !== "available" || notifiedVersion === state.latest || !Notification.isSupported()) return;
  notifiedVersion = state.latest;
  let note = new Notification({
    title: `Hidden Cube Chaser ${state.latest} est disponible`,
    body: "Clique ici pour mettre à jour (Chaser redémarre tout seul).",
    icon: ICON,
  });
  note.on("click", () => updater.install());
  note.show();
});

function updateMenuItem() {
  let s = updater.state;
  switch (s.status) {
    case "available":
      return { label: `⬆ Installer la mise à jour ${s.latest}`, click: () => updater.install() };
    case "downloading":
      return { label: `Mise à jour ${s.latest} : téléchargement…`, enabled: false };
    case "checking":
      return { label: "Recherche de mise à jour…", enabled: false };
    case "auth":
      return { label: "Mises à jour : connexion GitHub requise (gh auth login)", click: () => updater.check() };
    case "error":
      return { label: "Mise à jour : échec, réessayer", click: () => (s.asset ? updater.install() : updater.check()) };
    case "dev":
      return { label: "Version de développement (mise à jour par git pull)", enabled: false };
    default:
      return { label: `Vérifier les mises à jour${s.status === "up-to-date" ? " (à jour)" : ""}`, click: () => updater.check() };
  }
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
          { key: "demo-1", n: 1, look: "gold", spawned: true, taken: t > 44, since: started - 4000, rise: 3, ...cube },
          { key: "demo-2", n: 2, look: "red", spawned: false, taken: false, since: started - 90000, rise: -1, x: cube.x + 2200, y: cube.y + 1500 },
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
  setInterval(() => {
    for (let win of [overlay, markersWin]) {
      if (!win?.isVisible()) continue;
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop();
    }
  }, RAISE_INTERVAL_MS);
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
  let available = updater.state.status === "available" ? `\n⬆ Mise à jour ${updater.state.latest} disponible` : "";
  tray.setToolTip(`Hidden Cube Chaser ${app.getVersion()}\n${statusLine()}\n${minimapLine}${available}`);
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
    enabled: settings.compass,
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
      check("Boussole (flèche de direction)", "compass"),
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
        click: () => saveMinimap({ region: undefined, anchor: undefined }),
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
      check("Montrer où un cube ouvert peut réapparaître", "respawnSpots"),
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
      { label: `Hidden Cube Chaser ${app.getVersion()}`, enabled: false },
      updateMenuItem(),
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
  createMarkersWindow();
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.on("click", () => tray.popUpContextMenu());
  rebuildTray();

  purgeWorkerHistory();
  setInterval(purgeWorkerHistory, PURGE_INTERVAL_MS);

  updater.cleanup();
  setTimeout(() => updater.check(), UPDATE_FIRST_CHECK_MS);
  setInterval(() => updater.check(), UPDATE_INTERVAL_MS);
  // Diagnostics: --update-now installs a newer release as soon as the first check finds one.
  if (process.argv.includes("--update-now"))
    updater.on("change", (s) => s.status === "available" && updater.install());

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
