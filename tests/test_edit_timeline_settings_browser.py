"""The Edit timeline's settings in a real browser: the first picture into an empty timeline gives it its size and
frame rate, the Inspector changes them (one undo step), and the Edit tab draws each picture in the timeline's frame
by its Scaling - black around it where its shape differs.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest tests.test_edit_timeline_settings_browser
Real pictures are written here with Pillow and served through HARNESS_MEDIA_DIR.
"""
import os
import shutil
import tempfile
import unittest

import test_edit_timeline_browser as base

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

Base = type("Base", (unittest.TestCase,), {k: v for k, v in base.EditTimelineBrowserTests.__dict__.items()
                                           if not k.startswith("test") and k not in ("__dict__", "__weakref__")})

MEDIA = """() => Object.assign(__media, {
  'D:/out/wide.png': { duration: 0, still: true, video: true, width: 1600, height: 900, fps: 0 },
  'D:/out/square.png': { duration: 0, still: true, video: true, width: 400, height: 400, fps: 0 },
  'D:/out/film25.mp4': { duration: 2, video: true, audio: false, width: 1280, height: 720, fps: 25 },
  'D:/out/film30.mp4': { duration: 2, video: true, audio: false, width: 640, height: 480, fps: 30 } })"""

SETTINGS = "() => { const c = __panel._editTlCut; return [c.width || 0, c.height || 0, c.fps, c.fit || 'fit', c.setBy || '']; }"
ADD = "async (items) => { await __panel._editTlAdd(items.map(([path, kind]) => ({ path, name: path.split('/').pop(), kind })), null, null); return __panel._editTlNote; }"


