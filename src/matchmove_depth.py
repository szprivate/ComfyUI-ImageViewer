"""A phone's depth (an iPhone Cinematic film's depth track) for the TRACK itself, not only the ground.

Two uses (Sebastian 2026-11-20: "use the iPhone's depth information to improve the track"):

- ``depth_edges``: tracks that sit on a depth edge (a corner of something near against something far: the feature
  is where two surfaces meet in the picture, not a point of either, and slides as the camera moves) or whose depth
  jumps from frame to frame against the other tracks (something moving, a reflection). Found before the solve.
- ``depth_pull`` (called by ``matchmove_solve.solve``): after the free solve, rounds of a bundle adjustment that
  pulls each point towards the depth the phone saw it at, on every key frame. The phone's depth has no units and
  may be scaled differently on every frame, so each frame's scale is fitted to the solve (the median ratio) and
  only the PROPORTIONS in depth pull - what a free solve gets wrong when its focal length is a little off (a
  squashed or stretched solve). Samples that disagree a lot (edges, moving things, the depth's own errors) are
  left out of the pull. The answer says how well the depth and the solve agree, before and after.

The depth picture's value is read two ways (``READINGS``): disparity (bright = near, depth = 1 / value) or depth
(value grows with distance). Disparity is what is reported of the iPhone's Cinematic films and is the default;
it cannot be told from the solve, whose depth may itself be inside out.

Pure numpy: the maps come in as {frame: float32 [h, w] as stored (0..1)}, the plate's tracks as
``matchmove.clean_tracks`` gives them (keys in the plate's own pixels).
"""

from __future__ import annotations

import math

import numpy as np

READINGS = ("disparity", "depth")
DEFAULT_READING = "disparity"   # as reported of iPhone Cinematic films: bright = near
EDGE_TOL = 0.15          # a 5 x 5 window's spread (p90 - p10) over its median that counts as a depth edge
EDGE_SHARE = 0.3         # share of a track's sampled frames on an edge that marks it
JUMP_TOL = 0.25          # a step's depth change off the frame's median change (log) that counts as a jump
JUMP_SHARE = 0.2         # share of a track's steps that jump that marks it
DEPTH_ROUNDS = (0.3, 1.0, 2.0, 2.0)    # the pull's strength each round, times the asked strength
MIN_ORDER = 0.3         # the rank correlation of the phone's depth with the solve's below which it is not used
DEPTH_MIN_TRACKS = 8     # tracks a frame needs to have its scale fitted
MIN_VALUE = 1.0 / 255    # below this the picture says nothing (no depth there)
MAX_FRAMES = 160         # frames sampled for the edge clean-up


def sample_frames(frames, most=MAX_FRAMES):
    """At most *most* of *frames*, spread evenly (both ends kept)."""
    frames = sorted(int(f) for f in frames)
    if len(frames) <= most:
        return frames
    step = (len(frames) - 1) / (most - 1)
    return sorted({frames[int(round(i * step))] for i in range(most)})


def _window(img, x, y, r):
    h, w = img.shape
    xi, yi = int(round(x)), int(round(y))
    if not (0 <= xi < w and 0 <= yi < h):
        return None
    return img[max(0, yi - r):yi + r + 1, max(0, xi - r):xi + r + 1]


def track_samples(maps, tracks, w, h):
    """{track index: {frame: (value, edge)}}: each track's depth picture value (the 3 x 3 median at its plate
    pixel, the map scaled to the plate) and how much of an edge it sits on (the 5 x 5 spread over the median)."""
    out = {}
    for f, img in maps.items():
        img = np.asarray(img, np.float32)
        mh, mw = img.shape[:2]
        kx, ky = mw / float(w), mh / float(h)
        for ti, t in enumerate(tracks):
            k = _key_at(t, f)
            if k is None:
                continue
            x, y = (k[1] + 0.5) * kx - 0.5, (k[2] + 0.5) * ky - 0.5
            a = _window(img, x, y, 1)
            if a is None or not a.size:
                continue
            v = float(np.median(a))
            if not v > MIN_VALUE:
                continue
            b = _window(img, x, y, 2)
            lo, hi = np.percentile(b, (10, 90))
            out.setdefault(ti, {})[int(f)] = (v, float((hi - lo) / v))
    return out


