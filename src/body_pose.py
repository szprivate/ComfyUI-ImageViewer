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
        found.append({"landmarks": landmarks_of(kp), "box": box, "size": size})
    found.sort(key=lambda p: -p["size"])
    return found


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
