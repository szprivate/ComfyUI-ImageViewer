"""What the agentY panel can rely on when the viewer hosts it.

agentY-comfyuiConnect draws floating pieces (the # tag menu, the Manage
conversations page) next to the panel. That only works because of three facts
about this viewer, pinned here so a change to them is a deliberate one:
the docked panel lives in the viewer's shadow root, the viewer's full-screen
mode hides every other child of <body>, and the panel is mounted by handing its
host an element (not a document).  Run: python -m unittest tests.test_agent_panel_host_contract
"""
import os
import unittest

JS = os.path.join(os.path.dirname(__file__), "..", "js")


def read(name):
    with open(os.path.join(JS, name), encoding="utf-8") as f:
        return f.read()


class PanelHostContract(unittest.TestCase):
    def test_panel_body_is_inside_the_shadow_root(self):
        src = read("bEpicViewer_agentPanel.js")
        self.assertIn("this.shadowRoot.appendChild(style)", src)
        self.assertIn('host.mountInto(body, { where: "viewer"', src)

    def test_full_screen_mode_hides_the_page_body(self):
        # why a menu appended to document.body vanishes in the viewer
        src = read("bEpicViewer.js")
        self.assertIn("body.bepic-viewer-only > *:not(bepic-viewer-panel)", src)

    def test_viewer_names_what_agenty_reads(self):
        src = read("bEpicViewer_agentPanel.js")
        for name in ("openAgentPanel", "closeAgentPanel", "extractFrame"):
            self.assertIn(name, src)

    def test_viewer_offers_the_history_selection(self):
        # agentY-comfyuiConnect reads window.bEpicViewerApi.historySelection()
        # with each message and for get_history_selection.
        src = read("bEpicViewer.js")
        self.assertIn("historySelection: () => globalViewerPanel?.agentHistorySelection?.()", src)
        self.assertIn("agentHistorySelection()", read("bEpicViewer_agentY.js"))


if __name__ == "__main__":
    unittest.main()
