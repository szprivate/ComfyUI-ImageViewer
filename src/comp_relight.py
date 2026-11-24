"""Comp's Relight: a picture lit again in 2.5D from its normals and the comp's Light nodes.

The numpy twin of js/imageViewer_compRelight.js (read that file's head for the rules): the same steps in the same
order, in float64, the picture stored float32. tests/test_comp_parity.py renders the same comps with both.
Imports only numpy, so comp_model can load it with or without the package (``_sibling``).
"""
from __future__ import annotations

import math

import numpy as np

RELIGHT_NORMALS = ["from depth", "from a layer", "normals input"]
RELIGHT_SPACES = ["camera", "world"]
RELIGHT_ENCODINGS = ["0..1", "-1..1"]
RELIGHT_GREEN = ["up", "down"]
RELIGHT_MODES = ["add light", "relight"]
RELIGHT_OUTPUTS = ["result", "light only", "normals"]
RELIGHT_PENUMBRA = 0.1

D2R = math.pi / 180


def _distances(depth, n, mode, mul):
    if depth is None:
        return np.zeros(n, np.float64)
    v = np.asarray(depth, np.float64).reshape(-1)
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        if mode == "inverse":
            z = np.where(v > 0, mul / np.where(v > 0, v, 1.0), 0.0)
        else:
            z = v * mul
    return np.where((z > 0) & np.isfinite(z), z, 0.0)


def box_blur(a, w, h, r):
    """A box blur of radius r along rows then columns, the edge repeated (the page's ``boxBlur``)."""
    if not r >= 1:
        return a
    A = a.reshape(h, w)
    k = 2 * r + 1
    xs = np.arange(w)
    s = np.zeros((h, w), np.float64)
    for j in range(-r, r + 1):
        s = s + A[:, np.clip(xs + j, 0, w - 1)]
    tmp = s / k
    ys = np.arange(h)
    s = np.zeros((h, w), np.float64)
    for j in range(-r, r + 1):
        s = s + tmp[np.clip(ys + j, 0, h - 1), :]
    return (s / k).reshape(-1)


def camera_points(d, w, h, cam, fallback):
    z = np.where(d > 0, d, fallback).reshape(h, w)
    x = (np.arange(w) + 0.5) / w * 2 - 1 - cam["sx"]
    y = 1 - (np.arange(h) + 0.5) / h * 2
    C = np.empty((h, w, 3), np.float64)
    C[..., 0] = (x[None, :] * z) / cam["k"]
    C[..., 1] = (y[:, None] * z) / cam["ky"]
    C[..., 2] = -z
    return C


def _unit_or_front(x, y, z):
    ln = np.sqrt(x * x + y * y + z * z)
    ok = ln > 1e-12
    safe = np.where(ok, ln, 1.0)
    return np.where(ok, x / safe, 0.0), np.where(ok, y / safe, 0.0), np.where(ok, z / safe, 1.0)


def normals_from_points(C):
    h, w = C.shape[:2]
    xs, ys = np.arange(w), np.arange(h)
    l, r = np.maximum(xs - 1, 0), np.minimum(xs + 1, w - 1)
    u, dn = np.maximum(ys - 1, 0), np.minimum(ys + 1, h - 1)
    A = C[:, r] - C[:, l]
    B = C[dn, :] - C[u, :]
    ax, ay, az = A[..., 0], A[..., 1], A[..., 2]
    bx, by, bz = B[..., 0], B[..., 1], B[..., 2]
    nx = by * az - bz * ay
    ny = bz * ax - bx * az
    nz = bx * ay - by * ax
    nx, ny, nz = _unit_or_front(nx, ny, nz)
    back = (nx * -C[..., 0] + ny * -C[..., 1] + nz * -C[..., 2]) < 0
    sg = np.where(back, -1.0, 1.0)
    return np.stack([nx * sg, ny * sg, nz * sg], axis=-1)


