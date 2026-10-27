// World <-> map conversions for Aion 2, shared by the main process and the overlay.
// Packet coordinates are Unreal units (cm): x grows to the east, y grows to the south on the map.
// Verified 2026-10-27 against aion2maps markers: gathering nodes land at 0.0 px with this transform.
(function (root) {
  const MAPS = {
    1010: { key: "verteron", name: "Verteron" },
    1110: { key: "altgard", name: "Altgard" },
  };
  const LAYER = 8192; // aion2maps layer size in px
  const WORLD_SPAN_M = 8160; // metres covered by that layer
  const ROUTE_SIZE = 4096; // Map Overlay route mapSize

  function toRoutePixels(x, y) {
    let k = (LAYER / WORLD_SPAN_M / 100) * (ROUTE_SIZE / LAYER);
    let c = (LAYER / 2) * (ROUTE_SIZE / LAYER);
    return { x: x * k + c, y: y * k + c };
  }

  // Clockwise angle from map north (screen up), in degrees, of the vector from -> to.
  function bearingNorthUp(from, to) {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    return (Math.atan2(dx, -dy) * 180) / Math.PI;
  }

  function wrap180(a) {
    return ((((a + 180) % 360) + 360) % 360) - 180;
  }

  function compassPoint(bearing) {
    const names = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
    return names[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
  }

  const api = { MAPS, ROUTE_SIZE, toRoutePixels, bearingNorthUp, wrap180, compassPoint };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Geometry = api;
})(typeof window === "undefined" ? globalThis : window);
