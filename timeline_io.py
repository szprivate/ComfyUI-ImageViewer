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


_COLOR = __import__("re").compile(r"^#[0-9a-fA-F]{6}$")


def _bepic(obj):
    meta = obj.get("metadata") if isinstance(obj, dict) else None
    note = meta.get("bepic") if isinstance(meta, dict) else None
    return note if isinstance(note, dict) else {}


def _is_off(track):
    """A track that is switched off: ours (``metadata.bepic.off``) or OTIO's ``enabled``."""
    return bool(track) and (bool(_bepic(track).get("off")) or track.get("enabled") is False)


# What the Inspector's Video tab sets on a clip (bEpicViewer_editTimelineData.js
# has the same table, FX): each key with its neutral value and the range it is
# held to. Zoom is a factor; position and anchor point are fractions of the
# frame (x of its width to the right, y of its height UP); rotation is degrees,
# clockwise; a crop is the fraction of the picture taken off that side; opacity
# is 0..1. `toff` / `coff` / `ooff` switch a whole section off without losing
# its numbers.
FX = {"zx": (1.0, 0.01, 20.0), "zy": (1.0, 0.01, 20.0), "x": (0.0, -5.0, 5.0), "y": (0.0, -5.0, 5.0),
      "rot": (0.0, -3600.0, 3600.0), "ax": (0.0, -5.0, 5.0), "ay": (0.0, -5.0, 5.0),
      "cl": (0.0, 0.0, 1.0), "cr": (0.0, 0.0, 1.0), "ct": (0.0, 0.0, 1.0), "cb": (0.0, 0.0, 1.0),
      "op": (1.0, 0.0, 1.0)}
FX_FLAGS = ("fh", "fv", "toff", "coff", "ooff")


def clean_fx(given):
    """*given* held to what an effect may be, with only what differs from neutral
    kept: ``{}`` is a clip as it comes."""
    out = {}
    if not isinstance(given, dict):
        return out
    for key, (neutral, low, high) in FX.items():
        try:
            value = float(given.get(key, neutral))
        except (TypeError, ValueError):
            continue
        if value != value:
            continue
        value = round(max(low, min(high, value)), 5)
        if value != neutral:
            out[key] = value
    for key in FX_FLAGS:
        if given.get(key):
            out[key] = True
    return out


def _look(item):
    """What the panel shows of a clip beyond its range: its colour, its volume,
    and what the Inspector did to its picture (``fx``)."""
    try:
        volume = float(_note(item).get("volume", 1.0))
    except (TypeError, ValueError):
        volume = 1.0
    return {"color": str(_bepic(item).get("color") or ""), "volume": round(max(0.0, min(4.0, volume)), 4),
            "fx": clean_fx(_bepic(item).get("fx"))}


# How a text is drawn where its timeline does not say: centred, in the lower
# part of the picture, a sixteenth of its height, white.
TEXT_LOOK = {"size": 6.0, "x": 0.5, "y": 0.85, "color": "#ffffff"}


def text_look(mark):
    """A text's look: ``{"size", "x", "y", "color"}``. ``size`` is a percentage
    of the picture's height, ``x`` / ``y`` where its middle is (0..1)."""
    note = _bepic(mark)
    out = dict(TEXT_LOOK)
    for key, low, high in (("size", 1.0, 40.0), ("x", 0.0, 1.0), ("y", 0.0, 1.0)):
        try:
            out[key] = round(max(low, min(high, float(note.get(key, out[key])))), 4)
        except (TypeError, ValueError):
            pass
    color = str(note.get("color") or "")
    if _COLOR.match(color):
        out["color"] = color.lower()
    return out


def _tracks(doc):
    """``[(place in the stack, track)]`` of every track of the timeline."""
    stack = doc.get("tracks") or {}
    return [(i, t) for i, t in enumerate(stack.get("children") or [])
            if isinstance(t, dict) and str(t.get("OTIO_SCHEMA") or "").startswith("Track")]


def _kind(track):
    return "audio" if str(track.get("kind") or "Video").lower() == "audio" else "video"


