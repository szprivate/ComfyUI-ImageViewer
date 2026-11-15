"""The Farm space's relay: /imageviewer/farm passes a known action to the agentY host's /agentY/pool and draws a
host that is down as a state, not an error. No provider key, no path and no process on this side."""
import asyncio
import importlib
import os
import sys
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if "imageviewer" not in sys.modules:
    pkg = types.ModuleType("imageviewer")
    pkg.__path__ = [os.path.join(ROOT, "src")]
    sys.modules["imageviewer"] = pkg

from aiohttp import web                                     # noqa: E402
from aiohttp.test_utils import TestClient, TestServer      # noqa: E402

fr = importlib.import_module("imageviewer.farm_routes")
ar = importlib.import_module("imageviewer.atlas_render")


class FakeAccess:
    @staticmethod
    def same_origin(request):
        if request.headers.get("Origin") not in (None, f"http://{request.host}"):
            return False, "Refused: the request did not come from ComfyUI's own page."
        return True, ""


class FarmRouteTests(unittest.TestCase):
    def run_async(self, coro):
        return asyncio.new_event_loop().run_until_complete(coro)

    async def client(self):
        app = web.Application()
        fr.register(lambda m, p, h: app.router.add_route(m, p, h), web=web, path_access=FakeAccess)
        c = TestClient(TestServer(app))
        await c.start_server()
        return c

    def test_clean_request(self):
        self.assertEqual(fr.clean_request({"action": "cancel", "id": "j1", "dest": "C:/Windows"}),
                         {"action": "cancel", "id": "j1"})
        for bad in ({"action": "rm"}, [], {"action": "submit"}):
            with self.assertRaises(ValueError):
                fr.clean_request(bad)

    def test_state_and_actions_are_relayed(self):
        seen = []

        def host(base, method, query="", body=None, timeout=30, route=""):
            seen.append((method, route, body))
            return {"ok": True, "machines": [{"id": "m1"}]}

        async def go():
            c = await self.client()
            try:
                with mock.patch.object(ar, "call_host", host):
                    r1 = await c.get("/imageviewer/farm")
                    r2 = await c.post("/imageviewer/farm", json={"action": "stop", "id": "m1", "dest": "/etc"})
                    r3 = await c.post("/imageviewer/farm", json={"action": "stop"},
                                      headers={"Origin": "http://evil.example"})
                    r4 = await c.post("/imageviewer/farm", json={"action": "format_c"})
                return r1.status, await r1.json(), r2.status, r3.status, r4.status
            finally:
                await c.close()
        s1, j1, s2, s3, s4 = self.run_async(go())
        self.assertEqual((s1, j1["machines"][0]["id"], s2, s3, s4), (200, "m1", 200, 403, 400))
        self.assertEqual(seen[1], ("POST", "pool", {"action": "stop", "id": "m1"}))
        self.assertEqual(len(seen), 2)

    def test_a_host_that_is_down_is_a_state(self):
        def down(*a, **k):
            raise ar.RelayError("the agentY host is not running (start it, then press the button again)", 503)

        async def go():
            c = await self.client()
            try:
                with mock.patch.object(ar, "call_host", down):
                    r = await c.get("/imageviewer/farm")
                    p = await c.post("/imageviewer/farm", json={"action": "refresh"})
                return r.status, await r.json(), p.status
            finally:
                await c.close()
        s, j, ps = self.run_async(go())
        self.assertEqual((s, j["offline"], ps), (200, True, 503))


if __name__ == "__main__":
    unittest.main()
