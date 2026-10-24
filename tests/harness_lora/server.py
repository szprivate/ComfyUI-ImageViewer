"""Standalone harness for the Dataset panel: python tests/harness_lora/server.py [port]
Serves js/ and page.html, and the /bepic/lora/* routes straight from lora_io.py over a demo output
folder made in a temp dir (a dataset with 6 items, a running training run). No ComfyUI, no agentY."""
import importlib.util
import json
import os
import struct
import sys
import tempfile
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
spec = importlib.util.spec_from_file_location("lora_io", os.path.join(ROOT, "lora_io.py"))
io = importlib.util.module_from_spec(spec)
spec.loader.exec_module(io)


def png(path, w, h, rgb):
    def chunk(k, d):
        return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xFFFFFFFF)
    raw = zlib.compress((b"\x00" + bytes(rgb) * w) * h)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def seed(out):
    ds = os.path.join(out, "agent", "lora_datasets", "demo_cat")
    os.makedirs(os.path.join(ds, "items"))
    items = []
    for i in range(6):
        f = f"items/i{i + 1:03d}.png"
        png(os.path.join(ds, f), 256, 256, (40 + i * 30, 90, 200 - i * 25))
        items.append({"id": f"i{i + 1:03d}", "file": f, "kind": "image",
                      "caption": ("ohwx " if i != 3 else "") + f"a cat, picture {i + 1}",
                      "included": i != 5, "crop": None, "original": f"C:/src/{i}.jpg", "size": [256, 256],
                      "frames": None, "fps": None, "source": "folder",
                      "note": "blurry" if i == 5 else "good light", "removed_by": "agent" if i == 5 else None})
    m = {"version": 1, "name": "demo_cat", "subject": "Mimi the cat", "kind": "character", "model": "flux1-dev",
         "trigger_word": "ohwx", "caption_style": "natural sentences", "status": "review", "approved_at": None,
         "created": "2026-10-24", "buckets": [[512, 512], [768, 512]],
         "summary": {"count": 6, "included": 5, "removed": 1, "warnings": ["only 5 usable images"]}, "items": items}
    io.write_json(os.path.join(ds, "manifest.json"), m)
    run = os.path.join(out, "agent", "lora_runs", "demo_job")
    os.makedirs(os.path.join(run, "samples"))
    for s in (100, 200, 300):
        png(os.path.join(run, "samples", f"s{s}.png"), 192, 192, (s // 2, 120, 255 - s // 2))
    io.write_json(os.path.join(run, "job.json"), {"dataset": "demo_cat", "model": "flux1-dev", "steps": 1000})
    series = [[i * 10, 0.4 * (0.995 ** i) + 0.05 * ((i * 7919) % 13) / 13] for i in range(1, 60)]
    io.write_json(os.path.join(run, "progress.json"), {
        "job": "demo_job", "status": "running", "step": 600, "total": 1000, "pct": 0.6, "eta_s": 540,
        "it_s": 1.23, "elapsed_s": 810, "loss": 0.137, "lr": 1e-4, "vram_gb": 21.4, "loss_series": series,
        "updated": time.time(), "message": "training", "backend": "ai-toolkit", "model": "flux1-dev",
        "dataset": "demo_cat"})
    io.write_json(os.path.join(run, "samples.json"), [
        {"step": s, "files": [{"prompt": "ohwx cat on a sofa", "file": f"samples/s{s}.png"}] * 2} for s in (100, 200, 300)])
    with open(os.path.join(run, "events.jsonl"), "w") as fh:
        for n, (k, t) in enumerate([("started", "training started"), ("sample", "samples at step 100"),
                                    ("checkpoint", "checkpoint at step 500")], 1):
            fh.write(json.dumps({"id": n, "t": time.time() - 100 + n, "kind": k, "text": t}) + "\n")
    with open(os.path.join(run, "train.log"), "w") as fh:
        fh.write("\n".join(f"step {i}/1000 loss=0.1{i}" for i in range(580, 601)))


OUT = tempfile.mkdtemp(prefix="lora_harness_")
seed(OUT)
TYPES = {".js": "text/javascript", ".html": "text/html", ".png": "image/png", ".json": "application/json"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self, method, u, body):
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        try:
            if method == "GET" and p == "/bepic/lora/datasets":
                return self.send(200, {"datasets": io.list_datasets(OUT)}) or True
            if method == "GET" and p == "/bepic/lora/dataset":
                return self.send(200, io.get_dataset(OUT, q.get("name"))) or True
            if method == "GET" and p == "/bepic/lora/runs":
                return self.send(200, {"runs": io.list_runs(OUT)}) or True
            if method == "GET" and p == "/bepic/lora/run":
                return self.send(200, io.get_run(OUT, q.get("name"))) or True
            if method == "GET" and p == "/bepic/lora/file":
                with open(io.resolve_file(OUT, q.get("path")), "rb") as fh:
                    return self.send(200, fh.read(), "image/png") or True
            if method == "POST" and p == "/bepic/lora/dataset_save":
                return self.send(200, io.save_dataset(OUT, body.get("name"), body.get("manifest"))) or True
            if method == "POST" and p == "/bepic/lora/review":
                return self.send(200, io.review_dataset(OUT, body.get("name"), body.get("action"),
                                                        body.get("note"), body.get("manifest"))) or True
            if method == "POST" and p == "/bepic/lora/control":
                return self.send(200, io.control_run(OUT, body.get("name"), body.get("action"), body.get("keep"))) or True
        except io.LoraError as e:
            return self.send(e.status, {"error": str(e)}) or True
        return False

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/bepic/"):
            if not self.route("GET", u, None):
                self.send(404, {"error": "nf"})
            return
        f = os.path.join(ROOT, "js", u.path[4:]) if u.path.startswith("/js/") else os.path.join(HERE, u.path.lstrip("/") or "page.html")
        try:
            with open(f, "rb") as fh:
                data = fh.read()
        except OSError:
            return self.send(404, b"nf", "text/plain")
        self.send(200, data, TYPES.get(os.path.splitext(f)[1], "application/octet-stream"))

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            body = {}
        if not self.route("POST", urlparse(self.path), body):
            self.send(404, {"error": "nf"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    print(f"http://127.0.0.1:{port}/page.html  (demo data in {OUT})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
