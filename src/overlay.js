const { bearingNorthUp, wrap180, compassPoint } = window.Geometry;

const $ = (id) => document.getElementById(id);
const LOOK_FR = { gold: "OR", red: "ROUGE" };
const NEAR_M = 6;
const HEADING_WINDOW_MS = 2500;
const HEADING_MIN_MOVE = 600; // 6 m in world units
const SONAR_MAX_M = 80;

let state;
let history = []; // recent self positions, for the movement heading
let arrowAngle = 0; // unwrapped, so the CSS transition never spins the long way round
let seen = new Set();
let freshUntil = 0;

window.chaser.onState((next) => {
  let previous = state;
  state = next;
  trackHistory();
  announceNewCubes(previous);
  render();
});

setInterval(() => state && render(), 250);

// --- helpers ------------------------------------------------------------------------------

function metres(units) {
  return units / 100;
}

function trackHistory() {
  let self = state.self;
  if (!self) return;
  let last = history.at(-1);
  if (!last || last.x !== self.x || last.y !== self.y) history.push({ x: self.x, y: self.y, t: Date.now() });
  let cutoff = Date.now() - HEADING_WINDOW_MS * 2;
  history = history.filter((p) => p.t >= cutoff);
}

// Bearing of travel over the last couple of seconds, or undefined when standing still.
function movementHeading() {
  let now = history.at(-1);
  if (!now) return undefined;
  let from = history.find((p) => now.t - p.t <= HEADING_WINDOW_MS);
  if (!from || Math.hypot(now.x - from.x, now.y - from.y) < HEADING_MIN_MOVE) return undefined;
  return bearingNorthUp(from, now);
}

function target() {
  let cubes = state.cubes ?? [];
  let self = state.self;
  let open = cubes.filter((c) => !c.taken && Number.isFinite(c.x));
  let byDistance = (a, b) => (self ? Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y) : 0);
  return open.sort(byDistance)[0] ?? cubes.findLast((c) => c.taken);
}

