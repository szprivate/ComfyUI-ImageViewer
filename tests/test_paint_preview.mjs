// The quick preview's arithmetic (imageViewer_paintPreview.js): the factor and the shrinking.
//     node --test tests/test_paint_preview.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { previewFactor, shrinkRGBA, shrinkGray, PREVIEW_MIN_PIXELS } from "../js/imageViewer_paintPreview.js";

test("a small picture, or one seen at half its size or more, is drawn in full", () => {
    assert.equal(previewFactor(1600, 1200, 0.1), 1);
    assert.ok(1600 * 1200 < PREVIEW_MIN_PIXELS);
    assert.equal(previewFactor(4000, 3000, 1), 1);
    assert.equal(previewFactor(4000, 3000, 0.6), 1);
    assert.equal(previewFactor(4000, 3000, 0), 1);
});

test("a big picture seen small is previewed at the whole factor that fits the screen", () => {
    assert.equal(previewFactor(4000, 3000, 0.5), 2);
    assert.equal(previewFactor(4000, 3000, 0.3), 3);
    assert.equal(previewFactor(4000, 3000, 0.24), 4);
    assert.equal(previewFactor(16000, 16000, 0.001), 16);
});

test("shrinkRGBA averages each box, colour weighted by alpha, and keeps a ragged edge", () => {
    // 3 x 2: red opaque, clear, blue opaque | green half, red opaque, clear.
    const px = new Uint8ClampedArray([255, 0, 0, 255, 9, 9, 9, 0, 0, 0, 255, 255,
                                      0, 255, 0, 128, 255, 0, 0, 255, 0, 0, 0, 0]);
    const [out, w, h] = shrinkRGBA(px, 3, 2, 2);
    assert.deepEqual([w, h], [2, 1]);
    // The first box: red 255 + green 128 + red 255 of alpha over 4 pixels; the clear pixel's colour does not count.
    const a = 255 + 128 + 255;
    assert.deepEqual([...out.slice(0, 4)], [Math.round((255 * 510) / a), Math.round((255 * 128) / a), 0, Math.round(a / 4)]);
    // The ragged box: blue and clear.
    assert.deepEqual([...out.slice(4, 8)], [0, 0, 255, 128]);
    // All clear: clear.
    assert.deepEqual([...shrinkRGBA(new Uint8ClampedArray(16), 2, 2, 2)[0]], [0, 0, 0, 0]);
});

test("shrinkGray averages each box", () => {
    const [out, w, h] = shrinkGray(new Uint8Array([0, 255, 255, 255, 100, 100, 100, 0, 50]), 3, 3, 2);
    assert.deepEqual([w, h], [2, 2]);
    assert.deepEqual([...out], [Math.round((0 + 255 + 255 + 100) / 4), Math.round((255 + 100) / 2), Math.round((100 + 0) / 2), 50]);
});
