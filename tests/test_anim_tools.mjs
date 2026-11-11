// node --test tests/test_anim_tools.mjs
// The 3D space's Dope Sheet / Curve Editor edits (imageViewer_animTools.js)
// and the tracks' infinity modes (imageViewer_scene3d.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_scene3d.js";
import * as A from "../js/imageViewer_animTools.js";

const box = (id, keys, prop = "position") => {
    const it = S.makePrimitiveItem("box", id);
    it.id = id;
    for (const [f, v, ease] of keys) S.setKeyframe(it, prop, f, v, ease);
    return it;
};
const frames = (it, prop = "position") => S.track(it, prop).map((k) => k.f);
const near = (a, b, eps = 1e-9) => {
    if (Array.isArray(a)) return a.every((x, i) => Math.abs(x - b[i]) <= eps);
    return Math.abs(a - b) <= eps;
};

test("move keys: selected keys move, a key they land on is replaced", () => {
    const a = box("a", [[0, [0, 0, 0]], [10, [1, 0, 0]], [20, [2, 0, 0]]]);
    const sel = [{ id: "a", prop: "position", f: 10 }];
    const next = A.moveKeys([a], sel, 10);
    assert.deepEqual(next, [{ id: "a", prop: "position", f: 20 }]);
    assert.deepEqual(frames(a), [0, 20]);
    assert.deepEqual(S.track(a, "position")[1].v, [1, 0, 0], "the moved key won");
});

test("move keys across objects and properties at once", () => {
    const a = box("a", [[0, [0, 0, 0]], [10, [1, 0, 0]]]);
    S.setKeyframe(a, "rotation", 10, [0, 90, 0]);
    const b = box("b", [[5, [0, 0, 0]]]);
    const sel = [...A.keysOf([a, b])].filter((k) => k.f > 0);
    A.moveKeys([a, b], sel, 3);
    assert.deepEqual(frames(a), [0, 13]);
    assert.deepEqual(frames(a, "rotation"), [13]);
    assert.deepEqual(frames(b), [8]);
});

test("scale keys about a pivot keeps the curve's shape (tangents scaled)", () => {
    const a = box("a", [[0, [0, 0, 0]], [10, [10, 0, 0]], [20, [0, 0, 0]]]);
    S.setTangent(a, "position", 10, 0, 2, { side: "out" });
    const before = S.valueAt(a, "position", 5)[0];
    A.scaleKeys([a], A.keysOf([a]), 2, 0);
    assert.deepEqual(frames(a), [0, 20, 40]);
    assert.ok(near(S.track(a, "position")[1].to[0], 1), "slope halved");
    assert.ok(near(S.valueAt(a, "position", 10)[0], before), "same shape, twice as long");
    assert.deepEqual(A.scaleKeys([a], [], -1, 0), [], "no negative scale");
});

test("stagger offsets each object by one more step", () => {
    const items = ["a", "b", "c"].map((id) => box(id, [[0, [0, 0, 0]], [10, [1, 0, 0]]]));
    A.staggerKeys(items, A.keysOf(items), 4);
    assert.deepEqual(items.map((it) => frames(it)), [[0, 10], [4, 14], [8, 18]]);
});

test("delete, ease and box select", () => {
    const a = box("a", [[0, [0, 0, 0]], [10, [1, 0, 0]], [20, [2, 0, 0]]]);
    assert.deepEqual(A.keysInRange(a, "position", 15, 5).map((k) => k.f), [10]);
    assert.equal(A.setKeysEase([a], [{ id: "a", prop: "position", f: 0 }], "linear"), 1);
    assert.equal(S.track(a, "position")[0].ease, "linear");
    assert.equal(A.deleteKeys([a], [{ id: "a", prop: "position", f: 10 }]), 1);
    assert.deepEqual(frames(a), [0, 20]);
});

test("copy and paste keys onto another object", () => {
    const a = box("a", [[10, [1, 0, 0]], [14, [2, 0, 0]]]);
    const b = box("b", []);
    const clip = A.copyKeys([a, b], A.keysOf([a]));
    const pasted = A.pasteKeys([a, b], clip, 30, ["b"]);
    assert.equal(pasted.length, 2);
    assert.deepEqual(frames(b), [30, 34]);
    assert.deepEqual(frames(a), [10, 14], "the source is untouched");
});

test("retime with ripple spreads a range and moves what follows", () => {
    const a = box("a", [[0, [0, 0, 0]], [10, [1, 0, 0]], [20, [2, 0, 0]], [30, [3, 0, 0]]]);
    const n = A.retimeKeys([a], [{ id: "a", prop: "position" }], 0, 20, 40, true);
    assert.equal(n, 3);
    assert.deepEqual(frames(a), [0, 20, 40, 50]);
    const b = box("b", [[0, [0, 0, 0]], [10, [1, 0, 0]], [20, [2, 0, 0]], [30, [3, 0, 0]]]);
    A.retimeKeys([b], [{ id: "b", prop: "position" }], 0, 10, 40, false);
    assert.deepEqual(frames(b), [0, 19, 20, 30], "without ripple it stops short of the next key");
});

