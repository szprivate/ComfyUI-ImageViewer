"""Comp: the nodes that move pixels by a map, in numpy - the twin of ``js/imageViewer_compWarp.js``.

CornerPin, STMap, VectorWarp, LensDistortion, GridWarp, and the arithmetic the Tracker and PlanarTracker
render with. Float for float the page's (tests/test_comp_parity.py): float64 throughout, the same order of
operations and the same fixed iteration counts. Written from the textbook maths (a projective map from four
point pairs, a radial lens polynomial, a thin-plate spline, a least-squares similarity).

Coordinates are pixels, y down, a pixel's centre at i + 0.5. A map is two float64 [H, W] arrays: the place in
the source each output pixel reads (NaN: nothing). Sampling is ``comp_model.resample``'s: bilinear at pixel
centres, transparent outside.

No ComfyUI, aiohttp or torch here; it imports only numpy, so comp_model.py can load it by its path.
"""
from __future__ import annotations

import math

import numpy as np

LENS_MODES = ["undistort", "redistort"]
LENS_OUTPUTS = ["image", "stmap"]
TRACK_MOTIONS = ["translate", "rotate", "scale", "perspective"]
TRACK_TRANSFORMS = ["none", "stabilise", "match-move"]
_NEWTON = 12


def sample_map(src, U, V, w, h):
    """The source read at U, V (pixel coordinates, centres at +0.5) for each pixel of a w x h output."""
    sh, sw = src.shape[:2]
    u = U - 0.5
    v = V - 0.5
    nan = np.isnan(u) | np.isnan(v)
    u = np.where(nan, -10.0, u)
    v = np.where(nan, -10.0, v)
    x0 = np.floor(u).astype(np.int64)
    y0 = np.floor(v).astype(np.int64)
    fx = (u - x0)[..., None]
    fy = (v - y0)[..., None]
    out = np.zeros((h, w, 4), np.float64)
    srcd = src.astype(np.float64)
    inside = ~nan & (x0 >= -1) & (y0 >= -1) & (x0 < sw) & (y0 < sh)
    for dy in (0, 1):
        for dx in (0, 1):
            xx, yy = x0 + dx, y0 + dy
            ok = inside & (xx >= 0) & (yy >= 0) & (xx < sw) & (yy < sh)
            wgt = (fx if dx else 1 - fx) * (fy if dy else 1 - fy)
            vals = srcd[np.clip(yy, 0, sh - 1), np.clip(xx, 0, sw - 1)]
            out += np.where(ok[..., None], vals * wgt, 0)
    return out.astype(np.float32)


def map_as_st(U, V, w, h, sw, sh):
    """The map as an ST map picture: (x / sw, 1 - y / sh, 0, 1); transparent where it reads nothing."""
    out = np.zeros((h, w, 4), np.float32)
    ok = ~(np.isnan(U) | np.isnan(V))
    out[..., 0] = np.where(ok, U / sw, 0)
    out[..., 1] = np.where(ok, 1 - V / sh, 0)
    out[..., 3] = np.where(ok, 1, 0)
    return out


# ── a projective map from four point pairs ───────────────────────────────────

def solve(A, b):
    """A x = b for a small square A (lists, changed in place), the page's elimination; None when singular."""
    n = len(b)
    scale = 0.0
    for i in range(n):
        for j in range(n):
            scale = max(scale, abs(A[i][j]))
    tiny = (scale or 1) * 1e-12
    for c in range(n):
        p = c
        for r in range(c + 1, n):
            if abs(A[r][c]) > abs(A[p][c]):
                p = r
        if abs(A[p][c]) <= tiny:
            return None
        if p != c:
            A[p], A[c] = A[c], A[p]
            b[p], b[c] = b[c], b[p]
        for r in range(c + 1, n):
            f = A[r][c] / A[c][c]
            if not f:
                continue
            for j in range(c, n):
                A[r][j] -= f * A[c][j]
            b[r] -= f * b[c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = b[r]
        for j in range(r + 1, n):
            s -= A[r][j] * x[j]
        x[r] = s / A[r][r]
    return x


def homography(frm, to):
    """The 3 x 3 map (row major, h[8] = 1) taking the four points ``frm`` to ``to``; None if they make none."""
    A, b = [], []
    for k in range(4):
        x, y, X, Y = float(frm[k][0]), float(frm[k][1]), float(to[k][0]), float(to[k][1])
        A.append([x, y, 1.0, 0.0, 0.0, 0.0, -X * x, -X * y])
        b.append(X)
        A.append([0.0, 0.0, 0.0, x, y, 1.0, -Y * x, -Y * y])
        b.append(Y)
    h = solve(A, b)
    return h + [1.0] if h else None


def apply_h(H, x, y):
    w = H[6] * x + H[7] * y + H[8]
    if not w > 1e-12:
        return None
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]


