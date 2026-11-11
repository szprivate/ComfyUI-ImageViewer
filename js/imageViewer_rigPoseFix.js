// Making a pose a body could hold: joint limits, knees and elbows that bend only
// one way, and hands or feet put on the floor. It works on the motion model's
// joints as global rotations from its T-pose (imageViewer_rigMotion.js SOMA_T),
// so the same rules serve a pose written in words (imageViewer_rigPoseSpec.js)
// and one read from a picture (imageViewer_rigVideo.js solvePose).
// Pure data, no three.js: tested in node (tests/test_rig_pose_fix.mjs).
//
// The maths is the textbook kind (swing-twist splits, the law of cosines for a
// two-bone limb), written for this file.

import { v3, quat } from "./imageViewer_rigData.js";
import { SOMA_T } from "./imageViewer_rigMotion.js";

// The joints, parents first, and each one's parent.
export const PARENT = {
    Hips: null, Spine1: "Hips", Spine2: "Spine1", Chest: "Spine2", Neck1: "Chest", Head: "Neck1",
    LeftShoulder: "Chest", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm",
    RightShoulder: "Chest", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm",
    LeftLeg: "Hips", LeftShin: "LeftLeg", LeftFoot: "LeftShin", LeftToeBase: "LeftFoot", LeftToeEnd: "LeftToeBase",
    RightLeg: "Hips", RightShin: "RightLeg", RightFoot: "RightShin", RightToeBase: "RightFoot", RightToeEnd: "RightToeBase",
};
const ORDER = Object.keys(PARENT);
const DEG = Math.PI / 180;

const boneDir = (from, to) => v3.norm(v3.sub(SOMA_T[to], SOMA_T[from]));

// Elbows and knees: the axis they bend about (in the parent's frame at rest, the
// way the bend is positive), how far, and how far the bone may roll about itself.
export const HINGES = {
    LeftForeArm:  { axis: [0, -1, 0], min: 0, max: 155, bone: ["LeftForeArm", "LeftHand"], roll: 90, upper: "LeftArm" },
    RightForeArm: { axis: [0, 1, 0],  min: 0, max: 155, bone: ["RightForeArm", "RightHand"], roll: 90, upper: "RightArm" },
    LeftShin:     { axis: [1, 0, 0],  min: 0, max: 155, bone: ["LeftShin", "LeftFoot"], roll: 15, upper: "LeftLeg" },
    RightShin:    { axis: [1, 0, 0],  min: 0, max: 155, bone: ["RightShin", "RightFoot"], roll: 15, upper: "RightLeg" },
};
// Every other joint: the most it may turn from its parent, in degrees (none = free).
export const CONES = {
    Spine1: 35, Spine2: 35, Chest: 35, Neck1: 45, Head: 80,
    LeftShoulder: 30, RightShoulder: 30, LeftHand: 90, RightHand: 90,
    LeftFoot: 60, RightFoot: 60, LeftToeBase: 70, RightToeBase: 70,
};

/** The part of rotation `q` about unit `axis` (its twist) and the angle of it, in radians. */
export function twistOf(q, axis) {
    const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
    let t = [axis[0] * d, axis[1] * d, axis[2] * d, q[3]];
    const l = Math.hypot(t[0], t[1], t[2], t[3]);
    if (l < 1e-9) return { q: [0, 0, 0, 1], angle: 0 };
    t = t.map((v) => v / l);
    if (t[3] < 0) t = t.map((v) => -v);
    return { q: t, angle: 2 * Math.atan2(t[0] * axis[0] + t[1] * axis[1] + t[2] * axis[2], t[3]) };
}

const clampDeg = (a, lo, hi) => Math.max(lo * DEG, Math.min(hi * DEG, a));

/** One joint's turn from its parent held to what the joint can do. */
export function limitLocal(joint, local) {
    let q = quat.norm(local);
    if (q[3] < 0) q = q.map((v) => -v);
    const h = HINGES[joint];
    if (h) {
        // Split off the roll about the bone, then keep only the bend about the hinge.
        const along = boneDir(h.bone[0], h.bone[1]);
        const roll = twistOf(q, along);
        const swingPart = quat.mul(q, quat.conj(roll.q));
        const bend = twistOf(swingPart, h.axis);
        return quat.mul(quat.axisAngle(h.axis, clampDeg(bend.angle, h.min, h.max)),
                        quat.axisAngle(along, clampDeg(roll.angle, -h.roll, h.roll)));
    }
    const max = CONES[joint];
    if (max == null) return q;
    const angle = 2 * Math.acos(Math.min(1, q[3]));
    if (angle <= max * DEG) return q;
    const s = Math.sin(angle / 2);
    return quat.axisAngle([q[0] / s, q[1] / s, q[2] / s], max * DEG);
}

