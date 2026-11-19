// The camera's lens and film back (js/imageViewer_cameraLens.js): node --test tests/test_camera_lens.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../js/imageViewer_cameraLens.js";
import { parseScene } from "../js/imageViewer_scene3d.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("a full frame camera at 16:9: the picture is the film's width, the focal length is the pinhole's", () => {
    const cam = { filmback: [36, 24] };
    const [pw, ph] = L.pictureOnFilm(cam, 16 / 9);
    near(pw, 36); near(ph, 20.25);
    // 50 mm on 20.25 mm high: 2 atan(10.125 / 50)
    const fov = L.fovFromFocal(cam, 50, 16 / 9);
    near(fov, 2 * Math.atan(10.125 / 50) * 180 / Math.PI);
    near(L.focalOf(cam, fov, 16 / 9), 50, 1e-9);
});

test("the four film fits", () => {
    const fb = [36, 24];                        // 1.5:1 film
    near(L.pictureOnFilm({ filmback: fb, filmFit: "vertical" }, 2)[1], 24);
    near(L.pictureOnFilm({ filmback: fb, filmFit: "vertical" }, 2)[0], 48);
    // fill: inside the film back; a 2:1 picture is the film's width, a 1:1 the film's height
    assert.deepEqual(L.pictureOnFilm({ filmback: fb, filmFit: "fill" }, 2), [36, 18]);
    assert.deepEqual(L.pictureOnFilm({ filmback: fb, filmFit: "fill" }, 1), [24, 24]);
    // overscan: the film back inside the picture
    assert.deepEqual(L.pictureOnFilm({ filmback: fb, filmFit: "overscan" }, 2), [48, 24]);
    assert.deepEqual(L.pictureOnFilm({ filmback: fb, filmFit: "overscan" }, 1), [36, 36]);
});

test("horizontal and vertical fields of view go both ways", () => {
    const h = L.horizontalFov(40, 16 / 9);
    near(L.fovFromHorizontal(h, 16 / 9), 40, 1e-9);
    assert.ok(h > 40);
});

test("defaults: 36 x 24, horizontal, clipping 0.1 .. 10000; a far before the near is pushed past it", () => {
    assert.deepEqual(L.filmbackOf({}), [36, 24]);
    assert.equal(L.filmFitOf({ filmFit: "nonsense" }), "horizontal");
    assert.deepEqual(L.clipOf({}), [0.1, 10000]);
    const [n, f] = L.clipOf({ clip: [5, 1] });
    assert.equal(n, 5); assert.ok(f > 5);
});

test("a scene keeps a camera's film back, fit, clipping and its own framing mask", () => {
    const scene = parseScene({ items: [{ id: "c1", kind: "camera", name: "Cam", fov: 30,
        filmback: [24.89, 14], filmFit: "vertical", clip: [0.5, 500],
        frameMask: { on: true, key: "1.85", opacity: 0.4 } }] });
    const c = scene.items[0];
    assert.deepEqual(c.filmback, [24.89, 14]);
    assert.equal(c.filmFit, "vertical");
    assert.deepEqual(c.clip, [0.5, 500]);
    assert.deepEqual(c.frameMask, { on: true, key: "1.85", custom: "", opacity: 0.4, line: true, label: true });
    // a camera without them stays as it was
    const plain = parseScene({ items: [{ id: "c2", kind: "camera", fov: 30 }] }).items[0];
    for (const k of ["filmback", "filmFit", "clip", "frameMask"]) assert.equal(plain[k], undefined);
});

test("the lens shift is kept, held to +-2, and moves the projection a share of the picture", () => {
    assert.deepEqual(L.shiftOf(null), [0, 0]);
    assert.deepEqual(L.shiftOf({ shift: [5, -0.1] }), [2, -0.1]);
    assert.deepEqual(L.readLensFields({ shift: [0, 0] }), {});
    assert.deepEqual(L.readLensFields({ shift: [0.1, 0] }).shift, [0.1, 0]);
    assert.deepEqual(L.shiftTerms([0.5, -0.25]), [1, -0.5]);
    // a picture taking half of the view moves half as far in the view
    assert.deepEqual(L.shiftTerms([0.5, 0.5], 0.5, 0.25), [0.5, 0.25]);
    const sc = parseScene({ items: [{ id: "c", kind: "camera", name: "C", shift: [0.2, 0.1] }] });
    assert.deepEqual(sc.items[0].shift, [0.2, 0.1]);
});
