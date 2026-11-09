// Paint's Select > Modify (expand, contract, smooth, border), Select > Colour range, and guides, rulers and
// snapping. The arithmetic is pure and has twins in src/paint_math.py (expand_mask / contract_mask /
// smooth_mask / border_mask / color_range), compared by tests/test_paint_parity.py; the mixin is the editor's
// side. Written from what the commands do, not from any other program's code.
import * as D from "./imageViewer_paintData.js";
import { dilate } from "./imageViewer_paintStyle.js";

export { cleanGuides, MAX_GUIDES } from "./imageViewer_paintData.js";
export const RULER_PX = 18;
/** How near (screen pixels) a guide, an edge or the middle catches what is dragged. */
export const SNAP_PX = 8;

export function expandMask(m, w, h, r) { return dilate(m, w, h, r); }

export function contractMask(m, w, h, r) {
    const inv = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) inv[i] = 255 - m[i];
    const d = dilate(inv, w, h, r);
    for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
    return d;
}

/** A band `width` wide along the selection's edge: half outside it, half inside. */
export function borderMask(m, w, h, width) {
    const a = Math.round(width / 2), b = Math.max(0, Math.round(width) - a);
    const out = expandMask(m, w, h, a), inner = contractMask(m, w, h, b);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, out[i] - inner[i]);
    return out;
}

/** Corners and specks rounded away: blurred by r, then in where at least half covered. */
export function smoothMask(m, w, h, r) {
    const f = D.feather(m, w, h, r);
    const out = new Uint8Array(m.length);
    for (let i = 0; i < f.length; i++) out[i] = f[i] >= 128 ? 255 : 0;
    return out;
}

/**
 * Select > Colour range: how near each pixel's colour lies to `color` - all of it at the colour, nothing at
 * `fuzz` away or more (the distance: RGB, averaged over the three channels), times the pixel's alpha.
 */
export function colorRange(px, w, h, color, fuzz) {
    const out = new Uint8Array(w * h), f = Math.max(1, fuzz);
    for (let i = 0; i < w * h; i++) {
        const o = i * 4, dr = px[o] - color[0], dg = px[o + 1] - color[1], db = px[o + 2] - color[2];
        const d = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
        const v = 1 - d / f;
        out[i] = v <= 0 ? 0 : D.q8(v * (px[o + 3] / 255));
    }
    return out;
}

/** v pulled onto the nearest of `targets` within `tol`, or left; returns [v, the target or null]. */
export function snapValue(v, targets, tol) {
    let best = null, bd = tol;
    for (const t of targets) { const d = Math.abs(v - t); if (d <= bd) { bd = d; best = t; } }
    return best == null ? [v, null] : [best, best];
}

/** A span [a, b] moved so that its start, middle or end lands on a target: the shift (0 when none is near). */
export function snapSpan(a, b, targets, tol) {
    let best = 0, bd = tol + 1e-9;
    for (const p of [a, (a + b) / 2, b]) {
        for (const t of targets) { const d = Math.abs(t - p); if (d < bd) { bd = d; best = t - p; } }
    }
    return best;
}

/** A ruler's tick step in canvas pixels: the smallest of 1, 2, 5 x 10^n at least `minPx` screen pixels apart. */
export function rulerStep(zoom, minPx = 50) {
    for (let e = 0; e < 8; e++) for (const k of [1, 2, 5]) { const s = k * 10 ** e; if (s * zoom >= minPx) return s; }
    return 1e8;
}

/** How far (px) "Extend empty areas" reaches into the layer, so the new part is made to meet it without a seam. */
export const EMPTY_GROW = 8;

/**
 * The empty area around a layer, as a selection of the canvas (W x H, 0..255): everything the layer does not cover
 * - outside its box, and where it is see-through (255 - its alpha, so a soft edge is half selected) - grown by
 * *grow* px into the layer. Null when the layer covers the whole canvas.
 */
export function emptyAround(px, L, W, H, grow = EMPTY_GROW) {
    const m = new Uint8Array(W * H).fill(255);
    for (let y = Math.max(0, L.y); y < Math.min(H, L.y + L.h); y++) {
        for (let x = Math.max(0, L.x); x < Math.min(W, L.x + L.w); x++) {
            m[y * W + x] = 255 - px[((y - L.y) * L.w + (x - L.x)) * 4 + 3];
        }
    }
    if (!m.some((v) => v)) return null;
    return grow > 0 ? dilate(m, W, H, grow) : m;
}

/** The words a fill of the empty area takes when the user gave none. */
export const EMPTY_PROMPT = "a seamless continuation of the picture around it, the same scene, light and style";

