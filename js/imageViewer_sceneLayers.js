// imageViewer_sceneLayers.js
// Display layers, selection sets and references in a previz scene: the data
// and the rules, no three.js, no DOM (the panel is imageViewer_previzLayers.js,
// the drawing is imageViewer_model3d.js).
//
// DISPLAY LAYERS — scene.displayLayers, in the order the panel lists them:
//     { id, name, visible, mode, color, members: [item ids] }
//   visible  false hides everything on the layer, whatever its own eye says.
//   mode     "normal"     drawn and picked as usual
//            "template"   drawn as a grey (or coloured) wireframe, not
//                         pickable in the viewport, left out of a render
//            "reference"  drawn as it is, not pickable in the viewport
//   color    "#rrggbb" or null: the layer's swatch, and the colour a
//            template's wire is drawn in.
// An item is on one layer at most; putting it on another takes it off the
// first. What hangs under an item takes on its layer unless it is on one of
// its own, so a layer holding a character's model holds its rig too.
//
// SELECTION SETS — scene.selectionSets: { id, name, members: [item ids] }.
// A set is only a remembered selection: an item can be in any number, and
// nothing about the item changes. The character picker shows a character's
// sets as buttons.
//
// REFERENCES — scene.references: a scene file brought into this one, kept
// pointing at the file so a change saved there turns up here.
//     { id, namespace, path, follow, version, mtime }
//   path     the file as last read (follow "latest" moves it on to newer
//            versions of the same file name, as the export rules number them)
//   follow   "latest" or "pinned"
//   version  the version number read from the file name, or null
//   mtime    the file's modification time when it was read
// Every item brought in carries ref: { id, src, base }:
//   id       the reference it came from
//   src      its id in the file
//   base     what the file said for the fields a shot may change (OVERRIDES)
// Its own id is made from the two (refItemId), so a reload gives every item
// back the id it had: the shot's selection sets, layers, keys and anything
// else that names it keep working.
//
// A reload takes the file's version of everything, except the fields the
// shot has changed since the last load — a field whose value is no longer
// the `base` the file gave it is an edit made here, and stays. That is the
// whole override model: animate a referenced character's controls in a
// shot, save a fix to the character file, and the shot keeps its animation
// with the fixed character under it.
//
// Clean-room: written for this viewer from the behaviour described above.

export const LAYER_MODES = ["normal", "template", "reference"];
export const MODE_LABEL = { normal: "", template: "T", reference: "R" };
export const LAYER_COLORS = ["#d9534f", "#f0ad4e", "#f7e463", "#5cb85c", "#5bc0de", "#428bca", "#9b59b6", "#e83e8c"];

// What a shot may change on a referenced item and keep across a reload.
export const OVERRIDES = ["position", "rotation", "scale", "pivot", "visible", "ikfk", "fov", "tracks", "parent"];

let _seq = 0;
function _id(prefix) {
    _seq += 1;
    return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

const _hex = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
const _ids = (list) => (Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === "string" && x))] : []);
const _clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const _same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// ── Reading and writing ──────────────────────────────────────────────────────

/** An item's `ref` from a file or a widget, or null. */
export function readItemRef(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.src !== "string") return null;
    const base = raw.base && typeof raw.base === "object" ? _clone(raw.base) : {};
    return { id: raw.id, src: raw.src, base };
}

/**
 * The layers, sets and references of a scene as parseScene reads them, onto
 * `scene` (whose items are already read). Members naming no item are dropped.
 */
