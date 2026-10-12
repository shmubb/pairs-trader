// The trading rules for one pair, as a state machine. Given the model's
// snapshot for a bar (and context the engine supplies: session, funding,
// account limits) it returns *intents* — open / add / reduce / close /
// rebalance — and a full explanation of why. The backtester and the live
// engine both execute these intents, so what you backtest is what runs.
//
// Direction convention: dir = +1 means LONG the spread (long A, short β·B),
// taken when z is very negative (A cheap vs B). dir = -1 is the mirror.

export const STRATEGY_DEFAULTS = {
  gates: {
    maxCointP: 0.10, minHalfLifeBars: 3, maxHalfLifeBars: 120, maxHurst: 0.55,
    minCorr: 0.6, minCorrShort: 0.4, maxVolRatio: 2.5, minBeta: 0.2, maxBeta: 5,
    maxLegMoveSigma: 4, requireLongAgreement: false, maxOpposingLongZ: 3.0, maxMoverOiBuild: null,
  },
  entry: {
    z: 2.0, confirm: "stall", stallGiveback: 0.15, minEdgeCostRatio: 2.5, maxEntryZ: 3.3,
    cooldownBarsAfterStop: 48, volumeFilter: "off", maxRelVolume: 4, maxCarryCost: null,
  },
  ladder: {
    enabled: true,
    levels: [{ z: 0, weight: 0.5 }, { z: 0.75, weight: 0.3 }, { z: 1.25, weight: 0.2 }],
    minBarsBetweenAdds: 3, noAddAfterTimeFraction: 0.5,
  },
  exit: {
    z: 0.0, partialZ: null, partialFraction: 0.5, stopZ: 4.0, dollarStopR: 1.25, liveExitRequiresProfit: true,
    timeStopHalfLives: 3, minTimeStopBars: 12, maxHoldBars: 336,
    breakCointP: 0.5, breakConsecutive: 3, maxFundingDrainOfEdge: 0.5, rebalanceBetaDrift: 0.15,
  },
  costs: { takerFee: 0.00045, makerFee: 0.00015, slippage: 0.0003, useMaker: false },
};

export function mergeConfig(base, over = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? mergeConfig(base[k], v) : v;
  }
  return out;
}

/** Round-trip trading cost as a fraction of leg-A notional (entry + exit, both legs). */
export function roundTripCost(beta, costs) {
  const fee = costs.useMaker ? costs.makerFee : costs.takerFee;
  return 2 * (fee + costs.slippage) * (1 + Math.abs(beta));
}

/** Expected bars to revert from |z| to the exit level for an OU process. */
export function expectedHoldBars(absZ, exitZ, halfLife) {
  const target = Math.max(0.25, Math.abs(exitZ));
  return halfLife * Math.max(1, Math.log2(Math.max(absZ, target + 0.01) / target));
}

/**
 * Pair-level tradeability checks. Each check is reported (pass/fail, value,
 * limit) so the dashboard can show a checklist rather than a bare verdict.
 */
