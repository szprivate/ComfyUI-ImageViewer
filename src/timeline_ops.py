"""More of the Edit panel's changes, for agentY's ``edit_cut`` (``timeline_io.apply_ops``).

Each works on the panel's form of a cut (:func:`timeline_io.editable`) by the same rule as
the panel's own code in ``js/imageViewer_editTimelineData.js``, so a change made by the
agent reads back in the panel exactly as if it had been made there:

- ``insert`` - Resolve's Insert edit on V1 (``insertEdit``): the clip goes in at a moment
  of the film, a shot there is cut in two, and everything after it moves on.
- ``overwrite`` - Resolve's Overwrite edit on V1 (``overwriteV1``): the clip is laid over
  what is there; nothing else moves.
- ``add_marker`` / ``set_marker`` / ``remove_marker`` - the timeline's markers (M).
- ``mix`` - a sound track's or the Master's fader (its Gain effect), pan and mute.
- :func:`set_more` - the keys ``set`` takes beyond in / length / volume: ``speed``,
  ``motion`` (reverse, freeze), ``transition`` and ``transition_look`` (``setSpeed``,
  ``setMotion``, ``setTransition``, ``setTransitionLook``).

A change that cannot be done raises ValueError naming it (then no change of the list is
done). Clips are numbered from 1 on each track, markers from 1 in time order.
"""
from __future__ import annotations

import copy
import os

from . import timeline_io as T

#: A cut can only be this near a clip's end or a dissolve (MIN_CLIP, MIX_MARGIN in the JS).
MIN_CLIP = 0.1
MIX_MARGIN = 0.05
EPS = 1e-6
TRANSITION_LOOKS = ("dissolve", "dip", "wipe")


def _r(v):
    return round(float(v), 4)


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _fps(edit):
    fps = _f(edit.get("fps"), 24.0)
    return fps if fps > 0 else 24.0


def _to_frame(t, fps):
    return round(round(max(0.0, t) * fps) / fps, 4)


def _ends(edit):
    starts = T.v1_times(edit)
    return [(s, s + _f(c.get("length"))) for s, c in zip(starts, edit.get("clips") or [])]


def _film_end(edit):
    ends = _ends(edit)
    return ends[-1][1] if ends else 0.0


def _not_cuttable(c):
    """Why clip *c* cannot be cut in two here ("" = it can): what the JS's splitFx / shiftAfx
    would carry over is left to the panel."""
    if isinstance(c.get("compound"), dict):
        return "it is a compound clip"
    if T._loop(c)[0]:
        return "it loops (take its loop off first)"
    if T._ramp(c):
        return "it has a speed ramp"
    if isinstance(c.get("fx"), dict) and any((c["fx"].get("keys") or {}).values()):
        return "its Inspector settings are keyed"
    if any(isinstance(fx, dict) and any((fx.get("keys") or {}).values()) for fx in c.get("afx") or []):
        return "its sound effects are keyed"
    if c.get("link"):
        return "its sound is split off its picture (linked to a clip on a sound track)"
    return ""


def _tail(c, local):
    """The part of clip *c* from *local* seconds into it on (headCut)."""
    b = copy.deepcopy(c)
    b["in"] = _r(T.source_moment(c, local))
    b["length"] = _r(_f(c.get("length")) - local)
    b["transition"] = 0.0
    for k in ("gap", "uid", "link", "unlinked"):
        b.pop(k, None)
    return b


def _split_v1(edit, i, t, what):
    """V1's clip *i* cut in two at film moment *t* (splitClip): returns the index of the second half."""
    clips = edit["clips"]
    c = clips[i]
    start = T.v1_times(edit)[i]
    local = _r(t - start)
    own = _f(c.get("transition"))
    following = _f(clips[i + 1].get("transition")) if i + 1 < len(clips) else 0.0
    low = own + MIX_MARGIN if own > 0 else MIN_CLIP
    high = _f(c.get("length")) - (following + MIX_MARGIN if following > 0 else MIN_CLIP)
    if local < low - EPS or local > high + EPS:
        raise ValueError(f"{what}: {t}s is too near an end or inside a dissolve of {T._label(c)} on V1 to cut it there")
    why = _not_cuttable(c)
    if why:
        raise ValueError(f"{what}: {T._label(c)} cannot be cut in two at {t}s - {why}; cut it in the Edit panel (B)")
    clips.insert(i + 1, _tail(c, local))
    c["length"] = local
    return i + 1


