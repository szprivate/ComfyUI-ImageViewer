"""spconv.pytorch stand-in: SparseConvTensor and submanifold 3D convolution in plain PyTorch.

A submanifold convolution answers at exactly the input's active voxels: out[p] = bias + sum over the
kernel's offsets o of W[o] @ in[p + o], where in[p + o] counts only when that voxel is active. The
neighbour of every voxel at every offset is found by sorting linearized (batch, x, y, z) keys and
searchsorted; the result is kept on the tensor under the layer's indice_key, as spconv does, so layers
sharing a key share the work.
"""
import torch
import torch.nn as nn

from . import modules  # noqa: F401
from .modules import SparseModule

__version__ = "0.0.0+viewer-shim"


class SparseConvTensor:
    def __init__(self, features, indices, spatial_shape, batch_size, indice_dict=None, **_):
        self.features = features
        self.indices = indices
        self.spatial_shape = [int(s) for s in spatial_shape]
        self.batch_size = int(batch_size)
        self.indice_dict = {} if indice_dict is None else indice_dict

    def replace_feature(self, feature):
        return SparseConvTensor(feature, self.indices, self.spatial_shape, self.batch_size, self.indice_dict)

    @property
    def shape(self):
        return [self.batch_size, *self.spatial_shape, self.features.shape[1]]

    def dense(self, channels_first=True):
        c = self.features.shape[1]
        out = self.features.new_zeros(self.batch_size, *self.spatial_shape, c)
        idx = self.indices.long()
        out[idx[:, 0], idx[:, 1], idx[:, 2], idx[:, 3]] = self.features
        return out.permute(0, 4, 1, 2, 3).contiguous() if channels_first else out


_PAD = 8  # room for a neighbour up to 8 voxels off the edge (kernels up to 17 wide)


def _keys(idx, shape):
    """One int64 per voxel: (batch, x, y, z), with room around the grid so neighbours off its edge never alias."""
    i = idx.long()
    d1, d2, d3 = (int(s) + 2 * _PAD for s in shape)
    return ((i[:, 0] * d1 + (i[:, 1] + _PAD)) * d2 + (i[:, 2] + _PAD)) * d3 + (i[:, 3] + _PAD)


def neighbours(x, kernel_size, key=None):
    """(K, N) indices into x's voxels, -1 where the neighbour at that kernel offset is not active."""
    cache = (key, tuple(kernel_size))
    if key is not None and cache in x.indice_dict:
        return x.indice_dict[cache]
    idx = x.indices.long()
    keys = _keys(idx, x.spatial_shape)
    order = torch.argsort(keys)
    sorted_keys = keys[order]
    ks = kernel_size
    rng = [torch.arange(k, device=idx.device) - k // 2 for k in ks]
    offs = torch.stack(torch.meshgrid(*rng, indexing="ij"), -1).reshape(-1, 3)   # kernel order (d, h, w)
    out = torch.full((offs.shape[0], idx.shape[0]), -1, dtype=torch.long, device=idx.device)
    for k, o in enumerate(offs):
        nb = idx.clone()
        nb[:, 1:] += o
        nk = _keys(nb, x.spatial_shape)
        pos = torch.searchsorted(sorted_keys, nk).clamp(max=sorted_keys.numel() - 1)
        hit = sorted_keys[pos] == nk
        out[k] = torch.where(hit, order[pos], torch.full_like(pos, -1))
    if key is not None:
        x.indice_dict[cache] = out
    return out


class SubMConv3d(SparseModule):
    def __init__(self, in_channels, out_channels, kernel_size=3, stride=1, padding=0, dilation=1, groups=1,
                 bias=True, indice_key=None, algo=None, **_):
        super().__init__()
        ks = (kernel_size,) * 3 if isinstance(kernel_size, int) else tuple(kernel_size)
        self.in_channels, self.out_channels, self.kernel_size = in_channels, out_channels, ks
        self.indice_key = indice_key
        self.weight = nn.Parameter(torch.empty(out_channels, *ks, in_channels))
        self.bias = nn.Parameter(torch.zeros(out_channels)) if bias else None
        nn.init.kaiming_uniform_(self.weight.view(out_channels, -1), a=5 ** 0.5)

    def forward(self, x):
        nb = neighbours(x, self.kernel_size, self.indice_key)
        f = x.features
        w = self.weight.reshape(self.out_channels, -1, self.in_channels).to(f.dtype)    # (O, K, I)
        out = f.new_zeros(f.shape[0], self.out_channels)
        padded = torch.cat([f, f.new_zeros(1, f.shape[1])], 0)                           # row -1 = zeros
        for k in range(nb.shape[0]):
            col = nb[k]
            if bool((col < 0).all()):
                continue
            out = out + padded[col] @ w[:, k].t()
        if self.bias is not None:
            out = out + self.bias.to(out.dtype)
        return x.replace_feature(out)


class SparseSequential(SparseModule, nn.Sequential):
    def forward(self, x):
        for m in self:
            if isinstance(m, SparseModule):
                x = m(x)
            elif isinstance(x, SparseConvTensor):
                x = x.replace_feature(m(x.features))
            else:
                x = m(x)
        return x
