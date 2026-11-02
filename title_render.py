"""Titles: the fonts of this machine, and a title drawn as the Edit panel draws it.

A title is a clip on a video track whose picture is words (``clip.title`` in the
Edit panel, ``metadata.bepic.title`` in the .otio). Its look is the table below -
the same as ``TITLE_NUM`` ... in ``js/bEpicViewer_editTitles.js`` - and it is laid
out and drawn by the same arithmetic as there (:func:`layout` is ``layoutTitle``,
:func:`render` is ``drawTitle``): glyph by glyph by the font's own linear
advances (no kerning and no ligatures, which the browser and Pillow cannot be
made to do alike), the same line boxes, the same synthetic bold and italic where
a family has no such face. A change to one is a change to the other
(tests/test_edit_titles_parity.py compares the two).

**Fonts** (:func:`fonts`): the families of the font files in the OS's font
folders - Windows' own and the user's, macOS's, the usual Linux ones - read by
Pillow (the file's family and style names), cached for the life of the process.
No program is started for it (the viewer may not start one; ``fc-list`` is not
asked), so on Linux the folders are walked. ``GET /bepic/fonts`` lists them,
``GET /bepic/font_file?id=`` hands the browser ONE of those files by its id
(never a path: nothing outside this list can be asked for), a face of a
collection (.ttc) as a font file of its own.
"""

import hashlib
import logging
import os
import struct
import sys
import threading

log = logging.getLogger(__name__)

# ── the table (bEpicViewer_editTitles.js, kept in step) ───────────────────────

TITLE_NUM = {
    "size": (6.0, 0.5, 40.0), "track": (0.0, -200.0, 1000.0), "line": (1.2, 0.5, 4.0), "op": (1.0, 0.0, 1.0),
    "sw": (7.0, 0.0, 50.0), "shx": (0.0, -100.0, 100.0), "shy": (0.0, -100.0, 100.0), "shb": (0.0, 0.0, 100.0),
    "sho": (0.0, 0.0, 1.0), "bgo": (0.0, 0.0, 1.0), "bgp": (20.0, 0.0, 200.0), "bgr": (0.0, 0.0, 200.0),
    "x": (0.5, 0.0, 1.0), "y": (0.85, 0.0, 1.0), "w": (0.9, 0.02, 1.0), "h": (0.2, 0.02, 1.0),
}
TITLE_COLORS = {"color": "#ffffff", "sc": "#000000", "shc": "#000000", "bgc": "#000000"}
TITLE_FLAGS = ("bold", "italic", "underline", "strike")
TITLE_CHOICES = {"align": ("center", "left", "right", "justify"), "valign": ("middle", "top", "bottom"),
                 "caps": ("none", "upper")}
TITLE_FONT = "Arial"
MAX_TITLE_TEXT = 2000
TITLE_KEYS = {"tsize": "size", "ttrack": "track", "tline": "line", "tsw": "sw"}
DEFAULT_METRICS = {"asc": 0.905, "desc": 0.212}
SYNTH_BOLD = 0.03
SYNTH_ITALIC = 0.2
UNDERLINE = {"at": 0.08, "thick": 0.06}
STRIKE = {"at": -0.28, "thick": 0.06}
FALLBACK_FAMILIES = ("Arial", "Helvetica", "Liberation Sans", "DejaVu Sans", "Segoe UI")
WEB_SAFE = ("Arial", "Helvetica", "Times New Roman", "Georgia", "Courier New", "Verdana", "Trebuchet MS", "Impact")
# Advances are read at this size and scaled: the font's linear advances, not the
# hinted ones Pillow would give at a small size (the browser's are linear).
_BIG = 2048


def _is_color(v):
    s = str(v or "")
    return len(s) == 7 and s[0] == "#" and all(c in "0123456789abcdefABCDEF" for c in s[1:])


def clean_title(given):
    """*given* held to what a title may be, every part of it present (cleanTitle in the JS)."""
    g = given if isinstance(given, dict) else {}
    text = g.get("text")
    out = {"text": ("Title" if text is None else str(text))[:MAX_TITLE_TEXT]}
    font = "".join(ch for ch in str(g.get("font") or "") if ord(ch) >= 32 and ch not in '"\\').strip()[:120]
    out["font"] = font or TITLE_FONT
    for key, (default, low, high) in TITLE_NUM.items():
        v = g.get(key)
        try:
            v = float(v) if v is not None and v != "" and not isinstance(v, bool) else None
        except (TypeError, ValueError):
            v = None
        out[key] = default if v is None or v != v or v in (float("inf"), float("-inf")) \
            else round(max(low, min(high, v)), 5)
    for key, default in TITLE_COLORS.items():
        out[key] = str(g[key]).lower() if _is_color(g.get(key)) else default
    for key in TITLE_FLAGS:
        out[key] = g.get(key) is True
    for key, choices in TITLE_CHOICES.items():
        out[key] = g.get(key) if g.get(key) in choices else choices[0]
    return out


