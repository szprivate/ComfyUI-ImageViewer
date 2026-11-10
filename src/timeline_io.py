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
import math
import os
import re

try:                                    # the viewer's old "bEpic" names (legacy_names.py)
    from .legacy_names import renamed_otio as _renamed_otio
except ImportError:
    from legacy_names import renamed_otio as _renamed_otio

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
            doc = _renamed_otio(json.load(fh))
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


_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _imageviewer(obj):
    meta = obj.get("metadata") if isinstance(obj, dict) else None
    note = meta.get("imageviewer") if isinstance(meta, dict) else None
    return note if isinstance(note, dict) else {}


def _is_off(track):
    """A track that is switched off: ours (``metadata.imageviewer.off``) or OTIO's ``enabled``."""
    return bool(track) and (bool(_imageviewer(track).get("off")) or track.get("enabled") is False)


# What the Inspector's Video tab sets on a clip (imageViewer_editTimelineData.js
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
    keys = clean_keys(given.get("keys"))
    if keys:
        out["keys"] = keys
    return out


# Keyframes (imageViewer_editTimelineData.js, cleanKeys / keyValue - kept in step):
# ``fx["keys"] = {param: [{"t", "v", "i"}]}``, ``t`` seconds of CLIP time (from the
# clip's first frame on the timeline), ``i`` how it goes on to the next key:
# absent linear, "in", "out", "inout", "hold". "vol" is the clip's volume; "tsize", "ttrack", "tline",
# "tsw" a title's size, tracking, line spacing and outline width (title_render.TITLE_KEYS).
_TITLE_KEY_RANGES = {"tsize": (0.5, 40.0), "ttrack": (-200.0, 1000.0), "tline": (0.5, 4.0), "tsw": (0.0, 50.0)}
KEY_PARAMS = tuple(FX) + ("vol",) + tuple(_TITLE_KEY_RANGES) + ("spd",)
INTERPS = ("linear", "in", "out", "inout", "hold")


def clean_keys(given):
    """*given* held to what keys may be: known params, finite, sorted, one per moment (the last wins)."""
    out = {}
    if not isinstance(given, dict):
        return out
    for p in KEY_PARAMS:
        items = given.get(p)
        if not isinstance(items, list):
            continue
        low, high = (0.0, 1.0) if p == "vol" else (MIN_SPEED, MAX_SPEED) if p == "spd" else _TITLE_KEY_RANGES[p] if p in _TITLE_KEY_RANGES else FX[p][1:]
        by = {}
        for k in items:
            if not isinstance(k, dict):
                continue
            try:
                t, v = float(k.get("t")), float(k.get("v"))
            except (TypeError, ValueError):
                continue
            if t != t or v != v or t < 0 or t in (float("inf"),) or v in (float("inf"), float("-inf")):
                continue
            key = {"t": round(t, 4), "v": round(max(low, min(high, v)), 5)}
            if k.get("i") in INTERPS and k.get("i") != "linear":
                key["i"] = k["i"]
            by[key["t"]] = key
        keys = sorted(by.values(), key=lambda k: k["t"])[:1000]
        if keys:
            out[p] = keys
    return out


# A V1 dissolve's look (imageViewer_editTimelineData.js, "video transitions"): a cross
# dissolve, a dip to a colour, or a wipe. Kept on the OTIO Transition in
# metadata.imageviewer.transition; its transition_type stays SMPTE_Dissolve, so
# another program reads a dissolve of the same length.
WIPE_DIRS = ("right", "left", "down", "up")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def clean_tfx(x):
    """A transition's look held to what it may be (cleanTfx); None for a cross dissolve."""
    if not isinstance(x, dict):
        return None
    if x.get("type") == "dip":
        color = str(x.get("color") or "")
        return {"type": "dip", "color": color.lower() if _HEX.match(color) else "#000000"}
    if x.get("type") == "wipe":
        return {"type": "wipe", "dir": x.get("dir") if x.get("dir") in WIPE_DIRS else "right"}
    return None


def _look(item):
    """What the panel shows of a clip beyond its range: its colour, its volume,
    and what the Inspector did to its picture (``fx``)."""
    try:
        volume = float(_note(item).get("volume", 1.0))
    except (TypeError, ValueError):
        volume = 1.0
    out = {"color": str(_imageviewer(item).get("color") or ""), "volume": round(max(0.0, min(4.0, volume)), 4),
           "fx": clean_fx(_imageviewer(item).get("fx")), **clip_time(item)}
    takes = clean_takes(_imageviewer(item).get("takes"))
    if takes:
        out["takes"] = takes
    out.update(clip_link(item))
    out.update(clip_audio(item))
    marks = read_markers(item, clip=True)
    if marks:
        out["markers"] = marks
    return out


# A film's picture and its sound can be split apart (the Edit panel's "Unlink audio
# / video", Resolve's Link Clips switched off): the video clip stays where it is,
# with its own sound muted (``mute``), and a clip of the same file on a sound track
# carries the sound - at its own place, so it can start earlier or end later (a J
# or L cut). The two share a link group (``link``); ``unlinked`` says they are
# moved and trimmed apart, else they go together. All three in ``metadata.imageviewer``;
# the media reference of each is the same file, so any other program reads two
# plain clips.
_LINK = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")


def clip_link(item):
    """``{"link", "unlinked", "mute"}`` of a clip - only the keys it has."""
    note = _imageviewer(item)
    out = {}
    link = note.get("link")
    if isinstance(link, str) and _LINK.match(link):
        out["link"] = link
        if note.get("unlinked") is True:
            out["unlinked"] = True
    if note.get("mute") is True:
        out["mute"] = True
    # Switched off (the panel's D, Resolve's Clip Enable): ours, or OTIO's own `enabled`.
    if note.get("disabled") is True or item.get("enabled") is False:
        out["disabled"] = True
    # A piece of a compound clip (saved flat: see compounds_of); the panel folds the pieces back.
    part = note.get("cpart")
    if isinstance(part, dict) and isinstance(part.get("id"), str) and _LINK.match(part["id"]):
        out["cpart"] = {"id": part["id"]}
    return out


def _set_link(item, c):
    """Write a clip's link group, mute and switch, where the edit states them, into *item*."""
    if "disabled" in c:
        item["enabled"] = c.get("disabled") is not True
    if not any(k in c for k in ("link", "unlinked", "mute", "disabled", "cpart")):
        return
    meta = item.setdefault("metadata", {})
    note = meta.setdefault("imageviewer", {}) if isinstance(meta, dict) else None
    if not isinstance(note, dict):
        return
    if "link" in c:
        link = c.get("link")
        if isinstance(link, str) and _LINK.match(link):
            note["link"] = link
        else:
            note.pop("link", None)
    if "unlinked" in c or "link" in c:
        if c.get("unlinked") is True and note.get("link"):
            note["unlinked"] = True
        else:
            note.pop("unlinked", None)
    if "mute" in c:
        if c.get("mute") is True:
            note["mute"] = True
        else:
            note.pop("mute", None)
    if "disabled" in c:
        if c.get("disabled") is True:
            note["disabled"] = True
        else:
            note.pop("disabled", None)
    if "cpart" in c:
        part = c.get("cpart")
        if isinstance(part, dict) and isinstance(part.get("id"), str) and _LINK.match(part["id"]):
            note["cpart"] = {"id": part["id"]}
        else:
            note.pop("cpart", None)


# Audio transitions and fades (imageViewer_editTimelineData.js, "audio transitions and fades" -
# the same arithmetic, kept in step; tests/test_edit_audio_xfade.py holds the two to each other).
# A crossfade lies on the clip coming in, ``xfade = {"len", "curve", "align"}``: "centre" half
# before the cut and half after, "start" all after (the clip going out plays on past its end),
# "end" all before (the clip coming in begins early) - the sound beyond the cut is the clips'
# handles, so nothing moves. ``curve`` "0" (straight), "+3" (equal power, the default) or "-3"
# (x^1.5). ``fadeIn`` / ``fadeOut``: seconds of the clip, straight lines of gain; a crossfade on a
# side takes the fade's place. In the file ``metadata.imageviewer.afade_in`` / ``afade_out`` / ``axfade``;
# the bed's fade out is agentY's own ``metadata.agentY.fade_out`` (1 s where it says nothing).
XF_CURVES = ("+3", "0", "-3")
XF_ALIGNS = ("centre", "start", "end")
MIN_XFADE = 0.02


def curve_gain(curve, p):
    """The gain of a fade coming in, *p* (0..1) of the way through (curveGain in the JS)."""
    import math
    x = max(0.0, min(1.0, float(p)))
    if curve == "0":
        return x
    if curve == "-3":
        return x ** 1.5
    return math.sin(x * math.pi / 2)


def clean_xfade(x):
    """A crossfade held to what one may be, or None."""
    if not isinstance(x, dict):
        return None
    try:
        length = round(float(x.get("len") or 0), 4)
    except (TypeError, ValueError):
        return None
    if length != length or not length >= MIN_XFADE - 1e-9:
        return None
    return {"len": min(length, 60.0), "curve": x.get("curve") if x.get("curve") in XF_CURVES else "+3",
            "align": x.get("align") if x.get("align") in XF_ALIGNS else "centre"}


def xfade_sides(x):
    """``(before, after)``: how much of a crossfade lies before the cut and after it."""
    length = float(x["len"])
    if x.get("align") == "start":
        return 0.0, length
    if x.get("align") == "end":
        return length, 0.0
    b = round(length / 2, 4)
    return b, round(length - b, 4)


def env_gain(env, u):
    """The gain of a clip's fades and crossfades at clip time *u* (envGain in the JS).
    *env*: ``{"len", "fi", "fo", "xin", "xout"}``, a crossfade ``{"b", "a", "curve"}``."""
    if not env:
        return 1.0
    t, length = float(u), float(env["len"])
    xin, xout = env.get("xin"), env.get("xout")
    lo = -xin["b"] if xin else 0.0
    hi = length + xout["a"] if xout else length
    if t < lo - 1e-9 or t > hi + 1e-9:
        return 0.0
    g = 1.0
    if xin:
        span = xin["b"] + xin["a"]
        if span > 0 and t < xin["a"]:
            g *= curve_gain(xin["curve"], (t + xin["b"]) / span)
    elif env.get("fi", 0) > 0 and t < env["fi"]:
        g *= max(0.0, t) / env["fi"]
    if xout:
        span, s = xout["b"] + xout["a"], length - xout["b"]
        if span > 0 and t > s:
            g *= curve_gain(xout["curve"], 1 - (t - s) / span)
    elif env.get("fo", 0) > 0 and t > length - env["fo"]:
        g *= max(0.0, length - t) / env["fo"]
    return max(0.0, min(1.0, g))


