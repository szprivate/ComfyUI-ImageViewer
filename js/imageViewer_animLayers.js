// imageViewer_animLayers.js
// Animation layers for the 3D space: the maths, as plain data and pure
// functions (no three.js, no DOM), so it runs under plain node.
//
// The item's own tracks are the BASE layer. Above it, bottom first, lie the
// scene's `animLayers`; an item's keys on one are `item.layerTracks[id][prop]`
// (scene3d.js parses and binds them). A frame is evaluated bottom up:
//
//   additive   value += w · L          (position, rotation, pivot, fov, ikfk)
//              value *= 1 + w · (L-1)  (scale: a layer of 1 changes nothing)
//   override   value += w · (L - value)
//
// where L is the layer's own curve at the frame and w its weight there (a
// keyable channel of the layer itself, 0..1). A layer only touches the props it
// has keys on, so an override layer with keys on one arm overrides that arm and
// nothing else. Muted layers count for nothing; while any layer is soloed only
// the soloed ones (and the base) do. A lock only refuses keys.
//
// Rotations blend per Euler component, linearly, as Maya's anim layers do by
// default; keys on a layer are interpolated by the same curve code as the base.
//
// Written from the rules above (the behaviour every DCC documents for its
// layers), not from any program's code.
import * as S from "./imageViewer_scene3d.js";

export const LAYER_ORDER = 200;     // after the base (0) and the clip sequencer (100)

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** The layers that count at all: not muted, and soloed when anything is. */
export function liveLayers(scene) {
    const list = (scene && Array.isArray(scene.animLayers)) ? scene.animLayers : [];
    const solo = list.some((l) => l.solo && !l.mute);
    return list.filter((l) => !l.mute && (!solo || l.solo));
}

/** A layer's weight at `frame`, keys included. */
export function layerWeightAt(layer, frame) {
    if (!layer) return 0;
    const keys = layer.tracks && Array.isArray(layer.tracks.weight) ? layer.tracks.weight : [];
    return clamp01(Number(S.keysValueAt(keys, "weight", frame, layer.weight ?? 1)) || 0);
}

/** One layer's blend of `value` (what lies below) with its own curve value `L`. */
export function blendLayer(mode, prop, value, L, w) {
    const one = (v, l, i) => {
        if (mode === "override") return v + w * (l - v);
        if (prop === "scale") return v * (1 + w * (l - 1));
        return v + w * l;
    };
    if (Array.isArray(value)) return value.map((v, i) => one(v, Array.isArray(L) ? L[i] : L, i));
    return one(value, Array.isArray(L) ? L[0] : L);
}

/**
 * The stack on top of `at` (what the base and anything before this evaluator
 * gave). Registered with scene3d as the "animLayers" evaluator, so every
 * evaluateIn / valueIn sees it.
 */
export function applyLayers(scene, item, frame, at) {
    const sets = item && item.layerTracks;
    if (!sets || !scene || !Array.isArray(scene.animLayers) || !scene.animLayers.length) return at;
    let out = null;
    for (const layer of liveLayers(scene)) {
        const set = sets[layer.id];
        if (!set) continue;
        const w = layerWeightAt(layer, frame);
        if (w <= 0) continue;
        for (const prop of Object.keys(set)) {
            const keys = set[prop];
            if (!Array.isArray(keys) || !keys.length) continue;
            const below = (out || at)[prop];
            if (below === undefined) continue;          // a prop this item's kind does not have
            if (!out) out = { ...at };
            const L = S.keysValueAt(keys, prop, frame, S.layerIdentity(prop, item));
            out[prop] = blendLayer(layer.mode, prop, below, L, w);
        }
    }
    if (!out) return at;
    if (out.ikfk !== undefined) out.ikfk = clamp01(out.ikfk);
    return out;
}

S.registerSceneEvaluator("animLayers", LAYER_ORDER, applyLayers);

// ── Editing the stack ────────────────────────────────────────────────────────

export function layerById(scene, id) {
    return (scene && Array.isArray(scene.animLayers) && scene.animLayers.find((l) => l.id === id)) || null;
}

function uniqueLayerName(scene, wanted, exceptId = null) {
    const taken = new Set(((scene && scene.animLayers) || []).filter((l) => l.id !== exceptId).map((l) => l.name));
    let base = (wanted || "AnimLayer").trim().slice(0, 80) || "AnimLayer";
    if (!taken.has(base)) return base;
    const m = base.match(/^(.*?)(\d+)$/);
    let stem = m ? m[1] : base;
    let n = m ? Number(m[2]) + 1 : 2;
    while (taken.has(`${stem}${n}`)) n += 1;
    return `${stem}${n}`;
}

/**
 * A new layer on top of the stack (or right above `above`). It becomes the
 * active one unless `select` is false. Returns the layer.
 */
