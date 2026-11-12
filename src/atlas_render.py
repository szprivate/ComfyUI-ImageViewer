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
import math
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


# ── "New Atlas world": a world made from a prompt or pictures, from the 3D space (no agent turn) ──

CREATE_ROUTE = "atlas_create"
ASPECTS = ("16:9", "9:16", "4:3", "3:4", "1:1")
MAX_CREATE_IMAGES = 8
MAX_PROMPT = 2000
ENGINES = ("atlas", "echo")            # World Labs Atlas, or SpAItial Echo (the second world generator)
ECHO_MODELS = ("echo-2", "echo-hq")
ECHO_MESH = ("", "mesh", "mesh-simplified")


def clean_create_request(data, images=None) -> dict:
    """The body forwarded to the host for a new world. ``images`` are the pictures' absolute paths,
    already resolved and checked by the route (path_access); the page's own list is not trusted here."""
    if not isinstance(data, dict):
        raise RelayError("bad request", 400)
    prompt = str(data.get("prompt") or "").strip()[:MAX_PROMPT]
    imgs = [str(p) for p in (images or []) if str(p or "").strip()]
    if len(imgs) > MAX_CREATE_IMAGES:
        raise RelayError(f"at most {MAX_CREATE_IMAGES} pictures for one world", 400)
    if not imgs and not prompt:
        raise RelayError("describe the place, or add a picture of it", 400)
    name = "".join(c if (c.isalnum() or c in "_- ") else "_" for c in str(data.get("name") or "")).strip()[:60]
    if not name:
        raise RelayError("give the world a name", 400)
    engine = str(data.get("engine") or "atlas").lower()
    if engine not in ENGINES:
        raise RelayError("engine is atlas or echo", 400)
    if engine == "echo":
        if len(imgs) > 1:
            raise RelayError("Echo makes a world from ONE picture (or a panorama, or words)", 400)
        model = str(data.get("model") or "echo-2").lower()
        if model not in ECHO_MODELS:
            raise RelayError("model is " + " or ".join(ECHO_MODELS), 400)
        pano = str(data.get("is_pano") or "auto").lower()
        if pano not in ("auto", "true", "false"):
            raise RelayError("is_pano is auto, true or false", 400)
        mesh = str(data.get("mesh") or "").lower()
        if mesh not in ECHO_MESH:
            raise RelayError("mesh is none, mesh or mesh-simplified", 400)
        return {"engine": "echo", "name": name, "prompt": "" if imgs else prompt, "image_paths": imgs,
                "model": model, "is_pano": pano, "mesh": mesh,
                "open_in_viewer": data.get("open_in_viewer", True) is not False}
    aspect = str(data.get("aspect_ratio") or "16:9")
    if aspect not in ASPECTS:
        raise RelayError("aspect_ratio is one of " + ", ".join(ASPECTS), 400)
    try:
        detail = int(data.get("mesh_detail") or 4)
    except (TypeError, ValueError):
        raise RelayError("mesh_detail must be a number", 400)
    if detail not in (2, 4, 8):
        raise RelayError("mesh_detail is 2 (fine), 4 or 8 (light)", 400)
    return {"name": name, "prompt": prompt, "image_paths": imgs, "aspect_ratio": aspect, "mesh_detail": detail,
            "open_in_viewer": data.get("open_in_viewer", True) is not False}


def start_create(comfy_base: str, data, images=None) -> dict:
    return call_host(comfy_base, "POST", body=clean_create_request(data, images), route=CREATE_ROUTE, timeout=60.0)


def create_state(comfy_base: str, job_id: str) -> dict:
    job_id = "".join(c for c in str(job_id or "") if c.isalnum())[:32]
    if not job_id:
        raise RelayError("no job id", 400)
    return call_host(comfy_base, "GET", query=f"id={job_id}", route=CREATE_ROUTE)


# ── "Chisel this view": an Atlas Chisel picture at the camera the viewer looks through (no agent turn) ──

CHISEL_ROUTE = "atlas_chisel"
MAX_CHISEL_PROMPT = 2000


def _viewer_camera(cam) -> dict:
    """The camera the page sent, as the host's ``{"viewer": {...}}`` camera spec (raw matrices, checked)."""
    if not isinstance(cam, dict):
        raise RelayError("send the camera", 400)
    cw = _num_list(cam.get("camera_world"), 16)
    if cw is None:
        raise RelayError("camera_world must be the camera's 16 matrix numbers", 400)
    viewer = {"camera_world": cw}
    if cam.get("model_world") is not None:
        viewer["model_world"] = _num_list(cam.get("model_world"), 16)
        if viewer["model_world"] is None:
            raise RelayError("model_world must be the model's 16 matrix numbers", 400)
    for k in ("fov", "aspect"):
        try:
            if cam.get(k) is not None:
                viewer[k] = float(cam[k])
        except (TypeError, ValueError):
            raise RelayError(f"{k} must be a number", 400)
    viewer["gated"] = bool(cam.get("gated"))
    return {"viewer": viewer}


MAX_DEPTH_PIXELS = 1280 * 720


