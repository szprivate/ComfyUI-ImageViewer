"""LoRA datasets and training runs for the Dataset panel (bEpicViewer_loraPanel.js).

The formats are the contract in agentY-core (``agenty_core/tools/lora_training/formats.py``): a dataset
folder ``<ComfyUI output>/agent/lora_datasets/<name>`` (manifest.json, review.json, items/) and a run
folder ``agent/lora_runs/<job>`` (job.json, progress.json, events.jsonl, samples.json, control.json,
train.log). The viewer reads and edits those files; the agent's tools and the trainer read them too.

This side only guards the files: only the two folders above are touched, names are plain slugs (no path
parts), files are written whole or not at all, and the manifest hash is computed exactly as agenty_core
does it (``manifest_sha``; tests/test_lora_io.py pins a fixed vector so the two cannot drift).
No aiohttp or ComfyUI in here, so it can be tested on its own.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time

MAX_BYTES = 8 * 1024 * 1024
LOG_TAIL_LINES = 60
EVENTS_CAP = 200
NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$")
SERVE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".mp4", ".webm", ".mov", ".mkv"}
BUSY = ("training",)
ACTIONS = ("approve", "ask", "cancel")


class LoraError(Exception):
    """Something to tell the user, with the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --- folders -----------------------------------------------------------------

def agent_root(output_dir: str) -> str:
    return os.path.join(os.path.abspath(output_dir), "agent")


def datasets_root(output_dir: str) -> str:
    return os.path.join(agent_root(output_dir), "lora_datasets")


def runs_root(output_dir: str) -> str:
    return os.path.join(agent_root(output_dir), "lora_runs")


def check_name(name) -> str:
    n = str(name or "").strip()
    if not NAME_RE.match(n) or ".." in n:
        raise LoraError("bad name", 400)
    return n


def _dataset_dir(output_dir: str, name) -> str:
    d = os.path.join(datasets_root(output_dir), check_name(name))
    if not os.path.isfile(os.path.join(d, "manifest.json")):
        raise LoraError(f"no LoRA dataset '{name}'", 404)
    return d


def _run_dir(output_dir: str, name) -> str:
    d = os.path.join(runs_root(output_dir), check_name(name))
    if not os.path.isdir(d):
        raise LoraError(f"no training run '{name}'", 404)
    return d


def dataset_name_of_path(path, output_dir: str) -> str | None:
    """The dataset name when ``path`` is ``.../lora_datasets/<name>/manifest.json`` under the output folder."""
    if not isinstance(path, str) or os.path.basename(path).lower() != "manifest.json":
        return None
    p = os.path.abspath(path)
    if not _inside(p, datasets_root(output_dir)):
        return None
    # Compare the resolved spellings: an agent may name the same folder by its UNC path while ComfyUI
    # knows it as a mapped drive (W:), and relpath raises ValueError across the two spellings.
    try:
        rel = os.path.relpath(os.path.realpath(p), os.path.realpath(datasets_root(output_dir))).replace("\\", "/").split("/")
    except ValueError:
        return None
    if len(rel) != 2 or not NAME_RE.match(rel[0]) or not os.path.isfile(p):
        return None
    return rel[0]


def _inside(path: str, root: str) -> bool:
    try:
        a, b = os.path.realpath(path), os.path.realpath(root)
        return os.path.commonpath([os.path.normcase(a), os.path.normcase(b)]) == os.path.normcase(b)
    except ValueError:
        return False


def resolve_file(output_dir: str, raw) -> str:
    """The absolute path of a thumbnail / sample the panel may show: a media file inside one of the two
    folders (given absolute, or relative to the agent folder). Anything else is refused."""
    if not isinstance(raw, str) or not raw.strip() or "\0" in raw:
        raise LoraError("no path", 400)
    p = raw.strip().strip('"')
    p = p if os.path.isabs(p) else os.path.join(agent_root(output_dir), p)
    p = os.path.abspath(p)
    if not (_inside(p, datasets_root(output_dir)) or _inside(p, runs_root(output_dir))):
        raise LoraError("this folder is not a LoRA dataset or run folder", 403)
    if os.path.splitext(p)[1].lower() not in SERVE_EXTS:
        raise LoraError("not a picture or clip", 403)
    if not os.path.isfile(p):
        raise LoraError("file not found", 404)
    return p


# --- json --------------------------------------------------------------------

def read_json(path, default=None):
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return default
        with open(path, "r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, data) -> None:
    """Atomic: a reader (the agent, the trainer, the panel's poll) never sees half a file."""
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(data, indent=1, ensure_ascii=False))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --- the contract's hash and summary (ported from agenty_core formats.py) ------

def manifest_sha(manifest: dict) -> str:
    """Hash of what training would see: trigger word, model and every included item's file, caption and crop.
    Same bytes as agenty_core.tools.lora_training.formats.manifest_sha."""
    core = {"trigger_word": manifest.get("trigger_word", ""), "model": manifest.get("model", ""),
            "items": [[i.get("file"), i.get("caption", ""), i.get("crop")]
                      for i in manifest.get("items", []) if i.get("included", True)]}
    return hashlib.sha256(json.dumps(core, sort_keys=True).encode("utf-8")).hexdigest()


