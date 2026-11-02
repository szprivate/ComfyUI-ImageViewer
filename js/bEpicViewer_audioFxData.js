// bEpicViewer_audioFxData.js
// The Edit panel's sound effects as data (Resolve's Fairlight FX, a few of them):
// what an effect is, its parameters and their ranges, how a chain is held to
// what it may be, its keyframes, and the numbers the preview's WebAudio nodes
// and the render's ffmpeg filters are given. Pure - no page - so it runs under
// node; audio_fx.py is the same table and arithmetic for the render (kept in
// step: tests/test_edit_audio_fx.py holds the two to each other).
//
// An effect: { type, on, p: { param: value }, keys: { param: [{ t, v, i }] } }.
// A chain is a list of them, applied in order. A clip's (`clip.afx`) sounds
// first, then the clip's volume and fades, then its track's (`track.afx`; the
// bed's `cut.afx.A1`), then the mix. Keys: a clip's in CLIP time (as its volume
// keys), a track's in FILM time; only the simple params are keyed (KEYED).

export const AFX = {
    eq: { name: "EQ", long: "Fairlight EQ: high-pass, low shelf, a peaking mid, high shelf, low-pass",
          params: { hp: [0, 0, 2000, "Hz", "High-pass (0: off)"], ls_f: [120, 20, 1000, "Hz", "Low shelf"], ls_g: [0, -24, 24, "dB", "Low gain"],
                    pk_f: [1000, 100, 10000, "Hz", "Mid"], pk_g: [0, -24, 24, "dB", "Mid gain"], pk_q: [1, 0.1, 10, "", "Mid Q"],
                    hs_f: [8000, 1000, 16000, "Hz", "High shelf"], hs_g: [0, -24, 24, "dB", "High gain"], lp: [0, 0, 20000, "Hz", "Low-pass (0: off)"] } },
    comp: { name: "Compressor", long: "Dynamics: compressor",
            params: { thr: [-18, -60, 0, "dB", "Threshold"], ratio: [4, 1, 20, ":1", "Ratio"], att: [10, 0.1, 1000, "ms", "Attack"],
                      rel: [100, 1, 2000, "ms", "Release"], knee: [6, 0, 18, "dB", "Knee"], makeup: [0, 0, 24, "dB", "Make-up"] } },
    limit: { name: "Limiter", long: "Dynamics: limiter",
             params: { ceil: [-1, -24, 0, "dB", "Ceiling"], rel: [50, 1, 1000, "ms", "Release"] } },
    reverb: { name: "Reverb", long: "Reverb: room, hall or plate",
              params: { preset: ["room", null, null, "", "Preset"], mix: [0.25, 0, 1, "", "Mix"], decay: [0.8, 0.1, 8, "s", "Decay"],
                        pre: [10, 0, 200, "ms", "Pre-delay"] } },
    delay: { name: "Delay", long: "Delay / echo",
             params: { time: [250, 5, 2000, "ms", "Time"], fb: [0.35, 0, 0.9, "", "Feedback"], mix: [0.3, 0, 1, "", "Mix"] } },
    gain: { name: "Gain", long: "Gain", params: { gain: [0, -60, 24, "dB", "Gain"] } },
    pan: { name: "Pan", long: "Pan", params: { pan: [0, -1, 1, "", "Pan (-1 left, +1 right)"] } },
};
export const AFX_TYPES = Object.keys(AFX);
// A short mark for the badges on a track's header and a clip.
export const AFX_SHORT = { eq: "EQ", comp: "CMP", limit: "LIM", reverb: "REV", delay: "DLY", gain: "GN", pan: "PAN" };
// The params that take keyframes: mix, gain, pan.
export const KEYED = { reverb: ["mix"], delay: ["mix"], gain: ["gain"], pan: ["pan"] };
// A reverb preset: its decay when chosen, and how dark its tail is (a one-pole low-pass on the noise, 0: none).
export const REVERB_PRESETS = { room: { decay: 0.8, tone: 0.45, name: "Room" }, hall: { decay: 2.4, tone: 0.3, name: "Hall" },
                                plate: { decay: 1.6, tone: 0.05, name: "Plate" } };
