// Paint: the blur brush (js/imageViewer_paintDraw.js blurDab) and the on-canvas size / opacity drag
// (js/imageViewer_paintBrushDrag.js). Run: node --test tests/test_paint_brushdrag.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../js/imageViewer_paintDraw.js";
import * as B from "../js/imageViewer_paintBrushDrag.js";

const layer = (w, h, f) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4);
    return { px, lw: w, lh: h, lx: 0, ly: 0, W: w, H: h, sel: null, lockAlpha: false };
};
const at = (st, x, y) => [...st.px.slice((y * st.lw + x) * 4, (y * st.lw + x) * 4 + 4)];

test("blur: a hard edge under the dab gets soft, far away nothing changes", () => {
    const st = layer(40, 20, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const r = G.blurDab(st, 20, 10, 6, 1, 1);
    assert.ok(r);
    const a = at(st, 19, 10)[0], b = at(st, 20, 10)[0];
    assert.ok(a > 0 && a < 128, `left of the edge ${a}`);
    assert.ok(b > 128 && b < 255, `right of the edge ${b}`);
    assert.deepEqual(at(st, 2, 10), [0, 0, 0, 255]);
    assert.deepEqual(at(st, 37, 10), [255, 255, 255, 255]);
    assert.equal(at(st, 19, 10)[3], 255);
});

test("blur: strength 0 does nothing, a second dab blurs more", () => {
    const st = layer(40, 20, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    assert.equal(G.blurDab(st, 20, 10, 6, 1, 0), null);
    assert.equal(at(st, 19, 10)[0], 0);
    G.blurDab(st, 20, 10, 6, 1, 0.5);
    const once = at(st, 18, 10)[0];
    G.blurDab(st, 20, 10, 6, 1, 0.5);
    assert.ok(at(st, 18, 10)[0] > once, "again: softer");
});

test("blur: premultiplied, so a transparent neighbour does not darken the colour; locked alpha keeps the alpha", () => {
    const mk = () => layer(30, 10, (x) => (x < 15 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const st = mk();
    G.blurDab(st, 15, 5, 5, 1, 1);
    const p = at(st, 14, 5);
    assert.ok(p[3] < 255 && p[3] > 0);
    assert.equal(p[0], 255, "still pure red, only less opaque");
    const lk = mk(); lk.lockAlpha = true;
    G.blurDab(lk, 15, 5, 5, 1, 1);
    assert.equal(at(lk, 14, 5)[3], 255);
    assert.equal(at(lk, 16, 5)[3], 0, "nothing is added where it was transparent");
});

test("blur: the selection limits it", () => {
    const st = layer(40, 20, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    st.sel = new Uint8Array(40 * 20);           // nothing selected
    assert.equal(G.blurDab(st, 20, 10, 6, 1, 1), null);
    assert.equal(at(st, 19, 10)[0], 0);
});

test("blur: its reach grows with the brush, within 1..12", () => {
    assert.equal(G.blurReach(1), 1);
    assert.equal(G.blurReach(36), 9);
    assert.equal(G.blurReach(1000), 12);
});

test("drag: sideways the size (the circle's edge follows), up the opacity, Shift the hardness", () => {
    const s = { size: 50, opacity: 50, hardness: 50 };
    assert.deepEqual(B.brushDragValues(s, 10, 0, 1, false), { size: 70, opacity: 50, hardness: 50 });
    assert.deepEqual(B.brushDragValues(s, 10, 0, 2, false).size, 60);      // zoomed in: picture pixels
    assert.deepEqual(B.brushDragValues(s, 0, -40, 1, false), { size: 50, opacity: 70, hardness: 50 });
    assert.deepEqual(B.brushDragValues(s, 0, 40, 1, true), { size: 50, opacity: 50, hardness: 30 });
    assert.equal(B.brushDragValues(s, -1000, 0, 1, false).size, 1);
    assert.equal(B.brushDragValues(s, 5000, 0, 1, false).size, B.DRAG_MAX_SIZE);
    assert.equal(B.brushDragValues(s, 0, 1000, 1, false).opacity, 1);
    assert.equal(B.brushDragValues(s, 0, -1000, 1, true).hardness, 100);
    assert.deepEqual(B.brushDragValues({ size: 100, strength: 50 }, 5, -20, 1, false, "liquify"), { size: 110, strength: 60 });
    assert.equal(B.brushDragLabel({ size: 12, opacity: 40, hardness: 0 }), "Size 12 px · Opacity 40%");
    assert.equal(B.brushDragLabel({ size: 12, opacity: 40, hardness: 7 }, "brush", true), "Size 12 px · Hardness 7%");
});
