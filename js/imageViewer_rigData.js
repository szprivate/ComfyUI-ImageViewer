// imageViewer_rigData.js
// Character rigs in a previz scene: the data and the maths, no three.js, no DOM.
//
// A rigged character is a model item (a skinned .glb / .fbx) plus a set of
// CONTROLS — ordinary scene items of kind "control" hanging under a rig group
// under the model. Being scene items is the point: the outliner lists them,
// the gizmo moves them, the Channel Box and the Curve Editor key them, undo
// and the node widget carry them, exactly like any box or camera. The bones
// themselves are never keyed; each frame the view (imageViewer_rig3d.js)
// poses them from where the controls are.
//
// A CONTROL item carries, beside the usual channels:
//   rest     4x4 (column-major, three.js order) — where the control sits, in
//            its parent's space, with every channel at zero. It is applied
//            ABOVE the channels: T(rest) · T(position) · R · S. So a control
//            reads 0 0 0 at the rig's rest pose, which is what an animator
//            expects of one (Maya does it with an offset group).
//   control  { model, type, role, side, bone, chain, bind, hinge, shape, ... }
//            type: "root"  the whole character, on the ground
//                  "cog"   centre of gravity — the hips and all above them
//                  "fk"    turns one bone (any bone of any creature)
//                  "ik"    the end of a limb: hand or foot; `chain` is the
//                          three bones [upper, lower, end] it solves
//                  "pole"  where the elbow / knee points
//            bind   4x4 from the control's space to its bone's (fk: the bone,
//                   ik: the limb's end bone), taken at the rest pose.
//            hinge  the limb's bend axis in the upper bone's own space (ik).
// An IK control also has an `ikfk` channel, 0 = the limb follows its FK
// controls, 1 = it follows the IK control; anything between blends.
//
// Everything here works in MODEL SPACE: the space of the model item's own
// geometry (its `inner` node in the view), so moving the model moves the rig.
//
// RETARGETING (imported motion, AI motion) goes through one shared pose
// space — CANONICAL: a T-pose, Y up, facing +Z, the character's left along
// +X. Each humanoid role has a known direction in it (the left arm points +X,
// the spine points up). A pose is written as, per role, the rotation that
// takes the bone from its canonical T-pose to where it is. Any skeleton can
// be read into that and any rig written from it, whatever its bone names,
// rest pose (T or A) or bone axes.
//
// The maths is textbook (rigid transforms, quaternions, the law of cosines
// for two-bone IK, minimal-arc rotations), written for this file.

// ── Small maths: vec3, quaternions [x, y, z, w], column-major 4x4 ─────────────

export const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};

