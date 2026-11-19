// A camera's lens and its own framing mask (js/imageViewer_cameraLens.js). Run: node --test tests/test_camera_lens.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../js/imageViewer_cameraLens.js";
import { parseScene } from "../js/imageViewer_scene3d.js";

const near = (a, b, msg, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${msg}: ${a} != ${b}`);

test("a lens left out is the default, and the default is not stored", () => {
    assert.deepEqual(L.lensSettings(null), { aperture: [36, 24], fit: "fill", shift: [0, 0], near: 0, far: 0 });
    assert.equal(L.cleanLens({ aperture: [36, 24], fit: "fill" }), null);
    assert.equal(L.cleanLens(null), null);
    const l = L.cleanLens({ aperture: [24.89, 18.66], fit: "nonsense", shift: [5, -0.1], near: 2, far: 1 });
    assert.deepEqual(l.aperture, [24.89, 18.66]);
    assert.equal(l.fit, "fill");
    assert.deepEqual(l.shift, [2, -0.1]);          // held to +-2
    assert.equal(l.far, 0);                         // a far before the near is dropped
    assert.deepEqual(L.lensSettings({ aperture: [0, 5] }).aperture, [36, 24]);
});

test("the film back meets the picture by its fit", () => {
    // full frame (3:2) and a 16:9 picture: fill = the width is used, the height cut
    const [w, h] = L.gateFilm(null, 16 / 9);
    near(w, 36, "fill width"); near(h, 36 * 9 / 16, "fill height");
    // a 1:1 picture fills the height
    assert.deepEqual(L.gateFilm(null, 1), [24, 24]);
    assert.deepEqual(L.gateFilm({ fit: "vertical" }, 16 / 9), [24 * 16 / 9, 24]);
    assert.deepEqual(L.gateFilm({ fit: "horizontal" }, 1), [36, 36]);
});

test("focal length and field of view are one number read two ways", () => {
    const a = 16 / 9;
    const f = L.focalFromFov(null, a, 35);
    near(L.fovFromFocal(null, a, f), 35, "round trip");
    near(f, 20.25 / 2 / Math.tan(17.5 * Math.PI / 180), "pinhole");
    // a 50 mm lens on full frame across 36 mm sees 2 atan(18 / 50)
    near(L.horizontalFov(a, L.fovFromFocal(null, a, 50)), 2 * Math.atan(18 / 50) * 180 / Math.PI, "horizontal", 1e-9);
    near(L.verticalFov(a, L.horizontalFov(a, 40)), 40, "vertical from horizontal", 1e-9);
    // a phone's 5.7 mm on its own sensor is about 26 mm on full frame (the same picture)
    const phone = { aperture: [7.89, 5.26], fit: "horizontal" };
    const fov = L.fovFromFocal(phone, a, 5.7);
    near(L.focalFromFov({ fit: "horizontal" }, a, fov), 5.7 * 36 / 7.89, "35 mm equivalent", 1e-9);
});

test("a new film back keeps the lens's own numbers but nothing else", () => {
    const l = L.withAperture({ aperture: [36, 24], fit: "vertical", shift: [0.1, 0] }, [23.6, 15.6]);
    assert.deepEqual(l.aperture, [23.6, 15.6]);
    assert.equal(l.fit, "vertical");
    assert.deepEqual(l.shift, [0.1, 0]);
});

test("the lens shift moves the picture a share of its size", () => {
    assert.deepEqual(L.shiftTerms([0.5, -0.25]), [1, -0.5]);
    // a picture taking half of the view moves half as far in the view
    assert.deepEqual(L.shiftTerms([0.5, 0.5], 0.5, 0.25), [0.5, 0.25]);
    assert.deepEqual(L.shiftTerms(null), [0, 0]);
});

test("a camera's mask is its own when it has one, else the viewer's", () => {
    const viewer = { on: true, key: "2.39", custom: "", opacity: 0.8, line: true, label: true };
    assert.equal(L.cleanCameraMask(null), null);
    assert.equal(L.cleanCameraMask({ on: false, key: "1.85" }), null);
    const own = L.gateMask({ kind: "camera", mask: { on: true, key: "1.85", opacity: 0.5 } }, viewer);
    assert.equal(own.own, true);
    assert.equal(own.st.key, "1.85");
    near(own.mask.ratio, 1.85, "own ratio");
    const theirs = L.gateMask({ kind: "camera" }, viewer);
    assert.equal(theirs.own, false);
    assert.equal(theirs.st, viewer);
    const choices = L.maskChoices();
    assert.equal(choices[0][0], "");
    assert.equal(choices[choices.length - 1][0], "custom");
});

test("a scene keeps a camera's lens and mask, and leaves defaults out", () => {
    const sc = parseScene({ items: [
        { id: "c1", kind: "camera", name: "A", lens: { aperture: [24.89, 18.66], fit: "horizontal" }, mask: { on: true, key: "2.39" } },
        { id: "c2", kind: "camera", name: "B", lens: { aperture: [36, 24] }, mask: { on: false } },
    ] });
    const [a, b] = sc.items;
    assert.deepEqual(a.lens.aperture, [24.89, 18.66]);
    assert.equal(a.lens.fit, "horizontal");
    assert.equal(a.mask.key, "2.39");
    assert.ok(!b.lens && !b.mask, JSON.stringify(b));
});
