"""Animated characters out of the 3D space: FBX (skeleton, skin, keys) and Alembic (baked meshes).

The browser has the character — its meshes, its skeleton, and the pose the rig
puts it in at every frame — so it does the sampling and posts the numbers here
(`collect` in js/imageViewer_previzExport.js). This module only writes files,
with no SDK: ComfyUI has no FBX writer and Alembic has no Python wheel, so
both formats are written directly, from their published structure.

FBX (binary, version 7.4)
    A file header, then a tree of records: each a name, a list of typed
    properties and nested records. A character is
        Objects      a Null for the character, a Model per bone (LimbNode)
                     and per mesh, the mesh's Geometry, a Skin deformer with a
                     Cluster per bone (its vertex weights and bind matrices),
                     a BindPose, and an animation stack: per bone a curve node
                     per channel (Lcl Translation / Rotation / Scaling) holding
                     one curve per axis, keyed on every frame;
        Connections  who is the child of whom, and which curve drives which
                     property.
    Lengths are the scene's units declared as metres (UnitScaleFactor 100:
    one unit = 100 cm). Rotations are Euler degrees in FBX's default order
    (X first, then Y, then Z).

Alembic (Ogawa)
    The container abc_io.py reads: groups and data blocks, an object tree
    with packed property headers. Each mesh is an Xform holding a PolyMesh
    whose points (`P`) are sampled on every frame — the skinned result, in
    world space — so any application plays it back without a rig. Faces are
    written in Alembic's winding (the reverse of glTF's).
"""

import hashlib
import math
import struct
import time
import zlib

import numpy as np

# ── shared ───────────────────────────────────────────────────────────────────


def _euler_fbx(q):
    """FBX XYZ Euler degrees (applied X, then Y, then Z) from a quaternion [x, y, z, w]."""
    x, y, z, w = q
    # rotation matrix, row r column c
    m11 = 1 - 2 * (y * y + z * z); m12 = 2 * (x * y - w * z); m13 = 2 * (x * z + w * y)
    m21 = 2 * (x * y + w * z); m22 = 1 - 2 * (x * x + z * z); m23 = 2 * (y * z - w * x)
    m31 = 2 * (x * z - w * y); m32 = 2 * (y * z + w * x); m33 = 1 - 2 * (x * x + y * y)
    # R = Rz * Ry * Rx
    ry = math.asin(max(-1.0, min(1.0, -m31)))
    if abs(m31) < 0.9999999:
        rx = math.atan2(m32, m33)
        rz = math.atan2(m21, m11)
    else:
        rx = 0.0
        rz = math.atan2(-m12, m22)
    del m13, m23
    return [math.degrees(rx), math.degrees(ry), math.degrees(rz)]


def _unwrap(seq):
    """Keep consecutive Euler triples within 180° of each other per axis."""
    out = []
    prev = None
    for e in seq:
        if prev is not None:
            e = [v + 360.0 * round((p - v) / 360.0) for v, p in zip(e, prev)]
        out.append(e)
        prev = e
    return out


# ── FBX ──────────────────────────────────────────────────────────────────────

KTIME_SECOND = 46186158000
_FBX_VERSION = 7400
_SENTINEL = b"\0" * 13
_ALWAYS_SENTINEL = {"AnimationStack", "AnimationLayer"}
# The fixed id / time pair every FBX writer outside the SDK uses: the SDK
# checks the footer against them.
_FILE_ID = b"\x28\xb3\x2a\xeb\xb6\x24\xcc\xc2\xbf\xc8\xb0\x2a\xa9\x2b\xfc\xf1"
_CREATION = "1970-01-01 10:00:00:000"
_FOOT_ID = b"\xfa\xbc\xab\x09\xd0\xc8\xd4\x66\xb1\x76\xfb\x83\x1c\xf7\x26\x7e"
_FOOT_END = b"\xf8\x5a\x8c\x6a\xde\xf5\xd9\x7e\xec\xe9\x0c\xe3\x75\x8f\x29\x0b"
_TIME_MODES = {120: 1, 100: 2, 60: 3, 50: 4, 48: 5, 30: 6, 25: 10, 24: 11, 1000: 12, 96: 15, 72: 16}


class _N:
    """One FBX record: a name, typed properties, children."""

    __slots__ = ("name", "props", "kids")

    def __init__(self, name, *props):
        self.name = name
        self.props = list(props)
        self.kids = []

    def add(self, name, *props):
        n = _N(name, *props)
        self.kids.append(n)
        return n