def _new_clip(op, what, durations, want_picture=True):
    file = str(op.get("file") or "").strip()
    if not file:
        raise ValueError(f"{what}: no 'file'")
    if want_picture and T._media_kind(file) == "audio":
        raise ValueError(f"{what}: {os.path.basename(file)} is sound - V1 is the picture; put sound on A2.. with 'add'")
    start = T._num(op.get("in") or 0, f"{what}: 'in'")
    if op.get("length") is not None:
        length = T._num(op.get("length"), f"{what}: 'length'", MIN_CLIP)
    else:
        known = _f((durations or {}).get(T.norm_path(file)))
        if not known > start + MIN_CLIP:
            raise ValueError(f"{what}: how long {os.path.basename(file)} is, is not known - give 'length'")
        length = known - start
    clip = {"file": file, "name": str(op.get("name") or os.path.splitext(os.path.basename(file))[0])[:200],
            "in": _r(start), "length": _r(length), "transition": 0.0, "color": "", "volume": 1.0}
    if op.get("volume") is not None:
        clip["volume"] = _r(min(4.0, T._num(op.get("volume"), f"{what}: 'volume'")))
    return clip


def _v1_only(new, op, what):
    tid = str(op.get("track") or "V1").strip().upper()
    if tid != "V1":
        raise ValueError(f"{what}: insert and overwrite are edits of the cut itself (V1) - "
                         f"put a clip on {tid} with 'add' at its moment")
    if T._locked(new, "V1"):
        raise ValueError(f"{what}: track V1 is locked in the Edit panel - unlock it there")


def _follows(edit, tid):
    """Does track *tid* move with an insert (its Auto Track Selector on, not locked)?"""
    if tid == "T":
        return not (edit.get("lock") or {}).get("T") and (edit.get("auto") or {}).get("T") is not False
    k = T._find_track(edit, tid)
    return bool(k) and not k.get("lock") and k.get("auto") is not False


def op_insert(new, op, what, durations):
    """``{"op": "insert", "file", "at", "in", "length", "name", "volume"}`` (insertEdit)."""
    _v1_only(new, op, what)
    fresh = _new_clip(op, what, durations)
    t = _to_frame(T._num(op.get("at") or 0, f"{what}: 'at'"), _fps(new))
    clips = new.setdefault("clips", [])
    total = fresh["length"]
    index, lead = len(clips), 0.0
    if not clips:
        index, lead = 0, t
    elif t >= _film_end(new) - EPS:
        index, lead = len(clips), _r(max(0.0, t - _film_end(new)))
    else:
        ends = _ends(new)
        in_gap = next((g for g, c in enumerate(clips) if _f(c.get("gap")) > 0
                       and ends[g][0] - _f(c.get("gap")) - EPS <= t < ends[g][0] - EPS), -1)
        if in_gap >= 0:
            index, lead = in_gap, _r(t - (ends[in_gap][0] - _f(clips[in_gap].get("gap"))))
        else:
            under = [i for i, (s, e) in enumerate(ends) if s - EPS <= t < e - EPS]
            i = under[-1] if under else -1
            if i < 0:
                index = len(clips)
            elif abs(t - ends[i][0]) < EPS:
                index, lead = i, _f(clips[i].get("gap"))
            else:
                index = _split_v1(new, i, t, what)
    # Everything from the playhead on, on the other tracks, moves on with the cut (the bed stays).
    for k in new.get("tracks") or []:
        if isinstance(k, dict) and _follows(new, str(k.get("id") or "").upper()):
            for c in k.get("clips") or []:
                if _f(c.get("at")) >= t - EPS:
                    c["at"] = _r(_f(c.get("at")) + total)
    if _follows(new, "T"):
        for x in new.get("texts") or []:
            if _f(x.get("start")) >= t - EPS:
                x["start"] = _r(_f(x.get("start")) + total)
    if index < len(clips):
        after = clips[index]
        after["gap"] = _r(max(0.0, _f(after.get("gap")) - lead))
        after["transition"] = 0.0                       # its dissolve was from the clip before
    if lead > 0:
        fresh["gap"] = _r(lead)
    clips.insert(index, fresh)
    return f"inserted {fresh['name']} into V1 at {t}s for {total}s (what follows moved on {total}s)"


