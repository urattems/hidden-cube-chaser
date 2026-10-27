// Checks the GitHub releases of this repository and installs a newer portable build in place.
// The repository is private: anonymous requests are tried first, then the token of the GitHub
// CLI (`gh auth login`) when it is installed.
const { app } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const REPO = "urattems/hidden-cube-chaser";
const API = `https://api.github.com/repos/${REPO}`;
const ASSET = /-win-x64\.zip$/;
const EXE = "Hidden Cube Chaser.exe";
const GH_PATHS = ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe", "C:\\Program Files (x86)\\GitHub CLI\\gh.exe"];

function newer(a, b) {
  let pa = a.split(".").map(Number);
  let pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}

async function ghToken() {
  for (let gh of GH_PATHS) {
    let token = await run(gh, ["auth", "token"]);
    if (token) return token;
  }
  return undefined;
}

class Updater extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.version = app.getVersion();
    this.installDir = path.dirname(process.execPath);
    this.state = { status: app.isPackaged ? "idle" : "dev" };
    this.token = undefined;
  }

  // The zip and its unpacked copy of an installed update (~300 MB) stay in %TEMP% until the
  // updated app starts again; it removes them then.
  cleanup() {
    let temp = app.getPath("temp");
    for (let name of fs.readdirSync(temp)) {
      if (!name.startsWith("hcc-update-")) continue;
      try {
        fs.rmSync(path.join(temp, name), { recursive: true, force: true });
      } catch {}
    }
  }

  set(state) {
    this.state = state;
    this.emit("change", state);
  }

  async request(url, accept = "application/vnd.github+json") {
    let headers = { Accept: accept, "User-Agent": "hidden-cube-chaser" };
    let res = await fetch(url, { headers });
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      this.token ??= await ghToken();
      if (!this.token) return { auth: true };
      res = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${this.token}` } });
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${url}`);
    return { res };
  }

  async check() {
    if (this.state.status === "dev" || this.state.status === "downloading") return;
    this.set({ ...this.state, status: "checking" });
    try {
      let { res, auth } = await this.request(`${API}/releases/latest`);
      if (auth) return this.set({ status: "auth" });
      let release = await res.json();
      let latest = String(release.tag_name).replace(/^v/, "");
      let asset = release.assets?.find((a) => ASSET.test(a.name));
      if (newer(latest, this.version) && asset) {
        this.log(`update ${latest} available (${asset.name})`);
        this.set({ status: "available", latest, asset: { id: asset.id, name: asset.name } });
      } else {
        this.set({ status: "up-to-date", latest });
      }
    } catch (e) {
      this.log(`update check failed: ${e.message}`);
      this.set({ status: "error", error: e.message });
    }
  }

  // Downloads and unpacks the new build, then hands over to a script that waits for this app to
  // exit, copies the files over the install folder and starts it again.
  async install() {
    let { status, latest, asset } = this.state;
    if (status !== "available") return;
    if (!fs.existsSync(path.join(this.installDir, EXE))) {
      this.set({ status: "error", error: `${EXE} introuvable dans ${this.installDir}` });
      return;
    }
    this.set({ status: "downloading", latest, asset });
    try {
      let work = fs.mkdtempSync(path.join(app.getPath("temp"), "hcc-update-"));
      let zip = path.join(work, asset.name);
      let { res } = await this.request(`${API}/releases/assets/${asset.id}`, "application/octet-stream");
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      let unpacked = path.join(work, "unpacked");
      let ok = await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpacked}' -Force; 'ok'`,
      ]);
      let source = [unpacked, path.join(unpacked, "Hidden Cube Chaser")].find((d) => fs.existsSync(path.join(d, EXE)));
      if (ok !== "ok" || !source) throw new Error("archive de mise à jour illisible");
      let script = path.join(work, "update.ps1");
      fs.writeFileSync(
        script,
        [
          "param([int]$AppPid, [string]$Source, [string]$Target, [string]$Exe)",
          "Wait-Process -Id $AppPid -Timeout 60 -ErrorAction SilentlyContinue",
          "Start-Sleep -Seconds 1",
          // /E copies everything and deletes nothing in the install folder; retries cover files
          // Windows still holds for a moment after the app exits.
          'robocopy "$Source" "$Target" /E /R:10 /W:1 /NFL /NDL /NJH /NJS | Out-Null',
          "Start-Process -FilePath $Exe",
        ].join("\r\n"),
      );
      this.log(`update ${latest}: installing from ${source}`);
      // Started through WMI so it lives outside this app's job object: a plain detached child is
      // killed along with the app when the app is quitting, which is exactly when it must run.
      let quote = (s) => `"${s}"`;
      let commandLine = [
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File",
        quote(script),
        `-AppPid ${process.pid}`,
        `-Source ${quote(source)}`,
        `-Target ${quote(this.installDir)}`,
        `-Exe ${quote(path.join(this.installDir, EXE))}`,
      ].join(" ");
      let created = await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }).ReturnValue`,
      ]);
      if (created !== "0") throw new Error(`impossible de lancer l'installation (WMI ${created})`);
      app.quit();
    } catch (e) {
      this.log(`update failed: ${e.message}`);
      this.set({ status: "error", error: e.message, latest, asset });
    }
  }
}

module.exports = { Updater, newer };
