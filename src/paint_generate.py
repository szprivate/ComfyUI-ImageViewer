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
- ``paint:prompt`` - the node whose ``text`` / ``prompt`` (a partner node: ``model.prompt``) gets the words.
- ``paint:output`` - the SaveImage / PreviewImage whose picture comes back.
- every ``seed`` / ``noise_seed`` / ``model.seed`` gets a new number each run (below 2^31).

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

ACTIONS = ("fill", "remove", "extend", "edit", "background", "select_subject", "select_objects", "upscale")
LABELS = {"fill": "Generative fill", "remove": "Remove object", "extend": "Extend (fill the new border)",
          "edit": "Edit with a prompt", "background": "Remove background", "select_subject": "Select foreground",
          "select_objects": "Select objects", "upscale": "Upscale with detail"}
# A model that takes no mask (an edit model) is shown the place to change as a flat grey, and told so;
# its picture is then laid in through the selection, so nothing outside it changes.
GREY = 128
GREY_PROMPTS = {
    "fill": "In the flat grey area, make {prompt}. Keep everything outside the grey area exactly as it is, and match its "
            "light, perspective and style.",
    "remove": "Fill the flat grey area so that it matches what is around it, as if nothing had ever been there. Keep "
              "everything else exactly as it is.",
    "extend": "Continue the picture into the flat grey border seamlessly: the same scene, light and style{prompt_tail}. "
              "Keep the middle exactly as it is.",
}
MATTES = ("background", "select_subject", "select_objects")
FRONTEND_ONLY = {"Note", "MarkdownNote", "Reroute", "PrimitiveNode"}
DOWNLOAD_HOSTS = ("huggingface.co",)
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
PROMPT_INPUTS = ("prompt", "text", "model.prompt")   # model.*: a partner node's inputs behind its model choice
SEED_INPUTS = ("seed", "noise_seed", "model.seed")
SEED_MAX = 2 ** 31 - 1   # the partner nodes take no more (Qwen, Seedream); KSampler takes anything
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
    """(entry, workflow) of a built-in: the workflow in the API format, or as the canvas has it ("ui")."""
    for e in builtins():
        if e["id"] == wid:
            with open(os.path.join(BUILTIN_DIR, e["file"]), encoding="utf-8") as fh:
                return e, json.load(fh)
    return None, None


def workflow_file(wid):
    """What the page turns into a prompt (or reads its settings from): {id, label, format, workflow, action...}."""
    e, g = _builtin(wid)
    if not e:
        raise GenerateError(f"no built-in workflow {wid!r}")
    return {"id": e["id"], "label": e["label"], "format": e.get("format", "api"), "workflow": g,
            "tune": e.get("tune") or [], "api": bool(e.get("api"))}


def installed(e, node_classes):
    """Whether this ComfyUI has every node the built-in *e* uses (None: not known - the tests)."""
    if node_classes is None:
        return True
    return all(n in node_classes or n in FRONTEND_ONLY for n in e.get("nodes") or [])


def _models_dir(folder_paths):
    return getattr(folder_paths, "models_dir", None) if folder_paths is not None else None


def missing_models(e, folder_paths):
    """The model files the built-in *e* names (from its template) that are not here: [{what, kind, folder, url}]."""
    out = []
    if folder_paths is None:
        return out
    for m in e.get("models") or []:
        if not locate(folder_paths, m.get("directory") or "", m["name"]):
            out.append({"what": m["name"], "kind": "model", "folder": m.get("directory") or "", "url": m.get("url") or ""})
    return out


def first_run_downloads(e, folder_paths):
    """What a node pack fetches for itself on its first run (ComfyUI-RMBG): the folders not there yet."""
    base = _models_dir(folder_paths)
    if not base:
        return []
    return [p for p in e.get("downloads_itself") or [] if not os.path.isdir(os.path.join(base, *p.split("/")))]


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


def default_for(action, node_classes=None):
    for e in builtins():
        if action in e["actions"] and installed(e, node_classes):
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


