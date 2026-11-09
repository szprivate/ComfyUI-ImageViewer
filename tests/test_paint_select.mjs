// Paint's Select > Modify, Colour range, guides and snapping (js/imageViewer_paintSelect.js).
// Run: node --test tests/test_paint_select.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_paintSelect.js";
import * as D from "../js/imageViewer_paintData.js";

const box = (w, h, x0, y0, x1, y1) => { const m = new Uint8Array(w * h); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 255; return m; };
const count = (m) => m.reduce((n, v) => n + (v >= 128), 0);

test("expand, contract, border, smooth", () => {
    const W = 20, H = 20, m = box(W, H, 5, 5, 15, 15);
    const e = S.expandMask(m, W, H, 2), c = S.contractMask(m, W, H, 2);
    assert.equal(e[5 * W + 3], 255);                  // two to the left of the edge: in
    assert.equal(e[3 * W + 3], 0);                    // the corner rounds: a disc, not a square
    assert.equal(count(c), 6 * 6);
    assert.equal(c[7 * W + 7], 255);
    const b = S.borderMask(m, W, H, 4);
    assert.equal(b[10 * W + 10], 0);                  // the middle is out
    assert.equal(b[10 * W + 4], 255);                 // just outside the edge
    assert.equal(b[10 * W + 6], 255);                 // just inside it
    const speck = box(W, H, 5, 5, 15, 15); speck[1 * W + 1] = 255;
    const s = S.smoothMask(speck, W, H, 2);
    assert.equal(s[1 * W + 1], 0);                    // a speck goes
    assert.equal(s[10 * W + 10], 255);
    assert.equal(s[5 * W + 5], 0);                    // a corner rounds off
});

test("colour range: all at the colour, nothing at the fuzziness, times the alpha", () => {
    const px = new Uint8ClampedArray([200, 0, 0, 255, 180, 20, 0, 255, 0, 0, 255, 255, 200, 0, 0, 128]);
    const r = S.colorRange(px, 4, 1, [200, 0, 0], 40);
    assert.equal(r[0], 255);
    assert.ok(r[1] > 0 && r[1] < 255);
    assert.equal(r[2], 0);
    assert.equal(r[3], 128);
});

test("guides: cleaned, moved with the canvas", () => {
    assert.deepEqual(D.cleanGuides([{ axis: "x", pos: 3.3 }, { axis: "y", pos: 99 }, { axis: "q", pos: 1 }, null], 50, 40), [{ axis: "x", pos: 3.5 }]);
    assert.deepEqual(D.cleanGuides(D.moveGuides([{ axis: "x", pos: 10 }, { axis: "y", pos: 10 }], -12, 4, 2, 2), 50, 40), [{ axis: "y", pos: 28 }]);
    const doc = D.cleanDoc({ w: 30, h: 20, layers: [], guides: [{ axis: "y", pos: 5 }] });
    assert.deepEqual(doc.guides, [{ axis: "y", pos: 5 }]);
    assert.equal("guides" in D.cleanDoc({ w: 30, h: 20, layers: [] }), false);
});

test("snapping: the nearest target within reach, a span by its start, middle or end", () => {
    assert.deepEqual(S.snapValue(9.2, [0, 10, 20], 1), [10, 10]);
    assert.deepEqual(S.snapValue(5, [0, 10, 20], 1), [5, null]);
    assert.equal(S.snapSpan(12, 22, [0, 25, 50], 4), 3);     // the middle (17) is not near; the end is
    assert.equal(S.snapSpan(19, 31, [25], 2), 0);           // the middle lands already
    assert.equal(S.snapSpan(100, 110, [0], 3), 0);
    assert.equal(S.rulerStep(1), 50);
    assert.equal(S.rulerStep(10), 5);
    assert.equal(S.rulerStep(0.1), 500);
});

test("the empty area around a layer: outside its box and where it is see-through, grown into it", () => {
    const W = 6, H = 4, L = { x: 1, y: 0, w: 3, h: 4 };
    const px = new Uint8ClampedArray(L.w * L.h * 4).fill(255);
    px[(1 * L.w + 1) * 4 + 3] = 0;                         // a hole in the middle of the layer
    px[(2 * L.w + 1) * 4 + 3] = 128;                       // half see-through
    const m = S.emptyAround(px, L, W, H, 0);
    assert.equal(m[0], 255);                               // left of the layer
    assert.equal(m[5], 255);                               // right of it
    assert.equal(m[1], 0);                                 // the layer covers it
    assert.equal(m[1 * W + 2], 255);                       // the hole
    assert.equal(m[2 * W + 2], 127);
    const grown = S.emptyAround(px, L, W, H, 1);
    assert.equal(grown[1], 255);                           // reaches one pixel into the layer
    assert.equal(S.emptyAround(new Uint8ClampedArray(W * H * 4).fill(255), { x: 0, y: 0, w: W, h: H }, W, H), null);
});
