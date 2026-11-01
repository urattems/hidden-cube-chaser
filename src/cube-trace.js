// What the log needs to explain a cube that never showed on the corner map: for each cube, how the
// reading of the map went while it was in range and whether its marker was drawn.
class CubeTrace {
  constructor(log) {
    this.log = log;
    this.cubes = new Map(); // cube id -> what happened since it was announced
  }

  // The cubes the worker currently knows: a new one starts a trace, a missing one ends it.
  update(cubes, now = Date.now()) {
    for (let cube of cubes)
      if (!this.cubes.has(cube.id))
        this.cubes.set(cube.id, { since: now, frames: {}, count: 0, ms: 0, maxMs: 0 });
    let present = new Set(cubes.map((c) => c.id));
    for (let [id, trace] of this.cubes) {
      if (present.has(id)) continue;
      this.log(`cube ${id} gone: ${this.summary(trace, now)}`);
      this.cubes.delete(id);
    }
  }

  // One vision result, with Questlog's estimate at that moment.
  vision(result, estimate) {
    for (let trace of this.cubes.values()) {
      trace.frames[result.status] = (trace.frames[result.status] ?? 0) + 1;
      if (result.ms !== undefined) {
        trace.count++;
        trace.ms += result.ms;
        trace.maxMs = Math.max(trace.maxMs, result.ms);
      }
      if (result.status === "lost" && result.score !== undefined && !(trace.bestLost?.score >= result.score))
        trace.bestLost = { score: result.score, patches: result.patches };
      if (estimate) {
        trace.claimed = Math.max(trace.claimed ?? 0, (estimate.accuracy ?? 0) / 100);
        if (result.status === "fix")
          trace.off = Math.max(trace.off ?? 0, Math.hypot(result.x - estimate.x, result.y - estimate.y) / 100);
      }
    }
  }

  // Its marker has just been placed on the corner map.
  drawn(id, distance, now = Date.now()) {
    let trace = this.cubes.get(id);
    if (!trace || trace.drawnAfter !== undefined) return;
    trace.drawnAfter = (now - trace.since) / 1000;
    this.log(`cube ${id} drawn after ${trace.drawnAfter.toFixed(1)} s, ${distance.toFixed(0)} m away`);
  }

  summary(t, now) {
    let parts = [`in range ${Math.round((now - t.since) / 1000)} s`];
    parts.push(t.drawnAfter === undefined ? "never drawn" : `drawn after ${t.drawnAfter.toFixed(1)} s`);
    let frames = Object.entries(t.frames).map(([status, n]) => `${status} ${n}`);
    parts.push(`frames ${frames.join(" ") || "none"}`);
    if (t.count) parts.push(`${Math.round(t.ms / t.count)} ms avg ${t.maxMs} max`);
    if (t.bestLost) parts.push(`best lost ${t.bestLost.score.toFixed(2)} ${t.bestLost.patches ?? ""}`.trimEnd());
    if (t.claimed !== undefined)
      parts.push(`estimate ${t.off === undefined ? "?" : `off ${Math.round(t.off)} m`}, claims ${Math.round(t.claimed)} m`);
    return parts.join(", ");
  }
}

module.exports = { CubeTrace };