export function readSceneLayers(scene, data) {
    const known = new Set((scene.items || []).map((it) => it.id));
    const members = (list) => _ids(list).filter((id) => known.has(id));
    const layers = [];
    const onLayer = new Set();
    for (const raw of Array.isArray(data && data.displayLayers) ? data.displayLayers : []) {
        if (!raw || typeof raw !== "object") continue;
        const layer = {
            id: typeof raw.id === "string" && raw.id ? raw.id : _id("dl"),
            name: typeof raw.name === "string" && raw.name ? raw.name : "layer",
            visible: raw.visible !== false,
            mode: LAYER_MODES.includes(raw.mode) ? raw.mode : "normal",
            color: _hex(raw.color),
            // One layer per item: the first that names it keeps it.
            members: members(raw.members).filter((id) => !onLayer.has(id) && onLayer.add(id)),
        };
        if (typeof raw.ref === "string") { layer.ref = raw.ref; if (typeof raw.src === "string") layer.src = raw.src; }
        layers.push(layer);
    }
    const sets = [];
    for (const raw of Array.isArray(data && data.selectionSets) ? data.selectionSets : []) {
        if (!raw || typeof raw !== "object") continue;
        const set = {
            id: typeof raw.id === "string" && raw.id ? raw.id : _id("ss"),
            name: typeof raw.name === "string" && raw.name ? raw.name : "set",
            members: members(raw.members),
        };
        if (typeof raw.ref === "string") { set.ref = raw.ref; if (typeof raw.src === "string") set.src = raw.src; }
        sets.push(set);
    }
    const refs = [];
    for (const raw of Array.isArray(data && data.references) ? data.references : []) {
        if (!raw || typeof raw !== "object" || typeof raw.path !== "string" || !raw.path) continue;
        refs.push({
            id: typeof raw.id === "string" && raw.id ? raw.id : _id("rf"),
            namespace: typeof raw.namespace === "string" && raw.namespace ? raw.namespace : "ref",
            path: raw.path,
            follow: raw.follow === "pinned" ? "pinned" : "latest",
            version: Number.isFinite(Number(raw.version)) && raw.version !== null ? Number(raw.version) : null,
            mtime: Number.isFinite(Number(raw.mtime)) && raw.mtime !== null ? Number(raw.mtime) : null,
        });
    }
    // An item whose reference is gone is an ordinary item now.
    const refIds = new Set(refs.map((r) => r.id));
    for (const it of scene.items || []) if (it.ref && !refIds.has(it.ref.id)) delete it.ref;
    if (layers.length) scene.displayLayers = layers;
    if (sets.length) scene.selectionSets = sets;
    if (refs.length) scene.references = refs;
    return scene;
}

/** Drop members that no longer name an item — after a delete, say. */
export function pruneMembers(scene) {
    const known = new Set((scene.items || []).map((it) => it.id));
    for (const l of scene.displayLayers || []) l.members = l.members.filter((id) => known.has(id));
    for (const s of scene.selectionSets || []) s.members = s.members.filter((id) => known.has(id));
    return scene;
}

// ── Display layers ───────────────────────────────────────────────────────────

export function displayLayers(scene) {
    return (scene && scene.displayLayers) || [];
}

export function layerById(scene, id) {
    return displayLayers(scene).find((l) => l.id === id) || null;
}

/** The layer an item is on itself (not through a parent), or null. */
export function layerOf(scene, itemId) {
    return displayLayers(scene).find((l) => l.members.includes(itemId)) || null;
}

function _uniqueIn(list, wanted, exceptId = null) {
    const base = String(wanted || "").trim() || "layer";
    const taken = new Set(list.filter((x) => x.id !== exceptId).map((x) => x.name));
    if (!taken.has(base)) return base;
    const stem = base.replace(/\d+$/, "") || base;
    for (let n = 1; ; n++) if (!taken.has(`${stem}${n}`)) return `${stem}${n}`;
}

/** A new display layer holding `members` (taken off any other layer). */
export function addDisplayLayer(scene, name, members = []) {
    if (!scene.displayLayers) scene.displayLayers = [];
    const used = new Set(scene.displayLayers.map((l) => l.color));
    const layer = {
        id: _id("dl"),
        name: _uniqueIn(scene.displayLayers, name || "layer1"),
        visible: true, mode: "normal",
        color: LAYER_COLORS.find((c) => !used.has(c)) || null,
        members: [],
    };
    scene.displayLayers.push(layer);
    addToLayer(scene, layer.id, members);
    return layer;
}

/** Put items on a layer; each comes off whatever layer it was on. */
export function addToLayer(scene, layerId, ids) {
    const layer = layerById(scene, layerId);
    if (!layer) return 0;
    const known = new Set((scene.items || []).map((it) => it.id));
    const want = _ids(ids).filter((id) => known.has(id));
    for (const l of displayLayers(scene)) if (l !== layer) l.members = l.members.filter((id) => !want.includes(id));
    let n = 0;
    for (const id of want) if (!layer.members.includes(id)) { layer.members.push(id); n++; }
    return n;
}

/** Take items off every layer. */
export function removeFromLayers(scene, ids) {
    const drop = new Set(_ids(ids));
    let n = 0;
    for (const l of displayLayers(scene)) {
        const before = l.members.length;
        l.members = l.members.filter((id) => !drop.has(id));
        n += before - l.members.length;
    }
    return n;
}

