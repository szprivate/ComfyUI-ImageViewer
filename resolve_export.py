"""Export to Resolve: a folder that DaVinci Resolve, the free version too, can open.

``<name>/media/`` holds whole copies of the original files the cut uses,
``<name>.fcpxml`` is the timeline, ``<name>.edl`` a CMX3600 fallback for V1,
``<name>.otio`` the cut with its media pointing into ``media/``, ``README.txt``
says how to import it and what did not come along.

Three halves, in this order in the file:

* :func:`build_model` / :func:`fcpxml` / :func:`edl`: pure. The cut becomes pieces
  on whole frames, and those become text. All time arithmetic is on
  ``fractions.Fraction`` from the frame rate (24000/1001, not 23.976), so nothing
  drifts: a position is a count of frames, never a sum of seconds.
* :func:`probe` / :func:`free_version_note`: what each file is, and whether the
  free version may fail to read it.
* :func:`make_plan` / :class:`Job`: the copy, in a thread of its own (the output is
  often on a slow share), with progress and cancel. Everything is built in a
  ``<name>.partial-<id>`` folder beside the target and renamed at the end, so a
  cancel or a failure leaves nothing behind, and an original is only ever read.

WHY ABSOLUTE ``file:///`` URLS, on the evidence: Apple's DTD says an asset's src is
a "file: URL"; Resolve's manual (20, ch. 58, "Conforming XML Files") says it finds
media "based on the embedded file paths" and, when they are not there, prompts for
a folder whose subfolders it searches. Nothing found says Resolve takes a relative
src. So: this machine's absolute paths (they import as they are), and a package
that was moved is relinked at that prompt by pointing at it.

Not verified inside Resolve itself; the README and the viewer's CLAUDE.md say so.
"""

import copy
import json
import math
import os
import re
import shutil
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from fractions import Fraction
from urllib.parse import quote

from . import timeline_io
from .timeline_render import effective, is_still

CHUNK = 4 * 1024 * 1024
MAX_PIECES = 20000
_NEEDED_SPARE = 16 * 1024 * 1024         # the timeline files, and a margin
_NOMINAL = (24, 30, 48, 60, 120)


class ExportError(ValueError):
    """The package cannot be made; the message is for the person at the panel."""


# ── time ─────────────────────────────────────────────────────────────────────

def rate_of(fps):
    """A frame rate as the exact fraction it stands for: 23.976 is 24000/1001."""
    value = float(fps or 24.0)
    if not value > 0:
        value = 24.0
    for base in _NOMINAL:
        ntsc = base * 1000 / 1001
        if abs(value - ntsc) < 0.01:
            return Fraction(base * 1000, 1001)
    return Fraction(value).limit_denominator(1001)


def frames_of(seconds, rate):
    return int(round(float(seconds or 0) * float(rate)))


def _exact(value):
    """A number from a file (4 decimals) as a fraction of what it says."""
    return Fraction(str(round(float(value or 0), 6)))


def time_str(value):
    """A time FCPXML can read: ``0s``, ``3s``, ``1001/24s``."""
    value = Fraction(value)
    if value == 0:
        return "0s"
    return f"{value.numerator}s" if value.denominator == 1 else f"{value.numerator}/{value.denominator}s"


def frame_duration(rate):
    """One frame, as FCPXML spells it: ``1001/24000s``, ``100/3000s``."""
    if rate.denominator == 1:
        return f"100/{rate.numerator * 100}s"
    return f"{rate.denominator}/{rate.numerator}s"


def _grid(frames, rate):
    """*frames* frames, in units of the frame duration as it is spelled."""
    if not frames:
        return "0s"
    if rate.denominator == 1:
        return f"{frames * 100}/{rate.numerator * 100}s"
    return f"{frames * rate.denominator}/{rate.numerator}s"


def timecode(frames, rate):
    """HH:MM:SS:FF, non-drop: frames counted at the nominal base (30 for 29.97),
    which is what makes it exact at an NTSC rate."""
    base = int(round(float(rate)))
    frames = max(0, int(frames))
    ff = frames % base
    total = frames // base
    return f"{total // 3600:02d}:{total // 60 % 60:02d}:{total % 60:02d}:{ff:02d}"


