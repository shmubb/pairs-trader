# Strategy specification

What the system does at every step, and why. Parameter names refer to
`config/default.json` (written for 1-hour bars; other bar sizes are rescaled
automatically by `src/core/timeframe.js`).

## 1. The spread

For a pair (A, B), with log prices a = ln A, b = ln B:

```
spread  s = a − β·b
```

- **β (hedge ratio)** — `model.hedge`:
  - `"ratio"` (**default**): β = 1, a dollar-neutral log ratio. Equal dollars in each leg.
  - `"kalman"`: a slowly adapting regression β.
  - `"ols"`: the OLS slope of a on b over the formation window.

  The post-mortem's instinct was that a regression β beats β = 1. On real data it didn't. A 30-day OLS β fits noise, and its residual looks more stationary than it really is. Out-of-sample, β = 1 and Kalman both beat OLS (docs/RESEARCH.md, round 1). With β = 1 the cointegration test uses the stricter plain-ADF critical values; with an estimated β it uses Engle-Granger values.
- The spread is modelled as an **Ornstein-Uhlenbeck process** fitted by AR(1) on the formation window (`model.formationBars`, 720 h = 30 days):
  - **μ** — equilibrium level, **σ** — equilibrium standard deviation, **half-life** = ln 2 / θ — how long it takes to close half the gap.
- **z = (s − μ) / σ.** The parameters are re-estimated every `model.recalEvery` bars (24 h) and held fixed in between, so z only moves because prices move.

### Why not a rolling 24-hour mean/std (the old method)?

When the ratio trends, a short rolling mean chases it, so z collapses toward 0 while the position keeps losing. The signal says "reverting" precisely when it isn't. In a sustained break, z pins at 3+ for days as the mean drags behind. The OU equilibrium from a 30-day window, refitted daily, doesn't chase intraday moves. Every trade's stop is also measured on the parameters frozen at entry (section 4).

## 2. Is the pair tradeable right now? (gates)

A z-score only means something if the spread actually mean-reverts. Every gate must pass for a new entry (`gates.*`):

| Gate | Default | Why |
|---|---|---|
| Cointegration p-value (ADF / Engle-Granger) | ≤ 0.05 | Spread is stationary on the formation window (ADF on the residual, MacKinnon p-values; matches statsmodels). |
| Half-life | 3–120 h | Too fast = noise/costs; too slow = capital tied up while the regime changes underneath. |
| Hurst exponent | ≤ 0.55 | Above 0.5 the spread trends. |
| Return correlation (30 d / 3 d) | ≥ 0.6 / ≥ 0.4 | The legs must move together, and still be moving together recently. |
| Spread volatility vs normal | ≤ 2.5× | A volatility blow-out means the fitted σ no longer describes the spread. |
| β | 0.2–5 | Implausible hedge ratios mean a broken fit. |
| Leg impulse | ≤ 2σ over 24 h | One leg is in a crash, pump or news move. In the trade study, results got steadily worse with bigger impulses. |
| Positioning (open interest) | moving leg's OI rose ≤ 5% over 24 h | OI building behind the move means new, often informed, positioning, and it reverted worst in both periods. OI falling (liquidations, stop-outs) reverted better. The engine records OI itself, so this gate is inactive for its first 24 h. Unknown OI passes. |
| Long-window z | not > 3 on the same side | If the spread is also extreme on a 90-day window, it's a trend, not a wobble. |

The research (docs/RESEARCH.md) shows these gates are the single biggest improvement. Removing them roughly quadruples the number of trades and the losses.

## 3. Entry

All of:

1. **|z| ≥ `entry.z` (2.0).** Direction: z < 0 → long A / short β·B (A is cheap); z > 0 → the mirror.
2. **|z| ≤ `entry.maxEntryZ` (2.6)** for the first tranche. Entries beyond 2.5 lost more in both periods, because they are more often breaks than opportunities.
3. **Stall confirmation** (`entry.confirm = "stall"`): |z| must have come back at least `entry.stallGiveback` (0.15σ) from its extreme of the last 12 bars. You enter after the spread stops extending, not while it's still running away — "impulse → extreme → stall → entry".
4. **Funding cap**: no entry if funding would cost more than `entry.maxCarryCost` (5 bp) over the expected hold. Trades that paid more than 5 bp were the worst carry bucket in both periods.
5. **Edge vs cost**: the expected reversion move ((|z| − exit z) × σ), plus any funding the position earns over the expected hold, must be ≥ `entry.minEdgeCostRatio` (2.5×) the round-trip fees and slippage on both legs plus any funding it pays. This formalises "don't go in at a 1% gap, wait for 2–3%" and adapts to each pair's volatility.
6. **Session / event filter**: no new entries from 2 h before to 1 h after CPI, NFP, FOMC, PPI or GDP releases (`sessions.*`). Hour-of-day, weekend and "13th–15th of the month" filters showed no consistent effect across periods, so they are available but off.
7. **Risk layer allows it**: daily loss limit not hit, no drawdown halt, not in a losing-streak cooldown, under `risk.maxConcurrentPairs`, and neither coin is already used by another open pair.
8. **Not in a post-stop cooldown** for this pair and direction (`entry.cooldownBarsAfterStop`, 48 h).

## 4. Position size — sized from the stop

```
budget        = riskPerTrade × equity                 (1%)
loss per $1   = σ × Σ wᵢ·(stopZ − zᵢ) + round-trip cost
leg A total   = budget / loss-per-$1                  (all tranches)
leg B total   = β × leg A
```

