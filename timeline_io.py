"""Reading the cut that lies beside a film.

A film that was edited rather than generated usually has its edit next to it: an
OpenTimelineIO file of the same name (``cut.mp4`` / ``cut.otio``) - agentY's edit
stage writes one, and so can Resolve, Nuke Studio or Premiere. The viewer shows
it as a strip over the scrub bar, so a cut can be read and stepped through shot
by shot.

This module only reads, and only flattens: OTIO's nested, rational-time
structure becomes plain seconds the page can draw. No OpenTimelineIO library is
needed - a ``.otio`` file is JSON.
"""

import json
import os

_MAX_BYTES = 8 * 1024 * 1024
_MAX_ITEMS = 2000


def sidecar_for(media_path):
    """The ``.otio`` beside *media_path*, or None when there is none."""
    stem = os.path.splitext(str(media_path or ""))[0]
    if not stem:
        return None
    for ext in (".otio", ".OTIO"):
        cand = stem + ext
        if os.path.isfile(cand):
            return cand
    return None


def _seconds(rt):
    """An OTIO RationalTime as seconds (0 for anything that is not one)."""
    try:
        rate = float(rt.get("rate") or 0)
        return float(rt.get("value") or 0) / rate if rate else 0.0
    except (AttributeError, TypeError, ValueError):
        return 0.0


def _span(time_range):
    """``(start, length)`` in seconds of an OTIO TimeRange."""
    if not isinstance(time_range, dict):
        return 0.0, 0.0
    return _seconds(time_range.get("start_time") or {}), _seconds(time_range.get("duration") or {})


def _rate(obj):
    """The first frame rate found anywhere under *obj* (0 when there is none)."""
    stack = [obj]
    seen = 0
    while stack and seen < 5000:
        cur = stack.pop()
        seen += 1
        if isinstance(cur, dict):
            if cur.get("OTIO_SCHEMA", "").startswith("RationalTime") and cur.get("rate"):
                try:
                    return float(cur["rate"])
                except (TypeError, ValueError):
                    pass
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return 0.0


def _file(ref):
    """The file a media reference names, as a path where it is a file URL."""
    url = str((ref or {}).get("target_url") or "") if isinstance(ref, dict) else ""
    if url.startswith("file:///"):
        url = url[8:] if len(url) > 9 and url[9] == ":" else url[7:]
    elif url.startswith("file://"):
        url = "//" + url[7:]
    return url


def _track(track):
    """One track flattened: ``(items, transitions, length)`` in seconds."""
    items, transitions = [], []
    at = 0.0
    for child in (track.get("children") or [])[:_MAX_ITEMS]:
        if not isinstance(child, dict):
            continue
        schema = str(child.get("OTIO_SCHEMA") or "")
        if schema.startswith("Transition"):
            # It sits ON the join: this much of the clip before, that much of the
            # one after.
            before, after = _seconds(child.get("in_offset") or {}), _seconds(child.get("out_offset") or {})
            transitions.append({"at": round(at, 4), "start": round(at - before, 4),
                                "length": round(before + after, 4),
                                "name": str(child.get("name") or child.get("transition_type") or "")})
            continue
        _start, length = _span(child.get("source_range"))
        if length <= 0:
            continue
        kind = "gap" if schema.startswith("Gap") else "clip"
        items.append({"kind": kind, "name": str(child.get("name") or ""),
                      "start": round(at, 4), "length": round(length, 4),
                      "file": _file(child.get("media_reference")) if kind == "clip" else ""})
        at += length
    return items, transitions, at


def flatten(doc):
    """An OTIO timeline as what the viewer draws.

    ``{"name", "fps", "duration", "video": [...], "audio": [...],
    "transitions": [...], "texts": [...]}`` - every time in seconds from the
    start of the film. Only the first video track carries the cut; further ones
    are counted, not drawn.
    """
    if not isinstance(doc, dict) or not str(doc.get("OTIO_SCHEMA") or "").startswith("Timeline"):
        raise ValueError("not an OpenTimelineIO timeline")
    stack = doc.get("tracks") or {}
    tracks = [t for t in (stack.get("children") or []) if isinstance(t, dict)
              and str(t.get("OTIO_SCHEMA") or "").startswith("Track")]
    video = [t for t in tracks if str(t.get("kind") or "Video").lower() == "video"]
    audio = [t for t in tracks if str(t.get("kind") or "").lower() == "audio"]
    out = {"name": str(doc.get("name") or ""), "fps": _rate(doc), "duration": 0.0,
           "video": [], "audio": [], "transitions": [], "texts": [],
           "video_tracks": len(video), "audio_tracks": len(audio)}
    if video:
        out["video"], out["transitions"], out["duration"] = _track(video[0])
    if audio:
        items, _t, length = _track(audio[0])
        out["audio"] = items
        out["duration"] = max(out["duration"], length)
    # Texts are markers on the whole timeline: a title is over the film at a
    # moment, not inside one clip.
    for m in (stack.get("markers") or [])[:_MAX_ITEMS]:
        if not isinstance(m, dict):
            continue
        start, length = _span(m.get("marked_range"))
        note = ((m.get("metadata") or {}).get("agentY") or {}) if isinstance(m.get("metadata"), dict) else {}
        out["texts"].append({"name": str(m.get("name") or note.get("text") or ""),
                             "start": round(start, 4), "length": round(length, 4),
                             "preset": str(note.get("preset") or "")})
    out["duration"] = round(out["duration"], 4)
    return out


def read(path):
    """The flattened timeline in the ``.otio`` at *path*.

    Raises ``ValueError`` for a file that is not one, ``OSError`` for one that
    cannot be read.
    """
    if os.path.getsize(path) > _MAX_BYTES:
        raise ValueError("the timeline file is too large")
    with open(path, "r", encoding="utf-8") as fh:
        try:
            doc = json.load(fh)
        except ValueError:
            raise ValueError("the timeline file is not JSON") from None
    return flatten(doc)
