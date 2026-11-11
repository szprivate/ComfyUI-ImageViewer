"""Character rigs: export, auto-rigging and AI motion for the 3D space.

    POST /imageviewer/rig/export        multipart: a "meta" JSON part + binary parts it names
                                        ({format: fbx|usd|abc, name, context, ...} + rig_export.parse_payload)
                                        -> {ok, path, relative, version}: by the export rule (kind "character")
    POST /imageviewer/rig/read_motion   {path} -> rig_import.read: an FBX / USD file's settings, the viewer's rig
                                        carried in it (live), and a USD skeleton's animation (the page reads an
                                        FBX's motion itself, with FBXLoader); may_serve-guarded
    GET  /imageviewer/rig/tools         -> {unirig: {ready, why}, kimodo: {ready, why, model},
                                            install: {root, hf_token: bool, running: job id | null}}
    POST /imageviewer/rig/install       {root?, only?: unirig|kimodo|posetrack, hf_token?} -> {job}: runs
                                        scripts/rig/install_rig_tools.py (an Install button in the page);
                                        a token is written where huggingface_hub reads it, never answered
    POST /imageviewer/rig/autorig       {src, name?, context?, seed?} -> {job}: UniRig on the model's file;
                                        the job's result is {path, relative}, a skinned .glb by the export rule
    POST /imageviewer/rig/motion        {mode: text|inbetween|restyle, prompt, frames, keys?, path?, seed?, steps?,
                                        samples?, heading?} -> {job}: Kimodo; the result is the motion on its own
                                        skeleton (scripts/rig/kimodo_run.py), retargeted in the page
    POST /imageviewer/rig/video_pose    {src, start?, end?, step?} -> {job}: MediaPipe's Pose Landmarker on a film
                                        (scripts/rig/video_pose_run.py); the result is the landmarks per frame,
                                        solved onto the character in the page (imageViewer_rigVideo.js)
    POST /imageviewer/rig/lipsync       {src, fps, start?, seconds?, lead?, smooth?, strength?} -> mouth curves per
                                        frame (lipsync.py, in this process), put on blendshapes in the page
    GET  /imageviewer/rig/job?job=      -> {state: running|done|error|cancelled, log, result?, error?}
    POST /imageviewer/rig/job           {job, cancel: true}
    POST /imageviewer/rig/agent         {action: rig|remove_rig|autorig|motion|inbetween|clean_feet|export|add_motion, model?,
                                        ...} -> {id}: sent to the open page (event imageviewer.rig.agent), which
                                        does it on its 3D scene and reports to POST /imageviewer/rig/agent_done;
                                        GET /imageviewer/rig/agent?id= -> {state: sent|running|done|error, result?}

The models run outside ComfyUI's Python, each in an environment of its own
(they pin torch, CUDA extensions and in UniRig's case Blender's ``bpy``): the
viewer starts the runner script under scripts/rig/ with that environment's
interpreter. Which interpreter is an admin's setting, never the page's: it is
read from ``rig_tools.json`` in the viewer's user folder (or the file named by
IMAGE_VIEWER_RIG_TOOLS), or from the IMAGE_VIEWER_UNIRIG_PYTHON / _DIR and
IMAGE_VIEWER_KIMODO_PYTHON environment variables::

    {"unirig": {"python": "D:/AI/rigtools/UniRig/.venv/Scripts/python.exe", "repo": "D:/AI/rigtools/UniRig"},
     "kimodo": {"python": "D:/AI/rigtools/kimodo/.venv/Scripts/python.exe",
                "model": "Kimodo-SOMA-RP-v1.2", "text_encoder_device": "cpu"}}

scripts/rig/install_rig_tools.py sets both up and writes that file.
Kimodo is kept loaded between requests (one worker process, fed a request per
line), since loading it takes most of a minute.
"""
from __future__ import annotations

import json
import os
import re
import signal
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import atexit
import urllib.parse
from struct import error as struct_error

from . import rig_export
from . import rig_import

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts", "rig")
INSTALLER = os.path.join(SCRIPTS, "install_rig_tools.py")
MAX_JOBS = 8
LOG_LINES = 60
DEFAULT_KIMODO_MODEL = "Kimodo-SOMA-RP-v1.2"
MAX_PART = 512 * 1024 * 1024
WORKERS = []            # the Kimodo workers started, so they can be stopped (at exit, in tests)


def config_path():
    custom = os.environ.get("IMAGE_VIEWER_RIG_TOOLS", "").strip().strip('"')
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    try:
        from .legacy_names import user_dir
    except ImportError:  # pragma: no cover - run outside the package
        from legacy_names import user_dir
    return os.path.join(user_dir(), "rig_tools.json")