def _fade_num(value):
    try:
        v = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return round(v, 4) if 0 < v < 86400 else 0.0


def clip_audio(item):
    """``{"fadeIn", "fadeOut", "xfade"}`` of a clip - only the keys it has."""
    note = _imageviewer(item)
    out = {}
    fi, fo = _fade_num(note.get("afade_in")), _fade_num(note.get("afade_out"))
    if fi:
        out["fadeIn"] = fi
    if fo:
        out["fadeOut"] = fo
    x = clean_xfade(note.get("axfade"))
    if x:
        out["xfade"] = x
    chain = _afx().clean_chain(note.get("afx"))
    if chain:
        out["afx"] = chain
    return out


def _afx():
    from . import audio_fx
    return audio_fx


# Markers (the panel's M, Resolve's): on the timeline - the first video track's
# markers, in film seconds (the stack's markers are agentY's texts) - and on
# clips, in seconds of the clip's source (OTIO's own rule for a clip's markers),
# so they ride with the picture. Every marker of those lists is read; one the
# panel wrote carries ``metadata.imageviewer.marker`` (its note, its length on the
# timeline). ``ref`` is its place in the list it came from, so a save keeps what
# another program wrote into it. The same rules as cleanMarkers in the JS.
MARKER_COLORS = ("blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple", "magenta", "white")
_MAX_MARKERS = 1000


def _marker_color(value):
    c = str(value or "").lower()
    return c if c in MARKER_COLORS else ("magenta" if c == "fuchsia" else "blue")


def read_markers(obj, clip=False):
    """The markers of an OTIO item: ``[{"t" | "src", "len", "name", "note", "color", "ref"}]``, in time order."""
    out = []
    marks = obj.get("markers") if isinstance(obj, dict) else None
    for ref, m in enumerate((marks or [])[:_MAX_MARKERS]):
        if not isinstance(m, dict) or not str(m.get("OTIO_SCHEMA") or "").startswith("Marker"):
            continue
        start, length = _span(m.get("marked_range"))
        note = _imageviewer(m).get("marker")
        note = note if isinstance(note, dict) else {}
        try:
            span = float(note.get("len", length) or 0)
        except (TypeError, ValueError):
            span = length
        text = note.get("note", m.get("comment"))
        item = {("src" if clip else "t"): round(max(0.0, start), 4), "len": round(max(0.0, span), 4),
                "name": str(m.get("name") or "")[:200], "note": str(text or "")[:2000],
                "color": _marker_color(m.get("color")), "ref": ref}
        out.append(item)
    return sorted(out, key=lambda x: x["src" if clip else "t"])


def film_markers(edit):
    """Every marker of an editable cut in film seconds, in time order: ``[{"t", "len", "name", "note", "color", "clip"}]``
    (``clip`` "V1:2" / "V2:0" for a clip's own; "" for the timeline's). allMarkers in the JS does the same."""
    out = [{**{k: m.get(k) for k in ("len", "name", "note", "color")}, "t": float(m.get("t") or 0), "clip": ""}
           for m in edit.get("markers") or []]

    def of_clip(c, start, cid):
        try:
            speed = float(c.get("speed") or 1) or 1.0
        except (TypeError, ValueError):
            speed = 1.0
        still = not c.get("file") or c.get("title") is not None
        for m in c.get("markers") or []:
            u = float(m.get("src") or 0) if still else (float(m.get("src") or 0) - float(c.get("in") or 0)) / speed
            if -1e-6 <= u <= float(c.get("length") or 0) + 1e-6:
                out.append({**{k: m.get(k) for k in ("len", "name", "note", "color")}, "t": round(start + max(0.0, u), 4), "clip": cid})
    at = 0.0
    for i, c in enumerate(edit.get("clips") or []):
        at += float(c.get("gap") or 0)
        if i:
            at -= float(c.get("transition") or 0)
        of_clip(c, at, f"V1:{i}")
        at += float(c.get("length") or 0)
    for k in edit.get("tracks") or []:
        for i, c in enumerate(k.get("clips") or []):
            of_clip(c, float(c.get("at") or 0), f"{k.get('id')}:{i}")
    return sorted(out, key=lambda m: m["t"])


def _write_markers(obj, given, rate, clip=False, speed=1.0):
    """Lay the edit's markers (*given*, as read_markers gives them) into OTIO item *obj*'s list."""
    import copy
    old = list(obj.get("markers") or []) if isinstance(obj.get("markers"), list) else []
    out = []
    for i, m in enumerate((given or [])[:_MAX_MARKERS], 1):
        if not isinstance(m, dict):
            continue
        at = _num(m.get("src" if clip else "t"), f"marker {i}'s moment")
        span = max(0.0, float(m.get("len") or 0) if isinstance(m.get("len"), (int, float)) else 0.0)
        ref = m.get("ref")
        if isinstance(ref, int) and not isinstance(ref, bool) and 0 <= ref < len(old) and isinstance(old[ref], dict):
            mark = copy.deepcopy(old[ref])
        else:
            mark = {"OTIO_SCHEMA": "Marker.2", "metadata": {}}
        mark["name"] = str(m.get("name") or "")[:200]
        mark["color"] = _marker_color(m.get("color")).upper()
        mark["comment"] = str(m.get("note") or "")[:2000]
        mark["marked_range"] = _range(max(0.0, at), span * (speed if clip else 1.0), rate)
        meta = mark.setdefault("metadata", {})
        if isinstance(meta, dict):
            note = meta.setdefault("imageviewer", {})
            if isinstance(note, dict):
                note["marker"] = {"note": mark["comment"], "len": round(span, 4)}
        out.append(mark)
    obj["markers"] = out


def _set_audio(item, c):
    """Write a clip's fades and crossfade, where the edit states them, into *item*."""
    if not any(k in c for k in ("fadeIn", "fadeOut", "xfade", "afx")):
        return
    meta = item.setdefault("metadata", {})
    note = meta.setdefault("imageviewer", {}) if isinstance(meta, dict) else None
    if not isinstance(note, dict):
        return
    for key, name in (("fadeIn", "afade_in"), ("fadeOut", "afade_out")):
        if key in c:
            v = _fade_num(c.get(key))
            if v:
                note[name] = v
            else:
                note.pop(name, None)
    if "xfade" in c:
        x = clean_xfade(c.get("xfade"))
        if x:
            note["axfade"] = x
        else:
            note.pop("axfade", None)
    if "afx" in c:
        chain = _afx().clean_chain(c.get("afx"))
        if chain:
            note["afx"] = chain
        else:
            note.pop("afx", None)


def bed_fades(item):
    """The bed's fades: ``{"fadeIn", "fadeOut"}`` (its fade out agentY's, 1 s where it says nothing)."""
    try:
        fo = float(_note(item).get("fade_out", 1.0))
    except (TypeError, ValueError):
        fo = 1.0
    return {"fadeIn": _fade_num(_imageviewer(item).get("afade_in")), "fadeOut": round(max(0.0, fo), 4)}


def _set_bed_fades(item, s):
    meta = item.setdefault("metadata", {})
    if not isinstance(meta, dict):
        return
    if "fadeIn" in s:
        note = meta.setdefault("imageviewer", {})
        if isinstance(note, dict):
            v = _fade_num(s.get("fadeIn"))
            if v:
                note["afade_in"] = v
            else:
                note.pop("afade_in", None)
    if "fadeOut" in s:
        note = meta.setdefault("agentY", {})
        if isinstance(note, dict):
            note["fade_out"] = _fade_num(s.get("fadeOut"))


_FILM_EXTS = (".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi")
_STILL_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".gif", ".bmp", ".avif", ".exr")


def _xfadeable(c, v1):
    f = str(c.get("file") or "").lower()
    if c.get("loop") or f.endswith(_STILL_EXTS):
        return False
    return not (v1 and (not f.endswith(_FILM_EXTS) or c.get("mute")))


def audio_envs(edit):
    """Every clip's fades and crossfades as :func:`env_gain` reads them: ``{("V1", i) | (track id, i): env}``
    for the clips of *edit* (as :func:`editable` gives it). xfadeFrom / audioEnv in the JS."""
    def env_of(c):
        return {"len": float(c.get("length") or 0), "fi": float(c.get("fadeIn") or 0),
                "fo": float(c.get("fadeOut") or 0), "xin": None, "xout": None}
    out = {}
    clips = edit.get("clips") or []
    for i, c in enumerate(clips):
        out[("V1", i)] = env_of(c)
    for i, c in enumerate(clips):
        x = clean_xfade(c.get("xfade"))
        if not x or not i or float(c.get("gap") or 0) > 0 or float(c.get("transition") or 0) > 0 \
                or not _xfadeable(c, True) or not _xfadeable(clips[i - 1], True):
            continue
        b, a = xfade_sides(x)
        out[("V1", i)].update(xin={"b": b, "a": a, "curve": x["curve"]}, fi=0.0)
        out[("V1", i - 1)].update(xout={"b": b, "a": a, "curve": x["curve"]}, fo=0.0)
    for t in edit.get("tracks") or []:
        tc = t.get("clips") or []
        for i, c in enumerate(tc):
            out[(t.get("id"), i)] = env_of(c)
        if t.get("kind") != "audio":
            continue
        for i, c in enumerate(tc):
            x = clean_xfade(c.get("xfade"))
            if not x or not _xfadeable(c, False):
                continue
            at = float(c.get("at") or 0)
            j = next((n for n, o in enumerate(tc) if n != i
                      and abs(float(o.get("at") or 0) + float(o.get("length") or 0) - at) < 1e-3), -1)
            if j < 0 or not _xfadeable(tc[j], False):
                continue
            b, a = xfade_sides(x)
            out[(t.get("id"), i)].update(xin={"b": b, "a": a, "curve": x["curve"]}, fi=0.0)
            out[(t.get("id"), j)].update(xout={"b": b, "a": a, "curve": x["curve"]}, fo=0.0)
    return out


