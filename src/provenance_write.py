"""Provenance for what ImageViewerSend saves: the graph that made a file, kept beside it.

agentY's "recreate these shots with changes" re-runs the graph that made a shot, so a
file has to say how it was made. A file written by a run of the viewer's Send node
(a temp PNG the viewer shows, or the files "save to output" writes) gets, in the folder
``agent_metadata`` beside it (the agentY format, version 1 - the same as
agenty_core.utils.provenance, which reads it):

* ``agent_metadata/<name>.agenty.json`` - the sidecar; only the key ``"provenance"`` is
  set in it (what else it holds stays), written to a file beside it and moved over;
* ``agent_metadata/<name>.prov.json.gz`` - gzip of ``{"v": 1, "prompt": <API graph>,
  "workflow": <UI workflow or null>}``.

A file that already has an old sidecar right next to it (before 1.18) keeps that one.

Secrets are never stored. Any input / widget whose NAME says it is a credential
(api key, token, secret, password, auth, credential) with a text value, and any text
that has the shape of a key (``sk-``, ``sk-ant-``, ``hf_``, ``ghp_``, ``AIza``, ``Bearer``,
``xox?-`` ...), is replaced by ``"<redacted>"`` before anything is written. ComfyUI's
``extra_data`` is never read.

Best effort: nothing in here raises into the node.
"""
import copy
import gzip
import hashlib
import json
import os
import re
import tempfile
import time

VERSION = 1
SOURCE = "ImageViewerSend"
SIDECAR_SUFFIX = ".agenty.json"
GRAPH_SUFFIX = ".prov.json.gz"
META_DIR = "agent_metadata"
REDACTED = "<redacted>"
MAX_FILES = 512            # a sequence of hundreds of frames is annotated up to here

