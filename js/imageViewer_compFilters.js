// imageViewer_compFilters.js
// The arithmetic of Comp's finishing nodes (imageViewer_compExtra.js has their table): keying and matte
// finishing (difference keyer, despill, edge extend, light wrap, core / edge mattes), colour (CDL, hue
// curves, clamp, log / lin, colour match), filters (grain, denoise, sharpen, median, edge detect, edge blur)
// and the vector retime / time blur sums.
//
// Pure functions on pictures ({w, h, data: Float32Array w*h*4}, linear, premultiplied). src/comp_extra.py is the
// same arithmetic in numpy, operation for operation and in the same order (tests/test_comp_parity.py compares
// them float for float): change one, change the other. Everything in between is float64; results Float32Array.
// Clean room: every formula here is published maths (ASC CDL, Rec. 709 weights, the camera makers' published
// log curves, the guided filter of He, Sun and Tang, Sobel) written from the description, no other code.
import { blank, blurImage, boxAxis, boxesForGauss, opticalFlow, greyOf } from "./imageViewer_compOps.js";
import { erodeImage } from "./imageViewer_compMatte.js";

const LUM = [0.2126, 0.7152, 0.0722];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rampUp = (x, lo, soft) => (soft > 0 ? clamp01((x - lo) / soft) : x >= lo ? 1 : 0);

/** A picture whose four channels are one plane (to blur a matte with the picture blur). */
function planePic(a, w, h) {
    const p = blank(w, h), d = p.data;
    for (let i = 0; i < w * h; i++) { const v = a[i]; d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = v; }
    return p;
}
function alphaOf(img) {
    const a = new Float64Array(img.w * img.h), d = img.data;
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
}
/** The plane blurred as the picture blur does (its four copies rounded to float32 as a picture is). */
function blurPlane(a, w, h, size) {
    const b = blurImage(planePic(a, w, h), size).data, out = new Float64Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = b[i * 4];
    return out;
}

// ── keying and matte finishing ───────────────────────────────────────────────

export const DIFF_OUTPUTS = ["premultiplied", "matte"];
/**
 * A matte from the difference to a clean plate: d = the RMS of the three channels' differences (as they are,
 * premultiplied), ramped from `threshold` over `softness`; invert; out the picture cut by it, or the matte.
 */
export function differenceKeyImage(img, clean, p) {
    if (!clean) return img;
    const out = blank(img.w, img.h), s = img.data, c = clean.data, o = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const dr = s[i] - c[i], dg = s[i + 1] - c[i + 1], db = s[i + 2] - c[i + 2];
        const d = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
        let m = rampUp(d, p.threshold, p.softness);
        if (p.invert === "on") m = 1 - m;
        if (p.output === "matte") { o[i] = m; o[i + 1] = m; o[i + 2] = m; o[i + 3] = 1; }
        else { o[i] = s[i] * m; o[i + 1] = s[i + 1] * m; o[i + 2] = s[i + 2] * m; o[i + 3] = s[i + 3] * m; }
    }
    return out;
}

export const SPILL_SCREENS = ["green", "blue"];
export const SPILL_REPLACE = ["none", "grey", "colour"];
export const SPILL_OUTPUTS = ["despilled", "spill"];
/**
 * Despill: the screen's channel held to the larger (or the mean) of the other two by `amount`; what is taken
 * out (the spill) can be given back as grey (a third to each channel) or as `replace_color` times the spill.
 * On the numbers as they are (premultiplied: the arithmetic scales with alpha). "spill" shows it as a matte.
 */
export function despillImage(img, p) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    const k = p.screen === "blue" ? 2 : 1, j1 = 0, j2 = k === 1 ? 2 : 1;
    const rc = p.replace_color || [0, 0, 0, 1];
    for (let i = 0; i < s.length; i += 4) {
        const o1 = s[i + j1], o2 = s[i + j2];
        const lim = p.limit === "average" ? (o1 + o2) / 2 : Math.max(o1, o2);
        const spill = Math.max(0, s[i + k] - lim);
        if (p.output === "spill") { o[i] = spill; o[i + 1] = spill; o[i + 2] = spill; o[i + 3] = 1; continue; }
        const t = p.amount * spill;
        let r = s[i], g = s[i + 1], b = s[i + 2];
        if (k === 1) g = g - t; else b = b - t;
        if (p.replace === "grey") { r = r + t / 3; g = g + t / 3; b = b + t / 3; }
        else if (p.replace === "colour") { r = r + t * rc[0]; g = g + t * rc[1]; b = b + t * rc[2]; }
        o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = s[i + 3];
    }
    return out;
}

