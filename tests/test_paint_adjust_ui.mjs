// The adjustment panels' arithmetic (imageViewer_paintAdjustUI.js) and Levels per channel (paintData).
//     node --test tests/test_paint_adjust_ui.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { histogram, remapHist, remapLum, autoLevels, gammaToShare, shareToGamma, levelsOf, levelsPatch, CURVE_PRESETS, histScale }
    from "../js/imageViewer_paintAdjustUI.js";
import * as D from "../js/imageViewer_paintData.js";

const px = (list) => new Uint8ClampedArray(list.flat());

test("the histogram counts each channel and the luminance, leaving see-through pixels out", () => {
    const h = histogram(px([[255, 0, 0, 255], [0, 0, 0, 255], [10, 20, 30, 0]]));
    assert.equal(h.n, 2);
    assert.equal(h.r[255], 1); assert.equal(h.r[0], 1);
    assert.equal(h.g[0], 2);
    assert.equal(h.l[Math.floor(0.2126 * 255 + 0.5)], 1);
    assert.equal(h.l[0], 1);
});

test("a table moves the counts; the luminance after follows all three tables", () => {
    const c = new Float64Array(256); c[10] = 3; c[200] = 2;
    const inv = new Float64Array(256).map((_, i) => 1 - i / 255);
    const out = remapHist(c, inv);
    assert.equal(out[245], 3); assert.equal(out[55], 2);
    const h = histogram(px([[100, 100, 100, 255]]));
    const lum = remapLum(h, [inv, inv, inv]);
    assert.equal(lum[155], 1);
});

test("auto levels cut 0.1 % at each end", () => {
    const c = new Float64Array(256);
    for (let i = 30; i <= 220; i++) c[i] = 100;
    c[0] = 5; c[255] = 5;                    // a few stray pixels at the very ends
    const a = autoLevels(c, 0.001);
    assert.equal(a.in_black, 30);
    assert.equal(a.in_white, 220);
    assert.deepEqual(autoLevels(new Float64Array(256)), { in_black: 0, in_white: 255 });
});

test("the grey slider and the gamma are each other's inverse", () => {
    assert.equal(gammaToShare(1), 0.5);
    for (const g of [0.3, 0.8, 1, 1.7, 3]) assert.ok(Math.abs(shareToGamma(gammaToShare(g)) - g) < 1e-9, String(g));
    assert.ok(gammaToShare(2) < 0.5);   // more gamma: the grey slider goes left (lighter midtones)
});

test("levels per channel: a channel of its own after the master, back to null at its defaults", () => {
    const p = D.cleanAdjust("levels", { in_black: 20, r: { in_white: 200 } });
    assert.equal(p.r.in_white, 200);
    assert.equal(p.g, null);
    assert.equal(levelsOf(p, "g").in_white, 255);
    assert.deepEqual(levelsPatch(p, "r", { in_white: 255 }), { r: null });
    assert.equal(levelsPatch(p, "rgb", { gamma: 1.5 }).in_black, 20);
    const luts = D.adjustLuts("levels", p);
    // red: the master (20..255) then its own (0..200); green only the master.
    const master = (v) => Math.min(1, Math.max(0, (v - 20 / 255) / (235 / 255)));
    const v = 120 / 255;
    assert.ok(Math.abs(luts[1][120] - master(v)) < 1e-12);
    assert.ok(Math.abs(luts[0][120] - Math.min(1, master(v) / (200 / 255))) < 1e-12);
});

test("presets are curves the data module takes; the scale leaves the ends out", () => {
    for (const p of Object.values(CURVE_PRESETS)) {
        const c = D.cleanAdjust("curves", { rgb: p.pts });
        assert.ok(c.rgb.length >= 2, p.label);
    }
    const c = new Float64Array(256); c[0] = 1e6; c[100] = 10;
    assert.ok(Math.abs(histScale(c) - 10.8) < 1e-9);
});
