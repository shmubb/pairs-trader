// Position sizing and account-level risk limits.
//
// Sizing works backwards from the stop: decide how much of the account a
// trade may lose (riskPerTrade), work out how far the spread can move against
// the *fully scaled-in* position before the stop fires, and size so that the
// worst case equals the budget. Scaling in therefore never raises the maximum
// loss — the extra tranches were paid for up front. That is the difference
// between a planned scale-in and "doubling down".

import { roundTripCost } from "./strategy.js";

export const RISK_DEFAULTS = {
  riskPerTrade: 0.01,
  maxGrossLeverage: 3,
  maxConcurrentPairs: 3,
  maxAssetExposure: 1.5,
  dailyLossLimit: 0.03,
  maxDrawdownHalt: 0.12,
  consecutiveLossCooldown: 3,
  cooldownBars: 24,
  maxLegShareOfVolume: 0.002,
  minOrderUsd: 11,
};

/**
 * Plan the full position for a new entry.
 * snap: model snapshot at entry. strat: merged strategy config. risk: risk config.
 * account: { equity, grossOpen (USD gross notional already open), assetExposure: {asset: USD} }
 * liquidity: { volA24h, volB24h } quote volume (USD), optional.
 * Returns leg-A plan notional (all tranches) and a breakdown, or {ok:false, reason}.
 */
export function planPosition(snap, strat, risk, account, liquidity = {}) {
  const r = { ...RISK_DEFAULTS, ...risk };
  const absZ = Math.abs(snap.z);
  const beta = Math.abs(snap.beta);
  const levels = strat.ladder.enabled ? strat.ladder.levels : [{ z: 0, weight: 1 }];
  const wSum = levels.reduce((s, l) => s + l.weight, 0);
  // Loss per $1 of planned leg-A notional if every tranche fills and the stop fires.
  let adverse = 0;
  for (const l of levels) adverse += (l.weight / wSum) * Math.max(0.25, strat.exit.stopZ - (absZ + l.z));
  const lossPerUnit = adverse * snap.sigmaEq + roundTripCost(beta, strat.costs);
  const budget = r.riskPerTrade * account.equity;
  let notionalA = budget / lossPerUnit;
  const limits = [];

  const grossPerUnit = 1 + beta;
  const grossRoom = r.maxGrossLeverage * account.equity - (account.grossOpen || 0);
  if (notionalA * grossPerUnit > grossRoom) { notionalA = Math.max(0, grossRoom / grossPerUnit); limits.push("gross leverage cap"); }
  if (liquidity.volA24h) {
    const capA = r.maxLegShareOfVolume * liquidity.volA24h;
    if (notionalA > capA) { notionalA = capA; limits.push("leg A liquidity"); }
  }
  if (liquidity.volB24h && beta > 0) {
    const capB = (r.maxLegShareOfVolume * liquidity.volB24h) / beta;
    if (notionalA > capB) { notionalA = capB; limits.push("leg B liquidity"); }
  }
  for (const [asset, mult] of [[account.assetA, 1], [account.assetB, beta]]) {
    if (!asset || !account.assetExposure) continue;
    const room = r.maxAssetExposure * account.equity - (account.assetExposure[asset] || 0);
    if (notionalA * mult > room) { notionalA = Math.max(0, room / mult); limits.push(`${asset} exposure cap`); }
  }
  const smallest = Math.min(...levels.map((l) => l.weight / wSum)) * notionalA * Math.min(1, beta || 1);
  if (smallest < r.minOrderUsd) return { ok: false, reason: `smallest tranche $${smallest.toFixed(2)} below exchange minimum`, notionalA, limits };

  return {
    ok: notionalA > 0,
    reason: notionalA > 0 ? null : "no room under limits",
    notionalA,
    notionalB: notionalA * beta,
    gross: notionalA * grossPerUnit,
    maxLoss: notionalA * lossPerUnit,
    budget,
    lossPerUnit,
    stopDistanceSigma: adverse,
    tranches: levels.map((l) => ({ atAbsZ: absZ + l.z, notionalA: (notionalA * l.weight) / wSum, notionalB: (notionalA * beta * l.weight) / wSum })),
    expectedProfit: notionalA * (levels[0].weight / wSum) * ((absZ - strat.exit.z) * snap.sigmaEq - roundTripCost(beta, strat.costs)),
    limits,
  };
}

/**
 * Account-level circuit breakers. Call on every bar/tick with the current
 * equity; ask canOpen() before any new position or add.
 */
export class AccountGuard {
  constructor(risk = {}) {
    this.r = { ...RISK_DEFAULTS, ...risk };
    this.peak = null;
    this.dayKey = null;
    this.dayStart = null;
    this.halted = false;
    this.haltReason = null;
    this.lossStreak = 0;
    this.cooldownUntil = -Infinity;
    this.openPairs = 0;
  }

  update(t, equity, bar = 0) {
    this.bar = bar;
    const day = new Date(t).toISOString().slice(0, 10);
    if (day !== this.dayKey) { this.dayKey = day; this.dayStart = equity; this.dayHalted = false; }
    this.peak = Math.max(this.peak ?? equity, equity);
    const dd = 1 - equity / this.peak;
    const dayLoss = 1 - equity / this.dayStart;
    if (dd >= this.r.maxDrawdownHalt && !this.halted) { this.halted = true; this.haltReason = `drawdown ${(dd * 100).toFixed(1)}% ≥ ${(this.r.maxDrawdownHalt * 100).toFixed(0)}% — manual reset required`; }
    if (dayLoss >= this.r.dailyLossLimit) this.dayHalted = true;
    return { dd, dayLoss, flattenAll: this.halted || this.dayHalted };
  }

  recordTrade(pnl) {
    this.lossStreak = pnl < 0 ? this.lossStreak + 1 : 0;
    if (this.lossStreak >= this.r.consecutiveLossCooldown) { this.cooldownUntil = (this.bar ?? 0) + this.r.cooldownBars; this.lossStreak = 0; }
  }

  /** forAdd: scaling into a pair that is already open doesn't count against the pair limit. */
  canOpen(forAdd = false) {
    if (this.halted) return { ok: false, reason: this.haltReason };
    if (this.dayHalted) return { ok: false, reason: `daily loss limit ${(this.r.dailyLossLimit * 100).toFixed(0)}% hit — no new risk today` };
    if ((this.bar ?? 0) < this.cooldownUntil) return { ok: false, reason: `cooling off after ${this.r.consecutiveLossCooldown} losses in a row` };
    if (!forAdd && this.openPairs >= this.r.maxConcurrentPairs) return { ok: false, reason: `already ${this.openPairs} pairs open` };
    return { ok: true };
  }

  reset() { this.halted = false; this.haltReason = null; this.peak = null; }
}
