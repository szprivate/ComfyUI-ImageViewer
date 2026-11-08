"""How a file was made, read back: the graph kept with it or inside it.

The read side of agentY-core's ``agenty_core.utils.provenance``, for the Dependencies tab
(``deps_graph.py``), so the tab works in plain ComfyUI without the agentY host. Same files, same
rules, in this order:

* the sidecar ``agent_metadata/<name>.agenty.json`` (or the old one right beside the file) and the
  ``.prov.json.gz`` it names - what the Send node (``provenance_write.py``) and agentY write;
* the graph EMBEDDED in the file: a PNG's text chunks (ComfyUI's Save Image), a video's container
  tags (Save Video, VHS Video Combine) - read through PyAV, a ComfyUI dependency, never by starting
  a program (no route may start a process on the host);

and the writing of a sidecar key (``write_json``), atomically, in the same format.

Also :func:`param_index`, the prompt part of agentY-core's ``tools.regenerate.param_index``: the
prompts a graph was made with, found through the samplers' positive / negative links.

``tests/test_deps_parity.py`` compares this with agentY-core's on the same files, when agentY-core
is importable: change one, change the other. Secrets are masked as the Send node masks them
(``provenance_write.redact_prompt``) before anything leaves here.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import struct
import tempfile
import threading
import zlib
from pathlib import Path

try:
    from . import provenance_write as _pw
except ImportError:  # loaded on its own (tests)
    import provenance_write as _pw  # type: ignore[no-redef]

SIDECAR_SUFFIX = ".agenty.json"
GRAPH_SUFFIX = ".prov.json.gz"
META_DIR = "agent_metadata"
_MODEL_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".bin", ".sft")
_PNG_SIG = b"\x89PNG\r\n\x1a\n"

#: Held while a sidecar is read, changed and written back (agentY holds its own in its process).
SIDECAR_LOCK = threading.RLock()


def redact_graph(graph: dict) -> dict:
    """A deep copy of an API graph (or a UI workflow) with every secret masked."""
    if not isinstance(graph, dict):
        return {}
    if "nodes" in graph and "links" in graph:
        return _pw.redact_workflow(graph) or {}
    return _pw.redact_prompt(graph)


def _is_link(v) -> bool:
    return (isinstance(v, (list, tuple)) and len(v) == 2 and isinstance(v[1], int)
            and not isinstance(v[0], bool) and isinstance(v[0], (str, int)))


def _scalar(v) -> bool:
    return isinstance(v, (str, int, float, bool)) or v is None


def _nodes(graph: dict):
    for nid, node in (graph or {}).items():
        if isinstance(node, dict) and node.get("class_type"):
            yield str(nid), node, (node.get("inputs") or {})


# ── where the record is ──────────────────────────────────────────────────────

def _beside(path, suffix: str) -> Path:
    return Path(str(path) + suffix)


def _in_meta(path, suffix: str) -> Path:
    p = Path(str(path))
    return p.parent / META_DIR / (p.name + suffix)


def sidecar_path(path) -> Path:
    """``agent_metadata/<name>.agenty.json``, or the old one right beside the file when that exists."""
    old = _beside(path, SIDECAR_SUFFIX)
    return old if old.is_file() else _in_meta(path, SIDECAR_SUFFIX)


def graph_path(path) -> Path:
    old = _beside(path, GRAPH_SUFFIX)
    if old.is_file() or _beside(path, SIDECAR_SUFFIX).is_file():
        return old
    return _in_meta(path, GRAPH_SUFFIX)


def graph_file_of(path, prov: dict | None = None) -> Path:
    p = Path(str(path))
    name = str((prov or {}).get("graph_file") or "")
    if name:
        for d in (sidecar_path(p).parent, p.parent, p.parent / META_DIR):
            if (d / name).is_file():
                return d / name
    return graph_path(p)


def _atomic_write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(target: Path, doc) -> None:
    _atomic_write(Path(target), json.dumps(doc, ensure_ascii=False, indent=1).encode("utf-8"))


def _read_json(p: Path):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_sidecar(path) -> dict:
    sc = sidecar_path(path)
    doc = _read_json(sc) if sc.is_file() else None
    return doc if isinstance(doc, dict) else {}


# ── the graph inside the file ────────────────────────────────────────────────

def png_text_chunks(path) -> dict:
    """``{keyword: text}`` of a PNG's tEXt / zTXt / iTXt chunks ({} when none / not a PNG)."""
    out: dict = {}
    try:
        with open(path, "rb") as f:
            if f.read(8) != _PNG_SIG:
                return {}
            while True:
                head = f.read(8)
                if len(head) < 8:
                    break
                length, ctype = struct.unpack(">I4s", head)
                if ctype in (b"tEXt", b"zTXt", b"iTXt"):
                    if length > 64 * 1024 * 1024:
                        break
                    data = f.read(length)
                    f.read(4)
                    try:
                        if ctype == b"tEXt":
                            k, _, v = data.partition(b"\x00")
                            out[k.decode("latin-1")] = v.decode("utf-8", "replace")
                        elif ctype == b"zTXt":
                            k, _, rest = data.partition(b"\x00")
                            out[k.decode("latin-1")] = zlib.decompress(rest[1:]).decode("utf-8", "replace")
                        else:
                            k, _, rest = data.partition(b"\x00")
                            comp, rest = rest[0], rest[2:]
                            _lang, _, rest = rest.partition(b"\x00")
                            _tr, _, text = rest.partition(b"\x00")
                            if comp:
                                text = zlib.decompress(text)
                            out[k.decode("utf-8", "replace")] = text.decode("utf-8", "replace")
                    except Exception:  # noqa: BLE001
                        continue
                elif ctype == b"IEND":
                    break
                else:
                    f.seek(length + 4, 1)
    except OSError:
        return {}
    return out


