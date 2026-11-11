// node --test tests/test_rig_live.mjs
// The rig carried in an FBX / USD and motion brought back from one (imageViewer_rigLive.js), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../js/imageViewer_rigLive.js";
import { mat4, quat } from "../js/imageViewer_rigData.js";

const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};

function scene() {
    return {
        items: [
            { id: "m1", kind: "model", name: "Hero" },
            { id: "m2", kind: "model", name: "Twin" },
            { id: "g1", kind: "group", parent: "m1", rig: { model: "m1" } },
            { id: "c1", kind: "control", parent: "g1", control: { model: "m1", type: "cog" }, tracks: { position: [{ f: 0, v: [0, 0, 0] }] } },
            { id: "c2", kind: "control", parent: "c1", control: { model: "m1", type: "fk", bone: "arm" }, tracks: {} },
            { id: "k1", kind: "constraint", target: "c2", driven: "box" },                // names a control: part of the rig
            { id: "box", kind: "primitive", constraint: { to: "m1", bone: "hand" } },     // names only the model: a prop
            { id: "g2", kind: "group", parent: "m2", rig: { model: "m2" } },
            { id: "d1", kind: "control", parent: "g2", control: { model: "m2", type: "cog" }, tracks: {} },
        ],
    };
}

test("the rig is its group, its controls and what names them, not a prop on the model", () => {
    assert.deepEqual(L.rigItems(scene(), "m1").map((it) => it.id), ["g1", "c1", "c2", "k1"]);
    assert.deepEqual(L.rigItems(scene(), "m2").map((it) => it.id), ["g2", "d1"]);
    assert.deepEqual(L.rigItems(scene(), "nope"), []);
});

test("the rig goes out and comes back as it was, with the parts registered", () => {
    const saved = [];
    L.registerRigLivePart("test.layers", {
        save: (panel, modelId) => (modelId === "m1" ? { on: ["c2"], panel: !!panel } : null),
        load: (panel, modelId, json, remap) => saved.push({ modelId, json, c2: remap("c2") }),
    });
    const sc = scene();
    const live = L.collectRigLive(sc, "m1", { bones: ["hips", "arm"], panel: {}, range: [0, 24], fps: 24 });
    assert.equal(live.kind, "imageviewer.rig");
    assert.deepEqual(live.parts["test.layers"], { on: ["c2"], panel: true });
    // Changed in the viewer since, then brought back: the rig is the file's again.
    sc.items.find((it) => it.id === "c1").tracks = {};
    sc.items = sc.items.filter((it) => it.id !== "k1");
    const { items } = L.restoreRigLive(sc, "m1", JSON.parse(JSON.stringify(live)), { newId: () => "new" });
    assert.deepEqual(items.map((it) => it.id), ["g1", "c1", "c2", "k1"]);
    assert.deepEqual(sc.items.find((it) => it.id === "c1").tracks.position, [{ f: 0, v: [0, 0, 0] }]);
    assert.equal(sc.items.filter((it) => it.id === "c1").length, 1);
    assert.ok(sc.items.find((it) => it.id === "d1"), "the other character's rig stays");
    assert.deepEqual(saved, [{ modelId: "m1", json: { on: ["c2"], panel: true }, c2: "c2" }]);
});

test("onto another copy of the character: its own model id, and new ids where the first copy's are taken", () => {
    const sc = scene();
    const live = L.collectRigLive(sc, "m1", { bones: ["arm"] });
    let n = 0;
    const { items, remap } = L.restoreRigLive(sc, "m2", live, { newId: () => `x${++n}` });
    // m2's own rig (g2, d1) is replaced; m1's stays and keeps its ids.
    assert.ok(!sc.items.find((it) => it.id === "g2"));
    for (const id of ["g1", "c1", "c2", "k1"]) assert.equal(sc.items.filter((it) => it.id === id).length, 1, id);
    assert.equal(items.length, 4);
    const g = items.find((it) => it.kind === "group");
    assert.equal(g.parent, "m2");
    assert.equal(g.rig.model, "m2");
    const c2 = items.find((it) => it.control && it.control.bone === "arm");
    assert.equal(c2.control.model, "m2");
    assert.equal(c2.parent, remap("c1"));
    assert.equal(items.find((it) => it.kind === "constraint").target, c2.id);
    assert.notEqual(c2.id, "c2");
});

test("a rig only comes back onto its skeleton", () => {
    const live = L.collectRigLive(scene(), "m1", { bones: ["hips", "arm"] });
    assert.equal(L.canRestore(live, ["hips", "arm", "hand"]).ok, true);
    assert.equal(L.canRestore(live, ["hips"]).ok, false);
    assert.equal(L.canRestore(null, ["hips"]).ok, false);
    assert.equal(L.canRestore({ ...live, v: 99 }, ["hips", "arm"]).ok, false);
});

// A chain: hips at 1 m, spine above, arm out along +X.
const REST = [
    { name: "mixamorig:Hips", parent: null, world: mat4.compose([0, 1, 0], [0, 0, 0, 1], [1, 1, 1]) },
    { name: "mixamorig:Spine", parent: "mixamorig:Hips", world: mat4.compose([0, 1.2, 0], [0, 0, 0, 1], [1, 1, 1]) },
    { name: "mixamorig:LeftArm", parent: "mixamorig:Spine", world: mat4.compose([0.2, 1.4, 0], [0, 0, 0, 1], [1, 1, 1]) },
    { name: "mixamorig:LeftHand", parent: "mixamorig:LeftArm", world: mat4.compose([0.7, 1.4, 0], [0, 0, 0, 1], [1, 1, 1]) },
];

