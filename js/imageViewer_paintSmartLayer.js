// imageViewer_paintSmartLayer.js
// Paint's smart layers: a pixel layer that keeps the picture it was made from (its SOURCE, at that picture's
// own size) and how that picture lies on the canvas (a 3 x 3 projective matrix, so a free transform and a
// Distort / Perspective stay settings). Its pixels are drawn again from the source whenever that changes,
// so scaling down and back up, or rotating twice, loses nothing.
//
// The layer (`L.smart`): { src: the source's id, sw, sh: its size, m: [9] source pixels -> the layer's own
// pixels (the canvas less L.x, L.y), cut: true when only the part over the canvas was drawn }. The pixels
// of a source are kept beside the document, by id (several layers may share one: a duplicate). Everything
// else of the layer (its mask, style, smart filters, blend, opacity) is a pixel layer's.
//
// The first half is the arithmetic (pure, the same as src/paint_smartlayer.py - tests/test_paint_parity.py
// compares them; tests/test_paint_smartlayer.mjs); the second, SmartLayerMixin, the editor's side.
//
// Written from the textbook definitions (homogeneous coordinates, bilinear sampling, a 2 x 2 box filter
// for each level of a mip chain), not from any other program's code.

import * as D from "./imageViewer_paintData.js";
import { homography } from "./imageViewer_paintWarp.js";

// ── the arithmetic ──────────────────────────────────────────────────────────

/** A source as big as a layer may be; a drawn layer bigger than DRAW_LIMIT pixels (and four canvases) is cut to the canvas. */
export const MAX_SRC_SIDE = 16384;
export const DRAW_LIMIT = 4096 * 4096;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function mul3(A, B) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return o;
}