export const EXTEND_OUTPUTS = ["premultiplied", "extended"];
/**
 * Edge extend: the colour of the solid part pushed out into the edges. w = how solid a pixel is (alpha above
 * `threshold`, ramped to 1); E = blur(colour x w) / blur(w); the colour becomes colour x w + E x (1 - w), so the
 * core keeps its own and the soft edge takes the core's nearby colour instead of the background it was keyed
 * from. "extended": that colour everywhere, alpha 1 (to premultiply later).
 */
export function edgeExtendImage(img, p) {
    const w = img.w, h = img.h, s = img.data, n = w * h;
    const thr = p.threshold, span = Math.max(1e-6, 1 - thr);
    const P = blank(w, h), pd = P.data, c = new Float64Array(n * 3), wt = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = s[i * 4 + 3];
        const cr = a > 0 ? s[i * 4] / a : 0, cg = a > 0 ? s[i * 4 + 1] / a : 0, cb = a > 0 ? s[i * 4 + 2] / a : 0;
        const k = clamp01((a - thr) / span);
        c[i * 3] = cr; c[i * 3 + 1] = cg; c[i * 3 + 2] = cb; wt[i] = k;
        pd[i * 4] = cr * k; pd[i * 4 + 1] = cg * k; pd[i * 4 + 2] = cb * k; pd[i * 4 + 3] = k;
    }
    const B = blurImage(P, p.size).data;
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < n; i++) {
        const bw = B[i * 4 + 3], k = wt[i], a = s[i * 4 + 3];
        for (let ch = 0; ch < 3; ch++) {
            const e = bw > 1e-6 ? B[i * 4 + ch] / bw : c[i * 3 + ch];
            const v = c[i * 3 + ch] * k + e * (1 - k);
            o[i * 4 + ch] = p.output === "extended" ? v : v * a;
        }
        o[i * 4 + 3] = p.output === "extended" ? 1 : a;
    }
    return out;
}

export const WRAP_OUTPUTS = ["wrapped", "wrap only"];
/**
 * Light wrap: the background's light over the foreground's edges. edge = alpha x (1 - blur(alpha, width)); the
 * background (only what is brighter than `threshold`, when it is above 0) blurred by `diffuse`, times the edge
 * and `intensity`, is added to the foreground (or alone, with the edge as its alpha).
 */
export function lightWrapImage(fg, bg, p) {
    if (!bg) return fg;
    const w = fg.w, h = fg.h, n = w * h, s = fg.data, b = bg.data;
    const ba = blurPlane(alphaOf(fg), w, h, p.width);
    const G = blank(w, h), g = G.data;
    for (let i = 0; i < n; i++) {
        let k = 1;
        if (p.threshold > 0) {
            const L = LUM[0] * b[i * 4] + LUM[1] * b[i * 4 + 1] + LUM[2] * b[i * 4 + 2];
            k = L > p.threshold ? (L - p.threshold) / L : 0;
        }
        g[i * 4] = b[i * 4] * k; g[i * 4 + 1] = b[i * 4 + 1] * k; g[i * 4 + 2] = b[i * 4 + 2] * k; g[i * 4 + 3] = b[i * 4 + 3];
    }
    const D = blurImage(G, p.diffuse).data;
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < n; i++) {
        const a = s[i * 4 + 3], e = a * (1 - ba[i]) * p.intensity;
        if (p.output === "wrap only") {
            o[i * 4] = D[i * 4] * e; o[i * 4 + 1] = D[i * 4 + 1] * e; o[i * 4 + 2] = D[i * 4 + 2] * e; o[i * 4 + 3] = clamp01(e);
        } else {
            o[i * 4] = s[i * 4] + D[i * 4] * e; o[i * 4 + 1] = s[i * 4 + 1] + D[i * 4 + 1] * e; o[i * 4 + 2] = s[i * 4 + 2] + D[i * 4 + 2] * e;
            o[i * 4 + 3] = a;
        }
    }
    return out;
}

