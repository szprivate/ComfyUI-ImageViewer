"""Sound files in the Viewer, in a real browser: the REAL viewer js against stubbed ComfyUI scripts, with a real WAV.

A sound is a frame like a clip: it plays through the Viewer's <video> and transport, hidden, with its waveform
drawn in the viewport instead; its History tile is drawn, never fetched (a fetched one would fail and ask for
the item to be pruned); a click on the waveform seeks; going to a picture puts the waveform away. A sound
dropped from the desktop lands in the History the same way.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_viewer_audio_browser
"""
import math
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import unittest
import urllib.request
import wave

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

SHOW = """async ([path, name]) => {
  const P = window.__panel;
  if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
  P.showInViewerTab([[{ kind: 'audio', path, name, external: true, fps: 24 }]], { show: true, dedupe: false });
  P._historyPanelSig = null;
  P.renderHistoryPanel();
}"""

STATE = """() => { const P = window.__panel, v = P.videoBase, a = P._audioView;
  const tile = P.historyStrip.querySelector('.history-thumb img');
  return { videoMode: !!P._videoMode, videoShown: v.style.display, src: v.getAttribute('src') || '',
           duration: v.duration, time: v.currentTime, paused: v.paused,
           on: !!(a && a.view.classList.contains('on')), name: a ? a.name.textContent : '',
           clock: a ? a.time.textContent : '', peaks: P._audioPeaksNow ? P._audioPeaksNow.length : 0,
           note: a ? a.note.textContent : '', tile: tile ? tile.getAttribute('src') || '' : '',
           frames: P._videoFrames }; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _write_tone(path, seconds=3.0, rate=22050):
    """A 440 Hz tone that fades in, so the waveform has a shape to it."""
    n = int(seconds * rate)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(32000 * (i / n) * math.sin(2 * math.pi * 440 * i / rate)))
                               for i in range(n)))


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ViewerAudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="bepic_audio_")
        _write_tone(os.path.join(cls.media, "tone.wav"))
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.media)
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
                cls.browser = (cls.pw.chromium.launch(channel=channel, headless=True,
                                                      args=["--autoplay-policy=no-user-gesture-required"]) if channel
                               else cls.pw.chromium.launch(headless=True,
                                                           args=["--autoplay-policy=no-user-gesture-required"]))
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
        cls.server.terminate()
        cls.server.wait(5)
        shutil.rmtree(cls.media, ignore_errors=True)

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1400, "height": 900})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        return pg

    def test_a_sound_plays_with_its_waveform(self):
        pg = self.page()
        pg.evaluate(SHOW, ["D:/out/tone.wav", "tone.wav"])
        pg.wait_for_function("() => window.__panel._audioPeaksNow && window.__panel.videoBase.duration > 0", timeout=15000)
        s = pg.evaluate(STATE)
        self.assertTrue(s["videoMode"], "a sound rides the clip transport")
        self.assertEqual(s["videoShown"], "none", "the <video> plays it hidden")
        self.assertIn("tone.wav", s["src"])
        self.assertTrue(s["on"], "the waveform is up")
        self.assertEqual(s["name"], "tone.wav")
        self.assertAlmostEqual(s["duration"], 3.0, delta=0.05)
        self.assertGreater(s["peaks"], 100, "the waveform was decoded")
        self.assertTrue(s["tile"].startswith("data:image/svg+xml"), "the History tile is drawn, not fetched")
        self.assertEqual(s["frames"], 72, "the timeline steps through it at 24 fps")
        self.assertIn("/ 0:03.0", s["clock"])

        # A click on the waveform, three quarters along, seeks there.
        box = pg.evaluate("() => { const r = window.__panel._audioView.wave.getBoundingClientRect();"
                          " return [r.x, r.y, r.width, r.height]; }")
        pg.mouse.click(box[0] + box[2] * 0.75, box[1] + box[3] / 2)
        pg.wait_for_function("() => Math.abs(window.__panel.videoBase.currentTime - 2.25) < 0.1", timeout=5000)
        self.assertEqual(pg.evaluate("() => window.__panel._audioView.time.textContent"), "0:02.3 / 0:03.0")

        # It plays: the transport's play runs the hidden player and the clock moves.
        pg.evaluate("() => { const v = window.__panel.videoBase; v.currentTime = 0; return v.play(); }")
        pg.wait_for_function("() => window.__panel.videoBase.currentTime > 0.3", timeout=5000)
        pg.evaluate("() => window.__panel.videoBase.pause()")

        # A picture next: the waveform goes away and the <video> is let go.
        pg.evaluate("""() => { const P = window.__panel;
          P.showInViewerTab([[{ path: 'D:/out/pic.png', name: 'pic.png', external: true }]], { show: true, dedupe: false }); }""")
        pg.wait_for_function("() => !window.__panel._videoMode", timeout=5000)
        s = pg.evaluate(STATE)
        self.assertFalse(s["on"], "the waveform is put away for a picture")
        self.assertEqual(s["src"], "")
        self.assertEqual(self.errors, [])

    def test_a_sound_dropped_from_the_desktop(self):
        pg = self.page()
        pg.evaluate("""async () => { const P = window.__panel;
          if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
          const bytes = await (await fetch('/media/tone.wav')).arrayBuffer();
          P._addDroppedFiles([new File([bytes], 'drop.wav', { type: 'audio/wav' })]); }""")
        pg.wait_for_function("() => window.__panel._audioPeaksNow && window.__panel.videoBase.duration > 0", timeout=15000)
        s = pg.evaluate(STATE)
        self.assertTrue(s["on"])
        self.assertEqual(s["name"], "drop.wav")
        self.assertTrue(s["src"].startswith("blob:"))
        item = pg.evaluate("() => { const P = window.__panel, f = P._baseFrames()[0];"
                           " return { kind: f.kind, drag: P._historyDragItem(f, [f]).kind,"
                           "          current: P._currentFrameDragItem() }; }")
        self.assertEqual((item["kind"], item["drag"]), ("audio", "audio"))
        self.assertNotIn("extractFrame", item["current"], "a sound is dragged as the file, not a frame of it")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
