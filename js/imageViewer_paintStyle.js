// Paint's layer styles: drop shadow, outer glow, an edge (stroke) and a colour overlay on a pixel layer,
// kept as settings (`L.style`) and drawn in the composite. The same arithmetic is src/paint_style.py,
// compared pixel by pixel by tests/test_paint_parity.py; tested on its own in tests/test_paint_style.mjs.
// Written from what the effects look like, not from any other program's code.
import { q8, feather } from "./imageViewer_paintData.js";

export const STYLE_KINDS = ["shadow", "glow", "stroke", "overlay"];
export const STYLE_LABELS = { shadow: "Drop shadow", glow: "Outer glow", stroke: "Stroke", overlay: "Colour overlay" };
export const STYLE_DEFAULTS = {
    shadow: { on: true, color: [0, 0, 0], opacity: 0.75, angle: 120, distance: 10, size: 10 },
    glow: { on: true, color: [255, 255, 190], opacity: 0.75, size: 20 },
    stroke: { on: true, color: [0, 0, 0], opacity: 1, size: 3 },
    overlay: { on: true, color: [255, 0, 0], opacity: 1 },
};
/** Each number's range: [min, max, whole]. */
const RANGES = { opacity: [0, 1, false], angle: [-180, 180, false], distance: [0, 1000, false], size: [0, 250, false] };
const STROKE_MAX = 100;

const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };

/** A style held to what it may be; null when nothing is left. */
export function cleanStyle(s) {
    if (!s || typeof s !== "object") return null;
    const out = {};
    for (const k of STYLE_KINDS) {
        const e = s[k];
        if (!e || typeof e !== "object") continue;
        const d = STYLE_DEFAULTS[k], o = { on: e.on !== false };
        const c = Array.isArray(e.color) ? e.color : d.color;
        o.color = [0, 1, 2].map((i) => Math.round(n(c[i], d.color[i], 0, 255)));
        for (const f of Object.keys(d)) {
            if (f === "on" || f === "color") continue;
            const [lo, hi] = RANGES[f];
            o[f] = n(e[f], d[f], lo, f === "size" && k === "stroke" ? STROKE_MAX : hi);
        }
        if (k === "stroke") o.size = Math.max(1, Math.round(o.size));
        out[k] = o;
    }
    return Object.keys(out).length ? out : null;
}

/** Does this layer draw a style? */
export function styleOn(L) {
    const s = L && L.kind === "pixel" && L.style;
    return !!s && STYLE_KINDS.some((k) => s[k] && s[k].on);
}

/** The largest of m within a disc of radius r (whole pixels) about each pixel: an edge's spread. */
export function dilate(m, w, h, r) {
    r = Math.round(r);
    if (r <= 0) return new Uint8Array(m);
    // How wide the disc is at each row away from the middle.
    const hw = [];
    for (let dy = 0; dy <= r; dy++) hw.push(Math.floor(Math.sqrt(r * r - dy * dy)));
    const out = new Uint8Array(w * h);
    let H = new Uint8Array(m);
    for (let k = 0; k <= r; k++) {
        if (k > 0) {
            // One pixel wider: the largest of a pixel and its two neighbours on the row.
            const G = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) {
                const o = y * w;
                for (let x = 0; x < w; x++) {
                    let v = H[o + x];
                    if (x > 0 && H[o + x - 1] > v) v = H[o + x - 1];
                    if (x < w - 1 && H[o + x + 1] > v) v = H[o + x + 1];
                    G[o + x] = v;
                }
            }
            H = G;
        }
        for (let dy = 0; dy <= r; dy++) {
            if (hw[dy] !== k) continue;
            for (const s of dy ? [dy, -dy] : [0]) {
                for (let y = 0; y < h; y++) {
                    const sy = y + s;
                    if (sy < 0 || sy >= h) continue;
                    const o = y * w, so = sy * w;
                    for (let x = 0; x < w; x++) if (H[so + x] > out[o + x]) out[o + x] = H[so + x];
                }
            }
        }
    }
    return out;
}

/** m moved by whole pixels (what moves in from outside is 0). */
export function shiftMask(m, w, h, dx, dy) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const sy = y - dy;
        if (sy < 0 || sy >= h) continue;
        for (let x = 0; x < w; x++) {
            const sx = x - dx;
            if (sx >= 0 && sx < w) out[y * w + x] = m[sy * w + sx];
        }
    }
    return out;
}

/** The shadow's offset in whole pixels: it falls away from a light at `angle` (degrees, 0 = from the right, 90 = from above). */
export function shadowOffset(angle, distance) {
    const a = (angle * Math.PI) / 180;
    return [Math.round(-Math.cos(a) * distance) || 0, Math.round(Math.sin(a) * distance) || 0];
}

