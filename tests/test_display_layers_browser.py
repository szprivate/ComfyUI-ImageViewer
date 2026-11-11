"""Display layers, selection sets, the Character Picker and references in the 3D space, in a real browser.

The REAL viewer js against stubbed ComfyUI (tests/harness/tabs.html), three.js from vendor/three, the small
skinned humanoid of tests/rig_fixture.py rigged from the Rig menu's code:
  - a template layer draws its box as a wire and the click goes through it; a hidden layer hides it;
  - a selection set selects from its row in the Layers panel;
  - the picker has a button per control, laid out with the character's left on the right, and a click selects;
  - a referenced scene comes in under a namespace, a newer version of its file is picked up, and the
    shot's own move and keys on it are kept.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_display_layers_browser
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

OPEN = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const scene = P.previzScene();
  const hero = S.makeModelItem({ url: '/media/hero.glb', filename: 'hero.glb' }, 'Hero');
  scene.items.push(hero);
  const a = S.makePrimitiveItem('box', 'Wall'); a.position = [2.2, 0.5, 0]; a.scale = [1, 1, 1];
  const b = S.makePrimitiveItem('box', 'Crate'); b.position = [2.2, 0.5, -2.5]; b.scale = [1.4, 1.4, 1.4];
  scene.items.push(a, b);
  P._previzSelection = hero.id;
  await P.previzChanged({ reload: true });
  const view = P._modelView();
  await view.whenLoaded(20000);
  await P.previzRigCharacter(hero.id);
  window.__ids = { hero: hero.id, wall: a.id, crate: b.id };
  return { controls: scene.items.filter((it) => it.kind === 'control').length };
}"""

# Where an item's middle is on the canvas, as a pointer event would carry it.
LAYERS = """async () => {
  const P = window.__panel, view = P._modelView(), ids = window.__ids;
  const { THREE } = view.libs;
  view.resetView && view.resetView();
  const at = (id) => {
    const e = view._entries.get(id);
    const box = new THREE.Box3().setFromObject(e.root);
    const c = box.getCenter(new THREE.Vector3()).project(view.activeCameraObject());
    const r = view.canvas.getBoundingClientRect();
    return { clientX: r.left + (c.x + 1) / 2 * r.width, clientY: r.top + (1 - c.y) / 2 * r.height };
  };
  const before = view._pick(at(ids.wall));
  P.setPanelDocked('layers3d', true);
  const layer = P.previzNewDisplayLayer([ids.wall], 'walls');
  P.previzSetLayer(layer.id, { mode: 'template' });
  const templated = view.isTemplated(ids.wall);
  const wire = (() => { let w = null; view._entries.get(ids.wall).root.traverse((o) => { if (o.isMesh && w === null) w = !!o.material.wireframe; }); return w; })();
  const through = view._pick(at(ids.wall));
  const rows = P.layers3dPanel.querySelectorAll('.pl-row').length;
  const mark = P.previzPanel.querySelector('.previz-layer.template') ? true : false;
  P.previzSetLayer(layer.id, { mode: 'reference' });
  const refTemplated = view.isTemplated(ids.wall);
  P.previzSetLayer(layer.id, { mode: 'normal', visible: false });
  const hidden = view._entries.get(ids.wall).root.visible;
  P.previzSetLayer(layer.id, { visible: true, mode: 'template' });
  return { before, templated, wire, through, rows, mark, refTemplated, hidden };
}"""

SETS = """async () => {
  const P = window.__panel, ids = window.__ids;
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const scene = P.previzScene();
  const arms = scene.items.filter((it) => it.kind === 'control' && /Arm_fk|ForeArm_fk|Hand_fk/.test(it.name)).map((it) => it.id);
  P.previzSelectIds(arms);
  const set = P.previzNewSelectionSet(null, 'arms');
  P.previzSelect(null);
  P._plTab = 'sets'; P._plRender(true);
  P.layers3dPanel.querySelector(`.pl-row[data-set-id="${set.id}"]`).click();
  const got = P.previzSelectedIds().slice().sort();
  return { want: arms.slice().sort(), got };
}"""

PICKER = """async () => {
  const P = window.__panel, ids = window.__ids;
  P.setPanelDocked('picker', true);
  P._pkRender(true);
  const ui = P._pkUI;
  const btn = (name) => { const it = P.previzScene().items.find((x) => x.name === name); return ui.buttons.get(it.id); };
  const box = (el) => el.getBoundingClientRect();
  const left = box(btn('mixamorigLeftHand_fk')), right = box(btn('mixamorigRightHand_fk'));
  const head = box(btn('mixamorigHead_fk')), hips = box(btn('mixamorigHips_fk'));
  btn('mixamorigHead_fk').click();
  const selected = P.previzSelectedItem().name;
  const sets = [...ui.sets.querySelectorAll('.pk-set')].map((b) => b.textContent);
  return { buttons: ui.buttons.size, leftOnRight: left.x > right.x, headAbove: head.y < hips.y, selected, sets,
           lit: ui.root.querySelectorAll('.pk-btn.on').length };
}"""

