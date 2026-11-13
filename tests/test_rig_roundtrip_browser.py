"""A character to FBX / USD and back, in a real browser (js/imageViewer_previzRigRoundTrip.js).

The REAL viewer js against stubbed ComfyUI (tests/harness/tabs.html), as tests/test_rig_tools_browser.py:
the rig routes are answered in the test with the real writers (src/rig_export.py) and the real reader
(src/rig_import.py). A rigged character is keyed, exported with its rig, its rig taken off and brought
back from the file (ids, keys and pose as they were); the file's motion baked onto the controls instead;
and a USD export's motion put on another character whose bones are named another way (Unreal's), by
humanoid role.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_rig_roundtrip_browser
"""
import json
import os
import shutil
import struct
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tests"))
sys.path.insert(0, os.path.join(ROOT, "src"))
import rig_fixture  # noqa: E402
import test_rig_tools_browser as T  # noqa: E402

try:
    import pxr  # noqa: F401
    HAVE_USD = True
except ImportError:  # pragma: no cover
    HAVE_USD = False

KEY_ARM = """async () => {
  const P = window.__panel;
  const c = P.previzScene().items.find((it) => it.name === 'mixamorigLeftArm_fk');
  P.previzScene().items.find((it) => it.name === 'arm_L_ik').ikfk = 0;
  P.setFrame(0); P.previzSelect(c.id); P.previzSetChannel('rotation', 2, 0); P.previzRigKeyAll(window.__hero);
  P.setFrame(24); P.previzSetChannel('rotation', 2, -90); P.previzRigKeyAll(window.__hero);
  return window.__boneAt('LeftHand', 24);
}"""

RIG_STATE = """() => {
  const P = window.__panel;
  const items = P.previzScene().items.filter((it) => (it.kind === 'control' && it.control.model === window.__hero)
                                                 || (it.rig && it.rig.model === window.__hero));
  const keys = items.reduce((n, it) => n + Object.values(it.tracks || {}).reduce((m, t) => m + t.length, 0), 0);
  return { ids: items.map((it) => it.id).sort(), keys };
}"""


