// The Comp space's Paint node: strokes laid on the picture that comes in - colour, clone, reveal and erase -
// each living on one frame, from a frame on, between two frames or on every frame. Pure: no DOM; the twin is
// src/comp_paint.py and tests/test_comp_parity.py compares the two.
//
// A stroke is a list of points in pixels of the picture that comes into the node (y down from its top row) and
// a round brush: Paint's own dab (`dabAt`: a disc with a smooth edge from `hard` out) placed along the line
// `spacing` x its diameter apart (`dabsAlong`). A stroke keeps the most any of its dabs gave a pixel (it does not
// build up over itself), times its opacity, as Paint's brush does:
//   colour  out = colour x a x k + out x (1 - a x k)       (premultiplied over)
//   erase   out = out x (1 - k)                            (every channel, alpha too)
//   clone   out = out x (1 - k) + S x k, S = the picture as it stands before this stroke, `offset` away
//           (or the input at `dt` frames from here, unpainted, when dt is not 0)
//   reveal  out = out x (1 - k) + S x k, S = the second input ("reveal") at `dt` frames from here, `offset` away
// A stroke can follow a Transform node (`link`): its points move by that node's matrix at the frame shown,
// taken back through its matrix at the frame the stroke was drawn on.

import { dabAt, dabsAlong } from "./imageViewer_paintData.js";

export const PAINT_TOOLS = ["color", "clone", "reveal", "erase"];
export const PAINT_TOOL_LABELS = { color: "Brush", clone: "Clone", reveal: "Reveal", erase: "Eraser" };
/** Where a stroke lives in time: on every frame, on its frame only, from its frame on, up to it, or between f and f1. */
export const PAINT_LIFE = ["all", "single", "from", "to", "range"];
export const PAINT_LIFE_LABELS = { all: "all frames", single: "this frame", from: "from here on", to: "up to here", range: "frames f to f1" };
export const STROKE_DEFAULTS = { tool: "color", size: 40, hard: 0.6, opacity: 1, spacing: 0.1, color: [1, 1, 1, 1], offset: [0, 0], dt: 0, life: "all", f: 0 };
const MAX_POINTS = 20000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clampN = (v, lo, hi, d) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** A stroke as the arithmetic takes it (bad numbers replaced by the defaults); null when it has no points. */
export function cleanStroke(s) {
    if (!s || typeof s !== "object" || !Array.isArray(s.pts)) return null;
    const pts = [];
    for (const p of s.pts) {
        if (pts.length >= MAX_POINTS) break;
        if (Array.isArray(p) && isNum(p[0]) && isNum(p[1])) pts.push([p[0], p[1]]);
    }
    if (!pts.length) return null;
    const D = STROKE_DEFAULTS;
    const vec = (v, d) => (Array.isArray(v) && isNum(v[0]) && isNum(v[1]) ? [v[0], v[1]] : d.slice());
    const col = Array.isArray(s.color) && s.color.length >= 3 && s.color.slice(0, 4).every(isNum)
        ? [s.color[0], s.color[1], s.color[2], isNum(s.color[3]) ? clampN(s.color[3], 0, 1, 1) : 1] : D.color.slice();
    const out = {
        tool: PAINT_TOOLS.includes(s.tool) ? s.tool : D.tool,
        pts,
        size: clampN(s.size, 0.5, 4000, D.size),
        hard: clampN(s.hard, 0, 1, D.hard),
        opacity: clampN(s.opacity, 0, 1, D.opacity),
        spacing: clampN(s.spacing, 0.02, 2, D.spacing),
        color: col,
        offset: vec(s.offset, D.offset),
        dt: isNum(s.dt) ? Math.round(s.dt) : 0,
        life: PAINT_LIFE.includes(s.life) ? s.life : D.life,
        f: isNum(s.f) ? Math.round(s.f) : 0,
    };
    if (out.life === "range") out.f1 = isNum(s.f1) ? Math.round(s.f1) : out.f;
    if (typeof s.link === "string" && s.link) out.link = s.link;
    if (s.off) out.off = true;
    if (typeof s.name === "string" && s.name) out.name = s.name.slice(0, 80);
    return out;
}

/** Whether a (clean) stroke is on frame f. */
export function strokeLive(s, f) {
    if (!s || s.off) return false;
    switch (s.life) {
    case "single": return f === s.f;
    case "from": return f >= s.f;
    case "to": return f <= s.f;
    case "range": return f >= Math.min(s.f, s.f1) && f <= Math.max(s.f, s.f1);
    default: return true;
    }
}

/** The strokes of a node that are on frame f, cleaned, in the order they are laid. */
export function liveStrokes(strokes, f) {
    const out = [];
    for (const raw of Array.isArray(strokes) ? strokes : []) {
        const s = cleanStroke(raw);
        if (s && strokeLive(s, f)) out.push(s);
    }
    return out;
}

/** The dab centres of a stroke in full-size pixels, its points first taken through `m` (a 2 x 3 matrix) if given. */
export function strokeDabs(s, m = null) {
    const P = m ? s.pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]) : s.pts;
    const r = s.size / 2;
    const out = [[P[0][0], P[0][1]]];
    let carry = 0;
    for (let i = 1; i < P.length; i++) {
        const [x0, y0] = P[i - 1], [x1, y1] = P[i];
        if (x0 === x1 && y0 === y1) continue;
        const d = dabsAlong(x0, y0, x1, y1, r, s.spacing, carry);
        for (const p of d.dabs) out.push(p);
        carry = d.carry;
    }
    return out;
}