export const quat = {
    identity: () => [0, 0, 0, 1],
    mul(a, b) {
        const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
        return [ax * bw + aw * bx + ay * bz - az * by,
                ay * bw + aw * by + az * bx - ax * bz,
                az * bw + aw * bz + ax * by - ay * bx,
                aw * bw - ax * bx - ay * by - az * bz];
    },
    conj: (q) => [-q[0], -q[1], -q[2], q[3]],
    norm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
    rotate(q, v) {
        const p = quat.mul(quat.mul(q, [v[0], v[1], v[2], 0]), quat.conj(q));
        return [p[0], p[1], p[2]];
    },
    axisAngle(axis, angle) {
        const a = v3.norm(axis), s = Math.sin(angle / 2);
        return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
    },
    /** The smallest rotation taking direction `a` onto direction `b`. */
    between(a, b) {
        const u = v3.norm(a), w = v3.norm(b);
        const d = v3.dot(u, w);
        if (d > 1 - 1e-12) return [0, 0, 0, 1];
        if (d < -1 + 1e-12) {
            let axis = v3.cross([1, 0, 0], u);
            if (v3.len(axis) < 1e-6) axis = v3.cross([0, 1, 0], u);
            return quat.axisAngle(axis, Math.PI);
        }
        const c = v3.cross(u, w);
        return quat.norm([c[0], c[1], c[2], 1 + d]);
    },
    slerp(a, b, t) {
        let [bx, by, bz, bw] = b;
        let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
        if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        if (cos > 0.9995) {
            return quat.norm([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t,
                              a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
        }
        const th = Math.acos(cos), s = Math.sin(th);
        const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
        return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
    },
    /** From XYZ Euler angles in degrees — three.js's 'XYZ' order (R = Rx·Ry·Rz). */
    fromEulerDeg(e) {
        const D = Math.PI / 360;
        const c1 = Math.cos(e[0] * D), c2 = Math.cos(e[1] * D), c3 = Math.cos(e[2] * D);
        const s1 = Math.sin(e[0] * D), s2 = Math.sin(e[1] * D), s3 = Math.sin(e[2] * D);
        return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
                c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
    },
    /** XYZ Euler degrees; `near` picks the turn closest to a previous value. */
    toEulerDeg(q, near = null) {
        const m = mat4.compose([0, 0, 0], q, [1, 1, 1]);
        const R = 180 / Math.PI;
        const m13 = Math.max(-1, Math.min(1, m[8]));
        let x, y = Math.asin(m13), z;
        if (Math.abs(m13) < 0.9999999) { x = Math.atan2(-m[9], m[10]); z = Math.atan2(-m[4], m[0]); }
        else { x = Math.atan2(m[6], m[5]); z = 0; }
        const out = [x * R, y * R, z * R];
        if (near) for (let i = 0; i < 3; i++) out[i] += 360 * Math.round((near[i] - out[i]) / 360);
        return out.map((v) => (Math.abs(v) < 1e-9 ? 0 : v));
    },
};

export const mat4 = {
    identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    mul(a, b) {
        const o = new Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
            }
        }
        return o;
    },
    compose(p, q, s) {
        const [x, y, z, w] = q;
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
                (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
                (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
                p[0], p[1], p[2], 1];
    },
    decompose(m) {
        let sx = Math.hypot(m[0], m[1], m[2]);
        const sy = Math.hypot(m[4], m[5], m[6]);
        const sz = Math.hypot(m[8], m[9], m[10]);
        if (mat4.det(m) < 0) sx = -sx;
        const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
        // rotation matrix (column-major 3x3) to quaternion
        const m11 = r[0], m12 = r[3], m13 = r[6], m21 = r[1], m22 = r[4], m23 = r[7], m31 = r[2], m32 = r[5], m33 = r[8];
        const tr = m11 + m22 + m33;
        let q;
        if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
        else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
        else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
        else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]; }
        return { p: [m[12], m[13], m[14]], q: quat.norm(q), s: [sx, sy, sz] };
    },
    det(m) {
        const [a, b, c, , d, e, f, , g, h, i] = m;
        return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
    },
    invert(m) {
        const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = m;
        const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
        const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
        const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
        const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
        const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
        if (det === 0) return mat4.identity();
        const id = 1 / det;
        return [
            t11 * id,
            (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * id,
            (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * id,
            (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * id,
            t12 * id,
            (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * id,
            (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * id,
            (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * id,
            t13 * id,
            (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * id,
            (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * id,
            (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * id,
            t14 * id,
            (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * id,
            (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * id,
            (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * id,
        ];
    },
    /** T(position)·R(euler deg)·S — a channel set as a matrix. */
    fromChannels(position, rotationDeg, scale) {
        return mat4.compose(position || [0, 0, 0], quat.fromEulerDeg(rotationDeg || [0, 0, 0]), scale || [1, 1, 1]);
    },
    point: (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
                      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
                      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]],
    /** The same transform with its scale taken out (a control never scales its bone). */
    rigid(m) { const d = mat4.decompose(m); return mat4.compose(d.p, d.q, [1, 1, 1]); },
};

// ── Humanoid roles ───────────────────────────────────────────────────────────

// Every role a humanoid control rig knows, its parent role, and the direction
// the bone points in the canonical T-pose (from its head towards its child's).
export const HUMANOID = [
    { role: "hips",       parent: null,         dir: [0, 1, 0] },
    { role: "spine",      parent: "hips",       dir: [0, 1, 0] },
    { role: "chest",      parent: "spine",      dir: [0, 1, 0] },
    { role: "upperChest", parent: "chest",      dir: [0, 1, 0], optional: true },
    { role: "neck",       parent: "upperChest", dir: [0, 1, 0] },
    { role: "head",       parent: "neck",       dir: [0, 1, 0] },
    { role: "shoulder.L", parent: "upperChest", dir: [1, 0, 0], optional: true },
    { role: "upperArm.L", parent: "shoulder.L", dir: [1, 0, 0] },
    { role: "lowerArm.L", parent: "upperArm.L", dir: [1, 0, 0] },
    { role: "hand.L",     parent: "lowerArm.L", dir: [1, 0, 0] },
    { role: "shoulder.R", parent: "upperChest", dir: [-1, 0, 0], optional: true },
    { role: "upperArm.R", parent: "shoulder.R", dir: [-1, 0, 0] },
    { role: "lowerArm.R", parent: "upperArm.R", dir: [-1, 0, 0] },
    { role: "hand.R",     parent: "lowerArm.R", dir: [-1, 0, 0] },
    { role: "upperLeg.L", parent: "hips",       dir: [0, -1, 0] },
    { role: "lowerLeg.L", parent: "upperLeg.L", dir: [0, -1, 0] },
    { role: "foot.L",     parent: "lowerLeg.L", dir: [0, -1, 0] },
    { role: "toes.L",     parent: "foot.L",     dir: [0, 0, 1], optional: true },
    { role: "upperLeg.R", parent: "hips",       dir: [0, -1, 0] },
    { role: "lowerLeg.R", parent: "upperLeg.R", dir: [0, -1, 0] },
    { role: "foot.R",     parent: "lowerLeg.R", dir: [0, -1, 0] },
    { role: "toes.R",     parent: "foot.R",     dir: [0, 0, 1], optional: true },
];
export const ROLE = Object.fromEntries(HUMANOID.map((r) => [r.role, r]));
// The foot points mostly down at its head (ankle → ball), but its forward
// direction is what keeps it from spinning: its canonical "dir" is down, and
// its second axis forward. Every role has a second axis for the same reason.
const ROLE_UP = { "foot.L": [0, 0, 1], "foot.R": [0, 0, 1], "toes.L": [0, 1, 0], "toes.R": [0, 1, 0] };
export function roleSecondAxis(role) {
    if (ROLE_UP[role]) return ROLE_UP[role];
    const d = ROLE[role] ? ROLE[role].dir : [0, 1, 0];
    return Math.abs(d[1]) > 0.5 ? [0, 0, 1] : [0, 1, 0];
}

// The four limbs that get IK: [upper, lower, end] and which way the joint bends.
export const LIMBS = [
    { name: "arm.L", chain: ["upperArm.L", "lowerArm.L", "hand.L"], bend: [0, 0, -1], side: "L" },
    { name: "arm.R", chain: ["upperArm.R", "lowerArm.R", "hand.R"], bend: [0, 0, -1], side: "R" },
    { name: "leg.L", chain: ["upperLeg.L", "lowerLeg.L", "foot.L"], bend: [0, 0, 1], side: "L" },
    { name: "leg.R", chain: ["upperLeg.R", "lowerLeg.R", "foot.R"], bend: [0, 0, 1], side: "R" },
];

// ── Reading bone names ───────────────────────────────────────────────────────

// Prefixes the common exporters put in front of every bone.
const PREFIXES = [/^mixamorig\d*[\s:_]/, /^cc_base_/, /^j_bip_[clr]_/, /^bip\d*[\s_]/, /^def[-_]/,
                  /^org[-_]/, /^armature[|:_.]/, /^skeleton[|:_.]/, /^root[|:]/, /^[a-z0-9]+:/];

/** A bone name reduced to lower case words, its side taken out: { base, side }. */
export function splitName(name) {
    let s = String(name || "");
    // camelCase → words before lowercasing, so LeftUpLeg reads "left up leg"
    s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    const raw = String(name || "").toLowerCase();
    let side = "";
    // J_Bip_L_UpperArm / CC_Base_L_Upperarm / Bip01 L Thigh carry the side in the prefix
    const pre = raw.match(/^(?:j_bip_|cc_base_|bip\d*[\s_])([lr])[\s_]/);
    if (pre) side = pre[1].toUpperCase();
    for (const p of PREFIXES) s = s.replace(p, "");
    s = s.replace(/[._\-:|]+/g, " ").trim();
    const words = s.split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w === "left" || w === "l" || w === "lf" || w === "lt") { side = side || "L"; continue; }
        if (w === "right" || w === "r" || w === "rt") { side = side || "R"; continue; }
        // leftarm, rightupleg written as one word
        const m = w.match(/^(left|right)(.+)$/);
        if (m) { side = side || (m[1] === "left" ? "L" : "R"); out.push(m[2]); continue; }
        out.push(w);
    }
    return { base: out.join(" "), side };
}

// What a role is called, word patterns tried in order. Spine is special: a
// chain, numbered from the hips up, so it is sorted out after this.
const ROLE_WORDS = [
    ["toes", /\b(toe ?base|toe|toes|ball)\b(?!.*end)/],
    ["foot", /\b(foot|ankle)\b/],
    ["lowerLeg", /\b(lower ?leg|leg|calf|shin|knee|lowerleg)\b/],
    ["upperLeg", /\b(up ?leg|upper ?leg|thigh|upperleg|upleg)\b/],
    ["hand", /\b(hand|wrist)\b/],
    ["lowerArm", /\b(fore ?arm|lower ?arm|elbow|lowerarm|forearm)\b/],
    ["upperArm", /\b(upper ?arm|arm|upperarm)\b/],
    ["shoulder", /\b(shoulder|clavicle|collar|clav)\b/],
];

function _isEndBone(name, kids) {
    return kids === 0 && /(end|nub|tip|top)\b|_end$|end$/i.test(String(name));
}

/**
 * Find the humanoid roles in a skeleton.
 *
 * `bones`: [{ name, parent (a name or null), head: [x, y, z] in model space }].
 * Answers { roles: { role: boneName }, humanoid: bool, missing: [roles] }.
 * Names are tried first (Mixamo, Unreal, VRM, Character Creator, Biped,
 * Rigify, Blender's .L/.R); a skeleton whose names say nothing — an
 * auto-rigger's bone_12 — is read from its shape instead.
 */
export function matchHumanoid(bones) {
    const byName = new Map(bones.map((b) => [b.name, b]));
    const kids = new Map(bones.map((b) => [b.name, []]));
    for (const b of bones) if (b.parent && kids.has(b.parent)) kids.get(b.parent).push(b.name);
    const roles = {};
    // Fingers are under the hand: their words (index, middle, thumb...) never
    // count as an arm or a leg.
    const fingerish = /\b(thumb|index|middle|ring|pinky|little|finger|digit)/;
    for (const b of bones) {
        const { base, side } = splitName(b.name);
        if (!base || fingerish.test(base) || _isEndBone(b.name, kids.get(b.name).length)) continue;
        if (!side) continue;
        for (const [role, re] of ROLE_WORDS) {
            if (!re.test(base)) continue;
            const key = `${role}.${side}`;
            // The first (highest in the tree) match wins: "upperarm twist" comes after "upperarm".
            if (!roles[key] || _depth(byName, b.name) < _depth(byName, roles[key])) roles[key] = b.name;
            break;
        }
    }
    // Centre line: hips, spine chain, neck, head.
    const centre = bones.filter((b) => !splitName(b.name).side);
    const find = (re) => centre.find((b) => re.test(splitName(b.name).base) && !_isEndBone(b.name, kids.get(b.name).length));
    const hips = find(/\b(hips|pelvis|hip)\b/);
    if (hips) roles.hips = hips.name;
    const head = find(/\bhead\b/);
    if (head) roles.head = head.name;
    const neck = find(/\bneck\b/);
    if (neck) roles.neck = neck.name;
    if (roles.hips && (roles.neck || roles.head)) {
        // The spine is whatever lies between the hips and the neck.
        const top = roles.neck || roles.head;
        const chain = [];
        for (let n = byName.get(top) && byName.get(top).parent; n && n !== roles.hips; n = byName.get(n) && byName.get(n).parent) {
            chain.unshift(n);
        }
        if (chain.length >= 1 && byName.get(chain[0]) && byName.get(chain[0]).parent !== undefined) {
            roles.spine = chain[0];
            if (chain.length >= 3) { roles.chest = chain[Math.floor((chain.length - 1) / 2)]; roles.upperChest = chain[chain.length - 1]; }
            else if (chain.length === 2) { roles.chest = chain[1]; }
            else roles.chest = chain[0];
            if (roles.chest === roles.spine && chain.length === 1) delete roles.upperChest;
        }
        if (!roles.neck && roles.head) roles.neck = roles.upperChest || roles.chest;
    }
    if (!_complete(roles)) {
        const shaped = matchByShape(bones);
        if (_complete(shaped)) return { roles: shaped, humanoid: true, missing: [], byShape: true };
    }
    _fillChain(roles);
    const missing = HUMANOID.filter((r) => !r.optional && !roles[r.role]).map((r) => r.role);
    return { roles, humanoid: missing.length === 0, missing };
}

function _depth(byName, name) {
    let d = 0;
    for (let n = byName.get(name); n && n.parent; n = byName.get(n.parent)) d++;
    return d;
}

function _complete(roles) {
    return HUMANOID.every((r) => r.optional || roles[r.role]);
}

// upperChest and shoulder are optional; a rig without them hangs the next
// role from the one above instead.
function _fillChain(roles) {
    if (!roles.upperChest && roles.chest) roles.upperChest = roles.chest;
    return roles;
}

/**
 * Roles read from where the bones are, for a skeleton whose names say
 * nothing. A humanoid standing up: the root with two chains going down (legs)
 * and one going up; up there, two chains going out sideways (arms) and one
 * carrying on up (neck, head). The character's left is +X.
 */
export function matchByShape(bones) {
    const byName = new Map(bones.map((b) => [b.name, b]));
    const kids = new Map(bones.map((b) => [b.name, []]));
    for (const b of bones) if (b.parent && kids.has(b.parent)) kids.get(b.parent).push(b.name);
    const roots = bones.filter((b) => !b.parent || !byName.has(b.parent));
    if (!roots.length) return {};
    // Longest straight-ish chain from a bone, following its child furthest along `dir`.
    const follow = (start, dir, max = 8) => {
        const out = [start];
        let cur = start;
        for (let i = 0; i < max; i++) {
            const k = kids.get(cur) || [];
            if (!k.length) break;
            const head = byName.get(cur).head;
            let best = null, bestScore = -Infinity;
            for (const c of k) {
                const d = v3.norm(v3.sub(byName.get(c).head, head));
                // Direction decides; the size of what hangs below only breaks a tie (an arm with five
                // fingers must not win over the neck going straight up).
                const score = v3.dot(d, dir) + 1e-3 * Math.min(_subtree(kids, c), 20);
                if (score > bestScore) { bestScore = score; best = c; }
            }
            if (best === null || bestScore < 0.2) break;
            out.push(best);
            cur = best;
        }
        return out;
    };
    // The hips: the first bone with two children going down and one going up.
    let hips = null;
    const walk = [roots[0].name];
    while (walk.length) {
        const n = walk.shift();
        const k = kids.get(n) || [];
        const head = byName.get(n).head;
        const down = k.filter((c) => byName.get(c).head[1] < head[1] - 1e-4 || _lowest(byName, kids, c) < head[1] - 0.2 * _height(bones));
        const up = k.filter((c) => !down.includes(c));
        if (down.length >= 2 && up.length >= 1) { hips = n; break; }
        walk.push(...k);
    }
    if (!hips) return {};
    const roles = { hips };
    const hk = kids.get(hips);
    const hipHead = byName.get(hips).head;
    const legs = hk.filter((c) => _lowest(byName, kids, c) < hipHead[1] - 0.2 * _height(bones))
        .sort((a, b) => byName.get(b).head[0] - byName.get(a).head[0]);
    const spineStart = hk.filter((c) => !legs.includes(c))
        .sort((a, b) => _subtree(kids, b) - _subtree(kids, a))[0];
    const leg = (start, side) => {
        const c = follow(start, [0, -1, 0], 4);
        if (c.length >= 3) {
            roles[`upperLeg.${side}`] = c[0]; roles[`lowerLeg.${side}`] = c[1]; roles[`foot.${side}`] = c[2];
            const toe = (kids.get(c[2]) || []).sort((a, b) => byName.get(b).head[2] - byName.get(a).head[2])[0];
            if (toe) roles[`toes.${side}`] = toe;
        }
    };
    if (legs.length >= 2) { leg(legs[0], "L"); leg(legs[legs.length - 1], "R"); }
    if (!spineStart) return roles;
    // Up the spine to the bone where the arms branch off.
    const spine = follow(spineStart, [0, 1, 0], 12);
    let branch = -1;
    for (let i = 0; i < spine.length; i++) {
        const k = kids.get(spine[i]) || [];
        const side = k.filter((c) => Math.abs(byName.get(c).head[0] - byName.get(spine[i]).head[0]) > 1e-4
            || Math.abs(_farthestX(byName, kids, c)) > 0.15 * _height(bones));
        if (side.length >= 2) { branch = i; break; }
    }
    if (branch < 0) return roles;
    const chain = spine.slice(0, branch + 1);
    roles.spine = chain[0];
    roles.chest = chain[Math.min(chain.length - 1, Math.max(0, Math.floor((chain.length - 1) / 2)))];
    roles.upperChest = chain[chain.length - 1];
    const top = spine[branch];
    const after = spine.slice(branch + 1);
    if (after.length >= 2) { roles.neck = after[0]; roles.head = after[1]; }
    else if (after.length === 1) { roles.neck = after[0]; roles.head = after[0]; }
    const arms = (kids.get(top) || []).filter((c) => !after.includes(c))
        .sort((a, b) => _farthestX(byName, kids, b) - _farthestX(byName, kids, a));
    const arm = (start, side, sign) => {
        let c = follow(start, [sign, 0, 0], 5);
        // A clavicle first: a short bone before the long upper arm.
        if (c.length >= 4) { roles[`shoulder.${side}`] = c[0]; c = c.slice(1); }
        if (c.length >= 3) { roles[`upperArm.${side}`] = c[0]; roles[`lowerArm.${side}`] = c[1]; roles[`hand.${side}`] = c[2]; }
    };
    if (arms.length >= 2) { arm(arms[0], "L", 1); arm(arms[arms.length - 1], "R", -1); }
    return roles;
}

function _subtree(kids, n) { let c = 1; for (const k of kids.get(n) || []) c += _subtree(kids, k); return c; }
function _lowest(byName, kids, n) { let y = byName.get(n).head[1]; for (const k of kids.get(n) || []) y = Math.min(y, _lowest(byName, kids, k)); return y; }
function _farthestX(byName, kids, n) {
    let x = byName.get(n).head[0];
    for (const k of kids.get(n) || []) { const kx = _farthestX(byName, kids, k); if (Math.abs(kx) > Math.abs(x)) x = kx; }
    return x;
}
function _height(bones) {
    let lo = Infinity, hi = -Infinity;
    for (const b of bones) { lo = Math.min(lo, b.head[1]); hi = Math.max(hi, b.head[1]); }
    return Math.max(1e-6, hi - lo);
}

// ── Building the control rig ─────────────────────────────────────────────────

const COLORS = { L: "#3d8bff", R: "#ff4d5a", C: "#ffd24d", root: "#e8e8e8", ik: "#4dff9a" };

let _cseq = 0;
function _cid() { _cseq += 1; return `k${Date.now().toString(36)}${_cseq.toString(36)}`; }

function _sideOf(role, boneName) {
    if (role && /\.L$/.test(role)) return "L";
    if (role && /\.R$/.test(role)) return "R";
    const s = splitName(boneName).side;
    return s || "C";
}

/**
 * The controls for a skinned model.
 *
 * `model`  the scene item of the character
 * `skeleton` { bones: [{ name, parent, world: 4x4 model-space rest matrix }] }
 *          — in parent-before-child order
 * `opts`   { humanoid: true to try IK limbs, COG and so on (default),
 *            size: the character's height, for shape sizes }
 *
 * Answers { group, items, roles, humanoid }: the rig group and every control
 * item, ready to push into scene.items (group first, parents before children).
 */
export function buildRig(model, skeleton, opts = {}) {
    const bones = skeleton.bones.map((b) => ({ ...b, head: [b.world[12], b.world[13], b.world[14]] }));
    const byName = new Map(bones.map((b) => [b.name, b]));
    const kids = new Map(bones.map((b) => [b.name, []]));
    for (const b of bones) if (b.parent && kids.has(b.parent)) kids.get(b.parent).push(b.name);
    const height = opts.size || _height(bones) || 1;
    const match = opts.humanoid === false ? { roles: {}, humanoid: false, missing: [] } : matchHumanoid(bones);
    const humanoid = !!match.humanoid;
    const roles = humanoid ? match.roles : {};
    const roleOf = new Map();
    for (const [role, name] of Object.entries(roles)) if (!roleOf.has(name)) roleOf.set(name, role);

    const group = {
        id: _cid(), kind: "group", name: `${model.name} rig`, parent: model.id,
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0],
        visible: true, tracks: {}, rig: { model: model.id, humanoid, roles },
    };
    const items = [];
    const restWorld = new Map();          // control id -> model-space rest matrix (rigid)
    const make = (name, parentId, world, control) => {
        const parentWorld = parentId && restWorld.has(parentId) ? restWorld.get(parentId) : mat4.identity();
        const item = {
            id: _cid(), kind: "control", name, parent: parentId || group.id,
            position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0],
            visible: true, tracks: {},
            rest: mat4.mul(mat4.invert(parentWorld), world),
            control: { model: model.id, ...control },
        };
        restWorld.set(item.id, world);
        items.push(item);
        return item;
    };

    // Root: on the ground under the character, facing the world.
    const rootBone = bones.find((b) => !b.parent || !byName.has(b.parent));
    const base = rootBone ? rootBone.head : [0, 0, 0];
    const root = make("root_ctrl", null, mat4.compose([base[0], 0, base[2]], [0, 0, 0, 1], [1, 1, 1]), {
        type: "root", role: "root", side: "C", shape: { type: "root", size: 0.45 * height, color: COLORS.root },
    });

    let cog = null;
    if (humanoid) {
        const h = byName.get(roles.hips).head;
        cog = make("cog_ctrl", root.id, mat4.compose(h, [0, 0, 0, 1], [1, 1, 1]), {
            type: "cog", role: "cog", side: "C", shape: { type: "square", size: 0.28 * height, color: COLORS.C, axis: [0, 1, 0] },
        });
    }

    // One FK control per bone, aligned with the bone, parented like the bones.
    const fkOf = new Map();
    for (const b of bones) {
        const nk = kids.get(b.name).length;
        if (_isEndBone(b.name, nk)) continue;
        const role = roleOf.get(b.name) || null;
        const parentFk = b.parent && fkOf.get(b.parent);
        const parentId = parentFk ? parentFk.id : (cog && role === "hips" ? cog.id : root.id);
        const world = mat4.rigid(b.world);
        // Which way the bone points, in the control's own space: the circle
        // goes round that axis.
        const child = kids.get(b.name).map((k) => byName.get(k))
            .sort((x, y) => _subtree(kids, y.name) - _subtree(kids, x.name))[0];
        let length = child ? v3.dist(child.head, b.head) : 0.05 * height;
        let axis = [0, 1, 0];
        if (child && length > 1e-6) {
            const inv = mat4.invert(world);
            const local = mat4.point(inv, child.head);
            axis = v3.norm(local);
        }
        if (!(length > 1e-6)) length = 0.05 * height;
        const side = _sideOf(role, b.name);
        const isHips = role === "hips";
        const size = isHips ? 0.18 * height : Math.max(0.03 * height, Math.min(0.12 * height, 0.45 * length));
        const fk = make(`${b.name}_fk`, parentId, world, {
            type: "fk", role, side, bone: b.name,
            bind: mat4.mul(mat4.invert(world), b.world),
            shape: { type: "circle", size, axis, color: COLORS[side] || COLORS.C },
        });
        fkOf.set(b.name, fk);
    }

    // IK on the four limbs, plus a pole for each.
    if (humanoid) {
        for (const limb of LIMBS) {
            const names = limb.chain.map((r) => roles[r]);
            if (names.some((n) => !n || !byName.get(n))) continue;
            const [A, B, C] = names.map((n) => byName.get(n));
            const isLeg = limb.name.startsWith("leg");
            // A foot control sits at the ankle, flat on the world; a hand
            // control is aligned with the hand.
            const endWorld = isLeg ? mat4.compose(C.head, [0, 0, 0, 1], [1, 1, 1]) : mat4.rigid(C.world);
            const ik = make(`${limb.name.replace(".", "_")}_ik`, root.id, endWorld, {
                type: "ik", role: limb.name, side: limb.side, chain: names,
                bind: mat4.mul(mat4.invert(endWorld), C.world),
                shape: { type: isLeg ? "foot" : "cube", size: (isLeg ? 0.09 : 0.06) * height, color: COLORS[limb.side] },
            });
            ik.ikfk = 1;
            const lenA = v3.dist(A.head, B.head), lenB = v3.dist(B.head, C.head);
            const bend = _bendDirection(A.head, B.head, C.head, limb.bend);
            const polePos = v3.add(B.head, v3.scale(bend, (lenA + lenB) * 0.6));
            const pole = make(`${limb.name.replace(".", "_")}_pole`, root.id, mat4.compose(polePos, [0, 0, 0, 1], [1, 1, 1]), {
                type: "pole", role: limb.name, side: limb.side, ik: ik.id,
                shape: { type: "diamond", size: 0.035 * height, color: COLORS[limb.side] },
            });
            ik.control.pole = pole.id;
            ik.control.hinge = _hingeLocal(A, B, C, polePos);
            ik.control.lengths = [lenA, lenB];
        }
    }
    return { group, items, roles, humanoid, missing: match.missing || [] };
}

/** The way a limb bends, at rest: off the straight line, or `hint` if it is straight. */
function _bendDirection(a, b, c, hint) {
    const axis = v3.norm(v3.sub(c, a));
    const off = v3.sub(b, v3.add(a, v3.scale(axis, v3.dot(v3.sub(b, a), axis))));
    if (v3.len(off) > 1e-3 * v3.dist(a, c)) return v3.norm(off);
    const h = v3.sub(hint, v3.scale(axis, v3.dot(hint, axis)));
    return v3.len(h) > 1e-6 ? v3.norm(h) : v3.norm(v3.cross(axis, [0, 1, 0]));
}

/**
 * The limb's hinge axis, in the upper bone's own space. Taken from the bend
 * the limb has at rest — towards the pole — so the solver turns the elbow the
 * way it already folds.
 */
function _hingeLocal(A, B, C, polePos) {
    const pa = A.head, pc = C.head;
    const u = v3.norm(v3.sub(pc, pa));
    let v = v3.sub(polePos, pa);
    v = v3.norm(v3.sub(v, v3.scale(u, v3.dot(v, u))));
    // The knee sits towards the pole: hinge = (pa→knee) × (knee→pc), as the solver measures it.
    const knee = v3.add(B.head, v3.scale(v, 0.01 * v3.dist(pa, pc)));
    const hinge = v3.norm(v3.cross(v3.sub(knee, pa), v3.sub(pc, knee)));
    const qa = mat4.decompose(A.world).q;
    return quat.rotate(quat.conj(qa), hinge);
}

// ── Two-bone IK ──────────────────────────────────────────────────────────────

/**
 * Solve a limb. Positions are the joints as the FK pose has them (pa shoulder
 * / hip, pb elbow / knee, pc wrist / ankle); qa, qb the upper and lower bones'
 * world rotations in that pose. `hinge` is the upper bone's bend axis in its
 * own space, `lengths` the rest lengths. Answers the new world rotations
 * { qa, qb } and where the joints end up { pb, pc }.
 */
export function solveTwoBone({ pa, pb, pc, qa, qb, target, pole, hinge, lengths }) {
    const l1 = lengths ? lengths[0] : v3.dist(pa, pb);
    const l2 = lengths ? lengths[1] : v3.dist(pb, pc);
    let toT = v3.sub(target, pa);
    let d = v3.len(toT);
    const reach = (l1 + l2) * 0.99999;
    d = Math.max(Math.abs(l1 - l2) + 1e-6, Math.min(reach, d));
    const u = d > 1e-9 ? v3.norm(toT) : v3.norm(v3.sub(pc, pa));
    let v = v3.sub(pole, pa);
    v = v3.sub(v, v3.scale(u, v3.dot(v, u)));
    if (v3.len(v) < 1e-9) v = v3.sub(pb, v3.add(pa, v3.scale(u, v3.dot(v3.sub(pb, pa), u))));
    v = v3.len(v) < 1e-9 ? v3.norm(v3.cross(u, [0, 1, 0])) : v3.norm(v);
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const knee = v3.add(pa, v3.add(v3.scale(u, a), v3.scale(v, h)));
    const end = v3.add(pa, v3.scale(u, d));
    // Upper bone: turn its frame (direction, hinge) onto the solved one.
    const hingeNow = quat.rotate(qa, hinge);
    const frameFk = _frame(v3.sub(pb, pa), hingeNow);
    let hingeIk = v3.cross(v3.sub(knee, pa), v3.sub(end, knee));
    if (v3.len(hingeIk) < 1e-9) hingeIk = v3.cross(u, v);    // straight: the pole decides
    const frameIk = _frame(v3.sub(knee, pa), hingeIk);
    const dA = quat.mul(frameIk, quat.conj(frameFk));
    const qa2 = quat.norm(quat.mul(dA, qa));
    // Lower bone: carried round by the upper, then swung onto the target.
    const qbCarried = quat.norm(quat.mul(dA, qb));
    const lowerNow = quat.rotate(dA, v3.sub(pc, pb));
    const dB = quat.between(lowerNow, v3.sub(end, knee));
    const qb2 = quat.norm(quat.mul(dB, qbCarried));
    return { qa: qa2, qb: qb2, pb: knee, pc: end };
}

/** A rotation whose X axis is `x` and whose Y axis is `y` made perpendicular to it. */
function _frame(x, y) {
    const X = v3.norm(x);
    let Y = v3.sub(y, v3.scale(X, v3.dot(y, X)));
    Y = v3.len(Y) > 1e-9 ? v3.norm(Y) : v3.norm(v3.cross(X, Math.abs(X[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const Z = v3.cross(X, Y);
    return mat4.decompose([X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, 0, 0, 0, 1]).q;
}

// ── Canonical pose space (retargeting) ───────────────────────────────────────

/**
 * Per role, the rotation that takes the bone from its own rest pose into the
 * canonical T-pose: `align · restRotation` is the bone as it would sit in a
 * T-pose. Built from where the bones' heads are.
 *
 * `rest`  Map role -> { q: model-space rest rotation, head: [x,y,z], childHead }
 * `dirs`  role -> the direction the bone points in the T-pose wanted, where
 *         it is not the role's own (a skeleton's T-pose to retarget onto).
 */
export function canonicalAlign(rest, dirs = null) {
    const out = {};
    for (const r of HUMANOID) {
        const b = rest[r.role];
        if (!b) continue;
        // An end bone (a hand, a head with no child role) carries on the
        // way its parent was turned.
        if (!b.childHead) { out[r.role] = (r.parent && (out[r.parent] || (r.parent === "upperChest" && out.chest))) || [0, 0, 0, 1]; continue; }
        const dir = v3.sub(b.childHead, b.head);
        // Swing the bone's direction onto the canonical one; then twist about
        // it so its second axis (the elbow's forward, the foot's toe) lines up
        // too, read from the bone's rest frame.
        const swing = quat.between(dir, (dirs && dirs[r.role]) || r.dir);
        out[r.role] = swing;
    }
    // Hips and the spine carry the facing of the whole body: take it from the
    // legs and arms when there are any, so a character standing turned at
    // rest still reads as facing +Z.
    return out;
}

/**
 * A pose into canonical space. `world`: role -> model-space world rotation of
 * the bone in the pose; `restQ`: role -> rest rotation; `align` from
 * canonicalAlign. Answers role -> rotation from the canonical T-pose.
 */
export function toCanonical(world, restQ, align) {
    const out = {};
    for (const role of Object.keys(world)) {
        if (!restQ[role] || !align[role]) continue;
        const tpose = quat.mul(align[role], restQ[role]);
        out[role] = quat.norm(quat.mul(world[role], quat.conj(tpose)));
    }
    return out;
}

/** ...and back out onto another skeleton: role -> model-space world rotation. */
export function fromCanonical(canon, restQ, align) {
    const out = {};
    for (const role of Object.keys(canon)) {
        if (!restQ[role] || !align[role]) continue;
        out[role] = quat.norm(quat.mul(canon[role], quat.mul(align[role], restQ[role])));
    }
    return out;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * Thin a baked track. `samples` [{ f, v }] one per frame (v a number or
 * [x,y,z]); keeps the ends and every key the straight line between its kept
 * neighbours misses by more than `tol`. Answers the kept samples.
 */
export function reduceKeys(samples, tol = 0.01) {
    if (samples.length <= 2) return samples.slice();
    const comps = (v) => (Array.isArray(v) ? v : [v]);
    const keep = new Array(samples.length).fill(false);
    keep[0] = keep[samples.length - 1] = true;
    const stack = [[0, samples.length - 1]];
    while (stack.length) {
        const [i, j] = stack.pop();
        if (j - i < 2) continue;
        const a = samples[i], b = samples[j];
        let worst = -1, at = -1;
        for (let k = i + 1; k < j; k++) {
            const t = (samples[k].f - a.f) / (b.f - a.f);
            const va = comps(a.v), vb = comps(b.v), vk = comps(samples[k].v);
            let err = 0;
            for (let c = 0; c < vk.length; c++) err = Math.max(err, Math.abs(va[c] + (vb[c] - va[c]) * t - vk[c]));
            if (err > worst) { worst = err; at = k; }
        }
        if (worst > tol) { keep[at] = true; stack.push([i, at], [at, j]); }
    }
    return samples.filter((_, i) => keep[i]);
}

// ── Scene helpers ────────────────────────────────────────────────────────────

/** Every control of one character (model item id), in the scene's order. */
export function controlsOf(scene, modelId) {
    return ((scene && scene.items) || []).filter((it) => it.kind === "control" && it.control && it.control.model === modelId);
}

/** The rig group of a character, or null. */
export function rigGroupOf(scene, modelId) {
    return ((scene && scene.items) || []).find((it) => it.kind === "group" && it.rig && it.rig.model === modelId) || null;
}

export function isRigged(scene, modelId) {
    return controlsOf(scene, modelId).length > 0;
}

/** The control a bone's FK hangs on. */
export function fkControlFor(scene, modelId, bone) {
    return controlsOf(scene, modelId).find((c) => c.control.type === "fk" && c.control.bone === bone) || null;
}

/** A control's local matrix at its channels: rest · T · R · S. */
export function controlLocal(item, at) {
    const ch = mat4.fromChannels(at.position, at.rotation, at.scale);
    return item.rest ? mat4.mul(item.rest, ch) : ch;
}

/** The channels that put a control at `local` (its parent's space): position and rotation, scale kept. */
export function channelsForLocal(item, local, near = null) {
    const m = item.rest ? mat4.mul(mat4.invert(item.rest), local) : local;
    const d = mat4.decompose(m);
    const tidy = (x) => (Math.abs(x) < 1e-9 ? 0 : x);
    return { position: d.p.map(tidy), rotation: quat.toEulerDeg(d.q, near) };
}

/** Read one rig-related item from parseScene: keeps `rest` and `control`, `ikfk` and the group's `rig`. */
export function readRigFields(item, raw) {
    const m16 = (m) => (Array.isArray(m) && m.length === 16 && m.every((x) => Number.isFinite(Number(x))) ? m.map(Number) : null);
    if (raw.kind === "group" && raw.rig && typeof raw.rig === "object") {
        item.rig = { model: String(raw.rig.model || ""), humanoid: !!raw.rig.humanoid,
                     roles: raw.rig.roles && typeof raw.rig.roles === "object" ? { ...raw.rig.roles } : {} };
    }
    if (raw.kind !== "control") return item;
    const c = raw.control && typeof raw.control === "object" ? raw.control : {};
    item.rest = m16(raw.rest) || mat4.identity();
    const out = {
        model: String(c.model || ""), type: ["root", "cog", "fk", "ik", "pole", "face"].includes(c.type) ? c.type : "fk",
        role: typeof c.role === "string" ? c.role : null, side: ["L", "R", "C"].includes(c.side) ? c.side : "C",
    };
    if (typeof c.bone === "string") out.bone = c.bone;
    if (Array.isArray(c.chain) && c.chain.length === 3) out.chain = c.chain.map(String);
    if (m16(c.bind)) out.bind = m16(c.bind);
    if (Array.isArray(c.hinge) && c.hinge.length === 3) out.hinge = c.hinge.map(Number);
    if (Array.isArray(c.lengths) && c.lengths.length === 2) out.lengths = c.lengths.map(Number);
    if (typeof c.pole === "string") out.pole = c.pole;
    if (typeof c.ik === "string") out.ik = c.ik;
    // The spaces it can follow (imageViewer_rigExtras.js) and, for a facial control, what it is.
    if (Array.isArray(c.spaces)) out.spaces = c.spaces.filter((x) => typeof x === "string" && x).slice(0, 32);
    if (typeof c.face === "string") out.face = c.face.slice(0, 80);
    const sh = c.shape && typeof c.shape === "object" ? c.shape : {};
    out.shape = {
        type: ["circle", "square", "root", "cube", "foot", "diamond"].includes(sh.type) ? sh.type : "circle",
        size: Number.isFinite(Number(sh.size)) ? Number(sh.size) : 0.1,
        color: typeof sh.color === "string" ? sh.color : "#ffd24d",
    };
    if (Array.isArray(sh.axis) && sh.axis.length === 3) out.shape.axis = sh.axis.map(Number);
    item.control = out;
    if (out.type === "ik") item.ikfk = Number.isFinite(Number(raw.ikfk)) ? Math.max(0, Math.min(1, Number(raw.ikfk))) : 1;
    return item;
}
