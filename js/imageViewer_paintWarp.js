// imageViewer_paintWarp.js
// Paint's Distort, Perspective and Warp: a pixel layer (and its mask) bent by its four corners (a projective
// transform, the homography that takes the layer's rectangle to the four points) or by a grid of points (a
// smooth surface through them, Catmull-Rom across and down, drawn as small triangles).
//
// The first half is the arithmetic (pure, tested in tests/test_paint_warp.mjs); the second, WarpMixin, the
// session on the editor's prototype, like the free transform's: begun by Edit's / Layer's menu or the
// Transform tool's options, the layer shown as it would be while points move, Enter applies (one undo step),
// Esc cancels, anything else that changes the document applies it first.
//
// Written from the textbook definitions (the direct linear transform for four point pairs, Catmull-Rom
// splines, barycentric coordinates), not from any other program's code.

// ── the arithmetic ──────────────────────────────────────────────────────────

/** The homography taking four points `from` to four points `to` ([[x, y] x 4]): [h0..h7] (h8 = 1), or null. */
export function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
        const [x, y] = from[i], [X, Y] = to[i];
        A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
        A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    // Gaussian elimination with partial pivoting.
    for (let c = 0; c < 8; c++) {
        let p = c;
        for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-12) return null;
        [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
        for (let r = 0; r < 8; r++) {
            if (r === c) continue;
            const f = A[r][c] / A[c][c];
            if (!f) continue;
            for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
            b[r] -= f * b[c];
        }
    }
    return b.map((v, i) => v / A[i][i]);
}

export function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + 1;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Are the four points a shape a projective transform can make (convex, the same turn at every corner)? */
export function convexQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
        const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
        const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
        if (Math.abs(z) < 1e-9) return false;
        if (!sign) sign = Math.sign(z);
        else if (Math.sign(z) !== sign) return false;
    }
    return true;
}

/** The whole-pixel box around points [[x, y], ...]. */
export function boxOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.floor(x0 + 1e-6); y0 = Math.floor(y0 + 1e-6);
    return { x: x0, y: y0, w: Math.max(1, Math.ceil(x1 - 1e-6) - x0), h: Math.max(1, Math.ceil(y1 - 1e-6) - y0) };
}

/** RGBA at (u, v) in the source's pixels (pixel middles at .5), bilinear with premultiplied alpha, into out[o..o+3]. */
function sampleRGBA(src, w, h, u, v, out, o, smooth) {
    if (!smooth) {
        const ui = Math.floor(u), vi = Math.floor(v);
        if (ui < 0 || vi < 0 || ui >= w || vi >= h) return;
        const q = (vi * w + ui) * 4;
        out[o] = src[q]; out[o + 1] = src[q + 1]; out[o + 2] = src[q + 2]; out[o + 3] = src[q + 3];
        return;
    }
    const fu = u - 0.5, fv = v - 0.5, u0 = Math.floor(fu), v0 = Math.floor(fv), du = fu - u0, dv = fv - v0;
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
    if (al <= 0) return;
    // A Uint8ClampedArray rounds to the nearest by itself.
    out[o] = r / al; out[o + 1] = g / al; out[o + 2] = bl / al; out[o + 3] = al;
}

function sampleMask(src, w, h, u, v, fill) {
    const fu = u - 0.5, fv = v - 0.5, u0 = Math.floor(fu), v0 = Math.floor(fv), du = fu - u0, dv = fv - v0;
    let s = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const ux = u0 + i, vy = v0 + j;
        const val = ux < 0 || vy < 0 || ux >= w || vy >= h ? fill : src[vy * w + ux];
        s += val * (j ? dv : 1 - dv) * (i ? du : 1 - du);
    }
    return Math.round(s);
}

/** The corners of a w x h source in its own pixels, as the quads list them: top left, top right, bottom right, bottom left. */
const rectOf = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

/**
 * A layer (RGBA, w x h; or a mask, `ch` 1 with `fill` outside it) taken onto the four corners `quad` (canvas
 * pixels): { px, box }. Every pixel of the box is taken back through the inverse homography.
 */
export function perspectiveLayer(src, w, h, quad, { ch = 4, fill = 0, smooth = true } = {}) {
    const box = boxOf(quad), H = homography(quad, rectOf(w, h));
    const out = ch === 4 ? new Uint8ClampedArray(box.w * box.h * 4) : new Uint8Array(box.w * box.h).fill(fill);
    if (!H || !convexQuad(quad)) return { px: out, box };
    for (let Y = 0; Y < box.h; Y++) for (let X = 0; X < box.w; X++) {
        const [u, v] = applyH(H, box.x + X + 0.5, box.y + Y + 0.5);
        if (ch === 4) sampleRGBA(src, w, h, u, v, out, (Y * box.w + X) * 4, smooth);
        else out[Y * box.w + X] = sampleMask(src, w, h, u, v, fill);
    }
    return { px: out, box };
}

