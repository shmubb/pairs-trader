# Runbook

How to run each piece, and what to do when something goes wrong.

## 0. Requirements

- Node.js **22.12 or newer** (`node --version`). Nothing else for research and paper trading.
- For live/testnet trading: `npm install` once (pulls the official-SDK-compatible `@nktkas/hyperliquid` and `viem`, pinned).
- The dashboard needs nothing — open `index.html` from GitHub Pages, or let the engine serve it.

## 1. Dashboard (read-only)

Either:

- **GitHub Pages / any static host** — the page talks to Hyperliquid directly from your browser.
- **Locally with the engine** — `node bin/engine.js`, then open http://localhost:8787. You get everything the static page shows plus the engine's live state, positions and log.

What to look at, top to bottom:

1. **Action banner** — `ENTER`, `WAIT` (signal forming but a condition isn't met — the reasons say which), `NO TRADE` (a tradeability gate fails: don't touch this pair right now), or the engine's state if it's running this pair.
2. **Z-score chart** — exactly what the model saw at each bar (no hindsight). Yellow/purple dashed = entry, faint dotted = scale-in levels, red = stop, green = target.
3. **Risk ticket** — enter account size and risk %. It gives each tranche's size per leg (USD and coins), the stop, the maximum loss if every tranche fills and the stop is hit, the target, the time stop, edge vs costs, and funding carry per day. "Copy ticket" if you trade by hand.
4. **Gates** — hover any row for why it matters.
5. **Liquidation & stop heat** — modelled, not observed (no exchange publishes this). The orange dashed line is the leg price at which *this trade's* spread stop would fire, holding the other leg still.

## 2. Research (on your machine)

```bash
node bin/fetch-data.js                        # ~500 MB of hourly history for the universe (Binance archive)
node bin/fetch-data.js --metrics              # open interest + long/short ratios (slow: daily files)
node bin/backtest.js ETH BTC                  # one pair with the current config
node bin/backtest.js ETH BTC --legacy         # the old app's rules, same data
node bin/backtest.js LINK DOT --from 2025-01-01 --set entry.z=2.5 --trades
node bin/scan.js                              # every pair, in-sample vs out-of-sample
node bin/analyze-scan.js research/scan-1h.json
node bin/sweep.js                             # config variants averaged across a basket
node bin/trade-study.js                       # which entry conditions win/lose
```

Everything writes JSON into `research/`. `docs/RESEARCH.md` explains the findings.

## 3. Paper trading (do this for weeks first)

```bash
cp config/engine.example.json config/engine.json   # pick pairs, interval, paper equity
node bin/engine.js                                  # mode "paper" by default
```

Paper mode uses live Hyperliquid prices and funding, simulated fills at mid ± slippage, real fee rates. State is in `state/engine-paper.json`, trades in `state/trades.jsonl`, log in `state/engine.log`. Stop with Ctrl-C: positions and state persist; restart picks up where it left off.

## 4. Testnet, then live

1. On app.hyperliquid.xyz → **API**, create an **API wallet** and authorise it. Copy its private key. An API wallet can trade but **cannot withdraw or transfer** — if the key leaks, funds can't be moved out. Never put your main wallet's key anywhere in this project.
2. `cp .env.example .env` and fill in `HL_ACCOUNT` (main address) and `HL_AGENT_KEY` (API wallet key). `.env` is git-ignored.
3. Testnet: `node bin/engine.js --mode live --testnet` (testnet needs its own API wallet, created on the testnet site).
4. Mainnet: `node bin/engine.js --mode live --i-understand`. Start with a small account and `risk.riskPerTrade` at 0.25–0.5%.

The engine sets each leg's exchange leverage to `exchange.leverage` (default 5×, cross). That is *exchange* leverage (how much margin is posted), separate from `risk.maxGrossLeverage` (how big positions may get relative to equity). Keeping exchange leverage moderate keeps liquidation prices far beyond the spread stop.

## 5. Safety controls

| Control | Where | What it does |
|---|---|---|
| Kill switch | create `state/KILL` | Next poll: closes every engine position, opens nothing. Delete the file to resume. |
| Daily loss limit | `risk.dailyLossLimit` (3%) | Flattens and blocks new risk until the next UTC day. |
| Drawdown halt | `risk.maxDrawdownHalt` (12%) | Flattens and halts. Review, then restart with `--reset-halt`. |
| Losing-streak cooldown | `risk.consecutiveLossCooldown` (3) | Pauses new entries for `risk.cooldownBars`. |
| Intrabar stop | engine | Re-checks the spread stop every poll on live mids; needs two polls in a row so one wick can't trigger it. |
| Leg reconciliation | live broker | Both legs go in one signed action; a failed leg is retried, and if it can't be completed the filled leg is unwound. |
| Margin pre-check | live broker | Refuses to send either leg unless withdrawable margin covers both with 50% headroom. |
| One pair per coin | engine | Never opens two pairs sharing a coin (Hyperliquid nets positions per coin). |
| Mainnet guard | CLI | Live mainnet needs `--i-understand`. |

## 6. When something goes wrong

- **"engine thought a position was open but the exchange shows none"** — you (or a liquidation) closed it outside the engine. The engine clears its record; check `state/engine.log`.
- **"exchange holds … the engine didn't open"** — a manual position in one of the legs. The engine leaves it alone and won't trade that pair until it's gone.
- **"close incomplete, retrying next tick"** — a close order didn't fully fill. It retries every poll. If it persists (asset halted, extreme volatility), close manually on the website.
- **"could not complete both legs — unwinding"** — the second leg couldn't be filled within the slippage cap. The first leg was sold back. Check the log for the unwind fill.
- **Rate limits (429)** — the client backs off automatically. Fewer pairs or a longer `pollSeconds` reduces load.
- **Power cut / crash** — restart the engine. It rebuilds the model from Hyperliquid history, restores open positions from the state file, and reconciles against the exchange before trading.
- **You want out now** — `touch state/KILL` (or close on the website, then restart the engine so it reconciles).

## 7. What the engine does not do

- It doesn't place resting stop orders on the exchange: the stop is on the *spread*, which no exchange order type can express. If the engine is off, nothing protects an open position except your exchange-side liquidation price. Run it on an always-on machine (or close positions before shutting down).
- It trades only the pairs in `config/engine.json`. Pair selection is your decision, informed by the scanner and `docs/RESEARCH.md`.
