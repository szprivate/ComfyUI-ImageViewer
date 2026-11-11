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


if __name__ == "__main__":
    unittest.main()
