// Finds the player's exact world position by matching the game's corner map (minimap) against
// the reference map tiles Aion 2 - Map Overlay keeps locally. The corner map is north-up, so the
// only unknowns are its zoom (calibrated once, then kept) and where it sits on the world map.
(function (root) {
  const NCC = root.NCC ?? (typeof require === "function" ? require("./ncc") : undefined);

  const K = 8192 / 8160 / 100; // world cm -> reference px (about 1 px per metre)
  const CENTER = 4096;
  const MAP_KEYS = { 1010: "verteron", 1110: "altgard" };
  // Part of the selected region used for matching: clear of the opacity sliders along the top
  // and the buttons down the right-hand edge.
  const TEMPLATE = { left: 0.02, top: 0.06, right: 0.94, bottom: 0.97 };
  // A fix needs the whole frame to correlate and a 3x3 grid of patches to land on the same spot.
  // A popup or the cursor over part of the corner map lowers the whole-frame score, so a weaker
  // score passes when more patches agree.
  const ACCEPT = 0.45;
  const ACCEPT_PATCHES = 5;
  const WEAK = 0.25;
  const WEAK_PATCHES = 6;
  const PATCH_GRID = 3;
  const PATCH_ACCEPT = 0.5;
  const PATCH_SLACK = 3; // px each patch may move from the whole-frame answer
  const CALIBRATE = 0.55;
  const CALIBRATE_PATCHES = 7;
  const CALIBRATE_REFINED = 0.45; // below this at half resolution, the costly last pass is not worth it
  // Reference px per screen px: the same in-game zoom gives a higher value on a smaller screen
  // (0.75 at 1440p is 1.0 at 1080p), and zooming out raises it further (1.415 seen at 1080p).
  const SCALE_MIN = 0.3;
  const SCALE_MAX = 3;
  const SCALE_STEP = 1.05;
  // Dungeons and caves draw a near-black corner map (mean ~10 against ~150 outdoors): nothing to match.
  const DARK_MAP = 50;
  // After losing track, a fix is only reported once a second frame lands at the same place.
  const CONFIRM_MS = 2500;
  const CONFIRM_SLACK = 300; // cm, plus 12 m/s of movement
  const MISSES_BEFORE_RESCALE = 8;
  const RESCALE_COOLDOWN_MS = 8000;
  const UNKNOWN_SCALE_RETRY_MS = 3000;

  const toRef = (cm) => cm * K + CENTER;
  const toWorld = (px) => (px - CENTER) / K;

  class MinimapLocator {
    // reference(mapKey, x0, y0, w, h) -> Promise<Float32Array | null> in reference px.
    constructor({ reference, scale, mapKey }) {
      this.reference = reference;
      this.scale = scale ?? undefined; // reference px per screen px
      this.mapKey = mapKey ?? undefined;
      this.last = undefined; // { x, y, at } of the last fix, world cm
      this.misses = 0;
      this.lastRescale = 0;
      this.turn = 0; // which map this frame tries while the map is not settled
    }

    // frame: { data: Float32Array gray, w, h } of the selected region at screen resolution.
    // prior: { x, y, accuracy, map } in world cm from Questlog (any field may be missing).
    async locate(frame, prior, anchor = { x: 0.5, y: 0.5 }, now = Date.now()) {
      let guess = this.guess(prior, now);
      if (!guess) return { status: "no-prior" };
      let keys = this.candidateKeys(prior, now);
      if (!keys.length) return { status: "no-map" };

      let crop = this.templateCrop(frame);
      let mean = 0;
      for (let v of crop.data) mean += v;
      if (mean / crop.data.length < DARK_MAP) return { status: "no-map" };
      let cooled = now - this.lastRescale > (this.scale === undefined ? UNKNOWN_SCALE_RETRY_MS : RESCALE_COOLDOWN_MS);
      if (this.scale === undefined && !cooled) return { status: "searching" };
      let needScale = this.scale === undefined || (this.misses >= MISSES_BEFORE_RESCALE && cooled);
      if (needScale) {
        this.lastRescale = now;
        let found = await this.findScale(crop, frame, anchor, guess, keys);
        if (!found) {
          this.misses++;
          return { status: "searching" };
        }
        this.scale = found.scale;
        this.mapKey = found.mapKey;
        keys = [found.mapKey];
      }

      // With no settled map, one map per frame: both at once would double the cost of every frame
      // for as long as the corner map stays closed.
      let mapKey = keys[this.turn++ % keys.length];
      let best = await this.match(crop, frame, anchor, guess, mapKey, this.scale, 1);
      if (!best || !best.accepted) {
        this.misses++;
        return { status: "lost", score: best?.score, patches: best?.patches };
      }
      this.misses = 0;
      this.mapKey = mapKey;
      if (!this.last || now - this.last.at > 3000) {
        let p = this.pending;
        this.pending = { x: best.x, y: best.y, at: now };
        let slack = p && CONFIRM_SLACK + ((now - p.at) / 1000) * 1200;
        if (!p || now - p.at > CONFIRM_MS || Math.hypot(best.x - p.x, best.y - p.y) > slack)
          return { status: "searching", score: best.score, patches: best.patches };
      }
      this.pending = undefined;
      this.last = { x: best.x, y: best.y, at: now };
      return {
        status: "fix",
        x: best.x,
        y: best.y,
        score: best.score,
        patches: best.patches,
        scale: this.scale,
        mapKey,
      };
    }

    // Where to look and how far: around the last fix while it is fresh, else Questlog's estimate.
    guess(prior, now) {
      if (this.last && now - this.last.at < 3000) {
        let radius = 15 + ((now - this.last.at) / 1000) * 12; // ~12 m/s covers running and gliding
        return { x: this.last.x, y: this.last.y, radius };
      }
      if (prior?.x === undefined) return undefined;
      let accuracy = (prior.accuracy ?? 3000) / 100;
      return { x: prior.x, y: prior.y, radius: Math.min(120, Math.max(30, accuracy * 1.5 + 20)) };
    }

    candidateKeys(prior, now) {
      if (prior?.map !== undefined && prior.map !== null) {
        let known = MAP_KEYS[prior.map];
        return known ? [known] : []; // a dungeon or another region: no reference to match
      }
      // Questlog only learns the map on a zone change, which can take minutes after logging in, and
      // the character may have changed side since the last session: only a live fix settles the map.
      if (this.mapKey && this.last && now - this.last.at < 3000) return [this.mapKey];
      return Object.values(MAP_KEYS);
    }

    templateCrop(frame) {
      let x = Math.round(frame.w * TEMPLATE.left);
      let y = Math.round(frame.h * TEMPLATE.top);
      let w = Math.round(frame.w * TEMPLATE.right) - x;
      let h = Math.round(frame.h * TEMPLATE.bottom) - y;
      return { x, y, w, h, data: NCC.crop(frame.data, frame.w, x, y, w, h) };
    }

    // Template at `scale` (reference px per screen px) reduced by `level`, and the player's place in it.
    scaledTemplate(crop, frame, anchor, scale, level) {
      let tw = Math.max(8, Math.round((crop.w * scale) / level));
      let th = Math.max(8, Math.round((crop.h * scale) / level));
      let data = NCC.resize(crop.data, crop.w, crop.h, tw, th);
      let ax = ((frame.w * anchor.x - crop.x) * tw) / crop.w;
      let ay = ((frame.h * anchor.y - crop.y) * th) / crop.h;
      return { data, tw, th, ax, ay };
    }

    async match(crop, frame, anchor, guess, mapKey, scale, level) {
      let t = this.scaledTemplate(crop, frame, anchor, scale, level);
      let r = Math.ceil(guess.radius / level);
      let ex = toRef(guess.x) / level - t.ax;
      let ey = toRef(guess.y) / level - t.ay;
      let x0 = Math.floor(ex) - r - 3;
      let y0 = Math.floor(ey) - r - 3;
      let rw = t.tw + 2 * r + 6;
      let rh = t.th + 2 * r + 6;
      let ref = await this.referenceAt(mapKey, x0, y0, rw, rh, level);
      if (!ref) return undefined;
      let hit = NCC.locate(ref, rw, rh, t.data, t.tw, t.th, ex - x0, ey - y0, r);
      let accepted = false;
      let patches;
      if (level === 1 && hit.score >= WEAK) {
        patches = this.patchVote(ref, rw, rh, t, hit);
        accepted =
          (hit.score >= ACCEPT && patches.agree >= ACCEPT_PATCHES) ||
          (hit.score >= WEAK && patches.agree >= WEAK_PATCHES);
        // Under partial cover the agreeing patches know better than the whole frame.
        if (accepted && hit.score < ACCEPT) hit = { ...hit, x: hit.x + patches.dx, y: hit.y + patches.dy };
      }
      return {
        x: toWorld((x0 + hit.x + t.ax) * level),
        y: toWorld((y0 + hit.y + t.ay) * level),
        score: hit.score,
        patches: patches && `${patches.agree}/${patches.total}`,
        patchesAgree: patches?.agree ?? 0,
        accepted,
      };
    }

    // Each patch of the template searched a few px around where the whole-frame answer puts it.
    patchVote(ref, rw, rh, t, hit) {
      let pw = Math.floor(t.tw / PATCH_GRID);
      let ph = Math.floor(t.th / PATCH_GRID);
      let agreeing = [];
      let total = 0;
      if (pw < 16 || ph < 16) return { agree: 0, total: 0, dx: 0, dy: 0 };
      let integ = NCC.integrals(ref, rw, rh);
      for (let gy = 0; gy < PATCH_GRID; gy++)
        for (let gx = 0; gx < PATCH_GRID; gx++) {
          let patch = NCC.template(NCC.crop(t.data, t.tw, gx * pw, gy * ph, pw, ph), pw, ph);
          if (patch.norm < 1e-3 * pw * ph) continue; // flat patch: nothing to match
          total++;
          let ex = Math.round(hit.x) + gx * pw;
          let ey = Math.round(hit.y) + gy * ph;
          let p = NCC.searchWindow(ref, rw, rh, integ, patch, ex - PATCH_SLACK, ey - PATCH_SLACK, ex + PATCH_SLACK, ey + PATCH_SLACK);
          let inside = Math.abs(p.x - ex) < PATCH_SLACK && Math.abs(p.y - ey) < PATCH_SLACK;
          if (p.score >= PATCH_ACCEPT && inside) agreeing.push({ dx: p.x - ex, dy: p.y - ey });
        }
      let median = (values) => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;
      return {
        agree: agreeing.length,
        total,
        dx: median(agreeing.map((a) => a.dx)),
        dy: median(agreeing.map((a) => a.dy)),
      };
    }

    async referenceAt(mapKey, x0, y0, w, h, level) {
      if (level === 1) return this.reference(mapKey, x0, y0, w, h);
      let full = await this.reference(mapKey, x0 * level, y0 * level, w * level, h * level);
      return full && NCC.resize(full, w * level, h * level, w, h);
    }

    // The corner map's zoom: try a range of scales coarsely, then refine around the best.
    async findScale(crop, frame, anchor, guess, keys) {
      // Each map gets its own full check: a wrong map's lucky coarse score must not hide the right one.
      for (let key of keys) {
        let found = await this.findScaleOn(crop, frame, anchor, guess, key);
        if (found) return found;
      }
      return undefined;
    }

    async findScaleOn(crop, frame, anchor, guess, mapKey) {
      let wide = { ...guess, radius: Math.max(guess.radius, 40) };
      let best;
      for (let s = SCALE_MIN; s <= SCALE_MAX + 1e-9; s *= SCALE_STEP) {
        let fix = await this.match(crop, frame, anchor, wide, mapKey, s, 4);
        if (fix && (!best || fix.score > best.score)) best = { ...fix, scale: s };
      }
      if (!best || best.score < 0.3) return undefined;
      let refined = best;
      let span = best.scale * (SCALE_STEP - 1);
      for (let s = best.scale - span; s <= best.scale + span + 1e-9; s += span / 4) {
        if (s < SCALE_MIN * 0.8) continue;
        let fix = await this.match(crop, frame, anchor, { x: best.x, y: best.y, radius: 12 }, mapKey, s, 2);
        if (fix && fix.score > refined.score) refined = { ...fix, scale: s };
      }
      if (refined.score < CALIBRATE_REFINED) return undefined;
      // Last pass at full resolution: 1 % of zoom already moves the frame's edges by more than the
      // few px a patch may move, so a zoom this close to right still fails the patch vote.
      let check;
      let fine = span / 4;
      for (let s = refined.scale - fine; s <= refined.scale + fine + 1e-9; s += fine / 4) {
        let fix = await this.match(crop, frame, anchor, { x: refined.x, y: refined.y, radius: 6 }, mapKey, s, 1);
        if (fix && (!check || fix.score > check.score)) check = { ...fix, scale: s };
      }
      // A calibration is kept for the session, so it must be beyond doubt: a strong whole-frame
      // score and most patches agreeing (a dark cave floor can otherwise pass for terrain).
      let calibrated = check && check.score >= CALIBRATE && check.patchesAgree >= CALIBRATE_PATCHES;
      return calibrated ? { scale: check.scale, mapKey } : undefined;
    }
  }

  const api = { MinimapLocator, MAP_KEYS, SCALE_MIN, SCALE_MAX, toRef, toWorld };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MinimapLocatorLib = api;
})(typeof self !== "undefined" ? self : globalThis);