def _prompt_input(ins, prefer=None):
    """Which input of a prompt node takes the words: *prefer*, a known name, else one ending in "prompt"."""
    if prefer and isinstance(ins.get(prefer), str):
        return prefer
    name = next((n for n in PROMPT_INPUTS if isinstance(ins.get(n), str)), None)
    if name:
        return name
    return next((n for n, v in ins.items() if isinstance(v, str) and n.lower().endswith("prompt") and "neg" not in n.lower()), None)


def detect_slots(graph, prompt_input=None):
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
            for name in PROMPT_INPUTS:
                if isinstance(ins.get(name), str) and graph[k]["class_type"] not in IMAGE_LOADERS:
                    cands.append((0 if ("prompt" in t or "positive" in t) else 1, 0 if ins[name].strip() else 1, k))
                    break
        p = min(cands)[2] if cands else None
    if p is not None:
        name = _prompt_input(graph[p].get("inputs", {}), prompt_input)
        out["prompt"] = [p, name] if name else None
    outs = [k for k in ids if graph[k]["class_type"] in OUTPUTS]
    out["output"] = by_title.get("output") or (outs[-1] if outs else None)
    for k in ids:
        for name, v in (graph[k].get("inputs") or {}).items():
            if name in SEED_INPUTS and isinstance(v, (int, float)) and not isinstance(v, bool):
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


def resolve_workflow(action, wid=None, graph=None):
    """(entry, graph) for *action*: the workflow *wid* (a built-in id or "custom"), else the chosen one. A built-in
    kept as the canvas has it is turned into a prompt by ComfyUI's own page: *graph* is that prompt."""
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
    if e.get("format") == "ui":
        if isinstance(graph, dict) and isinstance(graph.get("output"), dict):
            graph = graph["output"]
        if not is_api_graph(graph):
            raise GenerateError("the page did not send this workflow as a prompt (reload the page: an older one may be cached)")
        if len(json.dumps(graph)) > MAX_GRAPH_BYTES:
            raise GenerateError("that workflow is too large")
        return e, copy.deepcopy(graph)
    return e, g


class _Remembered:
    """ComfyUI's folder_paths for one pass: each folder's listing and each lookup asked once (a folder on a
    network drive is slow to list, and a listing asks about the same model folders dozens of times)."""

    def __init__(self, fp):
        self._fp, self._full, self._lists = fp, {}, {}
        self.models_dir = getattr(fp, "models_dir", None)

    def get_full_path(self, folder, name):
        k = (folder, name)
        if k not in self._full:
            self._full[k] = self._fp.get_full_path(folder, name)
        return self._full[k]

    def get_filename_list(self, folder):
        if folder not in self._lists:
            self._lists[folder] = self._fp.get_filename_list(folder)
        return self._lists[folder]

    def get_folder_paths(self, folder):
        return self._fp.get_folder_paths(folder)


def _entry_item(e, folder_paths, node_classes):
    if e.get("format") == "ui":
        gone = missing_models(e, folder_paths)
    else:
        _e, g = _builtin(e["id"])
        gone = missing(g, folder_paths, node_classes)
        urls = {m["name"]: m for m in e.get("models") or []}
        for m in gone:
            if m["what"] in urls:
                m["url"] = urls[m["what"]].get("url") or ""
    return {"id": e["id"], "label": e["label"], "api": bool(e.get("api")), "from": e.get("from", ""),
            "format": e.get("format", "api"), "missing": gone, "tune": e.get("tune") or [],
            "mask": bool(e.get("mask_in")), "first_run": first_run_downloads(e, folder_paths),
            "scale": e.get("scale") or None, "optional": e.get("optional") or []}


