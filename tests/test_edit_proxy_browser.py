"""Proxy playback and the server's scrub sound in the Edit tab, in a real browser.

- A film whose edit proxy is being made plays as it is; once the server says it is ready, the frame resting on
  screen is shown again from the copy (view_file ... &edit=1), and playing and the two-up load the copy too.
- The bar's switch turns it off (the film itself again) and is kept.
- An older server (no /imageviewer/edit_proxy): the film itself, as before.
- Scrubbing reads a sound from /imageviewer/timeline_pcm (mono at 22050) instead of fetching the file.

Needs Playwright with an installed Edge or Chrome, node for the stub server and ffmpeg for the media;
skipped without them. Run: python -m unittest tests.test_edit_proxy_browser
"""
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import urllib.request

from tests.test_edit_play_audio_browser import FFMPEG, ROOT, _ff, _free_port, sync_playwright

SETUP = """(proxies) => {
  const P = __panel;
  try { localStorage.removeItem('imageviewer.viewer.editProxy'); } catch (_) {}
  P._epxOn = null;
  window.__proxies = proxies;
  Object.assign(__media, { 'D:/out/v1.mp4': { duration: 8, audio: true, video: true },
                           'D:/out/a440.wav': { duration: 8, audio: true } });
  P.editTlNew();
  P._editTlApply({ ...P._editTlCut,
    clips: [0, 1].map((i) => ({ file: 'D:/out/v1.mp4', name: 's' + i, in: i * 2, length: 2, transition: 0, color: '', volume: 1 })),
    tracks: [{ id: 'A2', kind: 'audio', name: 'A2', off: false,
               clips: [{ file: 'D:/out/a440.wav', name: 'a440.wav', at: 0, in: 0, length: 4, volume: 0.5 }] }] });
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  P.switchTab(P._editTlTab);
  return P._editTlTab;
}"""

SRC = "() => (__panel.videoBase && __panel.videoBase.currentSrc) || ''"


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or FFMPEG is None,
                 "needs playwright, node and ffmpeg")
class EditProxyBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="bepic_proxy_")
        m = lambda n: os.path.join(cls.media, n)
        _ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", m("v1.mp4"))
        # The "proxy": another picture (smaller), same length - which one is up shows in the video's size.
        _ff("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", "-bf", "0", "-c:a", "aac", "-shortest", m("v1.proxy.mp4"))
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

    def page(self, proxies):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("() => window.__ready", timeout=20000)
        pg.evaluate(SETUP, proxies)
        pg.wait_for_function("() => __panel.videoBase && __panel.videoBase.readyState >= 2", timeout=15000)
        return pg, errors

    def test_the_proxy_is_taken_up_once_it_is_made(self):
        pg, errors = self.page({"D:/out/v1.mp4": ["making", "making", "ready"]})
        self.assertNotIn("edit=1", pg.evaluate(SRC), "while it is made, the film itself")
        pg.wait_for_function("() => (__panel.videoBase.currentSrc || '').includes('edit=1') && __panel.videoBase.readyState >= 2",
                             timeout=15000)
        self.assertEqual(pg.evaluate("() => __panel.videoBase.videoWidth"), 160)
        # Played, and at the next clip (the same film), still the copy.
        pg.evaluate("() => { const P = __panel; P.loopMode = 'once'; P.setFrame(0); P.play(); }")
        pg.wait_for_timeout(2600)
        self.assertGreater(pg.evaluate("() => __panel._ep.tNow"), 2.1)
        self.assertIn("edit=1", pg.evaluate(SRC))
        pg.evaluate("() => __panel.stop()")
        self.assertEqual(errors, [])

    def test_the_switch_turns_it_off_and_is_kept(self):
        pg, errors = self.page({"D:/out/v1.mp4": "ready"})
        pg.wait_for_function("() => (__panel.videoBase.currentSrc || '').includes('edit=1')", timeout=15000)
        btn = pg.evaluate("() => { const b = __panel._editTlUi.proxy; return { on: b.classList.contains('on'), shown: b.isConnected }; }")
        self.assertEqual(btn, {"on": True, "shown": True})
        pg.evaluate("() => __panel._editTlUi.proxy.click()")
        pg.wait_for_function("() => !(__panel.videoBase.currentSrc || '').includes('edit=1') && __panel.videoBase.readyState >= 2",
                             timeout=15000)
        self.assertEqual(pg.evaluate("() => __panel.videoBase.videoWidth"), 320)
        self.assertFalse(pg.evaluate("() => __panel._editTlUi.proxy.classList.contains('on')"))
        self.assertEqual(pg.evaluate("() => localStorage.getItem('imageviewer.viewer.editProxy')"), "off")
        self.assertEqual(errors, [])

    def test_an_older_server_plays_the_film_itself(self):
        pg, errors = self.page({})
        pg.wait_for_timeout(800)
        self.assertNotIn("edit=1", pg.evaluate(SRC))
        self.assertEqual(pg.evaluate("() => __panel.videoBase.videoWidth"), 320)
        self.assertEqual(errors, [])

    def test_scrubbing_reads_the_servers_sound(self):
        pg, errors = self.page({})
        pg.evaluate("() => { window.__pcm = { 'D:/out/v1.mp4': { seconds: 8, freq: 330 }, 'D:/out/a440.wav': { seconds: 8, freq: 440 } }; }")
        pg.evaluate("() => { const P = __panel; P.editScrubAt(0.5); }")
        pg.wait_for_function("() => { const c = __panel._eaDecoded; return c && ['D:/out/v1.mp4', 'D:/out/a440.wav'].every((f) => c.get(f) && c.get(f).data); }",
                             timeout=15000)
        got = pg.evaluate("""() => { const c = __panel._eaDecoded;
          return ['D:/out/v1.mp4', 'D:/out/a440.wav'].map((f) => ({ rate: c.get(f).rate, n: c.get(f).data.length,
                   peak: Math.max(...Array.from(c.get(f).data.slice(0, 2000)).map(Math.abs)) })); }""")
        for g in got:
            self.assertEqual(g["rate"], 22050)
            self.assertEqual(g["n"], 8 * 22050)
            self.assertAlmostEqual(g["peak"], 16000 / 32767, places=2)
        reqs = pg.evaluate("() => __requests.filter((r) => r.startsWith('/imageviewer/timeline_pcm'))")
        self.assertEqual(sorted(reqs), ["/imageviewer/timeline_pcm?D:/out/a440.wav", "/imageviewer/timeline_pcm?D:/out/v1.mp4"])
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
