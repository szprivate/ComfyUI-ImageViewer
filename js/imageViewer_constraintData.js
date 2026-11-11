// imageViewer_constraintData.js
// Constraints of the 3D space, as data: what a constraint IS, how it is read
// from a saved scene, and the names of its weight channels. Pure, no imports,
// so imageViewer_scene3d.js can read constraints while parsing a scene and the
// solver (imageViewer_constraints.js) can import both without a cycle.
//
// A constraint lives on the item it moves (the DRIVEN item), in a list:
//     item.constraints = [{ id, type, on, weight, targets: [{ id, w, offset }],
//                           maintainOffset, skip: { t, r, s }, aim }]
// and the list is applied in order, each one on top of what the ones before
// it left. Types (clean-room; the words are the trade's, the maths is ours):
//   point  - the driven item's position follows the weighted average of the
//            targets' positions (plus an offset each, when kept);
//   orient - its rotation follows the weighted blend of the targets' rotations;
//   scale  - its scale follows the weighted average of the targets' scales;
//   parent - it moves and turns as if it were a child of each target, blended
//            by weight (its own scale is left alone);
//   aim    - it stays where it is and turns so one of its axes points at the
//            weighted average of the targets, another axis towards "up".
//
// THE WEIGHTS ARE CHANNELS. Each target's weight is the scalar channel
// "cw:<constraint id>:<target id>" on the driven item, and the constraint's
// own weight (how much of it is applied at all, 0..1) is "ce:<constraint id>".
// Their static values are `w` and `weight` here; keyed, they are ordinary
// tracks in item.tracks, keyed, drawn and edited like any other channel.
// The weights are relative: a target's share is its weight over the sum.
//
// `offset` is what "maintain offset" captured when the constraint was made
// (the solver fills it): a vector for point, a quaternion for orient and aim,
// a scale ratio for scale, a 4x4 (column-major) for parent. null = none, the
// driven item snaps onto the target.

export const CONSTRAINT_TYPES = ["parent", "point", "orient", "scale", "aim"];
export const CONSTRAINT_LABELS = {
    parent: "Parent", point: "Point", orient: "Orient", scale: "Scale", aim: "Aim",
};
// Which of the driven item's channels each type writes (and so can skip).
export const CONSTRAINT_CHANNELS = {
    parent: ["t", "r"], point: ["t"], orient: ["r"], scale: ["s"], aim: ["r"],
};
export const AIM_UP_TYPES = ["scene", "vector", "object", "objectrotation", "none"];
export const AIM_UP_LABELS = {
    scene: "Scene up", vector: "Vector", object: "Object", objectrotation: "Object rotation", none: "None",
};
export const AXES = {
    "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0], "+Z": [0, 0, 1], "-Z": [0, 0, -1],
};
/** The axis name of a unit vector, or "" when it is none of the six. */
export function axisName(v) {
    for (const [k, a] of Object.entries(AXES)) {
        if (Array.isArray(v) && a.every((x, i) => Math.abs(x - Number(v[i])) < 1e-9)) return k;
    }
    return "";
}
export const MAX_WEIGHT = 10;

let _seq = 0;
function _id() {
    _seq += 1;
    return `cn${Date.now().toString(36)}${_seq.toString(36)}`;
}

const _num = (v, d) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const _clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const _vec = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x)))
    ? v.map(Number) : (d ? d.slice() : null));

/** The default aim set-up: a camera looks down its -Z, anything else +Z; up is +Y. */
export function defaultAim(kind) {
    return {
        aimAxis: kind === "camera" ? [0, 0, -1] : [0, 0, 1],
        upAxis: [0, 1, 0],
        upType: "scene",
        upVector: [0, 1, 0],
        upObject: null,
    };
}

/**
 * A new constraint of `type` on an item of `kind`, on `targets` (ids). Its
 * offsets are empty: the solver's captureOffsets fills them when
 * maintainOffset is on.
 */
