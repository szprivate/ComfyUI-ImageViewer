"""Generate a motion with NVIDIA Kimodo, for the viewer's 3D space.

Run by the viewer (src/rig_routes.py) with Kimodo's own Python:

    python kimodo_run.py --request req.json --output motion.json [--model Kimodo-SOMA-RP-v1.2]
    python kimodo_run.py --serve [--model ...]     one {"request", "output"} JSON per stdin line;
                                                   answers "@@{"done": true}" or "@@{"error": ...}"

The request: {prompt, frames (at Kimodo's 30 fps), keys: [{frame, joints: {SOMA joint: [x,y,z,w]}, root: [x,y,z]}],
seed, steps, samples, heading, postprocess}. A key's joint rotations are global rotations away from SOMA's
standard T-pose (Y up, facing +Z, the left side at +X); joints a key leaves out turn with their parent.
Its root is the hips' position in metres, relative to where the motion starts.

The answer, the same kind of numbers: {fps, joints, parents, rest (the T-pose joint positions relative to
the hips), samples: [{rot [T][77][x,y,z,w] global from the T-pose, root [T][3], contacts [T][4]}]}.

Kimodo's code is Apache-2.0 and its SOMA models are under the NVIDIA Open Model License; its text
encoder (LLM2Vec on Llama 3) is under Meta's Llama 3 licence. None of it is part of the viewer.
"""
import argparse
import json
import math
import os
import sys
import traceback

import numpy as np


