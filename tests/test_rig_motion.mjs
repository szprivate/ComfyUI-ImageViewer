// node --test tests/test_rig_motion.mjs
// Poses to and from the motion model's skeleton, and the feet clean-up (imageViewer_rigMotion.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../js/imageViewer_rigData.js";
import * as M from "../js/imageViewer_rigMotion.js";

const { mat4, quat, v3 } = R;
const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};
const head = (m) => [m[12], m[13], m[14]];
const deg = (d) => (d * Math.PI) / 180;

// tests/rig_fixture.py's figure: T-posed, Y up, facing +Z, left along +X.
const BONES = [
    ["Hips", null, [0, 1, 0]], ["Spine", "Hips", [0, 1.1, 0]], ["Spine1", "Spine", [0, 1.25, 0]],
    ["Spine2", "Spine1", [0, 1.4, 0]], ["Neck", "Spine2", [0, 1.55, 0]], ["Head", "Neck", [0, 1.65, 0]],
    ["HeadTop_End", "Head", [0, 1.85, 0]],
    ["LeftShoulder", "Spine2", [0.06, 1.5, 0]], ["LeftArm", "LeftShoulder", [0.18, 1.5, 0]],
    ["LeftForeArm", "LeftArm", [0.46, 1.5, 0]], ["LeftHand", "LeftForeArm", [0.72, 1.5, 0]],
    ["RightShoulder", "Spine2", [-0.06, 1.5, 0]], ["RightArm", "RightShoulder", [-0.18, 1.5, 0]],
    ["RightForeArm", "RightArm", [-0.46, 1.5, 0]], ["RightHand", "RightForeArm", [-0.72, 1.5, 0]],
    ["LeftUpLeg", "Hips", [0.1, 0.95, 0]], ["LeftLeg", "LeftUpLeg", [0.1, 0.52, 0.01]],
    ["LeftFoot", "LeftLeg", [0.1, 0.09, 0]], ["LeftToeBase", "LeftFoot", [0.1, 0.02, 0.12]],
    ["RightUpLeg", "Hips", [-0.1, 0.95, 0]], ["RightLeg", "RightUpLeg", [-0.1, 0.52, 0.01]],
    ["RightFoot", "RightLeg", [-0.1, 0.09, 0]], ["RightToeBase", "RightFoot", [-0.1, 0.02, 0.12]],
];
const SOMA = ["Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "LeftShoulder", "LeftArm", "LeftForeArm",
    "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand", "LeftLeg", "LeftShin", "LeftFoot",
    "LeftToeBase", "RightLeg", "RightShin", "RightFoot", "RightToeBase"];
const INDEX = new Map(SOMA.map((n, i) => [n, i]));

/** The figure at rest; `frames` turns each bone's own axes (a rig's bones rarely line up with the world). */
function skeleton(frames = () => [0, 0, 0, 1], { aPose = 0 } = {}) {
    const heads = new Map(BONES.map(([n, , h]) => [n, h]));
    // An A-pose: the arms swung down about the shoulders.
    for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
        const sh = heads.get(`${side}Arm`);
        const q = quat.axisAngle([0, 0, 1], -sign * deg(aPose));
        for (const n of [`${side}ForeArm`, `${side}Hand`]) heads.set(n, v3.add(sh, quat.rotate(q, v3.sub(heads.get(n), sh))));
    }
    return { bones: BONES.map(([n, p]) => ({ name: n, parent: p, world: mat4.compose(heads.get(n), frames(n), [1, 1, 1]) })) };
}
const roles = (sk) => R.matchHumanoid(sk.bones.map((b) => ({ name: b.name, parent: b.parent, head: head(b.world) }))).roles;
const twisted = (n) => quat.norm(quat.axisAngle(v3.norm([n.length % 3, 1, (n.length % 5) - 2]), deg(17 * (n.length % 7))));

/** FK: each named bone turned by a world-space rotation about its head, children carried along. */
function posed(sk, turns) {
    const rest = new Map(sk.bones.map((b) => [b.name, b.world]));
    const out = new Map();
    for (const b of sk.bones) {
        const local = b.parent ? mat4.mul(mat4.invert(rest.get(b.parent)), rest.get(b.name)) : rest.get(b.name);
        let w = b.parent ? mat4.mul(out.get(b.parent), local) : local.slice();
        if (turns[b.name]) {
            const d = mat4.decompose(w);
            w = mat4.compose(d.p, quat.mul(turns[b.name], d.q), d.s);
        }
        out.set(b.name, w);
    }
    return out;
}

test("the SOMA joint for each role", () => {
    assert.equal(M.somaJointOf("upperLeg.L", {}), "LeftLeg");
    assert.equal(M.somaJointOf("lowerLeg.R", {}), "RightShin");
    assert.equal(M.somaJointOf("chest", {}), "Chest");
    assert.equal(M.somaJointOf("chest", { upperChest: "x" }), "Spine2");
    assert.equal(M.somaJointOf("toes.L", {}), "LeftToeBase");
});

test("the motion's T-pose puts a T-posed character at rest, sized to it", () => {
    const sk = skeleton(twisted);
    const rest = M.humanoidRest(sk, roles(sk));
    const scale = M.motionScale(rest);
    near(scale, (1 - 0.02) / 1.0052, 1e-9);
    const rot = SOMA.map(() => [0, 0, 0, 1]);
    const pose = M.somaToPose(rot, [0, 1.0052, 0], INDEX, rest, scale);
    // Every joint about where it was: the model's own T-pose leans and bends a little
    // (its shoulders swept back, its head forward: within 8 cm at the top of the head).
    for (const b of sk.bones) near(head(pose.get(b.name)), head(b.world), 0.08, b.name);
    near(head(pose.get("Hips")), [0, 1, 0], 1e-9);
});