# Tracks for editing: a track LOCKED (nothing on it may be changed) and its AUTO TRACK SELECTOR
# (off: ripples, inserts, the blade at the playhead leave it alone) - Resolve's two header controls,
# the panel's (imageViewer_editTimelineData.js, trackFlags). ``metadata.imageviewer.lock`` /
# ``auto_select`` on a track (False only when off); texts: the stack's ``texts_lock`` / ``texts_auto``.
def track_flags(track):
    note = _imageviewer(track) if track else {}
    out = {"lock": bool(note.get("lock")), "auto": note.get("auto_select") is not False}
    # A sound track's effects (the ComfyUI Image Viewer's Fairlight-like FX), in metadata.imageviewer.afx.
    chain = _afx().clean_chain(note.get("afx"))
    if chain:
        out["afx"] = chain
    part = note.get("cpart")
    if isinstance(part, str) and _LINK.match(part):
        out["cpart"] = part                     # a track a compound clip's pieces were laid out on
    return out


def _set_flags(track, t):
    if track is None:
        return
    meta = track.setdefault("metadata", {})
    note = meta.setdefault("imageviewer", {}) if isinstance(meta, dict) else None
    if not isinstance(note, dict):
        return
    if "lock" in t:
        if t.get("lock"):
            note["lock"] = True
        else:
            note.pop("lock", None)
    if "auto" in t:
        if t.get("auto") is False:
            note["auto_select"] = False
        else:
            note.pop("auto_select", None)
    if "afx" in t:
        chain = _afx().clean_chain(t.get("afx"))
        if chain:
            note["afx"] = chain
        else:
            note.pop("afx", None)
    if "cpart" in t:
        part = t.get("cpart")
        if isinstance(part, str) and _LINK.match(part):
            note["cpart"] = part
        else:
            note.pop("cpart", None)


# A clip may carry takes: the same shot made again with changes, kept beside the
# first (``metadata.imageviewer.takes``). Exactly one is active, and the clip's media
# reference names its file, so OTIO stays what it was for any other program.
# imageViewer_editTimelineData.js (addTake / switchTake) is the same arithmetic.
MAX_TAKES = 50


def clean_takes(given):
    """*given* as a list of takes: ``{"file", "version", "created", "note", "active"}``
    (and, for an active take that made the clip shorter, ``"len"`` - the length it
    had). Anything that is not a take is left out; at most :data:`MAX_TAKES`;
    exactly one is active (the last, where none says so)."""
    if not isinstance(given, list):
        return []
    out = []
    for t in given:
        if not isinstance(t, dict) or not isinstance(t.get("file"), str) or not t["file"].strip():
            continue
        version = t.get("version")
        if isinstance(version, bool) or not isinstance(version, int):
            continue
        take = {"file": t["file"][:2000], "version": version,
                "created": str(t.get("created") or "")[:40] if isinstance(t.get("created") or "", str) else "",
                "note": str(t.get("note") or "")[:200] if isinstance(t.get("note") or "", str) else "",
                "active": t.get("active") is True}
        try:
            length = float(t.get("len") or 0)
        except (TypeError, ValueError):
            length = 0.0
        if length > 0 and length < 86400:
            take["len"] = round(length, 4)
        out.append(take)
        if len(out) >= MAX_TAKES:
            break
    seen = False
    for t in out:
        if t["active"] and seen:
            t["active"] = False
        seen = seen or t["active"]
    if out and not seen:
        out[-1]["active"] = True
    return out


def norm_path(path):
    """A path as two spellings of it compare: slashes forward, and no case."""
    return os.path.normcase(str(path or "").replace("\\", "/").rstrip("/")).replace("\\", "/")


def version_of(path):
    """The version a file's name says (``shot_03_v002.mp4`` -> 2); 1 where it says none."""
    stem = os.path.splitext(os.path.basename(str(path or "").replace("\\", "/")))[0]
    found = re.findall(r"(?:^|[^a-z0-9])v(\d{1,5})(?![0-9])", stem, re.I)
    return max(1, int(found[-1])) if found else 1


# A clip's speed (retime, "trim to fill": its source in and out kept, its length
# on the timeline the source it uses divided by the speed) and its loop (past
# one turn of ``span`` seconds of source the source again - "loop" - or back
# and forth - "pingpong"). Both in ``metadata.imageviewer``; the speed also as OTIO's
# own LinearTimeWarp, which other programs read. ``source_range`` stays what it
# is for every clip - its start in the source, its duration on the timeline -
# so a reader that knows neither plays the plain clip from its in point.
MIN_SPEED, MAX_SPEED = 0.1, 10.0
_WARP = "LinearTimeWarp"
_FREEZE = "FreezeFrame"
MOTIONS = ("", "reverse", "freeze")


def clip_time(item):
    """``{"speed", "loop", "span", "motion"}`` of a clip: 1 / "" / 0 / "" for a plain one.
    ``motion`` "reverse" (the source runs backwards from ``in``, the moment at the clip's
    head) or "freeze" (``in`` held): ``metadata.imageviewer.motion``, else read off OTIO's
    own effects - a FreezeFrame, or a LinearTimeWarp of 0 (freeze) or below 0 (reverse)."""
    note = _imageviewer(item)
    speed = note.get("speed")
    motion = str(note.get("motion") or "")
    warp = None
    for fx in item.get("effects") or [] if isinstance(item, dict) else []:
        if isinstance(fx, dict) and (str(fx.get("OTIO_SCHEMA") or "").startswith((_WARP, _FREEZE))
                                     or fx.get("effect_name") == _FREEZE):
            warp = fx
            break
    if warp is not None and "motion" not in note:
        try:
            ts = float(warp.get("time_scalar") if warp.get("time_scalar") is not None else 1.0)
        except (TypeError, ValueError):
            ts = 1.0
        if str(warp.get("OTIO_SCHEMA") or "").startswith(_FREEZE) or warp.get("effect_name") == _FREEZE or ts == 0:
            motion = "freeze"
        elif ts < 0:
            motion = "reverse"
    if speed is None and warp is not None:
        speed = warp.get("time_scalar")
    try:
        speed = abs(float(speed if speed is not None else 1.0))
    except (TypeError, ValueError):
        speed = 1.0
    if not speed > 0 or motion == "freeze":
        speed = 1.0
    speed = round(max(MIN_SPEED, min(MAX_SPEED, speed)), 4)
    loop = str(note.get("loop") or "")
    try:
        span = float(note.get("span") or 0)
    except (TypeError, ValueError):
        span = 0.0
    if motion not in MOTIONS:
        motion = ""
    if loop not in ("loop", "pingpong") or not span > 0 or motion:
        loop, span = "", 0.0
    return {"speed": speed, "loop": loop, "span": round(span, 4), "motion": motion}


def _set_time(item, c):
    """Write a clip's speed and loop, where the edit states them, into *item*."""
    meta = item.setdefault("metadata", {})
    note = meta.setdefault("imageviewer", {}) if isinstance(meta, dict) else None
    if not isinstance(note, dict):
        return
    if "speed" in c or "motion" in c:
        was = clip_time(item)
        motion = str(c.get("motion") or "") if "motion" in c else was["motion"]
        if motion not in MOTIONS:
            raise ValueError(f"a clip's motion is one of reverse, freeze or nothing, not {motion!r}")
        if "speed" in c:
            speed = _num(c.get("speed") or 1.0, "a clip's speed", MIN_SPEED)
            speed = round(min(MAX_SPEED, speed), 4)
        else:
            speed = was["speed"]
        if motion == "freeze":
            speed = 1.0
        effects = [fx for fx in (item.get("effects") or [])
                   if not (isinstance(fx, dict) and (str(fx.get("OTIO_SCHEMA") or "").startswith((_WARP, _FREEZE))
                                                     or fx.get("effect_name") == _FREEZE))]
        if abs(speed - 1.0) > 1e-4:
            note["speed"] = speed
        else:
            note.pop("speed", None)
        if motion:
            note["motion"] = motion
            note.pop("loop", None)
            note.pop("span", None)
        else:
            note.pop("motion", None)
        # OTIO's own effects, which other programs read: a FreezeFrame, or the speed as a
        # LinearTimeWarp (negative reversed). ``source_range`` starts at the moment at the
        # clip's head either way, so a reader that knows none of it plays forwards from there.
        if motion == "freeze":
            effects.append({"OTIO_SCHEMA": "FreezeFrame.1", "name": "", "effect_name": _FREEZE,
                            "metadata": {}, "time_scalar": 0.0})
        elif motion == "reverse" or abs(speed - 1.0) > 1e-4:
            effects.append({"OTIO_SCHEMA": "LinearTimeWarp.1", "name": "", "effect_name": _WARP,
                            "metadata": {}, "time_scalar": -speed if motion == "reverse" else speed})
        item["effects"] = effects
    if "loop" in c and not note.get("motion"):
        loop = str(c.get("loop") or "")
        span = _num(c.get("span") or 0, "a clip's loop") if loop else 0.0
        if loop in ("loop", "pingpong") and span > 0:
            note["loop"], note["span"] = loop, round(span, 4)
        else:
            note.pop("loop", None)
            note.pop("span", None)


# How a text is drawn where its timeline does not say: centred, in the lower
# part of the picture, a sixteenth of its height, white.
TEXT_LOOK = {"size": 6.0, "x": 0.5, "y": 0.85, "color": "#ffffff"}


def text_look(mark):
    """A text's look: ``{"size", "x", "y", "color"}``. ``size`` is a percentage
    of the picture's height, ``x`` / ``y`` where its middle is (0..1)."""
    note = _imageviewer(mark)
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


# A TITLE is a clip whose picture is words: on a video track, with no file - a
# GeneratorReference of kind ``imageviewer.title`` - and its words and look in
# ``metadata.imageviewer.title`` (title_render.TITLE_NUM ..., the Edit panel's
# imageViewer_editTitles.js). Every other program reads a generator clip of that
# length. The texts of older cuts (markers on the stack) come in as titles
# (:func:`texts_to_titles`), and are written as title clips at the next save.
TITLE_KIND = "imageviewer.title"


