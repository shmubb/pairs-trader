#!/usr/bin/env node
// Run the trading engine.
//
//   node bin/engine.js                                   # paper mode, config/engine.json (or the example)
//   node bin/engine.js --engine config/engine.json --mode paper
//   node bin/engine.js --mode live --testnet             # real orders on Hyperliquid TESTNET
//   node bin/engine.js --mode live                       # real money — read docs/RUNBOOK.md first
//
// Live mode reads HL_ACCOUNT (main wallet address) and HL_AGENT_KEY (API
// wallet private key) from the environment or a .env file in the project root.
// Stop instantly: create the file state/KILL (the engine flattens and idles).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Engine } from "../src/exec/engine.js";
import { loadConfig } from "../src/util/config.js";
import { loadUniverse } from "../src/data/history.js";
import { mergeConfig } from "../src/core/strategy.js";
import { parseArgs } from "../src/util/args.js";

const args = parseArgs(process.argv.slice(2), {});
const engPath = args.engine || (existsSync("config/engine.json") ? "config/engine.json" : "config/engine.example.json");
const eng = JSON.parse(await readFile(engPath, "utf8"));
const mode = args.mode || eng.mode || "paper";
const testnet = args.testnet ?? eng.testnet ?? false;

// .env support without a dependency.
const env = { ...process.env };
if (existsSync(".env")) {
  for (const line of (await readFile(".env", "utf8")).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

let cfg = await loadConfig(eng.config);
if (eng.overrides) cfg = mergeConfig(cfg, eng.overrides);
const uni = await loadUniverse();
const pairs = eng.pairs.map((p) => {
  const A = uni.find((u) => u.id === p.a), B = uni.find((u) => u.id === p.b);
  return { a: p.a, b: p.b, hlA: p.hlA || A?.hl || p.a, hlB: p.hlB || B?.hl || p.b, set: p.set };
});

if (mode === "live" && !testnet && !args["i-understand"]) {
  console.log("LIVE MAINNET MODE. This places real orders with real money.");
  console.log("Re-run with --i-understand once you have paper-traded and read docs/RUNBOOK.md.");
  process.exit(1);
}

console.log(`config: ${engPath} → ${mode}${testnet ? " (testnet)" : ""}`);
const engine = new Engine({ cfg, pairs, mode, interval: eng.interval || cfg.interval, equity: eng.paperEquity ?? 10_000, pollSeconds: eng.pollSeconds ?? 20, stateDir: eng.stateDir || "state", port: eng.statusPort ?? 8787, testnet, env });
process.on("SIGINT", async () => { console.log("\nstopping (positions are left as they are; state saved)"); engine.running = false; await engine.saveState().catch(() => {}); process.exit(0); });
await engine.start();