def decode_depth(depth) -> tuple:
    """The page's depth map, ``{"w", "h", "data": base64 little-endian float32, row 0 at the top}``,
    as (floats, w, h): planar depth in the world mesh's units, 0 where nothing is."""
    import base64
    import numpy as np
    if not isinstance(depth, dict):
        raise RelayError("bad depth map", 400)
    try:
        w, h = int(depth.get("w")), int(depth.get("h"))
    except (TypeError, ValueError):
        raise RelayError("bad depth map size", 400)
    if w < 1 or h < 1 or w * h > MAX_DEPTH_PIXELS:
        raise RelayError("bad depth map size", 400)
    try:
        raw = base64.b64decode(str(depth.get("data") or ""), validate=True)
    except Exception:
        raise RelayError("bad depth map data", 400)
    if len(raw) != w * h * 4:
        raise RelayError("the depth map's data does not match its size", 400)
    z = np.frombuffer(raw, dtype="<f4").astype(np.float64).reshape(h, w)
    z[~np.isfinite(z)] = 0.0
    z[z < 0] = 0.0
    return z, w, h


def write_log_depth(z, out_dir: str) -> tuple:
    """Save planar depth ``z`` (2-D array, 0 = nothing there) as the log-depth PNG Atlas Chisel reads:
    16-bit grey, v = (ln z - ln zmax) / (ln zmin - ln zmax), so white is zMin and black is zMax / no surface.
    Answers (path, z_min, z_max)."""
    import time
    import uuid
    import numpy as np
    from PIL import Image
    hit = z[z > 0]
    if hit.size < 16:
        raise RelayError("there is no geometry in front of the camera to build on", 400)
    zmin = max(float(np.percentile(hit, 0.5)), 1e-3)
    zmax = float(hit.max())
    if zmax <= zmin * 1.001:
        zmax = zmin * 1.01
    zc = np.clip(z, zmin, zmax)
    v = (np.log(zc) - np.log(zmax)) / (np.log(zmin) - np.log(zmax))
    v[z <= 0] = 0.0
    px = np.round(np.clip(v, 0.0, 1.0) * 65535.0).astype(np.uint16)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"chisel_depth_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.png")
    Image.fromarray(px).save(path)
    return path, zmin, zmax


def clean_chisel_request(data, image: str = "", mask: str = "", style: str = "",
                         depth: tuple | None = None) -> dict:
    """The body forwarded to the host for a Chisel picture. ``image`` / ``mask`` / ``style`` are absolute
    paths the route resolved and checked (path_access); the page's own references are never passed on."""
    if not isinstance(data, dict):
        raise RelayError("bad request", 400)
    world = world_dir_of(data.get("world_path") or data.get("world"))
    prompt = str(data.get("prompt") or "").strip()[:MAX_CHISEL_PROMPT]
    if not prompt:
        raise RelayError("say what Atlas should paint or change", 400)
    if mask and not image:
        raise RelayError("a mask needs the picture it was painted on", 400)
    if not image and not depth:
        raise RelayError("give Chisel something to build on: the scene's geometry or a picture", 400)
    try:
        voxel = float(data.get("voxel_size") or 0.0)
    except (TypeError, ValueError):
        raise RelayError("voxel_size must be a number", 400)
    voxel = min(max(voxel, 0.0), 0.4)
    try:
        seed = int(data.get("seed") if data.get("seed") not in (None, "") else -1)
    except (TypeError, ValueError):
        raise RelayError("seed must be a whole number", 400)
    return {"world": world, "camera": _viewer_camera(data.get("camera")), "prompt": prompt,
            "image_path": image or "", "mask_path": mask or "", "style_image": style or "",
            "context": data.get("context", True) is not False, "seed": seed if seed >= 0 else -1,
            "enhance_prompt": data.get("enhance_prompt", True) is not False,
            "depth_path": depth[0] if depth else "", "z_min": depth[1] if depth else None,
            "z_max": depth[2] if depth else None, "voxel_size": voxel}


def start_chisel(comfy_base: str, data, image: str = "", mask: str = "", style: str = "",
                 depth_dir: str = "") -> dict:
    """``depth_dir``: where to save the page's depth map (``data["depth"]``) as a log-depth PNG."""
    depth = None
    if isinstance(data, dict) and data.get("depth"):
        if not depth_dir:
            raise RelayError("no folder to keep the depth map in", 500)
        z, _w, _h = decode_depth(data["depth"])
        depth = write_log_depth(z, depth_dir)
    return call_host(comfy_base, "POST", body=clean_chisel_request(data, image, mask, style, depth),
                     route=CHISEL_ROUTE, timeout=60.0)


def chisel_state(comfy_base: str, job_id: str) -> dict:
    job_id = "".join(c for c in str(job_id or "") if c.isalnum())[:32]
    if not job_id:
        raise RelayError("no job id", 400)
    return call_host(comfy_base, "GET", query=f"id={job_id}", route=CHISEL_ROUTE)


