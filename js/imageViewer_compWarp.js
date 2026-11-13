// imageViewer_compWarp.js
// Comp: the nodes that move pixels by a map - CornerPin, STMap, VectorWarp, LensDistortion, GridWarp - and the
// arithmetic the trackers render with (a point's place at a frame, the motion between two frames).
//
// Plain ES module, imports nothing; imageViewer_compModel.js calls it from renderNode. The numpy twin is
// src/comp_warp.py, kept float for float (tests/test_comp_parity.py): the same order of operations, float64
// throughout, the same fixed iteration counts. Written from the textbook maths (a projective map from four point
// pairs, Brown's radial lens model, a thin-plate spline, a least-squares similarity), nothing taken from another
// program.
//
// Coordinates are pixels of the picture, y down, a pixel's centre at i + 0.5 - as every number in Comp. A map
// gives, for each output pixel centre, the place in the source it reads; sampling is resample()'s: bilinear at
// pixel centres, transparent outside.

const blank = (w, h) => ({ w, h, data: new Float32Array(w * h * 4) });

/** The source read at U[i], V[i] (pixel coordinates, centres at +0.5) for each output pixel i of w x h. NaN = nothing. */
export function sampleMap(src, U, V, w, h) {
    const out = blank(w, h), o = out.data, s = src.data, sw = src.w, sh = src.h;
    for (let i = 0; i < w * h; i++) {
        const u = U[i] - 0.5, v = V[i] - 0.5;
        if (!(u === u) || !(v === v)) continue;   // NaN
        const x0 = Math.floor(u), y0 = Math.floor(v);
        if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) continue;
        const fx = u - x0, fy = v - y0, oi = i * 4;
        for (let j = 0; j < 4; j++) {
            const yy = y0 + (j >> 1), xx = x0 + (j & 1);
            if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
            const wgt = ((j & 1) ? fx : 1 - fx) * ((j >> 1) ? fy : 1 - fy);
            if (!wgt) continue;
            const si = (yy * sw + xx) * 4;
            o[oi] += s[si] * wgt; o[oi + 1] += s[si + 1] * wgt; o[oi + 2] += s[si + 2] * wgt; o[oi + 3] += s[si + 3] * wgt;
        }
    }
    return out;
}

/** The map as a picture instead: rgba = (u, v, 0, 1) with u = x / sw across, v = 1 - y / sh up (an ST map). */
export function mapAsSt(U, V, w, h, sw, sh) {
    const out = blank(w, h), o = out.data;
    for (let i = 0; i < w * h; i++) {
        if (!(U[i] === U[i]) || !(V[i] === V[i])) continue;
        o[i * 4] = U[i] / sw; o[i * 4 + 1] = 1 - V[i] / sh; o[i * 4 + 3] = 1;
    }
    return out;
}

// ── a projective map from four point pairs ───────────────────────────────────

/**
 * The 3 x 3 map (row major, h[8] = 1) taking the four points `from` to the four points `to` ([[x, y] x 4]), or
 * null when they do not make one (three on a line). Gaussian elimination with partial pivoting on the 8 x 8.
 */
export function homography(from, to) {
    const A = [], b = [];
    for (let k = 0; k < 4; k++) {
        const x = from[k][0], y = from[k][1], X = to[k][0], Y = to[k][1];
        A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
        A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    const h = solve(A, b);
    return h ? [...h, 1] : null;
}

/** A x = b for a small square A (arrays, changed in place); null when singular. */
export function solve(A, b) {
    const n = b.length;
    let scale = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(A[i][j]));
    const tiny = (scale || 1) * 1e-12;
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) <= tiny) return null;
        if (p !== c) { const t = A[p]; A[p] = A[c]; A[c] = t; const u = b[p]; b[p] = b[c]; b[c] = u; }
        for (let r = c + 1; r < n; r++) {
            const f = A[r][c] / A[c][c];
            if (!f) continue;
            for (let j = c; j < n; j++) A[r][j] -= f * A[c][j];
            b[r] -= f * b[c];
        }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = b[r];
        for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
        x[r] = s / A[r][r];
    }
    return x;
}

