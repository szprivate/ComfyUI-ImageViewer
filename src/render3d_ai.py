"""A ComfyUI workflow on the 3D space's render (Sebastian 2026-11-24): the Render panel's AI workflow.

The Render panel (js/imageViewer_previzRenderPanel.js) renders the frame through the render camera as four
passes - ``beauty``, ``depth`` (near = white, nothing = black), ``normals`` (the camera's space, 0..1) and
``mask`` (white where something is) - and runs a workflow of the user's own (the open canvas, a workflow saved
in ComfyUI, a .json file, or one of the prepared ones) over them. The workflow is read as Comp's AI Workflow
node reads it (comp_ai_workflow.inspect): its loaders are its inputs, ``comp:`` titled nodes its parameters,
its first save (or the one titled ``comp:out``) its picture.

Which pass a loader takes (:func:`pass_for`): its name (the ``comp:<name>`` title, else the node's title, else
"src" / "image2" ...) when that names a pass - depth / z / zdepth, normal / normals / n, mask / alpha / matte -
else the beauty; a LoadImageMask takes the mask unless its name says otherwise. A film loader is refused: the
panel renders one frame.

Reference pictures (Sebastian 2026-11-25: "how do we deal with the necessity to add reference images?"): the
panel keeps up to MAX_REFS pictures of its own (a style, a product, a face), sent as ``refs`` (PNG / JPEG data
URLs, in order). A loader named ref / reference / style takes the first, ref2 / reference2 / style2 ... the
next ones (:func:`ref_index`). A ref loader without a picture is taken out of the graph with the links to it,
so the prepared workflows can offer image 3 / image 4 slots that stay empty unless the panel has pictures.

Route (registered by :func:`register`), JSON, same_origin:
    POST /imageviewer/render3d_ai {custom, values?, passes {beauty, depth, normals, mask: PNG data URLs},
                                   frame?, models?}
                                   refs? [data URLs]}
        -> {run, graph, outputs {output node: name}, main, uses {loader name: pass | refN}, seed, refs}; 409 {missing}
The page queues the graph (Paint's queue, with the sign-in) and shows the outputs straight from ComfyUI.
"""
from __future__ import annotations

import base64
import copy
import json
import os
import re
import secrets
import struct

from . import comp_ai_workflow as W
from . import paint_generate as G

PASSES = ("beauty", "depth", "normals", "mask")
ALIASES = {
    "depth": {"depth", "z", "zdepth", "z_depth", "depth_z", "depthmap", "depth_map"},
    "normals": {"normal", "normals", "n", "normalmap", "normal_map", "nrm"},
    "mask": {"mask", "alpha", "matte", "a", "holdout"},
    "beauty": {"beauty", "render", "rgb", "color", "colour", "src", "image", "plate", "rgba"},
}
MAX_PASS_BYTES = 64 * 1024 * 1024
MAX_REFS = 4
REF_NAMES = ("ref", "reference", "style", "refimage", "ref_image", "reference_image")
_DATA = re.compile(r"^data:image/png;base64,(.+)$", re.S)
_DATA_REF = re.compile(r"^data:image/(png|jpeg|webp);base64,(.+)$", re.S)


class RenderAiError(ValueError):
    pass


def ref_index(name):
    """1, 2 ... for a loader that takes a reference picture (ref, ref2, reference_3, style1 ...), else 0."""
    n = re.sub(r"[^a-z0-9_]", "", str(name or "").lower())
    m = re.match(r"^(.*?)_?(\d*)$", n)
    base, num = m.group(1), m.group(2)
    if base not in REF_NAMES:
        return 0
    i = int(num) if num else 1
    return i if 1 <= i <= MAX_REFS else 0


def pass_for(name, kind):
    """The pass a loader named *name* of *kind* (picture | mask | video) takes: a pass, or "refN"."""
    i = ref_index(name) if kind == "picture" else 0
    if i:
        return f"ref{i}"
    n = re.sub(r"[^a-z0-9_]", "", str(name or "").lower())
    for p, names in ALIASES.items():
        if n in names:
            return p
    for p in ("depth", "normals", "mask"):          # depth2, normals_cam, mask_fg ...
        if any(n.startswith(a) for a in ALIASES[p] if len(a) > 2):
            return p
    return "mask" if kind == "mask" else "beauty"


def _png(dataurl):
    m = _DATA.match(str(dataurl or ""))
    if not m:
        raise RenderAiError("a pass is not a PNG data URL")
    raw = base64.b64decode(m.group(1), validate=False)
    if len(raw) > MAX_PASS_BYTES:
        raise RenderAiError("a pass is too large")
    return raw