def listing(folder_paths=None, node_classes=None):
    """What Settings and the Generate menus show: per action its workflows, the chosen one and the user's own.
    A built-in whose nodes this ComfyUI does not have (a node pack not installed) is left out; one whose model
    files are not here is listed with them (`missing`, with where they come from, so the page can offer them).
    Each built-in is looked at once, however many actions it serves, and each model folder listed once."""
    if folder_paths is not None:
        folder_paths = _Remembered(folder_paths)
    ch = choices()
    table = builtins()
    seen = {}
    out = {}
    for a in ACTIONS:
        items = []
        for e in table:
            if a not in e["actions"] or not installed(e, node_classes):
                continue
            if e["id"] not in seen:
                seen[e["id"]] = _entry_item(e, folder_paths, node_classes)
            items.append(copy.deepcopy(seen[e["id"]]))
        c = custom(a)
        mine = None
        if c:
            mine = {"name": c.get("name"), "source": c.get("source"), "saved": c.get("saved"),
                    "slots": detect_slots(c["graph"]), "missing": missing(c["graph"], folder_paths, node_classes)}
        choice = ch[a]
        if choice not in {w["id"] for w in items} | {AGENT, CUSTOM}:
            choice = items[0]["id"] if items else AGENT          # the chosen one is not installed here
        out[a] = {"label": LABELS[a], "choice": choice, "default": default_for(a, node_classes), "workflows": items,
                  "custom": mine}
    return {"actions": out, "folder": user_folder()}


def ref_node(graph, ref):
    """The node *ref* names in an API graph: its id, else the node of that title (``paint:tune``)."""
    ref = str(ref)
    if ref in graph:
        return ref
    want = ref.strip().lower()
    return next((k for k, v in graph.items() if _title(v) == want), None)


def drop_nodes(graph, ids):
    """Take nodes out of an API graph, and every input that comes from them (the inputs they fed are optional)."""
    ids = set(ids)
    for k in ids:
        graph.pop(k, None)
    for v in graph.values():
        ins = v.get("inputs") or {}
        for name in [n for n, x in ins.items() if isinstance(x, list) and len(x) == 2 and str(x[0]) in ids]:
            del ins[name]


def apply_tune(graph, tune):
    """The dialog's settings: {node ref: {input: value}} onto plain (unlinked) inputs that are there."""
    done = []
    for ref, vals in (tune or {}).items():
        k = ref_node(graph, ref)
        if not k or not isinstance(vals, dict):
            continue
        ins = graph[k].setdefault("inputs", {})
        for name, v in vals.items():
            if name not in ins or isinstance(ins[name], list):
                continue                          # not an input of the node, or a link: not a setting
            if isinstance(v, (str, int, float, bool)) or v is None:
                ins[name] = v
                done.append([k, name])
    return done


# ── one run ──────────────────────────────────────────────────────────────────

_JOBS = {}
_LOCK = threading.Lock()


def _work_size(w, h, size):
    """The size the model works at for a w x h crop: about mp megapixels (or as it is), a multiple of mult, within max."""
    mp, mult, mx = size.get("mp"), max(1, int(size.get("mult") or 1)), int(size.get("max") or 2048)
    mn = int(size.get("min") or 0)
    s = math.sqrt(mp * 1e6 / (w * h)) if mp else 1.0
    if mn:
        s = max(s, mn / min(w, h))   # the model's shortest side (Seedream: 1024)
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


def _refs_set(graph, ref, name, value):
    k = ref_node(graph, ref)
    if k and name:
        graph[k].setdefault("inputs", {})[name] = value
    return k