def _key_at(track, f):
    keys = track["keys"]
    lo, hi = 0, len(keys) - 1
    while lo <= hi:
        m = (lo + hi) // 2
        if keys[m][0] == f:
            return keys[m]
        if keys[m][0] < f:
            lo = m + 1
        else:
            hi = m - 1
    return None


def to_depth(v, reading):
    """The stored value as a depth up to a scale: 1 / v for disparity, v for depth; None where it says nothing."""
    if not v > MIN_VALUE:
        return None
    return 1.0 / v if reading == "disparity" else float(v)


def depth_edges(maps, tracks, w, h, *, edge_tol=EDGE_TOL, edge_share=EDGE_SHARE, jump_tol=JUMP_TOL,
                jump_share=JUMP_SHARE):
    """The tracks the phone's depth says not to trust: [{id, why: edge | jumps, edge_share, jump_share, frames}],
    worst first. A track is on a depth EDGE when its window's spread is over *edge_tol* on at least *edge_share*
    of its sampled frames; it JUMPS when its depth changes from one sampled frame to the next by more than
    *jump_tol* (log) off what the frame's other tracks do, on at least *jump_share* of its steps (and twice)."""
    samples = track_samples(maps, tracks, w, h)
    frames = sorted(maps)
    # the frame-to-frame change of the depth the tracks see (the camera moving): the median log ratio per step
    step_of = {a: b for a, b in zip(frames, frames[1:])}
    med = {}
    for a, b in step_of.items():
        rs = [math.log(s[b][0] / s[a][0]) for s in samples.values() if a in s and b in s]
        if len(rs) >= DEPTH_MIN_TRACKS:
            med[a] = float(np.median(rs))
    out = []
    for ti, s in samples.items():
        n = len(s)
        if n < 2:
            continue
        edges = sum(1 for v, e in s.values() if e > edge_tol)
        steps = [(a, step_of[a]) for a in s if a in step_of and step_of[a] in s and a in med]
        jumps = sum(1 for a, b in steps if abs(math.log(s[b][0] / s[a][0]) - med[a]) > jump_tol)
        es = edges / n
        js = jumps / len(steps) if steps else 0.0
        why = "edge" if es >= edge_share else "jumps" if (jumps >= 2 and js >= jump_share) else None
        if why:
            out.append({"id": tracks[ti]["id"], "why": why, "edge_share": round(es, 3), "jump_share": round(js, 3),
                        "frames": n})
    out.sort(key=lambda r: -(r["edge_share"] + r["jump_share"]))
    return {"tracks": out, "frames": len(frames), "sampled_tracks": len(samples)}


# ── the pull in the solve ────────────────────────────────────────────────────

def _frame_fits(poses, pts, samples, reading):
    """Per key frame: (scale, [(track index, solve depth, phone depth)]) where enough tracks are seen. A sample on a
    depth edge (its window spreads over EDGE_TOL) is left out: the picture there is part near, part far - a small
    thing in front of a far one, at a depth picture's coarse size - and says neither."""
    out = {}
    for fr, (R, t) in poses.items():
        rows = []
        for ti, X in pts.items():
            s = samples.get(ti)
            if not s or fr not in s or s[fr][1] > EDGE_TOL:
                continue
            zp = to_depth(s[fr][0], reading)
            zs = float((R @ X + t)[2])
            if zp is None or not zs > 1e-9:
                continue
            rows.append((ti, zs, zp))
        if len(rows) < DEPTH_MIN_TRACKS:
            continue
        scale = float(np.median([zs / zp for _, zs, zp in rows]))
        out[fr] = (scale, rows)
    return out


def _rank(a):
    r = np.empty(len(a))
    r[np.argsort(a, kind="stable")] = np.arange(len(a))
    return r


def order_agreement(poses, pts, samples, reading):
    """Whether the phone's depth puts the tracks in the same near-to-far ORDER as the solve: the median over the
    key frames of the rank correlation (1 the same order, -1 the reverse), or None. A solve squashed or
    stretched by a focal length a little off keeps the order, so this is what tells the reading."""
    rs = []
    for s, rows in _frame_fits(poses, pts, samples, reading).values():
        zs = np.asarray([r[1] for r in rows])
        zp = np.asarray([r[2] for r in rows])
        a, b = _rank(zs), _rank(zp)
        sa, sb = a.std(), b.std()
        if sa > 0 and sb > 0:
            rs.append(float(((a - a.mean()) * (b - b.mean())).mean() / (sa * sb)))
    return float(np.median(rs)) if rs else None


