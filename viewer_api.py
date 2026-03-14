import os
import traceback
import folder_paths
from server import PromptServer

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
                print(f"[bEpicGetPath] route register failed {method} {path}: {e}")

        async def _bepic_open_path(request):
            data = {}
            if request.method == "POST":
                try:
                    data = await request.json()
                except Exception:
                    data = {}
            else:
                data = dict(request.query)

            paths_id = data.get("paths_id", "")
            path_key = data.get("path_key", "")
            suffix = data.get("suffix", "")

            try:
                from . import nodes
                store = getattr(nodes, 'BEPIC_PATHS_STORE', {})
            except Exception:
                store = {}
            # look up the specific paths dict for this ID; fall back to empty if missing
            paths_to_use = store.get(paths_id, {})
            rel = f"{paths_to_use.get(path_key, '')}{suffix}"

            print(f"[bEpicGetPath] open_path called with paths_id={paths_id!r}, path_key={path_key!r}, suffix={suffix!r}")
            print(f"[bEpicGetPath] store lookup returned: {paths_to_use!r}")
            print(f"[bEpicGetPath] relative path computed: {rel!r}")
            try:
                base = folder_paths.get_output_directory()
            except Exception:
                try:
                    base = folder_paths.get_temp_directory()
                except Exception:
                    base = os.getcwd()
            full = os.path.abspath(os.path.join(base, rel))
            print(f"[bEpicGetPath] base directory: {base!r}, full path: {full!r}")

            if os.path.isdir(full):
                target_dir = full
            else:
                target_dir = os.path.dirname(full) or base
            try:
                os.makedirs(target_dir, exist_ok=True)
            except Exception:
                pass
            try:
                os.startfile(target_dir)
            except Exception as e:
                print(f"[bEpicGetPath] _bepic_open_path error: {e}")

            return web.json_response({"success": True})

        async def _bepic_raw_view(request):
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' or 'filename' parameter")

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

            norm_cand = os.path.normcase(cand)
            allowed = False
            if temp_base:
                try:
                    if os.path.commonpath([os.path.normcase(os.path.abspath(temp_base)), norm_cand]).startswith(os.path.normcase(os.path.abspath(temp_base))):
                        allowed = True
                except Exception:
                    if norm_cand.startswith(os.path.normcase(os.path.abspath(temp_base))):
                        allowed = True
            if out_base and not allowed:
                try:
                    if os.path.commonpath([os.path.normcase(os.path.abspath(out_base)), norm_cand]).startswith(os.path.normcase(os.path.abspath(out_base))):
                        allowed = True
                except Exception:
                    if norm_cand.startswith(os.path.normcase(os.path.abspath(out_base))):
                        allowed = True

            if not allowed:
                print(f"[bEpicRawView] access denied for {cand}")
                return web.Response(status=403, text="access denied")

            if not os.path.exists(cand):
                print(f"[bEpicRawView] file not found: {cand}")
                return web.Response(status=404, text="file not found")

            return web.FileResponse(cand)

        async def _bepic_pick_folder(request):
            """Open a server-side folder picker dialog and return a sorted list of image files."""
            folder = None
            error = None
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                try:
                    root.wm_attributes('-topmost', 1)
                except Exception:
                    pass
                folder = filedialog.askdirectory(title="Select Folder to Open in Viewer")
                root.destroy()
            except Exception as e:
                error = str(e)

            if not folder:
                return web.json_response({"folder": None, "files": [], "error": error or "No folder selected"})

            image_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif'}
            files = []
            try:
                for fname in sorted(os.listdir(folder)):
                    ext = os.path.splitext(fname)[1].lower()
                    if ext in image_extensions:
                        full_path = os.path.join(folder, fname)
                        if os.path.isfile(full_path):
                            files.append({"path": full_path, "name": fname})
            except Exception as e:
                return web.json_response({"folder": folder, "files": [], "error": str(e)})

            return web.json_response({"folder": folder, "files": files})

        async def _bepic_view_file(request):
            """Serve any absolute file path selected by the user (no directory restriction)."""
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' parameter")
            path = os.path.abspath(path)
            if not os.path.isfile(path):
                return web.Response(status=404, text="file not found")
            return web.FileResponse(path)

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

        async def _bepic_health(_request):
            return web.json_response({"ok": True, "service": "bepic_templates"})

        _safe_add("POST", "/bepic/open_path", _bepic_open_path)
        _safe_add("GET", "/bepic/open_path", _bepic_open_path)
        _safe_add("POST", "/api/bepic/open_path", _bepic_open_path)
        _safe_add("GET", "/api/bepic/open_path", _bepic_open_path)
        _safe_add("GET", "/bepic/raw_view", _bepic_raw_view)
        _safe_add("GET", "/api/bepic/raw_view", _bepic_raw_view)
        _safe_add("GET", "/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("GET", "/api/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("GET", "/bepic/pick_folder", _bepic_pick_folder)
        _safe_add("GET", "/api/bepic/pick_folder", _bepic_pick_folder)
        _safe_add("GET", "/bepic/view_file", _bepic_view_file)
        _safe_add("GET", "/api/bepic/view_file", _bepic_view_file)
        _safe_add("GET", "/bepic/viewer", _bepic_viewer_page)
        _safe_add("GET", "/api/bepic/viewer", _bepic_viewer_page)
        _safe_add("GET", "/imageviewer", _bepic_viewer_page)
        _safe_add("GET", "/api/imageviewer", _bepic_viewer_page)
        _safe_add("GET", "/bepic/health", _bepic_health)
        _safe_add("GET", "/api/bepic/health", _bepic_health)

    try:
        register_routes()
    except Exception as e:
        print(f"[bEpicGetPath] could not register viewer routes: {e}")
        traceback.print_exc()
except ImportError:
    # aiohttp not available; skip route registration
    pass
