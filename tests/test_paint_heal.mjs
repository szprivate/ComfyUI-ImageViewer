// Paint's healing arithmetic (js/imageViewer_paintHeal.js): the membrane, seamless cloning, spot healing, the patch.
// Run: node --test tests/test_paint_heal.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as H from "../js/imageViewer_paintHeal.js";

const img = (w, h, f) => { const px = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...f(x, y), 255], (y * w + x) * 4); return px; };
const at = (px, w, x, y) => [...px.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
const disc = (w, h, cx, cy, r) => { const m = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) m[y * w + x] = 1; return m; };

test("the membrane between a 0 edge and a 1 edge is the straight line between them", () => {
    for (const w of [12, 70]) {
        const h = 40, vals = new Float64Array(w * h), inside = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (x === w - 1) vals[y * w + x] = 1; if (x > 0 && x < w - 1) inside[y * w + x] = 1; }
        H.membrane(vals, inside, w, h, 1, 400);
        for (const x of [3, Math.floor(w / 2), w - 3]) assert.ok(Math.abs(vals[10 * w + x] - x / (w - 1)) < 0.02, `w ${w} x ${x}: ${vals[10 * w + x]}`);
    }
});

test("cloning a brighter copy of the same gradient gives the destination back (the light comes from the edge)", () => {
    const w = 60, h = 50;
    const dst = img(w, h, (x, y) => [x * 3, y * 4, 100]);
    const src = img(w, h, (x, y) => [x * 3 + 40, y * 4 + 40, 140]);
    const cover = disc(w, h, 30, 25, 14);
    const box = H.insideBox(cover, w, h, 2);
    const healed = H.seamlessBox(dst, w, h, cover, src, (x, y) => (y * w + x) * 4, box);
    const out = H.blendHealed(dst, w, h, box, healed, cover);
    let worst = 0;
    for (let i = 0; i < dst.length; i++) worst = Math.max(worst, Math.abs(out[i] - dst[i]));
    assert.ok(worst <= 2, `differs by ${worst}`);
});

test("the spot healing brush takes a speck out of a texture", () => {
    const w = 90, h = 90;
    const px = img(w, h, (x, y) => ((x >> 3) + (y >> 3)) & 1 ? [200, 200, 200] : [60, 60, 60]);
    for (let y = 40; y < 48; y++) for (let x = 40; x < 48; x++) px.set([255, 0, 0, 255], (y * w + x) * 4);
    const out = H.spotHeal(px, w, h, disc(w, h, 44, 44, 7));
    for (let y = 40; y < 48; y++) for (let x = 40; x < 48; x++) { const [r, g] = at(out, w, x, y); assert.ok(r - g < 40, `still red at ${x},${y}: ${at(out, w, x, y)}`); }
    // Outside the brush nothing changed.
    assert.deepEqual(at(out, w, 5, 5), at(px, w, 5, 5));
    // Too big for any place around it: a smooth fill from its edge, still no red.
    const all = new Float32Array(w * h).fill(0);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) all[y * w + x] = 1;
    const flat = H.spotHeal(px, w, h, all);
    assert.ok(at(flat, w, 44, 44)[0] - at(flat, w, 44, 44)[1] < 40);
});

test("findSource keeps away from the region and prefers a place that looks alike", () => {
    const w = 120, h = 60;
    // Left: dark, right: light; a hole in the dark part is taken from the dark part.
    const px = img(w, h, (x) => (x < 60 ? [20, 20, 20] : [230, 230, 230]));
    const cover = disc(w, h, 25, 30, 6);
    const box = H.insideBox(cover, w, h, 0);
    const off = H.findSource(px, w, h, cover, box);
    assert.ok(off);
    assert.ok(Math.abs(off.dx) >= box.w || Math.abs(off.dy) >= box.h);
    assert.ok(25 + off.dx < 55, `took from ${25 + off.dx}`);
});

test("the patch fills the selection from where it is dragged, or carries it there", () => {
    const w = 80, h = 40;
    const px = img(w, h, () => [30, 90, 200]);
    for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) px.set([255, 0, 0, 255], (y * w + x) * 4);
    const sel = new Uint8Array(w * h);
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) sel[y * w + x] = 255;
    const r = H.patchArea(px, w, h, sel, 40, 0, "source");
    assert.deepEqual(at(r.px, w, 20, 20), [30, 90, 200, 255]);
    const d = H.patchArea(px, w, h, sel, 40, 0, "destination");
    assert.ok(at(d.px, w, 60, 20)[0] > 200);                 // the red square is now at 55..65 too
    assert.equal(d.region[20 * w + 60], 255);
    assert.ok(at(d.px, w, 20, 20)[0] > 200);                 // and still where it was
});

test("the clone source turned and scaled about where the offset was set", async () => {
    const D = await import("../js/imageViewer_paintData.js");
    assert.equal(D.cloneMatrix(0, 100, false), null);
    const m = D.cloneMatrix(90, 200, false);
    assert.ok(Math.abs(m.a) < 1e-9 && Math.abs(m.b - 2) < 1e-9 && Math.abs(m.c + 2) < 1e-9 && Math.abs(m.d) < 1e-9);
    // Anchor (10, 10), offset (+20, 0): a pixel 3 right of the anchor takes from 6 below the source point (turned 90°, twice as big).
    const c = { src: new Uint8ClampedArray(100 * 100 * 4), sw: 100, sh: 100, sx: 0, sy: 0, dx: 20, dy: 0, m, ax: 10.5, ay: 10.5 };
    assert.equal(D.cloneAt(c, 13, 10), (16 * 100 + 30) * 4);
    const f = { ...c, m: D.cloneMatrix(0, 100, true) };
    assert.equal(D.cloneAt(f, 13, 10), (10 * 100 + 27) * 4);   // flipped: 3 right is 3 left at the source
});