def tools_config():
    """What is set up: {"unirig": {...}, "kimodo": {...}} from the file, the environment over it."""
    cfg = {}
    try:
        with open(config_path(), encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            cfg = {k: dict(v) for k, v in raw.items() if isinstance(v, dict)}
    except (OSError, ValueError):
        pass
    env = os.environ
    for tool, key, var in (("unirig", "python", "IMAGE_VIEWER_UNIRIG_PYTHON"), ("unirig", "repo", "IMAGE_VIEWER_UNIRIG_DIR"),
                           ("kimodo", "python", "IMAGE_VIEWER_KIMODO_PYTHON"), ("kimodo", "model", "IMAGE_VIEWER_KIMODO_MODEL"),
                           ("posetrack", "python", "IMAGE_VIEWER_POSETRACK_PYTHON"),
                           ("posetrack", "model", "IMAGE_VIEWER_POSETRACK_MODEL")):
        if env.get(var):
            cfg.setdefault(tool, {})[key] = env[var]
    return cfg


def tool_status(cfg=None):
    cfg = tools_config() if cfg is None else cfg
    out = {}
    u = cfg.get("unirig") or {}
    if not u.get("python"):
        out["unirig"] = {"ready": False, "why": "UniRig is not set up (scripts/rig/install_rig_tools.py)"}
    elif not os.path.isfile(u["python"]):
        out["unirig"] = {"ready": False, "why": f"UniRig's Python is not there: {u['python']}"}
    elif not u.get("repo") or not os.path.isfile(os.path.join(u["repo"], "run.py")):
        out["unirig"] = {"ready": False, "why": "UniRig's folder (with run.py) is not set"}
    else:
        out["unirig"] = {"ready": True, "why": ""}
    k = cfg.get("kimodo") or {}
    model = k.get("model") or DEFAULT_KIMODO_MODEL
    if not k.get("python"):
        out["kimodo"] = {"ready": False, "why": "Kimodo is not set up (scripts/rig/install_rig_tools.py)", "model": model}
    elif not os.path.isfile(k["python"]):
        out["kimodo"] = {"ready": False, "why": f"Kimodo's Python is not there: {k['python']}", "model": model}
    else:
        out["kimodo"] = {"ready": True, "why": "", "model": model}
    p = cfg.get("posetrack") or {}
    if not p.get("python"):
        out["posetrack"] = {"ready": False, "why": "Motion from video is not set up (scripts/rig/install_rig_tools.py --only posetrack)"}
    elif not os.path.isfile(p["python"]):
        out["posetrack"] = {"ready": False, "why": f"The pose tracker's Python is not there: {p['python']}"}
    elif not p.get("model") or not os.path.isfile(p["model"]):
        out["posetrack"] = {"ready": False, "why": "The pose tracker's model (.task) is not there"}
    else:
        out["posetrack"] = {"ready": True, "why": ""}
    return out


UNIRIG_READS = {".obj", ".fbx", ".dae", ".glb", ".gltf", ".vrm"}


def abc_to_obj(src, dst):
    """An Alembic's first sample, every mesh in world space, as one OBJ (UniRig cannot read Alembic)."""
    try:
        from . import abc_io
    except ImportError:  # pragma: no cover - run outside the package
        import abc_io
    verts, faces = abc_io.to_mesh(src, sample=0)
    if not faces:
        raise RuntimeError("the Alembic has no mesh in it")
    with open(dst, "w", encoding="utf-8") as fh:
        fh.write("".join(f"v {x:.6f} {y:.6f} {z:.6f}\n" for x, y, z in verts))
        fh.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in faces))


def default_root(folder_paths):
    """Where the Install button puts the tools by default: beside ComfyUI's folder (D:/AI/comfyui ->
    D:/AI/rigtools), so they are not inside it; or the folder an earlier install used."""
    cfg = tools_config()
    for tool, key in (("unirig", "repo"), ("kimodo", "python")):
        path = (cfg.get(tool) or {}).get(key)
        if path:
            # <root>/UniRig, or <root>/kimodo/.venv/<bin>/python
            up = os.path.dirname(path) if tool == "unirig" else os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(path))))
            if up:
                return up
    base = getattr(folder_paths, "base_path", None)
    if base:
        return os.path.join(os.path.dirname(os.path.abspath(base)), "rigtools")
    return os.path.join(os.path.dirname(config_path()), "rigtools")


def hf_token_path():
    """Where huggingface_hub reads the token: HF_TOKEN_PATH, else HF_HOME/token, else ~/.cache/huggingface/token."""
    if os.environ.get("HF_TOKEN_PATH"):
        return os.path.expanduser(os.environ["HF_TOKEN_PATH"])
    home = os.environ.get("HF_HOME") or os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache"), "huggingface")
    return os.path.join(os.path.expanduser(home), "token")


