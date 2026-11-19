"""Matchmove's AI mattes: a mask over the whole shot from an AI workflow, frame by frame, as ONE ComfyUI job.

Two engines, both Paint's Generate built-ins run through ``paint_generate`` (the same slots, model checks, model
picks and downloads):

- ``objects``: SAM 3 by words ("person", "car", "water", "ground") - what it finds on each frame is white;
- ``background``: a background remover (RMBG, BiRefNet, BEN, the partner nodes) - the subject is white.

``prepare_batch`` reads each asked-for frame of the plate (the Matchmove routes' Plate: the same pixels the
tracker reads), hands it to ``paint_generate.prepare`` as the picture to work on, and lays the per-frame graphs into
one prompt with ``comp_ai.merge_graphs`` (the loaders and the text encoder are there once, so the model loads
once). The page queues it, waits for every frame's picture and hands them to ``place_batch``, which writes the
mattes as a grey PNG sequence at the plate's size in ``<input>/matchmove/mattes/<run>/matte.####.png`` (#### =
the plate's frame index from 0). A Matchmove mask names that sequence (``matchmove.clean_matte``): the tracker
then keeps features off it (an exclude mask) or gives them to an object, as for a drawn mask.

``sample`` reads a matte at the tracks' places: the AI ground uses it (SAM 3 asked for the ground on a few frames;
the tracks that stay on it are the ground's points).

No process is started; the workflows run in ComfyUI's own queue.
"""
from __future__ import annotations

import os
import secrets
import threading
import time
from types import SimpleNamespace

import numpy as np

from . import comp_ai as CA
from . import matchmove as MM
from . import paint_generate as G
from . import paint_io as P

ENGINES = {"objects": "select_objects", "background": "background"}
OBJECT_WORKFLOWS = ("sam3",)
MAX_FRAMES = 1000
MAX_RUNS = 8
_LOCK = threading.Lock()
_RUNS = {}


class MatteError(ValueError):
    pass


def _ids(engine):
    if engine == "objects":
        return list(OBJECT_WORKFLOWS)
    if engine == "background":
        return list(((G.comp_table().get("lists") or {}).get("matte") or {}).get("workflows") or [])
    raise MatteError(f"not a matte engine: {engine!r} (objects or background)")


def workflows_for(engine, folder_paths=None, node_classes=None):
    """{engine, action, workflows [Paint's items], choice}: what this ComfyUI can run for the engine now."""
    action = ENGINES.get(engine)
    ids = _ids(engine)
    if folder_paths is not None and not isinstance(folder_paths, G._Remembered):
        folder_paths = G._Remembered(folder_paths)
    items = []
    for wid in ids:
        e, _g = G._builtin(wid)
        if not e or action not in (e.get("actions") or []) or not G.installed(e, node_classes):
            continue
        items.append(G._entry_item(e, folder_paths, node_classes))
    return {"engine": engine, "action": action, "workflows": items, "choice": items[0]["id"] if items else None}


def pick_workflow(engine, wanted, node_classes=None):
    action = ENGINES.get(engine)
    usable = []
    for wid in _ids(engine):
        e, _g = G._builtin(wid)
        if e and action in (e.get("actions") or []) and G.installed(e, node_classes):
            usable.append(wid)
    if wanted and wanted in usable:
        return wanted
    if not usable:
        raise MatteError("this ComfyUI has none of the workflows for this (their node packs are not installed)")
    return usable[0]


