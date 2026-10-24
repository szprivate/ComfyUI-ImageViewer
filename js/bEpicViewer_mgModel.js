// bEpicViewer_mgModel.js
// The motion-graphics editor's edits, as pure functions on a scene (the format is in
// bEpicViewer_mgScene.js). No DOM, so the keyframe logic is tested under node
// (tests/test_mg_model.mjs). Every function mutates the scene it is given; the editor
// snapshots before it calls one (History) to get undo.
import { PROPS, PROPS_BY_TYPE, valueAt, track, evaluateLayer, tangentAt } from "./bEpicViewer_mgScene.js";

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A snapshot stack: push before a change, undo/redo move through the states. */
export class History {
    constructor(limit = 100) { this.limit = limit; this.past = []; this.future = []; }
    push(scene) {
        this.past.push(JSON.stringify(scene));
        if (this.past.length > this.limit) this.past.shift();
        this.future.length = 0;
    }
    undo(scene) {
        if (!this.past.length) return null;
        this.future.push(JSON.stringify(scene));
        return JSON.parse(this.past.pop());
    }
    redo(scene) {
        if (!this.future.length) return null;
        this.past.push(JSON.stringify(scene));
        return JSON.parse(this.future.pop());
    }
    get canUndo() { return this.past.length > 0; }
    get canRedo() { return this.future.length > 0; }
}

export function uniqueId(scene, base) {
    const have = new Set((scene.layers || []).map((l) => l.id));
    let id = base, n = 1;
    while (have.has(id)) id = `${base}${++n}`;
    return id;
}

export function layerOf(scene, id) {
    return (scene.layers || []).find((l) => l.id === id) || null;
}

/** A new layer of `type`, centred in the comp, with sensible defaults. */
export function makeLayer(scene, type, extra = {}) {
    const { width, height } = scene.comp;
    const base = { text: "text", shape: "shape", group: "group", image: "image", video: "video", component: "component" }[type] || "layer";
    const layer = { id: uniqueId(scene, base), name: base[0].toUpperCase() + base.slice(1), type, position: [width / 2, height / 2] };
    if (type === "text") Object.assign(layer, { text: "Text", fontSize: 96, weight: 700, align: "center", fill: "#ffffff" });
    if (type === "shape") Object.assign(layer, { shape: "rect", size: [400, 240], fill: "#ff6a1a" });
    if (type === "group") layer.position = [0, 0];
    Object.assign(layer, extra);
    if (extra.id) layer.id = uniqueId({ layers: (scene.layers || []).filter((l) => l.id !== extra.id) }, extra.id);
    return layer;
}

export function addLayer(scene, layer) {
    scene.layers.push(layer);
    return layer;
}

/** Remove a layer; its children are freed (parent cleared). */
export function removeLayer(scene, id) {
    scene.layers = scene.layers.filter((l) => l.id !== id);
    for (const l of scene.layers) if (l.parent === id) delete l.parent;
}

/** Move a layer in the stack: +1 toward the top (drawn later), -1 toward the bottom. */
export function moveLayer(scene, id, delta) {
    const i = scene.layers.findIndex((l) => l.id === id);
    const j = Math.max(0, Math.min(scene.layers.length - 1, i + delta));
    if (i < 0 || i === j) return false;
    const [l] = scene.layers.splice(i, 1);
    scene.layers.splice(j, 0, l);
    return true;
}

export function duplicateLayer(scene, id) {
    const src = layerOf(scene, id);
    if (!src) return null;
    const copy = clone(src);
    copy.id = uniqueId(scene, src.id.replace(/\d+$/, "") || "layer");
    copy.name = (src.name || src.id) + " copy";
    scene.layers.splice(scene.layers.indexOf(src) + 1, 0, copy);
    return copy;
}

/** Can `parentId` become the parent of `id` (no loops)? */
export function canParent(scene, id, parentId) {
    if (!parentId) return true;
    if (id === parentId) return false;
    let cur = layerOf(scene, parentId), hops = 0;
    while (cur && hops++ < 1000) {
        if (cur.id === id) return false;
        cur = cur.parent ? layerOf(scene, cur.parent) : null;
    }
    return true;
}

export function isAnimated(layer, prop) {
    return track(layer, prop).length > 0;
}

export function keyAt(layer, prop, frame) {
    return track(layer, prop).find((k) => k.f === frame) || null;
}

function putKey(layer, prop, frame, value, ease) {
    if (!layer.tracks) layer.tracks = {};
    const list = layer.tracks[prop] || (layer.tracks[prop] = []);
    const at = list.findIndex((k) => k.f === frame);
    if (at >= 0) {
        list[at].v = clone(value);
        if (ease !== undefined) list[at].ease = ease;
        delete list[at].ti; delete list[at].to;
    } else {
        list.push({ f: frame, v: clone(value), ease: ease || "smooth" });
        list.sort((a, b) => a.f - b.f);
    }
    return keyAt(layer, prop, frame);
}

/** A key at `frame` holding the property's value there (what the diamond button does). */
export function addKey(scene, layer, prop, frame) {
    frame = Math.round(frame);
    if (keyAt(layer, prop, frame)) return keyAt(layer, prop, frame);
    const v = evaluateLayer(scene, layer, frame)[prop] ?? valueAt(layer, prop, frame);
    return putKey(layer, prop, frame, v === null ? PROPS[prop].def : v);
}

