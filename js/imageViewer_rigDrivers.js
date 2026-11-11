// imageViewer_rigDrivers.js
// Set-driven keys: one channel of a scene item read through a curve to move
// another. Pure data, no imports (the scene model reads drivers through
// readDrivers while it parses, so this module must not import it back).
//
// A DRIVEN channel lives on the item it moves:
//   item.drivers = [{ prop, axis, driver: { id, prop, axis }, keys: [{ x, v }], ease, rest }]
//     prop   the channel driven: "position" / "rotation" (with axis 0..2), "ikfk",
//            "attr:<name>", "bs:<morph>" (axis null)
//     driver the channel read: the item `id`, its `prop` and `axis` the same way
//     keys   the curve: at driver value x the channel is moved BY v, sorted by x;
//            before the first and after the last it holds (Maya's constant)
//     ease   "linear" or "smooth" between keys (smooth = flat at every key)
//     rest   the channel's own value when the first key was set (what Key folds
//            the change into the curve against; see imageViewer_previzRigExtras.js)
// What the curve gives is ADDED to the channel's own value (its keys or its
// number), so a driven finger can still be animated on top. The scene's
// evaluate() is left as it is; the view adds the drivers where it places items.

export const DRIVEN_PROPS = ["position", "rotation", "scale", "ikfk"];
const MAX_DRIVERS = 2000;
const MAX_KEYS = 200;

const isExtra = (p) => typeof p === "string" && p.indexOf(":") > 0 && p.length < 300;
const okProp = (p) => DRIVEN_PROPS.includes(p) || isExtra(p);
const isVec = (p) => p === "position" || p === "rotation" || p === "scale";

/** Drivers as a scene keeps them: anything unreadable left out. */
export function readDrivers(raw) {
    const out = [];
    for (const d of Array.isArray(raw) ? raw.slice(0, MAX_DRIVERS) : []) {
        if (!d || typeof d !== "object" || !okProp(d.prop) || !d.driver || typeof d.driver !== "object") continue;
        const drv = d.driver;
        if (typeof drv.id !== "string" || !drv.id || !(okProp(drv.prop) || drv.prop === "fov" || drv.prop === "space")) continue;
        const axis = isVec(d.prop) ? Math.max(0, Math.min(2, Math.round(Number(d.axis) || 0))) : null;
        const daxis = isVec(drv.prop) ? Math.max(0, Math.min(2, Math.round(Number(drv.axis) || 0))) : null;
        const keys = (Array.isArray(d.keys) ? d.keys : [])
            .filter((k) => k && Number.isFinite(Number(k.x)) && Number.isFinite(Number(k.v)))
            .slice(0, MAX_KEYS).map((k) => ({ x: Number(k.x), v: Number(k.v) }))
            .sort((a, b) => a.x - b.x);
        if (!keys.length) continue;
        const one = { prop: d.prop, axis, driver: { id: drv.id, prop: drv.prop, axis: daxis }, keys,
                      ease: d.ease === "smooth" ? "smooth" : "linear" };
        if (Number.isFinite(Number(d.rest))) one.rest = Number(d.rest);
        out.push(one);
    }
    return out;
}

/** The curve's value at driver value x. */
export function curveAt(keys, x, ease = "linear") {
    if (!keys || !keys.length) return 0;
    if (x <= keys[0].x) return keys[0].v;
    const last = keys[keys.length - 1];
    if (x >= last.x) return last.v;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].x <= x) i++;
    const a = keys[i], b = keys[i + 1];
    let t = (x - a.x) / Math.max(1e-12, b.x - a.x);
    if (ease === "smooth") t = t * t * (3 - 2 * t);
    return a.v + (b.v - a.v) * t;
}

/** Put a key on a driver's curve (a key at the same x, within a hair, is replaced). */
export function setDriverKey(d, x, v) {
    const eps = 1e-6 * Math.max(1, Math.abs(x));
    const keys = (d.keys || []).filter((k) => Math.abs(k.x - x) > eps);
    keys.push({ x, v });
    keys.sort((a, b) => a.x - b.x);
    d.keys = keys.slice(0, MAX_KEYS);
    return d;
}

/** The driver entry of an item for (prop, axis) read from (driver), or null. */
export function findDriver(item, prop, axis, driver) {
    return ((item && item.drivers) || []).find((d) => d.prop === prop && (d.axis ?? null) === (axis ?? null)
        && d.driver.id === driver.id && d.driver.prop === driver.prop && (d.driver.axis ?? null) === (driver.axis ?? null)) || null;
}

/** Same channel, same driver: the label a driven channel is listed under. */
export function channelLabel(prop, axis) {
    if (isVec(prop)) return `${{ position: "translate", rotation: "rotate", scale: "scale" }[prop]}${"XYZ"[axis || 0]}`;
    if (prop === "ikfk") return "ikBlend";
    if (prop.startsWith("attr:")) return prop.slice(5);
    if (prop.startsWith("bs:")) return prop.slice(3);
    return prop;
}

/**
 * What the drivers of an item add to its channels at `frame`: Map prop -> number
 * (scalars) or [dx, dy, dz]. `valueOf(id, prop, axis, frame)` reads a driver
 * channel's value as it stands (its own drivers included - that is the caller's
 * job, so chains work and loops stop where it says).
 */
export function drivenDelta(item, frame, valueOf) {
    const out = new Map();
    for (const d of (item && item.drivers) || []) {
        const x = valueOf(d.driver.id, d.driver.prop, d.driver.axis, frame);
        if (!Number.isFinite(x)) continue;
        const v = curveAt(d.keys, x, d.ease);
        if (isVec(d.prop)) {
            const cur = out.get(d.prop) || [0, 0, 0];
            cur[d.axis || 0] += v;
            out.set(d.prop, cur);
        } else out.set(d.prop, (out.get(d.prop) || 0) + v);
    }
    return out;
}

/** The items an item's drivers read: ids, without repeats. */
export function driversOf(item) {
    return [...new Set(((item && item.drivers) || []).map((d) => d.driver.id))];
}

/** Drivers that read `id` are left out (an item removed from the scene). */
export function dropDriversOf(scene, id) {
    for (const it of (scene && scene.items) || []) {
        if (!it.drivers) continue;
        it.drivers = it.drivers.filter((d) => d.driver.id !== id);
        if (!it.drivers.length) delete it.drivers;
    }
}