def normals_from_colours(rgb, p, Rt):
    """rgb [H, W, 3] float -> unit camera-space normals [H, W, 3] (the page's ``normalsFromColours``)."""
    v = np.asarray(rgb, np.float64)
    x, y, z = v[..., 0], v[..., 1], v[..., 2]
    if p.get("encoding") != "-1..1":
        x, y, z = x * 2 - 1, y * 2 - 1, z * 2 - 1
    if p.get("green") == "down":
        y = -y
    if p.get("space") == "world":
        cx = Rt[0] * x + Rt[1] * y + Rt[2] * z
        cy = Rt[3] * x + Rt[4] * y + Rt[5] * z
        cz = Rt[6] * x + Rt[7] * y + Rt[8] * z
        x, y, z = cx, cy, cz
    x, y, z = _unit_or_front(x, y, z)
    return np.stack([x, y, z], axis=-1)


def normal_channels(ex, layer):
    if not ex or not layer or layer == "rgba":
        return None
    for chs in (("x", "y", "z"), ("r", "g", "b")):
        got = [ex.get(f"{layer}.{c}") for c in chs]
        if all(g is not None for g in got):
            return got
    names = [k for k in ex if k.find(".") > 0 and k[: k.find(".")] == layer]
    return [ex[k] for k in names[:3]] if len(names) >= 3 else None


def rotation_of(cam):
    m = cam["world"]
    R = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
    return R, [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]


def _unit3(a):
    ln = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    return [a[0] / ln, a[1] / ln, a[2] / ln] if ln > 1e-12 else [0.0, 0.0, -1.0]


def camera_lights(lights, key, cam):
    v = cam["view"]
    out = []

    def to_cam(x, y, z):
        return [v[0] * x + v[1] * y + v[2] * z + v[3], v[4] * x + v[5] * y + v[6] * z + v[7], v[8] * x + v[9] * y + v[10] * z + v[11]]

    def turn(x, y, z):
        return [v[0] * x + v[1] * y + v[2] * z, v[4] * x + v[5] * y + v[6] * z, v[8] * x + v[9] * y + v[10] * z]

    if not lights:
        c = key.get("color") or [1, 1, 1, 1]
        I = key["intensity"]
        t = _unit3(key.get("dir") or [0, 0, 1])
        out.append({"type": "directional", "rgb": [c[0] * I, c[1] * I, c[2] * I], "pos": [0, 0, 0],
                    "dir": [-t[0], -t[1], -t[2]], "cosOuter": -1, "cosInner": -1})
        return out
    for lt in lights:
        c = lt.get("color") or [1, 1, 1, 1]
        I = lt["intensity"]
        m = lt["world"]
        cone = max(1, min(89, lt.get("cone") or 30)) * D2R
        out.append({"type": lt["type"], "rgb": [c[0] * I, c[1] * I, c[2] * I], "pos": to_cam(m[3], m[7], m[11]),
                    "dir": _unit3(turn(-m[2], -m[6], -m[10])),
                    "cosOuter": math.cos(cone), "cosInner": math.cos(cone * (1 - RELIGHT_PENUMBRA))})
    return out


