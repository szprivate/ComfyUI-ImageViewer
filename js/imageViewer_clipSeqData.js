// imageViewer_clipSeqData.js
// The 3D space's clip sequencer: animation as CLIPS on TRACKS, in the spirit of
// a DCC's time editor / story tool. Pure data and pure functions - no three.js,
// no DOM - so it runs under plain node (tests/test_clip_seq.mjs).
//
// THE MODEL (kept on the scene as `scene.sequencer`, saved with it):
//
//   sequencer = { v: 1, sources: [Source], tracks: [Track] }
//
//   Source  a piece of animation that can be used again and again:
//           { id, name, kind: "keys" | "file", made: "keys" | "ai" | "file",
//             model,           the character it was made on (a model item id), or null
//             length,          its length in frames (its keys run 0..length)
//             items: { <item id>: { tracks: {prop: keys}, name, type, role, bone, parent, top } },
//             match,           the item whose path "Match to previous" lines up (a rig's COG)
//             clip, clipName } (kind "file": an animation inside the model's own file, by index)
//           The keys are the scene's own key shape (imageViewer_scene3d.js), their
//           frames counted from the source's start.
//
//   Track   { id, name, mute, solo, lock, weight (0..1), mode: "override" | "additive", clips: [Clip] }
//           `tracks[0]` is the BOTTOM track. A higher track lies over a lower
//           one, as in the Edit panel: it is applied after it.
//
//   Clip    { id, source, name, start, length, in, out, speed, loop, weight,
//             blendIn, blendOut, pre, post, target, offset, accumulate, mute, color }
//           start / length   where it lies on the shot's timeline, in frames
//           in / out         the stretch of the source it plays (source frames)
//           speed            source frames per timeline frame (retime)
//           loop             "" | "cycle" | "pingpong": past the stretch it repeats
//           blendIn/Out      frames of ramp at either end (smoothstep); two clips
//                            overlapping on one track cross-fade over the overlap
//           pre / post       hold the first / last pose before / after the clip
//           target           play it on another character (a model id): controls are
//                            matched by type and role (or bone), so a motion made on
//                            one humanoid plays on another
//           offset           { p: [x,y,z], yaw, pivot: [x,y,z] } where the clip is put
//                            in the world: moves and turns the source's TOP items (a
//                            rig's root control), so a walk can go on from where the
//                            clip before it stopped (Match to previous)
//           accumulate       a cycling clip moves on by its own travel each turn
//                            (a walk cycle walks instead of running on the spot)
//
// EVALUATION. A channel is first what its keys say (scene3d.evaluate); then,
// bottom track first, every clip playing at the frame blends its value in:
// override = towards the clip's value by the clip's weight (x track weight x
// ramp), additive = adds the clip's change since its first frame. Rotations are
// blended as quaternions. A channel no clip has keys for is left as it was.
// The animation layers (another evaluator, order 200) go on top of this.
//
// All clean-room: the ideas are the common ones of non-linear animation
// editing; nothing here comes from any program's code.

import * as S from "./imageViewer_scene3d.js";
import { quat, mat4, reduceKeys } from "./imageViewer_rigData.js";

export const SEQ_ORDER = 100;
export const LOOPS = ["", "cycle", "pingpong"];
export const MODES = ["override", "additive"];
export const MIN_SPEED = 0.05;
export const MAX_SPEED = 20;
export const MAX_TRACKS = 64;
export const COLORS = { keys: "#4f8fd6", ai: "#9b6ad6", file: "#4fae7a" };

