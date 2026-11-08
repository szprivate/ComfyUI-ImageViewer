// imageViewer_paintHeal.js
// Paint's healing: the Healing brush (paints texture from a source, Alt+click, that takes on the light and
// colour around where it lands), the Spot healing brush (no source: one is found nearby), and the Patch tool
// (a selection filled from where it is dragged to, or carried there).
//
// All three are seamless cloning as Pérez, Gangnet and Blake describe it ("Poisson image editing", 2003):
// inside the region the result keeps the source's gradients, and on its edge it meets the destination. That
// is the source plus a membrane - the smooth (harmonic) surface that is, on the edge, the destination minus
// the source - solved here by Gauss-Seidel relaxation, coarse to fine. The Spot brush picks its source by
// comparing the ring of pixels around the region with the ring around candidate places nearby (a small
// exhaustive search). Written from the paper and the textbook relaxation, not from any other program's code.
//
// The first half is the arithmetic (pure; tests/test_paint_heal.mjs), the second HealMixin, on the editor.

import * as D from "./imageViewer_paintData.js";

// ── the arithmetic ──────────────────────────────────────────────────────────

/**
 * The membrane: values for the `inside` pixels (1) of a w x h grid of C channels that are harmonic (each the
 * mean of its neighbours), the other pixels' values held as they are. `vals` is changed in place. Coarse to
 * fine: a grid of more than 32 x 32 is first solved at half its size, which starts the finer one off.
 */
export function membrane(vals, inside, w, h, C, iters = 60) {
    if (!inside.some((v) => v)) return vals;
    if (w > 32 && h > 32) {
        const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
        const cv = new Float64Array(cw * ch * C), ci = new Uint8Array(cw * ch);
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            let n = 0, all = true;
            const acc = new Float64Array(C);
            for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
                const X = 2 * x + i, Y = 2 * y + j;
                if (X >= w || Y >= h) continue;
                const k = Y * w + X;
                if (inside[k]) continue;
                all = false; n++;
                for (let c = 0; c < C; c++) acc[c] += vals[k * C + c];
            }
            const o = y * cw + x;
            if (all) ci[o] = 1;
            else for (let c = 0; c < C; c++) cv[o * C + c] = acc[c] / n;
        }
        membrane(cv, ci, cw, ch, C, iters);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const k = y * w + x;
            if (!inside[k]) continue;
            const o = (y >> 1) * cw + (x >> 1);
            for (let c = 0; c < C; c++) vals[k * C + c] = cv[o * C + c];
        }
    } else {
        // The coarsest grid: start from the mean of the edge.
        const acc = new Float64Array(C);
        let n = 0;
        for (let k = 0; k < w * h; k++) if (!inside[k]) { n++; for (let c = 0; c < C; c++) acc[c] += vals[k * C + c]; }
        for (let k = 0; k < w * h; k++) if (inside[k]) for (let c = 0; c < C; c++) vals[k * C + c] = n ? acc[c] / n : 0;
        iters = Math.max(iters, 4 * Math.max(w, h));
    }
    const list = [];
    for (let k = 0; k < w * h; k++) if (inside[k]) list.push(k);
    const omega = 1.7;                                  // over-relaxation
    for (let it = 0; it < iters; it++) {
        for (const k of list) {
            const x = k % w, y = (k - x) / w;
            let n = 0;
            for (let c = 0; c < C; c++) {
                let s = 0;
                n = 0;
                if (x > 0) { s += vals[(k - 1) * C + c]; n++; }
                if (x < w - 1) { s += vals[(k + 1) * C + c]; n++; }
                if (y > 0) { s += vals[(k - w) * C + c]; n++; }
                if (y < h - 1) { s += vals[(k + w) * C + c]; n++; }
                const cur = vals[k * C + c];
                vals[k * C + c] = cur + omega * (s / n - cur);
            }
        }
    }
    return vals;
}

/**
 * Seamless cloning over a box of a layer: `dst` the layer (RGBA, w x h), `inside` (w x h, >0 = to fill), `src`
 * RGBA with `srcAt(x, y)` -> its index (or -1: the destination's own pixel there). Returns the box
 * { x, y, w, h } and its filled pixels as premultiplied floats 0..1 (RGBA), the box's other pixels the destination's.
 */
