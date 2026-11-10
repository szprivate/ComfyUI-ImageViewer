// Paint's gradient, shapes and smudge: the arithmetic (pure, tested in tests/test_paint_draw.mjs; the
// gradient and the shapes' outlines have twins in src/paint_math.py - gradient_share / gradient_pixels /
// shape_path - compared by tests/test_paint_parity.py) and DrawMixin, the two tools on the editor.
// The dodge, burn and sponge brushes are in paintData.js (`toneAt`, used inside `stamp`).
// Written from what the tools do, not from any other program's code.
import * as D from "./imageViewer_paintData.js";

export const GRADIENT_TYPES = ["linear", "radial", "angle", "reflected", "diamond"];
export const GRADIENT_LABELS = { linear: "Linear", radial: "Radial", angle: "Angle", reflected: "Reflected", diamond: "Diamond" };
export const SHAPE_KINDS = ["rect", "rounded", "ellipse", "polygon", "line"];
export const SHAPE_LABELS = { rect: "Rectangle", rounded: "Rounded rectangle", ellipse: "Ellipse", polygon: "Polygon", line: "Line" };
/** A quarter of a circle as one cubic: the handles this far along the tangents (of the radius). */
export const KAPPA = 0.5522847498307936;

/**
 * Where (x, y) lies along a gradient dragged from (x0, y0) to (x1, y1): 0 at the start, 1 at the end and beyond.
 * The pixel's middle is passed in by the caller (x + 0.5).
 */
export function gradientShare(type, x, y, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len < 1e-9) return 0;
    const px = x - x0, py = y - y0;
    let t;
    if (type === "radial") t = Math.hypot(px, py) / len;
    else if (type === "angle") {
        t = (Math.atan2(py, px) - Math.atan2(dy, dx)) / (2 * Math.PI);
        t -= Math.floor(t);
        return t;
    } else if (type === "diamond") {
        const u = (px * dx + py * dy) / len, v = (px * dy - py * dx) / len;
        t = (Math.abs(u) + Math.abs(v)) / len;
    } else {
        t = (px * dx + py * dy) / (len * len);
        if (type === "reflected") t = Math.abs(t);
    }
    return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** The colours along a gradient: [{t, c: [r, g, b, a]}] (0..255), from a preset and the two colours. */
export function gradientStops(preset, fg, bg) {
    const F = [...fg.slice(0, 3), 255], B = [...bg.slice(0, 3), 255];
    if (preset === "fg-clear") return [{ t: 0, c: F }, { t: 1, c: [...F.slice(0, 3), 0] }];
    if (preset === "bw") return [{ t: 0, c: [0, 0, 0, 255] }, { t: 1, c: [255, 255, 255, 255] }];
    if (preset === "fg-bg-fg") return [{ t: 0, c: F }, { t: 0.5, c: B }, { t: 1, c: F }];
    return [{ t: 0, c: F }, { t: 1, c: B }];
}

/** Held to 0..1, in order, at least two (the agent's and the page's stops alike). */
export function cleanStops(stops) {
    const out = (Array.isArray(stops) ? stops : [])
        .map((s) => ({ t: Math.min(1, Math.max(0, Number(s.t) || 0)), c: [0, 1, 2, 3].map((k) => Math.min(255, Math.max(0, Math.round(Number((s.c || [])[k] ?? (k === 3 ? 255 : 0)))))) }))
        .sort((a, b) => a.t - b.t);
    if (out.length === 1) out.push({ t: 1, c: out[0].c.slice() });
    return out.length ? out : [{ t: 0, c: [0, 0, 0, 255] }, { t: 1, c: [255, 255, 255, 255] }];
}

/** The colour at t (0..1), straight RGBA 0..1 - mixed premultiplied, so a colour fading out does not darken. */
export function gradientColor(stops, t) {
    const n = stops.length;
    let a = stops[0], b = stops[0], f = 0;
    if (t <= stops[0].t) { a = b = stops[0]; }
    else if (t >= stops[n - 1].t) { a = b = stops[n - 1]; }
    else {
        for (let i = 0; i < n - 1; i++) {
            if (t <= stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1; break; }
        }
    }
    const aa = a.c[3] / 255, ba = b.c[3] / 255;
    const al = aa + (ba - aa) * f;
    const out = [0, 0, 0, al];
    for (let c = 0; c < 3; c++) {
        const pa = (a.c[c] / 255) * aa, pb = (b.c[c] / 255) * ba;
        out[c] = al > 0 ? (pa + (pb - pa) * f) / al : (a.c[c] + (b.c[c] - a.c[c]) * f) / 255;
    }
    return out;
}

