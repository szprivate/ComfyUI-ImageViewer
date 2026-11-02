"""Several clips selected, "Recreate with changes…" and takes, in the Edit panel in a real browser.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest tests.test_edit_takes_browser   (or discover -s tests)
It serves tests/harness/edit.html (the REAL viewer js against stubbed ComfyUI scripts), on a free port.
A take arrives the way agentY's does: ComfyUI's `bepic.edit.take` message, dispatched through the stubbed api.
"""
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
S1, S2, S3 = "D:/out/shot_01_v001.mp4", "D:/out/shot_02_v001.mp4", "D:/out/shot_03_v001.mp4"
S2B = "D:/out/shot_02_v002.mp4"

# Three shots (3 s from 1 s in, 2 s, 4 s) and, on V2, another piece of shot 2.
SETUP = """() => {
  const P = __panel;
  Object.assign(__media, {
    'D:/out/shot_01_v001.mp4': { duration: 8, video: true }, 'D:/out/shot_02_v001.mp4': { duration: 6, video: true },
    'D:/out/shot_03_v001.mp4': { duration: 9, video: true }, 'D:/out/shot_02_v002.mp4': { duration: 6, video: true },
    'D:/out/shot_01_v002.mp4': { duration: 2.5, video: true }, 'D:/out/shot_01_v003.mp4': { duration: 8, video: true } });
  P.editTlNew();
  const clip = (file, name, inn, length) => ({ file, name, in: inn, length, transition: 0, color: '', volume: 1 });
  P._editTlApply({ ...P._editTlCut, clips: [clip('D:/out/shot_01_v001.mp4', 'shot_01', 1, 3), clip('D:/out/shot_02_v001.mp4', 'shot_02', 0, 2),
                                            clip('D:/out/shot_03_v001.mp4', 'shot_03', 2, 4)],
    sound: [], tracks: [{ id: 'V2', kind: 'video', name: 'V2', off: false, clips: [{ ...clip('D:/out/shot_02_v001.mp4', 'cutaway', 3, 1), at: 6 }] }] });
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  return P._editTlTab;
}"""

WHERE = """([t, track]) => { const ui = __panel._editTlUi, a = ui.area.getBoundingClientRect();
  const row = [...ui.rows.querySelectorAll('.edit-track')].find(r => r.dataset.track === track).getBoundingClientRect();
  return [a.left + a.width * t / __panel._editTlLay.total, row.top + row.height / 2]; }"""

CUT = """() => { const c = __panel._editTlCut; const r = (v) => Math.round(v * 1000) / 1000;
  return { v1: c.clips.map(x => [x.file, r(x.in), r(x.length), x.speed || 1, (x.takes || []).map(t => [t.version, t.active])]),
           v2: c.tracks[0].clips.map(x => [x.file, r(x.in), r(x.length), r(x.at), (x.takes || []).length]) }; }"""