export const CORE_OUTPUTS = ["core", "edge", "outside"];
/**
 * Core / edge mattes from the alpha: core = the alpha eroded by `size` (a disc), outside = 1 - the alpha dilated
 * by it, edge = the band between them; softened by `softness`. Out as a white matte (m, m, m, m).
 */
export function coreEdgeImage(img, p) {
    const w = img.w, h = img.h, n = w * h, A = planePic(alphaOf(img), w, h);
    const er = erodeImage(A, { size: -p.size, shape: "disc", channels: "rgba" }), di = erodeImage(A, { size: p.size, shape: "disc", channels: "rgba" });
    const m = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const c = er.data[i * 4], d = di.data[i * 4];
        m[i] = p.output === "core" ? c : p.output === "outside" ? 1 - d : d - c;
    }
    const v = p.softness > 0 ? blurPlane(m, w, h, p.softness) : m;
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < n; i++) { const x = v[i]; o[i * 4] = x; o[i * 4 + 1] = x; o[i * 4 + 2] = x; o[i * 4 + 3] = x; }
    return out;
}

// ── colour ───────────────────────────────────────────────────────────────────

export const CDL_DIRECTIONS = ["forward", "inverse"];
/** Each straight colour through fn(r, g, b) -> [r, g, b], premultiplied again; a = 0 pixels as they are. */
function straightMap(img, fn) {
    const s = img.data, out = blank(img.w, img.h), o = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const a = s[i + 3];
        o[i + 3] = a;
        if (a <= 0) { o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; continue; }
        const c = fn(s[i] / a, s[i + 1] / a, s[i + 2] / a);
        o[i] = c[0] * a; o[i + 1] = c[1] * a; o[i + 2] = c[2] * a;
    }
    return out;
}
const powCdl = (v, pw) => (v > 0 ? Math.pow(v, pw) : pw === 1 ? v : 0);
/**
 * ASC CDL: (colour x slope + offset) ^ power, then saturation about Rec. 709 luma; "inverse" undoes it in the
 * other order. A power applies to values above 0 only (below: 0, or the value when the power is 1).
 */
export function cdlImage(img, p) {
    const sl = [p.slope_r, p.slope_g, p.slope_b], of = [p.offset_r, p.offset_g, p.offset_b], pw = [p.power_r, p.power_g, p.power_b];
    const sat = p.saturation;
    if (p.direction === "inverse") {
        return straightMap(img, (r, g, b) => {
            const L = LUM[0] * r + LUM[1] * g + LUM[2] * b, c = [r, g, b];
            return c.map((v, k) => {
                let x = sat !== 0 ? L + (v - L) / sat : L;
                x = powCdl(x, 1 / (pw[k] || 1e-6));
                return (x - of[k]) / (sl[k] || 1e-6);
            });
        });
    }
    return straightMap(img, (r, g, b) => {
        const v = [r, g, b].map((x, k) => powCdl(x * sl[k] + of[k], pw[k]));
        const L = LUM[0] * v[0] + LUM[1] * v[1] + LUM[2] * v[2];
        return v.map((x) => L + (x - L) * sat);
    });
}

export const HUES = ["red", "yellow", "green", "cyan", "blue", "magenta"];
/** A periodic Catmull-Rom through six points at 0, 60, ... 300 degrees. */
function hueCurve(P, hue) {
    const u = hue / 60, f0 = Math.floor(u), t = u - f0, i = ((f0 % 6) + 6) % 6;
    const p0 = P[(i + 5) % 6], p1 = P[i], p2 = P[(i + 1) % 6], p3 = P[(i + 2) % 6];
    return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * (t * t) + (3 * p1 - p0 - 3 * p2 + p3) * (t * t * t));
}
/**
 * Hue curves: saturation (x), a hue turn (degrees) and brightness (x), each a smooth curve through six hues.
 * The hue is HSV's; a pixel takes the curves in proportion to its HSV saturation, so greys stay. The turn is
 * about the grey axis (the mean of r g b), the saturation scales the distance from it.
 */
