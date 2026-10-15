# Perp DEX fees and points for delta-neutral volume farming (snapshot 2026-10-15)

**How this was researched.** WebFetch could not resolve DNS for any host during this session, so I could not open any official doc page directly. Every fact below comes from search-engine snippets of the cited URL. Confidence tags:
- **[O]**: an official source (venue docs, venue X account or venue blog) as quoted in search snippets.
- **[S]**: a secondary source (news, review or aggregator site; many carry referral links).
- **[K]**: my prior knowledge from before mid-2026, not re-verified this session.
- **[?]**: unknown or conflicting.
- **OLD**: the source is more than 6 months old (before about 2026-04).

Fees are in bps (1 bp = 0.01%). A negative maker fee is a rebate. Before deploying capital, confirm every fee against the venue's live API or fee endpoint.

## 1. Summary table

| Venue | Base maker / taker (bps) | Zero-fee or rebate options | Funding | Post-only | Points / token status (Oct 2026) |
|---|---|---|---|---|---|
| **Hyperliquid** | 1.5 / 4.5 [O] | Maker rebates of -0.1/-0.2/-0.3 bps at >0.5%/1.5%/3% share of 14-day maker volume [O]. HYPE staking cuts fees 5-40% [O]. HIP-3 growth-mode markets cut protocol fees by about 90% [S, 2026-04] | 1h (8h-formula rate /8) [O] | Yes, TIF `Alo` [K] | HYPE launched Nov 2024. No active HL points [K] |
| **Lighter** | Standard: 0 / 0. Premium: 0.4 / 2.8 [O, docs; S dated 2026-09-26] | Standard is zero-fee but takers get 300 ms latency, versus 140 ms on Premium. LIT staking gives up to 30% off Premium (0.28/1.96 bps at 500k LIT) [S] | 1h [S] | Yes [K] | LIT TGE 2025-12-30 [S]. No "Season 3". Weekly points on Robinhood Chain since 2026-08-10 (2x through Robinhood Wallet) [O docs / S] |
| **Paradex** | Retail UI: 0 maker / 0.75 taker since 2026-03-25 (was 0/0 "Zero Fee Perps"). Pro/API: 0 maker / about 2 taker [O X post; taker S/?] | Retail flow matches only RPI liquidity. Pro maker 0 [O] | Continuous ("Funding V2", from 2026-06-16), 8h-normalised [S] | Yes, `POST_ONLY` [K] | DIME TGE about 2026-03-05 [S]. XP Season 3 from 2026-02-01, 4M XP/week [O docs] |
| **Extended** | 0 / 2.5 (most sources) or 2 / 4 (one review) [S, ?] | Referral 10% discount [S] | 1h [K] | Yes [K] | Pre-token. Points weekly (about 1.2M/wk in S1). Final cap 70M points after anti-abuse slashing [S]. Moving settlement Starknet to Arc the week of 2026-10-19; convert USDT/wBTC by 2026-10-21 12:00 UTC or face liquidation [S, Sept 2026] |
| **Variational Omni** | 0 / 0 explicit; cost is in the RFQ spread (about 4-6 bps reported) [S] | Random loss refunds, 1-5% odds [S] | [?] | No (RFQ, no order book). Trading API "to be published" before TGE [S] | Pre-token. About 150k points/week, continuing until VAR TGE in Q4 2026; 32% genesis airdrop (announced 2026-09-24) [S citing official] |
| **Nado (Ink)** | 1 / 3.5 entry [S]. Down to -0.8 / 1.5 at top tier [O docs] | Monthly tiers on 30-day spot+perp volume [O] | 1h, capped at ±2%/day [O] | Likely (Vertex lineage) [K, ?] | No NADO token. Weekly points expected to map to $INK; Ink TGE expected Q3-Q4 2026 [S, ?] |
| **Aster** | USDT perps: 0 / 4. USD1 perps: 0 / 0.5 (one source says 4) [S, 2026-06 to 09] | Maker 0% on all perps since 2026-02-02 [S]. 5% off when paying in ASTER [S] | Mostly 8h, some 4h/1h, Binance-style [K, ?] | Yes, `GTX` [K] | ASTER live since 2025. Stage 6 was the final stage; vested claim 10-28 to 11-28 [S]. A WLFI/USD1-paid trading+OI points campaign runs 2026-08-31 to 12-31 [S, unverified] |
| **edgeX** | 1.2-1.8 / 3.8 (sources conflict) [S, OLD] | Fees fall to 0 maker at the top VIP tier. "Trade to Earn" refunds 100% of fees in USDC+EDGE [S] | 1h per docs, but the example and some markets show 4h [O, conflicting] | [?] Docs list only FOK/GTT/IOC [O] | EDGE TGE 2026-03-31; pre-TGE points ended [S] |
| **GRVT** | -0.01 / 4.5 (L1), down to -0.3 / 2.4 at top [S; MM-program page O] | Maker rebate on every tier. -1 bp maker on retail RWA perps for 3 months from 2026-09-07 [S] | 8h on sampled markets [S, ?] | Yes [K] | GRVT TGE 2026-07-30; S1+S2 closed with a 280M pool. No official Season 3 [S] |
| **Backpack** | 2 / 5 base [S, July 2026] | 30-day volume tiers [S] | 1h since 2025-08-20 [O] | Yes, `postOnly` [K] | BP TGE scheduled 2026-03-23. S4 ended 2026-01-28, then an "Epilogue" campaign [O blog]. No active season found [?] |
| **Pacifica (Solana)** | 1.5 / 4 for <$5M in 14 days; 0 maker at VIP1 (>$100M) [S, docs mirror] | | 1h [S, docs mirror] | Yes (ALO) [K] | Pre-token. Season 1 still running, weekly Thursday snapshots (500k or 10M/wk, sources conflict). No TGE date [S, 2026-10] |
| **Ondo Perps** | 1 / 2.5 or 1.5 / 3.5 [S, conflicting] | | [?] | [?] | 5M Ondo Points/week since 2026-07-23 for volume + OI. Payout probably in ONDO [S] |
| **Ethereal / Reya / StandX** | [?] | | [?] | [?] | Active points programs: Ethereal S1 (USDe margin), Reya weekly points (40% of supply), StandX multi-stage plus maker points [S] |

