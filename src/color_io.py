"""The viewer's colour transform: a picture's input colourspace -> sRGB.

The viewer shows 8-bit sRGB. What a file holds is another matter — a ComfyUI
tensor written into an EXR as it is, an ACEScg render, a log plate — and only the
user knows which. So the input colourspace is picked in the viewer (the selector
beside Exposure) and the picture is converted from it to sRGB when it is served.

The output side is fixed, and it is the config's own sRGB output — the rule
bepic_templates' colour transform node starts on: "Output - sRGB" of an OCIO v1
ACES config (which carries the tone curve), the sRGB display with its default
view on a v2 config. Picking that same sRGB as the input is "leave it alone".

The colourspaces are the ones of the OpenColorIO config picked in Settings ->
ComfyUI Image Viewer -> Comp (a .ocio file or one of PyOpenColorIO's built-in
configs, kept per OS user in ~/.comfyui_image_viewer/ocio_config.txt), else the
one the rest of the pipeline uses: `$OCIO` when it is set, else the config built
into PyOpenColorIO. Without
PyOpenColorIO there are still two — sRGB and Linear — done in numpy, so a
scene-linear EXR is never stuck looking black.
"""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np

try:
    import PyOpenColorIO as ocio
except Exception:  # pragma: no cover - optional
    ocio = None


BUILTIN_SRGB = "sRGB"
BUILTIN_LINEAR = "Linear"

# Offered at the top of the selector when the config has them, by exact name:
# the spaces a picture here is likely to be in.
_COMMON = ("ACES - ACEScg", "ACEScg", "Utility - Linear - sRGB", "Linear Rec.709 (sRGB)",
           "Utility - sRGB - Texture", "sRGB Encoded Rec.709 (sRGB)", "sRGB - Texture",
           "ACES - ACES2065-1", "ACES2065-1", "ACES - ACEScct", "ACEScct",
           "Utility - Raw", "Raw")

_lock = threading.Lock()
_state = None            # what _load() found, built once
_processors = {}         # (from, to) -> CPUProcessor; to is None for "to sRGB"
_pool = None             # strips of one frame, converted side by side


def _find(names, *required, exclude=()):
    """First name containing every *required* substring and none of *exclude*."""
    for name in names:
        low = name.lower()
        if all(s in low for s in required) and not any(s in low for s in exclude):
            return name
    return None


CONFIG_FILE_NAME = "ocio_config.txt"
# PyOpenColorIO's own configs, offered by name in the settings (OCIO 2.2+).
BUILTIN_CONFIGS = (
    ("ocio://default", "Built-in default (CG config, ACEScg working space)"),
    ("ocio://cg-config-latest", "Built-in CG config (ACES), latest"),
    ("ocio://studio-config-latest", "Built-in studio config (ACES, cameras and logs), latest"),
)
_config_error = ""       # why the chosen config could not be read, for the settings page


def config_file():
    """Where the chosen config is kept: per OS user, beside the viewer's other files."""
    try:
        from .legacy_names import user_dir
    except ImportError:  # pragma: no cover - run outside the package
        from legacy_names import user_dir
    return os.path.join(user_dir(), CONFIG_FILE_NAME)