export function makeConstraint(type, targets, {
    kind = "model", maintainOffset = true, weights = null, skip = null, aim = null, name = null,
} = {}) {
    if (!CONSTRAINT_TYPES.includes(type)) return null;
    const ids = [...new Set((targets || []).filter((t) => typeof t === "string" && t))];
    if (!ids.length) return null;
    const c = {
        id: _id(),
        type,
        name: name || `${type}Constraint`,
        on: true,
        weight: 1,
        maintainOffset: !!maintainOffset,
        targets: ids.map((id, i) => ({
            id, w: _clamp(_num(weights && weights[i], 1), 0, MAX_WEIGHT), offset: null,
        })),
        skip: cleanSkip(skip),
    };
    if (type === "aim") c.aim = cleanAim(aim, kind);
    return c;
}

export function cleanSkip(raw) {
    const out = { t: [], r: [], s: [] };
    for (const k of ["t", "r", "s"]) {
        const v = raw && Array.isArray(raw[k]) ? raw[k] : [];
        out[k] = [...new Set(v.map(Number).filter((a) => a === 0 || a === 1 || a === 2))].sort();
    }
    return out;
}

function _unit(v) {
    const n = Math.hypot(v[0], v[1], v[2]);
    return n > 1e-9 ? v.map((x) => x / n) : null;
}

export function cleanAim(raw, kind = "model") {
    const d = defaultAim(kind);
    const r = raw && typeof raw === "object" ? raw : {};
    const aimAxis = _unit(_vec(r.aimAxis, d.aimAxis)) || d.aimAxis;
    let upAxis = _unit(_vec(r.upAxis, d.upAxis)) || d.upAxis;
    // An up axis along the aim axis says nothing; pick one across it.
    const dot = Math.abs(aimAxis[0] * upAxis[0] + aimAxis[1] * upAxis[1] + aimAxis[2] * upAxis[2]);
    if (dot > 0.999) upAxis = Math.abs(aimAxis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    return {
        aimAxis,
        upAxis,
        upType: AIM_UP_TYPES.includes(r.upType) ? r.upType : d.upType,
        upVector: _unit(_vec(r.upVector, d.upVector)) || d.upVector.slice(),
        upObject: typeof r.upObject === "string" && r.upObject ? r.upObject : null,
    };
}

function _cleanOffset(type, v) {
    if (v === null || v === undefined) return null;
    const finite = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(Number(x)));
    if (type === "point" || type === "scale") return finite(v, 3) ? v.map(Number) : null;
    if (type === "orient" || type === "aim") return finite(v, 4) ? v.map(Number) : null;
    if (type === "parent") return finite(v, 16) ? v.map(Number) : null;
    return null;
}

/** An item's constraints as read from a saved scene; anything unreadable is left out. */
export function readConstraints(raw, kind = "model") {
    const out = [];
    const seen = new Set();
    for (const c of Array.isArray(raw) ? raw : []) {
        if (!c || typeof c !== "object" || !CONSTRAINT_TYPES.includes(c.type)) continue;
        const id = typeof c.id === "string" && /^[A-Za-z0-9]+$/.test(c.id) && !seen.has(c.id) ? c.id : _id();
        seen.add(id);
        const tseen = new Set();
        const targets = [];
        for (const t of Array.isArray(c.targets) ? c.targets : []) {
            if (!t || typeof t.id !== "string" || !t.id || tseen.has(t.id)) continue;
            tseen.add(t.id);
            targets.push({ id: t.id, w: _clamp(_num(t.w, 1), 0, MAX_WEIGHT), offset: _cleanOffset(c.type, t.offset) });
        }
        if (!targets.length) continue;
        const one = {
            id,
            type: c.type,
            name: typeof c.name === "string" && c.name ? c.name.slice(0, 120) : `${c.type}Constraint`,
            on: c.on !== false,
            weight: _clamp(_num(c.weight, 1), 0, 1),
            maintainOffset: c.maintainOffset !== false,
            targets,
            skip: cleanSkip(c.skip),
        };
        if (c.type === "aim") {
            one.aim = cleanAim(c.aim, kind);
            one.offset = _cleanOffset("aim", c.offset);
        }
        out.push(one);
    }
    return out;
}

/**
 * After a parse or a delete: drop targets that are no longer in the scene (and
 * a constraint left with none), and weight channels of constraints that are
 * gone. Returns the scene.
 */
