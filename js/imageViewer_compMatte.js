// Comp's mattes and channels: LumaKeyer, ChromaKeyer, Erode / Dilate, Laplacian (and high pass),
// ChannelMerge and ChannelMath. Pure; its numpy twins are in src/comp_model.py (`luma_key_image`,
// `chroma_key_image`, `erode_image`, `laplacian_image`, `channel_merge_image`, `channel_math_image`): the
// same operations in the same order - change one, change the other (tests/test_comp_parity.py).

import { blank, blurImage } from "./imageViewer_compOps.js";

const LUM = [0.2126, 0.7152, 0.0722];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── keyers ───────────────────────────────────────────────────────────────────

export const LUMA_SOURCES = ["luminance", "max", "red", "green", "blue"];
export const KEY_OUTPUTS = ["premultiplied", "matte", "despilled"];

/** A matte's clip: below `black` nothing, above `white` all, straight between. */
function clipMatte(m, black, white) {
    if (!(white > black)) return m < black ? 0 : 1;
    return clamp01((m - black) / (white - black));
}
/** Up from `lo` over `soft` (a step at `lo` without softness). */
const rampUp = (x, lo, soft) => (soft > 0 ? clamp01((x - lo) / soft) : x >= lo ? 1 : 0);

/**
 * A matte from brightness: transparent below `low`, solid from low + low_soft up to `high`, transparent
 * again past high + high_soft. Measured on the colour as it is (straight).
 */
export function lumaKeyImage(img, p) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        const a = s[i + 3], u = a > 0 ? a : 1;
        const r = s[i] / u, g = s[i + 1] / u, b = s[i + 2] / u;
        const Y = p.source === "max" ? Math.max(r, g, b) : p.source === "red" ? r : p.source === "green" ? g : p.source === "blue" ? b
            : LUM[0] * r + LUM[1] * g + LUM[2] * b;
        let m = rampUp(Y, p.low, p.low_soft) * (1 - rampUp(Y, p.high, p.high_soft));
        m = clipMatte(m, p.clip_black, p.clip_white);
        if (p.invert === "on") m = 1 - m;
        keyOut(o, i, s, m, p.output);
    }
    return out;
}
function keyOut(o, i, s, m, output, c) {
    if (output === "matte") { o[i] = m; o[i + 1] = m; o[i + 2] = m; o[i + 3] = 1; return; }
    const a = s[i + 3];
    if (c) {   // despilled colour (straight) - premultiplied again by the alpha it keeps
        const k = output === "despilled" ? a : a * m;
        o[i] = c[0] * k; o[i + 1] = c[1] * k; o[i + 2] = c[2] * k; o[i + 3] = k;
        return;
    }
    o[i] = s[i] * m; o[i + 1] = s[i + 1] * m; o[i + 2] = s[i + 2] * m; o[i + 3] = a * m;
}

/**
 * A matte from a screen colour, as a colour-difference keyer does: the screen's strongest channel less the
 * larger of the other two, against the same of the screen itself, gives how much of the screen a pixel is
 * (`screen_gain` scales it); alpha is one less that, clipped. Despill holds that channel to the larger
 * (or the mean) of the other two, by `despill`.
 */
export const DESPILL_LIMITS = ["max", "average"];
export function chromaKeyImage(img, p) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    const sc = p.screen || [0, 1, 0, 1];
    const k = sc[1] >= sc[0] && sc[1] >= sc[2] ? 1 : sc[2] >= sc[0] ? 2 : 0;
    const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
    const S = sc[k] - Math.max(sc[k1], sc[k2]);
    const avg = p.despill_limit === "average";
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        const a = s[i + 3], u = a > 0 ? a : 1;
        const c = [s[i] / u, s[i + 1] / u, s[i + 2] / u];
        const lim = avg ? (c[k1] + c[k2]) / 2 : Math.max(c[k1], c[k2]);
        const d = c[k] - Math.max(c[k1], c[k2]);
        const t = S > 0 ? clamp01((d / S) * p.screen_gain) : 0;
        const m = clipMatte(1 - t, p.clip_black, p.clip_white);
        const sp = c[k] - lim;
        if (sp > 0) c[k] = c[k] - sp * p.despill;
        keyOut(o, i, s, p.invert === "on" ? 1 - m : m, p.output, c);
    }
    return out;
}

// ── erode / dilate ───────────────────────────────────────────────────────────

export const ERODE_SHAPES = ["box", "disc"];
export const ERODE_CHANNELS = ["rgba", "alpha"];

