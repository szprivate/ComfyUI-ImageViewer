"""The pure-PyTorch stand-ins UniRig uses without CUDA (scripts/rig/shims), against the definitions.

spconv's submanifold convolution was also checked against spconv 2.3.8 itself (CPU): the same
convention (out[p] = sum_o W[o] @ in[p + o], weights [out, kD, kH, kW, in]); spconv's CPU kernel got
a handful of voxels wrong where the stand-in matched the definition.

Needs torch; skipped without it. Run: python -m unittest tests.test_rig_shims
"""
import itertools
import math
import os
import sys
import unittest

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None

SHIMS = os.path.join(os.path.dirname(__file__), "..", "scripts", "rig", "shims")


def _shim(name, *subs):
    """Import the stand-in (and its `subs` modules) even where the real library is installed."""
    saved = {k: sys.modules.pop(k) for k in list(sys.modules) if k == name or k.startswith(name + ".")}
    sys.path.insert(0, os.path.abspath(SHIMS))
    try:
        import importlib
        mod = importlib.import_module(name)
        for m in subs:
            importlib.import_module(m)
        sub = {k: sys.modules[k] for k in list(sys.modules) if k == name or k.startswith(name + ".")}
    finally:
        sys.path.pop(0)
        for k in list(sys.modules):
            if k == name or k.startswith(name + "."):
                del sys.modules[k]
        sys.modules.update(saved)
    return mod, sub


@unittest.skipIf(torch is None, "needs torch")
class ShimTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(0)

    def test_submanifold_conv_is_the_definition(self):
        _, sub = _shim("spconv", "spconv.pytorch")
        sp = sub["spconv.pytorch"]
        coords = torch.randint(0, 12, (600, 4))
        coords[:, 0] %= 2
        coords = torch.unique(coords, dim=0).int()
        feat = torch.randn(coords.shape[0], 5)
        for ks in (3, 5):
            conv = sp.SubMConv3d(5, 7, kernel_size=ks, bias=True, indice_key=f"k{ks}")
            x = sp.SparseConvTensor(feat, coords, [16, 16, 16], 2)
            out = conv(x)
            self.assertTrue(sub["spconv.pytorch.modules"].is_spconv_module(conv))
            self.assertIs(out.indices, coords)
            got = out.features
            w = conv.weight.detach()
            key = {tuple(c): i for i, c in enumerate(coords.tolist())}
            h = ks // 2
            for i in range(0, coords.shape[0], 37):
                c = coords[i].tolist()
                want = conv.bias.detach().clone()
                for a, b, d in itertools.product(range(ks), repeat=3):
                    j = key.get((c[0], c[1] + a - h, c[2] + b - h, c[3] + d - h))
                    if j is not None:
                        want += w[:, a, b, d, :] @ feat[j]
                self.assertLess((got[i] - want).abs().max().item(), 1e-4)
            # Layers sharing a key share the neighbour search.
            self.assertIn((f"k{ks}", (ks, ks, ks)), x.indice_dict)

    def test_varlen_attention_attends_within_each_sequence(self):
        fa, _ = _shim("flash_attn")
        lens = [5, 1, 9, 3]
        cu = torch.tensor([0] + list(itertools.accumulate(lens)), dtype=torch.int32)
        qkv = torch.randn(sum(lens), 3, 2, 4)
        out = fa.flash_attn_varlen_qkvpacked_func(qkv, cu, max_seqlen=9, softmax_scale=0.3)
        self.assertEqual(tuple(out.shape), (sum(lens), 2, 4))
        for s, e in zip(cu[:-1].tolist(), cu[1:].tolist()):
            q, k, v = qkv[s:e, 0], qkv[s:e, 1], qkv[s:e, 2]            # (L, H, D)
            att = torch.softmax(torch.einsum("qhd,khd->hqk", q, k) * 0.3, -1)
            want = torch.einsum("hqk,khd->qhd", att, v)
            self.assertLess((out[s:e] - want).abs().max().item(), 1e-5)

    def test_cross_attention_has_flash_attns_parameters(self):
        _, sub = _shim("flash_attn", "flash_attn.modules.mha")
        mha = sub["flash_attn.modules.mha"].MHA(embed_dim=8, num_heads=2, cross_attn=True)
        self.assertEqual(sorted(k for k in mha.state_dict()),
                         ["Wkv.bias", "Wkv.weight", "Wq.bias", "Wq.weight", "out_proj.bias", "out_proj.weight"])
        q, kv = torch.randn(2, 3, 8), torch.randn(2, 6, 8)
        out = mha(q, x_kv=kv)
        Q = mha.Wq(q).view(2, 3, 2, 4)
        KV = mha.Wkv(kv).view(2, 6, 2, 2, 4)                                 # (two, heads, dim)
        att = torch.softmax(torch.einsum("bqhd,bkhd->bhqk", Q, KV[:, :, 0]) / math.sqrt(4), -1)
        want = mha.out_proj(torch.einsum("bhqk,bkhd->bqhd", att, KV[:, :, 1]).reshape(2, 3, 8))
        self.assertLess((out - want).abs().max().item(), 1e-5)

    def test_segment_csr(self):
        ts, _ = _shim("torch_scatter")
        src = torch.randn(10, 3)
        ptr = torch.tensor([0, 4, 4, 7, 10])
        for red, fn in (("min", lambda t: t.min(0).values), ("max", lambda t: t.max(0).values),
                        ("sum", lambda t: t.sum(0)), ("mean", lambda t: t.mean(0))):
            got = ts.segment_csr(src, ptr, reduce=red)
            for i, (s, e) in enumerate(zip(ptr[:-1].tolist(), ptr[1:].tolist())):
                if e > s:
                    self.assertLess((got[i] - fn(src[s:e])).abs().max().item(), 1e-6, red)

    def test_farthest_point_sampling(self):
        tc, _ = _shim("torch_cluster")
        pos = torch.cat([torch.randn(40, 3), torch.randn(40, 3) + 10])
        batch = torch.cat([torch.zeros(40, dtype=torch.long), torch.ones(40, dtype=torch.long)])
        idx = tc.fps(pos, batch, ratio=0.25, random_start=False)
        self.assertEqual(idx.numel(), 20)
        self.assertEqual(int(idx[0]), 0)
        self.assertTrue(((idx[:10] < 40).all() and (idx[10:] >= 40).all()).item())
        far = int(torch.argmax(((pos[:40] - pos[0]) ** 2).sum(-1)))
        self.assertEqual(int(idx[1]), far)
        self.assertEqual(len(set(idx.tolist())), 20)


if __name__ == "__main__":
    unittest.main()