export function hueCurvesImage(img, p) {
    const S = HUES.map((h) => p["sat_" + h]), T = HUES.map((h) => p["hue_" + h]), Lc = HUES.map((h) => p["lum_" + h]);
    const R3 = Math.sqrt(3);
    return straightMap(img, (r, g, b) => {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
        if (!(dl > 0) || !(mx > 0)) return [r, g, b];
        let hh = mx === r ? (g - b) / dl : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
        if (hh < 0) hh = hh + 6;
        const hue = 60 * hh, w = clamp01(dl / mx);
        const sat = 1 + (hueCurve(S, hue) - 1) * w, turn = hueCurve(T, hue) * w, lum = 1 + (hueCurve(Lc, hue) - 1) * w;
        const grey = (r + g + b) / 3, vr = r - grey, vg = g - grey, vb = b - grey;
        const a = (turn * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
        const xr = (vb - vg) / R3, xg = (vr - vb) / R3, xb = (vg - vr) / R3;
        return [(grey + (vr * cs + xr * sn) * sat) * lum, (grey + (vg * cs + xg * sn) * sat) * lum, (grey + (vb * cs + xb * sn) * sat) * lum];
    });
}

export const CLAMP_CHANNELS = ["rgb", "rgba", "a", "r", "g", "b"];
/** The numbers as they are held to [minimum, maximum] (each end switchable) on the channels named. */
export function clampImage(img, p) {
    const s = img.data, out = blank(img.w, img.h), o = out.data;
    const on = p.channels === "rgba" ? [0, 1, 2, 3] : p.channels === "rgb" ? [0, 1, 2] : [{ r: 0, g: 1, b: 2, a: 3 }[p.channels] ?? 3];
    const lo = p.min_on !== "off", hi = p.max_on !== "off";
    o.set(s);
    for (let i = 0; i < s.length; i += 4) for (const k of on) {
        let v = s[i + k];
        if (lo && v < p.minimum) v = p.minimum;
        if (hi && v > p.maximum) v = p.maximum;
        o[i + k] = v;
    }
    return out;
}

export const LOG_CURVES = ["cineon", "logc3", "slog3", "acescct"];
export const LOG_DIRECTIONS = ["lin to log", "log to lin"];
const CIN_OFF = Math.pow(10, ((95 - 685) * 0.002) / 0.6);
/** The published curves: linear scene values <-> their log code values (0..1). */
export function logEncode(curve, x) {
    if (curve === "logc3") return x > 0.010591 ? 0.24719 * Math.log10(5.555556 * x + 0.052272) + 0.385537 : 5.367655 * x + 0.092809;
    if (curve === "slog3") return x >= 0.01125 ? (420 + Math.log10((x + 0.01) / 0.19) * 261.5) / 1023 : (x * (171.2102946929 - 95) / 0.01125 + 95) / 1023;
    if (curve === "acescct") return x <= 0.0078125 ? 10.5402377416545 * x + 0.0729055341958355 : (Math.log2(x) + 9.72) / 17.52;
    const v = x * (1 - CIN_OFF) + CIN_OFF;
    return v > 0 ? (685 + (Math.log10(v) * 0.6) / 0.002) / 1023 : 0;
}
export function logDecode(curve, t) {
    if (curve === "logc3") return t > 5.367655 * 0.010591 + 0.092809 ? (Math.pow(10, (t - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (t - 0.092809) / 5.367655;
    if (curve === "slog3") return t >= 171.2102946929 / 1023 ? Math.pow(10, (t * 1023 - 420) / 261.5) * 0.19 - 0.01 : ((t * 1023 - 95) * 0.01125) / (171.2102946929 - 95);
    if (curve === "acescct") return t <= 0.155251141552511 ? (t - 0.0729055341958355) / 10.5402377416545 : Math.pow(2, t * 17.52 - 9.72);
    return (Math.pow(10, ((t * 1023 - 685) * 0.002) / 0.6) - CIN_OFF) / (1 - CIN_OFF);
}
export function logLinImage(img, p) {
    const f = p.operation === "log to lin" ? (v) => logDecode(p.curve, v) : (v) => logEncode(p.curve, v);
    return straightMap(img, (r, g, b) => [f(r), f(g), f(b)]);
}

/** The alpha-weighted mean and standard deviation of a picture's straight colour: [[m r g b], [sd r g b]]. */
function colourStats(img) {
    const s = img.data, m = [0, 0, 0], q = [0, 0, 0];
    let wsum = 0;
    for (let i = 0; i < s.length; i += 4) { wsum += s[i + 3]; m[0] += s[i]; m[1] += s[i + 1]; m[2] += s[i + 2]; }
    if (!(wsum > 0)) return null;
    for (let k = 0; k < 3; k++) m[k] = m[k] / wsum;
    for (let i = 0; i < s.length; i += 4) {
        const a = s[i + 3];
        if (!(a > 0)) continue;
        for (let k = 0; k < 3; k++) { const d = s[i + k] / a - m[k]; q[k] += a * (d * d); }
    }
    return [m, q.map((v) => Math.sqrt(v / wsum))];
}
/** Colour match: each channel's mean and spread made the reference's (alpha-weighted, straight), mixed by amount. */
export function colorMatchImage(img, ref, p) {
    if (!ref) return img;
    const A = colourStats(img), B = colourStats(ref);
    if (!A || !B) return img;
    const k = [0, 1, 2].map((c) => B[1][c] / Math.max(A[1][c], 1e-6));
    return straightMap(img, (r, g, b) => [r, g, b].map((v, c) => { const t = B[0][c] + (v - A[0][c]) * k[c]; return v + (t - v) * p.amount; }));
}

// ── filters ──────────────────────────────────────────────────────────────────

/** A 32-bit hash of whole numbers (an integer mix, as published for hash tables): uniform in [0, 1). */
export function hash01(x, y, c, f, seed) {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(c + 1, 0x9e3779b1) ^ Math.imul(f, 0x85ebca77) ^ Math.imul(seed, 0xc2b2ae3d);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
/** How much a picture blur of `size` takes off white noise's variance (2D, from its three boxes' kernel). */
export function blurVariance(size) {
    const sigma = Math.max(0, size) / 2;
    if (sigma <= 0) return 1;
    let k = [1];
    for (const sz of boxesForGauss(sigma)) {
        const nk = new Array(k.length + sz - 1).fill(0);
        for (let i = 0; i < k.length; i++) for (let t = 0; t < sz; t++) nk[i + t] += k[i] / sz;
        k = nk;
    }
    let v = 0;
    for (const x of k) v += x * x;
    return v * v;
}
/** The grain a plate shows: the spread of its brightness less its brightness blurred a little. */
export function plateGrain(img) {
    const w = img.w, h = img.h, n = w * h, s = img.data, L = new Float64Array(n);
    for (let i = 0; i < n; i++) { const a = s[i * 4 + 3], u = a > 0 ? a : 1; L[i] = (LUM[0] * s[i * 4] + LUM[1] * s[i * 4 + 1] + LUM[2] * s[i * 4 + 2]) / u; }
    const B = blurPlane(L, w, h, 2);
    let m = 0;
    for (let i = 0; i < n; i++) m += L[i] - B[i];
    m = m / n;
    let q = 0;
    for (let i = 0; i < n; i++) { const d = L[i] - B[i] - m; q += d * d; }
    return Math.sqrt(q / n);
}
export const GRAIN_ANIM = ["on", "off"];
/**
 * Grain: per pixel noise (unit variance, from hash01), blurred by `size` and brought back to unit variance;
 * mono, or each channel its own by `saturation`; times `amount` and (1 - response) + response x brightness;
 * added to the straight colour. With a plate, `amount` is a share of the grain measured on it.
 */
export function grainImage(img, p, frame, scale, plate) {
    const w = img.w, h = img.h, n = w * h, s = img.data;
    const fr = p.animated === "off" ? 0 : Math.round(frame), seed = Math.round(p.seed || 0);
    const N = blank(w, h), nd = N.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) nd[i + c] = (hash01(x, y, c, fr, seed) - 0.5) * 3.4641016151377544;
    }
    const sz = p.size * scale;
    const G = sz > 0 ? blurImage(N, sz).data : nd, norm = 1 / Math.sqrt(blurVariance(sz));
    const amt = plate ? p.amount * plateGrain(plate) : p.amount;
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < n; i++) {
        const j = i * 4, a = s[j + 3];
        o[j + 3] = a;
        if (a <= 0) { o[j] = s[j]; o[j + 1] = s[j + 1]; o[j + 2] = s[j + 2]; continue; }
        const r = s[j] / a, g = s[j + 1] / a, b = s[j + 2] / a;
        const L = clamp01(LUM[0] * r + LUM[1] * g + LUM[2] * b);
        const k = amt * ((1 - p.response) + p.response * L);
        const g0 = G[j] * norm;
        const c = [r, g, b];
        for (let ch = 0; ch < 3; ch++) {
            const gc = g0 + (G[j + ch] * norm - g0) * p.saturation;
            o[j + ch] = (c[ch] + k * gc) * a;
        }
    }
    return out;
}

/** The mean over a (2r+1)^2 box, the edge repeated (the picture blur's boxes): a Float64Array w*h*4 in place. */
function boxMean(a, w, h, r) { boxAxis(a, w, h, r, true); boxAxis(a, w, h, r, false); return a; }
/**
 * Denoise: a guided filter of each channel by itself (He, Sun and Tang 2010): within a box of radius r,
 * the output is a x I + b with a = var / (var + eps), b = mean x (1 - a), the a and b averaged over the box.
 * Flat areas are smoothed, edges (high variance) kept. eps = strength^2. Mixed by `mix`.
 */
export function denoiseImage(img, p, scale) {
    const r = Math.round(p.radius * scale);
    if (r <= 0 || !(p.strength > 0)) return img;
    const w = img.w, h = img.h, s = img.data, N = s.length, eps = p.strength * p.strength;
    const I = Float64Array.from(s), mI = Float64Array.from(s), mII = new Float64Array(N);
    for (let i = 0; i < N; i++) mII[i] = I[i] * I[i];
    boxMean(mI, w, h, r); boxMean(mII, w, h, r);
    const A = new Float64Array(N), B = new Float64Array(N);
    for (let i = 0; i < N; i++) { const v = mII[i] - mI[i] * mI[i]; A[i] = v / (v + eps); B[i] = mI[i] - A[i] * mI[i]; }
    boxMean(A, w, h, r); boxMean(B, w, h, r);
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < N; i++) {
        if ((i & 3) === 3) { o[i] = s[i]; continue; }
        const q = A[i] * I[i] + B[i];
        o[i] = I[i] + (q - I[i]) * p.mix;
    }
    return out;
}

/** Sharpen: an unsharp mask, the picture plus (picture - its blur) x amount, on r g b. */
export function sharpenImage(img, p, scale) {
    const B = blurImage(img, p.size * scale).data, s = img.data, out = blank(img.w, img.h), o = out.data;
    for (let i = 0; i < s.length; i++) o[i] = (i & 3) === 3 ? s[i] : s[i] + (s[i] - B[i]) * p.amount;
    return out;
}

export const MEDIAN_CHANNELS = ["rgba", "rgb"];
export const MEDIAN_MAX = 4;
/** Median: each channel the middle value of the (2r+1)^2 square around it, the edge repeated. */
export function medianImage(img, p, scale) {
    const r = Math.min(MEDIAN_MAX, Math.round(p.radius * scale));
    if (r <= 0) return img;
    const w = img.w, h = img.h, s = img.data, out = blank(w, h), o = out.data;
    const nc = p.channels === "rgb" ? 3 : 4, side = 2 * r + 1, buf = new Float64Array(side * side), mid = (side * side - 1) >> 1;
    o.set(s);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < nc; c++) {
        let k = 0;
        for (let dy = -r; dy <= r; dy++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            for (let dx = -r; dx <= r; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); buf[k++] = s[(yy * w + xx) * 4 + c]; }
        }
        buf.sort();
        o[(y * w + x) * 4 + c] = buf[mid];
    }
    return out;
}

