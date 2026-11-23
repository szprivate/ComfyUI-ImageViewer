// The shared mask shape (js/imageViewer_maskShape.js): B-spline anchors, flattening, conversion, point forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as MS from "../js/imageViewer_maskShape.js";

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const SQ = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }];

test("a closed B-spline's anchors are the textbook ones and are smooth", () => {
    const an = MS.bsplineAnchors(SQ, true);
    assert.equal(an.length, 4);
    // anchor 1: (P0 + 4 P1 + P2) / 6
    near(an[1].x, (0 + 240 + 60) / 6); near(an[1].y, (0 + 0 + 60) / 6);
    for (const a of an) { // in and out handles on one line through the anchor, equal length
        near(a.x - a.ix, a.ox - a.x); near(a.y - a.iy, a.oy - a.y);
    }
});

test("an open B-spline starts on its first control point and ends on its last", () => {
    const an = MS.bsplineAnchors(SQ, false);
    near(an[0].x, 0); near(an[0].y, 0);
    near(an[3].x, 0); near(an[3].y, 60);
});

test("a B-spline stays inside the hull of its control points", () => {
    for (const [x, y] of MS.shapePolygon(SQ, "bspline", true)) {
        assert.ok(x > 0 && x < 60 && y > 0 && y < 60);
    }
});

test("Bezier corners flatten to the points themselves", () => {
    const poly = MS.shapePolygon(SQ, "bezier", true);
    assert.deepEqual(poly, SQ.map((p) => [p.x, p.y]));
});

test("B-spline to Bezier keeps the curve; Bezier to B-spline keeps the points", () => {
    const ctrl = SQ.map((p) => MS.corner(p.x, p.y));
    const bez = MS.convertShape(ctrl, "bspline", "bezier", true);
    const a = MS.shapePolygon(ctrl, "bspline", true), b = MS.shapePolygon(bez, "bezier", true);
    assert.equal(a.length, b.length);
    a.forEach((p, i) => { near(p[0], b[i][0]); near(p[1], b[i][1]); });
    const back = MS.convertShape(bez, "bezier", "bspline", true);
    back.forEach((p, i) => assert.ok(!MS.hasHandles(p) && p.x === bez[i].x));
});

test("point forms go there and back", () => {
    const r = { x: 0.2, y: 0.3, cin: { x: 0.1, y: 0.3 }, cout: { x: 0.3, y: 0.3 } };
    assert.deepEqual(MS.toRoto(MS.fromRoto(r)), r);
    assert.deepEqual(MS.toRoto(MS.fromRoto({ x: 1, y: 2 })), { x: 1, y: 2 });
    assert.deepEqual(MS.toArr(MS.fromArr([1, 2])), [1, 2]);
    assert.deepEqual(MS.toArr(MS.fromArr([1, 2, 0, 2, 3, 2])), [1, 2, 0, 2, 3, 2]);
});

test("mirrored handles drawn out while placing a point", () => {
    const a = MS.mirrorHandles(MS.corner(10, 10), 20, 15);
    assert.deepEqual([a.ix, a.iy, a.ox, a.oy], [0, 5, 20, 15]);
});

test("the SVG path of a B-spline is a closed run of cubics", () => {
    const d = MS.curveD(MS.bsplineAnchors(SQ, true), true, (x, y) => [x, y]);
    assert.match(d, /^M .* C .* Z$/);
    assert.equal((d.match(/C /g) || []).length, 4);
});

test("unknown kinds read as Bezier", () => {
    assert.equal(MS.shapeKind(undefined), "bezier");
    assert.equal(MS.shapeKind("bspline"), "bspline");
});

test("every tool reads a B-spline shape through the shared module", async () => {
    const D = await import("../js/imageViewer_matchmoveData.js");
    const P = await import("../js/imageViewer_paintData.js");
    const sq = [[0, 0], [60, 0], [60, 60], [0, 60]];
    const want = MS.shapePolygon(sq.map(MS.fromArr), "bspline", true);
    const m = D.cleanMask({ shape: "bspline", keys: [{ f: 0, pts: sq }] });
    assert.equal(m.shape, "bspline");
    assert.deepEqual(D.maskPolygon(m, 0), want);
    const path = P.cleanPath({ closed: true, shape: "bspline", pts: sq.map(([x, y]) => ({ x, y })) });
    assert.equal(path.shape, "bspline");
    const line = P.flattenPath(path);
    assert.equal(line.length, want.length);
    line.forEach((p, i) => { near(p[0], want[i][0]); near(p[1], want[i][1]); });
});
