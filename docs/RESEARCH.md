# Research findings (October 2026)

Everything here can be reproduced with the scripts in `bin/` (see the Runbook).
Raw outputs are in `research/*.json`.

## TL;DR

1. **The old system was guaranteed to blow up, and it does on every pair.** Its rules (24 h rolling z on the ETH/BTC ratio, enter |z| ≥ 1.5, exit only at |z| < 0.1, no stop, ~2× notional) replayed on 406 pairs lose the whole account on **100% of pairs in 2022–24 and 98% in 2025–26**.
2. **The rebuilt risk system works.** Sized from the stop with the gates on, the worst single trade is ≈ 1% of equity and typical pair drawdowns are 0.5–2%, against ~100%.
3. **The profit edge in crypto-vs-crypto pairs at 15 m–1 h horizons is close to zero after costs.** I searched about 1,500 pairs, 30+ configurations, two bar sizes and three cost models. The best configuration that held up in both periods made **+0.02% per pair** on average in each period. That's break-even with very low risk, not a money machine.
4. **Picking "the pairs that worked last year" doesn't work.** In-sample results have ~zero rank correlation with out-of-sample results (ρ ≈ 0.03). Cointegration between crypto pairs is fleeting: true about 8–9% of the time on 30-day windows.
5. **What helped, consistently in both periods:**
   - strict cointegration gates,
   - waiting for the spread to stall,
   - a wide (5σ) stop sized from risk,
   - avoiding moves backed by **open interest building** (new positioning),
   - avoiding big single-leg impulses,
   - avoiding trades that pay funding,
   - not entering beyond |z| ≈ 2.5,
   - cheaper execution.
6. **What didn't help:** hour-of-day, weekend, and "13th–15th of the month" filters (no consistent effect); a short (24 h–14 d) lookback; tighter stops; adding to losing positions.
7. **Where an edge is most plausible:** economically linked pairs (BTC vs COIN/MSTR, gold vs silver, PAXG vs gold) traded with maker execution. History on Hyperliquid's builder markets is too short to prove it (6–10 months, a handful of trades). Paper-trade these.

## Data and method

- **Prices:** Binance USD-M perpetual candles from Binance's public archive (Jan 2022 → Oct 11 2026; 1 h for 55 assets, 15 m for 18).
  - Hyperliquid's own API only serves the last 5,000 candles, and its S3 archive is requester-pays. Binance and Hyperliquid perps on the same coin track each other to within a few basis points, so spread dynamics carry over.
  - Gold, silver, NVDA, AAPL, TSLA, MSTR, COIN, SPY and QQQ are Binance's TradFi perps, standing in for Hyperliquid's builder-dex markets.
- **Funding:** Binance 8-hourly funding (Hyperliquid funds hourly at broadly similar levels). **Open interest:** Binance hourly OI for 29 assets.
- **Costs:**
  - default runs: 0.045% taker + 0.03% slippage per leg per side;
  - "hybrid": 0.03% + 0.015%;
  - "maker": 0.015% + 0.
- **No look-ahead:** signals on bar close, fills at the next open. A test proves decisions don't change when future bars are removed.
- **Validation:** the statistics are checked against statsmodels (ADF statistic to 1e-6).
- **Periods:** in-sample (IS) 2022-03-01 → 2024-12-31, out-of-sample (OOS) 2025-01-01 → 2026-10-11. Each period warms up its own model. "Mean ret" is the average across pairs of each pair's total return over the period at 1% risk per trade on a $10k account.
- **Basket for sweeps:** 29 liquid assets → 406 pairs (`bin/sweep.js`).

## 1. The old system, replayed

| | IS mean ret | IS pairs profitable | OOS mean ret | OOS pairs profitable | trades/pair | max DD |
|---|---|---|---|---|---|---|
| Old app rules (406 pairs) | **−101.4%** | 0% | **−97.0%** | 2% | ~380 | ~100% |
| ETH/BTC alone, 2022→2026 | −100.3% | | | | 293 | 100% (worst trade −196% of equity) |

It's the post-mortem's diagnosis, in numbers. Many small wins at the 0.1 exit (54% win rate), then one unbounded loss. The rolling mean kept the signal saying "reverting" while the ratio trended.

## 2. Scanning every pair (`bin/scan.js`, `bin/analyze-scan.js`)

With the first-cut rules:

- Only **29%** of pairs were profitable IS and **39%** OOS (mean −0.6% / −0.5%).
- Ranking pairs by any IS statistic (Sharpe, return, profit factor, % of time cointegrated, half-life, Hurst, β stability) had **|ρ| < 0.06** with OOS return.
- Only 40 of 946 pairs (4%) were profitable in both periods, *fewer* than the ~11% chance would give.
- Groups: same-sector pairs did best OOS (44% profitable), pairs against BTC/ETH worst (31%).

