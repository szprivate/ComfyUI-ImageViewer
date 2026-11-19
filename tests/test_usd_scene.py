"""A 3D scene saved as USD (usd_scene / usd_io): meshes referenced, never baked in;
lights, image planes, built geometry and the scene's own data written; read back
exactly; the Outliner's edits inside an asset authored as overrides.

Needs usd-core, numpy and trimesh; skipped without them.
Run: python -m unittest tests.test_usd_scene
"""
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
    from pxr import Sdf, Usd, UsdGeom, UsdLux  # noqa: F401
    import numpy as np
    import trimesh
except Exception:                                   # pragma: no cover
    Usd = None


def _b64(arr, dtype):
    return base64.b64encode(np.asarray(arr, dtype=dtype).tobytes()).decode("ascii")


def _quad():
    return {"name": "card", "positions": _b64([[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0]], np.float32),
            "uvs": _b64([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32),
            "indices": _b64([0, 1, 2, 0, 2, 3], np.uint32)}


@unittest.skipIf(Usd is None, "needs usd-core, numpy and trimesh")
class UsdSceneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.dirs = {k: os.path.join(cls.tmp, k) for k in ("output", "input", "temp")}
        for d in cls.dirs.values():
            os.makedirs(d, exist_ok=True)
        fp = types.ModuleType("folder_paths")
        fp.get_output_directory = lambda: cls.dirs["output"]
        fp.get_input_directory = lambda: cls.dirs["input"]
        fp.get_temp_directory = lambda: cls.dirs["temp"]
        fp.get_directory_by_type = lambda t: cls.dirs.get(t)
        cls.saved_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = fp
        cls.pkg = "imageviewer_usd_scene_under_test"
        pkg = types.ModuleType(cls.pkg)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[cls.pkg] = pkg
        cls.us = importlib.import_module(cls.pkg + ".usd_scene")
        cls.uio = importlib.import_module(cls.pkg + ".usd_io")
        # A model in ComfyUI's input folder, as Import Model leaves it.
        os.makedirs(os.path.join(cls.dirs["input"], "3d"), exist_ok=True)
        cls.glb = os.path.join(cls.dirs["input"], "3d", "hero.glb")
        box = trimesh.creation.box((1, 2, 1))
        box.visual.vertex_colors = [200, 30, 30, 255]
        scene = trimesh.Scene()
        scene.add_geometry(box, node_name="Body", geom_name="Body")
        scene.add_geometry(trimesh.creation.icosphere(radius=0.3), node_name="Head", geom_name="Head")
        scene.export(cls.glb)
        # A USD asset with a variant set, referenced where it lies.
        cls.asset = os.path.join(cls.tmp, "props", "chair.usda")
        os.makedirs(os.path.dirname(cls.asset))
        st = Usd.Stage.CreateNew(cls.asset)
        root = UsdGeom.Xform.Define(st, "/Chair")
        st.SetDefaultPrim(root.GetPrim())
        vs = root.GetPrim().GetVariantSets().AddVariantSet("look")
        for name in ("wood", "metal"):
            vs.AddVariant(name)
        vs.SetVariantSelection("wood")
        UsdGeom.Cube.Define(st, "/Chair/Seat")
        UsdGeom.Cube.Define(st, "/Chair/Back")
        st.GetRootLayer().Save()

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        if cls.saved_fp is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = cls.saved_fp
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def scene(self):
        return {
            "fps": 25, "length": 50, "activeCamera": "cam",
            "animLayers": [{"id": "L1", "name": "fix", "mode": "additive", "weight": 1}],
            "sequencer": {"tracks": [{"id": "s1"}]},
            "displayLayers": [{"id": "d1", "name": "props", "visible": True, "mode": "normal"}],
            "items": [
                {"id": "grp", "kind": "group", "name": "Set", "parent": None,
                 "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {}},
                {"id": "hero", "kind": "model", "name": "Hero", "parent": "grp",
                 "src": {"filename": "hero.glb", "subfolder": "3d", "type": "input", "name": "hero.glb"},
                 "position": [1, 0, 0], "rotation": [0, 45, 0], "scale": [1, 1, 1],
                 "usd": {"overs": {"Scene/Head": {"visible": False}}},
                 "tracks": {"position": [{"f": 0, "v": [1, 0, 0], "ease": "linear"},
                                         {"f": 10, "v": [3, 0, 0], "ease": "linear"}]},
                 "layerTracks": {"L1": {"position": [{"f": 0, "v": [0, 1, 0], "ease": "linear"}]}}},
                {"id": "chair", "kind": "model", "name": "Chair", "parent": None,
                 "src": {"path": self.asset, "name": "chair.usda"},
                 "position": [0, 0, 2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {},
                 "usd": {"overs": {"Back": {"visible": False}}, "variants": {"": {"look": "metal"}}}},
                {"id": "cam", "kind": "camera", "name": "Shot cam", "parent": None, "fov": 40,
                 "lens": {"aperture": [24.89, 18.66], "fit": "horizontal", "shift": [0.1, 0], "near": 0.5, "far": 900},
                 "resolution": [1920, 1080], "position": [0, 1, 5], "rotation": [0, 0, 0], "scale": [1, 1, 1],
                 "tracks": {}},
                {"id": "key", "kind": "light", "name": "Key", "parent": None,
                 "light": {"type": "spot", "intensity": 40, "color": "#ffeedd", "angle": 25, "penumbra": 0.4,
                           "shadows": True},
                 "position": [2, 4, 2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {}},
                {"id": "sun", "kind": "light", "name": "Sun", "parent": None,
                 "light": {"type": "directional", "intensity": 3}, "position": [0, 10, 0],
                 "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {}},
                {"id": "plate", "kind": "imageplane", "name": "Plate", "parent": None,
                 "src": {"path": os.path.join(self.tmp, "plate.png")}, "plane": {"opacity": 1},
                 "position": [0, 0, -3], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {}},
                {"id": "ground", "kind": "terrain", "name": "Ground", "parent": None,
                 "terrain": {"size": 40}, "position": [0, 0, 0], "rotation": [0, 0, 0],
                 "scale": [1, 1, 1], "tracks": {}},
                {"id": "trees", "kind": "scatter", "name": "Trees", "parent": None, "scatter": {"count": 3},
                 "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {}},
            ],
        }

    def geometry(self):
        tri = {"name": "Ground", "color": "#557733",
               "positions": _b64([[0, 0, 0], [1, 0, 0], [0, 0, 1]], np.float32),
               "normals": _b64([[0, 1, 0]] * 3, np.float32)}
        eye = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
        inst = dict(_quad(), name="Pine", instances=_b64(
            [eye + [0, 0, 0, 1], eye + [5, 0, 0, 1], eye + [0, 0, 5, 1]], np.float32))
        return {"plate": {"meshes": [_quad()]}, "ground": {"meshes": [tri]}, "trees": {"meshes": [inst]}}

    def save(self, name="shot_v001.usda"):
        path = os.path.join(self.dirs["output"], "scenes", name)
        out = self.us.save(self.scene(), path, geometry=self.geometry())
        return path, out

    def test_meshes_are_referenced_from_the_scene_not_written_into_it(self):
        path, out = self.save()
        stage = Usd.Stage.Open(path, load=Usd.Stage.LoadNone)
        layer = stage.GetRootLayer()
        # The scene layer itself holds no mesh of the model, the terrain or the scatter.
        hero = layer.GetPrimAtPath("/previz/Set/Hero")
        payloads = list(hero.payloadList.prependedItems)
        self.assertEqual(len(payloads), 1)
        self.assertTrue(payloads[0].assetPath.startswith("./assets/hero_"), payloads[0].assetPath)
        self.assertFalse([c for c in hero.nameChildren if c.typeName == "Mesh"])
        chair = layer.GetPrimAtPath("/previz/Chair")
        # A file of the user's outside the scene's folder is named where it lies.
        self.assertEqual(list(chair.payloadList.prependedItems)[0].assetPath, self.asset.replace("\\", "/"))
        ground = layer.GetPrimAtPath("/previz/Ground")
        self.assertTrue(list(ground.payloadList.prependedItems)[0].assetPath.startswith("./assets/Ground_"))
        # The converted mesh and the built ones are real meshes, beside the scene.
        assets = os.path.join(os.path.dirname(path), "assets")
        self.assertEqual(sorted(os.path.dirname(a) for a in out["assets"]), [assets] * 3)
        full = Usd.Stage.Open(path)
        meshes = [p for p in full.Traverse() if p.IsA(UsdGeom.Mesh)]
        self.assertTrue(any(str(p.GetPath()).startswith("/previz/Set/Hero/") for p in meshes))
        inst = UsdGeom.PointInstancer(full.GetPrimAtPath("/previz/Trees/Pine"))
        self.assertTrue(inst)
        self.assertEqual(len(inst.GetPositionsAttr().Get()), 3)
        self.assertEqual(out["notes"], [])

    def test_saving_again_reuses_the_converted_mesh(self):
        _, a = self.save("again_v001.usda")
        _, b = self.save("again_v002.usda")
        self.assertEqual(a["assets"], b["assets"])

    def test_lights_cameras_and_image_planes_are_usd_ones(self):
        path, _ = self.save("lights_v001.usda")
        stage = Usd.Stage.Open(path, load=Usd.Stage.LoadNone)
        spot = stage.GetPrimAtPath("/previz/Key/Light")
        self.assertTrue(spot.IsA(UsdLux.SphereLight))
        self.assertAlmostEqual(UsdLux.ShapingAPI(spot).GetShapingConeAngleAttr().Get(), 25)
        self.assertTrue(UsdLux.ShadowAPI(spot).GetShadowEnableAttr().Get())
        self.assertTrue(stage.GetPrimAtPath("/previz/Sun/Light").IsA(UsdLux.DistantLight))
        # A light shines along its item's -Y, as the viewer's do.
        m = UsdGeom.Xformable(stage.GetPrimAtPath("/previz/Sun/Light")).GetLocalTransformation()
        d = m.TransformDir((0, 0, -1))
        self.assertAlmostEqual(d[1], -1, places=5)
        self.assertTrue(stage.GetPrimAtPath("/previz/Shot_cam").IsA(UsdGeom.Camera))
        # The camera's film back as the picture uses it, its lens shift, its clipping and the focal length
        cam = UsdGeom.Camera(stage.GetPrimAtPath("/previz/Shot_cam"))
        self.assertAlmostEqual(cam.GetHorizontalApertureAttr().Get(), 24.89, places=3)
        self.assertAlmostEqual(cam.GetVerticalApertureAttr().Get(), 24.89 * 9 / 16, places=3)
        self.assertAlmostEqual(cam.GetHorizontalApertureOffsetAttr().Get(), 2.489, places=3)
        self.assertAlmostEqual(tuple(cam.GetClippingRangeAttr().Get())[1], 900, places=3)
        import math
        focal = cam.GetFocalLengthAttr().Get(0) or cam.GetFocalLengthAttr().Get()
        self.assertAlmostEqual(focal, 24.89 * 9 / 16 / 2 / math.tan(math.radians(20)), places=2)
        card = stage.GetPrimAtPath("/previz/Plate/Card")
        self.assertTrue(card.IsA(UsdGeom.Mesh))
        tex = stage.GetPrimAtPath("/previz/Plate/Look/picture")
        self.assertIn("plate.png", str(tex.GetAttribute("inputs:file").Get()))
        # Animation is baked for other applications.
        hero = UsdGeom.Xformable(stage.GetPrimAtPath("/previz/Set/Hero"))
        self.assertTrue(len(hero.GetTimeSamples()) >= 10)

    def test_opening_gives_the_scene_back_exactly(self):
        path, _ = self.save("back_v001.usda")
        scene = self.us.load(path)
        want = self.scene()
        self.assertEqual([it["id"] for it in scene["items"]], [it["id"] for it in want["items"]])
        for key in ("animLayers", "sequencer", "displayLayers", "activeCamera"):
            self.assertEqual(scene[key], want[key], key)
        hero = next(it for it in scene["items"] if it["id"] == "hero")
        self.assertEqual(hero["src"]["filename"], "hero.glb")          # still the original file
        self.assertTrue(hero["src"]["usdAsset"].endswith(".usdc"))
        self.assertEqual(hero["layerTracks"], want["items"][1]["layerTracks"])
        self.assertEqual(hero["usd"], want["items"][1]["usd"])

    def test_a_model_whose_file_is_gone_falls_back_to_its_copy(self):
        moved = os.path.join(self.dirs["input"], "3d", "gone.glb")
        shutil.copy(self.glb, moved)
        scene = self.scene()
        scene["items"][1]["src"] = {"filename": "gone.glb", "subfolder": "3d", "type": "input"}
        path = os.path.join(self.dirs["output"], "scenes", "gone_v001.usda")
        self.us.save(scene, path)
        os.remove(moved)
        hero = next(it for it in self.us.load(path)["items"] if it["id"] == "hero")
        self.assertTrue(hero["src"]["path"].endswith(".usdc"))
        self.assertEqual(hero["src"]["format"], "usd")

    def test_outliner_edits_inside_an_asset_are_overrides(self):
        path, _ = self.save("edits_v001.usda")
        layer = Sdf.Layer.FindOrOpen(path)
        back = layer.GetPrimAtPath("/previz/Chair/Back")
        self.assertEqual(back.specifier, Sdf.SpecifierOver)
        self.assertEqual(back.attributes["visibility"].default, "invisible")
        chair = layer.GetPrimAtPath("/previz/Chair")
        self.assertEqual(dict(chair.variantSelections), {"look": "metal"})
        # The converted glb's head is found by its node name.
        full = Usd.Stage.Open(path)
        head = [p for p in Usd.PrimRange(full.GetPrimAtPath("/previz/Set/Hero")) if p.GetName() == "Head"]
        self.assertTrue(head)
        self.assertEqual(UsdGeom.Imageable(head[0]).ComputeVisibility(), UsdGeom.Tokens.invisible)
        # The asset itself is untouched.
        self.assertNotIn("metal", open(self.asset).read().split("variants = {")[-1][:40])

    def test_the_prim_tree_of_an_asset_with_edits(self):
        tree = self.us.prim_tree(self.asset)
        self.assertEqual(tree["root"], "/Chair")
        self.assertEqual([p["rel"] for p in tree["prims"]], ["Seat", "Back"])
        self.assertEqual(tree["variants"]["look"]["choices"], ["metal", "wood"])
        self.assertEqual(tree["variants"]["look"]["selection"], "wood")
        edited = self.us.prim_tree(self.asset, edits={"overs": {"Back": {"visible": False}},
                                                       "variants": {"": {"look": "metal"}}})
        self.assertFalse(next(p for p in edited["prims"] if p["rel"] == "Back")["visible"])
        self.assertEqual(edited["variants"]["look"]["selection"], "metal")

    def _instanced_layout(self, n=40, name="layout"):
        """A layout of n instanced copies of one referenced mesh (as Pixar's Kitchen Set
        instanced): its meshes are instance proxies."""
        folder = os.path.join(self.tmp, name)
        os.makedirs(folder, exist_ok=True)
        part = os.path.join(folder, "spoon.usda")
        st = Usd.Stage.CreateNew(part)
        root = UsdGeom.Xform.Define(st, "/Spoon")
        st.SetDefaultPrim(root.GetPrim())
        m = UsdGeom.Mesh.Define(st, "/Spoon/Geom")
        m.CreatePointsAttr([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)])
        m.CreateFaceVertexCountsAttr([4])
        m.CreateFaceVertexIndicesAttr([0, 1, 2, 3])
        st.GetRootLayer().Save()
        path = os.path.join(folder, "layout.usda")
        st = Usd.Stage.CreateNew(path)
        top = UsdGeom.Xform.Define(st, "/Set")
        st.SetDefaultPrim(top.GetPrim())
        for i in range(n):
            x = UsdGeom.Xform.Define(st, f"/Set/Spoon_{i}")
            x.AddTranslateOp().Set((float(i) * 2, 0.0, 0.0))
            x.GetPrim().GetReferences().AddReference("./spoon.usda")
            x.GetPrim().SetInstanceable(True)
        st.GetRootLayer().Save()
        return path, n

    def test_an_instanced_layout_draws_and_its_prims_are_listed(self):
        path, n = self._instanced_layout()
        verts, faces, _colors = self.uio.stage_to_mesh(path)
        self.assertEqual(len(verts), 4 * n)
        self.assertEqual(len(faces), 2 * n)
        self.assertAlmostEqual(float(verts[:, 0].max()), 2 * (n - 1) + 1)
        # One copy alone, in its own space.
        one, _f, _c = self.uio.stage_to_mesh(path, prim_path="/Set/Spoon_7")
        self.assertAlmostEqual(float(one[:, 0].max()), 1.0)
        tree = self.us.prim_tree(path, "/Set/Spoon_3")
        self.assertEqual([p["rel"] for p in tree["prims"]], ["Geom"])
        self.assertTrue(tree["prims"][0]["proxy"])
        # An override inside an instance cannot be authored; it is left out, not an error.
        edited = self.us.prim_tree(path, "/Set/Spoon_3", edits={"overs": {"Geom": {"visible": False}}})
        self.assertEqual(len(edited["prims"]), 1)

    def test_the_models_of_one_layout_share_one_open_stage(self):
        path, n = self._instanced_layout(30, "layout_shared")
        self.uio._STAGES.clear()
        seen = set()
        for i in range(n):
            self.uio.stage_to_mesh(path, prim_path=f"/Set/Spoon_{i}")
            with self.uio.shared_stage(path, f"/Set/Spoon_{i}") as stage:
                seen.add(id(stage))
        self.assertEqual(len(seen), 1)
        self.assertEqual(len(self.uio._STAGES), 1)
        # Edits are a stage of their own; the plain one is not touched by them.
        with self.uio.shared_stage(path, "/Set/Spoon_1", {"overs": {"": {"visible": False}}}) as edited:
            self.assertNotIn(id(edited), seen)

    def test_an_old_json_scene_still_opens_and_saves_as_usd(self):
        old = {"fps": 24, "length": 10, "items": [
            {"id": "b", "kind": "primitive", "name": "Box", "primitive": {"type": "box"}, "color": "#ff0000",
             "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "tracks": {}}]}
        path = os.path.join(self.dirs["output"], "scenes", "old.usda")
        self.us.save(old, path)
        back = self.us.load(path)
        self.assertEqual(back["items"][0]["primitive"], {"type": "box"})
        stage = Usd.Stage.Open(path)
        self.assertTrue(stage.GetPrimAtPath("/previz/Box").IsA(UsdGeom.Cube))


if __name__ == "__main__":
    unittest.main()
