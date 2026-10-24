"""lora_io: the Dataset panel's file guard. Run: python -m unittest tests.test_lora_io (or pytest)"""
import importlib.util
import json
import os
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location("lora_io", os.path.join(os.path.dirname(__file__), "..", "lora_io.py"))
io = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(io)

# manifest_sha of this manifest as agenty_core's formats.manifest_sha computes it (pinned: the two must not drift)
VECTOR_MANIFEST = {"trigger_word": "ohwx", "model": "flux1-dev",
                   "items": [{"file": "items/i001.png", "caption": "ohwx a cat", "included": True, "crop": None},
                             {"file": "items/i002.png", "caption": "gone", "included": False, "crop": None},
                             {"file": "items/i003.png", "caption": "ohwx \u00fcn\u00ef", "crop": [0.1, 0.2, 0.5, 0.5]}]}
VECTOR_SHA = "d3d160065d63d9723d783def906967f5bedc04425d98d6e4c89e789f01db428c"


def manifest():
    return {"version": 1, "name": "cat", "subject": "a cat", "kind": "character", "model": "flux1-dev",
            "trigger_word": "ohwx", "caption_style": "natural", "status": "review", "approved_at": None,
            "created": "2026-01-01", "buckets": [[512, 512]], "mystery": {"keep": 1},
            "summary": {"count": 0, "included": 0, "removed": 0, "warnings": ["w"]},
            "items": [{"id": "i001", "file": "items/i001.png", "kind": "image", "caption": "ohwx a cat",
                       "included": True, "crop": None, "note": "n", "extra_item_key": 7},
                      {"id": "i002", "file": "items/i002.png", "kind": "image", "caption": "ohwx b",
                       "included": False, "crop": None, "removed_by": "agent"}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        self.ds = os.path.join(self.out, "agent", "lora_datasets", "cat")
        os.makedirs(os.path.join(self.ds, "items"))
        for n in ("i001.png", "i002.png"):
            with open(os.path.join(self.ds, "items", n), "wb") as fh:
                fh.write(b"\x89PNG")
        self._w(self.ds, "manifest.json", manifest())

    def _w(self, folder, name, data):
        with open(os.path.join(folder, name), "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def _r(self, folder, name):
        with open(os.path.join(folder, name), encoding="utf-8") as fh:
            return json.load(fh)


class ShaTests(unittest.TestCase):
    def test_fixed_vector(self):
        self.assertEqual(io.manifest_sha(VECTOR_MANIFEST), VECTOR_SHA)

    def test_matches_agenty_core_when_installed(self):
        try:
            from agenty_core.tools.lora_training import formats
        except Exception:
            self.skipTest("agenty_core not importable here")
        self.assertEqual(io.manifest_sha(VECTOR_MANIFEST), formats.manifest_sha(VECTOR_MANIFEST))

    def test_removed_items_do_not_change_it(self):
        m = json.loads(json.dumps(VECTOR_MANIFEST))
        m["items"][1]["caption"] = "something else"
        self.assertEqual(io.manifest_sha(m), VECTOR_SHA)


class DatasetTests(Base):
    def test_list_and_get(self):
        rows = io.list_datasets(self.out)
        self.assertEqual([r["name"] for r in rows], ["cat"])
        self.assertEqual((rows[0]["count"], rows[0]["included"], rows[0]["removed"]), (2, 1, 1))
        self.assertEqual(rows[0]["review"], "none")
        got = io.get_dataset(self.out, "cat")
        self.assertEqual(got["manifest"]["summary"]["warnings"], ["w"])
        self.assertEqual(got["dir"], self.ds)

    def test_bad_names_and_missing(self):
        for bad in ("../x", "a/b", "", None, "..", "a\\b"):
            with self.assertRaises(io.LoraError):
                io.get_dataset(self.out, bad)
        with self.assertRaises(io.LoraError) as c:
            io.get_dataset(self.out, "nope")
        self.assertEqual(c.exception.status, 404)

    def test_save_keeps_unknown_keys_and_recomputes_summary(self):
        m = manifest()
        m["items"][1]["included"] = True
        m["items"][0]["caption"] = "edited"
        del m["mystery"]
        del m["items"][0]["extra_item_key"]
        m["status"] = "approved"            # the panel cannot set this
        out = io.save_dataset(self.out, "cat", m)
        disk = self._r(self.ds, "manifest.json")
        self.assertEqual(disk["mystery"], {"keep": 1})
        self.assertEqual(disk["items"][0]["extra_item_key"], 7)
        self.assertEqual(disk["items"][0]["caption"], "edited")
        self.assertEqual(disk["summary"], {"count": 2, "included": 2, "removed": 0, "warnings": ["w"]})
        self.assertEqual(disk["status"], "review")
        self.assertFalse(out["reset_approval"])
        self.assertEqual([n for n in os.listdir(self.ds) if n.endswith(".tmp")], [])

    def test_save_refuses_escaping_files_and_garbage(self):
        for bad in ("../../x.png", "/etc/x.png", "C:/x.png", "items/../../x"):
            m = manifest()
            m["items"][0]["file"] = bad
            with self.assertRaises(io.LoraError):
                io.save_dataset(self.out, "cat", m)
        with self.assertRaises(io.LoraError):
            io.save_dataset(self.out, "cat", {"items": "x"})

    def test_save_while_training_is_refused(self):
        m = manifest()
        m["status"] = "training"
        self._w(self.ds, "manifest.json", m)
        with self.assertRaises(io.LoraError) as c:
            io.save_dataset(self.out, "cat", manifest())
        self.assertEqual(c.exception.status, 409)

    def test_approve_writes_review_with_sha_and_status(self):
        r = io.review_dataset(self.out, "cat", "approve", "go")
        rv = self._r(self.ds, "review.json")
        self.assertEqual(rv["state"], "approved")
        self.assertEqual(rv["by"], "viewer")
        disk = self._r(self.ds, "manifest.json")
        self.assertEqual(rv["manifest_sha"], io.manifest_sha(disk))
        self.assertEqual(disk["status"], "approved")
        self.assertTrue(disk["approved_at"])
        self.assertIn("approved in the viewer", r["message"])

    def test_edit_after_approval_resets_review(self):
        io.review_dataset(self.out, "cat", "approve")
        m = self._r(self.ds, "manifest.json")
        m["items"][0]["caption"] = "changed"
        out = io.save_dataset(self.out, "cat", m)
        self.assertTrue(out["reset_approval"])
        self.assertEqual(self._r(self.ds, "review.json")["state"], "pending")
        self.assertEqual(self._r(self.ds, "manifest.json")["status"], "review")

    def test_save_without_training_relevant_change_keeps_approval(self):
        io.review_dataset(self.out, "cat", "approve")
        m = self._r(self.ds, "manifest.json")
        m["caption_style"] = "tags"          # not part of the hash
        out = io.save_dataset(self.out, "cat", m)
        self.assertFalse(out["reset_approval"])
        self.assertEqual(self._r(self.ds, "review.json")["state"], "approved")

    def test_approve_with_manifest_saves_it_first(self):
        m = manifest()
        m["items"][0]["caption"] = "ohwx final"
        io.review_dataset(self.out, "cat", "approve", "", m)
        disk = self._r(self.ds, "manifest.json")
        self.assertEqual(disk["items"][0]["caption"], "ohwx final")
        self.assertEqual(self._r(self.ds, "review.json")["manifest_sha"], io.manifest_sha(disk))

    def test_approve_needs_an_included_item(self):
        m = manifest()
        m["items"][0]["included"] = False
        with self.assertRaises(io.LoraError):
            io.review_dataset(self.out, "cat", "approve", "", m)
        self.assertNotEqual(io.load_review(self.ds).get("state"), "approved")

    def test_ask_and_cancel(self):
        with self.assertRaises(io.LoraError):
            io.review_dataset(self.out, "cat", "ask", "  ")
        r = io.review_dataset(self.out, "cat", "ask", "crop the faces tighter")
        self.assertEqual(self._r(self.ds, "review.json")["state"], "changes")
        self.assertEqual(self._r(self.ds, "review.json")["note"], "crop the faces tighter")
        self.assertIn("crop the faces tighter", r["message"])
        io.review_dataset(self.out, "cat", "cancel")
        self.assertEqual(self._r(self.ds, "review.json")["state"], "cancelled")
        self.assertEqual(self._r(self.ds, "manifest.json")["status"], "cancelled")
        with self.assertRaises(io.LoraError):
            io.review_dataset(self.out, "cat", "explode")

    def test_dataset_name_of_path(self):
        mp = os.path.join(self.ds, "manifest.json")
        self.assertEqual(io.dataset_name_of_path(mp, self.out), "cat")
        other = os.path.join(self.out, "manifest.json")
        with open(other, "w") as fh:
            fh.write("{}")
        self.assertIsNone(io.dataset_name_of_path(other, self.out))
        self.assertIsNone(io.dataset_name_of_path(os.path.join(self.ds, "items", "i001.png"), self.out))


class FileTests(Base):
    def test_serves_inside_and_refuses_outside(self):
        p = os.path.join(self.ds, "items", "i001.png")
        self.assertEqual(io.resolve_file(self.out, p), os.path.abspath(p))
        self.assertEqual(io.resolve_file(self.out, "lora_datasets/cat/items/i001.png"), os.path.abspath(p))
        secret = os.path.join(self.out, "secret.png")
        with open(secret, "wb") as fh:
            fh.write(b"x")
        for bad in (secret, os.path.join(self.ds, "items", "..", "..", "..", "secret.png"),
                    "lora_datasets/../../secret.png", os.path.join(self.ds, "manifest.json"), "", None):
            with self.assertRaises(io.LoraError):
                io.resolve_file(self.out, bad)
        with self.assertRaises(io.LoraError) as c:
            io.resolve_file(self.out, os.path.join(self.ds, "items", "nope.png"))
        self.assertEqual(c.exception.status, 404)


class RunTests(Base):
    def setUp(self):
        super().setUp()
        self.run = os.path.join(self.out, "agent", "lora_runs", "job1")
        os.makedirs(os.path.join(self.run, "samples"))
        with open(os.path.join(self.run, "samples", "s1.png"), "wb") as fh:
            fh.write(b"\x89PNG")
        self._w(self.run, "job.json", {"dataset": "cat", "model": "flux1-dev", "steps": 100})
        self._w(self.run, "progress.json", {"job": "job1", "status": "running", "step": 10, "total": 100,
                                            "pct": 0.1, "updated": 5, "dataset": "cat"})
        self._w(self.run, "samples.json", [{"step": 10, "files": [{"prompt": "p", "file": "samples/s1.png"}]}])
        with open(os.path.join(self.run, "events.jsonl"), "w") as fh:
            fh.write(json.dumps({"id": 1, "t": 1, "kind": "started", "text": "go"}) + "\nnot json\n")
            fh.write(json.dumps({"id": 2, "t": 2, "kind": "sample", "text": "s"}) + "\n")
        with open(os.path.join(self.run, "train.log"), "w") as fh:
            fh.write("\n".join(f"line {i}" for i in range(200)))

    def test_list_and_get(self):
        self.assertEqual([r["name"] for r in io.list_runs(self.out)], ["job1"])
        r = io.get_run(self.out, "job1")
        self.assertEqual(r["progress"]["step"], 10)
        self.assertEqual([e["id"] for e in r["events"]], [1, 2])
        self.assertEqual(r["log_tail"].split("\n")[-1], "line 199")
        self.assertEqual(len(r["log_tail"].split("\n")), io.LOG_TAIL_LINES)
        f = r["samples"][0]["files"][0]
        self.assertEqual(io.resolve_file(self.out, f["path"]), os.path.abspath(f["path"]))

    def test_control_writes_stop(self):
        io.control_run(self.out, "job1", "stop", True)
        c = self._r(self.run, "control.json")
        self.assertEqual((c["action"], c["keep"]), ("stop", True))
        io.control_run(self.out, "job1", "stop", False)
        self.assertFalse(self._r(self.run, "control.json")["keep"])

    def test_control_refuses(self):
        with self.assertRaises(io.LoraError):
            io.control_run(self.out, "job1", "pause")
        with self.assertRaises(io.LoraError):
            io.control_run(self.out, "../job1", "stop")
        self._w(self.run, "progress.json", {"status": "done"})
        with self.assertRaises(io.LoraError) as c:
            io.control_run(self.out, "job1", "stop")
        self.assertEqual(c.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
