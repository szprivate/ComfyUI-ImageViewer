"""The rigging extras in a real browser: the pose library, Flip pose, spaces, Match IK / FK, set-driven
keys, blendshapes in the Channel Box and facial controls.

The REAL viewer js against stubbed ComfyUI (tests/harness/tabs.html), three.js from vendor/three, the
small skinned humanoid of tests/rig_fixture.py with three blendshapes on its head. The pose library's
server (src/rig_poses.py, tested in tests/test_rig_poses.py) is stood in for by the page.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_rig_extras_browser
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rig_fixture  # noqa: E402
import test_rig_browser as base  # noqa: E402
from test_rig_browser import OPEN, RIG, HELP  # noqa: E402

SHOTS = os.environ.get("RIG_EXTRAS_SHOTS")

STORE = """() => {
  const store = window.__poseStore = [];
  const before = window.__fetchApi;
  window.__fetchApi = async (p, opts) => {
    if (p !== '/imageviewer/rig/poses') return before(p, opts);
    const b = JSON.parse(opts.body);
    const j = (o) => ({ ok: true, status: 200, json: async () => o });
    if (b.op === 'list') return j({ poses: store.slice() });
    if (b.op === 'save') { const i = store.findIndex((x) => x.name.toLowerCase() === b.pose.name.toLowerCase()); if (i >= 0) store.splice(i, 1); store.unshift(b.pose); return j({ pose: b.pose }); }
    if (b.op === 'delete') { const i = store.findIndex((x) => x.name === b.name); if (i >= 0) store.splice(i, 1); return j({ ok: i >= 0 }); }
    return j({});
  };
  window.__bone = (name) => window.__boneAt(name);
  window.__ctrlAt = (id) => { const m = window.__panel._modelView().rigItemWorld(window.__hero, id); return [m[12], m[13], m[14]].map((v) => Math.round(v * 1000) / 1000); };
  window.__S = null;
}"""

POSES = """async () => {
  const P = window.__panel;
  P.setFrame(0);
  window.__ctrl('arm_L_ik').ikfk = 0; window.__ctrl('arm_R_ik').ikfk = 0;
  const arm = window.__ctrl('mixamorigLeftArm_fk');
  P.previzSelect(arm.id);
  P.previzSetChannel('rotation', 2, -90);                 // left arm down
  const posed = window.__bone('LeftHand');
  const saved = await P.previzPoseSave('Arm down');
  P.previzRigToRest(window.__hero);
  const rest = window.__bone('LeftHand');
  await P.previzPoseApply('Arm down');
  const applied = window.__bone('LeftHand');
  P.previzRigToRest(window.__hero);
  await P.previzPoseApply('Arm down', { blend: 0.5 });
  const half = window.__bone('LeftHand');
  P.previzRigToRest(window.__hero);
  await P.previzPoseApply('Arm down', { mirror: true });
  const mirrored = { left: window.__bone('LeftHand'), right: window.__bone('RightHand') };
  const list = await P.previzPoseList();
  // Flip: the right arm (down now) goes back to the left.
  P.previzRigFlipPose(window.__hero);
  const flipped = { left: window.__bone('LeftHand'), right: window.__bone('RightHand') };
  // Copy, rest, paste.
  P.previzPoseCopy(window.__hero);
  P.previzRigToRest(window.__hero);
  await P.previzPosePaste(window.__hero);
  const pasted = window.__bone('LeftHand');
  P._modelView().frameItems([window.__hero]);
  await P.previzPoseLibrary(window.__hero);
  await new Promise((r) => setTimeout(r, 100));
  const win = P.container.querySelector('.rx-float[data-rx="poses"]');
  return { posed, saved, rest, applied, half, mirrored, flipped, pasted, list: list.map((p) => [p.name, p.controls, !!p.thumb]),
           cards: win ? win.querySelectorAll('.rx-pose').length : -1 };
}"""

SPACES = """async () => {
  const P = window.__panel;
  P.container.querySelectorAll('.rx-float').forEach((n) => n.remove());
  P.previzRigToRest(window.__hero);
  window.__ctrl('arm_L_ik').ikfk = 1;
  const hand = window.__ctrl('arm_L_ik');
  const head = window.__ctrl('mixamorigHead_fk');
  const at = () => window.__ctrlAt(hand.id);
  const before = at(), boneBefore = window.__bone('LeftHand');
  P.previzRigSetSpace(hand.id, head.id);                   // the hand follows the head now
  const switched = at(), boneSwitched = window.__bone('LeftHand');
  P.previzSelect(head.id);
  P.previzSetChannel('rotation', 1, 90);                   // turn the head: the hand goes round with it
  const carried = at();
  P.previzRigSetSpace(hand.id, 0);                         // back to its parent, kept where it is
  const back = at();
  P.previzSelect(head.id);
  P.previzSetChannel('rotation', 1, 0);                    // the head turns back; the hand stays
  const stays = at();
  // Match FK to IK: move the foot by IK, match, switch the blend to FK - nothing moves.
  const foot = window.__ctrl('leg_L_ik');
  P.previzSelect(foot.id);
  P.previzSetChannel('position', 1, 0.25);
  const ikFoot = window.__bone('LeftFoot');
  P.previzRigMatch(foot.id, 'fk');
  foot.ikfk = 0; P._modelView().applyFrame(0);
  const fkFoot = window.__bone('LeftFoot');
  foot.ikfk = 1; P._modelView().applyFrame(0);
  return { before, switched, boneBefore, boneSwitched, carried, back, stays, ikFoot, fkFoot, space: hand.space || 0, spaces: hand.control.spaces.length };
}"""

SDK = """async () => {
  const P = window.__panel;
  P.previzRigToRest(window.__hero);
  const hand = window.__ctrl('arm_L_ik');
  hand.ikfk = 0;
  const finger = window.__ctrl('mixamorigLeftHandMiddle1_fk');
  P.previzRigAddAttr(hand.id, { name: 'fist', min: 0, max: 10, value: 0 });
  const drv = { id: hand.id, prop: 'attr:fist', axis: null };
  P.previzRigSdkKey(drv, [{ id: finger.id, prop: 'rotation', axis: 2 }]);      // rest: fist 0, finger straight
  P.previzSelect(hand.id); P.previzSetChannel('attr:fist', null, 10);
  P.previzSelect(finger.id); P.previzSetChannel('rotation', 2, -90);           // curl it
  const curled = window.__bone('LeftHandMiddle4');
  P.previzRigSdkKey(drv, [{ id: finger.id, prop: 'rotation', axis: 2 }]);
  const afterKey = window.__bone('LeftHandMiddle4');
  const own = finger.rotation[2];
  P.previzSelect(hand.id); P.previzSetChannel('attr:fist', null, 5);
  const half = window.__bone('LeftHandMiddle4');
  P.previzSetChannel('attr:fist', null, 0);
  const open = window.__bone('LeftHandMiddle4');
  P.previzSdkWindow();
  const win = P.container.querySelector('.rx-float[data-rx="sdk"]');
  const rows = P.channelsPanel ? [...P.channelsPanel.querySelectorAll('.cb-row')].map((r) => r.dataset.ch) : [];
  return { curled, afterKey, own, half, open, listed: win ? win.querySelectorAll('.rx-list')[2].textContent : '', rows };
}"""

FACE = """async () => {
  const P = window.__panel;
  P.container.querySelectorAll('.rx-float').forEach((n) => n.remove());
  const view = P._modelView();
  const names = view.rigMorphNames(window.__hero);
  const infl = (n) => { let v = null; view._entries.get(window.__hero).object.traverse((o) => {
      if (o.isMesh && o.morphTargetDictionary && o.morphTargetDictionary[n] !== undefined) v = o.morphTargetInfluences[o.morphTargetDictionary[n]]; }); return v; };
  P.previzSelect(window.__hero);
  if (!P.isPanelDocked('channels')) P.setPanelDocked('channels', true);
  P._previzRenderChannels();
  const rows = [...P.channelsPanel.querySelectorAll('.cb-row')].map((r) => r.dataset.ch).filter((x) => x && x.startsWith('bs:'));
  P.previzSetChannel('bs:mouthSmileLeft', null, 0.75);
  const smile = infl('mouthSmileLeft');
  P.previzKeyChannels(['bs:mouthSmileLeft']);
  const keyed = !!(P.previzSelectedItem().tracks['bs:mouthSmileLeft'] || []).length;
  P.previzSetChannel('bs:mouthSmileLeft', null, 0);
  const face = P.previzRigAddFace(window.__hero);
  const jaw = window.__ctrl('face_jaw_ctrl');
  const cell = face.cell;
  P.previzSelect(jaw.id);
  P.previzSetChannel('position', 1, -cell);
  const jawOpen = infl('jawOpen');
  P.previzSetChannel('position', 1, -cell / 2);
  const jawHalf = infl('jawOpen');
  const smileL = window.__ctrl('face_mouth_L_ctrl');
  P.previzSelect(smileL.id);
  P.previzSetChannel('position', 1, cell);
  const smileFace = infl('mouthSmileLeft');
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const back = S.parseScene(S.serializeScene(P.previzScene()));
  const m = back.items.find((i) => i.id === window.__hero);
  P.previzSelect(jaw.id);
  view.frameItems([face.items[0].id]);
  return { names, rows, smile, keyed, used: face.used, controls: face.items.length, jawOpen, jawHalf, smileFace,
           drivers: (m.drivers || []).length, faceKept: back.items.filter((i) => i.control && i.control.type === 'face').length };
}"""


class RigExtrasBrowserTests(base.RigBrowserTests):
    """Reuses the rig test's server and browser, with a character that has blendshapes."""

    @classmethod
    def setUpClass(cls):
        orig = rig_fixture.build
        rig_fixture.build = lambda prefix="", names="mixamo", skinned=True: orig(
            prefix, names, skinned, morphs=("jawOpen", "mouthSmileLeft", "mouthSmileRight"))
        try:
            super().setUpClass()
        finally:
            rig_fixture.build = orig

    # The rig tests themselves run in test_rig_browser; only the extras here.
    test_rig_pose_and_switch = None
    test_outliner_mirror_and_live_drag = None

    def _shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, name))

    def test_pose_library_spaces_driven_keys_and_face(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            pg.evaluate(OPEN, "hero.glb")
            pg.evaluate(RIG)
            pg.evaluate("() => {" + HELP + "}")
            pg.evaluate(STORE)
            poses = pg.evaluate(POSES)
            self._shot(pg, "pose-library.png")
            spaces = pg.evaluate(SPACES)
            sdk = pg.evaluate(SDK)
            self._shot(pg, "set-driven-key.png")
            face = pg.evaluate(FACE)
            pg.wait_for_timeout(200)
            self._shot(pg, "facial-controls.png")
            # The Rig menu lists the extras.
            menu = pg.evaluate("""() => {
              const P = window.__panel;
              const btn = [...P.previzPanel.querySelectorAll('button')].find((b) => /^Rig\\b/.test(b.textContent.trim()));
              P._previzToggleRigMenu(btn || P.previzPanel);
              return [...P.container.querySelectorAll('.previz-menu .previz-menu-item')].map((b) => b.textContent);
            }""")
            self._shot(pg, "rig-menu.png")
        finally:
            pg.close()
        eq = lambda a, b, places=2: [self.assertAlmostEqual(x, y, places=places) for x, y in zip(a, b)]
        # Pose library.
        self.assertEqual(poses["saved"]["name"], "Arm down")
        eq(poses["applied"], poses["posed"])
        self.assertAlmostEqual(poses["rest"][0], 0.72, places=2)
        self.assertTrue(poses["posed"][0] < poses["half"][0] < poses["rest"][0], poses)
        self.assertAlmostEqual(poses["mirrored"]["left"][0], 0.72, places=2)        # the left arm stays out
        eq(poses["mirrored"]["right"], [-poses["posed"][0], poses["posed"][1], poses["posed"][2]])
        eq(poses["flipped"]["left"], poses["posed"])
        self.assertAlmostEqual(poses["flipped"]["right"][0], -0.72, places=2)
        eq(poses["pasted"], poses["posed"])
        self.assertEqual(poses["list"][0][0], "Arm down")
        self.assertGreater(poses["list"][0][1], 30)
        self.assertTrue(poses["list"][0][2], "the pose has a picture")
        self.assertEqual(poses["cards"], 1)
        # Spaces: switching does not move it; the head carries it round; back to the parent keeps it there.
        eq(spaces["switched"], spaces["before"])
        eq(spaces["boneSwitched"], spaces["boneBefore"])
        self.assertAlmostEqual(spaces["carried"][2], -0.72, places=2)
        self.assertAlmostEqual(spaces["carried"][0], 0.0, places=2)
        eq(spaces["back"], spaces["carried"])
        eq(spaces["stays"], spaces["carried"])
        self.assertEqual(spaces["space"], 0)
        self.assertEqual(spaces["spaces"], 1)
        eq(spaces["fkFoot"], spaces["ikFoot"])
        # Set-driven key: Key folds the curl into the curve, nothing jumps, the finger is driven by "fist".
        eq(sdk["afterKey"], sdk["curled"])
        self.assertAlmostEqual(sdk["own"], 0, places=6)
        self.assertGreater(sdk["open"][0], sdk["half"][0])
        self.assertAlmostEqual(sdk["open"][0], 0.9, places=2)
        self.assertIn("attr:fist", sdk["rows"])
        self.assertIn("fist", sdk["listed"])
        # Blendshapes and the face.
        self.assertEqual(sorted(face["names"]), ["jawOpen", "mouthSmileLeft", "mouthSmileRight"])
        self.assertEqual(sorted(face["rows"]), ["bs:jawOpen", "bs:mouthSmileLeft", "bs:mouthSmileRight"])
        self.assertAlmostEqual(face["smile"], 0.75, places=6)
        self.assertTrue(face["keyed"])
        self.assertEqual(sorted(face["used"]), ["jawOpen", "mouthSmileLeft", "mouthSmileRight"])
        self.assertEqual(face["controls"], 4)        # the board, the jaw, the two mouth corners
        self.assertAlmostEqual(face["jawOpen"], 1, places=6)
        self.assertAlmostEqual(face["jawHalf"], 0.5, places=6)
        # The smile was keyed at 0.75 before: the driver adds to it, held to 1.
        self.assertAlmostEqual(face["smileFace"], 1, places=6)
        self.assertEqual(face["drivers"], 3)
        self.assertEqual(face["faceKept"], 4)
        for want in ("Flip pose", "Pose library…", "Space…", "Match FK to IK", "Set Driven Key…", "Add facial controls"):
            self.assertIn(want, menu)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
