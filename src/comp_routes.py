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
    GET  /imageviewer/comp_formats - the Send to Viewer node's formats and per-format options (file_writer)
    POST /imageviewer/comp_render {path, format, options? {bit_depth, compression, quality, compress_level, codec},
                                   first_number?, padding?, first?, last?, name?, context?, display?, view?}
                                                          -> {job}; GET ?job= -> its state; POST {job, cancel}
    POST /imageviewer/comp_export_nuke {path, name?, context?, bake?}
                                                          -> {job}: a .nk by the export rule (kind "comp"), the nodes
                                                          Nuke has none for baked to EXR beside it (comp_nuke);
                                                          GET ?job= -> its state; POST {job, cancel}
    POST /imageviewer/comp_write_plan {path, comp?, writes?, first?, last?, handles?}
                                                          the Write nodes' files, written nothing (comp_write.plan)
    POST /imageviewer/comp_write {path, writes?, first?, last?, handles?}
                                                          -> {job}: every Write writes its own files; GET / cancel
    POST /imageviewer/comp_metadata {path, comp?, node, frame}  what the image carries there (comp_write.metadata_at)
    GET  /imageviewer/comp_autosave?path= / POST {path, comp | drop}
                                                          the page's unsaved comp kept aside (comp_pipeline)
    POST /imageviewer/comp_ops {path | create, ops?}      the agent's edits (comp_api.apply), saved, the tab told
    GET  /imageviewer/comp_summary?path=                  the comp as the agent reads it
    POST /imageviewer/comp_relink {path, folder, ids?}    missing Reads looked for by name under a folder
    POST /imageviewer/comp_localise {path, ids?}          -> {job}: footage copied into input/comp_footage
    POST /imageviewer/comp_farm {path, writes?, ..., chunk, pool, group, priority, dry_run?}
                                                          the Writes as one Deadline job, relayed to agentY's
                                                          /agentY/comp_farm; dry_run answers the request + warnings

