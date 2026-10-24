"""Reading and writing motion-graphics scene files (``*.mgscene.json``) for the Motion panel.

The format and the full validation live in the scene module the editor shares with agentY's
renderer (js/bEpicViewer_mgScene.js, agenty_core/motion_graphics/schema.py). The viewer's side
only guards the file: right name, a JSON object that is a scene, written whole or not at all.
No aiohttp or ComfyUI in here, so it can be tested on its own.
"""
from __future__ import annotations

import json
import os
import tempfile

SUFFIX = ".mgscene.json"
MAX_BYTES = 8 * 1024 * 1024


def is_scene_path(path) -> bool:
    return isinstance(path, str) and path.lower().endswith(SUFFIX)


def check_path(path) -> str:
    """The absolute path of a scene file, or ValueError saying why it is not one."""
    if not is_scene_path(path):
        raise ValueError(f"not a motion-graphics scene (the file name must end in {SUFFIX})")
    return os.path.abspath(path)


def read(path) -> dict:
    p = check_path(path)
    if os.path.getsize(p) > MAX_BYTES:
        raise ValueError("the scene file is too large")
    with open(p, "r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("the file is not a scene (a JSON object)")
    return data


def write(path, scene) -> str:
    """Write the scene atomically (temp file + rename); returns the path."""
    p = check_path(path)
    if (not isinstance(scene, dict) or scene.get("mgscene") != 1 or not isinstance(scene.get("layers"), list)
            or not isinstance(scene.get("comp"), dict)):
        raise ValueError("this is not a scene: it needs mgscene 1, comp and layers")
    text = json.dumps(scene, indent=1, ensure_ascii=False)
    if len(text) > MAX_BYTES:
        raise ValueError("the scene is too large")
    folder = os.path.dirname(p)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".mgscene_", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text + "\n")
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return p
