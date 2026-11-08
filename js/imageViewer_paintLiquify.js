// Paint's Liquify (Filter > Liquify, Shift+Ctrl+X): a brush that pushes the active layer's pixels about -
// forward warp, reconstruct, twirl either way, pucker and bloat. The layer is kept as it was and a field of
// offsets is painted: each pixel of the result is the source read at (x + dx, y + dy), bilinear on
// premultiplied colour. One undo step when it is applied. Page only. Written from what the tool does, not
// from any other program's code.

export const LQ_MODES = ["push", "reconstruct", "twirl_cw", "twirl_ccw", "pucker", "bloat"];
export const LQ_LABELS = { push: "Forward warp", reconstruct: "Reconstruct", twirl_cw: "Twirl clockwise", twirl_ccw: "Twirl anticlockwise",
                           pucker: "Pucker", bloat: "Bloat" };
/** How far a dab of full strength turns (radians) or pulls in / pushes out (a share of the distance). */
const TWIRL = 0.12, PUCKER = 0.06;

export function liquifyField(w, h) { return { w, h, dx: new Float32Array(w * h), dy: new Float32Array(w * h) }; }

/** The brush's weight at distance d of radius R: 1 in the middle, 0 at the edge, smooth both ends. */
export function falloff(d, R) { if (d >= R) return 0; const t = 1 - (d * d) / (R * R); return t * t; }

/**
 * One dab into the field at (cx, cy) - layer pixels - of radius R and strength s (0..1). Push moves the
 * picture by (mx, my) under the brush. Returns the box it changed [x0, y0, x1, y1], or null.
 */
export function liquifyDab(f, mode, cx, cy, R, s, mx = 0, my = 0) {
    const { w, h, dx, dy } = f;
    const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(w, Math.ceil(cx + R) + 1), y1 = Math.min(h, Math.ceil(cy + R) + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    // Push reads the field where the content now under each pixel came from, so a stroke drags it along:
    // the field as it was before this dab, kept for the box (and a margin as wide as the move).
    let old = null;
    if (mode === "push") {
        const pad = Math.ceil(Math.hypot(mx, my) * s) + 2;
        const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad), bx1 = Math.min(w, x1 + pad), by1 = Math.min(h, y1 + pad), bw = bx1 - bx0;
        old = { x0: bx0, y0: by0, x1: bx1, y1: by1, w: bw, dx: new Float32Array(bw * (by1 - by0)), dy: new Float32Array(bw * (by1 - by0)) };
        for (let y = by0; y < by1; y++) {
            old.dx.set(dx.subarray(y * w + bx0, y * w + bx1), (y - by0) * bw);
            old.dy.set(dy.subarray(y * w + bx0, y * w + bx1), (y - by0) * bw);
        }
    }
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const px = x + 0.5, py = y + 0.5, qx = px - cx, qy = py - cy;
            const k = falloff(Math.hypot(qx, qy), R) * s;
            if (k <= 0) continue;
            const i = y * w + x;
            if (mode === "push") {
                const [ox, oy] = sampleField(f, old, px - mx * k, py - my * k);
                dx[i] = ox - mx * k; dy[i] = oy - my * k;
            } else if (mode === "reconstruct") {
                dx[i] *= 1 - k; dy[i] *= 1 - k;
            } else if (mode === "twirl_cw" || mode === "twirl_ccw") {
                // Read from a point turned the other way round, so the picture turns (y down: + is clockwise on screen).
                const a = (mode === "twirl_cw" ? -TWIRL : TWIRL) * k, c = Math.cos(a), sn = Math.sin(a);
                dx[i] += qx * c - qy * sn - qx; dy[i] += qx * sn + qy * c - qy;
            } else {
                const g = (mode === "pucker" ? PUCKER : -PUCKER) * k;
                dx[i] += qx * g; dy[i] += qy * g;
            }
        }
    }
    return [x0, y0, x1, y1];
}

