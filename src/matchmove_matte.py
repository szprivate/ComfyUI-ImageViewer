"""Matchmove's AI mattes: a mask over the whole shot from an AI workflow, frame by frame, as ONE ComfyUI job.

Two engines, both Paint's Generate built-ins run through ``paint_generate`` (the same slots, model checks, model
picks and downloads):

- ``objects``: SAM 3 by words ("person", "car", "water", "ground") - what it finds on each frame is white;
- ``background``: a background remover (RMBG, BiRefNet, BEN, the partner nodes) - the subject is white;
- ``depth``: Comp's depth models that answer depth as it is (Depth Anything 3; the Metric one in metres) - not a
  matte: ``depth_points`` turns each frame's depth, scaled onto the solved tracks, into points of the solve's own
  world, which the page finds the ground among (a floor with no tracks on it still has depth) and, from the
  Metric model, the size of a scene unit in metres.

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

ENGINES = {"objects": "select_objects", "background": "background", "depth": "depth"}
OBJECT_WORKFLOWS = ("sam3",)
METRIC_WORKFLOWS = ("comp_da3_metric",)   # depth in metres
DEPTH_STEP = 6                            # every 6th plate pixel of a depth map becomes a point
DEPTH_MOST = 4000                         # points a frame at most
DEPTH_MIN_TRACKS = 6                      # solved tracks a frame needs to scale its depth
MAX_FRAMES = 1000
MAX_RUNS = 8
MIN_WORK_SCALE = 0.1   # the smallest share of the plate the mask / depth models may be run at
_LOCK = threading.Lock()
_RUNS = {}


class MatteError(ValueError):
    pass


def _ids(engine):
    if engine == "objects":
        return list(OBJECT_WORKFLOWS)
    if engine == "background":
        return list(((G.comp_table().get("lists") or {}).get("matte") or {}).get("workflows") or [])
    if engine == "depth":
        # only the models that answer depth as it is: the ones scaled per frame (near white) cannot be put in space
        ids = list(((G.comp_table().get("lists") or {}).get("depth") or {}).get("workflows") or [])
        return [w for w in ids if (G._builtin(w)[0] or {}).get("depth") != "near_white"]
    raise MatteError(f"not a matte engine: {engine!r} (objects, background or depth)")


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


def work_scale(scale):
    """The share of the plate's size the models are run at: 1 (the plate), or less down to MIN_WORK_SCALE."""
    try:
        s = float(scale if scale is not None else 1)
    except (TypeError, ValueError):
        raise MatteError("'scale' must be a number (1 = the plate's size, 0.5 = half)") from None
    if not (MIN_WORK_SCALE <= s <= 1):
        raise MatteError(f"'scale' must lie between {MIN_WORK_SCALE} and 1")
    return s


def shrink(pic, scale):
    """An 8-bit RGBA frame at *scale* of its size (Lanczos), at least 64 px a side; the frame itself at 1."""
    if scale >= 1:
        return pic
    from PIL import Image
    h, w = pic.shape[:2]
    nw, nh = max(64, int(round(w * scale))), max(64, int(round(h * scale)))
    if (nw, nh) == (w, h):
        return pic
    return np.asarray(Image.fromarray(pic, "RGBA").resize((nw, nh), Image.LANCZOS))


def prepare_batch(picture, frames, input_dir, *, engine, prompt="", wid=None, graph=None, tune=None,
                  models=None, folder_paths=None, node_classes=None, scale=1):
    """The mattes of these plate frames as ONE prompt: {run, graph, outputs {frame: node}, frames, skipped, workflow}.

    *picture(n)* is the plate's frame n as linear premultiplied RGBA float (``matchmove_routes.Plate.picture``).
    *scale* < 1 runs the models on a smaller copy of each frame; the answers are brought back to the plate's size
    (``place_batch``, ``depth_points``), so only the work and the detail change."""
    scale = work_scale(scale)
    action = ENGINES.get(engine)
    if not action:
        raise MatteError(f"not a matte engine: {engine!r} (objects, background or depth)")
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
    size = work = None
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
        pic = shrink(pic, scale)
        h, w = pic.shape[:2]
        work = work or (w, h)
        s = SimpleNamespace(doc=SimpleNamespace(w=w, h=h, selection=None))
        res = G.prepare(s, None, action, input_dir, wid=wid, prompt=words, folder_paths=folder_paths,
                        node_classes=node_classes, graph=graph, tune=tune, picture=pic, models=models)
        g = res["graphs"][0]
        for nid, inp in G.detect_slots(g)["seeds"]:
            g[nid]["inputs"][inp] = seed
        out = g[res["output"]]
        if "filename_prefix" in (out.get("inputs") or {}):
            kind = "depth" if engine == "depth" else "matte"
            out["inputs"]["filename_prefix"] = f"matchmove/{kind}/{run}/{kind}.{f:04d}"
        graphs.append(g)
        outs.append(res["output"])
        done.append(f)
    if not graphs:
        raise MatteError(skipped[0]["why"] if skipped else "no frames to run")
    merged, out_ids = CA.merge_graphs(graphs, outs)
    with _LOCK:
        _RUNS[run] = {"engine": engine, "prompt": words, "size": size, "at": time.time(), "workflow": wid,
                      "scale": scale, "work": work,
                      "folder": os.path.join(input_dir, "matchmove", "mattes", run)}
        while len(_RUNS) > MAX_RUNS:
            _RUNS.pop(next(iter(_RUNS)))
    return {"run": run, "graph": merged, "outputs": {str(f): o for f, o in zip(done, out_ids)}, "frames": done,
            "skipped": skipped, "engine": engine, "workflow": wid, "nodes": len(merged), "seed": seed,
            "width": size[0], "height": size[1], "scale": scale, "work_width": work[0], "work_height": work[1]}


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
    if rec["engine"] == "depth":
        raise MatteError("a depth run is read with depth_points, not placed as mattes")
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


