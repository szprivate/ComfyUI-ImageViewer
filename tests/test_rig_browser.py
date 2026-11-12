"""Character rigs in the 3D space, in a real browser.

The REAL viewer js against stubbed ComfyUI (tests/harness/tabs.html), three.js from vendor/three. A small
skinned humanoid (tests/rig_fixture.py) is loaded, rigged from the Rig menu's code, and posed through its
controls: an FK control turns its bone, an IK foot drags the leg after it, and switching a limb from IK to FK
keeps the pose where it was.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_rig_browser
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import rig_fixture  # noqa: E402

OPEN = """async (name) => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const scene = P.previzScene();
  const item = S.makeModelItem({ url: '/media/' + name, filename: name }, 'Hero');
  scene.items.push(item);
  P._previzSelection = item.id;
  await P.previzChanged({ reload: true });
  const view = P._modelView();
  await view.whenLoaded(20000);
  window.__hero = item.id;
  return { id: item.id, bones: view._entries.get(item.id).bones.size };
}"""

RIG = """async () => {
  const P = window.__panel;
  const rig = await P.previzRigCharacter(window.__hero);
  const scene = P.previzScene();
  const kinds = {};
  for (const it of scene.items) if (it.kind === 'control') kinds[it.control.type] = (kinds[it.control.type] || 0) + 1;
  return { humanoid: rig.humanoid, kinds, selected: P.previzSelectedItem().name,
           outliner: P.previzPanel.querySelectorAll('.previz-item').length };
}"""

# Where a bone's head is, in model space, now.
HELP = """
  window.__boneAt = (name) => {
    const view = window.__panel._modelView();
    const pose = view.rigPose(window.__hero);
    const m = pose.get('mixamorig' + name);
    return [m[12], m[13], m[14]].map((v) => Math.round(v * 1000) / 1000);
  };
  window.__ctrl = (name) => window.__panel.previzScene().items.find((it) => it.name === name);