export function deleteDisplayLayer(scene, layerId) {
    const list = displayLayers(scene);
    const i = list.findIndex((l) => l.id === layerId);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete scene.displayLayers;
    return true;
}

export function renameLayer(scene, layerId, wanted) {
    const layer = layerById(scene, layerId);
    const text = String(wanted == null ? "" : wanted).trim();
    if (!layer || !text) return null;
    layer.name = _uniqueIn(displayLayers(scene), text, layer.id);
    return layer.name;
}

/** Move a layer up (-1) or down (+1) the list. */
export function moveLayer(scene, layerId, by) {
    const list = displayLayers(scene);
    const i = list.findIndex((l) => l.id === layerId);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    return true;
}

/**
 * How every item is drawn, from the layers: Map id -> { visible, mode, color,
 * layer }. An item on no layer, under nothing that is, draws as usual (no entry).
 * A hidden layer anywhere up the tree hides the item; the nearest layer that
 * says template or reference decides the mode.
 */
export function displayStates(scene) {
    const out = new Map();
    const layers = displayLayers(scene);
    if (!layers.length) return out;
    const own = new Map();
    for (const l of layers) for (const id of l.members) own.set(id, l);
    const byId = new Map((scene.items || []).map((it) => [it.id, it]));
    const memo = new Map();
    const stateOf = (id, depth = 0) => {
        if (memo.has(id)) return memo.get(id);
        const item = byId.get(id);
        if (!item || depth > 256) return null;
        const up = item.parent ? stateOf(item.parent, depth + 1) : null;
        const mine = own.get(id);
        let st = up;
        if (mine) {
            st = {
                visible: mine.visible && (!up || up.visible),
                mode: mine.mode !== "normal" ? mine.mode : (up ? up.mode : "normal"),
                color: mine.mode !== "normal" || !up || up.mode === "normal" ? mine.color : up.color,
                layer: mine.id,
            };
        }
        memo.set(id, st);
        return st;
    };
    for (const id of byId.keys()) {
        const st = stateOf(id);
        if (st) out.set(id, st);
    }
    return out;
}

/** Can the viewport pick this item? Not when its layer is a template or a reference. */
export function isPickable(states, id) {
    const st = states && states.get(id);
    return !st || (st.visible && st.mode === "normal");
}

// ── Selection sets ───────────────────────────────────────────────────────────

export function selectionSets(scene) {
    return (scene && scene.selectionSets) || [];
}

export function setById(scene, id) {
    return selectionSets(scene).find((s) => s.id === id) || null;
}

export function addSelectionSet(scene, name, members = []) {
    if (!scene.selectionSets) scene.selectionSets = [];
    const known = new Set((scene.items || []).map((it) => it.id));
    const set = { id: _id("ss"), name: _uniqueIn(scene.selectionSets, name || "set1"),
                  members: _ids(members).filter((id) => known.has(id)) };
    scene.selectionSets.push(set);
    return set;
}

export function addToSet(scene, setId, ids) {
    const set = setById(scene, setId);
    if (!set) return 0;
    const known = new Set((scene.items || []).map((it) => it.id));
    let n = 0;
    for (const id of _ids(ids)) if (known.has(id) && !set.members.includes(id)) { set.members.push(id); n++; }
    return n;
}

export function removeFromSet(scene, setId, ids) {
    const set = setById(scene, setId);
    if (!set) return 0;
    const drop = new Set(_ids(ids));
    const before = set.members.length;
    set.members = set.members.filter((id) => !drop.has(id));
    return before - set.members.length;
}

export function deleteSelectionSet(scene, setId) {
    const list = selectionSets(scene);
    const i = list.findIndex((s) => s.id === setId);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete scene.selectionSets;
    return true;
}

export function renameSet(scene, setId, wanted) {
    const set = setById(scene, setId);
    const text = String(wanted == null ? "" : wanted).trim();
    if (!set || !text) return null;
    set.name = _uniqueIn(selectionSets(scene), text, set.id);
    return set.name;
}

/** The sets whose every member is one of `ids` (a character's controls, say). */
export function setsWithin(scene, ids) {
    const pool = new Set(ids);
    return selectionSets(scene).filter((s) => s.members.length && s.members.every((id) => pool.has(id)));
}

// ── Character picker ─────────────────────────────────────────────────────────

