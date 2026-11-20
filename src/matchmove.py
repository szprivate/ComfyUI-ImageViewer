"""Matchmove: the plate's camera facts, features and 2D tracks, masks and the lens grid - in numpy.

The 3D space's Matchmove panels (js/imageViewer_previzMatchmove.js) call this through matchmove_routes.py. The
camera and object solves are in matchmove_solve.py.

Everything here is written from the textbook methods, from scratch:
- features: the smaller eigenvalue of the structure tensor (a corner has texture both ways), the best in each
  cell of a grid so they spread over the picture, none closer than a given distance;
- tracking: pyramidal Lucas-Kanade (each point's patch is matched by Gauss-Newton on a brightness-normalised
  difference, coarse level first), checked by tracking back again (a point that does not come home is lost) and
  by the correlation of its patch with the frame before;
- masks: polygons with keys (linear in between), or a matte per frame (a grey picture sequence an AI workflow
  made: SAM 3 by words, a background remover), each either keeping features out ("exclude") or giving the
  features inside to a moving object ("object");
- the lens grid: the crossings of a chart (a checkerboard's saddles, or a line grid's crossings) found on the
  Hessian, put in rows and columns by walking from neighbour to neighbour, then the radial numbers that make the
  rows and columns a plane again (a projective map of the lattice) by Nelder-Mead. The model is EXACTLY the Comp
  LensDistortion node's (comp_warp: r_d = r (1 + k1 r^2 + k2 r^4), r a share of half the diagonal about the
  centre), so a lens found here is that node's numbers.

No ComfyUI here.
"""
from __future__ import annotations

import math
import os
import re

import numpy as np

from . import comp_track as T
from . import comp_warp as WP

LUM = (0.2126, 0.7152, 0.0722)
MAX_TRACKS = 2000


# ── what the plate says about its camera ────────────────────────────────────

# Sensor sizes in millimetres (width, height) of some cinema and photo bodies, as their makers publish them.
# Matched by a lower-case substring of the camera's model name; the first match wins.
SENSORS = [
    ("alexa 35", (27.99, 19.22)),
    ("alexa mini lf", (36.70, 25.54)),
    ("alexa lf", (36.70, 25.54)),
    ("alexa 65", (54.12, 25.58)),
    ("alexa mini", (28.25, 18.17)),
    ("amira", (28.25, 18.17)),
    ("alexa", (28.25, 18.17)),
    ("venice", (36.0, 24.0)),
    ("burano", (36.0, 24.0)),
    ("fx9", (35.7, 18.8)),
    ("fx6", (35.7, 18.8)),
    ("fx3", (35.6, 23.8)),
    ("fx30", (23.3, 15.5)),
    ("komodo", (27.03, 14.26)),
    ("v-raptor", (40.96, 21.60)),
    ("raptor", (40.96, 21.60)),
    ("monstro", (40.96, 21.60)),
    ("helium", (29.90, 15.77)),
    ("gemini", (30.72, 18.0)),
    ("dragon", (30.72, 15.8)),
    ("ursa mini pro 12k", (27.03, 14.25)),
    ("ursa mini pro", (25.34, 14.25)),
    ("pocket cinema camera 6k", (23.10, 12.99)),
    ("pocket cinema camera 4k", (18.96, 10.00)),
    ("c70", (26.2, 13.8)),
    ("c300", (26.2, 13.8)),
    ("c500", (38.1, 20.1)),
    ("eos r5", (36.0, 24.0)),
    ("a7", (35.6, 23.8)),
    ("gh5", (17.3, 13.0)),
    ("gh6", (17.3, 13.0)),
    # phones: the sensor differs per model and lens, so a phone's own 35 mm equivalent focal length is used
    # before these (camera_facts); this is the main camera of a recent Pro, a last resort
    ("iphone", (9.8, 7.3)),
    ("pixel", (9.8, 7.4)),
    ("dji mini", (9.6, 7.2)),
    ("mavic 3", (17.3, 13.0)),
    ("osmo", (9.6, 7.2)),
    ("gopro", (6.17, 4.55)),
]
FULL_FRAME_DIAGONAL = math.hypot(36.0, 24.0)


def sensor_for(model):
    """(width, height) mm of a camera named ``model``, or None."""
    m = str(model or "").lower()
    if not m:
        return None
    for key, size in SENSORS:
        if key in m:
            return list(size)
    return None


def _num(v):
    try:
        if isinstance(v, tuple) and len(v) == 2:
            return float(v[0]) / float(v[1]) if float(v[1]) else None
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


_FOCAL_KEYS = re.compile(r"focal", re.I)


