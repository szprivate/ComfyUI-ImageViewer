"""File-writing backend for bEpicSendToViewer's "save to ./output" mode.

When the node's `save_to_output` toggle is on it persists the incoming frames to
ComfyUI's output directory in a chosen format instead of only pushing temp PNGs
to the viewer. Image formats (exr / tiff / png / jpg / dpx / ...) are written
with OpenImageIO — the same writer used by bepic_templates' bEpic_imageSave —
and video formats (mp4 / mov / webm) are encoded with imageio + imageio_ffmpeg.

Everything degrades gracefully: format discovery and every heavy import is lazy,
so importing this module never fails even when OIIO or ffmpeg are absent — the
menu simply shrinks and a clear error is raised only if an unavailable writer is
actually requested.
"""

import os
import random

import numpy as np
import torch

try:
    import folder_paths
except Exception:  # pragma: no cover - only importable inside ComfyUI
    folder_paths = None


VIDEO_EXTS = ["mp4", "mov", "webm"]

# Image formats a browser can show directly in an <img>; anything else (exr,
# tiff, dpx, ...) is saved as-is but previewed in the viewer via a temp PNG proxy.
_BROWSER_IMG = {"png", "jpg", "jpeg", "webp", "gif", "bmp"}

# Image formats we surface in the dropdown, in menu order. Filtered at import
# time against what OpenImageIO can actually write on this install.
_IMG_MENU = ["png", "exr", "tiff", "jpg", "dpx", "tga", "hdr", "bmp", "webp"]

# Extensions that only OpenImageIO can produce here (no PIL fallback).
_OIIO_ONLY = {"exr", "dpx", "hdr", "tga"}


def _oiio_writable_exts():
    """Set of extensions OpenImageIO can write on this install, or None when OIIO
    is unavailable. Each candidate is verified by asking OIIO to create a writer
    for a dummy filename, so read-only formats are excluded."""
    try:
        import OpenImageIO as oiio
    except Exception:
        return None

    exts = set()
    try:
        ext_list = oiio.get_string_attribute("extension_list") or ""
    except Exception:
        ext_list = ""
    for fmt in ext_list.split(";"):
        if ":" not in fmt:
            continue
        _, raw = fmt.split(":", 1)
        for x in raw.split(","):
            x = x.strip().lower()
            if x:
                exts.add(x)

    writable = set()
    for x in exts:
        try:
            out = oiio.ImageOutput.create("bepic_probe." + x)
        except Exception:
            out = None
        if out is not None:
            writable.add(x)
            try:
                out.close()
            except Exception:
                pass
        else:
            # Clear the pending "no writer" error so OIIO doesn't print it later.
            try:
                oiio.geterror()
            except Exception:
                pass
    return writable or None


def _build_format_menu():
    """Ordered list of formats for the node's file_format dropdown: available
    image formats first (VFX-friendly ones surfaced early), then video."""
    writable = _oiio_writable_exts()
    imgs = []
    for e in _IMG_MENU:
        if writable is None:
            # No OIIO: keep only what PIL can cover.
            if e not in _OIIO_ONLY:
                imgs.append(e)
        elif e in writable or (e == "tiff" and "tif" in writable):
            imgs.append(e)
    if not imgs:
        imgs = ["png"]
    return imgs + VIDEO_EXTS


# Computed once at import; drives the INPUT_TYPES dropdown.
FILE_FORMATS = _build_format_menu()


def is_video(file_format):
    return (file_format or "").lower().lstrip(".") in VIDEO_EXTS


# ── tensor normalisation ─────────────────────────────────────────────────────

def _to_frames(tensor):
    """Normalise an incoming IMAGE [B,H,W,C] / MASK [B,H,W] (or single-frame
    variants) tensor to a float32 numpy array of shape [B,H,W,C], C in {3,4}.
    Masks become 3-channel grayscale."""
    if not isinstance(tensor, torch.Tensor):
        tensor = torch.as_tensor(tensor)
    t = tensor.detach().cpu().float()

    if t.ndim == 2:            # H,W  (single mask)
        t = t.unsqueeze(0).unsqueeze(-1)          # 1,H,W,1
    elif t.ndim == 3:
        # B,H,W (mask batch) vs H,W,C (single image): a trailing 3/4 means chans
        if t.shape[-1] in (1, 3, 4):
            t = t.unsqueeze(0)                    # 1,H,W,C
        else:
            t = t.unsqueeze(-1)                  # B,H,W,1
    elif t.ndim == 4:
        pass                                     # B,H,W,C
    else:
        raise ValueError(f"unsupported tensor shape {tuple(t.shape)}")

    arr = t.numpy()
    c = arr.shape[-1]
    if c == 1:
        arr = np.repeat(arr, 3, axis=-1)
    return np.ascontiguousarray(arr, dtype=np.float32)