def homography_map(Hs, w, h, scale):
    px = (np.arange(w, dtype=np.float64) + 0.5) / scale
    py = ((np.arange(h, dtype=np.float64) + 0.5) / scale)[:, None]
    q = Hs[6] * px + Hs[7] * py + Hs[8]
    ok = q > 1e-12
    qs = np.where(ok, q, 1.0)
    U = np.where(ok, ((Hs[0] * px + Hs[1] * py + Hs[2]) / qs) * scale, np.nan)
    V = np.where(ok, ((Hs[3] * px + Hs[4] * py + Hs[5]) / qs) * scale, np.nan)
    return U, V


def homography_image(src, inv, scale):
    h, w = src.shape[:2]
    if not inv:
        return np.zeros((h, w, 4), np.float32)
    U, V = homography_map(inv, w, h, scale)
    return sample_map(src, U, V, w, h)


def pin_corners(get, fmt):
    """A CornerPin's corners in its input's pixels: 1 bottom left, 2 bottom right, 3 top right, 4 top left."""
    W, H = fmt["width"], fmt["height"]
    d = [[0, H], [W, H], [W, 0], [0, 0]]
    frm = [get(f"from{k + 1}") or d[k] for k in range(4)]
    to = [get(f"to{k + 1}") or frm[k] for k in range(4)]
    return frm, to


# ── ST map and vectors ───────────────────────────────────────────────────────

def st_map(us, vs, sw, sh):
    return us.astype(np.float64) * sw, (1 - vs.astype(np.float64)) * sh


def vector_map(us, vs, w, h, amount, scale):
    x = np.arange(w, dtype=np.float64)[None, :]
    y = np.arange(h, dtype=np.float64)[:, None]
    U = x + 0.5 + amount * us.astype(np.float64) * scale
    V = y + 0.5 + amount * vs.astype(np.float64) * scale
    return U, V


# ── lens distortion ──────────────────────────────────────────────────────────

def distort_r(r, k1, k2):
    r2 = r * r
    return r * (1 + k1 * r2 + k2 * r2 * r2)


def undistort_r(rd, k1, k2):
    """Newton's method, the page's fixed steps; an element stops where the slope is flat, as the page's loop does."""
    r = np.array(rd, np.float64, copy=True)
    alive = np.ones(r.shape, bool)
    for _ in range(_NEWTON):
        r2 = r * r
        f = r * (1 + k1 * r2 + k2 * r2 * r2) - rd
        d = 1 + 3 * k1 * r2 + 5 * k2 * r2 * r2
        alive &= ~(np.abs(d) < 1e-9)
        r = np.where(alive, r - f / np.where(alive, d, 1.0), r)
    return r


def lens_points(x, y, how, k1, k2, cx, cy, R):
    dx = (x - cx) / R
    dy = (y - cy) / R
    r = np.sqrt(dx * dx + dy * dy)
    tiny = r < 1e-12
    rs = np.where(tiny, 1.0, r)
    q = (distort_r(rs, k1, k2) if how == "distort" else undistort_r(rs, k1, k2)) / rs
    return np.where(tiny, x, cx + dx * q * R), np.where(tiny, y, cy + dy * q * R)


def lens_map(w, h, p, scale):
    c = p.get("center")
    cx = (c[0] if c else w / scale / 2) * scale
    cy = (c[1] if c else h / scale / 2) * scale
    R = math.sqrt(w * w + h * h) / 2
    zoom = p.get("zoom") or 1
    ox = np.broadcast_to(np.arange(w, dtype=np.float64)[None, :] + 0.5, (h, w))
    oy = np.broadcast_to(np.arange(h, dtype=np.float64)[:, None] + 0.5, (h, w))
    k1, k2 = float(p.get("k1") or 0), float(p.get("k2") or 0)
    if p.get("mode") == "redistort":
        qx, qy = lens_points(ox, oy, "undistort", k1, k2, cx, cy, R)
        return cx + (qx - cx) * zoom, cy + (qy - cy) * zoom
    return lens_points(cx + (ox - cx) / zoom, cy + (oy - cy) / zoom, "distort", k1, k2, cx, cy, R)


# ── grid warp ────────────────────────────────────────────────────────────────

def lattice(cols, rows, w, h):
    out = []
    for j in range(rows):
        for i in range(cols):
            out += [i / (cols - 1) * w, j / (rows - 1) * h]
    return out


def _phi(r2):
    return np.where(r2 > 0, 0.5 * r2 * np.log(np.where(r2 > 0, r2, 1.0)), 0.0)


def tps_solve(qx, qy, dx, dy):
    n = len(qx)
    m = n + 3
    A = np.zeros((m, m), np.float64)
    qx, qy = np.asarray(qx, np.float64), np.asarray(qy, np.float64)
    ex = qx[:, None] - qx[None, :]
    ey = qy[:, None] - qy[None, :]
    A[:n, :n] = _phi(ex * ex + ey * ey)
    A[:n, n] = 1
    A[:n, n + 1] = qx
    A[:n, n + 2] = qy
    A[n, :n] = 1
    A[n + 1, :n] = qx
    A[n + 2, :n] = qy
    try:
        wx = np.linalg.solve(A, np.r_[np.asarray(dx, np.float64), 0, 0, 0])
        wy = np.linalg.solve(A, np.r_[np.asarray(dy, np.float64), 0, 0, 0])
    except np.linalg.LinAlgError:
        return None
    return wx, wy