export const EDGE_SOURCES = ["luminance", "rgb"];
/** Edge detect: Sobel on the picture blurred by `size` (luminance, or each channel), |gradient| / 4 x gain; alpha 1. */
export function edgeDetectImage(img, p, scale) {
    const src = p.size > 0 ? blurImage(img, p.size * scale) : img;
    const w = img.w, h = img.h, s = src.data, out = blank(w, h), o = out.data;
    const lum = p.source !== "rgb", planes = lum ? 1 : 3;
    const P = [];
    for (let c = 0; c < planes; c++) {
        const a = new Float64Array(w * h);
        for (let i = 0; i < w * h; i++) a[i] = lum ? LUM[0] * s[i * 4] + LUM[1] * s[i * 4 + 1] + LUM[2] * s[i * 4 + 2] : s[i * 4 + c];
        P.push(a);
    }
    for (let y = 0; y < h; y++) {
        const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
        for (let x = 0; x < w; x++) {
            const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1, j = (y * w + x) * 4;
            for (let c = 0; c < planes; c++) {
                const a = P[c];
                const gx = (a[ym * w + xp] + 2 * a[y * w + xp] + a[yp * w + xp]) - (a[ym * w + xm] + 2 * a[y * w + xm] + a[yp * w + xm]);
                const gy = (a[yp * w + xm] + 2 * a[yp * w + x] + a[yp * w + xp]) - (a[ym * w + xm] + 2 * a[ym * w + x] + a[ym * w + xp]);
                const e = (Math.sqrt(gx * gx + gy * gy) / 4) * p.gain;
                if (lum) { o[j] = e; o[j + 1] = e; o[j + 2] = e; } else o[j + c] = e;
            }
            o[j + 3] = 1;
        }
    }
    return out;
}

