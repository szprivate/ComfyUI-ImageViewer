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
``stack.xml`` is read (groups flattened, their order kept).

**The .psd** (8-bit RGB, written by :func:`write_psd`, read by :func:`read_psd`): pixel layers
with their place, opacity, blend mode, visibility and mask (RLE), the merged picture, and Unicode
names. Photoshop has adjustment layers of its own, but not ours with our numbers: an adjustment
layer is BAKED on export - what is under it and it become one pixel layer, "<name> (merged)",
and the answer says so. Reading a .psd takes its pixel layers (raw or RLE); its adjustment layers,
group folders and clipping are named as left out.
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

    def _insert(self, L, index):
        if len(self.layers) >= MAX_LAYERS:
            raise ValueError(f"at most {MAX_LAYERS} layers")
        if index is None:
            self.layers.append(L)
        else:
            self.layers.insert(max(0, min(len(self.layers), int(index))), L)
        self.meta["active"] = L["id"]

    def remove(self, lid):
        self.meta["layers"] = [L for L in self.layers if L["id"] != lid]
        self.px.pop(lid, None)
        self.masks.pop(lid, None)
        if self.meta.get("active") == lid:
            self.meta["active"] = self.layers[-1]["id"] if self.layers else None


def clean_layer(L):
    """A layer's description held to what it may be (``paintData.cleanLayer`` is the same)."""
    kind = "adjust" if L.get("kind") == "adjust" else "pixel"
    out = {"id": str(L.get("id") or new_id())[:40], "name": str(L.get("name") or "Layer")[:120], "kind": kind,
           "visible": L.get("visible") is not False, "opacity": M._num(L.get("opacity"), 1.0, 0, 1),
           "blend": L.get("blend") if L.get("blend") in M.BLEND_MODES else "normal",
           "locked": bool(L.get("locked"))}
    if kind == "pixel":
        out.update(x=int(M._num(L.get("x"), 0)), y=int(M._num(L.get("y"), 0)),
                   w=int(M._num(L.get("w"), 0, 0, MAX_SIDE)), h=int(M._num(L.get("h"), 0, 0, MAX_SIDE)))
        if isinstance(L.get("text"), dict):
            out["text"] = clean_text(L["text"])
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
    return out


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
           "layers": [clean_layer(L) for L in layers if isinstance(L, dict)]}
    ids = [L["id"] for L in out["layers"]]
    if len(set(ids)) != len(ids):
        raise ValueError("two layers have the same id")
    out["active"] = meta.get("active") if meta.get("active") in ids else (ids[-1] if ids else None)
    return out


# ── the picture as it looks ──────────────────────────────────────────────────

