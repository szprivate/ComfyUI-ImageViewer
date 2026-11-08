// imageViewer_paintData.js
// Paint's arithmetic, pure (no DOM): how layers are laid over each other, what an adjustment layer does
// to the picture under it, the filters, the selection's shapes, the brush and the bucket.
//
// ONE arithmetic, twice: paint_math.py does exactly this on the server (an export, the agent's
// edit_image, an .ora's merged image), in the same order and with the same rounding - floor(x * 255 + 0.5)
// after every layer - so the picture written is the picture the user saw. Change one, change the other;
// tests/test_paint_parity.py runs both on the same documents.
//
// Pictures are Uint8ClampedArray RGBA (straight, not premultiplied), w * h * 4; masks Uint8Array w * h.
// A document: { w, h, name, layers: [bottom .. top], active } - see cleanLayer for a layer.

import { cleanStyle, styleOn, styledCached } from "./imageViewer_paintStyle.js";
import { cleanFilters, smartLayer } from "./imageViewer_paintSmart.js";
import { cleanSmart } from "./imageViewer_paintSmartLayer.js";

export const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "add",
    "color_dodge", "color_burn", "soft_light", "hard_light"];
export const BLEND_LABELS = { normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay",
    darken: "Darken", lighten: "Lighten", difference: "Difference", add: "Add (Linear Dodge)",
    color_dodge: "Color Dodge", color_burn: "Color Burn", soft_light: "Soft Light", hard_light: "Hard Light" };
export const ADJUST_TYPES = ["levels", "curves", "brightness_contrast", "exposure", "hue_saturation", "grade", "invert",
    "threshold"];
export const ADJUST_LABELS = { levels: "Levels", curves: "Curves", brightness_contrast: "Brightness/Contrast",
    exposure: "Exposure", hue_saturation: "Hue/Saturation", grade: "Grade", invert: "Invert", threshold: "Threshold" };
export const ADJUST_DEFAULTS = {
    levels: { in_black: 0, in_white: 255, gamma: 1, out_black: 0, out_white: 255, r: null, g: null, b: null },
    curves: { rgb: [[0, 0], [255, 255]], r: null, g: null, b: null },
    brightness_contrast: { brightness: 0, contrast: 0 },
    exposure: { exposure: 0, offset: 0, gamma: 1 },
    hue_saturation: { hue: 0, saturation: 0, lightness: 0 },
    grade: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] },
    invert: {},
    threshold: { level: 128 },
};
/** The numbers of each adjustment as the Properties panel shows them: [key, label, min, max, step]. */
export const ADJUST_FIELDS = {
    levels: [["in_black", "Input black", 0, 254, 1], ["in_white", "Input white", 1, 255, 1], ["gamma", "Gamma", 0.1, 9.99, 0.01],
             ["out_black", "Output black", 0, 255, 1], ["out_white", "Output white", 0, 255, 1]],
    brightness_contrast: [["brightness", "Brightness", -100, 100, 1], ["contrast", "Contrast", -100, 100, 1]],
    exposure: [["exposure", "Exposure (stops)", -10, 10, 0.05], ["offset", "Offset", -0.5, 0.5, 0.005], ["gamma", "Gamma", 0.1, 9.99, 0.01]],
    hue_saturation: [["hue", "Hue", -180, 180, 1], ["saturation", "Saturation", -100, 100, 1], ["lightness", "Lightness", -100, 100, 1]],
    grade: [["lift", "Lift", -1, 1, 0.01], ["gamma", "Gamma", 0.1, 9.99, 0.01], ["gain", "Gain", 0, 4, 0.01]],
    threshold: [["level", "Level", 1, 255, 1]],
    invert: [],
    curves: [],
};
/** A group's blend: Pass Through (its layers lay straight onto what is under the group) or one of the modes
 * (its layers are laid together first, on nothing, and that picture is laid with the mode). */
export const GROUP_BLENDS = ["pass_through", ...BLEND_MODES];
BLEND_LABELS.pass_through = "Pass Through";
/** How deep groups go inside groups. */
export const MAX_DEPTH = 12;
export const MAX_SIDE = 16384;
export const MAX_LAYERS = 200;

// ── cleaning ────────────────────────────────────────────────────────────────

export function num(v, d, lo = null, hi = null) {
    let x = Number(v);
    if (v === null || v === undefined || v === "" || !Number.isFinite(x)) x = Number(d);
    if (lo !== null) x = Math.max(lo, x);
    if (hi !== null) x = Math.min(hi, x);
    return x;
}
const triple = (v, d, lo, hi) => {
    if (typeof v === "number") v = [v, v, v];
    if (!Array.isArray(v) || v.length !== 3) v = [d, d, d];
    return v.map((x) => num(x, d, lo, hi));
};
function points(v) {
    if (!Array.isArray(v)) return null;
    const pts = v.filter((p) => Array.isArray(p) && p.length === 2).map((p) => [num(p[0], 0, 0, 255), num(p[1], 0, 0, 255)]);
    pts.sort((a, b) => a[0] - b[0]);
    const clean = [];
    for (const p of pts) {
        if (clean.length && Math.abs(p[0] - clean[clean.length - 1][0]) < 1) clean[clean.length - 1] = p;
        else clean.push(p);
    }
    return clean.length >= 2 ? clean : null;
}

/** An adjustment's numbers held to their ranges (paint_math.clean_adjust). */
export function cleanAdjust(kind, params) {
    const p = params && typeof params === "object" ? params : {};
    switch (kind) {
        case "levels": {
            // The RGB levels, then (each null, or levels of its own) Red, Green and Blue after them.
            const lv = (q) => {
                const ib = num(q.in_black, 0, 0, 254);
                return { in_black: ib, in_white: num(q.in_white, 255, ib + 1, 255), gamma: num(q.gamma, 1, 0.1, 9.99),
                         out_black: num(q.out_black, 0, 0, 255), out_white: num(q.out_white, 255, 0, 255) };
            };
            const out = lv(p);
            for (const ch of ["r", "g", "b"]) out[ch] = p[ch] && typeof p[ch] === "object" ? lv(p[ch]) : null;
            return out;
        }
        case "curves": return { rgb: points(p.rgb) || [[0, 0], [255, 255]], r: points(p.r), g: points(p.g), b: points(p.b) };
        case "brightness_contrast": return { brightness: num(p.brightness, 0, -100, 100), contrast: num(p.contrast, 0, -100, 100) };
        case "exposure": return { exposure: num(p.exposure, 0, -10, 10), offset: num(p.offset, 0, -0.5, 0.5), gamma: num(p.gamma, 1, 0.1, 9.99) };
        case "hue_saturation": return { hue: num(p.hue, 0, -180, 180), saturation: num(p.saturation, 0, -100, 100), lightness: num(p.lightness, 0, -100, 100) };
        case "grade": return { lift: triple(p.lift, 0, -1, 1), gamma: triple(p.gamma, 1, 0.1, 9.99), gain: triple(p.gain, 1, 0, 4) };
        case "threshold": return { level: num(p.level, 128, 1, 255) };
        case "invert": return {};
    }
    throw new Error(`unknown adjustment ${kind}`);
}

let _idSeq = 0;
export function newId() {
    _idSeq = (_idSeq + 1) % 1e6;
    return "l" + Date.now().toString(36).slice(-6) + _idSeq.toString(36) + Math.random().toString(36).slice(2, 5);
}

export const TEXT_DEFAULT = { text: "", font: "sans-serif", size: 48, color: "#ffffff", bold: false, italic: false, align: "left" };
export function cleanText(t) {
    t = t || {};
    return { text: String(t.text || "").slice(0, 4000), font: String(t.font || "sans-serif").slice(0, 80),
             size: num(t.size, 48, 4, 2000), color: /^#[0-9a-fA-F]{6}$/.test(String(t.color || "")) ? t.color : "#ffffff",
             bold: !!t.bold, italic: !!t.italic, align: ["left", "center", "right"].includes(t.align) ? t.align : "left" };
}

