// node --test tests/test_rig_data.mjs
// The rig's data and maths (imageViewer_rigData.js), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../js/imageViewer_rigData.js";
import * as S from "../js/imageViewer_scene3d.js";

const { mat4, quat, v3 } = R;
const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};

// The same figure tests/rig_fixture.py writes: T-posed, Y up, facing +Z, left along +X.
const BONES = [
    ["Hips", null, [0, 1, 0]], ["Spine", "Hips", [0, 1.1, 0]], ["Spine1", "Spine", [0, 1.25, 0]],
    ["Spine2", "Spine1", [0, 1.4, 0]], ["Neck", "Spine2", [0, 1.55, 0]], ["Head", "Neck", [0, 1.65, 0]],
    ["HeadTop_End", "Head", [0, 1.85, 0]],
    ["LeftShoulder", "Spine2", [0.06, 1.5, 0]], ["LeftArm", "LeftShoulder", [0.18, 1.5, 0]],
    ["LeftForeArm", "LeftArm", [0.46, 1.5, 0]], ["LeftHand", "LeftForeArm", [0.72, 1.5, 0]],
    ["LeftHandMiddle1", "LeftHand", [0.8, 1.5, 0]], ["LeftHandMiddle4", "LeftHandMiddle1", [0.9, 1.5, 0]],
    ["RightShoulder", "Spine2", [-0.06, 1.5, 0]], ["RightArm", "RightShoulder", [-0.18, 1.5, 0]],
    ["RightForeArm", "RightArm", [-0.46, 1.5, 0]], ["RightHand", "RightForeArm", [-0.72, 1.5, 0]],
    ["RightHandMiddle1", "RightHand", [-0.8, 1.5, 0]], ["RightHandMiddle4", "RightHandMiddle1", [-0.9, 1.5, 0]],
    ["LeftUpLeg", "Hips", [0.1, 0.95, 0]], ["LeftLeg", "LeftUpLeg", [0.1, 0.52, 0.01]],
    ["LeftFoot", "LeftLeg", [0.1, 0.09, 0]], ["LeftToeBase", "LeftFoot", [0.1, 0.02, 0.12]],
    ["LeftToe_End", "LeftToeBase", [0.1, 0.02, 0.2]],
    ["RightUpLeg", "Hips", [-0.1, 0.95, 0]], ["RightLeg", "RightUpLeg", [-0.1, 0.52, 0.01]],
    ["RightFoot", "RightLeg", [-0.1, 0.09, 0]], ["RightToeBase", "RightFoot", [-0.1, 0.02, 0.12]],
    ["RightToe_End", "RightToeBase", [-0.1, 0.02, 0.2]],
];
const UNREAL = {
    Hips: "pelvis", Spine: "spine_01", Spine1: "spine_02", Spine2: "spine_03", Neck: "neck_01", Head: "head",
    HeadTop_End: "head_end", LeftShoulder: "clavicle_l", LeftArm: "upperarm_l", LeftForeArm: "lowerarm_l",
    LeftHand: "hand_l", LeftHandMiddle1: "middle_01_l", LeftHandMiddle4: "middle_end_l",
    RightShoulder: "clavicle_r", RightArm: "upperarm_r", RightForeArm: "lowerarm_r", RightHand: "hand_r",
    RightHandMiddle1: "middle_01_r", RightHandMiddle4: "middle_end_r", LeftUpLeg: "thigh_l", LeftLeg: "calf_l",
    LeftFoot: "foot_l", LeftToeBase: "ball_l", LeftToe_End: "ball_end_l", RightUpLeg: "thigh_r",
    RightLeg: "calf_r", RightFoot: "foot_r", RightToeBase: "ball_r", RightToe_End: "ball_end_r",
};

function skeleton(rename = (n) => n, scale = 1) {
    return {
        bones: BONES.map(([n, p, h]) => ({
            name: rename(n), parent: p ? rename(p) : null,
            world: mat4.compose(h, [0, 0, 0, 1], [scale, scale, scale]),
        })),
    };
}
const asMatch = (sk) => sk.bones.map((b) => ({ name: b.name, parent: b.parent, head: [b.world[12], b.world[13], b.world[14]] }));