const _mul = (a, b) => {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
};
const _I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Where a character's controls go on its picker: one button per control, laid
 * out from where the control sits at rest, seen from the front (the character
 * facing you, its left on your right) or from its left side. Answers
 * { buttons: [{ id, name, type, side, role, x, y, r, color }], aspect } with
 * x and y in 0..1 (y down) and r a radius in the same units as x.
 */
export function pickerLayout(scene, modelId, view = "front") {
    const items = (scene && scene.items) || [];
    const ctrls = items.filter((it) => it.kind === "control" && it.control && it.control.model === modelId);
    if (!ctrls.length) return { buttons: [], limbs: [], aspect: 1 };
    const byId = new Map(ctrls.map((c) => [c.id, c]));
    const world = new Map();
    const at = (c, depth = 0) => {
        if (world.has(c.id)) return world.get(c.id);
        const parent = c.parent && byId.get(c.parent);
        const up = parent && depth < 256 ? at(parent, depth + 1) : _I;
        const m = _mul(up, Array.isArray(c.rest) && c.rest.length === 16 ? c.rest : _I);
        world.set(c.id, m);
        return m;
    };
    const raw = ctrls.map((c) => {
        const m = at(c);
        const p = [m[12], m[13], m[14]];
        const sh = c.control.shape || {};
        return {
            id: c.id, name: c.name, type: c.control.type, side: c.control.side || "C", role: c.control.role || null,
            u: view === "side" ? -p[2] : p[0], v: p[1],
            size: Number(sh.size) || 0.05, color: typeof sh.color === "string" ? sh.color : "#ffd24d",
        };
    });
    const us = raw.map((b) => b.u), vs = raw.map((b) => b.v);
    let minU = Math.min(...us), maxU = Math.max(...us), minV = Math.min(...vs), maxV = Math.max(...vs);
    const height = Math.max(1e-6, maxV - minV, maxU - minU);
    const pad = height * 0.08;
    minU -= pad; maxU += pad; minV -= pad; maxV += pad;
    const w = Math.max(1e-6, maxU - minU), h = Math.max(1e-6, maxV - minV);
    const span = Math.max(w, h);
    // Buttons big enough to hit, small enough to keep apart: the shape's size,
    // held between a floor and a ceiling of the picture.
    const radius = (b) => {
        const want = b.type === "root" ? 0.06 : b.type === "cog" ? 0.05 : b.type === "ik" ? 0.035
            : b.type === "pole" ? 0.022 : Math.min(0.03, Math.max(0.014, (b.size / span) * 0.35));
        return want * (span / w);
    };
    const buttons = raw.map((b) => ({
        id: b.id, name: b.name, type: b.type, side: b.side, role: b.role, color: b.color,
        x: (b.u - minU) / w, y: 1 - (b.v - minV) / h, r: radius(b),
    }));
    // The root sits under the feet rather than on top of the COG.
    for (const b of buttons) if (b.type === "root") b.y = Math.min(0.97, Math.max(b.y, 0.95));
    // An IK control sits where its hand or foot is, on top of that FK button:
    // seen from the front it moves out to the side, beside it. Each limb also
    // gets an IK / FK switch (`limbs`) beside its IK button, on the side
    // towards the middle (under a hand, over a foot), so it stays inside.
    const aspect = w / h;
    const cogB = buttons.find((b) => b.type === "cog");
    const mid = cogB ? cogB.x : 0.5;
    const limbs = [];
    for (const b of buttons) {
        if (b.type !== "ik") continue;
        if (view === "front") {
            const out = b.x >= mid ? 1 : -1;
            b.x = Math.min(0.98, Math.max(0.02, b.x + out * b.r * 2.6));
        }
        limbs.push({ ik: b.id, side: b.side, role: b.role, x: b.x,
                     y: b.y + (b.y < 0.5 ? 1 : -1) * Math.max(b.r * aspect * 2.2, 0.06) });
    }
    return { buttons, limbs, aspect };
}

// ── References ───────────────────────────────────────────────────────────────

export function references(scene) {
    return (scene && scene.references) || [];
}

export function referenceById(scene, id) {
    return references(scene).find((r) => r.id === id) || null;
}

export function referencedItems(scene, refId) {
    return ((scene && scene.items) || []).filter((it) => it.ref && it.ref.id === refId);
}

export function isReferenced(item) {
    return !!(item && item.ref);
}

