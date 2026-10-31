"""The Edit panel in a real browser: drops, filmstrips and waveforms, the blade, undo, keys, Auto edit, cut detection.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest tests.test_edit_timeline_browser
It serves tests/harness/edit.html - the REAL viewer js against stubbed ComfyUI scripts, with the server's Edit routes
answered in the page - on a free port, so it never touches a running ComfyUI.
"""
import os
import shutil
import socket
import subprocess
import sys
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# A cut of three shots (a film with sound, a still, a film) over music, with an empty video and sound track.
SETUP = """(zoom) => {
  const P = __panel;
  Object.assign(__media, {
    'D:/out/a.mp4': { duration: 4, audio: true, video: true }, 'D:/out/b.mp4': { duration: 5, audio: false, video: true },
    'D:/out/c.png': { duration: 0, still: true, video: true }, 'D:/out/music.wav': { duration: 20, audio: true },
    'D:/in/edits/song.wav': { duration: 6, audio: true }, 'D:/in/edits/shot.png': { duration: 0, still: true },
    'D:/in/edits/film.mp4': { duration: 2, audio: false, video: true }, 'D:/out/render_1.mp4': { duration: 2.5, video: true } });
  P.editTlNew();
  if (zoom) P._editTlView.zoom = zoom;
  const cut = { ...P._editTlCut, clips: [
     { file: 'D:/out/a.mp4', name: 'a', in: 0, length: 4, transition: 0, color: '', volume: 1 },
     { file: 'D:/out/c.png', name: 'c', in: 0, length: 3, transition: 0, color: '', volume: 1 },
     { file: 'D:/out/b.mp4', name: 'b', in: 1, length: 4, transition: 0, color: '', volume: 1 }],
     sound: [{ name: 'music', file: 'D:/out/music.wav' }],
     tracks: [{ id: 'V2', kind: 'video', name: 'V2', off: false, clips: [] },
              { id: 'A2', kind: 'audio', name: 'A2', off: false, clips: [] }] };
  P._editTlApply(cut);
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  return P._editTlTab;
}"""

CUT = "() => { const c = __panel._editTlCut; return { v1: c.clips.map(x => [x.file, Math.round(x.in*1000)/1000, Math.round(x.length*1000)/1000]), " \
      "tracks: Object.fromEntries(c.tracks.map(k => [k.id, k.clips.map(x => [x.file, Math.round(x.at*1000)/1000, Math.round(x.length*1000)/1000])])) }; }"

# The screen x of a moment of the film, and the y of a track's row.
WHERE = """([t, track]) => { const ui = __panel._editTlUi, a = ui.area.getBoundingClientRect();
  const row = [...ui.rows.querySelectorAll('.edit-track')].find(r => r.dataset.track === track).getBoundingClientRect();
  return [a.left + a.width * t / __panel._editTlLay.total, row.top + row.height / 2]; }"""

# A drag from the desktop, dropped at a point: DataTransfer with files, the events the browser sends.
DROP = """async ([x, y, files, uri]) => {
  const root = __panel._editTlUi.body.getRootNode();
  const target = root.elementFromPoint(x, y);
  const dt = new DataTransfer();
  for (const [name, type] of files) dt.items.add(new File([new Uint8Array(64)], name, { type }));
  if (uri) dt.setData('text/uri-list', uri);
  const ev = (type) => new DragEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
  target.dispatchEvent(ev('dragenter'));
  target.dispatchEvent(ev('dragover'));
  const ui = __panel._editTlUi;
  const mark = { line: getComputedStyle(ui.drop).display, left: ui.drop.style.left,
                 landing: [...ui.rows.querySelectorAll('.edit-track.landing')].map(r => r.dataset.track) };
  target.dispatchEvent(ev('drop'));
  return mark; }"""