class _T:
    """A property with an explicit FBX type code (for ints that must be 64-bit, arrays...)."""

    __slots__ = ("code", "value")

    def __init__(self, code, value):
        self.code = code
        self.value = value


def _prop_bytes(p):
    if isinstance(p, _T):
        code, v = p.code, p.value
    elif isinstance(p, bool):
        code, v = "C", p
    elif isinstance(p, int):
        code, v = ("I" if -2 ** 31 <= p < 2 ** 31 else "L"), p
    elif isinstance(p, float):
        code, v = "D", p
    elif isinstance(p, (bytes, bytearray)):
        code, v = "R", bytes(p)
    else:
        code, v = "S", str(p)
    if code == "C":
        return b"C" + struct.pack("<B", 1 if v else 0)
    if code == "Y":
        return b"Y" + struct.pack("<h", v)
    if code == "I":
        return b"I" + struct.pack("<i", v)
    if code == "L":
        return b"L" + struct.pack("<q", v)
    if code == "F":
        return b"F" + struct.pack("<f", v)
    if code == "D":
        return b"D" + struct.pack("<d", v)
    if code in ("S", "R"):
        raw = v.encode("utf-8") if isinstance(v, str) else v
        return code.encode() + struct.pack("<I", len(raw)) + raw
    if code in ("f", "d", "i", "l", "b"):
        dtype = {"f": "<f4", "d": "<f8", "i": "<i4", "l": "<i8", "b": "u1"}[code]
        arr = np.ascontiguousarray(np.asarray(v, dtype=dtype).ravel())
        raw = arr.tobytes()
        if len(raw) > 128:
            packed = zlib.compress(raw, 6)
            return code.encode() + struct.pack("<III", arr.size, 1, len(packed)) + packed
        return code.encode() + struct.pack("<III", arr.size, 0, len(raw)) + raw
    raise ValueError(f"unknown FBX property type {code}")


def _write_node(out, node):
    start = len(out)
    out += b"\0" * 12                     # end offset, property count, property bytes: filled below
    name = node.name.encode()
    out += struct.pack("<B", len(name)) + name
    p0 = len(out)
    for p in node.props:
        out += _prop_bytes(p)
    plen = len(out) - p0
    for k in node.kids:
        _write_node(out, k)
    if node.kids or not node.props or node.name in _ALWAYS_SENTINEL:
        out += _SENTINEL
    struct.pack_into("<III", out, start, len(out), len(node.props), plen)


def _p70(parent, rows):
    """A Properties70 block: rows of (name, type, label, flags, *values)."""
    p = parent.add("Properties70")
    for r in rows:
        p.add("P", *r)
    return p


def _fbx_bytes(top):
    out = bytearray(b"Kaydara FBX Binary  \x00\x1a\x00" + struct.pack("<I", _FBX_VERSION))
    for n in top:
        _write_node(out, n)
    out += _SENTINEL
    out += _FOOT_ID + b"\0\0\0\0"
    pad = ((len(out) + 15) & ~15) - len(out)
    out += b"\0" * (pad or 16)
    out += struct.pack("<I", _FBX_VERSION) + b"\0" * 120 + _FOOT_END
    return bytes(out)