/** The id an item from reference `refId` gets for its id `src` in the file. */
export function refItemId(refId, src) {
    return `${refId}_${src}`;
}

/** A namespace no other reference uses, from a file name: "hero_v003.json" -> "hero". */
export function namespaceFor(scene, path, wanted = null) {
    let base = wanted;
    if (!base) {
        const file = String(path || "").split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
        // <name>_v003, or the shot layout's <shot>_v003_<name>
        const m = file.match(/^.+?_v\d{3,}_(.+)$/i) || file.match(/^(.+?)_v\d{3,}$/i);
        base = (m ? m[1] : file) || "ref";
    }
    base = String(base).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "ref";
    const taken = new Set(references(scene).map((r) => r.namespace));
    if (!taken.has(base)) return base;
    for (let n = 1; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/** The version number in a file name, or null. */
export function versionOf(path) {
    const file = String(path || "").split(/[\\/]/).pop();
    const m = file.match(/_v(\d{3,})(?:[_.]|$)/i);
    return m ? Number(m[1]) : null;
}

// Every field of an item that names another item.
function _remap(item, map) {
    const to = (id) => (id && map.has(id) ? map.get(id) : id);
    item.id = to(item.id);
    if (item.parent) item.parent = map.has(item.parent) ? map.get(item.parent) : null;
    if (item.control) {
        if (item.control.model) item.control.model = to(item.control.model);
        if (item.control.pole) item.control.pole = to(item.control.pole);
        if (item.control.ik) item.control.ik = to(item.control.ik);
    }
    if (item.rig && item.rig.model) item.rig.model = to(item.rig.model);
    return item;
}

const _strip = (name, ns) => (ns && String(name).startsWith(`${ns}:`) ? String(name).slice(ns.length + 1) : String(name));

/**
 * What a reference brings in from its file, as this scene will hold it:
 * items with their ids, names and links made the reference's own, and the
 * file's own layers and sets the same way. `file` is a parsed scene.
 */
export function referencePayload(ref, file) {
    const src = (file && file.items) || [];
    const map = new Map(src.map((it) => [it.id, refItemId(ref.id, it.id)]));
    const items = src.map((raw) => {
        const it = _remap(_clone(raw), map);
        // A reference in the file comes in flat: its items are this file's now.
        it.name = `${ref.namespace}:${raw.name}`;
        const base = {};
        for (const f of OVERRIDES) if (raw[f] !== undefined) base[f] = _clone(f === "parent" ? it.parent : raw[f]);
        it.ref = { id: ref.id, src: raw.id, base };
        delete it.fromTab;
        return it;
    });
    const known = new Set(items.map((it) => it.id));
    const members = (list) => (list || []).map((id) => map.get(id)).filter((id) => id && known.has(id));
    const layers = displayLayers(file).map((l) => ({
        ...l, id: refItemId(ref.id, l.id), name: `${ref.namespace}:${l.name}`,
        members: members(l.members), ref: ref.id, src: l.id,
    }));
    const sets = selectionSets(file).map((s) => ({
        ...s, id: refItemId(ref.id, s.id), name: `${ref.namespace}:${s.name}`,
        members: members(s.members), ref: ref.id, src: s.id,
    }));
    return { items, layers, sets };
}

/**
 * Bring a reference's file into the scene, or bring it up to date.
 *
 * Items already in from this reference are matched by their id in the file:
 * each takes the file's version, except fields the shot has changed (no
 * longer equal to the `base` the last load recorded), which stay. Items the
 * file no longer has go; new ones come in where the reference's items are.
 * Answers { added, removed, kept, lostKeys } — `kept` counts items that
 * carried an override across, `lostKeys` the removed items that had keys.
 */
export function mergeReference(scene, ref, file) {
    const { items, layers, sets } = referencePayload(ref, file);
    const old = new Map(referencedItems(scene, ref.id).map((it) => [it.ref.src, it]));
    let kept = 0;
    for (const it of items) {
        const was = old.get(it.ref.src);
        if (!was) continue;
        let over = false;
        for (const f of OVERRIDES) {
            const before = was.ref && was.ref.base ? was.ref.base[f] : undefined;
            if (!_same(was[f], before)) {
                if (was[f] === undefined) delete it[f]; else it[f] = _clone(was[f]);
                over = true;
            }
        }
        if (over) kept++;
    }
    const fresh = new Set(items.map((it) => it.ref.src));
    const gone = [...old.values()].filter((it) => !fresh.has(it.ref.src));
    const lostKeys = gone.filter((it) => it.tracks && Object.keys(it.tracks).length).length;
    // In the place the reference's items were, so the outliner keeps its order.
    const list = scene.items || (scene.items = []);
    const first = list.findIndex((it) => it.ref && it.ref.id === ref.id);
    const rest = list.filter((it) => !(it.ref && it.ref.id === ref.id));
    const at = first < 0 ? rest.length : list.slice(0, first).filter((it) => !(it.ref && it.ref.id === ref.id)).length;
    rest.splice(at, 0, ...items);
    scene.items = rest;
    // A parent the shot gave that is gone now: back to the file's.
    const ids = new Set(scene.items.map((it) => it.id));
    for (const it of items) if (it.parent && !ids.has(it.parent)) it.parent = it.ref.base.parent || null;

    // The file's own layers and sets: the file's members, the shot's look.
    const oldLayers = new Map(displayLayers(scene).filter((l) => l.ref === ref.id).map((l) => [l.src, l]));
    const otherLayers = displayLayers(scene).filter((l) => l.ref !== ref.id);
    const newLayers = layers.map((l) => {
        const was = oldLayers.get(l.src);
        return was ? { ...l, visible: was.visible, mode: was.mode, color: was.color } : l;
    });
    const allLayers = [...otherLayers, ...newLayers];
    // An item the shot put on one of its own layers stays there.
    const shotHeld = new Set(otherLayers.flatMap((l) => l.members));
    for (const l of newLayers) l.members = l.members.filter((id) => !shotHeld.has(id));
    if (allLayers.length) scene.displayLayers = allLayers; else delete scene.displayLayers;
    const allSets = [...selectionSets(scene).filter((s) => s.ref !== ref.id), ...sets];
    if (allSets.length) scene.selectionSets = allSets; else delete scene.selectionSets;
    pruneMembers(scene);
    return { added: [...fresh].filter((s) => !old.has(s)).length,
             removed: gone.length, kept, lostKeys, items: items.length };
}

/** A new reference record (not yet loaded). */
export function addReference(scene, path, { namespace = null, follow = "latest" } = {}) {
    if (!scene.references) scene.references = [];
    const ref = { id: _id("rf"), namespace: namespaceFor(scene, path, namespace), path,
                  follow: follow === "pinned" ? "pinned" : "latest", version: versionOf(path), mtime: null };
    scene.references.push(ref);
    return ref;
}

/** Take a reference out, and everything it brought in. */
export function removeReference(scene, refId) {
    const list = references(scene);
    const i = list.findIndex((r) => r.id === refId);
    if (i < 0) return 0;
    list.splice(i, 1);
    if (!list.length) delete scene.references;
    const gone = new Set(referencedItems(scene, refId).map((it) => it.id));
    scene.items = scene.items.filter((it) => !gone.has(it.id));
    if (scene.activeCamera && gone.has(scene.activeCamera)) scene.activeCamera = null;
    const layers = displayLayers(scene).filter((l) => l.ref !== refId);
    if (layers.length) scene.displayLayers = layers; else delete scene.displayLayers;
    const sets = selectionSets(scene).filter((s) => s.ref !== refId);
    if (sets.length) scene.selectionSets = sets; else delete scene.selectionSets;
    pruneMembers(scene);
    return gone.size;
}

/**
 * Give a reference a new namespace: its items, layers and sets are renamed;
 * their ids stay, so nothing that names them breaks.
 */
export function renameNamespace(scene, refId, wanted) {
    const ref = referenceById(scene, refId);
    if (!ref) return null;
    const others = { references: references(scene).filter((r) => r.id !== refId) };
    const ns = namespaceFor(others, "", String(wanted || "").trim() || ref.namespace);
    const swap = (name) => `${ns}:${_strip(name, ref.namespace)}`;
    for (const it of referencedItems(scene, refId)) it.name = swap(it.name);
    for (const l of displayLayers(scene)) if (l.ref === refId) l.name = swap(l.name);
    for (const s of selectionSets(scene)) if (s.ref === refId) s.name = swap(s.name);
    ref.namespace = ns;
    return ns;
}

/** Turn a referenced item into an ordinary one — what a copy of it is. */
export function unreferenced(item) {
    const copy = _clone(item);
    delete copy.ref;
    return copy;
}
