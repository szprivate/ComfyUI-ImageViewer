"""Comp's AI nodes (matte, depth, relight, inpaint, upscale): one frame through a ComfyUI workflow.

The workflows are Paint's Generate ones (``paint_generate``: the built-ins, the user's choice per action, the
same slots and model checks). ``prepare`` renders what goes into the node at that frame (``comp_model``, full
size), hands it to ``paint_generate.prepare`` as the picture to work on - an inpaint's mask input as the
selection - and keeps what it needs to lay the answer back. The page queues the graphs; ``place`` writes the
answer beside the comp, ``<comp stem>_ai/<node>/<node>_<kind>.<frame>_<run>.png``, and names it relative to the comp,
so the node's ``results`` move with the comp's folder.

What each node asks for: matte = Paint's background removal (its matte), depth and relight = an image edit with
words, inpaint = fill (with words) or remove (without), upscale = the upscalers.

A frame range is ONE ComfyUI job (``prepare_batch``): every frame's input is rendered and filled into the workflow
as for one frame, then the per-frame graphs are laid into one prompt (``merge_graphs``) in which every node that is
the same in all of them - the model loaders, the text encoders - is there once, so the models load once and the
queue holds one entry. Each frame keeps its own output node; ``place_batch`` writes the answers as a PNG sequence,
``<comp stem>_ai/<node>/<run>/<node>_<kind>.####.png``, which the node reads back frame by frame (``results``).
All frames of a run share one seed (less flicker between frames).

A node may name its own workflow (``workflow``: an id of Paint's table for its action, else Paint's choice) and
its own model files (``models``: {"<workflow node>.<input>": file}, checked against ComfyUI's model folders by
``paint_generate.apply_models``); ``models_for`` lists what can be picked.
"""
from __future__ import annotations

import json
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
MAX_BATCH_FRAMES = 1000
MAX_BATCH_BYTES = 64 * 1024 * 1024
_LOCK = threading.Lock()
_JOBS = {}
_BATCHES = {}


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


def _ai_node(comp, node_id):
    comp, _ = M.normalize(comp)
    comp = M.G.flatten(comp)   # an AI node inside a group is named by its flat id, "<group>/<id>"
    n = next((x for x in comp["nodes"] if x["id"] == node_id), None)
    if n is None:
        raise AiError(f"no node {node_id!r} in the comp")
    kind = AI_KINDS.get(n["type"])
    if not kind:
        raise AiError(f"{node_id} is not an AI node")
    ins = list(n.get("inputs") or []) + [None, None]
    if not ins[0]:
        raise AiError("nothing comes into the node: wire a picture into it")
    if kind == "inpaint" and not ins[1]:
        raise AiError("wire the place to change into the mask input (its alpha)")
    return comp, n, kind, ins


def _frame_input(comp, kind, ins, f, sources, ocio):
    """(picture uint8 RGBA, selection uint8 or None) of what comes into the node at frame *f*."""
    memo = {}
    src = M.render_node(comp, ins[0], f, sources, 1.0, memo=memo, ocio=ocio)
    h, w = src.shape[:2]
    pic = to_8bit(src)
    sel = None
    if kind == "inpaint":
        m = M.conform(M.render_node(comp, ins[1], f, sources, 1.0, memo=memo, ocio=ocio), w, h)
        sel = np.clip(m[..., 3] * 255.0 + 0.5, 0, 255).astype(np.uint8)
        if not sel.any():
            raise AiError("the mask is empty at this frame")
    return pic, sel


def _generate(kind, n, pic, sel, input_dir, *, wid, graph, tune, models, folder_paths, node_classes):
    w, h = pic.shape[1], pic.shape[0]
    action, words = action_of(kind, n.get("prompt"))
    k = max(1, int(float(n.get("factor") or 2))) if kind == "upscale" else 2
    s = SimpleNamespace(doc=SimpleNamespace(w=w, h=h, selection=sel))
    res = G.prepare(s, None, action, input_dir, wid=wid, prompt=words, k=k, folder_paths=folder_paths,
                    node_classes=node_classes, graph=graph, tune=tune, picture=pic, models=models)
    return res, action, k


