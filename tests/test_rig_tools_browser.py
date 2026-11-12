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


# MediaPipe's landmarks of a person in the model's T-pose (y down, z away), walking across the picture.
_TPOSE = {11: (0.165, 0.429, -0.013), 12: (-0.164, 0.429, -0.012), 13: (0.453, 0.429, -0.013), 14: (-0.452, 0.429, -0.012),
          15: (0.724, 0.429, -0.013), 16: (-0.723, 0.429, -0.012), 17: (0.82, 0.429, -0.02), 18: (-0.82, 0.429, -0.02),
          19: (0.82, 0.429, 0.0), 20: (-0.82, 0.429, 0.0), 23: (0.1, -0.084, 0.026), 24: (-0.1, -0.083, 0.026),
          25: (0.1, -0.517, 0.018), 26: (-0.1, -0.517, 0.018), 27: (0.1, -0.938, -0.017), 28: (-0.1, -0.938, -0.017),
          29: (0.1, -0.98, -0.07), 30: (-0.1, -0.98, -0.07), 31: (0.1, -0.989, 0.115), 32: (-0.1, -0.989, 0.116),
          7: (0.07, 0.63, 0.01), 8: (-0.07, 0.63, 0.01), 0: (0.0, 0.6, 0.11)}


def fake_track(frames=25):
    out = []
    for i in range(frames):
        world, image = [], []
        for j in range(33):
            x, y, z = _TPOSE.get(j, (0.0, 0.0, 0.0))
            v = 0.95 if j in _TPOSE else 0.0
            world.append([x, -y, -z, v])
            image.append([0.5 + 0.1 * x + 0.01 * i, 0.5 - 0.1 * y, 0.0, v])
        out.append({"i": i, "t": i / 25, "world": world, "image": image})
    return {"fps": 25.0, "width": 1280, "height": 720, "frames": out}


