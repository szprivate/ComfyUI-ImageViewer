"""Provenance beside what bEpicSendToViewer saves (provenance_write.py): the graph, how it was made, and no secrets.

A saved file gets `<file>.agenty.json` (only the key "provenance" is set in it; the rest stays) and
`<file>.prov.json.gz` (the redacted API graph and UI workflow). The node writes it for its temp PNGs and for "save to
output", best effort. A fake key in a partner node's `api_key` widget must be in neither file.
Run: python -m unittest tests.test_provenance_write   (or discover -s tests)
"""
import gzip
import hashlib
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
KEY = "sk-test-FAKEKEY1234567890abcdef"

PROMPT = {
    "3": {"class_type": "KSampler", "inputs": {"seed": 1234, "steps": 20, "model": ["4", 0], "positive": ["6", 0]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdxl.safetensors"}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat, hf_ABCDEFGHIJKLMNOPQRSTUVWX is not a token", "clip": ["4", 1]}},
    "9": {"class_type": "KlingVideoNode", "inputs": {"api_key": KEY, "prompt": "a dog", "auth_token": "plain-secret-value",
                                                      "note": f"Bearer abcdefghijklmnopqrstuvwxyz0123 and {KEY}"}},
    "10": {"class_type": "bEpicSendToViewer", "inputs": {"input": ["3", 0], "tab_name": "t"}},
}
WORKFLOW = {"nodes": [
    {"id": 9, "type": "KlingVideoNode", "widgets_values": [KEY, "a dog", "plain-secret-value", 5],
     "inputs": [{"name": "api_key", "widget": {"name": "api_key"}}]},
    {"id": 6, "type": "CLIPTextEncode", "widgets_values": ["a cat"]},
], "links": [], "extra": {"api": KEY}}


