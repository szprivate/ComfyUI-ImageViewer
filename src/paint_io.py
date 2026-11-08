"""Paint's documents: a picture made of layers, kept as an OpenRaster file (.ora), exported flat or
as a Photoshop file (.psd).

A document is ``PaintDoc``: ``meta`` (what the page and the agent read - the size, the layers bottom
to top with their names, switches, opacity, blend mode, place, mask, an adjustment layer's type and
numbers) and the pixels beside it (``px[id]`` straight RGBA ``uint8 (h, w, 4)``, ``masks[id]``
``uint8 (h, w)``, ``selection`` ``uint8 (H, W)`` or None).

**The .ora** (OpenRaster 0.0.x, a zip Krita and GIMP open): ``mimetype`` (stored, first),
``stack.xml`` (the pixel layers, top first, with their place, opacity, visibility and composite-op),
``data/<id>.png``, ``mergedimage.png`` (the picture as it looks: :func:`composite`, the page's own
arithmetic - paint_math), ``Thumbnails/thumbnail.png``, and ours: ``imageviewer.json`` (the whole
``meta``: adjustment layers, masks, text, the selection - what ``stack.xml`` has no words for),
``data/<id>_mask.png``, ``selection.png``. An .ora from another program has no ``imageviewer.json``; its
``stack.xml`` is read (a stack inside the stack is a group).

**The .psd** (8-bit RGB, written by :func:`write_psd`, read by :func:`read_psd`): pixel layers
with their place, opacity, blend mode, visibility and mask (RLE), the merged picture, and Unicode
names, and groups as Photoshop's layer groups (Pass Through too). Photoshop has adjustment layers of its own, but not ours with our numbers: an adjustment
layer is BAKED on export - what is under it and it become one pixel layer, "<name> (merged)" (inside
a group: that whole group of the document's level), and the answer says so. Reading a .psd takes its
pixel layers (raw or RLE), groups and clipping masks; its adjustment layers are named as left out.
"""
from __future__ import annotations

import io
import json
import os
import re
import struct
import uuid
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

from . import paint_math as M
from . import paint_style as S
from . import paint_smart as SM

VERSION = 1
MAX_SIDE = 16384
MAX_LAYERS = 200
EXTS_OPEN = {".ora", ".psd"}


def new_id():
    return "l" + uuid.uuid4().hex[:10]


class PaintDoc:
    def __init__(self, w, h, name="paint"):
        self.meta = {"version": VERSION, "w": int(w), "h": int(h), "name": str(name or "paint"), "layers": [],
                     "active": None}
        self.px = {}
        self.masks = {}
        self.selection = None
        self.notes = []

    @property
    def w(self):
        return self.meta["w"]

    @property
    def h(self):
        return self.meta["h"]

    @property
    def layers(self):
        return self.meta["layers"]

    def layer(self, lid):
        for L in self.layers:
            if L["id"] == lid:
                return L
        return None

    def add_pixel_layer(self, pixels, name="Layer", x=0, y=0, index=None, **props):
        lid = props.pop("id", None) or new_id()
        h, w = pixels.shape[:2]
        L = clean_layer({"id": lid, "name": name, "kind": "pixel", "x": int(x), "y": int(y), "w": int(w), "h": int(h),
                         **props})
        self.px[lid] = np.ascontiguousarray(pixels, dtype=np.uint8)
        self._insert(L, index)
        return L

    def add_adjust_layer(self, kind, params=None, name=None, index=None, **props):
        lid = props.pop("id", None) or new_id()
        L = clean_layer({"id": lid, "name": name or M.ADJUST_LABELS.get(kind, kind), "kind": "adjust",
                         "adjust": {"type": kind, "params": M.clean_adjust(kind, params or {})}, **props})
        self._insert(L, index)
        return L

    def add_group(self, name="Group", index=None, **props):
        lid = props.pop("id", None) or new_id()
        L = clean_layer({"id": lid, "name": name, "kind": "group", **props})
        self._insert(L, index)
        return L

    def _insert(self, L, index):
        if len(self.layers) >= MAX_LAYERS:
            raise ValueError(f"at most {MAX_LAYERS} layers")
        if index is None:
            self.layers.append(L)
        else:
            self.layers.insert(max(0, min(len(self.layers), int(index))), L)
        self.meta["active"] = L["id"]

    def remove(self, lid):
        """The layer out (a group with everything inside it)."""
        L = self.layer(lid)
        gone = {x["id"] for x in subtree(self, L)} if L else {lid}
        self.meta["layers"] = [x for x in self.layers if x["id"] not in gone]
        for g in gone:
            self.px.pop(g, None)
            self.masks.pop(g, None)
        if self.meta.get("active") == lid:
            self.meta["active"] = self.layers[-1]["id"] if self.layers else None


def clean_layer(L):
    """A layer's description held to what it may be (``paintData.cleanLayer`` is the same)."""
    kind = L.get("kind") if L.get("kind") in ("adjust", "group") else "pixel"
    out = {"id": str(L.get("id") or new_id())[:40],
           "name": str(L.get("name") or ("Group" if kind == "group" else "Layer"))[:120], "kind": kind,
           "visible": L.get("visible") is not False, "opacity": M._num(L.get("opacity"), 1.0, 0, 1),
           "blend": L.get("blend") if L.get("blend") in M.BLEND_MODES else "normal",
           "locked": bool(L.get("locked"))}
    if L.get("parent"):
        out["parent"] = str(L["parent"])[:40]
    if L.get("clip") and kind != "group":
        out["clip"] = True
    if kind == "pixel":
        out.update(x=int(M._num(L.get("x"), 0)), y=int(M._num(L.get("y"), 0)),
                   w=int(M._num(L.get("w"), 0, 0, MAX_SIDE)), h=int(M._num(L.get("h"), 0, 0, MAX_SIDE)))
        if isinstance(L.get("text"), dict):
            out["text"] = clean_text(L["text"])
        st = S.clean_style(L.get("style"))
        if st:
            out["style"] = st
        if L.get("lockAlpha"):
            out["lockAlpha"] = True
        fl = SM.clean_filters(L.get("filters"))
        if fl:
            out["filters"] = fl
    elif kind == "group":
        out["blend"] = L.get("blend") if L.get("blend") in M.GROUP_BLENDS else "pass_through"
        if L.get("collapsed"):
            out["collapsed"] = True
    else:
        a = L.get("adjust") if isinstance(L.get("adjust"), dict) else {}
        t = a.get("type") if a.get("type") in M.ADJUST_TYPES else "levels"
        out["adjust"] = {"type": t, "params": M.clean_adjust(t, a.get("params"))}
        out["blend"] = "normal"
    m = L.get("mask")
    if isinstance(m, dict):
        out["mask"] = {"enabled": m.get("enabled") is not False, "x": int(M._num(m.get("x"), 0)),
                       "y": int(M._num(m.get("y"), 0)), "w": int(M._num(m.get("w"), 0, 0, MAX_SIDE)),
                       "h": int(M._num(m.get("h"), 0, 0, MAX_SIDE)),
                       "fill": 255 if M._num(m.get("fill"), 0) >= 128 else 0}
        dn, fe = M._num(m.get("density"), 1, 0, 1), M._num(m.get("feather"), 0, 0, 250)
        if dn != 1:
            out["mask"]["density"] = dn
        if fe > 0:
            out["mask"]["feather"] = fe
    return out