def _tc_start(text, fps):
    """A file's embedded start timecode in seconds (0 when it has none): Resolve
    matches a clip to its file by timecode, so an in point has to include it."""
    match = re.fullmatch(r"(\d+):(\d+):(\d+)([:;.])(\d+)", str(text or "").strip())
    if not match or not fps:
        return Fraction(0)
    hh, mm, ss, sep, ff = match.groups()
    hh, mm, ss, ff = int(hh), int(mm), int(ss), int(ff)
    base = int(round(float(fps)))
    count = (hh * 3600 + mm * 60 + ss) * base + ff
    if sep in ";." and base in (30, 60):
        drop = 2 if base == 30 else 4
        minutes = hh * 60 + mm
        count -= drop * (minutes - minutes // 10)
    return Fraction(count) / Fraction(fps)


# ── the cut as pieces on whole frames ────────────────────────────────────────

def _bed_clips(doc):
    """The first sound track's clips: ``[(at, in, length, volume, fade_out, file, name)]``."""
    audio = timeline_io._track_of(doc, "audio") or {}
    out, at = [], 0.0
    for child in audio.get("children") or []:
        if not isinstance(child, dict):
            continue
        schema = str(child.get("OTIO_SCHEMA") or "")
        if schema.startswith("Transition"):
            continue
        start, length = timeline_io._span(child.get("source_range"))
        if schema.startswith("Clip") and length > 0:
            note = timeline_io._note(child)
            try:
                gain = float(note.get("gain", note.get("volume", 1.0)))
            except (TypeError, ValueError):
                gain = 1.0
            out.append((at, start, length, gain, note.get("fade_out", 1.0),
                        timeline_io._file(child.get("media_reference")), str(child.get("name") or "")))
        at += length
    return out


def used_files(doc):
    """Every file the cut as a whole uses (the active take of a clip is its media)."""
    edit = timeline_io.editable(doc)
    seen, out = set(), []

    def add(path):
        key = timeline_io.norm_path(path)
        if path and key not in seen:
            seen.add(key)
            out.append(path)
    for c in edit["clips"]:
        add(c.get("file"))
    for bed in _bed_clips(doc):
        add(bed[5])
    for track in edit.get("tracks") or []:
        for c in track.get("clips") or []:
            add(c.get("file"))
    return out


def _source_rate(info, rate):
    fps = (info or {}).get("fps")
    return Fraction(fps) if fps else rate


def _turns(clip, u0, u1, rate):
    """The stretches of a clip's frames *u0*..*u1* that the source runs without a
    jump: ``[(first, last, source at first, speed)]``; speed < 0 runs backwards.
    A loop is what the render plays (timeline_render.source_moment), as clips."""
    speed = _exact(clip.get("speed") or 1) or Fraction(1)
    start = clip["_src"]
    span = _exact(clip.get("span") or 0)
    loop = clip.get("loop") if span > 0 else ""
    if not loop:
        return [(u0, u1, start + Fraction(u0) / rate * speed, speed)]
    out = []
    turn = 0
    per = span / speed * rate              # frames per turn, exact
    while True:
        a, b = int(round(turn * per)), int(round((turn + 1) * per))
        if a >= u1:
            break
        lo, hi = max(a, u0), min(b, u1)
        if hi > lo:
            ran = Fraction(lo - a) / rate * speed
            if loop == "pingpong" and turn % 2:
                out.append((lo, hi, start + span - ran, -speed))
            else:
                out.append((lo, hi, start + ran, speed))
        turn += 1
        if turn > MAX_PIECES or len(out) > MAX_PIECES:
            raise ExportError(f"{clip.get('name') or 'a clip'} loops too many times to write out as clips")
    return out


def _clip_pieces(c, u0, u1, at, rate, info, track, enabled=True):
    """Frames *u0*..*u1* of clip *c*, whose frame 0 lies at film frame *at*."""
    src_rate = _source_rate(info, rate)
    c = dict(c, _src=Fraction(round(_exact(c.get("in")) * src_rate)) / src_rate)
    still = bool(info and info.get("still")) or is_still(c.get("file"))
    turns = [(u0, u1, Fraction(0), Fraction(1))] if still else _turns(c, u0, u1, rate)
    return [{"file": c.get("file") or "", "name": str(c.get("name") or os.path.basename(c.get("file") or "")),
             "start": at + a, "dur": b - a, "src": src, "speed": speed, "still": still,
             "volume": float(c.get("volume", 1.0) if c.get("volume") is not None else 1.0),
             "mute": bool(c.get("mute")), "fx": c.get("fx") or {}, "enabled": enabled, "track": track,
             "looped": bool(c.get("loop"))} for a, b, src, speed in turns]


def _clamp(piece, lo, hi, rate):
    """*piece* cut to film frames *lo*..*hi* and moved to start from *lo*, or None."""
    a, b = max(piece["start"], lo), min(piece["start"] + piece["dur"], hi)
    if b <= a:
        return None
    out = dict(piece, start=a - lo, dur=b - a)
    if not piece.get("gap") and not piece.get("still"):
        out["src"] = piece["src"] + Fraction(a - piece["start"]) / rate * piece["speed"]
    return out


def build_model(doc, probes, frames=None, empty_ok=False):
    """The cut as pieces: ``{"name", "rate", "width", "height", "total", "spine",
    "lanes", "marks", "left_out", "files"}``.

    ``spine`` is V1 from cut to cut with no hole (gaps are pieces, ``gap: True``);
    a piece after a dissolve carries ``mix: (first frame, frames)``. ``lanes`` are
    the other tracks' pieces with ``lane`` (+ picture, - sound). *probes* is
    ``{file: what probe() said, or None for a file that is not there}``; a piece of
    a file that is not there is left out, V1 keeping its place with a gap.
    *frames* ``(first, last)``: only those frames of the film (both included).
    """
    edit = timeline_io.editable(doc)
    rate = rate_of(edit.get("fps"))
    left = []

    def say(line):
        if line not in left:
            left.append(line)
    info_of = lambda path: probes.get(path)        # noqa: E731

    # V1, in the render's arithmetic (timeline_render.frame_counts): whole frames per clip.
    clips = edit["clips"]
    counts = []
    for i, c in enumerate(clips):
        n = max(1, frames_of(c["length"], rate))
        d = 0 if c.get("gap") else frames_of(c.get("transition"), rate) if i else 0
        counts.append([n, d])
    for i in range(1, len(counts)):
        before = counts[i - 1]
        counts[i][1] = max(0, min(counts[i][1], counts[i][0] - 1, before[0] - 1))
    spine, cursor, starts = [], 0, []
    for i, c in enumerate(clips):
        cursor += frames_of(c.get("gap"), rate)
        cursor -= counts[i][1]
        starts.append(cursor)
        cursor += counts[i][0]
    v1_on = not (edit.get("off") or {}).get("V1")
    for i, c in enumerate(clips):
        n, d = counts[i]
        head = d // 2
        tail = 0
        if i + 1 < len(clips):
            nd = counts[i + 1][1]
            tail = nd - nd // 2
        u0, u1 = head, max(head + 1, n - tail)
        info = info_of(c.get("file"))
        if info is None:
            spine.append({"gap": True, "start": starts[i] + u0, "dur": u1 - u0, "missing": c.get("file")})
            continue
        pieces = _clip_pieces(c, u0, u1, starts[i], rate, info, "V1", v1_on)
        if d and pieces:
            before = info_of(clips[i - 1].get("file"))
            if before is not None:
                pieces[0]["mix"] = (starts[i], d, head)
        spine.extend(pieces)

    lanes = []
    video_lane, audio_lane = 0, -1
    for track in edit.get("tracks") or []:
        sound = track.get("kind") == "audio"
        if sound:
            audio_lane -= 1
            lane = audio_lane
        else:
            video_lane += 1
            lane = video_lane
        for c in track.get("clips") or []:
            info = info_of(c.get("file"))
            if info is None:
                continue
            n = max(1, frames_of(c["length"], rate))
            at = frames_of(c.get("at"), rate)
            for p in _clip_pieces(c, 0, n, at, rate, info, track.get("name") or track.get("id"), not track.get("off")):
                p["lane"], p["sound"] = lane, sound
                lanes.append(p)

    picture_end = max([p["start"] + p["dur"] for p in spine]
                      + [p["start"] + p["dur"] for p in lanes if not p.get("sound")] + [0])
    bed_on = not (edit.get("off") or {}).get("A1")
    for at, start, length, gain, fade, path, name in _bed_clips(doc):
        info = info_of(path)
        if info is None:
            continue
        begin = frames_of(at, rate)
        n = min(max(1, frames_of(length, rate)), max(1, picture_end - begin))
        known = info.get("duration")
        if known:
            room = int(math.floor((Fraction(known) - _exact(start)) * rate))
            if 0 < room < n:
                n = room
        lanes.extend(dict(p, lane=-1, sound=True) for p in
                     _clip_pieces({"file": path, "name": name or os.path.basename(path), "in": start,
                                   "volume": gain}, 0, n, begin, rate, info, "A1", bed_on))
        try:
            if float(fade or 0) > 0:
                say("The fade at the end of the music bed: the viewer's render draws it, the timeline has the bed at one level.")
        except (TypeError, ValueError):
            pass

    marks = []
    if (edit.get("off") or {}).get("T"):
        if edit["texts"]:
            say("Texts: their track is switched off, so they are not in the timeline.")
    else:
        for t in edit["texts"]:
            marks.append({"start": frames_of(t["start"], rate), "dur": max(1, frames_of(t["length"], rate)),
                          "text": str(t.get("text") or "")})
        if marks:
            say("Texts come as markers holding their words at their moment, not as drawn titles: "
                "their look (size, place, colour) is left out. Add them in Resolve as Text+.")

    # In and out.
    total = max([p["start"] + p["dur"] for p in spine + lanes] + [m["start"] + m["dur"] for m in marks] + [0])
    if frames:
        lo = max(0, min(total - 1, int(frames[0])))
        hi = max(lo + 1, min(total, int(frames[1]) + 1))
        kept = []
        for p in spine:
            cut = _clamp(p, lo, hi, rate)
            if not cut:
                continue
            mix = p.get("mix")
            if mix and not (mix[0] >= lo and mix[0] + mix[1] <= hi):
                cut.pop("mix", None)
                say("A dissolve that the in or out point falls inside became a cut.")
            elif mix:
                cut["mix"] = (mix[0] - lo, mix[1], mix[2])
            kept.append(cut)
        spine = kept
        lanes = [c for c in (_clamp(p, lo, hi, rate) for p in lanes) if c]
        moved = []
        for m in marks:
            a, b = max(m["start"], lo), min(m["start"] + m["dur"], hi)
            if b > a:
                moved.append(dict(m, start=a - lo, dur=b - a))
        marks = moved
        total = hi - lo

    # V1 with no holes: empty time is a gap, as far as anything else on the film reaches.
    full, at = [], 0
    for p in spine:
        if p["start"] > at:
            full.append({"gap": True, "start": at, "dur": p["start"] - at})
        full.append(p)
        at = p["start"] + p["dur"]
    if total > at:
        full.append({"gap": True, "start": at, "dur": total - at})
    # A dissolve needs a clip on both sides.
    for i, p in enumerate(full):
        if p.get("mix") and (i == 0 or full[i - 1].get("gap")):
            p.pop("mix")
    if len(full) > MAX_PIECES or len(lanes) > MAX_PIECES:
        raise ExportError("this cut is too long to write out as clips")

    # What Resolve's timeline will do differently from the viewer's.
    every = [p for p in full if not p.get("gap")] + lanes
    if not every and not empty_ok:
        raise ExportError("no clip of this cut can be read")
    if any(p["speed"] != 1 for p in every):
        say("Retimed sound plays as Resolve retimes it; the viewer plays it like tape, and silent past 4x.")
    if any(p["speed"] < 0 for p in every):
        say("Ping-pong loops come as forward and backward clips; a backward clip needs checking in Resolve.")
    if any(p.get("looped") for p in every):
        say("Loops come as the clip repeated: Resolve has no loop, so they no longer stretch as one clip.")
    if any(effective(p.get("fx")) and (effective(p["fx"])["fh"] or effective(p["fx"])["fv"]) for p in every):
        say("A flip is written as a negative scale; Resolve's manual only promises flips from AAF, so check it.")
    if any(p.get("link") for p in every) or _has_links(edit):
        say("Linked picture and sound arrive as separate clips (Resolve's own Link Clips can join them again).")
    if any(c.get("color") for c in clips):
        say("Clip colours.")
    if _covers_sound(edit, rate):
        say("In the viewer a clip on a higher video track silences what lies beneath it; in Resolve both sound.")
    lost = [os.path.basename(str(p.get("missing"))) for p in full if p.get("missing")]
    if lost:
        say("Missing, a gap in its place on V1: " + ", ".join(sorted(set(lost))))
    skipped = sorted({os.path.basename(path) for path in used_files(doc) if info_of(path) is None})
    if skipped:
        say("Files that are not there and so are not in the package: " + ", ".join(skipped))

    # The picture's size: the timeline's own, else the first shot's (timeline_render._size).
    about = timeline_io._note(doc)
    width, height = int(about.get("width") or 0), int(about.get("height") or 0)
    if not (width > 0 and height > 0):
        first = next((p for p in every if not p.get("sound") and (probes.get(p["file"]) or {}).get("width")), None)
        info = probes.get(first["file"]) if first else {}
        width, height = int(info.get("width") or 1920), int(info.get("height") or 1080)

    files, seen = [], set()
    for p in every:
        key = timeline_io.norm_path(p["file"])
        if key not in seen:
            seen.add(key)
            files.append(p["file"])
    return {"name": str(edit.get("name") or "cut"), "rate": rate, "width": width, "height": height, "total": total,
            "spine": full, "lanes": lanes, "marks": marks, "left_out": left, "files": files}


def _has_links(edit):
    return any(c.get("link") for c in edit["clips"]) or any(
        c.get("link") for t in edit.get("tracks") or [] for c in t.get("clips") or [])


def _covers_sound(edit, rate):
    spans = [(frames_of(c.get("at"), rate), frames_of(c.get("length"), rate))
             for t in edit.get("tracks") or [] if t.get("kind") != "audio" and not t.get("off")
             for c in t.get("clips") or []]
    return bool(spans) and any(not c.get("mute") for c in edit["clips"])


# ── FCPXML ───────────────────────────────────────────────────────────────────

_NOT_XML = re.compile("[^\t\n\r\x20-퟿-�\U00010000-\U0010ffff]")


def _text(value, limit=2000):
    """Text XML 1.0 may hold (ElementTree escapes the rest, but not this)."""
    return _NOT_XML.sub("", str(value or ""))[:limit]


def file_uri(path):
    """A path as a file URL: every part percent-encoded (space, #, umlauts), the
    drive's colon kept, ``//server/share`` as ``file://server/share``."""
    p = str(path).replace("\\", "/")
    if p.startswith("//"):
        host, _, rest = p[2:].partition("/")
        return f"file://{quote(host, safe='')}/" + quote(rest, safe="/")
    if re.match(r"^[A-Za-z]:", p):
        return f"file:///{p[:2]}" + quote(p[2:], safe="/")
    return "file:///" + quote(p.lstrip("/"), safe="/")


def _num(value):
    return f"{round(float(value), 5):.5f}".rstrip("0").rstrip(".") or "0"


_STANDARD = {(1280, 720): "720p", (1920, 1080): "1080p", (3840, 2160): "2160p", (4096, 2160): "4096x2160p"}


def _format_name(width, height, rate):
    label = _STANDARD.get((width, height))
    if not label:
        return None
    if rate.denominator == 1001:
        code = {24: "2398", 30: "2997", 48: "4795", 60: "5994", 120: "11988"}.get(round(float(rate)))
    elif rate.denominator == 1:
        code = str(rate.numerator)
    elif rate == Fraction(25, 2):
        code = None
    else:
        code = None
    return f"FFVideoFormat{label}{code}" if code else None


def _intrinsics(parent, p, info, model):
    """The adjustments in the DTD's order: crop, transform, blend, volume."""
    fx = effective(p.get("fx")) if not p.get("sound") else None
    if fx:
        pw, ph = (info or {}).get("width") or model["width"], (info or {}).get("height") or model["height"]
        if any(fx[k] for k in ("cl", "cr", "ct", "cb")):
            crop = ET.SubElement(parent, "adjust-crop", {"mode": "trim"})
            # "trim values as a percentage of original frame height" (Apple's DTD).
            ET.SubElement(crop, "trim-rect", {
                "left": _num(fx["cl"] * pw / ph * 100), "top": _num(fx["ct"] * 100),
                "right": _num(fx["cr"] * pw / ph * 100), "bottom": _num(fx["cb"] * 100)})
        sx = fx["zx"] * (-1 if fx["fh"] else 1)
        sy = fx["zy"] * (-1 if fx["fv"] else 1)
        if sx != 1 or sy != 1 or fx["x"] or fx["y"] or fx["rot"]:
            # Position and anchor: percent of the frame's HEIGHT, x and y alike, y up.
            # Rotation: + is counter-clockwise there, clockwise here.
            aspect = model["width"] / model["height"]
            attrs = {"position": f"{_num(fx['x'] * aspect * 100)} {_num(fx['y'] * 100)}",
                     "scale": f"{_num(sx)} {_num(sy)}", "rotation": _num(-fx["rot"])}
            if fx["ax"] or fx["ay"]:
                attrs["anchor"] = f"{_num(fx['ax'] * aspect * 100)} {_num(fx['ay'] * 100)}"
            ET.SubElement(parent, "adjust-transform", attrs)
        if fx["op"] != 1:
            ET.SubElement(parent, "adjust-blend", {"amount": _num(fx["op"])})
    volume = p.get("volume", 1.0)
    if (info or {}).get("audio") and not p.get("mute") and volume > 0 and abs(volume - 1.0) > 1e-4:
        ET.SubElement(parent, "adjust-volume", {"amount": f"{20 * math.log10(volume):.2f}dB"})


def _local_start(p, info):
    """The moment a piece begins on its own timeline. With a timeMap that timeline
    is the adjusted one: "time" is the new clip time, "value" the original."""
    if p.get("gap") or p.get("still"):
        return Fraction(0)
    src = p["src"] + Fraction((info or {}).get("tc") or 0)
    if p["speed"] == 1:
        return src
    return src / p["speed"] if p["speed"] > 0 else Fraction(0)


def _element(parent, p, info, ids, model, offset, lane=None):
    """A piece as an element of *parent*; its anchored children are added after."""
    rate = model["rate"]
    if p.get("gap"):
        return ET.SubElement(parent, "gap", {"name": "Gap", "offset": _grid(offset, rate), "start": "0s",
                                             "duration": _grid(p["dur"], rate)})
    tag = "video" if p["still"] else "asset-clip"
    attrs = {"ref": ids[timeline_io.norm_path(p["file"])]}
    if lane is not None:
        attrs["lane"] = str(lane)
    start = _local_start(p, info)
    attrs.update({"offset": time_str(offset) if not isinstance(offset, int) else _grid(offset, rate),
                  "name": _text(p["name"], 200), "start": time_str(start), "duration": _grid(p["dur"], rate)})
    if not p["still"]:
        if info and info.get("video") and not p.get("sound"):
            attrs["format"] = ids["format:" + timeline_io.norm_path(p["file"])]
            attrs["tcFormat"] = "NDF"
        # A film split from its sound, or sound taken from a film.
        if p.get("sound") and info and info.get("video"):
            attrs["srcEnable"] = "audio"
        elif not p.get("sound") and info and info.get("audio") and (p.get("mute") or p.get("volume", 1.0) <= 0):
            attrs["srcEnable"] = "video"
    if not p.get("enabled", True):
        attrs["enabled"] = "0"
    el = ET.SubElement(parent, tag, attrs)
    if not p["still"] and p["speed"] != 1:
        tm = ET.SubElement(el, "timeMap")
        length = Fraction(p["dur"]) / rate
        if p["speed"] > 0:
            end = start + length
            ET.SubElement(tm, "timept", {"time": "0s", "value": "0s", "interp": "linear"})
            ET.SubElement(tm, "timept", {"time": time_str(end), "value": time_str(end * p["speed"]), "interp": "linear"})
        else:
            first = p["src"] + Fraction((info or {}).get("tc") or 0)
            ET.SubElement(tm, "timept", {"time": "0s", "value": time_str(first), "interp": "linear"})
            ET.SubElement(tm, "timept", {"time": time_str(length),
                                         "value": time_str(first + length * p["speed"]), "interp": "linear"})
    _intrinsics(el, p, info, model)
    return el


def fcpxml(model, probes, uris):
    """The timeline as FCPXML 1.9. *uris*: ``{norm_path(file): file URL}``."""
    rate = model["rate"]
    root = ET.Element("fcpxml", {"version": "1.9"})
    res = ET.SubElement(root, "resources")
    seq_format = {"id": "r1", "frameDuration": frame_duration(rate), "width": str(model["width"]),
                  "height": str(model["height"]), "colorSpace": "1-1-1 (Rec. 709)"}
    name = _format_name(model["width"], model["height"], rate)
    if name:
        seq_format = {"id": "r1", "name": name, **{k: v for k, v in seq_format.items() if k != "id"}}
    ET.SubElement(res, "format", seq_format)
    ids, count = {}, 1
    for path in model["files"]:
        info = probes.get(path) or {}
        key = timeline_io.norm_path(path)
        count += 1
        attrs = {}
        if info.get("video"):
            fid = f"r{count}"
            count += 1
            w, h = str(info.get("width") or model["width"]), str(info.get("height") or model["height"])
            if info.get("still") or not info.get("fps"):
                ET.SubElement(res, "format", {"id": fid, "name": "FFVideoFormatRateUndefined", "width": w, "height": h})
            else:
                ET.SubElement(res, "format", {"id": fid, "frameDuration": frame_duration(Fraction(info["fps"])),
                                              "width": w, "height": h, "colorSpace": "1-1-1 (Rec. 709)"})
            attrs = {"hasVideo": "1", "format": fid}
            ids["format:" + key] = fid
        aid = f"r{count}"
        ids[key] = aid
        if info.get("audio"):
            attrs.update({"hasAudio": "1", "audioSources": "1", "audioChannels": str(info.get("channels") or 2),
                          "audioRate": str(info.get("audio_rate") or 48000)})
        asset = ET.SubElement(res, "asset", {
            "id": aid, "name": _text(os.path.splitext(os.path.basename(path))[0], 200),
            "start": time_str(Fraction(info.get("tc") or 0)),
            "duration": "0s" if info.get("still") else time_str(Fraction(info.get("duration") or 0)), **attrs})
        ET.SubElement(asset, "media-rep", {"kind": "original-media", "src": uris[key]})

    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", {"name": _text(model["name"], 200)})
    project = ET.SubElement(event, "project", {"name": _text(model["name"], 200)})
    sequence = ET.SubElement(project, "sequence", {"format": "r1", "duration": _grid(model["total"], rate),
                                                   "tcStart": "0s", "tcFormat": "NDF", "audioLayout": "stereo",
                                                   "audioRate": "48k"})
    spine = ET.SubElement(sequence, "spine")
    placed = []                          # (piece, element, its info)
    for p in model["spine"]:
        mix = p.get("mix")
        if mix:
            ET.SubElement(spine, "transition", {"name": "Cross Dissolve", "offset": _grid(mix[0], rate),
                                                "duration": _grid(mix[1], rate)})
        info = probes.get(p.get("file")) if not p.get("gap") else None
        el = _element(spine, p, info, ids, model, p["start"])
        placed.append((p, el, info))
    if not placed:
        raise ExportError("the cut has nothing on its timeline")

    def host(frame):
        """The V1 element a moment of the film lies in, and that moment on ITS timeline."""
        chosen = placed[0]
        for item in placed:
            if item[0]["start"] <= frame:
                chosen = item
            else:
                break
        p, el, info = chosen
        return el, _local_start(p, info) + Fraction(frame - p["start"]) / rate
    for p in sorted(model["lanes"], key=lambda q: (abs(q["lane"]), q["start"])):
        el, local = host(p["start"])
        _element(el, p, probes.get(p["file"]), ids, model, local, p["lane"])
    for m in model["marks"]:
        el, local = host(m["start"])
        text = _text(m["text"])
        line = (text.splitlines() or [""])[0][:200] or "text"
        attrs = {"start": time_str(local), "duration": _grid(m["dur"], rate), "value": line}
        if text != line:
            attrs["note"] = text
        ET.SubElement(el, "marker", attrs)
    ET.indent(root, "  ")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n'
            + ET.tostring(root, encoding="unicode") + "\n")


