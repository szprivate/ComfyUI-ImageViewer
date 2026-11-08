"""What a file's C2PA "content credentials" say about how it was made - read, not verified.

A generator that signs its output (BytePlus / Seedance, OpenAI, Adobe Firefly, Google ...) embeds a
C2PA manifest store: JUMBF boxes holding CBOR. This reads the ACTIVE manifest's claim generator and its
``c2pa.actions`` (software agent, when, the digital source type, the parameters - a model name, when the
signer put one there). Where the store sits:

* MP4 / MOV / AVIF / HEIF: a top-level ``uuid`` box with the C2PA user type (a walk of the box headers,
  seeking past the rest, so a large film costs a few reads);
* PNG: the ``caBX`` chunk;  JPEG: APP11 ``JP`` segments, put back together;  WebP: the ``C2PA`` chunk.

Nothing is verified - no signature, no hash: it is a caption, not proof, and the Dependencies tab says
so. Plain Python, no program started. Anything unreadable answers ``{}``.
"""
from __future__ import annotations

import os
import struct

C2PA_UUID = bytes.fromhex("d8fec3d61b0e483c92975828877ec481")
MAX_STORE = 8 * 1024 * 1024          # a manifest store is KBs; refuse anything absurd
_ISO_EXT = {".mp4", ".mov", ".m4v", ".m4a", ".3gp", ".avif", ".heic", ".heif"}


# ── finding the store ────────────────────────────────────────────────────────

def _iso_store(f, size: int) -> bytes:
    pos = 0
    while pos + 8 <= size:
        f.seek(pos)
        head = f.read(16)
        if len(head) < 8:
            return b""
        n, kind = struct.unpack(">I4s", head[:8])
        hl = 8
        if n == 1:
            n, hl = struct.unpack(">Q", head[8:16])[0], 16
        elif n == 0:
            n = size - pos
        if n < hl:
            return b""
        if kind == b"uuid" and n - hl <= MAX_STORE + 64:
            f.seek(pos + hl)
            body = f.read(n - hl)
            if body[:16] == C2PA_UUID:
                at = body.find(b"jumb", 16)
                return body[at - 4:] if at >= 4 else b""
        pos += n
    return b""


def _png_store(f) -> bytes:
    f.seek(8)
    while True:
        head = f.read(8)
        if len(head) < 8:
            return b""
        n, kind = struct.unpack(">I4s", head)
        if kind == b"caBX" and n <= MAX_STORE:
            return f.read(n)
        if kind == b"IEND":
            return b""
        f.seek(n + 4, 1)


def _jpeg_store(f) -> bytes:
    f.seek(2)
    parts: dict = {}
    while True:
        m = f.read(4)
        if len(m) < 4 or m[0] != 0xFF:
            break
        marker, n = m[1], struct.unpack(">H", m[2:])[0]
        if marker in (0xDA, 0xD9):          # start of scan: no more metadata
            break
        seg = f.read(n - 2)
        if marker == 0xEB and seg[:2] == b"JP" and len(seg) >= 16:
            en, z = struct.unpack(">HI", seg[2:8])
            box = seg[8:]
            if box[4:8] != b"jumb":
                continue
            parts.setdefault(en, []).append((z, box))
    for en, segs in parts.items():
        segs.sort()
        data = segs[0][1] + b"".join(b[8:] for _z, b in segs[1:])   # later ones repeat LBox / TBox
        if b"c2pa" in data[:64]:
            return data[:MAX_STORE]
    return b""


def _webp_store(f) -> bytes:
    f.seek(12)
    while True:
        head = f.read(8)
        if len(head) < 8:
            return b""
        kind, n = struct.unpack("<4sI", head)
        if kind == b"C2PA" and n <= MAX_STORE:
            return f.read(n)
        f.seek(n + (n & 1), 1)


