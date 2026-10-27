// Writes the live cubes as a route of problem-xyz/aion2-map-overlay, so that app draws them on
// the in-game map. Map Overlay watches its routes folder and reloads the open route by itself.
const fs = require("fs");
const path = require("path");
const { MAPS, ROUTE_SIZE, toRoutePixels } = require("./geometry");

const ROUTES_DIR = path.join(process.env.LOCALAPPDATA ?? "", "Aion2MapOverlayData", "routes");
const COLORS = { gold: "#f5b91a", red: "#ff4d4d" };
const LOOK_FR = { gold: "or", red: "rouge" };

function fileFor(mapKey) {
  return path.join(ROUTES_DIR, `Chaser_-_Cube_cache_${mapKey}.json`);
}

function routeDoc(mapKey, mapName, cubes) {
  return {
    format: "map-overlay-route",
    version: 1,
    name: `Hidden Cube Chaser - cube actif (${mapName})`,
    map: mapKey,
    mapSize: [ROUTE_SIZE, ROUTE_SIZE],
    markers: cubes.map((c) => {
      let p = toRoutePixels(c.x, c.y);
      return {
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        text: `Cube caché ${LOOK_FR[c.look] ?? ""} (${Math.round(c.x / 100)}, ${Math.round(c.y / 100)})`,
        color: COLORS[c.look] ?? "#f5b91a",
      };
    }),
  };
}

class MapOverlayExport {
  constructor(log) {
    this.log = log;
    this.written = new Map(); // map key -> json text
  }

  available() {
    return fs.existsSync(ROUTES_DIR);
  }

  // cubes: [{ x, y, look }] currently open on mapId. Every supported map's file is kept in sync, so
  // a cube taken or a map left empties the marker instead of leaving a stale one behind.
  update(mapId, cubes) {
    if (!this.available()) return;
    for (let [id, map] of Object.entries(MAPS)) {
      let list = Number(id) === mapId ? cubes : [];
      let text = JSON.stringify(routeDoc(map.key, map.name, list), null, 2) + "\n";
      if (this.written.get(map.key) === text) continue;
      let file = fileFor(map.key);
      try {
        // Write then rename, so Map Overlay never reads half a file.
        fs.writeFileSync(`${file}.tmp`, text, "utf8");
        fs.renameSync(`${file}.tmp`, file);
        this.written.set(map.key, text);
      } catch (e) {
        this.log(`map overlay export failed: ${e.message}`);
      }
    }
  }
}

module.exports = { MapOverlayExport, ROUTES_DIR };
