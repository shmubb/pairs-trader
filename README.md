# pairs-trader

Crypto perp trading for Hyperliquid: research toolkits, backtesters, a live
dashboard and paper/live execution engines that run the **same** signal and risk
code as the backtests. Three strategies live here:

- **carry + trend book:** the one that makes money;
- **statistical-arbitrage pairs:** the original project, now rebuilt;
- **volume farming:** for DEX points.

It replaces the original single-file app (kept at [`legacy/index.html`](legacy/index.html)).
That app traded a z-score of the ETH/BTC ratio over a rolling 24-hour window
with no stop, no time limit, no hedge ratio and no funding model, and it lost
money the way the post-mortem predicted. Replaying its rules on the same data
here loses the whole account (see [`docs/RESEARCH.md`](docs/RESEARCH.md)).

## What's in it

| Piece | Where | What it does |
|---|---|---|
| Signal core | `src/core/` | Cointegration (Engle-Granger, MacKinnon p-values, validated against statsmodels), OU half-life, Hurst, Kalman/OLS hedge ratio, regime and session gates, stall-confirmed entries |
| Risk engine | `src/core/risk.js`, `strategy.js` | Size from the stop, pre-budgeted scale-in ladder, frozen-model z stop, time stop, regime-break and funding exits, hedge-ratio rebalancing, daily loss limit, drawdown halt, losing-streak cooldown |
| Backtester | `src/core/backtest.js` | Bar-by-bar, fills on the next open, fees + slippage + funding, no look-ahead (tested) |
| Research | `bin/scan.js`, `sweep.js`, `trade-study.js`, `analyze-scan.js` | 1,485-pair scan, in-sample vs out-of-sample, parameter sweeps across a basket, entry-condition study (hours, sessions, events, volume, OI flushes) |
| Data | `src/data/` | Binance public archive (multi-year perp candles, funding, open interest) for research; Hyperliquid public API for live |
| Dashboard | `index.html`, `src/ui/` | Live signal, causal z-chart, gates, risk ticket, regime, funding carry, sessions/macro events, modelled liquidation & stop heat with order-book depth, scanner, read-only positions, alerts, engine view |
| Engine | `src/exec/`, `bin/engine.js` | Paper and live Hyperliquid trading: both legs in one signed action, leg reconciliation with unwind, margin pre-check, intrabar stops, kill switch, state recovery |
| Portfolio book | `src/core/xs-strategies.js`, `src/exec/portfolio-engine.js`, `bin/portfolio.js` | Carry + trend across ~20 perps: daily target book, paper/live Hyperliquid execution, drawdown halt, kill switch |
| Strategy research | `src/research/portfolio.js`, `bin/strategies.js`, `bin/robust.js` | Multi-asset backtester (next-open fills, costs, real funding); trend, breakout, cross-sectional momentum/reversal, carry and funding-contrarian families; IS/OOS and robustness grids |

## Quick start

```bash
# Node 22.12+
node bin/fetch-data.js            # download history (≈500 MB, a few minutes)
node bin/backtest.js ETH BTC      # new rules
node bin/backtest.js ETH BTC --legacy   # old rules, same data
npm test                          # 35 tests (+ npm run test:py for the Lighter bridge)

cp config/engine.example.json config/engine.json
node bin/engine.js                # paper trading + dashboard at http://localhost:8787
```

The dashboard also works as a static page (GitHub Pages): open `index.html`.

## Carry + trend book (the money-making strategy)

The pairs signal on its own came out at roughly break-even after costs (see `docs/RESEARCH.md`). The strategy that held up out-of-sample is a **daily-rebalanced book of crypto perps** with two legs:

- **funding carry:** long the lowest-funding coins, short the highest;
- **trend following:** long or short each coin by the sign of its multi-week returns.

The two legs are nearly uncorrelated.

Backtest, June 2020 → October 2026, after 6 bp/side costs and real funding:

- **Sharpe 1.57, 24% a year, max drawdown 14%.**
- **On the unseen 2024–2026 period:** Sharpe 1.17, 17% a year.
- **Every calendar year was positive**, including 2022.

```bash
node bin/portfolio.js --plan     # today's target book and orders (trades nothing)
node bin/portfolio.js            # paper trading on live Hyperliquid prices
```

Rules, results, risks and how to go live: [`docs/CARRY_TREND.md`](docs/CARRY_TREND.md).

## Volume farming mode

A separate, research-backed mode for farming DEX points. It runs market-neutral 5-minute pair trading on majors and generates large two-asset volume at about **−$3 per $1M traded** in backtest. That was $203M of volume on a $5k account over 20 months, on a zero-fee venue. The engine runs it in paper mode or live on Lighter through `src/exec/lighter_bridge.py`.

```bash
node bin/farm-plan.js --equity 5000 --gross-per-pair 3000 --pairs 3   # volume, cost, risk per venue
node bin/engine.js --engine config/farm.example.json                  # paper-farm on live prices
```

Details, caveats and Lighter setup: [`docs/FARMING.md`](docs/FARMING.md). Venue fees: [`docs/DEX_FEES.md`](docs/DEX_FEES.md).

## Read next

- [`docs/CARRY_TREND.md`](docs/CARRY_TREND.md) — the carry + trend book: research, rules, running it.
- [`docs/STRATEGY.md`](docs/STRATEGY.md) — every pairs rule (entry, sizing, when to add, when to hedge, when to cut) and why.
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — what the data says, including where the edge is thin.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — running the dashboard, research, paper, testnet and live; safety controls; incident handling.
- [`docs/HYPERLIQUID_API.md`](docs/HYPERLIQUID_API.md) — exchange API notes the execution code relies on.

Not financial advice. Paper-trade first; the research shows why.