export function addLayer(scene, { name, mode = "additive", weight = 1, above = null, select = true } = {}) {
    if (!scene) return null;
    if (!Array.isArray(scene.animLayers)) scene.animLayers = [];
    const n = scene.animLayers.length + 1;
    const layer = {
        id: S.newId("L"),
        name: uniqueLayerName(scene, name || `AnimLayer${n}`),
        mode: S.LAYER_MODES.includes(mode) ? mode : "additive",
        weight: clamp01(Number.isFinite(Number(weight)) ? Number(weight) : 1),
        mute: false, solo: false, lock: false,
        tracks: {},
    };
    const at = above ? scene.animLayers.findIndex((l) => l.id === above) : -1;
    if (at >= 0) scene.animLayers.splice(at + 1, 0, layer);
    else scene.animLayers.push(layer);
    if (select) scene.activeLayer = layer.id;
    S.bindScene(scene);
    return layer;
}

/** Change a layer's name, mode, weight, mute, solo or lock. */
export function setLayer(scene, id, patch = {}) {
    const layer = layerById(scene, id);
    if (!layer) return null;
    if (typeof patch.name === "string") layer.name = uniqueLayerName(scene, patch.name, id);
    if (S.LAYER_MODES.includes(patch.mode)) layer.mode = patch.mode;
    if (patch.weight !== undefined && Number.isFinite(Number(patch.weight))) layer.weight = clamp01(Number(patch.weight));
    for (const f of ["mute", "solo", "lock"]) if (patch[f] !== undefined) layer[f] = !!patch[f];
    return layer;
}

/** The layer keys go to; null is the base. */
export function setActiveLayer(scene, id) {
    if (!scene) return null;
    scene.activeLayer = id && layerById(scene, id) ? id : null;
    S.bindScene(scene);
    return scene.activeLayer;
}

/** Take a layer and every key on it away. */
export function removeLayer(scene, id) {
    if (!layerById(scene, id)) return false;
    scene.animLayers = scene.animLayers.filter((l) => l.id !== id);
    for (const it of scene.items || []) dropItemLayer(it, id);
    if (scene.activeLayer === id) scene.activeLayer = null;
    if (!scene.animLayers.length) { delete scene.animLayers; delete scene.activeLayer; }
    return true;
}

function dropItemLayer(item, id) {
    if (!item || !item.layerTracks) return;
    delete item.layerTracks[id];
    if (!Object.keys(item.layerTracks).length) delete item.layerTracks;
}

