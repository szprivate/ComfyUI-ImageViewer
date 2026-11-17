"""Previz stages as USD: the viewer's scene written out and read back.

The previz scene (js/imageViewer_scene3d.js) is a flat list of items with a
transform, optional keyframes, and either an asset to load or a shape to build.
That maps onto USD almost directly:

    /previz                     Xform, the stage's default prim
      /previz/Hero              Xform + payload -> hero.usd
      /previz/Floor             UsdGeomPlane, displayColor
      /previz/Camera            UsdGeomCamera, focalLength from the fov

Geometry arrives as a **payload**, not a reference, so a shot stage opens
without composing every asset — which is the point of previz. A payload can
only target a USD layer, so an item pointing at an .fbx or .glb is written as an
xform carrying its path in customData: other applications see an empty group
where it sits, and this viewer still finds the file.

USD interpolates between time samples linearly and knows nothing about easing,
so animation is **baked per frame** on export — that is what another package
expects to read. The scene's own keys ride along in customData, so re-importing
a stage this viewer wrote gives back the exact keys rather than a baked mess.
"""

import contextlib
import json
import math
import os
import threading
import time as _time
from collections import OrderedDict

USD_EXTS = {".usd", ".usda", ".usdc", ".usdz"}

# 35 mm still: the aperture the focal lengths below are quoted against, and the
# one most packages assume when nothing says otherwise.
APERTURE_H = 36.0
APERTURE_V = 24.0

_CUSTOM_KEY = "imageViewer"


def available():
    """True when this install can read and write USD."""
    try:
        from pxr import Usd  # noqa: F401
        return True
    except Exception:
        return False


def _pxr():
    from pxr import Gf, Sdf, Usd, UsdGeom, Vt
    return Gf, Sdf, Usd, UsdGeom, Vt


def is_usd(path):
    return os.path.splitext(str(path or ""))[1].lower() in USD_EXTS


def _prim_name(name, used):
    """A USD-legal prim name: letters, digits and underscores, never a digit
    first, and unique among its siblings."""
    out = "".join(c if (c.isalnum() or c == "_") else "_" for c in str(name or "Item"))
    if not out or out[0].isdigit():
        out = "_" + out
    base, n = out, 2
    while out in used:
        out = f"{base}_{n}"
        n += 1
    used.add(out)
    return out


# ── transforms ───────────────────────────────────────────────────────────────

def _quat_to_euler_xyz(w, x, y, z):
    """Euler XYZ in degrees, the order and convention the viewer stores.

    Matches three.js's Euler.setFromQuaternion(q, "XYZ"), so a stage written
    here and read back puts everything at the same angle it left at.
    """
    m11 = 1 - 2 * (y * y + z * z)
    m12 = 2 * (x * y - z * w)
    m13 = 2 * (x * z + y * w)
    m22 = 1 - 2 * (x * x + z * z)
    m23 = 2 * (y * z - x * w)
    m32 = 2 * (y * z + x * w)
    m33 = 1 - 2 * (x * x + y * y)

    ey = math.asin(max(-1.0, min(1.0, m13)))
    if abs(m13) < 0.9999999:
        ex = math.atan2(-m23, m33)
        ez = math.atan2(-m12, m11)
    else:                       # looking straight up or down: pick a branch
        ex = math.atan2(m32, m22)
        ez = 0.0
    return [math.degrees(ex), math.degrees(ey), math.degrees(ez)]


def _decompose(matrix):
    """(translate, rotateXYZ degrees, scale) from a USD local transform."""
    Gf, _Sdf, _Usd, _UsdGeom, _Vt = _pxr()
    xf = Gf.Transform(matrix)
    t = xf.GetTranslation()
    s = xf.GetScale()
    q = xf.GetRotation().GetQuat()
    imag = q.GetImaginary()
    rot = _quat_to_euler_xyz(q.GetReal(), imag[0], imag[1], imag[2])
    return [t[0], t[1], t[2]], rot, [s[0], s[1], s[2]]


def _with_pivot(position, rotation, scale, pivot):
    """The translate that stands in for a pivot.

    An item's placement is T(position + pivot - R*S*pivot) * R * S, so a stage
    written with plain translate / rotate / scale ops reproduces it exactly by
    folding the pivot into the translate. The pivot itself rides along in this
    viewer's own customData, so our stages come back with it; anyone else's
    reader sees the object in the right place, which is what matters.
    """
    Gf, _Sdf, _Usd, _UsdGeom, _Vt = _pxr()
    pv = [float(v) for v in (pivot or [0.0, 0.0, 0.0])]
    if not any(pv):
        return [float(v) for v in position]
    m = Gf.Matrix4d(1.0)
    m.SetScale(Gf.Vec3d(*[float(v) for v in scale]))
    r = Gf.Matrix4d(1.0)
    r.SetRotate(Gf.Rotation(Gf.Vec3d(1, 0, 0), float(rotation[0]))
                * Gf.Rotation(Gf.Vec3d(0, 1, 0), float(rotation[1]))
                * Gf.Rotation(Gf.Vec3d(0, 0, 1), float(rotation[2])))
    turned = (r * m).TransformDir(Gf.Vec3d(*pv))
    return [float(position[i]) + pv[i] - turned[i] for i in range(3)]


def _resolution(item):
    """A camera item's [width, height], defaulting as scene3d does."""
    res = item.get("resolution") if isinstance(item, dict) else None
    try:
        w, h = (int(round(float(v))) for v in res)
        if w >= 1 and h >= 1:
            return w, h
    except (TypeError, ValueError):
        pass
    return 1920, 1080


def _offset_matrix(item):
    """scene3d's `offset` as a Gf.Matrix4d, or None when there is none.

    three.js keeps a matrix column-major with the translation in elements
    12..14; USD reads sixteen numbers row by row, with the translation in the
    last row. The same sixteen numbers, in the same order, are the same matrix.
    """
    Gf, _Sdf, _Usd, _UsdGeom, _Vt = _pxr()
    m = item.get("offset") if isinstance(item, dict) else None
    if not isinstance(m, list) or len(m) != 16:
        return None
    try:
        values = [float(v) for v in m]
    except (TypeError, ValueError):
        return None
    identity = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    if all(abs(a - b) < 1e-12 for a, b in zip(values, identity)):
        return None
    return Gf.Matrix4d(*values)


def _set_xform(xformable, position, rotation, scale, time=None):
    """Author (or sample) the translate / rotateXYZ / scale ops of a prim."""
    Gf, _Sdf, _Usd, UsdGeom, _Vt = _pxr()
    ops = {op.GetOpType(): op for op in xformable.GetOrderedXformOps()}
    T, R, S = (UsdGeom.XformOp.TypeTranslate, UsdGeom.XformOp.TypeRotateXYZ,
               UsdGeom.XformOp.TypeScale)
    op_t = ops.get(T) or xformable.AddTranslateOp()
    op_r = ops.get(R) or xformable.AddRotateXYZOp()
    op_s = ops.get(S) or xformable.AddScaleOp()
    values = (Gf.Vec3d(*[float(v) for v in position]),
              Gf.Vec3f(*[float(v) for v in rotation]),
              Gf.Vec3f(*[float(v) for v in scale]))
    for op, value in zip((op_t, op_r, op_s), values):
        if time is None:
            op.Set(value)
        else:
            op.Set(value, time)


# ── the scene's own evaluation, mirrored from scene3d.js ─────────────────────

def _auto_slope(ease, frm, to, span):
    """The slope an ease word means: flat for smooth, the secant for linear."""
    if ease == "linear" and span > 0:
        return (to - frm) / span
    return 0.0


def _hermite(p0, p1, m0, m1, t, span):
    t2 = t * t
    t3 = t2 * t
    return ((2 * t3 - 3 * t2 + 1) * p0
            + (t3 - 2 * t2 + t) * span * m0
            + (-2 * t3 + 3 * t2) * p1
            + (t3 - t2) * span * m1)


def _angle_delta(a, b):
    d = (b - a) % 360.0
    if d > 180:
        d -= 360
    if d < -180:
        d += 360
    return d


def _lerp_angle(a, b, t):
    return a + _angle_delta(a, b) * t


