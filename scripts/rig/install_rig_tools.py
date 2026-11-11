"""Set up the 3D space's character tools on this machine: UniRig (auto-rigging) and Kimodo (AI motion).

Each gets a Python environment of its own under --root (they pin torch and CUDA extensions that ComfyUI's
own environment must not get), and the viewer is told where they are: rig_tools.json in the viewer's user
folder (~/.comfyui_image_viewer, or the file IMAGE_VIEWER_RIG_TOOLS names). Restart nothing: the viewer reads
the file on every request.

    python scripts/rig/install_rig_tools.py --root D:/AI/rigtools                 # both
    python scripts/rig/install_rig_tools.py --root ~/rigtools --only kimodo
    python scripts/rig/install_rig_tools.py --root D:/AI/rigtools --cuda cu128    # instead of what the GPU says

Any Python runs it. UniRig needs Python 3.11 (bpy 4.2 is built only for it): the script finds one (the
Windows py launcher, python3.11 on PATH, or uv, which installs one when there is none) or says how to get
it; --python names one. Kimodo uses the same 3.11 when there is one (it wants 3.10 or later).

Windows and Linux with an NVIDIA GPU: the CUDA build follows the GPU (--cuda auto: cu128 for RTX 50 /
Blackwell, cu126 otherwise). UniRig's skinning needs flash_attn, which has no wheel on PyPI: the script
looks up a prebuilt one (github.com/mjun0812/flash-attention-prebuild-wheels, BSD) that matches this
Python and a torch / CUDA pair the other CUDA extensions (torch_scatter, torch_cluster from data.pyg.org)
also have, and installs that torch. --flash-attn-wheel <path or URL> takes your own instead.

macOS (Apple Silicon), or --cuda cpu: no CUDA libraries. UniRig runs on PyTorch's MPS (or the CPU) with
the viewer's pure-PyTorch stand-ins for flash_attn, spconv, torch_scatter and torch_cluster
(scripts/rig/shims, put on UniRig's environment by a .pth file); Kimodo runs on MPS. Slower than a CUDA
GPU, but the same models and results.

What each needs that this script cannot do for you:
  * Kimodo's text encoder is LLM2Vec on Meta-Llama-3-8B-Instruct, a gated model: ask for access on its
    Hugging Face page, then `hf auth login` (or put the token in ~/.cache/huggingface/token). With less
    than ~17 GB of VRAM keep "text_encoder_device": "cpu" (written by default): under 3 GB on the GPU.
  * The models' weights download on first use (UniRig's from VAST-AI/UniRig, Kimodo's from nvidia/ on
    Hugging Face), so the first run takes a while.

Licences (none of this is part of the viewer, which only runs it): UniRig MIT (code and weights; its
pipeline uses Blender's bpy module, GPL, inside its own environment); Kimodo Apache-2.0, its SOMA models
under the NVIDIA Open Model License, the text encoder under Meta's Llama 3 licence; flash-attention BSD.
"""
import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import urllib.request

UNIRIG_GIT = "https://github.com/VAST-AI-Research/UniRig.git"
KIMODO_GIT = "https://github.com/nv-tlabs/kimodo.git"
FLASH_INDEX = "https://raw.githubusercontent.com/mjun0812/flash-attention-prebuild-wheels/main/doc/packages.md"
TORCH_INDEX = "https://download.pytorch.org/whl/{cuda}"
PYG_INDEX = "https://data.pyg.org/whl/torch-{torch}.0+{cuda}.html"
# After UniRig's requirements: numpy 1 for its compiled parts; pyrender (the skin step's voxelizer) resolves
# networkx 2.2, which does not import on Python 3.10+, and does not work with pyglet 2.
PINS = ["numpy==1.26.4", "networkx>=3", "pyglet<2"]
SHIMS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shims")


def run(cmd, cwd=None, env=None):
    print("$", " ".join(str(c) for c in cmd), flush=True)
    subprocess.check_call([str(c) for c in cmd], cwd=cwd, env=None if env is None else {**os.environ, **env})


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "rig-tools-installer"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def system():
    """'win', 'linux' or 'mac'."""
    return {"Windows": "win", "Darwin": "mac"}.get(platform.system(), "linux")


def wheel_platform(sysname):
    return {"win": "win_amd64", "linux": "linux_x86_64"}[sysname]


def gpu_cuda():
    """The CUDA build this machine's NVIDIA GPU wants, or None without one."""
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
                                      text=True, timeout=20)
    except Exception:
        return None
    caps = [float(x) for x in re.findall(r"\d+\.\d+", out)]
    if not caps:
        return None
    return "cu128" if max(caps) >= 12.0 else "cu126"


