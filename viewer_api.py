import asyncio
import io
import json
import os
import re
import base64
import sys
import traceback
import folder_paths
from server import PromptServer

from . import path_access
from . import push_open
try:
    from . import viewer_code
except Exception:  # pragma: no cover - the code panel is optional
    viewer_code = None
from . import viewer_settings

try:
    from . import media_resolve
except Exception:  # pragma: no cover - viewer still works without the resolver
    media_resolve = None

try:
    from . import model_writer
except Exception:  # pragma: no cover
    model_writer = None

try:
    from . import previz
except Exception:  # pragma: no cover
    previz = None

try:
    from . import previz_shot
except Exception:  # pragma: no cover
    previz_shot = None

try:
    from . import mg_scene_io
    from . import mg_render
except Exception:  # noqa: BLE001
    mg_scene_io = None
    mg_render = None
try:
    from . import atlas_render
except Exception:  # pragma: no cover
    atlas_render = None
try:
    from . import lora_io
except Exception:  # pragma: no cover
    lora_io = None

try:
    from . import abc_io
except Exception:  # pragma: no cover
    abc_io = None

try:
    from . import usd_io
except Exception:  # pragma: no cover
    usd_io = None

_MODEL_EXTS = {".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply",
               ".usd", ".usda", ".usdc", ".usdz", ".abc", ".spz", ".splat", ".ksplat", ".sog"}

# Sound files the Viewer plays (media_resolve.AUDIO_EXTS when it is there).
_AUDIO_EXTS = (getattr(media_resolve, "AUDIO_EXTS", None) if media_resolve is not None else None) \
    or {".wav", ".mp3", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".weba"}

# three.js and its loaders, for the viewer's 3D tabs. Outside js/ so ComfyUI
# doesn't import them at startup; served by /imageviewer/lib/three/<name> instead.
_THREE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "three")

# Stands in for a model's history tile until the browser has rendered one.
# A film with no poster and no decoder: a tile that says "film" instead of a broken image.
_VIDEO_PLACEHOLDER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    '<rect width="64" height="64" fill="#2a2a2a"/>'
    '<rect x="10" y="18" width="44" height="28" rx="3" fill="none" stroke="#9a9a9a" stroke-width="2"/>'
    '<path d="M28 25v14l12-7z" fill="#9a9a9a"/></svg>')

_MODEL_PLACEHOLDER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    '<rect width="64" height="64" fill="#2a2a2a"/>'
    '<g fill="none" stroke="#9a9a9a" stroke-width="2" stroke-linejoin="round">'
    '<path d="M32 12 50 22v20L32 52 14 42V22z"/><path d="M14 22l18 10 18-10M32 32v20"/>'
    '</g></svg>')


def _decode_image_upload(dataurl, force_png=False):
    """(bytes, ext) to write for an uploaded data: URL.

    The upload is decoded and re-encoded rather than written as it came. That is
    the check: whatever lands on disk is an image PIL could read, with nothing
    riding along after the pixels. Raises ValueError with a message for the
    client.
    """
    m = re.match(r"^data:image/(png|jpeg);base64,(.*)$", dataurl or "", re.DOTALL)
    if not m:
        raise ValueError("expected a data:image/png or data:image/jpeg payload")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception as e:
        raise ValueError(f"base64 decode failed: {e}")

    from PIL import Image
    try:
        with Image.open(io.BytesIO(raw)) as im:
            fmt = im.format
            if fmt not in ("PNG", "JPEG"):
                raise ValueError(f"expected a PNG or JPEG image, got {fmt or 'something else'}")
            im.load()
            if force_png:
                fmt = "PNG"
            if fmt == "JPEG" and im.mode not in ("RGB", "L", "CMYK"):
                im = im.convert("RGB")
            buf = io.BytesIO()
            if fmt == "PNG":
                im.save(buf, format="PNG", compress_level=4)
            else:
                im.save(buf, format="JPEG", quality=95)
    except ValueError:
        raise
    except Exception as e:              # a truncated file, a decompression bomb, ...
        raise ValueError(f"not a readable image: {e}")
    return buf.getvalue(), ("png" if fmt == "PNG" else "jpg")


def _usd_display_path(path, prim=None, frame=0):
    """The GLB standing in for a USD stage or an Alembic cache — or the path
    itself, when it is neither.

    The viewport speaks glTF; a stage or a cache is flattened once and reused.
    An Alembic cache is flattened at one sample, so `frame` picks which: a
    cache is geometry per frame, not a rig the viewport could play by itself.
    Failing to build it is reported to the log and the original path is
    returned, so the client gets a plain "can't read this" rather than a
    broken response.
    """
    try:
        if abc_io is not None and abc_io.is_abc(path):
            return abc_io.display_proxy(path, sample=frame, obj_path=prim) or path
        if usd_io is not None and usd_io.is_usd(path):
            return usd_io.display_proxy(path, prim) or path
    except Exception as e:
        print(f"[ImageViewer] could not build a preview of {os.path.basename(path)}: {e}")
    return path


def _frame_arg(request):
    """The `frame` query, for a format that holds one picture per frame."""
    try:
        return max(0, int(request.query.get("frame") or 0))
    except (TypeError, ValueError):
        return 0


def _file_response(path, prim=None, frame=0, cs=None, ev=None):
    """Serve an image/video file, swapping in a browser-renderable PNG proxy for
    formats an <img> can't decode (exr / tiff / dpx / ...).

    `no-cache` lets the browser keep the bytes but forces it to revalidate before
    reusing them, so an overwritten file is picked up immediately (via the ETag
    aiohttp already sends) while unchanged frames cost a 304 instead of a full
    re-download. That is what lets the viewer drop the per-request cache-buster
    it used to append, which was defeating its own frame-caching.

    `cs` is the input colourspace picked in the viewer: the picture is converted
    from it to sRGB instead of getting the proxy's fixed treatment. `ev` is the
    viewer's exposure, applied in linear light before that conversion.
    """
    path = _usd_display_path(path, prim, frame)
    if media_resolve is not None:
        proxy, done = None, False
        if cs:
            try:
                proxy, done = media_resolve.proxy_for_colorspace(path, cs, ev), True
            except Exception as e:
                print(f"[ImageViewer] colour transform failed for {path}: {e}")
        if not done:
            try:
                proxy = media_resolve.proxy_for_display(path)
            except Exception as e:
                print(f"[ImageViewer] display proxy failed for {path}: {e}")
        if not proxy:
            # A film a <video> cannot play (ProRes, say) is shown through an
            # H.264 copy; what is exported or cut is always the film itself.
            try:
                proxy = media_resolve.video_proxy(path)
            except Exception as e:
                print(f"[ImageViewer] playable copy failed for {path}: {e}")
        if proxy:
            path = proxy
    from aiohttp import web
    return web.FileResponse(path, headers={"Cache-Control": "no-cache"})


_PROBE_POOL = None


def _probe_pool():
    """A few threads for /imageviewer/probe_paths: checking a file on a network share is
    a round trip, not work, so asking about several at once is what makes a
    history of hundreds of paths quick to verify."""
    global _PROBE_POOL
    if _PROBE_POOL is None:
        from concurrent.futures import ThreadPoolExecutor
        _PROBE_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="imageviewer-probe")
    return _PROBE_POOL


def _resolve_raw_path(path):
    """Resolve a /imageviewer/raw_view path and say whether it may be served.

    Returns (abs_path, allowed). Split out of the route so /imageviewer/probe_paths can
    answer the same question without having to provoke the 403/404 it would
    otherwise take to find out.
    """
    try:
        temp_base = folder_paths.get_temp_directory()
    except Exception:
        temp_base = None
    try:
        out_base = folder_paths.get_output_directory()
    except Exception:
        out_base = None

    cand = path
    if not os.path.isabs(cand):
        if temp_base:
            cand = os.path.abspath(os.path.join(temp_base, cand))
        elif out_base:
            cand = os.path.abspath(os.path.join(out_base, cand))
        else:
            cand = os.path.abspath(path)
    else:
        cand = os.path.abspath(cand)

    # Inside, with links resolved: a junction in temp must not reach out of it.
    # The file is resolved once for both roots - a realpath is a round trip per
    # path component on a network share, and every history switch comes here.
    try:
        real_cand = path_access._real(cand)
    except Exception:
        return cand, False
    for base in (temp_base, out_base):
        if not base:
            continue
        try:
            if path_access._inside(real_cand, path_access._real(base)):
                return cand, True
        except Exception:
            continue
    return cand, False

def _resolve_comfy_ref(filename, type_name, subfolder):
    """Absolute path for ComfyUI's own {filename, type, subfolder} addressing.

    The same triple /view takes, resolved against the same roots, so a thumbnail
    can be asked for by the only name a node run gives its outputs. Confined to
    those roots on purpose: unlike a user-picked path, this triple arrives from
    the page, so it is checked rather than trusted. Returns None when it does not
    land inside the root it named.
    """
    name = (filename or "").strip()
    if not name:
        return None
    try:
        base = folder_paths.get_directory_by_type(type_name or "output")
    except Exception:
        base = None
    if not base:
        return None
    base = os.path.abspath(base)
    cand = os.path.abspath(os.path.join(base, (subfolder or "").strip(), name))
    # Containment check, not a string prefix: "..\..\secrets" normalises away
    # here, and a sibling directory whose name merely starts with the root's does
    # not pass.
    try:
        inside = os.path.commonpath([os.path.normcase(base),
                                     os.path.normcase(cand)])
        if inside != os.path.normcase(base):
            return None
    except Exception:
        return None
    return cand


# One directory listing is meant to be read, not scrolled forever; a frame
# request costs a probe per video, so it is capped harder.
_BROWSE_FILE_CAP = 3000
_BROWSE_FRAME_CAP = 500


def _browse_exts():
    """(images, videos) the browser will list, from the resolver when present."""
    if media_resolve is not None:
        return media_resolve.IMAGE_EXTS, media_resolve.VIDEO_EXTS
    return ({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".ico",
             ".svg", ".tif", ".tiff", ".exr", ".dpx", ".tga", ".hdr"},
            {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".avi", ".mpg",
             ".mpeg", ".wmv", ".flv"})


def _browse_sort_key(name):
    """frame_2.png before frame_10.png, as everywhere else in the viewer."""
    if media_resolve is not None:
        try:
            return media_resolve._natural_key(name)
        except Exception:
            pass
    return [int(tok) if tok.isdigit() else tok.lower()
            for tok in re.split(r"(\d+)", name)]


def _browse_default_dir():
    """Where the browser opens: ComfyUI's input directory."""
    try:
        d = folder_paths.get_input_directory()
        if d and os.path.isdir(d):
            return d
    except Exception:
        pass
    for _, path, _ in path_access.roots():
        if os.path.isdir(path):
            return path
    return os.path.abspath(os.getcwd())


def _browse_parent(path):
    """The directory above `path`, or None at a filesystem root or at the edge
    of the folders the viewer may open."""
    parent = os.path.dirname(os.path.abspath(path))
    if not parent or parent == path or not path_access.is_allowed(parent):
        return None
    return parent


def _browse_roots():
    """Shortcut destinations for the browser's jump menu: exactly the folders it
    may open."""
    return [{"label": label, "path": path}
            for label, path, _ in path_access.roots() if os.path.isdir(path)]


