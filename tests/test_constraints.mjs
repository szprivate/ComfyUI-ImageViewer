// node --test tests/test_constraints.mjs
// Constraints of the 3D space (imageViewer_constraintData.js, imageViewer_constraints.js), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_scene3d.js";
import * as D from "../js/imageViewer_constraintData.js";
import * as C from "../js/imageViewer_constraints.js";

const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};

function box(name, patch = {}) {
    const it = S.makePrimitiveItem("box", name);
    return Object.assign(it, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, patch);
}

function scene(...items) {
    return S.makeScene({ items });
}

function add(sc, driven, type, targets, opts = {}, frame = 0) {
    const c = D.makeConstraint(type, targets.map((t) => t.id), { kind: driven.kind, ...opts });
    (driven.constraints || (driven.constraints = [])).push(c);
    C.captureOffsets(sc, driven, c, frame);
    return c;
}

const worldPos = (sc, id, f = 0) => C.decompose(C.solver(sc, f).world(id).root).t;
const worldQuat = (sc, id, f = 0) => C.decompose(C.solver(sc, f).world(id).root).q;
const sameRot = (a, b, eps = 1e-6) => {
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    assert.ok(Math.abs(d - 1) < eps, `rotations differ: ${a} vs ${b}`);
};

test("matrix and Euler maths agree with each other", () => {
    for (const e of [[10, 20, 30], [-170, 80, 45], [90, 0, -90], [0, 89.9, 0], [33, -60, 120]]) {
        const q = C.quatFromEuler(e);
        const back = C.eulerFromQuat(q, e);
        near(back, e, 1e-6, `euler ${e}`);
        const m = C.compose([1, 2, 3], q, [2, 3, 4]);
        const d = C.decompose(m);
        near(d.t, [1, 2, 3]); near(d.s, [2, 3, 4]); sameRot(d.q, q);
        const I = C.multiply(m, C.invert(m));
        near(I, C.identity(), 1e-9);
    }
    // The second solution, when it is the nearer one.
    const q = C.quatFromEuler([180, 0, 180]);
    near(C.eulerFromQuat(q, [180, 0, 180]), [180, 0, 180], 1e-6);
    // Unwrapped onto the reference: no jump of a whole turn.
    near(C.eulerFromQuat(C.quatFromEuler([0, 0, 10]), [0, 0, 365]), [0, 0, 370], 1e-6);
});

test("point constraint: snaps, keeps an offset, blends by weight, skips axes", () => {
    const a = box("A", { position: [2, 0, 0] });
    const b = box("B", { position: [0, 4, 0] });
    const d = box("D", { position: [0, 0, 1] });
    const sc = scene(a, b, d);
    const c = add(sc, d, "point", [a], { maintainOffset: false });
    near(worldPos(sc, d.id), [2, 0, 0]);
    // A second target at the same weight: the middle.
    c.targets.push({ id: b.id, w: 1, offset: null });
    near(worldPos(sc, d.id), [1, 2, 0]);
    // Weights are shares: 3 to 1.
    c.targets[0].w = 3;
    near(worldPos(sc, d.id), [1.5, 1, 0]);
    // Skip Y: Y stays the item's own.
    c.skip.t = [1];
    near(worldPos(sc, d.id), [1.5, 0, 0]);
    // The constraint's own weight blends with where it would be.
    c.skip.t = [];
    c.weight = 0.5;
    near(worldPos(sc, d.id), [0.75, 0.5, 0.5]);
    // Maintain offset: nothing moves when it is made, then it follows.
    const e = box("E", { position: [5, 5, 5] });
    sc.items.push(e);
    add(sc, e, "point", [a]);
    near(worldPos(sc, e.id), [5, 5, 5]);
    a.position = [3, 0, 0];
    near(worldPos(sc, e.id), [6, 5, 5]);
});

test("orient constraint keeps position and follows the blended rotation", () => {
    const a = box("A", { rotation: [0, 90, 0] });
    const b = box("B", { rotation: [0, 0, 0] });
    const d = box("D", { position: [1, 2, 3] });
    const sc = scene(a, b, d);
    const c = add(sc, d, "orient", [a, b], { maintainOffset: false });
    near(worldPos(sc, d.id), [1, 2, 3]);
    sameRot(worldQuat(sc, d.id), C.quatFromEuler([0, 45, 0]));
    c.targets[1].w = 0;
    sameRot(worldQuat(sc, d.id), C.quatFromEuler([0, 90, 0]));
    // The channels the view will write read as degrees near the item's own.
    const loc = C.constrainedLocals(sc, 0).get(d.id);
    near(loc.rotation, [0, 90, 0], 1e-6);
    near(loc.position, [1, 2, 3]);
});

