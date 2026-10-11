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
    media_path = str(media_path or "")
    # A cut that has no film yet is named by its own file.
    if media_path.lower().endswith(".otio"):
        return media_path if os.path.isfile(media_path) else None
    stem = os.path.splitext(media_path)[0]
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


# ── editing ──────────────────────────────────────────────────────────────────
#
# The viewer's Edit panel changes a cut and saves it back into the same file. It
# works on a simpler picture than OTIO's: clips at their FULL length, each with
# the length of the dissolve that leads into it, the way an editor thinks of it
# ("this shot, from here to there, mixing in over a second"). OTIO instead lets
# two clips meet in the middle of a dissolve; :func:`editable` and
# :func:`rebuild` are the two directions between them.
#
# Nothing is rendered here, or anywhere in the viewer: the film beside the file
# stays as it was until whatever made it renders the edited cut.

_MIN_CLIP = 0.1


def _track_of(doc, kind):
    stack = doc.get("tracks") or {}
    for t in stack.get("children") or []:
        if isinstance(t, dict) and str(t.get("OTIO_SCHEMA") or "").startswith("Track") \
                and str(t.get("kind") or "Video").lower() == kind:
            return t
    return None


def _note(obj):
    meta = obj.get("metadata") if isinstance(obj, dict) else None
    note = meta.get("agentY") if isinstance(meta, dict) else None
    return note if isinstance(note, dict) else {}


def editable(doc):
    """An OTIO timeline as the Edit panel works on it.

    ``{"name", "fps", "clips": [{"ref", "name", "file", "in", "length",
    "transition"}], "texts": [{"ref", "text", "start", "length", "preset"}],
    "sound": [{"name", "file"}], "edited"}``. ``ref`` is the item's place in the
    file it came from, so saving can keep everything about it that the panel
    does not show. Clips are at their full length; ``transition`` is the dissolve
    from the clip before.
    """
    if not isinstance(doc, dict) or not str(doc.get("OTIO_SCHEMA") or "").startswith("Timeline"):
        raise ValueError("not an OpenTimelineIO timeline")
    meta = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
    stamp = meta.get("bepic") if isinstance(meta.get("bepic"), dict) else {}
    out = {"name": str(doc.get("name") or ""), "fps": _rate(doc) or 24.0, "clips": [], "texts": [],
           "sound": [], "edited": str(stamp.get("edited") or "")}
    video = _track_of(doc, "video")
    pending = None                      # the dissolve waiting for the clip after it
    for ref, child in enumerate((video or {}).get("children") or []):
        if not isinstance(child, dict):
            continue
        schema = str(child.get("OTIO_SCHEMA") or "")
        if schema.startswith("Transition"):
            before = _seconds(child.get("in_offset") or {})
            after = _seconds(child.get("out_offset") or {})
            if out["clips"]:
                out["clips"][-1]["length"] = round(out["clips"][-1]["length"] + after, 4)
            pending = (before, after)
            continue
        if not schema.startswith("Clip"):
            pending = None
            continue                    # a gap has nothing to cut; it is dropped on save
        start, length = _span(child.get("source_range"))
        clip = {"ref": ref, "name": str(child.get("name") or ""),
                "file": _file(child.get("media_reference")), "in": start, "length": length,
                "transition": 0.0}
        if pending:
            before, after = pending
            clip["in"] = max(0.0, start - before)
            clip["length"] = length + before
            clip["transition"] = round(before + after, 4)
            pending = None
        clip["in"], clip["length"] = round(clip["in"], 4), round(clip["length"], 4)
        out["clips"].append(clip)
    stack = doc.get("tracks") or {}
    for ref, m in enumerate(stack.get("markers") or []):
        if not isinstance(m, dict):
            continue
        start, length = _span(m.get("marked_range"))
        note = _note(m)
        out["texts"].append({"ref": ref, "text": str(note.get("text") or m.get("name") or ""),
                             "start": round(start, 4), "length": round(length, 4),
                             "preset": str(note.get("preset") or "")})
    audio = _track_of(doc, "audio")
    for child in (audio or {}).get("children") or []:
        if isinstance(child, dict) and str(child.get("OTIO_SCHEMA") or "").startswith("Clip"):
            out["sound"].append({"name": str(child.get("name") or ""),
                                 "file": _file(child.get("media_reference"))})
    return out


