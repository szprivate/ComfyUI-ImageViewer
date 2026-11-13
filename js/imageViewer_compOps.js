// imageViewer_compOps.js
// The arithmetic of Comp's heavier nodes: Crop, Shuffle, Copy, Premult / Unpremult, Keyer, Roto, motion
// vectors (optical flow), motion blur and depth blur. Pure functions on pictures ({w, h, data: Float32Array
// w*h*4}, linear, premultiplied), called by renderNode in imageViewer_compModel.js.
//
// src/comp_model.py is the same arithmetic in numpy, operation for operation and in the same order, so
// tests/test_comp_parity.py can compare the two float for float: change one, change the other. Everything
// in between is done in float64 (JS numbers, Float64Array) and only the result is a Float32Array.
// It imports nothing, so imageViewer_compModel.js can import it (and re-export blank / blurImage).

export function blank(w, h) { return { w, h, data: new Float32Array(w * h * 4) }; }

// ── bounding boxes ───────────────────────────────────────────────────────────
// A picture may carry `bb` = [x0, y0, x1, y1] (pixels, x1 / y1 past the end): every channel is exactly 0
// outside it. It is only a promise that lets an operation skip the empty part (Merge, Transform, Blur go
// through less); a picture without one counts as full. The numpy render has no boxes: the numbers are the same.

/** The box of the non-zero pixels of `img` (any of r g b a), [0, 0, 0, 0] when empty. */
export function scanBox(img) {
    const { w, h, data: d } = img;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) {
        let row = y * w * 4, lo = -1, hi = -1;
        for (let x = 0; x < w; x++, row += 4) if (d[row] || d[row + 1] || d[row + 2] || d[row + 3]) { if (lo < 0) lo = x; hi = x; }
        if (lo < 0) continue;
        if (lo < x0) x0 = lo; if (hi + 1 > x1) x1 = hi + 1;
        if (y < y0) y0 = y; y1 = y + 1;
    }
    return x1 > x0 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}
/** The box of `img`: its own, else the whole picture. */
export function boxOf(img) { return img.bb || [0, 0, img.w, img.h]; }
export const boxEmpty = (b) => b[2] <= b[0] || b[3] <= b[1];
export const boxUnion = (a, b) => (boxEmpty(a) ? b : boxEmpty(b) ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
export const boxClip = (b, w, h) => { const c = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(w, b[2]), Math.min(h, b[3])]; return boxEmpty(c) ? [0, 0, 0, 0] : c; };
export const boxGrow = (b, r, w, h) => (boxEmpty(b) ? b : boxClip([b[0] - r, b[1] - r, b[2] + r, b[3] + r], w, h));
export const boxWhole = (b, w, h) => b[0] <= 0 && b[1] <= 0 && b[2] >= w && b[3] >= h;
/** `img` with `bb` set (dropped when it is the whole picture). */
export function withBox(img, bb) { if (bb && !boxWhole(bb, img.w, img.h)) img.bb = bb; return img; }

export function boxesForGauss(sigma, n = 3) {
    if (sigma <= 0) return new Array(n).fill(1);
    const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl -= 1;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** Mean over 2r+1 along one axis, the edge value repeated (paint_math._box_axis), in place on a Float64Array. */
function boxAxis(a, w, h, r, horizontal) {
    if (r <= 0) return;
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    const stride = horizontal ? 4 : w * 4, lineStep = horizontal ? w * 4 : 4;
    const acc = new Float64Array(n + 2 * r + 2);
    const div = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
        const base = line * lineStep;
        for (let ch = 0; ch < 4; ch++) {
            // padded: r+1 copies of the first, the line, r copies of the last; cumulative sums
            let sum = 0;
            acc[0] = 0;
            const P = n + 2 * r + 1;
            for (let k = 0; k < P; k++) {
                let idx = k - (r + 1);
                if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
                sum += a[base + idx * stride + ch];
                acc[k + 1] = sum;
            }
            for (let i = 0; i < n; i++) a[base + i * stride + ch] = (acc[i + 2 * r + 2] - acc[i + 1]) / div;
        }
    }
}

