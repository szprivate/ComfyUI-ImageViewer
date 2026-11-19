"""The Matchmove panels' routes (/imageviewer/mm_*): the plate's facts and frames, tracking, the lens, the solves,
the undistorted plate for the 3D space and the lens handed to Comp.

Every path is a plate the page names: read only through ``path_access.may_serve`` (media), and every route with
an effect is a same-origin JSON POST. No process is started. The maths is matchmove.py and matchmove_solve.py.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import secrets
import threading
import time

import numpy as np

from . import comp_io
from . import comp_model as M
from . import matchmove as MM
from . import matchmove_solve as MS

MAX_JOBS = 16
MAX_SIDE = 4096           # the frame route's largest picture
MM_SUFFIX = ".mm.json"
MM_MAX_BYTES = 64 * 1024 * 1024
PHOTO_EXTS = (".heic", ".heif", ".hif")


_FRAME_NO = re.compile(r"^(.*?)(\d{3,})(\.[A-Za-z0-9]+)$")
_STILL_EXTS = {".exr", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".dpx", ".webp", ".bmp"}


def as_sequence(path):
    """One frame of a numbered sequence (shot.1001.exr, with shot.1002.exr beside it) as the sequence's pattern
    (shot.####.exr); anything else as it is."""
    if not path or comp_io.is_sequence(path):
        return path
    folder, name = os.path.split(path)
    m = _FRAME_NO.match(name)
    if not m or m.group(3).lower() not in _STILL_EXTS:
        return path
    head, digits, ext = m.group(1), m.group(2), m.group(3)
    n = int(digits)
    for other in (n + 1, n - 1):
        if other >= 0 and os.path.isfile(os.path.join(folder, f"{head}{other:0{len(digits)}d}{ext}")):
            return os.path.join(folder, f"{head}{'#' * len(digits)}{ext}")
    return path


def _read_node(path):
    return {"type": "read", "file": path, "offset": 0, "colorspace": "auto", "missing": "hold", "local": ""}


class Plate:
    """One plate's pixels by frame index (0 = its first frame), shared by the routes for a while."""

    def __init__(self, path, allow):
        self.path = path
        self.src = comp_io.Sources(None, allow=allow)
        self.node = _read_node(path)
        _, self.info = self.src.info(self.node)
        self.lock = threading.Lock()
        self.used = time.time()
        # a phone's film is stored on its side and turned on playback (the track's matrix): turned here too
        self.turn = 0
        if self.info.get("kind") == "video" and os.path.splitext(path)[1].lower() in (".mov", ".mp4", ".m4v", ".qt"):
            try:
                from . import iphone_io
                self.turn = int((iphone_io.read_film(path, timed=False).get("picture") or {}).get("rotation") or 0)
            except Exception:  # noqa: BLE001 - not a film this reader knows: as it is
                self.turn = 0
        if self.turn in (90, 270) and self.info.get("width") and self.info.get("height"):
            self.info = dict(self.info, width=self.info["height"], height=self.info["width"])

    @property
    def frames(self):
        i = self.info
        if i.get("kind") == "still":
            return 1
        return max(1, int(i.get("last", 0)) - int(i.get("first", 0)) + 1)

    def picture(self, n):
        """Linear premultiplied RGBA float of frame n (held to the plate's ends)."""
        n = max(0, min(self.frames - 1, int(n)))
        with self.lock:
            self.used = time.time()
            img = self.src(self.node, n)
        k = {90: -1, 180: 2, 270: 1}.get(self.turn, 0)
        if k and img is not None:
            img = np.ascontiguousarray(np.rot90(img, k))
        return img

    def close(self):
        self.src.close()


def register(add, *, web, path_access, folder_paths=None, resolve=None, export_rules=None):
    import asyncio

    plates = {}
    plates_lock = threading.Lock()
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

    def plate_of(raw):
        """(Plate, None) or (None, (why, status))."""
        path = as_sequence(abspath(raw))
        if not path:
            return None, ("no plate named", 400)
        if os.path.splitext(path)[1].lower() in PHOTO_EXTS:
            if not path_access.may_serve(path):
                return None, ("not allowed", 403)
            try:
                path = photo_plate(path)
            except Exception as e:  # noqa: BLE001 - a photo this reader cannot open
                return None, (f"{os.path.basename(path)}: {e}", 404)
        probe = comp_io.frame_path(path, comp_io.sequence_numbers(path)[0]) if comp_io.is_sequence(path) and comp_io.sequence_numbers(path) else path
        if not path_access.may_serve(probe):
            return None, (path_access.serve_refusal(probe) if hasattr(path_access, "serve_refusal") else "not allowed", 403)
        with plates_lock:
            p = plates.get(path)
            if p is None:
                p = Plate(path, path_access.may_serve)
                if p.info.get("kind") not in ("still", "sequence", "video"):
                    p.close()
                    return None, (f"{os.path.basename(path)}: {p.info.get('error') or 'not a picture, sequence or film'}", 404)
                plates[path] = p
                # keep a few
                while len(plates) > 4:
                    old = min(plates, key=lambda k: plates[k].used)
                    plates.pop(old).close()
            return p, None

    def plate_size(p):
        w, h = p.info.get("width"), p.info.get("height")
        if not (w and h):
            img = p.picture(0)
            h, w = img.shape[:2]
        return int(w), int(h)

    def phone_dir():
        base = folder_paths.get_input_directory() if folder_paths else os.path.join(os.path.expanduser("~"), ".comfyui_image_viewer")
        return os.path.join(base, "matchmove", "phone")

    def photo_plate(path):
        """A HEIC as a plate: its picture as a PNG (turned as shown), its depth as a 16-bit PNG beside it and its
        camera facts as ``<name>.png.json`` (which ``camera_facts`` reads) - written once per file."""
        from . import iphone_io
        st = os.stat(path)
        key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:10]
        stem = re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(path))[0])[:60]
        folder = phone_dir()
        png = os.path.join(folder, f"{stem}_{key}.png")
        if os.path.isfile(png):
            return png
        os.makedirs(folder, exist_ok=True)
        info = iphone_io.read_photo(path, pictures=True)
        from PIL import Image
        Image.fromarray(info["_picture"]).save(png + ".part.png")
        facts = iphone_io.photo_facts(path)
        facts = {k: v for k, v in facts.items() if not k.startswith("_")}
        if info.get("_depth") is not None:
            dpath = os.path.join(folder, f"{stem}_{key}_depth.png")
            d16 = (np.clip(info["_depth"], 0, 1) * 65535 + 0.5).astype(np.uint16)
            Image.fromarray(d16).save(dpath)
            facts.setdefault("phone", {})["depth_file"] = dpath
            facts["phone"]["depth_reading"] = iphone_io.depth_meaning(info["depth"])
        facts.setdefault("phone", {})["original"] = path
        with open(png + ".json", "w", encoding="utf-8") as fh:
            json.dump(facts, fh, indent=1, default=str)
        os.replace(png + ".part.png", png)
        return png

    def new_job(kind, total=0):
        for k in [k for k, j in jobs.items() if j.get("ended")][: max(0, len(jobs) - MAX_JOBS + 1)]:
            jobs.pop(k, None)
        jid = secrets.token_hex(8)
        jobs[jid] = {"kind": kind, "state": "running", "done": 0, "total": total}
        return jid, jobs[jid]

    async def job_route(request):
        """GET ?job= how far a job got (and what it found); POST {job, cancel} stops it."""
        if request.method == "GET":
            job = jobs.get(request.query.get("job") or "")
            if not job:
                return err("no such job", 404)
            return web.json_response({k: v for k, v in job.items() if k not in ("cancel",)})
        body = await body_of(request)
        job = jobs.get(str(body.get("job") or ""))
        if not job:
            return err("no such job", 404)
        if body.get("cancel"):
            job["cancel"] = True
        return web.json_response({"ok": True})

    # ── the plate ────────────────────────────────────────────────────────────

    async def plate_route(request):
        """GET ?path= the plate's size, frames, rate and what it says about its camera."""
        p, why = await off(plate_of, request.query.get("path"))
        if why:
            return err(*why)
        info = dict(p.info)
        first_file = None
        if info.get("kind") == "sequence":
            first_file = comp_io.frame_path(p.path, info["first"])
        w, h = info.get("width"), info.get("height")
        if not (w and h):
            img = await off(p.picture, 0)
            if img is not None:
                h, w = img.shape[:2]
        facts = await off(MM.camera_facts, p.path, first_file, w, h)
        return web.json_response({"path": p.path, "name": os.path.basename(p.path), "kind": info.get("kind"),
                                  "frames": p.frames, "first": info.get("first", 0), "width": w, "height": h,
                                  "fps": info.get("fps") or 24, "timecode": info.get("timecode"), "camera": facts,
                                  "turn": p.turn},
                                 headers={"Cache-Control": "no-cache"})

    def frame_jpeg(p, n, most, lens, quality=85):
        img = p.picture(n)
        if img is None:
            return None
        rgb = np.clip(M.linear_to_srgb(np.clip(img[..., :3], 0, None)), 0, 1)
        h, w = rgb.shape[:2]
        if lens and (lens.get("k1") or lens.get("k2")):
            from . import comp_warp as WP
            U, V = WP.lens_map(w, h, {"k1": lens.get("k1") or 0, "k2": lens.get("k2") or 0,
                                      "center": lens.get("center"), "zoom": 1, "mode": "undistort"}, 1.0)
            rgb = np.dstack([MM.T.sample(rgb[..., k], U, V) for k in range(3)])
        k = max(1, int(math.ceil(max(w, h) / max(64, min(MAX_SIDE, most)))))
        if k > 1:
            hh, ww = h // k * k, w // k * k
            rgb = rgb[:hh, :ww].reshape(hh // k, k, ww // k, k, 3).mean((1, 3))
        from PIL import Image
        buf = io.BytesIO()
        Image.fromarray((rgb * 255 + 0.5).astype(np.uint8)).save(buf, "JPEG", quality=quality)
        return buf.getvalue()

    def lens_of(q):
        try:
            k1, k2 = float(q.get("k1") or 0), float(q.get("k2") or 0)
            c = None
            if q.get("cx") not in (None, "") and q.get("cy") not in (None, ""):
                c = [float(q["cx"]), float(q["cy"])]
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(k1) and math.isfinite(k2)) or abs(k1) > 5 or abs(k2) > 5:
            return None
        return {"k1": k1, "k2": k2, "center": c} if (k1 or k2) else None

    async def frame_route(request):
        """GET ?path=&frame=&size=&k1=&k2=&cx=&cy= one frame as a JPEG (undistorted when k1 / k2 are given)."""
        q = request.query
        p, why = await off(plate_of, q.get("path"))
        if why:
            return err(*why)
        try:
            n = int(q.get("frame") or 0)
            most = int(q.get("size") or 1600)
        except ValueError:
            return err("frame and size are numbers")
        try:
            data = await off(frame_jpeg, p, n, most, lens_of(q))
        except comp_io.MissingFrame as e:
            return err(e, 404)
        if data is None:
            return err("no picture at that frame", 404)
        return web.Response(body=data, content_type="image/jpeg", headers={"Cache-Control": "max-age=300"})

    # ── tracking ─────────────────────────────────────────────────────────────

    def run_track(job, p, spec):
        def get(f):
            return p.picture(f)

        def progress(i, n):
            job["done"] = i + 1
            job["count"] = n
        try:
            if spec["mode"] == "points":
                keys = MM.T.track_points(lambda f: p.picture(f), spec["frames"], spec["points"],
                                         cancel=lambda: job.get("cancel"),
                                         progress=lambda i, got: job.update(done=i + 1))
                job["keys"] = keys
            else:
                job["tracks"] = MM.auto_track(get, spec["frames"], n=spec["n"], min_dist=spec["min_dist"],
                                              masks=spec["masks"], min_ncc=spec["min_ncc"],
                                              prefix=spec["prefix"], start_id=spec["start_id"],
                                              cancel=lambda: job.get("cancel"), progress=progress)
            job.update(state="stopped" if job.get("cancel") else "done")
        except Exception as e:  # noqa: BLE001 - said to the page
            job.update(state="error", error=str(e))
        finally:
            job["ended"] = time.time()

    def safe_masks(raw):
        """The masks a page sent, cleaned; a matte mask only when its sequence is media this server may read."""
        out = []
        for m in (MM.clean_mask(m) for m in (raw if isinstance(raw, list) else [])[:64]):
            if not m:
                continue
            if m.get("matte"):
                first = MM.matte_path(m["matte"]["pattern"], m["matte"]["frames"][0])
                if not path_access.may_serve(os.path.abspath(first)):
                    if not m["keys"]:
                        continue
                    m.pop("matte")
            out.append(m)
        return out

    async def track_route(request):
        """POST {path, from, to, mode: auto | points, n?, min_dist?, masks?, points?: [{id, x, y, pattern?,
        search?}]} starts a job; GET /imageviewer/mm_job?job= reads it."""
        body = await body_of(request)
        p, why = await off(plate_of, body.get("path"))
        if why:
            return err(*why)
        last = p.frames - 1
        try:
            f0 = max(0, min(last, int(body.get("from", 0))))
            f1 = max(0, min(last, int(body.get("to", last))))
            n = max(8, min(1000, int(body.get("n") or 200)))
            md = int(body["min_dist"]) if body.get("min_dist") else None
            min_ncc = max(0.3, min(0.99, float(body.get("min_ncc") or 0.75)))
            start_id = max(1, int(body.get("start_id") or 1))
        except (TypeError, ValueError):
            return err("from, to, n and min_dist are numbers")
        step = 1 if f1 >= f0 else -1
        mode = "points" if body.get("mode") == "points" else "auto"
        spec = {"mode": mode, "frames": list(range(f0, f1 + step, step)), "n": n, "min_dist": md,
                "masks": safe_masks(body.get("masks")),
                "min_ncc": min_ncc, "prefix": str(body.get("prefix") or "t")[:8], "start_id": start_id}
        if mode == "points":
            pts = []
            for q in (body.get("points") or [])[:200]:
                try:
                    pt = {"id": str(q["id"]), "x": float(q["x"]), "y": float(q["y"])}
                except (KeyError, TypeError, ValueError):
                    continue
                for k in ("pattern", "search"):
                    v = q.get(k)
                    if isinstance(v, list) and len(v) >= 2:
                        pt[k] = [max(5, min(301, int(v[0]))), max(5, min(601, int(v[1])))]
                pts.append(pt)
            if not pts:
                return err("no points to track")
            spec["points"] = pts
        jid, job = new_job("track", len(spec["frames"]))
        threading.Thread(target=run_track, args=(job, p, spec), daemon=True, name=f"mm-track-{jid}").start()
        return web.json_response({"job": jid, "total": job["total"]})

    # ── the lens ─────────────────────────────────────────────────────────────

    async def lens_grid_route(request):
        """POST {path, frames: [n, ...], kind: auto | checker | lines, fit_center, k2} -> the lens from a chart."""
        body = await body_of(request)
        p, why = await off(plate_of, body.get("path"))
        if why:
            return err(*why)
        frames = body.get("frames") or [0]
        try:
            frames = [max(0, min(p.frames - 1, int(f))) for f in frames][:8]
        except (TypeError, ValueError):
            return err("frames are frame numbers")
        kind = body.get("kind") if body.get("kind") in ("auto", "checker", "lines") else "auto"

        def run():
            pics = [MM.grey(p.picture(f)) for f in frames]
            h, w = pics[0].shape
            return MM.solve_lens_grid(pics, w, h, kind=kind, fit_center=bool(body.get("fit_center")),
                                      use_k2=body.get("k2") is not False)
        try:
            out = await off(run)
        except Exception as e:  # noqa: BLE001
            return err(e, 422)
        return web.json_response(out)

    async def lens_lines_route(request):
        """POST {width, height, lines: [[[x, y], ...]], fit_center, k2} -> the lens from straight lines."""
        body = await body_of(request)
        try:
            w, h = int(body["width"]), int(body["height"])
        except (KeyError, TypeError, ValueError):
            return err("width and height are numbers")
        lines = []
        for l in (body.get("lines") or [])[:200]:
            try:
                pts = [[float(a), float(b)] for a, b in l[:500]]
            except (TypeError, ValueError):
                continue
            if len(pts) >= 3:
                lines.append(pts)
        out = await off(MM.solve_lens_lines, lines, w, h, bool(body.get("fit_center")),
                        None if body.get("k2") is None else bool(body.get("k2")))
        return web.json_response(out)

    # ── the solves ───────────────────────────────────────────────────────────

    def clean_lens(v):
        if not isinstance(v, dict):
            return None
        try:
            k1, k2 = float(v.get("k1") or 0), float(v.get("k2") or 0)
            c = v.get("center")
            c = [float(c[0]), float(c[1])] if isinstance(c, (list, tuple)) and len(c) >= 2 else None
        except (TypeError, ValueError):
            return None
        return {"k1": k1, "k2": k2, "center": c}

    def run_solve(job, spec):
        def progress(stage, done, total):
            job.update(stage=stage, done=int(done), total=int(total))
        try:
            if spec["object"]:
                res = MS.solve_object(spec["tracks"], spec["object"], spec["camera"], spec["w"], spec["h"],
                                      lens=spec["lens"], scale=spec["scale"], cancel=lambda: job.get("cancel"))
            else:
                res = MS.solve(spec["tracks"], spec["w"], spec["h"], lens=spec["lens"], focal_px=spec["focal_px"],
                               mode=spec["mode"], refine_focal=spec["refine"], frames=spec["range"],
                               progress=progress, cancel=lambda: job.get("cancel"),
                               constraints=spec["constraints"], pixel_aspect=spec["pixel_aspect"])
            job["result"] = res
            job.update(state="stopped" if job.get("cancel") else ("error" if res.get("error") else "done"),
                       error=res.get("error"))
        except Exception as e:  # noqa: BLE001
            job.update(state="error", error=str(e))
        finally:
            job["ended"] = time.time()

    async def solve_route(request):
        """POST {width, height, tracks, lens?, focal_px?, mode: free | tripod | auto, refine?, range?: [a, b],
        constraints?: [{kind, ids, value?}], pixel_aspect?, object?: id, camera?: (the camera solve, for an
        object), scale?} starts a solve job."""
        body = await body_of(request)
        try:
            w, h = int(body["width"]), int(body["height"])
            fp = float(body["focal_px"]) if body.get("focal_px") else None
            rng = body.get("range")
            rng = (int(rng[0]), int(rng[1])) if isinstance(rng, list) and len(rng) == 2 else None
            scale = float(body["scale"]) if body.get("scale") else None
            pa = float(body["pixel_aspect"]) if body.get("pixel_aspect") else 1.0
        except (KeyError, TypeError, ValueError):
            return err("width, height, focal_px, range, scale and pixel_aspect are numbers")
        if not (0.2 <= pa <= 5):
            return err("pixel_aspect is out of range (0.2 .. 5)")
        if fp is not None and not (1 < fp < 1e6):
            return err("focal_px is out of range")
        tracks = MM.clean_tracks(body.get("tracks"))
        obj = str(body.get("object") or "")
        cam = body.get("camera") if isinstance(body.get("camera"), dict) else None
        if obj and not (cam and isinstance(cam.get("frames"), dict) and cam.get("focal_px")):
            return err("solve the camera first: an object is solved through it")
        spec = {"w": w, "h": h, "tracks": tracks, "lens": clean_lens(body.get("lens")), "focal_px": fp,
                "mode": body.get("mode") if body.get("mode") in ("free", "tripod", "auto") else "auto",
                "refine": None if body.get("refine") is None else bool(body.get("refine")), "range": rng,
                "object": obj, "camera": cam, "scale": scale, "pixel_aspect": pa,
                "constraints": MS.clean_constraints(body.get("constraints") if isinstance(body.get("constraints"), list) else [])}
        jid, job = new_job("solve", 0)
        threading.Thread(target=run_solve, args=(job, spec), daemon=True, name=f"mm-solve-{jid}").start()
        return web.json_response({"job": jid})

    # ── the undistorted plate, for the 3D space ──────────────────────────────

    def run_proxy(job, p, spec):
        from . import comp_warp as WP
        try:
            frames = spec["frames"]
            img0 = p.picture(frames[0])
            h, w = img0.shape[:2]
            k = max(1, int(math.ceil(max(w, h) / spec["size"])))
            lens = spec["lens"]
            UV = None
            if lens and (lens.get("k1") or lens.get("k2")):
                UV = WP.lens_map(w, h, {"k1": lens["k1"], "k2": lens["k2"], "center": lens.get("center"),
                                        "zoom": 1, "mode": "undistort"}, 1.0)
            how = {"container": "mp4", "encoder": "libx264", "pix_fmt": "yuv420p",
                   "options": {"crf": "18", "preset": "veryfast", "g": "1"}}
            wr = comp_io.VideoWriter(spec["out"], how, spec["fps"], w // k, h // k)
            try:
                for i, f in enumerate(frames):
                    if job.get("cancel"):
                        break
                    img = p.picture(f)
                    if img is None:
                        img = np.zeros_like(img0)
                    rgb = img[..., :3]
                    if UV is not None:
                        rgb = np.dstack([MM.T.sample(rgb[..., c], UV[0], UV[1]) for c in range(3)])
                    if k > 1:
                        hh, ww = h // k * k, w // k * k
                        rgb = rgb[:hh, :ww].reshape(hh // k, k, ww // k, k, 3).mean((1, 3))
                    wr.add(rgb.astype(np.float32))
                    job["done"] = i + 1
            finally:
                wr.close(keep=not job.get("cancel"))
            job.update(state="stopped" if job.get("cancel") else "done",
                       result={"filename": os.path.basename(spec["out"]), "subfolder": "matchmove", "type": "input",
                               "path": spec["out"], "width": w // k, "height": h // k})
        except Exception as e:  # noqa: BLE001
            job.update(state="error", error=str(e))
        finally:
            job["ended"] = time.time()

    async def proxy_route(request):
        """POST {path, lens?, from?, to?, size?, fps?} writes the plate - undistorted by the lens - as an H.264
        film into <input>/matchmove/, for the 3D space's camera backplate. A job: its result names the file."""
        body = await body_of(request)
        p, why = await off(plate_of, body.get("path"))
        if why:
            return err(*why)
        if folder_paths is None:
            return err("no ComfyUI input folder", 500)
        last = p.frames - 1
        try:
            f0 = max(0, min(last, int(body.get("from", 0))))
            f1 = max(f0, min(last, int(body.get("to", last))))
            size = max(256, min(4096, int(body.get("size") or 1920)))
            fps = float(body.get("fps") or p.info.get("fps") or 24)
        except (TypeError, ValueError):
            return err("from, to, size and fps are numbers")
        lens = clean_lens(body.get("lens"))
        try:
            st = os.stat(comp_io.frame_path(p.path, p.info["first"]) if p.info.get("kind") == "sequence" else p.path)
            stamp = f"{p.path}|{st.st_mtime}|{st.st_size}"
        except OSError:
            stamp = p.path
        key = hashlib.sha1(f"{stamp}|{lens}|{f0}|{f1}|{size}".encode()).hexdigest()[:10]
        stem = os.path.splitext(os.path.basename(p.path))[0].replace("#", "").replace("%", "").strip("._") or "plate"
        folder = os.path.join(folder_paths.get_input_directory(), "matchmove")
        out = os.path.join(folder, f"{stem}_mm_{key}.mp4")
        jid, job = new_job("proxy", f1 - f0 + 1)
        if os.path.isfile(out):
            job.update(state="done", done=job["total"], ended=time.time(),
                       result={"filename": os.path.basename(out), "subfolder": "matchmove", "type": "input",
                               "path": out})
            return web.json_response({"job": jid, "total": job["total"]})
        spec = {"frames": list(range(f0, f1 + 1)), "size": size, "fps": fps, "lens": lens, "out": out}
        threading.Thread(target=run_proxy, args=(job, p, spec), daemon=True, name=f"mm-proxy-{jid}").start()
        return web.json_response({"job": jid, "total": job["total"]})

    # ── the matchmove's own file ─────────────────────────────────────────────

    def mm_file_ok(path):
        return path.lower().endswith(MM_SUFFIX) and path_access.is_allowed(path)

    async def save_route(request):
        """POST {data, path?, name?, context?}: a matchmove (.mm.json) written over `path` when that is one,
        else a new file by the export rule (kind "matchmove", the next version)."""
        body = await body_of(request)
        data = body.get("data")
        if not isinstance(data, dict):
            return err("data is the matchmove")
        text = json.dumps(data, separators=(",", ":"))
        if len(text) > MM_MAX_BYTES:
            return err("the matchmove is too big to save", 413)
        path = abspath(body.get("path"))
        version = None
        if path:
            if not mm_file_ok(path):
                return err("not a matchmove file this viewer may write", 403)
        else:
            if export_rules is None or folder_paths is None:
                return err("saving is not available here", 500)
            name = body.get("name") or "matchmove"
            try:
                t = export_rules.target("matchmove", name, "json", folder_paths.get_output_directory(), body.get("context"))
            except ValueError as e:
                return err(e)
            path, version = t["path"][: -len(".json")] + MM_SUFFIX, t.get("version")

        def write():
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = f"{path}.part-{secrets.token_hex(4)}"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp, path)
        try:
            await off(write)
        except OSError as e:
            return err(f"not written: {e}", 500)
        return web.json_response({"path": path, "version": version})

    async def load_route(request):
        """GET ?path= a matchmove file."""
        path = abspath(request.query.get("path"))
        if not path or not mm_file_ok(path):
            return err("not a matchmove file this viewer may read", 403)
        if not os.path.isfile(path):
            return err("no such file", 404)
        try:
            if os.path.getsize(path) > MM_MAX_BYTES:
                return err("too big", 413)
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as e:
            return err(f"not read: {e}", 400)
        return web.json_response({"path": path, "data": data}, headers={"Cache-Control": "no-cache"})

    # ── the lens into Comp ───────────────────────────────────────────────────

    async def to_comp_route(request):
        """POST {path, lens, name?, context?, mode?: undistort | redistort, fps?, frames?, width?, height?} makes a
        comp: the plate's Read -> LensDistortion (the lens's numbers) -> Output, saved by the export rule."""
        body = await body_of(request)
        p, why = await off(plate_of, body.get("path"))
        if why:
            return err(*why)
        lens = clean_lens(body.get("lens")) or {"k1": 0, "k2": 0, "center": None}
        if export_rules is None or folder_paths is None:
            return err("comp export is not available here", 500)
        try:
            w, h = int(body.get("width") or p.info.get("width") or 0), int(body.get("height") or p.info.get("height") or 0)
        except (TypeError, ValueError):
            return err("width and height are numbers")
        if not (w and h):
            img = await off(p.picture, 0)
            h, w = img.shape[:2]
        mode = "redistort" if body.get("mode") == "redistort" else "undistort"
        try:
            t = export_rules.target("comp", body.get("name") or (os.path.splitext(os.path.basename(p.path))[0] + "_lens"),
                                    "json", folder_paths.get_output_directory(), body.get("context"))
        except ValueError as e:
            return err(e)
        path = t["path"][: -len(".json")] + M.SUFFIX
        node = {"id": "LensDistortion1", "type": "lensdistortion", "name": "Lens", "x": 0, "y": 120,
                "inputs": ["Read1"], "mode": mode, "k1": lens["k1"], "k2": lens["k2"], "center": lens["center"],
                "zoom": 1, "output": "image"}
        comp = {"comp": M.COMP_VERSION,
                "format": {"width": w, "height": h, "fps": float(p.info.get("fps") or 24), "frames": p.frames},
                "nodes": [{"id": "Read1", "type": "read", "name": "Plate", "x": 0, "y": 0, "inputs": [],
                           "file": p.path, "offset": 0, "colorspace": "auto"},
                          node,
                          {"id": "Output1", "type": "output", "x": 0, "y": 240, "inputs": ["LensDistortion1"]}],
                "output": "Output1"}
        comp, _ = M.normalize(comp)
        try:
            await off(comp_io.write, path, comp)
        except (ValueError, OSError) as e:
            return err(f"not written: {e}", 500)
        return web.json_response({"path": path, "version": t.get("version")})

    async def from_comp_route(request):
        """GET ?path=<comp>&node= -> the lens of a comp's LensDistortion node (the first, without node)."""
        path = abspath(request.query.get("path"))
        if not path or not path_access.is_allowed(path) or not path.endswith(M.SUFFIX):
            return err("not a comp the viewer may read", 403)
        try:
            comp, _ = M.normalize(await off(comp_io.read, path))
        except (ValueError, OSError) as e:
            return err(e, 422)
        want = request.query.get("node") or ""
        flat = M.G.flatten(comp) if hasattr(M, "G") else comp
        for n in flat.get("nodes") or []:
            if n.get("type") == "lensdistortion" and (not want or n.get("id") == want):
                def num(k):
                    v = n.get(k)
                    if isinstance(v, (int, float)):
                        return float(v)
                    try:
                        return float(M.param_at(n, k, 0)) if hasattr(M, "param_at") else 0.0
                    except Exception:  # noqa: BLE001
                        return 0.0
                c = n.get("center")
                return web.json_response({"node": n.get("id"), "k1": num("k1"), "k2": num("k2"),
                                          "center": c if isinstance(c, list) and len(c) == 2 else None,
                                          "width": comp["format"]["width"], "height": comp["format"]["height"]})
        return err("the comp has no LensDistortion node", 404)

    async def stmap_route(request):
        """POST {width, height, lens, mode: undistort | redistort, name?, context?} writes the lens as an ST map
        (EXR, u v in r g) by the export rule - for any compositor's STMap node."""
        body = await body_of(request)
        try:
            w, h = int(body["width"]), int(body["height"])
        except (KeyError, TypeError, ValueError):
            return err("width and height are numbers")
        if not (16 <= w <= 16384 and 16 <= h <= 16384):
            return err("the size is out of range")
        lens = clean_lens(body.get("lens")) or {"k1": 0, "k2": 0, "center": None}
        mode = "redistort" if body.get("mode") == "redistort" else "undistort"
        if export_rules is None or folder_paths is None:
            return err("export is not available here", 500)
        if "exr" not in comp_io.still_formats():
            return err("this ComfyUI cannot write EXR files (OpenEXR is not installed)", 422)
        try:
            t = export_rules.target("frame", body.get("name") or f"lens_{mode}_stmap", "exr",
                                    folder_paths.get_output_directory(), body.get("context"))
        except ValueError as e:
            return err(e)

        def run():
            st = MM.lens_stmap(w, h, lens, mode)
            img = np.dstack([st, np.zeros((h, w, 1), np.float32), np.ones((h, w, 1), np.float32)])
            comp_io.write_still(img, t["path"], "exr", options={"bit_depth": 32})
            return t["path"]
        try:
            path = await off(run)
        except Exception as e:  # noqa: BLE001
            return err(f"not written: {e}", 500)
        return web.json_response({"path": path})

    # ── AI mattes over the shot (matchmove_matte): SAM 3 by words, a background remover ──────────────

    def node_classes():
        try:
            import nodes  # ComfyUI's own: the node classes this server has
            return set(nodes.NODE_CLASS_MAPPINGS)
        except Exception:  # noqa: BLE001 - not inside ComfyUI (the tests): no check
            return None

    def output_ref(img):
        if not isinstance(img, dict) or not img.get("filename") or folder_paths is None:
            return None
        try:
            base = folder_paths.get_directory_by_type(img.get("type") or "output")
        except Exception:  # noqa: BLE001
            base = None
        if not base:
            return None
        p = os.path.abspath(os.path.join(base, str(img.get("subfolder") or ""), str(img["filename"])))
        return p if path_access.within(p, base) else None

    async def matte_workflows_route(request):
        """POST {engine: objects | background | depth} -> {engine, action, workflows, choice}."""
        from . import matchmove_matte as MT
        body = await body_of(request)
        try:
            res = await off(MT.workflows_for, str(body.get("engine") or ""), folder_paths, node_classes())
        except (MT.MatteError, ValueError, OSError) as e:
            return err(e)
        return web.json_response(res, headers={"Cache-Control": "no-cache"})

    async def matte_route(request):
        """POST {path, engine, prompt?, frames, workflow?, graph?, tune?, models?, scale?} -> ONE prompt for the frames'
        mattes {run, graph, outputs {frame: node}, frames, skipped}; 409 {missing} without its models."""
        from . import matchmove_matte as MT
        from . import paint_generate as G
        body = await body_of(request)
        if folder_paths is None:
            return err("ComfyUI's folders are not known here", 500)
        p, why = await off(plate_of, body.get("path"))
        if why:
            return err(*why)
        frames = body.get("frames")
        if not isinstance(frames, list) or not all(isinstance(f, (int, float)) and not isinstance(f, bool) for f in frames):
            return err("'frames' must be a list of frame numbers")
        last = p.frames - 1
        frames = [int(f) for f in frames if 0 <= int(f) <= last]
        try:
            res = await off(MT.prepare_batch, p.picture, frames, folder_paths.get_input_directory(),
                            engine=str(body.get("engine") or ""), prompt=str(body.get("prompt") or ""),
                            wid=body.get("workflow") or None, graph=body.get("graph"),
                            tune=body.get("tune") if isinstance(body.get("tune"), dict) else None,
                            models=body.get("models") if isinstance(body.get("models"), dict) else None,
                            folder_paths=folder_paths, node_classes=node_classes(), scale=body.get("scale"),
                            fps=float(p.info.get("fps") or 24))
        except G.Missing as e:
            return web.json_response({"error": str(e), "missing": e.missing}, status=409)
        except (MT.MatteError, G.GenerateError, ValueError, OSError) as e:
            return err(e)
        return web.json_response(res)

    async def matte_place_route(request):
        """POST {run, images {frame: {filename, subfolder, type}}} -> the matte sequence {pattern, frames, ...}."""
        from . import matchmove_matte as MT
        body = await body_of(request)
        run = str(body.get("run") or "")
        images = body.get("images") if isinstance(body.get("images"), dict) else {}
        try:
            rec = MT.run_record(run)
        except MT.MatteError as e:
            return err(e)
        if not path_access.is_allowed(rec["folder"]):
            return err(path_access.refusal(rec["folder"]), 403)
        found = {}
        for f, img in images.items():
            q = output_ref(img)
            if q and os.path.isfile(q) and path_access.may_serve(q):
                try:
                    found[int(f)] = q
                except ValueError:
                    continue
        if not found:
            return err("the workflow's pictures were not found", 404)
        try:
            res = await off(MT.place_batch, run, found)
        except (MT.MatteError, ValueError, OSError) as e:
            return err(e)
        return web.json_response(res)

    def _aspect(v):
        try:
            a = float(v or 1.0)
        except (TypeError, ValueError):
            return 1.0
        return a if 0.2 <= a <= 5 else 1.0

    async def depth_place_route(request):
        """POST {run, images {frame: {filename, subfolder, type}}, cams {frame: {R, t}}, tracks {frame: [[u, v, X0,
        X1, X2]]}, focal, center?, lens?} -> the depth job's frames as points of the solve's world
        (``matchmove_matte.depth_points``)."""
        from . import matchmove_matte as MT
        body = await body_of(request)
        images = body.get("images") if isinstance(body.get("images"), dict) else {}
        cams = body.get("cams") if isinstance(body.get("cams"), dict) else {}
        tracks = body.get("tracks") if isinstance(body.get("tracks"), dict) else {}
        try:
            focal = float(body.get("focal"))
        except (TypeError, ValueError):
            return err("'focal' (the solve's focal length in pixels) is needed")
        if not focal > 0:
            return err("'focal' must be above 0")
        center = body.get("center")
        center = [float(center[0]), float(center[1])] if isinstance(center, list) and len(center) == 2 else None
        lens = body.get("lens") if isinstance(body.get("lens"), dict) else None
        found = {}
        for f, img in list(images.items())[:MT.MAX_FRAMES]:
            q = output_ref(img)
            if q and os.path.isfile(q) and path_access.may_serve(q):
                try:
                    found[int(f)] = q
                except ValueError:
                    continue
        if not found:
            return err("the workflow's depth maps were not found", 404)
        tracks = {k: v[:5000] for k, v in tracks.items() if isinstance(v, list)}
        try:
            res = await off(MT.depth_points, str(body.get("run") or ""), found, cams, tracks,
                            focal=focal, center=center, lens=lens,
                            pixel_aspect=_aspect(body.get("pixel_aspect")))
        except (MT.MatteError, ValueError, OSError, TypeError) as e:
            return err(e)
        return web.json_response(res)

    async def matte_sample_route(request):
        """POST {matte, points {frame: [[id, x, y], ...]}} -> {votes {id: [on, seen]}}."""
        from . import matchmove_matte as MT
        body = await body_of(request)
        m = MM.clean_matte(body.get("matte"))
        if not m:
            return err("'matte' is not a matte")
        first = os.path.abspath(MM.matte_path(m["pattern"], m["frames"][0]))
        if not path_access.may_serve(first):
            return err("not allowed", 403)
        try:
            votes = await off(MT.sample, m, body.get("points") if isinstance(body.get("points"), dict) else {})
        except (MT.MatteError, ValueError, OSError) as e:
            return err(e)
        return web.json_response({"votes": votes})

    # ── the phone's own data ─────────────────────────────────────────────────

    async def phone_route(request):
        """GET ?path= everything an iPhone film or photo holds (keys, tracks, timed metadata, depth): what the
        plate step's Phone section lists."""
        from . import iphone_io
        raw = abspath(request.query.get("path"))
        if not raw or not os.path.isfile(raw) or not path_access.may_serve(raw):
            return err("not allowed or not there", 403)
        try:
            if iphone_io.is_photo(raw):
                info = iphone_io.public(await off(iphone_io.read_photo, raw))
            elif iphone_io.is_film(raw):
                info = iphone_io.public(await off(iphone_io.read_film, raw))
            else:
                return err("not a film or a HEIC photo")
        except (iphone_io.PhoneError, OSError, ValueError, IndexError) as e:
            return err(e)
        return web.json_response(json.loads(json.dumps(info, default=str)))

    def phone_depth_png(p, n, most=640):
        from . import matchmove_matte as MT
        w, h = plate_size(p)
        k = max(1, math.ceil(max(w, h) / most))
        maps = MT.phone_depth_maps(p.path, [n], p.info.get("fps") or 30, w // k, h // k, p.turn)
        if n not in maps:
            return None
        from PIL import Image
        buf = io.BytesIO()
        Image.fromarray((np.clip(maps[n], 0, 1) * 255 + 0.5).astype(np.uint8)).save(buf, "PNG")
        return buf.getvalue()

    async def phone_depth_view_route(request):
        """GET ?path=&frame= a Cinematic film's depth at that plate frame as a grey PNG (as stored: bright = near)."""
        from . import iphone_io
        p, why = await off(plate_of, request.query.get("path"))
        if why:
            return err(*why)
        try:
            data = await off(phone_depth_png, p, int(request.query.get("frame") or 0))
        except (iphone_io.PhoneError, ValueError, OSError) as e:
            return err(e, 404)
        if not data:
            return err("no depth at that frame", 404)
        return web.Response(body=data, content_type="image/png", headers={"Cache-Control": "max-age=300"})

    async def phone_depth_route(request):
        """POST {path, frames [plate frames], cams {frame: {R, t}}, tracks {frame: [[u, v, X0, X1, X2]]}, focal,
        center?, lens?, reading?} -> the phone's depth on those frames as points of the solve's world (the answer
        of ``mm_depth_place``, plus ``reading`` - disparity or depth - and its ``spread``)."""
        from . import iphone_io
        from . import matchmove_matte as MT
        body = await body_of(request)
        p, why = await off(plate_of, body.get("path"))
        if why:
            return err(*why)
        try:
            focal = float(body.get("focal"))
        except (TypeError, ValueError):
            return err("'focal' (the solve's focal length in pixels) is needed")
        if not focal > 0:
            return err("'focal' must be above 0")
        frames = [int(f) for f in (body.get("frames") or []) if isinstance(f, (int, float))][:MT.MAX_FRAMES]
        if not frames:
            return err("'frames' names no frames")
        cams = body.get("cams") if isinstance(body.get("cams"), dict) else {}
        tracks = body.get("tracks") if isinstance(body.get("tracks"), dict) else {}
        tracks = {k: v[:5000] for k, v in tracks.items() if isinstance(v, list)}
        center = body.get("center")
        center = [float(center[0]), float(center[1])] if isinstance(center, list) and len(center) == 2 else None
        lens = body.get("lens") if isinstance(body.get("lens"), dict) else None
        reading = body.get("reading") if body.get("reading") in MT.PHONE_READINGS else None
        try:
            res = await off(MT.phone_depth_points, p.path, frames, cams, tracks, fps=p.info.get("fps") or 30,
                            size=await off(plate_size, p), focal=focal, center=center,
                            lens=lens, turn=p.turn, reading=reading, pixel_aspect=_aspect(body.get("pixel_aspect")))
        except (MT.MatteError, iphone_io.PhoneError, ValueError, OSError, TypeError) as e:
            return err(e)
        return web.json_response(res)

    def phone_export(p, every):
        """The depth track as a 16-bit grey PNG sequence at plate frames (bright = near, as stored), beside the
        HEIC copies: <input>/matchmove/phone/<film>_depth/<film>_depth.####.png."""
        from . import matchmove_matte as MT
        stem = re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(p.path))[0])[:60]
        folder = os.path.join(phone_dir(), f"{stem}_depth")
        os.makedirs(folder, exist_ok=True)
        from PIL import Image
        w, h = plate_size(p)
        from . import iphone_io
        dep = iphone_io.read_film(p.path, timed=False)["depth"]
        dw, dh = (dep["width"], dep["height"]) if (dep["width"] > dep["height"]) == (w > h) else (dep["height"], dep["width"])
        written = 0
        for n in range(0, p.frames, max(1, every)):
            maps = MT.phone_depth_maps(p.path, [n], p.info.get("fps") or 30, dw, dh, p.turn)
            if n in maps:
                Image.fromarray((np.clip(maps[n], 0, 1) * 65535 + 0.5).astype(np.uint16)).save(
                    os.path.join(folder, f"{stem}_depth.{n:04d}.png"))
                written += 1
        return {"pattern": os.path.join(folder, f"{stem}_depth.####.png"), "frames": written,
                "width": dw, "height": dh}

    async def phone_export_route(request):
        """POST {path, every?} writes a Cinematic film's depth as a picture sequence (see ``phone_export``)."""
        from . import iphone_io
        body = await body_of(request)
        p, why = await off(plate_of, body.get("path"))
        if why:
            return err(*why)
        try:
            every = max(1, int(body.get("every") or 1))
            res = await off(phone_export, p, every)
        except (iphone_io.PhoneError, ValueError, OSError, TypeError, KeyError) as e:
            return err(e)
        return web.json_response(res)

    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("GET", f"{prefix}/mm_phone", phone_route)
        add("GET", f"{prefix}/mm_phone_depth_view", phone_depth_view_route)
        add("POST", f"{prefix}/mm_phone_depth", phone_depth_route)
        add("POST", f"{prefix}/mm_phone_export", phone_export_route)
    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("POST", f"{prefix}/mm_matte_workflows", matte_workflows_route)
        add("POST", f"{prefix}/mm_matte", matte_route)
        add("POST", f"{prefix}/mm_matte_place", matte_place_route)
        add("POST", f"{prefix}/mm_matte_sample", matte_sample_route)
        add("POST", f"{prefix}/mm_depth_place", depth_place_route)
        add("GET", f"{prefix}/mm_plate", plate_route)
        add("GET", f"{prefix}/mm_frame", frame_route)
        add("GET", f"{prefix}/mm_job", job_route)
        add("POST", f"{prefix}/mm_job", job_route)
        add("POST", f"{prefix}/mm_track", track_route)
        add("POST", f"{prefix}/mm_lens_grid", lens_grid_route)
        add("POST", f"{prefix}/mm_lens_lines", lens_lines_route)
        add("POST", f"{prefix}/mm_solve", solve_route)
        add("POST", f"{prefix}/mm_proxy", proxy_route)
        add("POST", f"{prefix}/mm_to_comp", to_comp_route)
        add("GET", f"{prefix}/mm_from_comp", from_comp_route)
        add("POST", f"{prefix}/mm_stmap", stmap_route)
        add("POST", f"{prefix}/mm_save", save_route)
        add("GET", f"{prefix}/mm_load", load_route)