def has_hf_token():
    if os.environ.get("HF_TOKEN"):
        return True
    try:
        with open(hf_token_path(), encoding="utf-8") as fh:
            return bool(fh.read().strip())
    except OSError:
        return False


HF_TOKEN_RE = re.compile(r"^hf_[A-Za-z0-9]{20,}$")


def save_hf_token(token):
    token = str(token or "").strip()
    if not HF_TOKEN_RE.match(token):
        raise ValueError("That is not a Hugging Face token (they start with hf_).")
    path = hf_token_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(token)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def clean_path(path, frames):
    """A motion's hips path for Kimodo's root2d constraint: {frames: [int], xz: [[x, z]]}, inside [0, frames)."""
    if not path:
        return None
    if not isinstance(path, dict):
        raise ValueError("path is {frames, xz}")
    fs, xz = path.get("frames"), path.get("xz")
    if not isinstance(fs, list) or not isinstance(xz, list) or len(fs) != len(xz) or len(fs) > 1800:
        raise ValueError("path: frames and xz of the same length (at most 1800)")
    out_f, out_xz, seen = [], [], set()
    for f, p in zip(fs, xz):
        try:
            f = int(f)
            x, z = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            raise ValueError("path: whole frames and [x, z] pairs")
        if not 0 <= f < frames or f in seen or not (abs(x) < 1e4 and abs(z) < 1e4):
            continue
        seen.add(f)
        out_f.append(f)
        out_xz.append([round(x, 5), round(z, 5)])
    return {"frames": out_f, "xz": out_xz} if out_f else None


def _kill_tree(proc):
    """Stop a process and what it started (the installer runs pip, which runs more)."""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.call(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, **_no_window())
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:  # noqa: BLE001 - fall back to the one process
        pass
    if proc.poll() is None:
        proc.kill()


def kind_logs(kind):
    """The jobs that run a model or an install keep a log file; an export is quick and says its error."""
    return kind in ("autorig", "motion", "install", "video_pose")


# How many commands (the installer's "$ " lines) a full install of each tool runs: for the progress bar.
INSTALL_STEPS = {"unirig": 10, "kimodo": 5, "posetrack": 3}



def kimodo_why(text):
    """Say plainly when Kimodo stopped on a gated Hugging Face model."""
    if "gated repo" not in text:
        return text
    m = re.search(r"huggingface\.co/([\w.-]+/[\w.-]+)", text)
    repo = m.group(1).rstrip(".") if m else "the text encoder model"
    if "awaiting a review" in text:
        return (f"Kimodo needs access to {repo}, and your request is still waiting for its "
                f"authors to approve it. Try again once https://huggingface.co/{repo} says you have access.")
    return (f"Kimodo needs access to the gated model {repo}. Request it at "
            f"https://huggingface.co/{repo}, then run `hf auth login` in the Kimodo venv.")

class _Job:
    def __init__(self, kind):
        self.id = secrets.token_hex(8)
        self.kind = kind
        self.state = "running"
        self.log = []
        self.result = None
        self.error = None
        self.proc = None
        self.cancelled = False
        self.started = time.time()
        self.share = None
        self.log_path = None
        self._fh = None

    def open_log(self):
        """Everything the job prints also goes to a file (the page only sees the last lines):
        <viewer user folder>/rig_logs/<kind>_<time>.log, the last 20 kept."""
        try:
            folder = os.path.join(os.path.dirname(config_path()), "rig_logs")
            os.makedirs(folder, exist_ok=True)
            old = sorted(f for f in os.listdir(folder) if f.endswith(".log"))
            for f in old[:max(0, len(old) - 19)]:
                try:
                    os.remove(os.path.join(folder, f))
                except OSError:
                    pass
            self.log_path = os.path.join(folder, f"{time.strftime('%Y%m%d_%H%M%S')}_{self.kind}_{self.id[:6]}.log")
            self._fh = open(self.log_path, "a", encoding="utf-8", errors="replace")
        except OSError:
            self.log_path, self._fh = None, None

    def close_log(self):
        if self._fh:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None

    def say(self, line):
        line = str(line).rstrip()
        if self._fh:
            try:
                self._fh.write(line + "\n")
                self._fh.flush()
            except OSError:
                pass
        if line:
            self.log.append(line)
            del self.log[:-LOG_LINES]

    def view(self):
        out = {"job": self.id, "kind": self.kind, "state": self.state, "log": self.log[-12:],
               "seconds": round(time.time() - self.started, 1)}
        if self.share is not None:
            out["share"] = round(self.share, 3)
        if self.log_path:
            out["log_file"] = self.log_path
        if self.result is not None:
            out["result"] = self.result
        if self.error:
            out["error"] = self.error
        return out