# ── EDL ──────────────────────────────────────────────────────────────────────

_EDL_START = 3600                     # the record side begins at 01:00:00:00, as a timeline in Resolve does


def _edl_line(text):
    return re.sub(r"[\r\n\t]+", " ", _text(text, 200))


def edl(model, media_names=None):
    """V1 as a CMX3600 EDL, non-drop. Clip names in the comment lines (reel ``AX``,
    so Resolve conforms by name); a gap is a ``BL`` event, a retime an ``M2`` line,
    a dissolve the two-line event. Sound, other tracks and adjustments are not in it."""
    rate = model["rate"]
    base = int(round(float(rate)))
    origin = _EDL_START * base
    media_names = media_names or {}
    out = [f"TITLE: {_edl_line(model['name'])}", "FCM: NON-DROP FRAME", ""]
    number = 0
    spine = model["spine"]

    def rec(frame):
        return timecode(origin + frame, rate)
    for i, p in enumerate(spine):
        number += 1
        tag = f"{number:03d}"
        if p.get("gap"):
            out += [f"{tag}  BL       V     C        {timecode(0, rate)} {timecode(p['dur'], rate)} "
                    f"{rec(p['start'])} {rec(p['start'] + p['dur'])}", ""]
            continue
        head = p["mix"][2] if p.get("mix") else 0
        next_head = spine[i + 1]["mix"][2] if i + 1 < len(spine) and spine[i + 1].get("mix") else 0
        begin, end = p["start"] - head, p["start"] + p["dur"] - next_head
        first = 0 if p["still"] else max(0, int(round(float((p["src"] - Fraction(head) / rate * p["speed"]) * rate))))
        src_in, src_out = timecode(first, rate), timecode(first + (end - begin), rate)
        if p.get("mix"):
            before = spine[i - 1]
            b_last = 0 if before["still"] else int(round(float(
                (before["src"] + Fraction(before["dur"] - head) / rate * before["speed"]) * rate)))
            b_tc = timecode(max(0, b_last), rate)
            out.append(f"{tag}  AX       V     C        {b_tc} {b_tc} {rec(begin)} {rec(begin)}")
            out.append(f"{tag}  AX       V     D {p['mix'][1]:03d}    {src_in} {src_out} {rec(begin)} {rec(end)}")
            out.append(f"* FROM CLIP NAME: {_edl_line(before['name'])}")
            out.append(f"* TO CLIP NAME: {_edl_line(p['name'])}")
        else:
            out.append(f"{tag}  AX       V     C        {src_in} {src_out} {rec(begin)} {rec(end)}")
            out.append(f"* FROM CLIP NAME: {_edl_line(p['name'])}")
        media = media_names.get(timeline_io.norm_path(p["file"]))
        if media:
            out.append(f"* SOURCE FILE: media/{_edl_line(media)}")
        if not p["still"] and p["speed"] != 1:
            out.append(f"M2   AX       {float(p['speed']) * float(rate):06.1f}                {src_in}")
        out.append("")
    return "\n".join(out) + "\n"


