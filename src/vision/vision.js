// Hidden window: grabs the corner map from the screen a few times a second and reports the
// player's exact position. Test mode replays saved frames instead of the screen.
const { MinimapLocator } = window.MinimapLocatorLib;

const FRAME_INTERVAL_MS = 250;
const TILE = 256;
const TILE_CACHE = 400;

let config;
let prior;
let locator;
let busy = false;
let timer;
let video = document.getElementById("video");
let canvas = new OffscreenCanvas(1, 1);
let ctx = canvas.getContext("2d", { willReadFrequently: true });

// --- reference tiles ---------------------------------------------------------------------

let tiles = new Map();

// The sea around the zone, which the corner map leaves see-through (the scenery shows there): pale
// and almost grey on the reference, unlike sand, grass, rock or inland water. Decided per 8 px
// block, so a grey stone inside the zone stays land. Null for a tile with no sea.
const SEA_BLOCK = 8;
function landMask(rgba) {
  let land;
  for (let by = 0; by < TILE; by += SEA_BLOCK)
    for (let bx = 0; bx < TILE; bx += SEA_BLOCK) {
      let sea = 0;
      for (let y = by; y < by + SEA_BLOCK; y++)
        for (let x = bx; x < bx + SEA_BLOCK; x++) {
          let i = (y * TILE + x) * 4;
          let r = rgba[i];
          let g = rgba[i + 1];
          let max = Math.max(r, g, rgba[i + 2]);
          let min = Math.min(r, g, rgba[i + 2]);
          if (max > 140 && (max - min) * 255 < 32 * max && g >= r - 4) sea++;
        }
      if (sea < 0.75 * SEA_BLOCK * SEA_BLOCK) continue;
      land ??= new Uint8Array(TILE * TILE).fill(1);
      for (let y = by; y < by + SEA_BLOCK; y++) land.fill(0, y * TILE + bx, y * TILE + bx + SEA_BLOCK);
    }
  return land ?? null;
}

function loadTile(mapKey, tx, ty) {
  let key = `${mapKey}/${tx}/${ty}`;
  if (tiles.has(key)) {
    let value = tiles.get(key);
    tiles.delete(key); // keep the most recently used at the end
    tiles.set(key, value);
    return value;
  }
  let promise = new Promise((resolve) => {
    let img = new Image();
    img.onload = () => {
      let c = new OffscreenCanvas(TILE, TILE);
      let g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      let rgba = g.getImageData(0, 0, TILE, TILE).data;
      resolve({ gray: NCC.toGray(rgba, TILE, TILE), land: landMask(rgba) });
    };
    img.onerror = () => resolve(null);
    img.src = `${config.mapsUrl}/${mapKey}/tiles/5/${tx}/${ty}.jpg`;
  });
  tiles.set(key, promise);
  if (tiles.size > TILE_CACHE) tiles.delete(tiles.keys().next().value);
  return promise;
}

async function reference(mapKey, x0, y0, w, h) {
  let gray = new Float32Array(w * h);
  let land = null; // only built when some sea is in the window
  let any = false;
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h - 1) / TILE); ty++)
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w - 1) / TILE); tx++) {
      if (tx < 0 || ty < 0 || tx >= 32 || ty >= 32) continue;
      let t = await loadTile(mapKey, tx, ty);
      if (!t) continue;
      any = true;
      let ax = tx * TILE;
      let ay = ty * TILE;
      let sx0 = Math.max(x0, ax);
      let sx1 = Math.min(x0 + w, ax + TILE);
      if (t.land && !land) land = new Float32Array(w * h).fill(1);
      for (let y = Math.max(y0, ay); y < Math.min(y0 + h, ay + TILE); y++) {
        let from = (y - ay) * TILE + (sx0 - ax);
        let to = (y - y0) * w + (sx0 - x0);
        gray.set(t.gray.subarray(from, from + sx1 - sx0), to);
        if (t.land) land.set(t.land.subarray(from, from + sx1 - sx0), to);
      }
    }
  return any ? { gray, land } : null;
}

// --- frames ------------------------------------------------------------------------------

function grab(source, sx, sy, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
  return { data: NCC.toGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h };
}

async function processFrame(frame, at) {
  let started = performance.now();
  let result = await locator.locate(frame, prior, config.anchor, at);
  result.ms = Math.round(performance.now() - started);
  result.at = at;
  window.vision.report(result);
}

// A game repaints all the time: a stream that stops delivering frames has died (the game going
// fullscreen or changing mode while starting can end it) and only shows its last, stale frame.
const STALL_MS = 4000;
let lastFrameAt;
let stallReported = false;
function watchFrames() {
  video.requestVideoFrameCallback(() => {
    lastFrameAt = performance.now();
    watchFrames();
  });
}

function stalled() {
  let track = video.srcObject?.getVideoTracks()[0];
  return track?.readyState === "ended" || (lastFrameAt !== undefined && performance.now() - lastFrameAt > STALL_MS);
}

async function tick() {
  if (busy || !config || video.readyState < 2) return;
  if (stalled()) {
    if (!stallReported) window.vision.report({ status: "stalled" });
    stallReported = true;
    return;
  }
  busy = true;
  let started = performance.now();
  let frameBefore = lastFrameAt;
  try {
    let { region } = config;
    let k = video.videoWidth / config.display.width; // the stream may come scaled
    let frame = grab(video, region.x * k, region.y * k, Math.round(region.w * k), Math.round(region.h * k));
    if (config.dump) {
      config.dump = false;
      let blob = await canvas.convertToBlob({ type: "image/png" });
      let bytes = new Uint8Array(await blob.arrayBuffer());
      window.vision.report({ status: "dump", png: bytes, video: [video.videoWidth, video.videoHeight] });
    }
    await processFrame(frame, Date.now());
  } catch (e) {
    window.vision.report({ status: "error", error: String(e) });
  } finally {
    busy = false;
    // A long search holds the page, so no frame can be seen meanwhile (a 6.6 s one on a busy PC
    // passed for a dead capture): that time does not count as silence.
    if (frameBefore !== undefined && lastFrameAt === frameBefore) lastFrameAt += performance.now() - started;
  }
}

async function startCapture() {
  let stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: config.sourceId,
        minWidth: config.display.width,
        maxWidth: config.display.width,
        minHeight: config.display.height,
        maxHeight: config.display.height,
        maxFrameRate: 8,
      },
    },
  });
  video.srcObject = stream;
  await video.play();
  watchFrames();
  clearInterval(timer);
  timer = setInterval(tick, FRAME_INTERVAL_MS);
}

async function runTest() {
  for (let item of config.testFrames) {
    let img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = item.url;
    });
    prior = item.prior;
    let frame = grab(img, 0, 0, img.naturalWidth, img.naturalHeight);
    let started = performance.now();
    let result = await locator.locate(frame, prior, config.anchor, item.at);
    window.vision.report({ ...result, ms: Math.round(performance.now() - started), name: item.name });
  }
  window.vision.report({ status: "test-done" });
}

window.vision.onConfig(async (next) => {
  config = next;
  locator = new MinimapLocator({ reference, scale: config.scale, mapKey: config.mapKey });
  try {
    if (config.testFrames) await runTest();
    else await startCapture();
  } catch (e) {
    window.vision.report({ status: "capture-failed", error: String(e) });
  }
});

window.vision.onPrior((next) => {
  prior = next;
});