function formatAge(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// --- rendering ------------------------------------------------------------------------------

function render() {
  document.body.classList.toggle("edit", !!state.edit);
  let cube = target();
  let card = $("card");
  let radar = $("radar-wrap");
  let idle = !cube && (state.edit || state.settings.alwaysShow);
  card.classList.toggle("idle", idle);
  if (!cube) {
    card.classList.toggle("hidden", !idle);
    radar.classList.add("hidden");
    if (idle) renderPlaceholder();
    updateSonar(undefined);
    return;
  }
  card.classList.remove("hidden");
  radar.classList.remove("hidden");

  let self = state.self;
  let distance = self ? metres(Math.hypot(cube.x - self.x, cube.y - self.y)) : undefined;
  let accuracy = self?.accuracy !== undefined ? metres(self.accuracy) : 0;
  let bearing = self ? bearingNorthUp(self, cube) : undefined;
  let heading = state.settings.arrowMode === "movement" ? movementHeading() : undefined;
  let relative = bearing === undefined ? undefined : heading === undefined ? bearing : wrap180(bearing - heading);
  let near = distance !== undefined && !cube.taken && distance <= Math.max(NEAR_M, accuracy);

  document.body.classList.toggle("red", cube.look === "red");
  document.body.classList.toggle("near", near);
  card.classList.toggle("taken", cube.taken);
  card.classList.toggle("fresh", Date.now() < freshUntil);

  $("title").textContent = `Cube caché · ${LOOK_FR[cube.look] ?? ""}`;
  $("badge").textContent = cube.taken ? "Ouvert par quelqu'un" : cube.spawned ? "Vient d'apparaître" : "Déjà là";
  $("age").textContent = cube.since ? formatAge(Date.now() - cube.since) : "";

  if (relative !== undefined) {
    arrowAngle += wrap180(relative - arrowAngle);
    $("arrow").style.transform = `rotate(${arrowAngle}deg)`;
  }
  $("cone").setAttribute("d", distance === undefined || cube.taken ? "" : conePath(distance, accuracy));
  $("dial-label").textContent = heading === undefined ? "N" : "▲";

  if (distance === undefined) {
    $("distance").textContent = "?";
    $("accuracy").textContent = "position inconnue";
  } else {
    let shown = distance < 10 ? distance.toFixed(0) : Math.round(distance);
    $("distance").innerHTML = `${accuracy >= 5 ? "≈" : ""}${shown}<small> m</small>`;
    $("accuracy").textContent = accuracy >= 5 ? `± ${Math.round(accuracy)} m (position estimée)` : "position précise";
  }
  $("direction").textContent =
    bearing === undefined
      ? ""
      : heading === undefined
        ? `Vers le ${compassPoint(bearing)} (nord en haut)`
        : describeRelative(relative);
  $("rise").textContent = describeRise(cube.rise);
  $("hint").textContent = hint(cube, distance, accuracy, near);
  $("coords").textContent = `${state.mapName ?? `Carte ${state.map ?? "?"}`} · X ${Math.round(cube.x / 100)}  Y ${Math.round(cube.y / 100)}`;

  drawRadar(cube, heading, accuracy);
  let others = (state.cubes ?? []).filter((c) => c !== cube && !c.taken).length;
  $("others").textContent = others ? `+ ${others} autre${others > 1 ? "s" : ""} cube${others > 1 ? "s" : ""} sur le radar` : "";
  updateSonar(cube.taken ? undefined : distance);
}

// The directions the cube can really be in, given how far off our own position may be: a thin
// beam right after a buff fixes the position, a wide fan while it is only estimated.
const CONE_MIN_DEG = 4;
const CONE_MAX_DEG = 90;
const CONE_RADIUS = 52;

function conePath(distance, accuracy) {
  let half = distance > 0 ? (Math.atan2(accuracy, distance) * 180) / Math.PI : CONE_MAX_DEG;
  half = (Math.min(CONE_MAX_DEG, Math.max(CONE_MIN_DEG, half)) * Math.PI) / 180;
  let x = (CONE_RADIUS * Math.sin(half)).toFixed(1);
  let y = (-CONE_RADIUS * Math.cos(half)).toFixed(1);
  return `M0,0 L-${x},${y} A${CONE_RADIUS},${CONE_RADIUS} 0 0 1 ${x},${y} Z`;
}

function describeRelative(angle) {
  let a = Math.abs(angle);
  if (a < 20) return "Droit devant";
  if (a > 160) return "Derrière toi";
  let side = angle > 0 ? "à droite" : "à gauche";
  return a < 70 ? `Devant, ${side}` : a < 110 ? `Sur ta ${side.slice(2)}` : `Derrière, ${side}`;
}

function describeRise(rise) {
  if (rise === undefined || Math.abs(rise) < 2) return "";
  return rise > 0 ? `▲ ${rise} m plus haut` : `▼ ${-rise} m plus bas`;
}

function hint(cube, distance, accuracy, near) {
  if (cube.taken) return "Quelqu'un l'a ouvert.";
  if (near) return "Tu y es ! Regarde autour de toi (ouvre la carte M : marqueur exact via Map Overlay).";
  if (accuracy >= 15) return "Position approximative : lance un buff ou une compétence pour la recaler.";
  if (distance !== undefined && distance < 25) return "Tout proche. Le marqueur exact est sur la carte (Map Overlay).";
  return "";
}

const IDLE_STATUS = {
  capturing: "Aucun cube à portée",
  "waiting-for-game": "En attente d'Aion 2",
  starting: "Démarrage…",
  "worker-restarting": "Redémarrage du décodeur…",
  "no-npcap": "Npcap n'est pas installé",
  "no-questlog": "Questlog introuvable",
  error: "Erreur de capture",
};

function renderPlaceholder() {
  document.body.classList.remove("red", "near");
  $("card").classList.remove("taken", "fresh");
  let status = state.status?.state;
  $("title").textContent = "Hidden Cube Chaser";
  $("badge").textContent = IDLE_STATUS[status] ?? status ?? "";
  $("age").textContent = "";
  $("hint").textContent = state.edit ? "Place-moi où tu veux voir les cubes." : "";
}

// --- radar ------------------------------------------------------------------------------------

function niceRange(m) {
  for (let r of [20, 30, 50, 80, 120, 200, 300, 500]) if (m <= r) return r;
  return 800;
}

function drawRadar(focus, heading, accuracy) {
  let canvas = $("radar");
  let ctx = canvas.getContext("2d");
  let size = canvas.width;
  let c = size / 2;
  let radius = c - 14;
  let self = state.self;
  let css = getComputedStyle(document.body);
  let accent = css.getPropertyValue("--accent").trim();
  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = "rgba(14,16,22,0.72)";
  ctx.beginPath();
  ctx.arc(c, c, radius + 10, 0, Math.PI * 2);
  ctx.fill();

  // The scale follows the focused cube; farther ones are pinned to the rim with their distance.
  let cubes = (state.cubes ?? []).filter((cube) => Number.isFinite(cube.x));
  let focusDistance = self ? metres(Math.hypot(focus.x - self.x, focus.y - self.y)) : 0;
  let range = niceRange(Math.max(focusDistance * 1.3, 15));
  let scale = radius / range;
  let rotation = heading === undefined ? 0 : -heading;

  ctx.strokeStyle = "rgba(255,255,255,0.13)";
  ctx.lineWidth = 2;
  for (let f of [0.5, 1]) {
    ctx.beginPath();
    ctx.arc(c, c, radius * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Ring labels on the lower-right diagonal, clear of the north tick.
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "600 18px Segoe UI";
  ctx.textAlign = "center";
  for (let f of [0.5, 1]) {
    let at = radius * f * Math.SQRT1_2;
    ctx.fillText(f === 1 ? `${range} m` : `${range / 2}`, c + at - 14, c + at - 6);
  }

  // North tick, turning with the radar when it follows the movement heading.
  let n = ((rotation - 90) * Math.PI) / 180;
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "700 22px Segoe UI";
  ctx.fillText("N", c + Math.cos(n) * (radius - 2), c + Math.sin(n) * (radius - 2) + 8);

  if (self && accuracy >= 2) {
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath();
    ctx.arc(c, c, Math.min(radius, accuracy * scale), 0, Math.PI * 2);
    ctx.fill();
  }

  if (self) {
    for (let cube of cubes) {
      let d = Math.hypot(cube.x - self.x, cube.y - self.y) / 100;
      let a = ((bearingNorthUp(self, cube) + rotation - 90) * Math.PI) / 180;
      let r = Math.min(radius, d * scale);
      let x = c + Math.cos(a) * r;
      let y = c + Math.sin(a) * r;
      let colour = cube.taken ? "#6b7280" : cube.look === "red" ? "#ff5252" : "#f5b91a";
      if (cube === focus && !cube.taken) {
        ctx.strokeStyle = accent;
        ctx.setLineDash([6, 8]);
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.shadowColor = colour;
      ctx.shadowBlur = cube === focus ? 18 : 6;
      ctx.fillStyle = colour;
      let s = cube === focus ? 15 : 10;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
      if (d * scale > radius) {
        ctx.fillStyle = colour;
        ctx.font = "600 18px Segoe UI";
        ctx.fillText(`${Math.round(d)} m`, c + Math.cos(a) * (radius - 26), c + Math.sin(a) * (radius - 26) + 6);
      }
    }
  }

  // The player: a triangle pointing along the heading, or a dot when the radar is north-up.
  ctx.fillStyle = "#f1f2f6";
  ctx.beginPath();
  if (heading === undefined) ctx.arc(c, c, 7, 0, Math.PI * 2);
  else {
    ctx.moveTo(c, c - 13);
    ctx.lineTo(c + 9, c + 9);
    ctx.lineTo(c - 9, c + 9);
  }
  ctx.fill();
}

// --- sound --------------------------------------------------------------------------------

let audio;
function tone(freq, start, length, gain) {
  audio ??= new AudioContext();
  let t = audio.currentTime + start;
  let osc = audio.createOscillator();
  let amp = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain * state.settings.volume, t + 0.01);
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
    tone(784, 0, 0.35, 0.35);
    tone(1175, 0.12, 0.45, 0.35);
    tone(1568, 0.24, 0.6, 0.3);
  }
}

let sonarTimer;
let sonarDistance;
function updateSonar(distance) {
  sonarDistance = state?.settings.sonar && distance !== undefined && distance <= SONAR_MAX_M ? distance : undefined;
  if (sonarDistance !== undefined && !sonarTimer) sonarTick();
}

function sonarTick() {
  sonarTimer = undefined;
  if (sonarDistance === undefined) return;
  let close = sonarDistance <= NEAR_M;
  tone(close ? 1480 : 1046, 0, 0.09, close ? 0.22 : 0.14);
  let interval = close ? 180 : 180 + (Math.min(sonarDistance, SONAR_MAX_M) / SONAR_MAX_M) * 1400;
  sonarTimer = setTimeout(sonarTick, interval);
}
