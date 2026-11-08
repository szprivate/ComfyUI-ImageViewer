"""deps_graph / deps_provenance: the Dependencies tab's reader, in the viewer (no agentY needed).
Run: python -m unittest tests.test_deps_graph"""
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
sys.path.insert(0, HERE)
import deps_fixture as fx  # noqa: E402


def _load():
    """The viewer's modules as the package `ivdeps` (relative imports, as in ComfyUI)."""
    pkg = types.ModuleType("ivdeps")
    pkg.__path__ = [SRC]
    sys.modules["ivdeps"] = pkg
    return (importlib.import_module("ivdeps.deps_graph"), importlib.import_module("ivdeps.deps_provenance"),
            importlib.import_module("ivdeps.provenance_write"))


dg, dp, pw = _load()


class DepsGraphTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.rts, self.f = fx.build(self.root)
        dg.set_roots(self.rts)
        self.addCleanup(dg.set_roots, None)
        dg._unknown.clear()

    def test_save_image_files_are_read_from_their_png(self):
        g = dg.graph(self.f["render"])
        by = {os.path.basename(n["id"]): n for n in g["nodes"]}
        self.assertEqual(set(by), {"plate.png", "depth_00001_.png", "render_00001_.png"})
        self.assertEqual(by["depth_00001_.png"]["kind"], "depth")
        self.assertEqual(by["render_00001_.png"]["kind"], "render")
        self.assertTrue(by["render_00001_.png"]["root"])
        edges = {(os.path.basename(e["from"]), os.path.basename(e["to"])) for e in g["edges"]}
        self.assertEqual(edges, {("plate.png", "depth_00001_.png"), ("depth_00001_.png", "render_00001_.png")})
        prompts = by["render_00001_.png"]["prompts"]
        self.assertEqual([(p["role"], p["text"]) for p in prompts], [("positive", "a kitchen at dawn"), ("negative", "blurry")])

    def test_what_was_made_from_a_file_is_known_once_its_outputs_were_read(self):
        self.assertEqual(len(dg.graph(self.f["plate"])["nodes"]), 1)      # nothing read yet
        dg.graph(self.f["render"])                                         # learns render <- depth <- plate
        g = dg.graph(self.f["plate"])
        self.assertEqual({os.path.basename(n["id"]) for n in g["nodes"]},
                         {"plate.png", "depth_00001_.png", "render_00001_.png"})
        idx = os.path.join(self.rts["input"], "agent_metadata", "plate.png.derived.json")
        self.assertTrue(os.path.isfile(idx))

    def test_look_in_folder_records_older_files(self):
        self.assertEqual(dg.reindex(self.rts["output"]), 2)
        self.assertEqual(len(dg.graph(self.f["plate"], down=4)["nodes"]), 3)

    def test_a_changed_input_marks_what_was_made_from_it(self):
        dg.graph(self.f["render"])
        fx.write_png(self.f["plate"], shade=99)
        dg._fp_cache.clear()
        g = dg.graph(self.f["render"])
        depth = next(n for n in g["nodes"] if n["id"].endswith("depth_00001_.png"))
        self.assertIn("plate.png", depth["stale"])

    def test_the_send_node_records_both_ways(self):
        out = os.path.join(self.rts["output"], "send_00001_.png")
        fx.write_png(out, shade=40)
        self.assertEqual(pw.annotate([out], "3", fx.SEND_GRAPH, {"workflow": None}), 1)
        deps = dg.recorded_deps(out)
        self.assertEqual([os.path.basename(i["path"]) for i in deps["inputs"]], ["render_00001_.png"])
        made = dg.derived_of(self.f["render"])
        self.assertEqual([os.path.basename(i["path"]) for i in made], ["send_00001_.png"])

    def test_a_file_that_says_nothing_is_asked_once(self):
        calls = []
        real = dp.provenance_of
        dp.provenance_of = lambda p, **kw: calls.append(p) or real(p, **kw)
        self.addCleanup(setattr, dp, "provenance_of", real)
        dg.graph(self.f["plate"])
        dg.graph(self.f["plate"])
        self.assertLessEqual(len(calls), 2)       # deps_of + prompts_of, the first time only

    def test_secrets_never_leave(self):
        g = dict(fx.RENDER_GRAPH)
        g["9"] = {"class_type": "OpenAIChat", "inputs": {"api_key": "sk-abcdefghijklmnopqrstuvwx", "prompt": "hi"}}
        p = os.path.join(self.rts["output"], "secret_00001_.png")
        fx.write_png(p, {"prompt": json.dumps(g)})
        got = dp.provenance_of(p)
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwx", json.dumps(got))


if __name__ == "__main__":
    unittest.main()