def edit_length(edit):
    """How long the film of *edit* is: the clips, less what the dissolves take."""
    clips = edit.get("clips") or []
    total = sum(float(c.get("length") or 0) for c in clips)
    return max(0.0, total - sum(float(c.get("transition") or 0) for c in clips[1:]))


def _num(value, what, low=0.0):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{what} is not a number") from None
    if v != v or v < low or v > 86400:
        raise ValueError(f"{what} is out of range")
    return v


def _rt(seconds, rate):
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": float(rate), "value": float(round(seconds * rate))}


def _range(start, length, rate):
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(start, rate), "duration": _rt(length, rate)}


def _url(path):
    p = str(path).replace("\\", "/")
    if p.startswith("//"):
        return "file:" + p
    return "file:///" + p.lstrip("/")


def new_doc(name="cut", fps=24.0):
    """An empty timeline: one video track, nothing on it yet."""
    return {"OTIO_SCHEMA": "Timeline.1", "name": str(name or "cut"), "metadata": {"made_by": "bEpic viewer"},
            "global_start_time": None,
            "tracks": {"OTIO_SCHEMA": "Stack.1", "name": "tracks", "metadata": {}, "source_range": None,
                       "effects": [], "markers": [],
                       "children": [{"OTIO_SCHEMA": "Track.1", "name": "V1", "kind": "Video",
                                     "metadata": {"bepic": {"fps": float(fps or 24.0)}},
                                     "source_range": None, "effects": [], "markers": [],
                                     "children": []}]}}


