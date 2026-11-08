// imageViewer_paintPreview.js
// Paint's quick preview: while a layer is dragged, transformed or a slider is pulled on a big picture, the
// picture is laid at about the screen's resolution (every layer shrunk by a whole factor k, kept until its
// pixels change) and shown over the canvas; when the drag is let go (or the slider rests) the canvas is
// drawn again in full. On a 4000 x 3000 picture seen whole, a full composite took ~0.5 s for every move of
// the mouse, so nothing was seen until the button was let go. A flat object of methods put onto the
// editor's prototype (PreviewMixin); `shrinkRGBA` / `shrinkGray` / `previewFactor` are pure, for the tests.

import * as D from "./imageViewer_paintData.js";
import { gradientPixels, gradientStops, layOver } from "./imageViewer_paintDraw.js";

/** Below this many pixels a full composite is quick enough: no preview. */
export const PREVIEW_MIN_PIXELS = 2e6;
/** The drags whose whole-canvas redraws are previewed (a stroke draws its own small rectangles). */
const PREVIEW_DRAGS = new Set(["mmove", "tf", "wp", "grad"]);
/** How long a slider must rest before the full picture is drawn under it. */
const REST_MS = 350;

/** The whole factor k (1/k of each side) a picture W x H seen at `scale` screen px per picture px is previewed at; 1 = none. */
export function previewFactor(W, H, scale) {
    if (W * H < PREVIEW_MIN_PIXELS || !(scale > 0)) return 1;
    const k = Math.floor(1 / scale);
    return k >= 2 ? Math.min(k, 16) : 1;
}

/** RGBA w x h shrunk by k (k x k boxes, colour weighted by alpha): [pixels, w', h']. */
export function shrinkRGBA(px, w, h, k) {
    const tw = Math.max(1, Math.ceil(w / k)), th = Math.max(1, Math.ceil(h / k));
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let j = 0; j < th; j++) {
        const y0 = j * k, y1 = Math.min(h, y0 + k);
        for (let i = 0; i < tw; i++) {
            const x0 = i * k, x1 = Math.min(w, x0 + k);
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let y = y0; y < y1; y++) {
                let o = (y * w + x0) * 4;
                for (let x = x0; x < x1; x++, o += 4) { const al = px[o + 3]; r += px[o] * al; g += px[o + 1] * al; b += px[o + 2] * al; a += al; n++; }
            }
            const q = (j * tw + i) * 4;
            if (a > 0) { out[q] = r / a; out[q + 1] = g / a; out[q + 2] = b / a; out[q + 3] = a / n; }
        }
    }
    return [out, tw, th];
}

/** A grey w x h (a mask, a selection) shrunk by k: [values, w', h']. */
export function shrinkGray(m, w, h, k) {
    const tw = Math.max(1, Math.ceil(w / k)), th = Math.max(1, Math.ceil(h / k));
    const out = new Uint8Array(tw * th);
    for (let j = 0; j < th; j++) {
        const y0 = j * k, y1 = Math.min(h, y0 + k);
        for (let i = 0; i < tw; i++) {
            const x0 = i * k, x1 = Math.min(w, x0 + k);
            let s = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += m[y * w + x]; n++; }
            out[j * tw + i] = Math.round(s / n);
        }
    }
    return [out, tw, th];
}

/** A layer's numbers that are lengths in pixels, divided by k (its style, smart filters). */
function scaledLook(L, k) {
    const out = {};
    if (L.style) {
        const st = {};
        for (const [kind, e] of Object.entries(L.style)) {
            const c = { ...e };
            if (c.size != null) c.size = kind === "stroke" ? Math.max(1, Math.round(c.size / k)) : c.size / k;
            if (c.distance != null) c.distance = c.distance / k;
            st[kind] = c;
        }
        out.style = st;
    }
    if (L.filters) out.filters = L.filters.map((f) => (f.type === "blur" || f.type === "sharpen"
        ? { ...f, params: { ...f.params, radius: Math.max(0.1, f.params.radius / k) } } : f));
    return out;
}

