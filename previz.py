"""Previz: scene files and rendered shots for the viewer's 3D scenes.

The scene itself is browser-side data (js/bEpicViewer_scene3d.js) kept on the
bEpic 3D Scene node. This module only deals with what has to live on disk:

  • scene files, under `output/3d_scenes/<name>.json`, for reusing a setup
    across workflows;
  • rendered shots, under `output/previz/<name>.mp4`. The viewer plays the shot
    back through a camera and posts one PNG per frame into
    `output/previz/<name>/`; those frames are then encoded into the mp4 and
    deleted, and the node reads the mp4 back as its IMAGE output. Frames are
    uploaded one at a time because that is all a browser canvas can hand over —
    the clip is what survives.

Both folders sit inside ComfyUI's output directory on purpose: nothing here
writes anywhere the viewer's other routes wouldn't (see path_access.py).
"""

import json
import os
import re

import folder_paths

SCENES_DIRNAME = "3d_scenes"
RENDERS_DIRNAME = "previz"
FRAME_RE = re.compile(r"^frame_(\d+)\.png$")


def _safe_name(name, fallback="scene"):
    """A file/folder name from user text: no separators, no surprises."""
    out = "".join(c for c in str(name or "") if c.isalnum() or c in "-_ ").strip()
    out = out.replace(" ", "_")
    return out[:64] or fallback


def scenes_dir(create=False):
    path = os.path.join(folder_paths.get_output_directory(), SCENES_DIRNAME)
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def renders_dir(name=None, create=False):
    path = os.path.join(folder_paths.get_output_directory(), RENDERS_DIRNAME)
    if name:
        path = os.path.join(path, _safe_name(name))
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def scene_path(name):
    return os.path.join(scenes_dir(), f"{_safe_name(name)}.json")


def list_scenes():
    try:
        names = os.listdir(scenes_dir())
    except OSError:
        return []
    out = []
    for n in sorted(names):
        if not n.lower().endswith(".json"):
            continue
        full = os.path.join(scenes_dir(), n)
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append({"name": n[:-5], "path": full, "mtime": st.st_mtime, "size": st.st_size})
    return out


def save_scene(name, scene):
    """Write a scene as JSON. `scene` is already-parsed data, not a string."""
    os.makedirs(scenes_dir(), exist_ok=True)
    path = scene_path(name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(scene, fh, indent=1)
    return path


def load_scene(name):
    with open(scene_path(name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def video_path(name):
    """The rendered shot itself: output/previz/<name>.mp4."""
    return os.path.join(renders_dir(), f"{_safe_name(name)}.mp4")


def frame_path(name, index):
    return os.path.join(renders_dir(name), f"frame_{int(index):04d}.png")


def clear_render(name):
    """Drop the frames of a previous take, so a shorter one can't leave a tail
    of stale frames behind it. Only ever removes `frame_####.png`."""
    folder = renders_dir(name)
    removed = 0
    try:
        names = os.listdir(folder)
    except OSError:
        return 0
    for n in names:
        if not FRAME_RE.match(n):
            continue
        try:
            os.remove(os.path.join(folder, n))
            removed += 1
        except OSError:
            continue
    return removed


def render_frames(name):
    """The rendered frames of `name`, in order."""
    folder = renders_dir(name)
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    numbered = []
    for n in names:
        m = FRAME_RE.match(n)
        if m:
            numbered.append((int(m.group(1)), os.path.join(folder, n)))
    numbered.sort()
    return [p for _i, p in numbered]


def encode_render(name, fps=24.0):
    """Turn the uploaded frames of `name` into output/previz/<name>.mp4.

    The frames are removed afterwards: the clip is the deliverable, and leaving
    both behind would double the disk cost of every take. Raises with a readable
    message when this install has no encoder.
    """
    paths = render_frames(name)
    if not paths:
        raise ValueError("there are no rendered frames to encode")

    import numpy as np
    from PIL import Image
    from . import file_writer

    frames, size = [], None
    for p in paths:
        with Image.open(p) as im:
            im = im.convert("RGB")
            if size is None:
                size = im.size
            elif im.size != size:
                raise ValueError(
                    f"the rendered frames are not all {size[0]}x{size[1]} — "
                    f"render the shot again to replace them")
            frames.append(np.asarray(im, dtype=np.float32) / 255.0)

    out = video_path(name)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        file_writer._write_video(np.stack(frames), out, float(fps or 24.0), "mp4")
    except Exception as e:
        raise ValueError(
            f"could not encode the shot ({e}). Install imageio-ffmpeg, or read "
            f"the frames in {renders_dir(name)} instead.")
    clear_render(name)
    try:
        os.rmdir(renders_dir(name))          # empty now; leave it tidy
    except OSError:
        pass
    return out


def load_render_video(name):
    """The rendered mp4 as an IMAGE tensor [N,H,W,3], or None when there isn't
    one. Decoded with whatever this install has, like the rest of the viewer."""
    path = video_path(name)
    if not os.path.isfile(path):
        return None
    import numpy as np
    import torch

    frames = []
    try:
        import imageio
        reader = imageio.get_reader(path)
        try:
            for frame in reader:
                frames.append(np.asarray(frame)[:, :, :3])
        finally:
            reader.close()
    except Exception:
        frames = []
    if not frames:
        try:
            import cv2
            cap = cv2.VideoCapture(path)
            try:
                while True:
                    ok, bgr = cap.read()
                    if not ok:
                        break
                    frames.append(bgr[:, :, ::-1].copy())
            finally:
                cap.release()
        except Exception:
            frames = []
    if not frames:
        raise ValueError(f"{os.path.basename(path)} is there but nothing on this "
                         f"install could decode it (imageio-ffmpeg / opencv)")
    stacked = np.stack(frames).astype(np.float32) / 255.0
    return torch.from_numpy(stacked)


def load_render(name):
    """The rendered shot as an IMAGE tensor [N,H,W,3], or None when there is
    nothing rendered yet.

    The mp4 is what a finished render leaves behind; a folder of frames is only
    there when a take was interrupted before it could be encoded, and is read as
    a fallback so those frames aren't lost."""
    video = load_render_video(name)
    if video is not None:
        return video
    paths = render_frames(name)
    if not paths:
        return None
    import numpy as np
    import torch
    from PIL import Image

    frames = []
    size = None
    for p in paths:
        with Image.open(p) as im:
            im = im.convert("RGB")
            if size is None:
                size = im.size
            elif im.size != size:
                raise ValueError(
                    f"the rendered frames in {os.path.basename(os.path.dirname(p))} are not all "
                    f"{size[0]}x{size[1]} — render the shot again to replace them")
            frames.append(np.asarray(im, dtype=np.float32) / 255.0)
    return torch.from_numpy(np.stack(frames))
