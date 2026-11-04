"""One history for all tabs, sorted by group, in a real browser: the REAL viewer js against stubbed ComfyUI scripts.

Every tab's snapshots are in one strip, drawn by group (the group used last first, newest first inside); a
group's heading folds it and takes dropped thumbnails; the right-click menu moves snapshots to another group, or
a new one. A click shows a snapshot in the tab it was made in; with that tab closed, in the History tab.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_history_groups_browser
"""
import json
import os
import shutil
import socket
import subprocess
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Two tabs; renders land oldest first: a1 (A, Characters), b1 (B, no group), a2 (A, Places), b2 (B, Characters).
# The stack is then b2 a2 b1 a1 (0..3), drawn Characters [0, 3], Places [1], No group [2].
SETUP = """async () => {
  const P = window.__panel;
  if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
  const fr = (n, g) => ({ path: `D:/out/${n}.png`, filename: `${n}.png`, type: 'output', ...(g ? { group: g } : {}) });
  const land = (tab, label, f) => {
    P.allTabs[tab] = [f];
    P.tabLabels[tab] = label;
    if (!P.tabOrder.includes(tab)) P.tabOrder.push(tab);
    P.pushHistorySnapshot(tab, [f]);
  };
  land('folder_a', 'Tab A', fr('a1', 'Characters'));
  land('folder_b', 'Tab B', fr('b1'));
  land('folder_a', 'Tab A', fr('a2', 'Places'));
  land('folder_b', 'Tab B', fr('b2', 'Characters'));
  P._rebuildTabBar(null);
  P.switchTab('folder_a');
  P._historyPanelSig = null;
  P.renderHistoryPanel();
}"""

STRIP = """() => { const P = window.__panel;
  return { rows: [...P.historyStrip.children].map((el) => el.classList.contains('history-group')
             ? `# ${el.querySelector('.history-group-name').textContent} (${el.querySelector('.history-group-count').textContent})`
             : el.dataset.idx !== undefined ? Number(el.dataset.idx) : el.textContent),
           open: [...P.historyStrip.querySelectorAll('.history-thumb.selected')].map((t) => Number(t.dataset.idx)),
           active: P.activeTab, viewing: P.isViewingHistory,
           groups: P.history.all.map((s) => s.map((f) => f.group || '').join('+')) }; }"""