/** The rows of a square or disc of radius r (whole pixels): [{dy, hw}]. */
function erodeRows(r, shape) {
    const rows = [];
    for (let dy = -r; dy <= r; dy++) rows.push({ dy, hw: shape === "disc" ? Math.floor(Math.sqrt(r * r - dy * dy) + 1e-9) : r });
    return rows;
}
/** The picture's largest (dilate) or smallest (erode) value within a whole-pixel radius r, the edge repeated. */
function morph(img, r, shape, grow, chans) {
    if (r <= 0) return img;
    const w = img.w, h = img.h, s = img.data, pick = grow ? Math.max : Math.min;
    // H[k] = the extreme over x-k..x+k along each row, for every half-width a row of the shape needs.
    const H = [s];
    for (let k = 1; k <= r; k++) {
        const prev = H[k - 1], cur = new Float32Array(s.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const xl = x - k < 0 ? 0 : x - k, xr = x + k > w - 1 ? w - 1 : x + k;
            const j = (y * w + x) * 4, jl = (y * w + xl) * 4, jr = (y * w + xr) * 4;
            for (const c of chans) cur[j + c] = pick(prev[j + c], pick(s[jl + c], s[jr + c]));
        }
        H.push(cur);
    }
    const out = { w, h, data: Float32Array.from(s) }, o = out.data;
    const rows = erodeRows(r, shape);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        for (const c of chans) {
            let v = grow ? -Infinity : Infinity;
            for (const row of rows) {
                let yy = y + row.dy; yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
                v = pick(v, H[row.hw][(yy * w + x) * 4 + c]);
            }
            o[j + c] = v;
        }
    }
    return out;
}
/** Erode (size below 0) or dilate (above): fractional sizes mix the two whole radii around them. */
export function erodeImage(img, p) {
    const size = p.size, r = Math.abs(size), lo = Math.floor(r), fr = r - lo;
    if (r <= 0) return img;
    const chans = p.channels === "alpha" ? [3] : [0, 1, 2, 3];
    const grow = size > 0;
    const A = morph(img, lo, p.shape, grow, chans);
    if (fr <= 1e-9) return A;
    const B = morph(img, lo + 1, p.shape, grow, chans);
    const out = blank(img.w, img.h), o = out.data;
    for (let i = 0; i < o.length; i++) o[i] = A.data[i] + (B.data[i] - A.data[i]) * fr;
    return out;
}

// ── Laplacian / high pass ────────────────────────────────────────────────────

export const LAPLACIAN_MODES = ["laplacian", "highpass"];

/**
 * laplacian: the colour less the mean of its four neighbours (x 4) - of the picture blurred by `size` first
 * (a Laplacian of Gaussian); highpass: the colour less the picture blurred by `size`. Then x gain + offset
 * (0.5 for the usual grey-centred look). Alpha is kept.
 */
export function laplacianImage(img, p) {
    const w = img.w, h = img.h, s = img.data;
    const B = p.size > 0 ? blurImage(img, p.size).data : s;
    const out = blank(w, h), o = out.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1, yu = y > 0 ? y - 1 : 0, yd = y < h - 1 ? y + 1 : h - 1;
        for (let c = 0; c < 3; c++) {
            let v;
            if (p.mode === "highpass") v = s[j + c] - B[j + c];
            else v = 4 * B[j + c] - (B[(y * w + xl) * 4 + c] + B[(y * w + xr) * 4 + c] + B[(yu * w + x) * 4 + c] + B[(yd * w + x) * 4 + c]);
            o[j + c] = v * p.gain + p.offset;
        }
        o[j + 3] = s[j + 3];
    }
    return out;
}

// ── channel ops ──────────────────────────────────────────────────────────────

export const CM_CHANNELS = ["r", "g", "b", "a", "luminance"];
export const CM_OUTPUTS = ["a", "r", "g", "b", "rgb", "rgba"];
export const CM_OPS = ["union", "plus", "minus", "from", "multiply", "divide", "in", "out", "stencil", "max", "min", "absminus", "xor"];
const chOf = (d, j, ch) => (ch === "luminance" ? LUM[0] * d[j] + LUM[1] * d[j + 1] + LUM[2] * d[j + 2] : d[j + { r: 0, g: 1, b: 2, a: 3 }[ch]]);
function cmOp(op, A, B) {
    switch (op) {
        case "union": return A + B - A * B;
        case "plus": return A + B;
        case "minus": return A - B;
        case "from": return B - A;
        case "multiply": case "in": return A * B;
        case "divide": return B !== 0 ? A / B : 0;
        case "out": return A * (1 - B);
        case "stencil": return B * (1 - A);
        case "max": return Math.max(A, B);
        case "min": return Math.min(A, B);
        case "absminus": return Math.abs(A - B);
        case "xor": return A + B - 2 * A * B;
        default: return A;
    }
}
const outChans = (out) => (out === "rgba" ? [0, 1, 2, 3] : out === "rgb" ? [0, 1, 2] : [{ r: 0, g: 1, b: 2, a: 3 }[out]]);

/** One channel of A and one of B, by an operation, into B's chosen channels (B passes through otherwise). */
export function channelMergeImage(b, a, p) {
    const out = { w: b.w, h: b.h, data: Float32Array.from(b.data) }, o = out.data, chans = outChans(p.output);
    for (let j = 0; j < o.length; j += 4) {
        const v = cmOp(p.operation, a ? chOf(a.data, j, p.a_channel) : 0, chOf(b.data, j, p.b_channel));
        for (const c of chans) o[j + c] = b.data[j + c] + (v - b.data[j + c]) * p.mix;
    }
    return out;
}

export const MATH_OPS = ["add", "multiply", "power", "invert", "clamp", "min", "max", "abs", "threshold", "set"];
/** Arithmetic on the chosen channels: value is the other operand (clamp: 0..value; invert: value - x). */
export function channelMathImage(img, p) {
    const out = { w: img.w, h: img.h, data: Float32Array.from(img.data) }, o = out.data, chans = outChans(p.channels);
    const v = p.value;
    for (let j = 0; j < o.length; j += 4) for (const c of chans) {
        const x = img.data[j + c];
        let y;
        switch (p.operation) {
            case "add": y = x + v; break;
            case "multiply": y = x * v; break;
            case "power": y = x > 0 ? Math.pow(x, v) : x; break;
            case "invert": y = v - x; break;
            case "clamp": y = x < 0 ? 0 : x > v ? v : x; break;
            case "min": y = Math.min(x, v); break;
            case "max": y = Math.max(x, v); break;
            case "abs": y = Math.abs(x); break;
            case "threshold": y = x >= v ? 1 : 0; break;
            default: y = v;
        }
        o[j + c] = x + (y - x) * p.mix;
    }
    return out;
}