def extra_tracks(doc):
    """The tracks beyond the first video and the first audio track, as the panel
    works on them: ``[{"id", "kind", "name", "off", "clips": [{"ref", "name",
    "file", "in", "length", "at", "color", "volume"}]}]``. A clip's ``at`` is
    where it begins in the film; ``ref`` is ``[track, child]`` in the file."""
    first = {"video": _track_of(doc, "video"), "audio": _track_of(doc, "audio")}
    count = {"video": 1, "audio": 1}
    out = []
    for ti, track in _tracks(doc):
        kind = _kind(track)
        if track is first[kind]:
            continue
        count[kind] += 1
        tid = ("V" if kind == "video" else "A") + str(count[kind])
        clips, at = [], 0.0
        for ci, child in enumerate((track.get("children") or [])[:_MAX_ITEMS]):
            if not isinstance(child, dict):
                continue
            schema = str(child.get("OTIO_SCHEMA") or "")
            if schema.startswith("Transition"):
                continue
            start, length = _span(child.get("source_range"))
            if schema.startswith("Clip") and length > 0:
                clips.append({"ref": [ti, ci], "name": str(child.get("name") or ""),
                              "file": _file(child.get("media_reference")), "in": round(start, 4),
                              "length": round(length, 4), "at": round(at, 4), **_look(child)})
            at += length
        out.append({"id": tid, "kind": kind, "name": str(track.get("name") or tid), "off": _is_off(track),
                    "clips": clips})
    return out


def editable(doc):
    """An OTIO timeline as the Edit panel works on it.

    ``{"name", "fps", "clips": [{"ref", "name", "file", "in", "length",
    "transition", "color", "volume"}], "texts": [{"ref", "text", "start",
    "length", "preset"}], "sound": [{"name", "file"}], "tracks": [...],
    "off": {"V1", "A1"}, "edited"}``. ``ref`` is the item's place in the
    file it came from, so saving can keep everything about it that the panel
    does not show. Clips are at their full length; ``transition`` is the dissolve
    from the clip before. ``tracks`` are the tracks beyond the first of each
    kind (:func:`extra_tracks`): clips placed at a moment of the film, the
    picture of a higher track covering what is under it.
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
                "transition": 0.0, **_look(child)}
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
                             "preset": str(note.get("preset") or ""), **text_look(m)})
    audio = _track_of(doc, "audio")
    for child in (audio or {}).get("children") or []:
        if isinstance(child, dict) and str(child.get("OTIO_SCHEMA") or "").startswith("Clip"):
            out["sound"].append({"name": str(child.get("name") or ""),
                                 "file": _file(child.get("media_reference"))})
    out["tracks"] = extra_tracks(doc)
    out["off"] = {"V1": _is_off(video), "A1": _is_off(audio),
                  "T": bool(_bepic(stack).get("texts_off"))}
    return out


def edit_length(edit):
    """How long the film of *edit* is: the clips, less what the dissolves take -
    or as far as the last clip on a higher video track reaches, if that is later."""
    clips = edit.get("clips") or []
    total = sum(float(c.get("length") or 0) for c in clips)
    main = max(0.0, total - sum(float(c.get("transition") or 0) for c in clips[1:]))
    over = [float(c.get("at") or 0) + float(c.get("length") or 0)
            for t in (edit.get("tracks") or []) if isinstance(t, dict) and t.get("kind") != "audio"
            for c in (t.get("clips") or []) if isinstance(c, dict)]
    return max([main] + over)


def _dress(item, c):
    """Write a clip's colour and volume, where the edit states them, into *item*."""
    if "color" in c:
        color = str(c.get("color") or "")
        meta = item.setdefault("metadata", {})
        if isinstance(meta, dict):
            note = meta.setdefault("bepic", {})
            if isinstance(note, dict):
                if _COLOR.match(color):
                    note["color"] = color.lower()
                else:
                    note.pop("color", None)
    if "fx" in c:
        meta = item.setdefault("metadata", {})
        if isinstance(meta, dict):
            note = meta.setdefault("bepic", {})
            if isinstance(note, dict):
                fx = clean_fx(c.get("fx"))
                if fx:
                    note["fx"] = fx
                else:
                    note.pop("fx", None)
    if c.get("volume") is not None:
        volume = max(0.0, min(4.0, _num(c.get("volume"), "a clip's volume")))
        meta = item.setdefault("metadata", {})
        if isinstance(meta, dict):
            note = meta.setdefault("agentY", {})
            if isinstance(note, dict):
                note["volume"] = round(volume, 4)


def _set_off(track, off):
    if track is None:
        return
    meta = track.setdefault("metadata", {})
    if isinstance(meta, dict):
        note = meta.setdefault("bepic", {})
        if isinstance(note, dict):
            note["off"] = bool(off)
    track["enabled"] = not off