def venv_python(folder):
    return os.path.join(folder, "Scripts", "python.exe") if os.name == "nt" else os.path.join(folder, "bin", "python")


def version_of(python):
    """(major, minor, path) of an interpreter given as a list (a command), or None when it does not run or
    cannot make a venv (ComfyUI's portable Python has no venv module)."""
    cmd = python if isinstance(python, list) else [python]
    try:
        out = subprocess.check_output([*cmd, "-c", "import sys, venv, ensurepip; print(sys.version_info[0], sys.version_info[1], sys.executable)"],
                                      text=True, timeout=60, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    major, minor, exe = out.strip().split(" ", 2)
    return int(major), int(minor), exe


def find_python(want, given):
    """An interpreter of version `want` (3, 11): the one given, the Windows py launcher, pythonX.Y on PATH,
    one uv knows or installs. Its path, or None."""
    tries = [[given]]
    if os.name == "nt":
        tries.append(["py", f"-{want[0]}.{want[1]}"])
    tries += [[f"python{want[0]}.{want[1]}"], ["uv", "python", "find", f"{want[0]}.{want[1]}"]]
    for cmd in tries:
        if cmd[0] == "uv":
            try:
                exe = subprocess.check_output(cmd, text=True, timeout=60, stderr=subprocess.DEVNULL).strip()
            except Exception:
                continue
            cmd = [exe]
        v = version_of(cmd)
        if v and v[:2] == tuple(want):
            return v[2]
    if shutil.which("uv"):
        print(f"== no Python {want[0]}.{want[1]} here: uv installs one", flush=True)
        try:
            run(["uv", "python", "install", f"{want[0]}.{want[1]}"])
            exe = subprocess.check_output(["uv", "python", "find", f"{want[0]}.{want[1]}"], text=True).strip()
            v = version_of([exe])
            if v and v[:2] == tuple(want):
                return v[2]
        except Exception as e:
            print(f"!! uv could not install it: {e}", flush=True)
    return None


def make_venv(folder, python):
    py = venv_python(folder)
    want = version_of([python])
    have = version_of([py]) if os.path.isfile(py) else None
    if have and want and have[:2] != want[:2]:
        # A venv this script made earlier with another Python: made again.
        print(f"== {folder} has Python {have[0]}.{have[1]}; made again with {want[0]}.{want[1]}", flush=True)
        shutil.rmtree(folder)
    if not os.path.isfile(py):
        run([python, "-m", "venv", folder])
    run([py, "-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"])
    return py


def py_tag(py):
    out = subprocess.check_output([py, "-c", "import sys; print(f'cp{sys.version_info[0]}{sys.version_info[1]}')"], text=True)
    return out.strip()


def site_packages(py):
    out = subprocess.check_output([py, "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], text=True)
    return out.strip()


def _ver(s):
    return tuple(int(x) for x in re.findall(r"\d+", s))


# ── A flash_attn wheel and the torch it was built for ─────────────────────────

def flash_wheels(text, plat):
    """[{url, flash, cuda, torch, py}] for flash_attn 2 wheels on this platform, from the index page's links."""
    out = []
    pat = r"\((https://[^)\s]*/(flash_attn-(2[\d.]*(?:\.post\d+)?)\+(cu\d+)torch([\d.]+)-(cp\d+)-cp\d+-" + plat + r"\.whl))\)"
    for m in re.finditer(pat, text):
        out.append({"url": m.group(1), "flash": m.group(3), "cuda": m.group(4),
                    "torch": ".".join(m.group(5).split(".")[:2]), "py": m.group(6)})
    return out


def cuda_order(want, have):
    """`want` first, then the other CUDA builds nearest to it. A tie goes to the older build (it asks less of
    the driver), except from cu128 up: RTX 50 / Blackwell cards need 12.8 or later."""
    w = _ver(want)[0]
    newer = w >= 128
    return sorted(set(have), key=lambda c: (c != want, newer and _ver(c)[0] < 128, abs(_ver(c)[0] - w),
                                            -_ver(c)[0] if newer else _ver(c)[0]))


def pick_flash(wheels, py, cuda, plat, has_torch, has_pyg):
    """The best (wheel, torch, cuda): this Python, a CUDA build near `cuda`, the newest torch that the
    PyTorch index and data.pyg.org (torch_scatter, torch_cluster) also have."""
    mine = [w for w in wheels if w["py"] == py]
    for cu in cuda_order(cuda, [w["cuda"] for w in mine]):
        pool = sorted((w for w in mine if w["cuda"] == cu), key=lambda w: (_ver(w["torch"]), _ver(w["flash"])), reverse=True)
        seen = set()
        for w in pool:
            if w["torch"] in seen:
                continue
            seen.add(w["torch"])
            if has_torch(w["torch"], cu, py, plat) and has_pyg(w["torch"], cu, py, plat):
                return w
    return None


def torch_available(torch, cuda, py, plat):
    try:
        page = fetch(TORCH_INDEX.format(cuda=cuda) + "/torch/")
    except Exception:
        return False
    return re.search(rf"torch-{re.escape(torch)}\.\d+%2B{cuda}-{py}-{py}-{plat}\.whl|"
                     rf"torch-{re.escape(torch)}\.\d+\+{cuda}-{py}-{py}-{plat}\.whl", page) is not None


def pyg_available(torch, cuda, py, plat):
    try:
        page = fetch(PYG_INDEX.format(torch=torch, cuda=cuda))
    except Exception:
        return False
    return all(re.search(rf"{name}-[\d.]+(?:%2B|\+)pt[\d]+{cuda}-{py}-{py}-{plat}\.whl", page)
               for name in ("torch_scatter", "torch_cluster"))


def spconv_package(cuda):
    v = _ver(cuda)[0]
    if v >= 126:
        return "spconv-cu126"
    if v >= 124:
        return "spconv-cu124"
    if v >= 120:
        return "spconv-cu121"
    return "spconv-cu118"


# ── UniRig ────────────────────────────────────────────────────────────────────

def unirig_requirements(repo):
    reqs = [r.strip() for r in open(os.path.join(repo, "requirements.txt"), encoding="utf-8") if r.strip()]
    return [r for r in reqs if not r.startswith(("flash_attn", "flash-attn", "#"))]


def install_shims(py):
    """Put the pure-PyTorch stand-ins after site-packages: a real library, where there is one, still wins."""
    pth = os.path.join(site_packages(py), "imageviewer_rig_shims.pth")
    with open(pth, "w", encoding="utf-8") as fh:
        fh.write(SHIMS + "\n")
    print(f"== stand-ins for flash_attn / spconv / torch_scatter / torch_cluster: {pth}")


def install_unirig(root, python, cuda, flash_wheel, sysname):
    repo = os.path.join(root, "UniRig")
    if not os.path.isdir(os.path.join(repo, ".git")):
        run(["git", "clone", "--depth", "1", UNIRIG_GIT, repo])
    py311 = find_python((3, 11), python)
    if not py311:
        sys.exit("!! UniRig needs Python 3.11 (its bpy 4.2 is built only for 3.11), and none was found.\n"
                 "   Install one, then run this again:\n"
                 "     Windows: winget install Python.Python.3.11   (or: conda create -n py311 python=3.11)\n"
                 "     macOS:   brew install python@3.11\n"
                 "   or pass it: --python <path to python 3.11>")
    print(f"== UniRig's Python: {py311}", flush=True)
    py = make_venv(os.path.join(repo, ".venv"), py311)
    tag = py_tag(py)
    reqs = unirig_requirements(repo)
    if cuda == "cpu" or sysname == "mac":
        if sysname == "mac":
            run([py, "-m", "pip", "install", "torch", "torchvision"])
            device = "mps"
        else:
            run([py, "-m", "pip", "install", "torch", "torchvision", "--index-url", TORCH_INDEX.format(cuda="cpu")])
            device = "cpu"
        run([py, "-m", "pip", "install", *reqs, "psutil"])
        install_shims(py)
        run([py, "-m", "pip", "install", *PINS])
        return {"python": py, "repo": repo, "device": device,
                "env": {"UNIRIG_DEVICE": device, "PYTORCH_ENABLE_MPS_FALLBACK": "1"}}

    plat = wheel_platform(sysname)
    torch_ver, wheel = None, flash_wheel
    if not wheel:
        try:
            found = pick_flash(flash_wheels(fetch(FLASH_INDEX), plat), tag, cuda, plat, torch_available, pyg_available)
        except Exception as e:  # the index could not be read
            print(f"!! could not read the flash_attn wheel list: {e}", flush=True)
            found = None
        if found:
            torch_ver, cuda, wheel = found["torch"], found["cuda"], found["url"]
            print(f"== flash_attn {found['flash']} for torch {torch_ver} + {cuda}, {tag}: {wheel}", flush=True)
        else:
            print(f"!! no prebuilt flash_attn for {tag} / {cuda} / {plat}: torch as the index has it, flash_attn "
                  "built from source (needs the CUDA toolkit), or pass --flash-attn-wheel.", flush=True)
    spec = f"torch=={torch_ver}.*" if torch_ver else "torch"
    run([py, "-m", "pip", "install", spec, "torchvision", "--index-url", TORCH_INDEX.format(cuda=cuda)])
    run([py, "-m", "pip", "install", *reqs, "psutil"])
    run([py, "-m", "pip", "install", spconv_package(cuda)])
    tv = subprocess.check_output([py, "-c", "import torch; print(torch.__version__.split('+')[0])"], text=True).strip()
    run([py, "-m", "pip", "install", "torch_scatter", "torch_cluster", "-f",
         f"https://data.pyg.org/whl/torch-{tv}+{cuda}.html", "--no-cache-dir"])
    try:
        if wheel:
            run([py, "-m", "pip", "install", wheel])
        else:
            run([py, "-m", "pip", "install", "flash_attn", "--no-build-isolation"])
    except subprocess.CalledProcessError:
        print("!! flash_attn did not install: UniRig will use the viewer's stand-in for it (slower skinning).",
              flush=True)
    install_shims(py)   # only used for what is missing
    run([py, "-m", "pip", "install", *PINS])
    return {"python": py, "repo": repo, "device": "cuda"}


# ── Kimodo ────────────────────────────────────────────────────────────────────

def install_kimodo(root, python, cuda, model, sysname):
    folder = os.path.join(root, "kimodo")
    os.makedirs(folder, exist_ok=True)
    py = make_venv(os.path.join(folder, ".venv"), find_python((3, 11), python) or python)
    env = {}
    if sysname == "mac":
        run([py, "-m", "pip", "install", "torch"])
        env = {"KIMODO_DEVICE": "mps", "PYTORCH_ENABLE_MPS_FALLBACK": "1"}
    elif cuda == "cpu":
        run([py, "-m", "pip", "install", "torch", "--index-url", TORCH_INDEX.format(cuda="cpu")])
        env = {"KIMODO_DEVICE": "cpu"}
    else:
        run([py, "-m", "pip", "install", "torch", "--index-url", TORCH_INDEX.format(cuda=cuda)])
    # Kimodo builds a C++ extension (motion_correction, its optional clean-up of foot contacts and
    # constraints) with CMake: CMake comes from pip, a C++ compiler must be on the machine (Visual Studio's
    # Build Tools on Windows, Xcode's command line tools on a Mac). Without one, Kimodo goes in without it;
    # the viewer cleans the feet up itself.
    run([py, "-m", "pip", "install", "cmake", "ninja", "huggingface_hub"])
    bindir = os.path.dirname(py)
    try:
        run([py, "-m", "pip", "install", f"git+{KIMODO_GIT}"], env={"PATH": bindir + os.pathsep + os.environ.get("PATH", "")})
        corrected = True
    except subprocess.CalledProcessError:
        print("!! Kimodo's motion_correction extension did not build (no C++ compiler?): Kimodo without it.",
              flush=True)
        run([py, "-m", "pip", "install", f"git+{KIMODO_GIT}"], env={"SKIP_MOTION_CORRECTION_IN_SETUP": "1"})
        corrected = False
    out = {"python": py, "model": model, "text_encoder_device": "cpu", "motion_correction": corrected}
    if env:
        out["env"] = env
    return out


def config_path():
    custom = os.environ.get("IMAGE_VIEWER_RIG_TOOLS", "").strip().strip('"')
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    return os.path.join(os.path.expanduser("~"), ".comfyui_image_viewer", "rig_tools.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, help="where the tools' folders go")
    ap.add_argument("--only", choices=["unirig", "kimodo"])
    ap.add_argument("--cuda", default="auto",
                    help="auto (from the GPU), cpu, or a PyTorch wheel index: cu118, cu121, cu124, cu126, cu128...")
    ap.add_argument("--python", default=sys.executable, help="the interpreter the environments are made from")
    ap.add_argument("--flash-attn-wheel", default="", help="your own flash_attn wheel (path or URL) for UniRig")
    ap.add_argument("--kimodo-model", default="Kimodo-SOMA-RP-v1.2")
    a = ap.parse_args()
    sysname = system()
    cuda = a.cuda
    if sysname == "mac":
        cuda = "cpu"
    elif cuda == "auto":
        cuda = gpu_cuda() or "cpu"
        print(f"== CUDA build: {cuda}" + ("" if cuda != "cpu" else " (no NVIDIA GPU found)"), flush=True)
    root = os.path.abspath(os.path.expanduser(a.root))
    os.makedirs(root, exist_ok=True)
    path = config_path()
    cfg = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    if a.only in (None, "unirig"):
        cfg["unirig"] = install_unirig(root, a.python, cuda, a.flash_attn_wheel, sysname)
    if a.only in (None, "kimodo"):
        cfg["kimodo"] = install_kimodo(root, a.python, cuda, a.kimodo_model, sysname)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    print(f"== written {path}")
    print("   Kimodo needs access to meta-llama/Meta-Llama-3-8B-Instruct on Hugging Face and `hf auth login`.")


if __name__ == "__main__":
    main()
