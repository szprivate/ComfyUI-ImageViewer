// node --test tests/test_clip_seq.mjs
// The 3D clip sequencer's model (imageViewer_clipSeqData.js), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_scene3d.js";
import * as Q from "../js/imageViewer_clipSeqData.js";

const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};

function boxScene() {
    const scene = S.makeScene({ length: 200 });
    const box = S.makePrimitiveItem("box", "Box");
    scene.items.push(box);
    return { scene, box };
}

/** A box that walks 10 along +Z over frames 0..24, bobbing in y. */
function walker() {
    const { scene, box } = boxScene();
    S.setKeyframe(box, "position", 0, [0, 0, 0], "linear");
    S.setKeyframe(box, "position", 12, [0, 1, 5], "linear");
    S.setKeyframe(box, "position", 24, [0, 0, 10], "linear");
    S.setKeyframe(box, "rotation", 0, [0, 0, 0], "smooth");
    S.setKeyframe(box, "rotation", 24, [0, 0, 30], "smooth");
    return { scene, box };
}

test("time: a clip plays its stretch once, retimed, looped and ping-ponged", () => {
    const c = Q.normalizeClip({ start: 10, in: 0, out: 20, speed: 1 });
    assert.equal(c.length, 20);
    assert.equal(Q.sourceFrame(c, 9), null);
    near(Q.sourceFrame(c, 10).s, 0);
    near(Q.sourceFrame(c, 25).s, 15);
    near(Q.sourceFrame(c, 30).s, 20);
    assert.equal(Q.sourceFrame(c, 31), null);
    const fast = Q.normalizeClip({ start: 0, in: 0, out: 20, speed: 2 });
    assert.equal(fast.length, 10);
    near(Q.sourceFrame(fast, 5).s, 10);
    const cyc = Q.normalizeClip({ start: 0, in: 4, out: 14, loop: "cycle", length: 35 });
    near(Q.sourceFrame(cyc, 3).s, 7);
    assert.deepEqual(Q.sourceFrame(cyc, 13), { s: 7, turn: 1 });
    // The end of the last turn is that turn's last pose.
    const end = Q.sourceFrame(Q.normalizeClip({ start: 0, in: 0, out: 10, loop: "cycle", length: 20 }), 20);
    assert.deepEqual(end, { s: 10, turn: 1 });
    const pp = Q.normalizeClip({ start: 0, in: 0, out: 10, loop: "pingpong", length: 30 });
    near(Q.sourceFrame(pp, 13).s, 7);
    near(Q.sourceFrame(pp, 23).s, 3);
    const held = Q.normalizeClip({ start: 10, in: 2, out: 6, pre: true, post: true });
    near(Q.sourceFrame(held, 0).s, 2);
    near(Q.sourceFrame(held, 99).s, 6);
});

test("capture: a clip made from keys plays exactly what the keys did, and the keys move into it", () => {
    const { scene, box } = walker();
    const want = [];
    for (let f = 0; f <= 24; f += 0.5) want.push(S.evaluate(box, f));
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 0, 24, { name: "walk" }));
    assert.equal(src.length, 24);
    assert.equal(src.match, box.id);
    assert.equal(S.track(box, "position").length, 0);
    const t = Q.addTrack(q);
    Q.addClip(q, t.id, src.id, 0);
    for (let i = 0; i < want.length; i++) {
        const f = i * 0.5;
        const at = S.evaluateIn(scene, box, f);
        near(at.position, want[i].position, 1e-9, `pos@${f}`);
        near(at.rotation, want[i].rotation, 1e-6, `rot@${f}`);
    }
});

test("capture: a stretch cut out of a smooth curve keeps the curve's shape", () => {
    const { scene, box } = boxScene();
    S.setKeyframe(box, "position", 0, [0, 0, 0]);
    S.setKeyframe(box, "position", 20, [10, 4, -2]);
    S.setKeyframe(box, "position", 40, [3, 0, 8]);
    const want = [];
    for (let f = 7; f <= 31; f++) want.push(S.evaluate(box, f).position);
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 7, 31, { remove: false }));
    Q.addClip(q, Q.addTrack(q).id, src.id, 107);
    for (let f = 7; f <= 31; f++) near(S.evaluateIn(scene, box, f + 100).position, want[f - 7], 1e-3, `@${f}`);
});