def _png_size(dataurl):
    """(w, h) of a PNG data URL, from its header; None when it is not one."""
    m = _DATA.match(str(dataurl or ""))
    if not m:
        return None
    raw = base64.b64decode(m.group(1)[:32], validate=False)
    if len(raw) < 24 or raw[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", raw[16:24])
    return (w, h) if w > 0 and h > 0 else None


# What the picture models answer in (Sebastian 2026-11-26: "the workflows take over the
# resolution / aspect ratio of the 3D render, closest possible"): the Gemini family picks a
# ratio and a tier, Seedream and the GPT one the nearest size of their own that keeps the shape.
GEMINI_ASPECTS = (("1:1", 1.0), ("2:3", 2 / 3), ("3:2", 3 / 2), ("3:4", 3 / 4), ("4:3", 4 / 3),
                  ("4:5", 4 / 5), ("5:4", 5 / 4), ("9:16", 9 / 16), ("16:9", 16 / 9), ("21:9", 21 / 9))
GEMINI_NODES = ("GeminiImage2Node", "GeminiNanoBanana2", "GeminiNanoBanana2V2")


def _fit(w, h, lo, hi, mult=1):
    """The closest to w x h that keeps the ratio with both sides in [lo, hi], in `mult` steps."""
    if not (w > 0 and h > 0):
        return None
    k = min(hi / max(w, h), max(lo / min(w, h), 1.0))
    tw, th = w * k, h * k
    if min(tw, th) < lo:                       # a ratio too extreme for the bounds: keep the shape
        k = hi / max(w, h)
        tw, th = w * k, h * k
    if mult > 1:
        tw, th = round(tw / mult) * mult, round(th / mult) * mult
        tw, th = max(lo, tw), max(lo, th)
    return int(max(1, tw)), int(max(1, th))


def apply_render_size(graph, size):
    """Tell the picture models of *graph* to answer in the render's shape and size, as close as they can."""
    if not size:
        return
    w, h = size
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ins = node.get("inputs")
        c = node.get("class_type")
        if not isinstance(ins, dict) or not c:
            continue
        if c == "ByteDanceSeedreamNodeV3":
            lo, hi = (240, 8592) if str(ins.get("model", "")).startswith("seedream 5.5") else (1024, 4512)
            got = _fit(w, h, lo, hi)
            if not got:
                continue
            if "model.size_preset" in ins:
                ins["model.size_preset"] = "Custom"
            if "model.width" in ins:
                ins["model.width"] = got[0]
            if "model.height" in ins:
                ins["model.height"] = got[1]
        elif c in GEMINI_NODES:
            if "aspect_ratio" in ins:
                ins["aspect_ratio"] = min(GEMINI_ASPECTS, key=lambda a: abs(a[1] - w / h))[0]
            if "resolution" in ins:
                ins["resolution"] = "1K" if max(w, h) <= 1024 else "2K" if max(w, h) <= 2048 else "4K"
        elif c in ("OpenAIGPTImageNodeV2", "OpenAIGPTImageNode"):
            got = _fit(w, h, 1024, 3840, 16)
            if not got:
                continue
            pre = "model." if any(str(k).startswith("model.") for k in ins) else ""
            if f"{pre}size" in ins:
                ins[f"{pre}size"] = "Custom"
            if f"{pre}custom_width" in ins:
                ins[f"{pre}custom_width"] = got[0]
            if f"{pre}custom_height" in ins:
                ins[f"{pre}custom_height"] = got[1]


def _ref(dataurl):
    m = _DATA_REF.match(str(dataurl or ""))
    if not m:
        raise RenderAiError("a reference picture is not a PNG, JPEG or WebP data URL")
    raw = base64.b64decode(m.group(2), validate=False)
    if len(raw) > MAX_PASS_BYTES:
        raise RenderAiError("a reference picture is too large")
    return raw, {"jpeg": "jpg"}.get(m.group(1), m.group(1))


def drop_nodes(graph, gone):
    """Take nodes *gone* out of *graph*, and every input that links to one of them."""
    gone = {str(k) for k in gone}
    for k in gone:
        graph.pop(k, None)
    for node in graph.values():
        ins = node.get("inputs") or {}
        for n in [n for n, x in ins.items() if isinstance(x, list) and len(x) == 2 and str(x[0]) in gone]:
            del ins[n]


def prepare(custom, passes, input_dir, *, values=None, frame=0, folder_paths=None, node_classes=None, models=None,
            refs=None, size=None):
    """The workflow filled in with the passes: {run, graph, outputs {node: name}, main, uses, seed, label}."""
    if not isinstance(custom, dict) or not isinstance(custom.get("graph"), dict):
        raise RenderAiError("no workflow: take one from the canvas, a saved workflow, a file or the prepared list")
    graph = W.clean_graph(custom["graph"])
    if len(json.dumps(graph)) > G.MAX_GRAPH_BYTES:
        raise RenderAiError("that workflow is too large")
    info = W.inspect(graph)
    if not info["outputs"]:
        raise RenderAiError("the workflow saves nothing: it needs a SaveImage, PreviewImage or Send to Image Viewer "
                            "(title it comp:out if there are several)")
    film = [x["name"] for x in info["inputs"] if x["kind"] == "video"]
    if film:
        raise RenderAiError(f"{film[0]} takes a film: the Render panel runs one frame (sequences come later)")
    G.apply_models(graph, models if isinstance(models, dict) else None, folder_paths)
    gone = G.missing(graph, folder_paths, node_classes)
    if gone:
        raise G.Missing(gone)
    passes = passes if isinstance(passes, dict) else {}
    run = secrets.token_hex(6)
    rel_dir = f"paint/render3d_{run}"
    folder = os.path.join(input_dir, *rel_dir.split("/"))
    f = max(0, int(frame or 0))
    refs = [r for r in (refs if isinstance(refs, list) else []) if r][:MAX_REFS]
    written, uses, unused = {}, {}, []
    for x in info["inputs"]:
        p = pass_for(x["name"], x["kind"])
        if p.startswith("ref"):
            i = int(p[3:])
            if i > len(refs):
                unused.append(x["node"])          # no picture for it: the slot goes
                continue
            if p not in written:
                raw, ext = _ref(refs[i - 1])
                os.makedirs(folder, exist_ok=True)
                name = f"{p}.{ext}"
                with open(os.path.join(folder, name), "wb") as fh:
                    fh.write(raw)
                written[p] = f"{rel_dir}/{name}"
            graph[x["node"]]["inputs"]["image"] = written[p]
            uses[x["name"]] = p
            continue
        if p not in written:
            if not passes.get(p):
                raise RenderAiError(f"the {p} pass was not rendered (render the frame again)")
            os.makedirs(folder, exist_ok=True)
            name = f"{p}.{f:04d}.png"
            with open(os.path.join(folder, name), "wb") as fh:
                fh.write(_png(passes[p]))
            written[p] = f"{rel_dir}/{name}"
        node = graph[x["node"]]
        node["inputs"]["image"] = written[p]
        if x["kind"] == "mask":
            node["inputs"]["channel"] = "red"          # the mask pass is white where something is
        uses[x["name"]] = p
    drop_nodes(graph, unused)
    # The models answer in the render's own shape and size, as close as each of them can
    # (Sebastian 2026-11-26); a layer may ask for a size of its own, else the beauty pass's
    # (the region's own when a region is rendered).
    want = size if isinstance(size, (list, tuple)) and len(size) == 2 and all(isinstance(v, (int, float)) and v > 0 for v in size) else None
    apply_render_size(graph, want or _png_size(passes.get("beauty")))
    vals = values if isinstance(values, dict) else {}
    for prm in custom.get("params") or []:
        k, inp = prm.get("node"), prm.get("input")
        if k not in graph or inp not in (graph[k].get("inputs") or {}):
            continue
        v = vals.get(prm.get("id"), prm.get("def"))
        kind = prm.get("kind")
        try:
            if kind == "int":
                v = int(round(float(v)))
            elif kind == "num":
                v = float(v)
            elif kind == "bool":
                v = v in (True, "on", "true", 1)
        except (TypeError, ValueError):
            v = prm.get("def")
        if isinstance(v, (str, int, float, bool)):
            graph[k]["inputs"][inp] = v
    seed = secrets.randbelow(G.SEED_MAX + 1)
    for k, inp in info["seeds"]:
        if k in graph:
            graph[k]["inputs"][inp] = seed
    outputs = {}
    for o in info["outputs"]:
        ins = graph[o["node"]].get("inputs") or {}
        if "filename_prefix" in ins:
            ins["filename_prefix"] = f"render3d/ai/{run}/{G.safe_name(o['name']) or 'out'}.{f:04d}"
        outputs[o["node"]] = o["name"]
    return {"run": run, "graph": copy.deepcopy(graph), "outputs": outputs, "main": info["outputs"][0]["name"],
            "uses": uses, "refs": sum(1 for p in written if p.startswith("ref")), "seed": seed, "label": custom.get("name") or "My workflow", "nodes": len(graph)}


def register(add, *, web, path_access, folder_paths):
    """Add the route through ``add(method, path, handler)``, under /imageviewer and /api/imageviewer."""
    import asyncio

    def node_classes():
        try:
            import nodes  # ComfyUI's own
            return set(nodes.NODE_CLASS_MAPPINGS)
        except Exception:  # noqa: BLE001 - not inside ComfyUI
            return None

    async def run_ai(request):
        ok, why = path_access.same_origin(request)
        if not ok:
            return web.json_response({"error": why}, status=403)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "the body must be a JSON object"}, status=400)
        try:
            res = await asyncio.get_running_loop().run_in_executor(None, lambda: prepare(
                body.get("custom"), body.get("passes"), folder_paths.get_input_directory(),
                values=body.get("values"), frame=body.get("frame") or 0, folder_paths=folder_paths,
                node_classes=node_classes(), models=body.get("models"), refs=body.get("refs"),
                size=body.get("size")))
        except G.Missing as e:
            return web.json_response({"error": str(e), "missing": e.missing}, status=409)
        except (RenderAiError, W.WorkflowError, G.GenerateError, ValueError, OSError) as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response(res)

    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("POST", f"{prefix}/render3d_ai", run_ai)
