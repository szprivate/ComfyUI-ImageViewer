// imageViewer_paintFilters.js
// Paint's Filter menu beyond blur and sharpen: pure functions on a layer's pixels (straight RGBA
// Uint8ClampedArray, w * h * 4), each returning new pixels. Only the page runs these (what they make
// is saved as pixels), so there is no Python twin to keep in step.
//
// Written from the textbook definitions of these operations (unsharp masking, high-pass as the image
// minus its blur, a median by a sliding histogram, additive noise, a line-integral motion blur, block
// averaging), not from any other program's code.

import { blurFloat, q8 } from "./imageViewer_paintData.js";

/** The filters: id -> { label, fields: [key, label, default, min, max] | [key, label, default, [choices]], run(px, w, h, v) }. */
export const FILTERS = {
    unsharp: { label: "Unsharp Mask", fields: [["amount", "Amount (%)", 100, 1, 500], ["radius", "Radius (px)", 2, 0.1, 250], ["threshold", "Threshold (levels)", 0, 0, 255]],
               run: (px, w, h, v) => unsharpMask(px, w, h, v.radius, v.amount / 100, v.threshold) },
    high_pass: { label: "High Pass", fields: [["radius", "Radius (px)", 10, 0.1, 250]], run: (px, w, h, v) => highPass(px, w, h, v.radius) },
    median: { label: "Median (despeckle)", fields: [["radius", "Radius (px)", 2, 1, 30]], run: (px, w, h, v) => median(px, w, h, Math.round(v.radius)) },
    noise: { label: "Add Noise", fields: [["amount", "Amount (%)", 10, 0.1, 400], ["kind", "Distribution", "gaussian", ["gaussian", "uniform"]],
                                          ["mono", "Monochromatic", "no", ["no", "yes"]], ["seed", "Seed", 1, 0, 1e9]],
             run: (px, w, h, v) => addNoise(px, w, h, v.amount / 100, v.kind === "gaussian", v.mono === "yes", v.seed) },
    motion_blur: { label: "Motion Blur", fields: [["angle", "Angle (°)", 0, -360, 360], ["distance", "Distance (px)", 20, 1, 500]],
                   run: (px, w, h, v) => motionBlur(px, w, h, v.angle, v.distance) },
    pixelate: { label: "Pixelate (mosaic)", fields: [["size", "Cell size (px)", 16, 2, 500]], run: (px, w, h, v) => pixelate(px, w, h, Math.round(v.size)) },
};

const toFloat = (px, n) => { const f = new Float64Array(n * 3); for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) f[i * 3 + c] = px[i * 4 + c] / 255; return f; };

/** Unsharp mask: f + (f - blur(f)) * amount, where the difference is at least `threshold` levels. Alpha kept. */
export function unsharpMask(px, w, h, radius, amount, threshold = 0) {
    const n = w * h, f = toFloat(px, n), b = blurFloat(f, w, h, 3, radius);
    const out = new Uint8ClampedArray(px), th = threshold / 255;
    for (let i = 0; i < n; i++) {
        // The threshold is on the brightest channel's difference, so a pixel is sharpened whole or not at all.
        let dmax = 0;
        for (let c = 0; c < 3; c++) dmax = Math.max(dmax, Math.abs(f[i * 3 + c] - b[i * 3 + c]));
        if (dmax < th) continue;
        for (let c = 0; c < 3; c++) out[i * 4 + c] = q8(f[i * 3 + c] + (f[i * 3 + c] - b[i * 3 + c]) * amount);
    }
    return out;
}

/** High pass: 0.5 + (f - blur(f)) - grey where nothing changes. Alpha kept. */
export function highPass(px, w, h, radius) {
    const n = w * h, f = toFloat(px, n), b = blurFloat(f, w, h, 3, radius);
    const out = new Uint8ClampedArray(px);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 4 + c] = q8(0.5 + f[i * 3 + c] - b[i * 3 + c]);
    return out;
}