/** Point (x, y) through the 3 x 3 map; null behind it (w <= 0). */
export function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    if (!(w > 1e-12)) return null;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** The map ``Hs`` (output -> source, in pixels of the comp) for every output pixel of w x h at ``scale``. */
export function homographyMap(Hs, w, h, scale) {
    const U = new Float64Array(w * h), V = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        const py = (y + 0.5) / scale;
        for (let x = 0; x < w; x++) {
            const px = (x + 0.5) / scale, i = y * w + x;
            const q = Hs[6] * px + Hs[7] * py + Hs[8];
            if (!(q > 1e-12)) { U[i] = NaN; V[i] = NaN; continue; }
            U[i] = ((Hs[0] * px + Hs[1] * py + Hs[2]) / q) * scale;
            V[i] = ((Hs[3] * px + Hs[4] * py + Hs[5]) / q) * scale;
        }
    }
    return [U, V];
}

/** The picture through a map that takes source points to output points: each output pixel reads ``inv`` of it. */
export function homographyImage(src, inv, scale) {
    if (!inv) return blank(src.w, src.h);
    const [U, V] = homographyMap(inv, src.w, src.h, scale);
    return sampleMap(src, U, V, src.w, src.h);
}

/** A CornerPin's corners, in pixels of its input (fmt): 1 bottom left, 2 bottom right, 3 top right, 4 top left. */
export function pinCorners(get, fmt) {
    const W = fmt.width, H = fmt.height;
    const def = [[0, H], [W, H], [W, 0], [0, 0]];
    const from = [1, 2, 3, 4].map((k, i) => get(`from${k}`) || def[i]);
    const to = [1, 2, 3, 4].map((k, i) => get(`to${k}`) || from[i]);
    return { from, to };
}

// ── ST map and vectors ───────────────────────────────────────────────────────

/** An ST map (u across, v up, 0..1 over the source) read as a map: w x h of the map's own picture. */
export function stMap(us, vs, w, h, sw, sh) {
    const U = new Float64Array(w * h), V = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) { U[i] = us[i] * sw; V[i] = (1 - vs[i]) * sh; }
    return [U, V];
}

/** Each pixel read from where its vector points: x + amount * u * scale (the vectors are in pixels of the comp). */
export function vectorMap(us, vs, w, h, amount, scale) {
    const U = new Float64Array(w * h), V = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        U[i] = x + 0.5 + amount * us[i] * scale; V[i] = y + 0.5 + amount * vs[i] * scale;
    }
    return [U, V];
}

// ── lens distortion ──────────────────────────────────────────────────────────

export const LENS_MODES = ["undistort", "redistort"];
export const LENS_OUTPUTS = ["image", "stmap"];
const NEWTON = 12;

/** The distorted radius of an undistorted one: r (1 + k1 r^2 + k2 r^4), r a share of half the diagonal. */
export function distortR(r, k1, k2) { const r2 = r * r; return r * (1 + k1 * r2 + k2 * r2 * r2); }
/** The undistorted radius of a distorted one: Newton's method, a fixed number of steps (the twin does the same). */
export function undistortR(rd, k1, k2) {
    let r = rd;
    for (let i = 0; i < NEWTON; i++) {
        const r2 = r * r, f = r * (1 + k1 * r2 + k2 * r2 * r2) - rd, d = 1 + 3 * k1 * r2 + 5 * k2 * r2 * r2;
        if (Math.abs(d) < 1e-9) break;
        r -= f / d;
    }
    return r;
}

/** Where a point of the picture (w x h pixels, centre cx, cy) lands: "distort" an undistorted point, else the other way. */
export function lensPoint(x, y, how, k1, k2, cx, cy, R) {
    const dx = (x - cx) / R, dy = (y - cy) / R, r = Math.sqrt(dx * dx + dy * dy);
    if (r < 1e-12) return [x, y];
    const q = how === "distort" ? distortR(r, k1, k2) / r : undistortR(r, k1, k2) / r;
    return [cx + dx * q * R, cy + dy * q * R];
}

