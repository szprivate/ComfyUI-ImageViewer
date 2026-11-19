"""A lock on any parameter of the Parameters panel (Sebastian 2026-11-19), in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html):
  - every row of a node's parameters has a padlock; locking one greys its field out and disables its widget on
    the canvas, and the lock is kept on the node (node.properties, saved with the workflow);
  - an edit made with several nodes selected passes a locked parameter by, on every node that locked it;
  - a locked parameter's keys cannot be set; unlocking gives everything back;
  - a node loaded with a lock in its properties gets its widget disabled (the extension's loadedGraphNode);
  - on a 3D tab, where the panel is the Channel Box: Lock Selected greys a channel out, the gizmo loses that
    axis, and a move keeps the channel's value; Unlock Selected gives it back.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_param_locks_browser
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

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  const make = (id) => ({ id, type: 'KSampler', title: 'KSampler ' + id, properties: {}, inputs: [],
      widgets: [ { name: 'steps', type: 'number', value: 20, options: { min: 1, max: 100, step: 1 } },
                 { name: 'cfg', type: 'number', value: 7, options: { min: 0, max: 30, step: 0.5 } },
                 { name: 'sampler', type: 'combo', value: 'euler', options: { values: ['euler', 'dpmpp_2m'] } } ] });
  const nodes = [make(1), make(2)];
  window.__nodes = nodes;
  app.graph.setDirtyCanvas = () => {};
  app.graph.getNodeById = (id) => nodes.find((n) => String(n.id) === String(id)) || null;
  P.setViewerToggleState(true);
  if (!P.isPanelDocked('params')) P.togglePanelDocked('params');
  // Both selected on the canvas; the panel shows the last of the selection, node 2.
  app.canvas.selected_nodes = { 2: nodes[1], 1: nodes[0] };
  for (let k = 0; k < 100 && !P.paramsContent.querySelector('.param-lock'); k++) await new Promise((r) => setTimeout(r, 30));
  return P.currentParamNodeId;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ParamLockTests(unittest.TestCase):
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
        if getattr(cls, "server", None):
            cls.server.kill()
            cls.server.wait()

    def test_a_parameter_is_locked_in_the_panel_and_keeps_its_value(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            pg.evaluate(SETUP)
            rows = "window.__panel.paramsContent"
            before = pg.evaluate(f"() => [...{rows}.querySelectorAll('.param-row')].map((r) => !!r.querySelector('.param-lock'))")
            # The padlock of "cfg", clicked.
            pg.evaluate(f"() => {rows}.querySelector('.param-row[data-param-name=cfg] .param-lock').click()")
            locked = pg.evaluate(f"""() => {{ const row = {rows}.querySelector('.param-row[data-param-name=cfg]');
                const n = window.__nodes[1];
                return {{ cls: row.classList.contains('param-locked'), disabled: row.querySelector('input').disabled,
                          on: row.querySelector('.param-lock').classList.contains('on'),
                          props: n.properties.imageviewer_locked, widget: n.widgets[1].disabled,
                          steps: {rows}.querySelector('.param-row[data-param-name=steps] input').disabled }}; }}""")
            # Node 1 locks "steps" (a lock is the node's own).
            pg.evaluate("async () => { const m = await import('/extensions/viewer/imageViewer_paramLocks.js'); "
                        "m.setParamLocked(window.__nodes[0], 'steps', true); }")
            # An edit with both nodes selected: steps stays on node 1, cfg on node 2.
            pg.evaluate("() => { const P = window.__panel; P.applyToSelectedNodes('cfg', 12); P.applyToSelectedNodes('steps', 40); }")
            vals = pg.evaluate("() => window.__nodes.map((n) => [n.widgets[0].value, n.widgets[1].value])")
            # A rebuild keeps it locked.
            pg.evaluate("() => window.__panel.updateParamsPanel(true)")
            rebuilt = pg.evaluate(f"() => {rows}.querySelector('.param-row[data-param-name=cfg] input').disabled")
            # Unlocked: the field and the widget are free again, and the lock is gone from the node.
            pg.evaluate(f"() => {rows}.querySelector('.param-row[data-param-name=cfg] .param-lock').click()")
            unlocked = pg.evaluate(f"""() => {{ const n = window.__nodes[1];
                return {{ disabled: {rows}.querySelector('.param-row[data-param-name=cfg] input').disabled,
                          props: n.properties.imageviewer_locked || null, widget: !!n.widgets[1].disabled }}; }}""")
            pg.evaluate("() => window.__panel.applyToSelectedNodes('cfg', 9)")
            after = pg.evaluate("() => window.__nodes.map((n) => n.widgets[1].value)")
            # A node loaded with a lock in its properties: its widget is disabled by the extension.
            loaded = pg.evaluate("""() => { const n = { id: 3, properties: { imageviewer_locked: ['seed'] },
                    widgets: [{ name: 'seed', value: 1 }, { name: 'denoise', value: 1 }] };
                window.__ext.loadedGraphNode(n); return n.widgets.map((w) => !!w.disabled); }""")
        finally:
            pg.close()
        self.assertTrue(all(before) and len(before) == 3, before)
        self.assertEqual(locked, {"cls": True, "disabled": True, "on": True, "props": ["cfg"], "widget": True, "steps": False})
        self.assertEqual(vals, [[20, 12], [40, 7]])
        self.assertTrue(rebuilt)
        self.assertEqual(unlocked, {"disabled": False, "props": None, "widget": False})
        self.assertEqual(after, [9, 9])
        self.assertEqual(loaded, [True, False])
        self.assertEqual(errors, [])


    def test_a_channel_is_locked_in_the_channel_box(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            out = pg.evaluate("""async () => {
              const P = window.__panel;
              const { app } = await import('/scripts/app.js');
              app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
              P.setViewerToggleState(true);
              await P.spaceOpen('3d');
              const box = await P.previzAddPrimitive('box');
              P.previzSelect(box.id);
              const v = P._modelView(); v.setPaneLayout('single'); v.setGizmoMode('translate');
              await new Promise((r) => setTimeout(r, 200));
              if (!P.isPanelDocked('params')) P.setPanelDocked('params', true);
              P._previzRenderChannels();
              const row = () => P.channelsPanel.querySelector('.cb-row[data-ch="position.1"]');
              P._cbSelect('position.1', {});
              const menu = () => { P._cbMenu({ preventDefault() {}, stopPropagation() {}, target: row(), clientX: 300, clientY: 300 });
                  const items = [...P._previzMenuHost().querySelectorAll('.previz-menu-item')];
                  return items; };
              const lockItem = menu().find((b) => b.textContent.startsWith('Lock Selected'));
              const had = !!lockItem;
              lockItem.click();
              await new Promise((r) => setTimeout(r, 100));
              P._previzRenderChannels();
              const item = () => P.previzScene().items.find((i) => i.id === box.id);
              const locked = { cls: row().classList.contains('locked'), ro: row().querySelector('input').readOnly,
                               list: item().locked, showY: v.gizmo.showY, showX: v.gizmo.showX };
              // The gizmo's move, as it reports one: Y stays.
              P.previzApplyTransform(box.id, { position: [3, 4, 5] }, ['position']);
              const moved = item().position.slice();
              // Typed into the Channel Box: nothing.
              P.previzSetChannel('position', 1, 9);
              const typed = item().position[1];
              const unlockItem = menu().find((b) => b.textContent.startsWith('Unlock Selected'));
              unlockItem.click();
              await new Promise((r) => setTimeout(r, 100));
              P._previzRenderChannels();
              const unlocked = { cls: row().classList.contains('locked'), list: item().locked || null, showY: v.gizmo.showY };
              P.previzSetChannel('position', 1, 9);
              return { had, locked, moved, typed, unlocked, after: item().position[1] };
            }""")
        finally:
            pg.close()
        self.assertTrue(out["had"])
        self.assertEqual(out["locked"], {"cls": True, "ro": True, "list": ["position.1"], "showY": False, "showX": True})
        self.assertEqual(out["moved"][0], 3)
        self.assertEqual(out["moved"][2], 5)
        self.assertNotEqual(out["moved"][1], 4)
        self.assertEqual(out["typed"], out["moved"][1])
        self.assertEqual(out["unlocked"], {"cls": False, "list": None, "showY": True})
        self.assertEqual(out["after"], 9)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
