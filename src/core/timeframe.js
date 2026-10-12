// config/default.json is written in 1-hour bars. Running on another bar size
// must rescale every parameter that counts bars, or "30-day formation window"
// silently becomes 7.5 days on 15m candles.

export const BAR_MINUTES = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 };

const BAR_KEYS = {
  model: ["formationBars", "longFormationBars", "recalEvery", "volShortBars", "corrShortBars", "zVelocityBars", "zExtremeBars", "volumeAvgBars", "legMoveBars"],
  gates: ["minHalfLifeBars", "maxHalfLifeBars"],
  entry: ["cooldownBarsAfterStop"],
  ladder: ["minBarsBetweenAdds"],
  exit: ["minTimeStopBars", "maxHoldBars"],
  risk: ["cooldownBars"],
};

/** Return a copy of cfg with bar counts converted from 1h bars to `interval` bars. */
export function scaleConfig(cfg, interval) {
  const k = 60 / (BAR_MINUTES[interval] ?? 60);
  if (k === 1) return cfg;
  const out = structuredClone(cfg);
  for (const [section, keys] of Object.entries(BAR_KEYS)) {
    if (!out[section]) continue;
    for (const key of keys) {
      const v = out[section][key];
      if (Number.isFinite(v)) out[section][key] = Math.max(1, Math.round(v * k));
    }
  }
  out.interval = interval;
  return out;
}

export const barMs = (interval) => (BAR_MINUTES[interval] ?? 60) * 60_000;
