// imageViewer_compGrain.js
// Grain as a measured thing: a grain profile (how strong the grain is per channel, per brightness and per size),
// the Degrain that takes it out, the Regrain that puts a plate's own grain back over a comp, and the profile-
// driven synthesis the Grain node uses. imageViewer_compExtra.js has their table and calls these.
//
// Pure functions on pictures ({w, h, data: Float32Array w*h*4}, linear, premultiplied). src/comp_extra.py holds
// the same arithmetic in numpy, operation for operation and in the same order (tests/test_comp_parity.py
// compares them float for float): change one, change the other. Everything in between is float64.
//
// Clean room (Sebastian 2026-11-13): written from published maths only - the "a trous" B3-spline wavelet
// (Starck and Murtagh), soft thresholding of wavelet details (Donoho), the median absolute deviation as a robust
// spread, Tukey's biweight, Cholesky - and from the general method of measuring grain against brightness and
// re-applying it normalised (as described in plate regraining write-ups). No code of any regrain tool or plug-in.
import { hash01 } from "./imageViewer_compFilters.js";
import { blank } from "./imageViewer_compOps.js";

const LUM = [0.2126, 0.7152, 0.0722];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Detail bands a profile keeps (finest first): 1, 2, 4 and 8 pixel grain. */
export const GRAIN_LEVELS = 4;
/** Brightness bins a profile measures. */
export const GRAIN_BINS = 8;
/** At least this many samples in a bin, or the bin takes its neighbour's numbers. */
const MIN_COUNT = 8;
/** ...and at least this share of all the samples. */
const MIN_SHARE = 0.005;
/** A sample whose brightness changes by more than this many times the median change is on an edge. */
const EDGE = 4;
/** At most about this many pixels are measured (a grid of them). */
const SAMPLES = 65536;
export const REGRAIN_FILLS = ["scatter", "synth", "plate"];
export const REGRAIN_OUTPUTS = ["result", "grain", "new areas", "difference"];
export const DEGRAIN_OUTPUTS = ["degrained", "removed"];

// ── the wavelet ──────────────────────────────────────────────────────────────

/** One a-trous smoothing of a plane at level j: [1 4 6 4 1] / 16 with holes of 2^j, across then down, edges held. */
export function atrousSmooth(a, w, h, j) {
    const s = 1 << j, t = new Float64Array(w * h), out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        const r = y * w;
        for (let x = 0; x < w; x++) {
            const x1 = x - s < 0 ? 0 : x - s, x0 = x - 2 * s < 0 ? 0 : x - 2 * s;
            const x3 = x + s > w - 1 ? w - 1 : x + s, x4 = x + 2 * s > w - 1 ? w - 1 : x + 2 * s;
            t[r + x] = (a[r + x0] + 4 * a[r + x1] + 6 * a[r + x] + 4 * a[r + x3] + a[r + x4]) / 16;
        }
    }
    for (let y = 0; y < h; y++) {
        const y1 = (y - s < 0 ? 0 : y - s) * w, y0 = (y - 2 * s < 0 ? 0 : y - 2 * s) * w;
        const y3 = (y + s > h - 1 ? h - 1 : y + s) * w, y4 = (y + 2 * s > h - 1 ? h - 1 : y + 2 * s) * w, r = y * w;
        for (let x = 0; x < w; x++) out[r + x] = (t[y0 + x] + 4 * t[y1 + x] + 6 * t[r + x] + 4 * t[y3 + x] + t[y4 + x]) / 16;
    }
    return out;
}
/** A plane's detail bands and what is left: {d: [L planes], c: the smooth rest}. */
export function atrous(a, w, h, levels) {
    const d = [];
    let c = a;
    for (let j = 0; j < levels; j++) {
        const n = atrousSmooth(c, w, h, j), dj = new Float64Array(w * h);
        for (let i = 0; i < dj.length; i++) dj[i] = c[i] - n[i];
        d.push(dj);
        c = n;
    }
    return { d, c };
}
/** The 1D kernels of 0..GRAIN_LEVELS a-trous smoothings, dense, centred at KR (made once). */
const KR = 128;
let KERNELS = null;
function atrousKernels() {
    if (KERNELS) return KERNELS;
    let c = new Float64Array(2 * KR + 1);
    c[KR] = 1;
    const ks = [c];
    for (let k = 0; k < GRAIN_LEVELS; k++) {
        const s = 1 << k, n = new Float64Array(2 * KR + 1);
        const tap = [[-2 * s, 1], [-s, 4], [0, 6], [s, 4], [2 * s, 1]];
        for (let i = 0; i < c.length; i++) {
            if (!c[i]) continue;
            for (const [o, wt] of tap) { const q = i + o; if (q >= 0 && q < n.length) n[q] += c[i] * wt / 16; }
        }
        c = n;
        ks.push(c);
    }
    return (KERNELS = ks);
}
function dot(a, b) { let v = 0; for (let i = 0; i < a.length; i++) v += a[i] * b[i]; return v; }
/** How alike detail bands j and k of unit white noise are (their covariance; 2D, separable kernels). */
export function whiteBandCov(j, k) {
    const K = atrousKernels(), A = (a, b) => dot(K[a], K[b]);
    const x = A(j, k), y = A(j, k + 1), z = A(j + 1, k), t = A(j + 1, k + 1);
    return x * x - y * y - z * z + t * t;
}
/** The spread (standard deviation) of detail band j of unit white noise. */
export function whiteBandSpread(j) { return Math.sqrt(whiteBandCov(j, j)); }

