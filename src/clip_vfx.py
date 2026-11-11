"""VFX on a clip: LTX-2.5's IC-LoRA workflows run on a film of the History (right-click › VFX).

Four actions, each a ready-made workflow in ``clip_vfx_workflows/`` (API format; Lightricks' example
workflows from ComfyUI-LTXVideo ``example_workflows/2.5``, tested on a 32 GB card with the text encoders on
the CPU - the same files are agentY-core's ``ltx2_5_vfx_*`` templates):

    alpha    a greyscale matte film of the clip (white = opaque), at most ``ALPHA_CHUNK`` frames a run:
             a longer clip is cut into runs and their mattes joined again
    hdr      SDR -> HDR: an HLG BT.2020 film plus a half-float ACEScg EXR sequence (``ltx_vfx/hdr_exr/<name>``)
    reframe  outpaint the clip into another frame (width x height, multiples of 64)
    upscale  refine (stays close) or restore (for damaged footage), FullHD or 4K

The model needs 8n + 1 frames, so a clip of another length runs on the most of it that is 8n + 1 (the frames
left out are said). A clip that is exactly that and lies in ComfyUI's input folder is read as it is; anything
else is written into ``<input>/clip_vfx/`` first by the Edit panel's renderer (PyAV in this process, sound
kept) - no process is started. The seeds stay as tested: a pass run again gives the same picture.

The page queues the graphs (with the sign-in, as Generate does) and hands the outputs back to ``finish``.
"""
from __future__ import annotations

import copy
import json
import os
import re
import secrets
import shutil
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WF_DIR = os.path.join(HERE, "clip_vfx_workflows")

ALPHA_CHUNK = 121                 # 8 x 15 + 1: the alpha IC-LoRA's longest run
MIN_FRAMES = 9
MAX_JOBS = 32
MAX_SIDE = 1920                   # what was tested on 32 GB for reframe's target
MAX_PROMPT = 2000
UPSCALE_SIZES = ("FullHD", "4K")

ACTIONS = {
    "alpha": {"label": "Alpha matte", "files": {"": "ltx2_5_vfx_alpha_matte"}, "prompt": False,
              "minutes": "about 6 min for 97 frames on an RTX 5090"},
    "hdr": {"label": "SDR to HDR", "files": {"": "ltx2_5_vfx_sdr_to_hdr"}, "prompt": False,
            "minutes": "about 2.5 min for 97 frames on an RTX 5090"},
    "reframe": {"label": "Reframe", "files": {"": "ltx2_5_vfx_reframe_outpaint"}, "prompt": True,
                "minutes": "about 9 min for 97 frames on an RTX 5090"},
    "upscale": {"label": "Upscale", "files": {"refine": "ltx2_5_vfx_upscale_refine",
                                              "restore": "ltx2_5_vfx_upscale_restore"}, "prompt": True,
                "minutes": "about 11 min for 97 frames on an RTX 5090"},
}
REFRAME_PRESETS = [("16:9", 1920, 1088), ("9:16", 1088, 1920), ("1:1", 1088, 1088), ("4:5", 1088, 1344),
                   ("2.39:1", 1920, 832)]

# Loaders the paint table does not know (LTX's own), checked the same way.
EXTRA_LOADERS = {
    "LTXICLoRALoaderModelOnly": [("lora_name", "loras")],
    "LatentUpscaleModelLoader": [("model_name", "latent_upscale_models")],
}


class VfxError(Exception):
    def __init__(self, msg, status=400, **extra):
        super().__init__(msg)
        self.status = status
        self.extra = extra


# ── the workflows ────────────────────────────────────────────────────────────