# ── what each file is, and what the free version may not read ────────────────

STILL_LIST = (".tif", ".tiff", ".jpg", ".jpeg", ".png", ".dpx", ".tga", ".dng")


def probe(path):
    """What a file is, from its header, in this process (no program is started):
    ``{"video", "audio", "still", "width", "height", "fps", "duration", "tc",
    "codec", "pix_fmt", "profile", "channels", "audio_rate"}``. None when it is not
    there; with ``"unread"`` when it is there and cannot be read."""
    if not path or not os.path.isfile(path):
        return None
    if is_still(path) or os.path.splitext(path)[1].lower() in (".exr", ".dpx", ".tga", ".dng", ".hdr", ".gif", ".avif"):
        info = {"video": True, "audio": False, "still": True}
        try:
            from PIL import Image
            with Image.open(path) as im:
                info.update(width=im.width, height=im.height)
        except Exception:  # noqa: BLE001 - a picture PIL cannot open is still a file to copy
            pass
        return info
    try:
        import av
        with av.open(path) as src:
            info = {"video": False, "audio": False, "still": False}
            if src.streams.video:
                v = src.streams.video[0]
                cc = v.codec_context
                fps = v.average_rate or v.base_rate
                fps = rate_of(float(fps)) if fps else None
                info.update(video=True, width=v.width, height=v.height, fps=fps,
                            codec=cc.name, pix_fmt=str(getattr(cc, "pix_fmt", "") or ""),
                            profile=str(getattr(cc, "profile", "") or ""))
                tc = v.metadata.get("timecode") or src.metadata.get("timecode")
                info["tc"] = _tc_start(tc, fps) if fps else Fraction(0)
                if not tc:
                    for s in src.streams:
                        if s.metadata.get("timecode"):
                            info["tc"] = _tc_start(s.metadata["timecode"], fps) if fps else Fraction(0)
                            break
                if v.duration and v.time_base:
                    seconds = Fraction(v.duration) * Fraction(v.time_base)
                elif src.duration:
                    seconds = Fraction(src.duration, 1000000)
                else:
                    seconds = Fraction(0)
                # A film's length on its own frame grid.
                info["duration"] = Fraction(round(seconds * fps)) / fps if fps else seconds
            if src.streams.audio:
                a = src.streams.audio[0]
                info.update(audio=True, channels=a.codec_context.channels or 2, audio_rate=a.rate or 48000,
                            audio_codec=a.codec_context.name)
                if not info["video"]:
                    if a.duration and a.time_base:
                        seconds = Fraction(a.duration) * Fraction(a.time_base)
                    else:
                        seconds = Fraction(src.duration or 0, 1000000)
                    info["duration"] = seconds
            return info
    except Exception as exc:  # noqa: BLE001 - it is there and still gets copied; the note says it could not be read
        ext = os.path.splitext(path)[1].lower()
        sound = ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac")
        return {"video": not sound, "audio": sound, "still": False, "unread": str(exc)[:200]}


