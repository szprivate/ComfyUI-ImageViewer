// bEpicViewer_paramAnimData.js
// Keyframes on a node's parameters, as plain data — no DOM, no graph.
//
// A node that can be animated (the bEpic image nodes: Transform, Grade, Blur…)
// carries one hidden STRING widget, "animation", whose input spec lists the
// parameters that may take keys under "bepic_animatable". Its value is
//
//     { v: 1, tracks: { mix: [{ f, v, ease, ti?, to? }, …], … } }
//
// the same key shape as a previz track (bEpicViewer_scene3d.js): `f` the frame
// (the image's index in the batch — the viewer's frame for a clip), `v` the
// value, `ease` how the curve leaves the key ("smooth" | "linear" | "hold"),
// `ti` / `to` optional hand-set slopes in value per frame. The node's own
// widget stays the un-animated value; a parameter with keys follows its curve.
//
// bepic_anim.py in bepic_templates renders these. valueAt here and value_at
// there must agree, or the Parameters panel shows one number and the node
// renders another.

export const ANIM_WIDGET = "animation";
export const EASES = ["smooth", "linear", "hold"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** The keyable parameter names a node declares, or null for a plain node. */
export function animatableNames(node) {
    const spec = node?.constructor?.nodeData?.input?.optional?.[ANIM_WIDGET];
    const names = spec && spec[1] && spec[1].bepic_animatable;
    return Array.isArray(names) && names.length && animWidget(node) ? names : null;
}

export function animWidget(node) {
    return (node?.widgets || []).find((w) => w.name === ANIM_WIDGET) || null;
}

/** Whether a parameter is an INT on the node (its keys are then whole numbers). */
export function isIntParam(node, name) {
    const spec = node?.constructor?.nodeData?.input?.required?.[name]
              || node?.constructor?.nodeData?.input?.optional?.[name];
    return !!spec && spec[0] === "INT";
}

/** The node's tracks, read fresh from its widget: { name: keys[] }. */
export function readTracks(node) {
    const w = animWidget(node);
    if (!w || !w.value) return {};
    try {
        const tracks = (JSON.parse(w.value) || {}).tracks || {};
        const out = {};
        for (const [name, keys] of Object.entries(tracks)) {
            const good = (Array.isArray(keys) ? keys : []).filter((k) => k && "f" in k && "v" in k);
            if (good.length) out[name] = good.sort((a, b) => a.f - b.f);
        }
        return out;
    } catch (e) {
        return {};
    }
}

/** Write the tracks back — empty tracks are dropped, no tracks is "". */
export function writeTracks(node, tracks) {
    const w = animWidget(node);
    if (!w) return;
    const clean = {};
    for (const [name, keys] of Object.entries(tracks || {})) if (keys && keys.length) clean[name] = keys;
    const next = Object.keys(clean).length ? JSON.stringify({ v: 1, tracks: clean }) : "";
    if (w.value === next) return;
    w.value = next;
    w.callback?.(next);
}

function autoSlope(ease, p0, p1, span) {
    return ease === "linear" && span > 0 ? (p1 - p0) / span : 0;
}

function hermite(p0, p1, m0, m1, t, span) {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * span * m0
         + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * span * m1;
}

/** A track's value at `frame`; `stat` when it has no keys. */
export function valueAt(keys, frame, stat) {
    if (!keys || !keys.length) return stat;
    if (frame <= keys[0].f) return keys[0].v;
    const last = keys[keys.length - 1];
    if (frame >= last.f) return last.v;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].f <= frame) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.f - a.f;
    const ease = a.ease || "smooth";
    if (ease === "hold" || span <= 0 || !isNum(a.v) || !isNum(b.v)) return a.v;
    const t = (frame - a.f) / span;
    const m0 = isNum(a.to) ? a.to : autoSlope(ease, a.v, b.v, span);
    const m1 = isNum(b.ti) ? b.ti : autoSlope(ease, a.v, b.v, span);
    return hermite(a.v, b.v, m0, m1, t, span);
}

/** The slope a key has on one side, hand-set or implied by its ease. */
export function tangentAt(keys, frame, side) {
    const i = keys.findIndex((k) => k.f === frame);
    if (i < 0) return 0;
    const key = keys[i];
    const own = side === "in" ? key.ti : key.to;
    if (isNum(own)) return own;
    const other = side === "in" ? keys[i - 1] : keys[i + 1];
    if (!other) return 0;
    const [from, to] = side === "in" ? [other, key] : [key, other];
    return autoSlope(from.ease || "smooth", from.v, to.v, to.f - from.f);
}

/** Put a key on a track (a new array), keeping the ease and handles of a key it replaces. */
export function setKey(keys, frame, value, ease) {
    const f = Math.round(frame);
    const list = (keys || []).slice();
    const at = list.findIndex((k) => k.f === f);
    const old = at >= 0 ? list[at] : null;
    const key = { f, v: value, ease: ease || (old ? old.ease : "smooth") };
    if (old && old.ti !== undefined) key.ti = old.ti;
    if (old && old.to !== undefined) key.to = old.to;
    if (at >= 0) list[at] = key; else list.push(key);
    return list.sort((a, b) => a.f - b.f);
}

export function removeKey(keys, frame) {
    return (keys || []).filter((k) => k.f !== Math.round(frame));
}

/** Hand-set one side of a key's tangent; both sides unless `broken`. */
export function setTangent(keys, frame, slope, side, broken) {
    const key = (keys || []).find((k) => k.f === Math.round(frame));
    if (!key) return;
    key[side === "in" ? "ti" : "to"] = slope;
    if (!broken) key[side === "in" ? "to" : "ti"] = slope;
}

export function clearTangents(keys, frame) {
    const key = (keys || []).find((k) => k.f === Math.round(frame));
    if (key) { delete key.ti; delete key.to; }
}

/** Every frame any of the tracks has a key on, sorted. */
export function keyFrames(tracks) {
    const out = new Set();
    for (const keys of Object.values(tracks || {})) for (const k of keys) out.add(k.f);
    return [...out].sort((a, b) => a - b);
}
