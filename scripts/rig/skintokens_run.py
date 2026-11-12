"""Rig one model with SkinTokens (TokenRig): skeleton and skin weights in one go, onto the model as a .glb.

Run by the viewer (src/rig_routes.py) with SkinTokens' own Python, in SkinTokens' folder:

    python skintokens_run.py --repo <SkinTokens> --input <model> --output <out.glb> --work <tmp>
                             [--seed 12345] [--use-skeleton] [--postprocess]

SkinTokens (github.com/VAST-AI-Research/SkinTokens, MIT code and weights) is the successor of UniRig from
the same team: one autoregressive model writes the skeleton and the skin weights as one sequence. It is not
part of the viewer and is not imported by it, only run, as UniRig is.

What this does instead of SkinTokens' own demo.py, and why:
  * No server. demo.py starts a helper (bpy_server.py) that listens on port 59876 on EVERY network
    interface and unpickles whatever is posted to it - anyone on the network could run code on this
    machine while it is up. Here Blender's bpy reads and writes the files in this process, on its main
    thread (the loader SkinTokens itself uses when bpy is not shared between threads), so nothing listens.
  * Weights-only checkpoint loading. SkinTokens loads its checkpoint with torch.load(weights_only=False),
    which runs whatever code a checkpoint carries. Here every torch.load is weights-only; the classes the
    checkpoint's saved settings name (PyTorch Lightning's AttributeDict, OmegaConf's containers ...) are
    read as plain dicts by an inert class of this file - nothing of theirs runs - and turned back into
    the plain settings SkinTokens reads from them.
  * The model's own textures and size: always SkinTokens' "transfer" (its --use_transfer), which puts the
    rig onto the file that was given rather than onto its simplified mesh.

Without CUDA (a Mac, or SKINTOKENS_DEVICE=cpu) the transformer is asked for PyTorch's own attention (sdpa)
instead of flash-attention 2, and flash_attn's call comes from the viewer's stand-in (scripts/rig/shims).
SkinTokens itself asks for an NVIDIA GPU with 14 GB; elsewhere it is slow and untested.
"""
import argparse
import collections
import os
import random
import re
import shutil
import sys
import time
import traceback

CKPT = "experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt"
VAE_CKPT = "experiments/skin_vae_2_10_32768/last.ckpt"
LLM_DIR = "models/Qwen3-0.6B"
MIN_VRAM_GB = 14
# What SkinTokens' loader reads; a .vrm is a glTF binary.
READS = {".obj": ".obj", ".fbx": ".fbx", ".glb": ".glb", ".gltf": ".gltf", ".dae": ".dae", ".vrm": ".glb"}
MAX_STUBS = 64


def say(line):
    print(line, flush=True)


def fail(line, code=1):
    say("!! " + line)
    sys.exit(code)


# ── Weights-only loading ──────────────────────────────────────────────────────

class Inert:
    """Stands for any class a checkpoint's settings name. NEWOBJ and REDUCE make a plain OrderedDict of it
    (so SETITEMS and BUILD fill it as data); nothing of the named class is imported or run."""
    name = "?"

    def __new__(cls, *args, **kwargs):
        d = collections.OrderedDict()
        if args:
            d["__args__"] = list(args)
        return d


def inert(name):
    return type("Inert_" + re.sub(r"\W", "_", name), (Inert,), {"name": name})


REFUSED = re.compile(r"GLOBAL ([A-Za-z_][\w.]*)")


def refused_global(message):
    """The global torch's weights-only loader refused, by its full name; None when it refused something else."""
    if "is blocked" in message:
        return None
    m = REFUSED.search(message)
    if not m:
        return None
    name = m.group(1)
    return name if "." in name else "builtins." + name   # torch prints builtins.x as x


def safe_torch_load(torch):
    """torch.load, always weights-only; a global the loader refuses is read as data by an inert class."""
    real = torch.load
    unpickling = getattr(getattr(torch, "serialization", None), "pickle", None)
    errors = (getattr(unpickling, "UnpicklingError", Exception),) if unpickling else (Exception,)
    import pickle
    errors = errors + (pickle.UnpicklingError,)
    stubbed = set()

    def load(f, map_location=None, *args, **kwargs):
        kwargs.pop("weights_only", None)
        kwargs.pop("pickle_module", None)
        for _ in range(MAX_STUBS + 1):
            try:
                if hasattr(f, "seek"):
                    f.seek(0)
                return real(f, map_location, *args, weights_only=True, **kwargs)
            except errors as e:
                name = refused_global(str(e))
                if not name or name in stubbed:
                    raise
                stubbed.add(name)
                torch.serialization.add_safe_globals([(inert(name), name)])
        raise RuntimeError("the checkpoint names too many classes to read it safely")

    load.stubbed = stubbed
    torch.load = load
    return load