def free_version_note(path, info):
    """Why the free DaVinci Resolve may fail to read this file; "" when nothing
    known speaks against it. A warning, never a certainty: Blackmagic's own codec
    table should decide, and the original is what was asked for, so nothing is
    transcoded."""
    if not info:
        return ""
    if info.get("unread"):
        return "could not be read here, so its format is not known"
    ext = os.path.splitext(str(path))[1].lower()
    if info.get("still"):
        if ext not in STILL_LIST and ext != ".exr":
            return f"{ext} is not among the stills Resolve's manual lists for an imported timeline (TIF, JPG, PNG, DPX, TGA, DNG)"
        return ""
    notes = []
    codec = str(info.get("codec") or "").lower()
    pix = str(info.get("pix_fmt") or "").lower()
    depth = re.search(r"p(\d+)", pix)
    bits = int(depth.group(1)) if depth else 8
    chroma = "4:4:4" if "444" in pix or pix.startswith("gbr") else "4:2:2" if "422" in pix else "4:2:0"
    if codec == "h264" and (bits > 8 or chroma != "4:2:0"):
        notes.append(f"H.264 {bits}-bit {chroma}: the free version is reported to play only 8-bit 4:2:0 H.264 reliably")
    elif codec in ("hevc", "h265") and chroma != "4:2:0":
        notes.append(f"H.265 {bits}-bit {chroma}: reported as Studio only")
    elif codec in ("vp8", "vp9", "av1", "theora", "wmv3", "flv1", "mpeg1video") or ext in (".webm", ".mkv", ".ogv", ".flv"):
        notes.append(f"{codec or ext}: not a format confirmed to import in the free version")
    if (info.get("width") or 0) > 3840 or (info.get("height") or 0) > 2160:
        notes.append(f"{info['width']}x{info['height']} is larger than the free version's UHD limit")
    return "; ".join(notes)


