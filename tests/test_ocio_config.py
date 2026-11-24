"""The OCIO config picked in Settings -> ComfyUI Image Viewer -> Comp (color_io.set_config, /imageviewer/ocio_config).

Needs aiohttp and PyOpenColorIO (2.2 or later, for the built-in configs); skipped without them.
"""
import asyncio
import importlib
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

try:
    from aiohttp.test_utils import TestClient, TestServer
    import PyOpenColorIO as ocio
except Exception:  # noqa: BLE001
    ocio = None

MINIMAL = """ocio_profile_version: 2
roles:
  default: lin
  scene_linear: lin
displays:
  srgb_d:
    - !<View> {name: plain, colorspace: srgb}
colorspaces:
  - !<ColorSpace>
    name: lin
    encoding: scene-linear
  - !<ColorSpace>
    name: srgb
    from_scene_reference: !<ExponentTransform> {value: [2.2, 2.2, 2.2, 1], direction: inverse}
  - !<ColorSpace>
    name: my plate log
"""


@unittest.skipIf(web is None or ocio is None, "needs aiohttp and PyOpenColorIO")
class OcioConfig(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.home = os.path.join(cls.tmp, "home")
        os.makedirs(cls.home)
        cls.old_home = os.environ.get("HOME")
        os.environ["HOME"] = cls.home
        cls.old_ocio = os.environ.pop("OCIO", None)
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, [])
        cls.color_io = importlib.import_module(cls.pkg + ".color_io")
        cls.comp_ocio = importlib.import_module(cls.pkg + ".comp_ocio")
        cls.cfg = os.path.join(cls.tmp, "studio.ocio")
        with open(cls.cfg, "w", encoding="utf-8") as fh:
            fh.write(MINIMAL)

    @classmethod
    def tearDownClass(cls):
        cls.color_io.set_config("")
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        if cls.old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = cls.old_home
        if cls.old_ocio is not None:
            os.environ["OCIO"] = cls.old_ocio
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, method, body=None, origin=True):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as c:
                headers = {"Origin": f"http://{c.host}:{c.port}"} if origin else {}
                if method == "GET":
                    res = await c.get("/imageviewer/ocio_config")
                else:
                    res = await c.post("/imageviewer/ocio_config", json=body, headers=headers)
                return res.status, await res.json()
        return asyncio.run(go())

    def test_the_built_in_default_has_aces(self):
        self.color_io.set_config("")
        names = [c["name"] for c in self.comp_ocio.info()["colorspaces"]]
        self.assertIn("ACEScg", names)
        # The bar's one output: the sRGB ENCODING, never the ACES view that tone-maps (the menu picks the input).
        srgb = self.comp_ocio.info()["srgb"]
        self.assertEqual(srgb, {"dst": "sRGB Encoded Rec.709 (sRGB)"})
        self.assertTrue(self.comp_ocio.resolve(dict({"src": "ACEScg"}, **srgb)))
        # Sebastian's check: a picture taken from sRGB into ACEScg and shown as ACEScg looks as it started.
        import numpy as np
        px = np.array([[[0.2, 0.5, 0.8], [0.05, 0.9, 0.3], [1.0, 1.0, 1.0]]], np.float32)
        to_cg = self.comp_ocio.apply_rgb(px.copy(), {"src": "sRGB Encoded Rec.709 (sRGB)", "dst": "ACEScg"})
        back = self.comp_ocio.apply_rgb(to_cg, dict({"src": "ACEScg"}, **srgb))
        self.assertLess(float(np.abs(back - px).max()), 1e-3)
        # The page's preview: an exact matrix into linear Rec.709, then the sRGB curve - within a level.
        lin = self.comp_ocio.info()["srgb_linear"]
        self.assertEqual(lin, "Linear Rec.709 (sRGB)")
        M = sys.modules[self.comp_ocio.__name__.rsplit('.', 1)[0] + '.comp_model']
        src = np.random.RandomState(1).rand(1, 400, 3).astype(np.float32)
        cg = self.comp_ocio.apply_rgb(src, {"src": "sRGB Encoded Rec.709 (sRGB)", "dst": "ACEScg"})
        lut = self.comp_ocio.bake({"src": "ACEScg", "dst": lin})
        self.assertEqual(lut[1], "matrix")
        shown = self.comp_ocio._srgb_curve(np.clip(M.apply_lut(cg, lut), 0, None))
        self.assertLessEqual(float(np.abs(np.round(shown * 255) - np.round(src * 255)).max()), 1.0)
        st, d = self.call("GET")
        self.assertEqual(st, 200)
        self.assertEqual(d["source"], "built-in")
        self.assertTrue(any(b["value"] == "ocio://default" for b in d["builtin"]))

    def test_a_config_file_is_checked_kept_and_used_at_once(self):
        self.color_io.set_config("")
        self.comp_ocio.info()   # the built-in one loaded first, so a change must replace it
        st, d = self.call("POST", {"config": self.cfg})
        self.assertEqual(st, 200, d)
        self.assertEqual(d["chosen"], os.path.abspath(self.cfg))
        self.assertEqual(d["source"], "settings")
        info = self.comp_ocio.info()
        self.assertEqual([c["name"] for c in info["colorspaces"]], ["lin", "srgb", "my plate log"])
        self.assertEqual(info["working"], "lin")
        with open(self.color_io.config_file(), encoding="utf-8") as fh:
            self.assertEqual(fh.read().strip(), os.path.abspath(self.cfg))
        # Back to nothing chosen.
        st, d = self.call("POST", {"config": ""})
        self.assertEqual((st, d["chosen"], d["source"]), (200, "", "built-in"))
        self.assertFalse(os.path.exists(self.color_io.config_file()))

    def test_a_built_in_config_by_name(self):
        st, d = self.call("POST", {"config": "ocio://studio-config-latest"})
        self.assertEqual(st, 200, d)
        self.assertEqual(d["source"], "settings")
        self.assertGreater(d["colorspaces"], 20)
        self.call("POST", {"config": ""})

    def test_what_is_not_a_config_is_refused(self):
        bad = os.path.join(self.tmp, "broken.ocio")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("not: [a config")
        for choice, words in ((os.path.join(self.tmp, "nothing.ocio"), "no file"),
                              (os.path.join(self.tmp, "notes.txt"), ".ocio file"),
                              (bad, "could not read")):
            st, d = self.call("POST", {"config": choice})
            self.assertEqual(st, 400, (choice, d))
            self.assertIn(words, d["error"])
        self.assertEqual(self.color_io.chosen_config(), "")

    def test_another_site_may_not_change_it(self):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as c:
                res = await c.post("/imageviewer/ocio_config", json={"config": self.cfg},
                                   headers={"Origin": "http://evil.example"})
                return res.status
        self.assertEqual(asyncio.run(go()), 403)
        self.assertEqual(self.color_io.chosen_config(), "")


if __name__ == "__main__":
    unittest.main()