try:
    from aiohttp import web

    def register_routes():
        ps = PromptServer.instance
        if not ps or not getattr(ps, "app", None):
            raise RuntimeError("PromptServer.instance.app is not ready yet")
        router = ps.app.router

        def _add(method, path, handler):
            try:
                router.add_route(method, path, handler)
            except Exception as e:
                print(f"[ImageViewer] route register failed {method} {path}: {e}")

        def _safe_add(method, path, handler):
            _add(method, path, handler)
            # The same route under the viewer's old name ("bEpic", before 1.18),
            # for a caller that was not updated with it.
            for new, old in (("/imageviewer/", "/bepic/"), ("/api/imageviewer/", "/api/bepic/")):
                if path.startswith(new):
                    _add(method, old + path[len(new):], handler)

        async def _off_loop(fn, *args):
            """Run `fn` in a worker thread.

            For anything that touches the disk on a route the history strip calls:
            an `isfile`, a `realpath` or a thumbnail is quick on a local drive but
            can take tens of milliseconds - and now and then seconds - on a
            network share, and on the event loop that wait holds up EVERY other
            request. Measured on the W: share: a history switch's /imageviewer/raw_view
            took 40 ms alone, 180-310 ms while the strip's thumbnails were being
            answered and 4-4.7 s behind one /imageviewer/probe_paths of 166 paths.
            """
            return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

        async def _serve(path, prim=None, frame=0, cs=None, ev=None):
            """_file_response off the event loop: decoding and converting a
            frame takes long enough to hold up every other request."""
            return await asyncio.get_running_loop().run_in_executor(
                None, _file_response, path, prim, frame, cs, ev)

        async def _imageviewer_colorspaces(request):
            """The input colourspaces the viewer's selector offers, which of
            them is sRGB (nothing done) and which is plain linear."""
            from . import color_io
            info = await asyncio.get_running_loop().run_in_executor(None, color_io.info)
            return web.json_response(info)

        def _timeline_media(params):
            """The film a timeline request is about: ``(path, allowed, error)``.

            Reach is the same as the file's own: a film the viewer may show is a
            film whose timeline it may read - and change.
            """
            path = params.get('path')
            if path:
                if params.get('external'):
                    media = os.path.abspath(str(path))
                    return media, path_access.is_allowed(media), None
                media, allowed = _resolve_raw_path(str(path))
                return media, allowed, None
            if params.get('filename'):
                try:
                    base = folder_paths.get_directory_by_type(params.get('type') or 'output')
                except Exception:
                    base = None
                if not base:
                    return None, False, "unknown folder type"
                media = os.path.abspath(os.path.join(base, str(params.get('subfolder') or ''),
                                                     str(params['filename'])))
                return media, path_access.within(media, base), None
            return None, False, "missing 'path' or 'filename' parameter"

        async def _imageviewer_timeline(request):
            """The cut that lies beside a film: its ``.otio``.

            Flattened to seconds for drawing, and - under ``edit`` - as the Edit
            panel works on it (clips at full length, each with its dissolve). No
            timeline is the ordinary case (most films were generated, not cut)
            and answers 404 quietly.
            """
            from . import timeline_io

            # Off the event loop: resolving the film and looking for its sidecar
            # touch the disk, which on a network share can take a while.
            def _locate(params):
                media, allowed, error = _timeline_media(params)
                side = timeline_io.sidecar_for(media) if (allowed and not error) else None
                return media, allowed, error, side
            media, allowed, error, side = await _off_loop(_locate, dict(request.query))
            if error:
                return web.Response(status=400, text=error)
            if not allowed:
                return web.Response(status=403, text=path_access.refusal(media))
            if not side:
                return web.Response(status=404, text="no timeline beside this file")

            def _read():
                data = timeline_io.read(side)
                data["edit"] = timeline_io.read_editable(side)
                return data
            try:
                data = await asyncio.get_running_loop().run_in_executor(None, _read)
            except (OSError, ValueError) as exc:
                return web.Response(status=422, text=f"the timeline could not be read: {exc}")
            data["file"] = os.path.basename(side)
            data["otio"] = side
            return web.json_response(data, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_timeline_save(request):
            """Save a cut changed in the Edit panel into the ``.otio`` beside its film.

            Only an existing timeline can be saved into, and only its own clips
            and texts can be in the edit (timeline_io.rebuild): the panel cuts
            what is there. Nothing is rendered - the viewer starts no process -
            so the film stays as it was until its maker renders the edited cut;
            the file is stamped so that it can tell.
            """
            from . import timeline_io
            allowed, why = path_access.same_origin(request)
            if not allowed:
                return web.Response(status=403, text=why)
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400, text="the request is not JSON")
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            import datetime
            now = datetime.datetime.now(datetime.timezone.utc)
            stamp = now.isoformat(timespec="seconds")
            create = None
            if body.get("new"):
                # A cut started in the panel, with no film yet: it gets a file of
                # its own in ComfyUI's output folder, where its maker will look.
                try:
                    base = folder_paths.get_output_directory()
                except Exception:
                    base = None
                if not base:
                    return web.Response(status=500, text="ComfyUI has no output folder")
                from . import export_rules
                try:
                    where = export_rules.target("edit", body.get("name") or "cut", "otio", base,
                                                body.get("context"))
                except ValueError as exc:
                    return web.Response(status=400, text=str(exc))
                side = where["path"]
                create = os.path.splitext(os.path.basename(side))[0]
            else:
                media, allowed, error = _timeline_media(body)
                if error:
                    return web.Response(status=400, text=error)
                if not allowed:
                    return web.Response(status=403, text=path_access.refusal(media))
                side = timeline_io.sidecar_for(media)
                if not side:
                    return web.Response(status=404, text="no timeline beside this file")

            def _may_use(path):
                return path_access.is_allowed(path)

            def _save():
                edit = timeline_io.save(side, body.get("edit"), stamp, _may_use, create)
                data = timeline_io.read(side)
                data["edit"] = edit
                return data
            try:
                data = await asyncio.get_running_loop().run_in_executor(None, _save)
            except ValueError as exc:
                return web.Response(status=422, text=f"not saved: {exc}")
            except OSError as exc:
                return web.Response(status=500, text=f"not saved: {exc}")
            data["file"] = os.path.basename(side)
            data["otio"] = side
            data["path"] = os.path.abspath(side)         # where it is: the panel says so
            if create is not None:
                # How the panel names this cut from now on.
                data["target"] = {"path": side, "external": 1}
            return web.json_response(data, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_timeline_save_as(request):
            """Save cut as: the cut into a new ``.otio`` of the user's choosing.

            ``{"name", "folder", "edit", "source": <the target of the cut's file, or
            none>, "overwrite": bool}``. The folder must be one the viewer may use
            (path_access), the name cannot leave it (timeline_io.cut_file_name), and a
            file that is there answers 409 unless ``overwrite``. The source stays as it was.
            """
            from . import timeline_io
            allowed, why = path_access.same_origin(request)
            if not allowed:
                return web.Response(status=403, text=why)
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400, text="the request is not JSON")
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            folder = str(body.get("folder") or "").strip()
            if not folder:
                return web.Response(status=400, text="no folder")
            folder = os.path.abspath(folder)
            side = os.path.join(folder, timeline_io.cut_file_name(body.get("name")))
            if not path_access.is_allowed(folder) or not path_access.is_allowed(side):
                return web.Response(status=403, text=path_access.refusal(folder))
            source = None
            if isinstance(body.get("source"), dict):
                media, allowed, error = _timeline_media(body["source"])
                if error:
                    return web.Response(status=400, text=error)
                if not allowed:
                    return web.Response(status=403, text=path_access.refusal(media))
                source = timeline_io.sidecar_for(media)
            import datetime
            stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            overwrite = body.get("overwrite") is True

            def _save():
                if os.path.exists(side) and not overwrite:
                    return None
                edit = timeline_io.save_as(side, source, body.get("edit"), stamp, path_access.is_allowed)
                data = timeline_io.read(side)
                data["edit"] = edit
                return data
            try:
                data = await asyncio.get_running_loop().run_in_executor(None, _save)
            except ValueError as exc:
                return web.Response(status=422, text=f"not saved: {exc}")
            except OSError as exc:
                return web.Response(status=500, text=f"not saved: {exc}")
            if data is None:
                return web.json_response({"exists": True, "path": side}, status=409)
            data["file"] = os.path.basename(side)
            data["otio"] = side
            data["path"] = side
            data["target"] = {"path": side, "external": 1}
            return web.json_response(data, headers={"Cache-Control": "no-cache"})

        # ── Export to Resolve: a folder with the original clips and a timeline ──

        async def _resolve_body(request):
            """``(body, None)`` or ``(None, a refusal)``: from ComfyUI's own page, JSON."""
            allowed, why = path_access.same_origin(request)
            if not allowed:
                return None, web.Response(status=403, text=why)
            try:
                body = await request.json()
            except Exception:
                return None, web.Response(status=400, text="the request is not JSON")
            if not isinstance(body, dict):
                return None, web.Response(status=400, text="the request is not an object")
            return body, None

        def _resolve_plan(body):
            """What the request would export, as ``(doc, plan)``; raises what it refuses."""
            from . import resolve_export, timeline_io
            source = body.get("source") if isinstance(body.get("source"), dict) else {}
            media, allowed, error = _timeline_media(source)
            if error:
                raise _ResolveRefused(400, error)
            if not allowed:
                raise _ResolveRefused(403, path_access.refusal(media))
            side = timeline_io.sidecar_for(media)
            if not side:
                raise _ResolveRefused(404, "no timeline beside this file: save the cut first")
            frames = body.get("frames")
            if frames is not None and not (isinstance(frames, list) and len(frames) == 2
                                           and all(isinstance(v, int) and not isinstance(v, bool) and v >= 0
                                                   for v in frames) and frames[0] <= frames[1]):
                raise _ResolveRefused(400, "frames is not [first, last]")
            folder = str(body.get("folder") or "").strip() or os.path.dirname(os.path.abspath(side))
            folder = os.path.abspath(folder)
            if not path_access.is_allowed(folder):
                raise _ResolveRefused(403, path_access.refusal(folder))
            doc = timeline_io._load(side)
            # A copy hands a file's bytes to whoever reads the package: the serve rule.
            plan = resolve_export.make_plan(doc, side, folder, body.get("name") or None, frames, path_access.may_serve,
                                            bake=body.get("bake_fx") if isinstance(body.get("bake_fx"), bool) else None)
            if not path_access.is_allowed(plan["path"]):
                raise _ResolveRefused(403, path_access.refusal(plan["path"]))
            return doc, plan

        class _ResolveRefused(Exception):
            def __init__(self, status, text):
                super().__init__(text)
                self.status, self.text = status, text

        async def _imageviewer_export_resolve_plan(request):
            """What Export to Resolve would copy: ``{name, folder, path, exists, size, free,
            files, missing, refused, flagged, left_out, ...}``. Nothing is written."""
            from . import resolve_export
            body, refused = await _resolve_body(request)
            if refused is not None:
                return refused
            try:
                _doc, plan = await asyncio.get_running_loop().run_in_executor(None, _resolve_plan, body)
            except _ResolveRefused as exc:
                return web.Response(status=exc.status, text=exc.text)
            except ValueError as exc:
                return web.Response(status=422, text=str(exc))
            except OSError as exc:
                return web.Response(status=500, text=str(exc))
            return web.json_response(resolve_export.public(plan), headers={"Cache-Control": "no-cache"})

        async def _imageviewer_export_resolve(request):
            """Start making the package; the work runs in a thread of its own
            (resolve_export.Job), and ``{"id"}`` is what to ask the status route with.

            ``{"source", "name", "folder", "frames", "continue_missing"}``. 403: outside the
            viewer's folders. 409: the target is there. 422: files are missing (they are
            named; ``continue_missing`` goes on without them). 507: not enough room.
            """
            from . import resolve_export
            body, refused = await _resolve_body(request)
            if refused is not None:
                return refused

            def _begin():
                doc, plan = _resolve_plan(body)
                if plan["refused"]:
                    names = ", ".join(os.path.basename(p) for p in plan["refused"][:12])
                    raise _ResolveRefused(403, f"The viewer may not copy these: {names}. "
                                          + path_access.refusal(plan["refused"][0]))
                if plan["exists"]:
                    raise _ResolveRefused(409, f"{plan['path']} is there already: choose another name.")
                if plan["missing"] and body.get("continue_missing") is not True:
                    raise _ResolveRefused(422, "Missing: " + ", ".join(plan["missing"][:12]))
                resolve_export.check_room(plan)
                return resolve_export.start(doc, plan)
            try:
                job = await asyncio.get_running_loop().run_in_executor(None, _begin)
            except _ResolveRefused as exc:
                return web.Response(status=exc.status, text=exc.text)
            except resolve_export.NoRoom as exc:
                return web.Response(status=507, text=str(exc))
            except ValueError as exc:
                return web.Response(status=422, text=str(exc))
            except OSError as exc:
                return web.Response(status=500, text=str(exc))
            return web.json_response(job.state(), headers={"Cache-Control": "no-cache"})

        async def _imageviewer_export_resolve_status(request):
            """How far a package is: ``{status: running|done|failed|cancelled, done, total, ...}``."""
            from . import resolve_export
            body, refused = await _resolve_body(request)
            if refused is not None:
                return refused
            job = resolve_export.job_of(body.get("id"))
            if job is None:
                return web.Response(status=404, text="no such export")
            return web.json_response(job.state(), headers={"Cache-Control": "no-cache"})

        async def _imageviewer_export_resolve_cancel(request):
            """Stop a package; what it had made so far is removed by its own thread."""
            from . import resolve_export
            body, refused = await _resolve_body(request)
            if refused is not None:
                return refused
            job = resolve_export.job_of(body.get("id"))
            if job is None:
                return web.Response(status=404, text="no such export")
            job.cancel()
            return web.json_response(job.state(), headers={"Cache-Control": "no-cache"})

        # ── what the Edit panel draws in its clips, and Auto edit measures ──
        #
        # timeline_media.py does the reading (PyAV, in this process). The work
        # runs in a small pool of its own: a timeline of new clips asks for many
        # readings at once, and they must not take the threads the picture being
        # played is fetched with (raw_view and the thumbnails use the default one).
        _media_pool = []

        async def _media_work(fn, *args):
            if not _media_pool:
                from concurrent.futures import ThreadPoolExecutor
                _media_pool.append(ThreadPoolExecutor(max_workers=2, thread_name_prefix="imageviewer-media"))
            return await asyncio.get_running_loop().run_in_executor(_media_pool[0], fn, *args)

        def _media_path(params):
            """``(path, response)`` for a reading route: the file asked about, or the refusal.

            ``path`` (absolute) or ComfyUI's ``filename`` / ``type`` / ``subfolder``;
            only a picture, film or sound in the allowed folders (``may_serve``):
            these routes hand back what is IN the file.
            """
            raw = str(params.get("path") or "").strip()
            if raw:
                path = os.path.abspath(raw)
            else:
                path = _resolve_comfy_ref(params.get("filename"), params.get("type"), params.get("subfolder"))
                if path is None:
                    return None, web.Response(status=400, text="missing 'path', or an unresolvable filename")
            if not path_access.may_serve(path):
                return None, web.Response(status=403, text=path_access.serve_refusal(path))
            if not os.path.isfile(path):
                return None, web.Response(status=404, text="file not found")
            return path, None

        async def _media_reading(request, kind, fn, *args):
            """``(path, reading, etag)``, or the response to send instead (a refusal, a 304)."""
            from . import timeline_media
            path, refused = await _off_loop(_media_path, dict(request.query))
            if refused is not None:
                return refused
            try:
                tag = await _off_loop(timeline_media.etag, path, kind + repr(args))
            except OSError:
                return web.Response(status=404, text="file not found")
            if request.headers.get("If-None-Match") == tag:
                return web.Response(status=304, headers={"ETag": tag, "Cache-Control": "no-cache"})
            try:
                got = await _media_work(fn, path, *args)
            except ValueError as exc:                    # MediaError is one
                return web.Response(status=422, text=str(exc))
            except OSError as exc:
                return web.Response(status=500, text=f"not read: {exc}")
            return path, got, tag

        async def _imageviewer_timeline_peaks(request):
            """The waveform of a file's sound (timeline_media.peaks), cached by path, mtime and size."""
            from . import timeline_media
            got = await _media_reading(request, "peaks", timeline_media.peaks)
            if isinstance(got, web.StreamResponse):
                return got
            return web.json_response(got[1], headers={"ETag": got[2], "Cache-Control": "no-cache"})

        async def _imageviewer_timeline_strip(request):
            """A filmstrip: ``n`` frames of a film side by side on one JPEG (timeline_media.strip).

            What the sheet holds is in the headers: ``X-Strip-N`` tiles, each
            ``X-Strip-Tw`` x ``X-Strip-Th``, of a file ``X-Strip-Duration`` long;
            tile i is the middle of the i-th of n equal parts of ``X-Strip-Start`` ..
            ``X-Strip-End``: the whole file, or the part ``start`` .. ``end`` (seconds)
            asked for - a clip cut out of a long film shows frames of its own part.
            """
            from . import timeline_media
            n, h = timeline_media.strip_size(request.query.get("n"), request.query.get("h"))
            window = timeline_media.strip_window(request.query.get("start"), request.query.get("end"))
            got = await _media_reading(request, "strip", timeline_media.strip, n, h, window)
            if isinstance(got, web.StreamResponse):
                return got
            jpeg, meta = got[1]
            return web.FileResponse(jpeg, headers={
                "ETag": got[2], "Cache-Control": "no-cache", "Content-Type": "image/jpeg",
                "X-Strip-N": str(meta["n"]), "X-Strip-Tw": str(meta["tw"]), "X-Strip-Th": str(meta["th"]),
                "X-Strip-Duration": str(meta["duration"]),
                "X-Strip-Start": str(meta.get("start", 0.0)), "X-Strip-End": str(meta.get("end", meta["duration"]))})

        async def _imageviewer_timeline_beats(request):
            """Where the beats of a piece of music fall (agentY's read_beats, ported)."""
            from . import timeline_media
            got = await _media_reading(request, "beats", timeline_media.beats)
            if isinstance(got, web.StreamResponse):
                return got
            return web.json_response(got[1], headers={"ETag": got[2], "Cache-Control": "no-cache"})

        async def _imageviewer_timeline_shots(request):
            """Where a film cuts: its shot lengths (agentY's read_rhythm, ported)."""
            from . import timeline_media
            try:
                sens = max(0.01, min(1.0, float(request.query.get("sensitivity") or 0.3)))
            except ValueError:
                sens = 0.3
            got = await _media_reading(request, "shots", timeline_media.shots, sens)
            if isinstance(got, web.StreamResponse):
                return got
            return web.json_response(got[1], headers={"ETag": got[2], "Cache-Control": "no-cache"})

        async def _imageviewer_timeline_cuts(request):
            """Scene cut detection: where a film that is already an edit cuts (timeline_media.detect_cuts)."""
            from . import timeline_media
            got = await _media_reading(request, "cuts", timeline_media.detect_cuts)
            if isinstance(got, web.StreamResponse):
                return got
            return web.json_response(got[1], headers={"ETag": got[2], "Cache-Control": "no-cache"})

        async def _imageviewer_take(request):
            """A shot made again: new takes of the clips of a cut that use some file.

            ``{"otio": str, "takes": [{"from_file", "file", "version", "note"}], "retime": bool}``.
            agentY's "recreate these shots with changes" posts here once a new version of a
            shot is on disk. Every clip of the cut (``otio``) whose media is ``from_file`` gets
            ``file`` as its next take (timeline_io.add_take) and the timeline is saved
            (written beside it and moved over). Then ``imageviewer.edit.take`` goes to the pages,
            so an Edit panel that has the cut open takes the take in as one undo step
            (imageViewer_editTimeline.js: editTlTakeIn). Answers ``{"ok", "saved", "applied",
            "pushed", "notes"}``; the timeline is fenced like the other timeline routes
            (path_access.is_allowed) and every new file like any file the viewer hands back
            (path_access.may_serve). Only ComfyUI's own page or a caller with no browser
            Origin may post, as application/json (path_access.same_origin). ``client_id``
            (query string) names the asking tab; the event still goes to every page,
            because any panel that has the cut open must take the take in, or its next save
            would drop it.
            """
            from . import timeline_io
            allowed, why = path_access.same_origin(request)
            if not allowed:
                return web.json_response({"ok": False, "error": why}, status=403)
            client_id = str(request.query.get("client_id") or "")[:200]
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"ok": False, "error": "the request is not JSON"}, status=400)
            if not isinstance(body, dict):
                return web.json_response({"ok": False, "error": "the request is not an object"}, status=400)
            raw = body.get("takes")
            if not isinstance(raw, list) or not raw or len(raw) > 50:
                return web.json_response({"ok": False, "error": "'takes' is a list of 1 to 50 takes"}, status=400)
            import datetime
            stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            takes = []
            for n, t in enumerate(raw, 1):
                if not isinstance(t, dict):
                    return web.json_response({"ok": False, "error": f"take {n} is not an object"}, status=400)
                src, new = t.get("from_file"), t.get("file")
                if not isinstance(src, str) or not src.strip() or len(src) > 2000 \
                        or not isinstance(new, str) or not new.strip() or len(new) > 2000:
                    return web.json_response({"ok": False, "error": f"take {n} needs 'from_file' and 'file' (paths)"},
                                             status=400)
                version, note = t.get("version", 0), t.get("note", "")
                if isinstance(version, bool) or not isinstance(version, int) or version < 0 or version > 99999:
                    version = 0
                if not isinstance(note, str):
                    note = ""
                path = os.path.abspath(new.strip())
                if not path_access.may_serve(path):
                    return web.json_response({"ok": False, "error": path_access.serve_refusal(path)}, status=403)
                if not os.path.isfile(path):
                    return web.json_response({"ok": False, "error": f"{os.path.basename(path)} does not exist"},
                                             status=400)
                takes.append({"from_file": src.strip(), "file": path.replace("\\", "/"),
                              "version": version or timeline_io.version_of(path), "note": note.strip()[:200],
                              "created": stamp})
            retime = body.get("retime") is True
            otio_raw = body.get("otio")
            if otio_raw is not None and not isinstance(otio_raw, str):
                return web.json_response({"ok": False, "error": "'otio' is a path"}, status=400)
            otio = os.path.abspath(otio_raw.strip()) if otio_raw and otio_raw.strip() else ""
            if otio:
                if not otio.lower().endswith(".otio"):
                    return web.json_response({"ok": False, "error": "'otio' is not a timeline file (.otio)"}, status=400)
                if not path_access.is_allowed(otio):
                    return web.json_response({"ok": False, "error": path_access.refusal(otio)}, status=403)

            def _apply():
                """(saved, applied, notes): the takes put into the file, if there is one."""
                notes = []
                if not otio:
                    return False, 0, ["no timeline file was named; the open Edit panels were told"]
                if not os.path.isfile(otio):
                    return False, 0, [f"{os.path.basename(otio)} does not exist; the open Edit panels were told"]
                try:
                    doc = timeline_io._load(otio)
                    timeline_io.editable(doc)               # a timeline, and one this can read
                except (OSError, ValueError) as exc:
                    return False, 0, [f"{os.path.basename(otio)} could not be read ({exc}); the open Edit panels were told"]
                total = 0
                for t in takes:
                    duration = None
                    try:
                        from . import timeline_media
                        duration = float(timeline_media.probe(t["file"]).get("duration") or 0) or None
                    except Exception as exc:  # noqa: BLE001 - PyAV missing or a file it cannot read: the panel clamps
                        notes.append(f"{os.path.basename(t['file'])}: its length is not known here ({exc})")
                    doc, n = timeline_io.add_take(doc, t["from_file"], t["file"], t["version"], t["note"],
                                                  t["created"], retime, duration)
                    total += n
                    if not n:
                        notes.append(f"no clip of {os.path.basename(otio)} uses {os.path.basename(t['from_file'])}")
                if not total:
                    return False, 0, notes
                tmp = otio + ".tmp"
                with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                    json.dump(doc, fh, indent=2)
                os.replace(tmp, otio)
                return True, total, notes
            try:
                saved, applied, notes = await asyncio.get_running_loop().run_in_executor(None, _apply)
            except OSError as exc:
                return web.json_response({"ok": False, "error": f"not saved: {exc}"}, status=500)
            pushed = False
            try:
                PromptServer.instance.send_sync("imageviewer.edit.take", {"otio": otio, "takes": takes, "saved": saved,
                                                                     "retime": retime, "client_id": client_id})
                pushed = True
            except Exception as exc:  # noqa: BLE001 - no page may be listening; the file is saved all the same
                notes.append(f"the pages could not be told ({exc})")
            return web.json_response({"ok": True, "saved": saved, "applied": applied, "pushed": pushed, "notes": notes})

        async def _imageviewer_cut(request):
            """A cut read, or changed, by agentY (its edit_cut tool): ``{"otio": str, "ops": [...]}``.

            No ``ops``: the cut as the Edit panel works on it (``edit``), nothing written.
            With ``ops`` (timeline_io.apply_ops: add a clip at a moment of the film, set a
            clip's in / length / place / volume, remove one) the cut is changed and saved
            the way the panel saves it (timeline_io.change), and ``imageviewer.edit.changed``
            ({otio, edit, said, client_id}) goes to the pages: an Edit panel that has the
            cut open takes the new cut in as one undo step (imageViewer_editTakes.js:
            editTlChangedIn). Answers ``{"ok", "otio", "edit", "length", "saved", "said",
            "pushed"}``. Fenced like the take route: the timeline by path_access.is_allowed,
            every file added by path_access.may_serve, and only ComfyUI's own page or a
            caller with no browser Origin may post.
            """
            from . import timeline_io
            allowed, why = path_access.same_origin(request)
            if not allowed:
                return web.json_response({"ok": False, "error": why}, status=403)
            client_id = str(request.query.get("client_id") or "")[:200]
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"ok": False, "error": "the request is not JSON"}, status=400)
            if not isinstance(body, dict):
                return web.json_response({"ok": False, "error": "the request is not an object"}, status=400)
            otio_raw = body.get("otio")
            if not isinstance(otio_raw, str) or not otio_raw.strip():
                return web.json_response({"ok": False, "error": "'otio' (the cut's .otio path) is needed"}, status=400)
            otio = os.path.abspath(otio_raw.strip())
            if not otio.lower().endswith(".otio"):
                return web.json_response({"ok": False, "error": "'otio' is not a timeline file (.otio)"}, status=400)
            if not path_access.is_allowed(otio):
                return web.json_response({"ok": False, "error": path_access.refusal(otio)}, status=403)
            ops = body.get("ops")
            if ops is not None and not isinstance(ops, list):
                return web.json_response({"ok": False, "error": "'ops' is a list of changes"}, status=400)
            ops = ops or []
            if len(ops) > timeline_io.MAX_OPS:
                return web.json_response({"ok": False, "error": f"at most {timeline_io.MAX_OPS} changes at once"},
                                         status=400)
            files = []
            for n, op in enumerate(ops, 1):
                if isinstance(op, dict) and str(op.get("op") or "").lower() == "add":
                    raw = op.get("file")
                    if not isinstance(raw, str) or not raw.strip() or len(raw) > 2000:
                        return web.json_response({"ok": False, "error": f"change {n} (add) needs 'file' (a path)"},
                                                 status=400)
                    path = os.path.abspath(raw.strip())
                    if not path_access.may_serve(path):
                        return web.json_response({"ok": False, "error": path_access.serve_refusal(path)}, status=403)
                    if not os.path.isfile(path):
                        return web.json_response({"ok": False, "error": f"{os.path.basename(path)} does not exist"},
                                                 status=400)
                    op["file"] = path.replace("\\", "/")
                    files.append(op["file"])
            marked = body.get("range")
            if marked is not None:
                try:
                    marked = (int(marked["start"]), int(marked["end"]))
                except (TypeError, KeyError, ValueError):
                    return web.json_response({"ok": False, "error": "'range' is {\"start\": frame, \"end\": frame} "
                                              "(film frames of the cut, both included)"}, status=400)
            import datetime
            stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

            def _sources(edit):
                """The marked range in the sources (timeline_io.source_map), at each file's own frame rate."""
                first = timeline_io.source_map(edit, *marked)
                rates = {}
                for p in first["pieces"]:
                    f = p.get("file") or ""
                    if f and "src_fps" in p and f not in rates:
                        rates[f] = 0.0
                        try:
                            path = os.path.abspath(f)
                            if path_access.may_serve(path) and os.path.isfile(path):
                                from . import timeline_media
                                rates[f] = float(timeline_media.probe(path).get("fps") or 0)
                        except Exception:  # noqa: BLE001 - unreadable: the cut's rate is taken, and said
                            pass
                return timeline_io.source_map(edit, *marked, src_fps=rates)

            def _work():
                if not os.path.isfile(otio):
                    raise FileNotFoundError(f"{os.path.basename(otio)} does not exist")
                if not ops:
                    edit = timeline_io.read_editable(otio)
                    return edit, [], (_sources(edit) if marked else None)
                durations = {}
                for f in files:
                    try:
                        from . import timeline_media
                        durations[f] = float(timeline_media.probe(f).get("duration") or 0)
                    except Exception:  # noqa: BLE001 - PyAV missing or unreadable: the op must give 'length'
                        pass
                edit, said = timeline_io.change(otio, ops, stamp, path_access.is_allowed, durations)
                return edit, said, (_sources(edit) if marked else None)
            try:
                edit, said, sources = await asyncio.get_running_loop().run_in_executor(None, _work)
            except FileNotFoundError as exc:
                return web.json_response({"ok": False, "error": str(exc)}, status=404)
            except ValueError as exc:
                return web.json_response({"ok": False, "error": f"not changed: {exc}"}, status=422)
            except OSError as exc:
                return web.json_response({"ok": False, "error": f"not saved: {exc}"}, status=500)
            out = {"ok": True, "otio": otio, "edit": edit, "length": round(timeline_io.edit_length(edit), 4),
                   "saved": bool(ops), "said": said, "pushed": False}
            if sources is not None:
                out["marked"] = sources
            if ops:
                try:
                    PromptServer.instance.send_sync("imageviewer.edit.changed", {
                        "otio": otio, "edit": edit, "file": os.path.basename(otio), "said": said,
                        "client_id": client_id})
                    out["pushed"] = True
                except Exception as exc:  # noqa: BLE001 - no page may be listening; the file is saved all the same
                    out["notes"] = [f"the pages could not be told ({exc})"]
            return web.json_response(out, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_timeline_probe(request):
            """How long files are and what they hold: ``{"info": {path: {...} | {"error"}}}``.

            The Edit panel's lengths come from here (the container's header, read
            in this process) and only fall back to the browser's ``<video>``.
            """
            from . import timeline_media
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400, text="the request is not JSON")
            paths = body.get("paths") if isinstance(body, dict) else None
            if not isinstance(paths, list) or len(paths) > 200:
                return web.Response(status=400, text="'paths' is a list of at most 200 files")

            def one(raw):
                path = os.path.abspath(str(raw or ""))
                if not path_access.may_serve(path):
                    return {"error": "not allowed"}
                if not os.path.isfile(path):
                    return {"error": "not found"}
                try:
                    return timeline_media.probe(path)
                except ValueError as exc:
                    return {"error": str(exc)}
            info = {}
            for raw in paths:
                info[str(raw)] = await _media_work(one, raw)
            return web.json_response({"info": info}, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_timeline_locate(request):
            """Files named the way ComfyUI names its outputs (``filename`` / ``type`` /
            ``subfolder``: the queue's and the history's), as the paths a cut holds."""
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400, text="the request is not JSON")
            items = body.get("items") if isinstance(body, dict) else None
            if not isinstance(items, list) or len(items) > 200:
                return web.Response(status=400, text="'items' is a list of at most 200 files")

            def find(items):
                out = []
                for it in items:
                    it = it if isinstance(it, dict) else {}
                    path = _resolve_comfy_ref(it.get("filename"), it.get("type"), it.get("subfolder"))
                    ok = bool(path) and path_access.may_serve(path) and os.path.isfile(path)
                    out.append(path if ok else None)
                return out
            return web.json_response({"paths": await _off_loop(find, items)})

        async def _imageviewer_timeline_upload(request):
            """A file dropped onto the Edit panel from the desktop, kept in ``<input>/edits``
            (a dropped ``.otio`` cut: in ``<input>/edits/cuts``, opened as a cut, never reusing a
            file of that name unless its bytes are the same).

            A cut holds paths, and a file dropped from the explorer arrives as its
            bytes only. Pictures, films and sound only (``is_media``), under their
            own base name made safe; a file of that name and size already there is
            used again rather than copied twice. Never written over.
            """
            from . import timeline_media
            try:
                reader = await request.multipart()
                field = await reader.next()
                while field is not None and field.name != "file":
                    field = await reader.next()
            except Exception:
                return web.Response(status=400, text="the request is not a file upload")
            if field is None or not field.filename:
                return web.Response(status=400, text="no file in the upload")
            name = timeline_media.upload_name(field.filename)
            is_cut = name.lower().endswith(".otio")        # a cut dropped from the desktop: opened as a cut
            if not is_cut and not path_access.is_media(name):
                return web.Response(status=415, text=f"{name} is not a picture, film, sound or cut (.otio)")
            try:
                base = folder_paths.get_input_directory()
            except Exception:
                base = None
            if not base:
                return web.Response(status=500, text="ComfyUI has no input folder")
            folder = os.path.join(base, "edits", "cuts") if is_cut else os.path.join(base, "edits")
            data = bytearray()
            while True:
                chunk = await field.read_chunk(1 << 20)
                if not chunk:
                    break
                data.extend(chunk)
                if is_cut and len(data) > (64 << 20):
                    return web.Response(status=413, text="that cut file is too large")

            def _keep():
                if is_cut:
                    path, there = timeline_media.place_cut_upload(folder, name, data)
                else:
                    path, there = timeline_media.place_upload(folder, name, len(data))
                if not there:
                    tmp = path + ".part"
                    with open(tmp, "wb") as fh:
                        fh.write(data)
                    os.replace(tmp, path)
                return path, there
            try:
                path, there = await _off_loop(_keep)
            except OSError as exc:
                return web.Response(status=500, text=f"not written: {exc}")
            return web.json_response({"path": path, "name": os.path.basename(path), "reused": there})

        async def _imageviewer_fonts(request):
            """The font families of this machine, for a title's font picker
            (title_render.font_list: families, each face with its id and metrics -
            no paths). Read once (Pillow, the OS's font folders), kept for the
            life of the process; ``?refresh=1`` reads them again."""
            from . import title_render
            if request.query.get("refresh") == "1":
                await _off_loop(title_render.fonts, True)
            got = await _off_loop(title_render.font_list)
            return web.json_response(got, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_font_file(request):
            """ONE font file of the machine's list (``/imageviewer/fonts``), by its id -
            never by a path, so nothing outside the OS's font folders can be
            asked for; a face of a collection (.ttc) as a font file of its own.
            The browser draws a title with it, as the render does."""
            from . import title_render
            face = title_render.face_by_id(request.query.get("id"))
            if not face:
                return web.Response(status=404, text="no such font")
            try:
                data = await _off_loop(title_render.face_bytes, face)
            except (OSError, ValueError) as exc:
                return web.Response(status=404, text=f"the font could not be read: {exc}")
            kind = "font/otf" if data[:4] == b"OTTO" else "font/ttf"
            return web.Response(body=data, content_type=kind,
                                headers={"Cache-Control": "private, max-age=86400"})

        async def _imageviewer_timeline_solid(request):
            """A plain colour as a picture a cut can hold: the Effects panel's generators.

            A clip is a piece of a file, so a colour has to be one: a PNG under
            ``<output>/imageviewer/edits/solids``, named after its colour and size, so
            asking twice gives the same file and nothing piles up.
            """
            import re
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400, text="the request is not JSON")
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            color = str(body.get("color") or "#000000").lower()
            if not re.match(r"^#[0-9a-f]{6}$", color):
                return web.Response(status=400, text="a colour is written #rrggbb")
            try:
                w, h = int(body.get("width") or 1920), int(body.get("height") or 1080)
            except (TypeError, ValueError):
                return web.Response(status=400, text="the size is not a number")
            if not (16 <= w <= 8192 and 16 <= h <= 8192):
                return web.Response(status=400, text="the size is out of range")
            try:
                base = folder_paths.get_output_directory()
            except Exception:
                base = None
            if not base:
                return web.Response(status=500, text="ComfyUI has no output folder")
            folder = os.path.join(base, "imageviewer", "edits", "solids")
            path = os.path.join(folder, f"solid_{color[1:]}_{w}x{h}.png")

            def _make():
                if os.path.isfile(path):
                    return
                from PIL import Image
                os.makedirs(folder, exist_ok=True)
                rgb = tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))
                tmp = path + ".tmp"
                Image.new("RGB", (w, h), rgb).save(tmp, "PNG")
                os.replace(tmp, path)
            try:
                await asyncio.get_running_loop().run_in_executor(None, _make)
            except OSError as exc:
                return web.Response(status=500, text=f"not written: {exc}")
            return web.json_response({"path": path, "name": os.path.basename(path), "color": color})

        async def _imageviewer_timeline_render(request):
            """Render the saved cut of a film into a film of its own.

            Done in this process (timeline_render.py, through PyAV): no program
            is started. The film a cut lies beside is never written over - it
            may be somebody's render - so the result goes next to it as
            ``<name>_cut<N>``, with its timeline beside it; a cut that has no
            film yet gets one of its own name. Texts are not drawn here, and the
            answer says how many were left out.
            """
            from . import timeline_io, timeline_render
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400, text="the request is not JSON")
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            media, allowed, error = _timeline_media(body)
            if error:
                return web.Response(status=400, text=error)
            if not allowed:
                return web.Response(status=403, text=path_access.refusal(media))
            side = timeline_io.sidecar_for(media)
            if not side:
                return web.Response(status=404, text="no timeline beside this file")
            from . import export_rules
            fmt = str(body.get("format") or "mp4").lower()
            if fmt not in timeline_render.FORMATS:
                return web.Response(status=400, text=f"unknown format: {fmt}")
            codec, quality = body.get("codec"), str(body.get("quality") or "high")
            # "Export in-out only": the frames of the film between the Edit panel's in and out.
            frames = body.get("frames")
            if frames is not None and not (isinstance(frames, list) and len(frames) == 2
                                           and all(isinstance(v, int) and not isinstance(v, bool) and v >= 0
                                                   for v in frames) and frames[0] <= frames[1]):
                return web.Response(status=400, text="frames is not [first, last]")
            # Where it goes and what it is called is the rule every export
            # follows: the shot's folder when the canvas names one, the plain
            # one otherwise, and always the next version - never over a film
            # that is there.
            try:
                where = export_rules.target(
                    "video", body.get("name") or os.path.splitext(os.path.basename(side))[0],
                    fmt, folder_paths.get_output_directory(), body.get("context"),
                    body.get("version"))
            except ValueError as exc:
                return web.Response(status=400, text=str(exc))
            out = where["path"]

            def _render():
                import copy
                import datetime
                import json as _json
                doc = timeline_io._load(side)
                got = timeline_render.render(doc, out, fmt, path_access.is_allowed, codec, quality, frames)
                # The timeline that goes with the new film: this cut, marked as
                # rendered rather than as changed-and-waiting.
                done = copy.deepcopy(doc)
                meta = done.setdefault("metadata", {})
                if isinstance(meta, dict):
                    meta["imageviewer"] = {"rendered": datetime.datetime.now(datetime.timezone.utc)
                                     .isoformat(timespec="seconds"),
                                     "texts_left_out": got["texts_left_out"]}
                beside = os.path.splitext(out)[0] + ".otio"
                tmp = beside + ".tmp"
                with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                    _json.dump(done, fh, indent=2)
                os.replace(tmp, beside)
                return got
            try:
                got = await asyncio.get_running_loop().run_in_executor(None, _render)
            except ValueError as exc:                       # RenderError is one
                return web.Response(status=422, text=f"not rendered: {exc}")
            except OSError as exc:
                return web.Response(status=500, text=f"not rendered: {exc}")
            got["name"] = os.path.basename(got["path"])
            got["relative"], got["version"] = where["relative"], where["version"]
            return web.json_response(got, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_export_options(request):
            """What an export can be: the formats, the codecs each can hold and
            which is the default, the names quality goes by (export_rules)."""
            from . import export_rules
            return web.json_response(export_rules.options())

        async def _imageviewer_export_target(request):
            """Where an export WOULD go and what it would be called, for the
            dialog to show before anything is written. Nothing is created."""
            from . import export_rules
            try:
                body = await request.json()
            except Exception:
                body = None
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            try:
                where = export_rules.target(body.get("kind"), body.get("name"), body.get("ext"),
                                            folder_paths.get_output_directory(),
                                            body.get("context"), body.get("version"))
            except (ValueError, TypeError) as exc:
                return web.Response(status=400, text=str(exc))
            if body.get("sequence"):
                seq = export_rules.sequence_target(body.get("kind"), body.get("name"), body.get("ext"),
                                                   folder_paths.get_output_directory(),
                                                   body.get("context"), body.get("version"))
                where = dict(where, relative=seq["relative"], exists=False)
            return web.json_response({k: where[k] for k in ("relative", "version", "layout", "exists")})

        async def _imageviewer_export_places(request):
            """The folders a kind of file is looked for in (export_rules.places):
            where a picker opens, and the shortcuts it offers."""
            from . import export_rules
            try:
                body = await request.json()
            except Exception:
                body = None
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            try:
                found = export_rules.places(body.get("kind"), folder_paths.get_output_directory(),
                                            body.get("context"))
            except (ValueError, TypeError) as exc:
                return web.Response(status=400, text=str(exc))
            return web.json_response({"places": found})

        async def _imageviewer_export_view(request):
            """Export what is on screen (export_view.py): the frame being looked
            at as a PNG, or the whole clip as a film - by the rule every export
            follows, so as the next version in the shot's folder or the viewer's.

            Body: ``{scope: "frame" | "clip", name, context, files: [{path |
            filename, subfolder, type}], frame, fps, cs, format, codec, quality,
            dataurl}``. `files` is the tab's frames: one video, or the pictures
            of a sequence. `dataurl` stands in for a clip only the browser has.
            """
            from . import export_rules, export_view, timeline_render
            try:
                body = await request.json()
            except Exception:
                body = None
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            scope = "clip" if body.get("scope") == "clip" else "frame"
            out_dir = folder_paths.get_output_directory()
            cs = str(body.get("cs") or "")
            try:
                index = max(0, int(body.get("frame") or 0))
            except (TypeError, ValueError):
                index = 0

            paths = []
            for item in (body.get("files") or [])[:export_view.MAX_FRAMES + 1]:
                if not isinstance(item, dict):
                    continue
                raw = str(item.get("path") or "")
                if not raw and item.get("filename"):
                    raw = os.path.join(str(item.get("subfolder") or ""), str(item["filename"]))
                try:
                    full = media_resolve.resolve_path(raw, str(item.get("type") or ""),
                                                      allow=path_access.is_allowed)
                except PermissionError as e:
                    return web.Response(status=403, text=path_access.refusal(e.args[0]))
                if not full or not os.path.isfile(full):
                    return web.Response(status=404, text=f"{os.path.basename(raw) or 'a file'} is not on disk any more")
                paths.append(full)

            fmt = str(body.get("format") or ("mp4" if scope == "clip" else "png")).lower()
            name = body.get("name") or (os.path.splitext(os.path.basename(paths[0]))[0] if paths else "export")
            try:
                if scope == "frame":
                    where = export_rules.target("frame", name, "png", out_dir, body.get("context"))
                    if body.get("dataurl"):
                        raw_png, _ext = _decode_image_upload(body.get("dataurl"), force_png=True)

                        def work():
                            os.makedirs(where["folder"], exist_ok=True)
                            with open(where["path"], "wb") as fh:
                                fh.write(raw_png)
                            return {"path": where["path"], "frames": 1}
                    elif not paths:
                        return web.Response(status=400, text="there is nothing on screen that has a file")
                    else:
                        src = paths[0] if export_view.is_video(paths[0]) or len(paths) == 1 \
                            else paths[min(index, len(paths) - 1)]

                        def work():
                            return export_view.write_png(export_view.frame_of(src, index, cs), where["path"])
                else:
                    if fmt not in timeline_render.FORMATS:
                        return web.Response(status=400, text=f"unknown format: {fmt}")
                    if not paths:
                        return web.Response(status=400, text="a clip only the browser holds cannot be exported whole "
                                                             "- export its frame, or open it from a folder")
                    where = export_rules.target("video", name, fmt, out_dir, body.get("context"))
                    codec, quality = body.get("codec"), str(body.get("quality") or "high")
                    if export_view.is_video(paths[0]):
                        def work():
                            return export_view.write_video_clip(paths[0], where["path"], fmt, codec, quality,
                                                                path_access.is_allowed)
                    else:
                        fps = body.get("fps")

                        def work():
                            return export_view.write_sequence(paths, where["path"], fps, fmt, codec, quality, cs)
                got = await asyncio.get_running_loop().run_in_executor(None, work)
            except ValueError as exc:                       # ExportError and RenderError are
                return web.Response(status=422, text=f"not exported: {exc}")
            except OSError as exc:
                return web.Response(status=500, text=f"not exported: {exc}")
            got = dict(got, name=os.path.basename(got["path"]), relative=where["relative"],
                       version=where["version"], kind="video" if scope == "clip" else "image")
            return web.json_response(got, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_raw_view(request):
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' or 'filename' parameter")

            def _check(path):
                cand, allowed = _resolve_raw_path(path)
                # Both refusals are answered silently. The viewer's history outlives
                # the files it names — a cleaned temp dir, an output root belonging to
                # another machine — and printing here put one line in the ComfyUI log
                # per dead entry per redraw of the history strip. The client asks
                # /imageviewer/probe_paths instead and drops those entries from the panel.
                if not allowed or not path_access.is_media(cand):
                    return cand, 403
                if not os.path.exists(cand):
                    return cand, 404
                return cand, 200

            # Every history switch comes through here, so the checks (a realpath
            # and a stat, on the network share for most outputs) run off the loop.
            cand, status = await _off_loop(_check, path)
            if status == 403:
                return web.Response(status=403, text="access denied")
            if status == 404:
                return web.Response(status=404, text="file not found")

            return await _serve(cand, cs=params.get("cs"), ev=params.get("ev"))

        async def _imageviewer_probe_paths(request):
            """Report which of the given paths this server can no longer serve.

            Body: {"paths": [{"path": ..., "external": bool}, ...]}; a bare string
            is treated as a non-external path. Answers with one entry per
            unreachable path and why, so the history panel can prune the snapshots
            pointing at them without guessing from a failed image load.
            """
            try:
                data = await request.json()
            except Exception:
                data = {}
            entries = data.get("paths") if isinstance(data, dict) else None
            if not isinstance(entries, list):
                entries = []

            def _verdict(item):
                if isinstance(item, dict):
                    p = item.get("path")
                    external = bool(item.get("external"))
                else:
                    p = item
                    external = False
                if not p or not isinstance(p, str):
                    return None
                # External frames come from the file browser, a loader node or
                # drag-drop and are served by /imageviewer/view_file. One outside the
                # allowed folders is left out of the answer entirely: reporting it
                # would get it pruned from history before the user has had a
                # chance to allow its folder, and answering "gone" or not for it
                # would tell any caller which files exist.
                if external:
                    if not path_access.is_allowed(p):
                        return None
                    if not os.path.isfile(os.path.abspath(p)):
                        return {"path": p, "reason": "gone"}
                    return None
                cand, allowed = _resolve_raw_path(p)
                if not allowed:
                    return {"path": p, "reason": "denied"}
                if not os.path.isfile(cand):
                    return {"path": p, "reason": "gone"}
                return None

            # The whole history in one request: a realpath and a stat per path,
            # ~25 ms each on the W: share, 4-4.7 s for 166 paths. That ran on the
            # event loop, so every request behind it - the picture a history
            # switch asked for included - waited the whole time. Now it runs on
            # worker threads, several paths at once (they are latency, not work).
            def _probe_all(items):
                return [v for v in _probe_pool().map(_verdict, items) if v]

            unreachable = await _off_loop(_probe_all, entries)
            return web.json_response({"unreachable": unreachable})

        def _browse_matcher(pattern):
            """A name test from what the user typed in the filter box.

            Globs if it looks like one — `*.exr`, `frame_??.png`, `{png,jpg}`
            are all fnmatch — and a plain substring otherwise, because typing
            "hero" and being told a folder is empty is not what anyone means by
            a filter. Several patterns can be separated by spaces, commas or
            semicolons, and a match on any of them is a match.
            """
            import fnmatch

            parts = [p for p in re.split(r"[\s,;]+", (pattern or "").strip()) if p]
            if not parts:
                return None
            tests = []
            for part in parts:
                low = part.lower()
                if any(ch in low for ch in "*?["):
                    tests.append(lambda name, pat=low: fnmatch.fnmatch(name, pat))
                else:
                    tests.append(lambda name, needle=low: needle in name)
            return lambda name: any(test(name.lower()) for test in tests)

        async def _imageviewer_browse(request):
            """List one directory for the viewer's file browser panel.

            No path → ComfyUI's input directory, which is where the browser opens.

            Confined to the allowed folders (path_access). Everything inside
            them is listed — a folder with a .json beside its .png is a folder
            with a .json in it, and a browser that hides half of what is there
            is a browser you cannot trust. Each file says what kind it is, and
            "other" is the viewer's way of saying it has nothing to show for
            it: no preview, nothing to open, nothing to drag onto the graph.
            """
            raw = (request.query.get("path") or "").strip()
            if not raw:
                raw = _browse_default_dir()
            path = os.path.abspath(os.path.expanduser(raw))

            # Before any look at the disk, so a refusal says nothing about
            # whether the folder exists.
            if not path_access.is_allowed(path):
                return web.json_response({
                    "path": path, "parent": None, "roots": _browse_roots(),
                    "dirs": [], "files": [], "truncated": False,
                    "error": path_access.refusal(path),
                }, status=403)

            if not os.path.isdir(path):
                return web.json_response({
                    "path": path, "parent": None, "roots": _browse_roots(),
                    "dirs": [], "files": [], "truncated": False,
                    "error": "not a directory",
                }, status=404)

            image_exts, video_exts = _browse_exts()
            # Filtering happens HERE, not in the page: the listing is capped, so
            # a filter applied afterwards would search the first few hundred
            # names of a big folder rather than the folder.
            matches = _browse_matcher(request.query.get("filter"))
            kinds = {k for k in (request.query.get("kinds") or "").split(",") if k}
            dirs, files, truncated = [], [], False
            try:
                names = os.listdir(path)
            except Exception as e:
                return web.json_response({
                    "path": path, "parent": _browse_parent(path), "roots": _browse_roots(),
                    "dirs": [], "files": [], "truncated": False, "error": str(e),
                }, status=403)

            for name in sorted(names, key=_browse_sort_key):
                full = os.path.join(path, name)
                try:
                    is_dir = os.path.isdir(full)
                except OSError:
                    continue                      # a dead junction / permission wall
                if is_dir:
                    dirs.append({"name": name, "path": full})
                    continue
                ext = os.path.splitext(name)[1].lower()
                if ext in image_exts:
                    kind = "image"
                elif ext in video_exts:
                    kind = "video"
                elif ext in _AUDIO_EXTS:
                    kind = "audio"
                elif ext in _MODEL_EXTS:
                    kind = "model"
                elif ext == ".otio":
                    kind = "cut"           # opens in an Edit tab
                elif ext in (".ora", ".psd"):
                    kind = "paint"         # a picture in layers: opens in a Paint tab
                elif viewer_code is not None and ext in viewer_code.TEXT_EXTS:
                    kind = "text"          # shown in the Agent code panel
                else:
                    kind = "other"
                if kinds and kind not in kinds:
                    continue
                if matches and not matches(name):
                    continue
                if len(files) >= _BROWSE_FILE_CAP:
                    truncated = True
                    continue
                try:
                    st = os.stat(full)
                    size, mtime = st.st_size, st.st_mtime
                except OSError:
                    size, mtime = 0, 0
                files.append({"name": name, "path": full, "kind": kind,
                              "ext": ext, "size": size, "mtime": mtime})

            return web.json_response({
                "path": path,
                "parent": _browse_parent(path),
                "roots": _browse_roots(),
                "dirs": dirs,
                "files": files,
                "truncated": truncated,
                # So the page can say "nothing matches" rather than "empty".
                "filtered": bool(matches or kinds),
            })

        async def _imageviewer_browse_frames(request):
            """Turn browsed paths into viewer frames.

            Body: {"paths": [abs path, ...]}. Answers with one frame dict per
            readable file — the same shape the resolver hands the viewer for a
            loader node, so a video arrives with its fps, frame count and a
            cached poster instead of the viewer having to guess at them.

            Kept apart from the listing above because this is the expensive half:
            every video costs a probe and a poster decode, and a folder of them
            would stall the panel that is only trying to draw a list of names.
            """
            if media_resolve is None:
                return web.json_response(
                    {"error": "media resolver unavailable on this install"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = {}
            paths = data.get("paths") if isinstance(data, dict) else None
            if not isinstance(paths, list):
                paths = []

            image_exts, video_exts = _browse_exts()
            frames, missing = [], []
            for raw in paths[:_BROWSE_FRAME_CAP]:
                if not raw or not isinstance(raw, str):
                    continue
                p = os.path.abspath(raw)
                if not path_access.is_allowed(p) or not os.path.isfile(p):
                    missing.append(raw)
                    continue
                ext = os.path.splitext(p)[1].lower()
                try:
                    if ext in _MODEL_EXTS:
                        frames.append(media_resolve._model_frame(p))
                    elif ext in _AUDIO_EXTS:
                        frames.append(media_resolve._audio_frame(p))
                    elif ext in video_exts:
                        frames.append(media_resolve._video_frame(p))
                    elif ext in image_exts:
                        frames.append(media_resolve._image_frame(p))
                except Exception as e:
                    print(f"[ImageViewer] browse_frames failed for {p}: {e}")
                    missing.append(raw)

            return web.json_response({"frames": frames, "missing": missing})

        async def _imageviewer_push(request):
            """Show files in a viewer tab that did not come through a save node.

            Body: {"paths": [abs path, ...], "group": "...", "label": "..."}. An
            MCP tool's render, a script's output, a shot's picture: whoever
            produced the file says which group of the Viewer tab it belongs in
            ("agentY" when nobody says; ``tab_name``, the old name of ``group``,
            is taken when ``group`` is empty). The frames are the ones
            /imageviewer/browse_frames builds, sent as the same ``imageviewer.viewer.update``
            message ImageViewerSend sends, so the page files them exactly as it
            does a send from a workflow that is not on the open graph. Only files inside the folders the
            viewer may open (path_access) are shown; the rest come back in
            ``refused``.

            A path may also be a folder, an image sequence (``f_%04d.png``,
            ``f_####.png``, ``f_*.png``) or an ``.otio`` (the film beside it, see
            push_open; one with no film beside it is opened as a cut in the Edit panel,
            answered as ``cuts``). Optional: ``focus`` (bring the viewer up and select the
            first item), ``play`` (start it), ``panel: "edit"`` (open the Edit
            panel on the cut beside the first film that has one), ``panel: "paint"``
            (the pictures open in Paint tabs). They ride on the same message as
            ``open``; the page does the rest. An ``.ora`` / ``.psd`` always opens in
            Paint (``imageviewer.paint.open``), answered as ``paint``.
            """
            if media_resolve is None:
                return web.json_response({"error": "media resolver unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = {}
            if not isinstance(data, dict) or not isinstance(data.get("paths"), list):
                return web.json_response({"error": "bad request"}, status=400)
            clean = lambda v: " ".join(str(v or "").split())[:60]
            group = clean(data.get("group")) or clean(data.get("tab_name")) or "agentY"
            label = clean(data.get("label"))
            tab = group

            from . import timeline_io
            # Motion-graphics scenes (*.mgscene.json) open the Motion editor, a LoRA dataset's manifest the
            # Dataset panel; neither is media (push_open.split_pushed).
            motion, lora, rest = push_open.split_pushed(
                data["paths"], is_allowed=path_access.is_allowed,
                is_scene=lambda r: mg_scene_io is not None and mg_scene_io.is_scene_path(r),
                dataset_of=(lambda r: lora_io is not None and lora_io.dataset_name_of_path(r, folder_paths.get_output_directory())))
            image_exts, video_exts = _browse_exts()
            # An .otio with no film beside it is a cut to open, not media to show: its tab and the Edit panel.
            cuts_open, rest = push_open.split_lone_cuts(
                rest, is_allowed=path_access.is_allowed, may_serve=path_access.may_serve, video_exts=video_exts)
            # An .ora / .psd is a picture in layers: it opens in a Paint tab, not as media.
            paint_open, rest = push_open.split_paint(rest, is_allowed=path_access.is_allowed)
            if str(data.get("panel") or "").strip().lower() == "paint":
                # panel "paint": the pictures open in Paint too, each in a tab of its own.
                keep = []
                for raw in rest:
                    p = os.path.abspath(str(raw))
                    if (os.path.splitext(p)[1].lower() in image_exts and os.path.isfile(p)
                            and path_access.may_serve(p)):
                        paint_open.append(p)
                    else:
                        keep.append(raw)
                rest = keep
            data["paths"] = rest
            files, refused, cuts = push_open.expand(
                data["paths"], set(image_exts) | _AUDIO_EXTS, video_exts,
                may_serve=path_access.may_serve, is_allowed=path_access.is_allowed,
                cap=_BROWSE_FRAME_CAP)
            frames, edit_at = [], None
            for p in files:
                ext = os.path.splitext(p)[1].lower()
                try:
                    if ext in _MODEL_EXTS:
                        frame = media_resolve._model_frame(p)
                    elif ext in _AUDIO_EXTS:
                        frame = media_resolve._audio_frame(p)
                    elif ext in video_exts:
                        frame = media_resolve._video_frame(p)
                    elif ext in image_exts:
                        frame = media_resolve._image_frame(p)
                    else:
                        refused.append(p)
                        continue
                except Exception as e:
                    print(f"[ImageViewer] push failed for {p}: {e}")
                    refused.append(p)
                    continue
                if group:
                    frame["group"] = group
                if label:
                    frame["label"] = label
                # The film that has a cut beside it is what the Edit panel opens on.
                if (edit_at is None and ext in video_exts
                        and (p in cuts or timeline_io.sidecar_for(p))):
                    edit_at = len(frames)
                frames.append(frame)

            # Optional: bring the viewer up, select/play the first item, open the
            # Edit panel on a cut. A plain push (no focus, no panel) stays quiet.
            want_panel = str(data.get("panel") or "").strip().lower()
            opened = None
            notes = []
            if want_panel == "edit" and edit_at is None and frames:
                notes.append("no .otio beside the film, so the Edit panel was not opened")
            if frames and (data.get("focus") or want_panel == "edit"):
                opened = {"focus": True, "select": 0, "play": bool(data.get("play"))}
                if want_panel == "edit" and edit_at is not None:
                    opened.update(panel="edit", select=edit_at, play=False)

            if frames:
                msg = {
                    "tabs": {"tab": frames},
                    "unique_id": None,
                    "tab_name": tab,
                }
                if opened:
                    msg["open"] = opened
                PromptServer.instance.send_sync("imageviewer.viewer.update", msg)
            for p in motion:
                PromptServer.instance.send_sync("imageviewer.mg.open", {"path": p})
            for p in lora:
                PromptServer.instance.send_sync("imageviewer.lora.open", {"path": p})
            for p in cuts_open:
                PromptServer.instance.send_sync("imageviewer.edit.open", {"path": p})
            for p in paint_open:
                PromptServer.instance.send_sync("imageviewer.paint.open", {"path": p})
            return web.json_response({"ok": True, "shown": len(frames), "motion": motion, "lora": lora, "cuts": cuts_open,
                                      "paint": paint_open,
                                      "refused": refused,
                                      "opened": bool(opened), "edit": bool(opened and opened.get("panel")),
                                      "notes": notes})

        # --- Previz shots for an agent (previz_shot.py) ----------------------
        _shots = previz_shot.ShotBook() if previz_shot is not None else None

        async def _imageviewer_previz_shot(request):
            """Open a previz scene in the viewer and (optionally) render a camera through it.

            Body: {"scene": {...previz scene...}, "name": "shot", "render": {camera,
            start, end, fps, width, height, format, quality, shading, background, aa},
            "add_node": true, "focus": true}. The scene is saved under output/3d_scenes,
            sent to the page as the tab ``previz:<name>`` and, when ``render`` is given,
            the page renders it exactly as Export > Render does and reports back. Answers
            at once with an ``id``; poll GET /imageviewer/previz_shot?id=<id> for the state
            (``queued`` | ``rendering`` | ``done`` | ``error``) and, when done, ``path``.
            """
            if _shots is None or previz is None:
                return web.json_response({"error": "previz unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            try:
                job = _shots.new_job(data)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            try:
                saved = previz.save_scene(job["name"], job["scene"])
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            PromptServer.instance.send_sync("imageviewer.viewer.update", {
                "tabs": {job["key"]: []},
                "unique_id": None,
                "scene_data": previz_shot.json_dumps(job["scene"]),
                "scene_replace": True,
                "tab_label": f"Previz: {job['name']}",
                "focus_tab": bool(job["focus"]),
            })
            if job["render"] is not None:
                PromptServer.instance.send_sync("imageviewer.previz.render", {
                    "id": job["id"], "key": job["key"], "name": job["name"],
                    "render": job["render"], "add_node": job["add_node"],
                })
            return web.json_response({"ok": True, "id": job["id"], "key": job["key"],
                                      "scene_file": saved, "state": job["state"]})

        async def _imageviewer_previz_shot_done(request):
            """The page's report on a shot it was asked to render (progress or result)."""
            if _shots is None:
                return web.json_response({"error": "previz unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict) or not _shots.report(data):
                return web.json_response({"error": "unknown shot"}, status=404)
            return web.json_response({"ok": True})

        async def _imageviewer_previz_shot_state(request):
            if _shots is None:
                return web.json_response({"error": "previz unavailable"}, status=500)
            job = _shots.get(request.query.get("id") or "")
            if job is None:
                return web.json_response({"error": "unknown shot"}, status=404)
            return web.json_response(_shots.public(job))

        # --- Render with World Labs Atlas (atlas_render.py) -------------------
        # The viewer has neither agenty_core nor the World Labs key: these two routes relay to the
        # agentY host, which renders (the same core function the agent's atlas_render_view runs).
        async def _imageviewer_atlas_render(request):
            """Body: {"world_path": ".../world.glb", "camera": {"camera_world": [16], "model_world": [16],
            "fov", "aspect", "gated"}, "upscale": 0|2|4, "add_to_world": false}. Answers at once with an ``id``;
            poll GET /imageviewer/atlas_render?id=<id> (``state``: running | done | error, ``path`` when done)."""
            if atlas_render is None:
                return web.json_response({"error": "atlas render unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            base = f"{request.scheme}://{request.host}"
            try:
                out = await asyncio.to_thread(atlas_render.start_render, base, data)
            except atlas_render.RelayError as e:
                return web.json_response({"error": str(e)}, status=e.status)
            return web.json_response(out)

        async def _imageviewer_atlas_render_state(request):
            if atlas_render is None:
                return web.json_response({"error": "atlas render unavailable"}, status=500)
            base = f"{request.scheme}://{request.host}"
            try:
                out = await asyncio.to_thread(atlas_render.render_state, base, request.query.get("id") or "")
            except atlas_render.RelayError as e:
                return web.json_response({"error": str(e)}, status=e.status)
            return web.json_response(out)

        # --- Render camera with Atlas: the previz camera's animation as an Atlas-painted move (atlas_render.py) ---
        async def _imageviewer_atlas_move(request):
            """Body: {"world_path", "keys": [{"t", "camera_world": [16], "fov", "aspect"}], "model_world": [16],
            "quality", "fps", "name", "dry_run", "confirm_cost"}. A dry run answers with the plan and the price;
            otherwise an ``id`` to poll GET /imageviewer/atlas_camera_move?id=<id> (tasks_done / tasks_total)."""
            if atlas_render is None:
                return web.json_response({"error": "atlas render unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            base = f"{request.scheme}://{request.host}"
            try:
                out = await asyncio.to_thread(atlas_render.start_move, base, data)
            except atlas_render.RelayError as e:
                return web.json_response({"error": str(e)}, status=e.status)
            return web.json_response(out)

        async def _imageviewer_atlas_move_state(request):
            if atlas_render is None:
                return web.json_response({"error": "atlas render unavailable"}, status=500)
            base = f"{request.scheme}://{request.host}"
            try:
                out = await asyncio.to_thread(atlas_render.move_state, base, request.query.get("id") or "")
            except atlas_render.RelayError as e:
                return web.json_response({"error": str(e)}, status=e.status)
            return web.json_response(out)

        # --- Motion panel: scene files and the Render relay (mg_scene_io.py, mg_render.py) ---
        async def _imageviewer_mgscene(request):
            """GET ?path=<file>.mgscene.json -> {"path", "scene"}.

            Also answers for what belongs to a scene: a poster .png that carries it, and the rendered
            film beside it (``clip.mp4`` + ``clip.mgscene.json`` / ``clip.png``). The file may be named
            by ``path`` or, as the history strip knows a render, by ``filename`` + ``subfolder`` +
            ``type``. ``probe=1`` answers only {"has_scene"}."""
            if mg_scene_io is None:
                return web.json_response({"error": "motion panel unavailable"}, status=500)
            path = request.query.get("path") or ""
            if not path and request.query.get("filename"):
                path = _resolve_comfy_ref(request.query.get("filename"), request.query.get("type"),
                                          request.query.get("subfolder")) or ""
            if mg_scene_io.is_png_path(path) or mg_scene_io.is_video_path(path):
                # a poster PNG that carries its scene, or the film beside its scene (agentY writes
                # both next to every rendered video); never writes: a Save goes to the path returned
                path = os.path.abspath(path)
                if not path_access.may_serve(path):
                    return web.json_response({"error": path_access.serve_refusal(path)}, status=403)
                if not os.path.isfile(path):
                    return web.json_response({"error": "file not found"}, status=404)
                resolve = mg_scene_io.resolve_png if mg_scene_io.is_png_path(path) else mg_scene_io.scene_beside
                found = await asyncio.get_running_loop().run_in_executor(None, resolve, path, path_access.is_allowed)
                if request.query.get("probe"):
                    return web.json_response({"has_scene": found is not None})
                if found is None:
                    return web.json_response({"error": "no motion-graphics scene belongs to this file"}, status=422)
                return web.json_response(found, headers={"Cache-Control": "no-cache"})
            if not mg_scene_io.is_scene_path(path):
                if request.query.get("probe"):
                    return web.json_response({"has_scene": False})
                return web.json_response({"error": "not a scene file (*.mgscene.json)"}, status=400)
            path = os.path.abspath(path)
            # a scene file is not media, so may_serve would refuse it; the
            # .mgscene.json check above plus the allowed folders are the rule
            if not path_access.is_allowed(path):
                return web.json_response({"error": path_access.refusal(path)}, status=403)
            if not os.path.isfile(path):
                return web.json_response({"error": "file not found"}, status=404)
            try:
                scene = await asyncio.get_running_loop().run_in_executor(None, mg_scene_io.read, path)
            except (ValueError, OSError) as e:
                return web.json_response({"error": str(e)}, status=422)
            return web.json_response({"path": path, "scene": scene}, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_mgscene_save(request):
            """POST {"path", "scene"}: write the scene file the editor changed (allowed folders only)."""
            if mg_scene_io is None:
                return web.json_response({"error": "motion panel unavailable"}, status=500)
            try:
                body = await request.json()
            except Exception:
                body = None
            if not isinstance(body, dict):
                return web.json_response({"error": "bad request"}, status=400)
            path = body.get("path") or ""
            if not mg_scene_io.is_scene_path(path):
                return web.json_response({"error": "not a scene file (*.mgscene.json)"}, status=400)
            path = os.path.abspath(path)
            if not path_access.is_allowed(path):
                return web.json_response({"error": path_access.refusal(path)}, status=403)
            try:
                await asyncio.get_running_loop().run_in_executor(None, mg_scene_io.write, path, body.get("scene"))
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=422)
            except OSError as e:
                return web.json_response({"error": f"not saved: {e}"}, status=500)
            return web.json_response({"ok": True, "path": path})

        async def _imageviewer_mg_render(request):
            """POST {"path", "format"?, "scale"?} starts a render on the agentY host; GET ?id= polls it."""
            if mg_render is None:
                return web.json_response({"error": "motion render unavailable"}, status=500)
            base = f"{request.scheme}://{request.host}"
            try:
                if request.method == "POST":
                    try:
                        data = await request.json()
                    except Exception:
                        data = None
                    out = await asyncio.to_thread(mg_render.start_render, base, data)
                else:
                    out = await asyncio.to_thread(mg_render.render_state, base, request.query.get("id") or "")
            except mg_render.RelayError as e:
                return web.json_response({"error": str(e)}, status=e.status)
            return web.json_response(out)


        # --- Dataset panel: LoRA datasets and training runs (lora_io.py) -----
        def _lora_reply(fn, *args):
            async def run():
                try:
                    return web.json_response(await asyncio.get_running_loop().run_in_executor(None, fn, *args),
                                             headers={"Cache-Control": "no-cache"})
                except lora_io.LoraError as e:
                    return web.json_response({"error": str(e)}, status=e.status)
                except OSError as e:
                    return web.json_response({"error": f"not done: {e}"}, status=500)
            return run()

        async def _lora_body(request):
            try:
                body = await request.json()
            except Exception:
                body = None
            return body if isinstance(body, dict) else {}

        async def _imageviewer_lora_datasets(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            out = folder_paths.get_output_directory()
            return await _lora_reply(lambda: {"datasets": lora_io.list_datasets(out)})

        async def _imageviewer_lora_dataset(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            return await _lora_reply(lora_io.get_dataset, folder_paths.get_output_directory(), request.query.get("name"))

        async def _imageviewer_lora_file(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            try:
                p = lora_io.resolve_file(folder_paths.get_output_directory(), request.query.get("path"))
            except lora_io.LoraError as e:
                return web.json_response({"error": str(e)}, status=e.status)
            return web.FileResponse(p, headers={"Cache-Control": "no-cache"})

        async def _imageviewer_lora_dataset_save(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            b = await _lora_body(request)
            return await _lora_reply(lora_io.save_dataset, folder_paths.get_output_directory(),
                                     b.get("name"), b.get("manifest"))

        async def _imageviewer_lora_review(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            b = await _lora_body(request)
            return await _lora_reply(lora_io.review_dataset, folder_paths.get_output_directory(),
                                     b.get("name"), b.get("action"), b.get("note"), b.get("manifest"))

        async def _imageviewer_lora_runs(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            out = folder_paths.get_output_directory()
            return await _lora_reply(lambda: {"runs": lora_io.list_runs(out)})

        async def _imageviewer_lora_run(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            return await _lora_reply(lora_io.get_run, folder_paths.get_output_directory(), request.query.get("name"))

        async def _imageviewer_lora_control(request):
            if lora_io is None:
                return web.json_response({"error": "dataset panel unavailable"}, status=500)
            b = await _lora_body(request)
            return await _lora_reply(lora_io.control_run, folder_paths.get_output_directory(),
                                     b.get("name"), b.get("action"), b.get("keep"))

        # --- Agent code panel (viewer_code.py) -------------------------------
        _code_store = viewer_code.CodeStore() if viewer_code is not None else None

        async def _imageviewer_code_add(request):
            """A snippet of code the agent made, for the Agent code panel."""
            if _code_store is None:
                return web.json_response({"error": "code panel unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = {}
            snip, is_new = _code_store.add(data if isinstance(data, dict) else {})
            if snip is None:
                return web.json_response({"error": "bad request"}, status=400)
            if is_new:
                try:
                    PromptServer.instance.send_sync("imageviewer.code.update", snip)
                except Exception as e:
                    print(f"[ImageViewer] code push failed: {e}")
            return web.json_response({"ok": True, "id": snip["id"], "new": is_new})

        async def _imageviewer_code_list(request):
            if _code_store is None:
                return web.json_response({"snippets": []})
            try:
                limit = max(1, min(200, int(request.query.get("limit") or 50)))
            except ValueError:
                limit = 50
            return web.json_response({"snippets": _code_store.recent(limit=limit)})

        async def _imageviewer_text(request):
            """A text file (code, json, notes) from an allowed folder."""
            if viewer_code is None:
                return web.json_response({"error": "code panel unavailable"}, status=500)
            path = os.path.abspath(request.query.get("path") or "")
            if not request.query.get("path") or not path_access.may_serve(path):
                return web.json_response({"error": "not allowed"}, status=403)
            if not os.path.isfile(path):
                return web.json_response({"error": "file not found"}, status=404)
            try:
                text, language, cut = viewer_code.read_text_file(path)
            except ValueError:
                return web.json_response({"error": "not a text file"}, status=415)
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"path": path, "name": os.path.basename(path),
                                      "language": language, "code": text, "truncated": cut})

        async def _imageviewer_view_file(request):
            """Serve a file by absolute path, from inside the allowed folders."""
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' parameter")
            path = os.path.abspath(path)

            # Off the event loop, like /imageviewer/raw_view: a file opened from a
            # project folder is as likely to be on a network share.
            def _check(path):
                # fonts are served too: a motion-graphics scene draws its text with them
                if not (path_access.may_serve(path)
                        or (path_access.is_font(path) and path_access.is_allowed(path))):
                    return 403, path_access.serve_refusal(path)
                return (200, "") if os.path.isfile(path) else (404, "")
            status, refusal = await _off_loop(_check, path)
            if status == 403:
                return web.Response(status=403, text=refusal)
            if status == 404:
                return web.Response(status=404, text="file not found")
            # `raw` is the file itself, never a browser-friendly stand-in: a
            # world's HDR sky is read by three's HDR/EXR loaders, and a PNG
            # proxy would throw away exactly the range it is there for.
            if params.get("raw"):
                return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
            # `prim` narrows a USD stage (or an Alembic cache) to one subtree —
            # how a layout arrives as separate items the viewer can place; a
            # cache also takes `frame`, since it holds geometry per frame.
            return await _serve(path, params.get("prim"), _frame_arg(request),
                                params.get("cs"), params.get("ev"))

        async def _imageviewer_thumb(request):
            """Serve a small cached stand-in for an image, for the thumbnail strips.

            Falls back to the original file whenever a thumbnail cannot be made —
            already small enough, a vector, no decoder — so the client never has to
            know which happened and a tile always shows a picture.

            Reach is deliberately the same as /imageviewer/view_file — the allowed
            folders: this hands back a SHRUNK version of bytes that endpoint would
            give in full, so it widens nothing.
            """
            # All of it off the event loop: the checks stat the source (on the
            # network share for most outputs) and a first request makes the
            # thumbnail - a decode and resize of the full render. On the loop, a
            # strip of new tiles held up every other request, the picture a
            # history switch was waiting for included (40 ms alone, 0.6-1.4 s
            # behind twelve tiles being made).
            def _answer(params):
                path = params.get('path')
                if not path:
                    # A node run hands the viewer {filename, subfolder, type} and no
                    # path at all — that is how ComfyUI's own /view addresses a file,
                    # and it is the SHAPE THE HISTORY STRIP ACTUALLY USES. Resolving it
                    # here is what makes this endpoint reachable for generated images
                    # rather than only for files opened by path.
                    path = _resolve_comfy_ref(params.get('filename'),
                                              params.get('type'),
                                              params.get('subfolder'))
                    if path is None:
                        return web.Response(status=400,
                                            text="missing 'path', or an unresolvable filename")
                path = os.path.abspath(path)
                if not path_access.may_serve(path):
                    return web.Response(status=403, text=path_access.serve_refusal(path))
                if not os.path.isfile(path):
                    return web.Response(status=404, text="file not found")

                if os.path.splitext(path)[1].lower() in _MODEL_EXTS:
                    # A model's tile is rendered by the browser (/imageviewer/model_thumb);
                    # until then, a generic cube. Neither may be cached for long:
                    # the real one replaces the placeholder under the same URL.
                    thumb = model_writer.cached_thumb(path) if model_writer else None
                    if thumb:
                        return web.FileResponse(thumb, headers={"Cache-Control": "no-cache"})
                    return web.Response(text=_MODEL_PLACEHOLDER_SVG, content_type="image/svg+xml",
                                        headers={"Cache-Control": "no-store"})

                if media_resolve is not None and os.path.splitext(path)[1].lower() in media_resolve.VIDEO_EXTS:
                    # A film's tile is its poster: the picture beside it, or a decoded frame. Never the film's own
                    # bytes: an <img> cannot show them, and that was the broken tile in the history strip.
                    try:
                        poster = media_resolve._video_thumb(path)
                    except Exception:
                        poster = None
                    if poster and os.path.isfile(poster):
                        return web.FileResponse(poster, headers={"Cache-Control": "no-cache"})
                    return web.Response(text=_VIDEO_PLACEHOLDER_SVG, content_type="image/svg+xml",
                                        headers={"Cache-Control": "no-store"})

                if media_resolve is not None:
                    try:
                        size = params.get('max')
                        thumb = media_resolve.thumb_for(
                            path, size or media_resolve.THUMB_MAX_SIDE, params.get('cs'))
                        if thumb and os.path.isfile(thumb):
                            # Cache hard: a thumbnail is keyed on the source's mtime, so
                            # a changed source lands on a different cache entry rather
                            # than needing this one revalidated.
                            return web.FileResponse(
                                thumb, headers={"Cache-Control": "public, max-age=31536000"})
                    except Exception as e:
                        print(f"[ImageViewer] thumb failed for {path}: {e}")
                return _file_response(path)

            return await _off_loop(_answer, dict(request.query))

        async def _imageviewer_clear_cache(request):
            try:
                temp_base = folder_paths.get_temp_directory()
            except Exception:
                temp_base = None
            deleted = 0
            if not temp_base:
                return web.json_response({"deleted": 0})

            try:
                for fname in os.listdir(temp_base):
                    if not fname.startswith('ImageViewer_'):
                        continue
                    fpath = os.path.join(temp_base, fname)
                    try:
                        if os.path.isfile(fpath):
                            os.remove(fpath)
                            deleted += 1
                    except Exception:
                        continue
            except Exception as e:
                print(f"[ImageViewerClearCache] error scanning temp dir: {e}")
                return web.json_response({"deleted": deleted})

            return web.json_response({"deleted": deleted})

        async def _image_viewer_page(request):
            """Open the regular ComfyUI app in viewer-only mode.

            The viewer extension depends on ComfyUI's full frontend runtime,
            so we redirect to root with a query flag and let JS collapse the
            UI to only the ComfyUI Image Viewer panel.
            """
            raise web.HTTPFound('/?image_viewer_only=1')

        async def _imageviewer_save_annotation(request):
            """Save a PNG produced by the in-viewer Annotation tool to ./output.

            Body: JSON { dataurl: "data:image/png;base64,...", filename_prefix }.
            Returns { filename, subfolder, type:"output", path } so the viewer can
            add the saved file to its history strip (and drag it onto the graph).
            """
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"error": "invalid JSON body"}, status=400)

            prefix = str(data.get("filename_prefix") or "ImageViewer_annotation")
            # Keep only filesystem-safe characters in the prefix.
            prefix = "".join(c for c in prefix if c.isalnum() or c in ("_", "-")) or "ImageViewer_annotation"

            try:
                raw, ext = _decode_image_upload(data.get("dataurl"))
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)

            try:
                out_dir = folder_paths.get_output_directory()
                if data.get("name"):
                    # Named by the page: exported by the rule every export follows
                    # (export_rules) - the shot's folder when the canvas names
                    # one, the viewer's own otherwise, and the next version.
                    from . import export_rules
                    where = export_rules.target("annotation", data.get("name"), ext, out_dir,
                                                data.get("context"))
                    fpath, fname = where["path"], os.path.basename(where["path"])
                    full_output_folder = where["folder"]
                    subfolder = os.path.dirname(where["relative"])
                else:
                    # An older page: ./output/annotations/, counted as ComfyUI counts
                    # (get_save_image_path honours a subfolder in the prefix).
                    full_output_folder, filename, counter, subfolder, _ = \
                        folder_paths.get_save_image_path(
                            os.path.join("annotations", prefix), out_dir)
                    fname = f"{filename}_{counter:05d}_.{ext}"
                    fpath = os.path.join(full_output_folder, fname)
                os.makedirs(full_output_folder, exist_ok=True)
                with open(fpath, "wb") as fh:
                    fh.write(raw)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            except Exception as e:
                traceback.print_exc()
                return web.json_response({"error": str(e)}, status=500)

            return web.json_response({
                "filename": fname,
                "subfolder": subfolder or "",
                "type": "output",
                "path": os.path.abspath(fpath),
            })

        # ── marks on a film (annotation_io.py) ──────────────────────────────────
        def _annot_target(params):
            """(media, sidecar, error_response) for the film a request names; the file's
            own reach applies - a film the viewer may show may have marks beside it."""
            from . import annotation_io
            media, allowed, error = _timeline_media(params)
            if error:
                return None, None, web.Response(status=400, text=error)
            if not allowed:
                return None, None, web.Response(status=403, text=path_access.refusal(media))
            return media, annotation_io.sidecar_for(media), None

        async def _imageviewer_video_annotations(request):
            """The marks stored beside a film: {items: [...]} (empty when none)."""
            from . import annotation_io
            media, side, bad = await _off_loop(_annot_target, dict(request.query))
            if bad is not None:
                return bad
            doc = await asyncio.get_running_loop().run_in_executor(None, annotation_io.read, side)
            doc = dict(doc or {"version": annotation_io.VERSION, "items": []})
            # Where the film is, so the page can tell the agent: its own idea of the
            # file is a ComfyUI reference, which means nothing outside ComfyUI.
            doc["media_path"] = media
            if request.query.get("describe"):
                # In words, the way the page answers the agent live
                # (imageViewer_viewerState.annotationReport) - get_viewer_annotations(path=...).
                try:
                    frame = int(request.query["frame"]) if request.query.get("frame") not in (None, "") else None
                except ValueError:
                    frame = None
                doc["report"] = annotation_io.report(doc, kind=_annot_kind(media), frame=frame, source=media)
            return web.json_response(doc, headers={"Cache-Control": "no-cache"})

        def _annot_kind(media):
            ext = os.path.splitext(str(media or ""))[1].lower()
            return "video" if ext in (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".gif") else "image"

        def _annot_mask(body):
            """Draw the boxes and strokes of a file's marks (or of the marks sent) as a
            mask PNG under ./output/annotation_masks: (status, answer)."""
            from . import annotation_io
            has_media = bool(body.get("path") or body.get("filename"))
            media, side, doc = None, None, None
            if has_media:
                media, side, bad = _annot_target(body)
                if bad is not None:
                    return bad.status, {"error": bad.text}
                doc = annotation_io.read(side) or {}
            items = body.get("items")
            if not isinstance(items, list):
                items = (doc or {}).get("items") or []
            try:
                w = int(body.get("width") or (doc or {}).get("width") or 0)
                h = int(body.get("height") or (doc or {}).get("height") or 0)
            except (TypeError, ValueError):
                w = h = 0
            if (not w or not h) and media and _annot_kind(media) == "image" and os.path.isfile(media):
                try:
                    from PIL import Image
                    with Image.open(media) as im:
                        w, h = im.size
                except Exception:  # noqa: BLE001
                    w = h = 0
            if not w or not h:
                return 422, {"error": "the picture's size is not known - open it in the viewer once, "
                                      "or pass width and height"}
            frame = body.get("frame")
            try:
                frame = int(frame) if frame not in (None, "", -1, "-1") else None
            except (TypeError, ValueError):
                frame = None
            try:
                img, used = annotation_io.mask_image(items, w, h, frame=frame)
            except ValueError as exc:
                return 422, {"error": str(exc)}
            stem = os.path.splitext(os.path.basename(media or "annotation"))[0] or "annotation"
            stem = "".join(c for c in stem if c.isalnum() or c in ("_", "-"))[:80] or "annotation"
            if frame is not None:
                stem += f"_f{frame:05d}"
            out_dir = folder_paths.get_output_directory()
            folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                os.path.join("annotation_masks", stem + "_mask"), out_dir, w, h)
            os.makedirs(folder, exist_ok=True)
            name = f"{filename}_{counter:05d}_.png"
            path = os.path.join(folder, name)
            img.save(path)
            return 200, {"ok": True, "path": os.path.abspath(path), "filename": name,
                         "subfolder": subfolder or "", "type": "output", "width": w, "height": h,
                         "marks": used, "frame": frame, "media_path": media or ""}

        async def _imageviewer_annotation_mask(request):
            """POST {path | filename+subfolder+type, items?, width?, height?, frame?}:
            the drawn regions (boxes, freehand strokes; a closed stroke filled) as a
            white-on-black PNG, for an inpaint mask. Without ``items`` the marks
            stored beside the file are drawn. The file's own reach applies."""
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"error": "the request is not JSON"}, status=400)
            if not isinstance(body, dict):
                return web.json_response({"error": "the request is not an object"}, status=400)
            try:
                status, answer = await _off_loop(_annot_mask, body)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return web.json_response({"error": f"no mask: {exc}"}, status=500)
            return web.json_response(answer, status=status)

        async def _imageviewer_video_annotations_save(request):
            """Replace the marks beside a film. No marks removes the file."""
            from . import annotation_io
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400, text="the request is not JSON")
            if not isinstance(body, dict):
                return web.Response(status=400, text="the request is not an object")
            media, side, bad = _annot_target(body)
            if bad is not None:
                return bad
            try:
                doc = await asyncio.get_running_loop().run_in_executor(
                    None, annotation_io.save, side, body)
            except ValueError as exc:
                return web.Response(status=422, text=f"not saved: {exc}")
            except OSError as exc:
                return web.Response(status=500, text=f"not saved: {exc}")
            return web.json_response({"ok": True, "file": os.path.basename(side),
                                      "path": side, "media_path": media, "count": len(doc["items"]) if doc else 0})

        async def _imageviewer_extract_frame(request):
            """Write one frame of a clip out as a PNG file and say where it landed.

            Backs shift-dragging a frame off the viewer's timeline onto the node
            graph. Two body shapes, matching the two kinds of clip the viewer can
            be playing:
              { path | filename+subfolder+type, frame } — a video the server can
                read, inside the allowed folders. The PNG is written next to it
                when it sits in ComfyUI's input, output or temp folder, and in
                ./output/extracted_frames otherwise: this route writes files, so
                it never writes outside ComfyUI's own folders.
              { dataurl, name } — a clip that exists only in the browser (dropped
                in from Explorer), whose frame the viewer grabbed off the <video>
                itself. There is no original for it to sit beside, so those land
                in ./output/extracted_frames.

            Returns { path, filename } — an absolute path, so the caller can point
            a path-based loader straight at it.
            """
            if media_resolve is None:
                return web.json_response(
                    {"error": "media resolver unavailable on this install"}, status=500)
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"error": "invalid JSON body"}, status=400)

            try:
                frame = max(0, int(data.get("frame") or 0))
            except Exception:
                frame = 0

            dataurl = data.get("dataurl") or ""
            if dataurl:
                try:
                    raw, _ = _decode_image_upload(dataurl, force_png=True)
                except ValueError as e:
                    return web.json_response({"error": str(e)}, status=400)
                stem = os.path.splitext(os.path.basename(str(data.get("name") or "clip")))[0]
                stem = "".join(c for c in stem if c.isalnum() or c in ("_", "-")) or "clip"
                try:
                    folder = media_resolve.extract_dir(data.get("context")) if data.get("rule") \
                        else media_resolve.extract_dir_fallback()
                    os.makedirs(folder, exist_ok=True)
                    # Same naming as a server-side extract, so a folder of frames
                    # reads the same however they got there.
                    fpath = os.path.join(folder,
                                         media_resolve.extract_frame_name(stem, frame))
                    with open(fpath, "wb") as fh:
                        fh.write(raw)
                except Exception as e:
                    traceback.print_exc()
                    return web.json_response({"error": str(e)}, status=500)
                return web.json_response({"path": os.path.abspath(fpath),
                                          "filename": os.path.basename(fpath)})

            raw_path = data.get("path") or data.get("filename") or ""
            try:
                path = media_resolve.resolve_path(raw_path, str(data.get("type") or ""),
                                                  allow=path_access.is_allowed)
            except PermissionError as e:
                return web.json_response({"error": path_access.refusal(e.args[0])}, status=403)
            if not path or not os.path.isfile(path):
                return web.json_response(
                    {"error": f"could not find {raw_path!r} on disk"}, status=404)

            try:
                if data.get("rule"):
                    out = media_resolve.extract_frame(path, frame, beside=False,
                                                      folder=media_resolve.extract_dir(data.get("context")))
                else:
                    out = media_resolve.extract_frame(
                        path, frame, beside=path_access.in_comfy_dirs(path))
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=422)
            except Exception as e:
                traceback.print_exc()
                return web.json_response({"error": str(e)}, status=500)

            return web.json_response({"path": os.path.abspath(out),
                                      "filename": os.path.basename(out)})

        async def _imageviewer_resolve_media(request):
            """Resolve a loader node's media into viewer tabs.

            Two body/query forms, matching how loaders store their media:
              { value, hint, type, skip, cap, every } — `value` is a raw widget
                string (a ./input filename, an absolute OS path, or a directory)
                and `hint` is the widget's name.
              { files: [...], type, label } — an explicit list of files the node
                loads, used by container-style loaders (AYON) whose media lives
                in a JSON blob instead of a path widget.

            Returns { tabs: [{label, kind, frames}] } — frames are viewer frame
            dicts — or { error } with a message to show the user.
            """
            if media_resolve is None:
                return web.json_response(
                    {"error": "media resolver unavailable on this install"}, status=500)

            if request.method == "POST":
                try:
                    data = await request.json()
                except Exception:
                    data = {}
            else:
                data = dict(request.query)

            def _int(key, default=0):
                try:
                    return int(data.get(key, default) or default)
                except Exception:
                    return default

            files = data.get("files")
            if isinstance(files, str):          # GET form: comma-separated
                files = [f for f in files.split(",") if f.strip()]
            value = str(data.get("value") or "").strip()
            if not value and not files:
                return web.json_response({"error": "no media value given"}, status=400)

            missing = []
            try:
                if files:
                    tabs, missing = media_resolve.resolve_files(
                        files,
                        ann_type=str(data.get("type") or "input"),
                        label=str(data.get("label") or ""),
                        allow=path_access.is_allowed,
                    )
                else:
                    tabs = media_resolve.resolve(
                        value,
                        hint=str(data.get("hint") or ""),
                        ann_type=str(data.get("type") or ""),
                        skip=_int("skip"),
                        cap=_int("cap"),
                        every=_int("every", 1),
                        allow=path_access.is_allowed,
                    )
            except PermissionError as e:
                return web.json_response({"error": path_access.refusal(e.args[0])}, status=403)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=404)
            except Exception as e:
                traceback.print_exc()
                return web.json_response({"error": str(e)}, status=500)

            payload = {"tabs": tabs}
            if missing:
                payload["warning"] = (
                    f"{len(missing)} file(s) referenced by the node are missing "
                    f"from ./input, or outside the folders the viewer may open")
            return web.json_response(payload)

        async def _imageviewer_health(_request):
            return web.json_response({"ok": True, "service": "bepic_templates"})

        async def _imageviewer_three(request):
            name = request.match_info.get("name", "")
            try:
                allowed = set(os.listdir(_THREE_DIR))
            except OSError:
                allowed = set()
            if name not in allowed or not name.endswith(".js"):
                return web.Response(status=404, text="not found")
            return web.FileResponse(os.path.join(_THREE_DIR, name), headers={
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "max-age=86400",
            })

        async def _imageviewer_model_thumb(request):
            """Keep the browser's rendering of a model as its history tile."""
            if model_writer is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict) or not isinstance(data.get("path"), str):
                return web.json_response({"error": "bad request"}, status=400)
            path = os.path.abspath(data["path"])
            if os.path.splitext(path)[1].lower() not in _MODEL_EXTS:
                return web.json_response({"error": "not a 3D model"}, status=400)
            if not path_access.is_allowed(path):
                return web.json_response({"error": path_access.refusal(path)}, status=403)
            if not os.path.isfile(path):
                return web.json_response({"error": "file not found"}, status=404)
            dataurl = data.get("dataurl")
            if not isinstance(dataurl, str) or len(dataurl) > 3 * 1024 * 1024:
                return web.json_response({"error": "thumbnail missing or too large"}, status=400)
            try:
                raw, _ext = _decode_image_upload(dataurl, force_png=True)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            dst = model_writer.thumb_cache_path(path)
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, "wb") as fh:
                    fh.write(raw)
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True})

        async def _imageviewer_scene_list(_request):
            """Saved previz scenes (output/3d_scenes)."""
            if previz is None:
                return web.json_response({"scenes": []})
            return web.json_response({"scenes": [
                {"name": s["name"], "mtime": s["mtime"]} for s in previz.list_scenes()]})

        async def _imageviewer_scene_load(request):
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            raw = request.query.get("path", "")
            if raw:
                # A scene picked in the file picker: anywhere the viewer may read.
                path = os.path.abspath(raw)
                if os.path.splitext(path)[1].lower() != ".json":
                    return web.json_response({"error": "a scene is a .json file"}, status=400)
                if not path_access.is_allowed(path):
                    return web.json_response({"error": path_access.refusal(path)}, status=403)
                if not os.path.isfile(path):
                    return web.json_response({"error": "no such scene"}, status=404)
                try:
                    return web.json_response({"name": os.path.basename(path), "path": path,
                                              "scene": previz.load_scene_at(path)})
                except Exception as e:
                    return web.json_response({"error": str(e)}, status=400)
            name = request.query.get("name", "")
            if not name:
                return web.json_response({"error": "missing name"}, status=400)
            try:
                return web.json_response({"name": name, "scene": previz.load_scene(name)})
            except FileNotFoundError:
                return web.json_response({"error": "no such scene"}, status=404)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)

        async def _imageviewer_scene_save(request):
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict) or not isinstance(data.get("scene"), dict):
                return web.json_response({"error": "bad request"}, status=400)
            name = data.get("name") or "scene"
            if data.get("rule"):
                # Saved where every export goes, as the next version (export_rules).
                from . import export_rules
                try:
                    where = export_rules.target("scene", name, "json",
                                                folder_paths.get_output_directory(), data.get("context"))
                    path = previz.save_scene_at(where["path"], data["scene"])
                except ValueError as e:
                    return web.json_response({"error": str(e)}, status=400)
                except OSError as e:
                    return web.json_response({"error": str(e)}, status=500)
                return web.json_response({"ok": True, "name": os.path.basename(path), "path": path,
                                          "relative": where["relative"], "version": where["version"]})
            try:
                path = previz.save_scene(name, data["scene"])
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True, "name": previz._safe_name(name), "path": path})

        async def _imageviewer_previz_frame(request):
            """One rendered frame of a shot, straight from the viewer's canvas.

            Like every other upload here the PNG is decoded and re-encoded, so
            what lands in ./output/previz is an image and nothing else."""
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict):
                return web.json_response({"error": "bad request"}, status=400)
            name = data.get("name") or "shot"
            try:
                index = int(data.get("index", 0))
            except (TypeError, ValueError):
                return web.json_response({"error": "bad frame index"}, status=400)
            if index < 0 or index > 99999:
                return web.json_response({"error": "frame index out of range"}, status=400)
            if data.get("first"):
                previz.clear_render(name)          # a new take replaces the old one
            try:
                raw, _ext = _decode_image_upload(data.get("dataurl"), force_png=True)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            previz.renders_dir(name, create=True)
            path = previz.frame_path(name, index)
            try:
                with open(path, "wb") as fh:
                    fh.write(raw)
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True, "path": path,
                                      "dir": os.path.dirname(path)})

        async def _imageviewer_previz_encode(request):
            """Encode a finished take into output/previz/<name>.<format>."""
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict):
                return web.json_response({"error": "bad request"}, status=400)
            name = data.get("name") or "shot"
            try:
                fps = float(data.get("fps", 24.0)) or 24.0
            except (TypeError, ValueError):
                fps = 24.0
            fmt = str(data.get("format") or "mp4").lower()
            if fmt not in previz.VIDEO_FORMATS:
                return web.json_response({"error": f"unknown format: {fmt}"}, status=400)
            quality = str(data.get("quality") or "high").lower()
            if quality not in previz.VIDEO_QUALITY:
                return web.json_response({"error": f"unknown quality: {quality}"}, status=400)
            # A MOV can be ProRes or H.264; the rule for which, and its default,
            # is the one every export follows (export_rules).
            from . import export_rules
            codec = export_rules.video_settings(fmt, data.get("codec"), quality)["codec"] \
                if data.get("codec") else None
            where = None
            if data.get("rule"):
                try:
                    where = export_rules.target("video", name, fmt, folder_paths.get_output_directory(),
                                                data.get("context"))
                except ValueError as e:
                    return web.json_response({"error": str(e)}, status=400)
            try:
                path = previz.encode_render(name, fps, fmt, quality, codec,
                                            out=where["path"] if where else None)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True, "path": path,
                                      "name": previz._safe_name(name),
                                      "relative": where["relative"] if where else
                                      f"{previz.RENDERS_DIRNAME}/{os.path.basename(path)}"})

        async def _imageviewer_previz_publish(request):
            """Put a finished take kept as stills where every export goes: its
            frames leave the working folder for the next version's."""
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict):
                return web.json_response({"error": "bad request"}, status=400)
            name = data.get("name") or "shot"
            from . import export_rules
            try:
                seq = export_rules.sequence_target("frame", name, "png",
                                                   folder_paths.get_output_directory(), data.get("context"))
                paths = previz.publish_frames(name, seq)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True, "dir": seq["folder"], "path": paths[0],
                                      "paths": paths, "count": len(paths), "relative": seq["relative"],
                                      "version": seq["version"]})

        async def _imageviewer_usd_export(request):
            """Write a previz scene out as a USD stage."""
            if usd_io is None or not usd_io.available():
                return web.json_response({"error": "this install has no USD (pip install usd-core)"},
                                         status=501)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict) or not isinstance(data.get("scene"), dict):
                return web.json_response({"error": "bad request"}, status=400)

            target = data.get("path")
            if target:
                target = os.path.abspath(str(target))
                if not path_access.is_allowed(target):
                    return web.json_response({"error": path_access.refusal(target)}, status=403)
                if not usd_io.is_usd(target):
                    return web.json_response({"error": "that name is not a USD file"}, status=400)
            elif data.get("rule"):
                # Exported where every export goes, as the next version.
                from . import export_rules
                ext = "usdc" if str(data.get("format", "")).lower() == "usdc" else "usda"
                try:
                    where = export_rules.target("stage", data.get("name") or "previz", ext,
                                                folder_paths.get_output_directory(), data.get("context"))
                except ValueError as e:
                    return web.json_response({"error": str(e)}, status=400)
                target = where["path"]
                os.makedirs(os.path.dirname(target), exist_ok=True)
            else:
                name = previz._safe_name(data.get("name") or "previz") if previz else "previz"
                ext = "usdc" if str(data.get("format", "")).lower() == "usdc" else "usda"
                folder = previz.scenes_dir(create=True) if previz else folder_paths.get_output_directory()
                target = os.path.join(folder, f"{name}.{ext}")
            try:
                written = usd_io.export_scene(data["scene"], target)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)
            root = os.path.abspath(folder_paths.get_output_directory())
            inside = os.path.abspath(written).startswith(root + os.sep)
            return web.json_response({"ok": True, "path": written,
                                      "name": os.path.basename(written),
                                      "relative": os.path.relpath(written, root).replace("\\", "/")
                                      if inside else ""})

        async def _imageviewer_usd_import(request):
            """Read a USD stage — or an Alembic cache — into a previz scene."""
            raw_path = request.query.get("path") or ""
            if abc_io is not None and abc_io.is_abc(raw_path):
                target = os.path.abspath(raw_path)
                if not path_access.is_allowed(target):
                    return web.json_response({"error": path_access.refusal(target)}, status=403)
                if not os.path.isfile(target):
                    return web.json_response({"error": "no such file"}, status=404)
                try:
                    scene = abc_io.import_scene(target)
                except Exception as e:
                    return web.json_response({"error": str(e)}, status=400)
                return web.json_response({"ok": True, "scene": scene,
                                          "name": os.path.basename(target)})
            if usd_io is None or not usd_io.available():
                return web.json_response({"error": "this install has no USD (pip install usd-core)"},
                                         status=501)
            raw = request.query.get("path") or ""
            if not raw:
                return web.json_response({"error": "missing path"}, status=400)
            path = os.path.abspath(raw)
            if not path_access.is_allowed(path):
                return web.json_response({"error": path_access.refusal(path)}, status=403)
            if not os.path.isfile(path):
                return web.json_response({"error": "no such stage"}, status=404)
            try:
                scene = usd_io.import_scene(path)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)
            return web.json_response({"ok": True, "path": path, "scene": scene})

        async def _imageviewer_usd_stages(_request):
            """USD stages sitting in output/3d_scenes, for the Load menu."""
            if previz is None:
                return web.json_response({"stages": []})
            folder = previz.scenes_dir()
            out = []
            try:
                names = os.listdir(folder)
            except OSError:
                names = []
            for n in sorted(names):
                if os.path.splitext(n)[1].lower() in (usd_io.USD_EXTS if usd_io else set()):
                    out.append({"name": n, "path": os.path.join(folder, n)})
            return web.json_response({"stages": out, "dir": folder,
                                      "available": bool(usd_io and usd_io.available())})

        async def _imageviewer_roots(request):
            """The folders the viewer may open, for Settings → ComfyUI Image Viewer,
            and whether this request may change them."""
            editable, reason = path_access.may_edit(request)
            out = path_access.describe()
            out.update(editable=editable, reason=reason)
            return web.json_response(out)

        async def _imageviewer_roots_save(request):
            """Replace the folders listed in the roots file (path_access.ROOTS_FILE). The one
            request that can widen what every other route will open, so it is
            fenced by path_access.may_edit."""
            editable, reason = path_access.may_edit(request)
            if not editable:
                return web.json_response({"error": reason}, status=403)
            try:
                body = await request.json()
                entries = body.get("entries")
                if not isinstance(entries, list):
                    raise ValueError("'entries' must be a list of folder paths")
                path_access.write_file_entries(entries)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            except OSError as e:
                return web.json_response(
                    {"error": f"could not write {path_access.ROOTS_FILE}: {e}"}, status=500)
            out = path_access.describe()
            out.update(editable=True, reason="")
            return web.json_response(out)

        async def _imageviewer_roots_folders(request):
            """Sub-folders of a path, for the settings page's folder picker.
            Looks outside the allowed folders — that is its job — so it is
            answered only where the list may be edited."""
            editable, reason = path_access.may_edit(request)
            if not editable:
                return web.json_response({"error": reason}, status=403)
            try:
                body = await request.json()
                return web.json_response(path_access.list_folders(str(body.get("path") or "")))
            except FileNotFoundError as e:
                return web.json_response({"error": f"not a folder: {e.args[0]}"}, status=404)
            except (OSError, ValueError) as e:
                return web.json_response({"error": str(e)}, status=400)

        async def _imageviewer_settings(request):
            """The viewer's settings as kept per OS user (viewer_settings.py):
            ComfyUI's own store can be per project, these are not."""
            return web.json_response({"values": viewer_settings.load(),
                                      "file": viewer_settings.path()})

        async def _imageviewer_settings_save(request):
            try:
                body = await request.json()
                values = viewer_settings.update(body.get("values") if isinstance(body, dict) else None)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            except OSError as e:
                return web.json_response(
                    {"error": f"could not write {viewer_settings.path()}: {e}"}, status=500)
            return web.json_response({"values": values, "file": viewer_settings.path()})

        # Routes that change something on the machine — writing a render,
        # deleting cache files — are POST only. A GET can be set off by a link
        # or an <img> on any page the user has open; a JSON POST from another
        # origin can't get past the browser without a CORS preflight.
        _safe_add("GET", "/imageviewer/lib/three/{name}", _imageviewer_three)
        _safe_add("GET", "/api/imageviewer/lib/three/{name}", _imageviewer_three)
        _safe_add("POST", "/imageviewer/model_thumb", _imageviewer_model_thumb)
        _safe_add("GET", "/imageviewer/scenes", _imageviewer_scene_list)
        _safe_add("GET", "/api/imageviewer/scenes", _imageviewer_scene_list)
        _safe_add("GET", "/imageviewer/scene", _imageviewer_scene_load)
        _safe_add("GET", "/api/imageviewer/scene", _imageviewer_scene_load)
        _safe_add("POST", "/imageviewer/scene", _imageviewer_scene_save)
        _safe_add("POST", "/api/imageviewer/scene", _imageviewer_scene_save)
        _safe_add("POST", "/imageviewer/previz_frame", _imageviewer_previz_frame)
        _safe_add("POST", "/api/imageviewer/previz_frame", _imageviewer_previz_frame)
        _safe_add("POST", "/imageviewer/previz_encode", _imageviewer_previz_encode)
        _safe_add("POST", "/api/imageviewer/previz_encode", _imageviewer_previz_encode)
        _safe_add("POST", "/imageviewer/usd_export", _imageviewer_usd_export)
        _safe_add("POST", "/api/imageviewer/usd_export", _imageviewer_usd_export)
        _safe_add("GET", "/imageviewer/usd_import", _imageviewer_usd_import)
        _safe_add("GET", "/api/imageviewer/usd_import", _imageviewer_usd_import)
        _safe_add("GET", "/imageviewer/usd_stages", _imageviewer_usd_stages)
        _safe_add("GET", "/api/imageviewer/usd_stages", _imageviewer_usd_stages)
        _safe_add("POST", "/api/imageviewer/model_thumb", _imageviewer_model_thumb)
        _safe_add("GET", "/imageviewer/timeline", _imageviewer_timeline)
        _safe_add("GET", "/api/imageviewer/timeline", _imageviewer_timeline)
        _safe_add("POST", "/imageviewer/timeline", _imageviewer_timeline_save)
        _safe_add("POST", "/api/imageviewer/timeline", _imageviewer_timeline_save)
        for _route, _handler in (("timeline_export_resolve_plan", _imageviewer_export_resolve_plan),
                                 ("timeline_export_resolve", _imageviewer_export_resolve),
                                 ("timeline_export_resolve_status", _imageviewer_export_resolve_status),
                                 ("timeline_export_resolve_cancel", _imageviewer_export_resolve_cancel)):
            _safe_add("POST", "/imageviewer/" + _route, _handler)
            _safe_add("POST", "/api/imageviewer/" + _route, _handler)
        _safe_add("POST", "/imageviewer/timeline_save_as", _imageviewer_timeline_save_as)
        _safe_add("POST", "/api/imageviewer/timeline_save_as", _imageviewer_timeline_save_as)
        _safe_add("POST", "/imageviewer/take", _imageviewer_take)
        _safe_add("POST", "/api/imageviewer/take", _imageviewer_take)
        _safe_add("POST", "/imageviewer/cut", _imageviewer_cut)
        _safe_add("POST", "/api/imageviewer/cut", _imageviewer_cut)
        _safe_add("POST", "/imageviewer/timeline_render", _imageviewer_timeline_render)
        _safe_add("POST", "/imageviewer/timeline_solid", _imageviewer_timeline_solid)
        _safe_add("GET", "/imageviewer/fonts", _imageviewer_fonts)
        _safe_add("GET", "/api/imageviewer/fonts", _imageviewer_fonts)
        _safe_add("GET", "/imageviewer/font_file", _imageviewer_font_file)
        _safe_add("GET", "/api/imageviewer/font_file", _imageviewer_font_file)
        _safe_add("GET", "/imageviewer/timeline_peaks", _imageviewer_timeline_peaks)
        _safe_add("GET", "/api/imageviewer/timeline_peaks", _imageviewer_timeline_peaks)
        _safe_add("GET", "/imageviewer/timeline_strip", _imageviewer_timeline_strip)
        _safe_add("GET", "/api/imageviewer/timeline_strip", _imageviewer_timeline_strip)
        _safe_add("GET", "/imageviewer/timeline_beats", _imageviewer_timeline_beats)
        _safe_add("GET", "/api/imageviewer/timeline_beats", _imageviewer_timeline_beats)
        _safe_add("GET", "/imageviewer/timeline_shots", _imageviewer_timeline_shots)
        _safe_add("GET", "/imageviewer/timeline_cuts", _imageviewer_timeline_cuts)
        _safe_add("GET", "/api/imageviewer/timeline_cuts", _imageviewer_timeline_cuts)
        _safe_add("GET", "/api/imageviewer/timeline_shots", _imageviewer_timeline_shots)
        _safe_add("POST", "/imageviewer/timeline_probe", _imageviewer_timeline_probe)
        _safe_add("POST", "/api/imageviewer/timeline_probe", _imageviewer_timeline_probe)
        _safe_add("POST", "/imageviewer/timeline_locate", _imageviewer_timeline_locate)
        _safe_add("POST", "/api/imageviewer/timeline_locate", _imageviewer_timeline_locate)
        _safe_add("POST", "/imageviewer/timeline_upload", _imageviewer_timeline_upload)
        _safe_add("POST", "/api/imageviewer/timeline_upload", _imageviewer_timeline_upload)
        _safe_add("POST", "/api/imageviewer/timeline_solid", _imageviewer_timeline_solid)
        _safe_add("POST", "/api/imageviewer/timeline_render", _imageviewer_timeline_render)
        _safe_add("GET", "/imageviewer/export_options", _imageviewer_export_options)
        _safe_add("GET", "/api/imageviewer/export_options", _imageviewer_export_options)
        _safe_add("POST", "/imageviewer/export_target", _imageviewer_export_target)
        _safe_add("POST", "/api/imageviewer/export_target", _imageviewer_export_target)
        _safe_add("POST", "/imageviewer/export_places", _imageviewer_export_places)
        _safe_add("POST", "/imageviewer/export_view", _imageviewer_export_view)
        _safe_add("POST", "/api/imageviewer/export_view", _imageviewer_export_view)
        _safe_add("POST", "/api/imageviewer/export_places", _imageviewer_export_places)
        _safe_add("POST", "/imageviewer/previz_publish", _imageviewer_previz_publish)
        _safe_add("POST", "/api/imageviewer/previz_publish", _imageviewer_previz_publish)
        _safe_add("GET", "/imageviewer/raw_view", _imageviewer_raw_view)
        _safe_add("GET", "/api/imageviewer/raw_view", _imageviewer_raw_view)
        _safe_add("GET", "/imageviewer/video_annotations", _imageviewer_video_annotations)
        _safe_add("GET", "/api/imageviewer/video_annotations", _imageviewer_video_annotations)
        _safe_add("POST", "/imageviewer/video_annotations", _imageviewer_video_annotations_save)
        _safe_add("POST", "/api/imageviewer/video_annotations", _imageviewer_video_annotations_save)
        _safe_add("POST", "/imageviewer/annotation_mask", _imageviewer_annotation_mask)
        _safe_add("POST", "/api/imageviewer/annotation_mask", _imageviewer_annotation_mask)
        _safe_add("POST", "/imageviewer/probe_paths", _imageviewer_probe_paths)
        _safe_add("POST", "/api/imageviewer/probe_paths", _imageviewer_probe_paths)
        _safe_add("POST", "/imageviewer/clear_cache", _imageviewer_clear_cache)
        _safe_add("POST", "/api/imageviewer/clear_cache", _imageviewer_clear_cache)
        _safe_add("GET", "/imageviewer/browse", _imageviewer_browse)
        _safe_add("GET", "/api/imageviewer/browse", _imageviewer_browse)
        _safe_add("POST", "/imageviewer/browse_frames", _imageviewer_browse_frames)
        _safe_add("POST", "/imageviewer/code", _imageviewer_code_add)
        _safe_add("POST", "/api/imageviewer/code", _imageviewer_code_add)
        _safe_add("GET", "/imageviewer/code", _imageviewer_code_list)
        _safe_add("GET", "/api/imageviewer/code", _imageviewer_code_list)
        _safe_add("GET", "/imageviewer/text", _imageviewer_text)
        _safe_add("GET", "/api/imageviewer/text", _imageviewer_text)
        _safe_add("POST", "/imageviewer/push", _imageviewer_push)
        _safe_add("POST", "/imageviewer/previz_shot", _imageviewer_previz_shot)
        _safe_add("POST", "/api/imageviewer/previz_shot", _imageviewer_previz_shot)
        _safe_add("POST", "/imageviewer/previz_shot_done", _imageviewer_previz_shot_done)
        _safe_add("POST", "/api/imageviewer/previz_shot_done", _imageviewer_previz_shot_done)
        _safe_add("POST", "/imageviewer/atlas_render", _imageviewer_atlas_render)
        _safe_add("POST", "/api/imageviewer/atlas_render", _imageviewer_atlas_render)
        _safe_add("GET", "/imageviewer/atlas_render", _imageviewer_atlas_render_state)
        _safe_add("GET", "/api/imageviewer/atlas_render", _imageviewer_atlas_render_state)
        _safe_add("POST", "/imageviewer/atlas_camera_move", _imageviewer_atlas_move)
        _safe_add("POST", "/api/imageviewer/atlas_camera_move", _imageviewer_atlas_move)
        _safe_add("GET", "/imageviewer/atlas_camera_move", _imageviewer_atlas_move_state)
        _safe_add("GET", "/api/imageviewer/atlas_camera_move", _imageviewer_atlas_move_state)
        _safe_add("GET", "/imageviewer/previz_shot", _imageviewer_previz_shot_state)
        _safe_add("GET", "/api/imageviewer/previz_shot", _imageviewer_previz_shot_state)
        _safe_add("POST", "/api/imageviewer/push", _imageviewer_push)
        _safe_add("POST", "/api/imageviewer/browse_frames", _imageviewer_browse_frames)
        _safe_add("GET", "/imageviewer/view_file", _imageviewer_view_file)
        _safe_add("GET", "/imageviewer/colorspaces", _imageviewer_colorspaces)
        _safe_add("GET", "/api/imageviewer/colorspaces", _imageviewer_colorspaces)
        _safe_add("GET", "/imageviewer/thumb", _imageviewer_thumb)
        _safe_add("GET", "/api/imageviewer/thumb", _imageviewer_thumb)
        _safe_add("GET", "/api/imageviewer/view_file", _imageviewer_view_file)
        _safe_add("POST", "/imageviewer/save_annotation", _imageviewer_save_annotation)
        _safe_add("POST", "/api/imageviewer/save_annotation", _imageviewer_save_annotation)
        _safe_add("POST", "/imageviewer/extract_frame", _imageviewer_extract_frame)
        _safe_add("POST", "/api/imageviewer/extract_frame", _imageviewer_extract_frame)
        _safe_add("POST", "/imageviewer/resolve_media", _imageviewer_resolve_media)
        _safe_add("POST", "/api/imageviewer/resolve_media", _imageviewer_resolve_media)
        _safe_add("GET", "/imageviewer/resolve_media", _imageviewer_resolve_media)
        _safe_add("GET", "/api/imageviewer/resolve_media", _imageviewer_resolve_media)
        _safe_add("GET", "/imageviewer/viewer", _image_viewer_page)
        _safe_add("GET", "/api/imageviewer/viewer", _image_viewer_page)
        _safe_add("GET", "/imageviewer", _image_viewer_page)
        _safe_add("GET", "/api/imageviewer", _image_viewer_page)
        _safe_add("GET", "/imageviewer/settings", _imageviewer_settings)
        _safe_add("GET", "/api/imageviewer/settings", _imageviewer_settings)
        _safe_add("POST", "/imageviewer/settings", _imageviewer_settings_save)
        _safe_add("POST", "/api/imageviewer/settings", _imageviewer_settings_save)
        _safe_add("GET", "/imageviewer/roots", _imageviewer_roots)
        _safe_add("GET", "/api/imageviewer/roots", _imageviewer_roots)
        _safe_add("POST", "/imageviewer/roots", _imageviewer_roots_save)
        _safe_add("POST", "/api/imageviewer/roots", _imageviewer_roots_save)
        _safe_add("POST", "/imageviewer/roots/folders", _imageviewer_roots_folders)
        _safe_add("POST", "/api/imageviewer/roots/folders", _imageviewer_roots_folders)
        # Paint: a picture in layers (paint_routes.py; paint_io / paint_ops / paint_math).
        try:
            from . import paint_routes
            from . import export_rules as _paint_rules
            paint_routes.register(_safe_add, web=web, path_access=path_access, export_rules=_paint_rules,
                                  folder_paths=folder_paths,
                                  send=lambda ev, data: PromptServer.instance.send_sync(ev, data),
                                  resolve=lambda p: _resolve_raw_path(str(p))[0] if p else None)
        except Exception as e:  # noqa: BLE001 - the rest of the viewer works without it
            print(f"[ImageViewer] Paint routes not registered: {e}")
        for _m, _h in (("GET", _imageviewer_mgscene), ("POST", _imageviewer_mgscene_save)):
            _safe_add(_m, "/imageviewer/mgscene", _h)
            _safe_add(_m, "/api/imageviewer/mgscene", _h)
        for _m in ("GET", "POST"):
            _safe_add(_m, "/imageviewer/mg_render", _imageviewer_mg_render)
            _safe_add(_m, "/api/imageviewer/mg_render", _imageviewer_mg_render)
        for _m, _p, _h in (("GET", "datasets", _imageviewer_lora_datasets), ("GET", "dataset", _imageviewer_lora_dataset),
                           ("GET", "file", _imageviewer_lora_file), ("POST", "dataset_save", _imageviewer_lora_dataset_save),
                           ("POST", "review", _imageviewer_lora_review), ("GET", "runs", _imageviewer_lora_runs),
                           ("GET", "run", _imageviewer_lora_run), ("POST", "control", _imageviewer_lora_control)):
            _safe_add(_m, "/imageviewer/lora/" + _p, _h)
            _safe_add(_m, "/api/imageviewer/lora/" + _p, _h)
        _safe_add("GET", "/imageviewer/health", _imageviewer_health)
        _safe_add("GET", "/api/imageviewer/health", _imageviewer_health)

    try:
        register_routes()
    except Exception as e:
        print(f"[ImageViewer] could not register viewer routes: {e}")
        traceback.print_exc()
except ImportError:
    # aiohttp not available; skip route registration
    pass