export function evaluateGates(snap, cfg) {
  const g = cfg.gates;
  const checks = [];
  const add = (name, ok, value, limit, why) => checks.push({ name, ok: !!ok, value, limit, why });
  add("cointegration", snap.cointP <= g.maxCointP, snap.cointP, g.maxCointP, "Engle-Granger p-value of the spread; above the limit the spread isn't reliably mean-reverting");
  add("halfLife", snap.halfLife >= g.minHalfLifeBars && snap.halfLife <= g.maxHalfLifeBars, snap.halfLife, [g.minHalfLifeBars, g.maxHalfLifeBars], "how fast the spread reverts; too slow ties capital up and lets regimes change underneath you");
  add("hurst", !(snap.hurst > g.maxHurst), snap.hurst, g.maxHurst, "above 0.5 the spread trends rather than reverts");
  add("correlation", snap.corr >= g.minCorr, snap.corr, g.minCorr, "return correlation over the formation window");
  add("correlationShort", snap.corrShort >= g.minCorrShort, snap.corrShort, g.minCorrShort, "recent correlation; a drop means the legs are decoupling");
  add("volatility", snap.volRatio <= g.maxVolRatio, snap.volRatio, g.maxVolRatio, "spread volatility vs normal; a blow-out means the old σ no longer describes the spread");
  add("beta", Math.abs(snap.beta) >= g.minBeta && Math.abs(snap.beta) <= g.maxBeta, snap.beta, [g.minBeta, g.maxBeta], "implausible hedge ratios signal a broken fit");
  const legMove = Math.max(Math.abs(snap.legMoveA), Math.abs(snap.legMoveB));
  add("impulse", !(legMove > g.maxLegMoveSigma), legMove, g.maxLegMoveSigma, "one leg is in a violent move (crash/pump/news); wait for it to settle");
  if (g.maxMoverOiBuild != null) {
    const moverA = Math.abs(snap.legMoveA) >= Math.abs(snap.legMoveB);
    const oi = moverA ? snap.oiChgA : snap.oiChgB;
    add("positioning", !(oi > g.maxMoverOiBuild), Number.isFinite(oi) ? oi : null, g.maxMoverOiBuild, "open interest building behind the move = new (often informed) positioning, which reverts less than forced liquidations; unknown OI passes");
  }
  if (Number.isFinite(snap.zLong)) {
    const opposing = Math.sign(snap.zLong) === Math.sign(snap.z) && Math.abs(snap.zLong) > g.maxOpposingLongZ;
    add("longHorizon", !opposing, snap.zLong, g.maxOpposingLongZ, "the spread is also extreme on the 3× longer window — likely a trend, not a wobble");
    if (g.requireLongAgreement) add("longAgreement", Math.abs(snap.zLong) < Math.abs(snap.z), snap.zLong, null, "longer window must be less stretched");
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export class PairStrategy {
  constructor(cfg = {}) {
    this.cfg = mergeConfig(STRATEGY_DEFAULTS, cfg);
    this.pos = null;
    this.cooldown = { 1: -Infinity, [-1]: -Infinity };
    this.lastRecal = null;
    this.bar = 0;
  }

  /** Spread z under the parameters frozen at entry (so a drifting mean can't hide a loss). */
  frozenZ(snap) {
    const e = this.pos.entry;
    const s = Math.log(snap.pa) - e.beta * Math.log(snap.pb);
    return (s - e.mu) / e.sigmaEq;
  }

  /**
   * ctx: {
   *   bar: index, session: {ok, reason}, carryPerBar: funding earned per bar as a fraction of leg-A notional
   *   for a LONG-spread position (negate for short), canOpen: {ok, reason} from the portfolio/risk layer,
   *   pnlFrac: open PnL as fraction of planned max loss (from the executor), fundingPaid: cumulative funding fraction of A notional
   * }
   */
  onBar(snap, ctx = {}) {
    const c = this.cfg;
    this.bar = ctx.bar ?? this.bar + 1;
    const out = { intents: [], action: "WAIT", reasons: [], gates: null, dir: 0 };
    if (!snap.ready) { out.reasons.push("warming up: need " + "formation window of data"); return out; }

    const gates = evaluateGates(snap, c);
    out.gates = gates;
    const recalNew = snap.recalAt !== this.lastRecal;
    this.lastRecal = snap.recalAt;

    if (this.pos) return this.manage(snap, ctx, gates, recalNew, out);
    return this.seekEntry(snap, ctx, gates, out);
  }

  seekEntry(snap, ctx, gates, out) {
    const c = this.cfg;
    const absZ = Math.abs(snap.z);
    const dir = snap.z < 0 ? 1 : -1;
    out.dir = dir;
    if (absZ < c.entry.z) {
      out.action = "WAIT";
      out.reasons.push(`|z| ${absZ.toFixed(2)} below entry ${c.entry.z}`);
      return out;
    }
    const blockers = [];
    if (!gates.ok) blockers.push(...gates.checks.filter((k) => !k.ok).map((k) => `gate ${k.name} failed`));
    if (absZ > c.entry.maxEntryZ) blockers.push(`|z| ${absZ.toFixed(2)} beyond max first-entry ${c.entry.maxEntryZ} (too stretched to trust)`);
    if (this.bar < this.cooldown[dir]) blockers.push(`cooling down after a stop in this direction (${this.cooldown[dir] - this.bar} bars left)`);
    if (ctx.session && !ctx.session.ok) blockers.push(`session: ${ctx.session.reason}`);
    if (ctx.canOpen && !ctx.canOpen.ok) blockers.push(`risk: ${ctx.canOpen.reason}`);
    if (c.entry.volumeFilter === "avoidSpikes" && Math.max(snap.rvA, snap.rvB) > c.entry.maxRelVolume) blockers.push("volume spike: likely news-driven");
    if (c.entry.volumeFilter === "requireSpike" && Math.max(snap.rvA, snap.rvB) < 1.5) blockers.push("no volume behind the move");

    // Confirmation: don't catch the knife — wait for the spread to stop extending.
    if (c.entry.confirm === "stall") {
      const giveback = Math.abs(snap.zExtreme) - absZ;
      if (giveback < c.entry.stallGiveback) blockers.push(`still extending (gave back ${giveback.toFixed(2)}σ of ${c.entry.stallGiveback} needed)`);
    } else if (c.entry.confirm === "velocity") {
      if (Math.sign(snap.zVel) !== dir) blockers.push("z still moving away from the mean");
    }

    // Edge vs cost: expected reversion move must comfortably beat fees, slippage and funding.
    const gross = (absZ - c.exit.z) * snap.sigmaEq;
    const cost = roundTripCost(snap.beta, c.costs);
    const hold = expectedHoldBars(absZ, c.exit.z, snap.halfLife);
    const carry = (ctx.carryPerBar ?? 0) * dir * hold;
    const ratio = (gross + Math.max(0, carry)) / (cost + Math.max(0, -carry));
    out.edge = { gross, cost, carry, ratio, holdBars: hold };
    if (c.entry.maxCarryCost != null && -carry > c.entry.maxCarryCost) blockers.push(`funding would cost ${(-carry * 1e4).toFixed(1)}bp over the expected hold (max ${(c.entry.maxCarryCost * 1e4).toFixed(0)}bp)`);
    if (ratio < c.entry.minEdgeCostRatio) blockers.push(`edge ${(gross * 100).toFixed(2)}% only ${ratio.toFixed(1)}× costs (need ${c.entry.minEdgeCostRatio}×)`);

    if (blockers.length) {
      out.action = gates.ok ? "WAIT" : "NO_TRADE";
      out.reasons.push(...blockers);
      return out;
    }

    // Open: freeze the model so stops and targets are measured against what we believed at entry.
    const ladder = c.ladder.enabled ? c.ladder.levels : [{ z: 0, weight: 1 }];
    const first = ladder[0];
    this.pos = {
      dir,
      openedBar: this.bar, openedT: snap.t,
      entry: { beta: snap.beta, mu: snap.mu, sigmaEq: snap.sigmaEq, halfLife: snap.halfLife, z: snap.z, absZ },
      ladder: ladder.map((l) => ({ ...l, absZ: absZ + l.z, filled: false })),
      filledWeight: 0,
      lastAddBar: this.bar,
      partialDone: false,
      breakStreak: 0,
      edge: out.edge,
      timeStopBars: Math.min(c.exit.maxHoldBars, Math.max(c.exit.minTimeStopBars, c.exit.timeStopHalfLives * snap.halfLife)),
    };
    this.pos.ladder[0].filled = true;
    this.pos.filledWeight = first.weight;
    out.action = "ENTER";
    out.intents.push({ type: "open", dir, weight: first.weight, reason: `|z| ${absZ.toFixed(2)} ≥ ${c.entry.z}, gates pass, edge ${out.edge.ratio.toFixed(1)}× cost` });
    out.reasons.push(out.intents[0].reason);
    return out;
  }

  manage(snap, ctx, gates, recalNew, out) {
    const c = this.cfg, p = this.pos;
    const zF = this.frozenZ(snap);
    const held = this.bar - p.openedBar;
    out.dir = p.dir;
    out.position = { zFrozen: zF, barsHeld: held, filledWeight: p.filledWeight, timeStopBars: p.timeStopBars };
    const toward = -p.dir * zF; // > 0 while still on the entry side of the mean; ≤ 0 once reverted
    const close = (reason, action) => {
      out.intents.push({ type: "close", reason });
      out.action = action;
      out.reasons.push(reason);
      if (action === "STOP") this.cooldown[p.dir] = this.bar + c.entry.cooldownBarsAfterStop;
      this.pos = null;
      return out;
    };

    // 1. Hard stop on the frozen model — the rule the old system never had.
    if (toward >= c.exit.stopZ) return close(`stop: frozen z ${zF.toFixed(2)} reached ±${c.exit.stopZ}`, "STOP");
    // 2. Dollar stop backstop (gaps, model error): loss beyond 1.25× plan.
    if (ctx.pnlFrac != null && ctx.pnlFrac <= -c.exit.dollarStopR) return close(`stop: loss ${(-ctx.pnlFrac).toFixed(2)}× planned risk`, "STOP");
    // 3. Take profit at the mean (on frozen or live z — whichever gets there first, if PnL is positive).
    const liveToward = -p.dir * snap.z;
    if (toward <= c.exit.z || (liveToward <= c.exit.z && (!c.exit.liveExitRequiresProfit || (ctx.pnlFrac ?? 1) > 0))) return close(`target: spread back to ${c.exit.z}σ (frozen z ${zF.toFixed(2)}, live z ${snap.z.toFixed(2)})`, "TAKE_PROFIT");
    // 4. Time stop: if it hasn't reverted in ~3 half-lives, the relationship has probably changed.
    if (held >= p.timeStopBars) return close(`time stop: ${held} bars ≥ ${Math.round(p.timeStopBars)} (≈${c.exit.timeStopHalfLives} half-lives)`, "TIME_STOP");
    // 5. Regime break: cointegration gone for several recalibrations in a row.
    if (recalNew) p.breakStreak = snap.cointP > c.exit.breakCointP ? p.breakStreak + 1 : 0;
    if (p.breakStreak >= c.exit.breakConsecutive) return close(`regime break: cointegration p>${c.exit.breakCointP} for ${p.breakStreak} recalibrations`, "BREAK");
    // 6. Funding drain.
    if (ctx.fundingPaid != null && p.edge && -ctx.fundingPaid > c.exit.maxFundingDrainOfEdge * p.edge.gross) return close(`funding has eaten ${((-ctx.fundingPaid / p.edge.gross) * 100).toFixed(0)}% of the expected edge`, "FUNDING");

    // Partial profit.
    if (c.exit.partialZ != null && !p.partialDone && toward <= c.exit.partialZ) {
      p.partialDone = true;
      out.intents.push({ type: "reduce", fraction: c.exit.partialFraction, reason: `partial profit at frozen z ${zF.toFixed(2)}` });
    }

    // Scale-in: only pre-budgeted tranches, only while the setup is still healthy, only on a stall.
    const next = p.ladder.find((l) => !l.filled);
    if (next && toward >= next.absZ) {
      const why = [];
      if (!gates.ok) why.push("gates failing");
      if (this.bar - p.lastAddBar < c.ladder.minBarsBetweenAdds) why.push("too soon after last add");
      if (held > c.ladder.noAddAfterTimeFraction * p.timeStopBars) why.push("too late in the trade");
      if (c.entry.confirm === "stall" && Math.abs(snap.zExtreme) - Math.abs(snap.z) < c.entry.stallGiveback) why.push("still extending");
      if (ctx.canOpen && !ctx.canOpen.ok) why.push(ctx.canOpen.reason);
      if (!why.length) {
        next.filled = true;
        p.filledWeight += next.weight;
        p.lastAddBar = this.bar;
        out.intents.push({ type: "add", weight: next.weight, reason: `scale-in at frozen z ${zF.toFixed(2)} (planned level ${next.absZ.toFixed(2)})` });
        out.action = "ADD";
      } else {
        out.reasons.push(`add at ${next.absZ.toFixed(2)} held back: ${why.join(", ")}`);
      }
    }

    // Hedge-ratio drift → rebalance leg B, keeping the frozen z continuous.
    if (c.exit.rebalanceBetaDrift && Math.abs(snap.beta - p.entry.beta) / Math.abs(p.entry.beta) >= c.exit.rebalanceBetaDrift) {
      const s = Math.log(snap.pa) - snap.beta * Math.log(snap.pb);
      p.entry.mu = s - zF * p.entry.sigmaEq;
      p.entry.beta = snap.beta;
      out.intents.push({ type: "rebalance", beta: snap.beta, reason: `hedge ratio drifted to ${snap.beta.toFixed(3)}` });
    }

    if (out.action === "WAIT") out.action = "HOLD";
    out.reasons.push(`holding: frozen z ${zF.toFixed(2)}, ${held}/${Math.round(p.timeStopBars)} bars`);
    return out;
  }
}
