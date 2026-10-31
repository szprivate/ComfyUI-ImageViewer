"""Switching between history items stays quick with a long history whose thumbnails are slow, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html); the harness server makes up
the pictures (HARNESS_MEDIA=1) and holds every thumbnail back (THUMB_DELAY_MS), the way the tiles of renders
on a network share arrive. A switch used to rebuild the whole strip: every tile was made again, asked for
its thumbnail again, and the picture the switch wanted queued behind them on the server.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_history_switch_perf_browser
"""
import os
import shutil
import socket
import statistics
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
ITEMS = 150
THUMB_DELAY_MS = 1500
# A switch is a click, a 1600x1000 PNG from the harness and its decode; the budget leaves room for a slow
# machine, and is still a fraction of the seconds a switch could take behind a strip of tiles.
SWITCH_BUDGET_MS = 400

SETUP = """async (n) => {
  const P = window.__panel;
  if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
  const key = P.activeTab || 'main';
  P.activeTab = key;
  P.history[key] = Array.from({ length: n }, (_, i) =>
      [{ path: `D:/out/render_${String(i).padStart(4, '0')}.png`, type: 'output', label: `render ${i}` }]);
  P.allTabs[key] = JSON.parse(JSON.stringify(P.history[key][0]));
  P._historyPanelSig = null;
  P.renderHistoryPanel();
  P.historyStrip.querySelectorAll('.history-thumb').forEach((t) => { t.__orig = true; });
  return key;
}"""

# Click a tile, then wait for the picture it opens to be loaded, decoded and painted.
SWITCH = """async (idx) => {
  const P = window.__panel;
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const tile = P.historyStrip.querySelector(`.history-thumb[data-idx="${idx}"]`);
  const want = encodeURIComponent(P.history[P.activeTab][idx][0].path);
  const t0 = performance.now();
  tile.click();
  const sync = performance.now() - t0;
  const img = P.imgBase;
  while (!(img.src.includes(want) && img.complete && img.naturalWidth) && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 2));
  try { await img.decode(); } catch (e) {}
  await raf(); await raf();
  return { sync, total: performance.now() - t0, ok: img.src.includes(want) && !!img.naturalWidth };
}"""

