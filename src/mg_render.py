"""Render a motion-graphics scene from the viewer's Motion panel.

The viewer runs inside ComfyUI's Python and has neither ``agenty_core`` nor Node; the render
(Remotion) is agenty_core's ``mg_render``, which the agentY host runs. So the panel's Render button
is a thin relay, like Render with Atlas (atlas_render.py): this module checks the request and
forwards it to the host's ``/agentY/mg_render`` and back (same ``/agent/host_info`` discovery and
session token). Poll with ``GET`` and the job ``id``.
"""
from __future__ import annotations

import json
import urllib.request

from . import atlas_render
from . import mg_scene_io

RelayError = atlas_render.RelayError
FORMATS = ("mp4", "webm", "mov", "gif")


def clean_request(data) -> dict:
    if not isinstance(data, dict):
        raise RelayError("bad request", 400)
    try:
        path = mg_scene_io.check_path(data.get("path"))
    except ValueError as exc:
        raise RelayError(str(exc), 400)
    fmt = str(data.get("format") or "mp4").lower()
    if fmt not in FORMATS:
        raise RelayError("format is mp4, webm, mov or gif", 400)
    out = {"scene_path": path, "format": fmt}
    try:
        out["scale"] = min(1.0, max(0.1, float(data.get("scale") or 1.0)))
    except (TypeError, ValueError):
        raise RelayError("scale must be a number", 400)
    return out


def call_host(comfy_base: str, method: str, query: str = "", body=None, timeout: float = 30.0) -> dict:
    base, token = atlas_render.host_endpoint(comfy_base)
    url = base + "/agentY/mg_render" + (f"?{query}" if query else "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers[atlas_render.TOKEN_HEADER] = token
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    try:
        status, out = atlas_render._open(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout)
    except Exception:  # noqa: BLE001
        raise RelayError("the agentY host is not running (start it, then press Render again)", 503)
    if status == 404 and method == "POST":
        raise RelayError("the agentY host is too old to render motion graphics (update agentY and restart it)", 503)
    if status == 403:
        raise RelayError("the agentY host refused the viewer (its session token changed: reload the ComfyUI page)", 403)
    if status >= 400:
        raise RelayError(str(out.get("error") or f"the agentY host answered {status}"), status if status < 500 else 502)
    return out if isinstance(out, dict) else {}


def start_render(comfy_base: str, data) -> dict:
    return call_host(comfy_base, "POST", body=clean_request(data))


def render_state(comfy_base: str, job_id: str) -> dict:
    job_id = "".join(c for c in str(job_id or "") if c.isalnum())[:32]
    if not job_id:
        raise RelayError("no render id", 400)
    return call_host(comfy_base, "GET", query=f"id={job_id}")