def plain(x, depth=0):
    """Settings read through Inert back into plain dicts / lists: OmegaConf's containers keep theirs in
    _content (nodes in _val), Box and AttributeDict are their items already."""
    if depth > 64:
        return x
    if isinstance(x, dict):
        extra = getattr(x, "__dict__", {}) or {}
        if "_content" in extra or "_val" in extra:
            inner = extra.get("_content", extra.get("_val"))
            return plain(inner, depth + 1)
        if "_content" in x or "_val" in x:
            return plain(x.get("_content", x.get("_val")), depth + 1)
        out = {}
        for k, v in x.items():
            if k == "__args__":
                continue
            out[plain(k, depth + 1)] = plain(v, depth + 1)
        if not out and x.get("__args__"):
            args = x["__args__"]
            return plain(args[0], depth + 1) if len(args) == 1 else [plain(a, depth + 1) for a in args]
        return out
    if isinstance(x, list):
        return [plain(v, depth + 1) for v in x]
    if isinstance(x, tuple):
        return tuple(plain(v, depth + 1) for v in x)
    return x


def settings_plain(torch):
    """Wrap the next loads so the settings of a Lightning checkpoint come back plain."""
    load = torch.load

    def wrapped(*args, **kwargs):
        ckpt = load(*args, **kwargs)
        if isinstance(ckpt, dict) and "hyper_parameters" in ckpt:
            ckpt["hyper_parameters"] = plain(ckpt["hyper_parameters"])
        return ckpt

    wrapped.stubbed = load.stubbed
    torch.load = wrapped


# ── The device ───────────────────────────────────────────────────────────────

def device(torch):
    want = os.environ.get("SKINTOKENS_DEVICE", "").strip().lower()
    if want in ("cuda", "mps", "cpu"):
        return want
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


def has_real_flash():
    try:
        import importlib.metadata as md
        md.version("flash_attn")
        return True
    except Exception:
        return False


def sdpa_instead_of_flash():
    """transformers is asked for flash_attention_2 by SkinTokens: PyTorch's own attention, where there is none."""
    from transformers import AutoModelForCausalLM
    real = AutoModelForCausalLM.from_config

    def from_config(*args, **kwargs):
        if kwargs.get("attn_implementation") == "flash_attention_2":
            kwargs["attn_implementation"] = "sdpa"
        return real(*args, **kwargs)

    AutoModelForCausalLM.from_config = from_config


# ── Rigging ──────────────────────────────────────────────────────────────────

def check_repo(repo):
    for rel in (CKPT, VAE_CKPT, os.path.join(LLM_DIR, "config.json")):
        if not os.path.isfile(os.path.join(repo, rel)):
            fail(f"SkinTokens' {rel} is not there: run the viewer's installer again (Rig > Set up...)")