// ── planes ───────────────────────────────────────────────────────────────────

/** The r g b planes of a picture (premultiplied, as they are). */
export function rgbPlanes(img) {
    const n = img.w * img.h, s = img.data, out = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    for (let i = 0; i < n; i++) { out[0][i] = s[i * 4]; out[1][i] = s[i * 4 + 1]; out[2][i] = s[i * 4 + 2]; }
    return out;
}
/** The brightness a profile is looked up by: Rec. 709 luma, smoothed by the first two a-trous levels. */
export function guideLuma(planes, w, h) {
    const n = w * h, L = new Float64Array(n);
    for (let i = 0; i < n; i++) L[i] = LUM[0] * planes[0][i] + LUM[1] * planes[1][i] + LUM[2] * planes[2][i];
    return atrousSmooth(atrousSmooth(L, w, h, 0), w, h, 1);
}

// ── the profile ──────────────────────────────────────────────────────────────

function median(v) {
    const n = v.length;
    if (!n) return 0;
    v.sort();
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}
/** Leave out the samples on the picture's edges (where a degrain leaves some of the picture in the grain): those
 *  whose guide changes by more than EDGE x the median change across them. Keeps them all if that leaves too few. */
function flatSamples(idx, guide, w) {
    if (!idx.length) return idx;
    const gm = new Float64Array(idx.length);
    for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        gm[k] = Math.abs(guide[i + 1] - guide[i - 1]) + Math.abs(guide[i + w] - guide[i - w]);
    }
    const lim = EDGE * median(Float64Array.from(gm)), out = [];
    for (let k = 0; k < idx.length; k++) if (gm[k] <= lim) out.push(idx[k]);
    return out.length >= idx.length / 4 ? out : idx;
}
/** The pixels measured: a grid of at most about SAMPLES, away from the edges where the wavelet repeats them. */
function sampleIndex(w, h, levels) {
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / SAMPLES)));
    const m = Math.max(1, Math.min(Math.floor(w / 4), Math.floor(h / 4), 1 << levels));
    const out = [];
    for (let y = m; y < h - m; y += step) for (let x = m; x < w - m; x += step) out.push(y * w + x);
    return out;
}
/**
 * Measure grain. `noise` is three planes holding the grain (plate - degrained) or a picture with grain in it;
 * `guide` the brightness to sort it by. Per detail band, channel and brightness bin: the spread of the band
 * (1.4826 x the median absolute value, which picture edges barely move); bins with too few samples take the
 * nearest bin's. corr: how alike the three channels' finest grain is. range: [lo, hi] of the bins (else the 1st
 * and 99th percentile of the guide). `scale`: the scale of the pictures measured (the profile says it).
 */