def op_overwrite(new, op, what, durations):
    """``{"op": "overwrite", "file", "at", "in", "length", "name", "volume"}`` (overwriteV1)."""
    _v1_only(new, op, what)
    mine = _new_clip(op, what, durations)
    a = _to_frame(T._num(op.get("at") or 0, f"{what}: 'at'"), _fps(new))
    b = _r(a + mine["length"])
    placed = []
    for c0, (s0, e0) in zip(new.get("clips") or [], _ends(new)):
        if e0 <= a + EPS or s0 >= b - EPS:
            placed.append((s0, False, copy.deepcopy(c0)))
            continue
        if s0 < a - EPS and a - s0 >= MIN_CLIP - EPS:          # its head stays, up to the clip
            head = copy.deepcopy(c0)
            head["length"] = _r(a - s0)
            placed.append((s0, False, head))
        if e0 > b + EPS and e0 - b >= MIN_CLIP - EPS:          # its tail stays, from the clip's end
            why = _not_cuttable(c0)
            if why:
                raise ValueError(f"{what}: {T._label(c0)} would be cut in two at {b}s - {why}; "
                                 "overwrite it in the Edit panel")
            placed.append((b, False, _tail(c0, b - s0)))
    placed.append((a, True, mine))
    placed.sort(key=lambda p: (p[0], 0 if p[1] else 1))
    out, end = [], 0.0
    for k, (s, _is_mine, c) in enumerate(placed):
        d = _r(s - end)
        c.pop("at", None)
        if d >= 0 or not k:
            c["transition"] = 0.0
            if d > 0:
                c["gap"] = max(0.0, d)
            else:
                c.pop("gap", None)
        else:
            c.pop("gap", None)
            c["transition"] = -d
        out.append(c)
        end = max(end, _r(s + _f(c.get("length"))))
    new["clips"] = out
    return f"laid {mine['name']} over V1 from {a}s to {b}s"


# ── markers ──────────────────────────────────────────────────────────────────

def _marker_fields(m, op, what):
    changed = []
    if op.get("at") is not None:
        m["t"] = _r(T._num(op.get("at"), f"{what}: 'at'"))
        changed.append(f"at {m['t']}s")
    if op.get("length") is not None:
        m["len"] = _r(T._num(op.get("length"), f"{what}: 'length'"))
        changed.append(f"length {m['len']}s")
    if op.get("name") is not None:
        m["name"] = str(op.get("name"))[:200]
        changed.append(f"name {m['name']!r}")
    if op.get("note") is not None:
        m["note"] = str(op.get("note"))[:2000]
        changed.append("note")
    if op.get("color") is not None:
        c = str(op.get("color") or "").lower()
        if c not in T.MARKER_COLORS:
            raise ValueError(f"{what}: 'color' is one of {', '.join(T.MARKER_COLORS)}")
        m["color"] = c
        changed.append(f"color {c}")
    return changed


def _marker(new, op, what):
    marks = sorted(new.get("markers") or [], key=lambda m: _f(m.get("t")))
    new["markers"] = marks
    try:
        n = int(op.get("marker"))
    except (TypeError, ValueError):
        raise ValueError(f"{what}: 'marker' is the marker's number (1, 2 ... in time order)") from None
    if not 1 <= n <= len(marks):
        raise ValueError(f"{what}: the cut has {len(marks)} marker(s), no marker {n}")
    return n, marks


def op_add_marker(new, op, what):
    """``{"op": "add_marker", "at", "length", "name", "note", "color"}``: a marker on the timeline."""
    if op.get("at") is None:
        raise ValueError(f"{what}: 'at' is the marker's moment (seconds of the film)")
    m = {"t": 0.0, "len": 0.0, "name": "", "note": "", "color": "blue"}
    _marker_fields(m, op, what)
    new["markers"] = sorted((new.get("markers") or []) + [m], key=lambda x: _f(x.get("t")))
    return f"marker at {m['t']}s" + (f" ({m['name']})" if m["name"] else "")