export function blurImage(img, size) {
    const sigma = Math.max(0, size) / 2;
    if (sigma <= 0) return img;
    const boxes = boxesForGauss(sigma);
    if (img.bb) {
        // Only the box grown by how far the three passes reach (and a pixel): outside it everything stays 0,
        // and inside, the edge of the piece is 0 as the picture's own pixels there are.
        const reach = boxes.reduce((t, s) => t + ((s - 1) >> 1), 0) + 1;
        const sub = boxGrow(img.bb, reach, img.w, img.h);
        if (boxEmpty(sub)) return withBox({ w: img.w, h: img.h, data: new Float32Array(img.w * img.h * 4) }, [0, 0, 0, 0]);
        if (!boxWhole(sub, img.w, img.h)) {
            const sw = sub[2] - sub[0], sh = sub[3] - sub[1], a = new Float64Array(sw * sh * 4);
            for (let y = 0; y < sh; y++) {
                const from = ((sub[1] + y) * img.w + sub[0]) * 4;
                for (let k = 0; k < sw * 4; k++) a[y * sw * 4 + k] = img.data[from + k];
            }
            for (const s of boxes) { const r = (s - 1) >> 1; boxAxis(a, sw, sh, r, true); boxAxis(a, sw, sh, r, false); }
            const out = new Float32Array(img.w * img.h * 4);
            for (let y = 0; y < sh; y++) out.set(a.subarray(y * sw * 4, (y + 1) * sw * 4), ((sub[1] + y) * img.w + sub[0]) * 4);
            return withBox({ w: img.w, h: img.h, data: out }, sub);
        }
    }
    const a = Float64Array.from(img.data);
    for (const s of boxes) {
        const r = (s - 1) >> 1;
        boxAxis(a, img.w, img.h, r, true);
        boxAxis(a, img.w, img.h, r, false);
    }
    return { w: img.w, h: img.h, data: Float32Array.from(a) };
}


const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const LUM = [0.2126, 0.7152, 0.0722];

// ── Crop ─────────────────────────────────────────────────────────────────────

/** How much of each pixel lies inside [lo, hi) along one axis: the area with no softness, else a ramp of
 *  `soft` pixels at each edge measured at the pixel's centre. */
function axisCover(n, lo, hi, soft) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (soft > 0) { const c = i + 0.5; out[i] = clamp01((c - lo) / soft) * clamp01((hi - c) / soft); }
        else out[i] = clamp01(Math.min(i + 1, hi) - Math.max(i, lo));
    }
    return out;
}

/** The picture inside the box (pixels of this picture), transparent outside. */
export function cropImage(img, l, t, r, b, soft) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    const mx = axisCover(img.w, l, r, soft), my = axisCover(img.h, t, b, soft);
    for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
            const m = mx[x] * my[y], i = (y * img.w + x) * 4;
            o[i] = s[i] * m; o[i + 1] = s[i + 1] * m; o[i + 2] = s[i + 2] * m; o[i + 3] = s[i + 3] * m;
        }
    }
    return out;
}

// ── channels ─────────────────────────────────────────────────────────────────

export const SHUFFLE_CHOICES = ["r", "g", "b", "a", "0", "1"];
export const COPY_CHOICES = ["B", "A.r", "A.g", "A.b", "A.a", "0", "1"];
const CH = { r: 0, g: 1, b: 2, a: 3 };

/** Each output channel from a channel of the input (or 0 / 1), as the numbers stand (premultiplied). */
export function shuffleImage(img, pick) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        for (let k = 0; k < 4; k++) { const c = pick[k]; o[i + k] = c === "0" ? 0 : c === "1" ? 1 : s[i + CH[c]]; }
    }
    return out;
}

/** B with chosen channels taken from A (or 0 / 1): Nuke's Copy. */
export function copyImage(Bimg, Aimg, pick) {
    const out = blank(Bimg.w, Bimg.h), B = Bimg.data, A = Aimg.data, o = out.data;
    for (let i = 0; i < Bimg.w * Bimg.h * 4; i += 4) {
        for (let k = 0; k < 4; k++) {
            const c = pick[k];
            o[i + k] = c === "0" ? 0 : c === "1" ? 1 : c === "B" ? B[i + k] : A[i + CH[c.slice(2)]];
        }
    }
    return out;
}