export function seamlessBox(dst, w, h, inside, src, srcAt, box) {
    const { x: bx, y: by, w: bw, h: bh } = box;
    const n = bw * bh, S = new Float64Array(n * 4), M = new Float64Array(n * 4), In = new Uint8Array(n);
    const pm = (b, q, out, o) => { const a = b[q + 3] / 255; out[o] = (b[q] / 255) * a; out[o + 1] = (b[q + 1] / 255) * a; out[o + 2] = (b[q + 2] / 255) * a; out[o + 3] = a; };
    const tmp = new Float64Array(4);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const gx = x + bx, gy = y + by, k = y * bw + x, q = (gy * w + gx) * 4;
        const sq = srcAt(gx, gy);
        if (sq >= 0) pm(src, sq, S, k * 4); else pm(dst, q, S, k * 4);
        In[k] = inside[gy * w + gx] > 0 ? 1 : 0;
        pm(dst, q, tmp, 0);
        // On the edge: what the source lacks of the destination; the membrane carries it inside.
        for (let c = 0; c < 4; c++) M[k * 4 + c] = In[k] ? 0 : tmp[c] - S[k * 4 + c];
    }
    membrane(M, In, bw, bh, 4);
    const out = new Float64Array(n * 4);
    for (let k = 0; k < n; k++) for (let c = 0; c < 4; c++) out[k * 4 + c] = Math.max(0, Math.min(1, S[k * 4 + c] + M[k * 4 + c]));
    return out;
}

/** The box around the pixels of `inside` (w x h) that are > 0, grown by `pad` and held to the grid; null when there are none. */
export function insideBox(inside, w, h, pad = 2) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside[y * w + x] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The layer with the seamless result laid in by `cover` (w x h, 0..1 floats or 0..255 with `scale` 255) times `opacity`. */
export function blendHealed(dst, w, h, box, healed, cover, scale = 1, opacity = 1) {
    const out = new Uint8ClampedArray(dst);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
        const gx = x + box.x, gy = y + box.y, i = gy * w + gx;
        const t = Math.min(1, (cover[i] / scale) * opacity);
        if (t <= 0) continue;
        const k = (y * box.w + x) * 4, q = i * 4, a0 = dst[q + 3] / 255, a1 = healed[k + 3];
        const a = a0 * (1 - t) + a1 * t;
        for (let c = 0; c < 3; c++) {
            const v = (dst[q + c] / 255) * a0 * (1 - t) + healed[k + c] * t;
            out[q + c] = D.q8(a > 0 ? v / a : 0);
        }
        out[q + 3] = D.q8(a);
    }
    return out;
}

/**
 * Where a region (inside, in its `box`) is best taken from: { dx, dy } or null. Candidates lie around it, one to
 * two of its sizes away in 24 directions; each is scored by how much the pixels around the region (a ring
 * `ring` wide) differ from the pixels around the candidate, and the region and its source must not meet.
 */
export function findSource(px, w, h, inside, box, ring = 4) {
    const rx0 = Math.max(0, box.x - ring), ry0 = Math.max(0, box.y - ring);
    const rx1 = Math.min(w - 1, box.x + box.w - 1 + ring), ry1 = Math.min(h - 1, box.y + box.h - 1 + ring);
    const ringPts = [];
    const step = Math.max(1, Math.round(Math.sqrt(((rx1 - rx0 + 1) * (ry1 - ry0 + 1)) / 4000)));
    for (let y = ry0; y <= ry1; y += step) for (let x = rx0; x <= rx1; x += step) if (!(inside[y * w + x] > 0)) ringPts.push(y * w + x);
    if (!ringPts.length) return null;
    const size = Math.max(box.w, box.h);
    let best = null, bs = Infinity;
    for (const k of [1.15, 1.5, 2, 2.75]) for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const dx = Math.round(Math.cos(ang) * size * k), dy = Math.round(Math.sin(ang) * size * k);
        if (Math.abs(dx) < box.w && Math.abs(dy) < box.h) continue;                // overlaps itself
        if (rx0 + dx < 0 || ry0 + dy < 0 || rx1 + dx >= w || ry1 + dy >= h) continue;
        let s = 0;
        for (const i of ringPts) {
            const x = i % w, y = (i - x) / w, j = ((y + dy) * w + x + dx) * 4, q = i * 4;
            if (inside[(y + dy) * w + x + dx] > 0) { s += 3 * 255 * 255; continue; }       // a source that is itself the hole
            for (let c = 0; c < 3; c++) { const d = px[q + c] - px[j + c]; s += d * d; }
        }
        s /= ringPts.length;
        if (s < bs) { bs = s; best = { dx, dy }; }
    }
    return best;
}

/** Spot healing: the region (cover > 0) filled from the best place nearby, seamlessly; a smooth fill when none fits. */
export function spotHeal(px, w, h, cover, scale = 1, opacity = 1) {
    const box = insideBox(cover, w, h, 2);
    if (!box) return new Uint8ClampedArray(px);
    const off = findSource(px, w, h, cover, box);
    const healed = off
        ? seamlessBox(px, w, h, cover, px, (x, y) => { const X = x + off.dx, Y = y + off.dy; return X < 0 || Y < 0 || X >= w || Y >= h ? -1 : (Y * w + X) * 4; }, box)
        // No place fits: a source of nothing, so the membrane alone - the edge pulled smoothly in - is the fill.
        : seamlessBox(px, w, h, cover, new Uint8ClampedArray(px.length), (x, y) => (y * w + x) * 4, box);
    return blendHealed(px, w, h, box, healed, cover, scale, opacity);
}

