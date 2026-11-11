// A single pose from words: a humanoid's joints described the way a person would
// ("the thigh 90° forward, the knee bent 90°"), or put together from named poses
// ("sit" + "arms_crossed"), solved into the motion model's joint rotations, so it
// goes onto any humanoid character the way an AI motion does (one frame of it,
// through imageViewer_rigMotion.js somaToPose). This is how the agent poses a
// character without the text-to-motion model. Pure data, no three.js: tested in
// node (tests/test_rig_pose_spec.mjs).
//
// Every joint turns from the T-pose, in its parent's frame (so a bent elbow stays
// bent when the shoulder moves), all angles in degrees. Directions are the
// character's own: forward is where it faces, left is its left. The hips stand
// where the character stands; with `ground` (the default) the whole body is
// lowered or raised until its lowest joint touches the floor - a sitting, kneeling
// or lying pose then lands on the ground by itself.
//
// The maths is plain rotation composition and forward kinematics, written for
// this file.

import { quat } from "./imageViewer_rigData.js";
import { SOMA_T, SOMA_HIPS, MOTION_FPS, headingOf } from "./imageViewer_rigMotion.js";

// The joints a pose drives, parents first, and each one's parent.
const PARENT = {
    Hips: null, Spine1: "Hips", Spine2: "Spine1", Chest: "Spine2", Neck1: "Chest", Head: "Neck1",
    LeftShoulder: "Chest", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm",
    RightShoulder: "Chest", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm",
    LeftLeg: "Hips", LeftShin: "LeftLeg", LeftFoot: "LeftShin", LeftToeBase: "LeftFoot", LeftToeEnd: "LeftToeBase",
    RightLeg: "Hips", RightShin: "RightLeg", RightFoot: "RightShin", RightToeBase: "RightFoot", RightToeEnd: "RightToeBase",
};
export const POSE_JOINTS = Object.keys(PARENT).filter((j) => !j.endsWith("ToeEnd"));

// The parts of the body a pose names, what each turns, and the SOMA joint it is.
// Sided parts take ".L" / ".R"; without a side they are both, mirrored.
export const PARTS = {
    hips:      { joint: "Hips",   moves: ["bend", "side", "turn"] },
    spine:     { joint: "Spine1", moves: ["bend", "side", "twist"] },
    chest:     { joint: "Chest",  moves: ["bend", "side", "twist"] },
    neck:      { joint: "Neck1",  moves: ["bend", "side", "twist"] },
    head:      { joint: "Head",   moves: ["bend", "side", "twist"] },
    shoulder:  { joint: "Shoulder", sided: true, moves: ["raise", "forward"] },
    upperArm:  { joint: "Arm",      sided: true, moves: ["down", "forward", "twist"] },
    lowerArm:  { joint: "ForeArm",  sided: true, moves: ["bend", "twist"] },
    hand:      { joint: "Hand",     sided: true, moves: ["bend", "side", "twist"] },
    upperLeg:  { joint: "Leg",      sided: true, moves: ["forward", "out", "twist"] },
    lowerLeg:  { joint: "Shin",     sided: true, moves: ["bend"] },
    foot:      { joint: "Foot",     sided: true, moves: ["point", "turn"] },
    toes:      { joint: "ToeBase",  sided: true, moves: ["bend"] },
};
// What else a part may be called.
const PART_ALIASES = {
    pelvis: "hips", root: "hips", back: "spine", torso: "chest", upperchest: "chest", clavicle: "shoulder",
    arm: "upperArm", upperarm: "upperArm", elbow: "lowerArm", forearm: "lowerArm", lowerarm: "lowerArm", wrist: "hand",
    leg: "upperLeg", thigh: "upperLeg", upperleg: "upperLeg", hip: "upperLeg", knee: "lowerLeg", shin: "lowerLeg",
    calf: "lowerLeg", lowerleg: "lowerLeg", ankle: "foot", feet: "foot", toe: "toes",
};
// What else a move may be called, with the sign it takes.
const MOVE_ALIASES = {
    up: ["down", -1], raise: ["raise", 1], lift: ["forward", 1], back: ["forward", -1], backward: ["forward", -1],
    lean: ["side", 1], tilt: ["side", 1], nod: ["bend", 1], in: ["out", -1], flex: ["bend", 1], curl: ["bend", 1],
    rotate: ["twist", 1], roll: ["twist", 1], yaw: ["turn", 1],
};