export function premultImage(img) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    for (let i = 0; i < img.w * img.h * 4; i += 4) { const a = s[i + 3]; o[i] = s[i] * a; o[i + 1] = s[i + 1] * a; o[i + 2] = s[i + 2] * a; o[i + 3] = a; }
    return out;
}

export function unpremultImage(img) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        const a = s[i + 3];
        if (a > 0) { o[i] = s[i] / a; o[i + 1] = s[i + 1] / a; o[i + 2] = s[i + 2] / a; }
        else { o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; }
        o[i + 3] = a;
    }
    return out;
}

// ── Keyer ────────────────────────────────────────────────────────────────────

export const KEYER_MODES = ["chroma", "luma"];

/**
 * A key: chroma compares each pixel's chromaticity (its colour divided by r + g + b, so brightness does not
 * matter) with the screen's, as a share of how far the screen is from grey; luma keys by brightness. Below
 * `tolerance` it is gone, over `softness` more it is solid. Despill pulls the screen's strongest channel
 * down to the larger of the other two. Out: the straight colour, despilled, times alpha x key.
 */
export function keyImage(img, p) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    const sc = p.screen || [0, 1, 0, 1];
    const ssum = sc[0] + sc[1] + sc[2];
    const qs = ssum > 1e-6 ? [sc[0] / ssum, sc[1] / ssum, sc[2] / ssum] : [1 / 3, 1 / 3, 1 / 3];
    const e0 = qs[0] - 1 / 3, e1 = qs[1] - 1 / 3, e2 = qs[2] - 1 / 3;
    const spread = Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2);
    let k = 0;
    if (sc[1] >= sc[0] && sc[1] >= sc[2]) k = 1; else if (sc[2] >= sc[0] && sc[2] >= sc[1]) k = 2;
    const oi = [(k + 1) % 3, (k + 2) % 3];
    const soft = Math.max(p.softness, 1e-6), tol = p.tolerance, despill = p.despill;
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        const a = s[i + 3];
        const c = a > 0 ? [s[i] / a, s[i + 1] / a, s[i + 2] / a] : [s[i], s[i + 1], s[i + 2]];
        let key;
        if (p.mode === "luma") key = clamp01((LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2] - tol) / soft);
        else {
            const sum = c[0] + c[1] + c[2];
            if (sum <= 1e-6 || spread <= 1e-6) key = 1;
            else {
                const q0 = c[0] / sum - qs[0], q1 = c[1] / sum - qs[1], q2 = c[2] / sum - qs[2];
                const d = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2) / spread;
                key = clamp01((d - tol) / soft);
            }
            if (despill > 0) {
                const lim = Math.max(c[oi[0]], c[oi[1]]);
                if (c[k] > lim) c[k] = c[k] - despill * (c[k] - lim);
            }
        }
        const na = a * key;
        o[i] = c[0] * na; o[i + 1] = c[1] * na; o[i + 2] = c[2] * na; o[i + 3] = na;
    }
    return out;
}

// ── Roto ─────────────────────────────────────────────────────────────────────

/** The Roto node's picture: the matte as white, or its input cut by the matte. */
export function rotoImage(matte, w, h, src) {
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < w * h; i++) {
        const m = matte[i], j = i * 4;
        if (src) { const s = src.data; o[j] = s[j] * m; o[j + 1] = s[j + 1] * m; o[j + 2] = s[j + 2] * m; o[j + 3] = s[j + 3] * m; }
        else { o[j] = m; o[j + 1] = m; o[j + 2] = m; o[j + 3] = m; }
    }
    return out;
}

// ── motion vectors (optical flow) ────────────────────────────────────────────

const FLOW_WARPS = 2;     // warps per pyramid level
const FLOW_MIN_SIDE = 8;  // no level smaller than this

/** A picture's brightness for matching: Rec. 709 luminance of the (premultiplied) colour, to the power 1/2.2. */
export function greyOf(img) {
    const g = new Float64Array(img.w * img.h), d = img.data;
    for (let i = 0; i < img.w * img.h; i++) {
        const l = LUM[0] * d[i * 4] + LUM[1] * d[i * 4 + 1] + LUM[2] * d[i * 4 + 2];
        g[i] = l > 0 ? Math.pow(l, 1 / 2.2) : 0;
    }
    return g;
}

