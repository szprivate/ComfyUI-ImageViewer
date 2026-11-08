"""Paint's routes: a picture in layers, opened in the page, changed by the page or the agent, saved
as an .ora, exported flat or as a .psd (paint_io, paint_ops).

The server keeps each document that is open in a page as a SESSION (``_Book``): its description and
its pixels, under a random token the page holds. Pixels travel raw (straight RGBA, gzip) so that
nothing is rounded on the way - a canvas' PNG would premultiply them.

- ``POST /imageviewer/paint/open`` (JSON) - a picture, an .ora or a .psd by ``path`` (or ``filename`` /
  ``subfolder`` / ``type``), or ``new: {w, h, name, fill}``: a session; answers ``token``, ``doc``
  (the description), ``path``, ``notes``.
- ``GET /imageviewer/paint/px?token=&layer=<id>`` / ``mask=<id>`` / ``sel=1`` - a session's pixels.
- ``POST /imageviewer/paint/stage?token=&part=layer:<id>|mask:<id>|sel`` - pixels from the page, held in
  the session until the next save (``gzip`` when ``X-ImageViewer-Enc: gzip``). Nothing is written to disk,
  and a token is unguessable, so this needs no more fence than the host check.
- ``POST /imageviewer/paint/save`` (JSON) - the page's description plus the staged pixels (the rest,
  named in ``keep``, as the session has them) become the session's document; ``write`` false stops
  there (``sync``), else it is written: over its own .ora, or - a picture, a .psd, a new document,
  ``as_new`` - as the next version by the export rule (kind ``paint``).
- ``POST /imageviewer/paint/export`` (JSON) - the session's document as png / jpg / webp / tif (flat) or
  psd (layers; adjustments baked), by the export rule.
- ``POST /imageviewer/paint/save_as`` (JSON) - ``token, meta, keep, folder, name, format (ora | psd), overwrite``:
  the document into that folder (``is_allowed``), the tab working on that file from then on; 409 ``{exists, path}``
  when the file is there and ``overwrite`` is not set.
- ``POST /imageviewer/paint/doc`` (JSON) - the agent's: ``doc`` (a path, or a token) and ``ops``
  (paint_ops). Without ops: the outline. With ops: applied (all or none), written when the document
  is a file (an .ora over itself; a picture / .psd as a new .ora version beside the rule), and the page
  told (``imageviewer.paint.changed``).
- ``POST /imageviewer/paint/describe`` (JSON) - ``token``: the session's description as it is now (after the
  agent's or the page's ops), to read its pixels again.
- ``POST /imageviewer/paint/snapshot`` (JSON) - the picture as it looks and the selection, as PNGs in
  ``<input>/paint`` - what agentY is given when it builds the workflow itself (Generate's "agentY" choice).
- ``GET / POST /imageviewer/paint/workflows`` - the workflows Generate runs (paint_generate.py): the table;
  POST ``{action, choice}`` picks one, ``{action, graph, name, source}`` stores the user's own (API format;
  ``graph: null`` forgets it).
- ``POST /imageviewer/paint/generate`` (JSON) - ``token, action, prompt, workflow?, variations, k``: the crop
  (and its mask) written into ``<input>/paint``, the workflow filled in, 1-4 graphs for the page to queue;
  409 ``{missing}`` when a model or node is not on this machine.
- ``POST /imageviewer/paint/generate_place`` (JSON) - ``job, image {filename, subfolder, type}, n``: the paint
  ops that lay a result back (a layer at the crop, masked to the selection; a mask; a selection; an upscale).

Every POST but ``stage`` is ``path_access.same_origin``; every path is ``path_access.is_allowed``
(an .ora / .psd is not media, so not ``may_serve``), a picture read as a layer ``may_serve``.
"""
from __future__ import annotations

import gzip
import os
import re
import secrets
import threading
import time

import numpy as np

from . import paint_generate as G
from . import paint_io as P
from . import paint_ops as O
from . import paint_math as M