const EXPECT = {
    hips: "Hips", spine: "Spine", head: "Head", neck: "Neck",
    "upperArm.L": "LeftArm", "lowerArm.L": "LeftForeArm", "hand.L": "LeftHand", "shoulder.L": "LeftShoulder",
    "upperArm.R": "RightArm", "lowerArm.R": "RightForeArm", "hand.R": "RightHand",
    "upperLeg.L": "LeftUpLeg", "lowerLeg.L": "LeftLeg", "foot.L": "LeftFoot", "toes.L": "LeftToeBase",
    "upperLeg.R": "RightUpLeg", "lowerLeg.R": "RightLeg", "foot.R": "RightFoot", "toes.R": "RightToeBase",
};

test("Mixamo names (as three.js's loader sanitises them) are read as a humanoid", () => {
    const m = R.matchHumanoid(asMatch(skeleton((n) => `mixamorig${n}`)));
    assert.equal(m.humanoid, true, `missing ${m.missing}`);
    for (const [role, bone] of Object.entries(EXPECT)) assert.equal(m.roles[role], `mixamorig${bone}`, role);
});

test("Unreal names are read as a humanoid", () => {
    const m = R.matchHumanoid(asMatch(skeleton((n) => UNREAL[n])));
    assert.equal(m.humanoid, true, `missing ${m.missing}`);
    for (const [role, bone] of Object.entries(EXPECT)) assert.equal(m.roles[role], UNREAL[bone], role);
});

test("a skeleton with meaningless names is read from its shape", () => {
    const idx = new Map(BONES.map(([n], i) => [n, i]));
    const m = R.matchHumanoid(asMatch(skeleton((n) => `bone_${idx.get(n)}`)));
    assert.equal(m.humanoid, true, `missing ${m.missing}`);
    assert.ok(m.byShape);
    for (const role of ["hips", "upperArm.L", "lowerArm.L", "hand.L", "upperLeg.R", "lowerLeg.R", "foot.R", "head"]) {
        assert.equal(m.roles[role], `bone_${idx.get(EXPECT[role])}`, role);
    }
});

test("a four-legged skeleton is not taken for a human", () => {
    const quad = [
        { name: "root", parent: null, head: [0, 1, 0] },
        { name: "spine", parent: "root", head: [0, 1, 0.5] }, { name: "neck", parent: "spine", head: [0, 1.2, 0.9] },
        { name: "fl1", parent: "spine", head: [0.2, 0.9, 0.5] }, { name: "fl2", parent: "fl1", head: [0.2, 0.4, 0.5] },
        { name: "fl3", parent: "fl2", head: [0.2, 0, 0.5] },
        { name: "fr1", parent: "spine", head: [-0.2, 0.9, 0.5] }, { name: "fr2", parent: "fr1", head: [-0.2, 0.4, 0.5] },
        { name: "fr3", parent: "fr2", head: [-0.2, 0, 0.5] },
        { name: "tail", parent: "root", head: [0, 1, -0.4] },
    ];
    const m = R.matchHumanoid(quad);
    assert.equal(m.humanoid, false);
});

test("quaternion, Euler and matrix maths agree with three.js's conventions", () => {
    const e = [30, -50, 110];
    const q = quat.fromEulerDeg(e);
    near(quat.toEulerDeg(q), e, 1e-9);
    const m = mat4.compose([1, 2, 3], q, [2, 2, 2]);
    const back = mat4.mul(m, mat4.invert(m));
    near(back, mat4.identity(), 1e-9);
    const d = mat4.decompose(m);
    near(d.p, [1, 2, 3]); near(d.s, [2, 2, 2]);
    near(Math.abs(quat.mul(d.q, quat.conj(q))[3]), 1, 1e-9);
    // R = Rx·Ry·Rz: rotating X by (0, 0, 90) gives Y.
    near(quat.rotate(quat.fromEulerDeg([0, 0, 90]), [1, 0, 0]), [0, 1, 0], 1e-12);
});