def fake_sitter():
    """One picture: a person sitting on a chair (thighs forward, shins down), the arms hanging, facing the camera."""
    pts = {k: list(v) for k, v in _TPOSE.items()}             # canonical: y up, +z towards the camera
    for sh, el, wr, ix, pk in ((11, 13, 15, 19, 17), (12, 14, 16, 20, 18)):
        x, y, z = pts[sh]
        pts[el], pts[wr] = [x, y - 0.29, z], [x, y - 0.56, z]
        pts[ix], pts[pk] = [x, y - 0.66, z + 0.02], [x, y - 0.66, z - 0.02]
    for hp, kn, an, he, to in ((23, 25, 27, 29, 31), (24, 26, 28, 30, 32)):
        x, y, z = pts[hp]
        pts[kn] = [x, y, z + 0.43]
        pts[an] = [x, y - 0.42, z + 0.43]
        pts[he] = [x, y - 0.47, z + 0.38]
        pts[to] = [x, y - 0.47, z + 0.55]
    world = [[pts[j][0], -pts[j][1], -pts[j][2], 0.95] if j in pts else [0.0, 0.0, 0.0, 0.0] for j in range(33)]
    return {"fps": 0, "width": 640, "height": 480, "picture": True,
            "frames": [{"i": 0, "t": 0, "world": world, "image": None}]}


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
            ready = getattr(self, "installed", True)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "unirig": {"ready": ready, "why": "" if ready else "UniRig is not set up"},
                "skintokens": {"ready": ready and getattr(self, "skin_ready", False), "why": "SkinTokens is not set up"},
                "kimodo": {"ready": ready, "why": "" if ready else "Kimodo is not set up", "model": "Kimodo-SOMA-RP-v1.2"},
                "posetrack": {"ready": ready, "why": "" if ready else "Motion from video is not set up"},
                "install": {"root": "D:/AI/rigtools", "hf_token": False, "running": None}}))

        def install(route, request):
            self.requests.append(("install", json.loads(request.post_data or "{}")))
            state["install_polls"] = 0
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"job": "inst", "kind": "install", "state": "running", "log": [], "share": 0}))

        def start(kind):
            def handler(route, request):
                body = json.loads(request.post_data or "{}")
                self.requests.append((kind, body))
                if kind == "motion":
                    state["result"] = fake_motion(int(body["frames"]))
                elif kind == "video_pose":
                    src = body.get("src") or {}
                    state["result"] = fake_sitter() if str(src.get("path", "")).endswith(".png") else fake_track()
                else:
                    state["result"] = {"path": "D:/out/characters/statue_rig.glb", "relative": "characters/statue_rig.glb",
                                       "name": "statue_rig.glb", "engine": body.get("engine") or "unirig"}
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"job": kind, "state": "running", "log": []}))
            return handler

        def job(route, request):
            if "job=inst" in request.url:
                state["install_polls"] += 1
                if state["install_polls"] < 3:
                    body = {"job": "inst", "state": "running", "log": ["$ pip install torch"], "share": 0.4}
                else:
                    self.installed = True
                    body = {"job": "inst", "state": "done", "log": ["== written"], "share": 1.0}
                route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
                return
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"job": "x", "state": "done", "log": ["done"], "result": state["result"]}))

        def agent_done(route, request):
            self.requests.append(("agent_done", json.loads(request.post_data or "{}")))
            route.fulfill(status=200, content_type="application/json", body='{"ok": true}')

        pg.route("**/imageviewer/rig/agent_done", agent_done)
        pg.route("**/imageviewer/rig/export", export)
        pg.route("**/imageviewer/rig/tools", tools)
        pg.route("**/imageviewer/rig/install", install)
        pg.route("**/imageviewer/rig/autorig", start("autorig"))
        pg.route("**/imageviewer/rig/motion", start("motion"))
        pg.route("**/imageviewer/rig/job*", job)
        pg.route("**/imageviewer/rig/video_pose", start("video_pose"))

        def lipsync(route, request):
            body = json.loads(request.post_data or "{}")
            self.requests.append(("lipsync", body))
            n = 10
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "frames": n, "fps": body["fps"], "open": [0, 0.2, 0.9, 1, 0.5, 0, 0.8, 0.8, 0.2, 0],
                "round": [0] * 6 + [1, 1, 0, 0], "wide": [0] * n, "closed": [0, 0, 0, 0, 0, 1, 0, 0, 0, 0], "hiss": [0] * n}))
        pg.route("**/imageviewer/rig/lipsync", lipsync)
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        # The pose library's store (src/rig_poses.py, tested in test_rig_poses.py), stood in for by the page.
        pg.evaluate("""() => { const before = window.__fetchApi, store = [];
            window.__fetchApi = async (p, opts) => {
                if (p !== '/imageviewer/rig/poses') return before(p, opts);
                const b = JSON.parse(opts.body), j = (o) => ({ ok: true, status: 200, json: async () => o });
                if (b.op === 'save') { store.unshift(b.pose); return j({ ok: true, pose: b.pose }); }
                if (b.op === 'delete') return j({ ok: true });
                return j({ poses: store.slice() });
            }; }""")
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

    def test_ai_takes_land_as_clips_in_the_clip_sequencer(self):
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            pg.evaluate("async () => window.__panel.previzAutoRig(window.__hero, { seed: 7 })")
            pg.evaluate(HELP)
            keyed = pg.evaluate("""async () => { const r = await window.__panel.previzRigGenerateMotion(window.__hero,
                                     { mode: 'text', prompt: 'A person walks forward.', from: 0, to: 48 });
                                   return [r, window.__boneAt('Hips', 0), window.__boneAt('Hips', 48)]; }""")
            pg.evaluate("() => window.__panel.previzUndo()")
            take = pg.evaluate("""async () => { const P = window.__panel;
                const keysBefore = P.previzScene().items.filter((it) => it.kind === 'control').reduce((n, it) => n + Object.keys(it.tracks || {}).length, 0);
                const r = await P.previzRigGenerateMotion(window.__hero,
                    { mode: 'text', prompt: 'A person walks forward.', from: 0, to: 48, asClip: true });
                const keysAfter = P.previzScene().items.filter((it) => it.kind === 'control').reduce((n, it) => n + Object.keys(it.tracks || {}).length, 0);
                const q = P.previzScene().sequencer;
                return { r, keysBefore, keysAfter, tracks: q.tracks.map((t) => [t.name, t.clips.map((c) => [c.start, c.length])]),
                         made: q.sources.map((s) => s.made), hips0: window.__boneAt('Hips', 0), hips48: window.__boneAt('Hips', 48),
                         blocks: P.clipsPanel.querySelectorAll('.cs-clip').length }; }""")
            second = pg.evaluate("""async () => { const P = window.__panel;
                await P.previzRigGenerateMotion(window.__hero, { mode: 'text', prompt: 'A person walks forward.', from: 0, to: 48, asClip: true });
                return P.previzScene().sequencer.tracks.map((t) => t.name); }""")
        finally:
            pg.close()
        r, hips0, hips48 = keyed
        self.assertTrue(take["r"]["ok"], take["r"])
        self.assertEqual(take["r"]["clip"], "AI takes")
        self.assertEqual(take["keysAfter"], take["keysBefore"], "the character's own keys are as they were")
        self.assertEqual(take["tracks"], [["AI takes", [[0, 48]]]])
        self.assertEqual(take["made"], ["ai"])
        self.assertEqual(take["blocks"], 1)
        # The clip plays what the keys played.
        for a, b in ((take["hips0"], hips0), (take["hips48"], hips48)):
            for x, y in zip(a, b):
                self.assertAlmostEqual(x, y, delta=1e-3)
        self.assertEqual(second, ["AI takes", "AI takes 2"], "a second take stacks above the first")
        self.assertEqual(self.errors, [])

    def _menu(self, pg, label):
        """Click an entry of the Rig menu, the Animation menu or File's Export character."""
        for btn in ("button.previz-rig", "button.previz-anim", "button.previz-mb-file"):
            pg.locator(btn).first.click()
            item = pg.locator("button.previz-menu-item", has_text=label)
            if item.count():
                sub = pg.locator("button.previz-menu-item.has-sub", has_text="Export character")
                if btn.endswith("file") and sub.count():
                    sub.first.click()
                item.first.click()
                return
            pg.evaluate("() => window.__panel._previzCloseAddMenu()")
        raise AssertionError(f"no menu entry {label!r}")

    def _go(self, pg, title, fill=None):
        box = pg.locator(f'.rd-box[aria-label="{title}"]')
        box.wait_for(state="visible", timeout=10000)
        for sel, value in (fill or {}).items():
            box.locator(sel).first.fill(str(value))
        box.locator("button.rd-go").click()
        box.wait_for(state="detached", timeout=30000)

    def test_install_from_the_auto_rig_dialog(self):
        """Not set up: Auto-rig… offers the install, which runs and then opens the Auto-rig dialog."""
        self.installed = False
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            self._menu(pg, "Auto-rig")
            box = pg.locator('.rd-box[aria-label="Install AI rigging / motion models"]')
            box.wait_for(state="visible", timeout=10000)
            text = box.inner_text()
            self.assertEqual(box.locator('input[type="password"]').count(), 1)
            box.locator('input[type="password"]').fill("hf_" + "b" * 30)
            box.locator("button.rd-go").click()
            rig = pg.locator('.rd-box[aria-label="Auto-rig"]')
            rig.wait_for(state="visible", timeout=20000)
            gone = box.count()
        finally:
            pg.close()
            self.installed = True
        self.assertIn("not set up on this machine", text)
        body = [b for k, b in self.requests if k == "install"][0]
        self.assertEqual(body["root"], "D:/AI/rigtools")                # the server's suggestion
        self.assertEqual(body["hf_token"], "hf_" + "b" * 30)
        self.assertIsNone(body["only"])                       # "also AI motion" was ticked
        self.assertEqual(gone, 0)
        self.assertEqual(self.errors, [])

    def test_auto_rig_offers_skintokens_and_keeping_the_skeleton(self):
        """SkinTokens set up: the dialog offers it first; on a model with a skeleton it can keep it (skin weights
        only), UniRig cannot; the engine chosen is remembered; one not set up opens the install for it."""
        self.skin_ready = True
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            pg.evaluate("() => { try { localStorage.removeItem('imageviewer.viewer.autorigEngine'); } catch (_) {} }")
            self._menu(pg, "Auto-rig")
            box = pg.locator('.rd-box[aria-label="Auto-rig"]')
            box.wait_for(state="visible", timeout=10000)
            first = box.locator("select.rig-engine").input_value()
            no_keep = box.get_by_text("Keep its skeleton").count()       # the statue has no skeleton yet
            box.locator("select.rig-engine").select_option("unirig")
            box.locator("select.rig-engine").select_option("skintokens")
            box.locator("button.rd-go").click()
            box.wait_for(state="detached", timeout=30000)
            pg.wait_for_function("() => window.__panel.previzScene().items.some((it) => it.kind === 'control')", timeout=30000)
            remembered = pg.evaluate("() => localStorage.getItem('imageviewer.viewer.autorigEngine')")
            # Rigged now: it has a skeleton, which SkinTokens can keep.
            self._menu(pg, "Auto-rig")
            box.wait_for(state="visible", timeout=10000)
            keep = box.locator("label", has_text="Keep its skeleton")
            shown_skin = keep.is_visible()
            box.locator("select.rig-engine").select_option("unirig")
            shown_unirig = keep.is_visible()
            box.locator("select.rig-engine").select_option("skintokens")
            keep.locator("input").check()
            hint = box.locator(".rd-hint").first.inner_text()
            box.locator("button.rd-go").click()
            box.wait_for(state="detached", timeout=30000)
            # The agent's road names the engine too.
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'r1', action: 'autorig',
                             args: { model: 'statue', engine: 'unirig', keep_skeleton: true } })""")
        finally:
            pg.close()
            self.skin_ready = False
        self.assertEqual(first, "skintokens")
        self.assertEqual(no_keep, 0)
        self.assertEqual(remembered, "skintokens")
        self.assertTrue(shown_skin)
        self.assertFalse(shown_unirig)
        self.assertIn("stays", hint)
        bodies = [b for k, b in self.requests if k == "autorig"]
        self.assertEqual([(b["engine"], b["keep_skeleton"]) for b in bodies], [("skintokens", False), ("skintokens", True)])
        done = [b for k, b in self.requests if k == "agent_done" and b.get("id") == "r1"][-1]
        self.assertEqual(done["state"], "error")
        self.assertIn("only SkinTokens", done["error"])
        self.assertEqual(self.errors, [])

    def test_drive_everything_from_the_rig_menu(self):
        """The same road as the agent's, by hand: Rig menu, dialogs, their buttons."""
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            self._menu(pg, "Auto-rig")
            self._go(pg, "Auto-rig", {"input.rd-num": 9})
            pg.wait_for_function("() => window.__panel.previzScene().items.some((it) => it.kind === 'control')", timeout=30000)
            pg.evaluate("() => window.__panel.setFrame(0)")
            self._menu(pg, "Generate motion from text")
            self._go(pg, "Motion from text (Kimodo)", {"textarea": "A person walks forward."})
            keyed = pg.evaluate("() => window.__panel.previzRigKeyedFrames(window.__hero)")
            pg.evaluate("() => window.__panel.setFrame(20)")
            for t in ("Clean up feet",):
                self._menu(pg, t)
            # Keep frames 0 and 48 only, then ask for what is between them.
            # (The text motion went onto an animation layer of its own: its keys are filtered too.)
            pg.evaluate("""() => { for (const it of window.__panel.previzScene().items) if (it.kind === 'control')
                           for (const set of [it.tracks || {}, ...Object.values(it.layerTracks || {})])
                           for (const p of Object.keys(set)) set[p] = set[p].filter((k) => k.f === 0 || k.f === 48); }""")
            self._menu(pg, "AI in-between")
            self._go(pg, "AI in-between (Kimodo)")
            self.layers = pg.evaluate("() => window.__panel.previzScene().animLayers || []")
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
        # Each AI take landed on an override layer of its own.
        self.assertEqual([(l["name"].split(" ")[0:2], l["mode"]) for l in self.layers],
                         [(["AI", "motion"], "override"), (["AI", "in-between"], "override")])
        self.assertEqual(motions[1]["mode"], "inbetween")
        self.assertEqual((keyed[0], keyed[-1]), (0, 48))           # keyed over the shot (reduced where it is straight)
        self.assertGreater(len(keyed), 20)
        self.assertEqual([m["format"] for k, m in self.requests if k == "export"], ["fbx", "abc"])
        self.assertIn("export", kinds)
        self.assertEqual(self.errors, [])

    def test_restyle_video_motion_lip_sync_and_layers(self):
        """Restyle, motion from a film and lip sync, each taken onto a layer; the agent's scene-wide ops."""
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            pg.evaluate("async () => window.__panel.previzAutoRig(window.__hero, { seed: 7 })")
            pg.evaluate(HELP)
            pg.evaluate("""async () => window.__panel.previzRigGenerateMotion(window.__hero,
                             { mode: 'text', prompt: 'A person walks forward.', from: 0, to: 48 })""")
            # Agent: layers asked for before the layers feature is in the viewer say so.
            had_layers = pg.evaluate("() => typeof window.__panel.previzLayerAdd === 'function'")
            had_poses = pg.evaluate("() => typeof window.__panel.previzPoseList === 'function'")
            pg.evaluate("async () => window.__panel.previzRigAgentRun({ id: 'l0', action: 'layer_add', args: { name: 'x' } })")
            # A stand-in for the layers mixin: records which layer each bake went to.
            pg.evaluate("""() => { const p = window.__panel; window.__layers = [];
                p.previzLayerAdd = (o) => { window.__layers.push({ add: o.name, mode: o.mode }); return 'L' + window.__layers.length; };
                p.previzWithLayer = (id, fn) => { window.__layers.push({ into: id }); return fn(); }; }""")
            entries = pg.evaluate("""() => window.__panel.previzRigAIEntries(window.__hero, { rigged: true }).map((e) => e.label)""")
            restyle = pg.evaluate("""async () => window.__panel.previzRigRestyle(window.__hero,
                                       { prompt: 'A tired old man walks.', strength: 'medium', layer: 'new' })""")
            film = pg.evaluate("""async () => window.__panel.previzRigVideoMotion(window.__hero,
                                    { src: { filename: 'walk.mp4', type: 'input' }, at: 60, smooth: 0, layer: 'new' })""")
            hips60, hips84 = pg.evaluate("() => [window.__boneAt('Hips', 60), window.__boneAt('Hips', 84)]")
            arm = pg.evaluate("() => [window.__boneAt('LeftArm', 70), window.__boneAt('LeftHand', 70)]")
            layers = pg.evaluate("() => window.__layers")
            # Lip sync: a character with ARKit mouth shapes, keyed through "bs:" tracks (the rig extras' scene model).
            pg.evaluate("""() => { const p = window.__panel;
                p._previzMorphNames = () => ['jawOpen', 'mouthFunnel', 'mouthClose', 'eyeBlinkLeft'];
                p._previzCanKeyMorphs = () => true;
                window.__keys = {};
                const it = p.previzScene().items.find((i) => i.id === window.__hero);
                it.tracks = it.tracks || {};
                window.__hero_item = it; }""")
            # (until the scene model knows "bs:" tracks, keys are written straight into the item for the test)
            pg.evaluate("""() => { const p = window.__panel; const orig = p.previzRigLipSync.bind(p);
                window.__lip = async (o) => orig(o); }""")
            lips = pg.evaluate("""async () => window.__panel.previzRigLipSync(window.__hero,
                                    { src: { filename: 'line.wav', type: 'input' }, at: 5, lead: 0 })""")
            # The agent's road for the new actions.
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'a3', action: 'restyle',
                             args: { model: 'Statue', prompt: 'A soldier marches.', strength: 'close' } })""")
            pg.evaluate("async () => window.__panel.previzRigAgentRun({ id: 'a4', action: 'layer_add', args: { name: 'Fix', mode: 'additive' } })")
            pg.evaluate("async () => window.__panel.previzRigAgentRun({ id: 'a5', action: 'pose_list', args: {} })")
            pg.evaluate("async () => window.__panel.previzRigAgentRun({ id: 'a6', action: 'list_constraints', args: {} })")
        finally:
            pg.close()
        self.assertEqual(entries, ["Pose…", "Restyle motion…", "Motion from video…", "Lip sync from audio…"])
        motions = [b for k, b in self.requests if k == "motion"]
        r = motions[1]
        self.assertEqual(r["mode"], "restyle")
        self.assertEqual(r["prompt"], "A tired old man walks.")
        self.assertEqual(r["path"]["frames"][0], 0)
        self.assertEqual(r["path"]["frames"][-1], r["frames"] - 1)
        self.assertTrue(all(k.get("effectors") for k in r["keys"][1:]))
        self.assertTrue(restyle["ok"], restyle)
        self.assertEqual(restyle["layer"], "L1")
        vp = [b for k, b in self.requests if k == "video_pose"][0]
        self.assertEqual(vp["src"], {"filename": "walk.mp4", "type": "input"})
        self.assertTrue(film["ok"], film)
        self.assertEqual(film["layer"], "L3")
        self.assertEqual(layers[0], {"add": "AI restyle · Statue", "mode": "override"})
        self.assertEqual(layers[1], {"into": "L1"})
        self.assertEqual(layers[2]["add"], "Video motion · Statue")
        # 25 film frames at 25 fps = 1 s = 24 scene frames; the person moved across the picture (+X here)
        self.assertGreater(hips84[0] - hips60[0], 0.05)
        # T-posed arm in the film: the character's left arm points out sideways (+X)
        d = [arm[1][i] - arm[0][i] for i in range(3)]
        self.assertGreater(d[0], 0.8 * math.hypot(*d))
        self.assertTrue(lips["ok"], lips)
        self.assertEqual(lips["set"], "arkit")
        self.assertEqual(lips["shapes"], 3)
        lip = [b for k, b in self.requests if k == "lipsync"][0]
        self.assertEqual(lip["src"], {"filename": "line.wav", "type": "input"})
        done = {b["id"]: b for k, b in self.requests if k == "agent_done" and b["state"] in ("done", "error")}
        if not had_layers:
            self.assertEqual(done["l0"]["state"], "error")
            self.assertIn("Animation layers", done["l0"]["error"])
        self.assertEqual(done["a3"]["state"], "done", done["a3"])
        self.assertEqual(done["a4"]["state"], "done", done["a4"])
        self.assertEqual(done["a4"]["result"]["layer"], "L5")
        if had_poses:
            self.assertEqual(done["a5"]["state"], "done", done["a5"])
        else:
            self.assertEqual(done["a5"]["state"], "error")
            self.assertIn("pose library", done["a5"]["error"])
        self.assertEqual(done["a6"]["state"], "done", done["a6"])        # constraints are in the viewer (#110)
        self.assertEqual(done["a6"]["result"]["constraints"], [])
        self.assertEqual(self.errors, [])

    def test_the_agent_poses_the_character_on_one_frame(self):
        """A pose from named poses and joints in words, keyed on one frame, through the agent's road."""
        pg = self.page()
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            pg.evaluate("async () => window.__panel.previzAutoRig(window.__hero, { seed: 7 })")
            pg.evaluate(HELP)
            rest = pg.evaluate("() => ['Hips', 'LeftHand', 'RightHand', 'LeftFoot', 'LeftUpLeg'].map((b) => window.__boneAt(b, 10))")
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'p1', action: 'pose',
                             args: { model: 'Statue', preset: ['sit', 'arms_crossed'], frame: 10,
                                     joints: { head: { turn: 25 }, tail: { wag: 1 } } } })""")
            posed = pg.evaluate("() => ['Hips', 'LeftHand', 'RightHand', 'LeftFoot', 'LeftUpLeg'].map((b) => window.__boneAt(b, 10))")
            keyed = pg.evaluate("() => window.__panel.previzRigKeyedFrames(window.__hero)")
            pg.evaluate("async () => window.__panel.previzRigAgentRun({ id: 'p2', action: 'pose', args: { model: 'Statue', preset: 'fly' } })")
            pg.evaluate("async () => window.__panel.previzRigAgentRun({ id: 'p3', action: 'pose_presets', args: {} })")
            # A side plank on the right hand, the hand straight under its shoulder; asked for twice, it stays the same.
            plank = """async () => window.__panel.previzRigAgentRun({ id: 'p4', action: 'pose', args: { model: 'Statue', frame: 30,
                         joints: { hips: { side: -70, turn: 30 }, 'upperArm.L': { down: -80 } },
                         contacts: [{ part: 'right hand', under: true }, 'left foot'] } })"""
            pg.evaluate(plank)
            once = pg.evaluate("() => ['Hips', 'RightHand', 'RightArm', 'LeftFoot'].map((b) => window.__boneAt(b, 30))")
            pg.evaluate(plank)
            twice = pg.evaluate("() => ['Hips', 'RightHand', 'RightArm', 'LeftFoot'].map((b) => window.__boneAt(b, 30))")
            # A pose from a picture of somebody sitting, arms hanging.
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'p5', action: 'pose',
                             args: { model: 'Statue', frame: 50, image: 'D:/refs/sitter.png' } })""")
            pic = pg.evaluate("() => ['Hips', 'LeftHand', 'LeftArm', 'LeftFoot', 'LeftLeg'].map((b) => window.__boneAt(b, 50))")
            # The same picture read by ComfyUI's SAM 3D Body nodes: the graph the server hands over is queued,
            # and its ImageViewerBodyPose answer read (ComfyUI's queue stood in for here).
            body_asks = []

            def body_pose(route, request):
                ask = json.loads(request.post_data or "{}")
                body_asks.append(ask)
                if str(ask["src"].get("path", "")).endswith(".mp4"):           # a film: two parts of 15 and 10 frames
                    answer = {"film": True, "fps": 25.0, "width": 1280, "height": 720, "frames": list(range(25)),
                              "parts": [{"graph": {"4": {"class_type": "ImageViewerBodyPose", "inputs": {}}, "part": [a, n]},
                                         "output": "4", "first": a, "count": n} for a, n in ((0, 15), (15, 10))]}
                else:
                    answer = {"graph": {"4": {"class_type": "ImageViewerBodyPose", "inputs": {}}}, "output": "4", "image": "rig_pose/x.png"}
                route.fulfill(status=200, content_type="application/json", body=json.dumps(answer))
            pg.route("**/imageviewer/rig/body_pose", body_pose)
            pg.evaluate("""([world, film]) => {
                const p = window.__panel, tools = p._previzRigTools.bind(p);
                p._previzRigTools = async () => Object.assign(await tools(), { sam3dbody: { ready: true, missing: [] } });
                window.__parts = [];
                p._paintQueue = async (g) => { window.__queued = g; if (g.part) window.__parts.push(g.part); return 'pid'; };
                p._paintWait = async (id, out, tell) => {
                    const g = window.__queued;
                    if (!g.part) return tell.pick({ imageviewer_body: [{ people: [{ landmarks: world }] }] });
                    const frames = film.frames.slice(g.part[0], g.part[0] + g.part[1]).map((f) => ({ world: f.world, image: f.image }));
                    return tell.pick({ imageviewer_body: [{ people: [], frames, width: 960, height: 540 }] });
                };
            }""", [fake_sitter()["frames"][0]["world"], fake_track()])
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'p6', action: 'pose',
                             args: { model: 'Statue', frame: 70, image: 'D:/refs/sitter.png', fov: 40 } })""")
            sam = pg.evaluate("() => ['Hips', 'LeftHand', 'LeftArm', 'LeftFoot', 'LeftLeg'].map((b) => window.__boneAt(b, 70))")
            queued = pg.evaluate("() => window.__queued")
            # A film read by SAM 3D Body: a graph per part, every frame's person put together and solved.
            pg.evaluate("""async () => window.__panel.previzRigAgentRun({ id: 'v1', action: 'video_motion',
                             args: { model: 'Statue', from: 100, path: 'D:/refs/walk.mp4', via: 'sam3d', film_to: 24,
                                     step: 1, smooth: 0, fov: 45 } })""")
            film_hips = pg.evaluate("() => [window.__boneAt('Hips', 100), window.__boneAt('Hips', 124)]")
            parts = pg.evaluate("() => window.__parts")
        finally:
            pg.close()
        done = {b["id"]: b for k, b in self.requests if k == "agent_done" and b["state"] in ("done", "error")}
        self.assertEqual(done["p1"]["state"], "done", done["p1"])
        self.assertEqual(done["p1"]["result"]["frame"], 10)
        self.assertEqual(done["p1"]["result"]["not_understood"], ["tail"])
        self.assertEqual(keyed, [10])
        (h0, l0, r0, f0, _), (h1, l1, r1, f1, _) = rest, posed
        stand = h0[1] - f0[1]
        # Sitting: the hips come down to about knee height, the feet stay on the floor.
        self.assertLess(h1[1] - f1[1], 0.75 * stand)
        self.assertLess(abs(f1[1] - f0[1]), 0.15 * stand)
        # Arms crossed: each hand has gone over to the other side of the body.
        across = [r0[i] - l0[i] for i in range(3)]               # from the left hand to the right one at rest
        dot = lambda a, b: sum(x * y for x, y in zip(a, b))
        side = [x / math.sqrt(dot(across, across)) for x in across]
        mid = [(l0[i] + r0[i]) / 2 for i in range(3)]
        self.assertGreater(dot([l1[i] - mid[i] for i in range(3)], side), -0.02 * stand)
        self.assertLess(dot([r1[i] - mid[i] for i in range(3)], side), 0.02 * stand)
        self.assertEqual(done["p2"]["state"], "error")
        self.assertIn("sit", done["p2"]["error"])
        names = [p["name"] for p in done["p3"]["result"]["presets"]]
        self.assertIn("arms_crossed", names)
        self.assertIn("upperArm", done["p3"]["result"]["parts"])
        self.assertIn("hand.R", done["p3"]["result"]["contacts"])
        self.assertEqual(done["p4"]["state"], "done", done["p4"])
        self.assertEqual(done["p4"]["result"]["contacts"], ["hand.R", "foot.L"])
        hips, hand, shoulder, foot = once
        floor = f0[1]                                            # the ankle at rest
        self.assertLess(abs(hand[1] - floor), 0.08 * stand, (hand, floor))
        self.assertLess(math.hypot(hand[0] - shoulder[0], hand[2] - shoulder[2]), 0.12 * stand, (hand, shoulder))
        self.assertLess(abs(foot[1] - floor), 0.08 * stand, (foot, floor))
        for a, b in zip(once, twice):
            self.assertLess(math.dist(a, b), 1e-3 * stand, "the same pose asked for again turns nothing further")
        self.assertEqual(done["p5"]["state"], "done", done["p5"])
        self.assertEqual([b["src"] for k, b in self.requests if k == "video_pose"][-1], {"path": "D:/refs/sitter.png"})
        hips, hand, shoulder, foot, thigh = pic
        self.assertLess(hips[1] - foot[1], 0.75 * stand)         # sitting down
        self.assertLess(abs(foot[1] - floor), 0.08 * stand, (foot, floor))
        self.assertLess(hand[1], shoulder[1] - 0.35 * stand)     # the arms hang
        self.assertLess(math.hypot(hand[0] - shoulder[0], hand[2] - shoulder[2]), 0.15 * stand)
        self.assertEqual(done["p5"]["result"].get("read_with"), "mediapipe")
        self.assertEqual(done["p6"]["state"], "done", done["p6"])
        self.assertEqual(done["p6"]["result"]["read_with"], "sam3d")
        self.assertEqual(body_asks[0], {"src": {"path": "D:/refs/sitter.png"}, "fov": 40})
        self.assertEqual(queued["4"]["class_type"], "ImageViewerBodyPose")
        for a, b in zip(pic, sam):                                # the same landmarks: the same pose
            self.assertLess(math.dist(a, b), 1e-3 * stand)
        self.assertEqual(done["v1"]["state"], "done", done["v1"])
        self.assertEqual(done["v1"]["result"]["read_with"], "sam3d")
        self.assertEqual(body_asks[-1], {"src": {"path": "D:/refs/walk.mp4"}, "start": 0, "end": 24, "step": 1, "fov": 45})
        self.assertEqual(parts, [[0, 15], [15, 10]])
        self.assertGreater(film_hips[1][0] - film_hips[0][0], 0.05)   # the person moved across the picture
        self.assertEqual(self.errors, [])

    def _ask(self, pg, aid, action, args=None):
        """The agent's road: a request as rig_routes sends it; the page's answer to /rig/agent_done."""
        pg.evaluate("async ([id, action, args]) => window.__panel.previzRigAgentRun({ id, action, args })", [aid, action, args or {}])
        done = [b for k, b in self.requests if k == "agent_done" and b.get("id") == aid and b["state"] in ("done", "error")]
        self.assertTrue(done, f"no answer to {aid}")
        return done[-1]

    def test_the_agent_makes_clips_and_renders_a_turntable_of_each(self):
        """animate_scene's road: AI takes as clips, a clip placed, one turntable rig keyed per clip, a render per clip,
        keys, layers, display layers, set-driven keys, IK/FK, USD and the scene in viewerState."""
        pg = self.page()
        frames, encodes, usd = [], [], []

        def frame(route, request):
            b = json.loads(request.post_data or "{}")
            frames.append((b["name"], b["index"]))
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"path": f"D:/out/previz/{b['name']}/{b['index']:04d}.png", "dir": f"D:/out/previz/{b['name']}"}))

        def encode(route, request):
            b = json.loads(request.post_data or "{}")
            encodes.append(b)
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"path": f"D:/out/previz/{b['name']}.mp4", "relative": f"previz/{b['name']}.mp4"}))

        def usd_export(route, request):
            b = json.loads(request.post_data or "{}")
            usd.append(b)
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"path": "D:/out/stages/shot_v001.usda", "relative": "stages/shot_v001.usda"}))
        pg.route("**/imageviewer/previz_frame", frame)
        pg.route("**/imageviewer/previz_encode", encode)
        pg.route("**/imageviewer/usd_export", usd_export)
        try:
            pg.evaluate(OPEN, ["statue.glb", "Statue"])
            pg.evaluate("async () => window.__panel.previzAutoRig(window.__hero, { seed: 7 })")
            take = self._ask(pg, "m1", "motion", {"model": "Statue", "prompt": "A person walks forward.", "from": 0, "to": 23, "as_clip": True})
            info = self._ask(pg, "s1", "scene_info")
            src = info["result"]["scene"]["clips"]["sources"][0]["name"]
            placed = self._ask(pg, "c1", "clip_place", {"source": src, "at": 30})
            sped = self._ask(pg, "c2", "clip_set", {"clip": placed["result"]["clip"], "name": "Fast walk", "speed": 2})
            listed = self._ask(pg, "c3", "clip_list")
            tt = self._ask(pg, "t1", "turntable", {"clips": "all", "degrees": 360})
            orbit = pg.evaluate("""() => { const P = window.__panel, view = P._modelView(), scene = P.previzScene();
                const cam = scene.items.find((i) => i.kind === 'camera' && i.name === 'Turntable cam');
                const e = view._entries.get(cam.id); const out = [];
                for (const f of [0, 6, 12, 18, 30, 33, 36]) { view.applyFrame(f); e.root.updateMatrixWorld(true);
                    const p = e.camera.getWorldPosition(new view.libs.THREE.Vector3());
                    const d = new view.libs.THREE.Vector3(0, 0, -1).applyQuaternion(e.camera.getWorldQuaternion(new view.libs.THREE.Quaternion()));
                    out.push([f, p.toArray(), d.toArray()]); }
                view.applyFrame(0); return out; }""")
            renders = []
            for i, rg in enumerate(tt["result"]["ranges"]):
                renders.append(self._ask(pg, f"r{i}", "render", {"clip": rg["clip"], "camera": "Turntable cam",
                                                                  "name": f"turn_{i}", "add_node": False, "width": 64, "height": 36}))
            blast = self._ask(pg, "pb", "playblast", {"from": 0, "to": 3, "camera": "Turntable cam", "hud": False, "scale": 25})
            ik = pg.evaluate("() => window.__panel.previzScene().items.find((i) => i.kind === 'control' && i.control.type === 'ik').name")
            fk = pg.evaluate("() => window.__panel.previzScene().items.find((i) => i.kind === 'control' && i.control.type === 'fk').name")
            sw = self._ask(pg, "ik1", "ikfk_switch", {"control": ik, "to": "fk", "frame": 5})
            key = self._ask(pg, "k1", "key_set", {"item": fk, "prop": "rotation", "keys": [{"frame": 2, "value": [10, 0, 0]}, {"frame": 8, "axis": "y", "value": 25}]})
            keys = self._ask(pg, "k2", "key_list", {"item": fk, "frame": 8})
            kdel = self._ask(pg, "k3", "key_delete", {"item": fk, "prop": "rotation", "frame": 2})
            lay = self._ask(pg, "l1", "layer_add", {"name": "Fix", "mode": "additive"})
            lset = self._ask(pg, "l2", "layer_set", {"layer": "Fix", "weight": 0.5, "mute": True})
            dl = self._ask(pg, "d1", "display_layer_add", {"name": "set", "items": ["Statue"]})
            dset = self._ask(pg, "d2", "display_layer_set", {"layer": "set", "visible": False, "mode": "template"})
            attr = self._ask(pg, "x1", "attr_add", {"item": fk, "name": "fist", "min": 0, "max": 1})
            sdk = self._ask(pg, "x2", "sdk_key", {"driver": {"item": fk, "prop": "attr:fist"}, "driver_value": 1,
                                                  "driven": [{"item": ik, "prop": "position", "axis": "y", "value": 0.3}], "frame": 0})
            cam = self._ask(pg, "cam", "add_camera", {"name": "Wide", "position": [4, 2, 4], "look_at": [0, 1, 0], "fov": 30, "active": False})
            look = pg.evaluate("""() => { const P = window.__panel, view = P._modelView(), scene = P.previzScene();
                const c = scene.items.find((i) => i.name === 'Wide'); const e = view._entries.get(c.id); view.applyFrame(0);
                e.root.updateMatrixWorld(true);
                return new view.libs.THREE.Vector3(0, 0, -1).applyQuaternion(e.camera.getWorldQuaternion(new view.libs.THREE.Quaternion())).toArray(); }""")
            split = self._ask(pg, "c4", "clip_split", {"clip": "Fast walk", "at": 33})
            bad = self._ask(pg, "e1", "clip_set", {"clip": "nobody"})
            stage = self._ask(pg, "u1", "export_usd", {"name": "shot"})
            state = pg.evaluate("() => window.__panel.agentViewerState().scene3d")
            undo = pg.evaluate("() => window.__panel._undoState().past.map((s) => s.label).slice(-4)")
        finally:
            pg.close()
        self.assertEqual(take["state"], "done", take)
        self.assertEqual(take["result"]["clip"], "AI takes")
        self.assertEqual(placed["state"], "done", placed)
        self.assertEqual([placed["result"]["from"], placed["result"]["to"]], [30, 53])
        self.assertEqual(sped["state"], "done", sped)
        self.assertEqual([sped["result"]["from"], sped["result"]["to"], sped["result"]["speed"]], [30, 41, 2], "a speed keeps the source: half as long")
        ranges = [[c["name"], c["from"], c["to"]] for c in listed["result"]["turntable_ranges"]]
        self.assertEqual(ranges[1], ["Fast walk", 30, 41])
        self.assertEqual(ranges[0][1:], [0, 23])
        self.assertEqual(tt["state"], "done", tt)
        self.assertEqual([[r["from"], r["to"]] for r in tt["result"]["ranges"]], [[0, 23], [30, 41]])
        # The camera goes round the subject: the same distance from its centre, looking at it, a quarter turn every 6 frames.
        c0 = tt["result"]["ranges"][0]["center"]
        dist = tt["result"]["ranges"][0]["distance"]
        for f, p, d in orbit[:4]:
            flat = math.hypot(p[0] - c0[0], p[2] - c0[2])
            self.assertAlmostEqual(flat, dist, delta=1e-3 * max(1, dist))
            to = [c0[i] - p[i] for i in range(3)]
            n = math.hypot(*to)
            self.assertGreater(sum(d[i] * to[i] / n for i in range(3)), 0.999, f"frame {f} looks at the subject")
        a0 = math.atan2(orbit[0][1][0] - c0[0], orbit[0][1][2] - c0[2])
        a6 = math.atan2(orbit[1][1][0] - c0[0], orbit[1][1][2] - c0[2])
        self.assertAlmostEqual(abs(math.degrees(a6 - a0)) % 360, 90, delta=0.5)
        self.assertGreater(orbit[0][1][2], c0[2], "it starts in front of the character (+Z)")
        # Each clip's render: its own frames, through the turntable camera.
        for i, (r, (a, b)) in enumerate(zip(renders, [(0, 23), (30, 41)])):
            self.assertEqual(r["state"], "done", r)
            self.assertEqual(r["result"]["path"], f"D:/out/previz/turn_{i}.mp4")
            self.assertEqual(sorted(x for n, x in frames if n == f"turn_{i}"), list(range(a, b + 1)))
        self.assertEqual(blast["state"], "done", blast)
        self.assertEqual(sorted(x for n, x in frames if n.endswith("_playblast")), [0, 1, 2, 3])
        self.assertEqual(sw["state"], "done", sw)
        self.assertEqual(sw["result"]["ikfk"], 0)
        self.assertEqual(key["state"], "done", key)
        self.assertEqual(key["result"]["keys"], 2)
        rot = {k["frame"]: k["value"] for k in keys["result"]["tracks"]["rotation"]}
        self.assertAlmostEqual(rot[8][1], 25, delta=1e-6)
        self.assertEqual(kdel["result"]["frames_cleared"], 1)
        self.assertEqual(lay["state"], "done", lay)
        self.assertEqual(lset["state"], "done", lset)
        self.assertEqual([lset["result"]["weight"], lset["result"]["mute"]], [0.5, True])
        self.assertEqual(dl["result"]["members"], 1)
        self.assertEqual([dset["result"]["visible"], dset["result"]["mode"]], [False, "template"])
        self.assertEqual(attr["result"]["prop"], "attr:fist")
        self.assertEqual(sdk["state"], "done", sdk)
        self.assertEqual(sdk["result"]["keyed"], 1)
        to = [-4, -1, -4]
        n = math.hypot(*to)
        self.assertGreater(sum(look[i] * to[i] / n for i in range(3)), 0.999, (look, "add_camera looks at its look_at"))
        self.assertEqual(split["state"], "done", split)
        self.assertEqual(bad["state"], "error")
        self.assertIn("no clip named nobody", bad["error"])
        self.assertEqual(stage["result"]["path"], "D:/out/stages/shot_v001.usda")
        self.assertEqual(usd[0]["format"], "usda")
        self.assertIn("Turntable cam", state["cameras"])
        self.assertEqual(state["active_camera"], "Turntable cam")
        self.assertTrue(any(c["name"] == "Fast walk" for c in state["clips"]), state)
        self.assertEqual(state["anim_layers"][0]["name"], "Fix")
        self.assertEqual(state["display_layers"][0]["visible"], False)
        self.assertIn("split clip", undo, "each change is an undo step")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