MSEL = "() => [...__panel._editTlUi.rows.querySelectorAll('.msel')].map(e => e.dataset.key).sort()"
SEL = "() => [...__panel._editTlUi.rows.querySelectorAll('.sel')].map(e => e.dataset.key)"
BADGES = "() => [...__panel._editTlUi.rows.querySelectorAll('.edit-shot')].map(e => [e.dataset.key, (e.querySelector('.edit-badge-take') || {}).textContent || ''])"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def take(from_file, file, version, saved=True, retime=False, otio="D:/out/cut.otio", note="warmer"):
    return {"otio": otio, "takes": [{"from_file": from_file, "file": file, "version": version, "note": note,
                                      "created": "2026-10-31T10:00:00"}], "saved": saved, "retime": retime}


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class EditTakesBrowserTests(unittest.TestCase):
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

    def page(self, bridge=False, saved=False):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        if bridge:
            pg.evaluate("() => { window.__recreated = []; window.agentYViewerBridge = { version: 1, "
                        "recreate: async (a) => { window.__recreated.push(JSON.parse(JSON.stringify(a))); return { ok: true, message: 'Sent to agentY.' }; } }; }")
        pg.evaluate(SETUP)
        if saved:
            pg.evaluate("async () => { await __panel._editTlSave(); }")
            self.assertFalse(pg.evaluate("() => __panel._editTlDirty()"))
            self.assertEqual(pg.evaluate("() => __panel._editTlOtio"), "D:/out/cut.otio")
        self.settle(pg)
        return pg

    @staticmethod
    def settle(pg):
        pg.wait_for_function("() => __panel._emPending === 0 && __panel._emDrawn > 0", timeout=15000)

    @staticmethod
    def click(pg, who, t, track="V1", mods=(), button="left", host=None):
        x, y = pg.evaluate(WHERE, [t, track])
        host = host or pg
        for m in mods:
            host.keyboard.down(m)
        host.mouse.click(x, y, button=button)
        for m in mods:
            host.keyboard.up(m)

    def cut(self, pg):
        return pg.evaluate(CUT)

    def land(self, pg, detail):
        pg.evaluate("(d) => { __api.dispatch('bepic.edit.take', d); }", detail)
        pg.wait_for_function("() => !__panel._editTlTakeBusy", timeout=10000)
        pg.wait_for_timeout(250)

    # ── several clips selected ──

    def test_ctrl_toggles_shift_extends_a_plain_click_is_one_again(self):
        pg = self.page()
        self.click(pg, "a", 1.5)                                       # shot_01
        self.assertEqual(pg.evaluate(SEL), ["V1:0"])
        self.assertEqual(pg.evaluate(MSEL), [])
        self.click(pg, "c", 7.0, mods=["Control"])                     # + shot_03
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:2"])
        st = pg.evaluate("() => __panel.agentViewerState().edit")
        self.assertEqual([c["id"] for c in st["selected"]], ["V1:0", "V1:2"])
        self.assertEqual(pg.evaluate("() => __panel._editTlSel"), {"kind": "clip", "i": 2}, "the last one clicked is the single selection")
        self.click(pg, "b", 4.0, mods=["Control"])
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:1", "V1:2"])
        self.click(pg, "b", 4.0, mods=["Control"])                     # toggled out again
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:2"])
        self.assertEqual(self.cut(pg)["v1"][0][:3], [S1, 1, 3], "selecting changes nothing in the cut")
        self.click(pg, "a", 1.5)                                       # plain: one again
        self.assertEqual(pg.evaluate(MSEL), [])
        self.assertEqual(pg.evaluate(SEL), ["V1:0"])
        self.click(pg, "c", 7.0, mods=["Shift"])                       # range V1:0..2
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:1", "V1:2"])
        sel = pg.evaluate("() => __panel.agentViewerState().edit.selected")
        self.assertEqual([c["id"] for c in sel], ["V1:0", "V1:1", "V1:2"])
        self.assertEqual(sel[0], {"name": "shot_01", "file": S1, "in": 1, "out": 4, "track": "V1", "id": "V1:0"})
        self.assertNotIn("selected_item", pg.evaluate("() => __panel.agentViewerState().edit"))
        self.assertEqual(self.errors, [])

    def test_shift_stays_on_its_track_and_a_clip_on_a_track_has_its_own_id(self):
        pg = self.page()
        self.click(pg, "a", 1.5)
        self.click(pg, "x", 6.5, "V2", mods=["Shift"])                 # another track: added, across tracks
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V2:0"])
        self.click(pg, "a", 1.5, mods=["Control"])
        self.assertEqual(pg.evaluate(MSEL), [])
        self.assertEqual([c["id"] for c in pg.evaluate("() => __panel.agentViewerState().edit.selected")], ["V2:0"])
        self.click(pg, "a", 1.5, mods=["Control"])
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V2:0"])
        self.assertEqual([c["id"] for c in pg.evaluate("() => __panel.agentViewerState().edit.selected")], ["V1:0", "V2:0"])

    def test_an_edit_that_moves_clips_lets_the_selection_go_and_nothing_points_at_the_wrong_clip(self):
        pg = self.page()
        self.click(pg, "a", 1.5)
        self.click(pg, "c", 7.0, mods=["Control"])
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:2"])
        pg.evaluate("() => __panel._editTlMove(0, 1)")                 # shot_01 moves behind shot_02
        self.assertEqual(pg.evaluate(MSEL), [])
        self.assertEqual(self.cut(pg)["v1"][1][0], S1)
        sel = pg.evaluate("() => __panel.agentViewerState().edit.selected")
        self.assertEqual([c["file"] for c in sel], [S1], "only the clip that was moved to is selected, and it is the right one")
        # A trim keeps the selection.
        self.click(pg, "b", 6.5, mods=["Control"])
        self.assertEqual(len(pg.evaluate(MSEL)), 2)
        pg.evaluate("() => __panel._editTlApply(structuredClone(Object.assign(__panel._editTlCut, {})))")
        # Removing a clip lets it go.
        pg.evaluate("() => __panel._editTlRemove({ kind: 'clip', i: 1 })")
        self.assertEqual(pg.evaluate(MSEL), [])
        self.assertEqual(self.errors, [])

    # ── Recreate with changes… ──

    def menu_item(self, pg, label, host=None):
        host = host or pg
        item = host.locator(".previz-menu-item", has_text=label).first
        return item

    def test_right_click_recreate_sends_the_selected_clips_and_the_words_through_the_bridge(self):
        pg = self.page(bridge=True)
        self.click(pg, "a", 1.5)
        self.click(pg, "c", 7.0, mods=["Control"])
        self.click(pg, "c", 7.0, button="right")                       # a clip of the selection: it stays
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:2"])
        self.menu_item(pg, "Recreate 2 shots").click()
        self.assertTrue(pg.evaluate("() => !!__panel._editTlUi.dialog && __panel._editTlUi.dialog.classList.contains('edit-recreate')"))
        pg.fill(".edit-recreate textarea", "warmer light <b>and</b> slower camera")
        pg.click(".edit-recreate .edit-btn.primary")
        pg.wait_for_function("() => window.__recreated.length === 1", timeout=10000)
        sent = pg.evaluate("() => window.__recreated[0]")
        self.assertEqual(sent["text"], "warmer light <b>and</b> slower camera")
        self.assertEqual(sent["otio"], "D:/out/cut.otio", "the cut was saved first, so the file on disk names the clips")
        self.assertEqual([(c["id"], c["file"], c["name"], c["in"], c["out"], c["track"]) for c in sent["clips"]],
                         [("V1:0", S1, "shot_01", 1, 4, "V1"), ("V1:2", S3, "shot_03", 2, 6, "V1")])
        self.assertEqual(pg.evaluate("() => __saves.length"), 1)
        self.assertFalse(pg.evaluate("() => __panel._editTlDirty()"))
        self.assertFalse(pg.evaluate("() => !!(__panel._editTlUi.dialog && __panel._editTlUi.dialog.isConnected)"), "the dialog closes when it was sent")
        self.assertEqual(self.errors, [])

    def test_a_clip_not_in_the_selection_becomes_the_selection_and_the_dialog_cannot_run_html(self):
        pg = self.page(bridge=True)
        self.click(pg, "a", 1.5)
        self.click(pg, "b", 4.0, button="right")
        self.assertEqual(pg.evaluate(SEL), ["V1:1"])
        self.menu_item(pg, "Recreate with changes").click()
        self.assertIn("shot_02", pg.inner_text(".edit-recreate"))
        pg.fill(".edit-recreate textarea", "x")
        pg.click(".edit-recreate .edit-btn.primary")
        pg.wait_for_function("() => window.__recreated.length === 1", timeout=10000)
        self.assertEqual([c["id"] for c in pg.evaluate("() => window.__recreated[0].clips")], ["V1:1"])

    def test_without_the_bridge_send_is_disabled_with_a_note(self):
        pg = self.page(bridge=False)
        self.click(pg, "b", 4.0, button="right")
        self.menu_item(pg, "Recreate with changes").click()
        self.assertTrue(pg.evaluate("() => __panel._editTlUi.dialog.querySelector('.edit-btn.primary').disabled"))
        self.assertIn("not on this page", pg.inner_text(".edit-recreate"))
        pg.evaluate("() => { window.agentYViewerBridge = { version: 1 }; }")
        # The dialog stands over the middle of the timeline (on the clip): closed before the next right-click.
        pg.evaluate("() => { __panel._editTlUi.dialog.remove(); __panel._editTlUi.dialog = null; }")
        self.click(pg, "b", 4.0, button="right")
        self.menu_item(pg, "Recreate with changes").click()
        self.assertTrue(pg.evaluate("() => __panel._editTlUi.dialog.querySelector('.edit-btn.primary').disabled"))
        self.assertIn("cannot recreate", pg.inner_text(".edit-recreate"))

    def test_a_bridge_that_throws_is_said_and_the_dialog_stays(self):
        pg = self.page(bridge=True)
        pg.evaluate("() => { window.agentYViewerBridge.recreate = async () => { throw new Error('panel gone'); }; }")
        self.click(pg, "b", 4.0, button="right")
        self.menu_item(pg, "Recreate with changes").click()
        pg.fill(".edit-recreate textarea", "warmer")
        pg.click(".edit-recreate .edit-btn.primary")
        pg.wait_for_function("() => /panel gone/.test(__panel._editTlUi.dialog.querySelector('.edit-none').textContent)",
                             timeout=10000)
        self.assertIn("Not sent: panel gone", pg.inner_text(".edit-recreate"))
        self.assertFalse(pg.evaluate("() => __panel._editTlUi.dialog.querySelector('.edit-btn.primary').disabled"))
        self.assertEqual(self.errors, [])

    # ── takes ──

    def test_a_take_lands_swaps_the_file_keeps_the_rest_shows_v2_and_undo_restores(self):
        pg = self.page(saved=True)
        self.assertEqual(dict(pg.evaluate(BADGES))["V1:0"], "")
        self.land(pg, take(S2, S2B, 2))
        cut = self.cut(pg)
        self.assertEqual(cut["v1"][1][:4], [S2B, 0, 2, 1])
        self.assertEqual(cut["v1"][1][4], [[1, False], [2, True]])
        self.assertEqual(cut["v2"][0][:4], [S2B, 3, 1, 6], "the clip on V2 that used the file takes it too; in, length and place stay")
        self.assertEqual(cut["v1"][0][0], S1, "other clips are untouched")
        badges = dict((k, v) for k, v in pg.evaluate(BADGES))
        self.assertEqual((badges["V1:1"], badges["V2:0"], badges["V1:0"]), ("v2", "v2", ""))
        self.assertFalse(pg.evaluate("() => __panel._editTlDirty()"), "saved: the take is in the file, so it is not a change")
        self.assertIn("take v2 in", pg.evaluate("() => __panel._editTlNote"))
        pg.evaluate("() => __panel.editTlUndo()")
        cut = self.cut(pg)
        self.assertEqual((cut["v1"][1][0], cut["v1"][1][4], cut["v2"][0][0]), (S2, [], S2))
        self.assertEqual(dict(pg.evaluate(BADGES))["V1:1"], "")
        pg.evaluate("() => __panel.editTlRedo()")
        self.assertEqual(self.cut(pg)["v1"][1][0], S2B)
        self.assertEqual(self.errors, [])

    def test_an_unsaved_take_is_a_change_and_a_saved_one_leaves_the_users_own_edits_unsaved_and_untouched(self):
        pg = self.page(saved=True)
        self.land(pg, take(S2, S2B, 2, saved=False))
        self.assertTrue(pg.evaluate("() => __panel._editTlDirty()"))
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertFalse(pg.evaluate("() => __panel._editTlDirty()"))
        # The user's own edit (a colour), then a saved take.
        pg.evaluate("() => __panel._editTlApply(__panel._editTlCut ? (() => { const c = structuredClone(__panel._editTlCut); c.clips[0].color = '#ff0000'; return c; })() : null)")
        self.assertTrue(pg.evaluate("() => __panel._editTlDirty()"))
        self.land(pg, take(S2, S2B, 2, saved=True))
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[0].color"), "#ff0000", "the user's edit is untouched")
        self.assertEqual(pg.evaluate("() => __panel._editTlSaved.clips[1].file"), S2B, "the baseline has the take")
        self.assertEqual(pg.evaluate("() => __panel._editTlSaved.clips[0].color"), "")
        self.assertTrue(pg.evaluate("() => __panel._editTlDirty()"), "the colour is still unsaved")
        # Undo takes the take out, not the colour.
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[0].color"), "#ff0000")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[1].file"), S2)
        self.assertEqual(self.errors, [])

    def test_a_take_for_a_cut_that_is_not_open_or_a_file_it_does_not_use_does_nothing(self):
        pg = self.page(saved=True)
        before = self.cut(pg)
        self.land(pg, take("D:/out/elsewhere.mp4", "D:/out/elsewhere_v002.mp4", 2, otio="D:/out/other.otio"))
        self.assertEqual(self.cut(pg), before)
        self.assertFalse(pg.evaluate("() => __panel._editTlHistory().past.length > 0"))
        self.land(pg, {"takes": [], "saved": True})
        self.land(pg, None)
        self.assertEqual(self.cut(pg), before)
        self.assertEqual(self.errors, [])

    def test_a_shorter_take_shortens_the_clip_and_retime_slows_it_to_fill(self):
        pg = self.page(saved=True)
        self.land(pg, take(S1, "D:/out/shot_01_v002.mp4", 2))          # 2.5 s of source; the clip used 1..4
        v1 = self.cut(pg)["v1"][0]
        self.assertEqual(v1[:2], ["D:/out/shot_01_v002.mp4", 1])
        self.assertAlmostEqual(v1[2], 1.5, places=2)
        pg.evaluate("() => __panel.editTlUndo()")
        self.land(pg, take(S1, "D:/out/shot_01_v002.mp4", 2, retime=True))
        v1 = self.cut(pg)["v1"][0]
        self.assertAlmostEqual(v1[2], 3, places=2)
        self.assertAlmostEqual(v1[3], 0.5, places=2)

    def test_switching_takes_from_the_menu_is_an_undo_step_and_retime_to_fit_is_there(self):
        pg = self.page(saved=True)
        self.land(pg, take(S1, "D:/out/shot_01_v002.mp4", 2))
        self.land(pg, take("D:/out/shot_01_v002.mp4", "D:/out/shot_01_v003.mp4", 3))
        self.assertEqual(self.cut(pg)["v1"][0][4], [[1, False], [2, False], [3, True]])
        self.click(pg, "a", 0.5, button="right")
        names = pg.locator(".previz-menu-item").all_inner_texts()
        self.assertTrue(any(n.startswith("\u2713") and "v3" in n for n in names), names)
        self.assertTrue(any("v1" in n for n in names) and any("Retime to fit" in n for n in names))
        self.menu_item(pg, "v1").click()
        pg.wait_for_function("() => __panel._editTlCut.clips[0].file === 'D:/out/shot_01_v001.mp4'", timeout=10000)
        self.assertEqual(dict(pg.evaluate(BADGES))["V1:0"], "v1")
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(self.cut(pg)["v1"][0][0], "D:/out/shot_01_v003.mp4")
        self.assertEqual(dict(pg.evaluate(BADGES))["V1:0"], "v3")
        self.assertEqual(self.errors, [])

    def test_saving_after_a_switch_writes_the_active_take(self):
        pg = self.page(saved=True)
        self.land(pg, take(S2, S2B, 2, saved=False))
        pg.evaluate("async () => { await __panel._editTlSave(); }")
        saved = pg.evaluate("() => __saves[__saves.length - 1].edit.clips[1]")
        self.assertEqual([(t["version"], t["active"]) for t in saved["takes"]], [(1, False), (2, True)])
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[1].file"), S2B)
        self.assertFalse(pg.evaluate("() => __panel._editTlDirty()"))

    # ── popped out ──

    def test_the_same_in_the_popped_out_window(self):
        pg = self.page(bridge=True, saved=True)
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel._editTlUi && __panel._editTlUi.body.ownerDocument !== document", timeout=10000)
        pg.evaluate("() => __panel.editTlRefresh()")
        self.click(pg, "a", 1.5, host=win)
        self.click(pg, "c", 7.0, mods=["Control"], host=win)
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:2"])
        self.land(pg, take(S3, "D:/out/shot_03_v002.mp4", 2))
        self.assertEqual(self.cut(pg)["v1"][2][0], "D:/out/shot_03_v002.mp4")
        self.assertEqual(pg.evaluate(MSEL), ["V1:0", "V1:2"], "a take keeps the selection")
        self.assertEqual(dict(pg.evaluate(BADGES))["V1:2"], "v2")
        self.click(pg, "c", 7.0, button="right", host=win)
        win.locator(".previz-menu-item", has_text="v1").first.click()
        pg.wait_for_function("() => __panel._editTlCut.clips[2].file === 'D:/out/shot_03_v001.mp4'", timeout=10000)
        x, y = pg.evaluate(WHERE, [0.2, "V2"])
        win.mouse.click(x, y)                                          # the timeline takes the focus, as a user's click does
        win.keyboard.press("Control+z")
        self.assertEqual(self.cut(pg)["v1"][2][0], "D:/out/shot_03_v002.mp4")
        self.assertEqual(pg.evaluate(MSEL), [], "an undo lets a selection of several go")
        self.click(pg, "a", 1.5, host=win)
        self.click(pg, "c", 7.0, mods=["Control"], host=win)
        self.click(pg, "c", 7.0, button="right", host=win)
        win.locator(".previz-menu-item", has_text="Recreate 2 shots").first.click()
        win.fill(".edit-recreate textarea", "greener")
        win.click(".edit-recreate .edit-btn.primary")
        pg.wait_for_function("() => window.__recreated.length === 1", timeout=10000)
        self.assertEqual([c["id"] for c in pg.evaluate("() => window.__recreated[0].clips")], ["V1:0", "V1:2"])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
