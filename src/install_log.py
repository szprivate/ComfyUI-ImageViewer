"""The install log: one place every install and download the viewer starts writes to, line by line.

The page opens its log window on one of these (js/imageViewer_installLog.js) and follows it while it runs,
so the user sees what pip, git and the model downloads print instead of a bar and a last line.

    GET  /imageviewer/install_log                 -> {logs: [{id, title, kind, state, started, lines}]}, newest first
    GET  /imageviewer/install_log?id=..&since=N   -> {id, title, kind, state, error?, log_file?, lines: [...],
                                                      next, dropped, can_stop}: the lines from N on
    POST /imageviewer/install_log {id, cancel: true} -> stops it (the same as the dialog's own Stop)

Who writes here: the rig tools' installer (rig_routes, install_rig_tools.py's output), the model downloads of
Paint / Comp AI workflows and SAM 3D Body (paint_generate._download_all).
"""

from __future__ import annotations

import secrets
import threading
import time
from collections import OrderedDict

MAX_LOGS = 20            # the last ones kept, the running ones never dropped
MAX_LINES = 5000         # each keeps its last lines; the file (where there is one) keeps all

_LOGS: "OrderedDict[str, Log]" = OrderedDict()
_LOCK = threading.Lock()


class Log:
    def __init__(self, title, kind, log_id=None):
        self.id = str(log_id) if log_id else secrets.token_hex(8)
        self.title = str(title)
        self.kind = str(kind)
        self.state = "running"
        self.error = None
        self.started = time.time()
        self.ended = None
        self.log_file = None
        self.stop = None          # a callable that stops what writes here, or None
        self._lines = []
        self._dropped = 0
        self._lock = threading.Lock()

    def say(self, line):
        """One or more lines (a trailing newline is dropped; a carriage return keeps the text after it)."""
        text = str(line).rstrip("\r\n")
        with self._lock:
            for part in text.split("\n"):
                part = part.rsplit("\r", 1)[-1].rstrip()
                self._lines.append(part)
            over = len(self._lines) - MAX_LINES
            if over > 0:
                del self._lines[:over]
                self._dropped += over

    def finish(self, state="done", error=None):
        if self.state != "running":
            return
        self.error = str(error) if error else None
        self.ended = time.time()
        self.state = state
        self.stop = None

    def lines_since(self, since=0):
        with self._lock:
            start = max(0, int(since) - self._dropped)
            return self._lines[start:], self._dropped + len(self._lines), self._dropped

    def view(self, since=0):
        lines, nxt, dropped = self.lines_since(since)
        out = {"id": self.id, "title": self.title, "kind": self.kind, "state": self.state,
               "started": self.started, "seconds": round((self.ended or time.time()) - self.started, 1),
               "lines": lines, "next": nxt, "dropped": dropped, "can_stop": self.state == "running" and self.stop is not None}
        if self.error:
            out["error"] = self.error
        if self.log_file:
            out["log_file"] = self.log_file
        return out

    def brief(self):
        with self._lock:
            n = self._dropped + len(self._lines)
        return {"id": self.id, "title": self.title, "kind": self.kind, "state": self.state,
                "started": self.started, "lines": n}


def new(title, kind, stop=None, log_id=None):
    """A new log, kept with the last MAX_LOGS (a running one is never dropped). *log_id*: the id of the job
    that writes to it, so the page that knows the job knows the log."""
    log = Log(title, kind, log_id)
    log.stop = stop
    with _LOCK:
        _LOGS[log.id] = log
        over = len(_LOGS) - MAX_LOGS
        for lid in [k for k, v in _LOGS.items() if v.state != "running"][:max(0, over)]:
            _LOGS.pop(lid, None)
    return log


def get(log_id):
    with _LOCK:
        return _LOGS.get(str(log_id or ""))


def listing():
    with _LOCK:
        return [v.brief() for v in reversed(_LOGS.values())]


def stop(log_id):
    """Stop what writes to the log: True when it had a way to."""
    log = get(log_id)
    if not log or log.state != "running" or not log.stop:
        return False
    try:
        log.stop()
    except Exception as e:  # noqa: BLE001 - said in the log
        log.say(f"!! could not stop: {e}")
        return False
    log.say("-- stop asked for --")
    return True


def register(add, *, web, path_access):
    async def h_get(request):
        lid = request.query.get("id")
        if not lid:
            return web.json_response({"logs": listing()})
        log = get(lid)
        if not log:
            return web.json_response({"error": "no such log"}, status=404)
        try:
            since = max(0, int(request.query.get("since") or 0))
        except ValueError:
            since = 0
        return web.json_response(log.view(since))

    async def h_post(request):
        ok, why = path_access.same_origin(request)
        if not ok:
            return web.Response(status=403, text=why)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "the body must be a JSON object"}, status=400)
        log = get(body.get("id"))
        if not log:
            return web.json_response({"error": "no such log"}, status=404)
        if body.get("cancel"):
            stop(log.id)
        return web.json_response(log.view(int(body.get("since") or 0) if str(body.get("since") or "0").isdigit() else 0))

    for method, h in (("GET", h_get), ("POST", h_post)):
        add(method, "/imageviewer/install_log", h)
        add(method, "/api/imageviewer/install_log", h)