def quat_to_mat(q):
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def mat_to_quat(m):
    """[..., 3, 3] -> [..., 4] (x, y, z, w)."""
    m = np.asarray(m, dtype=np.float64)
    flat = m.reshape(-1, 3, 3)
    out = np.zeros((len(flat), 4))
    for i, r in enumerate(flat):
        t = r[0, 0] + r[1, 1] + r[2, 2]
        if t > 0:
            s = math.sqrt(t + 1.0) * 2
            q = [(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, 0.25 * s]
        elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
            s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
            q = [0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s]
        elif r[1, 1] > r[2, 2]:
            s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
            q = [(r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s]
        else:
            s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
            q = [(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s, (r[1, 0] - r[0, 1]) / s]
        out[i] = q
    return out.reshape(m.shape[:-2] + (4,))


def mat_to_axis_angle(m):
    q = mat_to_quat(m)
    q = np.where(q[..., 3:4] < 0, -q, q)
    s = np.linalg.norm(q[..., :3], axis=-1, keepdims=True)
    angle = 2 * np.arctan2(s, q[..., 3:4])
    axis = np.where(s > 1e-9, q[..., :3] / np.maximum(s, 1e-12), 0.0)
    return axis * angle


def key_constraints(keys, names, parents):
    """The keyed poses as one Kimodo full-body constraint (local axis-angle per joint, hips positions)."""
    frames, rots, roots = [], [], []
    for key in sorted(keys, key=lambda k: int(k["frame"])):
        g = np.repeat(np.eye(3)[None], len(names), axis=0)
        given = key.get("joints") or {}
        for j, name in enumerate(names):              # parents come first
            if name in given:
                g[j] = quat_to_mat(given[name])
            elif parents[j] >= 0:
                g[j] = g[parents[j]]
        local = np.empty_like(g)
        for j in range(len(names)):
            local[j] = g[j] if parents[j] < 0 else g[parents[j]].T @ g[j]
        frames.append(int(key["frame"]))
        rots.append(mat_to_axis_angle(local))
        roots.append([float(v) for v in key["root"]])
    if not frames:
        return []
    roots = np.array(roots)
    return [{"type": "fullbody", "frame_indices": frames, "local_joints_rot": np.array(rots).tolist(),
             "root_positions": roots.tolist(), "smooth_root_2d": roots[:, [0, 2]].tolist()}]


def pick_device(torch):
    """KIMODO_DEVICE (cuda, mps, cpu), else CUDA, else Apple's MPS, else the CPU."""
    want = os.environ.get("KIMODO_DEVICE", "").strip().lower()
    if want in ("cuda", "cuda:0"):
        return "cuda:0"
    if want in ("mps", "cpu"):
        return want
    if torch.cuda.is_available():
        return "cuda:0"
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


class Generator:
    def __init__(self, model_name):
        import torch
        from kimodo import load_model
        from kimodo.skeleton import SOMASkeleton77
        self.torch = torch
        self.device = pick_device(torch)
        print(f"Kimodo on {self.device}, loading {model_name}", flush=True)
        try:
            self.model = load_model(model_name, device=self.device, default_family="Kimodo")
        except Exception as e:
            if self.device != "mps":
                raise
            print(f"!! Kimodo would not load on MPS ({type(e).__name__}: {e}); on the CPU", flush=True)
            self.device = "cpu"
            self.model = load_model(model_name, device=self.device, default_family="Kimodo")
        self.skel = SOMASkeleton77()
        self.names = list(self.skel.bone_order_names)
        self.parents = [self.names.index(self.skel.bone_parents[n]) if self.skel.bone_parents[n] else -1
                        for n in self.names]
        self.rest = np.asarray(self.skel.neutral_joints.cpu().numpy(), dtype=np.float64)
        # Kimodo's own clean-up needs its C++ extension, which only builds where there is a compiler.
        import importlib.util
        self.corrects = importlib.util.find_spec("motion_correction") is not None
        if not self.corrects:
            print("Kimodo without motion_correction: no post-processing (the viewer cleans the feet up)", flush=True)
        print("Kimodo ready", flush=True)

    def generate(self, req):
        torch = self.torch
        from kimodo.constraints import load_constraints_lst
        from kimodo.tools import seed_everything
        frames = int(req["frames"])
        texts = [t.strip() + "." for t in str(req["prompt"]).split(".") if t.strip()]
        per = [frames // len(texts)] * len(texts)
        per[-1] += frames - sum(per)
        constraints = key_constraints(req.get("keys") or [], self.names, self.parents)
        lst = load_constraints_lst(constraints, self.model.skeleton, device=self.device) if constraints else []
        if req.get("seed") is not None:
            seed_everything(int(req["seed"]))
        samples = int(req.get("samples") or 1)
        kw = {}
        if req.get("heading"):
            kw["first_heading_angle"] = torch.full((samples,), float(req["heading"]), device=self.device)
        print(f"generating {frames} frames: {' '.join(texts)} ({len(constraints and constraints[0]['frame_indices'])} keys)",
              flush=True)
        out = self.model(texts, per, constraint_lst=lst, num_denoising_steps=int(req.get("steps") or 100),
                         num_samples=samples, multi_prompt=True, post_processing=bool(req.get("postprocess", True)) and self.corrects,
                         return_numpy=True, **kw)
        rots = np.asarray(out["global_rot_mats"])
        joints = np.asarray(out["posed_joints"])
        contacts = np.asarray(out.get("foot_contacts")) if out.get("foot_contacts") is not None else None
        if rots.ndim == 4:
            rots, joints = rots[None], joints[None]
            contacts = contacts[None] if contacts is not None else None
        result = {"fps": float(self.model.fps), "joints": self.names, "parents": self.parents,
                  "rest": np.round(self.rest, 5).tolist(), "samples": []}
        for s in range(rots.shape[0]):
            result["samples"].append({
                "rot": np.round(mat_to_quat(rots[s]), 5).tolist(),
                "root": np.round(joints[s][:, 0, :], 5).tolist(),
                "contacts": (np.round(contacts[s].astype(np.float64), 3).tolist() if contacts is not None else None),
            })
        return result


def run_one(gen, request_path, output_path):
    with open(request_path, encoding="utf-8") as fh:
        req = json.load(fh)
    result = gen.generate(req)
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Kimodo-SOMA-RP-v1.2")
    ap.add_argument("--request")
    ap.add_argument("--output")
    ap.add_argument("--serve", action="store_true")
    a = ap.parse_args()
    gen = Generator(a.model)
    if not a.serve:
        run_one(gen, a.request, a.output)
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            run_one(gen, msg["request"], msg["output"])
            print("@@" + json.dumps({"done": True}), flush=True)
        except Exception as e:  # noqa: BLE001 - answered, and the worker stays up
            traceback.print_exc(file=sys.stdout)
            print("@@" + json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main()
