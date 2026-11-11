"""scripts/rig/unirig_launch.py: UniRig's checkpoints load with PyTorch's weights-only loader still on.

Needs torch (2.6+) and python-box, as UniRig's venv has them; skipped without.
Run: python -m unittest tests.test_unirig_launch
"""
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LAUNCH = os.path.join(ROOT, "scripts", "rig", "unirig_launch.py")

try:
    import torch
    import box
except ImportError:  # pragma: no cover
    torch = box = None


@unittest.skipIf(torch is None or not hasattr(torch.serialization, "add_safe_globals"), "needs torch 2.6+ and python-box")
class LaunchTests(unittest.TestCase):
    def test_a_checkpoint_with_box_settings_loads_weights_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            ck = os.path.join(tmp, "model.ckpt")
            torch.save({"state_dict": {"w": torch.ones(3)},
                        "hyper_parameters": box.Box(lr=0.1, layers=box.BoxList([1, 2]), sub=box.Box(a=1))}, ck)
            with open(os.path.join(tmp, "run.py"), "w") as fh:
                fh.write("import sys, torch\n"
                         "ck = torch.load(sys.argv[1])\n"           # weights_only by default in 2.6+
                         "hp = ck['hyper_parameters']\n"
                         "print(float(ck['state_dict']['w'].sum()), hp['lr'], list(hp['layers']), hp['sub']['a'], sys.argv[2])\n")
            plain = subprocess.run([sys.executable, "run.py", ck, "x"], cwd=tmp, capture_output=True, text=True)
            out = subprocess.run([sys.executable, LAUNCH, "run.py", ck, "--flag=1"], cwd=tmp, capture_output=True, text=True)
            # Something that would run code is still refused.
            with open(os.path.join(tmp, "evil.ckpt"), "wb") as fh:
                import pickle
                class Evil:
                    def __reduce__(self):
                        return (os.system, ("echo pwned",))
                torch.save({"x": Evil()}, fh)
            evil = subprocess.run([sys.executable, LAUNCH, "run.py", os.path.join(tmp, "evil.ckpt"), "y"], cwd=tmp,
                                  capture_output=True, text=True)
        if plain.returncode == 0:
            self.skipTest("this PyTorch loads the checkpoint without help")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.split(), ["3.0", "0.1", "[1,", "2]", "1", "--flag=1"])
        self.assertNotEqual(evil.returncode, 0)
        self.assertNotIn("pwned", evil.stdout)


if __name__ == "__main__":
    unittest.main()
