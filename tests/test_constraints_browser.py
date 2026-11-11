"""Constraints in the 3D space, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three: the Constrain menu makes a constraint from the selection (targets first, the follower
last), the view puts the follower where the solver says (three's own world matrices are compared
with imageViewer_constraints.js, through a group, a pivot and a camera), the Channel Box shows the
constraint's weights as keyable rows, the curve editor lists them, and Bake keys the result.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_constraints_browser
"""
import os
import shutil
import socket
import subprocess
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  P.setPanelDocked('channels', true);
  return true;
}"""

MENU_POINT = """async () => {
  const P = window.__panel;
  const C = await import('/extensions/viewer/imageViewer_constraints.js');
  const a = await P.previzAddPrimitive('box'); a.position = [2, 0, 0];
  const b = await P.previzAddPrimitive('sphere'); b.position = [0, 0, 5];
  await P.previzChanged();
  P.previzSelect(a.id); P.previzSelect(b.id, { add: true });
  // Snap, not keep: the menu's Maintain offset switched off first.
  P.previzSetConstraintKeepOffset(false);
  const btn = P.previzPanel.querySelector('.previz-constrain');
  btn.click();
  const items = [...P.shadowRoot.querySelectorAll('.previz-menu-item')].map((x) => x.textContent);
  [...P.shadowRoot.querySelectorAll('.previz-menu-item')].find((x) => x.textContent === 'Point').click();
  await new Promise((r) => setTimeout(r, 50));
  const view = P._modelView();
  const e = view._entries.get(b.id);
  e.root.updateWorldMatrix(true, false);
  const wp = e.root.getWorldPosition(new view.libs.THREE.Vector3()).toArray();
  // Move the target: the follower comes along.
  a.position = [-1, 3, 0]; P.previzChanged();
  const wp2 = e.root.getWorldPosition(new view.libs.THREE.Vector3()).toArray();
  P._previzRenderChannels();
  const box = P.channelsPanel;
  const rows = [...box.querySelectorAll('.cb-row')].map((r) => r.dataset.ch).filter(Boolean);
  const tinted = [...box.querySelectorAll('.cb-row.constrained')].map((r) => r.dataset.ch);
  const heads = [...box.querySelectorAll('.cb-constraint .cb-cname')].map((x) => x.textContent);
  const list = P.previzListConstraints();
  return { items, wp, wp2, rows, tinted, heads, list, b: b.id, a: a.id };
}"""

WEIGHTS_AND_CURVES = """async () => {
  const P = window.__panel;
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const scene = P.previzScene();
  const b = P.previzSelectedItem();
  const c = b.constraints[0];
  const t2 = await P.previzAddPrimitive('cone'); t2.position = [10, 0, 0];
  // Add a second target by hand through the API, then key the blend across 0..10.
  P.previzRemoveConstraint(b.id, c.id, { quiet: true });
  const aId = c.targets[0].id;
  const cid = P.previzConstrain('point', { driven: b.id, targets: [aId, t2.id], maintainOffset: false });
  P.setFrame(0);
  P.previzSetConstraintWeight(b.id, cid, t2.id, 0, { key: true });
  P.previzSetConstraintWeight(b.id, cid, aId, 1, { key: true });
  P.setFrame(10);
  P.previzSetConstraintWeight(b.id, cid, t2.id, 1, { key: true });
  P.previzSetConstraintWeight(b.id, cid, aId, 0, { key: true });
  const view = P._modelView();
  const at = (f) => { P.setFrame(f); const e = view._entries.get(b.id); return e.root.getWorldPosition(new view.libs.THREE.Vector3()).toArray(); };
  const p0 = at(0), p10 = at(10);
  P.previzSelect(b.id);
  P._previzRenderChannels();
  // Type a weight into the Channel Box row at frame 10: keyed, so a key.
  const row = P.channelsPanel.querySelector(`.cb-row[data-ch="cw:${cid}:${aId}"]`);
  const input = row.querySelector('input');
  input.value = '1'; input.dispatchEvent(new Event('change'));
  const w = S.valueAt(b, `cw:${cid}:${aId}`, 10);
  P.setPanelDocked('curves', true);
  P.previzRefreshCurves();
  const names = [...P.curvesPanel.querySelectorAll('.curves-ch')].map((r) => r.textContent);
  return { p0, p10, w, keyed: row.classList.contains('keyed'), names, ticks: S.keyframeFrames(b) };
}"""

THREE_MATCHES_SOLVER = """async () => {
  const P = window.__panel;
  const C = await import('/extensions/viewer/imageViewer_constraints.js');
  await P.previzNewScene();
  const g = P.previzAddGroup(); g.position = [4, 1, 0]; g.rotation = [0, 30, 0]; g.scale = [2, 2, 2];
  const t = await P.previzAddPrimitive('box'); t.parent = g.id; t.position = [1, 0, 0]; t.rotation = [10, 0, 0]; t.pivot = [0, 0.5, 0];
  const g2 = P.previzAddGroup(); g2.position = [0, 2, 0]; g2.rotation = [0, 0, 45];
  const d = await P.previzAddPrimitive('torus'); d.parent = g2.id; d.position = [0.5, 0, 0]; d.pivot = [0.2, 0, 0];
  const cam = P.previzAddCamera();
  await P.previzChanged({ reload: true });
  P.previzConstrain('parent', { driven: d.id, targets: [t.id], maintainOffset: true });
  P.previzConstrain('aim', { driven: cam.id, targets: [t.id], maintainOffset: false });
  // Move the target's group: everything follows.
  g.rotation = [0, 75, 0]; t.position = [1.5, 0.5, 0];
  P.previzChanged();
  const view = P._modelView();
  view.scene.updateMatrixWorld(true);
  const sv = C.solver(P.previzScene(), Math.round(P.currentFrame || 0));
  const diff = (id) => {
    const e = view._entries.get(id);
    const a = e.root.matrixWorld.toArray(), b = sv.world(id).root;
    return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  };
  // The camera looks at the target: its -Z goes through the target's root.
  const T = view.libs.THREE;
  const ce = view._entries.get(cam.id).root;
  const dir = new T.Vector3(0, 0, -1).applyQuaternion(ce.getWorldQuaternion(new T.Quaternion()));
  const to = view._entries.get(t.id).root.getWorldPosition(new T.Vector3()).sub(ce.getWorldPosition(new T.Vector3())).normalize();
  return { target: diff(t.id), driven: diff(d.id), cam: diff(cam.id), aimDot: dir.dot(to) };
}"""

BAKE = """async () => {
  const P = window.__panel;
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  await P.previzNewScene();
  const scene = P.previzScene(); scene.length = 25;
  const a = await P.previzAddPrimitive('box');
  S.setKeyframe(a, 'position', 0, [0, 0, 0], 'linear');
  S.setKeyframe(a, 'position', 24, [4, 0, 0], 'linear');
  const b = await P.previzAddPrimitive('sphere'); b.position = [0, 2, 0];
  // Made at frame 0, where A is at the origin: B keeps its 2 above A.
  P.setFrame(0);
  P.previzConstrain('point', { driven: b.id, targets: [a.id], maintainOffset: true });
  P.previzSelect(b.id);
  const n = P.previzBakeConstraints();
  return { n, left: !!b.constraints, keys: S.track(b, 'position').length,
           mid: S.valueAt(b, 'position', 12), end: S.valueAt(b, 'position', 24),
           undoable: (P.previzUndo(), !!P.previzSelectedItem() && !!S.itemById(P.previzScene(), b.id).constraints) };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ConstraintsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
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

    def _page(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        pg.evaluate(SETUP)
        return pg, errors

    def test_constrain_menu_weights_curves_and_three(self):
        pg, errors = self._page()
        try:
            st = pg.evaluate(MENU_POINT)
            wc = pg.evaluate(WEIGHTS_AND_CURVES)
            tm = pg.evaluate(THREE_MATCHES_SOLVER)
            bk = pg.evaluate(BAKE)
        finally:
            pg.close()
        self.assertEqual(errors, [])
        # The menu: the five kinds, offset switch, select / bake / remove.
        for name in ("Parent", "Point", "Orient", "Aim", "Scale", "Maintain offset", "Bake constraints"):
            self.assertIn(name, " | ".join(st["items"]))
        for got, want in zip(st["wp"], [2, 0, 0]):
            self.assertAlmostEqual(got, want, places=5)
        for got, want in zip(st["wp2"], [-1, 3, 0]):
            self.assertAlmostEqual(got, want, places=5)
        self.assertEqual(st["heads"], ["pointConstraint1 (Point)"])
        self.assertEqual(sorted(st["tinted"]), ["position.0", "position.1", "position.2"])
        self.assertTrue(any(r.startswith("ce:") for r in st["rows"]))
        self.assertTrue(any(r.startswith("cw:") for r in st["rows"]))
        self.assertEqual(st["list"][0]["type"], "point")
        self.assertEqual(st["list"][0]["driven"], st["b"])
        self.assertEqual(st["list"][0]["targets"][0]["id"], st["a"])
        # Keyed weights blend from one target to the other.
        for got, want in zip(wc["p0"], [-1, 3, 0]):
            self.assertAlmostEqual(got, want, places=5)
        for got, want in zip(wc["p10"], [10, 0, 0]):
            self.assertAlmostEqual(got, want, places=5)
        self.assertEqual(wc["w"], 1)
        self.assertTrue(wc["keyed"])
        self.assertTrue(any(n.endswith("W") and "pointConstraint1" in n for n in wc["names"]), wc["names"])
        self.assertEqual(wc["ticks"], [0, 10])
        # three's matrices are the solver's.
        self.assertLess(tm["target"], 1e-5)
        self.assertLess(tm["driven"], 1e-5)
        self.assertLess(tm["cam"], 1e-5)
        self.assertGreater(tm["aimDot"], 0.99999)
        # Bake: a key a frame, the constraint gone, the motion kept; undo brings it back.
        self.assertEqual(bk["keys"], 25)
        self.assertFalse(bk["left"])
        self.assertAlmostEqual(bk["mid"][1], 2, places=5)
        self.assertGreater(bk["mid"][0], 0.5)
        self.assertLess(bk["mid"][0], 3.5)
        self.assertAlmostEqual(bk["end"][0], 4, places=5)
        self.assertAlmostEqual(bk["end"][1], 2, places=5)
        self.assertTrue(bk["undoable"])


if __name__ == "__main__":
    unittest.main()
