"""Comp's AI nodes (matte, depth, relight, inpaint, upscale): one frame through a ComfyUI workflow.

The workflows are Paint's Generate ones (``paint_generate``: the built-ins, the user's choice per action, the
same slots and model checks). ``prepare`` renders what goes into the node at that frame (``comp_model``, full
size), hands it to ``paint_generate.prepare`` as the picture to work on - an inpaint's mask input as the
selection - and keeps what it needs to lay the answer back. The page queues the graphs; ``place`` writes the
answer beside the comp, ``<comp stem>_ai/<node>/<node>_<kind>.<frame>_<run>.png``, and names it relative to the comp,
so the node's ``results`` move with the comp's folder.

What each node asks for: matte = Paint's background removal (its matte), depth and relight = an image edit with
words, inpaint = fill (with words) or remove (without), upscale = the upscalers.
"""
from __future__ import annotations

import os
import secrets
import threading
import time
from types import SimpleNamespace

import numpy as np

from . import comp_io
from . import comp_model as M
from . import paint_generate as G
from . import paint_io as P

AI_KINDS = {"ai_matte": "matte", "ai_depth": "depth", "ai_relight": "relight", "ai_inpaint": "inpaint", "ai_upscale": "upscale"}
DEPTH_PROMPT = ("Turn this picture into a depth map: greyscale, near things white, far things black, smooth "
                "shading without texture or detail, exactly the same framing.")
RELIGHT_PROMPT = "Relight this picture: {prompt}. Keep everything else exactly as it is: the subjects, the objects, the framing."
MAX_JOBS = 8
_LOCK = threading.Lock()
_JOBS = {}


class AiError(ValueError):
    pass


def action_of(kind, prompt):
    """The Generate action and the words for an AI node."""
    words = str(prompt or "").strip()
    if kind == "matte":
        return "background", ""
    if kind == "depth":
        return "edit", DEPTH_PROMPT
    if kind == "relight":
        if not words:
            raise AiError("say how the light should be")
        return "edit", RELIGHT_PROMPT.format(prompt=words.rstrip("."))
    if kind == "inpaint":
        return ("fill", words) if words else ("remove", "")
    if kind == "upscale":
        return "upscale", ""
    raise AiError(f"not an AI node: {kind!r}")


def to_8bit(img):
    """A premultiplied linear picture as straight sRGB RGBA 8-bit (what a ComfyUI picture is)."""
    px = comp_io.still_pixels(img, "png")
    return np.clip(px * 255.0 + 0.5, 0, 255).astype(np.uint8)


def prepare(comp, comp_path, node_id, frame, sources, input_dir, *, ocio=None, wid=None, graph=None, tune=None,
            folder_paths=None, node_classes=None):
    """The filled-in workflow for one frame of an AI node: paint_generate's answer plus ``kind``."""
    comp, _ = M.normalize(comp)
    n = next((x for x in comp["nodes"] if x["id"] == node_id), None)
    if n is None:
        raise AiError(f"no node {node_id!r} in the comp")
    kind = AI_KINDS.get(n["type"])
    if not kind:
        raise AiError(f"{node_id} is not an AI node")
    ins = list(n.get("inputs") or []) + [None, None]
    if not ins[0]:
        raise AiError("nothing comes into the node: wire a picture into it")
    f = int(frame)
    memo = {}
    src = M.render_node(comp, ins[0], f, sources, 1.0, memo=memo, ocio=ocio)
    h, w = src.shape[:2]
    pic = to_8bit(src)
    sel = None
    if kind == "inpaint":
        if not ins[1]:
            raise AiError("wire the place to change into the mask input (its alpha)")
        m = M.conform(M.render_node(comp, ins[1], f, sources, 1.0, memo=memo, ocio=ocio), w, h)
        sel = np.clip(m[..., 3] * 255.0 + 0.5, 0, 255).astype(np.uint8)
        if not sel.any():
            raise AiError("the mask is empty at this frame")
    action, words = action_of(kind, n.get("prompt"))
    k = max(1, int(float(n.get("factor") or 2))) if kind == "upscale" else 2
    s = SimpleNamespace(doc=SimpleNamespace(w=w, h=h, selection=sel))
    res = G.prepare(s, None, action, input_dir, wid=wid, prompt=words, k=k, folder_paths=folder_paths,
                    node_classes=node_classes, graph=graph, tune=tune, picture=pic)
    rec = {"comp": os.path.abspath(comp_path), "node": node_id, "frame": f, "kind": kind, "w": w, "h": h, "k": k,
           "box": res["box"], "pic": pic if kind == "inpaint" else None, "at": time.time()}
    with _LOCK:
        _JOBS[res["job"]] = rec
        while len(_JOBS) > MAX_JOBS:
            _JOBS.pop(next(iter(_JOBS)))
    out = dict(res)
    out.update(kind=kind, action=action, frame=f)
    return out


def result_name(comp_path, node_id, kind, frame, run=""):
    """Where a result lies: (absolute path, the path relative to the comp's folder, with / between). Each run
    gets a name of its own (*run*), so a frame run again is never a cached picture of the run before, and an
    undo still finds the earlier one."""
    stem = os.path.basename(comp_path)
    stem = stem[: -len(M.SUFFIX)] if stem.lower().endswith(M.SUFFIX) else os.path.splitext(stem)[0]
    safe = G.safe_name(node_id) or "node"
    rel = f"{stem}_ai/{safe}/{safe}_{kind}.{int(frame):04d}{('_' + run) if run else ''}.png"
    return os.path.join(os.path.dirname(os.path.abspath(comp_path)), *rel.split("/")), rel


def place(job, result_path):
    """The answer of *job* written beside its comp: {file (relative to the comp), path, frame, node, kind}."""
    with _LOCK:
        rec = _JOBS.get(job)
    if not rec:
        raise AiError("that run is no longer known (the server restarted?) - run it again")
    px = P.image_pixels(result_path)
    w, h, kind = rec["w"], rec["h"], rec["kind"]
    if kind == "matte":
        out = G.matte_of(G._cover(px, w, h))
    elif kind == "depth":
        rgb = G._cover(px, w, h)[..., :3].astype(np.float32)
        out = np.clip(rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114 + 0.5, 0, 255).astype(np.uint8)
    elif kind == "upscale":
        out = np.ascontiguousarray(G._cover(px, w * rec["k"], h * rec["k"]))
    elif kind == "inpaint":
        bx, by, bw, bh = rec["box"]
        out = rec["pic"].copy()
        out[by:by + bh, bx:bx + bw] = G._cover(px, bw, bh)
        out[..., 3] = 255
    else:
        out = G._cover(px, w, h).copy()
        out[..., 3] = 255
    path, rel = result_name(rec["comp"], rec["node"], kind, rec["frame"], job[:6])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.part-{secrets.token_hex(4)}"
    with open(tmp, "wb") as fh:
        fh.write(P.png_bytes(out))
    os.replace(tmp, path)
    return {"file": rel, "path": path, "frame": rec["frame"], "node": rec["node"], "kind": kind}