/**
 * A gradient's pixels over a w x h box whose top left lies at (ox, oy) on the canvas: RGBA 0..255.
 * g = { type, x0, y0, x1, y1, stops, reverse }.
 */
export function gradientPixels(w, h, ox, oy, g) {
    const out = new Uint8ClampedArray(w * h * 4);
    const stops = cleanStops(g.stops);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let t = gradientShare(g.type, x + ox + 0.5, y + oy + 0.5, g.x0, g.y0, g.x1, g.y1);
            if (g.reverse) t = 1 - t;
            const c = gradientColor(stops, t), o = (y * w + x) * 4;
            out[o] = D.q8(c[0]); out[o + 1] = D.q8(c[1]); out[o + 2] = D.q8(c[2]); out[o + 3] = D.q8(c[3]);
        }
    }
    return out;
}

/** src (RGBA) laid Normal over px (the same size) by src's alpha x opacity x t[i]/255 (t may be null: all). */
export function layOver(px, src, opacity = 1, t = null) {
    const out = new Uint8ClampedArray(px);
    for (let i = 0; i < px.length / 4; i++) {
        const o = i * 4;
        const as = (src[o + 3] / 255) * opacity * (t ? t[i] / 255 : 1);
        if (as <= 0) continue;
        const ab = px[o + 3] / 255, ao = as + ab * (1 - as);
        for (let c = 0; c < 3; c++) out[o + c] = D.q8(ao > 0 ? ((src[o + c] / 255) * as + (px[o + c] / 255) * ab * (1 - as)) / ao : 0);
        out[o + 3] = D.q8(ao);
    }
    return out;
}

const pt = (x, y, ix = x, iy = y, ox = x, oy = y, smooth = false) => ({ x, y, ix, iy, ox, oy, smooth });

/**
 * A shape's outline as a pen path ({closed, pts}, paintData's path format), in the box (x0, y0)-(x1, y1)
 * (a line: from the first point to the second). o: { radius (rounded corners, px), sides (polygon) }.
 */
export function shapePath(kind, x0, y0, x1, y1, o = {}) {
    if (kind === "line") return { closed: false, pts: [pt(x0, y0), pt(x1, y1)] };
    const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
    const w = r - l, h = b - t, cx = (l + r) / 2, cy = (t + b) / 2;
    if (kind === "ellipse") {
        const kx = (KAPPA * w) / 2, ky = (KAPPA * h) / 2;
        return { closed: true, pts: [
            pt(cx, t, cx - kx, t, cx + kx, t, true), pt(r, cy, r, cy - ky, r, cy + ky, true),
            pt(cx, b, cx + kx, b, cx - kx, b, true), pt(l, cy, l, cy + ky, l, cy - ky, true)] };
    }
    if (kind === "polygon") {
        const n = Math.max(3, Math.min(64, Math.round(o.sides || 6)));
        const pts = [];
        for (let i = 0; i < n; i++) {
            const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
            pts.push(pt(cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a)));
        }
        return { closed: true, pts };
    }
    const rr = kind === "rounded" ? Math.max(0, Math.min(Number(o.radius) || 0, w / 2, h / 2)) : 0;
    if (rr <= 0) return { closed: true, pts: [pt(l, t), pt(r, t), pt(r, b), pt(l, b)] };
    const k = KAPPA * rr;
    return { closed: true, pts: [
        pt(l + rr, t, l + rr - k, t), pt(r - rr, t, r - rr, t, r - rr + k, t),
        pt(r, t + rr, r, t + rr - k), pt(r, b - rr, r, b - rr, r, b - rr + k),
        pt(r - rr, b, r - rr + k, b), pt(l + rr, b, l + rr, b, l + rr - k, b),
        pt(l, b - rr, l, b - rr + k), pt(l, t + rr, l, t + rr, l, t + rr - k)] };
}

/** The end of a drag held to the nearest 45° about its start (Shift). */
export function snap45(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return [x0 + len * Math.cos(a), y0 + len * Math.sin(a)];
}

/** A shape's box from a drag: Shift makes it as wide as tall, Alt grows it about where the drag began. */
export function shapeBox(x0, y0, x1, y1, square, centre) {
    let w = x1 - x0, h = y1 - y0;
    if (square) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
    return centre ? [x0 - w, y0 - h, x0 + w, y0 + h] : [x0, y0, x0 + w, y0 + h];
}

