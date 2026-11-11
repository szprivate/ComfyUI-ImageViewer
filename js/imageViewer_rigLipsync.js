// Lip sync: the mouth curves the server reads off a sound (src/lipsync.py: open,
// round, wide, closed, hiss per frame, 0..1) turned into the character's own
// blendshapes, by the names its meshes have. Pure data: tested in node
// (tests/test_rig_lipsync.mjs).
//
// Three naming habits are known: Apple's ARKit face shapes (jawOpen, mouthFunnel,
// mouthPucker, mouthClose, ...), the viseme sets of game avatars (viseme_aa,
// viseme_O, viseme_PP ...) and a single "mouth open" shape. A character with
// several gets the richest set it has fully. The mix is written for this file.

const C = (v) => Math.max(0, Math.min(1, v));

// Each set: the shape names it needs (case and separators ignored) and how each is made of the curves.
export const SETS = [
    {
        id: "arkit",
        label: "ARKit face shapes",
        need: ["jawOpen"],
        shapes: {
            jawOpen: (m) => C(m.open * 0.85 + m.round * 0.15),
            mouthFunnel: (m) => C(m.round * m.open * 1.4),
            mouthPucker: (m) => C(m.round * (1 - m.open) * 1.2),
            mouthClose: (m) => C(m.closed * 0.7 + m.hiss * 0.2),
            mouthPressLeft: (m) => C(m.closed * 0.5),
            mouthPressRight: (m) => C(m.closed * 0.5),
            mouthStretchLeft: (m) => C(m.wide * 0.6 + m.hiss * 0.3),
            mouthStretchRight: (m) => C(m.wide * 0.6 + m.hiss * 0.3),
            mouthSmileLeft: (m) => C(m.wide * 0.25),
            mouthSmileRight: (m) => C(m.wide * 0.25),
            mouthUpperUpLeft: (m) => C(m.hiss * 0.35),
            mouthUpperUpRight: (m) => C(m.hiss * 0.35),
            mouthLowerDownLeft: (m) => C(m.open * 0.3 + m.hiss * 0.3),
            mouthLowerDownRight: (m) => C(m.open * 0.3 + m.hiss * 0.3),
        },
    },
    {
        id: "visemes",
        label: "visemes",
        need: ["viseme_aa"],
        shapes: {
            viseme_sil: (m) => C(1 - Math.max(m.open, m.closed, m.hiss, m.round, m.wide) * 2),
            viseme_PP: (m) => C(m.closed),
            viseme_FF: (m) => C(m.hiss * 0.4),
            viseme_SS: (m) => C(m.hiss * 0.8),
            viseme_aa: (m) => C(m.open * (1 - m.round) * (1 - m.wide * 0.5)),
            viseme_E: (m) => C(m.wide * m.open * 1.3),
            viseme_I: (m) => C(m.wide * (1 - m.open)),
            viseme_O: (m) => C(m.round * m.open * 1.4),
            viseme_U: (m) => C(m.round * (1 - m.open)),
            viseme_nn: (m) => C(m.open * 0.15),
        },
    },
    {
        id: "open",
        label: "one mouth-open shape",
        need: [],
        shapes: {},   // filled with whichever of OPEN_NAMES the character has
    },
];
const OPEN_NAMES = ["mouthOpen", "jawOpen", "mouth_open", "MouthOpen", "jaw_open", "open", "A", "aa", "Fcl_MTH_A", "vrc.v_aa"];

const key = (n) => String(n).toLowerCase().replace(/[\s_.\-]/g, "");

/**
 * Which set the character's morph names fit: { id, label, shapes: { real name: fn } } or null.
 * Only the shapes the character has are kept, under its own spelling.
 */
export function pickSet(morphNames) {
    const have = new Map((morphNames || []).map((n) => [key(n), n]));
    for (const set of SETS) {
        if (set.id === "open") {
            const n = OPEN_NAMES.map(key).find((k) => have.has(k));
            return n ? { id: "open", label: set.label, shapes: { [have.get(n)]: (m) => C(m.open) } } : null;
        }
        if (!set.need.every((n) => have.has(key(n)))) continue;
        const shapes = {};
        for (const [n, fn] of Object.entries(set.shapes)) if (have.has(key(n))) shapes[have.get(key(n))] = fn;
        return { id: set.id, label: set.label, shapes };
    }
    return null;
}

/**
 * The curves -> keys per shape: { name: [{ f, v }] } from scene frame `from`,
 * thinned where a run of keys lies on a straight line (within `tol`).
 */
export function lipKeys(curves, set, from = 0, { tol = 0.02, gain = 1 } = {}) {
    const n = curves.frames || (curves.open ? curves.open.length : 0);
    const out = {};
    for (const [name, fn] of Object.entries(set.shapes)) {
        const vals = [];
        for (let i = 0; i < n; i++) {
            const m = { open: curves.open[i] || 0, round: curves.round[i] || 0, wide: curves.wide[i] || 0,
                        closed: curves.closed[i] || 0, hiss: curves.hiss[i] || 0 };
            vals.push({ f: from + i, v: Math.round(C(fn(m) * gain) * 1000) / 1000 });
        }
        out[name] = thin(vals, tol);
    }
    return out;
}

/** Keys on a straight line between their neighbours (within tol) left out; the ends always kept. */
export function thin(keys, tol) {
    if (keys.length <= 2) return keys;
    const out = [keys[0]];
    let a = 0;
    for (let i = 1; i < keys.length - 1; i++) {
        const A = keys[a], B = keys[i + 1];
        // Would a line from the last kept key to the next one pass every key skipped, this one too?
        let ok = true;
        for (let j = a + 1; j <= i; j++) {
            const t = (keys[j].f - A.f) / (B.f - A.f);
            if (Math.abs(A.v + (B.v - A.v) * t - keys[j].v) > tol) { ok = false; break; }
        }
        if (!ok) { out.push(keys[i]); a = i; }
    }
    out.push(keys[keys.length - 1]);
    return out;
}
