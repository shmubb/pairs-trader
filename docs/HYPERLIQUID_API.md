# Hyperliquid Perps Execution Reference (Node 22 ESM)

Inspected: `@nktkas/hyperliquid@0.33.3` (npm latest on 2026-10-12; `engines.node >=22.12.0`), `viem@2.57.5`,
`hyperliquid-dex/hyperliquid-python-sdk` @ `2fdb18f` (2026-06-04). Verified offline: `/tmp/hlresearch/example.mjs`
(imports, constructs clients, formats px/sz, signs, exercises `order()` against a mock transport).
Legend: **[SRC]** read in SDK source | **[RUN]** executed locally | **[DOCS~]** official-docs text via web-search snippets
(WebFetch to hyperliquid.gitbook.io failed with DNS ENOTFOUND, so no page was read in full) | **[UNVERIFIED]**.

## 1. Install & construct
```sh
npm i @nktkas/hyperliquid@0.33.3 viem      # deps: @nktkas/rews, @noble/hashes, decimal.js, valibot (auto). No peer deps.
```
- A wallet object is required; a raw hex string is NOT accepted. `AbstractWallet` = viem LocalAccount
  (`privateKeyToAccount`), viem JSON-RPC account, ethers v6 `Wallet`/Signer, or ethers v5 Signer. [SRC]
- Testnet = `new HttpTransport({ isTestnet: true })`. That one flag selects the URL (`https://api.hyperliquid-testnet.xyz`)
  and the signing source (`"b"` testnet, `"a"` mainnet; L1 EIP-712 domain chainId 1337). [SRC][RUN]
```js
import { HttpTransport, InfoClient, ExchangeClient, ApiRequestError, HttpRequestError, ValidationError } from "@nktkas/hyperliquid";
import { formatPrice, formatSize, SymbolConverter } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";

const transport = new HttpTransport({ isTestnet: process.env.HL_TESTNET === "1", timeout: 10_000 /* default; null disables */ });
// other options: apiUrl, rpcUrl, fetchOptions (RequestInit minus body/method)
const info = new InfoClient({ transport });
const wallet = privateKeyToAccount(process.env.HL_AGENT_KEY);           // "0x" + 64 hex
const exchange = new ExchangeClient({
  transport, wallet,
  // defaultVaultAddress: "0x...",   // trade a subaccount/vault with this signer
  // defaultExpiresAfter: () => Date.now() + 5_000,  // server rejects action after this ms timestamp
  // nonceManager: (addr) => myMonotonicMs(addr),    // default: Date.now() with +1 on collision, per wallet+network
});
const ACCOUNT = process.env.HL_ACCOUNT;  // MASTER address. Use for every info query, never the agent address.
```
SDK behaviour that matters for execution [SRC]:
- Every exchange call for one `(walletAddress, isTestnet)` runs under a per-key **mutex covering sign + HTTP round
  trip** (`_shell.js` `withLock`). Parallel `exchange.order()` calls from one wallet are serialized. To submit both pair
  legs at once, put them in **one** `order({ orders: [legA, legB] })` (one action, one nonce, IP weight 1).
- `order`/`cancel`/`cancelByCloid` throw `ApiRequestError` if **any** status in `statuses[]` has `error`, even when
  other legs filled. The raw response is on `err.response`. Always reconcile per leg from it. [RUN]
- Params are validated with valibot before sending (`ValidationError`). `p`/`s` accept string|number and are normalized
  (trailing zeros stripped, `"3500.0"`→`"3500"`), and cloid is lowercased. Tick/lot rules are **not** checked: call
  `formatPrice`/`formatSize` yourself. [SRC][RUN]
- HTTP non-2xx, timeout, or abort throws `HttpRequestError` (extends `TransportError`), with `.response?.status`.
  A timeout on `order` does not mean the order was rejected, so reconcile via `orderStatus` by cloid.
- Every method takes a final `opts` argument: `{ signal?, vaultAddress?, expiresAfter? }`.