/**
 * One dab of the smudge brush: what the brush carries (st.smudge.buf, premultiplied, a square of
 * st.smudge.n about the dab's middle) is laid down by the dab's cover x strength, and the brush then
 * picks up what it has put down - strength 1 drags the first colour all the way, 0 nothing.
 * The first dab only picks up (or, finger painting, the brush starts with the colour). Returns the rect it changed.
 */
export function smudgeDab(st, cx, cy, radius, hard, strength) {
    const sm = st.smudge, n = sm.n, half = (n - 1) / 2, { lw, lh, lx, ly, px } = st;
    const ix = Math.round(cx - lx), iy = Math.round(cy - ly);
    const first = !sm.started;
    sm.started = true;
    let rect = null;
    for (let j = 0; j < n; j++) {
        const y = iy - half + j;
        if (y < 0 || y >= lh) continue;
        for (let i = 0; i < n; i++) {
            const x = ix - half + i;
            if (x < 0 || x >= lw) continue;
            const o = (y * lw + x) * 4, b = (j * n + i) * 4;
            const pa = px[o + 3] / 255;
            const p = [(px[o] / 255) * pa, (px[o + 1] / 255) * pa, (px[o + 2] / 255) * pa, pa];
            if (first && !sm.finger) { for (let c = 0; c < 4; c++) sm.buf[b + c] = p[c]; continue; }
            let a = D.dabAt(Math.hypot(x + 0.5 - (ix + 0.5), y + 0.5 - (iy + 0.5)), radius, hard);
            if (a > 0 && st.sel) {
                const gx = x + lx, gy = y + ly;
                a *= gx >= 0 && gy >= 0 && gx < st.W && gy < st.H ? st.sel[gy * st.W + gx] / 255 : 0;
            }
            const k = a * strength;
            if (k > 0 && !(st.lockAlpha && px[o + 3] === 0)) {
                const q = [0, 0, 0, 0];
                for (let c = 0; c < 4; c++) q[c] = p[c] + (sm.buf[b + c] - p[c]) * k;
                // Locked transparency: the colour changes, the alpha stays.
                if (!st.lockAlpha) px[o + 3] = D.q8(q[3]);
                for (let c = 0; c < 3; c++) px[o + c] = D.q8(q[3] > 0 ? q[c] / q[3] : 0);
                for (let c = 0; c < 4; c++) p[c] = q[c];
                rect = { x0: Math.min(rect ? rect.x0 : x, x), y0: Math.min(rect ? rect.y0 : y, y), x1: Math.max(rect ? rect.x1 : x + 1, x + 1), y1: Math.max(rect ? rect.y1 : y + 1, y + 1) };
            }
            // The brush picks up what is under it now; where the dab is full it keeps `strength` of what it had.
            const keep = strength * a;
            for (let c = 0; c < 4; c++) sm.buf[b + c] = p[c] + (sm.buf[b + c] - p[c]) * keep;
        }
    }
    return rect;
}

/**
 * One dab of the blur brush (Photoshop's Blur tool): the pixels under the dab are softened by a small box blur
 * (two passes, premultiplied, so a transparent edge does not darken) of what is there NOW, mixed in by the dab's
 * cover x strength - so going over a place again in the stroke blurs it more. The blur's reach grows with the
 * brush (`blurReach`). Locked transparency keeps the alpha; the selection limits it. Returns the rect it changed.
 */