def _new_clip(c, what, may_use):
    path = os.path.abspath(str(c["file"]).strip())
    if may_use is None or not may_use(path):
        raise ValueError(f"{what}: {os.path.basename(path)} is not a file the viewer may use")
    if not os.path.isfile(path):
        raise ValueError(f"{what}: {os.path.basename(path)} does not exist")
    return {"OTIO_SCHEMA": "Clip.1", "name": os.path.basename(path), "metadata": {},
            "effects": [], "markers": [], "source_range": None,
            "media_reference": {"OTIO_SCHEMA": "ExternalReference.1", "name": "",
                                "metadata": {}, "available_range": None,
                                "target_url": _url(path)}}


def _build_tracks(doc, tracks, rate, may_use):
    """The extra tracks of an edit as OTIO tracks: ``(video tracks, audio tracks)``.

    A track is a row of clips with gaps between them, so two clips of one track
    cannot share a moment: where they would, the earlier one ends where the
    later one begins.
    """
    import copy
    if not isinstance(tracks, list):
        raise ValueError("the tracks are not a list")
    if len(tracks) > 32:
        raise ValueError("too many tracks")
    stack = (doc.get("tracks") or {}).get("children") or []
    made = {"video": [], "audio": []}
    for n, t in enumerate(tracks, 1):
        if not isinstance(t, dict):
            raise ValueError(f"track {n} is not an object")
        kind = "audio" if t.get("kind") == "audio" else "video"
        name = str(t.get("name") or t.get("id") or f"track {n}")[:80]
        clips = t.get("clips") or []
        if not isinstance(clips, list) or len(clips) > _MAX_ITEMS:
            raise ValueError(f"{name}: its clips are not a list this can hold")
        placed = []
        for i, c in enumerate(clips, 1):
            what = f"{name}, clip {i}"
            if not isinstance(c, dict):
                raise ValueError(f"{what} is not an object")
            ref = c.get("ref")
            if ref is None and str(c.get("file") or "").strip():
                item = _new_clip(c, what, may_use)
            else:
                ok = (isinstance(ref, list) and len(ref) == 2 and all(isinstance(v, int) and not isinstance(v, bool)
                                                                      for v in ref)
                      and 0 <= ref[0] < len(stack) and isinstance(stack[ref[0]], dict))
                kids = (stack[ref[0]].get("children") or []) if ok else []
                if not ok or not 0 <= ref[1] < len(kids) \
                        or not str((kids[ref[1]] or {}).get("OTIO_SCHEMA") or "").startswith("Clip"):
                    raise ValueError(f"{what} does not name a clip of this timeline")
                item = copy.deepcopy(kids[ref[1]])
            at = _num(c.get("at") or 0, f"{what}'s place")
            start = _num(c.get("in") or 0, f"{what}'s in point")
            length = _num(c.get("length"), f"{what}'s length", _MIN_CLIP)
            if c.get("name") is not None:
                item["name"] = str(c["name"])[:200]
            _dress(item, c)
            placed.append([round(at * rate), round(start * rate), max(1, round(length * rate)), item])
        placed.sort(key=lambda p: p[0])
        children, cursor = [], 0
        for k, (at, start, length, item) in enumerate(placed):
            if k + 1 < len(placed):
                length = min(length, placed[k + 1][0] - at)      # it ends where the next one begins
            if length <= 0:
                continue
            if at > cursor:
                children.append({"OTIO_SCHEMA": "Gap.1", "name": "", "metadata": {}, "effects": [], "markers": [],
                                 "source_range": _range(0.0, (at - cursor) / rate, rate)})
            item["source_range"] = _range(start / rate, length / rate, rate)
            children.append(item)
            cursor = at + length
        track = {"OTIO_SCHEMA": "Track.1", "name": name, "kind": "Audio" if kind == "audio" else "Video",
                 "metadata": {}, "source_range": None, "effects": [], "markers": [], "children": children}
        _set_off(track, bool(t.get("off")))
        made[kind].append(track)
    return made["video"], made["audio"]


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

    A text with no ``ref`` is a new one. ``tracks`` (when the edit has the key)
    replaces every track beyond the first video and the first audio track;
    ``off`` switches those two off or on. An edit without those keys - an older
    page - leaves what the file holds of them alone.
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
            ref = _new_clip(c, f"clip {i}", may_use)
        elif not isinstance(ref, int) or isinstance(ref, bool) or not 0 <= ref < len(source) \
                or not str((source[ref] or {}).get("OTIO_SCHEMA") or "").startswith("Clip"):
            raise ValueError(f"clip {i} does not name a clip of this timeline")
        start = _num(c.get("in"), f"clip {i}'s in point")
        length = _num(c.get("length"), f"clip {i}'s length", _MIN_CLIP)
        mix = _num(c.get("transition") or 0, f"clip {i}'s dissolve") if i > 1 else 0.0
        parsed.append((ref, start, length, mix, str(c.get("name")) if c.get("name") is not None else None, c))
    for i, (_ref, _s, length, mix, _n, _c) in enumerate(parsed):
        if mix and (mix >= length or mix >= parsed[i - 1][2]):
            raise ValueError(f"the dissolve into clip {i + 1} is as long as one of the clips it joins")
    def halves(seconds):
        # In whole frames, and adding up: two rounded halves of a 25-frame
        # dissolve are 24 frames, and the film would come back a frame short.
        frames = round(float(seconds or 0.0) * rate)
        first = frames // 2
        return first / rate, (frames - first) / rate

    children = []
    for i, (ref, start, length, mix, name, given) in enumerate(parsed):
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
        _dress(item, given)
        children.append(item)
    video["children"] = children
    audio = _track_of(new, "audio")
    if "tracks" in edit:
        more_video, more_audio = _build_tracks(doc, edit.get("tracks") or [], rate, may_use)
        stack_new = new.get("tracks") or {}
        kept = [t for t in (stack_new.get("children") or [])
                if not (isinstance(t, dict) and str(t.get("OTIO_SCHEMA") or "").startswith("Track"))
                or t is video or t is audio]
        # Bottom to top, as OTIO stacks them: the cut, what lies over it, then the sound.
        at = kept.index(video) + 1
        kept[at:at] = more_video
        if more_audio and audio is None:
            # The first sound track of a timeline is the bed under the whole film
            # (A1). A cut that has none gets an empty one, or the first track
            # added would be read back as the bed.
            audio = {"OTIO_SCHEMA": "Track.1", "name": "A1", "kind": "Audio", "metadata": {},
                     "source_range": None, "effects": [], "markers": [], "children": []}
            kept.append(audio)
        kept.extend(more_audio)
        stack_new["children"] = kept
    off = edit.get("off")
    if isinstance(off, dict):
        if "V1" in off:
            _set_off(video, bool(off["V1"]))
        if "A1" in off:
            _set_off(audio, bool(off["A1"]))
        if "T" in off:
            stack_meta = (new.get("tracks") or {}).setdefault("metadata", {})
            if isinstance(stack_meta, dict):
                note = stack_meta.setdefault("bepic", {})
                if isinstance(note, dict):
                    note["texts_off"] = bool(off["T"])
    film = edit_length({"clips": [{"length": p[2], "transition": p[3]} for p in parsed],
                        "tracks": extra_tracks(new)})

    stack = new.get("tracks") or {}
    old_marks = list(((doc.get("tracks") or {}).get("markers")) or [])
    marks = []
    for i, t in enumerate(edit.get("texts") or [], 1):
        ref = t.get("ref") if isinstance(t, dict) else None
        if ref is None and isinstance(t, dict):
            # A text written in the panel: a marker of its own, said the way agentY says its texts.
            mark = {"OTIO_SCHEMA": "Marker.2", "name": "", "color": "PURPLE", "marked_range": None,
                    "metadata": {"agentY": {"text": ""}, "made_by": "bEpic viewer"}}
        elif not isinstance(ref, int) or isinstance(ref, bool) or not 0 <= ref < len(old_marks):
            raise ValueError(f"text {i} does not name a text of this timeline")
        else:
            mark = copy.deepcopy(old_marks[ref])
        start = _num(t.get("start"), f"text {i}'s start")
        length = _num(t.get("length"), f"text {i}'s length", 0.2)
        mark["marked_range"] = _range(start, length, rate)
        if t.get("text") is not None:
            text = str(t["text"])[:2000]
            mark["name"] = text.splitlines()[0][:80] if text.strip() else ""
            meta = mark.setdefault("metadata", {})
            if isinstance(meta, dict):
                note = meta.setdefault("agentY", {})
                if isinstance(note, dict):
                    note["text"] = text
        look = {k: t[k] for k in TEXT_LOOK if isinstance(t, dict) and t.get(k) is not None}
        if look:
            meta = mark.setdefault("metadata", {})
            if isinstance(meta, dict):
                note = meta.setdefault("bepic", {})
                if isinstance(note, dict):
                    note.update(look)
                    note.update(text_look(mark))          # held to what a look may be
        marks.append(mark)
    stack["markers"] = marks

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