/** The (n+1) x (n+1) grid of a w x h layer lying at (x, y), row by row: [[x, y], ...]. */
export function warpGrid(n, x, y, w, h) {
    const g = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) g.push([x + (w * i) / n, y + (h * j) / n]);
    return g;
}

const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

/** The grid point (i, j); beyond the edge, the straight line on from the last two. */
function gp(grid, n, i, j) {
    const ci = Math.max(0, Math.min(n, i)), cj = Math.max(0, Math.min(n, j));
    if (ci === i && cj === j) return grid[j * (n + 1) + i];
    const a = gp(grid, n, ci, cj);
    const bi = i < 0 ? 1 : i > n ? n - 1 : ci, bj = j < 0 ? 1 : j > n ? n - 1 : cj;
    const b = gp(grid, n, bi, bj);
    return [2 * a[0] - b[0], 2 * a[1] - b[1]];
}

/** Where the surface through the grid takes (s, t), both 0..n (grid units): a Catmull-Rom patch, through every point. */
export function warpAt(grid, n, s, t) {
    const i = Math.min(n - 1, Math.max(0, Math.floor(s))), j = Math.min(n - 1, Math.max(0, Math.floor(t)));
    const fs = s - i, ft = t - j;
    const rows = [];
    for (let dj = -1; dj <= 2; dj++) {
        const q = [-1, 0, 1, 2].map((di) => gp(grid, n, i + di, j + dj));
        rows.push([cr(q[0][0], q[1][0], q[2][0], q[3][0], fs), cr(q[0][1], q[1][1], q[2][1], q[3][1], fs)]);
    }
    return [cr(rows[0][0], rows[1][0], rows[2][0], rows[3][0], ft), cr(rows[0][1], rows[1][1], rows[2][1], rows[3][1], ft)];
}

/** The surface sampled `S` times a cell: { pts (canvas), m = n * S } as an (m+1)² lattice, row by row. */
export function warpLattice(grid, n, S) {
    const m = n * S, pts = [];
    for (let b = 0; b <= m; b++) for (let a = 0; a <= m; a++) pts.push(warpAt(grid, n, a / S, b / S));
    return { pts, m };
}

/**
 * A layer bent by the grid: { px, box }. The lattice's small quads are split into two triangles each and
 * every pixel middle inside one is taken back to the source by its barycentric coordinates.
 */
export function warpLayer(src, w, h, grid, n, { ch = 4, fill = 0, smooth = true, S = 8 } = {}) {
    const { pts, m } = warpLattice(grid, n, S);
    const box = boxOf(pts);
    const out = ch === 4 ? new Uint8ClampedArray(box.w * box.h * 4) : new Uint8Array(box.w * box.h).fill(fill);
    const uv = (a, b) => [(w * a) / m, (h * b) / m];
    const tri = (P0, P1, P2, T0, T1, T2) => {
        const x0 = Math.max(box.x, Math.floor(Math.min(P0[0], P1[0], P2[0]))), x1 = Math.min(box.x + box.w - 1, Math.ceil(Math.max(P0[0], P1[0], P2[0])));
        const y0 = Math.max(box.y, Math.floor(Math.min(P0[1], P1[1], P2[1]))), y1 = Math.min(box.y + box.h - 1, Math.ceil(Math.max(P0[1], P1[1], P2[1])));
        const d = (P1[1] - P2[1]) * (P0[0] - P2[0]) + (P2[0] - P1[0]) * (P0[1] - P2[1]);
        if (Math.abs(d) < 1e-12) return;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const l0 = ((P1[1] - P2[1]) * (px - P2[0]) + (P2[0] - P1[0]) * (py - P2[1])) / d;
            const l1 = ((P2[1] - P0[1]) * (px - P2[0]) + (P0[0] - P2[0]) * (py - P2[1])) / d;
            const l2 = 1 - l0 - l1;
            if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
            const u = l0 * T0[0] + l1 * T1[0] + l2 * T2[0], v = l0 * T0[1] + l1 * T1[1] + l2 * T2[1];
            const o = (y - box.y) * box.w + (x - box.x);
            if (ch === 4) sampleRGBA(src, w, h, u, v, out, o * 4, smooth);
            else out[o] = sampleMask(src, w, h, u, v, fill);
        }
    };
    for (let b = 0; b < m; b++) for (let a = 0; a < m; a++) {
        const k = b * (m + 1) + a;
        const p00 = pts[k], p10 = pts[k + 1], p01 = pts[k + m + 1], p11 = pts[k + m + 2];
        const t00 = uv(a, b), t10 = uv(a + 1, b), t01 = uv(a, b + 1), t11 = uv(a + 1, b + 1);
        tri(p00, p10, p11, t00, t10, t11);
        tri(p00, p11, p01, t00, t11, t01);
    }
    return { px: out, box };
}