def video_tags(path) -> dict:
    """The container / stream metadata tags of a video, lower-cased keys, through PyAV (in this
    process: agentY-core asks ffprobe first, which the viewer may not start)."""
    tags: dict = {}
    try:
        import av  # type: ignore
        with av.open(str(path)) as c:
            for k, v in (c.metadata or {}).items():
                tags.setdefault(str(k).lower(), v)
            for s in c.streams:
                for k, v in (getattr(s, "metadata", None) or {}).items():
                    tags.setdefault(str(k).lower(), v)
    except Exception:  # noqa: BLE001
        pass
    return tags


def _looks_api(g) -> bool:
    return (isinstance(g, dict) and bool(g)
            and all(isinstance(v, dict) and "class_type" in v for v in g.values()))


def _json_or_none(text):
    if isinstance(text, (dict, list)):
        return text
    if not isinstance(text, str):
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _pull(meta: dict) -> tuple[dict, dict | None]:
    """(API graph, UI workflow) out of a metadata dict with ``prompt`` / ``workflow`` / ``comment``."""
    graph, wf = {}, None
    for key in ("prompt", "comment", "description"):
        doc = _json_or_none(meta.get(key))
        if _looks_api(doc):
            graph = doc
            break
        if isinstance(doc, dict):
            inner = _json_or_none(doc.get("prompt"))
            if _looks_api(inner):
                graph = inner
                w = _json_or_none(doc.get("workflow"))
                wf = w if isinstance(w, dict) else None
                break
    if wf is None:
        w = _json_or_none(meta.get("workflow"))
        wf = w if isinstance(w, dict) else None
    return graph, wf


_SAVE_CLASS = re.compile(r"(?i)(^Save|SaveImage|SaveVideo|VideoCombine|SendToViewer|SaveAnimated|SaveWEBP|SaveAudio)")


def _pick_output(graph: dict, filename: str) -> tuple[str, bool]:
    """(node id, certain): the save node a file came from, guessed from the graph."""
    saves = [(nid, inputs) for nid, node, inputs in _nodes(graph) if _SAVE_CLASS.search(node["class_type"])]
    if len(saves) == 1:
        return saves[0][0], True
    stem = Path(filename).name
    hit = []
    for nid, inputs in saves:
        pre = inputs.get("filename_prefix")
        if isinstance(pre, str) and pre:
            base = pre.replace("\\", "/").rsplit("/", 1)[-1]
            if base and stem.startswith(base):
                hit.append(nid)
    if len(hit) == 1:
        return hit[0], True
    return (hit[0] if hit else (saves[0][0] if saves else "")), False


