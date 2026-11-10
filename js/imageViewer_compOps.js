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
    const a = Float64Array.from(img.data);
    for (const s of boxesForGauss(sigma)) {
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

export const ROTO_MODES = ["add", "subtract"];
const SUB = 4;          // sub-samples per pixel along each axis (16 a pixel)
const SPLINE_STEPS = 8; // pieces of each segment of a smooth shape

/** A shape's points at `frame` (comp pixels): its keys, straight between them, held before and after. */
export function shapePoints(shape, frame) {
    const keys = Array.isArray(shape.keys) ? shape.keys.filter((k) => k && Array.isArray(k.pts)).slice().sort((a, b) => a.f - b.f) : [];
    if (!keys.length) return Array.isArray(shape.pts) ? shape.pts : [];
    if (frame <= keys[0].f) return keys[0].pts;
    const last = keys[keys.length - 1];
    if (frame >= last.f) return last.pts;
    let i = 0;
    while (keys[i + 1].f <= frame) i++;
    const a = keys[i], b = keys[i + 1];
    if (a.pts.length !== b.pts.length) return a.pts;
    const t = (frame - a.f) / (b.f - a.f);
    return a.pts.map((p, j) => [p[0] + (b.pts[j][0] - p[0]) * t, p[1] + (b.pts[j][1] - p[1]) * t]);
}

/** The outline drawn: the points, or a closed Catmull-Rom curve through them; times `scale`. */
export function shapeOutline(pts, smooth, scale = 1) {
    const n = pts.length;
    if (!smooth || n < 3) return pts.map((p) => [p[0] * scale, p[1] * scale]);
    const out = [];
    for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        for (let s = 0; s < SPLINE_STEPS; s++) {
            const t = s / SPLINE_STEPS, t2 = t * t, t3 = t2 * t;
            const q = [0, 1].map((k) => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3));
            out.push([q[0] * scale, q[1] * scale]);
        }
    }
    return out;
}

/** How much of each pixel a closed polygon covers (even-odd), on 4 x 4 sub-samples: Float64Array w*h. */
export function polygonCover(poly, w, h) {
    const cov = new Float64Array(w * h);
    const n = poly.length;
    if (n < 3) return cov;
    const W4 = w * SUB;
    const cross = [];
    for (let sy = 0; sy < h * SUB; sy++) {
        const yy = (sy + 0.5) / SUB;
        cross.length = 0;
        for (let e = 0; e < n; e++) {
            const p = poly[e], q = poly[(e + 1) % n];
            if ((p[1] <= yy) !== (q[1] <= yy)) cross.push(p[0] + ((yy - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
        }
        if (cross.length < 2) continue;
        cross.sort((a, b) => a - b);
        const row = Math.floor(sy / SUB) * w;
        for (let j = 0; j + 1 < cross.length; j += 2) {
            const k0 = Math.max(0, Math.ceil(cross[j] * SUB - 0.5)), k1 = Math.min(W4, Math.ceil(cross[j + 1] * SUB - 0.5));
            for (let k = k0; k < k1; k++) cov[row + Math.floor(k / SUB)] += 1 / (SUB * SUB);
        }
    }
    return cov;
}

/** A Roto node's matte at `frame` in a w x h picture (`scale` times the comp): Float64Array w*h. */
export function rotoMatte(shapes, frame, w, h, scale) {
    const M = new Float64Array(w * h);
    for (const sh of Array.isArray(shapes) ? shapes : []) {
        if (!sh || sh.off) continue;
        const pts = shapePoints(sh, frame);
        if (!pts || pts.length < 3) continue;
        let m = polygonCover(shapeOutline(pts, sh.smooth !== false, scale), w, h);
        const feather = (Number(sh.feather) || 0) * scale;
        if (feather > 0) {
            const tmp = blank(w, h);
            for (let i = 0; i < w * h; i++) tmp.data[i * 4] = m[i];
            const b = blurImage(tmp, feather);
            m = new Float64Array(w * h);
            for (let i = 0; i < w * h; i++) m[i] = b.data[i * 4];
        }
        if (sh.mode === "subtract") for (let i = 0; i < w * h; i++) M[i] = M[i] * (1 - m[i]);
        else for (let i = 0; i < w * h; i++) M[i] = M[i] + m[i] - M[i] * m[i];
    }
    return M;
}

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