export function det3(m) {
    return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/** The inverse by the adjugate (the same formula as the Python, so the two round alike), or null. */
export function inv3(m) {
    const d = det3(m);
    if (!d || !Number.isFinite(d)) return null;
    return [(m[4] * m[8] - m[5] * m[7]) / d, (m[2] * m[7] - m[1] * m[8]) / d, (m[1] * m[5] - m[2] * m[4]) / d,
            (m[5] * m[6] - m[3] * m[8]) / d, (m[0] * m[8] - m[2] * m[6]) / d, (m[2] * m[3] - m[0] * m[5]) / d,
            (m[3] * m[7] - m[4] * m[6]) / d, (m[1] * m[6] - m[0] * m[7]) / d, (m[0] * m[4] - m[1] * m[3]) / d];
}

export const move3 = (dx, dy) => [1, 0, dx, 0, 1, dy, 0, 0, 1];
export const scale3 = (kx, ky = kx) => [kx, 0, 0, 0, ky, 0, 0, 0, 1];
/** A 2D affine { a, b, c, d, e, f } (x = a u + c v + e, y = b u + d v + f) as a 3 x 3. */
export const affine3 = (t) => [t.a, t.c, t.e, t.b, t.d, t.f, 0, 0, 1];
/** The homography (paintWarp's eight numbers) as a 3 x 3. */
export const hom3 = (h) => [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];

export function apply3(m, x, y) {
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** The four corners of a sw x sh source under m: top left, top right, bottom right, bottom left. */
export function corners(m, sw, sh) { return [apply3(m, 0, 0), apply3(m, sw, 0), apply3(m, sw, sh), apply3(m, 0, sh)]; }

/** Does m put the source's rectangle somewhere it can be drawn (in front of the eye, not folded)? */
export function drawable(m, sw, sh) {
    if (!(Math.abs(det3(m)) > 1e-12)) return false;
    for (const [x, y] of [[0, 0], [sw, 0], [sw, sh], [0, sh]]) if (!(m[6] * x + m[7] * y + m[8] > 1e-9)) return false;
    return true;
}

/** `L.smart` held to what it may be (paint_smartlayer.clean_smart), or null. */
export function cleanSmart(s) {
    if (!s || typeof s !== "object" || !ID_RE.test(String(s.src || ""))) return null;
    const sw = Math.trunc(D.num(s.sw, 0, 0, MAX_SRC_SIDE)), sh = Math.trunc(D.num(s.sh, 0, 0, MAX_SRC_SIDE));
    if (sw < 1 || sh < 1 || !Array.isArray(s.m) || s.m.length !== 9) return null;
    const m = s.m.map(Number);
    if (!m.every(Number.isFinite) || !drawable(m, sw, sh)) return null;
    const out = { src: String(s.src), sw, sh, m };
    if (s.cut) out.cut = true;
    return out;
}

/** The layer's matrix on the canvas: source pixels -> canvas pixels. */
export function canvasMatrix(L) { return mul3(move3(L.x, L.y), L.smart.m); }

/** How much the source is shrunk where it is shrunk most (the shortest side, against the source's own). */
export function minScale(m, sw, sh) {
    const q = corners(m, sw, sh), len = (a, b) => Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    return Math.min(len(q[0], q[1]) / sw, len(q[1], q[2]) / sh, len(q[3], q[2]) / sw, len(q[0], q[3]) / sh);
}

/** Which level of the mip chain to read: the smallest one that is still at least half the size drawn. */
export function levelFor(m, sw, sh) {
    const s = minScale(m, sw, sh);
    let k = 0;
    while (k < 12 && s * Math.pow(2, k) < 0.5 && (sw >> (k + 1)) >= 1 && (sh >> (k + 1)) >= 1) k++;
    return k;
}

/** Half the size (rounded up): each pixel the premultiplied mean of the 2 x 2 under it (those that are there). */
export function halveRGBA(src, w, h) {
    const W = Math.ceil(w / 2), H = Math.ceil(h / 2), out = new Uint8ClampedArray(W * H * 4);
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
        let r = 0, g = 0, b = 0, al = 0, n = 0;
        for (let j = 0; j < 2; j++) {
            const y = 2 * Y + j;
            if (y >= h) continue;
            for (let i = 0; i < 2; i++) {
                const x = 2 * X + i;
                if (x >= w) continue;
                const q = (y * w + x) * 4, a = src[q + 3];
                r += src[q] * a; g += src[q + 1] * a; b += src[q + 2] * a; al += a; n++;
            }
        }
        const o = (Y * W + X) * 4;
        if (al > 0) { out[o] = r / al; out[o + 1] = g / al; out[o + 2] = b / al; }
        out[o + 3] = al / n;
    }
    return { px: out, w: W, h: H };
}

/** The mip chain of a source, made as far as asked and kept with it. */
export function level(source, k) {
    if (!source.levels) source.levels = [{ px: source.px, w: source.w, h: source.h }];
    while (source.levels.length <= k) {
        const p = source.levels[source.levels.length - 1];
        source.levels.push(halveRGBA(p.px, p.w, p.h));
    }
    return source.levels[k];
}

/** The whole-pixel box around points [[x, y], ...]. */
export function boxOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.floor(x0 + 1e-6); y0 = Math.floor(y0 + 1e-6);
    return { x: x0, y: y0, w: Math.max(1, Math.ceil(x1 - 1e-6) - x0), h: Math.max(1, Math.ceil(y1 - 1e-6) - y0) };
}

/**
 * Where the drawn layer lies on the canvas (W x H) for the canvas matrix `cm`: the box around the source's
 * corners, or - when that is more than DRAW_LIMIT pixels and four canvases, or a side over MAX_SRC_SIDE - only the part of it
 * over the canvas (`cut`).
 */
export function drawBox(cm, sw, sh, W, H) {
    const box = boxOf(corners(cm, sw, sh));
    if (box.w * box.h <= Math.max(DRAW_LIMIT, 4 * W * H) && box.w <= MAX_SRC_SIDE && box.h <= MAX_SRC_SIDE) return { box, cut: false };
    const x0 = Math.max(box.x, 0), y0 = Math.max(box.y, 0), x1 = Math.min(box.x + box.w, W), y1 = Math.min(box.y + box.h, H);
    if (x1 <= x0 || y1 <= y0) return { box: { x: 0, y: 0, w: 1, h: 1 }, cut: true };
    return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, cut: true };
}

/**
 * The source (`source` = { px, w, h }, its levels kept on it) drawn by the canvas matrix `cm` onto a canvas
 * W x H: { px, box, m, cut } - the pixels of `box`, and the matrix as the layer keeps it (relative to the box).
 * Each pixel's middle is taken back through the inverse into the level that fits, read bilinearly with
 * premultiplied alpha; a Uint8ClampedArray rounds to the nearest (half to even, as numpy's round).
 */
