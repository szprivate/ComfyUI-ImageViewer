"""Alembic (.abc) caches, read without an Alembic library.

Alembic has no Python bindings on PyPI and `usd-core` ships without its
Alembic plugin, so this reads the file itself. An .abc is an **Ogawa**
container — a tree of groups and data blocks — with Alembic's object and
property layer written into it, and both are simple enough to read directly:

    Ogawa      "Ogawa" magic, then groups (a count and that many 64-bit
               child references) and data blocks (a size and that many bytes).
               A reference's top bit says which of the two it points at.
    objects    Each object is a group: [0] its properties, then one group per
               child object, and a final data block naming those children.
    properties Each compound property is a group laid out the same way, ending
               in a data block of packed property headers (type, POD, extent,
               sample count, name). A scalar or array property's samples are
               data blocks of a 16-byte key followed by the values.

What comes back is geometry: polygon meshes (`P`, `.faceIndices`,
`.faceCounts`) and the transforms above them (`.xform`'s `.vals`, a 4x4
matrix per sample), which is what a previz shot needs from a cache. Other
schemas — curves, points, subdivision creases, cameras, materials, UVs and
normals — are left alone, as are HDF5-backed .abc files (Alembic's older
container, which Ogawa replaced in 2013).

Like USD, geometry reaches the viewport as a cached GLB: the viewport speaks
glTF, and a cache is flattened once per frame it is asked for.
"""

import hashlib
import math
import os
import struct

_MAGIC = b"Ogawa"
# Alembic's plain-old-data types, by the code stored in a property header.
_POD_FORMAT = {0: "?", 1: "B", 2: "b", 3: "H", 4: "h", 5: "I", 6: "i",
               7: "Q", 8: "q", 9: "e", 10: "f", 11: "d"}
_POD_SIZE = {0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 8, 8: 8, 9: 2, 10: 4, 11: 8}
_KEY_BYTES = 16          # every sample is prefixed with its own hash

_MESH_SCHEMAS = ("AbcGeom_PolyMesh", "AbcGeom_SubD")


def is_abc(path):
    return bool(path) and os.path.splitext(str(path))[1].lower() == ".abc"


def available():
    """True when this install can read Alembic — it always can."""
    return True


def readable(path):
    """Whether `path` is an Ogawa Alembic this module can open."""
    try:
        with open(path, "rb") as fh:
            return fh.read(5) == _MAGIC
    except OSError:
        return False


# ── the Ogawa container ──────────────────────────────────────────────────────

