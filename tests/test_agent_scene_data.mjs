// node --test tests/test_agent_scene_data.mjs
// The arithmetic of the agent's scene actions (imageViewer_agentSceneData.js): clip frames,
// picking clips, a turntable's keys per range, the scene description.
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_scene3d.js";
import * as A from "../js/imageViewer_agentSceneData.js";

const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};

const seq = () => ({
    v: 1,
    sources: [{ id: "s1", name: "Walk", length: 24, made: "ai", model: "m1" }, { id: "s2", name: "Wave", length: 12, made: "keys", model: "m1" }],
    tracks: [
        { id: "t1", name: "Track 1", weight: 1, mode: "override", clips: [
            { id: "c2", source: "s2", name: "", start: 30, length: 12, speed: 1 },
            { id: "c1", source: "s1", name: "Hero walk", start: 0, length: 24, speed: 1 },
        ] },
        { id: "t2", name: "Muted", mute: true, weight: 1, mode: "override", clips: [{ id: "c3", source: "s1", start: 50, length: 10 }] },
    ],
});

test("a clip's frames are the ones it lies over, both ends shown", () => {
    assert.deepEqual(A.clipFrames({ start: 0, length: 48 }), { from: 0, to: 48 });
    assert.deepEqual(A.clipFrames({ start: 10, length: 0.5 }), { from: 10, to: 10 });
    assert.deepEqual(A.clipFrames({ start: 4, length: 10.5 }), { from: 4, to: 14 });
});

test("pickClips: all live clips in time order, or by name / source name / id", () => {
    const q = seq();
    const all = A.pickClips(q, "all");
    assert.deepEqual(all.clips.map((c) => [c.id, c.name, c.from, c.to]), [["c1", "Hero walk", 0, 24], ["c2", "Wave", 30, 42]]);
    assert.deepEqual(all.missing, []);
    const some = A.pickClips(q, ["wave", "c3", "nope"]);
    assert.deepEqual(some.clips.map((c) => c.id), ["c2", "c3"], "a muted clip is taken when named");
    assert.deepEqual(some.missing, ["nope"]);
    assert.equal(A.pickClips(q, ["Walk"]).clips[0].id, "c3", "a clip with no name of its own goes by its source's");
    assert.equal(A.pickClips(q, ["hero walk"]).clips[0].id, "c1");
});

test("fitDistance sees the whole sphere", () => {
    const d = A.fitDistance(1, 90, 1, 1);
    near(d, 1 / Math.sin(Math.PI / 4), 1e-9);
    assert.ok(A.fitDistance(1, 35) > A.fitDistance(1, 60));
});

test("a turntable range turns a full circle less one step, held at its ends", () => {
    const sub = { center: [1, 1, 2], radius: 1 };
    const k = A.turntableRange(sub, 10, 33, { degrees: 360, fov: 40, aspect: 16 / 9 });
    const rot = k.pivot.rotation;
    assert.deepEqual(rot[0], { f: 10, v: [0, 0, 0], ease: "linear" });
    const last = rot[rot.length - 1];
    assert.equal(last.f, 33);
    near(last.v[1], 360 * 23 / 24, 1e-3);
    assert.equal(last.ease, "hold");
    for (let i = 1; i < rot.length; i++) assert.ok(rot[i].v[1] - rot[i - 1].v[1] <= 90 + 1e-9, "never more than 90 degrees apart");
    const pivot = S.makeGroupItem("p");
    S.setTrack(pivot, "rotation", rot);
    for (let f = 10; f <= 33; f++) near(S.valueAt(pivot, "rotation", f)[1], 15 * (f - 10), 1e-3, `an even turn at ${f}`);
    assert.deepEqual(k.pivot.position, [{ f: 10, v: [1, 1, 2], ease: "hold" }]);
    near(k.distance, A.fitDistance(1, 40, 16 / 9), 1e-3);
    near(k.height, k.distance * 0.2, 1e-3);
    // The camera stands back and up and looks down at the centre.
    const [cp] = k.cam.position, [cr] = k.cam.rotation;
    near(cp.v, [0, k.height, k.distance], 1e-3);
    near(cr.v[0], -Math.atan2(k.height, k.distance) * 180 / Math.PI, 1e-3);
    const fixed = A.turntableRange(sub, 0, 0, { distance: 5, height: 0, look_height: 0.5, start_yaw: 90 });
    assert.deepEqual(fixed.pivot.rotation, [{ f: 0, v: [0, 90, 0], ease: "hold" }]);
    assert.deepEqual(fixed.pivot.position[0].v, [1, 1.5, 2]);
    assert.equal(fixed.cam.rotation[0].v[0], 0);
});

