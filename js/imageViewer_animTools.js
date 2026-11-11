// imageViewer_animTools.js
// Key edits for the 3D space's Dope Sheet and Curve Editor: moving, scaling,
// staggering and retiming keys across objects, simplifying a dense curve, and
// the buffer curve. Plain data and pure functions over scene3d's items - no
// DOM, no three.js - so every one is tested under node
// (tests/test_anim_tools.mjs).
//
// A key is named by where it lives: { id, prop, f } - the item, the property
// (a key holds all three axes of position / rotation / scale / pivot, or the
// one number of fov / ikfk) and its frame. A selection is a list of those.
//
// Written from the behaviour every DCC's dope sheet and graph editor has (and
// the textbook Ramer-Douglas-Peucker idea for the simplify), not from any
// program's code.
import * as S from "./imageViewer_scene3d.js";

// ── Naming keys ──────────────────────────────────────────────────────────────

export const keyId = (k) => `${k.id}|${k.prop}|${k.f}`;

export function parseKeyId(s) {
    const [id, prop, f] = String(s).split("|");
    return { id, prop, f: Number(f) };
}

/** Every key of these items (optionally only some properties), as {id, prop, f}. */
export function keysOf(items, props = S.TRACKS) {
    const out = [];
    for (const it of items || []) {
        for (const prop of props) for (const k of S.track(it, prop)) out.push({ id: it.id, prop, f: k.f });
    }
    return out;
}

/** The selection grouped as Map(id -> Map(prop -> Set(frames))). */
function _grouped(sel) {
    const by = new Map();
    for (const k of sel || []) {
        if (!by.has(k.id)) by.set(k.id, new Map());
        const props = by.get(k.id);
        if (!props.has(k.prop)) props.set(k.prop, new Set());
        props.get(k.prop).add(Math.round(k.f));
    }
    return by;
}

const _clone = (v) => (Array.isArray(v) ? v.slice() : v);

function _scaleTangent(t, k) {
    if (t === undefined) return undefined;
    return Array.isArray(t) ? t.map((x) => x / k) : t / k;
}

/**
 * Move the selected keys of one track through `fn(frame) -> frame`.
 *
 * Rounded to whole frames. A selected key that lands on an unselected one
 * replaces it (what a dragged key does in any dope sheet); two selected keys
 * that land on one frame keep the one that came later in time. `stretch` is
 * the factor time was scaled by around the key, so hand-set tangents (value
 * per frame) keep the curve's shape: a key twice as far away rises half as
 * steeply. Returns the frames the selected keys now have.
 */
function _remapTrack(item, prop, frames, fn, stretch = 1) {
    const keys = S.track(item, prop);
    if (!keys.length) return [];
    const moved = [], still = [];
    for (const k of keys) (frames.has(k.f) ? moved : still).push(k);
    if (!moved.length) return [];
    const landed = new Map();
    for (const k of moved) {
        const nk = { ...k, f: Math.round(fn(k.f)), v: _clone(k.v) };
        if (stretch !== 1) {
            if (nk.ti !== undefined) nk.ti = _scaleTangent(nk.ti, stretch);
            if (nk.to !== undefined) nk.to = _scaleTangent(nk.to, stretch);
        }
        landed.set(nk.f, nk);                       // in time order: the later one wins
    }
    const out = still.filter((k) => !landed.has(k.f)).concat([...landed.values()]);
    out.sort((a, b) => a.f - b.f);
    item.tracks[prop] = out;
    return [...landed.keys()];
}

/** Apply `fn` to every selected key; returns the new selection. */
function _remap(items, sel, fnFor, stretch = 1) {
    const byId = new Map((items || []).map((it) => [it.id, it]));
    const next = [];
    for (const [id, props] of _grouped(sel)) {
        const item = byId.get(id);
        if (!item) continue;
        for (const [prop, frames] of props) {
            const fn = fnFor(item, prop);
            for (const f of _remapTrack(item, prop, frames, fn, stretch)) next.push({ id, prop, f });
        }
    }
    return next;
}

// ── Dope Sheet edits ─────────────────────────────────────────────────────────

/** Move the selected keys by `delta` frames. */
export function moveKeys(items, sel, delta) {
    const d = Math.round(delta);
    if (!d) return (sel || []).slice();
    return _remap(items, sel, () => (f) => f + d);
}

