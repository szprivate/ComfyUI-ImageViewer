"""Playing a cut whose sound runs on past its last picture, in a real browser: the Edit tab plays on to
the end of the sound - the picture black after the cut's last frame - and stops there, as the export
renders it (tests/test_edit_export_sound_tail.py).

Needs Playwright with an installed Edge or Chrome, node for the stub server and ffmpeg for the media;
skipped without them. Run: python -m unittest tests.test_edit_play_sound_tail_browser
"""
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import urllib.request

from tests.test_edit_play_audio_browser import FFMPEG, ROOT, _ff, _free_port, sync_playwright

# Two shots of a second on V1 and a sound of four seconds on A2 from 0.5 s: the film is 4.5 s long.
SETUP = """() => {
  const P = __panel;
  Object.assign(__media, { 'D:/out/v1.mp4': { duration: 8, audio: true, video: true },
                           'D:/out/a440.wav': { duration: 8, audio: true } });
  P.editTlNew();
  P._editTlApply({ ...P._editTlCut,
    clips: [0, 1].map((i) => ({ file: 'D:/out/v1.mp4', name: 's' + i, in: i * 2, length: 1, transition: 0, color: '', volume: 1 })),
    tracks: [{ id: 'A2', kind: 'audio', name: 'A2', off: false,
               clips: [{ file: 'D:/out/a440.wav', name: 'a440.wav', at: 0.5, in: 0, length: 4, volume: 0.5 }] }] });
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  P.switchTab(P._editTlTab);
  return P._editTlTab;
}"""

STATE = """() => { const P = __panel, ep = P._ep;
  return { playing: !!P.isPlaying, t: ep ? ep.tNow : null, pic: ep && ep.at ? !!ep.at.clip : null,
           sound: ep ? (ep.bed || []).some((a) => !a.paused) : false, frame: P.currentFrame }; }"""


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or FFMPEG is None,
                 "needs playwright, node and ffmpeg")
class EditPlaySoundTailBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="bepic_tail_")
        m = lambda n: os.path.join(cls.media, n)
        _ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", "-c:a", "aac", "-shortest", m("v1.mp4"))
        _ff("-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-ac", "2", "-ar", "48000", m("a440.wav"))
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.media)
        env.pop("HARNESS_MEDIA", None)
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/edit.html", timeout=1).read()
                break
            except Exception:
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                cls.browser = cls.pw.chromium.launch(channel=channel, headless=True,
                                                     args=["--autoplay-policy=no-user-gesture-required"])
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

    def test_playback_runs_on_to_the_end_of_the_sound(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("() => window.__ready", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_function("() => __panel.videoBase && __panel.videoBase.readyState >= 3", timeout=15000)
        pg.wait_for_timeout(500)
        pg.evaluate("() => { const P = __panel; P.loopMode = 'once'; P.setFrame(0); P.play(); }")
        pg.wait_for_timeout(3300)                        # 3.3 s in: past the pictures (2 s), the sound still on
        mid = pg.evaluate(STATE)
        self.assertTrue(mid["playing"], mid)
        self.assertGreater(mid["t"], 2.5, mid)
        self.assertFalse(mid["pic"], "black past the cut's last frame")
        self.assertTrue(mid["sound"], "the sound plays on")
        pg.wait_for_timeout(2000)                        # 5.3 s: the film (4.5 s) has ended
        end = pg.evaluate(STATE)
        self.assertFalse(end["playing"], end)
        self.assertEqual(end["frame"], int(4.5 * 24) - 1, "stopped on the film's last frame, the sound's end")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