/** A layer's description held to what it may be (paint_io.clean_layer). */
export function cleanLayer(L) {
    const kind = L.kind === "adjust" ? "adjust" : L.kind === "group" ? "group" : "pixel";
    const out = { id: String(L.id || newId()).slice(0, 40), name: String(L.name || (kind === "group" ? "Group" : "Layer")).slice(0, 120), kind,
                  visible: L.visible !== false, opacity: num(L.opacity, 1, 0, 1),
                  blend: BLEND_MODES.includes(L.blend) ? L.blend : "normal", locked: !!L.locked };
    if (L.parent) out.parent = String(L.parent).slice(0, 40);
    // A clipping mask: laid only where the layer under it (its base) is. Not for a group.
    if (L.clip && kind !== "group") out.clip = true;
    if (kind === "pixel") {
        Object.assign(out, { x: Math.trunc(num(L.x, 0)), y: Math.trunc(num(L.y, 0)),
                             w: Math.trunc(num(L.w, 0, 0, MAX_SIDE)), h: Math.trunc(num(L.h, 0, 0, MAX_SIDE)) });
        if (L.text && typeof L.text === "object") out.text = cleanText(L.text);
        // Layer styles (imageViewer_paintStyle.js): settings, drawn in the composite.
        const st = cleanStyle(L.style);
        if (st) out.style = st;
        if (L.lockAlpha) out.lockAlpha = true;
        // Smart filters (imageViewer_paintSmart.js): settings, drawn in the composite before the style.
        const fl = cleanFilters(L.filters);
        if (fl) out.filters = fl;
        // A smart layer (imageViewer_paintSmartLayer.js): its source and how it lies; its pixels are drawn from them.
        const sm = cleanSmart(L.smart);
        if (sm) { out.smart = sm; delete out.text; }
    } else if (kind === "group") {
        out.blend = GROUP_BLENDS.includes(L.blend) ? L.blend : "pass_through";
        if (L.collapsed) out.collapsed = true;
    } else {
        const a = L.adjust && typeof L.adjust === "object" ? L.adjust : {};
        const t = ADJUST_TYPES.includes(a.type) ? a.type : "levels";
        out.adjust = { type: t, params: cleanAdjust(t, a.params) };
        out.blend = "normal";
    }
    if (L.mask && typeof L.mask === "object") {
        const m = L.mask;
        out.mask = { enabled: m.enabled !== false, x: Math.trunc(num(m.x, 0)), y: Math.trunc(num(m.y, 0)),
                     w: Math.trunc(num(m.w, 0, 0, MAX_SIDE)), h: Math.trunc(num(m.h, 0, 0, MAX_SIDE)), fill: num(m.fill, 0) >= 128 ? 255 : 0 };
        // Density (how much it hides, 0..1) and feather (a blur of its edge, px): kept, not baked in.
        const dn = num(m.density, 1, 0, 1), fe = num(m.feather, 0, 0, 250);
        if (dn !== 1) out.mask.density = dn;
        if (fe > 0) out.mask.feather = fe;
    }
    return out;
}

/**
 * The layers put in tree order (paint_io.fix_tree), in place: a layer's `parent` names a group or is gone,
 * and every group's layers lie right under it in the list (bottom .. top: its layers, then the group).
 * Siblings keep their order (a group counts where the group's own entry is). Too deep or a loop: the
 * layer comes out of its group.
 */
export function fixTree(layers) {
    const byId = new Map(layers.map((L) => [L.id, L]));
    for (const L of layers) {
        if (!L.parent) { delete L.parent; continue; }
        const P = byId.get(L.parent);
        if (!P || P.kind !== "group" || P === L) { delete L.parent; continue; }
    }
    for (const L of layers) {
        // A loop, or deeper than MAX_DEPTH: out of the group.
        let p = L.parent, n = 0;
        const seen = new Set([L.id]);
        while (p) {
            if (seen.has(p) || ++n > MAX_DEPTH) { delete L.parent; break; }
            seen.add(p);
            p = byId.get(p).parent;
        }
    }
    const kids = new Map();
    for (const L of layers) {
        const k = L.parent || "";
        if (!kids.has(k)) kids.set(k, []);
        kids.get(k).push(L);
    }
    const out = [];
    const walk = (k) => { for (const L of kids.get(k) || []) { if (L.kind === "group") walk(L.id); out.push(L); } };
    walk("");
    for (let i = 0; i < out.length; i++) layers[i] = out[i];
    layers.length = out.length;
    return layers;
}

export function cleanDoc(meta) {
    const w = Math.trunc(num(meta.w, 0)), h = Math.trunc(num(meta.h, 0));
    if (!(w >= 1 && w <= MAX_SIDE && h >= 1 && h <= MAX_SIDE)) throw new Error(`the canvas must be 1..${MAX_SIDE} pixels a side`);
    const layers = fixTree((Array.isArray(meta.layers) ? meta.layers : []).filter((L) => L && typeof L === "object").map(cleanLayer));
    const ids = layers.map((L) => L.id);
    const out = { version: 1, w, h, name: String(meta.name || "paint").slice(0, 120), layers,
                  active: ids.includes(meta.active) ? meta.active : (ids[ids.length - 1] || null) };
    const paths = cleanPaths(meta.paths);
    if (paths.length) out.paths = paths;
    const guides = cleanGuides(meta.guides, w, h);
    if (guides.length) out.guides = guides;
    return out;
}

// ── guides ──────────────────────────────────────────────────────────────────

export const MAX_GUIDES = 100;

/** Guides held to what they may be: [{axis: "x" | "y", pos}], on the canvas, at whole or half pixels. */
export function cleanGuides(list, w, h) {
    const out = [];
    for (const g of Array.isArray(list) ? list : []) {
        if (!g || (g.axis !== "x" && g.axis !== "y")) continue;
        const pos = Math.round(Number(g.pos) * 2) / 2;
        if (!Number.isFinite(pos) || pos < 0 || pos > (g.axis === "x" ? w : h)) continue;
        out.push({ axis: g.axis, pos });
        if (out.length >= MAX_GUIDES) break;
    }
    return out;
}

/** Guides moved by dx, dy, then scaled by kx, ky (crop, canvas size, image size); clean them after. */
export function moveGuides(list, dx = 0, dy = 0, kx = 1, ky = 1) {
    return (list || []).map((g) => ({ axis: g.axis, pos: g.axis === "x" ? (g.pos + dx) * kx : (g.pos + dy) * ky }));
}

// ── the tree ────────────────────────────────────────────────────────────────

export const isGroup = (L) => !!L && L.kind === "group";

/** The layers of each group (and "" = the document), bottom first, as indexes into doc.layers. */
export function childIndexes(doc) {
    const kids = new Map([["", []]]);
    const groups = new Set(doc.layers.filter(isGroup).map((L) => L.id));
    doc.layers.forEach((L, i) => {
        // A parent not in the document (a layer taken out to be laid alone): of the document's level.
        const k = L.parent && groups.has(L.parent) ? L.parent : "";
        if (!kids.has(k)) kids.set(k, []);
        kids.get(k).push(i);
    });
    return kids;
}

/** The group and every layer inside it: [first, last] indexes (last is the group's own). A layer: [i, i]. */
export function subtreeRange(doc, id) {
    const i = layerIndex(doc, id);
    if (i < 0) return null;
    let a = i;
    while (a > 0 && isInside(doc, doc.layers[a - 1], id)) a--;
    return [a, i];
}

/** Is L inside the group `gid` (at any depth)? */
export function isInside(doc, L, gid) {
    let p = L && L.parent, n = 0;
    while (p && n++ <= MAX_DEPTH) {
        if (p === gid) return true;
        const P = doc.layers.find((x) => x.id === p);
        p = P && P.parent;
    }
    return false;
}

/** The groups a layer is in, the nearest first. */
export function ancestors(doc, L) {
    const out = [];
    let p = L && L.parent;
    while (p && out.length <= MAX_DEPTH) {
        const P = doc.layers.find((x) => x.id === p);
        if (!P) break;
        out.push(P);
        p = P.parent;
    }
    return out;
}

/** The layers of `ids` and of every group among them (with what is inside), bottom first - each once. */
export function withInside(doc, ids) {
    const want = new Set(ids);
    return doc.layers.filter((L) => want.has(L.id) || ancestors(doc, L).some((P) => want.has(P.id)));
}

/** Of `ids`, only those not inside another of them (a group picked with its layers: just the group). */
export function outermost(doc, ids) {
    const want = new Set(ids);
    return doc.layers.filter((L) => want.has(L.id) && !ancestors(doc, L).some((P) => want.has(P.id))).map((L) => L.id);
}

// ── rounding and the blend modes ────────────────────────────────────────────

/** paint_math.q8 */
export const q8 = (x) => { const v = Math.floor(x * 255 + 0.5); return v < 0 ? 0 : v > 255 ? 255 : v; };

const hardLight = (cb, cs) => (cs <= 0.5 ? cb * 2 * cs : 1 - (1 - cb) * (1 - (2 * cs - 1)));

/** B(Cb, Cs) - paint_math.blend_fn, channel by channel. */
export function blendFn(mode, cb, cs) {
    switch (mode) {
        case "multiply": return cb * cs;
        case "screen": return cb + cs - cb * cs;
        case "overlay": return hardLight(cs, cb);
        case "darken": return Math.min(cb, cs);
        case "lighten": return Math.max(cb, cs);
        case "difference": return Math.abs(cb - cs);
        case "add": return Math.min(1, cb + cs);
        case "color_dodge": return cb <= 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / Math.max(1e-12, 1 - cs));
        case "color_burn": return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / Math.max(1e-12, cs));
        case "soft_light": {
            const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
            return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (d - cb);
        }
        case "hard_light": return hardLight(cb, cs);
    }
    return cs;
}

/**
 * A pixel layer over `out` (W x H) inside the canvas rectangle rx0..rx1, ry0..ry1 (paint_io.lay):
 * `px` the layer's pixels (L.w x L.h at L.x, L.y), `mask` its mask (L.mask.w x L.mask.h) or null.
 */