def rebuild(doc, edit, stamp="", may_use=None):
    """*doc* with the cut replaced by *edit*; returns a new document.

    Each clip and text of *edit* names the item it came from (``ref``), and that
    item is carried over whole - its media, its metadata, anything another
    program wrote into it - with only its range changed.

    A clip with no ``ref`` is NEW material: it names a ``file``, and
    *may_use(path)* decides whether that file may be put into a cut (the route
    passes the viewer's own rule for which files it may show). Without
    *may_use* no new material is taken. Sound is kept as it is, with a bed laid
    under the whole film stretched or cut to the film's new length.
    """
    import copy
    if not isinstance(edit, dict):
        raise ValueError("the edit is not an object")
    new = copy.deepcopy(doc)
    video = _track_of(new, "video")
    if video is None:
        raise ValueError("the timeline has no video track")
    hint = ((video.get("metadata") or {}).get("bepic") or {}) if isinstance(video.get("metadata"), dict) else {}
    rate = _rate(doc) or float(hint.get("fps") or 24.0)
    source = list((_track_of(doc, "video") or {}).get("children") or [])
    clips = edit.get("clips")
    if not isinstance(clips, list) or not clips:
        raise ValueError("a cut needs at least one clip")
    if len(clips) > _MAX_ITEMS:
        raise ValueError("too many clips")
    parsed = []
    for i, c in enumerate(clips, 1):
        ref = c.get("ref") if isinstance(c, dict) else None
        if ref is None and isinstance(c, dict) and str(c.get("file") or "").strip():
            # New material, dropped into the cut.
            path = os.path.abspath(str(c["file"]).strip())
            if may_use is None or not may_use(path):
                raise ValueError(f"clip {i}: {os.path.basename(path)} is not a file the viewer may use")
            if not os.path.isfile(path):
                raise ValueError(f"clip {i}: {os.path.basename(path)} does not exist")
            ref = {"OTIO_SCHEMA": "Clip.1", "name": os.path.basename(path), "metadata": {},
                   "effects": [], "markers": [], "source_range": None,
                   "media_reference": {"OTIO_SCHEMA": "ExternalReference.1", "name": "",
                                       "metadata": {}, "available_range": None,
                                       "target_url": _url(path)}}
        elif not isinstance(ref, int) or isinstance(ref, bool) or not 0 <= ref < len(source) \
                or not str((source[ref] or {}).get("OTIO_SCHEMA") or "").startswith("Clip"):
            raise ValueError(f"clip {i} does not name a clip of this timeline")
        start = _num(c.get("in"), f"clip {i}'s in point")
        length = _num(c.get("length"), f"clip {i}'s length", _MIN_CLIP)
        mix = _num(c.get("transition") or 0, f"clip {i}'s dissolve") if i > 1 else 0.0
        parsed.append((ref, start, length, mix, str(c.get("name")) if c.get("name") is not None else None))
    for i, (_ref, _s, length, mix, _n) in enumerate(parsed):
        if mix and (mix >= length or mix >= parsed[i - 1][2]):
            raise ValueError(f"the dissolve into clip {i + 1} is as long as one of the clips it joins")
    def halves(seconds):
        # In whole frames, and adding up: two rounded halves of a 25-frame
        # dissolve are 24 frames, and the film would come back a frame short.
        frames = round(float(seconds or 0.0) * rate)
        first = frames // 2
        return first / rate, (frames - first) / rate

    children = []
    for i, (ref, start, length, mix, name) in enumerate(parsed):
        head, before = halves(mix if i else 0.0)
        tail = halves(parsed[i + 1][3])[1] if i + 1 < len(parsed) else 0.0
        if head or before:
            children.append({"OTIO_SCHEMA": "Transition.1", "name": "", "metadata": {},
                             "transition_type": "SMPTE_Dissolve",
                             "in_offset": _rt(head, rate), "out_offset": _rt(before, rate)})
        item = copy.deepcopy(ref if isinstance(ref, dict) else source[ref])
        item["source_range"] = _range(start + head, length - head - tail, rate)
        if name is not None:
            item["name"] = name[:200]
        children.append(item)
    video["children"] = children
    film = edit_length({"clips": [{"length": p[2], "transition": p[3]} for p in parsed]})

    stack = new.get("tracks") or {}
    old_marks = list(((doc.get("tracks") or {}).get("markers")) or [])
    marks = []
    for i, t in enumerate(edit.get("texts") or [], 1):
        ref = t.get("ref") if isinstance(t, dict) else None
        if not isinstance(ref, int) or isinstance(ref, bool) or not 0 <= ref < len(old_marks):
            raise ValueError(f"text {i} does not name a text of this timeline")
        start = _num(t.get("start"), f"text {i}'s start")
        length = _num(t.get("length"), f"text {i}'s length", 0.2)
        mark = copy.deepcopy(old_marks[ref])
        mark["marked_range"] = _range(start, length, rate)
        if t.get("text") is not None:
            text = str(t["text"])[:2000]
            mark["name"] = text.splitlines()[0][:80] if text.strip() else ""
            meta = mark.setdefault("metadata", {})
            if isinstance(meta, dict):
                note = meta.setdefault("agentY", {})
                if isinstance(note, dict):
                    note["text"] = text
        marks.append(mark)
    stack["markers"] = marks

    audio = _track_of(new, "audio")
    kids = [c for c in (audio or {}).get("children") or [] if isinstance(c, dict)]
    if audio is not None and len(kids) == 1 and str(kids[0].get("OTIO_SCHEMA") or "").startswith("Clip"):
        start, _length = _span(kids[0].get("source_range"))
        kids[0]["source_range"] = _range(start, film, rate)
    meta = new.setdefault("metadata", {})
    if isinstance(meta, dict):
        meta["bepic"] = {"edited": str(stamp or ""),
                         "note": "cut changed in the bEpic viewer; the film beside this file "
                                 "has not been rendered again"}
    return new


def _load(path):
    if os.path.getsize(path) > _MAX_BYTES:
        raise ValueError("the timeline file is too large")
    with open(path, "r", encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except ValueError:
            raise ValueError("the timeline file is not JSON") from None


def read_editable(path):
    """The cut in the ``.otio`` at *path*, as the Edit panel works on it."""
    return editable(_load(path))


def save(path, edit, stamp="", may_use=None, create=None):
    """Write *edit* into the ``.otio`` at *path*; returns the cut as it now reads.

    Written to a file beside it first and moved over: a save that fails halfway
    leaves the timeline that was there. With *create* (a timeline's name) the
    file is a new one, started empty.
    """
    doc = new_doc(create) if create is not None else _load(path)
    new = rebuild(doc, edit, stamp, may_use)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(new, fh, indent=2)
    os.replace(tmp, path)
    return editable(new)
