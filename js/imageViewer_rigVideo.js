// Motion from a film: a person's body landmarks, frame by frame (MediaPipe's Pose
// Landmarker, run by scripts/rig/video_pose_run.py), solved into the motion model's
// joint rotations, so the film's motion goes onto a character the way an AI motion
// does (imageViewer_rigMotion.js somaToPose, cleanFeet). Pure data, no three.js:
// tested in node (tests/test_rig_video.mjs).
//
// The landmarks come in metres about the hips' middle, x to the picture's right,
// y down, z away from the camera. A person facing the camera has their left side on
// the picture's right, so (x, -y, -z) is the canonical pose space: Y up, facing +Z,
// the left side at +X. Each bone is turned from its direction in the model's
// T-pose to the direction the film shows (the shortest turn, carried down the
// chain from its parent, so a limb does not twist on its own); the hips, the chest
// and the head get their whole turn from the hips' line, the shoulders' line and
// the ears and nose. Where the person stands comes from the picture: how big the
// torso is says how far away, where the hips are says where across (a camera that
// stands still is assumed).
//
// The maths is the textbook kind (bases, shortest-arc quaternions, slerp, a
// Gaussian), written for this file.

import { v3, quat } from "./imageViewer_rigData.js";
import { SOMA_T, SOMA_HIPS, MOTION_FPS } from "./imageViewer_rigMotion.js";

// MediaPipe's 33 body landmarks, by the numbers this file uses.
export const LM = {
    nose: 0, earL: 7, earR: 8, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
    pinkyL: 17, pinkyR: 18, indexL: 19, indexR: 20, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26,
    ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32,
};
const FEET = [LM.ankleL, LM.ankleR, LM.heelL, LM.heelR, LM.toeL, LM.toeR];

// The joints a film drives, parents first.
export const VIDEO_JOINTS = ["Hips", "Spine1", "Spine2", "Chest", "Neck1", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "RightLeg", "RightShin", "RightFoot", "RightToeBase"];

// Limbs: joint, parent joint (whose turn it starts from), the T-pose bone (from, to)
// and the landmarks of the bone in the film.
const LIMBS = [];
for (const [S, s] of [["Left", "L"], ["Right", "R"]]) {
    const x = S === "Left" ? 1 : -1;
    LIMBS.push(
        { joint: `${S}Arm`, parent: `${S}Shoulder`, rest: [`${S}Arm`, `${S}ForeArm`], lm: [LM[`shoulder${s}`], LM[`elbow${s}`]] },
        { joint: `${S}ForeArm`, parent: `${S}Arm`, rest: [`${S}ForeArm`, `${S}Hand`], lm: [LM[`elbow${s}`], LM[`wrist${s}`]] },
        { joint: `${S}Hand`, parent: `${S}ForeArm`, restDir: [x, 0, 0], lm: [LM[`wrist${s}`], [LM[`index${s}`], LM[`pinky${s}`]]] },
        { joint: `${S}Leg`, parent: "Hips", rest: [`${S}Leg`, `${S}Shin`], lm: [LM[`hip${s}`], LM[`knee${s}`]] },
        { joint: `${S}Shin`, parent: `${S}Leg`, rest: [`${S}Shin`, `${S}Foot`], lm: [LM[`knee${s}`], LM[`ankle${s}`]] },
        { joint: `${S}Foot`, parent: `${S}Shin`, rest: [`${S}Foot`, `${S}ToeBase`], lm: [LM[`ankle${s}`], LM[`toe${s}`]] },
    );
}
// The head's nose is ahead of and a little under the ears' middle at rest: that much pitch is no turn.
const HEAD_PITCH = 0.27;

/** A landmark list [[x, y, z, vis]] -> canonical points (Y up, facing +Z). */
export function toCanonicalPoints(pts) {
    return pts.map((p) => (p ? [p[0], -p[1], -p[2], p[3] === undefined ? 1 : p[3]] : null));
}

const at = (pts, i) => (Array.isArray(i) ? v3.scale(v3.add(pts[i[0]], pts[i[1]]), 0.5) : pts[i].slice(0, 3));
const vis = (pts, i) => (Array.isArray(i) ? Math.min(pts[i[0]][3], pts[i[1]][3]) : pts[i][3]);
const mid = (a, b) => v3.scale(v3.add(a, b), 0.5);

/** The rotation whose X axis is along `x` and whose Y is as near `up` as can be (a right-handed basis). */
export function basisQuat(x, up) {
    const X = v3.norm(x);
    const Z = v3.norm(v3.cross(X, up));
    const Y = v3.cross(Z, X);
    return quatFromAxes(X, Y, Z);
}

function quatFromAxes(X, Y, Z) {
    // The rotation matrix with columns X, Y, Z.
    const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
    const t = m00 + m11 + m22;
    let q;
    if (t > 0) {
        const s = Math.sqrt(t + 1) * 2;
        q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
    }
    return quat.norm(q);
}

