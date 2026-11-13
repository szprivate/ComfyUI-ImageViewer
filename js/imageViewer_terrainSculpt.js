// imageViewer_terrainSculpt.js
// A terrain's hand edits, as data: what the terrain brushes write.
//
//   terrain.sculpt     {res, unit, data}  heights added to the terrain, in metres: res x res
//                      int16 values x `unit` metres, laid on the terrain's own vertex grid
//                      (u = X, v = Z, 0..1 from its -X / -Z corner, cell i at i / (res - 1)),
//                      little-endian, base64.
//   terrain.layerPaint {res, data}        the ground layers painted by hand: res x res cells of
//                      4 bytes (ground, rock, cliff, peak), cell i at (i + 0.5) / res, base64.
//                      Where the four add up to a, the layers are a x the paint and (1 - a) x
//                      what the rules (or the splat picture) say.
//
// Both are null on a terrain nobody has painted. Pure: no DOM, no three.js; tested under plain
// node (tests/test_terrain_sculpt.mjs). The brushes in the view are imageViewer_terrainBrush3d.js.

export const SCULPT_TOOLS = ["raise", "lower", "smooth", "flatten", "restore"];
export const LAYER_TOOL = "layer";
export const SCULPT_UNIT = 0.01;           // metres per step of an int16: +-327 m
export const SCULPT_MAX_RES = 513;
export const LAYER_RES = 128;

const toB64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
};
const fromB64 = (text) => {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
};

// ── Sculpt ───────────────────────────────────────────────────────────────

/** A stored sculpt held to its rules, or null. */
export function cleanSculpt(p) {
    if (!p || typeof p !== "object" || typeof p.data !== "string") return null;
    const res = Math.round(Number(p.res));
    const unit = Number(p.unit ?? SCULPT_UNIT);
    if (!Number.isFinite(res) || res < 2 || res > SCULPT_MAX_RES || !(unit > 0) || unit > 10) return null;
    let bytes;
    try { bytes = fromB64(p.data); } catch (_) { return null; }
    if (bytes.length !== res * res * 2) return null;
    return { res, unit, data: p.data };
}

/** A sculpt's offsets in metres, {res, cells}; with `res`, resampled onto that grid. Null in, zeros out. */
export function decodeSculpt(p, res = null) {
    const c = cleanSculpt(p);
    if (!c) return { res: res || 2, cells: new Float32Array((res || 2) ** 2) };
    const bytes = fromB64(c.data);
    const view = new DataView(bytes.buffer);
    const cells = new Float32Array(c.res * c.res);
    for (let i = 0; i < cells.length; i++) cells[i] = view.getInt16(i * 2, true) * c.unit;
    const g = { res: c.res, cells };
    return res && res !== c.res ? resampleVertexGrid(g, res) : g;
}

export function encodeSculpt(grid, unit = SCULPT_UNIT) {
    const bytes = new Uint8Array(grid.cells.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < grid.cells.length; i++) {
        view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(grid.cells[i] / unit))), true);
    }
    return { res: grid.res, unit, data: toB64(bytes) };
}

/** Whether a sculpt grid changes anything (by more than half a unit). */
export function sculptEmpty(grid, unit = SCULPT_UNIT) {
    for (const v of grid.cells) if (Math.abs(v) >= unit / 2) return false;
    return true;
}

/** The value of a vertex-aligned grid at u, v (0..1). */
export function vertexAt(grid, u, v) {
    const n = grid.res, c = grid.cells;
    const x = Math.min(n - 1, Math.max(0, u * (n - 1))), y = Math.min(n - 1, Math.max(0, v * (n - 1)));
    const x0 = Math.min(n - 2, Math.floor(x)), y0 = Math.min(n - 2, Math.floor(y));
    const tx = x - x0, ty = y - y0;
    return (c[y0 * n + x0] * (1 - tx) + c[y0 * n + x0 + 1] * tx) * (1 - ty)
         + (c[(y0 + 1) * n + x0] * (1 - tx) + c[(y0 + 1) * n + x0 + 1] * tx) * ty;
}

/** A vertex-aligned grid onto another resolution (the terrain's segments changed). */
export function resampleVertexGrid(grid, res) {
    const cells = new Float32Array(res * res);
    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) cells[y * res + x] = vertexAt(grid, x / (res - 1), y / (res - 1));
    }
    return { res, cells };
}

/** How much of a brush reaches distance d (0 middle, 1 rim). */
export function falloff(d, hardness = 0.5) {
    if (d >= 1) return 0;
    const h = Math.min(0.99, Math.max(0, hardness));
    if (d <= h) return 1;
    const t = (d - h) / (1 - h);
    return 1 - t * t * (3 - 2 * t);
}

/**
 * One dab of a sculpt tool on `grid` (offsets in metres, vertex-aligned), at u, v, radius ru / rv
 * as shares of the terrain's width / depth. `base` is the terrain without the sculpt, in metres,
 * same grid (smooth and flatten work on the whole height). `amount` is metres for raise / lower;
 * for the others `strength` 0..1 is the share of the way it goes in one dab. `to` is flatten's
 * height in metres. Changes `grid`; answers the cell box it touched [x0, y0, x1, y1], or null.
 */
