// The modeling operations as one function of (mesh, selection, numbers): js/imageViewer_meshTools.js.
import test from "node:test";
import assert from "node:assert/strict";
import * as MD from "../js/imageViewer_meshData.js";
import * as MT from "../js/imageViewer_meshTools.js";

const box = () => MD.unpack(MD.meshFromPrimitive("box"));
const topFace = (m) => m.f.findIndex((f) => f.every((i) => m.v[i][1] > 0.49));

test("an operation's numbers start from the remembered options, given ones win", () => {
    assert.deepEqual(MT.toolParams("extrude", { extrude: 0.4, individual: true }), { amount: 0.4, individual: true });
    assert.deepEqual(MT.toolParams("extrude", { extrude: 0.4 }, { amount: 1 }), { amount: 1, individual: false });
    assert.equal(MT.toolParams("inset", { inset: -3 }).amount, 0);              // held to its range
    assert.equal(MT.toolParams("loopcut", {}, { share: 2 }).share, 0.99);
    assert.deepEqual(MT.optionsFromParams("bevel", { amount: 0.2 }), { bevel: 0.2 });
    assert.deepEqual(MT.optionsFromParams("symmetrize", { axis: "z", side: -1, tol: 0.01 }), { mirrorAxis: "z", mirrorSide: -1, weld: 0.01 });
    assert.equal(MT.snapAmount(0.234, 0.1), 0.2);
});

test("run again from the mesh before it, each amount gives its own result and the mesh is untouched", () => {
    const m = box();
    const sel = { mode: "face", ids: [topFace(m)] };
    const a = MT.runMeshOp(m, "extrude", sel, { amount: 0.25 });
    const b = MT.runMeshOp(m, "extrude", sel, { amount: 1 });
    const top = (x) => Math.max(...x.mesh.v.map((p) => p[1]));
    assert.equal(m.v.length, 8);
    assert.ok(Math.abs(top(a) - 0.75) < 1e-9 && Math.abs(top(b) - 1.5) < 1e-9);
    assert.deepEqual(a.ids, sel.ids);
    // The scene length is turned into the mesh's own (a node scaled 2x halves it).
    const c = MT.runMeshOp(m, "extrude", sel, { amount: 1 }, (d) => d / 2);
    assert.ok(Math.abs(top(c) - 1.0) < 1e-9);
});

test("loop cut takes the edge it is given and the share along it", () => {
    const m = box();
    const key = MD.edgeKey(...MD.meshEdges(m)[0]);
    const r = MT.runMeshOp(m, "loopcut", { mode: "vertex", ids: [] }, { edge: key, share: 0.25 });
    assert.equal(r.error, undefined);
    assert.equal(r.mode, "edge");
    assert.equal(r.mesh.v.length, 12);
    const [a, b] = MD.edgeEnds(key);
    const want = m.v[a].map((x, k) => x + (m.v[b][k] - x) * 0.25);
    assert.ok(r.mesh.v.slice(8).some((p) => p.every((x, k) => Math.abs(x - want[k]) < 1e-9)));
});

test("what cannot run says why, and whole-mesh operations need no selection", () => {
    const m = box();
    assert.ok(MT.runMeshOp(m, "extrude", { mode: "face", ids: [] }).error);
    assert.ok(MT.runMeshOp(m, "bevel", { mode: "face", ids: [] }).error);
    const s = MT.runMeshOp(m, "subdivide", { mode: "vertex", ids: [] }, { levels: 1 });
    assert.equal(s.mesh.f.length, 24);
    assert.ok(MT.runMeshOp(m, "nope", { mode: "vertex", ids: [0] }).error);
});