def title_from_text(t):
    """A title made from a text of an older cut (a marker): it looks as the text did."""
    t = t if isinstance(t, dict) else {}
    return clean_title({k: t.get(k) for k in ("text", "size", "x", "y", "color")})


def title_at(title, keys, u):
    """*title* with its keyed numbers (``fx.keys`` tsize / ttrack / tline / tsw) at clip time *u*."""
    from .timeline_render import key_value
    look = clean_title(title)
    for k, p in TITLE_KEYS.items():
        items = (keys or {}).get(k) if isinstance(keys, dict) else None
        if items:
            low, high = TITLE_NUM[p][1:]
            look[p] = max(low, min(high, key_value(items, u)))
    return look


def words(look):
    s = str(look.get("text") or "").replace("\r", "")
    return s.upper() if look.get("caps") == "upper" else s


# ── fonts ─────────────────────────────────────────────────────────────────────

_FONT_EXTS = (".ttf", ".otf", ".ttc", ".otc")
_PLAIN = {"regular", "normal", "book", "roman", "plain", "standard"}
_LOCK = threading.Lock()
_FONTS = None          # [{"family", "faces": {kind: {"id", "path", "index", "asc", "desc"}}}]
_BY_ID = {}


def font_dirs():
    """The folders this OS keeps fonts in (Windows': its own and the user's)."""
    home = os.path.expanduser("~")
    if sys.platform.startswith("win"):
        windir = os.environ.get("WINDIR") or os.environ.get("SystemRoot") or r"C:\Windows"
        local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        return [os.path.join(windir, "Fonts"), os.path.join(local, "Microsoft", "Windows", "Fonts")]
    if sys.platform == "darwin":
        return ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts",
                os.path.join(home, "Library", "Fonts")]
    return ["/usr/share/fonts", "/usr/local/share/fonts", os.path.join(home, ".local", "share", "fonts"),
            os.path.join(home, ".fonts")]


def _files(dirs):
    seen = set()
    for root in dirs:
        if not os.path.isdir(root):
            continue
        for here, subdirs, names in os.walk(root):
            subdirs[:] = [d for d in subdirs if not d.startswith(".")][:200]
            for name in names:
                if name.lower().endswith(_FONT_EXTS):
                    path = os.path.join(here, name)
                    key = os.path.normcase(path)
                    if key not in seen:
                        seen.add(key)
                        yield path
                        if len(seen) > 5000:
                            return


def _kind(style):
    """``(kind, extra words)`` of a style name: "Bold Italic" -> ("bolditalic", ""), "Semibold" -> ("regular", "Semibold")."""
    parts = str(style or "").replace("-", " ").split()
    bold = italic = False
    rest = []
    for w in parts:
        lw = w.lower()
        if lw == "bold":
            bold = True
        elif lw in ("italic", "oblique"):
            italic = True
        elif lw not in _PLAIN:
            rest.append(w)
    return ("bold" if bold else "") + ("italic" if italic else "") or "regular", " ".join(rest)


def scan(dirs=None):
    """Every family of the font files in *dirs* (the OS's folders): ``[{"family", "faces"}]``, sorted."""
    from PIL import ImageFont
    families = {}
    for path in _files(dirs if dirs is not None else font_dirs()):
        collection = path.lower().endswith((".ttc", ".otc"))
        for index in range(16 if collection else 1):
            try:
                font = ImageFont.truetype(path, _BIG, index=index)
            except Exception:  # noqa: BLE001 - not a font Pillow reads, or past a collection's last face
                break
            try:
                family, style = font.getname()
                asc, desc = font.getmetrics()
            except Exception:  # noqa: BLE001
                continue
            if not family:
                continue
            kind, extra = _kind(style)
            name = (str(family) + (" " + extra if extra else "")).strip()
            fid = hashlib.sha1(f"{os.path.normcase(path)}|{index}".encode("utf-8")).hexdigest()[:16]
            face = {"id": fid, "path": path, "index": index, "asc": round(asc / _BIG, 5), "desc": round(desc / _BIG, 5)}
            fam = families.setdefault(name.lower(), {"family": name, "faces": {}})
            fam["faces"].setdefault(kind, face)
    return sorted(families.values(), key=lambda f: f["family"].lower())


