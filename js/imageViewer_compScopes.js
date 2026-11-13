// The Comp picture's viewer tools, the arithmetic: two pictures compared (a wipe, their difference, a mix), the
// pixel sampler (one pixel, a box's average), the scopes (histogram, waveform, vectorscope), the out-of-range
// marks and the guides (the format, action and title safe areas). Pure: no DOM; tests in tests/test_comp_scopes.mjs.
// Pictures are {w, h, data: Float32Array} premultiplied linear RGBA (the comp's); scopes read the 8-bit picture
// on screen (Uint8ClampedArray RGBA), so they show what is seen, after the display transform.

export const COMPARE_MODES = ["off", "wipe", "difference", "mix"];
export const COMPARE_LABELS = { off: "Off", wipe: "Wipe", difference: "Difference", mix: "Mix (half each)" };
export const SCOPES = ["", "histogram", "waveform", "vectorscope"];
export const SCOPE_LABELS = { "": "None", histogram: "Histogram", waveform: "Waveform", vectorscope: "Vectorscope" };
/** Safe areas as shares of the picture (EBU R 95: action 93 %, title 90 %). */
export const SAFE = { action: 0.93, title: 0.9 };
const LUMA = [0.2126, 0.7152, 0.0722];

/** B laid on A's size (bottom left on bottom left, as pictures of other sizes meet in the comp). */
function laid(B, w, h) {
    if (B.w === w && B.h === h) return B.data;
    const out = new Float32Array(w * h * 4), dy = h - B.h, cw = Math.min(w, B.w);
    for (let y = Math.max(0, dy); y < Math.min(h, B.h + dy); y++) {
        const s = (y - dy) * B.w * 4;
        out.set(B.data.subarray(s, s + cw * 4), y * w * 4);
    }
    return out;
}

/**
 * A and B as the compare mode shows them, at A's size: "wipe" - A left of the line, B right of it (the line at
 * `wipe` x the width, turned by `angle` degrees about the middle); "difference" - |A - B| per channel; "mix" - half
 * each. Off (or no B): A itself.
 */
export function compareImages(A, B, mode, { wipe = 0.5, angle = 0 } = {}) {
    if (!B || mode === "off" || !COMPARE_MODES.includes(mode)) return A;
    const w = A.w, h = A.h, a = A.data, b = laid(B, w, h), out = new Float32Array(w * h * 4);
    if (mode === "difference") { for (let i = 0; i < a.length; i++) out[i] = Math.abs(a[i] - b[i]); return { w, h, data: out }; }
    if (mode === "mix") { for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) * 0.5; return { w, h, data: out }; }
    const t = (angle * Math.PI) / 180, nx = Math.cos(t), ny = Math.sin(t);
    const cx = wipe * w, cy = h / 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const side = (x + 0.5 - cx) * nx + (y + 0.5 - cy) * ny;
        const i = (y * w + x) * 4, s = side < 0 ? a : b;
        out[i] = s[i]; out[i + 1] = s[i + 1]; out[i + 2] = s[i + 2]; out[i + 3] = s[i + 3];
    }
    return { w, h, data: out };
}

/** The wipe line's two ends across the picture (w x h), for drawing it: [[x0, y0], [x1, y1]]. */
export function wipeLine(w, h, wipe = 0.5, angle = 0) {
    const t = (angle * Math.PI) / 180, dx = -Math.sin(t), dy = Math.cos(t), cx = wipe * w, cy = h / 2, L = Math.hypot(w, h);
    return [[cx - dx * L, cy - dy * L], [cx + dx * L, cy + dy * L]];
}