export function layPixels(out, W, H, L, px, mask, rx0 = 0, ry0 = 0, rx1 = W, ry1 = H) {
    const op = L.opacity;
    if (!px || op <= 0) return;
    const lw = L.w, lh = L.h, lx = L.x, ly = L.y;
    const x0 = Math.max(rx0, lx, 0), y0 = Math.max(ry0, ly, 0), x1 = Math.min(rx1, lx + lw, W), y1 = Math.min(ry1, ly + lh, H);
    if (x1 <= x0 || y1 <= y0) return;
    const mode = L.blend || "normal";
    const m = L.mask && L.mask.enabled && mask ? L.mask : null;
    const mfill = m ? m.fill / 255 : 1, dens = m && m.density != null ? m.density : 1;
    for (let y = y0; y < y1; y++) {
        let si = ((y - ly) * lw + (x0 - lx)) * 4;
        let oi = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, si += 4, oi += 4) {
            const sa0 = px[si + 3];
            // as = 0: the backdrop exactly (q8 of k / 255 is k); where that is see-through, no colour.
            if (sa0 === 0) { if (out[oi + 3] === 0) out[oi] = out[oi + 1] = out[oi + 2] = 0; continue; }
            let mv = 1;
            if (m) {
                const mx = x - m.x, my = y - m.y;
                mv = (mx >= 0 && my >= 0 && mx < m.w && my < m.h) ? mask[my * m.w + mx] / 255 : mfill;
                if (dens !== 1) mv = 1 - dens * (1 - mv);
            }
            const as = (sa0 / 255) * (op * mv);
            if (as === 0) { if (out[oi + 3] === 0) out[oi] = out[oi + 1] = out[oi + 2] = 0; continue; }
            const ab = out[oi + 3] / 255;
            const ao = as + ab * (1 - as);
            for (let c = 0; c < 3; c++) {
                const cb = out[oi + c] / 255, cs = px[si + c] / 255;
                const b = mode === "normal" ? cs : blendFn(mode, cb, cs);
                const cs2 = (1 - ab) * cs + ab * b;
                const num_ = as * cs2 + (1 - as) * ab * cb;
                out[oi + c] = q8(ao > 0 ? num_ / Math.max(ao, 1e-12) : 0);
            }
            out[oi + 3] = q8(ao);
        }
    }
}

// ── adjustments ─────────────────────────────────────────────────────────────

function monotone(pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const n = xs.length;
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    const m = new Array(n).fill(0);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        const a = m[i] / d[i], b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    const lut = new Float64Array(256);
    for (let v = 0; v < 256; v++) {
        let y;
        if (v <= xs[0]) y = ys[0];
        else if (v >= xs[n - 1]) y = ys[n - 1];
        else {
            let k = 0;
            while (v > xs[k + 1]) k++;
            const h = xs[k + 1] - xs[k];
            const t = (v - xs[k]) / h, t2 = t * t, t3 = t * t * t;
            y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
        }
        lut[v] = Math.min(255, Math.max(0, y)) / 255;
    }
    return lut;
}
export { monotone as curveLut };

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c) => (c <= 0 ? 0 : c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** Three tables of 256 (0..1), or null where it is worked out per pixel (paint_math.adjust_luts). */
export function adjustLuts(kind, params) {
    const p = cleanAdjust(kind, params);
    const one = (f) => { const a = new Float64Array(256); for (let i = 0; i < 256; i++) a[i] = f(i / 255); return [a, a, a]; };
    switch (kind) {
        case "levels": {
            const lv = (q) => {
                const ib = q.in_black / 255, iw = q.in_white / 255, ob = q.out_black / 255, ow = q.out_white / 255, g = 1 / q.gamma;
                return (v) => ob + (ow - ob) * (Math.min(1, Math.max(0, (v - ib) / (iw - ib))) ** g);
            };
            const master = lv(p);
            return ["r", "g", "b"].map((ch) => {
                const own = p[ch] ? lv(p[ch]) : null;
                const a = new Float64Array(256);
                for (let i = 0; i < 256; i++) { const m = master(i / 255); a[i] = own ? own(m) : m; }
                return a;
            });
        }
        case "curves": {
            const master = monotone(p.rgb);
            return ["r", "g", "b"].map((ch) => {
                const own = p[ch] ? monotone(p[ch]) : null;
                const a = new Float64Array(256);
                for (let i = 0; i < 256; i++) a[i] = own ? own[Math.floor(master[i] * 255 + 0.5)] : master[i];
                return a;
            });
        }
        case "brightness_contrast": {
            const c = p.contrast / 100;
            const f = c >= 0 ? 1 / (1 - c * 0.99) : 1 + c;
            const b = p.brightness / 200;
            return one((v) => Math.min(1, Math.max(0, (v - 0.5) * f + 0.5 + b)));
        }
        case "exposure": {
            const k = 2 ** p.exposure, g = 1 / p.gamma;
            return one((v) => Math.min(1, Math.max(0, linToSrgb(Math.max(0, srgbToLin(v) * k + p.offset) ** g))));
        }
        case "grade":
            return [0, 1, 2].map((ch) => {
                const lift = p.lift[ch], gam = p.gamma[ch], gain = p.gain[ch];
                const a = new Float64Array(256);
                for (let i = 0; i < 256; i++) {
                    const v = i / 255;
                    const x = Math.max(0, gain * (v + lift * (1 - v)));
                    a[i] = Math.min(1, x ** (1 / gam));
                }
                return a;
            });
        case "invert": return one((v) => 1 - v);
    }
    return null;
}

/** paint_math._hsl_adjust for one pixel, r g b 0..1 -> [r, g, b]. */
export function hueSat(r, g, b, p) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let l = (mx + mn) / 2;
    const d = mx - mn;
    let s = d === 0 ? 0 : d / Math.max(1e-12, 1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d > 0) {
        if (mx === r) h = (((g - b) / d) % 6 + 6) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    h = (((h * 60 + p.hue) % 360) + 360) % 360;
    s = Math.min(1, Math.max(0, s * (1 + p.saturation / 100)));
    const light = p.lightness / 100;
    l = light > 0 ? l + (1 - l) * light : l * (1 + light);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = l - c / 2;
    const i = ((Math.floor(hp) % 6) + 6) % 6;
    const rs = [c, x, 0, 0, x, c][i], gs = [x, c, c, x, 0, 0][i], bs = [0, 0, x, c, c, x][i];
    return [rs + m, gs + m, bs + m];
}

/** An adjustment layer over `out` (W x H) inside the rectangle (paint_math.apply_adjust); `mask` as in layPixels. */
export function layAdjust(out, W, H, L, mask, rx0 = 0, ry0 = 0, rx1 = W, ry1 = H, luts = null) {
    const op = L.opacity;
    if (op <= 0) return;
    const kind = L.adjust.type;
    const p = cleanAdjust(kind, L.adjust.params);
    const tables = kind === "hue_saturation" || kind === "threshold" ? null : (luts || adjustLuts(kind, p));
    const m = L.mask && L.mask.enabled && mask ? L.mask : null;
    const mfill = m ? m.fill / 255 : 1, dens = m && m.density != null ? m.density : 1;
    const x0 = Math.max(0, rx0), y0 = Math.max(0, ry0), x1 = Math.min(W, rx1), y1 = Math.min(H, ry1);
    for (let y = y0; y < y1; y++) {
        let oi = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, oi += 4) {
            let mv = 1;
            if (m) {
                const mx = x - m.x, my = y - m.y;
                mv = (mx >= 0 && my >= 0 && mx < m.w && my < m.h) ? mask[my * m.w + mx] / 255 : mfill;
                if (dens !== 1) mv = 1 - dens * (1 - mv);
            }
            const t = op * mv;
            const r = out[oi], g = out[oi + 1], b = out[oi + 2];
            let rr, gg, bb;
            if (tables) { rr = tables[0][r]; gg = tables[1][g]; bb = tables[2][b]; }
            else if (kind === "threshold") {
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                rr = gg = bb = lum >= p.level ? 1 : 0;
            } else [rr, gg, bb] = hueSat(r / 255, g / 255, b / 255, p);
            const cr = r / 255, cg = g / 255, cbb = b / 255;
            out[oi] = q8(cr + (rr - cr) * t);
            out[oi + 1] = q8(cg + (gg - cg) * t);
            out[oi + 2] = q8(cbb + (bb - cbb) * t);
        }
    }
}

/** The adjustment baked into one picture (paint_math.adjust_pixels): Merge Down of an adjustment layer. */
export function adjustPixels(px, w, h, kind, params) {
    const out = new Uint8ClampedArray(px);
    layAdjust(out, w, h, { opacity: 1, adjust: { type: kind, params } }, null);
    return out;
}

/**
 * The document over the rectangle (paint_io.composite): `pix(L)` gives a layer's pixels, `maskOf(L)` its
 * mask. `out` may be given (W x H, cleared inside the rectangle first); `from` / `to`: only the layers
 * (of the document's own level - a group counts at its own entry, with what is inside it) with indexes
 * from..to-1, laid on `out` as it stands (a cache of what is below).
 *
 * A group: Pass Through lays its layers straight on what is under it (with an opacity under 1 or a mask,
 * on a copy that is then mixed back: Co = Cb + (Cr - Cb) t, premultiplied, t = opacity x mask); any other
 * mode lays them on nothing first and that picture like a pixel layer the size of the canvas.
 */
