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

    def test_a_film_hands_over_every_frames_person_with_its_place_in_the_picture(self):
        kp2 = [[i * 10.0, i * 5.0] for i in range(70)]
        person = {"bbox": [0, 0, 100, 200], "pred_keypoints_3d": mhr70(), "pred_keypoints_2d": kp2}
        data = {"frames": [[person], [], [person]], "image_size": (500, 1000)}
        track = B.track_of(data)
        self.assertEqual(len(track), 3)
        self.assertEqual(track[1], {"world": None, "image": None})
        self.assertEqual(len(track[0]["world"]), 33)
        self.assertEqual(track[0]["image"][16], [0.41, 0.41, 0.0, 1.0])     # right wrist: MHR70 41 at (410, 205)
        self.assertEqual(track[0]["image"][1], [0.0, 0.0, 0.0, 0.0])
        out = B.hand_over(data)
        self.assertEqual((out["width"], out["height"]), (1000, 500))
        self.assertNotIn("kp2d", out["people"][0])
        self.assertEqual(len(out["frames"]), 3)
        self.assertNotIn("frames", B.hand_over({"frames": [[person]], "image_size": (500, 1000)}))

    def test_the_film_graph_reads_its_part_and_smooths_when_asked(self):
        g = B.video_graph("rig_pose/film/a_p000.mp4", "sam.safetensors", 0, 1.0)
        self.assertEqual(g["1"], {"class_type": "LoadVideo", "inputs": {"file": "rig_pose/film/a_p000.mp4"}})
        self.assertEqual(g["5"]["class_type"], "GetVideoComponents")
        self.assertEqual(g["6"]["class_type"], "SAM3DBody_Smooth")
        self.assertEqual(g[B.OUTPUT_NODE]["inputs"]["mhr_pose_data"], ["6", 0])
        raw = B.video_graph("x.mp4", "sam.safetensors", 0, 0)
        self.assertNotIn("6", raw)
        self.assertEqual(raw[B.OUTPUT_NODE]["inputs"]["mhr_pose_data"], ["3", 0])

    def test_a_film_is_cut_into_parts_once(self):
        try:
            import av
            import numpy as np
        except ImportError:
            self.skipTest("needs PyAV")
        tmp = tempfile.mkdtemp()
        try:
            src = os.path.join(tmp, "walk.mp4")
            oc = av.open(src, "w")
            vs = oc.add_stream("libx264", rate=24)
            vs.width, vs.height, vs.pix_fmt = 1920, 1080, "yuv420p"
            for i in range(20):
                for pkt in vs.encode(av.VideoFrame.from_ndarray(np.full((1080, 1920, 3), i * 10, np.uint8), format="rgb24")):
                    oc.mux(pkt)
            for pkt in vs.encode():
                oc.mux(pkt)
            oc.close()
            inp = os.path.join(tmp, "input")
            got = B.film_parts(src, inp, 2, 15, 3, side=960, part=3)
            self.assertEqual(got["frames"], [2, 5, 8, 11, 14])
            self.assertEqual([(p["first"], p["count"]) for p in got["parts"]], [(0, 3), (3, 2)])
            with av.open(os.path.join(inp, *got["parts"][0]["name"].split("/"))) as c:
                frames = list(c.decode(video=0))
            self.assertEqual((len(frames), frames[0].width, frames[0].height), (3, 960, 540))
            mtime = os.path.getmtime(os.path.join(inp, *got["parts"][1]["name"].split("/")))
            self.assertEqual(B.film_parts(src, inp, 2, 15, 3, side=960, part=3), got)
            self.assertEqual(os.path.getmtime(os.path.join(inp, *got["parts"][1]["name"].split("/"))), mtime)
            with self.assertRaises(ValueError):
                B.film_parts(src, inp, 30, -1, 1)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

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
