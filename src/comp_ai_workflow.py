"""A ComfyUI workflow of the user's own in a Comp AI node (Sebastian 2026-11-23).

Every AI node (matte, depth, inpaint, upscale) can run a workflow taken from the open canvas or a .json file in
place of its own short list, and the AI Workflow node (``ai_workflow``) runs nothing else. The workflow is kept
INSIDE the comp, on the node (``custom``: {graph (API format), name, source, path, sig, inputs, outputs, params}),
so the comp renders the same when the canvas or the file changes; Reload in the page takes the file again.

How a workflow meets the comp (:func:`inspect`):

- **Inputs.** Every LoadImage / LoadImageOutput is a picture input, every LoadImageMask a mask input (it takes the
  alpha of what is wired into it), every LoadVideo / VHS_LoadVideo a film input (the frames asked for, rendered to
  one H.264 film). A node titled ``comp:<name>`` names its input; another is named by its title, else by its kind
  and number. An AI Workflow node gets one pipe per input; the other AI nodes hand their own ``src`` (the first
  picture input, or the one named src / image / plate) and ``mask`` (a mask input, or one named mask; without one
  the picture's alpha carries the place to change, as Paint's Generate does).
- **Outputs.** Every SaveImage / PreviewImage / SaveImageAdvanced / video save. The first (or the one titled
  ``comp:out``) is the node's picture; on an AI Workflow node each further one is a layer of it, named after the
  output (a Shuffle takes it out).
- **Parameters.** Every plain value of a node titled ``comp:<name>`` (a primitive, a sampler's steps ...) and the
  prompt the workflow has are the node's parameters ``wf_<name>`` (numbers keyable); every other seed gets the
  run's one seed.

How it runs (:func:`prepare`): with picture inputs the workflow is filled in once per frame and the frames' graphs
are laid into ONE prompt (``comp_ai.merge_graphs``: the loaders and encoders once). With a film input it runs
once over the range. With no input at all it runs once; its picture is held over the frames. :func:`place`
writes what came back beside the comp, ``<stem>_ai/<node>/<run>/<node>_<output>.####.png`` (a float EXR is kept
as EXR), and answers the node's ``results`` (frames, and layers for further outputs).
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time

import numpy as np

from . import comp_ai as CA
from . import comp_io
from . import comp_model as M
from . import paint_generate as G
from . import paint_io as P

PICTURE_LOADERS = ("LoadImage", "LoadImageOutput")
MASK_LOADERS = ("LoadImageMask",)
VIDEO_LOADERS = {"LoadVideo": "file", "VHS_LoadVideo": "video", "VHS_LoadVideoPath": "video"}
PICTURE_OUTPUTS = ("SaveImage", "PreviewImage", "SaveImageAdvanced", "Image Save", "SaveImageWebsocket",
                   "SaveAnimatedWEBP", "SaveAnimatedPNG")
VIDEO_OUTPUTS = ("SaveVideo", "SaveWEBM", "VHS_VideoCombine")
VIDEO_EXTS = (".mp4", ".webm", ".mov", ".mkv", ".gif", ".avi")
PROMPT_NAMES = ("prompt", "text", "positive", "model.prompt")
SKIP_INPUTS = {"image", "images", "filename_prefix", "upload", "video", "file", "channel", "format", "codec"}
MAX_PARAMS = 48
MAX_FRAMES = CA.MAX_BATCH_FRAMES
MAX_FILM_FRAMES = 2400
_LOCK = threading.Lock()
_RUNS = {}
MAX_RUNS = 8
PREFIX = "comp:"


class WorkflowError(ValueError):
    pass


# ── what a workflow takes and gives ─────────────────────────────────────────

def _ids(graph):
    return sorted(graph, key=lambda k: (0, int(k)) if str(k).isdigit() else (1, str(k)))


def _title(node):
    return str(((node.get("_meta") or {}).get("title")) or "").strip()


def _slug(s):
    s = re.sub(r"[^A-Za-z0-9_]+", "_", str(s or "").strip()).strip("_").lower()
    return s[:40]


def _own_name(node):
    """The name a node's title gives it: ``comp:<name>`` (or ``paint:<name>``), else its title if that is not
    just its class; None for none."""
    t = _title(node)
    low = t.lower()
    for pre in (PREFIX, "paint:"):
        if low.startswith(pre):
            return _slug(t[len(pre):]) or None
    if t and t != node.get("class_type") and not re.match(r"^(load|save|preview)\s*(image|video|mask)", low):
        return _slug(t) or None
    return None


def _tagged(node):
    low = _title(node).lower()
    return low.startswith(PREFIX)


def layer_name(name):
    """A further output's name as a layer of the comp (letters, digits and _; not r g b a, rgb or rgba)."""
    s = _slug(name) or "out"
    if s[0].isdigit():
        s = "o_" + s
    if s in ("r", "g", "b", "a", "rgb", "rgba", "none"):
        s = s + "_out"
    return s


