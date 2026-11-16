// A scatter's painted density as data (imageViewer_scatterPaint.js): stored form, the brush, the spots it keeps.
// Run: node --test tests/test_scatter_paint.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    cleanPaint, emptyGrid, decodePaint, encodePaint, paintAt, stampBrush, strokeBrush, brushFalloff,
    paintedSpots, paintedShare, PAINT_RES, DRAWS_PER_SPOT,
} from "../js/imageViewer_scatterPaint.js";
import { scatterSettings, makeScatterItem } from "../js/imageViewer_worldData.js";

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test("a stored paint is held to its rules; a broken one reads as none", () => {
    const g = emptyGrid(32);
    const p = encodePaint(g);
    assert.deepEqual(cleanPaint(p), p);
    assert.equal(cleanPaint(null), null);
    assert.equal(cleanPaint({ res: 32, data: "AAAA" }), null);           // wrong length
    assert.equal(cleanPaint({ res: 4, data: encodePaint(emptyGrid(4)).data }), null);   // too small
    assert.equal(cleanPaint({ res: 32, data: "not base64!" }), null);
    // scatterSettings keeps it, and a new scatter has none.
    assert.equal(makeScatterItem("s", "grass").scatter.paint, null);
    assert.deepEqual(scatterSettings({ scatter: { paint: p } }).paint, p);
});

test("encode and decode go round to the nearest of 255 steps", () => {
    const g = emptyGrid(16);
    g.cells[5] = 1; g.cells[6] = 0.5; g.cells[7] = 0.2;
    const back = decodePaint(encodePaint(g));
    assert.equal(back.res, 16);
    assert.equal(back.cells[5], 1);
    assert.ok(Math.abs(back.cells[6] - 0.5) < 1 / 255);
    assert.ok(Math.abs(back.cells[7] - 0.2) < 1 / 255);
    assert.equal(decodePaint(null).res, PAINT_RES);
});

test("the brush is full in its middle, nothing past its rim, and erases what it painted", () => {
    assert.equal(brushFalloff(0, 0.5), 1);
    assert.equal(brushFalloff(0.5, 0.5), 1);
    assert.equal(brushFalloff(1, 0.5), 0);
    assert.ok(brushFalloff(0.75, 0.5) > 0 && brushFalloff(0.75, 0.5) < 1);
    const g = emptyGrid(64);
    assert.ok(stampBrush(g, 0.5, 0.5, 0.1, 0.1, { strength: 1, hardness: 0.5 }));
    assert.ok(paintAt(g, 0.5, 0.5) > 0.99);
    assert.equal(paintAt(g, 0.9, 0.9), 0);
    assert.equal(paintAt(g, 0.5, 0.65), 0);          // past the rim (0.1)
    // Half strength goes half way, twice goes three quarters.
    const h = emptyGrid(64);
    stampBrush(h, 0.5, 0.5, 0.1, 0.1, { strength: 0.5, hardness: 0.9 });
    assert.ok(Math.abs(paintAt(h, 0.5, 0.5) - 0.5) < 0.01);
    stampBrush(h, 0.5, 0.5, 0.1, 0.1, { strength: 0.5, hardness: 0.9 });
    assert.ok(Math.abs(paintAt(h, 0.5, 0.5) - 0.75) < 0.01);
    stampBrush(g, 0.5, 0.5, 0.1, 0.1, { strength: 1, hardness: 0.9, erase: true });
    assert.ok(paintAt(g, 0.5, 0.5) < 0.01);
});

test("a stroke paints the whole way between its ends", () => {
    const g = emptyGrid(64);
    strokeBrush(g, 0.1, 0.5, 0.9, 0.5, 0.03, 0.03, { strength: 1, hardness: 0.5 });
    for (const u of [0.15, 0.3, 0.5, 0.7, 0.85]) assert.ok(paintAt(g, u, 0.5) > 0.9, `painted at ${u}`);
    assert.equal(paintAt(g, 0.5, 0.2), 0);
    const share = paintedShare(g);
    assert.ok(share > 0.03 && share < 0.1, `share ${share}`);
});

test("spots land only where the paint is, as thickly as it says", () => {
    const g = emptyGrid(64);
    // Left half full, right half a quarter.
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) g.cells[y * 64 + x] = x < 32 ? 1 : 0.25;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (y < 16) g.cells[y * 64 + x] = 0;
    const spots = paintedSpots(g, 20000, rng(3));
    const left = spots.filter((s) => s.u < 0.49 && s.v > 0.26).length;
    const right = spots.filter((s) => s.u > 0.51 && s.v > 0.26).length;
    const top = spots.filter((s) => s.v < 0.24).length;
    assert.equal(top, 0);
    assert.ok(Math.abs(right / left - 0.25) < 0.05, `ratio ${right / left}`);
    for (const s of spots) assert.equal(s.r.length, DRAWS_PER_SPOT - 3);
});

test("painting one place leaves every spot elsewhere where it was", () => {
    const g = emptyGrid(64);
    stampBrush(g, 0.25, 0.25, 0.15, 0.15, { strength: 1, hardness: 0.6 });
    const before = paintedSpots(g, 4000, rng(9));
    stampBrush(g, 0.8, 0.8, 0.1, 0.1, { strength: 1, hardness: 0.6 });
    const after = paintedSpots(g, 4000, rng(9));
    const key = (s) => `${s.u.toFixed(6)},${s.v.toFixed(6)},${s.r.map((x) => x.toFixed(6)).join(",")}`;
    const near = (s) => Math.hypot(s.u - 0.25, s.v - 0.25) < 0.2;
    const a = new Set(before.filter(near).map(key)), b = new Set(after.filter(near).map(key));
    assert.ok(a.size > 50);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.ok(after.length > before.length);
});
