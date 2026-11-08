"""Changes to a Paint document made by name: what the agent's ``edit_image`` sends (``POST
/imageviewer/paint/doc``), and what the page asks the server to do where the server does it better (the
fill from the surroundings, a resize of every layer).

``apply_ops(doc, ops, read_image)`` changes *doc* in place, all or none (the caller works on a copy
read from the file and writes it only when every op went through), and returns what was done, one
line per op. Layers are named as the Layers panel shows them: a number from 1 at the TOP, a name,
or "active" - a group counts as a row, and the rows inside it follow it. No aiohttp here.
"""
from __future__ import annotations

import copy
import re

import numpy as np

from . import paint_io as P
from . import paint_math as M

MAX_OPS = 60
OPS = ("add_layer", "add_adjustment", "set_layer", "remove_layer", "duplicate_layer", "move_layer", "merge_down",
       "flatten", "select", "mask", "fill", "clear", "heal", "filter", "crop", "canvas_size", "resize",
       "transform", "add_text", "group", "ungroup", "merge_group")
ANCHORS = {"top_left": (0, 0), "top": (0.5, 0), "top_right": (1, 0), "left": (0, 0.5), "center": (0.5, 0.5),
           "right": (1, 0.5), "bottom_left": (0, 1), "bottom": (0.5, 1), "bottom_right": (1, 1)}


class OpError(ValueError):
    pass


def _color(c, default=(0, 0, 0, 255)):
    if c is None:
        return default
    if isinstance(c, (list, tuple)) and len(c) in (3, 4):
        v = [int(M._num(x, 0, 0, 255)) for x in c]
        return tuple(v + [255]) if len(v) == 3 else tuple(v)
    s = str(c).strip()
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?", s)
    if m:
        h = m.group(1)
        a = int(m.group(2), 16) if m.group(2) else 255
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)
    names = {"white": (255, 255, 255, 255), "black": (0, 0, 0, 255), "transparent": (0, 0, 0, 0),
             "red": (255, 0, 0, 255), "green": (0, 255, 0, 255), "blue": (0, 0, 255, 255), "grey": (128, 128, 128, 255),
             "gray": (128, 128, 128, 255)}
    if s.lower() in names:
        return names[s.lower()]
    raise OpError(f"{c!r} is not a colour (#rrggbb, or [r, g, b])")


def find_layer(doc, ref, kind=None):
    """A layer by its number from the top (1 = top), its name, its id or "active"."""
    layers = doc.layers
    if not layers:
        raise OpError("the document has no layers")
    L = None
    if ref in (None, "", "active"):
        L = doc.layer(doc.meta.get("active")) or layers[-1]
    elif isinstance(ref, (int, float)) and not isinstance(ref, bool):
        n = int(ref)
        if not 1 <= n <= len(layers):
            raise OpError(f"there is no layer {n} (1 is the top, {len(layers)} the bottom)")
        L = layers[len(layers) - n]
    else:
        s = str(ref).strip()
        if s.isdigit():
            return find_layer(doc, int(s), kind)
        L = doc.layer(s) or next((x for x in reversed(layers) if x["name"] == s), None) \
            or next((x for x in reversed(layers) if x["name"].lower() == s.lower()), None)
        if L is None:
            raise OpError(f"no layer is called {s!r}")
    if kind and L["kind"] != kind:
        what = {"adjust": "an adjustment layer", "group": "a group", "pixel": "a pixel layer"}[L["kind"]]
        raise OpError(f"{L['name']!r} is {what}")
    return L


def _unlocked(L):
    if L.get("locked"):
        raise OpError(f"{L['name']!r} is locked in the Layers panel - ask the user to unlock it")
    return L


def _index_of(doc, L):
    return next(i for i, x in enumerate(doc.layers) if x["id"] == L["id"])


def _place_index(doc, op):
    """Where a new layer goes (an index from the bottom): above / below a layer, at the top of a group
    (``into``), or at the top. Its group is put on the op as ``_parent`` (see :func:`_placed`)."""
    op.pop("_parent", None)
    if op.get("into") not in (None, ""):
        G = find_layer(doc, op["into"], "group")
        op["_parent"] = G["id"]
        return _index_of(doc, G)
    if op.get("below") not in (None, ""):
        R = find_layer(doc, op["below"])
        op["_parent"] = R.get("parent")
        return _index_of(doc, P.subtree(doc, R)[0])
    if op.get("above") not in (None, ""):
        R = find_layer(doc, op["above"])
        op["_parent"] = R.get("parent")
        return _index_of(doc, R) + 1
    return len(doc.layers)


def _placed(L, op):
    """The new layer *L* into the group :func:`_place_index` chose."""
    if op.get("_parent"):
        L["parent"] = op["_parent"]
    return L


def _resize(px, w, h, method="lanczos"):
    from PIL import Image
    im = Image.fromarray(px, "RGBA" if px.ndim == 3 else "L")
    resample = {"nearest": Image.NEAREST, "bilinear": Image.BILINEAR, "bicubic": Image.BICUBIC}.get(method, Image.LANCZOS)
    if px.ndim == 3:
        # Premultiplied while resampled, or a see-through edge goes dark.
        f = px.astype(np.float64) / 255
        pm = np.concatenate([f[..., :3] * f[..., 3:4], f[..., 3:4]], axis=2)
        chans = [np.asarray(Image.fromarray((pm[..., c] * 255).astype(np.float32), "F").resize((w, h), resample))
                 for c in range(4)]
        a = np.clip(chans[3], 0, 255)
        rgb = [np.where(a > 0, np.clip(chans[c], 0, 255) / np.maximum(a, 1e-9), 0) for c in range(3)]
        return np.stack([M.q8(rgb[0]), M.q8(rgb[1]), M.q8(rgb[2]), M.q8(a / 255)], axis=2)
    return np.asarray(im.resize((w, h), resample), dtype=np.uint8)