export const MAX_AFX = 12;

const num = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const EASES = ["linear", "in", "out", "inout", "hold"];

/** An effect of `type` at its defaults. */
export function newAfx(type) {
    const t = AFX[type];
    if (!t) return null;
    const p = {};
    for (const [k, d] of Object.entries(t.params)) p[k] = d[0];
    return { type, on: true, p, keys: {} };
}

/** One effect held to what it may be (null for none). */
export function cleanAfxOne(x) {
    if (!x || typeof x !== "object" || !AFX[x.type]) return null;
    const out = newAfx(x.type);
    out.on = x.on !== false;
    for (const [k, [def, lo, hi]] of Object.entries(AFX[x.type].params)) {
        const v = x.p && x.p[k];
        if (k === "preset") out.p[k] = REVERB_PRESETS[v] ? v : def;
        else if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) out.p[k] = r5(Math.max(lo, Math.min(hi, Number(v))));
    }
    for (const k of KEYED[x.type] || []) {
        const list = x.keys && Array.isArray(x.keys[k]) ? x.keys[k] : [];
        const [, lo, hi] = AFX[x.type].params[k];
        const by = new Map();
        for (const key of list) {
            if (!key || !Number.isFinite(Number(key.t)) || !Number.isFinite(Number(key.v)) || Number(key.t) < 0) continue;
            const t = Math.round(Number(key.t) * 1e4) / 1e4;
            by.set(t, { t, v: r5(Math.max(lo, Math.min(hi, Number(key.v)))), ...(EASES.includes(key.i) && key.i !== "linear" ? { i: key.i } : {}) });
        }
        const keys = [...by.values()].sort((a, b) => a.t - b.t).slice(0, 1000);
        if (keys.length) out.keys[k] = keys;
    }
    return out;
}

/** A chain held to what it may be: known effects, at most MAX_AFX. */
export function cleanAfx(list) {
    return (Array.isArray(list) ? list : []).map(cleanAfxOne).filter(Boolean).slice(0, MAX_AFX);
}

/** How far into the stretch to the next key `p` (0..1) has got, by the key's ease (the data module's easeShare). */
function ease(p, how) {
    const x = Math.max(0, Math.min(1, p));
    if (how === "in") return x * x;
    if (how === "out") return 1 - (1 - x) * (1 - x);
    if (how === "inout") return x * x * (3 - 2 * x);
    if (how === "hold") return 0;
    return x;
}

