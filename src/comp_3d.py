"""Comp's 3D compositing in numpy: the twin of js/imageViewer_comp3d.js (read its header for the rules).

Cameras, cards and shapes, projection, point clouds from depth and the renderer. The arithmetic and its order
are the page's, so tests/test_comp_parity.py can compare the two. Loadable on its own (numpy and math only)."""
import math

import numpy as np

SHAPES = ["cube", "sphere", "cylinder"]
PROJECT_FACES = ["both", "front"]
DEPTH_MODES = ["distance", "inverse"]
DEPTH_OUT = ["depth.z", "none"]

D2R = math.pi / 180


# ── matrices ────────────────────────────────────────────────────────────────

def m4mul(a, b):
    return [a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c]
            for r in range(4) for c in range(4)]


def m4t(x, y, z):
    return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]


def m4s(x, y, z):
    return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]


def m4rx(deg):
    a = deg * D2R
    c, s = math.cos(a), math.sin(a)
    return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]


def m4ry(deg):
    a = deg * D2R
    c, s = math.cos(a), math.sin(a)
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]


def m4rz(deg):
    a = deg * D2R
    c, s = math.cos(a), math.sin(a)
    return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def euler_xyz(r):
    return m4mul(m4rx(r[0]), m4mul(m4ry(r[1]), m4rz(r[2])))


def trs(t, r, s):
    return m4mul(m4t(t[0], t[1], t[2]), m4mul(euler_xyz(r), m4s(s[0], s[1], s[2])))


def apply(m, x, y, z):
    """m applied to a point (or to arrays of x, y, z)."""
    return (m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11])


# ── cameras ─────────────────────────────────────────────────────────────────

def camera_at(p, eye, W, H):
    t = p.get("translate") or [0, 0, 0]
    R = euler_xyz(p.get("rotate") or [0, 0, 0])
    Rt = [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0, 0, 0, 0, 1]
    view = m4mul(m4t(-eye, 0, 0), m4mul(Rt, m4t(-t[0], -t[1], -t[2])))
    world = m4mul(m4t(t[0], t[1], t[2]), m4mul(R, m4t(eye, 0, 0)))
    k = p["focal"] / (p["haperture"] / 2)
    conv = p["convergence"] if p.get("convergence", 0) > 0 else 1
    return {"world": world, "view": view, "k": k, "ky": (k * W) / H, "sx": (k * eye) / conv, "near": p["near"],
            "far": p["far"], "W": W, "H": H, "pos": [world[3], world[7], world[11]]}


def project(cam, x, y, z):
    c = apply(cam["view"], x, y, z)
    d = -c[2]
    return ((cam["k"] * c[0]) / d + cam["sx"] + 1) * 0.5 * cam["W"], (1 - (cam["ky"] * c[1]) / d) * 0.5 * cam["H"], d


# ── geometry ────────────────────────────────────────────────────────────────

def card_mesh(aspect):
    h = aspect / 2
    return {"pos": [-0.5, -h, 0, 0.5, -h, 0, 0.5, h, 0, -0.5, h, 0], "uv": [0, 0, 1, 0, 1, 1, 0, 1], "tri": [0, 1, 2, 0, 2, 3]}


