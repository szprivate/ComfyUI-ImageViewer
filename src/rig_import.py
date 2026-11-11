"""Characters coming back into the 3D space: the viewer's rig and the motion in an FBX or USD file.

The way out is rig_export.py: every application gets the baked motion, and the
viewer's own rig rides along as one packed property (`rig_export.LIVE_PROP` on
an FBX's character Null, `rig_export.LIVE_KEY` in a USD SkelRoot's customData).
This module reads both back, with no SDK:

* `read_fbx(path)` - an FBX file's settings (frame rate, units, up axis) and the
  viewer's rig if it carries one. The motion of an FBX is read in the page by
  three.js's FBXLoader, which already knows Maya's pivots and pre-rotations.
  Binary FBX (6.1 / 7.x, 32- and 64-bit records) is walked record by record;
  an ASCII FBX is searched for the one property.
* `read_usd(path)` - a UsdSkel stage's skeleton and its animation, sampled on
  every time code (the page has no USD reader: three.js's is a stub), plus the
  viewer's rig. Through pxr (usd-core).
"""

import os
import re
import struct
import zlib

try:
    from . import rig_export
except ImportError:  # loaded on its own (the tests): rig_export.py beside it
    import rig_export

MAX_FILE = 2 << 30          # nothing past this is read for a property
MAX_FRAMES = 20000          # a USD animation is sampled at most this many times
MAX_JOINTS = 2000


# ── FBX ──────────────────────────────────────────────────────────────────────

class _Rec:
    __slots__ = ("name", "props", "kids")

    def __init__(self, name, props, kids):
        self.name, self.props, self.kids = name, props, kids

    def find(self, name):
        return next((k for k in self.kids if k.name == name), None)


def _read_prop(buf, i):
    code = chr(buf[i])
    i += 1
    fixed = {"Y": "<h", "C": "<B", "I": "<i", "F": "<f", "D": "<d", "L": "<q"}
    if code in fixed:
        fmt = fixed[code]
        v = struct.unpack_from(fmt, buf, i)[0]
        return (bool(v) if code == "C" else v), i + struct.calcsize(fmt)
    if code in ("S", "R"):
        (n,) = struct.unpack_from("<I", buf, i)
        raw = bytes(buf[i + 4:i + 4 + n])
        return (raw.decode("utf-8", "replace") if code == "S" else raw), i + 4 + n
    if code in ("f", "d", "l", "i", "b", "c"):
        count, enc, n = struct.unpack_from("<III", buf, i)
        i += 12
        raw = bytes(buf[i:i + n])
        if enc == 1:
            raw = zlib.decompress(raw)
        size = {"f": 4, "d": 8, "l": 8, "i": 4, "b": 1, "c": 1}[code]
        fmt = {"f": "f", "d": "d", "l": "q", "i": "i", "b": "B", "c": "B"}[code]
        return list(struct.unpack(f"<{min(count, len(raw) // size)}{fmt}", raw[:count * size])), i + n
    raise ValueError(f"unknown FBX property type {code!r}")


def _read_records(buf, i, end, wide, depth=0):
    """The records between i and end; each (end offset, property count, property bytes, name)."""
    out = []
    head = 25 if wide else 13
    while i + head <= end:
        if wide:
            stop, nprops, plen = struct.unpack_from("<QQQ", buf, i)
            i += 24
        else:
            stop, nprops, plen = struct.unpack_from("<III", buf, i)
            i += 12
        nlen = buf[i]
        i += 1
        if stop == 0:                       # the null record that ends a list
            break
        if stop > end or depth > 64:
            raise ValueError("the FBX file is damaged")
        name = bytes(buf[i:i + nlen]).decode("ascii", "replace")
        i += nlen
        props = []
        p = i
        for _ in range(nprops):
            v, p = _read_prop(buf, p)
            props.append(v)
        i += plen
        kids = _read_records(buf, i, stop, wide, depth + 1) if i < stop else []
        out.append(_Rec(name, props, kids))
        i = stop
    return out


def _p70(rec):
    """A record's Properties70 (or 6.1's Properties60) as {name: [values]}."""
    out = {}
    if rec is None:
        return out
    block = rec.find("Properties70") or rec.find("Properties60")
    for p in (block.kids if block else []):
        if p.props:
            out[str(p.props[0])] = p.props[4:] if p.name == "P" else p.props[3:]
    return out


_ASCII_LIVE = re.compile(r'P:\s*"' + rig_export.LIVE_PROP + r'"\s*,\s*"KString"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"([^"]*)"')
_ASCII_NUM = r'P:\s*"{}"\s*,[^\n]*?,\s*([-0-9.eE+]+)\s*$'


