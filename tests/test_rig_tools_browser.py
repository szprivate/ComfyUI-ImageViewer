"""The Rig menu's tools in a real browser: FBX / Alembic export, auto-rig, AI motion, feet.

The REAL viewer js against stubbed ComfyUI (tests/harness/tabs.html). The server's rig routes are answered
in the test itself, with the real writers: an export posts what the page collected to src/rig_export.py
(the Alembic is read back with src/abc_io.py, the FBX is loaded with three.js's FBXLoader), auto-rigging
hands back the skinned fixture as UniRig would, and a motion comes back as the motion model would send it
(scripts/rig/kimodo_run.py's answer), so the retargeting and the bake onto the controls run for real.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_rig_tools_browser
"""
import email.parser
import email.policy
import json
import math
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
sys.path.insert(0, os.path.join(ROOT, "src"))
import rig_fixture  # noqa: E402

OPEN = """async ([name, title]) => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const scene = P.previzScene();
  scene.items = scene.items.filter((it) => it.kind !== 'model' && it.kind !== 'control' && !(it.rig));
  const item = S.makeModelItem({ url: '/media/' + name, filename: name }, title);
  scene.items.push(item);
  scene.fps = 24; scene.length = 49; scene.lengthSet = true;
  P._previzSelection = item.id;
  await P.previzChanged({ reload: true });
  await P._modelView().whenLoaded(20000);
  window.__hero = item.id;
  return item.id;
}"""

HELP = """() => {
  window.__boneAt = (name, f) => {
    const view = window.__panel._modelView();
    const [p] = view.rigPosesAt(window.__hero, [f]);
    const m = p.pose.get('mixamorig' + name);
    return [m[12], m[13], m[14]].map((v) => Math.round(v * 1000) / 1000);
  };
}"""

# The motion model's 77 joints, as kimodo_run.py names them (SOMA).
SOMA = ["Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "HeadEnd", "Jaw", "LeftEye", "RightEye",
        "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand"] + \
       [f"LeftHand{f}{i}" for f in ("Thumb",) for i in ("1", "2", "3", "End")] + \
       [f"LeftHand{f}{i}" for f in ("Index", "Middle", "Ring", "Pinky") for i in ("1", "2", "3", "4", "End")] + \
       ["RightShoulder", "RightArm", "RightForeArm", "RightHand"] + \
       [f"RightHand{f}{i}" for f in ("Thumb",) for i in ("1", "2", "3", "End")] + \
       [f"RightHand{f}{i}" for f in ("Index", "Middle", "Ring", "Pinky") for i in ("1", "2", "3", "4", "End")] + \
       ["LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "LeftToeEnd",
        "RightLeg", "RightShin", "RightFoot", "RightToeBase", "RightToeEnd"]


def _qz(deg):
    a = math.radians(deg) / 2
    return [0.0, 0.0, math.sin(a), math.cos(a)]