class _Archive:
    """The raw tree: groups, data blocks, and the two indexes at the root."""

    def __init__(self, path):
        with open(path, "rb") as fh:
            self.buf = fh.read()
        if self.buf[:5] != _MAGIC:
            raise ValueError(f"{os.path.basename(path)} is not an Ogawa Alembic file "
                             f"(an HDF5 one needs the Alembic libraries)")
        self.path = path
        root = self.group(struct.unpack_from("<Q", self.buf, 8)[0])
        if len(root) < 6:
            raise ValueError("this Alembic archive has no object tree")
        self.top = root[2]
        self.archive_metadata = self._read_metadata(root[3])
        self.time_samplings = self._read_time_samplings(root[4])
        self.indexed_metadata = self.data(root[5]).decode("utf-8", "replace").split(";")

    # -- primitives --
    def group(self, off):
        if not off:
            return ()
        n = struct.unpack_from("<Q", self.buf, off)[0]
        return struct.unpack_from("<%dQ" % n, self.buf, off + 8) if n else ()

    @staticmethod
    def is_data(ref):
        return bool(ref >> 63)

    @staticmethod
    def offset(ref):
        return ref & ((1 << 63) - 1)

    def children(self, ref):
        return () if self.is_data(ref) else self.group(self.offset(ref))

    def data(self, ref):
        off = self.offset(ref)
        if not self.is_data(ref) or not off:
            return b""
        size = struct.unpack_from("<Q", self.buf, off)[0]
        return self.buf[off + 8:off + 8 + size]

    # -- the root's own blocks --
    def _read_metadata(self, ref):
        out = {}
        for pair in self.data(ref).decode("utf-8", "replace").split(";"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                out[k] = v
        return out

    def _read_time_samplings(self, ref):
        """(start, step) per sampling, in seconds. Index 0 is the default one."""
        raw = self.data(ref)
        out, i = [], 0
        while i + 4 <= len(raw):
            try:
                _max_sample = struct.unpack_from("<I", raw, i)[0]; i += 4
                per_cycle = struct.unpack_from("<d", raw, i)[0]; i += 8
                count = struct.unpack_from("<I", raw, i)[0]; i += 4
                times = struct.unpack_from("<%dd" % count, raw, i); i += 8 * count
            except struct.error:
                break
            start = times[0] if times else 0.0
            step = (per_cycle / count) if count else per_cycle
            out.append((start, step or 0.0))
        return out


def _read_property_headers(buf, indexed_metadata):
    """The packed header block that ends every compound property's group."""
    out, i = [], 0
    while i < len(buf):
        try:
            info = struct.unpack_from("<I", buf, i)[0]
        except struct.error:
            break
        i += 4
        ptype = info & 0x3                      # 0 compound, 1 scalar, 2 array
        size_hint = (info >> 2) & 0x3
        rec = {"type": ptype, "pod": (info >> 4) & 0xF, "extent": (info >> 12) & 0xFF,
               "samples": 1, "ts": 0}
        meta_index = (info >> 20) & 0xFF
        if ptype != 0:
            width = {0: 1, 1: 2, 2: 4}[size_hint]
            fmt = {0: "<B", 1: "<H", 2: "<I"}[size_hint]
            rec["samples"] = struct.unpack_from(fmt, buf, i)[0]; i += width
            if info & 0x0100:                   # carries a time-sampling index
                rec["ts"] = buf[i]; i += 1
        if i >= len(buf):
            break
        n = buf[i]; i += 1
        rec["name"] = buf[i:i + n].decode("utf-8", "replace"); i += n
        if meta_index == 0xFF:                  # its own metadata, not an indexed one
            n2 = buf[i]; i += 1
            rec["metadata"] = buf[i:i + n2].decode("utf-8", "replace"); i += n2
        else:
            rec["metadata"] = (indexed_metadata[meta_index]
                               if meta_index < len(indexed_metadata) else "")
        out.append(rec)
    return out


def _read_object_headers(buf):
    """The block naming an object's children: a length, a name, a metadata index."""
    out, i = [], 0
    while i + 4 <= len(buf):
        n = struct.unpack_from("<I", buf, i)[0]; i += 4
        if n == 0 or i + n > len(buf):
            break
        out.append(buf[i:i + n].decode("utf-8", "replace")); i += n
        if i < len(buf):
            i += 1                              # metadata index
    return out


class _Property:
    """One property, with its samples still in the file."""

    def __init__(self, archive, ref, header):
        self.a = archive
        self.ref = ref
        self.h = header

    @property
    def samples(self):
        return max(1, int(self.h.get("samples") or 1))

    def _sample_refs(self):
        return self.a.children(self.ref) if not self.a.is_data(self.ref) else (self.ref,)

    def values(self, sample=0):
        """One sample, as a flat tuple of numbers."""
        refs = self._sample_refs()
        if not refs:
            return ()
        # An array property stores (data, dimensions) per sample; a scalar one
        # stores just the data. A sample that never changes is stored once.
        stride = 2 if self.h["type"] == 2 else 1
        count = max(1, len(refs) // stride)
        index = min(max(0, int(sample)), count - 1)
        raw = self.a.data(refs[index * stride])
        if len(raw) <= _KEY_BYTES:
            return ()
        fmt = _POD_FORMAT.get(self.h["pod"])
        size = _POD_SIZE.get(self.h["pod"])
        if not fmt or not size:
            return ()
        n = (len(raw) - _KEY_BYTES) // size
        return struct.unpack_from("<%d%s" % (n, fmt), raw, _KEY_BYTES)


class _Compound:
    """A compound property: named children, each a property of its own."""

    def __init__(self, archive, ref):
        self.a = archive
        self.ref = ref
        self.children = {}
        kids = archive.children(ref)
        if not kids:
            return
        headers = _read_property_headers(archive.data(kids[-1]), archive.indexed_metadata)
        for i, h in enumerate(headers):
            if i >= len(kids) - 1:
                break
            self.children[h["name"]] = (kids[i], h)

    def compound(self, name):
        found = self.children.get(name)
        if not found or found[1]["type"] != 0:
            return None
        return _Compound(self.a, found[0])

    def prop(self, name):
        found = self.children.get(name)
        if not found or found[1]["type"] == 0:
            return None
        return _Property(self.a, found[0], found[1])


class Object:
    """One object of the cache: its schema, its transform, its mesh."""

    def __init__(self, archive, ref, name, parent=None):
        self.a = archive
        self.ref = ref
        self.name = name
        self.parent = parent
        self.path = f"{parent.path}/{name}" if parent else f"/{name}" if name else "/"
        kids = archive.children(ref)
        self.props = _Compound(archive, kids[0]) if kids and not archive.is_data(kids[0]) else None
        self.children = []
        if kids and archive.is_data(kids[-1]):
            for i, child_name in enumerate(_read_object_headers(archive.data(kids[-1]))):
                if 1 + i < len(kids) - 1 + 1 and not archive.is_data(kids[1 + i]):
                    self.children.append(Object(archive, kids[1 + i], child_name, self))

    # -- what kind of thing it is --
    @property
    def schema(self):
        if not self.props:
            return ""
        for name in (".geom", ".xform"):
            found = self.props.children.get(name)
            if found:
                meta = found[1].get("metadata") or ""
                for part in meta.split(";"):
                    if part.startswith("schema="):
                        return part.split("=", 1)[1]
                return name.lstrip(".")
        return ""

    @property
    def is_mesh(self):
        geom = self.props.children.get(".geom") if self.props else None
        if not geom:
            return False
        inner = self.props.compound(".geom")
        return bool(inner and "P" in inner.children and ".faceCounts" in inner.children)

    @property
    def is_xform(self):
        return bool(self.props and ".xform" in self.props.children)

    # -- transform --
    def matrix(self, sample=0):
        """This object's own 4x4 matrix at `sample`, row-major as Alembic stores it."""
        if not self.props:
            return None
        xform = self.props.compound(".xform")
        vals = xform.prop(".vals") if xform else None
        if vals is None:
            return None
        v = vals.values(sample)
        return list(v) if len(v) == 16 else None

    def world_matrix(self, sample=0):
        m = _identity()
        chain = []
        node = self
        while node is not None:
            chain.append(node)
            node = node.parent
        for node in reversed(chain):
            local = node.matrix(sample)
            if local:
                m = _mat_mul(local, m)      # row-vector convention, child first
        return m

    def sample_count(self):
        """How many samples this object's geometry (or transform) carries."""
        best = 1
        if self.props:
            geom = self.props.compound(".geom")
            if geom:
                p = geom.prop("P")
                if p:
                    best = max(best, p.samples)
            xform = self.props.compound(".xform")
            if xform:
                vals = xform.prop(".vals")
                if vals:
                    best = max(best, vals.samples)
        return best

    # -- geometry --
    def mesh(self, sample=0):
        """(points, faces) in this object's own space; faces are triangles."""
        geom = self.props.compound(".geom") if self.props else None
        if not geom:
            return None
        p = geom.prop("P")
        counts = geom.prop(".faceCounts")
        indices = geom.prop(".faceIndices")
        if not p or not counts or not indices:
            return None
        flat = p.values(sample)
        points = [tuple(flat[i:i + 3]) for i in range(0, len(flat) - 2, 3)]
        return points, _triangulate(counts.values(sample), indices.values(sample), len(points))


# ── small matrix helpers (row-vector, as Alembic and USD write them) ─────────

def _identity():
    return [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def _mat_mul(a, b):
    out = [0.0] * 16
    for r in range(4):
        for c in range(4):
            out[r * 4 + c] = sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
    return out


def _transform_point(m, p):
    x, y, z = p
    return (x * m[0] + y * m[4] + z * m[8] + m[12],
            x * m[1] + y * m[5] + z * m[9] + m[13],
            x * m[2] + y * m[6] + z * m[10] + m[14])


def _triangulate(counts, indices, point_count):
    """Polygons to triangles, as a fan — and Alembic winds its faces the other
    way round from glTF, so each one is reversed on the way out."""
    faces, at = [], 0
    for n in counts:
        n = int(n)
        if n >= 3 and at + n <= len(indices):
            ring = [int(indices[at + k]) for k in range(n)][::-1]
            if all(0 <= v < point_count for v in ring):
                for k in range(1, n - 1):
                    faces.append((ring[0], ring[k], ring[k + 1]))
        at += n
    return faces


# ── reading a whole cache ────────────────────────────────────────────────────

def _objects(archive):
    root = Object(archive, archive.top, "")
    out = []

    def walk(obj):
        for child in obj.children:
            out.append(child)
            walk(child)

    walk(root)
    return out


def open_archive(path):
    return _Archive(os.path.abspath(path))


def info(path):
    """What the cache holds: its meshes, how many samples, at what rate."""
    a = open_archive(path)
    objects = _objects(a)
    meshes = [o for o in objects if o.is_mesh]
    samples = max([o.sample_count() for o in objects] or [1])
    fps = 24.0
    try:
        fps = float(a.archive_metadata.get("FramesPerTimeUnit") or 24.0)
    except (TypeError, ValueError):
        pass
    return {"objects": len(objects), "meshes": [o.path for o in meshes],
            "samples": samples, "fps": fps or 24.0,
            "application": a.archive_metadata.get("_ai_Application", ""),
            "written": a.archive_metadata.get("_ai_DateWritten", "")}


def to_mesh(path, sample=0, obj_path=None):
    """Every visible mesh flattened into (vertices, faces), in world space.

    With `obj_path`, only that object, in its own space — the same split USD
    uses, so an item can carry its own transform.
    """
    a = open_archive(path)
    objects = _objects(a)
    if obj_path:
        objects = [o for o in objects if o.path == obj_path]
    vertices, faces = [], []
    for obj in objects:
        if not obj.is_mesh:
            continue
        got = obj.mesh(sample)
        if not got:
            continue
        points, tris = got
        if not obj_path:
            m = obj.world_matrix(sample)
            points = [_transform_point(m, p) for p in points]
        base = len(vertices)
        vertices.extend(points)
        faces.extend([(a0 + base, b0 + base, c0 + base) for a0, b0, c0 in tris])
    return vertices, faces


def _cache_path(src, sample, obj_path=None):
    import folder_paths
    tmp = folder_paths.get_temp_directory()
    os.makedirs(tmp, exist_ok=True)
    try:
        stamp = os.path.getmtime(src)
    except OSError:
        stamp = 0
    key = f"{os.path.abspath(src)}|{stamp}|{sample}|{obj_path or ''}"
    digest = hashlib.sha1(key.encode("utf-8", "replace")).hexdigest()[:16]
    stem = "".join(c for c in os.path.splitext(os.path.basename(src))[0]
                   if c.isalnum() or c in "-_")[:40] or "cache"
    return os.path.join(tmp, f"bEpic_abc_{stem}_{digest}.glb")


def display_proxy(path, sample=0, obj_path=None):
    """A GLB standing in for the cache at one sample, built once and reused."""
    if not is_abc(path) or not readable(path):
        return None
    dst = _cache_path(path, sample, obj_path)
    try:
        if os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(path):
            return dst
    except OSError:
        pass

    import numpy as np
    import torch
    vertices, faces = to_mesh(path, sample=sample, obj_path=obj_path)
    if not vertices or not faces:
        raise ValueError("this cache has no polygon mesh to show")

    from comfy_extras.nodes_save_3d import save_glb
    save_glb(torch.tensor(np.asarray(vertices, dtype=np.float32)),
             torch.tensor(np.asarray(faces, dtype=np.int64)), dst)
    return dst


def _decompose(m):
    """(translate, rotate XYZ in degrees, scale) from a row-vector 4x4."""
    t = [m[12], m[13], m[14]]
    rows = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]]
    scale = [math.sqrt(sum(c * c for c in r)) or 1.0 for r in rows]
    r = [[rows[i][j] / scale[i] for j in range(3)] for i in range(3)]
    # The viewer's rotations are three's XYZ Euler, read off the same basis USD
    # uses; the matrix here is the transpose of three's column-major one.
    sy = -r[2][0]
    if abs(sy) < 0.999999:
        x = math.atan2(r[2][1], r[2][2])
        y = math.asin(max(-1.0, min(1.0, sy)))
        z = math.atan2(r[1][0], r[0][0])
    else:
        x = math.atan2(-r[1][2], r[1][1])
        y = math.asin(max(-1.0, min(1.0, sy)))
        z = 0.0
    deg = 180.0 / math.pi
    return t, [x * deg, y * deg, z * deg], scale


def import_scene(path):
    """Read a cache into a previz scene dict — one item per mesh, groups above.

    Transforms that animate come in as keyframes, one per sample, the way an
    imported USD stage's samples do. The geometry itself is read at the sample
    the viewer asks for (display_proxy), not baked into the scene.
    """
    a = open_archive(path)
    objects = _objects(a)
    meta = info(path)
    fps = meta["fps"]
    samples = meta["samples"]

    scene = {"version": 1, "fps": fps, "length": max(1, samples), "lengthSet": True,
             "items": [], "activeCamera": None}
    ids = {}

    def item_id(obj):
        return f"abc_{abs(hash(obj.path)) & 0xffffffff:x}"

    for obj in objects:
        if not (obj.is_mesh or obj.is_xform):
            continue
        ids[obj.path] = item_id(obj)
        count = obj.sample_count()
        t, r, s = _decompose(obj.matrix(0) or _identity())
        item = {"id": ids[obj.path], "kind": "model" if obj.is_mesh else "group",
                "name": obj.name or "object",
                "position": t, "rotation": r, "scale": s,
                "pivot": [0, 0, 0], "visible": True, "tracks": {},
                "parent": ids.get(obj.parent.path) if obj.parent else None}
        if obj.is_mesh:
            item["src"] = {"path": os.path.abspath(path), "prim": obj.path,
                           "name": obj.name, "format": "abc"}
        # A transform with more than one sample animates: one key per sample.
        if count > 1 and obj.matrix(0) is not None:
            tracks = {"position": [], "rotation": [], "scale": []}
            for i in range(count):
                ti, ri, si = _decompose(obj.matrix(i) or _identity())
                tracks["position"].append({"f": i, "v": ti, "ease": "linear"})
                tracks["rotation"].append({"f": i, "v": ri, "ease": "linear"})
                tracks["scale"].append({"f": i, "v": si, "ease": "linear"})
            if any(k["v"] != tracks["position"][0]["v"] for k in tracks["position"]) or \
               any(k["v"] != tracks["rotation"][0]["v"] for k in tracks["rotation"]) or \
               any(k["v"] != tracks["scale"][0]["v"] for k in tracks["scale"]):
                item["tracks"] = tracks
        scene["items"].append(item)
    return scene