/** One pixel's numbers at (x, y) of a picture (its pixels; outside: null): [r, g, b, a] premultiplied. */
export function sampleAt(img, x, y) {
    const px = Math.floor(x), py = Math.floor(y);
    if (!img || px < 0 || py < 0 || px >= img.w || py >= img.h) return null;
    const i = (py * img.w + px) * 4, d = img.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

/** The mean, the least and the most of each channel inside a box (its pixels, ends in any order); null if empty. */
export function boxStats(img, x0, y0, x1, y1) {
    const ax = Math.max(0, Math.floor(Math.min(x0, x1))), bx = Math.min(img.w, Math.ceil(Math.max(x0, x1)));
    const ay = Math.max(0, Math.floor(Math.min(y0, y1))), by = Math.min(img.h, Math.ceil(Math.max(y0, y1)));
    if (bx <= ax || by <= ay) return null;
    const sum = [0, 0, 0, 0], lo = [Infinity, Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity, -Infinity], d = img.data;
    for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) {
        const i = (y * img.w + x) * 4;
        for (let k = 0; k < 4; k++) { const v = d[i + k]; sum[k] += v; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    }
    const n = (bx - ax) * (by - ay);
    return { mean: sum.map((s) => s / n), min: lo, max: hi, n, box: [ax, ay, bx, by] };
}

/** Premultiplied numbers as the colour they stand for (divided by alpha; alpha 0: as they are). */
export function straight(c) { return !c ? c : c[3] > 0 ? [c[0] / c[3], c[1] / c[3], c[2] / c[3], c[3]] : c.slice(); }

/** Counts of each 8-bit value of the picture on screen: { r, g, b, l } (Uint32Array(bins) each), l = Rec. 709 luma. */
export function histogram(px, w, h, bins = 256) {
    const r = new Uint32Array(bins), g = new Uint32Array(bins), b = new Uint32Array(bins), l = new Uint32Array(bins);
    const k = bins / 256;
    for (let i = 0, n = w * h * 4; i < n; i += 4) {
        r[(px[i] * k) | 0]++; g[(px[i + 1] * k) | 0]++; b[(px[i + 2] * k) | 0]++;
        l[Math.min(bins - 1, ((LUMA[0] * px[i] + LUMA[1] * px[i + 1] + LUMA[2] * px[i + 2]) * k) | 0)]++;
    }
    return { r, g, b, l, bins };
}

/**
 * A waveform: for each of `cols` columns of the picture, how many of its pixels have each of `rows` levels
 * (0 at the bottom row, 255 at the top). "luma": one count (Float32Array cols x rows); "rgb": three
 * (r, g, b one after the other). Returns { cols, rows, data, mode }.
 */
export function waveform(px, w, h, cols = 256, rows = 128, mode = "luma") {
    const planes = mode === "rgb" ? 3 : 1, data = new Float32Array(planes * cols * rows);
    const kx = cols / w, ky = (rows - 1) / 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, c = Math.min(cols - 1, (x * kx) | 0);
        if (planes === 1) {
            const v = LUMA[0] * px[i] + LUMA[1] * px[i + 1] + LUMA[2] * px[i + 2];
            data[(rows - 1 - Math.round(v * ky)) * cols + c]++;
        } else for (let p = 0; p < 3; p++) data[p * cols * rows + (rows - 1 - Math.round(px[i + p] * ky)) * cols + c]++;
    }
    return { cols, rows, data, mode };
}

/** Rec. 709 colour difference of an 8-bit colour, each -0.5..0.5: [cb, cr]. */
export function chroma709(r, g, b) {
    const R = r / 255, G = g / 255, B = b / 255, Y = LUMA[0] * R + LUMA[1] * G + LUMA[2] * B;
    return [(B - Y) / 1.8556, (R - Y) / 1.5748];
}

/** A vectorscope: counts on a size x size grid of (cb, cr), cb to the right, cr up, the middle grey. */
export function vectorscope(px, w, h, size = 128) {
    const data = new Float32Array(size * size), k = size - 1;
    for (let i = 0, n = w * h * 4; i < n; i += 4) {
        const [cb, cr] = chroma709(px[i], px[i + 1], px[i + 2]);
        const x = Math.round((cb + 0.5) * k), y = Math.round((0.5 - cr) * k);
        data[y * size + x]++;
    }
    return { size, data };
}

/** Where the 75 % colour bars' primaries and secondaries land on the vectorscope (for its targets), as [name, x, y] 0..1. */
export function vectorTargets() {
    const out = [];
    for (const [name, r, g, b] of [["R", 191, 0, 0], ["Y", 191, 191, 0], ["G", 0, 191, 0], ["C", 0, 191, 191], ["B", 0, 0, 191], ["M", 191, 0, 191]]) {
        const [cb, cr] = chroma709(r, g, b);
        out.push([name, cb + 0.5, 0.5 - cr]);
    }
    return out;
}

/** Counts as brightness 0..255: a log scale, so a few pixels still show beside many. */
export function densityLevels(data, gain = 1) {
    let max = 0;
    for (const v of data) if (v > max) max = v;
    const out = new Uint8ClampedArray(data.length), L = Math.log1p(max) || 1;
    for (let i = 0; i < data.length; i++) out[i] = data[i] ? 40 + (215 * Math.log1p(data[i] * gain)) / L : 0;
    return out;
}

/**
 * Marks over the picture on screen (`out`, 8-bit RGBA, written) where the comp's numbers (`img`) are out of 0..1:
 * above 1 in any colour channel - stripes of red; below 0 - stripes of blue; an alpha outside 0..1 - yellow. The
 * stripes leave every other band as it was, so the picture shows through. Returns how many pixels were marked.
 */
export function markOutOfRange(img, out, { eps = 1e-6 } = {}) {
    const d = img.data, w = img.w;
    let n = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        const over = r > 1 + eps || g > 1 + eps || b > 1 + eps, under = r < -eps || g < -eps || b < -eps, alpha = a < -eps || a > 1 + eps;
        if (!over && !under && !alpha) continue;
        n++;
        const x = p % w, y = (p / w) | 0;
        if ((((x + y) >> 2) & 1) === 0) continue;
        const c = alpha ? [255, 220, 0] : over ? [255, 40, 40] : [40, 110, 255];
        out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
    }
    return n;
}

/** The guides of a w x h format: the format's box, the action and title safe boxes, the middle. */
export function guideRects(w, h) {
    const box = (k) => [(w * (1 - k)) / 2, (h * (1 - k)) / 2, w * k, h * k];
    return { format: [0, 0, w, h], action: box(SAFE.action), title: box(SAFE.title), centre: [w / 2, h / 2] };
}

/** Numbers for the sampler's readout: 4 decimals, or "-" when there are none. */
export function fmtValues(c, digits = 4) {
    return c ? c.map((v) => (Number.isFinite(v) ? v.toFixed(digits) : "-")) : ["-", "-", "-", "-"];
}