/**
 * Scale the selected keys in time about `pivot` (a frame) by `factor`.
 * Negative factors are refused (that is a reverse, not a scale); a factor that
 * would put two keys of a track on one frame is allowed - the later one stays.
 */
export function scaleKeys(items, sel, factor, pivot) {
    const k = Number(factor);
    if (!(k > 0) || !Number.isFinite(k)) return (sel || []).slice();
    const p = Number.isFinite(pivot) ? pivot : selectionRange(sel).min;
    return _remap(items, sel, () => (f) => p + (f - p) * k, k);
}

/**
 * Stagger the selection across objects: the first object's keys stay, the
 * next ones move by `step`, 2 x `step`, ... in the order of `items` (the
 * scene's order, or the order they were picked in). The usual way to make a
 * row of things start one after the other.
 */
export function staggerKeys(items, sel, step) {
    const s = Math.round(step);
    const ids = new Set((sel || []).map((k) => k.id));
    const order = new Map();
    for (const it of items || []) if (ids.has(it.id)) order.set(it.id, order.size);
    return _remap(items, sel, (item) => (f) => f + s * (order.get(item.id) || 0));
}

/** Remove the selected keys. Returns how many went. */
export function deleteKeys(items, sel) {
    const byId = new Map((items || []).map((it) => [it.id, it]));
    let n = 0;
    for (const [id, props] of _grouped(sel)) {
        const item = byId.get(id);
        if (!item) continue;
        for (const [prop, frames] of props) {
            const before = S.track(item, prop).length;
            for (const f of frames) S.removeKeyframe(item, f, prop);
            n += before - S.track(item, prop).length;
        }
    }
    return n;
}

/** Give the selected keys an ease ("smooth" | "linear" | "hold"); hand-set tangents go. */
export function setKeysEase(items, sel, ease) {
    const byId = new Map((items || []).map((it) => [it.id, it]));
    let n = 0;
    for (const [id, props] of _grouped(sel)) {
        const item = byId.get(id);
        if (!item) continue;
        for (const [prop, frames] of props) {
            for (const k of S.track(item, prop)) {
                if (!frames.has(k.f)) continue;
                k.ease = ease;
                delete k.ti;
                delete k.to;
                n++;
            }
        }
    }
    return n;
}

/** First and last frame of a selection; {min: 0, max: 0, empty: true} without one. */
export function selectionRange(sel) {
    if (!sel || !sel.length) return { min: 0, max: 0, empty: true };
    let min = Infinity, max = -Infinity;
    for (const k of sel) { if (k.f < min) min = k.f; if (k.f > max) max = k.f; }
    return { min, max, empty: false };
}

/**
 * Keys of one track between two frames, inclusive - the dope sheet's box
 * select, run per row.
 */
export function keysInRange(item, prop, a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return S.track(item, prop).filter((k) => k.f >= lo && k.f <= hi).map((k) => ({ id: item.id, prop, f: k.f }));
}

/** Copy the selected keys, relative to the first of them. */
export function copyKeys(items, sel) {
    const byId = new Map((items || []).map((it) => [it.id, it]));
    const { min } = selectionRange(sel);
    const out = [];
    for (const [id, props] of _grouped(sel)) {
        const item = byId.get(id);
        if (!item) continue;
        for (const [prop, frames] of props) {
            for (const k of S.track(item, prop)) {
                if (frames.has(k.f)) out.push({ id, prop, key: { ...k, v: _clone(k.v), f: k.f - min } });
            }
        }
    }
    return out;
}

/**
 * Paste copied keys at `frame`. Onto the same objects when they are there; when
 * the copy is of ONE object and `targets` names others, onto each of those
 * (properties they cannot have are skipped). Returns the pasted keys.
 */
export function pasteKeys(items, clip, frame, targets = null) {
    const byId = new Map((items || []).map((it) => [it.id, it]));
    const ids = [...new Set((clip || []).map((c) => c.id))];
    const out = [];
    const put = (item, c) => {
        if (!item || !S.TRACKS.includes(c.prop)) return;
        if (c.prop === "fov" && item.kind !== "camera") return;
        const f = Math.round(frame + c.key.f);
        S.setKeyframe(item, c.prop, f, c.key.v, c.key.ease);
        const k = S.track(item, c.prop).find((x) => x.f === f);
        if (c.key.ti !== undefined) k.ti = _clone(c.key.ti); else delete k.ti;
        if (c.key.to !== undefined) k.to = _clone(c.key.to); else delete k.to;
        out.push({ id: item.id, prop: c.prop, f });
    };
    const onto = targets && targets.length && ids.length === 1 ? targets : null;
    for (const c of clip || []) {
        if (onto) for (const t of onto) put(byId.get(t), c);
        else put(byId.get(c.id), c);
    }
    return out;
}