def read_fbx(path):
    """{ format, version, fps, unit_cm, up, live } of an FBX file. `live` is the viewer's rig
    (rig_export.pack_live) or None. `unit_cm`: centimetres per unit as the file declares it."""
    path = os.fspath(path)
    if os.path.getsize(path) > MAX_FILE:
        raise ValueError("the file is too large")
    with open(path, "rb") as fh:
        buf = fh.read()
    out = {"format": "fbx", "version": None, "fps": None, "unit_cm": 1.0, "up": "y", "live": None}
    if buf.startswith(b"Kaydara FBX Binary  \x00"):
        (version,) = struct.unpack_from("<I", buf, 23)
        out["version"] = version
        top = _read_records(buf, 27, len(buf), version >= 7500)
        gs = next((r for r in top if r.name == "GlobalSettings"), None)
        props = _p70(gs)
        _settings(out, props)
        objects = next((r for r in top if r.name == "Objects"), None)
        for rec in (objects.kids if objects else []):
            if rec.name != "Model":
                continue
            v = _p70(rec).get(rig_export.LIVE_PROP)
            if v:
                live = rig_export.unpack_live(str(v[0]))
                if live is not None:
                    out["live"] = live
                    break
        return out
    text = buf.decode("utf-8", "replace")
    if "FBXHeaderExtension" not in text[:4096] and "; FBX" not in text[:200]:
        raise ValueError("not an FBX file")
    m = re.search(r";\s*FBX\s+(\d+)\.(\d+)\.(\d+)", text[:400])
    if m:
        out["version"] = int(m.group(1)) * 1000 + int(m.group(2)) * 100
    props = {}
    for key in ("UnitScaleFactor", "CustomFrameRate", "TimeMode", "UpAxis", "UpAxisSign"):
        mm = re.search(_ASCII_NUM.format(key), text, re.M)
        if mm:
            props[key] = [float(mm.group(1))]
    _settings(out, props)
    m = _ASCII_LIVE.search(text)
    if m:
        out["live"] = rig_export.unpack_live(m.group(1))
    return out


_MODE_FPS = {v: k for k, v in rig_export._TIME_MODES.items()}
_MODE_FPS.update({7: 29.97, 8: 29.97, 9: 59.94, 13: 23.976})


def _settings(out, props):
    def num(name, default=None):
        v = props.get(name)
        try:
            return float(v[0]) if v else default
        except (TypeError, ValueError):
            return default
    out["unit_cm"] = num("UnitScaleFactor", 1.0) or 1.0
    mode = num("TimeMode")
    fps = _MODE_FPS.get(int(mode)) if mode is not None else None
    if not fps:
        fps = num("CustomFrameRate")
    out["fps"] = fps if fps and fps > 0 else None
    up = int(num("UpAxis", 1) or 0)
    out["up"] = {0: "x", 1: "y", 2: "z"}.get(up, "y")


# ── USD ──────────────────────────────────────────────────────────────────────

def _mat(m):
    """A Gf.Matrix4d as three.js's column-major 16 (the same numbers in the same order, see rig_export._gf_matrix)."""
    return [float(m[r][c]) for r in range(4) for c in range(4)]


