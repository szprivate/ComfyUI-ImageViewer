"""A character out to FBX / USD and back (src/rig_export.py, src/rig_import.py).

The writers and the reader against each other, the FBX skin's bind matrices as other readers take them
(Transform = the mesh in the bone's space), and - when Blender's Python module is installed (pip install
bpy, Python 3.11) - Blender itself importing both files: the mesh where the viewer had it, frame by frame.

    python -m unittest tests.test_rig_roundtrip
"""
import importlib.util
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import textwrap
import unittest

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "src"))
import rig_export  # noqa: E402
import rig_import  # noqa: E402

try:
    import pxr  # noqa: F401
    HAVE_USD = True
except ImportError:  # pragma: no cover
    HAVE_USD = False

LIVE = {"v": 1, "kind": "imageviewer.rig", "items": [{"id": "c1", "kind": "control", "name": "Ünïcode"}],
        "model": {"id": "m1", "bones": ["root", "arm"]}}


def _q(axis, deg):
    a = math.radians(deg) / 2
    v = np.asarray(axis, float) / np.linalg.norm(axis)
    return [*(v * math.sin(a)), math.cos(a)]


def stick(root_t=(2.0, 0.0, -1.0), root_deg=90.0):
    """Two bones (a root at 1 m, an arm along +X) and a box skinned to the arm, the arm turning 90° about Z
    over 5 frames; the character itself stands at `root_t`, turned `root_deg` about Y (its Null / SkelRoot)."""
    rq = _q([0, 1, 0], root_deg)
    g0 = rig_export._trs_matrix(root_t, rq, [1, 1, 1])
    bind0 = rig_export._trs_matrix([0, 1, 0], [0, 0, 0, 1], [1, 1, 1])
    bind1 = rig_export._trs_matrix([0.5, 1, 0], [0, 0, 0, 1], [1, 1, 1])
    box = np.array([[x, y, z] for x in (0.5, 1.0) for y in (0.95, 1.05) for z in (-0.05, 0.05)], np.float32)
    idx = np.array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3],
                   np.uint32)
    frames = list(range(5))
    anim = []
    for f in frames:
        anim.append([0, 1, 0, 0, 0, 0, 1, 1, 1, 1])
        anim.append([0.5, 0, 0, *_q([0, 0, 1], 22.5 * f), 1, 1, 1])
    return {
        "name": "Stick", "fps": 24, "frames": frames,
        "root": {"t": list(root_t), "q": rq, "s": [1, 1, 1]}, "rootMatrix": list(g0.ravel(order="F")),
        "bones": [{"name": "root", "parent": -1, "rest": {"t": [0, 1, 0], "q": [0, 0, 0, 1], "s": [1, 1, 1]},
                   "bind": list(bind0.ravel(order="F"))},
                  {"name": "arm", "parent": 0, "rest": {"t": [0.5, 0, 0], "q": [0, 0, 0, 1], "s": [1, 1, 1]},
                   "bind": list(bind1.ravel(order="F"))}],
        "meshes": [{"name": "Box", "positions": box.ravel(), "indices": idx, "normals": None, "uvs": None,
                    "joints": np.array([[1, 0, 0, 0]] * len(box), np.uint32).ravel(),
                    "weights": np.array([[1, 0, 0, 0]] * len(box), np.float32).ravel()}],
        "anim": np.array(anim, np.float32).ravel(),
        "rootAnim": np.array([[*root_t, *rq, 1, 1, 1]] * len(frames), np.float32).ravel(),
        "live": LIVE,
    }


def _fbx_records(path):
    with open(path, "rb") as fh:
        buf = fh.read()
    return rig_import._read_records(buf, 27, len(buf), False)


class LivePacking(unittest.TestCase):
    def test_pack_and_unpack(self):
        s = rig_export.pack_live(LIVE)
        self.assertTrue(s.isascii())
        self.assertEqual(rig_export.unpack_live(s), LIVE)
        self.assertIsNone(rig_export.unpack_live("some other tool's value"))
        self.assertIsNone(rig_export.unpack_live("ivz1:%%%"))
        self.assertIsNone(rig_export.unpack_live(None))


class FbxRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_the_rig_and_the_settings_come_back(self):
        p = os.path.join(self.tmp, "stick.fbx")
        rig_export.write_fbx(p, stick())
        info = rig_import.read_fbx(p)
        self.assertEqual(info["live"], LIVE)
        self.assertEqual((info["version"], info["fps"], info["unit_cm"], info["up"]), (7400, 24, 100.0, "y"))
        d = stick()
        d.pop("live")
        rig_export.write_fbx(p, d)
        self.assertIsNone(rig_import.read_fbx(p)["live"])

    def test_cluster_transform_is_the_mesh_in_the_bones_space(self):
        """TransformLink . Transform = the mesh's own place at bind time (the character's Null here, turned and
        moved): what the SDK's files hold, and what Blender and ufbx read. Writing the mesh's place itself in
        Transform put the mesh off by the bone's offset in Blender."""
        p = os.path.join(self.tmp, "stick.fbx")
        d = stick()
        rig_export.write_fbx(p, d)
        objects = next(r for r in _fbx_records(p) if r.name == "Objects")
        clusters = [r for r in objects.kids if r.name == "Deformer" and r.props[2] == "Cluster"]
        self.assertEqual(len(clusters), 1)
        tx = np.array(clusters[0].find("Transform").props[0]).reshape(4, 4, order="F")
        link = np.array(clusters[0].find("TransformLink").props[0]).reshape(4, 4, order="F")
        g0 = np.array(d["rootMatrix"]).reshape(4, 4, order="F")
        np.testing.assert_allclose(link @ tx, g0, atol=1e-9)
        bind1 = np.array(d["bones"][1]["bind"]).reshape(4, 4, order="F")
        np.testing.assert_allclose(link, g0 @ bind1, atol=1e-9)

    def test_ascii_fbx_is_searched_for_the_rig(self):
        p = os.path.join(self.tmp, "maya.fbx")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(textwrap.dedent(f"""\
                ; FBX 7.5.0 project file
                FBXHeaderExtension:  {{
                }}
                GlobalSettings:  {{
                    Properties70:  {{
                        P: "UpAxis", "int", "Integer", "",2
                        P: "UnitScaleFactor", "double", "Number", "",1
                        P: "TimeMode", "enum", "", "",6
                    }}
                }}
                Objects:  {{
                    Model: 1, "Model::Stick", "Null" {{
                        Properties70:  {{
                            P: "{rig_export.LIVE_PROP}", "KString", "", "U", "{rig_export.pack_live(LIVE)}"
                        }}
                    }}
                }}
                """))
        info = rig_import.read_fbx(p)
        self.assertEqual(info["live"], LIVE)
        self.assertEqual((info["fps"], info["unit_cm"], info["up"]), (30, 1.0, "z"))

    def test_not_an_fbx(self):
        p = os.path.join(self.tmp, "x.fbx")
        with open(p, "w") as fh:
            fh.write("hello")
        with self.assertRaises(ValueError):
            rig_import.read_fbx(p)


@unittest.skipUnless(HAVE_USD, "needs usd-core")
class UsdRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_written_and_read_back(self):
        from pxr import Usd, UsdGeom, UsdSkel
        d = stick()
        p = os.path.join(self.tmp, "stick.usda")
        rig_export.write_usd(p, d)
        info = rig_import.read_usd(p)
        self.assertEqual(info["live"], LIVE)
        self.assertEqual((info["fps"], info["meters"], info["up"]), (24.0, 1.0, "y"))
        self.assertEqual([j["name"] for j in info["joints"]], ["root", "arm"])
        self.assertEqual([j["parent"] for j in info["joints"]], [-1, 0])
        self.assertEqual(info["frames"], [0.0, 1.0, 2.0, 3.0, 4.0])
        a = np.array(info["anim"])
        b = d["anim"].reshape(5, 2, 10)
        np.testing.assert_allclose(a[..., :3], b[..., :3], atol=1e-6)
        np.testing.assert_allclose(np.abs((a[..., 3:7] * b[..., 3:7]).sum(-1)), 1, atol=1e-6)   # the same turn
        np.testing.assert_allclose(info["bind"][1], d["bones"][1]["bind"], atol=1e-9)
        # UsdSkel's own skinning: the box at frame 4 (arm turned 90°) where the viewer's skinning puts it.
        stage = Usd.Stage.Open(p)
        cache = UsdSkel.Cache()
        root = UsdSkel.Root(stage.GetPrimAtPath("/Stick"))
        cache.Populate(root, Usd.TraverseInstanceProxies())
        binding = cache.ComputeSkelBindings(root, Usd.TraverseInstanceProxies())[0]
        skq = cache.GetSkelQuery(binding.GetSkeleton())
        target = binding.GetSkinningTargets()[0]
        t = Usd.TimeCode(4)
        xf = skq.ComputeSkinningTransforms(t)
        pts = target.GetPrim().GetAttribute("points").Get(t)
        target.ComputeSkinnedPoints(xf, pts, t)
        ours = rig_export.skinned_points(d, d["meshes"][0])[4]
        world = UsdGeom.Xformable(root).ComputeLocalToWorldTransform(t)
        theirs = np.array([list(world.Transform(v)) for v in pts])
        np.testing.assert_allclose(theirs, ours, atol=1e-5)

    def test_a_name_usd_cannot_hold(self):
        d = stick()
        d["bones"][0]["name"] = "mixamorig:Hips"
        d["bones"][1]["name"] = "1 arm"
        p = os.path.join(self.tmp, "names.usd")
        rig_export.write_usd(p, d)
        info = rig_import.read_usd(p)
        self.assertEqual([j["name"] for j in info["joints"]], ["mixamorig:Hips", "1 arm"])