def _node_models(n, models):
    """The node's own model picks, or the ones the page sent."""
    got = models if isinstance(models, dict) else n.get("models")
    if not isinstance(got, dict):
        return None
    return {str(a): str(b) for a, b in got.items() if isinstance(b, str) and b}


def prepare(comp, comp_path, node_id, frame, sources, input_dir, *, ocio=None, wid=None, graph=None, tune=None,
            folder_paths=None, node_classes=None, models=None):
    """The filled-in workflow for one frame of an AI node: paint_generate's answer plus ``kind``."""
    comp, n, kind, ins = _ai_node(comp, node_id)
    f = int(frame)
    pic, sel = _frame_input(comp, kind, ins, f, sources, ocio)
    h, w = pic.shape[:2]
    res, action, k = _generate(kind, n, pic, sel, input_dir, wid=wid or n.get("workflow") or None, graph=graph,
                               tune=tune, models=_node_models(n, models), folder_paths=folder_paths,
                               node_classes=node_classes)
    rec = {"comp": os.path.abspath(comp_path), "node": node_id, "frame": f, "kind": kind, "w": w, "h": h, "k": k,
           "box": res["box"], "pic": pic if kind == "inpaint" else None, "at": time.time()}
    with _LOCK:
        _JOBS[res["job"]] = rec
        while len(_JOBS) > MAX_JOBS:
            _JOBS.pop(next(iter(_JOBS)))
    out = dict(res)
    out.update(kind=kind, action=action, frame=f)
    return out


# ── a frame range as one job ─────────────────────────────────────────────────

def _is_link(x, graph):
    return (isinstance(x, list) and len(x) == 2 and isinstance(x[1], int) and not isinstance(x[1], bool)
            and str(x[0]) in graph)


def _order(graph):
    """The node ids of an API graph, each after the nodes it reads (a loop is an error)."""
    out, state = [], {}

    def visit(k):
        if state.get(k) == 2:
            return
        if state.get(k) == 1:
            raise AiError("the workflow has a loop")
        state[k] = 1
        for x in (graph[k].get("inputs") or {}).values():
            if _is_link(x, graph):
                visit(str(x[0]))
        state[k] = 2
        out.append(k)

    for k in sorted(graph, key=lambda k: (0, int(k)) if str(k).isdigit() else (1, str(k))):
        visit(str(k))
    return out


def merge_graphs(graphs, outputs):
    """Several filled-in API graphs as ONE prompt: (graph, [the output node's id of each]).

    A node whose class and inputs (its links counted by what they lead to) are the same in two graphs is there
    once: the loaders, the text encoders and whatever only they feed. What differs per frame (the picture, what is
    made from it) and every output node is there per frame."""
    merged, canon, outs = {}, {}, []
    for g, out_id in zip(graphs, outputs):
        g = {str(k): v for k, v in g.items()}
        local = {}
        for k in _order(g):
            v = g[k]
            ins = {}
            for name, x in (v.get("inputs") or {}).items():
                ins[name] = [local[str(x[0])], x[1]] if _is_link(x, g) else x
            node = {"class_type": v["class_type"], "inputs": ins}
            if v.get("_meta"):
                node["_meta"] = v["_meta"]
            sig = None if (k == str(out_id) or v["class_type"] in G.OUTPUTS) else \
                json.dumps([v["class_type"], ins], sort_keys=True, default=str)
            if sig is not None and sig in canon:
                local[k] = canon[sig]
                continue
            nid = str(len(merged) + 1)
            merged[nid] = node
            local[k] = nid
            if sig is not None:
                canon[sig] = nid
        outs.append(local[str(out_id)])
    return merged, outs


