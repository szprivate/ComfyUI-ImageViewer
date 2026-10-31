// The Contact Sheet grid's layout math and sync rules (js/bEpicViewer_contactGrid.js).
// Run: node --test tests/test_contact_grid.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { gridLayout, fitRect, cellFrame, followRate, CONTACT_GRID_CAP } from "../js/bEpicViewer_contactGrid.js";

const W = 1600, H = 900;
const shape = (n, w = W, h = H, aspects = []) => { const l = gridLayout(n, w, h, aspects); return [l.cols, l.rows]; };

test("columns and rows for N 16:9 cells in a wide view", () => {
    assert.deepEqual(shape(1), [1, 1]);
    assert.deepEqual(shape(2), [2, 1]);
    assert.deepEqual(shape(3), [2, 2]);
    assert.deepEqual(shape(4), [2, 2]);
    assert.deepEqual(shape(6), [3, 2]);
    assert.deepEqual(shape(9), [3, 3]);
    assert.deepEqual(shape(12), [4, 3]);
    assert.deepEqual(shape(16), [4, 4]);
    assert.equal(CONTACT_GRID_CAP, 16);
});

test("the shape follows the view and the items' aspect ratios", () => {
    // A tall view stacks them.
    assert.deepEqual(shape(4, 500, 1400), [1, 4]);
    // Portrait clips in a wide view sit side by side.
    assert.deepEqual(shape(6, W, H, Array(6).fill(9 / 16)), [6, 1]);
    // Square pictures in a square view.
    assert.deepEqual(shape(9, 1000, 1000, Array(9).fill(1)), [3, 3]);
});

test("cells keep inside the view, do not overlap, and letterbox their media", () => {
    const aspects = [16 / 9, 9 / 16, 1, 2.39, 4 / 3];
    const l = gridLayout(5, W, H, aspects, { gap: 6, pad: 8 });
    assert.equal(l.cells.length, 5);
    for (const [i, c] of l.cells.entries()) {
        assert.ok(c.x >= 7.99 && c.y >= 7.99 && c.x + c.w <= W - 7.99 && c.y + c.h <= H - 7.99, `cell ${i} inside`);
        assert.ok(c.fit.w <= c.w + 1e-6 && c.fit.h <= c.h + 1e-6, `fit ${i} inside its cell`);
        assert.ok(Math.abs(c.fit.w / c.fit.h - aspects[i]) < 1e-6, `aspect ${i} kept`);
        // Centred in the cell, touching two opposite sides.
        assert.ok(Math.abs(c.fit.w - c.w) < 1e-6 || Math.abs(c.fit.h - c.h) < 1e-6);
        for (const [j, d] of l.cells.entries()) {
            if (j <= i) continue;
            const apart = c.x + c.w <= d.x + 1e-6 || d.x + d.w <= c.x + 1e-6 || c.y + c.h <= d.y + 1e-6 || d.y + d.h <= c.y + 1e-6;
            assert.ok(apart, `cells ${i} and ${j} apart`);
        }
    }
});

test("an incomplete last row is centred", () => {
    const l = gridLayout(5, W, H);                     // 3 + 2
    assert.deepEqual([l.cols, l.rows], [3, 2]);
    const last = l.cells.slice(3);
    const left = last[0].x, right = W - (last[1].x + last[1].w);
    assert.ok(Math.abs(left - right) < 1e-6);
});

test("nothing to lay out", () => {
    assert.deepEqual(gridLayout(0, W, H).cells, []);
    assert.deepEqual(gridLayout(3, 0, H).cells, []);
    assert.equal(gridLayout(3, W, H, [0, NaN, -1]).cells[0].fit.w / gridLayout(3, W, H).cells[0].fit.h > 0, true);
});

test("fitRect, the frame a cell shows, the follower's rate", () => {
    assert.deepEqual(fitRect(2, 0, 0, 100, 100), { x: 0, y: 25, w: 100, h: 50 });
    assert.deepEqual(fitRect(0.5, 0, 0, 100, 100), { x: 25, y: 0, w: 50, h: 100 });
    // Same index everywhere; a shorter clip holds its last frame.
    assert.equal(cellFrame(10, 48), 10);
    assert.equal(cellFrame(60, 48), 47);
    assert.equal(cellFrame(-3, 48), 0);
    assert.equal(cellFrame(7.9, 0), 7);
    // Ahead slows down, behind speeds up, capped at 25 %.
    assert.ok(followRate(1, 0.02) < 1 && followRate(1, -0.02) > 1);
    assert.equal(followRate(1, 0), 1);
    assert.equal(followRate(1, 5), 0.75);
    assert.equal(followRate(1, -5), 1.25);
});