"""

FK = """async () => {
  const P = window.__panel;
  P.setFrame(0);
  const ik = window.__ctrl('arm_L_ik'); ik.ikfk = 0;          // the left arm on FK
  const c = window.__ctrl('mixamorigLeftArm_fk');
  const before = window.__boneAt('LeftHand');
  P.previzSelect(c.id);
  P.previzSetChannel('rotation', 2, -90);                      // swing the arm down
  const after = window.__boneAt('LeftHand');
  return { before, after };
}"""

IK = """async () => {
  const P = window.__panel;
  const c = window.__ctrl('leg_L_ik');
  const before = window.__boneAt('LeftFoot');
  P.previzSelect(c.id);
  P.previzSetChannel('position', 1, 0.3);                      // lift the left foot 0.3
  P.previzSetChannel('position', 2, 0.2);                      // and forward
  const foot = window.__boneAt('LeftFoot'), knee = window.__boneAt('LeftLeg'), hip = window.__boneAt('LeftUpLeg');
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return { before, foot, knee, thigh: d(hip, knee), shin: d(knee, foot) };
}"""

SWITCH = """async () => {
  const P = window.__panel;
  const ik = window.__ctrl('leg_L_ik');
  const foot = window.__boneAt('LeftFoot'), knee = window.__boneAt('LeftLeg');
  P.previzRigSwitchIkFk(ik.id, 'fk');
  const scene = P.previzScene();
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const ikfk = S.valueAt(scene.items.find((x) => x.id === ik.id), 'ikfk', 0);
  return { ikfk, foot, knee, foot2: window.__boneAt('LeftFoot'), knee2: window.__boneAt('LeftLeg') };
}"""

ROUNDTRIP = """async () => {
  const P = window.__panel;
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const scene = P.previzScene();
  const back = S.parseScene(S.serializeScene(scene));
  P.previzRemoveRig(window.__hero);
  const removed = P.previzScene().items.filter((it) => it.kind === 'control').length;
  const rest = window.__boneAt('LeftFoot');
  return { kept: back.items.filter((it) => it.kind === 'control').length, removed, rest };
}"""


# An animated leg switched IK -> FK -> IK on keyed frames, the COG turned: nothing jumps, before or after.
ANIMATED_SWITCH = """async () => {
  const P = window.__panel;
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const scene = () => P.previzScene();
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const at = async (f) => { P.setFrame(f); await new Promise((r) => setTimeout(r, 30)); };
  const bones = ['LeftFoot', 'LeftLeg', 'LeftHand', 'LeftForeArm'];
  const snap = () => Object.fromEntries(bones.map((b) => [b, window.__boneAt(b)]));
  const diff = (a, b) => Math.max(...bones.map((k) => d(a[k], b[k])));
  const out = {};
  // The character turned and the COG moved and turned: the switch must work in the rig's own space.
  const cog = window.__ctrl('cog_ctrl');
  P.previzSelect(cog.id);
  P.previzSetChannel('rotation', 1, 35);
  P.previzSetChannel('position', 1, -0.1);
  // Animate the left leg's IK foot: keys at 0 and 20.
  P._previzAutokey = true;
  const foot = window.__ctrl('leg_L_ik');
  await at(0); P.previzSelect(foot.id); P.previzSetChannel('position', 2, 0.1); S.setKeyframe && 0;
  P.previzRigKeyAll(window.__hero);
  await at(20); P.previzSelect(foot.id); P.previzSetChannel('position', 1, 0.35); P.previzSetChannel('position', 2, 0.3);
  P.previzRigKeyAll(window.__hero);
  // Switch to FK at 10.
  await at(9); const b9 = snap();
  await at(10); const b10 = snap();
  P.previzRigSwitchIkFk(foot.id, 'fk');
  await at(10); const a10 = snap();
  await at(9); const a9 = snap();
  out.toFK = { at10: diff(b10, a10), at9: diff(b9, a9), ikfk10: S.currentValue(scene(), foot, 'ikfk', 10), ikfk9: S.currentValue(scene(), foot, 'ikfk', 9) };
  // Bend the FK knee at 15, then back to IK at 15.
  await at(15);
  const knee = window.__ctrl('mixamorigLeftLeg_fk'); const pre15 = snap(); out.ik15pre = S.currentValue(scene(), foot, 'ikfk', 15); out.ikTrack = JSON.stringify(S.track(foot,'ikfk')); out.kneeTrack = JSON.stringify(S.track(knee,'rotation'));
  P.previzSelect(knee.id); P.previzSetChannel('rotation', 0, 100);
  const c15 = snap(); out.kneeVal = S.currentValue(scene(), knee, 'rotation', 15);
  P.previzRigSwitchIkFk(knee.id, 'ik');
  await at(15); const d15 = snap();
  await at(10); const a10b = snap();
  out.sanity = { bend: diff(pre15, c15), move9to15: diff(a9, pre15) };
  out.toIK = { at15: diff(c15, d15), at10kept: diff(a10, a10b), ikfk15: S.currentValue(scene(), foot, 'ikfk', 15) };
  // The arm with its pole, not animated: FK -> IK -> FK.
  P._previzAutokey = false;
  await at(30);
  const arm = window.__ctrl('arm_L_ik');
  const sh = window.__ctrl('mixamorigLeftArm_fk'), el = window.__ctrl('mixamorigLeftForeArm_fk');
  P.previzRigSwitchIkFk(arm.id, 'fk'); 
  P.previzSelect(sh.id); P.previzSetChannel('rotation', 2, -50); P.previzSelect(el.id); P.previzSetChannel('rotation', 1, -60);
  const e0 = snap();
  P.previzRigSwitchIkFk(arm.id, 'ik'); await at(30); const e1 = snap();
  P.previzRigSwitchIkFk(arm.id, 'fk'); await at(30); const e2 = snap();
  out.arm = { pose: diff(e0, a10), toIK: diff(e0, e1), backFK: diff(e1, e2) };
  // The menu label follows the blend.
  P.previzSelect(arm.id);
  return out;
}"""

# The view hides a limb's unused side; the Picker dims it and switches the limb.
IDLE_AND_PICKER = """async () => {
  const P = window.__panel;
  P.setPanelDocked('picker', true);
  P.setPanelMaximized ? 0 : 0;
  P._pkRender(true);
  const view = P._modelView();
  const vis = (n) => view._entries.get(window.__ctrl(n).id).object.visible;
  const tick = () => new Promise((r) => setTimeout(r, 120));
  P.previzSelect(null); P.setFrame(0); await tick();
  const r = {};
  r.ik = { armIk: vis('arm_L_ik'), pole: vis('arm_L_pole'), fkArm: vis('mixamorigLeftArm_fk'), fkHand: vis('mixamorigLeftHand_fk'), finger: vis('mixamorigLeftHandMiddle1_fk') };
  const pills = () => [...P.pickerPanel.querySelectorAll('.pk-ikfk')].map((b) => b.textContent);
  r.pills = pills();
  const pill = P.pickerPanel.querySelector(`.pk-ikfk[data-ik="${window.__ctrl('arm_L_ik').id}"]`);
  const hand = window.__boneAt('LeftHand');
  pill.click(); await tick(); P.setFrame(0); await tick();
  r.afterClick = { pills: pills(), hand, hand2: window.__boneAt('LeftHand'), armIk: vis('arm_L_ik'), fkArm: vis('mixamorigLeftArm_fk'),
     idleBtns: [...P.pickerPanel.querySelectorAll('.pk-btn.idle')].map((b) => b.title) };
  // A hidden control selected (outliner) shows.
  P.previzSelect(window.__ctrl('arm_L_ik').id); await tick();
  r.selShows = vis('arm_L_ik');
  P.previzSelect(null); await tick();
  r.unselHides = vis('arm_L_ik');
  return r;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class RigBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        with open(os.path.join(cls.tmp, "hero.glb"), "wb") as fh:
            fh.write(rig_fixture.build(prefix="mixamorig:"))
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.tmp)
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/tabs.html", timeout=1).read()
                break
            except Exception:
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                cls.browser = (cls.pw.chromium.launch(channel=channel, headless=True) if channel
                               else cls.pw.chromium.launch(headless=True))
                break
            except Exception:
                continue
        if cls.browser is None:
            cls.tearDownClass()
            raise unittest.SkipTest("no browser for playwright")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "browser", None):
            cls.browser.close()
        if getattr(cls, "pw", None):
            cls.pw.stop()
        if getattr(cls, "server", None):
            cls.server.kill()
            cls.server.wait()
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    def test_rig_pose_and_switch(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            opened = pg.evaluate(OPEN, "hero.glb")
            self.assertEqual(opened["bones"], len(rig_fixture.BONES))
            rig = pg.evaluate(RIG)
            pg.evaluate("() => {" + HELP + "}")
            fk = pg.evaluate(FK)
            ik = pg.evaluate(IK)
            sw = pg.evaluate(SWITCH)
            rt = pg.evaluate(ROUNDTRIP)
            pg.screenshot(path=os.environ.get("RIG_SHOT") or os.path.join(self.tmp, "rig.png"))
        finally:
            pg.close()
        self.assertTrue(rig["humanoid"])
        self.assertEqual(rig["kinds"], {"root": 1, "cog": 1, "fk": 26, "ik": 4, "pole": 4})
        self.assertEqual(rig["selected"], "cog_ctrl")
        # FK: the left arm turned -90° about Z from the shoulder: the hand goes from out at the side to below it.
        self.assertAlmostEqual(fk["before"][0], 0.72, places=2)
        self.assertAlmostEqual(fk["after"][0], 0.18, places=2)
        self.assertAlmostEqual(fk["after"][1], 1.5 - 0.54, places=2)
        # IK: the foot follows its control, the leg keeps its lengths, the knee comes forward.
        self.assertAlmostEqual(ik["foot"][1], 0.09 + 0.3, places=2)
        self.assertAlmostEqual(ik["foot"][2], 0.2, places=2)
        self.assertAlmostEqual(ik["thigh"], 0.43, places=2)
        self.assertAlmostEqual(ik["shin"], 0.43, places=2)
        self.assertGreater(ik["knee"][2], 0.05)
        # Switch to FK: the blend is 0 and nothing moved.
        self.assertEqual(sw["ikfk"], 0)
        for a, b in ((sw["foot"], sw["foot2"]), (sw["knee"], sw["knee2"])):
            for x, y in zip(a, b):
                self.assertAlmostEqual(x, y, places=2)
        self.assertEqual(rt["kept"], 36)
        self.assertEqual(rt["removed"], 0)
        self.assertAlmostEqual(rt["rest"][1], 0.09, places=2)
        self.assertEqual(errors, [])


    def test_animated_ik_fk_switch_and_the_unused_side(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            pg.evaluate(OPEN, "hero.glb")
            pg.evaluate(RIG)
            pg.evaluate("() => {" + HELP + "}")
            idle = pg.evaluate(IDLE_AND_PICKER)
            sw = pg.evaluate(ANIMATED_SWITCH)
        finally:
            pg.close()
        # Switching keeps every bone where it was, on the frame and on the frame before.
        self.assertEqual(sw["toFK"]["ikfk10"], 0)
        self.assertEqual(sw["toFK"]["ikfk9"], 1)
        self.assertLess(sw["toFK"]["at10"], 0.002, sw)
        self.assertLess(sw["toFK"]["at9"], 0.002, sw)
        self.assertGreater(sw["sanity"]["bend"], 0.1, "the FK knee did bend the leg")
        self.assertEqual(sw["toIK"]["ikfk15"], 1)
        self.assertLess(sw["toIK"]["at15"], 0.002, sw)
        self.assertLess(sw["toIK"]["at10kept"], 0.002, sw)
        self.assertGreater(sw["arm"]["pose"], 0.1)
        self.assertLess(sw["arm"]["toIK"], 0.002, sw)
        self.assertLess(sw["arm"]["backFK"], 0.002, sw)
        # On IK the arm's FK controls are hidden (fingers stay), on FK its IK control and pole.
        self.assertEqual(idle["ik"], {"armIk": True, "pole": True, "fkArm": False, "fkHand": False, "finger": True})
        self.assertEqual(idle["pills"], ["IK", "IK", "IK", "IK"])
        after = idle["afterClick"]
        self.assertEqual(after["pills"][0], "FK")
        self.assertEqual(after["hand"], after["hand2"], "the Picker's switch does not move the hand")
        self.assertFalse(after["armIk"])
        self.assertTrue(after["fkArm"])
        self.assertIn("arm_L_ik (arm.L)", after["idleBtns"])
        self.assertIn("mixamorigRightArm_fk (upperArm.R)", after["idleBtns"])
        self.assertTrue(idle["selShows"], "a selected control is shown even when its side is unused")
        self.assertFalse(idle["unselHides"])
        self.assertEqual(errors, [])

    def test_outliner_mirror_and_live_drag(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            pg.evaluate(OPEN, "hero.glb")
            pg.evaluate("() => {" + HELP + "}")
            # The skeleton shows under the model before any rig: one folded row, its bones once opened.
            skel = pg.evaluate("""async () => {
              const P = window.__panel;
              const rows = () => [...P.previzPanel.querySelectorAll('.previz-item')].map((r) => r.textContent);
              const folded = rows();
              const row = [...P.previzPanel.querySelectorAll('.previz-bone')].find((r) => r.textContent.includes('Skeleton'));
              row.querySelector('.previz-twisty').click();
              return { folded, open: rows() };
            }""")
            pg.evaluate(RIG)
            # Mirror: the left arm swung forward (about Y), mirrored onto the right arm.
            mir = pg.evaluate("""async () => {
              const P = window.__panel;
              P.setFrame(0);
              window.__ctrl('arm_L_ik').ikfk = 0; window.__ctrl('arm_R_ik').ikfk = 0;
              const c = window.__ctrl('mixamorigLeftArm_fk');
              P.previzSelect(c.id);
              P.previzSetChannel('rotation', 1, -60);
              const left = window.__boneAt('LeftHand');
              P.previzRigMirrorPose([c.id]);
              return { left, right: window.__boneAt('RightHand') };
            }""")
            # A clicked bone row selects its control once rigged.
            picked = pg.evaluate("""() => {
              const P = window.__panel;
              const row = [...P.previzPanel.querySelectorAll('.previz-bone')].find((r) => r.textContent.trim().endsWith('mixamorigLeftForeArm'));
              row.click();
              return P.previzSelectedItem().name;
            }""")
            # Dragging a control poses the character while the mouse is still down.
            drag = pg.evaluate("""async () => {
              const P = window.__panel;
              const view = P._modelView();
              const c = window.__ctrl('leg_L_ik');
              P.previzSelect(c.id);
              await new Promise((r) => setTimeout(r, 100));
              const before = window.__boneAt('LeftFoot');
              const g = view.gizmo;
              g.object.position.y += 0.25;
              g.object.updateMatrixWorld(true);
              g.dispatchEvent({ type: 'objectChange' });
              return { before, during: window.__boneAt('LeftFoot'), attached: !!g.object };
            }""")
            pg.evaluate("() => { window.__panel._previzSelection = null; }")
            menus = {}
            for which in ("rig", "anim", "mb-file"):
                pg.locator(f"button.previz-{which}").first.click()
                items = pg.locator("button.previz-menu-item")
                menus[which] = {items.nth(i).text_content(): "off" in (items.nth(i).get_attribute("class") or "")
                                for i in range(items.count())}
                pg.evaluate("() => window.__panel._previzCloseAddMenu()")
            menu = {**menus["rig"], **menus["anim"]}
        finally:
            pg.close()
        self.assertTrue(any("Skeleton (%d bones)" % len(rig_fixture.BONES) in r for r in skel["folded"]), skel)
        self.assertFalse(any(r.strip().endswith("mixamorigHips") for r in skel["folded"]))
        self.assertTrue(any(r.strip().endswith("mixamorigLeftHand") for r in skel["open"]))
        # The right hand is the left one reflected across X: forward stays forward.
        self.assertGreater(abs(mir["left"][2]), 0.2, mir)
        self.assertAlmostEqual(mir["right"][0], -mir["left"][0], places=2)
        self.assertAlmostEqual(mir["right"][1], mir["left"][1], places=2)
        self.assertAlmostEqual(mir["right"][2], mir["left"][2], places=2)
        self.assertEqual(picked, "mixamorigLeftForeArm_fk")
        self.assertTrue(drag["attached"])
        self.assertAlmostEqual(drag["during"][1] - drag["before"][1], 0.25, places=2)
        # Nothing selected, one character in the scene: the menu works on it.
        self.assertIn("AI in-between…", menu, menu)
        self.assertFalse(menu["AI in-between…"])
        self.assertFalse(menu["Auto-rig…"])
        # Two menus: Rig builds the character, Animation moves it.
        self.assertIn("Auto-rig…", menus["rig"])
        self.assertIn("Set Driven Key…", menus["rig"])
        self.assertNotIn("AI in-between…", menus["rig"])
        for label in ("AI in-between…", "Pose library…", "Motion from video…", "Lip sync from audio…",
                      "Add motion from file…", "Match FK to IK"):
            self.assertIn(label, menus["anim"])
        # The character's exports are in the menu bar's File menu (Export character ▸).
        self.assertIn("Export FBX…", menus["mb-file"])
        self.assertNotIn("Export FBX…", menus["anim"])
        self.assertTrue(any(k.startswith("Switch limb") for k in menus["anim"]), menus["anim"])
        self.assertNotIn("Auto-rig…", menus["anim"])
        self.assertEqual(errors, [])

if __name__ == "__main__":
    unittest.main()
