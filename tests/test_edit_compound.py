"""Compound clips in the .otio: written flat by the page (toSave), kept by timeline_io, folded back (regroupCut).

    python -m unittest tests.test_edit_compound
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


def _tio():
    name = "imageviewer_compound_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[name] = pkg
    return importlib.import_module(name + ".timeline_io")


# The page's half, under node: make a compound, write what a save sends; or fold a read cut back.
JS = r"""
import * as D from "%s";
const [mode, arg] = [process.argv[2], process.argv[3]];
const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const files = JSON.parse(arg);
const cut = { ...D.emptyCut("t", 24),
    clips: [shot(files.a, 4), shot(files.b, 3, { in: 1 }), shot(files.c, 2)],
    tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [shot(files.c, 1, { at: 4.5 })] },
             { id: "V3", kind: "video", name: "V3", off: false, clips: [shot(files.c, 1, { at: 0.5 })] },
             { id: "A2", kind: "audio", name: "A2", off: false, clips: [shot(files.s, 2, { at: 5 })] }] };
const r = D.makeCompound(cut, [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }, { kind: "tclip", track: "V2", i: 0 }, { kind: "tclip", track: "A2", i: 0 }], "Mid");
if (mode === "save") console.log(JSON.stringify(D.toSave(r.cut)));
else {
    const back = D.regroupCut(JSON.parse(process.argv[4]));
    // the file names its clips by their place (ref); the cut before the save by their files
    for (const c of [...back.clips, ...back.tracks.flatMap((k) => k.clips)]) delete c.ref;
    console.log(JSON.stringify({ same: D.sameCut(back, r.cut), clips: back.clips.length, compound: D.isCompound(back.clips[1]),
                                 tracks: back.tracks.map((k) => [k.id, k.clips.length]) }));
}
"""


@unittest.skipIf(shutil.which("node") is None, "needs node")
class CompoundsInTheFile(unittest.TestCase):
    def setUp(self):
        self.tio = _tio()
        self.tmp = tempfile.mkdtemp()
        self.files = {}
        for k, ext in (("a", "mp4"), ("b", "mp4"), ("c", "png"), ("s", "wav")):
            self.files[k] = os.path.join(self.tmp, f"{k}.{ext}").replace("\\", "/")  # timeline_io writes paths with /
            open(self.files[k], "wb").close()
        self.script = os.path.join(self.tmp, "page.mjs")
        with open(self.script, "w") as f:
            f.write(JS % ("file://" + os.path.join(ROOT, "js", "imageViewer_editTimelineData.js").replace("\\", "/")))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def node(self, *args):
        out = subprocess.run(["node", self.script, *args], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_a_compound_is_written_flat_and_comes_back_whole(self):
        edit = self.node("save", json.dumps(self.files))
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)
        meta = doc["metadata"]["imageviewer"]["compounds"]
        self.assertEqual(list(meta), ["C1"])
        v1 = [c for c in doc["tracks"]["children"][0]["children"] if c["OTIO_SCHEMA"].startswith("Clip")]
        self.assertEqual(len(v1), 3, "the compound's two shots are clips of V1 in the file")
        self.assertEqual([(c.get("metadata") or {}).get("imageviewer", {}).get("cpart") for c in v1],
                         [None, {"id": "C1"}, {"id": "C1"}])
        read = self.tio.editable(json.loads(json.dumps(doc)))
        self.assertEqual(list(read["compounds"]), ["C1"])
        self.assertTrue(any(k.get("cpart") == "C1" for k in read["tracks"]), "the tracks made for it are marked")
        back = self.node("back", json.dumps(self.files), json.dumps(read))
        self.assertEqual(back["clips"], 2)
        self.assertTrue(back["compound"])
        self.assertEqual(back["tracks"], [["V2", 0], ["V3", 1], ["A2", 0]])
        self.assertTrue(back["same"], "the cut read back is the cut that was saved")

    def test_a_save_without_compounds_drops_them_and_one_without_the_key_keeps_them(self):
        edit = self.node("save", json.dumps(self.files))
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)
        kept = self.tio.rebuild(doc, {k: v for k, v in edit.items() if k != "compounds"}, may_use=lambda p: True)
        self.assertIn("C1", kept["metadata"]["imageviewer"]["compounds"])
        gone = self.tio.rebuild(doc, {**edit, "compounds": {}}, may_use=lambda p: True)
        self.assertNotIn("compounds", gone["metadata"]["imageviewer"])

    def test_ids_that_are_not_ids_are_left_out(self):
        self.assertEqual(self.tio.compounds_of({"compounds": {"C1": {"cut": {}}, "../x": {"cut": {}}, "C2": {"cut": 3}}}),
                         {"C1": {"cut": {}}})
        self.assertEqual(self.tio.compounds_of({"compounds": [1]}), {})


if __name__ == "__main__":
    unittest.main()
