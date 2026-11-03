"""Paint's routes (paint_routes.py) through the REAL viewer_api in a private aiohttp app: open, the pixels
both ways, save (.ora, by the export rule and over itself), export (flat and .psd), the agent's ops with
the page told, the snapshot, the fences, and /bepic/push opening an .ora in Paint.

    python -m unittest discover -s tests -p test_paint_routes.py
"""
import asyncio
import gzip
import importlib
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


@unittest.skipIf(web is None, "needs aiohttp")
class PaintRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.P = importlib.import_module(cls.pkg + ".paint_io")
        cls.outside = tempfile.mkdtemp()
        from PIL import Image
        cls.png = os.path.join(cls.dirs["output"], "pic.png")
        a = np.zeros((40, 60, 4), np.uint8)
        a[..., 0] = 200
        a[..., 3] = 255
        a[10:20, 10:30, 1] = 180
        Image.fromarray(a, "RGBA").save(cls.png)
        cls.png_px = a

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside, ignore_errors=True)

    def setUp(self):
        del self.sent[:]

    def run_c(self, fn):
        async def go():
            app = web.Application(client_max_size=1 << 28)
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    @staticmethod
    async def j(c, route, body):
        r = await c.post(route, json=body)
        return r.status, await r.json()

    @staticmethod
    async def px(c, tok, **q):
        r = await c.get("/bepic/paint/px", params={"token": tok, **q})
        return r.status, await r.read()

    def test_open_a_picture_and_read_its_pixels(self):
        async def go(c):
            st, d = await self.j(c, "/bepic/paint/open", {"path": self.png})
            self.assertEqual(st, 200, d)
            self.assertEqual((d["doc"]["w"], d["doc"]["h"]), (60, 40))
            self.assertIsNone(d["path"])           # a picture is not where its layers are saved
            L = d["doc"]["layers"][0]
            st, raw = await self.px(c, d["token"], layer=L["id"])
            self.assertEqual(st, 200)
            got = np.frombuffer(raw, np.uint8).reshape(40, 60, 4)
            self.assertTrue(np.array_equal(got, self.png_px))
        self.run_c(go)

    def test_save_by_the_rule_then_over_itself_with_kept_layers(self):
        async def go(c):
            st, d = await self.j(c, "/bepic/paint/open", {"new": {"w": 32, "h": 16, "name": "board", "fill": "#102030"}})
            self.assertEqual(st, 200, d)
            tok, meta = d["token"], d["doc"]
            bg = meta["layers"][0]
            # A second layer from the page, and a mask on it, sent raw (one gzipped).
            top = {"id": "ltop", "name": "Paint", "kind": "pixel", "x": 4, "y": 2, "w": 8, "h": 4, "opacity": 0.5,
                   "blend": "multiply", "mask": {"x": 4, "y": 2, "w": 8, "h": 4, "enabled": True, "fill": 0}}
            pix = np.full((4, 8, 4), 255, np.uint8)
            pix[..., 1] = 7
            r = await c.post("/bepic/paint/stage", params={"token": tok, "part": "layer:ltop"},
                             data=gzip.compress(pix.tobytes()), headers={"X-Bepic-Enc": "gzip"})
            self.assertEqual(r.status, 200, await r.text())
            mask = np.full((4, 8), 128, np.uint8)
            r = await c.post("/bepic/paint/stage", params={"token": tok, "part": "mask:ltop"}, data=mask.tobytes())
            self.assertEqual(r.status, 200)
            meta2 = {**meta, "layers": [bg, top], "active": "ltop"}
            st, s = await self.j(c, "/bepic/paint/save", {"token": tok, "meta": meta2, "keep": [bg["id"]]})
            self.assertEqual(st, 200, s)
            self.assertTrue(s["path"].endswith(os.path.join("bepic", "paint", "board_v001.ora")), s["path"])
            doc = self.P.read_ora(s["path"])
            self.assertEqual([L["name"] for L in doc.layers], ["Background", "Paint"])
            self.assertEqual(doc.layers[1]["blend"], "multiply")
            self.assertTrue(np.array_equal(doc.px["ltop"], pix))
            self.assertTrue(np.array_equal(doc.masks["ltop"], mask))
            self.assertEqual(tuple(doc.px[bg["id"]][0, 0]), (16, 32, 48, 255))
            # Saved again: over the same file, nothing re-sent.
            meta3 = {**meta2, "layers": [bg, {**top, "opacity": 1.0}]}
            st, s2 = await self.j(c, "/bepic/paint/save", {"token": tok, "meta": meta3, "keep": [bg["id"], "ltop"]})
            self.assertEqual(st, 200, s2)
            self.assertEqual(s2["path"], s["path"])
            self.assertEqual(self.P.read_ora(s["path"]).layers[1]["opacity"], 1.0)
            # A layer neither sent nor kept is refused, and nothing is written.
            st, bad = await self.j(c, "/bepic/paint/save", {"token": tok, "meta": meta3, "keep": [bg["id"]]})
            self.assertEqual(st, 400)
            self.assertIn("not sent", bad["error"])
        self.run_c(go)

    def test_export_flat_and_psd(self):
        async def go(c):
            st, d = await self.j(c, "/bepic/paint/open", {"path": self.png})
            tok = d["token"]
            st, e = await self.j(c, "/bepic/paint/export", {"token": tok, "format": "jpg", "name": "flat"})
            self.assertEqual(st, 200, e)
            self.assertTrue(e["path"].endswith(".jpg") and os.path.isfile(e["path"]))
            st, p = await self.j(c, "/bepic/paint/export", {"token": tok, "format": "psd", "name": "flat"})
            self.assertEqual(st, 200, p)
            self.assertTrue(p["path"].endswith("flat_v002.psd"), p["path"])  # the jpg took v001: one number per export
            back = self.P.read_psd(p["path"])
            self.assertTrue(np.array_equal(back.px[back.layers[0]["id"]], self.png_px))
            st, bad = await self.j(c, "/bepic/paint/export", {"token": tok, "format": "exe"})
            self.assertEqual(st, 400)
        self.run_c(go)

    def test_agent_ops_on_an_open_doc_tell_the_page(self):
        async def go(c):
            st, d = await self.j(c, "/bepic/paint/open", {"new": {"w": 20, "h": 20, "name": "agentdoc"}})
            tok = d["token"]
            st, s = await self.j(c, "/bepic/paint/save", {"token": tok, "meta": d["doc"], "keep": [d["doc"]["layers"][0]["id"]]})
            path = s["path"]
            st, o = await self.j(c, "/bepic/paint/doc", {"doc": path})
            self.assertEqual(st, 200, o)
            self.assertEqual(o["outline"]["layer_count"], 1)
            ops = [{"op": "add_layer", "file": self.png, "fit": "cover", "name": "Photo"},
                   {"op": "add_adjustment", "type": "hue_saturation", "params": {"saturation": -50}}]
            st, o = await self.j(c, "/bepic/paint/doc", {"doc": path, "ops": ops})
            self.assertEqual(st, 200, o)
            self.assertTrue(o["written"])
            self.assertEqual(o["token"], tok)
            self.assertEqual([r["name"] for r in o["outline"]["layers"]][:2], ["Hue/Saturation", "Photo"])
            self.assertEqual(self.sent[-1][0], "bepic.paint.changed")
            self.assertEqual(self.sent[-1][1]["token"], tok)
            # The page reads the changed pixels from its session.
            photo = next(L for L in self.P.read_ora(path).layers if L["name"] == "Photo")
            st, again = await self.px(c, tok, layer=photo["id"])
            self.assertEqual(st, 200)
            self.assertEqual((photo["w"], photo["h"]), (30, 20))     # "cover": the picture's shape kept, the canvas covered
            self.assertEqual(len(again), 30 * 20 * 4)
            # A bad op changes nothing.
            st, bad = await self.j(c, "/bepic/paint/doc", {"doc": path, "ops": [{"op": "remove_layer", "layer": 1}, {"op": "explode"}]})
            self.assertEqual(st, 400)
            self.assertEqual(len(self.P.read_ora(path).layers), 3)
        self.run_c(go)

    def test_agent_ops_on_a_picture_make_a_new_ora(self):
        async def go(c):
            st, o = await self.j(c, "/bepic/paint/doc", {"doc": self.png, "ops": [{"op": "add_text", "text": "Hi", "size": 12}]})
            self.assertEqual(st, 200, o)
            self.assertTrue(o["path"].endswith(".ora"))
            self.assertEqual(len(self.P.read_ora(o["path"]).layers), 2)
        self.run_c(go)

    def test_snapshot_writes_the_picture_and_the_selection(self):
        async def go(c):
            st, d = await self.j(c, "/bepic/paint/open", {"path": self.png})
            tok = d["token"]
            sel = np.zeros((40, 60), np.uint8)
            sel[5:15, 20:40] = 255
            await c.post("/bepic/paint/stage", params={"token": tok, "part": "sel"}, data=sel.tobytes())
            await self.j(c, "/bepic/paint/save", {"token": tok, "meta": d["doc"], "keep": [d["doc"]["layers"][0]["id"]], "write": False})
            st, s = await self.j(c, "/bepic/paint/snapshot", {"token": tok})
            self.assertEqual(st, 200, s)
            self.assertTrue(os.path.isfile(s["picture"]) and os.path.isfile(s["selection"]))
            self.assertEqual(s["box"], {"x": 20, "y": 5, "w": 20, "h": 10})
            self.assertTrue(s["picture"].startswith(os.path.join(self.dirs["input"], "paint")))
        self.run_c(go)

    def test_fences(self):
        from PIL import Image
        out = os.path.join(self.outside, "secret.png")
        Image.new("RGBA", (4, 4)).save(out)

        async def go(c):
            st, _ = await self.j(c, "/bepic/paint/open", {"path": out})
            self.assertEqual(st, 403)
            st, _ = await self.j(c, "/bepic/paint/doc", {"doc": out})
            self.assertEqual(st, 400)
            st, d = await self.j(c, "/bepic/paint/open", {"new": {"w": 8, "h": 8}})
            st, o = await self.j(c, "/bepic/paint/doc", {"doc": d["token"], "ops": [{"op": "add_layer", "file": out}]})
            self.assertEqual(st, 400)
            self.assertIn("may open", o["error"])
            # Another site's page.
            r = await c.post("/bepic/paint/open", json={"new": {"w": 8, "h": 8}}, headers={"Origin": "http://evil.example"})
            self.assertEqual(r.status, 403)
            r = await c.post("/bepic/paint/open", data="{}", headers={"Content-Type": "text/plain"})
            self.assertEqual(r.status, 403)
            # A token that is not one.
            st, _ = await self.px(c, "nope", layer="x")
            self.assertEqual(st, 404)
        self.run_c(go)

    def test_push_opens_an_ora_in_paint(self):
        doc = self.P.PaintDoc(8, 8, "pushed")
        doc.add_pixel_layer(np.zeros((8, 8, 4), np.uint8), "Background")
        path = os.path.join(self.dirs["output"], "pushed.ora")
        self.P.write_ora(path, doc)

        async def go(c):
            st, got = await self.j(c, "/bepic/push", {"paths": [path, self.png], "panel": "paint"})
            self.assertEqual(st, 200, got)
            self.assertEqual(sorted(os.path.normcase(p) for p in got["paint"]),
                             sorted(os.path.normcase(os.path.abspath(p)) for p in (path, self.png)))
            self.assertEqual(got["shown"], 0)
            self.assertEqual([e for e, _ in self.sent].count("bepic.paint.open"), 2)
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