def shape_mesh(shape, div):
    pos, uv, tri = [], [], []

    def quad(a, b, c, d):
        tri.extend([a, b, c, a, c, d])
    if shape == "sphere":
        lon, lat = max(3, div), max(2, int(math.floor(div / 2)))
        for j in range(lat + 1):
            ph = (math.pi * j) / lat
            y, r = math.cos(ph) * 0.5, math.sin(ph) * 0.5
            for i in range(lon + 1):
                th = (2 * math.pi * i) / lon
                pos.extend([r * math.sin(th), y, r * math.cos(th)])
                uv.extend([i / lon, 1 - j / lat])
        for j in range(lat):
            for i in range(lon):
                a = j * (lon + 1) + i
                quad(a + lon + 1, a + lon + 2, a + 1, a)
    elif shape == "cylinder":
        n = max(3, div)
        for i in range(n + 1):
            th = (2 * math.pi * i) / n
            x, z = math.sin(th) * 0.5, math.cos(th) * 0.5
            pos.extend([x, -0.5, z, x, 0.5, z])
            uv.extend([i / n, 0, i / n, 1])
        for i in range(n):
            quad(2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1)
        for y in (0.5, -0.5):
            c = len(pos) // 3
            pos.extend([0, y, 0])
            uv.extend([0.5, 0.5])
            for i in range(n + 1):
                th = (2 * math.pi * i) / n
                x, z = math.sin(th) * 0.5, math.cos(th) * 0.5
                pos.extend([x, y, z])
                uv.extend([0.5 + x, 0.5 - z])
            for i in range(n):
                tri.extend([c, c + 1 + i, c + 2 + i] if y > 0 else [c, c + 2 + i, c + 1 + i])
    else:
        F = [[[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
             [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]]
        for nm, u, v in F:
            b = len(pos) // 3
            for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                pos.extend([(nm[0] + u[0] * su + v[0] * sv) * 0.5, (nm[1] + u[1] * su + v[1] * sv) * 0.5,
                            (nm[2] + u[2] * su + v[2] * sv) * 0.5])
                uv.extend([(su + 1) / 2, (sv + 1) / 2])
            quad(b, b + 1, b + 2, b + 3)
    return {"pos": pos, "uv": uv, "tri": tri}


def place_mesh(mesh, m):
    pos = []
    p = mesh["pos"]
    for i in range(0, len(p), 3):
        pos.extend(apply(m, p[i], p[i + 1], p[i + 2]))
    return {"pos": pos, "uv": mesh["uv"], "tri": mesh["tri"]}


def points_from_depth(img, depth, cam, mode, mul, step):
    """The page's pointsFromDepth: (pos [N, 3] float64, col [N, 4] float32)."""
    h, w = img.shape[:2]
    ys = np.arange(0, h, step)
    xs = np.arange(0, w, step)
    Y, X = np.meshgrid(ys, xs, indexing="ij")
    Y, X = Y.ravel(), X.ravel()
    a = img[Y, X, 3]
    v = depth[Y, X].astype(np.float64) if depth is not None else np.zeros(len(Y))
    if mode == "inverse":
        with np.errstate(divide="ignore", invalid="ignore"):
            d = np.where(v > 0, mul / np.where(v > 0, v, 1), 0.0)
    else:
        d = v * mul
    ok = (a > 0) & (d > 0)
    X, Y, d = X[ok].astype(np.float64), Y[ok].astype(np.float64), d[ok]
    nx = ((X + 0.5) / w) * 2 - 1 - cam["sx"]
    ny = 1 - ((Y + 0.5) / h) * 2
    px, py, pz = apply(cam["world"], (nx * d) / cam["k"], (ny * d) / cam["ky"], -d)
    col = img[Y.astype(np.int64), X.astype(np.int64)].astype(np.float32)
    return np.stack([px, py, pz], axis=1) if len(d) else np.zeros((0, 3)), col


# ── sampling ────────────────────────────────────────────────────────────────

def sample(img, u, v):
    """Bilinear at (u, v) (arrays, pixel units, 0 = the first pixel's centre), transparent outside: [N, 4]."""
    sh, sw = img.shape[:2]
    x0 = np.floor(u).astype(np.int64)
    y0 = np.floor(v).astype(np.int64)
    fx = (u - x0)[:, None]
    fy = (v - y0)[:, None]
    out = np.zeros((len(u), 4), np.float64)
    src = img.astype(np.float64)
    for dy in (0, 1):
        for dx in (0, 1):
            xx, yy = x0 + dx, y0 + dy
            ok = (xx >= 0) & (yy >= 0) & (xx < sw) & (yy < sh)
            wgt = (fx if dx else 1 - fx) * (fy if dy else 1 - fy)
            vals = src[np.clip(yy, 0, sh - 1), np.clip(xx, 0, sw - 1)]
            out += np.where(ok[:, None], vals * wgt, 0)
    return out


# ── the renderer ────────────────────────────────────────────────────────────

def _clip_near(poly, near):
    out = []
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        da, db = -a[2], -b[2]
        ina, inb = da >= near, db >= near
        if ina:
            out.append(a)
        if ina != inb:
            t = (near - da) / (db - da)
            out.append([v + (b[k] - v) * t for k, v in enumerate(a)])
    return out


def _mesh(ob, cam, W, H, n, zb, cb):
    GW, GH = W * n, H * n
    P, U, T = ob["pos"], ob["uv"], ob["tri"]
    for t in range(0, len(T), 3):
        ids = [T[t], T[t + 1], T[t + 2]]
        wv = [[P[q * 3], P[q * 3 + 1], P[q * 3 + 2]] for q in ids]
        if ob.get("proj") and ob.get("faces") == "front":
            e1 = [wv[1][0] - wv[0][0], wv[1][1] - wv[0][1], wv[1][2] - wv[0][2]]
            e2 = [wv[2][0] - wv[0][0], wv[2][1] - wv[0][1], wv[2][2] - wv[0][2]]
            nx = e1[1] * e2[2] - e1[2] * e2[1]
            ny = e1[2] * e2[0] - e1[0] * e2[2]
            nz = e1[0] * e2[1] - e1[1] * e2[0]
            pc = ob["proj"]["cam"]["pos"]
            if not (nx * (pc[0] - wv[0][0]) + ny * (pc[1] - wv[0][1]) + nz * (pc[2] - wv[0][2]) > 0):
                continue
        poly = []
        for k, q in enumerate(ids):
            c = apply(cam["view"], wv[k][0], wv[k][1], wv[k][2])
            poly.append([c[0], c[1], c[2], U[q * 2], U[q * 2 + 1], wv[k][0], wv[k][1], wv[k][2]])
        poly = _clip_near(poly, cam["near"])
        if len(poly) < 3:
            continue
        pv = []
        for v in poly:
            d = -v[2]
            pv.append([(((cam["k"] * v[0]) / d + cam["sx"] + 1) * 0.5 * W) * n, ((1 - (cam["ky"] * v[1]) / d) * 0.5 * H) * n, 1 / d, v])
        for f in range(1, len(pv) - 1):
            a, b, c = pv[0], pv[f], pv[f + 1]
            area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if not abs(area) > 1e-12:
                continue
            X0 = max(0, int(math.floor(min(a[0], b[0], c[0]) - 0.5)))
            X1 = min(GW - 1, int(math.ceil(max(a[0], b[0], c[0]) - 0.5)))
            Y0 = max(0, int(math.floor(min(a[1], b[1], c[1]) - 0.5)))
            Y1 = min(GH - 1, int(math.ceil(max(a[1], b[1], c[1]) - 0.5)))
            if X1 < X0 or Y1 < Y0:
                continue
            sy, sx = np.meshgrid(np.arange(Y0, Y1 + 1, dtype=np.float64) + 0.5, np.arange(X0, X1 + 1, dtype=np.float64) + 0.5, indexing="ij")
            sy, sx = sy.ravel(), sx.ravel()
            w0 = ((c[0] - b[0]) * (sy - b[1]) - (c[1] - b[1]) * (sx - b[0])) / area
            w1 = ((a[0] - c[0]) * (sy - c[1]) - (a[1] - c[1]) * (sx - c[0])) / area
            w2 = ((b[0] - a[0]) * (sy - a[1]) - (b[1] - a[1]) * (sx - a[0])) / area
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue
            w0, w1, w2, sx, sy = w0[inside], w1[inside], w2[inside], sx[inside], sy[inside]
            iz = w0 * a[2] + w1 * b[2] + w2 * c[2]
            with np.errstate(divide="ignore"):
                d = 1 / iz
            s = (sy - 0.5).astype(np.int64) * GW + (sx - 0.5).astype(np.int64)
            ok = (d < zb[s]) & ~(d > cam["far"])
            if not ok.any():
                continue
            w0, w1, w2, iz, d, s = w0[ok], w1[ok], w2[ok], iz[ok], d[ok], s[ok]

            def at(k):
                return (w0 * a[3][k] * a[2] + w1 * b[3][k] * b[2] + w2 * c[3][k] * c[2]) / iz
            if ob.get("proj"):
                q0, q1, q2 = project(ob["proj"]["cam"], at(5), at(6), at(7))
                col = sample(ob["proj"]["img"], q0 - 0.5, q1 - 0.5)
                col[~(q2 > 0)] = 0
            elif ob.get("tex") is not None:
                tex = ob["tex"]
                col = sample(tex, at(3) * tex.shape[1] - 0.5, (1 - at(4)) * tex.shape[0] - 0.5)
            else:
                col = np.ones((len(d), 4))
            zb[s] = d
            cb[s] = col


def _points(ob, cam, W, H, n, zb, cb):
    GW, GH = W * n, H * n
    pos = np.asarray(ob["pos"], np.float64).reshape(-1, 3)
    if not len(pos):
        return
    px, py, d = project(cam, pos[:, 0], pos[:, 1], pos[:, 2])
    keep = (d >= cam["near"]) & ~(d > cam["far"])
    idx = np.nonzero(keep)[0]
    if not len(idx):
        return
    half = (ob["size"] * n) / 2
    gx, gy, d = px[idx] * n, py[idx] * n, d[idx]
    x0 = np.ceil(gx - half - 0.5)
    x1 = np.ceil(gx + half - 0.5) - 1
    y0 = np.ceil(gy - half - 0.5)
    y1 = np.ceil(gy + half - 0.5) - 1
    tiny = x1 < x0
    x0[tiny] = x1[tiny] = np.floor(gx[tiny])
    tiny = y1 < y0
    y0[tiny] = y1[tiny] = np.floor(gy[tiny])
    x0, x1, y0, y1 = (v.astype(np.int64) for v in (x0, x1, y0, y1))
    sw, shh = int((x1 - x0).max()) + 1, int((y1 - y0).max()) + 1
    S, Dd, I = [], [], []
    for oy in range(shh):
        for ox in range(sw):
            X, Y = x0 + ox, y0 + oy
            ok = (X <= x1) & (Y <= y1) & (X >= 0) & (Y >= 0) & (X < GW) & (Y < GH)
            S.append(Y[ok] * GW + X[ok])
            Dd.append(d[ok])
            I.append(idx[ok])
    S, Dd, I = np.concatenate(S), np.concatenate(Dd), np.concatenate(I)
    if not len(S):
        return
    o = np.lexsort((I, Dd, S))
    S, Dd, I = S[o], Dd[o], I[o]
    first = np.ones(len(S), bool)
    first[1:] = S[1:] != S[:-1]
    S, Dd, I = S[first], Dd[first], I[first]
    win = Dd < zb[S]
    zb[S[win]] = Dd[win]
    cb[S[win]] = np.asarray(ob["col"], np.float64).reshape(-1, 4)[I[win]]


def render_scene(objs, cam, W, H, n):
    """The page's renderScene: (img [H, W, 4] float32, depth [H, W] float32, deep)."""
    n = max(1, min(4, int(math.floor(n + 0.5)) if n else 1))
    GW, GH = W * n, H * n
    S, K = GW * GH, len(objs)
    Z = np.full((max(K, 1), S), np.inf)
    Cc = np.zeros((max(K, 1), S, 4))
    for k, ob in enumerate(objs):
        if ob["kind"] == "points":
            _points(ob, cam, W, H, n, Z[k], Cc[k])
        else:
            _mesh(ob, cam, W, H, n, Z[k], Cc[k])
    acc = np.zeros((S, 4))
    first = np.full(S, np.inf)
    if K:
        order = np.argsort(Z[:K], axis=0, kind="stable")
        tr = np.ones(S)
        ar = np.arange(S)
        for q in range(K):
            k = order[q]
            z = Z[k, ar]
            c = Cc[k, ar]
            v = z < np.inf
            acc += np.where(v[:, None], tr[:, None] * c, 0)
            hit = v & (first == np.inf) & (c[:, 3] > 0)
            first[hit] = z[hit]
            tr = np.where(v, tr * (1 - c[:, 3]), tr)
    nn = n * n
    blk = acc.reshape(H, n, W, n, 4)
    img = (blk.sum(axis=(1, 3)) / nn).astype(np.float32)
    near = first.reshape(H, n, W, n).min(axis=(1, 3))
    depth = np.where(near < np.inf, near, 0).astype(np.float32)
    # deep: one sample per object that covers a pixel, front first (the earlier object first at one depth)
    P = W * H
    samp = np.zeros((max(K, 1), P, 6))
    zk = np.full((max(K, 1), P), np.inf)
    for k in range(K):
        cov = (Z[k] < np.inf).reshape(H, n, W, n)
        c = Cc[k].reshape(H, n, W, n, 4)
        sums = np.where(cov[..., None], c, 0).sum(axis=(1, 3)).reshape(P, 4) / nn
        zz = np.where(cov & (c[..., 3] > 0), Z[k].reshape(H, n, W, n), np.inf).min(axis=(1, 3)).reshape(P)
        samp[k, :, :4] = sums
        samp[k, :, 4] = zz
        samp[k, :, 5] = zz
        zk[k] = zz
    if K:
        o = np.argsort(zk[:K], axis=0, kind="stable")
        zs = np.take_along_axis(zk[:K], o, axis=0)
        ss = np.take_along_axis(samp[:K], o[..., None], axis=0)
        fin = zs < np.inf
        counts = fin.sum(axis=0).astype(np.uint32)
        flat = ss.transpose(1, 0, 2)[fin.T].astype(np.float32)
    else:
        counts = np.zeros(P, np.uint32)
        flat = np.zeros((0, 6), np.float32)
    return img, depth, {"w": W, "h": H, "n": counts, "s": flat.reshape(-1, 6)}