/** The shortest turn taking direction `a` onto `b`. */
export function swing(a, b) {
    const u = v3.norm(a), w = v3.norm(b);
    const d = v3.dot(u, w);
    if (d > 1 - 1e-9) return [0, 0, 0, 1];
    if (d < -1 + 1e-9) {
        let axis = v3.cross(u, [1, 0, 0]);
        if (v3.len(axis) < 1e-6) axis = v3.cross(u, [0, 1, 0]);
        return quat.axisAngle(v3.norm(axis), Math.PI);
    }
    const c = v3.cross(u, w);
    return quat.norm([c[0], c[1], c[2], 1 + d]);
}

const restDir = (from, to) => v3.norm(v3.sub(SOMA_T[to], SOMA_T[from]));
// The model's T-pose leans a little (its shoulders behind its hips): the hips' and the chest's
// bases at rest, so that pose solves to no turn.
const REST_UP = v3.sub(mid(SOMA_T.LeftArm, SOMA_T.RightArm), mid(SOMA_T.LeftLeg, SOMA_T.RightLeg));
let _restHips, _restChest;
const restHips = () => (_restHips ||= quat.conj(basisQuat(v3.sub(SOMA_T.LeftLeg, SOMA_T.RightLeg), REST_UP)));
const restChest = () => (_restChest ||= quat.conj(basisQuat(v3.sub(SOMA_T.LeftArm, SOMA_T.RightArm), REST_UP)));

/**
 * One frame's canonical points -> { joint: global rotation from the T-pose }.
 * `prev` the last frame's answer: a limb the film cannot see (`minVis`) keeps its
 * turn from there, carried with its parent.
 */
export function solvePose(P, prev = null, { minVis = 0.35 } = {}) {
    const q = {};
    const up = v3.sub(mid(at(P, LM.shoulderL), at(P, LM.shoulderR)), mid(at(P, LM.hipL), at(P, LM.hipR)));
    q.Hips = quat.mul(basisQuat(v3.sub(at(P, LM.hipL), at(P, LM.hipR)), up), restHips());
    q.Chest = quat.mul(basisQuat(v3.sub(at(P, LM.shoulderL), at(P, LM.shoulderR)), up), restChest());
    q.Spine1 = quat.slerp(q.Hips, q.Chest, 1 / 3);
    q.Spine2 = quat.slerp(q.Hips, q.Chest, 2 / 3);
    if (Math.min(vis(P, LM.earL), vis(P, LM.earR), vis(P, LM.nose)) >= minVis) {
        const X = v3.norm(v3.sub(at(P, LM.earL), at(P, LM.earR)));
        let f = v3.sub(at(P, LM.nose), mid(at(P, LM.earL), at(P, LM.earR)));
        f = v3.norm(v3.sub(f, v3.scale(X, v3.dot(f, X))));
        const frame = quatFromAxes(X, v3.cross(f, X), f);
        q.Head = quat.mul(frame, quat.axisAngle([1, 0, 0], -HEAD_PITCH));
    } else {
        q.Head = prev && prev.Head && prev.Chest ? quat.mul(q.Chest, quat.mul(quat.conj(prev.Chest), prev.Head)) : q.Chest;
    }
    q.Neck1 = quat.slerp(q.Chest, q.Head, 0.5);
    q.LeftShoulder = q.Chest;
    q.RightShoulder = q.Chest;
    for (const L of LIMBS) {
        const parent = q[L.parent];
        const d0 = L.restDir || restDir(L.rest[0], L.rest[1]);
        if (Math.min(vis(P, L.lm[0]), vis(P, L.lm[1])) >= minVis) {
            const from = quat.rotate(parent, d0);
            const to = v3.sub(at(P, L.lm[1]), at(P, L.lm[0]));
            q[L.joint] = v3.len(to) > 1e-6 ? quat.mul(swing(from, to), parent) : parent;
        } else if (prev && prev[L.joint] && prev[L.parent]) {
            q[L.joint] = quat.mul(parent, quat.mul(quat.conj(prev[L.parent]), prev[L.joint]));
        } else {
            q[L.joint] = parent;
        }
    }
    q.LeftToeBase = q.LeftFoot;
    q.RightToeBase = q.RightFoot;
    return q;
}

/** Each landmark's track smoothed over time (a Gaussian of `sigma` frames); frames without a person filled from the nearest. */
export function smoothTracks(frames, key, sigma = 1.5) {
    const n = frames.length;
    const have = frames.map((f) => f[key]);
    const idx = have.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return have;
    const filled = have.map((h, i) => {
        if (h) return h;
        let best = idx[0];
        for (const j of idx) if (Math.abs(j - i) < Math.abs(best - i)) best = j;
        return have[best];
    });
    if (!(sigma > 0)) return filled;
    const r = Math.max(1, Math.ceil(3 * sigma));
    const w = [];
    for (let k = -r; k <= r; k++) w.push(Math.exp(-0.5 * (k / sigma) ** 2));
    const count = filled[0].length;
    return filled.map((_, i) => {
        const out = [];
        for (let p = 0; p < count; p++) {
            const acc = [0, 0, 0, 0];
            let ws = 0;
            for (let k = -r; k <= r; k++) {
                const j = Math.min(n - 1, Math.max(0, i + k));
                const q = filled[j][p];
                const wk = w[k + r];
                for (let c = 0; c < 4; c++) acc[c] += (q[c] === undefined ? 1 : q[c]) * wk;
                ws += wk;
            }
            out.push(acc.map((v) => v / ws));
        }
        return out;
    });
}

