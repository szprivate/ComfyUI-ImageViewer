// The editable polygon mesh and what modeling does to it (js/imageViewer_meshData.js).
// Run: node --test tests/test_mesh_data.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../js/imageViewer_meshData.js";

const box = () => M.meshFromPrimitive("box");
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** Every edge has exactly two faces, each using it once each way: a closed surface, faces turned the same way. */
function closedAndConsistent(mesh) {
    const dir = new Map();
    for (const face of mesh.f) for (let k = 0; k < face.length; k++) {
        const key = `${face[k]}>${face[(k + 1) % face.length]}`;
        assert.ok(!dir.has(key), `edge ${key} twice the same way`);
        dir.set(key, true);
    }
    for (const key of dir.keys()) {
        const [a, b] = key.split(">");
        assert.ok(dir.has(`${b}>${a}`), `edge ${key} has no other side`);
    }
}

/** Signed volume (positive when the faces face out). */
function volume(mesh) {
    let vol = 0;
    for (const face of mesh.f) for (const [a, b, c] of M.triangulateFace(mesh, face)) {
        const A = mesh.v[a], B = mesh.v[b], C = mesh.v[c];
        vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    }
    return vol;
}

test("packed and working forms carry the same mesh, and cleaning drops what cannot be a face", () => {
    const m = box();
    const p = M.pack(m);
    assert.equal(p.v.length, 24);
    assert.equal(p.f.length, 30);
    assert.deepEqual(M.unpack(p), m);
    const c = M.cleanMesh({ v: [0, 0, 0, 1, 0, 0, 0, 1, 0], f: [3, 0, 1, 2, 3, 0, 0, 1, 4, 0, 1, 9, 2] });
    assert.deepEqual(M.unpack(c).f, [[0, 1, 2]]);
    assert.equal(M.cleanMesh({ v: [], f: [] }), null);
});

test("every shape to start from is closed, faces out and has the drawn shape's size", () => {
    for (const type of ["box", "sphere", "cylinder", "cone", "torus"]) {
        const m = M.meshFromPrimitive(type);
        closedAndConsistent(m);
        assert.ok(volume(m) > 0, `${type} faces in`);
        const ys = m.v.map((p) => p[1]);
        if (type !== "torus") { close(Math.max(...ys), 0.5, 1e-9); close(Math.min(...ys), -0.5, 1e-9); }
    }
    close(volume(box()), 1);
    const plane = M.meshFromPrimitive("plane", { divisions: 2 });
    assert.equal(plane.f.length, 4);
    for (const face of plane.f) assert.ok(M.faceNormal(plane, face)[1] > 0.99);
});

test("a concave face is cut into triangles inside it", () => {
    // An L: six corners, one of them reflex.
    const m = { v: [[0, 0, 0], [2, 0, 0], [2, 0, -1], [1, 0, -1], [1, 0, -2], [0, 0, -2]], f: [[0, 1, 2, 3, 4, 5]] };
    const tris = M.triangulateFace(m, m.f[0]);
    assert.equal(tris.length, 4);
    let area = 0;
    for (const [a, b, c] of tris) {
        const n = M.faceNormalRaw(m, [a, b, c]);
        assert.ok(n[1] > 0, "a triangle turned over");
        area += n[1] / 2;
    }
    close(area, 3);
});

test("extruding the top of a box makes it taller and keeps it closed", () => {
    const m = box();
    const top = m.f.findIndex((face) => M.faceNormal(m, face)[1] > 0.99);
    const r = M.extrudeFaces(m, [top], 1);
    closedAndConsistent(r.mesh);
    close(volume(r.mesh), 2);
    assert.equal(r.mesh.f.length, 10);
    assert.deepEqual(r.ids, [top]);
    assert.ok(r.mesh.f[top].every((i) => Math.abs(r.mesh.v[i][1] - 1.5) < 1e-9));
});

test("extruding two touching faces as one region makes no wall between them", () => {
    const m = M.meshFromPrimitive("plane", { divisions: 2 });
    const r = M.extrudeFaces(m, [0, 1], 0.5);
    // Two faces have six border edges between them: six walls, the shared edge none.
    assert.equal(r.walls.length, 6);
    const each = M.extrudeFaces(m, [0, 1], 0.5, { individual: true });
    assert.equal(each.walls.length, 8);
});