def summarize(manifest: dict) -> dict:
    items = manifest.get("items", [])
    inc = [i for i in items if i.get("included", True)]
    manifest.setdefault("summary", {})
    if not isinstance(manifest["summary"], dict):
        manifest["summary"] = {}
    manifest["summary"].update(count=len(items), included=len(inc), removed=len(items) - len(inc))
    return manifest


def load_review(ds: str) -> dict:
    r = read_json(os.path.join(ds, "review.json"), {"state": "none"})
    return r if isinstance(r, dict) and r else {"state": "none"}


def _load_manifest(ds: str) -> dict:
    m = read_json(os.path.join(ds, "manifest.json"))
    if not isinstance(m, dict) or not isinstance(m.get("items"), list):
        raise LoraError("manifest.json is missing or not a dataset manifest", 422)
    return m


def _save_manifest(ds: str, manifest: dict) -> None:
    summarize(manifest)
    write_json(os.path.join(ds, "manifest.json"), manifest)


# --- datasets ----------------------------------------------------------------

def list_datasets(output_dir: str) -> list:
    root = datasets_root(output_dir)
    out = []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return out
    for n in names:
        ds = os.path.join(root, n)
        mp = os.path.join(ds, "manifest.json")
        if not NAME_RE.match(n) or not os.path.isfile(mp):
            continue
        m = read_json(mp)
        if not isinstance(m, dict) or not isinstance(m.get("items"), list):
            continue
        s = summarize(dict(m, summary=dict(m.get("summary") or {})))["summary"]
        cover = next((i.get("file") for i in m["items"] if i.get("included", True) and i.get("file")), None)
        out.append({"name": n, "dir": ds, "manifest_path": mp, "subject": m.get("subject", ""),
                    "kind": m.get("kind", ""), "model": m.get("model", ""), "status": m.get("status", "draft"),
                    "trigger_word": m.get("trigger_word", ""), "count": s["count"], "included": s["included"],
                    "removed": s["removed"], "review": load_review(ds).get("state", "none"),
                    "cover": os.path.join(ds, cover) if cover else None,
                    "updated": os.path.getmtime(mp)})
    out.sort(key=lambda d: d["updated"], reverse=True)
    return out


def get_dataset(output_dir: str, name) -> dict:
    ds = _dataset_dir(output_dir, name)
    m = _load_manifest(ds)
    return {"name": os.path.basename(ds), "dir": ds, "manifest_path": os.path.join(ds, "manifest.json"),
            "manifest": summarize(m), "review": load_review(ds), "sha": manifest_sha(m)}


def _merge_manifest(disk: dict, client: dict) -> dict:
    """What the panel sent, over what is on disk: keys the panel does not know stay, and so do an item's."""
    if not isinstance(client, dict) or not isinstance(client.get("items"), list):
        raise LoraError("the manifest needs an items list", 422)
    for it in client["items"]:
        if not isinstance(it, dict) or not isinstance(it.get("file"), str) or not it["file"]:
            raise LoraError("every item needs a file", 422)
        f = it["file"].replace("\\", "/")
        if f.startswith("/") or ".." in f.split("/") or re.match(r"^[A-Za-z]:", f):
            raise LoraError("an item's file must be inside the dataset folder", 422)
    by_id = {i.get("id"): i for i in disk.get("items", []) if isinstance(i, dict) and i.get("id")}
    new = dict(disk)
    for k, v in client.items():
        if k in ("status", "approved_at", "name", "version", "created", "summary"):
            continue                       # the server's (or the agent's), not the panel's
        new[k] = v
    new["items"] = [dict(by_id.get(it.get("id"), {}), **it) if it.get("id") in by_id else it
                    for it in client["items"]]
    if isinstance(client.get("summary"), dict):
        new["summary"] = dict(disk.get("summary") or {}, **{k: v for k, v in client["summary"].items()
                                                              if k == "warnings"})
    return new


def _guard_busy(m: dict) -> None:
    if m.get("status") in BUSY:
        raise LoraError("this dataset is being trained on right now; it cannot be edited", 409)


def _write_review(ds: str, state: str, note: str, sha: str | None = None) -> dict:
    old = load_review(ds)
    now = time.time()
    r = {"state": state, "requested": old.get("requested", now), "updated": now, "note": note, "by": "viewer"}
    if sha:
        r["manifest_sha"] = sha
    write_json(os.path.join(ds, "review.json"), r)
    return r


def save_dataset(output_dir: str, name, client_manifest) -> dict:
    """Write the panel's manifest. When it differs (as training would see it) from what was approved, the
    approval is void: review goes back to ``pending`` and the status to ``review``."""
    ds = _dataset_dir(output_dir, name)
    disk = _load_manifest(ds)
    _guard_busy(disk)
    new = _merge_manifest(disk, client_manifest)
    review = load_review(ds)
    reset = False
    if review.get("state") == "approved" or disk.get("status") == "approved":
        if review.get("state") != "approved" or manifest_sha(new) != review.get("manifest_sha"):
            reset = True
    if reset:
        new["status"], new["approved_at"] = "review", None
        review = _write_review(ds, "pending", "edited after approval; it needs a new approval")
    _save_manifest(ds, new)
    return {"ok": True, "manifest": new, "review": review, "sha": manifest_sha(new), "reset_approval": reset}


