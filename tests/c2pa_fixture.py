"""Small files carrying a C2PA manifest store, built here (no signer needed: the reader verifies nothing).
The store's shape is C2PA's: JUMBF superboxes (jumb / jumd) holding CBOR claims and assertions."""
import struct
import zlib
from pathlib import Path


def _write(path, data: bytes):
    Path(path).write_bytes(data)

C2PA_UUID = bytes.fromhex("d8fec3d61b0e483c92975828877ec481")
JUMD_C2PA = bytes.fromhex("6332706100110010800000aa00389b71")   # 'c2pa' type of the store's description


def cbor(v) -> bytes:
    def head(major, n):
        if n < 24:
            return bytes([major << 5 | n])
        for info, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
            if n < 1 << (8 * size):
                return bytes([major << 5 | info]) + n.to_bytes(size, "big")
        raise ValueError(n)
    if isinstance(v, bool):
        return b"\xf5" if v else b"\xf4"
    if isinstance(v, int):
        return head(0, v) if v >= 0 else head(1, -1 - v)
    if isinstance(v, str):
        b = v.encode()
        return head(3, len(b)) + b
    if isinstance(v, bytes):
        return head(2, len(v)) + v
    if isinstance(v, list):
        return head(4, len(v)) + b"".join(cbor(x) for x in v)
    if isinstance(v, dict):
        return head(5, len(v)) + b"".join(cbor(k) + cbor(x) for k, x in v.items())
    raise TypeError(v)


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(body), kind) + body


def superbox(label: str, *children: bytes, kind_uuid: bytes = b"\x00" * 16) -> bytes:
    jumd = box(b"jumd", kind_uuid + b"\x03" + label.encode() + b"\x00")
    return box(b"jumb", jumd + b"".join(children))


def store(actions: list, generator: str = "Test 1.0", manifests: int = 1) -> bytes:
    """A manifest store whose LAST (active) manifest has these actions."""
    ms = []
    for i in range(manifests):
        acts = actions if i == manifests - 1 else [{"action": "c2pa.opened"}]
        ms.append(superbox(f"urn:c2pa:{i:08d}-0000-0000-0000-000000000000",
                           superbox("c2pa.assertions",
                                    superbox("c2pa.actions.v2", box(b"cbor", cbor({"actions": acts})))),
                           superbox("c2pa.claim.v2", box(b"cbor", cbor({
                               "claim_generator_info": [{"name": generator}], "dc:title": "x"}))),
                           superbox("c2pa.signature", box(b"cbor", cbor({"sig": b"\x00"})))))
    return superbox("c2pa", *ms, kind_uuid=JUMD_C2PA)


def _png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png(path, st: bytes):
    ihdr = _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    idat = _png_chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00"))
    _write(path, b"\x89PNG\r\n\x1a\n" + ihdr + _png_chunk(b"caBX", st) + idat + _png_chunk(b"IEND", b""))


def jpeg(path, st: bytes, seg: int = 300):
    """APP11 segments of at most *seg* bytes of the box each; later ones repeat LBox / TBox."""
    out = b"\xff\xd8"
    first, rest = st[:seg], st[seg:]
    pieces = [first] + [st[:8] + rest[i:i + seg] for i in range(0, len(rest), seg)]
    for z, piece in enumerate(pieces, 1):
        body = b"JP" + struct.pack(">HI", 0x11, z) + piece
        out += b"\xff\xeb" + struct.pack(">H", len(body) + 2) + body
    out += b"\xff\xda\x00\x02" + b"\x00" * 8 + b"\xff\xd9"
    _write(path, out)


def mp4(path, st: bytes, at_end: bool = True):
    ftyp = box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2")
    mdat = box(b"mdat", b"\x00" * 4096)
    uuid = box(b"uuid", C2PA_UUID + b"\x00\x00\x00\x00" + b"manifest\x00" + b"\x00" * 8 + st)
    _write(path, ftyp + (mdat + uuid if at_end else uuid + mdat))


def webp(path, st: bytes):
    chunk = b"C2PA" + struct.pack("<I", len(st)) + st + (b"\x00" if len(st) & 1 else b"")
    vp8 = b"VP8L" + struct.pack("<I", 5) + b"\x2f\x00\x00\x00\x00" + b"\x00"
    body = b"WEBP" + vp8 + chunk
    _write(path, b"RIFF" + struct.pack("<I", len(body)) + body)


SEEDANCE = [{"action": "c2pa.created", "when": "2026-10-21T21:42:54Z",
             "softwareAgent": {"name": "BytePlus_ModelArk", "version": "1.0.0"},
             "parameters": {"model_name": "dreamina-seedance-2-5", "log_id": "ATMA"},
             "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"}]
