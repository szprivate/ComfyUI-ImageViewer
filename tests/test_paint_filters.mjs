// Paint's Filter menu beyond blur / sharpen (js/imageViewer_paintFilters.js), and clipping masks in the
// page's composite (their Python twin is in tests/test_paint_parity.py).
//   node --test tests/test_paint_filters.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_paintData.js";
import * as F from "../js/imageViewer_paintFilters.js";

const solid = (w, h, rgba) => { const px = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) px.set(rgba, i * 4); return px; };
const at = (px, w, x, y) => [...px.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

test("median takes out a lone speck and keeps a flat picture as it is", () => {
    const px = solid(9, 9, [100, 120, 140, 255]);
    px.set([255, 0, 0, 255], (4 * 9 + 4) * 4);
    const out = F.median(px, 9, 9, 1);
    assert.deepEqual(at(out, 9, 4, 4), [100, 120, 140, 255]);
    assert.deepEqual(at(out, 9, 0, 0), [100, 120, 140, 255]);
});

test("high pass is grey on a flat picture; unsharp mask leaves it alone and sharpens an edge", () => {
    const flat = solid(12, 6, [90, 90, 90, 255]);
    assert.deepEqual(at(F.highPass(flat, 12, 6, 3), 12, 5, 3), [128, 128, 128, 255]);
    assert.deepEqual(F.unsharpMask(flat, 12, 6, 2, 1, 0), flat);
    const edge = solid(12, 6, [50, 50, 50, 255]);
    for (let y = 0; y < 6; y++) for (let x = 6; x < 12; x++) edge.set([200, 200, 200, 255], (y * 12 + x) * 4);
    const s = F.unsharpMask(edge, 12, 6, 2, 1, 0);
    assert.ok(at(s, 12, 5, 3)[0] < 50 && at(s, 12, 6, 3)[0] > 200);
    // A threshold above the edge's difference: nothing changes.
    assert.deepEqual(F.unsharpMask(edge, 12, 6, 2, 1, 255), edge);
});

test("noise is the same for the same seed, mono noise is grey, and see-through pixels stay", () => {
    const px = solid(10, 10, [128, 128, 128, 255]);
    px.set([0, 0, 0, 0], 0);
    const a = F.addNoise(px, 10, 10, 0.2, true, false, 7), b = F.addNoise(px, 10, 10, 0.2, true, false, 7);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, F.addNoise(px, 10, 10, 0.2, true, false, 8));
    assert.deepEqual(at(a, 10, 0, 0), [0, 0, 0, 0]);
    const m = F.addNoise(px, 10, 10, 0.2, false, true, 3);
    for (let i = 1; i < 100; i++) assert.ok(m[i * 4] === m[i * 4 + 1] && m[i * 4 + 1] === m[i * 4 + 2]);
});

test("motion blur smears along its angle only; pixelate averages its cells", () => {
    const w = 21, h = 21, px = solid(w, h, [0, 0, 0, 255]);
    px.set([255, 255, 255, 255], (10 * w + 10) * 4);
    const out = F.motionBlur(px, w, h, 0, 8);
    assert.ok(at(out, w, 13, 10)[0] > 0, "along the line");
    assert.equal(at(out, w, 10, 13)[0], 0, "not across it");
    const v = F.motionBlur(px, w, h, 90, 8);
    assert.ok(at(v, w, 10, 13)[0] > 0 && at(v, w, 13, 10)[0] === 0);
    const q = solid(4, 2, [0, 0, 0, 255]);
    q.set([200, 100, 0, 255], 0);
    const p = F.pixelate(q, 4, 2, 2);
    assert.deepEqual(at(p, 4, 1, 1), [50, 25, 0, 255]);
    assert.deepEqual(at(p, 4, 3, 1), [0, 0, 0, 255]);
});

test("a clipped layer shows only where its base is, and an adjustment clipped changes only the base", () => {
    const W = 6, H = 1;
    const bg = { id: "bg", kind: "pixel", x: 0, y: 0, w: W, h: H };
    const base = { id: "base", kind: "pixel", x: 0, y: 0, w: 3, h: 1 };             // the left half
    const top = { id: "top", kind: "pixel", x: 0, y: 0, w: W, h: H, clip: true };   // red everywhere
    const doc = D.cleanDoc({ w: W, h: H, layers: [bg, base, top] });
    const pix = { bg: solid(W, H, [0, 0, 255, 255]), base: solid(3, 1, [0, 255, 0, 255]), top: solid(W, H, [255, 0, 0, 255]) };
    const c = D.composite(doc, (L) => pix[L.id], () => null);
    assert.deepEqual(at(c, W, 1, 0), [255, 0, 0, 255]);   // on the base: the clipped red
    assert.deepEqual(at(c, W, 4, 0), [0, 0, 255, 255]);   // off it: the background
    const inv = D.cleanDoc({ w: W, h: H, layers: [bg, base, { id: "inv", kind: "adjust", adjust: { type: "invert" }, clip: true }] });
    const c2 = D.composite(inv, (L) => pix[L.id], () => null);
    assert.deepEqual(at(c2, W, 1, 0), [255, 0, 255, 255]); // the green base inverted
    assert.deepEqual(at(c2, W, 4, 0), [0, 0, 255, 255]);   // the background untouched
    // Base hidden: its clipped layers go with it.
    const hid = D.cleanDoc({ w: W, h: H, layers: [bg, { ...base, visible: false }, top] });
    assert.deepEqual(at(D.composite(hid, (L) => pix[L.id], () => null), W, 1, 0), [0, 0, 255, 255]);
    // A group is never clipped.
    assert.equal(D.cleanLayer({ kind: "group", clip: true }).clip, undefined);
});