export function blurDab(st, cx, cy, radius, hard, strength) {
    const { lw, lh, lx, ly, px } = st;
    if (strength <= 0) return null;
    const k = blurReach(radius);
    const x0 = Math.max(0, Math.floor(cx - radius - lx)), y0 = Math.max(0, Math.floor(cy - radius - ly));
    const x1 = Math.min(lw, Math.ceil(cx + radius - lx) + 1), y1 = Math.min(lh, Math.ceil(cy + radius - ly) + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    // What is read: the dab's box and the blur's reach around it.
    const ax = Math.max(0, x0 - 2 * k), ay = Math.max(0, y0 - 2 * k), bx = Math.min(lw, x1 + 2 * k), by = Math.min(lh, y1 + 2 * k);
    const w = bx - ax, h = by - ay;
    let a = new Float32Array(w * h * 4), b = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = ((y + ay) * lw + x + ax) * 4, q = (y * w + x) * 4, al = px[o + 3] / 255;
        a[q] = (px[o] / 255) * al; a[q + 1] = (px[o + 1] / 255) * al; a[q + 2] = (px[o + 2] / 255) * al; a[q + 3] = al;
    }
    // A box of 2k+1 along x, then along y; twice (close to a Gaussian). At the layer's edge: the mean of what is there.
    const pass = (src, dst, horiz) => {
        const n = horiz ? w : h, m = horiz ? h : w;
        for (let l = 0; l < m; l++) {
            const at = (t) => (horiz ? l * w + t : t * w + l) * 4;
            const sum = [0, 0, 0, 0];
            let cnt = 0;
            for (let t = 0; t <= Math.min(k, n - 1); t++) { const q = at(t); for (let c = 0; c < 4; c++) sum[c] += src[q + c]; cnt++; }
            for (let t = 0; t < n; t++) {
                const q = at(t);
                for (let c = 0; c < 4; c++) dst[q + c] = sum[c] / cnt;
                const add = t + k + 1, drop = t - k;
                if (add < n) { const r = at(add); for (let c = 0; c < 4; c++) sum[c] += src[r + c]; cnt++; }
                if (drop >= 0) { const r = at(drop); for (let c = 0; c < 4; c++) sum[c] -= src[r + c]; cnt--; }
            }
        }
    };
    for (let i = 0; i < 2; i++) { pass(a, b, true); pass(b, a, false); }
    let rect = null;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        let t = D.dabAt(Math.hypot(x + 0.5 + lx - cx, y + 0.5 + ly - cy), radius, hard);
        if (t > 0 && st.sel) {
            const gx = x + lx, gy = y + ly;
            t *= gx >= 0 && gy >= 0 && gx < st.W && gy < st.H ? st.sel[gy * st.W + gx] / 255 : 0;
        }
        t *= strength;
        const o = (y * lw + x) * 4;
        if (t <= 0 || (st.lockAlpha && px[o + 3] === 0)) continue;
        const q = ((y - ay) * w + x - ax) * 4, al = px[o + 3] / 255;
        const p = [(px[o] / 255) * al, (px[o + 1] / 255) * al, (px[o + 2] / 255) * al, al];
        const v = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++) v[c] = p[c] + (a[q + c] - p[c]) * t;
        // Locked transparency (and a mask, whose alpha is always full): the colour softens, the alpha stays.
        if (!st.lockAlpha) px[o + 3] = D.q8(v[3]);
        for (let c = 0; c < 3; c++) px[o + c] = D.q8(v[3] > 0 ? Math.min(1, v[c] / v[3]) : 0);
        rect = { x0: Math.min(rect ? rect.x0 : x, x), y0: Math.min(rect ? rect.y0 : y, y), x1: Math.max(rect ? rect.x1 : x + 1, x + 1), y1: Math.max(rect ? rect.y1 : y + 1, y + 1) };
    }
    return rect;
}

/** How far the blur brush reaches (the box's half width), from the dab's radius: a quarter of it, 1 to 12 px. */
export function blurReach(radius) { return Math.max(1, Math.min(12, Math.round(radius / 4))); }

/** The smudge brush's buffer for a stroke whose largest dab is `radius` (finger painting: full of `color`). */
export function smudgeStart(radius, finger, color) {
    const n = 2 * Math.ceil(radius) + 1, buf = new Float32Array(n * n * 4);
    if (finger) for (let i = 0; i < n * n; i++) buf.set([color[0] / 255, color[1] / 255, color[2] / 255, 1], i * 4);
    return { n, buf, finger: !!finger, started: false };
}

// ── the tools on the editor ──────────────────────────────────────────────────