def review_dataset(output_dir: str, name, action, note="", client_manifest=None) -> dict:
    """approve | ask | cancel. Returns {ok, state, review, message}; ``message`` is the short text the panel
    sends to agentY (when it runs) so the agent carries on."""
    if action not in ACTIONS:
        raise LoraError("action is approve, ask or cancel", 400)
    ds = _dataset_dir(output_dir, name)
    nm = os.path.basename(ds)
    note = " ".join(str(note or "").split())[:2000]
    if client_manifest is not None:
        saved = save_dataset(output_dir, name, client_manifest)
        manifest = saved["manifest"]
    else:
        manifest = _load_manifest(ds)
        _guard_busy(manifest)
    if action == "approve":
        if not any(i.get("included", True) for i in manifest["items"]):
            raise LoraError("nothing is included: a dataset needs at least one item to train on", 422)
        r = _write_review(ds, "approved", note, manifest_sha(manifest))
        manifest["status"], manifest["approved_at"] = "approved", r["updated"]
        msg = f"LoRA dataset {nm} approved in the viewer, start training."
        if note:
            msg += f" Note: {note}"
    elif action == "ask":
        if not note:
            raise LoraError("write the note the agent should read", 422)
        r = _write_review(ds, "changes", note)
        manifest["status"], manifest["approved_at"] = "review", None
        msg = f"LoRA dataset {nm}: changes wanted in the viewer. {note}"
    else:
        r = _write_review(ds, "cancelled", note)
        manifest["status"], manifest["approved_at"] = "cancelled", None
        msg = f"LoRA dataset {nm} cancelled in the viewer, do not train it."
        if note:
            msg += f" Note: {note}"
    _save_manifest(ds, manifest)
    return {"ok": True, "state": r["state"], "review": r, "manifest": manifest, "message": msg}


# --- runs --------------------------------------------------------------------

def _tail(path: str, lines: int = LOG_TAIL_LINES) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 96 * 1024))
            data = fh.read()
    except OSError:
        return ""
    text = data.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(text.rstrip("\n").split("\n")[-lines:])


def _events(run: str) -> list:
    out = []
    try:
        with open(os.path.join(run, "events.jsonl"), "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict):
                    out.append(e)
    except OSError:
        pass
    return out[-EVENTS_CAP:]


def list_runs(output_dir: str) -> list:
    root = runs_root(output_dir)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    out = []
    for n in names:
        run = os.path.join(root, n)
        if not NAME_RE.match(n) or not os.path.isdir(run):
            continue
        p = read_json(os.path.join(run, "progress.json"), {}) or {}
        job = read_json(os.path.join(run, "job.json"), {}) or {}
        try:
            mt = max(os.path.getmtime(os.path.join(run, f)) for f in os.listdir(run)) if os.listdir(run) else os.path.getmtime(run)
        except OSError:
            mt = 0
        out.append({"name": n, "status": p.get("status") or job.get("status") or "starting",
                    "step": p.get("step", 0), "total": p.get("total", job.get("steps", 0)),
                    "pct": p.get("pct", 0), "dataset": p.get("dataset") or job.get("dataset", ""),
                    "model": p.get("model") or job.get("model", ""), "updated": p.get("updated") or mt})
    out.sort(key=lambda r: r["updated"] or 0, reverse=True)
    return out


def get_run(output_dir: str, name) -> dict:
    run = _run_dir(output_dir, name)
    samples = read_json(os.path.join(run, "samples.json"), []) or []
    if not isinstance(samples, list):
        samples = []
    for s in samples:
        if isinstance(s, dict):
            for f in s.get("files") or []:
                if isinstance(f, dict) and isinstance(f.get("file"), str):
                    f["path"] = os.path.join(run, f["file"])
    return {"name": os.path.basename(run), "dir": run,
            "progress": read_json(os.path.join(run, "progress.json"), {}) or {},
            "job": read_json(os.path.join(run, "job.json"), {}) or {},
            "result": read_json(os.path.join(run, "result.json"), None),
            "control": read_json(os.path.join(run, "control.json"), None),
            "samples": samples, "events": _events(run),
            "log_tail": _tail(os.path.join(run, "train.log"))}


def control_run(output_dir: str, name, action, keep=False) -> dict:
    if action != "stop":
        raise LoraError("action is stop", 400)
    run = _run_dir(output_dir, name)
    status = (read_json(os.path.join(run, "progress.json"), {}) or {}).get("status", "starting")
    if status in ("done", "failed", "stopped"):
        raise LoraError(f"this run already ended ({status})", 409)
    ctl = {"action": "stop", "keep": bool(keep), "t": time.time(), "by": "viewer"}
    write_json(os.path.join(run, "control.json"), ctl)
    return {"ok": True, "control": ctl}