test("blend: override, weights, additive, mute and solo", () => {
    const { scene, box } = boxScene();
    box.position = [1, 2, 3];
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, { id: "s1", name: "up", kind: "keys", length: 10, match: box.id,
        items: { [box.id]: { tracks: { position: [{ f: 0, v: [0, 10, 0], ease: "linear" }, { f: 10, v: [0, 20, 0], ease: "linear" }] }, top: true } } });
    Q.normalizeSeq(q);
    const t = Q.addTrack(q);
    const c = Q.addClip(q, t.id, src.id, 0);
    near(S.evaluateIn(scene, box, 5).position, [0, 15, 0]);
    near(S.evaluateIn(scene, box, 11).position, [1, 2, 3], 1e-9, "outside the clip the keys (here none) rule");
    c.weight = 0.5;
    near(S.evaluateIn(scene, box, 5).position, [0.5, 8.5, 1.5]);
    c.weight = 1; t.weight = 0.25;
    near(S.evaluateIn(scene, box, 0).position, [0.75, 4, 2.25]);
    t.weight = 1; t.mode = "additive";
    near(S.evaluateIn(scene, box, 5).position, [1, 7, 3], 1e-9, "additive: the change since the clip's first frame");
    t.mute = true;
    near(S.evaluateIn(scene, box, 5).position, [1, 2, 3]);
    t.mute = false; t.mode = "override";
    const t2 = Q.addTrack(q);
    t2.solo = true;
    near(S.evaluateIn(scene, box, 5).position, [1, 2, 3], 1e-9, "a soloed empty track silences the rest");
    t2.solo = false;
    // A higher track lies over a lower one.
    const src2 = Q.addSource(q, { id: "s2", name: "side", kind: "keys", length: 10, items: { [box.id]: { tracks: { position: [{ f: 0, v: [7, 7, 7], ease: "linear" }] }, top: true } } });
    Q.normalizeSeq(q);
    Q.addClip(q, t2.id, src2.id, 0);
    near(S.evaluateIn(scene, box, 5).position, [7, 7, 7]);
});

test("blend: two clips overlapping on a track cross-fade; ramps are smooth", () => {
    const { scene, box } = boxScene();
    const q = Q.ensureSeq(scene);
    const A = Q.addSource(q, { id: "a", kind: "keys", length: 30, items: { [box.id]: { tracks: { position: [{ f: 0, v: [0, 0, 0] }] }, top: true } } });
    const B = Q.addSource(q, { id: "b", kind: "keys", length: 30, items: { [box.id]: { tracks: { position: [{ f: 0, v: [10, 0, 0] }] }, top: true } } });
    Q.normalizeSeq(q);
    const t = Q.addTrack(q);
    Q.addClip(q, t.id, A.id, 0);
    Q.addClip(q, t.id, B.id, 20);   // overlaps 20..30
    near(S.evaluateIn(scene, box, 19).position, [0, 0, 0]);
    near(S.evaluateIn(scene, box, 25).position, [5, 0, 0]);
    near(S.evaluateIn(scene, box, 30).position, [10, 0, 0]);
    const w = Q.trackActive(t, 22).map((x) => x.w);
    near(w[0], 1); near(w[1], 0.104);
    // A blend-out with nothing after it fades back to the keys.
    t.clips[1].blendOut = 10;
    near(S.evaluateIn(scene, box, 45).position, [5, box.position[1] / 2, 0]);
});

test("rotations blend the short way, as quaternions", () => {
    const { scene, box } = boxScene();
    box.rotation = [0, 170, 0];
    const q = Q.ensureSeq(scene);
    const s = Q.addSource(q, { id: "r", kind: "keys", length: 10, items: { [box.id]: { tracks: { rotation: [{ f: 0, v: [0, -170, 0] }] }, top: true } } });
    Q.normalizeSeq(q);
    const c = Q.addClip(q, Q.addTrack(q).id, s.id, 0, { weight: 0.5 });
    const r = S.evaluateIn(scene, box, 5).rotation;
    near(r[0], 0, 1e-6, "no flip into the other Euler solution"); near(r[2], 0, 1e-6);
    near(((r[1] % 360) + 360) % 360, 180, 1e-6);
    void c;
});