def agreement(poses, pts, samples, reading):
    """How far the solve's depths are from the phone's (each frame scaled onto the solve): the median of
    |log(solve / phone)| over every sample, or None (too few)."""
    fits = _frame_fits(poses, pts, samples, reading)
    devs = [abs(math.log(zs / (s * zp))) for s, rows in fits.values() for _, zs, zp in rows]
    return (float(np.median(devs)), len(fits), len(devs)) if devs else (None, 0, 0)


def _spread(devs):
    """(cut, sigma): the deviation over which a sample is left out of the pull (the median and 3 x the robust
    spread, at least 2 %), and how far the phone's depth is off as a share (at least 1 %)."""
    d = np.asarray(devs)
    med = float(np.median(d))
    mad = float(np.median(np.abs(d - med))) * 1.4826
    return max(math.log(1.02), med + 3 * mad), max(0.01, med * 1.4826)


def restart_from_depth(obs, res, c, samples, reading, resect):
    """New key frames and points from the phone's depth: the first key frame's points put out along their rays to
    the depth seen there, then frame by frame each key camera found from the points it sees (``resect``) and the
    points it sees first put out from it at its own fitted scale. For a solve whose depth came out inside out (a
    trap of shots with little camera movement, which the phone's depth shows). -> (poses, pts) or None."""
    f = res["f"]
    keys = sorted(res["poses"])
    # start on the key frame the depth covers best (an AI depth run has only some of them)
    seen_on = {k: sum(1 for ti in obs.by_frame.get(k, {}) if k in samples.get(ti, {})) for k in keys}
    fix = max(keys, key=lambda k: seen_on[k])
    order = [fix] + [k for k in sorted(keys, key=lambda k: abs(k - fix)) if k != fix]
    poses = {fix: res["poses"][fix]}
    pts = {}
    old_med = float(np.median([(poses[fix][0] @ X + poses[fix][1])[2] for X in res["pts"].values()])) or 1.0

    def put_out(fr, scale):
        R, t = poses[fr]
        for ti, uv in obs.by_frame.get(fr, {}).items():
            if ti in pts or ti not in res["pts"]:
                continue
            sm = samples.get(ti, {}).get(fr)
            zp = to_depth(sm[0], reading) if sm else None
            if zp is None:
                continue
            ray = np.array([(uv[0] - c[0]) / f, (uv[1] - c[1]) / f, 1.0])
            pts[ti] = R.T @ (ray * zp * scale - t)

    zs0 = [to_depth(samples[ti][fix][0], reading) for ti in obs.by_frame.get(fix, {})
           if ti in samples and fix in samples[ti]]
    zs0 = [z for z in zs0 if z is not None]
    if len(zs0) < DEPTH_MIN_TRACKS:
        return None
    put_out(fix, old_med / float(np.median(zs0)))
    for fr in order[1:]:
        seen = [ti for ti in obs.by_frame.get(fr, {}) if ti in pts]
        if len(seen) < 6:
            continue
        X = np.stack([pts[ti] for ti in seen])
        uv = np.stack([obs.by_frame[fr][ti] for ti in seen])
        near = min(poses, key=lambda k: abs(k - fr))
        got = resect(X, uv, f, c, guess=poses[near])
        if got is None:
            continue
        poses[fr] = (got[0], got[1])
        ratios = []
        for ti in seen:
            sm = samples.get(ti, {}).get(fr)
            zp = to_depth(sm[0], reading) if sm else None
            z = float((got[0] @ pts[ti] + got[1])[2])
            if zp and z > 1e-9:
                ratios.append(z / zp)
        if len(ratios) >= DEPTH_MIN_TRACKS:
            put_out(fr, float(np.median(ratios)))
    if len(poses) < max(3, len(keys) // 2) or len(pts) < 12:
        return None
    return poses, pts, fix


def depth_pull(obs, res, c, samples, key_ba, *, strength=1.0, reading=None, refine_f=False, cancel=None,
               resect=None):
    """Pull the key frames' points to the depths the phone saw them at (``res`` changed in place, as
    ``_constrain`` does). *samples* {track index: {frame: (value, edge)}} (``track_samples``), *key_ba* the
    solve's ``_key_ba``. -> the report {reading, agreement_before, agreement (median relative difference, a share),
    frames, samples, used, strength} or {error}."""
    poses, pts = res["poses"], res["pts"]
    reading = reading if reading in READINGS else DEFAULT_READING
    # samples on a depth edge say neither depth (part near, part far at the picture's coarse size): left out
    samples = {ti: kept for ti, s in samples.items() if (kept := {fr: v for fr, v in s.items() if v[1] <= EDGE_TOL})}
    order = order_agreement(poses, pts, samples, reading)
    if order is None:
        return {"error": f"the depth covers fewer than {DEPTH_MIN_TRACKS} solved tracks on every key frame"}
    turned = False
    if order < MIN_ORDER and resect is not None:
        # The solve and the phone disagree on what is near and what is far: a solve with its depth inside out
        # (a shot with little camera movement allows both). Start again from the phone's depth and keep it when
        # it fits the tracks about as well.
        got = restart_from_depth(obs, res, c, samples, reading, resect)
        if got is not None:
            p2, x2, fix2 = got
            f2, rms2 = key_ba(obs, p2, x2, res["f"], c, fix2, refine_f, iters=25)
            o2 = order_agreement(p2, x2, samples, reading)
            if o2 is not None and o2 >= MIN_ORDER and rms2 <= res["rms"] * 1.5 + 0.3:
                res["poses"], res["pts"], res["f"], res["rms"] = p2, x2, f2, rms2
                res["pair"] = (fix2, None)
                poses, pts = p2, x2
                turned = True
                order_before, order = order, o2
    if order < MIN_ORDER:
        return {"error": f"the depth does not order the tracks near to far as the solve does (rank "
                         f"correlation {order:.2f}): it may be read the wrong way (reading), not belong to this "
                         "plate, or be turned", "order": round(order, 3), "reading": reading}
    before, nf, ns = agreement(poses, pts, samples, reading)
    fix = res["pair"][0] if res.get("pair") else min(poses)
    f = res["f"]
    used = 0
    for k in DEPTH_ROUNDS:
        if cancel and cancel():
            break
        fits = _frame_fits(poses, pts, samples, reading)
        devs = [abs(math.log(zs / (s * zp))) for s, rows in fits.values() for _, zs, zp in rows]
        if not devs:
            break
        cut, sigma = _spread(devs)
        acc, cnt = {}, {}
        for fr, (s, rows) in fits.items():
            R, t = poses[fr]
            C = -R.T @ t
            for ti, zs, zp in rows:
                if abs(math.log(zs / (s * zp))) > cut:
                    continue
                X = pts[ti]
                acc[ti] = acc.get(ti, 0) + C + (X - C) * (s * zp / zs)
                cnt[ti] = cnt.get(ti, 0) + 1
        if not acc:
            break
        R0, t0 = poses[fix]
        priors = {}
        for ti, a in acc.items():
            z = float((R0 @ pts[ti] + t0)[2])
            if not z > 1e-9:
                z = float(np.median([(R0 @ q + t0)[2] for q in pts.values()])) or 1.0
            # in pixels of cost per unit away, as the measurements' pull: 1 / (the depth's own error there) - a
            # noisy depth pulls less - and a point seen on more frames a little harder (each one more say)
            priors[ti] = (a / cnt[ti], float(strength) * k / (sigma * z) * min(2.0, math.sqrt(cnt[ti] / 4.0)))
        used = len(priors)
        f, rms = key_ba(obs, poses, pts, f, c, fix, refine_f, priors=priors, iters=15)
        res["f"], res["rms"] = f, rms
    after, nf, ns = agreement(poses, pts, samples, reading)
    rel = lambda x: round(math.exp(x) - 1, 4) if x is not None else None  # noqa: E731
    out_turn = {"turned": True, "order_before": round(order_before, 3)} if turned else {}
    return {**out_turn, "reading": reading, "order": round(order, 3), "agreement_before": rel(before), "agreement": rel(after), "frames": nf,
            "samples": ns, "used": used, "strength": float(strength)}
