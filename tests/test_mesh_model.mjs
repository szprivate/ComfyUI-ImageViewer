// Modeling, part 3: subdivision, mirror, booleans, UVs (js/imageViewer_meshModel.js).
// Run: node --test tests/test_mesh_model.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../js/imageViewer_meshData.js";
import * as X from "../js/imageViewer_meshModel.js";
import * as O from "../js/imageViewer_meshOps.js";

const box = () => M.meshFromPrimitive("box");
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
function volume(m) {
    const p = M.meshTriangles(m).position;
    let v = 0;
    for (let i = 0; i < p.length; i += 9) {
        v += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
            + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
    }
    return v;
}
const moved = (m, d) => ({ v: m.v.map((p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]]), f: m.f.map((f) => f.slice()) });
const closed = (m) => O.boundaryLoops(m).length === 0;

test("subdivision: a cube's quads become four each and it rounds inwards, closed", () => {
    const s1 = X.subdivide(box(), 1);
    assert.deepEqual(M.meshStats(s1), { verts: 26, faces: 24, edges: 48, tris: 48 });
    // The cube's corner moves to (P(n-3) + 2R + F) / n with n = 3: 5/18 of the way.
    const c = s1.v[box().v.findIndex((p) => p.every((x) => x > 0))];
    close(c[0], 5 / 18);
    assert.ok(closed(s1));
    const s2 = X.subdivide(box(), 2);
    assert.equal(M.meshStats(s2).faces, 96);
    assert.ok(volume(s2) < volume(s1) && volume(s1) < 1);
    assert.equal(M.meshStats(X.subdivide(box(), 0)).faces, 6);
});

test("subdivision keeps a plane flat and its border where it was", () => {
    const g = X.subdivide(M.meshFromPrimitive("plane", { divisions: 2 }), 2);
    for (const p of g.v) { close(p[1], 0); assert.ok(Math.abs(p[0]) <= 0.5 + 1e-9 && Math.abs(p[2]) <= 0.5 + 1e-9); }
    // The corners stay put.
    assert.ok(g.v.some((p) => Math.abs(p[0] - 0.5) < 1e-9 && Math.abs(p[2] - 0.5) < 1e-9));
});

test("mirror makes a whole from a half, shares the seam, faces still out", () => {
    // Half a box: x from 0 to 0.5, open at x = 0.
    const b = moved(box(), [0.25, 0, 0]);
    b.v.forEach((p) => { p[0] = p[0] < 0.1 ? 0 : 0.5; });
    const half = M.deleteSel(b, "face", [b.f.findIndex((f) => f.every((i) => b.v[i][0] === 0))]).mesh;
    const whole = X.mirrorMesh(half, "x");
    assert.equal(M.meshStats(whole).verts, 12);
    assert.equal(M.meshStats(whole).faces, 10);
    assert.ok(closed(whole));
    close(volume(whole), 1);
    // Symmetrize: a box moved off the plane keeps its +x side and is mirrored.
    const sym = X.mirrorMesh(moved(box(), [0.25, 0, 0]), "x", { symmetrize: true });
    assert.ok(sym.v.every((p) => Math.abs(Math.abs(p[0]) - 0.75) < 1e-9 || Math.abs(p[0]) < 1e-9 || Math.abs(Math.abs(p[0]) - 0.25) < 1e-9));
});

test("booleans: union, subtract and intersect of two overlapping boxes have the right volumes", () => {
    const a = box(), b = moved(box(), [0.5, 0.5, 0.5]);
    // Overlap is 0.5^3.
    const u = X.booleanMesh(a, b, "union"), s = X.booleanMesh(a, b, "subtract"), i = X.booleanMesh(a, b, "intersect");
    close(volume(u), 2 - 0.125, 1e-6);
    close(volume(s), 1 - 0.125, 1e-6);
    close(volume(i), 0.125, 1e-6);
    for (const m of [u, s, i]) assert.ok(closed(m), "closed");
    // Dissolving coplanar pieces leaves the intersection a plain cube again.
    const d = X.dissolveCoplanar(i);
    assert.equal(M.meshStats(d).faces, 6);
    close(volume(d), 0.125, 1e-6);
    // Apart: subtract leaves a, intersect leaves nothing.
    const far = moved(box(), [5, 0, 0]);
    close(volume(X.booleanMesh(a, far, "subtract")), 1);
    assert.equal(X.booleanMesh(a, far, "intersect").f.length, 0);
});

test("transformMesh moves through a column-major matrix and keeps faces out under a mirror", () => {
    const t = X.transformMesh(box(), [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]);
    close(volume(t), 2);
    const flip = X.transformMesh(box(), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    close(volume(flip), 1);
});

test("UV projections and the options an item keeps", () => {
    const b = box();
    const tris = M.meshTriangles(b);
    const uv = X.projectUVs(b, tris, { type: "box", scale: 1 });
    assert.equal(uv.length, tris.tris.length * 6);
    for (const x of uv) assert.ok(x >= -1e-9 && x <= 1 + 1e-9);
    const s = M.meshFromPrimitive("sphere");
    const st = M.meshTriangles(s);
    const su = X.projectUVs(s, st, { type: "sphere" });
    // No triangle stretches across more than half the texture.
    for (let t = 0; t < st.tris.length; t++) {
        const us = [su[t * 6], su[t * 6 + 2], su[t * 6 + 4]];
        assert.ok(Math.max(...us) - Math.min(...us) <= 0.5);
    }
    assert.equal(X.cleanUv({ type: "none" }), null);
    assert.deepEqual(X.cleanUv({ type: "planar", axis: "q", scale: -2 }), { type: "planar", axis: "y", scale: 1, checker: false });
    assert.equal(X.cleanSubdiv(9), X.MAX_SUBDIV);
    assert.equal(X.cleanSubdiv("x"), 0);
});