def _selection(doc, need=True):
    if doc.selection is None or not doc.selection.any():
        if need:
            raise OpError("nothing is selected - select first ({'op': 'select', ...})")
        return None
    return doc.selection


def _layer_area(doc, L, mask):
    """*mask* (canvas-sized) cut to the pixel layer's rectangle: (h, w) floats 0..1."""
    h, w = doc.px[L["id"]].shape[:2]
    out = np.zeros((h, w), dtype=np.float64)
    x, y = L["x"], L["y"]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(doc.w, x + w), min(doc.h, y + h)
    if x1 > x0 and y1 > y0:
        out[y0 - y:y1 - y, x0 - x:x1 - x] = mask[y0:y1, x0:x1] / 255.0
    return out


def _canvas_layer(doc, L):
    """Grow a pixel layer to cover the canvas (keeps what lies outside it)."""
    px = doc.px[L["id"]]
    h, w = px.shape[:2]
    x0, y0 = min(0, L["x"]), min(0, L["y"])
    x1, y1 = max(doc.w, L["x"] + w), max(doc.h, L["y"] + h)
    if (x0, y0, x1 - x0, y1 - y0) == (L["x"], L["y"], w, h):
        return px
    big = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
    big[L["y"] - y0:L["y"] - y0 + h, L["x"] - x0:L["x"] - x0 + w] = px
    doc.px[L["id"]] = big
    L.update(x=x0, y=y0, w=x1 - x0, h=y1 - y0)
    return big


def _mix(px, color_px, t):
    """*color_px* laid over *px* with coverage *t* (h, w): a fill."""
    return M.blend_over(px, color_px, t, "normal")


def _read_layer_image(read_image, op, key="file"):
    f = op.get(key)
    if not isinstance(f, str) or not f.strip():
        raise OpError(f"'{key}' (a picture's path) is needed")
    try:
        return read_image(f.strip())
    except OpError:
        raise
    except Exception as e:  # noqa: BLE001
        raise OpError(f"{f} could not be read ({e})")


def _read_mask(read_image, op, doc, key="mask_file"):
    px = _read_layer_image(read_image, op, key)
    # White = in. A picture with see-through parts: its alpha; else its brightness.
    if px[..., 3].min() < 255:
        m = px[..., 3]
    else:
        m = M.q8((0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]) / 255)
    if m.shape != (doc.h, doc.w):
        m = _resize(m, doc.w, doc.h, "bilinear")
    return m


def apply_ops(doc, ops, read_image, fonts=None):
    """Every op of *ops* on *doc* (in place; call it on a copy). Returns the lines said."""
    if not isinstance(ops, list):
        raise OpError("'ops' is a list of changes")
    if len(ops) > MAX_OPS:
        raise OpError(f"at most {MAX_OPS} changes at once")
    said = []
    for n, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise OpError(f"change {n} is not an object")
        name = str(op.get("op") or "").strip().lower()
        if name not in OPS:
            raise OpError(f"change {n}: unknown op {name!r} (one of {', '.join(OPS)})")
        try:
            said.append(_ONE[name](doc, op, read_image, fonts))
        except OpError as e:
            raise OpError(f"change {n} ({name}): {e}") from None
        P.fix_tree(doc.layers)
    return said


def _add_layer(doc, op, read_image, _fonts):
    name = str(op.get("name") or "").strip()
    idx = _place_index(doc, op)
    if op.get("file"):
        px = _read_layer_image(read_image, op)
        fit = op.get("fit") or "none"
        if op.get("w") or op.get("h"):
            w = int(M._num(op.get("w"), px.shape[1] * (M._num(op.get("h"), px.shape[0]) / px.shape[0]), 1, P.MAX_SIDE))
            h = int(M._num(op.get("h"), px.shape[0] * w / px.shape[1], 1, P.MAX_SIDE))
            px = _resize(px, w, h)
        elif fit in ("canvas", "contain", "cover"):
            ph, pw = px.shape[:2]
            if fit == "canvas":
                w, h = doc.w, doc.h
            else:
                k = (min if fit == "contain" else max)(doc.w / pw, doc.h / ph)
                w, h = max(1, round(pw * k)), max(1, round(ph * k))
            px = _resize(px, w, h)
        ph, pw = px.shape[:2]
        if op.get("x") is None and op.get("y") is None:
            x, y = (doc.w - pw) // 2, (doc.h - ph) // 2
        else:
            x, y = int(M._num(op.get("x"), 0)), int(M._num(op.get("y"), 0))
        name = name or str(op["file"]).replace("\\", "/").split("/")[-1].rsplit(".", 1)[0]
        what = f"{pw}x{ph} at {x},{y}"
    else:
        col = _color(op.get("color"), (0, 0, 0, 0))
        px = np.zeros((doc.h, doc.w, 4), dtype=np.uint8)
        px[...] = col
        x = y = 0
        name = name or ("Fill" if col[3] else "Layer")
        what = "filled " + ("#%02x%02x%02x" % col[:3]) if col[3] else "empty"
    L = doc.add_pixel_layer(px, name[:120], x, y, index=idx, opacity=M._num(op.get("opacity"), 100, 0, 100) / 100,
                            blend=op.get("blend") if op.get("blend") in M.BLEND_MODES else "normal")
    _placed(L, op)
    m = None
    if op.get("mask_file"):
        m = _read_mask(read_image, op, doc)
    elif op.get("mask") == "selection":
        m = _selection(doc).copy()
    if m is not None:
        L["mask"] = {"enabled": True, "x": 0, "y": 0, "w": doc.w, "h": doc.h, "fill": 0}
        doc.masks[L["id"]] = m
        what += ", masked"
    return f"added layer {L['name']!r} ({what})"