def _smooth(e0, e1, x):
    if not e1 > e0:
        return np.where(x < e0, 0.0, 1.0)
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def shade(img, C, N, lights, p):
    s = np.asarray(img, np.float64)
    a = s[..., 3]
    nx, ny, nz = N[..., 0], N[..., 1], N[..., 2]
    out = np.empty(s.shape, np.float32)
    if p.get("output") == "normals":
        out[..., 0] = (nx * 0.5 + 0.5) * a
        out[..., 1] = (ny * 0.5 + 0.5) * a
        out[..., 2] = (nz * 0.5 + 0.5) * a
        out[..., 3] = a
        return out
    gain = p["gain"]
    wrap = max(0.0, p.get("wrap") or 0)
    spec = max(0.0, p.get("specular") or 0)
    shin = max(1.0, p.get("shininess") or 1)
    px, py, pz = C[..., 0], C[..., 1], C[..., 2]
    vx, vy, vz = _unit_or_front(-px, -py, -pz)
    dr = np.zeros(a.shape)
    dg, db, sr, sg, sb = dr.copy(), dr.copy(), dr.copy(), dr.copy(), dr.copy()
    for L in lights:
        rgb = L["rgb"]
        if L["type"] == "ambient":
            dr, dg, db = dr + rgb[0], dg + rgb[1], db + rgb[2]
            continue
        if L["type"] == "directional":
            lx = np.full(a.shape, -L["dir"][0])
            ly = np.full(a.shape, -L["dir"][1])
            lz = np.full(a.shape, -L["dir"][2])
            k = np.ones(a.shape)
            live = np.ones(a.shape, bool)
        else:
            lx, ly, lz = L["pos"][0] - px, L["pos"][1] - py, L["pos"][2] - pz
            ll = np.sqrt(lx * lx + ly * ly + lz * lz)
            live = ll > 1e-12
            safe = np.where(live, ll, 1.0)
            lx, ly, lz = lx / safe, ly / safe, lz / safe
            if L["type"] == "spot":
                k = _smooth(L["cosOuter"], L["cosInner"], -(lx * L["dir"][0] + ly * L["dir"][1] + lz * L["dir"][2]))
            else:
                k = np.ones(a.shape)
        live = live & (k > 0)
        ndl = nx * lx + ny * ly + nz * lz
        d = (ndl + wrap) / (1 + wrap) if wrap > 0 else ndl
        on = live & (d > 0)
        dr = np.where(on, dr + rgb[0] * d * k, dr)
        dg = np.where(on, dg + rgb[1] * d * k, dg)
        db = np.where(on, db + rgb[2] * d * k, db)
        if spec > 0:
            hx, hy, hz = lx + vx, ly + vy, lz + vz
            hl = np.sqrt(hx * hx + hy * hy + hz * hz)
            hok = hl > 1e-12
            hs = np.where(hok, hl, 1.0)
            ndh = nx * (hx / hs) + ny * (hy / hs) + nz * (hz / hs)
            ok = live & (ndl > 0) & hok & (ndh > 0)
            q = np.power(np.where(ok, ndh, 0.0), shin) * k
            sr = np.where(ok, sr + rgb[0] * q, sr)
            sg = np.where(ok, sg + rgb[1] * q, sg)
            sb = np.where(ok, sb + rgb[2] * q, sb)
    r, g, b = s[..., 0], s[..., 1], s[..., 2]
    lr = r * dr * gain + sr * spec * gain * a
    lg = g * dg * gain + sg * spec * gain * a
    lb = b * db * gain + sb * spec * gain * a
    if p.get("output") == "light only" or p.get("mode") == "relight":
        out[..., 0], out[..., 1], out[..., 2] = lr, lg, lb
    else:
        out[..., 0], out[..., 1], out[..., 2] = r + lr, g + lg, b + lb
    out[..., 3] = a
    return out


def relight_image(img, ex, g, p):
    """The Relight node (the page's ``relightImage``): g {cam, lights, depth, normals, scale}."""
    h, w = img.shape[:2]
    n = w * h
    mul = p["multiply"] if p.get("multiply") and p["multiply"] > 0 else 1
    d = _distances(g.get("depth"), n, p.get("depth_mode"), mul)
    r = int(math.floor((p.get("smooth") or 0) * (g.get("scale") or 1) + 0.5))
    if g.get("depth") is not None and r >= 1:
        has = np.where(d > 0, 1.0, 0.0)
        bd, bh = box_blur(d, w, h, r), box_blur(has, w, h, r)
        ok = (has > 0) & (bh > 0)
        d = np.where(ok, bd / np.where(ok, bh, 1.0), 0.0)
    C = camera_points(d, w, h, g["cam"], mul)
    _R, Rt = rotation_of(g["cam"])
    N = None
    if p.get("normals") == "from a layer":
        if p.get("layer") == "rgba":
            N = normals_from_colours(np.asarray(img, np.float64)[..., :3], p, Rt)
        else:
            ch = normal_channels(ex, p.get("layer"))
            if ch:
                N = normals_from_colours(np.stack([np.asarray(c, np.float64).reshape(h, w) for c in ch], axis=-1), p, Rt)
    elif p.get("normals") == "normals input" and g.get("normals") is not None:
        N = normals_from_colours(np.asarray(g["normals"], np.float64)[..., :3], p, Rt)
    if N is None:
        N = normals_from_points(C)
    lights = camera_lights(g.get("lights") or [], {"dir": p.get("key_direction"), "color": p.get("key_color"),
                                                   "intensity": p["key_intensity"]}, g["cam"])
    return shade(img, C, N, lights, p)
