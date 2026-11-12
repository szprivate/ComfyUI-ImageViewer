// imageViewer_scene3d.js
// The previz scene: what a 3D tab holds when it is more than one model.
//
// Plain data and pure functions only — no three.js, no DOM. The view
// (imageViewer_model3d.js) builds three objects from this, the node stores it
// as JSON, and a scene file is exactly this shape. Keeping it separate is what
// makes the animation testable without a browser.
//
// A scene is { fps, length, items[], activeCamera }. Every item — model,
// camera or group — carries a static transform plus optional animation
// `tracks`. A track is a sorted list of keyframes { f, v, ease }: `f` is a
// frame number on the viewer's own timeline, `v` the value at that frame
// ([x,y,z], or a number for fov), and `ease` how it leaves that key ("smooth"
// or "linear"). A property with no track holds its static value for the whole
// shot.
//
// TANGENTS
// A key may also carry `ti` and `to`: the slope of the curve coming in and
// going out, in value-units per frame, shaped like `v` (three numbers, or one
// for fov). They are what the curve editor's handles set, and they are
// OPTIONAL — a key without them behaves exactly as its `ease` says, because
// the ease shapes are the same cubic with the tangents those words imply:
// "smooth" is flat at both ends, "linear" is the straight line between the
// keys, "hold" is not a curve at all. So dragging a handle does not switch a
// scene into some other mode; it writes down the number the word was standing
// in for.
//
// THE PIVOT
// `pivot` is the point rotation and scale happen about, in the item's own
// space. It is a channel like any other — keyable, and on the curve editor's
// list — and the transform it stands for is
//     T(position) · T(pivot) · R · S · T(-pivot)
// which is what every DCC means by one: move the pivot and the object stays
// where it is, then turns around somewhere else.
//
// FROZEN TRANSFORMS
// `offset`, when present, is a 4x4 matrix (16 numbers, three.js column-major
// order) that sits under everything above:
//     T(position) · T(pivot) · R · S · T(-pivot) · offset
// Freeze Transformations is what writes it. Maya bakes a frozen transform into
// the vertices; a previz item points at a file it must not rewrite, so the
// transform is kept here instead, and the channels go back to zero with the
// item exactly where it was. It is not a channel and never animates.
//
// CAMERAS
// A camera's `resolution` is the [width, height] of the picture it takes. Its
// `fov` is the vertical field of view of THAT picture — the gate — whatever
// shape the viewport happens to be.
//
// THE HIERARCHY
// `items` stays a flat list — it is what a JSON widget, an undo snapshot and a
// diff all want — and the tree is carried by one field: `parent`, the id of the
// item this one hangs under, or null at the top. A transform is LOCAL to that
// parent, exactly as in USD or any DCC, so moving a group moves what is inside
// it and a child's numbers stay the numbers you typed. (Changing an item's
// parent in the outliner rewrites its numbers so it stays put in the world —
// that is the mixin's job, _previzKeepWorld; nothing here moves anything.) A `group` item is a
// transform and nothing else: it draws no geometry and exists to hold others,
// which is what a USD Xform or an assembly comes in as.
//
// ANIMATION LAYERS
// A scene may carry `animLayers` (bottom first) above the item's own tracks,
// which are the BASE layer. Each layer is {id, name, mode: "additive" |
// "override", weight, mute, solo, lock, tracks: {weight: keys}} and an item's
// keys on it are `item.layerTracks[layerId][prop]`, shaped as `item.tracks`.
// `scene.activeLayer` (an id, or null for the base) is where keys go: every
// key-editing function below (track, setKeyframe, removeKeyframe, the
// tangents) works on the active layer of the scene the item is bound to
// (bindScene). Evaluation is explicit: evaluate() is the base alone,
// evaluateIn(scene, …) the whole stack (imageViewer_animLayers.js blends it).
//
// Nothing here walks the tree to place an item — the view parents three.js
// objects the same way and lets the engine compose the matrices.

import { WORLD_KINDS, readWorldItem, referenceSettings, walkSettings, worldInfo } from "./imageViewer_worldData.js";
import { readRigFields } from "./imageViewer_rigData.js";
import { readItemRef, readSceneLayers } from "./imageViewer_sceneLayers.js";
import { pruneConstraints, readConstraints, readWeightStatic, writeWeightStatic } from "./imageViewer_constraintData.js";
import { readDrivers } from "./imageViewer_rigDrivers.js";
import { readAim, readAimStatic, writeAimStatic } from "./imageViewer_cameraAim.js";

export const SCENE_VERSION = 1;
export const DEFAULT_RESOLUTION = [1920, 1080];

/** The picture a camera takes, as [width, height] — never missing, never zero. */
export function cameraResolution(item) {
    const r = item && Array.isArray(item.resolution) ? item.resolution : null;
    const ok = r && r.length === 2 && r.every((v) => Number.isFinite(Number(v)) && Number(v) >= 1);
    return ok ? r.map((v) => Math.round(Number(v))) : DEFAULT_RESOLUTION.slice();
}

// ── Render settings ───────────────────────────────────────────────────────────
// What the render dialog last used, kept on the scene so it travels with the
// workflow. `camera` is an item id, "" for the free view, or null for "the
// camera being looked through, else the first one"; `end` null is the last
// frame of the shot; `fps` null is the shot's own rate.
export const RENDER_FORMATS = ["mp4", "mov", "webm", "png"];
export const RENDER_DEFAULTS = {
    camera: null, useCameraRes: true, width: 1920, height: 1080, scale: 100,
    start: 0, end: null, fps: null,
    format: "mp4", quality: "high",
    shading: "original", background: "viewer", color: "#282828",
    aa: 2, grid: false, helpers: false, addNode: true,
};

// The render dialog's starting point for a shot that has never been rendered,
// from Settings → ComfyUI Image Viewer. Only the look-and-output fields: range and
// camera belong to the shot.
const _RENDER_FACTORY = { ...RENDER_DEFAULTS };
export function setRenderDefaults(patch = {}) {
    Object.assign(RENDER_DEFAULTS, _RENDER_FACTORY);     // a bad value falls back to the factory's
    const merged = renderSettings({ render: { ..._RENDER_FACTORY, ...patch } });
    for (const k of ["format", "quality", "scale", "aa", "background", "color"]) RENDER_DEFAULTS[k] = merged[k];
}

/** The scene's render settings, every field present and sane. */
export function renderSettings(scene) {
    const raw = (scene && scene.render && typeof scene.render === "object") ? scene.render : {};
    const d = RENDER_DEFAULTS;
    const int = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : dflt);
    const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
    return {
        camera: typeof raw.camera === "string" ? raw.camera : null,
        useCameraRes: raw.useCameraRes !== false,
        width: int(raw.width, 16, 8192, d.width),
        height: int(raw.height, 16, 8192, d.height),
        scale: int(raw.scale, 10, 400, d.scale),
        start: int(raw.start, 0, 99999, d.start),
        end: raw.end === null || raw.end === undefined ? null : int(raw.end, 0, 99999, null),
        fps: raw.fps === null || raw.fps === undefined || !(Number(raw.fps) > 0) ? null : Number(raw.fps),
        format: pick(raw.format, RENDER_FORMATS, d.format),
        quality: pick(raw.quality, ["high", "medium", "low"], d.quality),
        // What a MOV is written with (the viewer-wide rule: ProRes unless H.264 is picked).
        codec: pick(raw.codec, ["prores", "h264"], "prores"),
        shading: pick(raw.shading, ["original", "clay", "normal", "wireframe"], d.shading),
        background: pick(raw.background, ["viewer", "color", "transparent"], d.background),
        color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : d.color,
        aa: pick(Number(raw.aa), [1, 2, 4], d.aa),
        grid: !!raw.grid,
        helpers: !!raw.helpers,
        addNode: raw.addNode !== false,
    };
}

