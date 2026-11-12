"""A person's pose from a picture through ComfyUI's own SAM 3D Body nodes, for the viewer's Pose dialog.

ComfyUI ships Meta's SAM 3D Body as core nodes (``SAM3DBody_Loader`` -> ``SAM3DBody_Predict``,
``comfy_extras/nodes_sam3d_body.py``; the weights ``sam_3d_body_dinov3_bf16.safetensors`` in
``models/detection``, Comfy-Org's repackage, under Meta's SAM License). The viewer does not run the
model itself: the page queues a small graph (:func:`graph`) whose last node is the pack's
``ImageViewerBodyPose`` (nodes.py), which hands the first person's keypoints back in its ``ui``
answer as MediaPipe's 33 body landmarks (:func:`landmarks_of`), so the same solver reads both
(``imageViewer_rigPoseSpec.js`` solvePicturePose).

SAM 3D Body's 3D keypoints are the MHR70 layout (``sam_3d_body/metadata/mhr70.py``: COCO's body,
the feet, both hands, a few arm points and the neck), metres in the camera's frame (x right, y down,
z forward) - MediaPipe's world landmarks use the same axes, about the hips' middle. This module is
pure: no ComfyUI, no torch.
"""
from __future__ import annotations

import hashlib
from fractions import Fraction
import json
import os
import shutil

# MediaPipe's 33 body landmarks <- MHR70 indices (None: MHR70 has no such point).
# MediaPipe: 0 nose, 1-3 left eye inner / eye / outer, 4-6 right eye ..., 7 / 8 ears, 9 / 10 mouth,
# 11 / 12 shoulders, 13 / 14 elbows, 15 / 16 wrists, 17 / 18 pinkies, 19 / 20 index fingers,
# 21 / 22 thumbs, 23 / 24 hips, 25 / 26 knees, 27 / 28 ankles, 29 / 30 heels, 31 / 32 foot index (big toe).
# A finger is its knuckle (MHR70's "third joint"), as MediaPipe's pinky / index points are.
MP_FROM_MHR70 = [
    0,                  # nose
    None, 1, None,      # left eye
    None, 2, None,      # right eye
    3, 4,               # ears
    None, None,         # mouth
    5, 6, 7, 8,         # shoulders, elbows
    62, 41,             # wrists
    61, 40,             # pinky knuckles
    49, 28,             # index knuckles
    42, 21,             # thumb tips
    9, 10, 11, 12, 13, 14,
    17, 20,             # heels
    15, 18,             # big toes
]
MHR70_HIPS = (9, 10)

# The weights, as ComfyUI's SAM 3D Body tutorial names them.
MODEL = {"name": "sam_3d_body_dinov3_bf16.safetensors", "folder": "detection",
         "url": "https://huggingface.co/Comfy-Org/sam-3d-body/resolve/main/detection/sam_3d_body_dinov3_bf16.safetensors"}
NODES = ("SAM3DBody_Loader", "SAM3DBody_Predict")
OUTPUT_NODE = "4"


def landmarks_of(kp3d):
    """MHR70 keypoints [[x, y, z] * 70] (camera frame) -> 33 MediaPipe world landmarks [[x, y, z, vis]],
    about the hips' middle; a point MHR70 lacks is [0, 0, 0, 0]."""
    pts = [[float(v) for v in p[:3]] for p in kp3d]
    if len(pts) < 70:
        raise ValueError(f"expected the 70 MHR70 keypoints, got {len(pts)}")
    hips = [(pts[MHR70_HIPS[0]][i] + pts[MHR70_HIPS[1]][i]) / 2 for i in range(3)]
    out = []
    for j in MP_FROM_MHR70:
        if j is None:
            out.append([0.0, 0.0, 0.0, 0.0])
        else:
            out.append([round(pts[j][i] - hips[i], 5) for i in range(3)] + [1.0])
    return out


def people_of(mhr_pose_data, frame=0):
    """The people SAM 3D Body found in one frame of its MHR_POSE_DATA, biggest first:
    [{landmarks, box, size}]. ``box`` is [x0, y0, x1, y1] in pixels when it says."""
    frames = (mhr_pose_data or {}).get("frames") or []
    if frame >= len(frames):
        return []
    found = []
    for person in frames[frame] or []:
        kp = person.get("pred_keypoints_3d") if isinstance(person, dict) else None
        if kp is None:
            continue
        kp = kp.tolist() if hasattr(kp, "tolist") else kp
        if kp and isinstance(kp[0], list) and kp[0] and isinstance(kp[0][0], list):
            kp = kp[0]                                   # a leading batch of one
        box = person.get("bbox")
        box = box.tolist() if hasattr(box, "tolist") else box
        box = [float(v) for v in box[:4]] if box is not None and len(box) >= 4 else None
        size = (box[2] - box[0]) * (box[3] - box[1]) if box else 0.0
        kp2 = person.get("pred_keypoints_2d")
        kp2 = kp2.tolist() if hasattr(kp2, "tolist") else kp2
        if kp2 and isinstance(kp2[0], list) and kp2[0] and isinstance(kp2[0][0], list):
            kp2 = kp2[0]
        found.append({"landmarks": landmarks_of(kp), "box": box, "size": size,
                      "kp2d": kp2 if kp2 is not None and len(kp2) >= 70 else None})
    found.sort(key=lambda p: -p["size"])
    return found


