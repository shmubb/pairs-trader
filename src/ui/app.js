// Dashboard. Pulls Hyperliquid data in the browser and runs the same model,
// strategy and sizing code as the engine and backtester (src/core). Read-only:
// it never holds keys and cannot trade. If the engine is running locally
// (node bin/engine.js) its live state is shown too.

import { PairModel } from "../core/model.js";
import { PairStrategy, mergeConfig, roundTripCost, expectedHoldBars } from "../core/strategy.js";
import { planPosition } from "../core/risk.js";
import { sessionCheck, sessionsAt, nextEvents } from "../core/sessions.js";
import { scaleConfig, barMs } from "../core/timeframe.js";
import { liquidationMap, stopLevels, bookDepth } from "../core/liquidity.js";
import { HyperliquidInfo, marketsFor, loadPairHL } from "../data/hyperliquid.js";
import { zChart, heatLadder } from "./charts.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fx = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const sgn = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "—");
const usd = (v) => (Number.isFinite(v) ? "$" + Math.round(v).toLocaleString() : "—");
const store = {
  get(k, d) { try { const v = localStorage.getItem("pt2:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pt2:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const S = {
  baseCfg: null, cfg: null, universe: [], shortlist: [], interval: store.get("interval", "1h"),
  pair: null, markets: {}, snaps: [], model: null, mids: {}, heat: {}, books: {}, scan: {}, engine: null,
  alerts: { sound: store.get("alSound", false), push: store.get("alPush", false) }, lastActions: {},
};
const info = new HyperliquidInfo({ weightPerMinute: 700 });

// --------------------------------------------------------------------------- boot
async function boot() {
  const [cfg, uni, short] = await Promise.all([
    fetch("config/default.json").then((r) => r.json()),
    fetch("config/universe.json").then((r) => r.json()),
    fetch("config/shortlist.json").then((r) => r.json()).catch(() => ({ pairs: [{ a: "ETH", b: "BTC" }] })),
  ]);
  S.baseCfg = cfg;
  S.universe = uni.assets;
  S.shortlist = short.pairs;
  const sel = $("pair-select");
  for (const p of S.shortlist) {
    const o = document.createElement("option");
    o.value = `${p.a}/${p.b}`;
    o.textContent = `${p.a} / ${p.b}`;
    sel.appendChild(o);
  }
  sel.value = store.get("pair", sel.options[0].value);
  sel.addEventListener("change", () => selectPair(sel.value));
  $("pair-custom").addEventListener("keydown", (e) => { if (e.key === "Enter") selectPair(e.target.value.trim().toUpperCase().replace(/\s+/g, "")); });
  for (const b of $("interval-seg").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.v === S.interval);
    b.addEventListener("click", () => { S.interval = b.dataset.v; store.set("interval", S.interval); for (const x of $("interval-seg").querySelectorAll("button")) x.classList.toggle("on", x === b); selectPair(S.pair.id); });
  }
  for (const id of ["r-equity", "r-risk", "r-lev"]) {
    $(id).value = store.get(id, $(id).value);
    $(id).addEventListener("input", () => { store.set(id, $(id).value); renderTicket(); });
  }
  $("wallet").value = store.get("wallet", "");
  $("wallet-go").addEventListener("click", loadPositions);
  setupAlerts();
  setInterval(() => { $("clock").textContent = new Date().toISOString().slice(11, 19) + " UTC"; }, 1000);

  await selectPair(sel.value);
  renderScan();
  scanNext();
  setInterval(pollMids, 5000);
  setInterval(checkNewBar, 30_000);
  setInterval(refreshBooks, 30_000);
  setInterval(scanNext, 15_000);
  setInterval(pollEngine, 5000);
  setInterval(() => { if (store.get("wallet", "")) loadPositions(); }, 30_000);
  pollEngine();
  if (store.get("wallet", "")) loadPositions();
}

function resolve(id) {
  const u = S.universe.find((x) => x.id === id || x.hl === id);
  return u ? { id: u.id, hl: u.hl } : { id, hl: id };
}

function parsePair(str) {
  const [a, b] = String(str).split("/");
  if (!a || !b) return null;
  const A = resolve(a), B = resolve(b);
  return { id: `${A.id}/${B.id}`, a: A.id, b: B.id, hlA: A.hl, hlB: B.hl };
}

function cfgFor(interval) {
  return scaleConfig(S.baseCfg, interval);
}

// --------------------------------------------------------------------------- data
async function selectPair(str) {
  const p = parsePair(str);
  if (!p) return;
  S.pair = p;
  store.set("pair", p.id);
  if ([...$("pair-select").options].some((o) => o.value === p.id)) $("pair-select").value = p.id;
  document.title = `${p.a}/${p.b} · Pairs Trader`;
  setStatus("warn", `loading ${p.id}…`);
  S.cfg = cfgFor(S.interval);
  try {
    S.markets = { ...S.markets, ...(await marketsFor(info, [p.hlA, p.hlB])) };
    if (!S.markets[p.hlA] || !S.markets[p.hlB]) throw new Error(`no Hyperliquid perp for ${!S.markets[p.hlA] ? p.hlA : p.hlB}`);
    const step = barMs(S.interval);
    const need = S.cfg.model.longFormationBars + 150;
    const now = Date.now();
    const bars = await loadPairHL(info, p.hlA, p.hlB, S.interval, now - need * step, now);
    const closed = bars.filter((b) => b.t + step <= now);
    S.model = new PairModel(S.cfg.model);
    S.snaps = closed.map((b) => S.model.update(b));
    S.lastBarT = closed.length ? closed[closed.length - 1].t : 0;
    S.lastBar = closed[closed.length - 1];
    setStatus(closed.length >= S.cfg.model.formationBars ? "ok" : "warn", `${closed.length} ${S.interval} bars · ${new Date().toISOString().slice(11, 16)} UTC`);
    await Promise.all([loadHeat(p), refreshBooks(), pollMids()]);
  } catch (e) {
    setStatus("bad", e.message);
    $("action-reasons").textContent = `Could not load data: ${e.message}`;
    return;
  }
  render();
}

async function loadHeat(p) {
  const now = Date.now();
  const [a, b] = await Promise.all([info.candles(p.hlA, "1h", now - 30 * 864e5, now), info.candles(p.hlB, "1h", now - 30 * 864e5, now)]);
  S.heat = { [p.hlA]: a, [p.hlB]: b };
}

async function refreshBooks() {
  if (!S.pair) return;
  try {
    const [a, b] = await Promise.all([info.l2Book(S.pair.hlA), info.l2Book(S.pair.hlB)]);
    S.books = { [S.pair.hlA]: bookDepth(a), [S.pair.hlB]: bookDepth(b) };
    renderHeat();
  } catch { /* book is optional */ }
}

async function pollMids() {
  try {
    const dexes = [...new Set([S.pair?.hlA, S.pair?.hlB].map((c) => (c && c.includes(":") ? c.split(":")[0] : undefined)))];
    for (const d of dexes) { const m = await info.allMids(d); for (const [k, v] of Object.entries(m)) S.mids[k] = +v; }
    renderLive();
  } catch { setStatus("warn", "mids unavailable, retrying"); }
}

async function checkNewBar() {
  if (!S.pair || !S.model) return;
  const step = barMs(S.interval), now = Date.now();
  if (now < S.lastBarT + 2 * step + 5000) return;
  try {
    const bars = await loadPairHL(info, S.pair.hlA, S.pair.hlB, S.interval, S.lastBarT + step, now);
    const fresh = bars.filter((b) => b.t > S.lastBarT && b.t + step <= now);
    for (const b of fresh) { S.snaps.push(S.model.update(b)); S.lastBarT = b.t; S.lastBar = b; }
    if (fresh.length) { setStatus("ok", `updated ${new Date().toISOString().slice(11, 16)} UTC`); render(); }
  } catch (e) { setStatus("warn", e.message); }
}

function setStatus(kind, text) {
  $("data-led").className = "led " + kind;
  $("data-status").textContent = text;
}

// --------------------------------------------------------------------------- evaluation
function evaluate(snap, pair, cfg) {
  const st = new PairStrategy(cfg);
  const fA = S.markets[pair.hlA]?.funding ?? 0, fB = S.markets[pair.hlB]?.funding ?? 0;
  const barH = barMs(S.interval) / 3600_000;
  const ctx = { bar: 1e9, session: sessionCheck(Date.now(), cfg.sessions), canOpen: { ok: true }, carryPerBar: (-fA + Math.abs(snap.beta ?? 1) * fB) * barH };
  const d = snap.ready ? st.onBar(snap, ctx) : { action: "WAIT", reasons: ["warming up"], gates: null };
  return { d, ctx };
}

function engineFor(pairId) {
  return S.engine?.pairs?.find((p) => p.id === pairId) || null;
}

// --------------------------------------------------------------------------- render
function render() {
  const snap = S.snaps[S.snaps.length - 1];
  if (!snap) return;
  const { d, ctx } = evaluate(snap, S.pair, S.cfg);
  S.diag = d; S.ctx = ctx;
  const eng = engineFor(S.pair.id);
  const show = eng?.diag ? { ...d, ...eng.diag } : d;
  renderAction(snap, show, eng);
  renderChart(eng);
  renderGates(show.gates || d.gates);
  renderRegime(snap);
  renderFunding(snap);
  renderSessions();
  renderTicket();
  renderHeat();
  maybeAlert(S.pair.id, show.action);
}

const BADGE = { ENTER: ["ENTER", "b-enter"], ADD: ["ADD", "b-enter"], WAIT: ["WAIT", "b-wait"], NO_TRADE: ["NO TRADE", "b-notrade"], HOLD: ["HOLDING", "b-hold"], TAKE_PROFIT: ["TAKE PROFIT", "b-exit"], STOP: ["STOP", "b-exit"], TIME_STOP: ["TIME STOP", "b-exit"], BREAK: ["EXIT: BREAK", "b-exit"], FUNDING: ["EXIT: FUNDING", "b-exit"] };

function directionText(z, beta) {
  const { a, b } = S.pair;
  return z < 0
    ? `<span style="color:var(--long)">Long ${esc(a)}</span> / Short ${esc(b)} ×${fx(Math.abs(beta), 2)}`
    : `<span style="color:var(--short)">Short ${esc(a)}</span> / Long ${esc(b)} ×${fx(Math.abs(beta), 2)}`;
}

function renderAction(snap, d, eng) {
  const [label, cls] = BADGE[d.action] || [d.action, "b-wait"];
  const badge = $("action-badge");
  badge.textContent = (eng ? "ENGINE · " : "") + label;
  badge.className = "badge " + cls;
  const dirZ = eng?.pos ? -eng.pos.dir : snap.z;
  $("action-direction").innerHTML = snap.ready ? (eng?.pos ? "In position: " : Math.abs(snap.z) >= S.cfg.entry.z ? "" : "If it triggers: ") + directionText(dirZ, snap.beta) : "Warming up";
  $("action-reasons").innerHTML = (d.reasons || []).slice(0, 6).map(esc).join("<br>");
  renderLive();
}

function liveZ() {
  const snap = S.snaps[S.snaps.length - 1];
  const pa = S.mids[S.pair?.hlA], pb = S.mids[S.pair?.hlB];
  if (!snap?.ready || !pa || !pb) return null;
  return (Math.log(pa) - snap.beta * Math.log(pb) - snap.mu) / snap.sigmaEq;
}

function renderLive() {
  const snap = S.snaps[S.snaps.length - 1];
  const z = liveZ();
  const el = $("z-live");
  el.textContent = z == null ? "—" : sgn(z);
  el.style.color = z == null ? "" : Math.abs(z) >= S.cfg.entry.z ? (z < 0 ? "var(--long)" : "var(--short)") : "var(--text)";
  $("z-sub").textContent = `live z · last ${S.interval} bar ${snap?.ready ? sgn(snap.z) : "—"}`;
}

function renderChart(eng) {
  const c = S.cfg;
  const keep = S.interval === "15m" ? 96 * 10 : 24 * 30;
  const series = S.snaps.slice(-keep).map((s) => ({ t: s.t, z: s.z }));
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const bands = [
    { y: c.entry.z, color: css("--short") }, { y: -c.entry.z, color: css("--long") },
    { y: c.exit.stopZ, color: css("--bad"), dash: "6 3" }, { y: -c.exit.stopZ, color: css("--bad"), dash: "6 3" },
    { y: c.exit.z, color: css("--good"), dash: "2 3" }, { y: -c.exit.z, color: css("--good"), dash: "2 3" },
  ];
  if (c.ladder.enabled) for (const l of c.ladder.levels.slice(1)) { bands.push({ y: c.entry.z + l.z, color: css("--faint"), dash: "1 4" }, { y: -(c.entry.z + l.z), color: css("--faint"), dash: "1 4" }); }
  const markers = eng?.pos ? [{ t: eng.pos.openedT, color: css("--info") }] : [];
  zChart($("z-chart"), series, { bands, markers });
  $("z-legend").innerHTML = `<span><i style="background:var(--long)"></i>entry ±${c.entry.z} (long spread below)</span><span><i style="background:var(--faint)"></i>scale-in levels</span><span><i style="background:var(--bad)"></i>stop ±${c.exit.stopZ}</span><span><i style="background:var(--good)"></i>target ${c.exit.z}</span>`;
}

function renderGates(g) {
  const box = $("gates");
  if (!g) { box.innerHTML = '<div class="hint">warming up</div>'; return; }
  const pass = g.checks.filter((c) => c.ok).length;
  $("gates-sub").textContent = `${pass}/${g.checks.length} pass`;
  const fmtLim = (l) => (Array.isArray(l) ? `${l[0]}–${l[1]}` : l == null ? "" : String(l));
  box.innerHTML = g.checks.map((c) => `<div class="gate" title="${esc(c.why)}"><span class="${c.ok ? "ok-c" : "bad-c"}">${c.ok ? "✓" : "✗"}</span><span>${esc(c.name)}</span><span class="val">${esc(typeof c.value === "number" ? fx(c.value, Math.abs(c.value) < 1 ? 3 : 1) : c.value)} <span class="muted">/ ${esc(fmtLim(c.limit))}</span></span></div>`).join("");
}

function kv(items) {
  return items.map(([k, v, s, cls]) => `<div><div class="k">${esc(k)}</div><div class="v ${cls || ""}">${esc(v)}</div>${s ? `<div class="s">${esc(s)}</div>` : ""}</div>`).join("");
}

function renderRegime(s) {
  if (!s.ready) { $("regime").innerHTML = kv([["status", "warming up", `${s.bars} bars`]]); return; }
  const barH = barMs(S.interval) / 3600_000;
  const c = S.cfg.gates;
  $("regime").innerHTML = kv([
    ["half-life", `${fx(s.halfLife * barH, 0)}h`, "expected time to close half the gap", s.halfLife <= c.maxHalfLifeBars ? "ok-c" : "bad-c"],
    ["cointegration p", fx(s.cointP, 3), `ADF ${fx(s.adfStat, 2)}`, s.cointP <= c.maxCointP ? "ok-c" : "bad-c"],
    ["hedge ratio β", fx(s.beta, 3), `drift ${fx((s.betaDrift || 0) * 100, 1)}% since last fit`],
    ["Hurst", fx(s.hurst, 2), "< 0.5 reverts, > 0.5 trends", s.hurst <= c.maxHurst ? "ok-c" : "bad-c"],
    ["correlation", fx(s.corr, 2), `recent ${fx(s.corrShort, 2)}`],
    ["spread vol vs normal", fx(s.volRatio, 2) + "×", "short-term σ / formation σ", s.volRatio <= c.maxVolRatio ? "" : "bad-c"],
    ["1σ of spread", fx(s.sigmaEq * 100, 2) + "%", "move per z unit"],
    ["long-window z", sgn(s.zLong), "3× longer formation"],
    ["leg impulse", `${sgn(s.legMoveA, 1)} / ${sgn(s.legMoveB, 1)}σ`, `${S.pair.a} / ${S.pair.b}, last ${S.cfg.model.legMoveBars} bars`],
    ["volume vs avg", `${fx(s.rvA, 1)}× / ${fx(s.rvB, 1)}×`, "last bar, both legs"],
  ]);
}

function renderFunding(s) {
  const mA = S.markets[S.pair.hlA], mB = S.markets[S.pair.hlB];
  if (!mA || !mB) return;
  const beta = Math.abs(s.beta || 1);
  const carryLongDay = (-mA.funding + beta * mB.funding) * 24; // per $1 of leg A, long spread
  $("funding").innerHTML = kv([
    [`${S.pair.a} funding`, `${fx(mA.funding * 1e4, 3)} bp/h`, `${fx(mA.funding * 24 * 365 * 100, 1)}% APR (longs pay +)`],
    [`${S.pair.b} funding`, `${fx(mB.funding * 1e4, 3)} bp/h`, `${fx(mB.funding * 24 * 365 * 100, 1)}% APR`],
    ["carry: long spread", `${sgn(carryLongDay * 1e4, 2)} bp/day`, `long ${S.pair.a} / short ${S.pair.b}`, carryLongDay >= 0 ? "ok-c" : "warn-c"],
    ["carry: short spread", `${sgn(-carryLongDay * 1e4, 2)} bp/day`, `short ${S.pair.a} / long ${S.pair.b}`, carryLongDay <= 0 ? "ok-c" : "warn-c"],
  ]);
}

function renderSessions() {
  const now = Date.now();
  const sc = sessionCheck(now, S.cfg.sessions);
  const open = sessionsAt(now);
  const ev = nextEvents(now, 5);
  const fmtIn = (t) => { const h = (t - now) / 3600_000; return h < 0 ? "now" : h < 48 ? `in ${h.toFixed(1)}h` : `in ${(h / 24).toFixed(0)}d`; };
  $("sessions").innerHTML =
    `<div class="hint" style="margin-bottom:8px">Open now: <b>${esc(open.join(" + ") || "between sessions")}</b>${[0, 6].includes(new Date().getUTCDay()) ? " · weekend (thinner books)" : ""}</div>` +
    (sc.ok ? "" : `<div class="warnbox" style="margin-bottom:8px">Entry blackout: ${esc(sc.reason)}</div>`) +
    `<table><tbody>${ev.map((e) => `<tr><td>${esc(e.type)}</td><td>${new Date(e.t).toISOString().slice(5, 16).replace("T", " ")} UTC</td><td class="muted">${fmtIn(e.t)}</td></tr>`).join("") || '<tr><td class="muted">no scheduled events loaded</td></tr>'}</tbody></table>`;
}

function renderTicket() {
  const snap = S.snaps[S.snaps.length - 1];
  const box = $("ticket");
  if (!snap?.ready) { box.innerHTML = '<div class="hint">warming up</div>'; return; }
  const c = S.cfg;
  const equity = +$("r-equity").value || 0;
  const risk = { ...c.risk, riskPerTrade: (+$("r-risk").value || 1) / 100, maxGrossLeverage: +$("r-lev").value || 3 };
  const triggered = Math.abs(snap.z) >= c.entry.z;
  const z = triggered ? snap.z : (snap.z < 0 ? -1 : 1) * c.entry.z;
  const s = { ...snap, z };
  const mA = S.markets[S.pair.hlA], mB = S.markets[S.pair.hlB];
  const plan = planPosition(s, c, risk, { equity }, { volA24h: mA?.dayNtlVlm, volB24h: mB?.dayNtlVlm });
  const barH = barMs(S.interval) / 3600_000;
  const dir = z < 0 ? 1 : -1;
  const pa = S.mids[S.pair.hlA] || snap.pa, pb = S.mids[S.pair.hlB] || snap.pb;
  const cost = roundTripCost(snap.beta, c.costs);
  const gross = (Math.abs(z) - c.exit.z) * snap.sigmaEq;
  const hold = expectedHoldBars(Math.abs(z), c.exit.z, snap.halfLife) * barH;
  const timeStop = Math.min(c.exit.maxHoldBars, Math.max(c.exit.minTimeStopBars, c.exit.timeStopHalfLives * snap.halfLife)) * barH;
  const carryDay = (-(mA?.funding || 0) + Math.abs(snap.beta) * (mB?.funding || 0)) * 24 * dir;
  if (!plan.ok) { box.innerHTML = `<div class="warnbox">${esc(plan.reason)}</div>`; return; }
  const side = (usdAmt) => (usdAmt > 0 ? '<span class="ok-c">BUY</span>' : '<span class="bad-c">SELL</span>');
  const rows = plan.tranches.map((t, i) => {
    const aUsd = dir * t.notionalA, bUsd = -dir * t.notionalB;
    return `<tr><td>#${i + 1} at |z| ${fx(t.atAbsZ, 2)}</td><td>${side(aUsd)} ${esc(S.pair.a)} ${usd(Math.abs(aUsd))}<div class="muted">${fx(Math.abs(aUsd) / pa, 4)}</div></td><td>${side(bUsd)} ${esc(S.pair.b)} ${usd(Math.abs(bUsd))}<div class="muted">${fx(Math.abs(bUsd) / pb, 4)}</div></td></tr>`;
  }).join("");
  box.innerHTML =
    (triggered ? "" : `<div class="hint" style="margin-bottom:8px">Not triggered — showing the ticket if |z| reaches ${c.entry.z}.</div>`) +
    `<table><thead><tr><th>TRANCHE</th><th>LEG A</th><th>LEG B</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="kv" style="margin-top:10px">${kv([
      ["max loss (all tranches, stop)", usd(plan.maxLoss), `${fx((plan.maxLoss / equity) * 100, 2)}% of account`, "bad-c"],
      ["stop", `|z| ${c.exit.stopZ}`, `≈ ${fx(plan.stopDistanceSigma * snap.sigmaEq * 100, 2)}% spread move vs avg entry`],
      ["target", `z ${c.exit.z}`, `first tranche nets ≈ ${usd(plan.expectedProfit)}`, "ok-c"],
      ["time stop", `${fx(timeStop, 0)}h`, `expected hold ≈ ${fx(hold, 0)}h`],
      ["edge / cost", `${fx(gross / cost, 1)}×`, `${fx(gross * 100, 2)}% vs ${fx(cost * 100, 2)}% fees+slip`, gross / cost >= c.entry.minEdgeCostRatio ? "ok-c" : "warn-c"],
      ["funding carry", `${sgn(carryDay * plan.notionalA, 2)} $/day`, carryDay >= 0 ? "paid to hold" : "costs to hold"],
      ["gross exposure", usd(plan.gross), `${fx(plan.gross / (equity || 1), 2)}× account${plan.limits.length ? " · capped: " + plan.limits.join(", ") : ""}`],
    ])}</div>` +
    `<div class="row" style="margin-top:10px"><button class="btn" id="copy-ticket">Copy ticket</button></div>`;
  $("copy-ticket").onclick = () => {
    const lines = [`${S.pair.id} ${dir > 0 ? "LONG" : "SHORT"} spread · β ${fx(snap.beta, 3)} · entry |z| ${fx(Math.abs(z), 2)}`,
      ...plan.tranches.map((t, i) => `#${i + 1} @|z| ${fx(t.atAbsZ, 2)}: ${dir > 0 ? "BUY" : "SELL"} ${S.pair.a} $${Math.round(t.notionalA)} / ${dir > 0 ? "SELL" : "BUY"} ${S.pair.b} $${Math.round(t.notionalB)}`),
      `stop |z| ${c.exit.stopZ} (max loss $${Math.round(plan.maxLoss)}) · target z ${c.exit.z} · time stop ${fx(timeStop, 0)}h`];
    navigator.clipboard?.writeText(lines.join("\n"));
  };
}

function renderHeat() {
  if (!S.pair) return;
  const snap = S.snaps[S.snaps.length - 1];
  const eng = engineFor(S.pair.id);
  // Leg price at which the spread stop would fire, holding the other leg still.
  let stopA = null, stopB = null;
  if (snap?.ready) {
    const pos = eng?.pos;
    const e = pos ? pos.entry : { beta: snap.beta, mu: snap.mu, sigmaEq: snap.sigmaEq };
    const dir = pos ? pos.dir : snap.z < 0 ? 1 : -1;
    const sStop = e.mu - dir * S.cfg.exit.stopZ * e.sigmaEq;
    const pa = S.mids[S.pair.hlA] || snap.pa, pb = S.mids[S.pair.hlB] || snap.pb;
    stopA = Math.exp(sStop + e.beta * Math.log(pb));
    stopB = Math.exp((Math.log(pa) - sStop) / e.beta);
  }
  for (const [box, coin, stop] of [[$("heat-a"), S.pair.hlA, stopA], [$("heat-b"), S.pair.hlB, stopB]]) {
    const candles = S.heat[coin];
    const liq = candles?.length ? liquidationMap(candles) : null;
    heatLadder(box, coin, liq, { stops: candles ? stopLevels(candles) : [], depth: S.books[coin], ourStop: stop });
  }
}

// --------------------------------------------------------------------------- scanner
let scanIdx = 0;
async function scanNext() {
  if (!S.shortlist.length || !S.baseCfg) return;
  const p = parsePair(`${S.shortlist[scanIdx % S.shortlist.length].a}/${S.shortlist[scanIdx % S.shortlist.length].b}`);
  scanIdx++;
  try {
    const cfg = cfgFor("1h");
    S.markets = { ...S.markets, ...(await marketsFor(info, [p.hlA, p.hlB])) };
    const now = Date.now();
    const bars = (await loadPairHL(info, p.hlA, p.hlB, "1h", now - (cfg.model.longFormationBars + 100) * 3600_000, now, { funding: false })).filter((b) => b.t + 3600_000 <= now);
    const m = new PairModel(cfg.model);
    let snap = null;
    for (const b of bars) snap = m.update(b);
    if (!snap) return;
    const { d } = evaluate(snap, p, cfg);
    S.scan[p.id] = { snap, d, t: now };
    maybeAlert(p.id, d.action);
  } catch (e) { S.scan[p.id] = { error: e.message, t: Date.now() }; }
  renderScan();
}

function renderScan() {
  const tb = $("scan-table").querySelector("tbody");
  tb.innerHTML = S.shortlist.map((sp) => {
    const p = parsePair(`${sp.a}/${sp.b}`);
    const r = S.scan[p.id];
    if (!r) return `<tr class="click" data-p="${esc(p.id)}"><td>${esc(p.id)}</td><td colspan="6" class="muted">queued…</td></tr>`;
    if (r.error) return `<tr class="click" data-p="${esc(p.id)}"><td>${esc(p.id)}</td><td colspan="6" class="bad-c">${esc(r.error)}</td></tr>`;
    const s = r.snap, [lab] = BADGE[r.d.action] || [r.d.action];
    const zc = Math.abs(s.z) >= S.baseCfg.entry.z ? (s.z < 0 ? "var(--long)" : "var(--short)") : "";
    return `<tr class="click" data-p="${esc(p.id)}"><td>${esc(p.id)}</td><td style="color:${zc}">${sgn(s.z)}</td><td>${esc(lab)}</td><td>${fx(s.halfLife, 0)}h</td><td class="${s.cointP <= S.baseCfg.gates.maxCointP ? "ok-c" : "muted"}">${fx(s.cointP, 3)}</td><td>${fx(s.corr, 2)}</td><td>${r.d.edge ? fx(r.d.edge.ratio, 1) + "×" : "—"}</td></tr>`;
  }).join("");
  for (const tr of tb.querySelectorAll("tr.click")) tr.onclick = () => selectPair(tr.dataset.p);
}

// --------------------------------------------------------------------------- positions & engine
async function loadPositions() {
  const addr = $("wallet").value.trim();
  store.set("wallet", addr);
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { $("positions").textContent = "Enter a 0x… address (42 characters)."; return; }
  try {
    const st = await info.clearinghouseState(addr);
    const ps = (st.assetPositions || []).map((x) => x.position);
    const acct = +st.marginSummary.accountValue;
    $("positions").innerHTML = `<div class="hint" style="margin-bottom:6px">Account value ${usd(acct)} · margin used ${usd(+st.marginSummary.totalMarginUsed)}</div>` +
      (ps.length ? `<div class="scroll-x"><table><thead><tr><th>COIN</th><th>SIZE</th><th>ENTRY</th><th>uPnL</th><th>LIQ</th></tr></thead><tbody>${ps.map((p) => {
        const mid = S.mids[p.coin];
        const dist = p.liquidationPx && mid ? Math.abs(+p.liquidationPx / mid - 1) * 100 : null;
        return `<tr><td>${esc(p.coin)}</td><td class="${+p.szi > 0 ? "ok-c" : "bad-c"}">${esc(p.szi)}</td><td>${esc(p.entryPx)}</td><td class="${+p.unrealizedPnl >= 0 ? "ok-c" : "bad-c"}">${fx(+p.unrealizedPnl, 2)}</td><td>${p.liquidationPx ? esc((+p.liquidationPx).toPrecision(5)) + (dist != null ? ` <span class="${dist < 10 ? "bad-c" : "muted"}">(${fx(dist, 1)}%)</span>` : "") : "—"}</td></tr>`;
      }).join("")}</tbody></table></div>` : '<div class="hint">No open positions.</div>');
  } catch (e) { $("positions").textContent = `Could not load: ${e.message}`; }
}

async function pollEngine() {
  const urls = location.port === "8787" ? ["/state"] : ["http://localhost:8787/state"];
  for (const u of urls) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(u, { signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error();
      const prevTrades = S.engine?.trades?.length ?? null;
      S.engine = await r.json();
      $("engine-led").className = "led ok";
      $("engine-status").textContent = `engine ${S.engine.mode}${S.engine.testnet ? " testnet" : ""}`;
      if (prevTrades != null && S.engine.trades.length > prevTrades) { const t = S.engine.trades[S.engine.trades.length - 1]; notify(`${t.pair} closed`, `${t.reason} · PnL ${sgn(t.pnl)}`); }
      renderEngine();
      return;
    } catch { /* not running */ }
  }
  S.engine = null;
  $("engine-led").className = "led";
  $("engine-status").textContent = "engine offline";
  $("engine-card").hidden = true;
}

function renderEngine() {
  const e = S.engine;
  $("engine-card").hidden = false;
  $("engine-sub").textContent = `${e.mode}${e.testnet ? " · testnet" : ""} · ${e.interval}${e.venue ? " · " + e.venue : ""}`;
  const dd = e.guard.peak ? 1 - e.equity / e.guard.peak : 0;
  const open = e.pairs.filter((p) => p.pos);
  $("engine-kv").innerHTML = kv([
    ["equity", usd(e.equity), `drawdown ${fx(dd * 100, 1)}%`],
    ["today", e.guard.dayStart ? sgn(((e.equity / e.guard.dayStart) - 1) * 100, 2) + "%" : "—", e.guard.dayHalted ? "daily limit hit" : "within limit", e.guard.dayHalted ? "bad-c" : ""],
    ["status", e.guard.halted ? "HALTED" : e.guard.canOpen.ok ? "trading" : "no new risk", e.guard.haltReason || e.guard.canOpen.reason || "", e.guard.halted ? "bad-c" : "ok-c"],
    ["open pairs", String(open.length), open.map((p) => `${p.id} ${p.live ? sgn(p.live.pnl) : ""}`).join(", ")],
    ...(e.farm && e.farm.volume > 0 ? [
      ["volume (since start)", "$" + Math.round(e.farm.volume).toLocaleString(), `today $${Math.round(e.farm.volumeToday).toLocaleString()} · ${e.farm.fills} fills`],
      ["cost per $1M traded", e.farm.perMillion == null ? "—" : (e.farm.perMillion >= 0 ? "+" : "") + "$" + e.farm.perMillion.toFixed(1), "net PnL ÷ volume (farming efficiency)", e.farm.perMillion >= -30 ? "ok-c" : "warn-c"],
    ] : []),
    ...e.pairs.map((p) => [p.id, (p.diag?.action || "—") + (p.snap?.ready ? ` · z ${sgn(p.snap.z)}` : ""), p.pos ? `frozen z ${p.live ? sgn(p.live.zFrozen) : "—"}, ${p.plan ? usd(p.plan.maxLoss) + " at risk" : ""}` : (p.diag?.reasons || [])[0] || ""]),
  ]);
  $("engine-log").textContent = (e.log || []).slice(-60).join("\n");
  if (engineFor(S.pair?.id)) render();
}

// --------------------------------------------------------------------------- alerts
function setupAlerts() {
  const paint = () => {
    $("al-sound").textContent = `Sound ${S.alerts.sound ? "on" : "off"}`; $("al-sound").classList.toggle("on", S.alerts.sound);
    $("al-push").textContent = `Notifications ${S.alerts.push ? "on" : "off"}`; $("al-push").classList.toggle("on", S.alerts.push);
  };
  $("al-sound").onclick = () => { S.alerts.sound = !S.alerts.sound; store.set("alSound", S.alerts.sound); paint(); if (S.alerts.sound) beep(); };
  $("al-push").onclick = async () => {
    if (!S.alerts.push && "Notification" in window && Notification.permission !== "granted") await Notification.requestPermission();
    S.alerts.push = !S.alerts.push && "Notification" in window && Notification.permission === "granted";
    store.set("alPush", S.alerts.push); paint();
  };
  paint();
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.25;
    o.start(); g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5); o.stop(ctx.currentTime + 0.5);
  } catch { /* audio blocked */ }
}

function notify(title, body) {
  $("al-log").textContent = `${new Date().toISOString().slice(11, 16)} ${title} — ${body}`;
  if (S.alerts.sound) beep();
  if (S.alerts.push && "Notification" in window && Notification.permission === "granted") { try { new Notification(title, { body, tag: "pairs" }); } catch { /* ignore */ } }
}

function maybeAlert(pairId, action) {
  const prev = S.lastActions[pairId];
  S.lastActions[pairId] = action;
  if (prev && prev !== action && (action === "ENTER" || action === "ADD")) notify(`${pairId}: ${action}`, "spread setup passed every gate");
}

boot().catch((e) => { setStatus("bad", e.message); console.error(e); });
