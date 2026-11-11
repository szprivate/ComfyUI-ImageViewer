"""The 3D space's Clip Sequencer, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three: a keyed box becomes a clip (Clip from keys), the clip drives the box in the viewport,
it is moved and loop-extended with the real mouse, a second clip is matched to the first, the
sequence is baked back to keys, and undo walks it all back. CLIPS_SHOTS=<folder> writes screenshots.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_clip_seq_browser
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
  await P.previzAddPrimitive('box');
  const it = P.previzSelectedItem();
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  S.setKeyframe(it, 'position', 0, [0, 0.5, 0], 'linear');
  S.setKeyframe(it, 'position', 12, [0, 1.5, 2], 'linear');
  S.setKeyframe(it, 'position', 24, [0, 0.5, 4], 'linear');
  P.previzChanged();
  P.setPanelDocked('clips', true);
  P.previzRefreshClips();
  const c = P.previzClipsFromKeys();
  P.previzClipsFit();
  P.setFrame(12);
  const root = P._model3d._entries.get(it.id).root.position;
  return { clip: c && { start: c.start, length: c.length }, keysLeft: (it.tracks.position || []).length,
           blocks: P.clipsPanel.querySelectorAll('.cs-clip').length, rootAt12: [root.x, root.y, root.z], id: it.id };
}"""

STATE = """() => {
  const P = window.__panel, q = P.previzScene().sequencer;
  const it = P.previzSelectedItem();
  return { tracks: q ? q.tracks.map((t) => t.clips.map((c) => ({ start: c.start, length: c.length, loop: c.loop, off: c.offset || null }))) : [],
           keys: (it.tracks.position || []).length, undo: P._undoState().past.length };
}"""

AT = """(f) => { const P = window.__panel; P.setFrame(f); const e = P._model3d._entries.get(P.previzSelectedItem().id).root.position; return [e.x, e.y, e.z]; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ClipSequencerTests(unittest.TestCase):
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

    def _box(self, pg, sel):
        b = pg.evaluate("(sel) => { const e = window.__panel.clipsPanel.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }", sel)
        self.assertIsNotNone(b, sel)
        return b

    def test_clip_from_keys_drives_the_box_and_is_edited_with_the_mouse(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        shots = os.environ.get("CLIPS_SHOTS")
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(SETUP)
            self.assertEqual(st["clip"], {"start": 0, "length": 24})
            self.assertEqual(st["keysLeft"], 0, "the keys moved into the clip")
            self.assertEqual(st["blocks"], 1)
            for a, b in zip(st["rootAt12"], [0, 1.5, 2]):
                self.assertAlmostEqual(a, b, places=4)
            if shots:
                os.makedirs(shots, exist_ok=True)
                pg.screenshot(path=os.path.join(shots, "clips-1-from-keys.png"))

            # Drag the clip 20 frames to the right with the real mouse.
            blk = self._box(pg, ".cs-clip")
            px = blk["width"] / 24
            y = blk["y"] + blk["height"] / 2
            pg.mouse.move(blk["x"] + blk["width"] / 2, y)
            pg.mouse.down()
            pg.mouse.move(blk["x"] + blk["width"] / 2 + 10 * px, y, steps=5)
            pg.mouse.move(blk["x"] + blk["width"] / 2 + 20 * px, y, steps=5)
            pg.mouse.up()
            s = pg.evaluate(STATE)
            self.assertEqual(s["tracks"][0][0]["start"], 20)
            at32 = pg.evaluate(AT, 32)
            self.assertAlmostEqual(at32[2], 2, places=4)

            # Ctrl + drag the right edge: the clip loops on for 24 more frames.
            blk = self._box(pg, ".cs-clip")
            x = blk["x"] + blk["width"] - 2
            pg.keyboard.down("Control")
            pg.mouse.move(x, y)
            pg.mouse.down()
            pg.mouse.move(x + 12 * px, y, steps=4)
            pg.mouse.move(x + 24 * px, y, steps=4)
            pg.mouse.up()
            pg.keyboard.up("Control")
            s = pg.evaluate(STATE)
            c = s["tracks"][0][0]
            self.assertEqual((c["loop"], c["length"]), ("cycle", 48))
            self.assertAlmostEqual(pg.evaluate(AT, 56)[2], 2, places=4, msg="the second turn plays the walk again")

            # Walk on: each turn starts where the last ended.
            pg.evaluate("""async () => { const P = window.__panel; const Q = await import('/extensions/viewer/imageViewer_clipSeqData.js');
                P._csEdit('walk on', (qq) => Q.setClip(qq, qq.tracks[0].clips[0].id, { accumulate: true })); }""")
            self.assertAlmostEqual(pg.evaluate(AT, 56)[2], 6, places=4)

            # A second clip of the same source after it, matched: it walks on from 8.
            pg.evaluate("""() => { const P = window.__panel; const q = P.previzScene().sequencer;
                const c = P.previzClipsPlace(q.sources[0].id, 68); P.previzClipsMatch(c.id); }""")
            s = pg.evaluate(STATE)
            self.assertEqual(sum(len(t) for t in s["tracks"]), 2)
            self.assertAlmostEqual(pg.evaluate(AT, 80)[2], 10, places=4)
            if shots:
                pg.evaluate("() => window.__panel.previzClipsFit()")
                pg.screenshot(path=os.path.join(shots, "clips-2-looped-and-matched.png"))
                r = pg.evaluate("() => { const b = window.__panel.clipsPanel.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }")
                pg.screenshot(path=os.path.join(shots, "clips-3-panel.png"), clip=r)

            # The panel's keys: select the second clip, Ctrl+D duplicates it, Del removes the copy.
            blk2 = pg.evaluate("() => { const r = window.__panel.clipsPanel.querySelectorAll('.cs-clip')[1].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }")
            pg.mouse.click(blk2["x"] + blk2["width"] / 2, blk2["y"] + blk2["height"] / 2)
            pg.keyboard.press("Control+d")
            self.assertEqual(sum(len(t) for t in pg.evaluate(STATE)["tracks"]), 3)
            pg.keyboard.press("Delete")
            self.assertEqual(sum(len(t) for t in pg.evaluate(STATE)["tracks"]), 2)

            # Bake: keys again, the same motion, no clips.
            want = [pg.evaluate(AT, f) for f in (30, 56, 80)]
            pg.evaluate("() => window.__panel.previzClipsBake()")
            s = pg.evaluate(STATE)
            self.assertEqual(s["tracks"], [])
            self.assertGreater(s["keys"], 4)
            for f, w in zip((30, 56, 80), want):
                got = pg.evaluate(AT, f)
                for a, b in zip(got, w):
                    self.assertAlmostEqual(a, b, delta=0.02)
            # One undo brings the clips back, a redo bakes again.
            pg.evaluate("() => window.__panel.previzUndo()")
            s = pg.evaluate(STATE)
            self.assertEqual(sum(len(t) for t in s["tracks"]), 2)
            self.assertEqual(s["keys"], 0)
            self.assertAlmostEqual(pg.evaluate(AT, 80)[2], want[2][2], places=4)
            pg.evaluate("() => window.__panel.previzRedo()")
            self.assertEqual(pg.evaluate(STATE)["tracks"], [])
        finally:
            pg.close()
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