/** Global rotations -> the same with every joint held to its limits (children keep their turn from their parent). */
export function limitJoints(global) {
    const out = {};
    for (const j of ORDER) {
        if (!global[j]) continue;
        const p = PARENT[j];
        if (!p || !out[p]) { out[j] = global[j]; continue; }
        const local = quat.mul(quat.conj(global[p]), global[j]);
        out[j] = quat.norm(quat.mul(out[p], limitLocal(j, local)));
    }
    return out;
}

/**
 * Turn each upper arm and thigh about itself so its elbow or knee bends about the
 * hinge: a limb read as directions (a picture) says where the bones point but not
 * how the upper bone rolls. The bones point where they did; only the roll changes.
 */
export function alignHinges(global) {
    const out = { ...global };
    for (const [joint, h] of Object.entries(HINGES)) {
        const U = out[h.upper], L = out[joint];
        if (!U || !L) continue;
        const u = v3.norm(quat.rotate(U, boneDir(h.upper, joint)));
        const l = v3.norm(quat.rotate(L, boneDir(h.bone[0], h.bone[1])));
        const c = v3.cross(u, l);
        if (v3.len(c) < Math.sin(8 * DEG)) continue;            // nearly straight: any roll will do
        const want = v3.norm(c);
        const flat = (v) => v3.norm(v3.sub(v, v3.scale(u, v3.dot(v, u))));
        const have = flat(quat.rotate(U, h.axis));
        const phi = Math.atan2(v3.dot(u, v3.cross(have, want)), v3.dot(have, want));
        out[h.upper] = quat.norm(quat.mul(quat.axisAngle(u, phi), U));
    }
    return out;
}

/** Where every joint is (metres, the hips at the origin) for global rotations. */
export function jointPoints(global) {
    const at = {};
    for (const j of ORDER) {
        const p = PARENT[j];
        if (!p) { at[j] = [0, 0, 0]; continue; }
        const g = global[p] || [0, 0, 0, 1];
        const r = quat.rotate(g, v3.sub(SOMA_T[j], SOMA_T[p]));
        at[j] = v3.add(at[p], r);
    }
    return at;
}

// The limbs a contact can put on the floor: the chain and how far its joint stands above the floor.
export const CONTACT_LIMBS = {
    "hand.L": { a: "LeftArm", b: "LeftForeArm", c: "LeftHand", lift: 0.03 },
    "hand.R": { a: "RightArm", b: "RightForeArm", c: "RightHand", lift: 0.03 },
    "foot.L": { a: "LeftLeg", b: "LeftShin", c: "LeftFoot", lift: SOMA_T.LeftFoot[1] - SOMA_T.LeftToeEnd[1] },
    "foot.R": { a: "RightLeg", b: "RightShin", c: "RightFoot", lift: SOMA_T.RightFoot[1] - SOMA_T.RightToeEnd[1] },
    "knee.L": { a: "LeftLeg", c: "LeftShin", lift: 0.05 },
    "knee.R": { a: "RightLeg", c: "RightShin", lift: 0.05 },
};

/** "left hand", "hand.R", { part: "foot_l", under: true } ... -> { key, under } | null. */
export function readContact(c) {
    const raw = typeof c === "string" ? c : c && (c.part || c.name);
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    const side = /(^|[\s_.\-])(l|left)([\s_.\-]|$)/.test(s) || /^left/.test(s) || /left$/.test(s) ? "L"
        : /(^|[\s_.\-])(r|right)([\s_.\-]|$)/.test(s) || /^right/.test(s) || /right$/.test(s) ? "R" : null;
    const part = /hand|wrist|palm/.test(s) ? "hand" : /foot|feet|ankle|heel|sole/.test(s) ? "foot" : /knee/.test(s) ? "knee" : null;
    if (!part || !side) return null;
    return { key: `${part}.${side}`, under: !!(c && typeof c === "object" && c.under) };
}

