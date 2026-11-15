"""Settings -> ComfyUI Image Viewer drawn as one page (js/imageViewer_settingsPage.js).

Run: python -m unittest tests.test_settings_page_browser   (Playwright with Edge or Chrome and node; skipped without)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_edit_timeline_browser as base  # noqa: E402

# ComfyUI's settings store, stubbed; the page drawn into the document as the dialog would.
OPEN = """async (adv) => {
    const { app } = await import('/scripts/app.js');
    const vals = {};
    window.__vals = vals;
    app.extensionManager.setting = { get: (id) => vals[id], set: async (id, v) => { vals[id] = v; } };
    localStorage.setItem('imageviewer.settings.advanced', JSON.stringify(!!adv));
    localStorage.removeItem('imageviewer.settings.open');
    const S = await import('/extensions/viewer/imageViewer_settings.js');
    const list = S.viewerSettings();
    document.querySelector('.__ivs')?.remove();
    const box = document.createElement('div');
    box.className = '__ivs';
    box.style.cssText = 'position:fixed;inset:0;overflow:auto;z-index:99999;background:#15171c;padding:12px';
    box.append(S.renderViewerSettingsPage());
    document.body.append(box);
    return { shown: list.filter((d) => d.type !== 'hidden').map((d) => d.id),
             hidden: list.filter((d) => d.type === 'hidden').map((d) => d.id) };
}"""
ROWS = "() => [...document.querySelectorAll('.__ivs .ivs-field')].filter((e) => e.offsetParent).map((e) => e.dataset.id)"


class _Base(base.EditTimelineBrowserTests):
    pass


for _name in [n for n in dir(base.EditTimelineBrowserTests) if n.startswith("test")]:
    setattr(_Base, _name, None)


class SettingsPageBrowserTests(_Base):
    def test_one_page_holds_every_setting_and_writes_the_store(self):
        pg = self.page()
        reg = pg.evaluate(OPEN, True)
        # ComfyUI shows ONE entry, the page; every setting is still registered, hidden.
        self.assertEqual(reg["shown"], ["ImageViewer.Settings.Page"])
        self.assertIn("ImageViewer.Playback.FPS", reg["hidden"])
        # With advanced on and every section open, every setting that was shown before is on the page.
        pg.evaluate("() => document.querySelectorAll('.__ivs .ivs-group.ivs-closed > .ivs-head').forEach((h) => h.click())")
        rows = pg.evaluate(ROWS)
        state = {"ImageViewer.View.HiddenOverlays", "ImageViewer.Dock.LastSide", "ImageViewer.Colours.FollowSet"}
        missing = [i for i in reg["hidden"] if i not in rows and i not in state]
        self.assertEqual(missing, [])
        # A change is written through ComfyUI's store, and its reset puts the default back.
        pg.fill(".__ivs [data-id='ImageViewer.Playback.FPS'] input", "30")
        pg.dispatch_event(".__ivs [data-id='ImageViewer.Playback.FPS'] input", "change")
        self.assertEqual(pg.evaluate("() => __vals['ImageViewer.Playback.FPS']"), 30)
        pg.click(".__ivs [data-id='ImageViewer.Playback.FPS'] .ivs-reset")
        self.assertEqual(pg.evaluate("() => __vals['ImageViewer.Playback.FPS']"), 25)
        pg.select_option(".__ivs [data-id='ImageViewer.Playback.Loop'] select", "once")
        self.assertEqual(pg.evaluate("() => __vals['ImageViewer.Playback.Loop']"), "once")
        pg.click(".__ivs [data-id='ImageViewer.Browser.FoldSequences'] input")
        self.assertIs(pg.evaluate("() => __vals['ImageViewer.Browser.FoldSequences']"), True)
        self.assertEqual(self.errors, [])

    def test_advanced_rows_hide_and_the_find_field_narrows_the_page(self):
        pg = self.page()
        pg.evaluate(OPEN, False)
        pg.evaluate("() => document.querySelectorAll('.__ivs .ivs-group.ivs-closed > .ivs-head').forEach((h) => h.click())")
        rows = pg.evaluate(ROWS)
        self.assertNotIn("ImageViewer.Dock.Width", rows)
        self.assertNotIn("ImageViewer.Experimental.AtlasCameraMove", rows)
        self.assertFalse([r for r in rows if r.startswith("ImageViewer.Colours.") and r not in (
            "ImageViewer.Colours.Preset", "ImageViewer.Colours.Scope", "ImageViewer.Colours.Reset")])
        self.assertIn("ImageViewer.Dock.Side", rows)
        pg.click(".__ivs .ivs-top input[type=checkbox]")
        self.assertIn("ImageViewer.Dock.Width", pg.evaluate(ROWS))
        # Finding: only what matches, its sections opened.
        pg.fill(".__ivs .ivs-find", "frame rate")
        found = pg.evaluate(ROWS)
        self.assertIn("ImageViewer.Playback.FPS", found)
        self.assertIn("ImageViewer.Previz.FPS", found)
        self.assertNotIn("ImageViewer.Playback.Loop", found)
        pg.fill(".__ivs .ivs-find", "nothing like this at all")
        self.assertEqual(pg.evaluate(ROWS), [])
        self.assertTrue(pg.is_visible(".__ivs .ivs-empty"))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
