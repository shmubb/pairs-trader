import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { FarmStrategy, farmModelConfig, FARM_DEFAULTS } from "../src/core/farm-strategy.js";
import { computeZ, simulate } from "../src/research/farm.js";
import { PairModel } from "../src/core/model.js";
import { LighterBroker } from "../src/exec/lighter-broker.js";

function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
function bars5m(n, seed = 1) {
  const g = rng(seed), out = [];
  let lb = Math.log(100), e = 0;
  const phi = Math.pow(0.5, 1 / 10);
  for (let i = 0; i < n; i++) {
    lb += 0.002 * g(); e = phi * e + 0.0015 * g();
    const pa = Math.exp(0.2 + lb + e), pb = Math.exp(lb), prev = out[i - 1];
    out.push({ t: Date.UTC(2026, 0, 1) + i * 300_000, oa: prev ? prev.pa : pa, ob: prev ? prev.pb : pb, pa, pb, qa: 1e6, qb: 1e6, fa: 0, fb: 0 });
  }
  return out;
}

test("FarmStrategy makes exactly the research simulator's decisions", () => {
  const fc = { ...FARM_DEFAULTS };
  const bars = bars5m(4000, 7);
  const mc = farmModelConfig(fc, "5m");
  // Research path.
  const zs = computeZ(bars, mc);
  const fb = mc.formationBars;
  const sim = simulate(bars, zs, { zIn: fc.zIn, zOut: fc.zOut, zStop: fc.zStop, gateCointP: fc.gateCointP, maxHold: Math.round(fc.maxHoldF * fb) }, { startT: 0, gross: 1000 });
  // Live path: strategy decisions, executed at the next open, same accounting.
  const model = new PairModel(mc), st = new FarmStrategy(fc, "5m");
  let qA = 0, qB = 0, pnl = 0, volume = 0, pending = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    if (i > 0 && (qA || qB)) pnl += qA * (b.oa - p.pa) + qB * (b.ob - p.pb);
    if (pending !== null) {
      const nA = 500, tA = (pending * nA) / b.oa, tB = (-pending * nA) / b.ob;
      volume += Math.abs(tA - qA) * b.oa + Math.abs(tB - qB) * b.ob;
      qA = tA; qB = tB; pending = null;
    }
    if (qA || qB) pnl += qA * (b.pa - b.oa) + qB * (b.pb - b.ob);
    const snap = model.update(b);
    const d = st.onBar(snap, { bar: i });
    for (const it of d.intents) pending = it.target;
  }
  assert.ok(sim.trades > 50, `trades ${sim.trades}`);
  assert.ok(Math.abs(volume - sim.volume) < 1e-6 * sim.volume, `volume ${volume} vs ${sim.volume}`);
  assert.ok(Math.abs(pnl - sim.gross) < 1e-6 * Math.max(1, Math.abs(sim.gross)), `pnl ${pnl} vs ${sim.gross}`);
});

/** Fake lighter_bridge.py: positions move when orders are submitted, per scenario. */
async function fakeBridge(scenario) {
  const pos = {};
  let call = 0;
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const send = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/health") return send({ ok: true });
    if (req.url === "/markets") return send({ BTC: { market_id: 1 }, ETH: { market_id: 0 } });
    if (req.url === "/account") return send({ equity: 10000, positions: Object.fromEntries(Object.entries(pos).filter(([, v]) => v).map(([k, v]) => [k, { szi: v, entryPx: 1 }])) });
    if (req.url === "/orders") {
      call++;
      const legs = JSON.parse(body).legs;
      const results = legs.map((l) => {
        const fill = scenario(l, call);
        if (fill) pos[l.symbol] = (pos[l.symbol] || 0) + l.size;
        return { symbol: l.symbol, submitted: true, error: null };
      });
      return send({ results });
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(), pos };
}

const mk = (url) => { const b = new LighterBroker({ bridgeUrl: url, confirmMs: 600, pollMs: 50, log: () => {} }); b.setMids({ BTC: 100000, ETH: 4000 }); return b; };

test("Lighter broker: both legs fill", async () => {
  const f = await fakeBridge(() => true);
  const b = mk(f.url);
  await b.init({ BTC: {}, ETH: {} });
  const r = await b.executeLegs([{ coin: "ETH", usd: 4000 }, { coin: "BTC", usd: -4000 }]);
  assert.ok(r.every((x) => x.ok));
  assert.ok(Math.abs(f.pos.ETH - 1) < 1e-9 && Math.abs(f.pos.BTC + 0.04) < 1e-9);
  f.close();
});

test("Lighter broker: missing leg is retried", async () => {
  const f = await fakeBridge((l, call) => !(l.symbol === "BTC" && call === 1));
  const b = mk(f.url);
  const r = await b.executeLegs([{ coin: "ETH", usd: 4000 }, { coin: "BTC", usd: -4000 }]);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  f.close();
});

test("Lighter broker: leg that never fills → filled leg is unwound", async () => {
  const f = await fakeBridge((l) => l.symbol !== "BTC" || l.reduceOnly);
  const b = mk(f.url);
  const r = await b.executeLegs([{ coin: "ETH", usd: 4000 }, { coin: "BTC", usd: -4000 }]);
  assert.ok(r.every((x) => !x.ok && x.unwound));
  assert.ok(Math.abs(f.pos.ETH || 0) < 1e-9, `ETH left ${f.pos.ETH}`);
  f.close();
});