/**
 * The lens map for an output of w x h (the input's size; all numbers in its pixels times ``scale``). Undistort: the
 * output is the straightened picture, each pixel read where the lens put it. Redistort: the other way, for putting a
 * straightened comp back into the plate. ``zoom`` scales the result about the centre (above 1 hides the edges).
 */
export function lensMap(w, h, p, scale) {
    const U = new Float64Array(w * h), V = new Float64Array(w * h);
    const c = p.center, cx = (c ? c[0] : w / scale / 2) * scale, cy = (c ? c[1] : h / scale / 2) * scale;
    const R = Math.sqrt(w * w + h * h) / 2, zoom = p.zoom || 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, ox = x + 0.5, oy = y + 0.5;
        let q;
        if (p.mode === "redistort") {
            q = lensPoint(ox, oy, "undistort", p.k1, p.k2, cx, cy, R);
            q = [cx + (q[0] - cx) * zoom, cy + (q[1] - cy) * zoom];
        } else q = lensPoint(cx + (ox - cx) / zoom, cy + (oy - cy) / zoom, "distort", p.k1, p.k2, cx, cy, R);
        U[i] = q[0]; V[i] = q[1];
    }
    return [U, V];
}

/**
 * k1 (and k2, given enough points) from lines that are straight in the world, drawn on the distorted picture
 * ([[ [x, y], ... ], ...], pixels of a w x h picture): the numbers that make them straightest once undistorted -
 * the sum, over the lines, of the smaller spread of their points across their own direction. Nelder-Mead from
 * (0, 0), a fixed number of steps. Returns {k1, k2, error (mean distance from straight, pixels), points}.
 */
export function solveLens(lines, w, h, center = null, { k2: useK2 = null } = {}) {
    const ls = (lines || []).filter((l) => Array.isArray(l) && l.length >= 3);
    const points = ls.reduce((s, l) => s + l.length, 0);
    if (!ls.length) return { k1: 0, k2: 0, error: null, points };
    const cx = center ? center[0] : w / 2, cy = center ? center[1] : h / 2, R = Math.sqrt(w * w + h * h) / 2;
    const two = useK2 === null ? points >= 12 && ls.length >= 2 : !!useK2;
    const cost = (k1, k2) => {
        let s = 0;
        for (const l of ls) {
            const u = l.map((pt) => lensPoint(pt[0], pt[1], "undistort", k1, k2, cx, cy, R));
            s += lineSpread(u);
        }
        return s;
    };
    const f = (v) => cost(v[0], two ? v[1] : 0);
    let simplex = two ? [[0, 0], [0.05, 0], [0, 0.05]] : [[0], [0.05]];
    let vals = simplex.map(f);
    for (let it = 0; it < 400; it++) {
        const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
        simplex = order.map((i) => simplex[i]); vals = order.map((i) => vals[i]);
        const n = simplex.length - 1, best = simplex[0], worst = simplex[n];
        if (Math.abs(vals[n] - vals[0]) < 1e-14 && it > 20) break;
        const cen = best.map((_, k) => simplex.slice(0, n).reduce((s, v) => s + v[k], 0) / n);
        const at = (t) => cen.map((c, k) => c + t * (worst[k] - c));
        const xr = at(-1), fr = f(xr);
        if (fr < vals[0]) { const xe = at(-2), fe = f(xe); if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; } continue; }
        if (fr < vals[n - 1]) { simplex[n] = xr; vals[n] = fr; continue; }
        const xc = fr < vals[n] ? at(-0.5) : at(0.5), fc = f(xc);
        if (fc < Math.min(fr, vals[n])) { simplex[n] = xc; vals[n] = fc; continue; }
        for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, k) => best[k] + 0.5 * (v - best[k])); vals[i] = f(simplex[i]); }
    }
    const v = simplex[0];
    return { k1: v[0], k2: two ? v[1] : 0, error: Math.sqrt(vals[0] / points), points };
}

/** The squared distances of points from their own best line, summed (the smaller eigenvalue of their scatter). */
export function lineSpread(pts) {
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    return Math.max(0, tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det)));
}

// ── grid warp (a thin-plate spline through the lattice's points) ─────────────