## 2. Spreads and liquidity (weak data)
- I found no rigorous 2026 spread study. One snapshot gave the all-in cost of a $100k BTC market buy (fee + half-spread + impact) as Lighter 0.5 bps and Paradex 1.2 bps [S: liquidview.app/blog/best-perp-dex-2026]. GRVT claims under 0.5 bps on BTC for $200k+ orders [S, vendor claim].
- Hyperliquid has the deepest book for BTC/ETH/SOL and about 58% of perp DEX volume [S]. In my prior knowledge, its BTC/ETH top-of-book is typically about 0.1-0.3 bps and mid-cap alts are about 1-5 bps [K, ?].
- Omni's cost is entirely the quoted spread: 4-6 bps reported to users, while the OLP hedges at 0-2 bps [S: blockeden.xyz 2026-05-03].
- For mid-caps (LINK, DOT, ADA, AVAX, ATOM, NEAR, INJ, HBAR, OP, ARB, kSHIB, ONDO, PYTH), no per-venue spread data was found [?]. Measure it directly from the L2 books.

## 3. Asset listings (requested alts)
- **Hyperliquid:** all of LINK, DOT, ADA, AVAX, ATOM, NEAR, INJ, HBAR, OP, ARB, kSHIB, ONDO and PYTH are listed as main-dex perps [K]. Check `info{"type":"meta"}`.
- **Aster:** Binance-style broad listings, likely including 1000SHIB [K, ?].
- **Paradex:** 100+ perps [O, ZFP launch post]. **Variational:** about 450 markets [S, 2026-05].
- **Lighter:** majors confirmed (BTC, ETH, SOL, HYPE, XRP, BNB), plus equities and FX perps [S]. Specific alts not verified [?].
- **Extended, Nado, edgeX, GRVT, Backpack, Pacifica:** I could not verify these specific alts [?]. Pull each venue's markets endpoint before choosing pairs. Expect thinner alt coverage on Backpack, Nado and Extended.

## 4. Anti-wash, self-trade and API notes relevant to delta-neutral farming
- **Lighter:** clawed back Season 2 points from sybil, self-trading and wash-trading, then redistributed them to the community (Dec 2025) [S: coinfomania, mexc/359319]. Standard (zero-fee) accounts are limited to **60 requests/min**; Premium gets 24,000 weighted/min [O: apidocs.lighter.xyz/docs/rate-limits]. In practice, HF bots need Premium, which means paying fees.
- **Paradex:** the zero/low-fee retail tier applies only to UI orders, which fill only against RPI. API traders pay Pro fees [O/S]. A guide says XP rewards "real" volume and tight maker orders and to avoid wash trading [S]. The official exclusion rules were not found [?].
- **Extended:** the scoring formula is private. Points are capped at 70M after "anti-abuse adjustments" [S].
- **Pacifica:** self-trade prevention cancels the resting order [O: pacifica.gitbook.io/docs/trading-on-pacifica/self-trade-prevention]. Wash/sybil activity is retroactively slashed. A guide says hedged long/short against the open market is fine, but cross-wallet self-matching is not [S].
- **Aster:** archived Stage 2 rules weighted taker volume at 2x maker [S]. There are community wash-trading allegations [S, unverified].
- **General pattern:** every active program filters self-matching across linked wallets, and several (Lighter, Paradex, Ondo, Aster) also reward OI or holding time. A delta-neutral leg on two *different* venues is the low-risk form. Two opposing accounts on the same venue is the pattern that gets slashed.