PICTURE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".tga", ".gif", ".exr", ".hdr", ".dpx"}
EXPORT_FORMATS = {"png": "PNG", "jpg": "JPEG", "webp": "WebP", "tif": "TIFF", "psd": "Photoshop (.psd)", "ora": "OpenRaster (.ora)"}
MAX_SESSIONS = 6
MAX_STAGE_BYTES = P.MAX_SIDE * P.MAX_SIDE * 4
_TOKEN = re.compile(r"[0-9a-f]{32}")
#: Seconds the agent waits for the page to hand over a picture it has not saved (``sync`` on /paint/doc).
SYNC_TIMEOUT = 20.0
_PART = re.compile(r"(layer|mask|src):([A-Za-z0-9_-]{1,40})|sel")


class PaintError(ValueError):
    pass


def is_paint_file(path):
    return os.path.splitext(str(path or ""))[1].lower() in P.EXTS_OPEN


def may_open(path):
    ext = os.path.splitext(str(path or ""))[1].lower()
    return ext in P.EXTS_OPEN or ext in PICTURE_EXTS


class _Session:
    def __init__(self, doc, path, source=None):
        self.doc = doc
        self.path = path          # the .ora it came from / was saved to, or None
        self.source = source      # the file it was opened from (a picture, a .psd, the .ora)
        self.staged = {}
        self.used = time.time()
        self.lock = threading.Lock()


class _Book:
    """The documents open in pages, by token (the oldest let go past MAX_SESSIONS)."""

    def __init__(self):
        self._s = {}
        self._lock = threading.Lock()

    def add(self, doc, path, source=None):
        tok = secrets.token_hex(16)
        with self._lock:
            self._s[tok] = _Session(doc, path, source or path)
            while len(self._s) > MAX_SESSIONS:
                old = min(self._s, key=lambda k: self._s[k].used)
                del self._s[old]
        return tok

    def get(self, tok):
        if not isinstance(tok, str) or not _TOKEN.fullmatch(tok):
            return None
        with self._lock:
            s = self._s.get(tok)
        if s:
            s.used = time.time()
        return s

    def by_path(self, path):
        key = os.path.normcase(os.path.abspath(path))
        with self._lock:
            for tok, s in self._s.items():
                for p in (s.path, s.source):
                    if p and os.path.normcase(os.path.abspath(p)) == key:
                        return tok, s
        return None, None


BOOK = _Book()


# ── the work (no aiohttp: tested on its own) ─────────────────────────────────

def open_doc(path=None, new=None):
    """``(token, session)`` for a file or a new canvas."""
    if new is not None:
        w, h = int(M._num(new.get("w"), 1920)), int(M._num(new.get("h"), 1080))
        if not (1 <= w <= P.MAX_SIDE and 1 <= h <= P.MAX_SIDE):
            raise PaintError(f"the canvas must be 1..{P.MAX_SIDE} pixels a side")
        doc = P.PaintDoc(w, h, str(new.get("name") or "paint")[:120])
        fill = new.get("fill", "white")
        px = np.zeros((h, w, 4), np.uint8)
        try:
            px[...] = O._color(fill or "white")
        except O.OpError as e:
            raise PaintError(str(e)) from None
        doc.add_pixel_layer(px, "Background")
        return BOOK.add(doc, None)
    doc = P.open_any(path)
    return BOOK.add(doc, path if path.lower().endswith(".ora") else None, path), doc


def pixels_of(s, part):
    """Raw bytes of a session's layer / mask / selection."""
    m = _PART.fullmatch(part or "")
    if not m:
        raise PaintError("unknown part")
    doc = s.doc
    if part == "sel":
        sel = doc.selection if doc.selection is not None else np.zeros((doc.h, doc.w), np.uint8)
        return np.ascontiguousarray(sel).tobytes()
    kind, lid = m.group(1), m.group(2)
    src = {"layer": doc.px, "mask": doc.masks, "src": doc.sources}[kind]
    a = src.get(lid)
    if a is None:
        raise PaintError(f"no {kind} {lid}")
    return np.ascontiguousarray(a).tobytes()


