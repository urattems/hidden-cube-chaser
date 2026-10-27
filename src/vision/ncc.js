// Normalised cross-correlation on grayscale Float32Array images, coarse to fine.
// Shared by the vision window and the offline tests (plain script or CommonJS).
(function (root) {
  function toGray(rgba, w, h) {
    let out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4)
      out[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return out;
  }

  function crop(img, w, x, y, cw, ch) {
    let out = new Float32Array(cw * ch);
    for (let r = 0; r < ch; r++) out.set(img.subarray((y + r) * w + x, (y + r) * w + x + cw), r * cw);
    return out;
  }

  // Area-averaging resize, good for the large reductions a minimap frame goes through.
  function resize(img, w, h, nw, nh) {
    let out = new Float32Array(nw * nh);
    let sx = w / nw;
    let sy = h / nh;
    for (let y = 0; y < nh; y++) {
      let y0 = y * sy;
      let y1 = Math.min(h, y0 + sy);
      for (let x = 0; x < nw; x++) {
        let x0 = x * sx;
        let x1 = Math.min(w, x0 + sx);
        let sum = 0;
        let area = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
          let wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
          if (wy <= 0) continue;
          let row = yy * w;
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            let wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
            if (wx <= 0) continue;
            sum += img[row + xx] * wx * wy;
            area += wx * wy;
          }
        }
        out[y * nw + x] = area > 0 ? sum / area : 0;
      }
    }
    return out;
  }

  function half(img, w, h) {
    let nw = w >> 1;
    let nh = h >> 1;
    let out = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        let i = 2 * y * w + 2 * x;
        out[y * nw + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4;
      }
    return { data: out, w: nw, h: nh };
  }

  function integrals(img, w, h) {
    let W = w + 1;
    let s = new Float64Array(W * (h + 1));
    let s2 = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      let row2 = 0;
      for (let x = 0; x < w; x++) {
        let v = img[y * w + x];
        row += v;
        row2 += v * v;
        s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row;
        s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + row2;
      }
    }
    return { s, s2, W };
  }

  function template(img, w, h) {
    let n = w * h;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += img[i];
    mean /= n;
    let zm = new Float32Array(n);
    let norm = 0;
    for (let i = 0; i < n; i++) {
      zm[i] = img[i] - mean;
      norm += zm[i] * zm[i];
    }
    return { zm, w, h, norm: Math.sqrt(norm) };
  }

  function scoreAt(ref, rw, integ, tpl, x, y) {
    let { s, s2, W } = integ;
    let n = tpl.w * tpl.h;
    let a = y * W + x;
    let b = y * W + x + tpl.w;
    let c = (y + tpl.h) * W + x;
    let d = (y + tpl.h) * W + x + tpl.w;
    let sum = s[d] - s[b] - s[c] + s[a];
    let sum2 = s2[d] - s2[b] - s2[c] + s2[a];
    let variance = sum2 - (sum * sum) / n;
    if (variance <= 1e-6 || tpl.norm <= 1e-6) return 0;
    let num = 0;
    let zm = tpl.zm;
    for (let j = 0; j < tpl.h; j++) {
      let r = (y + j) * rw + x;
      let t = j * tpl.w;
      for (let i = 0; i < tpl.w; i++) num += zm[t + i] * ref[r + i];
    }
    return num / (tpl.norm * Math.sqrt(variance));
  }

  // Best top-left of tpl inside ref within [x0, x1] x [y0, y1].
  function searchWindow(ref, rw, rh, integ, tpl, x0, y0, x1, y1) {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(rw - tpl.w, x1);
    y1 = Math.min(rh - tpl.h, y1);
    let best = { x: x0, y: y0, score: -2 };
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        let v = scoreAt(ref, rw, integ, tpl, x, y);
        if (v > best.score) best = { x, y, score: v };
      }
    return best;
  }

  function parabola(a, b, c) {
    let d = a - 2 * b + c;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
  }

  // Locates tpl (w x h) in ref (rw x rh) near the expected top-left (ex, ey), within radius px.
  // Returns sub-pixel { x, y, score } in ref pixels.
  function locate(ref, rw, rh, tplImg, tw, th, ex, ey, radius) {
    let integFull = integrals(ref, rw, rh);
    let tplFull = template(tplImg, tw, th);
    let cx = Math.round(ex);
    let cy = Math.round(ey);
    let r = Math.ceil(radius);
    let best;
    if (r > 6 && tw >= 24 && th >= 24) {
      let rh2 = half(ref, rw, rh);
      let th2 = half(tplImg, tw, th);
      let coarse = searchWindow(
        rh2.data, rh2.w, rh2.h, integrals(rh2.data, rh2.w, rh2.h), template(th2.data, th2.w, th2.h),
        Math.floor((cx - r) / 2), Math.floor((cy - r) / 2), Math.ceil((cx + r) / 2), Math.ceil((cy + r) / 2),
      );
      best = searchWindow(ref, rw, rh, integFull, tplFull, coarse.x * 2 - 2, coarse.y * 2 - 2, coarse.x * 2 + 2, coarse.y * 2 + 2);
    } else {
      best = searchWindow(ref, rw, rh, integFull, tplFull, cx - r, cy - r, cx + r, cy + r);
    }
    let at = (dx, dy) => {
      let x = best.x + dx;
      let y = best.y + dy;
      return x < 0 || y < 0 || x > rw - tw || y > rh - th ? best.score : scoreAt(ref, rw, integFull, tplFull, x, y);
    };
    return {
      x: best.x + parabola(at(-1, 0), best.score, at(1, 0)),
      y: best.y + parabola(at(0, -1), best.score, at(0, 1)),
      score: best.score,
    };
  }

  const api = { toGray, crop, resize, half, integrals, template, scoreAt, searchWindow, locate };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NCC = api;
})(typeof self !== "undefined" ? self : globalThis);
