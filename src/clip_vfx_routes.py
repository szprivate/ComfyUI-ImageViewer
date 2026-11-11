"""Routes of the History's VFX actions on a clip (clip_vfx.py).

    GET  /imageviewer/clip_vfx                       what is offered: actions, reframe presets, upscale sizes
    POST /imageviewer/clip_vfx/prepare {source: {path} | {filename, type, subfolder}, action, options}
                                                     -> {job, label, graphs, output, runs, used, frames, left_out,
                                                         note}; 409 {missing} when a model or node is not here
    POST /imageviewer/clip_vfx/finish {job, results: [{filename, type, subfolder}]}
                                                     -> {path, exr} (the runs' mattes joined for a long alpha clip)

Both POSTs are ``path_access.same_origin`` JSON. The source must be a film the viewer may serve
(``may_serve``); the results are ComfyUI's own output references, resolved inside the folder they name.
"""
from __future__ import annotations

import os

from . import clip_vfx as V


def register(add, *, web, path_access, folder_paths, resolve):
    import asyncio

    def off(fn, *a, **k):
        return asyncio.get_running_loop().run_in_executor(None, lambda: fn(*a, **k))

    def node_classes():
        try:
            import nodes  # ComfyUI's own
            return set(nodes.NODE_CLASS_MAPPINGS)
        except Exception:  # noqa: BLE001 - not inside ComfyUI (the tests): no check
            return None

    async def body_of(request):
        ok, why = path_access.same_origin(request)
        if not ok:
            raise web.HTTPForbidden(text=why)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        if not isinstance(body, dict):
            raise web.HTTPBadRequest(text="the body must be a JSON object")
        return body

    def comfy_ref(ref):
        if not isinstance(ref, dict) or not ref.get("filename"):
            return None
        try:
            base = folder_paths.get_directory_by_type(ref.get("type") or "output")
        except Exception:  # noqa: BLE001
            base = None
        if not base:
            return None
        p = os.path.abspath(os.path.join(base, str(ref.get("subfolder") or ""), str(ref["filename"])))
        return p if path_access.within(p, base) else None

    def err(e):
        if isinstance(e, V.VfxError):
            return web.json_response({"error": str(e), **e.extra}, status=e.status)
        return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)

    async def h_list(_request):
        return web.json_response(V.actions())

    async def h_prepare(request):
        body = await body_of(request)
        src = body.get("source")
        if isinstance(src, str):
            src = {"path": src}
        path = None
        if isinstance(src, dict):
            path = resolve(str(src["path"])) if src.get("path") else comfy_ref(src)
        if not path or not os.path.isfile(path):
            return web.json_response({"error": "no such film"}, status=404)
        if not path_access.may_serve(path):
            return web.json_response({"error": path_access.serve_refusal(path)}, status=403)
        try:
            res = await off(V.prepare, path, str(body.get("action") or ""), body.get("options"),
                            folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                            folder_paths=folder_paths, node_classes=node_classes(),
                            may_use=path_access.may_serve)
        except Exception as e:  # noqa: BLE001
            return err(e)
        return web.json_response(res)

    async def h_finish(request):
        body = await body_of(request)
        refs = body.get("results")
        if not isinstance(refs, list) or not refs:
            return web.json_response({"error": "send the results"}, status=400)
        paths = [comfy_ref(r) for r in refs[:64]]
        try:
            res = await off(V.finish, str(body.get("job") or ""), paths, folder_paths.get_output_directory(),
                            may_use=path_access.may_serve)
        except Exception as e:  # noqa: BLE001
            return err(e)
        return web.json_response(res)

    for method, path, h in (("GET", "clip_vfx", h_list), ("POST", "clip_vfx/prepare", h_prepare),
                            ("POST", "clip_vfx/finish", h_finish)):
        add(method, "/imageviewer/" + path, h)
        add(method, "/api/imageviewer/" + path, h)
