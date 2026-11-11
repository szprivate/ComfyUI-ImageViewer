"""Read a person's body pose from a film, frame by frame, for the viewer's motion from video.

Run by the viewer (src/rig_routes.py) with the posetrack environment's own Python
(scripts/rig/install_rig_tools.py --only posetrack):

    python video_pose_run.py --model pose_landmarker_heavy.task --video clip.mp4 --output pose.json
                             [--start 0] [--end -1] [--step 1]

It runs Google's MediaPipe Pose Landmarker (BlazePose GHUM 3D; code and model Apache-2.0) in its
video mode: one person, the 33 body landmarks per frame. The answer:

    {"fps", "width", "height", "frames": [{"i": film frame, "t": seconds,
      "world": [[x, y, z, visibility] * 33] | null,     metres, about the hips' middle (y down, z away)
      "image": [[x, y, z, visibility] * 33] | null}]}    x, y as fractions of the picture

Lines starting "!! " are errors the viewer shows; "progress <done> <total>" lines are its progress.
Nothing here is the viewer's code: it only runs it and reads the numbers back.
"""
import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=-1)
    ap.add_argument("--step", type=int, default=1)
    a = ap.parse_args()
    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
    except ImportError as e:
        print(f"!! the posetrack environment lacks {e.name}: run the installer with --only posetrack", flush=True)
        sys.exit(2)

    cap = cv2.VideoCapture(a.video)
    if not cap.isOpened():
        print(f"!! could not open the film: {a.video}", flush=True)
        sys.exit(3)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    end = total - 1 if a.end < 0 or (total and a.end >= total) else a.end
    step = max(1, a.step)

    options = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=a.model),
        running_mode=vision.RunningMode.VIDEO, num_poses=1,
        min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.5)
    out = {"fps": fps, "width": width, "height": height, "frames": []}
    print(f"film {width}x{height} at {fps:.3f} fps, frames {a.start}..{end}", flush=True)
    with vision.PoseLandmarker.create_from_options(options) as marker:
        i = 0
        while True:
            ok, frame = cap.read()
            if not ok or (end >= 0 and i > end):
                break
            if i >= a.start and (i - a.start) % step == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                res = marker.detect_for_video(image, int(round(i * 1000.0 / fps)))
                world = res.pose_world_landmarks[0] if res.pose_world_landmarks else None
                img = res.pose_landmarks[0] if res.pose_landmarks else None
                four = lambda pts: [[round(p.x, 5), round(p.y, 5), round(p.z, 5),
                                     round(float(getattr(p, "visibility", 1.0) or 0.0), 3)] for p in pts]
                out["frames"].append({"i": i, "t": round(i / fps, 5),
                                      "world": four(world) if world else None,
                                      "image": four(img) if img else None})
                done = len(out["frames"])
                if done % 10 == 0:
                    print(f"progress {i - a.start + 1} {max(1, end - a.start + 1)}", flush=True)
            i += 1
    cap.release()
    if not any(f["world"] for f in out["frames"]):
        print("!! no person was found in the film", flush=True)
        sys.exit(4)
    with open(a.output, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print(f"done: {len(out['frames'])} frames", flush=True)


if __name__ == "__main__":
    main()
