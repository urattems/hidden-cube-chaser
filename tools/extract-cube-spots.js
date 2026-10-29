// Extracts the hidden-cube spawn groups from the aion2maps map data into src/data/cube-spots.json.
// Each group lists the spots its cube can spawn on, in world cm like the packets (aion2maps stores
// [x, z, y] in metres). Usage: node tools/extract-cube-spots.js [aion2maps folder]
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] ?? path.join(__dirname, "..", "..", "aion2maps");
const FILES = { 1010: "md_World_L_A.json", 1110: "md_World_D_A.json" };

let out = {};
for (let [map, file] of Object.entries(FILES)) {
  let data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  out[map] = data.cubes.map((c) => ({
    name: c.s.replace(/^EnvObj_[A-Z]\d_/, "").replace(/Hidden(Cube|Box)_?/, ""),
    key: !!c.ko,
    spots: c.pos.map(([x, z, y]) => [Math.round(x * 100), Math.round(y * 100), Math.round(z * 100)]),
  }));
  console.log(`${map}: ${out[map].length} groups, ${out[map].reduce((n, g) => n + g.spots.length, 0)} spots`);
}
let target = path.join(__dirname, "..", "src", "data", "cube-spots.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out));
console.log(`written ${target} (${fs.statSync(target).size} bytes)`);
