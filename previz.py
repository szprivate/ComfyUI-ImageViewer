"""Previz: scene files and rendered shots for the viewer's 3D scenes.

The scene itself is browser-side data (js/bEpicViewer_scene3d.js) kept on the
bEpic 3D Scene node. This module only deals with what has to live on disk:

  • scene files. They are saved where every export goes (export_rules: the
    shot's folder, or `output/bepic/scenes`, versioned); `output/3d_scenes` is
    where they went before that and is still read.
  • rendered shots. The viewer plays the shot back through a camera and posts
    one PNG per frame into `output/previz/<name>/` - the take's working folder,
    because that is all a browser canvas can hand over. A finished take is then
    put where every export goes: encoded into a clip, or its frames moved, as a
    new version. `output/previz/<name>.latest.json` says where that was, and it
    is how the node finds the take by its name; a take from before the rule
    (`output/previz/<name>.mp4`, or its frames left in the working folder) is
    still read.

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
# The containers a take can be encoded into, first one the default.
VIDEO_FORMATS = ("mp4", "mov", "webm")
# imageio's 0-10 quality scale, by the names the render dialog uses.
VIDEO_QUALITY = {"high": 9, "medium": 7, "low": 5}


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


def save_scene_at(path, scene):
    """Write a scene as JSON to a path the caller has already decided on."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(scene, fh, indent=1)
    return path


def load_scene_at(path):
    with open(path, "r", encoding="utf-8") as fh:
        scene = json.load(fh)
    if not isinstance(scene, dict) or not isinstance(scene.get("items"), list):
        raise ValueError("that file is not a previz scene")
    return scene


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


def video_path(name, fmt="mp4"):
    """The rendered shot itself: output/previz/<name>.<fmt>."""
    fmt = fmt if fmt in VIDEO_FORMATS else "mp4"
    return os.path.join(renders_dir(), f"{_safe_name(name)}.{fmt}")


def _pointer(name):
    return os.path.join(renders_dir(), f"{_safe_name(name)}.latest.json")


def note_render(name, path=None, folder=None, stem=None):
    """Remember where the finished take of `name` was put (see the module's
    notes): a clip's path, or a sequence's folder and the stem of its frames."""
    note = {"path": path} if path else {"folder": folder, "stem": stem}
    os.makedirs(renders_dir(), exist_ok=True)
    with open(_pointer(name), "w", encoding="utf-8") as fh:
        json.dump(note, fh)


def latest_render(name):
    """What :func:`note_render` wrote, if what it names is still there and still
    inside the output folder - a note is a file, and files get edited."""
    try:
        with open(_pointer(name), "r", encoding="utf-8") as fh:
            note = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(note, dict):
        return None
    root = os.path.abspath(folder_paths.get_output_directory())
    where = note.get("path") or note.get("folder")
    if not isinstance(where, str):
        return None
    where = os.path.abspath(where)
    try:
        if os.path.commonpath([root, where]) != root:
            return None
    except ValueError:
        return None
    if note.get("path"):
        return {"path": where} if os.path.isfile(where) else None
    if not isinstance(note.get("stem"), str) or not os.path.isdir(where):
        return None
    return {"folder": where, "stem": note["stem"]}


def _noted_frames(note):
    """The frames of a take kept as stills, in order."""
    pattern = re.compile(r"^" + re.escape(note["stem"]) + r"\.(\d+)\.png$", re.I)
    numbered = []
    try:
        names = os.listdir(note["folder"])
    except OSError:
        return []
    for n in names:
        m = pattern.match(n)
        if m:
            numbered.append((int(m.group(1)), os.path.join(note["folder"], n)))
    numbered.sort()
    return [p for _i, p in numbered]


def existing_video(name):
    """Whichever clip a take of `name` was encoded into, or None."""
    note = latest_render(name)
    if note and note.get("path"):
        return note["path"]
    for fmt in VIDEO_FORMATS:
        path = video_path(name, fmt)
        if os.path.isfile(path):
            return path
    return None


def frame_path(name, index):
    return os.path.join(renders_dir(name), f"frame_{int(index):04d}.png")