const DEG = Math.PI / 180;
const Rx = (d) => quat.axisAngle([1, 0, 0], d * DEG);
const Ry = (d) => quat.axisAngle([0, 1, 0], d * DEG);
const Rz = (d) => quat.axisAngle([0, 0, 1], d * DEG);
const mul = (...qs) => qs.reduce((a, b) => quat.mul(a, b), [0, 0, 0, 1]);

/**
 * One part's turn from the T-pose, in its parent's frame. `s` is +1 for the
 * character's left, -1 for its right (the centre parts take +1).
 *   hips / spine / chest / neck / head: bend (forward), side (towards its left), twist|turn (to its left)
 *   shoulder: raise (shrug), forward
 *   upperArm: down (from straight out sideways; 90 = hanging, negative = above), forward
 *             (towards the front; with down 0 and forward 90 it points ahead), twist (inwards:
 *             with the elbow bent it swings the forearm across the body; negative = outwards)
 *   lowerArm: bend (the elbow; the forearm folds towards the front of the upper arm), twist
 *   hand:     bend (palm down from the T-pose), side (towards the thumb / front), twist
 *   upperLeg: forward (the thigh raised to the front; 90 = level, as sitting), out (spread
 *             sideways), twist (the toes outwards)
 *   lowerLeg: bend (the knee)
 *   foot:     point (the toes down; negative = up), turn (the toes outwards)
 *   toes:     bend (curled down)
 */
export function partTurn(part, m, s = 1) {
    const g = (k) => Number(m[k]) || 0;
    switch (part) {
        case "hips": return mul(Ry(g("turn") + g("twist")), Rx(g("bend")), Rz(-g("side")));
        case "spine": case "chest": case "neck": case "head":
            return mul(Ry(g("twist") + g("turn")), Rx(g("bend")), Rz(-g("side")));
        case "shoulder": return mul(Ry(-s * g("forward")), Rz(s * g("raise")));
        case "upperArm": return mul(Ry(-s * g("forward")), Rz(-s * g("down")), Rx(g("twist")));
        case "lowerArm": return mul(Ry(-s * g("bend")), Rx(g("twist")));
        case "hand": return mul(Rz(-s * g("bend")), Ry(-s * g("side")), Rx(g("twist")));
        case "upperLeg": return mul(Rx(-g("forward")), Rz(s * g("out")), Ry(s * g("twist")));
        case "lowerLeg": return Rx(g("bend"));
        case "foot": return mul(Ry(s * g("turn")), Rx(g("point")));
        case "toes": return Rx(g("bend"));
        default: return [0, 0, 0, 1];
    }
}