def title_of(item):
    """The title a clip is (its words and look, every part present), or None for a clip that is not one."""
    from .title_render import clean_title
    note = _imageviewer(item)
    ref = item.get("media_reference") if isinstance(item, dict) else None
    generator = isinstance(ref, dict) and str(ref.get("OTIO_SCHEMA") or "").startswith("GeneratorReference") \
        and str(ref.get("generator_kind") or "") == TITLE_KIND
    if isinstance(note.get("title"), dict) or generator:
        return clean_title(note.get("title") if isinstance(note.get("title"), dict) else {})
    return None


def _new_title(c, what, marks):
    """A title clip of its own, made in the panel - or from the marker it came from (``mark``), whose metadata it keeps."""
    import copy
    from .title_render import clean_title
    title = clean_title(c.get("title"))
    meta = {}
    mark = c.get("mark")
    if isinstance(mark, int) and not isinstance(mark, bool):
        if not 0 <= mark < len(marks) or not isinstance(marks[mark], dict):
            raise ValueError(f"{what} does not name a text of this timeline")
        meta = copy.deepcopy(marks[mark].get("metadata")) if isinstance(marks[mark].get("metadata"), dict) else {}
        meta.pop("imageviewer", None)                   # the text's look: the title's own now
    note = meta.setdefault("agentY", {})
    if isinstance(note, dict):
        note.setdefault("kind", "text")
        note["text"] = title["text"]
    meta["made_by"] = "ComfyUI Image Viewer"
    return {"OTIO_SCHEMA": "Clip.1", "name": "", "metadata": meta, "enabled": True,
            "effects": [], "markers": [], "source_range": None,
            "media_reference": {"OTIO_SCHEMA": "GeneratorReference.1", "name": "title", "metadata": {},
                                "available_range": None, "generator_kind": TITLE_KIND, "parameters": {}}}


def _set_title(item, c):
    """Write a title's words and look, where the edit states them, into *item* (and its words where agentY reads them)."""
    if not isinstance(c.get("title"), dict):
        return
    from .title_render import clean_title
    title = clean_title(c["title"])
    meta = item.setdefault("metadata", {})
    if not isinstance(meta, dict):
        return
    note = meta.setdefault("imageviewer", {})
    if isinstance(note, dict):
        note["title"] = title
    about = meta.setdefault("agentY", {})
    if isinstance(about, dict):
        about.setdefault("kind", "text")
        about["text"] = title["text"]
    if not str(item.get("name") or "").strip():
        item["name"] = next((x for x in title["text"].split("\n") if x.strip()), "Title")[:200]


def texts_to_titles(edit):
    """*edit* (:func:`editable`) with its texts as title clips - imageViewer_editTimelineData.textsToTitles, the
    same rule: each looks as the text did, on video tracks of their own above the others (as many as texts
    overlap), ``mark`` naming the marker it came from; the texts' switch is those tracks' switch."""
    from .title_render import title_from_text
    texts = edit.get("texts") or []
    if not texts:
        return edit
    taken = {t["id"] for t in edit["tracks"]}
    made = []
    for n, t in sorted(enumerate(texts), key=lambda p: (float(p[1].get("start") or 0), p[0])):
        start = round(max(0.0, float(t.get("start") or 0)), 4)
        length = round(max(0.2, float(t.get("length") or 0)), 4)
        track = next((m for m in made if m["end"] <= start + 1e-6), None)
        if track is None:
            k = 2
            while f"V{k}" in taken:
                k += 1
            taken.add(f"V{k}")
            track = {"end": 0.0, "track": {"id": f"V{k}", "kind": "video", "name": f"V{k}",
                                           "off": bool((edit.get("off") or {}).get("T")), "clips": []}}
            made.append(track)
            edit["tracks"].append(track["track"])
        title = title_from_text(t)
        clip = {"name": next((x for x in title["text"].split("\n") if x.strip()), "Title")[:200], "file": "",
                "in": 0.0, "length": length, "at": start, "color": "", "volume": 1.0, "fx": {},
                "speed": 1.0, "loop": "", "span": 0.0, "title": title}
        if isinstance(t.get("ref"), int):
            clip["mark"] = t["ref"]
        track["track"]["clips"].append(clip)
        track["end"] = start + length
    edit["texts"] = []
    if isinstance(edit.get("off"), dict):
        edit["off"]["T"] = False
    return edit


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
                clip = {"ref": [ti, ci], "name": str(child.get("name") or ""),
                        "file": _file(child.get("media_reference")), "in": round(start, 4),
                        "length": round(length, 4), "at": round(at, 4), **_look(child)}
                title = title_of(child) if kind == "video" else None
                if title is not None:
                    clip.update(title=title, file="", **{"in": 0.0})
                clips.append(clip)
            at += length
        out.append({"id": tid, "kind": kind, "name": str(track.get("name") or tid), "off": _is_off(track),
                    **track_flags(track), "clips": clips})
    return out


def editable(doc):
    """An OTIO timeline as the Edit panel works on it.

    ``{"name", "fps", "clips": [{"ref", "name", "file", "in", "length",
    "transition", "color", "volume"}], "texts": [{"ref", "text", "start",
    "length", "preset"}], "sound": [{"name", "file"}], "tracks": [...],
    "off": {"V1", "A1"}, "edited"}``. ``ref`` is the item's place in the
    file it came from, so saving can keep everything about it that the panel
    does not show. Clips are at their full length; ``transition`` is the dissolve
    from the clip before; ``gap`` (where there is one) the empty time before the
    clip - OTIO Gaps on V1, kept, with no dissolve into or out of one. ``tracks`` are the tracks beyond the first of each
    kind (:func:`extra_tracks`): clips placed at a moment of the film, the
    picture of a higher track covering what is under it.
    """
    if not isinstance(doc, dict) or not str(doc.get("OTIO_SCHEMA") or "").startswith("Timeline"):
        raise ValueError("not an OpenTimelineIO timeline")
    meta = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
    stamp = meta.get("imageviewer") if isinstance(meta.get("imageviewer"), dict) else {}
    out = {"name": str(doc.get("name") or ""), "fps": _rate(doc) or 24.0, "clips": [], "texts": [],
           "sound": [], "edited": str(stamp.get("edited") or "")}
    video = _track_of(doc, "video")
    pending = None                      # the dissolve waiting for the clip after it
    gap = 0.0                           # the empty time (OTIO Gaps) waiting for the clip after it
    for ref, child in enumerate((video or {}).get("children") or []):
        if not isinstance(child, dict):
            continue
        schema = str(child.get("OTIO_SCHEMA") or "")
        if schema.startswith("Transition"):
            # A dissolve out of a gap (a fade from black) is not one the panel
            # makes: it is left out, and the clip after it keeps its own range.
            if gap > 0 or not out["clips"]:
                pending = None
                continue
            before = _seconds(child.get("in_offset") or {})
            after = _seconds(child.get("out_offset") or {})
            out["clips"][-1]["length"] = round(out["clips"][-1]["length"] + after, 4)
            pending = (before, after, clean_tfx(_imageviewer(child).get("transition")))
            continue
        if schema.startswith("Gap"):
            _start, length = _span(child.get("source_range"))
            if pending and out["clips"]:
                # A dissolve into this gap (a fade to black) is left out too: the
                # clip before it ends where its own range does.
                out["clips"][-1]["length"] = round(out["clips"][-1]["length"] - pending[1], 4)
            pending = None
            gap += max(0.0, length)
            continue
        if not schema.startswith("Clip"):
            pending = None
            continue                    # anything else on the track has nothing to cut
        start, length = _span(child.get("source_range"))
        clip = {"ref": ref, "name": str(child.get("name") or ""),
                "file": _file(child.get("media_reference")), "in": start, "length": length,
                "transition": 0.0, **_look(child)}
        if gap > 0:
            # Empty time before this clip on V1: black, or what a higher track shows there.
            clip["gap"] = round(gap, 4)
            gap = 0.0
        if pending:
            before, after, tfx = pending
            clip["in"] = max(0.0, start - before * _step(clip))
            clip["length"] = length + before
            clip["transition"] = round(before + after, 4)
            if tfx:
                clip["tfx"] = tfx
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
                                 "file": _file(child.get("media_reference")), **bed_fades(child)})
    out["tracks"] = extra_tracks(doc)
    out["off"] = {"V1": _is_off(video), "A1": _is_off(audio),
                  "T": bool(_imageviewer(stack).get("texts_off")),
                  "master": bool(_imageviewer(stack).get("master_off"))}
    flags = {"V1": track_flags(video), "A1": track_flags(audio),
             "T": {"lock": bool(_imageviewer(stack).get("texts_lock")), "auto": _imageviewer(stack).get("texts_auto") is not False}}
    out["lock"] = {k: v["lock"] for k, v in flags.items()}
    out["auto"] = {k: v["auto"] for k, v in flags.items()}
    out["afx"] = {"A1": flags["A1"].get("afx") or [],
                  # The Mixer's master (its fader and pan, and any effect on the whole mix), on the stack.
                  "master": _afx().clean_chain(_imageviewer(stack).get("master_afx"))}
    out["markers"] = read_markers(video)
    compounds = compounds_of(_imageviewer(doc))
    if compounds:
        out["compounds"] = compounds
    # The texts (markers) as title clips: the panel, the render and the Resolve export all work on those.
    return texts_to_titles(out)


def _set_master(doc, values):
    """The Mixer's master (``master_off``, ``master_afx``) in the stack's metadata.imageviewer; a value
    at rest (False, an empty chain) is taken out, so a cut that never used it stays as it was."""
    stack = doc.get("tracks")
    if not isinstance(stack, dict):
        return
    meta = stack.setdefault("metadata", {})
    if not isinstance(meta, dict):
        return
    note = meta.setdefault("imageviewer", {})
    if not isinstance(note, dict):
        return
    for key, value in values.items():
        if value:
            note[key] = value
        else:
            note.pop(key, None)
    if not note:
        meta.pop("imageviewer", None)