/** Bilinear at (x, y) in pixel-index coordinates (centres on whole numbers), the edge repeated. */
function sampleGrey(a, w, h, x, y) {
    let x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    x0 = x0 < 0 ? 0 : x0 > w - 1 ? w - 1 : x0; x1 = x1 < 0 ? 0 : x1 > w - 1 ? w - 1 : x1;
    y0 = y0 < 0 ? 0 : y0 > h - 1 ? h - 1 : y0; y1 = y1 < 0 ? 0 : y1 > h - 1 ? h - 1 : y1;
    const A = a[y0 * w + x0], B = a[y0 * w + x1], Cc = a[y1 * w + x0], D = a[y1 * w + x1];
    const top = A + (B - A) * fx, bot = Cc + (D - Cc) * fx;
    return top + (bot - top) * fy;
}

function halve(a, w, h) {
    const w2 = Math.floor(w / 2), h2 = Math.floor(h / 2), o = new Float64Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        const i = 2 * y * w + 2 * x;
        o[y * w2 + x] = (a[i] + a[i + 1] + a[i + w] + a[i + w + 1]) / 4;
    }
    return o;
}

/**
 * Where each pixel of `g0` went in `g1` ({u, v} Float64Array, pixels): Horn-Schunck on a pyramid, coarse to
 * fine, the second picture warped by the flow so far before each round. `smoothness` is Horn-Schunck's alpha
 * (on the 0..1 brightness), `iterations` the Jacobi steps per round, `levels` the most pyramid levels.
 */
export const FLOW_DETAIL = { full: 0, half: 1, quarter: 2 };

export function opticalFlow(g0, g1, w, h, { smoothness = 0.04, iterations = 30, levels = 4, detail = "full" } = {}) {
    const skip = FLOW_DETAIL[detail] || 0;
    const pyr = [{ a: g0, b: g1, w, h }];
    while (pyr.length < levels + skip) {
        const t = pyr[pyr.length - 1];
        const w2 = Math.floor(t.w / 2), h2 = Math.floor(t.h / 2);
        if (Math.min(w2, h2) < FLOW_MIN_SIDE) break;
        pyr.push({ a: halve(t.a, t.w, t.h), b: halve(t.b, t.w, t.h), w: w2, h: h2 });
    }
    const a2 = smoothness * smoothness;
    let u = null, v = null, pw = 0, ph = 0;
    const fine = Math.min(skip, pyr.length - 1);
    for (let L = pyr.length - 1; L >= fine; L--) {
        const { a: I0, b: I1, w: W, h: H } = pyr[L], N = W * H;
        const nu = new Float64Array(N), nv = new Float64Array(N);
        if (u) {
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const j = Math.min(y >> 1, ph - 1) * pw + Math.min(x >> 1, pw - 1);
                nu[y * W + x] = 2 * u[j]; nv[y * W + x] = 2 * v[j];
            }
        }
        u = nu; v = nv; pw = W; ph = H;
        const Ix = new Float64Array(N), Iy = new Float64Array(N), It = new Float64Array(N), Iw = new Float64Array(N);
        for (let r = 0; r < FLOW_WARPS; r++) {
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; Iw[i] = sampleGrey(I1, W, H, x + u[i], y + v[i]); }
            for (let y = 0; y < H; y++) {
                const ym = y > 0 ? y - 1 : 0, yp = y < H - 1 ? y + 1 : H - 1;
                for (let x = 0; x < W; x++) {
                    const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1, i = y * W + x;
                    const dx0 = (I0[y * W + xp] - I0[y * W + xm]) / 2, dx1 = (Iw[y * W + xp] - Iw[y * W + xm]) / 2;
                    const dy0 = (I0[yp * W + x] - I0[ym * W + x]) / 2, dy1 = (Iw[yp * W + x] - Iw[ym * W + x]) / 2;
                    Ix[i] = (dx0 + dx1) / 2; Iy[i] = (dy0 + dy1) / 2; It[i] = Iw[i] - I0[i];
                }
            }
            let du = new Float64Array(N), dv = new Float64Array(N), eu = new Float64Array(N), ev = new Float64Array(N);
            for (let it = 0; it < iterations; it++) {
                for (let y = 0; y < H; y++) {
                    const ym = y > 0 ? y - 1 : 0, yp = y < H - 1 ? y + 1 : H - 1;
                    for (let x = 0; x < W; x++) {
                        const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1, i = y * W + x;
                        const ub = (du[y * W + xm] + du[y * W + xp] + du[ym * W + x] + du[yp * W + x]) / 4;
                        const vb = (dv[y * W + xm] + dv[y * W + xp] + dv[ym * W + x] + dv[yp * W + x]) / 4;
                        const t = (Ix[i] * ub + Iy[i] * vb + It[i]) / (a2 + Ix[i] * Ix[i] + Iy[i] * Iy[i]);
                        eu[i] = ub - Ix[i] * t; ev[i] = vb - Iy[i] * t;
                    }
                }
                let s = du; du = eu; eu = s; s = dv; dv = ev; ev = s;
            }
            for (let i = 0; i < N; i++) { u[i] += du[i]; v[i] += dv[i]; }
        }
    }
    if (fine > 0) {
        // Computed on a smaller picture: brought up to full size, bilinear, and scaled with it.
        const k = 2 ** fine, uu = new Float64Array(w * h), vv = new Float64Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const sx = (x + 0.5) / k - 0.5, sy = (y + 0.5) / k - 0.5;
            uu[y * w + x] = sampleGrey(u, pw, ph, sx, sy) * k; vv[y * w + x] = sampleGrey(v, pw, ph, sx, sy) * k;
        }
        return { u: uu, v: vv };
    }
    return { u, v };
}