def hand_over(mhr_pose_data):
    """What ImageViewerBodyPose answers the page: the first frame's people (a picture) and, for a film,
    every frame's person (:func:`track_of`)."""
    data = mhr_pose_data or {}
    size = data.get("image_size") or (0, 0)
    people = [{k: v for k, v in p.items() if k != "kp2d"} for p in people_of(data, 0)]
    out = {"people": people, "height": int(size[0]), "width": int(size[1])}
    if len(data.get("frames") or []) > 1:
        out["frames"] = track_of(data)
    return out


def _mp33(points, f=lambda p: p):
    """MHR70 points -> MediaPipe's 33 order through ``f`` ([x, y, z, vis] each; a point MHR70 lacks is zeros)."""
    out = []
    for j in MP_FROM_MHR70:
        out.append([0.0, 0.0, 0.0, 0.0] if j is None else f(points[j]))
    return out


def track_of(mhr_pose_data):
    """Every frame of a film read by SAM 3D Body as the pose tracker's frames: [{world, image}] in order,
    the biggest person of each frame; ``world`` as :func:`landmarks_of`, ``image`` the 2D keypoints as
    shares of the picture (x right, y down), both None where nobody was found."""
    data = mhr_pose_data or {}
    h, w = (data.get("image_size") or (0, 0))[:2]
    out = []
    for fi in range(len(data.get("frames") or [])):
        people = people_of(data, fi)
        if not people:
            out.append({"world": None, "image": None})
            continue
        img = None
        kp2 = people[0].get("kp2d")
        if kp2 is not None and w and h:
            img = _mp33(kp2, lambda p: [round(float(p[0]) / w, 5), round(float(p[1]) / h, 5), 0.0, 1.0])
        out.append({"world": people[0]["landmarks"], "image": img})
    return out


def find_model(names):
    """The SAM 3D Body weights among ComfyUI's ``detection`` files (as it lists them), or None."""
    want = MODEL["name"].lower()
    names = [str(n) for n in names or []]
    for n in names:
        if n.replace("\\", "/").split("/")[-1].lower() == want:
            return n
    for n in names:
        b = n.replace("\\", "/").split("/")[-1].lower().replace("-", "_")
        if "sam_3d_body" in b or "sam3d_body" in b:
            return n
    return None


def graph(image_name, model_name, fov=0.0):
    """The API prompt: LoadImage -> SAM3DBody_Predict (full frame, body only) -> ImageViewerBodyPose."""
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "2": {"class_type": "SAM3DBody_Loader", "inputs": {"model_file": model_name}},
        "3": {"class_type": "SAM3DBody_Predict",
              "inputs": {"sam3d_body_model": ["2", 0], "image": ["1", 0], "run_hand_refinement": False,
                         "fov": float(fov or 0.0), "batch_size": 8}},
        OUTPUT_NODE: {"class_type": "ImageViewerBodyPose", "inputs": {"mhr_pose_data": ["3", 0]}},
    }


# A film is read in parts of at most PART_FRAMES frames, made at most FILM_SIDE pixels on its longer side:
# GetVideoComponents holds a part's frames as one float tensor (~6 MB a frame at 960 x 540).
PART_FRAMES = 240
FILM_SIDE = 960
MAX_FILM_FRAMES = 6000


def video_graph(film_name, model_name, fov=0.0, smooth=1.0):
    """The API prompt for one part of a film: LoadVideo -> GetVideoComponents -> SAM3DBody_Predict
    (full frame, body only) -> SAM3DBody_Smooth (when ``smooth`` > 0) -> ImageViewerBodyPose."""
    g = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": film_name}},
        "5": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "2": {"class_type": "SAM3DBody_Loader", "inputs": {"model_file": model_name}},
        "3": {"class_type": "SAM3DBody_Predict",
              "inputs": {"sam3d_body_model": ["2", 0], "image": ["5", 0], "run_hand_refinement": False,
                         "fov": float(fov or 0.0), "batch_size": 8}},
        OUTPUT_NODE: {"class_type": "ImageViewerBodyPose", "inputs": {"mhr_pose_data": ["3", 0]}},
    }
    smooth = max(0.0, min(1.0, float(smooth or 0.0)))
    if smooth > 0:
        g["6"] = {"class_type": "SAM3DBody_Smooth",
                  "inputs": {"mhr_pose_data": ["3", 0], "strength": smooth, "method": "savgol", "window": 7,
                             "rotation_threshold_degrees": 30.0}}
        g[OUTPUT_NODE]["inputs"]["mhr_pose_data"] = ["6", 0]
    return g


