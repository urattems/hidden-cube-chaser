// Draws the cubes on the game's corner map. Positions arrive in CSS px of this window, which
// covers the corner map exactly; cubes beyond its frame become arrows pinned to the edge.
const COLOURS = { gold: "#f5b91a", red: "#ff5252", spot: "#7dd3fc" };
// Inside of the frame, clear of the opacity sliders on top and the buttons on the right.
const FRAME = { left: 0.03, top: 0.08, right: 0.92, bottom: 0.95 };

let nodes = new Map();

function node(key) {
  let el = nodes.get(key);
  if (el) return el;
  el = document.createElement("div");
  el.className = "marker";
  el.innerHTML =
    '<div class="ring"></div><div class="gem"></div>' +
    '<svg class="arrow" viewBox="-14 -14 28 28"><path d="M12,0 L-8,-9 L-4,0 L-8,9 Z"/></svg>' +
    '<div class="label"></div>';
  document.body.appendChild(el);
  nodes.set(key, el);
  return el;
}

window.markers.onUpdate((list) => {
  let w = innerWidth;
  let h = innerHeight;
  let box = { x0: w * FRAME.left, y0: h * FRAME.top, x1: w * FRAME.right, y1: h * FRAME.bottom };
  let cx = (box.x0 + box.x1) / 2;
  let cy = (box.y0 + box.y1) / 2;
  let seen = new Set();
  for (let m of list) {
    let spot = m.kind === "spot";
    let inside = m.x >= box.x0 && m.x <= box.x1 && m.y >= box.y0 && m.y <= box.y1;
    // Of the candidate spots off the map, only the nearest one left to check gets an edge arrow.
    if (spot && !inside && !m.nearest) continue;
    seen.add(m.key);
    let el = node(m.key);
    el.classList.toggle("spot", spot);
    el.classList.toggle("checked", !!m.checked);
    let x = m.x;
    let y = m.y;
    if (!inside) {
      // Where the line from the frame's centre to the cube leaves the frame.
      let dx = m.x - cx;
      let dy = m.y - cy;
      let t = Math.min(Math.abs((dx > 0 ? box.x1 - cx : box.x0 - cx) / dx || Infinity), Math.abs((dy > 0 ? box.y1 - cy : box.y0 - cy) / dy || Infinity));
      x = cx + dx * t;
      y = cy + dy * t;
      el.querySelector(".arrow").style.transform = `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI}deg)`;
    }
    el.classList.toggle("edge", !inside);
    el.classList.toggle("taken", !!m.taken);
    el.style.setProperty("--c", spot ? COLOURS.spot : (COLOURS[m.look] ?? COLOURS.gold));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    let label = el.querySelector(".label");
    let name = spot ? "?" : `${m.n}`;
    label.textContent = inside ? name : `${name} · ${Math.round(m.distance)} m`;
    // Keep the label inside the window near the right and top edges.
    label.style.left = x > w - 90 ? "-70px" : "12px";
    label.style.top = y < 30 ? "8px" : "-24px";
  }
  for (let [key, el] of nodes)
    if (!seen.has(key)) {
      el.remove();
      nodes.delete(key);
    }
});