export const PreviewMixin = {
    /** The factor the picture would be previewed at now (1: drawn in full). */
    _previewK() {
        if (!this.doc) return 1;
        const dpr = (this.d.defaultView && this.d.defaultView.devicePixelRatio) || 1;
        return previewFactor(this.doc.w, this.doc.h, this.view.zoom * dpr);
    },

    /** Is a whole-canvas redraw now one to preview? (a live edit or one of the previewed drags, on a big picture) */
    _previewWanted() {
        const dr = this._drag;
        if (dr && dr.kind === "stroke") return false;
        if (!(this._liveSnap || (dr && PREVIEW_DRAGS.has(dr.kind)))) return false;
        return this._previewK() > 1;
    },

    /**
     * Lay the preview at the next frame; `over` puts other pixels in a layer's place ({id: {L, px, mask}},
     * preview-sized; left out: as it was, null: none).
     */
    requestPreview(over) {
        if (over !== undefined) this._pvOver = over;
        const win = this.d.defaultView;
        if (this._pvRest) win.clearTimeout(this._pvRest);
        // A slider held still (no pointer drag of the canvas): the full picture after a moment.
        this._pvRest = win.setTimeout(() => { this._pvRest = 0; if (!this._drag) this._previewSettle(); }, REST_MS);
        if (this._pvRaf) return;
        this._pvRaf = win.requestAnimationFrame(() => { this._pvRaf = 0; this._previewDraw(); });
    },

    /** The preview put away and the canvas drawn in full (at the next frame). */
    _previewSettle() {
        const win = this.d.defaultView;
        if (this._pvRaf) { win.cancelAnimationFrame(this._pvRaf); this._pvRaf = 0; }
        if (this._pvRest) { win.clearTimeout(this._pvRest); this._pvRest = 0; }
        this._pvOver = null;
        if (!this._pvShown) return;
        this.requestRedraw(null, true);
    },

    _previewHide() {
        if (!this._pvShown) return;
        this._pvShown = false;
        if (this._pvCanvas) this._pvCanvas.style.display = "none";
    },

    /** A buffer shrunk by k, kept until the buffer changes (its identity or its version). */
    _pvShrunk(buf, w, h, k, gray = false) {
        const c = this._pvCache || (this._pvCache = new WeakMap());
        const ver = this.bufVer.get(buf) || 0, hit = c.get(buf);
        if (hit && hit.k === k && hit.ver === ver && hit.w === w && hit.h === h) return hit.out;
        const out = gray ? shrinkGray(buf, w, h, k) : shrinkRGBA(buf, w, h, k);
        c.set(buf, { k, ver, w, h, out });
        return out;
    },

    /** The document at 1/k: its layers' places and lengths divided by k, their pixels and masks shrunk. */
    _previewDoc(k) {
        const doc = this.doc, pw = Math.ceil(doc.w / k), ph = Math.ceil(doc.h / k);
        const over = this._pvOver || {};
        const px = new Map(), mk = new Map();
        const layers = doc.layers.map((L) => {
            const o = over[L.id];
            if (o) { if (o.px) px.set(L.id, o.px); if (o.mask) mk.set(L.id, o.mask); return { ...L, ...o.L }; }
            const out = { ...L, ...scaledLook(L, k) };
            if (L.kind === "pixel") {
                const b = this.pix.get(L.id);
                if (b) {
                    const [s, sw, sh] = this._pvShrunk(b, L.w, L.h, k);
                    px.set(L.id, s);
                    Object.assign(out, { x: Math.round(L.x / k), y: Math.round(L.y / k), w: sw, h: sh });
                }
            }
            if (L.mask) {
                const m = this._maskOf(L);
                if (m) {
                    const [s, sw, sh] = this._pvShrunk(m, L.mask.w, L.mask.h, k, true);
                    mk.set(L.id, s);
                    out.mask = { ...L.mask, x: Math.round(L.mask.x / k), y: Math.round(L.mask.y / k), w: sw, h: sh, feather: 0 };
                } else out.mask = { ...L.mask, feather: 0 };
            }
            return out;
        });
        return { doc: { ...doc, w: pw, h: ph, layers }, px, mk };
    },

    /** The picture laid at 1/k and shown over the canvas. */
    _previewDraw() {
        const k = this._previewK();
        if (!this.doc || k <= 1) { this._previewHide(); this.requestRedraw(null, true); return; }
        const { doc, px, mk } = this._previewDoc(k);
        const W = doc.w, H = doc.h;
        let cv = this._pvCanvas;
        if (!cv) {
            cv = this._pvCanvas = this.el("canvas", "paint-preview");
            this.canvas.after(cv);
        }
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; this._pvImg = null; }
        cv.style.width = `${this.doc.w}px`;
        cv.style.height = `${this.doc.h}px`;
        const ctx = cv.getContext("2d");
        if (!this._pvImg) this._pvImg = ctx.createImageData(W, H);
        const out = this._pvImg.data;
        D.composite(doc, (L) => px.get(L.id) || null, (L) => mk.get(L.id) || null, null, out);
        ctx.putImageData(this._pvImg, 0, 0);
        cv.style.display = "block";
        this._pvShown = true;
        this._pvCount = (this._pvCount || 0) + 1;
    },

    /** The free transform while dragged on a big picture: the layer transformed at 1/k (the nearest pixel). */
    _previewTransform(tf) {
        const k = this._previewK();
        const { L, src, p } = tf;
        const m = D.tfMatrix(p), mm = { ...m, e: m.e / k, f: m.f / k };
        const [s, sw, sh] = this._pvShrunk(src.px, src.w, src.h, k);
        const box = D.tfBox(mm, sw, sh);
        if (box.w > D.MAX_SIDE * 2 || box.h > D.MAX_SIDE * 2) return;
        const o = { L: { x: box.x, y: box.y, w: box.w, h: box.h, ...scaledLook(L, k) }, px: D.tfPixels(s, sw, sh, mm, box, false) };
        if (src.mask) {
            const mk = src.mask, [ms, mw, mh] = this._pvShrunk(mk.m, mk.w, mk.h, k, true);
            const ox = (mk.x - src.x) / k, oy = (mk.y - src.y) / k;
            const m2 = { ...mm, e: mm.e + mm.a * ox + mm.c * oy, f: mm.f + mm.b * ox + mm.d * oy };
            const mb = D.tfBox(m2, mw, mh);
            o.mask = D.tfMask(ms, mw, mh, m2, mb, mk.fill);
            o.L.mask = { ...L.mask, x: mb.x, y: mb.y, w: mb.w, h: mb.h, feather: 0 };
        }
        this.requestPreview({ [L.id]: o });
    },

    /** The gradient tool while dragged: the layer with the gradient laid on it, at 1/k (a mask being painted: none). */
    _previewGradient(dr) {
        const k = this._previewK();
        if (k <= 1 || this._maskUp() || Math.hypot(dr.x1 - dr.x0, dr.y1 - dr.y0) < 1) return false;
        const L = this.active();
        if (!L || L.kind !== "pixel" || L.locked) return false;
        const o = this.opts.gradient, W = Math.ceil(this.doc.w / k), H = Math.ceil(this.doc.h / k);
        // The layer as it would be grown to the canvas, at 1/k.
        const x0 = Math.min(0, L.x), y0 = Math.min(0, L.y), x1 = Math.max(this.doc.w, L.x + L.w), y1 = Math.max(this.doc.h, L.y + L.h);
        const gx = Math.round(x0 / k), gy = Math.round(y0 / k), gw = Math.ceil((x1 - x0) / k), gh = Math.ceil((y1 - y0) / k);
        const base = new Uint8ClampedArray(gw * gh * 4);
        const b = this.pix.get(L.id);
        if (b) {
            const [s, sw, sh] = this._pvShrunk(b, L.w, L.h, k), lx = Math.round(L.x / k) - gx, ly = Math.round(L.y / k) - gy;
            for (let y = 0; y < sh; y++) {
                const ty = y + ly;
                if (ty < 0 || ty >= gh) continue;
                const a = Math.max(0, -lx), z = Math.min(sw, gw - lx);
                if (z > a) base.set(s.subarray((y * sw + a) * 4, (y * sw + z) * 4), (ty * gw + lx + a) * 4);
            }
        }
        const g = { type: o.type, x0: dr.x0 / k, y0: dr.y0 / k, x1: dr.x1 / k, y1: dr.y1 / k, reverse: !!o.reverse, stops: gradientStops(o.preset, this.fg, this.bg) };
        const gp = gradientPixels(gw, gh, gx, gy, g);
        let t = null;
        if (this.sel) {
            const [ss] = this._pvShrunk(this.sel, this.doc.w, this.doc.h, k, true);
            t = new Uint8Array(gw * gh);
            for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
                const cx = x + gx, cy = y + gy;
                if (cx >= 0 && cy >= 0 && cx < W && cy < H) t[y * gw + x] = ss[cy * W + cx];
            }
        }
        let laid = layOver(base, gp, o.opacity / 100, t);
        if (L.lockAlpha) for (let i = 3; i < laid.length; i += 4) laid[i] = base[i];
        this.requestPreview({ [L.id]: { L: { x: gx, y: gy, w: gw, h: gh, ...scaledLook(L, k) }, px: laid } });
        return true;
    },
};
