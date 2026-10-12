export const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");
export const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : x === Infinity ? "∞" : "—");

export function fmtMetrics(m) {
  if (!m) return "no data";
  const exits = Object.entries(m.byExit).map(([k, v]) => `${k}:${v.n} (${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(0)})`).join("  ");
  return [
    `return ${pct(m.totalReturn)}  CAGR ${pct(m.cagr)}  Sharpe ${num(m.sharpe)}  maxDD ${pct(m.maxDrawdown)}  Calmar ${num(m.calmar)}`,
    `trades ${m.trades}  win ${pct(m.winRate, 0)}  PF ${num(m.profitFactor)}  avgR ${num(m.avgR)}  worst ${pct(m.worstTrade)}  avg hold ${num(m.avgBarsHeld, 0)} bars  exposure ${pct(m.exposure, 0)}`,
    `fees ${m.fees.toFixed(0)}  funding ${m.funding.toFixed(0)}  exits: ${exits}`,
  ].join("\n");
}