def prepare_batch(comp, comp_path, node_id, frames, sources, input_dir, *, ocio=None, wid=None, graph=None,
                  tune=None, folder_paths=None, node_classes=None, models=None):
    """A frame range of an AI node as one ComfyUI job: {run, graph, outputs {frame: output node id}, frames,
    skipped [{frame, why}], kind, action, nodes, workflow}. The page queues ``graph`` once and hands the outputs'
    pictures to :func:`place_batch`."""
    comp, n, kind, ins = _ai_node(comp, node_id)
    want = sorted({int(f) for f in frames or []})
    if not want:
        raise AiError("no frames to run")
    if len(want) > MAX_BATCH_FRAMES:
        raise AiError(f"at most {MAX_BATCH_FRAMES} frames in one job (set frames per job lower)")
    if folder_paths is not None:
        folder_paths = G._Remembered(folder_paths)     # every frame asks about the same model files
    picks = _node_models(n, models)
    wid = wid or n.get("workflow") or None
    run = secrets.token_hex(6)
    plates = os.path.join(input_dir, "paint", f"compai_{run}")
    seed = secrets.randbelow(G.SEED_MAX + 1)
    graphs, outs, done, skipped, per = [], [], [], [], {}
    action = None
    for f in want:
        try:
            pic, sel = _frame_input(comp, kind, ins, f, sources, ocio)
        except AiError as e:
            skipped.append({"frame": f, "why": str(e)})
            continue
        h, w = pic.shape[:2]
        res, action, k = _generate(kind, n, pic, sel, input_dir, wid=wid, graph=graph, tune=tune, models=picks,
                                   folder_paths=folder_paths, node_classes=node_classes)
        g = res["graphs"][0]
        for nid, inp in G.detect_slots(g)["seeds"]:
            g[nid]["inputs"][inp] = seed
        out = g[res["output"]]
        if "filename_prefix" in (out.get("inputs") or {}):
            out["inputs"]["filename_prefix"] = f"comp/ai/{run}/{G.safe_name(node_id) or 'node'}.{f:04d}"
        plate = None
        if kind == "inpaint":
            os.makedirs(plates, exist_ok=True)
            plate = os.path.join(plates, f"plate.{f:04d}.png")
            with open(plate, "wb") as fh:
                fh.write(P.png_bytes(pic))
        per[f] = {"w": w, "h": h, "k": k, "box": res["box"], "plate": plate}
        graphs.append(g)
        outs.append(res["output"])
        done.append(f)
    if not graphs:
        raise AiError(skipped[0]["why"] if skipped else "no frames to run")
    merged, out_ids = merge_graphs(graphs, outs)
    if len(json.dumps(merged)) > MAX_BATCH_BYTES:
        raise AiError("the job is too large: set frames per job lower")
    rec = {"comp": os.path.abspath(comp_path), "node": node_id, "kind": kind, "frames": per, "at": time.time(),
           "outputs": dict(zip(out_ids, done))}
    with _LOCK:
        _BATCHES[run] = rec
        while len(_BATCHES) > MAX_JOBS:
            _BATCHES.pop(next(iter(_BATCHES)))
    return {"run": run, "graph": merged, "outputs": {str(f): o for f, o in zip(done, out_ids)}, "frames": done,
            "skipped": skipped, "kind": kind, "action": action, "nodes": len(merged), "per_frame": len(graphs[0]),
            "seed": seed}


def models_for(action, folder_paths, *, wid=None, graph=None):
    """What can be picked for a workflow of *action* (``wid``, else Paint's choice): {workflow, inputs}."""
    if action not in G.ACTIONS:
        raise AiError(f"unknown action {action!r}")
    wid = wid or G.choices()[action]
    if wid == G.AGENT:
        return {"workflow": wid, "inputs": []}
    _e, g = G.resolve_workflow(action, wid, graph)
    return {"workflow": wid, "inputs": G.model_inputs(g, folder_paths)}


