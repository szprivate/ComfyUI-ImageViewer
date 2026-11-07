"""What a user saved while the viewer was still called "bEpic" (before 1.18) keeps working.

legacy_names.py (environment variables, the per-user folder, settings ids, a cut's notes),
paint_io (an .ora's bepic.json) and js/imageViewer_legacy.js (localStorage, ComfyUI
settings and keybindings, node types in a workflow).
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
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NODE = shutil.which("node")


def _pkg():
    name = "imageviewer_legacy_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[name] = pkg
    return name


def _mod(sub):
    return importlib.import_module(_pkg() + "." + sub)


class Python(unittest.TestCase):
    def setUp(self):
        self.L = _mod("legacy_names")

    def test_an_old_environment_variable_counts_as_the_new_one(self):
        env = {"BEPIC_VIEWER_ROOTS": "D:/a", "BEPIC_TEMP_BUDGET_MB": "10",
               "IMAGE_VIEWER_SETTINGS": "new", "BEPIC_VIEWER_SETTINGS": "old",
               "BEPIC_WORLDS_DIR": "w"}
        self.L.adopt_old_env(env)
        self.assertEqual(env["IMAGE_VIEWER_ROOTS"], "D:/a")
        self.assertEqual(env["IMAGE_VIEWER_TEMP_BUDGET_MB"], "10")
        self.assertEqual(env["IMAGE_VIEWER_SETTINGS"], "new")          # the new name wins
        self.assertNotIn("IMAGE_VIEWER_WORLDS_DIR", env)               # the Worlds pack's own

    def test_the_old_user_folder_is_copied_once_and_left_alone(self):
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        os.makedirs(os.path.join(home, ".bepic_viewer"))
        with open(os.path.join(home, ".bepic_viewer", "roots.txt"), "w") as fh:
            fh.write("D:/projects\n")
        new = self.L.user_dir(home)
        self.assertEqual(new, os.path.join(home, ".comfyui_image_viewer"))
        with open(os.path.join(new, "roots.txt")) as fh:
            self.assertEqual(fh.read(), "D:/projects\n")
        self.assertTrue(os.path.isfile(os.path.join(home, ".bepic_viewer", "roots.txt")))
        with open(os.path.join(new, "roots.txt"), "w") as fh:
            fh.write("E:/\n")
        self.L.user_dir(home)                                          # not copied over again
        with open(os.path.join(new, "roots.txt")) as fh:
            self.assertEqual(fh.read(), "E:/\n")

    def test_an_old_settings_id_reads_as_the_new_one(self):
        self.assertEqual(self.L.renamed_setting("bEpic.Viewer.Playback.FPS"), "ImageViewer.Playback.FPS")
        self.assertEqual(self.L.renamed_setting("ImageViewer.Playback.FPS"), "ImageViewer.Playback.FPS")

    def test_a_cuts_old_notes_and_titles_get_the_new_names(self):
        doc = {"metadata": {"bepic": {"edited": "t"}},
               "tracks": {"children": [{"metadata": {"bepic": {"lock": True}, "imageviewer": {"solo": 1}},
                                        "children": [{"media_reference": {"generator_kind": "bepic.title"},
                                                      "metadata": {"bepic": {"title": {"text": "Hi"}}}}]}]}}
        self.L.renamed_otio(doc)
        self.assertEqual(doc["metadata"], {"imageviewer": {"edited": "t"}})
        track = doc["tracks"]["children"][0]
        self.assertEqual(track["metadata"], {"imageviewer": {"lock": True, "solo": 1}})
        clip = track["children"][0]
        self.assertEqual(clip["media_reference"]["generator_kind"], "imageviewer.title")
        self.assertEqual(clip["metadata"]["imageviewer"]["title"]["text"], "Hi")

    def test_timeline_io_reads_an_old_cut_with_the_new_names(self):
        tio = _mod("timeline_io")
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, "cut.otio")
        with open(path, "w") as fh:
            json.dump({"OTIO_SCHEMA": "Timeline.1", "metadata": {"bepic": {"edited": "x"}},
                       "tracks": {"OTIO_SCHEMA": "Stack.1", "children": []}}, fh)
        self.assertEqual(tio._load(path)["metadata"], {"imageviewer": {"edited": "x"}})

    def test_a_paint_document_saved_as_bepic_json_opens(self):
        try:
            pio = _mod("paint_io")
        except ImportError as e:  # pragma: no cover
            self.skipTest(f"paint_io needs {e}")
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        doc = pio.PaintDoc(8, 6, "old")
        new, old = os.path.join(d, "new.ora"), os.path.join(d, "old.ora")
        pio.write_ora(new, doc)
        with zipfile.ZipFile(new) as src, zipfile.ZipFile(old, "w") as dst:
            for info in src.infolist():
                data = src.read(info.filename)
                if info.filename == "imageviewer.json":
                    info = zipfile.ZipInfo("bepic.json", info.date_time)
                dst.writestr(info, data)
        back = pio.read_ora(old)
        self.assertEqual((back.meta["w"], back.meta["h"], back.meta["name"]), (8, 6, "old"))


@unittest.skipUnless(NODE, "needs node")
class Page(unittest.TestCase):
    def js(self, body):
        url = "file:///" + os.path.join(ROOT, "js", "imageViewer_legacy.js").replace("\\", "/")
        code = f"import * as L from {json.dumps(url)}; const out = await (async () => {{ {body} }})();" \
               f" process.stdout.write(JSON.stringify(out));"
        res = subprocess.run([NODE, "--input-type=module", "-e", code], capture_output=True, text=True, check=True)
        return json.loads(res.stdout)

    def test_old_localstorage_keys_are_moved_and_a_new_one_wins(self):
        out = self.js("""
            const m = new Map([["bepic.viewer.edits", "A"], ["bEpicViewer:state:v1:/", "S"],
                               ["bepic.edit.recent", "old"], ["imageviewer.edit.recent", "new"], ["other", "x"]]);
            const s = { get length() { return m.size; }, key: (i) => [...m.keys()][i],
                        getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, v),
                        removeItem: (k) => m.delete(k) };
            L.migrateStorage(s);
            return Object.fromEntries(m);""")
        self.assertEqual(out, {"imageviewer.viewer.edits": "A", "imageViewer:state:v1:/": "S",
                               "imageviewer.edit.recent": "new", "other": "x"})

    def test_old_node_types_in_a_workflow_and_its_subgraphs_load_as_the_new_ones(self):
        out = self.js("""
            const g = { nodes: [{ type: "bEpicSendToViewer" }, { type: "KSampler" }],
                        definitions: { subgraphs: [{ nodes: [{ type: "bEpicScene3D" }, { type: "bEpicImageViewerRoto" }] }] } };
            return [L.renameLegacyNodes(g), g];""")
        self.assertEqual(out[0], 3)
        self.assertEqual([n["type"] for n in out[1]["nodes"]], ["ImageViewerSend", "KSampler"])
        self.assertEqual([n["type"] for n in out[1]["definitions"]["subgraphs"][0]["nodes"]],
                         ["ImageViewerScene3D", "ImageViewerRoto"])

    def test_old_settings_and_keybindings_are_carried_over_once(self):
        out = self.js("""
            const v = { "bEpic.Viewer.Playback.FPS": 30,
                        "Comfy.Keybinding.NewBindings": [{ commandId: "bEpic.Viewer.playPause", combo: { key: "k" } },
                                                         { commandId: "bEpic.toggleViewer", combo: { key: "v" } },
                                                         { commandId: "Comfy.Other" }] };
            const setting = { get: (k) => v[k], set: async (k, x) => { v[k] = x; } };
            const ids = ["ImageViewer.Playback.FPS", "ImageViewer.Playback.Loop"];
            await L.migrateSettings(setting, ids);
            v["ImageViewer.Playback.FPS"] = 25;            // changed after the move
            await L.migrateSettings(setting, ids);          // the next start: the old value is gone
            return v;""")
        self.assertEqual(out["ImageViewer.Playback.FPS"], 25)
        self.assertIsNone(out["bEpic.Viewer.Playback.FPS"])
        self.assertNotIn("ImageViewer.Playback.Loop", out)
        self.assertEqual([b["commandId"] for b in out["Comfy.Keybinding.NewBindings"]],
                         ["ImageViewer.playPause", "ImageViewer.toggleViewer", "Comfy.Other"])

    def test_a_history_sequence_saved_under_the_old_key_unpacks(self):
        url = "file:///" + os.path.join(ROOT, "js", "imageViewer_historyData.js").replace("\\", "/")
        code = (f"import * as H from {json.dumps(url)};"
                " const old = [{ src: 'a_0001.png', fps: 24, _bepicSeq: [{ src: [5, '2', 4] }] }];"
                " process.stdout.write(JSON.stringify([H.unpackSnapshot(old), H.packSnapshot(old) === old]));")
        res = subprocess.run([NODE, "--input-type=module", "-e", code], capture_output=True, text=True, check=True)
        frames, untouched = json.loads(res.stdout)
        self.assertEqual([f["src"] for f in frames], ["a_0001.png", "a_0002.png"])
        self.assertTrue(untouched)

    def test_the_old_page_api_name_still_answers(self):
        out = self.js("""
            const w = {}; L.aliasOldApi(w); w.imageViewerApi = { a: 1 };
            const seen = w.bEpicViewerApi.a; w.bEpicViewerApi = { b: 2 };
            return [seen, w.imageViewerApi.b];""")
        self.assertEqual(out, [1, 2])


class Routes(unittest.TestCase):
    def test_every_route_also_answers_under_the_old_name(self):
        with open(os.path.join(ROOT, "src", "viewer_api.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('(("/imageviewer/", "/bepic/"), ("/api/imageviewer/", "/api/bepic/"))', src)

    def test_the_old_node_ids_are_kept_as_hidden_aliases(self):
        with open(os.path.join(ROOT, "src", "nodes.py"), encoding="utf-8") as fh:
            src = fh.read()
        for old in ("bEpicSendToViewer", "bEpicImageViewerRoto", "bEpicImageViewerSAM3Collector", "bEpicScene3D"):
            self.assertIn(f'"{old}":', src)
        self.assertIn('"DEPRECATED": True', src)


if __name__ == "__main__":
    unittest.main()