_IMG_EXT = {".png"}
_VID_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi", ".gif", ".webp"}


def _result(found, source, confidence, graph=None, **kw) -> dict:
    return {"found": found, "source": source, "confidence": confidence,
            "graph": graph if graph is not None else {},
            "prompt_id": kw.get("prompt_id", ""), "output_node": kw.get("output_node", ""),
            "output_index": kw.get("output_index", 0), "workflow_file": kw.get("workflow_file", ""),
            "note": kw.get("note", "")}


def _from_sidecar(p: Path) -> dict | None:
    doc = _read_json(sidecar_path(p)) if sidecar_path(p).is_file() else None
    prov = doc.get("provenance") if isinstance(doc, dict) else None
    if not isinstance(prov, dict):
        return None
    gf = graph_file_of(p, prov)
    try:
        blob = json.loads(gzip.decompress(gf.read_bytes()).decode("utf-8"))
    except (OSError, ValueError, EOFError, zlib.error):
        return None
    g = blob.get("prompt") if isinstance(blob, dict) else None
    if not _looks_api(g):
        return None
    return _result(True, "sidecar", "exact", redact_graph(g), prompt_id=str(prov.get("prompt_id") or ""),
                   output_node=str(prov.get("output_node") or ""), output_index=int(prov.get("output_index") or 0),
                   workflow_file=str(prov.get("workflow_file") or ""))


def _from_media(p: Path) -> dict | None:
    ext = p.suffix.lower()
    if ext in _IMG_EXT:
        meta, src = png_text_chunks(p), "png"
    elif ext in _VID_EXT:
        meta, src = video_tags(p), "video"
    else:
        return None
    graph, _wf = _pull(meta)
    if not graph:
        return None
    nid, sure = _pick_output(graph, p.name)
    return _result(True, src, "high" if (sure or not nid) else "medium", redact_graph(graph),
                   output_node=nid, note="" if sure else "output node guessed from the graph")


def provenance_of(path, *, use_history: bool = False) -> dict:
    """The provenance of a file: sidecar, then embedded metadata (ComfyUI's history is agentY's).

    ``{"found", "source", "confidence", "graph", "prompt_id", "output_node", "output_index",
    "workflow_file", "note"}``."""
    p = Path(str(path))
    try:
        got = _from_sidecar(p)
        if got:
            return got
        if p.is_file():
            got = _from_media(p)
            if got:
                return got
    except Exception:  # noqa: BLE001
        pass
    return _result(False, "none", "none")


# ── the prompts of a graph (agentY-core tools.regenerate.param_index, its prompt part) ──

_TEXT_INPUTS = ("text", "prompt", "text_g", "text_l", "positive_prompt", "caption")


def _node_inputs(graph: dict, nid: str) -> dict:
    n = graph.get(str(nid))
    return (n.get("inputs") or {}) if isinstance(n, dict) else {}


def _literal_for(graph: dict, nid: str, name: str):
    v = _node_inputs(graph, nid).get(name)
    if v is None:
        return None
    if not _is_link(v):
        return (nid, name, v) if _scalar(v) else None
    tid = str(v[0])
    t = graph.get(tid)
    if not isinstance(t, dict):
        return None
    ti = t.get("inputs") or {}
    if str(t.get("class_type", "")).startswith("Primitive") or len(ti) == 1:
        for pn in ("value", "string", "text", "int", "float"):
            if pn in ti and not _is_link(ti[pn]) and _scalar(ti[pn]):
                return (tid, pn, ti[pn])
    return None


def _prompt_targets(graph: dict, nid: str, seen: set, depth: int = 0, role: str = "") -> list:
    if nid in seen or depth > 8 or str(nid) not in graph:
        return []
    seen.add(nid)
    inputs = _node_inputs(graph, nid)
    found = []
    for tn in _TEXT_INPUTS:
        if tn in inputs:
            lit = _literal_for(graph, nid, tn)
            if lit and isinstance(lit[2], str):
                found.append(lit)
    if found:
        return found
    if role and _is_link(inputs.get(role)):
        return _prompt_targets(graph, str(inputs[role][0]), seen, depth + 1, role)
    for name, v in inputs.items():
        if _is_link(v) and (name.startswith("conditioning") or name in ("positive", "negative", "cond")):
            found += _prompt_targets(graph, str(v[0]), seen, depth + 1, role)
    return found