export function render(source, cm, W, H) {
    const { box, cut } = drawBox(cm, source.w, source.h, W, H);
    const out = new Uint8ClampedArray(box.w * box.h * 4);
    const k = levelFor(cm, source.w, source.h), lv = level(source, k);
    const inv = inv3(mul3(cm, scale3(Math.pow(2, k))));
    const m = mul3(move3(-box.x, -box.y), cm);
    if (!inv) return { px: out, box, m, cut };
    const src = lv.px, w = lv.w, h = lv.h;
    for (let Y = 0; Y < box.h; Y++) {
        const gy = box.y + Y + 0.5;
        for (let X = 0; X < box.w; X++) {
            const gx = box.x + X + 0.5;
            const d = inv[6] * gx + inv[7] * gy + inv[8];
            if (!(d > 0)) continue;
            const u = (inv[0] * gx + inv[1] * gy + inv[2]) / d, v = (inv[3] * gx + inv[4] * gy + inv[5]) / d;
            const fu = u - 0.5, fv = v - 0.5, u0 = Math.floor(fu), v0 = Math.floor(fv), du = fu - u0, dv = fv - v0;
            if (u0 < -1 || v0 < -1 || u0 >= w || v0 >= h) continue;
            let r = 0, g = 0, bl = 0, al = 0;
            for (let j = 0; j < 2; j++) {
                const vy = v0 + j;
                if (vy < 0 || vy >= h) continue;
                const wy = j ? dv : 1 - dv;
                for (let i = 0; i < 2; i++) {
                    const ux = u0 + i;
                    if (ux < 0 || ux >= w) continue;
                    const q = (vy * w + ux) * 4, pa = src[q + 3] * (wy * (i ? du : 1 - du));
                    r += src[q] * pa; g += src[q + 1] * pa; bl += src[q + 2] * pa; al += pa;
                }
            }
            if (al <= 0) continue;
            const o = (Y * box.w + X) * 4;
            out[o] = r / al; out[o + 1] = g / al; out[o + 2] = bl / al; out[o + 3] = al;
        }
    }
    return { px: out, box, m, cut };
}

/** The matrix that lays a sw x sh source at its own size with its middle at (cx, cy) - or fitted inside W x H when bigger. */
export function placeMatrix(sw, sh, W, H, { fit = true } = {}) {
    const k = fit ? Math.min(1, W / sw, H / sh) : 1;
    const w = sw * k, h = sh * k;
    return mul3(move3(Math.round((W - w) / 2), Math.round((H - h) / 2)), scale3(k));
}

/** The scale, rotation and corners of a smart layer, for the panel: { sx, sy, r, quad }. */
export function describe(L) {
    const cm = canvasMatrix(L), s = L.smart, q = corners(cm, s.sw, s.sh);
    const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180 / Math.PI;
    const affine = Math.abs(cm[6]) < 1e-12 && Math.abs(cm[7]) < 1e-12;
    return { sx: (len(q[0], q[1]) + len(q[3], q[2])) / 2 / s.sw, sy: (len(q[0], q[3]) + len(q[1], q[2])) / 2 / s.sh,
             r: Math.round(r * 100) / 100, quad: q, affine };
}

// ── the editor ──────────────────────────────────────────────────────────────

let SRC_N = 0;
export const newSrcId = () => "s" + Date.now().toString(36) + (SRC_N++).toString(36) + Math.random().toString(36).slice(2, 6);

