"""The marks drawn on a film or a picture, kept beside it.

The Annotation tool's marks are feedback that has to survive the page, so they
are written next to the file: ``cut.mp4`` -> ``cut.annotations.json``,
``render_0001.png`` -> ``render_0001.annotations.json`` (a picture with no file
behind it - dropped in from Explorer - keeps its marks in memory only). It is
plain JSON the agent (or anything else) can read without the viewer:

    { "version": 1, "media": "cut.mp4", "fps": 24, "frames": 120,
      "width": 1920, "height": 1080,
      "items": [ { "type": "text", "f": 72, "fe": 80, "x": 0.4, "y": 0.2,
                   "size": 42, "color": "#ff3b30", "text": "face drifts" }, ... ] }

``f`` / ``fe`` are the first and last frame (inclusive) the mark is shown on (0
on a picture); x / y and every point are fractions of the picture (0..1), so they
hold for any resolution. ``width`` / ``height`` are the picture's size when the
viewer knew it. Nothing here touches ComfyUI: the route in viewer_api.py decides
whether a file may be written beside, this only validates and reads/writes, says
what the marks are in words (:func:`report`, the same answer the viewer's page
gives - bEpicViewer_viewerState.js) and draws the boxes and strokes as a mask
(:func:`mask_image`).
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
    doc = {"version": VERSION, "media": str(data.get("media") or "")[:260],
           "fps": _num(data.get("fps"), 0, 1000, 0), "frames": _int(data.get("frames"), 0, 10 ** 7, 0),
           "items": items}
    w, h = _int(data.get("width"), 0, 65536, 0), _int(data.get("height"), 0, 65536, 0)
    if w and h:
        doc["width"], doc["height"] = w, h
    return doc


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


# ── in words (the same answer the viewer's page gives) ──────────────────────────

MARKS_CAP = 200
TEXT_CAP = 500


def where_is(x, y):
    """"top left", "centre", "bottom right"... (bEpicViewer_annotateReport.whereIs)."""
    col = "left" if x < 1 / 3 else "right" if x > 2 / 3 else ""
    row = "top" if y < 1 / 3 else "bottom" if y > 2 / 3 else ""
    return " ".join(p for p in (row, col) if p) or "centre"


def _pct(v):
    return f"{int(round(v * 100))}%"


def _r4(v):
    return round(float(v), 4)


def _bounds(it):
    if it.get("type") == "pen":
        xs = [p["x"] for p in it["pts"]]
        ys = [p["y"] for p in it["pts"]]
    else:
        xs = [it["a"]["x"], it["b"]["x"]]
        ys = [it["a"]["y"], it["b"]["y"]]
    return min(xs), min(ys), max(xs), max(ys)


def describe_item(it, w=0, h=0):
    """One mark as a line of text (bEpicViewer_annotateReport.describeItem)."""
    t = it.get("type")
    if t == "text":
        return (f"text at {_pct(it['x'])},{_pct(it['y'])} ({int(round(it['x'] * w))},"
                f"{int(round(it['y'] * h))} px, {where_is(it['x'], it['y'])}): "
                + json.dumps(str(it.get("text") or ""), ensure_ascii=False))
    if t == "arrow":
        a, b = it["a"], it["b"]
        return (f"arrow from {_pct(a['x'])},{_pct(a['y'])} ({where_is(a['x'], a['y'])}) "
                f"to {_pct(b['x'])},{_pct(b['y'])} ({where_is(b['x'], b['y'])})")
    if t in ("rect", "pen"):
        x1, y1, x2, y2 = _bounds(it)
        what = "box from" if t == "rect" else "freehand mark around"
        return (f"{what} {_pct(x1)},{_pct(y1)} to {_pct(x2)},{_pct(y2)} "
                f"({where_is((x1 + x2) / 2, (y1 + y2) / 2)})")
    return ""


def describe_mark(it, w=0, h=0):
    """One mark as the agent reads it (bEpicViewer_viewerState.describeMark)."""
    t = it.get("type")
    m = {"type": {"rect": "box", "pen": "stroke"}.get(t, t)}
    if it.get("color"):
        m["color"] = it["color"]
    if t == "text":
        m["text"] = str(it.get("text") or "")[:TEXT_CAP]
        m["at"] = {"x": _r4(it["x"]), "y": _r4(it["y"])}
        m["where"] = where_is(it["x"], it["y"])
    elif t == "arrow":
        m["from"] = {"x": _r4(it["a"]["x"]), "y": _r4(it["a"]["y"])}
        m["to"] = {"x": _r4(it["b"]["x"]), "y": _r4(it["b"]["y"])}
        m["where"] = where_is(it["b"]["x"], it["b"]["y"])
    elif t in ("rect", "pen"):
        x1, y1, x2, y2 = _bounds(it)
        m["box"] = {"x1": _r4(x1), "y1": _r4(y1), "x2": _r4(x2), "y2": _r4(y2)}
        if t == "pen":
            m["points"] = len(it["pts"])
        m["where"] = where_is((x1 + x2) / 2, (y1 + y2) / 2)
    else:
        return None
    if t != "text" and it.get("width") is not None:
        m["width"] = int(round(it["width"]))
    m["description"] = describe_item(it, w, h)
    return m


def report(doc, kind="", width=0, height=0, frame=None, source=""):
    """The marks of *doc* as the agent reads them: gathered per frame range (a
    film) or as one set (a picture), each with its words and where it is.

    ``{kind, source, width, height, fps, frames, count, annotations: [{frame, end,
    timecode, end_timecode, notes, marks}]}`` - the shape the viewer's page
    answers with (window.bEpicViewerApi.annotations). *frame*: only the marks
    shown on that frame of a film."""
    doc = doc or {}
    fps = float(doc.get("fps") or 0)
    video = (kind or ("video" if (doc.get("frames") or fps) else "image")) == "video"
    w = int(width or doc.get("width") or 0)
    h = int(height or doc.get("height") or 0)
    items = [i for i in doc.get("items") or [] if isinstance(i, dict)]
    if video and frame is not None:
        items = [i for i in items if i.get("f", 0) <= frame <= i.get("fe", i.get("f", 0))]
    out = {"kind": "video" if video else "image", "count": len(items)}
    if source:
        out["source"] = source
    if w and h:
        out["width"], out["height"] = w, h
    if video:
        if fps:
            out["fps"] = round(fps, 3)
        if doc.get("frames"):
            out["frames"] = int(doc["frames"])
        if frame is not None:
            out["frame"] = int(frame)
    groups = {}
    kept = 0
    for it in items:
        if kept >= MARKS_CAP:
            break
        m = describe_mark(it, w, h)
        if not m:
            continue
        kept += 1
        f, e = (int(it.get("f", 0)), int(it.get("fe", it.get("f", 0)))) if video else (0, 0)
        g = groups.get((f, e))
        if g is None:
            g = {"frame": f, "end": e} if video else {}
            if video and fps:
                g["timecode"] = timecode(f, fps)
                if e > f:
                    g["end_timecode"] = timecode(e, fps)
            g["notes"], g["marks"] = [], []
            groups[(f, e)] = g
        if m["type"] == "text" and m["text"].strip():
            g["notes"].append(m["text"].strip())
        g["marks"].append(m)
    out["annotations"] = [groups[k] for k in sorted(groups)]
    for g in out["annotations"]:
        if not g["notes"]:
            del g["notes"]
    if len(items) > kept:
        out["truncated"] = True
    return out


# ── a mask of the drawn regions ─────────────────────────────────────────────────

#: Marks that outline a region. Arrows point and texts talk; neither is a region.
MASK_TYPES = ("rect", "pen")


def _closed(pts, w, h, width):
    """A freehand stroke that comes back to where it started outlines an area."""
    if len(pts) < 3:
        return False
    x0, y0 = pts[0]["x"] * w, pts[0]["y"] * h
    x1, y1 = pts[-1]["x"] * w, pts[-1]["y"] * h
    gap = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
    xs = [p["x"] * w for p in pts]
    ys = [p["y"] * h for p in pts]
    size = max(max(xs) - min(xs), max(ys) - min(ys), 1.0)
    return gap <= max(3.0 * width, 0.15 * size)


def mask_image(items, width, height, frame=None, fill_closed=True, ss=2):
    """The boxes and freehand strokes of *items* as a white-on-black mask (a PIL
    "L" image at *width* x *height*): a box is filled, a stroke is drawn at its
    width - and filled as well when it closes on itself (a circled area).
    *frame*: only the marks shown on that frame of a film. Returns
    ``(image, used)``, *used* the number of marks drawn (0: an all-black mask)."""
    from PIL import Image, ImageDraw
    w, h = int(width), int(height)
    if w <= 0 or h <= 0:
        raise ValueError("the picture's size is not known")
    if w * h > 400_000_000:
        raise ValueError("the picture is too large for a mask")
    img = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(img)
    used = 0
    for raw in (items or [])[:MAX_ITEMS]:
        it = clean_item(raw)
        if not it or it["type"] not in MASK_TYPES:
            continue
        if frame is not None and not (it["f"] <= frame <= it["fe"]):
            continue
        used += 1
        if it["type"] == "rect":
            x1, y1, x2, y2 = _bounds(it)
            d.rectangle([x1 * w * ss, y1 * h * ss, x2 * w * ss, y2 * h * ss], fill=255)
            continue
        pts = [(p["x"] * w * ss, p["y"] * h * ss) for p in it["pts"]]
        lw = max(1, int(round(it.get("width", 6) * ss)))
        if fill_closed and _closed(it["pts"], w, h, it.get("width", 6)):
            d.polygon(pts, fill=255)
        d.line(pts, fill=255, width=lw, joint="curve")
        r = lw / 2
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    if ss != 1:
        img = img.resize((w, h), Image.BILINEAR)
    return img, used
