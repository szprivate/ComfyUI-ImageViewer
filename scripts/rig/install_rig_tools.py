"""Set up the 3D space's character tools on this machine: UniRig (auto-rigging) and Kimodo (AI motion).

Each gets a Python environment of its own under --root (they pin torch and CUDA extensions that ComfyUI's
own environment must not get), and the viewer is told where they are: rig_tools.json in the viewer's user
folder (~/.comfyui_image_viewer, or the file IMAGE_VIEWER_RIG_TOOLS names). Restart nothing: the viewer reads
the file on every request.

    python scripts/rig/install_rig_tools.py --root D:/AI/rigtools                 # both
    python scripts/rig/install_rig_tools.py --root D:/AI/rigtools --only kimodo
    python scripts/rig/install_rig_tools.py --root D:/AI/rigtools --cuda cu124 --flash-attn-wheel <path or URL>

Run it with the Python the environments should be made from (UniRig wants 3.11; Kimodo 3.10 or later).

What each needs that this script cannot do for you:
  * Kimodo's text encoder is LLM2Vec on Meta-Llama-3-8B-Instruct, a gated model: ask for access on its
    Hugging Face page, then `hf auth login` (or put the token in ~/.cache/huggingface/token). With less
    than ~17 GB of VRAM keep "text_encoder_device": "cpu" (written by default): under 3 GB on the GPU.
  * UniRig's skin-weight model imports flash_attn. On Windows there is no wheel on PyPI: pass a prebuilt
    one that matches the torch / CUDA / Python versions with --flash-attn-wheel.
  * The models' weights download on first use (UniRig's from VAST-AI/UniRig, Kimodo's from nvidia/ on
    Hugging Face), so the first run takes a while.

Licences (none of this is part of the viewer, which only runs it): UniRig MIT (code and weights; its
pipeline uses Blender's bpy module, GPL, inside its own environment); Kimodo Apache-2.0, its SOMA models
under the NVIDIA Open Model License, the text encoder under Meta's Llama 3 licence.
"""
import argparse
import json
import os
import subprocess
import sys

UNIRIG_GIT = "https://github.com/VAST-AI-Research/UniRig.git"
KIMODO_GIT = "https://github.com/nv-tlabs/kimodo.git"


def run(cmd, cwd=None):
    print("$", " ".join(str(c) for c in cmd), flush=True)
    subprocess.check_call([str(c) for c in cmd], cwd=cwd)


def venv_python(folder):
    return os.path.join(folder, "Scripts", "python.exe") if os.name == "nt" else os.path.join(folder, "bin", "python")


def make_venv(folder, python):
    py = venv_python(folder)
    if not os.path.isfile(py):
        run([python, "-m", "venv", folder])
    run([py, "-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"])
    return py


def torch_version(py):
    out = subprocess.check_output([py, "-c", "import torch; print(torch.__version__.split('+')[0])"], text=True)
    return out.strip()


def install_unirig(root, python, cuda, flash_wheel):
    repo = os.path.join(root, "UniRig")
    if not os.path.isdir(os.path.join(repo, ".git")):
        run(["git", "clone", "--depth", "1", UNIRIG_GIT, repo])
    py = make_venv(os.path.join(repo, ".venv"), python)
    run([py, "-m", "pip", "install", "torch", "torchvision", "--index-url", f"https://download.pytorch.org/whl/{cuda}"])
    reqs = [r.strip() for r in open(os.path.join(repo, "requirements.txt"), encoding="utf-8") if r.strip()]
    run([py, "-m", "pip", "install", *[r for r in reqs if not r.startswith("flash_attn")], "psutil"])
    run([py, "-m", "pip", "install", f"spconv-{cuda}"])
    tv = torch_version(py)
    run([py, "-m", "pip", "install", "torch_scatter", "torch_cluster", "-f",
         f"https://data.pyg.org/whl/torch-{tv}+{cuda}.html", "--no-cache-dir"])
    if flash_wheel:
        run([py, "-m", "pip", "install", flash_wheel])
    else:
        try:
            run([py, "-m", "pip", "install", "flash_attn", "--no-build-isolation"])
        except subprocess.CalledProcessError:
            print("!! flash_attn did not install. UniRig's skinning needs it: rerun with --flash-attn-wheel "
                  "and a wheel built for this torch / CUDA / Python.", flush=True)
    run([py, "-m", "pip", "install", "numpy==1.26.4"])
    return {"python": py, "repo": repo}


def install_kimodo(root, python, cuda, model):
    folder = os.path.join(root, "kimodo")
    os.makedirs(folder, exist_ok=True)
    py = make_venv(os.path.join(folder, ".venv"), python)
    run([py, "-m", "pip", "install", "torch", "--index-url", f"https://download.pytorch.org/whl/{cuda}"])
    run([py, "-m", "pip", "install", f"git+{KIMODO_GIT}", "huggingface_hub"])
    return {"python": py, "model": model, "text_encoder_device": "cpu"}


def config_path():
    custom = os.environ.get("IMAGE_VIEWER_RIG_TOOLS", "").strip().strip('"')
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    return os.path.join(os.path.expanduser("~"), ".comfyui_image_viewer", "rig_tools.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, help="where the tools' folders go")
    ap.add_argument("--only", choices=["unirig", "kimodo"])
    ap.add_argument("--cuda", default="cu124", help="the PyTorch wheel index to use (cu118, cu121, cu124, cu126...)")
    ap.add_argument("--python", default=sys.executable, help="the interpreter the environments are made from")
    ap.add_argument("--flash-attn-wheel", default="", help="a flash_attn wheel (path or URL) for UniRig")
    ap.add_argument("--kimodo-model", default="Kimodo-SOMA-RP-v1.2")
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    os.makedirs(root, exist_ok=True)
    path = config_path()
    cfg = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    if a.only in (None, "unirig"):
        cfg["unirig"] = install_unirig(root, a.python, a.cuda, a.flash_attn_wheel)
    if a.only in (None, "kimodo"):
        cfg["kimodo"] = install_kimodo(root, a.python, a.cuda, a.kimodo_model)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    print(f"== written {path}")
    print("   Kimodo needs access to meta-llama/Meta-Llama-3-8B-Instruct on Hugging Face and `hf auth login`.")


if __name__ == "__main__":
    main()
