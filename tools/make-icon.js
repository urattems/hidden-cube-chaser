// Draws the app icon (a gold isometric cube) into assets/icon.png and assets/icon.ico.
// Usage: node tools/make-icon.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  let len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  let body = Buffer.concat([Buffer.from(type), data]);
  let crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  let raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  let ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inside(px, py, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    let [xi, yi] = poly[i];
    let [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Faces in unit space (0..1): top, left, right of an isometric cube.
const top = [[0.5, 0.08], [0.9, 0.3], [0.5, 0.52], [0.1, 0.3]];
const left = [[0.1, 0.3], [0.5, 0.52], [0.5, 0.95], [0.1, 0.72]];
const right = [[0.9, 0.3], [0.5, 0.52], [0.5, 0.95], [0.9, 0.72]];
const faces = [
  [top, [255, 214, 92]],
  [left, [214, 150, 18]],
  [right, [168, 108, 8]],
];

function cubePixel(size) {
  const samples = 4; // supersampling for smooth edges
  return (x, y) => {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy++)
      for (let sx = 0; sx < samples; sx++) {
        let u = (x + (sx + 0.5) / samples) / size;
        let v = (y + (sy + 0.5) / samples) / size;
        for (let [poly, colour] of faces)
          if (inside(u, v, poly)) {
            acc[0] += colour[0];
            acc[1] += colour[1];
            acc[2] += colour[2];
            acc[3] += 255;
            break;
          }
      }
    let n = samples * samples;
    let a = acc[3] / n;
    return a === 0 ? [0, 0, 0, 0] : [acc[0] / (acc[3] / 255), acc[1] / (acc[3] / 255), acc[2] / (acc[3] / 255), a].map(Math.round);
  };
}

const out = path.join(__dirname, "..", "assets");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.png"), png(32, cubePixel(32)));

// ICO holding PNG images (Windows Vista and later read these).
const sizes = [16, 32, 48, 256];
const images = sizes.map((s) => png(s, cubePixel(s)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  let e = 6 + i * 16;
  header[e] = s === 256 ? 0 : s;
  header[e + 1] = s === 256 ? 0 : s;
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(out, "icon.ico"), Buffer.concat([header, ...images]));
console.log("icons written to", out);
