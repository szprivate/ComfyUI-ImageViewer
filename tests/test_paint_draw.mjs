// Paint's gradient, shapes, dodge / burn / sponge and smudge (js/imageViewer_paintDraw.js, paintData's toneAt).
// Run: node --test tests/test_paint_draw.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../js/imageViewer_paintDraw.js";
import * as D from "../js/imageViewer_paintData.js";

test("gradient share: every type at its start, its end and between", () => {
    const s = (type, x, y) => G.gradientShare(type, x, y, 10, 10, 30, 10);
    assert.equal(s("linear", 10, 10), 0);
    assert.equal(s("linear", 30, 10), 1);
    assert.equal(s("linear", 20, 55), 0.5);              // across the drag it does not change
    assert.equal(s("linear", 0, 10), 0);                 // held before the start and after the end
    assert.equal(s("reflected", 0, 10), 0.5);            // mirrored about the start
    assert.equal(s("radial", 10, 20), 0.5);
    assert.equal(s("radial", 10, 40), 1);
    assert.equal(s("diamond", 15, 15), 0.5);             // |u| + |v|
    assert.equal(s("angle", 20, 10), 0);
    assert.ok(Math.abs(s("angle", 10, 20) - 0.25) < 1e-12);  // a quarter turn (clockwise on screen, y down)
    assert.equal(G.gradientShare("linear", 4, 4, 5, 5, 5, 5), 0);  // no drag: the start colour
});

test("gradient colours: stops mixed premultiplied, presets, reverse", () => {
    const st = G.gradientStops("fg-clear", [255, 0, 0], [0, 0, 255]);
    const c = G.gradientColor(st, 0.5);
    assert.deepEqual(c.map((v) => Math.round(v * 255)), [255, 0, 0, 128]);   // fading out stays red, not dark red
    const px = G.gradientPixels(4, 1, 0, 0, { type: "linear", x0: 0, y0: 0, x1: 4, y1: 0, stops: G.gradientStops("bw", [0, 0, 0], [0, 0, 0]) });
    assert.deepEqual([px[0], px[4], px[8], px[12]], [32, 96, 159, 223]);
    const rv = G.gradientPixels(4, 1, 0, 0, { type: "linear", x0: 0, y0: 0, x1: 4, y1: 0, reverse: true, stops: G.gradientStops("bw", [0, 0, 0], [0, 0, 0]) });
    assert.deepEqual([rv[0], rv[12]], [223, 32]);
    assert.equal(G.gradientStops("fg-bg-fg", [1, 2, 3], [4, 5, 6]).length, 3);
    assert.deepEqual(G.cleanStops([{ t: 2, c: [300, -1, 5] }]).map((s) => [s.t, s.c]), [[1, [255, 0, 5, 255]], [1, [255, 0, 5, 255]]]);
});

test("layOver: Normal over by the source's alpha, the opacity and a mask", () => {
    const back = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255]);
    const src = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]);
    const out = G.layOver(back, src, 0.5, new Uint8Array([255, 0]));
    assert.deepEqual([...out], [128, 0, 128, 255, 0, 0, 255, 255]);
});

test("shapes: their outlines as paths", () => {
    const r = G.shapePath("rect", 30, 20, 10, 5);
    assert.deepEqual(r.pts.map((p) => [p.x, p.y]), [[10, 5], [30, 5], [30, 20], [10, 20]]);
    const m = D.pathMask(40, 30, D.cleanPath(r));
    assert.equal(m[10 * 40 + 20], 255);
    assert.equal(m[2 * 40 + 20], 0);
    const rr = G.shapePath("rounded", 0, 0, 20, 10, { radius: 50 });
    assert.equal(rr.pts.length, 8);                                    // the radius held to half the side
    assert.deepEqual([rr.pts[0].x, rr.pts[2].y], [5, 5]);
    const e = D.flattenPath(D.cleanPath(G.shapePath("ellipse", 0, 0, 40, 20)));
    for (const [x, y] of e) assert.ok(Math.abs(((x - 20) / 20) ** 2 + ((y - 10) / 10) ** 2 - 1) < 0.01);   // on the ellipse
    const p = G.shapePath("polygon", 0, 0, 20, 20, { sides: 3 });
    assert.equal(p.pts.length, 3);
    assert.deepEqual([p.pts[0].x, p.pts[0].y], [10, 0]);              // a point at the top
    const l = G.shapePath("line", 1, 2, 3, 4);
    assert.equal(l.closed, false);
    assert.deepEqual(G.shapeBox(10, 10, 14, 30, true, false), [10, 10, 30, 30]);
    assert.deepEqual(G.shapeBox(10, 10, 14, 13, false, true), [6, 7, 14, 13]);
    const [x, y] = G.snap45(0, 0, 10, 1);
    assert.ok(Math.abs(y) < 1e-9 && Math.abs(x - Math.hypot(10, 1)) < 1e-9);
});