class _KimodoWorker:
    """One long-lived Kimodo process: a JSON request per stdin line, answered by a {"done"|"error"} line."""

    def __init__(self):
        self.proc = None
        self.key = None
        self.lock = threading.Lock()

    def _start(self, cfg, job):
        key = (cfg["python"], cfg.get("model"), cfg.get("text_encoder_device"))
        if self.proc and self.proc.poll() is None and self.key == key:
            return
        self.stop()
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        if cfg.get("text_encoder_device"):
            env["TEXT_ENCODER_DEVICE"] = str(cfg["text_encoder_device"])
        for k, v in (cfg.get("env") or {}).items():
            env[str(k)] = str(v)
        job.say("starting Kimodo (the first run loads the model; that takes a while)")
        self.proc = subprocess.Popen(
            [cfg["python"], "-u", os.path.join(SCRIPTS, "kimodo_run.py"), "--serve",
             "--model", cfg.get("model") or DEFAULT_KIMODO_MODEL],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            env=env, cwd=cfg.get("cwd") or None, **_no_window())
        self.key = key

    def run(self, cfg, job, request_path, output_path):
        with self.lock:
            self._start(cfg, job)
            job.proc = self.proc
            self.proc.stdin.write(json.dumps({"request": request_path, "output": output_path}) + "\n")
            self.proc.stdin.flush()
            for line in self.proc.stdout:
                if line.startswith("@@"):
                    msg = json.loads(line[2:])
                    if "error" in msg:
                        raise RuntimeError(kimodo_why(msg["error"]))
                    if msg.get("done"):
                        return
                    continue
                job.say(line)
                if job.cancelled:
                    break
            if job.cancelled:
                self.stop()
                raise RuntimeError("cancelled")
            raise RuntimeError(kimodo_why("Kimodo stopped: " + " | ".join(job.log[-4:])))

    def stop(self):
        proc, self.proc = self.proc, None
        if not proc:
            return
        if proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                pass
        for pipe in (proc.stdin, proc.stdout):
            try:
                pipe.close()
            except (OSError, AttributeError):
                pass


@atexit.register
def _stop_workers():
    for w in WORKERS:
        w.stop()


def _no_window():
    if sys.platform == "win32":
        return {"creationflags": 0x08000000}           # CREATE_NO_WINDOW
    return {}


def resolve_src(src, folder_paths, resolve=None):
    """A model item's src -> the file on disk (or "")."""
    if not isinstance(src, dict):
        return ""
    if src.get("path"):
        p = str(src["path"])
        if resolve:
            p = resolve(p) or p
        return os.path.abspath(p)
    if src.get("filename"):
        kind = str(src.get("type") or "output")
        try:
            base = folder_paths.get_directory_by_type(kind)
        except Exception:  # noqa: BLE001
            base = None
        if not base:
            return ""
        return os.path.abspath(os.path.join(base, str(src.get("subfolder") or ""), str(src["filename"])))
    url = str(src.get("url") or "")
    if "/view?" in url:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        return resolve_src({k: (q.get(k) or [""])[0] for k in ("filename", "subfolder", "type")}, folder_paths)
    return ""


WRITERS = {"fbx": "write_fbx", "usd": "write_usd", "abc": "write_abc"}


def _usd_ok():
    try:
        from pxr import UsdSkel  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


AGENT_ACTIONS = ("rig", "remove_rig", "autorig", "motion", "inbetween", "clean_feet", "export",
                 "restyle", "video_motion", "lipsync",
                 "layer_add", "layer_list", "constrain", "remove_constraint", "list_constraints", "bake_constraints",
                 "pose_list", "pose_save", "pose_apply", "pose_delete", "flip_pose", "add_motion",
                 "pose", "pose_presets")
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}
SOUND_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"} | VIDEO_EXTS


