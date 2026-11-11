"""torch_scatter stand-in: segment_csr on torch.segment_reduce."""
import torch

__version__ = "0.0.0+viewer-shim"


def segment_csr(src, indptr, out=None, reduce="sum"):
    reduce = {"add": "sum"}.get(reduce, reduce)
    if indptr.dim() != 1:
        raise NotImplementedError("segment_csr stand-in: 1-D indptr only")
    lengths = (indptr[1:] - indptr[:-1]).to(torch.long)
    data = src
    if data.device.type == "mps":   # segment_reduce has no MPS kernel
        res = torch.segment_reduce(data.cpu(), reduce, lengths=lengths.cpu(), axis=0, unsafe=True).to(data.device)
    else:
        res = torch.segment_reduce(data, reduce, lengths=lengths, axis=0, unsafe=True)
    if out is not None:
        out.copy_(res)
        return out
    return res