/** A solid colour laid Normal over `out` (W x H RGBA, in place) by a[i] / 255 x opacity. */
function overColor(out, color, a, opacity) {
    const cs = color.map((v) => v / 255);
    for (let i = 0; i < a.length; i++) {
        const as = (a[i] / 255) * opacity;
        if (as <= 0) continue;
        const o = i * 4, ab = out[o + 3] / 255, ao = as + ab * (1 - as);
        for (let c = 0; c < 3; c++) out[o + c] = q8(ao > 0 ? (cs[c] * as + (out[o + c] / 255) * ab * (1 - as)) / ao : 0);
        out[o + 3] = q8(ao);
    }
}

/**
 * The layer with its style, as a canvas-sized picture (W x H RGBA) to be laid with the layer's opacity and
 * blend: its mask is in it. Under the layer, in this order: the shadow (its outline moved and blurred), the
 * glow (blurred, twice as strong, held to 1), the edge (the outline spread by its size); then the layer, its
 * colours mixed toward the overlay's.
 */
export function styledPixels(W, H, L, px, mask) {
    const s = L.style || {};
    const A = new Uint8Array(W * H);
    const C = new Uint8ClampedArray(W * H * 4);
    const m = L.mask && L.mask.enabled && mask ? L.mask : null;
    const mfill = m ? m.fill / 255 : 1, dens = m && m.density != null ? m.density : 1;
    const ov = s.overlay && s.overlay.on ? s.overlay : null;
    const x0 = Math.max(0, L.x), y0 = Math.max(0, L.y), x1 = Math.min(W, L.x + L.w), y1 = Math.min(H, L.y + L.h);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const si = ((y - L.y) * L.w + x - L.x) * 4, i = y * W + x;
            let mv = 1;
            if (m) {
                const mx = x - m.x, my = y - m.y;
                mv = mx >= 0 && my >= 0 && mx < m.w && my < m.h ? mask[my * m.w + mx] / 255 : mfill;
                if (dens !== 1) mv = 1 - dens * (1 - mv);
            }
            A[i] = q8((px[si + 3] / 255) * mv);
            for (let c = 0; c < 3; c++) {
                const cs = px[si + c] / 255;
                C[i * 4 + c] = ov ? q8(cs + (ov.color[c] / 255 - cs) * ov.opacity) : px[si + c];
            }
            C[i * 4 + 3] = A[i];
        }
    }
    const out = new Uint8ClampedArray(W * H * 4);
    if (s.shadow && s.shadow.on) {
        const [dx, dy] = shadowOffset(s.shadow.angle, s.shadow.distance);
        overColor(out, s.shadow.color, feather(shiftMask(A, W, H, dx, dy), W, H, s.shadow.size), s.shadow.opacity);
    }
    if (s.glow && s.glow.on) {
        const g = feather(A, W, H, s.glow.size);
        for (let i = 0; i < g.length; i++) g[i] = Math.min(255, g[i] * 2);
        overColor(out, s.glow.color, g, s.glow.opacity);
    }
    if (s.stroke && s.stroke.on) overColor(out, s.stroke.color, dilate(A, W, H, s.stroke.size), s.stroke.opacity);
    // The layer over that, Normal by its own alpha.
    for (let i = 0; i < W * H; i++) {
        const as = A[i] / 255;
        if (as <= 0) continue;
        const o = i * 4, ab = out[o + 3] / 255, ao = as + ab * (1 - as);
        for (let c = 0; c < 3; c++) out[o + c] = q8(ao > 0 ? ((C[o + c] / 255) * as + (out[o + c] / 255) * ab * (1 - as)) / ao : 0);
        out[o + 3] = q8(ao);
    }
    return out;
}

// What a styled layer looks like is kept until its pixels, mask, place or style change: a buffer's
// version is BUF_VER's (the editor counts every change there), a mask's identity its own.
export const BUF_VER = new WeakMap();
const cache = new WeakMap();
const ids = new WeakMap();
let nextId = 1;
const idOf = (o) => { if (!o) return 0; let v = ids.get(o); if (!v) { v = nextId++; ids.set(o, v); } return v; };

export function styledCached(W, H, L, px, mask) {
    const sig = `${W}x${H}|${L.x},${L.y},${L.w},${L.h}|${BUF_VER.get(px) || 0}|${idOf(mask)}:${mask ? BUF_VER.get(mask) || 0 : 0}|`
        + JSON.stringify(L.mask || null) + JSON.stringify(L.style);
    const c = cache.get(px);
    if (c && c.sig === sig) return c.out;
    const out = styledPixels(W, H, L, px, mask);
    cache.set(px, { sig, out });
    return out;
}