export function composite(doc, pix, maskOf, rect = null, out = null, opts = {}) {
    const W = doc.w, H = doc.h;
    const r = rect || { x0: 0, y0: 0, x1: W, y1: H };
    if (!out) out = new Uint8ClampedArray(W * H * 4);
    if (!opts.keep) {
        for (let y = r.y0; y < r.y1; y++) out.fill(0, (y * W + r.x0) * 4, (y * W + r.x1) * 4);
    }
    const from = opts.from || 0, to = opts.to == null ? doc.layers.length : opts.to;
    const kids = childIndexes(doc);
    const top = kids.get("").filter((i) => i >= from && i < to);
    layList(out, doc, top, kids, pix, maskOf, r, 0);
    return out;
}

const _scratch = [];
function scratch(depth, n) {
    let b = _scratch[depth];
    if (!b || b.length !== n) b = _scratch[depth] = new Uint8ClampedArray(n);
    return b;
}

function layList(out, doc, list, kids, pix, maskOf, r, depth) {
    const W = doc.w, H = doc.h;
    for (let k = 0; k < list.length; k++) {
        const L = doc.layers[list[k]];
        // The layers clipped to this one (the next ones up with `clip`). A clipped layer with no base
        // under it (the lowest of its level, or over an adjustment layer) is laid as it is.
        let n = 0;
        if (L.kind !== "adjust" && !L.clip) while (k + 1 + n < list.length && doc.layers[list[k + 1 + n]].clip) n++;
        if (!L.visible) { k += n; continue; }
        const clipped = [];
        for (let j = 1; j <= n; j++) { const C = doc.layers[list[k + j]]; if (C.visible) clipped.push(C); }
        if (clipped.length) { layClipGroup(out, doc, L, clipped, kids, pix, maskOf, r, depth); k += n; continue; }
        k += n;
        if (L.kind === "group") layGroup(out, doc, L, kids, pix, maskOf, r, depth);
        else if (L.kind === "adjust") layAdjust(out, W, H, L, maskOf(L), r.x0, r.y0, r.x1, r.y1);
        else layPixelLayer(out, W, H, L, pix(L), maskOf(L), r);
    }
}

/** A pixel layer: as it is, or with its style (a canvas-sized picture, kept until something changes). */
function layPixelLayer(out, W, H, L, px, mask, r) {
    [L, px] = smartLayer(W, H, L, px);
    if (px && styleOn(L)) {
        layPixels(out, W, H, { x: 0, y: 0, w: W, h: H, opacity: L.opacity, blend: L.blend }, styledCached(W, H, L, px, mask), null, r.x0, r.y0, r.x1, r.y1);
    } else layPixels(out, W, H, L, px, mask, r.x0, r.y0, r.x1, r.y1);
}

/**
 * A base and the layers clipped to it (paint_io._lay_clip_group): the base laid alone (normal, full
 * opacity, its mask), each clipped layer on it only where it is (`layClipped`: the base's alpha is kept),
 * and that picture laid with the base's opacity and blend (a Pass Through group base: Normal).
 */
function layClipGroup(out, doc, B, clipped, kids, pix, maskOf, r, depth) {
    const W = doc.w, H = doc.h;
    if (B.opacity <= 0) return;
    const buf = scratch(depth, W * H * 4);
    for (let y = r.y0; y < r.y1; y++) buf.fill(0, (y * W + r.x0) * 4, (y * W + r.x1) * 4);
    if (B.kind === "group") layGroup(buf, doc, { ...B, blend: "normal", opacity: 1 }, kids, pix, maskOf, r, depth + 1);
    else layPixelLayer(buf, W, H, { ...B, opacity: 1, blend: "normal" }, pix(B), maskOf(B), r);
    for (const C of clipped) {
        if (C.kind === "adjust") layAdjust(buf, W, H, C, maskOf(C), r.x0, r.y0, r.x1, r.y1);
        else { const [C2, cp] = smartLayer(W, H, C, pix(C)); layClipped(buf, W, H, C2, cp, maskOf(C), r.x0, r.y0, r.x1, r.y1); }
    }
    layPixels(out, W, H, { x: 0, y: 0, w: W, h: H, opacity: B.opacity, blend: B.blend === "pass_through" ? "normal" : B.blend }, buf, null, r.x0, r.y0, r.x1, r.y1);
}

/** A clipped pixel layer over its base (paint_math.clip_over): Co = Cb + (B(Cb, Cs) - Cb) t, the alpha kept. */
export function layClipped(out, W, H, L, px, mask, rx0 = 0, ry0 = 0, rx1 = W, ry1 = H) {
    const op = L.opacity;
    if (!px || op <= 0) return;
    const lw = L.w, lh = L.h, lx = L.x, ly = L.y;
    const x0 = Math.max(rx0, lx, 0), y0 = Math.max(ry0, ly, 0), x1 = Math.min(rx1, lx + lw, W), y1 = Math.min(ry1, ly + lh, H);
    if (x1 <= x0 || y1 <= y0) return;
    const mode = L.blend || "normal";
    const m = L.mask && L.mask.enabled && mask ? L.mask : null;
    const mfill = m ? m.fill / 255 : 1, dens = m && m.density != null ? m.density : 1;
    for (let y = y0; y < y1; y++) {
        let si = ((y - ly) * lw + (x0 - lx)) * 4;
        let oi = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, si += 4, oi += 4) {
            if (out[oi + 3] === 0 || px[si + 3] === 0) continue;
            let mv = 1;
            if (m) {
                const mx = x - m.x, my = y - m.y;
                mv = (mx >= 0 && my >= 0 && mx < m.w && my < m.h) ? mask[my * m.w + mx] / 255 : mfill;
                if (dens !== 1) mv = 1 - dens * (1 - mv);
            }
            const t = (px[si + 3] / 255) * (op * mv);
            if (t === 0) continue;
            for (let c = 0; c < 3; c++) {
                const cb = out[oi + c] / 255, cs = px[si + c] / 255;
                const b = mode === "normal" ? cs : blendFn(mode, cb, cs);
                out[oi + c] = q8(cb + (b - cb) * t);
            }
        }
    }
}

function layGroup(out, doc, G, kids, pix, maskOf, r, depth) {
    const W = doc.w, H = doc.h;
    const list = kids.get(G.id) || [];
    if (G.opacity <= 0 || !list.length) return;
    const mask = maskOf(G);
    const m = G.mask && G.mask.enabled && mask ? G.mask : null;
    if (G.blend === "pass_through") {
        if (G.opacity >= 1 && !m) { layList(out, doc, list, kids, pix, maskOf, r, depth + 1); return; }
        const buf = scratch(depth, W * H * 4);
        for (let y = r.y0; y < r.y1; y++) { const a = (y * W + r.x0) * 4, b = (y * W + r.x1) * 4; buf.set(out.subarray(a, b), a); }
        layList(buf, doc, list, kids, pix, maskOf, r, depth + 1);
        mixBack(out, buf, W, H, G.opacity, m, mask, r);
        return;
    }
    const buf = scratch(depth, W * H * 4);
    for (let y = r.y0; y < r.y1; y++) buf.fill(0, (y * W + r.x0) * 4, (y * W + r.x1) * 4);
    layList(buf, doc, list, kids, pix, maskOf, r, depth + 1);
    layPixels(out, W, H, { x: 0, y: 0, w: W, h: H, opacity: G.opacity, blend: G.blend, mask: G.mask }, buf, mask, r.x0, r.y0, r.x1, r.y1);
}

/** out = out + (res - out) t inside the rectangle, premultiplied (paint_math.mix_back). */
export function mixBack(out, res, W, H, op, m, mask, r) {
    const mfill = m ? m.fill / 255 : 1, dens = m && m.density != null ? m.density : 1;
    for (let y = r.y0; y < r.y1; y++) {
        let oi = (y * W + r.x0) * 4;
        for (let x = r.x0; x < r.x1; x++, oi += 4) {
            let mv = 1;
            if (m) {
                const mx = x - m.x, my = y - m.y;
                mv = (mx >= 0 && my >= 0 && mx < m.w && my < m.h) ? mask[my * m.w + mx] / 255 : mfill;
                if (dens !== 1) mv = 1 - dens * (1 - mv);
            }
            const t = op * mv;
            const ab = out[oi + 3] / 255, ar = res[oi + 3] / 255;
            const ao = ab + (ar - ab) * t;
            for (let c = 0; c < 3; c++) {
                const pb = (out[oi + c] / 255) * ab, pr = (res[oi + c] / 255) * ar;
                const pc = pb + (pr - pb) * t;
                out[oi + c] = q8(ao > 0 ? pc / Math.max(ao, 1e-12) : 0);
            }
            out[oi + 3] = q8(ao);
        }
    }
}

// ── filters ─────────────────────────────────────────────────────────────────