test("two ranges on one rig: each shows its own turn, the keys merge", () => {
    const pivot = S.makeGroupItem("Turntable");
    for (const [a, b] of [[0, 23], [30, 41]]) {
        const k = A.turntableRange({ center: [0, 1, 0], radius: 1 }, a, b, {});
        const list = (S.baseTrack(pivot, "rotation") || []).filter((x) => x.f < a || x.f > b);
        S.setTrack(pivot, "rotation", A.mergeKeys(list, k.pivot.rotation));
    }
    const fs = S.baseTrack(pivot, "rotation").map((k) => k.f);
    assert.ok(fs.includes(0) && fs.includes(23) && fs.includes(30) && fs.includes(41) && !fs.some((f) => f > 23 && f < 30), fs.join());
    near(S.valueAt(pivot, "rotation", 0)[1], 0);
    near(S.valueAt(pivot, "rotation", 12)[1], 360 * 23 / 24 * 12 / 23, 1e-3, "linear through the range");
    near(S.valueAt(pivot, "rotation", 27)[1], 360 * 23 / 24, 1e-3, "held between the ranges");
    near(S.valueAt(pivot, "rotation", 30)[1], 0);
    near(S.valueAt(pivot, "rotation", 41)[1], 360 * 11 / 12, 1e-3);
});

test("sphereOf and sampleFrames", () => {
    const s = A.sphereOf([{ min: [0, 0, 0], max: [1, 2, 0] }, { min: [-1, 0, 0], max: [0, 1, 2] }]);
    near(s.center, [0, 1, 1]);
    near(s.radius, Math.hypot(2, 2, 2) / 2);
    assert.equal(A.sphereOf([]), null);
    assert.deepEqual(A.sampleFrames(0, 8, 5), [0, 2, 4, 6, 8]);
    assert.deepEqual(A.sampleFrames(3, 3, 9), [3]);
});

test("describeScene names cameras, models and clips, and counts controls", () => {
    const scene = S.makeScene({ fps: 25, length: 60 });
    const m = S.makeModelItem({ path: "hero.glb" }, "Hero");
    const cam = S.makeCameraItem("Shot cam", { fov: 40 });
    cam.tracks.position = [{ f: 0, v: [0, 0, 0] }, { f: 10, v: [1, 0, 0] }];
    scene.items.push(m, cam, { id: "k1", kind: "control", name: "hips", tracks: {}, control: { model: m.id } });
    scene.activeCamera = cam.id;
    scene.sequencer = seq();
    scene.animLayers = [{ id: "L1", name: "Fix", mode: "additive", weight: 0.5 }];
    const d = A.describeScene(scene);
    assert.equal(d.fps, 25);
    assert.equal(d.active_camera, "Shot cam");
    assert.equal(d.controls, 1);
    assert.deepEqual(d.items.map((i) => i.name), ["Hero", "Shot cam"]);
    assert.deepEqual(d.items[1].keys, { count: 2, first: 0, last: 10 });
    assert.equal(d.clips.tracks[0].clips[1].name, "Hero walk");
    assert.deepEqual(d.anim_layers, [{ id: "L1", name: "Fix", mode: "additive", weight: 0.5, mute: false, solo: false, lock: false }]);
});
