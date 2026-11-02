"""Playing a cut with several sound tracks in a real browser, with real films and sounds: the sound is not sought
back while it plays (a stretch heard twice), the film's clock keeps time across cuts, and after a seek and a loop
going round every sound is where the film is.

Needs Playwright with an installed Edge or Chrome, node for the stub server and ffmpeg for the media;
skipped without them. Run: python -m unittest tests.test_edit_play_audio_browser
It serves tests/harness/edit.html (the REAL viewer js, ComfyUI stubbed) with media made here by ffmpeg
(HARNESS_MEDIA_DIR), held back HARNESS_MEDIA_DELAY_MS per request as a share would, so it never touches a
running ComfyUI.

Why: the film's clock used to be the <video> on screen. At every cut it stood still while the next clip got going
(~50 ms), so every sound track ran ahead, and each time they were more than 0.15 s ahead they were all sought
back - the same stretch heard twice on every track, a few times in ten seconds of a cut of short shots.
"""
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FFMPEG = shutil.which("ffmpeg")

# Every seek of a media element, every play(): [element, ms, from, to].
INIT = r"""(() => {
  const M = window.__m = { on: false, seeks: [], plays: [] };
  const P = HTMLMediaElement.prototype, d = Object.getOwnPropertyDescriptor(P, 'currentTime');
  let id = 0; const tag = (el) => el.__id || (el.__id = el.tagName[0] + (++id));
  Object.defineProperty(P, 'currentTime', { configurable: true, get() { return d.get.call(this); },
    set(v) { if (M.on) M.seeks.push([tag(this), performance.now(), d.get.call(this), v, !this.paused]); d.set.call(this, v); } });
  const play = P.play; P.play = function () { if (M.on) M.plays.push([tag(this), performance.now()]); return play.call(this); };
})();"""

# Twelve shots of a second (two films, taking turns, from different in points) over a bed, and three sound
# tracks with a clip each - one of them with keyed volume, so its sound is looked at every frame.
SETUP = """() => {
  const P = __panel;
  Object.assign(__media, {
    'D:/out/v1.mp4': { duration: 8, audio: true, video: true }, 'D:/out/v2.mp4': { duration: 8, audio: true, video: true },
    'D:/out/bed.wav': { duration: 20, audio: true }, 'D:/out/a220.wav': { duration: 14, audio: true },
    'D:/out/a440.wav': { duration: 14, audio: true }, 'D:/out/a660.wav': { duration: 14, audio: true } });
  P.editTlNew();
  const snd = (file, at, len, extra) => ({ file, name: file.split('/').pop(), at, in: 0, length: len, volume: 0.5, ...(extra || {}) });
  P._editTlApply({ ...P._editTlCut,
    clips: Array.from({ length: 12 }, (_, i) => ({ file: i % 2 ? 'D:/out/v2.mp4' : 'D:/out/v1.mp4', name: 's' + i,
                                                     in: Math.round((i * 0.37) % 5 * 1000) / 1000, length: 1, transition: 0, color: '', volume: 1 })),
    sound: [{ name: 'bed', file: 'D:/out/bed.wav' }],
    tracks: [{ id: 'A2', kind: 'audio', name: 'A2', off: false, clips: [snd('D:/out/a220.wav', 0, 12, { fx: { keys: { vol: [{ t: 0, v: 0.2 }, { t: 8, v: 1 }] } } })] },
             { id: 'A3', kind: 'audio', name: 'A3', off: false, clips: [snd('D:/out/a440.wav', 1, 10)] },
             { id: 'A4', kind: 'audio', name: 'A4', off: false, clips: [snd('D:/out/a660.wav', 2, 9)] }] });
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  P.switchTab(P._editTlTab);
  return P._editTlTab;
}"""

# Each playing sound's distance from where the film's clock says it should be (seconds; every clip here starts
# at its file's beginning and runs at speed 1), and the picture's.
OFF = """() => { const P = __panel, ep = P._ep, t = ep.tNow; if (t == null) return null;
  const items = [{ at: 0 }, { at: 0 }, { at: 1 }, { at: 2 }];
  const sound = (ep.bed || []).map((a, k) => a.paused ? null : a.currentTime - (t - items[k].at));
  const at = ep.at, v = P.videoBase;
  const pic = at && at.clip && !ep.still ? v.currentTime - ((at.base ?? at.clip.in) + (t - (at.segAt ?? at.origin)) * (at.speed || 1)) : null;
  return { t, sound, pic }; }"""

# Watch for `ms`, every frame: the clock against the wall, and each sound's and the picture's distance from it.
WATCH = """async (ms) => {
  const M = __m, P = __panel, t0 = performance.now(), c0 = P._ep.tNow, samples = [];
  await new Promise((done) => { const f = () => { const o = (%s)(); if (o) samples.push(o);
    if (performance.now() - t0 < ms) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
  return { wall: (performance.now() - t0) / 1000, film: P._ep.tNow - c0, samples }; }""" % OFF


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _ff(*args):
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], check=True)


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or FFMPEG is None,
                 "needs playwright, node and ffmpeg")
class EditPlayAudioBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="bepic_play_")
        m = lambda n: os.path.join(cls.media, n)
        for name, src, hz in (("v1.mp4", "testsrc2", 330), ("v2.mp4", "testsrc", 550)):
            _ff("-f", "lavfi", "-i", f"{src}=size=320x180:rate=24:duration=8", "-f", "lavfi", "-i", f"sine=frequency={hz}:duration=8",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", "-c:a", "aac", "-shortest", m(name))
        _ff("-f", "lavfi", "-i", "anoisesrc=d=20:c=pink:a=0.2", "-ac", "2", "-ar", "44100", m("bed.wav"))
        for hz in (220, 440, 660):
            _ff("-f", "lavfi", "-i", f"sine=frequency={hz}:duration=14", "-ac", "2", "-ar", "48000", m(f"a{hz}.wav"))
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.media, HARNESS_MEDIA_DELAY_MS="60")
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

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.add_init_script(INIT)
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("() => window.__ready", timeout=20000)
        pg.evaluate(SETUP)
        # Everything loaded before it plays (the films and the sounds of the first seconds).
        pg.wait_for_function("() => __panel.videoBase && __panel.videoBase.readyState >= 3", timeout=15000)
        pg.wait_for_timeout(800)
        return pg

    def play(self, pg, frame=0):
        pg.evaluate("(f) => { __panel.setFrame(f); __m.seeks = []; __m.plays = []; __m.on = true; __panel.play(); }", frame)

    def seeks(self, pg):
        return pg.evaluate("() => __m.seeks.map(s => [s[0], s[1], s[2], s[3], s[4]])")

    def test_steady_playback_over_cuts_seeks_no_sound_back(self):
        pg = self.page()
        self.play(pg)
        got = pg.evaluate(WATCH, 6000)
        pg.evaluate("() => { __m.on = false; __panel.stop(); }")
        seeks = self.seeks(pg)
        sound = [s for s in seeks if s[0][0] == "A"]
        back = [s for s in sound if s[4] and s[3] < s[2] - 0.01]
        self.assertEqual(back, [], "no playing sound is sought back: nothing is heard twice")
        # Each sound is sought once, where its clip starts (the bed and A2 at the play, A3 at 1 s, A4 at 2 s).
        per = {}
        for s in sound:
            per[s[0]] = per.get(s[0], 0) + 1
        self.assertEqual(sorted(per.values()), [1, 1, 1, 1], f"one seek per sound clip, at its start: {per}")
        # The film's clock keeps the wall's time across six cuts (it used to lose ~50 ms at each).
        self.assertAlmostEqual(got["film"], got["wall"], delta=0.08)
        late = [s for s in got["samples"][30:] if s["sound"]]
        worst = max(abs(x) for s in late for x in s["sound"] if x is not None)
        self.assertLess(worst, 0.15, "every sound stays beside the clock")
        pics = sorted(abs(s["pic"]) for s in got["samples"][30:] if s["pic"] is not None)
        self.assertLess(pics[len(pics) // 2], 0.04, "the picture is on the clock (started before each cut)")
        self.assertEqual(self.errors, [])

    def test_after_a_seek_while_playing_every_sound_is_where_the_film_is(self):
        pg = self.page()
        self.play(pg)
        pg.wait_for_timeout(1200)
        pg.evaluate("() => { __m.seeks = []; __panel.setFrame(24 * 6 + 5); }")     # into the seventh shot
        got = pg.evaluate(WATCH, 1500)
        pg.evaluate("() => { __m.on = false; __panel.stop(); }")
        self.assertGreaterEqual(got["samples"][0]["t"], 6.2)
        # Each playing sound sought once, to the film's moment; none afterwards.
        sound = [s for s in self.seeks(pg) if s[0][0] == "A"]
        self.assertEqual(len(sound), 4, sound)
        settled = [s for s in got["samples"] if s["t"] > got["samples"][0]["t"] + 0.6]
        self.assertTrue(settled)
        for s in settled:
            for x in s["sound"]:
                self.assertIsNotNone(x)
                self.assertLess(abs(x), 0.1, f"a sound off the film after the seek: {s}")
        self.assertEqual(self.errors, [])

    def test_a_loop_going_round_brings_every_sound_round_with_it(self):
        pg = self.page()
        # The range 3 s .. 4.5 s, looped: it goes round about twice in 3 s.
        pg.evaluate("() => { const P = __panel; P.loopMode = 'loop'; P.playbackRange = { start: 72, end: 107 }; }")
        self.play(pg, 72)
        got = pg.evaluate(WATCH, 3200)
        pg.evaluate("() => { __m.on = false; __panel.stop(); }")
        ts = [s["t"] for s in got["samples"]]
        wraps = sum(1 for a, b in zip(ts, ts[1:]) if b < a - 0.5)
        self.assertGreaterEqual(wraps, 1, "the range went round")
        self.assertTrue(all(3.0 - 1e-3 <= t < 4.5 + 0.05 for t in ts), "inside the range")
        sound = [s for s in self.seeks(pg) if s[0][0] == "A"]
        back = [s for s in sound if s[4] and s[3] < s[2] - 0.01]
        # Back with the loop: one seek per sound and turn, never one in between.
        self.assertEqual(len(back), 4 * wraps, back)
        # A while after each turn began, every sound is where the film is.
        starts = [i for i, (a, b) in enumerate(zip(ts, ts[1:]), 1) if b < a - 0.5]
        for i in starts:
            later = [s for s in got["samples"][i:] if s["t"] > got["samples"][i]["t"] + 0.5][:5]
            for s in later:
                for x in s["sound"]:
                    if x is not None:
                        self.assertLess(abs(x), 0.1, f"a sound off the film after the loop went round: {s}")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
