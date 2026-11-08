"""Paint's Generate with ready-made ComfyUI workflows (no agent in between).

Each Generate action (``ACTIONS``) is a fixed workflow in ComfyUI's API format. The built-in ones are in
``paint_workflows/`` (``index.json`` names them, their actions, the size the model works at and where
they came from); the user can put their own in their place in Settings -> ComfyUI Image Viewer -> Paint
(from the canvas or from a file), kept per OS user in ``~/.comfyui_image_viewer/paint_workflows/``.

A workflow's inputs are found by node titles, else by what the nodes are (:func:`detect_slots`):

- ``paint:image`` - the LoadImage that gets the picture. Its MASK output is the selection (the PNG is
  written with alpha = 255 - selection, so LoadImage's mask = the place to change), as the official
  inpaint templates wire it.
- ``paint:mask`` - optional, a LoadImage / LoadImageMask that gets the selection on its own (white =
  change).
- ``paint:prompt`` - the node whose ``text`` / ``prompt`` gets the words.
- ``paint:output`` - the SaveImage / PreviewImage whose picture comes back.
- every ``seed`` / ``noise_seed`` gets a new number each run.

``prepare`` cuts out what the action works on (the selection's box and some of what is around it, or
the whole picture), scales it to the model's working size, writes it into ``<input>/paint`` and fills the
workflow in; the page queues it in ComfyUI's own queue. ``place`` takes the picture the workflow made,
scales it back to the box it came from and answers the paint ops that lay it in (one undo step in the
page): a layer masked to the selection, a layer mask, the selection, or a bigger canvas.
"""

import copy
import json
import math
import os
import re
import secrets
import threading
import time

import numpy as np

from . import paint_io as P
from . import paint_math as M
from . import paint_ops as O

HERE = os.path.dirname(os.path.abspath(__file__))
BUILTIN_DIR = os.path.join(HERE, "paint_workflows")

ACTIONS = ("fill", "remove", "extend", "edit", "background", "select_subject", "upscale")
LABELS = {"fill": "Generative fill", "remove": "Remove object", "extend": "Extend (fill the new border)",
          "edit": "Edit with a prompt", "background": "Remove background", "select_subject": "Select subject",
          "upscale": "Upscale with detail"}
# What each action works on: the selection's box (with context around it) or the whole picture.
NEEDS_SEL = ("fill", "remove")
MASKED = ("fill", "remove", "extend")
CONTEXT = 0.25                      # of the selection box's larger side, on every side
MIN_CONTEXT = 32
AGENT = "agent"                     # the choice that asks agentY instead (the old way)
CUSTOM = "custom"
MAX_JOBS = 64
MAX_GRAPH_BYTES = 4 * 1024 * 1024

LOADERS = {      # class -> (input, model folder) a missing file shows up in
    "UNETLoader": [("unet_name", "diffusion_models")],
    "CheckpointLoaderSimple": [("ckpt_name", "checkpoints")],
    "VAELoader": [("vae_name", "vae")],
    "CLIPLoader": [("clip_name", "text_encoders")],
    "DualCLIPLoader": [("clip_name1", "text_encoders"), ("clip_name2", "text_encoders")],
    "TripleCLIPLoader": [("clip_name1", "text_encoders"), ("clip_name2", "text_encoders"), ("clip_name3", "text_encoders")],
    "LoraLoader": [("lora_name", "loras")],
    "LoraLoaderModelOnly": [("lora_name", "loras")],
    "UpscaleModelLoader": [("model_name", "upscale_models")],
    "ControlNetLoader": [("control_net_name", "controlnet")],
}
IMAGE_LOADERS = ("LoadImage", "LoadImageOutput")
MASK_LOADERS = ("LoadImageMask",)
OUTPUTS = ("SaveImage", "PreviewImage", "SaveImageAdvanced", "Image Save", "SaveImageWebsocket")
ASPECTS = ("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")


class GenerateError(ValueError):
    pass


class Missing(GenerateError):
    def __init__(self, missing):
        self.missing = missing
        super().__init__("missing: " + ", ".join(m["what"] for m in missing))


# ── the built-in table and the user's own ────────────────────────────────────

