"""Comp's VFX nodes: the History's Convert Footage workflows (LTX-2.5, ``clip_vfx``) on a comp node.

Alpha matte, SDR to HDR, Reframe and Upscale each work on a whole clip (8n + 1 frames), so the node is never run
live: Render makes its result once, over the comp's range, and the node reads that back like a Read.

What goes through the workflow (the node's ``prerender``):

    on   what comes into the node is rendered first (the comp up to there, full size, frames 0 .. used - 1) into a
         film in ``<input>/clip_vfx/``, and that film is the clip; the result's frame k is comp frame k
    off  the film of the Read coming in (through Dots and disabled nodes only) is used as it is - faster, and the
         plate's own pixels; the result's frame k is the Read's file frame k, so it takes the Read's offset

``prepare`` hands the page ``clip_vfx.prepare``'s graphs (the page queues them, as the History's dialog does);
``finish`` takes the outputs, moves the result beside the comp (``<comp stem>_vfx/<node>/``: the film, or for
HDR the ACEScg EXR sequence) and answers the node's ``results``: {file (relative to the comp), offset, first,
last, width, height, colorspace, frames, kind, prerender}. The page adds the key it was made for.
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import threading
import time

from . import clip_vfx as V
from . import comp_io
from . import comp_model as M

VFX_KINDS = {"vfx_alpha": "alpha", "vfx_hdr": "hdr", "vfx_reframe": "reframe", "vfx_upscale": "upscale"}
PASSING = {"dot"}
MAX_JOBS = 16
_LOCK = threading.Lock()
_JOBS = {}


class VfxNodeError(ValueError):
    def __init__(self, msg, status=400, **extra):
        super().__init__(msg)
        self.status = status
        self.extra = extra


def options_of(n):
    """The clip_vfx options of a VFX node's settings."""
    kind = VFX_KINDS[n["type"]]
    out = {}
    if kind == "reframe":
        out = {"width": n.get("width") or 1920, "height": n.get("height") or 1088, "prompt": n.get("prompt") or ""}
    elif kind == "upscale":
        out = {"mode": n.get("mode") or "refine", "size": n.get("size") or "FullHD", "prompt": n.get("prompt") or ""}
    return V.clean_options(kind, out)


def plate_of(comp, nid):
    """The Read a node's input is, through Dots and disabled nodes; None for anything else."""
    seen = set()
    while nid and nid not in seen:
        seen.add(nid)
        n = next((x for x in comp["nodes"] if x["id"] == nid), None)
        if n is None:
            return None
        if n["type"] == "read" and not n.get("disable"):
            return n
        if n["type"] in PASSING or n.get("disable"):
            ins = n.get("inputs") or []
            nid = ins[0] if ins else None
            continue
        return None
    return None


def frames_used(kind, frames):
    """How many frames from the first the workflows take of a clip of *frames* frames."""
    runs = V.plan(frames, V.ALPHA_CHUNK if kind == "alpha" else None)
    return sum(n for _a, n in runs)


def node_dir(comp_path, node_id):
    """(absolute folder, the same relative to the comp's folder) where a node's results lie."""
    from . import paint_generate as G
    stem = os.path.basename(comp_path)
    stem = stem[: -len(M.SUFFIX)] if stem.lower().endswith(M.SUFFIX) else os.path.splitext(stem)[0]
    safe = G.safe_name(node_id) or "node"
    rel = f"{stem}_vfx/{safe}"
    return os.path.join(os.path.dirname(os.path.abspath(comp_path)), *rel.split("/")), rel


def render_input(comp, nid, frames, sources, path, *, ocio=None, fps=24.0):
    """Frames 0 .. frames - 1 of node *nid* (full size) as an H.264 film at *path* (plain sRGB, over black)."""
    from . import export_rules
    size = M.format_at(comp, nid)
    how = export_rules.video_settings("mp4", None, "high")
    w = comp_io.VideoWriter(path, how, fps, size["width"], size["height"])
    ok = False
    try:
        for f in range(frames):
            img = M.render_node(comp, nid, f, sources, 1.0, memo={}, ocio=ocio)
            w.add(M.conform(img, size["width"], size["height"]))
        ok = True
    finally:
        w.close(keep=ok)
    return path


