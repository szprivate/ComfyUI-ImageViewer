"""flash_attn.modules.mha.MHA stand-in: self or cross attention with flash_attn's parameter names."""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class MHA(nn.Module):
    def __init__(self, embed_dim, num_heads, num_heads_kv=None, cross_attn=False, qkv_proj_bias=True,
                 out_proj_bias=True, dropout=0.0, softmax_scale=None, causal=False, device=None, dtype=None, **_):
        super().__init__()
        self.embed_dim = embed_dim
        self.num_heads = num_heads
        self.num_heads_kv = num_heads_kv or num_heads
        self.cross_attn = cross_attn
        self.head_dim = embed_dim // num_heads
        self.causal = causal
        self.dropout = dropout
        self.softmax_scale = softmax_scale
        kv_dim = 2 * self.head_dim * self.num_heads_kv
        kw = {"device": device, "dtype": dtype}
        if cross_attn:
            self.Wq = nn.Linear(embed_dim, embed_dim, bias=qkv_proj_bias, **kw)
            self.Wkv = nn.Linear(embed_dim, kv_dim, bias=qkv_proj_bias, **kw)
        else:
            self.Wqkv = nn.Linear(embed_dim, embed_dim + kv_dim, bias=qkv_proj_bias, **kw)
        self.out_proj = nn.Linear(embed_dim, embed_dim, bias=out_proj_bias, **kw)

    def forward(self, x, x_kv=None, **_):
        h, d, hk = self.num_heads, self.head_dim, self.num_heads_kv
        if self.cross_attn:
            q = self.Wq(x)
            kv = self.Wkv(x if x_kv is None else x_kv)
        else:
            qkv = self.Wqkv(x)
            q, kv = qkv[..., : h * d], qkv[..., h * d:]
        b, s = q.shape[0], q.shape[1]
        q = q.view(b, s, h, d).transpose(1, 2)
        kv = kv.view(b, kv.shape[1], 2, hk, d)
        k, v = kv[:, :, 0].transpose(1, 2), kv[:, :, 1].transpose(1, 2)
        if hk != h:
            k = k.repeat_interleave(h // hk, dim=1)
            v = v.repeat_interleave(h // hk, dim=1)
        scale = self.softmax_scale if self.softmax_scale is not None else 1.0 / math.sqrt(d)
        out = F.scaled_dot_product_attention(q, k, v, dropout_p=self.dropout if self.training else 0.0,
                                             is_causal=self.causal and not self.cross_attn, scale=scale)
        return self.out_proj(out.transpose(1, 2).reshape(b, s, h * d))