def _unique(name, used):
    base, k = name, 2
    while name in used:
        name = f"{base}{k}"
        k += 1
    used.add(name)
    return name


def _is_link(x):
    return isinstance(x, list) and len(x) == 2 and isinstance(x[0], (str, int)) and isinstance(x[1], int) \
        and not isinstance(x[1], bool)


def _kind_of(v, name):
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "num"
    if isinstance(v, str):
        return "prompt" if (name in PROMPT_NAMES or len(v) > 60 or "\n" in v) else "text"
    return None


def signature(graph):
    """A short hash of a workflow (what its results were made with)."""
    return hashlib.sha1(json.dumps(graph, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:12]


def clean_graph(graph):
    """The API-format graph of *graph* (what ``app.graphToPrompt()`` answers is taken too)."""
    if isinstance(graph, dict) and isinstance(graph.get("output"), dict) and G.is_api_graph(graph["output"]):
        graph = graph["output"]
    if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
        raise WorkflowError("this is a workflow as the canvas saves it: the page turns it into a prompt first (reload the page)")
    if not G.is_api_graph(graph):
        raise WorkflowError("not a ComfyUI workflow (a JSON object of nodes with class_type and inputs)")
    if len(json.dumps(graph)) > G.MAX_GRAPH_BYTES:
        raise WorkflowError("that workflow is too large")
    return {str(k): {"class_type": v["class_type"], "inputs": copy.deepcopy(v.get("inputs") or {}),
                     **({"_meta": copy.deepcopy(v["_meta"])} if isinstance(v.get("_meta"), dict) else {})}
            for k, v in graph.items() if v.get("class_type") not in G.FRONTEND_ONLY}


def inspect(graph):
    """What the workflow takes and gives: {inputs [{name, node, kind picture | mask | video}], outputs [{name,
    node, kind picture | video}], params [{id, name, node, input, kind, def, label}], prompt [node, input] | None,
    seeds [[node, input]], sig}."""
    graph = clean_graph(graph)
    ids = _ids(graph)
    inputs, used = [], set()
    counts = {"picture": 0, "mask": 0, "video": 0}
    for k in ids:
        c = graph[k]["class_type"]
        kind = "picture" if c in PICTURE_LOADERS else "mask" if c in MASK_LOADERS else "video" if c in VIDEO_LOADERS else None
        if not kind:
            continue
        counts[kind] += 1
        own = _own_name(graph[k])
        if kind == "picture" and own is None:
            own = "src" if counts["picture"] == 1 else f"image{counts['picture']}"
        elif own is None:
            own = kind if counts[kind] == 1 else f"{kind}{counts[kind]}"
        inputs.append({"name": _unique(own, used), "node": k, "kind": kind})
    outputs, oused = [], set()
    outs = [k for k in ids if graph[k]["class_type"] in PICTURE_OUTPUTS + VIDEO_OUTPUTS]
    main = next((k for k in outs if _title(graph[k]).lower() in (PREFIX + "out", PREFIX + "output", "paint:output")), None)
    if main:
        outs.remove(main)
        outs.insert(0, main)
    for i, k in enumerate(outs):
        own = "out" if i == 0 else layer_name(_own_name(graph[k]) or f"out{i + 1}")
        outputs.append({"name": _unique(own, oused), "node": k,
                        "kind": "video" if graph[k]["class_type"] in VIDEO_OUTPUTS else "picture"})
    params, pused = [], set()
    tagged_inputs = set()
    for k in ids:
        v = graph[k]
        if not _tagged(v) or v["class_type"] in PICTURE_LOADERS + MASK_LOADERS + PICTURE_OUTPUTS + VIDEO_OUTPUTS \
                or v["class_type"] in VIDEO_LOADERS:
            continue
        base = _own_name(v) or _slug(v["class_type"])
        plain = [(n, x) for n, x in (v.get("inputs") or {}).items() if not _is_link(x) and _kind_of(x, n)
                 and n not in SKIP_INPUTS]
        for name, x in plain:
            label = base if len(plain) == 1 else f"{base} {name}"
            pid = "wf_" + _unique(_slug(label), pused)
            params.append({"id": pid, "name": label, "node": k, "input": name, "kind": _kind_of(x, name), "def": x})
            tagged_inputs.add((k, name))
    slots = G.detect_slots(graph)
    prompt = slots.get("prompt")
    if prompt and tuple(prompt) not in tagged_inputs:
        pid = "wf_" + _unique("prompt", pused)
        params.insert(0, {"id": pid, "name": "prompt", "node": prompt[0], "input": prompt[1], "kind": "prompt",
                          "def": graph[prompt[0]]["inputs"].get(prompt[1], ""), "auto": True})
    seeds = [[k, n] for k, n in slots.get("seeds") or [] if (k, n) not in tagged_inputs]
    return {"inputs": inputs, "outputs": outputs, "params": params[:MAX_PARAMS],
            "prompt": list(prompt) if prompt else None, "seeds": seeds, "sig": signature(graph), "nodes": len(graph)}


def make_custom(graph, name="", source="file", path=""):
    """What a node keeps of a workflow taken in: {graph, name, source, path, saved, sig, inputs, outputs, params}."""
    g = clean_graph(graph)
    info = inspect(g)
    if not info["outputs"]:
        raise WorkflowError("the workflow saves nothing: it needs a SaveImage, PreviewImage or a video save "
                            "(title it comp:out if there are several)")
    return {"graph": g, "name": str(name or "")[:120] or "My workflow", "source": source if source in ("canvas", "file") else "file",
            "path": str(path or "")[:1024], "saved": time.strftime("%Y-%m-%d %H:%M:%S"), "sig": info["sig"],
            "inputs": info["inputs"], "outputs": info["outputs"], "params": info["params"]}


# ── filling it in ────────────────────────────────────────────────────────────

def custom_of(n):
    c = n.get("custom")
    if not isinstance(c, dict) or not isinstance(c.get("graph"), dict):
        return None
    return c


def uses_custom(n):
    """Whether node *n* runs its own workflow: an AI Workflow node always, another AI node when it picked it."""
    if not custom_of(n):
        return False
    return n.get("type") == "ai_workflow" or n.get("workflow") == "custom"


def param_value(n, p, f):
    """A workflow parameter's value at frame *f* (its keys, else its value, else the workflow's own)."""
    v = M.param_at(n, p["id"], f)
    if v is None:
        v = p.get("def")
    k = p.get("kind")
    try:
        if k == "int":
            return int(round(float(v)))
        if k == "num":
            return float(v)
        if k == "bool":
            return v in (True, "on", "true", 1)
    except (TypeError, ValueError):
        return p.get("def")
    return v if isinstance(v, (str, int, float, bool)) else p.get("def")


def _ports(n, info):
    """{workflow input node id: index of the comp node's input} for node *n*."""
    if n.get("type") == "ai_workflow":
        return {x["node"]: i for i, x in enumerate(info["inputs"])}
    pics = [x for x in info["inputs"] if x["kind"] in ("picture", "video")]
    masks = [x for x in info["inputs"] if x["kind"] == "mask"]
    src = next((x for x in pics if x["name"] in ("src", "image", "plate")), pics[0] if pics else None)
    mask = next((x for x in info["inputs"] if x["name"] == "mask" and x is not src), masks[0] if masks else None)
    out = {}
    if src:
        out[src["node"]] = 0
    if mask and CA.AI_KINDS.get(n.get("type")) == "inpaint":
        out[mask["node"]] = 1
    return out


def _render(comp, nid, f, sources, ocio, memo):
    return M.render_node(comp, nid, f, sources, 1.0, memo=memo, ocio=ocio)


def _write_png(path, px):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(P.png_bytes(px))


def _film(comp, nid, frames, sources, ocio, path, fps):
    from . import export_rules
    size = M.format_at(comp, nid)
    how = export_rules.video_settings("mp4", None, "high")
    w = comp_io.VideoWriter(path, how, fps, size["width"], size["height"])
    ok = False
    try:
        for f in frames:
            w.add(M.conform(_render(comp, nid, f, sources, ocio, {}), size["width"], size["height"]))
        ok = True
    finally:
        w.close(keep=ok)


def prepare(comp, comp_path, node_id, frames, sources, input_dir, *, ocio=None, folder_paths=None, node_classes=None,
            models=None):
    """The node's own workflow over *frames* as ONE ComfyUI job: {run, graph, outputs {merged output node id:
    [frame | null, output name]}, frames, mode frames | once, kind, nodes, seed, skipped}."""
    comp0, _e = M.normalize(comp)
    flat = M.G.flatten(comp0)
    n = next((x for x in flat["nodes"] if x["id"] == node_id), None)
    if n is None:
        raise WorkflowError(f"no node {node_id!r} in the comp")
    if not uses_custom(n):
        raise WorkflowError("the node has no workflow of its own: take one from the canvas or a file")
    c = custom_of(n)
    graph = clean_graph(c["graph"])
    info = inspect(graph)
    if not info["outputs"]:
        raise WorkflowError("the workflow saves nothing")
    kind = CA.AI_KINDS.get(n["type"], "workflow")
    G.apply_models(graph, models if isinstance(models, dict) else n.get("models"), folder_paths)
    gone = G.missing(graph, folder_paths, node_classes)
    if gone:
        raise G.Missing(gone)
    want = sorted({int(f) for f in frames or []})
    if not want:
        raise WorkflowError("no frames to run")
    if len(want) > MAX_FRAMES:
        raise WorkflowError(f"at most {MAX_FRAMES} frames in one job (set frames per job lower)")
    ins = list(n.get("inputs") or [])
    ports = _ports(n, info)
    by_node = {x["node"]: x for x in info["inputs"]}
    for nid, i in ports.items():
        if not (i < len(ins) and ins[i]):
            what = by_node[nid]["name"] if n["type"] == "ai_workflow" else ("src" if i == 0 else "mask")
            raise WorkflowError(f"nothing comes into {what}: wire a picture into it")
    if kind == "inpaint" and not (len(ins) > 1 and ins[1]):
        raise WorkflowError("wire the place to change into the mask input (its alpha)")
    loaders = [x for x in info["inputs"] if x["node"] in ports]
    has_video = any(x["kind"] == "video" for x in loaders)
    mode = "frames" if loaders and not has_video else "once"
    if has_video:
        if want != list(range(want[0], want[-1] + 1)):
            raise WorkflowError("a workflow with a film input takes every frame of a stretch, not every Nth")
        if len(want) > MAX_FILM_FRAMES:
            raise WorkflowError(f"at most {MAX_FILM_FRAMES} frames as one film")
    run = secrets.token_hex(6)
    rel_dir = f"paint/compwf_{run}"
    folder = os.path.join(input_dir, *rel_dir.split("/"))
    seed = secrets.randbelow(G.SEED_MAX + 1)
    fps = float((flat.get("format") or {}).get("fps") or 24)
    safe = G.safe_name(node_id) or "node"
    no_mask_loader = kind == "inpaint" and not any(x["kind"] == "mask" for x in loaders)

    def fill(g, f, memo):
        """The workflow filled in for frame *f*: its loaders' files, the parameters at f, the seed, the outputs'
        prefixes. Answers what the frame needs to lay the answer back ({w, h, k, box, plate})."""
        per = {}
        src_pic = None
        for x in loaders:
            i = ports[x["node"]]
            node = g[x["node"]]
            if x["kind"] == "video":
                name = f"{G.safe_name(x['name']) or 'film'}.mp4"
                path = os.path.join(folder, name)
                if not os.path.isfile(path):
                    _film(flat, ins[i], want, sources, ocio, path, fps)
                node["inputs"][VIDEO_LOADERS[node["class_type"]]] = (path if node["class_type"] == "VHS_LoadVideoPath"
                                                                    else f"{rel_dir}/{name}")
                size = M.format_at(flat, ins[i])
                per.setdefault("w", size["width"])
                per.setdefault("h", size["height"])
                continue
            img = _render(flat, ins[i], f, sources, ocio, memo)
            pic = CA.to_8bit(img)
            if x["kind"] == "mask":
                px = np.ascontiguousarray(pic[..., 3])       # white = where the mask is
                node["inputs"]["channel"] = "red"
            else:
                px = pic
                if i == 0:
                    src_pic = pic
                    per["w"], per["h"] = pic.shape[1], pic.shape[0]
            name = f"{G.safe_name(x['name']) or 'in'}.{f:04d}.png"
            _write_png(os.path.join(folder, name), px)
            node["inputs"]["image"] = f"{rel_dir}/{name}"
        if no_mask_loader and src_pic is not None:
            # As Paint's Generate does: LoadImage's MASK output (255 - alpha) is the place to change.
            m = M.conform(_render(flat, ins[1], f, sources, ocio, memo), src_pic.shape[1], src_pic.shape[0])
            sel = np.clip(m[..., 3] * 255.0 + 0.5, 0, 255).astype(np.uint8)
            pic = src_pic.copy()
            pic[..., 3] = 255 - sel
            name = f"src.{f:04d}.png"
            _write_png(os.path.join(folder, name), pic)
            g[next(x["node"] for x in loaders if ports[x["node"]] == 0)]["inputs"]["image"] = f"{rel_dir}/{name}"
        if kind == "inpaint" and src_pic is not None:
            plate = os.path.join(folder, f"plate.{f:04d}.png")
            _write_png(plate, src_pic)
            per["plate"] = plate
        for p in c.get("params") or []:
            if p.get("node") in g and p.get("input") in (g[p["node"]].get("inputs") or {}):
                g[p["node"]]["inputs"][p["input"]] = param_value(n, p, f)
        if kind == "inpaint" and info["prompt"] and n.get("prompt") is not None:
            k0, inp = info["prompt"]
            if k0 in g and not any(p.get("node") == k0 and p.get("input") == inp and not p.get("auto") for p in c.get("params") or []):
                g[k0]["inputs"][inp] = str(n.get("prompt") or "")
        for k0, inp in info["seeds"]:
            if k0 in g:
                g[k0]["inputs"][inp] = seed
        for o in info["outputs"]:
            ins0 = g[o["node"]].get("inputs") or {}
            if "filename_prefix" in ins0:
                ins0["filename_prefix"] = f"comp/ai/{run}/{safe}_{G.safe_name(o['name'])}" + (f".{f:04d}" if mode == "frames" else "")
        if "w" not in per:
            fm = flat.get("format") or {}
            per["w"], per["h"] = int(fm.get("width") or 1920), int(fm.get("height") or 1080)
        per["k"] = max(1, int(float(n.get("factor") or 2))) if kind == "upscale" else 1
        per["box"] = [0, 0, per["w"], per["h"]]
        return per

    graphs, outs, done, skipped, frames_rec = [], [], [], [], {}
    if mode == "frames":
        for f in want:
            g = copy.deepcopy(graph)
            try:
                per = fill(g, f, {})
            except (CA.AiError, WorkflowError, ValueError) as e:
                skipped.append({"frame": f, "why": str(e)})
                continue
            graphs.append(g)
            outs.append([o["node"] for o in info["outputs"]])
            frames_rec[f] = per
            done.append(f)
        if not graphs:
            raise WorkflowError(skipped[0]["why"] if skipped else "no frames to run")
        merged, flat_outs = _merge(graphs, outs)
        outputs = {}
        for f, ids_ in zip(done, flat_outs):
            for o, mid in zip(info["outputs"], ids_):
                outputs[mid] = [f, o["name"]]
    else:
        os.makedirs(folder, exist_ok=True)
        g = copy.deepcopy(graph)
        per = fill(g, want[0], {})
        merged = g
        outputs = {o["node"]: [None, o["name"]] for o in info["outputs"]}
        for f in want:
            frames_rec[f] = per
        done = want
    if len(json.dumps(merged)) > CA.MAX_BATCH_BYTES:
        raise WorkflowError("the job is too large: set frames per job lower")
    rec = {"comp": os.path.abspath(comp_path), "node": node_id, "kind": kind, "type": n["type"], "mode": mode,
           "frames": frames_rec, "want": done, "outputs": outputs, "out_kinds": {o["name"]: o["kind"] for o in info["outputs"]},
           "main": info["outputs"][0]["name"], "layers": n["type"] == "ai_workflow", "at": time.time(), "folder": folder}
    with _LOCK:
        _RUNS[run] = rec
        while len(_RUNS) > MAX_RUNS:
            _RUNS.pop(next(iter(_RUNS)))
    return {"run": run, "graph": merged, "outputs": outputs, "frames": done, "skipped": skipped, "mode": mode,
            "kind": kind, "nodes": len(merged), "per_frame": len(graph), "seed": seed, "workflow": "custom",
            "label": c.get("name") or "My workflow"}


def _merge(graphs, outs):
    """Several filled-in graphs as one prompt: (graph, [[merged ids of each graph's outputs]]). comp_ai's
    merge_graphs keeps ONE output per graph; this keeps every output of each."""
    merged, canon, res = {}, {}, []
    for g, out_ids in zip(graphs, outs):
        g = {str(k): v for k, v in g.items()}
        local = {}
        outset = {str(x) for x in out_ids}
        for k in CA._order(g):
            v = g[k]
            ins = {}
            for name, x in (v.get("inputs") or {}).items():
                ins[name] = [local[str(x[0])], x[1]] if CA._is_link(x, g) else x
            node = {"class_type": v["class_type"], "inputs": ins}
            if v.get("_meta"):
                node["_meta"] = v["_meta"]
            sig = None if (k in outset or v["class_type"] in PICTURE_OUTPUTS + VIDEO_OUTPUTS) else \
                json.dumps([v["class_type"], ins], sort_keys=True, default=str)
            if sig is not None and sig in canon:
                local[k] = canon[sig]
                continue
            nid = str(len(merged) + 1)
            merged[nid] = node
            local[k] = nid
            if sig is not None:
                canon[sig] = nid
        res.append([local[str(x)] for x in out_ids])
    return merged, res


# ── what came back ───────────────────────────────────────────────────────────

def run_record(run):
    with _LOCK:
        rec = _RUNS.get(str(run))
    if not rec:
        raise WorkflowError("that run is no longer known (the server restarted?) - run it again")
    return rec


def out_name(comp_path, node_id, run, output, frame, ext="png"):
    """(absolute path, relative to the comp) of an output's frame: ``<stem>_ai/<node>/<run>/<node>_<output>.####.<ext>``."""
    stem = os.path.basename(comp_path)
    stem = stem[: -len(M.SUFFIX)] if stem.lower().endswith(M.SUFFIX) else os.path.splitext(stem)[0]
    safe = G.safe_name(node_id) or "node"
    rel = f"{stem}_ai/{safe}/{run}/{safe}_{G.safe_name(output) or 'out'}.{int(frame):04d}.{ext}"
    return os.path.join(os.path.dirname(os.path.abspath(comp_path)), *rel.split("/")), rel


def film_frames(path, folder):
    """A film a workflow saved, as PNG pictures in *folder* (PyAV in this process): [path, ...] in order."""
    import av
    os.makedirs(folder, exist_ok=True)
    out = []
    with av.open(path) as c:
        st = next((s for s in c.streams if s.type == "video"), None)
        if st is None:
            raise WorkflowError(f"{os.path.basename(path)} holds no picture")
        for i, fr in enumerate(c.decode(st)):
            p = os.path.join(folder, f"f{i:05d}.png")
            fr.to_image().convert("RGBA").save(p)
            out.append(p)
            if len(out) > MAX_FILM_FRAMES:
                break
    return out


def _spread(paths, frames):
    """Pictures laid on frames in order; spread evenly when the counts differ; one picture is held (its first frame)."""
    if not paths:
        return {}
    if len(paths) == 1:
        return {frames[0]: paths[0]}
    if len(paths) == len(frames):
        return dict(zip(frames, paths))
    return {f: paths[min(len(paths) - 1, int(i * len(paths) / len(frames)))] for i, f in enumerate(frames)}


def _answer(rec, per, src):
    """The main output's picture as the node's result for one frame: the AI node's own finishing (comp_ai), or
    the picture as it is for an AI Workflow node (None: copy the file as it is)."""
    if rec["type"] == "ai_workflow":
        return None
    if rec["kind"] == "depth":
        return None   # brought to 0..1 together, below
    one = dict(per, kind=rec["kind"])
    plate = P.image_pixels(per["plate"]) if per.get("plate") else None
    return CA._answer(one, P.image_pixels(src), plate)


def place(run, images):
    """A run's answers (*images*: {output node id: [path, ...]}) written beside the comp: {frames {frame: file},
    layers {name: {frame: file}}, node, kind, folder}."""
    rec = run_record(run)
    by_out = {}          # output name -> {frame: source path}
    tmp = os.path.join(rec["folder"], "films")
    for nid, paths in images.items():
        hit = rec["outputs"].get(str(nid))
        if not hit or not paths:
            continue
        f, name = hit
        paths = [p for p in paths if p]
        if not paths:
            continue
        if f is not None:
            by_out.setdefault(name, {})[int(f)] = paths[0]
            continue
        pics = []
        for p in paths:
            if p.lower().endswith(VIDEO_EXTS):
                pics += film_frames(p, os.path.join(tmp, f"{G.safe_name(name)}_{len(pics)}"))
            else:
                pics.append(p)
        by_out.setdefault(name, {}).update(_spread(pics, rec["want"]))
    main = by_out.get(rec["main"]) or {}
    if not main:
        raise WorkflowError("the workflow gave no pictures")
    frames, paths = {}, {}
    depth = None
    if rec["kind"] == "depth":
        order = sorted(main)
        maps = CA.depth_maps([CA._fit_float(CA.read_depth(main[f]), rec["frames"][f]["w"], rec["frames"][f]["h"]) for f in order])
        depth = dict(zip(order, maps))
    for f in sorted(main):
        src = main[f]
        per = rec["frames"].get(f) or {}
        ext = "exr" if src.lower().endswith(".exr") and rec["type"] == "ai_workflow" else "png"
        path, rel = out_name(rec["comp"], rec["node"], run, rec["main"], f, ext)
        px = depth[f] if depth is not None else _answer(rec, per, src)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if px is None:
            if ext == "png" and not src.lower().endswith(".png"):
                CA._write(path, P.image_pixels(src))
            else:
                shutil.copyfile(src, path)
        else:
            CA._write(path, px)
        frames[str(f)], paths[str(f)] = rel, path
    layers = {}
    if rec["layers"]:
        for name, got in by_out.items():
            if name == rec["main"]:
                continue
            lay = {}
            for f in sorted(got):
                src = got[f]
                ext = "exr" if src.lower().endswith(".exr") else "png"
                path, rel = out_name(rec["comp"], rec["node"], run, name, f, ext)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                if ext == "png" and not src.lower().endswith(".png"):
                    CA._write(path, P.image_pixels(src))
                else:
                    shutil.copyfile(src, path)
                lay[str(f)] = rel
            if lay:
                layers[name] = lay
    first = next(iter(paths.values()))
    return {"frames": frames, "layers": layers, "paths": paths, "node": rec["node"], "kind": rec["kind"],
            "folder": os.path.dirname(first)}
