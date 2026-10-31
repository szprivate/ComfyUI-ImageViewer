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

    def test_zoom_keys_zoom_in_out_and_fit(self):
        pg = self.page()
        self.focus_timeline(pg)
        zoom = "() => __panel._editTlView.zoom"
        self.assertEqual(pg.evaluate(zoom), 1)
        pg.keyboard.press("Control+Equal")
        self.assertAlmostEqual(pg.evaluate(zoom), 1.5, places=3)
        pg.keyboard.press("Control+Equal")
        self.assertAlmostEqual(pg.evaluate(zoom), 2.25, places=3)
        pg.keyboard.press("Control+Minus")
        self.assertAlmostEqual(pg.evaluate(zoom), 1.5, places=3)
        pg.keyboard.press("Shift+Z")
        self.assertEqual(pg.evaluate(zoom), 1)
        pg.keyboard.press("Control+Minus")                 # never below the whole film
        self.assertEqual(pg.evaluate(zoom), 1)
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
        pg.evaluate("() => { __panel._emDrawn = 0; __panel.editTlRefresh(); }")
        pg.wait_for_function("() => __panel._emPending === 0 && __panel._emDrawn > 0", timeout=15000)
        pg.wait_for_function("(key) => { const b = __panel._editTlUi.rows.querySelector(`[data-key='${key}']`); return !!(b && b._emCanvas); }",
                             arg="V1:0", timeout=15000)
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


    # ── trimming like an editor: hover, roll, slip, slide, retime, loop ──

    def x_at(self, pg, t, track="V1", dx=0):
        x, y = pg.evaluate(WHERE, [t, track])
        return x + dx, y

    def tip(self, pg):
        return pg.evaluate("() => { const t = __panel._editTlUi.trimTip; return t && t.style.display !== 'none' ? t.innerText : ''; }")

    def test_hover_on_a_cut_shows_the_side_that_moves_and_its_timecode(self):
        pg = self.page()
        # Just left of the cut at 4 s: the outgoing shot's out.
        pg.mouse.move(*self.x_at(pg, 4.0, dx=-5))
        info = pg.evaluate("""() => { const ui = __panel._editTlUi; const b = ui.rows.querySelector("[data-key='V1:0']");
            return { cursor: b.style.cursor, side: ui.trimA.dataset.side, left: ui.trimA.style.left, shown: ui.trimA.style.display }; }""")
        self.assertIn("data:image/svg", info["cursor"])
        self.assertEqual((info["side"], info["shown"], info["left"]), ("end", "block", "0%"))
        self.assertIn("Out of a", self.tip(pg))
        self.assertIn("00:00:04:00", self.tip(pg))
        # Just right of it: the incoming shot's in.
        pg.mouse.move(*self.x_at(pg, 4.0, dx=5))
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.trimA.dataset.side"), "start")
        self.assertIn("In of c", self.tip(pg))
        # On it: a roll - both sides lit.
        pg.mouse.move(*self.x_at(pg, 4.0, dx=1))
        self.assertIn("Roll a | c", self.tip(pg))
        self.assertEqual(pg.evaluate("() => [__panel._editTlUi.trimA.style.display, __panel._editTlUi.trimB.style.display]"), ["block", "block"])
        # The middle of a clip: nothing lit; the pointer leaves: nothing shown.
        pg.mouse.move(*self.x_at(pg, 2.0))
        self.assertEqual(self.tip(pg), "")
        pg.mouse.move(5, 5)
        self.assertEqual(self.tip(pg), "")
        self.assertEqual(self.errors, [])

    def drag(self, pg, x0, y0, x1, y1, keys=(), check=None):
        for k in keys:
            pg.keyboard.down(k)
        pg.mouse.move(x0, y0)
        pg.mouse.down()
        pg.mouse.move((x0 + x1) / 2, y1, steps=3)
        pg.mouse.move(x1, y1, steps=3)
        got = pg.evaluate(check) if check else None
        pg.mouse.up()
        for k in reversed(keys):
            pg.keyboard.up(k)
        return got

    def px_per_second(self, pg):
        return pg.evaluate("() => __panel._editTlUi.area.getBoundingClientRect().width / __panel._editTlLay.total")

    def test_a_roll_moves_the_cut_and_keeps_the_film_length_one_undo_step(self):
        pg = self.page()
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 7.0, dx=1)                         # the cut between the still c and b (in 1 s)
        tip = self.drag(pg, x, y, x - 0.5 * pps, y, check="() => __panel._editTlUi.trimTip.innerText")
        self.assertIn("Roll c | b", tip)
        self.assertIn("\u221212f", tip)
        c = self.cut(pg)
        self.assertEqual(c["v1"], [["D:/out/a.mp4", 0, 4.0], ["D:/out/c.png", 0, 2.5], ["D:/out/b.mp4", 0.5, 4.5]])
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlLay.total"), 11.0, places=3)
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(self.cut(pg)["v1"][2], ["D:/out/b.mp4", 1.0, 4.0])
        # Held by the source: b has only 1 s before its in point.
        x, y = self.x_at(pg, 7.0, dx=1)
        self.drag(pg, x, y, x - 2.5 * pps, y)
        self.assertEqual(self.cut(pg)["v1"][2], ["D:/out/b.mp4", 0, 5.0])
        self.assertEqual(self.errors, [])

    def test_a_trim_stops_at_the_end_of_the_source(self):
        pg = self.page()
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 11.0, dx=-3)                      # b's out: 1 s in, 4 s long, a 5 s file
        self.drag(pg, x, y, x + 3 * pps, y)
        self.assertEqual(self.cut(pg)["v1"][2], ["D:/out/b.mp4", 1.0, 4.0])
        self.assertEqual(self.errors, [])

    def test_slip_by_alt_drag_and_by_the_comma_and_period_keys(self):
        pg = self.page()
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 9.0)
        seen = self.drag(pg, x, y, x + 0.5 * pps, y, keys=("Alt",),
                         check="() => [__panel._editTlUi.trimTip.innerText, __panel._editTlUi.slipBand.style.display]")
        self.assertIn("Slip b", seen[0])
        self.assertIn("src 00:00:00:12", seen[0])                # the source in shown while slipping
        self.assertEqual(seen[1], "block")                         # and where the source lies
        self.assertEqual(self.cut(pg)["v1"][2], ["D:/out/b.mp4", 0.5, 4.0])
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlLay.total"), 11.0, places=3)
        pg.keyboard.press("Period")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 0.5 + 1 / 24, places=3)
        pg.keyboard.press("Shift+Period")                          # a second: held at the end of the 5 s file
        self.assertEqual(self.cut(pg)["v1"][2], ["D:/out/b.mp4", 1.0, 4.0])
        pg.keyboard.press("Comma")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 1 - 1 / 24, places=3)
        for _ in range(4):
            pg.keyboard.press("Control+z")
        self.assertEqual(self.cut(pg)["v1"][2], ["D:/out/b.mp4", 1.0, 4.0], "one undo step each")
        # A still has nothing to slip.
        x, y = self.x_at(pg, 5.5)
        self.drag(pg, x, y, x + 40, y, keys=("Alt",))
        self.assertIn("still", pg.evaluate("() => __panel._editTlNote"))
        self.assertEqual(self.errors, [])

    def test_slide_on_v1_and_a_move_on_v2_keep_the_length(self):
        pg = self.page()
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 5.5)                                  # c, between a and b
        self.drag(pg, x, y, x + 0.5 * pps, y, keys=("Alt", "Shift"))
        self.assertEqual(self.cut(pg)["v1"], [["D:/out/a.mp4", 0, 4.0], ["D:/out/c.png", 0, 3.0], ["D:/out/b.mp4", 1.0, 4.0]],
                         "a has no more source: the slide is held")
        self.drag(pg, x, y, x - 0.5 * pps, y, keys=("Alt", "Shift"))
        self.assertEqual(self.cut(pg)["v1"], [["D:/out/a.mp4", 0, 3.5], ["D:/out/c.png", 0, 3.0], ["D:/out/b.mp4", 0.5, 4.5]])
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlLay.total"), 11.0, places=3)
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(self.cut(pg)["v1"][0], ["D:/out/a.mp4", 0, 4.0])
        # V2: a placed clip moves, its length kept.
        pg.evaluate("""() => { const P = __panel; P._editTlApply(P._editTlCut && { ...P._editTlCut, tracks: [{ ...P._editTlCut.tracks[0],
            clips: [{ file: 'D:/out/b.mp4', name: 'o', in: 1, length: 2, at: 1, color: '', volume: 1 }] }, P._editTlCut.tracks[1]] }); }""")
        x, y = self.x_at(pg, 2.0, "V2")
        self.drag(pg, x, y, x + 1.5 * pps, y)
        self.assertEqual(self.cut(pg)["tracks"]["V2"], [["D:/out/b.mp4", 2.5, 2.0]])
        self.assertEqual(self.errors, [])

    def test_retime_by_alt_on_an_edge_and_loop_by_ctrl_on_the_out_edge(self):
        pg = self.page()
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 4.0, dx=-5)
        tip = self.drag(pg, x, y, x + 2 * pps, y, keys=("Alt",), check="() => __panel._editTlUi.trimTip.innerText")
        self.assertIn("Retime a", tip)
        a = pg.evaluate("() => __panel._editTlCut.clips[0]")
        self.assertAlmostEqual(a["length"], 6.0, places=3)
        self.assertAlmostEqual(a["speed"], 4 / 6, places=3)
        self.assertEqual(a["in"], 0)
        self.assertIn("67 %", pg.evaluate("() => __panel._editTlUi.rows.querySelector(\"[data-key='V1:0'] .edit-badge-time\").textContent"))
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.press("Shift+R")
        self.assertEqual(self.cut(pg)["v1"][0], ["D:/out/a.mp4", 0, 4.0])
        # Ctrl+drag b's out-edge: past its source, looped.
        x, y = self.x_at(pg, 11.0, dx=-3)
        self.drag(pg, x, y, x + 2 * pps, y, keys=("Control",))
        b = pg.evaluate("() => __panel._editTlCut.clips[2]")
        self.assertEqual(b["loop"], "loop")
        self.assertAlmostEqual(b["span"], 4.0, places=3)
        self.assertGreater(b["length"], 5.5)
        pg.mouse.click(*self.x_at(pg, 9.0))
        pg.keyboard.press("Control+l")
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlCut.clips[2].length"), b["length"] + 4, places=3)
        self.assertIn("\u00d7", pg.evaluate("() => __panel._editTlUi.rows.querySelector(\"[data-key='V1:2'] .edit-badge-time\").textContent"))
        self.assertEqual(self.errors, [])

    def test_the_inspector_sets_start_source_in_and_speed_keeping_the_length(self):
        pg = self.page()
        pg.evaluate("""() => { const P = __panel; P._editTlApply({ ...P._editTlCut, tracks: [{ ...P._editTlCut.tracks[0],
            clips: [{ file: 'D:/out/b.mp4', name: 'o', in: 1, length: 2, at: 1, color: '', volume: 1 }] }, P._editTlCut.tracks[1]] });
            P._editTlSel = { kind: 'tclip', track: 'V2', i: 0 }; P._editInspTab = 'timing'; P.editTlRefresh(); }""")
        set_row = """([label, v]) => { const rows = [...__panel.editInspectorPanel.querySelectorAll('.insp-row')];
            const r = rows.find(r => r.querySelector('.insp-label').textContent === label); const i = r.querySelector('input');
            i.value = String(v); i.dispatchEvent(new Event('change')); }"""
        pg.evaluate(set_row, ["Start", 3])
        self.assertEqual(self.cut(pg)["tracks"]["V2"], [["D:/out/b.mp4", 3.0, 2.0]])
        pg.evaluate(set_row, ["Source in", 2.5])
        self.assertEqual(pg.evaluate("() => [__panel._editTlCut.tracks[0].clips[0].in, __panel._editTlCut.tracks[0].clips[0].length]"), [2.5, 2])
        pg.evaluate(set_row, ["Source in", 9])                     # held: 2 s used of a 5 s file
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].in"), 3)
        pg.evaluate(set_row, ["Speed %", 50])
        self.assertEqual(pg.evaluate("() => [__panel._editTlCut.tracks[0].clips[0].length, __panel._editTlCut.tracks[0].clips[0].speed]"), [4, 0.5])
        self.assertEqual(pg.evaluate("() => __panel._editTlHistory().past.length"), 5)    # the track clip, then one step each
        self.assertEqual(self.errors, [])

    # ── ganged playheads ──

    HEAD = "() => parseFloat(__panel._editTlUi.head.style.left)"

    def head_at(self, pg, frame):
        return (frame + 0.5) / 24 / pg.evaluate("() => __panel._editTlLay.total") * 100

    def test_the_two_playheads_are_one_position_both_ways(self):
        pg = self.page()
        # The viewer's bar scrubbed: the Edit panel's playhead follows.
        pg.evaluate("() => { const t = __panel.timeline; t.value = '100'; t.dispatchEvent(new Event('input')); }")
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 100), places=2)
        # The ruler clicked: the viewer's bar and its frame number follow.
        pg.mouse.click(*pg.evaluate("""() => { const r = __panel._editTlUi.ruler.getBoundingClientRect();
            return [r.left + r.width * 5 / __panel._editTlLay.total, r.top + 5]; }"""))
        self.assertEqual(pg.evaluate("() => [__panel.currentFrame, Number(__panel.timeline.value), __panel.container.querySelector('#cur-f').innerText]"),
                         [120, 120, "120"])
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 120), places=2)
        # Keys: a frame, an edit point, the end.
        self.focus_timeline(pg)
        pg.keyboard.press("ArrowRight")
        self.assertEqual(pg.evaluate("() => Number(__panel.timeline.value)"), 121)
        pg.keyboard.press("ArrowDown")
        self.assertEqual(pg.evaluate("() => Number(__panel.timeline.value)"), 168)
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 168), places=2)
        # The transport's step buttons (the viewer's own) - and zoomed in, the panel scrolls to keep its playhead in view.
        pg.evaluate("() => { __panel._editTlZoom(8); __panel._editTlUi.scroll.scrollLeft = 0; __panel.setFrame(250); }")
        vis = pg.evaluate("""() => { const s = __panel._editTlUi.scroll, h = __panel._editTlUi.head.getBoundingClientRect(), b = s.getBoundingClientRect();
            return h.left >= b.left && h.left <= b.right; }""")
        self.assertTrue(vis, "the playhead is scrolled into view")
        self.assertEqual(self.errors, [])

    def stills_cut(self, pg):
        pg.evaluate("""() => { const P = __panel; Object.assign(__media, { 'D:/out/s1.png': { still: true }, 'D:/out/s2.png': { still: true } });
            P._editTlApply({ ...P._editTlCut, sound: [], tracks: [], clips: [
              { file: 'D:/out/s1.png', name: 's1', in: 0, length: 2, transition: 0, color: '', volume: 1 },
              { file: 'D:/out/s2.png', name: 's2', in: 0, length: 2, transition: 0, color: '', volume: 1 }] }); P.setFrame(0); }""")

    def test_playing_moves_both_playheads_together_without_a_loop_back(self):
        pg = self.page()
        self.stills_cut(pg)
        got = pg.evaluate("""async () => {
            const P = __panel; let sets = 0, heads = 0;
            const set = P.setFrame.bind(P); P.setFrame = (f) => { sets += 1; return set(f); };
            const head = P._editTlPlayhead.bind(P); P._editTlPlayhead = () => { heads += 1; return head(); };
            const total = P._editTlLay.total, samples = [];
            P.play();
            const t0 = performance.now(); let gaps = [], last = t0;
            await new Promise((done) => { const tick = () => { const now = performance.now(); gaps.push(now - last); last = now;
                samples.push([P.currentFrame, Number(P.timeline.value), parseFloat(P._editTlUi.head.style.left)]);
                if (now - t0 < 1500) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
            P.stop();
            const frames = samples[samples.length - 1][0] - samples[0][0];
            gaps.sort((a, b) => a - b);
            return { sets, heads, frames, samples, total, ms: performance.now() - t0, p95: gaps[Math.floor(gaps.length * 0.95)] }; }""")
        for frame, bar, head in got["samples"]:
            self.assertEqual(frame, bar, "the viewer's bar is the frame")
            self.assertAlmostEqual(head, (frame + 0.5) / 24 / got["total"] * 100, places=2)
        self.assertGreater(got["frames"], 24)                      # it ran at about 24 fps for 1.5 s
        self.assertLessEqual(got["sets"], 1, "playing moves the frame itself: nothing sets it back")
        self.assertLessEqual(got["heads"], got["frames"] + 3, "the panel's playhead is drawn once a frame, no more")
        frames = [s[0] for s in got["samples"]]
        self.assertEqual(frames, sorted(frames), "never back: no feedback")
        print(f"\nplayback: {got['frames']} frames in {got['ms']:.0f} ms ({got['frames'] / got['ms'] * 1000:.1f} fps), "
              f"playhead drawn {got['heads']}x, p95 frame gap {got['p95']:.1f} ms", file=sys.stderr)
        self.assertEqual(self.errors, [])

    def test_moving_the_edit_playhead_from_another_tab_brings_the_cut_up(self):
        pg = self.page()
        key = pg.evaluate("() => __panel._editTlTab")
        pg.evaluate("""() => { const P = __panel; P.allTabs.tabZ = [{ path: 'D:/out/c.png', external: true, name: 'c.png' }];
            P.tabOrder.push('tabZ'); P.tabLabels.tabZ = 'Z'; P._rebuildTabBar(null); P.switchTab('tabZ'); }""")
        self.assertFalse(pg.evaluate("() => __panel.isPanelDocked('editTimeline')"), "the Edit panel goes with its tab")
        pg.evaluate("() => __panel._editTlSeek(2)")
        self.assertEqual(pg.evaluate("() => [__panel.activeTab, __panel.currentFrame]"), [key, 48])
        self.assertEqual(self.errors, [])

    # ── stills ──

    def test_stills_land_from_every_source_and_trim_longer_than_their_default(self):
        pg = self.page()
        # The desktop, onto V1.
        x, y = self.x_at(pg, 10.9)
        pg.evaluate(DROP, [x, y, [["shot.png", "image/png"]], ""])
        pg.wait_for_function("() => __panel._editTlCut.clips.length === 4", timeout=5000)
        self.assertEqual(self.cut(pg)["v1"][3], ["D:/in/edits/shot.png", 0, 3.0])
        payload = """async ([x, y, items]) => { const root = __panel._editTlUi.body.getRootNode(); const t = root.elementFromPoint(x, y);
            const dt = new DataTransfer(); dt.setData('application/x-bepic-history', JSON.stringify({ items }));
            t.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })); }"""
        # A History thumbnail (ComfyUI's output, named by filename).
        pg.evaluate(payload, [*self.x_at(pg, 1.0, "V2"), [{"filename": "hist.png", "type": "output", "subfolder": "", "kind": "image"}]])
        pg.wait_for_function("() => __panel._editTlCut.tracks[0].clips.length === 1", timeout=5000)
        # A row of the file browser (a path).
        pg.evaluate(payload, [*self.x_at(pg, 6.0, "V2"), [{"path": "D:/pics/browser.jpg", "filename": "browser.jpg", "kind": "image", "external": True}]])
        pg.wait_for_function("() => __panel._editTlCut.tracks[0].clips.length === 2", timeout=5000)
        # A node dragged off the canvas (a Load Image), let go over V2.
        pg.evaluate("""async () => { const { app } = await import('/scripts/app.js');
            const cv = document.createElement('canvas'); Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: '10px', height: '10px' });
            document.body.append(cv); app.canvas.canvas = cv;
            const node = { id: 7, type: 'LoadImage', title: 'Load Image', pos: [10, 10], widgets: [{ name: 'image', value: 'house.png', type: 'combo' }], inputs: [], outputs: [] };
            app.canvas.node_over = node; app.canvas.selected_nodes = {};
            __panel._editTlCanvasBound = false; __panel._editTlWatchCanvas(); }""")
        x, y = self.x_at(pg, 8.5, "V2")
        pg.evaluate("""([x, y]) => { const cv = document.querySelector('body > canvas');
            cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 3, clientY: 3 }));
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y })); }""", [x, y])
        pg.wait_for_function("() => __panel._editTlCut.tracks[0].clips.length === 3", timeout=5000)
        v2 = self.cut(pg)["tracks"]["V2"]
        self.assertEqual(sorted(v2), sorted([["D:/out/hist.png", 1.0, 3.0], ["D:/pics/browser.jpg", 6.0, 3.0], ["D:/in/house.png", 8.5, 3.0]]))
        # Longer than the 3 s default: its out-edge pulled, then its in-edge (a still has no source to run out of).
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 4.0, "V2", dx=-3)
        self.drag(pg, x, y, x + 1.5 * pps, y)
        x, y = self.x_at(pg, 1.0, "V2", dx=3)
        self.drag(pg, x, y, x - 1.0 * pps, y)
        hist = [c for c in self.cut(pg)["tracks"]["V2"] if c[0].endswith("hist.png")][0]
        self.assertEqual(hist, ["D:/out/hist.png", 0.0, 5.5])       # 1..4, out to 5.5, in back to 0
        # The still dropped at the end of V1 (11..14), its out-edge pulled.
        x, y = self.x_at(pg, pg.evaluate("() => __panel._editTlLay.total") - 0.001, "V1", dx=-3)
        self.drag(pg, x, y, x + 60, y)
        self.assertGreater(self.cut(pg)["v1"][3][2], 3.5)
        self.assertEqual(self.errors, [])

    # ── in and out ──

    def range(self, pg):
        return pg.evaluate("() => __panel.playbackRange && [__panel.playbackRange.start, __panel.playbackRange.end]")

    def test_in_and_out_marked_dragged_cleared_and_shown_on_both_bars(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.evaluate("() => __panel.setFrame(24)")
        pg.keyboard.press("i")
        pg.evaluate("() => __panel.setFrame(200)")
        pg.keyboard.press("o")
        self.assertEqual(self.range(pg), [24, 200])
        marks = pg.evaluate("""() => { const ui = __panel._editTlUi; return [ui.markIn.style.display, ui.markOut.style.display,
            parseFloat(ui.markIn.style.left), parseFloat(ui.markOut.style.left), __panel.container.querySelector('#timeline-range').style.display]; }""")
        self.assertEqual(marks[0:2], ["block", "block"])
        self.assertAlmostEqual(marks[2], 1 / 11 * 100, places=2)
        self.assertAlmostEqual(marks[3], 201 / 24 / 11 * 100, places=2)
        self.assertEqual(marks[4], "block", "the viewer's own bar shows it too")
        # The in handle dragged near the cut at 4 s: it snaps onto it.
        hx, hy = pg.evaluate("() => { const r = __panel._editTlUi.markIn.getBoundingClientRect(); return [r.left + 3, r.top + 6]; }")
        tx, _ = self.x_at(pg, 4.04)
        self.drag(pg, hx, hy, tx, hy)
        self.assertEqual(self.range(pg), [96, 200])
        # Ctrl+drag on the ruler: a new range.
        rx = pg.evaluate("() => __panel._editTlUi.ruler.getBoundingClientRect().top + 5")
        x0, _ = self.x_at(pg, 2.02)
        x1, _ = self.x_at(pg, 3.02)
        self.drag(pg, x0, rx, x1, rx, keys=("Control",))
        self.assertEqual(self.range(pg), [48, 72])
        # Right-click: set the out here.
        x2, _ = self.x_at(pg, 6.02)
        pg.mouse.click(x2, rx, button="right")
        pg.evaluate("() => [...__panel.container.querySelectorAll('.previz-menu-item')].find(b => b.textContent === 'Set out here').click()")
        self.assertEqual(self.range(pg), [48, 144])
        # X: the selected clip's range; Alt+X clears it.
        pg.mouse.click(*self.x_at(pg, 9.0))
        pg.keyboard.press("x")
        self.assertEqual(self.range(pg), [168, 263])
        pg.keyboard.press("Shift+i")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 168)
        # The viewer's bar Ctrl-dragged: the ruler follows.
        box = pg.evaluate("() => { const r = __panel.container.querySelector('#timeline-container').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
        self.drag(pg, box[0] + box[2] * 0.1, box[1] + box[3] / 2, box[0] + box[2] * 0.3, box[1] + box[3] / 2, keys=("Control",))
        r = self.range(pg)
        self.assertLess(abs(r[0] - round(0.1 * 263)), 3)
        self.assertAlmostEqual(pg.evaluate("() => parseFloat(__panel._editTlUi.markIn.style.left)"), r[0] / 24 / 11 * 100, places=2)
        # Kept with the cut across a tab switch (which clears the transport's range).
        key = pg.evaluate("() => __panel._editTlTab")
        pg.evaluate("""(key) => { const P = __panel; P.allTabs.tabZ = [{ path: 'D:/out/c.png', external: true, name: 'c.png' }];
            P.tabOrder.push('tabZ'); P.tabLabels.tabZ = 'Z'; P.switchTab('tabZ'); P.switchTab(key); }""", key)
        self.assertEqual(self.range(pg), r)
        self.focus_timeline(pg)
        pg.keyboard.press("Alt+x")
        self.assertIsNone(self.range(pg))
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.markIn.style.display"), "none")
        self.assertEqual(self.errors, [])

    def test_the_range_loops_playback_and_is_what_export_renders(self):
        pg = self.page()
        self.stills_cut(pg)
        pg.evaluate("() => { __panel.loopMode = 'loop'; __panel._editTlSetRange({ start: 30, end: 40 }); }")
        frames = pg.evaluate("""async () => { const P = __panel, seen = []; P.play();
            await new Promise((done) => { const t0 = performance.now(); const tick = () => { seen.push(P.currentFrame);
                if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
            P.stop(); return seen; }""")
        self.assertTrue(all(30 <= f <= 40 for f in frames), frames)
        self.assertIn(30, frames[3:], "it went round")
        # Export film: "in-out only" is offered and sent as the frames to render.
        pg.evaluate("() => { const P = __panel; P._editTlSaved = P._editTlCut; P._editTlTarget = { path: 'D:/out/cut.otio' }; P._editTlRender(); }")
        pg.wait_for_function("() => !!__panel.container.querySelector('.export-dlg [data-field=range]')", timeout=5000)
        self.assertEqual(pg.evaluate("() => __panel.container.querySelector('.export-dlg [data-field=range]').value"), "range")
        pg.evaluate("() => __panel.container.querySelector('.export-dlg .rd-go').click()")
        pg.wait_for_function("() => !!window.__rendered", timeout=5000)
        self.assertEqual(pg.evaluate("() => window.__rendered.frames"), [30, 40])
        self.assertEqual(self.errors, [])

    def test_detect_cuts_and_auto_edit_keep_to_the_range(self):
        pg = self.page()
        pg.evaluate("""() => { __cuts['D:/out/a.mp4'] = { fps: 24, duration: 4, cuts: [
            { t: 1.0, score: 0.3, ratio: 20, kind: 'cut' }, { t: 3.0, score: 0.3, ratio: 20, kind: 'cut' } ] };
            __panel._editTlSetRange({ start: 48, end: 95 }); __panel._editTlSel = null; __panel.editTlDetectSelected(); }""")
        pg.wait_for_function("() => __panel._editTlMarks", timeout=5000)
        pg.wait_for_function("() => __panel._editTlUi.rows.querySelectorAll('.edit-cutmark').length === 1", timeout=5000)
        pg.evaluate("() => __panel.editTlMarksCancel()")
        pg.evaluate("() => __panel.editTlAutoDialog()")
        self.assertEqual(pg.evaluate("""() => [...__panel._editTlUi.dialog.querySelectorAll('select')]
            .find(s => [...s.options].some(o => o.value === 'range')).value"""), "range")
        self.assertEqual(self.errors, [])

    # ── popped out ──

    def test_popped_out_hover_slip_keys_marks_and_the_ganged_playhead(self):
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        win.mouse.move(*pg.evaluate(WHERE, [4.0, "V1"]))
        win.mouse.move(*self.x_at(pg, 4.0, dx=-5))
        self.assertIn("Out of a", self.tip(pg))
        win.mouse.click(*self.x_at(pg, 9.0))
        win.keyboard.press("Period")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 1.0, places=3, msg="held at the 5 s file's end")
        win.keyboard.press("Comma")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 1 - 1 / 24, places=3)
        pg.evaluate("() => __panel.setFrame(60)")
        win.keyboard.press("i")
        self.assertEqual(self.range(pg), [60, 263])
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 60), places=2)
        pg.evaluate("() => { const t = __panel.timeline; t.value = '150'; t.dispatchEvent(new Event('input')); }")
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 150), places=2)
        self.assertEqual(self.errors, [])

if __name__ == "__main__":
    unittest.main()
