"""torch_cluster stand-in: farthest point sampling."""
import math

import torch

__version__ = "0.0.0+viewer-shim"


def _fps_one(pos, k, random_start):
    n = pos.shape[0]
    out = torch.empty(k, dtype=torch.long, device=pos.device)
    first = int(torch.randint(n, (1,))) if random_start else 0
    dist = torch.full((n,), float("inf"), device=pos.device, dtype=pos.dtype)
    cur = first
    for i in range(k):
        out[i] = cur
        d = ((pos - pos[cur]) ** 2).sum(-1)
        dist = torch.minimum(dist, d)
        cur = int(torch.argmax(dist))
    return out


def fps(src, batch=None, ratio=0.5, random_start=True, batch_size=None, ptr=None):
    """Indices of a farthest-point subset of each batch's points (ratio of them, at least one)."""
    if isinstance(ratio, torch.Tensor):
        ratio = float(ratio.flatten()[0])
    pos = src.detach().float()
    if pos.device.type == "mps":
        pos = pos.cpu()
    if batch is None:
        starts = [0]
        ends = [pos.shape[0]]
    else:
        b = batch.to(pos.device)
        counts = torch.bincount(b)
        ends = torch.cumsum(counts, 0).tolist()
        starts = [0] + ends[:-1]
    picked = []
    for s, e in zip(starts, ends):
        n = e - s
        if n <= 0:
            continue
        k = max(1, int(math.ceil(n * ratio)))
        picked.append(_fps_one(pos[s:e], k, random_start) + s)
    return torch.cat(picked).to(src.device)
