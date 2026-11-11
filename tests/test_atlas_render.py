"""atlas_render: the viewer's relay to the agentY host. Run: python -m unittest tests.test_atlas_render"""
import importlib.util
import json
import base64
import os
import tempfile
import threading
import unittest

import numpy as np
from PIL import Image
from http.server import BaseHTTPRequestHandler, HTTPServer

_spec = importlib.util.spec_from_file_location(
    "atlas_render", os.path.join(os.path.dirname(__file__), "..", "src", "atlas_render.py"))
ar = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ar)

M16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 4, 1]


def world_on_disk(tmp):
    d = os.path.join(tmp, "court")
    os.makedirs(d)
    for n in ("world.json", "world.glb"):
        open(os.path.join(d, n), "w").write("{}")
    return d


class Stub:
    """One server that is both ComfyUI (/agent/host_info) and the agentY host (/agentY/atlas_render)."""

    def __init__(self, host_info=True, token="tok", post_status=200):
        stub = self
        self.seen, self.token, self.post_status = [], token, post_status

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path == "/agent/host_info":
                    if not host_info:
                        return self._send(404, {})
                    return self._send(200, {"agent_server_port": stub.port, "session_token": stub.token})
                stub.seen.append(("GET", self.path, self.headers.get("X-AgentY-Token"), None))
                self._send(200, {"id": "abc", "state": "done", "path": "C:/x/render_000.png"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                stub.seen.append(("POST", self.path, self.headers.get("X-AgentY-Token"), body))
                self._send(stub.post_status, {"ok": True, "id": "abc", "state": "running"} if stub.post_status == 200
                           else {"error": "nope"})
        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.world = world_on_disk(self.tmp.name)

    def req(self, **kw):
        body = {"world_path": os.path.join(self.world, "world.glb"),
                "camera": {"camera_world": M16, "model_world": M16, "fov": 50, "aspect": 1.6, "gated": True},
                "upscale": 2, "add_to_world": True}
        body.update(kw)
        return body

    def test_clean_request(self):
        out = ar.clean_request(self.req())
        self.assertEqual(out["world"], self.world)
        self.assertEqual(out["camera"]["viewer"]["camera_world"], [float(x) for x in M16])
        self.assertTrue(out["camera"]["viewer"]["gated"])
        self.assertEqual((out["upscale"], out["add_to_world"]), (2, True))

    def test_not_an_atlas_world(self):
        other = os.path.join(self.tmp.name, "model.glb")
        open(other, "w").write("x")
        for body in (self.req(world_path=other), self.req(world_path=""), None,
                     self.req(camera=None), self.req(camera={"camera_world": [1, 2]}),
                     self.req(camera={"camera_world": M16, "model_world": [1]}), self.req(upscale=3),
                     self.req(camera={"camera_world": M16, "fov": "x"})):
            with self.assertRaises(ar.RelayError) as cm:
                ar.clean_request(body)
            self.assertEqual(cm.exception.status, 400)

    def test_a_folder_path_works_too(self):
        self.assertEqual(ar.clean_request(self.req(world_path=self.world))["world"], self.world)


class RelayTests(unittest.TestCase):
    setUp = RequestTests.setUp
    req = RequestTests.req

    def test_start_and_poll_go_to_the_host_with_its_token(self):
        stub = Stub()
        self.addCleanup(stub.close)
        out = ar.start_render(stub.base, self.req())
        self.assertEqual(out["id"], "abc")
        method, path, token, body = stub.seen[0]
        self.assertEqual((method, path, token), ("POST", "/agentY/atlas_render", "tok"))
        self.assertEqual(body["camera"]["viewer"]["camera_world"][14], 4.0)
        st = ar.render_state(stub.base, "abc")
        self.assertEqual(st["state"], "done")
        self.assertEqual(stub.seen[1][:3], ("GET", "/agentY/atlas_render?id=abc", "tok"))

    def test_without_the_extension_or_the_host(self):
        stub = Stub(host_info=False)
        self.addCleanup(stub.close)
        with self.assertRaises(ar.RelayError) as cm:
            ar.start_render(stub.base, self.req())
        self.assertEqual(cm.exception.status, 503)
        self.assertIn("agentY", str(cm.exception))
        down = Stub()
        down.close()
        with self.assertRaises(ar.RelayError) as cm:
            ar.start_render(down.base, self.req())
        self.assertEqual(cm.exception.status, 503)

    def test_host_errors_are_passed_on(self):
        stub = Stub(post_status=400)
        self.addCleanup(stub.close)
        with self.assertRaises(ar.RelayError) as cm:
            ar.start_render(stub.base, self.req())
        self.assertEqual((cm.exception.status, str(cm.exception)), (400, "nope"))
        old = Stub(post_status=404)
        self.addCleanup(old.close)
        with self.assertRaises(ar.RelayError) as cm:
            ar.start_render(old.base, self.req())
        self.assertIn("too old", str(cm.exception))

    def test_poll_id_is_sanitised(self):
        stub = Stub()
        self.addCleanup(stub.close)
        ar.render_state(stub.base, "a/../b?x=1")
        self.assertEqual(stub.seen[0][1], "/agentY/atlas_render?id=abx1")
        with self.assertRaises(ar.RelayError):
            ar.render_state(stub.base, "///")


class MoveRelayTests(unittest.TestCase):
    setUp = RequestTests.setUp

    def req(self, **kw):
        keys = [{"t": i / 24, "camera_world": M16[:14] + [-0.1 * i, 1], "fov": 40, "aspect": 1.78, "gated": True} for i in range(3)]
        body = {"world_path": os.path.join(self.world, "world.glb"), "keys": keys, "model_world": M16, "quality": "high",
                "fps": 24, "name": "push", "dry_run": True}
        body.update(kw)
        return body

    def test_clean_move_request(self):
        out = ar.clean_move_request(self.req())
        self.assertEqual(out["world"], self.world)
        self.assertEqual((len(out["keys"]), out["quality"], out["dry_run"], out["confirm_cost"]), (3, "high", True, False))
        self.assertEqual(out["model_world"], [float(x) for x in M16])
        self.assertEqual(out["keys"][2]["camera_world"][14], -0.2)

    def test_bad_move_requests(self):
        for body in (None, self.req(keys=[]), self.req(keys=self.req()["keys"][:1]), self.req(quality="ultra"),
                     self.req(keys=[{"t": 0, "camera_world": [1]}] * 2), self.req(keys=[{"camera_world": M16}] * 2),
                     self.req(model_world=[1]), self.req(keys=self.req()["keys"] * 300), self.req(world_path="")):
            with self.assertRaises(ar.RelayError) as cm:
                ar.clean_move_request(body)
            self.assertEqual(cm.exception.status, 400)

    def test_start_and_poll_use_the_move_route(self):
        stub = Stub()
        self.addCleanup(stub.close)
        self.assertEqual(ar.start_move(stub.base, self.req(dry_run=False, confirm_cost=True))["id"], "abc")
        method, path, token, body = stub.seen[0]
        self.assertEqual((method, path, token), ("POST", "/agentY/atlas_camera_move", "tok"))
        self.assertTrue(body["confirm_cost"] and not body["dry_run"])
        ar.move_state(stub.base, "abc")
        self.assertEqual(stub.seen[1][:2], ("GET", "/agentY/atlas_camera_move?id=abc"))

    def test_an_old_host_is_named(self):
        old = Stub(post_status=404)
        self.addCleanup(old.close)
        with self.assertRaises(ar.RelayError) as cm:
            ar.start_move(old.base, self.req())
        self.assertIn("too old", str(cm.exception))



class CreateTests(unittest.TestCase):
    """New Atlas world: the body the host gets, and the create route."""

    def test_clean_create_request(self):
        ok = ar.clean_create_request({"name": "court yard!", "prompt": " a courtyard ", "aspect_ratio": "4:3",
                                      "mesh_detail": "8"}, [])
        self.assertEqual(ok, {"name": "court yard_", "prompt": "a courtyard", "image_paths": [], "aspect_ratio": "4:3",
                              "mesh_detail": 8, "open_in_viewer": True})
        self.assertEqual(ar.clean_create_request({"name": "r"}, ["C:/a.png"])["image_paths"], ["C:/a.png"])
        for body, imgs in ((None, []), ({"name": "w"}, []), ({"name": "", "prompt": "x"}, []),
                           ({"name": "w", "prompt": "x", "aspect_ratio": "2:1"}, []),
                           ({"name": "w", "prompt": "x", "mesh_detail": 5}, []),
                           ({"name": "w"}, ["p.png"] * (ar.MAX_CREATE_IMAGES + 1))):
            with self.assertRaises(ar.RelayError) as cm:
                ar.clean_create_request(body, imgs)
            self.assertEqual(cm.exception.status, 400)

    def test_the_page_cannot_name_the_pictures_itself(self):
        body = ar.clean_create_request({"name": "w", "prompt": "x", "image_paths": ["C:/secret.png"]}, None)
        self.assertEqual(body["image_paths"], [])        # only what the route resolved and checked is passed on

    def test_start_and_poll_use_the_create_route(self):
        stub = Stub()
        self.addCleanup(stub.close)
        self.assertEqual(ar.start_create(stub.base, {"name": "w", "prompt": "a hall"}, [])["id"], "abc")
        method, path, token, body = stub.seen[0]
        self.assertEqual((method, path, token), ("POST", "/agentY/atlas_create", "tok"))
        self.assertEqual(body["prompt"], "a hall")
        ar.create_state(stub.base, "abc")
        self.assertEqual(stub.seen[1][:2], ("GET", "/agentY/atlas_create?id=abc"))
        with self.assertRaises(ar.RelayError):
            ar.create_state(stub.base, "../")



class ChiselTests(unittest.TestCase):
    """Chisel this view: the body the host gets, and the chisel route."""
    CAM = {"camera_world": list(range(16)), "model_world": list(range(16)), "fov": 50, "aspect": 16 / 9, "gated": True}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.glb = os.path.join(world_on_disk(self.tmp.name), "world.glb")

    def test_clean_chisel_request(self):
        body = ar.clean_chisel_request({"world_path": self.glb, "camera": self.CAM, "prompt": " a fountain ",
                                        "seed": "7", "enhance_prompt": False, "context": False},
                                       "C:/v.png", "C:/m.png", "")
        self.assertEqual(body["world"], os.path.dirname(self.glb))
        self.assertEqual(body["camera"], {"viewer": {"camera_world": [float(i) for i in range(16)],
                                                     "model_world": [float(i) for i in range(16)],
                                                     "fov": 50.0, "aspect": 16 / 9, "gated": True}})
        self.assertEqual((body["prompt"], body["image_path"], body["mask_path"], body["style_image"], body["seed"],
                          body["enhance_prompt"], body["context"]),
                         ("a fountain", "C:/v.png", "C:/m.png", "", 7, False, False))
        self.assertEqual(ar.clean_chisel_request({"world_path": self.glb, "camera": self.CAM, "prompt": "x"},
                                                 depth=("C:/d.png", 1.0, 9.0))["seed"], -1)
        for data, img, mask in ((None, "", ""), ({"world_path": self.glb, "camera": self.CAM}, "", ""),
                                ({"world_path": self.glb, "prompt": "x"}, "", ""),
                                ({"world_path": self.glb, "camera": {"camera_world": [1]}, "prompt": "x"}, "", ""),
                                ({"world_path": self.glb, "camera": self.CAM, "prompt": "x", "seed": "a"}, "", ""),
                                ({"world_path": self.glb, "camera": self.CAM, "prompt": "x"}, "", "C:/m.png"),
                                ({"world_path": self.glb, "camera": self.CAM, "prompt": "x"}, "", "")):  # nothing to build on
            with self.assertRaises(ar.RelayError) as cm:
                ar.clean_chisel_request(data, img, mask)
            self.assertEqual(cm.exception.status, 400)

    def test_the_page_cannot_name_the_pictures_itself(self):
        body = ar.clean_chisel_request({"world_path": self.glb, "camera": self.CAM, "prompt": "x",
                                        "image_path": "C:/secret.png", "mask_path": "C:/m.png",
                                        "depth_path": "C:/secret.png", "z_min": 1, "z_max": 2},
                                       depth=("C:/d.png", 1.0, 9.0))
        self.assertEqual((body["image_path"], body["mask_path"], body["depth_path"], body["z_min"]), ("", "", "C:/d.png", 1.0))

    def test_bad_depth_maps_are_refused(self):
        good = np.ones((2, 2), "<f4").tobytes()
        for d in (None, {"w": 2, "h": 2, "data": "!!"}, {"w": 3, "h": 2, "data": base64.b64encode(good).decode()},
                  {"w": 5000, "h": 5000, "data": ""}, {"w": "a", "h": 2}):
            with self.assertRaises(ar.RelayError):
                ar.decode_depth(d)
        z, w, h = ar.decode_depth({"w": 2, "h": 2, "data": base64.b64encode(good).decode()})
        with self.assertRaises(ar.RelayError):                    # four pixels is no geometry to build on
            ar.write_log_depth(z, self.tmp.name)

    def test_start_and_poll_use_the_chisel_route(self):
        stub = Stub()
        self.addCleanup(stub.close)
        z = np.zeros((36, 64), "<f4")
        z[:, 10:] = np.linspace(1.5, 12.0, 54, dtype="<f4")
        depth = {"w": 64, "h": 36, "data": base64.b64encode(z.tobytes()).decode()}
        out_dir = os.path.join(self.tmp.name, "edits")
        self.assertEqual(ar.start_chisel(stub.base, {"world_path": self.glb, "camera": self.CAM, "prompt": "a hall",
                                                     "depth": depth, "voxel_size": 0.9}, depth_dir=out_dir)["id"], "abc")
        method, path, token, body = stub.seen[0]
        self.assertEqual((method, path, token, body["prompt"]), ("POST", "/agentY/atlas_chisel", "tok", "a hall"))
        self.assertEqual(os.path.dirname(body["depth_path"]), out_dir)
        self.assertEqual(body["voxel_size"], 0.4)
        self.assertAlmostEqual(body["z_max"], 12.0, places=4)
        self.assertGreater(body["z_min"], 1.4)
        png = np.asarray(Image.open(body["depth_path"])).astype(np.float64) / 65535.0
        self.assertEqual(png.shape, (36, 64))
        self.assertEqual(png[0, 0], 0.0)                         # no surface: black
        back = np.exp(np.log(body["z_max"]) + png * (np.log(body["z_min"]) - np.log(body["z_max"])))
        self.assertLess(np.abs(back[:, 20:] - z[:, 20:]).max(), 0.01)
        ar.chisel_state(stub.base, "abc")
        self.assertEqual(stub.seen[1][:2], ("GET", "/agentY/atlas_chisel?id=abc"))

if __name__ == "__main__":
    unittest.main()
