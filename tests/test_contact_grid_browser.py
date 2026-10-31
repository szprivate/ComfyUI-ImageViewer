"""Contact Sheet of three or more history items, in a real browser: the grid, its labels, the wipes that
still compare two, videos playing in step, a click on a cell, the pop-out and what viewerState says.

Needs Playwright with an installed Edge or Chrome, node for the stub server and ffmpeg for the test clips;
skipped without them.
Run: python -m unittest tests.test_contact_grid_browser
It serves tests/harness/tabs.html - the REAL viewer js against stubbed ComfyUI scripts - on a free port,
with real clips made here by ffmpeg (HARNESS_MEDIA_DIR), so it never touches a running ComfyUI.
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

# A tab whose history holds the given items (newest first, as renders land), the strip open, and the items
# at `pick` Ctrl-selected in that order. Returns the tab's key.
SETUP = """async ([items, pick]) => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  const frame = (it) => it.video
    ? { path: `D:/out/${it.name}`, filename: it.name, type: 'output', kind: 'video', fps: 24, label: it.label || '' }
    : { path: `D:/out/${it.name}`, filename: it.name, type: 'output', label: it.label || '' };
  for (const it of [...items].reverse()) P.updateData({ unique_id: '20', tab_name: 'grid', tabs: { tab1: [frame(it)] } }, null);
  const key = 'named:grid';
  P.switchTab(key);
  if (P.isPanelDocked && !P.isPanelDocked('history')) P.togglePanelDocked('history');
  P._agentTags = { 'D:/out/p1.png': 'hero' };
  P.renderHistoryPanel();
  P.startHistorySelection(key, pick[0]);
  for (const i of pick.slice(1)) P.toggleHistorySelection(key, i);
  return key;
}"""

GRID = """() => { const P = window.__panel, g = P._grid; if (!g) return null;
  const root = P.viewport;
  return { on: P._gridOn, info: P.gridInfo(), mode: P.sliderMode,
    visible: getComputedStyle(P._gridEl).display, layers: getComputedStyle(P.contactContainer).display,
    cells: g.cells.map(c => { const r = c.el.getBoundingClientRect(); return {
      label: c.label.textContent, video: !!c.video, x: r.x, y: r.y, w: r.width, h: r.height,
      ready: c.video ? c.video.readyState : (c.img.complete && c.img.naturalWidth > 0 ? 4 : 0) }; }),
    hint: P._gridHintNode ? [P._gridHintNode.style.display, P._gridHintNode.textContent] : null }; }"""

HINT = "() => { const h = window.__panel._gridHintNode; return h ? [h.style.display, h.textContent] : null; }"
STATE = "() => window.__panel.agentViewerState().compare"
READY = "() => { const g = window.__panel._grid; return !!g && g.cells.every(c => c.video ? c.video.readyState >= 2 : c.img.complete && c.img.naturalWidth > 0); }"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _clip(path, seconds, size="320x180"):
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=24:duration={seconds}",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", path], check=True)


def _still(path, size):
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=1:duration=1",
                    "-frames:v", "1", path], check=True)


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or FFMPEG is None,
                 "needs playwright, node and ffmpeg")
class ContactGridBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="bepic_grid_")
        _clip(os.path.join(cls.media, "c1.mp4"), 2)
        _clip(os.path.join(cls.media, "c2.mp4"), 3)
        _clip(os.path.join(cls.media, "c3.mp4"), 4)
        for i in range(1, 10):
            _clip(os.path.join(cls.media, f"v{i}.mp4"), 4, "640x360")
        _still(os.path.join(cls.media, "p1.png"), "400x300")
        _still(os.path.join(cls.media, "p2.png"), "300x400")
        _still(os.path.join(cls.media, "p3.png"), "640x360")
        _still(os.path.join(cls.media, "p4.png"), "500x500")
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.media)
        env.pop("HARNESS_MEDIA", None)
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
        shutil.rmtree(cls.media, ignore_errors=True)

    def page(self, items, pick):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        self.key = pg.evaluate(SETUP, [items, pick])
        return pg

    def compare_on(self, pg):
        pg.evaluate("() => window.__panel.cycleCompareMode()")   # the C key
        pg.wait_for_function(READY, timeout=15000)
        pg.wait_for_timeout(150)
        return pg.evaluate(GRID)

    IMAGES = [{"name": "p1.png", "label": "v1"}, {"name": "p2.png"}, {"name": "p3.png", "label": "v3"},
              {"name": "p4.png"}]

    def test_four_images_in_a_grid_with_labels(self):
        pg = self.page(self.IMAGES, [2, 0, 1, 3])
        g = self.compare_on(pg)
        self.assertTrue(g["on"])
        self.assertEqual(g["mode"], "contact")
        self.assertEqual((g["visible"], g["layers"]), ("block", "none"))
        self.assertEqual(g["info"]["items"], 4)
        self.assertEqual((g["info"]["cols"], g["info"]["rows"]), (2, 2))
        # Selection order: item 2 first (A), then 0 (B), 1, 3.
        self.assertEqual(g["info"]["indices"], [2, 0, 1, 3])
        labels = [c["label"] for c in g["cells"]]
        self.assertTrue(labels[0].startswith("Ap3.png") and "v3" in labels[0], labels[0])
        self.assertTrue(labels[1].startswith("Bp1.png") and "#hero" in labels[1], labels[1])
        self.assertTrue(labels[2].startswith("3p2.png"))
        # Cells sit apart inside the viewport.
        vp = pg.evaluate("() => { const r = window.__panel.viewport.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }")
        for c in g["cells"]:
            self.assertGreaterEqual(c["x"], vp[0])
            self.assertLessEqual(c["x"] + c["w"], vp[0] + vp[2] + 0.5)
        a, b = g["cells"][0], g["cells"][1]
        self.assertGreater(b["x"], a["x"] + a["w"])
        self.assertEqual(g["hint"], ["none", ""] if g["hint"] else None)
        self.assertEqual(self.errors, [])

    def test_three_videos_and_an_image(self):
        items = [{"name": "c1.mp4", "video": True}, {"name": "c2.mp4", "video": True},
                 {"name": "c3.mp4", "video": True}, {"name": "p1.png"}]
        pg = self.page(items, [0, 1, 2, 3])
        g = self.compare_on(pg)
        self.assertEqual(g["info"]["items"], 4)
        self.assertEqual([c["video"] for c in g["cells"]], [True, True, True, False])
        # The sheet is as long as its longest clip (4 s at 24 fps), and a scrub moves every clip to that frame.
        n = pg.evaluate("() => window.__panel.getImgCount()")
        self.assertEqual(n, 96)
        pg.evaluate("() => window.__panel.setFrame(30)")
        pg.wait_for_timeout(400)
        t = pg.evaluate("() => window.__panel._grid.cells.filter(c => c.video).map(c => Math.min(c.frames - 1, Math.floor(c.video.currentTime * 24)))")
        # c1 is 2 s (48 frames) - it shows frame 30 too; then past its end it holds its last frame.
        self.assertEqual(t, [30, 30, 30])
        pg.evaluate("() => window.__panel.setFrame(70)")
        pg.wait_for_timeout(400)
        t = pg.evaluate("() => window.__panel._grid.cells.filter(c => c.video).map(c => Math.min(c.frames - 1, Math.floor(c.video.currentTime * 24)))")
        self.assertEqual(t, [47, 70, 70])
        # A frame step drives them all.
        pg.evaluate("() => window.__panel.step(1)")
        pg.wait_for_timeout(300)
        t = pg.evaluate("() => window.__panel._grid.cells.filter(c => c.video).map(c => Math.min(c.frames - 1, Math.floor(c.video.currentTime * 24)))")
        self.assertEqual(t, [47, 71, 71])
        self.assertEqual(pg.evaluate("() => window.__panel.currentFrame"), 71)
        self.assertEqual(self.errors, [])

    def test_wipe_modes_compare_the_first_two_with_a_hint(self):
        pg = self.page(self.IMAGES, [3, 1, 0])
        self.compare_on(pg)
        pg.evaluate("() => window.__panel.setSliderMode('vertical')")
        pg.wait_for_timeout(200)
        s = pg.evaluate("""() => { const P = window.__panel; return { on: !!P._gridOn, hc: P.historyCompare,
            base: P.imgBase.getAttribute('src'), cmp: P.imgCompare.getAttribute('src'),
            layers: getComputedStyle(P.contactContainer).display, slider: getComputedStyle(P.slider).display }; }""")
        self.assertFalse(s["on"])
        self.assertEqual((s["hc"]["baseIdx"], s["hc"]["otherIdx"]), (3, 1))
        self.assertIn("p4.png", s["base"])
        self.assertIn("p2.png", s["cmp"])
        self.assertEqual((s["layers"], s["slider"]), ("block", "block"))
        self.assertEqual(pg.evaluate(HINT), ["block", "Comparing 1 and 2 of 3; Contact Sheet shows all"])
        pg.evaluate("() => window.__panel.setSliderMode('horizontal')")
        self.assertEqual(pg.evaluate(HINT)[0], "block")
        # Back to the sheet: the selection is still all three.
        pg.evaluate("() => window.__panel.setSliderMode('contact')")
        pg.wait_for_function(READY, timeout=10000)
        g = pg.evaluate(GRID)
        self.assertEqual(g["info"]["indices"], [3, 1, 0])
        self.assertEqual(pg.evaluate(HINT)[0], "none")
        # The C key's cycle for a sheet: contact -> vertical -> horizontal -> off.
        P = "() => { const P = window.__panel; P.cycleCompareMode(); return [P.isComparing, P.sliderMode]; }"
        self.assertEqual(pg.evaluate(P), [True, "vertical"])
        self.assertEqual(pg.evaluate(P), [True, "horizontal"])
        self.assertEqual(pg.evaluate(P), [False, "horizontal"])
        self.assertEqual(self.errors, [])

    def test_synced_playback_stays_within_a_frame(self):
        items = [{"name": f"v{i}.mp4", "video": True} for i in range(1, 10)]
        pg = self.page(items, list(range(9)))
        g = self.compare_on(pg)
        self.assertEqual(g["info"]["shown"], 9)
        self.assertEqual((g["info"]["cols"], g["info"]["rows"]), (3, 3))
        pg.evaluate("() => window.__panel.play()")
        pg.wait_for_timeout(500)                 # past the start-up
        samples = pg.evaluate("""async () => { const P = window.__panel, out = [];
            const t0 = performance.now(); let frames = 0;
            await new Promise(r => { const tick = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else r(); }; requestAnimationFrame(tick); });
            return frames; }""")
        spreads = pg.evaluate("""async () => { const P = window.__panel, out = [];
            for (let i = 0; i < 20; i++) { out.push([P.gridSyncStats().spread, P.currentFrame]); await new Promise(r => setTimeout(r, 100)); }
            return out; }""")
        heads = [f for _, f in spreads]
        spreads = [s for s, _ in spreads]
        stats = pg.evaluate("() => window.__panel.gridSyncStats()")
        self.assertTrue(stats["playing"])
        self.assertEqual(stats["videos"], 9)
        self.assertLess(max(spreads), 1.0, spreads)          # under one frame, over 2 s
        # The page keeps animating. Headless software decoding of nine clips holds Edge to ~27 fps whether
        # or not the sheet syncs them (measured: free play 29, synced 27); the sync tick itself is ~3 us.
        self.assertGreater(samples, 40)
        # The playhead moved with them (it loops at 96 frames, so: many different frames).
        self.assertGreater(len(set(heads)), 15, heads)
        pg.evaluate("() => window.__panel.stop()")
        paused = pg.evaluate("() => window.__panel._grid.cells.every(c => c.video.paused)")
        self.assertTrue(paused)
        print(f"\n  9 videos: max spread {max(spreads):.3f} frames over 2 s, {samples / 2:.0f} fps page, "
              f"dropped {[d['dropped'] for d in stats['dropped'] if d]}")
        self.assertEqual(self.errors, [])

    def test_clicking_a_cell(self):
        pg = self.page(self.IMAGES, [0, 1, 2, 3])
        g = self.compare_on(pg)
        c = g["cells"][2]
        pg.mouse.move(c["x"] + c["w"] / 2, c["y"] + c["h"] / 2)
        pg.mouse.click(c["x"] + c["w"] / 2, c["y"] + c["h"] / 2)
        pg.wait_for_timeout(450)
        g = pg.evaluate(GRID)
        self.assertEqual(g["info"]["indices"], [2, 0, 1, 3])
        hc = pg.evaluate("() => window.__panel.historyCompare")
        self.assertEqual((hc["baseIdx"], hc["otherIdx"]), (2, 0))
        self.assertTrue(g["cells"][0]["label"].startswith("A"))
        # Double-click: that item alone, compare off.
        c = g["cells"][3]
        pg.mouse.dblclick(c["x"] + c["w"] / 2, c["y"] + c["h"] / 2)
        pg.wait_for_timeout(300)
        s = pg.evaluate("""() => { const P = window.__panel; return { cmp: P.isComparing, grid: !!P._gridOn,
            hc: P.historyCompare, idx: P.currentHistoryIndex, viewing: P.isViewingHistory,
            src: P.imgBase.getAttribute('src') }; }""")
        self.assertEqual((s["cmp"], s["grid"], s["hc"]), (False, False, None))
        self.assertEqual((s["idx"], s["viewing"]), (3, True))
        self.assertIn("p4.png", s["src"])
        self.assertEqual(self.errors, [])

    def test_the_pop_out(self):
        items = [{"name": "c1.mp4", "video": True}, {"name": "c2.mp4", "video": True}, {"name": "p1.png"}]
        pg = self.page(items, [0, 1, 2])
        self.compare_on(pg)
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => window.__panel.container.ownerDocument !== document", timeout=10000)
        pg.wait_for_function("() => { const P = window.__panel; return P._gridOn && P._gridEl.ownerDocument !== document"
                             " && P._gridEl.clientWidth > 0; }", timeout=10000)
        g = pg.evaluate(GRID)
        self.assertEqual(g["info"]["items"], 3)
        self.assertTrue(all(c["w"] > 50 for c in g["cells"]))
        pg.evaluate("() => window.__panel.play()")
        win.wait_for_timeout(800)
        st = pg.evaluate("() => window.__panel.gridSyncStats()")
        self.assertTrue(st["playing"])
        self.assertGreater(max(st["frames"]), 3)
        pg.evaluate("() => window.__panel.stop()")
        self.assertEqual(pg.evaluate(STATE)["mode"], "contact")
        pg.evaluate("() => window.__panel.toggleUndock()")
        pg.wait_for_function("() => window.__panel.container.ownerDocument === document", timeout=10000)
        pg.wait_for_timeout(200)
        self.assertTrue(pg.evaluate("() => window.__panel._gridOn && window.__panel._gridEl.clientWidth > 0"))
        self.assertEqual(self.errors, [])

    def test_docked_and_full_screen(self):
        items = [{"name": "c1.mp4", "video": True}, {"name": "p1.png"}, {"name": "p2.png"}, {"name": "p3.png"}]
        pg = self.page(items, [0, 1, 2, 3])
        self.compare_on(pg)
        # Docked into the page's right-hand cell (what ComfyUI's layout has), as the dock button does it.
        pg.evaluate("""() => { const cell = document.createElement('div'); cell.id = 'comfyui-body-right';
            Object.assign(cell.style, { position: 'fixed', right: '0', top: '0', width: '700px', height: '900px' });
            document.body.appendChild(cell); window.__panel.setPageDock('right'); }""")
        pg.wait_for_function("() => window.__panel.pageDockSide() === 'right'", timeout=5000)
        pg.wait_for_timeout(300)
        g = pg.evaluate(GRID)
        self.assertTrue(g["on"])
        vp = pg.evaluate("() => { const r = window.__panel.viewport.getBoundingClientRect(); return [r.x, r.width]; }")
        self.assertGreater(vp[0], 700)            # it is in the right-hand cell now
        for c in g["cells"]:
            self.assertGreaterEqual(c["x"], vp[0] - 0.5)
            self.assertLessEqual(c["x"] + c["w"], vp[0] + vp[1] + 0.5)
        self.assertEqual(pg.evaluate(STATE)["mode"], "contact")
        pg.evaluate("() => window.__panel.setPageDock('')")
        # Full screen: the panel takes the whole window, and the sheet follows its new size.
        pg.evaluate("""() => { const P = window.__panel; P._viewerOnly = true;
            Object.assign(P.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh' }); }""")
        pg.wait_for_timeout(300)
        g2 = pg.evaluate(GRID)
        vp2 = pg.evaluate("() => window.__panel.viewport.getBoundingClientRect().width")
        self.assertGreater(vp2, vp[1])
        self.assertGreater(g2["cells"][0]["w"], g["cells"][0]["w"])
        self.assertEqual(pg.evaluate("() => window.__panel.agentViewerState().display"), "fullscreen")
        self.assertEqual(self.errors, [])

    def test_viewer_state_reports_the_sheet(self):
        pg = self.page(self.IMAGES, [1, 0, 2])
        self.compare_on(pg)
        c = pg.evaluate(STATE)
        self.assertEqual(c["mode"], "contact")
        self.assertEqual((c["items"], c["shown"]), (3, 3))
        self.assertEqual(c["indices"], [1, 0, 2])
        self.assertEqual((c["a"]["index"], c["b"]["index"]), (1, 0))
        pg.evaluate("() => window.__panel.setSliderMode('vertical')")
        c = pg.evaluate(STATE)
        self.assertEqual((c["mode"], c["items"]), ("history", 3))
        self.assertNotIn("indices", c)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