/** Motion vectors for picture `cur` against the frames before and after: rg = forward (to the next frame),
 *  ba = backward (to the one before), in pixels of the COMP (divided by `scale`). */
export function vectorsImage(prev, cur, next, opts, scale = 1) {
    const w = cur.w, h = cur.h, g = greyOf(cur);
    const fw = opticalFlow(g, greyOf(next), w, h, opts), bw = opticalFlow(g, greyOf(prev), w, h, opts);
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < w * h; i++) {
        o[i * 4] = fw.u[i] / scale; o[i * 4 + 1] = fw.v[i] / scale; o[i * 4 + 2] = bw.u[i] / scale; o[i * 4 + 3] = bw.v[i] / scale;
    }
    return out;
}

// ── motion blur ──────────────────────────────────────────────────────────────

export const SHUTTER_OFFSETS = ["centred", "start", "end"];

/** One channel-set sample, bilinear, the edge repeated, into out[0..3]. */
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

/** Each pixel averaged along where it travels while the shutter is open: forward vectors (rg) for the time
 *  after the frame, backward (ba) for the time before; vectors in comp pixels, times `scale` here. */
export function motionBlurImage(img, vec, shutter, samples, offset, scale = 1) {
    if (!(shutter > 0) || !vec) return img;
    const w = img.w, h = img.h, out = blank(w, h), o = out.data, d = img.data, V = vec.data;
    const lo = offset === "start" ? 0 : offset === "end" ? -shutter : -shutter / 2;
    const hi = lo + shutter;
    const N = Math.max(1, Math.round(samples));
    const s = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < N; k++) {
            const t = lo + ((k + 0.5) * (hi - lo)) / N;
            const dx = t >= 0 ? t * V[i] * scale : -t * V[i + 2] * scale;
            const dy = t >= 0 ? t * V[i + 1] * scale : -t * V[i + 3] * scale;
            samplePix(d, w, h, x + dx, y + dy, s);
            r += s[0]; g += s[1]; b += s[2]; a += s[3];
        }
        o[i] = r / N; o[i + 1] = g / N; o[i + 2] = b / N; o[i + 3] = a / N;
    }
    return out;
}

// ── depth blur ───────────────────────────────────────────────────────────────

export const DEPTH_CHANNELS = ["r", "g", "b", "a", "luminance"];

