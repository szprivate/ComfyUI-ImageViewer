# Pure-PyTorch stand-ins for UniRig's (and SkinTokens') CUDA-only libraries

Used where `flash_attn`, `spconv`, `torch_scatter` and `torch_cluster` have no builds (macOS, or a machine
without CUDA). `install_rig_tools.py` puts this folder on UniRig's environment through a `.pth` file, which
Python reads after site-packages, so a real installed library always wins over the stand-in.

Only what UniRig and SkinTokens call is here:

* `flash_attn.modules.mha.MHA` (cross attention: `Wq`, `Wkv`, `out_proj`, the same parameter names, so the
  checkpoint loads) and `flash_attn.flash_attn_varlen_qkvpacked_func`, on `torch.nn.functional.scaled_dot_product_attention`;
* `flash_attn.flash_attn_interface.flash_attn_func` (SkinTokens: batched q / k / v, grouped heads, causal), the same way;
* `spconv.pytorch.SparseConvTensor` and `SubMConv3d` (submanifold sparse convolution, spconv 2's weight layout
  `[out, kD, kH, kW, in]`), found by hashing the voxel coordinates;
* `torch_scatter.segment_csr` on `torch.segment_reduce`;
* `torch_cluster.fps` (farthest point sampling).

Written for the viewer from the libraries' documented behaviour; no code is taken from them.