export function analyseGrain(noise, guide, w, h, scale = 1, range = null) {
    const levels = GRAIN_LEVELS, NB = GRAIN_BINS;
    const idx = flatSamples(sampleIndex(w, h, levels), guide, w);
    let lo, hi;
    if (range) [lo, hi] = range;
    else {
        const g = Float64Array.from(idx, (i) => guide[i]).sort();
        const n = g.length;
        lo = n ? g[Math.floor(0.01 * (n - 1))] : 0;
        hi = n ? g[Math.floor(0.99 * (n - 1))] : 1;
    }
    if (!(hi - lo > 1e-6)) hi = lo + 1e-6;
    const bin = new Int32Array(idx.length);
    for (let k = 0; k < idx.length; k++) {
        const b = Math.floor((guide[idx[k]] - lo) / (hi - lo) * NB);
        bin[k] = b < 0 ? 0 : b > NB - 1 ? NB - 1 : b;
    }
    const sigma = [], bands0 = [];
    for (let c = 0; c < 3; c++) {
        const { d } = atrous(noise[c], w, h, levels);
        bands0.push(d[0]);
        for (let j = 0; j < levels; j++) {
            if (!sigma[j]) sigma[j] = [];
            const groups = Array.from({ length: NB }, () => []);
            for (let k = 0; k < idx.length; k++) groups[bin[k]].push(Math.abs(d[j][idx[k]]));
            const all = [];
            const least = Math.max(MIN_COUNT, Math.ceil(MIN_SHARE * idx.length));
            const row = groups.map((g) => { for (const v of g) all.push(v); return g.length >= least ? 1.4826 * median(Float64Array.from(g)) : null; });
            const whole = 1.4826 * median(Float64Array.from(all));
            sigma[j][c] = fillBins(row, whole);
        }
    }
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const i of idx) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += bands0[a][i] * bands0[b][i];
    const corr = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        if (a === b) continue;
        const q = Math.sqrt(S[a][a] * S[b][b]);
        corr[a][b] = q > 0 ? Math.max(-1, Math.min(1, S[a][b] / q)) : 0;
    }
    return { v: 1, scale, levels, bins: NB, lo, hi, sigma, corr };
}
/** Bins without a number take the nearest bin's that has one (the lower on a tie); none at all: `whole`. */
function fillBins(row, whole) {
    const out = row.slice();
    for (let k = 0; k < out.length; k++) {
        if (out[k] !== null) continue;
        let best = null;
        for (let r = 1; r < row.length && best === null; r++) {
            if (k - r >= 0 && row[k - r] !== null) best = row[k - r];
            else if (k + r < row.length && row[k + r] !== null) best = row[k + r];
        }
        out[k] = best === null ? whole : best;
    }
    return out;
}
/** Is p a profile this code can use? */
export function isProfile(p) {
    return !!(p && p.v === 1 && Array.isArray(p.sigma) && p.sigma.length && Array.isArray(p.corr) && Number.isFinite(p.lo) && Number.isFinite(p.hi));
}
/** Several frames' profiles as one: the median of each number, the mean of the correlations. */
export function mergeProfiles(list) {
    const ps = list.filter(isProfile);
    if (!ps.length) return null;
    const p0 = ps[0], out = JSON.parse(JSON.stringify(p0));
    for (let j = 0; j < p0.sigma.length; j++) for (let c = 0; c < 3; c++) for (let k = 0; k < p0.bins; k++)
        out.sigma[j][c][k] = median(Float64Array.from(ps, (p) => p.sigma[j][c][k]));
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { let s = 0; for (const p of ps) s += p.corr[a][b]; out.corr[a][b] = s / ps.length; }
    out.frames = ps.length;
    return out;
}
/**
 * A profile as it stands at `scale`: grain finer than a pixel there is gone, so its band j is the measured band
 * j + shift (shift = log2 of the measured scale over this one, rounded). {levels, bands: [j][c][bin], total:
 * [c][bin] (the whole grain's spread), lo, hi, bins, corr}.
 */