test("parent constraint carries the item like a child, with the offset kept", () => {
    const a = box("A", { position: [1, 0, 0] });
    const d = box("D", { position: [3, 0, 0], rotation: [0, 0, 10] });
    const sc = scene(a, d);
    add(sc, d, "parent", [a]);
    near(worldPos(sc, d.id), [3, 0, 0]);
    sameRot(worldQuat(sc, d.id), C.quatFromEuler([0, 0, 10]));
    // Turn the target a quarter about Y: the item swings round it.
    a.rotation = [0, 90, 0];
    near(worldPos(sc, d.id), [1, 0, -2]);
    sameRot(worldQuat(sc, d.id), C.quatMultiply(C.quatFromEuler([0, 90, 0]), C.quatFromEuler([0, 0, 10])));
    // Scale is left alone.
    d.scale = [2, 2, 2];
    near(C.decompose(C.solver(sc, 0).world(d.id).root).s, [2, 2, 2]);
});

test("scale constraint", () => {
    const a = box("A", { scale: [2, 3, 4] });
    const d = box("D");
    const sc = scene(a, d);
    add(sc, d, "scale", [a], { maintainOffset: false });
    near(C.decompose(C.solver(sc, 0).world(d.id).root).s, [2, 3, 4]);
});

test("aim constraint points the aim axis at the target, up towards scene up", () => {
    const t = box("T", { position: [5, 0, 0] });
    const d = box("D");
    const sc = scene(t, d);
    add(sc, d, "aim", [t], { maintainOffset: false });
    const q = worldQuat(sc, d.id);
    near(C.rotateVector(q, [0, 0, 1]), [1, 0, 0], 1e-9);
    near(C.rotateVector(q, [0, 1, 0]), [0, 1, 0], 1e-9);
    // A camera aims down its -Z.
    const cam = S.makeCameraItem("Cam", { position: [0, 0, 0], rotation: [0, 0, 0] });
    sc.items.push(cam);
    add(sc, cam, "aim", [t], { maintainOffset: false });
    near(C.rotateVector(worldQuat(sc, cam.id), [0, 0, -1]), [1, 0, 0], 1e-9);
    // Up from an object: up points at it as far as it can.
    const u = box("U", { position: [0, 0, 3] });
    sc.items.push(u);
    const e = box("E");
    sc.items.push(e);
    add(sc, e, "aim", [t], { maintainOffset: false, aim: { upType: "object", upObject: u.id } });
    near(C.rotateVector(worldQuat(sc, e.id), [0, 1, 0]), [0, 0, 1], 1e-9);
    // Maintain offset: no turn when made.
    const f = box("F", { rotation: [10, 20, 30] });
    sc.items.push(f);
    add(sc, f, "aim", [t]);
    sameRot(worldQuat(sc, f.id), C.quatFromEuler([10, 20, 30]));
});

test("a target inside a moved group, and a driven item inside a turned group", () => {
    const g = S.makeGroupItem("G");
    g.position = [10, 0, 0];
    g.rotation = [0, 90, 0];
    const a = box("A", { position: [1, 0, 0], parent: g.id });
    const g2 = S.makeGroupItem("G2");
    g2.position = [0, 5, 0];
    g2.rotation = [0, 0, 45];
    g2.scale = [2, 2, 2];
    const d = box("D", { parent: g2.id });
    const sc = scene(g, a, g2, d);
    add(sc, d, "point", [a], { maintainOffset: false });
    // A's root is at G · (1,0,0) = (10, 0, -1).
    near(worldPos(sc, a.id), [10, 0, -1], 1e-9);
    near(worldPos(sc, d.id), [10, 0, -1], 1e-9);
    // And the channels say so in G2's space.
    const loc = C.constrainedLocals(sc, 0).get(d.id);
    const back = C.transformPoint(C.solver(sc, 0).world(g2.id).inner, loc.position);
    near(back, [10, 0, -1], 1e-9);
});