export function boxesForGauss(sigma, n = 3) {
    if (sigma <= 0) return new Array(n).fill(1);
    const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl -= 1;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

// A mean over 2r+1 along x (dir 0) or y (dir 1), edge repeated, on `ch` interleaved float channels.
function boxAxis(a, w, h, ch, r, dir) {
    if (r <= 0) return a;
    const out = new Float64Array(a.length);
    const n = dir === 0 ? w : h, lines = dir === 0 ? h : w;
    const step = dir === 0 ? ch : w * ch;
    const k = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
        const base = dir === 0 ? line * w * ch : line * ch;
        for (let c = 0; c < ch; c++) {
            let s = 0;
            for (let j = -r - 1; j < r; j++) s += a[base + Math.min(n - 1, Math.max(0, j)) * step + c];
            for (let i = 0; i < n; i++) {
                s += a[base + Math.min(n - 1, i + r) * step + c] - a[base + Math.min(n - 1, Math.max(0, i - r - 1)) * step + c];
                out[base + i * step + c] = s / k;
            }
        }
    }
    return out;
}

export function blurFloat(a, w, h, ch, radius) {
    const sigma = Math.max(0, radius) / 2;
    if (sigma <= 0) return a;
    let out = Float64Array.from(a);
    for (const size of boxesForGauss(sigma)) {
        const r = (size - 1) >> 1;
        out = boxAxis(out, w, h, ch, r, 0);
        out = boxAxis(out, w, h, ch, r, 1);
    }
    return out;
}

/** paint_math.blur_pixels: a Gaussian on premultiplied colour. */
export function blurPixels(px, w, h, radius) {
    const n = w * h;
    const pm = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
        const a = px[i * 4 + 3] / 255;
        pm[i * 4] = (px[i * 4] / 255) * a; pm[i * 4 + 1] = (px[i * 4 + 1] / 255) * a; pm[i * 4 + 2] = (px[i * 4 + 2] / 255) * a; pm[i * 4 + 3] = a;
    }
    const b = blurFloat(pm, w, h, 4, radius);
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
        const a = b[i * 4 + 3];
        for (let c = 0; c < 3; c++) out[i * 4 + c] = q8(a > 0 ? b[i * 4 + c] / Math.max(a, 1e-12) : 0);
        out[i * 4 + 3] = q8(a);
    }
    return out;
}

export function sharpenPixels(px, w, h, radius, amount) {
    const n = w * h;
    const f = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) f[i * 3 + c] = px[i * 4 + c] / 255;
    const b = blurFloat(f, w, h, 3, radius);
    const out = new Uint8ClampedArray(px);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 4 + c] = q8(f[i * 3 + c] + (f[i * 3 + c] - b[i * 3 + c]) * amount);
    return out;
}

// ── selections ──────────────────────────────────────────────────────────────

export function rectMask(w, h, x, y, rw, rh) {
    const m = new Uint8Array(w * h);
    const x0 = Math.round(Math.max(0, x)), y0 = Math.round(Math.max(0, y));
    const x1 = Math.round(Math.min(w, x + rw)), y1 = Math.round(Math.min(h, y + rh));
    for (let yy = y0; yy < y1; yy++) m.fill(255, yy * w + x0, yy * w + Math.max(x0, x1));
    return m;
}

export function ellipseMask(w, h, x, y, rw, rh) {
    const m = new Uint8Array(w * h);
    if (rw <= 0 || rh <= 0) return m;
    const cx = x + rw / 2, cy = y + rh / 2, rx = rw / 2, ry = rh / 2;
    const ys = Math.max(0, Math.floor(y)), ye = Math.min(h, Math.ceil(y + rh));
    for (let yy = ys; yy < ye; yy++) {
        const dy = (yy + 0.5 - cy) / ry;
        for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(w, Math.ceil(x + rw)); xx++) {
            const dx = (xx + 0.5 - cx) / rx;
            if (dx * dx + dy * dy <= 1) m[yy * w + xx] = 255;
        }
    }
    return m;
}

/** Even-odd at pixel centres (paint_math.polygon_mask). */
export function polygonMask(w, h, pts) {
    const m = new Uint8Array(w * h);
    if (!pts || pts.length < 3) return m;
    const n = pts.length;
    for (let row = 0; row < h; row++) {
        const cy = row + 0.5;
        const hits = [];
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const y0 = pts[i][1], y1 = pts[j][1];
            if ((y0 <= cy && cy < y1) || (y1 <= cy && cy < y0)) hits.push(pts[i][0] + (cy - y0) * (pts[j][0] - pts[i][0]) / (y1 - y0));
        }
        hits.sort((a, b) => a - b);
        for (let k = 0; k + 1 < hits.length; k += 2) {
            const a = Math.max(0, Math.ceil(hits[k] - 0.5)), b = Math.min(w - 1, Math.floor(hits[k + 1] - 0.5));
            if (b >= a) m.fill(255, row * w + a, row * w + b + 1);
        }
    }
    return m;
}

export function combineMasks(old, neu, op) {
    if (!old || op === "replace") return neu;
    const out = new Uint8Array(neu.length);
    for (let i = 0; i < neu.length; i++) {
        const o = old[i], n = neu[i];
        out[i] = op === "add" ? Math.max(o, n) : op === "subtract" ? Math.max(0, o - n) : op === "intersect" ? Math.min(o, n) : n;
    }
    return out;
}

export function feather(m, w, h, radius) {
    if (radius <= 0) return m;
    const f = new Float64Array(m.length);
    for (let i = 0; i < m.length; i++) f[i] = m[i] / 255;
    const b = blurFloat(f, w, h, 1, radius);
    const out = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = q8(b[i]);
    return out;
}

/**
 * A layer's mask as it acts (paint_io.mask_values): feathered by `L.mask.feather`. Density is applied
 * where the mask is read (layPixels and the rest). What a composite's `maskOf` hands it.
 */
export function maskAsItActs(L, raw) {
    if (!raw || !L.mask || !(L.mask.feather > 0)) return raw;
    return feather(raw, L.mask.w, L.mask.h, L.mask.feather);
}

export function invertMask(m) {
    const out = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = 255 - m[i];
    return out;
}

/** {x, y, w, h} of the non-zero part, or null. */
export function maskBBox(m, w, h) {
    if (!m) return null;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (m[row + x]) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                y1 = y;
            }
        }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The edge of a selection: the inside pixels that touch an outside one (for the marching ants). */
export function maskEdge(m, w, h) {
    const e = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (m[i] < 128) continue;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || m[i - 1] < 128 || m[i + 1] < 128 || m[i - w] < 128 || m[i + w] < 128) e[i] = 1;
        }
    }
    return e;
}

// ── the brush ───────────────────────────────────────────────────────────────
//
// A stroke keeps how much of each pixel it has covered (`cover`, 0..1, the MOST any dab gave it), so a
// stroke does not build up over itself; the layer is the picture from before the stroke (`orig`) with
// the colour laid over it by cover x opacity (the eraser takes alpha away by as much).

/** How much a round dab of radius r and hardness h (0..1) covers a pixel at distance d. */
/** A brush tip's value (0..1) at (u, v) in its own pixels, bilinear; 0 outside it. */
export function tipAt(tip, u, v) {
    const fu = u - 0.5, fv = v - 0.5, u0 = Math.floor(fu), v0 = Math.floor(fv), du = fu - u0, dv = fv - v0, w = tip.w, h = tip.h, a = tip.a;
    if (u0 < -1 || v0 < -1 || u0 >= w || v0 >= h) return 0;
    let s = 0;
    for (let j = 0; j < 2; j++) {
        const y = v0 + j;
        if (y < 0 || y >= h) continue;
        for (let i = 0; i < 2; i++) {
            const x = u0 + i;
            if (x < 0 || x >= w) continue;
            s += a[y * w + x] * (j ? dv : 1 - dv) * (i ? du : 1 - du);
        }
    }
    return s / 255;
}

/** A dab's jitter (Shape Dynamics): from `rand` (0..1 each call), the dab moved (scatter, a share of the diameter),
 *  smaller (size, 0..1) and turned (angle, 0..1 of a full turn). { dx, dy, k, da }. */
export function jitter(rand, radius, o) {
    const sc = (o.scatter || 0) / 100, sz = (o.sizeJitter || 0) / 100, aj = (o.angleJitter || 0) / 100;
    const dx = sc ? (rand() * 2 - 1) * sc * 2 * radius : 0, dy = sc ? (rand() * 2 - 1) * sc * 2 * radius : 0;
    const k = sz ? 1 - sz * rand() : 1, da = aj ? (rand() - 0.5) * aj * Math.PI * 2 : 0;
    return { dx, dy, k, da };
}

/**
 * The brush tip's Direction: which way the stroke is going, so a tip can point along it. `f` is
 * { ax, ay (where the way was last read), vx, vy (the way, smoothed; null before the first), dir (radians, null
 * before) }; the pointer at (x, y). The way is read again only once the pointer is `step` away from where it was last
 * read (a hand's wobble of a pixel does not turn the tip), and each new reading is blended half and half with the way
 * before, so a curve turns the tip smoothly. Returns a new f.
 */