# ── image writing (OpenImageIO, PIL fallback) ────────────────────────────────

def _oiio_type(oiio, ext):
    """Pick a sensible bit depth per format (half for EXR/HDR, 16-bit for
    dpx/tiff, else 8-bit)."""
    ext = ext.lower()
    if ext in ("exr", "hdr"):
        return oiio.HALF
    if ext in ("dpx", "tif", "tiff"):
        return oiio.UINT16
    return oiio.UINT8


def _write_image_oiio(frame, path, ext):
    import OpenImageIO as oiio
    h, w, nch = frame.shape
    spec = oiio.ImageSpec(w, h, nch, _oiio_type(oiio, ext))   # 4ch auto-names RGBA
    out = oiio.ImageOutput.create(path)
    if out is None:
        raise RuntimeError(f"no OpenImageIO writer for '{path}'")
    if not out.open(path, spec):
        raise RuntimeError(f"could not open '{path}': {out.geterror()}")
    if not out.write_image(frame):
        err = out.geterror()
        out.close()
        raise RuntimeError(f"failed writing '{path}': {err}")
    out.close()


def _write_image_pil(frame, path, ext):
    from PIL import Image
    u8 = np.clip(frame * 255.0, 0, 255).astype(np.uint8)
    if ext in ("jpg", "jpeg") and u8.shape[-1] == 4:
        u8 = u8[:, :, :3]                        # jpeg has no alpha
    mode = "RGBA" if u8.shape[-1] == 4 else "RGB"
    Image.fromarray(u8, mode).save(path)


def _write_image(frame, path, ext):
    try:
        import OpenImageIO  # noqa: F401
        _write_image_oiio(frame, path, ext)
        return
    except ImportError:
        if ext in _OIIO_ONLY:
            raise RuntimeError(
                f"'{ext}' requires the OpenImageIO python module "
                "(pip install OpenImageIO)")
        _write_image_pil(frame, path, ext)


# ── video writing (imageio + imageio_ffmpeg) ─────────────────────────────────

def _pad_even(frame_u8):
    """Pad H/W up to the next even size (edge replication) so yuv420p encoders
    accept the frame without silently rescaling it."""
    h, w = frame_u8.shape[:2]
    ph, pw = h % 2, w % 2
    if ph or pw:
        frame_u8 = np.pad(frame_u8, ((0, ph), (0, pw), (0, 0)), mode="edge")
    return frame_u8


def _write_video(frames, path, fps, ext):
    """Encode a [B,H,W,C] float array to a single video file at `fps`."""
    import imageio

    fps = float(fps) if fps and fps > 0 else 24.0
    if ext == "webm":
        writer = imageio.get_writer(path, fps=fps, codec="libvpx-vp9",
                                    macro_block_size=1)
    else:  # mp4 / mov → H.264
        writer = imageio.get_writer(path, fps=fps, codec="libx264", quality=8,
                                    macro_block_size=1, pixelformat="yuv420p")
    try:
        for i in range(frames.shape[0]):
            u8 = np.clip(frames[i, :, :, :3] * 255.0, 0, 255).astype(np.uint8)
            writer.append_data(_pad_even(u8))
    finally:
        writer.close()


def _write_temp_proxies(frames, tag):
    """Write browser-displayable PNG proxies to the temp dir for formats the
    viewer can't render directly (exr / tiff / dpx / ...). Returns viewer frame
    dicts pointing at the proxies."""
    from PIL import Image
    try:
        tmp = folder_paths.get_temp_directory()
        os.makedirs(tmp, exist_ok=True)
    except Exception:
        return []
    safe = "".join(c for c in (tag or "out") if c.isalnum() or c in "-_") or "out"
    rnd = random.randint(1, 1_000_000)
    frames_out = []
    for i in range(frames.shape[0]):
        u8 = np.clip(frames[i, :, :, :3] * 255.0, 0, 255).astype(np.uint8)
        name = f"bEpic_proxy_{safe}_{i:04d}_{rnd}.png"
        path = os.path.join(tmp, name)
        Image.fromarray(u8, "RGB").save(path, compress_level=4)
        frames_out.append({"path": path, "type": "temp"})
    return frames_out


def _prepare_output(filename_prefix, w, h):
    """Resolve (full_folder, filename, counter, subfolder) for `filename_prefix`
    under ComfyUI's output dir, pre-creating any subfolder in the prefix so
    get_save_image_path's counter scan and the subsequent writes both succeed."""
    out_dir = folder_paths.get_output_directory()
    prefix = (filename_prefix or "bEpic").strip().strip('"') or "bEpic"
    sub = os.path.dirname(prefix)
    if sub:
        try:
            os.makedirs(os.path.join(out_dir, sub), exist_ok=True)
        except Exception:
            pass
    full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, out_dir, w, h)
    try:
        os.makedirs(full_folder, exist_ok=True)
    except Exception:
        pass
    return full_folder, filename, counter, subfolder


