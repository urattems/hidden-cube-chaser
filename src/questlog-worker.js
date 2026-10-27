// Runs Questlog's own Aion 2 combat worker (read straight from its installed app.asar)
// in a utility process we own, and speaks the small tRPC-over-parentPort protocol it expects.
// Nothing in the Questlog install is modified; when Questlog updates, we pick up its new decoder.
const { utilityProcess } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const DEFAULT_ASAR = "C:\\Program Files\\Questlog\\resources\\app.asar";
const WORKER_IN_ASAR = path.join(".output", "electron", "workers", "aion-2", "combat.cjs");
const SITE_URL = "https://questlog.gg/aion-2";
const GAME_PROCESS = /^aion2\.exe$/i;
const PID_REFRESH_MS = 2000;

// Host procedures the worker calls on its parent (see tt() in combat.cjs). Other mutations
// (setTimers, mutateSite crowd reports to questlog.gg, uploads) are acknowledged and dropped:
// Questlog itself already sends those, and this instance only reads.
function hostProcedures(getPids) {
  return {
    pids: () => getPids(),
    uploadSettings: () => ({ automatic: false, signedIn: false }),
  };
}

function trpcError(message) {
  return { message, code: -32603, data: { code: "INTERNAL_SERVER_ERROR" } };
}

class QuestlogWorker extends EventEmitter {
  constructor({ asarPath = DEFAULT_ASAR, dataDir, log }) {
    super();
    this.asarPath = asarPath;
    this.dataDir = dataDir;
    this.log = log;
    this.subscriptions = new Map(); // id -> path
    this.nextId = 1;
    this.child = undefined;
    this.pids = [];
    this.stopped = false;
    this.restartDelay = 1000;
    this.procedures = hostProcedures(() => this.pids);
  }

  get workerPath() {
    return path.join(this.asarPath, WORKER_IN_ASAR);
  }

  subscribe(procedurePath) {
    let id = this.nextId++;
    this.subscriptions.set(id, procedurePath);
    this.send(id, procedurePath);
    return id;
  }

  start() {
    if (!fs.existsSync(this.asarPath)) {
      this.emit("status", { state: "no-questlog", error: `Questlog introuvable : ${this.asarPath}` });
      return;
    }
    this.stopped = false;
    this.refreshPids();
    this.pidTimer = setInterval(() => this.refreshPids(), PID_REFRESH_MS);
    this.spawn();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pidTimer);
    this.child?.kill();
  }

  spawn() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let child = utilityProcess.fork(this.workerPath, [`--user-data=${this.dataDir}`, `--site-url=${SITE_URL}`], {
      serviceName: "hidden-cube-chaser-aion-2",
      stdio: "pipe",
    });
    this.child = child;
    child.stdout?.on("data", (d) => this.log(`[worker] ${String(d).trimEnd()}`));
    child.stderr?.on("data", (d) => this.log(`[worker:err] ${String(d).trimEnd()}`));
    child.on("spawn", () => {
      this.log(`worker started from ${this.workerPath}`);
      this.restartDelay = 1000;
      for (let [id, procedurePath] of this.subscriptions) this.send(id, procedurePath);
    });
    child.on("message", (message) => this.receive(message));
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.log(`worker exited with code ${code}`);
      this.emit("status", { state: "worker-restarting" });
      if (this.stopped) return;
      setTimeout(() => !this.stopped && this.spawn(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    });
  }

  send(id, procedurePath) {
    this.child?.postMessage({
      connection: 1,
      message: { id, type: "subscription", path: procedurePath },
    });
  }

  receive(message) {
    if (!message || typeof message !== "object") return;
    if ("host" in message) return this.answerHost(message.host);
    let response = message.response;
    if (!response || response.id === undefined) return;
    let procedurePath = this.subscriptions.get(response.id);
    if (!procedurePath) return;
    if (response.error) {
      this.log(`subscription ${procedurePath} failed: ${JSON.stringify(response.error).slice(0, 500)}`);
      return;
    }
    if (response.result?.type === "data") this.emit("data", procedurePath, response.result.data);
  }

  answerHost(request) {
    if (!request || request.type === "stop") return;
    let procedure = this.procedures[request.path];
    let reply = procedure
      ? { id: request.id, result: { type: "data", data: procedure(request.input) } }
      : request.type === "mutation"
        ? { id: request.id, result: { type: "data", data: null } }
        : { id: request.id, error: trpcError(`${request.path} is not available in Hidden Cube Chaser`) };
    this.child?.postMessage({ host: reply });
  }

  refreshPids() {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 8 << 20 }, (error, stdout) => {
      if (error) return;
      let pids = [];
      for (let line of stdout.split(/\r?\n/)) {
        let [name, pid] = line.split('","').map((s) => s.replace(/"/g, ""));
        if (name && GAME_PROCESS.test(name)) pids.push(Number(pid));
      }
      let changed = pids.join() !== this.pids.join();
      this.pids = pids;
      if (changed) this.emit("game", pids.length > 0);
    });
  }
}

module.exports = { QuestlogWorker, DEFAULT_ASAR };