export function directionTurn(f, x, y, step = 2) {
    const dx = x - f.ax, dy = y - f.ay, d = Math.hypot(dx, dy);
    if (!(d >= step)) return f;
    let vx = dx / d, vy = dy / d;
    if (f.vx != null) {
        const mx = f.vx + vx, my = f.vy + vy, m = Math.hypot(mx, my);
        if (m > 1e-6) { vx = mx / m; vy = my / m; }               // a turn back on itself takes the new way
    }
    return { ax: x, ay: y, vx, vy, dir: Math.atan2(vy, vx) };
}

/** A small seeded random generator (mulberry32). */
export function seeded(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function dabAt(d, r, hard) {
    if (d >= r) return 0;
    const inner = r * hard;
    if (d <= inner) return 1;
    const t = (d - inner) / Math.max(1e-6, r - inner);
    return 1 - t * t * (3 - 2 * t);
}

/** The dabs along a segment, `spacing` (a share of the diameter) apart; `carry` the distance left over. */
export function dabsAlong(x0, y0, x1, y1, radius, spacing, carry = 0) {
    const step = Math.max(0.5, radius * 2 * spacing);
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const out = [];
    let t = step - carry;
    if (carry === 0 && len === 0) return { dabs: [[x0, y0]], carry: 0 };
    while (t <= len) {
        out.push([x0 + dx * (t / (len || 1)), y0 + dy * (t / (len || 1))]);
        t += step;
    }
    return { dabs: out, carry: len - (t - step) };
}

// ── pen pressure ─────────────────────────────────────────────────────────────
//
// A pen (Wacom through Windows Ink, an Apple Pencil ...) reports PointerEvent.pressure 0..1; a mouse reports
// 0.5 while a button is down, which means nothing, so only a "pen" is read. The brush's size and / or
// opacity follow it (Properties: "Pen pressure"), each dab at the pressure where it lies along the move.

/** The smallest share of the brush's size a light touch draws (a dab never vanishes). */
export const PRESSURE_MIN_SIZE = 0.05;

/** The pressure of a pointer event as the brush takes it: a pen's own, anything else 1. */
export function pressureOf(pointerType, pressure) {
    if (pointerType !== "pen") return 1;
    const p = Number(pressure);
    return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1;
}

/** What a pressure does to one dab: `{ r }` its share of the radius, `{ a }` of its opacity. */
export function pressureScale(p, size, opacity) {
    return { r: size ? Math.max(PRESSURE_MIN_SIZE, p) : 1, a: opacity ? p : 1 };
}

/**
 * Dabs from (x0, y0) at pressure p0 to (x1, y1) at p1: each [x, y, p], the pressure taken along the move,
 * spaced by the radius THERE (a lighter, smaller dab sits closer to the one before) when `size` follows the
 * pen. `carry` is the distance already gone since the last dab, as dabsAlong's.
 */
export function pressureDabs(x0, y0, p0, x1, y1, p1, radius, spacing, carry = 0, size = true) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const stepAt = (p) => Math.max(0.5, radius * (size ? Math.max(PRESSURE_MIN_SIZE, p) : 1) * 2 * spacing);
    if (len === 0) return { dabs: carry === 0 ? [[x0, y0, p1]] : [], carry };
    const out = [];
    let t = stepAt(p0) - carry;
    while (t <= len) {
        const f = t / len, p = p0 + (p1 - p0) * f;
        out.push([x0 + dx * f, y0 + dy * f, p]);
        t += stepAt(p);
    }
    const lastAt = out.length ? Math.hypot(out[out.length - 1][0] - x0, out[out.length - 1][1] - y0) : -carry;
    return { dabs: out, carry: len - lastAt };
}

/**
 * One dab into a stroke. `st` = { px (the layer, written), orig, cover (Float32Array), lw, lh, lx, ly,
 * color [r, g, b], opacity, erase, sel (canvas mask or null), W, H, lockAlpha }. Returns the layer
 * rectangle touched, {x0, y0, x1, y1}, or null. `flow` (0..1, the pen's pressure on the opacity) scales the
 * dab; the stroke still keeps the most any dab gave a pixel, so a lighter press never lightens it.
 */
export function stamp(st, cx, cy, radius, hard, flow = 1, angle = 0) {
    const { lw, lh, lx, ly } = st;
    // A brush tip (st.tip, a grey picture: white paints): its longer side the dab's diameter, turned by `angle`.
    const tip = st.tip, tk = tip ? (2 * radius) / Math.max(tip.w, tip.h) : 0;
    const reach = tip ? (tk * Math.hypot(tip.w, tip.h)) / 2 : radius;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const x0 = Math.max(0, Math.floor(cx - reach - lx)), y0 = Math.max(0, Math.floor(cy - reach - ly));
    const x1 = Math.min(lw, Math.ceil(cx + reach - lx) + 1), y1 = Math.min(lh, Math.ceil(cy + reach - ly) + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            let a;
            if (tip) {
                const dx = x + 0.5 + lx - cx, dy = y + 0.5 + ly - cy;
                a = tipAt(tip, (ca * dx + sa * dy) / tk + tip.w / 2, (-sa * dx + ca * dy) / tk + tip.h / 2) * flow;
            } else a = dabAt(Math.hypot(x + 0.5 + lx - cx, y + 0.5 + ly - cy), radius, hard) * flow;
            if (a <= 0) continue;
            if (st.sel) {
                const gx = x + lx, gy = y + ly;
                a *= (gx >= 0 && gy >= 0 && gx < st.W && gy < st.H) ? st.sel[gy * st.W + gx] / 255 : 0;
                if (a <= 0) continue;
            }
            const i = y * lw + x;
            if (st.build) {
                // Flow: each dab lays a share of what is still missing, so the dabs of one stroke build up to the
                // opacity (going over the same place again in the stroke makes it darker); a dab is never weaker
                // than what the stroke already laid there.
                const nc = st.cover[i] + a * st.build * (1 - st.cover[i]);
                if (nc <= st.cover[i] + 1e-6) continue;
                a = nc;
            } else if (a <= st.cover[i]) continue;
            st.cover[i] = a;
            let t = a * st.opacity;
            const o = i * 4;
            const oa = st.orig[o + 3] / 255;
            if (st.tone) {
                // Dodge, burn, sponge: the pixel from before the stroke changed by the dab's share; alpha kept.
                const v = toneAt(st.tone, st.orig[o] / 255, st.orig[o + 1] / 255, st.orig[o + 2] / 255, t);
                st.px[o] = q8(v[0]); st.px[o + 1] = q8(v[1]); st.px[o + 2] = q8(v[2]);
                continue;
            }
            let col = st.color;
            if (st.clone) {
                // The clone stamp: the colour of the source at the same offset (cloneAt), its alpha scaling the dab.
                const q = cloneAt(st.clone, x + lx, y + ly);
                if (q < 0) { st.cover[i] = 0; continue; }
                const sp = st.clone.src;
                t *= sp[q + 3] / 255;
                if (t <= 0) continue;
                col = [sp[q], sp[q + 1], sp[q + 2]];
            }
            if (st.erase) {
                st.px[o] = st.orig[o]; st.px[o + 1] = st.orig[o + 1]; st.px[o + 2] = st.orig[o + 2];
                st.px[o + 3] = q8(oa * (1 - t));
                continue;
            }
            if (st.lockAlpha) {
                for (let c = 0; c < 3; c++) st.px[o + c] = q8((st.orig[o + c] / 255) * (1 - t) + (col[c] / 255) * t);
                st.px[o + 3] = st.orig[o + 3];
                continue;
            }
            // Normal over the picture from before the stroke.
            const ao = t + oa * (1 - t);
            for (let c = 0; c < 3; c++) {
                const v = ao > 0 ? ((col[c] / 255) * t + (st.orig[o + c] / 255) * oa * (1 - t)) / ao : 0;
                st.px[o + c] = q8(v);
            }
            st.px[o + 3] = q8(ao);
        }
    }
    return { x0, y0, x1, y1 };
}

/**
 * The dodge, burn and sponge brushes on one pixel (0..1), by `t` (the dab's share x the exposure / flow).
 * tone = { mode: dodge | burn | sponge, range: shadows | midtones | highlights (dodge, burn),
 * sat: saturate | desaturate (sponge) }. Dodge moves a channel toward white, burn toward black, each by
 * how much the pixel's light lies in the range (shadows (1 - Y)^2, midtones 4 Y (1 - Y), highlights Y^2);
 * the sponge moves the channels away from or toward the pixel's grey.
 */
export function toneAt(tone, r, g, b, t) {
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    if (tone.mode === "sponge") {
        const k = tone.sat === "desaturate" ? -t : t;
        return [cl(Y + (r - Y) * (1 + k)), cl(Y + (g - Y) * (1 + k)), cl(Y + (b - Y) * (1 + k))];
    }
    const w = tone.range === "shadows" ? (1 - Y) * (1 - Y) : tone.range === "highlights" ? Y * Y : 4 * Y * (1 - Y);
    const s = t * w;
    if (tone.mode === "burn") return [r - s * r, g - s * g, b - s * b];
    return [r + s * (1 - r), g + s * (1 - g), b + s * (1 - b)];
}

