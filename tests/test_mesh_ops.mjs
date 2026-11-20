// Modeling, part 2: loops, rings, loop cut, bevel, bridge, fill, connect, merge by distance, soft selection
// (js/imageViewer_meshOps.js). Run: node --test tests/test_mesh_ops.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../js/imageViewer_meshData.js";
import * as O from "../js/imageViewer_meshOps.js";

const box = () => M.meshFromPrimitive("box");
const keys = (m) => M.meshEdges(m).map(([a, b]) => M.edgeKey(a, b));
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
/** An edge between two points, by where they are. */
function edgeAtPoints(m, p, q) {
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
    const a = m.v.findIndex((v) => near(v, p)), b = m.v.findIndex((v) => near(v, q));
    return M.edgeKey(a, b);
}

test("a ring goes round a box; a loop follows a grid's line and stops at its border", () => {
    const b = box();
    const k = edgeAtPoints(b, [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]);
    assert.equal(O.edgeRing(b, k).length, 4);
    // A box's corners are not ordinary grid vertices: the loop is the edge alone.
    assert.deepEqual(O.edgeLoop(b, k), [k]);
    const g = M.meshFromPrimitive("plane", { divisions: 4 });
    const e = edgeAtPoints(g, [-0.25, 0, -0.25], [0, 0, -0.25]);
    const loop = O.edgeLoop(g, e);
    assert.equal(loop.length, 4);                 // all the way across, border to border
    for (const kk of loop) for (const i of M.edgeEnds(kk)) close(g.v[i][2], -0.25);
    assert.equal(O.edgeRing(g, e).length, 5);     // across the quads, both ways to the border
});

test("a loop cut splits every quad of the ring, at the same place along each, and keeps the volume", () => {
    const b = box();
    const k = edgeAtPoints(b, [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]);
    const r = O.loopCut(b, k, 0.25);
    assert.deepEqual(M.meshStats(r.mesh), { verts: 12, faces: 10, edges: 20, tris: 20 });
    assert.equal(r.ids.length, 4);
    // The new loop lies in one plane across z.
    const zs = new Set();
    for (const kk of r.ids) for (const i of M.edgeEnds(kk)) zs.add(Math.round(r.mesh.v[i][2] * 1e6) / 1e6);
    assert.equal(zs.size, 1);
    close(Math.abs([...zs][0]), 0.25);
    close(volume(r.mesh), 1);
    assert.equal(O.boundaryLoops(r.mesh).length, 0);
});

test("a loop cut that reaches a face that is not a quad puts the new vertex in its side", () => {
    // A box with a triangle fan for its top: the ring from a side edge stops at the top.
    const b = box();
    const top = b.f.findIndex((f) => f.every((i) => b.v[i][1] > 0));
    const c = b.v.length;
    b.v.push([0, 0.5, 0]);
    const f = b.f[top];
    b.f.splice(top, 1, ...f.map((i, k) => [i, f[(k + 1) % 4], c]));
    const side = edgeAtPoints(b, [0.5, -0.5, 0.5], [0.5, 0.5, 0.5]);
    const r = O.loopCut(b, side, 0.5);
    assert.equal(O.boundaryLoops(r.mesh).length, 0);   // still closed
    close(volume(r.mesh), 1);
});

test("bevelling one edge cuts its corner off; all of them chamfer the whole box", () => {
    const b = box();
    const k = edgeAtPoints(b, [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]);
    const one = O.bevelEdges(b, [k], 0.1);
    // The edge's face; the end faces take the cut corner into their own outline (no triangles left over).
    assert.equal(M.meshStats(one.mesh).faces, 7);
    assert.deepEqual(one.mesh.f.map((f) => f.length).sort(), [4, 4, 4, 4, 4, 5, 5]);
    close(volume(one.mesh), 1 - 0.1 * 0.1 / 2);
    assert.equal(O.boundaryLoops(one.mesh).length, 0);
    const all = O.bevelEdges(b, keys(b), 0.1);
    assert.deepEqual(M.meshStats(all.mesh), { verts: 24, faces: 26, edges: 48, tris: 44 });
    assert.equal(O.boundaryLoops(all.mesh).length, 0);
    assert.equal(all.ids.length, 20);
    // Every face still faces out: the volume is the cube cut by the edge planes (|x| + |y| <= 0.9 ...)
    // and the corner planes (|x| + |y| + |z| <= 1.3), counted on a grid.
    const N = 120;
    let inside = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
        const x = Math.abs((i + 0.5) / N - 0.5), y = Math.abs((j + 0.5) / N - 0.5), z = Math.abs((k + 0.5) / N - 0.5);
        if (x + y <= 0.9 && y + z <= 0.9 && x + z <= 0.9 && x + y + z <= 1.3) inside++;
    }
    close(volume(all.mesh), inside / N ** 3, 5e-3);     // the grid count is a little high at the slanted planes
});