def stage(s, part, data, gz=False):
    if not _PART.fullmatch(part or ""):
        raise PaintError("unknown part")
    if gz:
        data = gzip.decompress(data)
        if len(data) > MAX_STAGE_BYTES:
            raise PaintError("too large")
    with s.lock:
        s.staged[part] = bytes(data)
        total = sum(len(v) for v in s.staged.values())
        if total > 4 * MAX_STAGE_BYTES:
            s.staged.clear()
            raise PaintError("too much waiting to be saved")


def commit(s, meta, keep):
    """The page's document becomes the session's: its description, the staged pixels, the kept ones."""
    meta = P.clean_meta(meta)
    keep = set(keep or [])
    old = s.doc
    doc = P.PaintDoc(meta["w"], meta["h"], meta["name"])
    doc.meta = meta
    with s.lock:
        staged, s.staged = s.staged, {}
    for L in meta["layers"]:
        lid = L["id"]
        if L["kind"] == "pixel":
            raw = staged.get("layer:" + lid)
            if raw is not None:
                if len(raw) != L["w"] * L["h"] * 4:
                    raise PaintError(f"layer {L['name']!r}: {len(raw)} bytes for {L['w']}x{L['h']}")
                doc.px[lid] = np.frombuffer(raw, np.uint8).reshape(L["h"], L["w"], 4).copy()
            elif lid in keep and lid in old.px and old.px[lid].shape[:2] == (L["h"], L["w"]):
                doc.px[lid] = old.px[lid]
            else:
                raise PaintError(f"layer {L['name']!r}: its pixels were not sent")
        if L.get("mask"):
            mk = L["mask"]
            raw = staged.get("mask:" + lid)
            if raw is not None:
                if len(raw) != mk["w"] * mk["h"]:
                    raise PaintError(f"the mask of {L['name']!r}: wrong size")
                doc.masks[lid] = np.frombuffer(raw, np.uint8).reshape(mk["h"], mk["w"]).copy()
            elif lid in keep and lid in old.masks and old.masks[lid].shape == (mk["h"], mk["w"]):
                doc.masks[lid] = old.masks[lid]
            else:
                L.pop("mask")
    # Smart layers' sources: sent once, then kept by the session; a layer whose source is not there is a plain one.
    for L in meta["layers"]:
        sm = L.get("smart")
        if not sm:
            continue
        sid = sm["src"]
        if sid in doc.sources:
            continue
        raw = staged.get("src:" + sid)
        if raw is not None and len(raw) == sm["sw"] * sm["sh"] * 4:
            doc.sources[sid] = np.frombuffer(raw, np.uint8).reshape(sm["sh"], sm["sw"], 4).copy()
        elif sid in old.sources and old.sources[sid].shape[:2] == (sm["sh"], sm["sw"]):
            doc.sources[sid] = old.sources[sid]
        else:
            L.pop("smart")
            doc.notes.append(f"the source of the smart layer {L['name']!r} did not arrive: it is a plain layer")
    raw = staged.get("sel")
    if raw is not None and len(raw) == doc.w * doc.h:
        sel = np.frombuffer(raw, np.uint8).reshape(doc.h, doc.w).copy()
        doc.selection = sel if sel.any() else None
    s.doc = doc
    return doc


def _rule_target(export_rules, output_dir, name, ext, context):
    return export_rules.target("paint", name, ext, output_dir, context)