// Named poses. Each is a set of parts; they are laid over each other in the order
// given, later parts replacing earlier ones' moves, so "sit" + "arms_crossed" is a
// person sitting with crossed arms.
export const PRESETS = {
    t_pose: { note: "arms straight out", parts: {} },
    a_pose: { note: "arms 45 degrees down", parts: { upperArm: { down: 45 } } },
    stand: { note: "standing relaxed, arms hanging", parts: {
        upperArm: { down: 78, forward: 5 }, lowerArm: { bend: 12 }, hand: { bend: 5 } } },
    arms_up: { note: "both arms straight up", parts: { upperArm: { down: -85 } } },
    arms_forward: { note: "both arms straight ahead", parts: { upperArm: { forward: 90 } } },
    arms_crossed: { note: "arms folded across the chest", parts: {
        "upperArm.L": { down: 59, forward: 100, twist: -23 }, "lowerArm.L": { bend: 95 },
        "upperArm.R": { down: 60, forward: 97, twist: -23 }, "lowerArm.R": { bend: 84 } } },
    hands_on_hips: { note: "hands on the hips, elbows out", parts: {
        upperArm: { down: 47, forward: -11, twist: 87 }, lowerArm: { bend: 88 }, hand: { bend: 10 } } },
    hands_behind_head: { note: "hands clasped behind the head, elbows out", parts: {
        upperArm: { down: -53, forward: 5, twist: -111 }, lowerArm: { bend: 133 } } },
    wave: { note: "the right hand raised, waving", parts: {
        "upperArm.R": { down: -6, forward: 15, twist: -86 }, "lowerArm.R": { bend: 81 },
        "upperArm.L": { down: 78, forward: 5 }, "lowerArm.L": { bend: 12 } } },
    point: { note: "the right arm pointing ahead", parts: {
        "upperArm.R": { forward: 85, down: 5 }, "upperArm.L": { down: 78, forward: 5 }, "lowerArm.L": { bend: 12 } } },
    think: { note: "the right hand at the chin, the left arm across the waist", parts: {
        "upperArm.R": { down: 41, forward: 108, twist: -60 }, "lowerArm.R": { bend: 133 }, "hand.R": { bend: -20 },
        "upperArm.L": { down: 60, forward: 97, twist: -23 }, "lowerArm.L": { bend: 84 }, head: { bend: 10 } } },
    sit: { note: "sitting on a chair, hands on the thighs", parts: {
        upperLeg: { forward: 90, out: 6 }, lowerLeg: { bend: 90 }, spine: { bend: 4 },
        upperArm: { down: 72, forward: 35 }, lowerArm: { bend: 45 }, hand: { bend: 25 } } },
    sit_floor: { note: "sitting cross-legged on the floor", hips: { height: 0.12 }, parts: {
        "upperLeg.L": { forward: 104, out: 43, twist: 82 }, "lowerLeg.L": { bend: 132 },
        "upperLeg.R": { forward: 100, out: 43, twist: 82 }, "lowerLeg.R": { bend: 128 }, foot: { point: 10 },
        spine: { bend: 10 }, upperArm: { down: 65, forward: 45 }, lowerArm: { bend: 40 }, hand: { bend: 20 } } },
    kneel: { note: "kneeling on the right knee", parts: {
        "upperLeg.L": { forward: 90, out: 5 }, "lowerLeg.L": { bend: 90 },
        "upperLeg.R": { forward: -5 }, "lowerLeg.R": { bend: 95 }, "foot.R": { point: -40 }, "toes.R": { bend: -50 },
        upperArm: { down: 75, forward: 15 }, lowerArm: { bend: 20 } } },
    kneel_both: { note: "kneeling on both knees, upright", parts: {
        upperLeg: { forward: 0 }, lowerLeg: { bend: 95 }, foot: { point: 40 },
        upperArm: { down: 78, forward: 5 }, lowerArm: { bend: 12 } } },
    crouch: { note: "crouching low on the feet", parts: {
        upperLeg: { forward: 115, out: 15 }, lowerLeg: { bend: 135 }, spine: { bend: 25 },
        chest: { bend: 10 }, head: { bend: -25 }, upperArm: { down: 70, forward: 50 }, lowerArm: { bend: 30 } } },
    lie_back: { note: "lying on the back", parts: {
        hips: { bend: -90 }, upperArm: { down: 80, forward: -5 }, foot: { point: 15 } } },
    lie_front: { note: "lying face down", parts: {
        hips: { bend: 90 }, upperArm: { down: 80 }, head: { side: 0, twist: 70 }, foot: { point: 60 } } },
};

/** "upperArm.L", "left_elbow", "Right Thigh", "knees" ... -> [part, side | null]. */
export function readPart(name) {
    let s = String(name || "").trim();
    let side = null;
    const m1 = s.match(/^(left|right|l|r)[\s_.\-]+(.+)$/i);
    const m2 = s.match(/^(.+?)[\s_.\-]+(left|right|l|r)$/i);
    if (m1) { side = m1[1][0].toUpperCase(); s = m1[2]; } else if (m2) { side = m2[2][0].toUpperCase(); s = m2[1]; }
    let k = s.replace(/[\s_.\-]/g, "");
    if (!PARTS[k]) {
        const low = k.toLowerCase();
        k = Object.keys(PARTS).find((p) => p.toLowerCase() === low) || PART_ALIASES[low]
            || (low.endsWith("s") && (PART_ALIASES[low.slice(0, -1)] || Object.keys(PARTS).find((p) => p.toLowerCase() === low.slice(0, -1))));
    }
    if (!k || !PARTS[k]) return null;
    if (!PARTS[k].sided) side = null;
    return [k, side];
}

