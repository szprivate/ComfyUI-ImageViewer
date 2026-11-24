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

Route (registered by :func:`register`), JSON, same_origin:
    POST /imageviewer/render3d_ai {custom, values?, passes {beauty, depth, normals, mask: PNG data URLs},
                                   frame?, models?}
        -> {run, graph, outputs {output node: name}, main, uses {loader name: pass}, seed}; 409 {missing}
The page queues the graph (Paint's queue, with the sign-in) and shows the outputs straight from ComfyUI.
"""
from __future__ import annotations

import base64
import copy
import json
import os
import re
import secrets

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
_DATA = re.compile(r"^data:image/png;base64,(.+)$", re.S)


class RenderAiError(ValueError):
    pass


def pass_for(name, kind):
    """The pass a loader named *name* of *kind* (picture | mask | video) takes."""
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


def prepare(custom, passes, input_dir, *, values=None, frame=0, folder_paths=None, node_classes=None, models=None):
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
    written, uses = {}, {}
    for x in info["inputs"]:
        p = pass_for(x["name"], x["kind"])
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
            "uses": uses, "seed": seed, "label": custom.get("name") or "My workflow", "nodes": len(graph)}


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
                node_classes=node_classes(), models=body.get("models")))
        except G.Missing as e:
            return web.json_response({"error": str(e), "missing": e.missing}, status=409)
        except (RenderAiError, W.WorkflowError, G.GenerateError, ValueError, OSError) as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response(res)

    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("POST", f"{prefix}/render3d_ai", run_ai)