test("a pose goes to the model and back unchanged", () => {
    const sk = skeleton(twisted);
    const rest = M.humanoidRest(sk, roles(sk));
    const scale = M.motionScale(rest);
    const pose = posed(sk, {
        Hips: quat.axisAngle([0, 1, 0], deg(30)), Spine1: quat.axisAngle([1, 0, 0], deg(12)),
        LeftArm: quat.axisAngle([0, 0, 1], deg(-60)), LeftForeArm: quat.axisAngle([0, 1, 0], deg(40)),
        RightUpLeg: quat.axisAngle([1, 0, 0], deg(-35)), RightLeg: quat.axisAngle([1, 0, 0], deg(50)),
    });
    const key = M.poseToSoma(pose, rest, scale);
    near(M.headingOf(key), deg(30), 1e-5);
    const rot = SOMA.map((n) => key.joints[n] || [0, 0, 0, 1]);
    const back = M.somaToPose(rot, key.root, INDEX, rest, scale);
    for (const b of sk.bones) near(head(back.get(b.name)), head(pose.get(b.name)), 1e-6, b.name);
});

test("the model's raised arm raises an A-posed character's arm the same way", () => {
    const sk = skeleton(twisted, { aPose: 40 });
    const rest = M.humanoidRest(sk, roles(sk));
    const rot = SOMA.map(() => [0, 0, 0, 1]);
    const up = quat.axisAngle([0, 0, 1], deg(45));        // the left arm, from out sideways (+X) up 45°
    for (const n of ["LeftArm", "LeftForeArm", "LeftHand"]) rot[INDEX.get(n)] = up;
    const pose = M.somaToPose(rot, [0, 1, 0], INDEX, rest, M.motionScale(rest));
    const dir = v3.norm(v3.sub(head(pose.get("LeftHand")), head(pose.get("LeftArm"))));
    near(dir, [Math.SQRT1_2, Math.SQRT1_2, 0], 1e-6);
    // The model's arm that hangs in its T-pose is out sideways on the character too.
    const rh = head(pose.get("RightHand"));
    assert.ok(rh[0] < -0.69 && Math.abs(rh[1] - 1.5) < 0.1, `right hand at ${rh}`);
});

test("in-between keys: model frames from the first key, positions from where it starts", () => {
    const sk = skeleton();
    const rest = M.humanoidRest(sk, roles(sk));
    const p0 = posed(sk, {}), p1 = posed(sk, { Hips: quat.axisAngle([0, 1, 0], deg(90)) });
    for (const [n, m] of p1) p1.set(n, mat4.mul(mat4.compose([1, 0, 2], [0, 0, 0, 1], [1, 1, 1]), m));
    const k = M.inbetweenKeys([{ f: 10, pose: p0 }, { f: 34, pose: p1 }], rest, 1, 24);
    assert.deepEqual(k.keys.map((x) => x.frame), [0, 30]);
    assert.equal(k.frames, 31);
    near(k.keys[0].root, [0, 0.98, 0], 1e-9);
    near(k.keys[1].root, [1, 0.98, 2], 1e-9);
    near(k.heading, 0, 1e-4);
    near(M.headingOf(k.keys[1]), deg(90), 1e-5);
});

test("a standing foot that slides is pinned, a foot under the floor is lifted, and the legs keep their length", () => {
    const sk = skeleton();
    const rest = M.humanoidRest(sk, roles(sk));
    const frames = [];
    for (let f = 0; f < 12; f++) {
        // The hips drift forward; the left foot skates with them over the floor; the right one sinks in at frame 6.
        const pose = posed(sk, {});
        const move = mat4.compose([0, 0, 0.004 * f], [0, 0, 0, 1], [1, 1, 1]);
        for (const [n, m] of pose) pose.set(n, mat4.mul(move, m));
        if (f === 6) for (const n of ["RightFoot", "RightToeBase"]) {
            const m = pose.get(n).slice(); m[13] -= 0.05; pose.set(n, m);
        }
        frames.push({ f, pose });
    }
    const report = M.cleanFeet(frames, rest, { blend: 0 });
    assert.ok(report.pinned > 0 && report.lifted > 0, JSON.stringify(report));
    const z = frames.map((fr) => fr.pose.get("LeftFoot")[14]);
    for (const v of z) near(v, z[0], 1e-4, "left foot pinned");
    for (const fr of frames) {
        near(v3.dist(head(fr.pose.get("LeftUpLeg")), head(fr.pose.get("LeftLeg"))), Math.hypot(0.43, 0.01), 1e-6, "thigh");
        near(v3.dist(head(fr.pose.get("LeftLeg")), head(fr.pose.get("LeftFoot"))), Math.hypot(0.43, 0.01), 1e-6, "shin");
        assert.ok(fr.pose.get("RightToeBase")[13] >= 0.02 - 1e-6, `right toe at ${fr.pose.get("RightToeBase")[13]}`);
    }
});

test("motion frames are resampled onto the scene's rate", () => {
    const sample = { rot: [[[0, 0, 0, 1]], [quat.axisAngle([0, 1, 0], deg(90))]], root: [[0, 0, 0], [3, 0, 0]], contacts: null };
    const out = M.resample(sample, 60, 5, 3);
    assert.deepEqual(out.map((x) => x.f), [5, 6, 7]);
    near(out[1].root, [1.5, 0, 0], 1e-9);
    near(out[1].rot[0], quat.axisAngle([0, 1, 0], deg(45)), 1e-9);
    near(out[2].root, [3, 0, 0], 1e-9);
});