def film_parts(src, input_dir, start=0, end=-1, step=1, side=FILM_SIDE, part=PART_FRAMES):
    """Cut the frames ``start..end`` (every ``step``-th) of the film *src* into short H.264 films in
    ``input/rig_pose/film/`` for LoadVideo, at most *side* pixels on the longer side and *part* frames
    each; made once per film and choice (a manifest beside them). Answers {fps, width, height, frames:
    [film frame of each read frame], parts: [{name, first, count}]} (``first`` indexes ``frames``).
    PyAV in this process: no program is started."""
    import av
    st = os.stat(src)
    key = hashlib.sha1(f"{os.path.realpath(src)}|{st.st_mtime_ns}|{st.st_size}|{start}|{end}|{step}|{side}|{part}"
                       .encode("utf-8")).hexdigest()[:12]
    folder = os.path.join(input_dir, "rig_pose", "film")
    manifest = os.path.join(folder, f"{key}.json")
    if os.path.isfile(manifest):
        try:
            with open(manifest, encoding="utf-8") as fh:
                got = json.load(fh)
            if all(os.path.isfile(os.path.join(input_dir, p["name"])) for p in got["parts"]):
                return got
        except (OSError, ValueError, KeyError, TypeError):
            pass
    os.makedirs(folder, exist_ok=True)
    step = max(1, int(step))
    start = max(0, int(start))
    out = {"fps": 24.0, "width": 0, "height": 0, "frames": [], "parts": []}
    writer = None

    def close():
        nonlocal writer
        if writer is None:
            return
        oc, vs, tmp, dst = writer
        for pkt in vs.encode():
            oc.mux(pkt)
        oc.close()
        os.replace(tmp, dst)
        writer = None

    with av.open(src) as ic:
        vin = next((s for s in ic.streams if s.type == "video"), None)
        if vin is None:
            raise ValueError("the film has no picture")
        rate = vin.average_rate or vin.guessed_rate or 24
        out["fps"] = float(rate)
        i = -1
        try:
            for frame in ic.decode(vin):
                i += 1
                if 0 <= end < i:
                    break
                if i < start or (i - start) % step:
                    continue
                if not out["width"]:
                    out["width"], out["height"] = frame.width, frame.height
                    k = min(1.0, side / float(max(frame.width, frame.height)))
                    tw, th = max(2, int(frame.width * k) // 2 * 2), max(2, int(frame.height * k) // 2 * 2)
                if len(out["frames"]) >= MAX_FILM_FRAMES:
                    raise ValueError(f"over {MAX_FILM_FRAMES} frames to read: pick a shorter stretch or read every 2nd frame")
                if writer is None or (len(out["frames"]) - out["parts"][-1]["first"]) >= part:
                    close()
                    n = len(out["parts"])
                    name = f"rig_pose/film/{key}_p{n:03d}.mp4"
                    dst = os.path.join(input_dir, name)
                    tmp = dst + ".partial.mp4"
                    oc = av.open(tmp, "w")
                    try:
                        vs = oc.add_stream("libx264", rate=max(1, int(round(float(rate) / step))))
                        vs.options = {"crf": "14", "preset": "veryfast"}
                    except Exception:  # noqa: BLE001 - a PyAV without x264
                        vs = oc.add_stream("mpeg4", rate=max(1, int(round(float(rate) / step))))
                        vs.options = {"qscale": "2"}
                    vs.width, vs.height, vs.pix_fmt = tw, th, "yuv420p"
                    writer = (oc, vs, tmp, dst)
                    out["parts"].append({"name": name, "first": len(out["frames"]), "count": 0})
                oc, vs = writer[0], writer[1]
                small = frame.reformat(width=tw, height=th, format="yuv420p")
                small.pts = out["parts"][-1]["count"]
                small.time_base = Fraction(1, max(1, int(round(float(rate) / step))))
                for pkt in vs.encode(small):
                    oc.mux(pkt)
                out["frames"].append(i)
                out["parts"][-1]["count"] += 1
            close()
        except BaseException:
            if writer is not None:
                try:
                    writer[0].close()
                    os.remove(writer[2])
                except OSError:
                    pass
            raise
    if not out["frames"]:
        raise ValueError("no frames in that stretch of the film")
    tmp = manifest + ".partial"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    os.replace(tmp, manifest)
    return out


def place_in_input(src, input_dir):
    """The name LoadImage reads *src* by: its path below ComfyUI's input folder, else a copy in
    ``input/rig_pose/`` named by its contents (the same picture twice is one file)."""
    inp = os.path.realpath(input_dir)
    real = os.path.realpath(src)
    if os.path.commonpath([inp, real]) == inp:
        return os.path.relpath(real, inp).replace(os.sep, "/")
    h = hashlib.sha1()
    with open(real, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    base = os.path.basename(real)
    name = f"{h.hexdigest()[:10]}_{base}"
    dst = os.path.join(inp, "rig_pose", name)
    if not os.path.isfile(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst + ".partial"
        shutil.copyfile(real, tmp)
        os.replace(tmp, dst)
    return "rig_pose/" + name