/** Edge blur: the picture blurred by `size` where its alpha has an edge: e = 1 - |2 x blur(alpha, width) - 1|. */
export function edgeBlurImage(img, p, scale) {
    const w = img.w, h = img.h, s = img.data;
    const ba = blurPlane(alphaOf(img), w, h, p.width * scale);
    const B = blurImage(img, p.size * scale).data, out = blank(w, h), o = out.data;
    for (let i = 0; i < w * h; i++) {
        const e = (1 - Math.abs(2 * ba[i] - 1)) * p.amount;
        for (let c = 0; c < 4; c++) { const j = i * 4 + c; o[j] = s[j] + (B[j] - s[j]) * e; }
    }
    return out;
}

// ── time ─────────────────────────────────────────────────────────────────────

/** Bilinear at index coordinates, the edge repeated, of all four channels, into out. */
function samplePix(d, w, h, x, y, out) {
    let x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    x0 = x0 < 0 ? 0 : x0 > w - 1 ? w - 1 : x0; x1 = x1 < 0 ? 0 : x1 > w - 1 ? w - 1 : x1;
    y0 = y0 < 0 ? 0 : y0 > h - 1 ? h - 1 : y0; y1 = y1 < 0 ? 0 : y1 > h - 1 ? h - 1 : y1;
    const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4;
    for (let k = 0; k < 4; k++) {
        const top = d[a + k] + (d[b + k] - d[a + k]) * fx, bot = d[c + k] + (d[e + k] - d[c + k]) * fx;
        out[k] = top + (bot - top) * fy;
    }
}
export const RETIME_FLOW = { smoothness: 0.04, iterations: 30, levels: 4, detail: "half" };
/**
 * The picture a fraction t of the way from `a` to `b` by their motion: the flow F from a to b; each pixel
 * takes a at x - t F(x) and b at x + (1 - t) F(x), mixed by t.
 */
