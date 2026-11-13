"""The Comp space's tool library: groups saved as tools, kept per OS user so every comp on this machine shares
them (AYON starts ComfyUI with a user directory per project, which is why they are not in ComfyUI's folder).

Where: ``~/.comfyui_image_viewer/comp_tools/<name>.comp.json``, or the folder named by IMAGE_VIEWER_COMP_TOOLS.

A tool is a comp file holding one Group node and nothing else (the page's ``toolFragment``): ``{comp: 1, format,
nodes: [group], output: null, tool: {name, note?}}``. It opens as a comp too. This module checks the shape (the
comp model's own rules) and keeps the files; it reads and writes nothing outside that folder.

Route (registered by comp_routes through :func:`register`), JSON, same_origin:
    POST /imageviewer/comp_tools {op: "list"}             -> {tools: [{name, note, file, created, inputs, nodes}]}
    POST /imageviewer/comp_tools {op: "get", name}        -> {tool}
    POST /imageviewer/comp_tools {op: "save", tool}       -> {tool: {name, ...}} (the same name: written over)
    POST /imageviewer/comp_tools {op: "delete", name}     -> {ok}
"""
import json
import os
import re
import time

MAX_TOOLS = 1000
MAX_BYTES = 4_000_000
MAX_NAME = 80


def tools_dir():
    env = os.environ.get("IMAGE_VIEWER_COMP_TOOLS")
    if env:
        return env
    try:
        from .legacy_names import user_dir
    except ImportError:  # run outside the package (tests)
        from legacy_names import user_dir
    return os.path.join(user_dir(), "comp_tools")


def _model():
    try:
        from . import comp_model
    except ImportError:  # run outside the package (tests)
        import comp_model
    return comp_model


def clean_name(name):
    s = re.sub(r"[\x00-\x1f\x7f]", "", str(name or "")).strip()
    return s[:MAX_NAME]


def file_name(name):
    """The file a tool of that name is kept in: safe on every file system, one per name whatever its case."""
    s = re.sub(r"[^A-Za-z0-9 _.\-]+", "_", clean_name(name)).strip(" ._").lower()
    s = re.sub(r"\s+", " ", s)
    if s.upper().split(".")[0] in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(10)), *(f"LPT{i}" for i in range(10))}:
        s = "_" + s
    return (s or "tool") + ".comp.json"


def clean_tool(raw):
    """The tool as it will be kept, or a ValueError saying what is wrong with it."""
    if not isinstance(raw, dict):
        raise ValueError("a tool must be an object")
    meta = raw.get("tool") if isinstance(raw.get("tool"), dict) else {}
    name = clean_name(meta.get("name"))
    if not name:
        raise ValueError("a tool needs a name")
    M = _model()
    comp, _ = M.normalize(dict(raw, comp=M.COMP_VERSION))
    groups = [n for n in comp["nodes"] if n.get("type") == "group"]
    if len(groups) != 1:
        raise ValueError("a tool is one Group node")
    g = groups[0]
    g["inputs"] = [None] * len(g.get("inputs") or [])
    g["x"], g["y"] = 0, 0
    g["name"] = name
    out = {"comp": M.COMP_VERSION, "format": comp["format"], "nodes": [g], "output": None,
           "tool": {"name": name, "created": meta.get("created") if isinstance(meta.get("created"), (int, float)) else time.time()}}
    note = clean_name(meta.get("note")) if meta.get("note") else ""
    if note:
        out["tool"]["note"] = note
    if len(json.dumps(out)) > MAX_BYTES:
        raise ValueError("the tool is too big to keep")
    return out


def _summary(tool, fname):
    g = tool["nodes"][0]
    count = 0
    stack = [g]
    while stack:
        n = stack.pop()
        for c in n.get("nodes") or []:
            count += 1
            stack.append(c)
    return {"name": tool["tool"]["name"], "note": tool["tool"].get("note", ""), "file": fname,
            "created": tool["tool"]["created"], "inputs": len(g.get("inputs") or []), "nodes": count}


def list_tools(folder=None):
    folder = folder or tools_dir()
    out = []
    try:
        names = sorted(n for n in os.listdir(folder) if n.lower().endswith(".comp.json"))
    except OSError:
        return out
    for n in names[:MAX_TOOLS]:
        try:
            p = os.path.join(folder, n)
            if os.path.getsize(p) > MAX_BYTES:
                continue
            with open(p, encoding="utf-8") as f:
                out.append(_summary(clean_tool(json.load(f)), n))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    out.sort(key=lambda t: t["name"].lower())
    return out


def get_tool(name, folder=None):
    folder = folder or tools_dir()
    with open(os.path.join(folder, file_name(name)), encoding="utf-8") as f:
        return clean_tool(json.load(f))


def save_tool(raw, folder=None):
    folder = folder or tools_dir()
    tool = clean_tool(raw)
    os.makedirs(folder, exist_ok=True)
    fname = file_name(tool["tool"]["name"])
    path = os.path.join(folder, fname)
    if not os.path.exists(path) and len([n for n in os.listdir(folder) if n.endswith(".comp.json")]) >= MAX_TOOLS:
        raise ValueError(f"the library is full ({MAX_TOOLS} tools)")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(tool, f, indent=1)
    os.replace(tmp, path)
    return _summary(tool, fname)


def delete_tool(name, folder=None):
    folder = folder or tools_dir()
    path = os.path.join(folder, file_name(name))
    if os.path.isfile(path):
        os.remove(path)
        return True
    return False


def register(add, *, web, path_access):
    """Add the route through ``add(method, path, handler)``, under /imageviewer and /api/imageviewer."""
    import asyncio

    def off(fn, *a):
        return asyncio.get_running_loop().run_in_executor(None, lambda: fn(*a))

    async def post(request):
        ok, why = path_access.same_origin(request)
        if not ok:
            return web.json_response({"error": why}, status=403)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "the body must be a JSON object"}, status=400)
        op = body.get("op")
        try:
            if op == "list":
                return web.json_response({"tools": await off(list_tools)})
            if op == "get":
                return web.json_response({"tool": await off(get_tool, body.get("name"))})
            if op == "save":
                return web.json_response({"tool": await off(save_tool, body.get("tool"))})
            if op == "delete":
                return web.json_response({"ok": await off(delete_tool, body.get("name"))})
        except FileNotFoundError:
            return web.json_response({"error": "there is no tool of that name"}, status=404)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"error": f"unknown op {op!r}"}, status=400)

    for prefix in ("/imageviewer", "/api/imageviewer"):
        add("POST", f"{prefix}/comp_tools", post)
