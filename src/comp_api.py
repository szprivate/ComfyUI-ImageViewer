"""A Python API for comps: build, edit and render ``*.comp.json`` files without the viewer's page.

    from imageviewer.comp_api import Comp          # or: scripts/comp_render.py --help on the command line

    c = Comp.new(1920, 1080, fps=24, frames=100)
    plate = c.add("read", file="plates/sh010.####.exr")
    grade = c.add("grade", inputs=[plate], gain=1.2)
    c.key(grade, "gain", 0, 1.0); c.key(grade, "gain", 99, 1.4)
    c.add("write", inputs=[grade], name="main", file="render/{comp}.####.exr", channels="all", handles=8)
    c.connect(c.output, grade)
    c.save("sh010_comp_v001.comp.json")
    c.render()                                      # every Write node, all its frames

The same operations, as a list of plain dicts, are what the agent sends (POST /imageviewer/comp_ops,
:meth:`Comp.apply`): ``{"op": "add" | "connect" | "disconnect" | "set" | "key" | "unkey" | "remove" | "output" |
"format" | "rename", ...}``.

Node types and their parameters are ``comp_model.NODE_TYPES`` (the page's table, checked against it by the
parity test). Ids are made as the page makes them: the type's label and a number (``Read1``, ``Grade2``).
"""
from __future__ import annotations

import copy
import os

from . import comp_io
from . import comp_model as M
from . import comp_write as CW

LABELS = {"read": "Read", "constant": "Constant", "roto": "Roto", "paint": "Paint", "merge": "Merge", "copy": "Copy", "transform": "Transform",
          "reformat": "Reformat", "crop": "Crop", "cornerpin": "CornerPin", "stmap": "STMap", "vectorwarp": "VectorWarp",
          "lensdistortion": "LensDistortion", "gridwarp": "GridWarp", "tracker": "Tracker", "planartracker": "PlanarTracker", "grade": "Grade", "colorcorrect": "ColorCorrect", "ocio_colorspace": "OCIOColorSpace",
          "ocio_display": "OCIODisplay", "keyer": "Keyer", "lumakeyer": "LumaKeyer", "chromakeyer": "ChromaKeyer", "blur": "Blur",
          "glow": "Glow", "erode": "Erode/Dilate", "laplacian": "Laplacian", "motionblur": "MotionBlur", "depthblur": "DepthBlur",
          "defocus": "Defocus", "lensflare": "LensFlare", "shuffle": "Shuffle", "addchannels": "AddChannels",
          "removechannels": "Remove", "channelmerge": "ChannelMerge", "channelmath": "ChannelMath", "premult": "Premult",
          "unpremult": "Unpremult", "retime": "Retime", "vectors": "Vectors", "metadata": "Metadata", "write": "Write",
          "camera3d": "Camera", "card3d": "Card", "geo3d": "Shape", "project3d": "Project", "scene3d": "Scene",
          "pointcloud": "PointCloud", "render3d": "Render3D", "deepread": "DeepRead", "deepfromimage": "DeepFromImage",
          "deepmerge": "DeepMerge", "deepholdout": "DeepHoldout", "deepcrop": "DeepCrop", "deepflatten": "DeepFlatten",
          "oneview": "OneView", "joinviews": "JoinViews", "anaglyph": "Anaglyph", "sidebyside": "SideBySide",
          "output": "Output", "dot": "Dot", "group": "Group", "group_input": "Input", "group_output": "GroupOutput",
          "backdrop": "Backdrop", "sticky": "StickyNote"}
LABELS.update(M._X.EXTRA_LABELS)   # the rest of the node set (comp_extra)
EASES = ["smooth", "linear", "hold", "easeIn", "easeOut", "easeInOut", "backOut", "expoOut"]
NODE_GAP = 60


class CompError(ValueError):
    pass


