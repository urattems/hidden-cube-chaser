// Records the game's raw TCP streams (both directions) with the worker's own recorder, alongside
// the worker's view of the player's position, for protocol research.
// Usage: node_modules\electron\dist\electron.exe tools\record.js [seconds]
// Output: tools\recordings\capture-*.ndjson ([time, "data", connection, "in"|"out", base64], ...)
//         tools\recordings\positions.ndjson ([time, self, map])
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { QuestlogWorker } = require("../src/questlog-worker");

const seconds = Number(process.argv.at(-1)) || 60;
const out = path.join(__dirname, "recordings");

app.whenReady().then(() => {
  let dataDir = path.join(app.getPath("temp"), "hidden-cube-chaser-record");
  fs.mkdirSync(out, { recursive: true });
  let positions = fs.createWriteStream(path.join(out, "positions.ndjson"));
  let worker = new QuestlogWorker({ dataDir, log: () => {} });
  let started = false;
  worker.on("data", (procedurePath, data) => {
    if (procedurePath === "capture.status" && data.state === "capturing" && !started) {
      started = true;
      worker.mutate("capture.recording.start");
    }
    if (procedurePath === "map.positions") positions.write(`${JSON.stringify([Date.now(), data.self, data.map])}\n`);
  });
  worker.subscribe("capture.status");
  worker.subscribe("map.positions");
  worker.start();
  setTimeout(() => {
    worker.mutate("capture.recording.stop");
    setTimeout(() => {
      let dir = path.join(dataDir, "recordings");
      for (let name of fs.readdirSync(dir)) fs.renameSync(path.join(dir, name), path.join(out, name));
      positions.end();
      worker.stop();
      app.quit();
    }, 1500);
  }, seconds * 1000);
});