const median = (a) => {
    const s = a.filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/**
 * The tracker's answer -> a motion as kimodo_run.py answers one: { fps, joints,
 * samples: [{ rot [T][J], root [T][3], contacts: null }] }, the hips in the
 * model's metres (the person scaled to its size), relative to where the person
 * stood on the first frame.
 * `opts` { smooth (frames), fov (the camera's horizontal field of view, degrees),
 * inPlace (no travel), minVis }.
 */
export function solveFilm(track, { smooth = 1.5, fov = 50, inPlace = false, minVis = 0.35 } = {}) {
    const frames = (track.frames || []).filter((f) => f.world || f.image);
    if (!frames.length) throw new Error("no person was found in the film");
    const world = smoothTracks(frames, "world", smooth).map(toCanonicalPoints);
    const image = frames.some((f) => f.image) ? smoothTracks(frames, "image", smooth) : null;
    // The person's size: the hips over the lowest foot landmark, standing.
    const hipsH = median(world.map((P) => -Math.min(...FEET.map((i) => P[i][1]))));
    const k = Number.isFinite(hipsH) && hipsH > 0.2 ? SOMA_HIPS / hipsH : 1;
    const W = track.width || 1920, H = track.height || 1080;
    const focal = W / (2 * Math.tan((fov * Math.PI) / 360));
    const placed = world.map((P, i) => {
        const hipsHeight = -Math.min(...FEET.map((j) => P[j][1]));
        if (inPlace || !image) return { x: 0, z: 0, y: hipsHeight };
        const I = image[i];
        const px = (a) => [I[a][0] * W, I[a][1] * H];
        const sh = mid(px(LM.shoulderL), px(LM.shoulderR)), hp = mid(px(LM.hipL), px(LM.hipR));
        const torsoPx = Math.hypot(sh[0] - hp[0], sh[1] - hp[1]);
        const torsoM = v3.len(v3.sub(mid(at(P, LM.shoulderL), at(P, LM.shoulderR)), mid(at(P, LM.hipL), at(P, LM.hipR))));
        const d = torsoPx > 1 ? (focal * torsoM) / torsoPx : NaN;
        return { x: ((hp[0] - W / 2) / focal) * d, y: -((hp[1] - H / 2) / focal) * d, z: d, h: hipsHeight };
    });
    const first = placed.find((p) => Number.isFinite(p.z)) || placed[0];
    const rot = [], root = [];
    let prev = null;
    for (let i = 0; i < world.length; i++) {
        const q = solvePose(world[i], prev, { minVis });
        prev = q;
        rot.push(VIDEO_JOINTS.map((j) => q[j]));
        const p = placed[i];
        if (inPlace || !image || !Number.isFinite(p.z)) {
            root.push([0, p.y * k, 0]);
        } else {
            // Across and nearer (the person's +Z is towards the camera); up and down as the picture moves.
            root.push([(p.x - first.x) * k, (first.h + (p.y - first.y)) * k, -(p.z - first.z) * k]);
        }
    }
    const step = frames.length > 1 ? (frames[frames.length - 1].i - frames[0].i) / (frames.length - 1) : 1;
    return { fps: (track.fps || 24) / Math.max(1, step), joints: VIDEO_JOINTS.slice(),
             samples: [{ rot, root, contacts: null }], first: frames[0].i, size: hipsH };
}

/**
 * A solved film as the motion model's in-between keys (a clean-up): a full-body key
 * every `every` model frames and the hips' path on every one. Answers { keys, path, frames }.
 */
export function filmKeys(motion, every = 6) {
    const s = motion.samples[0];
    const n = s.rot.length;
    const frames = Math.max(8, Math.round(((n - 1) / motion.fps) * MOTION_FPS) + 1);
    const keys = [], path = { frames: [], xz: [] };
    let last = -Infinity;
    for (let mf = 0; mf < frames; mf++) {
        const t = Math.min(n - 1, (mf / MOTION_FPS) * motion.fps);
        const i = Math.round(t);
        path.frames.push(mf);
        path.xz.push([s.root[i][0], s.root[i][2]]);
        if (mf - last >= every || mf === frames - 1) {
            const joints = {};
            motion.joints.forEach((j, x) => { joints[j] = s.rot[i][x].map((v) => Math.round(v * 1e6) / 1e6); });
            keys.push({ frame: mf, joints, root: s.root[i].slice() });
            last = mf;
        }
    }
    return { keys, path, frames };
}