def _clear_frames(name):
    """Drop the loose frames of `name`. Only ever removes `frame_####.png`."""
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


def clear_render(name):
    """Drop everything a previous take of `name` left behind — its frames and
    its mp4 alike. A take is cleared before the new one starts uploading, so a
    shorter take can't leave a tail of stale frames behind it, and a take kept
    as stills isn't read back as the clip an earlier take encoded."""
    removed = _clear_frames(name)
    for fmt in VIDEO_FORMATS:
        try:
            os.remove(video_path(name, fmt))
            removed += 1
        except OSError:
            pass
    # A take put away as a version stays where it is - it is an export, and an
    # export is never written over. Only the note that it is the latest goes.
    try:
        os.remove(_pointer(name))
    except OSError:
        pass
    return removed


def render_frames(name):
    """The rendered frames of `name`, in order: the ones still in the working
    folder (a take that was stopped, or one from before takes were put away),
    else the take that was kept as stills."""
    loose = _working_frames(name)
    if loose:
        return loose
    note = latest_render(name)
    return _noted_frames(note) if note and note.get("folder") else []


def _working_frames(name):
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


def publish_frames(name, seq):
    """Move a take kept as stills out of the working folder to where the rule
    puts it (`seq`: export_rules.sequence_target), keeping each frame's number.
    Returns the new paths."""
    from . import export_rules
    moved = []
    folder = renders_dir(name)
    try:
        names = os.listdir(folder)
    except OSError:
        names = []
    numbered = sorted((int(m.group(1)), n) for n, m in ((n, FRAME_RE.match(n)) for n in names) if m)
    if not numbered:
        raise ValueError("there are no rendered frames to keep")
    os.makedirs(seq["folder"], exist_ok=True)
    for index, n in numbered:
        dst = export_rules.sequence_frame(seq, index)
        os.replace(os.path.join(folder, n), dst)
        moved.append(dst)
    try:
        os.rmdir(folder)
    except OSError:
        pass
    note_render(name, folder=seq["folder"], stem=seq["stem"])
    return moved


def encode_render(name, fps=24.0, fmt="mp4", quality="high", codec=None, out=None):
    """Turn the uploaded frames of `name` into a clip: at `out` when the caller
    has decided where (the export rule), else output/previz/<name>.<fmt>.

    `fmt` is one of VIDEO_FORMATS (mp4 and mov are H.264, webm is VP9) and
    `quality` one of VIDEO_QUALITY's names.

    The frames are removed afterwards: the clip is the deliverable, and leaving
    both behind would double the disk cost of every take. Raises with a readable
    message when this install has no encoder.
    """
    paths = _working_frames(name)
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

    fmt = fmt if fmt in VIDEO_FORMATS else "mp4"
    # One take, one clip: a re-render into another container must not leave
    # the old one behind for the node to read.
    for other in VIDEO_FORMATS:
        if other != fmt:
            try:
                os.remove(video_path(name, other))
            except OSError:
                pass
    placed = bool(out)
    out = out or video_path(name, fmt)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        file_writer._write_video(np.stack(frames), out, float(fps or 24.0), fmt,
                                 quality=VIDEO_QUALITY.get(quality, VIDEO_QUALITY["high"]),
                                 codec=codec)
    except Exception as e:
        raise ValueError(
            f"could not encode the shot ({e}). Install imageio-ffmpeg, or read "
            f"the frames in {renders_dir(name)} instead.")
    _clear_frames(name)
    try:
        os.rmdir(renders_dir(name))          # empty now; leave it tidy
    except OSError:
        pass
    if placed:
        note_render(name, path=out)
    return out


def load_render_video(name):
    """The rendered clip as an IMAGE tensor [N,H,W,3], or None when there isn't
    one. Decoded with whatever this install has, like the rest of the viewer."""
    path = existing_video(name)
    if not path:
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

    The mp4 is what a render asked for as a clip leaves behind; a folder of
    frames is what a render asked for as PNG stills leaves, and what an
    interrupted take leaves before it could be encoded. Either reads back, and
    only one of the two can be there — a new take clears the other."""
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
