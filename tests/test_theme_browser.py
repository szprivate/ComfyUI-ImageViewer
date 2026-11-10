"""Settings -> Colours: the viewer's and the Edit page's colours, applied live (js/imageViewer_theme.js).

Run: python -m unittest tests.test_theme_browser   (Playwright with Edge or Chrome and node; skipped without)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_edit_timeline_browser as base  # noqa: E402
import test_paint_browser as paint_base  # noqa: E402

# ComfyUI's settings store, stubbed: the harness has none, so pref() would answer the defaults.
STORE = """async () => {
    const { app } = await import('/scripts/app.js');
    // "Custom": the colours below are the settings' (the default follows ComfyUI's palette).
    const vals = { 'ImageViewer.Colours.Preset': 'custom' };
    app.extensionManager.setting = { get: (id) => vals[id], set: async (id, v) => { vals[id] = v; } };
    window.__setPref = async (id, v) => { vals[id] = v; __panel.applyViewerPref(id, v); };
}"""
# A ComfyUI palette as the frontend (1.58) puts it on <html>: theme tokens, one through var() / color-mix().
PALETTE = """(p) => { const s = document.documentElement.style;
    for (const [k, v] of Object.entries(p)) s.setProperty('--' + k, v); }"""
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
        # The timeline has a colour of its own (every preset sets it), so the panel colour is not it.
        self.assertEqual(pg.evaluate(BG, panel), before)
        self.assertEqual(before, "rgb(27, 27, 31)", "the Paint preset's timeline")
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
        # Another tab: the colours stay ("Everywhere", the default), unless wanted on the Edit page only.
        other = pg.evaluate("() => Object.keys(__panel.allTabs).find((k) => !__panel.isEditTab(k))")
        if other is None:
            pg.evaluate("() => __panel.editTlTabHidden(true)")
        else:
            pg.evaluate("(k) => __panel.switchTab(k)", other)
        self.assertEqual(pg.evaluate(CHROME), "all")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Scope', 'edit')")
        self.assertEqual(pg.evaluate(CHROME), "not all")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Scope', 'all')")
        self.assertEqual(pg.evaluate(CHROME), "all")
        # Back at the defaults: the Paint preset's colours, the panels Paint's own.
        for key in ("Panel", "Clip", "Heads", "Timeline", "Button"):
            pg.evaluate("(k) => __setPref('ImageViewer.Colours.' + k, undefined)", key)
        self.assertEqual(pg.evaluate(BG, panel), "rgb(27, 27, 31)")
        self.assertEqual(self.errors, [])


    def test_follow_comfyui_takes_its_palette_and_changes_with_it(self):
        pg = self.page()
        pg.evaluate(STORE)
        pg.evaluate(PALETTE, {"background": "#2b2f38", "card": "#3a3f4a", "foreground": "#f0f0f0",
                              "secondary": "var(--card)", "border": "color-mix(in srgb, #2b2f38 50%, #ffffff)",
                              "primary": "#0b8ce9"})
        pg.evaluate("() => __setPref('ImageViewer.Colours.Preset', 'comfy')")
        panel = ".history-panel"
        self.assertEqual(pg.evaluate(BG, panel), "rgb(43, 47, 56)")
        # var() and color-mix() are resolved: the buttons are the card's colour, the border half way to white.
        cols = pg.evaluate("""async () => {
            const { THEME } = await import('/extensions/viewer/imageViewer_theme.js');
            const { app } = await import('/scripts/app.js');
            return Object.fromEntries(THEME.map((t) => [t.key, app.extensionManager.setting.get(t.id)]));
        }""")
        self.assertEqual(cols["button"], "3a3f4a", "the colour rows show ComfyUI's colours")
        self.assertEqual(cols["border"], "95979c")
        self.assertEqual(cols["accent"], "0b8ce9")
        # ComfyUI's palette switched: the viewer follows at once, without a setting touched.
        pg.evaluate(PALETTE, {"background": "#ffffff", "foreground": "#171718", "card": "#eeeeee"})
        pg.wait_for_function("(s) => getComputedStyle(__panel.shadowRoot.querySelector(s)).backgroundColor === 'rgb(255, 255, 255)'",
                             arg=panel, timeout=3000)
        # A colour changed by hand: Custom, and the palette no longer followed.
        pg.evaluate("() => __setPref('ImageViewer.Colours.Preset', 'custom')")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Panel', '404040')")
        self.assertEqual(pg.evaluate(BG, panel), "rgb(64, 64, 64)")
        pg.evaluate(PALETTE, {"background": "#101010"})
        pg.wait_for_timeout(200)
        self.assertEqual(pg.evaluate(BG, panel), "rgb(64, 64, 64)")
        self.assertEqual(self.errors, [])

    def test_a_paint_preset_kept_from_before_moves_to_follow_comfyui_once(self):
        pg = self.page()
        res = pg.evaluate("""async () => {
            const { app } = await import('/scripts/app.js');
            const S = await import('/extensions/viewer/imageViewer_settings.js');
            const run = async (vals) => {
                app.extensionManager.setting = { get: (id) => vals[id], set: async (id, v) => { vals[id] = v; } };
                await S.applyStartupPrefs();
                return vals;
            };
            const P = 'ImageViewer.Colours.Preset', F = 'ImageViewer.Colours.FollowSet';
            const kept = await run({ [P]: 'paint' });
            const again = await run({ [P]: 'paint', [F]: true });          // picked Paint since: it stays
            const grey = await run({ [P]: 'grey' });                        // another preset: left alone
            const changed = await run({ [P]: 'paint', 'ImageViewer.Colours.Panel': '404040' });
            return [kept[P], kept[F], again[P], grey[P], grey[F], changed[P]];
        }""")
        self.assertEqual(res, ["comfy", True, "paint", "grey", True, "paint"])
        self.assertEqual(self.errors, [])

    def test_a_change_reaches_the_popped_out_viewer_at_once(self):
        pg = self.page()
        pg.evaluate(STORE)
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel.container.ownerDocument !== document", timeout=10000)
        POP = "(sel) => getComputedStyle(__panel.container.ownerDocument.querySelector(sel) " \
              "|| __panel.container.querySelector(sel)).backgroundColor"
        pg.evaluate("() => __setPref('ImageViewer.Colours.Title', '602020')")
        self.assertEqual(pg.evaluate(POP, ".panel-titlebar"), "rgb(96, 32, 32)")
        pg.evaluate("() => __setPref('ImageViewer.Colours.Window', '203040')")
        self.assertEqual(pg.evaluate("() => __panel.container.ownerDocument.body.style.backgroundColor"), "rgb(32, 48, 64)")
        # A preset picked while it is out, and ComfyUI's palette followed there too.
        pg.evaluate("""async () => {
            const { PRESETS, THEME } = await import('/extensions/viewer/imageViewer_theme.js');
            for (const t of THEME) await __setPref(t.id, PRESETS.midnight.values[t.key]);
        }""")
        self.assertEqual(pg.evaluate(POP, ".panel-titlebar"), "rgb(28, 34, 48)")
        pg.evaluate(PALETTE, {"background": "#3a2020", "card": "#3a2020", "foreground": "#ffffff"})
        pg.evaluate("() => __setPref('ImageViewer.Colours.Preset', 'comfy')")
        self.assertEqual(pg.evaluate(POP, ".history-panel"), "rgb(58, 32, 32)")
        pg.evaluate(PALETTE, {"background": "#203a20", "card": "#203a20"})
        pg.wait_for_function("(s) => getComputedStyle(__panel.container.querySelector(s)).backgroundColor === 'rgb(32, 58, 32)'",
                             arg=".history-panel", timeout=3000)
        # Docked again, the shadow root has the colours too.
        pg.evaluate("() => __panel.toggleUndock()")
        self.assertEqual(pg.evaluate(BG, ".history-panel"), "rgb(32, 58, 32)")
        self.assertEqual(self.errors, [])


class _PaintBase(paint_base.PaintBrowserTests):
    pass


for _name in [n for n in dir(paint_base.PaintBrowserTests) if n.startswith("test")]:
    setattr(_PaintBase, _name, None)


class ThemePaintBrowserTests(_PaintBase):
    def test_a_preset_reaches_paint(self):
        pg = self.page()
        pg.evaluate(STORE)
        self.open_photo(pg)
        root, wrap = ".paint-root", ".paint-wrap"
        # The default, the Paint preset: Paint looks as it always did.
        self.assertEqual(pg.evaluate(BG, root), "rgb(21, 21, 24)")
        self.assertEqual(pg.evaluate(BG, wrap), "rgb(35, 35, 39)")
        self.assertEqual(pg.evaluate(BG, ".paint-bar"), "rgb(29, 29, 33)")
        # Another preset's colours: Paint follows.
        pg.evaluate("""async () => {
            const { PRESETS, THEME } = await import('/extensions/viewer/imageViewer_theme.js');
            for (const t of THEME) await __setPref(t.id, PRESETS.midnight.values[t.key]);
        }""")
        self.assertEqual(pg.evaluate(BG, root), "rgb(18, 22, 32)")
        self.assertEqual(pg.evaluate(BG, wrap), "rgb(11, 14, 21)")
        self.assertEqual(pg.evaluate(BG, ".paint-bar"), "rgb(28, 34, 48)")
        # The accent reaches Paint's sliders and the lit buttons of the lower bar, which no table names.
        acc = "(sel) => getComputedStyle(__panel.shadowRoot.querySelector(sel)).accentColor"
        self.assertEqual(pg.evaluate(acc, ".paint-optbar input[type=range]"), "rgb(76, 154, 255)")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
