// Paint's smart layers, the arithmetic (js/imageViewer_paintSmartLayer.js): run with node --test.
import test from "node:test";
import assert from "node:assert/strict";
import * as SL from "../js/imageViewer_paintSmartLayer.js";

const noise = (w, h, seed = 1) => {
    let s = seed;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i++) { s = (s * 1103515245 + 12345) >>> 0; px[i] = (s >>> 16) & 255; }
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    return px;
};

test("drawn at its own place and size, a source is itself, pixel for pixel", () => {
    const px = noise(31, 17), r = SL.render({ px, w: 31, h: 17 }, SL.move3(5, -3), 40, 30);
    assert.deepEqual(r.box, { x: 5, y: -3, w: 31, h: 17 });
    assert.deepEqual(Array.from(r.px), Array.from(px));
    assert.deepEqual(r.m, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.equal(r.cut, false);
});

test("the level read is the smallest still at least half the size drawn", () => {
    assert.equal(SL.levelFor(SL.scale3(1), 100, 100), 0);
    assert.equal(SL.levelFor(SL.scale3(0.6), 100, 100), 0);
    assert.equal(SL.levelFor(SL.scale3(0.4), 100, 100), 1);
    assert.equal(SL.levelFor(SL.scale3(0.1), 100, 100), 3);
    assert.equal(SL.levelFor(SL.scale3(0.5, 0.05), 100, 100), 4);      // the side shrunk most decides
});

test("halving takes the premultiplied mean of what is there (odd sizes round up)", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255]);   // 3 x 1: red, clear blue, green
    const h = SL.halveRGBA(px, 3, 1);
    assert.equal(h.w, 2); assert.equal(h.h, 1);
    assert.deepEqual(Array.from(h.px.slice(0, 4)), [255, 0, 0, 128]);   // red only (the clear one adds no colour), half covered
    assert.deepEqual(Array.from(h.px.slice(4)), [0, 255, 0, 255]);
});

test("scaled down and up again, a smart layer is its source again (a plain layer would be blurred)", () => {
    const w = 64, h = 48, px = noise(w, h, 7), src = { px, w, h };
    let L = { x: 0, y: 0, smart: { src: "a", sw: w, sh: h, m: [1, 0, 0, 0, 1, 0, 0, 0, 1] } };
    const step = (G) => { const r = SL.render(src, SL.mul3(G, SL.canvasMatrix(L)), 100, 100); L = { x: r.box.x, y: r.box.y, w: r.box.w, h: r.box.h, smart: { ...L.smart, m: r.m } }; return r; };
    step(SL.scale3(0.1));
    const r = step(SL.scale3(10));
    assert.deepEqual(r.box, { x: 0, y: 0, w, h });
    let diff = 0;
    for (let i = 0; i < px.length; i++) diff = Math.max(diff, Math.abs(px[i] - r.px[i]));
    assert.ok(diff <= 1, `max difference ${diff}`);
});

test("a layer far bigger than the canvas is drawn only over the canvas", () => {
    const r = SL.render({ px: noise(20, 20), w: 20, h: 20 }, SL.mul3(SL.move3(-500, -500), SL.scale3(300)), 50, 40);
    assert.equal(r.cut, true);
    assert.deepEqual(r.box, { x: 0, y: 0, w: 50, h: 40 });
});

test("cleanSmart keeps a sound description and drops anything else", () => {
    const ok = { src: "s1", sw: 10, sh: 5, m: [2, 0, 1, 0, 2, 1, 0, 0, 1] };
    assert.deepEqual(SL.cleanSmart(ok), ok);
    assert.equal(SL.cleanSmart({ ...ok, src: "../x" }), null);
    assert.equal(SL.cleanSmart({ ...ok, m: [0, 0, 0, 0, 0, 0, 0, 0, 1] }), null);       // flat
    assert.equal(SL.cleanSmart({ ...ok, m: [1, 0, 0, 0, 1, 0, -1, 0, 1] }), null);      // behind the eye
    assert.equal(SL.cleanSmart({ ...ok, sw: 0 }), null);
});

test("placed: its own size in the middle, or fitted inside a smaller canvas", () => {
    assert.deepEqual(SL.placeMatrix(100, 50, 300, 200), [1, 0, 100, 0, 1, 75, 0, 0, 1]);
    const m = SL.placeMatrix(1000, 500, 300, 200);
    assert.deepEqual(SL.corners(m, 1000, 500).map(([x, y]) => [Math.round(x), Math.round(y)]), [[0, 25], [300, 25], [300, 175], [0, 175]]);
});