def builtins():
    with open(os.path.join(BUILTIN_DIR, "index.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _builtin(wid):
    for e in builtins():
        if e["id"] == wid:
            with open(os.path.join(BUILTIN_DIR, e["file"]), encoding="utf-8") as fh:
                return e, json.load(fh)
    return None, None


def user_folder():
    from .legacy_names import user_dir
    return os.path.join(os.environ.get("IMAGE_VIEWER_PAINT_WORKFLOWS") or os.path.join(user_dir(), "paint_workflows"))


def _choices_path():
    return os.path.join(user_folder(), "choices.json")


def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{secrets.token_hex(4)}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def default_for(action):
    for e in builtins():
        if action in e["actions"]:
            return e["id"]
    return AGENT


def choices():
    got = _read_json(_choices_path(), {})
    return {a: (got.get(a) if isinstance(got, dict) and isinstance(got.get(a), str) else default_for(a)) for a in ACTIONS}


def set_choice(action, wid):
    if action not in ACTIONS:
        raise GenerateError(f"unknown action {action!r}")
    ok = {e["id"] for e in builtins() if action in e["actions"]} | {AGENT, CUSTOM}
    if wid not in ok:
        raise GenerateError(f"{wid!r} is not a workflow for {LABELS[action]}")
    if wid == CUSTOM and not custom(action):
        raise GenerateError("there is no workflow of your own for this yet")
    got = _read_json(_choices_path(), {})
    got = got if isinstance(got, dict) else {}
    got[action] = wid
    _write_json(_choices_path(), got)


def custom(action):
    """The user's own workflow for *action*: {graph, name, source, saved} or None."""
    if action not in ACTIONS:
        return None
    got = _read_json(os.path.join(user_folder(), f"{action}.json"), None)
    return got if isinstance(got, dict) and isinstance(got.get("graph"), dict) else None


def is_api_graph(g):
    return (isinstance(g, dict) and bool(g)
            and all(isinstance(v, dict) and isinstance(v.get("class_type"), str) and isinstance(v.get("inputs", {}), dict)
                    for v in g.values()))


def set_custom(action, graph, name="", source="file"):
    """Keep *graph* (API format) as the user's workflow for *action* and choose it; None takes it away."""
    if action not in ACTIONS:
        raise GenerateError(f"unknown action {action!r}")
    path = os.path.join(user_folder(), f"{action}.json")
    if graph is None:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        if choices()[action] == CUSTOM:
            set_choice(action, default_for(action))
        return None
    if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
        raise GenerateError("this is a workflow as ComfyUI saves it for the canvas, not in its API format: open it on "
                            "the canvas and use From canvas here, or save it with Export (API)")
    if isinstance(graph, dict) and isinstance(graph.get("output"), dict) and is_api_graph(graph["output"]):
        graph = graph["output"]            # what app.graphToPrompt() answers
    if not is_api_graph(graph):
        raise GenerateError("not a ComfyUI workflow in API format (a JSON object of nodes with class_type and inputs)")
    if len(json.dumps(graph)) > MAX_GRAPH_BYTES:
        raise GenerateError("that workflow is too large")
    slots = detect_slots(graph)
    if not slots["image"] or not slots["output"]:
        raise GenerateError("the workflow needs a LoadImage (for the picture) and a SaveImage or PreviewImage "
                            "(for the result); title them paint:image and paint:output if there are several")
    _write_json(path, {"graph": graph, "name": str(name or "")[:120] or "My workflow", "source": source,
                       "saved": time.strftime("%Y-%m-%d %H:%M:%S")})
    set_choice(action, CUSTOM)
    return slots


def _title(node):
    return str(((node.get("_meta") or {}).get("title")) or "").strip().lower()


def detect_slots(graph):
    """Where the picture, the mask, the prompt and the result are: {image, mask, mask_kind, prompt, output, seeds}."""
    ids = sorted(graph, key=lambda k: (0, int(k)) if str(k).isdigit() else (1, str(k)))
    by_title = {}
    for k in ids:
        t = _title(graph[k])
        if t.startswith("paint:"):
            by_title.setdefault(t[6:].strip(), k)
    out = {"image": None, "mask": None, "mask_kind": None, "prompt": None, "output": None, "seeds": []}
    loaders = [k for k in ids if graph[k]["class_type"] in IMAGE_LOADERS]
    out["image"] = by_title.get("image") or next((k for k in loaders if "mask" not in _title(graph[k])), None)
    mk = by_title.get("mask") or next((k for k in ids if graph[k]["class_type"] in MASK_LOADERS), None) \
        or next((k for k in loaders if k != out["image"] and "mask" in _title(graph[k])), None)
    if mk and mk != out["image"]:
        out["mask"], out["mask_kind"] = mk, graph[mk]["class_type"]
    p = by_title.get("prompt")
    if p is None:
        cands = []
        for k in ids:
            ins, t = graph[k].get("inputs", {}), _title(graph[k])
            if "neg" in t:
                continue
            for name in ("prompt", "text"):
                if isinstance(ins.get(name), str) and graph[k]["class_type"] not in IMAGE_LOADERS:
                    cands.append((0 if ("prompt" in t or "positive" in t) else 1, 0 if ins[name].strip() else 1, k))
                    break
        p = min(cands)[2] if cands else None
    if p is not None:
        ins = graph[p].get("inputs", {})
        name = "prompt" if "prompt" in ins else ("text" if "text" in ins else None)
        out["prompt"] = [p, name] if name else None
    outs = [k for k in ids if graph[k]["class_type"] in OUTPUTS]
    out["output"] = by_title.get("output") or (outs[-1] if outs else None)
    for k in ids:
        for name, v in (graph[k].get("inputs") or {}).items():
            if name in ("seed", "noise_seed") and isinstance(v, (int, float)) and not isinstance(v, bool):
                out["seeds"].append([k, name])
    return out


FOLDER_ALIASES = {"diffusion_models": ("diffusion_models", "unet"), "text_encoders": ("text_encoders", "clip")}


def _base(name):
    return str(name).replace("\\", "/").rsplit("/", 1)[-1].lower()


def locate(folder_paths, folder, name):
    """The name ComfyUI knows *name* by in *folder*: as it is, else the same file name in any subfolder
    (an extra model path, `flux/flux1-fill-dev.safetensors`), else None."""
    for f in FOLDER_ALIASES.get(folder, (folder,)):
        try:
            if folder_paths.get_full_path(f, name):
                return name
        except Exception:  # noqa: BLE001 - an unknown folder name
            pass
    want = _base(name)
    hits = []
    for f in FOLDER_ALIASES.get(folder, (folder,)):
        try:
            listed = folder_paths.get_filename_list(f) or []
        except Exception:  # noqa: BLE001
            listed = []
        hits += [n for n in listed if _base(n) == want]
    return min(hits, key=lambda n: (n.count("/") + n.count("\\"), len(n))) if hits else None


def resolve_models(graph, folder_paths):
    """Point every loader of *graph* at the file as ComfyUI lists it (in place); the names not found."""
    gone = []
    if folder_paths is None:
        return gone
    for v in graph.values():
        for name, folder in LOADERS.get(v.get("class_type"), []):
            ins = v.get("inputs") or {}
            f = ins.get(name)
            if not isinstance(f, str) or not f:
                continue
            got = locate(folder_paths, folder, f)
            if got:
                ins[name] = got
            else:
                gone.append({"what": f, "kind": "model", "folder": folder})
    return gone


def missing(graph, folder_paths=None, node_classes=None):
    """What the workflow needs that this ComfyUI does not have: [{what, kind, folder?}]. Model names are
    looked for in subfolders too, and the graph is pointed at what was found."""
    out = []
    if node_classes is not None:
        for cls in sorted({v["class_type"] for v in graph.values()}):
            if cls not in node_classes:
                out.append({"what": cls, "kind": "node"})
    out += resolve_models(graph, folder_paths)
    seen, uniq = set(), []
    for m in out:
        if m["what"] not in seen:
            seen.add(m["what"])
            uniq.append(m)
    return uniq


def resolve_workflow(action, wid=None):
    """(entry, graph) for *action*: the workflow *wid* (a built-in id or "custom"), else the chosen one."""
    wid = wid or choices()[action]
    if wid == CUSTOM:
        c = custom(action)
        if not c:
            raise GenerateError("there is no workflow of your own for this - pick one in Settings")
        return {"id": CUSTOM, "label": c.get("name") or "My workflow", "api": False, "actions": [action],
                "size": {"mp": None, "mult": 8, "max": 2048}}, copy.deepcopy(c["graph"])
    e, g = _builtin(wid)
    if not e or action not in e["actions"]:
        raise GenerateError(f"{wid!r} is not a workflow for {LABELS.get(action, action)}")
    return e, g


def listing(folder_paths=None, node_classes=None):
    """What Settings and the Generate menus show: per action its workflows, the chosen one and the user's own."""
    ch = choices()
    table = builtins()
    out = {}
    for a in ACTIONS:
        items = []
        for e in table:
            if a in e["actions"]:
                _e, g = _builtin(e["id"])
                items.append({"id": e["id"], "label": e["label"], "api": bool(e.get("api")), "from": e.get("from", ""),
                              "missing": missing(g, folder_paths, node_classes)})
        c = custom(a)
        mine = None
        if c:
            mine = {"name": c.get("name"), "source": c.get("source"), "saved": c.get("saved"),
                    "slots": detect_slots(c["graph"]), "missing": missing(c["graph"], folder_paths, node_classes)}
        out[a] = {"label": LABELS[a], "choice": ch[a], "default": default_for(a), "workflows": items, "custom": mine}
    return {"actions": out, "folder": user_folder()}


# ── one run ──────────────────────────────────────────────────────────────────

_JOBS = {}
_LOCK = threading.Lock()


def _work_size(w, h, size):
    """The size the model works at for a w x h crop: about mp megapixels (or as it is), a multiple of mult, within max."""
    mp, mult, mx = size.get("mp"), max(1, int(size.get("mult") or 1)), int(size.get("max") or 2048)
    s = math.sqrt(mp * 1e6 / (w * h)) if mp else 1.0
    s = min(s, mx / max(w, h))
    tw = max(mult, int(round(w * s / mult)) * mult)
    th = max(mult, int(round(h * s / mult)) * mult)
    return min(tw, mx - mx % mult or mult), min(th, mx - mx % mult or mult)


def _aspect(w, h):
    r = w / h
    return min(ASPECTS, key=lambda a: abs(math.log(r / (int(a.split(":")[0]) / int(a.split(":")[1])))))


def crop_box(doc, action):
    """(x, y, w, h) of what *action* works on, and the selection's box (or None)."""
    sel = doc.selection if doc.selection is not None and doc.selection.any() else None
    if action in NEEDS_SEL and sel is None:
        raise GenerateError("select the place first")
    if action == "extend" and sel is None:
        raise GenerateError("nothing to extend: the new border should be selected")
    sb = M.mask_bbox(sel) if sel is not None else None
    if sb and action in ("fill", "remove", "edit"):
        x, y, w, h = sb
        m = max(MIN_CONTEXT, int(round(CONTEXT * max(w, h))))
        x0, y0 = max(0, x - m), max(0, y - m)
        x1, y1 = min(doc.w, x + w + m), min(doc.h, y + h + m)
        return (x0, y0, x1 - x0, y1 - y0), sb
    return (0, 0, doc.w, doc.h), sb


def prepare(s, token, action, input_dir, *, wid=None, prompt="", variations=1, k=2, folder_paths=None,
            node_classes=None):
    """The workflow for one Generate, filled in: {job, graphs, output, label, box, api}."""
    if action not in ACTIONS:
        raise GenerateError(f"unknown action {action!r}")
    entry, graph = resolve_workflow(action, wid)
    gone = missing(graph, folder_paths, node_classes)
    if gone:
        raise Missing(gone)
    slots = detect_slots(graph)
    if not slots["image"] or not slots["output"]:
        raise GenerateError("the workflow has no picture input or no output")
    doc = s.doc
    (bx, by, bw, bh), sb = crop_box(doc, action)
    tw, th = _work_size(bw, bh, entry.get("size") or {})
    pic = P.composite(doc)[by:by + bh, bx:bx + bw].copy()
    sel = doc.selection[by:by + bh, bx:bx + bw] if (sb and action in MASKED + ("edit",)) else None
    if (tw, th) != (bw, bh):
        pic = O._resize(pic, tw, th)
        if sel is not None:
            sel = O._resize(np.ascontiguousarray(sel), tw, th, "bilinear")
    pic[..., 3] = 255 if sel is None else (255 - sel)
    folder = os.path.join(input_dir, "paint")
    os.makedirs(folder, exist_ok=True)
    job = secrets.token_hex(8)
    name = f"gen_{job}.png"
    with open(os.path.join(folder, name), "wb") as fh:
        fh.write(P.png_bytes(pic))
    mask_name = None
    if slots["mask"]:
        mask_name = f"gen_{job}_mask.png"
        m = sel if sel is not None else np.zeros((th, tw), np.uint8)
        with open(os.path.join(folder, mask_name), "wb") as fh:
            fh.write(P.png_bytes(m))
    words = str(prompt or "").strip()
    default_words = (entry.get("prompts") or {}).get(action, "")
    text = words or default_words
    if action == "fill" and not words:
        raise GenerateError("say what to make")
    if action == "edit" and not words:
        raise GenerateError("say what to change")
    g0 = graph
    gi = g0[slots["image"]]["inputs"]
    gi["image"] = f"paint/{name}"
    if slots["mask"]:
        mi = g0[slots["mask"]]["inputs"]
        mi["image"] = f"paint/{mask_name}"
        if slots["mask_kind"] == "LoadImageMask":
            mi["channel"] = "red"
    if slots["prompt"] and slots["prompt"][1]:
        g0[slots["prompt"][0]]["inputs"][slots["prompt"][1]] = text
    for nid, inp, val in (entry.get("set") or {}).get(action, []):
        if nid in g0:
            g0[nid]["inputs"][inp] = val
    if entry.get("aspect"):
        nid, inp = entry["aspect"]
        if nid in g0:
            g0[nid]["inputs"][inp] = _aspect(tw, th)
    if entry.get("scale") and action == "upscale":
        nid, inp = entry["scale"]
        if nid in g0:
            g0[nid]["inputs"][inp] = f"{int(k)}x"
    out_node = g0[slots["output"]]
    if "filename_prefix" in out_node.get("inputs", {}):
        out_node["inputs"]["filename_prefix"] = f"paint/generate/{action}"
    graphs = []
    for _ in range(max(1, min(4, int(variations or 1)))):
        g = copy.deepcopy(g0)
        for nid, inp in slots["seeds"]:
            g[nid]["inputs"][inp] = secrets.randbelow(2 ** 50)
        graphs.append(g)
    label = f"{LABELS[action]}: {words[:40]}" if words else LABELS[action]
    rec = {"token": token, "action": action, "box": [bx, by, bw, bh], "sel": bool(sb), "k": int(k or 2),
           "label": label, "name": (words[:30] or LABELS[action]), "w": doc.w, "h": doc.h, "at": time.time()}
    with _LOCK:
        _JOBS[job] = rec
        while len(_JOBS) > MAX_JOBS:
            _JOBS.pop(next(iter(_JOBS)))
    return {"job": job, "graphs": graphs, "output": slots["output"], "label": label, "box": rec["box"],
            "api": bool(entry.get("api")), "workflow": entry.get("label"), "size": [tw, th]}


def _cover(px, w, h):
    """*px* scaled to cover w x h and cut to it from the middle (a model that answers another shape)."""
    ph, pw = px.shape[:2]
    if (pw, ph) == (w, h):
        return px
    k = max(w / pw, h / ph)
    sw, sh = max(w, int(math.ceil(pw * k))), max(h, int(math.ceil(ph * k)))
    big = O._resize(px, sw, sh)
    x0, y0 = (sw - w) // 2, (sh - h) // 2
    return big[y0:y0 + h, x0:x0 + w].copy()


def place(job, result_path, input_dir, n=0):
    """The paint ops that lay the result of *job* into its document: {token, ops, label}."""
    with _LOCK:
        rec = _JOBS.get(job)
    if not rec:
        raise GenerateError("that Generate is no longer known (the server restarted?) - run it again")
    px = P.image_pixels(result_path)
    a = rec["action"]
    bx, by, bw, bh = rec["box"]
    folder = os.path.join(input_dir, "paint")
    os.makedirs(folder, exist_ok=True)
    out = os.path.join(folder, f"gen_{job}_result{n or ''}.png")
    name = rec["name"] + (f" {n + 1}" if n else "")
    if a == "upscale":
        k = rec["k"]
        W, H = rec["w"] * k, rec["h"] * k
        if max(W, H) > P.MAX_SIDE:
            raise GenerateError(f"{W}x{H} is larger than Paint takes ({P.MAX_SIDE} a side)")
        with open(out, "wb") as fh:
            fh.write(P.png_bytes(_cover(px, W, H)))
        ops = [{"op": "resize", "w": W, "h": H}, {"op": "add_layer", "file": out, "name": f"Upscaled {k}x", "x": 0, "y": 0}]
        return {"token": rec["token"], "ops": ops, "label": rec["label"]}
    if a in ("background", "select_subject"):
        m = _cover(px, rec["w"], rec["h"])
        with open(out, "wb") as fh:
            fh.write(P.png_bytes(m))
        ops = ([{"op": "mask", "layer": "active", "from": "file", "file": out}] if a == "background"
               else [{"op": "select", "mode": "file", "file": out}])
        return {"token": rec["token"], "ops": ops, "label": rec["label"]}
    px = _cover(px, bw, bh).copy()
    px[..., 3] = 255
    with open(out, "wb") as fh:
        fh.write(P.png_bytes(px))
    op = {"op": "add_layer", "file": out, "name": name, "x": bx, "y": by}
    if rec["sel"]:
        op["mask"] = "selection"
    if a == "extend":
        op["below"] = "active"
    return {"token": rec["token"], "ops": [op], "label": rec["label"]}


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(s or ""))[:60]