def fonts(refresh=False):
    """The machine's families (:func:`scan` of :func:`font_dirs`), read once and kept."""
    global _FONTS, _BY_ID
    with _LOCK:
        if _FONTS is None or refresh:
            try:
                _FONTS = scan()
            except Exception as exc:  # noqa: BLE001 - no fonts is a list of none, not a failure
                log.warning("bEpic: the fonts could not be read: %s", exc)
                _FONTS = []
            _BY_ID = {face["id"]: face for f in _FONTS for face in f["faces"].values()}
        return _FONTS


def font_list():
    """What ``/bepic/fonts`` answers: the families, each face with its id and metrics - no paths."""
    out = []
    for f in fonts():
        faces = {}
        for kind, face in f["faces"].items():
            faces[kind] = {"id": face["id"], "asc": face["asc"], "desc": face["desc"],
                           "url": "/bepic/font_file?id=" + face["id"], "file": os.path.basename(face["path"])}
        out.append({"family": f["family"], "faces": faces})
    return {"fonts": out, "fallback": list(FALLBACK_FAMILIES)}


def face_by_id(fid):
    fonts()
    return _BY_ID.get(str(fid or ""))


def face_bytes(face):
    """The bytes of a face as a font file of its own (one face of a collection taken out of it)."""
    with open(face["path"], "rb") as fh:
        data = fh.read()
    if data[:4] != b"ttcf":
        return data
    return _ttc_face(data, int(face["index"]))


def _ttc_face(data, index):
    """Face *index* of a TrueType collection as a plain sfnt: its table directory and its tables."""
    count = struct.unpack(">I", data[8:12])[0]
    if not 0 <= index < count:
        raise ValueError("no such face in the collection")
    at = struct.unpack(">I", data[12 + 4 * index:16 + 4 * index])[0]
    version, tables = struct.unpack(">IH", data[at:at + 6])
    entries = []
    for k in range(tables):
        tag, check, off, length = struct.unpack(">4sIII", data[at + 12 + 16 * k:at + 28 + 16 * k])
        entries.append((tag, check, off, length))
    head = 12 + 16 * tables
    out = bytearray(data[at:at + 12])
    body = bytearray()
    for tag, check, off, length in entries:
        out += struct.pack(">4sIII", tag, check, head + len(body), length)
        body += data[off:off + length]
        body += b"\0" * ((-len(body)) % 4)
    return bytes(out + body)


def resolve_face(families, family, bold, italic):
    """The face a title is drawn with (resolveFace in the JS, the same choice):
    ``{"family", "face", "bold", "italic" (synthetic ones still to do), "missing"}``."""
    families = families or []
    by = {f["family"].lower(): f for f in families}
    fam = by.get(str(family or "").lower())
    missing = fam is None
    if fam is None:
        fam = next((by[n.lower()] for n in FALLBACK_FAMILIES if n.lower() in by), None)
    if fam is None and families:
        fam = families[0]
    if fam is None:
        return {"family": family or TITLE_FONT, "face": None, "bold": bool(bold), "italic": bool(italic),
                "missing": True}
    faces = fam["faces"]
    want = ("bold" if bold else "") + ("italic" if italic else "") or "regular"
    if want in faces:
        return {"family": fam["family"], "face": faces[want], "bold": False, "italic": False, "missing": missing}
    tries = ([("bold", False, True), ("italic", True, False), ("regular", True, True)] if bold and italic
             else [("regular", True, False)] if bold else [("regular", False, True)] if italic else [])
    for kind, b, i in tries:
        if kind in faces:
            return {"family": fam["family"], "face": faces[kind], "bold": b, "italic": i, "missing": missing}
    face = next((faces[k] for k in ("regular", "bold", "italic", "bolditalic") if k in faces), None)
    return {"family": fam["family"], "face": face, "bold": bool(bold), "italic": bool(italic), "missing": missing}


def missing_note(look, got):
    """What to say when a title's family is not on this machine ("" when it is)."""
    if not got.get("missing"):
        return ""
    return f"font {look['font']!r} is not on this machine: drawn with {got['family']}"


# ── layout (layoutTitle) ──────────────────────────────────────────────────────