/** The field before the dab at a point (pixel centres), bilinear: from the kept box, else the field (unchanged there); 0 outside. */
function sampleField(f, old, x, y) {
    const { w, h } = f;
    const fx = x - 0.5, fy = y - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    let ox = 0, oy = 0;
    for (const [jx, jy, wt] of [[ix, iy, (1 - tx) * (1 - ty)], [ix + 1, iy, tx * (1 - ty)], [ix, iy + 1, (1 - tx) * ty], [ix + 1, iy + 1, tx * ty]]) {
        if (wt <= 0 || jx < 0 || jy < 0 || jx >= w || jy >= h) continue;
        if (jx >= old.x0 && jx < old.x1 && jy >= old.y0 && jy < old.y1) {
            const j = (jy - old.y0) * old.w + jx - old.x0;
            ox += old.dx[j] * wt; oy += old.dy[j] * wt;
        } else { ox += f.dx[jy * w + jx] * wt; oy += f.dy[jy * w + jx] * wt; }
    }
    return [ox, oy];
}

/** The source read through the field over [x0, y0, x1, y1] into `out` (both w x h RGBA), bilinear, premultiplied. */
export function liquifyInto(out, src, f, box = null) {
    const { w, h, dx, dy } = f;
    const [x0, y0, x1, y1] = box || [0, 0, w, h];
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = y * w + x, o = i * 4;
            if (dx[i] === 0 && dy[i] === 0) { out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; out[o + 3] = src[o + 3]; continue; }
            const fx = x + dx[i], fy = y + dy[i], ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
            let r = 0, g = 0, b = 0, a = 0;
            for (const [jx, jy, wt] of [[ix, iy, (1 - tx) * (1 - ty)], [ix + 1, iy, tx * (1 - ty)], [ix, iy + 1, (1 - tx) * ty], [ix + 1, iy + 1, tx * ty]]) {
                if (wt <= 0 || jx < 0 || jy < 0 || jx >= w || jy >= h) continue;
                const s = (jy * w + jx) * 4, al = (src[s + 3] / 255) * wt;
                r += src[s] * al; g += src[s + 1] * al; b += src[s + 2] * al; a += al;
            }
            if (a <= 1e-9) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
            out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = a * 255;
        }
    }
    return out;
}

export function liquifyPixels(src, f) { return liquifyInto(new Uint8ClampedArray(src.length), src, f); }

