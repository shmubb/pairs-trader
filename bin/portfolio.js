#!/usr/bin/env node
// Run the carry + trend book on Hyperliquid (docs/CARRY_TREND.md).
//
//   node bin/portfolio.js --plan                 # show today's target book and orders, trade nothing
//   node bin/portfolio.js                        # paper trading loop (rebalances daily after 00:00 UTC)
//   node bin/portfolio.js --once                 # one rebalance now, then exit (for cron / Task Scheduler)
//   node bin/portfolio.js --mode live --testnet  # real orders on Hyperliquid testnet
//   node bin/portfolio.js --mode live --i-understand   # mainnet, real money
//
// Live mode reads HL_ACCOUNT (main address) and HL_AGENT_KEY (API wallet key)
// from the environment or .env. Kill switch: create <stateDir>/KILL — the
// engine flattens everything and stops trading. After a drawdown halt,
// restart with --reset-halt.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "../src/util/args.js";
import { loadUniverse } from "../src/data/history.js";
import { PortfolioEngine } from "../src/exec/portfolio-engine.js";

const args = parseArgs(process.argv.slice(2), {});
const path = args.config || (existsSync("config/portfolio.json") ? "config/portfolio.json" : "config/portfolio.example.json");
const cfg = JSON.parse(await readFile(path, "utf8"));
const mode = args.mode || cfg.mode || "paper";
const testnet = args.testnet ?? cfg.testnet ?? false;

const env = { ...process.env };
if (existsSync(".env")) {
  for (const line of (await readFile(".env", "utf8")).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

if (mode === "live" && !testnet && !args["i-understand"] && !args.plan) {
  console.log("LIVE MAINNET MODE. This places real orders with real money.");
  console.log("Re-run with --i-understand once you have paper-traded and read docs/CARRY_TREND.md.");
  process.exit(1);
}

const NON_CRYPTO = new Set(["gold", "silver", "equity", "btc-equity", "index"]);
const exclude = new Set(cfg.exclude || []);
const coins = cfg.coins || (await loadUniverse()).filter((a) => !NON_CRYPTO.has(a.sector) && !exclude.has(a.id) && !exclude.has(a.hl)).map((a) => a.hl);

const eng = new PortfolioEngine({ cfg, coins, mode, testnet, env, equity: args.equity ?? cfg.paperEquity ?? 10_000, stateDir: cfg.stateDir || "state/portfolio", resetHalt: !!args["reset-halt"] });
try { await eng.start(); } catch (e) {
  console.error(`could not start: ${e.message}`);
  console.error("Hyperliquid's API must be reachable (api.hyperliquid.xyz). Live mode also needs HL_ACCOUNT and HL_AGENT_KEY.");
  process.exit(1);
}

if (args.plan || args.once) {
  const p = args.plan ? await eng.rebalance({ dryRun: true }) : await eng.rebalance();
  printPlan(p);
  if (args.once) await eng.saveState(await eng.broker.equity());
  process.exit(0);
}

process.on("SIGINT", async () => { console.log("\nstopping (positions are left as they are; state saved)"); eng.running = false; await eng.saveState().catch(() => {}); process.exit(0); });
await eng.run();

function printPlan(p) {
  const pc = (x) => (x == null ? "" : (x * 100).toFixed(1) + "%");
  const usd = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(0);
  console.log(`\nTarget book for the daily close ${new Date(p.barTime).toISOString().slice(0, 10)} — equity ${usd(p.equity)}, gross ${(p.gross * 100).toFixed(0)}% of equity`);
  console.log(`${"coin".padEnd(8)} ${"weight".padStart(8)} ${"carry".padStart(8)} ${"trend".padStart(8)} ${"target".padStart(10)}`);
  const rows = Object.entries(p.weights).sort((a, b) => b[1] - a[1]);
  for (const [c, w] of rows) console.log(`${c.padEnd(8)} ${pc(w).padStart(8)} ${pc(p.legs.carry[c] != null ? p.legs.carry[c] * eng.cfg.book.wCarry : null).padStart(8)} ${pc(p.legs.trend[c] != null ? p.legs.trend[c] * (1 - eng.cfg.book.wCarry) : null).padStart(8)} ${usd(w * p.equity).padStart(10)}`);
  if (p.skipped) console.log("(skipped: not enough data)");
  console.log(`\nOrders${args.plan ? " (not sent)" : ""}:`);
  if (!p.orders.length) console.log("  none — the book is within its no-trade band");
  for (const o of p.orders) console.log(`  ${o.coin.padEnd(8)} ${o.deltaUsd > 0 ? "BUY " : "SELL"} ${usd(Math.abs(o.deltaUsd)).padStart(8)}  (${usd(o.curUsd)} → ${usd(o.tgtUsd)})${o.reduceOnly ? " reduce-only" : ""}`);
}