def save(s, export_rules, output_dir, *, as_new=False, name=None, context=None, is_allowed=None):
    """Write the session's document: over its own .ora, else the next version by the rule."""
    doc = s.doc
    if s.path and not as_new and s.path.lower().endswith(".ora"):
        path = s.path
        if is_allowed and not is_allowed(path):
            raise PaintError("that folder may not be written to")
        version = None
    else:
        t = _rule_target(export_rules, output_dir, name or doc.meta.get("name") or "paint", "ora", context)
        path, version = t["path"], t["version"]
    P.write_ora(path, doc)
    s.path = path
    return {"path": path, "version": version}


_NOT_IN_A_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", re.I)
SAVE_AS_FORMATS = ("ora", "psd")


class Exists(PaintError):
    """Save as onto a file that is there: the page asks before writing over it."""

    def __init__(self, path):
        super().__init__(f"{os.path.basename(path)} is there already")
        self.path = path


def file_name(name, fmt):
    """A file name from what was typed: no folder in it, the format's extension."""
    text = _NOT_IN_A_NAME.sub("_", str(name or "")).strip()
    if text.lower().endswith("." + fmt):
        text = text[:-len(fmt) - 1]
    text = text.strip(" .")[:120].strip(" .")
    if not text.strip("_") or _RESERVED.match(text):
        text = ("paint_" + text) if text.strip("_") else "paint"
    return f"{text}.{fmt}"


def save_as(s, folder, name, fmt="ora", *, overwrite=False, is_allowed=None):
    """Save as...: the document into *folder* / *name*.<fmt> (.ora with everything; .psd as Photoshop takes it).
    The tab then works on that file. Raises Exists when it is there and *overwrite* is not set."""
    fmt = str(fmt or "ora").lower().lstrip(".")
    if fmt not in SAVE_AS_FORMATS:
        raise PaintError(f"Save as writes .ora or .psd, not .{fmt}")
    if not str(folder or "").strip():
        raise PaintError("say which folder")
    folder = os.path.abspath(str(folder))
    if is_allowed and not is_allowed(folder):
        raise PaintError("that folder may not be written to (Settings > ComfyUI Image Viewer > Folders)")
    os.makedirs(folder, exist_ok=True)       # the shot's paint folder before its first version, say
    path = os.path.join(folder, file_name(name, fmt))
    if os.path.exists(path) and not overwrite:
        raise Exists(path)
    tmp = path + ".part" + fmt
    try:
        notes = []
        if fmt == "psd":
            notes = list(P.write_psd(tmp, s.doc) or [])
        else:
            P.write_ora(tmp, s.doc)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    s.path = path
    return {"path": path, "notes": notes}