export const LiquifyMixin = {
    /** Start liquifying the active pixel layer (the tool `liquify`); the layer is grown to the canvas first. */
    lqBegin() {
        if (this.lq) return this.lq;
        this._tfSettle();
        this._commitText && this._commitText();
        const L = this.active();
        if (!L || L.kind !== "pixel") { this._notify("Liquify works on a pixel layer.", "info"); return null; }
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return null; }
        if (this._smartRefuses && this._smartRefuses(L, "Liquify")) return null;
        const before = this._snap();
        // The picture may be pushed into the space around a smaller layer: work on the canvas's size.
        const W = this.doc.w, H = this.doc.h;
        if (L.x > 0 || L.y > 0 || L.x + L.w < W || L.y + L.h < H) this._growToCanvas(L);
        // The layer's buffer is the snapshot's (kept for Cancel and Undo): the work goes into a copy.
        const src = this.pix.get(L.id);
        this.pix.set(L.id, new Uint8ClampedArray(src));
        this.lq = { L, src, before, f: liquifyField(L.w, L.h), touched: false };
        if (this.tool !== "liquify") this.setTool("liquify");
        else { this.refreshProps(); this.drawOverlay(); }
        return this.lq;
    },

    _lqDown(p) {
        const lq = this.lq || this.lqBegin();
        if (!lq) return;
        this._drag = { kind: "lq", last: [p.x, p.y] };
        this._lqDab(p.x, p.y, 0, 0);
    },

    _lqMove(dr, p) {
        const [lx, ly] = dr.last, o = this.opts.liquify, R = o.size / 2;
        const dist = Math.hypot(p.x - lx, p.y - ly), step = Math.max(1, R * 0.15);
        if (this.opts.liquify.mode === "push") {
            if (dist < 0.5) return;
            // The stroke cut into short steps: each moves the picture by its own length.
            const n = Math.max(1, Math.ceil(dist / step));
            for (let k = 1; k <= n; k++) this._lqDab(lx + (p.x - lx) * k / n, ly + (p.y - ly) * k / n, (p.x - lx) / n, (p.y - ly) / n);
        } else this._lqDab(p.x, p.y, 0, 0);
        dr.last = [p.x, p.y];
    },

    _lqDab(x, y, mx, my) {
        const lq = this.lq, o = this.opts.liquify, L = lq.L;
        const box = liquifyDab(lq.f, o.mode, x - L.x, y - L.y, o.size / 2, o.strength / 100, mx, my);
        if (!box) return;
        lq.touched = true;
        const px = this.pix.get(L.id);
        liquifyInto(px, lq.src, lq.f, box);
        this._bump(px);
        this.requestRedraw(L.style || L.filters ? null : { x0: box[0] + L.x, y0: box[1] + L.y, x1: box[2] + L.x, y1: box[3] + L.y });
    },

    /** Keep what was done: one undo step "Liquify". */
    lqCommit() {
        const lq = this.lq;
        if (!lq) return false;
        this.lq = null;
        if (!lq.touched) { this._restore(lq.before); this._afterHistory(); return false; }
        const before = lq.before, after = this._snap();
        this._push({ label: "Liquify", undo: () => this._restore(before), redo: () => this._restore(after), bytes: this._snapBytes(before, after) });
        this._afterHistory();
        this._thumbsSoon();
        return true;
    },

    lqCancel() {
        const lq = this.lq;
        if (!lq) return;
        this.lq = null;
        this._restore(lq.before);
        this._afterHistory();
    },

    /** Restore all: the field emptied, the layer as it was when Liquify began (still liquifying). */
    lqRestoreAll() {
        const lq = this.lq;
        if (!lq) return;
        lq.f = liquifyField(lq.L.w, lq.L.h);
        const px = this.pix.get(lq.L.id);
        px.set(lq.src);
        this._bump(px);
        this.requestRedraw(null);
    },

    _lqOptions(ts, bar, sync, note) {
        const o = this.opts.liquify;
        const md = this.el("select", "lq-mode");
        for (const m of LQ_MODES) md.append(this.el("option", "", { value: m, text: LQ_LABELS[m] }));
        md.value = o.mode;
        md.addEventListener("change", () => { o.mode = md.value; sync(); });
        this._field(ts, "Mode", md);
        this._slider(ts, "Size", o.size, 2, 2000, 1, (v) => { o.size = v; sync(); this.drawOverlay(); });
        this._slider(ts, "Strength %", o.strength, 1, 100, 1, (v) => { o.strength = v; sync(); });
        const row = this.el("div", "paint-field wrap");
        const go = this.el("button", "paint-btn on lq-apply", { type: "button", text: "Apply (Enter)" });
        go.disabled = !this.lq;
        go.addEventListener("click", () => this.lqCommit());
        const no = this.el("button", "paint-btn lq-cancel", { type: "button", text: "Cancel (Esc)" });
        no.disabled = !this.lq;
        no.addEventListener("click", () => this.lqCancel());
        const ra = this.el("button", "paint-btn lq-restore", { type: "button", text: "Restore all" });
        ra.disabled = !this.lq;
        ra.addEventListener("click", () => this.lqRestoreAll());
        row.append(go, no, ra);
        ts.append(row);
        if (!bar) note("Paint over the layer to push its pixels about; [ / ] the size. Enter applies it all as one step, Esc throws it away.");
    },
};