/** A regular lattice of cols x rows points over a w x h picture: a flat [x0, y0, x1, y1, ...], rows top first. */
export function lattice(cols, rows, w, h) {
    const out = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.push((i / (cols - 1)) * w, (j / (rows - 1)) * h);
    return out;
}

/**
 * Each output pixel reads source p + d(p), where d is the thin-plate spline through the lattice that takes the
 * destination points ``dst`` to the source ``src`` (flat [x, y, ...], pixels of the comp). w x h output at ``scale``.
 */
export function gridMap(src, dst, w, h, scale) {
    const n = Math.min(src.length, dst.length) >> 1;
    const U = new Float64Array(w * h), V = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { U[y * w + x] = x + 0.5; V[y * w + x] = y + 0.5; }
    let moved = false;
    for (let k = 0; k < 2 * n; k++) if (src[k] !== dst[k]) { moved = true; break; }
    if (!n || !moved) return [U, V];
    const L = Math.max(w, h) / scale;   // coordinates as a share of the picture: a well-conditioned system
    const qx = [], qy = [], dx = [], dy = [];
    for (let k = 0; k < n; k++) {
        qx.push(dst[2 * k] / L); qy.push(dst[2 * k + 1] / L);
        dx.push((src[2 * k] - dst[2 * k]) / L); dy.push((src[2 * k + 1] - dst[2 * k + 1]) / L);
    }
    const coef = tpsSolve(qx, qy, dx, dy);
    if (!coef) return [U, V];
    const { wx, wy } = coef;
    for (let y = 0; y < h; y++) {
        const py = (y + 0.5) / scale / L;
        for (let x = 0; x < w; x++) {
            const px = (x + 0.5) / scale / L, i = y * w + x;
            let sx = wx[n] + wx[n + 1] * px + wx[n + 2] * py, sy = wy[n] + wy[n + 1] * px + wy[n + 2] * py;
            for (let k = 0; k < n; k++) {
                const ex = px - qx[k], ey = py - qy[k], r2 = ex * ex + ey * ey;
                if (r2 > 0) { const phi = 0.5 * r2 * Math.log(r2); sx += wx[k] * phi; sy += wy[k] * phi; }
            }
            U[i] += sx * L * scale; V[i] += sy * L * scale;
        }
    }
    return [U, V];
}

/** The thin-plate spline's weights for values dx, dy at points (qx, qy): {wx, wy}, n kernel weights then a, bx, by. */
export function tpsSolve(qx, qy, dx, dy) {
    const n = qx.length, m = n + 3;
    const K = () => {
        const A = [];
        for (let i = 0; i < m; i++) A.push(new Array(m).fill(0));
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const ex = qx[i] - qx[j], ey = qy[i] - qy[j], r2 = ex * ex + ey * ey;
                A[i][j] = r2 > 0 ? 0.5 * r2 * Math.log(r2) : 0;
            }
            A[i][n] = 1; A[i][n + 1] = qx[i]; A[i][n + 2] = qy[i];
            A[n][i] = 1; A[n + 1][i] = qx[i]; A[n + 2][i] = qy[i];
        }
        return A;
    };
    const wx = solve(K(), [...dx, 0, 0, 0]), wy = solve(K(), [...dy, 0, 0, 0]);
    return wx && wy ? { wx, wy } : null;
}

// ── trackers ─────────────────────────────────────────────────────────────────

export const TRACK_MOTIONS = ["translate", "rotate", "scale", "perspective"];
export const TRACK_TRANSFORMS = ["none", "stabilise", "match-move"];

/** A tracked point's place at frame f from its keys [[f, x, y, confidence], ...] (sorted): the key, a straight line
 *  between two, the nearest end outside them; null without keys. */