/** A param of an effect at time `t` (its keys, else its number). */
export function afxParam(fx, k, t) {
    const keys = fx && fx.keys && fx.keys[k];
    if (!keys || !keys.length) return num(fx && fx.p && fx.p[k]);
    const u = num(t);
    if (u <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (u >= last.t) return last.v;
    for (let n = 0; n + 1 < keys.length; n++) {
        const a = keys[n], b = keys[n + 1];
        if (u >= a.t && u < b.t) return a.v + (b.v - a.v) * ease((u - a.t) / (b.t - a.t), a.i);
    }
    return last.v;
}

/** Has any effect of the chain keys? */
export function afxKeyed(list) {
    return (list || []).some((fx) => fx && fx.keys && Object.values(fx.keys).some((k) => k && k.length));
}

/** Does a chain do anything (an effect that is on)? */
export function afxActive(list) {
    return (list || []).some((fx) => fx && fx.on !== false && AFX[fx.type]);
}

/** A key of param `k` of effect `i` at time `t` set to `v` (added, or changed); returns the new chain. */
export function setAfxKey(list, i, k, t, v) {
    const out = cleanAfx(list);
    const fx = out[i];
    if (!fx || !(KEYED[fx.type] || []).includes(k)) return out;
    const tt = Math.round(Math.max(0, num(t)) * 1e4) / 1e4;
    const keys = (fx.keys[k] || []).filter((x) => Math.abs(x.t - tt) > 1e-6);
    const was = (fx.keys[k] || []).find((x) => Math.abs(x.t - tt) <= 1e-6);
    keys.push({ t: tt, v: num(v), ...(was && was.i ? { i: was.i } : {}) });
    fx.keys[k] = keys;
    return cleanAfx(out);
}

/** The key of param `k` of effect `i` at time `t` taken away. */
export function removeAfxKey(list, i, k, t) {
    const out = cleanAfx(list);
    const fx = out[i];
    if (fx && fx.keys[k]) fx.keys[k] = fx.keys[k].filter((x) => Math.abs(x.t - num(t)) > 1e-6);
    return cleanAfx(out);
}

/** Effect `i` moved by `d` places (reorder). */
export function moveAfx(list, i, d) {
    const out = cleanAfx(list);
    const j = Math.max(0, Math.min(out.length - 1, i + d));
    if (!out[i] || i === j) return out;
    const [fx] = out.splice(i, 1);
    out.splice(j, 0, fx);
    return out;
}

/** A param (or `on`) of effect `i` changed: `patch` { param: value } or { on }. A keyed param gets a key at `t` instead (auto-key). */
export function patchAfx(list, i, patch, t) {
    let out = cleanAfx(list);
    const fx = out[i];
    if (!fx) return out;
    const keyed = [];
    for (const [k, v] of Object.entries(patch || {})) {
        if (k === "on") { fx.on = !!v; continue; }
        if (fx.keys[k] && fx.keys[k].length && t !== undefined) { keyed.push([k, v]); continue; }
        fx.p[k] = v;
        if (k === "preset" && REVERB_PRESETS[v]) fx.p.decay = REVERB_PRESETS[v].decay;
    }
    for (const [k, v] of keyed) out = setAfxKey(out, i, k, t, v);
    return cleanAfx(out);
}

// ── what the preview's WebAudio nodes and the render's ffmpeg filters are given ──

const db2lin = (db) => Math.pow(10, num(db) / 20);

/**
 * The filters of an effect, as numbers both sides read alike:
 *   eq     [{ kind: "highpass" | "lowshelf" | "peaking" | "highshelf" | "lowpass", f, g, q }]
 *          (WebAudio's BiquadFilterNode and ffmpeg's highpass / lowshelf / equalizer / highshelf /
 *          lowpass are both the RBJ cookbook: the pass filters Butterworth - WebAudio's Q is in dB
 *          there, -3.0103 - the shelves of slope 1, the peak of its Q)
 *   comp   { threshold dB, ratio, attack s, release s, knee dB, makeup dB; ffmpeg: linear threshold,
 *          knee as a factor 10^(dB/20) (1..8, so 0..18 dB), ms, linear make-up }
 *   limit  { ceiling dB, release s; ffmpeg alimiter limit 10^(dB/20), level off }
 */
export function afxPlan(fx) {
    const p = (fx && fx.p) || {};
    if (!fx || !AFX[fx.type]) return null;
    if (fx.type === "eq") {
        const out = [];
        if (num(p.hp) > 0) out.push({ kind: "highpass", f: num(p.hp), q: Math.SQRT1_2 });
        if (num(p.ls_g)) out.push({ kind: "lowshelf", f: num(p.ls_f), g: num(p.ls_g) });
        if (num(p.pk_g)) out.push({ kind: "peaking", f: num(p.pk_f), g: num(p.pk_g), q: num(p.pk_q, 1) });
        if (num(p.hs_g)) out.push({ kind: "highshelf", f: num(p.hs_f), g: num(p.hs_g) });
        if (num(p.lp) > 0) out.push({ kind: "lowpass", f: num(p.lp), q: Math.SQRT1_2 });
        return { eq: out };
    }
    if (fx.type === "comp") {
        return { threshold: num(p.thr), ratio: num(p.ratio, 4), attack: num(p.att) / 1000, release: num(p.rel) / 1000, knee: num(p.knee),
                 makeup: num(p.makeup),
                 ffmpeg: { threshold: r5(db2lin(p.thr)), ratio: num(p.ratio, 4), attack: num(p.att), release: num(p.rel),
                           knee: r5(Math.max(1, Math.min(8, db2lin(p.knee)))), makeup: r5(Math.max(1, Math.min(64, db2lin(p.makeup)))) } };
    }
    if (fx.type === "limit") {
        return { ceiling: num(p.ceil), release: num(p.rel) / 1000,
                 ffmpeg: { limit: r5(Math.max(0.0625, Math.min(1, db2lin(p.ceil)))), release: num(p.rel) } };
    }
    return { ...p };
}

/** The ffmpeg filter strings of an EQ / compressor / limiter (audio_fx.ffmpeg_filters is the same). */
export function afxFfmpeg(fx) {
    const plan = afxPlan(fx);
    if (!plan || fx.on === false) return [];
    if (fx.type === "eq") {
        return plan.eq.map((b) => b.kind === "peaking" ? `equalizer=f=${b.f}:t=q:w=${b.q}:g=${b.g}`
            : b.kind === "lowshelf" ? `lowshelf=f=${b.f}:t=s:w=1:g=${b.g}`
            : b.kind === "highshelf" ? `highshelf=f=${b.f}:t=s:w=1:g=${b.g}`
            : `${b.kind}=f=${b.f}:t=q:w=${r5(b.q)}`);
    }
    if (fx.type === "comp") {
        const f = plan.ffmpeg;
        return [`acompressor=threshold=${f.threshold}:ratio=${f.ratio}:attack=${f.attack}:release=${f.release}:knee=${f.knee}:makeup=${f.makeup}`];
    }
    if (fx.type === "limit") return [`alimiter=limit=${plan.ffmpeg.limit}:release=${plan.ffmpeg.release}:level=false`];
    return [];
}

// A small, fixed random-number generator (mulberry32): the reverb's impulse response is the same noise in the
// preview and the render (audio_fx.reverb_ir), so nothing is downloaded and both sound alike.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The reverb's impulse response, two channels at `rate`: `pre` ms of silence,
 * then noise falling by 60 dB over `decay` seconds (darkened by its preset's
 * tone), each channel scaled to unit energy. [Float32Array, Float32Array].
 */
export function reverbIR(preset, decay, pre, rate = 48000) {
    const tone = (REVERB_PRESETS[preset] || REVERB_PRESETS.room).tone;
    const d = Math.max(0.1, Math.min(8, num(decay, 0.8)));
    const lead = Math.round(Math.max(0, num(pre)) / 1000 * rate);
    const n = lead + Math.round(d * rate);
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
        const r = rng(1234567 + ch * 7919 + Math.round(d * 1000));
        const x = new Float32Array(n);
        let lp = 0, energy = 0;
        for (let k = lead; k < n; k++) {
            const w = r() * 2 - 1;
            lp = lp * tone + w * (1 - tone);
            const v = lp * Math.exp(-6.907755 * (k - lead) / rate / d);
            x[k] = v;
            energy += v * v;
        }
        const s = energy > 0 ? 1 / Math.sqrt(energy) : 0;
        for (let k = 0; k < n; k++) x[k] *= s;
        out.push(x);
    }
    return out;
}

/** WebAudio's StereoPannerNode for stereo in: [lL, rL, lR, rR] - out L = in L * lL + in R * rL, out R = in L * lR + in R * rR. */
export function panGains(pan) {
    const p = Math.max(-1, Math.min(1, num(pan)));
    if (p <= 0) { const x = (p + 1) * Math.PI / 2; return [1, Math.cos(x), 0, Math.sin(x)]; }
    const x = p * Math.PI / 2;
    return [Math.cos(x), 0, Math.sin(x), 1];
}
