// Small dependency-free SVG charts for the dashboard.

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Z-score line chart with horizontal bands.
 * series: [{t, z}] ; bands: [{y, color, dash, label}] ; markers: [{t, color, label}]
 */
export function zChart(container, series, { bands = [], markers = [], height = 260, fmtTime } = {}) {
  container.innerHTML = "";
  const W = 900, H = height, pad = { l: 40, r: 12, t: 10, b: 22 };
  const pts = series.filter((p) => Number.isFinite(p.z));
  if (pts.length < 2) { container.innerHTML = '<div class="hint">Not enough data yet.</div>'; return; }
  const zs = pts.map((p) => p.z).concat(bands.map((b) => b.y));
  const lim = Math.min(8, Math.max(3, ...zs.map(Math.abs))) * 1.08;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (z) => pad.t + (1 - (z + lim) / (2 * lim)) * (H - pad.t - pad.b);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "spread z-score chart" });

  for (let g = -Math.floor(lim); g <= Math.floor(lim); g++) {
    svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(g), y2: y(g), stroke: css("--line"), "stroke-width": g === 0 ? 1.2 : 0.6 }));
    const lbl = el("text", { x: pad.l - 6, y: y(g) + 3, "text-anchor": "end", "font-size": 10, fill: css("--faint"), "font-family": "JetBrains Mono" });
    lbl.textContent = (g > 0 ? "+" : "") + g;
    svg.appendChild(lbl);
  }
  for (const b of bands) {
    svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(b.y), y2: y(b.y), stroke: b.color, "stroke-width": 1, "stroke-dasharray": b.dash || "4 4", opacity: 0.8 }));
  }
  // Colour the line by side of the mean.
  let d = "";
  pts.forEach((p, i) => { d += `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.z).toFixed(1)}`; });
  svg.appendChild(el("path", { d, fill: "none", stroke: css("--text"), "stroke-width": 1.3, opacity: 0.9 }));
  for (const m of markers) {
    if (m.t < t0 || m.t > t1) continue;
    svg.appendChild(el("line", { x1: x(m.t), x2: x(m.t), y1: pad.t, y2: H - pad.b, stroke: m.color, "stroke-width": 1, opacity: 0.7 }));
  }
  const last = pts[pts.length - 1];
  svg.appendChild(el("circle", { cx: x(last.t), cy: y(last.z), r: 4, fill: last.z < 0 ? css("--long") : css("--short") }));
  // Time labels
  for (let k = 0; k <= 4; k++) {
    const t = t0 + (k / 4) * (t1 - t0);
    const lbl = el("text", { x: x(t), y: H - 6, "text-anchor": k === 0 ? "start" : k === 4 ? "end" : "middle", "font-size": 10, fill: css("--faint"), "font-family": "JetBrains Mono" });
    lbl.textContent = fmtTime ? fmtTime(t) : new Date(t).toISOString().slice(5, 16).replace("T", " ");
    svg.appendChild(lbl);
  }
  container.appendChild(svg);

  // Hover tooltip
  const tip = document.createElement("div");
  tip.className = "tip mono";
  container.appendChild(tip);
  const cross = el("line", { y1: pad.t, y2: H - pad.b, stroke: css("--muted"), "stroke-width": 0.8, opacity: 0 });
  svg.appendChild(cross);
  svg.addEventListener("mousemove", (ev) => {
    const r = svg.getBoundingClientRect();
    const tx = t0 + ((((ev.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - tx) < Math.abs(best.t - tx)) best = p;
    cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("opacity", 1);
    tip.textContent = `${new Date(best.t).toISOString().slice(0, 16).replace("T", " ")} UTC · z ${best.z.toFixed(2)}`;
    tip.style.left = Math.min(r.width - 170, Math.max(0, ev.clientX - r.left + 10)) + "px";
    tip.style.top = "6px";
    tip.style.opacity = 1;
  });
  svg.addEventListener("mouseleave", () => { tip.style.opacity = 0; cross.setAttribute("opacity", 0); });
}

/** Horizontal heat ladder for one leg: liquidation bins, stop levels, current price, our stop price. */
export function heatLadder(container, title, liq, { stops = [], depth = null, ourStop = null, fmt = (v) => v.toPrecision(5) } = {}) {
  container.innerHTML = "";
  const head = document.createElement("div");
  head.className = "mono";
  head.style.cssText = "font-size:12px;font-weight:700;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px";
  const t1 = document.createElement("span");
  t1.textContent = title;
  const t2 = document.createElement("span");
  t2.className = "muted";
  t2.style.fontWeight = "400";
  t2.textContent = liq ? fmt(liq.price) : "";
  head.append(t1, t2);
  container.appendChild(head);
  if (!liq) { const n = document.createElement("div"); n.className = "hint"; n.textContent = "no data"; container.appendChild(n); return; }
  const W = 600, rowH = 2.6, H = liq.bins.length * rowH + 4;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title} liquidation heat` });
  const lo = liq.bins[0].lo, hi = liq.bins[liq.bins.length - 1].hi;
  const y = (px) => 2 + (1 - (px - lo) / (hi - lo)) * (H - 4);
  const max = Math.max(...liq.bins.map((b) => Math.max(b.longLiq, b.shortLiq))) || 1;
  for (const b of liq.bins) {
    const v = Math.max(b.longLiq, b.shortLiq) / max;
    if (v < 0.02) continue;
    const isLong = b.longLiq >= b.shortLiq;
    svg.appendChild(el("rect", { x: 40, y: y(b.hi), width: (W - 150) * v, height: Math.max(1, y(b.lo) - y(b.hi) - 0.5), fill: isLong ? css("--bad") : css("--good"), opacity: 0.25 + 0.7 * v }));
  }
  for (const s of stops) {
    if (s.px < lo || s.px > hi) continue;
    svg.appendChild(el("line", { x1: 40, x2: W - 90, y1: y(s.px), y2: y(s.px), stroke: css("--muted"), "stroke-dasharray": "2 3", "stroke-width": 0.8 }));
  }
  svg.appendChild(el("line", { x1: 0, x2: W, y1: y(liq.price), y2: y(liq.price), stroke: css("--text"), "stroke-width": 1.2 }));
  const pl = el("text", { x: W - 2, y: y(liq.price) - 3, "text-anchor": "end", "font-size": 10, fill: css("--text"), "font-family": "JetBrains Mono" });
  pl.textContent = "now";
  svg.appendChild(pl);
  if (ourStop && ourStop > lo && ourStop < hi) {
    svg.appendChild(el("line", { x1: 0, x2: W, y1: y(ourStop), y2: y(ourStop), stroke: css("--warn"), "stroke-width": 1.2, "stroke-dasharray": "6 3" }));
    const sl = el("text", { x: W - 2, y: y(ourStop) - 3, "text-anchor": "end", "font-size": 10, fill: css("--warn"), "font-family": "JetBrains Mono" });
    sl.textContent = "stop≈";
    svg.appendChild(sl);
  }
  for (const pct of [-0.1, -0.05, 0.05, 0.1]) {
    const px = liq.price * (1 + pct);
    if (px < lo || px > hi) continue;
    const t = el("text", { x: 2, y: y(px) + 3, "font-size": 9, fill: css("--faint"), "font-family": "JetBrains Mono" });
    t.textContent = (pct > 0 ? "+" : "") + pct * 100 + "%";
    svg.appendChild(t);
  }
  container.appendChild(svg);
  const usd = (v) => (v >= 1e9 ? (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : (v / 1e3).toFixed(0) + "k");
  const info = document.createElement("div");
  info.className = "hint mono";
  info.style.cssText = "font-size:11px;margin-top:4px;line-height:1.5";
  info.innerHTML = [
    liq.clusterAbove ? `<span class="ok-c">▲</span> short liqs ≈ ${fmt(liq.clusterAbove.px)} (${(((liq.clusterAbove.px / liq.price) - 1) * 100).toFixed(1)}%)` : "",
    liq.clusterBelow ? `<span class="bad-c">▼</span> long liqs ≈ ${fmt(liq.clusterBelow.px)} (${(((liq.clusterBelow.px / liq.price) - 1) * 100).toFixed(1)}%)` : "",
    depth ? `book ±1%: bids $${usd(depth.bidUsd)} / asks $${usd(depth.askUsd)} · spread ${depth.spreadBps.toFixed(1)}bp` : "",
  ].filter(Boolean).join("<br>");
  container.appendChild(info);
}