test("holes are found, filled, and two of them bridged", () => {
    const b = box();
    const top = b.f.findIndex((f) => f.every((i) => b.v[i][1] > 0));
    const bottom = b.f.findIndex((f) => f.every((i) => b.v[i][1] < 0));
    const open = M.deleteSel(b, "face", [top]).mesh;
    assert.equal(O.boundaryLoops(open).length, 1);
    const filled = O.fillHoles(open);
    close(volume(filled.mesh), 1);
    // A tube: top and bottom both out; bridging the two borders closes the side... into a wall across.
    const tube = M.deleteSel(b, "face", [top, bottom]).mesh;
    assert.equal(O.boundaryLoops(tube).length, 2);
    const verts = tube.v.map((_, i) => i);
    const br = O.bridge(tube, "vertex", verts);
    assert.ok(!br.error, br.error);
    assert.equal(br.ids.length, 4);
    assert.equal(O.boundaryLoops(br.mesh).length, 0);
    // Two faces: taken out and bridged in one step (the box's top and bottom become a tunnel).
    const tunnel = O.bridge(b, "face", [top, bottom]);
    assert.equal(M.meshStats(tunnel.mesh).faces, 8);
    // Borders of different lengths are refused.
    const t2 = M.deleteSel(b, "face", [top]).mesh;
    assert.ok(O.bridge(t2, "vertex", t2.v.map((_, i) => i)).error);
});

test("connect splits a face between two of its corners, or between the middles of two edges", () => {
    const b = box();
    const f = b.f[0];
    const r = O.connect(b, "vertex", [f[0], f[2]]);
    assert.equal(M.meshStats(r.mesh).faces, 7);
    assert.deepEqual(r.ids, [M.edgeKey(f[0], f[2])]);
    // Neighbours are not connected again.
    assert.equal(M.meshStats(O.connect(b, "vertex", [f[0], f[1]]).mesh).faces, 6);
    const e = O.connect(b, "edge", [M.edgeKey(f[0], f[1]), M.edgeKey(f[2], f[3])]);
    assert.equal(M.meshStats(e.mesh).verts, 10);
    assert.equal(M.meshStats(e.mesh).faces, 7);
    close(volume(e.mesh), 1);
    assert.equal(O.boundaryLoops(e.mesh).length, 0);
});

test("merge by distance welds what is close and leaves the rest", () => {
    // Two boxes' worth of corners where the second is a hair off the first.
    const b = box();
    const n = b.v.length;
    const two = { v: [...b.v, ...b.v.map((p) => [p[0] + 1e-6, p[1], p[2]])], f: [...b.f, ...b.f.map((f) => f.map((i) => i + n))] };
    const r = O.mergeByDistance(two, 1e-4);
    assert.equal(r.merged, 8);
    assert.equal(r.mesh.v.length, 8);
    assert.equal(O.mergeByDistance(two, 1e-9).merged, 0);
});

test("soft selection: full weight at the selection, a smooth fall to nothing at the radius", () => {
    close(O.softFalloff(0, 1), 1);
    close(O.softFalloff(0.5, 1), 0.5);
    close(O.softFalloff(1, 1), 0);
    assert.ok(O.softFalloff(0.25, 1) > 0.8);
    const g = M.meshFromPrimitive("plane", { divisions: 4 });
    const centre = g.v.findIndex((p) => Math.abs(p[0]) < 1e-9 && Math.abs(p[2]) < 1e-9);
    const w = O.softWeights(g, [centre], 0.6);
    assert.equal(w.get(centre), 1);
    const next = g.v.findIndex((p) => Math.abs(p[0] - 0.25) < 1e-9 && Math.abs(p[2]) < 1e-9);
    assert.ok(w.get(next) > 0 && w.get(next) < 1);
    const corner = g.v.findIndex((p) => Math.abs(p[0] - 0.5) < 1e-9 && Math.abs(p[2] - 0.5) < 1e-9);
    assert.equal(w.has(corner), false);
    assert.equal(O.softWeights(g, [centre], 0).size, 1);
});

test("bevelling two edges in a row shares the point where they meet, so the mesh stays closed", async () => {
    const X = await import("../js/imageViewer_meshModel.js");
    let b = box();
    b = M.extrudeFaces(b, X.resolveSelection(b, "face", { side: "+y" }), 0.5).mesh;
    const r = O.bevelEdges(b, X.resolveSelection(b, "edge", { along: "y", within: 5 }), 0.05);
    const d = X.describeMesh(r.mesh);
    assert.equal(d.open_edges, 0);
    assert.equal(d.facing["+x"], d.facing["-x"]);
    close(volume(r.mesh), 1.5 - 4 * 1.5 * 0.05 * 0.05 / 2, 1e-6);
});