def manifest_store(path) -> bytes:
    """The raw JUMBF manifest store of *path*, ``b""`` without one."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            sig = f.read(12)
            ext = os.path.splitext(str(path))[1].lower()
            if sig[:8] == b"\x89PNG\r\n\x1a\n":
                return _png_store(f)
            if sig[:2] == b"\xff\xd8":
                return _jpeg_store(f)
            if sig[:4] == b"RIFF" and sig[8:12] == b"WEBP":
                return _webp_store(f)
            if sig[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip", b"uuid") or ext in _ISO_EXT:
                return _iso_store(f, size)
    except (OSError, struct.error, ValueError):
        pass
    return b""


# ── JUMBF ────────────────────────────────────────────────────────────────────

def _boxes(data: bytes, start: int = 0, end: int | None = None):
    end = len(data) if end is None else end
    pos = start
    while pos + 8 <= end:
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        hl = 8
        if n == 1:
            n, hl = struct.unpack(">Q", data[pos + 8:pos + 16])[0], 16
        elif n == 0:
            n = end - pos
        if n < hl or pos + n > end:
            return
        yield kind, data[pos + hl:pos + n]
        pos += n


def _superbox(body: bytes) -> dict:
    """``{"label", "children": [superbox], "content": [(kind, bytes)]}`` of a ``jumb`` box's body."""
    out = {"label": "", "children": [], "content": []}
    for kind, b in _boxes(body):
        if kind == b"jumd":
            toggles = b[16] if len(b) > 16 else 0
            if toggles & 2:
                z = b.find(b"\x00", 17)
                out["label"] = b[17:z if z >= 0 else len(b)].decode("utf-8", "replace")
        elif kind == b"jumb":
            out["children"].append(_superbox(b))
        else:
            out["content"].append((kind, b))
    return out


# ── CBOR (what C2PA uses of it) ──────────────────────────────────────────────

class _Cbor:
    def __init__(self, data: bytes):
        self.d, self.i, self.depth = data, 0, 0

    def _arg(self, info: int) -> int:
        if info < 24:
            return info
        size = {24: 1, 25: 2, 26: 4, 27: 8}.get(info)
        if size is None:
            raise ValueError("indefinite or reserved length")
        v = int.from_bytes(self.d[self.i:self.i + size], "big")
        self.i += size
        return v

    def read(self):
        if self.i >= len(self.d):
            raise ValueError("truncated")
        self.depth += 1
        if self.depth > 64:
            raise ValueError("too deep")
        b = self.d[self.i]
        self.i += 1
        major, info = b >> 5, b & 31
        try:
            if major == 7:
                if info == 20:
                    return False
                if info == 21:
                    return True
                if info in (22, 23):
                    return None
                if info == 25:
                    self.i += 2
                    return 0.0
                if info in (26, 27):
                    n = 4 if info == 26 else 8
                    v = struct.unpack(">f" if n == 4 else ">d", self.d[self.i:self.i + n])[0]
                    self.i += n
                    return v
                return None
            if info == 31 and major in (2, 3, 4, 5):     # indefinite length, up to a break (0xFF)
                return self._indefinite(major)
            n = self._arg(info)
            if major == 0:
                return n
            if major == 1:
                return -1 - n
            if major in (2, 3):
                v = self.d[self.i:self.i + n]
                self.i += n
                return v.decode("utf-8", "replace") if major == 3 else bytes(v)
            if major == 4:
                return [self.read() for _ in range(min(n, 10000))]
            if major == 5:
                out = {}
                for _ in range(min(n, 10000)):
                    k = self.read()
                    out[k if isinstance(k, (str, int)) else str(k)] = self.read()
                return out
            if major == 6:
                return self.read()          # a tag: its value
        finally:
            self.depth -= 1
        raise ValueError("bad CBOR")


    def _at_break(self) -> bool:
        if self.i < len(self.d) and self.d[self.i] == 0xFF:
            self.i += 1
            return True
        return False

    def _indefinite(self, major: int):
        if major in (2, 3):
            parts = []
            while not self._at_break():
                parts.append(self.read())
            return ("" if major == 3 else b"").join(parts)
        if major == 4:
            out = []
            while not self._at_break() and len(out) < 10000:
                out.append(self.read())
            return out
        out = {}
        while not self._at_break() and len(out) < 10000:
            k = self.read()
            out[k if isinstance(k, (str, int)) else str(k)] = self.read()
        return out


