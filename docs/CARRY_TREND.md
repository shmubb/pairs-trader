# Carry + trend book

The directional strategy this repo recommends for making money (as opposed to farming volume). It holds a diversified book of crypto perps on Hyperliquid and rebalances once a day.

Two return sources, each well documented in the crypto-factor literature:

- **Funding carry.** Coins where longs pay high funding are crowded. Short them and go long the coins with the lowest funding. You collect the funding gap, and crowded longs also tend to underperform on price.
- **Trend.** Coins keep moving in the direction of their recent multi-week returns. Hold each coin long or short according to the sign of its 7, 14, 28, 56 and 112-day returns.

The two legs are almost uncorrelated (−0.09 daily), so the blend is far steadier than either alone.

## Result

Backtest: Binance USD-M perp history, June 2020 → October 2026. Daily bars, top-20 universe, fills at the next day's open. Costs are 6 bp per side, and real funding is paid or received every 8 hours.

- **Selection period (in-sample):** 2020-06 → 2023-12. The rules were chosen here.
- **Unseen period (out-of-sample):** 2024-01 → now. Tested once, rules unchanged.

| | In-sample | Out-of-sample | Full period |
|---|---|---|---|
| Sharpe ratio | 1.86 | **1.17** | 1.57 |
| Annual return | 30% | **17%** | 24% |
| Max drawdown | 11% | **14%** | 14% |

Default risk: 20% target volatility per leg.

| Full period | |
|---|---|
| Realised volatility | 14.5% |
| Positive months | 66% |
| Worst / best month | −7.1% / +22.0% |
| $10k → | ≈ $40k |
| Turnover | ≈ 93× equity per year; costs ≈ 5.5% a year |
| Average gross exposure | 0.68× equity |

| Calendar year | 2020 (Jun→) | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 (→Oct) |
|---|---|---|---|---|---|---|---|
| Return | +26% | +78% | +7% | +9% | +29% | +4% | +14% |

Every year was positive, including 2022, when a buy-and-hold basket lost 24%.

How each piece did on its own, with the same costs:

| Strategy | Sharpe, in-sample | Sharpe, out-of-sample | Out-of-sample max DD |
|---|---|---|---|
| Buy & hold, vol-targeted basket | 1.12 | 0.19 | 29% |
| BTC only, vol-targeted | 1.04 | 0.66 | 32% |
| Trend leg alone (TSMOM 7–112d) | 1.68 | 0.41 | 19% |
| Carry leg alone (7-day funding) | 0.99 | 0.90 | 25% |
| **Carry + trend, 50/50** | **1.86** | **1.17** | **14%** |

### Robustness (`bin/robust.js`)

Each parameter was moved one at a time, with the others at their defaults. Out-of-sample Sharpe for each variant:

| Parameter | Values tried → out-of-sample Sharpe |
|---|---|
| Carry lookback (days) | 1: 0.83 · 3: 0.68 · 5: 0.97 · **7: 1.17** · 10: 1.08 · 14: 1.54 · 21: 1.07 · 30: 0.62 |
| Carry quantile per side | 0.2: 1.26 · 0.25: 1.36 · **0.3: 1.17** · 0.4: 1.30 · 0.5: 1.25 |
| Trend lookbacks (days) | 7/14/28: 1.53 · 14/28/56: 1.31 · **7…112: 1.17** · 28/56/112: 1.22 · 56/112/224: 0.72 |
| Universe size | 10: 0.90 · 15: 1.39 · **20: 1.17** · 30: 1.08 · 45: 1.67 |
| Carry weight | 0 (trend only): 0.41 · 0.3: 0.89 · **0.5: 1.17** · 0.7: 1.18 · 1 (carry only): 0.90 |
| Cost per side | 3 bp: 1.39 · **6 bp: 1.17** · 10 bp: 0.87 · 15 bp: 0.50 |
| Rebalance hour (UTC) | **00: 1.18** · 04: 1.39 · 08: 1.46 · 12: 1.08 · 16: 1.26 · 20: 0.93 |
| Rebalance frequency | **daily: 1.17** · every 3 days: 0.57 · weekly: 1.72 |

No variant loses money out-of-sample. The defaults were not tuned to the best cell: several neighbours did better out-of-sample, which is what you expect when the edge is broad rather than a lucky parameter.

### What didn't work (`bin/strategies.js`, same data and costs)

| Idea | Sharpe, in-sample | Sharpe, out-of-sample | Verdict |
|---|---|---|---|
| Short-term reversal (1–3 day losers vs winners) | −3.0 | −2.7 | Strongly negative. Crypto keeps moving the same way at 1–3 days, so never fade it. |
| Cross-sectional momentum, 4–8 weeks | −0.2 to 1.05 | −0.5 to −0.1 | Did not survive out-of-sample. |
| Funding contrarian (fade extreme funding in time) | −0.5 to −0.1 | 0.0 to 0.1 | No edge. Extreme funding on its own is not a timing signal; the cross-section is what matters. |
| Donchian breakouts | 0.3 to 1.4 | −0.5 to 0.5 | Unstable across channel lengths. |
| BTC-regime long-only basket | 1.6 to 1.8 | 0.26 to 0.38 | Mostly beta. Fine in bull markets, little edge. |