## 2. Exchange actions (exact param shapes) [SRC]
```js
// Order wire: a=asset index, b=isBuy, p=price str, s=size str (base units), r=reduceOnly, t=type, c=cloid (optional)
import { randomBytes } from "node:crypto";
const cloid = "0x" + randomBytes(16).toString("hex");          // exactly 16 bytes / 34 chars
await exchange.order({
  orders: [{ a: 3, b: true, p: "61.234", s: "1.5", r: false, t: { limit: { tif: "Gtc" } }, c: cloid }],
  grouping: "na",            // "na" | "normalTpsl" | "positionTpsl" | { p: int<=1e8 } (priority, IOC/ALO only)
  // builder: { b: "0x...", f: 10 }   // f in 0.1bps
});
// tif: "Gtc" | "Ioc" | "Alo" (post-only) | "FrontendMarket" (IOC tagged as market)
// trigger: t: { trigger: { isMarket: true, triggerPx: "60", tpsl: "sl" } }
// Response: response.data.statuses[i] is one of
//   { resting: { oid, cloid? } } | { filled: { totalSz, avgPx, oid, cloid? } } | { error } | "waitingForFill" | "waitingForTrigger"

await exchange.cancel({ cancels: [{ a: 3, o: 123456789 }] /*, f: true (fast cancel) */ });   // statuses: "success" | {error}
await exchange.cancelByCloid({ cancels: [{ asset: 3, cloid }] });   // NOTE the key names differ: asset/cloid, not a/o
await exchange.modify({ oid: 123 /* or cloid */, order: { a, b, p, s, r, t, c } });
await exchange.batchModify({ modifies: [{ oid, order }] });
await exchange.updateLeverage({ asset: 3, isCross: true, leverage: 5 });   // isCross:false = isolated. int >=1
await exchange.updateIsolatedMargin({ asset: 3, isBuy: true, ntli: 10 * 1e6 });  // USD * 1e6, +add / -remove
await exchange.scheduleCancel({ time: Date.now() + 60_000 });  // dead man's switch: arm or extend
await exchange.scheduleCancel();                                 // no time = clear any scheduled cancel
await exchange.approveAgent({ agentAddress: "0x...", agentName: `bot1 valid_until ${Date.now() + 30 * 864e5}` });
// approveAgent is user-signed (EIP-712): the MASTER key must sign. hyperliquidChain comes from the transport.
await exchange.noop({ nonce: stuckNonce });  // invalidate a pending action by consuming its nonce (param required)
await exchange.reserveRequestWeight({ weight: 10 });   // buy extra address-based action budget
```

## 3. Info calls (`info.<method>(params)`, params omit `type`) [SRC]
```js
await info.meta();                       // { universe:[{name,szDecimals,maxLeverage,marginTableId,onlyIsolated?,isDelisted?,marginMode?}], marginTables, collateralToken }
await info.metaAndAssetCtxs();           // [meta, ctxs[]]: ctxs[i] aligns with meta.universe[i]
//   ctx: { funding, openInterest, markPx, midPx|null, oraclePx, premium|null, impactPxs:[bid,ask]|null, prevDayPx, dayNtlVlm, dayBaseVlm }
await info.allMids();                    // Record<coin, midStr>   (optional { dex })
await info.l2Book({ coin: "ETH", nSigFigs: null /*2|3|4|5*/, mantissa: null /*2|5, only with nSigFigs 5*/ });
//   { coin, time, levels: [bids[{px,sz,n}], asks[...]] } | null   (20 levels per side [UNVERIFIED])
await info.candleSnapshot({ coin: "ETH", interval: "1h", startTime: ms, endTime: ms /*optional*/ });
//   intervals: 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M. Rows {t,T,s,i,o,c,h,l,v,n} (OHLCV strings)
await info.fundingHistory({ coin: "ETH", startTime: ms, endTime: ms });   // [{coin,fundingRate,premium,time}], hourly rows
await info.predictedFundings();          // [[coin, [[venue, {fundingRate,nextFundingTime,fundingIntervalHours?}|null], ...]], ...]
                                         //  venues include "HlPerp", "BinPerp", "BybitPerp"
await info.clearinghouseState({ user: ACCOUNT });
//   { marginSummary, crossMarginSummary:{accountValue,totalNtlPos,totalRawUsd,totalMarginUsed}, crossMaintenanceMarginUsed,
//     withdrawable, assetPositions:[{type:"oneWay", position:{coin, szi /*signed*/, entryPx, positionValue, unrealizedPnl,
//     liquidationPx|null, marginUsed, maxLeverage, leverage:{type:"cross",value}|{type:"isolated",value,rawUsd},
//     cumFunding:{allTime,sinceOpen,sinceChange}}}], time }
await info.openOrders({ user: ACCOUNT });          // [{coin,side:"B"|"A",limitPx,sz,oid,timestamp,origSz,cloid?,reduceOnly?}]
await info.frontendOpenOrders({ user: ACCOUNT });  // adds orderType, tif, reduceOnly, isTrigger, triggerPx, children, cloid|null
await info.userFills({ user: ACCOUNT, aggregateByTime: true });
//   [{coin,px,sz,side,time,startPosition,dir,closedPnl,hash,oid,crossed,fee,feeToken,tid,cloid?,builderFee?,liquidation?}]
await info.userFillsByTime({ user: ACCOUNT, startTime, endTime, aggregateByTime: true, reversed: false });
await info.orderStatus({ user: ACCOUNT, oid: cloidOrOid });   // reconcile after a timeout
await info.userFunding({ user: ACCOUNT, startTime, endTime }); // funding actually paid/received
await info.activeAssetData({ user: ACCOUNT, coin: "ETH" });   // leverage, maxTradeSzs, availableToTrade
await info.userRateLimit({ user: ACCOUNT });                  // address-based budget used/cap
// also: userFees, maxMarketOrderNtls, perpsAtOpenInterestCap, extraAgents({user}), historicalOrders, exchangeStatus
```
All numeric values come back as **strings**. Parse with `Number()` (or decimal.js for money math).

