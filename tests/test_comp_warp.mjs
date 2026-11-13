// node --test tests/test_comp_warp.mjs
// Comp's warps and trackers (js/imageViewer_compWarp.js and their nodes in imageViewer_compModel.js): what each map
// does to a point, the lens solve, the tracker's motion and its bake into a Transform / CornerPin.
import test from "node:test";
import assert from "node:assert/strict";
import * as W from "../js/imageViewer_compWarp.js";
import * as C from "../js/imageViewer_compModel.js";

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const noise = (w, h) => ({ w, h, data: new Float32Array(w * h * 4).map((_, i) => ((i * 7919) % 101) / 101) });

test("a homography takes the four points where they go, and its swap takes them back", () => {
    const P = [[0, 100], [200, 100], [200, 0], [0, 0]], Q = [[10, 90], [180, 110], [190, 5], [20, 12]];
    const H = W.homography(P, Q), Hi = W.homography(Q, P);
    P.forEach((p, k) => { const q = W.applyH(H, p[0], p[1]); near(q[0], Q[k][0], 1e-9); near(q[1], Q[k][1], 1e-9); });
    const q = W.applyH(H, 57, 33), back = W.applyH(Hi, q[0], q[1]);
    near(back[0], 57, 1e-9); near(back[1], 33, 1e-9);
    assert.equal(W.homography([[0, 0], [1, 1], [2, 2], [3, 3]], Q), null, "points on a line make no map");
});

test("a CornerPin left at its corners changes nothing", () => {
    const comp = C.newComp({ width: 13, height: 9 });
    const r = C.addNode(comp, C.makeNode(comp, "read", { file: "x" }));
    const p = C.addNode(comp, C.makeNode(comp, "cornerpin", { inputs: [r.id] }));
    const src = noise(13, 9);
    const a = C.renderNode(comp, r.id, 0, { source: () => src }), b = C.renderNode(comp, p.id, 0, { source: () => src });
    for (let i = 0; i < a.data.length; i++) near(b.data[i], a.data[i], 1e-5);
});

test("undistort and redistort are each other's way back", () => {
    for (const [k1, k2] of [[-0.2, 0.05], [0.15, 0], [0.05, -0.02]]) {
        for (const [x, y] of [[10, 20], [300, 40], [190, 260], [5, 5]]) {
            const d = W.lensPoint(x, y, "distort", k1, k2, 160, 120, 200), u = W.lensPoint(d[0], d[1], "undistort", k1, k2, 160, 120, 200);
            near(u[0], x, 1e-6); near(u[1], y, 1e-6);
        }
    }
});

test("the lens solve finds k1 (and k2) from lines that are straight in the world", () => {
    const w = 320, h = 240, R = Math.sqrt(w * w + h * h) / 2;
    for (const [k1, k2] of [[-0.12, 0], [0.08, 0], [-0.15, 0.04]]) {
        const lines = [];
        for (const y of [20, 70, 170, 220]) lines.push([...Array(9)].map((_, i) => W.lensPoint(10 + i * 37.5, y, "distort", k1, k2, w / 2, h / 2, R)));
        for (const x of [25, 290]) lines.push([...Array(7)].map((_, i) => W.lensPoint(x, 10 + i * 36, "distort", k1, k2, w / 2, h / 2, R)));
        const got = W.solveLens(lines, w, h, null, { k2: k2 !== 0 });
        near(got.k1, k1, 0.004, "k1");
        if (k2) near(got.k2, k2, 0.01, "k2");
        assert.ok(got.error < 0.05, `straight to ${got.error} px`);
    }
    assert.equal(W.solveLens([], 10, 10).error, null);
});

test("an ST map of a lens undistort does what the undistort does", () => {
    const comp = C.newComp({ width: 24, height: 16 });
    const r = C.addNode(comp, C.makeNode(comp, "read", { file: "x" }));
    const l = C.addNode(comp, C.makeNode(comp, "lensdistortion", { inputs: [r.id], k1: -0.1 }));
    const m = C.addNode(comp, C.makeNode(comp, "lensdistortion", { inputs: [r.id], k1: -0.1, output: "stmap" }));
    const s = C.addNode(comp, C.makeNode(comp, "stmap", { inputs: [r.id, m.id] }));
    const src = noise(24, 16);
    const a = C.renderNode(comp, l.id, 0, { source: () => src }), b = C.renderNode(comp, s.id, 0, { source: () => src });
    for (let i = 0; i < a.data.length; i++) near(b.data[i], a.data[i], 1e-5);
});

