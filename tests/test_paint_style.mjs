// Paint's layer styles (js/imageViewer_paintStyle.js): the settings, the spread, the shadow's offset,
// the styled picture, its cache, and the composite drawing it.
// Run: node --test tests/test_paint_style.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_paintStyle.js";
import * as D from "../js/imageViewer_paintData.js";

test("cleanStyle: ranges, whole stroke sizes, unknown effects gone, nothing left is null", () => {
    const s = S.cleanStyle({ stroke: { size: 300.4, color: [300, -5, 7] }, bevel: {}, shadow: { on: false, opacity: 3 } });
    assert.deepEqual(s.stroke, { on: true, color: [255, 0, 7], opacity: 1, size: 100 });
    assert.equal(s.shadow.on, false);
    assert.equal(s.shadow.opacity, 1);
    assert.equal(s.bevel, undefined);
    assert.equal(S.cleanStyle({ bevel: {} }), null);
    assert.equal(S.styleOn({ kind: "pixel", style: s }), true);
    assert.equal(S.styleOn({ kind: "pixel", style: { shadow: { on: false } } }), false);
    assert.equal(S.styleOn({ kind: "adjust", style: s }), false);
    // The layer keeps it through cleanLayer.
    assert.deepEqual(D.cleanLayer({ kind: "pixel", w: 1, h: 1, style: { glow: {} }, lockAlpha: 1 }).style.glow.size, 20);
    assert.equal(D.cleanLayer({ kind: "pixel", w: 1, h: 1, lockAlpha: 1 }).lockAlpha, true);
});

test("dilate: a disc; the shadow's offset away from the light", () => {
    const m = new Uint8Array(121);
    m[5 * 11 + 5] = 255;
    const d = S.dilate(m, 11, 11, 3);
    assert.equal(d.reduce((a, v) => a + (v ? 1 : 0), 0), 29);
    assert.equal(d[7 * 11 + 7], 255);
    assert.equal(d[8 * 11 + 6], 0);
    assert.deepEqual(S.shadowOffset(90, 5), [0, 5]);      // light from above: the shadow below
    assert.deepEqual(S.shadowOffset(180, 4), [4, 0]);     // light from the left: to the right
});

test("styledPixels: edge, shadow and overlay where they belong; the composite draws them; the cache follows changes", () => {
    const W = 30, H = 30;
    const px = new Uint8ClampedArray(10 * 10 * 4);
    for (let i = 0; i < 100; i++) px.set([200, 0, 0, 255], i * 4);
    const L = D.cleanLayer({ id: "a", kind: "pixel", x: 10, y: 10, w: 10, h: 10,
                             style: { stroke: { size: 2, color: [0, 0, 255] }, shadow: { angle: 90, distance: 6, size: 0, opacity: 1 }, overlay: { color: [0, 255, 0], opacity: 0.5 } } });
    const out = S.styledPixels(W, H, L, px, null);
    const at = (x, y) => [...out.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
    assert.deepEqual(at(15, 15), [100, 128, 0, 255]);       // the layer, half toward green
    assert.deepEqual(at(8, 15), [0, 0, 255, 255]);          // its edge
    assert.deepEqual(at(15, 24), [0, 0, 0, 255]);           // the shadow, 6 px down
    assert.deepEqual(at(2, 2), [0, 0, 0, 0]);
    const doc = { w: W, h: H, layers: [L] };
    const comp = () => D.composite(doc, () => px, () => null);
    assert.deepEqual([...comp().slice((15 * W + 8) * 4, (15 * W + 8) * 4 + 4)], [0, 0, 255, 255]);
    // The pixels change and their version is counted: the style is drawn again.
    for (let i = 0; i < 100; i++) px.set([0, 0, 0, 0], i * 4);
    S.BUF_VER.set(px, 1);
    assert.equal(comp()[(15 * W + 8) * 4 + 3], 0);
});