def mask_values(L, mask, x0, y0, x1, y1):
    """The layer's mask over the canvas rectangle x0..x1, y0..y1, as floats 0..1 (1 with none)."""
    m = L.get("mask")
    if not m or not m.get("enabled") or mask is None:
        return np.ones((y1 - y0, x1 - x0), dtype=np.float64)
    out = np.full((y1 - y0, x1 - x0), m.get("fill", 0) / 255.0, dtype=np.float64)
    mx, my = m["x"], m["y"]
    mh, mw = mask.shape[:2]
    ax0, ay0 = max(x0, mx), max(y0, my)
    ax1, ay1 = min(x1, mx + mw), min(y1, my + mh)
    if ax1 > ax0 and ay1 > ay0:
        out[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = mask[ay0 - my:ay1 - my, ax0 - mx:ax1 - mx] / 255.0
    return out


def composite(doc, upto=None, only=None, hidden_ok=False):
    """The document as it looks: ``uint8 (H, W, 4)``. *upto*: the layers up to and with this id;
    *only*: just these ids."""
    W, H = doc.w, doc.h
    out = np.zeros((H, W, 4), dtype=np.uint8)
    for L in doc.layers:
        if only is not None and L["id"] not in only:
            continue
        if L.get("visible") or hidden_ok:
            out = lay(out, doc, L)
        if upto is not None and L["id"] == upto:
            break
    return out


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
    for L in reversed(meta["layers"]):
        if L["kind"] != "pixel":
            continue
        src = f"data/{L['id']}.png"
        ET.SubElement(stack, "layer", {
            "name": L["name"], "src": src, "x": str(L["x"]), "y": str(L["y"]), "opacity": f"{L['opacity']:.4f}",
            "visibility": "visible" if L["visible"] else "hidden", "composite-op": M.ORA_BLEND[L["blend"]],
            **({"edit-locked": "true"} if L.get("locked") else {})})
        px = doc.px.get(L["id"])
        if px is None:
            px = np.zeros((max(1, L["h"]), max(1, L["w"]), 4), dtype=np.uint8)
        files.append((src, png_bytes(px)))
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


def _ora_layers(stack, z, doc, x0=0, y0=0):
    """The layers of a stack.xml stack (top first), bottom first into *doc*; groups flattened."""
    for el in reversed(list(stack)):
        if el.tag == "stack":
            if el.get("visibility") == "hidden":
                doc.notes.append(f"the hidden group {el.get('name') or ''!r} was opened with its layers shown as they are")
            _ora_layers(el, z, doc, x0 + int(float(el.get("x") or 0)), y0 + int(float(el.get("y") or 0)))
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
                                blend=blend, locked=el.get("edit-locked") == "true")


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
    become one pixel layer. ``(layers [(meta, pixels, mask)], notes)``."""
    out, notes = [], []
    below = []                     # the layers laid so far, as (L)
    for L in doc.layers:
        if L["kind"] == "adjust":
            if not L.get("visible"):
                notes.append(f"the hidden adjustment layer {L['name']!r} was left out")
                continue
            merged = composite(doc, upto=L["id"])
            nm = f"{L['name']} (merged)"
            out = [(clean_layer({"id": L["id"], "name": nm, "x": 0, "y": 0, "w": doc.w, "h": doc.h}), merged, None)]
            label = M.ADJUST_LABELS[L["adjust"]["type"]]
            what = L["name"] if L["name"] == label else f"{L['name']} ({label})"
            notes.append(f"{what} was merged with the layers under it "
                         f"into one layer, {nm!r}: Photoshop's own adjustment layers do not work out the same")
            below = []
            continue
        px = doc.px.get(L["id"])
        if px is None:
            continue
        out.append((L, px, doc.masks.get(L["id"]) if L.get("mask") else None))
        below.append(L)
    return out, notes


def write_psd(path, doc):
    """A layered .psd (8-bit RGB). Returns the notes (what was baked)."""
    layers, notes = baked_for_psd(doc)
    W, H = doc.w, doc.h
    recs, chans = [], []
    for L, px, mask in layers:
        h, w = px.shape[:2]
        x, y = int(L.get("x", 0)), int(L.get("y", 0))
        channel_ids = [-1, 0, 1, 2]
        planes = [px[..., 3], px[..., 0], px[..., 1], px[..., 2]]
        m = L.get("mask") if mask is not None else None
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
        flags = 0 if L.get("visible") else 2
        if L.get("locked"):
            flags |= 1                  # transparency protected: the nearest Photoshop has
        if m:
            mh, mw = mask.shape[:2]
            mflags = 0 if m.get("enabled") else 2
            maskdata = struct.pack(">iiiiBBH", m["y"], m["x"], m["y"] + mh, m["x"] + mw, m.get("fill", 0), mflags, 0)
        else:
            maskdata = b""
        extra = (struct.pack(">I", len(maskdata)) + maskdata + struct.pack(">I", 0) + _pascal(L["name"])
                 + _unicode_block(L["name"]))
        rec = (struct.pack(">iiiiH", y, x, y + h, x + w, len(channel_ids)) + cinfo + b"8BIM"
               + M.PSD_BLEND.get(L.get("blend", "normal"), b"norm")
               + struct.pack(">BBBB", int(round(float(L.get("opacity", 1)) * 255)), 0, flags, 0)
               + struct.pack(">I", len(extra)) + extra)
        recs.append(rec)
        chans.append(cdata)
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
                    if k == b"luni" and len(data) >= 4:
                        n_ch, = struct.unpack(">I", data[:4])
                        name = data[4:4 + 2 * n_ch].decode("utf-16-be", "replace")
                r.i = ex_end
                recs.append({"top": top, "left": left, "w": right - left, "h": bottom - top, "chans": chans,
                             "key": key, "opacity": opacity, "clip": clip, "flags": flags, "mask": mask,
                             "name": name, "kinds": kinds})
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
            for rec in recs:
                if b"lsct" in rec["kinds"] or b"lsdk" in rec["kinds"]:
                    continue                  # a group's folder or its end: the layers are kept in order
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
                if rec["clip"]:
                    doc.notes.append(f"{rec['name']!r} was clipped to the layer under it in Photoshop; here it is not")
                L = doc.add_pixel_layer(px, rec["name"] or "Layer", rec["left"], rec["top"],
                                        opacity=rec["opacity"] / 255, visible=not (rec["flags"] & 2),
                                        blend=M.PSD_BLEND_BACK.get(rec["key"], "normal"))
                if rec["key"] not in M.PSD_BLEND_BACK:
                    doc.notes.append(f"{rec['name']!r}: its blend mode {rec['key'].decode('latin-1')!r} is Normal here")
                if rec["mask"] and -2 in p:
                    L["mask"] = clean_layer({"mask": rec["mask"]})["mask"]
                    doc.masks[L["id"]] = np.ascontiguousarray(p[-2])
        r.i = lm_end
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
        row = {"layer": i + 1, "name": L["name"], "kind": L["kind"] if L["kind"] == "pixel" else "adjustment",
               "visible": L["visible"], "opacity": round(L["opacity"] * 100, 1)}
        if L["kind"] == "pixel":
            row.update(blend=L["blend"], x=L["x"], y=L["y"], w=L["w"], h=L["h"])
            if L.get("text"):
                row["text"] = L["text"]["text"][:200]
        else:
            row.update(type=L["adjust"]["type"], params=L["adjust"]["params"])
        if L.get("mask"):
            row["mask"] = "on" if L["mask"]["enabled"] else "off"
        if L.get("locked"):
            row["locked"] = True
        if L["id"] == doc.meta.get("active"):
            row["active"] = True
        rows.append(row)
    sel = M.mask_bbox(doc.selection)
    out = {"w": doc.w, "h": doc.h, "name": doc.meta.get("name"), "layer_count": n, "layers": rows,
           "selection": ({"x": sel[0], "y": sel[1], "w": sel[2], "h": sel[3]} if sel else None)}
    return out