def _entry(graph, nid, name, value, label, group):
    node = graph.get(str(nid)) or {}
    return {"id": f"{nid}.{name}", "node": str(nid), "input": name, "label": label, "value": value,
            "class": str(node.get("class_type", "")), "group": group}


def param_index(graph: dict) -> list[dict]:
    """The prompts of an API graph, as agentY-core's ``param_index`` lists them (``group`` "prompt",
    ``label`` positive / negative / text), in the same order."""
    entries: list[dict] = []
    taken: set = set()

    def add(e):
        k = (e["node"], e["input"])
        if k not in taken:
            taken.add(k)
            entries.append(e)

    claimed: dict = {}
    for _nid, _node, inputs in _nodes(graph):
        for role in ("positive", "negative"):
            v = inputs.get(role)
            if _is_link(v):
                for tid, tname, _tval in _prompt_targets(graph, str(v[0]), set(), role=role):
                    claimed.setdefault((tid, tname), role)
    for (tid, tname), role in claimed.items():
        add(_entry(graph, tid, tname, _node_inputs(graph, tid)[tname], role, "prompt"))
    roles = {"prompt": "positive", "negative_prompt": "negative", "positive_prompt": "positive"}
    for nid, _node, inputs in _nodes(graph):
        for name, v in inputs.items():
            role = roles.get(name.rsplit(".", 1)[-1])
            if role and isinstance(v, str) and (nid, name) not in taken:
                add(_entry(graph, nid, name, v, role, "prompt"))
    for nid, node, inputs in _nodes(graph):
        if str(node["class_type"]).startswith("CLIPTextEncode") and isinstance(inputs.get("text"), str):
            add(_entry(graph, nid, "text", inputs["text"], "text", "prompt"))
    return entries


# ── the models a file was made with (the Dependencies tab's caption) ─────────
# Viewer-only: agentY-core keeps the same values in ``provenance.models`` / ``partner`` of the sidecar,
# but for every node of the graph; here only the nodes that fed the file's own output count.

_MAIN_INPUT = re.compile(r"(?i)^(ckpt_name|unet_name|model_name|diffusion_model|model_path)$")
_LORA_INPUT = re.compile(r"(?i)^lora_name(_\d+)?$")
_UPSCALE_INPUT = re.compile(r"(?i)^upscale_model(_name)?$")
_AUX_INPUT = re.compile(r"(?i)^(vae_name|clip_name\d*|text_encoder\d*|clip_vision_name|control_?net_name|"
                        r"style_model_name|gligen_name)$")
_PARTNER_CLASS = re.compile(        # agentY-core utils.provenance._PARTNER_CLASS
    r"^(Kling|Veo|Runway|Luma|Pika|Pixverse|Vidu|Minimax|MiniMax|Moonvalley|Recraft|Ideogram|Stability|"
    r"BFL|Flux\w*(?:Pro|Ultra|Kontext)|OpenAI|GPTImage|Dalle|Gemini|NanoBanana|ByteDance|Bytedance|"
    r"Seedance|Seedream|Sora|Grok|Tripo|Rodin|Meshy|ElevenLabs|Magnific|Topaz|Hitpaw|Reve[A-Z_]|"
    r"Higgsfield|Wavespeed|Sonilo|Veed|Quiver|Hunyuan3D\w*Api)")
_PARTNER_API = re.compile(r"(?:[a-z0-9]Api|^Api)")
_PARTNER_NOT = re.compile(r"(?i)^(VHS_|Load|Save|Preview|GetVideo|CreateVideo|SaveVideo|Primitive|Note|Reroute)")
_PARTNER_MODEL = ("model", "model_name", "model_version", "model_id", "version")
_ROLE_ORDER = {"partner": 0, "model": 0, "upscale": 1, "lora": 2, "aux": 3}
_MODELS_CACHE: dict = {}
_MODELS_CACHE_MAX = 512