def _exif_facts(path):
    """Camera facts from a still's EXIF (Pillow): make, model, lens, focal_mm, focal35, sensor from the focal
    plane resolution."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            ex = im.getexif()
            if not ex:
                return {}
            w, h = im.size
            return _exif_values(ex, w, h)
    except Exception:  # noqa: BLE001 - not a picture Pillow reads
        return {}


def exif_dict_facts(tiff, width=None, height=None):
    """The same facts from raw EXIF bytes (a TIFF header on, as a HEIC's Exif item holds)."""
    try:
        from PIL import Image
        ex = Image.Exif()
        ex.load(bytes(tiff) if bytes(tiff).startswith(b"Exif") else b"Exif\x00\x00" + bytes(tiff))
    except Exception:  # noqa: BLE001
        return {}
    if not width or not height:
        sub = {}
        try:
            sub = dict(ex.get_ifd(0x8769))
        except Exception:  # noqa: BLE001
            pass
        width, height = sub.get(0xA002), sub.get(0xA003)
    return _exif_values(ex, width, height)


def _exif_values(ex, w, h):
    out = {}
    try:
        sub = dict(ex.get_ifd(0x8769))
    except Exception:  # noqa: BLE001 - an old Pillow, or no sub-IFD
        sub = {}
    allv = dict(ex)
    allv.update(sub)
    if allv.get(0x010F):
        out["make"] = str(allv[0x010F]).strip("\x00 ")
    if allv.get(0x0110):
        out["model"] = str(allv[0x0110]).strip("\x00 ")
    if allv.get(0xA434):
        out["lens"] = str(allv[0xA434]).strip("\x00 ")
    f = _num(allv.get(0x920A))
    if f:
        out["focal_mm"] = f
    f35 = _num(allv.get(0xA405))
    if f35:
        out["focal35"] = f35
    xres, yres, unit = _num(allv.get(0xA20E)), _num(allv.get(0xA20F)), allv.get(0xA210)
    try:
        per_mm = {2: 25.4, 3: 10.0, 4: 1.0}.get(int(unit) if unit else 2)
    except (TypeError, ValueError):
        per_mm = None
    if xres and yres and per_mm and w and h:
        sw, sh = w / xres * per_mm, h / yres * per_mm
        if 1 < sw < 80 and 1 < sh < 80:
            out["sensor_mm"] = [round(sw, 3), round(sh, 3)]
    return out


def _exr_facts(path):
    """Camera facts from an EXR's header (OpenEXR's standard camera attributes, and any attribute naming a
    focal length or a sensor size)."""
    out = {}
    try:
        import OpenEXR
    except ImportError:
        return out
    try:
        f = OpenEXR.File(path, header_only=True) if hasattr(OpenEXR, "File") else None
        hdr = f.header() if f is not None else OpenEXR.InputFile(path).header()
    except Exception:  # noqa: BLE001
        return out
    for k, v in hdr.items():
        lk = k.lower()
        val = v
        if hasattr(v, "x") and hasattr(v, "y"):
            val = (v.x, v.y)
        if lk in ("cameramake", "make"):
            out["make"] = str(val)
        elif lk in ("cameramodel", "model", "cameraname"):
            out["model"] = str(val)
        elif lk in ("lensmodel", "lens"):
            out["lens"] = str(val)
        elif lk in ("sensorphysicalwidth",):
            out.setdefault("sensor_mm", [None, None])[0] = _num(val)
        elif lk in ("sensorphysicalheight",):
            out.setdefault("sensor_mm", [None, None])[1] = _num(val)
        elif _FOCAL_KEYS.search(lk) and "focal_mm" not in out:
            n = _num(val)
            if n and 1 <= n <= 2000:
                out["focal_mm"] = n
        elif ("sensor" in lk or "filmback" in lk) and isinstance(val, (tuple, list)) and len(val) == 2:
            a, b = _num(val[0]), _num(val[1])
            if a and b and 1 < a < 80:
                out["sensor_mm"] = [a, b]
    s = out.get("sensor_mm")
    if s and not (s[0] and s[1]):
        if s[0]:
            out["sensor_mm"] = [s[0], None]
        else:
            out.pop("sensor_mm")
    return out


def _video_facts(path):
    """Camera facts a film's container keeps (QuickTime's make / model / lens keys and the like): read from the
    file's own boxes first (``iphone_io``: an iPhone's lens and 35 mm keys, its depth track), then what PyAV
    shows."""
    out = {}
    if os.path.splitext(path)[1].lower() in (".mov", ".mp4", ".m4v", ".qt"):
        from . import iphone_io
        out = {k: v for k, v in iphone_io.film_facts(path).items() if not k.startswith("_")}
    try:
        import av
        with av.open(path) as c:
            md = dict(c.metadata or {})
            for s in c.streams.video[:1]:
                md.update({k: v for k, v in (s.metadata or {}).items() if k not in md})
                sar = getattr(s, "sample_aspect_ratio", None) or getattr(s.codec_context, "sample_aspect_ratio", None)
                if sar and float(sar) > 0 and abs(float(sar) - 1) > 1e-3:
                    out["pixel_aspect"] = round(float(sar), 6)
    except Exception:  # noqa: BLE001
        return out
    for k, v in md.items():
        lk = k.lower()
        if lk.endswith("make") and "make" not in out:
            out["make"] = str(v)
        elif lk.endswith(("model", "camera.model")) and "model" not in out and "lens" not in lk:
            out["model"] = str(v)
        elif "lens" in lk and "model" in lk:
            out["lens"] = str(v)
        elif _FOCAL_KEYS.search(lk):
            n = _num(re.sub(r"[^0-9.]", "", str(v)) or None)
            if n and 1 <= n <= 2000:
                if "35" in lk:
                    out["focal35"] = n
                else:
                    out.setdefault("focal_mm", n)
    return out


def _sidecar_facts(path):
    """A JSON beside the plate (``<plate>.camera.json`` or ``<plate>.json``) with any of: make, model, lens,
    focal_mm, focal35, sensor_mm - what a camera report gives."""
    import json
    base = re.sub(r"[._]?(#+|%0\d+d|\d+)?\.[^.]+$", "", path)
    for cand in (base + ".camera.json", path + ".json", base + ".json"):
        if os.path.isfile(cand) and os.path.getsize(cand) < 1_000_000:
            try:
                with open(cand, encoding="utf-8") as fh:
                    d = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(d, dict):
                keep = {k: d[k] for k in ("make", "model", "lens", "focal_mm", "focal35", "sensor_mm", "phone") if k in d}
                if keep:
                    keep["_file"] = os.path.basename(cand)
                    return keep
    return {}


def camera_facts(path, first_file=None, width=None, height=None):
    """What the plate says about its camera: {make, model, lens, focal_mm, focal35, sensor_mm, sensor_from,
    focal_from, fov_h, notes}. ``first_file`` is the first frame of a sequence."""
    probe = first_file or path
    ext = os.path.splitext(probe)[1].lower()
    facts, src = {}, {}
    for name, fn in (("film", _video_facts if ext in (".mp4", ".mov", ".mxf", ".mkv", ".webm", ".avi", ".m4v") else None),
                     ("EXR header", _exr_facts if ext == ".exr" else None),
                     ("HEIC", _heic_facts if ext in (".heic", ".heif", ".hif") else None),
                     ("EXIF", _exif_facts if ext in (".jpg", ".jpeg", ".tif", ".tiff", ".dng", ".png", ".webp") else None),
                     ("camera file", _sidecar_facts)):
        if not fn:
            continue
        got = fn(probe) if name != "camera file" else fn(path)
        for k, v in got.items():
            if k.startswith("_"):
                continue
            if k == "phone":
                facts.setdefault("phone", v)
                continue
            if k not in facts and v not in (None, "", []):
                facts[k] = v
                src[k] = name + (f" ({got['_file']})" if "_file" in got else "")
    notes = []
    w, h = width, height
    phone = facts.pop("phone", None)
    if phone and not (w and h) and phone.get("width") and phone.get("height"):
        w, h = phone["width"], phone["height"]           # a photo read here: its size as shown
    if phone and phone.get("rotation") in (90, 270) and w and h and w > h:
        w, h = h, w                         # shown upright: the picture is turned on playback
    a = (w / h) if w and h else 1.5

    def equivalent_frame(crop=1.0):
        # the picture's own shape on a full-frame diagonal (43.3 mm), smaller by the crop factor
        sh = FULL_FRAME_DIAGONAL / crop / math.sqrt(1 + a * a)
        return [round(sh * a, 3), round(sh, 3)]

    if "focal_mm" in facts and "focal35" in facts and "sensor_mm" not in facts and facts["focal_mm"] > 0:
        # the camera's own 35 mm equivalent says its field of view better than a sensor from a list of models
        # (a phone's lenses each have a sensor of their own, and video crops it)
        facts["sensor_mm"] = equivalent_frame(facts["focal35"] / facts["focal_mm"])
        src["sensor_mm"] = "the 35 mm equivalent focal length"
    if "focal_mm" not in facts and "focal35" in facts:
        facts["focal_mm"] = facts["focal35"]
        facts["sensor_mm"] = equivalent_frame()
        src["focal_mm"] = src.get("focal35", "")
        src["sensor_mm"] = "35 mm equivalent (the picture's shape on a full-frame diagonal)"
    if "sensor_mm" not in facts:
        s = sensor_for(facts.get("model"))
        if s:
            facts["sensor_mm"] = s
            src["sensor_mm"] = f"the {facts['model']}'s published sensor"
    if "sensor_mm" in facts and facts["sensor_mm"] and facts["sensor_mm"][1] is None and w and h:
        facts["sensor_mm"] = [facts["sensor_mm"][0], facts["sensor_mm"][0] * h / w]
    if facts.get("focal_mm") and facts.get("sensor_mm"):
        # The sensor's width as used by this picture: a picture narrower than the sensor's shape is a crop of
        # its height... the common case is the full width used.
        sw = float(facts["sensor_mm"][0])
        facts["fov_h"] = round(2 * math.degrees(math.atan(sw / 2 / float(facts["focal_mm"]))), 4)
    if "iphone" in str(facts.get("model") or "").lower() or "apple" in str(facts.get("make") or "").lower():
        notes.append("A phone's video is stabilised by cropping, so its field of view is a little narrower than its "
                     "lens says: let the solve refine the focal length.")
    if not facts.get("focal_mm"):
        notes.append("The plate does not say its focal length: give it if you know it, else the solve finds it.")
    elif not facts.get("sensor_mm"):
        notes.append("The plate gives a focal length but no sensor size: pick the camera or type the sensor width.")
    if phone:
        facts["phone"] = phone
        notes.extend(phone_notes(phone))
    facts["sources"] = src
    facts["notes"] = notes
    return facts


def _heic_facts(path):
    from . import iphone_io
    return iphone_io.photo_facts(path)


def phone_notes(phone):
    """What to tell the user about a phone's film or photo."""
    out = []
    if phone.get("tracks") is not None:            # a film
        if not phone.get("apple"):
            return out
        if phone.get("depth"):
            d = phone["depth"]
            out.append(f"Cinematic film: it carries the phone's depth ({d.get('width')} x {d.get('height')}, "
                       f"{d.get('samples')} pictures). Find the ground can use it in place of a depth model.")
        else:
            out.append("An iPhone film: it holds no depth (only Cinematic mode records one, and only the "
                       "unmodified original keeps it) and no motion samples.")
        if phone.get("motion"):
            out.append("Motion keys in the film: " + ", ".join(phone["motion"][:4]) + ".")
    elif phone.get("depth"):
        out.append("A photo with depth (" + str(phone["depth"].get("type")) + ").")
    return out


# ── pictures ─────────────────────────────────────────────────────────────────

def grey(img):
    """Brightness of a picture ([H, W, 3+] floats or bytes) as float32 0..1-ish; a 2D array passes."""
    a = np.asarray(img)
    if a.ndim == 2:
        return a.astype(np.float32)
    f = a[..., :3].astype(np.float32)
    if a.dtype == np.uint8:
        f /= 255.0
    g = f[..., 0] * LUM[0] + f[..., 1] * LUM[1] + f[..., 2] * LUM[2]
    # a linear picture is lifted towards display brightness, so shadows carry texture as the eye sees it
    return np.sqrt(np.clip(g, 0, None)) if a.dtype != np.uint8 else g


def _blur5(g):
    """The 1 4 6 4 1 blur, both ways, the edge repeated."""
    k = np.array([1, 4, 6, 4, 1], np.float32) / 16
    p = np.pad(g, ((0, 0), (2, 2)), mode="edge")
    g = sum(k[i] * p[:, i:i + g.shape[1]] for i in range(5))
    p = np.pad(g, ((2, 2), (0, 0)), mode="edge")
    return sum(k[i] * p[i:i + g.shape[0], :] for i in range(5))


def pyramid(g, levels=4, smallest=32):
    out = [np.asarray(g, np.float32)]
    for _ in range(levels - 1):
        b = _blur5(out[-1])
        if min(b.shape) // 2 < smallest:
            break
        out.append(b[::2, ::2].copy() if b.shape[0] % 2 == 0 and b.shape[1] % 2 == 0
                   else b[: b.shape[0] // 2 * 2: 2, : b.shape[1] // 2 * 2: 2].copy())
    return out


def _grads(g):
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = (g[:, 2:] - g[:, :-2]) * 0.5
    gy[1:-1, :] = (g[2:, :] - g[:-2, :]) * 0.5
    return gx, gy


def _boxsum(a, r):
    """Sum over the (2r+1)^2 window round each pixel (the edge repeated)."""
    p = np.pad(a, r + 1, mode="edge").astype(np.float64)
    s = p.cumsum(0).cumsum(1)
    n = 2 * r + 1
    h, w = a.shape
    return (s[n:n + h, n:n + w] - s[0:h, n:n + w] - s[n:n + h, 0:w] + s[0:h, 0:w])


def _local_max(a, r=1):
    """True where a pixel is the largest of its (2r+1)^2 neighbourhood."""
    p = np.pad(a, r, mode="constant", constant_values=-np.inf)
    h, w = a.shape
    m = np.ones(a.shape, bool)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx == 0 and dy == 0:
                continue
            m &= a >= p[r + dy:r + dy + h, r + dx:r + dx + w]
    return m


# ── masks ────────────────────────────────────────────────────────────────────

MASK_MODES = ("exclude", "object")


def clean_mask(m):
    """{id, name, mode, object, on, keys: [{f, pts: [[x, y], ...]}]} with at least 3 points a key, or None."""
    if not isinstance(m, dict):
        return None
    keys = []
    for k in (m.get("keys") or [])[:2000]:
        try:
            f = int(k["f"])
            pts = [[float(p[0]), float(p[1])] for p in (k.get("pts") or [])[:500]]
        except (TypeError, ValueError, KeyError, IndexError):
            continue
        if len(pts) >= 3 and all(math.isfinite(v) for p in pts for v in p):
            keys.append({"f": f, "pts": pts})
    matte = clean_matte(m.get("matte"))
    if not keys and not matte:
        return None
    keys.sort(key=lambda k: k["f"])
    mode = m.get("mode") if m.get("mode") in MASK_MODES else "exclude"
    out = {"id": str(m.get("id") or ""), "name": str(m.get("name") or "Mask")[:80], "mode": mode,
           "object": str(m.get("object") or "") if mode == "object" else "", "on": m.get("on") is not False,
           "keys": keys}
    if matte:
        out["matte"] = matte
    return out


# A matte mask: {pattern (#### = the plate's frame index), frames, threshold, grow, invert, width?, height?}; the
# page's cleanMatte. A frame between its frames takes the nearest earlier one (else its first).

def clean_matte(t):
    if not isinstance(t, dict) or not isinstance(t.get("pattern"), str) or "#" not in t["pattern"]:
        return None
    frames = set()
    for f in (t.get("frames") or [])[:100000]:
        try:
            f = int(f)
        except (TypeError, ValueError):
            continue
        if f >= 0:
            frames.add(f)
    if not frames:
        return None

    def num(k, d, lo, hi):
        try:
            v = float(t.get(k, d))
        except (TypeError, ValueError):
            v = d
        return min(hi, max(lo, v)) if math.isfinite(v) else d
    out = {"pattern": t["pattern"], "frames": sorted(frames), "threshold": num("threshold", 0.5, 0.01, 0.99),
           "grow": int(round(num("grow", 6, 0, 64))), "invert": bool(t.get("invert"))}
    try:
        if int(t.get("width") or 0) > 0 and int(t.get("height") or 0) > 0:
            out["width"], out["height"] = int(t["width"]), int(t["height"])
    except (TypeError, ValueError):
        pass
    return out


def matte_path(pattern, f):
    """The file of a matte's frame: the pattern's last run of # filled with the number."""
    m = list(re.finditer(r"#+", pattern))
    if not m:
        return pattern
    r = m[-1]
    return pattern[:r.start()] + str(int(f)).zfill(r.end() - r.start()) + pattern[r.end():]


def matte_frame_at(matte, f):
    fs = matte["frames"]
    got = fs[0]
    for x in fs:
        if x <= f:
            got = x
        else:
            break
    return got


_MATTES = {}
_MATTE_KEEP = 64


def _grow(b, r):
    """A boolean picture widened by r pixels (a square)."""
    if r <= 0:
        return b
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(b.astype(np.int32), pad), axis=axis)
        n = b.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        b = (hi - lo) > 0
    return b


def matte_mask(matte, f):
    """The boolean picture of a matte at frame f (masked = True), or None when its file is not there."""
    path = matte_path(matte["pattern"], matte_frame_at(matte, f))
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_mtime_ns, st.st_size, matte["threshold"], matte["grow"], matte["invert"])
    got = _MATTES.get(key)
    if got is None:
        from PIL import Image
        with Image.open(path) as im:
            g = np.asarray(im.convert("L"), np.uint8)
        b = g >= int(round(matte["threshold"] * 255))
        if matte["invert"]:
            b = ~b
        got = _grow(b, matte["grow"])
        _MATTES[key] = got
        while len(_MATTES) > _MATTE_KEEP:
            _MATTES.pop(next(iter(_MATTES)))
    return got


def matte_hit(matte, f, pts):
    """Which of pts (plate pixels, [N, 2]) lie on the matte at frame f."""
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    b = matte_mask(matte, f)
    if b is None or not len(pts):
        return np.zeros(len(pts), bool)
    h, w = b.shape
    sx = w / matte["width"] if matte.get("width") else 1.0
    sy = h / matte["height"] if matte.get("height") else 1.0
    x = np.floor(pts[:, 0] * sx).astype(np.int64)
    y = np.floor(pts[:, 1] * sy).astype(np.int64)
    ok = (x >= 0) & (x < w) & (y >= 0) & (y < h) & np.isfinite(pts).all(1)
    out = np.zeros(len(pts), bool)
    out[ok] = b[y[ok], x[ok]]
    return out


def mask_at(mask, f):
    """The polygon of a mask at frame f: held before its first key and after its last, straight in between (when
    the two keys have as many points; else the earlier key's)."""
    ks = mask["keys"]
    if f <= ks[0]["f"]:
        return np.asarray(ks[0]["pts"], np.float64)
    if f >= ks[-1]["f"]:
        return np.asarray(ks[-1]["pts"], np.float64)
    for a, b in zip(ks, ks[1:]):
        if a["f"] <= f <= b["f"]:
            A = np.asarray(a["pts"], np.float64)
            if len(a["pts"]) != len(b["pts"]):
                return A
            t = (f - a["f"]) / max(1, b["f"] - a["f"])
            return A + (np.asarray(b["pts"], np.float64) - A) * t
    return np.asarray(ks[-1]["pts"], np.float64)


def inside(poly, pts):
    """Which of pts ([N, 2]) lie inside the polygon (even-odd)."""
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    x, y = pts[:, 0][:, None], pts[:, 1][:, None]
    p = np.asarray(poly, np.float64)
    x1, y1 = p[:, 0][None, :], p[:, 1][None, :]
    q = np.roll(p, -1, 0)
    x2, y2 = q[:, 0][None, :], q[:, 1][None, :]
    cross = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / np.where(y2 - y1 == 0, 1e-12, y2 - y1) + x1)
    return (cross.sum(1) % 2) == 1