def read_usd(path, skeleton=None):
    """A UsdSkel stage's character as numbers for the page:
        { format, fps, start, end, meters, up, live, skeleton, skel_to_model (16: the skeleton's space in the file's,
          less the viewer's own character placement),
          joints: [{ name, parent }], rest: [16 per joint, local], bind: [16 per joint, skeleton space],
          frames: [time codes], anim: [frames][joints][10] (t xyz, q xyzw, s xyz, local) }
    `skeleton` picks one Skeleton prim by path; else the first with an animation, else the first.
    Without a skeleton, `joints` is empty and `live` is still answered."""
    from pxr import Usd, UsdGeom, UsdSkel

    stage = Usd.Stage.Open(os.fspath(path), Usd.Stage.LoadAll)
    if stage is None:
        raise ValueError("the stage could not be opened")
    fps = stage.GetTimeCodesPerSecond() or 24.0
    out = {"format": "usd", "fps": float(fps), "start": stage.GetStartTimeCode(), "end": stage.GetEndTimeCode(),
           "meters": float(UsdGeom.GetStageMetersPerUnit(stage) or 0.01),
           "up": str(UsdGeom.GetStageUpAxis(stage)).lower(), "live": None, "skeleton": None,
           "joints": [], "rest": [], "bind": [], "frames": [], "anim": []}
    skels = []
    for prim in stage.Traverse():
        if out["live"] is None:
            v = prim.GetCustomDataByKey(rig_export.LIVE_KEY)
            if v:
                out["live"] = rig_export.unpack_live(str(v))
        if prim.IsA(UsdSkel.Skeleton):
            skels.append(prim)
    if not skels:
        return out
    cache = UsdSkel.Cache()
    pick = None
    if skeleton:
        pick = next((p for p in skels if str(p.GetPath()) == str(skeleton)), None)
    queries = [(p, cache.GetSkelQuery(UsdSkel.Skeleton(p))) for p in ([pick] if pick else skels)]
    prim, query = next(((p, q) for p, q in queries if q and q.GetAnimQuery()), queries[0])
    if not query:
        return out
    skel = UsdSkel.Skeleton(prim)
    out["skeleton"] = str(prim.GetPath())
    # The skeleton's own place: joint transforms are in its space, and an application may have put the
    # character's axis fix or size on a prim above it (Blender turns an imported Y-up armature +90° about X
    # rather than its bones). The viewer's own export keeps the character's place in the scene on its
    # SkelRoot: that part is left out, as the FBX's character node is.
    xc = UsdGeom.XformCache(Usd.TimeCode(out["start"]))
    to_world = xc.GetLocalToWorldTransform(prim)
    root = UsdSkel.Root.Find(prim)
    if root and root.GetPrim().GetCustomDataByKey(rig_export.LIVE_KEY):
        to_world = to_world * xc.GetLocalToWorldTransform(root.GetPrim()).GetInverse()
    out["skel_to_model"] = _mat(to_world)
    order = query.GetJointOrder()
    if len(order) > MAX_JOINTS:
        raise ValueError("the skeleton has too many joints")
    topo = query.GetTopology()
    names = list(prim.GetCustomDataByKey("imageViewer:jointNames") or [])
    if len(names) != len(order):
        names = [str(j).rsplit("/", 1)[-1] for j in order]
    out["joints"] = [{"name": names[i], "parent": int(topo.GetParent(i))} for i in range(len(order))]
    rest = skel.GetRestTransformsAttr().Get()
    bind = skel.GetBindTransformsAttr().Get()
    if bind and len(bind) == len(order):
        out["bind"] = [_mat(m) for m in bind]
    if rest and len(rest) == len(order):
        out["rest"] = [_mat(m) for m in rest]
    elif out["bind"]:
        # No rest: the bind pose, made local.
        import numpy as np
        b = [np.array(m, dtype=np.float64).reshape(4, 4) for m in out["bind"]]
        out["rest"] = [(_local(b, i, j["parent"])).ravel().tolist() for i, j in enumerate(out["joints"])]
    anim = query.GetAnimQuery()
    if not anim:
        return out
    times = sorted(set(anim.GetJointTransformTimeSamples() or []))
    if not times:
        times = [out["start"]]
    if len(times) > 1:
        # Every frame between the first and last sample (a sparse file is filled in by USD's own interpolation).
        lo, hi = times[0], times[-1]
        times = [lo + k for k in range(int(hi - lo) + 1)] if hi - lo <= MAX_FRAMES else times[:MAX_FRAMES]
    for t in times:
        xf = query.ComputeJointLocalTransforms(Usd.TimeCode(t))
        if not xf:
            continue
        res = UsdSkel.DecomposeTransforms(xf)
        if not res or len(res) < 3:
            continue
        tr, rot, sc = res[-3:]
        row = []
        for k in range(len(order)):
            q = rot[k]
            im = q.GetImaginary()
            row.append([float(tr[k][0]), float(tr[k][1]), float(tr[k][2]),
                        float(im[0]), float(im[1]), float(im[2]), float(q.GetReal()),
                        float(sc[k][0]), float(sc[k][1]), float(sc[k][2])])
        out["frames"].append(float(t))
        out["anim"].append(row)
    return out


def _local(worlds, i, parent):
    import numpy as np
    return worlds[i] if parent < 0 else worlds[i] @ np.linalg.inv(worlds[parent])


def read(path):
    """`read_fbx` or `read_usd` by the file's extension."""
    ext = os.path.splitext(os.fspath(path))[1].lower()
    if ext == ".fbx":
        return read_fbx(path)
    if ext in (".usd", ".usda", ".usdc", ".usdz"):
        return read_usd(path)
    raise ValueError(f"not an FBX or USD file: {ext}")