zᵢ are the ladder levels (section 5). The worst case — every tranche filled, then the stop — loses ≈ 1% of equity. A volatile spread (big σ) automatically gets a smaller position. Then caps apply:

- gross notional ≤ `risk.maxGrossLeverage` × equity (3×) across everything open,
- each leg ≤ `risk.maxLegShareOfVolume` (0.2%) of its 24 h volume,
- per-coin exposure ≤ `risk.maxAssetExposure` × equity,
- every tranche ≥ the $10 exchange minimum.

## 5. When to add ("double down") — the pre-budgeted ladder

`ladder.levels`: 50% at entry, 30% at +0.75σ further, 20% at +1.25σ further. With entry at z = 2 that's 2.0 / 2.75 / 3.25, all well inside the 5.0 stop.

Because the size in section 4 already assumes every tranche fills, **adding never raises the maximum loss**. That is the difference from the 2/25 liquidation in the trading journal, where adding size raised the risk. An add happens only if:

- the gates still pass (the relationship hasn't broken),
- the spread has stalled again (same giveback rule as entry),
- at least `ladder.minBarsBetweenAdds` (3) bars since the last add,
- less than `ladder.noAddAfterTimeFraction` (50%) of the time stop has elapsed,
- the risk layer allows new risk.

What the data says, in plain terms:

- **Adds lose on average.** Trades that added once averaged −0.43R, and twice −0.6R. Trades that never needed an add were around break-even.
- **The ladder is still the safer way to size.** It starts at half size, so returns and drawdown are smaller, and its risk-adjusted result (Sharpe) matches a single full-size entry.
- **Bottom line:** never add outside the plan. If you want simpler behaviour, set `ladder.enabled: false`. That puts the full risk budget on the first, stall-confirmed entry and makes no adds.

## 6. Exits — the part the old system didn't have

Checked every bar, in this order. In the engine, the stop is also checked intrabar on live prices.

| Exit | Rule | Why |
|---|---|---|
| **Stop** | Frozen-model z reaches ±`exit.stopZ` (5.0) | Uses β, μ, σ frozen at entry, so a drifting mean can't hide the loss. This truncates the tail that ended the old strategy. A wider stop does better than 3 or 4: sizing comes from the stop distance, so the position is smaller and noise doesn't shake it out. Worst-case loss stays 1% either way. |
| **Dollar backstop** | Loss ≥ `exit.dollarStopR` (1.25) × planned max loss | Gaps, model error. |
| **Take profit** | Frozen z back to `exit.z` (0, the mean), or live z there while the trade is in profit | "The spread closes and PnL is green." |
| **Time stop** | Held ≥ `exit.timeStopHalfLives` (3) × half-life (min 12 h, max 14 d) | If it hasn't reverted in ~3 half-lives, the relationship has probably changed. Close regardless of PnL. |
| **Regime break** | Cointegration p > 0.5 at 3 recalibrations in a row | The thing you're trading no longer exists. |
| **Funding drain** | Funding paid > 50% of expected edge | Carry is eating the trade. |
| **Account** | Daily loss limit / drawdown halt / kill switch | Flatten everything. |

Optional partial profit: `exit.partialZ` takes `exit.partialFraction` off early (off by default).

## 7. When to hedge

The pair is itself the hedge (long one asset, short a β-weighted other), so "hedging" here means keeping that hedge correct and cutting risk when the hedge stops working:

- **Hedge-ratio drift** (with the `kalman` or `ols` hedge): when re-estimated β moves more than `exit.rebalanceBetaDrift` (15%) from the position's β, leg B is resized to the new β. The frozen z is kept continuous, so the stop level doesn't jump.
- **Correlation/volatility deterioration** shows up as failing gates. That blocks adds, and a sustained cointegration loss forces an exit.
- **Account level**: the daily loss limit and drawdown halt flatten everything instead of hedging it.

## 8. Funding

Hyperliquid charges funding hourly. For a long-spread position, carry per hour = −funding(A) + β × funding(B) per $1 of leg A. It is used three ways:

- in the **edge test** — paying carry raises the bar, earning carry lowers it,
- as an **exit** — funding drain,
- on the **risk ticket** — $/day at the planned size.

## 9. Liquidation / stop heat (dashboard)

A model, not observed data (see `src/core/liquidity.js`):

- liquidation clusters estimated from where volume traded × typical leverage, with levels price has already swept removed,
- stop clusters at round numbers and recent swing highs/lows,
- the live order book within ±1%.

It shows where a leg could get wicked and where a cascade would create an overshoot. The research tests whether OI-flush divergences revert better.

## 10. Execution

`exchange.entryStyle` sets how entries are executed:

- `"hybrid"` (default in the example engine config): rest a post-only order on the thinner leg at the touch. When it fills, hedge the filled fraction on the other leg with an IOC.
- `"taker"`: both legs IOC.

The default `costs` (0.03% fee, 0.015% slippage per leg per side) are a blend for hybrid entries and taker exits. Costs decided almost every result in the research, so execution quality matters as much as the signal.


- Both legs go in **one signed order action** as IOC limits capped at mid ± 0.5% (retries up to 1.5%).
- Each leg is reconciled individually. A missing leg is retried. If it can't be completed, the filled leg is unwound reduce-only.
- Margin for both legs is checked **before** anything is sent.
- Exchange leverage is set per leg (default 5× cross), so liquidation prices sit far beyond the spread stop.
- Signing uses an API (agent) wallet, which can't withdraw. Account state is read from the main address.