/** A part's moves as given (aliases read, unknown ones named). */
function readMoves(part, moves, unknown) {
    const out = {};
    for (const [k0, v] of Object.entries(moves || {})) {
        const n = Number(v);
        if (!Number.isFinite(n)) { unknown.push(`${part}.${k0}`); continue; }
        let k = k0, sign = 1;
        if (!PARTS[part].moves.includes(k) && MOVE_ALIASES[k]) [k, sign] = MOVE_ALIASES[k];
        if (part === "hips" || part === "foot") { if (k === "twist") k = "turn"; }
        else if (k === "turn" && PARTS[part].moves.includes("twist")) k = "twist";
        if (!PARTS[part].moves.includes(k)) { unknown.push(`${part}.${k0}`); continue; }
        out[k] = Math.max(-180, Math.min(180, n * sign));
    }
    return out;
}

/**
 * A pose description -> the parts per side: { "hips": {...}, "upperArm.L": {...}, ... },
 * where the hips go ({ height, offset }: a preset's, then the spec's own) and what was not
 * understood. `spec` = { preset: name | [names], joints: { part: moves }, hips,
 * mirror: "L" | "R" (copy that side onto the other) }.
 */
export function resolvePose(spec = {}) {
    const unknown = [];
    const out = {};
    let hips = {};
    const lay = (parts) => {
        for (const [name, moves] of Object.entries(parts || {})) {
            const r = readPart(name);
            if (!r) { unknown.push(name); continue; }
            const [part, side] = r;
            const got = readMoves(part, moves, unknown);
            const keys = PARTS[part].sided ? (side ? [`${part}.${side}`] : [`${part}.L`, `${part}.R`]) : [part];
            for (const k of keys) out[k] = { ...(out[k] || {}), ...got };
        }
    };
    const presets = spec.preset == null ? [] : Array.isArray(spec.preset) ? spec.preset : String(spec.preset).split(/[+,]/);
    for (const p0 of presets) {
        const p = String(p0).trim().toLowerCase().replace(/[\s\-]+/g, "_");
        if (!p) continue;
        if (!PRESETS[p]) { unknown.push(`preset ${p0}`); continue; }
        lay(PRESETS[p].parts);
        if (PRESETS[p].hips) hips = { ...hips, ...PRESETS[p].hips };
    }
    lay(spec.joints);
    const mirror = spec.mirror ? String(spec.mirror)[0].toUpperCase() : null;
    if (mirror === "L" || mirror === "R") {
        const other = mirror === "L" ? "R" : "L";
        for (const [k, v] of Object.entries(out)) if (k.endsWith(`.${mirror}`)) out[k.slice(0, -1) + other] = { ...v };
    }
    if (spec.hips && typeof spec.hips === "object") hips = { ...hips, ...spec.hips };
    return { parts: out, hips, unknown };
}

/**
 * The parts -> the model's joint rotations (global, canonical: Y up, facing +Z),
 * where every joint is (metres, hips at the origin, before `root`), and where the
 * hips go. `heading` (radians, 0 = facing +Z, turning towards +X) is where the
 * character faces now. `hips` = { height (share of standing hips height), offset
 * [x, y, z] metres }; `ground` (default true) lowers or raises the body until its
 * lowest joint is on the floor, unless a height is given. `flatFeet` (default true)
 * keeps a foot the pose does not point level while its shin stands roughly upright.
 */
