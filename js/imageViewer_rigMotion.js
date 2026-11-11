// Motion for humanoid rigs: poses to and from the AI motion model's skeleton,
// and the clean-up of where the feet land. Pure data, no three.js: tested in node
// (tests/test_rig_motion.mjs).
//
// The model (NVIDIA Kimodo, run by scripts/rig/kimodo_run.py) works on its own
// 77-joint SOMA skeleton, in a T-pose standing on the ground (Y up, facing +Z,
// its left side at +X, metres). A motion arrives as, per frame and joint, the
// global rotation away from that T-pose, plus where the hips are. That is the
// canonical pose space of imageViewer_rigData.js: a rotation in it turns any
// skeleton's bone from that skeleton's own T-pose, so the motion is put on a
// character bone by bone (fromCanonical), the hips scaled to the character's
// size. Keyed poses go the other way (toCanonical) to become the model's
// constraints for an in-between.
//
// The maths is the textbook kind (rigid transforms, quaternions, two-bone IK),
// written for this file.

import { v3, quat, mat4, HUMANOID, canonicalAlign, toCanonical, fromCanonical, solveTwoBone } from "./imageViewer_rigData.js";

export const MOTION_FPS = 30;

/** The SOMA joint a humanoid role drives (and reads), for this character's roles. */
export function somaJointOf(role, roles) {
    const centre = { hips: "Hips", spine: "Spine1", chest: roles && roles.upperChest ? "Spine2" : "Chest",
                     upperChest: "Chest", neck: "Neck1", head: "Head" };
    if (centre[role]) return centre[role];
    const [base, side] = String(role).split(".");
    const S = side === "L" ? "Left" : side === "R" ? "Right" : "";
    const limb = { shoulder: "Shoulder", upperArm: "Arm", lowerArm: "ForeArm", hand: "Hand",
                   upperLeg: "Leg", lowerLeg: "Shin", foot: "Foot", toes: "ToeBase" }[base];
    return S && limb ? S + limb : null;
}

const head = (m) => [m[12], m[13], m[14]];

// The model's T-pose: where SOMA's joints are, relative to the hips (metres),
// read from Kimodo's somaskel77 rest. The canonical pose space is this pose,
// so a character is lined up bone by bone with it (its feet pointing forward
// and down as these do, its spine leaning as this one).
export const SOMA_T = {
    Hips: [0, 0, 0], Spine1: [-0.0001, 0.05, -0.0005], Spine2: [-0.0001, 0.1213, -0.0008], Chest: [-0.0001, 0.1968, -0.009],
    Neck1: [-0.002, 0.4599, -0.0145], Head: [-0.002, 0.5983, 0.028],
    LeftShoulder: [0.0161, 0.4292, 0.0421], LeftArm: [0.1653, 0.4292, -0.0129], LeftForeArm: [0.4527, 0.4292, -0.0129],
    LeftHand: [0.7236, 0.4292, -0.0129], LeftLeg: [0.1004, -0.0843, 0.026], LeftShin: [0.1004, -0.5166, 0.0179],
    LeftFoot: [0.1004, -0.9381, -0.0169], LeftToeBase: [0.1004, -0.9887, 0.1154],
    RightShoulder: [-0.0139, 0.4286, 0.0431], RightArm: [-0.1643, 0.4286, -0.0123], RightForeArm: [-0.4517, 0.4286, -0.0123],
    RightHand: [-0.723, 0.4286, -0.0123], RightLeg: [-0.1005, -0.083, 0.0262], RightShin: [-0.1005, -0.5166, 0.0181],
    RightFoot: [-0.1005, -0.9377, -0.0166], RightToeBase: [-0.1005, -0.9885, 0.1162],
    LeftToeEnd: [0.1003, -1.0052, 0.1806], RightToeEnd: [-0.1004, -1.0049, 0.1808],
};
// The hips over the lowest joint, standing: the model's size.
export const SOMA_HIPS = -Math.min(...Object.values(SOMA_T).map((p) => p[1]));

/**
 * What a character is at rest, for moving poses on and off it.
 * `skeleton` { bones: [{ name, parent, world }] } (model space, parents first);
 * `roles` role -> bone name. Answers { order, parent, restWorld, restLocal,
 * restQ, align, roles, ground, hipsHeight }.
 */
