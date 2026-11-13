"""Comp's colour files: LUT files for the LUT node, and ASC CDL files (.cc / .cdl / .ccc) for the CDL node.

A LUT is read into the same shape the OCIO nodes' baked transforms have - ``(size, shaper, float32 data)``,
blue fastest, red slowest - so the page's ``lutColor`` and ``comp_model.apply_lut`` apply it trilinear, the
preview and the render alike. A ``.cube`` (3D, or 1D sampled onto a 33^3 grid) is read here, with its
``DOMAIN_MIN`` / ``DOMAIN_MAX`` as the shaper's range; any other format OpenColorIO reads (.3dl, .spi3d,
.csp, .clf ...) is sampled through an OCIO FileTransform onto a 33^3 grid over 0..1, when OCIO is installed.

A CDL is the ten numbers of the ASC Color Decision List (slope, offset, power per channel, saturation),
read from the first ColorCorrection in the file (a .cdl's first ColorDecision) and written as a .cc, or a
.cdl / .ccc holding one. Written from the published schema, namespaces ignored on reading.
"""
from __future__ import annotations

import os
import threading
import xml.etree.ElementTree as ET

import numpy as np

MAX_BYTES = 64 * 1024 * 1024
MAX_CDL_BYTES = 1024 * 1024
MAX_SIZE = 129
GRID = 33
CDL_EXTS = (".cc", ".cdl", ".ccc")
ASC_NS = "urn:ASC:CDL:v1.01"
_lock = threading.Lock()
_cache = {}


class LutError(ValueError):
    pass


def _floats(parts, n, line):
    try:
        v = [float(x) for x in parts[:n]]
    except ValueError:
        raise LutError(f"not a number in {line!r}") from None
    if len(v) != n:
        raise LutError(f"{n} numbers expected in {line!r}")
    return v


def parse_cube(text):
    """A .cube's text -> (size, shaper, data) as the comp applies it."""
    size3 = size1 = 0
    lo, hi = [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]
    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        key = parts[0].upper()
        if key == "TITLE":
            continue
        if key == "LUT_3D_SIZE":
            size3 = int(parts[1])
        elif key == "LUT_1D_SIZE":
            size1 = int(parts[1])
        elif key == "DOMAIN_MIN":
            lo = _floats(parts[1:], 3, line)
        elif key == "DOMAIN_MAX":
            hi = _floats(parts[1:], 3, line)
        elif key in ("LUT_1D_INPUT_RANGE", "LUT_3D_INPUT_RANGE"):
            a, b = _floats(parts[1:], 2, line)
            lo, hi = [a] * 3, [b] * 3
        elif key[0].isalpha():
            continue   # another keyword of a newer writer
        else:
            rows.append(_floats(parts, 3, line))
    lo_, hi_ = min(lo), max(hi)
    if not hi_ > lo_:
        raise LutError("the domain is empty")
    shaper = f"lin:{lo_:g}:{hi_:g}"
    data = np.asarray(rows, np.float64)
    if size3:
        if not 2 <= size3 <= MAX_SIZE:
            raise LutError(f"a 3D size of {size3} (2..{MAX_SIZE} is read)")
        if len(rows) < size3 ** 3:
            raise LutError(f"{len(rows)} entries, {size3 ** 3} expected")
        cube = data[-size3 ** 3:].reshape(size3, size3, size3, 3)     # [b][g][r]: red fastest in the file
        return size3, shaper, np.ascontiguousarray(cube.transpose(2, 1, 0, 3)).astype(np.float32).reshape(-1)
    if size1:
        if not 2 <= size1 <= 65536 or len(rows) < size1:
            raise LutError("a 1D LUT with too few entries")
        tab = data[:size1]
        axis = np.linspace(lo_, hi_, GRID)
        src = np.linspace(lo_, hi_, size1)
        ch = [np.interp(axis, src, tab[:, k]) for k in range(3)]
        R, G, B = np.meshgrid(ch[0], ch[1], ch[2], indexing="ij")
        return GRID, shaper, np.stack([R, G, B], axis=-1).astype(np.float32).reshape(-1)
    raise LutError("no LUT_3D_SIZE or LUT_1D_SIZE")


def _ocio_file(path):
    try:
        import PyOpenColorIO as ocio
    except ImportError:
        raise LutError("only .cube files are read without OpenColorIO") from None
    try:
        cfg = ocio.Config.CreateRaw()
        t = ocio.FileTransform(src=path, interpolation=ocio.INTERP_BEST, direction=ocio.TRANSFORM_DIR_FORWARD)
        cpu = cfg.getProcessor(t).getDefaultCPUProcessor()
    except Exception as e:  # noqa: BLE001
        raise LutError(f"OpenColorIO could not read it: {e}") from None
    axis = np.linspace(0, 1, GRID)
    R, G, B = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.ascontiguousarray(np.stack([R, G, B], axis=-1).reshape(-1, 3), np.float32)
    cpu.applyRGB(grid)
    return GRID, "lin:0:1", grid.reshape(-1)