def _add_adjustment(doc, op, _read, _fonts):
    kind = str(op.get("type") or "").strip().lower()
    if kind not in M.ADJUST_TYPES:
        raise OpError(f"unknown adjustment {kind!r} (one of {', '.join(M.ADJUST_TYPES)})")
    L = doc.add_adjust_layer(kind, op.get("params") or {}, str(op.get("name") or "").strip() or None,
                             index=_place_index(doc, op), opacity=M._num(op.get("opacity"), 100, 0, 100) / 100)
    _placed(L, op)
    if op.get("mask") == "selection":
        L["mask"] = {"enabled": True, "x": 0, "y": 0, "w": doc.w, "h": doc.h, "fill": 0}
        doc.masks[L["id"]] = _selection(doc).copy()
    return f"added adjustment layer {L['name']!r} ({M.ADJUST_LABELS[kind]})"


def _set_layer(doc, op, _read, _fonts):
    L = find_layer(doc, op.get("layer"))
    changed = []
    if "locked" in op:
        L["locked"] = bool(op["locked"])
        changed.append("locked" if L["locked"] else "unlocked")
    if L.get("locked") and any(k in op for k in ("x", "y", "params", "blend")):
        _unlocked(L)
    if "name" in op and str(op["name"]).strip():
        L["name"] = str(op["name"]).strip()[:120]
        changed.append(f"named {L['name']!r}")
    if "visible" in op:
        L["visible"] = bool(op["visible"])
        changed.append("shown" if L["visible"] else "hidden")
    if "opacity" in op:
        L["opacity"] = M._num(op["opacity"], 100, 0, 100) / 100
        changed.append(f"opacity {round(L['opacity'] * 100)}%")
    if "blend" in op:
        modes = M.GROUP_BLENDS if L["kind"] == "group" else M.BLEND_MODES
        if op["blend"] not in modes:
            raise OpError(f"unknown blend mode {op['blend']!r} (one of {', '.join(modes)})")
        if L["kind"] == "adjust":
            raise OpError("an adjustment layer has no blend mode here")
        L["blend"] = op["blend"]
        changed.append(f"blend {L['blend']}")
    if "x" in op or "y" in op:
        if L["kind"] != "pixel":
            raise OpError(f"{'a group' if L['kind'] == 'group' else 'an adjustment layer'} has no place of its own"
                          + (" - move the layers inside it" if L["kind"] == "group" else ""))
        L["x"] = int(M._num(op.get("x"), L["x"]))
        L["y"] = int(M._num(op.get("y"), L["y"]))
        changed.append(f"at {L['x']},{L['y']}")
    if "params" in op:
        if L["kind"] != "adjust":
            raise OpError(f"{L['name']!r} is not an adjustment layer")
        merged = {**L["adjust"]["params"], **(op["params"] if isinstance(op["params"], dict) else {})}
        L["adjust"]["params"] = M.clean_adjust(L["adjust"]["type"], merged)
        changed.append("its numbers")
    if "clip" in op:
        if L["kind"] == "group":
            raise OpError("a group is not clipped to the layer under it here (clip its layers, or clip layers to it)")
        L["clip"] = bool(op["clip"])
        if not L["clip"]:
            L.pop("clip")
        changed.append("clipped to the layer under it" if op["clip"] else "not clipped")
    if "collapsed" in op and L["kind"] == "group":
        L["collapsed"] = bool(op["collapsed"])
        changed.append("folded" if L["collapsed"] else "opened")
    if op.get("active"):
        doc.meta["active"] = L["id"]
        changed.append("made active")
    if not changed:
        raise OpError("nothing to change (name, visible, opacity, blend, x, y, params, locked, clip, collapsed, active)")
    return f"layer {L['name']!r}: " + ", ".join(changed)