def prepare_batch(picture, frames, input_dir, *, engine, prompt="", wid=None, graph=None, tune=None,
                  models=None, folder_paths=None, node_classes=None):
    """The mattes of these plate frames as ONE prompt: {run, graph, outputs {frame: node}, frames, skipped, workflow}.

    *picture(n)* is the plate's frame n as linear premultiplied RGBA float (``matchmove_routes.Plate.picture``)."""
    action = ENGINES.get(engine)
    if not action:
        raise MatteError(f"not a matte engine: {engine!r} (objects or background)")
    words = str(prompt or "").strip()
    if engine == "objects" and not words:
        raise MatteError("say what to find (person, car, water, sky ...)")
    want = sorted({int(f) for f in frames or [] if int(f) >= 0})
    if not want:
        raise MatteError("no frames to run")
    if len(want) > MAX_FRAMES:
        raise MatteError(f"at most {MAX_FRAMES} frames in one job (take every second or third frame)")
    if folder_paths is not None:
        folder_paths = G._Remembered(folder_paths)
    wid = pick_workflow(engine, wid, node_classes)
    run = secrets.token_hex(6)
    seed = secrets.randbelow(G.SEED_MAX + 1)
    graphs, outs, done, skipped = [], [], [], []
    size = None
    for f in want:
        try:
            img = picture(f)
        except Exception as e:  # noqa: BLE001 - a missing frame is left out and said
            skipped.append({"frame": f, "why": str(e) or "no picture"})
            continue
        if img is None:
            skipped.append({"frame": f, "why": "no picture"})
            continue
        pic = CA.to_8bit(img)
        h, w = pic.shape[:2]
        size = size or (w, h)
        s = SimpleNamespace(doc=SimpleNamespace(w=w, h=h, selection=None))
        res = G.prepare(s, None, action, input_dir, wid=wid, prompt=words, folder_paths=folder_paths,
                        node_classes=node_classes, graph=graph, tune=tune, picture=pic, models=models)
        g = res["graphs"][0]
        for nid, inp in G.detect_slots(g)["seeds"]:
            g[nid]["inputs"][inp] = seed
        out = g[res["output"]]
        if "filename_prefix" in (out.get("inputs") or {}):
            out["inputs"]["filename_prefix"] = f"matchmove/matte/{run}/matte.{f:04d}"
        graphs.append(g)
        outs.append(res["output"])
        done.append(f)
    if not graphs:
        raise MatteError(skipped[0]["why"] if skipped else "no frames to run")
    merged, out_ids = CA.merge_graphs(graphs, outs)
    with _LOCK:
        _RUNS[run] = {"engine": engine, "prompt": words, "size": size, "at": time.time(),
                      "folder": os.path.join(input_dir, "matchmove", "mattes", run)}
        while len(_RUNS) > MAX_RUNS:
            _RUNS.pop(next(iter(_RUNS)))
    return {"run": run, "graph": merged, "outputs": {str(f): o for f, o in zip(done, out_ids)}, "frames": done,
            "skipped": skipped, "engine": engine, "workflow": wid, "nodes": len(merged), "seed": seed,
            "width": size[0], "height": size[1]}


def run_record(run):
    with _LOCK:
        rec = _RUNS.get(str(run))
    if not rec:
        raise MatteError("that run is no longer known (the server restarted?) - run it again")
    return rec


def place_batch(run, results):
    """The workflow's pictures (*results*: {frame: path}) as the run's matte sequence: {pattern, frames, folder,
    width, height, covered {frame: share of the frame that is white}}."""
    rec = run_record(run)
    w, h = rec["size"]
    os.makedirs(rec["folder"], exist_ok=True)
    pattern = os.path.join(rec["folder"], "matte.####.png")
    frames, covered = [], {}
    for f, src in sorted(((int(a), b) for a, b in results.items()), key=lambda x: x[0]):
        px = P.image_pixels(src)
        m = G.matte_of(G._cover(px, w, h))
        path = MM.matte_path(pattern, f)
        tmp = f"{path}.part-{secrets.token_hex(4)}"
        with open(tmp, "wb") as fh:
            fh.write(P.png_bytes(np.ascontiguousarray(m)))
        os.replace(tmp, path)
        frames.append(f)
        covered[str(f)] = round(float((m >= 128).mean()), 4)
    if not frames:
        raise MatteError("the job gave no pictures")
    return {"pattern": pattern, "frames": frames, "folder": rec["folder"], "width": w, "height": h,
            "covered": covered, "engine": rec["engine"], "prompt": rec["prompt"]}


def sample(matte, points):
    """How often each track lies on a matte: *points* {frame: [[id, x, y], ...]} -> {id: [frames on it, frames
    seen]}. Only the matte's own frames count (not the ones that stand in for others)."""
    m = MM.clean_matte(matte)
    if not m:
        raise MatteError("not a matte")
    have = set(m["frames"])
    votes = {}
    for f, rows in (points or {}).items():
        try:
            f = int(f)
        except (TypeError, ValueError):
            continue
        if f not in have or not isinstance(rows, list):
            continue
        ids, xy = [], []
        for r in rows[:5000]:
            try:
                ids.append(str(r[0]))
                xy.append([float(r[1]), float(r[2])])
            except (TypeError, ValueError, IndexError):
                continue
        if not ids:
            continue
        hit = MM.matte_hit(m, f, xy)
        for i, on in zip(ids, hit):
            v = votes.setdefault(i, [0, 0])
            v[1] += 1
            v[0] += int(bool(on))
    return votes