def load_lut(path):
    """``(size, shaper, data)`` of a LUT file, kept while the file stays as it is. LutError says why not."""
    try:
        st = os.stat(path)
    except OSError:
        raise LutError("no such file") from None
    if st.st_size > MAX_BYTES:
        raise LutError("the file is too large for a LUT")
    key = (path, st.st_mtime_ns, st.st_size)
    with _lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    if path.lower().endswith(".cube"):
        with open(path, encoding="utf-8", errors="replace") as fh:
            got = parse_cube(fh.read())
    else:
        got = _ocio_file(path)
    with _lock:
        _cache[key] = got
        while len(_cache) > 16:
            _cache.pop(next(iter(_cache)))
    return got


# ── ASC CDL ──────────────────────────────────────────────────────────────────

def _local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def _find(el, name):
    for e in el.iter():
        if _local(e.tag) == name:
            return e
    return None


def _three(el, name):
    e = _find(el, name)
    if e is None or not (e.text or "").strip():
        return None
    v = [float(x) for x in e.text.split()]
    if len(v) != 3:
        raise LutError(f"{name} needs three numbers")
    return v


def parse_cdl(text):
    """The first correction in a .cc / .cdl / .ccc: {slope, offset, power, saturation, id}."""
    if len(text) > MAX_CDL_BYTES:
        raise LutError("the file is too large for a CDL")
    if "<!ENTITY" in text.upper():
        raise LutError("entities are not read")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        raise LutError(f"not XML: {e}") from None
    cc = root if _local(root.tag) == "colorcorrection" else _find(root, "colorcorrection")
    if cc is None:
        raise LutError("no ColorCorrection in the file")
    try:
        slope, offset, power = _three(cc, "slope"), _three(cc, "offset"), _three(cc, "power")
        sat = _find(cc, "saturation")
        s = float(sat.text) if sat is not None and (sat.text or "").strip() else 1.0
    except ValueError as e:
        raise LutError(str(e)) from None
    return {"slope": slope or [1, 1, 1], "offset": offset or [0, 0, 0], "power": power or [1, 1, 1], "saturation": s,
            "id": cc.get("id") or ""}


def read_cdl(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return parse_cdl(fh.read(MAX_CDL_BYTES + 1))


def _num(v):
    return f"{float(v):.6g}"


def cdl_text(values, ext=".cc", cid=""):
    """A correction as a .cc (or wrapped in a .cdl / .ccc)."""
    def trio(k, d):
        v = values.get(k) or d
        return " ".join(_num(x) for x in list(v)[:3])
    ident = f' id="{_xml_attr(cid)}"' if cid else ""
    cc = (f"<ColorCorrection{ident}>\n"
          f"    <SOPNode>\n        <Slope>{trio('slope', [1, 1, 1])}</Slope>\n"
          f"        <Offset>{trio('offset', [0, 0, 0])}</Offset>\n        <Power>{trio('power', [1, 1, 1])}</Power>\n    </SOPNode>\n"
          f"    <SatNode>\n        <Saturation>{_num(values.get('saturation', 1))}</Saturation>\n    </SatNode>\n</ColorCorrection>")
    head = '<?xml version="1.0" encoding="UTF-8"?>\n'
    if ext == ".cdl":
        inner = "\n".join("        " + ln for ln in cc.splitlines())
        return f'{head}<ColorDecisionList xmlns="{ASC_NS}">\n    <ColorDecision>\n{inner}\n    </ColorDecision>\n</ColorDecisionList>\n'
    if ext == ".ccc":
        inner = "\n".join("    " + ln for ln in cc.splitlines())
        return f'{head}<ColorCorrectionCollection xmlns="{ASC_NS}">\n{inner}\n</ColorCorrectionCollection>\n'
    return head + cc.replace("<ColorCorrection", f'<ColorCorrection xmlns="{ASC_NS}"', 1) + "\n"


def _xml_attr(s):
    return str(s).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def write_cdl(path, values, cid=""):
    ext = os.path.splitext(path)[1].lower()
    if ext not in CDL_EXTS:
        raise LutError(f"a CDL file ends in {', '.join(CDL_EXTS)}")
    text = cdl_text(values, ext, cid)
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)
    return path
