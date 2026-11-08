"""Paint draws the page and the server draws the files with ONE arithmetic (paint_math.py and
js/imageViewer_paintData.js): the same documents - every blend mode, every adjustment, masks,
opacity, layers off the canvas - composited by both must come out the same, pixel for pixel
(1 level of 255 is allowed where float rounding in pow / sqrt differs).

Run: python -m unittest tests.test_paint_parity   (needs node and numpy; skipped without)
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_math as M, np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
b64 = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def rnd_doc(seed, blends, adjust=None, size=(37, 29)):
    rng = np.random.default_rng(seed)
    W, H = size
    d = P.PaintDoc(W, H, f"case{seed}")
    bg = rng.integers(0, 256, (H, W, 4), dtype=np.uint8)
    bg[..., 3] = rng.choice([0, 128, 255, 255, 255], (H, W)).astype(np.uint8)
    d.add_pixel_layer(bg, "bg")
    for i, mode in enumerate(blends):
        w, h = int(rng.integers(8, W + 10)), int(rng.integers(8, H + 10))
        px = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
        L = d.add_pixel_layer(px, f"l{i}", int(rng.integers(-8, W - 4)), int(rng.integers(-8, H - 4)), blend=mode,
                              opacity=float(rng.choice([1.0, 0.73, 0.5])))
        if i % 2 == 0:
            mw, mh = int(rng.integers(5, W)), int(rng.integers(5, H))
            L["mask"] = {"enabled": True, "x": int(rng.integers(-3, 10)), "y": int(rng.integers(-3, 10)), "w": mw, "h": mh,
                         "fill": int(rng.choice([0, 255]))}
            d.masks[L["id"]] = rng.integers(0, 256, (mh, mw), dtype=np.uint8)
    for kind, params in (adjust or []):
        L = d.add_adjust_layer(kind, params, opacity=0.8)
        L["mask"] = {"enabled": True, "x": 2, "y": 3, "w": W - 5, "h": H - 6, "fill": 255}
        d.masks[L["id"]] = rng.integers(0, 256, (H - 6, W - 5), dtype=np.uint8)
    return d


ADJ = [("levels", {"in_black": 20, "in_white": 230, "gamma": 1.4, "out_black": 10, "out_white": 240}),
       ("curves", {"rgb": [[0, 10], [80, 120], [200, 180], [255, 250]], "g": [[0, 0], [128, 100], [255, 255]]}),
       ("brightness_contrast", {"brightness": 25, "contrast": 40}),
       ("brightness_contrast", {"brightness": -30, "contrast": -50}),
       ("exposure", {"exposure": 0.7, "offset": 0.01, "gamma": 1.2}),
       ("hue_saturation", {"hue": 77, "saturation": 35, "lightness": -20}),
       ("hue_saturation", {"hue": -140, "saturation": -60, "lightness": 30}),
       ("grade", {"lift": [0.05, 0, -0.03], "gamma": [1.1, 0.9, 1], "gain": [1.2, 1, 0.8]}),
       ("invert", {}), ("threshold", {"level": 100})]


@unittest.skipIf(shutil.which("node") is None, "needs node")
class PaintParity(unittest.TestCase):
    def run_node(self, cases):
        job = {"cases": {}}
        for name, d in cases.items():
            job["cases"][name] = {"doc": d.meta, "px": {k: b64(v) for k, v in d.px.items()},
                                  "masks": {k: b64(v) for k, v in d.masks.items()},
                                  "filters": getattr(d, "filters", None), "path": getattr(d, "path", None),
                                  "distort": getattr(d, "distort", None), "draw": getattr(d, "draw", None)}
        with tempfile.TemporaryDirectory() as tmp:
            a, b = os.path.join(tmp, "in.json"), os.path.join(tmp, "out.json")
            with open(a, "w") as f:
                json.dump(job, f)
            subprocess.run(["node", os.path.join(HERE, "paint_parity.mjs"), a, b], check=True)
            with open(b) as f:
                return json.load(f)

    def same(self, py, js_b64, shape, what, tol=1):
        js = np.frombuffer(base64.b64decode(js_b64), np.uint8).reshape(shape)
        diff = np.abs(py.astype(int) - js.astype(int))
        if py.ndim == 3:
            seen = (py[..., 3] > 0) | (js[..., 3] > 0)
            diff = np.where(seen[..., None], diff, 0)
        self.assertLessEqual(int(diff.max()), tol, f"{what}: max difference {diff.max()} at {np.unravel_index(diff.argmax(), diff.shape)}")
        return diff

    def test_every_blend_mode_with_masks_and_opacity(self):
        cases = {}
        for k, mode in enumerate(M.BLEND_MODES):
            cases[mode] = rnd_doc(10 + k, [mode, mode, "normal"])
        got = self.run_node(cases)
        for name, d in cases.items():
            self.same(P.composite(d), got[name]["composite"], (d.h, d.w, 4), name)

    def test_every_adjustment(self):
        cases = {f"{k}_{i}": rnd_doc(50 + i, ["multiply"], [(k, p)]) for i, (k, p) in enumerate(ADJ)}
        got = self.run_node(cases)
        for name, d in cases.items():
            self.same(P.composite(d), got[name]["composite"], (d.h, d.w, 4), name)

    def test_a_stack_of_everything(self):
        d = rnd_doc(99, list(M.BLEND_MODES), ADJ[:6], size=(61, 47))
        d.layers[3]["visible"] = False
        got = self.run_node({"all": d})
        self.same(P.composite(d), got["all"]["composite"], (d.h, d.w, 4), "all")

    def test_groups(self):
        """Groups of every kind of blend, nested, with opacity and masks."""
        cases = {}
        rng = np.random.default_rng(5)
        for k, gb in enumerate(["pass_through", "normal", "multiply", "screen", "overlay", "difference"]):
            for op, masked in ((1.0, False), (0.6, False), (1.0, True), (0.45, True)):
                d = rnd_doc(200 + k * 7 + int(op * 10), ["multiply", "screen", "normal", "overlay"],
                            [("hue_saturation", {"hue": 40, "saturation": 20, "lightness": 0})])
                ids = [L["id"] for L in d.layers]
                # ids: bg, l0..l3, adjust. Group l1, l2 and the adjustment; a group inside it holds l2.
                G = d.add_group("G", blend=gb, opacity=op)
                if masked:
                    G["mask"] = {"enabled": True, "x": 3, "y": 2, "w": d.w - 6, "h": d.h - 4, "fill": 0}
                    d.masks[G["id"]] = rng.integers(0, 256, (d.h - 4, d.w - 6), dtype=np.uint8)
                inner = d.add_group("inner", blend="pass_through" if k % 2 else "screen", opacity=0.8)
                for i in (2, 5):
                    d.layer(ids[i])["parent"] = G["id"]
                d.layer(ids[3])["parent"] = inner["id"]
                inner["parent"] = G["id"]
                d.meta = P.clean_meta(d.meta)
                cases[f"{gb}_{op}_{masked}"] = d
        hidden = rnd_doc(400, ["normal", "multiply"])
        g = hidden.add_group("off", blend="normal")
        hidden.layers[1]["parent"] = g["id"]
        g["visible"] = False
        hidden.meta = P.clean_meta(hidden.meta)
        cases["hidden"] = hidden
        empty = rnd_doc(401, ["normal"])
        empty.add_group("empty", blend="multiply", index=1)
        cases["empty"] = empty
        got = self.run_node(cases)
        for name, d in cases.items():
            self.same(P.composite(d), got[name]["composite"], (d.h, d.w, 4), name)

    def test_clipping_masks(self):
        """Layers clipped to a pixel layer and to a group: every blend, opacity, masks, an adjustment clipped."""
        cases = {}
        for k, (base_blend, clip_blend) in enumerate([("normal", "normal"), ("multiply", "screen"), ("screen", "overlay"),
                                                      ("normal", "difference"), ("overlay", "soft_light")]):
            d = rnd_doc(500 + k, [base_blend, clip_blend, "normal", "hard_light"])
            ids = [L["id"] for L in d.layers]
            d.layer(ids[2])["clip"] = True                    # l1 onto l0
            d.layer(ids[3])["clip"] = True                    # and l2
            d.layer(ids[3])["opacity"] = 0.6
            A = d.add_adjust_layer("hue_saturation", {"hue": 90, "saturation": 30, "lightness": 0}, index=4)
            A["clip"] = True
            d.meta = P.clean_meta(d.meta)
            cases[f"px_{k}"] = d
        # A group as the base; a hidden clipped layer; a clipped layer with nothing under it.
        g = rnd_doc(600, ["normal", "multiply", "screen"])
        ids = [L["id"] for L in g.layers]
        G = g.add_group("G", blend="pass_through", index=3, opacity=0.8)
        g.layer(ids[1])["parent"] = G["id"]
        g.layer(ids[2])["parent"] = G["id"]
        g.layer(ids[3])["clip"] = True
        g.meta = P.clean_meta(g.meta)
        cases["group_base"] = g
        h = rnd_doc(601, ["normal", "multiply"])
        h.layers[0]["clip"] = True
        h.layers[2]["clip"] = True
        h.layers[2]["visible"] = False
        h.meta = P.clean_meta(h.meta)
        cases["odd"] = h
        got = self.run_node(cases)
        for name, d in cases.items():
            self.same(P.composite(d), got[name]["composite"], (d.h, d.w, 4), name)

    def test_mask_density_and_feather(self):
        cases = {}
        for k, (dn, fe) in enumerate([(0.5, 0), (1, 3.5), (0.3, 6), (0, 2)]):
            d = rnd_doc(700 + k, ["normal", "multiply", "screen"], [("invert", {})])
            G = d.add_group("G", blend="normal", opacity=0.9, index=3)
            G["mask"] = {"enabled": True, "x": 0, "y": 0, "w": d.w, "h": d.h, "fill": 0}
            d.masks[G["id"]] = np.random.default_rng(k).integers(0, 256, (d.h, d.w), dtype=np.uint8)
            d.layers[1]["parent"] = G["id"]
            for L in d.layers:
                if L.get("mask"):
                    L["mask"]["density"] = dn
                    L["mask"]["feather"] = fe
            d.meta = P.clean_meta(d.meta)
            cases[f"m{k}"] = d
        got = self.run_node(cases)
        for name, d in cases.items():
            self.same(P.composite(d), got[name]["composite"], (d.h, d.w, 4), name)

    def test_filters_and_selection_shapes(self):
        d = rnd_doc(7, [])
        L = d.layers[0]
        poly = [[2.3, 1.1], [30.5, 6.2], [20.2, 27.7], [4.9, 18.4], [15, 12]]
        d.filters = {"blur": 3.5, "radius": 2.0, "amount": 1.3, "polygon": poly}
        got = self.run_node({"f": d})["f"]
        px = d.px[L["id"]]
        self.same(M.blur_pixels(px, 3.5), got["blur"], px.shape, "blur", tol=1)
        self.same(M.sharpen_pixels(px, 2.0, 1.3), got["sharpen"], px.shape, "sharpen", tol=1)
        h, w = px.shape[:2]
        self.same(M.feather_mask(M.ellipse_mask(w, h, 3, 4, w * 0.6, h * 0.5), 3.5), got["feather"], (h, w), "feather")
        self.same(M.polygon_mask(w, h, poly), got["polygon"], (h, w), "polygon", tol=0)
        self.same(M.ellipse_mask(w, h, 2.5, 3.2, w * 0.7, h * 0.6), got["ellipse"], (h, w), "ellipse", tol=0)

    def test_pen_paths(self):
        d = rnd_doc(9, [])
        path = {"name": "p", "closed": True, "pts": [
            {"x": 3.2, "y": 4.1, "ix": 3.2, "iy": 4.1, "ox": 12.5, "oy": -2, "smooth": False},
            {"x": 31.7, "y": 9.3, "ix": 28, "iy": 2, "ox": 35.4, "oy": 16.6, "smooth": True},
            {"x": 18.1, "y": 25.6, "ix": 18.1, "iy": 25.6, "ox": 18.1, "oy": 25.6, "smooth": False},
            {"x": 6, "y": 20, "ix": 10, "iy": 26, "ox": 2, "oy": 14, "smooth": True}]}
        W, H = 40, 32
        d.path = {"path": path, "w": W, "h": H, "width": 3.4}
        got = self.run_node({"p": d})["p"]
        Q = M.clean_path(path)
        line = M.flatten_path(Q)
        self.assertEqual(len(line), len(got["path_line"]))
        self.assertLess(float(np.abs(np.array(line) - np.array(got["path_line"])).max()), 1e-9)
        self.same(M.path_mask(W, H, Q), got["path_fill"], (H, W), "path fill", tol=0)
        self.same(M.stroke_mask(W, H, line, True, 3.4), got["path_stroke"], (H, W), "path stroke", tol=1)
        # An open path is filled as if closed by a straight line, and stroked without that line.
        Q["closed"] = False
        self.assertEqual(M.flatten_path(Q)[-1], [6, 20])
        self.assertLess(len(M.flatten_path(Q)), len(line))
        # A path survives clean_meta (so it is kept in the .ora's imageviewer.json).
        meta = dict(d.meta, paths=[path, {"pts": []}])
        self.assertEqual([p["name"] for p in P.clean_meta(meta)["paths"]], ["p"])

    def test_distort(self):
        from paint_pkg import paint_ops as O
        d = rnd_doc(11, [])
        L = d.layers[0]
        q = [[L["x"] + 3.5, L["y"] - 2], [L["x"] + 40.2, L["y"] + 5], [L["x"] + 30, L["y"] + 35.7], [L["x"] - 4, L["y"] + 22]]
        d.distort = q
        got = self.run_node({"d": d})["d"]
        O.apply_ops(d, [{"op": "distort", "layer": L["name"], "corners": q}], read_image=None)
        L2 = d.layer(L["id"])
        self.assertEqual([L2["x"], L2["y"], L2["w"], L2["h"]], [got["distort_box"][k] for k in "xywh"])
        self.same(d.px[L["id"]], got["distort"], d.px[L["id"]].shape, "distort", tol=1)
        with self.assertRaises(O.OpError):          # a bow tie is no shape a perspective makes
            O.apply_ops(d, [{"op": "distort", "corners": [[0, 0], [10, 0], [0, 10], [10, 10]]}], read_image=None)

    def test_gradients_and_shapes(self):
        d = rnd_doc(13, [])
        rng = np.random.default_rng(13)
        gs = []
        for kind in M.GRADIENT_TYPES:
            for rev in (False, True):
                stops = [{"t": 0, "c": [int(v) for v in rng.integers(0, 256, 4)]}, {"t": float(rng.uniform(0.2, 0.8)), "c": [int(v) for v in rng.integers(0, 256, 4)]},
                         {"t": 1, "c": [int(v) for v in rng.integers(0, 256, 3)] + [0]}]
                gs.append({"type": kind, "x0": float(rng.uniform(0, 30)), "y0": float(rng.uniform(0, 20)),
                           "x1": float(rng.uniform(5, 40)), "y1": float(rng.uniform(5, 30)), "stops": stops, "reverse": rev})
        shapes = [{"kind": k, "x0": 3.3, "y0": 30.5, "x1": 41.2, "y1": 4.1, "radius": 7.5, "sides": 5} for k in M.SHAPE_KINDS]
        presets = [["fg-bg", [200, 10, 30], [0, 90, 255]], ["fg-clear", [1, 2, 3], [4, 5, 6]], ["bw", [9, 9, 9], [8, 8, 8]], ["fg-bg-fg", [255, 0, 0], [0, 0, 255]]]
        W, H, ox, oy = 37, 29, -3, 2
        d.draw = {"w": W, "h": H, "ox": ox, "oy": oy, "gradients": gs, "shapes": shapes, "presets": presets}
        got = self.run_node({"d": d})["d"]
        for i, g in enumerate(gs):
            self.same(M.gradient_pixels(W, H, ox, oy, g), got["gradients"][i], (H, W, 4), f"gradient {g['type']} {g['reverse']}", tol=1)
        for i, q in enumerate(shapes):
            line = M.flatten_path(M.clean_path(M.shape_path(q["kind"], q["x0"], q["y0"], q["x1"], q["y1"], q["radius"], q["sides"])))
            self.assertEqual(len(line), len(got["shapes"][i]), q["kind"])
            self.assertLess(float(np.abs(np.array(line) - np.array(got["shapes"][i])).max()), 1e-9, q["kind"])
        for i, (p, fg, bg) in enumerate(presets):
            self.assertEqual([[s["t"], s["c"]] for s in M.gradient_stops(p, fg, bg)], [[s["t"], s["c"]] for s in got["stops"][i]], p)


if __name__ == "__main__":
    unittest.main()