TILE = "(i) => window.__panel.historyStrip.querySelector(`.history-thumb[data-idx=\"${i}\"]`)"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class HistoryGroupsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
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
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(SETUP)
        return pg

    def strip(self, pg):
        return pg.evaluate(STRIP)

    def click(self, pg, idx, **mods):
        pg.evaluate(f"([i, m]) => ({TILE})(i).dispatchEvent(new MouseEvent('click', {{ bubbles: true, ...m }}))",
                    [idx, mods])

    def menu(self, pg, idx):
        pg.evaluate(f"(i) => {{ const t = ({TILE})(i), r = t.getBoundingClientRect();"
                    " t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5 })); }",
                    idx)
        return "() => [...window.__panel.container.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')]"

    def test_every_tab_is_in_one_strip_drawn_by_group(self):
        pg = self.page()
        s = self.strip(pg)
        self.assertEqual(s["rows"], ["# Characters (2)", 0, 3, "# Places (1)", 1, "# No group (1)", 2])
        self.assertEqual((s["active"], s["open"]), ("folder_a", [1]), "tab A's newest is the open tile")
        # The same strip on tab B, its newest open.
        pg.evaluate("() => window.__panel.switchTab('folder_b')")
        s = self.strip(pg)
        self.assertEqual(s["rows"][0:3], ["# Characters (2)", 0, 3])
        self.assertEqual(s["open"], [0])
        # The arrow keys go through the strip as it is drawn: 0, 3, 1, 2.
        pg.evaluate("() => window.__panel.navigateHistory(1)")
        s = self.strip(pg)
        self.assertEqual((s["active"], s["open"], s["viewing"]), ("folder_a", [3], True), "a1 shows in tab A")
        pg.evaluate("() => window.__panel.navigateHistory(1)")
        self.assertEqual(self.strip(pg)["open"], [1])
        self.assertEqual(self.errors, [])

    def test_a_click_shows_it_in_its_tab_and_a_closed_tab_leaves_it_in_the_history(self):
        pg = self.page()
        self.click(pg, 2)                    # b1, made in tab B
        st = pg.evaluate("() => ({ active: __panel.activeTab, shown: __panel.allTabs.folder_b[0].path, a: __panel.allTabs.folder_a[0].path })")
        self.assertEqual(st, {"active": "folder_b", "shown": "D:/out/b1.png", "a": "D:/out/a2.png"})
        self.assertEqual(self.strip(pg)["open"], [2])
        # Tab B closed: its snapshots stay, and one opens in the History tab.
        pg.evaluate("() => __panel.closeTab('folder_b')")
        self.assertEqual(len(pg.evaluate("() => __panel.history.all")), 4)
        self.click(pg, 0)                    # b2
        st = pg.evaluate("() => ({ active: __panel.activeTab, label: __panel.tabLabels[__panel.activeTab], shown: __panel.allTabs[__panel.activeTab][0].path })")
        self.assertEqual(st, {"active": "folder_history", "label": "🕘 History", "shown": "D:/out/b2.png"})
        self.assertEqual(self.strip(pg)["open"], [0])
        self.assertEqual(self.errors, [])

    def test_a_heading_folds_its_group(self):
        pg = self.page()
        pg.evaluate("() => __panel.historyStrip.querySelector('.history-group[data-group=\"Characters\"]').click()")
        s = self.strip(pg)
        self.assertEqual(s["rows"], ["# Characters (2)", "# Places (1)", 1, "# No group (1)", 2])
        self.assertEqual(pg.evaluate("() => __panel.historyDisplayIndices()"), [1, 2])
        # It stays folded across a reload of the state.
        pg.evaluate("() => __panel.persistViewerState()")
        saved = json.loads(pg.evaluate("() => localStorage.getItem(__panel._getViewerStateStorageKey())"))
        self.assertEqual(saved["historyCollapsed"], ["Characters"])
        pg.evaluate("() => __panel.historyStrip.querySelector('.history-group[data-group=\"Characters\"]').click()")
        self.assertEqual(self.strip(pg)["rows"][0:3], ["# Characters (2)", 0, 3])
        self.assertEqual(self.errors, [])

    def test_the_menu_moves_it_to_another_group_or_a_new_one(self):
        pg = self.page()
        items = self.menu(pg, 2)             # b1, no group
        rows = pg.evaluate(items + ".map((e) => e.textContent)")
        self.assertIn("📁 Move to group ▸", rows)
        pg.evaluate(items + ".find((e) => e.textContent.startsWith('📁')).click()")
        rows = pg.evaluate(items + ".filter((e) => e.classList.contains('thumb-ctx-sub')).map((e) => e.textContent)")
        self.assertEqual(rows, ["Characters", "Places", "＋ New group…"], "no 'No group' for one that has none")
        pg.evaluate(items + ".find((e) => e.textContent === 'Places').click()")
        s = self.strip(pg)
        self.assertEqual(s["groups"], ["Characters", "Places", "Places", "Characters"])
        self.assertEqual(s["rows"], ["# Characters (2)", 0, 3, "# Places (2)", 1, 2])
        # The tab's own picture of it follows (b1 is no tab's picture here, a2 is tab A's).
        # Several at once, into a new group (the prompt).
        self.click(pg, 1, ctrlKey=True)
        self.click(pg, 3, ctrlKey=True)
        pg.once("dialog", lambda d: d.accept("Props"))
        items = self.menu(pg, 3)
        self.assertIn("📁 Move 2 to group ▸", pg.evaluate(items + ".map((e) => e.textContent)"))
        pg.evaluate(items + ".find((e) => e.textContent.startsWith('📁')).click()")
        pg.evaluate(items + ".find((e) => e.textContent.startsWith('＋')).click()")
        s = self.strip(pg)
        self.assertEqual(s["groups"], ["Characters", "Props", "Places", "Props"])
        self.assertEqual(s["rows"][0], "# Characters (1)")
        self.assertIn("# Props (2)", s["rows"])
        self.assertEqual(pg.evaluate("() => __panel.allTabs.folder_a[0].group"), "Props", "tab A's picture is a2: it follows")
        # ...and out of every group.
        items = self.menu(pg, 0)
        pg.evaluate(items + ".find((e) => e.textContent.startsWith('📁')).click()")
        pg.evaluate(items + ".find((e) => e.textContent === '✕ No group').click()")
        self.assertEqual(self.strip(pg)["groups"][0], "")
        # It is kept.
        pg.evaluate("() => __panel.persistViewerState()")
        saved = json.loads(pg.evaluate("() => localStorage.getItem(__panel._getViewerStateStorageKey())"))
        self.assertEqual([s[0].get("group", "") for s in saved["history"]["all"]], ["", "Props", "Places", "Props"])
        self.assertEqual([s[0]["fromTab"] for s in saved["history"]["all"]], ["folder_b", "folder_a", "folder_b", "folder_a"])
        self.assertEqual(self.errors, [])

    def test_a_thumbnail_dropped_on_a_heading_moves_there(self):
        pg = self.page()
        moved = pg.evaluate(f"""() => {{ const P = window.__panel, t = ({TILE})(2);
            const h = P.historyStrip.querySelector('.history-group[data-group="Characters"]');
            const dt = new DataTransfer();
            const ev = (type) => new DragEvent(type, {{ bubbles: true, composed: true, cancelable: true, dataTransfer: dt }});
            t.dispatchEvent(ev('dragstart'));
            const over = ev('dragover'); h.dispatchEvent(over);
            h.dispatchEvent(ev('drop'));
            t.dispatchEvent(ev('dragend'));
            return over.defaultPrevented; }}""")
        self.assertTrue(moved, "a heading takes the drop")
        s = self.strip(pg)
        self.assertEqual(s["groups"][2], "Characters")
        self.assertEqual(s["rows"], ["# Characters (3)", 0, 2, 3, "# Places (1)", 1])
        self.assertEqual(self.errors, [])

    def test_a_group_is_renamed_from_its_heading(self):
        pg = self.page()
        head = "() => __panel.historyStrip.querySelector('.history-group[data-group=\"Characters\"]')"
        self.assertFalse(pg.evaluate("() => !!__panel.historyStrip.querySelector('.history-group[data-group=\"\"] .history-group-rename')"),
                         "'No group' is no group to rename")
        pg.evaluate(f"() => ({head})().querySelector('.history-group-rename').click()")
        pg.evaluate("() => { const i = __panel.historyStrip.querySelector('.history-group-input'); i.value = 'Cast';"
                    " i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }")
        s = self.strip(pg)
        self.assertEqual(s["groups"], ["Cast", "Places", "", "Cast"])
        self.assertEqual(s["rows"][0:3], ["# Cast (2)", 0, 3])
        self.assertEqual(pg.evaluate("() => __panel.allTabs.folder_b[0].group"), "Cast", "tab B's picture follows")
        # Esc leaves it as it was; a right-click opens the field too.
        pg.evaluate("() => __panel.historyStrip.querySelector('.history-group[data-group=\"Places\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))")
        pg.evaluate("() => { const i = __panel.historyStrip.querySelector('.history-group-input'); i.value = 'X';"
                    " i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }")
        self.assertEqual(self.strip(pg)["groups"], ["Cast", "Places", "", "Cast"])
        # A name that is there already: the two become one, and a folded group stays folded.
        pg.evaluate("() => __panel.toggleHistoryGroupCollapsed('Places')")
        self.assertTrue(pg.evaluate("() => __panel.renameHistoryGroup('Places', 'Cast')"))
        s = self.strip(pg)
        self.assertEqual(s["groups"], ["Cast", "Cast", "", "Cast"])
        self.assertEqual(s["rows"][0], "# Cast (3)")
        self.assertEqual(self.errors, [])

    def test_clear_clears_the_one_history(self):
        pg = self.page()
        pg.once("dialog", lambda d: d.accept())
        pg.evaluate("() => __panel.historyClearBtn.click()")
        self.assertEqual(pg.evaluate("() => (__panel.history.all || []).length"), 0)
        self.assertEqual(pg.evaluate("() => Object.keys(__panel.allTabs).sort()"), ["folder_a", "folder_b"], "the tabs stay")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
