"""The viewer's settings, kept in one place per OS user.

ComfyUI stores settings in its user directory, and a launcher may hand each
project its own (AYON starts ComfyUI with --user-directory inside the project),
so a setting changed in one project is back at its default in the next. The
viewer's own settings (Settings -> ComfyUI Image Viewer, ids starting "ImageViewer.")
are therefore mirrored here: the page loads them at startup and writes each
change back.

Where: ~/.comfyui_image_viewer/settings.json, or the file named by IMAGE_VIEWER_SETTINGS
(a studio can point every machine at one roaming profile path).

Only preferences live here — scalars under the viewer's own prefix. The folders
the viewer may open are not a setting (path_access.py), and nothing stored here
is trusted as a path: a start folder is still checked when it is browsed.
"""

import json
import os

try:                                    # the viewer's old "bEpic" names (legacy_names.py)
    from .legacy_names import user_dir as _user_dir, renamed_setting as _renamed_setting
except ImportError:
    from legacy_names import user_dir as _user_dir, renamed_setting as _renamed_setting

ENV = "IMAGE_VIEWER_SETTINGS"
PREFIX = "ImageViewer."
MAX_KEYS = 200
MAX_TEXT = 2000


def path():
    custom = os.environ.get(ENV, "").strip().strip('"')
    if custom:
        return os.path.abspath(os.path.expandvars(os.path.expanduser(custom)))
    return os.path.join(_user_dir(), "settings.json")


def load():
    """{id: value}; empty when there is no file yet or it can't be read."""
    try:
        with open(path(), encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"[ImageViewer] could not read {path()}: {e}")
        return {}
    return _clean(data) if isinstance(data, dict) else {}


def _clean(values):
    """Only what a setting can be: the viewer's own ids, scalar values."""
    out = {}
    for key, value in values.items():
        key = _renamed_setting(key)
        if not isinstance(key, str) or not key.startswith(PREFIX) or len(key) > 120:
            continue
        if isinstance(value, bool) or value is None:
            out[key] = value
        elif isinstance(value, (int, float)):
            if value == value and abs(value) != float("inf"):      # no NaN / inf in JSON
                out[key] = value
        elif isinstance(value, str) and len(value) <= MAX_TEXT:
            out[key] = value
    return out


def update(values):
    """Merge `values` into the file (None removes a key). Returns the result.
    Raises ValueError when there is nothing storable in it."""
    if not isinstance(values, dict):
        raise ValueError("expected an object of setting ids and values")
    removed = [k for k, v in values.items() if v is None and isinstance(k, str)]
    clean = {k: v for k, v in _clean(values).items() if v is not None}
    if not clean and not removed:
        raise ValueError(f"no '{PREFIX}*' settings in the request")
    merged = load()
    merged.update(clean)
    for k in removed:
        merged.pop(k, None)
    if len(merged) > MAX_KEYS:
        raise ValueError("too many settings")
    target = path()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=2, sort_keys=True)
    os.replace(tmp, target)
    return merged