def chosen_config():
    """The config picked in the settings ("" = none: $OCIO, else the built-in one)."""
    try:
        with open(config_file(), encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _read_config(choice):
    if choice.startswith("ocio://"):
        return ocio.Config.CreateFromBuiltinConfig(choice)
    return ocio.Config.CreateFromFile(choice)


def check_config(choice):
    """The cleaned choice, or ValueError saying why it cannot be used. An empty one clears it."""
    choice = str(choice or "").strip().strip('"')
    if not choice:
        return ""
    if len(choice) > 1000:
        raise ValueError("That path is too long.")
    if choice.startswith("ocio://"):
        if ocio is None:
            raise ValueError("OpenColorIO is not installed on the ComfyUI machine.")
    else:
        choice = os.path.abspath(os.path.expandvars(os.path.expanduser(choice)))
        if os.path.splitext(choice)[1].lower() != ".ocio":
            raise ValueError("An OCIO config is a .ocio file.")
        if not os.path.isfile(choice):
            raise ValueError(f"There is no file at {choice}.")
        if ocio is None:
            raise ValueError("OpenColorIO is not installed on the ComfyUI machine.")
    try:
        _read_config(choice).validate()
    except Exception as e:  # noqa: BLE001 - OCIO's own words
        raise ValueError(f"OpenColorIO could not read it: {e}") from None
    return choice


def set_config(choice):
    """Keep the chosen config (checked first) and start using it at once; "" goes back to $OCIO / built-in."""
    choice = check_config(choice)
    path = config_file()
    if choice:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(choice + "\n")
    elif os.path.exists(path):
        os.remove(path)
    reset()
    return choice


def reset():
    """Forget the loaded config and everything made from it (the next call reads it again)."""
    global _state
    with _lock:
        _state = None
        _processors.clear()
    try:
        from . import comp_ocio
        comp_ocio.reset()
    except ImportError:  # pragma: no cover
        pass


def config_tag():
    """A short name of the config in use, for caches of converted pictures (the same name in two configs differs)."""
    import hashlib
    st = _load()
    return hashlib.sha1(st.get("source_path", st["source"]).encode("utf-8", "replace")).hexdigest()[:6]


def config_state():
    """What the settings page shows: the choice, where the config in use came from, and any trouble."""
    st = _load()
    return {"chosen": chosen_config(), "source": st["source"], "path": st.get("source_path", ""),
            "error": _config_error, "available": st["config"] is not None, "ocio": ocio is not None,
            "env": os.environ.get("OCIO", ""), "file": config_file(), "colorspaces": len(st["names"]),
            "builtin": [{"value": v, "label": label} for v, label in BUILTIN_CONFIGS]}


def _open_config():
    """(config, where it came from, its path). The settings' choice first, then `$OCIO`
    — it is what every other application of the pipeline reads — then PyOpenColorIO's own."""
    global _config_error
    _config_error = ""
    choice = chosen_config()
    if choice:
        try:
            return _read_config(choice), "settings", choice
        except Exception as e:  # noqa: BLE001
            _config_error = f"{choice} could not be read ({e}); using {'$OCIO' if os.environ.get('OCIO') else 'the built-in config'}"
            print(f"[ImageViewer] the OCIO config chosen in the settings: {_config_error}")
    if os.environ.get("OCIO"):
        try:
            return ocio.Config.CreateFromEnv(), "$OCIO", os.environ["OCIO"]
        except Exception as e:
            print(f"[ImageViewer] the OCIO config in $OCIO could not be read ({e}); "
                  "using PyOpenColorIO's built-in one")
    return ocio.Config.CreateFromBuiltinConfig("ocio://default"), "built-in", "ocio://default"


def _srgb_view(cfg):
    """(display, view) of the config's sRGB display on OCIO v2, else None.

    A v1 ACES config bakes the tone curve into "Output - sRGB", so converting to
    that colourspace is the display path. v2 splits the view transform back out:
    converting to "sRGB - Display" there applies the encoding only."""
    if cfg.getMajorVersion() < 2:
        return None
    try:
        for display in cfg.getDisplays():
            if "srgb" in display.lower():
                return display, cfg.getDefaultView(display)
    except Exception:
        pass
    return None


def _load():
    """{config, source, names, families, target, view, linear}, built once."""
    global _state
    with _lock:
        if _state is not None:
            return _state
        state = {"config": None, "source": "none", "names": [BUILTIN_SRGB, BUILTIN_LINEAR],
                 "families": {}, "target": BUILTIN_SRGB, "view": None, "linear": BUILTIN_LINEAR}
        if ocio is not None:
            try:
                cfg, source, source_path = _open_config()
                names = list(cfg.getColorSpaceNames())
                target = (_find(names, "output", "srgb")
                          or _find(names, "srgb", "display")
                          or next((n for n in names if n.lower() == "srgb"), None)
                          or _find(names, "srgb", exclude=("linear", "lin_")))
                if target:
                    # "Linear" as the pipeline means it: the config's working
                    # space. It is also what OpenImageIO resolves "linear" to,
                    # which is how scene-linear files were shown before.
                    role = cfg.getColorSpace(ocio.ROLE_SCENE_LINEAR)
                    linear = role.getName() if role is not None else None
                    if linear not in names:
                        linear = (_find(names, "linear", "srgb", exclude=("ap1", "p3"))
                                  or _find(names, "linear", "rec.709") or target)
                    families = {}
                    for name in names:
                        try:
                            families[name] = cfg.getColorSpace(name).getFamily() or ""
                        except Exception:
                            families[name] = ""
                    state = {"config": cfg, "source": source, "names": names,
                             "families": families, "target": target,
                             "view": _srgb_view(cfg), "linear": linear, "source_path": source_path}
                else:
                    print("[ImageViewer] the OCIO config has no sRGB colourspace; "
                          "the viewer offers sRGB and Linear only")
            except Exception as e:
                print(f"[ImageViewer] OpenColorIO is not usable ({e}); "
                      "the viewer offers sRGB and Linear only")
        _state = state
        return _state


def info():
    """What the selector needs: the names, which one is sRGB (nothing done),
    which one is the working linear space, and a short list for the top."""
    st = _load()
    seen, top = set(), []
    for name in [st["target"], st["linear"]] + [n for n in _COMMON if n in st["names"]]:
        if name and name not in seen:
            seen.add(name)
            top.append(name)
    return {
        "source": st["source"],
        "target": st["target"],
        "linear": st["linear"],
        "common": top,
        "colorspaces": [{"name": n, "family": st["families"].get(n, "")} for n in st["names"]],
    }


def is_identity(colorspace):
    """True when *colorspace* needs nothing done: it is sRGB, or not a name the
    config has (a selection kept from another config must not break the picture)."""
    st = _load()
    return (not colorspace) or colorspace == st["target"] or colorspace not in st["names"]


def _processor(colorspace, to=None):
    """The CPU processor from *colorspace* to another colourspace, or — *to*
    left out — to the viewer's sRGB."""
    st = _load()
    key = (colorspace, to)
    with _lock:
        if key not in _processors:
            cfg = st["config"]
            if to is not None:
                proc = cfg.getProcessor(colorspace, to)
            elif st["view"]:
                proc = cfg.getProcessor(
                    ocio.DisplayViewTransform(src=colorspace, display=st["view"][0],
                                              view=st["view"][1]),
                    ocio.TRANSFORM_DIR_FORWARD)
            else:
                proc = cfg.getProcessor(colorspace, st["target"])
            _processors[key] = proc.getDefaultCPUProcessor()
        return _processors[key]


def _apply(cpu, rgb):
    """cpu.applyRGB over *rgb*, a frame's rows split across threads: the call
    releases the GIL and a 4K frame is otherwise the slow part of serving it."""
    global _pool
    rows = rgb.shape[0]
    parts = min(os.cpu_count() or 1, 8, rgb.size // 1_500_000)
    if parts < 2 or rows < parts:
        cpu.applyRGB(rgb)
        return
    with _lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="imageviewer-ocio")
    edges = np.linspace(0, rows, parts + 1).astype(int)
    list(_pool.map(lambda ab: cpu.applyRGB(rgb[ab[0]:ab[1]]), zip(edges[:-1], edges[1:])))


def to_srgb(rgb, colorspace, ev=0.0):
    """Convert *rgb* — float32, [H,W,3], contiguous — from *colorspace* to sRGB,
    in place. Returns it.

    *ev* is the viewer's exposure, in stops, and it is applied to the light, not
    to the picture on screen: the values are taken to the config's working
    linear space, multiplied there, and only then converted for display. That is
    what lets a stop down bring back a highlight the display transform would
    have clipped — which no adjustment of the converted picture can do.
    """
    if is_identity(colorspace):
        return rgb
    st = _load()
    gain = float(2.0 ** ev) if ev else 1.0
    if st["config"] is None:
        # No OpenColorIO: the one transform there is, the sRGB curve.
        if gain != 1.0:
            rgb *= gain
        np.clip(rgb, 0.0, None, out=rgb)
        rgb[...] = np.where(rgb <= 0.0031308, rgb * 12.92,
                            1.055 * np.power(rgb, 1.0 / 2.4) - 0.055)
        return rgb
    if gain == 1.0:
        _apply(_processor(colorspace), rgb)
        return rgb
    linear = st["linear"]
    if colorspace != linear:
        _apply(_processor(colorspace, linear), rgb)
    rgb *= gain
    _apply(_processor(linear), rgb)
    return rgb