MAX_DEPTH = 12


def fix_tree(layers):
    """The layers put in tree order, in place (``paintData.fixTree``): a ``parent`` names a group or is
    gone, and every group's layers lie right under it (bottom .. top: its layers, then the group).
    Siblings keep their order; a loop or deeper than MAX_DEPTH: out of the group."""
    by_id = {L["id"]: L for L in layers}
    for L in layers:
        p = L.get("parent")
        P = by_id.get(p) if p else None
        if not P or P.get("kind") != "group" or P is L:
            L.pop("parent", None)
    for L in layers:
        p, n, seen = L.get("parent"), 0, {L["id"]}
        while p:
            n += 1
            if p in seen or n > MAX_DEPTH:
                L.pop("parent", None)
                break
            seen.add(p)
            p = by_id[p].get("parent")
    kids = {}
    for L in layers:
        kids.setdefault(L.get("parent") or "", []).append(L)
    out = []

    def walk(k):
        for L in kids.get(k, []):
            if L.get("kind") == "group":
                walk(L["id"])
            out.append(L)
    walk("")
    layers[:] = out
    return layers


def ancestors(doc, L):
    """The groups *L* is in, the nearest first."""
    out, p = [], L.get("parent")
    while p and len(out) <= MAX_DEPTH:
        P = doc.layer(p)
        if P is None:
            break
        out.append(P)
        p = P.get("parent")
    return out


def subtree(doc, L):
    """*L* and, for a group, every layer inside it - bottom first (a slice of ``doc.layers``)."""
    i = next(k for k, x in enumerate(doc.layers) if x["id"] == L["id"])
    a = i
    while a > 0 and any(P["id"] == L["id"] for P in ancestors(doc, doc.layers[a - 1])):
        a -= 1
    return doc.layers[a:i + 1]


TEXT_DEFAULT = {"text": "", "font": "sans-serif", "size": 48, "color": "#ffffff", "bold": False, "italic": False,
                "align": "left"}


def clean_text(t):
    out = dict(TEXT_DEFAULT)
    out["text"] = str(t.get("text") or "")[:4000]
    out["font"] = str(t.get("font") or "sans-serif")[:80]
    out["size"] = M._num(t.get("size"), 48, 4, 2000)
    c = str(t.get("color") or "#ffffff")
    out["color"] = c if re.fullmatch(r"#[0-9a-fA-F]{6}", c) else "#ffffff"
    out["bold"], out["italic"] = bool(t.get("bold")), bool(t.get("italic"))
    out["align"] = t.get("align") if t.get("align") in ("left", "center", "right") else "left"
    return out


def clean_meta(meta):
    """A document's description from the page, held to what it may be."""
    if not isinstance(meta, dict):
        raise ValueError("the document is not an object")
    w, h = int(M._num(meta.get("w"), 0)), int(M._num(meta.get("h"), 0))
    if not (1 <= w <= MAX_SIDE and 1 <= h <= MAX_SIDE):
        raise ValueError(f"the canvas must be 1..{MAX_SIDE} pixels a side")
    layers = meta.get("layers") if isinstance(meta.get("layers"), list) else []
    if len(layers) > MAX_LAYERS:
        raise ValueError(f"at most {MAX_LAYERS} layers")
    out = {"version": VERSION, "w": w, "h": h, "name": str(meta.get("name") or "paint")[:120],
           "layers": fix_tree([clean_layer(L) for L in layers if isinstance(L, dict)])}
    ids = [L["id"] for L in out["layers"]]
    if len(set(ids)) != len(ids):
        raise ValueError("two layers have the same id")
    out["active"] = meta.get("active") if meta.get("active") in ids else (ids[-1] if ids else None)
    paths = M.clean_paths(meta.get("paths"))
    if paths:
        out["paths"] = paths
    guides = M.clean_guides(meta.get("guides"), w, h)
    if guides:
        out["guides"] = guides
    return out


# ── the picture as it looks ──────────────────────────────────────────────────

