"""Previz shots an agent asks for: a scene to open and, optionally, a render of it.

An agent can author a previz scene (models, a keyed camera) as plain JSON and
have the viewer open it and render a camera through it, the same render the
Export > Render dialog makes. The page does the drawing (it has the WebGL
renderer), so a request is a job: the route files it here, sends the scene and
the render request to the page, and the page reports progress and the result
back. The agent polls the job.

No aiohttp or ComfyUI in here, so it can be tested on its own.
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid

MAX_JOBS = 50
MAX_ITEMS = 500
RENDER_KEYS = ("camera", "start", "end", "fps", "width", "height", "useCameraRes", "scale", "format",
               "quality", "shading", "background", "color", "aa", "grid", "helpers", "codec")
STATES = ("queued", "rendering", "done", "error")


def json_dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"))


def safe_name(name, fallback="shot") -> str:
    out = "".join(c for c in str(name or "") if c.isalnum() or c in "-_ ").strip().replace(" ", "_")
    return out[:64] or fallback


def _scene_of(data) -> dict:
    scene = data.get("scene")
    if isinstance(scene, str):
        try:
            scene = json.loads(scene)
        except ValueError:
            raise ValueError("scene is not valid JSON")
    if not isinstance(scene, dict) or not isinstance(scene.get("items"), list) or not scene["items"]:
        raise ValueError("scene needs a non-empty items list")
    if len(scene["items"]) > MAX_ITEMS:
        raise ValueError("scene has too many items")
    ids = [i.get("id") for i in scene["items"] if isinstance(i, dict)]
    if len(ids) != len(scene["items"]) or any(not isinstance(i, str) or not i for i in ids) \
            or len(set(ids)) != len(ids):
        raise ValueError("every scene item needs a unique string id")
    scene.setdefault("version", 1)
    return scene


def clean_render(render, scene: dict) -> dict:
    """The render settings the page accepts, with the camera checked against the scene."""
    if not isinstance(render, dict):
        raise ValueError("render must be an object")
    out = {k: render[k] for k in RENDER_KEYS if k in render}
    cams = [i["id"] for i in scene["items"] if i.get("kind") == "camera"]
    cam = out.get("camera")
    if cam in (None, ""):
        if scene.get("activeCamera") in cams:
            out["camera"] = scene["activeCamera"]
        elif cams:
            out["camera"] = cams[0]
        else:
            raise ValueError("the scene has no camera to render through")
    elif cam not in cams:
        raise ValueError(f"no camera '{cam}' in the scene (cameras: {', '.join(cams) or 'none'})")
    out.setdefault("format", "mp4")
    return out


class ShotBook:
    """The shots asked for, newest last, oldest dropped."""

    def __init__(self):
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()

    def new_job(self, data) -> dict:
        if not isinstance(data, dict):
            raise ValueError("bad request")
        scene = _scene_of(data)
        name = safe_name(data.get("name"))
        render = data.get("render")
        render = clean_render(render, scene) if render else None
        job = {
            "id": uuid.uuid4().hex[:12], "name": name, "key": f"previz:{name}", "scene": scene,
            "render": render, "add_node": data.get("add_node", True) is not False,
            "focus": data.get("focus", True) is not False,
            "state": "queued" if render else "done", "done": 0, "total": 0, "path": None,
            "message": "", "created": time.time(),
        }
        with self._lock:
            self._jobs[job["id"]] = job
            while len(self._jobs) > MAX_JOBS:
                self._jobs.pop(next(iter(self._jobs)))
        return job

    def get(self, job_id):
        with self._lock:
            return self._jobs.get(job_id)

    def report(self, data: dict) -> bool:
        job = self.get(str(data.get("id") or ""))
        if job is None:
            return False
        state = data.get("state")
        if state in STATES:
            job["state"] = state
        for k in ("done", "total"):
            if isinstance(data.get(k), (int, float)):
                job[k] = int(data[k])
        for k in ("path", "message", "where"):
            if isinstance(data.get(k), str):
                job[k] = data[k]
        return True

    @staticmethod
    def public(job: dict) -> dict:
        return {k: job.get(k) for k in ("id", "name", "key", "state", "done", "total", "path", "where", "message")}
