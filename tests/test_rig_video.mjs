// node --test tests/test_rig_video.mjs
// Motion from a film: landmarks solved into the motion model's joint turns (imageViewer_rigVideo.js),
// and restyle requests (imageViewer_rigMotion.js restyleRequest).
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../js/imageViewer_rigData.js";
import * as M from "../js/imageViewer_rigMotion.js";
import * as V from "../js/imageViewer_rigVideo.js";

const { quat, v3, mat4 } = R;
const near = (a, b, eps, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};
const deg = (d) => (d * Math.PI) / 180;
const T = M.SOMA_T;

/** The model's T-pose as MediaPipe would report it (y down, z away), with the hips at `hips` (canonical). */
function landmarks(turn = {}, hips = [0, 0, 0]) {
    const P = new Array(33).fill(null);
    const put = (i, p) => { P[i] = p; };
    const pts = {
        [V.LM.shoulderL]: T.LeftArm, [V.LM.shoulderR]: T.RightArm, [V.LM.elbowL]: T.LeftForeArm, [V.LM.elbowR]: T.RightForeArm,
        [V.LM.wristL]: T.LeftHand, [V.LM.wristR]: T.RightHand, [V.LM.indexL]: v3.add(T.LeftHand, [0.1, 0, 0.01]),
        [V.LM.pinkyL]: v3.add(T.LeftHand, [0.1, 0, -0.01]), [V.LM.indexR]: v3.add(T.RightHand, [-0.1, 0, 0.01]),
        [V.LM.pinkyR]: v3.add(T.RightHand, [-0.1, 0, -0.01]), [V.LM.hipL]: T.LeftLeg, [V.LM.hipR]: T.RightLeg,
        [V.LM.kneeL]: T.LeftShin, [V.LM.kneeR]: T.RightShin, [V.LM.ankleL]: T.LeftFoot, [V.LM.ankleR]: T.RightFoot,
        [V.LM.heelL]: v3.add(T.LeftFoot, [0, -0.04, -0.06]), [V.LM.heelR]: v3.add(T.RightFoot, [0, -0.04, -0.06]),
        [V.LM.toeL]: T.LeftToeBase, [V.LM.toeR]: T.RightToeBase,
        [V.LM.earL]: v3.add(T.Head, [0.07, 0.03, -0.02]), [V.LM.earR]: v3.add(T.Head, [-0.07, 0.03, -0.02]),
    };
    // the nose: ahead of the ears' middle, as far down as the head's rest pitch says
    const em = v3.scale(v3.add(pts[V.LM.earL], pts[V.LM.earR]), 0.5);
    pts[V.LM.nose] = v3.add(em, [0, -0.1 * Math.tan(0.27), 0.1]);
    for (const [i, p] of Object.entries(pts)) {
        let q = p;
        if (turn.fn) q = turn.fn(Number(i), q);
        q = v3.add(q, hips);
        put(Number(i), [q[0], -q[1], -q[2], 0.99]);
    }
    for (let i = 0; i < 33; i++) if (!P[i]) P[i] = [0, 0, 0, 0];
    return P;
}

test("the model's own T-pose solves to no turn at all", () => {
    const P = V.toCanonicalPoints(landmarks());
    const q = V.solvePose(P);
    for (const j of V.VIDEO_JOINTS) {
        const d = Math.abs(quat.norm(q[j])[3]);
        assert.ok(d > Math.cos(deg(4) / 2), `${j} turned ${(2 * Math.acos(Math.min(1, d)) * 180 / Math.PI).toFixed(1)}°`);
    }
});

test("an arm raised 45° in the film raises the model's arm 45°", () => {
    const up = quat.axisAngle([0, 0, 1], deg(45));
    const arm = new Set([V.LM.elbowL, V.LM.wristL, V.LM.indexL, V.LM.pinkyL]);
    const P = V.toCanonicalPoints(landmarks({ fn: (i, p) => (arm.has(i) ? v3.add(T.LeftArm, quat.rotate(up, v3.sub(p, T.LeftArm))) : p) }));
    const q = V.solvePose(P);
    const d = quat.rotate(q.LeftArm, v3.norm(v3.sub(T.LeftForeArm, T.LeftArm)));
    near(d, [Math.SQRT1_2, Math.SQRT1_2, 0], 1e-6);
    // the forearm stays straight along it
    const f = quat.rotate(q.LeftForeArm, v3.norm(v3.sub(T.LeftHand, T.LeftForeArm)));
    near(f, [Math.SQRT1_2, Math.SQRT1_2, 0], 1e-6);
});

test("a body turned 90° in the film turns the hips 90°", () => {
    const turn = quat.axisAngle([0, 1, 0], deg(90));
    const P = V.toCanonicalPoints(landmarks({ fn: (i, p) => quat.rotate(turn, p) }));
    const q = V.solvePose(P);
    near(M.headingOf({ joints: { Hips: q.Hips } }), deg(90), 1e-6);
});

test("a hidden arm keeps its turn from the frame before", () => {
    const P0 = V.toCanonicalPoints(landmarks());
    const q0 = V.solvePose(P0);
    const P1 = P0.map((p) => p.slice());
    P1[V.LM.elbowL][3] = 0.05;
    const q1 = V.solvePose(P1, q0);
    near(q1.LeftArm, q0.LeftArm, 1e-9);
});