def write_fbx(path, data):
    """Write a character as FBX. `data` is what `parse_payload` returns."""
    fps = float(data.get("fps") or 24)
    frames = list(data.get("frames") or [0])
    bones = data["bones"]
    meshes = data["meshes"]
    ids = iter(range(1_000_000, 10_000_000))
    nid = lambda: next(ids)  # noqa: E731

    header = _N("FBXHeaderExtension")
    header.add("FBXHeaderVersion", 1003)
    header.add("FBXVersion", _FBX_VERSION)
    ts = header.add("CreationTimeStamp")
    now = time.localtime()
    for k, v in (("Version", 1000), ("Year", now.tm_year), ("Month", now.tm_mon), ("Day", now.tm_mday),
                 ("Hour", now.tm_hour), ("Minute", now.tm_min), ("Second", now.tm_sec), ("Millisecond", 0)):
        ts.add(k, v)
    header.add("Creator", "ComfyUI Image Viewer")
    top = [header, _N("FileId", _FILE_ID), _N("CreationTime", _CREATION), _N("Creator", "ComfyUI Image Viewer")]

    t0, t1 = frames[0] / fps, frames[-1] / fps
    gs = _N("GlobalSettings")
    gs.add("Version", 1000)
    mode = _TIME_MODES.get(int(round(fps)), 14) if abs(fps - round(fps)) < 1e-6 else 14
    _p70(gs, [
        ("UpAxis", "int", "Integer", "", 1), ("UpAxisSign", "int", "Integer", "", 1),
        ("FrontAxis", "int", "Integer", "", 2), ("FrontAxisSign", "int", "Integer", "", 1),
        ("CoordAxis", "int", "Integer", "", 0), ("CoordAxisSign", "int", "Integer", "", 1),
        ("OriginalUpAxis", "int", "Integer", "", 1), ("OriginalUpAxisSign", "int", "Integer", "", 1),
        ("UnitScaleFactor", "double", "Number", "", 100.0),
        ("OriginalUnitScaleFactor", "double", "Number", "", 100.0),
        ("TimeMode", "enum", "", "", mode),
        ("TimeSpanStart", "KTime", "Time", "", _T("L", int(round(t0 * KTIME_SECOND)))),
        ("TimeSpanStop", "KTime", "Time", "", _T("L", int(round(t1 * KTIME_SECOND)))),
        ("CustomFrameRate", "double", "Number", "", fps),
    ])
    top.append(gs)
    doc_id = nid()
    docs = _N("Documents")
    docs.add("Count", 1)
    d = docs.add("Document", _T("L", doc_id), "Scene", "Scene")
    _p70(d, [("SourceObject", "object", "", ""), ("ActiveAnimStackName", "KString", "", "", "Take 001")])
    d.add("RootNode", _T("L", 0))
    top += [docs, _N("References")]

    objects = _N("Objects")
    conns = _N("Connections")
    counts = {}

    def count(kind):
        counts[kind] = counts.get(kind, 0) + 1

    def link(child, parent, prop=None):
        if prop is None:
            conns.add("C", "OO", _T("L", child), _T("L", parent))
        else:
            conns.add("C", "OP", _T("L", child), _T("L", parent), prop)

    def model(name, kind, t, r, s, extra=()):
        mid = nid()
        m = objects.add("Model", _T("L", mid), f"{name}\x00\x01Model", kind)
        m.add("Version", 232)
        _p70(m, [
            ("RotationActive", "bool", "", "", 1),
            ("InheritType", "enum", "", "", 1),
            ("ScalingMax", "Vector3D", "Vector", "", 0.0, 0.0, 0.0),
            ("DefaultAttributeIndex", "int", "Integer", "", 0),
            ("Lcl Translation", "Lcl Translation", "", "A", *map(float, t)),
            ("Lcl Rotation", "Lcl Rotation", "", "A", *map(float, r)),
            ("Lcl Scaling", "Lcl Scaling", "", "A", *map(float, s)),
            *extra,
        ])
        m.add("Shading", True)
        m.add("Culling", "CullingOff")
        count("Model")
        return mid

    # The character: a Null carrying the model item's place in the scene.
    root = data.get("root") or {}
    rt = root.get("t") or [0, 0, 0]
    rq = root.get("q") or [0, 0, 0, 1]
    rs = root.get("s") or [1, 1, 1]
    char_id = model(data.get("name") or "character", "Null", rt, _euler_fbx(rq), rs)
    na = objects.add("NodeAttribute", _T("L", nid()), "\x00\x01NodeAttribute", "Null")
    na.add("TypeFlags", "Null")
    count("NodeAttribute")
    link(na.props[0].value, char_id)
    link(char_id, 0)
    g0 = np.array(data.get("rootMatrix") or np.eye(4).ravel(order="F"), dtype=np.float64).reshape(4, 4, order="F")

    # Bones.
    bone_ids = []
    for i, b in enumerate(bones):
        r = b["rest"]
        bid = model(b["name"], "LimbNode", r["t"], _euler_fbx(r["q"]), r["s"])
        bone_ids.append(bid)
        attr = nid()
        a = objects.add("NodeAttribute", _T("L", attr), "\x00\x01NodeAttribute", "LimbNode")
        _p70(a, [("Size", "double", "Number", "", 33.333)])
        a.add("TypeFlags", "Skeleton")
        count("NodeAttribute")
        link(attr, bid)
        link(bid, bone_ids[b["parent"]] if b["parent"] >= 0 else char_id)

    # Meshes, their skins.
    pose_nodes = [(char_id, g0)]
    for i, b in enumerate(bones):
        pose_nodes.append((bone_ids[i], g0 @ np.array(b["bind"], dtype=np.float64).reshape(4, 4, order="F")))
    for mesh in meshes:
        pos = mesh["positions"].reshape(-1, 3).astype(np.float64)
        idx = mesh["indices"].reshape(-1, 3).astype(np.int64)
        poly = idx.copy()
        poly[:, 2] = -poly[:, 2] - 1
        gid = nid()
        g = objects.add("Geometry", _T("L", gid), f"{mesh['name']}\x00\x01Geometry", "Mesh")
        g.add("Vertices", _T("d", pos))
        g.add("PolygonVertexIndex", _T("i", poly))
        g.add("GeometryVersion", 124)
        layer_elems = []
        if mesh.get("normals") is not None:
            nrm = mesh["normals"].reshape(-1, 3)[idx.ravel()].astype(np.float64)
            le = g.add("LayerElementNormal", 0)
            le.add("Version", 101)
            le.add("Name", "")
            le.add("MappingInformationType", "ByPolygonVertex")
            le.add("ReferenceInformationType", "Direct")
            le.add("Normals", _T("d", nrm))
            layer_elems.append("LayerElementNormal")
        if mesh.get("uvs") is not None:
            uv = mesh["uvs"].reshape(-1, 2).astype(np.float64).copy()
            le = g.add("LayerElementUV", 0)
            le.add("Version", 101)
            le.add("Name", "UVMap")
            le.add("MappingInformationType", "ByPolygonVertex")
            le.add("ReferenceInformationType", "IndexToDirect")
            le.add("UV", _T("d", uv))
            le.add("UVIndex", _T("i", idx.ravel()))
            layer_elems.append("LayerElementUV")
        le = g.add("LayerElementMaterial", 0)
        le.add("Version", 101)
        le.add("Name", "")
        le.add("MappingInformationType", "AllSame")
        le.add("ReferenceInformationType", "IndexToDirect")
        le.add("Materials", _T("i", [0]))
        layer_elems.append("LayerElementMaterial")
        layer = g.add("Layer", 0)
        layer.add("Version", 100)
        for kind in layer_elems:
            e = layer.add("LayerElement")
            e.add("Type", kind)
            e.add("TypedIndex", 0)
        count("Geometry")
        mid = model(mesh["name"], "Mesh", [0, 0, 0], [0, 0, 0], [1, 1, 1])
        link(gid, mid)
        link(mid, char_id)
        mat = nid()
        m = objects.add("Material", _T("L", mat), f"{mesh['name']}_mat\x00\x01Material", "")
        m.add("Version", 102)
        m.add("ShadingModel", "lambert")
        m.add("MultiLayer", 0)
        _p70(m, [("DiffuseColor", "Color", "", "A", 0.7, 0.7, 0.7)])
        count("Material")
        link(mat, mid)
        pose_nodes.append((mid, g0))
        joints = mesh.get("joints")
        weights = mesh.get("weights")
        if joints is None or weights is None or not len(bones):
            continue
        joints = joints.reshape(-1, 4).astype(np.int64)
        weights = weights.reshape(-1, 4).astype(np.float64)
        skin = nid()
        s = objects.add("Deformer", _T("L", skin), f"{mesh['name']}_skin\x00\x01Deformer", "Skin")
        s.add("Version", 101)
        s.add("Link_DeformAcuracy", 50.0)
        count("Deformer")
        link(skin, gid)
        for bi, b in enumerate(bones):
            sel = (joints == bi) & (weights > 0)
            vtx = np.nonzero(sel.any(axis=1))[0]
            if not len(vtx):
                continue
            w = (weights * sel).sum(axis=1)[vtx]
            cid = nid()
            c = objects.add("Deformer", _T("L", cid), f"{b['name']}\x00\x01SubDeformer", "Cluster")
            c.add("Version", 100)
            c.add("UserData", "", "")
            c.add("Indexes", _T("i", vtx))
            c.add("Weights", _T("d", w))
            c.add("Transform", _T("d", g0.ravel(order="F")))
            link_m = g0 @ np.array(b["bind"], dtype=np.float64).reshape(4, 4, order="F")
            c.add("TransformLink", _T("d", link_m.ravel(order="F")))
            count("Deformer")
            link(cid, skin)
            link(bone_ids[bi], cid)

    pose_id = nid()
    pose = objects.add("Pose", _T("L", pose_id), "BindPose\x00\x01Pose", "BindPose")
    pose.add("Type", "BindPose")
    pose.add("Version", 100)
    pose.add("NbPoseNodes", len(pose_nodes))
    for node_id, mtx in pose_nodes:
        pn = pose.add("PoseNode")
        pn.add("Node", _T("L", node_id))
        pn.add("Matrix", _T("d", np.asarray(mtx, dtype=np.float64).ravel(order="F")))
    count("Pose")

    # Animation: every bone, every frame.
    anim = data.get("anim")
    if anim is not None and len(frames) > 0:
        stack = nid()
        st = objects.add("AnimationStack", _T("L", stack), "Take 001\x00\x01AnimStack", "")
        _p70(st, [
            ("LocalStart", "KTime", "Time", "", _T("L", int(round(t0 * KTIME_SECOND)))),
            ("LocalStop", "KTime", "Time", "", _T("L", int(round(t1 * KTIME_SECOND)))),
            ("ReferenceStart", "KTime", "Time", "", _T("L", int(round(t0 * KTIME_SECOND)))),
            ("ReferenceStop", "KTime", "Time", "", _T("L", int(round(t1 * KTIME_SECOND)))),
        ])
        layer = nid()
        objects.add("AnimationLayer", _T("L", layer), "BaseLayer\x00\x01AnimLayer", "")
        link(layer, stack)
        count("AnimationStack")
        count("AnimationLayer")
        times = np.array([int(round(f / fps * KTIME_SECOND)) for f in frames], dtype=np.int64)
        arr = anim.reshape(len(frames), len(bones), 10)

        def curves(owner, prop, values):
            cn = nid()
            node = objects.add("AnimationCurveNode", _T("L", cn), f"{prop.split()[-1][0]}\x00\x01AnimCurveNode", "")
            v0 = values[0]
            _p70(node, [("d|X", "Number", "", "A", float(v0[0])), ("d|Y", "Number", "", "A", float(v0[1])),
                        ("d|Z", "Number", "", "A", float(v0[2]))])
            count("AnimationCurveNode")
            link(cn, layer)
            link(cn, owner, prop)
            for axis, ch in enumerate(("d|X", "d|Y", "d|Z")):
                cid = nid()
                c = objects.add("AnimationCurve", _T("L", cid), "\x00\x01AnimCurve", "")
                c.add("Default", float(v0[axis]))
                c.add("KeyVer", 4009)
                c.add("KeyTime", _T("l", times))
                c.add("KeyValueFloat", _T("f", values[:, axis]))
                c.add("KeyAttrFlags", _T("i", [8452]))
                c.add("KeyAttrDataFloat", _T("f", [0.0, 0.0, 0.0, 0.0]))
                c.add("KeyAttrRefCount", _T("i", [len(times)]))
                count("AnimationCurve")
                link(cid, cn, ch)

        for bi in range(len(bones)):
            t = arr[:, bi, 0:3]
            q = arr[:, bi, 3:7]
            s = arr[:, bi, 7:10]
            curves(bone_ids[bi], "Lcl Translation", t)
            curves(bone_ids[bi], "Lcl Rotation", np.array(_unwrap([_euler_fbx(x) for x in q])))
            if np.abs(s - 1).max() > 1e-6:
                curves(bone_ids[bi], "Lcl Scaling", s)
        rootf = data.get("rootAnim")
        if rootf is not None and len(frames) > 1 and np.ptp(rootf.reshape(len(frames), 10), axis=0).max() > 1e-7:
            ra = rootf.reshape(len(frames), 10)
            curves(char_id, "Lcl Translation", ra[:, 0:3])
            curves(char_id, "Lcl Rotation", np.array(_unwrap([_euler_fbx(x) for x in ra[:, 3:7]])))
            curves(char_id, "Lcl Scaling", ra[:, 7:10])

    defs = _N("Definitions")
    defs.add("Version", 100)
    defs.add("Count", sum(counts.values()) + 1)
    defs.add("ObjectType", "GlobalSettings").add("Count", 1)
    for kind, n in counts.items():
        defs.add("ObjectType", kind).add("Count", n)
    top += [defs, objects, conns]
    takes = _N("Takes")
    takes.add("Current", "Take 001")
    if anim is not None:
        tk = takes.add("Take", "Take 001")
        tk.add("FileName", "Take_001.tak")
        tk.add("LocalTime", _T("L", int(round(t0 * KTIME_SECOND))), _T("L", int(round(t1 * KTIME_SECOND))))
        tk.add("ReferenceTime", _T("L", int(round(t0 * KTIME_SECOND))), _T("L", int(round(t1 * KTIME_SECOND))))
    top.append(takes)
    with open(path, "wb") as fh:
        fh.write(_fbx_bytes(top))
    return path