export function profileAt(p, scale) {
    const shift = Math.floor(Math.log2(p.scale / scale) + 0.5);
    const L = p.sigma.length, levels = Math.max(1, L - Math.max(0, shift));
    const bands = [];
    for (let j = 0; j < levels; j++) {
        const m = Math.min(L - 1, Math.max(0, j + shift));
        bands.push(p.sigma[m].map((row) => row.slice()));
    }
    // The whole grain's spread: the bands' spreads summed with how alike neighbouring bands of noise are.
    const rho = [];
    for (let j = 0; j < levels; j++) { rho.push([]); for (let k = 0; k < levels; k++) rho[j].push(whiteBandCov(j, k) / (whiteBandSpread(j) * whiteBandSpread(k))); }
    const total = [0, 1, 2].map((c) => Array.from({ length: p.bins }, (_, b) => {
        let v = 0;
        for (let j = 0; j < levels; j++) for (let k = 0; k < levels; k++) v += rho[j][k] * bands[j][c][b] * bands[k][c][b];
        return Math.sqrt(Math.max(0, v));
    }));
    return { levels, bands, total, lo: p.lo, hi: p.hi, bins: p.bins, corr: p.corr };
}
/** Where each pixel of `guide` falls between the bins' centres: {k: Int32Array, t: Float64Array}. */
export function binPlaces(guide, q) {
    const n = guide.length, K = new Int32Array(n), T = new Float64Array(n), NB = q.bins;
    for (let i = 0; i < n; i++) {
        let u = (guide[i] - q.lo) / (q.hi - q.lo) * NB - 0.5;
        if (u < 0) u = 0;
        if (u > NB - 1) u = NB - 1;
        let k = Math.floor(u);
        if (k > NB - 2) k = Math.max(0, NB - 2);
        K[i] = k;
        T[i] = NB > 1 ? u - k : 0;
    }
    return { k: K, t: T };
}
/** One row of numbers per bin looked up at the places (straight between the bins' centres). */
function lookup(row, pl, i) {
    const k = pl.k[i], t = pl.t[i];
    return row.length > 1 ? row[k] * (1 - t) + row[k + 1] * t : row[0];
}

// ── synthesis ────────────────────────────────────────────────────────────────

/** The lower triangle of a 3 x 3 correlation (held positive). */
export function cholesky3(m) {
    const L = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) {
        let s = m[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) L[i][j] = Math.sqrt(Math.max(s, 1e-6));
        else L[i][j] = s / L[j][j];
    }
    return L;
}
/**
 * Grain of unit strength shaped as a profile: white noise per channel (seeded per frame), mixed so the channels
 * are as alike as measured, then each detail band weighted by its share of the measured grain. Three planes.
 */
export function synthField(q, w, h, frame, seed) {
    const n = w * h, X = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const Lc = cholesky3(q.corr);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = (hash01(x, y, 0, frame, seed) - 0.5) * 3.4641016151377544;
        const b = (hash01(x, y, 1, frame, seed) - 0.5) * 3.4641016151377544;
        const c = (hash01(x, y, 2, frame, seed) - 0.5) * 3.4641016151377544;
        X[0][i] = Lc[0][0] * a;
        X[1][i] = Lc[1][0] * a + Lc[1][1] * b;
        X[2][i] = Lc[2][0] * a + Lc[2][1] * b + Lc[2][2] * c;
    }
    const out = [];
    for (let c = 0; c < 3; c++) {
        // Each band's share of the grain, averaged over the bins.
        const share = [];
        for (let j = 0; j < q.levels; j++) {
            let s = 0;
            for (let k = 0; k < q.bins; k++) s += q.total[c][k] > 0 ? q.bands[j][c][k] / q.total[c][k] : 0;
            share.push(s / q.bins);
        }
        // Each band at its share, the sum brought to unit spread (neighbouring bands of noise are not independent).
        const g0 = share.map((v, j) => v / whiteBandSpread(j));
        let vr = 0;
        for (let j = 0; j < q.levels; j++) for (let k = 0; k < q.levels; k++) vr += g0[j] * g0[k] * whiteBandCov(j, k);
        const sd = vr > 0 ? Math.sqrt(vr) : 1;
        const { d } = atrous(X[c], w, h, q.levels), o = new Float64Array(n);
        for (let j = 0; j < q.levels; j++) {
            const g = g0[j] / sd, dj = d[j];
            for (let i = 0; i < n; i++) o[i] += g * dj[i];
        }
        out.push(o);
    }
    return out;
}

