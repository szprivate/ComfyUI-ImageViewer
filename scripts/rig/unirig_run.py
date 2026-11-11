"""Rig one model with UniRig: skeleton, then skin weights, merged back onto the model as a .glb.

Run by the viewer (src/rig_routes.py) with UniRig's own Python, in UniRig's folder:

    python unirig_run.py --repo <UniRig> --input <model> --output <out.glb> --work <tmp> [--seed 12345]

The steps are the ones UniRig's launch/inference/*.sh scripts run, called
directly so they also work where there is no bash (Windows). UniRig is MIT
licensed (code and weights); it is not part of the viewer and is not
imported by it, only run.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

SUFFIXES = "obj,fbx,FBX,dae,glb,gltf,vrm"
DATA_CONFIG = "configs/data/quick_inference.yaml"
SKELETON_TASK = "configs/task/quick_inference_skeleton_articulationxl_ar_256.yaml"
SKIN_TASK = "configs/task/quick_inference_unirig_skin.yaml"


def step(title, args, cwd):
    print(f"== {title}", flush=True)
    cmd = [sys.executable, *args]
    code = subprocess.call(cmd, cwd=cwd)
    if code != 0:
        print(f"!! {title} failed ({code})", flush=True)
        sys.exit(code)


def extract(repo, model, npz_dir, faces):
    step("reading the mesh", ["-m", "src.data.extract", f"--config={DATA_CONFIG}", f"--require_suffix={SUFFIXES}",
                              "--force_override=true", "--num_runs=1", "--id=0",
                              f"--time={time.strftime('%Y_%m_%d_%H_%M_%S')}", f"--faces_target_count={faces}",
                              f"--input={model}", f"--output_dir={npz_dir}"], repo)


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

    extract(repo, model, npz, a.faces)
    step("predicting the skeleton", ["run.py", f"--task={SKELETON_TASK}", f"--seed={a.seed}", f"--input={model}",
                                     f"--output={skeleton}", f"--npz_dir={npz}"], repo)
    extract(repo, skeleton, npz, a.faces)
    step("predicting the skin weights", ["run.py", f"--task={SKIN_TASK}", f"--seed={a.seed}", f"--input={skeleton}",
                                         f"--output={skin}", f"--npz_dir={npz}", "--data_name=raw_data.npz"], repo)
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
