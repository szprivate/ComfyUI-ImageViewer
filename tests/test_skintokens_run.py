"""scripts/rig/skintokens_run.py's checkpoint loading: weights-only kept on, the classes a checkpoint's
settings name read as plain data by an inert class (nothing of theirs runs), and the settings handed back
as the plain dicts SkinTokens reads. Also the flash_attn_func stand-in SkinTokens calls without CUDA.

Needs torch; skipped without it. Run: python -m unittest tests.test_skintokens_run
"""
import os
import pickle
import sys
import tempfile
import textwrap
import unittest

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None

HERE = os.path.dirname(os.path.abspath(__file__))
RIG = os.path.join(HERE, "..", "scripts", "rig")
sys.path.insert(0, RIG)
import skintokens_run as R  # noqa: E402

# A module the checkpoint's classes come from: written for the test, so the "foreign" classes are real
# ones, and one of them would run a command if it were ever unpickled the ordinary way.
FOREIGN = """
import subprocess
class AttributeDict(dict):
    pass
class AnyNode:
    def __init__(self, v): self._val = v
class DictConfig:
    def __init__(self, d): self._content = {k: AnyNode(v) for k, v in d.items()}; self._metadata = {'ref_type': 'x'}
class Evil:
    def __init__(self, path): self.path = path
    def __reduce__(self):
        return (subprocess.call, (['python', '-c', 'open(%r, "w").write("ran")' % self.path],))
"""


@unittest.skipIf(torch is None, "needs torch")
class SafeLoadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        with open(os.path.join(self.tmp, "foreign_ckpt_mod.py"), "w") as fh:
            fh.write(textwrap.dedent(FOREIGN))
        sys.path.insert(0, self.tmp)
        import foreign_ckpt_mod as F
        self.F = F
        self.marker = os.path.join(self.tmp, "ran.txt")
        hp = F.AttributeDict(model_config={"llm": {"hidden_size": 8}},
                             transform_config=F.DictConfig({"predict_transform": {"n": 1}}),
                             tokenizer_config={"t": [1, 2]}, evil=F.Evil(self.marker))
        self.ckpt = os.path.join(self.tmp, "x.ckpt")
        torch.save({"state_dict": {"w": torch.arange(3.0)}, "hyper_parameters": hp}, self.ckpt)
        self.real = torch.load

    def tearDown(self):
        torch.load = self.real
        sys.path.remove(self.tmp)
        sys.modules.pop("foreign_ckpt_mod", None)

    def test_loads_the_weights_and_plain_settings_without_running_anything(self):
        R.safe_torch_load(torch)
        R.settings_plain(torch)
        ck = torch.load(self.ckpt, map_location="cpu", weights_only=False)   # as SkinTokens asks
        self.assertTrue(torch.equal(ck["state_dict"]["w"], torch.arange(3.0)))
        hp = ck["hyper_parameters"]
        self.assertEqual(type(hp), dict)
        self.assertEqual(hp["model_config"], {"llm": {"hidden_size": 8}})
        self.assertEqual(hp["transform_config"], {"predict_transform": {"n": 1}})
        self.assertEqual(hp["tokenizer_config"], {"t": [1, 2]})
        self.assertFalse(os.path.exists(self.marker), "the checkpoint's code ran")
        self.assertIn("foreign_ckpt_mod.AttributeDict", torch.load.stubbed)
        self.assertNotIn("foreign_ckpt_mod.AttributeDict", [type(v).__module__ for v in hp.values()])

    def test_the_ordinary_loader_would_have_run_it(self):
        # The point of the above: without weights-only, loading this file runs its command.
        with open(self.ckpt, "rb") as fh:
            torch.load(fh, map_location="cpu", weights_only=False)
        self.assertTrue(os.path.exists(self.marker))

    def test_a_blocked_module_still_refuses(self):
        class Boom:
            def __reduce__(self):
                return (os.system, ("echo no",))
        bad = os.path.join(self.tmp, "bad.ckpt")
        torch.save({"x": Boom()}, bad)
        R.safe_torch_load(torch)
        with self.assertRaises(pickle.UnpicklingError):
            torch.load(bad)


class HelperTests(unittest.TestCase):
    def test_refused_global_names(self):
        self.assertEqual(R.refused_global("Unsupported global: GLOBAL lightning.fabric.AttributeDict was not"),
                         "lightning.fabric.AttributeDict")
        self.assertEqual(R.refused_global("Unsupported global: GLOBAL getattr was not"), "builtins.getattr")
        self.assertIsNone(R.refused_global("Trying to load unsupported GLOBAL os.system whose module os is blocked."))
        self.assertIsNone(R.refused_global("something else"))

    def test_plain(self):
        self.assertEqual(R.plain({"a": [1, (2, {"b": 3})]}), {"a": [1, (2, {"b": 3})]})
        self.assertEqual(R.plain({"__args__": ["x"]}), "x")


@unittest.skipIf(torch is None, "needs torch")
class FlashAttnFuncShim(unittest.TestCase):
    def shim(self):
        sys.path.insert(0, os.path.abspath(os.path.join(RIG, "shims")))
        saved = {k: sys.modules.pop(k) for k in list(sys.modules) if k == "flash_attn" or k.startswith("flash_attn.")}
        try:
            from flash_attn.flash_attn_interface import flash_attn_func
            import flash_attn
            self.assertIs(flash_attn.flash_attn_func, flash_attn_func)
            return flash_attn_func
        finally:
            sys.path.pop(0)
            for k in [k for k in sys.modules if k == "flash_attn" or k.startswith("flash_attn.")]:
                del sys.modules[k]
            sys.modules.update(saved)

    def reference(self, q, k, v, causal=False):
        """Attention written out: softmax(q k^T / sqrt(d)) v per batch and head, (B, S, H, D)."""
        B, Sq, H, D = q.shape
        Hk = k.shape[2]
        out = torch.empty(B, Sq, H, D)
        for b in range(B):
            for h in range(H):
                kh = h // (H // Hk)
                s = q[b, :, h] @ k[b, :, kh].T / D ** 0.5
                if causal:
                    Sk = k.shape[1]
                    keep = torch.ones(Sq, Sk, dtype=torch.bool).tril(diagonal=Sk - Sq)
                    s = s.masked_fill(~keep, float("-inf"))
                out[b, :, h] = s.softmax(-1) @ v[b, :, kh]
        return out

    def test_matches_attention_written_out(self):
        f = self.shim()
        torch.manual_seed(0)
        q, k, v = torch.randn(2, 5, 4, 8), torch.randn(2, 7, 2, 8), torch.randn(2, 7, 2, 8)
        self.assertTrue(torch.allclose(f(q, k, v), self.reference(q, k, v), atol=1e-5))
        self.assertTrue(torch.allclose(f(q, k, v, causal=True), self.reference(q, k, v, causal=True), atol=1e-5))
        qb = q.to(torch.bfloat16)
        out = f(qb, k.to(torch.bfloat16), v.to(torch.bfloat16))
        self.assertEqual(out.dtype, torch.bfloat16)
        self.assertEqual(out.shape, (2, 5, 4, 8))


if __name__ == "__main__":
    unittest.main()