# ── Alembic (Ogawa) ──────────────────────────────────────────────────────────

_POD = {"bool": 0, "uint8": 1, "int32": 6, "float32": 10, "float64": 11}
_POD_FMT = {0: "<?", 1: "<B", 6: "<i4", 10: "<f4", 11: "<f8"}
_EMPTY_DATA = 1 << 63


class _Ogawa:
    """Writes groups and data blocks; answers references to them."""

    def __init__(self):
        self.buf = bytearray(b"Ogawa" + b"\xff" + struct.pack("<H", 1) + b"\0" * 8)

    def data(self, raw):
        if not raw:
            return _EMPTY_DATA
        off = len(self.buf)
        self.buf += struct.pack("<Q", len(raw)) + raw
        return off | _EMPTY_DATA

    def group(self, refs):
        if not refs:
            off = len(self.buf)
            self.buf += struct.pack("<Q", 0)
            return off
        off = len(self.buf)
        self.buf += struct.pack("<Q", len(refs)) + struct.pack("<%dQ" % len(refs), *refs)
        return off

    def finish(self, root):
        struct.pack_into("<Q", self.buf, 8, root)
        return bytes(self.buf)


def _key(raw):
    return hashlib.md5(raw).digest()


class _Prop:
    """A property to write: scalar or array, its samples (each raw bytes), its metadata."""

    def __init__(self, name, kind, pod, extent, samples, metadata="", ts=0):
        self.name, self.kind, self.pod, self.extent = name, kind, pod, extent
        self.samples, self.metadata, self.ts = samples, metadata, ts
        self.children = []

    @classmethod
    def compound(cls, name, children, metadata=""):
        p = cls(name, 0, 0, 0, [], metadata)
        p.children = children
        return p