def masks_state(masks, f, pts):
    """For each point: "" (free), "exclude" (under an exclude mask) or "obj:<id>" (under an object's mask)."""
    out = np.array([""] * len(pts), dtype=object)
    for m in masks or []:
        if not m.get("on", True):
            continue
        hit = matte_hit(m["matte"], f, pts) if m.get("matte") else inside(mask_at(m, f), pts)
        if m["mode"] == "exclude":
            out[hit] = "exclude"
        else:
            free = hit & (out != "exclude")
            out[free] = "obj:" + m["object"]
    return out


# ── features ─────────────────────────────────────────────────────────────────

def corner_response(g, r=2):
    """The smaller eigenvalue of the structure tensor over a (2r+1)^2 window."""
    gx, gy = _grads(np.asarray(g, np.float32))
    sxx, syy, sxy = _boxsum(gx * gx, r), _boxsum(gy * gy, r), _boxsum(gx * gy, r)
    return (sxx + syy) / 2 - np.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy)


def detect_features(g, n=200, min_dist=20, margin=12, quality=0.01, avoid=None, keep=None, cells=(8, 6)):
    """Up to ``n`` corners of grey picture g ([[x, y]], pixel centres at +0.5), at least ``min_dist`` apart and
    from the points in ``avoid``, spread over a grid of ``cells``; ``keep(pts) -> bool[]`` may refuse some (masks)."""
    g = np.asarray(g, np.float32)
    h, w = g.shape
    resp = corner_response(g)
    resp[:margin, :] = 0
    resp[-margin:, :] = 0
    resp[:, :margin] = 0
    resp[:, -margin:] = 0
    top = float(np.percentile(resp, 99.9)) if resp.size else 0
    if top <= 0:
        return np.zeros((0, 2))
    cand = _local_max(resp, 2) & (resp > top * quality)
    ys, xs = np.nonzero(cand)
    if not len(xs):
        return np.zeros((0, 2))
    vals = resp[ys, xs]
    order = np.argsort(-vals)
    xs, ys, vals = xs[order], ys[order], vals[order]
    pts = np.c_[xs + 0.5, ys + 0.5].astype(np.float64)
    if keep is not None and len(pts):
        ok = np.asarray(keep(pts), bool)
        pts, vals = pts[ok], vals[ok]
    # an even spread: each cell takes its share first, then the rest by strength
    cw, ch = w / cells[0], h / cells[1]
    per = max(1, int(math.ceil(n / (cells[0] * cells[1]))))
    cell = (np.minimum(cells[0] - 1, (pts[:, 0] / cw).astype(int)) * cells[1]
            + np.minimum(cells[1] - 1, (pts[:, 1] / ch).astype(int))) if len(pts) else np.zeros(0, int)
    taken = []
    occupied = {}
    g2 = max(1.0, float(min_dist))

    def free(p):
        cx, cy = int(p[0] // g2), int(p[1] // g2)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in occupied.get((cx + dx, cy + dy), ()):
                    if (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < g2 * g2:
                        return False
        return True

    def take(p):
        occupied.setdefault((int(p[0] // g2), int(p[1] // g2)), []).append(p)
        taken.append(p)

    for p in (avoid if avoid is not None else []):
        occupied.setdefault((int(p[0] // g2), int(p[1] // g2)), []).append(tuple(p))
    counts = {}
    for rnd in (0, 1):
        for i, p in enumerate(pts):
            if len(taken) >= n:
                break
            c = int(cell[i])
            if rnd == 0 and counts.get(c, 0) >= per:
                continue
            tp = (float(p[0]), float(p[1]))
            if tp in taken or not free(tp):
                continue
            take(tp)
            counts[c] = counts.get(c, 0) + 1
    return np.asarray(taken, np.float64).reshape(-1, 2)


# ── Lucas-Kanade ─────────────────────────────────────────────────────────────

def _sample(g, x, y):
    """Bilinear, pixel centres at +0.5, the edge repeated; x, y any shape."""
    return T.sample(g, x, y)


def lk(pyr0, pyr1, pts, guess=None, win=7, iters=12):
    """Where pts of the picture of pyramid pyr0 are in pyr1: (new [N, 2], ok [N] bool, residual [N]).
    ``guess`` [N, 2] is where to start looking (default: where they were)."""
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    n = len(pts)
    if not n:
        return pts.copy(), np.zeros(0, bool), np.zeros(0)
    L = len(pyr0)
    d = (np.zeros_like(pts) if guess is None else np.asarray(guess, np.float64) - pts) / (2 ** (L - 1))
    o = np.arange(-win, win + 1, dtype=np.float64)
    ox, oy = np.meshgrid(o, o)
    ox, oy = ox.ravel()[None, :], oy.ravel()[None, :]
    ok = np.ones(n, bool)
    res = np.zeros(n)
    for lvl in range(L - 1, -1, -1):
        g0, g1 = pyr0[lvl], pyr1[lvl]
        s = 2.0 ** lvl
        p = pts / s
        px, py = p[:, 0:1] + ox, p[:, 1:2] + oy
        gx0, gy0 = _grads(g0)
        Tm = _sample(g0, px, py)
        Ix, Iy = _sample(gx0, px, py), _sample(gy0, px, py)
        Tm = Tm - Tm.mean(1, keepdims=True)
        Gxx, Gyy, Gxy = (Ix * Ix).sum(1), (Iy * Iy).sum(1), (Ix * Iy).sum(1)
        det = Gxx * Gyy - Gxy * Gxy
        lam = (Gxx + Gyy) / 2 - np.sqrt(((Gxx - Gyy) / 2) ** 2 + Gxy ** 2)
        good = (det > 1e-12) & (lam > 1e-6 * ox.size)
        if lvl == 0:
            ok &= good
        inv = np.where(good, 1.0 / np.where(good, det, 1), 0)
        for _ in range(iters):
            I = _sample(g1, px + d[:, 0:1], py + d[:, 1:2])
            e = Tm - (I - I.mean(1, keepdims=True))
            bx, by = (Ix * e).sum(1), (Iy * e).sum(1)
            dx = inv * (Gyy * bx - Gxy * by)
            dy = inv * (Gxx * by - Gxy * bx)
            d[:, 0] += dx
            d[:, 1] += dy
            if np.max(np.abs(dx) + np.abs(dy)) < 0.01:
                break
        if lvl == 0:
            res = np.sqrt((e * e).mean(1))
        else:
            d *= 2
    new = pts + d
    h, w = pyr1[0].shape
    ok &= (new[:, 0] > 1) & (new[:, 1] > 1) & (new[:, 0] < w - 1) & (new[:, 1] < h - 1) & np.isfinite(new).all(1)
    return new, ok, res


def patch_ncc(g0, p0, g1, p1, win=7):
    """Normalised correlation of the patches round p0 in g0 and p1 in g1 (per point)."""
    o = np.arange(-win, win + 1, dtype=np.float64)
    ox, oy = np.meshgrid(o, o)
    ox, oy = ox.ravel()[None, :], oy.ravel()[None, :]
    a = _sample(g0, p0[:, 0:1] + ox, p0[:, 1:2] + oy)
    b = _sample(g1, p1[:, 0:1] + ox, p1[:, 1:2] + oy)
    a = a - a.mean(1, keepdims=True)
    b = b - b.mean(1, keepdims=True)
    den = np.sqrt((a * a).sum(1) * (b * b).sum(1))
    return np.where(den > 1e-12, (a * b).sum(1) / np.where(den > 1e-12, den, 1), 0)


def auto_track(get, frames, n=200, min_dist=None, masks=None, fb=1.0, min_ncc=0.75, refill=0.7,
               prefix="t", cancel=None, progress=None, start_id=1, group_of=None):
    """Find features and follow them through ``frames`` (in order, either way); ``get(f)`` gives the picture.

    Returns [{id, name, group, keys: [[f, x, y, score]]}]. A point under an exclude mask is not started and stops
    when it goes under one; a point started under an object's mask belongs to that object (group = its id, else
    "camera"). New features are added when fewer than ``refill`` x n are alive."""
    frames = list(frames)
    if not frames:
        return []
    masks = [m for m in (clean_mask(m) for m in masks or []) if m]
    g = grey(get(frames[0]))
    h, w = g.shape
    md = min_dist or max(8, int(math.sqrt(w * h / max(1, n)) * 0.5))
    pyr = pyramid(g)
    tracks = []
    alive = []          # indices into tracks
    pos = np.zeros((0, 2))
    vel = np.zeros((0, 2))
    nid = [start_id]

    def start(gg, f, avoid):
        def keep(pts):
            st = masks_state(masks, f, pts)
            return st != "exclude"
        new = detect_features(gg, n=n - len(alive), min_dist=md, avoid=avoid, keep=keep)
        if not len(new):
            return np.zeros((0, 2))
        st = masks_state(masks, f, new)
        for i, p in enumerate(new):
            grp = st[i][4:] if str(st[i]).startswith("obj:") else "camera"
            tid = f"{prefix}{nid[0]}"
            nid[0] += 1
            tracks.append({"id": tid, "name": tid, "group": grp, "auto": True,
                           "keys": [[int(f), round(float(p[0]), 3), round(float(p[1]), 3), 1.0]]})
            alive.append(len(tracks) - 1)
        return new

    got = start(g, frames[0], None)
    pos = got.copy()
    vel = np.zeros_like(pos)
    if progress:
        progress(0, len(tracks))
    for k, f in enumerate(frames[1:], 1):
        if cancel and cancel():
            break
        g1 = grey(get(f))
        pyr1 = pyramid(g1)
        if len(alive):
            new, ok, _ = lk(pyr, pyr1, pos, guess=pos + vel)
            back, ok2, _ = lk(pyr1, pyr, new)
            fbe = np.sqrt(((back - pos) ** 2).sum(1))
            ncc = patch_ncc(pyr[0], pos, pyr1[0], new)
            good = ok & ok2 & (fbe < fb) & (ncc > min_ncc)
            if masks:
                st = masks_state(masks, f, new)
                for i, ti in enumerate(alive):
                    grp = tracks[ti]["group"]
                    if st[i] == "exclude" or (grp != "camera" and st[i] != "obj:" + grp and good[i] and _mask_owned(masks, grp)):
                        good[i] = False
            keep_alive = []
            for i, ti in enumerate(alive):
                if good[i]:
                    tracks[ti]["keys"].append([int(f), round(float(new[i, 0]), 3), round(float(new[i, 1]), 3),
                                               round(float(ncc[i]), 3)])
                    keep_alive.append(i)
            alive[:] = [alive[i] for i in keep_alive]
            vel = (new - pos)[keep_alive]
            pos = new[keep_alive]
        if len(alive) < refill * n and len(tracks) < MAX_TRACKS:
            added = start(g1, f, [tuple(p) for p in pos])
            pos = np.r_[pos, added] if len(added) else pos
            vel = np.r_[vel, np.zeros_like(added)] if len(added) else vel
        pyr = pyr1
        if progress:
            progress(k, len(tracks))
    # one-frame tracks say nothing
    return [t for t in tracks if len(t["keys"]) >= 2]


# ── tracking a hard shot: new points on any frame, forwards, backwards or both ─────────────────

DIRECTIONS = ("forward", "backward", "both")


def track_shot(get, lo, hi, seeds, n=200, direction="both", existing=None, extend=None, masks=None,
               fb=1.0, min_ncc=0.75, refill=0.7, min_dist=None, prefix="t", start_id=1, follow_new=True,
               groups=None, cancel=None, progress=None):
    """Track frames lo..hi of a shot from the frames in ``seeds``, ``direction`` forward | backward | both.

    At each seed frame new features are found where the tracks there (``existing`` and the ones found so far)
    are fewer than n, and followed in the direction(s) asked; when fewer than ``refill`` x n are alive on a
    frame, new ones are found there too. With ``follow_new`` a feature found part way along a pass is then
    followed the other way as well, back to the range's end, so every track is as long as the picture lets it
    be. ``existing`` = {id: {f: (x, y)}} (the shot's tracks: kept clear of, and counted); ``extend`` = ids of
    those to carry on past their last key (forward) and before their first (backward), as the direction says.
    ``seeds`` None = the frame the direction starts at; [] = no new features (only carrying on).

    Returns {"tracks": [{id, name, group, auto, keys}], "extended": {id: [[f, x, y, score], ...]}} - the
    extended keys are only the new ones, outside the track's own span."""
    if direction not in DIRECTIONS:
        direction = "both"
    lo, hi = int(min(lo, hi)), int(max(lo, hi))
    masks = [m for m in (clean_mask(m) for m in masks or []) if m]
    existing = existing or {}
    fwd, bwd = direction in ("forward", "both"), direction in ("backward", "both")
    tracks = []                    # {id, group, keys: {f: [x, y, s]}, born, ext}
    nid = [start_id]
    done = [0]
    pyr_cache = {}

    def pyr_of(f):
        if f not in pyr_cache:
            if len(pyr_cache) > 6:
                pyr_cache.pop(next(iter(pyr_cache)))
            pyr_cache[f] = pyramid(grey(get(f)))
        return pyr_cache[f]

    w = h = None
    md = min_dist

    def taken_at(f, skip=()):
        pts = [xy[f] for tid, xy in existing.items() if f in xy and tid not in skip]
        pts += [t["keys"][f][:2] for t in tracks if f in t["keys"]]
        return pts

    def seed(f):
        """New features at f (kept clear of every track there); their indices into ``tracks``."""
        nonlocal w, h, md
        g = pyr_of(f)[0]
        if w is None:
            h, w = g.shape
            md = md or max(8, int(math.sqrt(w * h / max(1, n)) * 0.5))
        avoid = [tuple(p) for p in taken_at(f)]          # the tracks alive here are among them
        want = n - len(avoid)
        if want <= 0 or len(tracks) >= MAX_TRACKS:
            return []
        new = detect_features(g, n=min(want, MAX_TRACKS - len(tracks)), min_dist=md, avoid=avoid or None,
                              keep=lambda pts: masks_state(masks, f, pts) != "exclude")
        if not len(new):
            return []
        st = masks_state(masks, f, new)
        out = []
        for i, p in enumerate(new):
            grp = st[i][4:] if str(st[i]).startswith("obj:") else "camera"
            tid = f"{prefix}{nid[0]}"
            nid[0] += 1
            tracks.append({"id": tid, "group": grp, "keys": {int(f): [float(p[0]), float(p[1]), 1.0]},
                           "born": int(f), "ext": False})
            out.append(len(tracks) - 1)
        return out

    def sweep(frames, starts, reseed):
        """Follow tracks through ``frames`` (in order): ``starts`` {f: [track index]} join where they are at f;
        with ``reseed`` new features are found on thin frames. Returns the indices of the tracks born here."""
        born = []
        alive, pos, vel = [], np.zeros((0, 2)), np.zeros((0, 2))
        for k, f in enumerate(frames):
            if cancel and cancel():
                break
            joining = [i for i in starts.get(f, []) if i not in alive]
            if joining:
                alive += joining
                pos = np.r_[pos, [tracks[i]["keys"][f][:2] for i in joining]]
                vel = np.r_[vel, np.zeros((len(joining), 2))]
            if k + 1 >= len(frames):
                break
            f1 = frames[k + 1]
            pyr, pyr1 = pyr_of(f), pyr_of(f1)
            if alive:
                new, ok, _ = lk(pyr, pyr1, pos, guess=pos + vel)
                back, ok2, _ = lk(pyr1, pyr, new)
                fbe = np.sqrt(((back - pos) ** 2).sum(1))
                ncc = patch_ncc(pyr[0], pos, pyr1[0], new)
                good = ok & ok2 & (fbe < fb) & (ncc > min_ncc)
                if masks:
                    st = masks_state(masks, f1, new)
                    for i, ti in enumerate(alive):
                        grp = tracks[ti]["group"]
                        if st[i] == "exclude" or (grp != "camera" and st[i] != "obj:" + grp and good[i]
                                                  and _mask_owned(masks, grp)):
                            good[i] = False
                keep = []
                for i, ti in enumerate(alive):
                    # a track that runs into keys it already has (another pass) stops there
                    if good[i] and f1 not in tracks[ti]["keys"]:
                        tracks[ti]["keys"][int(f1)] = [float(new[i, 0]), float(new[i, 1]), float(ncc[i])]
                        keep.append(i)
                alive = [alive[i] for i in keep]
                vel = (new - pos)[keep]
                pos = new[keep]
            if reseed and len(tracks) < MAX_TRACKS:
                if len(taken_at(f1)) < refill * n:
                    got = seed(f1)
                    if got:
                        born += got
                        alive += got
                        pos = np.r_[pos, [tracks[i]["keys"][f1][:2] for i in got]]
                        vel = np.r_[vel, np.zeros((len(got), 2))]
            done[0] += 1
            if progress:
                progress(done[0], len(tracks))
        return born

    up = list(range(lo, hi + 1))
    down = up[::-1]

    # carry on the tracks asked for, from their ends
    if extend:
        ext_f, ext_b = {}, {}
        for tid in extend:
            xy = existing.get(tid)
            if not xy:
                continue
            first, last = min(xy), max(xy)
            grp = (groups or {}).get(tid, "camera")
            for f0, side, store in ((last, fwd, ext_f), (first, bwd, ext_b)):
                if side and lo <= f0 <= hi:
                    tracks.append({"id": tid, "group": grp, "keys": {int(f0): [*map(float, xy[f0]), 1.0]},
                                   "born": int(f0), "ext": True})
                    store.setdefault(f0, []).append(len(tracks) - 1)
        if ext_f:
            sweep([f for f in up if f >= min(ext_f)], ext_f, False)
        if ext_b:
            sweep([f for f in down if f <= max(ext_b)], ext_b, False)

    # new features from each seed frame
    for s in sorted({max(lo, min(hi, int(f))) for f in (seeds if seeds is not None else [lo if fwd else hi])}):
        if cancel and cancel():
            break
        first = seed(s)
        born = []
        if fwd:
            born += [(i, "f") for i in sweep([f for f in up if f >= s], {s: first}, True)]
        if bwd:
            born += [(i, "b") for i in sweep([f for f in down if f <= s], {s: first}, True)]
        if follow_new and direction == "both":
            # found part way along: follow them the other way too
            back_starts, fwd_starts = {}, {}
            for i, way in born:
                (back_starts if way == "f" else fwd_starts).setdefault(tracks[i]["born"], []).append(i)
            if back_starts:
                sweep([f for f in down if f <= max(back_starts)], back_starts, False)
            if fwd_starts:
                sweep([f for f in up if f >= min(fwd_starts)], fwd_starts, False)

    def keys_of(t, skip=None):
        return [[f, round(v[0], 3), round(v[1], 3), round(v[2], 3)] for f, v in sorted(t["keys"].items())
                if skip is None or f not in skip]

    out, extended = [], {}
    for t in tracks:
        if t["ext"]:
            ks = keys_of(t, existing.get(t["id"], {}))
            if ks:
                extended.setdefault(t["id"], []).extend(ks)
        elif len(t["keys"]) >= 2:          # one-frame tracks say nothing
            out.append({"id": t["id"], "name": t["id"], "group": t["group"], "auto": True, "keys": keys_of(t)})
    for tid in extended:
        extended[tid].sort(key=lambda k: k[0])
    return {"tracks": out, "extended": extended}


def track_cost(lo, hi, seeds, direction, extend):
    """About how many frame steps track_shot takes (for its progress bar)."""
    span = abs(hi - lo) + 1
    per = span * (2 if direction == "both" else 1)
    return max(1, per * max(1, len(seeds or [0])) + (per if extend else 0))


def existing_tracks(raw, limit=MAX_TRACKS):
    """A page's tracks as ({id: {f: (x, y)}}, {id: group}): what track_shot keeps clear of and carries on."""
    out, groups = {}, {}
    for t in clean_tracks(raw, limit):
        xy = {k[0]: (k[1], k[2]) for k in t["keys"]}
        if xy:
            out[t["id"]] = xy
            groups[t["id"]] = t["group"]
    return out, groups


def _mask_owned(masks, grp):
    return any(m["mode"] == "object" and m["object"] == grp for m in masks)


def clean_tracks(tracks, limit=MAX_TRACKS):
    """[{id, name, group, on, keys: [[f, x, y, score]], manual?}] as the solve reads them."""
    out = []
    for t in (tracks or [])[:limit]:
        if not isinstance(t, dict):
            continue
        keys = []
        for k in (t.get("keys") or [])[:100000]:
            try:
                f, x, y = int(k[0]), float(k[1]), float(k[2])
                s = float(k[3]) if len(k) > 3 else 1.0
            except (TypeError, ValueError, IndexError):
                continue
            if math.isfinite(x) and math.isfinite(y):
                keys.append([f, x, y, s])
        keys.sort(key=lambda k: k[0])
        dedup = []
        for k in keys:
            if dedup and dedup[-1][0] == k[0]:
                dedup[-1] = k
            else:
                dedup.append(k)
        out.append({"id": str(t.get("id") or f"t{len(out) + 1}"), "name": str(t.get("name") or "")[:80],
                    "group": str(t.get("group") or "camera"), "on": t.get("on") is not False, "keys": dedup})
    return out


# ── the lens grid ────────────────────────────────────────────────────────────

def _blur_gauss(g, sigma):
    if sigma <= 0.3:
        return g
    r = int(math.ceil(sigma * 3))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-x * x / (2 * sigma * sigma))
    k /= k.sum()
    p = np.pad(g, ((0, 0), (r, r)), mode="edge")
    g = sum(k[i] * p[:, i:i + g.shape[1]] for i in range(2 * r + 1))
    p = np.pad(g, ((r, r), (0, 0)), mode="edge")
    return sum(k[i] * p[i:i + g.shape[0], :] for i in range(2 * r + 1))


def grid_points(g, kind="checker", sigma=None):
    """The crossings of a chart in grey picture g: [[x, y]] (pixel centres at +0.5). ``kind`` checker = the
    saddles where four squares meet; lines = where light (or dark) lines cross."""
    g = np.asarray(g, np.float32)
    h, w = g.shape
    s = sigma or max(1.2, min(w, h) / 700.0)
    b = _blur_gauss(g, s)
    gx, gy = _grads(b)
    gxx, gxy = _grads(gx)
    _, gyy = _grads(gy)
    det = gxx * gyy - gxy * gxy
    if kind == "lines":
        tr = gxx + gyy
        sign = -1.0 if float(np.sum(np.clip(-tr, 0, None))) >= float(np.sum(np.clip(tr, 0, None))) else 1.0
        resp = np.where(sign * tr > 0, np.clip(det, 0, None), 0)
    else:
        resp = np.clip(-det, 0, None)
    m = int(max(4, 3 * s))
    resp[:m] = 0
    resp[-m:] = 0
    resp[:, :m] = 0
    resp[:, -m:] = 0
    r = max(2, int(round(2 * s)))
    peaks = _local_max(resp, r) & (resp > 0)
    vals = np.sort(resp[peaks])[::-1]
    if not len(vals):
        return np.zeros((0, 2))
    # the chart's crossings are the strong peaks; noise and texture make many weak ones
    top = float(np.median(vals[: min(len(vals), 40)]))
    cand = peaks & (resp > top * 0.15)
    ys, xs = np.nonzero(cand)
    if not len(xs):
        return np.zeros((0, 2))
    # a fraction of a pixel: a parabola through each peak and its neighbours, both ways
    c = resp[ys, xs]
    l, rr = resp[ys, np.maximum(xs - 1, 0)], resp[ys, np.minimum(xs + 1, w - 1)]
    u, dd = resp[np.maximum(ys - 1, 0), xs], resp[np.minimum(ys + 1, h - 1), xs]
    den_x, den_y = l - 2 * c + rr, u - 2 * c + dd
    ox = np.where(np.abs(den_x) > 1e-12, 0.5 * (l - rr) / np.where(np.abs(den_x) > 1e-12, den_x, 1), 0)
    oy = np.where(np.abs(den_y) > 1e-12, 0.5 * (u - dd) / np.where(np.abs(den_y) > 1e-12, den_y, 1), 0)
    pts = np.c_[xs + 0.5 + np.clip(ox, -0.5, 0.5), ys + 0.5 + np.clip(oy, -0.5, 0.5)]
    order = np.argsort(-c)
    return pts[order][:6000]


def _directions(pts):
    """The two directions the lattice runs in (unit vectors) and its spacing, from each point's nearest
    neighbours."""
    n = len(pts)
    d2 = ((pts[:, None, :] - pts[None, :, :]) ** 2).sum(2)
    np.fill_diagonal(d2, np.inf)
    nn = np.argsort(d2, 1)[:, :4]
    vec = pts[nn] - pts[:, None, :]
    dist = np.sqrt((vec ** 2).sum(2))
    spacing = float(np.median(dist[:, 0]))
    sel = dist < spacing * 1.6
    v = vec[sel]
    ang = np.mod(np.arctan2(v[:, 1], v[:, 0]), math.pi)
    hist, edges = np.histogram(ang, bins=180, range=(0, math.pi))
    k = np.array([1, 2, 3, 2, 1], float)
    sm = np.convolve(np.r_[hist[-2:], hist, hist[:2]], k, "same")[2:-2]
    a1 = int(np.argmax(sm))
    dist_bins = np.minimum(np.abs(np.arange(180) - a1), 180 - np.abs(np.arange(180) - a1))
    sm2 = np.where(dist_bins > 25, sm, -1)
    a2 = int(np.argmax(sm2))
    t1, t2 = (a1 + 0.5) * math.pi / 180, (a2 + 0.5) * math.pi / 180
    return np.array([math.cos(t1), math.sin(t1)]), np.array([math.cos(t2), math.sin(t2)]), spacing, d2


def grid_lattice(pts, centre=None):
    """Put the crossings in rows and columns: [(i, j, x, y)], walking from the point nearest ``centre`` to the
    neighbour each step predicts (so a strongly bent grid is still followed)."""
    pts = np.asarray(pts, np.float64)
    if len(pts) < 9:
        return []
    if len(pts) > 2500:
        pts = pts[:2500]
    a_dir, b_dir, sp, d2 = _directions(pts)
    c = np.asarray(centre if centre is not None else pts.mean(0))
    seed = int(np.argmin(((pts - c) ** 2).sum(1)))

    def nearest_to(q, tol):
        dd = ((pts - q) ** 2).sum(1)
        i = int(np.argmin(dd))
        return i if dd[i] < tol * tol else -1

    idx = {seed: (0, 0)}
    at = {(0, 0): seed}
    vec = {seed: (a_dir * sp, b_dir * sp)}
    # the seed's own vectors, from its real neighbours
    for k, dvec in enumerate((a_dir * sp, b_dir * sp)):
        j = nearest_to(pts[seed] + dvec, sp * 0.4)
        if j >= 0:
            va, vb = vec[seed]
            vec[seed] = (pts[j] - pts[seed], vb) if k == 0 else (va, pts[j] - pts[seed])
    queue = [seed]
    while queue:
        p = queue.pop(0)
        i, j = idx[p]
        va, vb = vec[p]
        for di, dj, step in ((1, 0, va), (-1, 0, -va), (0, 1, vb), (0, -1, -vb)):
            key = (i + di, j + dj)
            if key in at:
                continue
            tol = 0.33 * min(np.hypot(*va), np.hypot(*vb))
            q = nearest_to(pts[p] + step, tol)
            if q < 0 or q in idx:
                continue
            idx[q] = key
            at[key] = q
            d = pts[q] - pts[p]
            nva = d * di if di else va
            nvb = d * dj if dj else vb
            vec[q] = (nva, nvb)
            queue.append(q)
    return [(ij[0], ij[1], float(pts[q][0]), float(pts[q][1])) for ij, q in at.items()]


def _nelder_mead(f, x0, steps, iters=600, tol=1e-12):
    x0 = np.asarray(x0, np.float64)
    n = len(x0)
    simplex = [x0] + [x0 + np.eye(n)[i] * steps[i] for i in range(n)]
    vals = [f(s) for s in simplex]
    for it in range(iters):
        order = np.argsort(vals)
        simplex = [simplex[i] for i in order]
        vals = [vals[i] for i in order]
        if it > 30 and abs(vals[-1] - vals[0]) <= tol * max(1e-30, abs(vals[0])):
            break
        cen = np.mean(simplex[:-1], 0)
        xr = cen + (cen - simplex[-1])
        fr = f(xr)
        if fr < vals[0]:
            xe = cen + 2 * (cen - simplex[-1])
            fe = f(xe)
            if fe < fr:
                simplex[-1], vals[-1] = xe, fe
            else:
                simplex[-1], vals[-1] = xr, fr
            continue
        if fr < vals[-2]:
            simplex[-1], vals[-1] = xr, fr
            continue
        xc = cen + 0.5 * (simplex[-1] - cen) if fr >= vals[-1] else cen + 0.5 * (xr - cen)
        fc = f(xc)
        if fc < min(fr, vals[-1]):
            simplex[-1], vals[-1] = xc, fc
            continue
        for i in range(1, n + 1):
            simplex[i] = simplex[0] + 0.5 * (simplex[i] - simplex[0])
            vals[i] = f(simplex[i])
    k = int(np.argmin(vals))
    return simplex[k], vals[k]


def undistort_points(pts, lens, w, h):
    """Plate pixels -> where they would be without the lens (comp_warp's model)."""
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    if not lens or not (lens.get("k1") or lens.get("k2")):
        return pts.copy()
    c = lens.get("center") or [w / 2, h / 2]
    R = math.hypot(w, h) / 2
    ux, uy = WP.lens_points(pts[:, 0], pts[:, 1], "undistort", float(lens.get("k1") or 0),
                            float(lens.get("k2") or 0), float(c[0]), float(c[1]), R)
    return np.c_[ux, uy]


def distort_points(pts, lens, w, h):
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    if not lens or not (lens.get("k1") or lens.get("k2")):
        return pts.copy()
    c = lens.get("center") or [w / 2, h / 2]
    R = math.hypot(w, h) / 2
    dx, dy = WP.lens_points(pts[:, 0], pts[:, 1], "distort", float(lens.get("k1") or 0),
                            float(lens.get("k2") or 0), float(c[0]), float(c[1]), R)
    return np.c_[dx, dy]


def _grid_cost(grids, k1, k2, cx, cy, R):
    tot, n = 0.0, 0
    Hs = []
    for lat in grids:
        ij = lat[:, :2]
        xy = lat[:, 2:]
        ux, uy = WP.lens_points(xy[:, 0], xy[:, 1], "undistort", k1, k2, cx, cy, R)
        u = np.c_[ux, uy]
        H = T.fit_homography(ij, u)
        if H is None:
            return 1e30, []
        r = T.apply(H, ij) - u
        tot += float((r * r).sum())
        n += len(r)
        Hs.append(H)
    return tot / max(1, n), Hs


def focal_from_homographies(Hs, w, h, cx=None, cy=None):
    """The focal length (pixels) a planar chart's projective maps imply, square pixels, centre (cx, cy): from
    h1' W h2 = 0 and h1' W h1 = h2' W h2 with W = diag(1/f^2, 1/f^2, 1) (the image of the absolute conic). None
    when the chart faces the camera too squarely to tell."""
    cx = w / 2 if cx is None else cx
    cy = h / 2 if cy is None else cy
    A, b = [], []
    Tm = np.array([[1, 0, -cx], [0, 1, -cy], [0, 0, 1.0]])
    for H in Hs:
        Hc = Tm @ H
        h1, h2 = Hc[:, 0], Hc[:, 1]
        # unknown a = 1 / f^2:  a (h1x h2x + h1y h2y) + h1z h2z = 0
        A.append(h1[0] * h2[0] + h1[1] * h2[1])
        b.append(-h1[2] * h2[2])
        A.append(h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2)
        b.append(-(h1[2] ** 2 - h2[2] ** 2))
    A, b = np.asarray(A), np.asarray(b)
    scale = np.abs(A).max() or 1
    den = float((A * A).sum())
    if den <= 1e-30:
        return None
    a = float((A * b).sum()) / den
    # too square to the camera: the equations hardly constrain a
    if a <= 0 or math.sqrt(den) / scale < 1e-3:
        return None
    f = 1 / math.sqrt(a)
    if not (0.1 * max(w, h) < f < 50 * max(w, h)):
        return None
    return f


def solve_lens_grid(pictures, w, h, kind="auto", fit_center=False, use_k2=True):
    """The lens from one or more pictures of a chart ([grey]); returns {k1, k2, center, error (px), points,
    coverage (how far out the chart reaches, 1 = the corners), focal_px?, lattices: [[[i, j, x, y]]], notes}."""
    grids = []
    for g in pictures:
        best = []
        s0 = max(1.2, min(w, h) / 700.0)
        for kd in (("checker", "lines") if kind == "auto" else (kind,)):
            # a line grid's crossings show at about the lines' width: a few blurs are tried
            for sig in ((s0, 2.5 * s0) if kd == "checker" else (s0, 2.5 * s0, 5 * s0, 8 * s0)):
                pts = grid_points(g, kd, sigma=sig)
                lat = grid_lattice(pts, centre=(w / 2, h / 2))
                if len(lat) > len(best):
                    best = lat
        if len(best) >= 16:
            grids.append(np.asarray(best, np.float64))
    notes = []
    if not grids:
        return {"error": None, "points": 0, "notes": ["No chart was found: a checkerboard or a grid of lines, "
                                                       "sharp and filling the frame, finds best."]}
    R = math.hypot(w, h) / 2
    two = bool(use_k2) and sum(len(gd) for gd in grids) >= 30

    def f(v):
        k1 = v[0]
        k2 = v[1] if two else 0.0
        cx = w / 2 + (v[2 if two else 1] * R * 0.05 if fit_center else 0)
        cy = h / 2 + (v[3 if two else 2] * R * 0.05 if fit_center else 0)
        return _grid_cost(grids, k1, k2, cx, cy, R)[0]

    x0 = [0.0] + ([0.0] if two else []) + ([0.0, 0.0] if fit_center else [])
    steps = [0.05] + ([0.05] if two else []) + ([0.2, 0.2] if fit_center else [])
    v, cost = _nelder_mead(f, x0, steps)
    # once more from where it got to (Nelder-Mead stalls on long valleys)
    v, cost = _nelder_mead(f, v, [s * 0.2 for s in steps])
    k1 = float(v[0])
    k2 = float(v[1]) if two else 0.0
    cx = w / 2 + (float(v[2 if two else 1]) * R * 0.05 if fit_center else 0)
    cy = h / 2 + (float(v[3 if two else 2]) * R * 0.05 if fit_center else 0)
    _, Hs = _grid_cost(grids, k1, k2, cx, cy, R)
    allp = np.concatenate([gd[:, 2:] for gd in grids])
    cov = float(np.max(np.hypot(allp[:, 0] - cx, allp[:, 1] - cy)) / R)
    if cov < 0.75:
        notes.append(f"The chart reaches {round(cov * 100)} % of the way to the corners: the distortion out there is "
                     "guessed. Fill the frame with it.")
    err = math.sqrt(cost)
    if err > 1.0:
        notes.append(f"The chart does not fit well ({err:.2f} px): is it flat, sharp and not moving?")
    out = {"k1": round(k1, 6), "k2": round(k2, 6), "center": [round(cx, 3), round(cy, 3)] if fit_center else None,
           "error": round(err, 4), "points": int(sum(len(gd) for gd in grids)), "coverage": round(cov, 3),
           "lattices": [gd.round(3).tolist() for gd in grids], "notes": notes, "pictures": len(pictures),
           "found": len(grids)}
    fp = focal_from_homographies(Hs, w, h, cx, cy)
    if fp:
        out["focal_px"] = round(fp, 2)
    return out


def solve_lens_lines(lines, w, h, fit_center=False, use_k2=None):
    """k1 / k2 (and the centre) from lines that are straight in the world, drawn on the plate - the page's
    comp_warp solveLens, with the centre free when asked. {k1, k2, center, error, points}."""
    ls = [np.asarray(l, np.float64) for l in (lines or []) if isinstance(l, (list, tuple)) and len(l) >= 3]
    pts = sum(len(l) for l in ls)
    if not ls:
        return {"k1": 0, "k2": 0, "center": None, "error": None, "points": 0}
    R = math.hypot(w, h) / 2
    two = (pts >= 12 and len(ls) >= 2) if use_k2 is None else bool(use_k2)

    def spread(u):
        c = u - u.mean(0)
        s = c.T @ c
        tr, det = s[0, 0] + s[1, 1], s[0, 0] * s[1, 1] - s[0, 1] ** 2
        return tr / 2 - math.sqrt(max(0.0, tr * tr / 4 - det))

    def f(v):
        k1 = v[0]
        k2 = v[1] if two else 0.0
        o = 2 if two else 1
        cx = w / 2 + (v[o] * R * 0.05 if fit_center else 0)
        cy = h / 2 + (v[o + 1] * R * 0.05 if fit_center else 0)
        s = 0.0
        for l in ls:
            ux, uy = WP.lens_points(l[:, 0], l[:, 1], "undistort", k1, k2, cx, cy, R)
            s += spread(np.c_[ux, uy])
        return s

    x0 = [0.0] + ([0.0] if two else []) + ([0.0, 0.0] if fit_center else [])
    steps = [0.05] + ([0.05] if two else []) + ([0.2, 0.2] if fit_center else [])
    v, cost = _nelder_mead(f, x0, steps)
    v, cost = _nelder_mead(f, v, [s * 0.2 for s in steps])
    o = 2 if two else 1
    return {"k1": round(float(v[0]), 6), "k2": round(float(v[1]) if two else 0.0, 6),
            "center": [round(w / 2 + float(v[o]) * R * 0.05, 3), round(h / 2 + float(v[o + 1]) * R * 0.05, 3)] if fit_center else None,
            "error": round(math.sqrt(cost / max(1, pts)), 4), "points": pts}


def lens_stmap(w, h, lens, mode="undistort"):
    """The ST map (u, v in 0..1, v up) of the lens, as the Comp STMap node reads it: [H, W, 2] float32."""
    U, V = WP.lens_map(w, h, {"k1": lens.get("k1") or 0, "k2": lens.get("k2") or 0, "center": lens.get("center"),
                              "zoom": lens.get("zoom") or 1, "mode": mode}, 1.0)
    return np.dstack([U / w, 1 - V / h]).astype(np.float32)
