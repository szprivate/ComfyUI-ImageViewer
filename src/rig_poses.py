"""The pose library of the 3D space's rigs: poses kept per OS user, so every scene and every
project on this machine shares them (AYON starts ComfyUI with a user directory per project, which
is why they are not kept in ComfyUI's own folder).

Where: ``~/.comfyui_image_viewer/poses/<name>.json``, or the folder named by IMAGE_VIEWER_POSES.

A pose is what the page sends (js/imageViewer_rigExtras.js, ``capturePose``): per control, keyed by
what the control drives (``fk:<bone>``, ``ik:<limb>``, ``pole:<limb>``, ``cog``, ``root``,
``face:<name>``), its position / rotation / IK blend / custom attributes, plus the character's
blendshape weights and a small picture. This module only checks the shape and keeps the files; it
reads and writes nothing outside that folder and hands out no file but these JSONs.

Routes (registered by viewer_api through :func:`register`), JSON, same_origin:
    POST /imageviewer/rig/poses {op: "list"}              -> {poses: [pose, ...]} newest first
    POST /imageviewer/rig/poses {op: "save", pose}        -> {pose}
    POST /imageviewer/rig/poses {op: "delete", name}      -> {ok}
    POST /imageviewer/rig/poses {op: "rename", name, to}  -> {pose}
"""
import json
import math
import os
import re
import time

MAX_POSES = 2000
MAX_CONTROLS = 2000
MAX_THUMB = 400_000          # bytes of the data: URL
MAX_NAME = 80


def poses_dir():
    env = os.environ.get("IMAGE_VIEWER_POSES")
    if env:
        return env
    try:
        from .legacy_names import user_dir
    except ImportError:  # run outside the package (tests)
        from legacy_names import user_dir
    return os.path.join(user_dir(), "poses")


def clean_name(name):
    """A pose's name as shown, or "" when there is none to keep."""
    s = re.sub(r"[\x00-\x1f\x7f]", "", str(name or "")).strip()
    return s[:MAX_NAME]


def file_name(name):
    """The file a pose of that name is kept in: the name made safe for every file system, lower-cased
    so that two names differing only in case are one pose (Windows would make them one file anyway)."""
    s = re.sub(r"[^A-Za-z0-9 _.\-]+", "_", clean_name(name)).strip(" ._").lower()
    s = re.sub(r"\s+", " ", s)
    if s.upper().split(".")[0] in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(10)), *(f"LPT{i}" for i in range(10))}:
        s = "_" + s
    return (s or "pose") + ".json"


def _num(v, d=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return d
    return x if math.isfinite(x) else d


def _vec(v):
    if isinstance(v, (list, tuple)) and len(v) == 3:
        return [_num(x) for x in v]
    return None


def clean_pose(raw):
    """The pose as it will be kept, or a ValueError saying what is wrong with it."""
    if not isinstance(raw, dict):
        raise ValueError("a pose must be an object")
    name = clean_name(raw.get("name"))
    if not name:
        raise ValueError("a pose needs a name")
    ctrls = raw.get("controls")
    if not isinstance(ctrls, dict) or not ctrls:
        raise ValueError("a pose needs the controls it poses")
    out = {}
    for key, c in list(ctrls.items())[:MAX_CONTROLS]:
        if not isinstance(key, str) or not key or len(key) > 200 or not isinstance(c, dict):
            continue
        one = {}
        for p in ("position", "rotation"):
            v = _vec(c.get(p))
            if v is not None:
                one[p] = v
        if "ikfk" in c:
            one["ikfk"] = min(1.0, max(0.0, _num(c.get("ikfk"), 1.0)))
        if isinstance(c.get("attrs"), dict):
            one["attrs"] = {str(k)[:190]: _num(v) for k, v in list(c["attrs"].items())[:200]}
        if one:
            out[key] = one
    if not out:
        raise ValueError("a pose needs the controls it poses")
    pose = {
        "name": name,
        "model": clean_name(raw.get("model")),
        "created": _num(raw.get("created"), time.time()),
        "controls": out,
    }
    if isinstance(raw.get("blendshapes"), dict):
        pose["blendshapes"] = {str(k)[:190]: min(1.0, max(0.0, _num(v))) for k, v in list(raw["blendshapes"].items())[:2000]}
    thumb = raw.get("thumb")
    if isinstance(thumb, str) and len(thumb) <= MAX_THUMB and re.match(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$", thumb):
        pose["thumb"] = thumb
    return pose


def list_poses(folder=None):
    folder = folder or poses_dir()
    out = []
    try:
        names = [n for n in os.listdir(folder) if n.lower().endswith(".json")]
    except OSError:
        return out
    for n in names[:MAX_POSES]:
        try:
            with open(os.path.join(folder, n), encoding="utf-8") as f:
                out.append(clean_pose(json.load(f)))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    out.sort(key=lambda p: -p["created"])
    return out


def save_pose(raw, folder=None):
    folder = folder or poses_dir()
    pose = clean_pose(raw)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, file_name(pose["name"]))
    if not os.path.exists(path) and len([n for n in os.listdir(folder) if n.endswith(".json")]) >= MAX_POSES:
        raise ValueError(f"the library is full ({MAX_POSES} poses)")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(pose, f)
    os.replace(tmp, path)
    return pose


def delete_pose(name, folder=None):
    folder = folder or poses_dir()
    path = os.path.join(folder, file_name(name))
    if os.path.isfile(path):
        os.remove(path)
        return True
    return False


def rename_pose(name, to, folder=None):
    folder = folder or poses_dir()
    src = os.path.join(folder, file_name(name))
    with open(src, encoding="utf-8") as f:
        pose = clean_pose(json.load(f))
    pose["name"] = clean_name(to)
    if not pose["name"]:
        raise ValueError("a pose needs a name")
    saved = save_pose(pose, folder)
    if file_name(name) != file_name(to):
        os.remove(src)
    return saved


def register(add, *, web, path_access):
    """Add the routes through ``add(method, path, handler)``, under /imageviewer and /api/imageviewer."""
    import asyncio

    def off(fn, *a):
        return asyncio.get_running_loop().run_in_executor(None, lambda: fn(*a))

    async def post(request):
        ok, why = path_access.same_origin(request)
        if not ok:
            return web.json_response({"error": why}, status=403)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "the body must be a JSON object"}, status=400)
        op = body.get("op")
        try:
            if op == "list":
                return web.json_response({"poses": await off(list_poses)})
            if op == "save":
                return web.json_response({"pose": await off(save_pose, body.get("pose"))})
            if op == "delete":
                return web.json_response({"ok": await off(delete_pose, body.get("name"))})
            if op == "rename":
                return web.json_response({"pose": await off(rename_pose, body.get("name"), body.get("to"))})
        except FileNotFoundError:
            return web.json_response({"error": "there is no pose of that name"}, status=404)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"error": f"unknown op {op!r}"}, status=400)

    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("POST", f"{prefix}/rig/poses", post)
