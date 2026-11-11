"""Rig one model with UniRig: skeleton, then skin weights, merged back onto the model as a .glb.

Run by the viewer (src/rig_routes.py) with UniRig's own Python, in UniRig's folder:

    python unirig_run.py --repo <UniRig> --input <model> --output <out.glb> --work <tmp> [--seed 12345]

The steps are the ones UniRig's launch/inference/*.sh scripts run, called
directly so they also work where there is no bash (Windows). Without CUDA (a Mac,
or UNIRIG_DEVICE=cpu) the task files are copied with PyTorch Lightning told to use
MPS or the CPU at full precision, and the CUDA-only libraries come from the viewer's
stand-ins (scripts/rig/shims, installed by install_rig_tools.py); a step that fails
on MPS is run again on the CPU. UniRig is MIT
licensed (code and weights); it is not part of the viewer and is not
imported by it, only run.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import time

SUFFIXES = "obj,fbx,FBX,dae,glb,gltf,vrm"
DATA_CONFIG = "configs/data/quick_inference.yaml"
SKELETON_TASK = "configs/task/quick_inference_skeleton_articulationxl_ar_256.yaml"
SKIN_TASK = "configs/task/quick_inference_unirig_skin.yaml"


def step(title, args, cwd, fatal=True):
    """Run one UniRig command, its output passed through; its last lines are kept in TAIL."""
    print(f"== {title}", flush=True)
    cmd = [sys.executable, *args]
    env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK=os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "1"),
               PYTHONUNBUFFERED="1")
    TAIL.clear()
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1)
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        TAIL.append(line.rstrip())
        del TAIL[:-80]
    proc.stdout.close()
    code = proc.wait()
    if code != 0 and fatal:
        print(f"!! {title} failed ({code}): {why_failed()}", flush=True)
        sys.exit(code)
    return code


def why_failed():
    """The last error a step printed: the exception line of its traceback, else its last lines."""
    errs = [l.strip() for l in TAIL if re.match(r"^\s*[A-Za-z_.]*(Error|Exception)\b", l) or "Error:" in l]
    if errs:
        return errs[-1][:400]
    rest = [l.strip() for l in TAIL if l.strip()]
    return " | ".join(rest[-3:])[:400] or "no output"


TAIL = []
LAUNCH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unirig_launch.py")


def device():
    """cuda, mps or cpu: UNIRIG_DEVICE, else what this machine has."""
    want = os.environ.get("UNIRIG_DEVICE", "").strip().lower()
    if want in ("cuda", "mps", "cpu"):
        return want
    try:
        import torch
    except ImportError:     # UniRig's own run says what is missing
        return "cuda"
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


def _no_flash(cfg):
    """Turn every flash_attention_2 in a model config into sdpa; True when there was one."""
    hit = False
    if isinstance(cfg, dict):
        for k, v in cfg.items():
            if k in ("_attn_implementation", "attn_implementation") and v == "flash_attention_2":
                cfg[k] = "sdpa"
                hit = True
            else:
                hit = _no_flash(v) or hit
    elif isinstance(cfg, list):
        for v in cfg:
            hit = _no_flash(v) or hit
    return hit


def _voxels_by(cfg, backend):
    """Set every voxelizer `backend` in a transform config; True when there was one."""
    hit = False
    if isinstance(cfg, dict):
        for k, v in cfg.items():
            if k == "backend" and v in ("pyrender", "open3d"):
                cfg[k] = backend
                hit = True
            else:
                hit = _voxels_by(v, backend) or hit
    elif isinstance(cfg, list):
        for v in cfg:
            hit = _voxels_by(v, backend) or hit
    return hit


def _copy_config(repo, kind, name, dev, change):
    """configs/<kind>/<name>.yaml changed by `change(cfg)` (True when it changed anything) as a copy: its name, or None."""
    import yaml
    path = os.path.join(repo, "configs", kind, name if name.endswith(".yaml") else name + ".yaml")
    with open(path, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    if not change(cfg):
        return None
    out = f"_viewer_{os.path.splitext(os.path.basename(path))[0]}_{dev}"
    with open(os.path.join(repo, "configs", kind, out + ".yaml"), "w", encoding="utf-8") as fh:
        yaml.safe_dump(cfg, fh, sort_keys=False)
    return out


def task_for(repo, task, dev, voxels=None):
    """The task file as UniRig ships it on CUDA; elsewhere a copy that runs on `dev` at full precision.
    `voxels` ("open3d") swaps the skin step's voxelizer: pyrender's needs an OpenGL context."""
    if dev == "cuda" and not voxels:
        return task
    import yaml
    with open(os.path.join(repo, task), encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    comps = cfg.get("components") or {}
    tag = dev + (f"_{voxels}" if voxels else "")
    if dev != "cuda":
        trainer = cfg.setdefault("trainer", {})
        trainer["accelerator"] = dev
        trainer["precision"] = "32-true"
        trainer["devices"] = 1
        # The skeleton model asks transformers for flash-attention 2, which only CUDA has: PyTorch's own
        # attention (sdpa) computes the same thing.
        if comps.get("model"):
            comps["model"] = _copy_config(repo, "model", comps["model"], dev, _no_flash) or comps["model"]
    if voxels and comps.get("transform"):
        comps["transform"] = _copy_config(repo, "transform", comps["transform"], tag,
                                          lambda c: _voxels_by(c, voxels)) or comps["transform"]
    name = os.path.splitext(os.path.basename(task))[0]
    out = f"configs/task/_viewer_{name}_{tag}.yaml"
    with open(os.path.join(repo, out), "w", encoding="utf-8") as fh:
        yaml.safe_dump(cfg, fh, sort_keys=False)
    return out


def predict(title, repo, task, dev, args, voxels=False):
    """A run.py step on `dev`. A failure is tried again: with the open3d voxelizer when `voxels` (the
    skin step), and on the CPU after MPS."""
    tries = [(dev, None)]
    if voxels:
        tries.append((dev, "open3d"))
    if dev == "mps":
        tries.append(("cpu", "open3d" if voxels else None))
    for n, (d, vox) in enumerate(tries):
        last = n == len(tries) - 1
        label = title if n == 0 else f"{title} (again: {d}{', open3d voxels' if vox else ''})"
        code = step(label, [LAUNCH, "run.py", f"--task={task_for(repo, task, d, vox)}", *args], repo, fatal=last)
        if code == 0:
            return
        print(f"!! {label} failed ({code}): {why_failed()}", flush=True)


def extract(repo, model, npz_dir, faces):
    step("reading the mesh", ["-m", "src.data.extract", f"--config={DATA_CONFIG}", f"--require_suffix={SUFFIXES}",
                              "--force_override=true", "--num_runs=1", "--id=0",
                              f"--time={time.strftime('%Y_%m_%d_%H_%M_%S')}", f"--faces_target_count={faces}",
                              f"--input={model}", f"--output_dir={npz_dir}"], repo)
    # UniRig's extract catches its own errors and goes on: without this the next step fails on a
    # missing raw_data.npz and the reason is long gone from the log. (With an absolute input,
    # UniRig puts the npz beside the input, not in npz_dir.)
    want = [os.path.join(os.path.splitext(model)[0], "raw_data.npz"),
            os.path.join(npz_dir, os.path.splitext(os.path.basename(model))[0], "raw_data.npz")]
    if not any(os.path.isfile(w) for w in want):
        why = [l for l in TAIL if "Error" in l or "error" in l or "Traceback" in l] or TAIL[-6:]
        print("!! UniRig could not read the mesh: " + " | ".join(why[-4:]), flush=True)
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--faces", type=int, default=50000)
    a = ap.parse_args()
    repo = os.path.abspath(a.repo)
    work = os.path.abspath(a.work)
    os.makedirs(work, exist_ok=True)
    # A plain name in a plain folder: UniRig derives its intermediate paths from the input's.
    ext = os.path.splitext(a.input)[1].lower() or ".glb"
    model = os.path.join(work, "model" + ext)
    shutil.copyfile(a.input, model)
    npz = os.path.join(work, "npz")
    skeleton = os.path.join(work, "skeleton.fbx")
    skin = os.path.join(work, "skin.fbx")

    dev = device()
    print(f"== UniRig on {dev}", flush=True)
    extract(repo, model, npz, a.faces)
    predict("predicting the skeleton", repo, SKELETON_TASK, dev,
            [f"--seed={a.seed}", f"--input={model}", f"--output={skeleton}", f"--npz_dir={npz}"])
    extract(repo, skeleton, npz, a.faces)
    predict("predicting the skin weights", repo, SKIN_TASK, dev,
            [f"--seed={a.seed}", f"--input={skeleton}", f"--output={skin}", f"--npz_dir={npz}", "--data_name=raw_data.npz"],
            voxels=True)
    out = os.path.abspath(a.output)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    step("merging onto the model", ["-m", "src.inference.merge", f"--require_suffix={SUFFIXES}", "--num_runs=1", "--id=0",
                                    f"--source={skin}", f"--target={model}", f"--output={out}"], repo)
    if not os.path.isfile(out):
        print("!! no output was written", flush=True)
        sys.exit(1)
    print(f"== done: {out}", flush=True)


if __name__ == "__main__":
    main()