def prepare(comp, comp_path, node_id, sources, input_dir, output_dir, *, ocio=None, folder_paths=None,
            node_classes=None, may_use=None, render=None):
    """Everything the page queues for a VFX node: clip_vfx's answer plus {kind, first, last, prerender, node}.
    Raises VfxNodeError (409 with ``missing`` when a model or node is not here, checked before anything is
    written)."""
    comp, _ = M.normalize(comp)
    comp = M.G.flatten(comp)
    n = next((x for x in comp["nodes"] if x["id"] == node_id), None)
    if n is None:
        raise VfxNodeError(f"no node {node_id!r} in the comp")
    kind = VFX_KINDS.get(n["type"])
    if not kind:
        raise VfxNodeError(f"{node_id} is not a VFX node")
    ins = list(n.get("inputs") or [])
    if not ins or not ins[0]:
        raise VfxNodeError("nothing comes into the node: wire a picture into it")
    opts = options_of(n)
    g0, _save = V.graph_for(kind, opts, "check.mp4", "ltx_vfx/check", "ltx_vfx/check" if kind == "hdr" else "")
    miss = V.missing(g0, folder_paths, node_classes)
    if miss:
        raise VfxNodeError("the workflow needs what is not here", 409, missing=miss)
    frames_total = int(comp["format"]["frames"])
    fps = float(comp["format"].get("fps") or 24)
    pre = (n.get("prerender") or "on") != "off"
    made = None
    if pre:
        if frames_total < V.MIN_FRAMES:
            raise VfxNodeError(f"the comp is {frames_total} frames long; LTX needs at least {V.MIN_FRAMES}")
        used = frames_used(kind, frames_total)
        folder = os.path.join(input_dir, "clip_vfx")
        os.makedirs(folder, exist_ok=True)
        made = os.path.join(folder, f"{V.stem_of(comp_path)}_{V.stem_of(node_id)}_{secrets.token_hex(4)}.mp4")
        (render or render_input)(comp, ins[0], used, sources, made, ocio=ocio, fps=fps)
        source, offset, first = made, 0, 0
    else:
        plate = plate_of(comp, ins[0])
        path = sources.path_of(plate) if plate else ""
        info = sources.info(plate)[1] if plate else {}
        if not plate or info.get("kind") != "video":
            raise VfxNodeError("prerender is off, so a Read of a film has to come into the node (with nothing but "
                               "Dots between); switch prerender on to send what comes in")
        if may_use and not may_use(path):
            raise VfxNodeError(f"the viewer may not read {os.path.basename(path)}", 403)
        source, offset = path, int(plate.get("offset") or 0)
        first = offset          # the film's frame 0 is shown at comp frame offset
    try:
        prep = V.prepare(source, kind, opts, input_dir, output_dir, folder_paths=folder_paths,
                         node_classes=node_classes, may_use=may_use)
    except Exception:
        if made:
            _remove(made)
        raise
    last = first + prep["used"] - 1
    rec = {"comp": os.path.abspath(comp_path), "node": node_id, "kind": kind, "offset": offset,
           "first": max(0, first), "last": min(frames_total - 1, last), "prerender": pre, "made": made,
           "at": time.time()}
    with _LOCK:
        _JOBS[prep["job"]] = rec
        while len(_JOBS) > MAX_JOBS:
            _JOBS.pop(next(iter(_JOBS)))
    out = dict(prep)
    out.update(kind=kind, node=node_id, first=rec["first"], last=rec["last"], prerender=pre)
    if rec["first"] > rec["last"]:
        raise VfxNodeError("the film's frames lie outside the comp's range (the Read's offset)")
    return out


def _remove(p):
    try:
        os.remove(p)
    except OSError:
        pass


_NUM = re.compile(r"^(.*?)(\d+)(\.exr)$", re.I)


def sequence_pattern(names):
    """A '#' pattern for numbered EXR names (one prefix, one width), or None."""
    parts = [_NUM.match(n) for n in names]
    if not parts or not all(parts):
        return None
    pre, width = parts[0].group(1), len(parts[0].group(2))
    if any(p.group(1) != pre or len(p.group(2)) != width for p in parts):
        return None
    return f"{pre}{'#' * width}{parts[0].group(3)}"


def _aces_name():
    """The OCIO name of ACEScg in the config, else "auto" (an EXR is then read as the working linear)."""
    try:
        from . import comp_ocio
        cfg, st = comp_ocio._cfg()
        if cfg is not None:
            for name in ("ACES - ACEScg", "ACEScg"):
                if name in st["names"]:
                    return name
    except Exception:  # noqa: BLE001 - no OCIO
        pass
    return "auto"


def finish(job, results, output_dir, *, may_use=None, join_films=None, probe=None):
    """The results of *job* beside its comp: the node's ``results`` (see the module's doc)."""
    with _LOCK:
        rec = _JOBS.get(job)
    if rec is None:
        raise VfxNodeError("that run is no longer known (the server restarted?) - render it again", 404)
    try:
        res = V.finish(job, results, output_dir, may_use=may_use, join_films=join_films)
    finally:
        if rec.get("made"):
            _remove(rec["made"])
            rec["made"] = None
    folder, rel = node_dir(rec["comp"], rec["node"])
    os.makedirs(folder, exist_ok=True)
    kind, tag = rec["kind"], secrets.token_hex(3)
    probe = probe or V.probe
    info = probe(res["path"])
    width, height, count = info["width"], info["height"], info["frames"]
    exr = [p for p in (res.get("exr") or []) if os.path.isfile(p)]
    pattern = sequence_pattern([os.path.basename(p) for p in exr]) if exr else None
    if kind == "hdr" and pattern:
        sub = f"{V.stem_of(rec['node'])}_hdr_{tag}"
        dst = os.path.join(folder, sub)
        os.makedirs(dst, exist_ok=True)
        for p in exr:
            shutil.move(p, os.path.join(dst, os.path.basename(p)))
        try:
            os.rmdir(os.path.dirname(exr[0]))
        except OSError:
            pass
        file = f"{rel}/{sub}/{pattern}"
        colorspace, count = _aces_name(), len(exr)
    else:
        name = f"{V.stem_of(rec['node'])}_{kind}_{tag}{os.path.splitext(res['path'])[1] or '.mp4'}"
        shutil.move(res["path"], os.path.join(folder, name))
        file = f"{rel}/{name}"
        colorspace = "linear" if kind == "alpha" else "srgb"
    # A Read counts a sequence's frames from its first number, as a film's from 0: the same offset serves both.
    first = rec["first"]
    last = min(rec["last"], first + max(1, count) - 1)
    return {"file": file, "offset": rec["offset"], "first": first,
            "last": last, "width": width, "height": height, "colorspace": colorspace, "frames": count, "kind": kind,
            "prerender": rec["prerender"], "node": rec["node"]}
