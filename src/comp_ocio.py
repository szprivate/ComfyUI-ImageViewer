"""OpenColorIO for the Comp space: the config the viewer uses (``color_io``: ``$OCIO``, else PyOpenColorIO's
built-in one), its colourspaces, displays and views, a transform applied exactly (the render, a Read's file
into the working space) and the same transform baked into a 3D LUT behind a shaper (the page's preview).

A transform is a spec: ``{"src": name, "dst": name}`` or ``{"src": name, "display": d, "view": v}``; an
empty or missing ``src`` / ``dst`` is the comp's working space - the config's scene-linear role, which is
what the viewer calls "Linear". Without PyOpenColorIO every transform is refused (``available`` False) and
the nodes pass their picture through, saying so.

The LUT's shaper (``comp_model.SHAPERS``): ``log2`` over [2^-12, 2^6] for a scene-linear source, ``lin``
over [0, 1.25] for anything else (log, video, data), so its points lie where the values are.
"""
from __future__ import annotations

import threading

import numpy as np

from . import color_io
from . import comp_model as M

LUT_SIZE = 48
_lock = threading.Lock()
_procs = {}
_luts = {}


def reset():
    """Forget the processors and LUTs (the config changed: color_io.reset)."""
    with _lock:
        _procs.clear()
        _luts.clear()


def _cfg():
    st = color_io._load()
    return st["config"], st


def available():
    return _cfg()[0] is not None


def working():
    return _cfg()[1]["linear"]


def info():
    cfg, st = _cfg()
    if cfg is None:
        return {"available": False, "colorspaces": [], "displays": [], "working": "", "source": st["source"]}
    displays = []
    try:
        for d in cfg.getDisplays():
            displays.append({"name": d, "views": list(cfg.getViews(d)), "default": cfg.getDefaultView(d)})
    except Exception:  # noqa: BLE001 - a v1 config without displays still converts colourspaces
        pass
    # The bar's menu picks the INPUT colourspace and always shows it on plain sRGB (srgb_out).
    srgb = srgb_out()
    lin = srgb_linear(srgb)
    return {"available": True, "source": st["source"], "working": st["linear"], "srgb": srgb,
            "srgb_linear": lin,
            "colorspaces": [{"name": n, "family": st["families"].get(n, "")} for n in st["names"]],
            "displays": displays, "default_display": displays[0]["name"] if displays else ""}


SRGB_ENCODED = ("srgb encoded rec.709 (srgb)", "srgb - texture", "utility - srgb - texture", "srgb_texture",
                "srgb_tx", "srgb texture", "srgb")


def srgb_out():
    """The comp viewer's output: the sRGB ENCODING only, never a view that tone-maps (an ACES config's
    default sRGB view does, so a picture taken from sRGB into ACEScg and shown back did not look like it
    started). A plain sRGB-encoded colourspace when the config has one, else an un-tone-mapped view of the
    sRGB display, else what the viewer shows on (color_io's target / view)."""
    cfg, st = _cfg()
    if cfg is None:
        return {"dst": st["target"]}
    by_lower = {n.lower(): n for n in st["names"]}
    for want in SRGB_ENCODED:
        if want in by_lower:
            return {"dst": by_lower[want]}
    for role in ("color_picking", "texture_paint"):
        try:
            cs = cfg.getColorSpace(role)
        except Exception:  # noqa: BLE001
            cs = None
        name = cs.getName() if cs is not None else ""
        if name in st["names"] and "srgb" in name.lower() and "lin" not in name.lower():
            return {"dst": name}
    if st.get("view"):
        display = st["view"][0]
        try:
            views = list(cfg.getViews(display))
        except Exception:  # noqa: BLE001
            views = []
        plain = next((v for v in views if v.lower().replace("-", "").replace(" ", "") in
                      ("untonemapped", "video(colorimetric)", "standard")), None)
        return {"display": display, "view": plain or st["view"][1]}
    return {"dst": st["target"]}


def _srgb_curve(x):
    x = np.asarray(x, dtype=np.float64)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(np.maximum(x, 0), 1 / 2.4) - 0.055)


def srgb_linear(out=None):
    """The linear colourspace whose sRGB encoding ``out`` is (Linear Rec.709 (sRGB) in the built-in config),
    checked by the numbers: the page then bakes the input into IT - for a linear input an exact matrix - and
    puts the sRGB curve on itself. A LUT straight into the encoded values interpolated a matrix and a steep
    curve together and missed saturated colours by up to 100 levels. None when nothing fits."""
    cfg, st = _cfg()
    out = out if out is not None else srgb_out()
    if cfg is None or not out.get("dst"):
        return None
    probe = np.array([[[0.0, 0.001, 0.01], [0.05, 0.18, 0.5], [0.8, 1.0, 0.3]]], np.float32)
    want = _srgb_curve(probe)
    for name in st["names"]:
        low = name.lower()
        if "lin" not in low or not any(k in low for k in ("srgb", "rec.709", "rec709", "bt.709")):
            continue
        if any(k in low for k in ("ap0", "ap1", "p3", "2020", "aces")):
            continue
        try:
            got = apply_rgb(probe.copy(), {"src": name, "dst": out["dst"]})
        except Exception:  # noqa: BLE001
            continue
        if processor({"src": name, "dst": out["dst"]}) is not None and float(np.abs(got - want).max()) < 2e-3:
            return name
    return None