def _remove_layer(doc, op, _read, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer")))
    if len(P.subtree(doc, L)) >= len(doc.layers):
        raise OpError("the last layer cannot be taken out")
    doc.remove(L["id"])
    return f"removed layer {L['name']!r}"


def _duplicate_layer(doc, op, _read, _fonts):
    L = find_layer(doc, op.get("layer"))
    block = P.subtree(doc, L)
    new = {x["id"]: P.new_id() for x in block}
    at = _index_of(doc, L) + 1
    copies = []
    for x in block:
        C = copy.deepcopy(x)
        C["id"] = new[x["id"]]
        if x.get("parent") in new:
            C["parent"] = new[x["parent"]]
        C["locked"] = False
        if x["id"] in doc.px:
            doc.px[C["id"]] = doc.px[x["id"]].copy()
        if x["id"] in doc.masks:
            doc.masks[C["id"]] = doc.masks[x["id"]].copy()
        copies.append(C)
    C = copies[-1]
    C["name"] = str(op.get("name") or f"{L['name']} copy")[:120]
    if len(doc.layers) + len(copies) > P.MAX_LAYERS:
        raise OpError(f"at most {P.MAX_LAYERS} layers")
    doc.layers[at:at] = copies
    doc.meta["active"] = C["id"]
    return f"duplicated {L['name']!r} as {C['name']!r}" + (f" ({len(copies) - 1} layers inside)" if len(copies) > 1 else "")


def _move_layer(doc, op, _read, _fonts):
    """A layer (a group with what is in it) moved: among the layers of its group (top, bottom, up,
    down), to a place from the top (it takes the place - and the group - of the layer there), or
    ``into`` a group (its top) / ``into: "none"`` out of every group (just above the group it was in)."""
    L = find_layer(doc, op.get("layer"))
    block = P.subtree(doc, L)
    ids = {x["id"] for x in block}
    rest = [x for x in doc.layers if x["id"] not in ids]
    into, to = op.get("into"), op.get("to")
    if into not in (None, ""):
        if str(into).lower() in ("none", "document", "top_level"):
            anc = P.ancestors(doc, L)
            if not anc:
                raise OpError(f"{L['name']!r} is in no group")
            out = anc[-1]
            L.pop("parent", None)
            j = next(k for k, x in enumerate(rest) if x["id"] == out["id"]) + 1
            what = "out of its groups"
        else:
            G = find_layer(doc, into, "group")
            if G["id"] in ids:
                raise OpError("a group cannot go inside itself")
            L["parent"] = G["id"]
            j = next(k for k, x in enumerate(rest) if x["id"] == G["id"])
            what = f"into the group {G['name']!r}"
        doc.layers[:] = rest[:j] + block + rest[j:]
        return f"moved {L['name']!r} {what}"
    par = L.get("parent")
    sibs = [x for x in rest if x.get("parent") == par]
    pos = next((k for k, x in enumerate(doc.layers) if x["id"] == L["id"]), 0)
    below = [x for x in sibs if _index_of(doc, x) < pos]
    if to in ("top", "bottom", "up", "down"):
        if to == "top":
            ref, side = (sibs[-1] if sibs else None), "above"
        elif to == "bottom":
            ref, side = (sibs[0] if sibs else None), "below"
        elif to == "up":
            above = [x for x in sibs if _index_of(doc, x) > pos]
            ref, side = (above[0] if above else None), "above"
        else:
            ref, side = (below[-1] if below else None), "below"
    elif isinstance(to, (int, float)) or (isinstance(to, str) and to.isdigit()):
        n = len(doc.layers)
        k = int(to)
        if not 1 <= k <= n:
            raise OpError(f"'to' is 1 (top) .. {n} (bottom)")
        ref = doc.layers[n - k]
        if ref["id"] in ids:
            return f"{L['name']!r} is at place {k} already"
        L["parent"] = ref.get("parent")
        if not L["parent"]:
            L.pop("parent")
        side = "above" if _index_of(doc, ref) > pos else "below"
    else:
        raise OpError("'to' is top, bottom, up, down or a place from the top (1 = top); or give 'into' a group")
    if ref is None:
        return f"{L['name']!r} stays where it is"
    rb = P.subtree(doc, ref)
    if side == "above":
        j = next(k for k, x in enumerate(rest) if x["id"] == rb[-1]["id"]) + 1
    else:
        j = next(k for k, x in enumerate(rest) if x["id"] == rb[0]["id"])
    doc.layers[:] = rest[:j] + block + rest[j:]
    place = len(doc.layers) - _index_of(doc, L)
    return f"moved {L['name']!r} to place {place} from the top"


def _group(doc, op, _read, _fonts):
    """Layers into a new group, where the top one of them was; in the order they are in."""
    refs = op.get("layers")
    if refs in (None, ""):
        refs = [op.get("layer")]
    if not isinstance(refs, list) or not refs:
        raise OpError("'layers' is a list of layers to put in the group")
    picked = [find_layer(doc, r) for r in refs]
    pid = {x["id"] for x in picked}
    # A layer whose group is picked too goes with its group.
    tops = [x for x in doc.layers if x["id"] in pid and not any(a["id"] in pid for a in P.ancestors(doc, x))]
    top = tops[-1]
    par = top.get("parent")
    if len(P.ancestors(doc, top)) >= P.MAX_DEPTH:
        raise OpError("groups go at most %d deep" % P.MAX_DEPTH)
    blend = op.get("blend") or "pass_through"
    if blend not in M.GROUP_BLENDS:
        raise OpError(f"unknown blend mode {blend!r} (one of {', '.join(M.GROUP_BLENDS)})")
    G = P.clean_layer({"id": P.new_id(), "name": str(op.get("name") or _fresh_group_name(doc))[:120], "kind": "group",
                       "blend": blend, "opacity": M._num(op.get("opacity"), 100, 0, 100) / 100,
                       **({"parent": par} if par else {})})
    if len(doc.layers) >= P.MAX_LAYERS:
        raise OpError(f"at most {P.MAX_LAYERS} layers")
    blocks = [x for T in tops for x in P.subtree(doc, T)]
    bid = {x["id"] for x in blocks}
    rest = [x for x in doc.layers if x["id"] not in bid]
    # Where the top one was: above the layer under it among what is left.
    j = _index_of(doc, P.subtree(doc, top)[0])
    j = len([x for x in doc.layers[:j] if x["id"] not in bid])
    for T in tops:
        T["parent"] = G["id"]
    doc.layers[:] = rest[:j] + blocks + [G] + rest[j:]
    doc.meta["active"] = G["id"]
    return f"put {len(tops)} layer{'s' if len(tops) != 1 else ''} into the group {G['name']!r}"


def _fresh_group_name(doc):
    taken = {x["name"] for x in doc.layers}
    n = sum(1 for x in doc.layers if x["kind"] == "group") + 1
    while f"Group {n}" in taken:
        n += 1
    return f"Group {n}"


def _ungroup(doc, op, _read, _fonts):
    G = _unlocked(find_layer(doc, op.get("layer"), "group"))
    kids = [x for x in doc.layers if x.get("parent") == G["id"]]
    for x in kids:
        if G.get("parent"):
            x["parent"] = G["parent"]
        else:
            x.pop("parent", None)
    if G.get("mask") or G.get("opacity", 1) < 1 or G.get("blend") != "pass_through":
        doc.notes.append(f"the group {G['name']!r} had its own opacity, blend mode or mask; they went with it")
    doc.meta["layers"] = [x for x in doc.layers if x["id"] != G["id"]]
    doc.masks.pop(G["id"], None)
    doc.meta["active"] = kids[-1]["id"] if kids else (doc.layers[-1]["id"] if doc.layers else None)
    return f"took the {len(kids)} layer{'s' if len(kids) != 1 else ''} out of the group {G['name']!r}"


def _merge_group(doc, op, _read, _fonts):
    """A group made one pixel layer the size of the canvas: what it shows, as it shows it, alone."""
    G = _unlocked(find_layer(doc, op.get("layer"), "group"))
    block = P.subtree(doc, G)
    sub = P.PaintDoc(doc.w, doc.h)
    sub.meta["layers"] = [dict(x) for x in block]
    top = sub.meta["layers"][-1]
    top.pop("parent", None)
    top.update(visible=True, opacity=1.0, mask=None)
    top.pop("mask")
    top["blend"] = "normal"
    sub.px = {x["id"]: doc.px[x["id"]] for x in block if x["id"] in doc.px}
    sub.masks = {x["id"]: doc.masks[x["id"]] for x in block[:-1] if x["id"] in doc.masks}
    flat = P.composite(sub)
    at = _index_of(doc, block[0])
    L = P.clean_layer({"id": P.new_id(), "name": G["name"], "kind": "pixel", "x": 0, "y": 0, "w": doc.w, "h": doc.h,
                       "opacity": G["opacity"], "visible": G["visible"],
                       "blend": G["blend"] if G["blend"] in M.BLEND_MODES else "normal",
                       **({"parent": G["parent"]} if G.get("parent") else {})})
    if G.get("mask") and G["id"] in doc.masks:
        L["mask"] = dict(G["mask"])
    for x in block:
        doc.px.pop(x["id"], None)
        if x["id"] != G["id"]:
            doc.masks.pop(x["id"], None)
    if G["id"] in doc.masks:
        doc.masks[L["id"]] = doc.masks.pop(G["id"])
    ids = {x["id"] for x in block}
    rest = [x for x in doc.layers if x["id"] not in ids]
    doc.layers[:] = rest[:at] + [L] + rest[at:]
    doc.px[L["id"]] = flat
    doc.meta["active"] = L["id"]
    if G["blend"] == "pass_through" and any(x["kind"] == "adjust" or x.get("blend") != "normal" for x in block[:-1]):
        doc.notes.append(f"{G['name']!r} was Pass Through: merged, its layers no longer mix with what is under it")
    return f"merged the group {G['name']!r} ({len(block) - 1} layers) into one layer"


def _merge_down(doc, op, _read, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer")))
    if L["kind"] == "group":
        raise OpError(f"{L['name']!r} is a group: merge_group makes it one layer first")
    i = _index_of(doc, L)
    under = [x for x in doc.layers[:i] if x.get("parent") == L.get("parent")]
    if not under:
        raise OpError(f"{L['name']!r} is the bottom layer{' of its group' if L.get('parent') else ''}: nothing under it to merge into")
    B = _unlocked(under[-1])
    if B["kind"] != "pixel":
        raise OpError(f"the layer under it, {B['name']!r}, is {'a group' if B['kind'] == 'group' else 'an adjustment layer'}")
    base = _canvas_layer(doc, B)
    sub = P.PaintDoc(B["w"], B["h"])
    # Both laid on a document the size of the layer underneath (its place as 0, 0).
    lb = dict(B, x=0, y=0, opacity=1.0, blend="normal", visible=True)
    lb.pop("mask", None)
    sub.meta["layers"] = [lb]
    sub.px[B["id"]] = base
    if L["kind"] == "pixel":
        lt = dict(L, x=L["x"] - B["x"], y=L["y"] - B["y"])
        if lt.get("mask"):
            lt["mask"] = dict(lt["mask"], x=lt["mask"]["x"] - B["x"], y=lt["mask"]["y"] - B["y"])
        sub.px[L["id"]] = doc.px[L["id"]]
    else:
        lt = dict(L)
        if lt.get("mask"):
            lt["mask"] = dict(lt["mask"], x=lt["mask"]["x"] - B["x"], y=lt["mask"]["y"] - B["y"])
    if L["id"] in doc.masks:
        sub.masks[L["id"]] = doc.masks[L["id"]]
    sub.meta["layers"].append(lt)
    out = P.composite(sub)
    if L["kind"] == "adjust":
        out[..., 3] = base[..., 3]               # an adjustment changes colour, not where the layer is
    if B.get("mask") and B["id"] in doc.masks:
        doc.notes.append(f"{B['name']!r} kept its mask")
    doc.px[B["id"]] = out
    doc.remove(L["id"])
    doc.meta["active"] = B["id"]
    return f"merged {L['name']!r} down into {B['name']!r}"


def _flatten(doc, op, _read, _fonts):
    flat = P.composite(doc)
    if op.get("background") not in (None, "", "transparent"):
        col = np.zeros_like(flat)
        col[...] = _color(op["background"])
        flat = M.blend_over(col, flat, np.ones(flat.shape[:2]), "normal")
    n = len(doc.layers)
    doc.meta["layers"] = []
    doc.px.clear()
    doc.masks.clear()
    doc.add_pixel_layer(flat, str(op.get("name") or "Background"))
    return f"flattened {n} layers into one"


def _select(doc, op, read_image, _fonts):
    mode = str(op.get("mode") or "rect").lower()
    how = str(op.get("combine") or "replace").lower()
    if how not in ("replace", "add", "subtract", "intersect"):
        raise OpError("'combine' is replace, add, subtract or intersect")
    W, H = doc.w, doc.h
    if mode == "none":
        doc.selection = None
        return "selection cleared"
    if mode == "all":
        new = np.full((H, W), 255, np.uint8)
    elif mode == "invert":
        cur = doc.selection if doc.selection is not None else np.zeros((H, W), np.uint8)
        doc.selection = (255 - cur).astype(np.uint8)
        return "selection inverted"
    elif mode in ("rect", "ellipse"):
        x, y = M._num(op.get("x"), 0), M._num(op.get("y"), 0)
        w, h = M._num(op.get("w"), 0, 0), M._num(op.get("h"), 0, 0)
        if w <= 0 or h <= 0:
            raise OpError("a rect / ellipse needs w and h (pixels)")
        new = (M.rect_mask if mode == "rect" else M.ellipse_mask)(W, H, x, y, w, h)
    elif mode == "polygon":
        pts = op.get("points")
        if not isinstance(pts, list) or len(pts) < 3:
            raise OpError("a polygon needs 'points': [[x, y], ...] (3 or more)")
        new = M.polygon_mask(W, H, [[M._num(p[0], 0), M._num(p[1], 0)] for p in pts if isinstance(p, (list, tuple))])
    elif mode == "layer":
        L = find_layer(doc, op.get("layer"), "pixel")
        new = np.zeros((H, W), np.uint8)
        px = doc.px[L["id"]]
        x, y = L["x"], L["y"]
        h, w = px.shape[:2]
        x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
        if x1 > x0 and y1 > y0:
            new[y0:y1, x0:x1] = px[y0 - y:y1 - y, x0 - x:x1 - x, 3]
    elif mode == "file":
        new = _read_mask(read_image, op, doc, "file")
    else:
        raise OpError("'mode' is rect, ellipse, polygon, all, none, invert, layer (its alpha) or file (a mask)")
    sel = M.combine_masks(doc.selection, new, how)
    if op.get("feather"):
        sel = M.feather_mask(sel, M._num(op["feather"], 0, 0, 500))
    doc.selection = sel
    bb = M.mask_bbox(sel)
    return f"selected ({mode}, {how})" + (f": {bb[2]}x{bb[3]} at {bb[0]},{bb[1]}" if bb else ": nothing")


def _mask(doc, op, read_image, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer")))
    how = str(op.get("from") or "selection").lower()
    if how == "remove":
        L.pop("mask", None)
        doc.masks.pop(L["id"], None)
        return f"{L['name']!r}: mask removed"
    if how in ("on", "off"):
        if not L.get("mask"):
            raise OpError(f"{L['name']!r} has no mask")
        L["mask"]["enabled"] = how == "on"
        return f"{L['name']!r}: mask {how}"
    if how == "settings":
        # Density (0..100 %) and feather (px): kept on the mask, not baked in.
        if not L.get("mask"):
            raise OpError(f"{L['name']!r} has no mask")
        said = []
        if "density" in op:
            L["mask"]["density"] = M._num(op["density"], 100, 0, 100) / 100
            said.append(f"density {round(L['mask']['density'] * 100)}%")
        if "feather" in op:
            L["mask"]["feather"] = M._num(op["feather"], 0, 0, 250)
            said.append(f"feather {L['mask']['feather']:g} px")
        if not said:
            raise OpError("give 'density' (0..100) or 'feather' (px)")
        L["mask"] = P.clean_layer({"mask": L["mask"]})["mask"]
        return f"{L['name']!r}: mask " + ", ".join(said)
    if how == "invert":
        if not L.get("mask"):
            raise OpError(f"{L['name']!r} has no mask")
        doc.masks[L["id"]] = (255 - doc.masks[L["id"]]).astype(np.uint8)
        L["mask"]["fill"] = 255 - L["mask"].get("fill", 0)
        return f"{L['name']!r}: mask inverted"
    if how == "selection":
        m = _selection(doc).copy()
    elif how == "file":
        m = _read_mask(read_image, op, doc, "file")
    elif how == "all":
        m = np.full((doc.h, doc.w), 255, np.uint8)
    else:
        raise OpError("'from' is selection, file, all, invert, on, off, remove or settings (density, feather)")
    L["mask"] = {"enabled": True, "x": 0, "y": 0, "w": doc.w, "h": doc.h, "fill": 0 if how != "all" else 255}
    doc.masks[L["id"]] = m
    return f"{L['name']!r}: mask from the {how}"


def _fill(doc, op, _read, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer"), "pixel"))
    col = _color(op.get("color"), (0, 0, 0, 255))
    sel = _selection(doc, need=False)
    px = _canvas_layer(doc, L)
    t = _layer_area(doc, L, sel) if sel is not None else np.ones(px.shape[:2])
    cp = np.zeros_like(px)
    cp[...] = col
    doc.px[L["id"]] = _mix(px, cp, t)
    hexc = "#%02x%02x%02x" % col[:3]
    return f"filled {'the selection' if sel is not None else 'all'} of {L['name']!r} with {hexc}"


def _clear(doc, op, _read, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer"), "pixel"))
    sel = _selection(doc)
    px = doc.px[L["id"]].copy()
    t = _layer_area(doc, L, sel)
    px[..., 3] = M.q8((px[..., 3] / 255.0) * (1 - t))
    doc.px[L["id"]] = px
    return f"cleared the selection on {L['name']!r}"


def _heal(doc, op, _read, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer"), "pixel"))
    sel = _selection(doc)
    px = _canvas_layer(doc, L)
    hole = M.q8(_layer_area(doc, L, sel))
    doc.px[L["id"]] = M.heal(px, hole)
    return f"filled the selection on {L['name']!r} from its surroundings"


def _filter(doc, op, _read, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer"), "pixel"))
    kind = str(op.get("type") or "").lower()
    px = doc.px[L["id"]]
    if kind == "blur":
        r = M._num(op.get("radius"), 4, 0.1, 250)
        out = M.blur_pixels(px, r)
        what = f"blurred {r:g} px"
    elif kind == "sharpen":
        r = M._num(op.get("radius"), 2, 0.1, 100)
        a = M._num(op.get("amount"), 1, 0, 10)
        out = M.sharpen_pixels(px, r, a)
        what = f"sharpened {r:g} px x{a:g}"
    elif kind in M.ADJUST_TYPES:
        out = M.adjust_pixels(px, kind, op.get("params") or {})
        what = M.ADJUST_LABELS[kind] + " baked in"
    else:
        raise OpError("'type' is blur, sharpen or an adjustment type (baked into the pixels)")
    sel = _selection(doc, need=False)
    if sel is not None:
        t = _layer_area(doc, L, sel)[..., None]
        out = M.q8((px.astype(np.float64) / 255) * (1 - t) + (out.astype(np.float64) / 255) * t)
        what += " in the selection"
    doc.px[L["id"]] = out
    return f"{L['name']!r}: {what}"


def _shift_all(doc, dx, dy):
    for L in doc.layers:
        if L["kind"] == "pixel":
            L["x"] += dx
            L["y"] += dy
        if L.get("mask"):
            L["mask"]["x"] += dx
            L["mask"]["y"] += dy
    if doc.selection is not None:
        H, W = doc.selection.shape
        s = np.zeros((doc.h, doc.w), np.uint8)
        x0, y0 = max(0, dx), max(0, dy)
        sx0, sy0 = max(0, -dx), max(0, -dy)
        w = min(W - sx0, doc.w - x0)
        h = min(H - sy0, doc.h - y0)
        if w > 0 and h > 0:
            s[y0:y0 + h, x0:x0 + w] = doc.selection[sy0:sy0 + h, sx0:sx0 + w]
        doc.selection = s if s.any() else None


def _crop(doc, op, _read, _fonts):
    if op.get("to") == "selection":
        bb = M.mask_bbox(_selection(doc))
        x, y, w, h = bb
    else:
        x, y = int(M._num(op.get("x"), 0)), int(M._num(op.get("y"), 0))
        w, h = int(M._num(op.get("w"), 0)), int(M._num(op.get("h"), 0))
    if w < 1 or h < 1 or w > P.MAX_SIDE or h > P.MAX_SIDE:
        raise OpError("the crop needs w and h of at least 1 pixel")
    doc.meta["w"], doc.meta["h"] = w, h
    _shift_all(doc, -x, -y)
    return f"cropped to {w}x{h} (from {x},{y})"


def _canvas_size(doc, op, _read, _fonts):
    w = int(M._num(op.get("w"), doc.w, 1, P.MAX_SIDE))
    h = int(M._num(op.get("h"), doc.h, 1, P.MAX_SIDE))
    ax, ay = ANCHORS.get(str(op.get("anchor") or "center"), (0.5, 0.5))
    dx, dy = int(round((w - doc.w) * ax)), int(round((h - doc.h) * ay))
    old = (doc.w, doc.h)
    doc.meta["w"], doc.meta["h"] = w, h
    _shift_all(doc, dx, dy)
    return f"canvas {old[0]}x{old[1]} -> {w}x{h} (anchored {op.get('anchor') or 'center'})"


def _resize_doc(doc, op, _read, _fonts):
    if op.get("scale"):
        k = M._num(op["scale"], 1, 0.01, 16)
        w, h = round(doc.w * k), round(doc.h * k)
    else:
        w = op.get("w")
        h = op.get("h")
        if not w and not h:
            raise OpError("give w and/or h (pixels), or scale")
        w = int(M._num(w, doc.w * M._num(h, doc.h) / doc.h, 1, P.MAX_SIDE))
        h = int(M._num(h, doc.h * w / doc.w, 1, P.MAX_SIDE))
    if w > P.MAX_SIDE or h > P.MAX_SIDE:
        raise OpError(f"at most {P.MAX_SIDE} pixels a side")
    kx, ky = w / doc.w, h / doc.h
    method = op.get("method") or "lanczos"
    for L in doc.layers:
        if L["kind"] == "pixel":
            px = doc.px[L["id"]]
            nw, nh = max(1, round(px.shape[1] * kx)), max(1, round(px.shape[0] * ky))
            doc.px[L["id"]] = _resize(px, nw, nh, method)
            L.update(x=round(L["x"] * kx), y=round(L["y"] * ky), w=nw, h=nh)
        if L.get("mask") and L["id"] in doc.masks:
            m = doc.masks[L["id"]]
            nw, nh = max(1, round(m.shape[1] * kx)), max(1, round(m.shape[0] * ky))
            doc.masks[L["id"]] = _resize(m, nw, nh, "bilinear")
            L["mask"].update(x=round(L["mask"]["x"] * kx), y=round(L["mask"]["y"] * ky), w=nw, h=nh)
    if doc.selection is not None:
        doc.selection = _resize(doc.selection, w, h, "bilinear")
    old = (doc.w, doc.h)
    doc.meta["w"], doc.meta["h"] = w, h
    return f"resized {old[0]}x{old[1]} -> {w}x{h} ({method})"


def _transform(doc, op, _read, _fonts):
    L = _unlocked(find_layer(doc, op.get("layer"), "pixel"))
    px = doc.px[L["id"]]
    done = []
    cx, cy = L["x"] + px.shape[1] / 2, L["y"] + px.shape[0] / 2
    if op.get("flip") in ("h", "horizontal"):
        px = px[:, ::-1].copy()
        done.append("flipped left-right")
    elif op.get("flip") in ("v", "vertical"):
        px = px[::-1].copy()
        done.append("flipped top-bottom")
    rot = int(M._num(op.get("rotate"), 0)) % 360
    if rot:
        if rot % 90 == 0:
            px = np.rot90(px, k=-(rot // 90)).copy()
        else:
            from PIL import Image
            im = Image.fromarray(px, "RGBA").rotate(-rot, resample=Image.BICUBIC, expand=True)
            px = np.asarray(im, dtype=np.uint8).copy()
        done.append(f"rotated {rot} degrees")
    if op.get("scale"):
        k = M._num(op["scale"], 1, 0.01, 16)
        px = _resize(px, max(1, round(px.shape[1] * k)), max(1, round(px.shape[0] * k)))
        done.append(f"scaled x{k:g}")
    if not done:
        raise OpError("give flip (h / v), rotate (degrees clockwise) or scale")
    doc.px[L["id"]] = px
    L["w"], L["h"] = px.shape[1], px.shape[0]
    L["x"], L["y"] = int(round(cx - px.shape[1] / 2)), int(round(cy - px.shape[0] / 2))
    if L.get("mask"):
        L.pop("mask")
        doc.masks.pop(L["id"], None)
        done.append("its mask removed")
    return f"{L['name']!r}: " + ", ".join(done)


def render_text(t, fonts=None):
    """A text layer's pixels (Pillow; the font by family through *fonts* when given)."""
    from PIL import Image, ImageDraw, ImageFont
    t = P.clean_text(t)
    size = int(round(t["size"]))
    font = None
    if fonts:
        try:
            font = fonts(t["font"], t["bold"], t["italic"], size)
        except Exception:  # noqa: BLE001 - no such family: the default
            font = None
    if font is None:
        try:
            font = ImageFont.load_default(size=size)
        except TypeError:
            font = ImageFont.load_default()
    lines = t["text"].split("\n") or [""]
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    boxes = [probe.textbbox((0, 0), ln or " ", font=font) for ln in lines]
    lh = int(size * 1.25)
    w = max(1, max(b[2] for b in boxes) + 4)
    h = max(1, lh * len(lines) + 4)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    col = tuple(int(t["color"][i:i + 2], 16) for i in (1, 3, 5)) + (255,)
    for i, ln in enumerate(lines):
        lw = boxes[i][2]
        x = 2 if t["align"] == "left" else ((w - lw) // 2 if t["align"] == "center" else w - lw - 2)
        d.text((x, 2 + i * lh), ln, font=font, fill=col)
    return np.asarray(im, dtype=np.uint8).copy()


def _add_text(doc, op, _read, fonts):
    text = str(op.get("text") or "")
    if not text.strip():
        raise OpError("'text' is needed")
    t = P.clean_text({**op, "text": text})
    px = render_text(t, fonts)
    x = int(M._num(op.get("x"), (doc.w - px.shape[1]) // 2))
    y = int(M._num(op.get("y"), (doc.h - px.shape[0]) // 2))
    L = doc.add_pixel_layer(px, str(op.get("name") or text.splitlines()[0][:40]), x, y, index=_place_index(doc, op))
    _placed(L, op)
    L["text"] = t
    return f"added text {text.splitlines()[0][:40]!r} at {x},{y}"


_ONE = {"add_layer": _add_layer, "add_adjustment": _add_adjustment, "set_layer": _set_layer,
        "remove_layer": _remove_layer, "duplicate_layer": _duplicate_layer, "move_layer": _move_layer,
        "merge_down": _merge_down, "flatten": _flatten, "select": _select, "mask": _mask, "fill": _fill,
        "clear": _clear, "heal": _heal, "filter": _filter, "crop": _crop, "canvas_size": _canvas_size,
        "resize": _resize_doc, "transform": _transform, "add_text": _add_text, "group": _group,
        "ungroup": _ungroup, "merge_group": _merge_group}