def workflow(name):
    with open(os.path.join(WF_DIR, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def _only(graph, cls):
    ids = [k for k, v in graph.items() if v.get("class_type") == cls]
    if len(ids) != 1:
        raise VfxError(f"the workflow has {len(ids)} {cls} nodes, not one", 500)
    return ids[0]


def _titled(graph, cls, word):
    for k, v in graph.items():
        if v.get("class_type") == cls and word in str((v.get("_meta") or {}).get("title", "")).lower():
            return k
    return None


def clean_options(action, opts):
    """The options of *action* as they will be used (anything else in *opts* is ignored)."""
    if action not in ACTIONS:
        raise VfxError(f"no such action: {action!r}")
    opts = opts if isinstance(opts, dict) else {}
    out = {}
    if ACTIONS[action]["prompt"]:
        out["prompt"] = str(opts.get("prompt") or "").strip()[:MAX_PROMPT]
    if action == "reframe":
        try:
            w, h = int(opts.get("width") or 1920), int(opts.get("height") or 1088)
        except (TypeError, ValueError):
            raise VfxError("width and height must be whole numbers")
        snap = lambda x: max(256, min(MAX_SIDE, int(round(x / 64.0)) * 64))   # the workflow snaps to 64
        out["width"], out["height"] = snap(w), snap(h)
    if action == "upscale":
        mode = str(opts.get("mode") or "refine")
        out["mode"] = mode if mode in ("refine", "restore") else "refine"
        size = str(opts.get("size") or "FullHD")
        out["size"] = size if size in UPSCALE_SIZES else "FullHD"
    return out


def graph_for(action, opts, video, prefix, exr_dir=""):
    """The API graph of *action* reading *video* (a name in ComfyUI's input folder) and saving as *prefix*
    (in the output folder). -> (graph, id of the SaveVideo node)."""
    opts = clean_options(action, opts)
    g = copy.deepcopy(workflow(ACTIONS[action]["files"][opts.get("mode", "")]))
    g[_only(g, "LoadVideo")]["inputs"]["file"] = video
    save = _only(g, "SaveVideo")
    g[save]["inputs"]["filename_prefix"] = prefix
    if "prompt" in opts:
        p = _titled(g, "PrimitiveStringMultiline", "positive")
        if p is None:
            raise VfxError("the workflow has no positive prompt", 500)
        g[p]["inputs"]["value"] = opts["prompt"]
    if action == "reframe":
        g[_titled(g, "PrimitiveInt", "width")]["inputs"]["value"] = opts["width"]
        g[_titled(g, "PrimitiveInt", "height")]["inputs"]["value"] = opts["height"]
    if action == "upscale":
        g[_only(g, "LTXVGetTilingSizes")]["inputs"]["output_size"] = opts["size"]
    if action == "hdr":
        exr = g[_only(g, "LTXVHDRDecodePostprocess")]["inputs"]
        exr["output_dir"] = exr_dir
        exr["filename_prefix"] = "frame"
    return g, save


def missing(graph, folder_paths=None, node_classes=None):
    """What *graph* needs that is not here: [{what, kind, folder?}] (the model names pointed at what was found)."""
    from . import paint_generate as pg
    out = pg.missing(graph, folder_paths, node_classes)
    if folder_paths is None:
        return out
    seen = {m["what"] for m in out}
    for v in graph.values():
        for name, folder in EXTRA_LOADERS.get(v.get("class_type"), []):
            ins = v.get("inputs") or {}
            f = ins.get(name)
            if not isinstance(f, str) or not f:
                continue
            got = pg.locate(folder_paths, folder, f)
            if got:
                ins[name] = got
            elif f not in seen:
                seen.add(f)
                out.append({"what": f, "kind": "model", "folder": folder})
    return out


# ── frames ───────────────────────────────────────────────────────────────────

def usable(n):
    """The most of *n* frames that is 8k + 1."""
    return ((int(n) - 1) // 8) * 8 + 1 if n >= MIN_FRAMES else 0


def plan(frames, chunk=None):
    """The runs a clip of *frames* frames is cut into: [(first frame, frames)], each 8k + 1 and at most
    *chunk*; the frames at the end that make no such run are left out."""
    if frames < MIN_FRAMES:
        raise VfxError(f"the clip is {frames} frames long; LTX needs at least {MIN_FRAMES}")
    runs, at, left = [], 0, int(frames)
    while left >= MIN_FRAMES:
        n = usable(min(left, chunk) if chunk else left)
        runs.append((at, n))
        at += n
        left -= n
    return runs


def probe(path):
    """{frames, fps, width, height, seconds} of a film (PyAV, the header first, else counted)."""
    import av
    with av.open(path) as src:
        if not src.streams.video:
            raise VfxError(f"{os.path.basename(path)} has no picture", 415)
        s = src.streams.video[0]
        fps = float(s.average_rate or s.guessed_rate or 24)
        if s.duration and s.time_base:
            seconds = float(s.duration * s.time_base)
        elif src.duration:
            seconds = src.duration / 1_000_000
        else:
            seconds = 0.0
        frames = int(s.frames or 0) or int(round(seconds * fps))
        if not frames:
            frames = sum(1 for _ in src.decode(video=0))
            seconds = frames / fps
        return {"frames": frames, "fps": fps, "width": s.width, "height": s.height,
                "seconds": seconds or frames / fps}


def write_part(path, first, n, fps, out_path, may_use=None):
    """Frames first .. first + n - 1 of *path*, with their sound, as an H.264 film (the Edit panel's renderer)."""
    from . import timeline_io, timeline_render
    name = os.path.splitext(os.path.basename(path))[0]
    doc = timeline_io.rebuild(timeline_io.new_doc(name, fps),
                              {"clips": [{"file": path, "in": first / fps, "length": n / fps, "transition": 0,
                                          "name": name}], "texts": []}, "", may_use)
    return timeline_render.render(doc, out_path, "mp4", may_use, "h264", "high")


def join(paths, fps, out_path, may_use=None):
    """The films *paths* one after the other (the mattes of a long clip's runs)."""
    from . import timeline_io, timeline_render
    clips = []
    for p in paths:
        clips.append({"file": p, "in": 0.0, "length": probe(p)["frames"] / fps, "transition": 0,
                      "name": os.path.splitext(os.path.basename(p))[0]})
    doc = timeline_io.rebuild(timeline_io.new_doc("joined", fps), {"clips": clips, "texts": []}, "", may_use)
    return timeline_render.render(doc, out_path, "mp4", may_use, "h264", "high")


# ── jobs ─────────────────────────────────────────────────────────────────────

_JOBS = {}
_LOCK = threading.Lock()


def stem_of(path):
    s = re.sub(r"[^A-Za-z0-9_\-]+", "_", os.path.splitext(os.path.basename(path))[0]).strip("_")
    return (s or "clip")[:60]


def _inside(path, folder):
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(folder)]) == os.path.abspath(folder)
    except ValueError:            # another drive
        return False


def prepare(source, action, opts, input_dir, output_dir, *, folder_paths=None, node_classes=None, may_use=None,
            facts=None, write=None):
    """Everything the page queues for *action* on the film *source* (a path the route checked):
    {job, label, graphs, output, runs, used, frames, left_out, note}. Raises VfxError(409, missing=[...])
    when a model or node is not here - before anything is written."""
    opts = clean_options(action, opts)
    f = facts or probe(source)
    write = write or write_part
    runs = plan(f["frames"], ALPHA_CHUNK if action == "alpha" else None)
    job = secrets.token_hex(6)
    stem = stem_of(source)
    tag = {"alpha": "alpha", "hdr": "hdr", "reframe": "reframe",
           "upscale": "upscale_" + opts.get("mode", "")}[action]
    prefix = f"ltx_vfx/{stem}_{tag}"
    exr_dir = f"ltx_vfx/hdr_exr/{stem}_{job}" if action == "hdr" else ""
    # Checked on a graph before anything is written for it.
    g0, _save = graph_for(action, opts, "check.mp4", prefix, exr_dir)
    miss = missing(g0, folder_paths, node_classes)
    if miss:
        raise VfxError("the workflow needs what is not here", 409, missing=miss)
    whole = len(runs) == 1 and runs[0] == (0, f["frames"])
    staged, made = [], []
    if whole and _inside(source, input_dir):
        staged.append(os.path.relpath(source, input_dir).replace(os.sep, "/"))
    else:
        folder = os.path.join(input_dir, "clip_vfx")
        os.makedirs(folder, exist_ok=True)
        for i, (first, n) in enumerate(runs):
            name = f"{stem}_{job}_{i + 1:02d}.mp4"
            out = os.path.join(folder, name)
            if whole and source.lower().endswith(".mp4"):
                shutil.copyfile(source, out)
            else:
                write(source, first, n, f["fps"], out, may_use)
            made.append(out)
            staged.append("clip_vfx/" + name)
    graphs, save = [], None
    for name in staged:
        g, save = graph_for(action, opts, name, prefix, exr_dir)
        missing(g, folder_paths, None)           # the model names as this ComfyUI lists them
        graphs.append(g)
    used = sum(n for _a, n in runs)
    left = f["frames"] - used
    note = ""
    if left:
        note = f"{left} frame{'s' if left != 1 else ''} at the end left out (LTX takes 8n + 1 frames)"
    if len(runs) > 1:
        note = (note + "; " if note else "") + f"run in {len(runs)} parts of at most {ALPHA_CHUNK} frames"
    rec = {"id": job, "action": action, "opts": opts, "source": source, "stem": stem, "fps": f["fps"],
           "made": made, "exr_dir": exr_dir, "runs": runs, "created": time.time()}
    with _LOCK:
        _JOBS[job] = rec
        while len(_JOBS) > MAX_JOBS:
            _JOBS.pop(next(iter(_JOBS)))
    label = ACTIONS[action]["label"]
    if action == "upscale":
        label += f" ({opts['mode']}, {opts['size']})"
    if action == "reframe":
        label += f" to {opts['width']}x{opts['height']}"
    return {"job": job, "label": label, "graphs": graphs, "output": save, "runs": len(runs), "used": used,
            "frames": f["frames"], "left_out": left, "note": note, "minutes": ACTIONS[action]["minutes"]}


def _free_name(folder, stem, ext):
    i = 1
    while True:
        p = os.path.join(folder, f"{stem}_v{i:03d}{ext}")
        if not os.path.exists(p):
            return p
        i += 1


def finish(job, results, output_dir, *, may_use=None, join_films=None):
    """*results*: the output film of each run, as absolute paths (the route resolved them), in run order.
    -> {path, exr: [frames] | None, label}. The parts written for the runs are removed."""
    with _LOCK:
        rec = _JOBS.get(job)
    if rec is None:
        raise VfxError("unknown job", 404)
    if len(results) != len(rec["runs"]):
        raise VfxError(f"{len(results)} results for {len(rec['runs'])} runs")
    for p in results:
        if not p or not os.path.isfile(p):
            raise VfxError(f"no such result: {os.path.basename(p or '?')}", 404)
    if len(results) == 1:
        path = results[0]
    else:
        folder = os.path.join(output_dir, "ltx_vfx")
        os.makedirs(folder, exist_ok=True)
        path = _free_name(folder, f"{rec['stem']}_alpha", ".mp4")
        (join_films or join)(results, rec["fps"], path, may_use)
    exr = None
    if rec["exr_dir"]:
        d = os.path.join(output_dir, rec["exr_dir"])
        if os.path.isdir(d):
            exr = sorted(os.path.join(d, n) for n in os.listdir(d) if n.lower().endswith(".exr"))
    for p in rec["made"]:
        try:
            os.remove(p)
        except OSError:
            pass
    rec["made"] = []
    return {"path": path, "exr": exr, "action": rec["action"], "source": rec["source"]}


def actions():
    """What the page offers: {action: {label, prompt, minutes}}, the reframe presets and the upscale sizes."""
    return {"actions": {a: {"label": e["label"], "prompt": e["prompt"], "minutes": e["minutes"],
                            "modes": [m for m in e["files"] if m]} for a, e in ACTIONS.items()},
            "reframe": [{"label": l, "width": w, "height": h} for l, w, h in REFRAME_PRESETS],
            "sizes": list(UPSCALE_SIZES), "chunk": ALPHA_CHUNK}

