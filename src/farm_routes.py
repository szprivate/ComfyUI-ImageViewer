"""The Farm space's routes: the page's GPU farm, relayed to the agentY host's ``/agentY/pool``.

The farm itself (rented vast.ai / RunPod machines, ComfyUIs added by address, the job queue, the spend cap) lives
in agentY-core's ``gpu_pool``, served by the agentY host. This module only passes requests along, so the viewer
holds no provider key, starts no process and reads or writes no file for it:

    GET  /imageviewer/farm                 the farm's state (machines, jobs, spend, settings, which keys are set)
    POST /imageviewer/farm {action, ...}   one of ACTIONS (same_origin, JSON); answered with the new state

A page cannot name where outputs are written (``dest`` is dropped): the host puts them under its own output folder
and into the History.
"""

from __future__ import annotations

import asyncio
import json

ACTIONS = ("offers", "rent", "start", "stop", "terminate", "add_url", "remove", "parity", "submit", "cancel",
           "retry", "remove_job", "settings", "refresh", "open_url", "volume_offers", "create_volume", "resize_volume",
           "delete_volume")
MAX_BODY = 16 * 1024 * 1024
ROUTE = "pool"


def clean_request(body) -> dict:
    """What is forwarded for a POST: a known action and its fields, never a path."""
    if not isinstance(body, dict):
        raise ValueError("the body must be a JSON object")
    action = str(body.get("action") or "")
    if action not in ACTIONS:
        raise ValueError(f"unknown farm action {action!r}")
    out = {k: v for k, v in body.items() if k != "dest"}
    if action == "submit" and not isinstance(body.get("workflow"), dict):
        raise ValueError("submit needs the workflow (API format)")
    return out


def register(add, *, web, path_access):
    from . import atlas_render

    def off(fn, *a, **k):
        return asyncio.get_running_loop().run_in_executor(None, lambda: fn(*a, **k))

    def base_of(request):
        return f"{request.scheme}://{request.host}"

    async def get_state(request):
        try:
            out = await off(atlas_render.call_host, base_of(request), "GET", route=ROUTE, timeout=15.0)
        except atlas_render.RelayError as e:
            # A host that is down or too old is a state the page draws, not an error page.
            return web.json_response({"ok": False, "offline": e.status in (503, 404), "error": str(e)},
                                     status=200 if e.status in (503, 404) else e.status)
        return web.json_response(out)

    async def post_action(request):
        ok, why = path_access.same_origin(request)
        if not ok:
            return web.json_response({"error": why}, status=403)
        if (request.content_length or 0) > MAX_BODY:
            return web.json_response({"error": "the request is too large"}, status=413)
        try:
            body = clean_request(json.loads((await request.read()).decode("utf-8") or "null"))
        except (ValueError, UnicodeDecodeError) as e:
            return web.json_response({"error": str(e)}, status=400)
        try:
            out = await off(atlas_render.call_host, base_of(request), "POST", body=body, route=ROUTE,
                            timeout=120.0)
        except atlas_render.RelayError as e:
            msg = str(e)
            if e.status == 503 and "too old" in msg:
                msg = "the agentY host is too old for the Farm (update agentY and restart it)"
            return web.json_response({"ok": False, "error": msg}, status=e.status)
        return web.json_response(out)

    # the page calls these through api.fetchApi, which asks for /api/imageviewer/farm
    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("GET", f"{prefix}/farm", get_state)
        add("POST", f"{prefix}/farm", post_action)