/**
 * The clone stamp's source pixel for the canvas pixel (gx, gy): an index into `c.src` (RGBA, `c.sw` x `c.sh`,
 * its top left at `c.sx`, `c.sy` on the canvas), `c.dx` / `c.dy` away; -1 outside it.
 */
export function cloneAt(c, gx, gy) {
    let qx, qy;
    if (c.m) {
        // Turned / scaled / flipped about the destination anchor (ax, ay): source = anchor + offset + M (g - anchor).
        const ux = gx + 0.5 - c.ax, uy = gy + 0.5 - c.ay;
        qx = Math.floor(c.ax + c.dx + c.m.a * ux + c.m.c * uy) - c.sx;
        qy = Math.floor(c.ay + c.dy + c.m.b * ux + c.m.d * uy) - c.sy;
    } else { qx = gx + c.dx - c.sx; qy = gy + c.dy - c.sy; }
    if (qx < 0 || qy < 0 || qx >= c.sw || qy >= c.sh) return -1;
    return (qy * c.sw + qx) * 4;
}

/** The clone source's turn (degrees, clockwise), scale (%) and left-right flip as a 2 x 2 {a, b, c, d}; null when it is none. */
export function cloneMatrix(angle = 0, scale = 100, flip = false) {
    if (!angle && (scale === 100 || !scale) && !flip) return null;
    const r = (angle * Math.PI) / 180, k = (scale || 100) / 100, cs = Math.cos(r) * k, sn = Math.sin(r) * k, f = flip ? -1 : 1;
    return { a: cs * f, b: sn * f, c: -sn, d: cs };
}

// ── free transform ──────────────────────────────────────────────────────────
//
// A layer is transformed about its middle: p = t + R(r) · Shear(kx, ky) · Scale(sx, sy) · (u - c), u in the
// layer's own pixels (0..w, 0..h), c its middle, t where that middle lands on the canvas. `r` in degrees,
// clockwise on screen (y down). As a 2D affine {a, b, c, d, e, f}: x = a u + c v + e, y = b u + d v + f.

/** The transform that leaves a layer w x h at (x, y) where it is. */
export function tfIdentity(x, y, w, h) {
    return { tx: x + w / 2, ty: y + h / 2, sx: 1, sy: 1, r: 0, kx: 0, ky: 0, cx: w / 2, cy: h / 2 };
}

export function tfMatrix(t) {
    const r = (t.r || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const sx = t.sx, sy = t.sy, kx = t.kx || 0, ky = t.ky || 0;
    // Shear · Scale = [[sx, kx sy], [ky sx, sy]]; R · that.
    const a = cs * sx - sn * ky * sx, c = cs * kx * sy - sn * sy;
    const b = sn * sx + cs * ky * sx, d = sn * kx * sy + cs * sy;
    return { a, b, c, d, e: t.tx - (a * t.cx + c * t.cy), f: t.ty - (b * t.cx + d * t.cy) };
}

export function applyM(m, u, v) { return [m.a * u + m.c * v + m.e, m.b * u + m.d * v + m.f]; }

export function invertM(m) {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return null;
    const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
    return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** True when a transform only moves the layer by whole pixels (no resampling needed). */
export function tfIsMove(t) {
    return t.sx === 1 && t.sy === 1 && !(t.r % 360) && !t.kx && !t.ky
        && Number.isInteger(t.tx - t.cx) && Number.isInteger(t.ty - t.cy);
}

/** The four corners of a w x h layer under m, on the canvas: top left, top right, bottom right, bottom left. */
export function tfCorners(m, w, h) { return [applyM(m, 0, 0), applyM(m, w, 0), applyM(m, w, h), applyM(m, 0, h)]; }

/** The whole-pixel box the transformed layer covers. */
export function tfBox(m, w, h) {
    const cs = tfCorners(m, w, h);
    const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs) + 1e-6), y0 = Math.floor(Math.min(...ys) + 1e-6);
    const x1 = Math.ceil(Math.max(...xs) - 1e-6), y1 = Math.ceil(Math.max(...ys) - 1e-6);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * The layer's pixels (RGBA w x h) under m, into a new buffer the size of `box`: every pixel's middle taken
 * back through m, read bilinearly with premultiplied alpha (`smooth`), or the nearest pixel.
 */
export function tfPixels(src, w, h, m, box, smooth = true) {
    const inv = invertM(m);
    const out = new Uint8ClampedArray(box.w * box.h * 4);
    if (!inv) return out;
    for (let Y = 0; Y < box.h; Y++) {
        for (let X = 0; X < box.w; X++) {
            const gx = box.x + X + 0.5, gy = box.y + Y + 0.5;
            const u = inv.a * gx + inv.c * gy + inv.e, v = inv.b * gx + inv.d * gy + inv.f;
            const o = (Y * box.w + X) * 4;
            if (!smooth) {
                const ui = Math.floor(u), vi = Math.floor(v);
                if (ui < 0 || vi < 0 || ui >= w || vi >= h) continue;
                const q = (vi * w + ui) * 4;
                out[o] = src[q]; out[o + 1] = src[q + 1]; out[o + 2] = src[q + 2]; out[o + 3] = src[q + 3];
                continue;
            }
            const fu = u - 0.5, fv = v - 0.5;
            const u0 = Math.floor(fu), v0 = Math.floor(fv), du = fu - u0, dv = fv - v0;
            let r = 0, g = 0, bl = 0, al = 0;
            for (let j = 0; j < 2; j++) {
                const vy = v0 + j;
                if (vy < 0 || vy >= h) continue;
                const wy = j ? dv : 1 - dv;
                for (let i = 0; i < 2; i++) {
                    const ux = u0 + i;
                    if (ux < 0 || ux >= w) continue;
                    const wgt = wy * (i ? du : 1 - du);
                    if (wgt <= 0) continue;
                    const q = (vy * w + ux) * 4, pa = src[q + 3] * wgt;
                    r += src[q] * pa; g += src[q + 1] * pa; bl += src[q + 2] * pa; al += pa;
                }
            }
            if (al <= 0) continue;
            out[o] = r / al + 0.5; out[o + 1] = g / al + 0.5; out[o + 2] = bl / al + 0.5; out[o + 3] = al + 0.5;
        }
    }
    return out;
}

/** A mask (one channel, `fill` outside it) under m, into the size of `box`. */
export function tfMask(src, w, h, m, box, fill = 0) {
    const inv = invertM(m);
    const out = new Uint8Array(box.w * box.h).fill(fill);
    if (!inv) return out;
    for (let Y = 0; Y < box.h; Y++) {
        for (let X = 0; X < box.w; X++) {
            const gx = box.x + X + 0.5, gy = box.y + Y + 0.5;
            const fu = inv.a * gx + inv.c * gy + inv.e - 0.5, fv = inv.b * gx + inv.d * gy + inv.f - 0.5;
            const u0 = Math.floor(fu), v0 = Math.floor(fv), du = fu - u0, dv = fv - v0;
            let s = 0;
            for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
                const ux = u0 + i, vy = v0 + j;
                const val = (ux < 0 || vy < 0 || ux >= w || vy >= h) ? fill : src[vy * w + ux];
                s += val * (j ? dv : 1 - dv) * (i ? du : 1 - du);
            }
            out[Y * box.w + X] = Math.round(s);
        }
    }
    return out;
}

// ── the bucket ──────────────────────────────────────────────────────────────

/** The pixels like the one at (sx, sy) within `tol` (0..255), touching it (or all of them): a mask w x h. */
export function floodMask(px, w, h, sx, sy, tol, contiguous = true) {
    const m = new Uint8Array(w * h);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return m;
    const s = (sy * w + sx) * 4;
    const ref = [px[s], px[s + 1], px[s + 2], px[s + 3]];
    const like = (i) => {
        const o = i * 4;
        return Math.abs(px[o] - ref[0]) <= tol && Math.abs(px[o + 1] - ref[1]) <= tol && Math.abs(px[o + 2] - ref[2]) <= tol
            && Math.abs(px[o + 3] - ref[3]) <= tol;
    };
    if (!contiguous) {
        for (let i = 0; i < w * h; i++) if (like(i)) m[i] = 255;
        return m;
    }
    const stack = [sy * w + sx];
    m[sy * w + sx] = 255;
    while (stack.length) {
        const i = stack.pop();
        const x = i % w, y = (i - x) / w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && !m[j] && like(j)) { m[j] = 255; stack.push(j); }
    }
    return m;
}

/** Colour laid over a layer's pixels by coverage `t` (Float32Array/Uint8Array w x h, `scale` 255 for a mask). */
export function fillOver(px, w, h, color, t, scale = 1) {
    const out = new Uint8ClampedArray(px);
    for (let i = 0; i < w * h; i++) {
        const a = t[i] / scale;
        if (a <= 0) continue;
        const o = i * 4;
        const as = (color[3] == null ? 1 : color[3] / 255) * a;
        const ab = px[o + 3] / 255;
        const ao = as + ab * (1 - as);
        for (let c = 0; c < 3; c++) {
            const v = ao > 0 ? ((color[c] / 255) * as + (px[o + c] / 255) * ab * (1 - as)) / ao : 0;
            out[o + c] = q8(v);
        }
        out[o + 3] = q8(ao);
    }
    return out;
}

