// World <-> map conversions for Aion 2.
// Packet coordinates are Unreal units (cm): x grows to the east, y grows to the south on the map.
// Verified 2026-10-27 against aion2maps markers: gathering nodes land at 0.0 px with this transform.
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

module.exports = { MAPS, ROUTE_SIZE, toRoutePixels };