def layout(look, W, H, measure, metrics=None, synth=None):
    """Where every glyph of a title goes in a ``W x H`` frame - layoutTitle in the JS."""
    L = clean_title(look)
    synth = synth or {}
    px = max(1.0, H * L["size"] / 100.0)
    trk = L["track"] / 1000.0 * px
    box_w, box_h = L["w"] * W, L["h"] * H
    box_l, box_t = L["x"] * W - box_w / 2.0, L["y"] * H - box_h / 2.0
    line_h = L["line"] * px
    adv = {}

    def a(ch):
        if ch not in adv:
            adv[ch] = float(measure(ch) or 0.0)
        return adv[ch]

    def width(s):
        return sum(a(ch) + trk for ch in s) - trk if s else 0.0

    lines = []
    for para in words(L).split("\n"):
        ws = [w for w in para.split(" ") if w]
        if not ws:
            lines.append(("", True))
            continue
        line = ""
        for word in ws:
            cand = line + " " + word if line else word
            if line and width(cand) > box_w + 1e-6:
                lines.append((line, False))
                line = word
            else:
                line = cand
        lines.append((line, True))
    block_h = len(lines) * line_h
    top = box_t if L["valign"] == "top" else box_t + box_h - block_h if L["valign"] == "bottom" \
        else box_t + (box_h - block_h) / 2.0
    m = metrics or DEFAULT_METRICS
    asc, desc = float(m.get("asc") or DEFAULT_METRICS["asc"]), float(m.get("desc") or DEFAULT_METRICS["desc"])
    out = []
    bx0, bx1 = float("inf"), float("-inf")
    for k, (text, last) in enumerate(lines):
        lw = width(text)
        spaces = text.count(" ")
        stretch = (box_w - lw) / spaces if L["align"] == "justify" and not last and spaces > 0 else 0.0
        x0 = box_l + box_w - lw if L["align"] == "right" else box_l + (box_w - lw) / 2.0 \
            if L["align"] == "center" else box_l
        line_top = top + k * line_h
        base = line_top + (line_h - (asc + desc) * px) / 2.0 + asc * px
        glyphs = []
        x = x0
        for ch in text:
            glyphs.append((ch, x))
            x += a(ch) + trk + (stretch if ch == " " else 0.0)
        x1 = x0 + lw + stretch * spaces
        if text:
            bx0, bx1 = min(bx0, x0), max(bx1, x1)
        out.append({"text": text, "x0": x0, "x1": x1, "base": base, "top": line_top, "glyphs": glyphs})
    if not bx1 > bx0:
        bx0 = bx1 = L["x"] * W
    pad = L["bgp"] / 100.0 * px
    box = None
    if L["bgo"] > 0:
        box = {"x0": bx0 - pad, "y0": top - pad, "x1": bx1 + pad, "y1": top + block_h + pad,
               "r": min(L["bgr"] / 100.0 * px, (bx1 - bx0 + 2 * pad) / 2.0, (block_h + 2 * pad) / 2.0)}
    under = []
    for ln in out:
        if not ln["text"]:
            continue
        if L["underline"]:
            under.append({"x0": ln["x0"], "x1": ln["x1"], "y": ln["base"] + UNDERLINE["at"] * px,
                          "h": max(1.0, UNDERLINE["thick"] * px)})
        if L["strike"]:
            t = max(1.0, STRIKE["thick"] * px)
            under.append({"x0": ln["x0"], "x1": ln["x1"], "y": ln["base"] + STRIKE["at"] * px - t / 2.0, "h": t})
    return {"px": px, "look": L, "lines": out, "box": box, "under": under,
            "block": {"x0": bx0, "y0": top, "x1": bx1, "y1": top + block_h},
            "stroke_px": max(1, int(round(L["sw"] / 100.0 * px))) if L["sw"] > 0 else 0,
            "bold_px": max(1, int(round(SYNTH_BOLD * px))) if synth.get("bold") else 0,
            "italic": bool(synth.get("italic")),
            "shadow": {"dx": L["shx"] / 100.0 * px, "dy": L["shy"] / 100.0 * px, "blur": L["shb"] / 100.0 * px}
            if L["sho"] > 0 else None}


# ── drawing (drawTitle) ───────────────────────────────────────────────────────

_FACE_CACHE = {}


def _pil_font(face, px):
    from PIL import ImageFont
    key = (face["path"] if face else "", face["index"] if face else 0, round(px, 3))
    if key not in _FACE_CACHE:
        if len(_FACE_CACHE) > 64:
            _FACE_CACHE.clear()
        if face:
            _FACE_CACHE[key] = ImageFont.truetype(face["path"], px, index=face["index"])
        else:
            _FACE_CACHE[key] = ImageFont.load_default(size=px)
    return _FACE_CACHE[key]


