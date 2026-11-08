// Paint's Liquify (js/imageViewer_paintLiquify.js) and smart filters (js/imageViewer_paintSmart.js).
// Run: node --test tests/test_paint_liquify.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as Q from "../js/imageViewer_paintLiquify.js";
import * as SF from "../js/imageViewer_paintSmart.js";
import * as D from "../js/imageViewer_paintData.js";

const W = 40, H = 30;
const bar = () => { const px = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 18; x < 22; x++) px.set([255, 0, 0, 255], (y * W + x) * 4); return px; };
const red = (px, x, y) => px[(y * W + x) * 4 + 3] > 128 && px[(y * W + x) * 4] > 128;

test("an empty field gives the picture back exactly", () => {
    const px = bar();
    assert.deepEqual(Q.liquifyPixels(px, Q.liquifyField(W, H)), px);
});

test("forward warp drags the picture along the stroke; reconstruct takes it back", () => {
    const px = bar(), f = Q.liquifyField(W, H);
    for (let k = 0; k < 8; k++) Q.liquifyDab(f, "push", 20 + k, 15, 10, 1, 1, 0);
    const out = Q.liquifyPixels(px, f);
    assert.ok(red(out, 26, 15), "pushed to the right");
    assert.ok(!red(out, 19, 15), "gone from where it was");
    assert.ok(red(out, 19, 2), "far from the brush: untouched");
    for (let k = 0; k < 40; k++) Q.liquifyDab(f, "reconstruct", 24, 15, 14, 1);
    const back = Q.liquifyPixels(px, f);
    assert.ok(red(back, 19, 15) && !red(back, 26, 15));
});

test("twirl turns, pucker pulls in, bloat pushes out", () => {
    const px = bar();
    const f = Q.liquifyField(W, H);
    for (let k = 0; k < 6; k++) Q.liquifyDab(f, "twirl_cw", 20, 15, 12, 1);
    const t = Q.liquifyPixels(px, f);
    // Clockwise on screen (y down): above the middle the bar leans right.
    assert.ok(red(t, 23, 8) && !red(t, 18, 8) && red(t, 16, 20), "the top to the right, the bottom to the left");
    const ff = Q.liquifyField(W, H);
    for (let k = 0; k < 6; k++) Q.liquifyDab(ff, "bloat", 20, 15, 12, 1);
    const b = Q.liquifyPixels(px, ff);
    assert.ok(red(b, 22, 15) && red(b, 17, 15), "bloat widens the bar");
    const fp = Q.liquifyField(W, H);
    for (let k = 0; k < 6; k++) Q.liquifyDab(fp, "pucker", 20, 15, 12, 1);
    const p = Q.liquifyPixels(px, fp);
    assert.ok(!red(p, 21, 15), "pucker narrows it");
    assert.equal(Q.falloff(0, 5), 1);
    assert.equal(Q.falloff(5, 5), 0);
    assert.equal(Q.liquifyDab(f, "push", -50, -50, 5, 1, 1, 0), null);
});

test("smart filters: cleaned, drawn in order on a canvas-sized copy, cached by the buffer's version", () => {
    assert.equal(SF.cleanFilters([{ type: "nope" }]), null);
    const fl = SF.cleanFilters([{ type: "blur", params: { radius: 999 } }, { type: "invert", on: false }]);
    assert.deepEqual(fl.map((f) => [f.type, f.on]), [["blur", true], ["invert", false]]);
    assert.equal(fl[0].params.radius, 250);
    const px = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    const L = { kind: "pixel", x: 3, y: 3, w: 4, h: 4, filters: [{ type: "invert", on: true, params: {} }] };
    assert.ok(SF.smartOn(L));
    const [L2, out] = SF.smartLayer(10, 10, L, px);
    assert.deepEqual([L2.x, L2.y, L2.w, L2.h], [0, 0, 10, 10]);
    assert.deepEqual([...out.slice((4 * 10 + 4) * 4, (4 * 10 + 4) * 4 + 4)], [0, 0, 0, 255]);
    assert.equal(out[3], 0);
    assert.equal(SF.smartLayer(10, 10, L, px)[1], out);                       // kept
    const blur = { ...L, filters: [{ type: "blur", on: true, params: { radius: 3 } }] };
    const [, b] = SF.smartLayer(10, 10, blur, px);
    assert.ok(b[(2 * 10 + 2) * 4 + 3] > 0, "a blur reaches past the layer's box");
    // In the composite, and switched off it is the plain layer.
    const doc = D.cleanDoc({ w: 10, h: 10, layers: [{ id: "a", kind: "pixel", x: 3, y: 3, w: 4, h: 4, filters: [{ type: "invert" }] }] });
    const c = D.composite(doc, () => px, () => null);
    assert.deepEqual([...c.slice((4 * 10 + 4) * 4, (4 * 10 + 4) * 4 + 4)], [0, 0, 0, 255]);
    doc.layers[0].filters[0].on = false;
    assert.deepEqual([...D.composite(doc, () => px, () => null).slice((4 * 10 + 4) * 4, (4 * 10 + 4) * 4 + 4)], [255, 255, 255, 255]);
});