/**
 * A blur that grows with the distance from the focus: each pixel's circle of confusion is
 * clamp((|depth - focus| - dof / 2) / falloff, 0, 1) of `size`; the picture is blurred at `layers` sizes
 * from 0 to `size` (Blur's size, pixels of this picture) and each pixel takes the two nearest, weighted by
 * where its circle lies between them - spread with them, so a blurred edge reaches over its neighbours.
 */
export function depthBlurImage(img, depth, p) {
    const w = img.w, h = img.h, d = img.data, D = depth.data, N = w * h;
    const L = Math.max(2, Math.round(p.layers));
    const ch = p.channel;
    const pos = new Float64Array(N);
    const fall = Math.max(p.falloff, 1e-6);
    for (let i = 0; i < N; i++) {
        const z = ch === "luminance" ? LUM[0] * D[i * 4] + LUM[1] * D[i * 4 + 1] + LUM[2] * D[i * 4 + 2] : D[i * 4 + CH[ch]];
        pos[i] = clamp01((Math.abs(z - p.focus) - p.dof / 2) / fall) * (L - 1);
    }
    const num = new Float64Array(N * 4), den = new Float64Array(N);
    for (let l = 0; l < L; l++) {
        const col = blank(w, h), wt = blank(w, h);
        let any = false;
        for (let i = 0; i < N; i++) {
            const k = 1 - Math.abs(pos[i] - l);
            if (k <= 0) continue;
            any = true;
            const j = i * 4;
            col.data[j] = d[j] * k; col.data[j + 1] = d[j + 1] * k; col.data[j + 2] = d[j + 2] * k; col.data[j + 3] = d[j + 3] * k;
            wt.data[j] = k;
        }
        if (!any) continue;
        const size = (p.size * l) / (L - 1);
        const lens = p.filter === "lens";
        const blur = (im) => (lens ? defocusImage(im, { size, shape: "disc", blades: 6, rotation: 0, aspect: 1, bloom: 0, threshold: 1 }) : blurImage(im, size));
        const bc = blur(col), bw = blur(wt);
        for (let i = 0; i < N; i++) {
            const j = i * 4;
            num[j] += bc.data[j]; num[j + 1] += bc.data[j + 1]; num[j + 2] += bc.data[j + 2]; num[j + 3] += bc.data[j + 3];
            den[i] += bw.data[j];
        }
    }
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < N; i++) {
        const j = i * 4;
        if (den[i] > 1e-6) { o[j] = num[j] / den[i]; o[j + 1] = num[j + 1] / den[i]; o[j + 2] = num[j + 2] / den[i]; o[j + 3] = num[j + 3] / den[i]; }
        else { o[j] = d[j]; o[j + 1] = d[j + 1]; o[j + 2] = d[j + 2]; o[j + 3] = d[j + 3]; }
    }
    return out;
}

// ── Defocus: a lens's blur ───────────────────────────────────────────────────

export const DEFOCUS_SHAPES = ["disc", "polygon"];

/**
 * The aperture as rows: [{dy, l, r}] - for each row of pixels dy (centre) the aperture's span [l, r] there.
 * A disc of diameter `size` (pixels), or a polygon of `blades` sides (one pointing up, turned by `rotation`
 * degrees); `aspect` stretches it sideways.
 */
export function apertureRows(size, shape, blades, rotation, aspect) {
    const r = size / 2, rows = [];
    if (!(r > 0)) return rows;
    const R = Math.ceil(r);
    let verts = null;
    if (shape === "polygon") {
        const n = Math.max(3, Math.round(blades)), rot = (rotation * Math.PI) / 180;
        verts = [];
        for (let k = 0; k < n; k++) { const a = rot + (2 * Math.PI * k) / n - Math.PI / 2; verts.push([r * aspect * Math.cos(a), r * Math.sin(a)]); }
    }
    for (let dy = -R; dy <= R; dy++) {
        if (!verts) {
            if (Math.abs(dy) > r) continue;
            const hw = aspect * Math.sqrt(r * r - dy * dy);
            rows.push({ dy, l: -hw, r: hw });
            continue;
        }
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < verts.length; k++) {
            const p = verts[k], q = verts[(k + 1) % verts.length];
            if ((p[1] <= dy) !== (q[1] <= dy)) {
                const x = p[0] + ((dy - p[1]) * (q[0] - p[0])) / (q[1] - p[1]);
                if (x < lo) lo = x;
                if (x > hi) hi = x;
            }
        }
        if (hi > lo) rows.push({ dy, l: lo, r: hi });
    }
    return rows;
}