def mask_values(L, mask, x0, y0, x1, y1):
    """The layer's mask over the canvas rectangle x0..x1, y0..y1, as floats 0..1 (1 with none)."""
    m = L.get("mask")
    if not m or not m.get("enabled") or mask is None:
        return np.ones((y1 - y0, x1 - x0), dtype=np.float64)
    if m.get("feather", 0) > 0:
        mask = M.feather_mask(mask, float(m["feather"]))
    out = np.full((y1 - y0, x1 - x0), m.get("fill", 0) / 255.0, dtype=np.float64)
    mx, my = m["x"], m["y"]
    mh, mw = mask.shape[:2]
    ax0, ay0 = max(x0, mx), max(y0, my)
    ax1, ay1 = min(x1, mx + mw), min(y1, my + mh)
    if ax1 > ax0 and ay1 > ay0:
        out[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = mask[ay0 - my:ay1 - my, ax0 - mx:ax1 - mx] / 255.0
    dn = float(m.get("density", 1))
    if dn != 1:
        out = 1 - dn * (1 - out)
    return out


def composite(doc, upto=None, only=None, hidden_ok=False):
    """The document as it looks: ``uint8 (H, W, 4)``. *upto*: the layers of the document's own level up to
    and with this id (a group with what is inside it); *only*: just these ids (groups are always gone
    through). A group as ``paintData.composite`` lays it."""
    W, H = doc.w, doc.h
    out = np.zeros((H, W, 4), dtype=np.uint8)
    kids = {}
    groups = {L["id"] for L in doc.layers if L["kind"] == "group"}
    for i, L in enumerate(doc.layers):
        # A parent not in the document (a layer taken out to be laid alone): of the document's level.
        kids.setdefault(L.get("parent") if L.get("parent") in groups else "", []).append(i)
    k = None
    if upto is not None:
        k = next((i for i, L in enumerate(doc.layers) if L["id"] == upto), None)
    top = [i for i in kids.get("", []) if k is None or i <= k]
    return _lay_list(out, doc, top, kids, only, hidden_ok)


def _lay_list(out, doc, idxs, kids, only, hidden_ok):
    k = 0
    while k < len(idxs):
        L = doc.layers[idxs[k]]
        n = 0
        if L["kind"] != "adjust" and not L.get("clip"):
            while k + 1 + n < len(idxs) and doc.layers[idxs[k + 1 + n]].get("clip"):
                n += 1
        skip = only is not None and L["id"] not in only and L["kind"] != "group"
        if skip or not (L.get("visible") or hidden_ok):
            k += 1 + n
            continue
        clipped = [doc.layers[idxs[k + j]] for j in range(1, n + 1)]
        clipped = [C for C in clipped if (C.get("visible") or hidden_ok) and (only is None or C["id"] in only)]
        if clipped:
            out = _lay_clip_group(out, doc, L, clipped, kids, only, hidden_ok)
        elif L["kind"] == "group":
            out = _lay_group(out, doc, L, kids, only, hidden_ok)
        else:
            out = lay(out, doc, L)
        k += 1 + n
    return out


def _lay_clip_group(out, doc, B, clipped, kids, only, hidden_ok):
    """A base and the layers clipped to it (``paintData.layClipGroup``)."""
    W, H = doc.w, doc.h
    op = float(B.get("opacity", 1.0))
    if op <= 0:
        return out
    buf = np.zeros((H, W, 4), dtype=np.uint8)
    if B["kind"] == "group":
        buf = _lay_group(buf, doc, dict(B, blend="normal", opacity=1.0), kids, only, hidden_ok)
    else:
        buf = lay(buf, doc, dict(B, opacity=1.0, blend="normal"))
    for C in clipped:
        if C["kind"] == "adjust":
            buf = lay(buf, doc, C)
            continue
        px = doc.px.get(C["id"])
        cop = float(C.get("opacity", 1.0))
        if px is None or cop <= 0:
            continue
        C, px = SM.smart_layer(W, H, C, px)
        lx, ly = C.get("x", 0), C.get("y", 0)
        ph, pw = px.shape[:2]
        x0, y0, x1, y1 = max(0, lx), max(0, ly), min(W, lx + pw), min(H, ly + ph)
        if x1 <= x0 or y1 <= y0:
            continue
        alpha = cop * mask_values(C, doc.masks.get(C["id"]), x0, y0, x1, y1)
        buf[y0:y1, x0:x1] = M.clip_over(buf[y0:y1, x0:x1], px[y0 - ly:y1 - ly, x0 - lx:x1 - lx], alpha,
                                        C.get("blend", "normal"))
    blend = "normal" if B.get("blend") == "pass_through" else B.get("blend", "normal")
    return M.blend_over(out, buf, np.full((H, W), op), blend)


def _lay_group(out, doc, G, kids, only, hidden_ok):
    W, H = doc.w, doc.h
    ch = kids.get(G["id"], [])
    op = float(G.get("opacity", 1.0))
    if op <= 0 or not ch:
        return out
    mask = doc.masks.get(G["id"])
    masked = bool(G.get("mask") and G["mask"].get("enabled") and mask is not None)
    if G.get("blend") == "pass_through":
        if op >= 1 and not masked:
            return _lay_list(out, doc, ch, kids, only, hidden_ok)
        res = _lay_list(out.copy(), doc, ch, kids, only, hidden_ok)
        return M.mix_back(out, res, op * mask_values(G, mask, 0, 0, W, H))
    buf = _lay_list(np.zeros((H, W, 4), dtype=np.uint8), doc, ch, kids, only, hidden_ok)
    return M.blend_over(out, buf, op * mask_values(G, mask, 0, 0, W, H), G.get("blend", "normal"))


def lay(out, doc, L):
    """One layer over *out* (in place where it can, the result returned)."""
    W, H = doc.w, doc.h
    op = float(L.get("opacity", 1.0))
    if L["kind"] == "adjust":
        if op <= 0:
            return out
        t = op * mask_values(L, doc.masks.get(L["id"]), 0, 0, W, H)
        a = L["adjust"]
        return M.apply_adjust(out, a["type"], a["params"], t)
    px = doc.px.get(L["id"])
    if px is None or op <= 0:
        return out
    L, px = SM.smart_layer(W, H, L, px)
    if S.style_on(L):
        st = S.styled_pixels(W, H, L, px, mask_values(L, doc.masks.get(L["id"]), 0, 0, W, H))
        return M.blend_over(out, st, np.full((H, W), op), L.get("blend", "normal"))
    lx, ly = L.get("x", 0), L.get("y", 0)
    ph, pw = px.shape[:2]
    x0, y0, x1, y1 = max(0, lx), max(0, ly), min(W, lx + pw), min(H, ly + ph)
    if x1 <= x0 or y1 <= y0:
        return out
    src = px[y0 - ly:y1 - ly, x0 - lx:x1 - lx]
    alpha = op * mask_values(L, doc.masks.get(L["id"]), x0, y0, x1, y1)
    out[y0:y1, x0:x1] = M.blend_over(out[y0:y1, x0:x1], src, alpha, L.get("blend", "normal"))
    return out


# ── PNG in and out ───────────────────────────────────────────────────────────

def png_bytes(arr, mode=None):
    from PIL import Image
    im = Image.fromarray(arr, mode=mode or ("L" if arr.ndim == 2 else "RGBA"))
    b = io.BytesIO()
    im.save(b, format="PNG", compress_level=4)
    return b.getvalue()


def read_png(data, gray=False):
    from PIL import Image
    im = Image.open(io.BytesIO(data) if isinstance(data, (bytes, bytearray)) else data)
    im.load()
    if gray:
        if im.mode in ("RGBA", "LA"):
            # A mask sent as RGBA (a canvas has no grey PNG): its brightness.
            im = im.convert("RGB")
        return np.asarray(im.convert("L"), dtype=np.uint8).copy()
    return np.asarray(im.convert("RGBA"), dtype=np.uint8).copy()


def image_pixels(path):
    """Any picture the viewer shows as straight RGBA 8-bit: through Pillow, or the display proxy
    (EXR, HDR, DPX ... - what the viewer shows of it)."""
    try:
        return read_png(path)
    except Exception:  # noqa: BLE001 - not a format Pillow reads
        pass
    from . import media_resolve
    proxy = media_resolve.proxy_for_display(path)
    if not proxy:
        raise ValueError(f"{os.path.basename(path)} could not be read as a picture")
    return read_png(proxy)


def doc_from_image(path, name=None):
    px = image_pixels(path)
    h, w = px.shape[:2]
    if w > MAX_SIDE or h > MAX_SIDE:
        raise ValueError(f"the picture is larger than {MAX_SIDE} pixels a side")
    doc = PaintDoc(w, h, name or os.path.splitext(os.path.basename(path))[0])
    doc.add_pixel_layer(px, "Background")
    return doc


def open_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".ora":
        return read_ora(path)
    if ext == ".psd":
        return read_psd(path)
    return doc_from_image(path)


# ── OpenRaster ───────────────────────────────────────────────────────────────

def write_ora(path, doc):
    """Write *doc* to *path* (tmp + replace, so a failed save leaves the old file)."""
    meta = clean_meta(doc.meta)
    doc.meta = meta
    merged = composite(doc)
    root = ET.Element("image", {"version": "0.0.3", "w": str(doc.w), "h": str(doc.h), "name": meta["name"]})
    stack = ET.SubElement(root, "stack")
    files = []
    kids = {}
    for L in meta["layers"]:
        kids.setdefault(L.get("parent") or "", []).append(L)

    def put(parent_el, key):
        for L in reversed(kids.get(key, [])):
            vis = "visible" if L["visible"] else "hidden"
            if L["kind"] == "group":
                # A group is a stack: Pass Through is "auto" isolation, any other mode isolated.
                g = ET.SubElement(parent_el, "stack", {
                    "name": L["name"], "opacity": f"{L['opacity']:.4f}", "visibility": vis,
                    "composite-op": M.ORA_BLEND.get(L["blend"], "svg:src-over"),
                    "isolation": "auto" if L["blend"] == "pass_through" else "isolate"})
                put(g, L["id"])
                continue
            if L["kind"] != "pixel":
                continue
            src = f"data/{L['id']}.png"
            ET.SubElement(parent_el, "layer", {
                "name": L["name"], "src": src, "x": str(L["x"]), "y": str(L["y"]), "opacity": f"{L['opacity']:.4f}",
                "visibility": vis, "composite-op": M.ORA_BLEND[L["blend"]],
                **({"edit-locked": "true"} if L.get("locked") else {})})
            px = doc.px.get(L["id"])
            if px is None:
                px = np.zeros((max(1, L["h"]), max(1, L["w"]), 4), dtype=np.uint8)
            files.append((src, png_bytes(px)))
    put(stack, "")
    for L in meta["layers"]:
        if L.get("mask") and doc.masks.get(L["id"]) is not None:
            files.append((f"data/{L['id']}_mask.png", png_bytes(doc.masks[L["id"]])))
    if doc.selection is not None and doc.selection.any():
        files.append(("selection.png", png_bytes(doc.selection)))
        meta["selection"] = True
    else:
        meta.pop("selection", None)
    from PIL import Image
    thumb = Image.fromarray(merged, "RGBA")
    thumb.thumbnail((256, 256))
    tb = io.BytesIO()
    thumb.save(tb, format="PNG")
    tmp = f"{path}.tmp-{uuid.uuid4().hex[:6]}"
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    try:
        with zipfile.ZipFile(tmp, "w") as z:
            z.writestr(zipfile.ZipInfo("mimetype"), "image/openraster", compress_type=zipfile.ZIP_STORED)
            z.writestr("stack.xml", ET.tostring(root, encoding="utf-8", xml_declaration=True),
                       compress_type=zipfile.ZIP_DEFLATED)
            for name, data in files:
                z.writestr(name, data, compress_type=zipfile.ZIP_STORED)
            z.writestr("mergedimage.png", png_bytes(merged), compress_type=zipfile.ZIP_STORED)
            z.writestr("Thumbnails/thumbnail.png", tb.getvalue(), compress_type=zipfile.ZIP_STORED)
            z.writestr("imageviewer.json", json.dumps(meta, indent=1), compress_type=zipfile.ZIP_DEFLATED)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return merged


def _ora_layers(stack, z, doc, x0=0, y0=0, parent=None):
    """The layers of a stack.xml stack (top first), bottom first into *doc*; a stack inside is a group."""
    for el in reversed(list(stack)):
        if el.tag == "stack":
            gx, gy = x0 + int(float(el.get("x") or 0)), y0 + int(float(el.get("y") or 0))
            op = el.get("composite-op") or "svg:src-over"
            isolated = el.get("isolation") == "isolate" or op != "svg:src-over"
            blend = M.ORA_BLEND_BACK.get(op, "normal") if isolated else "pass_through"
            G = clean_layer({"id": new_id(), "name": el.get("name") or "Group", "kind": "group", "blend": blend,
                             "opacity": M._num(el.get("opacity"), 1, 0, 1), "visible": el.get("visibility") != "hidden",
                             **({"parent": parent} if parent else {})})
            # The group's entry goes above what is in it: put it in after them (fix_tree keeps it so).
            _ora_layers(el, z, doc, gx, gy, G["id"])
            doc._insert(G, None)
        elif el.tag == "layer":
            src = el.get("src") or ""
            try:
                px = read_png(z.read(src))
            except Exception:  # noqa: BLE001 - not a png layer (an svg, a missing file): said
                doc.notes.append(f"layer {el.get('name') or src!r} could not be read and was left out")
                continue
            op = el.get("composite-op") or "svg:src-over"
            blend = M.ORA_BLEND_BACK.get(op, "normal")
            if op not in M.ORA_BLEND_BACK:
                doc.notes.append(f"layer {el.get('name')!r}: its blend mode {op} is not known here, it is Normal")
            doc.add_pixel_layer(px, el.get("name") or "Layer", x0 + int(float(el.get("x") or 0)),
                                y0 + int(float(el.get("y") or 0)),
                                opacity=M._num(el.get("opacity"), 1, 0, 1), visible=el.get("visibility") != "hidden",
                                blend=blend, locked=el.get("edit-locked") == "true",
                                **({"parent": parent} if parent else {}))


def read_ora(path):
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        root = ET.fromstring(z.read("stack.xml"))
        W, H = int(root.get("w") or 0), int(root.get("h") or 0)
        # bepic.json: written while the viewer was called "bEpic" (before 1.18)
        own = next((n for n in ("imageviewer.json", "bepic.json") if n in names), None)
        if own:
            meta = clean_meta(json.loads(z.read(own)))
            doc = PaintDoc(meta["w"], meta["h"], meta["name"])
            doc.meta = meta
            for L in meta["layers"]:
                if L["kind"] == "pixel":
                    src = f"data/{L['id']}.png"
                    px = read_png(z.read(src)) if src in names else np.zeros((max(1, L["h"]), max(1, L["w"]), 4), np.uint8)
                    doc.px[L["id"]] = px
                    L["h"], L["w"] = px.shape[:2]
                if L.get("mask"):
                    mn = f"data/{L['id']}_mask.png"
                    if mn in names:
                        doc.masks[L["id"]] = read_png(z.read(mn), gray=True)
                        L["mask"]["h"], L["mask"]["w"] = doc.masks[L["id"]].shape[:2]
                    else:
                        L.pop("mask")
            if "selection.png" in names:
                sel = read_png(z.read("selection.png"), gray=True)
                if sel.shape == (doc.h, doc.w):
                    doc.selection = sel
            doc.meta.pop("selection", None)
            return doc
        doc = PaintDoc(W, H, root.get("name") or os.path.splitext(os.path.basename(path))[0])
        top = root.find("stack")
        if top is not None:
            _ora_layers(top, z, doc)
        if not doc.layers and "mergedimage.png" in names:
            doc.add_pixel_layer(read_png(z.read("mergedimage.png")), "Background")
        fix_tree(doc.layers)
        if doc.layers:
            doc.meta["active"] = doc.layers[-1]["id"]
        return doc


# ── Photoshop ────────────────────────────────────────────────────────────────

def packbits(row):
    """PackBits (Apple's RLE, what Photoshop's compression 1 is) of one row of bytes."""
    out = bytearray()
    n = len(row)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and row[j + 1] == row[i] and j - i < 127:
            j += 1
        if j > i:
            out.append(257 - (j - i + 1))
            out.append(row[i])
            i = j + 1
            continue
        j = i
        while j + 1 < n and j - i < 127 and not (j + 2 < n and row[j + 1] == row[j + 2]):
            j += 1
        out.append(j - i)
        out.extend(row[i:j + 1])
        i = j + 1
    return bytes(out)


def unpackbits(data, size):
    out = bytearray()
    i = 0
    while len(out) < size and i < len(data):
        n = data[i]
        i += 1
        if n < 128:
            out.extend(data[i:i + n + 1])
            i += n + 1
        elif n > 128:
            out.extend(bytes([data[i]]) * (257 - n))
            i += 1
    return bytes(out[:size]).ljust(size, b"\0")


def _rle_channel(plane):
    """A channel as Photoshop stores it under compression 1: (counts, data)."""
    rows = [packbits(plane[y].tobytes()) for y in range(plane.shape[0])]
    return b"".join(struct.pack(">H", len(r)) for r in rows), b"".join(rows)


def _pascal(name, pad=4):
    raw = name.encode("latin-1", "replace")[:255]
    b = bytes([len(raw)]) + raw
    while len(b) % pad:
        b += b"\0"
    return b


def _unicode_block(name):
    s = name[:250]
    data = struct.pack(">I", len(s)) + s.encode("utf-16-be")
    if len(data) % 2:
        data += b"\0"
    return b"8BIMluni" + struct.pack(">I", len(data)) + data


def baked_for_psd(doc):
    """The document's layers as Photoshop can take them: an adjustment layer and what is under it
    become one pixel layer (an adjustment inside a group: that group of the document's own level, and
    what is under it). ``(layers [(meta, pixels, mask)], notes)``, bottom first; a group's entry has
    pixels None and comes after what is inside it."""
    out, notes = [], []
    top = [L for L in doc.layers if not L.get("parent")]
    for T in top:
        inside = subtree(doc, T)
        adjusts = [L for L in inside if L["kind"] == "adjust"]
        hidden = [L for L in adjusts if not L.get("visible") or any(not P.get("visible") for P in ancestors(doc, L))]
        for L in hidden:
            notes.append(f"the hidden adjustment layer {L['name']!r} was left out")
        if len(adjusts) > len(hidden):
            merged = composite(doc, upto=T["id"])
            nm = f"{T['name']} (merged)"
            out = [(clean_layer({"id": T["id"], "name": nm, "x": 0, "y": 0, "w": doc.w, "h": doc.h}), merged, None)]
            if T["kind"] == "adjust":
                label = M.ADJUST_LABELS[T["adjust"]["type"]]
                what = T["name"] if T["name"] == label else f"{T['name']} ({label})"
            else:
                what = f"the group {T['name']!r}, which holds an adjustment layer,"
            notes.append(f"{what} was merged with the layers under it "
                         f"into one layer, {nm!r}: Photoshop's own adjustment layers do not work out the same")
            continue
        for L in inside:
            if L["kind"] == "group":
                out.append((L, None, doc.masks.get(L["id"]) if L.get("mask") else None))
                continue
            px = doc.px.get(L["id"])
            if px is None:
                continue
            if SM.smart_on(L):
                # Smart filters are baked: the layer as they draw it, canvas-sized.
                L, px = SM.smart_layer(doc.w, doc.h, L, px)
                L = {k: v for k, v in L.items() if k != "filters"}
                notes.append(f"the smart filters of {L['name']!r} were baked into its pixels")
            if S.style_on(L):
                # A layer style is baked: the layer and its effects (and its mask) as one picture.
                st = S.styled_pixels(doc.w, doc.h, L, px, mask_values(L, doc.masks.get(L["id"]), 0, 0, doc.w, doc.h))
                meta = {k: v for k, v in L.items() if k not in ("mask", "style")}
                out.append((dict(meta, x=0, y=0, w=doc.w, h=doc.h), st, None))
                notes.append(f"the layer style of {L['name']!r} was baked into its pixels")
                continue
            out.append((L, px, doc.masks.get(L["id"]) if L.get("mask") else None))
    return out, notes


def _psd_record(L, px, mask, section=None):
    """One layer record and its channel data. *section*: the group's lsct type (1 open, 2 closed,
    3 the end of a group - a divider)."""
    if px is None:
        h = w = x = y = 0
        planes = [np.zeros((0, 0), np.uint8)] * 4
    else:
        h, w = px.shape[:2]
        x, y = int(L.get("x", 0)), int(L.get("y", 0))
        planes = [px[..., 3], px[..., 0], px[..., 1], px[..., 2]]
    channel_ids = [-1, 0, 1, 2]
    m = L.get("mask") if mask is not None else None
    if m and (m.get("feather", 0) > 0 or m.get("density", 1) != 1):
        # Photoshop's own density and feather are not written: the mask goes as it acts.
        dn = float(m.get("density", 1))
        mask = M.q8(1 - dn * (1 - M.feather_mask(mask, float(m.get("feather", 0))) / 255.0))
        m = dict(m, fill=int(round(255 * (1 - dn * (1 - m.get("fill", 0) / 255)))))
    if m:
        channel_ids.append(-2)
        planes.append(mask)
    cinfo, cdata = b"", b""
    for cid, plane in zip(channel_ids, planes):
        if plane.size == 0:
            block = struct.pack(">H", 0)
        else:
            counts, data = _rle_channel(np.ascontiguousarray(plane))
            block = struct.pack(">H", 1) + counts + data
        cinfo += struct.pack(">hI", cid, len(block))
        cdata += block
    flags = 0 if L.get("visible", True) else 2
    if L.get("locked") or L.get("lockAlpha"):
        flags |= 1                  # transparency protected (also the nearest Photoshop has to a whole lock)
    if section is not None:
        flags |= 8 | 16             # bit 4 (said by bit 3): the pixel data does not matter (a folder)
    if m:
        mh, mw = mask.shape[:2]
        mflags = 0 if m.get("enabled") else 2
        maskdata = struct.pack(">iiiiBBH", m["y"], m["x"], m["y"] + mh, m["x"] + mw, m.get("fill", 0), mflags, 0)
    else:
        maskdata = b""
    blend = L.get("blend", "normal")
    key = M.PSD_PASS if blend == "pass_through" else M.PSD_BLEND.get(blend, b"norm")
    extra = (struct.pack(">I", len(maskdata)) + maskdata + struct.pack(">I", 0) + _pascal(L["name"])
             + _unicode_block(L["name"]))
    if section is not None:
        lsct = struct.pack(">I", section) + (b"8BIM" + key if section in (1, 2) else b"")
        extra += b"8BIMlsct" + struct.pack(">I", len(lsct)) + lsct
    rec = (struct.pack(">iiiiH", y, x, y + h, x + w, len(channel_ids)) + cinfo + b"8BIM"
           + (b"norm" if section == 3 else key)
           + struct.pack(">BBBB", int(round(float(L.get("opacity", 1)) * 255)), 1 if L.get("clip") else 0, flags, 0)
           + struct.pack(">I", len(extra)) + extra)
    return rec, cdata


def write_psd(path, doc):
    """A layered .psd (8-bit RGB), groups as Photoshop's layer groups. Returns the notes (what was baked)."""
    layers, notes = baked_for_psd(doc)
    if doc.meta.get("paths"):
        notes = list(notes) + [f"{len(doc.meta['paths'])} pen path(s) are kept only in the .ora, not in the .psd"]
    W, H = doc.w, doc.h
    recs, chans = [], []
    kids = {}
    for e in layers:
        kids.setdefault(e[0].get("parent") or "", []).append(e)

    def put(key):
        for L, px, mask in kids.get(key, []):
            if L["kind"] == "group":
                r, c = _psd_record({"name": "</Layer group>", "visible": True}, None, None, section=3)
                recs.append(r)
                chans.append(c)
                put(L["id"])
                r, c = _psd_record(L, None, mask, section=2 if L.get("collapsed") else 1)
            else:
                r, c = _psd_record(L, px, mask)
            recs.append(r)
            chans.append(c)
    put("")
    linfo = struct.pack(">h", len(recs)) + b"".join(recs) + b"".join(chans)
    if len(linfo) % 2:
        linfo += b"\0"
    layer_section = struct.pack(">I", len(linfo)) + linfo + struct.pack(">I", 0)
    merged = composite(doc)
    # The merged picture: three channels, over white where it is see-through (what a reader shows).
    a = merged[..., 3:4].astype(np.float64) / 255
    flat = M.q8((merged[..., :3].astype(np.float64) / 255) * a + (1 - a))
    counts, datas = b"", b""
    for ch in range(3):
        c, d = _rle_channel(np.ascontiguousarray(flat[..., ch]))
        counts += c
        datas += d
    res = _resolution_block()
    body = (b"8BPS" + struct.pack(">H6xHIIHH", 1, 3, H, W, 8, 3) + struct.pack(">I", 0)
            + struct.pack(">I", len(res)) + res
            + struct.pack(">I", len(layer_section)) + layer_section
            + struct.pack(">H", 1) + counts + datas)
    tmp = f"{path}.tmp-{uuid.uuid4().hex[:6]}"
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    try:
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return notes


def _resolution_block():
    """ResolutionInfo (0x03ED): 72 dpi."""
    data = struct.pack(">IHHIHH", 72 << 16, 1, 1, 72 << 16, 1, 1)
    return b"8BIM" + struct.pack(">H", 0x03ED) + b"\0\0" + struct.pack(">I", len(data)) + data


class _R:
    def __init__(self, b):
        self.b, self.i = b, 0

    def take(self, n):
        if self.i + n > len(self.b):
            raise ValueError("the file ends early")
        out = self.b[self.i:self.i + n]
        self.i += n
        return out

    def u(self, fmt):
        return struct.unpack(">" + fmt, self.take(struct.calcsize(">" + fmt)))


def _read_channel(r, w, h, depth=8):
    comp, = r.u("H")
    size = w * h
    if size == 0:
        return np.zeros((h, w), np.uint8)
    if comp == 0:
        return np.frombuffer(r.take(size), np.uint8).reshape(h, w)
    if comp == 1:
        counts = r.u(f"{h}H")
        rows = [unpackbits(r.take(c), w) for c in counts]
        return np.frombuffer(b"".join(rows), np.uint8).reshape(h, w)
    raise ValueError("ZIP-compressed layers are not read here (Photoshop uses them for 16 and 32 bit)")


def read_psd(path):
    with open(path, "rb") as f:
        b = f.read()
    r = _R(b)
    if r.take(4) != b"8BPS":
        raise ValueError("not a Photoshop file")
    ver, = r.u("H")
    if ver != 1:
        raise ValueError("a large-document .psb is not read here")
    r.take(6)
    nch, H, W, depth, mode = r.u("HIIHH")
    if depth != 8 or mode not in (1, 3):
        raise ValueError("only 8-bit RGB or greyscale .psd files are read here")
    r.take(r.u("I")[0])                       # colour mode data
    r.take(r.u("I")[0])                       # image resources
    lm_len, = r.u("I")
    lm_end = r.i + lm_len
    doc = PaintDoc(W, H, os.path.splitext(os.path.basename(path))[0])
    skipped = []
    if lm_len:
        li_len, = r.u("I")
        li_end = r.i + li_len
        if li_len:
            count, = r.u("h")
            count = abs(count)
            recs = []
            for _ in range(count):
                top, left, bottom, right, n = r.u("iiiiH")
                chans = [r.u("hI") for _ in range(n)]
                if r.take(4) != b"8BIM":
                    raise ValueError("a layer record is damaged")
                key = r.take(4)
                opacity, clip, flags, _f = r.u("BBBB")
                ex_len, = r.u("I")
                ex_end = r.i + ex_len
                mlen, = r.u("I")
                mask = None
                if mlen >= 18:
                    mt, ml, mb, mr = r.u("iiii")
                    fill, mflags = r.u("BB")
                    r.take(mlen - 18)
                    mask = {"x": ml, "y": mt, "w": mr - ml, "h": mb - mt, "fill": fill, "enabled": not (mflags & 2)}
                else:
                    r.take(mlen)
                r.take(r.u("I")[0])           # blending ranges
                nlen = r.take(1)[0]
                name = r.take(nlen).decode("latin-1", "replace")
                pad = (4 - (1 + nlen) % 4) % 4
                r.take(pad)
                kinds = set()
                section, section_key = None, None
                while r.i + 12 <= ex_end:
                    sig = r.take(4)
                    if sig not in (b"8BIM", b"8B64"):
                        break
                    k = r.take(4)
                    ln, = r.u("I")
                    data = r.take(ln)
                    if ln % 2 and r.i < ex_end:
                        pass
                    kinds.add(k)
                    if k in (b"lsct", b"lsdk") and len(data) >= 4:
                        section = struct.unpack(">I", data[:4])[0]
                        section_key = data[8:12] if len(data) >= 12 else None
                    if k == b"luni" and len(data) >= 4:
                        n_ch, = struct.unpack(">I", data[:4])
                        name = data[4:4 + 2 * n_ch].decode("utf-16-be", "replace")
                r.i = ex_end
                recs.append({"top": top, "left": left, "w": right - left, "h": bottom - top, "chans": chans,
                             "key": key, "opacity": opacity, "clip": clip, "flags": flags, "mask": mask,
                             "name": name, "kinds": kinds, "section": section, "section_key": section_key})
            for rec in recs:
                planes = {}
                for cid, ln in rec["chans"]:
                    start = r.i
                    if cid == -2 and rec["mask"]:
                        mw, mh = rec["mask"]["w"], rec["mask"]["h"]
                        planes[cid] = _read_channel(r, mw, mh)
                    elif cid in (-1, 0, 1, 2):
                        planes[cid] = _read_channel(r, rec["w"], rec["h"])
                    r.i = start + ln
                rec["planes"] = planes
            r.i = li_end
            adjust_keys = {b"levl", b"curv", b"brit", b"hue2", b"hue ", b"expA", b"nvrt", b"thrs", b"blnc", b"vibA",
                           b"mixr", b"selc", b"grdm", b"phfl", b"blwh", b"post", b"clrL", b"SoCo", b"GdFl", b"PtFl"}
            open_groups = []                  # the ids of the groups being read, the innermost last
            for rec in recs:
                sec = rec["section"]
                if sec == 3:                  # the end of a group (records are bottom first): it starts here
                    open_groups.append(new_id())
                    continue
                if sec in (1, 2):             # the group's own record, after what is in it
                    if not open_groups:
                        continue
                    gid = open_groups.pop()
                    key = rec["section_key"] or rec["key"]
                    blend = "pass_through" if key == M.PSD_PASS else M.PSD_BLEND_BACK.get(key, "normal")
                    G = clean_layer({"id": gid, "name": rec["name"] or "Group", "kind": "group", "blend": blend,
                                     "opacity": rec["opacity"] / 255, "visible": not (rec["flags"] & 2),
                                     "collapsed": sec == 2, **({"parent": open_groups[-1]} if open_groups else {})})
                    if rec["mask"] and -2 in rec["planes"]:
                        G["mask"] = clean_layer({"mask": rec["mask"]})["mask"]
                        doc.masks[gid] = np.ascontiguousarray(rec["planes"][-2])
                    doc._insert(G, None)
                    continue
                if sec is not None:
                    continue
                parent = {"parent": open_groups[-1]} if open_groups else {}
                if rec["kinds"] & adjust_keys:
                    skipped.append(f"{rec['name']!r} (an adjustment or fill layer)")
                    continue
                p = rec["planes"]
                if rec["w"] <= 0 or rec["h"] <= 0:
                    continue
                gray = mode == 1
                r_, g_, b_ = (p.get(0), p.get(0), p.get(0)) if gray else (p.get(0), p.get(1), p.get(2))
                if r_ is None or g_ is None or b_ is None:
                    skipped.append(repr(rec["name"]))
                    continue
                a_ = p.get(-1)
                if a_ is None:
                    a_ = np.full((rec["h"], rec["w"]), 255, np.uint8)
                px = np.stack([r_, g_, b_, a_], axis=2)
                L = doc.add_pixel_layer(px, rec["name"] or "Layer", rec["left"], rec["top"],
                                        opacity=rec["opacity"] / 255, visible=not (rec["flags"] & 2),
                                        blend=M.PSD_BLEND_BACK.get(rec["key"], "normal"), clip=bool(rec["clip"]),
                                        **parent)
                if rec["flags"] & 1:
                    L["lockAlpha"] = True
                if rec["key"] not in M.PSD_BLEND_BACK:
                    doc.notes.append(f"{rec['name']!r}: its blend mode {rec['key'].decode('latin-1')!r} is Normal here")
                if rec["mask"] and -2 in p:
                    L["mask"] = clean_layer({"mask": rec["mask"]})["mask"]
                    doc.masks[L["id"]] = np.ascontiguousarray(p[-2])
        r.i = lm_end
    fix_tree(doc.layers)
    if doc.layers:
        doc.meta["active"] = doc.layers[-1]["id"]
    if skipped:
        doc.notes.append("left out: " + ", ".join(skipped[:12]) + (" ..." if len(skipped) > 12 else ""))
    if not doc.layers:
        comp, = r.u("H")
        size = W * H
        planes = []
        if comp == 1:
            counts = r.u(f"{nch * H}H")
            for ch in range(nch):
                rows = [unpackbits(r.take(c), W) for c in counts[ch * H:(ch + 1) * H]]
                planes.append(np.frombuffer(b"".join(rows), np.uint8).reshape(H, W))
        elif comp == 0:
            for ch in range(nch):
                planes.append(np.frombuffer(r.take(size), np.uint8).reshape(H, W))
        else:
            raise ValueError("the picture in this .psd is compressed in a way not read here")
        if mode == 1:
            planes = [planes[0]] * 3 + planes[1:2]
        rgb = planes[:3]
        a = planes[3] if len(planes) > 3 else np.full((H, W), 255, np.uint8)
        doc.add_pixel_layer(np.stack(rgb + [a], axis=2), "Background")
    return doc


# ── what the page and the agent read ─────────────────────────────────────────

def outline(doc):
    """The document for the agent: layers numbered from 1 at the TOP, as the Layers panel shows them."""
    rows = []
    n = len(doc.layers)
    for i, L in enumerate(reversed(doc.layers)):
        row = {"layer": i + 1, "name": L["name"],
               "kind": {"pixel": "pixel", "adjust": "adjustment", "group": "group"}[L["kind"]],
               "visible": L["visible"], "opacity": round(L["opacity"] * 100, 1)}
        if L.get("parent"):
            P = doc.layer(L["parent"])
            row["in_group"] = P["name"] if P else None
        if L["kind"] == "group":
            row.update(blend=L["blend"], layers_inside=len(subtree(doc, L)) - 1)
        elif L["kind"] == "pixel":
            row.update(blend=L["blend"], x=L["x"], y=L["y"], w=L["w"], h=L["h"])
            if L.get("text"):
                row["text"] = L["text"]["text"][:200]
        else:
            row.update(type=L["adjust"]["type"], params=L["adjust"]["params"])
        if L.get("mask"):
            row["mask"] = "on" if L["mask"]["enabled"] else "off"
            if L["mask"].get("density", 1) != 1:
                row["mask_density"] = round(L["mask"]["density"] * 100)
            if L["mask"].get("feather"):
                row["mask_feather"] = L["mask"]["feather"]
        if L.get("locked"):
            row["locked"] = True
        if L.get("lockAlpha"):
            row["lock_alpha"] = True
        if L.get("style"):
            row["style"] = {k: v for k, v in L["style"].items() if v.get("on")}
        if L.get("filters"):
            row["filters"] = [f["type"] + ("" if f["on"] else " (off)") for f in L["filters"]]
        if L.get("clip"):
            row["clipped"] = True
        if L["id"] == doc.meta.get("active"):
            row["active"] = True
        rows.append(row)
    sel = M.mask_bbox(doc.selection)
    out = {"w": doc.w, "h": doc.h, "name": doc.meta.get("name"), "layer_count": n, "layers": rows,
           "selection": ({"x": sel[0], "y": sel[1], "w": sel[2], "h": sel[3]} if sel else None)}
    if doc.meta.get("paths"):
        out["paths"] = [{"name": q["name"], "points": len(q["pts"]), "closed": q["closed"]} for q in doc.meta["paths"]]
    if doc.meta.get("guides"):
        out["guides"] = [[g["axis"], g["pos"]] for g in doc.meta["guides"]]
    return out