With the final rules (section 4), the universe averages −0.04% IS / 0.00% OOS. The 25 pairs that were cointegrated most often in 2022–24 averaged **+0.39% OOS with 80% profitable**. That's the one selection rule with a positive tilt, though the overall rank correlation is still weak (ρ ≈ 0.03). The dashboard shortlist (`config/shortlist.json`) is built from it.

## 3. What each rule is worth (`bin/sweep.js`, 406 pairs, 1 h)

Round 1: one change at a time from the first-cut defaults (30-day OLS, z 2/4, ladder, stall).

| Variant | IS mean ret | IS Sharpe | OOS mean ret | OOS Sharpe | trades/pair | max DD |
|---|---|---|---|---|---|---|
| defaults | −1.06% | −0.24 | −0.50% | −0.17 | 13 | 3.2–3.5% |
| **loose stat gates** (no cointegration / Hurst / half-life) | **−3.82%** | −0.47 | **−2.33%** | −0.42 | 41–53 | 6.6–8.0% |
| formation 7 d | −3.97% | −0.58 | −2.33% | −0.50 | 28–35 | 5–7% |
| formation 14 d | −2.39% | −0.41 | −1.40% | −0.35 | 22–25 | 4.5–5.3% |
| formation 60 d | −0.17% | −0.09 | −0.30% | −0.19 | 7 | 2.2% |
| no stall confirmation | −1.37% | −0.25 | −0.93% | −0.25 | 19 | 4.0–4.3% |
| no ladder (single entry) | −1.45% | −0.24 | −0.63% | −0.16 | 13 | 4.3–4.7% |
| entry z 1.5 | −1.39% | −0.32 | −0.70% | −0.23 | 22 | 3.4–3.8% |
| entry z 2.5 | −0.87% | −0.22 | −0.51% | −0.19 | 8 | 3.0–3.3% |
| stop z 3.2 | −1.39% | −0.26 | −0.66% | −0.18 | 12 | 4.1–4.5% |
| stop z 5 | −0.81% | −0.24 | −0.33% | −0.15 | 13 | 2.1–2.4% |
| strict cointegration p < .05 | −0.81% | −0.21 | −0.40% | −0.18 | 9 | 2.6–2.8% |
| hedge Kalman | −0.44% | −0.20 | −0.30% | −0.20 | 5 | 1.8% |
| hedge β = 1 (ratio) | −0.47% | −0.15 | −0.22% | −0.14 | 8 | 2.4–2.6% |
| maker fees, no slippage | −0.48% | −0.11 | **+0.23%** | 0.00 | 13 | 3.2–3.5% |

Reading it:

- **The statistical gates are the biggest single improvement.** Without them the system trades 4× as much and loses 3–4× as much. They keep you out of trending, decoupled pairs, which is exactly what killed the old system.
- **Longer formation windows beat short ones.** The old 24 h window is the extreme short end.
- **Stall confirmation and a wide stop sized from risk both help.**
- **β = 1 and Kalman beat OLS out-of-sample.** OLS over 30 days overfits.
- **Costs move results more than any signal tweak.**

Rounds 2 and 4: combining the winners.

| Configuration | IS mean ret | OOS mean ret | OOS % pairs + | trades/pair | max DD |
|---|---|---|---|---|---|
| Kalman, 60 d, p < .05, stop 5, hybrid exec | +0.01% | −0.02% | 35% | 1.7 | 0.6% |
| defaults + all trade-study filters (taker) | −0.37% | −0.07% | 47% | 7.4–8.0 | 1.9–2.0% |
| **β = 1, 30 d, p < .05, stop 5, all filters, hybrid exec** ← `config/default.json` | **+0.02%** | **+0.02%** | 43% | 3.2–3.5 | 0.7–0.8% |

The filters added on top of the very selective Kalman/60 d base made no difference: too few trades were left to filter.

## 4. 15-minute bars (`--interval 15m`, 91 pairs, IS 2024-04→2025-03, OOS 2025-04→)

| Variant | IS mean ret | OOS mean ret | OOS trades/pair |
|---|---|---|---|
| defaults | −0.46% | −1.27% | 16 |
| defaults + maker | −0.15% | −0.32% | 16 |
| ratio, p < .05, stop 5 | −0.15% | −0.23% | 8 |
| … + hybrid exec | −0.11% | −0.12% | 8 |
| … + maker exec | −0.08% | 0.00% | 8 |
| 7 d formation + maker | −0.72% | −0.13% | 23 |

Faster bars don't create an edge. They create more trades, and so more cost.

## 5. Which conditions at entry matter (`bin/trade-study.js`, 10,735 trades)

Mean result per trade in R (1R = the planned loss at the stop):