// ── Graph editor tools ───────────────────────────────────────────────────────

/**
 * Retime: the keys of these tracks between `from` and `to` are spread so that
 * `to` lands on `newTo` (`from` stays). With `ripple`, everything after `to`
 * moves by the same amount, so the rest of the animation keeps its timing;
 * without it, keys after the range are left where they are (and a stretch
 * that would run over them is held one frame short of the next one).
 * `tracks` is a list of {id, prop}. Returns how many keys moved.
 */
export function retimeKeys(items, tracks, from, to, newTo, ripple = true) {
    const a = Math.round(Math.min(from, to)), b = Math.round(Math.max(from, to));
    let nb = Math.round(newTo);
    if (b <= a || nb <= a) return 0;
    const byId = new Map((items || []).map((it) => [it.id, it]));
    let moved = 0;
    for (const { id, prop } of tracks || []) {
        const item = byId.get(id);
        if (!item) continue;
        const keys = S.track(item, prop);
        if (!keys.length) continue;
        let target = nb;
        if (!ripple) {
            const next = keys.find((k) => k.f > b);
            if (next) target = Math.min(target, next.f - 1);
        }
        const k = (target - a) / (b - a);
        if (k <= 0) continue;
        const inRange = new Set(keys.filter((x) => x.f > a && x.f <= b).map((x) => x.f));
        const after = new Set(ripple ? keys.filter((x) => x.f > b).map((x) => x.f) : []);
        // Tangents of the keys inside the stretch, and of the key at its start,
        // change with it; keys that only slide along keep theirs.
        for (const x of keys) {
            if (inRange.has(x.f) || x.f === a) {
                if (x.ti !== undefined) x.ti = _scaleTangent(x.ti, k);
                if (x.to !== undefined) x.to = _scaleTangent(x.to, k);
            }
        }
        const shift = target - b;
        const fn = (f) => (f > b ? f + shift : a + (f - a) * k);
        const all = new Set([...inRange, ...after]);
        moved += _remapTrack(item, prop, all, fn).length;
    }
    return moved;
}

const _wrap180 = (d) => { let x = d % 360; if (x > 180) x -= 360; if (x < -180) x += 360; return x; };

/** One track sampled at every frame from its first key to its last. */
function _samples(item, prop, first, last) {
    const rot = prop === "rotation";
    const out = [];
    let prev = null;
    for (let f = first; f <= last; f++) {
        let v = S.valueAt(item, prop, f);
        if (rot && prev) {
            // Keep the turn going: a key's own number may be a whole turn away
            // from the curve that runs into it.
            v = v.map((x, a) => prev[a] + _wrap180(x - prev[a]));
        }
        out.push(v);
        prev = Array.isArray(v) ? v : null;
    }
    return out;
}

/**
 * Simplify one track: as few keys as keep the curve within `tolerance` of
 * where it was, measured per axis as a share of that axis's own range of
 * motion (0.01 = 1 %), at every frame.
 *
 * Starts from the end keys and adds the frame where the curve is furthest
 * off until nothing is (Ramer-Douglas-Peucker on the drawn curve). Every new
 * key gets the tangent the old curve had there, so a smooth move needs few
 * keys and a corner gets broken tangents. A track with stepped (hold) keys is
 * left as it is: a step cannot be drawn with fewer keys.
 *
 * Returns { before, after, skipped } and rewrites the track in place.
 */
