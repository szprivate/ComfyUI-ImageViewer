"""A small folder of files for the Dependencies tests: a plate, a depth pass and a render saved by ComfyUI's
Save Image (the graph embedded in the PNG), and helpers to read the records back. No PIL needed."""
import json
import os
import struct
import zlib


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def write_png(path, text=None, shade=0):
    """A 2x2 grey PNG with tEXt chunks `text` ({keyword: str})."""
    raw = b"".join(b"\x00" + bytes([shade, shade, shade]) * 2 for _ in range(2))
    body = _chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
    for k, v in (text or {}).items():
        body += _chunk(b"tEXt", k.encode("latin-1") + b"\x00" + v.encode("utf-8"))
    body += _chunk(b"IDAT", zlib.compress(raw)) + _chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + body)


DEPTH_GRAPH = {
    "1": {"class_type": "LoadImage", "inputs": {"image": "plate.png"}},
    "2": {"class_type": "DepthAnythingV2Preprocessor", "inputs": {"image": ["1", 0], "resolution": 512}},
    "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "depth"}},
}

RENDER_GRAPH = {
    "1": {"class_type": "LoadImage", "inputs": {"image": "depth_00001_.png [output]"}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "flux.safetensors"}},
    "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "a kitchen at dawn", "clip": ["4", 1]}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry", "clip": ["4", 1]}},
    "7": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0],
                                                "latent_image": ["1", 0], "seed": 7}},
    "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "render"}},
}

SEND_GRAPH = {
    "1": {"class_type": "LoadImage", "inputs": {"image": "render_00001_.png [output]"}},
    "2": {"class_type": "ImageScale", "inputs": {"image": ["1", 0], "width": 64, "height": 64}},
    "3": {"class_type": "ImageViewerSend", "inputs": {"images": ["2", 0]}},
}


def build(root):
    """input/plate.png, output/depth_00001_.png and output/render_00001_.png under `root`; their paths."""
    rts = {k: os.path.join(root, k) for k in ("input", "output", "temp")}
    for d in rts.values():
        os.makedirs(d, exist_ok=True)
    plate = os.path.join(rts["input"], "plate.png")
    depth = os.path.join(rts["output"], "depth_00001_.png")
    render = os.path.join(rts["output"], "render_00001_.png")
    write_png(plate, shade=10)
    write_png(depth, {"prompt": json.dumps(DEPTH_GRAPH)}, shade=20)
    write_png(render, {"prompt": json.dumps(RENDER_GRAPH)}, shade=30)
    return rts, {"plate": plate, "depth": depth, "render": render}


def tidy(g, root):
    """A graph() answer made comparable: paths relative to `root`, lists sorted, times left out."""
    rel = lambda p: os.path.relpath(p, root).replace("\\", "/") if p else p
    nodes = sorted(({"id": rel(n["id"]), "kind": n.get("kind", ""), "exists": n.get("exists"),
                     "root": n.get("root"), "stale": n.get("stale", ""), "prompts": n.get("prompts") or []}
                    for n in g.get("nodes") or []), key=lambda n: n["id"])
    edges = sorted(({"from": rel(e["from"]), "to": rel(e["to"]), "kind": e.get("kind", ""), "label": e.get("label", "")}
                    for e in g.get("edges") or []), key=lambda e: (e["from"], e["to"]))
    return {"root": rel(g.get("root")), "nodes": nodes, "edges": edges, "truncated": g.get("truncated")}


def records(root):
    """Every sidecar's provenance.deps and every .derived.json under `root`, times and fingerprints of
    the sidecars left as they are (both sides hash the same bytes), `created` left out."""
    out = {}
    for d, _dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            key = os.path.relpath(p, root).replace("\\", "/")
            if f.endswith(".agenty.json"):
                with open(p, encoding="utf-8") as fh:
                    doc = json.load(fh)
                deps = (doc.get("provenance") or {}).get("deps")
                if deps:
                    deps = json.loads(json.dumps(deps).replace(root.replace("\\", "\\\\"), "<root>").replace(root, "<root>"))
                    out[key] = deps
            elif f.endswith(".derived.json"):
                with open(p, encoding="utf-8") as fh:
                    doc = json.load(fh)
                items = [{k: v for k, v in i.items() if k != "created"} for i in doc.get("items") or []]
                out[key] = json.loads(json.dumps(items).replace(root.replace("\\", "\\\\"), "<root>").replace(root, "<root>"))
    return out