| Condition | IS | OOS | Verdict |
|---|---|---|---|
| all trades | −0.081 | −0.038 | |
| OI on the moving leg **up > 5% in 24 h** | **−0.118** | **−0.081** | worst both times → `gates.maxMoverOiBuild` |
| OI on the moving leg down > 5% (flush) | −0.068 | −0.014 | better |
| leg impulse < 1σ / > 3σ | −0.056 / −0.187 | −0.026 / −0.081 | monotonic → `gates.maxLegMoveSigma = 2` |
| entry \|z\| 2.0–2.25 / > 3 | −0.066 / −0.124 | −0.022 / −0.058 | → `entry.maxEntryZ = 2.6` |
| funding **pays > 5 bp** over the hold | −0.112 | −0.083 | worst both times → `entry.maxCarryCost` |
| trades with 0 / 1 / 2 scale-in adds | −0.024 / −0.433 / −0.611 | +0.030 / −0.425 / −0.675 | adds happen in losing trades |
| within ±6 h of CPI/NFP/FOMC | (no 2022–24 calendar) | −0.120 vs −0.036 | supports the blackout (2026 only) |
| hour of day, weekend, 13th–15th | no consistent sign | | no filter |
| relative volume > 3× | −0.070 | −0.080 | weak |
| exits: stop / take-profit / time stop | −0.91 / +0.89 / +0.10 | −0.90 / +0.90 / +0.08 | stops cost ≈ 1R as designed |

**On "when to double down":**

- Trades that triggered a scale-in averaged −0.4 to −0.7R. The spread kept going against you, and adding made the loss bigger in dollars.
- The pre-budgeted ladder still caps the *worst case* at 1R, and it has the same risk-adjusted result as one full entry.
- So: **never add outside the plan**, and simpler (no adds) is just as good.

**On liquidations:**

- Divergences where the moving leg's OI *fell* (forced closing) reverted better than ones where OI *rose* (new positioning). The effect is consistent but modest: about 0.05–0.07R per trade.
- The dashboard's liquidation heat is a model. Real liquidation levels would need tracked-wallet positions. Master Control already stores those for ~600 wallets (see Next steps).

Caveat: these filters were chosen by looking at both periods. They were picked for having the same sign in both, which is a weaker test than a clean hold-out. **Paper trading is the real out-of-sample test.**

## 6. Structural and TradFi pairs (6–10 months of data — anecdotes)

| Pair | Why it's linked | Result (final rules) |
|---|---|---|
| PAXG / GOLD | PAXG is a gold-backed token: near-arbitrage | cointegrated 70–76% of the time, half-life 14–17 h, corr 0.99, but 1σ ≈ 0.1% → **only tradeable with maker execution**; 0–2 trades depending on settings |
| BTC / COIN | Coinbase revenue is crypto activity | Sharpe 3.1, +1.6%, 5 trades |
| GOLD / SILVER | classic metals pair | Sharpe 2.7, +1.2%, 4 trades |
| ETH, SOL, kPEPE / MSTR | MSTR is a BTC treasury proxy | Sharpe 2.1–2.4, 1–4 trades each |
| BTC / MSTR | MSTR is a BTC treasury company | −0.2%, 1 trade |
| SPY / QQQ | index pair | −0.4%, 1 trade (first-cut rules: −1.0%, 2 trades) |

They make economic sense and look good, but on far too few trades to rely on. They're in the scanner. Paper-trade them before risking money.

## 7. Caveats

- **Proxy data.** Binance prices and funding stand in for Hyperliquid. Prices match closely, but funding regimes can differ (Hyperliquid funds hourly, with its own premium). The engine and dashboard use real Hyperliquid data.
- **Survivorship.** The universe is coins that exist today. Pairs with coins that died aren't in the sample, which flatters every result a little.
- **Event calendar.** It only covers 2026, so event-blackout results cover just the most recent months.
- **Selection bias.** The shortlist was chosen using the full history.

## 8. Recommendations and next steps

1. **Paper-trade first** (`node bin/engine.js`, paper mode) on the shortlist for at least a month. That is the only clean out-of-sample test left, on real Hyperliquid prices, funding and order books.
2. **Use hybrid execution** (`exchange.entryStyle: "hybrid"`). Cost was the deciding factor in nearly every comparison.
3. **Keep risk small:** 0.25–0.5% per trade to start. The system's main value today is that it can't blow up. Edge has to be proven live.
4. **Ideas with better odds than more pair-tuning:**
   - **Real liquidation heat.** Feed Master Control's tracked-wallet positions (actual entry, size, leverage) into `src/core/liquidity.js` instead of the volume model. Then fade cascades into real clusters.
   - **Funding-spread carry.** `predictedFundings` returns Hyperliquid next to Binance/Bybit funding for every coin. A delta-neutral position earning a persistent funding gap is a cleaner edge than spread mean reversion. It needs a second venue.
   - **Residual stat-arb.** Trade each alt against a BTC+ETH factor (or a sector basket) instead of a single partner. Basket spreads are more stable than pairs.
   - **Structural pairs with dedicated models** (PAXG/GOLD, BTC/COIN, MSTR) once there's a year of history.
   - **Signals into Master Control.** The engine serves `/state` as JSON. Master Control's alerts can read it, so the notifications live in the terminal and not in a bot.