const CHANNELS = ["position", "rotation", "scale", "pivot", "fov", "ikfk"];
const SCALARS = new Set(["fov", "ikfk"]);
const EPS = 1e-6;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const clone = (v) => (Array.isArray(v) ? v.slice() : v);
let _n = 0;
export function seqId(prefix) {
    _n = (_n + 1) % 1e6;
    return `${prefix}${Date.now().toString(36)}${_n.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

// ── Reading and tidying ──────────────────────────────────────────────────────

/** The scene's sequencer, or null when it has none. */
export function seqOf(scene) {
    const q = scene && scene.sequencer;
    return q && typeof q === "object" && !Array.isArray(q) ? q : null;
}

/** The scene's sequencer, made (and tidied) when needed. */
export function ensureSeq(scene) {
    if (!seqOf(scene)) scene.sequencer = { v: 1, sources: [], tracks: [] };
    return normalizeSeq(scene.sequencer);
}

function _keys(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const k of list) {
        if (!k || !Number.isFinite(Number(k.f))) continue;
        const v = Array.isArray(k.v) ? k.v.map((x) => num(x, 0)) : num(k.v, 0);
        const key = { f: Number(k.f), v, ease: k.ease === "linear" || k.ease === "hold" ? k.ease : "smooth" };
        for (const side of ["ti", "to"]) {
            if (k[side] === undefined) continue;
            key[side] = Array.isArray(k[side]) ? k[side].map((x) => num(x, 0)) : num(k[side], 0);
        }
        out.push(key);
    }
    out.sort((a, b) => a.f - b.f);
    return out.length ? out : null;
}

/** Tidy a sequencer in place: every field there and in range. Idempotent. */
export function normalizeSeq(q) {
    if (!q || typeof q !== "object") return q;
    q.v = 1;
    q.sources = (Array.isArray(q.sources) ? q.sources : []).filter((s) => s && typeof s === "object");
    for (const s of q.sources) {
        if (typeof s.id !== "string" || !s.id) s.id = seqId("src");
        s.kind = s.kind === "file" ? "file" : "keys";
        s.made = ["keys", "ai", "file"].includes(s.made) ? s.made : s.kind === "file" ? "file" : "keys";
        s.name = typeof s.name === "string" && s.name ? s.name : "Clip";
        s.model = typeof s.model === "string" && s.model ? s.model : null;
        s.length = Math.max(1, num(s.length, 1));
        if (s.kind === "file") {
            s.clip = Math.max(0, Math.round(num(s.clip, 0)));
            s.items = {};
        } else {
            const items = s.items && typeof s.items === "object" ? s.items : {};
            for (const id of Object.keys(items)) {
                const e = items[id];
                if (!e || typeof e !== "object") { delete items[id]; continue; }
                const tracks = {};
                for (const p of CHANNELS) { const k = _keys(e.tracks && e.tracks[p]); if (k) tracks[p] = k; }
                e.tracks = tracks;
                e.parent = typeof e.parent === "string" && e.parent ? e.parent : null;
                e.top = !!e.top;
            }
            s.items = items;
        }
        s.match = typeof s.match === "string" && s.match ? s.match : null;
    }
    q.tracks = (Array.isArray(q.tracks) ? q.tracks : []).filter((t) => t && typeof t === "object").slice(0, MAX_TRACKS);
    for (const t of q.tracks) {
        if (typeof t.id !== "string" || !t.id) t.id = seqId("trk");
        t.name = typeof t.name === "string" && t.name ? t.name : "Track";
        t.mute = !!t.mute; t.solo = !!t.solo; t.lock = !!t.lock;
        t.weight = clamp(num(t.weight, 1), 0, 1);
        t.mode = t.mode === "additive" ? "additive" : "override";
        t.clips = (Array.isArray(t.clips) ? t.clips : []).filter((c) => c && typeof c === "object");
        for (const c of t.clips) normalizeClip(c);
        t.clips.sort((a, b) => a.start - b.start);
    }
    return q;
}

export function normalizeClip(c) {
    if (typeof c.id !== "string" || !c.id) c.id = seqId("clp");
    c.source = typeof c.source === "string" ? c.source : "";
    c.name = typeof c.name === "string" ? c.name : "";
    c.start = num(c.start, 0);
    c.in = Math.max(0, num(c.in, 0));
    c.out = Math.max(c.in + EPS, num(c.out, c.in + 1));
    c.speed = clamp(num(c.speed, 1), MIN_SPEED, MAX_SPEED);
    c.loop = LOOPS.includes(c.loop) ? c.loop : "";
    c.length = Math.max(EPS, num(c.length, (c.out - c.in) / c.speed));
    if (!c.loop) c.length = (c.out - c.in) / c.speed;
    c.weight = clamp(num(c.weight, 1), 0, 1);
    c.blendIn = clamp(num(c.blendIn, 0), 0, c.length);
    c.blendOut = clamp(num(c.blendOut, 0), 0, c.length);
    c.pre = !!c.pre; c.post = !!c.post; c.mute = !!c.mute;
    c.accumulate = !!c.accumulate;
    c.target = typeof c.target === "string" && c.target ? c.target : null;
    if (c.offset && typeof c.offset === "object") {
        const v3 = (v) => (Array.isArray(v) && v.length === 3 ? v.map((x) => num(x, 0)) : [0, 0, 0]);
        c.offset = { p: v3(c.offset.p), yaw: num(c.offset.yaw, 0), pivot: v3(c.offset.pivot) };
        if (!c.offset.p.some((x) => x) && !c.offset.yaw) delete c.offset;
    } else delete c.offset;
    if (typeof c.color !== "string") delete c.color;
    return c;
}

// ── Finding things ───────────────────────────────────────────────────────────

export function sourceById(q, id) { return (q && q.sources || []).find((s) => s.id === id) || null; }
export function trackById(q, id) { return (q && q.tracks || []).find((t) => t.id === id) || null; }

/** { track, clip, index } of a clip id, or null. */
export function findClip(q, id) {
    for (const track of (q && q.tracks) || []) {
        const index = track.clips.findIndex((c) => c.id === id);
        if (index >= 0) return { track, clip: track.clips[index], index };
    }
    return null;
}

export function clipSpan(c) { return Math.max(EPS, c.out - c.in); }
export function clipEnd(c) { return c.start + c.length; }
/** How long the clip lies on the timeline when it plays its stretch once. */
export function naturalLength(c) { return clipSpan(c) / c.speed; }
/** How many times a clip goes round its stretch. */
export function turnsOf(c) { return (c.length * c.speed) / clipSpan(c); }
export function clipLabel(q, c) { const s = sourceById(q, c.source); return c.name || (s ? s.name : "clip"); }
export function clipColor(q, c) { const s = sourceById(q, c.source); return c.color || COLORS[(s && s.made) || "keys"]; }

/** Tracks that play: unmuted, and the soloed ones only when any is soloed. */
export function liveTracks(q) {
    const tracks = (q && q.tracks) || [];
    const solo = tracks.some((t) => t.solo);
    return tracks.filter((t) => !t.mute && (!solo || t.solo));
}

/** The first and last frame anything on the sequencer covers, or null. */
export function seqRange(q) {
    let lo = Infinity, hi = -Infinity;
    for (const t of (q && q.tracks) || []) for (const c of t.clips) { lo = Math.min(lo, c.start); hi = Math.max(hi, clipEnd(c)); }
    return lo <= hi ? { lo, hi } : null;
}

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Where in its source a clip is at timeline frame `f`: { s, turn }, or null
 * when the clip does not play there. The clip covers [start, start + length],
 * both ends included (keys are moments, the last key is the last pose).
 */
export function sourceFrame(c, f) {
    const end = clipEnd(c);
    const total = c.length * c.speed;
    let u = (f - c.start) * c.speed;
    if (f < c.start - EPS) { if (!c.pre) return null; u = 0; }
    else if (f > end + EPS) { if (!c.post) return null; u = total; }
    u = clamp(u, 0, total);
    const span = clipSpan(c);
    if (!c.loop) return { s: c.in + clamp(u, 0, span), turn: 0 };
    let turn = Math.floor(u / span + 1e-9);
    let r = u - turn * span;
    // The very end of a turn is that turn's last pose, not the next one's first.
    if (turn > 0 && r < 1e-7 && u >= total - 1e-7) { turn -= 1; r = span; }
    if (r < 0) r = 0;
    if (c.loop === "pingpong" && turn % 2 === 1) return { s: c.out - r, turn };
    return { s: c.in + r, turn };
}

/**
 * The clips of one track playing at `f`, oldest first, each with the weight it
 * plays at (clip weight x ramps; the track's weight is not in it). A clip that
 * starts while the one before it still plays fades in over the overlap, and the
 * one before does not fade out there: the two cross-fade.
 */
export function trackActive(track, f) {
    const out = [];
    const clips = track.clips;
    for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        if (c.mute) continue;
        const end = clipEnd(c);
        const inside = f >= c.start - EPS && f <= end + EPS;
        if (!inside && !(c.pre && f < c.start) && !(c.post && f > end)) continue;
        let w = c.weight;
        if (inside) {
            let bin = c.blendIn;
            for (let j = 0; j < i; j++) {
                const p = clips[j];
                if (!p.mute && clipEnd(p) > c.start + EPS) bin = Math.max(bin, Math.min(c.length, clipEnd(p) - c.start));
            }
            if (bin > EPS) w *= smooth((f - c.start) / bin);
            const crossed = clips.some((n, j) => j > i && !n.mute && n.start < end - EPS && n.start >= c.start);
            if (c.blendOut > EPS && !crossed) w *= smooth((end - f) / c.blendOut);
        }
        if (w > EPS) out.push({ clip: c, w });
    }
    return out;
}

// ── Sources: which entry plays on which item ─────────────────────────────────

/** The character a clip plays on. */
export function clipTarget(q, c) { const s = sourceById(q, c.source); return c.target || (s && s.model) || null; }

/** The source entry that plays on `item` through clip `c`, or null. */
export function entryFor(src, c, item) {
    if (!src || src.kind !== "keys" || !item) return null;
    const retarget = c.target && c.target !== src.model;
    if (!retarget) return src.items[item.id] || null;
    const ctl = item.control;
    if (!ctl || ctl.model !== c.target) return null;
    let best = null;
    for (const id of Object.keys(src.items)) {
        const e = src.items[id];
        if (e.type !== ctl.type) continue;
        if (ctl.role && e.role === ctl.role) return e;
        if (!best && ctl.bone && e.bone === ctl.bone) best = e;
    }
    return best;
}

/** The scene item an entry of `src` plays on through clip `c` (the inverse of entryFor). */
export function itemForEntry(scene, src, c, entryId) {
    const e = src.items[entryId];
    if (!e) return null;
    if (!c.target || c.target === src.model) return S.itemById(scene, entryId);
    for (const it of scene.items || []) {
        if (!it.control || it.control.model !== c.target || it.control.type !== e.type) continue;
        if (e.role && it.control.role === e.role) return it;
        if (e.bone && it.control.bone === e.bone) return it;
    }
    return null;
}

function _sample(keys, prop, s) {
    return S.valueAt({ tracks: { [prop]: keys }, [prop]: clone(keys[0].v), fov: 35, ikfk: 1 }, prop, s);
}

/** The channels an entry gives at source frame s: { prop: value } for the props it has keys on. */
export function entryValues(e, s) {
    const out = {};
    for (const p of Object.keys(e.tracks)) if (e.tracks[p] && e.tracks[p].length) out[p] = _sample(e.tracks[p], p, s);
    return out;
}

// ── Placement: offsets, cycles, matching ─────────────────────────────────────

/**
 * XYZ Euler degrees of q nearest `near`: both Euler solutions of the rotation
 * are tried (x + 180, 180 - y, z + 180 is the same turn), each wound to the
 * turn closest to `near`, so a blend never flips the curve over.
 */
export function eulerNear(q, near) {
    const a = quat.toEulerDeg(q, near);
    if (!near) return a;
    const b = [a[0] + 180, 180 - a[1], a[2] + 180].map((x, i) => x + 360 * Math.round((near[i] - x) / 360));
    const d = (e) => Math.abs(e[0] - near[0]) + Math.abs(e[1] - near[1]) + Math.abs(e[2] - near[2]);
    return d(b) < d(a) - 1e-9 ? b : a;
}

const _ry = (deg) => quat.axisAngle([0, 1, 0], deg * Math.PI / 180);

/** The offset of a clip as a matrix in its top items' parent space. */
export function offsetMatrix(c, turnShift = null) {
    const o = c.offset || { p: [0, 0, 0], yaw: 0, pivot: [0, 0, 0] };
    const pv = o.pivot || [0, 0, 0];
    let m = mat4.compose([o.p[0] + pv[0], o.p[1] + pv[1], o.p[2] + pv[2]], _ry(o.yaw || 0), [1, 1, 1]);
    m = mat4.mul(m, mat4.compose([-pv[0], -pv[1], -pv[2]], [0, 0, 0, 1], [1, 1, 1]));
    if (turnShift) m = mat4.mul(m, mat4.compose(turnShift, [0, 0, 0, 1], [1, 1, 1]));
    return m;
}

/** An item's local matrix from channels: rest · T(p) · T(pv) · R · S · T(-pv). */
function _local(item, ch) {
    const pv = ch.pivot || [0, 0, 0];
    let m = mat4.compose([ch.position[0] + pv[0], ch.position[1] + pv[1], ch.position[2] + pv[2]],
        quat.fromEulerDeg(ch.rotation), ch.scale || [1, 1, 1]);
    m = mat4.mul(m, mat4.compose([-pv[0], -pv[1], -pv[2]], [0, 0, 0, 1], [1, 1, 1]));
    return Array.isArray(item.rest) ? mat4.mul(item.rest, m) : m;
}

/** Channels (position, rotation) that put `item` at local matrix `m`, scale and pivot kept. */
function _channels(item, m, ch) {
    const L = Array.isArray(item.rest) ? mat4.mul(mat4.invert(item.rest), m) : m;
    const d = mat4.decompose(L);
    const pv = ch.pivot || [0, 0, 0];
    // L = T(p + pv) R S T(-pv): its translation is p + pv - R S pv.
    const rs = mat4.compose([0, 0, 0], d.q, ch.scale || [1, 1, 1]);
    const back = mat4.point(rs, pv);
    return {
        position: [d.p[0] - pv[0] + back[0], d.p[1] - pv[1] + back[1], d.p[2] - pv[2] + back[2]],
        rotation: eulerNear(d.q, ch.rotation),
    };
}

/** The top items of a source: those whose parent is not in it. */
export function topEntries(src) {
    return src && src.kind === "keys" ? Object.keys(src.items).filter((id) => src.items[id].top) : [];
}

/**
 * Where the source's match item is at source frame s, in the parent space of
 * its top item, as the clip's own keys put it (no offset): { p, heading }.
 * Items of the chain the source has no keys for stand as the scene has them.
 */
export function matchPoint(scene, q, c, s, frame = 0) {
    const src = sourceById(q, c.source);
    if (!src || src.kind !== "keys") return null;
    const matchId = src.match && src.items[src.match] ? src.match : topEntries(src)[0];
    if (!matchId) return null;
    let id = matchId, m = mat4.identity();
    for (let guard = 0; id && guard < 64; guard++) {
        const e = src.items[id];
        const item = itemForEntry(scene, src, c, id);
        if (!e || !item) return null;
        const ch = { ...S.evaluate(item, frame), ...entryValues(e, s) };
        m = mat4.mul(_local(item, ch), m);
        if (e.top) break;
        id = e.parent;
    }
    const fwd = mat4.point(m, [0, 0, 1]);
    const o = mat4.point(m, [0, 0, 0]);
    return { p: o, heading: Math.atan2(fwd[0] - o[0], fwd[2] - o[2]) * 180 / Math.PI };
}

/** How far a cycling clip's match item travels in one turn (x, z; y stays). */
export function cycleTravel(scene, q, c) {
    const a = matchPoint(scene, q, c, c.in), b = matchPoint(scene, q, c, c.out);
    if (!a || !b) return [0, 0, 0];
    return [b.p[0] - a.p[0], 0, b.p[2] - a.p[2]];
}

/** Where a clip puts its match item at timeline frame f, offset and cycles counted. */
export function placedMatchPoint(scene, q, c, f) {
    const at = sourceFrame({ ...c, pre: true, post: true }, f);
    const local = matchPoint(scene, q, c, at.s, f);
    if (!local) return null;
    let shift = null;
    if (c.accumulate && c.loop === "cycle" && at.turn) {
        const t = cycleTravel(scene, q, c);
        shift = [t[0] * at.turn, 0, t[2] * at.turn];
    }
    const p = mat4.point(offsetMatrix(c, shift), local.p);
    const yaw = (c.offset ? c.offset.yaw : 0) || 0;
    return { p, heading: local.heading + yaw };
}

/** The clip that ends nearest before `c` starts on the same character (any track), or null. */
export function previousClip(q, c) {
    const target = clipTarget(q, c);
    let best = null;
    for (const t of q.tracks) for (const o of t.clips) {
        if (o === c || o.mute || clipTarget(q, o) !== target) continue;
        if (o.start >= c.start - EPS) continue;
        if (!best || clipEnd(o) > clipEnd(best)) best = o;
    }
    return best;
}

/**
 * Line clip `c` up with the clip before it: where that one leaves the
 * character (its match item, on the ground), this one picks it up, turned the
 * way it faced when `rotation`. Height is left alone. Returns the offset set,
 * or null when there is nothing to match to.
 */
export function matchToPrevious(scene, q, c, { rotation = true, prev = null } = {}) {
    const p = prev || previousClip(q, c);
    if (!p) return null;
    const there = placedMatchPoint(scene, q, p, clipEnd(p));
    const here = matchPoint(scene, q, c, sourceFrame({ ...c, pre: true }, c.start).s, c.start);
    if (!there || !here) return null;
    const yaw = rotation ? _wrap(there.heading - here.heading) : 0;
    c.offset = { p: [there.p[0] - here.p[0], 0, there.p[2] - here.p[2]], yaw, pivot: [here.p[0], 0, here.p[2]] };
    return c.offset;
}

function _wrap(d) { d %= 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

// ── Evaluation ───────────────────────────────────────────────────────────────

function _blendValue(prop, base, v, w) {
    if (prop === "rotation") {
        const q = quat.slerp(quat.fromEulerDeg(base), quat.fromEulerDeg(v), w);
        return eulerNear(q, base);
    }
    if (Array.isArray(base)) return base.map((b, i) => b + (v[i] - b) * w);
    return base + (v - base) * w;
}

function _addValue(prop, base, v, ref, w) {
    if (prop === "rotation") {
        const d = quat.mul(quat.conj(quat.fromEulerDeg(ref)), quat.fromEulerDeg(v));
        const part = quat.slerp([0, 0, 0, 1], d, w);
        return eulerNear(quat.mul(quat.fromEulerDeg(base), part), base);
    }
    if (prop === "scale") return base.map((b, i) => b * Math.pow(Math.abs(ref[i]) > EPS ? v[i] / ref[i] : 1, w));
    if (Array.isArray(base)) return base.map((b, i) => b + (v[i] - ref[i]) * w);
    return base + (v - ref) * w;
}

/**
 * The scene evaluator (registered with scene3d at order 100): `at` as the keys
 * have it, with the sequencer's clips blended in. Pure in (scene, item fields,
 * frame): nothing is cached.
 */
export function applySequencer(scene, item, frame, at) {
    const q = seqOf(scene);
    if (!q || !Array.isArray(q.tracks) || !q.tracks.length || !item) return at;
    let out = null;
    for (const track of liveTracks(q)) {
        const tw = track.weight;
        if (!(tw > EPS) || !Array.isArray(track.clips)) continue;
        for (const { clip: c, w: cw } of trackActive(track, frame)) {
            const w = cw * tw;
            const src = sourceById(q, c.source);
            if (!src) continue;
            if (src.kind === "file") {
                if (item.id !== (c.target || src.model) || item.kind !== "model") continue;
                if (!out) out = { ...at };
                const pos = sourceFrame(c, frame);
                const list = (out.fileClips || []).map((x) => ({ ...x, weight: x.weight * (1 - w) }));
                list.push({ clip: src.clip, frame: pos.s, weight: w });
                out.fileClips = list;
                continue;
            }
            const e = entryFor(src, c, item);
            if (!e) continue;
            const pos = sourceFrame(c, frame);
            if (!pos) continue;
            const vals = entryValues(e, pos.s);
            if (!out) out = { ...at };
            // The top items carry where the clip is put.
            const placed = e.top && (c.offset || (c.accumulate && c.loop === "cycle" && pos.turn));
            if (placed) {
                const ch = { position: vals.position || out.position, rotation: vals.rotation || out.rotation,
                             scale: vals.scale || out.scale, pivot: vals.pivot || out.pivot };
                let shift = null;
                if (c.accumulate && c.loop === "cycle" && pos.turn) {
                    const t = cycleTravel(scene, q, c);
                    shift = [t[0] * pos.turn, 0, t[2] * pos.turn];
                }
                const moved = _channels(item, mat4.mul(offsetMatrix(c, shift), _local(item, ch)), ch);
                vals.position = moved.position;
                vals.rotation = moved.rotation;
            }
            const ref = track.mode === "additive" ? entryValues(e, c.in) : null;
            for (const p of Object.keys(vals)) {
                if (out[p] === undefined || (p === "ikfk" && out.ikfk === undefined)) {
                    if (p === "ikfk" || p === "fov") continue;
                }
                const base = out[p];
                if (base === undefined) continue;
                out[p] = ref && ref[p] !== undefined ? _addValue(p, base, vals[p], ref[p], w) : _blendValue(p, base, vals[p], w);
            }
        }
    }
    return out || at;
}

// Register with the scene model (scene3d imports nothing of ours, so no cycle).
if (typeof S.registerSceneEvaluator === "function") S.registerSceneEvaluator("clips", SEQ_ORDER, applySequencer);

/** at, with only the sequencer applied on top of the keys (no other evaluator). */
export function evaluateWithClips(scene, item, frame) {
    return applySequencer(scene, item, frame, S.evaluate(item, frame));
}

/** Every scene item some clip plays on. */
export function affectedItems(scene, q = seqOf(scene)) {
    const out = new Set();
    if (!q) return [];
    for (const t of q.tracks) for (const c of t.clips) {
        const src = sourceById(q, c.source);
        if (!src) continue;
        if (src.kind === "file") { const id = c.target || src.model; if (id) out.add(id); continue; }
        for (const id of Object.keys(src.items)) { const it = itemForEntry(scene, src, c, id); if (it) out.add(it.id); }
    }
    return [...out].map((id) => S.itemById(scene, id)).filter(Boolean);
}

// ── Making sources ───────────────────────────────────────────────────────────

/** A track's keys between lo and hi, counted from lo, cut exactly at both ends. */
export function cutKeys(item, prop, lo, hi) {
    const keys = S.track(item, prop);
    if (!keys.length) return null;
    const scalar = SCALARS.has(prop);
    const slope = (f) => {
        const h = 0.01;
        const a = S.valueAt(item, prop, f - h), b = S.valueAt(item, prop, f + h);
        return scalar ? (b - a) / (2 * h) : a.map((x, i) => (b[i] - x) / (2 * h));
    };
    const out = [];
    const segEase = (f) => { let e = keys[0].ease; for (const k of keys) if (k.f <= f) e = k.ease; return e; };
    const boundary = (f) => {
        const ease = segEase(f);
        const key = { f: f - lo, v: clone(S.valueAt(item, prop, f)), ease };
        if (ease !== "hold" && f > keys[0].f && f < keys[keys.length - 1].f) { const m = slope(f); key.ti = m; key.to = clone(m); }
        return key;
    };
    if (!keys.some((k) => Math.abs(k.f - lo) < EPS)) out.push(boundary(lo));
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.f < lo - EPS || k.f > hi + EPS) continue;
        const nk = { ...k, f: k.f - lo, v: clone(k.v) };
        // Hand the neighbours of a cut their own slopes, so the curve keeps its shape across it.
        if (nk.ti === undefined && i > 0 && keys[i - 1].f < lo - EPS && keys[i - 1].ease !== "hold")
            nk.ti = scalar ? S.tangentAt(item, prop, k.f, 0, "in") : [0, 1, 2].map((a) => S.tangentAt(item, prop, k.f, a, "in"));
        if (nk.to === undefined && i < keys.length - 1 && keys[i + 1].f > hi + EPS && k.ease !== "hold")
            nk.to = scalar ? S.tangentAt(item, prop, k.f, 0, "out") : [0, 1, 2].map((a) => S.tangentAt(item, prop, k.f, a, "out"));
        if (nk.ti !== undefined) nk.ti = clone(nk.ti);
        if (nk.to !== undefined) nk.to = clone(nk.to);
        out.push(nk);
    }
    if (!keys.some((k) => Math.abs(k.f - hi) < EPS) && hi > lo) out.push(boundary(hi));
    out.sort((a, b) => a.f - b.f);
    return out;
}

/**
 * Make a source of the keys `ids` have between frames lo and hi. With
 * `remove` the keys go from the items into the source (a DCC's "create clip"):
 * the animation then lives in the clip. Items without keys there are still
 * listed when `keepAll` (a rig's root, so a clip can be placed by it).
 * Returns the source (not yet added).
 */
export function captureSource(scene, ids, lo, hi, { name = "Clip", model = null, made = "keys", remove = true, keepAll = false, match = null } = {}) {
    lo = Math.round(lo); hi = Math.max(lo + 1, Math.round(hi));
    const set = new Set(ids);
    const items = {};
    for (const id of ids) {
        const it = S.itemById(scene, id);
        if (!it) continue;
        const tracks = {};
        for (const p of CHANNELS) {
            if (!S.isAnimated(it, p)) continue;
            const k = cutKeys(it, p, lo, hi);
            if (k && k.length) tracks[p] = k;
        }
        if (!Object.keys(tracks).length && !keepAll) continue;
        const ctl = it.control || {};
        items[id] = { tracks, name: it.name, type: ctl.type || it.kind, role: ctl.role || null, bone: ctl.bone || null,
                      parent: it.parent && set.has(it.parent) ? it.parent : null, top: !(it.parent && set.has(it.parent)) };
    }
    // An item whose parent was left out (no keys) hangs from the nearest one that is in.
    for (const id of Object.keys(items)) {
        let up = S.itemById(scene, id).parent;
        while (up && !items[up] && set.has(up)) up = (S.itemById(scene, up) || {}).parent;
        items[id].parent = up && items[up] ? up : null;
        items[id].top = !items[id].parent;
    }
    if (remove) {
        for (const id of Object.keys(items)) {
            const it = S.itemById(scene, id);
            for (const p of Object.keys(items[id].tracks)) {
                const left = S.track(it, p).filter((k) => k.f < lo - EPS || k.f > hi + EPS);
                if (!left.length) {
                    // The item stays where its clip starts, not where its first key was.
                    if (!SCALARS.has(p) || p === "fov") it[p] = clone(S.valueAt(it, p, lo));
                    else it[p] = S.valueAt(it, p, lo);
                    delete it.tracks[p];
                } else it.tracks[p] = left;
            }
        }
    }
    let m = match && items[match] ? match : null;
    if (!m) m = Object.keys(items).find((id) => items[id].type === "cog") || null;
    if (!m) {
        // The item that travels furthest.
        let far = -1;
        for (const id of Object.keys(items)) {
            const k = items[id].tracks.position;
            if (!k) continue;
            const d = Math.hypot(...k[k.length - 1].v.map((x, i) => x - k[0].v[i]));
            if (d > far) { far = d; m = id; }
        }
    }
    if (!m) m = Object.keys(items).find((id) => items[id].top) || null;
    return { id: seqId("src"), name, kind: "keys", made, model, length: hi - lo, items, match: m };
}

/** A source for one of a model's own animations (the file's clips; played by the model, not keyed). */
export function fileSource(model, clipIndex, clipName, frames) {
    return { id: seqId("src"), name: clipName || `${model.name} clip ${clipIndex + 1}`, kind: "file", made: "file",
             model: model.id, clip: clipIndex, clipName: clipName || "", length: Math.max(1, Math.round(frames)), items: {}, match: null };
}

// ── Edits (in place on the scene's sequencer; the panel snapshots for undo) ───

export function addSource(q, src) { q.sources.push(src); return src; }

export function addTrack(q, { name = null, mode = "override", above = null } = {}) {
    if (q.tracks.length >= MAX_TRACKS) return null;
    const used = new Set(q.tracks.map((t) => t.name));
    let n = q.tracks.length + 1, nm = name;
    if (!nm) { nm = `Track ${n}`; while (used.has(nm)) nm = `Track ${++n}`; }
    const t = { id: seqId("trk"), name: nm, mute: false, solo: false, lock: false, weight: 1, mode: mode === "additive" ? "additive" : "override", clips: [] };
    const i = above ? q.tracks.findIndex((x) => x.id === above) : -1;
    if (i >= 0) q.tracks.splice(i + 1, 0, t); else q.tracks.push(t);
    return t;
}

export function removeTrack(q, id) {
    const i = q.tracks.findIndex((t) => t.id === id);
    if (i < 0 || q.tracks[i].lock) return false;
    q.tracks.splice(i, 1);
    pruneSources(q);
    return true;
}

/** Move a track up (dir +1, over the one above) or down (-1). */
export function moveTrack(q, id, dir) {
    const i = q.tracks.findIndex((t) => t.id === id);
    const j = i + Math.sign(dir);
    if (i < 0 || j < 0 || j >= q.tracks.length) return false;
    [q.tracks[i], q.tracks[j]] = [q.tracks[j], q.tracks[i]];
    return true;
}

/** Does [a, b] lie clear of every clip of the track (but `except`)? */
export function trackFree(track, a, b, except = null) {
    return track.clips.every((c) => c === except || c.id === except || clipEnd(c) <= a + EPS || c.start >= b - EPS);
}

/** Put a source on a track as a new clip at `start`. */
export function addClip(q, trackId, sourceId, start, patch = {}) {
    const t = trackById(q, trackId), src = sourceById(q, sourceId);
    if (!t || !src || t.lock) return null;
    const c = normalizeClip({ source: src.id, start: Math.round(start), in: 0, out: src.length, speed: 1, ...patch });
    t.clips.push(c);
    t.clips.sort((a, b) => a.start - b.start);
    return c;
}

/** The track a new clip at [a, b] can go on: `prefer` when it is free there, else the first free one, else a new one. */
export function trackWithRoom(q, a, b, prefer = null) {
    const p = prefer && trackById(q, prefer);
    if (p && !p.lock && trackFree(p, a, b)) return p;
    for (let i = q.tracks.length - 1; i >= 0; i--) { const t = q.tracks[i]; if (!t.lock && trackFree(t, a, b)) return t; }
    return addTrack(q);
}

export function removeClip(q, id) {
    const at = findClip(q, id);
    if (!at || at.track.lock) return false;
    at.track.clips.splice(at.index, 1);
    pruneSources(q);
    return true;
}

/** Drop the sources no clip uses that were made for a clip alone (keep `keep`, and those the user captured). */
export function pruneSources(q, keep = null) {
    const used = new Set();
    for (const t of q.tracks) for (const c of t.clips) used.add(c.source);
    q.sources = q.sources.filter((s) => used.has(s.id) || s.id === keep || s.keep);
}

export function moveClip(q, id, start, trackId = null) {
    const at = findClip(q, id);
    if (!at || at.track.lock) return null;
    at.clip.start = Math.round(start * 1000) / 1000;
    if (trackId && trackId !== at.track.id) {
        const t = trackById(q, trackId);
        if (t && !t.lock) { at.track.clips.splice(at.index, 1); t.clips.push(at.clip); t.clips.sort((a, b) => a.start - b.start); return at.clip; }
    }
    at.track.clips.sort((a, b) => a.start - b.start);
    return at.clip;
}

/**
 * Trim an edge by d timeline frames. Without a loop the stretch of source
 * changes with it (held to the source); with one, the right edge plays more
 * or fewer turns and the left edge moves the start with the stretch.
 */
export function trimClip(q, id, side, d, srcLength = null) {
    const at = findClip(q, id);
    if (!at || at.track.lock) return null;
    const c = at.clip;
    const src = sourceById(q, c.source);
    const max = srcLength ?? (src ? src.length : c.out);
    if (side === "in") {
        let ds = d * c.speed;
        ds = clamp(ds, -c.in, (c.loop ? c.length * c.speed : clipSpan(c)) - 1 / c.speed);
        if (c.loop) ds = clamp(ds, -c.in, clipSpan(c) - EPS);
        const dt = ds / c.speed;
        c.start += dt;
        c.in += ds;
        if (c.loop) c.length = Math.max(1 / c.speed, c.length - dt);
    } else if (c.loop) {
        c.length = Math.max(1, c.length + d);
    } else {
        c.out = clamp(c.out + d * c.speed, c.in + 1 / 64, max);
    }
    return normalizeClip(c);
}

/** Retime by an edge: the clip plays the same source over a new length (its speed changes). */
export function retimeClip(q, id, side, d) {
    const at = findClip(q, id);
    if (!at || at.track.lock) return null;
    const c = at.clip;
    const total = c.length * c.speed;
    const len = clamp(c.length + (side === "in" ? -d : d), total / MAX_SPEED, total / MIN_SPEED);
    if (side === "in") c.start = clipEnd(c) - len;
    c.speed = total / len;
    c.length = len;
    return normalizeClip(c);
}

/** Make a clip loop (cycle, or keep its own mode) and lengthen it by d frames. */
export function loopExtend(q, id, d, mode = null) {
    const at = findClip(q, id);
    if (!at || at.track.lock) return null;
    const c = at.clip;
    if (!c.loop || mode) c.loop = mode || "cycle";
    c.length = Math.max(1, c.length + d);
    return normalizeClip(c);
}

export function setClip(q, id, patch) {
    const at = findClip(q, id);
    if (!at || at.track.lock) return null;
    const c = at.clip;
    const keepLen = "speed" in patch && !c.loop;
    Object.assign(c, patch);
    if (keepLen) c.length = clipSpan(c) / clamp(num(c.speed, 1), MIN_SPEED, MAX_SPEED);
    normalizeClip(c);
    at.track.clips.sort((a, b) => a.start - b.start);
    return c;
}

/** Split a clip at timeline frame f into two that play on as one did. A looped clip is not split. */
export function splitClip(q, id, f) {
    const at = findClip(q, id);
    if (!at || at.track.lock) return null;
    const c = at.clip;
    if (c.loop) return { error: "A looping clip is not split: take its loop off first." };
    if (f <= c.start + 0.5 || f >= clipEnd(c) - 0.5) return { error: "Split inside the clip, a frame from either end." };
    const s = sourceFrame(c, f).s;
    const b = normalizeClip({ ...JSON.parse(JSON.stringify(c)), id: seqId("clp"), start: f, in: s, blendIn: 0, pre: false });
    c.out = s; c.blendOut = 0; c.post = false;
    normalizeClip(c);
    b.out = Math.max(b.in + EPS, b.out);
    normalizeClip(b);
    at.track.clips.splice(at.index + 1, 0, b);
    return { a: c, b };
}

/** A copy of a clip right after it (on its track if there is room, else on the first free track). */
export function duplicateClip(q, id) {
    const at = findClip(q, id);
    if (!at) return null;
    const c = at.clip;
    const copy = normalizeClip({ ...JSON.parse(JSON.stringify(c)), id: seqId("clp"), start: clipEnd(c) });
    const t = trackWithRoom(q, copy.start, clipEnd(copy), at.track.id);
    if (!t) return null;
    t.clips.push(copy);
    t.clips.sort((a, b) => a.start - b.start);
    return copy;
}

// ── Baking ───────────────────────────────────────────────────────────────────

/**
 * Turn what the clips play into keys on the items, frame by frame over
 * [lo, hi] (the sequencer's range by default), and take the clips away (or
 * mute their tracks with `keepClips`). Keys are thinned within `tolerance`.
 * File clips (a model's own animation) cannot become keys and stay.
 * Returns { items, keys }.
 */
export function bakeToKeys(scene, { lo = null, hi = null, tolerance = 0.02, keepClips = false } = {}) {
    const q = seqOf(scene);
    const r = q && seqRange(q);
    if (!r) return { items: 0, keys: 0 };
    lo = Math.round(lo ?? r.lo); hi = Math.round(hi ?? r.hi);
    const items = affectedItems(scene, q).filter((it) => it.kind !== "model" || !(q.tracks.every((t) => t.clips.every((c) => (sourceById(q, c.source) || {}).kind === "file"))));
    const plan = [];
    for (const it of items) {
        const props = new Set();
        for (const t of q.tracks) for (const c of t.clips) {
            const src = sourceById(q, c.source);
            const e = entryFor(src, c, it);
            if (!e) continue;
            for (const p of Object.keys(e.tracks)) props.add(p);
            if (e.top && (c.offset || c.accumulate)) { props.add("position"); props.add("rotation"); }
        }
        if (!props.size) continue;
        const samples = {};
        for (const p of props) samples[p] = [];
        let near = null;
        for (let f = lo; f <= hi; f++) {
            const at = evaluateWithClips(scene, it, f);
            for (const p of props) {
                let v = at[p];
                if (v === undefined) continue;
                if (p === "rotation" && near) v = v.map((x, i) => x + 360 * Math.round((near[i] - x) / 360));
                samples[p].push({ f, v: clone(v) });
            }
            near = at.rotation;
        }
        plan.push({ it, samples });
    }
    // Write after sampling everything, so no item is baked from another's new keys.
    let keys = 0;
    for (const { it, samples } of plan) {
        for (const p of Object.keys(samples)) {
            const s = samples[p];
            if (!s.length) continue;
            const kept = S.track(it, p).filter((k) => k.f < lo || k.f > hi);
            const span = SCALARS.has(p) ? 1 : Math.max(1e-3, ...s.map((x) => Math.max(...x.v.map(Math.abs))));
            const tol = p === "rotation" ? tolerance * 10 : tolerance * (SCALARS.has(p) ? 1 : 0.01 * span);
            const thin = SCALARS.has(p)
                ? reduceKeys(s.map((x) => ({ f: x.f, v: [x.v, 0, 0] })), tol).map((k) => ({ f: k.f, v: k.v[0] }))
                : reduceKeys(s, tol);
            it.tracks = it.tracks || {};
            it.tracks[p] = [...kept, ...thin.map((k) => ({ f: k.f, v: clone(k.v), ease: "linear" }))].sort((a, b) => a.f - b.f);
            keys += thin.length;
        }
    }
    for (const t of q.tracks) {
        const keep = t.clips.filter((c) => (sourceById(q, c.source) || {}).kind === "file");
        if (keepClips) { if (t.clips.length > keep.length) t.mute = true; }
        else t.clips = keep;
    }
    if (!keepClips) { q.tracks = q.tracks.filter((t) => t.clips.length); pruneSources(q); }
    return { items: plan.length, keys };
}

/**
 * A copy of the scene with the clips baked into keys (every frame, no
 * thinning) and no sequencer: for readers that know keys only, such as the
 * USD export. The scene itself is not touched.
 */
export function withClipsBaked(scene) {
    const q = seqOf(scene);
    if (!q || !q.tracks || !q.tracks.length) return scene;
    const copy = S.parseScene(S.serializeScene(scene));
    normalizeSeq(copy.sequencer);
    bakeToKeys(copy, { tolerance: 0 });
    delete copy.sequencer;
    return copy;
}
