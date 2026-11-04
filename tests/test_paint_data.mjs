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

test("a pen's pressure is read, a mouse's is not", () => {
    assert.equal(D.pressureOf("pen", 0.3), 0.3);
    assert.equal(D.pressureOf("pen", 1.7), 1);
    assert.equal(D.pressureOf("mouse", 0.5), 1);            // a mouse with a button down says 0.5: ignored
    assert.equal(D.pressureOf("touch", 0.2), 1);
    assert.deepEqual(D.pressureScale(0.25, true, false), { r: 0.25, a: 1 });
    assert.deepEqual(D.pressureScale(0.25, false, true), { r: 1, a: 0.25 });
    assert.equal(D.pressureScale(0, true, false).r, D.PRESSURE_MIN_SIZE);
});

test("dabs along a pen move carry its pressure and sit closer where it is light", () => {
    const { dabs } = D.pressureDabs(0, 0, 0.2, 100, 0, 1, 10, 0.25);   // a step of 5 px at full pressure
    assert.ok(dabs.length > 20);                             // a constant 5 px step would give 20
    for (let i = 1; i < dabs.length; i++) assert.ok(dabs[i][2] >= dabs[i - 1][2]);
    const gaps = dabs.slice(1).map((d, i) => d[0] - dabs[i][0]);
    assert.ok(gaps[0] < gaps[gaps.length - 1]);
    const flat = D.pressureDabs(0, 0, 0.2, 100, 0, 1, 10, 0.25, 0, false);   // size not on the pen: even steps
    assert.deepEqual(flat.dabs.map(([x]) => x), D.dabsAlong(0, 0, 100, 0, 10, 0.25).dabs.map(([x]) => x));
    // The rest carries across moves just as dabsAlong's.
    const a = D.pressureDabs(0, 0, 1, 7, 0, 1, 10, 0.25), b = D.pressureDabs(7, 0, 1, 12, 0, 1, 10, 0.25, a.carry);
    assert.deepEqual([...a.dabs, ...b.dabs].map(([x]) => x), [5, 10]);
});

test("a light press paints a smaller, or fainter, dab", () => {
    const w = 40, h = 40, inked = (px) => { let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++; return n; };
    const full = layer(w, h), light = layer(w, h), faint = layer(w, h);
    D.stamp(stroke(full, w, h), 20, 20, 10, 1);
    D.stamp(stroke(light, w, h), 20, 20, 10 * D.pressureScale(0.3, true, false).r, 1);
    D.stamp(stroke(faint, w, h), 20, 20, 10, 1, D.pressureScale(0.3, false, true).a);
    assert.ok(inked(light) < inked(full) / 5);
    assert.equal(faint[(20 * w + 20) * 4 + 3], D.q8(0.3));
});
