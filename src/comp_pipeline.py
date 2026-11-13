"""Keeping comps safe and their footage found: autosave and recovery, relinking Reads whose files moved,
localising network footage into a local cache, and the farm request (sent on to agentY's Deadline tools).

No aiohttp or ComfyUI in here (the routes are in ``comp_routes.py``).

Autosave: ``<user folder>/comp_autosave/<hash of the comp's path>.json`` = ``{path, time, comp}`` (the user folder
is ``~/.comfyui_image_viewer``, or ``IMAGE_VIEWER_COMP_AUTOSAVE`` names the autosave folder itself). It is written
while a comp has unsaved changes and removed when the comp is saved; one newer than the file is offered back when
the comp is opened (after a crash, or a tab closed without saving).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time

from . import comp_io
from . import comp_model as M

MAX_SEARCH_FILES = 200000
MAX_SEARCH_DEPTH = 10


# ── autosave ─────────────────────────────────────────────────────────────────

def autosave_dir():
    d = os.environ.get("IMAGE_VIEWER_COMP_AUTOSAVE")
    if not d:
        try:
            from . import legacy_names
            d = os.path.join(legacy_names.user_dir(), "comp_autosave")
        except Exception:  # noqa: BLE001 - outside the package
            d = os.path.join(os.path.expanduser("~"), ".comfyui_image_viewer", "comp_autosave")
    return d


def _key(path):
    return hashlib.sha1(os.path.normcase(os.path.abspath(path)).encode("utf-8")).hexdigest()[:20]


def autosave_path(path):
    return os.path.join(autosave_dir(), _key(path) + ".json")


def autosave(path, comp):
    """The page's unsaved comp kept for ``path`` (atomically). Returns the time it was kept."""
    M.normalize(comp)
    folder = autosave_dir()
    os.makedirs(folder, exist_ok=True)
    now = time.time()
    text = json.dumps({"path": os.path.abspath(path), "time": now, "comp": comp}, ensure_ascii=False)
    if len(text) > comp_io.MAX_BYTES:
        raise ValueError("the comp is too large")
    fd, tmp = tempfile.mkstemp(prefix=".autosave_", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, autosave_path(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return now


def drop_autosave(path):
    try:
        os.remove(autosave_path(path))
        return True
    except OSError:
        return False


def recovery(path):
    """``{time, comp}`` of an autosave of ``path`` newer than the file itself (or the file is gone), else None."""
    p = autosave_path(path)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or os.path.normcase(str(data.get("path"))) != os.path.normcase(os.path.abspath(path)):
        return None
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
    if float(data.get("time") or 0) <= mtime:
        return None
    try:
        comp = comp_io.upgrade(data.get("comp"))
        M.normalize(comp)
    except ValueError:
        return None
    return {"time": float(data["time"]), "comp": comp}


# ── relinking ────────────────────────────────────────────────────────────────

def missing_reads(comp, comp_path, sources):
    """The Reads whose footage is not there: ``[{id, name, file}]``."""
    out = []
    for n in comp.get("nodes") or []:
        if n.get("type") != "read" or not n.get("file"):
            continue
        _, info = sources.info({"file": n.get("file")})
        if info.get("kind") == "missing":
            out.append({"id": n["id"], "name": n.get("name") or n["id"], "file": n["file"]})
    return out


def _matcher(file):
    """A test of a file name against what a Read names: the same name, or (a sequence) the same name around a frame
    number of at least as many digits. Case does not matter (a Windows share)."""
    base = os.path.basename(str(file).replace("\\", "/"))
    m = comp_io._SEQ.search(base)
    if not m:
        low = base.lower()
        return (lambda name: name.lower() == low), None
    digits = int(m.group(2)) if m.group(2) else len(m.group(1))
    rx = re.compile(re.escape(base[:m.start()]) + r"\d{%d,}" % digits + re.escape(base[m.end():]) + "$", re.I)
    return rx.match, base


def search(folder, wants, *, max_files=MAX_SEARCH_FILES, max_depth=MAX_SEARCH_DEPTH, allow=None):
    """Find each wanted Read's file under ``folder``: ``{id: new path or pattern}`` (a sequence keeps its pattern,
    in the folder its frames are in). The nearest match (fewest folders down) wins. ``allow(dir)`` may refuse a folder."""
    tests = {w["id"]: _matcher(w["file"]) for w in wants}
    found, depth_of = {}, {}
    seen = 0
    root = os.path.abspath(folder)
    base_depth = root.rstrip(os.sep).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath.rstrip(os.sep).count(os.sep) - base_depth
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and depth < max_depth
                             and (allow is None or allow(os.path.join(dirpath, d))))
        for name in filenames:
            seen += 1
            if seen > max_files:
                return found
            for wid, (test, pattern) in tests.items():
                if (wid in found and depth_of[wid] <= depth) or not test(name):
                    continue
                found[wid] = os.path.join(dirpath, pattern if pattern else name)
                depth_of[wid] = depth
        if len(found) == len(tests) and all(d <= depth for d in depth_of.values()):
            break
    return found


def relative_or_absolute(path, comp_path, keep_relative=True):
    """A new Read path: relative to the comp's folder when it lies inside it (as a relative Read did), else absolute."""
    if keep_relative and comp_path:
        here = os.path.dirname(os.path.abspath(comp_path))
        try:
            rel = os.path.relpath(path, here)
        except ValueError:     # another drive
            return path
        if not rel.startswith(".."):
            return rel.replace("\\", "/")
    return path


# ── localising ───────────────────────────────────────────────────────────────

def footage_files(path, info):
    """Every file one Read's footage is (a sequence: each frame on disk)."""
    if info.get("kind") == "sequence":
        return [comp_io.frame_path(path, n) for n in comp_io.sequence_numbers(path)]
    if info.get("kind") in ("still", "video"):
        return [path]
    return []


def local_place(path, cache_dir):
    """Where a localised copy of ``path`` goes: ``<cache>/<hash of its folder>/<its name>`` (one folder per source
    folder, so two plates of one name from two shots do not meet)."""
    folder = os.path.dirname(os.path.abspath(path))
    tag = hashlib.sha1(os.path.normcase(folder).encode("utf-8")).hexdigest()[:10]
    return os.path.join(cache_dir, f"{os.path.basename(folder) or 'root'}_{tag}", os.path.basename(path))


def copy_newer(src, dst):
    """Copy when the copy is missing or differs in size / time; True when it copied."""
    try:
        s = os.stat(src)
        d = os.stat(dst)
        if d.st_size == s.st_size and abs(d.st_mtime - s.st_mtime) < 2:
            return False
    except OSError:
        pass
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)
    return True