/**
 * How much of each pixel of a w x h picture (`scale` x the full size) a stroke covers, 0..1: the most any dab
 * gave it. Returns { cover: Float64Array(w * h), x0, y0, x1, y1 } (the box touched, x1 / y1 past its end), or
 * null when it touches nothing.
 */
export function strokeCover(s, w, h, scale = 1, m = null) {
    const dabs = strokeDabs(s, m), r = (s.size / 2) * scale, hard = s.hard;
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
    for (const [x, y] of dabs) {
        const cx = x * scale, cy = y * scale;
        bx0 = Math.min(bx0, Math.max(0, Math.floor(cx - r))); by0 = Math.min(by0, Math.max(0, Math.floor(cy - r)));
        bx1 = Math.max(bx1, Math.min(w, Math.ceil(cx + r))); by1 = Math.max(by1, Math.min(h, Math.ceil(cy + r)));
    }
    if (bx1 <= bx0 || by1 <= by0) return null;
    const cover = new Float64Array(w * h);
    for (const [x, y] of dabs) {
        const cx = x * scale, cy = y * scale;
        const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
        const x1 = Math.min(w, Math.ceil(cx + r)), y1 = Math.min(h, Math.ceil(cy + r));
        for (let py = y0; py < y1; py++) {
            const dy = py + 0.5 - cy;
            for (let px = x0; px < x1; px++) {
                const a = dabAt(Math.hypot(px + 0.5 - cx, dy), r, hard);
                const i = py * w + px;
                if (a > cover[i]) cover[i] = a;
            }
        }
    }
    return { cover, x0: bx0, y0: by0, x1: bx1, y1: by1 };
}

/**
 * The strokes laid on `img` (premultiplied float RGBA {w, h, data}; a new picture is returned). `scale` is the
 * picture's share of the full size. `sourceOf(stroke, current)` gives a clone / reveal stroke's picture already
 * moved by its offset (null: the stroke does nothing); `matrixOf(stroke)` its link's matrix or null.
 */
export function paintImage(img, strokes, scale, sourceOf, matrixOf = () => null) {
    const w = img.w, h = img.h;
    const out = { w, h, data: Float32Array.from(img.data) };
    const o = out.data;
    for (const s of strokes) {
        const cv = strokeCover(s, w, h, scale, matrixOf(s));
        if (!cv) continue;
        const { cover, x0, y0, x1, y1 } = cv, op = s.opacity;
        let S = null;
        if (s.tool === "clone" || s.tool === "reveal") { S = sourceOf(s, out); if (!S) continue; }
        const c = s.color, ca = c[3], cr = c[0] * ca, cg = c[1] * ca, cb = c[2] * ca;
        for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
            const i = py * w + px, k = cover[i] * op;
            if (!(k > 0)) continue;
            const j = i * 4;
            if (s.tool === "color") {
                const keep = 1 - ca * k;
                o[j] = cr * k + o[j] * keep; o[j + 1] = cg * k + o[j + 1] * keep; o[j + 2] = cb * k + o[j + 2] * keep; o[j + 3] = ca * k + o[j + 3] * keep;
            } else if (s.tool === "erase") {
                const keep = 1 - k;
                o[j] = o[j] * keep; o[j + 1] = o[j + 1] * keep; o[j + 2] = o[j + 2] * keep; o[j + 3] = o[j + 3] * keep;
            } else {
                const keep = 1 - k, d = S.data;
                o[j] = o[j] * keep + d[j] * k; o[j + 1] = o[j + 1] * keep + d[j + 1] * k; o[j + 2] = o[j + 2] * keep + d[j + 2] * k; o[j + 3] = o[j + 3] * keep + d[j + 3] * k;
            }
        }
    }
    return out;
}

/** The frames of its input a Paint node reads at frame f besides f itself (clone / reveal strokes with a dt). */
export function paintFrames(strokes, f) {
    const clone = new Set(), reveal = new Set();
    for (const s of liveStrokes(strokes, f)) {
        if (s.tool === "clone" && s.dt) clone.add(f + s.dt);
        if (s.tool === "reveal") reveal.add(f + s.dt);
    }
    return { clone: [...clone], reveal: [...reveal] };
}

/** The bounding box of a stroke's points, grown by its radius (for picking a stroke on the picture). */
export function strokeBox(s) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const r = s.size / 2;
    return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}

/** The index of the topmost live stroke whose line passes within its radius of (x, y), or -1. */
export function strokeAt(strokes, f, x, y) {
    const list = Array.isArray(strokes) ? strokes : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const s = cleanStroke(list[i]);
        if (!s || !strokeLive(s, f)) continue;
        const r = Math.max(3, s.size / 2), P = s.pts;
        for (let k = 0; k < P.length; k++) {
            const [ax, ay] = P[k], [bx, by] = P[Math.min(P.length - 1, k + 1)];
            const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
            const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
            if (Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) <= r) return i;
        }
    }
    return -1;
}

/** Points closer than `minGap` to the one before are left out (a pointer move of less than that adds nothing). */
export function thinPoints(pts, minGap = 0.75) {
    const out = [];
    for (const p of pts) {
        const q = out[out.length - 1];
        if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= minGap) out.push([Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    }
    return out;
}
