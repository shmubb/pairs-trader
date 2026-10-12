// Hyperliquid order precision rules (perps):
//  - size: at most szDecimals decimals (truncate — never round a size up)
//  - price: at most 5 significant figures AND at most (6 - szDecimals)
//    decimals; integer prices are always allowed.
// Prices are rounded in the *aggressive* direction (buy up, sell down) so an
// IOC with a slippage cushion stays marketable after rounding.

const strip = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

export function formatSize(sz, szDecimals) {
  const f = 10 ** szDecimals;
  const v = Math.trunc(Math.abs(sz) * f + 1e-9) / f;
  return strip(v.toFixed(szDecimals));
}

export function formatPrice(px, szDecimals, isBuy, maxDecimals = 6) {
  if (!(px > 0)) throw new Error(`bad price ${px}`);
  const intDigits = Math.floor(Math.log10(px)) + 1;
  const decimals = Math.max(0, Math.min(maxDecimals - szDecimals, 5 - intDigits));
  const f = 10 ** decimals;
  const scaled = px * f;
  const r = isBuy ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9);
  let v = r / f;
  // Integer prices may carry more than 5 significant figures; others may not.
  if (decimals === 0 && intDigits > 5) v = isBuy ? Math.ceil(px) : Math.floor(px);
  return strip(v.toFixed(decimals));
}

/** Price with a slippage cushion, rounded marketable. */
export function marketablePrice(mid, isBuy, slippage, szDecimals) {
  return formatPrice(mid * (isBuy ? 1 + slippage : 1 - slippage), szDecimals, isBuy);
}