# How much of a clip's canvas is drawn: [painted pixels in the top half, in the bottom half].
PAINT = """(key) => { const b = [...__panel._editTlUi.rows.querySelectorAll('.edit-shot, .edit-snd')].find(e => (e.dataset.key || 'A1') === key);
  const cv = b && b._emCanvas; if (!cv) return null;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let top = 0, bottom = 0;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x += 2) {
    if (d[(y * cv.width + x) * 4 + 3] > 0) { if (y < cv.height / 2) top++; else bottom++; } }
  return [top, bottom, cv.width, cv.height]; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class EditTimelineBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
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
        cls.server.terminate()
        cls.server.wait(5)

    def page(self, zoom=0):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        pg.evaluate(SETUP, zoom)
        self.settle(pg)
        return pg

    @staticmethod
    def settle(pg):
        pg.wait_for_function("() => __panel._emPending === 0 && __panel._emDrawn > 0", timeout=15000)

    @staticmethod
    def focus_timeline(pg):
        """A press on the timeline where nothing lies: it takes the focus, as a user's click does."""
        x, y = pg.evaluate(WHERE, [0.2, "V2"])
        pg.mouse.click(x, y)

    def cut(self, pg):
        return pg.evaluate(CUT)

    # ── drag and drop ──

    def test_files_from_the_desktop_land_where_dropped(self):
        pg = self.page()
        x, y = pg.evaluate(WHERE, [5.0, "V2"])
        mark = pg.evaluate(DROP, [x, y, [["shot.png", "image/png"], ["song.wav", "audio/wav"]], ""])
        self.assertEqual(mark["line"], "block", "the drop line shows where it lands")
        self.assertEqual(mark["landing"], ["V2"])
        pg.wait_for_function("() => __panel._editTlCut.tracks[0].clips.length === 1", timeout=5000)
        c = self.cut(pg)
        # The picture is placed at the moment it was dropped at, as a still of the default length; the sound goes
        # to a sound track at the same moment, as long as the file is.
        self.assertEqual(c["tracks"]["V2"], [["D:/in/edits/shot.png", 5.0, 3.0]])
        self.assertEqual(c["tracks"]["A2"], [["D:/in/edits/song.wav", 5.0, 6.0]])
        self.assertTrue(any(r.startswith("/bepic/timeline_upload") for r in pg.evaluate("() => __requests")))
        # Onto V1 a film goes between the shots - near the join at 4 s it lands there.
        x, y = pg.evaluate(WHERE, [4.4, "V1"])
        pg.evaluate(DROP, [x, y, [["film.mp4", "video/mp4"]], ""])
        pg.wait_for_function("() => __panel._editTlCut.clips.length === 4", timeout=5000)
        self.assertEqual([v[0] for v in self.cut(pg)["v1"]], ["D:/out/a.mp4", "D:/in/edits/film.mp4", "D:/out/c.png", "D:/out/b.mp4"])
        # One drop, one step back.
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(len(self.cut(pg)["v1"]), 3)
        self.assertEqual(self.errors, [])

    def test_a_drop_snaps_to_an_edit_point_and_comfy_outputs_are_found(self):
        pg = self.page()
        # A hair after the cut at 7 s (within the snapping distance): it lands ON 7.
        x, y = pg.evaluate(WHERE, [7.04, "V2"])
        pg.evaluate(DROP, [x, y, [], "http://127.0.0.1/api/view?filename=render_1.mp4&type=output&subfolder="])
        pg.wait_for_function("() => __panel._editTlCut.tracks[0].clips.length === 1", timeout=5000)
        self.assertEqual(self.cut(pg)["tracks"]["V2"], [["D:/out/render_1.mp4", 7.0, 2.5]])
        # And a history thumbnail's payload, named by ComfyUI's filename alone.
        x, y = pg.evaluate(WHERE, [9.6, "V2"])
        pg.evaluate("""async ([x, y]) => { const root = __panel._editTlUi.body.getRootNode(); const t = root.elementFromPoint(x, y);
            const dt = new DataTransfer(); dt.setData('application/x-bepic-history', JSON.stringify({ items: [{ filename: 'render_1.mp4', type: 'output', kind: 'video' }] }));
            t.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })); }""", [x, y])
        pg.wait_for_function("() => __panel._editTlCut.tracks[0].clips.length === 2", timeout=5000)
        self.assertEqual(self.errors, [])

    # ── filmstrips and waveforms ──

    def test_filmstrips_and_waveforms_are_drawn_in_the_clips(self):
        pg = self.page()
        a = pg.evaluate(PAINT, "V1:0")         # a film with sound: frames above, the waveform below
        self.assertGreater(a[0], a[2] * a[3] * 0.2)
        self.assertGreater(a[1], a[2] * a[3] * 0.1)
        b = pg.evaluate(PAINT, "V1:2")         # no sound: frames all the way down
        self.assertGreater(b[1], b[2] * b[3] * 0.2)
        bed = pg.evaluate(PAINT, "A1")         # the music bed: a waveform
        self.assertGreater(bed[0] + bed[1], 0)
        self.assertLess(bed[0] + bed[1], bed[2] * bed[3] / 2 * 0.99, "a waveform, not a filled block")
        # The strip shows the in..out: b starts at 1 s of its file, so its first tile is the 2nd second's colour.
        reqs = pg.evaluate("() => __requests")
        self.assertTrue(any("timeline_strip?D:/out/b.mp4" in r for r in reqs))
        self.assertFalse(any("timeline_peaks?D:/out/c.png" in r for r in reqs), "a still has no sound to ask for")
        self.assertEqual(self.errors, [])

    def test_only_what_is_in_view_is_asked_for_and_zoom_asks_for_more_frames(self):
        pg = self.page(zoom=3)
        reqs = pg.evaluate("() => __requests.filter(r => r.includes('timeline_'))")
        self.assertTrue(any("a.mp4" in r for r in reqs))
        self.assertFalse(any("b.mp4" in r for r in reqs), "b is out of view")
        n_before = max(int(r.split("&n=")[1]) for r in reqs if "timeline_strip?D:/out/a.mp4" in r)
        pg.evaluate("() => { const s = __panel._editTlUi.scroll; s.scrollLeft = s.scrollWidth; }")
        pg.wait_for_function("() => __requests.some(r => r.includes('timeline_strip?D:/out/b.mp4'))", timeout=5000)
        self.settle(pg)
        pg.evaluate("() => { const s = __panel._editTlUi.scroll; s.scrollLeft = 0; __panel._editTlZoom(48); }")
        pg.wait_for_function("() => __requests.some(r => r.includes('timeline_strip?D:/out/a.mp4&n=256'))", timeout=5000)
        self.settle(pg)
        n_after = max(int(r.split("&n=")[1]) for r in pg.evaluate("() => __requests") if "timeline_strip?D:/out/a.mp4" in r)
        self.assertGreater(n_after, n_before, "zoomed in, the strip asks for more frames")
        self.assertEqual(self.errors, [])

    def test_twenty_clips_draw_quickly(self):
        pg = self.page()
        ms = pg.evaluate("""async () => {
            const P = __panel; __delay = 30;
            const clips = [];
            for (let i = 0; i < 20; i++) { const f = 'D:/out/clip_' + i + '.mp4'; __media[f] = { duration: 3, audio: i % 2 === 0, video: true };
                clips.push({ file: f, name: 'clip ' + i, in: 0, length: 3, transition: 0, color: '', volume: 1 }); }
            const t0 = performance.now();
            P._editTlApply({ ...P._editTlCut, clips, tracks: [] });
            await new Promise(r => { const tick = () => (P._emPending === 0 && P._emDrawn >= 20) ? r() : setTimeout(tick, 5); setTimeout(tick, 20); });
            return performance.now() - t0; }""")
        print(f"\n20 new clips, every reading 30 ms away: strips and waveforms drawn in {ms:.0f} ms", file=sys.stderr)
        self.assertLess(ms, 3000)
        # From the cache, a redraw (a scroll, a zoom, an edit) asks for nothing.
        before = pg.evaluate("() => __requests.length")
        ms2 = pg.evaluate("""async () => { const t0 = performance.now(); __panel.editTlRefresh();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t0; }""")
        print(f"redraw of the same 20 from the cache: {ms2:.0f} ms", file=sys.stderr)
        self.assertEqual(pg.evaluate("() => __requests.length"), before)
        self.assertEqual(self.errors, [])

    # ── the blade, undo, keys ──

    def test_the_blade_cuts_where_clicked_and_undo_redo_walk_back_and_forth(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.keyboard.press("b")
        self.assertTrue(pg.evaluate("() => __panel._editTlBlade"))
        x, y = pg.evaluate(WHERE, [2.0, "V1"])
        pg.mouse.move(x, y)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.bladeLine.style.display"), "block")
        pg.mouse.click(x, y)
        self.assertEqual(self.cut(pg)["v1"][:2], [["D:/out/a.mp4", 0, 2.0], ["D:/out/a.mp4", 2.0, 2.0]])
        pg.keyboard.press("Control+z")
        self.assertEqual(len(self.cut(pg)["v1"]), 3)
        pg.keyboard.press("Control+Shift+z")
        self.assertEqual(len(self.cut(pg)["v1"]), 4)
        # Split at the playhead (Ctrl+B) and the deletes.
        pg.keyboard.press("Escape")
        self.assertFalse(pg.evaluate("() => __panel._editTlBlade"))
        pg.evaluate("() => __panel.setFrame(Math.round(8.5 * 24))")
        pg.keyboard.press("Control+b")
        self.assertEqual(len(self.cut(pg)["v1"]), 5)
        pg.keyboard.press("Shift+Delete")        # the second half, selected by the split, rippled out
        self.assertEqual(len(self.cut(pg)["v1"]), 4)
        # Arrows step frames, Up / Down jump to edit points, Home goes to the start.
        pg.keyboard.press("Home")
        pg.keyboard.press("ArrowDown")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 48)
        pg.keyboard.press("ArrowRight")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 49)
        pg.keyboard.press("i")
        self.assertEqual(pg.evaluate("() => __panel.playbackRange.start"), 49)
        self.assertEqual(self.errors, [])

    def test_keys_do_not_fire_while_typing_or_without_the_focus(self):
        pg = self.page()
        before = self.cut(pg)
        # The focus elsewhere (the page itself): B is not the blade.
        pg.mouse.click(5, 5)
        pg.keyboard.press("b")
        self.assertFalse(pg.evaluate("() => __panel._editTlBlade"))
        # Typing in a field inside the panel: nothing happens to the cut.
        self.focus_timeline(pg)
        pg.evaluate("() => __panel.editTlAutoDialog()")
        pg.evaluate("() => { const t = __panel._editTlUi.dialog.querySelector('textarea'); t.focus(); }")
        pg.keyboard.type("b s")
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.dialog.querySelector('textarea').value"), "b s")
        pg.keyboard.press("Control+z")              # the field's own undo, not the cut's
        self.assertFalse(pg.evaluate("() => __panel._editTlBlade"))
        self.assertEqual(self.cut(pg), before)
        self.assertEqual(pg.evaluate("() => __panel._editTlHistory().future.length"), 0)
        self.assertEqual(self.errors, [])

    # ── auto edit ──

    def test_auto_edit_cuts_on_the_beat_of_the_music(self):
        pg = self.page()
        pg.evaluate("() => { __beats['D:/out/music.wav'] = { bpm: 120, beats: Array.from({ length: 40 }, (_, i) => 0.25 + i * 0.5), duration: 20 }; }")
        self.focus_timeline(pg)
        pg.evaluate("() => __panel.editTlAutoDialog()")
        dlg = "() => __panel._editTlUi.dialog"
        self.assertEqual(pg.evaluate(f"() => [...({dlg})().querySelectorAll('.edit-mode')].map(b => b.dataset.mode)"),
                         ["beat", "even", "rhythm", "best", "detect"])
        pg.evaluate(f"() => ({dlg})().querySelector('[data-go]').click()")
        pg.wait_for_function("() => /bpm/.test(__panel._editTlUi.dialog.querySelector('.edit-dialog-said').textContent)", timeout=5000)
        starts = pg.evaluate("() => { const c = __panel._editTlCut; let at = 0; return c.clips.map(x => { const s = at; at += x.length; return s; }); }")
        for s in starts[1:]:
            self.assertAlmostEqual((s - 0.25) / 0.5, round((s - 0.25) / 0.5), places=3)    # every cut on a beat
        self.assertAlmostEqual(starts[1], 0.75, places=3)            # a shot every 2 beats
        pg.evaluate(f"() => [...({dlg})().querySelectorAll('.edit-dialog-said button')].find(b => b.textContent === 'Undo').click()")
        self.assertEqual(self.cut(pg)["v1"][0][2], 4.0)
        self.assertEqual(self.errors, [])

    # ── scene cut detection ──

    def test_detect_cuts_marks_then_split_at_all_then_undo(self):
        pg = self.page()
        pg.evaluate("""() => { __cuts['D:/out/a.mp4'] = { fps: 24, duration: 4, cuts: [
            { t: 1.0, score: 0.3, ratio: 20, kind: 'cut' }, { t: 2.5, score: 0.45, ratio: 10, kind: 'dissolve' },
            { t: 3.0, score: 0.05, ratio: 4, kind: 'cut' } ] }; }""")
        pg.evaluate("() => { __panel._editTlSel = { kind: 'clip', i: 0 }; __panel.editTlDetectSelected(); }")
        pg.wait_for_function("() => __panel._editTlUi.rows.querySelectorAll('.edit-cutmark').length === 2", timeout=5000)
        # More sensitive: the soft one too.
        pg.evaluate("() => { const s = __panel._editTlUi.cutbar.querySelector('input[type=range]'); s.value = '1'; s.dispatchEvent(new Event('input')); }")
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelectorAll('.edit-cutmark').length"), 3)
        # One left out by a click on it.
        box = pg.evaluate("() => { const r = __panel._editTlUi.rows.querySelectorAll('.edit-cutmark')[2].getBoundingClientRect(); return [r.left + r.width / 2, r.top + 4]; }")
        pg.mouse.click(*box)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelectorAll('.edit-cutmark.off').length"), 1)
        pg.evaluate("() => [...__panel._editTlUi.cutbar.querySelectorAll('button')].find(b => b.textContent.startsWith('Split')).click()")
        self.assertEqual(self.cut(pg)["v1"][:3], [["D:/out/a.mp4", 0, 1.0], ["D:/out/a.mp4", 1.0, 1.5], ["D:/out/a.mp4", 2.5, 1.5]])
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.cutbar.style.display"), "none")
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(len(self.cut(pg)["v1"]), 3)
        self.assertEqual(self.errors, [])

    def test_detect_cuts_respects_the_trim(self):
        pg = self.page()
        pg.evaluate("""() => { __cuts['D:/out/b.mp4'] = { fps: 24, duration: 5, cuts: [
            { t: 0.5, score: 0.3, ratio: 20, kind: 'cut' }, { t: 3.0, score: 0.3, ratio: 20, kind: 'cut' } ] }; }""")
        pg.evaluate("() => __panel.editTlDetectCuts([{ kind: 'clip', i: 2 }])")
        pg.wait_for_function("() => __panel._editTlUi.rows.querySelectorAll('.edit-cutmark').length === 1", timeout=5000)
        # b shows 1..5 of its file from 7 s of the film: the cut at 3 s of the file is at 9 s; the one at 0.5 is trimmed off.
        left = pg.evaluate("() => parseFloat(__panel._editTlUi.rows.querySelector('.edit-cutmark').style.left)")
        self.assertAlmostEqual(left, 9 / 11 * 100, places=2)
        self.assertEqual(self.errors, [])

    # ── popped out ──

    def test_popped_out_strips_draw_and_the_keys_work(self):
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        pg.wait_for_function("() => __panel._emPending === 0 && __panel._emDrawn > 0", timeout=15000)
        a = pg.evaluate(PAINT, "V1:0")
        self.assertGreater(a[0], a[2] * a[3] * 0.2, "the strip is drawn in the popout's canvas")
        x, y = pg.evaluate(WHERE, [0.2, "V2"])
        win.mouse.click(x, y)
        win.keyboard.press("b")
        self.assertTrue(pg.evaluate("() => __panel._editTlBlade"))
        x, y = pg.evaluate(WHERE, [9.0, "V1"])
        win.mouse.click(x, y)
        self.assertEqual(len(self.cut(pg)["v1"]), 4)
        win.keyboard.press("Control+z")
        self.assertEqual(len(self.cut(pg)["v1"]), 3)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
