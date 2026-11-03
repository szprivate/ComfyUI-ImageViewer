// Paint's pure arithmetic that has no Python twin: the brush, the bucket, selections, names.
// (What both sides compute - blending, adjustments, the stack, filters, masks - is tests/test_paint_parity.py.)
//   node --test tests/test_paint_data.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/bEpicViewer_paintData.js";

const layer = (w, h, rgba = [0, 0, 0, 0]) => { const px = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) px.set(rgba, i * 4); return px; };
const stroke = (px, w, h, extra = {}) => ({ px, orig: new Uint8ClampedArray(px), cover: new Float32Array(w * h), lw: w, lh: h, lx: 0, ly: 0,
                                            color: [255, 0, 0], opacity: 1, erase: false, lockAlpha: false, sel: null, W: w, H: h, ...extra });

test("dabs are spaced along a line and the rest carries into the next move", () => {
    const a = D.dabsAlong(0, 0, 10, 0, 5, 0.25);            // a step of 2.5 px
    assert.deepEqual(a.dabs.map(([x]) => x), [2.5, 5, 7.5, 10]);
    const b = D.dabsAlong(10, 0, 11, 0, 5, 0.25, a.carry);
    assert.equal(b.dabs.length, 0);
    const c = D.dabsAlong(11, 0, 13, 0, 5, 0.25, b.carry);
    assert.deepEqual(c.dabs.map(([x]) => x), [12.5]);       // 2.5 after the last dab, across both moves
});

test("a stroke does not build up where it crosses itself", () => {
    const w = 20, h = 20, px = layer(w, h);
    const st = stroke(px, w, h, { opacity: 0.5 });
    D.stamp(st, 10, 10, 4, 1);
    const once = px[(10 * w + 10) * 4 + 3];
    D.stamp(st, 10, 10, 4, 1);
    assert.equal(px[(10 * w + 10) * 4 + 3], once);
    assert.equal(once, D.q8(0.5));
    assert.equal(px[(0 * w + 0) * 4 + 3], 0);                 // outside the dab: untouched
});

test("the selection holds the brush, the eraser takes alpha, lock alpha keeps it", () => {
    const w = 10, h = 10;
    const sel = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 5; x++) sel[y * w + x] = 255;
    const px = layer(w, h);
    D.stamp(stroke(px, w, h, { sel }), 5, 5, 4, 1);
    assert.equal(px[(5 * w + 3) * 4 + 3], 255);
    assert.equal(px[(5 * w + 7) * 4 + 3], 0);
    const solid = layer(w, h, [0, 0, 255, 255]);
    D.stamp(stroke(solid, w, h, { erase: true }), 5, 5, 3, 1);
    assert.deepEqual([...solid.slice((5 * w + 5) * 4, (5 * w + 5) * 4 + 4)], [0, 0, 255, 0]);
    const half = layer(w, h, [0, 0, 255, 128]);
    D.stamp(stroke(half, w, h, { lockAlpha: true }), 5, 5, 3, 1);
    assert.deepEqual([...half.slice((5 * w + 5) * 4, (5 * w + 5) * 4 + 4)], [255, 0, 0, 128]);
});

test("the bucket's flood stays inside a region, or takes every like pixel", () => {
    const w = 9, h = 3, px = layer(w, h, [255, 255, 255, 255]);
    for (let y = 0; y < h; y++) px.set([0, 0, 0, 255], (y * w + 4) * 4);   // a black wall down the middle
    const near = D.floodMask(px, w, h, 1, 1, 10, true);
    const all = D.floodMask(px, w, h, 1, 1, 10, false);
    const count = (m) => m.reduce((a, v) => a + (v ? 1 : 0), 0);
    assert.equal(count(near), 12);
    assert.equal(count(all), 24);
    assert.deepEqual(D.maskBBox(near, w, h), { x: 0, y: 0, w: 4, h: 3 });
});

test("selections combine, invert and have a box", () => {
    const a = D.rectMask(10, 10, 0, 0, 5, 10), b = D.rectMask(10, 10, 3, 0, 5, 10);
    const box = (m) => D.maskBBox(m, 10, 10);
    assert.deepEqual(box(D.combineMasks(a, b, "add")), { x: 0, y: 0, w: 8, h: 10 });
    assert.deepEqual(box(D.combineMasks(a, b, "intersect")), { x: 3, y: 0, w: 2, h: 10 });
    assert.deepEqual(box(D.combineMasks(a, b, "subtract")), { x: 0, y: 0, w: 3, h: 10 });
    assert.deepEqual(box(D.invertMask(a)), { x: 5, y: 0, w: 5, h: 10 });
    assert.equal(D.maskBBox(new Uint8Array(100), 10, 10), null);
});

test("a document is held to what it may be", () => {
    const doc = D.cleanDoc({ w: 64, h: 32, layers: [{ id: "a", kind: "pixel", w: 64, h: 32, opacity: 7, blend: "nope" },
                                                    { id: "b", kind: "adjust", adjust: { type: "levels" }, blend: "multiply" }], active: "zz" });
    assert.equal(doc.layers[0].opacity, 1);
    assert.equal(doc.layers[0].blend, "normal");
    assert.equal(doc.layers[1].blend, "normal");             // an adjustment has no blend mode
    assert.equal(doc.active, "b");
    assert.throws(() => D.cleanDoc({ w: 0, h: 10 }));
    assert.equal(D.freshName({ layers: [{ name: "Layer 2" }] }), "Layer 3");
    assert.deepEqual(D.panelOrder(doc).map((L) => L.id), ["b", "a"]);
    assert.deepEqual(D.hexToRgb("#ff8000"), [255, 128, 0]);
});