def prepare(s, token, action, input_dir, *, wid=None, prompt="", variations=1, k=2, folder_paths=None,
            node_classes=None, graph=None, tune=None, box=None):
    """The workflow for one Generate, filled in: {job, graphs, output, label, box, api, filled}.

    *graph*: the prompt ComfyUI's page made of a canvas-format built-in; *tune*: the dialog's settings
    ({node ref: {input: value}}); *box*: for Select objects, whether the selection's box goes in."""
    if action not in ACTIONS:
        raise GenerateError(f"unknown action {action!r}")
    entry, graph = resolve_workflow(action, wid, graph)
    gone = missing(graph, folder_paths, node_classes)
    if gone:
        urls = {m["name"]: m for m in entry.get("models") or []}
        for m in gone:
            if m["what"] in urls:
                m["url"] = urls[m["what"]].get("url") or ""
        raise Missing(gone)
    slots = detect_slots(graph, entry.get("prompt_input"))
    if not slots["image"] or not slots["output"]:
        raise GenerateError("the workflow has no picture input or no output")
    doc = s.doc
    words = str(prompt or "").strip()
    sb_any = doc.selection is not None and doc.selection.any()
    if action == "select_objects":
        use_box = bool(box) and sb_any
        if not words and not use_box:
            raise GenerateError("say what to select, or select around it and take the selection's box")
    (bx, by, bw, bh), sb = crop_box(doc, action)
    tw, th = _work_size(bw, bh, entry.get("size") or {})
    pic = P.composite(doc)[by:by + bh, bx:bx + bw].copy()
    sel = doc.selection[by:by + bh, bx:bx + bw] if (sb and action in MASKED + ("edit",)) else None
    if (tw, th) != (bw, bh):
        pic = O._resize(pic, tw, th)
        if sel is not None:
            sel = O._resize(np.ascontiguousarray(sel), tw, th, "bilinear")
    grey = sel is not None and action in MASKED and not entry.get("mask_in") and entry.get("id") != CUSTOM
    if grey:
        # The model sees the place as a flat grey (it takes no mask); the picture comes back through the selection.
        a = (sel.astype(np.float32) / 255.0)[..., None]
        pic[..., :3] = np.clip(pic[..., :3].astype(np.float32) * (1 - a) + GREY * a + 0.5, 0, 255).astype(np.uint8)
    pic[..., 3] = 255 if (sel is None or grey) else (255 - sel)
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
    default_words = (entry.get("prompts") or {}).get(action, "")
    text = words or default_words
    if action == "fill" and not words:
        raise GenerateError("say what to make")
    if action == "edit" and not words:
        raise GenerateError("say what to change")
    if grey and action in GREY_PROMPTS and not (entry.get("prompts") or {}).get(action):
        text = GREY_PROMPTS[action].format(prompt=words, prompt_tail=(": " + words) if words else "")
    g0 = graph
    gi = g0[slots["image"]]["inputs"]
    gi["image"] = f"paint/{name}"
    if slots["mask"]:
        mi = g0[slots["mask"]]["inputs"]
        mi["image"] = f"paint/{mask_name}"
        if slots["mask_kind"] == "LoadImageMask":
            mi["channel"] = "red"
    optional = [str(x) for x in entry.get("optional") or []]
    drop = []
    if slots["prompt"] and slots["prompt"][1]:
        if not text and "paint:prompt" in optional:
            drop.append(slots["prompt"][0])
        else:
            g0[slots["prompt"][0]]["inputs"][slots["prompt"][1]] = text
    if action == "select_objects":
        kb = ref_node(g0, "paint:box")
        if kb and use_box:
            x, y, w, h = M.mask_bbox(doc.selection)
            sx, sy = tw / bw, th / bh
            g0[kb]["inputs"].update({"x": int(round((x - bx) * sx)), "y": int(round((y - by) * sy)),
                                     "width": max(1, int(round(w * sx))), "height": max(1, int(round(h * sy)))})
        elif kb:
            drop.append(kb)
    for ref, inp, val in (entry.get("set") or {}).get(action, []) + (entry.get("set") or {}).get("*", []):
        _refs_set(g0, ref, inp, val)
    if entry.get("aspect"):
        _refs_set(g0, entry["aspect"][0], entry["aspect"][1], _aspect(tw, th))
    if entry.get("dims"):
        kd = ref_node(g0, entry["dims"][0])
        if kd:
            g0[kd]["inputs"][entry["dims"][1]], g0[kd]["inputs"][entry["dims"][2]] = tw, th
    if entry.get("scale") and action == "upscale":
        sc = entry["scale"]
        _refs_set(g0, sc[0], sc[1], int(k) if len(sc) > 2 and sc[2] == "number" else f"{int(k)}x")
    tuned = apply_tune(g0, tune)
    if drop:
        drop_nodes(g0, drop)
    out_node = g0[slots["output"]]
    if "filename_prefix" in out_node.get("inputs", {}):
        out_node["inputs"]["filename_prefix"] = f"paint/generate/{action}"
    graphs = []
    for _ in range(max(1, min(4, int(variations or 1)))):
        g = copy.deepcopy(g0)
        for nid, inp in slots["seeds"]:
            if nid in g:
                g[nid]["inputs"][inp] = secrets.randbelow(SEED_MAX + 1)
        graphs.append(g)
    label = f"{LABELS[action]}: {words[:40]}" if words else LABELS[action]
    rec = {"token": token, "action": action, "box": [bx, by, bw, bh], "sel": bool(sb) and action not in MATTES,
           "k": int(k or 2), "label": label, "name": (words[:30] or LABELS[action]), "w": doc.w, "h": doc.h, "at": time.time()}
    with _LOCK:
        _JOBS[job] = rec
        while len(_JOBS) > MAX_JOBS:
            _JOBS.pop(next(iter(_JOBS)))
    return {"job": job, "graphs": graphs, "output": slots["output"], "label": label, "box": rec["box"],
            "api": bool(entry.get("api")), "workflow": entry.get("label"), "size": [tw, th], "grey": grey,
            "tuned": tuned, "dropped": drop}


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