test("dodge, burn, sponge: toward white / black by the range, colour out or in", () => {
    const g = [0.5, 0.5, 0.5];
    assert.deepEqual(D.toneAt({ mode: "dodge", range: "midtones" }, ...g, 1), [1, 1, 1]);
    assert.deepEqual(D.toneAt({ mode: "burn", range: "midtones" }, ...g, 0.5), [0.25, 0.25, 0.25]);
    // Shadows: a dark pixel moves more than a light one; highlights the other way round.
    const dk = D.toneAt({ mode: "dodge", range: "shadows" }, 0.1, 0.1, 0.1, 0.5)[0] - 0.1;
    const lt = D.toneAt({ mode: "dodge", range: "shadows" }, 0.9, 0.9, 0.9, 0.5)[0] - 0.9;
    assert.ok(dk > 0.3 && lt < 0.01);
    assert.ok(0.9 - D.toneAt({ mode: "burn", range: "highlights" }, 0.9, 0.9, 0.9, 0.5)[0] > 0.3);
    const red = [1, 0, 0], Y = 0.2126;
    const des = D.toneAt({ mode: "sponge", sat: "desaturate" }, ...red, 1);
    for (const v of des) assert.ok(Math.abs(v - Y) < 1e-12);
    const sat = D.toneAt({ mode: "sponge", sat: "saturate" }, 0.6, 0.5, 0.5, 1);
    assert.ok(sat[0] > 0.6 && sat[1] < 0.5);
    // In the stamp: alpha kept, the pixel from before the stroke changed once per stroke.
    const px = new Uint8ClampedArray(9 * 9 * 4);
    for (let i = 0; i < 81; i++) px.set([128, 128, 128, 200], i * 4);
    const st = { px, orig: new Uint8ClampedArray(px), cover: new Float32Array(81), lw: 9, lh: 9, lx: 0, ly: 0, W: 9, H: 9,
                 color: [0, 0, 0], opacity: 1, tone: { mode: "burn", range: "midtones" } };
    D.stamp(st, 4.5, 4.5, 3, 1);
    D.stamp(st, 4.5, 4.5, 3, 1);
    const o = (4 * 9 + 4) * 4;
    assert.deepEqual([px[o], px[o + 3]], [D.q8(D.toneAt(st.tone, 128 / 255, 128 / 255, 128 / 255, 1)[0]), 200]);
});

test("smudge: drags the colour where the stroke began along it, as far as the strength carries", () => {
    const W = 30, H = 5, mk = () => {
        const px = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(x < 5 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * W + x) * 4);
        return px;
    };
    const run = (strength, finger = false) => {
        const px = mk();
        const st = { px, orig: new Uint8ClampedArray(px), lw: W, lh: H, lx: 0, ly: 0, W, H, smudge: G.smudgeStart(2, finger, [0, 255, 0]) };
        for (let x = 2; x <= 20; x++) G.smudgeDab(st, x + 0.5, 2.5, 2, 1, strength);
        return px;
    };
    const redAt = (px, x) => px[(2 * W + x) * 4];
    const strong = run(0.9), weak = run(0.3);
    assert.ok(redAt(strong, 12) > 100, redAt(strong, 12));
    assert.ok(redAt(strong, 12) > redAt(weak, 12));
    assert.ok(redAt(strong, 12) > redAt(strong, 19));        // fading along the way
    assert.equal(redAt(strong, 28), 0);                       // beyond the stroke: untouched
    const finger = run(0.9, true);
    assert.ok(finger[(2 * W + 3) * 4 + 1] > 150);             // finger painting starts with the colour
});