export const SmartLayerMixin = {
    /** The sources by id: { px, w, h, levels }. Never taken back while the editor holds the document (undo may need one). */
    _srcs() { return this.srcs || (this.srcs = new Map()); },

    isSmart(L) { return !!(L && L.kind === "pixel" && L.smart && this._srcs().has(L.smart.src)); },

    /** A source kept (the pixels are not copied: nothing changes a source in place). */
    addSource(px, w, h, id = null) {
        id = id || newSrcId();
        this._srcs().set(id, { px, w, h });
        return id;
    },

    /** Draw the layer again from its source by the canvas matrix `cm` (inside `change`): new pixels, box and matrix. */
    _smartDraw(L, cm = null) {
        const S = this._srcs().get(L.smart.src);
        if (!S) return false;
        cm = cm || canvasMatrix(L);
        if (!drawable(cm, S.w, S.h)) throw new Error("that would turn the smart layer inside out");
        const r = render(S, cm, this.doc.w, this.doc.h);
        this.pix.set(L.id, r.px);
        Object.assign(L, { x: r.box.x, y: r.box.y, w: r.box.w, h: r.box.h });
        L.smart = { ...L.smart, m: r.m };
        if (r.cut) L.smart.cut = true; else delete L.smart.cut;
        if (this._smartDrawn) this._smartDrawn.add(L.id);
        return true;
    },

    /**
     * After a change: a smart layer whose pixels something else replaced (not drawn from its source) is a
     * plain pixel layer from then on - what was done to its pixels is kept, not drawn over later.
     */
    _smartKeepOrForget(before) {
        const was = new Map(before.doc.layers.map((x) => [x.id, x]));
        for (const L of this.doc.layers) {
            const B = was.get(L.id);
            if (!L.smart || !B || !B.smart || (this._smartDrawn && this._smartDrawn.has(L.id))) continue;
            if (before.pix.get(L.id) !== this.pix.get(L.id)) delete L.smart;
        }
        this._smartDrawn = null;
    },

    /**
     * The free transform or Distort / Perspective let go on a smart layer: the layer was shown from its drawn
     * pixels; now it is drawn again from its source by `G` (canvas -> canvas: where the drawn layer was, to
     * where it went). Its mask stays as the session made it.
     */
    _smartAfterSession(L, G, from) {
        if (!this.isSmart(L)) return;
        // The layer's matrix is relative to where the drawn layer lay before the session moved it.
        const shown = { x: L.x, y: L.y, w: L.w, h: L.h }, px = this.pix.get(L.id);
        Object.assign(L, { x: from.x, y: from.y, w: from.w, h: from.h });
        const mask = L.mask ? { ...L.mask } : null, mk = this.masks.get(L.id);
        try { this._smartApply(L, G); }
        catch (e) {
            // Kept as the session showed it, a plain layer.
            delete L.smart;
            Object.assign(L, shown);
            this.pix.set(L.id, px);
            this._notify(String(e.message || e) + " - it is a plain layer now.", "warn");
        }
        if (mask) { L.mask = mask; this.masks.set(L.id, mk); }
    },

    /** A canvas transform G (3 x 3, canvas -> canvas) laid on a smart layer: its matrix becomes G · it, drawn again. */
    _smartApply(L, G) { return this._smartDraw(L, mul3(G, canvasMatrix(L))); },

    /** A layer drawn only over the canvas, moved since: drawn again where it lies now. Inside `change`. */
    _smartUncut() {
        for (const L of this.doc.layers) {
            if (!this.isSmart(L) || !L.smart.cut) continue;
            const cm = canvasMatrix(L), want = drawBox(cm, L.smart.sw, L.smart.sh, this.doc.w, this.doc.h).box;
            if (want.x !== L.x || want.y !== L.y || want.w !== L.w || want.h !== L.h) this._smartDraw(L, cm);
        }
    },

    /** Place a picture as a smart layer: its own size, or fitted inside the canvas when bigger, in the middle. */
    addSmartLayer(px, w, h, name, { fit = true, cm = null, index = null } = {}) {
        if (!this.doc) return false;
        if (w > MAX_SRC_SIDE || h > MAX_SRC_SIDE) return this.addPixelLayer(px, w, h, name);
        return this.change("Place smart layer", () => {
            const src = this.addSource(px, w, h);
            const L = D.cleanLayer({ id: D.newId(), name, kind: "pixel", x: 0, y: 0, w: 1, h: 1 });
            L.smart = { src, sw: w, sh: h, m: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
            this._smartDraw(L, cm || placeMatrix(w, h, this.doc.w, this.doc.h, { fit }));
            const i = index != null ? index : this.doc.layers.length ? this._placeNew(L) : 0;
            this.doc.layers.splice(i, 0, L);
            this.doc.active = L.id;
            this.editMask = false;
        });
    },

    /** Layer > Convert to smart layer: the layer's pixels become its source, lying where they lie. */
    convertToSmart() {
        const L = this.active();
        if (!L || L.kind !== "pixel") { this._notify("Convert to smart layer: pick a pixel layer.", "info"); return false; }
        if (this.isSmart(L)) return false;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return false; }
        return this.change("Convert to smart layer", () => {
            const src = this.addSource(this.pix.get(L.id), L.w, L.h);
            L.smart = { src, sw: L.w, sh: L.h, m: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
            delete L.text;
        });
    },

    /** Layer > Rasterize: the layer keeps its pixels as they are drawn and forgets its source. */
    rasterize(ids = null) {
        const list = (ids || this.pickedLayers().map((x) => x.id)).map((id) => this.doc.layers.find((x) => x.id === id)).filter((x) => x && x.smart);
        if (!list.length) return false;
        return this.change(list.length > 1 ? "Rasterize layers" : "Rasterize", () => { for (const L of list) delete L.smart; });
    },

    /** Back to the source's own size (fitted inside the canvas when bigger), its middle where the layer's is. */
    resetSmart() {
        const L = this.active();
        if (!this.isSmart(L)) return false;
        return this.change("Reset smart layer", () => {
            const s = L.smart, q = corners(canvasMatrix(L), s.sw, s.sh);
            const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
            const k = Math.min(1, this.doc.w / s.sw, this.doc.h / s.sh);
            this._smartDraw(L, mul3(move3(Math.round(cx - s.sw * k / 2), Math.round(cy - s.sh * k / 2)), scale3(k)));
        });
    },

    /**
     * A source changed (Edit contents saved): every layer drawn from `oldId` is drawn from the new pixels, its
     * corners where they were. One undo step.
     */
    replaceSource(oldId, px, w, h) {
        const users = this.doc.layers.filter((L) => L.smart && L.smart.src === oldId);
        if (!users.length) return false;
        return this.change("Edit smart layer contents", () => {
            const id = this.addSource(px, w, h);
            for (const L of users) {
                const s = L.smart, q = corners(canvasMatrix(L), s.sw, s.sh);
                const Hm = homography([[0, 0], [w, 0], [w, h], [0, h]], q);
                if (!Hm) continue;
                L.smart = { ...s, src: id, sw: w, sh: h };
                this._smartDraw(L, hom3(Hm));
            }
        });
    },

    /** A smart layer cannot be painted on: said, and true when that is the case (the caller stops). */
    _smartRefuses(L, what) {
        if (!this.isSmart(L) || this.editMask) return false;
        this._notify(`${what}: ${L.name} is a smart layer - Rasterize it first (Layer > Rasterize), or paint on its mask.`, "warn");
        return true;
    },

    /** Properties' section for a smart layer. */
    _smartLayerSection(L) {
        const s = this.el("div", "paint-sect paint-smartlayer");
        s.append(this.el("h4", "", { text: "Smart layer" }));
        const d = describe(L);
        const pct = (v) => `${Math.round(v * 1000) / 10}%`;
        s.append(this.el("div", "paint-note", { text: `Source ${L.smart.sw} x ${L.smart.sh}, drawn at ${pct(d.sx)} x ${pct(d.sy)}`
            + (d.r ? `, turned ${d.r}°` : "") + (d.affine ? "" : ", in perspective")
            + (L.smart.cut ? " (only the part over the canvas is drawn)" : "") }));
        const row = this.el("div", "paint-field wrap");
        for (const [label, title, run] of [["Edit contents", "Open the source in a Paint tab of its own; saving there updates this layer", () => this.host.editSmart && this.host.editSmart(L.id)],
                                            ["Reset", "Back to the source's own size", () => this.resetSmart()],
                                            ["Rasterize", "Keep the pixels as they are drawn and forget the source", () => this.rasterize([L.id])]]) {
            const b = this.el("button", "paint-btn", { type: "button", text: label, title });
            b.dataset.smart = label.split(" ")[0].toLowerCase();
            b.addEventListener("click", run);
            row.append(b);
        }
        s.append(row);
        s.append(this.el("div", "paint-note", { text: "Transform, Distort and Perspective draw it again from the source, so it keeps its detail. To paint on it, rasterize it (or paint its mask)." }));
        return s;
    },

    /** The sources the document still uses, for a save: { id: { px, w, h } }. */
    usedSources() {
        const out = {};
        for (const L of this.doc.layers) if (L.smart && this._srcs().has(L.smart.src)) out[L.smart.src] = this._srcs().get(L.smart.src);
        return out;
    },
};