def op_set_marker(new, op, what):
    """``{"op": "set_marker", "marker": n, "at", "length", "name", "note", "color"}``."""
    n, marks = _marker(new, op, what)
    changed = _marker_fields(marks[n - 1], op, what)
    if not changed:
        raise ValueError(f"{what}: nothing to set (at, length, name, note, color)")
    new["markers"] = sorted(marks, key=lambda x: _f(x.get("t")))
    return f"marker {n}: " + ", ".join(changed)


def op_remove_marker(new, op, what):
    """``{"op": "remove_marker", "marker": n}``."""
    n, marks = _marker(new, op, what)
    gone = marks.pop(n - 1)
    return f"removed the marker at {gone.get('t')}s"


# ── the Mixer ────────────────────────────────────────────────────────────────

def _afx():
    from . import audio_fx
    return audio_fx


def _set_level(chain, kind, value, what):
    """*chain* with its fader (``gain``, dB) or ``pan`` at *value* (setMixerLevel)."""
    A = _afx()
    chain = A.clean_chain(chain)
    rest, lo, hi = A.AFX[kind][kind]
    x = max(lo, min(hi, float(value)))
    at = max((j for j, fx in enumerate(chain) if fx.get("type") == kind), default=-1)
    if at < 0:
        if abs(x - rest) < 1e-9:
            return chain
        if len(chain) >= A.MAX_AFX:
            raise ValueError(f"{what}: the track has as many effects as it can hold")
        fx = A.new_afx(kind)
        fx["p"][kind] = x
        return A.clean_chain(chain + [fx])
    if (chain[at].get("keys") or {}).get(kind):
        raise ValueError(f"{what}: the {'fader' if kind == 'gain' else 'pan'} is keyed - set it in the Mixer")
    if abs(x - rest) < 1e-9 and chain[at].get("on") is not False:
        return [fx for j, fx in enumerate(chain) if j != at]
    chain[at] = {**chain[at], "on": True, "p": {**(chain[at].get("p") or {}), kind: x}}
    return A.clean_chain(chain)


def op_mix(new, op, what):
    """``{"op": "mix", "track": "master" | "A1" | "A2" .., "gain_db", "pan", "mute"}``."""
    tid = str(op.get("track") or "").strip().upper()
    if tid in ("MASTER", "M"):
        tid = "master"
    afx = new.setdefault("afx", {})
    off = new.setdefault("off", {})
    if tid in ("master", "A1"):
        if tid == "A1" and T._locked(new, "A1"):
            raise ValueError(f"{what}: track A1 is locked in the Edit panel - unlock it there")
        get = lambda: afx.get(tid) or []                                   # noqa: E731
        put = lambda ch: afx.__setitem__(tid, ch)                         # noqa: E731
        mute = lambda v: off.__setitem__(tid, bool(v))                    # noqa: E731
    else:
        k = T._find_track(new, tid)
        if k is None or k.get("kind") != "audio":
            raise ValueError(f"{what}: 'track' is master, A1 or a sound track (A2 ..)"
                             + (f"; {tid} is a picture track" if k is not None else ""))
        if k.get("lock"):
            raise ValueError(f"{what}: track {tid} is locked in the Edit panel - unlock it there")
        get = lambda: k.get("afx") or []                                  # noqa: E731
        put = lambda ch: k.__setitem__("afx", ch)                         # noqa: E731
        mute = lambda v: k.__setitem__("off", bool(v))                    # noqa: E731
    changed = []
    if op.get("gain_db") is not None:
        db = _f(op.get("gain_db"), None)
        if db is None or not -60 <= db <= 24:
            raise ValueError(f"{what}: 'gain_db' is -60 .. 24 (0 = the track as it is)")
        put(_set_level(get(), "gain", db, what))
        changed.append(f"fader {round(db, 2)} dB")
    if op.get("pan") is not None:
        p = _f(op.get("pan"), None)
        if p is None or not -1 <= p <= 1:
            raise ValueError(f"{what}: 'pan' is -1 (left) .. 1 (right)")
        put(_set_level(get(), "pan", p, what))
        changed.append(f"pan {p}")
    if op.get("mute") is not None:
        mute(op.get("mute"))
        changed.append("muted" if op.get("mute") else "heard")
    if not changed:
        raise ValueError(f"{what}: nothing to set (gain_db, pan, mute)")
    return f"{'Master' if tid == 'master' else tid}: " + ", ".join(changed)