export function vectorBlend(a, b, t) {
    const w = a.w, h = a.h, F = opticalFlow(greyOf(a), greyOf(b), w, h, RETIME_FLOW);
    const out = blank(w, h), o = out.data, sa = [0, 0, 0, 0], sb = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, u = F.u[i], v = F.v[i];
        samplePix(a.data, w, h, x - t * u, y - t * v, sa);
        samplePix(b.data, w, h, x + (1 - t) * u, y + (1 - t) * v, sb);
        for (let k = 0; k < 4; k++) o[i * 4 + k] = sa[k] + (sb[k] - sa[k]) * t;
    }
    return out;
}

/** The frames a time blur reads at f and their weights: [[frame, weight]] by frame, the sub-frames shared. */
export function timeBlurFrames(p, f) {
    const sh = Math.max(0, p.shutter), N = Math.max(1, Math.round(p.samples));
    const lo = p.offset === "start" ? 0 : p.offset === "end" ? -sh : -sh / 2;
    const wt = new Map();
    const put = (g, v) => wt.set(g, (wt.get(g) || 0) + v);
    for (let k = 0; k < N; k++) {
        const t = f + lo + (sh * (k + 0.5)) / N, f0 = Math.floor(t), fr = t - f0;
        if (fr < 1e-9) put(f0, 1 / N);
        else { put(f0, (1 - fr) / N); put(f0 + 1, fr / N); }
    }
    return [...wt].sort((x, y) => x[0] - y[0]);
}
/** Pictures summed with weights, in the order given. */
export function weightedSum(pics, weights) {
    const n = pics[0].data.length, acc = new Float64Array(n);
    for (let j = 0; j < pics.length; j++) { const d = pics[j].data, wv = weights[j]; for (let i = 0; i < n; i++) acc[i] = acc[i] + d[i] * wv; }
    return { w: pics[0].w, h: pics[0].h, data: Float32Array.from(acc) };
}
