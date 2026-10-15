# OI-backed momentum (short-term)

The short-horizon strategy in this repo: trades last hours, not weeks. About two trades a day across the 20 most-traded coins.

**The idea.** When a coin makes an unusually large move *up* and **open interest rises at the same time**, new money is opening positions, not shorts covering. Those moves keep going for the next several hours. Go long when that happens, hold 8 hours, get out.

## Result

Backtest, January 2022 → October 2026, on Binance USD-M perps:

- **Data:** 5-minute candles and 5-minute open-interest snapshots, 20 coins.
- **Sizing:** 0.25% of equity at risk per trade, total exposure capped at 1× equity.
- **Costs:** 6 bp per side, plus real funding.
- **Periods:** in-sample 2022–2024; out-of-sample 2025 onward.

| | 2022–2024 (in-sample) | 2025–2026 (out-of-sample) | Full period |
|---|---|---|---|
| Annual return | 42% | **46%** | 44% |
| Sharpe ratio | 1.70 | **1.86** | 1.76 |
| Max drawdown | 18% | **18%** | 18% |
| Trades per day | 2.5 | 1.7 | 2.2 |
| Average trade | +0.50% | +0.93% | +0.62% |

| Full period | |
|---|---|
| Positive months | 65% |
| Positive weeks | 51% |
| Worst week | −9.1% |
| Worst month | −9.4% |
| Best month | +20% |
| Win rate | 47% |
| Average winner | +4.1% |
| Average loser | −2.5% |
| Coins with positive total P&L | 19 of 20 |

| Year | 2022 | 2023 | 2024 | 2025 | 2026 (→ Oct) |
|---|---|---|---|---|---|
| Return | +9% | +43% | +85% | +36% | +44% |

The win rate is under 50%. It makes money because winners are bigger than losers, the way momentum strategies do. **Expect about half of all weeks to be down.** The edge shows up over months, not days.

### Robustness (`bin/oi-momentum.js`)

| Change from default | Sharpe, in-sample | Sharpe, out-of-sample |
|---|---|---|
| Move threshold 2σ / 3σ (default 2.5σ) | 1.64 / 1.75 | 1.81 / 2.08 |
| OI threshold +2% / +4% (default +3%) | 1.42 / 1.84 | 1.55 / 1.90 |
| Hold 6 h / 12 h (default 8 h) | 1.58 / 1.91 | 2.39 / 1.41 |
| Drop the 15-min / 12-h lookback | 1.70 / 1.38 | 1.65 / 1.71 |
| US hours only (12–20 UTC) | 1.92 | 1.82 |
| Top 10 coins only | 1.55 | 1.34 |
| Costs 10 bp per side | 1.36 | 1.59 |
| Shorts too (OI-backed down-moves) | 1.09 | 1.42 |

**Nothing in the neighbourhood breaks it.** Shorts add little, so the default is longs only.

### Why it's believable

| Check | Result |
|---|---|
| Random long entries at the same rate, same coins, same hold (hourly study) | ≈ 0–3 bp per $ traded; Sharpe −0.5 to −1.0 after costs |
| The same big up-moves *without* OI build-up (hourly study) | Positive out-of-sample but near zero in 2022–24. OI is what makes it consistent. |
| Entering one hour late (hourly study) | Out-of-sample edge per $ traded roughly halves (13.5 → 7 bp) |
| Checking every 5 minutes instead of hourly | Better in both periods (Sharpe 1.67 / 1.17 vs 1.37 / 0.99, same rule) |
| BTC-hedged version (hourly study) | Edge drops from ~20 bp to ~8–12 bp per $ traded |

What these mean:

- **Random entries:** the signal's timing is worth roughly +60 bp per trade.
- **Late entries and 5-minute checks:** the edge is front-loaded. The engine reacts at each 5-minute close, never by hand.
- **BTC hedge:** part of the profit is the whole market following through after an OI-backed pump. It's still profit, but trades carry market direction while open.

### How the defaults were picked

- **The original rule** came from an hourly study (`bin/short-term.js`, 2022–24 vs 2025–26), out of about 100 candidates:
  - intraday trend,
  - cross-sectional momentum and reversal,
  - shock follow/fade,
  - order-flow imbalance,
  - OI flush/build,
  - BTC→alt lead-lag.

  Only the OI-backed move family was positive after costs in both periods.