def slurp(path, mode="rb"):
    with open(path, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as fh:
        return fh.read()


def _mod(name="provenance_write"):
    pkg = "bepic_prov_under_test"
    if pkg not in sys.modules:
        p = types.ModuleType(pkg)
        p.__path__ = [ROOT]
        sys.modules[pkg] = p
    return importlib.import_module(pkg + "." + name)


class Provenance(unittest.TestCase):
    def setUp(self):
        self.pw = _mod()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.files = []
        for i in range(2):
            p = os.path.join(self.tmp, f"frame_{i}.png")
            with open(p, "wb") as fh:
                fh.write(b"png")
            self.files.append(p)

    def read(self, path):
        with open(path + ".agenty.json", encoding="utf-8") as fh:
            side = json.load(fh)
        with gzip.open(path + ".prov.json.gz", "rt", encoding="utf-8") as fh:
            graph = json.load(fh)
        return side, graph

    def test_each_file_gets_a_sidecar_and_a_graph_in_the_agentY_format(self):
        n = self.pw.annotate(self.files, "10", PROMPT, {"workflow": WORKFLOW, "extra_data": {"api_key_comfy_org": KEY}}, "pid-1")
        self.assertEqual(n, 2)
        for index, path in enumerate(self.files):
            side, graph = self.read(path)
            prov = side["provenance"]
            self.assertEqual(prov["v"], 1)
            self.assertEqual((prov["source"], prov["prompt_id"], prov["output_node"], prov["output_index"], prov["workflow_file"]),
                             ("bEpicSendToViewer", "pid-1", "10", index, ""))
            self.assertEqual(prov["graph_file"], os.path.basename(path) + ".prov.json.gz")
            self.assertRegex(prov["created"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")
            self.assertIn("comfyui_version", prov)
            self.assertEqual(prov["partner"], [])
            self.assertEqual(prov["models"], [{"node": "4", "input": "ckpt_name", "value": "sdxl.safetensors"}])
            self.assertEqual(prov["seeds"], [{"node": "3", "input": "seed", "value": 1234}])
            self.assertEqual(graph["v"], 1)
            self.assertEqual(graph["prompt"]["3"], PROMPT["3"], "an ordinary node is stored as it was")
            self.assertEqual(graph["workflow"]["nodes"][1], WORKFLOW["nodes"][1])
            red = json.dumps(graph["prompt"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            self.assertEqual(prov["graph_sha1"], hashlib.sha1(red.encode("utf-8")).hexdigest())

    def test_a_key_in_a_partner_nodes_api_key_widget_is_stored_nowhere(self):
        self.pw.annotate(self.files, "10", PROMPT, {"workflow": WORKFLOW}, "p")
        for path in self.files:
            side, graph = self.read(path)
            for name in (path + ".agenty.json", path + ".prov.json.gz"):
                raw = slurp(name)
                if name.endswith(".gz"):
                    raw = gzip.decompress(raw)
                self.assertNotIn(KEY.encode(), raw, name)
                self.assertNotIn(b"plain-secret-value", raw, name)
                self.assertNotIn(b"abcdefghijklmnopqrstuvwxyz0123", raw, name)
                self.assertNotIn(b"hf_ABCDEFGHIJKLMNOPQRSTUVWX", raw, name)
            inputs = graph["prompt"]["9"]["inputs"]
            self.assertEqual(inputs["api_key"], "<redacted>")
            self.assertEqual(inputs["auth_token"], "<redacted>")
            self.assertEqual(inputs["prompt"], "a dog")
            self.assertIn("<redacted>", inputs["note"])
            self.assertIn("<redacted>", graph["prompt"]["6"]["inputs"]["text"])
            self.assertEqual(graph["workflow"]["nodes"][0]["widgets_values"], ["<redacted>", "<redacted>", "<redacted>", 5])
            self.assertEqual(graph["workflow"]["extra"]["api"], "<redacted>")
            self.assertEqual(graph["prompt"]["10"], PROMPT["10"])

    def test_the_input_prompt_is_left_alone_and_a_sidecar_keeps_what_else_it_held(self):
        before = json.dumps(PROMPT, sort_keys=True)
        with open(self.files[0] + ".agenty.json", "w", encoding="utf-8") as fh:
            json.dump({"role": "title", "note": "x"}, fh)
        self.pw.annotate(self.files[:1], "10", PROMPT, None, "")
        self.assertEqual(json.dumps(PROMPT, sort_keys=True), before)
        side, graph = self.read(self.files[0])
        self.assertEqual((side["role"], side["note"]), ("title", "x"))
        self.assertIn("provenance", side)
        self.assertIsNone(graph["workflow"])
        self.assertFalse([n for n in os.listdir(self.tmp) if n.endswith(".tmp")])

    def test_key_shapes_are_masked_in_any_text(self):
        for text in ("sk-ant-api03-abcdefghijklmnopqrstuvwx", "ghp_" + "a" * 36, "AIza" + "b" * 35, "xoxb-1234567890-abcdefghij",
                     "Bearer abcdefghijklmnopqrstuvwxyz", KEY):
            self.assertNotIn(text.split()[-1], self.pw.scrub_text(f"use {text} now"))
        self.assertEqual(self.pw.scrub_text("a skyline, 4k, hf_short"), "a skyline, 4k, hf_short")

    def test_nothing_raises_and_nothing_is_written_without_a_graph(self):
        self.assertEqual(self.pw.annotate(self.files, "1", None, None), 0)
        self.assertEqual(self.pw.annotate(self.files, "1", {}, None), 0)
        self.assertEqual(self.pw.annotate([os.path.join(self.tmp, "gone.png"), None, ""], "1", PROMPT, None), 0)
        self.assertEqual(self.pw.annotate(None, "1", PROMPT, "not a dict"), 0)
        self.assertEqual(self.pw.annotate(["/no/such/folder/x.png"], "1", PROMPT, None), 0)
        self.assertEqual(os.listdir(self.tmp).count("frame_0.png.agenty.json"), 0)


def _node_module(tmp):
    fp = types.ModuleType("folder_paths")
    dirs = {"output": os.path.join(tmp, "out"), "temp": os.path.join(tmp, "temp"), "input": os.path.join(tmp, "in")}
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)
    fp.get_output_directory = lambda: dirs["output"]
    fp.get_temp_directory = lambda: dirs["temp"]
    fp.get_input_directory = lambda: dirs["input"]
    fp.get_directory_by_type = lambda t: dirs.get(t)

    def get_save_image_path(prefix, out_dir, w=0, h=0):
        sub, name = os.path.split(prefix)
        folder = os.path.join(out_dir, sub)
        os.makedirs(folder, exist_ok=True)
        return folder, name, len(os.listdir(folder)) + 1, sub, prefix
    fp.get_save_image_path = get_save_image_path
    sent = []
    srv = types.ModuleType("server")
    srv.PromptServer = type("PromptServer", (), {"instance": types.SimpleNamespace(
        send_sync=lambda e, d: sent.append((e, d)), last_prompt_id="run-9")})
    saved = {k: sys.modules.get(k) for k in ("folder_paths", "server")}
    sys.modules.update(folder_paths=fp, server=srv)
    name = "bepic_nodes_prov_under_test"
    pkg = types.ModuleType(name)
    pkg.__path__ = [ROOT]
    sys.modules[name] = pkg
    try:
        mod = importlib.import_module(name + ".nodes")
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return mod, dirs, name, sent


try:
    import torch  # noqa: F401
    import numpy  # noqa: F401
    from PIL import Image  # noqa: F401
except ImportError:  # pragma: no cover
    torch = None


@unittest.skipIf(torch is None, "needs torch, numpy and Pillow")
class NodeWritesProvenance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.nodes, cls.dirs, cls.pkg, cls.sent = _node_module(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_node(self, **kw):
        node = self.nodes.bEpicSendToViewer()
        node.send(torch.rand(2, 8, 8, 3), tab_name="shots", unique_id="10", prompt=PROMPT,
                  extra_pnginfo={"workflow": WORKFLOW}, **kw)
        self.nodes.provenance_write.wait()          # written off the node's thread
        return self.sent[-1][1]["tabs"]["tab"]

    def test_the_temp_pngs_the_viewer_shows_are_annotated(self):
        frames = self.run_node()
        self.assertEqual(len(frames), 2)
        for i, fr in enumerate(frames):
            side = json.loads(slurp(fr["path"] + ".agenty.json", "r"))["provenance"]
            self.assertEqual((side["output_node"], side["output_index"], side["prompt_id"]), ("10", i, "run-9"))
            self.assertTrue(os.path.isfile(fr["path"] + ".prov.json.gz"))
            self.assertNotIn(KEY, slurp(fr["path"] + ".agenty.json", "r"))

    def test_save_to_output_files_are_annotated(self):
        frames = self.run_node(save_to_output=True, filename_prefix="prov/test", file_format="png")
        self.assertTrue(frames)
        paths = [f["path"] for f in frames]
        self.assertTrue(all(os.path.abspath(p).startswith(os.path.abspath(self.dirs["output"])) for p in paths), paths)
        for p in paths:
            graph = json.loads(gzip.decompress(slurp(p + ".prov.json.gz")).decode("utf-8"))
            self.assertEqual(graph["prompt"]["9"]["inputs"]["api_key"], "<redacted>")

    def test_a_failing_writer_never_fails_the_node(self):
        pw = self.nodes.provenance_write
        for name in ("annotate", "annotate_async"):         # in the thread, and before it starts
            real = getattr(pw, name)
            setattr(pw, name, lambda *a, **k: 1 / 0)
            try:
                frames = self.run_node()
            finally:
                setattr(pw, name, real)
            self.assertEqual(len(frames), 2)

    def test_the_write_does_not_hold_up_the_node_and_takes_a_copy_of_the_graph(self):
        import threading
        pw = self.nodes.provenance_write
        gate, real = threading.Event(), pw.annotate
        seen = []
        pw.annotate = lambda paths, uid, prompt, *a: (gate.wait(10), seen.append(prompt))
        try:
            prompt = json.loads(json.dumps(PROMPT))
            node = self.nodes.bEpicSendToViewer()
            node.send(torch.rand(1, 8, 8, 3), tab_name="slow", unique_id="10", prompt=prompt,
                      extra_pnginfo={"workflow": WORKFLOW})
            self.assertFalse(seen)                        # the node returned while the write waits
            prompt.clear()
            gate.set()
            pw.wait()
        finally:
            pw.annotate = real
        self.assertTrue(seen and seen[0])                 # the graph as it was when the node ran

    def test_without_a_prompt_nothing_is_written(self):
        node = self.nodes.bEpicSendToViewer()
        node.send(torch.rand(1, 8, 8, 3), tab_name="shots2", unique_id="11")
        path = self.sent[-1][1]["tabs"]["tab"][0]["path"]
        self.assertFalse(os.path.exists(path + ".agenty.json"))


if __name__ == "__main__":
    unittest.main()
