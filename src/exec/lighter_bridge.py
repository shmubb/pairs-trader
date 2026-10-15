#!/usr/bin/env python3
"""
Local bridge between the Node engine and Lighter, using Lighter's official
Python SDK (`pip install lighter-sdk`) for signing. Listens on 127.0.0.1 only.

    LIGHTER_URL=https://mainnet.zklighter.elliot.ai \
    LIGHTER_ACCOUNT_INDEX=12345 LIGHTER_API_KEY_INDEX=3 LIGHTER_API_PRIVATE_KEY=0x... \
    python src/exec/lighter_bridge.py            # then: node bin/engine.js --engine config/farm.json --mode live

Endpoints (JSON):
  GET  /health    -> {"ok": true, "account_index": ..., "url": ...}
  GET  /markets   -> {"BTC": {"market_id", "size_decimals", "price_decimals", "min_base", "min_quote", "taker_fee", "maker_fee"}, ...}
  GET  /account   -> {"equity", "available", "collateral", "positions": {"BTC": {"szi", "entryPx", "unrealizedPnl", "liquidationPx"}}}
  POST /orders    {"legs": [{"symbol": "BTC", "size": 0.01, "reduceOnly": false, "maxSlippage": 0.003}, ...]}
               -> {"results": [{"symbol", "submitted", "error", "txHash", "baseAmount"}]}

Orders are slippage-capped market orders (IOC). Lighter settles asynchronously,
so the bridge only reports submission; the Node broker confirms fills by
re-reading positions. Use an API key (not your wallet key): API keys can trade
but the bridge never calls withdraw/transfer.
"""
import asyncio
import json
import logging
import os
import time

from aiohttp import web

log = logging.getLogger("lighter-bridge")


class LighterVenue:
    """Thin wrapper over the official SDK. Swappable for a fake in tests."""

    def __init__(self, url, account_index, api_key_index, api_private_key):
        self.url = url
        self.account_index = int(account_index)
        self.api_key_index = int(api_key_index)
        self.api_private_key = api_private_key
        self.markets = {}
        self._coi = int(time.time() * 1000) % 2_000_000_000

    async def start(self):
        import lighter  # imported here so tests can run without the SDK
        self.lighter = lighter
        self.client = lighter.SignerClient(self.url, self.account_index, {self.api_key_index: self.api_private_key})
        err = self.client.check_client()
        if err:
            raise RuntimeError(f"Lighter API key check failed: {err}")
        self.api = lighter.ApiClient(configuration=lighter.Configuration(host=self.url))
        self.order_api = lighter.OrderApi(self.api)
        self.account_api = lighter.AccountApi(self.api)
        await self.load_markets()

    async def load_markets(self):
        obs = await self.order_api.order_books()
        out = {}
        for ob in obs.order_books:
            if getattr(ob, "market_type", "perp") not in ("perp", "perps", None):
                continue
            if getattr(ob, "status", "active") not in ("active", None):
                continue
            out[ob.symbol] = {
                "market_id": ob.market_id,
                "size_decimals": ob.supported_size_decimals,
                "price_decimals": ob.supported_price_decimals,
                "min_base": float(ob.min_base_amount),
                "min_quote": float(ob.min_quote_amount),
                "taker_fee": float(ob.taker_fee),
                "maker_fee": float(ob.maker_fee),
            }
        self.markets = out
        return out

    async def account(self):
        res = await self.account_api.account(by="index", value=str(self.account_index))
        acc = res.accounts[0]
        positions = {}
        for p in acc.positions:
            size = float(p.position) * (1 if int(p.sign) >= 0 else -1)
            if size == 0:
                continue
            positions[p.symbol] = {
                "szi": size,
                "entryPx": float(p.avg_entry_price),
                "unrealizedPnl": float(p.unrealized_pnl),
                "liquidationPx": float(p.liquidation_price) if p.liquidation_price not in (None, "", "0") else None,
            }
        return {
            "equity": float(acc.total_asset_value),
            "available": float(acc.available_balance),
            "collateral": float(acc.collateral),
            "positions": positions,
        }

    def next_coi(self):
        self._coi = (self._coi + 1) % 2_000_000_000
        return self._coi

    async def market_order(self, symbol, size, reduce_only, max_slippage):
        m = self.markets.get(symbol)
        if not m:
            return {"symbol": symbol, "submitted": False, "error": f"unknown market {symbol}"}
        base_amount = int(round(abs(size) * 10 ** m["size_decimals"]))
        if base_amount <= 0 or abs(size) < m["min_base"]:
            return {"symbol": symbol, "submitted": False, "error": f"size {abs(size)} below minimum {m['min_base']}", "baseAmount": base_amount}
        tx, resp, err = await self.client.create_market_order_limited_slippage(
            market_index=m["market_id"],
            client_order_index=self.next_coi(),
            base_amount=base_amount,
            max_slippage=max_slippage,
            is_ask=size < 0,
            reduce_only=bool(reduce_only),
        )
        return {
            "symbol": symbol,
            "submitted": err is None,
            "error": None if err is None else str(err),
            "txHash": getattr(resp, "tx_hash", None) if resp is not None else None,
            "baseAmount": base_amount,
        }


def make_app(venue):
    app = web.Application()
    lock = asyncio.Lock()  # one order batch at a time keeps nonces ordered

    async def health(_):
        return web.json_response({"ok": True, "account_index": getattr(venue, "account_index", None), "url": getattr(venue, "url", None)})

    async def markets(_):
        return web.json_response(venue.markets)

    async def account(_):
        try:
            return web.json_response(await venue.account())
        except Exception as e:  # surface API errors to the engine instead of crashing
            return web.json_response({"error": str(e)}, status=502)

    async def orders(request):
        body = await request.json()
        legs = body.get("legs", [])
        async with lock:
            results = []
            for leg in legs:  # sequential: milliseconds apart, nonce-safe
                try:
                    results.append(await venue.market_order(leg["symbol"], float(leg["size"]), leg.get("reduceOnly", False), float(leg.get("maxSlippage", 0.003))))
                except Exception as e:
                    results.append({"symbol": leg.get("symbol"), "submitted": False, "error": str(e)})
        return web.json_response({"results": results})

    app.add_routes([web.get("/health", health), web.get("/markets", markets), web.get("/account", account), web.post("/orders", orders)])
    return app


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    env = os.environ
    missing = [k for k in ("LIGHTER_ACCOUNT_INDEX", "LIGHTER_API_KEY_INDEX", "LIGHTER_API_PRIVATE_KEY") if not env.get(k)]
    if missing:
        raise SystemExit(f"set {', '.join(missing)} (see docs/FARMING.md)")
    venue = LighterVenue(env.get("LIGHTER_URL", "https://mainnet.zklighter.elliot.ai"), env["LIGHTER_ACCOUNT_INDEX"], env["LIGHTER_API_KEY_INDEX"], env["LIGHTER_API_PRIVATE_KEY"])
    await venue.start()
    log.info("connected to %s, account %s, %d markets", venue.url, venue.account_index, len(venue.markets))
    runner = web.AppRunner(make_app(venue))
    await runner.setup()
    port = int(env.get("LIGHTER_BRIDGE_PORT", "8790"))
    await web.TCPSite(runner, "127.0.0.1", port).start()
    log.info("bridge listening on http://127.0.0.1:%d", port)
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