def fake_motion(frames):
    """What the model would answer: the hips walking 1 m forward (+Z), the left arm rising to 60° over the motion."""
    rot, root, contacts = [], [], []
    for t in range(frames):
        u = t / max(1, frames - 1)
        q = [[0.0, 0.0, 0.0, 1.0] for _ in SOMA]
        for n in ("LeftArm", "LeftForeArm", "LeftHand"):
            q[SOMA.index(n)] = _qz(60 * u)
        rot.append(q)
        root.append([0.0, 1.0052, 1.0 * u])
        contacts.append([0, 0, 0, 0])
    return {"fps": 30.0, "joints": SOMA, "parents": [], "rest": [], "samples": [{"rot": rot, "root": root, "contacts": contacts}]}


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _multipart(request):
    head = f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode()
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(head + request.post_data_buffer)
    meta, blobs = None, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        data = part.get_payload(decode=True)
        if name == "meta":
            meta = json.loads(data.decode())
        else:
            blobs[name] = data
    return meta, blobs


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class RigToolsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        with open(os.path.join(cls.tmp, "hero.glb"), "wb") as fh:
            fh.write(rig_fixture.build(prefix="mixamorig:"))
        with open(os.path.join(cls.tmp, "statue.glb"), "wb") as fh:
            fh.write(rig_fixture.build(prefix="mixamorig:", skinned=False))
        shutil.copyfile(os.path.join(cls.tmp, "hero.glb"), os.path.join(cls.tmp, "statue_rig.glb"))
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

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        self.requests = []
        tmp = self.tmp

        def export(route, request):
            import rig_export
            meta, blobs = _multipart(request)
            data = rig_export.parse_payload(meta, blobs)
            out = os.path.join(tmp, f"out.{meta['format']}")
            (rig_export.write_fbx if meta["format"] == "fbx" else rig_export.write_abc)(out, data)
            if os.environ.get("RIG_DEBUG"):
                import pickle
                with open(os.environ["RIG_DEBUG"] + "." + meta["format"], "wb") as fh:
                    pickle.dump(data, fh)
            self.requests.append(("export", meta))
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"ok": True, "path": out, "relative": "characters/" + os.path.basename(out)}))

        state = {}

        def tools(route, request):
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "unirig": {"ready": True, "why": ""}, "kimodo": {"ready": True, "why": "", "model": "Kimodo-SOMA-RP-v1.2"}}))

        def start(kind):
            def handler(route, request):
                body = json.loads(request.post_data or "{}")
                self.requests.append((kind, body))
                if kind == "motion":
                    state["result"] = fake_motion(int(body["frames"]))
                else:
                    state["result"] = {"path": "D:/out/characters/statue_rig.glb", "relative": "characters/statue_rig.glb",
                                       "name": "statue_rig.glb"}
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"job": kind, "state": "running", "log": []}))
            return handler

        def job(route, request):
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"job": "x", "state": "done", "log": ["done"], "result": state["result"]}))

        def agent_done(route, request):
            self.requests.append(("agent_done", json.loads(request.post_data or "{}")))
            route.fulfill(status=200, content_type="application/json", body='{"ok": true}')

        pg.route("**/imageviewer/rig/agent_done", agent_done)
        pg.route("**/imageviewer/rig/export", export)
        pg.route("**/imageviewer/rig/tools", tools)
        pg.route("**/imageviewer/rig/autorig", start("autorig"))
        pg.route("**/imageviewer/rig/motion", start("motion"))
        pg.route("**/imageviewer/rig/job*", job)
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        return pg

    def test_export_fbx_and_alembic(self):
        import abc_io
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["hero.glb", "Hero"])
            pg.evaluate("async () => { await window.__panel.previzRigCharacter(window.__hero); }")
            pg.evaluate(HELP)
            # Key the left arm down over the shot: frame 0 at rest, frame 24 swung -90° about Z.
            hand24 = pg.evaluate("""async () => {
              const P = window.__panel;
              const c = P.previzScene().items.find((it) => it.name === 'mixamorigLeftArm_fk');
              P.previzScene().items.find((it) => it.name === 'arm_L_ik').ikfk = 0;
              P.setFrame(0); P.previzSelect(c.id); P.previzSetChannel('rotation', 2, 0); P.previzRigKeyAll(window.__hero);
              P.setFrame(24); P.previzSetChannel('rotation', 2, -90); P.previzRigKeyAll(window.__hero);
              return window.__boneAt('LeftHand', 24);
            }""")
            fbx = pg.evaluate("async () => window.__panel.previzRigExport(window.__hero, 'fbx', { first: 0, last: 24 })")
            abc = pg.evaluate("async () => window.__panel.previzRigExport(window.__hero, 'abc', { first: 0, last: 24 })")
            # The FBX back in three.js: a skinned mesh, its bones, a clip that turns the arm down.
            shutil.copyfile(fbx["path"], os.path.join(self.tmp, "back.fbx"))
            back = pg.evaluate("""async () => {
              const { THREE, FBXLoader } = window.__panel._modelView().libs;
              const obj = await new FBXLoader().loadAsync('/media/back.fbx');
              let skinned = 0, bones = 0;
              obj.traverse((o) => { if (o.isSkinnedMesh) skinned++; if (o.isBone) bones++; });
              const mixer = new THREE.AnimationMixer(obj);
              const clip = obj.animations[0];
              const action = mixer.clipAction(clip);
              action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; action.play();
              mixer.setTime(1.0);
              obj.updateMatrixWorld(true);
              let hand = null;
              obj.traverse((o) => { if (o.isBone && o.name.endsWith('LeftHand')) hand = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).toArray(); });
              return { skinned, bones, duration: clip && clip.duration, tracks: clip ? clip.tracks.length : 0, hand,
                       scale: obj.scale.toArray() };
            }""")
            pg.screenshot(path=os.environ.get("RIG_TOOLS_SHOT") or os.path.join(self.tmp, "tools.png"))
        finally:
            pg.close()
        self.assertTrue(fbx.get("ok", True) and fbx["path"].endswith(".fbx"), fbx)
        self.assertEqual(back["skinned"], 1)
        self.assertEqual(back["bones"], len(rig_fixture.BONES))
        self.assertAlmostEqual(back["duration"], 1.0, places=2)
        # One second in, the clip has the hand where the rig had it on frame 24 (metres, as written).
        for a, b in zip(back["hand"], hand24):
            self.assertAlmostEqual(a, b, delta=0.02)
        # The Alembic: one mesh, 25 samples, the arm's vertices moving down by frame 24.
        info = abc_io.info(abc["path"])
        self.assertEqual(info["samples"], 25)
        self.assertEqual(len(info["meshes"]), 1)
        v0, _ = abc_io.to_mesh(abc["path"], sample=0)
        v24, _ = abc_io.to_mesh(abc["path"], sample=24)
        far0 = max(v0, key=lambda p: p[0])
        self.assertAlmostEqual(far0[0], 0.9 + 0.035, delta=0.01)                 # the fingertip box, out at the side
        self.assertLess(max(p[0] for p in v24), 0.4)                               # the arm hangs: nothing out there
        self.assertEqual(self.errors, [])

    def test_auto_rig_then_motion_then_feet(self):
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            before = pg.evaluate("() => window.__panel.previzHasSkeleton(window.__hero)")
            rigged = pg.evaluate("async () => window.__panel.previzAutoRig(window.__hero, { seed: 7 })")
            kinds = pg.evaluate("""() => { const k = {}; for (const it of window.__panel.previzScene().items)
                                     if (it.kind === 'control') k[it.control.type] = (k[it.control.type] || 0) + 1; return k; }""")
            pg.evaluate(HELP)
            motion = pg.evaluate("""async () => window.__panel.previzRigGenerateMotion(window.__hero,
                                      { mode: 'text', prompt: 'A person walks forward and raises the left arm.', from: 0, to: 48 })""")
            hips0, hips48 = pg.evaluate("() => [window.__boneAt('Hips', 0), window.__boneAt('Hips', 48)]")
            hand48, arm48 = pg.evaluate("() => [window.__boneAt('LeftHand', 48), window.__boneAt('LeftArm', 48)]")
            # An in-between between frame 0 and 48 (both keyed now): the keys are the constraints.
            # The animator keeps two of the poses (frames 0 and 48) and asks for what is between them.
            pg.evaluate("""() => { for (const it of window.__panel.previzScene().items) if (it.kind === 'control')
                           for (const p of Object.keys(it.tracks || {})) it.tracks[p] = it.tracks[p].filter((k) => k.f === 0 || k.f === 48); }""")
            inb = pg.evaluate("""async () => window.__panel.previzRigGenerateMotion(window.__hero,
                                   { mode: 'inbetween', from: 0, to: 48 })""")
            feet = pg.evaluate("() => window.__panel.previzRigCleanFeet(window.__hero)")
            # The agent's road: a request as rig_routes sends it, answered to /rig/agent_done.
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'a1', action: 'export',
                             args: { model: 'statue', format: 'abc', to: 4 } })""")
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'a2', action: 'motion', args: { model: 'nobody' } })""")
        finally:
            pg.close()
        self.assertFalse(before)
        self.assertTrue(rigged["ok"], rigged)
        self.assertTrue(rigged["humanoid"])
        autorig = [b for k, b in self.requests if k == "autorig"][0]
        self.assertEqual(autorig["seed"], 7)
        self.assertEqual(autorig["src"]["filename"], "statue.glb")
        self.assertEqual(kinds, {"root": 1, "cog": 1, "fk": 26, "ik": 4, "pole": 4})
        text = [b for k, b in self.requests if k == "motion"][0]
        self.assertEqual(text["frames"], 61)                                  # 2 s at 30 fps
        self.assertEqual(len(text["keys"]), 1)                                # it starts from the pose it was in
        self.assertTrue(motion["ok"], motion)
        self.assertGreater(motion["keys"], 0)
        # The hips walked 1 m forward (the character is 0.98 the model's size), the arm is up 60°.
        self.assertAlmostEqual(hips48[2] - hips0[2], 1.0 * (1 - 0.02) / 1.0052, delta=0.02)
        d = [hand48[i] - arm48[i] for i in range(3)]
        self.assertAlmostEqual(math.degrees(math.atan2(d[1], d[0])), 60, delta=3)
        inbetween = [b for k, b in self.requests if k == "motion"][1]
        self.assertEqual([k["frame"] for k in inbetween["keys"]], [0, 60])
        self.assertAlmostEqual(inbetween["keys"][1]["root"][2], 1.0, delta=0.02)
        self.assertTrue(inb["ok"], inb)
        self.assertTrue(feet["ok"], feet)
        done = [b for k, b in self.requests if k == "agent_done"]
        a1 = [b for b in done if b["id"] == "a1"]
        self.assertEqual([b["state"] for b in a1], ["running", "done"])
        self.assertTrue(a1[-1]["result"]["path"].endswith(".abc"))
        self.assertEqual(a1[-1]["result"]["model"], "Statue")
        a2 = [b for b in done if b["id"] == "a2"]
        self.assertEqual(a2[-1]["state"], "error")
        self.assertIn("nobody", a2[-1]["error"])
        self.assertEqual(self.errors, [])

    def _menu(self, pg, label):
        pg.locator("button.previz-rig").first.click()
        pg.locator("button.previz-menu-item", has_text=label).first.click()

    def _go(self, pg, title, fill=None):
        box = pg.locator(f'.rd-box[aria-label="{title}"]')
        box.wait_for(state="visible", timeout=10000)
        for sel, value in (fill or {}).items():
            box.locator(sel).first.fill(str(value))
        box.locator("button.rd-go").click()
        box.wait_for(state="detached", timeout=30000)

    def test_drive_everything_from_the_rig_menu(self):
        """The same road as the agent's, by hand: Rig menu, dialogs, their buttons."""
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            self._menu(pg, "Auto-rig")
            self._go(pg, "Auto-rig (UniRig)", {"input.rd-num": 9})
            pg.wait_for_function("() => window.__panel.previzScene().items.some((it) => it.kind === 'control')", timeout=30000)
            pg.evaluate("() => window.__panel.setFrame(0)")
            self._menu(pg, "Generate motion from text")
            self._go(pg, "Motion from text (Kimodo)", {"textarea": "A person walks forward."})
            keyed = pg.evaluate("() => window.__panel.previzRigKeyedFrames(window.__hero)")
            pg.evaluate("() => window.__panel.setFrame(20)")
            for t in ("Clean up feet",):
                self._menu(pg, t)
            # Keep frames 0 and 48 only, then ask for what is between them.
            pg.evaluate("""() => { for (const it of window.__panel.previzScene().items) if (it.kind === 'control')
                           for (const p of Object.keys(it.tracks || {})) it.tracks[p] = it.tracks[p].filter((k) => k.f === 0 || k.f === 48); }""")
            self._menu(pg, "AI in-between")
            self._go(pg, "AI in-between (Kimodo)")
            self._menu(pg, "Export FBX")
            self._go(pg, "Export FBX")
            self._menu(pg, "Export Alembic")
            self._go(pg, "Export Alembic")
        finally:
            pg.close()
        kinds = [k for k, _ in self.requests]
        self.assertEqual([b["seed"] for k, b in self.requests if k == "autorig"], [9])
        motions = [b for k, b in self.requests if k == "motion"]
        self.assertEqual(len(motions), 2)
        self.assertEqual(motions[0]["prompt"], "A person walks forward.")
        self.assertEqual(motions[0]["mode"], "text")
        self.assertEqual(motions[1]["mode"], "inbetween")
        self.assertEqual((keyed[0], keyed[-1]), (0, 48))           # keyed over the shot (reduced where it is straight)
        self.assertGreater(len(keyed), 20)
        self.assertEqual([m["format"] for k, m in self.requests if k == "export"], ["fbx", "abc"])
        self.assertIn("export", kinds)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