# ── ComfyUI VIDEO objects ────────────────────────────────────────────────────

def is_video_input(obj):
    """True for a ComfyUI native VIDEO object (comfy_api VideoInput), duck-typed
    so it works across comfy_api versions without importing it."""
    return (obj is not None
            and hasattr(obj, "get_components")
            and hasattr(obj, "save_to")
            and hasattr(obj, "get_frame_rate"))


def write_video_input(video_obj, save_to_output, filename_prefix, file_format, fps):
    """Handle a ComfyUI VIDEO input: always produce a viewer-playable file, and
    persist it to ./output when the toggle is on. Returns (saved_paths,
    viewer_frames). mp4 targets use the video's own encoder (keeps audio); other
    formats extract the frames and reuse write_output."""
    if folder_paths is None:
        raise RuntimeError("folder_paths unavailable (not running inside ComfyUI)")

    try:
        rate = float(video_obj.get_frame_rate())
    except Exception:
        rate = float(fps) if fps and fps > 0 else 24.0
    ext = (file_format or "mp4").lower().lstrip(".")

    # Native mp4 path (preserves audio): used when just previewing (toggle off)
    # or when the requested output format is mp4.
    if (not save_to_output) or ext == "mp4":
        if save_to_output:
            try:
                w, h = video_obj.get_dimensions()
            except Exception:
                w = h = 0
            full_folder, filename, counter, subfolder = _prepare_output(filename_prefix, w, h)
            file = f"{filename}_{counter:05}_.mp4"
            path = os.path.join(full_folder, file)
        else:
            tmp = folder_paths.get_temp_directory()
            os.makedirs(tmp, exist_ok=True)
            file = f"bEpic_vid_{random.randint(1, 1_000_000_000)}.mp4"
            path = os.path.join(tmp, file)
            subfolder = ""
        video_obj.save_to(path)
        try:
            frames = int(video_obj.get_frame_count())
        except Exception:
            frames = 0
        vframe = {
            "path": path, "type": "output" if save_to_output else "temp",
            "kind": "video", "fps": rate, "frames": frames,
            "filename": file, "subfolder": subfolder,
        }
        print(f"[bEpicSendToViewer] {'saved' if save_to_output else 'buffered'} "
              f"video {path} ({frames} frames @ {rate} fps)")
        return ([path] if save_to_output else []), [vframe]

    # Non-mp4 output format: extract frames and route through the image/video
    # writer (audio is dropped for these formats).
    images = video_obj.get_components().images
    return write_output(images, filename_prefix, ext, rate)


# ── public entry point ───────────────────────────────────────────────────────

def write_output(tensor, filename_prefix, file_format, fps):
    """Persist `tensor` to the ComfyUI output directory in `file_format`.

    Returns (saved_paths, viewer_frames): `saved_paths` are the files written to
    ./output; `viewer_frames` are frame dicts for the viewer to display — the
    saved files themselves for video and browser-friendly images, or temp PNG
    proxies for formats a browser can't render (exr / tiff / dpx / ...)."""
    if tensor is None:
        return [], []
    if folder_paths is None:
        raise RuntimeError("folder_paths unavailable (not running inside ComfyUI)")

    ext = (file_format or "png").lower().lstrip(".")
    frames = _to_frames(tensor)
    n, h, w = frames.shape[0], frames.shape[1], frames.shape[2]

    full_folder, filename, counter, subfolder = _prepare_output(filename_prefix, w, h)

    saved, viewer_frames = [], []

    if is_video(ext):
        file = f"{filename}_{counter:05}_.{ext}"
        path = os.path.join(full_folder, file)
        _write_video(frames, path, fps, ext)
        saved.append(path)
        viewer_frames.append({
            "path": path, "type": "output", "kind": "video",
            "fps": float(fps) if fps and fps > 0 else 24.0, "frames": int(n),
            "filename": file, "subfolder": subfolder,
        })
        print(f"[bEpicSendToViewer] wrote {path} ({n} frames @ {viewer_frames[0]['fps']} fps)")
    else:
        for i in range(n):
            file = f"{filename}_{counter:05}_.{ext}"
            path = os.path.join(full_folder, file)
            _write_image(frames[i], path, ext)
            saved.append(path)
            counter += 1
        print(f"[bEpicSendToViewer] wrote {n} {ext} file(s) to {full_folder}")
        if ext in _BROWSER_IMG:
            viewer_frames = [{"path": p, "type": "output"} for p in saved]
        else:
            viewer_frames = _write_temp_proxies(frames, filename)

    return saved, viewer_frames