def grid_map(src, dst, w, h, scale):
    n = min(len(src), len(dst)) // 2
    U = np.broadcast_to(np.arange(w, dtype=np.float64)[None, :] + 0.5, (h, w)).copy()
    V = np.broadcast_to(np.arange(h, dtype=np.float64)[:, None] + 0.5, (h, w)).copy()
    if not n or all(src[k] == dst[k] for k in range(2 * n)):
        return U, V
    L = max(w, h) / scale
    qx = [dst[2 * k] / L for k in range(n)]
    qy = [dst[2 * k + 1] / L for k in range(n)]
    dx = [(src[2 * k] - dst[2 * k]) / L for k in range(n)]
    dy = [(src[2 * k + 1] - dst[2 * k + 1]) / L for k in range(n)]
    coef = tps_solve(qx, qy, dx, dy)
    if coef is None:
        return U, V
    wx, wy = coef
    px = (np.arange(w, dtype=np.float64)[None, :] + 0.5) / scale / L
    py = (np.arange(h, dtype=np.float64)[:, None] + 0.5) / scale / L
    sx = wx[n] + wx[n + 1] * px + wx[n + 2] * py
    sy = wy[n] + wy[n + 1] * px + wy[n + 2] * py
    for k in range(n):
        ex = px - qx[k]
        ey = py - qy[k]
        phi = _phi(ex * ex + ey * ey)
        sx = sx + wx[k] * phi
        sy = sy + wy[k] * phi
    return U + sx * L * scale, V + sy * L * scale


# ── trackers ─────────────────────────────────────────────────────────────────

def track_at(keys, f):
    if not isinstance(keys, list) or not keys:
        return None
    if f <= keys[0][0]:
        return [keys[0][1], keys[0][2]]
    if f >= keys[-1][0]:
        return [keys[-1][1], keys[-1][2]]
    i = 0
    while i < len(keys) - 1 and keys[i + 1][0] <= f:
        i += 1
    a, b = keys[i], keys[i + 1]
    if a[0] == f:
        return [a[1], a[2]]
    t = (f - a[0]) / (b[0] - a[0])
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]


def track_has(keys, f):
    return isinstance(keys, list) and bool(keys) and keys[0][0] <= f <= keys[-1][0]


def track_pairs(data, ref, f):
    P, Q = [], []
    pts = data.get("points") if isinstance(data, dict) else None
    for pt in pts if isinstance(pts, list) else []:
        if not isinstance(pt, dict) or pt.get("on") is False or not track_has(pt.get("keys"), ref) or not track_has(pt.get("keys"), f):
            continue
        P.append(track_at(pt["keys"], ref))
        Q.append(track_at(pt["keys"], f))
    return P, Q


def solve_motion(P, Q, motion="translate"):
    """The page's ``solveMotion``: {"kind": "affine", "m", ...} or {"kind": "perspective", "H"}; None without points."""
    n = min(len(P), len(Q))
    if not n:
        return None
    if motion == "perspective" and n >= 4:
        H = homography(P[:4], Q[:4])
        if H:
            return {"kind": "perspective", "H": H}
    px = py = qx = qy = 0.0
    for i in range(n):
        px += P[i][0]
        py += P[i][1]
        qx += Q[i][0]
        qy += Q[i][1]
    px /= n
    py /= n
    qx /= n
    qy /= n
    a = b = pp = 0.0
    for i in range(n):
        ux, uy, vx, vy = P[i][0] - px, P[i][1] - py, Q[i][0] - qx, Q[i][1] - qy
        a += ux * vx + uy * vy
        b += ux * vy - uy * vx
        pp += ux * ux + uy * uy
    turn = n >= 2 and motion != "translate" and pp > 1e-9
    angle = math.atan2(b, a) if turn else 0.0
    s = ((math.sqrt(a * a + b * b) if turn else a) / pp) if n >= 2 and motion in ("scale", "perspective") and pp > 1e-9 else 1.0
    c, sn = math.cos(angle), math.sin(angle)
    m = [c * s, sn * s, -sn * s, c * s, 0.0, 0.0]
    m[4] = qx - (m[0] * px + m[2] * py)
    m[5] = qy - (m[1] * px + m[3] * py)
    return {"kind": "affine", "m": m, "angle": angle * 180 / math.pi, "s": s, "cP": [px, py], "cQ": [qx, qy]}


def invert_affine(m):
    det = m[0] * m[3] - m[1] * m[2] or 1e-12
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]


def quad_at(keys, f):
    if not isinstance(keys, list) or not keys:
        return None

    def pick(k):
        return [[k[1], k[2]], [k[3], k[4]], [k[5], k[6]], [k[7], k[8]]]
    if f <= keys[0][0]:
        return pick(keys[0])
    if f >= keys[-1][0]:
        return pick(keys[-1])
    i = 0
    while i < len(keys) - 1 and keys[i + 1][0] <= f:
        i += 1
    a, b = keys[i], keys[i + 1]
    if a[0] == f:
        return pick(a)
    t = (f - a[0]) / (b[0] - a[0])
    return pick([f] + [a[k] + (b[k] - a[k]) * t for k in range(1, 9)])