export function humanoidRest(skeleton, roles) {
    const byName = new Map(skeleton.bones.map((b) => [b.name, b]));
    const order = [], parent = new Map(), restWorld = new Map(), restLocal = new Map();
    for (const b of skeleton.bones) {
        order.push(b.name);
        parent.set(b.name, b.parent && byName.has(b.parent) ? b.parent : null);
        restWorld.set(b.name, b.world);
    }
    for (const n of order) {
        const p = parent.get(n);
        restLocal.set(n, p ? mat4.mul(mat4.invert(restWorld.get(p)), restWorld.get(n)) : restWorld.get(n).slice());
    }
    const info = {}, restQ = {}, dirs = {};
    for (const r of HUMANOID) {
        const name = roles[r.role];
        if (!name || !byName.has(name)) continue;
        restQ[r.role] = mat4.decompose(restWorld.get(name)).q;
        const child = HUMANOID.find((c) => roles[c.role] && byName.has(roles[c.role])
            && (c.parent === r.role || (r.role === "chest" && !roles.upperChest && c.parent === "upperChest" && c.role === "neck")));
        info[r.role] = { q: restQ[r.role], head: head(restWorld.get(name)),
                         childHead: child ? head(restWorld.get(roles[child.role])) : null };
        const a = SOMA_T[somaJointOf(r.role, roles)], b = child && SOMA_T[somaJointOf(child.role, roles)];
        if (a && b) dirs[r.role] = v3.norm(v3.sub(b, a));
    }
    let ground = Infinity;
    for (const n of order) ground = Math.min(ground, restWorld.get(n)[13]);
    const hips = roles.hips && restWorld.get(roles.hips);
    return { order, parent, restWorld, restLocal, restQ, align: canonicalAlign(info, dirs), roles,
             ground: Number.isFinite(ground) ? ground : 0, hipsHeight: hips ? hips[13] - ground : 1 };
}

/** How much bigger the character is than the model's skeleton (hips over the lowest joint). */
export function motionScale(rest) {
    return rest.hipsHeight / SOMA_HIPS;
}

/**
 * A character pose -> a key for the model: { joints: { SOMA joint: [x,y,z,w] }, root: [x,y,z] }.
 * `pose` Map bone -> model-space 4x4; `scale` from motionScale; `origin` [x, z]
 * of model space that is the motion's (0, 0).
 */
export function poseToSoma(pose, rest, scale, origin = [0, 0]) {
    const world = {};
    for (const role of Object.keys(rest.restQ)) {
        const m = pose.get(rest.roles[role]);
        if (m) world[role] = mat4.decompose(m).q;
    }
    const canon = toCanonical(world, rest.restQ, rest.align);
    const joints = {};
    for (const [role, q] of Object.entries(canon)) {
        const j = somaJointOf(role, rest.roles);
        if (j) joints[j] = q.map((v) => Math.round(v * 1e6) / 1e6);
    }
    const h = head(pose.get(rest.roles.hips) || rest.restWorld.get(rest.roles.hips));
    return { joints, root: [(h[0] - origin[0]) / scale, (h[1] - rest.ground) / scale, (h[2] - origin[1]) / scale] };
}

/** The way a pose's hips face, as the model measures it: 0 facing +Z, turning towards +X. */
export function headingOf(somaKey) {
    const q = somaKey.joints.Hips || [0, 0, 0, 1];
    const f = quat.rotate(q, [0, 0, 1]);
    return Math.atan2(f[0], f[2]);
}

/**
 * One frame of a motion -> a character pose (Map bone -> model-space 4x4).
 * `rot` the frame's [77][x,y,z,w], `root` its hips [x,y,z]. Bones that have a
 * role are turned as the model's joint for it; the others keep their place
 * under their parent, as at rest. Bone lengths stay the character's own.
 */
