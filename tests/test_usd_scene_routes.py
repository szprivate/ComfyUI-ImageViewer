"""The scene-as-USD routes: POST /imageviewer/scene with format usda writes a stage
(meshes beside it in assets/), GET /imageviewer/scene?path= reads it back, and
GET /imageviewer/usd_tree lists the prims inside an asset with the Outliner's edits.

viewer_api in a private aiohttp app, ComfyUI's folder_paths and server stubbed (as in test_edit_takes).
Needs usd-core, numpy and aiohttp; skipped without them.
Run: python -m unittest tests.test_usd_scene_routes
"""
import asyncio
import base64
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from pxr import Usd, UsdGeom
    import numpy as np
except Exception:                                   # pragma: no cover
    web = None


def _load(tmp):
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
    srv.PromptServer = type("PromptServer", (), {"instance": types.SimpleNamespace(
        app=app, send_sync=lambda event, data: None)})
    saved = {k: sys.modules.get(k) for k in ("folder_paths", "server")}
    sys.modules.update(folder_paths=fp, server=srv)
    name = "imageviewer_usd_routes_under_test"
    pkg = types.ModuleType(name)
    pkg.__path__ = [os.path.join(ROOT, "src")]
    sys.modules[name] = pkg
    try:
        importlib.import_module(name + ".viewer_api")
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return app, dirs, name


def _b64(arr, dtype):
    return base64.b64encode(np.asarray(arr, dtype=dtype).tobytes()).decode("ascii")


@unittest.skipIf(web is None, "needs aiohttp, usd-core and numpy")
class UsdSceneRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp)
        cls.asset = os.path.join(cls.dirs["output"], "props", "chair.usda")
        os.makedirs(os.path.dirname(cls.asset))
        st = Usd.Stage.CreateNew(cls.asset)
        root = UsdGeom.Xform.Define(st, "/Chair")
        st.SetDefaultPrim(root.GetPrim())
        vs = root.GetPrim().GetVariantSets().AddVariantSet("look")
        for v in ("wood", "metal"):
            vs.AddVariant(v)
        vs.SetVariantSelection("wood")
        UsdGeom.Cube.Define(st, "/Chair/Seat")
        UsdGeom.Cube.Define(st, "/Chair/Back")
        st.GetRootLayer().Save()
        cls.outside = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside, ignore_errors=True)

    def run_async(self, fn):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    def scene(self):
        return {"fps": 24, "length": 10, "items": [
            {"id": "chair", "kind": "model", "name": "Chair", "parent": None,
             "src": {"path": self.asset, "name": "chair.usda"},
             "position": [0, 0, 2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {},
             "usd": {"overs": {"Back": {"visible": False}}}},
            {"id": "ground", "kind": "terrain", "name": "Ground", "parent": None, "terrain": {"size": 10},
             "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {}},
        ]}

    def test_a_scene_saved_as_usda_opens_again(self):
        tri = {"name": "Ground", "color": "#557733",
               "positions": _b64([[0, 0, 0], [1, 0, 0], [0, 0, 1]], np.float32)}
        body = {"name": "shot", "format": "usda", "scene": self.scene(), "baked": self.scene(),
                "geometry": {"ground": {"meshes": [tri]}}}

        async def go(client):
            r = await client.post("/imageviewer/scene", json=body)
            saved = await r.json()
            self.assertEqual(r.status, 200, saved)
            r2 = await client.get("/imageviewer/scene", params={"path": saved["path"]})
            return saved, r2.status, await r2.json()
        saved, status, loaded = self.run_async(go)
        self.assertTrue(saved["path"].endswith(".usda"), saved)
        self.assertTrue(saved["assets"] and all(os.path.isfile(a) for a in saved["assets"]), saved)
        self.assertEqual(status, 200, loaded)
        items = {it["id"]: it for it in loaded["scene"]["items"]}
        self.assertEqual(set(items), {"chair", "ground"})
        self.assertEqual(items["chair"]["usd"], {"overs": {"Back": {"visible": False}}})
        self.assertEqual(os.path.abspath(items["chair"]["src"]["path"]), os.path.abspath(self.asset))
        # The asset itself is never written to.
        with open(self.asset) as fh:
            self.assertNotIn("invisible", fh.read())

    def test_the_prim_tree_takes_the_edits_and_is_fenced(self):
        edits = json.dumps({"overs": {"Back": {"visible": False}}, "variants": {"": {"look": "metal"}}})

        async def go(client):
            r = await client.get("/imageviewer/usd_tree", params={"path": self.asset, "usd": edits})
            tree = await r.json()
            bad = await client.get("/imageviewer/usd_tree", params={"path": os.path.join(self.outside, "x.usda")})
            notusd = await client.get("/imageviewer/usd_tree", params={"path": self.asset[:-5] + ".txt"})
            return r.status, tree, bad.status, notusd.status
        status, tree, bad, notusd = self.run_async(go)
        self.assertEqual(status, 200, tree)
        prims = {p["rel"]: p for p in tree["prims"]}
        self.assertEqual(set(prims), {"Seat", "Back"})
        self.assertFalse(prims["Back"]["visible"])
        self.assertTrue(prims["Seat"]["visible"])
        self.assertEqual(tree["variants"]["look"]["selection"], "metal")
        self.assertEqual(tree["variants"]["look"]["choices"], ["metal", "wood"])
        self.assertEqual(bad, 403)
        self.assertEqual(notusd, 400)


if __name__ == "__main__":
    unittest.main()
