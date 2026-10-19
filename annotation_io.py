"""The marks drawn on a film, kept beside it.

The Annotation tool's marks over a single picture are scratch work and live in
memory until exported. Over a *film* they are feedback that has to survive the
page, so they are written next to the file: ``cut.mp4`` -> ``cut.annotations.json``.
It is plain JSON the agent (or anything else) can read without the viewer:

    { "version": 1, "media": "cut.mp4", "fps": 24, "frames": 120,
      "items": [ { "type": "text", "f": 72, "fe": 80, "x": 0.4, "y": 0.2,
                   "size": 42, "color": "#ff3b30", "text": "face drifts" }, ... ] }

``f`` / ``fe`` are the first and last frame (inclusive) the mark is shown on;
x / y and every point are fractions of the picture (0..1), so they hold for any
resolution. Nothing here touches ComfyUI: the route in viewer_api.py decides
whether a film may be written beside, this only validates and reads/writes.
"""

import json
import os
import tempfile

VERSION = 1
MAX_ITEMS = 1000
MAX_POINTS = 2000
MAX_TEXT = 2000
MAX_BYTES = 8 * 1024 * 1024
TYPES = ("pen", "arrow", "rect", "text")


def sidecar_for(media_path):
    """The annotations file for *media_path* (it need not exist yet), or None."""
    media_path = str(media_path or "")
    stem = os.path.splitext(media_path)[0]
    return stem + ".annotations.json" if stem else None


def _num(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _int(v, lo, hi, default):
    return int(_num(v, lo, hi, default))


def _pt(p):
    if not isinstance(p, dict):
        return None
    return {"x": _num(p.get("x"), 0.0, 1.0, 0.0), "y": _num(p.get("y"), 0.0, 1.0, 0.0)}


def clean_item(it):
    """One mark as it may be stored, or None when it is not a mark."""
    if not isinstance(it, dict) or it.get("type") not in TYPES:
        return None
    f = _int(it.get("f"), 0, 10 ** 7, 0)
    out = {"type": it["type"], "f": f, "fe": _int(it.get("fe"), f, 10 ** 7, f),
           "color": str(it.get("color") or "#ff3b30")[:16]}
    if it["type"] == "text":
        text = str(it.get("text") or "")[:MAX_TEXT]
        if not text.strip():
            return None
        out.update(x=_num(it.get("x"), 0.0, 1.0, 0.0), y=_num(it.get("y"), 0.0, 1.0, 0.0),
                   size=_num(it.get("size"), 4, 1000, 42), text=text)
        return out
    out["width"] = _num(it.get("width"), 1, 400, 6)
    if it["type"] == "pen":
        pts = [q for q in (_pt(p) for p in (it.get("pts") or [])[:MAX_POINTS]) if q]
        if len(pts) < 2:
            return None
        out["pts"] = pts
        return out
    a, b = _pt(it.get("a")), _pt(it.get("b"))
    if not a or not b:
        return None
    out.update(a=a, b=b)
    return out


def clean(data):
    """The whole document, validated; bad marks are dropped, not fatal."""
    if not isinstance(data, dict):
        raise ValueError("the annotations are not an object")
    items = [c for c in (clean_item(i) for i in (data.get("items") or [])[:MAX_ITEMS]) if c]
    return {"version": VERSION, "media": str(data.get("media") or "")[:260],
            "fps": _num(data.get("fps"), 0, 1000, 0), "frames": _int(data.get("frames"), 0, 10 ** 7, 0),
            "items": items}


def read(side):
    """The stored document, or None when there is none (or it cannot be read)."""
    try:
        if os.path.getsize(side) > MAX_BYTES:
            return None
        with open(side, encoding="utf-8") as fh:
            return clean(json.load(fh))
    except (OSError, ValueError):
        return None


def save(side, data):
    """Write *data* beside its film; no marks at all removes the file. Returns the
    document written (or None when removed)."""
    doc = clean(data)
    if not doc["items"]:
        try:
            os.remove(side)
        except FileNotFoundError:
            pass
        return None
    folder = os.path.dirname(side) or "."
    fd, tmp = tempfile.mkstemp(prefix=".annotations-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1)
        os.replace(tmp, side)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return doc


def groups(doc):
    """The marks gathered per (first, last) frame, in frame order - what the agent
    is told: [{"frame", "end", "items": [...]}]."""
    by = {}
    for it in (doc or {}).get("items", []):
        by.setdefault((it["f"], it["fe"]), []).append(it)
    return [{"frame": f, "end": e, "items": by[(f, e)]} for f, e in sorted(by)]


def timecode(frame, fps):
    """00:00:03.12 style: hh:mm:ss and the frame within the second."""
    fps = fps if fps and fps > 0 else 24
    n = max(0, int(frame))
    whole = int(round(fps))
    secs, fr = divmod(n, whole) if whole else (0, n)
    return "%02d:%02d:%02d.%02d" % (secs // 3600, secs // 60 % 60, secs % 60, fr)