def _header_bytes(p):
    meta = p.metadata.encode()
    n = len(p.samples)
    vals = [max(n, 1) if p.kind else 0, len(p.name.encode()), len(meta), p.ts]
    big = max(vals)
    hint, fmt = (0, "<B") if big < 256 else (1, "<H") if big < 65536 else (2, "<I")
    info = p.kind | (hint << 2)
    if p.kind:
        info |= (p.pod & 0xF) << 4
        info |= (p.extent & 0xFF) << 12
        if p.ts:
            info |= 0x0100
        if p.kind == 2:
            info |= 0x0400            # homogenous
    info |= 0xFF << 20                # its metadata written inline
    out = struct.pack("<I", info)
    if p.kind:
        out += struct.pack(fmt, max(n, 1))
        if p.ts:
            out += struct.pack(fmt, p.ts)
    out += struct.pack(fmt, len(p.name.encode())) + p.name.encode()
    out += struct.pack(fmt, len(meta)) + meta
    return out


def _write_prop(w, p):
    if p.kind == 0:
        refs = [_write_prop(w, c) for c in p.children]
        refs.append(w.data(b"".join(_header_bytes(c) for c in p.children)))
        return w.group(refs)
    refs = []
    for raw in p.samples:
        refs.append(w.data(_key(raw) + raw))
        if p.kind == 2:
            refs.append(_EMPTY_DATA)    # one-dimensional: the size says how many
    return w.group(refs)