def matte_of(px):
    """The matte in a workflow's picture (white = the subject): its transparency when it has any (a cut-out, as
    the partner nodes answer), else its brightness (a mask saved as a picture)."""
    if px.ndim == 3 and px.shape[2] == 4 and int(px[..., 3].min()) < 255:
        return np.ascontiguousarray(px[..., 3])
    rgb = px[..., :3].astype(np.float32)
    return np.clip(rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114 + 0.5, 0, 255).astype(np.uint8)


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
    if a in MATTES:
        m = matte_of(_cover(px, rec["w"], rec["h"]))
        with open(out, "wb") as fh:
            fh.write(P.png_bytes(m))
        ops = ([{"op": "mask", "layer": "active", "from": "file", "file": out}] if a == "background"
               else [{"op": "select", "mode": "file", "file": out}])
        if a == "select_objects" and not m.any():
            raise GenerateError("nothing was found to select")
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


# ── model files a built-in needs: offered, fetched only when asked ────────────

_DOWNLOADS = {}
CHUNK = 1 << 20


def _safe_model_name(name):
    parts = str(name).replace("\\", "/").split("/")
    if not name or any(p in ("", ".", "..") for p in parts) or os.path.isabs(str(name)) or ":" in str(name):
        raise GenerateError(f"not a model file name: {name!r}")
    return "/".join(parts)


def _allowed_url(url):
    from urllib.parse import urlparse
    u = urlparse(str(url or ""))
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host == h or host.endswith("." + h) for h in DOWNLOAD_HOSTS)


def _target(folder_paths, directory, name):
    try:
        folders = folder_paths.get_folder_paths(directory)
    except Exception:  # noqa: BLE001 - an unknown folder name
        folders = []
    if not folders:
        raise GenerateError(f"ComfyUI has no model folder {directory!r}")
    return os.path.join(folders[0], *_safe_model_name(name).split("/"))


def _size_of(url, timeout=10):
    """Content-Length of *url* (a HEAD, redirects followed), or None."""
    import urllib.request
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "ComfyUI-ImageViewer"})
        with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310 - https to the hosts allowed only
            n = r.headers.get("Content-Length")
            return int(n) if n and n.isdigit() else None
    except Exception:  # noqa: BLE001 - offline, refused: the size is not known
        return None


_SIZES = {}


def _sizes(files):
    """Each file's size, asked of the host all at once (a few seconds at most), remembered for the process."""
    from concurrent.futures import ThreadPoolExecutor
    ask = [f["url"] for f in files if f["url"] not in _SIZES]
    if ask:
        with ThreadPoolExecutor(max_workers=min(8, len(ask))) as pool:
            for url, n in zip(ask, pool.map(lambda u: _size_of(u, timeout=4), ask)):
                if n:
                    _SIZES[url] = n
    for f in files:
        f["size"] = _SIZES.get(f["url"])


