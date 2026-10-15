// Volume-farming mode: a fast, market-neutral pair strategy built to generate
// lots of genuine two-asset volume at close to zero cost on zero-fee venues.
// See docs/FARMING.md for the research behind every default.
//
// Rules (identical to the research simulator in src/research/farm.js, so the
// backtest is what runs):
//   spread = ln A − ln B (β = 1), z against a short rolling window (6 h of 5 m bars)
//   flat  → |z| ≥ zIn            : enter, betting on reversion (long the cheap leg)
//   open  → z back to ±zOut      : exit (take the quick half of the reversion)
//         → |z| ≥ zStop          : stop
//         → held ≥ maxHold bars  : time exit
// Fixed gross notional per pair, taker execution.

export const FARM_DEFAULTS = {
  interval: "5m",
  formationH: 6,
  zIn: 1,
  zOut: 0.5,
  zStop: 3.5,
  maxHoldF: 0.5,       // max hold as a fraction of the formation window (3 h)
  grossPerPair: 2000,  // both legs together, USD
  gateCointP: 1,       // no cointegration gate: at this horizon it removes volume without adding edge
};

const MIN = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };

/** PairModel settings for farm mode (same derivation the research used). */
export function farmModelConfig(fc, interval = fc.interval) {
  const fb = Math.round((fc.formationH * 60) / MIN[interval]);
  return {
    hedge: "ratio", formationBars: fb, longFormationBars: fb,
    recalEvery: Math.max(12, Math.round(fb / 48)), volShortBars: Math.max(12, Math.round(fb / 30)),
    corrShortBars: Math.max(24, Math.round(fb / 10)), legMoveBars: Math.max(12, Math.round(fb / 30)), volumeAvgBars: fb,
  };
}

export class FarmStrategy {
  constructor(cfg = {}, interval = "5m") {
    this.cfg = { ...FARM_DEFAULTS, ...cfg };
    this.fb = Math.round((this.cfg.formationH * 60) / MIN[interval]);
    this.maxHold = Math.round(this.cfg.maxHoldF * this.fb);
    this.pos = null; // {dir, entryBar}
    this.bar = 0;
    this.kind = "farm";
  }

  /** snap: PairModel snapshot for the just-closed bar. Returns {action, intents, reasons}. */
  onBar(snap, { bar } = {}) {
    const c = this.cfg;
    this.bar = bar ?? this.bar + 1;
    const out = { action: "WAIT", intents: [], reasons: [], dir: this.pos?.dir ?? 0 };
    if (!snap.ready || !Number.isFinite(snap.z)) { out.reasons.push("warming up"); return out; }
    const z = snap.z;
    if (!this.pos) {
      if (snap.cointP <= c.gateCointP && Math.abs(z) >= c.zIn) {
        const dir = z < 0 ? 1 : -1;
        this.pos = { dir, entryBar: this.bar + 1 }; // fills on the next bar's open
        out.action = "ENTER";
        out.intents.push({ type: "farm", target: dir, reason: `|z| ${Math.abs(z).toFixed(2)} ≥ ${c.zIn}` });
      } else out.reasons.push(`|z| ${Math.abs(z).toFixed(2)} < ${c.zIn}`);
      return out;
    }
    const toward = -this.pos.dir * z;
    let why = null, action = null;
    if (toward >= c.zStop) { why = `stop: |z| ${Math.abs(z).toFixed(2)} ≥ ${c.zStop}`; action = "STOP"; }
    else if (toward <= c.zOut) { why = `target: z ${z.toFixed(2)} back inside ±${c.zOut}`; action = "TAKE_PROFIT"; }
    else if (this.bar - this.pos.entryBar >= this.maxHold) { why = `time exit after ${this.maxHold} bars`; action = "TIME_STOP"; }
    if (why) {
      this.pos = null;
      out.action = action;
      out.intents.push({ type: "farm", target: 0, reason: why });
      out.reasons.push(why);
    } else {
      out.action = "HOLD";
      out.reasons.push(`holding ${this.pos.dir > 0 ? "long" : "short"} spread, z ${z.toFixed(2)}`);
    }
    return out;
  }
}