/** The Patch tool: the region (sel, 0..255) filled from `dx`, `dy` away ("source"), or carried there ("destination"). */
export function patchArea(px, w, h, sel, dx, dy, mode = "source") {
    let region = sel, from;
    if (mode === "destination") {
        // The region moves to where it was dragged; it is filled from where it was.
        region = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const X = x - dx, Y = y - dy;
            if (X >= 0 && Y >= 0 && X < w && Y < h) region[y * w + x] = sel[Y * w + X];
        }
        from = (x, y) => { const X = x - dx, Y = y - dy; return X < 0 || Y < 0 || X >= w || Y >= h ? -1 : (Y * w + X) * 4; };
    } else from = (x, y) => { const X = x + dx, Y = y + dy; return X < 0 || Y < 0 || X >= w || Y >= h ? -1 : (Y * w + X) * 4; };
    const box = insideBox(region, w, h, 2);
    if (!box) return { px: new Uint8ClampedArray(px), region };
    const healed = seamlessBox(px, w, h, region, px, from, box);
    return { px: blendHealed(px, w, h, box, healed, region, 255), region };
}

// ── the tools ───────────────────────────────────────────────────────────────

export const HealMixin = {
    /** At the end of a Healing / Spot healing stroke: the painted area made seamless, into the stroke's pixels. */
    _healFinish(s) {
        const w = s.lw, h = s.lh, cover = s.cover;
        let out;
        if (s.heal === "spot") out = spotHeal(s.orig, w, h, cover, 1, s.healOpacity);
        else {
            const c = s.clone, box = insideBox(cover, w, h, 2);
            if (!box) return;
            const healed = seamlessBox(s.orig, w, h, cover, c.src, (x, y) => D.cloneAt(c, x + s.lx, y + s.ly), box);
            out = blendHealed(s.orig, w, h, box, healed, cover, 1, s.healOpacity);
        }
        s.px.set(out);
    },

    /** The Patch tool's press: inside the selection, drag it to where the patch comes from; elsewhere, draw a new selection. */
    _patchDown(p, e) {
        const W = this.doc.w, x = Math.floor(p.x), y = Math.floor(p.y);
        if (this.sel && x >= 0 && y >= 0 && x < W && y < this.doc.h && this.sel[y * W + x] > 0 && !e.shiftKey && !e.altKey) {
            this._drag = { kind: "patch", p0: { x: p.x, y: p.y }, dx: 0, dy: 0 };
            return;
        }
        this._drag = { kind: "lasso", pts: [[p.x, p.y]], e };
    },

    _patchMove(dr, p) {
        dr.dx = Math.round(p.x - dr.p0.x);
        dr.dy = Math.round(p.y - dr.p0.y);
        this.drawOverlay();
    },

    _patchUp(dr) {
        if (!dr.dx && !dr.dy) { this.drawOverlay(); return; }
        this.patch(dr.dx, dr.dy, this.opts.patch.mode);
    },

    /** Patch the selection on the active pixel layer from (or to) dx, dy away; one undo step. */
    patch(dx, dy, mode = "source") {
        if (!this.sel) { this._notify("Patch: select the area first (draw round it with the Patch tool).", "info"); return false; }
        const L = this._pixelTarget("Patch");
        if (!L) return false;
        return this.change("Patch", () => {
            const px = this._growToCanvas(L), W = this.doc.w, H = this.doc.h;
            const sel = D.maskForLayer(this.sel, W, H, L);
            const r = patchArea(px, L.w, L.h, sel, dx, dy, mode);
            this.pix.set(L.id, r.px);
            if (mode === "destination") {
                // The selection goes with the patch.
                const s = new Uint8Array(W * H);
                for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                    const X = x - dx, Y = y - dy;
                    if (X >= 0 && Y >= 0 && X < W && Y < H) s[y * W + x] = this.sel[Y * W + X];
                }
                this.sel = s.some((v) => v) ? s : null;
            }
        });
    },

    /** The selection's outline where the patch would come from, while it is dragged. */
    _patchDraw(c, X, Y) {
        const dr = this._drag;
        if (!dr || dr.kind !== "patch" || !this.selSegs) return;
        const s = this.selSegs, dx = dr.dx, dy = dr.dy;
        c.beginPath();
        for (let i = 0; i < s.length; i += 4) { c.moveTo(X(s[i] + dx) + 0.5, Y(s[i + 1] + dy) + 0.5); c.lineTo(X(s[i + 2] + dx) + 0.5, Y(s[i + 3] + dy) + 0.5); }
        c.lineWidth = 1; c.setLineDash([3, 3]);
        c.strokeStyle = "#4fd6ee"; c.stroke(); c.setLineDash([]);
    },
};
