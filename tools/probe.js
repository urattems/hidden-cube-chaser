// Diagnostic : lance le worker Questlog et affiche ses données brutes pendant quelques secondes.
// Usage : node_modules\electron\dist\electron.exe tools\probe.js [secondes]
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { QuestlogWorker } = require("../src/questlog-worker");

const seconds = Number(process.argv.at(-1)) || 25;
const logFile = path.join(__dirname, "probe.log");
fs.writeFileSync(logFile, "");
console.log = (...args) => fs.appendFileSync(logFile, args.join(" ") + "\n");

app.whenReady().then(() => {
  let worker = new QuestlogWorker({
    dataDir: path.join(app.getPath("temp"), "hidden-cube-chaser-probe"),
    log: (line) => console.log(line),
  });
  worker.on("status", (s) => console.log("[status]", JSON.stringify(s)));
  worker.on("game", (running) => console.log("[game]", running));
  let objects = new Map();
  let selves = [];
  let maps = new Set();
  worker.on("data", (procedurePath, data) => {
    if (procedurePath === "map.positions") {
      for (let o of data.objects ?? []) objects.set(o.entity, o);
      if (data.self) selves.push(data.self);
      maps.add(data.map);
      fs.writeFileSync(
        path.join(__dirname, "probe-objects.json"),
        JSON.stringify({ maps: [...maps], objects: [...objects.values()], selves }, null, 1),
      );
    }
    let text = JSON.stringify(data);
    if (procedurePath === "map.positions")
      text = JSON.stringify({ map: data.map, self: data.self, objects: data.objects?.length, sample: data.objects?.slice(0, 3) });
    console.log(`[${procedurePath}]`, text.slice(0, 600));
  });
  for (let p of ["capture.status", "hiddenCubes", "map.positions"]) worker.subscribe(p);
  worker.start();
  setTimeout(() => {
    worker.stop();
    app.quit();
  }, seconds * 1000);
});
