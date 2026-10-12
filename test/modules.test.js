import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleConfig } from "../src/core/timeframe.js";
import { liquidationMap, stopLevels, bookDepth } from "../src/core/liquidity.js";
import { easternOffset, nyTime, eventBlackout, sessionCheck } from "../src/core/sessions.js";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../config/default.json", import.meta.url)));

test("15m config keeps the same wall-clock windows as 1h", () => {
  const c = scaleConfig(cfg, "15m");
  assert.equal(c.model.formationBars, cfg.model.formationBars * 4);
  assert.equal(c.gates.maxHalfLifeBars, cfg.gates.maxHalfLifeBars * 4);
  assert.equal(c.exit.maxHoldBars, cfg.exit.maxHoldBars * 4);
  assert.equal(c.entry.z, cfg.entry.z, "non-bar parameters untouched");
  assert.equal(scaleConfig(cfg, "1h"), cfg);
});

test("liquidation map: levels price has swept are removed", () => {
  const candles = [];
  for (let i = 0; i < 100; i++) candles.push({ t: i, o: 100, h: 100.5, l: 99.5, c: 100, qv: 1e6 });
  const before = liquidationMap(candles);
  // 10x longs opened at 100 liquidate near 91; sweep down to 90 and back.
  candles.push({ t: 100, o: 100, h: 100, l: 90, c: 100, qv: 1e6 });
  const after = liquidationMap(candles);
  const mass = (m, lo, hi) => m.bins.filter((b) => b.lo >= lo && b.hi <= hi).reduce((s, b) => s + b.longLiq, 0);
  assert.ok(mass(before, 90.5, 92) > 0);
  assert.ok(mass(after, 90.5, 92) < 0.05 * mass(before, 90.5, 92), "swept long liquidations should be gone");
  assert.ok(after.clusterAbove.px > 100, "short liquidations sit above price");
});

test("stop levels and book depth", () => {
  const candles = [{ t: 0, o: 2470, h: 2510, l: 2440, c: 2480, qv: 1 }];
  const lv = stopLevels(candles);
  assert.ok(lv.some((l) => l.px === 2500) && lv.some((l) => l.px === 2400));
  const d = bookDepth({ levels: [[{ px: "99.9", sz: "10" }, { px: "98", sz: "10" }], [{ px: "100.1", sz: "5" }, { px: "102", sz: "5" }]] }, 0.01);
  assert.ok(Math.abs(d.mid - 100) < 1e-9);
  assert.ok(Math.abs(d.bidUsd - 999) < 1e-6 && Math.abs(d.askUsd - 500.5) < 1e-6);
});

test("macro event times handle US daylight saving", () => {
  assert.equal(easternOffset(Date.UTC(2026, 6, 1)), -4);
  assert.equal(easternOffset(Date.UTC(2026, 0, 15)), -5);
  assert.equal(new Date(nyTime("2026-07-14", 8, 30)).toISOString(), "2026-07-14T12:30:00.000Z");
  assert.equal(new Date(nyTime("2026-12-10", 8, 30)).toISOString(), "2026-12-10T13:30:00.000Z");
  const cpi = nyTime("2026-10-14", 8, 30);
  assert.ok(eventBlackout(cpi - 3600_000));
  assert.equal(eventBlackout(cpi - 5 * 3600_000), null);
  assert.equal(sessionCheck(cpi).ok, false);
});