function animate(rest, frames) {
    // Hips walk +Z, the arm swings down about Z: local rotations composed down the chain.
    const bones = rest.map((b) => ({ name: b.name, parent: b.parent }));
    const restW = new Map(rest.map((b) => [b.name, b.world]));
    return frames.map((f) => {
        const locals = new Map();
        for (const b of rest) {
            const p = b.parent ? restW.get(b.parent) : mat4.identity();
            let l = mat4.mul(mat4.invert(p), b.world);
            if (b.name.endsWith("Hips")) l = mat4.mul(mat4.compose([0, 0, 0.1 * f], [0, 0, 0, 1], [1, 1, 1]), l);
            if (b.name.endsWith("LeftArm")) l = mat4.mul(l, mat4.compose([0, 0, 0], quat.axisAngle([0, 0, 1], -0.1 * f), [1, 1, 1]));
            locals.set(b.name, l);
        }
        return { f, worlds: L.worldsFromLocals(bones, locals) };
    });
}

test("the same skeleton back: every bone where it was", () => {
    const frames = animate(REST, [0, 5, 10]);
    const match = L.matchBones(REST.map((b) => b.name), REST.map((b) => b.name));
    const out = L.retarget({ bones: REST, frames }, { bones: REST }, match);
    for (let i = 0; i < frames.length; i++) {
        for (const b of REST) near(out[i].pose.get(b.name), frames[i].worlds.get(b.name), 1e-9, `${b.name}@${frames[i].f}`);
    }
});

test("another skeleton: names matched, twice the size, its own lengths kept", () => {
    const big = REST.map((b) => ({ name: b.name.replace("mixamorig:", "").replace("LeftArm", "Left_Arm"),
                                   parent: b.parent && b.parent.replace("mixamorig:", "").replace("LeftArm", "Left_Arm"),
                                   world: mat4.compose(mat4.decompose(b.world).p.map((v) => v * 2), [0, 0, 0, 1], [1, 1, 1]) }));
    const match = L.matchBones(REST.map((b) => b.name), big.map((b) => b.name));
    assert.equal(match.size, 4);
    assert.equal(match.get("Left_Arm"), "mixamorig:LeftArm");
    const frames = animate(REST, [10]);
    const [out] = L.retarget({ bones: REST, frames }, { bones: big }, match);
    near(out.pose.get("Hips").slice(12, 15), [0, 2, 2], 1e-9, "hips move twice as far");          // 0.1 m x 10 x 2
    const hand = out.pose.get("LeftHand").slice(12, 15), arm = out.pose.get("Left_Arm").slice(12, 15);
    near(Math.hypot(hand[0] - arm[0], hand[1] - arm[1], hand[2] - arm[2]), 1.0, 1e-9, "its own arm length");
    near(Math.atan2(hand[1] - arm[1], hand[0] - arm[0]), -1.0, 1e-9, "the arm swung the source's -1 rad");
});

test("unmatched bones follow their parents at rest", () => {
    const dst = [...REST, { name: "Prop", parent: "mixamorig:LeftHand", world: mat4.compose([0.8, 1.4, 0], [0, 0, 0, 1], [1, 1, 1]) }];
    const frames = animate(REST, [10]);
    const [out] = L.retarget({ bones: REST, frames }, { bones: dst }, L.matchBones(REST.map((b) => b.name), dst.map((b) => b.name)));
    const hand = out.pose.get("mixamorig:LeftHand"), prop = out.pose.get("Prop");
    near(mat4.mul(mat4.invert(hand), prop).slice(12, 15), [0.1, 0, 0], 1e-9);
});

test("the fingerprint notices a changed motion, not float noise", () => {
    const frames = animate(REST, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]).map((fr) => ({ f: fr.f, pose: fr.worlds }));
    const fp = L.fingerprint(frames, { bones: 3, frames: 4 });
    assert.equal(fp.frames.length, 4);
    assert.equal(fp.bones.length, 3);
    const noisy = frames.map((fr) => ({ f: fr.f, pose: new Map([...fr.pose].map(([n, m]) => [n, m.map((v) => v + 1e-6)])) }));
    assert.equal(L.sameFingerprint(fp, noisy, 1e-3), true);
    const moved = frames.map((fr) => ({ f: fr.f, pose: new Map([...fr.pose].map(([n, m]) => [n, fr.f === 15 ? m.map((v, i) => (i === 13 ? v + 0.05 : v)) : m])) }));
    assert.equal(L.sameFingerprint(fp, moved, 1e-3), false);
    assert.equal(L.sameFingerprint(fp, frames.slice(0, 3), 1e-3), false, "a frame missing");
});

test("names compared without namespaces and prefixes", () => {
    assert.equal(L.boneKey("mixamorig:LeftArm"), "leftarm");
    assert.equal(L.boneKey("Character1|Left_Arm"), "leftarm");
    assert.equal(L.boneKey("mixamorigLeftArm"), "leftarm");
});

test("a Z-up file turned Y up", () => {
    near(mat4.point(L.Z_UP_TO_Y_UP, [0, 0, 1]), [0, 1, 0], 1e-12);
    near(mat4.point(L.Z_UP_TO_Y_UP, [0, 1, 0]), [0, 0, -1], 1e-12);
});