## 4. Asset index, rounding, market orders (Python SDK + nktkas) [SRC][RUN]
- **Perp asset id = index in `meta().universe`** (main dex, offset 0). Delisted coins keep their slot (`isDelisted:true`),
  so never filter the array before indexing. Spot = `10000 + spotMeta index`. Builder (HIP-3) dex i = `110000 + i*10000 + idx`.
  Python `Info.set_perp_meta`: `for asset, info in enumerate(meta["universe"]): coin_to_asset[name] = asset + offset`.
- **Size:** at most `szDecimals` decimals. Truncate, never round up (`formatSize` uses ROUND_DOWN).
- **Price:** at most 5 significant figures AND at most `MAX_DECIMALS - szDecimals` decimals (MAX_DECIMALS 6 perp, 8 spot).
  Integer prices are always valid whatever their sig figs (e.g. `123456`). Examples: `1234.5` ok, `1234.56` invalid.
  - Python: `round(float(f"{px:.5g}"), 6 - szDecimals)` (round-half-even).
  - nktkas `formatPrice(px, szDecimals, "perp")`: ROUND_DOWN to the decimal cap, then 5 sig figs (non-integers only).
    Truncation moves the price **down**. That is safe for a sell crossing the book, but on a buy it makes a passive limit
    slightly less aggressive. Apply slippage first, then format.
  - Python `float_to_wire`: `f"{x:.8f}"` then normalize (no trailing zeros). Trailing zeros change the signed msgpack hash;
    nktkas strips them for you.
- **Market order = aggressive limit IOC** (Python `market_open`/`market_close`): `px = mid * (1 ± slippage)`, with
  `DEFAULT_SLIPPAGE = 0.05` (5%). `+` for buy, `-` for sell. Round as above, then `t:{limit:{tif:"Ioc"}}`.
  `market_close` uses `sz = |szi|`, side opposite to the position, and `reduce_only=True`.
- **Wire action** (msgpack-hashed, so key order matters; the SDK canonicalizes it):
  `{type:"order", orders:[{a,b,p,s,r,t,c?}], grouping:"na", builder?}`. POST `/exchange` body:
  `{action, nonce, signature:{r,s,v}, vaultAddress?, expiresAfter?}`. [RUN: payload printed by example.mjs]
```js
function marketPx(mid, isBuy, szDec, slip = 0.01) {      // pairs-trading: 0.5-1% is usually ample vs SDK 5%
  return formatPrice(mid * (isBuy ? 1 + slip : 1 - slip), szDec, "perp");
}
async function placePair(legs /* [{a,isBuy,sz,mid,szDec,cloid,reduceOnly}] */) {
  const orders = legs.map(l => ({ a: l.a, b: l.isBuy, p: marketPx(l.mid, l.isBuy, l.szDec), s: formatSize(l.sz, l.szDec),
                                  r: !!l.reduceOnly, t: { limit: { tif: "Ioc" } }, c: l.cloid }));
  let res;
  try { res = await exchange.order({ orders, grouping: "na" }); }
  catch (e) {
    if (e instanceof ApiRequestError && e.response?.response?.data?.statuses) res = e.response; // partial: some legs errored
    else throw e;                     // transport/timeout: unknown outcome, so reconcile via orderStatus(cloid)
  }
  return res.response.data.statuses.map((st, i) => ({ leg: i,
    filledSz: st.filled ? Number(st.filled.totalSz) : 0, avgPx: st.filled ? Number(st.filled.avgPx) : null,
    resting: st.resting?.oid ?? null, error: st.error ?? null }));   // IOC remainder is auto-cancelled
}
```
IOC with zero fill returns `{error:"Order could not immediately match against any resting orders. asset=N"}` [DOCS~ error
table "IocCancel"]. A partial IOC fill is not an error: `filled.totalSz` < requested size.

