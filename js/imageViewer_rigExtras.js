// imageViewer_rigExtras.js
// Rigging extras, the data and the maths (no three.js, no DOM; tested in node,
// tests/test_rig_extras.mjs):
//
//   POSES     a character's controls as numbers, keyed by what each control
//             drives so a pose goes back onto the same rig - or another rig of
//             the same skeleton, or (by humanoid role) another humanoid; blended
//             in at any weight; and the whole body mirrored (flipBonesPose).
//   SPACES    which part of the rig a control follows: its own parent, or any
//             of control.spaces (the world, the root, the COG, the chest, the
//             head ...), switched by the keyable "space" channel without a jump.
//   DRIVERS   set-driven keys, evaluated with the scene (evaluateDriven); the
//             curves themselves are imageViewer_rigDrivers.js.
//   FACE      facial controls: a board beside the head with joysticks whose
//             moves drive the character's blendshapes (morph targets) through
//             set-driven keys, matched to the morphs by their names (the ARKit
//             52, and the same names spelt with _L / .L / Left).
//
// Clean room: written from what an animator expects of these tools, with
// textbook rigid-transform maths, for this file.

import * as S from "./imageViewer_scene3d.js";
import { mat4, quat, v3 } from "./imageViewer_rigData.js";
import { drivenDelta, curveAt } from "./imageViewer_rigDrivers.js";

/** An item's channels as the scene plays them (clips and layers included, where the scene model has them). */
const evalIn = (scene, item, frame) => (S.evaluateIn ? S.evaluateIn(scene, item, frame) : S.evaluate(item, frame));

// ── Names ────────────────────────────────────────────────────────────────────

/** The other side's name of a bone or role (Left <-> Right, .L <-> .R, _l <-> _r ...). */
export function flipName(s) {
    return String(s || "").replace(/(Left|Right|left|right|\.L\b|\.R\b|\.l\b|\.r\b|_l\b|_r\b|_L\b|_R\b|\bL_|\bR_|\bl_|\br_)/g,
        (m) => ({ Left: "Right", Right: "Left", left: "right", right: "left", ".L": ".R", ".R": ".L", ".l": ".r", ".r": ".l",
                  _l: "_r", _r: "_l", _L: "_R", _R: "_L", L_: "R_", R_: "L_", l_: "r_", r_: "l_" }[m] || m));
}

// ── Poses ────────────────────────────────────────────────────────────────────

/** What a control drives, as a pose names it. */
export function poseKey(c) {
    const k = c && c.control;
    if (!k) return null;
    if (k.type === "fk") return `fk:${k.bone}`;
    if (k.type === "ik" || k.type === "pole") return `${k.type}:${k.role}`;
    if (k.type === "face") return `face:${k.face || c.name}`;
    return k.type;              // root, cog
}

const r6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * The pose of a character's controls at `frame`: { controls: { key: {...} }, blendshapes }.
 * `ids` limits it to some controls; `blendshapes` (default true) takes the
 * model's blendshape weights along.
 */
export function capturePose(scene, modelId, frame, { ids = null, blendshapes = true } = {}) {
    const only = ids && ids.length ? new Set(ids) : null;
    const controls = {};
    for (const c of controlsOfModel(scene, modelId)) {
        if (only && !only.has(c.id)) continue;
        const key = poseKey(c);
        if (!key) continue;
        const at = evalIn(scene, c, frame);
        const one = { position: at.position.map(r6), rotation: at.rotation.map(r6) };
        if (c.control.role) one.role = c.control.role;
        if (c.control.type === "ik") one.ikfk = r6(at.ikfk ?? 1);
        const attrs = {};
        for (const n of Object.keys(c.attrs || {})) attrs[n] = r6(S.valueAt(c, `attr:${n}`, frame));
        for (const p of Object.keys(c.tracks || {})) if (p.startsWith("attr:")) attrs[p.slice(5)] = r6(S.valueAt(c, p, frame));
        if (Object.keys(attrs).length) one.attrs = attrs;
        controls[key] = one;
    }
    const out = { controls };
    const model = S.itemById(scene, modelId);
    if (blendshapes && model && !only) {
        const bs = {};
        for (const p of S.namedProps(model)) if (p.startsWith("bs:")) bs[p.slice(3)] = r6(S.valueAt(model, p, frame));
        if (Object.keys(bs).length) out.blendshapes = bs;
    }
    return out;
}

export function controlsOfModel(scene, modelId) {
    return ((scene && scene.items) || []).filter((it) => it.kind === "control" && it.control && it.control.model === modelId);
}

