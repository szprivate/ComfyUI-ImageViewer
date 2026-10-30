"""The routes a history switch calls do their disk work off the event loop.

On a network share an `isfile` or a `realpath` can take tens of milliseconds, a new thumbnail far more.
On the event loop that wait held up every other request: measured on the W: share, a switch's
/bepic/raw_view took 40 ms alone, 0.6-1.4 s behind twelve thumbnails being made and 4-4.7 s behind one
/bepic/probe_paths of 166 paths. Here the slow disk is simulated (every check of a "slow" path sleeps)
and the event loop must keep turning while those requests are answered.

The REAL viewer_api routes in a private aiohttp app, with ComfyUI's folder_paths and server stubbed.
Run: python -m unittest tests.test_routes_off_loop
"""
import asyncio
import importlib
import os
import shutil
import sys
import tempfile
import time
import types
import unittest

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from PIL import Image
except ImportError:  # pragma: no cover
    web = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SLOW_S = 0.25          # what one check of a file on the "share" costs
STALL_BUDGET_S = 0.2   # the longest the loop may go unanswered; one slow check on it is already more


def _load(tmp):
    """viewer_api as a module of a stand-in package, its routes on a fresh aiohttp app."""
    fp = types.ModuleType("folder_paths")
    fp.base_path = tmp
    dirs = {"output": os.path.join(tmp, "out"), "temp": os.path.join(tmp, "temp"), "input": os.path.join(tmp, "in")}
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)
    fp.get_output_directory = lambda: dirs["output"]
    fp.get_temp_directory = lambda: dirs["temp"]
    fp.get_input_directory = lambda: dirs["input"]
    fp.get_directory_by_type = lambda t: dirs.get(t)
    app = web.Application()
    srv = types.ModuleType("server")
    srv.PromptServer = type("PromptServer", (), {"instance": types.SimpleNamespace(app=app)})
    saved = {k: sys.modules.get(k) for k in ("folder_paths", "server")}
    sys.modules.update(folder_paths=fp, server=srv)
    name = "bepic_routes_under_test"
    pkg = types.ModuleType(name)
    pkg.__path__ = [ROOT]
    sys.modules[name] = pkg
    try:
        va = importlib.import_module(name + ".viewer_api")
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return app, va, dirs, name


@unittest.skipIf(web is None, "needs aiohttp and Pillow")
class RoutesOffLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.va, cls.dirs, cls.pkg = _load(cls.tmp)
        out = cls.dirs["output"]
        for i in range(12):
            Image.new("RGB", (640, 400), (i * 20, 40, 90)).save(os.path.join(out, f"slow_{i:02d}.png"))
        Image.new("RGB", (640, 400), (200, 40, 90)).save(os.path.join(out, "fast.png"))
        # The share: every check of a slow_ file is a round trip.
        pa = sys.modules[cls.pkg + ".path_access"]
        real = pa._real
        cls._restore = (pa, real)

        def slow_real(path):
            if "slow_" in os.path.basename(str(path)):
                time.sleep(SLOW_S)
            return real(path)
        pa._real = slow_real

    @classmethod
    def tearDownClass(cls):
        pa, real = cls._restore
        pa._real = real
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _client(self):
        # An aiohttp app is tied to the first loop it ran on; each test gets its own copy of the routes.
        app = web.Application()
        for r in self.app.router.routes():
            app.router.add_route(r.method, r.resource.canonical, r.handler)
        return TestClient(TestServer(app))

    def _while_busy(self, busy):
        """(longest stall of the event loop, results) while `busy(client)` requests are answered.

        Server and client share one loop here, so a handler that waits on the disk ON the loop stalls
        this ticker as it stalls every other request - the picture a history switch asked for included.
        """
        async def run():
            async with self._client() as client:
                gaps, done = [], asyncio.Event()

                async def ticker():
                    while not done.is_set():
                        t = time.perf_counter()
                        await asyncio.sleep(0.01)
                        gaps.append(time.perf_counter() - t)
                tick = asyncio.ensure_future(ticker())
                results = await asyncio.gather(*busy(client))
                done.set()
                await tick
                return max(gaps), results
        return asyncio.run(run())

    def _slow_paths(self):
        return [os.path.join(self.dirs["output"], f"slow_{i:02d}.png") for i in range(10)]

    def test_a_probe_of_the_whole_history_runs_off_the_loop(self):
        async def probe(client):
            r = await client.post("/bepic/probe_paths", json={"paths": [{"path": p} for p in self._slow_paths()]
                                                              + [{"path": os.path.join(self.dirs["output"], "gone.png")}]})
            return r.status, await r.json()

        stall, [(status, body)] = self._while_busy(lambda c: [probe(c)])
        self.assertLess(stall, STALL_BUDGET_S)
        # ... and it still answers the same: only the missing file is unreachable.
        self.assertEqual(status, 200)
        self.assertEqual([e["reason"] for e in body["unreachable"]], ["gone"])
        self.assertTrue(body["unreachable"][0]["path"].endswith("gone.png"))

    def test_a_strip_of_new_thumbnails_runs_off_the_loop(self):
        async def tile(client, p):
            r = await client.get("/bepic/thumb", params={"path": p})
            data = await r.read()
            return r.status, r.headers.get("Cache-Control"), len(data)

        stall, tiles = self._while_busy(lambda c: [tile(c, p) for p in self._slow_paths()])
        self.assertLess(stall, STALL_BUDGET_S)
        for status, cache, size in tiles:
            self.assertEqual((status, cache), (200, "public, max-age=31536000"))
            self.assertGreater(size, 0)

    def test_refusals_and_missing_files_answer_as_before(self):
        async def run():
            async with self._client() as client:
                out = []
                for route, path in (("/bepic/raw_view", os.path.join(self.dirs["output"], "nope.png")),
                                    ("/bepic/raw_view", os.path.join(self.tmp, "elsewhere.png")),
                                    ("/bepic/raw_view", os.path.join(self.dirs["output"], "notes.txt")),
                                    ("/bepic/thumb", os.path.join(self.dirs["output"], "nope.png")),
                                    ("/bepic/view_file", os.path.join(self.dirs["output"], "nope.png")),
                                    ("/bepic/view_file", os.path.join(self.dirs["output"], "fast.png"))):
                    r = await client.get(route, params={"path": path})
                    await r.read()
                    out.append(r.status)
                return out
        self.assertEqual(asyncio.run(run()), [404, 403, 403, 404, 404, 200])


if __name__ == "__main__":
    unittest.main()