@unittest.skipIf(T.sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class RigRoundTripBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        T.RigToolsBrowserTests.setUpClass.__func__(cls)
        with open(os.path.join(cls.tmp, "ue.glb"), "wb") as fh:
            fh.write(rig_fixture.build(names="unreal"))

    @classmethod
    def tearDownClass(cls):
        T.RigToolsBrowserTests.tearDownClass.__func__(cls)

    def page(self):
        import rig_export
        import rig_import
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        tmp = self.tmp
        self.exports = []

        def export(route, request):
            meta, blobs = T._multipart(request)
            data = rig_export.parse_payload(meta, blobs)
            out = os.path.join(tmp, f"out{len(self.exports)}.{meta['format']}")
            getattr(rig_export, {"fbx": "write_fbx", "usd": "write_usd", "abc": "write_abc"}[meta["format"]])(out, data)
            self.exports.append(meta)
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"ok": True, "path": out, "relative": "characters/" + os.path.basename(out)}))

        def read_motion(route, request):
            body = json.loads(request.post_data or "{}")
            try:
                out = rig_import.read(body["path"])
                route.fulfill(status=200, content_type="application/json", body=json.dumps(out))
            except Exception as e:  # noqa: BLE001
                route.fulfill(status=422, content_type="application/json", body=json.dumps({"error": str(e)}))

        pg.route("**/imageviewer/rig/export", export)
        pg.route("**/imageviewer/rig/read_motion", read_motion)
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        return pg

    def _file(self, out):
        return {"path": out["path"], "url": "/media/" + os.path.basename(out["path"])}

    def test_fbx_brings_the_rig_back_or_bakes_its_motion(self):
        pg = self.page()
        try:
            pg.evaluate(T.OPEN, ["hero.glb", "Hero"])
            pg.evaluate("async () => { await window.__panel.previzRigCharacter(window.__hero); }")
            pg.evaluate(T.HELP)
            hand24 = pg.evaluate(KEY_ARM)
            before = pg.evaluate(RIG_STATE)
            fbx = pg.evaluate("async () => window.__panel.previzRigExport(window.__hero, 'fbx', { first: 0, last: 30 })")
            self.assertTrue(fbx["path"].endswith(".fbx"), fbx)
            self.assertIn("live", self.exports[-1])
            # The rig taken off: the arm is back at rest.
            pg.evaluate("async () => { window.__panel.previzRemoveRig(window.__hero); await window.__panel.previzChanged({ reload: true }); }")
            self.assertEqual(pg.evaluate(RIG_STATE)["ids"], [])
            # Back from the file, unchanged since: the rig as it was (no rig needed first).
            back = pg.evaluate("async (f) => window.__panel.previzRigAddMotion(window.__hero, f)", self._file(fbx))
            self.assertTrue(back.get("ok"), back)
            self.assertEqual((back["how"], back["unchanged"]), ("restore", True))
            after = pg.evaluate(RIG_STATE)
            self.assertEqual(after, before)
            for a, b in zip(pg.evaluate("() => window.__boneAt('LeftHand', 24)"), hand24):
                self.assertAlmostEqual(a, b, delta=1e-3)
            # The same file's motion baked onto the controls instead: the hand still gets there.
            pg.evaluate("""() => { const P = window.__panel;
                for (const it of P.previzScene().items) if (it.kind === 'control') it.tracks = {}; P.previzChanged(); }""")
            baked = pg.evaluate("async (f) => window.__panel.previzRigAddMotion(window.__hero, f, { how: 'bake' })", self._file(fbx))
            self.assertTrue(baked.get("ok"), baked)
            self.assertEqual(baked["how"], "bake")
            self.assertEqual(baked["matched"], len(rig_fixture.BONES))
            self.assertEqual((baked["first"], baked["last"]), (0, 30))
            for a, b in zip(pg.evaluate("() => window.__boneAt('LeftHand', 24)"), hand24):
                self.assertAlmostEqual(a, b, delta=0.01)
            # Through the dialog: the rig back, the way it says it will.
            pg.evaluate("""async (f) => { const P = window.__panel; const read = await P.previzRigReadMotion(f);
                           P._previzAddMotionAsk(window.__hero, { name: 'out0.fbx', path: f.path, url: f.url }, read); }""", self._file(fbx))
            box = pg.locator('.rd-box[aria-label="Add motion from file"]')
            box.wait_for(state="visible", timeout=10000)
            note = box.inner_text()
            how = box.locator("select").first.input_value()
            box.locator("button.rd-go").click()
            box.wait_for(state="detached", timeout=30000)
            restored = pg.evaluate(RIG_STATE)
            # The menu has the entries.
            pg.locator("button.previz-anim").first.click()          # the Animation menu
            labels = pg.locator("button.previz-menu-item").all_inner_texts()
            pg.evaluate("() => window.__panel._previzCloseAddMenu()")
            pg.locator("button.previz-mb-file").first.click()       # File > Export character
            labels += pg.locator("button.previz-menu-item").all_inner_texts()
        finally:
            pg.close()
        self.assertIn("31 frames", note)
        self.assertIn("unchanged", note)
        self.assertEqual(how, "restore")
        self.assertEqual(restored, before)
        self.assertTrue(any("Add motion from file" in s for s in labels), labels)
        self.assertTrue(any("Export USD" in s for s in labels), labels)
        self.assertEqual(self.errors, [])

    def test_several_motions_go_into_the_clip_sequencer(self):
        pg = self.page()
        try:
            pg.evaluate(T.OPEN, ["hero.glb", "Hero"])
            pg.evaluate("async () => { await window.__panel.previzRigCharacter(window.__hero); }")
            pg.evaluate(T.HELP)
            hand24 = pg.evaluate(KEY_ARM)
            fbx = pg.evaluate("async () => window.__panel.previzRigExport(window.__hero, 'fbx', { first: 0, last: 30 })")
            two = os.path.join(self.tmp, "walk_two.fbx")
            shutil.copyfile(fbx["path"], two)
            files = [dict(self._file(fbx), name="walk_one.fbx"), {"path": two, "url": "/media/walk_two.fbx", "name": "walk_two.fbx"}]
            # The controls' keys gone: what plays afterwards is the clips.
            pg.evaluate("""() => { const P = window.__panel;
                for (const it of P.previzScene().items) if (it.kind === 'control') it.tracks = {}; P.previzChanged(); }""")
            out = pg.evaluate("""async (files) => { const P = window.__panel; const takes = [];
                for (const f of files) takes.push(...(await P.previzRigReadMotion(f, { clips: 'all' })).takes);
                const r = P.previzRigAddMotionClips(window.__hero, takes, { start: 5 });
                const Q = await import('/extensions/viewer/imageViewer_clipSeqData.js');
                const q = Q.seqOf(P.previzScene());
                return { r, names: takes.map((t) => t.name), clips: q.tracks.flatMap((t) => t.clips.map((c) => [c.start, c.length])) }; }""", files)
            state = pg.evaluate(RIG_STATE)
            hand = pg.evaluate("() => window.__boneAt('LeftHand', 29)")
            # Through the dialog: two more sources, placed after the first two.
            pg.evaluate("""async (files) => { const P = window.__panel; const reads = [];
                for (const f of files) reads.push({ f, read: await P.previzRigReadMotion(f, { clips: 'all' }) });
                P._previzAddMotionsAsk(window.__hero, reads, reads.flatMap((x) => x.read.takes)); }""", files)
            box = pg.locator('.rd-box[aria-label="Add motions from files"]')
            box.wait_for(state="visible", timeout=10000)
            note = box.inner_text()
            box.locator("button.rd-go").click()
            box.wait_for(state="detached", timeout=30000)
            sources = pg.evaluate("""async () => { const Q = await import('/extensions/viewer/imageViewer_clipSeqData.js');
                return Q.seqOf(window.__panel.previzScene()).sources.length; }""")
        finally:
            pg.close()
        self.assertTrue(out["r"]["ok"], out)
        self.assertEqual(out["names"], ["walk_one", "walk_two"])
        self.assertEqual(len(out["r"]["sources"]), 2)
        self.assertEqual(sorted(out["clips"]), [[5, 30], [35, 30]])
        self.assertEqual(state["keys"], 0, "the controls keep their own keys (none)")
        for a, b in zip(hand, hand24):
            self.assertAlmostEqual(a, b, delta=0.01)
        self.assertIn("2 from 2 files", note)
        self.assertEqual(sources, 4)
        self.assertEqual(self.errors, [])

    def test_an_fbx_in_centimetres_comes_in_at_metres(self):
        pg = self.page()
        try:
            pg.evaluate(T.OPEN, ["hero.glb", "Hero"])
            pg.evaluate("async () => { await window.__panel.previzRigCharacter(window.__hero); }")
            fbx = pg.evaluate("async () => window.__panel.previzRigExport(window.__hero, 'fbx', { first: 0, last: 4 })")
            # The same file saying its unit is the centimetre (as Mixamo's and Maya's do).
            with open(fbx["path"], "rb") as fh:
                data = bytearray(fh.read())
            key = b"S\x0f\x00\x00\x00UnitScaleFactor"
            at = data.index(key)
            hundred = b"D" + struct.pack("<d", 100.0)
            v = data.index(hundred, at)
            data[v:v + 9] = b"D" + struct.pack("<d", 1.0)
            with open(os.path.join(self.tmp, "in_cm.fbx"), "wb") as fh:
                fh.write(data)
            shutil.copyfile(fbx["path"], os.path.join(self.tmp, "in_m.fbx"))
            got = pg.evaluate("""async () => { const P = window.__panel; const out = {};
                for (const name of ['in_cm.fbx', 'in_m.fbx']) {
                    await P.previzAddModels([{ url: '/media/' + name, filename: name, name, kind: 'model' }]);
                    await P._modelView().whenLoaded(20000);
                    await new Promise((r) => setTimeout(r, 300));
                    const it = P.previzScene().items.find((i) => i.id === P._previzSelection);
                    out[name] = it.scale;
                }
                return out; }""")
        finally:
            pg.close()
        self.assertEqual(got["in_cm.fbx"], [0.01, 0.01, 0.01])
        self.assertEqual(got["in_m.fbx"], [1, 1, 1])
        self.assertEqual(self.errors, [])

    @unittest.skipUnless(HAVE_USD, "needs usd-core")
    def test_usd_motion_onto_a_character_named_another_way(self):
        pg = self.page()
        try:
            pg.evaluate(T.OPEN, ["hero.glb", "Hero"])
            pg.evaluate("async () => { await window.__panel.previzRigCharacter(window.__hero); }")
            pg.evaluate(T.HELP)
            hand24 = pg.evaluate(KEY_ARM)
            usd = pg.evaluate("async () => window.__panel.previzRigExport(window.__hero, 'usd', { first: 0, last: 24 })")
            self.assertTrue(usd["path"].endswith(".usd"), usd)
            # Unreal's names on the same body: pelvis, upperarm_l, hand_l...
            pg.evaluate(T.OPEN, ["ue.glb", "Mannequin"])
            rig = pg.evaluate("async () => { const r = await window.__panel.previzRigCharacter(window.__hero); return { humanoid: r.humanoid }; }")
            self.assertTrue(rig["humanoid"])
            plan = pg.evaluate("""async (f) => { const P = window.__panel; const read = await P.previzRigReadMotion(f);
                                   return P.previzRigMotionPlan(window.__hero, read); }""", self._file(usd))
            self.assertFalse(plan["live"]["ok"])             # another skeleton: its rig cannot come back here
            self.assertEqual(plan["frames"], 25)
            baked = pg.evaluate("async (f) => window.__panel.previzRigAddMotion(window.__hero, f)", self._file(usd))
            self.assertTrue(baked.get("ok"), baked)
            self.assertEqual(baked["how"], "bake")
            self.assertGreaterEqual(baked["matched"], 20)
            hand = pg.evaluate("""() => { const [p] = window.__panel._modelView().rigPosesAt(window.__hero, [24]);
                                  const m = p.pose.get('hand_l'); return [m[12], m[13], m[14]]; }""")
        finally:
            pg.close()
        for a, b in zip(hand, hand24):
            self.assertAlmostEqual(a, b, delta=0.02)
        self.assertEqual(self.errors, [])