export function trackAt(keys, f) {
    if (!Array.isArray(keys) || !keys.length) return null;
    if (f <= keys[0][0]) return [keys[0][1], keys[0][2]];
    const last = keys[keys.length - 1];
    if (f >= last[0]) return [last[1], last[2]];
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1][0] <= f) i++;
    const a = keys[i], b = keys[i + 1];
    if (a[0] === f) return [a[1], a[2]];
    const t = (f - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Whether a point has a key at frame f (no reaching across: a point only counts where it was tracked or placed). */
export function trackHas(keys, f) {
    if (!Array.isArray(keys) || !keys.length) return false;
    return f >= keys[0][0] && f <= keys[keys.length - 1][0];
}

/** The points of a Tracker's data that are on and known at both frames: {P: [[x, y]] at ref, Q: at f}. */
export function trackPairs(data, ref, f) {
    const P = [], Q = [];
    for (const pt of (data && data.points) || []) {
        if (pt.on === false || !trackHas(pt.keys, ref) || !trackHas(pt.keys, f)) continue;
        P.push(trackAt(pt.keys, ref)); Q.push(trackAt(pt.keys, f));
    }
    return { P, Q };
}

/**
 * The motion from the points at the reference frame (P) to the points now (Q): {kind: "affine", m} (pixels of the
 * comp, Motion's [a, b, c, d, e, f]) with what it is made of (t, angle in degrees, s, cP, cQ), or {kind:
 * "perspective", H} for four points and "perspective". One point: a move; two or more: a least-squares move, turn
 * and even scale (what ``motion`` allows).
 */
export function solveMotion(P, Q, motion = "translate") {
    const n = Math.min(P.length, Q.length);
    if (!n) return null;
    if (motion === "perspective" && n >= 4) {
        const H = homography(P.slice(0, 4), Q.slice(0, 4));
        if (H) return { kind: "perspective", H };
    }
    let px = 0, py = 0, qx = 0, qy = 0;
    for (let i = 0; i < n; i++) { px += P[i][0]; py += P[i][1]; qx += Q[i][0]; qy += Q[i][1]; }
    px /= n; py /= n; qx /= n; qy /= n;
    let a = 0, b = 0, pp = 0;
    for (let i = 0; i < n; i++) {
        const ux = P[i][0] - px, uy = P[i][1] - py, vx = Q[i][0] - qx, vy = Q[i][1] - qy;
        a += ux * vx + uy * vy; b += ux * vy - uy * vx; pp += ux * ux + uy * uy;
    }
    const turn = n >= 2 && motion !== "translate" && pp > 1e-9;
    const angle = turn ? Math.atan2(b, a) : 0;
    const s = n >= 2 && (motion === "scale" || motion === "perspective") && pp > 1e-9
        ? (turn ? Math.sqrt(a * a + b * b) : a) / pp : 1;
    const c = Math.cos(angle), sn = Math.sin(angle);
    // T(cQ) R S T(-cP)
    const m = [c * s, sn * s, -sn * s, c * s, 0, 0];
    m[4] = qx - (m[0] * px + m[2] * py); m[5] = qy - (m[1] * px + m[3] * py);
    return { kind: "affine", m, angle: (angle * 180) / Math.PI, s, cP: [px, py], cQ: [qx, qy] };
}

/** The motion inverted (stabilise): affine by its inverse, a projective map by swapping the point sets. */
export function invertAffine(m) {
    const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** A planar track's corners at frame f: its keys [[f, x1, y1, ... x4, y4], ...] read like trackAt. */
export function quadAt(keys, f) {
    if (!Array.isArray(keys) || !keys.length) return null;
    const pick = (k) => [[k[1], k[2]], [k[3], k[4]], [k[5], k[6]], [k[7], k[8]]];
    if (f <= keys[0][0]) return pick(keys[0]);
    const last = keys[keys.length - 1];
    if (f >= last[0]) return pick(last);
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1][0] <= f) i++;
    const a = keys[i], b = keys[i + 1];
    if (a[0] === f) return pick(a);
    const t = (f - a[0]) / (b[0] - a[0]);
    return pick(a.map((v, k) => (k ? v + (b[k] - v) * t : f)));
}

/** A key list with [f, ...values] put in (replacing one at f), kept sorted. */
export function putKey(keys, row) {
    const out = (keys || []).filter((k) => k[0] !== row[0]);
    out.push(row);
    out.sort((a, b) => a[0] - b[0]);
    return out;
}