export function somaToPose(rot, root, motionIndex, rest, scale, origin = [0, 0]) {
    const canon = {};
    for (const role of Object.keys(rest.restQ)) {
        const j = somaJointOf(role, rest.roles);
        const i = j != null ? motionIndex.get(j) : undefined;
        if (i !== undefined && rot[i]) canon[role] = rot[i];
    }
    const worldQ = fromCanonical(canon, rest.restQ, rest.align);
    const qOfBone = new Map();
    for (const [role, q] of Object.entries(worldQ)) qOfBone.set(rest.roles[role], q);
    const hipsAt = [root[0] * scale + origin[0], root[1] * scale + rest.ground, root[2] * scale + origin[1]];
    const pose = new Map();
    for (const name of rest.order) {
        const p = rest.parent.get(name);
        const local = rest.restLocal.get(name);
        let w = p ? mat4.mul(pose.get(p), local) : local.slice();
        const q = qOfBone.get(name);
        if (q || name === rest.roles.hips) {
            const d = mat4.decompose(w);
            w = mat4.compose(name === rest.roles.hips ? hipsAt : d.p, q || d.q, d.s);
        }
        pose.set(name, w);
    }
    return pose;
}

/**
 * Motion frames (at the model's 30 fps) onto scene frames: sample `count`
 * scene frames from `start` at `fps`, each the motion at that time (rotations
 * slerped, the hips lerped). Answers [{ f, rot, root, contacts }].
 */
export function resample(sample, fps, start, count) {
    const n = sample.rot.length;
    const out = [];
    for (let k = 0; k < count; k++) {
        const t = Math.min(n - 1, (k / fps) * MOTION_FPS);
        const i = Math.floor(t), j = Math.min(n - 1, i + 1), a = t - i;
        const rot = sample.rot[i].map((q, x) => (a < 1e-6 ? q : quat.slerp(q, sample.rot[j][x], a)));
        const root = sample.root[i].map((v, x) => v + (sample.root[j][x] - v) * a);
        const contacts = sample.contacts ? sample.contacts[a < 0.5 ? i : j] : null;
        out.push({ f: start + k, rot, root, contacts });
    }
    return out;
}

// ── Feet ─────────────────────────────────────────────────────────────────────

/**
 * Keep the feet on the floor and still while they stand.
 * `frames` [{ f, pose: Map, contacts?: [lHeel, lToe, rHeel, rToe] }], changed
 * in place and answered. A foot is standing where the model says so or, without
 * that, where it is low and hardly moving; while it stands it is pinned where
 * it stood (blended in and out over `blend` frames), and the leg is bent to
 * reach it. No foot goes through the floor (`floor`: rest.ground by default).
 */
export function cleanFeet(frames, rest, { floor = rest.ground, blend = 3, lock = true } = {}) {
    const report = { lifted: 0, pinned: 0 };
    for (const side of ["L", "R"]) {
        const up = rest.roles[`upperLeg.${side}`], low = rest.roles[`lowerLeg.${side}`];
        const foot = rest.roles[`foot.${side}`], toes = rest.roles[`toes.${side}`];
        if (!up || !low || !foot) continue;
        const lengths = [v3.dist(head(rest.restWorld.get(up)), head(rest.restWorld.get(low))),
                         v3.dist(head(rest.restWorld.get(low)), head(rest.restWorld.get(foot)))];
        const leg = lengths[0] + lengths[1];
        // Where the foot is, and how low its lowest joint is over the floor.
        const at = frames.map((fr) => head(fr.pose.get(foot)));
        const lowest = frames.map((fr) => Math.min(fr.pose.get(foot)[13], toes && fr.pose.get(toes) ? fr.pose.get(toes)[13] : Infinity));
        const restLow = Math.min(rest.restWorld.get(foot)[13], toes ? rest.restWorld.get(toes)[13] : Infinity) - floor;
        const standing = frames.map((fr, i) => {
            if (fr.contacts) {
                const c = side === "L" ? [fr.contacts[0], fr.contacts[1]] : [fr.contacts[2], fr.contacts[3]];
                return Math.max(c[0], c[1]) >= 0.5;
            }
            const prev = at[Math.max(0, i - 1)], next = at[Math.min(at.length - 1, i + 1)];
            const speed = v3.dist(prev, next) / (i > 0 && i < at.length - 1 ? 2 : 1);
            return lowest[i] - floor - restLow < 0.06 * leg && speed < 0.012 * leg;
        });
        // Targets: the floor first, then the pins.
        const target = at.map((p, i) => {
            const lift = Math.max(0, floor + restLow - lowest[i]);
            if (lift > 1e-6) report.lifted++;
            return [p[0], p[1] + lift, p[2]];
        });
        if (lock) {
            let i = 0;
            while (i < frames.length) {
                if (!standing[i]) { i++; continue; }
                let j = i;
                while (j + 1 < frames.length && standing[j + 1]) j++;
                const pin = target[i].slice();
                pin[1] = Math.max(pin[1], ...target.slice(i, j + 1).map((p) => p[1]));
                for (let k = Math.max(0, i - blend); k <= Math.min(frames.length - 1, j + blend); k++) {
                    const w = k < i ? 1 - (i - k) / (blend + 1) : k > j ? 1 - (k - j) / (blend + 1) : 1;
                    target[k] = target[k].map((v, x) => v + (pin[x] - v) * w);
                    if (k >= i && k <= j) report.pinned++;
                }
                i = j + 1;
            }
        }
        frames.forEach((fr, i) => {
            if (v3.dist(target[i], at[i]) > 1e-6) _reachFoot(fr.pose, rest, up, low, foot, target[i], lengths);
        });
    }
    return report;
}