def result_name(comp_path, node_id, kind, frame, run=""):
    """Where a result lies: (absolute path, the path relative to the comp's folder, with / between). Each run
    gets a name of its own (*run*), so a frame run again is never a cached picture of the run before, and an
    undo still finds the earlier one."""
    stem = os.path.basename(comp_path)
    stem = stem[: -len(M.SUFFIX)] if stem.lower().endswith(M.SUFFIX) else os.path.splitext(stem)[0]
    safe = G.safe_name(node_id) or "node"
    rel = f"{stem}_ai/{safe}/{safe}_{kind}.{int(frame):04d}{('_' + run) if run else ''}.png"
    return os.path.join(os.path.dirname(os.path.abspath(comp_path)), *rel.split("/")), rel


def _answer(rec, px, plate=None):
    """The workflow's picture as the node's result for one frame (uint8)."""
    w, h, kind = rec["w"], rec["h"], rec["kind"]
    if kind == "matte":
        return G.matte_of(G._cover(px, w, h))
    if kind == "depth":
        rgb = G._cover(px, w, h)[..., :3].astype(np.float32)
        return np.clip(rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114 + 0.5, 0, 255).astype(np.uint8)
    if kind == "upscale":
        return np.ascontiguousarray(G._cover(px, w * rec["k"], h * rec["k"]))
    if kind == "inpaint":
        bx, by, bw, bh = rec["box"]
        out = (plate if plate is not None else rec["pic"]).copy()
        out[by:by + bh, bx:bx + bw] = G._cover(px, bw, bh)
        out[..., 3] = 255
        return out
    out = G._cover(px, w, h).copy()
    out[..., 3] = 255
    return out


def _write(path, px):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.part-{secrets.token_hex(4)}"
    with open(tmp, "wb") as fh:
        fh.write(P.png_bytes(px))
    os.replace(tmp, path)


def place(job, result_path):
    """The answer of *job* written beside its comp: {file (relative to the comp), path, frame, node, kind}."""
    with _LOCK:
        rec = _JOBS.get(job)
    if not rec:
        raise AiError("that run is no longer known (the server restarted?) - run it again")
    out = _answer(rec, P.image_pixels(result_path))
    path, rel = result_name(rec["comp"], rec["node"], rec["kind"], rec["frame"], job[:6])
    _write(path, out)
    return {"file": rel, "path": path, "frame": rec["frame"], "node": rec["node"], "kind": rec["kind"]}


def sequence_name(comp_path, node_id, kind, run, frame):
    """A batch's frame: (absolute path, relative to the comp) in ``<stem>_ai/<node>/<run>/<node>_<kind>.####.png``."""
    stem = os.path.basename(comp_path)
    stem = stem[: -len(M.SUFFIX)] if stem.lower().endswith(M.SUFFIX) else os.path.splitext(stem)[0]
    safe = G.safe_name(node_id) or "node"
    rel = f"{stem}_ai/{safe}/{run}/{safe}_{kind}.{int(frame):04d}.png"
    return os.path.join(os.path.dirname(os.path.abspath(comp_path)), *rel.split("/")), rel


def batch_record(run):
    with _LOCK:
        rec = _BATCHES.get(str(run))
    if not rec:
        raise AiError("that run is no longer known (the server restarted?) - run it again")
    return rec


def place_batch(run, results):
    """A batch's answers (*results*: {frame: the workflow picture's path}) written as a PNG sequence beside the
    comp: {frames {frame: file relative to the comp}, paths {frame: absolute}, node, kind, folder}."""
    rec = batch_record(run)
    frames, paths = {}, {}
    for f, src in sorted(((int(a), b) for a, b in results.items()), key=lambda x: x[0]):
        per = rec["frames"].get(f)
        if not per:
            continue
        one = dict(per, kind=rec["kind"])
        plate = P.image_pixels(per["plate"]) if per.get("plate") else None
        out = _answer(one, P.image_pixels(src), plate)
        path, rel = sequence_name(rec["comp"], rec["node"], rec["kind"], run, f)
        _write(path, out)
        frames[str(f)], paths[str(f)] = rel, path
    if not frames:
        raise AiError("the job gave no pictures")
    first = next(iter(paths.values()))
    return {"frames": frames, "paths": paths, "node": rec["node"], "kind": rec["kind"],
            "folder": os.path.dirname(first)}
