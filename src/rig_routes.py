"""Character rigs: export, auto-rigging and AI motion for the 3D space.

    POST /imageviewer/rig/export        multipart: a "meta" JSON part + binary parts it names
                                        ({format: fbx|abc, name, context, ...} + rig_export.parse_payload)
                                        -> {ok, path, relative, version}: by the export rule (kind "character")
    GET  /imageviewer/rig/tools         -> {unirig: {ready, why}, kimodo: {ready, why, model}}
    POST /imageviewer/rig/autorig       {src, name?, context?, seed?} -> {job}: UniRig on the model's file;
                                        the job's result is {path, relative}, a skinned .glb by the export rule
    POST /imageviewer/rig/motion        {mode: text|inbetween, prompt, frames, keys?, seed?, steps?, samples?,
                                        heading?} -> {job}: Kimodo; the result is the motion on its own
                                        skeleton (scripts/rig/kimodo_run.py), retargeted in the page
    GET  /imageviewer/rig/job?job=      -> {state: running|done|error|cancelled, log, result?, error?}
    POST /imageviewer/rig/job           {job, cancel: true}

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
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import atexit
import urllib.parse

from . import rig_export

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts", "rig")
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
                           ("kimodo", "python", "IMAGE_VIEWER_KIMODO_PYTHON"), ("kimodo", "model", "IMAGE_VIEWER_KIMODO_MODEL")):
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
    return out


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

    def say(self, line):
        line = str(line).rstrip()
        if line:
            self.log.append(line)
            del self.log[:-LOG_LINES]

    def view(self):
        out = {"job": self.id, "kind": self.kind, "state": self.state, "log": self.log[-12:],
               "seconds": round(time.time() - self.started, 1)}
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
                        raise RuntimeError(msg["error"])
                    if msg.get("done"):
                        return
                    continue
                job.say(line)
                if job.cancelled:
                    break
            if job.cancelled:
                self.stop()
                raise RuntimeError("cancelled")
            raise RuntimeError("Kimodo stopped: " + " | ".join(job.log[-4:]))

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


def register(add, *, web, path_access, export_rules, folder_paths, resolve=None):
    """Add the routes through ``add(method, path, handler)``; each under /imageviewer and /api/imageviewer."""
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
        if fmt not in ("fbx", "abc"):
            return err(f"unknown format {fmt}")
        try:
            data = rig_export.parse_payload(meta, blobs)
            where = export_rules.target("character", meta.get("name") or "character", fmt,
                                        folder_paths.get_output_directory(), meta.get("context"))
        except (ValueError, KeyError) as e:
            return err(e)
        os.makedirs(os.path.dirname(where["path"]), exist_ok=True)
        try:
            await off(rig_export.write_fbx if fmt == "fbx" else rig_export.write_abc, where["path"], data)
        except Exception as e:  # noqa: BLE001
            return err(f"could not write the {fmt.upper()}: {e}", 500)
        return web.json_response({"ok": True, "path": where["path"], "relative": relative(where["path"]),
                                  "version": where.get("version"), "name": os.path.basename(where["path"])})

    # ── the tools ────────────────────────────────────────────────────────────

    async def tools(request):
        return web.json_response(tool_status())

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

        def work():
            os.makedirs(os.path.dirname(where["path"]), exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="unirig_") as tmp:
                cmd = [cfg["python"], "-u", os.path.join(SCRIPTS, "unirig_run.py"), "--repo", cfg["repo"],
                       "--input", src, "--output", where["path"], "--work", tmp, "--seed", str(seed)]
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
                    raise RuntimeError("UniRig failed: " + " | ".join(job.log[-4:]))
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
        if mode not in ("text", "inbetween"):
            return err("mode is text or inbetween")
        try:
            frames = int(body.get("frames") or 0)
        except (TypeError, ValueError):
            frames = 0
        if not 8 <= frames <= 30 * 60:
            return err("frames: between 8 and 1800 (Kimodo works at 30 fps)")
        if mode == "inbetween" and not body.get("keys"):
            return err("an in-between needs the keyed poses")
        try:
            steps, samples = int(body.get("steps") or 100), int(body.get("samples") or 1)
            heading = float(body.get("heading") or 0.0)
        except (TypeError, ValueError):
            return err("steps, samples and heading are numbers")
        request_doc = {
            "prompt": str(body.get("prompt") or ("A person moves naturally." if mode == "inbetween" else "")).strip(),
            "frames": frames,
            "keys": body.get("keys") or [],
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
            if job.kind == "autorig" and job.proc and job.proc.poll() is None:
                job.proc.kill()
            elif job.kind == "motion":
                kimodo.stop()
        return web.json_response(job.view())

    for method, path, handler in (("POST", "rig/export", export), ("GET", "rig/tools", tools),
                                  ("POST", "rig/autorig", autorig), ("POST", "rig/motion", motion),
                                  ("GET", "rig/job", job_state), ("POST", "rig/job", job_cancel)):
        add(method, f"/imageviewer/{path}", handler)
        add(method, f"/api/imageviewer/{path}", handler)
    return {"jobs": jobs, "kimodo": kimodo}