def localise(comp, comp_path, sources, cache_dir, ids=None, *, progress=None, cancelled=None):
    """Copy the footage of the Reads (all, or ``ids``) into ``cache_dir``: ``{id: local path}`` for the page to set
    as each Read's ``local`` (its ``file`` stays the network path). Precomps and missing footage are skipped and named
    in ``skipped``."""
    jobs, skipped = [], []
    for n in comp.get("nodes") or []:
        if n.get("type") != "read" or not n.get("file") or (ids and n["id"] not in ids):
            continue
        path = comp_io.resolve_file(n["file"], comp_path)
        _, info = sources.info({"file": n["file"]})
        files = footage_files(path, info)
        if not files:
            skipped.append({"id": n["id"], "why": "a comp" if info.get("kind") == "comp" else info.get("kind", "missing")})
            continue
        jobs.append((n["id"], path, files))
    total = sum(len(f) for _, _, f in jobs)
    done = copied = 0
    out = {}
    for nid, path, files in jobs:
        for f in files:
            if cancelled and cancelled():
                raise InterruptedError
            if copy_newer(f, local_place(f, cache_dir)):
                copied += 1
            done += 1
            if progress:
                progress(done, total)
        out[nid] = local_place(path, cache_dir)
    return {"local": out, "skipped": skipped, "files": total, "copied": copied}


# ── the farm ─────────────────────────────────────────────────────────────────

def farm_request(plans, *, chunk=10, pool="", group="", priority=-1, name="", comp_path="", python="", script=""):
    """The body for agentY's ``/agentY/comp_farm`` (core's ``submit_comp``): one Deadline job over the union of the
    Writes' frames, as file-safe numbers (Deadline frames are the comp frames plus ``frame_offset``, never below 0),
    each task rendering its chunk of every Write through ``scripts/comp_render.py``."""
    if not plans:
        raise ValueError("no Write node to render")
    lo = min(p["frames"][0] for p in plans)
    hi = max(p["frames"][-1] for p in plans)
    offset = max(0, -lo)
    chunk = max(1, min(1000, int(chunk or 10)))
    return {"comp": os.path.abspath(comp_path), "writes": [p["id"] for p in plans],
            "frames": f"{lo + offset}-{hi + offset}", "frame_offset": offset, "chunk": chunk,
            "first": lo, "last": hi, "pool": str(pool or ""), "group": str(group or ""),
            "priority": int(priority if priority is not None else -1), "name": str(name or "") or os.path.basename(comp_path),
            "python": python, "script": script,
            "outputs": [os.path.dirname(p["pattern"]) for p in plans]}


_LOCAL_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")


def farm_warnings(comp, comp_path, plans, sources):
    """What would break on another machine: the comp, its footage or its outputs on a path only this one has
    (a drive letter is taken as local unless it is a mapped network drive the farm also maps - said, not refused)."""
    out = []

    def local(p):
        p = str(p or "")
        return p.startswith(("/tmp/", "/home/", "/Users/")) or (_LOCAL_DRIVE.match(p) and p[:1].upper() == "C")
    if local(comp_path):
        out.append(f"the comp is on this machine's own disk ({comp_path}): the farm cannot read it")
    for n in comp.get("nodes") or []:
        if n.get("type") == "read" and n.get("file"):
            p, _ = sources.info({"file": n["file"]})
            if local(p):
                out.append(f"{n.get('name') or n['id']}: {os.path.basename(p)} is on this machine's own disk")
    for p in plans:
        if local(p["pattern"]):
            out.append(f"{p['name']} writes to this machine's own disk ({os.path.dirname(p['pattern'])})")
    return out
