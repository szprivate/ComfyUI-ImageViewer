"""A pose from a picture through ComfyUI's SAM 3D Body nodes (src/body_pose.py): MHR70 -> MediaPipe's 33,
the graph the page queues, the picture put where LoadImage reads it."""
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
import body_pose as B  # noqa: E402


def mhr70(offset=(0.0, 0.0, 0.0)):
    """70 keypoints: point i at (i, 2i, 3i) / 100, shifted."""
    return [[i / 100 + offset[0], 2 * i / 100 + offset[1], 3 * i / 100 + offset[2]] for i in range(70)]


class BodyPose(unittest.TestCase):
    def test_landmarks_are_mediapipes_33_about_the_hips(self):
        L = B.landmarks_of(mhr70((5.0, -1.0, 3.0)))
        self.assertEqual(len(L), 33)
        hips = [(9 + 10) / 200, 2 * (9 + 10) / 200, 3 * (9 + 10) / 200]
        at = lambda mhr: [round(v - h, 5) for v, h in zip([mhr / 100, 2 * mhr / 100, 3 * mhr / 100], hips)]
        self.assertEqual(L[11][:3], at(5))       # left shoulder
        self.assertEqual(L[16][:3], at(41))      # right wrist
        self.assertEqual(L[15][:3], at(62))      # left wrist
        self.assertEqual(L[19][:3], at(49))      # left index knuckle
        self.assertEqual(L[31][:3], at(15))      # left big toe
        self.assertEqual(L[30][:3], at(20))      # right heel
        self.assertEqual(L[1], [0.0, 0.0, 0.0, 0.0])      # no inner eye in MHR70
        self.assertEqual(L[23][3], 1.0)
        with self.assertRaises(ValueError):
            B.landmarks_of(mhr70()[:20])

    def test_people_biggest_first_and_a_batch_of_one(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("needs numpy")
        small = {"bbox": np.array([0, 0, 10, 10.0]), "pred_keypoints_3d": np.array(mhr70())}
        big = {"bbox": [0, 0, 100, 200], "pred_keypoints_3d": [mhr70()]}
        got = B.people_of({"frames": [[small, big, {"bbox": [0, 0, 1, 1]}]]})
        self.assertEqual([p["size"] for p in got], [20000.0, 100.0])
        self.assertEqual(len(got[0]["landmarks"]), 33)
        self.assertEqual(B.people_of({"frames": []}), [])

    def test_the_model_is_found_by_its_name(self):
        self.assertEqual(B.find_model(["a.pt", "sub/sam_3d_body_dinov3_bf16.safetensors"]), "sub/sam_3d_body_dinov3_bf16.safetensors")
        self.assertEqual(B.find_model(["SAM-3D-Body_vith_fp16.safetensors"]), "SAM-3D-Body_vith_fp16.safetensors")
        self.assertIsNone(B.find_model(["rt_detr.safetensors"]))

    def test_the_graph_ends_in_the_viewers_node(self):
        g = B.graph("rig_pose/x.png", "sam.safetensors", 40)
        self.assertEqual(g[B.OUTPUT_NODE]["class_type"], "ImageViewerBodyPose")
        self.assertEqual(g["3"]["inputs"]["fov"], 40.0)
        self.assertEqual(g["1"]["inputs"]["image"], "rig_pose/x.png")
        self.assertEqual(g["2"]["inputs"]["model_file"], "sam.safetensors")

    def test_a_picture_is_put_where_loadimage_reads_it(self):
        tmp = tempfile.mkdtemp()
        try:
            inp, out = os.path.join(tmp, "input"), os.path.join(tmp, "output")
            os.makedirs(os.path.join(inp, "refs")); os.makedirs(out)
            inside = os.path.join(inp, "refs", "a.png")
            outside = os.path.join(out, "b.png")
            for p in (inside, outside):
                with open(p, "wb") as fh:
                    fh.write(p.encode())
            self.assertEqual(B.place_in_input(inside, inp), "refs/a.png")
            name = B.place_in_input(outside, inp)
            self.assertTrue(name.startswith("rig_pose/") and name.endswith("_b.png"), name)
            self.assertEqual(B.place_in_input(outside, inp), name)            # the same picture: the same file
            with open(os.path.join(inp, *name.split("/")), "rb") as fh:
                self.assertEqual(fh.read(), outside.encode())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
