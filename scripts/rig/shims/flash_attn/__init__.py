"""flash_attn stand-in: the two calls UniRig makes and the one SkinTokens makes (flash_attn_func, in
flash_attn_interface), on PyTorch's scaled_dot_product_attention."""
import torch
import torch.nn.functional as F

__version__ = "0.0.0+viewer-shim"

from .flash_attn_interface import flash_attn_func  # noqa: E402,F401


def flash_attn_varlen_qkvpacked_func(qkv, cu_seqlens, max_seqlen, dropout_p=0.0, softmax_scale=None, causal=False, **_):
    """qkv (total, 3, H, D), sequences packed back to back at cu_seqlens; answers (total, H, D)."""
    dtype = qkv.dtype
    work = torch.float32 if qkv.device.type == "cpu" or dtype == torch.float16 and qkv.device.type == "mps" else dtype
    qkv = qkv.to(work)
    total, _, h, d = qkv.shape
    cu = cu_seqlens.to(torch.long)
    lens = cu[1:] - cu[:-1]
    b = lens.numel()
    m = int(max_seqlen) if max_seqlen else int(lens.max())
    m = max(m, int(lens.max()))
    seq = torch.repeat_interleave(torch.arange(b, device=qkv.device), lens)
    pos = torch.arange(total, device=qkv.device) - cu[:-1][seq]
    packed = qkv.new_zeros(b, m, 3, h, d)
    packed[seq, pos] = qkv
    valid = torch.zeros(b, m, dtype=torch.bool, device=qkv.device)
    valid[seq, pos] = True
    q, k, v = packed.permute(2, 0, 3, 1, 4).unbind(0)          # (B, H, M, D)
    mask = valid[:, None, None, :]
    out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=dropout_p, scale=softmax_scale,
                                         is_causal=False)
    out = out.permute(0, 2, 1, 3)[seq, pos]                     # (total, H, D)
    return out.to(dtype)