@unittest.skipIf(Image is None, "needs Pillow")
class EditTimelineSettingsBrowserTests(Base):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp()
        Image.new("RGB", (1600, 900), (0, 0, 200)).save(os.path.join(cls.media, "wide.png"))
        Image.new("RGB", (400, 400), (200, 0, 0)).save(os.path.join(cls.media, "square.png"))
        old = os.environ.get("HARNESS_MEDIA_DIR")
        os.environ["HARNESS_MEDIA_DIR"] = cls.media
        try:
            Base.setUpClass.__func__(cls)
        finally:
            if old is None:
                os.environ.pop("HARNESS_MEDIA_DIR", None)
            else:
                os.environ["HARNESS_MEDIA_DIR"] = old

    @classmethod
    def tearDownClass(cls):
        Base.tearDownClass.__func__(cls)
        shutil.rmtree(cls.media, ignore_errors=True)

    def empty(self):
        pg = self.page()
        pg.evaluate(MEDIA)
        pg.evaluate("() => __panel.editTlNew()")
        return pg

    def test_the_first_picture_into_an_empty_timeline_gives_it_its_size_and_rate(self):
        pg = self.empty()
        self.assertEqual(pg.evaluate(SETTINGS), [0, 0, 24, "fit", ""])
        note = pg.evaluate(ADD, [["D:/out/film25.mp4", "video"]])
        self.assertEqual(pg.evaluate(SETTINGS), [1280, 720, 25, "fit", ""])
        self.assertIn("timeline set to 1280x720 \u00b7 25 fps from film25.mp4", note)
        # Its length is on the new rate's frames: 2 s = 50 frames.
        self.assertEqual(pg.evaluate("() => __panel.editPlayFrameCount()"), 50)
        # The next one, of another size and rate, changes nothing.
        pg.evaluate(ADD, [["D:/out/film30.mp4", "video"]])
        self.assertEqual(pg.evaluate(SETTINGS), [1280, 720, 25, "fit", ""])
        # Emptied again, the next first picture gives them again - one undo step with its drop.
        pg.evaluate("() => __panel._editTlApply({ ...__panel._editTlCut, clips: [] })")
        pg.evaluate(ADD, [["D:/out/film30.mp4", "video"]])
        self.assertEqual(pg.evaluate(SETTINGS), [640, 480, 30, "fit", ""])
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(SETTINGS), [1280, 720, 25, "fit", ""])
        self.assertEqual(self.errors, [])

    def test_settings_set_by_hand_in_the_inspector_stay(self):
        pg = self.empty()
        pg.evaluate("() => __panel.editTlSettingsShow()")
        pg.wait_for_selector(".insp-rate", state="attached")
        pg.evaluate("""() => { const s = __panel.editInspectorPanel.querySelector('.insp-rate'); s.value = '50';
                                s.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate(SETTINGS), [0, 0, 50, "fit", "hand"])
        pg.evaluate("""() => { const s = __panel.editInspectorPanel.querySelector('.insp-size-preset'); s.value = '1080x1920';
                                s.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate(SETTINGS), [1080, 1920, 50, "fit", "hand"])
        pg.evaluate(ADD, [["D:/out/film25.mp4", "video"]])
        self.assertEqual(pg.evaluate(SETTINGS), [1080, 1920, 50, "fit", "hand"], "set by hand: the first clip leaves them")
        # The Inspector says so and the save carries them.
        pg.evaluate("() => { __panel._editTlSel = null; __panel.editTlRefresh(); }")
        said = pg.evaluate("() => __panel.editInspectorPanel.textContent")
        self.assertIn("Timeline Settings", said)
        self.assertEqual(pg.evaluate("() => __panel._editTlDirty()"), True)
        self.assertEqual(self.errors, [])

    def test_a_picture_of_another_shape_is_drawn_in_the_timelines_frame_by_its_scaling(self):
        pg = self.empty()
        pg.evaluate(ADD, [["D:/out/wide.png", "image"], ["D:/out/square.png", "image"]])
        self.assertEqual(pg.evaluate(SETTINGS)[:2], [1600, 900])
        # The square's frame: 3 s of the wide still, then the square.
        pg.evaluate("() => __panel.setFrame(4 * 24)")
        pg.wait_for_function("() => __panel.imgBase.naturalWidth === 400 && __panel.imgBase.complete", timeout=10000)
        pg.wait_for_timeout(100)
        geo = """() => { const P = __panel, el = P.imgBase, bg = P._epFrameBg;
          const f = bg && bg.firstChild.getBoundingClientRect();
          return { t: el.style.transform, clip: el.style.clipPath, bg: bg && bg.style.display, size: bg && bg.dataset.size,
                   aspect: f ? f.width / f.height : 0, W: el.clientWidth, H: el.clientHeight }; }"""
        g = pg.evaluate(geo)
        self.assertEqual(g["bg"], "block")
        self.assertEqual(g["size"], "1600x900")
        self.assertAlmostEqual(g["aspect"], 16 / 9, 2)
        # Fit: whole inside the frame - nothing cut, and scaled only where the layer is narrower than 16:9.
        self.assertEqual(g["clip"], "")
        # Fill: as wide as the frame, cut to it.
        pg.evaluate("() => __panel.editTlSetSettings({ fit: 'fill' })")
        pg.wait_for_timeout(100)
        g = pg.evaluate(geo)
        fw = min(g["W"], g["H"] * 16 / 9)
        want = fw / min(g["W"], g["H"])
        got = pg.evaluate("() => { const m = /scale\\(([\\d.]+), ([\\d.]+)\\)/.exec(__panel.imgBase.style.transform); return m ? [Number(m[1]), Number(m[2])] : [1, 1]; }")
        self.assertAlmostEqual(got[0], want, 3)
        self.assertAlmostEqual(got[1], want, 3)
        self.assertTrue(g["clip"].startswith("polygon("), g["clip"])
        # The clip's own Scaling wins: none = its own 400 pixels of the 1600 wide frame.
        pg.evaluate("() => { const c = __panel._editTlCut; __panel._editTlApply({ ...c, clips: c.clips.map((x, i) => i === 1 ? { ...x, fx: { fit: 'none' } } : x) }); }")
        pg.wait_for_timeout(100)
        g = pg.evaluate(geo)
        r = pg.evaluate("() => __panel.imgBase.getBoundingClientRect().width")
        drawn = pg.evaluate("""() => { const el = __panel.imgBase, m = /scale\\(([\\d.]+), [\\d.]+\\)$/.exec(el.style.transform);
                                       return Math.min(el.clientWidth, el.clientHeight) * (m ? Number(m[1]) : 1); }""")
        self.assertAlmostEqual(drawn / fw, 400 / 1600, 2)
        self.assertGreater(r, 0)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