export function simplifyTrack(item, prop, tolerance = 0.01) {
    const keys = S.track(item, prop);
    const before = keys.length;
    if (before < 3) return { before, after: before, skipped: false };
    if (keys.slice(0, -1).some((k) => k.ease === "hold")) return { before, after: before, skipped: true };
    const first = keys[0].f, last = keys[keys.length - 1].f;
    const target = _samples(item, prop, first, last);
    const vec = Array.isArray(target[0]);
    const axes = vec ? target[0].length : 1;
    const comp = (v, a) => (vec ? v[a] : v);
    const rot = prop === "rotation";
    const scale = [];
    for (let a = 0; a < axes; a++) {
        let lo = Infinity, hi = -Infinity;
        for (const v of target) { const x = comp(v, a); if (x < lo) lo = x; if (x > hi) hi = x; }
        scale.push(Math.max(1e-6, hi - lo));
    }
    const tol = Math.max(1e-6, Number(tolerance) || 0.01);

    // The old curve's slope at a frame, per side - one-sided differences, so
    // a corner keeps its corner and a straight line stays exactly straight.
    const slope = (i, side) => {
        const at = target[i];
        const nb = side === "in" ? target[i - 1] : target[i + 1];
        if (!nb) {
            const other = side === "in" ? target[i + 1] : target[i - 1];
            if (!other) return vec ? at.map(() => 0) : 0;
            return vec ? at.map((x, a) => (side === "in" ? other[a] - x : x - other[a])) : (side === "in" ? other - at : at - other);
        }
        return vec ? at.map((x, a) => (side === "in" ? x - nb[a] : nb[a] - x)) : (side === "in" ? at - nb : nb - at);
    };
    // Central where the two sides agree (a smooth curve), broken where they don't.
    const tangents = (i) => {
        const ti = slope(i, "in"), to = slope(i, "out");
        const agree = (vec ? [...Array(axes).keys()] : [0]).every((a) => {
            const x = comp(ti, a), y = comp(to, a);
            return Math.abs(x - y) <= tol * scale[a] * 2;
        });
        if (!agree) return { ti, to };
        const c = vec ? ti.map((x, a) => (x + to[a]) / 2) : (ti + to) / 2;
        return { ti: c, to: _clone(c) };
    };

    const build = (frames) => frames.map((f) => {
        const i = f - first;
        const { ti, to } = tangents(i);
        return { f, v: _clone(target[i]), ease: "smooth", ti, to };
    });
    const probe = { ...item, tracks: { [prop]: null }, infinity: undefined };
    const chosen = new Set([first, last]);
    let cand = null;
    for (let guard = 0; guard <= last - first + 1; guard++) {
        cand = build([...chosen].sort((x, y) => x - y));
        probe.tracks = { [prop]: cand };
        let worst = 0, at = -1;
        for (let f = first + 1; f < last; f++) {
            if (chosen.has(f)) continue;
            const got = S.valueAt(probe, prop, f), want = target[f - first];
            for (let a = 0; a < axes; a++) {
                let d = comp(got, a) - comp(want, a);
                if (rot) d = _wrap180(d);
                const e = Math.abs(d) / scale[a];
                if (e > worst) { worst = e; at = f; }
            }
        }
        if (worst <= tol || at < 0) break;
        chosen.add(at);
    }
    if (cand.length >= before) return { before, after: before, skipped: false };
    item.tracks[prop] = cand;
    return { before, after: cand.length, skipped: false };
}

/**
 * Buffer curves: a copy of tracks kept beside the scene, drawn grey behind
 * the live curves, and swapped with them on request. `snapshotTracks` takes
 * the copy, `swapTracks` trades it with what is there now (so a second swap
 * undoes the first).
 */
export function snapshotTracks(items, tracks) {
    const byId = new Map((items || []).map((it) => [it.id, it]));
    const out = new Map();
    for (const { id, prop } of tracks || []) {
        const it = byId.get(id);
        if (!it) continue;
        out.set(`${id}|${prop}`, S.track(it, prop).map((k) => ({ ...k, v: _clone(k.v),
            ...(k.ti !== undefined ? { ti: _clone(k.ti) } : {}), ...(k.to !== undefined ? { to: _clone(k.to) } : {}) })));
    }
    return out;
}

export function swapTracks(items, buffer) {
    const byId = new Map((items || []).map((it) => [it.id, it]));
    const live = new Map();
    let n = 0;
    for (const [key, keys] of buffer || []) {
        const [id, prop] = key.split("|");
        const it = byId.get(id);
        if (!it) continue;
        live.set(key, S.track(it, prop).map((k) => ({ ...k, v: _clone(k.v) })));
        if (!it.tracks) it.tracks = {};
        if (keys.length) it.tracks[prop] = keys.map((k) => ({ ...k, v: _clone(k.v) }));
        else delete it.tracks[prop];
        n++;
    }
    return { buffer: live, swapped: n };
}

/** A buffered track's value at a frame, for drawing its ghost. */
export function bufferValueAt(item, prop, keys, frame) {
    return S.valueAt({ ...item, tracks: { [prop]: keys } }, prop, frame);
}
