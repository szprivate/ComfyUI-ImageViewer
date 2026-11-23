"""The one shape every mask and roto tool draws with - the twin of js/imageViewer_maskShape.js.

A shape is points and a kind: "bezier" (anchors with a tangent handle on each side, the curve goes through
them) or "bspline" (control points of a uniform cubic B-spline, which pulls the curve towards them). Both come
down to anchors ``(x, y, ix, iy, ox, oy)`` with absolute handles, one cubic per segment; ``curve_anchors``
makes those from either kind and ``flatten_anchors`` the polyline. roto_raster.py, paint_math.py and
matchmove.py render with this, so a mask drawn in the page renders as drawn. Keep it identical to the JS.

Written from the textbook B-spline to Bezier conversion, not from any other program's code.
"""

import math

SHAPE_KINDS = ("bezier", "bspline")


def shape_kind(v):
    return "bspline" if v == "bspline" else "bezier"


def corner(x, y):
    return (x, y, x, y, x, y)


def bspline_anchors(ctrl, closed):
    """Anchors (x, y, ix, iy, ox, oy) of a uniform cubic B-spline through control points [(x, y)]; an open one
    clamped by a mirrored point past each end (see bsplineAnchors in the JS)."""
    ctrl = [(float(p[0]), float(p[1])) for p in ctrl]
    n = len(ctrl)
    if n < 3 and closed:
        closed = False
    if n < 2:
        return [corner(x, y) for x, y in ctrl]

    def P(i):
        if closed:
            return ctrl[i % n]
        if i < 0:
            return (2 * ctrl[0][0] - ctrl[1][0], 2 * ctrl[0][1] - ctrl[1][1])
        if i >= n:
            return (2 * ctrl[n - 1][0] - ctrl[n - 2][0], 2 * ctrl[n - 1][1] - ctrl[n - 2][1])
        return ctrl[i]

    out = []
    for i in range(n):
        a, b, c = P(i - 1), P(i), P(i + 1)
        out.append(((a[0] + 4 * b[0] + c[0]) / 6, (a[1] + 4 * b[1] + c[1]) / 6,
                    (a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3,
                    (2 * b[0] + c[0]) / 3, (2 * b[1] + c[1]) / 3))
    return out


def curve_anchors(anchors, kind, closed):
    """anchors: [(x, y, ix, iy, ox, oy)] (a B-spline's only need x, y)."""
    if shape_kind(kind) == "bspline":
        return bspline_anchors([(a[0], a[1]) for a in anchors], closed)
    return [tuple(float(v) for v in a[:6]) if len(a) >= 6 else corner(float(a[0]), float(a[1])) for a in anchors]


def segment_steps(a, b):
    if a[4] == a[0] and a[5] == a[1] and b[2] == b[0] and b[3] == b[1]:
        return 1
    ln = (math.hypot(a[4] - a[0], a[5] - a[1]) + math.hypot(b[2] - a[4], b[3] - a[5])
          + math.hypot(b[0] - b[2], b[1] - b[3]))
    return max(1, min(128, int(math.ceil(ln / 3))))


def bezier_at(a, b, t):
    u = 1 - t
    A, B, C, E = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
    return (A * a[0] + B * a[4] + C * b[2] + E * b[0], A * a[1] + B * a[5] + C * b[3] + E * b[1])


def flatten_anchors(anch, closed, scale=1.0):
    """The anchors as a polyline [(x, y)]; a closed one's last segment included without repeating the first."""
    out = []
    if not anch:
        return out
    out.append((anch[0][0], anch[0][1]))
    segs = len(anch) if closed else len(anch) - 1
    for i in range(segs):
        a, b = anch[i], anch[(i + 1) % len(anch)]
        if scale == 1:
            n = segment_steps(a, b)
        else:
            n = segment_steps(tuple(v * scale for v in a), tuple(v * scale for v in b))
        for k in range(1, n + 1):
            if closed and i == segs - 1 and k == n:
                break
            out.append((b[0], b[1]) if k == n else bezier_at(a, b, k / n))
    return out


def shape_polygon(anchors, kind, closed, scale=1.0):
    return flatten_anchors(curve_anchors(anchors, kind, closed), closed, scale)


def from_arr(p):
    """A Matchmove mask point [x, y] or [x, y, ix, iy, ox, oy] -> an anchor."""
    if len(p) >= 6:
        return tuple(float(v) for v in p[:6])
    return corner(float(p[0]), float(p[1]))