/** The median of each channel (alpha too) in a (2r+1)² square, edges clamped; a histogram slid along each row. */
export function median(px, w, h, r) {
    r = Math.max(1, Math.min(30, r | 0));
    const out = new Uint8ClampedArray(px.length);
    const half = ((2 * r + 1) * (2 * r + 1)) >> 1;
    const hist = new Int32Array(256);
    const cx = (x) => (x < 0 ? 0 : x >= w ? w - 1 : x), cy = (y) => (y < 0 ? 0 : y >= h ? h - 1 : y);
    for (let c = 0; c < 4; c++) {
        for (let y = 0; y < h; y++) {
            hist.fill(0);
            for (let dy = -r; dy <= r; dy++) {
                const row = cy(y + dy) * w;
                for (let dx = -r; dx <= r; dx++) hist[px[(row + cx(dx)) * 4 + c]]++;
            }
            for (let x = 0; x < w; x++) {
                if (x > 0) {
                    const xo = cx(x - r - 1), xi = cx(x + r);
                    for (let dy = -r; dy <= r; dy++) {
                        const row = cy(y + dy) * w;
                        hist[px[(row + xo) * 4 + c]]--;
                        hist[px[(row + xi) * 4 + c]]++;
                    }
                }
                let acc = 0, v = 0;
                for (; v < 256; v++) { acc += hist[v]; if (acc > half) break; }
                out[(y * w + x) * 4 + c] = v;
            }
        }
    }
    return out;
}

/** A small seeded generator (mulberry32), so the same seed gives the same noise. */
function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Noise added to the colour: uniform in ±amount, or Gaussian with sigma amount / 2; one value for all channels when mono. Alpha kept. */
export function addNoise(px, w, h, amount, gaussian = true, mono = false, seed = 1) {
    const n = w * h, out = new Uint8ClampedArray(px), rand = rng(Math.floor(seed));
    const one = () => {
        if (!gaussian) return (rand() * 2 - 1) * amount;
        // Box-Muller.
        const u = Math.max(1e-12, rand()), v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * (amount / 2);
    };
    for (let i = 0; i < n; i++) {
        if (px[i * 4 + 3] === 0) continue;
        const m = mono ? one() : 0;
        for (let c = 0; c < 3; c++) out[i * 4 + c] = q8(px[i * 4 + c] / 255 + (mono ? m : one()));
    }
    return out;
}

/** The average along a line `distance` long through each pixel at `angle` (degrees, 0 = left-right), premultiplied, bilinear. */
export function motionBlur(px, w, h, angle, distance) {
    const n = w * h;
    const steps = Math.max(1, Math.round(distance));
    const a = (angle * Math.PI) / 180, ux = Math.cos(a), uy = -Math.sin(a);
    const pm = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
        const al = px[i * 4 + 3] / 255;
        for (let c = 0; c < 3; c++) pm[i * 4 + c] = (px[i * 4 + c] / 255) * al;
        pm[i * 4 + 3] = al;
    }
    const out = new Uint8ClampedArray(n * 4);
    const acc = new Float64Array(4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        acc.fill(0);
        for (let s = 0; s <= steps; s++) {
            const t = s / steps - 0.5;
            let sx = x + ux * t * distance, sy = y + uy * t * distance;
            sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
            sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
            const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
            const fx = sx - x0, fy = sy - y0;
            const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
            for (let c = 0; c < 4; c++) {
                acc[c] += (pm[i00 + c] * (1 - fx) + pm[i10 + c] * fx) * (1 - fy) + (pm[i01 + c] * (1 - fx) + pm[i11 + c] * fx) * fy;
            }
        }
        const k = steps + 1, o = (y * w + x) * 4, al = acc[3] / k;
        for (let c = 0; c < 3; c++) out[o + c] = q8(al > 0 ? acc[c] / k / Math.max(al, 1e-12) : 0);
        out[o + 3] = q8(al);
    }
    return out;
}

/** Cells of `size` x `size` (from the layer's corner), each its average colour (premultiplied). */
export function pixelate(px, w, h, size) {
    size = Math.max(1, size | 0);
    const out = new Uint8ClampedArray(px.length);
    for (let y0 = 0; y0 < h; y0 += size) for (let x0 = 0; x0 < w; x0 += size) {
        const x1 = Math.min(w, x0 + size), y1 = Math.min(h, y0 + size);
        let r = 0, g = 0, b = 0, a = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4, al = px[i + 3] / 255;
            r += (px[i] / 255) * al; g += (px[i + 1] / 255) * al; b += (px[i + 2] / 255) * al; a += al;
        }
        const k = (x1 - x0) * (y1 - y0), al = a / k;
        const cr = q8(a > 0 ? r / a : 0), cg = q8(a > 0 ? g / a : 0), cb = q8(a > 0 ? b / a : 0), ca = q8(al);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; out[i] = cr; out[i + 1] = cg; out[i + 2] = cb; out[i + 3] = ca; }
    }
    return out;
}