def edit_length(edit):
    """How long the film of *edit* is: the clips and the gaps before them, less what the dissolves take -
    or as far as the last clip on a higher video track, or the last sound of a live sound track, reaches,
    if that is later (the film is black past its last picture). The same as filmLength in the JS."""
    clips = edit.get("clips") or []
    total = sum(float(c.get("length") or 0) + float(c.get("gap") or 0) for c in clips)
    main = max(0.0, total - sum(float(c.get("transition") or 0) for c in clips[1:]))
    over = []
    for t in edit.get("tracks") or []:
        if not isinstance(t, dict):
            continue
        sound = t.get("kind") == "audio"
        if sound and t.get("off"):
            continue                        # a switched-off sound track is not heard
        for c in t.get("clips") or []:
            if not isinstance(c, dict) or (sound and (c.get("disabled") or c.get("title") is not None)):
                continue
            over.append(float(c.get("at") or 0) + float(c.get("length") or 0))
    return max([main] + over)


def _set_takes(item, given, may_use):
    """Write a clip's takes, where the edit states them, into *item*; the active
    take's file becomes the media the clip points at."""
    takes = clean_takes(given)
    meta = item.setdefault("metadata", {})
    note = meta.setdefault("imageviewer", {}) if isinstance(meta, dict) else None
    if not isinstance(note, dict):
        return
    if not takes:
        note.pop("takes", None)
        return
    note["takes"] = takes
    active = next((t for t in takes if t["active"]), None)
    ref = item.get("media_reference")
    if active is None or not isinstance(ref, dict):
        return
    if norm_path(_file(ref)) == norm_path(active["file"]):
        return
    path = os.path.abspath(active["file"].strip())
    if may_use is None or not may_use(path):
        raise ValueError(f"take v{active['version']}: {os.path.basename(path)} is not a file the viewer may use")
    if not os.path.isfile(path):
        raise ValueError(f"take v{active['version']}: {os.path.basename(path)} does not exist")
    ref["target_url"] = _url(path)
    ref["available_range"] = None          # it described the media that was there