test("a pivot and a frozen transform are where the target's root is", () => {
    const a = box("A", { position: [1, 0, 0], pivot: [0, 2, 0] });
    const d = box("D", { pivot: [0, 1, 0] });
    const sc = scene(a, d);
    add(sc, d, "point", [a], { maintainOffset: false });
    // A's root sits at position + pivot; D's root (its pivot point) goes there.
    near(worldPos(sc, d.id), [1, 2, 0]);
    near(C.constrainedLocals(sc, 0).get(d.id).position, [1, 1, 0]);
});

test("weights are channels: keyed, they animate the blend", () => {
    const a = box("A", { position: [0, 0, 0] });
    const b = box("B", { position: [10, 0, 0] });
    const d = box("D");
    const sc = scene(a, b, d);
    const c = add(sc, d, "point", [a, b], { maintainOffset: false });
    const wa = D.weightProp(c.id, a.id), wb = D.weightProp(c.id, b.id);
    assert.ok(S.isExtraProp(wa));
    assert.equal(S.valueAt(d, wa, 0), 1);
    S.setKeyframe(d, wa, 0, 1, "linear");
    S.setKeyframe(d, wa, 10, 0, "linear");
    S.setKeyframe(d, wb, 0, 0, "linear");
    S.setKeyframe(d, wb, 10, 1, "linear");
    near(worldPos(sc, d.id, 0), [0, 0, 0]);
    near(worldPos(sc, d.id, 5), [5, 0, 0]);
    near(worldPos(sc, d.id, 10), [10, 0, 0]);
    assert.deepEqual(S.keyframeFrames(d), [0, 10]);
    // The envelope too.
    S.setKeyframe(d, D.envelopeProp(c.id), 0, 1, "linear");
    S.setKeyframe(d, D.envelopeProp(c.id), 10, 0, "linear");
    near(worldPos(sc, d.id, 10), [0, 0, 0]);
    near(worldPos(sc, d.id, 5), [2.5, 0, 0]);
    // A static write goes into the constraint.
    S.setStaticValue(d, wb, 0.25);
    assert.equal(c.targets[1].w, 0.25);
    // Survives a save and a load.
    const back = S.parseScene(S.serializeScene(sc));
    const d2 = S.itemById(back, d.id);
    assert.equal(d2.constraints.length, 1);
    assert.equal(S.track(d2, wa).length, 2);
    near(C.decompose(C.solver(back, 5).world(d.id).root).t, [2.5, 0, 0]);
});

test("loading drops targets that are gone and their weight channels", () => {
    const a = box("A", { position: [1, 0, 0] });
    const b = box("B");
    const d = box("D");
    const sc = scene(a, b, d);
    const c = add(sc, d, "point", [a, b]);
    S.setKeyframe(d, D.weightProp(c.id, b.id), 3, 0.5);
    sc.items = sc.items.filter((it) => it.id !== b.id);
    const back = S.parseScene(S.serializeScene(sc));
    const d2 = S.itemById(back, d.id);
    assert.equal(d2.constraints[0].targets.length, 1);
    assert.equal(S.track(d2, D.weightProp(c.id, b.id)).length, 0);
    // Without any target left, the constraint goes.
    back.items = back.items.filter((it) => it.id !== a.id);
    const again = S.parseScene(S.serializeScene(back));
    assert.equal(S.itemById(again, d.id).constraints, undefined);
});

test("loops are refused, and broken if they are there anyway", () => {
    const a = box("A");
    const b = box("B", { parent: a.id });
    const d = box("D");
    const sc = scene(a, b, d);
    assert.ok(C.cannotConstrain(sc, a.id, b.id), "a child cannot drive its parent");
    assert.ok(C.cannotConstrain(sc, a.id, a.id));
    assert.equal(C.cannotConstrain(sc, d.id, b.id), "");
    add(sc, d, "point", [a]);
    assert.ok(C.cannotConstrain(sc, a.id, d.id), "D already follows A");
    // Forced: the solve still ends.
    a.constraints = [D.makeConstraint("point", [d.id])];
    const sv = C.solver(sc, 0);
    assert.ok(sv.world(a.id));
    assert.ok(sv.world(d.id));
});

