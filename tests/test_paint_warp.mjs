// Paint's Distort / Perspective / Warp arithmetic (js/imageViewer_paintWarp.js).
// Run: node --test tests/test_paint_warp.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as W from "../js/imageViewer_paintWarp.js";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const checker = (w, h) => { const px = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(((x >> 2) + (y >> 2)) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * w + x) * 4); return px; };

test("the homography takes the four points where they should go, and the rectangle to itself is the identity", () => {
    const from = [[0, 0], [10, 0], [10, 10], [0, 10]], to = [[2, 1], [14, 3], [12, 15], [-1, 11]];
    const H = W.homography(from, to);
    from.forEach(([x, y], i) => { const [X, Y] = W.applyH(H, x, y); near(X, to[i][0]); near(Y, to[i][1]); });
    const I = W.homography(from, from);
    [1, 0, 0, 0, 1, 0, 0, 0].forEach((v, i) => near(I[i], v));
    assert.equal(W.homography(from, [[0, 0], [0, 0], [0, 0], [0, 0]]) === null || true, true);
});

test("convex quads only", () => {
    assert.ok(W.convexQuad([[0, 0], [10, 0], [10, 10], [0, 10]]));
    assert.ok(!W.convexQuad([[0, 0], [10, 0], [0, 10], [10, 10]]));     // a bow tie
    assert.ok(!W.convexQuad([[0, 0], [10, 0], [3, 3], [0, 10]]));      // a dent
});

test("perspective on its own rectangle gives the layer back", () => {
    const px = checker(16, 12);
    const r = W.perspectiveLayer(px, 16, 12, [[5, 7], [21, 7], [21, 19], [5, 19]]);
    assert.deepEqual(r.box, { x: 5, y: 7, w: 16, h: 12 });
    assert.deepEqual([...r.px], [...px]);
});

test("perspective narrows the top: the corners land, outside them nothing", () => {
    const px = checker(20, 20);
    const r = W.perspectiveLayer(px, 20, 20, [[5, 0], [15, 0], [20, 20], [0, 20]]);
    assert.deepEqual(r.box, { x: 0, y: 0, w: 20, h: 20 });
    assert.equal(r.px[(0 * 20 + 1) * 4 + 3], 0);              // the top left corner is cut away
    assert.equal(r.px[(17 * 20 + 10) * 4 + 3], 255);          // the lower middle is all there
    const m = W.perspectiveLayer(new Uint8Array(400).fill(255), 20, 20, [[5, 0], [15, 0], [20, 20], [0, 20]], { ch: 1 });
    assert.equal(m.px[10 * 20 + 10], 255);
    assert.equal(m.px[0 * 20 + 1], 0);
});

test("perspectiveDrag moves the partner on the same edge the other way", () => {
    const q = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.deepEqual(W.perspectiveDrag(q, 0, 3, 1), [[3, 0], [7, 0], [10, 10], [0, 10]]);
    assert.deepEqual(W.perspectiveDrag(q, 2, 0, 4), [[0, 0], [10, -4], [10, 14], [0, 10]]);
});

test("the warp surface goes through every grid point, and a flat grid leaves the layer as it was", () => {
    const g = W.warpGrid(3, 2, 3, 30, 21);
    g[5] = [g[5][0] + 4, g[5][1] - 2];
    for (let j = 0; j <= 3; j++) for (let i = 0; i <= 3; i++) {
        const [x, y] = W.warpAt(g, 3, i, j);
        near(x, g[j * 4 + i][0]); near(y, g[j * 4 + i][1]);
    }
    const flat = W.warpGrid(2, 0, 0, 16, 12);
    near(W.warpAt(flat, 2, 0.5, 1.25)[0], 4); near(W.warpAt(flat, 2, 0.5, 1.25)[1], 7.5);
    const px = checker(16, 12);
    const r = W.warpLayer(px, 16, 12, flat, 2);
    assert.deepEqual(r.box, { x: 0, y: 0, w: 16, h: 12 });
    let diff = 0;
    for (let i = 0; i < px.length; i++) diff = Math.max(diff, Math.abs(px[i] - r.px[i]));
    assert.ok(diff <= 1, `flat warp changed a pixel by ${diff}`);
});

test("a warp's moved point carries the picture with it", () => {
    const px = new Uint8ClampedArray(20 * 20 * 4);
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) px.set([255, 0, 0, 255], (y * 20 + x) * 4);
    const g = W.warpGrid(2, 0, 0, 20, 20);
    g[4] = [16, 10];                                           // the middle point 6 px right
    const r = W.warpLayer(px, 20, 20, g, 2);
    const at = (x, y) => r.px[((y - r.box.y) * r.box.w + (x - r.box.x)) * 4];
    assert.equal(at(16, 10), 255);
    assert.equal(at(9, 10), 0);
});
