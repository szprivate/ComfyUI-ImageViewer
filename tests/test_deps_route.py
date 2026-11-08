"""POST /imageviewer/deps through the REAL route, in ComfyUI itself (no agentY host): a render saved by Save
Image reads back to the plate it was made from; a GET, a page from elsewhere and a file outside what the viewer
may show are refused. Run: python -m unittest tests.test_deps_route"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import deps_fixture as fx  # noqa: E402

try:
    from aiohttp.test_utils import TestClient, TestServer
    from test_annotation_routes import _load, web
except ImportError:  # pragma: no cover
    web = None


@unittest.skipIf(web is None, "needs aiohttp and Pillow")
class DepsRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # viewer_api registers its routes when it is imported: once, onto one app, for the whole class.
        cls.tmp = os.path.realpath(tempfile.mkdtemp())
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, True)

    def setUp(self):
        self.dg = sys.modules[self.pkg + ".deps_graph"]
        self.dg.set_roots(self.dirs)
        self.addCleanup(self.dg.set_roots, None)
        self.dg._unknown.clear()
        for name, shade in (("plate.png", 10),):
            fx.write_png(os.path.join(self.dirs["input"], name), shade=shade)
        fx.write_png(os.path.join(self.dirs["output"], "depth_00001_.png"), {"prompt": __import__("json").dumps(fx.DEPTH_GRAPH)})
        fx.write_png(os.path.join(self.dirs["output"], "render_00001_.png"), {"prompt": __import__("json").dumps(fx.RENDER_GRAPH)})

    def run_with(self, body):
        """Run `body(call)` with one client (an app is tied to the loop it first ran on)."""
        async def go():
            async with TestClient(TestServer(self.app)) as c:
                async def call(method, path, **kw):
                    r = await c.request(method, path, **kw)
                    try:
                        data = await r.json()
                    except Exception:  # noqa: BLE001
                        data = None
                    return r.status, data
                await body(call)
        asyncio.run(go())

    def test_route(self):
        # One loop for the whole class: an aiohttp app is tied to the loop it first ran on.
        async def both(call):
            await self._render(call)
            await self._refusals(call)
        self.run_with(both)

    async def _render(self, call):
        """A render saved by Save Image reads back to its plate, prompts and all."""
        for route in ("/imageviewer/deps", "/api/imageviewer/deps"):
            st, g = await call("POST", route, json={"filename": "render_00001_.png", "type": "output"})
            self.assertEqual(st, 200, g)
            names = {os.path.basename(n["id"]): n for n in g["nodes"]}
            self.assertEqual(set(names), {"plate.png", "depth_00001_.png", "render_00001_.png"})
            self.assertTrue(all(n["viewable"] for n in names.values()))
            self.assertEqual(names["render_00001_.png"]["prompts"][0]["text"], "a kitchen at dawn")
            self.assertEqual([m["name"] for m in names["render_00001_.png"]["models"]], ["flux"])
            self.assertEqual(names["plate.png"]["models"], [])
        # "Look in folder" on the plate's own folder finds nothing new; what was made from it is known now.
        st, g = await call("POST", "/imageviewer/deps", json={"path": os.path.join(self.dirs["input"], "plate.png"), "scan": True})
        self.assertEqual(len(g["nodes"]), 3)

    async def _refusals(self, call):
        """A GET, a page from elsewhere, a file outside what the viewer may show, a file that is not there."""
        self.assertIn((await call("GET", "/imageviewer/deps?filename=render_00001_.png&type=output"))[0], (404, 405))
        st, _ = await call("POST", "/imageviewer/deps", json={"filename": "render_00001_.png", "type": "output"},
                          headers={"Origin": "http://evil.example"})
        self.assertEqual(st, 403)
        outside = os.path.join(tempfile.mkdtemp(), "x.png")
        fx.write_png(outside)
        self.assertEqual((await call("POST", "/imageviewer/deps", json={"path": outside}))[0], 403)
        st, body = await call("POST", "/imageviewer/deps", json={"filename": "nope.png", "type": "output"})
        self.assertEqual(st, 404, body)


if __name__ == "__main__":
    unittest.main()