## Rules

| | |
|---|---|
| Universe | Crypto perps in `config/universe.json` that trade on Hyperliquid. Each day, the 20 with the highest 30-day $ volume above a minimum. |
| Carry leg | Rank by funding paid over the last 7 days. Long the lowest-funding 30%, short the highest-funding 30%. Inverse-volatility weights within each side; dollar-neutral. |
| Trend leg | Per coin, the average of sign(return) over 7/14/28/56/112 days (a score from −1 to +1). Inverse-volatility weights. Long and short. |
| Risk | Each leg is scaled to 20% annualised volatility (trailing 60 days of returns). Blend 50/50. Gross exposure capped at 3× equity. The blend realises ≈ 14% volatility because the legs diversify. |
| Rebalance | Daily, just after the 00:00 UTC candle closes. A position is resized only if it is more than 25% away from target (no-trade band); orders below $15 are skipped. |
| Execution | IOC limit orders with a slippage cap, one coin at a time. Reductions first, so they free margin before additions. |
| Safety | Kill switch file. Drawdown halt: flatten and stop at −25% from peak. Margin pre-check before each order. A rebalance is skipped if data is missing for too many coins. |

Code:

- strategy: `carryTrend()` in `src/core/xs-strategies.js`;
- engine: `src/exec/portfolio-engine.js`;
- backtester: `src/research/portfolio.js`.

The engine calls the same strategy function as the backtester on the same matrix (`src/core/matrix.js`). A test checks they produce identical weights.

## Using it

```bash
node bin/portfolio.js --plan                       # today's target book and the orders it would send; trades nothing
node bin/portfolio.js                              # paper trading on live Hyperliquid prices, rebalances daily
node bin/portfolio.js --once                       # one rebalance now, then exit (for cron / Task Scheduler)
node bin/portfolio.js --mode live --testnet        # testnet orders
node bin/portfolio.js --mode live --i-understand   # mainnet, real money
```

1. **Paper first, for at least two to four weeks.**
   - `cp config/portfolio.example.json config/portfolio.json`.
   - Leave `mode: "paper"` and run `node bin/portfolio.js`.
   - The engine keeps state in `state/portfolio/`: `trades.jsonl`, `equity.jsonl`, `status.json` and `portfolio.log`.
   - Funding is charged hourly at Hyperliquid's live rates.
2. **Use a dedicated account or subaccount.**
   - The engine sizes from the whole account's equity.
   - It manages (and may close) positions in any universe coin.
3. **Live.**
   - Same setup as the pairs engine (`docs/RUNBOOK.md` §4): an API/agent wallet in `.env` as `HL_ACCOUNT` and `HL_AGENT_KEY`, and `npm install` for the SDK.
   - Run it under a process supervisor (pm2, systemd, or Windows Task Scheduler with `--once` at 00:10 UTC).
4. **Size.**
   - `book.targetVol` sets risk. 0.2 per leg gives ≈ 14% realised volatility and a historical worst drawdown of ≈ 14%.
   - Halve it to 0.1 for roughly half the return and half the drawdown.
   - Raising it doesn't improve the Sharpe ratio; it only scales risk.
5. **Stop.**
   - Create `state/portfolio/KILL`: the engine flattens and idles.
   - To resume after a kill or a drawdown halt: delete `KILL` if present, investigate, then restart with `--reset-halt`.

## Reproduce the research

```bash
node bin/fetch-data.js --from 2020-01         # Binance archive: 1h candles + funding since 2020 (≈1 GB)
node bin/strategies.js                        # every strategy family, in-sample vs out-of-sample
node bin/strategies.js --cost 10              # cost sensitivity
node bin/robust.js                            # parameter robustness grid for the chosen book
```

## What can go wrong

- **Backtest venue ≠ trading venue.**
  - History comes from Binance USD-M perps, including Binance funding. Hyperliquid funding is hourly, and its levels differ by venue.
  - Crowded coins are crowded on both, so the ranking should mostly carry over. Paper trading will show how much.
- **Survivorship.**
  - The universe is today's Hyperliquid listing. Coins that died (LUNA, FTT, …) are missing from the history.
  - The trend leg would have been short most of them as they collapsed. The carry leg is ambiguous.
- **The edge is noisy.**
  - The 95% confidence interval on the Sharpe ratio is wide (≈ 0.4 to 2.7 over six years).
  - Single years have ranged from +4% to +78% at the default risk, and a flat or losing year is entirely possible.
- **Costs.**
  - Turnover is ≈ 90× equity a year. At 6 bp per side (Hyperliquid taker 4.5 bp plus slippage), that costs ≈ 5.5% a year.
  - At 15 bp per side, the out-of-sample Sharpe ratio drops to about 0.5.
  - Use the fee tier you have. Maker execution of the daily rebalance is the obvious improvement.
- **Regime.** Trend following struggles in choppy ranges, and carry can unwind violently in a market-wide deleveraging. The drawdown halt is the backstop.

Not financial advice.
