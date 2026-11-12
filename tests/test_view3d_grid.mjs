// The 3D space's grid options (imageViewer_view3dGrid.js), the pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanGridOptions, gridLayout, GRID_DEFAULTS, MAX_LINES } from "../js/imageViewer_view3dGrid.js";

test("options are made whole and held in range", () => {
    assert.deepEqual(cleanGridOptions(null), { ...GRID_DEFAULTS });
    assert.deepEqual(cleanGridOptions({ size: "50", spacing: "0,5", major: 4.6, auto: false }),
                     { size: 50, spacing: 0.5, major: 5, auto: false });
    const bad = cleanGridOptions({ size: -3, spacing: "x", major: 1e9 });
    assert.equal(bad.size, 0.01);
    assert.equal(bad.spacing, GRID_DEFAULTS.spacing);
    assert.equal(bad.major, 100);
});

test("the default grid is ComfyUI's 20 x 20", () => {
    assert.deepEqual(gridLayout(GRID_DEFAULTS), { divisions: 20, size: 20, spacing: 1, half: 10, major: 10 });
});

test("lines lie on multiples of the spacing from the origin", () => {
    const lay = gridLayout({ size: 10, spacing: 0.25 });
    assert.equal(lay.divisions, 40);
    assert.equal(lay.size, 10);
    const odd = gridLayout({ size: 7, spacing: 2 });
    assert.equal(odd.divisions % 2, 0);
    assert.equal(odd.size, odd.divisions * 2);
});

test("a grid of too many lines gets a wider spacing", () => {
    const lay = gridLayout({ size: 10000, spacing: 0.01 });
    assert.ok(lay.divisions <= MAX_LINES);
    assert.ok(lay.spacing > 0.01);
    assert.ok(Math.abs(lay.size - 10000) / 10000 < 0.01);
});