STRIP = """() => {
  const P = window.__panel, tiles = [...P.historyStrip.querySelectorAll('.history-thumb')];
  return { tiles: tiles.length, kept: tiles.filter((t) => t.__orig).length,
           selected: tiles.filter((t) => t.classList.contains('selected')).map((t) => Number(t.dataset.idx)),
           bordered: tiles.filter((t) => t.style.border).map((t) => Number(t.dataset.idx)),
           index: P.currentHistoryIndex };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class HistorySwitchPerfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA="1", THUMB_DELAY_MS=str(THUMB_DELAY_MS))
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
        cls.server.terminate()
        cls.server.wait(5)

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        self.thumb_requests = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        self.in_flight = {"now": 0, "max": 0}

        def started(r):
            if "/bepic/thumb" not in r.url:
                return
            self.thumb_requests.append(r.url)
            self.in_flight["now"] += 1
            self.in_flight["max"] = max(self.in_flight["max"], self.in_flight["now"])

        def ended(r):
            if "/bepic/thumb" in r.url:
                self.in_flight["now"] -= 1
        pg.on("request", started)
        pg.on("requestfinished", ended)
        pg.on("requestfailed", ended)
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(SETUP, ITEMS)
        return pg

    def test_switching_keeps_the_strip_and_stays_within_budget(self):
        pg = self.page()
        pg.wait_for_timeout(300)               # the tiles in view have asked for their thumbnails
        self.assertGreater(len(self.thumb_requests), 0)
        times = []
        for idx in (1, 2, 3, 5, 8, 4, 0, 6, 7, 2, 1, 9):
            got = pg.evaluate(SWITCH, idx)
            self.assertTrue(got["ok"], f"switch to {idx} showed nothing")
            times.append(got["total"])
            strip = pg.evaluate(STRIP)
            self.assertEqual(strip["index"], idx)
            # The open item is highlighted, and only that one, exactly as a rebuild draws it.
            self.assertEqual(strip["selected"], [idx])
            self.assertEqual(strip["bordered"], [idx])
        strip = pg.evaluate(STRIP)
        # Nothing was made again: the tiles are the ones the strip was built with ...
        self.assertEqual((strip["tiles"], strip["kept"]), (ITEMS, ITEMS))
        # ... so no tile asked for its thumbnail a second time while the first answers were on their way.
        twice = sorted({u for u in self.thumb_requests if self.thumb_requests.count(u) > 1})
        self.assertEqual(twice, [], "a switch asked for thumbnails again")
        print(f"\nhistory switch ms over {ITEMS} items, tiles {THUMB_DELAY_MS} ms slow:",
              [round(t) for t in times], file=sys.stderr)
        self.assertLess(statistics.median(times), SWITCH_BUDGET_MS, times)
        self.assertLess(max(times), SWITCH_BUDGET_MS * 2.5, times)
        self.assertEqual(self.errors, [])

    def test_tiles_load_as_they_come_into_view_a_few_at_a_time(self):
        pg = self.page()
        pg.wait_for_timeout(300)
        first = set(self.thumb_requests)
        # Like loading="lazy": the far end of a long strip has not asked for anything yet.
        self.assertGreater(len(first), 0)
        self.assertLess(len(first), ITEMS)
        self.assertNotIn("render_0149", " ".join(first))
        pg.evaluate("() => { const s = window.__panel.historyStrip; s.scrollTop = s.scrollHeight; s.scrollLeft = s.scrollWidth; }")
        pg.wait_for_function("() => { const t = window.__panel.historyStrip.querySelector('.history-thumb[data-idx=\"149\"] img');"
                             " return t && t.complete && t.naturalWidth > 0; }", timeout=60000)
        self.assertIn("render_0149", " ".join(self.thumb_requests))
        # Never more tiles in the air than leave the server's connections free for the picture itself.
        self.assertLessEqual(self.in_flight["max"], 4)
        self.assertEqual(len(self.thumb_requests), len(set(self.thumb_requests)))
        self.assertEqual(self.errors, [])

    def test_tiles_still_load_with_the_viewer_popped_out(self):
        # The tiles that were waiting move to the popout's document with the viewer; they have to load there.
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        pop.value.wait_for_load_state()
        pg.wait_for_function("() => window.__panel.historyStrip.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => { const s = window.__panel.historyStrip; s.scrollTop = s.scrollHeight; s.scrollLeft = s.scrollWidth; }")
        pg.wait_for_function("() => { const t = window.__panel.historyStrip.querySelector('.history-thumb[data-idx=\"149\"] img');"
                             " return t && t.complete && t.naturalWidth > 0; }", timeout=60000)
        self.assertEqual(self.errors, [])

    def test_a_filter_change_and_back_does_not_flash_loaded_thumbnails_black(self):
        # The tag filter rebuilds the strip. Tiles that were loaded before must be painted from the cache in the
        # same tick they are made: complete, with a size, and no new request for them.
        pg = self.page()
        pg.evaluate("""() => { const P = window.__panel; window.agentYViewerBridge = { tags: async () => [] };
            const key = P.activeTab;
            P.history[key].forEach((sn) => { sn[0].filename = sn[0].path.split('/').pop(); });
            P._agentTags = { 'D:/out/render_0002.png': 'mine' }; }""")
        pg.wait_for_function("() => [...window.__panel.historyStrip.querySelectorAll('.history-thumb img')]"
                             ".filter((i) => i.complete && i.naturalWidth > 0).length >= 6", timeout=60000)
        pg.wait_for_timeout(300)
        loaded = pg.evaluate("""() => [...window.__panel.historyStrip.querySelectorAll('.history-thumb')]
            .filter((t) => { const i = t.querySelector('img'); return i.complete && i.naturalWidth > 0; })
            .map((t) => Number(t.dataset.idx))""")
        self.assertGreaterEqual(len(loaded), 6)
        before = len(self.thumb_requests)
        got = pg.evaluate("""async (loaded) => {
            const P = window.__panel;
            await P.refreshAgentTags();
            P.setHistoryTagFilter('agent:mine');
            const inTag = P.historyStrip.querySelectorAll('.history-thumb').length;
            P.setHistoryTagFilter('');
            const bad = [];   // read in the very tick of the switch, before any frame
            for (const idx of loaded) {
                const t = P.historyStrip.querySelector(`.history-thumb[data-idx="${idx}"] img`);
                if (!t || !t.complete || !t.naturalWidth) bad.push(idx);
            }
            return { inTag, bad, all: P.historyStrip.querySelectorAll('.history-thumb').length };
        }""", loaded)
        self.assertEqual(got["inTag"], 1)
        self.assertEqual(got["all"], ITEMS)
        self.assertEqual(got["bad"], [], "thumbnails loaded before were empty right after the filter switch")
        pg.wait_for_timeout(300)
        again = [u for u in self.thumb_requests[before:] if any(f"render_{i:04d}" in u for i in loaded)]
        self.assertEqual(again, [], "loaded thumbnails were requested again")
        self.assertEqual(self.errors, [])

    def test_a_real_change_still_rebuilds(self):
        pg = self.page()
        pg.evaluate(SWITCH, 3)
        # A new render lands in front: the strip is drawn again, and the open item moves with it.
        pg.evaluate("""() => { const P = window.__panel, key = P.activeTab;
                               P.history[key].unshift([{ path: 'D:/out/new.png', type: 'output' }]);
                               P.onHistoryPrepended(key); P.renderHistoryPanel(); }""")
        strip = pg.evaluate(STRIP)
        self.assertEqual(strip["tiles"], ITEMS + 1)
        self.assertEqual(strip["kept"], 0)
        self.assertEqual((strip["index"], strip["selected"]), (4, [4]))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