def _object_headers(children):
    out = b""
    for name, meta in children:
        nb, mb = name.encode(), meta.encode()
        out += struct.pack("<I", len(nb)) + nb + b"\xff" + struct.pack("<I", len(mb)) + mb
    return out + b"\0" * 32         # the data and child hashes


def _write_object(w, props, children):
    """props: a list of _Prop (the object's top compound); children: [(name, meta, props, children)]."""
    top = _Prop.compound("", props)
    refs = [_write_prop(w, top)]
    for name, meta, cprops, ckids in children:
        refs.append(_write_object(w, cprops, ckids))
    refs.append(w.data(_object_headers([(c[0], c[1]) for c in children])))
    return w.group(refs)


def write_abc(path, data):
    """Write each mesh as an Xform + PolyMesh whose points are sampled every frame."""
    fps = float(data.get("fps") or 24)
    frames = list(data.get("frames") or [0])
    w = _Ogawa()
    xform_meta = "schema=AbcGeom_Xform_v3;schemaObjTitle=AbcGeom_Xform_v3:.xform"
    mesh_meta = "schema=AbcGeom_PolyMesh_v1;schemaObjTitle=AbcGeom_PolyMesh_v1:.geom"
    kids = []
    animated = len(frames) > 1
    for mesh in data["meshes"]:
        idx = mesh["indices"].reshape(-1, 3).astype(np.int32)
        faces = idx[:, ::-1].copy()             # Alembic winds the other way round
        counts = np.full(len(faces), 3, dtype=np.int32)
        pts = mesh.get("points")
        pts = (pts.reshape(len(frames), -1, 3) if pts is not None else skinned_points(data, mesh)).astype(np.float32)
        p_samples = [pts[i].tobytes() for i in range(len(frames))]
        bounds = []
        for i in range(len(frames)):
            lo = pts[i].min(axis=0).astype(np.float64)
            hi = pts[i].max(axis=0).astype(np.float64)
            bounds.append(np.concatenate([lo, hi]).tobytes())
        ts = 1 if animated else 0
        geom = [
            _Prop("P", 2, _POD["float32"], 3, p_samples,
                  "geoScope=vtx;interpretation=point;podExtent=3;podName=float32_t", ts),
            _Prop(".faceIndices", 2, _POD["int32"], 1, [faces.ravel().tobytes()]),
            _Prop(".faceCounts", 2, _POD["int32"], 1, [counts.tobytes()]),
            _Prop(".selfBnds", 1, _POD["float64"], 6, bounds, "interpretation=box", ts),
        ]
        if mesh.get("uvs") is not None:
            uv = mesh["uvs"].reshape(-1, 2).astype(np.float32)[faces.ravel()]
            geom.append(_Prop("uv", 2, _POD["float32"], 2, [uv.tobytes()],
                              "arrayExtent=1;geoScope=fvr;interpretation=vector;isGeomParam=true;"
                              "podExtent=2;podName=float32_t"))
        shape = [_Prop.compound(".geom", geom, mesh_meta)]
        identity = struct.pack("<16d", *np.eye(4).ravel())
        xf = [_Prop.compound(".xform", [
            _Prop(".inherits", 1, _POD["bool"], 1, [struct.pack("<?", True)]),
            _Prop(".ops", 1, _POD["uint8"], 1, [struct.pack("<B", 3 << 4)]),
            _Prop(".vals", 1, _POD["float64"], 16, [identity]),
        ], xform_meta)]
        name = _abc_name(mesh["name"])
        kids.append((name, xform_meta, xf, [(name + "Shape", mesh_meta, shape, [])]))
    top = _write_object(w, [], kids)
    version = w.data(struct.pack("<i", 0))
    lib = w.data(struct.pack("<i", 10709))
    meta = ";".join([
        "_ai_AlembicVersion=Alembic 1.7.9 (written by ComfyUI Image Viewer)",
        "_ai_Application=ComfyUI Image Viewer",
        f"_ai_DateWritten={time.strftime('%a %b %d %H:%M:%S %Y')}",
        "_ai_Description=Baked from the 3D space",
    ]).encode()
    meta_ref = w.data(meta)
    # Time samplings: the identity one, then ours (uniform, one sample per frame).
    tsb = struct.pack("<I", 0) + struct.pack("<d", 1.0) + struct.pack("<I", 1) + struct.pack("<d", 0.0)
    tsb += struct.pack("<I", len(frames)) + struct.pack("<d", 1.0 / fps) + struct.pack("<I", 1) \
        + struct.pack("<d", frames[0] / fps)
    ts_ref = w.data(tsb)
    indexed = w.data(b"")
    root = w.group([version, lib, top, meta_ref, ts_ref, indexed])
    with open(path, "wb") as fh:
        fh.write(w.finish(root))
    return path