/** Bend one leg so its foot is at `target`, the foot keeping its turn; what hangs under it follows. */
function _reachFoot(pose, rest, up, low, foot, target, lengths) {
    const A = mat4.decompose(pose.get(up)), B = mat4.decompose(pose.get(low)), C = mat4.decompose(pose.get(foot));
    const pa = A.p, pb = B.p, pc = C.p;
    let hingeW = v3.cross(v3.sub(pb, pa), v3.sub(pc, pb));
    if (v3.len(hingeW) < 1e-9) hingeW = quat.rotate(A.q, [1, 0, 0]);
    // The knee keeps pointing the way it does: the pole is out in front of it.
    const mid = v3.add(pa, v3.scale(v3.sub(pc, pa), 0.5));
    let out = v3.sub(pb, mid);
    if (v3.len(out) < 1e-6) out = v3.cross(v3.norm(hingeW), v3.norm(v3.sub(pc, pa)));
    const pole = v3.add(pb, v3.scale(v3.norm(out), lengths[0] + lengths[1]));
    const s = solveTwoBone({ pa, pb, pc, qa: A.q, qb: B.q, target, pole,
                             hinge: quat.rotate(quat.conj(A.q), v3.norm(hingeW)), lengths });
    const changed = new Map([
        [up, mat4.compose(pa, s.qa, A.s)],
        [low, mat4.compose(s.pb, s.qb, B.s)],
        [foot, mat4.compose(s.pc, C.q, C.s)],
    ]);
    const old = new Map();
    for (const name of rest.order) {
        if (changed.has(name)) { old.set(name, pose.get(name)); pose.set(name, changed.get(name)); continue; }
        const p = rest.parent.get(name);
        if (p && old.has(p)) {
            old.set(name, pose.get(name));
            pose.set(name, mat4.mul(pose.get(p), mat4.mul(mat4.invert(old.get(p)), old.get(name))));
        }
    }
}

/**
 * The in-between's keys from the rig: per keyed frame its pose, made into the
 * model's constraints. `poses` [{ f, pose }] (scene frames, from `first`),
 * `fps` the scene's. Answers { keys: [{ frame, joints, root }], origin,
 * heading, frames } with frames counted at the model's 30 fps from the first key.
 */
export function inbetweenKeys(poses, rest, scale, fps) {
    if (!poses.length) return null;
    const first = poses[0].f;
    const h0 = head(poses[0].pose.get(rest.roles.hips));
    const origin = [h0[0], h0[2]];
    const keys = poses.map((p) => ({ frame: Math.round((p.f - first) / fps * MOTION_FPS), ...poseToSoma(p.pose, rest, scale, origin) }));
    const last = poses[poses.length - 1].f;
    return { keys, origin, heading: headingOf(keys[0]), frames: Math.max(8, Math.round((last - first) / fps * MOTION_FPS) + 1) };
}
