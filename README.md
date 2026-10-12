# pairs-trader

Statistical-arbitrage pairs trading for Hyperliquid perps: a research toolkit, a
backtester, a live dashboard and a paper/live execution engine, all running
the **same** signal and risk code.

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

## Quick start

```bash
# Node 22.12+
node bin/fetch-data.js            # download history (≈500 MB, a few minutes)
node bin/backtest.js ETH BTC      # new rules
node bin/backtest.js ETH BTC --legacy   # old rules, same data
npm test                          # 25 tests

cp config/engine.example.json config/engine.json
node bin/engine.js                # paper trading + dashboard at http://localhost:8787
```

The dashboard also works as a static page (GitHub Pages): open `index.html`.

## Read next

- [`docs/STRATEGY.md`](docs/STRATEGY.md) — every rule (entry, sizing, when to add, when to hedge, when to cut) and why.
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — what the data says, including where the edge is thin.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — running the dashboard, research, paper, testnet and live; safety controls; incident handling.
- [`docs/HYPERLIQUID_API.md`](docs/HYPERLIQUID_API.md) — exchange API notes the execution code relies on.

Not financial advice. Paper-trade first; the research shows why.