export function sculptDab(grid, base, u, v, ru, rv, { tool = "raise", amount = 0.5, strength = 0.5,
                                                          hardness = 0.5, to = 0 } = {}) {
    const n = grid.res, c = grid.cells;
    if (!(ru > 0) || !(rv > 0) || !SCULPT_TOOLS.includes(tool)) return null;
    const x0 = Math.max(0, Math.floor((u - ru) * (n - 1))), x1 = Math.min(n - 1, Math.ceil((u + ru) * (n - 1)));
    const y0 = Math.max(0, Math.floor((v - rv) * (n - 1))), y1 = Math.min(n - 1, Math.ceil((v + rv) * (n - 1)));
    if (x0 > x1 || y0 > y1) return null;
    const k = Math.min(1, Math.max(0, strength));
    const total = (i) => base[i] + c[i];
    // Smooth reads the heights as they were before this dab, so it does not run across.
    let before = null;
    if (tool === "smooth") {
        before = new Float32Array((x1 - x0 + 3) * (y1 - y0 + 3));
        const w = x1 - x0 + 3;
        for (let y = y0 - 1; y <= y1 + 1; y++) {
            for (let x = x0 - 1; x <= x1 + 1; x++) {
                const cx = Math.min(n - 1, Math.max(0, x)), cy = Math.min(n - 1, Math.max(0, y));
                before[(y - y0 + 1) * w + (x - x0 + 1)] = total(cy * n + cx);
            }
        }
    }
    for (let y = y0; y <= y1; y++) {
        const dv = (y / (n - 1) - v) / rv;
        for (let x = x0; x <= x1; x++) {
            const du = (x / (n - 1) - u) / ru;
            const f = falloff(Math.hypot(du, dv), hardness);
            if (f <= 0) continue;
            const i = y * n + x;
            if (tool === "raise") c[i] += amount * f;
            else if (tool === "lower") c[i] -= amount * f;
            else if (tool === "restore") c[i] *= 1 - f * k;
            else if (tool === "flatten") c[i] += (to - total(i)) * f * k;
            else if (tool === "smooth") {
                const w = x1 - x0 + 3, bx = x - x0 + 1, by = y - y0 + 1;
                let s = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += before[(by + dy) * w + bx + dx];
                c[i] += (s / 9 - before[by * w + bx]) * f * k;
            }
        }
    }
    return [x0, y0, x1, y1];
}

// ── Layer paint ──────────────────────────────────────────────────────────

export function cleanLayerPaint(p) {
    if (!p || typeof p !== "object" || typeof p.data !== "string") return null;
    const res = Math.round(Number(p.res));
    if (!Number.isFinite(res) || res < 8 || res > 512) return null;
    let bytes;
    try { bytes = fromB64(p.data); } catch (_) { return null; }
    if (bytes.length !== res * res * 4) return null;
    return { res, data: p.data };
}

export function decodeLayerPaint(p, res = LAYER_RES) {
    const c = cleanLayerPaint(p);
    if (!c) return { res, cells: new Float32Array(res * res * 4) };
    const bytes = fromB64(c.data);
    const cells = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) cells[i] = bytes[i] / 255;
    return { res: c.res, cells };
}

export function encodeLayerPaint(grid) {
    const bytes = new Uint8Array(grid.cells.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, grid.cells[i])) * 255);
    return { res: grid.res, data: toB64(bytes) };
}

/** The four painted weights at u, v (read between the cells' middles). */
export function layerAt(grid, u, v, out = [0, 0, 0, 0]) {
    const n = grid.res, c = grid.cells;
    const x = Math.min(n - 1, Math.max(0, u * n - 0.5)), y = Math.min(n - 1, Math.max(0, v * n - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    for (let k = 0; k < 4; k++) {
        out[k] = (c[(y0 * n + x0) * 4 + k] * (1 - tx) + c[(y0 * n + x1) * 4 + k] * tx) * (1 - ty)
               + (c[(y1 * n + x0) * 4 + k] * (1 - tx) + c[(y1 * n + x1) * 4 + k] * tx) * ty;
    }
    return out;
}

/** The layers shown: the rules' weights `rule` (4, any scale) mixed with the paint's `p` (4). */
export function mixLayers(rule, p, out = [0, 0, 0, 0]) {
    const a = Math.min(1, p[0] + p[1] + p[2] + p[3]);
    const rs = rule[0] + rule[1] + rule[2] + rule[3] || 1;
    for (let k = 0; k < 4; k++) out[k] = (rule[k] / rs) * (1 - a) + p[k];
    return out;
}

/**
 * One dab of the layer brush: layer `layer` (0 ground, 1 rock, 2 cliff, 3 peak) goes toward
 * full and the others give way, so the four never add up past 1; `erase` takes all paint away
 * (back to the rules). Answers whether anything changed.
 */
export function layerDab(grid, u, v, ru, rv, { layer = 0, strength = 0.5, hardness = 0.5, erase = false } = {}) {
    const n = grid.res, c = grid.cells;
    if (!(ru > 0) || !(rv > 0)) return false;
    const x0 = Math.max(0, Math.floor((u - ru) * n)), x1 = Math.min(n - 1, Math.ceil((u + ru) * n));
    const y0 = Math.max(0, Math.floor((v - rv) * n)), y1 = Math.min(n - 1, Math.ceil((v + rv) * n));
    const k = Math.min(1, Math.max(0, strength));
    let changed = false;
    for (let y = y0; y <= y1; y++) {
        const dv = ((y + 0.5) / n - v) / rv;
        for (let x = x0; x <= x1; x++) {
            const f = falloff(Math.hypot(((x + 0.5) / n - u) / ru, dv), hardness) * k;
            if (f <= 0) continue;
            const i = (y * n + x) * 4;
            for (let q = 0; q < 4; q++) {
                const before = c[i + q];
                c[i + q] = erase || q !== layer ? before * (1 - f) : before + (1 - before) * f;
                if (c[i + q] !== before) changed = true;
            }
        }
    }
    return changed;
}

/** Whether a layer paint holds anything. */
export function layerPaintEmpty(grid) {
    for (const v of grid.cells) if (v > 0.5 / 255) return false;
    return true;
}