// ── the nodes ────────────────────────────────────────────────────────────────

/** The profile a node works with: its own (Analyse), else one measured now on `noise` sorted by `guide`. */
function profileFor(n, noise, guide, w, h, scale) {
    return profileAt(isProfile(n && n.profile) ? n.profile : analyseGrain(noise, guide, w, h, scale), scale);
}

/**
 * Grain with a profile: unit grain shaped by it, times the measured strength at each pixel's brightness, times
 * `amount` (1 = as measured), added to the picture (premultiplied: times its alpha).
 */
export function profileGrainImage(img, n, p, frame, scale) {
    const w = img.w, h = img.h, N = w * h, s = img.data;
    const q = profileAt(n.profile, scale);
    const fr = p.animated === "off" ? 0 : Math.round(frame), seed = Math.round(p.seed || 0);
    const F = synthField(q, w, h, fr, seed);
    const pl = binPlaces(guideLuma(rgbPlanes(img), w, h), q);
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < N; i++) {
        const a = s[i * 4 + 3];
        o[i * 4 + 3] = a;
        for (let c = 0; c < 3; c++) o[i * 4 + c] = s[i * 4 + c] + p.amount * a * F[c][i] * lookup(q.total[c], pl, i);
    }
    return out;
}

/** A plane's 3 x 3 mean, edges held. */
function box3(a, w, h) {
    const t = new Float64Array(w * h), out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const r = y * w, x0 = x > 0 ? x - 1 : 0, x2 = x < w - 1 ? x + 1 : w - 1;
        t[r + x] = (a[r + x0] + a[r + x] + a[r + x2]) / 3;
    }
    for (let y = 0; y < h; y++) {
        const y0 = (y > 0 ? y - 1 : 0) * w, y2 = (y < h - 1 ? y + 1 : h - 1) * w, r = y * w;
        for (let x = 0; x < w; x++) out[r + x] = (t[y0 + x] + t[r + x] + t[y2 + x]) / 3;
    }
    return out;
}
/** The frames a Degrain reads at f (its own in the middle). */
export function degrainFrames(n, f) {
    const R = Math.max(0, Math.min(3, Math.round(n.temporal ?? 1)));
    const out = [];
    for (let g = f - R; g <= f + R; g++) out.push(g);
    return out;
}
/**
 * Degrain. Over time first: each neighbouring frame is averaged in by a Tukey weight of how far it is from this
 * one (its 3 x 3 mean difference over `motion` x the grain's strength there), so what moves is left to the
 * spatial pass. Then over space: every detail band of every channel is soft-thresholded at `strength` x the
 * grain's spread in that band at that brightness (less what the time pass took off), by the band's amount
 * (fine, medium, coarse). `pics` are the frames of degrainFrames, conformed; `at` is this frame's place in them.
 */