def _rgb(hexcolor):
    n = int(str(hexcolor)[1:], 16)
    return (n >> 16) & 255, (n >> 8) & 255, n & 255


def _fill_rect(im, x0, y0, x1, y1, rgb):
    """A rectangle of fractional edges filled on the RGBA image *im*, its edges covering their pixels
    by how much of them they cover (as the browser's fillRect does)."""
    import numpy as np
    from PIL import Image
    W, H = im.size

    def cover(a, b, n):
        edges = np.arange(n + 1, dtype=np.float32)
        return np.clip(np.minimum(edges[1:], b) - np.maximum(edges[:-1], a), 0.0, 1.0)

    mask = np.outer(cover(y0, y1, H), cover(x0, x1, W))
    if not mask.any():
        return
    layer = Image.new("RGBA", (W, H), tuple(rgb[:3]) + (0,))
    layer.putalpha(Image.fromarray((mask * 255 + 0.5).astype(np.uint8), "L"))
    im.alpha_composite(layer)


def render(look, W, H, families=None):
    """The title *look* drawn on a transparent ``W x H`` frame: ``(rgba uint8 array, note)``
    - *note* says when its font was not there ("" when it was)."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    L = clean_title(look)
    got = resolve_face(fonts() if families is None else families, L["font"], L["bold"], L["italic"])
    face = got["face"]
    big = _pil_font(face, _BIG)
    metrics = {"asc": face["asc"], "desc": face["desc"]} if face else DEFAULT_METRICS
    lay = layout(L, W, H, lambda ch: big.getlength(ch) * (max(1.0, H * L["size"] / 100.0)) / _BIG, metrics,
                 {"bold": got["bold"], "italic": got["italic"]})
    font = _pil_font(face, lay["px"])
    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if lay["box"]:
        b = lay["box"]
        ImageDraw.Draw(frame).rounded_rectangle([b["x0"], b["y0"], b["x1"], b["y1"]], radius=max(0.0, b["r"]),
                                                fill=_rgb(L["bgc"]) + (int(round(L["bgo"] * 255)),))
    text = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sc, fc = _rgb(L["sc"]) + (255,), _rgb(L["color"]) + (255,)
    s, bp = lay["stroke_px"], lay["bold_px"]

    def each(fn):
        for ln in lay["lines"]:
            if not ln["glyphs"]:
                continue
            if lay["italic"]:
                # Synthetic italic: the line leans about its baseline (drawn upright, then sheared).
                layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                fn(ImageDraw.Draw(layer), ln)
                k = SYNTH_ITALIC
                layer = layer.transform((W, H), Image.AFFINE, (1, k, -k * ln["base"], 0, 1, 0), resample=Image.BILINEAR)
                text.alpha_composite(layer)
            else:
                fn(ImageDraw.Draw(text), ln)

    def glyphs(draw, ln, fill, width, edge):
        for ch, x in ln["glyphs"]:
            if ch != " ":
                draw.text((x, ln["base"]), ch, font=font, anchor="ls", fill=fill, stroke_width=width, stroke_fill=edge)

    if s > 0:
        each(lambda d, ln: glyphs(d, ln, sc, s + bp, sc))
        for u in lay["under"]:
            _fill_rect(text, u["x0"] - s, u["y"] - s, u["x1"] + s, u["y"] + u["h"] + s, sc)
    each(lambda d, ln: glyphs(d, ln, fc, bp, fc if bp else None))
    for u in lay["under"]:
        _fill_rect(text, u["x0"], u["y"], u["x1"], u["y"] + u["h"], fc)
    alpha = np.asarray(text.getchannel("A"), dtype=np.float32)
    if lay["shadow"]:
        sh = lay["shadow"]
        a = Image.fromarray(np.clip(alpha * (L["sho"] * L["op"]) + 0.5, 0, 255).astype(np.uint8), "L")
        if sh["blur"] > 0:
            a = a.filter(ImageFilter.GaussianBlur(sh["blur"]))
        a = a.transform((W, H), Image.AFFINE, (1, 0, -sh["dx"], 0, 1, -sh["dy"]), resample=Image.BILINEAR)
        shadow = Image.new("RGBA", (W, H), _rgb(L["shc"]) + (0,))
        shadow.putalpha(a)
        frame.alpha_composite(shadow)
    if L["op"] < 1:
        text.putalpha(Image.fromarray(np.clip(alpha * L["op"] + 0.5, 0, 255).astype(np.uint8), "L"))
    frame.alpha_composite(text)
    return np.asarray(frame), missing_note(L, got)
