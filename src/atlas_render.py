"""Render a view of a World Labs Atlas world from the camera the viewer is looking through.

The viewer runs inside ComfyUI's Python: it has neither ``agenty_core`` (the shared tool layer that
talks to Atlas) nor the World Labs key. Both live in the agentY host, so the viewer's "Render with
Atlas" button is a thin relay: this module checks the request and forwards it to the host's
``/agentY/atlas_render`` and back. The host finds the camera frame conversion, the Atlas call, the
upscale and the files; this side only knows where the host is.

Where the host is, and the session token it wants on every call, come from the agentY ComfyUI
extension's ``/agent/host_info`` on the same ComfyUI (so nothing here is configured). Without that
extension there is nothing to relay to, and the answer says so.

No aiohttp or ComfyUI in here, so it can be tested on its own.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

TOKEN_HEADER = "X-AgentY-Token"
UPSCALES = (0, 2, 4)
CAMERA_KEYS = ("camera_world", "model_world", "fov", "aspect", "gated")


class RelayError(Exception):
    """Something to tell the user, with the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def world_dir_of(path) -> str:
    """The Atlas world folder for a ``world.glb`` (or the folder / ``world.json``) path, checked on disk."""
    p = os.path.abspath(os.path.expanduser(str(path or "").strip().strip('"')))
    if os.path.isfile(p):
        p = os.path.dirname(p)
    if not os.path.isfile(os.path.join(p, "world.json")):
        raise RelayError("this model is not an Atlas world (no world.json beside it)", 400)
    return p


def _num_list(v, n):
    if not isinstance(v, (list, tuple)) or len(v) != n:
        return None
    try:
        return [float(x) for x in v]
    except (TypeError, ValueError):
        return None


def clean_request(data) -> dict:
    """The body forwarded to the host: the world folder, the camera's raw matrices, and the options."""
    if not isinstance(data, dict):
        raise RelayError("bad request", 400)
    world = world_dir_of(data.get("world_path") or data.get("world"))
    cam = data.get("camera")
    if not isinstance(cam, dict):
        raise RelayError("send the camera", 400)
    cw = _num_list(cam.get("camera_world"), 16)
    if cw is None:
        raise RelayError("camera_world must be the camera's 16 matrix numbers", 400)
    viewer = {"camera_world": cw}
    mw = cam.get("model_world")
    if mw is not None:
        viewer["model_world"] = _num_list(mw, 16)
        if viewer["model_world"] is None:
            raise RelayError("model_world must be the model's 16 matrix numbers", 400)
    for k in ("fov", "aspect"):
        try:
            if cam.get(k) is not None:
                viewer[k] = float(cam[k])
        except (TypeError, ValueError):
            raise RelayError(f"{k} must be a number", 400)
    viewer["gated"] = bool(cam.get("gated"))
    try:
        upscale = int(data.get("upscale") or 0)
    except (TypeError, ValueError):
        upscale = -1
    if upscale not in UPSCALES:
        raise RelayError("upscale is 0, 2 or 4", 400)
    return {"world": world, "camera": {"viewer": viewer}, "upscale": upscale,
            "add_to_world": bool(data.get("add_to_world")), "depth": False}


# Loopback calls must not go through a system proxy.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _open(req: urllib.request.Request, timeout: float):
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            body = {}
        return e.code, body


def host_endpoint(comfy_base: str, timeout: float = 5.0):
    """``(base_url, token)`` of the agentY host, as the ComfyUI extension reports them."""
    try:
        status, info = _open(urllib.request.Request(comfy_base.rstrip("/") + "/agent/host_info"), timeout)
    except Exception:  # noqa: BLE001
        status, info = 0, {}
    if status != 200 or not isinstance(info, dict) or not info.get("agent_server_port"):
        raise RelayError("agentY is not set up in this ComfyUI (the agentY-comfyuiConnect extension "
                         "answers /agent/host_info); Render with Atlas needs agentY running.", 503)
    return f"http://127.0.0.1:{int(info['agent_server_port'])}", str(info.get("session_token") or "")