# ── set: speed, motion, transitions ──────────────────────────────────────────

def set_more(new, op, what, tid, clip, number):
    """The keys of ``set`` beyond in / length / volume / name / gap / at; returns what changed."""
    changed = []
    still = T._still_clip(clip)
    if op.get("speed") is not None:
        if still or isinstance(clip.get("compound"), dict) or T._motion(clip) == "freeze" or T._ramp(clip):
            raise ValueError(f"{what}: {T._label(clip)} has no speed to set (a still, a title, a compound clip, "
                             "a frozen one or one with a speed ramp)")
        s = max(T.MIN_SPEED, min(T.MAX_SPEED, T._num(op.get("speed"), f"{what}: 'speed'", T.MIN_SPEED)))
        was = T._speed(clip)
        clip["length"] = _r(_f(clip.get("length")) * was / s)       # its source kept: its length follows
        clip["speed"] = _r(s)
        changed.append(f"speed {clip['speed']} (length {clip['length']}s)")
    if op.get("motion") is not None:
        to = str(op.get("motion") or "").lower()
        to = "" if to in ("", "none", "forward", "forwards", "normal") else to
        if to not in ("reverse", "freeze", ""):
            raise ValueError(f"{what}: 'motion' is reverse, freeze or none")
        if still or isinstance(clip.get("compound"), dict):
            raise ValueError(f"{what}: {T._label(clip)} is a still, a title or a compound clip - it has no motion")
        frm = T._motion(clip)
        if frm != to:
            u = max(0.0, min(_f(clip.get("length")), _f(op.get("hold_at"))))
            held = T.source_moment(clip, u)
            if T._loop(clip)[0]:
                clip["in"] = _r(held if to == "freeze" else T.source_moment(clip, 0))
                clip.pop("loop", None)
                clip.pop("span", None)
            span = _f(clip.get("length")) * T._speed(clip)
            if to == "freeze":
                clip["in"] = _r(held)
                clip.pop("speed", None)
            elif to == "reverse":
                clip["in"] = _r(_f(clip.get("in")) + span)          # the same stretch, its last moment first
            elif frm == "reverse":
                clip["in"] = _r(max(0.0, _f(clip.get("in")) - span))
            clip["motion"] = to
        changed.append(f"motion {to or 'forwards'}")
    look = op.get("transition_look")
    if op.get("transition") is not None or look is not None:
        if tid != "V1" or number < 2:
            raise ValueError(f"{what}: a dissolve is between two clips of V1 - name V1's clip 2 or later "
                             "(the dissolve into it from the clip before)")
        clips = new.get("clips") or []
        if _f(clip.get("gap")) > 0:
            raise ValueError(f"{what}: {T._label(clip)} has empty time before it - no dissolve into a gap")
        if op.get("transition") is not None:
            sec = T._num(op.get("transition"), f"{what}: 'transition'")
            before = clips[number - 2]
            room = min(_f(clip.get("length")), _f(before.get("length"))) - MIN_CLIP
            if sec > room + EPS:
                raise ValueError(f"{what}: a {sec}s dissolve is longer than the shots on either side allow "
                                 f"(at most {round(max(0.0, room), 2)}s)")
            clip["transition"] = _r(sec)
            changed.append(f"dissolve {clip['transition']}s" if sec > 0 else "a cut (no dissolve)")
        if look is not None:
            kind = str((look.get("type") if isinstance(look, dict) else look) or "dissolve").lower()
            if kind not in TRANSITION_LOOKS:
                raise ValueError(f"{what}: 'transition_look' is dissolve, dip or wipe")
            given = look if isinstance(look, dict) else {}
            tfx = T.clean_tfx({"type": kind, "color": given.get("color"), "dir": given.get("dir")})
            if tfx:
                clip["tfx"] = tfx
            else:
                clip.pop("tfx", None)
            changed.append("transition " + (f"{tfx['type']} {tfx.get('color') or tfx.get('dir')}" if tfx else "cross dissolve"))
    return changed


OPS = {"insert": op_insert, "overwrite": op_overwrite}
MARKER_OPS = {"add_marker": op_add_marker, "set_marker": op_set_marker, "remove_marker": op_remove_marker,
              "mix": op_mix}
