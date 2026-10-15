#!/usr/bin/env node
// Run the OI-backed momentum strategy on Hyperliquid (docs/OI_MOMENTUM.md).
//
//   node bin/momentum.js --scan                   # evaluate the latest 5-minute bar now: coins, signals, would-be orders (trades nothing)
//   node bin/momentum.js                          # paper trading loop (checks every 5-minute close)
//   node bin/momentum.js --mode live --testnet    # real orders on Hyperliquid testnet
//   node bin/momentum.js --mode live --i-understand
//
// --signal binance uses Binance 5-minute candles + OI history (the research data; not
// available from the US). The default, hyperliquid, records Hyperliquid OI itself, so the
// 15-min/1-h/4-h/12-h lookbacks become available that long after the first start.
// Kill switch: create <stateDir>/KILL. After a drawdown halt: --reset-halt.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "../src/util/args.js";
import { loadUniverse } from "../src/data/history.js";
import { MomentumEngine } from "../src/exec/momentum-engine.js";
import { oimTrigger } from "../src/core/oi-momentum.js";

const args = parseArgs(process.argv.slice(2), {});
const path = args.config || (existsSync("config/momentum.json") ? "config/momentum.json" : "config/momentum.example.json");
const cfg = JSON.parse(await readFile(path, "utf8"));
if (args.signal) cfg.signalSource = args.signal;
const mode = args.mode || cfg.mode || "paper";
const testnet = args.testnet ?? cfg.testnet ?? false;

const env = { ...process.env };
if (existsSync(".env")) {
  for (const line of (await readFile(".env", "utf8")).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (mode === "live" && !testnet && !args["i-understand"] && !args.scan) {
  console.log("LIVE MAINNET MODE. This places real orders with real money.");
  console.log("Re-run with --i-understand once you have paper-traded and read docs/OI_MOMENTUM.md.");
  process.exit(1);
}

const NON_CRYPTO = new Set(["gold", "silver", "equity", "btc-equity", "index"]);
const exclude = new Set(cfg.exclude || []);
const assets = (await loadUniverse()).filter((a) => !NON_CRYPTO.has(a.sector) && !exclude.has(a.id)).map((a) => ({ id: a.id, hl: a.hl, binance: a.binance }));

const eng = new MomentumEngine({ cfg, assets, mode, testnet, env, equity: args.equity ?? cfg.paperEquity ?? 10_000, stateDir: cfg.stateDir || "state/momentum", resetHalt: !!args["reset-halt"] });
try { await eng.start(); } catch (e) {
  console.error(`could not start: ${e.message}`);
  console.error("Hyperliquid's API must be reachable (api.hyperliquid.xyz). Live mode also needs HL_ACCOUNT and HL_AGENT_KEY.");
  process.exit(1);
}

if (args.scan) {
  const m = await eng.loadMatrix();
  const k = m.t.length - 1;
  const p = eng.cfg.strategy;
  console.log(`\nLast closed 5-minute bar: ${new Date(m.t[k] + 5 * 60_000).toISOString()} — signals from ${eng.cfg.signalSource}`);
  console.log(`${"coin".padEnd(8)} ${p.lookbacksH.map((L) => `${L}h: z / ΔOI`.padStart(18)).join("")}  signal`);
  for (const a of eng.eligible(m, k)) {
    const cells = p.lookbacksH.map((LH) => {
      const L = Math.round(LH * 12), c0 = m.c[a][k - L], o0 = m.oi[a][k - L], o1 = m.oi[a][k];
      const z = c0 > 0 ? Math.log(m.c[a][k] / c0) / (m.sig[a][k] * Math.sqrt(L)) : NaN;
      const d = o0 > 0 && o1 > 0 ? o1 / o0 - 1 : NaN;
      return `${Number.isFinite(z) ? z.toFixed(1) : "—"} / ${Number.isFinite(d) ? (d * 100).toFixed(1) + "%" : "no OI yet"}`.padStart(18);
    });
    const t = oimTrigger(m, a, k, p);
    console.log(`${a.padEnd(8)} ${cells.join("")}  ${t ? (t.dir > 0 ? "LONG" : "SHORT") : ""}`);
  }
  console.log(`\nTriggers need a move ≥ ${p.zMin}σ AND OI +${p.oiMin * 100}% over the same window. Open trades: ${eng.state.trades.length}`);
  process.exit(0);
}

process.on("SIGINT", async () => { console.log("\nstopping (open trades stay open; their exits resume when you restart)"); eng.running = false; await eng.saveState().catch(() => {}); process.exit(0); });
await eng.run();
