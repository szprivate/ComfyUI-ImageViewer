// imageViewer_cameraAim.js
// A camera's look-at target (Sebastian 2026-11-12): off by default, switched
// on in the Channel Box. While it is on the camera turns to face its target
// every frame, its Roll channel turns it about the view axis (its Rotate
// channels are then left alone), and
// the target is a point in WORLD space with a handle of its own in the
// viewport (imageViewer_cameraAim3d.js), dragged while the camera is selected.
//
// Before this a camera had no target of its own, yet the orbit controls made
// it look at theirs whenever the view was panned or dollied through it: a
// camera turned by hand snapped back to that point and lost its roll. That
// is fixed in the view (_aimNavStart / _aimNavChange); a camera without a
// target now keeps the direction and the roll it was given.
//
// The target's three numbers are channels like any other ("aim:x", "aim:y",
// "aim:z", the extra-channel form of imageViewer_scene3d.js), so they can be
// keyed; their static values live in item.aim.target. "aim:roll" is the roll in
// degrees (item.aim.roll; positive turns the picture anticlockwise, as a
// rotation about the camera's own +Z). The switch is item.aim.on.
//
// Pure: no three.js, no DOM. Tested in tests/test_camera_aim.mjs.

export const AIM_PROPS = ["aim:x", "aim:y", "aim:z"];
export const AIM_LABELS = ["Target X", "Target Y", "Target Z"];
export const ROLL_PROP = "aim:roll";
/** Every channel a look-at camera has: the target, then the roll. */
export const AIM_CHANNELS = [...AIM_PROPS, ROLL_PROP];

const D = Math.PI / 180;

/** Whether `prop` is one of a camera target's channels. */
export function isAimProp(prop) {
    return AIM_CHANNELS.includes(prop);
}

/** A camera's look-at settings, every field present: { on, target }. */
export function aimSettings(item) {
    const raw = item && item.aim && typeof item.aim === "object" ? item.aim : {};
    const t = Array.isArray(raw.target) && raw.target.length === 3 && raw.target.every((v) => Number.isFinite(Number(v)))
        ? raw.target.map(Number) : null;
    const roll = Number(raw.roll);
    return { on: raw.on === true, target: t || defaultAimTarget(item), roll: Number.isFinite(roll) ? roll : 0 };
}

/** What a saved scene's `aim` is read as: null for none (a camera that never had one). */
export function readAim(raw) {
    if (!raw || typeof raw !== "object") return null;
    const t = Array.isArray(raw.target) && raw.target.length === 3 && raw.target.every((v) => Number.isFinite(Number(v)))
        ? raw.target.map(Number) : null;
    if (!t && raw.on !== true) return null;
    const out = { on: raw.on === true };
    if (t) out.target = t;
    const roll = Number(raw.roll);
    if (raw.roll !== undefined && raw.roll !== null && Number.isFinite(roll) && roll !== 0) out.roll = roll;
    return out;
}

/** Whether the camera looks at its target. */
export function aimOn(item) {
    return !!(item && item.kind === "camera" && item.aim && item.aim.on === true);
}

/** The direction a camera looks for a rotation in degrees (XYZ order): its -Z. */
export function forwardOf(rotation) {
    const [x, y] = (rotation || [0, 0, 0]).map((v) => (Number(v) || 0) * D);
    // R = Rx * Ry * Rz applied to (0, 0, -1); Rz leaves -Z where it is.
    const cy = Math.cos(y), sy = Math.sin(y), cx = Math.cos(x), sx = Math.sin(x);
    // Ry * (0,0,-1) = (-sy, 0, -cy); then Rx.
    return [-sy, sx * cy, -cx * cy];
}

/**
 * Where a target goes when it is switched on and has none yet: straight ahead
 * of the camera, as far as the world origin is in front of it (so a camera
 * aimed at the set lands its target there), at least one unit, else ten.
 */
export function defaultAimTarget(item, distance = null) {
    const p = (item && Array.isArray(item.position)) ? item.position.map(Number) : [0, 0, 0];
    const f = forwardOf(item && item.rotation);
    let d = Number(distance);
    if (!(d > 0)) {
        const toOrigin = -(p[0] * f[0] + p[1] * f[1] + p[2] * f[2]);
        d = toOrigin >= 1 ? toOrigin : 10;
    }
    return [p[0] + f[0] * d, p[1] + f[1] * d, p[2] + f[2] * d];
}

// The extra channels' static values (imageViewer_scene3d.js addStaticReader / addStaticWriter).
export function readAimStatic(item, prop) {
    if (!isAimProp(prop)) return undefined;
    if (prop === ROLL_PROP) return aimSettings(item).roll;
    return aimSettings(item).target[AIM_PROPS.indexOf(prop)];
}

export function writeAimStatic(item, prop, value) {
    if (!isAimProp(prop)) return false;
    const s = aimSettings(item);
    if (prop === ROLL_PROP) {
        item.aim = { ...(item.aim || {}), on: s.on, target: s.target, roll: Number(value) || 0 };
        return true;
    }
    const t = s.target.slice();
    t[AIM_PROPS.indexOf(prop)] = Number(value) || 0;
    item.aim = { ...(item.aim || {}), on: s.on, target: t };
    return true;
}
