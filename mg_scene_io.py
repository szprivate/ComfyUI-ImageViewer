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


# --- a poster PNG that carries a scene (written by agentY-core next to every rendered video) ---
PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_SCENE_KEY = "mgscene"
PNG_PATH_KEY = "mgscene_path"


def is_png_path(path) -> bool:
    return isinstance(path, str) and path.lower().endswith(".png")


def read_png_scene(path):
    """``(scene, source_path)`` from a PNG's ``mgscene`` / ``mgscene_path`` text chunks, or None.

    Reads the chunks up to the first IDAT only (the text is written before the pixels), so
    probing a big PNG is cheap. Handles iTXt (compressed or not) and tEXt."""
    import zlib
    found = {}
    try:
        with open(path, "rb") as fh:
            if fh.read(8) != PNG_SIG:
                return None
            while True:
                head = fh.read(8)
                if len(head) < 8:
                    break
                length, ctype = int.from_bytes(head[:4], "big"), head[4:]
                if ctype in (b"IDAT", b"IEND"):
                    break
                if ctype not in (b"iTXt", b"tEXt", b"zTXt"):
                    fh.seek(length + 4, 1)
                    continue
                if length > MAX_BYTES * 2:
                    fh.seek(length + 4, 1)
                    continue
                body = fh.read(length)
                fh.seek(4, 1)
                key, _, rest = body.partition(b"\0")
                key = key.decode("latin-1")
                if key not in (PNG_SCENE_KEY, PNG_PATH_KEY):
                    continue
                if ctype == b"tEXt":
                    found[key] = rest.decode("latin-1")
                elif ctype == b"zTXt":
                    found[key] = zlib.decompress(rest[1:]).decode("latin-1")
                else:  # iTXt: flag, method, language\0, translated key\0, text
                    flag, rest = rest[0], rest[2:]
                    _lang, _, rest = rest.partition(b"\0")
                    _tkey, _, text = rest.partition(b"\0")
                    if flag:
                        text = zlib.decompress(text)
                    found[key] = text.decode("utf-8")
    except (OSError, ValueError, zlib.error):
        return None
    raw = found.get(PNG_SCENE_KEY)
    if not raw:
        return None
    try:
        scene = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(scene, dict):
        return None
    return scene, found.get(PNG_PATH_KEY, "")


def resolve_png(png_path, is_allowed):
    """What the Motion panel opens for a poster PNG: ``{"path", "scene"}`` or None (no scene).

    The source scene file named in the PNG wins when it exists, is allowed and still holds the
    same scene, so a Save lands in the real file. Otherwise the embedded scene opens as
    ``<png folder>/<png stem>.mgscene.json`` (assets are relative to that folder); nothing is
    written here. ``is_allowed(path)`` is path_access.is_allowed."""
    got = read_png_scene(png_path)
    if got is None:
        return None
    scene, src = got
    if src and is_scene_path(src) and os.path.isabs(src) and os.path.isfile(src) and is_allowed(src):
        try:
            if read(src) == scene:
                return {"path": os.path.abspath(src), "scene": scene}
        except (ValueError, OSError):
            pass
    stem = os.path.splitext(os.path.basename(png_path))[0]
    return {"path": os.path.join(os.path.dirname(os.path.abspath(png_path)), stem + SUFFIX), "scene": scene}