test("the rig: a root, a COG, FK on each bone, IK and a pole per limb", () => {
    const model = { id: "m1", name: "Hero" };
    const rig = R.buildRig(model, skeleton((n) => `mixamorig${n}`));
    assert.equal(rig.humanoid, true);
    const types = rig.items.map((c) => c.control.type);
    assert.equal(types.filter((t) => t === "root").length, 1);
    assert.equal(types.filter((t) => t === "cog").length, 1);
    assert.equal(types.filter((t) => t === "ik").length, 4);
    assert.equal(types.filter((t) => t === "pole").length, 4);
    assert.equal(types.filter((t) => t === "fk").length, BONES.length - 3);   // not HeadTop_End, the toe ends
    assert.equal(rig.group.parent, "m1");
    for (const c of rig.items) assert.equal(c.control.model, "m1");
    // Rest worlds put each FK control on its bone.
    const world = new Map();
    for (const c of rig.items) {
        const pw = world.get(c.parent) || mat4.identity();
        world.set(c.id, mat4.mul(pw, c.rest));
    }
    const sk = skeleton((n) => `mixamorig${n}`);
    for (const c of rig.items.filter((x) => x.control.type === "fk")) {
        const b = sk.bones.find((x) => x.name === c.control.bone);
        near(mat4.mul(world.get(c.id), c.control.bind), b.world, 1e-9, c.name);
    }
    // Poles: the knees point forward (+Z), the elbows back (-Z).
    const pole = (role) => {
        const p = rig.items.find((c) => c.control.type === "pole" && c.control.role === role);
        return world.get(p.id);
    };
    assert.ok(pole("leg.L")[14] > 0.2);
    assert.ok(pole("arm.L")[14] < -0.2);
    // The IK chain names its three bones.
    const legL = rig.items.find((c) => c.control.type === "ik" && c.control.role === "leg.L");
    assert.deepEqual(legL.control.chain, ["mixamorigLeftUpLeg", "mixamorigLeftLeg", "mixamorigLeftFoot"]);
    assert.equal(legL.ikfk, 1);
});

test("the scene keeps a control through serialize and parse", () => {
    const model = { id: "m1", name: "Hero" };
    const rig = R.buildRig(model, skeleton());
    const scene = S.makeScene({ items: [{ ...S.makeModelItem({ filename: "hero.glb" }, "Hero"), id: "m1" }, rig.group, ...rig.items] });
    const ik = rig.items.find((c) => c.control.type === "ik");
    S.setKeyframe(ik, "ikfk", 0, 1, "hold");
    S.setKeyframe(ik, "ikfk", 10, 0, "hold");
    const back = S.parseScene(S.serializeScene(scene));
    assert.equal(back.items.length, scene.items.length);
    const ik2 = back.items.find((c) => c.id === ik.id);
    assert.equal(ik2.kind, "control");
    assert.deepEqual(ik2.control.chain, ik.control.chain);
    near(ik2.rest, ik.rest);
    assert.equal(S.valueAt(ik2, "ikfk", 5), 1);
    assert.equal(S.valueAt(ik2, "ikfk", 10), 0);
    assert.equal(back.items.find((g) => g.id === rig.group.id).rig.model, "m1");
});

test("a control's channels round-trip through its local matrix", () => {
    const item = { rest: mat4.compose([0.1, 1, 0], quat.fromEulerDeg([0, 30, 0]), [1, 1, 1]) };
    const at = { position: [0.2, -0.1, 0.3], rotation: [10, 20, -35], scale: [1, 1, 1] };
    const local = R.controlLocal(item, at);
    const ch = R.channelsForLocal(item, local);
    near(ch.position, at.position, 1e-9);
    near(ch.rotation, at.rotation, 1e-9);
});