def download_plan(wid, folder_paths, sizes=True):
    """What a built-in still needs: {id, label, files: [{name, folder, url, size, to}], total, unknown}."""
    e, _g = _builtin(wid)
    if not e:
        raise GenerateError(f"no built-in workflow {wid!r}")
    files = []
    for m in missing_models(e, folder_paths) if e.get("format") == "ui" else [
            dict(x, url=next((y.get("url") for y in e.get("models") or [] if y["name"] == x["what"]), ""))
            for x in missing(_builtin(wid)[1], folder_paths, None)]:
        url = m.get("url") or ""
        f = {"name": m["what"], "folder": m.get("folder") or "", "url": url if _allowed_url(url) else "", "size": None}
        if f["url"]:
            try:
                f["to"] = _target(folder_paths, f["folder"], f["name"])
            except GenerateError:
                f["url"] = ""
        files.append(f)
    if sizes:
        _sizes([f for f in files if f["url"]])
    total = sum(f["size"] or 0 for f in files if f["url"])
    return {"id": e["id"], "label": e["label"], "files": files, "total": total,
            "unknown": [f["name"] for f in files if not f["url"]], "first_run": first_run_downloads(e, folder_paths)}


def start_download(wid, folder_paths):
    """Fetch the files of :func:`download_plan` in a thread of its own: the job's id."""
    plan = download_plan(wid, folder_paths, sizes=False)
    files = [f for f in plan["files"] if f["url"]]
    if not files:
        raise GenerateError("nothing to download" if not plan["unknown"] else
                            "these are not offered for download: " + ", ".join(plan["unknown"]))
    job = secrets.token_hex(8)
    st = {"id": job, "workflow": wid, "files": [dict(f, done=0, state="waiting") for f in files], "state": "running",
          "error": None, "cancel": False}
    with _LOCK:
        _DOWNLOADS[job] = st
    threading.Thread(target=_download_all, args=(st,), daemon=True).start()
    return job


def start_file_download(files, folder_paths, what="models"):
    """Fetch named files ([{name, folder, url}]; Hugging Face only, into ComfyUI's model folders) in a
    thread of its own, as start_download does for a built-in: the job's id (download_status polls it)."""
    todo = []
    for f in files:
        if not _allowed_url(f.get("url")):
            raise GenerateError(f"not offered for download: {f.get('name')}")
        todo.append({"name": _safe_model_name(f["name"]), "folder": f["folder"], "url": f["url"], "size": None,
                     "to": _target(folder_paths, f["folder"], f["name"]), "done": 0, "state": "waiting"})
    if not todo:
        raise GenerateError("nothing to download")
    job = secrets.token_hex(8)
    st = {"id": job, "workflow": what, "files": todo, "state": "running", "error": None, "cancel": False}
    with _LOCK:
        _DOWNLOADS[job] = st
    threading.Thread(target=_download_all, args=(st,), daemon=True).start()
    return job


def _download_all(st):
    import urllib.request
    for f in st["files"]:
        if st["cancel"]:
            break
        tmp = f"{f['to']}.partial-{st['id']}"
        try:
            os.makedirs(os.path.dirname(f["to"]), exist_ok=True)
            if os.path.exists(f["to"]):
                f["state"] = "there"
                continue
            f["state"] = "fetching"
            req = urllib.request.Request(f["url"], headers={"User-Agent": "ComfyUI-ImageViewer"})
            with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as fh:   # noqa: S310 - hosts allowed only
                n = r.headers.get("Content-Length")
                f["size"] = int(n) if n and n.isdigit() else f.get("size")
                while not st["cancel"]:
                    b = r.read(CHUNK)
                    if not b:
                        break
                    fh.write(b)
                    f["done"] += len(b)
            if st["cancel"]:
                os.remove(tmp)
                f["state"] = "stopped"
                break
            os.replace(tmp, f["to"])
            f["state"] = "done"
        except Exception as e:  # noqa: BLE001 - said in the job's state
            try:
                os.remove(tmp)
            except OSError:
                pass
            f["state"] = "failed"
            st["error"] = f"{f['name']}: {e}"
            break
    st["state"] = "stopped" if st["cancel"] else ("failed" if st["error"] else "done")


def download_status(job, cancel=False):
    with _LOCK:
        st = _DOWNLOADS.get(job)
    if not st:
        raise GenerateError("no such download")
    if cancel:
        st["cancel"] = True
    return {k: v for k, v in st.items() if k != "cancel"} | {"files": [{k: v for k, v in f.items() if k != "to"} for f in st["files"]]}
