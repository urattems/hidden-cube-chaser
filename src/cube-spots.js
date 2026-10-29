// Where hidden cubes can spawn. Each cube belongs to a group of candidate spots and, once opened,
// comes back on one of them. Read from the game client by aion2maps, extracted into
// data/cube-spots.json by tools/extract-cube-spots.js, in world cm like the packets.
const SPOTS = require("./data/cube-spots.json");

const MATCH_CM = 200; // logged cubes sit within 5 cm of their spot

function groupLabel(name) {
  return name.replace(/_/g, " ").replace(/ +/g, " ").trim();
}

// The group and spot a cube stands on, or undefined. Searches every map when the map is unknown.
function locateCube(x, y, map) {
  let best;
  for (let [id, groups] of Object.entries(SPOTS)) {
    if (map !== undefined && SPOTS[map] && Number(id) !== map) continue;
    for (let group of groups)
      group.spots.forEach(([sx, sy], index) => {
        let d = Math.hypot(sx - x, sy - y);
        if (d <= MATCH_CM && (!best || d < best.d)) best = { map: Number(id), group: group.name, index, count: group.spots.length, d };
      });
  }
  return best && { ...best, label: groupLabel(best.group) };
}

function groupSpots(map, name) {
  return SPOTS[map]?.find((g) => g.name === name)?.spots ?? [];
}

module.exports = { locateCube, groupSpots, groupLabel };
