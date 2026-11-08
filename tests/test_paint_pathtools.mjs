// Paint's path tools beside the pen (imageViewer_paintPathTools.js): what they compute.
// Run: node --test tests/test_paint_pathtools.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { anchorsInBox, moveAnchors, removeAnchors, toolGroup, TOOL_GROUPS, PATH_TOOLS } from "../js/imageViewer_paintPathTools.js";

const A = (x, y, ix = x, iy = y, ox = x, oy = y) => ({ x, y, ix, iy, ox, oy, smooth: false });
const path = { id: "p", name: "Path 1", closed: true, pts: [A(0, 0), A(10, 0, 8, -2, 12, 2), A(10, 10), A(0, 10)] };

test("the box picks the anchors inside it, whichever corners it is dragged from", () => {
    assert.deepEqual(anchorsInBox(path, -1, -1, 11, 1), [0, 1]);
    assert.deepEqual(anchorsInBox(path, 11, 11, 5, -1), [1, 2]);
    assert.deepEqual(anchorsInBox(path, 2, 2, 8, 8), []);
});

test("moving anchors takes their handles along and leaves the others; null moves them all", () => {
    const m = moveAnchors(path.pts, [1], 5, -3);
    assert.deepEqual(m[1], { x: 15, y: -3, ix: 13, iy: -5, ox: 17, oy: -1, smooth: false });
    assert.equal(m[0], path.pts[0]);
    const all = moveAnchors(path.pts, null, 1, 1);
    assert.deepEqual(all.map((a) => [a.x, a.y]), [[1, 1], [11, 1], [11, 11], [1, 11]]);
    assert.equal(path.pts[1].x, 10, "the path itself is not changed");
});

test("taking anchors away keeps the rest in order; under three a path is open", () => {
    const r = removeAnchors(path, [1]);
    assert.deepEqual(r.pts.map((a) => [a.x, a.y]), [[0, 0], [10, 10], [0, 10]]);
    assert.equal(r.closed, true);
    assert.equal(removeAnchors(path, [0, 2]).closed, false);
});

test("the pen and its five tools share one place, the pen first", () => {
    assert.deepEqual(TOOL_GROUPS.pen, PATH_TOOLS);
    assert.equal(PATH_TOOLS[0], "pen");
    for (const t of PATH_TOOLS) assert.equal(toolGroup(t), "pen");
    assert.equal(toolGroup("brush"), null);
});