# ── naming ───────────────────────────────────────────────────────────────────

def package_name(name):
    """A folder name from what was typed: no folder in it, nothing Windows refuses."""
    return timeline_io.cut_file_name(name)[:-len(".otio")]


def default_name(folder, stem):
    """``<cut>_resolve`` beside the cut, or the next version: an export never writes
    over an earlier one (export_rules)."""
    base = package_name(f"{stem}_resolve")
    if not os.path.exists(os.path.join(folder, base)):
        return base
    for version in range(2, 1000):
        name = f"{base}_v{version:03d}"
        if not os.path.exists(os.path.join(folder, name)):
            return name
    raise ExportError("there are too many packages of this cut here")


def media_names(files):
    """``{norm_path(file): its name in media/}``: its own name, made safe; two files
    of one name from two folders get ``name_2.ext`` (compared without case, as
    Windows does). One file is one copy, whatever spelled it."""
    out, taken = {}, set()
    for path in files:
        key = timeline_io.norm_path(path)
        if key in out:
            continue
        base = os.path.basename(str(path).replace("\\", "/"))
        stem, ext = os.path.splitext(base)
        stem = package_name(stem)
        ext = re.sub(r"[^A-Za-z0-9.]", "", ext)
        name, number = stem + ext, 1
        while name.lower() in taken:
            number += 1
            name = f"{stem}_{number}{ext}"
        taken.add(name.lower())
        out[key] = name
    return out