/** A canvas-sized mask cut to a layer's rectangle (w x h, Uint8Array). */
export function maskForLayer(sel, W, H, L) {
    const out = new Uint8Array(L.w * L.h);
    for (let y = 0; y < L.h; y++) {
        const gy = y + L.y;
        if (gy < 0 || gy >= H) continue;
        for (let x = 0; x < L.w; x++) {
            const gx = x + L.x;
            if (gx >= 0 && gx < W) out[y * L.w + x] = sel[gy * W + gx];
        }
    }
    return out;
}

// ── colour ──────────────────────────────────────────────────────────────────

export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return [0, 0, 0];
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
/**
 * The average colour of the picture `px` (w x h, straight RGBA) inside the box from (x0, y0) to (x1, y1), any two
 * corners, in pixels (cut to the picture; a pixel counts when its middle is inside). Weighted by alpha, so what
 * is see-through counts as little as it shows; null where nothing in the box shows. A big box is read on a
 * grid of at most `most` pixels, evenly spread.
 */
export function areaAverage(px, w, h, x0, y0, x1, y1, most = 262144) {
    const ax = Math.max(0, Math.round(Math.min(x0, x1))), bx = Math.min(w, Math.round(Math.max(x0, x1)));
    const ay = Math.max(0, Math.round(Math.min(y0, y1))), by = Math.min(h, Math.round(Math.max(y0, y1)));
    if (bx <= ax || by <= ay) return null;
    const step = Math.max(1, Math.ceil(Math.sqrt(((bx - ax) * (by - ay)) / most)));
    let r = 0, g = 0, b = 0, a = 0;
    for (let y = ay; y < by; y += step) {
        for (let x = ax, i = (y * w + ax) * 4; x < bx; x += step, i += 4 * step) {
            const al = px[i + 3];
            r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
        }
    }
    if (!a) return null;
    return [Math.round(r / a), Math.round(g / a), Math.round(b / a)];
}

export const rgbToHex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// ── the document ────────────────────────────────────────────────────────────

export function layerIndex(doc, id) { return doc.layers.findIndex((L) => L.id === id); }

/** Layers as the panel lists them: the top first, numbered from 1 (the agent's numbering too). */
export function panelOrder(doc) { return doc.layers.slice().reverse(); }

/** A name not used yet: "Layer 3". */
export function freshName(doc, base = "Layer") {
    const taken = new Set(doc.layers.map((L) => L.name));
    let n = doc.layers.length + 1;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

// ── paths (the pen) ─────────────────────────────────────────────────────────
// A path is anchors with a handle on each side: { x, y, ix, iy (the handle before), ox, oy (after), smooth }.
// Every segment is a cubic Bezier from an anchor through its out handle and the next one's in handle.
// paint_math.flatten_path / stroke_mask are the same arithmetic.

export const MAX_PATHS = 100;
export const MAX_PATH_POINTS = 4000;

export function cleanPath(p) {
    const f = (v, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(-1e6, Math.min(1e6, x)) : d; };
    const pts = (Array.isArray(p && p.pts) ? p.pts : []).slice(0, MAX_PATH_POINTS).filter((a) => a && typeof a === "object").map((a) => {
        const x = f(a.x, 0), y = f(a.y, 0);
        return { x, y, ix: f(a.ix, x), iy: f(a.iy, y), ox: f(a.ox, x), oy: f(a.oy, y), smooth: !!a.smooth };
    });
    return { id: String((p && p.id) || newId()).slice(0, 40), name: String((p && p.name) || "Path").slice(0, 120), closed: !!(p && p.closed) && pts.length > 2, pts };
}

export function cleanPaths(list) {
    const out = [], seen = new Set();
    for (const p of (Array.isArray(list) ? list : []).slice(0, MAX_PATHS)) {
        const c = cleanPath(p);
        if (!c.pts.length || seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
    }
    return out;
}

/** How many straight pieces a segment is drawn with: about one per 3 px of its control polygon, 1 when it is straight. */
export function segmentSteps(a, b) {
    if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) return 1;
    const len = Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - a.ox, b.iy - a.oy) + Math.hypot(b.x - b.ix, b.y - b.iy);
    return Math.max(1, Math.min(128, Math.ceil(len / 3)));
}

export function bezierAt(a, b, t) {
    const u = 1 - t, A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, E = t * t * t;
    return [A * a.x + B * a.ox + C * b.ix + E * b.x, A * a.y + B * a.oy + C * b.iy + E * b.y];
}

/** The path as a polyline [[x, y], ...]; a closed path's last segment back to the first anchor included (not repeating it). */
export function flattenPath(path) {
    const pts = path.pts, out = [];
    if (!pts.length) return out;
    out.push([pts[0].x, pts[0].y]);
    const segs = path.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], n = segmentSteps(a, b);
        for (let k = 1; k <= n; k++) {
            if (path.closed && i === segs - 1 && k === n) break;
            out.push(k === n ? [b.x, b.y] : bezierAt(a, b, k / n));
        }
    }
    return out;
}

/** The inside of a path (an open one closed by a straight line), even-odd. */
export function pathMask(w, h, path) { return polygonMask(w, h, flattenPath(path)); }

/** A line `width` px wide along the polyline, antialiased: coverage = width / 2 - distance + 0.5, held to 0..1. */
export function strokeMask(w, h, line, closed, width) {
    const m = new Uint8Array(w * h);
    const n = line.length, r = Math.max(0.5, width / 2);
    if (!n) return m;
    const segs = n === 1 ? [[line[0], line[0]]] : [];
    for (let i = 0; i + 1 < n; i++) segs.push([line[i], line[i + 1]]);
    if (closed && n > 2) segs.push([line[n - 1], line[0]]);
    for (const [p, q] of segs) {
        const x0 = Math.max(0, Math.floor(Math.min(p[0], q[0]) - r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(p[0], q[0]) + r + 1));
        const y0 = Math.max(0, Math.floor(Math.min(p[1], q[1]) - r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(p[1], q[1]) + r + 1));
        const dx = q[0] - p[0], dy = q[1] - p[1], ll = dx * dx + dy * dy;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const cx = x + 0.5 - p[0], cy = y + 0.5 - p[1];
            let t = ll > 0 ? (cx * dx + cy * dy) / ll : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = cx - t * dx, ey = cy - t * dy, d = Math.sqrt(ex * ex + ey * ey);
            const c = r - d + 0.5, v = q8(c < 0 ? 0 : c > 1 ? 1 : c);
            const i = y * w + x;
            if (v > m[i]) m[i] = v;
        }
    }
    return m;
}

/** The anchor, or a handle, of `path` within `tol` of (x, y): { i, part: "a" | "in" | "out" } or null; handles first. */
export function pathHit(path, x, y, tol, handles = true) {
    let best = null, bd = tol;
    path.pts.forEach((a, i) => {
        const tries = [["a", a.x, a.y]];
        if (handles) tries.unshift(["in", a.ix, a.iy], ["out", a.ox, a.oy]);
        for (const [part, px, py] of tries) {
            if (part !== "a" && px === a.x && py === a.y) continue;
            const d = Math.hypot(px - x, py - y);
            if (d < bd || (d === bd && part !== "a" && best && best.part === "a")) { bd = d; best = { i, part }; }
        }
    });
    return best;
}

/** Move one part of an anchor; an anchor takes its handles along, a smooth anchor's other handle turns with the one dragged. */
export function movePathPoint(a, part, x, y, free = false) {
    const out = { ...a };
    if (part === "a") {
        const dx = x - a.x, dy = y - a.y;
        Object.assign(out, { x, y, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy });
        return out;
    }
    const [k, o] = part === "in" ? ["i", "o"] : ["o", "i"];
    out[k + "x"] = x; out[k + "y"] = y;
    if (a.smooth && !free) {
        const ol = Math.hypot(a[o + "x"] - a.x, a[o + "y"] - a.y), dl = Math.hypot(x - a.x, y - a.y);
        if (dl > 0 && ol > 0) { out[o + "x"] = a.x - ((x - a.x) / dl) * ol; out[o + "y"] = a.y - ((y - a.y) / dl) * ol; }
    }
    if (free) out.smooth = false;
    return out;
}

/** Every anchor and handle scaled by kx, ky, then moved by dx, dy (a crop, canvas size, resize; paint_math.move_paths). */
export function movePaths(paths, dx = 0, dy = 0, kx = 1, ky = 1) {
    return (paths || []).map((q) => ({ ...q, pts: q.pts.map((a) => ({ ...a, x: a.x * kx + dx, y: a.y * ky + dy, ix: a.ix * kx + dx, iy: a.iy * ky + dy,
                                                                     ox: a.ox * kx + dx, oy: a.oy * ky + dy })) }));
}
