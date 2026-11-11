// node --test tests/test_rig_extras.mjs
// The rigging extras' data and maths (imageViewer_rigExtras.js, imageViewer_rigDrivers.js and the
// extra channels of imageViewer_scene3d.js): poses, the mirror, spaces, set-driven keys, faces.
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../js/imageViewer_rigData.js";
import * as S from "../js/imageViewer_scene3d.js";
import * as X from "../js/imageViewer_rigExtras.js";
import * as D from "../js/imageViewer_rigDrivers.js";

const { mat4, quat } = R;
const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};

const BONES = [
    ["Hips", null, [0, 1, 0]], ["Spine", "Hips", [0, 1.1, 0]], ["Spine2", "Spine", [0, 1.4, 0]],
    ["Neck", "Spine2", [0, 1.55, 0]], ["Head", "Neck", [0, 1.65, 0]], ["HeadTop_End", "Head", [0, 1.85, 0]],
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
const skeleton = () => ({ bones: BONES.map(([n, p, h]) => ({ name: n, parent: p, world: mat4.compose(h, [0, 0, 0, 1], [1, 1, 1]) })) });

function riggedScene() {
    const model = { id: "m1", kind: "model", name: "Hero", parent: null, position: [0, 0, 0], rotation: [0, 0, 0],
                    scale: [1, 1, 1], pivot: [0, 0, 0], visible: true, tracks: {}, src: { filename: "hero.glb" } };
    const rig = R.buildRig(model, skeleton());
    const scene = S.makeScene({ items: [model, rig.group, ...rig.items] });
    return { scene, model, rig };
}
const ctrl = (scene, pred) => scene.items.find((c) => c.kind === "control" && pred(c.control, c));

test("extra channels: custom attributes and blendshapes key, hold their ranges and survive the file", () => {
    const { scene, model } = riggedScene();
    const hand = ctrl(scene, (k) => k.type === "ik" && k.role === "arm.L");
    hand.attrs = { fist: { value: 0, min: 0, max: 10 } };
    S.setStaticValue(hand, "attr:fist", 42);
    assert.equal(S.valueAt(hand, "attr:fist", 0), 10, "held to max");
    S.setKeyframe(hand, "attr:fist", 0, 0, "linear");
    S.setKeyframe(hand, "attr:fist", 10, 10, "linear");
    near(S.valueAt(hand, "attr:fist", 5), 5);
    S.setStaticValue(model, "bs:jawOpen", 1.7);
    assert.equal(model.blendshapes.jawOpen, 1);
    S.setKeyframe(model, "bs:mouthSmileLeft", 4, 0.5);
    assert.deepEqual(S.trackProps(model).filter(S.isExtraProp), ["bs:mouthSmileLeft"]);
    assert.ok(S.keyframeFrames(model).includes(4));
    const at = S.evaluate(model, 4);
    assert.equal(at["bs:jawOpen"], 1);
    assert.equal(at["bs:mouthSmileLeft"], 0.5);
    const back = S.parseScene(S.serializeScene(scene));
    const h2 = back.items.find((i) => i.id === hand.id);
    assert.deepEqual(h2.attrs.fist, { value: 10, min: 0, max: 10 });
    assert.equal(h2.tracks["attr:fist"].length, 2);
    const m2 = back.items.find((i) => i.id === "m1");
    assert.equal(m2.blendshapes.jawOpen, 1);
    assert.equal(S.valueAt(m2, "bs:mouthSmileLeft", 4), 0.5);
    S.removeKeyframe(m2, 4);
    assert.equal(S.trackProps(m2).filter(S.isExtraProp).length, 0);
    // Not every prop with a colon is ours: another module's extra channel still keys and parses.
    S.setKeyframe(m2, "cw:c1:t2", 0, 0.25);
    assert.equal(S.parseScene(S.serializeScene(back)).items.find((i) => i.id === "m1").tracks["cw:c1:t2"][0].v, 0.25);
});

test("a pose is captured by what each control drives and put back at any weight", () => {
    const { scene } = riggedScene();
    const arm = ctrl(scene, (k) => k.type === "fk" && k.bone === "LeftArm");
    const ik = ctrl(scene, (k) => k.type === "ik" && k.role === "arm.L");
    arm.rotation = [0, 0, -60];
    ik.ikfk = 0;
    const pose = X.capturePose(scene, "m1", 0);
    assert.deepEqual(pose.controls["fk:LeftArm"].rotation, [0, 0, -60]);
    assert.equal(pose.controls["ik:arm.L"].ikfk, 0);
    assert.equal(pose.controls["fk:LeftArm"].role, "upperArm.L");
    arm.rotation = [0, 0, 0];
    ik.ikfk = 1;
    const half = X.poseWrites(scene, "m1", pose, 0, { blend: 0.5 });
    const rot = half.writes.find((w) => w.id === arm.id && w.prop === "rotation").value;
    near(rot, [0, 0, -30], 1e-6);
    near(half.writes.find((w) => w.id === ik.id && w.prop === "ikfk").value, 0.5);
    assert.equal(half.missing.length, 0);
    // Limited to some controls: only those are written.
    const only = X.poseWrites(scene, "m1", pose, 0, { ids: [arm.id] });
    assert.ok(only.writes.every((w) => w.id === arm.id));
    // Onto another humanoid with other bone names: FK found by its role.
    const { scene: other } = riggedScene();
    for (const c of other.items) if (c.control && c.control.bone) c.control.bone = `mixamorig${c.control.bone}`;
    const onto = X.poseWrites(other, "m1", pose, 0);
    const a2 = ctrl(other, (k) => k.type === "fk" && k.bone === "mixamorigLeftArm");
    near(onto.writes.find((w) => w.id === a2.id && w.prop === "rotation").value, [0, 0, -60]);
});

test("rotations blend the short way, through quaternions", () => {
    near(X.blendRotation([0, 0, 170], [0, 0, -170], 0.5), [0, 0, 180], 1e-6);
    const q = quat.fromEulerDeg(X.blendRotation([0, 0, 170], [0, 0, -170], 0.5));
    near(Math.abs(q[2]), 1, 1e-9);
});

test("the mirror: the left arm's turn goes to the right, the spine's bend is reflected", () => {
    const sk = skeleton();
    const rest = new Map(sk.bones.map((b) => [b.name, b.world]));
    const pose = new Map(rest);
    // The left arm raised 40° (about +Z at the shoulder), the spine leaning to the character's left.
    const turn = (bone, q) => {
        const r = rest.get(bone);
        const p = [r[12], r[13], r[14]];
        return mat4.mul(mat4.mul(mat4.compose(p, q, [1, 1, 1]), mat4.compose(p.map((x) => -x), [0, 0, 0, 1], [1, 1, 1])), r);
    };
    const up = quat.fromEulerDeg([0, 0, 40]);
    pose.set("LeftArm", turn("LeftArm", up));
    pose.set("Spine", turn("Spine", quat.fromEulerDeg([0, 0, -10])));
    const out = X.flipBonesPose(pose, rest);
    // The right arm now turns -40° about Z (raised on its own side), the left is at rest.
    const dRight = mat4.decompose(mat4.mul(out.get("RightArm"), mat4.invert(rest.get("RightArm")))).q;
    near(quat.toEulerDeg(dRight), [0, 0, -40], 1e-6);
    near(mat4.decompose(out.get("LeftArm")).q, [0, 0, 0, 1], 1e-9);
    const dSpine = mat4.decompose(mat4.mul(out.get("Spine"), mat4.invert(rest.get("Spine")))).q;
    near(quat.toEulerDeg(dSpine), [0, 0, 10], 1e-6);
    // Flipping twice gives the pose back.
    const twice = X.flipBonesPose(out, rest);
    for (const [b, m] of pose) near(twice.get(b), m, 1e-9, b);
    assert.equal(X.flipName("mixamorigLeftHand"), "mixamorigRightHand");
    assert.equal(X.flipName("hand_l"), "hand_r");
    assert.equal(X.flipName("arm.L"), "arm.R");
});

test("spaces: a control in another space stays put at rest and follows its target", () => {
    const { scene } = riggedScene();
    const hand = ctrl(scene, (k) => k.type === "ik" && k.role === "arm.L");
    const head = ctrl(scene, (k) => k.type === "fk" && k.role === "head");
    const cands = X.spaceCandidates(scene, hand).map((s) => s.name);
    assert.ok(cands.includes("World") && cands.includes("COG") && cands.includes("Head") && cands.includes("Chest"), cands.join());
    assert.ok(!cands.includes("Root"), "its own parent is not a candidate");
    hand.control.spaces = [head.id];
    // Worlds as the view would have them, from the data: rest worlds, the head turned 90° about Y.
    const turned = mat4.mul(X.restWorld(scene, head.id), mat4.compose([0, 0, 0], quat.fromEulerDeg([0, 90, 0]), [1, 1, 1]));
    const worldOf = (headWorld) => (id) => (id === head.id ? headWorld : X.restWorld(scene, id));
    // At rest it sits exactly where its own rest puts it.
    near(X.spaceRestMatrix(scene, hand, 1, worldOf(X.restWorld(scene, head.id))), hand.rest, 1e-9);
    // With the head turned it is carried round the head.
    const top = X.spaceRestMatrix(scene, hand, 1, worldOf(turned));
    const P = X.restWorld(scene, hand.parent);
    const w = mat4.mul(P, top);
    const headPos = X.restWorld(scene, head.id);
    const rel = [w[12] - headPos[12], w[13] - headPos[13], w[14] - headPos[14]];
    // Hand at (0.72, 1.5, 0), head at (0, 1.65, 0): 0.72 along +X turns to -Z.
    near(rel, [0, -0.15, -0.72], 1e-9);
    // Switching keeps it where it is: channels in the new space give the same world.
    const now = mat4.mul(P, mat4.mul(hand.rest, mat4.fromChannels([0.1, 0.2, 0.3], [10, 20, 30], [1, 1, 1])));
    const ch = X.channelsInSpace(scene, hand, 1, now, worldOf(turned));
    const back = mat4.mul(mat4.mul(P, top), mat4.fromChannels(ch.position, ch.rotation, [1, 1, 1]));
    near(back, now, 1e-9);
    // The space channel keys as a held number and goes through the file.
    S.setKeyframe(hand, "space", 0, 0, "hold");
    S.setKeyframe(hand, "space", 12, 1, "hold");
    assert.equal(X.spaceAt(scene, hand, 11), 0);
    assert.equal(X.spaceAt(scene, hand, 12), 1);
    const again = S.parseScene(S.serializeScene(scene)).items.find((i) => i.id === hand.id);
    assert.deepEqual(again.control.spaces, [head.id]);
    assert.equal(again.tracks.space[1].v, 1);
});

test("set-driven keys: a curve from the driver's channel, added to the driven one, chained and clamped", () => {
    const { scene, model } = riggedScene();
    const hand = ctrl(scene, (k) => k.type === "ik" && k.role === "arm.L");
    const finger = ctrl(scene, (k) => k.type === "fk" && k.bone === "LeftHandMiddle1");
    hand.attrs = { fist: { value: 0, min: 0, max: 10 } };
    finger.drivers = [{ prop: "rotation", axis: 2, driver: { id: hand.id, prop: "attr:fist", axis: null },
                        keys: [{ x: 0, v: 0 }, { x: 10, v: -90 }], ease: "linear", rest: 0 }];
    finger.rotation = [0, 0, 5];
    S.setStaticValue(hand, "attr:fist", 5);
    near(X.evaluateDriven(scene, finger, 0).rotation, [0, 0, -40]);
    near(X.drivenPart(scene, finger, "rotation", 0), [0, 0, -45]);
    // Beyond the last key it holds.
    hand.attrs.fist.max = 100;
    S.setStaticValue(hand, "attr:fist", 50);
    near(X.evaluateDriven(scene, finger, 0).rotation[2], -85);
    // A blendshape driven by the finger's rotation (a chain), held to 0..1.
    model.drivers = D.readDrivers([{ prop: "bs:jawOpen", driver: { id: finger.id, prop: "rotation", axis: 2 },
                                     keys: [{ x: 0, v: 0 }, { x: -45, v: 1 }] }]);
    assert.equal(X.evaluateDriven(scene, model, 0)["bs:jawOpen"], 1);
    S.setStaticValue(hand, "attr:fist", 0);
    near(X.evaluateDriven(scene, model, 0)["bs:jawOpen"], 0);          // finger at +5: the curve holds 0
    // A loop does not hang.
    hand.drivers = [{ prop: "attr:fist", axis: null, driver: { id: finger.id, prop: "rotation", axis: 2 }, keys: [{ x: 0, v: 1 }], ease: "linear" }];
    assert.ok(Number.isFinite(X.evaluateDriven(scene, model, 0)["bs:jawOpen"]));
    // The file keeps them, and drops what cannot be read.
    const back = S.parseScene(S.serializeScene(scene));
    const f2 = back.items.find((i) => i.id === finger.id);
    assert.equal(f2.drivers.length, 1);
    assert.equal(f2.drivers[0].keys[1].v, -90);
    assert.deepEqual(D.readDrivers([{ prop: "nonsense" }, { prop: "rotation", driver: { id: "x", prop: "position" }, keys: [] }]), []);
    // A key at the same driver value replaces the old one.
    const d = { keys: [{ x: 0, v: 0 }] };
    D.setDriverKey(d, 0, 3); D.setDriverKey(d, 1, 4);
    assert.deepEqual(d.keys, [{ x: 0, v: 3 }, { x: 1, v: 4 }]);
    near(D.curveAt(d.keys, 0.5, "smooth"), 3.5);
    near(D.curveAt(d.keys, 0.25, "smooth"), 3 + (0.25 * 0.25 * (3 - 0.5)));
});

test("facial controls: joysticks find ARKit blendshapes however they are spelt, and drive them", () => {
    const { scene, model } = riggedScene();
    const head = ctrl(scene, (k) => k.type === "fk" && k.role === "head");
    const morphs = ["jawOpen", "Mouth_Smile_L", "mouthSmile_R", "eyeBlinkLeft", "eyeBlink_R", "browInnerUp", "tongueOut"];
    assert.equal(X.findMorph(morphs, "mouthSmileLeft"), "Mouth_Smile_L");
    assert.equal(X.findMorph(morphs, "mouthSmileRight"), "mouthSmile_R");
    assert.equal(X.findMorph(["blendShape1.jawOpen"], "jawOpen"), "blendShape1.jawOpen");
    const face = X.buildFaceRig(scene, model, morphs, { parentId: head.id, head: [0, 1.65, 0], height: 1.85 });
    assert.equal(face.items[0].control.face, "board");
    assert.ok(face.used.includes("jawOpen") && face.used.includes("Mouth_Smile_L") && face.used.includes("browInnerUp"));
    assert.deepEqual(face.unused, ["tongueOut"]);
    scene.items.push(...face.items);
    model.drivers = face.drivers;
    const jaw = face.items.find((i) => i.control.face === "jaw");
    // The board sits beside the head, in the model's axes whatever the head bone's.
    const w = mat4.mul(X.restWorld(scene, head.id), face.items[0].rest);
    assert.ok(w[12] > 0.2 && Math.abs(w[13] - 1.65) < 1e-9, `board at ${w[12]}, ${w[13]}`);
    jaw.position = [0, -face.cell, 0];
    near(X.evaluateDriven(scene, model, 0)["bs:jawOpen"], 1);
    jaw.position = [0, -face.cell / 2, 0];
    near(X.evaluateDriven(scene, model, 0)["bs:jawOpen"], 0.5);
    jaw.position = [0, face.cell, 0];
    near(X.evaluateDriven(scene, model, 0)["bs:jawOpen"], 0);
    // In a pose: the face controls come along, and the blendshapes.
    S.setStaticValue(model, "bs:tongueOut", 0.3);
    const pose = X.capturePose(scene, "m1", 0);
    assert.ok(pose.controls["face:jaw"]);
    assert.equal(pose.blendshapes.tongueOut, 0.3);
    // A face control round-trips through the file.
    const back = S.parseScene(S.serializeScene(scene));
    assert.equal(back.items.find((i) => i.id === jaw.id).control.type, "face");
    assert.equal(back.items.find((i) => i.id === jaw.id).control.face, "jaw");
});