# ── the plan: what would be copied ───────────────────────────────────────────

def _free_space(folder):
    at = os.path.abspath(folder)
    while not os.path.isdir(at):
        up = os.path.dirname(at)
        if up == at:
            break
        at = up
    try:
        return shutil.disk_usage(at).free
    except OSError:
        return None


def make_plan(doc, otio_path, folder=None, name=None, frames=None, may_read=None):
    """What an export of *doc* would do. Nothing is written. ``refused`` are files
    the viewer may not hand out (path_access), ``missing`` files that are not there."""
    files = used_files(doc)
    refused = [p for p in files if may_read is not None and not may_read(os.path.abspath(p))]
    probes = {p: (None if p in refused else probe(p)) for p in files}
    # A cut of nothing but refused files is answered as that, by the route, not as an empty cut.
    model = build_model(doc, probes, frames, empty_ok=bool(refused))
    stem = os.path.splitext(os.path.basename(otio_path))[0]
    folder = os.path.abspath(folder) if folder else os.path.dirname(os.path.abspath(otio_path))
    final = package_name(name) if name else default_name(folder, stem)
    rows, total = [], 0
    names = media_names(model["files"])
    for path in model["files"]:
        size = os.path.getsize(path)
        total += size
        info = probes[path]
        rows.append({"path": path, "name": names[timeline_io.norm_path(path)], "size": size,
                     "codec": str(info.get("codec") or info.get("audio_codec") or ""),
                     "pix_fmt": str(info.get("pix_fmt") or ""), "note": free_version_note(path, info)})
    missing = [p for p in files if probes[p] is None and p not in refused]
    return {"folder": folder, "name": final, "path": os.path.join(folder, final), "exists": os.path.exists(os.path.join(folder, final)),
            "files": rows, "size": total, "free": _free_space(folder), "missing": missing,
            "refused": refused, "left_out": model["left_out"],
            "flagged": [r for r in rows if r["note"]],
            "frames": model["total"], "fps": float(model["rate"]), "width": model["width"], "height": model["height"],
            "_model": model, "_probes": probes, "_names": names}


def public(plan):
    """A plan as the page gets it."""
    return {k: v for k, v in plan.items() if not k.startswith("_")}


# ── README and the OTIO copy ─────────────────────────────────────────────────

def otio_copy(doc, names, final):
    """*doc* with every media reference pointing into ``<final>/media`` (and
    ``metadata.bepic.package_media`` saying the same relative to the folder, so the
    folder can be read after a move). Takes that were not copied are dropped from
    the copy; the original .otio keeps them."""
    new = copy.deepcopy(doc)
    for item in timeline_io._every_clip(new):
        ref = item["media_reference"]
        name = names.get(timeline_io.norm_path(timeline_io._file(ref)))
        meta = item.setdefault("metadata", {})
        note = meta.setdefault("bepic", {}) if isinstance(meta, dict) else None
        if isinstance(note, dict):
            note.pop("takes", None)
        if not name:
            continue
        ref["target_url"] = timeline_io._url(os.path.join(final, "media", name))
        if isinstance(note, dict):
            note["package_media"] = f"media/{name}"
    return new


def readme(plan, model, final, base):
    lines = [
        f"{base} - a cut from the bEpic viewer for DaVinci Resolve",
        "=" * 60, "",
        f"{model['width']}x{model['height']}, {float(model['rate']):.3f} fps, {model['total']} frames.",
        "", "WHAT IS HERE",
        f"  media/          whole copies of the {len(model['files'])} original files the cut uses, not trimmed, not re-encoded",
        f"  {base}.fcpxml   the timeline (FCPXML 1.9): import this",
        f"  {base}.edl      CMX3600, V1 only: the fallback",
        f"  {base}.otio     the cut for OpenTimelineIO, its media pointing into media/",
        "", "HOW TO IMPORT",
        f"  1. In Resolve: File > Import > Timeline..., choose {base}.fcpxml.",
        "  2. Leave \"Automatically set project settings\" and \"Automatically import source clips",
        "     into media pool\" on, and \"Use sizing information\" on. OK.",
        "  If it does not import: the same command with the .edl. Then only V1 comes, with its cuts,",
        "  dissolves and speed changes. Point it at media/ when it asks.",
        "", "IF THE FOLDER WAS MOVED, OR ANOTHER MACHINE OPENS IT",
        f"  The timeline names the media by this machine's path: {final}",
        "  (a file: URL is what the format says, and nothing confirms that Resolve takes a relative one).",
        "  When the media is not there Resolve asks for a folder: answer Yes and pick this folder's media/.",
        "  It searches subfolders. Clips that come in offline: select them in the Media Pool,",
        "  right-click, Relink Selected Clips, and pick media/.",
        "  The record side of the EDL starts at 01:00:00:00, the FCPXML's at 00:00:00:00.",
        "", "CARRIED",
        "  frame rate, size, all video and sound tracks with their places, gaps on V1, source in and out,",
        "  dissolves, each clip's volume, mute and split sound, retime, loops (as repeated clips),",
        "  transform, crop, opacity, stills, switched-off tracks (as disabled clips), texts (as markers).",
        "", "LEFT OUT OR DIFFERENT",
    ]
    lines += [f"  - {line}" for line in model["left_out"]] or ["  nothing else that is known"]
    lines += ["", "FILES THE FREE VERSION MAY NOT READ (checked from each file's header; nothing was transcoded)"]
    if plan["flagged"]:
        lines += [f"  - {row['name']}: {row['note']}" for row in plan["flagged"]]
        lines += ["  A clip that shows \"Media offline\" or a red frame though it was found: convert that file",
                  "  to DNxHR or ProRes, or H.264 8-bit 4:2:0, and relink."]
    else:
        lines += ["  none known. H.264 and H.265 on Windows use the system's own decoders."]
    lines += ["", "NOT TESTED INSIDE RESOLVE: this package was made and checked by the viewer's own tests",
              "(well-formed, frame-accurate, every file there). The import itself is yours to try.", ""]
    return "\n".join(lines)