export function pruneConstraints(scene) {
    const ids = new Set((scene.items || []).map((it) => it.id));
    for (const item of scene.items || []) {
        if (!Array.isArray(item.constraints)) continue;
        for (const c of item.constraints) {
            c.targets = c.targets.filter((t) => ids.has(t.id) && t.id !== item.id);
            if (c.aim && c.aim.upObject && !ids.has(c.aim.upObject)) c.aim.upObject = null;
        }
        item.constraints = item.constraints.filter((c) => c.targets.length);
        if (!item.constraints.length) delete item.constraints;
        _pruneWeightTracks(item);
    }
    return scene;
}

function _pruneWeightTracks(item) {
    if (!item.tracks) return;
    for (const prop of Object.keys(item.tracks)) {
        const p = parseWeightProp(prop);
        if (!p) continue;
        const c = constraintOf(item, p.cid);
        if (!c || (p.target && !c.targets.some((t) => t.id === p.target))) delete item.tracks[prop];
    }
}

// ── The weight channels ────────────────────────────────────────────────────

export const weightProp = (cid, targetId) => `cw:${cid}:${targetId}`;
export const envelopeProp = (cid) => `ce:${cid}`;

/** { cid, target } for "cw:..." (target null for "ce:..."), else null. */
export function parseWeightProp(prop) {
    if (typeof prop !== "string") return null;
    let m = /^cw:([A-Za-z0-9]+):(.+)$/.exec(prop);
    if (m) return { cid: m[1], target: m[2] };
    m = /^ce:([A-Za-z0-9]+)$/.exec(prop);
    if (m) return { cid: m[1], target: null };
    return null;
}

export function constraintOf(item, cid) {
    return (item && Array.isArray(item.constraints) && item.constraints.find((c) => c.id === cid)) || null;
}

/** A weight channel's static value (scene3d's reader), or undefined for anything else. */
export function readWeightStatic(item, prop) {
    const p = parseWeightProp(prop);
    if (!p) return undefined;
    const c = constraintOf(item, p.cid);
    if (!c) return undefined;
    if (!p.target) return c.weight;
    const t = c.targets.find((x) => x.id === p.target);
    return t ? t.w : undefined;
}

/** Write a weight channel's static value (scene3d's writer). True when it was one. */
export function writeWeightStatic(item, prop, value) {
    const p = parseWeightProp(prop);
    if (!p) return false;
    const c = constraintOf(item, p.cid);
    if (!c) return false;
    const v = Number(value);
    if (!Number.isFinite(v)) return true;
    if (!p.target) { c.weight = _clamp(v, 0, 1); return true; }
    const t = c.targets.find((x) => x.id === p.target);
    if (t) t.w = _clamp(v, 0, MAX_WEIGHT);
    return true;
}

/** The highest a weight channel may go: 1 for a constraint's own weight, MAX_WEIGHT for a target's. */
export function weightRange(prop) {
    const p = parseWeightProp(prop);
    return p && !p.target ? [0, 1] : [0, MAX_WEIGHT];
}

/** Every weight channel an item has, in order: [{ prop, cid, target, label }]. */
export function weightChannels(item, nameOf = (id) => id) {
    const out = [];
    for (const c of (item && item.constraints) || []) {
        out.push({ prop: envelopeProp(c.id), cid: c.id, target: null, label: `${c.name}.weight` });
        for (const t of c.targets) {
            out.push({ prop: weightProp(c.id, t.id), cid: c.id, target: t.id, label: `${c.name}.${nameOf(t.id)}W` });
        }
    }
    return out;
}

/** Whether the item has a constraint that is on. */
export function isConstrained(item) {
    return !!(item && Array.isArray(item.constraints) && item.constraints.some((c) => c.on && c.targets.length));
}

/** Which of the item's channels ("t", "r", "s" per axis) a constraint that is on writes. */
export function constrainedChannels(item) {
    const out = new Set();
    for (const c of (item && item.constraints) || []) {
        if (!c.on) continue;
        for (const k of CONSTRAINT_CHANNELS[c.type] || []) {
            for (const a of [0, 1, 2]) if (!c.skip[k].includes(a)) out.add(`${k}${a}`);
        }
    }
    return out;
}

/** A name for a new constraint that the item does not have yet: pointConstraint1, 2, ... */
export function nextConstraintName(item, type) {
    const used = new Set(((item && item.constraints) || []).map((c) => c.name));
    for (let n = 1; ; n++) {
        const name = `${type}Constraint${n}`;
        if (!used.has(name)) return name;
    }
}