def cbor(data: bytes):
    return _Cbor(data).read()


# ── the manifest ─────────────────────────────────────────────────────────────

def _content(box: dict):
    for kind, b in box["content"]:
        try:
            if kind == b"cbor":
                return cbor(b)
            if kind == b"json":
                import json
                return json.loads(b.decode("utf-8"))
        except (ValueError, IndexError, UnicodeDecodeError):
            return None
    return None


def _agent(v) -> str:
    if isinstance(v, dict):
        return " ".join(str(v.get(k) or "") for k in ("name", "version")).strip()
    return str(v or "")


def read(path) -> dict:
    """What the active manifest of *path* says, ``{}`` without one:
    ``{"generator", "agents", "when", "source_type", "ai", "params", "actions", "title"}``."""
    data = manifest_store(path)
    if not data:
        return {}
    try:
        top = next((b for k, b in _boxes(data) if k == b"jumb"), None)
        if top is None:
            return {}
        store = _superbox(top)
        manifests = [c for c in store["children"]
                     if any(g["label"].startswith("c2pa.claim") for g in c["children"])]
        if not manifests:
            return {}
        m = manifests[-1]                     # the active manifest is the last one
        claim, actions = {}, []
        for c in m["children"]:
            if c["label"].startswith("c2pa.claim"):
                claim = _content(c) or {}
            elif c["label"] == "c2pa.assertions":
                for a in c["children"]:
                    if a["label"].startswith("c2pa.actions"):
                        got = _content(a) or {}
                        actions += [x for x in got.get("actions") or [] if isinstance(x, dict)]
    except (ValueError, struct.error, IndexError):
        return {}
    gen = claim.get("claim_generator") or ""
    info = claim.get("claim_generator_info")
    if not gen and isinstance(info, list):
        gen = " ".join(_agent(x) for x in info if isinstance(x, dict))
    elif not gen and isinstance(info, dict):
        gen = _agent(info)
    out_actions, params, agents, when, source = [], {}, [], "", ""
    for a in actions[:32]:
        name = str(a.get("action") or "")
        agent = _agent(a.get("softwareAgent"))
        p = a.get("parameters") if isinstance(a.get("parameters"), dict) else {}
        st = str(a.get("digitalSourceType") or "")
        out_actions.append({"action": name, "agent": agent[:120], "when": str(a.get("when") or "")[:40],
                            "source_type": st.rsplit("/", 1)[-1][:80]})
        if agent and agent not in agents:
            agents.append(agent[:120])
        when = when or str(a.get("when") or "")
        source = source or st.rsplit("/", 1)[-1]
        for k, v in p.items():
            if isinstance(v, (str, int, float, bool)) and k not in params:
                params[str(k)[:60]] = str(v)[:240]
    return {"generator": str(gen)[:200], "agents": agents, "when": when[:40], "source_type": source[:80],
            "ai": source in ("trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia",
                             "algorithmicMedia", "compositeSynthetic"),
            "params": params, "actions": out_actions, "title": str(claim.get("dc:title") or "")[:200]}


_MODEL_KEYS = ("model_name", "model", "model_id", "modelName", "model_version", "com.openai.model")


def model_of(info: dict) -> str:
    """The model a manifest names, ``""`` when it names none."""
    p = (info or {}).get("params") or {}
    for k in _MODEL_KEYS:
        if p.get(k):
            return str(p[k])
    for k, v in p.items():
        if "model" in k.lower() and v:
            return str(v)
    return ""