test("simplify a densely baked smooth move to a few keys within tolerance", () => {
    const a = box("a", []);
    for (let f = 0; f <= 48; f++) {
        const t = f / 48;
        S.setKeyframe(a, "position", f, [Math.sin(t * Math.PI * 2) * 5, t * t * 3, 1], "linear");
    }
    const want = Array.from({ length: 49 }, (_, f) => S.valueAt(a, "position", f));
    const r = A.simplifyTrack(a, "position", 0.01);
    assert.equal(r.before, 49);
    assert.ok(r.after < 15, `few keys left (${r.after})`);
    for (let f = 0; f <= 48; f++) {
        const got = S.valueAt(a, "position", f);
        assert.ok(Math.abs(got[0] - want[f][0]) <= 0.01 * 10 + 1e-9, `x at ${f}`);
        assert.ok(Math.abs(got[1] - want[f][1]) <= 0.01 * 3 + 1e-9, `y at ${f}`);
    }
});

test("simplify keeps a straight line as two keys and a corner sharp", () => {
    const a = box("a", []);
    for (let f = 0; f <= 20; f++) S.setKeyframe(a, "position", f, [f < 10 ? f : 20 - f, 0, 0], "linear");
    const r = A.simplifyTrack(a, "position", 0.001);
    assert.deepEqual(frames(a), [0, 10, 20]);
    assert.equal(r.after, 3);
    assert.ok(near(S.valueAt(a, "position", 5)[0], 5, 1e-6));
    assert.ok(near(S.valueAt(a, "position", 15)[0], 5, 1e-6));
});

test("simplify leaves stepped keys alone, and unwraps rotations", () => {
    const h = box("h", [[0, [0, 0, 0], "hold"], [1, [1, 0, 0], "hold"], [2, [2, 0, 0]]]);
    assert.equal(A.simplifyTrack(h, "position").skipped, true);
    const r = box("r", [], "rotation");
    for (let f = 0; f <= 36; f++) S.setKeyframe(r, "rotation", f, [0, ((f * 20) % 360) - 180, 0], "linear");
    const want = Array.from({ length: 37 }, (_, f) => S.valueAt(r, "rotation", f)[1]);
    A.simplifyTrack(r, "rotation", 0.005);
    assert.ok(S.track(r, "rotation").length < 37);
    for (let f = 0; f <= 36; f++) {
        let d = (S.valueAt(r, "rotation", f)[1] - want[f]) % 360;
        if (d > 180) d -= 360; if (d < -180) d += 360;
        assert.ok(Math.abs(d) < 4, `turn at ${f} off by ${d}`);
    }
});

test("buffer curve: snapshot, change, swap back and forth", () => {
    const a = box("a", [[0, [0, 0, 0]], [10, [1, 0, 0]]]);
    let buf = A.snapshotTracks([a], [{ id: "a", prop: "position" }]);
    A.moveKeys([a], [{ id: "a", prop: "position", f: 10 }], 5);
    assert.deepEqual(frames(a), [0, 15]);
    assert.ok(near(A.bufferValueAt(a, "position", buf.get("a|position"), 10)[0], 1));
    ({ buffer: buf } = A.swapTracks([a], buf));
    assert.deepEqual(frames(a), [0, 10]);
    A.swapTracks([a], buf);
    assert.deepEqual(frames(a), [0, 15]);
});

// ── Infinity ─────────────────────────────────────────────────────────────────

test("infinity: constant is what scenes always did", () => {
    const a = box("a", [[10, [0, 0, 0], "linear"], [20, [10, 0, 0]]]);
    assert.deepEqual(S.valueAt(a, "position", 0), [0, 0, 0]);
    assert.deepEqual(S.valueAt(a, "position", 30), [10, 0, 0]);
    assert.equal(S.hasInfinity(a), false);
});

test("infinity: cycle, offset, oscillate, linear", () => {
    const a = box("a", [[10, [0, 0, 0], "linear"], [20, [10, 0, 0]]]);
    S.setInfinity(a, "position", { pre: "cycle", post: "cycle" });
    assert.ok(S.hasInfinity(a));
    assert.ok(near(S.valueAt(a, "position", 25)[0], 5));
    assert.ok(near(S.valueAt(a, "position", 5)[0], 5));
    assert.ok(near(S.valueAt(a, "position", 33)[0], 3));
    S.setInfinity(a, "position", { post: "offset" });
    assert.ok(near(S.valueAt(a, "position", 25)[0], 15));
    assert.ok(near(S.valueAt(a, "position", 45)[0], 35));
    S.setInfinity(a, "position", { post: "oscillate" });
    assert.ok(near(S.valueAt(a, "position", 22)[0], 8));
    assert.ok(near(S.valueAt(a, "position", 32)[0], 2));
    S.setInfinity(a, "position", { pre: "linear", post: "linear" });
    assert.ok(near(S.valueAt(a, "position", 25)[0], 15), "the line's own slope");
    assert.ok(near(S.valueAt(a, "position", 0)[0], -10));
    S.setInfinity(a, "position", { pre: "constant", post: "constant" });
    assert.equal(a.infinity, undefined, "back at constant the entry goes");
});

test("infinity survives a save and a read; a bad word reads as constant", () => {
    const a = box("a", [[0, [0, 0, 0]], [10, [1, 0, 0]]]);
    S.setInfinity(a, "position", { post: "cycle" });
    const scene = S.makeScene({ items: [a] });
    const back = S.parseScene(S.serializeScene(scene));
    assert.deepEqual(S.infinityOf(back.items[0], "position"), { pre: "constant", post: "cycle" });
    const odd = S.parseScene({ items: [{ ...a, infinity: { position: { post: "bounce" } } }] });
    assert.equal(odd.items[0].infinity, undefined);
});