test("two-bone IK reaches the target, keeps the bone lengths, and bends towards the pole", () => {
    // A straight leg: hip, knee, ankle down the Y axis.
    const pa = [0, 1, 0], pb = [0, 0.5, 0], pc = [0, 0, 0];
    const qa = [0, 0, 0, 1], qb = [0, 0, 0, 1];
    const target = [0, 0.3, 0.2], pole = [0, 0.5, 1];
    const hinge = [-1, 0, 0];       // bending forward about -X, in the hip's space
    const sol = R.solveTwoBone({ pa, pb, pc, qa, qb, target, pole, hinge, lengths: [0.5, 0.5] });
    near(sol.pc, target, 1e-6, "end");
    near(v3.dist(pa, sol.pb), 0.5, 1e-9, "upper");
    near(v3.dist(sol.pb, sol.pc), 0.5, 1e-9, "lower");
    assert.ok(sol.pb[2] > 0.1, "the knee goes forward, towards the pole");
    // The rotations carry the bones to those joints.
    near(v3.add(pa, quat.rotate(sol.qa, v3.sub(pb, pa))), sol.pb, 1e-6, "upper rot");
    near(v3.add(sol.pb, quat.rotate(sol.qb, v3.sub(pc, pb))), sol.pc, 1e-6, "lower rot");
    // Out of reach: the limb straightens towards it.
    const far = R.solveTwoBone({ pa, pb, pc, qa, qb, target: [0, -2, 0.5], pole, hinge, lengths: [0.5, 0.5] });
    near(v3.dist(pa, far.pc), 1, 1e-3);
});

test("a baked track keeps only the keys it needs", () => {
    const s = [];
    for (let f = 0; f <= 20; f++) s.push({ f, v: [f < 10 ? f : 20 - f, 0, 0] });
    const kept = R.reduceKeys(s, 1e-6);
    assert.deepEqual(kept.map((k) => k.f), [0, 10, 20]);
});

test("a pose read into canonical space and written onto an A-posed rig points the same way", () => {
    // Source: the T-posed figure, its left arm raised 45° up (about +Z... towards +Y).
    const src = new Map(BONES.map(([n, , h]) => [n, h]));
    const childOf = (n) => BONES.find((b) => b[1] === n);
    const restSrc = {};
    const restTgt = {};
    const role = { "upperArm.L": "LeftArm", "lowerArm.L": "LeftForeArm" };
    // Target: the same arm at rest in an A-pose, 40° down.
    const aDown = quat.axisAngle([0, 0, 1], -40 * Math.PI / 180);
    for (const [r, n] of Object.entries(role)) {
        const c = childOf(n);
        restSrc[r] = { q: [0, 0, 0, 1], head: src.get(n), childHead: src.get(c[0]) };
        const head = src.get(n), ch = src.get(c[0]);
        const sh = src.get("LeftArm");
        const rot = (p) => v3.add(sh, quat.rotate(aDown, v3.sub(p, sh)));
        restTgt[r] = { q: aDown, head: rot(head), childHead: rot(ch) };
    }
    const alignS = R.canonicalAlign(restSrc), alignT = R.canonicalAlign(restTgt);
    const up = quat.axisAngle([0, 0, 1], 45 * Math.PI / 180);
    const worldSrc = { "upperArm.L": up, "lowerArm.L": up };
    const canon = R.toCanonical(worldSrc, { "upperArm.L": [0, 0, 0, 1], "lowerArm.L": [0, 0, 0, 1] }, alignS);
    const worldTgt = R.fromCanonical(canon, { "upperArm.L": aDown, "lowerArm.L": aDown }, alignT);
    // The target arm's bone direction (its rest direction turned by its new world rotation, from rest)
    const dirT = quat.rotate(quat.mul(worldTgt["upperArm.L"], quat.conj(aDown)),
                             v3.norm(v3.sub(restTgt["upperArm.L"].childHead, restTgt["upperArm.L"].head)));
    const dirS = quat.rotate(up, [1, 0, 0]);
    near(dirT, dirS, 1e-9);
});
