"""Settings -> Colours: the viewer's and the Edit page's colours, applied live (js/imageViewer_theme.js).

Run: python -m unittest tests.test_theme_browser   (Playwright with Edge or Chrome and node; skipped without)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_edit_timeline_browser as base  # noqa: E402

# ComfyUI's settings store, stubbed: the harness has none, so pref() would answer the defaults.
STORE = """async () => {
    const { app } = await import('/scripts/app.js');
    const vals = {};
    app.extensionManager.setting = { get: (id) => vals[id], set: async (id, v) => { vals[id] = v; } };
    window.__setPref = async (id, v) => { vals[id] = v; __panel.applyViewerPref(id, v); };
}"""
BG = "(sel) => getComputedStyle(__panel.shadowRoot.querySelector(sel)).backgroundColor"
CHROME = "() => __panel.shadowRoot.querySelector('style[data-iv-theme=\"chrome\"]').media"


class _Base(base.EditTimelineBrowserTests):
    pass


for _name in [n for n in dir(base.EditTimelineBrowserTests) if n.startswith("test")]:
    setattr(_Base, _name, None)


class ThemeBrowserTests(_Base):
    def test_colours_change_live_and_the_viewers_follow_the_edit_page(self):
        pg = self.page()
        pg.evaluate(STORE)
        panel = "#edit-timeline-panel"
        before = pg.evaluate(BG, panel)
        clip = pg.evaluate(BG, ".edit-shot:not(.tinted)")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Panel', '3a3a3a')")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Clip', '8a3020')")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Heads', '2a2a40')")
        self.assertEqual(pg.evaluate(BG, panel), "rgb(58, 58, 58)", "the Edit panel takes the panel colour")
        self.assertNotEqual(before, "rgb(58, 58, 58)")
        # A V1 shot: the colour, a shade lighter on every other one, lighter still under the playhead (.on).
        shades = {"rgb(138, 48, 32)", "rgb(145, 60, 45)", "rgb(159, 85, 72)"}
        self.assertIn(pg.evaluate(BG, ".edit-shot:not(.tinted)"), shades)
        self.assertNotIn(clip, shades)
        self.assertEqual(pg.evaluate(BG, ".edit-headrow"), "rgb(42, 42, 64)")
        # The timeline's own colour wins over the panels'.
        pg.evaluate("() => __setPref('ImageViewer.Colours.Timeline', '202830')")
        self.assertEqual(pg.evaluate(BG, panel), "rgb(32, 40, 48)")
        # A transparent icon button stays transparent when the buttons' colour changes.
        pg.evaluate("() => __setPref('ImageViewer.Colours.Button', '505050')")
        self.assertEqual(pg.evaluate(BG, ".pt-btn"), "rgba(0, 0, 0, 0)")
        self.assertEqual(pg.evaluate(CHROME), "all", "on a cut's tab the viewer's colours are on")
        # Another tab: the viewer's colours go ("On the Edit page"), unless they are wanted everywhere.
        other = pg.evaluate("() => Object.keys(__panel.allTabs).find((k) => !__panel.isEditTab(k))")
        if other is None:
            pg.evaluate("() => __panel.editTlTabHidden(true)")
        else:
            pg.evaluate("(k) => __panel.switchTab(k)", other)
        self.assertEqual(pg.evaluate(CHROME), "not all")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Scope', 'all')")
        self.assertEqual(pg.evaluate(CHROME), "all")
        # Back at the defaults nothing is written.
        for key in ("Panel", "Clip", "Heads", "Timeline", "Button"):
            pg.evaluate("(k) => __setPref('ImageViewer.Colours.' + k, undefined)", key)
        self.assertEqual(pg.evaluate("() => [...__panel.shadowRoot.querySelectorAll('style[data-iv-theme]')].map((s) => s.textContent)"), ["", ""])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