test("a film's person walking across the picture travels across, sized to the model", () => {
    const W = 1000, H = 1000, fov = 50, focal = W / (2 * Math.tan((fov * Math.PI) / 360));
    const frames = [];
    for (let i = 0; i < 10; i++) {
        const world = landmarks();
        // the hips 4 m from the camera, moving 0.1 m to the picture's right each frame
        const proj = world.map((p) => {
            const c = [p[0] + 0.1 * i, p[1] + 0, 4 + p[2]];
            return [W / 2 + (focal * c[0]) / c[2], H / 2 + (focal * c[1]) / c[2]];
        }).map(([x, y]) => [x / W, y / H, 0, 0.99]);
        frames.push({ i, t: i / 25, world, image: proj });
    }
    const m = V.solveFilm({ fps: 25, width: W, height: H, frames }, { smooth: 0, fov });
    assert.equal(m.samples[0].rot.length, 10);
    assert.equal(m.fps, 25);
    const root = m.samples[0].root;
    // the person's own size is the model's here, so a scale of about 1
    near(root[9][0] - root[0][0], 0.9, 0.12, "across");
    near(root[9][2] - root[0][2], 0, 0.12, "depth");
    near(root[0][1], M.SOMA_HIPS, 0.06, "hips height");
});

test("film keys: a full-body key every few model frames, the path on every one", () => {
    const P = landmarks();
    const frames = Array.from({ length: 31 }, (_, i) => ({ i, world: P, image: null }));
    const m = V.solveFilm({ fps: 30, frames }, { smooth: 0 });
    const k = V.filmKeys(m, 6);
    assert.equal(k.frames, 31);
    assert.equal(k.path.frames.length, 31);
    assert.deepEqual(k.keys.map((x) => x.frame), [0, 6, 12, 18, 24, 30]);
    assert.ok(k.keys[0].joints.LeftArm.length === 4);
});

test("restyle keeps the path on every model frame and, medium, the hands and feet every half second", () => {
    const BONES = [["Hips", null, [0, 1, 0]], ["Spine", "Hips", [0, 1.1, 0]], ["Chest", "Spine", [0, 1.3, 0]],
        ["Neck", "Chest", [0, 1.5, 0]], ["Head", "Neck", [0, 1.6, 0]],
        ["LeftArm", "Chest", [0.2, 1.45, 0]], ["LeftForeArm", "LeftArm", [0.45, 1.45, 0]], ["LeftHand", "LeftForeArm", [0.7, 1.45, 0]],
        ["RightArm", "Chest", [-0.2, 1.45, 0]], ["RightForeArm", "RightArm", [-0.45, 1.45, 0]], ["RightHand", "RightForeArm", [-0.7, 1.45, 0]],
        ["LeftUpLeg", "Hips", [0.1, 0.95, 0]], ["LeftLeg", "LeftUpLeg", [0.1, 0.52, 0]], ["LeftFoot", "LeftLeg", [0.1, 0.08, 0]],
        ["RightUpLeg", "Hips", [-0.1, 0.95, 0]], ["RightLeg", "RightUpLeg", [-0.1, 0.52, 0]], ["RightFoot", "RightLeg", [-0.1, 0.08, 0]]];
    const sk = { bones: BONES.map(([n, p, h]) => ({ name: n, parent: p, world: mat4.compose(h, [0, 0, 0, 1], [1, 1, 1]) })) };
    const roles = R.matchHumanoid(sk.bones.map((b) => ({ name: b.name, parent: b.parent, head: [b.world[12], b.world[13], b.world[14]] }))).roles;
    const rest = M.humanoidRest(sk, roles);
    const poses = [];
    for (let f = 0; f < 49; f++) {
        const pose = new Map();
        const move = mat4.compose([0, 0, 0.05 * f], [0, 0, 0, 1], [1, 1, 1]);
        for (const b of sk.bones) pose.set(b.name, mat4.mul(move, b.world));
        poses.push({ f: 10 + f, pose });
    }
    const r = M.restyleRequest(poses, rest, 1, 24, "medium");
    assert.equal(r.frames, 61);
    assert.equal(r.path.frames[0], 0);
    assert.equal(r.path.frames[r.path.frames.length - 1], 60);
    near(r.path.xz[r.path.xz.length - 1], [0, 2.4], 1e-6);
    assert.equal(r.keys[0].frame, 0);
    assert.equal(r.keys[0].effectors, undefined, "the first key is the whole body");
    assert.ok(r.keys.slice(1).every((k) => k.effectors && k.effectors.includes("LeftFoot")));
    assert.deepEqual(r.keys.map((k) => k.frame), [0, 15, 30, 45, 60]);
    const loose = M.restyleRequest(poses, rest, 1, 24, "loose");
    assert.deepEqual(loose.keys.map((k) => k.frame), [0]);
    const close = M.restyleRequest(poses, rest, 1, 24, "close");
    assert.ok(close.keys.length >= 6 && close.keys.every((k) => !k.effectors));
});
