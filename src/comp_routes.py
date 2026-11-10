"""The Comp space's routes: a comp file read and saved, the pixels its Reads name (for the page's preview),
and a render of its Output by the export rule.

    GET  /imageviewer/comp?path=<x.comp.json>            -> {path, comp}
    POST /imageviewer/comp {path, comp}                  save (same_origin, the allowed folders)
    POST /imageviewer/comp_new {name?, context?, width?, height?, fps?, frames?}
                                                          a new comp file by the export rule (kind "comp")
    GET  /imageviewer/comp_source?file=&comp=            what a Read's file is: {kind, first, last, ...}
    GET  /imageviewer/comp_pixels?file=&comp=&frame=&offset=&cs=&max=
                                                          one frame of a Read: float16 premultiplied linear
                                                          RGBA, gzip; X-Comp-W / -H (sent) and -OW / -OH (the file's)
    GET  /imageviewer/comp_ocio                          the OCIO config: {available, working, colorspaces, displays}
    GET  /imageviewer/comp_lut?src=&dst= | ?src=&display=&view=
                                                          a transform baked for the preview: float32 LUT, gzip;
                                                          X-Lut-Size, X-Lut-Shaper (comp_ocio.bake)
    POST /imageviewer/comp_render {path, format, codec?, quality?, first?, last?, name?, context?, display?, view?}
                                                          -> {job}; GET ?job= -> its state; POST {job, cancel}
    POST /imageviewer/comp_export_nuke {path, name?, context?, bake?}
                                                          -> {job}: a .nk by the export rule (kind "comp"), the nodes
                                                          Nuke has none for baked to EXR beside it (comp_nuke);
                                                          GET ?job= -> its state; POST {job, cancel}

A Read's pixels go through the same reader as the render (``comp_io.Sources``), so the preview shows what the
render will write - EXR and films included, which a browser cannot decode as floats. Everything that hands
back bytes is ``path_access.may_serve``; the comp file itself is not media and only ``is_allowed``. No route
starts a process: films are read and written by PyAV in this process.
"""
from __future__ import annotations

import gzip
import os
import re
import secrets
import threading
import time

import numpy as np

from . import comp_io
from . import comp_nuke
from . import comp_model as M

MAX_JOBS = 8
PIXEL_MAX = 4096


class _Readers:
    """Readers kept between preview requests (a film is opened once), a few at a time."""

    def __init__(self, allow, keep=6):
        self.allow, self.keep = allow, keep
        self.lock = threading.Lock()
        self.by_comp = {}

    def get(self, comp_path):
        with self.lock:
            src = self.by_comp.pop(comp_path, None) or comp_io.Sources(comp_path, allow=self.allow)
            self.by_comp[comp_path] = src
            while len(self.by_comp) > self.keep:
                old = self.by_comp.pop(next(iter(self.by_comp)))
                old.close()
            return src