# ── the job ──────────────────────────────────────────────────────────────────

_jobs = {}
_jobs_lock = threading.Lock()
MAX_JOBS = 32


class Cancelled(Exception):
    pass


class Job:
    """One package being made, in a thread of its own. Read through :meth:`state`."""

    def __init__(self, doc, plan):
        self.id = uuid.uuid4().hex
        self.doc = doc
        self.plan = plan
        self.final = plan["path"]
        self.work = os.path.join(plan["folder"], f"{plan['name']}.partial-{self.id[:8]}")
        self.status = "running"
        self.done = 0
        self.total = plan["size"]
        self.current = ""
        self.error = ""
        self.result = None
        self._cancel = threading.Event()
        self._lock = threading.Lock()

    def cancel(self):
        self._cancel.set()

    def state(self):
        with self._lock:
            out = {"id": self.id, "status": self.status, "done": self.done, "total": self.total,
                   "current": self.current, "error": self.error}
            if self.result:
                out["result"] = self.result
            return out

    def _set(self, **kw):
        with self._lock:
            for key, value in kw.items():
                setattr(self, key, value)

    def _copy(self, source, target):
        """Whole or not at all: beside its place first, then renamed. Read only, the source."""
        tmp = target + ".tmp"
        with open(source, "rb") as src, open(tmp, "wb") as out:
            while True:
                if self._cancel.is_set():
                    raise Cancelled()
                block = src.read(CHUNK)
                if not block:
                    break
                out.write(block)
                self._set(done=self.done + len(block))
        shutil.copystat(source, tmp)
        if os.path.getsize(tmp) != os.path.getsize(source):
            raise OSError(f"{os.path.basename(source)} came out at another size")
        os.replace(tmp, target)

    def _write(self, name, text):
        path = os.path.join(self.work, name)
        with open(path + ".tmp", "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(path + ".tmp", path)

    def run(self):
        plan, final = self.plan, self.final
        model, probes, names = plan["_model"], plan["_probes"], plan["_names"]
        base = plan["name"]
        try:
            media = os.path.join(self.work, "media")
            os.makedirs(media)
            for path in model["files"]:
                name = names[timeline_io.norm_path(path)]
                self._set(current=name)
                self._copy(path, os.path.join(media, name))
            if self._cancel.is_set():
                raise Cancelled()
            self._set(current="the timeline")
            uris = {key: file_uri(os.path.join(final, "media", name)) for key, name in names.items()}
            self._write(base + ".fcpxml", fcpxml(model, probes, uris))
            self._write(base + ".edl", edl(model, names))
            self._write(base + ".otio", json.dumps(otio_copy(self.doc, names, final), indent=2))
            self._write("README.txt", readme(plan, model, final, base))
            if os.path.exists(final):
                raise ExportError(f"{final} appeared while this was being made")
            if self._cancel.is_set():
                raise Cancelled()
            os.replace(self.work, final)
            self._set(status="done", current="", result={
                "path": final, "fcpxml": os.path.join(final, base + ".fcpxml"), "files": len(model["files"]),
                "size": plan["size"], "left_out": model["left_out"], "flagged": plan["flagged"],
                "missing": plan["missing"]})
        except Cancelled:
            self._clean()
            self._set(status="cancelled", current="")
        except OSError as exc:
            self._clean()
            full = getattr(exc, "errno", None) == 28 or getattr(exc, "winerror", None) in (112, 39)
            said = ("The disk is full: " if full else "") + str(exc)
            self._set(status="failed", error=said, current="")
        except Exception as exc:  # noqa: BLE001 - the page has to hear of it, and nothing may stay behind
            self._clean()
            self._set(status="failed", error=str(exc), current="")

    def _clean(self):
        """Only the folder this job made, never the target and never a source."""
        for _ in range(5):
            shutil.rmtree(self.work, ignore_errors=True)
            if not os.path.exists(self.work):
                return
            time.sleep(0.2)


def start(doc, plan):
    job = Job(doc, plan)
    with _jobs_lock:
        finished = [k for k, j in _jobs.items() if j.status != "running"]
        for key in finished[:max(0, len(_jobs) - MAX_JOBS + 1)]:
            _jobs.pop(key, None)
        _jobs[job.id] = job
    threading.Thread(target=job.run, name="bepic-resolve-export", daemon=True).start()
    return job


def job_of(job_id):
    with _jobs_lock:
        return _jobs.get(str(job_id or ""))


def check_room(plan):
    """A clear refusal when the copy will not fit."""
    free = plan.get("free")
    need = plan["size"] + _NEEDED_SPARE
    if free is not None and free < need:
        raise NoRoom(f"Not enough free space in {plan['folder']}: this needs {_size(need)}, there is {_size(free)}.")


class NoRoom(ExportError):
    pass


def _size(count):
    value = float(count)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit in ("B", "KB") else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"