def _component(value, axis):
    return value[axis] if isinstance(value, (list, tuple)) else value


INFINITY_MODES = ("constant", "linear", "cycle", "offset", "oscillate")
_TRACKS = ("position", "rotation", "scale", "pivot", "fov", "ikfk")


def infinity_of(item, prop):
    """(pre, post) of one property: scene3d.js ``infinityOf``."""
    own = (item.get("infinity") or {}).get(prop) or {}
    pick = lambda m: m if m in INFINITY_MODES else "constant"  # noqa: E731
    return pick(own.get("pre")), pick(own.get("post"))


def has_infinity(item):
    for prop in _TRACKS:
        keys = ((item.get("tracks") or {}).get(prop)) or []
        if len(keys) > 1 and infinity_of(item, prop) != ("constant", "constant"):
            return True
    return False


def _tangent_at(keys, i, axis, side):
    """scene3d.js ``tangentAt`` for key i: hand-set, else what the ease implies."""
    key = keys[i]
    own = key.get("ti" if side == "in" else "to")
    if own is not None:
        return _component(own, axis)
    j = i - 1 if side == "in" else i + 1
    if j < 0 or j >= len(keys):
        return 0.0
    frm, to = (keys[j], key) if side == "in" else (key, keys[j])
    return _auto_slope(frm.get("ease", "smooth"), _component(frm["v"], axis),
                       _component(to["v"], axis), to["f"] - frm["f"])


def _add(a, b, k):
    if isinstance(a, (list, tuple)):
        return [x + _component(b, i) * k for i, x in enumerate(a)]
    return a + b * k


def _beyond(item, prop, keys, frame):
    """``frame`` outside the keys through the infinity mode, or None (scene3d.js ``_beyond``)."""
    first, last = keys[0], keys[-1]
    before = frame < first["f"]
    if not before and frame <= last["f"]:
        return None
    pre, post = infinity_of(item, prop)
    mode = pre if before else post
    span = last["f"] - first["f"]
    if mode == "constant" or span <= 0:
        return None
    if mode == "linear":
        i, side = (0, "out") if before else (len(keys) - 1, "in")
        end = keys[i]
        if isinstance(end["v"], (list, tuple)):
            slope = [_tangent_at(keys, i, a, side) for a in range(len(end["v"]))]
        else:
            slope = _tangent_at(keys, i, 0, side)
        return _add(end["v"], slope, frame - end["f"])
    rel = frame - first["f"]
    turns = math.floor(rel / span)
    local = rel - turns * span
    if mode == "oscillate" and turns % 2 == 1:
        local = span - local
    v = _inside(item, prop, keys, first["f"] + local)
    if mode != "offset":
        return v
    if isinstance(last["v"], (list, tuple)):
        step = [x - _component(first["v"], i) for i, x in enumerate(last["v"])]
    else:
        step = last["v"] - first["v"]
    return _add(v, step, turns)


def value_at(item, prop, frame):
    """What `prop` is at `frame` — the same answer the viewer draws.

    A second implementation of the interpolation in scene3d.js, kept
    deliberately small and checked against it in the tests: baking has to agree
    with the viewport, or an exported stage would not match what was previewed.
    """
    keys = ((item.get("tracks") or {}).get(prop)) or []
    if len(keys) > 1:
        out = _beyond(item, prop, keys, frame)
        if out is not None:
            return max(0.0, min(1.0, out)) if prop == "ikfk" else out
    return _inside(item, prop, keys, frame)


def _inside(item, prop, keys, frame):
    static = item.get("fov", 35) if prop == "fov" else item.get(prop)
    if not keys:
        return static
    if frame <= keys[0]["f"]:
        return keys[0]["v"]
    if frame >= keys[-1]["f"]:
        return keys[-1]["v"]
    i = 0
    while i < len(keys) - 1 and keys[i + 1]["f"] <= frame:
        i += 1
    a, b = keys[i], keys[i + 1]
    span = b["f"] - a["f"]
    ease = a.get("ease", "smooth")
    if ease == "hold" or span <= 0:
        return a["v"]
    t = (frame - a["f"]) / span
    angles = prop == "rotation"

    def each(axis):
        p0 = _component(a["v"], axis)
        # The short way round for angles, exactly as the viewer draws it.
        p1 = p0 + _angle_delta(p0, _component(b["v"], axis)) if angles else _component(b["v"], axis)
        # Hand-set tangents win; otherwise the ease says what they are.
        m0 = _component(a["to"], axis) if a.get("to") is not None else _auto_slope(ease, p0, p1, span)
        m1 = _component(b["ti"], axis) if b.get("ti") is not None else _auto_slope(ease, p0, p1, span)
        return _hermite(p0, p1, m0, m1, t, span)

    if isinstance(a["v"], (list, tuple)):
        return [each(k) for k in range(len(a["v"]))]
    return each(0)


def _animated_range(item):
    """(first, last) frame this item has keys on, or None when it is still."""
    frames = []
    for prop in ("position", "rotation", "scale", "pivot", "fov"):
        for key in ((item.get("tracks") or {}).get(prop)) or []:
            frames.append(key["f"])
    return (min(frames), max(frames)) if frames else None


# ── export ───────────────────────────────────────────────────────────────────

def _fov_to_focal(fov_degrees):
    half = math.radians(max(1.0, min(179.0, float(fov_degrees or 35))) / 2.0)
    return (APERTURE_V / 2.0) / max(1e-6, math.tan(half))


def _focal_to_fov(focal, vertical_aperture):
    focal = max(1e-6, float(focal or 24))
    aperture = float(vertical_aperture or APERTURE_V)
    return math.degrees(2.0 * math.atan((aperture / 2.0) / focal))


def _torus_mesh(mesh, radius=0.35, tube=0.15, radial=48, tubular=16):
    """A torus, point by point — USD has no torus prim, and the viewer's shapes
    should all survive the trip."""
    _Gf, _Sdf, _Usd, _UsdGeom, Vt = _pxr()
    points, counts, indices = [], [], []
    for i in range(radial):
        u = 2 * math.pi * i / radial
        for j in range(tubular):
            v = 2 * math.pi * j / tubular
            points.append((
                (radius + tube * math.cos(v)) * math.cos(u),
                tube * math.sin(v),
                (radius + tube * math.cos(v)) * math.sin(u),
            ))
    for i in range(radial):
        for j in range(tubular):
            a = i * tubular + j
            b = ((i + 1) % radial) * tubular + j
            c = ((i + 1) % radial) * tubular + (j + 1) % tubular
            d = i * tubular + (j + 1) % tubular
            counts.append(4)
            indices.extend([a, b, c, d])
    mesh.CreatePointsAttr(Vt.Vec3fArray([tuple(map(float, p)) for p in points]))
    mesh.CreateFaceVertexCountsAttr(Vt.IntArray(counts))
    mesh.CreateFaceVertexIndicesAttr(Vt.IntArray(indices))
    mesh.CreateSubdivisionSchemeAttr("none")


