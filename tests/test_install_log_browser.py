"""The install log window, in a real browser: it follows a running install's lines, Stop asks the server to
stop it, it is one window reused for the next install, and with nothing installed yet it says so.

The server's half is played by page.route (the routes themselves are tested in test_rig_routes /
test_paint_generate). Needs Playwright with a browser and node for the stub server; skipped without them.
Run: python -m unittest tests.test_install_log_browser
INSTALL_LOG_SHOTS=<folder> saves a screenshot.
"""
import json
import os
import shutil
import socket
import subprocess
import time
import unittest
import urllib.parse
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHOTS = os.environ.get("INSTALL_LOG_SHOTS") or None


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeLogs:
    """What src/install_log.py answers, kept in Python: logs[id] = {title, state, lines, can_stop}."""

    def __init__(self):
        self.logs = {}
        self.cancelled = []

    def handle(self, route, request):
        u = urllib.parse.urlsplit(request.url)
        q = dict(urllib.parse.parse_qsl(u.query))
        if request.method == "POST":
            body = json.loads(request.post_data or "{}")
            lg = self.logs[body["id"]]
            if body.get("cancel"):
                self.cancelled.append(body["id"])
                lg["lines"].append("-- stop asked for --")
                lg["state"] = "cancelled"
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(self.view(body["id"], 0)))
        if "id" not in q:
            logs = [{"id": k, "title": v["title"], "kind": "install", "state": v["state"], "started": 1_700_000_000,
                     "lines": len(v["lines"])} for k, v in reversed(list(self.logs.items()))]
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"logs": logs}))
        if q["id"] not in self.logs:
            return route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "no such log"}))
        return route.fulfill(status=200, content_type="application/json",
                             body=json.dumps(self.view(q["id"], int(q.get("since") or 0))))

    def view(self, lid, since):
        lg = self.logs[lid]
        return {"id": lid, "title": lg["title"], "kind": "install", "state": lg["state"], "seconds": 12,
                "lines": lg["lines"][since:], "next": len(lg["lines"]), "dropped": 0,
                "can_stop": lg["state"] == "running", "log_file": "D:/x/rig_logs/install.log"}


STATE = """() => { const b = document.querySelector('.ivlog-box'); if (!b) return null;
  const body = b.querySelector('.ivlog-body');
  return { lines: [...b.querySelectorAll('.ivlog-line')].map((d) => d.textContent),
    classes: [...b.querySelectorAll('.ivlog-line')].map((d) => d.className),
    title: b.querySelector('.ivlog-title').textContent, state: b.querySelector('.ivlog-state').dataset.state || '',
    stop: getComputedStyle(b.querySelector('.ivlog-foot .ivlog-btn:last-child')).display !== 'none',
    file: b.querySelector('.ivlog-file').textContent, empty: (b.querySelector('.ivlog-empty') || {}).textContent || '',
    atEnd: body.scrollTop + body.clientHeight >= body.scrollHeight - 4,
    count: document.querySelectorAll('.ivlog-box').length }; }"""


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class InstallLogBrowserTests(unittest.TestCase):
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
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.terminate()
        cls.server.wait(5)

    def page(self, fake):
        page = self.browser.new_page(viewport={"width": 1200, "height": 800})
        page.route("**/imageviewer/install_log*", fake.handle)
        page.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        page.wait_for_function("() => !!window.__panel", timeout=15000)
        return page

    def wait_for(self, page, pred, what, timeout=6.0):
        t0 = time.time()
        s = None
        while time.time() - t0 < timeout:
            s = page.evaluate(STATE)
            if s and pred(s):
                return s
            time.sleep(0.1)
        self.fail(f"{what}: {s}")

    def test_the_window_follows_a_running_install_and_stop_stops_it(self):
        fake = FakeLogs()
        fake.logs["job1"] = {"title": "Installing kimodo into D:/AI/riggingTools", "state": "running",
                             "lines": ["$ python install_rig_tools.py --only kimodo", "Collecting torch"], "can_stop": True}
        page = self.page(fake)
        page.evaluate("""async () => { const m = await import('/extensions/viewer/imageViewer_installLog.js');
            window.__il = m; m.showInstallLog('job1', { host: window.__panel.container }); }""")
        s = self.wait_for(page, lambda s: len(s["lines"]) == 2, "the first lines")
        self.assertEqual(s["title"], "Installing kimodo into D:/AI/riggingTools")
        self.assertEqual(s["state"], "running")
        self.assertTrue(s["stop"])
        self.assertIn("ivlog-line cmd", s["classes"][0])             # a command stands out
        self.assertIn("D:/x/rig_logs/install.log", s["file"])
        # New lines come in while it runs, and the window keeps the last one in view.
        fake.logs["job1"]["lines"] += [f"  Downloading part {i}" for i in range(80)] + ["!! ERROR: pip failed"]
        s = self.wait_for(page, lambda s: len(s["lines"]) == 83, "the new lines")
        self.assertTrue(s["atEnd"])
        self.assertIn("err", s["classes"][-1])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            page.screenshot(path=os.path.join(SHOTS, "install-log.png"))
        # Stop asks the server; the window then says it was cancelled and offers no Stop.
        page.click(".ivlog-foot .ivlog-btn:last-child")
        s = self.wait_for(page, lambda s: s["state"] == "cancelled", "cancelled")
        self.assertEqual(fake.cancelled, ["job1"])
        self.assertFalse(s["stop"])
        # The next install reuses the one window.
        fake.logs["job2"] = {"title": "Downloading sam3d body", "state": "done", "lines": ["GET https://huggingface.co/x", "-- done --"]}
        page.evaluate("() => window.__il.showInstallLog('job2', { host: window.__panel.container })")
        s = self.wait_for(page, lambda s: s["title"] == "Downloading sam3d body" and len(s["lines"]) == 2, "the second log")
        self.assertEqual(s["count"], 1)
        self.assertEqual(s["state"], "done")
        self.assertIn("end", s["classes"][-1])
        # Closing takes it away; what ran is not touched.
        page.click(".ivlog-head .ivlog-x:last-child")
        self.assertIsNone(page.evaluate(STATE))
        page.close()

    def test_with_nothing_installed_the_window_says_so(self):
        page = self.page(FakeLogs())
        page.evaluate("""async () => { const m = await import('/extensions/viewer/imageViewer_installLog.js');
            await m.openLatestInstallLog({ host: window.__panel.container }); }""")
        s = self.wait_for(page, lambda s: s["empty"], "the empty note")
        self.assertIn("Nothing has been installed", s["empty"])
        page.close()


if __name__ == "__main__":
    unittest.main()
