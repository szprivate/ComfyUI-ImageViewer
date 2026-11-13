// node --test tests/test_comp_speed.mjs
// The faster kernels of the Comp preview make exactly the numbers of the plain loops they replaced: the box blur
// (rows and columns worked in another order, the same running sums) and the glow (its blurs through the bright
// part's box only).
import test from "node:test";
import assert from "node:assert/strict";
import * as O from "../js/imageViewer_compOps.js";
import * as L from "../js/imageViewer_compLight.js";

/** The box pass as it was written first (paint_math._box_axis): one line and channel at a time. */
function plainBoxAxis(a, w, h, r, horizontal) {
    if (r <= 0) return;
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    const stride = horizontal ? 4 : w * 4, lineStep = horizontal ? w * 4 : 4;
    const acc = new Float64Array(n + 2 * r + 2), div = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
        const base = line * lineStep;
        for (let ch = 0; ch < 4; ch++) {
            let sum = 0;
            acc[0] = 0;
            const P = n + 2 * r + 1;
            for (let k = 0; k < P; k++) {
                let idx = k - (r + 1);
                if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
                sum += a[base + idx * stride + ch];
                acc[k + 1] = sum;
            }
            for (let i = 0; i < n; i++) a[base + i * stride + ch] = (acc[i + 2 * r + 2] - acc[i + 1]) / div;
        }
    }
}
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = (w, h) => ({ w, h, data: new Float32Array(w * h * 4).map(() => rnd() * 3 - 0.5) });

test("the box pass gives the plain loop's numbers, both ways, at every size and reach", () => {
    for (const [w, h] of [[1, 1], [1, 9], [9, 1], [37, 23], [70, 300], [300, 2]]) {
        for (const r of [1, 2, 5, 40, 400]) {
            for (const horizontal of [true, false]) {
                const src = noise(w, h).data, a = new Float64Array(src), b = new Float64Array(src);
                O.boxAxis(a, w, h, r, horizontal);
                plainBoxAxis(b, w, h, r, horizontal);
                assert.deepEqual(a, b, `${w}x${h} r=${r} ${horizontal ? "rows" : "columns"}`);
            }
        }
    }
});

test("a blur is the three plain passes, also inside a box", () => {
    const img = noise(83, 41);
    for (const size of [0.7, 3, 12, 60]) {
        const a = new Float64Array(img.data);
        for (const s of O.boxesForGauss(size / 2)) { const r = (s - 1) >> 1; plainBoxAxis(a, 83, 41, r, true); plainBoxAxis(a, 83, 41, r, false); }
        assert.deepEqual(O.blurImage(img, size).data, new Float32Array(a), `size ${size}`);
    }
    // a spot in a box: the same as blurring the whole picture
    const spot = { w: 120, h: 80, data: new Float32Array(120 * 80 * 4) };
    for (let y = 30; y < 40; y++) for (let x = 50; x < 64; x++) for (let c = 0; c < 4; c++) spot.data[(y * 120 + x) * 4 + c] = rnd();
    const whole = O.blurImage(spot, 9).data;
    const boxed = O.blurImage(O.withBox({ ...spot }, O.scanBox(spot)), 9).data;
    assert.deepEqual(boxed, whole);
});

test("a glow of a few bright pixels is the glow of the whole picture", () => {
    const img = { w: 90, h: 60, data: new Float32Array(90 * 60 * 4) };
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 0.3; img.data[i + 3] = 1; }
    for (let y = 20; y < 26; y++) for (let x = 40; x < 47; x++) img.data[(y * 90 + x) * 4] = 4;
    const p = { threshold: 0.8, softness: 0.2, size: 30, steps: 4, intensity: 1, tint: [1, 1, 1, 1], source: "luminance", effect_only: "off" };
    const got = L.glowImage(img, p).data;
    // the same, worked the old way: blurs over the whole picture (no box)
    const hi = { w: 90, h: 60, data: new Float32Array(90 * 60 * 4) };
    for (let i = 0; i < hi.data.length; i += 4) {
        const Y = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
        const k = Math.min(1, Math.max(0, (Y - 0.8) / 0.2));
        hi.data[i] = img.data[i] * k; hi.data[i + 1] = img.data[i + 1] * k; hi.data[i + 2] = img.data[i + 2] * k;
    }
    const acc = new Float64Array(hi.data.length);
    let size = 30;
    for (let k = 0; k < 4; k++) { const b = O.blurImage(hi, size).data; for (let i = 0; i < acc.length; i++) acc[i] += b[i]; size /= 2; }
    for (let i = 0; i < acc.length; i += 4) {
        assert.equal(got[i], Math.fround(img.data[i] + acc[i] / 4));
        assert.equal(got[i + 3], img.data[i + 3]);
    }
});