class Comp:
    """One comp document. ``data`` is the file's dict; every edit keeps it a valid comp."""

    def __init__(self, data=None, path=None):
        data = copy.deepcopy(data) if data is not None else M.new_comp()
        self.data, errors = M.normalize(comp_io.upgrade(data))
        self.errors = errors
        self.path = os.path.abspath(path) if path else None

    # ── files ────────────────────────────────────────────────────────────────

    @classmethod
    def open(cls, path):
        return cls(comp_io.read(path), path)

    @classmethod
    def new(cls, width=1920, height=1080, fps=24, frames=48, path=None):
        return cls(M.new_comp(width, height, fps, frames), path)

    def save(self, path=None):
        path = path or self.path
        if not path:
            raise CompError("give the comp a path to save to (it must end in .comp.json)")
        self.path = comp_io.write(os.path.abspath(path), self.data)
        return self.path

    # ── reading ──────────────────────────────────────────────────────────────

    @property
    def format(self):
        return dict(self.data["format"])

    @property
    def output(self):
        return self.data.get("output")

    def nodes(self, type=None):
        return [n for n in self.data["nodes"] if type is None or n["type"] == type]

    def node(self, nid):
        n = M.node_by_id(self.data, self._id(nid))
        if not n:
            raise CompError(f"no node {nid!r}")
        return n

    def _id(self, ref):
        """A node by id or by name."""
        if isinstance(ref, dict):
            ref = ref.get("id")
        ref = str(ref or "")
        if M.node_by_id(self.data, ref):
            return ref
        named = [n["id"] for n in self.data["nodes"] if n.get("name") == ref]
        if len(named) == 1:
            return named[0]
        raise CompError(f"no node {ref!r}" if not named else f"{len(named)} nodes are named {ref!r}: use the id")

    def summary(self):
        """What an agent needs to read a comp: its format, the output, and each node with its inputs and the
        parameters that differ from their defaults (keys as frame lists)."""
        out = []
        for n in self.data["nodes"]:
            t = M.NODE_TYPES[n["type"]]
            params = {p: n[p] for p, d in t["params"].items() if p in n and n[p] != d["def"] and d["kind"] != "roto"}
            row = {"id": n["id"], "type": n["type"],
                   "inputs": {name: src for name, src in zip(t["inputs"], n.get("inputs") or []) if src}}
            if n.get("name"):
                row["name"] = n["name"]
            if n.get("disable"):
                row["disable"] = True
            if params:
                row["params"] = params
            if n.get("tracks"):
                row["keys"] = {p: [k["f"] for k in ks] for p, ks in n["tracks"].items() if ks}
            out.append(row)
        return {"path": self.path, "format": self.format, "output": self.output, "nodes": out,
                "writes": [n["id"] for n in self.nodes("write")]}

    # ── edits ────────────────────────────────────────────────────────────────

    def _unique(self, base):
        have = {n["id"] for n in self.data["nodes"]}
        k = 1
        while f"{base}{k}" in have:
            k += 1
        return f"{base}{k}"

    def _check_param(self, n, p, v):
        t = M.NODE_TYPES[n["type"]]
        d = t["params"].get(p)
        if d is None:
            raise CompError(f"{n['type']} has no parameter {p!r} (it has: {', '.join(t['params']) or 'none'})")
        if d.get("choices") is not None and d["kind"] in ("enum",) and v not in d["choices"]:
            raise CompError(f"{n['type']}.{p} is one of {', '.join(map(str, d['choices']))}")
        if d["kind"] in ("num", "int") and v is not None:
            if not M._is_num(v):
                raise CompError(f"{n['type']}.{p} is a number")
            if d.get("min") is not None and v < d["min"] or d.get("max") is not None and v > d["max"]:
                raise CompError(f"{n['type']}.{p} is {d.get('min')}..{d.get('max')}")
            if d["kind"] == "int":
                v = int(round(v))
        return v

    def add(self, type, inputs=None, name=None, x=None, y=None, **params):
        """A new node; returns its id. ``inputs`` are node ids (or names) in the type's input order."""
        if type not in M.NODE_TYPES:
            raise CompError(f"no node type {type!r} (there are: {', '.join(sorted(M.NODE_TYPES))})")
        t = M.NODE_TYPES[type]
        nid = self._unique(LABELS.get(type, type.title()))
        n = {"id": nid, "type": type, "inputs": [None] * len(t["inputs"])}
        for p, d in t["params"].items():
            if d["def"] is not None:
                n[p] = copy.deepcopy(d["def"])
        for p, v in params.items():
            n[p] = self._check_param(n, p, v)
        if name:
            n["name"] = str(name)
        last = self.data["nodes"][-1] if self.data["nodes"] else None
        n["x"] = x if M._is_num(x) else (last.get("x", 0) + 150 if last else 0)
        n["y"] = y if M._is_num(y) else (last.get("y", 0) if last else 0)
        self.data["nodes"].append(n)
        for i, src in enumerate(inputs or []):
            if src:
                self.connect(nid, src, i)
        if type == "output" and not self.data.get("output"):
            self.data["output"] = nid
        return nid

    def _port(self, n, port):
        names = M.NODE_TYPES[n["type"]]["inputs"]
        if isinstance(port, str) and not port.isdigit():
            if port not in names:
                raise CompError(f"{n['type']} has no input {port!r} (it has: {', '.join(names) or 'none'})")
            return names.index(port)
        i = int(port or 0)
        if not 0 <= i < len(names):
            raise CompError(f"{n['type']} has {len(names)} input(s)")
        return i

    def connect(self, dst, src, port=0):
        """Input ``port`` (a number or its name: B, A, mask, src...) of ``dst`` reads ``src``; a loop is refused."""
        n = self.node(dst)
        i = self._port(n, port)
        sid = self._id(src) if src else None
        if sid and M._reaches(self.data, sid, n["id"]):
            raise CompError(f"{sid} -> {n['id']} would make a loop")
        n["inputs"][i] = sid
        return self

    def disconnect(self, dst, port=0):
        return self.connect(dst, None, port)

    def set(self, nid, **params):
        """Parameters set (a keyed parameter gets a key at frame 0... use :meth:`key` for that; here its keys go)."""
        n = self.node(nid)
        for p, v in params.items():
            if p in ("name", "disable"):
                if v in (None, "", False):
                    n.pop(p, None)
                else:
                    n[p] = True if p == "disable" else str(v)
                continue
            v = self._check_param(n, p, v)
            if v is None:
                n.pop(p, None)
            else:
                n[p] = copy.deepcopy(v)
            if n.get("tracks"):
                n["tracks"].pop(p, None)
        return self

    def key(self, nid, param, frame, value, ease="smooth"):
        """A key of ``param`` at ``frame`` (the page's keys: Motion's interpolation, ``ease`` one of EASES)."""
        n = self.node(nid)
        d = M.NODE_TYPES[n["type"]]["params"].get(param)
        if not d or not d.get("key"):
            raise CompError(f"{n['type']}.{param} cannot be keyed")
        value = self._check_param(n, param, value)
        if ease not in EASES:
            raise CompError(f"ease is one of {', '.join(EASES)}")
        f = int(round(frame))
        track = n.setdefault("tracks", {}).setdefault(param, [])
        for k in track:
            if k["f"] == f:
                k.update(v=copy.deepcopy(value), ease=ease)
                k.pop("ti", None)
                k.pop("to", None)
                break
        else:
            track.append({"f": f, "v": copy.deepcopy(value), "ease": ease})
            track.sort(key=lambda k: k["f"])
        return self

    def unkey(self, nid, param, frame=None):
        """A key taken off (``frame`` None: every key of the parameter; it keeps the value it had at frame 0)."""
        n = self.node(nid)
        tr = (n.get("tracks") or {}).get(param)
        if not tr:
            return self
        if frame is None:
            n[param] = M.param_at(n, param, 0)
            n["tracks"].pop(param, None)
        else:
            n["tracks"][param] = [k for k in tr if k["f"] != int(round(frame))]
            if not n["tracks"][param]:
                n["tracks"].pop(param)
        if not n["tracks"]:
            n.pop("tracks")
        return self

    def remove(self, *ids):
        gone = {self._id(i) for i in ids}
        self.data["nodes"] = [n for n in self.data["nodes"] if n["id"] not in gone]
        for n in self.data["nodes"]:
            n["inputs"] = [None if s in gone else s for s in n.get("inputs") or []]
        if self.data.get("output") in gone:
            o = next((n for n in self.data["nodes"] if n["type"] == "output"), None)
            self.data["output"] = o["id"] if o else None
        return self

    def set_output(self, nid):
        n = self.node(nid)
        if n["type"] != "output":
            raise CompError("the comp's output is an Output node")
        self.data["output"] = n["id"]
        return self

    def set_format(self, **f):
        for k in f:
            if k not in ("width", "height", "fps", "frames"):
                raise CompError(f"the format has width, height, fps and frames (not {k!r})")
        self.data["format"].update({k: v for k, v in f.items() if v is not None})
        self.data, _ = M.normalize(self.data)
        return self

    def apply(self, ops):
        """A list of operations (dicts) applied in order, all or nothing. Returns ``{"ids": [...]}`` with the id
        of every node an "add" made, so later ops in the same list can name them by ``"$0"``, ``"$1"``..."""
        before = copy.deepcopy(self.data)
        made = []

        def ref(v):
            if isinstance(v, str) and v.startswith("$") and v[1:].isdigit() and int(v[1:]) < len(made):
                return made[int(v[1:])]
            return v
        try:
            for k, op in enumerate(ops or []):
                if not isinstance(op, dict):
                    raise CompError(f"op {k}: an op is an object")
                o = dict(op)
                kind = o.pop("op", None)
                if kind == "add":
                    made.append(self.add(o.pop("type", None), [ref(i) for i in o.pop("inputs", None) or []],
                                         o.pop("name", None), o.pop("x", None), o.pop("y", None), **(o.pop("params", None) or {}), **o))
                elif kind == "connect":
                    self.connect(ref(o["node"]), ref(o.get("from")), o.get("input", 0))
                elif kind == "disconnect":
                    self.disconnect(ref(o["node"]), o.get("input", 0))
                elif kind == "set":
                    self.set(ref(o.pop("node")), **(o.pop("params", None) or {}), **o)
                elif kind == "key":
                    self.key(ref(o["node"]), o["param"], o["frame"], o["value"], o.get("ease", "smooth"))
                elif kind == "unkey":
                    self.unkey(ref(o["node"]), o["param"], o.get("frame"))
                elif kind == "remove":
                    self.remove(*[ref(i) for i in (o.get("nodes") or [o.get("node")])])
                elif kind == "output":
                    self.set_output(ref(o["node"]))
                elif kind == "format":
                    self.set_format(**{k: o[k] for k in ("width", "height", "fps", "frames") if k in o})
                elif kind == "rename":
                    self.set(ref(o["node"]), name=o.get("name"))
                else:
                    raise CompError(f"op {k}: unknown op {kind!r} (add, connect, disconnect, set, key, unkey, remove, "
                                    "output, format, rename)")
        except (KeyError, TypeError) as e:
            self.data = before
            raise CompError(f"an op is missing a field: {e}") from e
        except CompError:
            self.data = before
            raise
        self.data, _ = M.normalize(self.data)
        return {"ids": made}

    # ── rendering ────────────────────────────────────────────────────────────

    def render(self, writes=None, first=None, last=None, handles=None, *, window=None, progress=None, allow=None):
        """Render the Write nodes (all, or the ids / names given): each its own files. ``window`` (a, b) keeps only
        comp frames a..b (a farm task's chunk). Returns what each wrote."""
        if not self.path:
            raise CompError("save the comp first: relative paths are beside its file")
        ids = None if writes in (None, "all") else [self._id(w) for w in ([writes] if isinstance(writes, str) else writes)]
        plans = CW.plan(self.data, self.path, ids, first, last, handles)
        if not plans:
            raise CompError("the comp has no Write node (or they are switched off)")
        if window is not None:
            a, b = window
            for p in plans:
                p["frames"] = [f for f in p["frames"] if a <= f <= b]
                p["numbers"] = {f: p["numbers"][f] for f in p["frames"]}
            plans = [p for p in plans if p["frames"]]
        src = comp_io.Sources(self.path, allow=allow)
        try:
            return CW.render(self.data, self.path, plans, src, progress=progress)
        finally:
            src.close()

    def render_output(self, path, frames=None, first_number=1001, display=None, view=None, options=None, progress=None):
        """The Output node's picture written to ``path`` (a ``#`` pattern for frames, a film by its ending)."""
        if not self.data.get("output"):
            raise CompError("the comp has no Output node")
        frames = list(range(self.data["format"]["frames"])) if frames is None else list(frames)
        path = os.path.abspath(path)
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        ext = comp_io.ALIASES.get(ext, ext)
        enc = comp_io.display_encoder(display, view)
        src = comp_io.Sources(self.path)
        writer, out = None, []
        try:
            if ext in comp_io.VIDEO_FORMATS:
                size = M.format_at(self.data, self.data["output"])
                writer = comp_io.VideoWriter(path, CW._film_settings(ext), self.data["format"]["fps"], size["width"], size["height"], enc)
            for k, (f, img) in enumerate(comp_io.render_frames(self.data, frames, src)):
                if writer is not None:
                    writer.add(img)
                else:
                    p = CW.frame_file(path, first_number + f) if (len(frames) > 1 or comp_io.is_sequence(path)) else path
                    comp_io.write_still(img, p, ext, enc, options)
                    out.append(p)
                if progress:
                    progress(k + 1, len(frames))
            if writer is not None:
                writer.close(True)
                writer = None
                out = [path]
        finally:
            if writer is not None:
                writer.close(False)
            src.close()
        return out