def call_host(comfy_base: str, method: str, query: str = "", body=None, timeout: float = 30.0,
              route: str = "atlas_render") -> dict:
    """One call to the host's ``/agentY/<route>`` (``query`` like ``id=abc`` for a poll)."""
    base, token = host_endpoint(comfy_base)
    url = base + f"/agentY/{route}" + (f"?{query}" if query else "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers[TOKEN_HEADER] = token
    data = json.dumps(body).encode("utf-8") if body is not None else None
    try:
        status, out = _open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout)
    except Exception:  # noqa: BLE001
        raise RelayError("the agentY host is not running (start it, then press the button again)", 503)
    if status == 404 and method == "POST":
        raise RelayError("the agentY host is too old for Render with Atlas (update agentY and restart it)", 503)
    if status == 403:
        raise RelayError("the agentY host refused the viewer (its session token changed: reload the ComfyUI "
                         "page and try again)", 403)
    if status >= 400:
        raise RelayError(str(out.get("error") or f"the agentY host answered {status}"), status if status < 500 else 502)
    return out if isinstance(out, dict) else {}


def start_render(comfy_base: str, data) -> dict:
    return call_host(comfy_base, "POST", body=clean_request(data))


MOVE_ROUTE = "atlas_camera_move"
QUALITIES = ("draft", "standard", "high")
MAX_MOVE_KEYS = 800


def clean_move_request(data) -> dict:
    """The body forwarded for a camera move: the world folder, the timeline camera sampled per frame
    (``keys``: t in seconds + the camera's raw matrixWorld + its lens), the model's matrix once, the options."""
    if not isinstance(data, dict):
        raise RelayError("bad request", 400)
    world = world_dir_of(data.get("world_path") or data.get("world"))
    raw = data.get("keys")
    if not isinstance(raw, list) or len(raw) < 2:
        raise RelayError("the camera needs an animation: at least two keys", 400)
    if len(raw) > MAX_MOVE_KEYS:
        raise RelayError(f"at most {MAX_MOVE_KEYS} camera keys (a move is at most ~30 s)", 400)
    keys = []
    for k in raw:
        k = k if isinstance(k, dict) else {}
        cw = _num_list(k.get("camera_world"), 16)
        try:
            t = float(k.get("t"))
        except (TypeError, ValueError):
            t = None
        if cw is None or t is None:
            raise RelayError("each key needs t and camera_world (16 numbers)", 400)
        key = {"t": t, "camera_world": cw, "gated": bool(k.get("gated", True))}
        for a in ("fov", "aspect"):
            try:
                if k.get(a) is not None:
                    key[a] = float(k[a])
            except (TypeError, ValueError):
                raise RelayError(f"{a} must be a number", 400)
        keys.append(key)
    out = {"world": world, "keys": keys}
    if data.get("model_world") is not None:
        mw = _num_list(data["model_world"], 16)
        if mw is None:
            raise RelayError("model_world must be the model's 16 matrix numbers", 400)
        out["model_world"] = mw
    quality = str(data.get("quality") or "standard")
    if quality not in QUALITIES:
        raise RelayError("quality is draft, standard or high", 400)
    out.update(quality=quality, name=str(data.get("name") or "move")[:60], dry_run=bool(data.get("dry_run")),
               confirm_cost=bool(data.get("confirm_cost")), grow_world=bool(data.get("grow_world")))
    try:
        out["fps"] = float(data.get("fps") or 24.0)
    except (TypeError, ValueError):
        raise RelayError("fps must be a number", 400)
    return out


def start_move(comfy_base: str, data) -> dict:
    return call_host(comfy_base, "POST", body=clean_move_request(data), route=MOVE_ROUTE, timeout=60.0)


def move_state(comfy_base: str, job_id: str) -> dict:
    job_id = "".join(c for c in str(job_id or "") if c.isalnum())[:32]
    if not job_id:
        raise RelayError("no render id", 400)
    return call_host(comfy_base, "GET", query=f"id={job_id}", route=MOVE_ROUTE)


def render_state(comfy_base: str, job_id: str) -> dict:
    job_id = "".join(c for c in str(job_id or "") if c.isalnum())[:32]
    if not job_id:
        raise RelayError("no render id", 400)
    return call_host(comfy_base, "GET", query=f"id={job_id}")