## 5. Protocol rules (official docs via search snippets) [DOCS~ unless marked]
**Funding**
- Paid **every hour**. Formula is stated on an 8h basis: `F = avgPremiumIndex + clamp(interest - avgPremiumIndex, -0.0005, 0.0005)`.
  1/8 of F is paid each hour. Interest = 0.01% per 8h (0.00125%/h, about 11% APR).
- Premium sampled every 5 s and averaged over the hour: `premium = impact_price_difference / oracle_price`. Impact
  notional is $20k for BTC/ETH and $6k for other assets.
- **Cap: 4%/hour**, the same for all assets (HIP-3 markets can use their own multiplier and interest).
- Payment = `size * ORACLE price * rate` (oracle, not mark). Longs pay when the rate is positive.
- `metaAndAssetCtxs` ctx.funding = the current hourly rate (per-hour, not 8h). `predictedFundings` gives the next HL
  rate next to Binance/Bybit (`fundingIntervalHours`, e.g. 8 for CEXs). [SRC; rate-unit interpretation UNVERIFIED]

**Fees (perps, Tier 0)**: taker **0.045%**, maker **0.015%**. Tier = rolling 14-day weighted volume
(`perps + 2*spot`), assessed daily at UTC end of day. T1 >$5M 0.040/0.012, T2 >$25M 0.035/0.008, T3 >$100M 0.030/0.004,
T4 >$500M maker 0. Staking and referral discounts and HIP-3/growth-mode fee changes were not checked [UNVERIFIED].
`info.userFees({user})` returns your actual rates, so read it at startup rather than hardcoding.

**Minimum order**: $10 notional (`sz * px`). The only exemption is a reduce-only order that exactly closes a position.
[third-party docs (Chainstack, CCXT) only, so official wording UNVERIFIED]. Size each leg so that
`sz*px >= ~11` after truncation, to absorb rounding.

**Rate limits**
- IP: **1200 weight/min** aggregate REST. Exchange action weight = `1 + floor(batchLength/40)`. Info weight is 20 for
  most requests and 2 for `l2Book`, `allMids`, `clearinghouseState`, `orderStatus`, `spotClearinghouseState`,
  `exchangeStatus` (that list is from memory, UNVERIFIED). Explorer requests weigh 40. `userFills*`, `fundingHistory`,
  `userFunding` etc. add weight per 20 items returned. `candleSnapshot` adds weight per 60 items.
- WS: 10 connections, 1000 subscriptions, 2000 messages/min.
- Address-based limit (per user, subaccounts separate): **1 request per 1 USDC traded cumulative**, plus an initial
  buffer of 10,000. When exhausted: 1 request per 10 s. Cancels get a higher cap: `min(limit + 100000, limit*2)`.
  A batch counts as n requests for this limit (1 for the IP limit). [buffer, throttle and cancel numbers from
  third-party tables, UNVERIFIED]. Check with `info.userRateLimit`. A fresh low-volume account burns this budget fast,
  so avoid churny cancel/replace loops.
- Open orders: 1000 base, +1 per $5M volume, max 5000 [third-party, UNVERIFIED].

**Pagination**: time-range info responses return at most **500** elements. Paginate with `startTime = last.time + 1`.
`userFills` returns the 2000 most recent. `userFillsByTime` returns 2000 per response and only the 10000 most recent are
reachable. **candleSnapshot: "Only the most recent 5000 candles are available"**: e.g. 1h covers about 208 days and 5m
about 17 days, so persist history locally.

**API / agent wallets & nonces**
- The master account signs `approveAgent` (user-signed). The agent can sign L1 actions only (orders, cancels, leverage,
  scheduleCancel, etc.). It **cannot withdraw** or transfer: those are user-signed actions that need the master key.