export function solvePoseSpec(parts, { heading = 0, ground = true, hips = {}, flatFeet = true } = {}) {
    const local = {};
    const footSet = new Set();
    for (const [k, moves] of Object.entries(parts)) {
        const [part, side] = k.split(".");
        const P = PARTS[part];
        if (!P) continue;
        const joint = P.sided ? (side === "R" ? "Right" : "Left") + P.joint : P.joint;
        local[joint] = partTurn(part, moves, side === "R" ? -1 : 1);
        if (part === "foot" && Number.isFinite(Number(moves.point))) footSet.add(joint);
    }
    const head = quat.axisAngle([0, 1, 0], heading);
    const global = {}, at = {};
    for (const j of Object.keys(PARENT)) {
        const p = PARENT[j];
        let l = local[j] || [0, 0, 0, 1];
        // A foot the pose does not point stays flat on the floor (turned as the shin faces)
        // while the shin stands within 60 degrees of upright: bent knees keep the soles down.
        if (flatFeet && j.endsWith("Foot") && !footSet.has(j) && quat.rotate(global[p], [0, -1, 0])[1] < -0.5) {
            const fw = quat.rotate(global[p], [0, 0, 1]);
            const yaw = Math.hypot(fw[0], fw[2]) > 1e-6 ? Math.atan2(fw[0], fw[2]) : heading;
            const turn = (Number((parts[`foot.${j.startsWith("Left") ? "L" : "R"}`] || {}).turn) || 0) * DEG * (j.startsWith("Left") ? 1 : -1);
            l = quat.mul(quat.conj(global[p]), quat.axisAngle([0, 1, 0], yaw + turn));
        }
        global[j] = quat.norm(p ? quat.mul(global[p], l) : quat.mul(head, l));
        if (!p) { at[j] = [0, 0, 0]; continue; }
        const d = SOMA_T[j].map((v, i) => v - SOMA_T[p][i]);
        const r = quat.rotate(global[p], d);
        at[j] = at[p].map((v, i) => v + r[i]);
    }
    let y = SOMA_HIPS;
    const h = Number(hips.height);
    if (Number.isFinite(h)) y = SOMA_HIPS * h;
    else if (ground !== false) y = -Math.min(...Object.values(at).map((p) => p[1]));
    const off = Array.isArray(hips.offset) ? hips.offset.map((v) => Number(v) || 0) : [0, 0, 0];
    // The offset is in the character's own directions (x its left, z its front).
    const o = quat.rotate(head, [off[0] || 0, 0, off[2] || 0]);
    const root = [o[0], y + (off[1] || 0), o[2]];
    const joints = {};
    for (const j of POSE_JOINTS) joints[j] = global[j].map((v) => Math.round(v * 1e6) / 1e6);
    return { joints, root, points: at };
}

/** A solved pose as a one-frame motion, shaped as the motion model's answer. */
export function poseMotion(solved) {
    return { fps: MOTION_FPS, joints: POSE_JOINTS.slice(),
             samples: [{ rot: [POSE_JOINTS.map((j) => solved.joints[j])], root: [solved.root.slice()], contacts: null }] };
}

/** The named poses, for the agent and the dialog: [{ name, note }]. */
export function presetList() {
    return Object.entries(PRESETS).map(([name, p]) => ({ name, note: p.note }));
}

/**
 * The way the character faces before a pose is laid on: the hips' heading at the frame,
 * unless that heading is one a pose of ours made - then the heading that pose started
 * from. Otherwise a pose's own hips turn would be taken as where the character faces and
 * asking for the same pose twice would turn it twice.
 */
export function poseBaseHeading(model, now) {
    const seen = model && model.rigPoseBase;
    if (!seen) return now;
    for (const [base, posed] of Object.values(seen)) {
        if (Math.abs(Math.atan2(Math.sin(now - posed), Math.cos(now - posed))) < 0.01) return base;
    }
    return now;
}

/** Keep where the pose on frame `f` started from and the heading it gave the hips. */
export function rememberPoseBase(model, f, base, motion) {
    if (!model) return;
    const s = motion && motion.samples && motion.samples[0];
    const i = motion && motion.joints ? motion.joints.indexOf("Hips") : -1;
    const q = s && i >= 0 && s.rot[0] && s.rot[0][i];
    if (!q) return;
    const posed = headingOf({ joints: { Hips: q } });
    model.rigPoseBase = { ...(model.rigPoseBase || {}), [f]: [Math.round(base * 1e6) / 1e6, Math.round(posed * 1e6) / 1e6] };
}