def _resize(a, w, h):
    """A float map brought to w x h, bilinear at pixel centres (the depth models answer at their own size)."""
    ph, pw = a.shape[:2]
    if (pw, ph) == (w, h):
        return a.astype(np.float32)
    ys = np.clip((np.arange(h) + 0.5) * ph / h - 0.5, 0, ph - 1)
    xs = np.clip((np.arange(w) + 0.5) * pw / w - 0.5, 0, pw - 1)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, ph - 1), np.minimum(x0 + 1, pw - 1)
    fy, fx = (ys - y0)[:, None], (xs - x0)[None, :]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return (top * (1 - fy) + bot * fy).astype(np.float32)


def _depth_at(d, u, v):
    """The median depth of the 3 x 3 pixels round (u, v), 0 off the map or where it has none."""
    h, w = d.shape
    x, y = int(u), int(v)
    if not (0 <= x < w and 0 <= y < h):
        return 0.0
    win = d[max(0, y - 1):y + 2, max(0, x - 1):x + 2]
    win = win[np.isfinite(win) & (win > 0)]
    return float(np.median(win)) if win.size else 0.0


def scale_depth(d, cam, tracks):
    """The solve's depth over the model's at the tracks: {scale, spread, tracks}, or None with too few.

    *cam* {R, t} (x_cam = R X + t, the solve's axes); *tracks* [[u, v, X0, X1, X2], ...] - the solved tracks seen
    on that frame, at their plate pixels. The solve's camera-space z over the model's depth there, the median of
    them (a depth model is right up to one scale per frame; a few tracks on the sky or a reflection do not move
    a median); spread = the median of how far each is off it, as a share."""
    R, t = np.asarray(cam["R"], float), np.asarray(cam["t"], float)
    ratios = []
    for r in tracks:
        try:
            u, v, X = float(r[0]), float(r[1]), np.asarray(r[2:5], float)
        except (TypeError, ValueError, IndexError):
            continue
        zs = float((R @ X + t)[2])
        zm = _depth_at(d, u, v)
        if zs > 0 and zm > 0:
            ratios.append(zs / zm)
    if len(ratios) < DEPTH_MIN_TRACKS:
        return None
    ratios = np.asarray(ratios)
    k = float(np.median(ratios))
    return {"scale": k, "spread": float(np.median(np.abs(ratios / k - 1))), "tracks": len(ratios)}


def depth_points(run, results, cams, tracks, *, focal, center, lens=None, step=DEPTH_STEP, most=DEPTH_MOST):
    """A depth job's frames as points of the solve's world: {points [[x, y, z]], frames [{frame, scale, spread,
    tracks, points}], skipped, metric, metres_per_unit, workflow}.

    *results* {frame: path of the model's EXR}; *cams* {frame: {R, t}}; *tracks* {frame: [[u, v, X0, X1, X2]]}.
    Each frame's depth is scaled onto its solved tracks (``scale_depth``), then every *step*-th pixel goes out
    along its ray (the plate's pixel through the lens to where it would be without it, then the solve's focal and
    centre) to that depth and back into the world. The farthest 5 % (sky, haze) are left out. From a metric model
    a scene unit is ``1 / scale`` metres (the median over the frames)."""
    from . import comp_ai as CA
    rec = run_record(run)
    if rec["engine"] != "depth":
        raise MatteError("not a depth run")
    w, h = rec["size"]
    fx = float(focal)
    c = np.asarray(center if center else [w / 2, h / 2], float)
    gy, gx = np.mgrid[step / 2:h:step, step / 2:w:step]
    grid = np.c_[gx.ravel(), gy.ravel()]
    rays = MM.undistort_points(grid, lens, w, h) if lens else grid
    rays = np.c_[(rays - c) / fx, np.ones(len(rays))]
    out, frames, skipped, scales = [], [], [], []
    for f, path in sorted(((int(a), b) for a, b in results.items()), key=lambda x: x[0]):
        cam = cams.get(f) or cams.get(str(f))
        if not cam:
            skipped.append({"frame": f, "why": "no solved camera"})
            continue
        d = _resize(CA.read_depth(path), w, h)
        sc = scale_depth(d, cam, tracks.get(f) or tracks.get(str(f)) or [])
        if not sc:
            skipped.append({"frame": f, "why": f"fewer than {DEPTH_MIN_TRACKS} solved tracks with depth"})
            continue
        z = d[gy.astype(int).ravel(), gx.astype(int).ravel()]
        ok = np.isfinite(z) & (z > 0)
        if ok.sum() < 50:
            skipped.append({"frame": f, "why": "no depth"})
            continue
        ok &= z <= np.percentile(z[ok], 95)
        pc = rays[ok] * (z[ok] * sc["scale"])[:, None]
        R, t = np.asarray(cam["R"], float), np.asarray(cam["t"], float)
        X = (pc - t) @ R                                  # R^T (x_cam - t), row by row
        if len(X) > most:
            X = X[np.linspace(0, len(X) - 1, most).astype(int)]
        out.append(X)
        scales.append(sc["scale"])
        frames.append({"frame": f, "points": len(X), **{k: round(v, 5) if isinstance(v, float) else v for k, v in sc.items()}})
    if not out:
        raise MatteError(skipped[0]["why"] if skipped else "the job gave no depth")
    metric = rec.get("workflow") in METRIC_WORKFLOWS
    pts = np.concatenate(out)
    return {"points": np.round(pts, 5).tolist(), "frames": frames, "skipped": skipped, "metric": metric,
            "metres_per_unit": round(1.0 / float(np.median(scales)), 6) if metric else None,
            "workflow": rec.get("workflow")}