export const DrawMixin = {
    /** The gradient tool's press: a drag from here to where it is let go. */
    _gradDown(p, e) {
        this._tfSettle();
        const [sx, sy] = this._snapPt(p.x, p.y);
        this._drag = { kind: "grad", x0: sx, y0: sy, x1: sx, y1: sy, e };
    },

    _gradMove(dr, p, e) {
        [dr.x1, dr.y1] = e.shiftKey ? snap45(dr.x0, dr.y0, p.x, p.y) : this._snapPt(p.x, p.y);
        // On a big picture the gradient is shown as it is dragged (at about the screen's resolution).
        this._previewGradient(dr);
        this.drawOverlay();
    },

    _gradUp(dr) {
        if (Math.hypot(dr.x1 - dr.x0, dr.y1 - dr.y0) < 1) { this.drawOverlay(); return; }
        this.gradient(dr.x0, dr.y0, dr.x1, dr.y1);
    },

    /** The gradient (the tool's options) from (x0, y0) to (x1, y1): onto the layer in the selection, or into its mask. */
    gradient(x0, y0, x1, y1, o = this.opts.gradient) {
        const W = this.doc.w, H = this.doc.h;
        const g = { type: o.type, x0, y0, x1, y1, reverse: !!o.reverse, stops: gradientStops(o.preset, this.fg, this.bg) };
        const opacity = o.opacity / 100;
        if (this._maskUp()) {
            // A mask: the gradient's grey (its alpha fading it to what the mask was), in the selection.
            const gp = gradientPixels(W, H, 0, 0, g), v = new Uint8Array(W * H), area = new Uint8Array(W * H);
            for (let i = 0; i < W * H; i++) {
                v[i] = Math.round(0.2126 * gp[i * 4] + 0.7152 * gp[i * 4 + 1] + 0.0722 * gp[i * 4 + 2]);
                area[i] = Math.round(gp[i * 4 + 3] * opacity * (this.sel && !this.quick ? this.sel[i] / 255 : 1));
            }
            return this._fillMaskArea(area, v, "Gradient");
        }
        const L = this._pixelTarget("Gradient");
        if (!L) return false;
        return this.change("Gradient", () => {
            const px = this._growToCanvas(L);
            const gp = gradientPixels(L.w, L.h, L.x, L.y, g);
            const t = this.sel ? D.maskForLayer(this.sel, W, H, L) : null;
            this.pix.set(L.id, this._keepAlpha(L, px, layOver(px, gp, opacity, t)));
        });
    },

    /** The shape tool's press: a box (Shift square, Alt about the middle) or a line. */
    _shapeDown(p, e) {
        this._tfSettle();
        const [sx, sy] = this._snapPt(p.x, p.y);
        this._drag = { kind: "shape", x0: sx, y0: sy, x1: sx, y1: sy, e, sq: false, ctr: false };
    },

    _shapeMove(dr, p, e) {
        const line = this.opts.shape.kind === "line";
        if (line) [dr.x1, dr.y1] = e.shiftKey ? snap45(dr.x0, dr.y0, p.x, p.y) : this._snapPt(p.x, p.y);
        else [dr.x1, dr.y1] = this._snapPt(p.x, p.y);
        dr.sq = e.shiftKey && !line; dr.ctr = e.altKey && !line;
        this.drawOverlay();
    },

    /** The path the drag would make. */
    _shapeOf(dr) {
        const o = this.opts.shape;
        const [a, b, c, d] = o.kind === "line" ? [dr.x0, dr.y0, dr.x1, dr.y1] : shapeBox(dr.x0, dr.y0, dr.x1, dr.y1, dr.sq, dr.ctr);
        return shapePath(o.kind, a, b, c, d, { radius: o.radius, sides: o.sides });
    },

    _shapeUp(dr) {
        if (Math.hypot(dr.x1 - dr.x0, dr.y1 - dr.y0) < 2) { this.drawOverlay(); return; }
        this.shape(this._shapeOf(dr));
    },

    /**
     * A shape onto a new layer of its own (filled with the colour, its edge in the second colour - or
     * the colour when it is only an edge), or kept as a pen path (Mode: Path).
     */
    shape(path, o = this.opts.shape) {
        const W = this.doc.w, H = this.doc.h, name = SHAPE_LABELS[o.kind] || "Shape";
        const P = D.cleanPath({ ...path, name: `${name} ${(this.doc.paths || []).length + 1}` });
        if (o.mode === "path") {
            return this.change(`${name} path`, () => {
                this.doc.paths = [...(this.doc.paths || []), P];
                this.pathId = P.id;
            });
        }
        const fill = o.kind !== "line" && o.fill, stroke = o.kind === "line" || o.stroke;
        if (!fill && !stroke) { this._notify("The shape is neither filled nor stroked: switch one on.", "info"); return false; }
        let px = new Uint8ClampedArray(W * H * 4);
        if (fill) px = D.fillOver(px, W, H, [...this.fg, 255], D.pathMask(W, H, P), 255);
        if (stroke) {
            const col = fill ? this.bg : this.fg;
            px = D.fillOver(px, W, H, [...col, 255], D.strokeMask(W, H, D.flattenPath(P), P.closed, o.kind === "line" ? o.lineWidth : o.width), 255);
        }
        const n = this.doc.layers.filter((L) => L.name.startsWith(name + " ")).length + 1;
        return this.addPixelLayer(px, W, H, `${name} ${n}`);
    },

    /** The gradient's line and the shape being drawn. */
    _drawDraw(c, X, Y) {
        const dr = this._drag;
        if (dr && dr.kind === "grad") {
            c.lineWidth = 1.5; c.strokeStyle = "#fff"; c.setLineDash([]);
            c.beginPath(); c.moveTo(X(dr.x0), Y(dr.y0)); c.lineTo(X(dr.x1), Y(dr.y1)); c.stroke();
            c.strokeStyle = "#000"; c.lineWidth = 0.5; c.stroke();
            for (const [x, y] of [[dr.x0, dr.y0], [dr.x1, dr.y1]]) { c.fillStyle = "#fff"; c.fillRect(X(x) - 3, Y(y) - 3, 6, 6); c.strokeRect(X(x) - 3, Y(y) - 3, 6, 6); }
        }
        if (dr && dr.kind === "shape") {
            const line = D.flattenPath(D.cleanPath(this._shapeOf(dr)));
            if (line.length < 2) return;
            c.strokeStyle = "#fff"; c.lineWidth = 1; c.setLineDash([5, 3]);
            c.beginPath();
            line.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))));
            if (this.opts.shape.kind !== "line") c.closePath();
            c.stroke(); c.setLineDash([]);
        }
    },

    _drawOptions(ts, bar, sync, note) {
        const sel = (obj, key, pairs, title, cls = "") => {
            const s = this.el("select", cls, { title });
            for (const [v, t] of pairs) s.append(this.el("option", "", { value: v, text: t }));
            s.value = obj[key];
            s.addEventListener("change", () => { obj[key] = s.value; this.refreshProps(); sync(); });
            return s;
        };
        const check = (obj, key, text, title = "") => {
            const c = this.el("input", "", { type: "checkbox", checked: !!obj[key] });
            c.addEventListener("change", () => { obj[key] = c.checked; sync(); });
            const l = this.el("label", "paint-check", { title });
            l.append(c, this.el("span", "", { text }));
            return l;
        };
        if (this.tool === "gradient") {
            const g = this.opts.gradient;
            this._field(ts, "Type", sel(g, "type", GRADIENT_TYPES.map((t) => [t, GRADIENT_LABELS[t]]), "How the colours spread from the drag's start", "grad-type"));
            this._field(ts, "Colours", sel(g, "preset", [["fg-bg", "Colour to second colour"], ["fg-clear", "Colour to transparent"], ["fg-bg-fg", "Colour, second, colour"], ["bw", "Black to white"]], "", "grad-preset"));
            this._slider(ts, "Opacity", g.opacity, 1, 100, 1, (v) => { g.opacity = v; sync(); });
            this._field(ts, "", [check(g, "reverse", "Reverse")]);
            note("Drag across the picture (Shift: in 45° steps). On a layer it goes into the selection; with the mask picked, into the mask.");
        } else if (this.tool === "shape") {
            const s = this.opts.shape;
            this._field(ts, "Shape", sel(s, "kind", SHAPE_KINDS.map((k) => [k, SHAPE_LABELS[k]]), "Shift+U: the next shape", "shape-kind"));
            this._field(ts, "Make", sel(s, "mode", [["pixels", "A new layer"], ["path", "A path"]], "A new layer with the shape in it, or a pen path to use later", "shape-mode"));
            if (s.kind === "rounded") this._slider(ts, "Radius", s.radius, 0, 1000, 1, (v) => { s.radius = v; sync(); });
            if (s.kind === "polygon") this._slider(ts, "Sides", s.sides, 3, 64, 1, (v) => { s.sides = v; sync(); });
            if (s.mode === "pixels") {
                if (s.kind === "line") this._slider(ts, "Width", s.lineWidth, 1, 500, 0.5, (v) => { s.lineWidth = v; sync(); });
                else {
                    this._field(ts, "", [check(s, "fill", "Fill", "Filled with the colour"), check(s, "stroke", "Edge", "An edge in the second colour")]);
                    this._slider(ts, "Edge width", s.width, 0.5, 500, 0.5, (v) => { s.width = v; sync(); });
                }
            }
            note(s.kind === "line" ? "Drag from end to end (Shift: in 45° steps), in the colour." : "Drag a box: Shift makes it square, Alt draws it from the middle.");
        }
    },
};
