"""deps_relay: the Dependencies tab's relay to the agentY host. Run: python -m unittest tests.test_deps_relay"""
import importlib.util
import json
import os
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location("deps_relay", os.path.join(HERE, "deps_relay.py"))
dr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dr)

GRAPH = {"ok": True, "root": "/out/depth.mp4", "truncated": False,
         "nodes": [{"id": "/in/plate.mp4", "file": "plate.mp4", "exists": True},
                   {"id": "/out/depth.mp4", "file": "depth.mp4", "exists": True, "root": True},
                   {"id": "/gone/x.png", "file": "x.png", "exists": False}],
         "edges": [{"from": "/in/plate.mp4", "to": "/out/depth.mp4", "kind": "depth"}]}


class Stub:
    def __init__(self, status=200, body=None):
        stub = self
        self.seen = []

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, doc):
                raw = json.dumps(doc).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path == "/agent/host_info":
                    return self._send(200, {"agent_server_port": stub.port, "session_token": "tok"})
                stub.seen.append((self.path, self.headers.get("X-AgentY-Token")))
                self._send(status, body if body is not None else GRAPH)
        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


class Relay(unittest.TestCase):
    def test_asks_the_host_and_marks_what_the_viewer_may_show(self):
        s = Stub()
        self.addCleanup(s.close)
        out = dr.fetch_graph(s.base, "/out/depth.mp4", up=99, down=2, scan=True,
                             may_serve=lambda p: p.startswith("/out/"))
        path, token = s.seen[0]
        q = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
        self.assertTrue(path.startswith("/agentY/deps?"))
        self.assertEqual(token, "tok")
        self.assertEqual(q["path"], ["/out/depth.mp4"])
        self.assertEqual(q["up"], ["12"])          # capped
        self.assertEqual(q["scan"], ["1"])
        view = {n["id"]: n["viewable"] for n in out["nodes"]}
        self.assertEqual(view, {"/in/plate.mp4": False, "/out/depth.mp4": True, "/gone/x.png": False})
        self.assertEqual(len(out["edges"]), 1)

    def test_errors_are_said(self):
        s = Stub(status=404, body={"ok": False, "error": "no such file: a.png"})
        self.addCleanup(s.close)
        with self.assertRaises(dr.RelayError) as c:
            dr.fetch_graph(s.base, "/a.png")
        self.assertIn("no such file", str(c.exception))
        old = Stub(status=404, body={})
        self.addCleanup(old.close)
        with self.assertRaises(dr.RelayError) as c:
            dr.fetch_graph(old.base, "/a.png")
        self.assertIn("too old", str(c.exception))
        with self.assertRaises(dr.RelayError):
            dr.fetch_graph(s.base, "")


if __name__ == "__main__":
    unittest.main()