test("stacked constraints: point then aim", () => {
    const p = box("P", { position: [0, 3, 0] });
    const t = box("T", { position: [5, 3, 0] });
    const d = box("D");
    const sc = scene(p, t, d);
    add(sc, d, "point", [p], { maintainOffset: false });
    add(sc, d, "aim", [t], { maintainOffset: false });
    near(worldPos(sc, d.id), [0, 3, 0]);
    near(C.rotateVector(worldQuat(sc, d.id), [0, 0, 1]), [1, 0, 0], 1e-9);
});

test("bake: continuous rotation keys on every frame", () => {
    const t = box("T", { position: [5, 0, 0] });
    const d = box("D");
    const sc = scene(t, d);
    add(sc, d, "aim", [t], { maintainOffset: false });
    // The target goes round the item once.
    for (let f = 0; f <= 40; f += 10) {
        const a = (f / 40) * 2 * Math.PI;
        S.setKeyframe(t, "position", f, [5 * Math.cos(a), 0, -5 * Math.sin(a)], "linear");
    }
    const baked = C.bakeFrames(sc, [d.id], 0, 40).get(d.id);
    assert.equal(baked.length, 41);
    for (let i = 1; i < baked.length; i++) {
        const dy = Math.abs(baked[i].rotation[1] - baked[i - 1].rotation[1]);
        assert.ok(dy < 30, `jump at ${i}: ${dy}`);
    }
    assert.deepEqual(C.bakedProps(d), ["rotation"]);
});

test("weight channels list and names", () => {
    const a = box("A");
    const d = box("D");
    const c = D.makeConstraint("parent", [a.id], { name: D.nextConstraintName(d, "parent") });
    d.constraints = [c];
    assert.equal(c.name, "parentConstraint1");
    assert.equal(D.nextConstraintName(d, "parent"), "parentConstraint2");
    const ch = D.weightChannels(d, () => "A");
    assert.deepEqual(ch.map((x) => x.label), ["parentConstraint1.weight", "parentConstraint1.AW"]);
    assert.deepEqual([...D.constrainedChannels(d)].sort(), ["r0", "r1", "r2", "t0", "t1", "t2"]);
    assert.deepEqual(D.parseWeightProp(ch[1].prop), { cid: c.id, target: a.id });
});

test("a rig control's rest matrix sits above its channels", () => {
    const t = box("T", { position: [5, 1, 0] });
    const ctrl = { id: "k1", kind: "control", name: "hand_ctrl", parent: null, position: [0, 0, 0], rotation: [0, 0, 0],
                   scale: [1, 1, 1], pivot: [0, 0, 0], visible: true, tracks: {},
                   rest: C.compose([1, 0, 0], C.quatFromEuler([0, 90, 0]), [1, 1, 1]) };
    const sc = scene(t, ctrl);
    add(sc, ctrl, "point", [t], { maintainOffset: false });
    near(worldPos(sc, ctrl.id), [5, 1, 0], 1e-9);
    // In the control's own (rest) space the channel reads the move from rest.
    const loc = C.constrainedLocals(sc, 0).get(ctrl.id);
    near(C.transformPoint(ctrl.rest, loc.position), [5, 1, 0], 1e-9);
});

test("bakedCopy: an export gets keys, the scene keeps its constraints", () => {
    const a = box("A");
    S.setKeyframe(a, "position", 0, [0, 0, 0], "linear");
    S.setKeyframe(a, "position", 10, [10, 0, 0], "linear");
    const b = box("B", { position: [0, 1, 0] });
    const sc = scene(a, b);
    sc.length = 11;
    const c = add(sc, b, "point", [a]);
    S.setKeyframe(b, D.weightProp(c.id, a.id), 0, 1);
    const copy = C.bakedCopy(sc);
    assert.ok(b.constraints, "the scene itself is untouched");
    const b2 = S.itemById(copy, b.id);
    assert.equal(b2.constraints, undefined);
    assert.equal(S.track(b2, "position").length, 11);
    assert.deepEqual(Object.keys(b2.tracks), ["position"]);
    near(S.valueAt(b2, "position", 5), [5, 1, 0]);
    assert.equal(C.bakedCopy(scene(box("X"))).items.length, 1, "nothing constrained: the scene as it is");
});