/** Move a layer up (+1) or down (-1) the stack. Order is evaluation order. */
export function moveLayer(scene, id, dir) {
    const list = (scene && scene.animLayers) || [];
    const i = list.findIndex((l) => l.id === id);
    const j = i + (dir > 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    return true;
}

/** Key the layer's weight at `frame` (the layer's own channel). */
export function keyLayerWeight(layer, frame, value, ease = "smooth") {
    if (!layer) return null;
    if (!layer.tracks) layer.tracks = {};
    const list = Array.isArray(layer.tracks.weight) ? layer.tracks.weight : [];
    const f = Math.round(frame);
    const v = clamp01(Number(value));
    const at = list.findIndex((k) => k.f === f);
    const key = { f, v, ease: at >= 0 && !ease ? list[at].ease : ease };
    if (at >= 0) list[at] = key; else list.push(key);
    list.sort((a, b) => a.f - b.f);
    layer.tracks.weight = list;
    return layer;
}

export function removeLayerWeightKey(layer, frame) {
    if (!layer || !layer.tracks || !Array.isArray(layer.tracks.weight)) return layer;
    const f = Math.round(frame);
    layer.tracks.weight = layer.tracks.weight.filter((k) => k.f !== f);
    if (!layer.tracks.weight.length) delete layer.tracks.weight;
    return layer;
}

/** The items with keys on a layer (its members, as far as anything can tell). */
export function layerMembers(scene, id) {
    return ((scene && scene.items) || []).filter((it) => it.layerTracks && it.layerTracks[id]
        && Object.values(it.layerTracks[id]).some((k) => Array.isArray(k) && k.length));
}

/** Every frame a layer has a key on, any item, any prop. */
export function layerKeyFrames(scene, id) {
    const out = new Set();
    for (const it of layerMembers(scene, id)) {
        for (const keys of Object.values(it.layerTracks[id])) for (const k of keys || []) out.add(k.f);
    }
    return [...out].sort((a, b) => a - b);
}

// ── Merging ──────────────────────────────────────────────────────────────────

/**
 * Drop keys a straight line through their neighbours already gives (within
 * `tol`), so a baked curve stays editable. Keys keep their frames.
 */
export function thinKeys(keys, tol = 1e-4) {
    if (keys.length <= 2) return keys;
    const comp = (v, i) => (Array.isArray(v) ? v[i] : v);
    const n = Array.isArray(keys[0].v) ? keys[0].v.length : 1;
    const out = [keys[0]];
    for (let i = 1; i < keys.length - 1; i++) {
        const a = out[out.length - 1], k = keys[i], b = keys[i + 1];
        const t = (k.f - a.f) / (b.f - a.f);
        let straight = true;
        for (let c = 0; c < n && straight; c++) {
            const lin = comp(a.v, c) + (comp(b.v, c) - comp(a.v, c)) * t;
            if (Math.abs(lin - comp(k.v, c)) > tol) straight = false;
        }
        if (!straight) out.push(k);
    }
    out.push(keys[keys.length - 1]);
    return out;
}

function sampleRange(frames) {
    if (!frames.length) return [];
    const lo = Math.min(...frames), hi = Math.max(...frames);
    const out = [];
    for (let f = lo; f <= hi; f++) out.push(f);
    return out;
}

/**
 * Merge a layer down into the one beneath it (the base when it is the lowest):
 * what the two show together, frame by frame over the keyed range, becomes the
 * lower layer's keys, and the layer goes. The layers above are left as they
 * are, so the picture does not change. Mute and solo are ignored for the two
 * merged (a merge is of what they hold); a muted layer above stays muted.
 * Returns the id the keys went to (null for the base), or undefined.
 */
export function mergeLayerDown(scene, id) {
    const list = (scene && scene.animLayers) || [];
    const i = list.findIndex((l) => l.id === id);
    if (i < 0) return undefined;
    const layer = list[i];
    const lower = i > 0 ? list[i - 1] : null;
    if (lower && lower.lock) return undefined;
    // Evaluate exactly the stack up to and including `layer`: the layers above
    // are taken out of a copy of the scene, and the two are switched on.
    const probeScene = {
        ...scene,
        animLayers: list.slice(0, i + 1).map((l) => ({ ...l, mute: !(l === layer || l === lower) && l.mute, solo: false })),
    };
    for (const it of scene.items || []) {
        const set = it.layerTracks && it.layerTracks[id];
        if (!set) continue;
        for (const prop of Object.keys(set)) {
            const keys = set[prop];
            if (!Array.isArray(keys) || !keys.length) continue;
            const lowerKeys = lower
                ? (it.layerTracks[lower.id] && it.layerTracks[lower.id][prop]) || []
                : S.baseTrack(it, prop);
            const frames = sampleRange([...keys, ...lowerKeys].map((k) => k.f));
            // What the stack up to `layer` shows, then what the lower layer has to
            // hold for that: solved against the stack without `layer`.
            const target = frames.map((f) => S.currentValue(probeScene, it, prop, f));
            const without = {
                ...probeScene,
                animLayers: probeScene.animLayers.filter((l) => l.id !== id),
                activeLayer: lower ? lower.id : null,
            };
            const copy = { ...it, layerTracks: { ...it.layerTracks } };
            delete copy.layerTracks[id];
            const baked = frames.map((f, n) => ({ f, v: S.solvePose(without, copy, prop, f, target[n]), ease: "linear" }));
            const thinned = thinKeys(baked);
            if (lower) {
                it.layerTracks[lower.id] = { ...(it.layerTracks[lower.id] || {}), [prop]: thinned };
            } else {
                if (!it.tracks) it.tracks = {};
                it.tracks[prop] = thinned;
            }
        }
    }
    removeLayer(scene, id);
    if (scene.animLayers) scene.activeLayer = lower ? lower.id : null;
    return lower ? lower.id : null;
}

/**
 * Extract: move the keys the selected items have on the layer being edited
 * onto a NEW layer above it, so a pass of changes can be weighted or muted on
 * its own. Override layers only (an additive layer's keys are offsets and
 * would mean the same on a new additive layer: that case moves them as they
 * are). Returns the new layer.
 */
export function extractToLayer(scene, items, { name, mode } = {}) {
    if (!scene) return null;
    const from = S.activeLayerOf(scene);
    const layer = addLayer(scene, { name: name || "Extracted", mode: mode || (from ? from.mode : "override"),
                                    above: from ? from.id : null, select: true });
    for (const it of items || []) {
        const src = from ? (it.layerTracks && it.layerTracks[from.id]) : it.tracks;
        if (!src || !Object.keys(src).length) continue;
        if (!it.layerTracks) it.layerTracks = {};
        it.layerTracks[layer.id] = JSON.parse(JSON.stringify(src));
        if (from) {
            delete it.layerTracks[from.id];
        } else {
            // Base keys moved up: the base holds where they started.
            for (const prop of Object.keys(src)) {
                const k = src[prop] && src[prop][0];
                if (k) it[prop] = Array.isArray(k.v) ? k.v.slice() : k.v;
            }
            it.tracks = {};
        }
    }
    // Base keys moved onto an additive layer would be added on top of the static
    // value; an extract from the base is always an override.
    if (!from) layer.mode = "override";
    S.bindScene(scene);
    return layer;
}

/** A short text of what a layer is, for the panel's tooltips. */
export function describeLayer(scene, layer) {
    const n = layerMembers(scene, layer.id).length;
    const keyed = layer.tracks && layer.tracks.weight && layer.tracks.weight.length ? ", weight keyed" : "";
    return `${layer.mode === "override" ? "Override" : "Additive"} layer, ${n} item${n === 1 ? "" : "s"}${keyed}`;
}