/** The pose's entry for a control: by what it drives, else (FK) by its humanoid role. */
export function poseEntryFor(pose, c, byRole = null) {
    const key = poseKey(c);
    if (key && pose.controls[key]) return pose.controls[key];
    if (c.control.type === "fk" && c.control.role) {
        const map = byRole || rolesOfPose(pose);
        return map.get(c.control.role) || null;
    }
    return null;
}

export function rolesOfPose(pose) {
    const m = new Map();
    for (const [k, e] of Object.entries(pose.controls || {})) if (k.startsWith("fk:") && e.role) m.set(e.role, e);
    return m;
}

/** Euler (degrees) blended the short way: through quaternions, written back near `a`. */
export function blendRotation(a, b, t) {
    if (t >= 1) return quat.toEulerDeg(quat.fromEulerDeg(b), a);
    if (t <= 0) return a.slice();
    return quat.toEulerDeg(quat.slerp(quat.fromEulerDeg(a), quat.fromEulerDeg(b), t), a);
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * What applying a pose writes: [{ id, prop, value }] (prop "position" / "rotation"
 * / "ikfk" / "attr:<n>" / "bs:<morph>"), at weight `blend` (0..1) over the pose
 * the character has at `frame`. `ids` limits it to some controls. Answers
 * { writes, matched, missing } (missing: pose entries no control took).
 */
export function poseWrites(scene, modelId, pose, frame, { ids = null, blend = 1 } = {}) {
    const t = Math.max(0, Math.min(1, Number(blend)));
    const only = ids && ids.length ? new Set(ids) : null;
    const byRole = rolesOfPose(pose);
    const writes = [];
    const used = new Set();
    let matched = 0;
    for (const c of controlsOfModel(scene, modelId)) {
        if (only && !only.has(c.id)) continue;
        const e = poseEntryFor(pose, c, byRole);
        if (!e) continue;
        matched++;
        used.add(e);
        const at = S.evaluate(c, frame);
        if (e.position) writes.push({ id: c.id, prop: "position", value: at.position.map((x, i) => lerp(x, e.position[i], t)) });
        if (e.rotation) writes.push({ id: c.id, prop: "rotation", value: blendRotation(at.rotation, e.rotation, t) });
        if (c.control.type === "ik" && Number.isFinite(e.ikfk)) writes.push({ id: c.id, prop: "ikfk", value: lerp(at.ikfk ?? 1, e.ikfk, t) });
        for (const [n, v] of Object.entries(e.attrs || {})) {
            const p = `attr:${n}`;
            if (!(c.attrs && c.attrs[n]) && !S.isAnimated(c, p)) continue;
            writes.push({ id: c.id, prop: p, value: lerp(S.valueAt(c, p, frame), v, t) });
        }
    }
    const model = S.itemById(scene, modelId);
    if (model && pose.blendshapes && !only) {
        for (const [n, v] of Object.entries(pose.blendshapes)) {
            const p = `bs:${n}`;
            writes.push({ id: model.id, prop: p, value: lerp(S.valueAt(model, p, frame), v, t) });
        }
    }
    const missing = Object.entries(pose.controls || {}).filter(([, e]) => !used.has(e)).map(([k]) => k);
    return { writes, matched, missing };
}

/**
 * The whole body mirrored across the character's X (its left and right): each
 * bone takes its twin's change from rest, reflected - S·(pose·rest⁻¹)·S·rest,
 * S = diag(-1, 1, 1) - so the bone axes either side was built with do not
 * matter. A bone with no twin (the spine, the head) is reflected onto itself.
 * `pose`, `rest`: Map bone -> model-space 4x4. Answers the mirrored Map.
 */
export function flipBonesPose(pose, rest) {
    const SX = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const out = new Map(pose);
    for (const [b, m] of pose) {
        if (!rest.has(b)) continue;
        let t = flipName(b);
        if (t === b || !rest.has(t) || !pose.has(t)) t = b;
        const delta = mat4.mul(m, mat4.invert(rest.get(b)));
        out.set(t, mat4.mul(mat4.mul(mat4.mul(SX, delta), SX), rest.get(t)));
    }
    return out;
}

// ── Spaces ───────────────────────────────────────────────────────────────────

/**
 * Where a rig item sits at rest, in the rig group's space (= the model's): a
 * control's rest under its parent's rest, all the way up; the rig group, or
 * anything that is not a control, is the identity.
 */
export function restWorld(scene, id) {
    let m = mat4.identity();
    const chain = [];
    for (let it = id ? S.itemById(scene, id) : null; it && it.kind === "control"; it = it.parent ? S.itemById(scene, it.parent) : null) {
        chain.unshift(it);
    }
    for (const c of chain) m = mat4.mul(m, c.rest || mat4.identity());
    return m;
}

/** The spaces a control can follow: index 0 its own parent, then control.spaces. */
export function spacesOf(scene, ctrl) {
    const list = [{ id: ctrl.parent, name: "Parent" }];
    for (const id of (ctrl.control && ctrl.control.spaces) || []) {
        const it = S.itemById(scene, id);
        if (it) list.push({ id, name: spaceName(it) });
    }
    return list;
}

export function spaceName(it) {
    if (!it) return "?";
    if (it.kind === "group" && it.rig) return "World";
    const k = it.control;
    if (k && (k.type === "root" || k.type === "cog")) return k.type === "root" ? "Root" : "COG";
    if (k && k.type === "ik" && k.role) {
        const side = /\.L$/.test(k.role) ? "Left" : /\.R$/.test(k.role) ? "Right" : "";
        return `${side} ${k.role.startsWith("leg") ? "foot" : "hand"}`.trim();
    }
    if (k && k.role) {
        const named = { hips: "Hips", spine: "Spine", chest: "Chest", upperChest: "Chest", neck: "Neck", head: "Head" }[k.role];
        if (named) return named;
        return k.role.replace(/\.(L|R)$/, (m, s2) => (s2 === "L" ? " left" : " right")).replace(/^./, (c) => c.toUpperCase());
    }
    return it.name;
}

/** The space index a control is in at `frame` (held to the list). */
export function spaceAt(scene, ctrl, frame) {
    const n = 1 + (((ctrl.control && ctrl.control.spaces) || []).length);
    return Math.max(0, Math.min(n - 1, Math.round(S.valueAt(ctrl, "space", frame) || 0)));
}

/**
 * The spaces worth offering a control: the world, the root, the COG, the hips,
 * the chest and the head - the ones animators switch hands, feet and props to -
 * leaving out its own parent and anything that hangs under it.
 */
export function spaceCandidates(scene, ctrl) {
    const model = ctrl.control && ctrl.control.model;
    const under = new Set([ctrl.id, ...S.descendantsOf(scene, ctrl.id).map((d) => d.id)]);
    const out = [];
    const group = ((scene && scene.items) || []).find((it) => it.kind === "group" && it.rig && it.rig.model === model);
    const push = (it) => { if (it && !under.has(it.id) && !out.some((o) => o.id === it.id)) out.push({ id: it.id, name: spaceName(it) }); };
    push(group);
    const ctrls = controlsOfModel(scene, model);
    for (const t of ["root", "cog"]) push(ctrls.find((c) => c.control.type === t));
    for (const role of ["hips", "chest", "upperChest", "neck", "head"]) push(ctrls.find((c) => c.control.type === "fk" && c.control.role === role));
    // Hands for props, feet for the other foot.
    for (const c of ctrls) if (c.control.type === "ik") push(c);
    return out.filter((o) => o.id !== ctrl.parent);
}

/**
 * The matrix the control's rest node takes, in its parent's space, to follow
 * space `index`: its own rest for 0; else P⁻¹ · T · (T₀⁻¹ · P₀) · rest - the
 * control kept where the target held it at rest, so a rig at rest looks the
 * same whatever space each control is in. `worldOf(id)` is an item's world now
 * (model space; the rig group's is the identity's equivalent there).
 */
export function spaceRestMatrix(scene, ctrl, index, worldOf) {
    const rest = ctrl.rest || mat4.identity();
    const spaces = (ctrl.control && ctrl.control.spaces) || [];
    if (!index || index > spaces.length) return rest;
    const target = spaces[index - 1];
    const P = worldOf(ctrl.parent), T = worldOf(target);
    if (!P || !T) return rest;
    const off = mat4.mul(mat4.invert(restWorld(scene, target)), restWorld(scene, ctrl.parent));
    return mat4.mul(mat4.mul(mat4.mul(mat4.invert(P), T), off), rest);
}

/**
 * The channels that keep a control where it is (`now`, its world in model space)
 * when it goes into space `index`. Answers { position, rotation }.
 */
export function channelsInSpace(scene, ctrl, index, now, worldOf, near = null) {
    const top = spaceRestMatrix(scene, ctrl, index, worldOf);
    const P = worldOf(ctrl.parent) || mat4.identity();
    const local = mat4.mul(mat4.invert(mat4.mul(P, top)), now);
    const d = mat4.decompose(local);
    const tidy = (x) => (Math.abs(x) < 1e-9 ? 0 : x);
    return { position: d.p.map(tidy), rotation: quat.toEulerDeg(d.q, near) };
}

// ── Set-driven keys, with the scene ──────────────────────────────────────────

/**
 * An item's channels at `frame` with what its drivers add (and their drivers',
 * to a depth of 6 - a loop stops there rather than hanging the page).
 */
export function evaluateDriven(scene, item, frame, depth = 0, at = null) {
    at = at || evalIn(scene, item, frame);
    if (!item.drivers || !item.drivers.length || depth > 6) return at;
    const valueOf = (id, prop, axis, f) => {
        const d = S.itemById(scene, id);
        if (!d) return NaN;
        const v = evaluateDriven(scene, d, f, depth + 1)[prop] ?? S.valueAt(d, prop, f);
        return axis !== null && axis !== undefined && Array.isArray(v) ? v[axis] : (Array.isArray(v) ? NaN : v);
    };
    const delta = drivenDelta(item, frame, valueOf);
    if (!delta.size) return at;
    const out = { ...at };
    for (const [prop, dv] of delta) {
        if (Array.isArray(dv)) {
            const base = out[prop] || S.valueAt(item, prop, frame);
            out[prop] = base.map((x, i) => x + dv[i]);
        } else {
            const base = out[prop] !== undefined ? out[prop] : S.valueAt(item, prop, frame);
            let v = base + dv;
            if (prop === "ikfk") v = Math.max(0, Math.min(1, v));
            else if (S.isExtraProp(prop)) {
                const [lo, hi] = S.extraRange(item, prop);
                v = Math.max(lo, Math.min(hi, v));
            }
            out[prop] = v;
        }
    }
    return out;
}

/** What the drivers add to one channel of an item now (the difference evaluateDriven makes). */
export function drivenPart(scene, item, prop, frame) {
    const a = evalIn(scene, item, frame);
    const b = evaluateDriven(scene, item, frame, 0, a);
    const x = a[prop] !== undefined ? a[prop] : S.valueAt(item, prop, frame);
    const y = b[prop] !== undefined ? b[prop] : x;
    return Array.isArray(x) ? x.map((v, i) => y[i] - v) : y - x;
}

/** The value a driver channel has now (drivers included), for the SDK window. */
export function channelValue(scene, id, prop, axis, frame) {
    const it = S.itemById(scene, id);
    if (!it) return NaN;
    const at = evaluateDriven(scene, it, frame);
    const v = at[prop] !== undefined ? at[prop] : S.valueAt(it, prop, frame);
    return Array.isArray(v) ? v[axis || 0] : v;
}

export { curveAt };

// ── Facial controls ──────────────────────────────────────────────────────────

/** A morph's name made comparable: lower case, no separators, Left / Right as l / r. */
export function morphKey(name) {
    return String(name || "").toLowerCase().replace(/left/g, "l").replace(/right/g, "r").replace(/[^a-z0-9]/g, "");
}

/** The morph of `names` that is `wanted` (an ARKit name), whatever its spelling, or null. */
export function findMorph(names, wanted) {
    const want = morphKey(wanted);
    const strip = (k) => k.replace(/^(blendshape\d*|bs|shape|morph)/, "");
    for (const n of names) if (morphKey(n) === want) return n;
    for (const n of names) if (strip(morphKey(n)) === want) return n;
    // "Mouth_Smile_L" and the like: ends with the name.
    for (const n of names) if (morphKey(n).endsWith(want) && want.length > 5) return n;
    return null;
}

// The joysticks: where each sits on the board (units of `cell`, x across the
// character's own left, y up) and which morph each direction of it drives.
// x+ is the CHARACTER'S left (+X in model space), as the board faces you.
export const FACE_CONTROLS = [
    { face: "brow_L",  at: [1.6, 2.6],  y: ["browOuterUpLeft", "browDownLeft"], x: ["", "browInnerUp"] },
    { face: "brow_R",  at: [-1.6, 2.6], y: ["browOuterUpRight", "browDownRight"], x: ["browInnerUp", ""] },
    { face: "eye_L",   at: [1.6, 1.2],  y: ["eyeWideLeft", "eyeBlinkLeft"], x: ["eyeLookOutLeft", "eyeLookInLeft"] },
    { face: "eye_R",   at: [-1.6, 1.2], y: ["eyeWideRight", "eyeBlinkRight"], x: ["eyeLookInRight", "eyeLookOutRight"] },
    { face: "cheek_L", at: [1.6, -0.2], y: ["cheekSquintLeft", ""], x: ["cheekPuff", ""] },
    { face: "cheek_R", at: [-1.6, -0.2], y: ["cheekSquintRight", ""], x: ["", "cheekPuff"] },
    { face: "mouth_L", at: [1.4, -1.6], y: ["mouthSmileLeft", "mouthFrownLeft"], x: ["mouthStretchLeft", "mouthPucker"] },
    { face: "mouth_R", at: [-1.4, -1.6], y: ["mouthSmileRight", "mouthFrownRight"], x: ["mouthPucker", "mouthStretchRight"] },
    { face: "mouth",   at: [0, -1.6],   y: ["mouthShrugUpper", "mouthFunnel"], x: ["mouthLeft", "mouthRight"] },
    { face: "jaw",     at: [0, -3.0],   y: ["mouthClose", "jawOpen"], x: ["jawLeft", "jawRight"] },
];

/**
 * Facial controls for a model whose meshes have `morphs` (names), hung under
 * `parentId` (the head's FK control when there is one, else the rig group).
 * `head` is where the head is (model space), `height` the character's.
 * Answers { items, drivers, used, unused } - the controls to push into the
 * scene (board first), the drivers to add to the model, and which morphs the
 * joysticks reach and which they do not (those are in the Blendshapes window).
 */
export function buildFaceRig(scene, model, morphs, { parentId, head, height = 1.7 } = {}) {
    const cell = 0.016 * height;              // one unit of the board, and a joystick's full travel
    const board = [head[0] + 0.16 * height, head[1], head[2] + 0.02 * height];
    const parentW = restWorld(scene, parentId);
    const items = [];
    const make = (name, parent, parentWorld, world, control) => {
        const it = {
            id: S.newId("k"), kind: "control", name, parent,
            position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0],
            visible: true, tracks: {}, rest: mat4.mul(mat4.invert(parentWorld), world),
            control: { model: model.id, type: "face", side: "C", ...control },
        };
        items.push(it);
        return it;
    };
    const boardW = mat4.compose(board, [0, 0, 0, 1], [1, 1, 1]);
    const b = make("face_board", parentId, parentW, boardW,
        { face: "board", shape: { type: "square", size: 4 * cell, axis: [0, 0, 1], color: "#8a8a8a" } });
    const drivers = [];
    const used = new Set();
    for (const f of FACE_CONTROLS) {
        const dirs = [["y", 1, f.y[0]], ["y", -1, f.y[1]], ["x", 1, f.x[0]], ["x", -1, f.x[1]]];
        const found = dirs.map(([ax, sign, want]) => [ax, sign, want ? findMorph(morphs, want) : null]);
        if (!found.some(([, , m]) => m)) continue;
        const side = /_L$/.test(f.face) ? "L" : /_R$/.test(f.face) ? "R" : "C";
        const w = mat4.compose([board[0] + f.at[0] * cell, board[1] + f.at[1] * cell, board[2]], [0, 0, 0, 1], [1, 1, 1]);
        const j = make(`face_${f.face}_ctrl`, b.id, boardW, w, {
            face: f.face, side,
            shape: { type: "circle", size: 0.35 * cell, axis: [0, 0, 1], color: side === "L" ? "#4da6ff" : side === "R" ? "#ff5a5a" : "#ffd24d" },
        });
        for (const [ax, sign, m] of found) {
            if (!m) continue;
            used.add(m);
            drivers.push({ prop: `bs:${m}`, axis: null, driver: { id: j.id, prop: "position", axis: ax === "x" ? 0 : 1 },
                           keys: [{ x: 0, v: 0 }, { x: sign * cell, v: 1 }].sort((p, q) => p.x - q.x), ease: "linear", rest: 0 });
        }
    }
    return { items: items.length > 1 ? items : [], drivers: items.length > 1 ? drivers : [], used: [...used],
             unused: morphs.filter((m) => !used.has(m)), cell };
}

/** Morph names as the view lists them, sorted with left / right pairs together. */
export function sortMorphs(names) {
    return [...new Set(names)].sort((a, b) => morphKey(a).replace(/[lr]$/, "") .localeCompare(morphKey(b).replace(/[lr]$/, "")) || a.localeCompare(b));
}

void v3; void curveAt;