/** A row's pixels: the first and last it touches and how much of them ({a, b, wa, wb}; a === b: one pixel, weight wa). */
function rowSpan(row) {
    const a = Math.floor(row.l + 0.5), b = Math.floor(row.r + 0.5);
    if (a === b) return { a, b, wa: row.r - row.l, wb: 0 };
    return { a, b, wa: a + 0.5 - row.l, wb: row.r - (b - 0.5) };
}

/**
 * The picture through the aperture: every pixel the mean of the aperture's area around it (the edge
 * repeated; a row's ends weighted by how much of their pixel it covers). `bloom` first brightens what is
 * brighter than `threshold` (luminance), so highlights make bright bokeh. Sizes are pixels of this picture.
 */
export function defocusImage(img, p) {
    const rows = apertureRows(p.size, p.shape, p.blades, p.rotation, p.aspect).map((row) => ({ dy: row.dy, ...rowSpan(row) }));
    if (rows.length <= 1 && (!rows.length || (rows[0].a === rows[0].b))) return img;
    const w = img.w, h = img.h, s = img.data;
    let reach = 1;
    for (const k of rows) reach = Math.max(reach, Math.abs(k.a) + 1, Math.abs(k.b) + 1);
    let total = 0;
    for (const k of rows) {
        if (k.a === k.b) { total += k.wa; continue; }
        if (k.b - 1 >= k.a + 1) total += k.b - 1 - (k.a + 1) + 1;
        total += k.wa; total += k.wb;
    }
    // The padded rows (edge repeated) and their running sums, per channel.
    const PW = w + 2 * reach;
    const Q = new Float64Array(h * PW * 4), P = new Float64Array(h * (PW + 1) * 4);
    const bloom = p.bloom || 0, thr = p.threshold;
    for (let y = 0; y < h; y++) {
        for (let i = 0; i < PW; i++) {
            let x = i - reach;
            x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
            const si = (y * w + x) * 4, qi = (y * PW + i) * 4;
            let m = 1;
            if (bloom > 0) { const L = LUM[0] * s[si] + LUM[1] * s[si + 1] + LUM[2] * s[si + 2]; if (L > thr) m = 1 + bloom * (L - thr); }
            Q[qi] = s[si] * m; Q[qi + 1] = s[si + 1] * m; Q[qi + 2] = s[si + 2] * m; Q[qi + 3] = s[si + 3];
        }
        for (let c = 0; c < 4; c++) {
            let sum = 0;
            P[(y * (PW + 1)) * 4 + c] = 0;
            for (let i = 0; i < PW; i++) { sum += Q[(y * PW + i) * 4 + c]; P[(y * (PW + 1) + i + 1) * 4 + c] = sum; }
        }
    }
    const out = blank(w, h), o = out.data;
    const acc = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        acc[0] = acc[1] = acc[2] = acc[3] = 0;
        for (const k of rows) {
            let yy = y + k.dy;
            yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
            const qb = yy * PW, pb = yy * (PW + 1), xo = x + reach;
            for (let c = 0; c < 4; c++) {
                if (k.a === k.b) { acc[c] += k.wa * Q[(qb + xo + k.a) * 4 + c]; continue; }
                if (k.b - 1 >= k.a + 1) acc[c] += P[(pb + xo + k.b) * 4 + c] - P[(pb + xo + k.a + 1) * 4 + c];
                acc[c] += k.wa * Q[(qb + xo + k.a) * 4 + c];
                acc[c] += k.wb * Q[(qb + xo + k.b) * 4 + c];
            }
        }
        const i = (y * w + x) * 4;
        o[i] = acc[0] / total; o[i + 1] = acc[1] / total; o[i + 2] = acc[2] / total; o[i + 3] = acc[3] / total;
    }
    return out;
}
