# Volume farming mode

**Goal:** generate as much genuine trading volume as possible for DEX points programs, at close to zero net cost and with no directional bet.

**Measure:** **net PnL per $1M traded.** Your past benchmarks were about **−$33/1M** (Paradex bot, then zero-fee) and **−$250 to −$350/1M** (Extended ETH bot).

## Result

**Strategy:** market-neutral 5-minute pair trading on majors (BTC, ETH, SOL, BNB, XRP, DOGE), taker execution, on a **zero-fee venue**.

| | Value |
|---|---|
| Recommended set | BTC/BNB + ETH/DOGE + SOL/XRP (chosen on 2025 data only) |
| Backtest | Feb 2025 → Oct 2026, $5k account, $3k gross per pair |
| Volume | **$202.7M** ($326k/day, ~$10M/month) |
| Net cost | **−$558 total = −$2.80 per $1M** (at 0.3 bp per side: zero fee + half-spread) |
| 2025 (selection period) | −$5.70 per $1M |
| 2026 (unseen) | +$0.70 per $1M |
| Worst day | −$288 (5.8% of the account) |
| Largest drawdown | ≈ −$1.8k (36% of a $5k account). PnL swings month to month (−$500 to +$860); the drift is ~0. |

Reproduce:

```bash
node bin/farm-portfolio.js --pairs BTC/BNB,ETH/DOGE,SOL/XRP --gross-per-pair 3000 --equity 5000 --cost 0.3
```

## How it works

| | |
|---|---|
| Spread | ln A − ln B (dollar-neutral, β = 1) |
| z-score | against a 6-hour rolling equilibrium (72 five-minute bars), recalibrated every hour |
| Enter | when \|z\| ≥ 1, long the cheap leg / short the rich leg |
| Exit | when z is back inside ±0.5: take the fast half of the reversion |
| Stop | \|z\| ≥ 3.5 |
| Time exit | 3 hours |
| Size | fixed gross per pair, both legs together (e.g. $3k = $1.5k each side) |
| Execution | taker (IOC with a slippage cap), both legs together |

A trade typically lasts minutes to an hour. Each pair does ~18 round trips a day. That turnover is the volume.

Engine code: `src/core/farm-strategy.js`. A test proves it makes exactly the same decisions as the research simulator, `src/research/farm.js`.

## Why this design (the research, `bin/farm*.js`)

1. **Gross edge.** At 5-minute horizons the spread between two majors mean-reverts slightly more than it trends. Measured at mid prices with fills at the next bar, the gross edge is **+0.1 to +0.35 bp per $ traded**, positive on 83–94% of 171 pairs in both periods. The strategy earns back part of the spread instead of paying it all.
2. **Microstructure caveat.** Part of that edge is microstructure (bid-ask bounce). Adding one bar of execution delay cuts it to roughly 0 in 2025 (still +0.2 bp in 2026). So the realistic expectation is "roughly break-even before costs", **not a profit engine**. The planner shows pessimistic/central/optimistic cases.
3. **Taker beats maker here.** Posting post-only orders on a mean-reversion signal gets filled mostly when the spread keeps moving against you, and misses the trades that revert immediately. In a conservative fill model that adverse selection cost **$100–135 per $1M even at zero fees**. Taking liquidity on a zero-fee venue costs only the half-spread.
4. **Majors only.** Alt pairs have similar gross edge but 1–3 bp spreads, which costs ~$100 per $1M.
5. **Fees decide everything.** At 2–4.5 bp taker fees (Paradex API, Extended, Nado, Pacifica, Hyperliquid), this costs $200–470 per $1M whatever the signal. Only zero-fee venues farm cheaply: **Lighter Standard** (0/0, per `docs/DEX_FEES.md`), or any venue/tier with zero taker fees.
6. **Funding carry was investigated as a subsidy.**
   - *Long low-funding / short high-funding basket:* funding pays +4 to +19 bp per $ traded, but the price noise of holding different coins swamps it.
   - *Same-coin hedge across contracts:* clean, but the gap inside one exchange is only ~1% APR. Gaps *between* venues are usually bigger. Track them live with Hyperliquid's `predictedFundings`, which also lists Binance and Bybit.
7. **Points-program rules.** Every program penalises self-trading between linked accounts. This strategy trades two *different* assets against the open book: genuine market-neutral trading, not wash trading.

## Using it

### 1. Plan the size

```bash
node bin/farm-plan.js --equity 5000 --gross-per-pair 3000 --pairs 3
node bin/farm-plan.js --equity 5000 --target-volume 20000000      # size for $20M/month
```

Output: expected volume per day and month, worst day and drawdown at that size, and $ per $1M (pessimistic/central/optimistic) on every venue in `config/venues.json`.

### 2. Paper-trade on live prices

```bash
node bin/engine.js --engine config/farm.example.json        # paper mode, Lighter-like costs
open http://localhost:8787                                   # engine card shows volume and cost per $1M
```

Run it for a few days. The engine card's **cost per $1M traded** is the number to watch. It should hover around −$30 to +$10.

### 3. Go live on Lighter

1. `pip install lighter-sdk` (Python 3.10+; installs the official signer for Windows, macOS and Linux).
2. On Lighter, create an **API key** for your account (not your wallet key). Note your account index and the API key index.
3. Start the bridge (localhost only):

   ```bash
   set LIGHTER_URL=https://mainnet.zklighter.elliot.ai
   set LIGHTER_ACCOUNT_INDEX=...
   set LIGHTER_API_KEY_INDEX=...
   set LIGHTER_API_PRIVATE_KEY=...
   python src/exec/lighter_bridge.py
   ```
   (PowerShell: `$env:LIGHTER_ACCOUNT_INDEX="..."` etc.; macOS/Linux: `export LIGHTER_ACCOUNT_INDEX=...`.)

4. Copy `config/farm.example.json` to `config/farm.json`, set `"mode": "live"`, and run:

   ```bash
   node bin/engine.js --engine config/farm.json --mode live --i-understand
   ```

5. Start small (e.g. `grossPerPair: 500`), check fills and the cost per $1M for a day, then scale.

Same safety controls as the main engine (`docs/RUNBOOK.md`):

- kill switch: `state/farm/KILL`,
- daily loss limit (2% in the farm config),
- drawdown halt (10%),
- leg reconciliation: a missing leg is retried, then the filled one is unwound.

## Not verified

- **The Lighter connector has not been run against Lighter's live API.** The real SDK installs and its native signer loads, and the bridge and broker logic are unit-tested against fakes. Lighter's API wasn't reachable from the build environment. Run it with a tiny size first.
- **Lighter Standard limits:** 60 requests/min, and taker orders are delayed 300 ms. Three pairs on 5-minute bars use a few requests a minute. The 300 ms delay is the kind of thing that turns the optimistic case into the central one.
- **Spreads:** the 0.3 bp half-spread for majors is an estimate. One third-party snapshot put all-in cost for a $100k BTC market order on Lighter at 0.5 bp. Smaller orders cost less. Measure your own fills.
- **Points programs change.** Check what each venue currently rewards (volume, maker volume, open interest) and its wash-trading rules before scaling. `docs/DEX_FEES.md` is a snapshot from 2026-10-15.
