"""The Edit panel in a real browser: drops, filmstrips and waveforms, the blade, undo, keys, Auto edit, cut detection,
the Selection / Trim Edit modes, gaps on V1, picture and sound unlinked, snapping.

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
        pg.on("pageerror", lambda e: self.errors.append(str(e)) or sys.stderr.write("PAGEERR " + str(getattr(e, "stack", "")) + chr(10)))
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
        pg.keyboard.press("Control+Minus")                 # past the whole film: empty timeline after it
        self.assertAlmostEqual(pg.evaluate(zoom), 1 / 1.5, places=3)
        for _ in range(6):
            pg.keyboard.press("Control+Minus")
        self.assertEqual(pg.evaluate(zoom), 0.25)
        pg.keyboard.press("Shift+Z")
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
        pg.keyboard.press("Alt+Period")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 0.5 + 1 / 24, places=3)
        pg.keyboard.press("Alt+Shift+Period")                      # a second: held at the end of the 5 s file
        self.assertEqual(self.cut(pg)["v1"][2], ["D:/out/b.mp4", 1.0, 4.0])
        pg.keyboard.press("Alt+Comma")
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
        return frame / 24 / pg.evaluate("() => __panel._editTlLay.total") * 100

    def test_the_two_playheads_are_one_position_both_ways(self):
        pg = self.page()
        # The viewer's bar scrubbed: the Edit panel's playhead follows.
        pg.evaluate("() => { const t = __panel.timeline; t.value = '100'; t.dispatchEvent(new Event('input')); }")
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 100), places=2)
        # The ruler clicked: the viewer's bar and its frame number follow.
        pg.mouse.click(*pg.evaluate("""() => { const r = __panel._editTlUi.ruler.getBoundingClientRect();
            return [r.left + r.width * (5 + 0.3 / 24) / __panel._editTlLay.total, r.top + 5]; }"""))      # inside frame 120 (pixels round)
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
            self.assertAlmostEqual(head, frame / 24 / got["total"] * 100, places=2)
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

    def test_an_in_handle_drag_survives_a_redraw_of_the_ruler(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.evaluate("() => __panel._editTlSetRange({ start: 24, end: 200 })")
        hx, hy = pg.evaluate("() => { const r = __panel._editTlUi.markIn.getBoundingClientRect(); return [r.left + 3, r.top + 6]; }")
        x1, _ = self.x_at(pg, 2.0)
        x2, _ = self.x_at(pg, 6.0)
        pg.mouse.move(hx, hy)
        pg.mouse.down()
        pg.mouse.move(x1, hy, steps=3)
        # The ruler is rebuilt under the pointer (a filmstrip lands, the cut is edited): the drag goes on.
        pg.evaluate("() => { __panel.editTlRefresh(); __panel._editTlUi.ruler.replaceChildren(); __panel.editTlRefresh(); }")
        pg.mouse.move(x2, hy, steps=3)
        pg.mouse.up()
        start = self.range(pg)[0]
        self.assertLess(abs(start - 6 * 24), 4, "the handle followed the pointer to the end of the drag")
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
        win.keyboard.press("Alt+Period")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 1.0, places=3, msg="held at the 5 s file's end")
        win.keyboard.press("Alt+Comma")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 1 - 1 / 24, places=3)
        pg.evaluate("() => __panel.setFrame(60)")
        win.keyboard.press("i")
        self.assertEqual(self.range(pg), [60, 263])
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 60), places=2)
        pg.evaluate("() => { const t = __panel.timeline; t.value = '150'; t.dispatchEvent(new Event('input')); }")
        self.assertAlmostEqual(pg.evaluate(self.HEAD), self.head_at(pg, 150), places=2)
        self.assertEqual(self.errors, [])

    # ── picture and sound apart, gaps on V1, the Trim Edit mode, snapping ──

    STARTS = "() => __panel._editTlLay.shots.map(s => Math.round(s.start * 1000) / 1000)"
    A2 = "() => __panel._editTlCut.tracks[1].clips.map(c => [c.file, Math.round(c.at*1000)/1000, Math.round(c.in*1000)/1000, Math.round(c.length*1000)/1000])"

    def steps(self, pg):
        return pg.evaluate("() => __panel._editTlHistory().past.length")

    def page_a2(self):
        """The page, the tracks scrolled down so that A2 is in view too (the panel is short)."""
        pg = self.page()
        pg.evaluate("() => { const m = __panel._editTlUi.secA; m.scrollTop = m.scrollHeight; }")
        return pg

    def test_unlink_by_the_menu_and_the_key_and_the_sound_moved_on_its_own(self):
        pg = self.page_a2()
        pg.wait_for_function("() => !!__panel._editTlUi.rows.querySelector(\"[data-key='V1:0'] .edit-badge-link:not(.off)\")", timeout=5000)
        pg.mouse.click(*self.x_at(pg, 2.0), button="right")
        pg.locator(".previz-menu-item", has_text="Unlink audio / video").first.click()
        self.assertEqual(pg.evaluate(self.A2), [["D:/out/a.mp4", 0, 0, 4.0]])
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.clips[0].mute === true"))
        self.assertTrue(pg.evaluate("() => !!__panel._editTlUi.rows.querySelector(\"[data-key='V1:0'] .edit-badge-link.off\")"))
        self.assertEqual(self.steps(pg), 1)
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(self.A2), [])
        # The key: Ctrl+Alt+L, the clip selected and the timeline focused.
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.press("Control+Alt+l")
        self.assertEqual(pg.evaluate(self.A2), [["D:/out/a.mp4", 0, 0, 4.0]])
        # The sound clip on its own: moved half a second on, its out pulled a second further - the picture stays.
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 2.0, "A2")
        self.drag(pg, x, y, x + 0.5 * pps, y)
        x, y = self.x_at(pg, 4.5, "A2", dx=-3)
        self.drag(pg, x, y, x - 1.0 * pps, y)
        self.assertEqual(pg.evaluate(self.A2), [["D:/out/a.mp4", 0.5, 0, 3.0]])
        self.assertEqual(self.cut(pg)["v1"][0], ["D:/out/a.mp4", 0, 4.0])
        self.assertEqual(pg.evaluate(self.STARTS), [0, 4, 7])
        # Deleted on its own: the picture stays, muted.
        pg.mouse.click(*self.x_at(pg, 2.0, "A2"))
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate(self.A2), [])
        self.assertEqual(len(self.cut(pg)["v1"]), 3)
        self.assertEqual(self.errors, [])

    def test_link_clips_again_and_the_pair_moves_together(self):
        pg = self.page_a2()
        pg.mouse.click(*self.x_at(pg, 2.0))
        self.focus_timeline(pg)
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.press("Control+Alt+l")
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 2.0, "A2")
        self.drag(pg, x, y, x + 0.5 * pps, y)                       # a J/L offset of half a second
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.down("Control")
        pg.mouse.click(*self.x_at(pg, 2.5, "A2"))
        pg.keyboard.up("Control")
        pg.mouse.click(*self.x_at(pg, 2.5, "A2"), button="right")
        pg.locator(".previz-menu-item", has_text="Link clips").first.click()
        self.assertTrue(pg.evaluate("() => { const c = __panel._editTlCut; return !!c.clips[0].link && !c.clips[0].unlinked && c.tracks[1].clips[0].link === c.clips[0].link; }"))
        # The picture moved on (over the still, leaving a gap): its sound goes with it, the offset kept.
        x, y = self.x_at(pg, 2.0)
        self.drag(pg, x, y, x + 1.0 * pps, y)
        self.assertEqual(pg.evaluate(self.A2), [["D:/out/a.mp4", 1.5, 0, 4.0]])
        self.assertEqual(pg.evaluate(self.STARTS)[0], 1.0)
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(self.A2), [["D:/out/a.mp4", 0.5, 0, 4.0]], "the move and its sound: one undo step")
        self.assertEqual(self.errors, [])

    def test_a_v1_clip_moved_to_v2_leaves_the_clips_after_it_in_place(self):
        pg = self.page()
        x, y = self.x_at(pg, 5.5)
        x2, y2 = self.x_at(pg, 5.5, "V2")
        self.drag(pg, x, y, x2, y2)
        self.assertEqual([v[0] for v in self.cut(pg)["v1"]], ["D:/out/a.mp4", "D:/out/b.mp4"])
        self.assertEqual(pg.evaluate(self.STARTS), [0, 7], "b stays at 7: a gap where c was")
        self.assertEqual(self.cut(pg)["tracks"]["V2"], [["D:/out/c.png", 4.0, 3.0]])
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlLay.total"), 11.0, places=3)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelectorAll('.edit-gap').length"), 1)
        # In the gap the viewport shows what V2 has there - and black with V2 switched off.
        shown = "() => { __panel.setFrame(132); const at = __panel._ep && __panel._ep.at; return at ? [at.key, !!at.clip] : null; }"
        self.assertEqual(pg.evaluate(shown), ["V2:0", True])
        pg.evaluate("() => { __panel._editTlView.solo = { V1: true }; __panel.editPlayLiveChanged(); __panel.setFrame(0); }")
        self.assertEqual(pg.evaluate(shown), ["", False])
        pg.evaluate("() => { __panel._editTlView.solo = {}; __panel.editPlayLiveChanged(); }")
        # The gap is selected by a click (off the playhead's line at 5.5 - a press within 4 px of it grabs the line); Del closes it.
        x, y = self.x_at(pg, 5.0)
        pg.mouse.click(x, y)
        self.assertEqual(pg.evaluate("() => __panel._editTlSel && __panel._editTlSel.kind"), "gap")
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate(self.STARTS), [0, 4])
        pg.evaluate("() => __panel.editTlUndo()")
        # Selection mode Del on a shot lifts it (a gap); Shift+Del ripples.
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate(self.STARTS), [7])
        pg.evaluate("() => __panel.editTlUndo()")
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.press("Shift+Delete")
        self.assertEqual(pg.evaluate(self.STARTS), [3])
        self.assertEqual(self.errors, [])

    def test_a_move_on_v1_overwrites_and_ctrl_shift_inserts(self):
        pg = self.page()
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 5.5)                                  # c (4..7) moved 2 s on: over b's start
        self.drag(pg, x, y, x + 2.0 * pps, y)
        self.assertEqual(self.cut(pg)["v1"], [["D:/out/a.mp4", 0, 4.0], ["D:/out/c.png", 0, 3.0], ["D:/out/b.mp4", 3.0, 2.0]])
        self.assertEqual(pg.evaluate(self.STARTS), [0, 6, 9])
        pg.evaluate("() => __panel.editTlUndo()")
        x, y = self.x_at(pg, 5.5)                                  # Ctrl+Shift: into the order after b
        self.drag(pg, x, y, x + 5.0 * pps, y, keys=("Control", "Shift"))
        self.assertEqual([v[0] for v in self.cut(pg)["v1"]], ["D:/out/a.mp4", "D:/out/b.mp4", "D:/out/c.png"])
        self.assertEqual(pg.evaluate(self.STARTS), [0, 4, 8])
        self.assertEqual(self.errors, [])

    def mode(self, pg):
        return pg.evaluate("""() => { const ui = __panel._editTlUi; return [ui.blade.classList.contains('on') ? 'blade' : ui.trimBtn.classList.contains('on') ? 'trim' : 'select', ui.pick.classList.contains('on'),
            ui.trimBtn.classList.contains('on'), ui.blade.classList.contains('on')]; }""")

    def test_the_modes_a_t_b_switch_by_key_and_by_button(self):
        pg = self.page()
        self.assertEqual(self.mode(pg), ["select", True, False, False])
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        self.assertEqual(self.mode(pg), ["trim", False, True, False])
        pg.keyboard.press("b")
        self.assertEqual(self.mode(pg), ["blade", False, False, True])
        pg.keyboard.press("Escape")                                # the blade away: back to the Trim mode it came from
        self.assertEqual(self.mode(pg), ["trim", False, True, False])
        pg.keyboard.press("b")
        pg.keyboard.press("a")                                     # A: Selection, the blade away
        self.assertEqual(self.mode(pg), ["select", True, False, False])
        pg.evaluate("() => __panel._editTlUi.trimBtn.click()")
        self.assertEqual(self.mode(pg), ["trim", False, True, False])
        pg.evaluate("() => __panel._editTlUi.pick.click()")
        self.assertEqual(self.mode(pg)[0], "select")
        # Not while typing: T, N, A, E, Ctrl+Alt+L go into the field.
        pg.evaluate("""() => { const i = document.createElement('input'); i.id = 'typing'; __panel._editTlUi.body.append(i); i.focus(); }""")
        pg.keyboard.type("tnae")
        pg.keyboard.press("Control+Alt+l")
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.body.querySelector('#typing').value"), "tnae")
        self.assertEqual(self.mode(pg)[0], "select")
        self.assertTrue(pg.evaluate("() => __panel._editTlView.snap"))
        self.assertEqual(pg.evaluate(self.A2), [])
        self.assertEqual(self.errors, [])

    def hover(self, pg, t, track="V1", dx=0, dy=0):
        x, y = self.x_at(pg, t, track, dx)
        pg.mouse.move(x, y + dy)
        return pg.evaluate("""() => { const b = [...__panel._editTlUi.rows.querySelectorAll('.edit-shot')].find(e => e.matches(':hover'));
            return [b ? b.style.cursor : '', __panel._editTlUi.trimTip && __panel._editTlUi.trimTip.style.display !== 'none' ? __panel._editTlUi.trimTip.innerText : '']; }""")

    def test_the_trim_mode_cursor_per_zone_and_each_trim(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        cursors = pg.evaluate("async () => (await import('/extensions/viewer/bEpicViewer_editTrim.js')).TRIM_CURSORS")
        h = pg.evaluate("() => __panel._editTlUi.rows.querySelector(\"[data-key='V1:0']\").getBoundingClientRect().height")
        out = self.hover(pg, 4.0, dx=-5)
        self.assertEqual(out[0], cursors["ripple-out"])
        self.assertIn("Ripple out of a", out[1])
        self.assertIn("00:00:04:00", out[1])
        rin = self.hover(pg, 4.0, dx=5)
        self.assertEqual(rin[0], cursors["ripple-in"])
        roll = self.hover(pg, 4.0, dx=1)
        self.assertEqual(roll[0], cursors["roll"])
        self.assertIn("Roll a | c", roll[1])
        slip = self.hover(pg, 9.0, dy=-h / 4)
        self.assertEqual(slip[0], cursors["slip"])
        self.assertIn("Slip b", slip[1])
        slide = self.hover(pg, 9.0, dy=h / 4)
        self.assertEqual(slide[0], cursors["slide"])
        self.assertIn("Slide b", slide[1])
        pps = self.px_per_second(pg)
        # Ripple: a's out half a second earlier, what follows moves up.
        x, y = self.x_at(pg, 4.0, dx=-5)
        tip = self.drag(pg, x, y, x - 0.5 * pps, y, check="() => __panel._editTlUi.trimTip.innerText")
        self.assertIn("Ripple out of a", tip)
        self.assertIn("\u221212f", tip)
        self.assertEqual(pg.evaluate(self.STARTS), [0, 3.5, 6.5])
        # Roll the cut between c and b (now at 6.5): the film keeps its length.
        x, y = self.x_at(pg, 6.5, dx=1)
        self.drag(pg, x, y, x - 0.25 * pps, y)
        self.assertEqual(pg.evaluate(self.STARTS), [0, 3.5, 6.25])
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlLay.total"), 10.5, places=3)
        # Slip b by its upper half; slide c by its lower half.
        x, y = self.x_at(pg, 8.5)
        self.drag(pg, x, y - h / 4, x + 0.25 * pps, y - h / 4)
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 0.5, places=3)
        self.assertEqual(pg.evaluate(self.STARTS), [0, 3.5, 6.25])
        x, y = self.x_at(pg, 5.0)
        self.drag(pg, x, y + h / 4, x - 0.25 * pps, y + h / 4)
        self.assertEqual(pg.evaluate(self.STARTS), [0, 3.25, 6.0])
        self.assertEqual(self.cut(pg)["v1"][0][2], 3.25)
        self.assertEqual(self.steps(pg), 4, "one undo step each")
        # A gap next to a ripple: V2's clip... a V1 clip moved off leaves a gap; a ripple of the clip before keeps it.
        pg.keyboard.press("a")
        x, y = self.x_at(pg, 4.5)
        x2, y2 = self.x_at(pg, 4.5, "V2")
        self.drag(pg, x, y, x2, y2)
        pg.keyboard.press("t")
        x, y = self.x_at(pg, 3.25, dx=-5)
        self.drag(pg, x, y, x + 0.25 * pps, y)
        self.assertEqual(pg.evaluate(self.STARTS), [0, 6.25], "the gap kept, moved on with the ripple")
        # Keys: click an edge to select the edit point; , / . nudge it a frame, E to the playhead.
        x, y = self.x_at(pg, 3.5, dx=-5)
        pg.mouse.click(x, y)
        self.assertTrue(pg.evaluate("() => !!__panel._editTlEditSel && __panel._editTlUi.editMark.style.display === 'block'"))
        pg.keyboard.press("Period")
        self.assertAlmostEqual(self.cut(pg)["v1"][0][2], 3.5 + 1 / 24, places=3)
        pg.keyboard.press("Shift+Comma")
        self.assertAlmostEqual(self.cut(pg)["v1"][0][2], 2.5 + 1 / 24, places=3)
        pg.evaluate("() => __panel.setFrame(72)")
        pg.keyboard.press("e")
        self.assertAlmostEqual(self.cut(pg)["v1"][0][2], 3.0, places=3)
        self.assertEqual(self.errors, [])

    # ── snapping ──

    def snap_line(self, pg):
        return pg.evaluate("() => { const l = __panel._editTlUi.snapLine; return l && l.style.display === 'block' ? l.dataset.kind : ''; }")

    def test_snapping_n_the_line_and_a_move_a_trim_and_the_blade_in_both_modes(self):
        pg = self.page()
        pps = self.px_per_second(pg)
        self.focus_timeline(pg)
        pg.evaluate("() => __panel.setFrame(72)")                 # the playhead at 3 s
        # A trim (Selection): a's out pulled to a hair after 3 s - it lands on the playhead; the line shows it.
        x, y = self.x_at(pg, 4.0, dx=-3)
        kind = self.drag(pg, x, y, x - 0.96 * pps, y, check="() => { const l = __panel._editTlUi.snapLine; return [l.style.display, l.dataset.kind, parseFloat(l.style.left)]; }")
        self.assertEqual(kind[0:2], ["block", "playhead"])
        self.assertAlmostEqual(kind[2], 3 / 11 * 100, places=2)
        self.assertEqual(self.cut(pg)["v1"][0], ["D:/out/a.mp4", 0, 3.0])
        self.assertEqual(self.snap_line(pg), "", "the line goes when the drag ends")
        pg.evaluate("() => __panel.editTlUndo()")
        # N: off - the same drag lands where it was let go (on a frame).
        pg.keyboard.press("n")
        self.assertFalse(pg.evaluate("() => __panel._editTlUi.snap.classList.contains('on')"))
        self.drag(pg, x, y, x - 0.96 * pps, y)
        self.assertNotEqual(self.cut(pg)["v1"][0][2], 3.0)
        pg.evaluate("() => __panel.editTlUndo()")
        # S held during the drag inverts it: snapped though it is off.
        pg.mouse.move(x, y)
        pg.mouse.down()
        pg.mouse.move(x - 0.5 * pps, y, steps=3)
        pg.keyboard.down("s")
        pg.mouse.move(x - 0.96 * pps, y, steps=3)
        pg.mouse.up()
        pg.keyboard.up("s")
        self.assertEqual(self.cut(pg)["v1"][0][2], 3.0)
        self.assertEqual(len(self.cut(pg)["v1"]), 3, "S held in a drag is not a split")
        pg.evaluate("() => __panel.editTlUndo()")
        pg.keyboard.press("n")
        # A move on V2 snaps its end to b's start at 7 (a clip edge on another track).
        pg.evaluate("""() => { const P = __panel; const c = P._editTlCut; P._editTlApply({ ...c, tracks: [{ ...c.tracks[0],
            clips: [{ file: 'D:/out/b.mp4', name: 'o', in: 1, length: 2, at: 1, color: '', volume: 1 }] }, c.tracks[1]] }); }""")
        x, y = self.x_at(pg, 2.0, "V2")
        got = self.drag(pg, x, y, x + 3.95 * pps, y, check="() => __panel._editTlUi.snapLine.dataset.kind")
        self.assertEqual(got, "clip")
        self.assertEqual(self.cut(pg)["tracks"]["V2"], [["D:/out/b.mp4", 5.0, 2.0]])
        # The blade: a click a hair off the playhead cuts on it; snapping off, where clicked.
        pg.keyboard.press("b")
        pg.mouse.click(*self.x_at(pg, 3.04))
        self.assertEqual(self.cut(pg)["v1"][0], ["D:/out/a.mp4", 0, 3.0])
        pg.evaluate("() => __panel.editTlUndo()")
        pg.keyboard.press("n")
        pg.mouse.click(*self.x_at(pg, 3.04))
        self.assertNotEqual(self.cut(pg)["v1"][0][2], 3.0)
        pg.evaluate("() => __panel.editTlUndo()")
        pg.keyboard.press("n")
        # The Trim mode: a ripple trim snaps its edit point too.
        pg.keyboard.press("t")
        x, y = self.x_at(pg, 4.0, dx=-5)
        self.drag(pg, x, y, x - 0.97 * pps, y)
        self.assertEqual(self.cut(pg)["v1"][0], ["D:/out/a.mp4", 0, 3.0])
        self.assertEqual(pg.evaluate(self.STARTS), [0, 3, 6])
        # Nudges by key ignore snapping: a frame is a frame.
        x, y = self.x_at(pg, 3.0, dx=-5)
        pg.mouse.click(x, y)
        pg.keyboard.press("Period")
        self.assertAlmostEqual(self.cut(pg)["v1"][0][2], 3 + 1 / 24, places=3)
        # The ruler scrub snaps the playhead to the cut at 6 (now).
        rx = self.x_at(pg, 6.03)[0]
        ry = pg.evaluate("() => { const r = __panel._editTlUi.ruler.getBoundingClientRect(); return r.top + r.height / 2; }")
        pg.mouse.click(rx, ry)
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), round((6 + 1 / 24) * 24))
        self.assertEqual(self.errors, [])

    def test_popped_out_trim_mode_unlink_and_snapping(self):
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        win.mouse.click(*self.x_at(pg, 2.0))
        win.keyboard.press("t")
        self.assertEqual(self.mode(pg)[0], "trim")
        win.mouse.move(*self.x_at(pg, 4.0, dx=-5))
        self.assertIn("Ripple out of a", self.tip(pg))
        win.keyboard.press("Control+Alt+l")
        self.assertEqual(pg.evaluate(self.A2), [["D:/out/a.mp4", 0, 0, 4.0]])
        win.keyboard.press("n")
        self.assertFalse(pg.evaluate("() => __panel._editTlView.snap"))
        pps = self.px_per_second(pg)
        x, y = self.x_at(pg, 4.0, dx=-5)
        win.mouse.move(x, y)
        win.mouse.down()
        win.mouse.move(x - 0.5 * pps, y, steps=4)
        win.mouse.up()
        self.assertEqual(pg.evaluate(self.STARTS), [0, 3.5, 6.5])
        win.keyboard.press("a")
        self.assertEqual(self.mode(pg)[0], "select")
        self.assertEqual(self.errors, [])

    # ── Resolve's way, the next round: zoom past the end, new tracks, several on any tracks, edit points, marquee ──

    FRAMES = """() => { const c = __panel._editTlCut; let t = 0; const v = c.clips.map(k => { t += (k.gap || 0) - (k.transition || 0); const s = t; t += k.length; return [k.name, Math.round(s * 24 * 100) / 100, Math.round((s + k.length) * 24 * 100) / 100]; });
        return { v1: v, tracks: Object.fromEntries(c.tracks.map(k => [k.id, k.clips.map(x => [x.name, Math.round(x.at * 24 * 100) / 100, Math.round((x.at + x.length) * 24 * 100) / 100])])) }; }"""
    SEL = "() => __panel._editTlSelAll().map(s => ({ clip: 'V1:' + s.i, tclip: s.track + ':' + s.i, text: 'T:' + s.i, sound: 'A1:' + s.i, gap: 'gap:' + s.i })[s.kind]).sort()"
    MARKS = "() => ['editMark', 'editMark2', 'editMark3', 'editMark4'].map(k => __panel._editTlUi[k]).filter(m => m && m.style.display === 'block').map(m => [m.dataset.side, parseFloat(m.style.left), m.style.getPropertyValue('--trim')])"

    def frames(self, pg):
        return pg.evaluate(self.FRAMES)

    @staticmethod
    def fit(pg):
        """Low rows, so that every track and the empty room below them are in the (short) panel."""
        pg.evaluate("""() => { const P = __panel; P._editTlView.heights = { V3: 14, V2: 14, V1: 14, A1: 14, A2: 14, A3: 14, T: 14 }; P.editTlRefresh(); P._editTlUi.secA.scrollTop = 0; }""")

    def on_v2(self, pg, *clips):
        pg.evaluate("""(clips) => { const P = __panel; const c = P._editTlCut; c.tracks[0].clips = clips.map(([name, at, length]) => ({ file: 'D:/out/b.mp4', name, in: 0, length, at, volume: 1, color: '' }));
            P._editTlApply({ ...c }); P._editTlHistories[P._editTlTab] = { past: [], future: [] }; }""", list(clips))

    def on_a2(self, pg, *clips):
        pg.evaluate("""(clips) => { const P = __panel; const c = P._editTlCut; c.tracks[1].clips = clips.map(([name, at, length]) => ({ file: 'D:/out/music.wav', name, in: 0, length, at, volume: 1, color: '' }));
            P._editTlApply({ ...c }); P._editTlHistories[P._editTlTab] = { past: [], future: [] }; }""", list(clips))
        self.fit(pg)

    def undo_len(self, pg):
        return pg.evaluate("() => __panel._editTlHistory().past.length")

    def test_01_zoom_out_past_the_end_moves_and_drops_there_and_fit_is_1x(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.evaluate("() => __panel._editTlZoom(0.25)")
        self.assertEqual(pg.evaluate("() => __panel._editTlLay.total"), 44)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.area.style.width"), "100%")
        # The film takes a quarter of the width; the ruler goes on.
        self.assertAlmostEqual(pg.evaluate("() => parseFloat(__panel._editTlUi.rows.querySelector('.edit-snd').style.width)"), 25, places=2)
        self.assertGreater(pg.evaluate("() => { const t = [...__panel._editTlUi.ruler.querySelectorAll('.edit-tick')]; return parseFloat(t[t.length - 1].style.left); }"), 90)
        # A click on the ruler past the end: the last frame, in step with the transport.
        pg.mouse.click(*pg.evaluate("""() => { const r = __panel._editTlUi.ruler.getBoundingClientRect(); return [r.left + r.width * 0.8, r.top + 5]; }"""))
        self.assertEqual(pg.evaluate("() => [__panel.currentFrame, Number(__panel.timeline.value)]"), [263, 263])
        # A clip dragged there, on V1: there, a gap before it. The scale kept (not Fit).
        x, y = pg.evaluate(WHERE, [9.0, "V1"])
        tx = pg.evaluate(WHERE, [30.0, "V1"])[0]
        pps = tx - pg.evaluate(WHERE, [29.0, "V1"])[0]
        self.drag(pg, x, y, tx, y)
        got = self.frames(pg)["v1"]
        self.assertEqual(got[2][0], "b")
        self.assertAlmostEqual(got[2][1], 28 * 24, delta=24 / pps + 1)                    # grabbed 2 s into it
        self.assertAlmostEqual(tx - pg.evaluate(WHERE, [29.0, "V1"])[0], pps, places=3, msg="seconds per pixel kept")
        pg.keyboard.press("Control+z")
        # A drop on V1 past the end: placed there.
        x, y = pg.evaluate(WHERE, [20.0, "V1"])
        pg.evaluate(DROP, [x, y, [["film.mp4", "video/mp4"]], ""])
        pg.wait_for_function("() => __panel._editTlCut.clips.length === 4", timeout=5000)
        self.assertAlmostEqual(self.frames(pg)["v1"][3][1], 20 * 24, delta=2)
        pg.keyboard.press("Shift+Z")
        self.assertEqual(pg.evaluate("() => __panel._editTlView.zoom"), 1)
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlLay.total - __panel._editTlLay.film"), 0, places=3)
        self.assertEqual(self.errors, [])

    def test_01_zoomed_out_in_the_trim_mode_a_ripple_keeps_its_scale(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        pg.evaluate("() => __panel._editTlZoom(0.5)")
        pps = pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0]
        x, y = self.x_at(pg, 4.0, dx=-5)
        self.drag(pg, x, y, x - 0.5 * pps, y)
        self.assertEqual(self.frames(pg)["v1"][0][2], 84)
        self.assertAlmostEqual(pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0], pps, places=2)
        self.assertEqual(self.errors, [])

    def test_02_dragging_into_the_empty_room_makes_a_track_one_undo_step(self):
        pg = self.page()
        self.on_a2(pg, ["s", 2, 2])
        before = self.undo_len(pg)
        room = "(k) => { const r = __panel._editTlUi.rows.querySelector(`.edit-room[data-room=\"${k}\"]`).getBoundingClientRect(); return r.top + r.height / 2; }"
        # A picture up: the room lit while it hovers, the new track on the drop, in Selection and in Trim mode (Ctrl+drag free).
        x, y = pg.evaluate(WHERE, [5.5, "V1"])
        lit = self.drag(pg, x, y, x + 20, pg.evaluate(room, "video"),
                        check="() => [__panel._editTlUi.rows.querySelector('.edit-room.landing')?.dataset.label, __panel._editTlUi.ghost.style.display, __panel._editTlCut.tracks.length]")
        self.assertEqual(lit, ["+ V3", "block", 2], "a preview; no track until it is let go")
        c = self.cut(pg)
        self.assertEqual(sorted(c["tracks"]), ["A2", "V2", "V3"])
        self.assertEqual(c["tracks"]["V3"][0][0], "D:/out/c.png")
        self.assertEqual(len(c["v1"]), 2)
        self.assertEqual(self.undo_len(pg), before + 1)
        self.assertEqual(pg.evaluate("() => [...__panel._editTlUi.rows.querySelectorAll('.edit-track')].map(r => r.dataset.track)"), ["V3", "V2", "V1", "A1", "A2"])
        # A sound down, below the bottom row.
        x, y = pg.evaluate(WHERE, [3.0, "A2"])
        self.drag(pg, x, y, x + 10, pg.evaluate(room, "audio"))
        c = self.cut(pg)
        self.assertEqual(c["tracks"]["A3"][0][0], "D:/out/music.wav")
        self.assertEqual(c["tracks"]["A2"], [])
        self.assertEqual(self.undo_len(pg), before + 2)
        # Undo: both, one each.
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertNotIn("A3", self.cut(pg)["tracks"])
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertNotIn("V3", self.cut(pg)["tracks"])
        # A picture does not make a sound track, nor a sound a video track.
        x, y = pg.evaluate(WHERE, [5.5, "V1"])
        self.drag(pg, x, y, x, pg.evaluate(room, "audio"))
        self.assertNotIn("A3", self.cut(pg)["tracks"])
        # The headers stay in line with the rows, the room counted in.
        # (Two sections now, each with its headers beside it: every row against the header of its own.)
        rows = pg.evaluate("""() => { const P = __panel, ui = P._editTlUi; const t = [...ui.rows.querySelectorAll('.edit-track, .edit-room')].map(r => r.getBoundingClientRect().top);
            const h = [...ui.heads.querySelectorAll('.edit-headrow')].map(r => r.getBoundingClientRect().top); return [t, h]; }""")
        self.assertEqual(len(rows[0]), len(rows[1]))
        for a, b in zip(*rows):
            self.assertAlmostEqual(a, b, delta=1)
        # The Trim mode: a body press slips, so Ctrl+Shift takes the clip; into the room it is a new track too.
        n = self.undo_len(pg)
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        x, y = pg.evaluate(WHERE, [1.0, "V1"])
        self.drag(pg, x, y, x + 10, pg.evaluate(room, "video"), keys=("Control", "Shift"))
        self.assertIn("V3", self.cut(pg)["tracks"])
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual(self.errors, [])

    def test_02_a_drop_from_outside_into_the_room_makes_a_track_one_undo_step(self):
        pg = self.page()
        self.fit(pg)
        room = "(k) => { const r = __panel._editTlUi.rows.querySelector(`.edit-room[data-room=\"${k}\"]`).getBoundingClientRect(); return r.top + r.height / 2; }"
        before = self.undo_len(pg)
        x = pg.evaluate(WHERE, [5.0, "V1"])[0]
        mark = pg.evaluate(DROP, [x, pg.evaluate(room, "video"), [["shot.png", "image/png"]], ""])
        self.assertEqual(mark["line"], "block")
        pg.wait_for_function("() => __panel._editTlCut.tracks.length === 3", timeout=5000)
        self.assertEqual(self.cut(pg)["tracks"]["V3"], [["D:/in/edits/shot.png", 5.0, 3.0]])
        self.assertEqual(self.undo_len(pg), before + 1)
        pg.evaluate(DROP, [x, pg.evaluate(room, "audio"), [["song.wav", "audio/wav"]], ""])
        pg.wait_for_function("() => __panel._editTlCut.tracks.length === 4", timeout=5000)
        self.assertEqual(self.cut(pg)["tracks"]["A3"], [["D:/in/edits/song.wav", 5.0, 6.0]])
        self.assertEqual(self.undo_len(pg), before + 2)
        self.assertEqual(self.errors, [])

    def test_03_the_trim_cursors_are_15_px_and_sharp_and_the_lit_side_thinner(self):
        pg = self.page()
        for zone, dx in (("end", -5), ("roll", -1)):
            x, y = self.x_at(pg, 4.0, dx=dx)
            pg.mouse.move(x, y)
            cur = pg.evaluate("([x, y]) => { const e = __panel._editTlUi.body.getRootNode().elementFromPoint(x, y); return decodeURIComponent(e.closest('.edit-shot').style.cursor); }", [x, y])
            self.assertIn("width='15' height='15'", cur, zone)
            self.assertIn(") 7 7,", cur, zone)
        width = pg.evaluate("() => getComputedStyle(__panel._editTlUi.trimA).borderRightWidth")
        self.assertEqual(width, "2px")
        # The Trim mode's own: ripple, and slip and slide on the body.
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        for what, x, y in (("ripple", *self.x_at(pg, 4.0, dx=-5)), ("body", *self.x_at(pg, 2.0))):
            pg.mouse.move(x, y)
            cur = pg.evaluate("([x, y]) => { const e = __panel._editTlUi.body.getRootNode().elementFromPoint(x, y); return decodeURIComponent(e.closest('.edit-shot').style.cursor); }", [x, y])
            self.assertIn("width='15' height='15'", cur, what)
        self.assertEqual(self.errors, [])

    def test_04_several_selected_across_video_sound_the_bed_a_text(self):
        for mode in ("a", "t"):
            pg = self.page()
            self.on_v2(pg, ["v", 1, 1])
            self.on_a2(pg, ["s", 5, 2])
            pg.evaluate("() => { const P = __panel; P._editTlApply({ ...P._editTlCut, texts: [{ text: 'hi', start: 8, length: 2 }] }); }")
            self.focus_timeline(pg)
            pg.keyboard.press(mode)
            pg.mouse.click(*pg.evaluate(WHERE, [2.0, "V1"]))
            pg.keyboard.down("Control")
            pg.mouse.click(*pg.evaluate(WHERE, [6.0, "A2"]))
            pg.mouse.click(*pg.evaluate(WHERE, [1.5, "V2"]))
            pg.mouse.click(*pg.evaluate(WHERE, [3.0, "A1"]))
            pg.mouse.click(*pg.evaluate(WHERE, [9.0, "T"]))
            pg.keyboard.up("Control")
            self.assertEqual(pg.evaluate(self.SEL), ["A1:0", "A2:0", "T:0", "V1:0", "V2:0"])
            for key in ("V1:0", "A2:0", "V2:0"):
                self.assertTrue(pg.evaluate("(k) => [...__panel._editTlUi.rows.querySelectorAll('[data-key]')].find(b => b.dataset.key === k).classList.contains('msel')", key), key)
            self.assertTrue(pg.evaluate("() => __panel._editTlUi.rows.querySelector('.edit-snd').classList.contains('msel')"))
            # Ctrl+click takes one out; Shift+click on another track adds, keeping the rest.
            pg.keyboard.down("Control")
            pg.mouse.click(*pg.evaluate(WHERE, [3.0, "A1"]))
            pg.keyboard.up("Control")
            self.assertEqual(pg.evaluate(self.SEL), ["A2:0", "T:0", "V1:0", "V2:0"])
            pg.keyboard.down("Shift")
            pg.mouse.click(*pg.evaluate(WHERE, [5.0, "V1"]))
            pg.keyboard.up("Shift")
            self.assertIn("V1:1", pg.evaluate(self.SEL))
            self.assertIn("A2:0", pg.evaluate(self.SEL))
            # agentY reads the clips.
            self.assertEqual(self.errors, [])
            pg.close()

    def test_05_clicking_a_cut_marks_it_green_and_comma_period_trim_per_side_in_selection(self):
        pg = self.page()
        self.focus_timeline(pg)
        f = 1 / 24
        # The outgoing edge: no ripple, a gap opens.
        pg.mouse.click(*self.x_at(pg, 4.0, dx=-5))
        marks = pg.evaluate(self.MARKS)
        self.assertEqual([m[0] for m in marks], ["end"])
        self.assertEqual(marks[0][2], "#35e06f")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 96, "the playhead goes to the edit")
        pg.keyboard.press("Comma")
        self.assertEqual(self.frames(pg)["v1"][0][2], 95)
        self.assertEqual(self.frames(pg)["v1"][1][1], 96, "the next clip stays")
        pg.keyboard.press("Period")
        self.assertEqual(self.frames(pg)["v1"][0][2], 96, "and it closes")
        pg.keyboard.press("Period")
        self.assertEqual(self.frames(pg)["v1"][0][2], 96, "not into the clip after it")
        self.assertIn("held", pg.evaluate("() => __panel._editTlNote"))
        # The incoming edge.
        pg.mouse.click(*self.x_at(pg, 7.0, dx=5))
        self.assertEqual([m[0] for m in pg.evaluate(self.MARKS)], ["start"])
        pg.keyboard.press("Period")
        self.assertEqual(self.frames(pg)["v1"][2][1:], [169, 264], "its start later, its end where it was")
        pg.keyboard.press("Comma")
        # The centre: a roll, both edges green, the film's length kept.
        pg.mouse.click(*self.x_at(pg, 7.0, dx=0))
        self.assertEqual(sorted(m[0] for m in pg.evaluate(self.MARKS)), ["end", "start"])
        pg.keyboard.press("Shift+Comma")
        got = self.frames(pg)["v1"]
        self.assertEqual(got[1][2], 144)
        self.assertEqual(got[2][1:], [144, 264])
        self.assertEqual(self.undo_len(pg), 5, "each press one step")
        # Esc lets go of the edit point; the keys then move the clip.
        pg.keyboard.press("Escape")
        self.assertEqual(pg.evaluate(self.MARKS), [])
        self.assertEqual(self.errors, [])

    def test_05_comma_period_ripple_in_the_trim_mode_and_a_cut_on_a_higher_track(self):
        pg = self.page()
        self.on_v2(pg, ["v", 1, 1], ["w", 2, 1], ["x", 5, 1])
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        pg.mouse.click(*self.x_at(pg, 4.0, dx=-5))
        self.assertEqual([m[0] for m in pg.evaluate(self.MARKS)], ["end"])
        pg.keyboard.press("Comma")
        got = self.frames(pg)["v1"]
        self.assertEqual(got[0][2], 95)
        self.assertEqual(got[1][1], 95, "what follows moves")
        self.assertEqual(got[2][2], 263)
        # An edge of V2's clip: its track ripples, V1 stays.
        pg.mouse.click(*self.x_at(pg, 3.0, "V2", dx=-5))
        pg.keyboard.press("Shift+Comma")
        v2 = self.frames(pg)["tracks"]["V2"]
        self.assertEqual(v2[0], ["v", 24, 48])
        self.assertLess(v2[2][1], 120)
        # A mode switch keeps it, and it now only trims.
        pg.keyboard.press("a")
        self.assertTrue(pg.evaluate("() => !!__panel._editTlEditPoint()"))
        self.assertEqual(self.errors, [])

    def test_06_snaps_land_on_the_exact_frame_by_real_drags_at_several_zooms_and_scrolls(self):
        for zoom in (0.25, 0.5, 1, 4, 16):
            for scroll in ((0, 900) if zoom > 1 else (0,)):
                pg = self.page(zoom=zoom)
                self.on_v2(pg, ["v", 8.5, 1], ["off", 5, 1.02], ["u", 1.5, 1.5])  # off: no whole number of frames long
                # Everything is said by pixels the page reports now, so a scroll is just where the timeline is.
                def to(t):
                    pg.evaluate("""([t, s]) => { const P = __panel, sc = P._editTlUi.scroll; sc.scrollLeft = Math.max(0, t / P._editTlLay.total * sc.scrollWidth - sc.clientWidth / 2 + s / 10); }""", [t, scroll])
                pps = lambda: pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0]
                near = min(6, 4)                                                 # within SNAP_PX (9), off by a few pixels
                msg = f"zoom {zoom} scroll {scroll}"
                line = """() => { const P = __panel, l = P._editTlUi.snapLine; return l && l.style.display === 'block' ? parseFloat(l.style.left) / 100 * P._editTlLay.total * 24 : null; }"""

                # A move by its END, with that off-grid length: the end lands on b's start (frame 168).
                to(5.5)
                x, y = pg.evaluate(WHERE, [5.5, "V2"])
                seen = self.drag(pg, x, y, x + (7 - 6.02) * pps() + near, y, check=line)
                got = pg.evaluate("() => { const c = __panel._editTlCut.tracks[0].clips[1]; return (c.at + c.length) * 24; }")
                self.assertAlmostEqual(got, 168, places=1, msg=msg + " move by the end")
                self.assertAlmostEqual(seen, 168, places=3, msg=msg + " the line stands where it lands")
                pg.evaluate("() => __panel.editTlUndo()")

                # A trim of the LAST clip's out, the film's length changing under the drag, onto v's end at 9.5 (frame 228).
                to(10.9)
                x, y = self.x_at(pg, 11.0, dx=-4)
                seen = self.drag(pg, x, y, x - 1.5 * pps() - near, y, check=line)
                self.assertEqual(self.frames(pg)["v1"][2][2], 228, msg + " trim out, the last clip")
                self.assertAlmostEqual(seen, 228, places=3, msg=msg + " its line")
                pg.evaluate("() => __panel.editTlUndo()")

                # A move of the last clip to the right, the film growing: its start onto v's end at 9.5, the pointer's offset kept.
                pg.evaluate("() => __panel.editTlRefresh()")
                to(8)
                x, y = pg.evaluate(WHERE, [8.0, "V1"])
                seen = self.drag(pg, x, y, x + 2.5 * pps() + near, y, check=line)
                self.assertEqual(self.frames(pg)["v1"][2][1], 228, msg + " the last clip moved, the film growing")
                self.assertAlmostEqual(seen, 228, places=3, msg=msg + " its line")
                pg.evaluate("() => __panel.editTlUndo()")
                pg.evaluate("() => __panel.editTlRefresh()")

                # A ripple trim in the Trim mode, what follows and the film moving: a's out onto u's end at 3 (frame 72).
                pg.evaluate("() => __panel.editTlMode('trim')")
                to(4)
                x, y = self.x_at(pg, 4.0, dx=-4)
                seen = self.drag(pg, x, y, x - 1.0 * pps() + near, y, check=line)
                self.assertEqual(self.frames(pg)["v1"][0][2], 72, msg + " ripple out")
                self.assertAlmostEqual(seen, 72, places=3, msg=msg + " its line")
                pg.evaluate("() => __panel.editTlUndo()")
                pg.evaluate("() => __panel.editTlMode('select')")

                # The playhead as a target: the clip's start, the snap line and the drawn playhead on one frame.
                pg.evaluate("() => { __panel.setFrame(121); __panel.editTlRefresh(); }")
                to(5.5)
                pg.evaluate("() => { const P = __panel; const c = P._editTlCut; c.tracks[0].clips = [{ file: 'D:/out/b.mp4', name: 'v', in: 0, length: 1, at: 4.5, volume: 1, color: '' }]; P._editTlApply({ ...c }); }")
                to(4.7)
                x, y = pg.evaluate(WHERE, [4.7, "V2"])
                seen = self.drag(pg, x, y, x + (121 / 24 - 4.5) * pps() + near, y, check=line)
                self.assertEqual(self.frames(pg)["tracks"]["V2"][0][1], 121, msg + " onto the playhead")
                self.assertAlmostEqual(seen, 121, places=3)
                head = pg.evaluate("() => parseFloat(__panel._editTlUi.head.style.left) / 100 * __panel._editTlLay.total * 24")
                self.assertAlmostEqual(head, 121, places=2, msg=msg + " the playhead is drawn where it landed")
                self.assertEqual(self.errors, [])
                pg.close()

    def test_06_scrolling_during_a_drag_and_a_clips_own_gap_do_not_put_a_snap_off(self):
        pg = self.page(zoom=4)
        self.on_v2(pg, ["v", 5, 1])
        pg.evaluate("() => { const P = __panel, s = P._editTlUi.scroll; s.scrollLeft = 5 / P._editTlLay.total * s.scrollWidth - 300; }")
        pps = pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0]
        x, y = pg.evaluate(WHERE, [5.5, "V2"])
        pg.mouse.move(x, y)
        pg.mouse.down()
        pg.mouse.move(x + 40, y, steps=2)
        # The strip scrolled a screenful under the held pointer.
        pg.evaluate("() => { __panel._editTlUi.scroll.scrollLeft += 300; }")
        # Where the clip's end is 4 px short of b's start at 7.
        tx = pg.evaluate(WHERE, [7.0 - 0.5, "V2"])[0] - 4
        pg.mouse.move(tx, y, steps=2)
        pg.mouse.up()
        self.assertEqual(self.frames(pg)["tracks"]["V2"][0][2], 168, "the end on frame 168, read off the timeline as it is now")
        pg.evaluate("() => __panel.editTlUndo()")
        # A clip with a gap before it: its own near edge does not hold it back (it used to stick to it).
        pg = self.page()
        pg.evaluate("() => { const P = __panel; const c = P._editTlCut; c.clips[2].gap = 1; c.tracks[0].clips = []; P._editTlApply({ ...c }); }")
        x, y = pg.evaluate(WHERE, [9.5, "V1"])
        one = 12 / 24 * (pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0])
        self.drag(pg, x, y, x - one, y)
        self.assertEqual(self.frames(pg)["v1"][2][1], 180, "half a second left, into its gap")
        self.assertEqual(self.errors, [])

    def test_07_comma_period_move_the_clip_alt_slips_in_both_modes(self):
        pg = self.page()
        self.on_v2(pg, ["v", 1, 1])
        self.focus_timeline(pg)
        # A clip on a track: moved.
        pg.mouse.click(*pg.evaluate(WHERE, [1.5, "V2"]))
        pg.keyboard.press("Period")
        self.assertEqual(self.frames(pg)["tracks"]["V2"][0][1:], [25, 49])
        pg.keyboard.press("Shift+Comma")
        self.assertEqual(self.frames(pg)["tracks"]["V2"][0][1:], [1, 25])
        pg.keyboard.press("Shift+Comma")
        self.assertEqual(self.frames(pg)["tracks"]["V2"][0][1:], [0, 24], "stops at the start")
        # V1, Selection: into a gap and no further; the source untouched.
        pg.evaluate("() => { const P = __panel; const c = P._editTlCut; c.clips[2].gap = 2 / 24; P._editTlApply({ ...c }); }")
        pg.mouse.click(*pg.evaluate(WHERE, [9.0, "V1"]))
        pg.keyboard.press("Comma")
        self.assertEqual(self.frames(pg)["v1"][2][1], 169)
        self.assertEqual(self.cut(pg)["v1"][2][1], 1, "the source in stays")
        pg.keyboard.press("Shift+Comma")
        self.assertEqual(self.frames(pg)["v1"][2][1], 168, "stops at the clip before it")
        pg.keyboard.press("Comma")
        self.assertIn("held", pg.evaluate("() => __panel._editTlNote"))
        # Alt: a slip, as before.
        n = self.undo_len(pg)
        pg.keyboard.press("Alt+Comma")
        self.assertAlmostEqual(self.cut(pg)["v1"][2][1], 1 - 1 / 24, places=3)
        self.assertEqual(self.frames(pg)["v1"][2][1], 168)
        self.assertEqual(self.undo_len(pg), n + 1)
        # The Trim mode: one clip slides, its neighbours giving and taking; the film's length kept.
        pg.keyboard.press("t")
        pg.evaluate("() => { __panel.editTlUndo(); __panel.editTlRefresh(); }")
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 1 }; P._editTlEditSel = null; }")
        before = self.frames(pg)["v1"]
        pg.keyboard.press("Comma")
        got = self.frames(pg)["v1"]
        self.assertEqual(got[1][1:], [before[1][1] - 1, before[1][2] - 1])
        self.assertEqual(got[0][2], before[0][2] - 1, "the shot before ends earlier")
        self.assertEqual(got[2][2], before[2][2], "the film's length kept")
        self.assertEqual(self.errors, [])

    def test_07_several_selected_move_together_by_key_and_by_a_drag(self):
        pg = self.page()
        self.on_v2(pg, ["v", 1, 1])
        self.on_a2(pg, ["s", 5, 2])
        self.focus_timeline(pg)
        pg.mouse.click(*pg.evaluate(WHERE, [1.5, "V2"]))
        pg.keyboard.down("Control")
        pg.mouse.click(*pg.evaluate(WHERE, [6.0, "A2"]))
        pg.keyboard.up("Control")
        n = self.undo_len(pg)
        pg.keyboard.press("Period")
        got = self.frames(pg)["tracks"]
        self.assertEqual((got["V2"][0][1], got["A2"][0][1]), (25, 121))
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual(pg.evaluate(self.SEL), ["A2:0", "V2:0"], "still selected")
        # A plain press on one of them and a drag: both go. A click only: just that one.
        pps = pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0]
        x, y = pg.evaluate(WHERE, [1.5, "V2"])
        pg.keyboard.press("n")                                       # without snapping: a plain distance
        self.drag(pg, x, y, x + pps, y)
        got = self.frames(pg)["tracks"]
        self.assertAlmostEqual(got["V2"][0][1], 49, delta=1)
        self.assertAlmostEqual(got["A2"][0][1], 145, delta=1)
        self.assertEqual(self.undo_len(pg), n + 2)
        x, y = pg.evaluate(WHERE, [2.5, "V2"])
        pg.mouse.click(x, y)
        self.assertEqual(pg.evaluate(self.SEL), ["V2:0"])
        self.assertEqual(self.errors, [])

    def test_08_shift_a_shift_s_go_from_edit_to_edit_selecting_it(self):
        pg = self.page()
        self.on_v2(pg, ["v", 1, 1])
        self.focus_timeline(pg)
        frame = "() => __panel.currentFrame"
        sides = lambda: sorted(m[0] for m in pg.evaluate(self.MARKS))
        pg.evaluate("() => __panel.setFrame(10)")
        # Three steps a cut (test_19 has the whole walk): left, both (a roll), right.
        pg.keyboard.press("Shift+KeyS")
        self.assertEqual((pg.evaluate(frame), sides()), (96, ["end"]))
        pg.keyboard.press("Shift+KeyS")
        self.assertEqual((pg.evaluate(frame), sides()), (96, ["end", "start"]), "a roll, green on both")
        self.assertEqual(len(self.cut(pg)["v1"]), 3, "Shift+S does not split")
        # , / . adjust it, the playhead with it, and the next press goes on from there.
        pg.keyboard.press("Comma")
        self.assertEqual(self.frames(pg)["v1"][0][2], 95)
        self.assertEqual(self.frames(pg)["v1"][1][1], 95)
        self.assertEqual(pg.evaluate(frame), 95)
        pg.keyboard.press("Shift+KeyS")
        self.assertEqual((pg.evaluate(frame), sides()), (95, ["start"]))
        pg.keyboard.press("Shift+KeyS")
        self.assertEqual(pg.evaluate(frame), 168)
        for _ in range(3):
            pg.keyboard.press("Shift+KeyS")
        self.assertEqual(sides(), ["end"], "the end of the film: an edge")
        pg.keyboard.press("Shift+KeyS")
        self.assertIn("no edit after", pg.evaluate("() => __panel._editTlNote"))
        pg.evaluate("() => __panel.setFrame(10)")
        pg.keyboard.press("Escape")
        pg.keyboard.press("Shift+KeyA")
        self.assertEqual((pg.evaluate(frame), sides()), (0, ["start"]))
        pg.keyboard.press("Shift+KeyA")
        self.assertIn("no edit before", pg.evaluate("() => __panel._editTlNote"))
        # Esc clears the edit, not more.
        pg.keyboard.press("Escape")
        self.assertEqual(pg.evaluate(self.MARKS), [])
        # A clip on another track selected: that track's edits. In the Trim mode too.
        pg.mouse.click(*pg.evaluate(WHERE, [1.5, "V2"]))
        pg.keyboard.press("t")
        pg.evaluate("() => __panel.setFrame(0)")
        pg.keyboard.press("Shift+KeyS")
        self.assertEqual((pg.evaluate(frame), pg.evaluate("() => __panel._editTlEditSel.sel.track")), (24, "V2"))
        pg.keyboard.press("Shift+KeyS")
        self.assertEqual(pg.evaluate(frame), 48)
        # S alone still splits; S held in a drag still flips the snapping.
        pg.keyboard.press("Escape")
        pg.keyboard.press("Escape")
        pg.keyboard.press("a")
        pg.evaluate("() => __panel.setFrame(24)")
        pg.keyboard.press("s")
        self.assertEqual(len(self.cut(pg)["v1"]), 4)
        pps = pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0]
        x, y = pg.evaluate(WHERE, [1.5, "V2"])
        pg.keyboard.press("n")
        pg.mouse.move(x, y)
        pg.mouse.down()
        pg.mouse.move(x + 2.46 * pps, y, steps=3)
        pg.keyboard.down("s")
        self.assertTrue(pg.evaluate("() => __panel._editTlSnapFlip"))
        pg.keyboard.up("s")
        pg.mouse.up()
        self.assertEqual(self.errors, [])

    def test_09_a_marquee_selects_what_it_touches_on_all_tracks_shift_adds(self):
        for mode in ("a", "t"):
            pg = self.page()
            self.on_v2(pg, ["v", 1, 1], ["w", 8, 1])
            self.on_a2(pg, ["s", 5, 2])
            self.focus_timeline(pg)
            pg.keyboard.press(mode)
            # From an empty place on V2, down over V1 and A2 and the bed.
            x0, y0 = pg.evaluate(WHERE, [4.5, "V2"])
            x1, y1 = pg.evaluate(WHERE, [5.5, "A2"])
            seen = self.drag(pg, x0, y0, x1, y1, check="() => { const m = __panel._editTlUi.area.querySelector('.edit-marquee'); return m && m.style.display !== 'none' ? m.getBoundingClientRect().width : 0; }")
            self.assertGreater(seen, 10, "the rectangle is drawn")
            self.assertIsNone(pg.evaluate("() => __panel._editTlUi.area.querySelector('.edit-marquee')"), "and goes")
            self.assertEqual(pg.evaluate(self.SEL), ["A1:0", "A2:0", "V1:1"])
            # Shift adds.
            x0, y0 = pg.evaluate(WHERE, [7.5, "V2"])
            x1, y1 = pg.evaluate(WHERE, [8.5, "V2"])
            self.drag(pg, x0, y0, x1, y1, keys=("Shift",))
            self.assertEqual(pg.evaluate(self.SEL), ["A1:0", "A2:0", "V1:1", "V2:1"])
            # A plain one replaces; a click where nothing lies takes it all off.
            x0, y0 = pg.evaluate(WHERE, [0.1, "V2"])
            x1, y1 = pg.evaluate(WHERE, [1.5, "V2"])
            self.drag(pg, x0, y0, x1, y1)
            self.assertEqual(pg.evaluate(self.SEL), ["V2:0"])
            pg.mouse.click(*pg.evaluate(WHERE, [4.5, "V2"]))
            self.assertEqual(pg.evaluate(self.SEL), [])
            # The ruler is not a place to draw one: it scrubs.
            r = pg.evaluate("() => { const r = __panel._editTlUi.ruler.getBoundingClientRect(); return [r.left + 100, r.top + 5]; }")
            self.drag(pg, r[0], r[1], r[0] + 100, r[1] + 60)
            self.assertEqual(pg.evaluate(self.SEL), [])
            self.assertEqual(self.errors, [])
            pg.close()

    def test_10_del_takes_everything_selected_as_one_undo_step(self):
        for key, ripple, mode in (("Delete", False, "a"), ("Backspace", False, "a"), ("Shift+Delete", True, "a"), ("Delete", False, "t"), ("Shift+Backspace", True, "t")):
            pg = self.page()
            self.on_v2(pg, ["v", 1, 1], ["w", 8, 1])
            self.on_a2(pg, ["s", 9, 1])
            pg.evaluate("() => { const P = __panel; P._editTlApply({ ...P._editTlCut, texts: [{ text: 'hi', start: 8, length: 2 }] }); P._editTlHistories[P._editTlTab] = { past: [], future: [] }; }")
            self.focus_timeline(pg)
            pg.keyboard.press(mode)
            pg.keyboard.down("Control")
            pg.mouse.click(*pg.evaluate(WHERE, [2.0, "V1"]))
            pg.mouse.click(*pg.evaluate(WHERE, [9.5, "A2"]))
            pg.mouse.click(*pg.evaluate(WHERE, [1.5, "V2"]))
            pg.mouse.click(*pg.evaluate(WHERE, [3.0, "A1"]))
            pg.mouse.click(*pg.evaluate(WHERE, [9.0, "T"]))
            pg.keyboard.up("Control")
            before = self.frames(pg)
            pg.keyboard.press(key)
            got = self.frames(pg)
            self.assertEqual([c[0] for c in got["v1"]], ["c", "b"], key)
            self.assertEqual(got["tracks"]["A2"], [], key)
            self.assertEqual(pg.evaluate("() => [__panel._editTlCut.sound.length, __panel._editTlCut.texts.length]"), [0, 0], key)
            if ripple:
                self.assertEqual(got["v1"][0][1], 0, "what follows closes up")
                # On its own track by v's length, and - V2's Auto Track Selector being on - by the V1 shot's 4 s too.
                self.assertEqual(got["tracks"]["V2"], [["w", 8 * 24 - 24 - 96, 8 * 24 - 96]], "on its own track, and with V1")
            else:
                self.assertEqual(got["v1"][0][1], 96, "gaps stay")
                self.assertEqual(got["tracks"]["V2"], [["w", 192, 216]])
            self.assertEqual(self.undo_len(pg), 1, key)
            self.assertEqual(pg.evaluate(self.SEL), [])
            pg.keyboard.press("Control+z")
            self.assertEqual(self.frames(pg), before, "one undo step brings it all back")
            self.assertEqual(pg.evaluate("() => __panel._editTlCut.sound.length"), 1)
            self.assertEqual(self.errors, [])
            pg.close()

    def test_10_a_linked_partner_goes_too_and_a_gap_and_a_saved_bed(self):
        pg = self.page()
        self.on_a2(pg, ["s", 0, 4])
        pg.evaluate("() => { const P = __panel; const c = P._editTlCut; c.clips[0].link = 'L'; c.tracks[1].clips[0].link = 'L'; c.tracks[1].clips[0].file = c.clips[0].file; P._editTlApply({ ...c }); }")
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.down("Control")
        pg.mouse.click(*self.x_at(pg, 9.0))
        pg.keyboard.up("Control")
        pg.keyboard.press("Delete")
        self.assertEqual(len(self.cut(pg)["v1"]), 1)
        self.assertEqual(self.cut(pg)["tracks"]["A2"], [], "the linked sound went with it")
        pg.keyboard.press("Control+z")
        # A gap selected: closed, as before.
        pg.evaluate("() => { const P = __panel; const c = P._editTlCut; c.clips[1].gap = 1; P._editTlApply({ ...c }); }")
        pg.mouse.click(*self.x_at(pg, 4.5))
        pg.keyboard.press("Delete")
        self.assertEqual(self.frames(pg)["v1"][1][1], 96)
        # All of V1: it keeps its last shot, and says so.
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList([{ kind: 'clip', i: 0 }, { kind: 'clip', i: 1 }, { kind: 'clip', i: 2 }]); }")
        pg.keyboard.press("Delete")
        self.assertEqual(len(self.cut(pg)["v1"]), 1)
        self.assertIn("keeps its last shot", pg.evaluate("() => __panel._editTlNote"))
        # The bed, deleted, is what a save sends.
        pg.mouse.click(*pg.evaluate(WHERE, [0.2, "A1"]))
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.sound.length"), 0)
        self.assertTrue(pg.evaluate("() => { const P = __panel; return !P._editTlSaved || !!P._editTlDirty(); }"))
        self.assertEqual(self.errors, [])

    ICONS = {"pick": ["M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"],
             "blade": ["M5.42 9.42 8 12", "cx=4,cy=8,r=2", "m14 6-8.58 8.58", "cx=4,cy=16,r=2", "M10.8 14.8 14 18", "M16 12h-2", "M22 12h-2"],
             "split": ["cx=6,cy=6,r=3", "M8.12 8.12 12 12", "M20 4 8.12 15.88", "cx=6,cy=18,r=3", "M14.8 14.8 20 20"],
             "trimBtn": ["x=9,y=9,width=6,height=6,rx=1", "M3 21h18", "M3 3h18"],
             "snap": ["m12 15 4 4", "M2.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.029-6.029a1 1 0 1 1 3 3l-6.029 6.029a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.365-6.367A1 1 0 0 0 8.716 4.282z", "m5 8 4 4"],
             "beats": ["M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"],
             "zoomOut": ["cx=11,cy=11,r=8", "x1=21,x2=16.65,y1=21,y2=16.65", "x1=8,x2=14,y1=11,y2=11"],
             "zoomIn": ["cx=11,cy=11,r=8", "x1=21,x2=16.65,y1=21,y2=16.65", "x1=11,x2=11,y1=8,y2=14", "x1=8,x2=14,y1=11,y2=11"],
             "zoomFit": ["M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2", "cx=12,cy=12,r=3", "m16 16-1.9-1.9"]}

    def test_the_bar_has_the_specified_icons_and_no_keys_button(self):
        pg = self.page()
        got = pg.evaluate("""(names) => Object.fromEntries(names.map(n => { const svg = __panel._editTlUi[n].querySelector('svg');
            return [n, { attrs: ['viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'].map(a => svg.getAttribute(a)), title: __panel._editTlUi[n].title,
                shapes: [...svg.children].map(c => c.getAttribute('d') || [...c.attributes].map(a => a.name + '=' + a.value).join(',')), w: svg.getBoundingClientRect().width }]; }))""", list(self.ICONS))
        for name, shapes in self.ICONS.items():
            self.assertEqual(got[name]["shapes"], shapes, name)
            self.assertEqual(got[name]["attrs"], ["0 0 24 24", "none", "currentColor", "2", "round", "round"], name)
            self.assertEqual(got[name]["w"], 15, name)
            self.assertTrue(got[name]["title"], name)
        # The states stay.
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        self.assertTrue(pg.evaluate("() => __panel._editTlUi.trimBtn.classList.contains('on')"))
        pg.keyboard.press("n")
        self.assertFalse(pg.evaluate("() => __panel._editTlUi.snap.classList.contains('on')"))
        # No ? button, and nothing left of its dialog.
        self.assertEqual(pg.evaluate("() => [...__panel._editTlUi.body.querySelectorAll('.edit-bar button')].filter(b => b.textContent.trim() === '?').length"), 0)
        self.assertEqual(pg.evaluate("() => typeof __panel.editTlKeysHelp"), "undefined")
        self.assertEqual(self.errors, [])

    HELP = """() => { const o = __panel.helpOverlay, on = (s) => getComputedStyle(o.querySelector(s)).display !== 'none';
        return { open: getComputedStyle(o).display !== 'none', edit: on('#help-edit'), viewer: on('#help-viewer'), text: o.querySelector('#help-edit-keys').textContent }; }"""

    def test_show_hotkeys_lists_the_edit_keys_on_a_cut_and_the_viewers_elsewhere(self):
        pg = self.page()
        pg.evaluate("() => __panel.helpBtn.click()")
        got = pg.evaluate(self.HELP)
        self.assertTrue(got["open"] and got["edit"])
        self.assertFalse(got["viewer"])
        for key in ("Selection mode", "Trim Edit mode", "Snapping", "Ripple delete", "Unlink", "Zoom the timeline", "Marquee", "Shift+S / Shift+A", "Play around edit", "Alt+, / Alt+.", "A new track",
                    "Click a cut", "Move the selected clips"):
            self.assertIn(key, got["text"], key)
        pg.evaluate("() => __panel.toggleHelpOverlay(false)")
        # The ? key with the timeline holding the focus, the pointer elsewhere.
        self.focus_timeline(pg)
        pg.mouse.move(800, 5)
        pg.keyboard.press("?")
        self.assertTrue(pg.evaluate(self.HELP)["edit"])
        pg.evaluate("() => __panel.toggleHelpOverlay(false)")
        # Another tab: the viewer's own.
        pg.evaluate("""() => { const P = __panel; P.allTabs['plain'] = []; P.tabLabels['plain'] = 'plain'; P.tabOrder.push('plain'); P.switchTab('plain'); }""")
        pg.evaluate("() => __panel.toggleHelpOverlay(true)")
        got = pg.evaluate(self.HELP)
        self.assertTrue(got["open"] and got["viewer"])
        self.assertFalse(got["edit"])
        self.assertGreater(pg.evaluate("() => __panel.helpOverlay.querySelectorAll('#help-keys > div').length"), 5)
        self.assertEqual(self.errors, [])

    # ── where a cut went, Save cut as, Open cut ──

    SAVED = "() => { const b = __panel._editTlUi.savedBar; return [getComputedStyle(b).display, b.querySelector('.edit-saved-text')?.textContent || '', b.classList.contains('error')]; }"
    BADGE = "() => __panel._editTlUi.badge.textContent"

    def saves_show(self, pg, keys):
        """A save says the whole path; a failure says why and leaves it unsaved; Save cut as and Open cut work. `keys`: the page holding the panel's keyboard."""
        keys.keyboard.press("Control+s")
        pg.wait_for_function("() => __panel._editTlUi.savedBar.style.display === 'flex'", timeout=5000)
        self.assertEqual(pg.evaluate(self.SAVED), ["flex", "Saved to D:/out/cut.otio", False])
        self.assertEqual(pg.evaluate(self.BADGE), "")
        self.assertIn("Copy path", pg.evaluate("() => __panel._editTlUi.savedBar.textContent"))
        self.assertIn("Show in file browser", pg.evaluate("() => __panel._editTlUi.savedBar.textContent"))
        self.assertEqual(pg.evaluate("() => __panel.editTlFilePath()"), "D:/out/cut.otio")
        # A failed save: the reason, still unsaved.
        pg.evaluate("() => { const P = __panel; window.__saveFail = { status: 500, text: 'not saved: [Errno 24] Too many open files' }; P._editTlApply(D_len(P)); }".replace("D_len(P)", "{ ...P._editTlCut, clips: P._editTlCut.clips.slice(0, -1) }"))
        keys.keyboard.press("Control+s")
        pg.wait_for_function("() => __panel._editTlUi.savedBar.classList.contains('error')", timeout=5000)
        got = pg.evaluate(self.SAVED)
        self.assertEqual(got[0], "flex")
        self.assertIn("Too many open files", got[1])
        self.assertIn("not saved", pg.evaluate(self.BADGE))
        pg.evaluate("() => { window.__saveFail = null; }")
        # Save cut as: a dialog, the name cleaned by the server, an overwrite asked, the tab then on the new file.
        keys.keyboard.press("Control+Shift+s")
        pg.wait_for_function("() => !!__panel._editTlUi.dialog", timeout=5000)
        d = "__panel._editTlUi.dialog"
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-dialog-title').textContent"), "Save cut as\u2026")
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-saveas-folder').value"), "D:/out")
        pg.evaluate("() => { window.__onDisk = { 'D:/out/other.otio': true }; }")
        pg.evaluate(f"() => {{ const i = {d}.querySelector('.edit-saveas-name'); i.value = 'other'; {d}.querySelector('.edit-saveas-go').click(); }}")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-saveas-note').textContent.includes('Overwrite it?')", timeout=5000)
        self.assertEqual(pg.evaluate("() => __panel.editTlFilePath()"), "D:/out/cut.otio", "nothing yet")
        pg.evaluate(f"() => {d}.querySelector('.edit-saveas-yes').click()")
        pg.wait_for_function("() => __panel.editTlFilePath() === 'D:/out/other.otio'", timeout=5000)
        self.assertEqual(pg.evaluate("() => __saveAs[0].source"), {"path": "D:/out/cut.otio", "external": 1})
        self.assertIn("other", pg.evaluate("() => __panel.tabLabels[__panel._editTlTab]"))
        self.assertEqual(pg.evaluate(self.SAVED)[1], "Saved to D:/out/other.otio")
        # A later save goes to the new file.
        self.assertEqual(pg.evaluate("() => __panel._editTlTarget.path"), "D:/out/other.otio")
        # Open cut: from the menu's dialog, a tab of its own; again: that tab.
        pg.evaluate("() => { const P = __panel; window.__otio = { 'D:/out/saved.otio': { name: 'saved', fps: 24, clips: [{ ref: 0, file: 'D:/out/a.mp4', name: 'a', in: 0, length: 2, transition: 0 }], texts: [], sound: [], tracks: [], off: {} } }; }")
        pg.evaluate("() => __panel.editTlOpenDialog()")
        pg.wait_for_function("() => __panel.container.querySelector('.pick-row.file')", timeout=5000)
        pg.evaluate("""() => { const r = __panel.container.querySelector('.pick-row.file'); r.click(); __panel.container.querySelector('.pick-dlg .rd-go').click(); }""")
        pg.wait_for_function("() => __panel.editTlFilePath() === 'D:/out/saved.otio'", timeout=5000)
        n = pg.evaluate("() => __panel._editTlTabs().length")
        self.assertEqual(pg.evaluate("async () => { await __panel.editTlOpenPath('D:/out/saved.otio'); return __panel._editTlTabs().length; }"), n)
        self.assertEqual(self.errors, [])

    def test_saves_say_where_in_the_viewer(self):
        pg = self.page()
        self.focus_timeline(pg)
        self.saves_show(pg, pg)

    def test_saves_say_where_docked_in_the_page_as_the_sidebar_is(self):
        pg = self.page()
        pg.evaluate("() => __panel.togglePageDock()")
        pg.evaluate("() => __panel.editTlRefresh()")
        self.focus_timeline(pg)
        self.saves_show(pg, pg)

    def test_saves_say_where_popped_out(self):
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        win.mouse.click(*pg.evaluate(WHERE, [0.2, "V2"]))
        self.saves_show(pg, win)

    # ── Export to Resolve ──

    RESOLVE_D = "__panel._editTlUi.dialog"

    def resolve_menu(self, pg):
        """The Save menu holds it, next to Export film; the entry opens the in-page dialog."""
        pg.evaluate("() => __panel._editTlOutMenu(__panel._editTlUi.body.querySelector('.edit-bar button'))")
        labels = pg.evaluate("() => [...__panel.container.querySelectorAll('.previz-menu-item')].map(b => b.textContent)")
        self.assertEqual(labels[labels.index("Export film\u2026") + 1], "Export to Resolve\u2026")
        pg.evaluate("() => [...__panel.container.querySelectorAll('.previz-menu-item')].find(b => b.textContent.startsWith('Export to Resolve')).click()")
        pg.wait_for_function(f"() => {self.RESOLVE_D} && {self.RESOLVE_D}.classList.contains('edit-resolve') && !{self.RESOLVE_D}.querySelector('.edit-resolve-go').disabled", timeout=8000)

    def resolve_dialog(self, pg, keys):
        d = self.RESOLVE_D
        self.resolve_menu(pg)
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-dialog-title').textContent"), "Export to Resolve\u2026")
        # All of it on screen, on top: nothing over its title, its button not cut off by a short panel.
        hit = """(d) => { const root = d.getRootNode(); return ['.edit-dialog-title', '.edit-resolve-go'].map((s) => {
            const r = d.querySelector(s).getBoundingClientRect(), at = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!at && d.contains(at); }); }"""
        self.assertEqual(pg.evaluate_handle(f"() => {d}").evaluate(hit), [True, True])
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-name').value"), "cut_resolve")
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-folder').value"), "D:/out")
        room = pg.evaluate(f"() => {d}.querySelector('.edit-resolve-room').textContent")
        self.assertIn("5.0 MB", room)
        self.assertIn("900.0 MB", room)
        self.assertEqual(pg.evaluate(f"() => getComputedStyle({d}.querySelector('.edit-resolve-check')).display"), "none", "no range, no option")
        # Typing in the name reaches the field and none of the panel's keys.
        before = self.cut(pg)
        keys.keyboard.press("Control+a")
        keys.keyboard.type("bs takes")
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-name').value"), "bs takes")
        self.assertEqual(self.cut(pg), before, "b and s did not cut anything")
        keys.keyboard.press("Enter")
        pg.wait_for_function("() => (window.__resolvePlans || []).at(-1).name === 'bs takes'", timeout=5000)
        # Progress, then the result with the whole path.
        pg.evaluate("() => { window.__resolve = { polls: 3 }; }")
        pg.wait_for_function(f"() => !{d}.querySelector('.edit-resolve-go').disabled", timeout=5000)
        pg.evaluate(f"() => {d}.querySelector('.edit-resolve-go').click()")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-resolve-note').textContent.includes('a.mp4')", timeout=5000)
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-cancel').style.display"), "")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-resolve-result').style.display === ''", timeout=8000)
        text = pg.evaluate(f"() => {d}.querySelector('.edit-resolve-result').textContent")
        self.assertIn("D:/out/bs takes", text)
        self.assertIn("Left out:", text)
        self.assertIn("Clip colours.", text)
        self.assertIn("H.264 10-bit 4:2:2", text)
        self.assertIn("Not tried inside Resolve", text)
        self.assertEqual(pg.evaluate(f"() => [...{d}.querySelectorAll('.edit-resolve-result button')].map(b => b.textContent)"), ["Copy path", "Show in file browser"])
        self.assertEqual(pg.evaluate(self.SAVED)[1], "Exported to D:/out/bs takes")
        pg.evaluate(f"() => {d}.querySelector('.edit-resolve-close').click()")
        self.assertFalse(pg.evaluate(f"() => !!{d}"))
        self.assertEqual(self.errors, [])

    def test_resolve_export_in_the_viewer(self):
        pg = self.page()
        self.resolve_dialog(pg, pg)

    def test_resolve_export_docked_in_the_page(self):
        pg = self.page()
        pg.evaluate("() => __panel.togglePageDock()")
        pg.evaluate("() => __panel.editTlRefresh()")
        self.resolve_dialog(pg, pg)

    def test_resolve_export_popped_out(self):
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        self.resolve_dialog(pg, win)

    def test_resolve_export_says_what_stands_in_its_way(self):
        pg = self.page()
        d = self.RESOLVE_D
        # In and out set: the option is there, and it asks for those frames.
        pg.evaluate("() => { __panel._editTlSetRange({ start: 24, end: 47 }); }")
        self.resolve_menu(pg)
        self.assertNotEqual(pg.evaluate(f"() => getComputedStyle({d}.querySelector('.edit-resolve-check')).display"), "none")
        pg.evaluate(f"() => {d}.querySelector('.edit-resolve-range').click()")
        pg.wait_for_function("() => JSON.stringify((window.__resolvePlans || []).at(-1).frames) === '[24,47]'", timeout=5000)
        # No room: said, and no Export.
        pg.evaluate("() => { window.__resolve = { plan: { free: 1024 } }; }")
        pg.evaluate(f"() => {{ const i = {d}.querySelector('.edit-resolve-name'); i.value = 'r2'; i.dispatchEvent(new Event('change')); }}")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-resolve-note').textContent.includes('not enough free space')", timeout=5000)
        self.assertTrue(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-go').disabled"))
        # Missing: named; Export only after saying to go on without them, and that goes to the server.
        pg.evaluate("() => { window.__resolve = { plan: { missing: ['D:/out/gone.mp4'], flagged: [{ name: 'a.mp4', note: 'H.264 10-bit 4:2:2' }] } }; }")
        pg.evaluate(f"() => {{ const i = {d}.querySelector('.edit-resolve-name'); i.value = 'r3'; i.dispatchEvent(new Event('change')); }}")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-resolve-list').textContent.includes('gone.mp4')", timeout=5000)
        self.assertIn("10-bit", pg.evaluate(f"() => {d}.querySelector('.edit-resolve-list').textContent"))
        self.assertTrue(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-go').disabled"))
        pg.evaluate(f"() => {d}.querySelector('.edit-resolve-lose').click()")
        self.assertFalse(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-go').disabled"))
        # Cancel while it runs: back at the form, the name still there.
        pg.evaluate("() => { window.__resolve = { polls: 100000 }; }")
        pg.evaluate(f"() => {d}.querySelector('.edit-resolve-go').click()")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-resolve-cancel').style.display === '' && window.__resolveState", timeout=5000)
        self.assertTrue(pg.evaluate("() => __resolveStarted.at(-1).continue_missing"))
        self.assertEqual(pg.evaluate("() => __resolveStarted.at(-1).frames"), [24, 47])
        pg.evaluate(f"() => {d}.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Escape', bubbles: true }}))")
        self.assertTrue(pg.evaluate(f"() => !!{d}"), "Esc does not walk away from a running export")
        pg.evaluate(f"() => {d}.querySelector('.edit-resolve-cancel').click()")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-resolve-go').style.display === ''", timeout=5000)
        self.assertEqual(pg.evaluate(f"() => {d}.querySelector('.edit-resolve-name').value"), "r3")
        # A failure stays said.
        pg.evaluate("() => { window.__resolve = { polls: 0, fail: 'The disk is full: no room' }; }")
        pg.wait_for_function(f"() => !{d}.querySelector('.edit-resolve-go').disabled", timeout=5000)
        pg.evaluate(f"() => {d}.querySelector('.edit-resolve-go').click()")
        pg.wait_for_function(f"() => {d}.querySelector('.edit-resolve-note').textContent.includes('disk is full')", timeout=5000)
        self.assertEqual(self.errors, [])

    # ── sound split off: relink, resync, merge back, no waveform ──

    def menu_has(self, pg, x, y):
        pg.mouse.click(x, y, button="right")
        got = pg.evaluate("() => [...__panel.container.querySelectorAll('.previz-menu-item')].map(b => b.textContent)")
        return got

    def test_split_no_waveform_relink_from_either_part_resync_and_merge_back(self):
        pg = self.page()
        self.fit(pg)
        pg.evaluate("() => { __panel._editTlView.heights = { V2: 14, V1: 60, A1: 14, A2: 14 }; __panel.editTlRefresh(); }")
        self.settle(pg)
        # Which clips draw a waveform lane: asked of the drawing itself, redrawn from scratch.
        pg.evaluate("() => { const P = __panel, w = P._emWave; P._emWave = function (ctx, m, ...r) { (window.__waves ||= new Set()).add(m.file); return w.call(this, ctx, m, ...r); }; }")
        waves = lambda: (pg.evaluate("() => { window.__waves = new Set(); __panel._emDrawn = 0; __panel.editTlRefresh(); }"),
                         pg.wait_for_function("() => __panel._emPending === 0 && __panel._emDrawn > 0", timeout=15000),
                         pg.evaluate("() => [...window.__waves]"))[-1]
        self.assertIn("D:/out/a.mp4", waves())
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.press("Control+Alt+l")
        self.assertNotIn("D:/out/a.mp4", pg.evaluate("""() => { window.__waves = new Set(); const b = __panel._editTlUi.rows.querySelector("[data-key='V1:0']"); const r = b.getBoundingClientRect(); __panel._editMediaClip(b, b._media, r, r.left, r.right, new Set()); return [...window.__waves]; }"""))
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.clips[0].mute"))
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelector(\"[data-key='V1:0']\").classList.contains('muted')"), False)
        # From either part.
        items = self.menu_has(pg, *self.x_at(pg, 2.0))
        self.assertTrue(any(i.startswith("Relink audio") for i in items), items)
        self.assertIn("Merge audio back into clip", items)
        self.assertFalse(any("own sound" in i for i in items))
        pg.keyboard.press("Escape")
        pg.mouse.click(5, 5)
        items = self.menu_has(pg, *self.x_at(pg, 2.0, "A2"))
        self.assertTrue(any(i.startswith("Relink audio") for i in items), items)
        pg.keyboard.press("Escape")
        pg.mouse.click(5, 5)
        # Out of sync by half a second, then relinked from the sound alone: the offset stays, said on both.
        pg.evaluate("() => { const P = __panel; const c = P._editTlCut; c.tracks[1].clips[0].at = 0.5; P._editTlSel = { kind: 'tclip', track: 'A2', i: 0 }; P._editTlApply({ ...c }); }")
        pg.mouse.click(*self.x_at(pg, 2.0, "A2"))
        pg.keyboard.press("Control+Alt+l")
        self.assertTrue(pg.evaluate("() => { const c = __panel._editTlCut; return !c.clips[0].unlinked && !c.tracks[1].clips[0].unlinked && c.clips[0].mute === true; }"))
        self.assertEqual(pg.evaluate("() => [...__panel._editTlUi.rows.querySelectorAll('.edit-badge-sync')].map(b => b.textContent)"), ["+12", "+12"])
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks[1].clips[0].at"), 0.5)
        # Resync.
        items = self.menu_has(pg, *self.x_at(pg, 2.0))
        pg.locator(".previz-menu-item", has_text="Resync").first.click()
        self.assertEqual(pg.evaluate("() => [__panel._editTlCut.tracks[1].clips[0].at, __panel._editTlUi.rows.querySelectorAll('.edit-badge-sync').length]"), [0, 0])
        # Merge back: one step; the sound clip gone, one source of sound, the waveform back.
        n = self.undo_len(pg)
        self.menu_has(pg, *self.x_at(pg, 2.0))
        pg.locator(".previz-menu-item", has_text="Merge audio back").first.click()
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual(self.cut(pg)["tracks"]["A2"], [])
        self.assertEqual(pg.evaluate("() => { const c = __panel._editTlCut.clips[0]; return [c.mute, c.link, c.unlinked].map(v => v === undefined); }"), [True, True, True])
        self.assertIn("D:/out/a.mp4", waves(), "the waveform lane is back")
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(len(self.cut(pg)["tracks"]["A2"]), 1, "one undo brings the pair back")
        self.assertEqual(self.errors, [])

    def test_keys_of_this_round_do_not_fire_while_typing(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.mouse.click(*pg.evaluate(WHERE, [2.0, "V1"]))
        before = self.cut(pg)
        frame = pg.evaluate("() => __panel.currentFrame")
        pg.evaluate("""() => { const i = document.createElement('input'); i.id = 'typing'; __panel._editTlUi.body.append(i); i.focus(); }""")
        pg.evaluate("() => __panel._editTlUi.body.querySelector('#typing').focus()")
        for key in ("Period", "Comma", "Shift+KeyA", "Shift+KeyS", "Alt+Period", "Delete", "Backspace"):
            pg.keyboard.press(key)
        self.assertEqual(self.cut(pg), before)
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), frame)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.body.querySelector('#typing').value"), ".,A")
        self.assertEqual(self.errors, [])

    def test_popped_out_every_item_of_this_round(self):
        pg = self.page()
        self.on_v2(pg, ["v", 1, 1])
        self.on_a2(pg, ["s", 5, 2])
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        # Zoom out past the end.
        win.mouse.click(*pg.evaluate(WHERE, [4.5, "V2"]))
        win.keyboard.press("Control+Minus")
        self.assertLess(pg.evaluate("() => __panel._editTlView.zoom"), 1)
        win.keyboard.press("Shift+Z")
        # A marquee, the keys, Del.
        x0, y0 = pg.evaluate(WHERE, [4.5, "V2"])
        x1, y1 = pg.evaluate(WHERE, [5.5, "A2"])
        win.mouse.move(x0, y0)
        win.mouse.down()
        win.mouse.move(x1, y1, steps=4)
        win.mouse.up()
        self.assertEqual(pg.evaluate(self.SEL), ["A1:0", "A2:0", "V1:1"])
        win.keyboard.press("Escape")
        # An edit point and , / .
        win.mouse.click(*self.x_at(pg, 4.0, dx=-5))
        self.assertEqual([m[0] for m in pg.evaluate(self.MARKS)], ["end"])
        win.keyboard.press("Comma")
        self.assertEqual(self.frames(pg)["v1"][0][2], 95)
        win.keyboard.press("Period")
        for _ in range(3):                                   # the cut's roll, its right side, then the next cut
            win.keyboard.press("Shift+KeyS")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 168)
        win.keyboard.press("Escape")
        win.keyboard.press("Escape")
        # A clip moved by a key; a new track by a drag; ctrl-click across and Del as one step.
        win.mouse.click(*pg.evaluate(WHERE, [1.5, "V2"]))
        win.keyboard.press("Period")
        self.assertEqual(self.frames(pg)["tracks"]["V2"][0][1], 25)
        x, y = pg.evaluate(WHERE, [1.6, "V2"])
        ry = pg.evaluate("() => { const r = __panel._editTlUi.rows.querySelector('.edit-room[data-room=\"video\"]').getBoundingClientRect(); return r.top + r.height / 2; }")
        # V2 to a new V3
        win.mouse.move(x, y)
        win.mouse.down()
        win.mouse.move(x + 10, ry, steps=4)
        win.mouse.up()
        self.assertIn("V3", self.cut(pg)["tracks"])
        win.mouse.click(*pg.evaluate(WHERE, [2.0, "V1"]))
        win.keyboard.down("Control")
        win.mouse.click(*pg.evaluate(WHERE, [6.0, "A2"]))
        win.keyboard.up("Control")
        n = self.undo_len(pg)
        win.keyboard.press("Delete")
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual(self.cut(pg)["tracks"]["A2"], [])
        self.assertEqual(self.errors, [])

    # ── round 29: insert at the playhead, the playhead's line, scrub audio, zoom about the playhead, the two-up ──

    NODES = """async (nodes) => { const { app } = await import('/scripts/app.js');
        app.canvas.selected_nodes = Object.fromEntries(nodes.map(([id, x, value]) => [String(id),
            { id, type: 'LoadImage', title: 'Load', pos: [x, 10], widgets: [{ name: 'image', value, type: 'combo' }], inputs: [], outputs: [] }])); }"""

    HEAD_X = "() => __panel._editTlUi.head.getBoundingClientRect().left"

    def test_11_selected_canvas_nodes_are_inserted_at_the_playhead_splitting_the_shot(self):
        pg = self.page()
        pg.evaluate("() => { __media['D:/in/zz.mp4'] = { duration: 2, video: true }; __media['D:/in/house.png'] = { duration: 0, still: true }; }")
        # Selected in the order zz, house - but house stands left of zz on the canvas, so it goes first.
        pg.evaluate(self.NODES, [[1, 300, "zz.mp4"], [2, 100, "house.png"]])
        pg.evaluate("() => __panel.setFrame(48)")                      # 2 s: inside a (0..4)
        labels = pg.evaluate("""() => { const P = __panel; P._editTlAddMenu(P._editTlUi.body.querySelector('.previz-btn[title^="Add"]'));
            const m = P._previzAddMenu; const out = m ? [...m.querySelectorAll('*')].map(n => n.textContent).filter(t => /inserted/.test(t)) : [];
            P._previzCloseAddMenu && P._previzCloseAddMenu(); return out; }""")
        self.assertTrue(any("Selected canvas nodes" in t for t in labels), labels)
        n = self.undo_len(pg)
        pg.evaluate("() => __panel._editTlAddSelected()")
        pg.wait_for_function("() => __panel._editTlCut.clips.length === 6", timeout=5000)
        self.assertEqual(self.cut(pg)["v1"][:4], [["D:/out/a.mp4", 0, 2.0], ["D:/in/house.png", 0, 3.0], ["D:/in/zz.mp4", 0, 2.0], ["D:/out/a.mp4", 2.0, 2.0]])
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 7 * 24, "the playhead at the end of what went in")
        self.assertEqual(self.undo_len(pg), n + 1, "one undo step")
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(len(self.cut(pg)["v1"]), 3)
        # With a clip of V2 selected, the insert goes onto V2 (its clip there split too).
        self.on_v2(pg, ["v", 1, 4])
        pg.mouse.click(*pg.evaluate(WHERE, [1.5, "V2"]))
        pg.evaluate("() => __panel.setFrame(72)")                      # 3 s: inside the V2 clip (1..5)
        pg.evaluate(self.NODES, [[2, 100, "house.png"]])
        pg.evaluate("() => __panel._editTlAddSelected()")
        pg.wait_for_function("() => __panel._editTlCut.tracks[0].clips.length === 3", timeout=5000)
        self.assertEqual(sorted(self.cut(pg)["tracks"]["V2"]), sorted([["D:/out/b.mp4", 1.0, 2.0], ["D:/out/b.mp4", 6.0, 2.0], ["D:/in/house.png", 3.0, 3.0]]))
        self.assertEqual(len(self.cut(pg)["v1"]), 3, "V1 untouched")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 6 * 24)
        self.assertEqual(self.errors, [])

    def test_12_the_playhead_line_is_grabbed_low_on_the_tracks_and_over_a_clip(self):
        pg = self.page()
        self.fit(pg)
        pg.evaluate("() => __panel.setFrame(120)")                     # 5 s, inside the still c (4..7)
        before = self.cut(pg)
        hx = pg.evaluate(self.HEAD_X)
        _, ya2 = pg.evaluate(WHERE, [5.0, "A2"])                       # the lowest track, empty there
        pg.mouse.move(hx + 3, ya2)
        self.assertTrue(pg.evaluate("() => __panel._editTlUi.body.classList.contains('head-hot')"))
        cur = pg.evaluate("""([x, y]) => { const r = __panel._editTlUi.body.getRootNode(); return getComputedStyle(r.elementFromPoint(x, y)).cursor; }""", [hx + 3, ya2])
        self.assertEqual(cur, "ew-resize")
        x85, _ = pg.evaluate(WHERE, [8.5, "A2"])
        pg.mouse.down()
        pg.mouse.move(x85, ya2, steps=5)
        pg.mouse.up()
        self.assertAlmostEqual(pg.evaluate("() => __panel.currentFrame"), 204, delta=1)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelectorAll('.edit-marquee').length"), 0)
        # Over a clip the line comes first: grabbing it on c's body scrubs, nothing moves.
        hx = pg.evaluate(self.HEAD_X)
        _, yv1 = pg.evaluate(WHERE, [8.5, "V1"])
        x3, _ = pg.evaluate(WHERE, [3.0 + 0.3 / 24, "V1"])             # inside frame 72, not on its edge (pixels round)
        pg.mouse.move(hx - 2, yv1)
        pg.mouse.down()
        pg.mouse.move(x3, yv1, steps=5)
        pg.mouse.up()
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 72)
        self.assertEqual(self.cut(pg), before)
        # Further than 4 px: the clip's own (a click selects it).
        pg.mouse.move(pg.evaluate(self.HEAD_X) + 12, yv1)
        self.assertFalse(pg.evaluate("() => __panel._editTlUi.body.classList.contains('head-hot')"))
        # Parked exactly on a cut: the edit point takes the click.
        pg.evaluate("() => __panel.setFrame(96)")                       # 4 s = the cut a | c
        pg.mouse.click(pg.evaluate(self.HEAD_X) + 1, yv1)
        self.assertEqual(pg.evaluate("() => __panel._editTlEditSel && __panel._editTlEditSel.act"), "roll")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 96)
        self.assertEqual(self.errors, [])

    FAKE_AUDIO = """() => { window.__grains = []; window.__clock = 0;
        class Buf { constructor(c, n, sr) { this.numberOfChannels = c; this.length = n; this.sampleRate = sr; this.duration = n / sr; this._d = new Float32Array(n); }
          getChannelData() { return this._d; } copyToChannel(d) { this._d.set(d); } }
        class Ctx { constructor() { this.state = 'running'; this.destination = {}; window.__ctxMade = (window.__ctxMade || 0) + 1; }
          get currentTime() { return window.__clock; }
          createBuffer(c, n, sr) { return new Buf(c, n, sr); }
          createBufferSource() { const node = { buffer: null, playbackRate: { value: 1 }, connect() {}, stop() {},
              start: (when) => window.__grains.push({ rate: node.playbackRate.value, when, n: node.buffer.length }) }; return node; }
          decodeAudioData() { const b = new Buf(1, 22050 * 30, 22050); for (let i = 0; i < b.length; i++) b._d[i] = Math.sin(i / 9) * 0.5; return Promise.resolve(b); }
          resume() {} close() {} }
        window.AudioContext = Ctx;
        __panel._eaFetch = async () => new ArrayBuffer(16);
        try { localStorage.removeItem('bepic.viewer.editAudio'); } catch (_) {}
        __panel._eaState = null; }"""

    # editScrubAt at film moments on a wall clock that is ours: [t, ms, clock] each.
    FEED = """async (steps) => { const P = __panel; const real = P._editPlayNow; let ms = 0; P._editPlayNow = () => ms;
        const n0 = __grains.length;
        for (const [t, m, c] of steps) { ms = m; __clock = c; P.editScrubAt(t); await new Promise(r => setTimeout(r, 30)); }
        P._editPlayNow = real; return __grains.slice(n0).map(g => g.rate); }"""

    def test_13_audio_scrubbing_and_the_two_audio_switches(self):
        pg = self.page()
        pg.evaluate(self.FAKE_AUDIO)
        pg.evaluate("() => __panel.editTlRefresh()")
        ui = "() => { const u = __panel._editTlUi; return [u.audio.dataset.icon, u.audio.classList.contains('on'), u.scrubAudio.dataset.icon, u.scrubAudio.classList.contains('on')]; }"
        self.assertEqual(pg.evaluate(ui), ["volume", True, "scrub", True])
        svg = pg.evaluate("() => { const s = __panel._editTlUi.audio.querySelector('svg'); return [s.getAttribute('stroke'), s.getAttribute('stroke-width'), s.getAttribute('viewBox')]; }")
        self.assertEqual(svg, ["currentColor", "2", "0 0 24 24"])
        # A real drag on the ruler makes the context and asks for the sound of a.mp4 and the bed.
        x0, _ = pg.evaluate(WHERE, [0.5, "V1"])
        x1, _ = pg.evaluate(WHERE, [2.5, "V1"])
        ry = pg.evaluate("() => { const r = __panel._editTlUi.ruler.getBoundingClientRect(); return r.top + r.height / 2; }")
        pg.mouse.move(x0, ry)
        pg.mouse.down()
        pg.mouse.move(x1, ry, steps=4)
        pg.mouse.up()
        self.assertEqual(pg.evaluate("() => window.__ctxMade"), 1)
        pg.wait_for_function("() => __panel._eaHave('D:/out/a.mp4') && __panel._eaHave('D:/out/music.wav')", timeout=5000)
        # The rate follows the speed: 0.04 s in 20 ms is 2x; a creep is held to 0.25x; a fling to 4x; standing still, nothing.
        rates = pg.evaluate(self.FEED, [[1.0, 1000, 10], [1.04, 1020, 10.2], [1.041, 1040, 10.4], [1.4, 1060, 10.6], [1.4, 1080, 10.8]])
        self.assertEqual(rates, [1, 2, 0.25, 4])
        g = pg.evaluate("() => __panel._eaGrains.at(-1)")
        self.assertEqual(sorted(g["files"]), ["D:/out/a.mp4", "D:/out/music.wav"])
        # Backwards (J's way): a grain read backwards.
        pg.evaluate(self.FEED, [[2.0, 3000, 20], [1.96, 3040, 20.2]])
        self.assertEqual(pg.evaluate("() => __panel._eaGrains.at(-1).dir"), -1)
        # While playing: no grains.
        pg.evaluate("() => { __panel.isPlaying = true; }")
        self.assertEqual(pg.evaluate(self.FEED, [[1.0, 5000, 30], [1.04, 5020, 30.2]]), [])
        pg.evaluate("() => { __panel.isPlaying = false; }")
        # Shift+M: scrubbing off - silent scrubs, playback still heard.
        self.focus_timeline(pg)
        pg.keyboard.press("Shift+M")
        self.assertEqual(pg.evaluate(ui)[3], False)
        self.assertEqual(pg.evaluate(self.FEED, [[1.0, 7000, 40], [1.04, 7020, 40.2]]), [])
        pg.keyboard.press("Shift+M")
        # The speaker off (Ctrl+Shift+M, or the button): scrubbing AND playback silent, the icon volume-x, kept in localStorage.
        pg.evaluate("() => __panel.setFrame(24)")
        pg.keyboard.press("Control+Shift+M")
        self.assertEqual(pg.evaluate(ui)[:2], ["volumeOff", False])
        self.assertEqual(pg.evaluate("() => JSON.parse(localStorage.getItem('bepic.viewer.editAudio'))"), {"play": False, "scrub": True})
        self.assertEqual(pg.evaluate(self.FEED, [[1.0, 9000, 50], [1.04, 9020, 50.2]]), [])
        vol = """() => { const P = __panel; P._editPlayMix(P._ep.at); P._editPlaySounds(1, true);
            return [P.videoBase.volume, P._ep.bed[0].volume]; }"""
        self.assertEqual(pg.evaluate(vol), [0, 0])
        pg.click("bepic-viewer-panel >> .edit-audio-btn")
        self.assertEqual(pg.evaluate(ui)[:2], ["volume", True])
        self.assertEqual(pg.evaluate(vol), [1, 1])
        pg.evaluate("() => __panel._editPlaySounds(1, false)")
        # Kept for the next page.
        pg.keyboard.press("Control+Shift+M")
        pg.reload()
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(SETUP, 0)
        self.assertEqual(pg.evaluate("() => __panel._editAudio().play"), False)
        pg.evaluate("() => localStorage.removeItem('bepic.viewer.editAudio')")
        self.assertEqual(self.errors, [])

    def test_14_zoom_keys_and_buttons_keep_the_playhead_where_it_is_on_screen(self):
        pg = self.page()
        pg.evaluate("() => __panel.setFrame(9 * 24)")
        self.focus_timeline(pg)
        for how in ("Control+Equal", "Control+Equal", "button", "Control+Minus"):
            x = pg.evaluate(self.HEAD_X)
            if how == "button":
                pg.click("bepic-viewer-panel >> .edit-btn[title^='Zoom in']")
            else:
                pg.keyboard.press(how)
            self.assertAlmostEqual(pg.evaluate(self.HEAD_X), x, delta=1.5, msg=how)
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlView.zoom"), 2.25, places=3)
        # Out of view: centred after the zoom.
        pg.evaluate("() => { const s = __panel._editTlUi.scroll; s.scrollLeft = 0; }")
        pg.keyboard.press("Control+Equal")
        box = pg.evaluate("() => { const r = __panel._editTlUi.scroll.getBoundingClientRect(); return [r.left, r.width]; }")
        self.assertAlmostEqual(pg.evaluate(self.HEAD_X), box[0] + box[1] / 2, delta=2)
        # Ctrl + wheel stays about the pointer.
        x2, y2 = pg.evaluate(WHERE, [8.0, "V1"])
        pg.evaluate("() => __panel._editTlUi.scroll.scrollLeft")
        t_before = pg.evaluate("([x]) => __panel._editTlTimeAt(x)", [x2])
        pg.mouse.move(x2, y2)
        pg.keyboard.down("Control")
        pg.mouse.wheel(0, -100)
        pg.keyboard.up("Control")
        pg.wait_for_timeout(100)
        self.assertAlmostEqual(pg.evaluate("([x]) => __panel._editTlTimeAt(x)", [x2]), t_before, delta=0.05)
        self.assertEqual(self.errors, [])

    TWOUP = """() => { const t = __panel._etu; if (!t || t.root.style.display === 'none') return null;
        const side = (s) => [s.box.dataset.clip, s.box.dataset.frame, s.box.dataset.srcFrame, s.label.textContent];
        return { act: t.root.dataset.act, left: side(t.left), right: side(t.right), doc: t.root.ownerDocument === document }; }"""

    def test_15_the_trim_mode_two_up_live_while_dragging_and_after_nudges(self):
        pg = self.page()
        pg.evaluate("() => __panel.setFrame(30)")
        pps = self.px_per_second(pg)
        # Selection mode: a trim shows no two-up.
        x, y = self.x_at(pg, 4.0, dx=1)
        self.assertIsNone(self.drag(pg, x, y, x - 0.25 * pps, y, check=self.TWOUP))
        pg.evaluate("() => __panel.editTlUndo()")
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        frame = pg.evaluate("() => __panel.currentFrame")
        # A roll of a | c: a's last frame on the left, c's first on the right, live as it moves.
        got = self.drag(pg, x, y, x - 0.5 * pps, y, check=self.TWOUP)
        self.assertEqual(got["act"], "roll")
        self.assertEqual(got["left"][:3], ["V1:0", "83", "83"])        # a ends at 3.5 s: frame 83, its source frame 83
        self.assertEqual(got["right"][:3], ["V1:1", "84", ""])          # c is a still: no source frame
        self.assertIn("Out", got["left"][3])
        self.assertIn("00:00:03:11", got["left"][3])
        # Let go, the playhead is on the rolled cut (it follows the edit point selected) and the two-up rests on it.
        self.assertNotEqual(frame, 84)
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 84, "the playhead followed the cut")
        pg.wait_for_function("() => __panel._etu && __panel._etu.root.style.display !== 'none'", timeout=3000)
        self.assertEqual(pg.evaluate(self.TWOUP)["left"][:2], ["V1:0", "83"])
        # A ripple-in of b nudged with . : c's last frame and b's first (in 1 s + a frame).
        pg.mouse.click(*self.x_at(pg, 7.0, dx=5))                       # b's in (c kept its end at 7)
        self.assertEqual(pg.evaluate("() => __panel._editTlEditSel.act"), "ripple-in")
        pg.keyboard.press("Period")
        got = pg.evaluate(self.TWOUP)
        self.assertEqual(got["left"][:2], ["V1:1", "167"])
        self.assertEqual(got["right"][:3], ["V1:2", "168", str(24 + 1)])
        pg.keyboard.press("Period")
        self.assertEqual(pg.evaluate(self.TWOUP)["right"][2], str(24 + 2))
        pg.wait_for_function("() => __panel._etu.root.style.display === 'none'", timeout=3000)
        # Slip in the Trim mode (Alt+.): the slipped clip's new first and last frames.
        pg.keyboard.press("Escape")
        pg.mouse.click(*self.x_at(pg, 8.0))
        pg.evaluate("() => __panel.editTwoUpHide()")
        src_in = pg.evaluate("() => __panel._editTlCut.clips[2].in")
        pg.keyboard.press("Alt+Comma")
        got = pg.evaluate(self.TWOUP)
        self.assertEqual(got["act"], "slip")
        self.assertIn("In", got["left"][3])
        self.assertEqual(got["left"][2], str(round(src_in * 24) - 1))
        # Leaving the Trim mode puts it away at once.
        pg.keyboard.press("a")
        self.assertIsNone(pg.evaluate(self.TWOUP))
        self.assertEqual(self.errors, [])

    def test_15b_the_two_up_rests_on_a_cut_in_the_trim_mode(self):
        pg = self.page()
        self.focus_timeline(pg)
        wait_up = "() => __panel._etu && __panel._etu.root.style.display !== 'none'"
        wait_gone = "() => !__panel._etu || __panel._etu.root.style.display === 'none'"
        # Selection mode: the playhead on a cut shows nothing.
        pg.evaluate("() => __panel.setFrame(96)")
        pg.wait_for_timeout(300)
        self.assertIsNone(pg.evaluate(self.TWOUP), "Selection mode never shows it")
        pg.keyboard.press("t")
        pg.wait_for_function(wait_up, timeout=3000)
        got = pg.evaluate(self.TWOUP)
        self.assertEqual(got["left"][:2], ["V1:0", "95"])
        self.assertEqual(got["right"][:2], ["V1:1", "96"])
        pg.wait_for_timeout(1300)
        self.assertIsNotNone(pg.evaluate(self.TWOUP), "it stays: it is not a nudge's flash")
        # An arrow step off the cut puts it away; one back onto the cut brings it again.
        pg.keyboard.press("ArrowRight")
        pg.wait_for_function(wait_gone, timeout=3000)
        pg.keyboard.press("ArrowLeft")
        pg.wait_for_function(wait_up, timeout=3000)
        # Shift+S to the next steps keeps it (a cut each).
        pg.evaluate("() => __panel.setFrame(110)")
        pg.wait_for_function(wait_gone, timeout=3000)
        pg.evaluate("() => __panel.setFrame(168)")
        pg.wait_for_function(wait_up, timeout=3000)
        self.assertEqual(pg.evaluate(self.TWOUP)["left"][:2], ["V1:1", "167"])
        # Playing puts it away; stopped on a cut it is back.
        pg.evaluate("() => __panel.play()")
        pg.wait_for_function(wait_gone, timeout=3000)
        pg.evaluate("() => __panel.stop()")
        pg.evaluate("() => __panel.setFrame(96)")
        pg.wait_for_function(wait_up, timeout=3000)
        # Leaving the Trim mode puts it away; so does Selection mode afterwards.
        pg.keyboard.press("a")
        self.assertIsNone(pg.evaluate(self.TWOUP))
        pg.evaluate("() => __panel.setFrame(168)")
        pg.wait_for_timeout(300)
        self.assertIsNone(pg.evaluate(self.TWOUP))
        self.assertEqual(self.errors, [])

    PICK = "() => { const t = __panel._etu; const e = __panel._editTlEditSel; return { pick: t && t.root.dataset.pick, act: e && e.act, side: e && e.side, sel: e && e.sel && __panel._etu && (e.sel.kind + ':' + (e.sel.i)), lens: __panel._editTlCut.clips.map(c => Math.round(c.length * 24)) }; }"

    def pane(self, pg, side):
        box = pg.evaluate("(s) => { const r = __panel._etu[s].box.querySelector('.edit-twoup-pic').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }", side)
        return box

    def test_15c_a_click_on_a_two_up_pane_selects_that_side_of_the_cut(self):
        pg = self.page()
        self.focus_timeline(pg)
        wait_up = "() => __panel._etu && __panel._etu.root.style.display !== 'none'"
        pg.keyboard.press("t")
        pg.evaluate("() => __panel.setFrame(96)")
        pg.wait_for_function(wait_up, timeout=3000)
        base = pg.evaluate(self.PICK)
        self.assertEqual(base["pick"], "")
        # Left pane: the outgoing clip's out; , trims it (a ripple out: a one frame shorter).
        pg.mouse.click(*self.pane(pg, "left"))
        got = pg.evaluate(self.PICK)
        self.assertEqual((got["pick"], got["act"], got["side"]), ("left", "trim-out", "end"))
        self.assertIsNotNone(pg.evaluate(self.TWOUP), "the two-up stays up")
        pg.keyboard.press("Comma")
        got = pg.evaluate(self.PICK)
        self.assertEqual(got["lens"][0], base["lens"][0] - 1)
        self.assertEqual(got["lens"][1], base["lens"][1])
        # Back to the cut (the nudge moved it), the right pane: the incoming clip's in.
        pg.evaluate("() => __panel.editTlUndo()")
        pg.evaluate("() => __panel.setFrame(96)")
        pg.wait_for_function(wait_up, timeout=3000)
        pg.mouse.click(*self.pane(pg, "right"))
        got = pg.evaluate(self.PICK)
        self.assertEqual((got["pick"], got["side"]), ("right", "start"))
        pg.keyboard.press("Period")
        got2 = pg.evaluate(self.PICK)
        self.assertEqual(got2["lens"][0], base["lens"][0])
        self.assertEqual(got2["lens"][1], base["lens"][1] - 1)
        pg.evaluate("() => __panel.editTlUndo()")
        pg.evaluate("() => __panel.setFrame(96)")
        pg.wait_for_function(wait_up, timeout=3000)
        # The side picked alone, clicked again: both (a roll); a pane while both: that side.
        pg.evaluate("() => { __panel._editTlEditSel = null; __panel.editTlRefresh(); }")
        pg.mouse.click(*self.pane(pg, "right"))
        self.assertEqual(pg.evaluate(self.PICK)["pick"], "right")
        pg.mouse.click(*self.pane(pg, "right"))
        self.assertEqual((pg.evaluate(self.PICK)["pick"], pg.evaluate(self.PICK)["act"]), ("both", "roll"))
        pg.mouse.click(*self.pane(pg, "left"))
        self.assertEqual(pg.evaluate(self.PICK)["pick"], "left")
        # The film's start: the missing left side does nothing, the right one picks.
        pg.evaluate("() => __panel.setFrame(0)")
        pg.wait_for_function(wait_up, timeout=3000)
        pg.evaluate("() => { __panel._editTlEditSel = null; __panel.editTlRefresh(); }")
        pg.mouse.click(*self.pane(pg, "left"))
        self.assertIsNone(pg.evaluate(self.PICK)["act"])
        pg.mouse.click(*self.pane(pg, "right"))
        self.assertEqual(pg.evaluate(self.PICK)["pick"], "right")
        self.assertEqual(self.errors, [])

    def test_15d_two_up_pane_clicks_in_the_pop_out(self):
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        self.fit(pg)
        pg.evaluate("() => __panel._editTlUi.body.focus()")
        win.keyboard.press("t")
        pg.evaluate("() => __panel.setFrame(96)")
        pg.wait_for_function("() => __panel._etu && __panel._etu.root.style.display !== 'none'", timeout=3000)
        base = pg.evaluate(self.PICK)
        win.mouse.click(*self.pane(pg, "left"))
        self.assertEqual(pg.evaluate(self.PICK)["pick"], "left")
        win.keyboard.press("Comma")
        self.assertEqual(pg.evaluate(self.PICK)["lens"][0], base["lens"][0] - 1)
        pg.evaluate("() => __panel.editTlUndo()")
        pg.evaluate("() => __panel.setFrame(96)")
        pg.wait_for_function("() => __panel._etu && __panel._etu.root.style.display !== 'none'", timeout=3000)
        win.mouse.click(*self.pane(pg, "right"))
        self.assertEqual(pg.evaluate(self.PICK)["pick"], "right")
        self.assertFalse(pg.evaluate(self.TWOUP)["doc"])
        self.assertEqual(self.errors, [])

    def test_16_popped_out_insert_line_grab_audio_switch_zoom_and_two_up(self):
        pg = self.page()
        pg.evaluate("() => { __media['D:/in/house.png'] = { duration: 0, still: true }; }")
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        self.fit(pg)
        # The insert.
        pg.evaluate(self.NODES, [[2, 100, "house.png"]])
        pg.evaluate("() => __panel.setFrame(48)")
        pg.evaluate("() => __panel._editTlAddSelected()")
        pg.wait_for_function("() => __panel._editTlCut.clips.length === 5", timeout=5000)
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 5 * 24)
        # The line grabbed low on the tracks.
        hx = pg.evaluate(self.HEAD_X)
        _, ya2 = pg.evaluate(WHERE, [5.0, "A2"])
        x8, _ = pg.evaluate(WHERE, [8.5, "A2"])
        win.mouse.move(hx + 2, ya2)
        win.mouse.down()
        win.mouse.move(x8, ya2, steps=4)
        win.mouse.up()
        self.assertAlmostEqual(pg.evaluate("() => __panel.currentFrame"), 204, delta=1)
        # The audio switch by key, the zoom about the playhead.
        win.mouse.click(*pg.evaluate(WHERE, [1.0, "V2"]))
        win.keyboard.press("Control+Shift+M")
        self.assertFalse(pg.evaluate("() => __panel._editAudio().play"))
        win.keyboard.press("Control+Shift+M")
        x = pg.evaluate(self.HEAD_X)
        win.keyboard.press("Control+Equal")
        self.assertAlmostEqual(pg.evaluate(self.HEAD_X), x, delta=1.5)
        win.keyboard.press("Shift+Z")
        # The two-up, in the pop-out's own document.
        win.keyboard.press("t")
        x, y = self.x_at(pg, 2.0, dx=1)                                 # the cut a | house
        win.mouse.move(x, y)
        win.mouse.down()
        win.mouse.move(x - 20, y, steps=3)
        got = pg.evaluate(self.TWOUP)
        win.mouse.up()
        self.assertEqual(got["act"], "roll")
        self.assertFalse(got["doc"], "drawn in the pop-out")
        self.assertEqual(pg.evaluate("() => __panel._etu.root.ownerDocument === __panel._editTlUi.body.ownerDocument"), True)
        self.assertIsNone(pg.evaluate(self.TWOUP))
        # At rest on that cut the pop-out shows it too, and keeps it.
        pg.evaluate("() => __panel.setFrame(Math.round(__panel._editTlCut.clips[0].length * 24))")
        pg.wait_for_function("() => __panel._etu && __panel._etu.root.style.display !== 'none'", timeout=3000)
        pg.wait_for_timeout(1300)
        got = pg.evaluate(self.TWOUP)
        self.assertIsNotNone(got)
        self.assertFalse(got["doc"])
        self.assertEqual(self.errors, [])

    # ── filmstrips of the pieces of a longer film ──

    PIECES = """() => [...__panel._editTlUi.rows.querySelectorAll('.edit-track[data-track="V1"] .edit-shot')].map(b => {
        const c = b._media.clip; return { key: b.dataset.key, in: c.in, out: c.in + c.length, tiles: b._emTiles || [], sheet: b._emSheet || null, wave: b._emWaveRange || null }; })"""

    def test_17_pieces_of_a_long_film_show_their_own_frames_and_sound(self):
        pg = self.page()
        pg.evaluate("""() => { const P = __panel; __media['D:/out/long.mp4'] = { duration: 10, audio: true, video: true };
            P._editTlApply({ ...P._editTlCut, clips: [{ file: 'D:/out/long.mp4', name: 'long', in: 0, length: 10, transition: 0, color: '', volume: 1 }], tracks: [], sound: [] });
            P._editTlHistories[P._editTlTab] = { past: [], future: [] }; window.__strips = []; }""")
        self.settle(pg)
        # The blade at 3 s and at 7 s: three pieces of one file.
        for f in (72, 168):
            pg.evaluate(f"() => __panel.setFrame({f})")
            pg.evaluate("() => __panel._editTlUi.body.focus()")
            pg.keyboard.press("Control+b")
        pg.evaluate("() => { __panel._editTlSel = null; __panel.editTlRefresh(); }")
        pg.wait_for_function("() => __panel._emPending === 0 && [...__panel._editTlUi.rows.querySelectorAll('.edit-track[data-track=\"V1\"] .edit-shot')].every(b => b._emSheet && b._emSheet.exact)", timeout=10000)
        pieces = pg.evaluate(self.PIECES)
        self.assertEqual([(p["in"], p["out"]) for p in pieces], [(0, 3), (3, 7), (7, 10)])
        for p in pieces:
            self.assertTrue(p["tiles"], p)
            # Every tile is a moment of the piece's own part of the file ...
            self.assertTrue(all(p["in"] <= t <= p["out"] for t in p["tiles"]), p)
            # ... from a sheet of that part (or the whole file for a piece that is most of it).
            self.assertLessEqual(p["sheet"]["start"], p["in"] + 1e-6)
            self.assertGreaterEqual(p["sheet"]["end"], p["out"] - 1e-6)
            # The waveform reads the same part of the sound.
            self.assertGreaterEqual(p["wave"][0], p["in"] - 1e-6)
            self.assertLessEqual(p["wave"][1], p["out"] + 1e-6)
        windows = [(w["start"], w["end"]) for w in pg.evaluate("() => __strips") if w["path"] == "D:/out/long.mp4" and w["start"] is not None]
        self.assertTrue(any(a >= 2 for a, _ in windows), windows)       # the later pieces asked for their own parts
        # Two pieces of one file show different frames.
        self.assertNotEqual(pieces[0]["tiles"][0], pieces[2]["tiles"][0])
        # A slip (Alt+Shift+.: a second of source) moves the piece's frames and sound with it; a drag asks for nothing new.
        pg.mouse.click(*pg.evaluate(WHERE, [5.0, "V1"]))
        pg.keyboard.press("Alt+Shift+Comma")
        self.settle(pg)
        pg.wait_for_function("() => { const b = __panel._editTlUi.rows.querySelector('[data-key=\"V1:1\"]'); return !!(b && b._emSheet && b._emSheet.exact); }", timeout=10000)
        mid = pg.evaluate(self.PIECES)[1]
        self.assertEqual((mid["in"], mid["out"]), (2, 6))
        self.assertAlmostEqual(mid["tiles"][0], pieces[1]["tiles"][0] - 1, places=2)
        self.assertAlmostEqual(mid["wave"][0], pieces[1]["wave"][0] - 1, places=2)
        n = pg.evaluate("() => __strips.length")
        pg.evaluate("""() => { const P = __panel; P._editTlDragging = true; P._editTlApply(P._editTlCut); const c = { ...P._editTlCut, clips: P._editTlCut.clips.map((x, i) => i === 1 ? { ...x, in: 0.3 } : x) };
            P._editTlCut = c; P.editTlRefresh(); }""")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate("() => __strips.length"), n, "nothing asked for during a drag")
        self.assertEqual(pg.evaluate(self.PIECES)[1]["tiles"][0] < 1.0, True, "drawn from what covers it meanwhile")
        pg.evaluate("() => { __panel._editTlDragging = false; __panel.editTlRefresh(); }")
        self.settle(pg)
        self.assertEqual(self.errors, [])

    # ── several selected clips moved together, over what is there ──

    def group_page(self):
        pg = self.page()
        self.on_v2(pg, ["v", 1, 1])
        self.on_a2(pg, ["s", 5, 2])
        pg.evaluate("() => __panel.setFrame(262)")            # the playhead out of the way (its line takes presses)
        self.focus_timeline(pg)
        pg.keyboard.press("n")                                  # no snapping: plain distances
        return pg

    def pick(self, pg, *spots):
        pg.mouse.click(*pg.evaluate(WHERE, list(spots[0])))
        pg.keyboard.down("Control")
        for t in spots[1:]:
            pg.mouse.click(*pg.evaluate(WHERE, list(t)))
        pg.keyboard.up("Control")

    def pps(self, pg):
        return pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0]

    def test_18_a_group_moves_left_past_a_clip_and_lies_over_it_leaving_gaps(self):
        pg = self.group_page()
        self.pick(pg, (5.5, "V1"), (9.0, "V1"))                # c (4..7) and b (7..11); a (0..4) is not selected
        n = self.undo_len(pg)
        x, y = pg.evaluate(WHERE, [5.5, "V1"])
        self.drag(pg, x, y, x - 3 * self.pps(pg), y)
        f = self.frames(pg)["v1"]
        # c at 1 s, b at 4 s: a is cut back to 0..1 under them; the gap where b was is gone (nothing after it).
        self.assertEqual([r[0] for r in f], ["a", "c", "b"])
        self.assertAlmostEqual(f[0][2], 24, delta=1)
        self.assertAlmostEqual(f[1][1], 24, delta=1)
        self.assertAlmostEqual(f[2][1], 96, delta=1)
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual(pg.evaluate(self.SEL), ["V1:1", "V1:2"], "still both selected")
        # To the right, past b: a and c from 0 and 4 to 6 and 10 - b (7..11) is covered.
        pg.evaluate("() => __panel.editTlUndo()")
        self.pick(pg, (2.0, "V1"), (5.5, "V1"))
        x, y = pg.evaluate(WHERE, [2.0, "V1"])
        self.drag(pg, x, y, x + 6 * self.pps(pg), y)
        f = self.frames(pg)["v1"]
        self.assertEqual([r[0] for r in f], ["a", "c"], "b (7..11) lay under them: covered, gone")
        self.assertAlmostEqual(f[0][1], 144, delta=1, msg="a gap before a, where it and c were")
        self.assertAlmostEqual(f[1][1], 240, delta=1)
        # A shorter move right: b's tail stays after c.
        pg.evaluate("() => __panel.editTlUndo()")
        self.pick(pg, (2.0, "V1"), (5.5, "V1"))
        x, y = pg.evaluate(WHERE, [2.0, "V1"])
        self.drag(pg, x, y, x + 2 * self.pps(pg), y)
        f = self.frames(pg)["v1"]
        self.assertEqual([r[0] for r in f], ["a", "c", "b"])
        self.assertEqual([round(r[1]) for r in f], [48, 144, 216], "c (6..9) over b's head: b from 9 to 11")
        # Held only at the start of the film.
        pg.evaluate("() => __panel.editTlUndo()")
        self.pick(pg, (5.5, "V1"), (9.0, "V1"))
        x, y = pg.evaluate(WHERE, [5.5, "V1"])
        self.drag(pg, x, y, x - 10 * self.pps(pg), y)
        f = self.frames(pg)["v1"]
        self.assertEqual(f[0][:2], ["c", 0])
        self.assertEqual(self.errors, [])

    def test_18_a_group_on_video_and_sound_tracks_moves_in_time_and_by_rows(self):
        pg = self.group_page()
        # c on V1 with the sound clip s (A2, 5..7): 2 s left - c over a, s with it.
        self.pick(pg, (5.5, "V1"), (6.0, "A2"))
        x, y = pg.evaluate(WHERE, [5.5, "V1"])
        self.drag(pg, x, y, x - 2 * self.pps(pg), y)
        f = self.frames(pg)
        self.assertEqual([r[0] for r in f["v1"]], ["a", "c", "b"])
        self.assertAlmostEqual(f["v1"][1][1], 48, delta=1)
        self.assertAlmostEqual(f["tracks"]["A2"][0][1], 72, delta=1)
        pg.evaluate("() => __panel.editTlUndo()")
        # c (V1) and v (V2) up one row: c onto V2 (over nothing there), v onto a new V3; s stays where it is.
        self.pick(pg, (5.5, "V1"), (1.5, "V2"))
        x, y = pg.evaluate(WHERE, [5.5, "V1"])
        _, y2 = pg.evaluate(WHERE, [5.5, "V2"])
        self.drag(pg, x, y, x, y2)
        f = self.frames(pg)
        self.assertEqual([r[0] for r in f["v1"]], ["a", "b"])
        self.assertEqual([r[0] for r in f["tracks"]["V2"]], ["c"])
        self.assertEqual([r[0] for r in f["tracks"]["V3"]], ["v"])
        self.assertAlmostEqual(f["tracks"]["V2"][0][1], 96, delta=1)
        self.assertEqual(pg.evaluate(self.SEL), ["V2:0", "V3:0"])
        self.assertEqual(self.errors, [])

    def test_18_a_group_with_a_linked_sound_and_the_keys_in_both_modes(self):
        pg = self.group_page()
        # a's sound split off onto a sound track: a and c selected and moved, a's sound goes with it in time.
        pg.mouse.click(*pg.evaluate(WHERE, [2.0, "V1"]))
        pg.keyboard.press("Control+Alt+l")
        self.fit(pg)
        pg.mouse.click(*pg.evaluate(WHERE, [2.0, "V1"]))
        pg.keyboard.press("Control+Alt+l")                     # linked again: picture and sound one clip
        self.assertFalse(pg.evaluate("() => !!__panel._editTlCut.clips[0].unlinked"))
        sound = [k for k, v in self.frames(pg)["tracks"].items() if any(r[0] == "a" for r in v)][0]
        self.pick(pg, (2.0, "V1"), (5.5, "V1"))
        x, y = pg.evaluate(WHERE, [2.0, "V1"])
        self.drag(pg, x, y, x + 1 * self.pps(pg), y)
        f = self.frames(pg)
        self.assertAlmostEqual(f["v1"][0][1], 24, delta=1)
        a_snd = [r for r in f["tracks"][sound] if r[0] == "a"][0]
        self.assertAlmostEqual(a_snd[1], 24, delta=1, msg="the linked sound went along")
        # , / . on the selection: all move a frame, past what is there; Shift: a second.
        n = self.undo_len(pg)
        pg.keyboard.press("Shift+Comma")
        f = self.frames(pg)
        self.assertAlmostEqual(f["v1"][0][1], 0, delta=1)
        self.assertEqual(self.undo_len(pg), n + 1)
        # The Trim mode: the keys move them together too (one clip alone would slide).
        pg.keyboard.press("t")
        pg.keyboard.press("Shift+Period")
        pg.keyboard.press("Shift+Period")
        pg.keyboard.press("Shift+Period")
        f = self.frames(pg)
        names = [r[0] for r in f["v1"]]
        self.assertEqual(names[:2], ["a", "c"])
        self.assertAlmostEqual(f["v1"][0][1], 72, delta=1)
        self.assertAlmostEqual(f["v1"][1][1], 168, delta=1, msg="c over b, which is cut back to after it")
        self.assertEqual(self.errors, [])

    def test_18_a_mixed_group_moved_up_takes_the_picture_up_and_leaves_the_sound(self):
        pg = self.group_page()
        self.pick(pg, (5.5, "V1"), (6.0, "A2"))
        x, y = pg.evaluate(WHERE, [5.5, "V1"])
        _, y2 = pg.evaluate(WHERE, [5.5, "V2"])
        self.drag(pg, x, y, x, y2)
        f = self.frames(pg)
        self.assertEqual(sorted(r[0] for r in f["tracks"]["V2"]), ["c", "v"])
        self.assertEqual([r[0] for r in f["tracks"]["A2"]], ["s"], "the sound stays on its sound track")
        self.assertEqual([r[0] for r in f["v1"]], ["a", "b"])
        self.assertEqual(self.errors, [])

    # ── Shift+S / Shift+A in three steps, play around edit ──

    def test_19_shift_s_and_shift_a_step_left_both_right_and_comma_period_trim_that(self):
        pg = self.page()
        pg.evaluate("() => __panel.setFrame(24)")
        self.focus_timeline(pg)
        pg.evaluate("() => __panel.setFrame(24)")
        seen = []
        for _ in range(4):
            pg.keyboard.press("Shift+KeyS")
            seen.append([pg.evaluate("() => __panel.currentFrame"), sorted(m[0] for m in pg.evaluate(self.MARKS)),
                         pg.evaluate("() => __panel._editTlEditSel.act")])
        self.assertEqual(seen, [[96, ["end"], "trim-out"], [96, ["end", "start"], "roll"], [96, ["start"], "trim-in"], [168, ["end"], "trim-out"]])
        for _ in range(3):
            pg.keyboard.press("Shift+KeyA")
        self.assertEqual(pg.evaluate("() => __panel._editTlEditSel.act"), "trim-out")
        self.assertEqual(sorted(m[0] for m in pg.evaluate(self.MARKS)), ["end"])
        # , / . trim exactly that side: the left - a's out; Ctrl+Z.
        pg.keyboard.press("Comma")
        f = self.frames(pg)["v1"]
        self.assertEqual((f[0][2], f[1][1]), (95, 96))
        pg.keyboard.press("Control+z")
        # Both: a roll.
        pg.keyboard.press("Shift+KeyS")
        pg.keyboard.press("Comma")
        f = self.frames(pg)["v1"]
        self.assertEqual((f[0][2], f[1][1]), (95, 95))
        pg.keyboard.press("Control+z")
        # The right side: c's in (Selection mode: a gap opens before it).
        pg.keyboard.press("Shift+KeyS")
        pg.keyboard.press("Period")
        f = self.frames(pg)["v1"]
        self.assertEqual((f[0][2], f[1][1]), (96, 97))
        self.assertEqual(self.errors, [])

    PLAYED = """async (ms) => { const P = __panel, seen = []; const t0 = performance.now();
        await new Promise((done) => { const tick = () => { seen.push(P.currentFrame); if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
        return seen; }"""

    def test_19_play_around_edit_loops_a_second_either_side_and_follows_a_nudge(self):
        pg = self.page()
        self.stills_cut(pg)                                    # s1 0..2, s2 2..4: stills, played on the wall clock
        pg.evaluate("() => __panel._editTlUi.body.focus()")
        pg.keyboard.press("t")
        pg.mouse.click(*self.x_at(pg, 2.0, dx=1))               # the cut: a roll, selected
        self.assertEqual(pg.evaluate("() => __panel._editTlEditSel.act"), "roll")
        band = "() => { const a = __panel._editTlUi.around; return a && a.style.display !== 'none' ? [Number(a.dataset.from), Number(a.dataset.to)] : null; }"
        self.assertEqual(pg.evaluate(band), [24, 71])
        pg.evaluate("() => __panel.play()")
        seen = pg.evaluate(self.PLAYED, 2600)
        self.assertEqual(seen[0], 24, "from the pre-roll")
        self.assertTrue(all(24 <= f <= 71 for f in seen), (min(seen), max(seen)))
        self.assertTrue(any(b < a for a, b in zip(seen, seen[1:])), "it loops")
        self.assertIsNone(pg.evaluate(self.TWOUP), "the film plays, not the two-up")
        # A nudge while it plays: the cut a frame later, the loop with it; the film plays on.
        pg.keyboard.press("Period")
        self.assertTrue(pg.evaluate("() => __panel.isPlaying"))
        seen = pg.evaluate(self.PLAYED, 2400)
        self.assertTrue(all(25 <= f <= 72 for f in seen[3:]), (min(seen), max(seen)))
        self.assertIn(72, seen)
        self.assertEqual(pg.evaluate(band), [25, 72])
        pg.evaluate("() => __panel.stop()")
        # Stopped, a nudge shows the two-up again.
        pg.keyboard.press("Period")
        self.assertIsNotNone(pg.evaluate(self.TWOUP))
        # The edit let go (Esc): the band and the window go, the in / out loop is back.
        pg.keyboard.press("Escape")
        self.assertIsNone(pg.evaluate(band))
        self.assertIsNone(pg.evaluate("() => __panel._editPlayAround()"))
        # The film's start holds the window: a cut at 0.5 s plays from 0.
        pg.evaluate("() => { const P = __panel; P._editTlApply({ ...P._editTlCut, clips: [{ ...P._editTlCut.clips[0], length: 0.5 }, P._editTlCut.clips[1]] }); }")
        pg.keyboard.press("t")
        pg.evaluate("() => { const P = __panel; P._editTlEditSel = { act: 'roll', sel: { kind: 'clip', i: 1 }, side: 'start', a: { kind: 'clip', i: 0 }, b: { kind: 'clip', i: 1 } }; P.editTlRefresh(); }")
        self.assertEqual(pg.evaluate("() => { const r = __panel._editPlayAround(); return [r.min, r.max]; }"), [0, 35])
        self.assertEqual(self.errors, [])

    # ── D: a clip switched off ──

    def test_20_d_switches_a_clip_off_and_the_track_under_or_black_plays_there(self):
        pg = self.page()
        self.on_v2(pg, ["v", 5, 1])                            # over c (4..7), from 5 to 6
        pg.evaluate("() => __panel.setFrame(262)")
        self.focus_timeline(pg)
        pg.mouse.click(*pg.evaluate(WHERE, [5.5, "V2"]))
        n = self.undo_len(pg)
        pg.keyboard.press("d")
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].disabled"))
        self.assertEqual(self.undo_len(pg), n + 1)
        blk = "(k) => { const b = __panel._editTlUi.rows.querySelector(`[data-key='${k}']`); return [b.classList.contains('disabled'), getComputedStyle(b).opacity]; }"
        self.assertEqual(pg.evaluate(blk, "V2:0"), [True, "0.42"])
        shown = "(f) => { __panel.setFrame(f); const at = __panel._ep && __panel._ep.at; return at ? (at.clip ? at.key : '') : null; }"
        self.assertEqual(pg.evaluate(shown, 132), "V1:1", "the shot under it shows")
        # The shot under it off too: black there.
        pg.mouse.click(*pg.evaluate(WHERE, [4.5, "V1"]))
        pg.evaluate("() => __panel.setFrame(262)")
        pg.keyboard.press("d")
        self.assertEqual(pg.evaluate(shown, 132), "")
        self.assertEqual(pg.evaluate(blk, "V1:1")[0], True)
        # The menu says it; D again brings it back; Ctrl+Z as well.
        items = self.menu_has(pg, *pg.evaluate(WHERE, [4.5, "V1"]))
        self.assertIn("Enable clip (D)", items)
        pg.keyboard.press("Escape")
        pg.mouse.click(5, 5)
        pg.mouse.click(*pg.evaluate(WHERE, [4.5, "V1"]))
        pg.keyboard.press("d")
        self.assertEqual(pg.evaluate(blk, "V1:1")[0], False)
        self.assertEqual(pg.evaluate(shown, 120), "V1:1")
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(blk, "V1:1")[0], True)
        # Saved: the file says it.
        pg.evaluate("() => __panel._editTlSave()")
        pg.wait_for_function("() => (window.__saves || []).length > 0", timeout=5000)
        sent = pg.evaluate("() => window.__saves.at(-1).edit")
        self.assertEqual([bool(c.get("disabled")) for c in sent["clips"]], [False, True, False])
        self.assertTrue(sent["tracks"][0]["clips"][0]["disabled"])
        self.assertEqual(self.errors, [])

    # ── keyframes ──

    ROW = """(label) => [...__panel.editInspectorPanel.querySelectorAll('.insp-row')].find(r => r.querySelector('.insp-label').textContent === label)"""
    DIAMOND = "(label) => (" + ROW + ")(label).querySelector('.insp-diamond').dataset.state"
    CLICK = "([label, cls]) => (" + ROW + ")(label).querySelector(cls).click()"
    BOX = "([label, cls]) => { const e = (" + ROW + ")(label).querySelector(cls); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }"
    OPKEYS = "() => (__panel._editTlCut.clips[0].fx && __panel._editTlCut.clips[0].fx.keys && __panel._editTlCut.clips[0].fx.keys.op) || []"
    KEYMARKS = "() => [...__panel._editTlUi.rows.querySelectorAll(\"[data-key='V1:0'] .edit-keymark\")].map(m => Number(m.dataset.t))"
    KEYMARK = "(k) => { const m = [...__panel._editTlUi.rows.querySelectorAll(\"[data-key='V1:0'] .edit-keymark\")][k].getBoundingClientRect(); return [m.left + m.width / 2, m.top + m.height / 2]; }"

    def key_page(self):
        pg = self.page()
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 0 }; P._editInspTab = 'video'; P.setFrame(24); P.editTlRefresh(); }")
        return pg

    def test_21_keyframes_in_the_inspector_auto_key_jump_ease_and_the_preview(self):
        pg = self.key_page()
        self.assertEqual(pg.evaluate(self.DIAMOND, "Opacity"), "none")
        self.assertEqual(pg.evaluate(self.DIAMOND, "Zoom"), "none")
        n = self.undo_len(pg)
        pg.evaluate(self.CLICK, ["Opacity", ".insp-diamond"])            # a key at 1 s into the clip, its value there
        self.assertEqual(pg.evaluate(self.OPKEYS), [{"t": 1, "v": 1}])
        self.assertEqual(pg.evaluate(self.DIAMOND, "Opacity"), "on")
        self.assertEqual(self.undo_len(pg), n + 1)
        # Elsewhere: lit, not filled; a change there makes a key by itself (auto-key).
        pg.evaluate("() => __panel.setFrame(72)")
        self.assertEqual(pg.evaluate(self.DIAMOND, "Opacity"), "has")
        pg.evaluate("() => { const i = (" + self.ROW + ")('Opacity').querySelector('input.insp-num'); i.value = '40'; i.dispatchEvent(new Event('change')); }")
        self.assertEqual(pg.evaluate(self.OPKEYS), [{"t": 1, "v": 1}, {"t": 3, "v": 0.4}])
        self.assertEqual(pg.evaluate(self.DIAMOND, "Opacity"), "on")
        # The preview draws the animation, frame by frame.
        op = "(f) => { __panel.setFrame(f); const s = __panel.videoBase.style.opacity; return s === '' ? 1 : Number(s); }"
        self.assertAlmostEqual(pg.evaluate(op, 72), 0.4, places=2)
        self.assertAlmostEqual(pg.evaluate(op, 48), 1 - 0.6 * (1 + 0.5 / 24) / 2, places=2)
        self.assertAlmostEqual(pg.evaluate(op, 12), 1.0, places=2)
        # The Inspector shows the number at the playhead.
        pg.evaluate("() => __panel.setFrame(48)")
        shown = pg.evaluate("() => Number((" + self.ROW + ")('Opacity').querySelector('input.insp-num').value)")
        self.assertAlmostEqual(shown, 70, delta=0.6)
        # The arrows go from key to key.
        pg.evaluate(self.CLICK, ["Opacity", ".insp-keybtn.prev"])
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 24)
        pg.evaluate(self.CLICK, ["Opacity", ".insp-keybtn.next"])
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 72)
        # Right-click the diamond: how it goes on - ease in.
        pg.evaluate("() => __panel.setFrame(24)")
        pg.mouse.click(*pg.evaluate(self.BOX, ["Opacity", ".insp-diamond"]), button="right")
        pg.locator(".previz-menu-item", has_text="Ease in").first.click()
        self.assertEqual(pg.evaluate(self.OPKEYS)[0], {"t": 1, "v": 1, "i": "in"})
        self.assertAlmostEqual(pg.evaluate(op, 48), 1 - 0.6 * ((1 + 0.5 / 24) / 2) ** 2, places=2)
        # The diamond again takes the key away (undone), the row's reset takes all its keys.
        pg.evaluate("() => __panel.setFrame(72)")
        pg.evaluate(self.CLICK, ["Opacity", ".insp-diamond"])
        self.assertEqual(len(pg.evaluate(self.OPKEYS)), 1)
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(len(pg.evaluate(self.OPKEYS)), 2)
        pg.evaluate(self.CLICK, ["Opacity", ".insp-reset"])
        self.assertEqual(pg.evaluate(self.OPKEYS), [])
        self.assertEqual(self.errors, [])

    def test_21_keyframe_marks_on_the_clip_drag_delete_ease_and_the_blade(self):
        pg = self.key_page()
        pg.evaluate("""() => { const P = __panel; const c = P._editTlCut; P._editTlSel = { kind: 'clip', i: 0 };
            P._editTlApply({ ...c, clips: c.clips.map((x, i) => i ? x : { ...x, fx: { keys: { op: [{ t: 1, v: 0 }, { t: 3, v: 1 }], zx: [{ t: 3, v: 2 }] } } }) }); P.setFrame(250); }""")
        self.assertEqual(pg.evaluate(self.KEYMARKS), [1, 3])
        pps = pg.evaluate(WHERE, [1.0, "V1"])[0] - pg.evaluate(WHERE, [0.0, "V1"])[0]
        # Dragged from 3 s to 2 s of the clip: every key of that moment moves (onto a frame), one undo step.
        n = self.undo_len(pg)
        x0, y = pg.evaluate(self.KEYMARK, 1)
        self.drag(pg, x0, y, x0 - pps, y)
        self.assertEqual(pg.evaluate(self.KEYMARKS), [1, 2])
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[0].fx.keys.zx"), [{"t": 2, "v": 2}])
        self.assertEqual(self.undo_len(pg), n + 1)
        # Right-click: hold; click + Del takes the moment's keys away, not the clip.
        x1, y1 = pg.evaluate(self.KEYMARK, 0)
        pg.mouse.click(x1, y1, button="right")
        pg.locator(".previz-menu-item", has_text="Hold").first.click()
        self.assertEqual(pg.evaluate(self.OPKEYS)[0], {"t": 1, "v": 0, "i": "hold"})
        pg.mouse.click(x1, y1)
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate(self.KEYMARKS), [2])
        self.assertEqual(len(self.cut(pg)["v1"]), 3, "the clip stays")
        # The blade through it: the keys divided, a key at the cut on both pieces.
        pg.evaluate("() => __panel.setFrame(12)")
        pg.keyboard.press("Control+b")
        self.assertEqual(pg.evaluate("() => [__panel._editTlCut.clips[0].fx.keys.op, __panel._editTlCut.clips[1].fx.keys.op]"),
                         [[{"t": 0.5, "v": 1}], [{"t": 0, "v": 1}, {"t": 1.5, "v": 1}]])
        self.assertEqual(self.errors, [])

    def test_21_popped_out_the_diamond_and_the_marks(self):
        pg = self.key_page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 0 }; P._editInspTab = 'video'; P.setFrame(24); P.editTlRefresh(); }")
        win.mouse.click(*pg.evaluate(self.BOX, ["Rotation Angle", ".insp-diamond"]))
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[0].fx.keys.rot"), [{"t": 1, "v": 0}])
        self.assertEqual(pg.evaluate(self.KEYMARKS), [1])
        self.assertEqual(self.errors, [])

    # ── several clips selected: the Inspector changes all of them ──

    def multi_page(self, tab="video"):
        """V1: a (film, 0-4), c (a still, 4-7), b (film, 7-11); V2: v (3-8); A2: s (0-6). Selected: a, c, b (b last)."""
        pg = self.page()
        self.on_v2(pg, ["v", 3, 5])
        self.on_a2(pg, ["s", 0, 6])
        pg.evaluate("""(tab) => { const P = __panel; P._editInspTab = tab;
            P._editTlSetSelList([{ kind: 'clip', i: 0 }, { kind: 'clip', i: 1 }, { kind: 'clip', i: 2 }], { kind: 'clip', i: 2 }); P.setFrame(24); P.editTlRefresh(); }""", tab)
        return pg

    def reselect(self, pg):
        """Undo lets the selection go; the three V1 clips again, the last one the primary."""
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList([{ kind: 'clip', i: 0 }, { kind: 'clip', i: 1 }, { kind: 'clip', i: 2 }], { kind: 'clip', i: 2 }); P.editTlRefresh(); }")

    SETROW = "([label, v]) => { const i = (" + ROW + ")(label).querySelector('input.insp-num'); i.value = String(v); i.dispatchEvent(new Event('change')); }"
    FXOF = "(i) => __panel._editTlCut.clips[i].fx || {}"
    VOLS = "() => { const c = __panel._editTlCut; return [c.clips[0].volume, c.clips[1].volume, c.clips[2].volume, c.tracks[1].clips[0].volume]; }"

    def test_22b_undo_and_redo_keep_the_selected_clips_selected(self):
        pg = self.multi_page()
        inspector = "() => __panel.editInspectorPanel.querySelector('.insp-multi').textContent.slice(0, 7)"
        want = ["V1:0", "V1:1", "V1:2"]
        primary = "() => { const s = __panel._editTlSel; return s.kind + ':' + s.i; }"
        pg.evaluate(self.SETROW, ["Opacity", 40])
        self.focus_timeline(pg)                  # the click on empty room clears the selection, as for a user
        self.reselect(pg)
        pg.keyboard.press("Control+z")
        self.assertIsNone(pg.evaluate(self.FXOF, 0).get("op"))
        self.assertEqual(pg.evaluate(self.SEL), want)
        self.assertEqual(pg.evaluate(inspector), "3 clips")
        self.assertEqual(pg.evaluate(primary), "clip:2")
        pg.keyboard.press("Control+Shift+z")
        self.assertAlmostEqual(pg.evaluate(self.FXOF, 0).get("op"), 0.4, places=3)
        self.assertEqual(pg.evaluate(self.SEL), want)
        self.assertEqual(pg.evaluate(inspector), "3 clips")
        # Undoing the add of a clip: the new clip leaves the selection, the others stay.
        pg.evaluate("""() => { const P = __panel; const c = P._editTlCut;
            P._editTlApply({ ...c, clips: [...c.clips, { file: 'D:/out/a.mp4', name: 'new', in: 0, length: 2, volume: 1, color: '' }] });
            P._editTlSetSelList([{ kind: 'clip', i: 0 }, { kind: 'clip', i: 1 }, { kind: 'clip', i: 3 }], { kind: 'clip', i: 3 }); P.editTlRefresh(); }""")
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips.length"), 3)
        self.assertEqual(pg.evaluate(self.SEL), ["V1:0", "V1:1"])
        self.assertEqual(pg.evaluate(primary), "clip:1")
        # Indexes shift: undo of a clip put in at the front keeps the same clips, now one place earlier.
        pg.evaluate("""() => { const P = __panel; const c = P._editTlCut;
            P._editTlApply({ ...c, clips: [{ file: 'D:/out/a.mp4', name: 'front', in: 0, length: 2, volume: 1, color: '' }, ...c.clips] });
            P._editTlSetSelList([{ kind: 'clip', i: 2 }, { kind: 'clip', i: 3 }], { kind: 'clip', i: 3 }); P.editTlRefresh(); }""")
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(self.SEL), ["V1:1", "V1:2"])
        self.assertEqual(self.errors, [])

    def test_22_several_selected_opacity_zoom_and_volume_go_to_all_with_one_undo(self):
        pg = self.multi_page()
        self.assertEqual(pg.evaluate("() => __panel.editInspectorPanel.querySelector('.insp-multi').textContent.slice(0, 7)"), "3 clips")
        n = self.undo_len(pg)
        pg.evaluate(self.SETROW, ["Opacity", 40])
        self.assertEqual(self.undo_len(pg), n + 1)
        for i in range(3):
            self.assertAlmostEqual(pg.evaluate(self.FXOF, i).get("op"), 0.4, places=3, msg=str(i))
        pg.evaluate("() => __panel.editTlUndo()")
        for i in range(3):
            self.assertIsNone(pg.evaluate(self.FXOF, i).get("op"))
        self.reselect(pg)
        # Zoom X (linked to Y): the same absolute value on all three; one step.
        n = self.undo_len(pg)
        pg.evaluate("() => { const i = (" + self.ROW + ")('Zoom').querySelectorAll('input.insp-num')[0]; i.value = '1.5'; i.dispatchEvent(new Event('change')); }")
        self.assertEqual(self.undo_len(pg), n + 1)
        for i in range(3):
            fx = pg.evaluate(self.FXOF, i)
            self.assertEqual((fx.get("zx"), fx.get("zy")), (1.5, 1.5), i)
        pg.evaluate("() => __panel.editTlUndo()")
        for i in range(3):
            self.assertIsNone(pg.evaluate(self.FXOF, i).get("zx"))
        self.reselect(pg)
        # A slider drag is one step, and sets the value on all.
        n = self.undo_len(pg)
        pg.evaluate("() => { const r = (" + self.ROW + ")('Opacity').querySelector('input.insp-range'); r.value = '25'; r.dispatchEvent(new Event('input')); r.value = '30'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }")
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual([round(pg.evaluate(self.FXOF, i).get("op") * 100) for i in range(3)], [30, 30, 30])
        # Volume: the films (a, b) and the sound clip on A2 get it, the still does not.
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList([{ kind: 'clip', i: 0 }, { kind: 'clip', i: 1 }, { kind: 'clip', i: 2 }, { kind: 'tclip', track: 'A2', i: 0 }], { kind: 'clip', i: 0 }); P._editInspTab = 'audio'; P.editTlRefresh(); }")
        n = self.undo_len(pg)
        pg.evaluate(self.SETROW, ["Volume", 50])
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual(pg.evaluate(self.VOLS), [0.5, 1, 0.5, 0.5])
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(self.VOLS), [1, 1, 1, 1])
        self.assertEqual(self.errors, [])

    def test_22_a_row_that_differs_shows_mixed_and_a_reset_resets_all(self):
        pg = self.multi_page()
        pg.evaluate("() => { const P = __panel; const c = P._editTlCut; P._editTlApply({ ...c, clips: c.clips.map((x, i) => i === 0 ? { ...x, fx: { op: 0.5 } } : x) }); }")
        state = "(l) => { const r = (" + self.ROW + ")(l); const i = r.querySelector('input.insp-num'); return [r.classList.contains('insp-mixedrow'), i.value, i.placeholder]; }"
        self.assertEqual(pg.evaluate(state, "Opacity"), [True, "", "—"])
        self.assertEqual(pg.evaluate(state, "Rotation Angle")[0], False)
        pg.evaluate(self.SETROW, ["Rotation Angle", 10])
        n = self.undo_len(pg)
        pg.evaluate(self.CLICK, ["Opacity", ".insp-reset"])
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual([pg.evaluate(self.FXOF, i).get("op", 1) for i in range(3)], [1, 1, 1])
        self.assertEqual(pg.evaluate(state, "Opacity")[0], False)
        self.assertEqual([pg.evaluate(self.FXOF, i).get("rot") for i in range(3)], [10, 10, 10])
        self.assertEqual(self.errors, [])

    def test_22_the_diamond_keys_only_the_clips_the_playhead_crosses_and_auto_key_works_per_clip(self):
        pg = self.multi_page()
        # a (0-4), c (4-7) and v on V2 (3-8); the playhead at 3.5 s lies in a and v, not in c; the primary is a.
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList([{ kind: 'clip', i: 1 }, { kind: 'tclip', track: 'V2', i: 0 }, { kind: 'clip', i: 0 }], { kind: 'clip', i: 0 }); P.setFrame(84); P.editTlRefresh(); }")
        keysof = "() => { const c = __panel._editTlCut; const k = (x) => ((x.fx || {}).keys || {}).op || []; return [k(c.clips[0]), k(c.clips[1]), k(c.tracks[0].clips[0])]; }"
        n = self.undo_len(pg)
        pg.evaluate(self.CLICK, ["Opacity", ".insp-diamond"])
        self.assertEqual(self.undo_len(pg), n + 1)
        got = pg.evaluate(keysof)
        self.assertEqual([len(x) for x in got], [1, 0, 1])
        self.assertAlmostEqual(got[0][0]["t"], 3.5, places=3)
        self.assertAlmostEqual(got[2][0]["t"], 0.5, places=3)
        self.assertEqual(pg.evaluate(self.DIAMOND, "Opacity"), "on")
        # Auto-key: a and v have keys, so they get a key at the playhead; c has none, so it gets the static value.
        pg.evaluate(self.SETROW, ["Opacity", 20])
        got = pg.evaluate(keysof)
        self.assertEqual([len(x) for x in got], [1, 0, 1])
        self.assertAlmostEqual(got[0][0]["v"], 0.2, places=3)
        self.assertAlmostEqual(got[2][0]["v"], 0.2, places=3)
        self.assertAlmostEqual(pg.evaluate(self.FXOF, 1)["op"], 0.2, places=3)
        self.assertIsNone(pg.evaluate("() => (__panel._editTlCut.clips[0].fx || {}).op"))
        # The diamond again takes the keys from every clip the playhead crosses, as one step.
        n = self.undo_len(pg)
        pg.evaluate(self.CLICK, ["Opacity", ".insp-diamond"])
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual([len(x) for x in pg.evaluate(keysof)], [0, 0, 0])
        # A playhead outside all of them: the diamond is off.
        pg.evaluate("() => { __panel.setFrame(600); }")
        self.assertTrue(pg.evaluate("() => (" + self.ROW + ")('Opacity').querySelector('.insp-diamond').disabled"))
        self.assertEqual(self.errors, [])

    def test_22_a_mixed_video_and_sound_selection_sends_volume_to_the_clips_with_sound(self):
        pg = self.multi_page("audio")
        sels = "[{ kind: 'clip', i: 1 }, { kind: 'tclip', track: 'A2', i: 0 }, { kind: 'tclip', track: 'V2', i: 0 }]"
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList(" + sels + ", { kind: 'tclip', track: 'A2', i: 0 }); P.editTlRefresh(); }")
        pg.evaluate(self.SETROW, ["Volume", 20])
        vols = pg.evaluate("() => { const c = __panel._editTlCut; return [c.clips[1].volume, c.tracks[1].clips[0].volume, c.tracks[0].clips[0].volume]; }")
        self.assertEqual(vols, [1, 0.2, 0.2], "the still has no sound; the sound clip and the film on V2 have")
        # With a picture primary, the video values go to the pictures only.
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList(" + sels + ", { kind: 'clip', i: 1 }); P._editInspTab = 'video'; P.editTlRefresh(); }")
        pg.evaluate(self.SETROW, ["Opacity", 60])
        ops = pg.evaluate("() => { const c = __panel._editTlCut; return [c.clips[1].fx.op, (c.tracks[0].clips[0].fx || {}).op, (c.tracks[1].clips[0].fx || {}).op]; }")
        self.assertEqual(ops, [0.6, 0.6, None])
        # Timing and File change the last clicked clip only, and say so.
        pg.evaluate("() => { __panel._editInspTab = 'timing'; __panel.editTlRefresh(); }")
        self.assertIn("last clicked", pg.evaluate("() => __panel.editInspectorPanel.querySelector('.insp-multi').textContent"))
        self.assertEqual(self.errors, [])

    def test_22_popped_out_several_selected_change_together(self):
        pg = self.multi_page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList([{ kind: 'clip', i: 0 }, { kind: 'clip', i: 1 }, { kind: 'clip', i: 2 }], { kind: 'clip', i: 2 }); P._editInspTab = 'video'; P.editTlRefresh(); }")
        self.assertIn("3 clips", pg.evaluate("() => __panel.editInspectorPanel.querySelector('.insp-multi').textContent"))
        pg.evaluate(self.SETROW, ["Opacity", 70])
        self.assertEqual([round(pg.evaluate(self.FXOF, i).get("op") * 100) for i in range(3)], [70, 70, 70])
        self.assertEqual(self.errors, [])

    # ── Copy a clip, Paste Attributes (Alt+V) ──

    PASTE_D = "__panel._editTlUi.dialog"
    BOXES = "() => Object.fromEntries([...__panel._editTlUi.dialog.querySelectorAll('input[data-attr]')].map(b => [b.dataset.attr, [b.checked, b.disabled]]))"

    def paste_page(self):
        """a (0-4) carries opacity 40 %, zoom 1.5, rotation 20 and keys on its position x at 1 s and 3.5 s."""
        pg = self.page()
        pg.evaluate("""() => { const P = __panel; const c = P._editTlCut;
            P._editTlApply({ ...c, clips: c.clips.map((x, i) => i === 0 ? { ...x, fx: { op: 0.4, zx: 1.5, zy: 1.5, rot: 20, keys: { x: [{ t: 1, v: 0.1 }, { t: 3.5, v: 0.6 }] } } } : x) });
            P._editTlHistories[P._editTlTab] = { past: [], future: [] };
            P._editTlSel = { kind: 'clip', i: 0 }; P._editTlMulti = null; P.editTlRefresh(); P._editTlUi.body.focus(); }""")
        return pg

    def open_paste(self, pg, keys):
        """Ctrl+C on a, then c and b selected, Alt+V."""
        keys.keyboard.press("Control+c")
        self.assertEqual(pg.evaluate("() => __panel._editTlClipboard.name"), "a")
        pg.evaluate("() => { const P = __panel; P._editTlSetSelList([{ kind: 'clip', i: 1 }, { kind: 'clip', i: 2 }], { kind: 'clip', i: 2 }); P.editTlRefresh(); P._editTlUi.body.focus(); }")
        keys.keyboard.press("Alt+v")
        pg.wait_for_function(f"() => {self.PASTE_D} && {self.PASTE_D}.classList.contains('edit-paste')", timeout=3000)

    def test_23_paste_attributes_only_opacity_and_zoom_onto_two_clips_one_undo(self):
        pg = self.paste_page()
        self.open_paste(pg, pg)
        d = self.PASTE_D
        pg.evaluate(f"() => {d}.querySelector('.edit-paste-none').click()")
        self.assertFalse(any(v[0] for v in pg.evaluate(self.BOXES).values()), "None: nothing checked")
        pg.evaluate(f"() => {{ {d}.querySelector('input[data-attr=opacity]').click(); {d}.querySelector('input[data-attr=zoom]').click(); }}")
        n = self.undo_len(pg)
        pg.evaluate(f"() => {d}.querySelector('.edit-paste-go').click()")
        self.assertFalse(pg.evaluate(f"() => !!{d}"), "the dialog closes")
        self.assertEqual(self.undo_len(pg), n + 1, "one undo step")
        for i in (1, 2):
            fx = pg.evaluate(self.FXOF, i)
            self.assertEqual((fx.get("op"), fx.get("zx"), fx.get("zy")), (0.4, 1.5, 1.5), i)
            self.assertNotIn("rot", fx)
            self.assertNotIn("keys", fx)
        self.assertEqual(pg.evaluate("() => __panel._editTlSelAll().map(s => s.i)"), [1, 2], "the selection stays")
        # The boxes checked are remembered, for this viewer.
        self.assertEqual(sorted(pg.evaluate("() => JSON.parse(localStorage.getItem('bepic.viewer.pasteAttrs'))")), ["opacity", "zoom"])
        pg.keyboard.press("Alt+v")
        pg.wait_for_function(f"() => !!{d}", timeout=3000)
        boxes = pg.evaluate(self.BOXES)
        self.assertEqual(sorted(k for k, v in boxes.items() if v[0]), ["opacity", "zoom"])
        pg.keyboard.press("Escape")
        self.assertFalse(pg.evaluate(f"() => !!{d}"))
        # One Ctrl+Z gives both clips back.
        pg.evaluate("() => __panel._editTlUi.body.focus()")
        pg.keyboard.press("Control+z")
        for i in (1, 2):
            self.assertEqual(pg.evaluate(self.FXOF, i), {}, i)
        # The right-click menu has Copy and Paste Attributes too.
        x, y = self.x_at(pg, 1.0)
        pg.mouse.click(x, y, button="right")
        labels = pg.evaluate("() => [...__panel.container.querySelectorAll('.previz-menu-item')].map(b => b.textContent)")
        self.assertEqual(labels[:2], ["Copy (Ctrl+C)", "Paste Attributes… (Alt+V)"])
        self.assertEqual(self.errors, [])

    def test_23_keyframes_are_pasted_relative_to_the_clip_start_and_cut_at_its_end(self):
        pg = self.paste_page()
        self.open_paste(pg, pg)
        d = self.PASTE_D
        pg.evaluate(f"() => {{ {d}.querySelector('.edit-paste-none').click(); {d}.querySelector('input[data-attr=position]').click(); {d}.querySelector('input[data-attr=keys]').click(); {d}.querySelector('.edit-paste-go').click(); }}")
        keys = "(i) => ((__panel._editTlCut.clips[i].fx || {}).keys || {}).x || []"
        b = pg.evaluate(keys, 2)                       # b: 4 s long, from 7 s on the timeline
        self.assertEqual([k["t"] for k in b], [1, 3.5], "where they were from a's start, from b's start")
        c = pg.evaluate(keys, 1)                       # c: 3 s long - the key at 3.5 s is cut off at its end
        self.assertEqual([k["t"] for k in c], [1, 3])
        self.assertAlmostEqual(c[1]["v"], 0.1 + 0.5 * 2 / 2.5, places=4)
        self.assertEqual(self.errors, [])

    def test_23_boxes_the_source_has_not_or_the_targets_cannot_take_are_off(self):
        pg = self.paste_page()
        pg.keyboard.press("Control+c")
        # Onto the still c only: no sound, no speed; a is no text.
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 1 }; P._editTlMulti = null; P.editTlRefresh(); P._editTlUi.body.focus(); }")
        pg.keyboard.press("Alt+v")
        pg.wait_for_function(f"() => !!{self.PASTE_D}", timeout=3000)
        boxes = pg.evaluate(self.BOXES)
        for off in ("volume", "speed", "textlook"):
            self.assertTrue(boxes[off][1], off)
            self.assertFalse(boxes[off][0], off)
        for on in ("zoom", "opacity", "crop", "keys", "name", "color"):
            self.assertFalse(boxes[on][1], on)
        pg.evaluate(f"() => {self.PASTE_D}.querySelector('.edit-paste-all').click()")
        boxes = pg.evaluate(self.BOXES)
        self.assertFalse(boxes["volume"][0], "All leaves the disabled ones")
        self.assertTrue(boxes["rotation"][0])
        pg.keyboard.press("Escape")
        # A source without keys: the keyframes switch is off.
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 2 }; P.editTlRefresh(); P._editTlUi.body.focus(); }")
        pg.keyboard.press("Control+c")
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 0 }; P.editTlRefresh(); P._editTlUi.body.focus(); }")
        pg.keyboard.press("Alt+v")
        pg.wait_for_function(f"() => !!{self.PASTE_D}", timeout=3000)
        boxes = pg.evaluate(self.BOXES)
        self.assertTrue(boxes["keys"][1])
        self.assertFalse(boxes["volume"][1], "a film carries a volume (the Inspector's rule)")
        # Typing in a field: neither key fires.
        pg.keyboard.press("Escape")
        pg.evaluate("() => { const i = document.createElement('input'); i.className = 'probe'; __panel._editTlUi.body.append(i); i.focus(); }")
        pg.evaluate("() => { __panel._editTlClipboard = null; }")
        pg.keyboard.press("Control+c")
        pg.keyboard.press("Alt+v")
        self.assertIsNone(pg.evaluate("() => __panel._editTlClipboard"))
        self.assertFalse(pg.evaluate(f"() => !!{self.PASTE_D} && {self.PASTE_D}.isConnected"))
        self.assertEqual(self.errors, [])

    def test_23_popped_out_copy_and_paste_attributes(self):
        pg = self.paste_page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 0 }; P._editTlMulti = null; P.editTlRefresh(); P._editTlUi.body.focus(); }")
        self.open_paste(pg, win)
        d = self.PASTE_D
        self.assertTrue(pg.evaluate(f"() => {d}.ownerDocument !== document"), "in the pop-out")
        self.assert_centred(pg, d)
        pg.evaluate(f"() => {{ {d}.querySelector('.edit-paste-none').click(); {d}.querySelector('input[data-attr=opacity]').click(); {d}.querySelector('.edit-paste-go').click(); }}")
        self.assertEqual([pg.evaluate(self.FXOF, i).get("op") for i in (1, 2)], [0.4, 0.4])
        self.assertEqual(self.errors, [])

    # ── the Edit panel's dialogs stand over the middle of the timeline ──

    CENTRE = """(d) => { const b = __panel._editTlUi.body.getBoundingClientRect(), r = d.getBoundingClientRect(), w = d.ownerDocument.defaultView;
        const hold = (v, size, room) => size + 16 >= room ? 8 : Math.max(8, Math.min(room - size - 8, v));
        return { got: [r.left + r.width / 2, r.top + r.height / 2], tl: [b.left + b.width / 2, b.top + b.height / 2],
                 want: [hold(b.left + b.width / 2 - r.width / 2, r.width, w.innerWidth) + r.width / 2, hold(b.top + b.height / 2 - r.height / 2, r.height, w.innerHeight) + r.height / 2],
                 inside: r.left >= 0 && r.top >= 0 && r.right <= w.innerWidth && r.bottom <= w.innerHeight }; }"""

    def assert_centred(self, pg, expr):
        got = pg.evaluate_handle(f"() => {expr}").evaluate(self.CENTRE)
        self.assertTrue(got["inside"], got)
        for k in (0, 1):
            self.assertLess(abs(got["got"][k] - got["want"][k]), 3, got)
        self.assertLess(abs(got["got"][0] - got["tl"][0]), 3, ("over the timeline's middle", got))
        return got

    def test_24_dialogs_are_centred_over_the_timeline(self):
        pg = self.paste_page()
        # Paste Attributes.
        self.open_paste(pg, pg)
        self.assert_centred(pg, self.PASTE_D)
        pg.keyboard.press("Escape")
        # Save cut as...
        pg.evaluate("() => { __panel.editTlSaveAsDialog(); }")
        pg.wait_for_function("() => __panel._editTlUi.dialog && __panel._editTlUi.dialog.isConnected && __panel._editTlUi.dialog.querySelector('.edit-saveas-name')", timeout=5000)
        self.assert_centred(pg, "__panel._editTlUi.dialog")
        pg.evaluate("() => __panel._editTlUi.dialog.querySelector('.edit-btn').click()")
        # Export to Resolve...
        self.resolve_menu(pg)
        self.assert_centred(pg, self.RESOLVE_D)
        # Centred again when the window changes size.
        pg.set_viewport_size({"width": 1300, "height": 900})
        pg.wait_for_timeout(200)
        self.assert_centred(pg, self.RESOLVE_D)
        pg.evaluate(f"() => {self.RESOLVE_D}.querySelector('.edit-resolve-close').click()")
        # Open cut... (the viewer's file picker) and Export film (its export dialog), opened from the panel.
        pick = "__panel.container.querySelector(':scope > .rd-shade.pick-dlg .rd-box')"
        pg.evaluate("() => { __panel.editTlOpenDialog(); }")
        pg.wait_for_function(f"() => {pick}", timeout=5000)
        self.assert_centred(pg, pick)
        pg.evaluate(f"() => {pick}.querySelector('.rd-x').click()")
        exp = "__panel.container.querySelector(':scope > .rd-shade.export-dlg .rd-box')"
        pg.evaluate("() => { __panel._editTlRender(); }")
        pg.wait_for_function(f"() => {exp}", timeout=8000)
        pg.wait_for_timeout(150)
        self.assert_centred(pg, exp)
        self.assertEqual(self.errors, [])

    # ── the Trim mode: the playhead stays on the selected cut ──

    ROLL = "(i) => { const P = __panel; P._editTlEditSel = { act: 'roll', sel: { kind: 'clip', i }, side: 'start', a: { kind: 'clip', i: i - 1 }, b: { kind: 'clip', i } }; P._editTlSel = { kind: 'clip', i }; P._editTlMulti = null; P.editTlRefresh(); }"

    def test_25_the_playhead_stays_on_the_selected_cut_in_the_trim_mode(self):
        pg = self.page()
        frame = "() => __panel.currentFrame"
        pg.evaluate("() => { __panel.setFrame(10); __panel._editTlUi.body.focus(); }")
        pg.keyboard.press("t")
        # The cut a | c (4 s) selected: the playhead jumps to it; the two-up shows it.
        pg.evaluate(self.ROLL, 1)
        self.assertEqual(pg.evaluate(frame), 96)
        pg.wait_for_function("() => __panel._etu && __panel._etu.root.style.display !== 'none'", timeout=3000)
        self.assertEqual(pg.evaluate(self.TWOUP)["right"][:2], ["V1:1", "96"])
        # , rolls it a frame back (a's film has no more frames after its end): the playhead follows.
        pg.keyboard.press("Comma")
        self.assertEqual(pg.evaluate(frame), 95)
        # Moved away by hand it stays there - until the cut moves again.
        pg.evaluate("() => __panel.setFrame(30)")
        self.assertEqual(pg.evaluate(frame), 30)
        pg.keyboard.press("Comma")
        self.assertEqual(pg.evaluate(frame), 94)
        # Undo moves the cut back: the playhead with it.
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(frame), 95)
        # Another cut selected (c | b at 7 s): the playhead goes there.
        pg.evaluate(self.ROLL, 2)
        self.assertEqual(pg.evaluate(frame), 168)
        # Playing: play around edit has the playhead; stopped, it is back on the cut.
        pg.evaluate("() => __panel.play()")
        pg.wait_for_timeout(250)
        self.assertNotEqual(pg.evaluate(frame), 168)
        pg.evaluate("() => __panel.stop()")
        self.assertEqual(pg.evaluate(frame), 168)
        # Let go of the cut (Esc): the playhead is free.
        pg.evaluate("() => __panel._editTlUi.body.focus()")
        pg.keyboard.press("Escape")
        pg.evaluate("() => { __panel.setFrame(30); __panel.editTlRefresh(); }")
        self.assertEqual(pg.evaluate(frame), 30)
        # The Selection mode: a selected cut does not hold it either.
        pg.keyboard.press("a")
        pg.evaluate(self.ROLL, 1)
        pg.evaluate("() => __panel.setFrame(30)")
        was = pg.evaluate("() => __panel._editTlCut.clips[0].length")
        pg.keyboard.press("Comma")
        self.assertLess(pg.evaluate("() => __panel._editTlCut.clips[0].length"), was, "the cut did move")
        self.assertEqual(pg.evaluate(frame), 30)
        # Back in the Trim mode the selected cut takes it.
        pg.keyboard.press("t")
        self.assertEqual(pg.evaluate(frame), pg.evaluate("() => Math.round(__panel._editTlEditTime(__panel._editTlEditSel, __panel._editTlCut) * 24)"))
        self.assertEqual(self.errors, [])

    def test_25_a_cut_out_of_view_is_scrolled_to_the_middle(self):
        pg = self.page()
        pg.evaluate("() => { const P = __panel; P._editTlUi.body.focus(); P._editTlZoom(16); P.setFrame(0); P._editTlUi.scroll.scrollLeft = 0; }")
        pg.keyboard.press("t")
        mid = """() => { const P = __panel, sc = P._editTlUi.scroll; const x = (P.currentFrame / 24) / P._editTlLay.total * sc.scrollWidth;
            return [Math.round(x - sc.scrollLeft - sc.clientWidth / 2), sc.scrollLeft > 0]; }"""
        pg.evaluate(self.ROLL, 2)
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 168)
        off, scrolled = pg.evaluate(mid)
        self.assertTrue(scrolled)
        self.assertLess(abs(off), 3, "the cut in the middle of the view")
        # Back to the first cut, out of view to the left: in the middle again.
        pg.evaluate(self.ROLL, 1)
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 96)
        self.assertLess(abs(pg.evaluate(mid)[0]), 3)
        # A cut still in view is not scrolled to.
        before = pg.evaluate("() => __panel._editTlUi.scroll.scrollLeft")
        pg.keyboard.press("Comma")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 95)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.scroll.scrollLeft"), before)
        self.assertEqual(self.errors, [])

    # ── the ruler on top, the readout, Shift + wheel, the video and the sound sections ──

    # Video tracks V4 V3 V2 V1 above the splitter, the bed A1 and A2 A3 below it, every row 20 px: both sections
    # are taller than the (short) panel shows, so each scrolls.
    SECTIONS = """() => { const P = __panel; const c = P._editTlCut;
        const v = (name, at, length) => ({ file: 'D:/out/b.mp4', name, in: 0, length, at, volume: 1, color: '' });
        const s = (name, at, length) => ({ file: 'D:/out/music.wav', name, in: 0, length, at, volume: 1, color: '' });
        P._editTlApply({ ...c, tracks: [
            { id: 'V2', kind: 'video', name: 'V2', off: false, clips: [v('v2', 0.5, 1)] },
            { id: 'V3', kind: 'video', name: 'V3', off: false, clips: [v('v3', 8, 1)] },
            { id: 'V4', kind: 'video', name: 'V4', off: false, clips: [v('v4', 9.5, 1)] },
            { id: 'A2', kind: 'audio', name: 'A2', off: false, clips: [s('s2', 4.5, 2)] },
            { id: 'A3', kind: 'audio', name: 'A3', off: false, clips: [s('s3', 8, 2)] }] });
        P._editTlHistories[P._editTlTab] = { past: [], future: [] };
        P._editTlView.heights = { V4: 20, V3: 20, V2: 20, V1: 20, A1: 20, A2: 20, A3: 20 };
        P._editTlView.split = null; P._editTlUi.vPinned = true; P._editTlUi.secA.scrollTop = 0; P.editTlRefresh(); }"""
    XT = "(t) => { const a = __panel._editTlUi.area.getBoundingClientRect(); return a.left + a.width * t / __panel._editTlLay.total; }"
    # The middle of the part of a row its section shows (null: scrolled out of view).
    ROWY = "(id) => { const P = __panel, r = P._editTlRowBox(P._editTlRowEl(id)); return r ? (r.top + r.bottom) / 2 : null; }"
    ROOMY = "(k) => { const P = __panel, b = P._editTlRowBox(P._editTlRowEl('new:' + k)); return b ? (b.top + b.bottom) / 2 : null; }"
    RECT = "(k) => { const r = __panel._editTlUi[k].getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }"
    HEIGHTS = "() => Object.fromEntries([...__panel._editTlUi.rows.querySelectorAll('.edit-track')].map(r => [r.dataset.track, r.offsetHeight]))"
    TC = "() => __panel._editTlUi.tc.textContent"
    SCROLLS = "() => [__panel._editTlUi.secV.scrollTop, __panel._editTlUi.secA.scrollTop]"

    def sections_page(self):
        pg = self.page()
        pg.evaluate(self.SECTIONS)
        self.settle(pg)
        return pg

    def at(self, pg, t, track):
        return pg.evaluate(self.XT, t), pg.evaluate(self.ROWY, track)

    def shift_wheel(self, pg, x, y, dy, mouse=None):
        m = mouse or pg
        m.mouse.move(x, y)
        m.keyboard.down("Shift")
        m.mouse.wheel(0, dy)
        m.keyboard.up("Shift")
        pg.wait_for_timeout(60)

    def test_26_the_ruler_stays_on_top_with_the_tracks_scrolled_and_scrubs(self):
        pg = self.sections_page()
        ruler0 = pg.evaluate(self.RECT, "ruler")
        # Both sections overflow; the video one sits down at V1 (by the splitter), the sound one at its top.
        st = pg.evaluate("() => { const u = __panel._editTlUi; return [u.secV.scrollTop, u.secV.scrollHeight - u.secV.clientHeight, u.secA.scrollTop, u.secA.scrollHeight - u.secA.clientHeight]; }")
        self.assertGreater(st[1], 0)
        self.assertGreater(st[3], 0)
        self.assertEqual(st[0], st[1], "the video section held down at V1")
        self.assertEqual(st[2], 0)
        pg.evaluate("() => { const u = __panel._editTlUi; u.secV.scrollTop = 0; u.secA.scrollTop = u.secA.scrollHeight; }")
        pg.wait_for_timeout(50)
        self.assertEqual(pg.evaluate(self.RECT, "ruler"), ruler0, "the ruler does not move")
        area, secv = pg.evaluate(self.RECT, "area"), pg.evaluate(self.RECT, "secV")
        self.assertAlmostEqual(ruler0[1], area[1], delta=0.5)
        self.assertLessEqual(ruler0[3], secv[1])
        mid_y = (ruler0[1] + ruler0[3]) / 2
        self.assertTrue(pg.evaluate("([x, y]) => { const u = __panel._editTlUi, e = u.body.getRootNode().elementFromPoint(x, y); return !!e && u.ruler.contains(e); }",
                                    [pg.evaluate(self.XT, 5.5), mid_y]), "nothing scrolled over it")
        # The headers went with their sections.
        self.assertTrue(pg.evaluate("() => { const u = __panel._editTlUi; return u.headsV.scrollTop === u.secV.scrollTop && Math.abs(u.headsA.scrollTop - u.secA.scrollTop) < 1; }"))
        pg.wait_for_function("() => !__panel._editTlUi.vPinned", timeout=3000)     # scrolled up: no longer held at V1
        # A drag on it scrubs.
        self.drag(pg, pg.evaluate(self.XT, 2.5), mid_y, pg.evaluate(self.XT, 5.5), mid_y)
        self.assertLessEqual(abs(pg.evaluate("() => __panel.currentFrame") - 132), 1)
        # The playhead's line runs from the ruler down through both sections, and is grabbed on a sound track.
        head = pg.evaluate("() => { const r = __panel._editTlUi.head.getBoundingClientRect(); return [r.left, r.top, r.bottom]; }")
        seca = pg.evaluate(self.RECT, "secA")
        self.assertLessEqual(head[1], ruler0[1] + 1)
        self.assertGreaterEqual(head[2], seca[3] - 1)
        y = pg.evaluate(self.ROWY, "A3")
        self.assertIsNotNone(y)
        self.drag(pg, head[0], y, pg.evaluate(self.XT, 6.5), y)
        self.assertLessEqual(abs(pg.evaluate("() => __panel.currentFrame") - 156), 1)
        self.assertEqual(self.cut(pg)["tracks"]["A3"], [["D:/out/music.wav", 8.0, 2.0]], "a scrub, not a move")
        self.assertEqual(self.errors, [])

    def test_26_the_readout_timecode_or_frames_toggled_and_live(self):
        pg = self.page()
        pg.evaluate("() => { try { localStorage.removeItem('bepic.viewer.editTimecode'); } catch (_) {} __panel._editTlTcModeNow = null; __panel._editTlTcSet('tc'); __panel.setFrame(25); }")
        self.assertEqual(pg.evaluate(self.TC), "00:00:01:01")
        tc, ruler = pg.evaluate(self.RECT, "tc"), pg.evaluate(self.RECT, "ruler")
        self.assertLessEqual(tc[2], ruler[0], "left of the ruler, over the headers' column")
        self.assertAlmostEqual(tc[1], ruler[1], delta=1)
        self.assertAlmostEqual(tc[3], ruler[3], delta=1)
        # Live, a frame at a time - and the text is written only when it changes.
        pg.evaluate("() => { const P = __panel; P.__tcWrites = 0; new MutationObserver((m) => { P.__tcWrites += m.length; }).observe(P._editTlUi.tc, { subtree: true, childList: true, characterData: true }); }")
        self.focus_timeline(pg)
        pg.keyboard.press("ArrowRight")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 26)
        self.assertEqual(pg.evaluate(self.TC), "00:00:01:02")
        pg.wait_for_timeout(30)
        writes = pg.evaluate("() => __panel.__tcWrites")
        self.assertGreaterEqual(writes, 1)
        pg.evaluate("() => { const P = __panel; for (let i = 0; i < 20; i++) P._editTlPlayhead(); P.editTlRefresh(); }")
        pg.wait_for_timeout(30)
        self.assertEqual(pg.evaluate("() => __panel.__tcWrites"), writes, "the same frame: not written again")
        # A click: frames; kept for this viewer.
        pg.click("bepic-viewer-panel >> .edit-tc")
        self.assertEqual(pg.evaluate(self.TC), "26")
        self.assertEqual(pg.evaluate("() => localStorage.getItem('bepic.viewer.editTimecode')"), "frames")
        self.assertEqual(pg.evaluate("() => { __panel._editTlTcModeNow = null; return __panel._editTlTcMode(); }"), "frames")
        pg.evaluate("() => __panel.setFrame(30)")
        self.assertEqual(pg.evaluate(self.TC), "30")
        # Right-click: the choice.
        pg.click("bepic-viewer-panel >> .edit-tc", button="right")
        pg.locator(".previz-menu-item", has_text="Timecode").first.click()
        self.assertEqual(pg.evaluate(self.TC), "00:00:01:06")
        # Double-click: typed, Enter goes there (the two clicks of it switch there and back).
        for typed, frame in (("00:00:02:00", 48), ("+12", 60), ("100", 100), ("nonsense", 100)):
            pg.dblclick("bepic-viewer-panel >> .edit-tc")
            pg.wait_for_function("() => !!__panel._editTlUi.tc.querySelector('input')", timeout=3000)
            pg.keyboard.press("Control+a")
            pg.keyboard.type(typed)
            pg.keyboard.press("Enter")
            self.assertEqual(pg.evaluate("() => __panel.currentFrame"), frame, typed)
            self.assertEqual(pg.evaluate("() => __panel._editTlTcMode()"), "tc")
        self.assertEqual(pg.evaluate(self.TC), "00:00:04:04")
        # Esc: nowhere.
        pg.dblclick("bepic-viewer-panel >> .edit-tc")
        pg.wait_for_function("() => !!__panel._editTlUi.tc.querySelector('input')", timeout=3000)
        pg.keyboard.type("5")
        pg.keyboard.press("Escape")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 100)
        self.assertEqual(pg.evaluate(self.TC), "00:00:04:04")
        self.assertEqual(self.errors, [])

    def test_26_shift_wheel_sets_the_heights_of_the_section_under_the_pointer(self):
        pg = self.sections_page()
        h0 = pg.evaluate(self.HEIGHTS)
        video, sound = ["V4", "V3", "V2", "V1"], ["A1", "A2", "A3"]
        x, y = self.at(pg, 5.5, "V1")
        self.shift_wheel(pg, x, y, -100)
        self.assertTrue(pg.evaluate("() => __panel._editTlSizing"), "the strips wait for the wheel to rest")
        pg.wait_for_function("() => !__panel._editTlSizing", timeout=3000)
        h1 = pg.evaluate(self.HEIGHTS)
        for k in video:
            self.assertGreater(h1[k], h0[k], k)
        for k in sound:
            self.assertEqual(h1[k], h0[k], k)
        # Over the sound section: only its tracks, lower.
        x, y = self.at(pg, 5.5, "A1")
        self.shift_wheel(pg, x, y, 100)
        pg.wait_for_function("() => !__panel._editTlSizing", timeout=3000)
        h2 = pg.evaluate(self.HEIGHTS)
        for k in video:
            self.assertEqual(h2[k], h1[k], k)
        for k in sound:
            self.assertLess(h2[k], h1[k], k)
        # Over the ruler: all of them. Kept with the cut's view.
        r = pg.evaluate(self.RECT, "ruler")
        rx, ry = pg.evaluate(self.XT, 5.5), (r[1] + r[3]) / 2
        self.shift_wheel(pg, rx, ry, -100)
        pg.wait_for_function("() => !__panel._editTlSizing", timeout=3000)
        h3 = pg.evaluate(self.HEIGHTS)
        for k in video + sound:
            self.assertGreater(h3[k], h2[k], k)
            self.assertEqual(pg.evaluate("(k) => __panel._editTlView.heights[k]", k), h3[k])
        # Within the bounds; the headers as tall as their rows; the volume line only on rows of 28 px or more.
        for _ in range(25):
            self.shift_wheel(pg, rx, ry, 100)
        pg.wait_for_function("() => !__panel._editTlSizing", timeout=3000)
        self.assertEqual(set(pg.evaluate(self.HEIGHTS).values()), {12})
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelectorAll('.edit-volline, .edit-volpt').length"), 0)
        self.assertTrue(pg.evaluate("""() => [...__panel._editTlUi.heads.querySelectorAll('.edit-headrow[data-track]')].every(h =>
            h.offsetHeight === __panel._editTlRowEl(h.dataset.track).offsetHeight)"""))
        for _ in range(40):
            self.shift_wheel(pg, rx, ry, -100)
        pg.wait_for_function("() => !__panel._editTlSizing", timeout=3000)
        self.assertEqual(set(pg.evaluate(self.HEIGHTS).values()), {160})
        self.settle(pg)
        # The wheel alone still moves along the film; Alt + wheel moves the section under it up and down.
        pg.evaluate("() => __panel._editTlZoom(4)")
        left = pg.evaluate("() => __panel._editTlUi.scroll.scrollLeft")
        sa = pg.evaluate(self.RECT, "secA")
        pg.mouse.move(rx, (sa[1] + sa[3]) / 2)
        pg.mouse.wheel(0, 120)
        pg.wait_for_timeout(50)
        self.assertGreater(pg.evaluate("() => __panel._editTlUi.scroll.scrollLeft"), left)
        top = pg.evaluate(self.SCROLLS)
        pg.keyboard.down("Alt")
        pg.mouse.wheel(0, 60)
        pg.keyboard.up("Alt")
        pg.wait_for_timeout(50)
        now = pg.evaluate(self.SCROLLS)
        self.assertEqual(now[0], top[0])
        self.assertGreater(now[1], top[1])
        self.assertEqual(self.errors, [])

    def test_26_the_splitter_and_each_section_scrolling_on_its_own(self):
        pg = self.sections_page()
        v0, a0 = pg.evaluate(self.RECT, "secV"), pg.evaluate(self.RECT, "secA")
        sp = pg.evaluate(self.RECT, "splitter")
        x, y = pg.evaluate(self.XT, 5.5), (sp[1] + sp[3]) / 2
        # Up 20 px: the video section lower, the sound taller; the headers alongside; kept with the cut's view.
        self.drag(pg, x, y, x, y - 20)
        v1, a1 = pg.evaluate(self.RECT, "secV"), pg.evaluate(self.RECT, "secA")
        self.assertAlmostEqual(v1[3] - v1[1], v0[3] - v0[1] - 20, delta=1)
        self.assertAlmostEqual(a1[3] - a1[1], a0[3] - a0[1] + 20, delta=1)
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlView.split"), v1[3] - v1[1], delta=1)
        self.assertTrue(pg.evaluate("() => { const u = __panel._editTlUi; return u.headsV.offsetHeight === u.secV.offsetHeight && u.headsA.offsetHeight === u.secA.offsetHeight; }"))
        self.assertEqual(self.undo_len(pg), 0, "the splitter changes nothing of the cut")
        # A redraw keeps it; the splitter over the headers moves it too, held at a section's minimum.
        pg.evaluate("() => __panel.editTlRefresh()")
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlUi.secV.offsetHeight"), v1[3] - v1[1], delta=1)
        hs = pg.evaluate(self.RECT, "hsplit")
        self.drag(pg, (hs[0] + hs[2]) / 2, (hs[1] + hs[3]) / 2, (hs[0] + hs[2]) / 2, hs[1] - 500)
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlUi.secV.offsetHeight"), 24, delta=1)
        # Double-click: back to fitting the video tracks.
        sp = pg.evaluate(self.RECT, "splitter")
        pg.mouse.dblclick(x, (sp[1] + sp[3]) / 2)
        self.assertIsNone(pg.evaluate("() => __panel._editTlView.split"))
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlUi.secV.offsetHeight"), v0[3] - v0[1], delta=1)
        # Each section scrolls on its own: the wheel over the headers, the headers' own scroll.
        top = pg.evaluate(self.SCROLLS)
        hv = pg.evaluate(self.RECT, "headsV")
        pg.mouse.move((hv[0] + hv[2]) / 2, (hv[1] + hv[3]) / 2)
        pg.mouse.wheel(0, -40)
        pg.wait_for_timeout(50)
        now = pg.evaluate(self.SCROLLS)
        self.assertLess(now[0], top[0])
        self.assertEqual(now[1], top[1])
        pg.evaluate("() => { __panel._editTlUi.headsA.scrollTop = 30; }")
        pg.wait_for_timeout(50)
        self.assertEqual(pg.evaluate(self.SCROLLS), [now[0], 30])
        self.assertIsNone(pg.evaluate(self.ROWY, "A1"), "A1 scrolled out of view")
        self.assertEqual(self.errors, [])

    def test_26_a_marquee_across_both_sections(self):
        pg = self.sections_page()
        x0, y0 = self.at(pg, 5.0, "V2")
        x1, y1 = self.at(pg, 6.0, "A2")
        self.assertIsNotNone(y0)
        self.assertIsNotNone(y1)
        self.drag(pg, x0, y0, x1, y1)
        got = pg.evaluate("() => __panel._editTlSelAll().map(s => s.kind + ':' + (s.track || '') + ':' + s.i)")
        self.assertIn("clip::1", got, "c on V1")
        self.assertIn("tclip:A2:0", got, "s2 on A2, below the splitter")
        self.assertNotIn("tclip:A3:0", got)
        self.assertEqual(self.errors, [])

    def test_26_a_linked_picture_and_sound_dragged_across_the_sections(self):
        pg = self.sections_page()
        pg.evaluate("""() => { const P = __panel; const c = P._editTlCut; c.clips[0].link = 'L';
            c.tracks.find(k => k.id === 'A2').clips = [{ file: c.clips[0].file, name: 'a', in: 0, length: 4, at: 0, volume: 1, color: '', link: 'L' }];
            P._editTlApply({ ...c }); P._editTlHistories[P._editTlTab] = { past: [], future: [] }; }""")
        pps = self.px_per_second(pg)
        x, y = self.at(pg, 2.0, "V1")
        self.drag(pg, x, y, x + 1.0 * pps, y)
        self.assertEqual(self.cut(pg)["tracks"]["A2"], [["D:/out/a.mp4", 1.0, 4.0]])
        self.assertEqual(pg.evaluate(self.STARTS)[0], 1.0)
        self.assertEqual(self.undo_len(pg), 1)
        # And from the sound, below the splitter: the picture above it follows.
        x, y = self.at(pg, 2.5, "A2")
        self.drag(pg, x, y, x + 0.5 * pps, y)
        self.assertEqual(self.cut(pg)["tracks"]["A2"], [["D:/out/a.mp4", 1.5, 4.0]])
        self.assertEqual(pg.evaluate(self.STARTS)[0], 1.5)
        self.assertEqual(self.errors, [])

    def test_26_a_drag_into_a_new_track_in_each_section(self):
        pg = self.sections_page()
        # The video section held at V1: its room is out of view above - past the section's top (over the ruler) counts.
        sv = pg.evaluate(self.RECT, "secV")
        x, y = self.at(pg, 5.5, "V1")
        lit = self.drag(pg, x, y, x, sv[1] - 6,
                        check="() => [__panel._editTlUi.rows.querySelector('.edit-room.landing')?.dataset.room, __panel._editTlUi.ghost.style.display]")
        self.assertEqual(lit, ["video", "block"])
        self.assertEqual(self.cut(pg)["tracks"]["V5"], [["D:/out/c.png", 4.0, 3.0]])
        self.assertEqual(self.undo_len(pg), 1)
        # Scrolled up to it, the room itself.
        pg.evaluate("() => { __panel._editTlUi.secV.scrollTop = 0; }")
        pg.wait_for_timeout(50)
        r = pg.evaluate(self.ROOMY, "video")
        x, y = self.at(pg, 8.5, "V3")
        self.assertIsNotNone(r)
        self.assertIsNotNone(y)
        self.drag(pg, x, y, x, r)
        self.assertIn("V6", self.cut(pg)["tracks"])
        self.assertEqual(self.cut(pg)["tracks"]["V3"], [])
        # The sound section: below its bottom (the room is out of view under A3) ...
        sa = pg.evaluate(self.RECT, "secA")
        x, y = self.at(pg, 5.0, "A2")
        self.assertIsNotNone(y)
        self.drag(pg, x, y, x, sa[3] + 4)
        self.assertEqual(self.cut(pg)["tracks"]["A4"], [["D:/out/music.wav", 4.5, 2.0]])
        # ... and scrolled down to it, the room itself.
        pg.evaluate("() => { const s = __panel._editTlUi.secA; s.scrollTop = s.scrollHeight; }")
        pg.wait_for_timeout(50)
        r = pg.evaluate(self.ROOMY, "audio")
        x, y = self.at(pg, 5.0, "A4")
        self.assertIsNotNone(r)
        self.assertIsNotNone(y)
        self.drag(pg, x, y, x, r)
        self.assertEqual(self.cut(pg)["tracks"]["A5"], [["D:/out/music.wav", 4.5, 2.0]])
        self.assertEqual(self.undo_len(pg), 4)
        self.assertEqual(self.errors, [])

    def test_26_popped_out_the_readout_the_splitter_and_shift_wheel(self):
        pg = self.sections_page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.wait_for_function("() => __panel._editTlUi.secV.offsetHeight > 0", timeout=10000)
        pg.evaluate("() => { __panel._editTlTcSet('tc'); __panel.setFrame(48); }")
        self.assertEqual(pg.evaluate(self.TC), "00:00:02:00")
        tc = pg.evaluate(self.RECT, "tc")
        win.mouse.click((tc[0] + tc[2]) / 2, (tc[1] + tc[3]) / 2)
        self.assertEqual(pg.evaluate(self.TC), "48")
        h0 = pg.evaluate(self.HEIGHTS)
        x, y = self.at(pg, 5.5, "A1")
        self.shift_wheel(pg, x, y, -100, mouse=win)
        pg.wait_for_function("() => !__panel._editTlSizing", timeout=3000)
        h1 = pg.evaluate(self.HEIGHTS)
        self.assertGreater(h1["A1"], h0["A1"])
        self.assertEqual(h1["V1"], h0["V1"])
        sp = pg.evaluate(self.RECT, "splitter")
        x, y = pg.evaluate(self.XT, 5.5), (sp[1] + sp[3]) / 2
        v0 = pg.evaluate("() => __panel._editTlUi.secV.offsetHeight")
        win.mouse.move(x, y)
        win.mouse.down()
        win.mouse.move(x, y - 15, steps=3)
        win.mouse.up()
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlUi.secV.offsetHeight"), v0 - 15, delta=1)
        self.assertEqual(self.errors, [])

if __name__ == "__main__":
    unittest.main()
