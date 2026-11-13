// imageViewer_scatterPaint.js
// A scatter's painted density, as data: a square grid over its terrain (u
// across X, v across Z, both 0..1 from the terrain's -X / -Z corner, as the
// terrain's own heights are laid out), one byte a cell, kept in the scene as
// base64 (`scatter.paint = {res, data}`). No paint (null) means the scatter
// grows anywhere its rules allow, as before; a painted scatter grows only
// where the paint is, as thick as the paint says.
//
// Pure: no DOM, no three.js, so it is tested under plain node
// (tests/test_scatter_paint.mjs). The brush in the view is
// imageViewer_scatterPaint3d.js.

export const PAINT_RES = 128;
export const PAINT_MIN_RES = 16;
export const PAINT_MAX_RES = 512;

// How many random numbers a painted scatter draws for every candidate spot,
// whether the spot is taken or not, so painting one place never moves what
// grows in another.
export const DRAWS_PER_SPOT = 9;

const b64encode = (bytes) => {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
};

const b64decode = (text) => {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
};

/** A stored paint held to its rules: `{res, data}` with res x res bytes, or null. */
export function cleanPaint(p) {
    if (!p || typeof p !== "object" || typeof p.data !== "string") return null;
    const res = Math.round(Number(p.res));
    if (!Number.isFinite(res) || res < PAINT_MIN_RES || res > PAINT_MAX_RES) return null;
    let bytes;
    try { bytes = b64decode(p.data); } catch (_) { return null; }
    if (bytes.length !== res * res) return null;
    return { res, data: p.data };
}

/** A new grid of `res` x `res` cells, all at `value` (0..1). */
export function emptyGrid(res = PAINT_RES, value = 0) {
    return { res, cells: new Float32Array(res * res).fill(Math.min(1, Math.max(0, value))) };
}

/** The working grid (floats 0..1) of a stored paint, or an empty one. */
export function decodePaint(p, res = PAINT_RES) {
    const c = cleanPaint(p);
    if (!c) return emptyGrid(res);
    const bytes = b64decode(c.data);
    const cells = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) cells[i] = bytes[i] / 255;
    return { res: c.res, cells };
}

/** A working grid back into what the scene keeps. */
export function encodePaint(grid) {
    const bytes = new Uint8Array(grid.cells.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, grid.cells[i])) * 255);
    return { res: grid.res, data: b64encode(bytes) };
}

/** The paint at u, v (0..1), read between the cells' middles. */
export function paintAt(grid, u, v) {
    const n = grid.res, c = grid.cells;
    const x = Math.min(n - 1, Math.max(0, u * n - 0.5)), y = Math.min(n - 1, Math.max(0, v * n - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    return (c[y0 * n + x0] * (1 - tx) + c[y0 * n + x1] * tx) * (1 - ty)
         + (c[y1 * n + x0] * (1 - tx) + c[y1 * n + x1] * tx) * ty;
}

/**
 * How much of the brush reaches a point `d` (0 at its middle, 1 at its rim):
 * full inside `hardness`, then a smooth fall to nothing at the rim.
 */
export function brushFalloff(d, hardness = 0.5) {
    if (d >= 1) return 0;
    const h = Math.min(0.99, Math.max(0, hardness));
    if (d <= h) return 1;
    const t = (d - h) / (1 - h);
    return 1 - t * t * (3 - 2 * t);
}

/**
 * One dab of the brush at u, v. `ru`, `rv`: its radius as shares of the
 * terrain's width and depth (a round brush on a terrain that is not square).
 * `strength` 0..1 is how far one dab goes toward full (painting) or empty
 * (`erase`). Changes `grid` in place; answers whether any cell changed.
 */
export function stampBrush(grid, u, v, ru, rv, { strength = 0.5, hardness = 0.5, erase = false } = {}) {
    const n = grid.res, c = grid.cells;
    if (!(ru > 0) || !(rv > 0)) return false;
    const x0 = Math.max(0, Math.floor((u - ru) * n)), x1 = Math.min(n - 1, Math.ceil((u + ru) * n));
    const y0 = Math.max(0, Math.floor((v - rv) * n)), y1 = Math.min(n - 1, Math.ceil((v + rv) * n));
    const k = Math.min(1, Math.max(0, strength));
    let changed = false;
    for (let y = y0; y <= y1; y++) {
        const dv = ((y + 0.5) / n - v) / rv;
        for (let x = x0; x <= x1; x++) {
            const du = ((x + 0.5) / n - u) / ru;
            const f = brushFalloff(Math.hypot(du, dv), hardness) * k;
            if (f <= 0) continue;
            const i = y * n + x, before = c[i];
            c[i] = erase ? before * (1 - f) : before + (1 - before) * f;
            if (c[i] !== before) changed = true;
        }
    }
    return changed;
}

/** Dabs along a stroke from (u0, v0) to (u1, v1), a quarter of the brush apart. */
export function strokeBrush(grid, u0, v0, u1, v1, ru, rv, opts = {}) {
    const steps = Math.max(1, Math.ceil(Math.hypot((u1 - u0) / ru, (v1 - v0) / rv) * 4));
    let changed = false;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (stampBrush(grid, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, ru, rv, opts)) changed = true;
    }
    return changed;
}

/** Share of the grid painted at all (above a 1/255 trace). */
export function paintedShare(grid) {
    let n = 0;
    for (const v of grid.cells) if (v > 1 / 255) n++;
    return n / grid.cells.length;
}

/**
 * The candidate spots of a painted scatter: `count` of them, spread evenly at
 * random over the whole terrain, each kept with the chance the paint gives
 * it. `rand` is the scatter's seeded generator; every candidate takes
 * DRAWS_PER_SPOT numbers from it, the spare ones handed out with the spot
 * (`r`, 6 of them, for its size and turn), so a stroke in one place leaves every other
 * spot as it was. Answers [{u, v, weight, r: [6 numbers]}] of the kept ones.
 */
export function paintedSpots(grid, count, rand) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const d = [];
        for (let k = 0; k < DRAWS_PER_SPOT; k++) d.push(rand());
        const u = d[0] * 0.98 + 0.01, v = d[1] * 0.98 + 0.01;
        const w = paintAt(grid, u, v);
        if (w <= 0 || d[2] >= w) continue;
        out.push({ u, v, weight: w, r: d.slice(3) });
    }
    return out;
}