test("edits: trim, retime, loop extend, split, move, duplicate", () => {
    const { scene, box } = walker();
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 0, 24));
    const t = Q.addTrack(q);
    const c = Q.addClip(q, t.id, src.id, 10);
    Q.trimClip(q, c.id, "out", -4);
    assert.equal(c.out, 20); assert.equal(c.length, 20);
    Q.trimClip(q, c.id, "out", 99);
    assert.equal(c.out, 24, "held to the source");
    Q.trimClip(q, c.id, "in", 6);
    assert.equal(c.start, 16); assert.equal(c.in, 6); assert.equal(c.length, 18);
    Q.retimeClip(q, c.id, "out", 18);
    near(c.speed, 0.5); assert.equal(c.length, 36); assert.equal(c.start, 16);
    Q.loopExtend(q, c.id, 36);
    assert.equal(c.loop, "cycle"); assert.equal(c.length, 72);
    near(Q.turnsOf(c), 2);
    assert.ok(Q.splitClip(q, c.id, 40).error, "a looped clip is not split");
    Q.setClip(q, c.id, { loop: "" });
    assert.equal(c.length, 36);
    const before = [];
    for (let f = 16; f <= 52; f += 3) before.push(S.evaluateIn(scene, box, f).position);
    const sp = Q.splitClip(q, c.id, 30);
    assert.equal(t.clips.length, 2);
    assert.equal(sp.b.start, 30);
    for (let f = 16, i = 0; f <= 52; f += 3, i++) near(S.evaluateIn(scene, box, f).position, before[i], 1e-9, `split @${f}`);
    const d = Q.duplicateClip(q, sp.b.id);
    near(d.start, Q.clipEnd(sp.b));
    Q.moveClip(q, d.id, 200);
    assert.equal(d.start, 200);
    Q.removeClip(q, d.id);
    assert.equal(Q.findClip(q, d.id), null);
});

test("cycles: a cycling walk with accumulate walks on, and Match to previous picks it up", () => {
    const { scene, box } = walker();
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 0, 24));
    const t = Q.addTrack(q);
    const c = Q.addClip(q, t.id, src.id, 0, { loop: "cycle", length: 72, accumulate: true });
    near(Q.cycleTravel(scene, q, c), [0, 0, 10]);
    near(S.evaluateIn(scene, box, 30).position, [0, 0.5, 12.5]);
    near(S.evaluateIn(scene, box, 72).position, [0, 0, 30]);
    // The next clip, on another track, starts where this one left off.
    const t2 = Q.addTrack(q);
    const n = Q.addClip(q, t2.id, src.id, 72);
    Q.matchToPrevious(scene, q, n);
    near(n.offset.p, [0, 0, 30]);
    near(S.evaluateIn(scene, box, 73).position, S.evaluate({ ...box, tracks: src.items[box.id].tracks }, 1).position.map((x, i) => x + [0, 0, 30][i]), 1e-6);
    near(S.evaluateIn(scene, box, 96).position, [0, 0, 40]);
});

test("match turns the next clip the way the last one faced", () => {
    const { scene, box } = boxScene();
    // A box that turns 90° left while it walks 5 along +Z.
    S.setKeyframe(box, "position", 0, [0, 0, 0], "linear");
    S.setKeyframe(box, "position", 10, [0, 0, 5], "linear");
    S.setKeyframe(box, "rotation", 0, [0, 0, 0], "linear");
    S.setKeyframe(box, "rotation", 10, [0, 90, 0], "linear");
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 0, 10));
    const a = Q.addClip(q, Q.addTrack(q).id, src.id, 0);
    const b = Q.addClip(q, Q.addTrack(q).id, src.id, 10);
    Q.matchToPrevious(scene, q, b);
    near(b.offset.yaw, 90);
    const end = S.evaluateIn(scene, box, 20);
    // The second walk goes along +X (the way the box faced), turning on to 180°.
    near(end.position, [5, 0, 5], 1e-6);
    near(Math.abs(end.rotation[1]) % 360, 180, 1e-6);
    void a;
});

test("bake: the clips become keys that play the same, and the clips go", () => {
    const { scene, box } = walker();
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 0, 24));
    const t = Q.addTrack(q);
    Q.addClip(q, t.id, src.id, 0, { loop: "cycle", length: 48, accumulate: true });
    Q.addClip(q, Q.addTrack(q).id, src.id, 48, { offset: { p: [0, 0, 20], yaw: 0, pivot: [0, 0, 0] } });
    const want = [];
    for (let f = 0; f <= 72; f++) want.push(S.evaluateIn(scene, box, f));
    const r = Q.bakeToKeys(scene);
    assert.equal(r.items, 1);
    assert.ok(r.keys > 4);
    assert.equal(q.tracks.length, 0);
    assert.equal(q.sources.length, 0);
    for (let f = 0; f <= 72; f++) {
        near(S.evaluateIn(scene, box, f).position, want[f].position, 0.05, `pos@${f}`);
        near(S.evaluateIn(scene, box, f).rotation, want[f].rotation, 0.5, `rot@${f}`);
    }
});