def register(add, *, web, path_access, export_rules, folder_paths, resolve=None, send=None):
    """Add the routes through ``add(method, path, handler)``; each under /imageviewer and /api/imageviewer.
    ``send(event, data)`` reaches the open pages (PromptServer.send_sync): the agent's requests go there."""
    import asyncio

    jobs = {}
    kimodo = _KimodoWorker()
    WORKERS.append(kimodo)

    def off(fn, *a, **k):
        return asyncio.get_running_loop().run_in_executor(None, lambda: fn(*a, **k))

    def err(e, status=400):
        return web.json_response({"error": str(e)}, status=status)

    def relative(path):
        root = os.path.abspath(folder_paths.get_output_directory())
        p = os.path.abspath(path)
        return os.path.relpath(p, root).replace("\\", "/") if p.startswith(root + os.sep) else ""

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

    def new_job(kind):
        for jid in [j for j, v in jobs.items() if v.state != "running"][:max(0, len(jobs) - MAX_JOBS + 1)]:
            jobs.pop(jid, None)
        if sum(1 for v in jobs.values() if v.state == "running") >= MAX_JOBS:
            raise web.HTTPTooManyRequests(text="too many rig jobs running")
        job = _Job(kind)
        jobs[job.id] = job
        return job

    def spawn(job, work):
        def run():
            try:
                job.result = work()
                job.state = "cancelled" if job.cancelled else "done"
            except Exception as e:  # noqa: BLE001 - reported to the page
                job.state = "cancelled" if job.cancelled else "error"
                job.error = str(e)
                job.say(f"!! {e}")
                if job.log_path and not job.cancelled:
                    job.error += f" (full log: {job.log_path})"
            finally:
                job.close_log()
        if kind_logs(job.kind):
            job.open_log()
        threading.Thread(target=run, daemon=True, name=f"rig-{job.kind}").start()

    # ── export ───────────────────────────────────────────────────────────────

    def upload_ok(request):
        """same_origin's checks for a multipart body: this machine's host, ComfyUI's own Origin, and the
        X-ImageViewer-Rig header in place of a JSON content type (a custom header cannot be sent across
        sites without a CORS preflight, so other sites stay out the same way)."""
        if not path_access._own_host(request.host):
            return "Refused: the page was not opened by this machine's address or name."
        origin = request.headers.get("Origin")
        if origin is not None:
            parts = urllib.parse.urlsplit(origin)
            if origin == "null" or not parts.netloc or parts.netloc.lower() != (request.host or "").lower():
                return "Refused: the request did not come from ComfyUI's own page."
        if request.headers.get("X-ImageViewer-Rig") != "1":
            return "Refused: the export must be sent by the viewer."
        return ""

    async def export(request):
        why = upload_ok(request)
        if why:
            return web.Response(status=403, text=why)
        try:
            reader = await request.multipart()
        except Exception:  # noqa: BLE001
            return err("the request is not multipart")
        meta, blobs = None, {}
        while True:
            part = await reader.next()
            if part is None:
                break
            data = bytearray()
            while True:
                chunk = await part.read_chunk(1 << 20)
                if not chunk:
                    break
                data += chunk
                if len(data) > MAX_PART:
                    return err("a part is too large", 413)
            if part.name == "meta":
                try:
                    meta = json.loads(bytes(data).decode("utf-8"))
                except ValueError:
                    return err("the meta part is not JSON")
            else:
                blobs[part.name] = bytes(data)
        if not isinstance(meta, dict):
            return err("no meta part")
        fmt = str(meta.get("format") or "fbx").lower()
        if fmt not in WRITERS:
            return err(f"unknown format {fmt}")
        if fmt == "usd" and not _usd_ok():
            return err("USD needs usd-core in ComfyUI's Python (pip install usd-core)", 501)
        try:
            data = rig_export.parse_payload(meta, blobs)
            where = export_rules.target("character", meta.get("name") or "character", fmt,
                                        folder_paths.get_output_directory(), meta.get("context"))
        except (ValueError, KeyError) as e:
            return err(e)
        os.makedirs(os.path.dirname(where["path"]), exist_ok=True)
        try:
            await off(getattr(rig_export, WRITERS[fmt]), where["path"], data)
        except Exception as e:  # noqa: BLE001
            return err(f"could not write the {fmt.upper()}: {e}", 500)
        return web.json_response({"ok": True, "path": where["path"], "relative": relative(where["path"]),
                                  "version": where.get("version"), "name": os.path.basename(where["path"])})

    async def read_motion(request):
        """POST {path}: what an FBX / USD file brings back - its settings, the viewer's rig if it
        carries one, and (USD) the skeleton's animation. A file the viewer may serve, nothing else."""
        body = await body_of(request)
        raw = str(body.get("path") or "")
        p = resolve_src({"path": raw}, folder_paths, resolve) if raw else resolve_src(body.get("src"), folder_paths, resolve)
        if not p or not os.path.isfile(p):
            return err("no such file", 404)
        if not path_access.may_serve(p):
            return web.Response(status=403, text=path_access.serve_refusal(p))
        if os.path.splitext(p)[1].lower() in (".usd", ".usda", ".usdc", ".usdz") and not _usd_ok():
            return err("USD needs usd-core in ComfyUI's Python (pip install usd-core)", 501)
        try:
            out = await off(rig_import.read, p)
        except (ValueError, OSError, struct_error) as e:
            return err(f"could not read {os.path.basename(p)}: {e}", 422)
        except Exception as e:  # noqa: BLE001 - pxr raises its own errors
            return err(f"could not read {os.path.basename(p)}: {e}", 422)
        out["path"] = p
        out["name"] = os.path.basename(p)
        return web.json_response(out)

    # ── the tools ────────────────────────────────────────────────────────────

    def installing():
        return next((j for j in jobs.values() if j.kind == "install" and j.state == "running"), None)

    async def tools(request):
        out = tool_status()
        run = installing()
        out["install"] = {"root": default_root(folder_paths), "hf_token": has_hf_token(),
                          "running": run.id if run else None}
        return web.json_response(out)

    async def install(request):
        body = await body_of(request)
        run = installing()
        if run:
            return web.json_response(run.view())
        root = str(body.get("root") or default_root(folder_paths)).strip().strip('"')
        root = os.path.abspath(os.path.expanduser(root))
        if not os.path.isabs(root) or os.path.dirname(root) == root:
            return err("choose a folder for the tools (not a drive's top folder)")
        if os.path.isfile(root):
            return err(f"{root} is a file")
        only = body.get("only")
        if only not in (None, "", "unirig", "kimodo", "posetrack"):
            return err("only is unirig, kimodo or posetrack")
        if body.get("hf_token"):
            try:
                save_hf_token(body["hf_token"])
            except ValueError as e:
                return err(e)
        script = INSTALLER
        cmd = [sys.executable, "-u", script, "--root", root]
        if only:
            cmd += ["--only", only]
        steps = INSTALL_STEPS[only] if only else sum(INSTALL_STEPS.values())
        job = new_job("install")

        def work():
            env = dict(os.environ, PYTHONUNBUFFERED="1")
            extra = {"start_new_session": True} if os.name != "nt" else {}
            flags = _no_window()
            if os.name == "nt":
                flags["creationflags"] = flags.get("creationflags", 0) | subprocess.CREATE_NEW_PROCESS_GROUP
            job.proc = subprocess.Popen(cmd, cwd=os.path.dirname(script), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, bufsize=1, env=env, encoding="utf-8", errors="replace",
                                        **extra, **flags)
            ran = 0
            job.share = 0.0
            for line in job.proc.stdout:
                job.say(line)
                if line.startswith("$ "):
                    ran += 1
                    job.share = min(0.97, ran / max(1, steps))
            code = job.proc.wait()
            job.proc.stdout.close()
            if job.cancelled:
                raise RuntimeError("cancelled")
            if code != 0:
                raise RuntimeError("The install stopped: " + " | ".join(l for l in job.log[-5:] if l.strip()))
            job.share = 1.0
            return tool_status()

        spawn(job, work)
        return web.json_response(job.view())

    async def autorig(request):
        body = await body_of(request)
        cfg = tools_config().get("unirig") or {}
        status = tool_status({"unirig": cfg})["unirig"]
        if not status["ready"]:
            return err(status["why"], 501)
        src = resolve_src(body.get("src"), folder_paths, resolve)
        if not src or not os.path.isfile(src):
            return err("the model's file was not found", 404)
        if not path_access.is_allowed(src):
            return err(path_access.refusal(src), 403)
        try:
            where = export_rules.target("character", (body.get("name") or "character") + "_rig", "glb",
                                        folder_paths.get_output_directory(), body.get("context"))
        except ValueError as e:
            return err(e)
        seed = int(body.get("seed") or 12345)
        job = new_job("autorig")

        ext = os.path.splitext(src)[1].lower()
        if ext not in UNIRIG_READS and ext != ".abc":
            return err(f"UniRig reads {', '.join(sorted(UNIRIG_READS))} or Alembic, not {ext or 'this file'}", 400)

        def work():
            os.makedirs(os.path.dirname(where["path"]), exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="unirig_") as tmp:
                given = src
                if ext == ".abc":
                    given = os.path.join(tmp, "source.obj")
                    job.say("== Alembic: its first frame as a mesh for UniRig")
                    abc_to_obj(src, given)
                cmd = [cfg["python"], "-u", os.path.join(SCRIPTS, "unirig_run.py"), "--repo", cfg["repo"],
                       "--input", given, "--output", where["path"], "--work", tmp, "--seed", str(seed)]
                env = dict(os.environ, PYTHONUNBUFFERED="1")
                for k, v in (cfg.get("env") or {}).items():
                    env[str(k)] = str(v)
                job.proc = subprocess.Popen(cmd, cwd=cfg["repo"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                            text=True, bufsize=1, env=env, **_no_window())
                for line in job.proc.stdout:
                    job.say(line)
                code = job.proc.wait()
                job.proc.stdout.close()
                if job.cancelled:
                    raise RuntimeError("cancelled")
                if code != 0 or not os.path.isfile(where["path"]):
                    said = [l for l in job.log if l.startswith("!! ")]
                    raise RuntimeError("UniRig failed: " + (" / ".join(l[3:] for l in said[-2:]) if said else " | ".join(job.log[-4:])))
            return {"path": where["path"], "relative": relative(where["path"]), "name": os.path.basename(where["path"])}

        spawn(job, work)
        return web.json_response(job.view())

    async def motion(request):
        body = await body_of(request)
        cfg = dict(tools_config().get("kimodo") or {})
        status = tool_status({"kimodo": cfg})["kimodo"]
        if not status["ready"]:
            return err(status["why"], 501)
        mode = body.get("mode")
        if mode not in ("text", "inbetween", "restyle"):
            return err("mode is text, inbetween or restyle")
        try:
            frames = int(body.get("frames") or 0)
        except (TypeError, ValueError):
            frames = 0
        if not 8 <= frames <= 30 * 60:
            return err("frames: between 8 and 1800 (Kimodo works at 30 fps)")
        if mode == "inbetween" and not body.get("keys"):
            return err("an in-between needs the keyed poses")
        try:
            path = clean_path(body.get("path"), frames)
        except ValueError as e:
            return err(str(e))
        if mode == "restyle" and not path:
            return err("a restyle needs the motion's path")
        if mode == "restyle" and not str(body.get("prompt") or "").strip():
            return err("describe the style (a person walks like a tired old man)")
        try:
            steps, samples = int(body.get("steps") or 100), int(body.get("samples") or 1)
            heading = float(body.get("heading") or 0.0)
        except (TypeError, ValueError):
            return err("steps, samples and heading are numbers")
        request_doc = {
            "prompt": str(body.get("prompt") or ("A person moves naturally." if mode == "inbetween" else "")).strip(),
            "frames": frames,
            "keys": body.get("keys") or [],
            "path": path,
            "seed": body.get("seed"),
            "steps": max(10, min(200, steps)),
            "samples": max(1, min(4, samples)),
            "heading": heading,
            "postprocess": body.get("postprocess", True) is not False,
        }
        if not request_doc["prompt"]:
            return err("describe the motion")
        job = new_job("motion")

        def work():
            with tempfile.TemporaryDirectory(prefix="kimodo_") as tmp:
                req = os.path.join(tmp, "request.json")
                out = os.path.join(tmp, "motion.json")
                with open(req, "w", encoding="utf-8") as fh:
                    json.dump(request_doc, fh)
                kimodo.run(cfg, job, req, out)
                with open(out, encoding="utf-8") as fh:
                    return json.load(fh)

        spawn(job, work)
        return web.json_response(job.view())

    def media_src(body, exts, what):
        """A film or sound named by the page ({path} or {filename, subfolder, type} or a /view URL) -> its file."""
        src = resolve_src(body.get("src"), folder_paths, resolve)
        if not src or not os.path.isfile(src):
            raise LookupError(f"the {what} was not found")
        if not path_access.is_allowed(src) or not path_access.may_serve(src):
            raise PermissionError(path_access.refusal(src))
        ext = os.path.splitext(src)[1].lower()
        if ext not in exts:
            raise ValueError(f"not a {what}: {ext or 'no extension'}")
        return src

    async def video_pose(request):
        body = await body_of(request)
        cfg = dict(tools_config().get("posetrack") or {})
        status = tool_status({"posetrack": cfg})["posetrack"]
        if not status["ready"]:
            return err(status["why"], 501)
        try:
            src = media_src(body, VIDEO_EXTS, "film")
        except LookupError as e:
            return err(e, 404)
        except PermissionError as e:
            return err(e, 403)
        except ValueError as e:
            return err(e)
        try:
            start, end = int(body.get("start") or 0), int(body.get("end") if body.get("end") is not None else -1)
            step = max(1, min(8, int(body.get("step") or 1)))
        except (TypeError, ValueError):
            return err("start, end and step are whole frames")
        job = new_job("video_pose")

        def work():
            with tempfile.TemporaryDirectory(prefix="posetrack_") as tmp:
                out = os.path.join(tmp, "pose.json")
                cmd = [cfg["python"], "-u", os.path.join(SCRIPTS, "video_pose_run.py"), "--model", cfg["model"],
                       "--video", src, "--output", out, "--start", str(max(0, start)), "--end", str(end),
                       "--step", str(step)]
                env = dict(os.environ, PYTHONUNBUFFERED="1")
                for k, v in (cfg.get("env") or {}).items():
                    env[str(k)] = str(v)
                job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                            bufsize=1, env=env, **_no_window())
                for line in job.proc.stdout:
                    job.say(line)
                code = job.proc.wait()
                job.proc.stdout.close()
                if job.cancelled:
                    raise RuntimeError("cancelled")
                if code != 0 or not os.path.isfile(out):
                    said = [l for l in job.log if l.startswith("!! ")]
                    raise RuntimeError(said[-1][3:] if said else "the pose tracker failed: " + " | ".join(job.log[-3:]))
                with open(out, encoding="utf-8") as fh:
                    return json.load(fh)

        spawn(job, work)
        return web.json_response(job.view())

    async def lipsync_route(request):
        body = await body_of(request)
        try:
            src = media_src(body, SOUND_EXTS, "sound")
        except LookupError as e:
            return err(e, 404)
        except PermissionError as e:
            return err(e, 403)
        except ValueError as e:
            return err(e)
        try:
            fps = float(body.get("fps") or 24)
            start = float(body.get("start") or 0)
            seconds = float(body["seconds"]) if body.get("seconds") else None
            lead = int(body.get("lead") if body.get("lead") is not None else 1)
            smooth = float(body.get("smooth") if body.get("smooth") is not None else 1.0)
            strength = float(body.get("strength") or 1.0)
        except (TypeError, ValueError):
            return err("fps, start, seconds, lead, smooth and strength are numbers")
        if not 1 <= fps <= 240:
            return err("fps between 1 and 240")
        try:
            from . import lipsync
        except ImportError:  # pragma: no cover - run outside the package
            import lipsync
        try:
            out = await off(lipsync.from_file, src, fps, start=max(0.0, start), seconds=seconds,
                            lead=max(0, min(6, lead)), smooth=max(0.0, min(4.0, smooth)),
                            strength=max(0.1, min(2.0, strength)))
        except Exception as e:  # noqa: BLE001 - a file PyAV cannot read
            return err(f"the sound could not be read: {e}", 422)
        out["fps"] = fps
        out["name"] = os.path.basename(src)
        return web.json_response(out)

    async def job_state(request):
        job = jobs.get(request.query.get("job") or "")
        if not job:
            return err("no such job", 404)
        return web.json_response(job.view())

    async def job_cancel(request):
        body = await body_of(request)
        job = jobs.get(str(body.get("job") or ""))
        if not job:
            return err("no such job", 404)
        if body.get("cancel") and job.state == "running":
            job.cancelled = True
            if job.kind == "install":
                _kill_tree(job.proc)
            elif job.kind in ("autorig", "video_pose") and job.proc and job.proc.poll() is None:
                job.proc.kill()
            elif job.kind == "motion":
                kimodo.stop()
        return web.json_response(job.view())

    # ── the agent ─────────────────────────────────────────────────────────────
    # The rig lives in the page, so an agent's request is sent there and the page reports back.
    asks = {}

    async def agent(request):
        body = await body_of(request)
        action = body.get("action")
        if action not in AGENT_ACTIONS:
            return err(f"action is one of {', '.join(AGENT_ACTIONS)}")
        if send is None:
            return err("the viewer's page cannot be reached", 501)
        for old in [k for k, v in asks.items() if v["state"] in ("done", "error")][:max(0, len(asks) - 40)]:
            asks.pop(old, None)
        aid = secrets.token_hex(8)
        args = {k: v for k, v in body.items() if k != "action"}
        asks[aid] = {"id": aid, "action": action, "state": "sent", "sent": time.time()}
        send("imageviewer.rig.agent", {"id": aid, "action": action, "args": args})
        return web.json_response(asks[aid])

    async def agent_state(request):
        ask = asks.get(request.query.get("id") or "")
        if not ask:
            return err("no such request", 404)
        out = dict(ask)
        if out["state"] == "sent" and time.time() - out["sent"] > 30:
            out["note"] = "no page has taken it yet: is the viewer open on its 3D scene?"
        return web.json_response(out)

    async def agent_done(request):
        body = await body_of(request)
        ask = asks.get(str(body.get("id") or ""))
        if not ask:
            return err("no such request", 404)
        state = body.get("state")
        if state not in ("running", "done", "error"):
            return err("state is running, done or error")
        ask["state"] = state
        for k in ("result", "error", "progress"):
            if k in body:
                ask[k] = body[k]
        return web.json_response({"ok": True})

    for method, path, handler in (("POST", "rig/agent", agent), ("GET", "rig/agent", agent_state),
                                  ("POST", "rig/agent_done", agent_done)):
        add(method, f"/imageviewer/{path}", handler)
        add(method, f"/api/imageviewer/{path}", handler)

    for method, path, handler in (("POST", "rig/export", export), ("POST", "rig/read_motion", read_motion), ("GET", "rig/tools", tools), ("POST", "rig/install", install),
                                  ("POST", "rig/autorig", autorig), ("POST", "rig/motion", motion),
                                  ("POST", "rig/video_pose", video_pose), ("POST", "rig/lipsync", lipsync_route),
                                  ("GET", "rig/job", job_state), ("POST", "rig/job", job_cancel)):
        add(method, f"/imageviewer/{path}", handler)
        add(method, f"/api/imageviewer/{path}", handler)
    return {"jobs": jobs, "kimodo": kimodo}