/** Two bones from `A` (lengths la, lb) reaching `T`, bending towards `pole`: where the middle joint goes. */
export function twoBone(A, la, lb, T, pole) {
    const toT = v3.sub(T, A);
    const dist = v3.len(toT);
    const n = dist > 1e-9 ? v3.scale(toT, 1 / dist) : [0, -1, 0];
    const d = Math.max(Math.abs(la - lb) + 1e-4, Math.min(la + lb - 1e-4, dist));
    let p = v3.sub(pole, A);
    p = v3.sub(p, v3.scale(n, v3.dot(p, n)));
    if (v3.len(p) < 1e-6) p = Math.abs(n[1]) < 0.9 ? v3.cross(n, [0, 1, 0]) : v3.cross(n, [1, 0, 0]);
    p = v3.norm(p);
    const cos = Math.max(-1, Math.min(1, (la * la + d * d - lb * lb) / (2 * la * d)));
    const sin = Math.sqrt(1 - cos * cos);
    return { mid: v3.add(A, v3.add(v3.scale(n, la * cos), v3.scale(p, la * sin))), end: v3.add(A, v3.scale(n, d)) };
}

/**
 * Put hands, feet or knees on the floor. `global` rotations, `rootY` the hips'
 * height; each contact's limb is turned (two-bone IK, bending the way it bent) so
 * its joint lands on the floor where it was over it - or, with `under`, straight
 * under the limb's root (a hand under its shoulder). Answers new rotations; the
 * hands and feet keep the way they face.
 */
export function placeContacts(global, rootY, contacts) {
    let g = { ...global };
    for (const c of contacts) {
        const L = CONTACT_LIMBS[c.key];
        if (!L) continue;
        const at = jointPoints(g);
        const A = at[L.a], C = at[L.c];
        const T = [c.under ? A[0] : C[0], L.lift - rootY, c.under ? A[2] : C[2]];
        if (!L.b) {
            // One bone (a knee on the floor): turn the thigh straight at it.
            const s = quat.between(v3.sub(C, A), v3.sub(T, A));
            g = turnChain(g, L.a, s);
            continue;
        }
        const B = at[L.b];
        const la = v3.dist(A, B), lb = v3.dist(B, C);
        const { mid } = twoBone(A, la, lb, T, B);
        const s1 = quat.between(v3.sub(B, A), v3.sub(mid, A));
        g = turnChain(g, L.a, s1);
        const at2 = jointPoints(g);
        const s2 = quat.between(v3.sub(at2[L.c], at2[L.b]), v3.sub(T, at2[L.b]));
        g = turnChain(g, L.b, s2, L.c);
    }
    return g;
}

/** Turn `joint` and everything under it by world rotation `s`; `keep` (and below) keeps its world turn. */
function turnChain(g, joint, s, keep = null) {
    const out = { ...g };
    const under = new Set([joint]);
    for (const j of ORDER) if (PARENT[j] && under.has(PARENT[j])) under.add(j);
    const kept = new Set();
    if (keep) { kept.add(keep); for (const j of ORDER) if (PARENT[j] && kept.has(PARENT[j])) kept.add(j); }
    for (const j of under) if (out[j] && !kept.has(j)) out[j] = quat.norm(quat.mul(s, out[j]));
    return out;
}

/** The hips' height that puts the lowest point of the body on the floor. */
export function groundHeight(at) {
    return -Math.min(...Object.values(at).map((p) => p[1]));
}

/**
 * The whole tidy-up: limits (with `limits`), then the contacts on the floor.
 * `rootY` null = stand the body on its lowest point, or on its first contact when
 * there are contacts. Answers { joints (global), rootY, points, contacts (the keys
 * understood), unknown (contacts not understood) }.
 */
export function fixPose(global, { limits = true, contacts = [], rootY = null, hinges = false } = {}) {
    let g = global;
    if (hinges) g = alignHinges(g);
    if (limits) g = limitJoints(g);
    const read = [], unknown = [];
    for (const c of [].concat(contacts || [])) {
        const r = readContact(c);
        if (r && CONTACT_LIMBS[r.key]) read.push(r); else unknown.push(typeof c === "string" ? c : JSON.stringify(c));
    }
    let y = rootY;
    if (y == null) {
        const at = jointPoints(g);
        y = read.length ? CONTACT_LIMBS[read[0].key].lift - at[CONTACT_LIMBS[read[0].key].c][1] : groundHeight(at);
    }
    if (read.length) {
        // A contact the limb cannot reach lowers the body (the others then bend more), a few times over.
        const base = g;
        for (let pass = 0; ; pass++) {
            g = placeContacts(base, y, read);
            if (rootY != null || pass === 6) break;
            const at = jointPoints(g);
            const gap = Math.max(...read.map((r) => at[CONTACT_LIMBS[r.key].c][1] + y - CONTACT_LIMBS[r.key].lift));
            if (!(gap > 0.002)) break;
            y -= gap;
        }
        if (limits) g = alignHinges(g);
    }
    return { joints: g, rootY: y, points: jointPoints(g), contacts: read.map((r) => r.key), unknown };
}