def _bpy_python():
    """An interpreter with Blender's module: this one, or IMAGE_VIEWER_TEST_BPY_PYTHON."""
    if importlib.util.find_spec("bpy") is not None:
        return sys.executable
    return os.environ.get("IMAGE_VIEWER_TEST_BPY_PYTHON") or None


BLENDER_SCRIPT = r'''
import json, sys, bpy
path = sys.argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
if path.endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=path, anim_offset=0)
else:
    bpy.ops.wm.usd_import(filepath=path)
mesh = next(o for o in bpy.data.objects if o.type == "MESH")
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
props = {k: str(v) for o in bpy.data.objects for k, v in o.items() if isinstance(v, str)}
out = {"frames": {}, "props": props}
for f in range(5):
    bpy.context.scene.frame_set(f)
    me = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    # Blender is Z up: (x, y, z) here is (x, -z, y) in the viewer's Y up.
    out["frames"][f] = [[v.x, v.z, -v.y] for v in (me.matrix_world @ p.co for p in me.data.vertices)]
print("RESULT " + json.dumps(out))
'''


@unittest.skipUnless(_bpy_python(), "needs Blender's Python module (pip install bpy) or IMAGE_VIEWER_TEST_BPY_PYTHON")
class InBlender(unittest.TestCase):
    """Blender's own importers (FBX and USD) put the mesh where the viewer had it on every frame."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def blender(self, path):
        script = os.path.join(self.tmp, "check.py")
        with open(script, "w") as fh:
            fh.write(BLENDER_SCRIPT)
        r = subprocess.run([_bpy_python(), script, path], capture_output=True, text=True, timeout=300)
        line = next((ln for ln in r.stdout.splitlines() if ln.startswith("RESULT ")), None)
        self.assertIsNotNone(line, r.stdout[-2000:] + r.stderr[-2000:])
        return json.loads(line[7:])

    def check(self, ext):
        if ext != ".fbx" and not HAVE_USD:
            self.skipTest("needs usd-core")
        d = stick()
        p = os.path.join(self.tmp, "stick" + ext)
        (rig_export.write_fbx if ext == ".fbx" else rig_export.write_usd)(p, d)
        got = self.blender(p)
        ours = rig_export.skinned_points(d, d["meshes"][0])
        for f in range(5):
            theirs = np.array(sorted(map(tuple, np.round(got["frames"][str(f)], 4))))
            want = np.array(sorted(map(tuple, np.round(ours[f], 4))))
            np.testing.assert_allclose(theirs, want, atol=2e-3, err_msg=f"frame {f}")
        return got

    def test_fbx_in_blender(self):
        got = self.check(".fbx")
        self.assertEqual(rig_export.unpack_live(got["props"].get(rig_export.LIVE_PROP)), LIVE)

    def test_usd_in_blender(self):
        self.check(".usda")


if __name__ == "__main__":
    unittest.main()