/** A corner dragged in Perspective: the corner beside it on the same edge goes the other way, so the edge stays centred. */
export function perspectiveDrag(quad0, i, dx, dy) {
    const q = quad0.map((p) => [...p]);
    if (Math.abs(dx) >= Math.abs(dy)) {
        const j = { 0: 1, 1: 0, 2: 3, 3: 2 }[i];            // the same top / bottom edge
        q[i][0] += dx; q[j][0] -= dx;
    } else {
        const j = { 0: 3, 3: 0, 1: 2, 2: 1 }[i];            // the same left / right edge
        q[i][1] += dy; q[j][1] -= dy;
    }
    return q;
}

// ── the session ─────────────────────────────────────────────────────────────

const HIT_PX = 8;
const LABELS = { distort: "Distort", perspective: "Perspective", warp: "Warp" };

export const WarpMixin = {
    /** Begin Distort, Perspective or Warp on the active pixel layer (a free transform being made is applied first). */
    wpBegin(mode = "distort", n = 3) {
        if (this.wp) { if (this.wp.mode === mode && (mode !== "warp" || this.wp.n === n)) return this.wp; this.wpCommit(); }
        if (this.tf) this.tfCommit();
        this._commitText();
        const L = this._tfLayer();
        if (!L) return null;
        const before = this._snap();
        const src = { px: this.pix.get(L.id), x: L.x, y: L.y, w: L.w, h: L.h,
                      mask: L.mask ? { m: this.masks.get(L.id), x: L.mask.x, y: L.mask.y, w: L.mask.w, h: L.mask.h, fill: L.mask.fill } : null };
        n = Math.max(1, Math.min(8, n | 0));
        const pts = mode === "warp" ? warpGrid(n, L.x, L.y, L.w, L.h) : [[L.x, L.y], [L.x + L.w, L.y], [L.x + L.w, L.y + L.h], [L.x, L.y + L.h]];
        this.wp = { L, src, mode, n, pts, start: pts.map((p) => [...p]), before, smooth: true };
        if (this.tool !== "move") this.setTool("move");
        else { this.refreshProps(); this.drawOverlay(); }
        return this.wp;
    },

    /** The press: on a point, drag it (Perspective: with its partner). Elsewhere nothing. */
    _wpDown(p) {
        const wp = this.wp, v = this.view;
        let best = -1, bd = HIT_PX;
        wp.pts.forEach(([x, y], i) => {
            const d = Math.hypot(v.x + x * v.zoom - p.sx, v.y + y * v.zoom - p.sy);
            if (d < bd) { bd = d; best = i; }
        });
        if (best < 0) return;
        this._drag = { kind: "wp", i: best, p0: { x: p.x, y: p.y }, pts0: wp.pts.map((q) => [...q]) };
    },

    _wpMove(dr, p) {
        const wp = this.wp;
        if (!wp) return;
        const dx = p.x - dr.p0.x, dy = p.y - dr.p0.y;
        let pts;
        if (wp.mode === "perspective") pts = perspectiveDrag(dr.pts0, dr.i, dx, dy);
        else { pts = dr.pts0.map((q) => [...q]); pts[dr.i] = [dr.pts0[dr.i][0] + dx, dr.pts0[dr.i][1] + dy]; }
        if (wp.mode !== "warp" && !convexQuad(pts)) return;     // a corner pulled across: not a shape it can make
        wp.pts = pts;
        this._wpShowSoon();
    },

    _wpUp() { this._wpShow(true); },

    _wpShowSoon() {
        if (this._wpRaf) return;
        this._wpRaf = this.d.defaultView.requestAnimationFrame(() => { this._wpRaf = 0; this._wpShow(false); });
    },

    /** The layer as the points make it: rough (nearest pixel, a coarser lattice) while dragging, smooth when let go. */
    _wpShow(smooth) {
        const wp = this.wp;
        if (!wp) return;
        if (this._wpRaf) { this.d.defaultView.cancelAnimationFrame(this._wpRaf); this._wpRaf = 0; }
        const { L, src } = wp;
        const run = (s, w, h, opts) => (wp.mode === "warp" ? warpLayer(s, w, h, wp.pts, wp.n, { ...opts, smooth, S: smooth ? 8 : 4 })
                                                           : perspectiveLayer(s, w, h, wp.pts, { ...opts, smooth }));
        const r = run(src.px, src.w, src.h, { ch: 4 });
        if (r.box.w > this.MAX_SIDE_WARP || r.box.h > this.MAX_SIDE_WARP) return;
        this.pix.set(L.id, r.px);
        Object.assign(L, { x: r.box.x, y: r.box.y, w: r.box.w, h: r.box.h });
        if (src.mask) {
            // The mask goes with the layer's pixels: taken through the same mapping, as a mask of the layer's own rectangle.
            const mk = src.mask, cut = new Uint8Array(src.w * src.h);
            for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
                const mx = x + src.x - mk.x, my = y + src.y - mk.y;
                cut[y * src.w + x] = mx >= 0 && my >= 0 && mx < mk.w && my < mk.h ? mk.m[my * mk.w + mx] : mk.fill;
            }
            const mr = run(cut, src.w, src.h, { ch: 1, fill: mk.fill });
            this.masks.set(L.id, mr.px);
            L.mask = { ...L.mask, x: mr.box.x, y: mr.box.y, w: mr.box.w, h: mr.box.h };
        }
        wp.smooth = smooth;
        this.requestRedraw();
        this.drawOverlay();
    },

    MAX_SIDE_WARP: 32768,

    wpCommit() {
        const wp = this.wp;
        if (!wp) return false;
        if (!wp.smooth || this._wpRaf) this._wpShow(true);
        this.wp = null;
        if (JSON.stringify(wp.pts) === JSON.stringify(wp.start)) {
            this._restore(wp.before);
            this._afterHistory();
            return false;
        }
        const before = wp.before, after = this._snap();
        this._push({ label: LABELS[wp.mode], undo: () => this._restore(before), redo: () => this._restore(after), bytes: this._snapBytes(before, after) });
        this._afterHistory();
        this._thumbsSoon();
        return true;
    },

    wpCancel() {
        const wp = this.wp;
        if (!wp) return;
        if (this._wpRaf) { this.d.defaultView.cancelAnimationFrame(this._wpRaf); this._wpRaf = 0; }
        this.wp = null;
        this._restore(wp.before);
        this._afterHistory();
    },

    /** The points and the shape on the picture: the outline (and, for Warp, the grid's lines through the surface). */
    _wpDraw(c, X, Y) {
        const wp = this.wp;
        if (!wp) return;
        c.lineWidth = 1;
        c.strokeStyle = "#4fd6ee";
        if (wp.mode === "warp") {
            const n = wp.n, S = 6;
            for (let k = 0; k <= n; k++) for (const across of [true, false]) {
                c.beginPath();
                for (let s = 0; s <= n * S; s++) {
                    const [x, y] = across ? warpAt(wp.pts, n, s / S, k) : warpAt(wp.pts, n, k, s / S);
                    if (s) c.lineTo(X(x), Y(y)); else c.moveTo(X(x), Y(y));
                }
                c.stroke();
            }
        } else {
            c.beginPath();
            wp.pts.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))));
            c.closePath(); c.stroke();
        }
        c.fillStyle = "#fff"; c.strokeStyle = "#000";
        for (const [x, y] of wp.pts) {
            c.fillRect(Math.round(X(x)) - 3.5, Math.round(Y(y)) - 3.5, 7, 7);
            c.strokeRect(Math.round(X(x)) - 3.5, Math.round(Y(y)) - 3.5, 7, 7);
        }
    },

    /** The Transform tool's row of these (options bar and Properties). */
    _wpOptions(ts, bar) {
        const row = this.el("div", "paint-field wrap");
        const wp = this.wp;
        for (const [mode, title] of [["distort", "Drag each corner where it should go"], ["perspective", "Drag a corner: the one beside it moves the other way"],
                                     ["warp", "Bend the layer by a grid of points"]]) {
            const b = this.el("button", "paint-btn wp-" + mode + (wp && wp.mode === mode ? " on" : ""), { type: "button", text: LABELS[mode], title });
            b.addEventListener("click", () => this.wpBegin(mode, this.opts.warp.n));
            row.append(b);
        }
        const n = this.el("select", "paint-warpgrid", { title: "Warp: cells across and down" });
        for (const k of [1, 2, 3, 4, 6, 8]) n.append(this.el("option", "", { value: String(k), text: `${k} x ${k}` }));
        n.value = String(this.opts.warp.n);
        n.addEventListener("change", () => { this.opts.warp.n = Number(n.value); if (this.wp && this.wp.mode === "warp") { this.wpCancel(); this.wpBegin("warp", this.opts.warp.n); } this._optSync(bar); });
        row.append(n);
        if (wp) {
            const go = this.el("button", "paint-btn on", { type: "button", text: "Apply (Enter)" });
            go.addEventListener("click", () => this.wpCommit());
            const no = this.el("button", "paint-btn", { type: "button", text: "Cancel (Esc)" });
            no.addEventListener("click", () => this.wpCancel());
            row.append(go, no);
        }
        ts.append(row);
        if (!bar && wp) ts.append(this.el("div", "paint-note", { text: `${LABELS[wp.mode]}: drag the points. Enter or a double-click applies, Esc cancels.` }));
    },
};
