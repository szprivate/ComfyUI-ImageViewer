// Paint's pen: the path arithmetic (imageViewer_paintData.js) and the editing helpers (imageViewer_paintPen.js).
// Run: node --test tests/test_paint_pen.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_paintData.js";
import { splitSegment, segmentHit } from "../js/imageViewer_paintPen.js";

const A = (x, y, ix = x, iy = y, ox = x, oy = y, smooth = false) => ({ x, y, ix, iy, ox, oy, smooth });

test("a straight path flattens to its anchors; a curve to many points ending on the anchor", () => {
    assert.deepEqual(D.flattenPath(D.cleanPath({ pts: [A(0, 0), A(10, 0), A(10, 10)] })), [[0, 0], [10, 0], [10, 10]]);
    const c = D.cleanPath({ closed: true, pts: [A(0, 0, 0, 0, 0, 20), A(30, 0, 30, 20, 30, 0), A(15, -10)] });
    const line = D.flattenPath(c);
    assert.ok(line.length > 10);
    assert.deepEqual(line[0], [0, 0]);
    assert.ok(line.some(([x, y]) => Math.abs(x - 30) < 1e-9 && Math.abs(y) < 1e-9));
});

test("cleanPath holds the numbers and drops a path with nothing in it", () => {
    const p = D.cleanPath({ name: "x", closed: true, pts: [{ x: "a", y: 3 }, { x: 1, y: 2 }] });
    assert.equal(p.closed, false);
    assert.deepEqual(p.pts[0], A(0, 3));
    assert.equal(D.cleanPaths([{ pts: [] }, { id: "q", pts: [A(1, 1)] }, { id: "q", pts: [A(2, 2)] }]).length, 1);
    assert.equal(D.cleanDoc({ w: 4, h: 4, layers: [] }).paths, undefined);
});

test("splitting a segment keeps the curve's shape", () => {
    const a = A(0, 0, 0, 0, 10, 20), b = A(40, 0, 30, 20, 40, 0);
    const [a2, m, b2] = splitSegment(a, b, 0.3);
    const [x, y] = D.bezierAt(a, b, 0.3);
    assert.ok(Math.abs(m.x - x) < 1e-9 && Math.abs(m.y - y) < 1e-9);
    for (const t of [0.2, 0.7]) {
        const [px, py] = D.bezierAt(a, b, 0.3 * t), [qx, qy] = D.bezierAt(a2, m, t);
        assert.ok(Math.hypot(px - qx, py - qy) < 1e-9);
        const [rx, ry] = D.bezierAt(a, b, 0.3 + 0.7 * t), [sx, sy] = D.bezierAt(m, b2, t);
        assert.ok(Math.hypot(rx - sx, ry - sy) < 1e-9);
    }
    // A straight segment stays straight, with a corner anchor.
    const [, m2] = splitSegment(A(0, 0), A(10, 0), 0.5);
    assert.deepEqual(m2, A(5, 0));
});

test("hits: handles before anchors, segments away from the ends", () => {
    const p = D.cleanPath({ pts: [A(0, 0, 0, 0, 5, 0, true), A(20, 0)] });
    assert.deepEqual(D.pathHit(p, 5, 0.5, 2), { i: 0, part: "out" });
    assert.deepEqual(D.pathHit(p, 20, 1, 2), { i: 1, part: "a" });
    assert.equal(D.pathHit(p, 10, 10, 2), null);
    const h = segmentHit(p, 10, 0.5, 2);
    assert.equal(h.i, 0);
    assert.ok(h.t > 0.3 && h.t < 0.7);
    assert.equal(segmentHit(p, 0.2, 0, 2), null);
});

test("moving: an anchor takes its handles, a smooth anchor's other handle turns with the one moved", () => {
    const a = A(10, 10, 0, 10, 20, 10, true);
    assert.deepEqual(D.movePathPoint(a, "a", 12, 13), A(12, 13, 2, 13, 22, 13, true));
    const b = D.movePathPoint(a, "out", 10, 30);
    assert.ok(Math.abs(b.ix - 10) < 1e-9 && Math.abs(b.iy - 0) < 1e-9);
    const c = D.movePathPoint(a, "out", 10, 30, true);
    assert.deepEqual([c.ix, c.iy, c.smooth], [0, 10, false]);
    assert.deepEqual(D.movePaths([{ id: "p", pts: [a] }], 1, 2, 2, 2)[0].pts[0], A(21, 22, 1, 22, 41, 22, true));
});

test("the stroke is width wide and antialiased at its edge", () => {
    const m = D.strokeMask(30, 10, [[2, 5.5], [28, 5.5]], false, 4);
    assert.equal(m[5 * 30 + 15], 255);
    assert.equal(m[4 * 30 + 15], 255);
    assert.equal(m[3 * 30 + 15], 128);
    assert.equal(m[2 * 30 + 15], 0);
});
