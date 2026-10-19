import asyncio
import io
import os
import re
import base64
import sys
import traceback
import folder_paths
from server import PromptServer

from . import path_access
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
    from . import abc_io
except Exception:  # pragma: no cover
    abc_io = None

try:
    from . import usd_io
except Exception:  # pragma: no cover
    usd_io = None

_MODEL_EXTS = {".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply",
               ".usd", ".usda", ".usdc", ".usdz", ".abc", ".spz", ".splat", ".ksplat", ".sog"}

# three.js and its loaders, for the viewer's 3D tabs. Outside js/ so ComfyUI
# doesn't import them at startup; served by /bepic/lib/three/<name> instead.
_THREE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "three")

# Stands in for a model's history tile until the browser has rendered one.
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
        print(f"[bEpicViewer] could not build a preview of {os.path.basename(path)}: {e}")
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
                print(f"[bEpicViewer] colour transform failed for {path}: {e}")
        if not done:
            try:
                proxy = media_resolve.proxy_for_display(path)
            except Exception as e:
                print(f"[bEpicViewer] display proxy failed for {path}: {e}")
        if not proxy:
            # A film a <video> cannot play (ProRes, say) is shown through an
            # H.264 copy; what is exported or cut is always the film itself.
            try:
                proxy = media_resolve.video_proxy(path)
            except Exception as e:
                print(f"[bEpicViewer] playable copy failed for {path}: {e}")
        if proxy:
            path = proxy
    from aiohttp import web
    return web.FileResponse(path, headers={"Cache-Control": "no-cache"})