def rig(a):
    repo = os.path.abspath(a.repo)
    check_repo(repo)
    work = os.path.abspath(a.work)
    os.makedirs(work, exist_ok=True)
    ext = os.path.splitext(a.input)[1].lower()
    if ext not in READS:
        fail(f"SkinTokens reads {', '.join(sorted(READS))}, not {ext or 'this file'}")
    model_path = os.path.join(work, "model" + READS[ext])
    shutil.copyfile(a.input, model_path)
    out = os.path.abspath(a.output)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    os.chdir(repo)                       # SkinTokens finds its checkpoints and models/ by relative paths
    sys.path.insert(0, repo)
    os.environ.setdefault("XFORMERS_IGNORE_FLASH_VERSION_CHECK", "1")
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    say("== loading SkinTokens")
    import numpy as np
    import torch
    safe_torch_load(torch)
    settings_plain(torch)
    dev = device(torch)
    say(f"== SkinTokens on {dev}")
    if dev == "cuda":
        try:
            gb = torch.cuda.get_device_properties(0).total_memory / 2 ** 30
            if gb < MIN_VRAM_GB - 0.5:
                say(f"== warning: this GPU has {gb:.0f} GB; SkinTokens asks for {MIN_VRAM_GB} GB "
                    "(UniRig needs about 8)")
        except Exception:
            pass
    if dev != "cuda" or not has_real_flash():
        sdpa_instead_of_flash()

    random.seed(a.seed)
    np.random.seed(a.seed % (2 ** 32))
    torch.manual_seed(a.seed)

    from src.data.dataset import DatasetConfig, RigDatasetModule
    from src.data.transform import Transform
    from src.tokenizer.parse import get_tokenizer
    from src.model.tokenrig import TokenRig
    from src.data.vertex_group import voxel_skin
    from src.rig_package.parser.bpy import BpyParser, transfer_rigging

    t0 = time.time()
    model = TokenRig.load_from_system_checkpoint(checkpoint_path=CKPT).to(dev)
    model.eval()
    if torch.load.stubbed:
        say("== read as plain data: " + ", ".join(sorted(torch.load.stubbed)))
    tokenizer = get_tokenizer(**model.tokenizer_config)
    transform = Transform.parse(**model.transform_config["predict_transform"])
    say(f"== model ready ({time.time() - t0:.0f} s)")

    say("== reading the mesh")
    dataset_config = DatasetConfig.parse(
        shuffle=False, batch_size=1, num_workers=0, pin_memory=False, persistent_workers=False,
        datapath={"data_name": None, "loader": "bpy", "filepaths": {"articulation": [model_path]}},
    ).split_by_cls()
    module = RigDatasetModule(predict_dataset_config=dataset_config, predict_transform=transform,
                              tokenizer=tokenizer, process_fn=model._process_fn)
    loader = module.predict_dataloader()["articulation"]
    batch = next(iter(loader))
    batch = {k: v.to(dev) if isinstance(v, torch.Tensor) else v for k, v in batch.items()}

    skeleton_tokens = None
    if a.use_skeleton:
        if "skeleton_tokens" not in batch or "skeleton_mask" not in batch:
            fail("the model has no skeleton to keep: rig it without 'Keep its skeleton'")
        mask = batch["skeleton_mask"][0] == 1
        skeleton_tokens = [batch["skeleton_tokens"][0][mask].cpu().numpy()]
        say("== keeping the model's skeleton: skin weights only")
    else:
        batch.pop("skeleton_tokens", None)
        batch.pop("skeleton_mask", None)
    batch["generate_kwargs"] = dict(max_length=2048, top_k=a.top_k, top_p=a.top_p, temperature=a.temperature,
                                    repetition_penalty=a.repetition_penalty, num_return_sequences=1,
                                    num_beams=a.num_beams, do_sample=True)

    say("== predicting the skeleton and skin weights")
    t0 = time.time()
    with torch.no_grad():
        preds = model.predict_step(batch, skeleton_tokens=skeleton_tokens, make_asset=True)["results"]
    asset = preds[0].asset if preds else None
    if asset is None or asset.joints is None or not len(asset.joints):
        fail("SkinTokens made no skeleton for this model (try another seed)")
    say(f"== {len(asset.joints)} bones ({time.time() - t0:.0f} s)")

    if a.postprocess:
        say("== smoothing the skin weights (voxels)")
        voxel = asset.voxel(resolution=196)
        asset.skin *= voxel_skin(grid=0, grid_coords=voxel.coords, joints=asset.joints, vertices=asset.vertices,
                                 faces=asset.faces, mode="square", voxel_size=voxel.voxel_size)
        asset.normalize_skin()

    say("== putting the rig onto the model")
    transfer_rigging(source_asset=asset, target_path=model_path, export_path=out, group_per_vertex=4)
    if not os.path.isfile(out):
        fail("no output was written")
    say(f"== done: {out}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--use-skeleton", action="store_true", help="keep the model's skeleton: skin weights only")
    ap.add_argument("--postprocess", action="store_true", help="SkinTokens' voxel smoothing of the weights")
    # SkinTokens' own defaults.
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument("--repetition-penalty", type=float, default=2.0)
    ap.add_argument("--num-beams", type=int, default=10)
    a = ap.parse_args(argv)
    try:
        rig(a)
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 - the viewer shows the last !! line
        traceback.print_exc()
        last = f"{type(e).__name__}: {e}".splitlines()[0][:400]
        if "out of memory" in last.lower():
            last += f" (SkinTokens asks for an NVIDIA GPU with {MIN_VRAM_GB} GB: UniRig needs less)"
        fail(last)


if __name__ == "__main__":
    main()