## 5. Uncertainty and staleness flags
- **Lighter Premium fees:** older 0.2/2 bps figures (2026-02) conflict with 0.4/2.8 [O docs, about 2026-09]. Use 0.4/2.8.
- **Paradex:** the API taker fee after the 2026-03-25 change is unconfirmed. About 2 bps is from 2025 materials.
- **edgeX:** all fee sources predate or sit near the 2026-03 TGE (OLD). Post-only support is unconfirmed.
- **Extended:** fees conflict (0/2.5 vs 2/4). The venue changes chain about 2026-10-19, so expect API endpoint changes.
- **Aster:** the USD1 taker fee conflicts (0.5 vs 4 bps). Pro-mode figures of 1/3.5 in one review look like the 2025 schedule (OLD).
- **Backpack:** whether the TGE happened on 2026-03-23 was not confirmed by a post-event source.
- **Nado:** the entry tier is from a secondary farming tracker. Only the top-tier figures (-0.8/1.5) come from the docs snippet.
- **Hyperliquid:** some guides give conflicting top-tier volume thresholds. Use the base tier of 1.5/4.5 [O].

## 6. Sources (all accessed 2026-10-15 via search snippets)
- Hyperliquid fees: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees ; funding: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding ; HIP-3 discount: https://hyperliquidguide.com/guides/fees
- Lighter fees: https://docs.lighter.xyz/trading/trading-fees ; https://cipher-intelligence.io/blog/lighter-dex-zero-fees-review/ (2026-09-26) ; rate limits: https://apidocs.lighter.xyz/docs/rate-limits ; RH Chain points: https://docs.lighter.xyz/points-program/lighter-on-robinhood-chain-points ; clawback: https://coinfomania.com/lighter-xyz-sybil-filtering-lit-airdrop-premarket/ ; funding: https://blockworks.com/analytics/lighter/lighter-perpetual-futures/lighter-funding-rates
- Paradex fee change: https://x.com/paradex/status/2036439864443543880 (2026-03) ; ZFP: https://www.paradex.trade/blog/introducing-zero-fee-perps (2025-09, OLD) ; XP: https://docs.paradex.trade/docs/xp-referrals/xp ; S3: https://www.bitget.com/news/detail/12560605178909 ; Funding V2: https://en.cryptonomist.ch/2026/07/12/paradex-funding-improvements/
- Extended: https://www.perpscope.com/dex/extended ; https://orbitperpscreener.com/blog/extended-review ; Arc migration: https://www.tokenpost.com/news/technology/28538 , https://blockonomi.com/extended-to-migrate-perpetual-dex-settlement-to-circles-arc-blockchain ; points cap: https://airdropalert.com/airdrops/extended-exchange-points-program/
- Variational: https://docs.variational.io/omni/rewards/points ; https://airdrops.io/variational/ ; https://defillama.com/research/spotlight/variational-swaps ; https://blockeden.xyz/de/blog/2026/05/03/variational-tradfi-on-chain-perp-platform-450-markets-cross-margin/
- Nado: https://docs.nado.xyz/core/fees-and-rebates ; https://docs.nado.xyz/core/funding-rates ; https://points.0xtimberj.com/ ; https://dexrank.com/reviews/nado/
- Aster: https://coinbureau.com/analysis/aster-vs-hyperliquid (2026-06) ; https://bitsgap.com/blog/what-aster-actually-costs-trading-fees-broken-down-slug-aster-trading-fees-explained ; https://boxmining.com/aster-dex-airdrop-guide/ ; https://airdrops.io/aster/
- edgeX: https://airdropalert.com/blogs/edgex-review/ ; https://messari.io/report/state-of-edgex-q4-2025 (OLD) ; https://edgex-1.gitbook.io/edgeX-documentation/trading/funding-fees ; https://edgex-1.gitbook.io/edgeX-documentation/trading/order-types
- GRVT: https://exchange-compare.com/exchanges/grvt/ ; https://help.grvt.io/en/articles/13606302-grvt-mm-program ; https://invezz.com/news/2026/09/16/the-fee-war-nobodys-really-fighting-anymore/ ; TGE: https://www.odaily.news/en/newsflash/504706 ; https://airdrops.io/grvt/
- Backpack: https://tradersunion.com/brokers/crypto/view/backpack/fees/ (2026-07) ; https://learn.backpack.exchange/blog/backpack-token-tge-overview ; https://learn.backpack.exchange/blog/backpack-epilogue ; funding: https://learn.backpack.exchange/zh-cn/articles/hourly-funding-and-real-time-yield
- Pacifica: https://mintlify.wiki/pacifica-fi/docs-migrate/platform/trading-fees ; https://airdropalert.com/blogs/pacifica-review/ (2026-10) ; https://pacifica.gitbook.io/docs/trading-on-pacifica/self-trade-prevention
- Ondo Perps: https://www.odaily.news/en/newsflash/503094 ; https://coinlaunch.space/projects/ondo-perps/
- Others: https://perps.info/dex/standx ; https://dropstab.com/research/alpha/top-perpetual-dex-platforms-for-point-farming (2026-02, OLD) ; spreads: https://www.liquidview.app/blog/best-perp-dex-2026