export function removeKey(layer, prop, frame) {
    const list = track(layer, prop).filter((k) => k.f !== frame);
    if (list.length) layer.tracks[prop] = list; else if (layer.tracks) delete layer.tracks[prop];
}

/** The stopwatch: animate a property (a key at `frame`), or stop animating it (freeze the value at `frame`). */
export function toggleAnimated(scene, layer, prop, frame) {
    frame = Math.round(frame);
    if (isAnimated(layer, prop)) {
        layer[prop] = clone(valueAt(layer, prop, frame));
        delete layer.tracks[prop];
        if (!Object.keys(layer.tracks).length) delete layer.tracks;
        return false;
    }
    addKey(scene, layer, prop, frame);
    return true;
}

/** Set a property's value at `frame`: a key when it is animated, the static value when not. */
export function setProp(scene, layer, prop, value, frame) {
    if (isAnimated(layer, prop)) putKey(layer, prop, Math.round(frame), value);
    else layer[prop] = clone(value);
}

/** Set one component of a vec2 property (or the number itself) at `frame`. */
export function setComponent(scene, layer, prop, axis, x, frame) {
    const cur = evaluateLayer(scene, layer, frame)[prop];
    if (Array.isArray(cur)) { const v = cur.slice(); v[axis] = x; setProp(scene, layer, prop, v, frame); }
    else setProp(scene, layer, prop, x, frame);
}

/** Move the listed keys ({prop, f}) by `df` frames. Keys landing on others replace them. Returns the moved selection. */
export function moveKeys(layer, sel, df) {
    df = Math.round(df);
    if (!df) return sel;
    const byProp = new Map();
    for (const s of sel) { if (!byProp.has(s.prop)) byProp.set(s.prop, []); byProp.get(s.prop).push(s.f); }
    const out = [];
    for (const [prop, frames] of byProp) {
        const list = track(layer, prop);
        const moving = list.filter((k) => frames.includes(k.f));
        const rest = list.filter((k) => !frames.includes(k.f));
        const target = new Set(moving.map((k) => Math.max(0, k.f + df)));
        const kept = rest.filter((k) => !target.has(k.f));
        for (const k of moving) k.f = Math.max(0, k.f + df);
        layer.tracks[prop] = [...kept, ...moving].sort((a, b) => a.f - b.f);
        for (const k of moving) out.push({ prop, f: k.f });
    }
    return out;
}

export function setEase(layer, prop, frame, ease) {
    const k = keyAt(layer, prop, frame);
    if (!k) return;
    k.ease = ease;
    delete k.ti; delete k.to;
}

/** Hand-set a tangent (value units per frame) for one component; handles stay unified unless `broken`. */
export function setTangent(layer, prop, frame, axis, slope, { side = "out", broken = false } = {}) {
    const k = keyAt(layer, prop, frame);
    if (!k) return;
    const blank = Array.isArray(k.v) ? k.v.map(() => 0) : 0;
    const put = (which) => {
        const base = k[which] !== undefined ? clone(k[which]) : clone(blank);
        if (Array.isArray(base)) base[axis] = slope; else k[which] = slope;
        if (Array.isArray(base)) k[which] = base;
    };
    // Fill the other side with what it implied, so one drag does not move both.
    for (const s of ["in", "out"]) {
        const which = s === "in" ? "ti" : "to";
        if (k[which] === undefined) {
            k[which] = Array.isArray(k.v) ? k.v.map((_, a) => tangentAt(layer, prop, frame, a, s)) : tangentAt(layer, prop, frame, 0, s);
        }
    }
    put(side === "in" ? "ti" : "to");
    if (!broken) put(side === "in" ? "to" : "ti");
}

// -- clipboard ----------------------------------------------------------------

/** Copy keys ({prop, f}) of a layer: {frames relative to the earliest, tracks}. */
export function copyKeys(layer, sel) {
    if (!sel.length) return null;
    const base = Math.min(...sel.map((s) => s.f));
    return sel.map((s) => ({ prop: s.prop, df: s.f - base, key: clone(keyAt(layer, s.prop, s.f)) })).filter((x) => x.key);
}

/** Paste copied keys on `layer` starting at `frame` (props the layer cannot animate are skipped). Returns the new selection. */
export function pasteKeys(layer, clip, frame) {
    const allowed = PROPS_BY_TYPE[layer.type] || [];
    const out = [];
    for (const c of clip || []) {
        if (!allowed.includes(c.prop)) continue;
        const f = Math.round(frame) + c.df;
        putKey(layer, c.prop, f, c.key.v, c.key.ease);
        const k = keyAt(layer, c.prop, f);
        if (c.key.ti !== undefined) k.ti = clone(c.key.ti);
        if (c.key.to !== undefined) k.to = clone(c.key.to);
        out.push({ prop: c.prop, f });
    }
    return out;
}

// -- misc -----------------------------------------------------------------------

/** The animated props of a layer (those with tracks), in the order they are listed. */
export function animatedProps(layer) {
    return Object.keys(PROPS).filter((p) => isAnimated(layer, p));
}

export function setDuration(scene, frames) {
    scene.comp.duration = Math.max(1, Math.round(frames));
}