export const SelectGuidesMixin = {
    /**
     * Generate › Extend empty areas: select what the active layer leaves empty on the canvas (grown a little into
     * it) - one undo step - and fill that by the Generative fill workflow, with the prompt (or EMPTY_PROMPT).
     */
    extendEmpty() {
        const L = this.active();
        if (!this.doc || !L || L.kind !== "pixel") { this._notify("Pick a pixel layer first.", "info"); return false; }
        const m = emptyAround(this.pix.get(L.id), L, this.doc.w, this.doc.h);
        if (!m) { this._notify("The layer covers the whole canvas: nothing is empty around it.", "info"); return false; }
        this.setSelection(m, "Select empty areas");
        if (this.host.generate) this.host.generate("fill", { prompt: (this._prompt || "").trim() || EMPTY_PROMPT, variations: this._variations || 1, label: "Extend empty areas" });
        return true;
    },

    // ── Select > Modify, Colour range ────────────────────────────────────────

    /** Expand, contract, smooth or border the selection by r pixels: one undo step. */
    modifySelection(kind, r) {
        if (!this.sel) { this._notify("Select something first.", "info"); return false; }
        const W = this.doc.w, H = this.doc.h;
        const fn = { expand: expandMask, contract: contractMask, smooth: smoothMask, border: borderMask }[kind];
        return this.setSelection(fn(this.sel, W, H, r), { expand: "Expand selection", contract: "Contract selection", smooth: "Smooth selection", border: "Border selection" }[kind]);
    },

    /** The picture (or the active layer) as canvas-sized pixels for Colour range. */
    _rangeSource(sample) {
        const W = this.doc.w, H = this.doc.h, L = this.active();
        if (sample !== "layer" || !L || L.kind !== "pixel") return this.comp;
        const out = new Uint8ClampedArray(W * H * 4), px = this.pix.get(L.id);
        for (let y = Math.max(0, L.y); y < Math.min(H, L.y + L.h); y++) {
            const s = ((y - L.y) * L.w + Math.max(0, L.x) - L.x) * 4, e = s + (Math.min(W, L.x + L.w) - Math.max(0, L.x)) * 4;
            out.set(px.subarray(s, e), (y * W + Math.max(0, L.x)) * 4);
        }
        return out;
    },

    /** Select > Colour range…: the colour (the brush's, picked with the eyedropper), how far it reaches; previewed as it changes. */
    colorRangeDialog() {
        const W = this.doc.w, H = this.doc.h, was = this.sel ? new Uint8Array(this.sel) : null;
        const show = (m) => { this.sel = m; this._selChanged(); };
        const make = (v) => {
            const m = colorRange(this._rangeSource(v.sample), W, H, this.fg, v.fuzz);
            return this.sel && v.combine !== "replace" && was ? D.combineMasks(was, m, v.combine) : m;
        };
        this.dialog("Colour range", [["fuzz", "Fuzziness", 40, 1, 255], ["sample", "From", "picture", ["picture", "layer"]],
                                     ["combine", "Selection", "replace", ["replace", "add", "subtract", "intersect"]]],
                    (v) => { show(was); this.setSelection(make(v), "Colour range"); },
                    `Selects the colours near the brush's colour (${D.rgbToHex(...this.fg)}) - pick it with the eyedropper (I) first.`,
                    { preview: true, onInput: (v, on) => show(on ? make(v) : was), onCancel: () => show(was) });
    },

    // ── guides, rulers, snapping ─────────────────────────────────────────────

    _guides() { return this.doc && this.doc.guides ? this.doc.guides : []; },

    /** doc.guides as they may be on a w x h canvas (none: the key is gone). Inside `change`. */
    _setGuides(list, w = this.doc.w, h = this.doc.h) {
        const g = D.cleanGuides(list, w, h);
        if (g.length) this.doc.guides = g; else delete this.doc.guides;
    },

    addGuide(axis, pos) {
        return this.change("New guide", () => {
            this._setGuides([...this._guides(), { axis, pos }]);
        });
    },

    clearGuides() {
        if (!this._guides().length) return false;
        return this.change("Clear guides", () => { delete this.doc.guides; });
    },

    toggleRulers() { this.rulers = !this.rulers; this.drawOverlay(); this._optPersist && this._optPersist(); },
    toggleGuides() { this.guidesHidden = !this.guidesHidden; this.drawOverlay(); },
    toggleSnap() { this.snapOff = !this.snapOff; this._notify(this.snapOff ? "Snapping is off." : "Snapping is on: guides, the canvas's edges and middle, the layers' edges.", "info"); },

    /** What x (or y) snaps to: the guides, the canvas's edges and middle, the other visible pixel layers' edges. */
    _snapTargets(axis, skip = null) {
        const W = this.doc.w, H = this.doc.h, n = axis === "x" ? W : H;
        const t = [0, n / 2, n];
        if (!this.guidesHidden) for (const g of this._guides()) if (g.axis === axis) t.push(g.pos);
        for (const L of this.doc.layers) {
            if (L.kind !== "pixel" || !L.visible || (skip && skip.has(L.id))) continue;
            if (axis === "x") t.push(L.x, L.x + L.w); else t.push(L.y, L.y + L.h);
        }
        return t;
    },

    /** A point snapped (both axes), when snapping is on. */
    _snapPt(x, y, skip = null) {
        if (this.snapOff || !this.doc) return [x, y];
        const tol = SNAP_PX / this.view.zoom;
        return [snapValue(x, this._snapTargets("x", skip), tol)[0], snapValue(y, this._snapTargets("y", skip), tol)[0]];
    },

    /** How far a box [x0, x1] x [y0, y1] moves for its edges or middle to land on a target (none: 0, 0). */
    _snapBox(x0, x1, y0, y1, skip = null) {
        if (this.snapOff || !this.doc) return [0, 0];
        const tol = SNAP_PX / this.view.zoom;
        return [snapSpan(x0, x1, this._snapTargets("x", skip), tol), snapSpan(y0, y1, this._snapTargets("y", skip), tol)];
    },

    /** A move of layers by dx, dy with their box's edges or middle pulled onto a target (Move tool). */
    _snapMove(dr, dx, dy) {
        const px = dr.set.filter((L) => L.kind === "pixel");
        if (!px.length) return [dx, dy];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const L of px) { const f = dr.from.get(L.id); x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y); x1 = Math.max(x1, f.x + L.w); y1 = Math.max(y1, f.y + L.h); }
        const [sx, sy] = this._snapBox(x0 + dx, x1 + dx, y0 + dy, y1 + dy, new Set(dr.set.map((L) => L.id)));
        return [dx + Math.round(sx), dy + Math.round(sy)];
    },

    /** The guide under the screen point (within 4 px), or -1. */
    _guideAt(sx, sy) {
        if (this.guidesHidden) return -1;
        const v = this.view;
        return this._guides().findIndex((g) => (g.axis === "x" ? Math.abs(v.x + g.pos * v.zoom - sx) : Math.abs(v.y + g.pos * v.zoom - sy)) <= 4);
    },

    /** A press on a ruler (a new guide) or, with the move tool, on a guide (moved; off the canvas: gone). True when taken. */
    _guideDown(p) {
        if (this.rulers && (p.sx < RULER_PX || p.sy < RULER_PX)) {
            const axis = p.sy < RULER_PX && p.sx >= RULER_PX ? "y" : p.sx < RULER_PX && p.sy >= RULER_PX ? "x" : null;
            if (!axis) return true;
            this._drag = { kind: "guide", axis, i: -1, pos: axis === "x" ? p.x : p.y };
            return true;
        }
        if (this.tool !== "move" || this.tf) return false;
        const i = this._guideAt(p.sx, p.sy);
        if (i < 0) return false;
        const g = this._guides()[i];
        this._drag = { kind: "guide", axis: g.axis, i, pos: g.pos };
        return true;
    },

    _guideMove(dr, p) {
        let v = dr.axis === "x" ? p.x : p.y;
        if (!this.snapOff) {
            const tol = SNAP_PX / this.view.zoom, n = dr.axis === "x" ? this.doc.w : this.doc.h;
            const t = [0, n / 2, n, ...this._snapTargets(dr.axis).filter((_, k) => k >= 3)];
            v = snapValue(v, t, tol)[0];
        }
        dr.pos = Math.round(v * 2) / 2;
        dr.off = dr.axis === "x" ? (p.sx < (this.rulers ? RULER_PX : 0) || p.x < 0 || p.x > this.doc.w) : (p.sy < (this.rulers ? RULER_PX : 0) || p.y < 0 || p.y > this.doc.h);
        this.drawOverlay();
    },

    _guideUp(dr) {
        const g = this._guides();
        if (dr.i < 0) {
            if (!dr.off) this.addGuide(dr.axis, dr.pos); else this.drawOverlay();
            return;
        }
        this.change(dr.off ? "Delete guide" : "Move guide", () => {
            const list = g.slice();
            if (dr.off) list.splice(dr.i, 1); else list[dr.i] = { axis: dr.axis, pos: dr.pos };
            this._setGuides(list);
        });
    },

    /** The guides, the guide being dragged, and the rulers (drawn last, over everything). */
    _guidesDraw(c, X, Y) {
        const ow = this.overlay.width / (this.d.defaultView.devicePixelRatio || 1), oh = this.overlay.height / (this.d.defaultView.devicePixelRatio || 1);
        const dr = this._drag && this._drag.kind === "guide" ? this._drag : null;
        c.lineWidth = 1;
        if (!this.guidesHidden) {
            this._guides().forEach((g, i) => {
                if (dr && dr.i === i) return;
                c.strokeStyle = "rgba(0, 220, 255, 0.85)";
                c.beginPath();
                if (g.axis === "x") { c.moveTo(Math.round(X(g.pos)) + 0.5, 0); c.lineTo(Math.round(X(g.pos)) + 0.5, oh); }
                else { c.moveTo(0, Math.round(Y(g.pos)) + 0.5); c.lineTo(ow, Math.round(Y(g.pos)) + 0.5); }
                c.stroke();
            });
        }
        if (dr) {
            c.strokeStyle = dr.off ? "rgba(255, 80, 80, 0.8)" : "rgba(0, 220, 255, 1)";
            c.setLineDash(dr.off ? [4, 4] : []);
            c.beginPath();
            if (dr.axis === "x") { c.moveTo(Math.round(X(dr.pos)) + 0.5, 0); c.lineTo(Math.round(X(dr.pos)) + 0.5, oh); }
            else { c.moveTo(0, Math.round(Y(dr.pos)) + 0.5); c.lineTo(ow, Math.round(Y(dr.pos)) + 0.5); }
            c.stroke(); c.setLineDash([]);
        }
        if (!this.rulers) return;
        const v = this.view, step = rulerStep(v.zoom), R = RULER_PX;
        c.fillStyle = "#202024"; c.fillRect(0, 0, ow, R); c.fillRect(0, 0, R, oh);
        c.strokeStyle = "#666"; c.fillStyle = "#aaa"; c.font = "9px system-ui"; c.textBaseline = "top";
        c.beginPath();
        const minor = step / (String(step)[0] === "2" ? 4 : 5);
        for (let a = Math.floor(-v.x / v.zoom / minor) * minor; X(a) < ow; a += minor) {
            const sx = Math.round(X(a)) + 0.5, major = Math.abs(a / step - Math.round(a / step)) < 1e-6;
            if (sx < R) continue;
            c.moveTo(sx, major ? 2 : R - 5); c.lineTo(sx, R);
            if (major) c.fillText(String(Math.round(a)), sx + 2, 2);
        }
        for (let a = Math.floor(-v.y / v.zoom / minor) * minor; Y(a) < oh; a += minor) {
            const sy = Math.round(Y(a)) + 0.5, major = Math.abs(a / step - Math.round(a / step)) < 1e-6;
            if (sy < R) continue;
            c.moveTo(major ? 2 : R - 5, sy); c.lineTo(R, sy);
            if (major) { c.save(); c.translate(2, sy + 2); c.rotate(Math.PI / 2); c.fillText(String(Math.round(a)), 0, -9); c.restore(); }
        }
        c.stroke();
        // Where the pointer is.
        if (this._hover) {
            c.strokeStyle = "#0df";
            c.beginPath();
            c.moveTo(Math.round(X(this._hover.x)) + 0.5, 0); c.lineTo(Math.round(X(this._hover.x)) + 0.5, R);
            c.moveTo(0, Math.round(Y(this._hover.y)) + 0.5); c.lineTo(R, Math.round(Y(this._hover.y)) + 0.5);
            c.stroke();
        }
        c.fillStyle = "#202024"; c.fillRect(0, 0, R, R);
    },

    _viewMenu() {
        const g = this._guides();
        return [{ label: `${this.rulers ? "Hide" : "Show"} rulers (Ctrl+R)`, run: () => this.toggleRulers() },
                { label: `${this.guidesHidden ? "Show" : "Hide"} guides (Ctrl+;)`, run: () => this.toggleGuides() },
                { label: `Snapping ${this.snapOff ? "on" : "off"} (Ctrl+Shift+;)`, run: () => this.toggleSnap() }, "-",
                { label: "New guide…", run: () => this.dialog("New guide", [["axis", "Orientation", "vertical", ["vertical", "horizontal"]], ["pos", "Position (px)", Math.round(this.doc.w / 2), 0, D.MAX_SIDE]],
                                                              (v) => this.addGuide(v.axis === "vertical" ? "x" : "y", v.pos)) },
                { label: "Clear guides", disabled: !g.length, run: () => this.clearGuides() }, "-",
                { label: "Fit (Ctrl+0)", run: () => this.fit() }];
    },
};
