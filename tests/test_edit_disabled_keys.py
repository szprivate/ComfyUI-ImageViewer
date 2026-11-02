"""Clips switched off (D) and keyframed clips: the file, the render, and the Edit tab's JS agreeing with it.

The JS side is asked through node (the data module is plain JS). The render tests need PyAV: ComfyUI's interpreter.
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest discover -s tests -p "test_edit_disabled_keys.py"
"""
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FPS = 24
NODE = shutil.which("node")


def _modules():
    name = "bepic_disabled_keys_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [ROOT]
        sys.modules[name] = pkg
    tio = importlib.import_module(name + ".timeline_io")
    try:
        tr = importlib.import_module(name + ".timeline_render")
    except ImportError:  # pragma: no cover
        tr = None
    return tio, tr


def js(expr, data):
    """Evaluate `expr` (a JS expression over D and `data`) under node, as JSON."""
    url = "file:///" + os.path.join(ROOT, "js", "bEpicViewer_editTimelineData.js").replace("\\", "/")
    code = (f"import * as D from {json.dumps(url)}; const data = JSON.parse(process.argv[1]);"
            f" process.stdout.write(JSON.stringify({expr}));")
    out = subprocess.run([NODE, "--input-type=module", "-e", code, json.dumps(data)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def shot(path, length, **more):
    return {"file": path, "name": os.path.basename(path), "in": 0, "length": length, "transition": 0, **more}


class DisabledClips(unittest.TestCase):
    def setUp(self):
        self.tio, self.tr = _modules()
        self.tmp = tempfile.mkdtemp()
        self.files = {}
        for n in ("a", "b", "c", "o", "s"):
            p = os.path.join(self.tmp, n + ".mp4").replace("\\", "/")
            open(p, "wb").close()
            self.files[n] = p

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self):
        f = self.files
        return {"clips": [shot(f["a"], 2), shot(f["b"], 2, transition=0.5, disabled=True), shot(f["c"], 2, transition=0.25)],
                "texts": [], "sound": [],
                "tracks": [{"id": "V2", "kind": "video", "name": "V2", "off": False,
                            "clips": [{**shot(f["o"], 1), "at": 0.5, "disabled": True}]},
                           {"id": "A2", "kind": "audio", "name": "A2", "off": False,
                            "clips": [{**shot(f["s"], 1), "at": 0, "disabled": True}]}]}

    def doc(self, edit):
        return self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)

    def test_the_switch_is_otio_enabled_and_metadata_and_comes_back(self):
        doc = self.doc(self.edit())
        items = [c for c in doc["tracks"]["children"][0]["children"] if str(c.get("OTIO_SCHEMA", "")).startswith("Clip")]
        self.assertEqual([c.get("enabled", True) for c in items], [True, False, True])
        self.assertTrue(items[1]["metadata"]["bepic"]["disabled"])
        back = self.tio.editable(doc)
        self.assertEqual([bool(c.get("disabled")) for c in back["clips"]], [False, True, False])
        self.assertTrue(back["tracks"][0]["clips"][0]["disabled"])
        # Switched on again: both forms go.
        edit = {**back, "clips": [dict(c, disabled=False) for c in back["clips"]]}
        again = self.tio.rebuild(doc, edit, may_use=lambda p: True)
        items = [c for c in again["tracks"]["children"][0]["children"] if str(c.get("OTIO_SCHEMA", "")).startswith("Clip")]
        self.assertEqual([c.get("enabled", True) for c in items], [True, True, True])
        self.assertNotIn("disabled", items[1]["metadata"].get("bepic", {}))

    @unittest.skipIf(NODE is None, "needs node")
    def test_the_render_and_the_edit_tab_show_the_same_clip_on_every_frame(self):
        """A disabled V1 shot is a gap in both, its dissolves cuts; disabled clips of the tracks are not there."""
        if self.tr is None:
            self.skipTest("timeline_render needs its imports")
        cut = self.tr.read_cut(self.doc(self.edit()))
        self.assertEqual([c["file"] if not c.get("blank") else "" for c in cut["clips"]], [self.files["a"], "", self.files["c"]])
        self.assertEqual(cut["overlays"], [])
        self.assertEqual(cut["sounds"], [])
        counts = self.tr.frame_counts(cut["clips"], FPS)
        total = self.tr.film_frames(counts)
        shown = [""] * total
        at = 0
        for clip, (n, d_in, _d_out) in zip(cut["clips"], counts):
            at -= d_in
            for k in range(n):
                shown[at + k] = "" if clip.get("blank") else clip["file"]
            at += n
        tab = js("Array.from({ length: data.n }, (_, f) => { const p = D.pictureAt(data.cut, (f + 0.5) / 24); return p && p.clip ? p.clip.file : ''; })",
                 {"cut": {**self.edit(), "fps": FPS, "off": {}}, "n": total})
        self.assertEqual(tab, shown)
        self.assertEqual(js("D.soundItems(data.cut).map(s => s.file)", {"cut": {**self.edit(), "fps": FPS, "off": {}}}), [])


if __name__ == "__main__":
    unittest.main()