def register(add, *, web, path_access, export_rules, folder_paths, resolve=None):
    """Add the routes through ``add(method, path, handler)``; each under /imageviewer and /api/imageviewer."""
    import asyncio

    readers = _Readers(path_access.may_serve)
    pixel_lock = threading.Lock()
    jobs = {}

    def off(fn, *a, **k):
        return asyncio.get_running_loop().run_in_executor(None, lambda: fn(*a, **k))

    def err(e, status=400):
        return web.json_response({"error": str(e)}, status=status)

    def abspath(p):
        p = str(p or "").strip()
        if resolve and p:
            p = resolve(p) or p
        return os.path.abspath(p) if p else ""

    async def body_of(request):
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

    def comp_path_ok(p):
        if not M.is_comp_path(p):
            return f"not a comp (the file name must end in {M.SUFFIX})"
        if not path_access.is_allowed(p):
            return path_access.refusal(p)
        return None

    # ── the file ─────────────────────────────────────────────────────────────

    async def get_comp(request):
        path = abspath(request.query.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        if not os.path.isfile(path):
            return err("file not found", 404)
        try:
            comp = await off(comp_io.read, path)
        except (ValueError, OSError) as e:
            return err(e, 422)
        return web.json_response({"path": path, "comp": comp}, headers={"Cache-Control": "no-cache"})

    async def save_comp(request):
        body = await body_of(request)
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            await off(comp_io.write, path, body.get("comp"))
        except ValueError as e:
            return err(e, 422)
        except OSError as e:
            return err(f"not saved: {e}", 500)
        return web.json_response({"ok": True, "path": path})

    def save_as_path(folder, name):
        """``<folder>/<name>.comp.json``: the name keeps no folder of its own and loses what is not a file name's."""
        stem = os.path.basename(str(name or "").strip().replace("\\", "/"))
        for end in (M.SUFFIX, ".json"):
            if stem.lower().endswith(end):
                stem = stem[: -len(end)]
        stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")
        if not stem:
            raise ValueError("give the comp a name")
        folder = abspath(folder)
        if not folder:
            raise ValueError("give a folder")
        return os.path.join(folder, stem + M.SUFFIX)

    async def save_as(request):
        """Save as: the comp written to a new file (409 ``{exists, path}`` when one is there, unless ``overwrite``)."""
        body = await body_of(request)
        try:
            path = save_as_path(body.get("folder"), body.get("name"))
        except ValueError as e:
            return err(e)
        why = comp_path_ok(path)
        if why:
            return err(why, 403)
        if os.path.exists(path) and not body.get("overwrite"):
            return web.json_response({"error": "there is a file of that name", "exists": True, "path": path}, status=409)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            await off(comp_io.write, path, body.get("comp"))
        except ValueError as e:
            return err(e, 422)
        except OSError as e:
            return err(f"not saved: {e}", 500)
        return web.json_response({"ok": True, "path": path})

    def new_target(name, context):
        t = export_rules.target("comp", name or "comp", "json", folder_paths.get_output_directory(), context)
        path = t["path"][: -len(".json")] + M.SUFFIX
        return path, t["version"]

    async def new_comp(request):
        body = await body_of(request)
        try:
            path, version = new_target(body.get("name"), body.get("context"))
        except ValueError as e:
            return err(e)
        fmt = {k: body[k] for k in ("width", "height", "fps", "frames") if isinstance(body.get(k), (int, float))}
        comp, _ = M.normalize(dict(M.new_comp(), format=dict(M.new_comp()["format"], **fmt)))
        try:
            await off(comp_io.write, path, comp)
        except (ValueError, OSError) as e:
            return err(f"not created: {e}", 500)
        return web.json_response({"path": path, "comp": comp, "version": version})

    # ── what a Read names ────────────────────────────────────────────────────

    def read_node(q):
        node = {"type": "read", "file": q.get("file") or "", "offset": 0, "colorspace": q.get("cs") or "auto"}
        try:
            node["offset"] = int(q.get("offset") or 0)
        except ValueError:
            pass
        return node

    async def get_source(request):
        comp_path = abspath(request.query.get("comp"))
        node = read_node(request.query)
        src = readers.get(comp_path or None)
        path, info = await off(src.info, node)
        return web.json_response(dict(info, path=path, name=os.path.basename(path)), headers={"Cache-Control": "no-cache"})

    def pixels(comp_path, node, frame, most):
        src = readers.get(comp_path or None)
        with pixel_lock:
            path, info = src.info(node)
            if info.get("kind") == "refused":
                return 403, path_access.serve_refusal(path)
            img = src(node, frame)
        if img is None:
            return 404, f"{os.path.basename(path) or 'the Read'} has no picture at frame {frame}"
        oh, ow = img.shape[:2]
        k = max(1, -(-max(ow, oh) // most))
        small = comp_io.shrink(img, k)
        return 200, (small, ow, oh)

    async def get_pixels(request):
        q = request.query
        comp_path = abspath(q.get("comp"))
        try:
            frame = int(q.get("frame") or 0)
            most = max(16, min(PIXEL_MAX, int(q.get("max") or PIXEL_MAX)))
        except ValueError:
            return err("frame and max are numbers")
        status, got = await off(pixels, comp_path, read_node(q), frame, most)
        if status != 200:
            return err(got, status)
        img, ow, oh = got
        data = await off(lambda: gzip.compress(comp_io.as_f16(img), 1))
        return web.Response(body=data, content_type="application/octet-stream", headers={
            "X-Comp-W": str(img.shape[1]), "X-Comp-H": str(img.shape[0]), "X-Comp-OW": str(ow), "X-Comp-OH": str(oh),
            "X-ImageViewer-Enc": "gzip", "Cache-Control": "no-cache",
            "Access-Control-Expose-Headers": "X-Comp-W, X-Comp-H, X-Comp-OW, X-Comp-OH, X-ImageViewer-Enc"})

    # ── rendering ────────────────────────────────────────────────────────────

    def run_job(job, comp, comp_path, spec):
        sources = comp_io.Sources(comp_path, allow=path_access.may_serve)
        fmt, f0, f1 = spec["format"], spec["first"], spec["last"]
        out_dir = folder_paths.get_output_directory()
        name = spec["name"]
        writer = None
        try:
            enc = comp_io.display_encoder(spec.get("display"), spec.get("view"))
            frames = range(f0, f1 + 1)
            job["total"] = len(frames)
            if fmt in comp_io.VIDEO_FORMATS:
                how = export_rules.video_settings(fmt, spec.get("codec"), spec.get("quality") or "high")
                t = export_rules.target("comp", name, fmt, out_dir, spec.get("context"))
                writer = comp_io.VideoWriter(t["path"], how, comp["format"]["fps"], comp["format"]["width"],
                                             comp["format"]["height"], enc)
                result = {"kind": "video", "path": t["path"], "relative": t["relative"], "version": t["version"],
                          "label": how["label"]}
            elif len(frames) == 1:
                t = export_rules.target("comp", name, fmt, out_dir, spec.get("context"))
                result = {"kind": "image", "path": t["path"], "relative": t["relative"], "version": t["version"]}
            else:
                seq = export_rules.sequence_target("comp", name, fmt, out_dir, spec.get("context"))
                result = {"kind": "image", "isSequence": True, "seqDir": seq["folder"], "relative": seq["relative"],
                          "version": seq["version"]}
            for f, img in comp_io.render_frames(comp, frames, sources):
                if job.get("cancel"):
                    raise InterruptedError
                if writer is not None:
                    writer.add(img)
                elif result.get("isSequence"):
                    p = export_rules.sequence_frame(seq, f)
                    comp_io.write_still(img, p, fmt, enc)
                    result.setdefault("path", p)
                    result.setdefault("paths", []).append(p)
                else:
                    comp_io.write_still(img, result["path"], fmt, enc)
                job["done"] += 1
            if writer is not None:
                writer.close(True)
                writer = None
            job.update(state="done", result=dict(result, frames=job["done"], notes=sources.notes))
        except InterruptedError:
            job.update(state="stopped")
        except Exception as e:  # noqa: BLE001 - said to the page
            job.update(state="error", error=str(e))
        finally:
            if writer is not None:
                writer.close(False)
            sources.close()
            job["ended"] = time.time()

    async def render(request):
        if request.method == "GET":
            job = jobs.get(request.query.get("job") or "")
            if not job:
                return err("no such render", 404)
            return web.json_response({k: job.get(k) for k in ("state", "done", "total", "result", "error")})
        body = await body_of(request)
        if body.get("job"):
            job = jobs.get(str(body["job"]))
            if not job:
                return err("no such render", 404)
            if body.get("cancel"):
                job["cancel"] = True
            return web.json_response({"ok": True})
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            comp, _ = M.normalize(await off(comp_io.read, path))
        except (ValueError, OSError) as e:
            return err(e, 422)
        if not comp["output"]:
            return err("the comp has no Output node", 422)
        fmt = str(body.get("format") or "png").lower()
        if fmt not in comp_io.STILL_EXTS + comp_io.VIDEO_FORMATS:
            return err(f"unknown format: {fmt}")
        last = comp["format"]["frames"] - 1
        try:
            f0 = max(0, min(last, int(body.get("first", 0))))
            f1 = max(f0, min(last, int(body.get("last", last))))
        except (TypeError, ValueError):
            return err("first and last are frame numbers")
        base = os.path.basename(path)[: -len(M.SUFFIX)]
        spec = {"format": fmt, "first": f0, "last": f1, "codec": body.get("codec"), "quality": body.get("quality"),
                "name": export_rules.slug(body.get("name") or base, "comp"), "context": body.get("context"),
                "display": str(body.get("display") or ""), "view": str(body.get("view") or "")}
        for k in [k for k, j in jobs.items() if j.get("ended")][: max(0, len(jobs) - MAX_JOBS + 1)]:
            jobs.pop(k, None)
        jid = secrets.token_hex(8)
        job = jobs[jid] = {"state": "running", "done": 0, "total": f1 - f0 + 1}
        threading.Thread(target=run_job, args=(job, comp, path, spec), daemon=True, name=f"comp-render-{jid}").start()
        return web.json_response({"job": jid, "total": job["total"]})

    # ── Export to Nuke ───────────────────────────────────────────────────────

    def run_nuke(job, comp, comp_path, spec):
        sources = comp_io.Sources(comp_path, allow=path_access.may_serve)
        try:
            t = export_rules.target("comp", spec["name"], "nk", folder_paths.get_output_directory(), spec.get("context"))
            nk = t["path"]
            stem = os.path.splitext(os.path.basename(nk))[0]
            bake_dir = os.path.join(os.path.dirname(nk), f"{stem}_bake")
            text, plan = comp_nuke.build(comp, info_of=sources.info, nk_path=nk, bake_dir=bake_dir, bake=spec["bake"])
            frames = range(comp["format"]["frames"])
            job["total"] = len(frames) * len(plan["bake"]) + 1
            hook = comp_io.ocio_hook()
            for f in frames:
                memo = {}
                for b in plan["bake"]:
                    if job.get("cancel"):
                        raise InterruptedError
                    img = M.render_node(comp, b["id"], f, sources, 1.0, memo=memo, ocio=hook)
                    comp_nuke.write_exr(img, os.path.join(b["dir"], f"{b['name']}.{f:04d}.exr"))
                    job["done"] += 1
            os.makedirs(os.path.dirname(nk), exist_ok=True)
            tmp = nk + ".part"
            with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            os.replace(tmp, nk)
            readme = os.path.join(os.path.dirname(nk), f"{stem}_README.txt")
            with open(readme, "w", encoding="utf-8") as fh:
                fh.write(comp_nuke.readme(plan, os.path.basename(nk)))
            job["done"] += 1
            job.update(state="done", result={"path": nk, "relative": t["relative"], "version": t["version"],
                                             "readme": readme, "bake_dir": bake_dir if plan["bake"] else "",
                                             "baked": [b["name"] for b in plan["bake"]], "notes": plan["notes"] + sources.notes,
                                             "placeholder": plan["placeholder"]})
        except InterruptedError:
            job.update(state="stopped")
        except Exception as e:  # noqa: BLE001 - said to the page
            job.update(state="error", error=str(e))
        finally:
            sources.close()
            job["ended"] = time.time()

    async def export_nuke(request):
        if request.method == "GET":
            job = jobs.get(request.query.get("job") or "")
            if not job:
                return err("no such export", 404)
            return web.json_response({k: job.get(k) for k in ("state", "done", "total", "result", "error")})
        body = await body_of(request)
        if body.get("job"):
            job = jobs.get(str(body["job"]))
            if not job:
                return err("no such export", 404)
            if body.get("cancel"):
                job["cancel"] = True
            return web.json_response({"ok": True})
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            comp, _ = M.normalize(await off(comp_io.read, path))
        except (ValueError, OSError) as e:
            return err(e, 422)
        if not comp["output"]:
            return err("the comp has no Output node", 422)
        base = os.path.basename(path)[: -len(M.SUFFIX)]
        spec = {"name": export_rules.slug(body.get("name") or base, "comp"), "context": body.get("context"),
                "bake": body.get("bake") is not False}
        for k in [k for k, j in jobs.items() if j.get("ended")][: max(0, len(jobs) - MAX_JOBS + 1)]:
            jobs.pop(k, None)
        jid = secrets.token_hex(8)
        job = jobs[jid] = {"state": "running", "done": 0, "total": 1}
        threading.Thread(target=run_nuke, args=(job, comp, path, spec), daemon=True, name=f"comp-nuke-{jid}").start()
        return web.json_response({"job": jid})

    # ── OpenColorIO ──────────────────────────────────────────────────────────

    async def get_ocio(request):
        from . import comp_ocio
        try:
            got = await off(comp_ocio.info)
        except Exception as e:  # noqa: BLE001 - no OCIO here: said, not raised
            got = {"available": False, "error": str(e), "colorspaces": [], "displays": []}
        return web.json_response(got, headers={"Cache-Control": "no-cache"})

    async def get_lut(request):
        from . import comp_ocio
        q = request.query
        spec = {"src": q.get("src") or ""}
        if q.get("display"):
            spec.update(display=q.get("display"), view=q.get("view") or "*")
        else:
            spec["dst"] = q.get("dst") or ""
        try:
            got = await off(comp_ocio.bake, spec)
        except Exception as e:  # noqa: BLE001
            return err(e, 500)
        if got is None:
            return err("the OCIO config cannot do that transform (or OpenColorIO is not installed)", 404)
        size, shaper, data = got
        body = await off(lambda: gzip.compress(np.ascontiguousarray(data, dtype="<f4").tobytes(), 1))
        return web.Response(body=body, content_type="application/octet-stream", headers={
            "X-Lut-Size": str(size), "X-Lut-Shaper": shaper, "X-ImageViewer-Enc": "gzip", "Cache-Control": "max-age=60",
            "Access-Control-Expose-Headers": "X-Lut-Size, X-Lut-Shaper, X-ImageViewer-Enc"})

    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("GET", f"{prefix}/comp_ocio", get_ocio)
        add("GET", f"{prefix}/comp_lut", get_lut)
        add("GET", f"{prefix}/comp", get_comp)
        add("POST", f"{prefix}/comp", save_comp)
        add("POST", f"{prefix}/comp_new", new_comp)
        add("POST", f"{prefix}/comp_save_as", save_as)
        add("GET", f"{prefix}/comp_source", get_source)
        add("GET", f"{prefix}/comp_pixels", get_pixels)
        add("GET", f"{prefix}/comp_render", render)
        add("POST", f"{prefix}/comp_render", render)
        add("GET", f"{prefix}/comp_export_nuke", export_nuke)
        add("POST", f"{prefix}/comp_export_nuke", export_nuke)