export function degrainImage(pics, at, n, p, scale) {
    const S = pics[at], w = S.w, h = S.h, N = w * h, s = S.data;
    const planes = rgbPlanes(S), guide = guideLuma(planes, w, h);
    const q = profileFor(n, planes, guide, w, h, scale), pl = binPlaces(guide, q);
    const lumTot = q.total[0].map((v, k) => (v + q.total[1][k] + q.total[2][k]) / 3);
    // Over time.
    let T = planes, rho = null;
    if (pics.length > 1) {
        const acc = planes.map((a) => Float64Array.from(a)), W = new Float64Array(N).fill(1), W2 = new Float64Array(N).fill(1);
        const mot = Math.max(1e-6, p.motion);
        for (let k = 0; k < pics.length; k++) {
            if (k === at) continue;
            const Q = rgbPlanes(pics[k]), D = new Float64Array(N);
            for (let i = 0; i < N; i++) D[i] = (Math.abs(Q[0][i] - planes[0][i]) + Math.abs(Q[1][i] - planes[1][i]) + Math.abs(Q[2][i] - planes[2][i])) / 3;
            const Db = box3(D, w, h);
            for (let i = 0; i < N; i++) {
                const sg = lookup(lumTot, pl, i), u = sg > 0 ? Db[i] / (mot * sg) : 2;
                const wt = u < 1 ? (1 - u * u) * (1 - u * u) : 0;
                if (!wt) continue;
                for (let c = 0; c < 3; c++) acc[c][i] += wt * Q[c][i];
                W[i] += wt; W2[i] += wt * wt;
            }
        }
        T = acc.map((a) => { const o = new Float64Array(N); for (let i = 0; i < N; i++) o[i] = a[i] / W[i]; return o; });
        rho = new Float64Array(N);
        for (let i = 0; i < N; i++) rho[i] = Math.sqrt(W2[i]) / W[i];
    }
    // Over space.
    const amt = [p.fine, p.medium, p.coarse], k0 = Math.max(0, p.strength);
    const res = [];
    for (let c = 0; c < 3; c++) {
        const { d, c: rest } = atrous(T[c], w, h, q.levels), o = Float64Array.from(rest);
        for (let j = 0; j < q.levels; j++) {
            const a = amt[Math.min(j, 2)], dj = d[j], row = q.bands[j][c];
            for (let i = 0; i < N; i++) {
                const v = dj[i];
                if (!a) { o[i] += v; continue; }
                const thr = k0 * lookup(row, pl, i) * (rho ? rho[i] : 1);
                const m = Math.abs(v) - thr, soft = m > 0 ? (v < 0 ? -m : m) : 0;
                o[i] += v + a * (soft - v);
            }
        }
        res.push(o);
    }
    const out = blank(w, h), o = out.data, removed = p.output === "removed";
    for (let i = 0; i < N; i++) {
        o[i * 4 + 3] = s[i * 4 + 3];
        for (let c = 0; c < 3; c++) o[i * 4 + c] = removed ? s[i * 4 + c] - res[c][i] : res[c][i];
    }
    return out;
}

/** Scatter: each pixel takes the normalised grain of another place - jittered cells of `cs` pixels, each cell (the
 *  nearest jittered centre) its own random offset - so the plate's grain is reused without its picture. */
function scatterField(src, w, h, cs, frame, seed) {
    const G = src.G, n = w * h, out = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
        let best = Infinity, bx = 0, by = 0;
        for (let b = cy - 1; b <= cy + 1; b++) for (let a = cx - 1; a <= cx + 1; a++) {
            const px = (a + hash01(a, b, 10, frame, seed)) * cs, py = (b + hash01(a, b, 11, frame, seed)) * cs;
            const dd = (px - x) * (px - x) + (py - y) * (py - y);
            if (dd < best) { best = dd; bx = a; by = b; }
        }
        // The cell's offset; one that lands on an edge of the plate tries the cell's next one (up to 4).
        let j = 0;
        for (let t = 0; t < 4; t++) {
            const ox = Math.floor(hash01(bx, by, 12 + 2 * t, frame, seed) * w), oy = Math.floor(hash01(bx, by, 13 + 2 * t, frame, seed) * h);
            j = ((y + oy) % h) * w + ((x + ox) % w);
            if (src.ok[j]) break;
        }
        const i = y * w + x;
        out[0][i] = G[0][j]; out[1][i] = G[1][j]; out[2][i] = G[2][j];
    }
    return out;
}
/** Where scatter may take grain from: the normalised grain held to +-4, and a flag per pixel that is off on the
 *  plate's edges (where the degrain left some of the picture in it), so no edge is carried into a new area. */
function scatterSource(Nrm, guide, w, h) {
    const n = w * h, gm = new Float64Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, l = x > 0 ? i - 1 : i, r = x < w - 1 ? i + 1 : i, u = y > 0 ? i - w : i, d = y < h - 1 ? i + w : i;
        gm[i] = Math.abs(guide[r] - guide[l]) + Math.abs(guide[d] - guide[u]);
    }
    const idx = sampleIndex(w, h, GRAIN_LEVELS), lim = 2 * EDGE * median(Float64Array.from(idx, (i) => gm[i]));
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) ok[i] = gm[i] <= lim ? 1 : 0;
    return { G: Nrm.map((a) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = a[i] < -4 ? -4 : a[i] > 4 ? 4 : a[i]; return o; }), ok };
}
/**
 * Regrain: the plate's grain (plate - degrained) divided by its strength at the degrained plate's brightness,
 * then times the strength at the comp's brightness, added to the comp. Where the comp is new - the `newMask`
 * input's alpha, or (detect) where the comp differs from the degrained plate by more than `threshold` - the
 * grain is made again: scattered from the plate's own, or synthesised from the profile, or (plate) left as it is.
 * comp / plate / degrained / newMask conformed to the comp's size; plate or degrained null: synth everywhere.
 */
