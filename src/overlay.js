const $ = (id) => document.getElementById(id);
const LOOK_FR = { gold: "or", red: "rouge" };

let state;
let seen = new Set();
let freshUntil = 0;

window.chaser.onState((next) => {
  let previous = state;
  state = next;
  announceNewCubes(previous);
  render();
});

setInterval(() => state && render(), 250);

// --- helpers ------------------------------------------------------------------------------

function metres(units) {
  return units / 100;
}

function distanceTo(point) {
  let self = state.self;
  return self ? metres(Math.hypot(point.x - self.x, point.y - self.y)) : undefined;
}

// Open cubes first, the nearest on top; the sonar follows the first one.
function sortedCubes() {
  let cubes = (state.cubes ?? []).filter((c) => Number.isFinite(c.x));
  let rank = (c) => (c.taken ? Infinity : (distanceTo(c) ?? 0));
  return cubes.sort((a, b) => rank(a) - rank(b));
}

// --- rendering ------------------------------------------------------------------------------

const CAPTURE_PROBLEM = {
  "no-npcap": "Npcap n'est pas installé",
  "npcap-stopped": "Le service Npcap est arrêté",
  "npcap-admin-only": "Npcap exige l'administrateur",
  "no-questlog": "Questlog introuvable",
  "worker-restarting": "Redémarrage du décodeur…",
  error: "Erreur de capture",
};

const MAP_STATUS = {
  searching: ["wait", "Carte : recherche…"],
  lost: ["bad", "Carte non lue (fermée ou cachée ?)"],
  "no-map": ["bad", "Carte non lue (cachée ou zone sombre ?)"],
  "no-prior": ["wait", "Carte : lance un buff pour démarrer"],
  "no-region": ["bad", "Carte : choisis sa zone dans le menu"],
  "no-maps": ["bad", "Carte : tuiles de Map Overlay absentes"],
  waiting: ["wait", "En attente d'Aion 2"],
  off: ["off", "Lecture de la carte désactivée"],
  error: ["bad", "Carte : erreur de lecture"],
};

// Green holds exactly while the markers can be drawn: the position comes from a fresh corner-map fix.
function mapStatus() {
  if (state.edit && !state.game) return ["off", "Place-moi où tu veux"];
  let problem = CAPTURE_PROBLEM[state.status?.state];
  if (problem) return ["bad", problem];
  if (state.self?.source === "minimap") return ["good", "Carte OK"];
  return MAP_STATUS[state.minimap] ?? ["wait", "Carte : recherche…"];
}

function cubeLine(cube) {
  let name = `Cube ${cube.n ?? ""} ${LOOK_FR[cube.look] ?? ""}`.trim();
  if (cube.taken) return `${name} · ouvert`;
  let distance = distanceTo(cube);
  if (distance === undefined) return name;
  let approximate = state.self.source !== "minimap";
  return `${name} · ${approximate ? "≈" : ""}${Math.round(distance)} m${describeRise(cube.rise)}`;
}

function describeRise(rise) {
  if (rise === undefined || Math.abs(rise) < 2) return "";
  return rise > 0 ? ` · ▲ ${rise} m` : ` · ▼ ${-rise} m`;
}

function render() {
  document.body.classList.toggle("edit", !!state.edit);
  let [level, text] = mapStatus();
  $("card").className = `card ${level}${Date.now() < freshUntil ? " fresh" : ""}`;
  $("status").textContent = text;

  let cubes = sortedCubes();
  let lines = cubes.map((c) => ({ text: cubeLine(c), look: c.look, taken: c.taken }));
  for (let r of state.respawns ?? []) lines.push({ text: `Réapparition · ${r.label} · ${r.left}/${r.total}`, look: "respawn" });
  $("cubes").replaceChildren(
    ...lines.map((line) => {
      let el = document.createElement("div");
      el.className = `cube ${line.look ?? ""}${line.taken ? " taken" : ""}`;
      el.textContent = line.text;
      return el;
    }),
  );

  let focus = cubes[0];
  updateSonar(focus && !focus.taken ? (distanceTo(focus) ?? SONAR.maxM) : undefined);
}

// --- sound --------------------------------------------------------------------------------

let audio;
function tone(freq, start, length, gain, type = "sine") {
  audio ??= new AudioContext();
  let t = Math.max(audio.currentTime, start);
  let osc = audio.createOscillator();
  let amp = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain * state.settings.volume, t + 0.005);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(amp).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length + 0.05);
}

function announceNewCubes(previous) {
  let fresh = (state.cubes ?? []).filter((c) => !c.taken && !seen.has(c.key));
  for (let c of state.cubes ?? []) seen.add(c.key);
  if (!previous || fresh.length === 0) return;
  freshUntil = Date.now() + 1800;
  if (state.settings.chime) {
    audio ??= new AudioContext();
    let now = audio.currentTime;
    tone(784, now, 0.35, 0.35);
    tone(1175, now + 0.12, 0.45, 0.35);
    tone(1568, now + 0.24, 0.6, 0.3);
  }
}

// Tempo, pitch and loudness all rise smoothly from maxM to the cube, with no jump on arrival. The
// curve gives the last metres more of the range, as that is where the map's exact position is
// worth hearing. An announced cube is in range whatever the estimate says, so past maxM the sonar
// keeps its slowest beat. The exact track is followed at once; the estimate wanders by metres, so it
// is smoothed.
const SONAR = {
  maxM: 60,
  curve: 0.7,
  slowMs: 1200,
  fastMs: 120,
  lowHz: 520,
  highHz: 2080,
  farGain: 0.3,
  nearGain: 0.6,
  farLength: 0.13,
  nearLength: 0.07,
  smoothExactMs: 150,
  smoothEstimateMs: 900,
  tickMs: 30,
  aheadS: 0.09,
};

let sonarTimer;
let sonarDistance; // smoothed
let sonarAt;
let lastBeat; // audio-clock time of the last beat

function updateSonar(distance) {
  if (!state?.settings.sonar || distance === undefined) {
    clearInterval(sonarTimer);
    sonarTimer = undefined;
    sonarDistance = undefined;
    lastBeat = undefined;
    return;
  }
  let now = Date.now();
  let smoothMs = state.self?.source === "minimap" ? SONAR.smoothExactMs : SONAR.smoothEstimateMs;
  if (sonarDistance === undefined) sonarDistance = distance;
  else sonarDistance += (distance - sonarDistance) * (1 - Math.exp(-(now - sonarAt) / smoothMs));
  sonarAt = now;
  sonarTimer ??= setInterval(sonarTick, SONAR.tickMs);
}

// Beats sit on the audio clock, placed a little ahead, so a busy PC does not shake the rhythm. The
// next beat is worked out again on each tick: running towards the cube shortens the wait right away.
function sonarTick() {
  audio ??= new AudioContext();
  if (audio.state === "suspended") audio.resume();
  let closeness = 1 - Math.min(1, sonarDistance / SONAR.maxM) ** SONAR.curve;
  let between = (far, near) => far * (near / far) ** closeness;
  let linear = (far, near) => far + (near - far) * closeness;
  let now = audio.currentTime;
  let next = lastBeat === undefined ? now : lastBeat + between(SONAR.slowMs, SONAR.fastMs) / 1000;
  if (next > now + SONAR.aheadS) return;
  lastBeat = Math.max(next, now);
  tone(between(SONAR.lowHz, SONAR.highHz), lastBeat, linear(SONAR.farLength, SONAR.nearLength), linear(SONAR.farGain, SONAR.nearGain), "triangle");
}