A Read's pixels go through the same reader as the render (``comp_io.Sources``), so the preview shows what the
render will write - EXR and films included, which a browser cannot decode as floats. Everything that hands
back bytes is ``path_access.may_serve``; the comp file itself is not media and only ``is_allowed``. No route
starts a process: films are read and written by PyAV in this process.
"""
from __future__ import annotations

import gzip
import math
import os
import re
import secrets
import threading
import time

import numpy as np

from . import comp_io
from . import comp_nuke
from . import comp_track
from . import comp_write as CW
from . import comp_pipeline as CP
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


def register(add, *, web, path_access, export_rules, folder_paths, resolve=None, send=None):
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
        out = {"path": path, "comp": comp}
        rec = await off(CP.recovery, path)
        if rec:
            out["autosave"] = {"time": rec["time"]}
        return web.json_response(out, headers={"Cache-Control": "no-cache"})

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
        await off(CP.drop_autosave, path)
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
        node = {"type": "read", "file": q.get("file") or "", "offset": 0, "colorspace": q.get("cs") or "auto",
                "missing": q.get("missing") or "black", "local": q.get("local") or ""}
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
            try:
                img = src(node, frame)
            except comp_io.MissingFrame as e:
                return 404, str(e)
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
                how = export_rules.video_settings(fmt, spec.get("codec"), comp_io.film_quality(spec.get("quality")))
                t = export_rules.target("comp", name, fmt, out_dir, spec.get("context"))
                size = M.format_at(comp, comp.get("output"))   # a Reformat before the Output changes it
                writer = comp_io.VideoWriter(t["path"], how, comp["format"]["fps"], size["width"], size["height"], enc)
                result = {"kind": "video", "path": t["path"], "relative": t["relative"], "version": t["version"],
                          "label": how["label"]}
            elif len(frames) == 1:
                t = export_rules.target("comp", name, fmt, out_dir, spec.get("context"))
                result = {"kind": "image", "path": t["path"], "relative": t["relative"], "version": t["version"]}
            else:
                seq = export_rules.sequence_target("comp", name, fmt, out_dir, spec.get("context"))
                pad, start = spec["padding"], spec["first_number"]
                hashes = "#" * pad
                result = {"kind": "image", "isSequence": True, "seqDir": seq["folder"], "version": seq["version"],
                          "relative": seq["relative"].replace(".####.", f".{hashes}."), "firstNumber": start}
            for f, img in comp_io.render_frames(comp, frames, sources):
                if job.get("cancel"):
                    raise InterruptedError
                if writer is not None:
                    writer.add(img)
                elif result.get("isSequence"):
                    # Numbered as the node numbers a sequence: from its first frame number, at its padding.
                    p = os.path.join(seq["folder"], f"{seq['stem']}.{start + f - f0:0{pad}d}.{seq['ext']}")
                    comp_io.write_still(img, p, fmt, enc, spec["options"])
                    result.setdefault("path", p)
                    result.setdefault("paths", []).append(p)
                else:
                    comp_io.write_still(img, result["path"], fmt, enc, spec["options"])
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
        fmt = comp_io.ALIASES.get(fmt, fmt)
        if fmt not in comp_io.still_formats() + list(comp_io.VIDEO_FORMATS):
            return err(f"this ComfyUI cannot write {fmt}")
        opts = body.get("options") if isinstance(body.get("options"), dict) else {}
        options = {k: opts[k] for k in ("bit_depth", "compression", "quality", "compress_level", "codec") if k in opts}
        try:
            first_number = max(0, int(body.get("first_number", 1001)))
            padding = max(1, min(9, int(body.get("padding", 4))))
        except (TypeError, ValueError):
            return err("first_number and padding are numbers")
        last = comp["format"]["frames"] - 1
        try:
            f0 = max(0, min(last, int(body.get("first", 0))))
            f1 = max(f0, min(last, int(body.get("last", last))))
            handles = max(0, min(1000, int(body.get("handles") or 0)))
        except (TypeError, ValueError):
            return err("first, last and handles are frame numbers")
        f0, f1 = f0 - handles, f1 + handles     # a Read holds its first / last frame out there
        base = os.path.basename(path)[: -len(M.SUFFIX)]
        spec = {"format": fmt, "first": f0, "last": f1, "options": options, "first_number": first_number,
                "padding": padding, "codec": options.get("codec") or body.get("codec"),
                "quality": options.get("quality", body.get("quality")),
                "name": export_rules.slug(body.get("name") or base, "comp"), "context": body.get("context"),
                "display": str(body.get("display") or ""), "view": str(body.get("view") or "")}
        for k in [k for k, j in jobs.items() if j.get("ended")][: max(0, len(jobs) - MAX_JOBS + 1)]:
            jobs.pop(k, None)
        jid = secrets.token_hex(8)
        job = jobs[jid] = {"state": "running", "done": 0, "total": f1 - f0 + 1}
        threading.Thread(target=run_job, args=(job, comp, path, spec), daemon=True, name=f"comp-render-{jid}").start()
        return web.json_response({"job": jid, "total": job["total"]})

    # ── tracking ─────────────────────────────────────────────────────────────

    def run_track(job, comp, comp_path, spec):
        sources = comp_io.Sources(comp_path, allow=path_access.may_serve)
        hook = comp_io.ocio_hook()
        src_id = spec["input"]

        def get(f):
            return M.render_node(comp, src_id, f, sources, 1.0, ocio=hook)

        def progress(i, got):
            job["done"] = i + 1
            job["keys" if spec["kind"] == "points" else "plane"] = got
        try:
            if spec["kind"] == "points":
                got = comp_track.track_points(get, spec["frames"], spec["points"], cancel=lambda: job.get("cancel"), progress=progress)
                job["keys"] = got
            else:
                got = comp_track.track_plane(get, spec["frames"], spec["quad"], cancel=lambda: job.get("cancel"), progress=progress)
                job["plane"] = got
            job.update(state="stopped" if job.get("cancel") else "done", result={"frames": job["done"], "notes": sources.notes})
        except Exception as e:  # noqa: BLE001 - said to the page
            job.update(state="error", error=str(e))
        finally:
            sources.close()
            job["ended"] = time.time()

    def _num_pair(v, lo=None):
        if not isinstance(v, (list, tuple)) or len(v) < 2:
            return None
        try:
            a, b = float(v[0]), float(v[1])
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(a) and math.isfinite(b)):
            return None
        if lo is not None:
            a, b = max(lo, min(1000, a)), max(lo, min(1000, b))
        return [a, b]

    async def track(request):
        """POST {path, comp?, node, from, to, points: [{id, x, y, pattern, search}] | quad: [[x, y] x 4]} starts a
        job; GET ?job= says how far it got with the keys so far; POST {job, cancel} stops it."""
        if request.method == "GET":
            job = jobs.get(request.query.get("job") or "")
            if not job:
                return err("no such track", 404)
            return web.json_response({k: job.get(k) for k in ("state", "done", "total", "keys", "plane", "result", "error")})
        body = await body_of(request)
        if body.get("job"):
            job = jobs.get(str(body["job"]))
            if not job:
                return err("no such track", 404)
            if body.get("cancel"):
                job["cancel"] = True
            return web.json_response({"ok": True})
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            raw = body["comp"] if isinstance(body.get("comp"), dict) else await off(comp_io.read, path)
            comp, _ = M.normalize(raw)
        except (ValueError, OSError) as e:
            return err(e, 422)
        n = M.node_by_id(comp, str(body.get("node") or ""))
        if not n or n.get("type") not in ("tracker", "planartracker"):
            return err("no such Tracker or PlanarTracker in the comp", 422)
        src_id = (n.get("inputs") or [None])[0]
        if not src_id:
            return err("the tracker has nothing coming in to track", 422)
        last = comp["format"]["frames"] - 1
        try:
            f0 = max(0, min(last, int(body.get("from", 0))))
            f1 = max(0, min(last, int(body.get("to", last))))
        except (TypeError, ValueError):
            return err("from and to are frame numbers")
        step = 1 if f1 >= f0 else -1
        spec = {"input": src_id, "frames": list(range(f0, f1 + step, step))}
        if n["type"] == "tracker":
            pts = []
            for p in body.get("points") or []:
                if not isinstance(p, dict):
                    continue
                at = _num_pair([p.get("x"), p.get("y")])
                if not at:
                    continue
                pts.append({"id": str(p.get("id") or len(pts))[:64], "x": at[0], "y": at[1],
                            "pattern": _num_pair(p.get("pattern"), 5) or [21, 21], "search": _num_pair(p.get("search"), 7) or [61, 61]})
            if not pts:
                return err("no points to track (place one on the picture first)")
            spec.update(kind="points", points=pts[:64])
        else:
            quad = [_num_pair(q) for q in (body.get("quad") or [])][:4]
            if len(quad) != 4 or not all(quad):
                return err("the surface needs its four corners")
            spec.update(kind="plane", quad=quad)
        for k in [k for k, j in jobs.items() if j.get("ended")][: max(0, len(jobs) - MAX_JOBS + 1)]:
            jobs.pop(k, None)
        jid = secrets.token_hex(8)
        job = jobs[jid] = {"state": "running", "done": 0, "total": len(spec["frames"])}
        threading.Thread(target=run_track, args=(job, comp, path, spec), daemon=True, name=f"comp-track-{jid}").start()
        return web.json_response({"job": jid, "total": job["total"]})

    # ── Write nodes ──────────────────────────────────────────────────────────

    def write_refusal(plans):
        for p in plans:
            folder = os.path.dirname(p["pattern"])
            if not path_access.is_allowed(folder):
                return f'{p["name"]}: {path_access.refusal(folder)}'
            if not p["film"] and p["type"] not in comp_io.still_formats() and p["type"] != "exr":
                return f'{p["name"]}: this ComfyUI cannot write {p["type"]}'
        return None

    def plan_of(comp, path, body):
        def num(k):
            v = body.get(k)
            return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
        ids = body.get("writes")
        ids = None if ids in (None, "", "all") else [str(i) for i in ids] if isinstance(ids, list) else [str(ids)]
        return CW.plan(comp, path, ids, num("first"), num("last"), num("handles"))

    def public_plan(plans):
        return [{"id": p["id"], "name": p["name"], "pattern": p["pattern"], "type": p["type"], "film": p["film"],
                 "first": p["frames"][0], "last": p["frames"][-1], "count": len(p["frames"]),
                 "first_file": CW.files_of(p)[0], "last_file": CW.files_of(p)[-1]} for p in plans]

    async def write_plan(request):
        """POST {path, comp?, writes?, first?, last?, handles?} -> {writes: [...], refused?}: what a render of the
        Write nodes would write, nothing written. ``comp`` is the page's (unsaved) graph, else the file's."""
        body = await body_of(request)
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            comp, _ = M.normalize(body["comp"] if isinstance(body.get("comp"), dict) else await off(comp_io.read, path))
            plans = plan_of(comp, path, body)
        except (ValueError, OSError) as e:
            return err(e, 422)
        return web.json_response({"writes": public_plan(plans), "refused": write_refusal(plans)})

    def run_writes(job, comp, comp_path, plans):
        sources = comp_io.Sources(comp_path, allow=path_access.may_serve)
        try:
            done = CW.render(comp, comp_path, plans, sources, progress=lambda d, t: job.update(done=d, total=t),
                             cancelled=lambda: job.get("cancel"))
            job.update(state="done", result={"kind": "writes", "writes": done, "notes": sources.notes})
        except InterruptedError:
            job.update(state="stopped")
        except Exception as e:  # noqa: BLE001 - said to the page
            job.update(state="error", error=str(e))
        finally:
            sources.close()
            job["ended"] = time.time()

    async def render_writes(request):
        """POST {path, writes?: "all" | [ids], first?, last?, handles?} -> {job}: the comp file's Write nodes
        rendered (each its own files); GET ?job= -> its state; POST {job, cancel}."""
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
            plans = plan_of(comp, path, body)
        except (ValueError, OSError) as e:
            return err(e, 422)
        if not plans:
            return err("the comp has no Write node to render (or they are all switched off)", 422)
        why = write_refusal(plans)
        if why:
            return err(why, 403)
        for k in [k for k, j in jobs.items() if j.get("ended")][: max(0, len(jobs) - MAX_JOBS + 1)]:
            jobs.pop(k, None)
        jid = secrets.token_hex(8)
        job = jobs[jid] = {"state": "running", "done": 0, "total": sum(len(p["frames"]) for p in plans)}
        threading.Thread(target=run_writes, args=(job, comp, path, plans), daemon=True, name=f"comp-write-{jid}").start()
        return web.json_response({"job": jid, "total": job["total"], "writes": public_plan(plans)})

    async def get_metadata(request):
        """POST {path, comp, node, frame} -> {metadata}: what node ``node``'s picture carries at ``frame`` (the
        Read's file header, set / removed by Metadata nodes on the way down)."""
        body = await body_of(request)
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            comp, _ = M.normalize(body["comp"] if isinstance(body.get("comp"), dict) else await off(comp_io.read, path))
            frame = int(body.get("frame") or 0)
        except (TypeError, ValueError, OSError) as e:
            return err(e, 422)
        src = readers.get(path)

        def go():
            with pixel_lock:
                return CW.metadata_at(comp, str(body.get("node") or ""), frame, src)
        md = await off(go)
        return web.json_response({"metadata": {k: v if isinstance(v, (int, float, str, list)) else str(v) for k, v in md.items()}})

    # ── autosave and recovery ────────────────────────────────────────────────

    async def autosave(request):
        """POST {path, comp} keeps the page's unsaved comp; {path, drop: true} forgets it. GET ?path= -> {time, comp}
        (an autosave newer than the file), 404 when there is none."""
        if request.method == "GET":
            path = abspath(request.query.get("path"))
            why = comp_path_ok(path)
            if why:
                return err(why, 403 if M.is_comp_path(path) else 400)
            rec = await off(CP.recovery, path)
            if not rec:
                return err("no autosave newer than the file", 404)
            return web.json_response(rec, headers={"Cache-Control": "no-cache"})
        body = await body_of(request)
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        if body.get("drop"):
            return web.json_response({"ok": True, "dropped": await off(CP.drop_autosave, path)})
        try:
            t = await off(CP.autosave, path, body.get("comp"))
        except ValueError as e:
            return err(e, 422)
        except OSError as e:
            return err(f"not kept: {e}", 500)
        return web.json_response({"ok": True, "time": t})

    # ── the agent's edits ────────────────────────────────────────────────────

    async def ops(request):
        """POST {path, ops: [...], create?: {width, height, fps, frames}} -> {path, ids, comp: summary}: operations
        on a comp file (comp_api.Comp.apply), all or nothing, saved; an open tab without changes reads it again."""
        from . import comp_api
        body = await body_of(request)
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)

        def go():
            if os.path.isfile(path):
                c = comp_api.Comp.open(path)
            elif isinstance(body.get("create"), dict):
                f = body["create"]
                c = comp_api.Comp.new(**{k: f[k] for k in ("width", "height", "fps", "frames") if isinstance(f.get(k), (int, float))}, path=path)
            else:
                raise FileNotFoundError("no such comp (send create: {...} to make it)")
            got = c.apply(body.get("ops") or [])
            c.save()
            return {"path": c.path, "ids": got["ids"], "comp": c.summary()}
        try:
            out = await off(go)
        except FileNotFoundError as e:
            return err(e, 404)
        except (ValueError, OSError) as e:
            return err(e, 422)
        if send:
            try:
                send("imageviewer.comp.open", {"path": out["path"], "quiet": True})
            except Exception:  # noqa: BLE001 - no page listening
                pass
        return web.json_response(out)

    async def summary(request):
        """GET ?path= -> the comp as the agent reads it (comp_api.Comp.summary)."""
        from . import comp_api
        path = abspath(request.query.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            c = await off(comp_api.Comp.open, path)
        except (ValueError, OSError) as e:
            return err(e, 422)
        return web.json_response(c.summary(), headers={"Cache-Control": "no-cache"})

    # ── relinking and localising footage ─────────────────────────────────────

    async def relink(request):
        """POST {path, comp?, folder?} -> {missing: [{id, name, file}], found: {id: new file}}: the Reads whose
        footage is not there, and (with a folder) where files of their names are under it. Nothing is changed:
        the page sets the paths it takes (one undo step)."""
        body = await body_of(request)
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        folder = abspath(body.get("folder")) if body.get("folder") else ""
        if folder and (not os.path.isdir(folder) or not path_access.is_allowed(folder)):
            return err(path_access.refusal(folder) if os.path.isdir(folder) else "no such folder", 403 if os.path.isdir(folder) else 404)
        try:
            comp, _ = M.normalize(body["comp"] if isinstance(body.get("comp"), dict) else await off(comp_io.read, path))
        except (ValueError, OSError) as e:
            return err(e, 422)

        def go():
            src = comp_io.Sources(path)
            missing = CP.missing_reads(comp, path, src)
            found = CP.search(folder, missing, allow=path_access.is_allowed) if folder and missing else {}
            return {"missing": missing, "found": {k: CP.relative_or_absolute(v, path) for k, v in found.items()}}
        return web.json_response(await off(go))

    def run_localise(job, comp, comp_path, ids, cache):
        sources = comp_io.Sources(comp_path, allow=path_access.may_serve)
        try:
            got = CP.localise(comp, comp_path, sources, cache, ids, progress=lambda d, t: job.update(done=d, total=t),
                              cancelled=lambda: job.get("cancel"))
            job.update(state="done", result=dict(got, notes=sources.notes))
        except InterruptedError:
            job.update(state="stopped")
        except Exception as e:  # noqa: BLE001
            job.update(state="error", error=str(e))
        finally:
            job["ended"] = time.time()

    async def localise(request):
        """POST {path, comp?, ids?} -> {job}: the Reads' footage copied into ComfyUI's input/comp_footage (a copy
        kept up to date by size and time); the result's ``local`` {id: path} is what the page sets as each Read's
        ``local``. GET ?job= / POST {job, cancel} as the render's."""
        if request.method == "GET":
            job = jobs.get(request.query.get("job") or "")
            if not job:
                return err("no such job", 404)
            return web.json_response({k: job.get(k) for k in ("state", "done", "total", "result", "error")})
        body = await body_of(request)
        if body.get("job"):
            job = jobs.get(str(body["job"]))
            if not job:
                return err("no such job", 404)
            if body.get("cancel"):
                job["cancel"] = True
            return web.json_response({"ok": True})
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            comp, _ = M.normalize(body["comp"] if isinstance(body.get("comp"), dict) else await off(comp_io.read, path))
        except (ValueError, OSError) as e:
            return err(e, 422)
        ids = [str(i) for i in body.get("ids")] if isinstance(body.get("ids"), list) else None
        cache = os.path.join(folder_paths.get_input_directory(), "comp_footage")
        jid = secrets.token_hex(8)
        job = jobs[jid] = {"state": "running", "done": 0, "total": 1}
        threading.Thread(target=run_localise, args=(job, comp, path, ids, cache), daemon=True, name=f"comp-local-{jid}").start()
        return web.json_response({"job": jid})

    # ── the farm (agentY's Deadline tools) ───────────────────────────────────

    async def farm(request):
        """POST {path, writes?, first?, last?, handles?, chunk?, pool?, group?, priority?, name?, dry_run?} ->
        the job agentY submitted (``/agentY/comp_farm``: core's ``submit_comp``), or with ``dry_run`` what would be
        sent and what may break on the farm. The comp file is what renders: the page saves first."""
        import sys
        body = await body_of(request)
        path = abspath(body.get("path"))
        why = comp_path_ok(path)
        if why:
            return err(why, 403 if M.is_comp_path(path) else 400)
        try:
            comp, _ = M.normalize(await off(comp_io.read, path))
            plans = plan_of(comp, path, body)
        except (ValueError, OSError) as e:
            return err(e, 422)
        if not plans:
            return err("the comp has no Write node to render (or they are all switched off)", 422)
        why = write_refusal(plans)
        if why:
            return err(why, 403)
        script = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts", "comp_render.py"))
        try:
            req = CP.farm_request(plans, chunk=body.get("chunk"), pool=body.get("pool"), group=body.get("group"),
                                  priority=body.get("priority"), name=body.get("name"), comp_path=path,
                                  python=sys.executable, script=script)
        except (TypeError, ValueError) as e:
            return err(e)
        warnings = await off(CP.farm_warnings, comp, path, plans, comp_io.Sources(path))
        if body.get("dry_run"):
            return web.json_response({"request": req, "warnings": warnings, "writes": public_plan(plans)})
        from . import atlas_render
        base = f"{request.scheme}://{request.host}"
        try:
            out = await off(atlas_render.call_host, base, "POST", body=req, route="comp_farm", timeout=240.0)
        except atlas_render.RelayError as e:
            return err(e, e.status)
        return web.json_response(dict(out if isinstance(out, dict) else {"result": out}, warnings=warnings))

    # ── Export to Nuke ───────────────────────────────────────────────────────

    def run_nuke(job, comp, comp_path, spec):
        sources = comp_io.Sources(comp_path, allow=path_access.may_serve)
        try:
            t = export_rules.target("comp", spec["name"], "nk", folder_paths.get_output_directory(), spec.get("context"))
            nk = t["path"]
            stem = os.path.splitext(os.path.basename(nk))[0]
            bake_dir = os.path.join(os.path.dirname(nk), f"{stem}_bake")
            text, plan = comp_nuke.build(comp, info_of=sources.info, nk_path=nk, bake_dir=bake_dir, bake=spec["bake"], comp_path=comp_path)
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

    async def get_formats(request):
        return web.json_response(comp_io.formats(), headers={"Cache-Control": "no-cache"})

    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("GET", f"{prefix}/comp_formats", get_formats)
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
        add("GET", f"{prefix}/comp_track", track)
        add("POST", f"{prefix}/comp_track", track)
        add("GET", f"{prefix}/comp_export_nuke", export_nuke)
        add("POST", f"{prefix}/comp_write_plan", write_plan)
        add("GET", f"{prefix}/comp_write", render_writes)
        add("POST", f"{prefix}/comp_write", render_writes)
        add("POST", f"{prefix}/comp_metadata", get_metadata)
        add("GET", f"{prefix}/comp_autosave", autosave)
        add("POST", f"{prefix}/comp_autosave", autosave)
        add("POST", f"{prefix}/comp_ops", ops)
        add("GET", f"{prefix}/comp_summary", summary)
        add("POST", f"{prefix}/comp_relink", relink)
        add("GET", f"{prefix}/comp_localise", localise)
        add("POST", f"{prefix}/comp_localise", localise)
        add("POST", f"{prefix}/comp_farm", farm)
        add("POST", f"{prefix}/comp_export_nuke", export_nuke)