def _dress(item, c, may_use=None, rate=None):
    """Write a clip's colour and volume, where the edit states them, into *item*."""
    if "color" in c:
        color = str(c.get("color") or "")
        meta = item.setdefault("metadata", {})
        if isinstance(meta, dict):
            note = meta.setdefault("imageviewer", {})
            if isinstance(note, dict):
                if _COLOR.match(color):
                    note["color"] = color.lower()
                else:
                    note.pop("color", None)
    if "fx" in c:
        meta = item.setdefault("metadata", {})
        if isinstance(meta, dict):
            note = meta.setdefault("imageviewer", {})
            if isinstance(note, dict):
                fx = clean_fx(c.get("fx"))
                if fx:
                    note["fx"] = fx
                else:
                    note.pop("fx", None)
    _set_time(item, c)
    _set_link(item, c)
    _set_audio(item, c)
    if "markers" in c:
        _write_markers(item, c.get("markers"), rate or _rate(item) or 24.0, clip=True, speed=clip_time(item)["speed"])
    if "takes" in c:
        _set_takes(item, c.get("takes"), may_use)
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
        note = meta.setdefault("imageviewer", {})
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
            if ref is None and isinstance(c.get("title"), dict) and kind == "video":
                item = _new_title(c, what, list(((doc.get("tracks") or {}).get("markers")) or []))
            elif ref is None and str(c.get("file") or "").strip():
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
            _dress(item, c, may_use, rate)
            if kind == "video":
                _set_title(item, c)
            if title_of(item) is not None:
                start = 0.0                                    # a title has no source
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
        _set_flags(track, t)
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
    return {"OTIO_SCHEMA": "Timeline.1", "name": str(name or "cut"), "metadata": {"made_by": "ComfyUI Image Viewer"},
            "global_start_time": None,
            "tracks": {"OTIO_SCHEMA": "Stack.1", "name": "tracks", "metadata": {}, "source_range": None,
                       "effects": [], "markers": [],
                       "children": [{"OTIO_SCHEMA": "Track.1", "name": "V1", "kind": "Video",
                                     "metadata": {"imageviewer": {"fps": float(fps or 24.0)}},
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
    hint = ((video.get("metadata") or {}).get("imageviewer") or {}) if isinstance(video.get("metadata"), dict) else {}
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
        gap = _num(c.get("gap") or 0, f"the gap before clip {i}")
        # No dissolve into a gap: a clip after empty time comes in with a cut.
        mix = _num(c.get("transition") or 0, f"clip {i}'s dissolve") if i > 1 and not gap > 0 else 0.0
        parsed.append((ref, start, length, mix, str(c.get("name")) if c.get("name") is not None else None, c, gap))
    for i, (_ref, _s, length, mix, _n, _c, _g) in enumerate(parsed):
        if mix and (mix >= length or mix >= parsed[i - 1][2]):
            raise ValueError(f"the dissolve into clip {i + 1} is as long as one of the clips it joins")
    def halves(seconds):
        # In whole frames, and adding up: two rounded halves of a 25-frame
        # dissolve are 24 frames, and the film would come back a frame short.
        frames = round(float(seconds or 0.0) * rate)
        first = frames // 2
        return first / rate, (frames - first) / rate

    children = []
    for i, (ref, start, length, mix, name, given, gap) in enumerate(parsed):
        head, before = halves(mix if i else 0.0)
        tail = halves(parsed[i + 1][3])[1] if i + 1 < len(parsed) else 0.0
        frames = round(gap * rate)
        if frames > 0:
            # Empty time on V1, as OTIO says it: a Gap (Resolve reads it as one).
            children.append({"OTIO_SCHEMA": "Gap.1", "name": "", "metadata": {}, "effects": [], "markers": [],
                             "source_range": _range(0.0, frames / rate, rate)})
        if head or before:
            tfx = clean_tfx(given.get("tfx")) if isinstance(given, dict) else None
            children.append({"OTIO_SCHEMA": "Transition.1",
                             "name": {"dip": "Dip to Color", "wipe": "Wipe"}.get((tfx or {}).get("type"), ""),
                             "metadata": {"imageviewer": {"transition": tfx}} if tfx else {},
                             "transition_type": "SMPTE_Dissolve",
                             "in_offset": _rt(head, rate), "out_offset": _rt(before, rate)})
        item = copy.deepcopy(ref if isinstance(ref, dict) else source[ref])
        _dress(item, given, may_use, rate)
        item["source_range"] = _range(max(0.0, start + head * _step(clip_time(item))), length - head - tail, rate)
        if name is not None:
            item["name"] = name[:200]
        children.append(item)
    video["children"] = children
    audio = _track_of(new, "audio")
    # The bed's clips deleted in the panel go from the file; the rest are kept whole.
    if isinstance(edit.get("sound"), list) and audio is not None:
        left = {str(s.get("file") or "") for s in edit["sound"] if isinstance(s, dict)}
        audio["children"] = [c for c in (audio.get("children") or [])
                             if not (isinstance(c, dict) and str(c.get("OTIO_SCHEMA") or "").startswith("Clip"))
                             or _file(c.get("media_reference")) in left]
        fades = {str(s.get("file") or ""): s for s in edit["sound"] if isinstance(s, dict)}
        for c in audio["children"]:
            if isinstance(c, dict) and str(c.get("OTIO_SCHEMA") or "").startswith("Clip"):
                _set_bed_fades(c, fades.get(_file(c.get("media_reference"))) or {})
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
                note = stack_meta.setdefault("imageviewer", {})
                if isinstance(note, dict):
                    note["texts_off"] = bool(off["T"])
        if "master" in off:
            _set_master(new, {"master_off": bool(off["master"])})
    afx = edit.get("afx")
    if isinstance(afx, dict) and "A1" in afx and audio is not None:
        _set_flags(audio, {"afx": afx.get("A1")})
    if isinstance(afx, dict) and "master" in afx:
        _set_master(new, {"master_afx": _afx().clean_chain(afx.get("master"))})
    for flag in ("lock", "auto"):
        given = edit.get(flag)
        if not isinstance(given, dict):
            continue
        for tid, track in (("V1", video), ("A1", audio)):
            if tid in given and track is not None:
                _set_flags(track, {flag: given[tid]})
        if "T" in given:
            stack_meta = (new.get("tracks") or {}).setdefault("metadata", {})
            note = stack_meta.setdefault("imageviewer", {}) if isinstance(stack_meta, dict) else None
            if isinstance(note, dict):
                key = "texts_lock" if flag == "lock" else "texts_auto"
                on = bool(given["T"])
                if flag == "lock" and on:
                    note[key] = True
                elif flag == "auto" and not on:
                    note[key] = False
                else:
                    note.pop(key, None)
    film = edit_length({"clips": [{"length": p[2], "transition": p[3], "gap": p[6]} for p in parsed],
                        "tracks": extra_tracks(new)})

    if "markers" in edit:
        _write_markers(video, edit.get("markers"), rate)
    stack = new.get("tracks") or {}
    old_marks = list(((doc.get("tracks") or {}).get("markers")) or [])
    marks = []
    for i, t in enumerate(edit.get("texts") or [], 1):
        ref = t.get("ref") if isinstance(t, dict) else None
        if ref is None and isinstance(t, dict):
            # A text written in the panel: a marker of its own, said the way agentY says its texts.
            mark = {"OTIO_SCHEMA": "Marker.2", "name": "", "color": "PURPLE", "marked_range": None,
                    "metadata": {"agentY": {"text": ""}, "made_by": "ComfyUI Image Viewer"}}
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
                note = meta.setdefault("imageviewer", {})
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
        meta["imageviewer"] = {"edited": str(stamp or ""),
                         "note": "cut changed in the ComfyUI Image Viewer; the film beside this file "
                                 "has not been rendered again"}
        kept = compounds_of({"compounds": edit.get("compounds")}) if "compounds" in edit else \
            compounds_of((_imageviewer(doc) or {}))
        if kept:
            meta["imageviewer"]["compounds"] = kept
    return new


# Compound clips (imageViewer_editTimelineData.js, "compound clips"): saved FLAT - their pieces
# are ordinary clips (each with ``metadata.imageviewer.cpart = {"id"}``, on V1 or on tracks
# marked ``cpart``), so the render, the Resolve export and agentY see real clips - and each
# compound's definition (its inner cut, where it lies, its in and length) is kept here, in the
# timeline's ``metadata.imageviewer.compounds``, for the panel to fold the pieces back. The
# definition is the page's own JSON: kept as it is, only its ids and size are checked.
_MAX_COMPOUNDS_BYTES = 4 * 1024 * 1024


def compounds_of(note):
    given = note.get("compounds") if isinstance(note, dict) else None
    if not isinstance(given, dict):
        return {}
    out = {}
    for cid, d in list(given.items())[:200]:
        if isinstance(cid, str) and _LINK.match(cid) and isinstance(d, dict) and isinstance(d.get("cut"), dict):
            out[cid] = d
    try:
        if len(json.dumps(out)) > _MAX_COMPOUNDS_BYTES:
            raise ValueError("the compound clips are too large to keep")
    except TypeError:
        return {}
    return out


def _load(path):
    if os.path.getsize(path) > _MAX_BYTES:
        raise ValueError("the timeline file is too large")
    with open(path, "r", encoding="utf-8") as fh:
        try:
            return _renamed_otio(json.load(fh))
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
    _write_doc(path, new)
    return editable(new)


def _write_doc(path, doc):
    """*doc* into *path*, whole or not at all: beside it first, then moved over."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(doc, fh, indent=2)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


_NOT_IN_A_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_NAME = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)$", re.I)


def cut_file_name(name):
    """A file name for a cut from what was typed: no folder in it, always ``.otio``."""
    text = _NOT_IN_A_NAME.sub("_", str(name or "")).strip()
    if text.lower().endswith(".otio"):
        text = text[:-5]
    text = text.strip(" .")[:120].strip(" .")
    if not text.strip("_") or _RESERVED_NAME.match(text):
        text = ("cut_" + text) if text.strip("_") else "cut"
    return text + ".otio"


def save_as(path, source, edit, stamp="", may_use=None):
    """*edit* into a new file at *path*, on the timeline of *source* (None: a new
    one), so that what the panel does not show comes along. *source* is left as it is."""
    stem = os.path.splitext(os.path.basename(path))[0]
    doc = _load(source) if source else new_doc(stem)
    new = rebuild(doc, edit, stamp, may_use)
    new["name"] = stem
    _write_doc(path, new)
    return editable(new)


def _every_clip(doc):
    """Every clip of every track of *doc*, with a media reference of its own."""
    for _i, track in _tracks(doc):
        for child in track.get("children") or []:
            if isinstance(child, dict) and str(child.get("OTIO_SCHEMA") or "").startswith("Clip") \
                    and isinstance(child.get("media_reference"), dict):
                yield child


def add_take(doc, from_file, file, version=0, note="", created="", retime=False, duration=None):
    """*doc* with a new take of every clip whose media is *from_file*; returns
    ``(new document, how many clips took it)``.

    The new take becomes the clip's media and its active take; the clip keeps its
    in point, place, effects and speed. A clip with no takes yet first gets its
    old file as the take "original". *duration* (seconds, the new file's length)
    lets a source that is shorter than the clip used shorten the clip - or, with
    *retime*, slow it down to fill its length; without it nothing is clamped
    here, and the panel does it when it takes the take in. A clip that already
    has this file as a take just makes it the active one.
    """
    import copy
    new = copy.deepcopy(doc)
    want = norm_path(from_file)
    file = str(file or "").strip()
    if not want or not file:
        return new, 0
    applied = 0
    for item in _every_clip(new):
        if norm_path(_file(item["media_reference"])) != want:
            continue
        meta = item.setdefault("metadata", {})
        if not isinstance(meta, dict):
            continue
        bep = meta.setdefault("imageviewer", {})
        if not isinstance(bep, dict):
            continue
        takes = [dict(t, active=False) for t in clean_takes(bep.get("takes"))]
        if not takes:
            takes = [{"file": _file(item["media_reference"]), "version": version_of(_file(item["media_reference"])),
                      "created": "", "note": "original", "active": False}]
        mine = next((t for t in takes if norm_path(t["file"]) == norm_path(file)), None)
        if mine is None:
            top = max([t["version"] for t in takes] + [0])
            number = version if isinstance(version, int) and not isinstance(version, bool) and version > 0 else 0
            if not number or any(t["version"] == number for t in takes):
                number = top + 1
            mine = {"file": file, "version": number, "created": str(created or "")[:40],
                    "note": str(note or "")[:200], "active": False}
            takes = (takes + [mine])[-MAX_TAKES:]
        for t in takes:
            t["active"] = t is mine
        mine.pop("len", None)
        item["media_reference"]["target_url"] = _url(os.path.abspath(file))
        item["media_reference"]["available_range"] = None
        was = _fit_source(item, duration, retime)
        if was:
            mine["len"] = was
        bep["takes"] = takes
        applied += 1
    return new, applied


def _fit_source(item, duration, retime):
    """A clip whose media just changed, made to fit it (see :func:`add_take`);
    returns the length it had when it was shortened, else 0."""
    try:
        known = float(duration or 0)
    except (TypeError, ValueError):
        return 0.0
    rng = item.get("source_range")
    if not known > 0 or not isinstance(rng, dict):
        return 0.0
    start, length = _span(rng)
    rate = float(((rng.get("duration") or {}).get("rate")) or 24.0)
    info = clip_time(item)
    speed = info["speed"]
    used = info["span"] if info["loop"] else length * speed
    if start + used <= known + 1e-3:
        return 0.0
    if known - start < _MIN_CLIP * speed:
        start = max(0.0, known - _MIN_CLIP * speed)
    usable = known - start
    if info["loop"]:
        _set_time(item, {"loop": info["loop"], "span": min(info["span"], usable)})
        item["source_range"] = _range(start, length, rate)
        return 0.0
    if retime:
        fit = max(MIN_SPEED, min(MAX_SPEED, usable / length))
        _set_time(item, {"speed": fit})
        item["source_range"] = _range(start, min(length, usable / fit), rate)
        return 0.0
    shorter = max(_MIN_CLIP, usable / speed)
    item["source_range"] = _range(start, shorter, rate)
    return round(length, 4) if shorter < length - 1e-4 else 0.0


# ── a cut changed by someone other than the panel: agentY's edit_cut ─────────
#
# The ops work on the cut as the panel holds it (:func:`editable`) and the
# result is saved the way the panel saves (:func:`save`, through :func:`rebuild`),
# so the file, Resolve and the panel read it as a cut made by hand. Tracks are
# named as the panel shows them: V1 (the cut), A1 (the bed under the whole film),
# V2.. / A2.. (clips placed at a moment of the film). Clips are counted from 1 on
# their track, in the order they play.

MAX_OPS = 50
_SOUND_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".aif", ".aiff", ".opus"}
_TRACK_NAME = re.compile(r"^[AV][2-9]\d*$|^[AV][1-9]\d+$")


def _media_kind(path):
    return "audio" if os.path.splitext(str(path or ""))[1].lower() in _SOUND_EXTS else "video"


def v1_times(edit):
    """Where each V1 clip begins in the film (seconds): gaps add, dissolves overlap."""
    out, at = [], 0.0
    for i, c in enumerate(edit.get("clips") or []):
        at += float(c.get("gap") or 0)
        if i:
            at -= float(c.get("transition") or 0)
        out.append(round(max(0.0, at), 4))
        at += float(c.get("length") or 0)
    return out


def _next_track(edit, kind):
    """A new, empty extra track of *kind*, put into *edit*; returns it."""
    letter = "A" if kind == "audio" else "V"
    tracks = edit.setdefault("tracks", [])
    have = [t for t in tracks if isinstance(t, dict) and t.get("kind") == kind]
    tid = f"{letter}{len(have) + 2}"
    track = {"id": tid, "kind": kind, "name": tid, "off": False, "clips": []}
    if kind == "video":
        # Picture tracks come before sound tracks, in the panel and in the file.
        last = max([i for i, t in enumerate(tracks) if isinstance(t, dict) and t.get("kind") == "video"], default=-1)
        tracks.insert(last + 1, track)
    else:
        tracks.append(track)
    return track


def _find_track(edit, tid):
    for t in edit.get("tracks") or []:
        if isinstance(t, dict) and str(t.get("id") or "").upper() == tid:
            return t
    return None


def _clashes(track, at, length, skip=None):
    """The clip of *track* that shares a moment with ``at .. at + length``, or None."""
    for c in track.get("clips") or []:
        if c is skip:
            continue
        a = float(c.get("at") or 0)
        b = a + float(c.get("length") or 0)
        if at < b - 1e-4 and at + length > a + 1e-4:
            return c
    return None


def _locked(edit, tid):
    """Is track *tid* of *edit* locked in the panel (nothing on it may be changed)?"""
    if tid in ("V1", "A1", "T"):
        return bool((edit.get("lock") or {}).get(tid))
    track = _find_track(edit, tid)
    return bool(track and track.get("lock"))


def _label(clip):
    return str(clip.get("name") or os.path.basename(str(clip.get("file") or "")))


def _op_add(new, op, what, durations):
    file = str(op.get("file") or "").strip()
    if not file:
        raise ValueError(f"{what}: no 'file'")
    kind = _media_kind(file)
    tid = str(op.get("track") or "").strip().upper()
    if tid in ("V1", "A1"):
        why = "V1 is the cut itself" if tid == "V1" else "A1 is the bed under the whole film"
        raise ValueError(f"{what}: {tid} takes no clip placed at a time ({why}) - use track "
                         f"{'A2' if kind == 'audio' else 'V2'}, or leave 'track' empty")
    at = _num(op.get("at") or 0, f"{what}: 'at'")
    start = _num(op.get("in") or 0, f"{what}: 'in'")
    if op.get("length") is not None:
        length = _num(op.get("length"), f"{what}: 'length'", _MIN_CLIP)
    else:
        known = float(durations.get(norm_path(file)) or 0.0)
        if not known > start + _MIN_CLIP:
            raise ValueError(f"{what}: how long {os.path.basename(file)} is, is not known - give 'length'")
        length = known - start
    if tid not in ("", "AUTO", "NEW") and _locked(new, tid):
        raise ValueError(f"{what}: track {tid} is locked in the Edit panel - unlock it there, or use another track")
    if tid in ("", "AUTO"):
        track = next((t for t in new["tracks"] if isinstance(t, dict) and t.get("kind") == kind
                      and not t.get("lock") and not _clashes(t, at, length)), None) or _next_track(new, kind)
    elif tid == "NEW":
        track = _next_track(new, kind)
    else:
        if not _TRACK_NAME.match(tid):
            raise ValueError(f"{what}: '{op.get('track')}' is not a track name (A2, V2 ...)")
        track = _find_track(new, tid)
        want = "audio" if tid[0] == "A" else "video"
        while track is None:                       # A4 asked for with only A2 there: A3 and A4 are made
            made = _next_track(new, want)
            if made["id"] == tid:
                track = made
            elif int(made["id"][1:]) >= int(tid[1:]):
                raise ValueError(f"{what}: track {tid} could not be made")
        if (track.get("kind") == "audio") != (kind == "audio"):
            raise ValueError(f"{what}: {os.path.basename(file)} is {'sound' if kind == 'audio' else 'picture'}, "
                             f"and {track['id']} is a {'sound' if track.get('kind') == 'audio' else 'picture'} track")
        hit = _clashes(track, at, length)
        if hit is not None:
            raise ValueError(f"{what}: {track['id']} has {_label(hit)} at {hit.get('at')}s for {hit.get('length')}s "
                             "there - pick another track, or leave 'track' empty for one with room")
    clip = {"file": file, "name": str(op.get("name") or os.path.splitext(os.path.basename(file))[0])[:200],
            "in": round(start, 4), "length": round(length, 4), "at": round(at, 4)}
    if op.get("volume") is not None:
        clip["volume"] = round(min(4.0, _num(op.get("volume"), f"{what}: 'volume'")), 4)
    track["clips"] = sorted((track.get("clips") or []) + [clip], key=lambda c: float(c.get("at") or 0))
    return f"added {clip['name']} on {track['id']} at {clip['at']}s for {clip['length']}s"


def _op_edit(new, op, what, kind_of_op):
    tid = str(op.get("track") or "").strip().upper()
    try:
        number = int(op.get("clip"))
    except (TypeError, ValueError):
        raise ValueError(f"{what}: 'clip' is the clip's number on its track (1, 2 ...)") from None
    track = None
    if _locked(new, tid):
        raise ValueError(f"{what}: track {tid} is locked in the Edit panel - nothing on it can be changed")
    if tid == "V1":
        row = new.get("clips") or []
    elif tid == "A1":
        row = new.get("sound") or []
    else:
        track = _find_track(new, tid)
        if track is None:
            raise ValueError(f"{what}: there is no track {tid or '(none named)'}")
        row = track.get("clips") or []
    if not 1 <= number <= len(row):
        raise ValueError(f"{what}: {tid} has {len(row)} clip(s), no clip {number}")
    clip = row[number - 1]
    label = _label(clip)
    if kind_of_op == "remove":
        if tid == "V1" and len(row) == 1:
            raise ValueError(f"{what}: a cut needs at least one clip on V1")
        del row[number - 1]
        if tid == "V1" and number - 1 < len(row):
            row[number - 1]["transition"] = 0.0       # its dissolve was into the clip taken out
        return f"removed {label} from {tid}"
    if tid == "A1":
        raise ValueError(f"{what}: the bed on A1 runs under the whole film; it can only be removed")
    changed = []
    for key in ("in", "length", "volume", "gap", "at"):
        if op.get(key) is None:
            continue
        if key == "at" and tid == "V1":
            raise ValueError(f"{what}: a V1 clip begins where the one before it ends - set its 'gap', "
                             "or trim the clips before it")
        if key == "gap" and tid != "V1":
            raise ValueError(f"{what}: 'gap' is for V1; on {tid} set 'at'")
        v = _num(op.get(key), f"{what}: '{key}'", _MIN_CLIP if key == "length" else 0.0)
        clip[key] = round(min(4.0, v) if key == "volume" else v, 4)
        changed.append(f"{key} {clip[key]}")
    if op.get("name") is not None:
        clip["name"] = str(op["name"])[:200]
        changed.append(f"name {clip['name']}")
    if not changed:
        raise ValueError(f"{what}: nothing to set (in, length, volume, name, and at - or gap on V1)")
    if track is not None:
        hit = _clashes(track, float(clip.get("at") or 0), float(clip.get("length") or 0), skip=clip)
        if hit is not None:
            raise ValueError(f"{what}: {label} would share a moment with {_label(hit)} on {tid}")
        track["clips"] = sorted(row, key=lambda c: float(c.get("at") or 0))
    elif number > 1 and float(clip.get("transition") or 0) >= float(clip.get("length") or 0):
        raise ValueError(f"{what}: {label} would be shorter than its dissolve")
    return f"{label} on {tid}: " + ", ".join(changed)


def apply_ops(edit, ops, durations=None):
    """*edit* (the panel's form of a cut) with *ops* done to it; returns ``(new edit, said)``.

    ``said`` has one line per op. An op that cannot be done raises ValueError naming it, and
    then none of them is done. Ops:

    - ``{"op": "add", "file", "at", "track", "in", "length", "name", "volume"}``: a clip placed
      at ``at`` seconds of the film. ``track``: ``"A2"``, ``"V3"`` ... (made when it is not
      there), ``"new"``, or empty for the first track of the file's kind with room there (sound:
      A2.., picture: V2..). ``length`` defaults to the rest of the file (``durations``: seconds
      by path). V1 and A1 take no placed clips: V1 is the cut itself, A1 the bed under it.
    - ``{"op": "set", "track", "clip", "at", "in", "length", "volume", "name", "gap"}``: move,
      trim, rename or set the volume of clip number ``clip`` (from 1) of ``track``; on V1 a new
      ``in`` / ``length`` ripples the clips after it, and ``gap`` is the empty time before it.
    - ``{"op": "remove", "track", "clip"}``: take a clip out (V1 closes up; on A1 a bed goes).
    """
    import copy
    if not isinstance(ops, list) or not ops:
        raise ValueError("'ops' is a list of 1 or more changes")
    if len(ops) > MAX_OPS:
        raise ValueError(f"at most {MAX_OPS} changes at once")
    new = copy.deepcopy(edit)
    new.setdefault("tracks", [])
    durations = {norm_path(k): v for k, v in (durations or {}).items()}
    said = []
    for n, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise ValueError(f"change {n} is not an object")
        kind_of_op = str(op.get("op") or "").strip().lower()
        what = f"change {n} ({kind_of_op or '?'})"
        if kind_of_op == "add":
            said.append(_op_add(new, op, what, durations))
        elif kind_of_op in ("set", "remove"):
            said.append(_op_edit(new, op, what, kind_of_op))
        else:
            raise ValueError(f"{what}: 'op' is add, set or remove")
    return new, said


def change(path, ops, stamp="", may_use=None, durations=None):
    """Do *ops* (:func:`apply_ops`) to the cut in the ``.otio`` at *path* and save it as the
    panel saves; returns ``(the cut as it now reads, said)``."""
    edit, said = apply_ops(read_editable(path), ops, durations)
    return save(path, edit, stamp, may_use), said


# ── a marked range, in the sources ───────────────────────────────────────────
#
# The user marks an in and an out on the cut (film frames of the Edit tab's
# timeline) and asks for "the shot inside it" made again. A generator or a trim
# needs the SOURCE: which file, and which of its frames. That goes through the
# clip's place in the film, its in point, its speed and its loop, and the
# source's own frame rate - arithmetic an agent should never do by hand. A film
# frame f shows its clip's source at the moment (f + 0.5) / fps of the film, as
# the Edit tab plays it (srcLocal, pictureAt) and the render reads it
# (timeline_render.clip_frames, through source_moment below).

_STILL_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".gif", ".bmp", ".avif", ".exr")
_EPS = 1e-6


def _still_clip(clip):
    """A picture or a title: no time of its own (the Edit tab's isStillClip)."""
    return clip.get("title") is not None or os.path.splitext(str(clip.get("file") or ""))[1].lower() in _STILL_EXTS


def _speed(clip):
    """A clip's speed as the Edit tab plays it (speedOf): 1 for a still, held to MIN_SPEED .. MAX_SPEED."""
    try:
        s = float(clip.get("speed") if clip.get("speed") is not None else 1.0)
    except (TypeError, ValueError):
        s = 1.0
    return max(MIN_SPEED, min(MAX_SPEED, s)) if s > 0 and not _still_clip(clip) else 1.0


def _motion(clip):
    """"reverse" / "freeze" / "" (the Edit tab's motionOf): not on a still or a title."""
    m = clip.get("motion")
    return m if m in ("reverse", "freeze") and not _still_clip(clip) else ""


def _ramp(clip):
    """A clip's speed ramp: its "spd" keys (rampOf), or [] - none on a still, a title or a frozen / reversed clip."""
    if _still_clip(clip) or clip.get("motion") in ("reverse", "freeze") or not isinstance(clip.get("fx"), dict):
        return []
    return clean_keys({"spd": (clip["fx"].get("keys") or {}).get("spd")}).get("spd") or []


def _share_area(x, how):
    """The integral from 0 to *x* of a key's share curve (shareArea in the JS)."""
    if how == "hold":
        return 0.0
    if how == "in":
        return x ** 3 / 3
    if how == "out":
        return x * x - x ** 3 / 3
    if how == "inout":
        return x ** 3 - x ** 4 / 2
    return x * x / 2


def ramp_advance(keys, u):
    """Seconds of source a ramp runs over in the clip's first *u* seconds (rampAdvance in the JS)."""
    t = max(0.0, float(u))
    if not keys:
        return t
    first, last = keys[0], keys[-1]
    total = min(t, first["t"]) * first["v"]
    for a, b in zip(keys, keys[1:]):
        if t <= a["t"]:
            break
        dt = max(1e-9, b["t"] - a["t"])
        x = min(1.0, (t - a["t"]) / dt)
        total += dt * (a["v"] * x + (b["v"] - a["v"]) * _share_area(x, a.get("i")))
    if t > last["t"]:
        total += (t - last["t"]) * last["v"]
    return total


def _step(clip):
    """Seconds of source per second of the clip (stepOf): the speed, negative reversed, 0 frozen.
    Also takes clip_time's answer (a dict with speed and motion and no file)."""
    m = clip.get("motion") if clip.get("motion") in ("reverse", "freeze") and not _still_clip(clip) else ""
    s = _speed(clip)
    return 0.0 if m == "freeze" else -s if m == "reverse" else s


def _loop(clip):
    """``(mode, span)``: "loop" / "pingpong" and one turn in seconds of source, or ``("", 0.0)`` (loopOf)."""
    try:
        span = float(clip.get("span") or 0)
    except (TypeError, ValueError):
        span = 0.0
    mode = clip.get("loop")
    return (mode, span) if mode in ("loop", "pingpong") and span > 0 and not _still_clip(clip) and not _motion(clip) \
        and not _ramp(clip) else ("", 0.0)


def source_moment(clip, u):
    """The moment (seconds) of *clip*'s source shown *u* seconds into the clip: from its
    in point at its speed, through its loop (``loop``: from the in point again,
    ``pingpong``: back and forth). The Edit tab's ``srcLocal``; the render reads its
    frames by it (timeline_render.clip_frames)."""
    start = float(clip.get("in") or 0)
    q = max(0.0, float(u)) * _speed(clip)
    motion = _motion(clip)
    if motion == "freeze":
        return start
    if motion == "reverse":
        return max(0.0, start - q)
    ramp = _ramp(clip)
    if ramp:
        return start + ramp_advance(ramp, u)
    mode, span = _loop(clip)
    if mode == "loop":
        q = q % span
    elif mode == "pingpong":
        p = q % (2 * span)
        q = p if p < span else 2 * span - p
    return start + q


def _film_frames(a, b, fps):
    """``(first, last)``: the film frames whose moment ``(f + 0.5) / fps`` lies in ``[a, b)`` seconds."""
    return math.ceil(a * fps - 0.5 - _EPS), math.ceil(b * fps - 0.5 - _EPS) - 1


def _src_frames(s0, s1, sfps):
    """``(first, last)``: the source frames a stretch between *s0* and *s1* source seconds runs over."""
    lo, hi = min(s0, s1), max(s0, s1)
    first = math.floor(lo * sfps + _EPS)
    return first, max(first, math.ceil(hi * sfps - _EPS) - 1)


def _shown(moment, sfps):
    """The source frame on screen at *moment* (a frame stays until the next one begins). The
    moment is taken to 0.1 ms, as the Edit tab seeks its player (srcLocal rounds so)."""
    return max(0, math.floor(round(moment, 4) * sfps + _EPS))


def _runs(clip, u0, u1):
    """The stretch ``[u0, u1)`` of a clip (seconds into it) as runs in which its source moves
    one way: ``[(x, y, s0, s1, backwards)]`` - one for a plain clip, one per turn of a loop."""
    speed = _speed(clip)
    mode, span = _loop(clip)
    start = float(clip.get("in") or 0)
    if _motion(clip) == "freeze":
        return [(u0, u1, start, start, False)]
    if _motion(clip) == "reverse":
        return [(u0, u1, max(0.0, start - u0 * speed), max(0.0, start - u1 * speed), True)]
    if _ramp(clip):
        return [(u0, u1, source_moment(clip, u0), source_moment(clip, u1), False)]
    if not mode:
        return [(u0, u1, start + u0 * speed, start + u1 * speed, False)]
    turn = span / speed
    out, x = [], u0
    while x < u1 - _EPS and len(out) < 1000:
        k = math.floor(x / turn + 1e-9)
        y = min(u1, (k + 1) * turn)
        p, q = (x - k * turn) * speed, (y - k * turn) * speed
        if mode == "pingpong" and k % 2 == 1:
            out.append((x, y, start + span - p, start + span - q, True))
        else:
            out.append((x, y, start + p, start + q, False))
        x = y
    return out


def _clip_label(clip):
    if isinstance(clip.get("title"), dict):
        words = str(clip["title"].get("text") or "").strip().splitlines()
        return 'title "' + (words[0][:60] if words else "") + '"'
    return str(clip.get("name") or os.path.basename(str(clip.get("file") or "")))[:80]


def _picture_layers(edit):
    """``[(rank, track id, number from 1, clip, film moment it begins)]`` of every clip that can
    be seen: V1 (rank 0) and the video tracks above it, switched-off clips and tracks left out."""
    layers = []
    if not (edit.get("off") or {}).get("V1"):
        for n, (c, at) in enumerate(zip(edit.get("clips") or [], v1_times(edit)), 1):
            if isinstance(c, dict) and not c.get("disabled"):
                layers.append((0, "V1", n, c, at))
    rank = 0
    for t in edit.get("tracks") or []:
        if not isinstance(t, dict) or t.get("kind") == "audio":
            continue
        rank += 1                       # later video tracks lie higher (pictureAt)
        if t.get("off"):
            continue
        for n, c in enumerate(t.get("clips") or [], 1):
            if isinstance(c, dict) and not c.get("disabled"):
                layers.append((rank, str(t.get("id") or t.get("name") or "V?"), n, c, float(c.get("at") or 0)))
    return layers


def source_map(edit, start, end, src_fps=None):
    """What a marked range of the cut is in the sources.

    *edit* is the cut as the Edit panel works on it (:func:`editable`); *start* / *end* are
    film frames of its timeline, both included (the viewer's in and out marks). Answers
    ``{"start", "end", "frames", "fps", "start_s", "end_s", "pieces"}`` with one piece for
    every clip of a picture track the range touches (V1 and the video tracks above it):

    ``track``, ``clip`` (numbered from 1 per track, as edit_cut does), ``name``, ``file``;
    ``rec_in`` / ``rec_out`` (the film frames of the range on this clip, both included),
    ``rec_frames``, ``rec_in_s`` / ``rec_out_s`` (film seconds, the out exclusive),
    ``whole_clip``, ``fps`` (the cut's); ``src_fps`` (the file's), ``src_fps_known``;
    ``src_in`` / ``src_out`` (the frames of the FILE the stretch runs over, both included,
    0 = its first frame), ``src_frames``, ``src_in_s`` / ``src_out_s`` / ``src_seconds`` (the
    same stretch in seconds of the file: a trim takes ``src_seconds`` from ``src_in_s``);
    ``src_first_shown`` / ``src_last_shown`` (the file's frames on screen at the range's first
    and last film frame); ``speed``. A looped clip adds ``loop`` and ``runs`` - one per turn
    (``rec_in, rec_out, src_in, src_out, src_in_s, src_out_s, backwards``), the top-level
    src_* spanning them all. A piece under a clip of a higher track has ``covered_by``. A
    still has ``still: true`` and no source frames, a title ``title: true``.

    *src_fps*: ``{file: frames per second}`` of the sources (the route probes them); a file
    not in it is taken at the cut's rate, ``src_fps_known: false``.
    """
    fps = float(edit.get("fps") or 24.0) or 24.0
    src_fps = src_fps or {}
    a, b = sorted((int(start), int(end)))
    total = max(1, int(round(edit_length(edit) * fps)))
    a, b = max(0, a), min(b, total - 1)
    out = {"start": a, "end": b, "frames": max(0, b - a + 1), "fps": fps,
           "start_s": round(a / fps, 4), "end_s": round((b + 1) / fps, 4), "pieces": []}
    if b < a:
        return out
    hits = []
    for rank, tid, n, c, at in _picture_layers(edit):
        length = float(c.get("length") or 0)
        f0, f1 = _film_frames(at, at + length, fps)
        lo, hi = max(a, f0), min(b, f1)
        if lo <= hi:
            hits.append({"rank": rank, "id": f"{tid}:{n}", "track": tid, "n": n, "clip": c, "at": at,
                         "length": length, "f0": f0, "f1": f1, "lo": lo, "hi": hi})
    for h in hits:
        c, at, lo, hi = h["clip"], h["at"], h["lo"], h["hi"]
        piece = {"track": h["track"], "clip": h["n"], "name": _clip_label(c), "file": str(c.get("file") or ""),
                 "rec_in": lo, "rec_out": hi, "rec_frames": hi - lo + 1,
                 "rec_in_s": round(lo / fps, 4), "rec_out_s": round((hi + 1) / fps, 4),
                 "whole_clip": lo == h["f0"] and hi == h["f1"], "fps": fps}
        over = [o["id"] for o in hits if o["rank"] > h["rank"] and o["clip"].get("title") is None
                and o["lo"] <= hi and o["hi"] >= lo]
        if over:
            piece["covered_by"] = over
        if c.get("title") is not None:
            piece["title"] = True
        elif _still_clip(c):
            piece["still"] = True
        else:
            sfps = float(src_fps.get(piece["file"]) or 0)
            known = sfps > 0
            sfps = sfps if known else fps
            u0 = max(0.0, lo / fps - at)
            u1 = min(h["length"], (hi + 1) / fps - at)
            runs = []
            for x, y, s0, s1, back in _runs(c, u0, u1):
                i0, i1 = _src_frames(s0, s1, sfps)
                r0, r1 = _film_frames(at + x, at + y, fps)
                runs.append({"rec_in": max(lo, r0), "rec_out": min(hi, r1), "src_in": i0, "src_out": i1,
                             "src_in_s": round(min(s0, s1), 4), "src_out_s": round(max(s0, s1), 4),
                             "backwards": back})
            s_lo, s_hi = min(r["src_in_s"] for r in runs), max(r["src_out_s"] for r in runs)
            i_lo, i_hi = min(r["src_in"] for r in runs), max(r["src_out"] for r in runs)
            piece.update({"src_fps": round(sfps, 4), "src_fps_known": known,
                          "src_in": i_lo, "src_out": i_hi, "src_frames": i_hi - i_lo + 1,
                          "src_in_s": s_lo, "src_out_s": s_hi, "src_seconds": round(s_hi - s_lo, 4),
                          "src_first_shown": _shown(source_moment(c, (lo + 0.5) / fps - at), sfps),
                          "src_last_shown": _shown(source_moment(c, (hi + 0.5) / fps - at), sfps),
                          "speed": _speed(c)})
            mode, _turn = _loop(c)
            if mode:
                piece["loop"] = mode
                piece["runs"] = runs
        out["pieces"].append(piece)
    return out