test("a grid warp moves the picture where its points went, and leaves it alone at distortion 0", () => {
    const sp = W.lattice(3, 3, 30, 20), dp = sp.slice();
    dp[8] += 2; dp[9] -= 1;   // the middle point
    const [U, V] = W.gridMap(sp, dp, 30, 20, 1);
    const i = 9 * 30 + 16;   // the pixel whose centre is at the moved point (17, 9.5) reads near the old (15, 10)
    near(U[i] - 0.5 - 16, -2, 0.2, "u"); near(V[i] - 0.5 - 9, 1, 0.2, "v");
    const [U0] = W.gridMap(sp, sp, 30, 20, 1);
    near(U0[i], 16.5, 0);
});

test("a tracked point reads its keys, and the motion is a move, a turn and a scale", () => {
    const keys = [[0, 10, 10, 1], [4, 18, 6, 1]];
    assert.deepEqual(W.trackAt(keys, 2), [14, 8]);
    assert.deepEqual(W.trackAt(keys, 9), [18, 6]);
    assert.equal(W.trackHas(keys, 5), false);
    const P = [[0, 0], [10, 0]], Q = [[5, 5], [5, 25]];
    const mo = W.solveMotion(P, Q, "scale");
    near(mo.angle, 90, 1e-9); near(mo.s, 2, 1e-9);
    const q = [mo.m[0] * 10 + mo.m[2] * 0 + mo.m[4], mo.m[1] * 10 + mo.m[3] * 0 + mo.m[5]];
    near(q[0], 5, 1e-9); near(q[1], 25, 1e-9);
    assert.equal(W.solveMotion(P, Q, "translate").angle, 0);
});

test("a baked stabilise / match-move draws what the tracker draws", () => {
    const pts = { points: [{ id: "a", keys: [[0, 5, 5, 1], [4, 8, 6, 1]] }, { id: "b", keys: [[0, 20, 6, 1], [4, 22, 9, 1]] },
        { id: "c", keys: [[0, 21, 14, 1], [4, 20, 15.5, 1]] }, { id: "d", keys: [[0, 6, 13, 1], [4, 7, 12, 1]] }] };
    for (const motion of ["translate", "rotate", "scale", "perspective"]) for (const how of ["stabilise", "match-move"]) {
        const comp = C.newComp({ width: 29, height: 17, frames: 6 });
        const r = C.addNode(comp, C.makeNode(comp, "read", { file: "x" }));
        const t = C.addNode(comp, C.makeNode(comp, "tracker", { inputs: [r.id], points: pts, motion, transform: how }));
        const b = C.bakeTrack(comp, t.id, how);
        assert.equal(b.type, motion === "perspective" ? "cornerpin" : "transform");
        assert.equal(b.inputs[0], null, "the baked node is not wired");
        b.inputs[0] = r.id;
        const src = noise(29, 17);
        for (const f of [1, 3]) {
            const x = C.renderNode(comp, t.id, f, { source: () => src }), y = C.renderNode(comp, b.id, f, { source: () => src });
            for (let i = 0; i < x.data.length; i++) near(y.data[i], x.data[i], 2e-3, `${motion} ${how} f${f}`);
        }
    }
    const comp = C.newComp();
    const t = C.addNode(comp, C.makeNode(comp, "tracker", {}));
    assert.equal(C.bakeTrack(comp, t.id, "match-move"), null, "nothing tracked, nothing baked");
});

test("an STMap's picture is its map's size", () => {
    const comp = C.newComp({ width: 40, height: 30 });
    const r = C.addNode(comp, C.makeNode(comp, "read", { file: "x" }));
    const f = C.addNode(comp, C.makeNode(comp, "reformat", { inputs: [r.id], width: 12, height: 8 }));
    const s = C.addNode(comp, C.makeNode(comp, "stmap", { inputs: [r.id, f.id] }));
    assert.deepEqual(C.formatAt(comp, s.id), { width: 12, height: 8 });
});
