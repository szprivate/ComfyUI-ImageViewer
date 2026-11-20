// Snapping in the 3D view: options, the winner among candidates, axes, the grid (js/imageViewer_view3dSnap.js).
// Run: node --test tests/test_view3d_snap.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { cleanSnapOptions, pickSnap, axesOf, constrainTo, snapToGrid, nearestOnSegment } from "../js/imageViewer_view3dSnap.js";

const near = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test("the options keep their shape", () => {
    const o = cleanSnapOptions({ on: 1, surface: true, bogus: 3 });
    assert.equal(o.on, true);
    assert.equal(o.surface, true);
    assert.equal(o.grid, true);
    assert.equal("bogus" in o, false);
    assert.equal(cleanSnapOptions(null).on, false);
});

test("the nearest candidate within reach wins, a locator before a point at one distance", () => {
    const cands = [
        { x: 10, y: 10, kind: "point" },
        { x: 10, y: 10, kind: "locator" },
        { x: 30, y: 10, kind: "pivot" },
    ];
    assert.equal(pickSnap(cands, 11, 10).kind, "locator");
    assert.equal(pickSnap(cands, 29, 10).kind, "pivot");
    assert.equal(pickSnap(cands, 100, 100), null);
    // An edge has a smaller reach than a point.
    assert.equal(pickSnap([{ x: 0, y: 10, kind: "edge" }], 0, 0), null);
    assert.equal(pickSnap([{ x: 0, y: 10, kind: "point" }], 0, 0).kind, "point");
    // A point within reach beats an edge right under the pointer.
    assert.equal(pickSnap([{ x: 0, y: 0, kind: "edge" }, { x: 5, y: 5, kind: "point" }], 0, 0).kind, "point");
});

test("a handle's axes", () => {
    assert.deepEqual(axesOf("X"), [0]);
    assert.deepEqual(axesOf("XZ"), [0, 2]);
    assert.equal(axesOf("XYZ"), null);
    assert.equal(axesOf(null), null);
});

test("a target is taken onto the line or plane of the drag", () => {
    const W = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    assert.deepEqual(constrainTo([0, 0, 0], [3, 4, 5], W, [0]), [3, 0, 0]);
    assert.deepEqual(constrainTo([1, 1, 1], [3, 4, 5], W, [0, 2]), [3, 1, 5]);
    assert.deepEqual(constrainTo([1, 1, 1], [3, 4, 5], W, null), [3, 4, 5]);
    // A turned axis: 45 degrees about Y.
    const c = Math.SQRT1_2;
    const L = [[c, 0, -c], [0, 1, 0], [c, 0, c]];
    assert.ok(near(constrainTo([0, 0, 0], [2, 0, 0], L, [0]), [1, 0, -1]));
});

test("the grid rounds the dragged axes, the item's own axes turning it with the item", () => {
    const W = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    assert.deepEqual(snapToGrid([1.26, 0.4, 2.7], 0.5, W, [0], true), [1.5, 0.4, 2.7]);
    assert.deepEqual(snapToGrid([1.26, 0.4, 2.7], 0.5, W, null, true), [1.5, 0.5, 2.5]);
    // Not turned: the item's axes are the world's.
    assert.ok(near(snapToGrid([1.36, 0.4, 0.3], 0.5, W, [0], false), [1.5, 0.4, 0.3]));
    // Turned 45 degrees about Y: whole steps along its own X, its Z kept.
    const c = Math.SQRT1_2;
    const L = [[c, 0, -c], [0, 1, 0], [c, 0, c]];
    const q = snapToGrid([1.2 * c, 0, -1.2 * c], 1, L, [0], false);
    assert.ok(near(q, [c, 0, -c]));
    assert.deepEqual(snapToGrid([1, 2, 3], 0, W, null, true), [1, 2, 3]);
});

test("the nearest point on a segment", () => {
    assert.deepEqual(nearestOnSegment(0, 0, 10, 0, 4, 3), { t: 0.4, d: 3 });
    assert.equal(nearestOnSegment(0, 0, 10, 0, -5, 0).t, 0);
    assert.equal(nearestOnSegment(0, 0, 0, 0, 3, 4).d, 5);
});