- **The 5-minute refinements** (15-min lookback, 2.5σ, 8 h hold) were each kept only if they improved *both* periods. That means the 2025–26 numbers have been looked at more than once and are not perfectly clean out-of-sample. The flat neighbourhood above is the main reassurance.

## Rules

| | |
|---|---|
| Universe | Crypto perps in `config/universe.json` that trade on Hyperliquid. The top 20 by 7-day $ volume. |
| Check | Every 5-minute close. |
| Trigger | For any window W in {15 min, 1 h, 4 h, 12 h}, both conditions hold. Then go long. |
| — move | log return over W ≥ 2.5 × (5-minute vol over the last 7 days) × √(bars in W) |
| — OI | open interest now ≥ 1.03 × open interest W ago |
| Hold | 8 hours. A new trigger on a coin you already hold extends the hold. |
| Size | A 1σ move over the hold costs 0.25% of equity. Typically $1–3k per trade on a $10k account. Total notional ≤ 1× equity. |
| Execution | IOC limit orders with a slippage cap; reduce-only exits. |
| Safety | Kill switch. Daily loss limit: −6%, flatten and pause until 00:00 UTC. Drawdown halt: −25% from peak. |

Code:

- signal: `src/core/oi-momentum.js` (used by the backtest and the engine);
- engine: `src/exec/momentum-engine.js`;
- research: `src/research/intraday.js`, `bin/oi-momentum.js`, `bin/short-term.js`.

## Using it

```bash
node bin/momentum.js --scan                        # latest 5-minute bar: each coin's move/OI per window and any signal; trades nothing
node bin/momentum.js                               # paper trading on live Hyperliquid prices
node bin/momentum.js --signal binance              # use Binance candles + OI (the research data) for signals
node bin/momentum.js --mode live --testnet         # testnet orders
node bin/momentum.js --mode live --i-understand    # mainnet, real money
```

1. **Pick the signal source.**
   - `hyperliquid` (default): Hyperliquid candles, and OI recorded by the engine at every 5-minute close.
     - Hyperliquid has no OI history endpoint. The 15-minute window works after 15 minutes of running, and the 12-hour window after 12 hours. Restarts keep the recorded history (`state/momentum/`).
     - If the engine is down, the gap means fewer signals until it refills.
   - `binance`: Binance's public 5-minute candles and OI history. This is exactly the data the backtest used, with no warm-up. Binance blocks some regions, including the US.
   - Trading is on Hyperliquid either way.
2. **Paper trade for 2–4 weeks.**
   - `cp config/momentum.example.json config/momentum.json`, then `node bin/momentum.js`.
   - Watch `state/momentum/momentum.log`, `trades.jsonl` and `status.json`.
   - Expect roughly 1–3 trades a day and plenty of small losing days.
3. **Live.**
   - Same setup as the other engines: an API/agent wallet in `.env` (`HL_ACCOUNT`, `HL_AGENT_KEY`) and `npm install`.
   - Use a dedicated account or subaccount.
   - Keep the process running: entries must happen within minutes of the trigger.
4. **Size.**
   - `strategy.riskPerTrade` 0.0025 gave an 18% max drawdown in the backtest.
   - 0.005 with `maxGross` 1.5 roughly doubled both the return and the drawdown (35%).
   - Start at the default or below.
5. **Stop.**
   - Create `state/momentum/KILL`: the engine flattens and stops.
   - To resume: delete it, then restart with `--reset-halt`.

## What can go wrong

- **Hyperliquid OI ≠ Binance OI.**
  - The backtest used Binance's open interest. Hyperliquid's OI is a different (smaller) market; it should rise in the same positioning waves, but that is untested.
  - Use `--signal binance` if you can reach Binance. Otherwise paper-trade long enough to compare.
- **Slippage on fast moves.**
  - Entries happen right after a sharp move, when books are thin. 6 bp per side may be optimistic on smaller coins.
  - At 10 bp the out-of-sample Sharpe ratio was still 1.6, but measure your real fills.
- **Speed.** The backtest enters at the 5-minute close. A few seconds of delay is fine; an hour is not.
- **Clustering.** Pumps come in waves across many coins, which is why total exposure is capped. A market-wide reversal after a wave of entries is the main risk. The worst week in the backtest was −9%.
- **History.** It covers 2022–2026, with OI available from 2022. One bear year (2022) was positive but weak (+9%).

Not financial advice.
