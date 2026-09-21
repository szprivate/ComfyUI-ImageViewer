"""Previz stages as USD: the viewer's scene written out and read back.

The previz scene (js/bEpicViewer_scene3d.js) is a flat list of items with a
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

import json
import math
import os

USD_EXTS = {".usd", ".usda", ".usdc", ".usdz"}

# 35 mm still: the aperture the focal lengths below are quoted against, and the
# one most packages assume when nothing says otherwise.
APERTURE_H = 36.0
APERTURE_V = 24.0

_CUSTOM_KEY = "bEpicViewer"


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

def _shape(t, ease):
    if ease == "linear":
        return t
    if ease == "hold":
        return 0.0
    return t * t * (3 - 2 * t)


def _lerp_angle(a, b, t):
    d = (b - a) % 360.0
    if d > 180:
        d -= 360
    if d < -180:
        d += 360
    return a + d * t


def value_at(item, prop, frame):
    """What `prop` is at `frame` — the same answer the viewer draws.

    A second implementation of the interpolation in scene3d.js, kept
    deliberately small and checked against it in the tests: baking has to agree
    with the viewport, or an exported stage would not match what was previewed.
    """
    keys = ((item.get("tracks") or {}).get(prop)) or []
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
    t = _shape((frame - a["f"]) / span, a.get("ease", "smooth")) if span > 0 else 0.0
    if isinstance(a["v"], (list, tuple)):
        if prop == "rotation":
            return [_lerp_angle(a["v"][k], b["v"][k], t) for k in range(len(a["v"]))]
        return [a["v"][k] + (b["v"][k] - a["v"][k]) * t for k in range(len(a["v"]))]
    return a["v"] + (b["v"] - a["v"]) * t


def _animated_range(item):
    """(first, last) frame this item has keys on, or None when it is still."""
    frames = []
    for prop in ("position", "rotation", "scale", "fov"):
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


def export_scene(scene, path, bake=True):
    """Write a previz scene to `path` as a USD stage. Returns the path."""
    Gf, Sdf, Usd, UsdGeom, _Vt = _pxr()
    scene = scene or {}
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
    root.GetPrim().SetCustomDataByKey(f"{_CUSTOM_KEY}:fps", fps)
    root.GetPrim().SetCustomDataByKey(f"{_CUSTOM_KEY}:length", length)
    if scene.get("activeCamera"):
        root.GetPrim().SetCustomDataByKey(f"{_CUSTOM_KEY}:activeCamera", str(scene["activeCamera"]))

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

        if kind == "group":
            # A group is an Xform and nothing else: it holds the others, and
            # its transform is theirs too.
            xformable = UsdGeom.Xform.Define(stage, prim_path)
        elif kind == "camera":
            cam = UsdGeom.Camera.Define(stage, prim_path)
            cam.CreateHorizontalApertureAttr(APERTURE_H)
            cam.CreateVerticalApertureAttr(APERTURE_V)
            cam.CreateClippingRangeAttr(Gf.Vec2f(0.01, 10000.0))
            xformable = cam
        elif kind == "primitive":
            xformable = _define_shape(stage, prim_path, item)
        else:
            xformable = UsdGeom.Xform.Define(stage, prim_path)
            src = item.get("src") or {}
            asset = src.get("asset") or src.get("path")
            prim_path = src.get("prim")
            if asset and is_usd(asset):
                # A payload, so opening the stage costs nothing until the asset
                # is actually wanted. Relative when it can be, so the stage and
                # its assets can move together.
                try:
                    rel = os.path.relpath(asset, layer_dir).replace("\\", "/")
                    target = rel if not rel.startswith("..") else asset.replace("\\", "/")
                except ValueError:
                    target = asset.replace("\\", "/")
                # With a prim path the payload points INTO the stage, which is
                # how an item taken from someone else's layout keeps pointing at
                # the thing it came from rather than at a whole shot.
                if prim_path and not src.get("asset"):
                    xformable.GetPrim().GetPayloads().AddPayload(target, Sdf.Path(prim_path))
                else:
                    xformable.GetPrim().GetPayloads().AddPayload(target)
            elif asset:
                # Not a USD layer, so it can't be payloaded: other packages see
                # an empty xform, and this viewer reads the path back out.
                xformable.GetPrim().SetCustomDataByKey(
                    f"{_CUSTOM_KEY}:asset", asset.replace("\\", "/"))

        prim = xformable.GetPrim()
        prim.SetCustomDataByKey(f"{_CUSTOM_KEY}:item", json.dumps(item))
        if item.get("visible") is False:
            UsdGeom.Imageable(prim).CreateVisibilityAttr(UsdGeom.Tokens.invisible)

        span = _animated_range(item) if bake else None
        if span is None:
            _set_xform(UsdGeom.Xformable(prim), item.get("position") or [0, 0, 0],
                       item.get("rotation") or [0, 0, 0], item.get("scale") or [1, 1, 1])
            if kind == "camera":
                UsdGeom.Camera(prim).CreateFocalLengthAttr(_fov_to_focal(item.get("fov", 35)))
        else:
            first, last = span
            focal_attr = UsdGeom.Camera(prim).CreateFocalLengthAttr() if kind == "camera" else None
            for frame in range(int(first), int(last) + 1):
                _set_xform(UsdGeom.Xformable(prim),
                           value_at(item, "position", frame),
                           value_at(item, "rotation", frame),
                           value_at(item, "scale", frame),
                           time=Usd.TimeCode(frame))
                if focal_attr is not None:
                    focal_attr.Set(_fov_to_focal(value_at(item, "fov", frame)), Usd.TimeCode(frame))

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
    chosen, cameras = [], []

    def visit(prim):
        if not prim.IsValid() or not prim.IsActive():
            return
        if UsdGeom.Camera(prim):
            cameras.append(prim)
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
    if not chosen and not cameras and root.IsValid() and not root.IsPseudoRoot() and _has_geometry(root):
        chosen.append(root)
    return chosen, cameras


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

    The viewer has two file routes: /bepic/raw_view, which serves ComfyUI's
    output and temp folders by a short name, and /bepic/view_file, which serves
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
    stage = Usd.Stage.Open(path, load=Usd.Stage.LoadAll if load_payloads else Usd.Stage.LoadNone)
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
        for prim in ours:
            try:
                item = json.loads(prim.GetCustomDataByKey(f"{_CUSTOM_KEY}:item"))
            except Exception:
                continue
            asset = _asset_of(prim, layer_dir)
            if asset and item.get("kind") == "model":
                item.setdefault("src", {})
                item["src"]["path"] = asset
            scene["items"].append(item)
        if active_id and any(it.get("id") == active_id for it in scene["items"]):
            scene["activeCamera"] = active_id
        return _mark_external(scene)

    # Anyone else's stage: take the layout, and the geometry under it.
    objects, cameras = _object_prims(stage, root)
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
    return _mark_external(scene)


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


def stage_to_mesh(path, time=None, prim_path=None):
    """Visible meshes flattened into (vertices, faces, colors).

    With `prim_path`, only that subtree is taken and it comes back in that
    prim's own space — the item carries the prim's world transform, so the two
    must not both apply it. Meshes tagged `guide` are skipped.

    Triangles, one buffer: a preview of the stage, not a faithful copy of it.
    """
    Gf, _Sdf, Usd, UsdGeom, _Vt = _pxr()
    stage = Usd.Stage.Open(path, load=Usd.Stage.LoadAll)
    if stage is None:
        raise ValueError(f"could not open {os.path.basename(path)}")
    when = Usd.TimeCode(time) if time is not None else Usd.TimeCode.EarliestTime()

    vertices, faces, colors = [], [], []
    xform_cache = UsdGeom.XformCache(when)

    subtree_root = None
    to_local = None
    if prim_path:
        subtree_root = stage.GetPrimAtPath(prim_path)
        if not subtree_root or not subtree_root.IsValid():
            raise ValueError(f"{prim_path} is not in {os.path.basename(path)}")
        to_local = xform_cache.GetLocalToWorldTransform(subtree_root).GetInverse()

    prims = Usd.PrimRange(subtree_root) if subtree_root else stage.TraverseAll()
    for prim in prims:
        mesh = UsdGeom.Mesh(prim)
        if not mesh or not prim.IsActive():
            continue
        imageable = UsdGeom.Imageable(prim)
        if imageable.ComputeVisibility(when) == UsdGeom.Tokens.invisible:
            continue
        purpose = imageable.ComputePurpose()
        if purpose == UsdGeom.Tokens.guide:
            continue

        points = mesh.GetPointsAttr().Get(when)
        counts = mesh.GetFaceVertexCountsAttr().Get(when)
        indices = mesh.GetFaceVertexIndicesAttr().Get(when)
        if not points or not counts or not indices:
            continue

        matrix = xform_cache.GetLocalToWorldTransform(prim)
        if to_local is not None:
            matrix = matrix * to_local
        offset = len(vertices)
        for p in points:
            world = matrix.Transform(Gf.Vec3d(p[0], p[1], p[2]))
            vertices.append((world[0], world[1], world[2]))

        rgb = (0.6, 0.6, 0.6)
        display = UsdGeom.Gprim(prim).GetDisplayColorAttr().Get(when)
        if display:
            rgb = (display[0][0], display[0][1], display[0][2])
        colors.extend([rgb] * len(points))

        for tri in _triangulate(list(counts), list(indices)):
            faces.append((tri[0] + offset, tri[1] + offset, tri[2] + offset))

    if not vertices or not faces:
        raise ValueError(f"{os.path.basename(path)} has no visible geometry to show")
    return vertices, faces, colors


def _cache_path(src, prim_path=None):
    """Where a stage's display copy lives: the temp dir, keyed on the file (and
    the prim, when only part of it is wanted) so a changed stage lands on a new
    entry rather than a stale one."""
    import hashlib
    import folder_paths
    tmp = folder_paths.get_temp_directory()
    os.makedirs(tmp, exist_ok=True)
    key = os.path.normcase(os.path.abspath(src)) + "|" + (prim_path or "")
    digest = hashlib.sha1(key.encode("utf-8", "replace")).hexdigest()[:16]
    stem = "".join(c for c in os.path.splitext(os.path.basename(src))[0]
                   if c.isalnum() or c in "-_")[:40] or "stage"
    return os.path.join(tmp, f"bEpic_usd_{stem}_{digest}.glb")


def display_proxy(path, prim_path=None):
    """A GLB standing in for a USD file (or one prim of it), built once and
    reused until the stage changes.

    Returns None when this install has no USD, so callers fall back to their
    ordinary "cannot show this" path instead of failing.
    """
    if not available() or not is_usd(path):
        return None
    dst = _cache_path(path, prim_path)
    try:
        if os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(path):
            return dst
    except OSError:
        pass

    import numpy as np
    import torch
    vertices, faces, colors = stage_to_mesh(path, prim_path=prim_path)

    from comfy_extras.nodes_save_3d import save_glb
    save_glb(
        torch.tensor(np.asarray(vertices, dtype=np.float32)),
        torch.tensor(np.asarray(faces, dtype=np.int64)),
        dst,
        vertex_colors=torch.tensor(np.asarray(colors, dtype=np.float32)),
    )
    return dst