def export(s, export_rules, output_dir, fmt, *, name=None, context=None, quality=92):
    fmt = str(fmt or "png").lower()
    if fmt == "jpeg":
        fmt = "jpg"
    if fmt == "tiff":
        fmt = "tif"
    if fmt not in EXPORT_FORMATS:
        raise PaintError(f"unknown format {fmt} (one of {', '.join(EXPORT_FORMATS)})")
    doc = s.doc
    t = _rule_target(export_rules, output_dir, name or doc.meta.get("name") or "paint", fmt, context)
    path = t["path"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    notes = []
    if fmt == "psd":
        notes = P.write_psd(path, doc) or []
    elif fmt == "ora":
        P.write_ora(path, doc)
    else:
        from PIL import Image
        flat = P.composite(doc)
        im = Image.fromarray(flat, "RGBA")
        if fmt == "jpg":
            # JPEG has no see-through: over white, as Photoshop flattens.
            back = Image.new("RGBA", im.size, (255, 255, 255, 255))
            back.alpha_composite(im)
            im = back.convert("RGB")
            im.save(path, format="JPEG", quality=int(M._num(quality, 92, 10, 100)), subsampling=0)
        elif fmt == "webp":
            im.save(path, format="WEBP", quality=int(M._num(quality, 92, 10, 100)), method=4)
        elif fmt == "tif":
            im.save(path, format="TIFF", compression="tiff_deflate")
        else:
            im.save(path, format="PNG", compress_level=4)
    return {"path": path, "version": t["version"], "notes": list(notes)}


def snapshot(s, input_dir):
    """The picture as it looks and the selection, as PNGs a workflow can load: ``<input>/paint``."""
    doc = s.doc
    folder = os.path.join(input_dir, "paint")
    os.makedirs(folder, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", doc.meta.get("name") or "paint").strip("_")[:40] or "paint"
    stamp = time.strftime("%Y%m%d_%H%M%S")
    comp = os.path.join(folder, f"{stem}_{stamp}_picture.png")
    with open(comp, "wb") as fh:
        fh.write(P.png_bytes(P.composite(doc)))
    out = {"picture": comp, "w": doc.w, "h": doc.h, "selection": None, "box": None}
    if doc.selection is not None and doc.selection.any():
        mp = os.path.join(folder, f"{stem}_{stamp}_mask.png")
        with open(mp, "wb") as fh:
            fh.write(P.png_bytes(doc.selection))
        out["selection"] = mp
        x, y, w, h = M.mask_bbox(doc.selection)
        out["box"] = {"x": x, "y": y, "w": w, "h": h}
    return out


def _fonts():
    try:
        from . import title_render as T
    except Exception:  # noqa: BLE001
        return None

    def get(family, bold, italic, size):
        face = T.resolve_face(T.fonts(), family, bold, italic)
        return T._pil_font(face["face"], size)
    return get


def agent_ops(doc_ref, ops, *, resolve, is_allowed, may_serve, export_rules, output_dir, write=True, save_new=False):
    """What ``/imageviewer/paint/doc`` does: ``(answer, token or None)``. ``save_new``: a document open in a page
    that has no .ora yet (a new canvas, a picture) is saved as the next version too (the agent on the live tab)."""
    tok, s = None, None
    if isinstance(doc_ref, str) and _TOKEN.fullmatch(doc_ref):
        s = BOOK.get(doc_ref)
        tok = doc_ref if s else None
        if not s:
            raise PaintError("that document is no longer open")
        path = s.path
    else:
        path = resolve(doc_ref)
        if not path or not is_allowed(path) or not os.path.isfile(path):
            raise PaintError(f"{doc_ref} is not a picture, .ora or .psd the viewer may open")
        if not may_open(path):
            raise PaintError(f"{os.path.basename(path)} is not a picture, .ora or .psd")
        tok, s = BOOK.by_path(path)
    if s is not None:
        doc = s.doc
    else:
        doc = P.open_any(path)
    if not ops:
        return {"path": path, "outline": P.outline(doc), "notes": list(doc.notes)}, tok

    def read_image(f):
        p = resolve(f)
        if not p or not may_serve(p) or not os.path.isfile(p):
            raise O.OpError(f"{f} is not a picture the viewer may open")
        return P.image_pixels(p)

    work = _copy(doc)
    said = O.apply_ops(work, ops, read_image, _fonts())
    answer = {"said": said}
    if s is None:
        # Not open in a page: the file is the document (a picture / .psd becomes a new .ora version).
        s = _Session(work, path if path.lower().endswith(".ora") else None)
        s.doc.meta.setdefault("name", os.path.splitext(os.path.basename(path))[0])
        res = save(s, export_rules, output_dir, is_allowed=is_allowed)
        answer.update(path=res["path"], written=True)
        tok2, s2 = BOOK.by_path(res["path"])
        if s2 is not None:
            s2.doc = work
            tok = tok2
    else:
        s.doc = work
        if write and (s.path or save_new):
            res = save(s, export_rules, output_dir, is_allowed=is_allowed)
            answer.update(path=res["path"], written=True)
        else:
            answer.update(path=s.path, written=False)
    answer["outline"] = P.outline(work)
    return answer, tok


def _copy(doc):
    import copy
    out = P.PaintDoc(doc.w, doc.h, doc.meta.get("name"))
    out.meta = copy.deepcopy(doc.meta)
    out.px = {k: v.copy() for k, v in doc.px.items()}
    out.masks = {k: v.copy() for k, v in doc.masks.items()}
    out.sources = dict(doc.sources)       # never changed in place: shared
    out.selection = None if doc.selection is None else doc.selection.copy()
    out.notes = list(doc.notes)
    return out


def describe(tok, s):
    return {"token": tok, "path": s.path, "doc": P.clean_meta(s.doc.meta), "notes": list(s.doc.notes),
            "selection": s.doc.selection is not None and bool(s.doc.selection.any())}


# ── the routes ───────────────────────────────────────────────────────────────

def register(add, *, web, path_access, export_rules, folder_paths, send, resolve):
    """Add the routes through ``add(method, path, handler)`` (both /imageviewer and /api/imageviewer)."""
    import asyncio

    def off(fn, *a, **k):
        return asyncio.get_running_loop().run_in_executor(None, lambda: fn(*a, **k))

    def err(e, status=400):
        return web.json_response({"error": str(e)}, status=status)

    def output_dir():
        return folder_paths.get_output_directory()

    # The agent on the picture the user is working on (edit_image with the tab's token and "sync"): the page is
    # asked for what it has not saved (imageviewer.paint.sync), answers with a save that writes nothing (its
    # sync_req), and only then do the ops run - so nothing of the user's is lost and nothing needs saving first.
    waiting = {}

    async def page_sync(tok):
        timeout = SYNC_TIMEOUT
        req = secrets.token_hex(8)
        fut = asyncio.get_running_loop().create_future()
        waiting[req] = fut
        try:
            send("imageviewer.paint.sync", {"token": tok, "req": req})
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise PaintError("the Paint tab did not hand over its picture (is the viewer open?)") from None
        finally:
            waiting.pop(req, None)

    def synced(body, failed=None):
        fut = waiting.get(str(body.get("sync_req") or ""))
        if fut is not None and not fut.done():
            if failed:
                fut.set_exception(PaintError(f"the Paint tab could not hand over its picture: {failed}"))
            else:
                fut.set_result(True)

    async def guarded_json(request):
        ok, why = path_access.same_origin(request)
        if not ok:
            raise web.HTTPForbidden(text=why)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        if not isinstance(body, dict):
            raise web.HTTPBadRequest(text="the body must be a JSON object")
        return body

    def ref_path(body):
        if body.get("path"):
            return resolve(str(body["path"]))
        if body.get("filename"):
            try:
                base = folder_paths.get_directory_by_type(body.get("type") or "output")
            except Exception:  # noqa: BLE001
                base = None
            if not base:
                return None
            p = os.path.abspath(os.path.join(base, str(body.get("subfolder") or ""), str(body["filename"])))
            return p if path_access.within(p, base) else None
        return None

    async def h_open(request):
        body = await guarded_json(request)
        try:
            if isinstance(body.get("new"), dict):
                tok = open_doc(new=body["new"])
                return web.json_response(describe(tok, BOOK.get(tok)))
            path = ref_path(body)
            if not path or not os.path.isfile(path):
                return err("no such file", 404)
            if not may_open(path):
                return err(f"{os.path.basename(path)} is not a picture, .ora or .psd", 415)
            if not (path_access.may_serve(path) if not is_paint_file(path) else path_access.is_allowed(path)):
                return err("that file is outside the folders the viewer may open", 403)
            tok, _doc = await off(open_doc, path)
            s = BOOK.get(tok)
            out = describe(tok, s)
            out["source"] = path
            return web.json_response(out)
        except (PaintError, ValueError, OSError) as e:
            return err(e)

    async def h_px(request):
        s = BOOK.get(request.query.get("token"))
        if not s:
            return err("that document is no longer open", 404)
        q = request.query
        part = "sel" if q.get("sel") else (f"layer:{q['layer']}" if q.get("layer") else
                                          f"src:{q['src']}" if q.get("src") else f"mask:{q.get('mask', '')}")
        try:
            raw = await off(pixels_of, s, part)
        except PaintError as e:
            return err(e, 404)
        body = await off(gzip.compress, raw, 1)
        return web.Response(body=body, headers={"Content-Type": "application/octet-stream", "Content-Encoding": "gzip",
                                                "Cache-Control": "no-store"})

    async def h_stage(request):
        if not path_access._own_host(request.host):
            return err("refused", 403)
        s = BOOK.get(request.query.get("token"))
        if not s:
            return err("that document is no longer open", 404)
        if (request.content_length or 0) > MAX_STAGE_BYTES:
            return err("too large", 413)
        data = await request.read()
        try:
            await off(stage, s, request.query.get("part"), data, request.headers.get("X-ImageViewer-Enc") == "gzip")
        except (PaintError, OSError, EOFError) as e:
            return err(e)
        return web.json_response({"ok": True})

    async def h_save(request):
        body = await guarded_json(request)
        s = BOOK.get(body.get("token"))
        if body.get("failed"):
            synced(body, str(body["failed"])[:200])
            return web.json_response({"ok": False})
        if not s:
            synced(body, "that document is no longer open")
            return err("that document is no longer open - open it again", 404)
        try:
            await off(commit, s, body.get("meta"), body.get("keep"))
            if body.get("write") is False:
                synced(body)
                return web.json_response({"ok": True, "path": s.path, "written": False})
            res = await off(save, s, export_rules, output_dir(), as_new=bool(body.get("as_new")),
                            name=body.get("name"), context=body.get("context"), is_allowed=path_access.is_allowed)
            return web.json_response({"ok": True, "written": True, **res})
        except (PaintError, ValueError, OSError) as e:
            return err(e)

    async def h_save_as(request):
        body = await guarded_json(request)
        s = BOOK.get(body.get("token"))
        if not s:
            return err("that document is no longer open - open it again", 404)
        try:
            if isinstance(body.get("meta"), dict):
                await off(commit, s, body["meta"], body.get("keep"))
            res = await off(save_as, s, body.get("folder"), body.get("name"), body.get("format") or "ora",
                            overwrite=bool(body.get("overwrite")), is_allowed=path_access.is_allowed)
            return web.json_response({"ok": True, "written": True, **res})
        except Exists as e:
            return web.json_response({"error": str(e), "exists": True, "path": e.path}, status=409)
        except (PaintError, ValueError, OSError) as e:
            return err(e)

    async def h_export(request):
        body = await guarded_json(request)
        s = BOOK.get(body.get("token"))
        if not s:
            return err("that document is no longer open", 404)
        try:
            if isinstance(body.get("meta"), dict):
                await off(commit, s, body["meta"], body.get("keep"))
            res = await off(export, s, export_rules, output_dir(), body.get("format"), name=body.get("name"),
                            context=body.get("context"), quality=body.get("quality", 92))
            return web.json_response({"ok": True, **res})
        except (PaintError, ValueError, OSError) as e:
            return err(e)

    async def h_doc(request):
        body = await guarded_json(request)
        ref = body.get("doc") or body.get("path") or body.get("token")
        if not ref:
            return err("'doc' (the .ora / .psd / picture's path) is needed")
        live = bool(body.get("sync")) and isinstance(ref, str) and bool(_TOKEN.fullmatch(ref))
        try:
            if live:
                if not BOOK.get(ref):
                    return err("that document is no longer open", 404)
                await page_sync(ref)
            answer, tok = await off(agent_ops, ref, body.get("ops"), resolve=resolve, is_allowed=path_access.is_allowed,
                                    may_serve=path_access.may_serve, export_rules=export_rules, output_dir=output_dir(),
                                    write=body.get("write") is not False, save_new=live)
        except (O.OpError, PaintError, ValueError, OSError) as e:
            return err(e)
        if body.get("ops"):
            try:
                send("imageviewer.paint.changed", {"path": answer.get("path"), "token": tok, "written": bool(answer.get("written")),
                                             "said": answer.get("said", []), "from": body.get("from") or "agent",
                                             "synced": live})
            except Exception:  # noqa: BLE001 - no page listening is fine
                pass
            if tok:
                answer["token"] = tok
        return web.json_response(answer)

    async def h_describe(request):
        body = await guarded_json(request)
        tok = body.get("token")
        s = BOOK.get(tok)
        if not s:
            return err("that document is no longer open", 404)
        return web.json_response(describe(tok, s))

    async def h_snapshot(request):
        body = await guarded_json(request)
        s = BOOK.get(body.get("token"))
        if not s:
            return err("that document is no longer open", 404)
        try:
            res = await off(snapshot, s, folder_paths.get_input_directory())
            res["path"] = s.path
            return web.json_response(res)
        except (PaintError, ValueError, OSError) as e:
            return err(e)

    # ── Generate with ready-made workflows (paint_generate) ──

    def node_classes():
        try:
            import nodes  # ComfyUI's own: what node classes this server has
            return set(nodes.NODE_CLASS_MAPPINGS)
        except Exception:  # noqa: BLE001 - not inside ComfyUI (the tests): no check
            return None

    async def h_workflows(request):
        if request.method == "GET":
            return web.json_response(await off(G.listing, folder_paths, node_classes()))
        body = await guarded_json(request)
        action = body.get("action")
        try:
            if "graph" in body:
                slots = await off(G.set_custom, action, body.get("graph"), body.get("name") or "", body.get("source") or "file")
            elif body.get("choice"):
                await off(G.set_choice, action, str(body["choice"]))
                slots = None
            else:
                return err("'graph' (or null) or 'choice' is needed")
        except (G.GenerateError, OSError) as e:
            return err(e)
        out = await off(G.listing, folder_paths, node_classes())
        out["slots"] = slots
        return web.json_response(out)

    async def h_generate(request):
        body = await guarded_json(request)
        s = BOOK.get(body.get("token"))
        if not s:
            return err("that document is no longer open", 404)
        try:
            res = await off(G.prepare, s, body.get("token"), body.get("action"), folder_paths.get_input_directory(),
                            wid=body.get("workflow") or None, prompt=body.get("prompt") or "",
                            variations=body.get("variations") or 1, k=body.get("k") or 2,
                            folder_paths=folder_paths, node_classes=node_classes())
        except G.Missing as e:
            return web.json_response({"error": str(e), "missing": e.missing}, status=409)
        except (G.GenerateError, OSError) as e:
            return err(e)
        return web.json_response(res)

    async def h_generate_place(request):
        body = await guarded_json(request)
        img = body.get("image") if isinstance(body.get("image"), dict) else {}
        path = ref_path(img)
        if not path or not os.path.isfile(path) or not path_access.may_serve(path):
            return err("the workflow's picture was not found", 404)
        try:
            res = await off(G.place, str(body.get("job") or ""), path, folder_paths.get_input_directory(), int(body.get("n") or 0))
        except (G.GenerateError, OSError, ValueError) as e:
            return err(e)
        return web.json_response(res)

    for method, name, h in (("GET", "workflows", h_workflows), ("POST", "workflows", h_workflows),
                            ("POST", "generate", h_generate), ("POST", "generate_place", h_generate_place)):
        add(method, "/imageviewer/paint/" + name, h)
        add(method, "/api/imageviewer/paint/" + name, h)

    for method, name, h in (("POST", "open", h_open), ("GET", "px", h_px), ("POST", "stage", h_stage),
                            ("POST", "save", h_save), ("POST", "save_as", h_save_as), ("POST", "export", h_export), ("POST", "doc", h_doc),
                            ("POST", "describe", h_describe), ("POST", "snapshot", h_snapshot)):
        add(method, "/imageviewer/paint/" + name, h)
        add(method, "/api/imageviewer/paint/" + name, h)