def _abc_name(name):
    out = "".join(c if c.isalnum() or c in "_" else "_" for c in str(name or "mesh"))
    return out or "mesh"


# ── posing the meshes (for Alembic) ─────────────────────────────────────────


def _trs_matrix(t, q, s):
    x, y, z, w = q
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = r * np.asarray(s, dtype=np.float64)[None, :]
    m[:3, 3] = t
    return m


def bone_worlds(data):
    """[frames, bones, 4, 4]: every bone in model space on every frame, from the local keys
    (a bone without a parent bone is keyed in model space itself). Without keys, the rest pose."""
    frames = list(data.get("frames") or [0])
    bones = data["bones"]
    nb = len(bones)
    anim = data.get("anim")
    out = np.zeros((len(frames), nb, 4, 4))
    for fi in range(len(frames)):
        for bi, b in enumerate(bones):
            if anim is not None:
                a = anim.reshape(len(frames), nb, 10)[fi, bi]
                local = _trs_matrix(a[0:3], a[3:7], a[7:10])
            else:
                r = b["rest"]
                local = _trs_matrix(r["t"], r["q"], r["s"])
            out[fi, bi] = out[fi, b["parent"]] @ local if b["parent"] >= 0 else local
    return out


def root_worlds(data):
    """[frames, 4, 4]: model space into the scene, per frame."""
    frames = list(data.get("frames") or [0])
    ra = data.get("rootAnim")
    if ra is not None:
        ra = ra.reshape(len(frames), 10)
        return np.stack([_trs_matrix(r[0:3], r[3:7], r[7:10]) for r in ra])
    g0 = np.array(data.get("rootMatrix") or np.eye(4).ravel(order="F"), dtype=np.float64).reshape(4, 4, order="F")
    return np.repeat(g0[None], len(frames), axis=0)