# A character file and a newer version of it, answered in place of the server's /imageviewer/scene_ref.
REFERENCE = """async () => {
  const P = window.__panel;
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const L = await import('/extensions/viewer/imageViewer_sceneLayers.js');
  const file = (v, color) => {
    const sc = S.makeScene();
    const g = S.makeGroupItem('Prop'); g.id = 'g1';
    const box = S.makePrimitiveItem('sphere', 'Ball'); box.id = 'b1'; box.parent = 'g1'; box.color = color;
    box.position = [-2, 0.5, 1.5];
    sc.items.push(g, box);
    return { path: `/out/imageviewer/scenes/prop_v00${v}.json`, version: v, mtime: 1000 + v,
             name: `prop_v00${v}.json`, scene: JSON.parse(S.serializeScene(sc)) };
  };
  window.__refFile = file(1, '#aa3333');
  const real = window.fetch;
  window.__fetches = [];
  window.fetch = async (url, opts) => {
    if (String(url).includes('/imageviewer/scene_ref')) {
      window.__fetches.push(String(url));
      return new Response(JSON.stringify(window.__refFile), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(url, opts);
  };
  const ref = await P.previzReferenceScene('/out/imageviewer/scenes/prop_v001.json');
  const scene = P.previzScene();
  const group = scene.items.find((it) => it.name === 'prop:Prop');
  const ball = scene.items.find((it) => it.name === 'prop:Ball');
  // The shot moves the prop and keys the ball.
  group.position = [0, 0, 1];
  S.setKeyframe(ball, 'position', 0, [-2, 0.5, 1.5]);
  S.setKeyframe(ball, 'position', 12, [-2, 1.5, 1.5]);
  await P.previzChanged({ reload: true });
  const unchanged = await P.previzCheckReferences({ quiet: true });
  window.__refFile = file(2, '#33aa55');
  const picked = await P.previzCheckReferences({ quiet: true });
  const sc2 = P.previzScene();
  const g2 = S.itemById(sc2, group.id), b2 = S.itemById(sc2, ball.id);
  const renamed = P.previzRename(b2.id, 'Other');
  P._plTab = 'refs'; P._plRender(true);
  const row = P.layers3dPanel.querySelector('.pl-refrow .pl-file');
  return { ns: ref.namespace, unchanged, picked, version: L.referenceById(sc2, ref.id).version,
           color: b2.color, groupPos: g2.position, keys: S.keyframeFrames(b2), renamed,
           file: row && row.textContent, fetched: window.__fetches.length,
           follow: window.__fetches[0].includes('follow=latest') };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class DisplayLayersBrowserTests(unittest.TestCase):
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

    def test_layers_sets_picker_and_references(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        shots = os.environ.get("LAYERS_SHOTS")
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            opened = pg.evaluate(OPEN)
            lay = pg.evaluate(LAYERS)
            sets = pg.evaluate(SETS)
            pick = pg.evaluate(PICKER)
            if shots:
                pg.evaluate("() => { const P = window.__panel; P.setPanelDocked('params', false); P.setPanelDocked('channels', false);"
                            " P._plTab = 'display'; P._plRender(true); P.previzSelectSet(P.previzScene().selectionSets[0].id); }")
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(shots, "layers-and-picker.png"))
            ref = pg.evaluate(REFERENCE)
            if shots:
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(shots, "references.png"))
        finally:
            pg.close()
        self.assertEqual(opened["controls"], 36)
        ids = None  # noqa: F841
        self.assertIsNotNone(lay["before"], "the wall is picked before it is a template")
        self.assertTrue(lay["templated"])
        self.assertTrue(lay["wire"], "a template is drawn as a wire")
        self.assertNotEqual(lay["through"], lay["before"], "the click goes through a template")
        self.assertEqual(lay["rows"], 1)
        self.assertTrue(lay["mark"], "the Outliner shows the layer")
        self.assertFalse(lay["refTemplated"], "a reference layer is drawn as it is")
        self.assertFalse(lay["hidden"], "a hidden layer hides its items")
        self.assertEqual(sets["got"], sets["want"])
        self.assertEqual(pick["buttons"], 36)
        self.assertTrue(pick["leftOnRight"], "the character's left is on your right")
        self.assertTrue(pick["headAbove"])
        self.assertEqual(pick["selected"], "mixamorigHead_fk")
        self.assertEqual(pick["lit"], 1)
        self.assertEqual(pick["sets"], ["arms"])
        self.assertEqual(ref["ns"], "prop")
        self.assertEqual(ref["unchanged"], 0, "an unchanged file is not merged again")
        self.assertEqual(ref["picked"], 1)
        self.assertEqual(ref["version"], 2)
        self.assertEqual(ref["color"], "#33aa55", "the file's change came in")
        self.assertEqual(ref["groupPos"], [0, 0, 1], "the shot's move is kept")
        self.assertEqual(ref["keys"], [0, 12], "the shot's keys are kept")
        self.assertIsNone(ref["renamed"], "a referenced item is renamed in its own file")
        self.assertEqual(ref["file"], "prop_v002.json")
        self.assertTrue(ref["follow"])
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