def resolve(spec):
    """The spec with its working-space blanks filled in, or None when it names what the config lacks."""
    cfg, st = _cfg()
    if cfg is None or not isinstance(spec, dict):
        return None
    names = set(st["names"])
    src = spec.get("src") or st["linear"]
    if src not in names:
        return None
    if spec.get("display"):
        try:
            display = cfg.getDefaultDisplay() if spec["display"] == "*" else spec["display"]
            view = spec.get("view") or "*"
            view = cfg.getDefaultView(display) if view == "*" else view
            if display not in list(cfg.getDisplays()) or view not in list(cfg.getViews(display)):
                return None
        except Exception:  # noqa: BLE001
            return None
        return {"src": src, "display": display, "view": view}
    dst = spec.get("dst") or st["linear"]
    return {"src": src, "dst": dst} if dst in names else None


def _key(r):
    return (r["src"], r.get("dst"), r.get("display"), r.get("view"))


def processor(spec):
    """The CPU processor of a spec (resolved), kept."""
    r = resolve(spec)
    if r is None:
        return None
    k = _key(r)
    with _lock:
        if k not in _procs:
            cfg, _ = _cfg()
            import PyOpenColorIO as ocio
            if r.get("display"):
                p = cfg.getProcessor(ocio.DisplayViewTransform(src=r["src"], display=r["display"], view=r["view"]),
                                     ocio.TRANSFORM_DIR_FORWARD)
            else:
                p = cfg.getProcessor(r["src"], r["dst"])
            _procs[k] = p.getDefaultCPUProcessor()
        return _procs[k]


def apply_rgb(rgb, spec):
    """``rgb`` (float, [H, W, 3]) through the transform, exactly; a new float32 array (the input untouched)."""
    cpu = processor(spec)
    out = np.ascontiguousarray(rgb, dtype=np.float32).copy()
    if cpu is None:
        return out
    color_io._apply(cpu, out)
    return out


def hook(spec):
    """``comp_model.render_node``'s ``ocio``: the transform as a function of [..., 3] colours, exact; None when
    OCIO cannot do it (the node then passes its picture through)."""
    if processor(spec) is None:
        return None
    return lambda rgb: apply_rgb(rgb, spec)


def from_space(rgb, colorspace):
    """A Read's file values (straight) from ``colorspace`` into the working space."""
    return apply_rgb(rgb, {"src": colorspace, "dst": ""})


def shaper_for(spec):
    r = resolve(spec)
    if r is None:
        return "lin:0:1.25"
    cfg, _ = _cfg()
    try:
        enc = cfg.getColorSpace(r["src"]).getEncoding() or ""
    except Exception:  # noqa: BLE001 - OCIO before 2.1
        enc = ""
    if not enc:   # a v1 config (ACES 1.x) says no encoding: the working space, or a name that says linear
        low = r["src"].lower()
        lin = (r["src"] == _cfg()[1]["linear"] or "lin" in low or "acescg" in low or "aces2065" in low)
        enc = "scene-linear" if lin else ""
    return "log2:-12:6" if enc == "scene-linear" else "lin:0:1.25"


def matrix_of(spec):
    """A transform that is matrices only (a linear space to another), as [m00..m22, o0, o1, o2]; else None."""
    r = resolve(spec)
    if r is None:
        return None
    cfg, _ = _cfg()
    try:
        import PyOpenColorIO as ocio
        if r.get("display"):
            return None
        proc = cfg.getProcessor(r["src"], r["dst"]).getOptimizedProcessor(ocio.OPTIMIZATION_DEFAULT)
        m, o = np.eye(4), np.zeros(4)
        for t in proc.createGroupTransform():
            if not isinstance(t, ocio.MatrixTransform):
                return None
            tm = np.array(t.getMatrix(), dtype=np.float64).reshape(4, 4)
            to = np.array(t.getOffset(), dtype=np.float64)
            if t.getDirection() == ocio.TRANSFORM_DIR_INVERSE:
                tm = np.linalg.inv(tm)
                to = -tm @ to
            m, o = tm @ m, tm @ o + to
        return np.concatenate([m[:3, :3].reshape(-1), o[:3]]).astype(np.float32)
    except Exception:  # noqa: BLE001 - not a plain matrix: baked as a LUT
        return None


def bake(spec, size=LUT_SIZE):
    """(size, shaper, float32 [size^3 * 3], blue fastest... red slowest) - the transform sampled on the shaper's grid;
    None without OCIO or for a spec the config cannot do."""
    r = resolve(spec)
    if r is None:
        return None
    k = _key(r) + (size,)
    with _lock:
        hit = _luts.get(k)
    if hit is not None:
        return hit
    mat = matrix_of(r)
    if mat is not None:
        got = (0, "matrix", mat)
        with _lock:
            _luts[k] = got
        return got
    shaper = shaper_for(r)
    axis = M.shaper_inverse(shaper, np.linspace(0, 1, size))
    R, G, B = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.stack([R, G, B], axis=-1).reshape(1, -1, 3).astype(np.float32)
    out = apply_rgb(grid, r).reshape(-1)
    got = (size, shaper, out)
    with _lock:
        _luts[k] = got
        while len(_luts) > 24:
            _luts.pop(next(iter(_luts)))
    return got
