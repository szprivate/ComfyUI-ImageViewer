"""spconv.pytorch.modules stand-in."""
import torch.nn as nn


class SparseModule(nn.Module):
    """What spconv's own layers are; PointSequential asks with is_spconv_module."""


def is_spconv_module(module):
    return isinstance(module, SparseModule)