def is_partner_class(class_type: str) -> bool:
    ct = str(class_type or "")
    if not ct or _PARTNER_NOT.match(ct):
        return False
    return bool(_PARTNER_CLASS.search(ct) or _PARTNER_API.search(ct))


def _model_name(value: str) -> str:
    """``flux1-dev`` for ``FLUX/flux1-dev.safetensors``."""
    base = re.split(r"[\\/]", str(value).strip())[-1]
    stem, ext = os.path.splitext(base)
    return stem if ext.lower() in _MODEL_EXT else base


def _upstream(graph: dict, start: str) -> list[str]:
    nodes = {nid: inputs for nid, _n, inputs in _nodes(graph)}
    if start not in nodes:
        return list(nodes)
    seen, order, queue = {start}, [start], [start]
    while queue:
        for v in nodes.get(queue.pop(0), {}).values():
            if _is_link(v) and str(v[0]) in nodes and str(v[0]) not in seen:
                seen.add(str(v[0]))
                order.append(str(v[0]))
                queue.append(str(v[0]))
    return order


def graph_models(graph: dict, output_node: str = "") -> list[dict]:
    """The models of an API graph that fed *output_node* (every node when it is unknown):
    ``[{"name", "role", "node", "class", "value"}]``, ``role`` one of ``model`` (a checkpoint,
    UNet, diffusion model), ``partner`` (an API node: its ``model`` input, else its class),
    ``upscale``, ``lora``, ``aux`` (VAE, text encoders, ControlNets ...); main ones first."""
    by_id = {nid: (node, inputs) for nid, node, inputs in _nodes(graph)}
    out: list[dict] = []
    seen: set = set()

    def add(name, role, nid, ct, value):
        if not name or (role, name) in seen:
            return
        seen.add((role, name))
        out.append({"name": name[:120], "role": role, "node": nid, "class": ct, "value": str(value)[:240]})

    for nid in _upstream(graph, str(output_node or "")):
        node, inputs = by_id.get(nid, ({}, {}))
        ct = str(node.get("class_type") or "")
        if is_partner_class(ct):
            pick = next((inputs[k] for k in _PARTNER_MODEL if isinstance(inputs.get(k), str) and inputs[k].strip()), "")
            add(pick.strip() if pick else re.sub(r"(Node|Api)$", "", ct), "partner", nid, ct, pick or ct)
            continue
        for name, v in inputs.items():
            if _is_link(v) or not isinstance(v, str) or not v.strip():
                continue
            short = str(name).rsplit(".", 1)[-1]
            if _LORA_INPUT.match(short):
                role = "lora"
            elif _UPSCALE_INPUT.match(short) or (short == "model_name" and "upscale" in ct.lower()):
                role = "upscale"
            elif _MAIN_INPUT.match(short):
                role = "model"
            elif _AUX_INPUT.match(short) or v.lower().endswith(_MODEL_EXT):
                role = "aux"
            else:
                continue
            if v.strip().lower() in ("none", "baked vae"):
                continue
            add(_model_name(v), role, nid, ct, v)
    out.sort(key=lambda m: _ROLE_ORDER.get(m["role"], 9))
    return out[:24]


def models_of(path) -> list[dict]:
    """:func:`graph_models` of the graph *path* was made with (``[]`` without one). Cached by the
    file's size and time, so a Dependencies tab redrawn does not read every graph again."""
    p = str(path)
    try:
        st = os.stat(p)
        key = (p, st.st_mtime_ns, st.st_size)
    except OSError:
        return []
    if key in _MODELS_CACHE:
        return _MODELS_CACHE[key]
    try:
        got = provenance_of(p)
        out = graph_models(got.get("graph") or {}, got.get("output_node") or "") if got.get("found") else []
    except Exception:  # noqa: BLE001 - a caption is never worth failing the tab
        out = []
    if len(_MODELS_CACHE) >= _MODELS_CACHE_MAX:
        _MODELS_CACHE.clear()
    _MODELS_CACHE[key] = out
    return out