def _resolve_raw_path(path):
    """Resolve a /bepic/raw_view path and say whether it may be served.

    Returns (abs_path, allowed). Split out of the route so /bepic/probe_paths can
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
    for base in (temp_base, out_base):
        if base and path_access.within(cand, base):
            return cand, True
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

        def _safe_add(method, path, handler):
            try:
                router.add_route(method, path, handler)
            except Exception as e:
                print(f"[bEpicViewer] route register failed {method} {path}: {e}")

        async def _serve(path, prim=None, frame=0, cs=None, ev=None):
            """_file_response off the event loop: decoding and converting a
            frame takes long enough to hold up every other request."""
            return await asyncio.get_running_loop().run_in_executor(
                None, _file_response, path, prim, frame, cs, ev)

        async def _bepic_colorspaces(request):
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

        async def _bepic_timeline(request):
            """The cut that lies beside a film: its ``.otio``.

            Flattened to seconds for drawing, and - under ``edit`` - as the Edit
            panel works on it (clips at full length, each with its dissolve). No
            timeline is the ordinary case (most films were generated, not cut)
            and answers 404 quietly.
            """
            from . import timeline_io
            media, allowed, error = _timeline_media(dict(request.query))
            if error:
                return web.Response(status=400, text=error)
            if not allowed:
                return web.Response(status=403, text=path_access.refusal(media))
            side = timeline_io.sidecar_for(media)
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
            return web.json_response(data, headers={"Cache-Control": "no-cache"})

        async def _bepic_timeline_save(request):
            """Save a cut changed in the Edit panel into the ``.otio`` beside its film.

            Only an existing timeline can be saved into, and only its own clips
            and texts can be in the edit (timeline_io.rebuild): the panel cuts
            what is there. Nothing is rendered - the viewer starts no process -
            so the film stays as it was until its maker renders the edited cut;
            the file is stamped so that it can tell.
            """
            from . import timeline_io
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
            if create is not None:
                # How the panel names this cut from now on.
                data["target"] = {"path": side, "external": 1}
            return web.json_response(data, headers={"Cache-Control": "no-cache"})

        async def _bepic_timeline_solid(request):
            """A plain colour as a picture a cut can hold: the Effects panel's generators.

            A clip is a piece of a file, so a colour has to be one: a PNG under
            ``<output>/bepic/edits/solids``, named after its colour and size, so
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
            folder = os.path.join(base, "bepic", "edits", "solids")
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

        async def _bepic_timeline_render(request):
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
                got = timeline_render.render(doc, out, fmt, path_access.is_allowed, codec, quality)
                # The timeline that goes with the new film: this cut, marked as
                # rendered rather than as changed-and-waiting.
                done = copy.deepcopy(doc)
                meta = done.setdefault("metadata", {})
                if isinstance(meta, dict):
                    meta["bepic"] = {"rendered": datetime.datetime.now(datetime.timezone.utc)
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

        async def _bepic_export_options(request):
            """What an export can be: the formats, the codecs each can hold and
            which is the default, the names quality goes by (export_rules)."""
            from . import export_rules
            return web.json_response(export_rules.options())

        async def _bepic_export_target(request):
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

        async def _bepic_export_places(request):
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

        async def _bepic_export_view(request):
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

        async def _bepic_raw_view(request):
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' or 'filename' parameter")

            cand, allowed = _resolve_raw_path(path)

            # Both refusals are answered silently. The viewer's history outlives
            # the files it names — a cleaned temp dir, an output root belonging to
            # another machine — and printing here put one line in the ComfyUI log
            # per dead entry per redraw of the history strip. The client asks
            # /bepic/probe_paths instead and drops those entries from the panel.
            if not allowed or not path_access.is_media(cand):
                return web.Response(status=403, text="access denied")

            if not os.path.exists(cand):
                return web.Response(status=404, text="file not found")

            return await _serve(cand, cs=params.get("cs"), ev=params.get("ev"))

        async def _bepic_probe_paths(request):
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

            unreachable = []
            for item in entries:
                if isinstance(item, dict):
                    p = item.get("path")
                    external = bool(item.get("external"))
                else:
                    p = item
                    external = False
                if not p or not isinstance(p, str):
                    continue
                # External frames come from the file browser, a loader node or
                # drag-drop and are served by /bepic/view_file. One outside the
                # allowed folders is left out of the answer entirely: reporting it
                # would get it pruned from history before the user has had a
                # chance to allow its folder, and answering "gone" or not for it
                # would tell any caller which files exist.
                if external:
                    if not path_access.is_allowed(p):
                        continue
                    if not os.path.isfile(os.path.abspath(p)):
                        unreachable.append({"path": p, "reason": "gone"})
                    continue
                cand, allowed = _resolve_raw_path(p)
                if not allowed:
                    unreachable.append({"path": p, "reason": "denied"})
                elif not os.path.isfile(cand):
                    unreachable.append({"path": p, "reason": "gone"})

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

        async def _bepic_browse(request):
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
                elif ext in _MODEL_EXTS:
                    kind = "model"
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

        async def _bepic_browse_frames(request):
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
                    elif ext in video_exts:
                        frames.append(media_resolve._video_frame(p))
                    elif ext in image_exts:
                        frames.append(media_resolve._image_frame(p))
                except Exception as e:
                    print(f"[bEpicViewer] browse_frames failed for {p}: {e}")
                    missing.append(raw)

            return web.json_response({"frames": frames, "missing": missing})

        async def _bepic_push(request):
            """Show files in a viewer tab that did not come through a save node.

            Body: {"paths": [abs path, ...], "tab_name": "agentY", "group": "...",
            "label": "..."}. An MCP tool's render, a script's output, a shot's
            picture: whoever produced the file says where it belongs. The frames
            are the ones /bepic/browse_frames builds, sent as the same
            ``bepic.viewer.update`` message bEpicSendToViewer sends, so the page
            files them by ``tab_name`` exactly as it does a send from a workflow
            that is not on the open graph. Only files inside the folders the
            viewer may open (path_access) are shown; the rest come back in
            ``refused``.
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
            tab = clean(data.get("tab_name")) or "agentY"
            group, label = clean(data.get("group")), clean(data.get("label"))

            image_exts, video_exts = _browse_exts()
            frames, refused = [], []
            for raw in data["paths"][:_BROWSE_FRAME_CAP]:
                if not raw or not isinstance(raw, str):
                    continue
                p = os.path.abspath(raw)
                if not path_access.may_serve(p) or not os.path.isfile(p):
                    refused.append(raw)
                    continue
                ext = os.path.splitext(p)[1].lower()
                try:
                    if ext in _MODEL_EXTS:
                        frame = media_resolve._model_frame(p)
                    elif ext in video_exts:
                        frame = media_resolve._video_frame(p)
                    elif ext in image_exts:
                        frame = media_resolve._image_frame(p)
                    else:
                        refused.append(raw)
                        continue
                except Exception as e:
                    print(f"[bEpicViewer] push failed for {p}: {e}")
                    refused.append(raw)
                    continue
                if group:
                    frame["group"] = group
                if label:
                    frame["label"] = label
                frames.append(frame)

            if frames:
                PromptServer.instance.send_sync("bepic.viewer.update", {
                    "tabs": {"tab": frames},
                    "unique_id": None,
                    "tab_name": tab,
                })
            return web.json_response({"ok": True, "shown": len(frames), "refused": refused})

        # --- Agent code panel (viewer_code.py) -------------------------------
        _code_store = viewer_code.CodeStore() if viewer_code is not None else None

        async def _bepic_code_add(request):
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
                    PromptServer.instance.send_sync("bepic.code.update", snip)
                except Exception as e:
                    print(f"[bEpicViewer] code push failed: {e}")
            return web.json_response({"ok": True, "id": snip["id"], "new": is_new})

        async def _bepic_code_list(request):
            if _code_store is None:
                return web.json_response({"snippets": []})
            try:
                limit = max(1, min(200, int(request.query.get("limit") or 50)))
            except ValueError:
                limit = 50
            return web.json_response({"snippets": _code_store.recent(limit=limit)})

        async def _bepic_text(request):
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

        async def _bepic_view_file(request):
            """Serve a file by absolute path, from inside the allowed folders."""
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' parameter")
            path = os.path.abspath(path)
            if not path_access.may_serve(path):
                return web.Response(status=403, text=path_access.serve_refusal(path))
            if not os.path.isfile(path):
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

        async def _bepic_thumb(request):
            """Serve a small cached stand-in for an image, for the thumbnail strips.

            Falls back to the original file whenever a thumbnail cannot be made —
            already small enough, a vector, no decoder — so the client never has to
            know which happened and a tile always shows a picture.

            Reach is deliberately the same as /bepic/view_file — the allowed
            folders: this hands back a SHRUNK version of bytes that endpoint would
            give in full, so it widens nothing.
            """
            params = dict(request.query)
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
                # A model's tile is rendered by the browser (/bepic/model_thumb);
                # until then, a generic cube. Neither may be cached for long:
                # the real one replaces the placeholder under the same URL.
                thumb = model_writer.cached_thumb(path) if model_writer else None
                if thumb:
                    return web.FileResponse(thumb, headers={"Cache-Control": "no-cache"})
                return web.Response(text=_MODEL_PLACEHOLDER_SVG, content_type="image/svg+xml",
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
                    print(f"[bEpicViewer] thumb failed for {path}: {e}")
            return _file_response(path)

        async def _bepic_clear_cache(request):
            try:
                temp_base = folder_paths.get_temp_directory()
            except Exception:
                temp_base = None
            deleted = 0
            if not temp_base:
                return web.json_response({"deleted": 0})

            try:
                for fname in os.listdir(temp_base):
                    if not fname.startswith('bEpic_'):
                        continue
                    fpath = os.path.join(temp_base, fname)
                    try:
                        if os.path.isfile(fpath):
                            os.remove(fpath)
                            deleted += 1
                    except Exception:
                        continue
            except Exception as e:
                print(f"[bEpicClearCache] error scanning temp dir: {e}")
                return web.json_response({"deleted": deleted})

            return web.json_response({"deleted": deleted})

        async def _bepic_viewer_page(request):
            """Open the regular ComfyUI app in viewer-only mode.

            The viewer extension depends on ComfyUI's full frontend runtime,
            so we redirect to root with a query flag and let JS collapse the
            UI to only the bEpic viewer panel.
            """
            raise web.HTTPFound('/?bepic_viewer_only=1')

        async def _bepic_save_annotation(request):
            """Save a PNG produced by the in-viewer Annotation tool to ./output.

            Body: JSON { dataurl: "data:image/png;base64,...", filename_prefix }.
            Returns { filename, subfolder, type:"output", path } so the viewer can
            add the saved file to its history strip (and drag it onto the graph).
            """
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"error": "invalid JSON body"}, status=400)

            prefix = str(data.get("filename_prefix") or "bEpic_annotation")
            # Keep only filesystem-safe characters in the prefix.
            prefix = "".join(c for c in prefix if c.isalnum() or c in ("_", "-")) or "bEpic_annotation"

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

        async def _bepic_video_annotations(request):
            """The marks stored beside a film: {items: [...]} (empty when none)."""
            from . import annotation_io
            media, side, bad = _annot_target(dict(request.query))
            if bad is not None:
                return bad
            doc = await asyncio.get_running_loop().run_in_executor(None, annotation_io.read, side)
            doc = dict(doc or {"version": annotation_io.VERSION, "items": []})
            # Where the film is, so the page can tell the agent: its own idea of the
            # file is a ComfyUI reference, which means nothing outside ComfyUI.
            doc["media_path"] = media
            return web.json_response(doc, headers={"Cache-Control": "no-cache"})

        async def _bepic_video_annotations_save(request):
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

        async def _bepic_extract_frame(request):
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

        async def _bepic_resolve_media(request):
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

        async def _bepic_health(_request):
            return web.json_response({"ok": True, "service": "bepic_templates"})

        async def _bepic_three(request):
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

        async def _bepic_model_thumb(request):
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

        async def _bepic_scene_list(_request):
            """Saved previz scenes (output/3d_scenes)."""
            if previz is None:
                return web.json_response({"scenes": []})
            return web.json_response({"scenes": [
                {"name": s["name"], "mtime": s["mtime"]} for s in previz.list_scenes()]})

        async def _bepic_scene_load(request):
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

        async def _bepic_scene_save(request):
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

        async def _bepic_previz_frame(request):
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

        async def _bepic_previz_encode(request):
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

        async def _bepic_previz_publish(request):
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

        async def _bepic_usd_export(request):
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

        async def _bepic_usd_import(request):
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

        async def _bepic_usd_stages(_request):
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

        async def _bepic_roots(request):
            """The folders the viewer may open, for Settings → bEpic Viewer,
            and whether this request may change them."""
            editable, reason = path_access.may_edit(request)
            out = path_access.describe()
            out.update(editable=editable, reason=reason)
            return web.json_response(out)

        async def _bepic_roots_save(request):
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

        async def _bepic_roots_folders(request):
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

        async def _bepic_settings(request):
            """The viewer's settings as kept per OS user (viewer_settings.py):
            ComfyUI's own store can be per project, these are not."""
            return web.json_response({"values": viewer_settings.load(),
                                      "file": viewer_settings.path()})

        async def _bepic_settings_save(request):
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
        _safe_add("GET", "/bepic/lib/three/{name}", _bepic_three)
        _safe_add("GET", "/api/bepic/lib/three/{name}", _bepic_three)
        _safe_add("POST", "/bepic/model_thumb", _bepic_model_thumb)
        _safe_add("GET", "/bepic/scenes", _bepic_scene_list)
        _safe_add("GET", "/api/bepic/scenes", _bepic_scene_list)
        _safe_add("GET", "/bepic/scene", _bepic_scene_load)
        _safe_add("GET", "/api/bepic/scene", _bepic_scene_load)
        _safe_add("POST", "/bepic/scene", _bepic_scene_save)
        _safe_add("POST", "/api/bepic/scene", _bepic_scene_save)
        _safe_add("POST", "/bepic/previz_frame", _bepic_previz_frame)
        _safe_add("POST", "/api/bepic/previz_frame", _bepic_previz_frame)
        _safe_add("POST", "/bepic/previz_encode", _bepic_previz_encode)
        _safe_add("POST", "/api/bepic/previz_encode", _bepic_previz_encode)
        _safe_add("POST", "/bepic/usd_export", _bepic_usd_export)
        _safe_add("POST", "/api/bepic/usd_export", _bepic_usd_export)
        _safe_add("GET", "/bepic/usd_import", _bepic_usd_import)
        _safe_add("GET", "/api/bepic/usd_import", _bepic_usd_import)
        _safe_add("GET", "/bepic/usd_stages", _bepic_usd_stages)
        _safe_add("GET", "/api/bepic/usd_stages", _bepic_usd_stages)
        _safe_add("POST", "/api/bepic/model_thumb", _bepic_model_thumb)
        _safe_add("GET", "/bepic/timeline", _bepic_timeline)
        _safe_add("GET", "/api/bepic/timeline", _bepic_timeline)
        _safe_add("POST", "/bepic/timeline", _bepic_timeline_save)
        _safe_add("POST", "/api/bepic/timeline", _bepic_timeline_save)
        _safe_add("POST", "/bepic/timeline_render", _bepic_timeline_render)
        _safe_add("POST", "/bepic/timeline_solid", _bepic_timeline_solid)
        _safe_add("POST", "/api/bepic/timeline_solid", _bepic_timeline_solid)
        _safe_add("POST", "/api/bepic/timeline_render", _bepic_timeline_render)
        _safe_add("GET", "/bepic/export_options", _bepic_export_options)
        _safe_add("GET", "/api/bepic/export_options", _bepic_export_options)
        _safe_add("POST", "/bepic/export_target", _bepic_export_target)
        _safe_add("POST", "/api/bepic/export_target", _bepic_export_target)
        _safe_add("POST", "/bepic/export_places", _bepic_export_places)
        _safe_add("POST", "/bepic/export_view", _bepic_export_view)
        _safe_add("POST", "/api/bepic/export_view", _bepic_export_view)
        _safe_add("POST", "/api/bepic/export_places", _bepic_export_places)
        _safe_add("POST", "/bepic/previz_publish", _bepic_previz_publish)
        _safe_add("POST", "/api/bepic/previz_publish", _bepic_previz_publish)
        _safe_add("GET", "/bepic/raw_view", _bepic_raw_view)
        _safe_add("GET", "/api/bepic/raw_view", _bepic_raw_view)
        _safe_add("GET", "/bepic/video_annotations", _bepic_video_annotations)
        _safe_add("GET", "/api/bepic/video_annotations", _bepic_video_annotations)
        _safe_add("POST", "/bepic/video_annotations", _bepic_video_annotations_save)
        _safe_add("POST", "/api/bepic/video_annotations", _bepic_video_annotations_save)
        _safe_add("POST", "/bepic/probe_paths", _bepic_probe_paths)
        _safe_add("POST", "/api/bepic/probe_paths", _bepic_probe_paths)
        _safe_add("POST", "/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("POST", "/api/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("GET", "/bepic/browse", _bepic_browse)
        _safe_add("GET", "/api/bepic/browse", _bepic_browse)
        _safe_add("POST", "/bepic/browse_frames", _bepic_browse_frames)
        _safe_add("POST", "/bepic/code", _bepic_code_add)
        _safe_add("POST", "/api/bepic/code", _bepic_code_add)
        _safe_add("GET", "/bepic/code", _bepic_code_list)
        _safe_add("GET", "/api/bepic/code", _bepic_code_list)
        _safe_add("GET", "/bepic/text", _bepic_text)
        _safe_add("GET", "/api/bepic/text", _bepic_text)
        _safe_add("POST", "/bepic/push", _bepic_push)
        _safe_add("POST", "/api/bepic/push", _bepic_push)
        _safe_add("POST", "/api/bepic/browse_frames", _bepic_browse_frames)
        _safe_add("GET", "/bepic/view_file", _bepic_view_file)
        _safe_add("GET", "/bepic/colorspaces", _bepic_colorspaces)
        _safe_add("GET", "/api/bepic/colorspaces", _bepic_colorspaces)
        _safe_add("GET", "/bepic/thumb", _bepic_thumb)
        _safe_add("GET", "/api/bepic/thumb", _bepic_thumb)
        _safe_add("GET", "/api/bepic/view_file", _bepic_view_file)
        _safe_add("POST", "/bepic/save_annotation", _bepic_save_annotation)
        _safe_add("POST", "/api/bepic/save_annotation", _bepic_save_annotation)
        _safe_add("POST", "/bepic/extract_frame", _bepic_extract_frame)
        _safe_add("POST", "/api/bepic/extract_frame", _bepic_extract_frame)
        _safe_add("POST", "/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("POST", "/api/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("GET", "/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("GET", "/api/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("GET", "/bepic/viewer", _bepic_viewer_page)
        _safe_add("GET", "/api/bepic/viewer", _bepic_viewer_page)
        _safe_add("GET", "/imageviewer", _bepic_viewer_page)
        _safe_add("GET", "/api/imageviewer", _bepic_viewer_page)
        _safe_add("GET", "/bepic/settings", _bepic_settings)
        _safe_add("GET", "/api/bepic/settings", _bepic_settings)
        _safe_add("POST", "/bepic/settings", _bepic_settings_save)
        _safe_add("POST", "/api/bepic/settings", _bepic_settings_save)
        _safe_add("GET", "/bepic/roots", _bepic_roots)
        _safe_add("GET", "/api/bepic/roots", _bepic_roots)
        _safe_add("POST", "/bepic/roots", _bepic_roots_save)
        _safe_add("POST", "/api/bepic/roots", _bepic_roots_save)
        _safe_add("POST", "/bepic/roots/folders", _bepic_roots_folders)
        _safe_add("POST", "/api/bepic/roots/folders", _bepic_roots_folders)
        _safe_add("GET", "/bepic/health", _bepic_health)
        _safe_add("GET", "/api/bepic/health", _bepic_health)

    try:
        register_routes()
    except Exception as e:
        print(f"[bEpicViewer] could not register viewer routes: {e}")
        traceback.print_exc()
except ImportError:
    # aiohttp not available; skip route registration
    pass