test("insetting a face draws its border in by the amount, and the ring closes it again", () => {
    const m = box();
    const top = m.f.findIndex((face) => M.faceNormal(m, face)[1] > 0.99);
    const r = M.insetFaces(m, [top], 0.1);
    closedAndConsistent(r.mesh);
    close(volume(r.mesh), 1);
    assert.equal(r.ring.length, 4);
    for (const i of r.mesh.f[top]) {
        close(Math.abs(r.mesh.v[i][0]), 0.4);
        close(Math.abs(r.mesh.v[i][2]), 0.4);
    }
});

test("deleting a face leaves a hole; deleting a vertex takes its faces and itself", () => {
    const m = box();
    const d = M.deleteSel(m, "face", [0]);
    assert.equal(d.mesh.f.length, 5);
    assert.equal(d.mesh.v.length, 8);
    const v = M.deleteSel(m, "vertex", [0]);
    assert.equal(v.mesh.f.length, 3);
    assert.equal(v.mesh.v.length, 7);
    const e = M.deleteSel(m, "edge", [M.edgeKey(0, 1)]);
    assert.equal(e.mesh.f.length, 4);
});

test("selections convert between modes, grow and invert", () => {
    const m = box();
    const top = m.f.findIndex((face) => M.faceNormal(m, face)[1] > 0.99);
    const verts = M.convertSel(m, "face", "vertex", [top]);
    assert.equal(verts.length, 4);
    assert.deepEqual(M.convertSel(m, "vertex", "face", verts), [top]);
    assert.equal(M.convertSel(m, "face", "edge", [top]).length, 4);
    assert.deepEqual(M.convertSel(m, "edge", "face", M.convertSel(m, "face", "edge", [top])), [top]);
    assert.equal(M.growSel(m, "face", [top]).length, 5);
    assert.equal(M.invertSel(m, "vertex", verts).length, 4);
    assert.equal(M.allOf(m, "edge").length, 12);
    assert.deepEqual(M.selCentroid(m, "face", [top]), [0, 0.5, 0]);
});

test("merging welds vertices into one at their middle and drops the faces that close up", () => {
    const m = box();
    const top = m.f.findIndex((face) => M.faceNormal(m, face)[1] > 0.99);
    const r = M.mergeVertices(m, "face", [top]);
    // The top face is gone, the four sides are triangles: a pyramid.
    assert.equal(r.mesh.v.length, 5);
    assert.equal(r.mesh.f.length, 5);
    closedAndConsistent(r.mesh);
    assert.deepEqual(r.mesh.v[r.ids[0]], [0, 0.5, 0]);
});

test("flipping turns a face round, and drawn triangles follow the faces", () => {
    const m = box();
    const f = M.flipFaces(m, [0]);
    const n0 = M.faceNormal(m, m.f[0]), n1 = M.faceNormal(f, f.f[0]);
    close(n0[0] + n1[0], 0); close(n0[1] + n1[1], 0); close(n0[2] + n1[2], 0);
    const t = M.meshTriangles(m);
    assert.equal(t.position.length, 12 * 9);
    assert.equal(t.triFace.length, 12);
    assert.deepEqual([...t.triFace.slice(0, 4)], [0, 0, 1, 1]);
});

test("triangles of a file become one welded mesh", () => {
    const g = M.meshTriangles(box()).position;
    const m = M.meshFromTriangles(g);
    assert.equal(m.v.length, 8);
    assert.equal(m.f.length, 12);
    closedAndConsistent(m);
});

// The edit mode's own small rules (js/imageViewer_view3dMeshEdit.js).
import { combineSel, segmentDistance, cleanMeshEditOptions } from "../js/imageViewer_view3dMeshEdit.js";

test("a pick combines with the selection as the view's modifiers say", () => {
    assert.deepEqual(combineSel([1, 2], [3], "replace"), [3]);
    assert.deepEqual(combineSel([1, 2], [2, 3], "toggle").sort(), [1, 3]);
    assert.deepEqual(combineSel([1, 2], [2], "remove"), [1]);
    assert.deepEqual(combineSel(new Set([1]), [1, 4], "add").sort(), [1, 4]);
});

test("distance to an edge on screen, and the options kept within reason", () => {
    close(segmentDistance([5, 3], [0, 0], [10, 0]), 3);
    close(segmentDistance([-4, 3], [0, 0], [10, 0]), 5);
    close(segmentDistance([1, 1], [0, 0], [0, 0]), Math.SQRT2);
    const o = cleanMeshEditOptions({ extrude: "x", inset: -5, individual: 1, xray: true });
    // Only a real true switches a box on (a stored 1 is not one).
    assert.equal(o.extrude, 0.25);
    assert.ok(o.inset >= 0);
    assert.equal(o.individual, false);
    assert.equal(o.xray, true);
});