_SECRET_NAME = re.compile(r"(?i)(api[_-]?key|token|secret|password|passwd|auth|credential)")
_SHAPES = [
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bsk-(?:proj-|or-v1-|live_)?[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bhf_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{30,}"),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bxapp-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
]
_BEARER = re.compile(r"(\b(?:Bearer|Token)\s+)([A-Za-z0-9._~+/=\-]{16,})", re.I)
_MODEL_INPUT = re.compile(r"(?i)(ckpt_name|unet_name|vae_name|lora_name|clip_name\d*|control_?net_name|"
                          r"upscale_model_name|model_name)$")
_SEED_INPUT = re.compile(r"(?i)^(seed|noise_seed)$")


# ── redaction ────────────────────────────────────────────────────────────────

def scrub_text(text):
    """*text* with anything that has the shape of a credential replaced."""
    for pat in _SHAPES:
        text = pat.sub(REDACTED, text)
    return _BEARER.sub(lambda m: m.group(1) + REDACTED, text)


def _walk(obj, name=""):
    if isinstance(obj, dict):
        return {k: _walk(v, str(k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_walk(v, name) for v in obj]
    if isinstance(obj, str):
        if name and obj and _SECRET_NAME.search(name):
            return REDACTED
        return scrub_text(obj)
    return obj


def secret_nodes(prompt):
    """The ids of the nodes of an API graph that have a credential-named text input."""
    out = set()
    for nid, node in (prompt or {}).items():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if isinstance(inputs, dict) and any(_SECRET_NAME.search(str(k)) and isinstance(v, str) and v
                                            for k, v in inputs.items()):
            out.add(str(nid))
    return out


def redact_prompt(prompt):
    """A deep copy of an API graph with every secret masked."""
    return _walk(copy.deepcopy(prompt)) if isinstance(prompt, dict) else {}


def redact_workflow(workflow, secret_ids=()):
    """A deep copy of a UI workflow with every secret masked. A workflow keeps its widget
    values as a bare list, so a node that has a credential-named widget (or whose API
    inputs did: *secret_ids*) gets every text widget value masked."""
    if not isinstance(workflow, dict):
        return None
    wf = _walk(copy.deepcopy(workflow))
    for node in wf.get("nodes") or []:
        if not isinstance(node, dict) or not isinstance(node.get("widgets_values"), list):
            continue
        names = [str(i.get("widget", {}).get("name", "") or i.get("name", ""))
                 for i in node.get("inputs") or [] if isinstance(i, dict)]
        if str(node.get("id")) in secret_ids or any(_SECRET_NAME.search(n) for n in names):
            node["widgets_values"] = [REDACTED if isinstance(x, str) and x else x for x in node["widgets_values"]]
    return wf


def graph_sha1(prompt):
    text = json.dumps(prompt, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


# ── what the graph says ──────────────────────────────────────────────────────

def _is_link(v):
    return (isinstance(v, (list, tuple)) and len(v) == 2 and isinstance(v[1], int)
            and not isinstance(v[0], bool) and isinstance(v[0], (str, int)))


def summarize(prompt):
    """``(models, seeds)`` of an API graph: ``{"node", "input", "value"}`` each."""
    models, seeds = [], []
    for nid, node in (prompt or {}).items():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        for name, v in inputs.items():
            if _is_link(v):
                continue
            if isinstance(v, str) and _MODEL_INPUT.search(str(name)):
                models.append({"node": str(nid), "input": str(name), "value": v})
            elif _SEED_INPUT.match(str(name)) and isinstance(v, int) and not isinstance(v, bool):
                seeds.append({"node": str(nid), "input": str(name), "value": v})
    return models[:64], seeds[:64]


def _comfyui_version():
    try:
        import comfyui_version
        return str(getattr(comfyui_version, "__version__", "") or "")
    except Exception:  # noqa: BLE001 - not ComfyUI, or an old one
        return ""


# ── writing ──────────────────────────────────────────────────────────────────

def record_paths(path):
    """(sidecar, graph) of the file *path*: in ``agent_metadata`` beside it, or right next
    to it when the file still has an old sidecar or graph there."""
    old_sc, old_g = path + SIDECAR_SUFFIX, path + GRAPH_SUFFIX
    if os.path.isfile(old_sc) or os.path.isfile(old_g):
        return old_sc, old_g
    base = os.path.join(os.path.dirname(path), META_DIR, os.path.basename(path))
    return base + SIDECAR_SUFFIX, base + GRAPH_SUFFIX


def _atomic_write(target, data):
    folder = os.path.dirname(target) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(target) + ".", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _existing(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def annotate(paths, unique_id, prompt, extra_pnginfo, prompt_id=""):
    """Write the provenance beside each of *paths* (the files this node made, in order -
    a file's place in the list is its ``output_index``; *prompt_id*: the run). Returns how many were written.
    Never raises."""
    try:
        if not isinstance(prompt, dict) or not prompt:
            return 0
        files = []
        for p in paths or []:
            p = str(p or "")
            if p and p not in files and os.path.isfile(p):
                files.append(p)
        if not files:
            return 0
        red = redact_prompt(prompt)
        workflow = extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
        ui = redact_workflow(workflow, secret_nodes(prompt))
        blob = gzip.compress(json.dumps({"v": VERSION, "prompt": red, "workflow": ui}, ensure_ascii=False,
                                        separators=(",", ":")).encode("utf-8"), 6, mtime=0)
        sha = graph_sha1(red)
        models, seeds = summarize(red)
        pid = str(prompt_id or "")
        version = _comfyui_version()
        created = time.strftime("%Y-%m-%dT%H:%M:%S")
        done = 0
        for index, path in enumerate(files[:MAX_FILES]):
            try:
                sidecar, graph = record_paths(path)
                _atomic_write(graph, blob)
                doc = _existing(sidecar)
                doc["provenance"] = {
                    "v": VERSION, "source": SOURCE, "prompt_id": pid,
                    "output_node": str(unique_id if unique_id is not None else ""), "output_index": index,
                    "workflow_file": "", "comfyui_version": version, "created": created,
                    "graph_file": os.path.basename(graph), "graph_sha1": sha,
                    "models": models, "seeds": seeds, "partner": [],
                }
                _atomic_write(sidecar, json.dumps(doc, ensure_ascii=False, indent=1).encode("utf-8"))
                done += 1
            except Exception:  # noqa: BLE001 - one file that cannot be annotated does not stop the others
                continue
        return done
    except Exception:  # noqa: BLE001 - provenance is never worth failing a run
        return 0


# ── off the node's thread ────────────────────────────────────────────────────

import threading

_PENDING = []
_PENDING_LOCK = threading.Lock()


def annotate_async(paths, unique_id, prompt, extra_pnginfo, prompt_id=""):
    """:func:`annotate` on a background thread, so a slow output folder (a network share)
    never holds up the run. The graph is copied first: the caller may change it after.
    Returns the thread (or None when there is nothing to write)."""
    try:
        if not isinstance(prompt, dict) or not prompt or not paths:
            return None
        args = (list(paths), unique_id, copy.deepcopy(prompt),
                copy.deepcopy(extra_pnginfo) if isinstance(extra_pnginfo, dict) else None, prompt_id)
    except Exception:  # noqa: BLE001
        return None

    def run():
        try:
            annotate(*args)
        except Exception as e:  # noqa: BLE001 - provenance is never worth failing a run
            print(f"[ImageViewerSend] provenance not written: {e}")
        finally:
            with _PENDING_LOCK:
                if t in _PENDING:
                    _PENDING.remove(t)

    t = threading.Thread(target=run, name="ImageViewer-provenance", daemon=True)
    with _PENDING_LOCK:
        _PENDING.append(t)
    t.start()
    return t


def wait(timeout=30.0):
    """Wait for the background writes started so far (tests, shutdown)."""
    with _PENDING_LOCK:
        pending = list(_PENDING)
    for t in pending:
        t.join(timeout)
