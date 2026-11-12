"""flash_attn.flash_attn_interface stand-in: flash_attn_func, the call SkinTokens makes, on PyTorch's
scaled_dot_product_attention. Written from flash-attention 2's documented signature; no code from it."""
import torch
import torch.nn.functional as F


def flash_attn_func(q, k, v, dropout_p=0.0, softmax_scale=None, causal=False, **_):
    """q (B, Sq, H, D), k / v (B, Sk, Hk, D) with H a multiple of Hk (grouped heads); answers (B, Sq, H, D)."""
    dtype = q.dtype
    work = torch.float32 if q.device.type == "cpu" else dtype
    q, k, v = (t.to(work).transpose(1, 2) for t in (q, k, v))        # (B, H, S, D)
    if k.shape[1] != q.shape[1]:
        rep = q.shape[1] // k.shape[1]
        k = k.repeat_interleave(rep, dim=1)
        v = v.repeat_interleave(rep, dim=1)
    if causal and q.shape[2] != k.shape[2]:
        # flash-attention 2 aligns the causal mask to the bottom right when the lengths differ.
        sq, sk = q.shape[2], k.shape[2]
        mask = torch.ones(sq, sk, dtype=torch.bool, device=q.device).tril(diagonal=sk - sq)
        out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=dropout_p, scale=softmax_scale)
    else:
        out = F.scaled_dot_product_attention(q, k, v, dropout_p=dropout_p, scale=softmax_scale, is_causal=causal)
    return out.transpose(1, 2).to(dtype)