REEXPORT = r'''
import sys, bpy
src, dst = sys.argv[1], sys.argv[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
if src.endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=src, anim_offset=0)
else:
    bpy.ops.wm.usd_import(filepath=src)
bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, 24
if dst.endswith(".fbx"):
    bpy.ops.export_scene.fbx(filepath=dst, use_custom_props=True, bake_anim=True, add_leaf_bones=False)
else:
    bpy.ops.wm.usd_export(filepath=dst, export_animation=True)
print("DONE")
'''


def _bpy():
    import test_rig_roundtrip
    return test_rig_roundtrip._bpy_python()


@unittest.skipIf(T.sync_playwright is None or shutil.which("node") is None or not _bpy(),
                 "needs playwright, node and Blender's Python module")
class ThroughBlender(RigRoundTripBrowserTests):
    """Exported here, opened and saved again by Blender (no change), brought back: the rig comes back from
    Blender's FBX (it keeps the property), and Blender's USD motion bakes onto the controls."""

    test_fbx_brings_the_rig_back_or_bakes_its_motion = None
    test_usd_motion_onto_a_character_named_another_way = None

    def blender(self, src, dst):
        import subprocess
        script = os.path.join(self.tmp, "reexport.py")
        with open(script, "w") as fh:
            fh.write(REEXPORT)
        r = subprocess.run([_bpy(), script, src, dst], capture_output=True, text=True, timeout=300)
        self.assertIn("DONE", r.stdout, r.stdout[-2000:] + r.stderr[-2000:])
        return {"path": dst, "url": "/media/" + os.path.basename(dst)}

    def run_through(self, fmt):
        pg = self.page()
        try:
            pg.evaluate(T.OPEN, ["hero.glb", "Hero"])
            pg.evaluate("async () => { await window.__panel.previzRigCharacter(window.__hero); }")
            pg.evaluate(T.HELP)
            hand24 = pg.evaluate(KEY_ARM)
            before = pg.evaluate(RIG_STATE)
            out = pg.evaluate(f"async () => window.__panel.previzRigExport(window.__hero, '{fmt}', {{ first: 0, last: 24 }})")
            ext = ".fbx" if fmt == "fbx" else ".usda"
            f = self.blender(out["path"], os.path.join(self.tmp, "from_blender" + ext))
            plan = pg.evaluate("""async (f) => { const P = window.__panel; const read = await P.previzRigReadMotion(f);
                                   return P.previzRigMotionPlan(window.__hero, read); }""", f)
            pg.evaluate("() => { const P = window.__panel; for (const it of P.previzScene().items) if (it.kind === 'control') it.tracks = {}; P.previzChanged(); }")
            got = pg.evaluate("async (f) => window.__panel.previzRigAddMotion(window.__hero, f)", f)
            state = pg.evaluate(RIG_STATE)
            hand = pg.evaluate("() => window.__boneAt('LeftHand', 24)")
        finally:
            pg.close()
        self.assertTrue(got.get("ok"), got)
        for a, b in zip(hand, hand24):
            self.assertAlmostEqual(a, b, delta=0.01, msg=(plan, got))
        self.assertEqual(self.errors, [])
        return plan, got, state, before

    def test_fbx_through_blender(self):
        plan, got, state, before = self.run_through("fbx")
        self.assertTrue(plan["live"]["ok"], plan)
        self.assertTrue(plan["unchanged"], plan)
        self.assertEqual(got["how"], "restore")
        self.assertEqual(state, before)

    @unittest.skipUnless(HAVE_USD, "needs usd-core")
    def test_usd_through_blender(self):
        plan, got, state, before = self.run_through("usd")
        self.assertEqual(got["how"], "restore" if plan["live"]["ok"] and plan["unchanged"] else "bake")


if __name__ == "__main__":
    unittest.main()
