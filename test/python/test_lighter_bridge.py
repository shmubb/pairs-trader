"""Bridge HTTP layer tested with a fake venue (no network, no keys).
Run: python -m unittest discover -s test/python   (needs aiohttp, which lighter-sdk installs)"""
import asyncio
import os
import sys
import unittest

from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "exec"))
import lighter_bridge  # noqa: E402


class FakeVenue:
    def __init__(self):
        self.markets = {"ETH": {"market_id": 0, "size_decimals": 4, "price_decimals": 2, "min_base": 0.005, "min_quote": 10, "taker_fee": 0, "maker_fee": 0}}
        self.orders = []
        self.account_index = 1
        self.url = "fake"

    async def account(self):
        return {"equity": 1000.0, "available": 900.0, "collateral": 1000.0, "positions": {"ETH": {"szi": 0.5, "entryPx": 4000.0, "unrealizedPnl": 1.0, "liquidationPx": None}}}

    async def market_order(self, symbol, size, reduce_only, max_slippage):
        self.orders.append((symbol, size, reduce_only, max_slippage))
        if symbol not in self.markets:
            return {"symbol": symbol, "submitted": False, "error": "unknown market"}
        return {"symbol": symbol, "submitted": True, "error": None, "txHash": "0xabc", "baseAmount": int(abs(size) * 10 ** 4)}


class BridgeTest(unittest.TestCase):
    def test_endpoints(self):
        async def run():
            venue = FakeVenue()
            client = TestClient(TestServer(lighter_bridge.make_app(venue)))
            await client.start_server()
            try:
                self.assertTrue((await (await client.get("/health")).json())["ok"])
                self.assertIn("ETH", await (await client.get("/markets")).json())
                acc = await (await client.get("/account")).json()
                self.assertEqual(acc["positions"]["ETH"]["szi"], 0.5)
                r = await client.post("/orders", json={"legs": [{"symbol": "ETH", "size": -0.25, "maxSlippage": 0.002}, {"symbol": "XYZ", "size": 1}]})
                res = (await r.json())["results"]
                self.assertTrue(res[0]["submitted"])
                self.assertFalse(res[1]["submitted"])
                self.assertEqual(venue.orders[0], ("ETH", -0.25, False, 0.002))
            finally:
                await client.close()
        asyncio.run(run())

    def test_size_rounding_and_minimum(self):
        async def run():
            v = lighter_bridge.LighterVenue("https://example", 1, 2, "0x" + "1" * 80)
            v.markets = {"ETH": {"market_id": 0, "size_decimals": 4, "price_decimals": 2, "min_base": 0.005, "min_quote": 10}}
            r = await v.market_order("ETH", 0.001, False, 0.003)
            self.assertFalse(r["submitted"])
            self.assertIn("below minimum", r["error"])
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