/** A valid frozen-transform matrix, or null (none, or not 16 finite numbers). */
export function offsetOf(item) {
    const m = item && item.offset;
    return Array.isArray(m) && m.length === 16 && m.every((v) => Number.isFinite(Number(v)))
        ? m.map(Number) : null;
}
export const DEFAULT_FPS = 24;
export const DEFAULT_LENGTH = 120;

// What a NEW shot and a new camera start with — the DEFAULT_* above stay what a
// saved scene missing a field is read as. Set from Settings → ComfyUI Image Viewer
// (setNewSceneDefaults); this module itself stays free of ComfyUI.
const NEW_SCENE = { fps: DEFAULT_FPS, length: DEFAULT_LENGTH, resolution: DEFAULT_RESOLUTION.slice() };

export function setNewSceneDefaults({ fps, length, resolution } = {}) {
    NEW_SCENE.fps = Number(fps) > 0 ? Number(fps) : DEFAULT_FPS;
    NEW_SCENE.length = Number(length) >= 1 ? Math.round(Number(length)) : DEFAULT_LENGTH;
    NEW_SCENE.resolution = Array.isArray(resolution) && resolution.length === 2 && resolution.every((v) => v > 0)
        ? resolution.map((v) => Math.round(v)) : DEFAULT_RESOLUTION.slice();
}
export const TRACKS = ["position", "rotation", "scale", "pivot", "fov", "ikfk", "space"];
// Channels that hold one number rather than [x, y, z]: a camera's field of
// view, an IK control's IK/FK blend and a control's space (imageViewer_rigData.js,
// imageViewer_rigExtras.js).
export const SCALAR_TRACKS = ["fov", "ikfk", "space"];
const _isScalar = (prop) => SCALAR_TRACKS.includes(prop) || isExtraProp(prop);

// EXTRA TRACKS
// Channels other features hang on an item without this module knowing them:
// a constraint's weights ("cw:<constraint>:<target>", "ce:<constraint>",
// imageViewer_constraintData.js), and anything else spelled "<kind>:<name>".
// Every one is a single number, keyed like any other channel. Where its value
// lives when it is NOT animated is the owner's business: it registers a reader
// (and a writer) here, so this module never has to import it.
export function isExtraProp(prop) {
    return typeof prop === "string" && /^[A-Za-z][\w]*:[^|]+$/.test(prop);
}
const _staticReaders = [];
const _staticWriters = [];
/** fn(item, prop) -> the channel's static value, or undefined when it is not yours. */
export function addStaticReader(fn) { if (!_staticReaders.includes(fn)) _staticReaders.push(fn); }
/** fn(item, prop, value) -> true when it took the value. */
export function addStaticWriter(fn) { if (!_staticWriters.includes(fn)) _staticWriters.push(fn); }
// A constraint's weights (imageViewer_constraintData.js) are the first extra channels.
addStaticReader(readWeightStatic);
addStaticWriter(writeWeightStatic);
// A camera's look-at target, "aim:x" / "aim:y" / "aim:z" (imageViewer_cameraAim.js).
addStaticReader(readAimStatic);
addStaticWriter(writeAimStatic);
function _extraStatic(item, prop) {
    for (const fn of _staticReaders) {
        const v = fn(item, prop);
        if (v !== undefined) return v;
    }
    return 0;
}
/** Set a channel's value where it lives when it does not animate. */
export function setStaticValue(item, prop, value) {
    if (!item) return item;
    if (isExtraProp(prop)) {
        for (const fn of _staticWriters) if (fn(item, prop, value)) return item;
        return item;
    }
    item[prop] = Array.isArray(value) ? value.slice() : value;
    return item;
}
/** Every channel this item can have keys on: the fixed ones, then its extra ones. */
export function trackProps(item) {
    // (Also the extras keyed on the animation layer being edited.)
    const sets = [item && item.tracks, _readSet(item)].filter(Boolean);
    const extra = [...new Set(sets.flatMap((t) => Object.keys(t).filter(isExtraProp)))];
    return extra.length ? [...TRACKS, ...extra] : TRACKS;
}
export const setStatic = setStaticValue;
/** Whether `prop` names a channel that can carry keys. */
export function isTrackProp(prop) {
    return TRACKS.includes(prop) || isExtraProp(prop);
}

// The rig's own extra channels (imageViewer_rigExtras.js):
//   "attr:<name>"  a custom attribute of a rig control (item.attrs[name] = { value, min, max })
//   "bs:<morph>"   a blendshape (morph target) weight of a model (item.blendshapes[morph] = 0..1)
// The rig's own extra channels: custom attributes and blendshape weights.
/** The range a rig extra channel is held to. */
export function extraRange(item, prop) {
    if (prop.startsWith("bs:")) return [0, 1];
    const a = prop.startsWith("attr:") && item && item.attrs && item.attrs[prop.slice(5)];
    return [a && Number.isFinite(a.min) ? a.min : -Infinity, a && Number.isFinite(a.max) ? a.max : Infinity];
}
addStaticReader((item, prop) => {
    if (prop.startsWith("attr:")) {
        const a = item.attrs && item.attrs[prop.slice(5)];
        return a && Number.isFinite(a.value) ? a.value : 0;
    }
    if (prop.startsWith("bs:")) {
        const w = item.blendshapes && item.blendshapes[prop.slice(3)];
        return Number.isFinite(w) ? w : 0;
    }
    return undefined;
});
addStaticWriter((item, prop, value) => {
    if (!prop.startsWith("attr:") && !prop.startsWith("bs:")) return false;
    const [lo, hi] = extraRange(item, prop);
    const v = Math.max(lo, Math.min(hi, Number(value) || 0));
    if (prop.startsWith("attr:")) {
        const name = prop.slice(5);
        if (!item.attrs) item.attrs = {};
        item.attrs[name] = { ...(item.attrs[name] || {}), value: v };
    } else {
        if (!item.blendshapes) item.blendshapes = {};
        item.blendshapes[prop.slice(3)] = v;
    }
    return true;
});

// Blocking shapes the viewer can make on its own — no file, no loader. Each is
// built at unit size and placed by its transform, so the gizmo's scale handles
// are also its size handles. `scale` is the default the item is created with.
export const PRIMITIVES = [
    { type: "box",      label: "Box",      scale: [1, 1, 1] },
    { type: "sphere",   label: "Sphere",   scale: [1, 1, 1] },
    { type: "plane",    label: "Plane",    scale: [10, 1, 10] },   // lies flat, as a floor
    { type: "cylinder", label: "Cylinder", scale: [1, 1, 1] },
    { type: "cone",     label: "Cone",     scale: [1, 1, 1] },
    { type: "torus",    label: "Torus",    scale: [1, 1, 1] },
];

const PRIMITIVE_TYPES = new Set(PRIMITIVES.map((p) => p.type));
export const DEFAULT_COLOR = "#9a9a9a";

let _seq = 0;