# --- The world's cameras, for auto-orient (imageViewer_previzAtlasOrient.js) --------------------------------------
# world.json keeps every frame's camera in the Atlas world frame (camera-to-world, RUB, quaternion XYZW); the
# mesh (world.glb) is built in the first meshed frame's camera frame (core's build_world_mesh: the frames with
# a camera and a depth map, the first of them as the base). The page gets each camera's axes and position in
# THAT frame, which is the frame the mesh's vertices are in.

def _quat_to_mat(q):
    x, y, z, w = [float(v) for v in q]
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def _cam_rt(cam):
    ex = (cam or {}).get("extrinsics") or {}
    R = _quat_to_mat(ex["quaternion"])
    if str(ex.get("coordinateSystem", "rub")).lower() == "rdf":
        R = [[r[0], -r[1], -r[2]] for r in R]
    return R, [float(v) for v in ex["position"]]


MAX_ORIENT_CAMERAS = 400


def world_cameras(path) -> dict:
    """``{"frames": n, "cameras": [{"right", "up", "fwd", "pos"}]}`` in the mesh frame, the base camera first."""
    wd = world_dir_of(path)
    try:
        with open(os.path.join(wd, "world.json"), encoding="utf-8") as f:
            world = json.load(f)
    except (OSError, ValueError):
        raise RelayError("the world's world.json could not be read", 400)
    frames = [fr for fr in (world.get("frames") or []) if isinstance(fr, dict) and fr.get("camera") and fr.get("depth")]
    if not frames:
        return {"frames": 0, "cameras": []}
    try:
        R0, t0 = _cam_rt(frames[0]["camera"])
    except (KeyError, TypeError, ValueError):
        raise RelayError("the world's first camera could not be read", 400)
    tr0 = [[R0[j][i] for j in range(3)] for i in range(3)]
    mv = lambda m, v: [sum(m[i][k] * v[k] for k in range(3)) for i in range(3)]  # noqa: E731
    def place(fr):
        R, t = _cam_rt(fr["camera"])
        col = lambda j: mv(tr0, [R[0][j], R[1][j], R[2][j]])  # noqa: E731
        back = col(2)
        return {"id": fr.get("id"), "right": col(0), "up": col(1), "fwd": [-v for v in back],
                "pos": mv(tr0, [t[i] - t0[i] for i in range(3)])}

    cams = []
    for fr in frames[:MAX_ORIENT_CAMERAS]:
        try:
            cams.append(place(fr))
        except (KeyError, TypeError, ValueError):
            continue
    # Every view of the world with a camera - depth or not, Atlas renders added to it too - as Atlas' own
    # Viewfinder shows them: a camera frustum with its picture (Sebastian 2026-11-11).
    views = []
    for fr in (world.get("frames") or [])[:MAX_ORIENT_CAMERAS]:
        if not (isinstance(fr, dict) and fr.get("camera") and fr.get("image")):
            continue
        try:
            v = place(fr)
            K = fr["camera"]["intrinsics"]
            w, h, fy = float(K["width"]), float(K["height"]), float(K["fy"])
        except (KeyError, TypeError, ValueError):
            continue
        if w <= 0 or h <= 0 or fy <= 0:
            continue
        img = os.path.join(wd, os.path.basename(str(fr["image"])))
        if not os.path.isfile(img):
            continue
        v.update({"image": img, "aspect": w / h, "fov": math.degrees(2 * math.atan(h / 2 / fy)),
                  "source": str(fr.get("source") or ""), "has_depth": bool(fr.get("depth"))})
        views.append(v)
    return {"frames": len(frames), "cameras": cams, "views": views}


# --- Rebuild the world's mesh (the cleaned depth meshes of agentY-core), by the agentY host -----------------------
REBUILD_ROUTE = "atlas_rebuild"


def rebuild_mesh(comfy_base: str, data) -> dict:
    if not isinstance(data, dict):
        raise RelayError("bad request", 400)
    world = world_dir_of(data.get("world_path") or data.get("world"))
    return call_host(comfy_base, "POST", body={"world": world}, route=REBUILD_ROUTE, timeout=600.0)


# --- Export a Gaussian splat of the world (World Labs posedImages2Splats, by the agentY host) --------------------
SPLAT_ROUTE = "atlas_splat"


def clean_splat_request(data) -> dict:
    if not isinstance(data, dict):
        raise RelayError("bad request", 400)
    world = world_dir_of(data.get("world_path") or data.get("world"))
    name = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in str(data.get("name") or ""))[:60]
    return {"world": world, "refine": data.get("refine", True) is not False, "name": name,
            "check_consistency": data.get("check_consistency", True) is not False,
            "dry_run": bool(data.get("dry_run")), "confirm_cost": bool(data.get("confirm_cost"))}


def start_splat(comfy_base: str, data) -> dict:
    body = clean_splat_request(data)
    return call_host(comfy_base, "POST", body=body, route=SPLAT_ROUTE, timeout=120.0 if body["dry_run"] else 30.0)


def splat_state(comfy_base: str, job_id: str) -> dict:
    job_id = "".join(c for c in str(job_id or "") if c.isalnum())[:32]
    if not job_id:
        raise RelayError("no export id", 400)
    return call_host(comfy_base, "GET", query=f"id={job_id}", route=SPLAT_ROUTE)
