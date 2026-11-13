"""Comp: tracking, in numpy - the Tracker's points and the PlanarTracker's surface, frame by frame.

Runs on the server (``/imageviewer/comp_track``, a job like the render's) over the full-size pictures of the
tracker's input. What it finds is written into the node as keys ([f, x, y, score] per point, [f, x1, y1 ... x4,
y4, score] for a surface), and the render reads those keys (comp_warp: ``track_at`` / ``quad_at``): tracking is
never repeated by a render.

The method is the textbook one, written here from scratch:
- a point: its pattern (the box round it at the frame the track starts) is looked for in a search box round
  where it is expected (last place + last step), by normalised cross-correlation (computed with FFTs and
  summed-area tables), refined to a fraction of a pixel by a parabola through the peak and its neighbours. When
  the best match falls below ``UPDATE`` the pattern is taken again from the new frame (it follows slow changes);
  below ``LOST`` the point stops.
- a surface: features with texture inside its four corners are matched from frame to frame and a projective map
  is fitted to them (least squares, outliers dropped in three rounds); that map, applied to the corners, predicts
  the new corners. Then each feature of the FIRST frame is looked for again, its pattern warped by the
  predicted map into the new frame's shape, and the map is fitted again from those - so the error does not add
  up from frame to frame.

No ComfyUI here.
"""
from __future__ import annotations

import math

import numpy as np

UPDATE = 0.8
LOST = 0.45
LUM = (0.2126, 0.7152, 0.0722)


def grey(img):
    """The picture's brightness (of its premultiplied rgb), float64 [H, W]."""
    d = np.asarray(img, np.float64)
    return d[..., 0] * LUM[0] + d[..., 1] * LUM[1] + d[..., 2] * LUM[2]


def sample(g, xs, ys):
    """g read bilinear at pixel coordinates (centres at +0.5), the edge repeated outside."""
    h, w = g.shape
    u = np.clip(np.asarray(xs, np.float64) - 0.5, 0, w - 1)
    v = np.clip(np.asarray(ys, np.float64) - 0.5, 0, h - 1)
    x0 = np.minimum(np.floor(u).astype(np.int64), w - 2) if w > 1 else np.zeros(np.shape(u), np.int64)
    y0 = np.minimum(np.floor(v).astype(np.int64), h - 2) if h > 1 else np.zeros(np.shape(v), np.int64)
    fx, fy = u - x0, v - y0
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    return (g[y0, x0] * (1 - fx) * (1 - fy) + g[y0, x1] * fx * (1 - fy) + g[y1, x0] * (1 - fx) * fy + g[y1, x1] * fx * fy)


def box(g, cx, cy, hw, hh):
    """The (2 hh + 1) x (2 hw + 1) pixels round (cx, cy), read bilinear."""
    ox = np.arange(-hw, hw + 1, dtype=np.float64)[None, :]
    oy = np.arange(-hh, hh + 1, dtype=np.float64)[:, None]
    return sample(g, cx + ox + 0 * oy, cy + oy + 0 * ox)


def _sums(a, ph, pw):
    """Sums over every ph x pw window of a (valid positions)."""
    s = np.zeros((a.shape[0] + 1, a.shape[1] + 1), np.float64)
    s[1:, 1:] = np.cumsum(np.cumsum(a, 0), 1)
    return s[ph:, pw:] - s[:-ph, pw:] - s[ph:, :-pw] + s[:-ph, :-pw]