def _define_shape(stage, path, item):
    """The USD prim for one of the viewer's built-in shapes, at the same size
    the viewport builds it: a 1-unit box, a half-unit radius, a 1×1 plane."""
    _Gf, _Sdf, _Usd, UsdGeom, _Vt = _pxr()
    kind = ((item.get("primitive") or {}).get("type")) or "box"
    if kind == "sphere":
        prim = UsdGeom.Sphere.Define(stage, path)
        prim.CreateRadiusAttr(0.5)
        prim.CreateExtentAttr([(-0.5, -0.5, -0.5), (0.5, 0.5, 0.5)])
    elif kind == "cylinder":
        prim = UsdGeom.Cylinder.Define(stage, path)
        prim.CreateRadiusAttr(0.5)
        prim.CreateHeightAttr(1.0)
        prim.CreateAxisAttr(UsdGeom.Tokens.y)
        prim.CreateExtentAttr([(-0.5, -0.5, -0.5), (0.5, 0.5, 0.5)])
    elif kind == "cone":
        prim = UsdGeom.Cone.Define(stage, path)
        prim.CreateRadiusAttr(0.5)
        prim.CreateHeightAttr(1.0)
        prim.CreateAxisAttr(UsdGeom.Tokens.y)
        prim.CreateExtentAttr([(-0.5, -0.5, -0.5), (0.5, 0.5, 0.5)])
    elif kind == "plane":
        prim = UsdGeom.Plane.Define(stage, path)
        prim.CreateAxisAttr(UsdGeom.Tokens.y)
        prim.CreateWidthAttr(1.0)
        prim.CreateLengthAttr(1.0)
        prim.CreateExtentAttr([(-0.5, 0, -0.5), (0.5, 0, 0.5)])
    elif kind == "torus":
        prim = UsdGeom.Mesh.Define(stage, path)
        _torus_mesh(prim)
    else:
        prim = UsdGeom.Cube.Define(stage, path)
        prim.CreateSizeAttr(1.0)
        prim.CreateExtentAttr([(-0.5, -0.5, -0.5), (0.5, 0.5, 0.5)])

    color = item.get("color") or "#9a9a9a"
    try:
        rgb = tuple(int(color[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
        prim.CreateDisplayColorAttr([rgb])
    except Exception:
        pass
    return prim


def _in_tree_order(items):
    """Items with every parent ahead of its children.

    Order in the list is not load-bearing anywhere else, so a scene that has
    been edited, undone or imported can hand its items over in any order and
    still export as the tree it is. Anything whose parent is missing is treated
    as top level rather than dropped.
    """
    by_id = {it.get("id"): it for it in items if isinstance(it, dict)}
    out, placed = [], set()

    def place(item):
        ident = item.get("id")
        if ident in placed:
            return
        parent = by_id.get(item.get("parent"))
        if parent is not None and parent is not item and parent.get("id") not in placed:
            place(parent)
        placed.add(ident)
        out.append(item)

    for item in items:
        if isinstance(item, dict):
            place(item)
    return out


def _color3(hex_color, default=(0.6, 0.6, 0.6)):
    try:
        return tuple(int(hex_color[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
    except Exception:
        return default


def _asset_target(asset, layer_dir, always_relative=False):
    """An asset path as a layer should spell it: relative to the stage when the
    two can move together, else absolute. A sidecar this viewer wrote always
    lives beside the stage's folder, so it is always relative."""
    try:
        rel = os.path.relpath(asset, layer_dir).replace("\\", "/")
    except ValueError:
        return asset.replace("\\", "/")
    if always_relative or not rel.startswith(".."):
        return rel if rel.startswith(".") else "./" + rel
    return asset.replace("\\", "/")


# The viewer's lights shine along their item's -Y; UsdLux lights along their
# own -Z. A child turned -90 degrees about X makes the two the same direction.
_LIGHT_TURN = -90.0


def _define_light(stage, parent_path, item):
    """A UsdLux light under an item's Xform, from the viewer's light settings."""
    Gf, Sdf, _Usd, UsdGeom, _Vt = _pxr()
    from pxr import UsdLux
    light = item.get("light") or {}
    kind = light.get("type") or "point"
    path = parent_path.AppendChild("Light")
    if kind == "directional":
        prim = UsdLux.DistantLight.Define(stage, path)
        prim.CreateAngleAttr(0.53)
    elif kind == "area":
        prim = UsdLux.RectLight.Define(stage, path)
        prim.CreateWidthAttr(float(light.get("width") or 2.0))
        prim.CreateHeightAttr(float(light.get("height") or 2.0))
    elif kind == "dome":
        prim = UsdLux.DomeLight.Define(stage, path)
    else:
        prim = UsdLux.SphereLight.Define(stage, path)
        prim.CreateRadiusAttr(0.05)
        prim.CreateTreatAsPointAttr(True)
        if kind == "spot":
            shaping = UsdLux.ShapingAPI.Apply(prim.GetPrim())
            shaping.CreateShapingConeAngleAttr(float(light.get("angle") or 30.0))
            shaping.CreateShapingConeSoftnessAttr(float(light.get("penumbra") or 0.0))
    prim.CreateIntensityAttr(float(light.get("intensity") if light.get("intensity") is not None else 1.0))
    prim.CreateColorAttr(Gf.Vec3f(*_color3(light.get("color") or "#ffffff", (1, 1, 1))))
    if kind in ("spot", "directional", "area"):
        UsdGeom.Xformable(prim).AddRotateXOp().Set(_LIGHT_TURN)
    shadow = UsdLux.ShadowAPI.Apply(prim.GetPrim())
    shadow.CreateShadowEnableAttr(bool(light.get("shadows")))
    return prim


def _define_dome(stage, parent_path, item, layer_dir, resolve):
    """An environment's panorama as a DomeLight, when it has a file to show."""
    _Gf, Sdf, _Usd, _UsdGeom, _Vt = _pxr()
    from pxr import UsdLux
    sky = (item.get("sky") or {}) if isinstance(item.get("sky"), dict) else {}
    src = sky.get("src")
    picture = resolve(src) if (resolve and src) else None
    if sky.get("mode") != "panorama" or not picture:
        return None
    dome = UsdLux.DomeLight.Define(stage, parent_path.AppendChild("Sky"))
    dome.CreateTextureFileAttr(Sdf.AssetPath(_asset_target(picture, layer_dir)))
    dome.CreateTextureFormatAttr("latlong")
    dome.CreateIntensityAttr(float(sky.get("intensity") or 1.0))
    return dome


_PICTURE_EXTS = {".png", ".jpg", ".jpeg", ".exr", ".hdr", ".tif", ".tiff", ".webp", ".bmp", ".tga"}


def _define_card(stage, parent_path, item, geo, layer_dir, resolve):
    """An image plane: its card as a mesh, its picture as the texture."""
    Gf, Sdf, _Usd, UsdGeom, _Vt = _pxr()
    from pxr import UsdShade
    meshes = (geo or {}).get("meshes") or []
    if not meshes:
        return None
    card = write_mesh(stage, parent_path.AppendChild("Card"), meshes[0])
    card.CreateDoubleSidedAttr(((item.get("plane") or {}).get("doubleSided")) is not False)
    picture = resolve(item.get("src")) if resolve else None
    mat = UsdShade.Material.Define(stage, parent_path.AppendChild("Look"))
    shader = UsdShade.Shader.Define(stage, parent_path.AppendPath(Sdf.Path("Look/Surface")))
    shader.CreateIdAttr("UsdPreviewSurface")
    mat.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
    opacity = (item.get("plane") or {}).get("opacity")
    if opacity is not None and float(opacity) < 1:
        shader.CreateInput("opacity", Sdf.ValueTypeNames.Float).Set(float(opacity))
    if picture and os.path.splitext(picture)[1].lower() in _PICTURE_EXTS:
        reader = UsdShade.Shader.Define(stage, parent_path.AppendPath(Sdf.Path("Look/st")))
        reader.CreateIdAttr("UsdPrimvarReader_float2")
        reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
        tex = UsdShade.Shader.Define(stage, parent_path.AppendPath(Sdf.Path("Look/picture")))
        tex.CreateIdAttr("UsdUVTexture")
        tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(_asset_target(picture, layer_dir))
        tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), "result")
        tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
        for name in ("diffuseColor", "emissiveColor"):
            shader.CreateInput(name, Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), "rgb")
    UsdShade.MaterialBindingAPI.Apply(card.GetPrim()).Bind(mat)
    return card


# ── meshes handed over as arrays (what the page sends for what it built) ────

def _array(value, dtype, width=None):
    """A base64 string or a plain list as a numpy array (rows of `width`)."""
    import base64
    import numpy as np
    if value is None:
        return None
    if isinstance(value, str):
        arr = np.frombuffer(base64.b64decode(value), dtype=dtype)
    else:
        arr = np.asarray(value, dtype=dtype)
    if width:
        if arr.size % width:
            raise ValueError("a mesh array does not divide into rows")
        arr = arr.reshape(-1, width)
    return arr


def _matrix(values):
    """Sixteen numbers in three.js order as a Gf.Matrix4d (the same numbers)."""
    Gf, _Sdf, _Usd, _UsdGeom, _Vt = _pxr()
    if not isinstance(values, (list, tuple)) or len(values) != 16:
        return None
    return Gf.Matrix4d(*[float(v) for v in values])


def write_mesh(stage, path, mesh):
    """One mesh, as the page sends it: positions, optional normals, uvs,
    per-vertex colours and triangle indices, plus a colour for the whole."""
    Gf, Sdf, _Usd, UsdGeom, Vt = _pxr()
    import numpy as np
    pts = _array(mesh.get("positions"), np.float32, 3)
    if pts is None or not len(pts):
        raise ValueError("a mesh without points")
    idx = _array(mesh.get("indices"), np.uint32)
    if idx is None or not len(idx):
        idx = np.arange(len(pts), dtype=np.uint32)
    if len(idx) % 3 or (len(idx) and int(idx.max()) >= len(pts)):
        raise ValueError("a mesh whose triangles do not fit its points")
    m = UsdGeom.Mesh.Define(stage, path)
    m.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(pts))
    m.CreateFaceVertexCountsAttr(Vt.IntArray([3] * (len(idx) // 3)))
    m.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(idx.astype(np.int32)))
    m.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    m.CreateExtentAttr(Vt.Vec3fArray([Gf.Vec3f(*map(float, lo)), Gf.Vec3f(*map(float, hi))]))
    nrm = _array(mesh.get("normals"), np.float32, 3)
    if nrm is not None and len(nrm) == len(pts):
        m.CreateNormalsAttr(Vt.Vec3fArray.FromNumpy(nrm))
        m.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    pv = UsdGeom.PrimvarsAPI(m)
    uv = _array(mesh.get("uvs"), np.float32, 2)
    if uv is not None and len(uv) == len(pts):
        pv.CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex) \
          .Set(Vt.Vec2fArray.FromNumpy(uv))
    col = _array(mesh.get("colors"), np.float32, 3)
    if col is not None and len(col) == len(pts):
        pv.CreatePrimvar("displayColor", Sdf.ValueTypeNames.Color3fArray, UsdGeom.Tokens.vertex) \
          .Set(Vt.Vec3fArray.FromNumpy(col))
    elif mesh.get("color"):
        m.CreateDisplayColorAttr([Gf.Vec3f(*_color3(mesh["color"]))])
    return m


def write_geometry_layer(path, geo):
    """A layer of meshes the page built itself (a terrain, a scatter, a depth
    mesh, a model only the page could read): one prim per mesh under /Geo, in
    the item's own space; a mesh drawn many times becomes a PointInstancer."""
    Gf, Sdf, Usd, UsdGeom, Vt = _pxr()
    import numpy as np
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    root = UsdGeom.Xform.Define(stage, "/Geo")
    stage.SetDefaultPrim(root.GetPrim())
    Usd.ModelAPI(root.GetPrim()).SetKind("component")
    used = set()
    for mesh in (geo or {}).get("meshes") or []:
        # A mesh's place below the item: "Rocks/Rock_3" keeps the page's own tree.
        parts = [p for p in str(mesh.get("path") or mesh.get("name") or "mesh").split("/") if p]
        at = Sdf.Path("/Geo")
        for part in parts[:-1]:
            at = at.AppendChild(_prim_name(part, set()))
            if not stage.GetPrimAtPath(at):
                UsdGeom.Xform.Define(stage, at)
        name = _prim_name(parts[-1] if parts else "mesh", used)
        prim_path = at.AppendChild(name)
        matrix = _matrix(mesh.get("matrix"))
        inst = _array(mesh.get("instances"), np.float32, 16)
        if inst is not None and len(inst):
            pi = UsdGeom.PointInstancer.Define(stage, prim_path)
            proto = write_mesh(stage, prim_path.AppendPath(Sdf.Path("Prototypes/mesh")), mesh)
            pi.CreatePrototypesRel().SetTargets([proto.GetPath()])
            positions, orients, scales = [], [], []
            for row in inst:
                xf = Gf.Transform(Gf.Matrix4d(*[float(v) for v in row]))
                t, s, q = xf.GetTranslation(), xf.GetScale(), xf.GetRotation().GetQuat()
                positions.append(Gf.Vec3f(*t))
                scales.append(Gf.Vec3f(*s))
                im = q.GetImaginary()
                orients.append(Gf.Quath(q.GetReal(), Gf.Vec3h(im[0], im[1], im[2])))
            pi.CreateProtoIndicesAttr(Vt.IntArray([0] * len(positions)))
            pi.CreatePositionsAttr(Vt.Vec3fArray(positions))
            pi.CreateOrientationsAttr(Vt.QuathArray(orients))
            pi.CreateScalesAttr(Vt.Vec3fArray(scales))
            target = pi
        else:
            target = write_mesh(stage, prim_path, mesh)
        if matrix is not None:
            UsdGeom.Xformable(target).AddTransformOp().Set(matrix)
    stage.GetRootLayer().Save()
    return path


# ── edits inside an asset: what the Outliner changes below an item ───────────

def apply_edits(stage, base, edits):
    """Author `edits` under the prim at `base` in the stage's current edit
    target: {"overs": {rel: {"visible": bool, "active": bool}},
    "variants": {rel: {set: choice}}}. `rel` is a prim path below `base`
    ("" is `base` itself). Over prims, so the asset itself is never touched."""
    _Gf, Sdf, _Usd, UsdGeom, _Vt = _pxr()
    base = Sdf.Path(str(base))
    edits = edits if isinstance(edits, dict) else {}

    def at(rel):
        rel = str(rel or "").strip("/")
        if not rel:
            return base
        try:
            return base.AppendPath(Sdf.Path(rel))
        except Exception:
            return None

    for rel, choices in (edits.get("variants") or {}).items():
        path = at(rel)
        if path is None or not isinstance(choices, dict):
            continue
        try:
            prim = stage.OverridePrim(path)
            for vset, choice in choices.items():
                if vset and isinstance(choice, str):
                    prim.GetVariantSets().AddVariantSet(str(vset)).SetVariantSelection(choice)
        except Exception:
            continue                # inside an instance: nothing may be authored there
    for rel, over in (edits.get("overs") or {}).items():
        path = at(rel)
        if path is None or not isinstance(over, dict):
            continue
        try:
            prim = stage.OverridePrim(path)
            if over.get("visible") is False:
                UsdGeom.Imageable(prim).CreateVisibilityAttr().Set(UsdGeom.Tokens.invisible)
            if over.get("active") is False:
                prim.SetActive(False)
        except Exception:
            continue                # inside an instance: nothing may be authored there


def export_scene(scene, path, bake=True, payloads=None, geometry=None, item_json=None,
                 scene_data=None, resolve=None, sidecars=(), edits=None):
    """Write a previz scene to `path` as a USD stage. Returns the path.

    The extras are what a saved scene adds to a plain export: `payloads`
    ({item id: layer}) is the file each item's geometry comes from when it is
    not the item's own (a mesh converted beside the stage); `geometry`
    ({item id: meshes}) what the page built for an image plane; `item_json`
    the items as they are kept (the export's own `scene` may be a baked
    copy); `scene_data` what the scene holds beside its items, on the root;
    `resolve(src)` the file a src names; `sidecars` the layers that are this
    stage's own and so always addressed relatively; `edits` ({item id: edits,
    apply_edits' shape}) the Outliner's changes inside each asset, when they
    differ from the item's own (a converted mesh names its prims anew).
    """
    Gf, Sdf, Usd, UsdGeom, _Vt = _pxr()
    scene = scene or {}
    payloads = payloads or {}
    geometry = geometry or {}
    item_json = item_json or {}
    sidecars = {os.path.normcase(os.path.abspath(p)) for p in sidecars or ()}
    fps = float(scene.get("fps") or 24.0)
    length = max(1, int(scene.get("length") or 120))
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)                     # CreateNew refuses an existing layer

    stage = Usd.Stage.CreateNew(path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    stage.SetTimeCodesPerSecond(fps)
    stage.SetFramesPerSecond(fps)
    stage.SetStartTimeCode(0)
    stage.SetEndTimeCode(length - 1)

    root = UsdGeom.Xform.Define(stage, "/previz")
    stage.SetDefaultPrim(root.GetPrim())
    Usd.ModelAPI(root.GetPrim()).SetKind("assembly")
    root.GetPrim().SetCustomDataByKey(f"{_CUSTOM_KEY}:fps", fps)
    root.GetPrim().SetCustomDataByKey(f"{_CUSTOM_KEY}:length", length)
    if scene.get("activeCamera"):
        root.GetPrim().SetCustomDataByKey(f"{_CUSTOM_KEY}:activeCamera", str(scene["activeCamera"]))
    if scene_data is not None:
        root.GetPrim().SetCustomDataByKey(f"{_CUSTOM_KEY}:scene", json.dumps(scene_data))

    used, layer_dir = set(), os.path.dirname(path)
    # Parents before their children, so a child's prim path can be built from
    # the one its parent got. A scene keeps its items in tree order already;
    # this does not rely on that.
    paths = {}
    for item in _in_tree_order(scene.get("items") or []):
        name = _prim_name(item.get("name"), used)
        parent_path = paths.get(item.get("parent")) or "/previz"
        prim_path = Sdf.Path(f"{parent_path}/{name}")
        paths[item.get("id")] = str(prim_path)
        kind = item.get("kind")
        item_path = prim_path
        own = payloads.get(item.get("id"))

        if kind == "group":
            # A group is an Xform and nothing else: it holds the others, and
            # its transform is theirs too.
            xformable = UsdGeom.Xform.Define(stage, prim_path)
        elif kind == "camera":
            cam = UsdGeom.Camera.Define(stage, prim_path)
            # The film back takes the shape of the picture: the vertical
            # aperture (and so the vertical fov) stays put, and the horizontal
            # one follows the resolution's aspect.
            res_w, res_h = _resolution(item)
            cam.CreateHorizontalApertureAttr(APERTURE_V * res_w / res_h)
            cam.CreateVerticalApertureAttr(APERTURE_V)
            cam.CreateClippingRangeAttr(Gf.Vec2f(0.01, 10000.0))
            xformable = cam
        elif kind == "primitive":
            xformable = _define_shape(stage, prim_path, item)
        elif kind == "light":
            xformable = UsdGeom.Xform.Define(stage, prim_path)
            _define_light(stage, prim_path, item)
        elif kind == "environment":
            xformable = UsdGeom.Xform.Define(stage, prim_path)
            _define_dome(stage, prim_path, item, layer_dir, resolve)
        elif kind == "imageplane":
            xformable = UsdGeom.Xform.Define(stage, prim_path)
            _define_card(stage, prim_path, item, geometry.get(item.get("id")), layer_dir, resolve)
        elif kind in ("terrain", "scatter", "depthmesh") or (kind != "model" and own):
            # Geometry the page built: a layer of its own beside the stage.
            xformable = UsdGeom.Xform.Define(stage, prim_path)
            if own:
                xformable.GetPrim().GetPayloads().AddPayload(_asset_target(own, layer_dir, True))
        else:
            xformable = UsdGeom.Xform.Define(stage, prim_path)
            src = item.get("src") or {}
            asset = own or src.get("asset") or src.get("path")
            src_prim = None if own else src.get("prim")
            if asset and is_usd(asset):
                # A payload, so opening the stage costs nothing until the asset
                # is actually wanted. Relative when it can be, so the stage and
                # its assets can move together.
                ours = os.path.normcase(os.path.abspath(asset)) in sidecars
                target = _asset_target(asset, layer_dir, ours)
                # With a prim path the payload points INTO the stage, which is
                # how an item taken from someone else's layout keeps pointing at
                # the thing it came from rather than at a whole shot.
                if src_prim and not src.get("asset"):
                    xformable.GetPrim().GetPayloads().AddPayload(target, Sdf.Path(src_prim))
                else:
                    xformable.GetPrim().GetPayloads().AddPayload(target)
                if own and (src.get("path") or src.get("filename")):
                    # The file it was converted from, for anyone who wants that.
                    original = resolve(src) if resolve else src.get("path")
                    if original:
                        xformable.GetPrim().SetCustomDataByKey(
                            f"{_CUSTOM_KEY}:source", str(original).replace("\\", "/"))
            elif asset:
                # Not a USD layer, so it can't be payloaded: other packages see
                # an empty xform, and this viewer reads the path back out.
                xformable.GetPrim().SetCustomDataByKey(
                    f"{_CUSTOM_KEY}:asset", asset.replace("\\", "/"))
            inside = (edits or {}).get(item.get("id"))
            if inside is None:
                inside = (item_json.get(item.get("id")) or item).get("usd") or {}
            if asset and is_usd(asset) and (inside.get("overs") or inside.get("variants")):
                apply_edits(stage, item_path, inside)

        prim = xformable.GetPrim()
        prim.SetCustomDataByKey(f"{_CUSTOM_KEY}:item", json.dumps(item_json.get(item.get("id")) or item))
        if item.get("visible") is False:
            UsdGeom.Imageable(prim).CreateVisibilityAttr(UsdGeom.Tokens.invisible)

        offset = _offset_matrix(item)
        span = _animated_range(item) if bake else None
        if span is not None and has_infinity(item):
            # A track that goes on past its keys moves over the whole shot.
            span = (0, length - 1)
        if span is None:
            pos = _with_pivot(item.get("position") or [0, 0, 0], item.get("rotation") or [0, 0, 0],
                              item.get("scale") or [1, 1, 1], item.get("pivot"))
            _set_xform(UsdGeom.Xformable(prim), pos,
                       item.get("rotation") or [0, 0, 0], item.get("scale") or [1, 1, 1])
            if kind == "camera":
                UsdGeom.Camera(prim).CreateFocalLengthAttr(_fov_to_focal(item.get("fov", 35)))
        else:
            first, last = span
            focal_attr = UsdGeom.Camera(prim).CreateFocalLengthAttr() if kind == "camera" else None
            for frame in range(int(first), int(last) + 1):
                rot = value_at(item, "rotation", frame)
                scl = value_at(item, "scale", frame)
                _set_xform(UsdGeom.Xformable(prim),
                           _with_pivot(value_at(item, "position", frame), rot, scl,
                                       value_at(item, "pivot", frame)),
                           rot, scl,
                           time=Usd.TimeCode(frame))
                if focal_attr is not None:
                    focal_attr.Set(_fov_to_focal(value_at(item, "fov", frame)), Usd.TimeCode(frame))
        if offset is not None:
            # Frozen transformations: a matrix under translate / rotate / scale,
            # which is exactly where scene3d's `offset` sits.
            UsdGeom.Xformable(prim).AddTransformOp(opSuffix="frozen").Set(offset)

    stage.GetRootLayer().Save()
    return path


# ── import ───────────────────────────────────────────────────────────────────

def _asset_of(prim, layer_dir):
    """The file a prim pulls in: its payload, its reference, or the path this
    viewer left in customData for a non-USD asset."""
    from pxr import Sdf, Usd
    custom = prim.GetCustomDataByKey(f"{_CUSTOM_KEY}:asset")
    if custom:
        return os.path.abspath(os.path.join(layer_dir, custom)) if not os.path.isabs(custom) else custom

    # The list proxies are not python lists, hence the explicit widening.
    def items(arc_list):
        out = []
        for which in ("prependedItems", "explicitItems", "appendedItems"):
            out.extend(list(getattr(arc_list, which, []) or []))
        return out

    for spec in prim.GetPrimStack():
        for arc in items(spec.payloadList) + items(spec.referenceList):
            if arc.assetPath:
                return _resolve(arc.assetPath, spec.layer, layer_dir)
    return None


def _resolve(asset_path, layer, layer_dir):
    try:
        resolved = layer.ComputeAbsolutePath(asset_path)
        if resolved:
            return os.path.abspath(resolved)
    except Exception:
        pass
    return asset_path if os.path.isabs(asset_path) else os.path.abspath(os.path.join(layer_dir, asset_path))


_SHAPE_BY_TYPE = {
    "Cube": "box", "Sphere": "sphere", "Cylinder": "cylinder",
    "Cone": "cone", "Plane": "plane",
}


def _has_geometry(prim):
    """True when there is anything drawable at or under this prim."""
    _Gf, _Sdf, _Usd, UsdGeom, _Vt = _pxr()
    if UsdGeom.Gprim(prim):
        return True
    for child in prim.GetAllChildren():
        if _has_geometry(child):
            return True
    return False


def _object_prims(stage, root):
    """The prims a previz scene should carry as items.

    A layout stage is a hierarchy, and previz is a flat list, so this picks the
    level that means "one thing you can move": a prim marked as a **component**
    in USD's model hierarchy (what an asset is), else one that pulls an asset in
    through a reference or payload, else a piece of geometry with no such
    ancestor. Once a prim is taken, nothing below it is — otherwise a kitchen
    would import as a thousand separate cupboard doors.
    """
    _Gf, _Sdf, Usd, UsdGeom, _Vt = _pxr()
    chosen, cameras, instancers = [], [], []

    def visit(prim):
        if not prim.IsValid() or not prim.IsActive():
            return
        if UsdGeom.Camera(prim):
            cameras.append(prim)
            return
        # A PointInstancer places its prototypes many times over; the
        # prototypes under it are templates, not things in the scene, so they
        # are not visited — import_scene makes one item per instance instead.
        if prim != root and prim.IsA(UsdGeom.PointInstancer):
            instancers.append(prim)
            return
        model = Usd.ModelAPI(prim)
        kind = model.GetKind() if model else ""
        is_component = kind == "component"
        # A prim that pulls an asset in is an item even when nothing composes
        # under it — a missing file, or an asset whose type the local prim
        # overrides. Dropping it would quietly lose a piece of the layout;
        # keeping it shows the gap, with the reason on the item.
        if prim != root and _has_arc(prim):
            chosen.append(prim)
            return
        if prim != root and is_component and _has_geometry(prim):
            chosen.append(prim)
            return                          # its innards are the asset's business
        if prim != root and UsdGeom.Gprim(prim):
            chosen.append(prim)
            return
        for child in prim.GetAllChildren():
            visit(child)

    visit(root)
    # A stage whose default prim IS the geometry (a single published asset,
    # rather than a layout) has nothing below the root to choose, so the root
    # itself is the object.
    if not chosen and not cameras and not instancers and root.IsValid() \
            and not root.IsPseudoRoot() and _has_geometry(root):
        chosen.append(root)
    return chosen, cameras, instancers


def _has_arc(prim):
    for spec in prim.GetPrimStack():
        for which in ("payloadList", "referenceList"):
            arcs = getattr(spec, which, None)
            if arcs is None:
                continue
            for name in ("prependedItems", "explicitItems", "appendedItems"):
                if list(getattr(arcs, name, []) or []):
                    return True
    return False


def _mark_external(scene):
    """Say that these files are addressed by their own absolute path.

    The viewer has two file routes: /imageviewer/raw_view, which serves ComfyUI's
    output and temp folders by a short name, and /imageviewer/view_file, which serves
    any absolute path inside the allowed folders (path_access). An item without
    this flag is asked for through the first one, and a stage that lives
    anywhere else — the input folder, a project drive — comes back 403 with no
    geometry to show for it.
    """
    for item in scene.get("items", []):
        src = item.get("src")
        if isinstance(src, dict) and src.get("path"):
            src["external"] = True
    return scene


def src_file(src):
    """The file an item's src names, or None: an absolute `path`, or ComfyUI's
    own filename / subfolder / type (a blob: URL names no file)."""
    if not isinstance(src, dict):
        return None
    if src.get("path"):
        return os.path.abspath(str(src["path"]))
    if src.get("filename"):
        try:
            import folder_paths
            base = folder_paths.get_directory_by_type(src.get("type") or "output")
        except Exception:
            base = None
        if not base:
            return None
        base = os.path.abspath(base)
        cand = os.path.abspath(os.path.join(base, str(src.get("subfolder") or ""), str(src["filename"])))
        try:
            if os.path.commonpath([os.path.normcase(base), os.path.normcase(cand)]) != os.path.normcase(base):
                return None
        except ValueError:
            return None
        return cand
    return None


def _src_exists(src):
    f = src_file(src)
    return bool(f and os.path.isfile(f))


def import_scene(path, load_payloads=True):
    """Read a USD stage into a previz scene dict.

    Payloads are composed by default: a layout stage keeps its geometry behind
    them, and without loading there would be nothing to place or to draw. Items
    this viewer wrote come back exactly — keys, easing and colours included —
    from the customData it left behind; anything else is read from the stage as
    it stands.
    """
    _Gf, _Sdf, Usd, UsdGeom, _Vt = _pxr()
    path = os.path.abspath(path)
    # Opened without its payloads first: a stage this viewer wrote keeps all
    # it needs on its own prims, and composing every asset to read that would
    # make opening a big shot as slow as loading all of it.
    stage = Usd.Stage.Open(path, load=Usd.Stage.LoadNone)
    if stage is None:
        raise ValueError(f"{os.path.basename(path)} is not a stage this build can open")
    layer_dir = os.path.dirname(path)

    fps = float(stage.GetTimeCodesPerSecond() or 24.0)
    start = stage.GetStartTimeCode()
    end = stage.GetEndTimeCode()
    length = max(1, int(round(end - start + 1))) if end > start else 120

    # The stage's own range, so a clip inside it never stretches the shot.
    scene = {"version": 1, "fps": fps, "length": length, "lengthSet": True,
             "items": [], "activeCamera": None}
    default = stage.GetDefaultPrim()
    root = default if default and default.IsValid() else stage.GetPseudoRoot()
    active_id = root.GetCustomDataByKey(f"{_CUSTOM_KEY}:activeCamera") if root else None

    # A stage this viewer wrote is read back item by item, exactly as it left.
    ours = []
    for prim in stage.TraverseAll():
        if prim.IsValid() and prim.IsActive() and prim.GetCustomDataByKey(f"{_CUSTOM_KEY}:item"):
            ours.append(prim)
    if ours:
        # A saved scene keeps what it holds beside its items on the root.
        kept = root.GetCustomDataByKey(f"{_CUSTOM_KEY}:scene") if root else None
        if kept:
            try:
                extra = json.loads(kept)
            except Exception:
                extra = None
            if isinstance(extra, dict):
                extra.pop("items", None)
                scene.update(extra)
        for prim in ours:
            try:
                item = json.loads(prim.GetCustomDataByKey(f"{_CUSTOM_KEY}:item"))
            except Exception:
                continue
            asset = _asset_of(prim, layer_dir)
            if asset and item.get("kind") == "model":
                src = item.setdefault("src", {})
                if prim.GetCustomDataByKey(f"{_CUSTOM_KEY}:source") or src.get("usdAsset") is not None:
                    # The mesh was converted beside the stage: the item still
                    # shows the file it came from, and the copy is there for
                    # when that file is gone.
                    src["usdAsset"] = asset
                    if not _src_exists(src):
                        item["src"] = {"path": asset, "name": src.get("name") or os.path.basename(asset),
                                       "format": "usd", "usdAsset": asset}
                else:
                    src["path"] = asset
            scene["items"].append(item)
        order = scene.pop("order", None)
        if isinstance(order, list):
            rank = {ident: i for i, ident in enumerate(order)}
            scene["items"].sort(key=lambda it: rank.get(it.get("id"), len(rank)))
        if active_id and any(it.get("id") == active_id for it in scene["items"]):
            scene["activeCamera"] = active_id
        return _mark_external(scene)

    if load_payloads:
        stage = Usd.Stage.Open(path, load=Usd.Stage.LoadAll)
        default = stage.GetDefaultPrim()
        root = default if default and default.IsValid() else stage.GetPseudoRoot()

    # Anyone else's stage: take the layout, and the geometry under it.
    objects, cameras, instancers = _object_prims(stage, root)
    # Every Xform above a chosen prim comes in as a group, so the stage's
    # hierarchy is the outliner's hierarchy and each item keeps the local
    # transform it was authored with.
    group_ids = {}

    def ensure_group(prim):
        if prim is None or not prim.IsValid() or prim.IsPseudoRoot():
            return None
        key = str(prim.GetPath())
        if key in group_ids:
            return group_ids[key]
        parent_id = ensure_group(prim.GetParent())
        item = _item_from_prim(prim, UsdGeom.Xformable(prim), False, None, None, stage)
        item["kind"] = "group"
        item.pop("src", None)
        item["parent"] = parent_id
        scene["items"].append(item)
        group_ids[key] = item["id"]
        return item["id"]

    for prim in cameras + objects:
        is_camera = bool(UsdGeom.Camera(prim))
        shape = _SHAPE_BY_TYPE.get(prim.GetTypeName()) if not is_camera else None
        # A shape prim that carries other geometry underneath is a group, not a
        # primitive, so it is shown as geometry rather than rebuilt as a sphere.
        if shape and any(_has_geometry(c) for c in prim.GetAllChildren()):
            shape = None
        asset = None if (is_camera or shape) else _asset_of(prim, layer_dir)
        item = _item_from_prim(prim, UsdGeom.Xformable(prim), is_camera, shape, asset, stage)
        item["parent"] = ensure_group(prim.GetParent())
        if not is_camera and not shape:
            # Geometry comes from this stage, at this prim: the server flattens
            # that subtree for the viewport (usd_io.display_proxy) and the item
            # carries the transform the prim has in the stage.
            # Addressed as stage + prim, not as the asset file: that way the
            # composition the stage set up — variants, nested payloads, the
            # transforms inside the asset — is what gets drawn. The asset path
            # rides along for anyone who wants the file itself.
            item["src"] = {"path": path, "prim": str(prim.GetPath()),
                           "name": prim.GetName(), "format": "usd"}
            if asset:
                item["src"]["asset"] = asset
        scene["items"].append(item)

    for instancer in instancers:
        _expand_instancer(instancer, stage, path, layer_dir, ensure_group, scene)
    return _mark_external(scene)


def _expand_instancer(instancer, stage, path, layer_dir, ensure_group, scene):
    """One item per instance of a PointInstancer, grouped under it.

    Each instance draws its prototype's geometry (addressed as stage + the
    prototype's prim, like any other item) at the transform the instancer gives
    it — USD's own ComputeInstanceTransformsAtTime, which also folds in the
    prototype's root transform. The instancer itself becomes the group, so
    moving it moves the lot, as it does in the stage. Masked-off (invisible)
    instances are left out; animated instancers come in at their first sample.
    """
    Gf, _Sdf, Usd, UsdGeom, _Vt = _pxr()
    pi = UsdGeom.PointInstancer(instancer)
    protos = [stage.GetPrimAtPath(t) for t in pi.GetPrototypesRel().GetTargets()]
    indices = list(pi.GetProtoIndicesAttr().Get() or [])
    if not protos or not indices:
        return
    samples = sorted(pi.GetPositionsAttr().GetTimeSamples() or [])
    time = Usd.TimeCode(samples[0]) if samples else Usd.TimeCode.Default()
    matrices = pi.ComputeInstanceTransformsAtTime(time, time)
    hidden = set(pi.GetInvisibleIdsAttr().Get(time) or [])
    ids = list(pi.GetIdsAttr().Get(time) or [])
    group_id = ensure_group(instancer)
    for i, (proto_index, matrix) in enumerate(zip(indices, matrices)):
        if (ids[i] if i < len(ids) else i) in hidden:
            continue
        if not (0 <= proto_index < len(protos)) or not protos[proto_index].IsValid():
            continue
        proto = protos[proto_index]
        shape = _SHAPE_BY_TYPE.get(proto.GetTypeName())
        if shape and any(_has_geometry(c) for c in proto.GetAllChildren()):
            shape = None
        asset = None if shape else _asset_of(proto, layer_dir)
        item = _item_from_prim(proto, UsdGeom.Xformable(proto), False, shape, asset, stage)
        position, rotation, scale = _decompose(Gf.Matrix4d(matrix))
        item.update({
            "id": f"usd_{abs(hash(str(instancer.GetPath()) + '#' + str(i))) & 0xffffffff:x}",
            "name": f"{proto.GetName()}_{i + 1}",
            "position": position, "rotation": rotation, "scale": scale,
            "tracks": {},
            "parent": group_id,
        })
        if not shape:
            item["src"] = {"path": path, "prim": str(proto.GetPath()),
                           "name": proto.GetName(), "format": "usd"}
            if asset:
                item["src"]["asset"] = asset
        scene["items"].append(item)


def _item_from_prim(prim, xformable, is_camera, shape, asset, stage):
    """A previz item for a prim some other package authored.

    The transform read here is the prim's own, LOCAL to its parent — the scene
    carries the stage's hierarchy as group items, so a chair three groups deep
    keeps the numbers it was authored with and moves when its groups move.
    """
    _Gf, _Sdf, Usd, UsdGeom, _Vt = _pxr()
    name = prim.GetName()
    # This prim's own samples. A parent that animates is a group of its own and
    # brings its own keys, so nothing has to be baked down the chain.
    xf = UsdGeom.Xformable(prim)
    times = sorted(xf.GetTimeSamples() or []) if xf else []

    def at(time):
        return _decompose(xf.GetLocalTransformation(Usd.TimeCode(time)) if xf else _Gf.Matrix4d(1.0))

    position, rotation, scale = at(times[0] if times else Usd.TimeCode.Default())
    item = {
        "id": f"usd_{abs(hash(str(prim.GetPath()))) & 0xffffffff:x}",
        "kind": "camera" if is_camera else ("primitive" if shape else "model"),
        "name": name,
        "position": position, "rotation": rotation, "scale": scale,
        "visible": UsdGeom.Imageable(prim).ComputeVisibility() != UsdGeom.Tokens.invisible,
        "tracks": {},
    }
    if is_camera:
        cam = UsdGeom.Camera(prim)
        focal = cam.GetFocalLengthAttr().Get()
        aperture = cam.GetVerticalApertureAttr().Get()
        item["fov"] = _focal_to_fov(focal, aperture)
        # Only the shape of the picture is in the stage, not its size: 1080
        # lines at the film back's aspect.
        h_ap = cam.GetHorizontalApertureAttr().Get() or APERTURE_H
        v_ap = aperture or APERTURE_V
        item["resolution"] = [max(1, int(round(1080 * float(h_ap) / float(v_ap)))), 1080]
    elif shape:
        item["primitive"] = {"type": shape}
        color = UsdGeom.Gprim(prim).GetDisplayColorAttr().Get()
        if color:
            r, g, b = color[0]
            item["color"] = "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))
    else:
        item["src"] = {"path": asset, "name": os.path.basename(asset or name)}

    # Time samples become keys. USD interpolates linearly between them, so that
    # is the easing they come back with — anything else would be a guess.
    if len(times) > 1:
        tracks = {"position": [], "rotation": [], "scale": []}
        for time in times:
            p, r, s = at(time)
            frame = int(round(time))
            tracks["position"].append({"f": frame, "v": p, "ease": "linear"})
            tracks["rotation"].append({"f": frame, "v": r, "ease": "linear"})
            tracks["scale"].append({"f": frame, "v": s, "ease": "linear"})
        item["tracks"] = tracks
    if is_camera:
        focal_attr = UsdGeom.Camera(prim).GetFocalLengthAttr()
        focal_times = focal_attr.GetTimeSamples() or []
        if len(focal_times) > 1:
            aperture = UsdGeom.Camera(prim).GetVerticalApertureAttr().Get()
            item.setdefault("tracks", {})["fov"] = [
                {"f": int(round(t)), "v": _focal_to_fov(focal_attr.Get(t), aperture), "ease": "linear"}
                for t in focal_times
            ]
    return item


# ── showing USD geometry in the viewer ───────────────────────────────────────
#
# The viewport speaks glTF, so a USD asset is flattened to a GLB once and cached
# beside the other proxies (the same trick exr uses to reach an <img>). It is a
# display copy and nothing else: composition, variants and materials stay in the
# stage, which is what the scene references and what gets exported again.

def _triangulate(counts, indices):
    """Fan-triangulate USD's face-vertex lists into triangles."""
    tris, at = [], 0
    for count in counts:
        if count >= 3:
            base = indices[at]
            for k in range(1, count - 1):
                tris.append((base, indices[at + k], indices[at + k + 1]))
        at += count
    return tris


# Opened stages, shared for a while. A layout stage opened as a scene becomes
# one item per model prim, and each asks for its own display copy and its own
# Outliner tree - hundreds of requests for ONE file (Pixar's Kitchen Set: 425
# items). Opening the whole stage with its payloads for each took seconds
# apiece; they now share one open stage per file and set of edits.
_STAGES = OrderedDict()
_STAGES_LOCK = threading.Lock()
STAGE_KEEP = 3          # stages kept open
STAGE_TTL = 60.0        # seconds: a sublayer changed on disk is seen after this


def _file_stamp(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


@contextlib.contextmanager
def shared_stage(path, base=None, edits=None):
    """The stage at `path`, all payloads loaded, with `edits` authored in its
    session layer under `base` (a prim path; else the default prim), held for
    the caller alone while inside the `with`. Reused while the file is unchanged
    and for at most STAGE_TTL seconds; never written to disk."""
    _Gf, _Sdf, Usd, _UsdGeom, _Vt = _pxr()
    path = os.path.abspath(path)
    ekey = _edits_key(edits)
    key = (os.path.normcase(path), _file_stamp(path), (base or "") if ekey else "", ekey)
    now = _time.monotonic()
    with _STAGES_LOCK:
        for k in [k for k, v in _STAGES.items() if now - v["at"] > STAGE_TTL and not v["lock"].locked()]:
            _STAGES.pop(k, None)
        slot = _STAGES.get(key)
        if slot is None:
            slot = {"stage": None, "lock": threading.Lock(), "at": now, "error": None}
            _STAGES[key] = slot
            while len(_STAGES) > STAGE_KEEP:
                _STAGES.popitem(last=False)
        else:
            _STAGES.move_to_end(key)
    with slot["lock"]:
        if slot["stage"] is None:
            stage = Usd.Stage.Open(path, load=Usd.Stage.LoadAll)
            if stage is None:
                with _STAGES_LOCK:
                    if _STAGES.get(key) is slot:
                        _STAGES.pop(key, None)
                raise ValueError(f"could not open {os.path.basename(path)}")
            if ekey:
                # The Outliner's changes inside the asset (usd_scene): in the session
                # layer, so the file is read as it is and shown as it is edited.
                root = base or (str(stage.GetDefaultPrim().GetPath()) if stage.GetDefaultPrim() else "/")
                stage.SetEditTarget(stage.GetSessionLayer())
                apply_edits(stage, root, edits)
            slot["stage"] = stage
        yield slot["stage"]


def _all_prims(Usd, root=None, stage=None):
    """Every prim below `root` (or of `stage`), INSIDE instances too: an
    instanced asset's meshes are instance proxies, which a plain traversal
    leaves out (an instanced stage drew nothing)."""
    pred = Usd.TraverseInstanceProxies(Usd.PrimAllPrimsPredicate)
    if root is not None:
        return Usd.PrimRange(root, pred)
    return Usd.PrimRange.Stage(stage, pred)


def stage_to_mesh(path, time=None, prim_path=None, edits=None):
    """Visible meshes flattened into (vertices, faces, colors).

    With `prim_path`, only that subtree is taken and it comes back in that
    prim's own space — the item carries the prim's world transform, so the two
    must not both apply it. Meshes tagged `guide` are skipped.

    Triangles, one buffer: a preview of the stage, not a faithful copy of it.
    Numpy arrays: vertices (N, 3) float, faces (M, 3) int, colors (N, 3) float.
    """
    import numpy as np
    Gf, _Sdf, Usd, UsdGeom, _Vt = _pxr()
    with shared_stage(path, prim_path, edits) as stage:
        when = Usd.TimeCode(time) if time is not None else Usd.TimeCode.EarliestTime()
        xform_cache = UsdGeom.XformCache(when)

        subtree_root = None
        to_local = None
        if prim_path:
            subtree_root = stage.GetPrimAtPath(prim_path)
            if not subtree_root or not subtree_root.IsValid():
                raise ValueError(f"{prim_path} is not in {os.path.basename(path)}")
            to_local = xform_cache.GetLocalToWorldTransform(subtree_root).GetInverse()

        verts, tris, cols = [], [], []
        offset = 0
        for prim in _all_prims(Usd, subtree_root, stage):
            mesh = UsdGeom.Mesh(prim)
            if not mesh or not prim.IsActive():
                continue
            imageable = UsdGeom.Imageable(prim)
            if imageable.ComputeVisibility(when) == UsdGeom.Tokens.invisible:
                continue
            if imageable.ComputePurpose() == UsdGeom.Tokens.guide:
                continue

            points = mesh.GetPointsAttr().Get(when)
            counts = mesh.GetFaceVertexCountsAttr().Get(when)
            indices = mesh.GetFaceVertexIndicesAttr().Get(when)
            if not points or not counts or not indices:
                continue

            matrix = xform_cache.GetLocalToWorldTransform(prim)
            if to_local is not None:
                matrix = matrix * to_local
            # Gf matrices act on row vectors: world = [p, 1] . M
            m = np.array(matrix, dtype=np.float64).reshape(4, 4)
            pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
            world = pts @ m[:3, :3] + m[3, :3]
            verts.append(world)

            rgb = (0.6, 0.6, 0.6)
            display = UsdGeom.Gprim(prim).GetDisplayColorAttr().Get(when)
            if display:
                rgb = (display[0][0], display[0][1], display[0][2])
            cols.append(np.tile(np.asarray(rgb, dtype=np.float64), (len(pts), 1)))

            faces = _triangulate(list(counts), list(indices))
            if faces:
                tris.append(np.asarray(faces, dtype=np.int64).reshape(-1, 3) + offset)
            offset += len(pts)

    if not verts or not tris:
        raise ValueError(f"{os.path.basename(path)} has no visible geometry to show")
    return np.concatenate(verts), np.concatenate(tris), np.concatenate(cols)


def _cache_path(src, prim_path=None, edits_key=""):
    """Where a stage's display copy lives: the temp dir, keyed on the file (and
    the prim, when only part of it is wanted) so a changed stage lands on a new
    entry rather than a stale one."""
    import hashlib
    import folder_paths
    tmp = folder_paths.get_temp_directory()
    os.makedirs(tmp, exist_ok=True)
    key = os.path.normcase(os.path.abspath(src)) + "|" + (prim_path or "") + "|" + (edits_key or "")
    digest = hashlib.sha1(key.encode("utf-8", "replace")).hexdigest()[:16]
    stem = "".join(c for c in os.path.splitext(os.path.basename(src))[0]
                   if c.isalnum() or c in "-_")[:40] or "stage"
    return os.path.join(tmp, f"ImageViewer_usd_{stem}_{digest}.glb")


def _edits_key(edits):
    import hashlib
    if not edits or not (edits.get("overs") or edits.get("variants")):
        return ""
    blob = json.dumps({"o": edits.get("overs") or {}, "v": edits.get("variants") or {}}, sort_keys=True)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def display_proxy(path, prim_path=None, edits=None):
    """A GLB standing in for a USD file (or one prim of it), built once and
    reused until the stage changes.

    Returns None when this install has no USD, so callers fall back to their
    ordinary "cannot show this" path instead of failing.
    """
    if not available() or not is_usd(path):
        return None
    key = _edits_key(edits)
    dst = _cache_path(path, prim_path, key)
    with _BUILD_LOCK:
        lock = _BUILDS.setdefault(dst, threading.Lock())
    with lock:                      # the same copy asked for twice is built once
        try:
            if os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(path):
                return dst
        except OSError:
            pass
        return _build_proxy(path, prim_path, edits if key else None, dst)


_BUILDS = {}
_BUILD_LOCK = threading.Lock()


def _build_proxy(path, prim_path, edits, dst):
    import numpy as np
    import torch
    vertices, faces, colors = stage_to_mesh(path, prim_path=prim_path, edits=edits)

    from comfy_extras.nodes_save_3d import save_glb
    save_glb(
        torch.tensor(np.asarray(vertices, dtype=np.float32)),
        torch.tensor(np.asarray(faces, dtype=np.int64)),
        dst,
        vertex_colors=torch.tensor(np.asarray(colors, dtype=np.float32)),
    )
    return dst
