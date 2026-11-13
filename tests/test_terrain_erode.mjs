// The erosion's arithmetic (js/imageViewer_terrainErode.js). Run: node --test tests/test_terrain_erode.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../js/imageViewer_terrainErode.js";

const hill = (n) => {
    const b = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        b[y * n + x] = 6 * Math.sin(x * 0.4) * Math.cos(y * 0.3) + 8 * Math.max(0, 1 - Math.hypot(x - n / 2, y - n / 2) / 10)
            + 3 * Math.sin(x * 1.7 + y * 2.3) + 10;
    }
    return b;
};
const sum = (a) => a.reduce((s, v) => s + v, 0);

test("settings are held to their ranges", () => {
    const o = E.cleanErode({ mode: "lava", iterations: -5, rain: 9, talus: 200, capacity: "x" });
    assert.equal(o.mode, "both");
    assert.equal(o.iterations, 1);
    assert.equal(o.rain, 1);
    assert.equal(o.talus, 89);
    assert.equal(o.capacity, E.ERODE_DEFAULTS.capacity);
});

test("sliding moves ground and keeps its amount", () => {
    const n = 33, b = hill(n), st = E.makeState(n, b);
    const before = sum(st.b);
    E.erode(st, { mode: "thermal", talus: 20, thermal: 2 }, 50);
    assert.ok(Math.abs(sum(st.b) - before) < 1e-3 * before);
    let moved = 0;
    for (let i = 0; i < b.length; i++) moved = Math.max(moved, Math.abs(st.b[i] - b[i]));
    assert.ok(moved > 0.1);
    assert.equal(sum(st.d), 0);
});

test("water carves, never digs below its neighbours, and stays finite", () => {
    const n = 33, b = hill(n), st = E.makeState(n, b);
    E.erode(st, { mode: "hydraulic" }, 200);
    let moved = 0;
    for (let i = 0; i < b.length; i++) {
        assert.ok(Number.isFinite(st.b[i]) && Number.isFinite(st.d[i]) && Number.isFinite(st.s[i]));
        assert.ok(st.d[i] >= 0 && st.s[i] >= -1e-6);
        moved = Math.max(moved, Math.abs(st.b[i] - b[i]));
    }
    assert.ok(moved > 0.05);
    // No new one-cell pits: water digs no hole below all its neighbours that was not there.
    const pits = (h) => {
        let count = 0;
        for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
            let lo = Infinity;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) lo = Math.min(lo, h[(y + dy) * n + x + dx]);
            if (h[y * n + x] < lo - 0.25) count++;
        }
        return count;
    };
    assert.ok(pits(st.b) <= pits(b), `${pits(st.b)} pits, ${pits(b)} before`);
});

test("masks are 0..1 and dry is the other side of wet", () => {
    const n = 25, st = E.makeState(n, hill(n));
    E.erode(st, {}, 100);
    const m = E.erodeMasks(st);
    for (const k of E.MASK_KINDS) {
        assert.equal(m[k].length, n * n);
        for (const v of m[k]) assert.ok(v >= 0 && v <= 1);
    }
    assert.ok(Math.max(...m.flow) > 0.99);
    for (let i = 0; i < n * n; i++) assert.ok(Math.abs(m.wetness[i] + m.dry[i] - 1) < 1e-6);
    const cells = E.maskToCells(m.flow, n, 16);
    assert.equal(cells.length, 256);
});

test("the result becomes sculpt over the generated heights, and layer paint", () => {
    const n = 3, base = new Float32Array([0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1]);
    const heights = base.map((h, i) => h * 10 + (i === 4 ? -2 : 0));
    const { grid, unit } = E.erodedSculpt(heights, base, 10, n);
    assert.equal(unit, 0.01);
    assert.ok(Math.abs(grid.cells[4] + 2) < 1e-6);
    assert.ok(Math.abs(grid.cells[0]) < 1e-6);
    // Too far for 16 bits of centimetres: a coarser unit.
    assert.ok(E.erodedSculpt(heights.map((h) => h + 500), base, 10, n).unit > 0.01);
    const masks = { erosion: new Float32Array(9).fill(1), deposit: new Float32Array(9) };
    const paint = E.erodedLayerPaint(masks, n, 4, 1);
    assert.equal(paint.length, 64);
    assert.ok(Math.abs(paint[1] - 1) < 1e-6 && paint[0] === 0);
    // Kept where the erosion leaves no mark.
    const prev = new Float32Array(64).fill(0.25);
    const kept = E.erodedLayerPaint({ erosion: new Float32Array(9), deposit: new Float32Array(9) }, n, 4, 1, prev);
    assert.deepEqual(Array.from(kept), Array.from(prev));
});