export function regrainImage(comp, plate, degr, newMask, n, p, frame, scale) {
    const w = comp.w, h = comp.h, N = w * h, s = comp.data;
    const fr = p.animated === "off" ? 0 : Math.round(frame), seed = Math.round(p.seed || 0);
    const Cp = rgbPlanes(comp), Cg = guideLuma(Cp, w, h);
    const have = !!(plate && degr);
    let q, G = null, Dg = null, m;
    if (have) {
        const P = rgbPlanes(plate), D = rgbPlanes(degr);
        G = [0, 1, 2].map((c) => { const o = new Float64Array(N); for (let i = 0; i < N; i++) o[i] = P[c][i] - D[c][i]; return o; });
        Dg = guideLuma(D, w, h);
        q = profileFor(n, G, Dg, w, h, scale);
    } else if (isProfile(n.profile)) q = profileAt(n.profile, scale);
    else return comp;
    const plC = binPlaces(Cg, q);
    // Where the grain is new.
    m = new Float64Array(N);
    if (!have) m.fill(1);
    else {
        if (newMask) { const k = newMask.data; for (let i = 0; i < N; i++) m[i] = clamp01(k[i * 4 + 3]); }
        if (p.detect === "on") {
            const thr = p.threshold, soft = p.softness;
            for (let i = 0; i < N; i++) {
                const d = Math.abs(Cg[i] - Dg[i]);
                const v = soft > 0 ? clamp01((d - thr) / soft) : d > thr ? 1 : 0;
                if (v > m[i]) m[i] = v;
            }
        }
    }
    // The grain at unit strength.
    let Nrm = null;
    if (have) {
        const plD = binPlaces(Dg, q);
        Nrm = [0, 1, 2].map((c) => {
            const o = new Float64Array(N);
            for (let i = 0; i < N; i++) { const sg = lookup(q.total[c], plD, i); o[i] = sg > 1e-9 ? G[c][i] / sg : 0; }
            return o;
        });
    }
    let F = null;
    if (!have || p.fill === "synth") F = synthField(q, w, h, fr, seed);
    else if (p.fill === "scatter") F = scatterField(scatterSource(Nrm, Dg, w, h), w, h, Math.max(4, p.cell * scale), fr, seed);
    const out = blank(w, h), o = out.data, mode = p.output;
    for (let i = 0; i < N; i++) {
        const a = s[i * 4 + 3], mm = F ? m[i] : 0;
        for (let c = 0; c < 3; c++) {
            const u = (Nrm ? Nrm[c][i] * (1 - mm) : 0) + (F ? F[c][i] * mm : 0);
            const g = p.amount * u * lookup(q.total[c], plC, i);
            const r = s[i * 4 + c] + a * g;
            o[i * 4 + c] = mode === "grain" ? g : mode === "new areas" ? m[i] : mode === "difference" ? (have ? r - plate.data[i * 4 + c] : g) : r;
        }
        o[i * 4 + 3] = mode === "result" ? a : 1;
    }
    return out;
}
/** The noise and guide Analyse measures for a node, from its inputs' pictures (the server does this at full size). */
export function analyseInputs(type, pics) {
    const [a, b] = pics;
    if (type === "regrain") {
        if (!a || !b) return null;
        const P = rgbPlanes(a), D = rgbPlanes(b), N = a.w * a.h;
        const G = [0, 1, 2].map((c) => { const o = new Float64Array(N); for (let i = 0; i < N; i++) o[i] = P[c][i] - D[c][i]; return o; });
        return { noise: G, guide: guideLuma(D, a.w, a.h), w: a.w, h: a.h };
    }
    if (!a) return null;
    const P = rgbPlanes(a);
    return { noise: P, guide: guideLuma(P, a.w, a.h), w: a.w, h: a.h };
}