- Limits: 1 unnamed agent + up to 3 named per account (+2 per subaccount) [third-party; UNVERIFIED]. Expiry is set via
  `agentName: "name valid_until <ms>"`. The nktkas guide claims a 90-day default expiry [UNVERIFIED].
  Query agents with `info.extraAgents({ user: MASTER })`.
- **Query state with the master (or subaccount/vault) address, never the agent address.** To trade a subaccount or
  vault with an agent, pass `vaultAddress`.
- Nonces are tracked **per signer**: the 100 highest are kept. A new nonce must be > the smallest in that set, never
  reused, and inside `(T - 2 days, T + 1 day)` of block time. Use one agent per process. Subaccounts signed by the same
  agent share its nonce tracker. Once an agent is deregistered its nonce state may be pruned, so never reuse an old
  agent address (replay risk).
- `expiresAfter` (ms) makes a stale signed action fail instead of executing late. It is useful for IOC legs.

**Margin modes**: cross (default) or isolated. Some assets are `onlyIsolated`/`marginMode:"strictIsolated"` (margin
cannot be removed) or `"noCross"`. You can raise leverage on an open position. Leverage is checked only at open.
Initial margin = `size * markPx / leverage`. Set `updateLeverage` per asset **before** entering. Switching cross and
isolated with an open position is rejected [from memory, UNVERIFIED]. `leverage <= meta.universe[i].maxLeverage`.

**scheduleCancel (dead man's switch)**: `time` must be **>= now + 5 s**. At that time all open orders are cancelled
(positions are NOT closed) and the trigger count increments. **Max 10 triggers per day, reset 00:00 UTC.** Omitting
`time` clears the switch. Older community posts show a volume gate
(`"Cannot set scheduled cancel time until enough volume traded. Required: $1000000"`). It is absent from the current docs
I could find, so **test on your account**: it may reject on a low-volume account [UNVERIFIED]. Pattern: re-arm every
~N s with `time = now + 3N`. Because only resting orders are cancelled, it does not protect an unhedged leg. Keep a
separate watchdog that flattens via reduce-only IOC.

## 6. Pairs-execution checklist
1. Startup: `metaAndAssetCtxs` → build `coin→{asset:index, szDecimals, maxLeverage}` (or `SymbolConverter.create({transport})`).
   Read `userFees` and `userRateLimit`. `updateLeverage` both legs. Optionally arm `scheduleCancel`.
2. Entry: size legs by notional (beta-hedged) and check each `>= $10`. Send **both legs in one `order()`** as IOC
   with a cloid per leg. Parse per-leg statuses even on `ApiRequestError`.
3. Leg mismatch (one filled, one errored or partial): retry the shortfall with a wider IOC, or unwind the filled leg
   reduce-only IOC. Decide by policy and cap retries.
4. Unknown outcome (timeout or 5xx): `orderStatus({user, oid: cloid})`, then confirm with `clearinghouseState` `szi`.
5. Exit: reduce-only IOC on both legs, sized from `|szi|` (not your internal book) so no dust remains.
6. Funding P&L: `userFunding`. Fills/fees: `userFillsByTime` (paginate). Positions: `clearinghouseState`.

## 7. Not verified / caveats
- No live API calls were made (api.hyperliquid.xyz is blocked here, and WebFetch could not resolve
  hyperliquid.gitbook.io). The §5 numbers come from search-engine snippets of the official GitBook plus third-party
  mirrors (Chainstack, GoldRush, CCXT). Re-check the pages for rate limits, fees, nonces/API wallets and margining
  before going live.
- UNVERIFIED items: the exact $10 minimum wording, the address-limit buffer/throttle numbers, the open-order cap, the
  agent count and default expiry, the scheduleCancel volume gate, whether margin mode can switch with an open position,
  the l2Book depth, and the list of weight-2 info endpoints.
- SDK types are pinned to 0.33.3. Per its README, API response types can change in patch releases.

Sources (web): hyperliquid.gitbook.io pages trading/funding, trading/fees, trading/margining,
for-developers/api/{rate-limits-and-user-limits, nonces-and-api-wallets, info-endpoint, exchange-endpoint, error-responses}
(snippets only); docs.chainstack.com (order precision, schedule cancel, rate limits); intercom.help/ccxt hyperliquid FAQ;
goldrush.dev candle-snapshot; nktkas.gitbook.io/hyperliquid/guides/agent-wallets-and-vaults; dwellir.com approveAgent.