def skinned_points(data, mesh):
    """[frames, verts, 3]: the mesh as its skeleton deforms it, in scene space (linear blend skinning)."""
    pos = mesh["positions"].reshape(-1, 3).astype(np.float64)
    roots = root_worlds(data)
    frames = len(roots)
    homo = np.concatenate([pos, np.ones((len(pos), 1))], axis=1)
    joints, weights = mesh.get("joints"), mesh.get("weights")
    if joints is None or weights is None or not data["bones"]:
        return np.stack([(homo @ roots[f].T)[:, :3] for f in range(frames)])
    joints = joints.reshape(-1, 4).astype(np.int64)
    weights = weights.reshape(-1, 4).astype(np.float64)
    tot = weights.sum(axis=1, keepdims=True)
    weights = np.where(tot > 0, weights / np.where(tot > 0, tot, 1), 0)
    worlds = bone_worlds(data)
    binds = np.stack([np.array(b["bind"], dtype=np.float64).reshape(4, 4, order="F") for b in data["bones"]])
    inv_binds = np.linalg.inv(binds)
    out = np.zeros((frames, len(pos), 3))
    for f in range(frames):
        skin = worlds[f] @ inv_binds                                  # [B, 4, 4]
        acc = np.zeros((len(pos), 4))
        for k in range(4):
            m = skin[joints[:, k]]                                    # [V, 4, 4]
            acc += weights[:, k:k + 1] * np.einsum("vij,vj->vi", m, homo)
        unweighted = tot[:, 0] <= 0
        acc[unweighted] = homo[unweighted]
        out[f] = (acc @ roots[f].T)[:, :3]
    return out


# ── what the browser sends ───────────────────────────────────────────────────


def parse_payload(meta, blobs):
    """`meta` (JSON from the page) + named binary parts -> the dict the writers read.

    meta: { name, fps, frames: [..], root: {t,q,s}, rootMatrix: [16],
            bones: [{ name, parent, rest: {t,q,s}, bind: [16] }],
            meshes: [{ name, positions, normals?, uvs?, indices, joints?, weights?, points? }],
            anim?, rootAnim? }
    — the array fields name a part in `blobs` ("f32:<part>" or "u32:<part>").
    """
    def arr(ref):
        if ref is None:
            return None
        kind, _, part = str(ref).partition(":")
        raw = blobs.get(part)
        if raw is None:
            raise ValueError(f"missing data part {part}")
        return np.frombuffer(raw, dtype={"f32": "<f4", "u32": "<u4", "u16": "<u2"}[kind]).copy()

    out = dict(meta)
    out["meshes"] = []
    for m in meta.get("meshes") or []:
        mm = dict(m)
        for k in ("positions", "normals", "uvs", "indices", "joints", "weights", "points"):
            mm[k] = arr(m.get(k))
        out["meshes"].append(mm)
    out["anim"] = arr(meta.get("anim"))
    out["rootAnim"] = arr(meta.get("rootAnim"))
    out["bones"] = list(meta.get("bones") or [])
    return out