export function newId(prefix = "i") {
    _seq += 1;
    return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

/** An empty transform others hang under: a USD Xform, or a folder you made. */
export function makeGroupItem(name) {
    return {
        id: newId("g"),
        kind: "group",
        name: name || "Group",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

export function makeScene(patch = {}) {
    return {
        version: SCENE_VERSION,
        fps: NEW_SCENE.fps,
        length: NEW_SCENE.length,
        items: [],
        activeCamera: null,      // item id, or null for the free camera
        // Whether the length above was chosen rather than defaulted. A model's
        // own clip may stretch a shot nobody has set a length for; once it has
        // been set — here, or by a stage that carries a range — it stands.
        lengthSet: false,
        ...patch,
    };
}

export function makeModelItem(src, name) {
    return {
        id: newId("m"),
        kind: "model",
        name: name || (src && (src.name || src.filename)) || "model",
        src: src || null,
        position: [0, 0, 0],
        rotation: [0, 0, 0],     // degrees, XYZ order
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

export function makePrimitiveItem(type, name) {
    const spec = PRIMITIVES.find((p) => p.type === type) || PRIMITIVES[0];
    return {
        id: newId("p"),
        kind: "primitive",
        name: name || spec.label,
        primitive: { type: spec.type },
        color: DEFAULT_COLOR,
        position: [0, spec.type === "plane" ? 0 : 0.5, 0],   // sitting on the grid
        rotation: [0, 0, 0],
        scale: spec.scale.slice(),
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

/**
 * A picture standing in the scene: a card showing an image.
 *
 * It is a scene item like any other — moved, parented, keyed — and its
 * geometry is a unit-height card whose width comes from the picture, so a
 * scale of 1 means "one unit tall". Parent one to a camera and it becomes
 * that camera's backplate; stand one behind the set and it is a matte
 * painting; put one beside the model and it is the reference you are
 * matching.
 */
export function makeImagePlaneItem(src, name) {
    return {
        id: newId("ip"),
        kind: "imageplane",
        name: name || (src && (src.name || src.filename)) || "Image plane",
        src: src || null,
        plane: { opacity: 1, lit: false, doubleSided: true },
        position: [0, 0.5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

/** An image plane's own settings, every field present and sane. */
export function planeSettings(item) {
    const raw = (item && item.plane && typeof item.plane === "object") ? item.plane : {};
    const opacity = Number(raw.opacity);
    return {
        opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
        lit: !!raw.lit,
        doubleSided: raw.doubleSided !== false,
    };
}

export function makeCameraItem(name, patch = {}) {
    return {
        id: newId("c"),
        kind: "camera",
        name: name || "Camera",
        position: [5, 5, 5],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        fov: 35,
        resolution: NEW_SCENE.resolution.slice(),
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
        ...patch,
    };
}

export function itemById(scene, id) {
    if (!scene || !id) return null;
    return (scene.items || []).find((it) => it && it.id === id) || null;
}

export function cameras(scene) {
    return (scene.items || []).filter((it) => it && it.kind === "camera");
}

export function models(scene) {
    return (scene.items || []).filter((it) => it && it.kind === "model");
}

/** Everything that is drawn: loaded files and built-in shapes alike. */
export function geometry(scene) {
    return (scene.items || []).filter((it) => it && it.kind !== "camera" && it.kind !== "group");
}

export function groups(scene) {
    return (scene.items || []).filter((it) => it && it.kind === "group");
}

/** The items hanging directly under `id` (or at the top, for null), in order. */
export function childrenOf(scene, id) {
    return (scene.items || []).filter((it) => it && (it.parent || null) === (id || null));
}

/** Everything under `id`, at any depth — what deleting a group takes with it. */
export function descendantsOf(scene, id) {
    const out = [];
    const walk = (parentId) => {
        for (const child of childrenOf(scene, parentId)) {
            out.push(child);
            walk(child.id);
        }
    };
    walk(id);
    return out;
}

/** How deep an item sits, for the outliner's indent. */
export function depthOf(scene, item) {
    let depth = 0;
    let node = item;
    const seen = new Set();
    while (node && node.parent && !seen.has(node.id)) {
        seen.add(node.id);
        node = itemById(scene, node.parent);
        if (node) depth += 1;
    }
    return depth;
}

/**
 * May `id` be moved under `parentId`? Not into itself, and not into its own
 * descendants — that would cut the branch off the tree and lose it.
 */
export function canParent(scene, id, parentId) {
    if (!id || id === parentId) return false;
    if (!parentId) return true;
    const target = itemById(scene, parentId);
    if (!target) return false;
    let node = target;
    const seen = new Set();
    while (node && !seen.has(node.id)) {
        if (node.id === id) return false;
        seen.add(node.id);
        node = node.parent ? itemById(scene, node.parent) : null;
    }
    return true;
}

/**
 * Put `id` under `parentId` (null for the top), keeping the flat list in tree
 * order: an item sits directly after its parent, ahead of the next branch. The
 * order matters — the outliner reads the list as it stands, and so does an
 * export.
 */
export function setParent(scene, id, parentId) {
    const item = itemById(scene, id);
    if (!item || !canParent(scene, id, parentId)) return false;
    item.parent = parentId || null;
    const moving = [item, ...descendantsOf(scene, id)];
    const rest = (scene.items || []).filter((it) => !moving.includes(it));
    const at = parentId ? rest.findIndex((it) => it.id === parentId) + 1 : rest.length;
    rest.splice(at, 0, ...moving);
    scene.items = rest;
    return true;
}

/**
 * Put `id` under `parentId` (null for the top) and among its new siblings
 * just before `beforeId` — or last, when `beforeId` is null or isn't one of
 * them. Its descendants come along. The flat list stays in tree order, so
 * the outliner, an export and a reload all see the same order.
 */
export function moveItem(scene, id, parentId, beforeId = null) {
    const item = itemById(scene, id);
    if (!item || !canParent(scene, id, parentId)) return false;
    const moving = [item, ...descendantsOf(scene, id)];
    if (beforeId && moving.some((it) => it.id === beforeId)) return false;
    item.parent = parentId || null;
    const rest = (scene.items || []).filter((it) => !moving.includes(it));
    const before = beforeId ? rest.find((it) => it.id === beforeId) : null;
    let at;
    if (before && (before.parent || null) === (parentId || null)) {
        at = rest.indexOf(before);
    } else if (parentId) {
        // Last child: after the parent and everything already under it.
        const tail = [itemById(scene, parentId), ...descendantsOf(scene, parentId)]
            .filter((it) => rest.includes(it));
        at = Math.max(...tail.map((it) => rest.indexOf(it))) + 1;
    } else {
        at = rest.length;
    }
    rest.splice(at, 0, ...moving);
    scene.items = rest;
    return true;
}

/** A name no other item carries, so the outliner never shows two the same. */
export function uniqueName(scene, wanted, exceptId = null) {
    // `exceptId` is the item being renamed: its own current name is not in
    // the way, or keeping a name would turn "Box" into "Box 2".
    const taken = new Set((scene.items || [])
        .filter((it) => it.id !== exceptId).map((it) => it.name));
    if (!taken.has(wanted)) return wanted;
    const base = wanted.replace(/\s+\d+$/, "");
    for (let n = 2; ; n++) {
        const candidate = `${base} ${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

// ── Keyframes ────────────────────────────────────────────────────────────────

const _clone = (v) => (Array.isArray(v) ? v.slice() : v);

/** Read one component of a key's value or tangent — vec3 or a lone number. */
export function componentOf(value, axis) {
    return Array.isArray(value) ? value[axis] : value;
}

/** Write one component back, in whatever shape the value has. */
function _withComponent(value, axis, x) {
    if (!Array.isArray(value)) return x;
    const out = value.slice();
    out[axis] = x;
    return out;
}

// ── Which layer an edit goes to ─────────────────────────────────────────────

// Items know their scene only through this map (bindScene), so a scene without
// layers costs nothing and a stray item edits its base keys, as it always did.
const _SCENE_OF = new WeakMap();

/** Tell the key-editing functions which scene (and so which active layer) each item is in. */
export function bindScene(scene) {
    if (scene && Array.isArray(scene.items)) for (const it of scene.items) if (it && typeof it === "object") _SCENE_OF.set(it, scene);
    return scene;
}

export function sceneOf(item) {
    return (item && _SCENE_OF.get(item)) || null;
}

/** The layer keys of `scene` go to (null = the base). */
export function activeLayerOf(scene) {
    if (!scene || !scene.activeLayer || !Array.isArray(scene.animLayers)) return null;
    return scene.animLayers.find((l) => l.id === scene.activeLayer) || null;
}

/** The layer an item's key edits go to: its scene's active layer, or null for the base. */
export function editLayer(item) {
    return activeLayerOf(sceneOf(item));
}

/** The track set edits of this item read: the active layer's keys, else its own. */
function _readSet(item) {
    if (!item) return null;
    const layer = editLayer(item);
    if (!layer) return item.tracks || null;
    return (item.layerTracks && item.layerTracks[layer.id]) || null;
}

/** The track set an edit writes into, made when missing; null when the active layer is locked. */
function _writeSet(item) {
    if (!item) return null;
    const layer = editLayer(item);
    if (!layer) {
        if (!item.tracks) item.tracks = {};
        return item.tracks;
    }
    if (layer.lock) return null;
    if (!item.layerTracks) item.layerTracks = {};
    if (!item.layerTracks[layer.id]) item.layerTracks[layer.id] = {};
    return item.layerTracks[layer.id];
}

/** Whether a key edit of this item would be refused (its active layer is locked). */
export function editLocked(item) {
    const layer = editLayer(item);
    return !!(layer && layer.lock);
}

/** Keyframes of one property on the layer being edited, oldest first. Never null. */
export function track(item, prop) {
    // Extra channels (constraint weights, …) are read by their owners from the
    // base: they stay there whatever layer is edited.
    const set = isExtraProp(prop) ? (item && item.tracks) : _readSet(item);
    const t = set && set[prop];
    return Array.isArray(t) ? t : [];
}

/** Keyframes of one property on the base layer, whatever layer is being edited. */
export function baseTrack(item, prop) {
    const t = item && item.tracks && item.tracks[prop];
    return Array.isArray(t) ? t : [];
}

/** Replace a whole track on the layer being edited (an empty list drops it). */
export function setTrack(item, prop, keys) {
    const set = isExtraProp(prop) ? (item.tracks || (item.tracks = {})) : _writeSet(item);
    if (!set) return item;
    if (Array.isArray(keys) && keys.length) set[prop] = keys.slice().sort((a, b) => a.f - b.f);
    else delete set[prop];
    return item;
}

export function isAnimated(item, prop) {
    return track(item, prop).length > 0;
}

/** Every frame this item has a key on (on the layer being edited), sorted, without duplicates. */
export function keyframeFrames(item) {
    const out = new Set();
    for (const prop of trackProps(item)) for (const k of track(item, prop)) out.add(k.f);
    return [...out].sort((a, b) => a - b);
}

/** Every frame this item has a key on, on ANY layer (the base, every layer). */
export function allKeyframeFrames(item) {
    const out = new Set();
    const sets = [item && item.tracks, ...Object.values((item && item.layerTracks) || {})];
    for (const set of sets) {
        if (!set) continue;
        for (const prop of Object.keys(set)) for (const k of Array.isArray(set[prop]) ? set[prop] : []) out.add(k.f);
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * Put a key on `prop` at `frame`. Replacing an existing key at that frame keeps
 * its easing unless a new one is given. Returns the scene item for chaining.
 */
export function setKeyframe(item, prop, frame, value, ease) {
    if (!item || !(TRACKS.includes(prop) || isExtraProp(prop))) return item;
    const f = Math.round(frame);
    const set = isExtraProp(prop) ? (item.tracks || (item.tracks = {})) : _writeSet(item);
    if (!set) return item;          // a locked layer takes no keys
    const list = Array.isArray(set[prop]) ? set[prop] : [];
    const at = list.findIndex((k) => k.f === f);
    const key = { f, v: _clone(value), ease: ease || (at >= 0 ? list[at].ease : "smooth") };
    // Moving a key keeps the shape its handles were given; only the editor's
    // tangent drag rewrites those.
    if (at >= 0 && list[at].ti !== undefined) key.ti = _clone(list[at].ti);
    if (at >= 0 && list[at].to !== undefined) key.to = _clone(list[at].to);
    if (at >= 0) list[at] = key;
    else list.push(key);
    list.sort((a, b) => a.f - b.f);
    set[prop] = list;
    return item;
}

/**
 * Set one component of a key's tangent.
 *
 * `side` is "in" or "out". Handles are unified unless `broken` says otherwise:
 * a curve with a kink in it is something you ask for, not something a drag
 * gives you by accident.
 */
export function setTangent(item, prop, frame, axis, slope, { side = "out", broken = false } = {}) {
    if (editLocked(item)) return null;
    const key = track(item, prop).find((k) => k.f === Math.round(frame));
    if (!key) return null;
    const blank = Array.isArray(key.v) ? key.v.map(() => 0) : 0;
    const put = (which) => {
        const base = key[which] !== undefined ? key[which] : _clone(blank);
        key[which] = _withComponent(base, axis, slope);
    };
    put(side === "in" ? "ti" : "to");
    if (!broken) put(side === "in" ? "to" : "ti");
    return key;
}

/** Back to what the key's ease says — the handles stop being hand-set. */
export function clearTangents(item, prop, frame) {
    if (editLocked(item)) return null;
    const key = track(item, prop).find((k) => k.f === Math.round(frame));
    if (!key) return null;
    delete key.ti;
    delete key.to;
    return key;
}

/**
 * The slope a key actually has on one side, hand-set or implied by its ease.
 * What the editor draws its handles from.
 */
export function tangentAt(item, prop, frame, axis, side = "out") {
    return _keysTangent(track(item, prop), frame, axis, side);
}

/** tangentAt on a key list of its own (the base's, for infinity, whatever layer is edited). */
function _keysTangent(keys, frame, axis, side = "out") {
    const i = keys.findIndex((k) => k.f === Math.round(frame));
    if (i < 0) return 0;
    const key = keys[i];
    const own = side === "in" ? key.ti : key.to;
    if (own !== undefined) return componentOf(own, axis);
    // Implied: read it off the segment this side of the key.
    const other = side === "in" ? keys[i - 1] : keys[i + 1];
    if (!other) return 0;
    const [from, to] = side === "in" ? [other, key] : [key, other];
    const span = to.f - from.f;
    const ease = from.ease;
    return _autoSlope(ease, componentOf(from.v, axis), componentOf(to.v, axis), span);
}

/** Drop the key at `frame` (all properties when `prop` is omitted). */
export function removeKeyframe(item, frame, prop) {
    if (!item) return item;
    const f = Math.round(frame);
    for (const p of prop ? [prop] : trackProps(item)) {
        // Extra channels live on the base; the rest on the layer being edited.
        const set = isExtraProp(p) ? item.tracks : (_readSet(item) ? _writeSet(item) : null);
        const list = set && set[p];
        if (!Array.isArray(list)) continue;
        const left = list.filter((k) => k.f !== f);
        if (left.length) set[p] = left;
        else delete set[p];
    }
    return item;
}

/** Forget an item's animation, leaving it wherever it is at `frame`. */
export function clearTracks(item, frame) {
    if (!item) return item;
    if (frame !== undefined) {
        // Where it is on screen, every layer counted.
        const at = evaluateIn(sceneOf(item), item, frame);
        item.position = at.position;
        item.rotation = at.rotation;
        item.scale = at.scale;
        if (item.kind === "camera") item.fov = at.fov;
    }
    item.tracks = {};
    delete item.layerTracks;
    return item;
}

// Ease shapes the segment AFTER a key: "linear" holds a constant speed,
// "smooth" (the default) eases out of it and into the next, and "hold" keeps
// the value until the next key, for stepped moves.
//
// Written as the tangents each word means, so one cubic draws every case and a
// hand-set handle is the same curve with a different number in it:
//   smooth → flat at both ends (which IS smoothstep)
//   linear → the straight line's own slope at both ends
function _autoSlope(ease, from, to, span) {
    if (ease === "linear" && span > 0) return (to - from) / span;
    return 0;
}

/**
 * One component of a segment, as a cubic Hermite.
 * `t` is 0..1 across the segment; the tangents are in value-units per frame,
 * so they are scaled by the segment's length to become the Hermite's.
 */
function _hermite(p0, p1, m0, m1, t, span) {
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0
         + (t3 - 2 * t2 + t) * span * m0
         + (-2 * t3 + 3 * t2) * p1
         + (t3 - t2) * span * m1;
}

// Rotations are kept in degrees, and two keys 350° apart really mean 10° the
// other way. Without this a turn would spin the long way round.
function _angleDelta(a, b) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
}

function _lerpAngle(a, b, t) {
    return a + _angleDelta(a, b) * t;
}

function _lerp(a, b, t, angles) {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.map((v, i) => (angles ? _lerpAngle(v, b[i], t) : v + (b[i] - v) * t));
    }
    return a + (b - a) * t;
}

// ── Before the first key and after the last ("infinity") ──────────────────────
//
// What a track does outside its keys is set per item and property:
// `item.infinity = { position: { pre: "constant", post: "cycle" }, ... }`.
// A missing entry is "constant" - the value of the end key, which is what
// every scene written before this did. The other words are the usual ones:
//   linear    - goes on along the end key's tangent
//   cycle     - the keys over again, end to end
//   offset    - cycles, each turn starting where the last one ended
//               (a walk that keeps walking)
//   oscillate - forwards, then backwards, then forwards
// It applies to the BASE layer's keys (an animation layer's curve holds its ends).
export const INFINITY_MODES = ["constant", "linear", "cycle", "offset", "oscillate"];

/** `{ pre, post }` of one property, "constant" where nothing is set. */
export function infinityOf(item, prop) {
    const own = item && item.infinity && item.infinity[prop];
    const pick = (m) => (INFINITY_MODES.includes(m) ? m : "constant");
    return { pre: pick(own && own.pre), post: pick(own && own.post) };
}

/** Set one or both sides; back at constant / constant the entry goes. */
export function setInfinity(item, prop, patch = {}) {
    if (!item || !TRACKS.includes(prop)) return item;
    const next = { ...infinityOf(item, prop) };
    for (const side of ["pre", "post"]) {
        if (patch[side] !== undefined) next[side] = INFINITY_MODES.includes(patch[side]) ? patch[side] : "constant";
    }
    if (!item.infinity) item.infinity = {};
    if (next.pre === "constant" && next.post === "constant") delete item.infinity[prop];
    else item.infinity[prop] = next;
    if (!Object.keys(item.infinity).length) delete item.infinity;
    return item;
}

/** Does any property of this item go on past its keys? (Baking then needs the whole shot.) */
export function hasInfinity(item) {
    return TRACKS.some((p) => {
        const inf = infinityOf(item, p);
        return baseTrack(item, p).length > 1 && (inf.pre !== "constant" || inf.post !== "constant");
    });
}

const _addV = (a, b, k) => (Array.isArray(a) ? a.map((x, i) => x + componentOf(b, i) * k) : a + b * k);
const _subV = (a, b) => (Array.isArray(a) ? a.map((x, i) => x - componentOf(b, i)) : a - b);

/** `frame` outside the (base) keys, read through the infinity mode. Null when the keys say it. */
function _beyond(item, prop, keys, frame) {
    const first = keys[0], last = keys[keys.length - 1];
    const before = frame < first.f;
    if (!before && frame <= last.f) return null;
    const mode = infinityOf(item, prop)[before ? "pre" : "post"];
    const span = last.f - first.f;
    if (mode === "constant" || span <= 0) return null;
    if (mode === "linear") {
        const end = before ? first : last;
        const side = before ? "out" : "in";
        const slope = Array.isArray(end.v)
            ? end.v.map((_, a) => _keysTangent(keys, end.f, a, side))
            : _keysTangent(keys, end.f, 0, side);
        return _addV(_clone(end.v), slope, frame - end.f);
    }
    const rel = frame - first.f;
    const turns = Math.floor(rel / span);
    let local = rel - turns * span;                  // 0..span
    if (mode === "oscillate" && (((turns % 2) + 2) % 2) === 1) local = span - local;
    const v = _inside(item, prop, keys, first.f + local);
    if (mode !== "offset") return v;
    // Each turn starts where the one before it ended.
    return _addV(v, _subV(last.v, first.v), turns);
}

/** The item's own (static) value of a property: what it holds without keys. */
export function staticValue(item, prop) {
    // A scene written before pivots existed simply has none, which is the
    // same thing as one at the origin.
    return prop === "fov" ? (item.fov ?? 35)
         : prop === "ikfk" ? (item.ikfk ?? 1)
         : prop === "space" ? (item.space ?? 0)
         : prop === "pivot" ? _clone(item.pivot || [0, 0, 0])
         : isExtraProp(prop) ? _extraStatic(item, prop)
         : _clone(item[prop]);
}

/** The value of one property at `frame` on the BASE layer, animated or not. */
export function valueAt(item, prop, frame) {
    const keys = baseTrack(item, prop);
    if (keys.length > 1) {
        const out = _beyond(item, prop, keys, frame);
        // The IK / FK blend stays a blend however far a line runs on.
        if (out !== null) return prop === "ikfk" ? Math.max(0, Math.min(1, out)) : out;
    }
    return _inside(item, prop, keys, frame);
}

/** valueAt without the infinity: what the keys themselves say. */
function _inside(item, prop, keys, frame) {
    return keysValueAt(keys, prop, frame, staticValue(item, prop));
}

/**
 * The value of the layer being edited at `frame`: the base's for the base, a
 * layer's own curve for a layer (its offset on an additive one). What the curve
 * editor draws.
 */
export function editValueAt(item, prop, frame) {
    const layer = editLayer(item);
    if (!layer) return valueAt(item, prop, frame);
    const rest = layer.mode === "additive" ? layerIdentity(prop, item) : valueAt(item, prop, frame);
    return keysValueAt(track(item, prop), prop, frame, rest);
}

/** What an additive layer adds when it holds nothing: zero, or 1 for scale. */
export function layerIdentity(prop, item) {
    if (prop === "scale") return [1, 1, 1];
    if (_isScalar(prop)) return 0;
    const v = item ? staticValue(item, prop) : null;
    return Array.isArray(v) ? v.map(() => 0) : [0, 0, 0];
}

/** A key list's value at `frame` — the curve itself; `stat` when there are no keys. */
export function keysValueAt(keys, prop, frame, stat) {
    keys = Array.isArray(keys) ? keys : [];
    if (keys.length === 0) return _clone(stat);
    if (frame <= keys[0].f) return _clone(keys[0].v);
    const last = keys[keys.length - 1];
    if (frame >= last.f) return _clone(last.v);
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].f <= frame) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.f - a.f;
    if (a.ease === "hold" || span <= 0) return _clone(a.v);
    const t = (frame - a.f) / span;
    const angles = prop === "rotation";
    const each = (axis) => {
        const p0 = componentOf(a.v, axis);
        // The short way round for angles: the segment is drawn to the nearer
        // turn, so 350° to 10° is 20° rather than 340°.
        const p1 = angles ? p0 + _angleDelta(p0, componentOf(b.v, axis))
                          : componentOf(b.v, axis);
        const m0 = a.to !== undefined ? componentOf(a.to, axis) : _autoSlope(a.ease, p0, p1, span);
        const m1 = b.ti !== undefined ? componentOf(b.ti, axis) : _autoSlope(a.ease, p0, p1, span);
        return _hermite(p0, p1, m0, m1, t, span);
    };
    return Array.isArray(a.v) ? a.v.map((_, axis) => each(axis)) : each(0);
}

/** Everything the view needs to place one item at `frame`. */
export function evaluate(item, frame) {
    const at = {
        position: valueAt(item, "position", frame),
        rotation: valueAt(item, "rotation", frame),
        scale: valueAt(item, "scale", frame),
        pivot: valueAt(item, "pivot", frame),
        fov: item.kind === "camera" ? valueAt(item, "fov", frame) : undefined,
        ikfk: item.kind === "control" && item.control && item.control.type === "ik"
            ? valueAt(item, "ikfk", frame) : undefined,
    };
    // A control's space and the named channels (custom attributes, blendshapes):
    // only where the item has them, so an ordinary item evaluates as before.
    if (item.kind === "control" && ((item.control && item.control.spaces && item.control.spaces.length) || isAnimated(item, "space"))) {
        at.space = valueAt(item, "space", frame);
    }
    for (const prop of namedProps(item)) at[prop] = valueAt(item, prop, frame);
    return at;
}

/** Every named channel an item has: its custom attributes, its blendshapes, and any keyed. */
export function namedProps(item) {
    const out = new Set();
    for (const n of Object.keys((item && item.attrs) || {})) out.add(`attr:${n}`);
    for (const n of Object.keys((item && item.blendshapes) || {})) out.add(`bs:${n}`);
    for (const p of Object.keys((item && item.tracks) || {})) if (isExtraProp(p)) out.add(p);
    return [...out];
}

// ── Scene-level evaluators (clip sequencer, animation layers) ──
const _SCENE_EVALUATORS = [];
export function registerSceneEvaluator(name, order, fn) {
    const i = _SCENE_EVALUATORS.findIndex((e) => e.name === name);
    if (i >= 0) _SCENE_EVALUATORS.splice(i, 1);
    _SCENE_EVALUATORS.push({ name, order, fn });
    _SCENE_EVALUATORS.sort((a, b) => a.order - b.order);
}
export function evaluateIn(scene, item, frame) {
    let at = evaluate(item, frame);
    if (!scene) return at;
    for (const e of _SCENE_EVALUATORS) at = e.fn(scene, item, frame, at) || at;
    return at;
}
export function valueIn(scene, item, prop, frame) {
    return evaluateIn(scene, item, frame)[prop];
}

/** valueIn, falling back to the base value for a prop the item's kind does not evaluate. */
export function currentValue(scene, item, prop, frame) {
    const v = valueIn(scene, item, prop, frame);
    return v !== undefined ? v : valueAt(item, prop, frame);
}

/**
 * What to key on the layer being edited at `frame` so that the WHOLE stack
 * shows `wanted` there - a pose made with the gizmo or the Channel Box lands
 * where it was made, whatever layers lie above or below.
 *
 * Every blend is affine in the edited layer's value (additive adds, override
 * mixes, scale multiplies), so two probes give the line and one more corrects
 * whatever is not quite (a clamp, a sequencer's blend). A layer that cannot move
 * the result (weight 0, muted, overridden from above) is keyed with `wanted`.
 */
export function solvePose(scene, item, prop, frame, wanted) {
    if (!scene || !_SCENE_EVALUATORS.length || !item) return _clone(wanted);
    const f = Math.round(frame);
    const layer = activeLayerOf(scene);
    const probe = (x) => {
        const copy = { ...item };
        const one = [{ f, v: _clone(x), ease: "hold" }];
        if (layer) {
            const lt = { ...(item.layerTracks || {}) };
            lt[layer.id] = { ...(lt[layer.id] || {}), [prop]: one };
            copy.layerTracks = lt;
        } else {
            copy.tracks = { ...(item.tracks || {}), [prop]: one };
        }
        return currentValue(scene, copy, prop, f);
    };
    const vec = Array.isArray(wanted);
    const at = (v, i) => (vec ? v[i] : v);
    const n = vec ? wanted.length : 1;
    const fill = (fn) => (vec ? wanted.map((_, i) => fn(i)) : fn(0));
    // Pairs of probe values, tried in turn per component until one moves the
    // result (a clamp, e.g. ikfk's 0..1, can hide the first pair's effect).
    const pairs = [[0, 1], [-1, 0], [(i) => at(wanted, i) - 1, (i) => at(wanted, i)], [-2, -1], [1, 2]];
    const xa = new Array(n), slope = new Array(n).fill(0), ca = new Array(n);
    for (const [pa, pb] of pairs) {
        const va = fill((i) => (typeof pa === "function" ? pa(i) : pa));
        const vb = fill((i) => (typeof pb === "function" ? pb(i) : pb));
        const ra = probe(va), rb = probe(vb);
        let open = false;
        for (let i = 0; i < n; i++) {
            if (Math.abs(slope[i]) >= 1e-9) continue;
            const a = (at(rb, i) - at(ra, i)) / ((at(vb, i) - at(va, i)) || 1);
            xa[i] = at(va, i); ca[i] = at(ra, i); slope[i] = a;
            if (Math.abs(a) < 1e-9) open = true;
        }
        if (!open) break;
    }
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(Math.abs(slope[i]) < 1e-9 ? at(wanted, i) : xa[i] + (at(wanted, i) - ca[i]) / slope[i]);
    }
    // One correction for anything not quite affine (a sequencer's blend).
    const check = probe(vec ? out : out[0]);
    for (let i = 0; i < n; i++) {
        const err = at(wanted, i) - at(check, i);
        if (Math.abs(slope[i]) >= 1e-9 && Math.abs(err) > 1e-7) out[i] += err / slope[i];
    }
    return vec ? out : out[0];
}

/** Key `prop` on the layer being edited so the stack shows `wanted` at `frame`. */
export function keyPose(scene, item, prop, frame, wanted, ease) {
    return setKeyframe(item, prop, frame, solvePose(scene, item, prop, frame, wanted), ease);
}

/**
 * Put `prop` where `wanted` says at `frame`: a key when `key` is asked for, the
 * property is keyed on the layer being edited, or that layer is not the base
 * (a layer holds animation only); else the item's own static value.
 */
export function setPose(scene, item, prop, frame, wanted, { key = false, ease } = {}) {
    if (key || isAnimated(item, prop) || activeLayerOf(scene)) return keyPose(scene, item, prop, frame, wanted, ease);
    return setStaticValue(item, prop, solvePose(scene, item, prop, frame, wanted));
}

/** Frames where anything in the scene has a key — the timeline's tick marks. */
export function sceneKeyframes(scene) {
    const out = new Set();
    for (const it of (scene && scene.items) || []) for (const f of allKeyframeFrames(it)) out.add(f);
    return [...out].sort((a, b) => a - b);
}

export function isAnimatedScene(scene) {
    return sceneKeyframes(scene).length > 0;
}

// ── Serialization ────────────────────────────────────────────────────────────

export const LAYER_MODES = ["additive", "override"];

/** The animation layers a scene file holds, cleaned: bottom first, unique ids, weights 0..1. */
export function readAnimLayers(data) {
    const list = data && Array.isArray(data.animLayers) ? data.animLayers : [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const id = typeof raw.id === "string" && raw.id && !seen.has(raw.id) ? raw.id : newId("L");
        seen.add(id);
        const w = Number(raw.weight);
        const layer = {
            id,
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : `AnimLayer${out.length + 1}`,
            mode: LAYER_MODES.includes(raw.mode) ? raw.mode : "additive",
            weight: Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 1,
            mute: raw.mute === true,
            solo: raw.solo === true,
            lock: raw.lock === true,
            tracks: {},
        };
        const wk = raw.tracks && Array.isArray(raw.tracks.weight) ? raw.tracks.weight : [];
        const keys = [];
        for (const k of wk) {
            if (!k || !Number.isFinite(Number(k.f)) || !Number.isFinite(Number(k.v))) continue;
            keys.push({ f: Math.round(Number(k.f)), v: Math.max(0, Math.min(1, Number(k.v))),
                        ease: k.ease === "linear" || k.ease === "hold" ? k.ease : "smooth" });
        }
        if (keys.length) layer.tracks.weight = keys.sort((a, b) => a.f - b.f);
        out.push(layer);
    }
    return out;
}


/**
 * A scene read from a file, a node widget or an older viewer state, with
 * everything missing filled in. Anything unreadable comes back as an empty
 * scene rather than throwing, so a damaged widget can't take the viewer down.
 */
export function parseScene(raw) {
    let data = raw;
    if (typeof raw === "string") {
        if (!raw.trim()) return makeScene();
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.warn("[ImageViewer] could not read the scene", e);
            return makeScene();
        }
    }
    if (!data || typeof data !== "object") return makeScene();

    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const vec = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x)))
        ? v.map(Number) : d.slice());

    const items = [];
    for (const raw of Array.isArray(data.items) ? data.items : []) {
        if (!raw || typeof raw !== "object") continue;
        const isCam = raw.kind === "camera";
        const isPrim = raw.kind === "primitive";
        const isGroup = raw.kind === "group";
        const isPlane = raw.kind === "imageplane";
        // A character rig's control (imageViewer_rigData.js): a transform
        // with a rest matrix above its channels and the bone it drives.
        const isCtrl = raw.kind === "control";
        // Worlds (imageViewer_worldData.js): an environment, a terrain, a
        // scatter or a depth mesh carries its own settings block and no src.
        const isWorld = WORLD_KINDS.includes(raw.kind);
        const item = {
            id: typeof raw.id === "string" && raw.id ? raw.id
                : newId(isCam ? "c" : isPrim ? "p" : isGroup ? "g" : isPlane ? "ip" : isCtrl ? "k" : "m"),
            kind: isCam ? "camera" : isPrim ? "primitive" : isGroup ? "group"
                : isPlane ? "imageplane" : isWorld ? raw.kind : isCtrl ? "control" : "model",
            name: typeof raw.name === "string" && raw.name ? raw.name
                : (isCam ? "Camera" : isPrim ? "Shape" : isGroup ? "Group"
                   : isPlane ? "Image plane" : isWorld ? raw.kind : isCtrl ? "control" : "model"),
            parent: typeof raw.parent === "string" && raw.parent ? raw.parent : null,
            position: vec(raw.position, [0, 0, 0]),
            rotation: vec(raw.rotation, [0, 0, 0]),
            scale: vec(raw.scale, [1, 1, 1]),
            pivot: vec(raw.pivot, [0, 0, 0]),
            visible: raw.visible !== false,
            tracks: {},
        };
        // Brought in from another scene file (imageViewer_sceneLayers.js).
        const ref = readItemRef(raw.ref);
        if (ref) item.ref = ref;
        if (isCam) {
            item.fov = num(raw.fov, 35);
            item.resolution = cameraResolution(raw);
            // The picture this camera's view has to match (a world's reference).
            const ref = referenceSettings(raw);
            if (ref) item.reference = ref;
            // Its look-at target, off unless switched on (imageViewer_cameraAim.js).
            const aim = readAim(raw.aim);
            if (aim) item.aim = aim;
        } else if (offsetOf(raw)) {
            item.offset = offsetOf(raw);
        }
        if (isCam) {
            // (the camera's fields are read above)
        } else if (isGroup) {
            // A group is its transform - and, for a rig's group, which character it rigs.
            readRigFields(item, raw);
        } else if (isCtrl) {
            readRigFields(item, raw);
        } else if (isWorld) {
            readWorldItem(item, raw);
        } else if (isPrim) {
            const type = raw.primitive && PRIMITIVE_TYPES.has(raw.primitive.type)
                ? raw.primitive.type : "box";
            item.primitive = { type };
            item.color = typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color)
                ? raw.color : DEFAULT_COLOR;
        } else if (isPlane) {
            item.src = raw.src && typeof raw.src === "object" ? raw.src : null;
            item.plane = planeSettings(raw);
        } else {
            item.src = raw.src && typeof raw.src === "object" ? raw.src : null;
            // An Atlas world set upright: with how many of its cameras (imageViewer_previzAtlasOrient.js).
            if (raw.atlasOrient && Number.isFinite(Number(raw.atlasOrient.frames))) {
                item.atlasOrient = { frames: Math.max(0, Math.round(Number(raw.atlasOrient.frames))) };
            }
            // How an Atlas world is shown (imageViewer_atlas3d.js): as a point cloud, and with its views.
            if (raw.atlasPoints === true) item.atlasPoints = true;
            if (raw.atlasViews === false) item.atlasViews = false;
            // Where single poses started from (imageViewer_previzRigPose.js): frame -> [base heading, posed heading].
            if (raw.rigPoseBase && typeof raw.rigPoseBase === "object" && !Array.isArray(raw.rigPoseBase)) {
                const kept = {};
                for (const [f, v] of Object.entries(raw.rigPoseBase).slice(0, 500)) {
                    if (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(Number(x)))) kept[f] = [Number(v[0]), Number(v[1])];
                }
                if (Object.keys(kept).length) item.rigPoseBase = kept;
            }
        }

        // Custom attributes (on controls) and blendshape weights (on models).
        if (raw.attrs && typeof raw.attrs === "object" && !Array.isArray(raw.attrs)) {
            const attrs = {};
            for (const [n, a] of Object.entries(raw.attrs).slice(0, 500)) {
                if (!n || n.length > 190 || !a || typeof a !== "object") continue;
                const lo = Number.isFinite(Number(a.min)) && a.min !== null ? Number(a.min) : undefined;
                const hi = Number.isFinite(Number(a.max)) && a.max !== null ? Number(a.max) : undefined;
                attrs[n] = { value: num(a.value, 0) };
                if (lo !== undefined) attrs[n].min = lo;
                if (hi !== undefined) attrs[n].max = hi;
            }
            if (Object.keys(attrs).length) item.attrs = attrs;
        }
        if (raw.blendshapes && typeof raw.blendshapes === "object" && !Array.isArray(raw.blendshapes)) {
            const bs = {};
            for (const [n, w] of Object.entries(raw.blendshapes).slice(0, 2000)) {
                if (n && n.length <= 190 && Number.isFinite(Number(w))) bs[n] = Math.max(0, Math.min(1, Number(w)));
            }
            if (Object.keys(bs).length) item.blendshapes = bs;
        }
        if (Number.isFinite(Number(raw.space)) && Number(raw.space) > 0) item.space = Math.round(Number(raw.space));
        if (Array.isArray(raw.drivers)) item.drivers = readDrivers(raw.drivers);
        if (!item.drivers || !item.drivers.length) delete item.drivers;

        const readSet = (tracks, onLayer = false) => {
            const out = {};
            tracks = tracks && typeof tracks === "object" ? tracks : {};
            for (const prop of [...TRACKS, ...Object.keys(tracks).filter(isExtraProp)]) {
                const list = Array.isArray(tracks[prop]) ? tracks[prop] : null;
                if (!list) continue;
                const keys = [];
                for (const k of list) {
                    if (!k || !Number.isFinite(Number(k.f))) continue;
                    const v = prop === "fov" ? num(k.v, item.fov ?? 35)
                        : prop === "ikfk" ? Math.max(onLayer ? -1 : 0, Math.min(1, num(k.v, onLayer ? 0 : (item.ikfk ?? 1))))
                        : prop === "space" ? Math.max(0, Math.round(num(k.v, 0)))
                        : isExtraProp(prop) ? num(k.v, 0)
                        : vec(k.v, item[prop]);
                    const key = { f: Math.round(Number(k.f)), v,
                                  ease: k.ease === "linear" || k.ease === "hold" ? k.ease : "smooth" };
                    // Hand-set tangents, in the same shape as the value. Anything
                    // else is left off, and the ease speaks for the key again.
                    const zero = _isScalar(prop) ? 0 : [0, 0, 0];
                    for (const side of ["ti", "to"]) {
                        if (k[side] === undefined) continue;
                        const t = _isScalar(prop) ? num(k[side], undefined) : vec(k[side], zero);
                        if (_isScalar(prop) ? Number.isFinite(t) : Array.isArray(t)) key[side] = t;
                    }
                    keys.push(key);
                }
                if (keys.length) {
                    keys.sort((a, b) => a.f - b.f);
                    out[prop] = keys;
                }
            }
            return out;
        };
        item.tracks = readSet(raw.tracks);
        // Keys on animation layers: the same shapes, one set per layer id
        // (layers that are not in the scene are dropped below).
        if (raw.layerTracks && typeof raw.layerTracks === "object") {
            const lt = {};
            for (const [lid, set] of Object.entries(raw.layerTracks)) {
                if (typeof lid !== "string" || !lid) continue;
                const one = readSet(set, true);
                if (Object.keys(one).length) lt[lid] = one;
            }
            if (Object.keys(lt).length) item.layerTracks = lt;
        }
        if (raw.infinity && typeof raw.infinity === "object") {
            for (const prop of TRACKS) {
                const inf = raw.infinity[prop];
                if (inf && typeof inf === "object") setInfinity(item, prop, { pre: inf.pre, post: inf.post });
            }
        }
        // A model (or an image plane) with no file left to point at is
        // dropped: it would show as an invisible row the user can't fix. A
        // shape carries its own geometry, so it has nothing to lose.
        if (!isCam && !isPrim && !isGroup && !isWorld && !isCtrl && !item.src) continue;
        // Constraints (imageViewer_constraintData.js) ride on the item they move.
        const cons = readConstraints(raw.constraints, item.kind);
        if (cons.length) item.constraints = cons;
        items.push(item);
    }

    const scene = makeScene({
        fps: Math.max(0.1, num(data.fps, DEFAULT_FPS)),
        length: Math.max(1, Math.round(num(data.length, DEFAULT_LENGTH))),
        lengthSet: !!data.lengthSet,
        items,
        activeCamera: typeof data.activeCamera === "string" ? data.activeCamera : null,
    });
    if (data.render && typeof data.render === "object") scene.render = renderSettings(data);
    // A world: where walking starts, and which world (and version) this is.
    if (data.walk && typeof data.walk === "object") scene.walk = walkSettings(data);
    const world = worldInfo(data);
    if (world) scene.world = world;
    // The studio lights: left out = "auto" (imageViewer_worldData.js studioLightsOn).
    if (data.defaultLights === "on" || data.defaultLights === "off") scene.defaultLights = data.defaultLights;
    // The clip sequencer's tracks and sources (imageViewer_clipSeqData.js tidies them).
    if (data.sequencer && typeof data.sequencer === "object") scene.sequencer = JSON.parse(JSON.stringify(data.sequencer));
    if (scene.activeCamera && !itemById(scene, scene.activeCamera)) scene.activeCamera = null;
    // Animation layers (imageViewer_animLayers.js blends them).
    const layers = readAnimLayers(data);
    if (layers.length) {
        scene.animLayers = layers;
        if (typeof data.activeLayer === "string" && layers.some((l) => l.id === data.activeLayer)) {
            scene.activeLayer = data.activeLayer;
        }
    }
    const known = new Set(layers.map((l) => l.id));
    for (const it of items) {
        if (!it.layerTracks) continue;
        for (const lid of Object.keys(it.layerTracks)) if (!known.has(lid)) delete it.layerTracks[lid];
        if (!Object.keys(it.layerTracks).length) delete it.layerTracks;
    }
    repairTree(scene);
    // Display layers, selection sets and references, their members held to the items there are.
    readSceneLayers(scene, data);
    pruneConstraints(scene);
    bindScene(scene);
    return scene;
}

/**
 * Make the tree true: a parent that isn't there, or a loop made by hand-editing
 * a widget, would otherwise hide items from the outliner for good. Both are
 * fixed by lifting the item back to the top rather than dropping it.
 */
export function repairTree(scene) {
    const byId = new Map((scene.items || []).map((it) => [it.id, it]));
    for (const item of scene.items || []) {
        if (item.parent && !byId.has(item.parent)) item.parent = null;
    }
    for (const item of scene.items || []) {
        const seen = new Set([item.id]);
        let node = item.parent ? byId.get(item.parent) : null;
        while (node) {
            if (seen.has(node.id)) { item.parent = null; break; }
            seen.add(node.id);
            node = node.parent ? byId.get(node.parent) : null;
        }
    }
    return scene;
}

export function serializeScene(scene) {
    return JSON.stringify(scene || makeScene());
}