def ncc(region, tpl):
    """Normalised cross-correlation of ``tpl`` at every place it fits in ``region``: [Hr - ph + 1, Wr - pw + 1]."""
    ph, pw = tpl.shape
    t = tpl - tpl.mean()
    tt = float((t * t).sum())
    Hr, Wr = region.shape
    if tt <= 1e-18 or Hr < ph or Wr < pw:
        return np.zeros((max(0, Hr - ph + 1), max(0, Wr - pw + 1)))
    fh, fw = Hr + ph, Wr + pw
    num = np.fft.irfft2(np.fft.rfft2(region, (fh, fw)) * np.conj(np.fft.rfft2(t, (fh, fw))), (fh, fw))[:Hr - ph + 1, :Wr - pw + 1]
    S = _sums(region, ph, pw)
    SS = _sums(region * region, ph, pw)
    var = np.maximum(SS - S * S / (ph * pw), 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / np.sqrt(var * tt)
    out[~np.isfinite(out) | (var < 1e-12 * ph * pw)] = 0
    return np.clip(out, -1, 1)


def _peak(c, i, j):
    """The fraction of a pixel to add to the peak at (i, j): a quadric fitted to the 3 x 3 round it (which follows a
    ridge's direction), else a parabola each way."""
    def one(a, b, d):
        den = a - 2 * b + d
        return 0.0 if abs(den) < 1e-12 else max(-0.5, min(0.5, 0.5 * (a - d) / den))
    if 0 < i < c.shape[0] - 1 and 0 < j < c.shape[1] - 1:
        w = c[i - 1:i + 2, j - 1:j + 2]
        gx = (w[:, 2] - w[:, 0]).sum() / 6
        gy = (w[2, :] - w[0, :]).sum() / 6
        hxx = (w[:, 0] - 2 * w[:, 1] + w[:, 2]).sum() / 3
        hyy = (w[0, :] - 2 * w[1, :] + w[2, :]).sum() / 3
        hxy = (w[2, 2] - w[2, 0] - w[0, 2] + w[0, 0]) / 4
        det = hxx * hyy - hxy * hxy
        if hxx < 0 and det > 1e-14:
            dx = -(hyy * gx - hxy * gy) / det
            dy = -(hxx * gy - hxy * gx) / det
            if abs(dx) <= 1 and abs(dy) <= 1:
                return dx, dy
    dy = one(c[i - 1, j], c[i, j], c[i + 1, j]) if 0 < i < c.shape[0] - 1 else 0.0
    dx = one(c[i, j - 1], c[i, j], c[i, j + 1]) if 0 < j < c.shape[1] - 1 else 0.0
    return dx, dy


def _best(g, tpl, cx, cy, sx, sy):
    ph, pw = tpl.shape
    region = box(g, cx, cy, pw // 2 + sx, ph // 2 + sy)
    c = ncc(region, tpl)
    if not c.size:
        return cx, cy, 0.0
    i, j = np.unravel_index(int(np.argmax(c)), c.shape)
    dx, dy = _peak(c, i, j)
    return cx + (j - sx) + dx, cy + (i - sy) + dy, float(c[i, j])


def find(g, tpl, cx, cy, sx, sy):
    """Where ``tpl`` (centred) is best found within (sx, sy) of (cx, cy) in g: (x, y, score). The peak is looked
    for again twice with the search centred on what was found, so the grid of whole pixels it is read on does not
    pull it."""
    x, y, s = _best(g, tpl, cx, cy, sx, sy)
    for _ in range(2):
        x2, y2, s2 = _best(g, tpl, x, y, 1, 1)
        if s2 < s - 1e-6:
            break
        moved = abs(x2 - x) + abs(y2 - y)
        x, y, s = x2, y2, max(s, s2)
        if moved < 0.01:
            break
    return x, y, s


def _half(v, lo=2, hi=200):
    return int(max(lo, min(hi, round(float(v) / 2))))


def track_points(get, frames, points, cancel=None, progress=None):
    """Track ``points`` ([{id, x, y, pattern: [w, h], search: [w, h]}], where they are at frames[0]) through
    ``frames`` (in order, either way). ``get(f)`` gives the picture at f. Returns {id: [[f, x, y, score], ...]}
    (frames[0] included, score 1); a point that is lost stops there. ``progress(i, keys)`` after each frame."""
    frames = list(frames)
    out = {}
    state = []
    if not frames:
        return out
    g0 = grey(get(frames[0]))
    for p in points:
        pw, ph = (p.get("pattern") or [21, 21])[:2]
        sw, sh = (p.get("search") or [61, 61])[:2]
        hw, hh = _half(pw), _half(ph)
        x, y = float(p["x"]), float(p["y"])
        out[p["id"]] = [[frames[0], x, y, 1.0]]
        state.append({"id": p["id"], "x": x, "y": y, "vx": 0.0, "vy": 0.0, "tpl": box(g0, x, y, hw, hh),
                      "sx": max(1, _half(sw) - hw), "sy": max(1, _half(sh) - hh), "on": True})
    if progress:
        progress(0, out)
    for k, f in enumerate(frames[1:], 1):
        if cancel and cancel():
            break
        if not any(s["on"] for s in state):
            break
        g = grey(get(f))
        for s in state:
            if not s["on"]:
                continue
            px, py = s["x"] + s["vx"], s["y"] + s["vy"]
            x, y, score = find(g, s["tpl"], px, py, s["sx"], s["sy"])
            if score < LOST:
                s["on"] = False
                continue
            s["vx"], s["vy"] = x - s["x"], y - s["y"]
            s["x"], s["y"] = x, y
            out[s["id"]].append([f, round(float(x), 3), round(float(y), 3), round(float(score), 3)])
            if score < UPDATE:
                th, tw = s["tpl"].shape
                s["tpl"] = box(g, x, y, tw // 2, th // 2)
        if progress:
            progress(k, out)
    return out


# ── a surface ────────────────────────────────────────────────────────────────

def fit_homography(P, Q):
    """The projective map taking points P to Q ([[x, y]], 4 or more), least squares on normalised points; None."""
    P, Q = np.asarray(P, np.float64), np.asarray(Q, np.float64)
    if len(P) < 4:
        return None

    def norm(a):
        c = a.mean(0)
        d = np.sqrt(((a - c) ** 2).sum(1)).mean() or 1.0
        k = math.sqrt(2) / d
        return np.array([[k, 0, -k * c[0]], [0, k, -k * c[1]], [0, 0, 1]])
    Tp, Tq = norm(P), norm(Q)
    p = (Tp @ np.c_[P, np.ones(len(P))].T).T
    q = (Tq @ np.c_[Q, np.ones(len(Q))].T).T
    rows = []
    for (x, y, _), (X, Y, _) in zip(p, q):
        rows.append([-x, -y, -1, 0, 0, 0, X * x, X * y, X])
        rows.append([0, 0, 0, -x, -y, -1, Y * x, Y * y, Y])
    try:
        _, sv, vt = np.linalg.svd(np.asarray(rows))
    except np.linalg.LinAlgError:
        return None
    Hn = vt[-1].reshape(3, 3)
    H = np.linalg.inv(Tq) @ Hn @ Tp
    if abs(H[2, 2]) < 1e-15:
        return None
    return H / H[2, 2]


def apply(H, pts):
    a = np.c_[np.asarray(pts, np.float64), np.ones(len(pts))] @ H.T
    return a[:, :2] / a[:, 2:3]


def robust_homography(P, Q, rounds=3):
    """fit_homography with the worst matches dropped: (H, inlier mask) or (None, None)."""
    P, Q = np.asarray(P, np.float64), np.asarray(Q, np.float64)
    keep = np.ones(len(P), bool)
    H = None
    for _ in range(rounds):
        if keep.sum() < 4:
            return None, None
        H = fit_homography(P[keep], Q[keep])
        if H is None:
            return None, None
        r = np.sqrt(((apply(H, P) - Q) ** 2).sum(1))
        lim = max(1.5, 3 * float(np.median(r[keep])))
        new = r <= lim
        if (new == keep).all():
            break
        keep = new
    return H, keep


def _inside_grid(quad, n=10):
    """Points spread over the four corners' surface (bilinear between them), away from its edges."""
    q = np.asarray(quad, np.float64)
    out = []
    for j in range(n):
        for i in range(n):
            u, v = (i + 0.5) / n, (j + 0.5) / n
            top = q[3] + (q[2] - q[3]) * u
            bot = q[0] + (q[1] - q[0]) * u
            out.append(top + (bot - top) * v)
    return np.asarray(out)


def _side(quad):
    q = np.asarray(quad, np.float64)
    return min(np.hypot(*(q[(k + 1) % 4] - q[k])) for k in range(4))


def warped_box(g, H_inv, cx, cy, hw, hh):
    """The pixels round (cx, cy) of a NEW frame as the reference g shows them: each read at H_inv of its place."""
    ox = np.arange(-hw, hw + 1, dtype=np.float64)
    oy = np.arange(-hh, hh + 1, dtype=np.float64)
    X, Y = np.meshgrid(cx + ox, cy + oy)
    src = apply(H_inv, np.c_[X.ravel(), Y.ravel()])
    return sample(g, src[:, 0], src[:, 1]).reshape(X.shape)


def track_plane(get, frames, quad, cancel=None, progress=None, features=48):
    """Track a surface whose corners are ``quad`` ([[x, y]] x 4: bottom left, bottom right, top right, top left) at
    frames[0] through ``frames``. Returns [[f, x1, y1, ..., x4, y4, share of features that agreed], ...]; it stops
    where too few features are found."""
    frames = list(frames)
    if not frames:
        return []
    q_ref = np.asarray(quad, np.float64)
    out = [[frames[0]] + [round(float(v), 3) for v in q_ref.ravel()] + [1.0]]
    side = _side(q_ref)
    hp = int(max(4, min(16, round(side / 16))))
    sr = int(max(6, min(48, round(side / 8))))
    g_ref = grey(get(frames[0]))
    cand = _inside_grid(q_ref, 10)
    tex = np.array([box(g_ref, x, y, hp, hp).std() for x, y in cand])
    order = np.argsort(-tex)
    ref_pts = cand[order[:features]][tex[order[:features]] > 1e-4 * max(1e-9, float(np.abs(g_ref).max()))]
    if progress:
        progress(0, out)
    if len(ref_pts) < 6:
        return out
    g_prev, q_prev = g_ref, q_ref
    H_step = np.eye(3)
    for k, f in enumerate(frames[1:], 1):
        if cancel and cancel():
            break
        g = grey(get(f))
        # 1. frame to frame: features inside the corners as they were, the last step as the guess
        prev_pts = _inside_grid(q_prev, 8)
        guess = apply(H_step, prev_pts)
        P, Q = [], []
        for (x, y), (gx, gy) in zip(prev_pts, guess):
            tpl = box(g_prev, x, y, hp, hp)
            if tpl.std() < 1e-6:
                continue
            X, Y, s = find(g, tpl, gx, gy, sr, sr)
            if s > 0.6:
                P.append([x, y])
                Q.append([X, Y])
        H1, keep = robust_homography(P, Q) if len(P) >= 6 else (None, None)
        if H1 is None:
            break
        q_guess = apply(H1, q_prev)
        # 2. against the first frame: its features, their patterns warped into this frame's shape
        Hr = fit_homography(q_ref, q_guess)
        if Hr is None:
            break
        Hr_inv = np.linalg.inv(Hr)
        at = apply(Hr, ref_pts)
        P2, Q2 = [], []
        for (rx, ry), (x, y) in zip(ref_pts, at):
            tpl = warped_box(g_ref, Hr_inv, x, y, hp, hp)
            if tpl.std() < 1e-6:
                continue
            X, Y, s = find(g, tpl, x, y, max(3, hp // 2), max(3, hp // 2))
            if s > 0.6:
                P2.append([rx, ry])
                Q2.append([X, Y])
        H2, keep2 = robust_homography(P2, Q2) if len(P2) >= 6 else (None, None)
        share = float(keep2.sum()) / len(ref_pts) if H2 is not None else float(keep.sum()) / max(1, len(P))
        q_now = apply(H2, q_ref) if H2 is not None else q_guess
        out.append([f] + [round(float(v), 3) for v in q_now.ravel()] + [round(share, 3)])
        H_step = fit_homography(q_prev, q_now)
        if H_step is None:
            H_step = np.eye(3)
        g_prev, q_prev = g, q_now
        if progress:
            progress(k, out)
    return out
