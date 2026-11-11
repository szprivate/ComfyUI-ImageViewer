"""scripts/rig/install_rig_tools.py: which flash_attn wheel and torch it picks. No network: the pages are stand-ins."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts", "rig"))
import install_rig_tools as I  # noqa: E402

BASE = "https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download"
PAGE = "\n".join(f"| 3.11 | {t} | x | [Download1(v0.1)]({BASE}/v0.1/flash_attn-{f}+{c}torch{t}-{p}-{p}-{plat}.whl) |"
                 for f, c, t, p, plat in [
                     ("2.8.3", "cu128", "2.9", "cp311", "win_amd64"),
                     ("2.8.3", "cu128", "2.8", "cp311", "win_amd64"),
                     ("2.8.2", "cu128", "2.8", "cp311", "win_amd64"),
                     ("2.8.3", "cu126", "2.8", "cp311", "win_amd64"),
                     ("2.8.3", "cu124", "2.6", "cp311", "win_amd64"),
                     ("2.8.3", "cu128", "2.8", "cp312", "win_amd64"),
                     ("2.8.3", "cu128", "2.8", "cp311", "linux_x86_64"),
                 ]) + f"\n| 3.9+ | 2.9 | x | [D]({BASE}/v0.9/flash_attn_3-3.0.0+cu128torch2.9gitx-cp39-abi3-win_amd64.whl) |"


class PickTests(unittest.TestCase):
    def test_parses_only_flash_attn_2_for_the_platform(self):
        w = I.flash_wheels(PAGE, "win_amd64")
        self.assertEqual(len(w), 6)
        self.assertEqual(w[0], {"url": f"{BASE}/v0.1/flash_attn-2.8.3+cu128torch2.9-cp311-cp311-win_amd64.whl",
                                "flash": "2.8.3", "cuda": "cu128", "torch": "2.9", "py": "cp311"})
        self.assertEqual(len(I.flash_wheels(PAGE, "linux_x86_64")), 1)

    def test_newest_torch_the_other_indexes_also_have(self):
        w = I.flash_wheels(PAGE, "win_amd64")
        pyg = {("2.8", "cu128"), ("2.6", "cu124")}            # data.pyg.org has no torch 2.9 build
        got = I.pick_flash(w, "cp311", "cu128", "win_amd64", lambda *a: True, lambda t, c, *a: (t, c) in pyg)
        self.assertEqual((got["torch"], got["cuda"], got["flash"]), ("2.8", "cu128", "2.8.3"))

    def test_falls_back_to_the_nearest_cuda(self):
        w = I.flash_wheels(PAGE, "win_amd64")
        got = I.pick_flash(w, "cp311", "cu126", "win_amd64", lambda t, c, *a: c != "cu126", lambda *a: True)
        self.assertEqual(got["cuda"], "cu124")                 # older before newer at the same distance
        self.assertIsNone(I.pick_flash(w, "cp313", "cu128", "win_amd64", lambda *a: True, lambda *a: True))

    def test_spconv_build_for_the_cuda(self):
        self.assertEqual([I.spconv_package(c) for c in ("cu118", "cu121", "cu124", "cu126", "cu128")],
                         ["spconv-cu118", "spconv-cu121", "spconv-cu124", "spconv-cu126", "spconv-cu126"])

    def test_index_page_patterns(self):
        torch_page = '<a href="/whl/cu128/torch-2.8.0%2Bcu128-cp311-cp311-win_amd64.whl#sha256=0">torch-2.8.0+cu128-cp311-cp311-win_amd64.whl</a>'
        pyg_page = ('<a href="https://data.pyg.org/whl/torch-2.8.0%2Bcu128/torch_scatter-2.1.2%2Bpt28cu128-cp311-cp311-win_amd64.whl">'
                    'torch_scatter-2.1.2+pt28cu128-cp311-cp311-win_amd64.whl</a>'
                    '<a href="x">torch_cluster-1.6.3+pt28cu128-cp311-cp311-win_amd64.whl</a>')
        old = I.fetch
        try:
            I.fetch = lambda url, timeout=60: torch_page if "pytorch" in url else pyg_page
            self.assertTrue(I.torch_available("2.8", "cu128", "cp311", "win_amd64"))
            self.assertFalse(I.torch_available("2.9", "cu128", "cp311", "win_amd64"))
            self.assertTrue(I.pyg_available("2.8", "cu128", "cp311", "win_amd64"))
            self.assertFalse(I.pyg_available("2.8", "cu128", "cp312", "win_amd64"))
        finally:
            I.fetch = old


if __name__ == "__main__":
    unittest.main()


try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


@unittest.skipIf(yaml is None, "needs PyYAML")
class UnirigConfigTests(unittest.TestCase):
    """scripts/rig/unirig_run.py's copies of UniRig's task files for MPS / the CPU."""

    def setUp(self):
        import tempfile
        import unirig_run
        self.U = unirig_run
        self.repo = tempfile.mkdtemp()
        files = {
            "configs/task/skel.yaml": {"components": {"model": "ar", "transform": "tf"},
                                       "trainer": {"accelerator": "gpu", "precision": "bf16-mixed", "devices": 1}},
            "configs/model/ar.yaml": {"llm": {"pretrained_model_name_or_path": "facebook/opt-350m",
                                              "_attn_implementation": "flash_attention_2"}},
            "configs/transform/tf.yaml": {"predict": {"vertex_group": [{"voxel_skin": {"backend": "pyrender"}}]}},
        }
        for rel, cfg in files.items():
            os.makedirs(os.path.join(self.repo, os.path.dirname(rel)), exist_ok=True)
            with open(os.path.join(self.repo, rel), "w") as fh:
                yaml.safe_dump(cfg, fh)

    def load(self, rel):
        with open(os.path.join(self.repo, rel)) as fh:
            return yaml.safe_load(fh)

    def test_cuda_keeps_the_shipped_task(self):
        self.assertEqual(self.U.task_for(self.repo, "configs/task/skel.yaml", "cuda"), "configs/task/skel.yaml")

    def test_mps_copy_runs_full_precision_without_flash_attention(self):
        out = self.U.task_for(self.repo, "configs/task/skel.yaml", "mps")
        task = self.load(out)
        self.assertEqual(task["trainer"]["accelerator"], "mps")
        self.assertEqual(task["trainer"]["precision"], "32-true")
        model = self.load(f"configs/model/{task['components']['model']}.yaml")
        self.assertEqual(model["llm"]["_attn_implementation"], "sdpa")
        self.assertEqual(task["components"]["transform"], "tf")          # voxelizer as shipped
        self.assertEqual(self.load("configs/model/ar.yaml")["llm"]["_attn_implementation"], "flash_attention_2")

    def test_open3d_voxels(self):
        task = self.load(self.U.task_for(self.repo, "configs/task/skel.yaml", "cpu", "open3d"))
        tf = self.load(f"configs/transform/{task['components']['transform']}.yaml")
        self.assertEqual(tf["predict"]["vertex_group"][0]["voxel_skin"]["backend"], "open3d")
        task = self.load(self.U.task_for(self.repo, "configs/task/skel.yaml", "cuda", "open3d"))
        self.assertEqual(task["trainer"]["accelerator"], "gpu")
        self.assertNotEqual(task["components"]["transform"], "tf")


class FindPythonTests(unittest.TestCase):
    def test_the_given_one_when_it_is_the_version(self):
        v = sys.version_info
        self.assertEqual(os.path.realpath(I.find_python((v[0], v[1]), sys.executable)), os.path.realpath(sys.executable))

    def test_none_when_there_is_no_such_python(self):
        old = I.shutil.which
        try:
            I.shutil.which = lambda name: None                    # and no uv to install one
            self.assertIsNone(I.find_python((2, 1), sys.executable))
        finally:
            I.shutil.which = old

    def test_a_venv_of_another_python_is_made_again(self):
        import tempfile
        folder = os.path.join(tempfile.mkdtemp(), "venv")
        calls = []
        old_run, old_ver = I.run, I.version_of
        try:
            os.makedirs(os.path.dirname(I.venv_python(folder)))
            open(I.venv_python(folder), "w").close()
            I.version_of = lambda cmd: (3, 13, "x") if cmd[0] == I.venv_python(folder) else (3, 11, "y")
            I.run = lambda cmd, cwd=None: calls.append(cmd)
            I.make_venv(folder, "/py311")
        finally:
            I.run, I.version_of = old_run, old_ver
        self.assertEqual(calls[0], ["/py311", "-m", "venv", folder])


class MainTests(unittest.TestCase):
    def test_triton_windows_follows_torch(self):
        self.assertEqual(I.triton_windows_spec("2.6.0"), "triton-windows<3.3")
        self.assertEqual(I.triton_windows_spec("2.8.1"), "triton-windows<3.5")
        self.assertEqual(I.triton_windows_spec("weird"), "triton-windows")

    def test_a_tool_that_installed_stays_set_up_when_the_next_one_fails(self):
        import json
        import subprocess
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "rig_tools.json")

            def kimodo(*_a):
                raise subprocess.CalledProcessError(1, "pip")
            with mock.patch.dict(os.environ, {"IMAGE_VIEWER_RIG_TOOLS": cfg}), \
                 mock.patch.object(I, "install_unirig", lambda *a: {"python": "u", "repo": "r"}), \
                 mock.patch.object(I, "install_kimodo", kimodo), \
                 mock.patch.object(sys, "argv", ["x", "--root", tmp, "--cuda", "cpu"]):
                with self.assertRaises(subprocess.CalledProcessError):
                    I.main()
            with open(cfg) as fh:
                self.assertEqual(json.load(fh), {"unirig": {"python": "u", "repo": "r"}})