test("retarget: a clip made on one character plays on another by control role", () => {
    const scene = S.makeScene();
    const mk = (model, type, role, v) => {
        const it = { id: `${model}_${role}`, kind: "control", name: role, parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0], tracks: {}, visible: true,
                     control: { model, type, role } };
        if (v) S.setKeyframe(it, "rotation", 0, v);
        scene.items.push(it);
        return it;
    };
    const a = mk("A", "fk", "head", [10, 0, 0]);
    const b = mk("B", "fk", "head", null);
    mk("B", "fk", "neck", null);
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [a.id], 0, 10, { model: "A" }));
    const c = Q.addClip(q, Q.addTrack(q).id, src.id, 0, { target: "B" });
    near(S.evaluateIn(scene, b, 3).rotation, [10, 0, 0]);
    a.rotation = [0, 5, 0];
    near(S.evaluateIn(scene, a, 3).rotation, [0, 5, 0], 1e-9, "the source's own character is not played on");
    assert.deepEqual(Q.affectedItems(scene).map((i) => i.id), [b.id]);
    void c;
});

test("file clips: a model's own animations are weighted, not keyed", () => {
    const scene = S.makeScene();
    const m = S.makeModelItem({ filename: "x.glb" }, "Hero");
    scene.items.push(m);
    const q = Q.ensureSeq(scene);
    const walk = Q.addSource(q, Q.fileSource(m, 0, "walk", 24));
    const run = Q.addSource(q, Q.fileSource(m, 1, "run", 16));
    const t = Q.addTrack(q);
    Q.addClip(q, t.id, walk.id, 0, { loop: "cycle", length: 48 });
    Q.addClip(q, t.id, run.id, 40);
    const at = S.evaluateIn(scene, m, 44);
    assert.equal(at.fileClips.length, 2);
    near(at.fileClips[0].frame, 20);
    near(at.fileClips[0].weight + at.fileClips[1].weight, 1);
    near(at.fileClips[1].frame, 4);
});

test("the sequencer survives a save and an undo (parseScene keeps it)", () => {
    const { scene, box } = walker();
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 0, 24));
    Q.addClip(q, Q.addTrack(q).id, src.id, 5, { loop: "pingpong", length: 60 });
    const back = S.parseScene(S.serializeScene(scene));
    Q.normalizeSeq(back.sequencer);
    assert.deepEqual(back.sequencer, JSON.parse(JSON.stringify(q)));
    const b = S.itemById(back, box.id);
    near(S.evaluateIn(back, b, 37).position, S.evaluateIn(scene, box, 37).position);
    // Something unreadable is tidied, not thrown.
    const odd = Q.normalizeSeq({ tracks: [{ clips: [{ start: "x", speed: 99 }, null] }, 5], sources: [null, { items: { a: { tracks: { position: "no" } } } }] });
    assert.equal(odd.tracks.length, 1);
    assert.equal(odd.tracks[0].clips[0].speed, Q.MAX_SPEED);
    assert.deepEqual(odd.sources[0].items.a.tracks, {});
});

test("withClipsBaked: a copy with keys for readers that know keys only; the scene is untouched", () => {
    const { scene, box } = walker();
    const q = Q.ensureSeq(scene);
    const src = Q.addSource(q, Q.captureSource(scene, [box.id], 0, 24));
    Q.addClip(q, Q.addTrack(q).id, src.id, 10, { loop: "cycle", length: 48, accumulate: true });
    const json = S.serializeScene(scene);
    const flat = Q.withClipsBaked(scene);
    assert.equal(S.serializeScene(scene), json);
    assert.equal(flat.sequencer, undefined);
    const b = S.itemById(flat, box.id);
    for (const f of [10, 21, 40, 58]) near(S.evaluate(b, f).position, S.evaluateIn(scene, box, f).position, 1e-6, `@${f}`);
});
