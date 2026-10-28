// Renders the corner-map markers for a given list and saves the transparent result as PNG, to be
// laid over a captured corner map. Usage: electron.exe tools\markers-test.js <out.png> <w> <h> <json list>
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const [out, w, h, list] = process.argv.slice(-4);

app.whenReady().then(async () => {
  let win = new BrowserWindow({
    width: Number(w),
    height: Number(h),
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { preload: path.join(__dirname, "..", "src", "markers-preload.js"), offscreen: true },
  });
  await win.loadFile(path.join(__dirname, "..", "src", "markers.html"));
  win.webContents.send("markers", JSON.parse(list));
  setTimeout(async () => {
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    app.quit();
  }, 1500);
});
