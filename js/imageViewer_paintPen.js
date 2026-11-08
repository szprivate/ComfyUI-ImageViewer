// imageViewer_paintPen.js
// Paint's pen: Bezier paths drawn anchor by anchor, kept in the document (doc.paths, saved in the .ora's
// imageviewer.json), and turned into a selection, a fill, a stroke or a layer mask. A flat object of
// methods put onto the editor's prototype (PenMixin); the arithmetic is in imageViewer_paintData.js
// (flattenPath, pathMask, strokeMask, pathHit, movePathPoint), and paint_math.py has its twin.
//
// Written from how a pen tool behaves (click a corner, drag a smooth anchor, click the first anchor to
// close, Ctrl to move, Alt to convert) and the textbook Bezier arithmetic (de Casteljau), not from any
// other program's code.

import * as D from "./imageViewer_paintData.js";

/** Pixels on screen within which an anchor or handle is hit. */
const HIT_PX = 6;

/** A segment split at t (de Casteljau): the anchors before / after with their new handles, and the new anchor. */
export function splitSegment(a, b, t) {
    const L = (p, q) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const p0 = [a.x, a.y], p1 = [a.ox, a.oy], p2 = [b.ix, b.iy], p3 = [b.x, b.y];
    const q0 = L(p0, p1), q1 = L(p1, p2), q2 = L(p2, p3), r0 = L(q0, q1), r1 = L(q1, q2), s = L(r0, r1);
    const straight = a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y;
    const m = straight ? { x: s[0], y: s[1], ix: s[0], iy: s[1], ox: s[0], oy: s[1], smooth: false }
                       : { x: s[0], y: s[1], ix: r0[0], iy: r0[1], ox: r1[0], oy: r1[1], smooth: true };
    return [straight ? { ...a } : { ...a, ox: q0[0], oy: q0[1] }, m, straight ? { ...b } : { ...b, ix: q2[0], iy: q2[1] }];
}

/** The segment of `path` within `tol` of (x, y): { i (from anchor i), t } or null. */
export function segmentHit(path, x, y, tol) {
    const pts = path.pts, segs = path.closed ? pts.length : pts.length - 1;
    let best = null, bd = tol;
    for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const n = 48;
        let prev = [a.x, a.y];
        for (let k = 1; k <= n; k++) {
            const cur = D.bezierAt(a, b, k / n);
            const dx = cur[0] - prev[0], dy = cur[1] - prev[1], ll = dx * dx + dy * dy;
            let u = ll > 0 ? ((x - prev[0]) * dx + (y - prev[1]) * dy) / ll : 0;
            u = Math.max(0, Math.min(1, u));
            const d = Math.hypot(x - prev[0] - u * dx, y - prev[1] - u * dy);
            if (d < bd) { bd = d; best = { i, t: (k - 1 + u) / n }; }
            prev = cur;
        }
    }
    if (!best) return null;
    // Next to an anchor it is that anchor's, not a new one.
    const a = pts[best.i], b = pts[(best.i + 1) % pts.length], [hx, hy] = D.bezierAt(a, b, best.t);
    return Math.hypot(hx - a.x, hy - a.y) < tol || Math.hypot(hx - b.x, hy - b.y) < tol ? null : best;
}

export const PenMixin = {
    _paths() { return (this.doc && this.doc.paths) || []; },
    /** The path the pen works on (shown on the picture, listed first in Properties). */
    curPath() { return this._paths().find((q) => q.id === this.pathId) || null; },

    _penReset() { this.pathId = null; this.pathPt = null; this._penOpen = false; },

    selectPath(id) {
        this.pathId = id && this._paths().some((q) => q.id === id) ? id : null;
        this.pathPt = null;
        this._penOpen = false;
        this.drawOverlay();
        this.refreshProps();
    },

    /** A new, empty path (it is kept from its first anchor). */
    _penNewPath() {
        if (!this.doc.paths) this.doc.paths = [];
        const names = new Set(this._paths().map((q) => q.name));
        let n = this._paths().length + 1;
        while (names.has(`Path ${n}`)) n++;
        const P = { id: D.newId(), name: `Path ${n}`, closed: false, pts: [] };
        this.doc.paths.push(P);
        this.pathId = P.id;
        return P;
    },

    _penTol() { return HIT_PX / this.view.zoom; },

    /** The press of the pen. Plain: an anchor (drag: a smooth one); on the first anchor: close; on a segment: a new anchor;
     *  on an anchor of a path not being drawn: take it away. Ctrl: move an anchor or handle. Alt: corner <-> smooth, or one handle alone. */
    _penDown(p, e) {
        this._tfSettle();
        const tol = this._penTol(), ctrl = e.ctrlKey || e.metaKey;
        let P = this.curPath();
        if (P && !P.pts.length) P = null;
        // Another path's anchor under the pointer (not while drawing): that path becomes the one.
        if (!this._penOpen && (!P || !D.pathHit(P, p.x, p.y, tol, true))) {
            const other = this._paths().find((q) => q !== P && D.pathHit(q, p.x, p.y, tol, false));
            if (other && (ctrl || e.altKey)) { this.pathId = other.id; P = other; this.refreshProps(); }
        }
        const hit = P ? D.pathHit(P, p.x, p.y, tol, true) : null;
        if (ctrl) {
            if (!hit) { this.pathPt = null; this._penOpen = false; this.drawOverlay(); return; }
            this.liveBegin();
            if (hit.part === "a") this.pathPt = hit.i;
            const a = P.pts[hit.i], hx = hit.part === "a" ? a.x : hit.part === "in" ? a.ix : a.ox, hy = hit.part === "a" ? a.y : hit.part === "in" ? a.iy : a.oy;
            // Moved by how far the pointer goes, so a grab off its centre does not make it jump.
            this._drag = { kind: "pen", P, i: hit.i, part: hit.part, free: e.altKey, label: hit.part === "a" ? "Move anchor" : "Move handle",
                           grab: { dx: hx - p.x, dy: hy - p.y } };
            this.drawOverlay();
            return;
        }
        if (e.altKey && hit) {
            this.liveBegin();
            const a = P.pts[hit.i];
            if (hit.part !== "a") { this._drag = { kind: "pen", P, i: hit.i, part: hit.part, free: true, label: "Move handle" }; return; }
            this.pathPt = hit.i;
            if (a.ix !== a.x || a.iy !== a.y || a.ox !== a.x || a.oy !== a.y) {
                P.pts[hit.i] = { ...a, ix: a.x, iy: a.y, ox: a.x, oy: a.y, smooth: false };
                this.liveEnd("Corner anchor");
                return;
            }
            this._drag = { kind: "pen", P, i: hit.i, part: "out", mirror: true, label: "Smooth anchor" };
            return;
        }
        if (this._penOpen && P && !P.closed) {
            if (hit && hit.part === "a" && hit.i === 0 && P.pts.length > 2) {
                this.liveBegin();
                P.closed = true;
                this._penOpen = false;
                this.pathPt = 0;
                this._drag = { kind: "pen", P, i: 0, part: "out", mirror: true, label: "Close path", still: true, p0: p };
                return;
            }
            this.liveBegin();
            P.pts.push({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y, smooth: false });
            this.pathPt = P.pts.length - 1;
            this._drag = { kind: "pen", P, i: this.pathPt, part: "out", mirror: true, label: "Add anchor", still: true, p0: p };
            this.drawOverlay();
            return;
        }
        if (P && hit && hit.part === "a") {
            // An end of an open path: go on drawing from it. Any other anchor: taken away.
            if (!P.closed && (hit.i === P.pts.length - 1 || hit.i === 0)) {
                if (hit.i === 0 && P.pts.length > 1) {
                    this.liveBegin();
                    P.pts = P.pts.slice().reverse().map((a) => ({ ...a, ix: a.ox, iy: a.oy, ox: a.ix, oy: a.iy }));
                    this.liveEnd("Reverse path");
                }
                this._penOpen = true;
                this.pathPt = P.pts.length - 1;
                this.drawOverlay();
                return;
            }
            this.deleteAnchor(hit.i);
            return;
        }
        if (P) {
            const sh = segmentHit(P, p.x, p.y, tol);
            if (sh) {
                this.liveBegin();
                const j = (sh.i + 1) % P.pts.length;
                const [a, m, b] = splitSegment(P.pts[sh.i], P.pts[j], sh.t);
                const pts = P.pts.slice();
                pts[sh.i] = a; pts[j] = b;
                pts.splice(sh.i + 1, 0, m);
                P.pts = pts;
                this.pathPt = sh.i + 1;
                this._drag = { kind: "pen", P, i: sh.i + 1, part: "a", label: "Add anchor" };
                this.drawOverlay();
                return;
            }
        }
        // A new path from here.
        this.liveBegin();
        P = this._penNewPath();
        P.pts.push({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y, smooth: false });
        this.pathPt = 0;
        this._penOpen = true;
        this._drag = { kind: "pen", P, i: 0, part: "out", mirror: true, label: "New path", still: true, p0: p };
        this.refreshProps();
        this.drawOverlay();
    },

    _penMove(dr, p, e) {
        const P = dr.P, a = P.pts[dr.i];
        if (!a) return;
        if (dr.still && Math.hypot(p.x - dr.p0.x, p.y - dr.p0.y) * this.view.zoom < 2) return;
        dr.still = false;
        let x = p.x + (dr.grab ? dr.grab.dx : 0), y = p.y + (dr.grab ? dr.grab.dy : 0);
        if (e.shiftKey && dr.part !== "a") {
            // Handles at 45° steps.
            const ang = Math.round(Math.atan2(y - a.y, x - a.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(x - a.x, y - a.y);
            x = a.x + Math.cos(ang) * len; y = a.y + Math.sin(ang) * len;
        }
        if (dr.mirror) P.pts[dr.i] = { ...a, ox: x, oy: y, ix: 2 * a.x - x, iy: 2 * a.y - y, smooth: true };
        else P.pts[dr.i] = D.movePathPoint(a, dr.part, x, y, dr.free || e.altKey);
        this.drawOverlay();
    },

    _penUp(dr) { this.liveEnd(dr.label); this.refreshProps(); },

    deleteAnchor(i) {
        const P = this.curPath();
        if (!P || !P.pts[i]) return false;
        return this.change("Delete anchor", () => {
            P.pts = P.pts.filter((_, k) => k !== i);
            if (P.pts.length < 3) P.closed = false;
            if (!P.pts.length) { this.doc.paths = this._paths().filter((q) => q !== P); this._penReset(); }
            else this.pathPt = null;
            if (this.doc.paths && !this.doc.paths.length) delete this.doc.paths;
        });
    },

    deletePath(id = this.pathId) {
        if (!this._paths().some((q) => q.id === id)) return false;
        return this.change("Delete path", () => {
            this.doc.paths = this._paths().filter((q) => q.id !== id);
            if (!this.doc.paths.length) delete this.doc.paths;
            if (this.pathId === id) this._penReset();
        });
    },

    renamePath(id, name) {
        const P = this._paths().find((q) => q.id === id);
        name = String(name || "").trim().slice(0, 120);
        if (!P || !name || name === P.name) return false;
        return this.change("Rename path", () => { P.name = name; });
    },

    /** Stop drawing the path (Enter, Esc): it stays, open. */
    penFinish() { this._penOpen = false; this.pathPt = null; this.drawOverlay(); this.refreshProps(); },

    _needPath(what) {
        const P = this.curPath();
        if (!P || !P.pts.length) { this._notify(`${what}: draw a path with the pen (P) first, or pick one in Properties.`, "info"); return null; }
        return P;
    },

    /** The inside of the path as the selection (`how`: replace, add, subtract, intersect; feathered by the pen's feather). */
    pathToSelection(how = "replace") {
        const P = this._needPath("Make selection");
        if (!P) return false;
        if (P.pts.length < 3) { this._notify("A path needs three anchors to hold a selection.", "info"); return false; }
        let m = D.combineMasks(how === "replace" ? null : this.sel, D.pathMask(this.doc.w, this.doc.h, P), how);
        const f = this.opts.pen.feather;
        if (f > 0) m = D.feather(m, this.doc.w, this.doc.h, f);
        this._penOpen = false;
        this.setSelection(m, "Selection from path");
        return true;
    },

    /** The colour into the inside of the path ("fill") or along it ("stroke"), on the active layer or its mask. */
    paintPath(kind, color = this.fg) {
        const P = this._needPath(kind === "fill" ? "Fill path" : "Stroke path");
        if (!P) return false;
        const W = this.doc.w, H = this.doc.h;
        const area = kind === "fill" ? D.pathMask(W, H, P) : D.strokeMask(W, H, D.flattenPath(P), P.closed, this.opts.pen.width);
        const label = kind === "fill" ? "Fill path" : "Stroke path";
        if (this._maskUp()) {
            const lum = Math.round(0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]);
            return this._fillMaskArea(area, lum, label);
        }
        const L = this._pixelTarget(label);
        if (!L) return false;
        return this.change(label, () => {
            const px = this._growToCanvas(L);
            this.pix.set(L.id, D.fillOver(px, L.w, L.h, [...color, 255], D.maskForLayer(area, W, H, L), 255));
        });
    },

    /** The active layer's mask made from the path (the inside shows). */
    maskFromPath() {
        const P = this._needPath("Mask from path");
        if (!P) return false;
        const L = this.active();
        if (!L) return false;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return false; }
        return this.change("Mask from path", () => {
            const W = this.doc.w, H = this.doc.h;
            L.mask = { ...(L.mask || {}), enabled: true, x: 0, y: 0, w: W, h: H, fill: 0 };
            this.masks.set(L.id, D.pathMask(W, H, P));
        });
    },

    /** The keys the pen takes; true when it took one. */
    _penKey(e, take) {
        if (this.tool !== "pen") return false;
        const k = e.key, ctrl = e.ctrlKey || e.metaKey;
        if (k === "Enter" && ctrl) return take(() => this.pathToSelection(e.shiftKey ? "add" : e.altKey ? "subtract" : "replace"));
        if (k === "Enter" && this._penOpen) return take(() => this.penFinish());
        if (k === "Escape" && (this._penOpen || this.pathId)) return take(() => (this._penOpen ? this.penFinish() : this.selectPath(null)));
        if ((k === "Delete" || k === "Backspace") && !e.altKey && this.curPath() && !this._layersFocus) {
            return take(() => (this.pathPt != null ? this.deleteAnchor(this.pathPt) : this.deletePath()));
        }
        return false;
    },

    /** The path on the picture: its curve, anchors (the picked one filled), the handles near the picked one. */
    _penDraw(c, X, Y) {
        const P = this.curPath();
        if (!P || !P.pts.length) return;
        const pts = P.pts, segs = P.closed ? pts.length : pts.length - 1;
        c.beginPath();
        c.moveTo(X(pts[0].x), Y(pts[0].y));
        for (let i = 0; i < segs; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            c.bezierCurveTo(X(a.ox), Y(a.oy), X(b.ix), Y(b.iy), X(b.x), Y(b.y));
        }
        // While drawing: the next segment, to the pointer.
        const h = this._hover, last = pts[pts.length - 1];
        if (this._penOpen && h && !this._drag && this.tool === "pen") c.bezierCurveTo(X(last.ox), Y(last.oy), X(h.x), Y(h.y), X(h.x), Y(h.y));
        c.lineWidth = 3; c.strokeStyle = "rgba(0,0,0,.6)"; c.stroke();
        c.lineWidth = 1.25; c.strokeStyle = "#4fd6ee"; c.stroke();
        if (this.tool !== "pen") return;
        const near = new Set();
        const sel = this.pathPt != null ? this.pathPt : (this._penOpen ? pts.length - 1 : null);
        if (sel != null) for (const d of [-1, 0, 1]) near.add((sel + d + pts.length) % pts.length);
        c.lineWidth = 1;
        for (const i of near) {
            const a = pts[i];
            if (!a) continue;
            for (const [hx, hy] of [[a.ix, a.iy], [a.ox, a.oy]]) {
                if (hx === a.x && hy === a.y) continue;
                c.strokeStyle = "#4fd6ee";
                c.beginPath(); c.moveTo(X(a.x), Y(a.y)); c.lineTo(X(hx), Y(hy)); c.stroke();
                c.fillStyle = "#4fd6ee";
                c.beginPath(); c.arc(X(hx), Y(hy), 3, 0, Math.PI * 2); c.fill();
            }
        }
        pts.forEach((a, i) => {
            const x = Math.round(X(a.x)) - 3.5, y = Math.round(Y(a.y)) - 3.5;
            c.fillStyle = i === sel ? "#4fd6ee" : "#fff";
            c.strokeStyle = "#0a3640";
            c.fillRect(x, y, 7, 7); c.strokeRect(x, y, 7, 7);
        });
    },

    /** The pen's part of Properties (and of the options bar). */
    _penOptions(ts, bar, sync, note) {
        const o = this.opts.pen;
        const paths = this._paths();
        if (!bar) {
            const pick = this.el("select", "paint-pathpick");
            pick.append(this.el("option", "", { value: "", text: paths.length ? "(no path picked)" : "(no paths yet)" }));
            for (const q of paths) pick.append(this.el("option", "", { value: q.id, text: `${q.name} (${q.pts.length}${q.closed ? ", closed" : ""})` }));
            pick.value = this.pathId || "";
            pick.addEventListener("change", () => this.selectPath(pick.value || null));
            this._field(ts, "Path", pick);
            const P = this.curPath();
            if (P) {
                const nm = this.el("input", "paint-pathname", { type: "text", value: P.name });
                nm.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") nm.blur(); });
                nm.addEventListener("change", () => this.renamePath(P.id, nm.value));
                this._field(ts, "Name", nm);
            }
        }
        const how = this.el("select", "paint-pathhow");
        for (const [v, t] of [["replace", "New selection"], ["add", "Add to selection"], ["subtract", "Take from selection"], ["intersect", "Keep what both hold"]]) {
            how.append(this.el("option", "", { value: v, text: t }));
        }
        how.value = o.combine;
        how.addEventListener("change", () => { o.combine = how.value; sync(); });
        this._field(ts, bar ? "" : "Selection", how);
        this._slider(ts, "Feather", o.feather, 0, 200, 0.5, (v) => { o.feather = v; sync(); });
        this._slider(ts, "Stroke", o.width, 0.5, 500, 0.5, (v) => { o.width = v; sync(); });
        const row = this.el("div", "paint-field wrap");
        const b = (text, title, run, cls = "") => {
            const x = this.el("button", "paint-btn " + cls, { type: "button", text, title });
            x.addEventListener("click", run);
            row.append(x);
        };
        b("Selection", "The inside of the path as the selection (Ctrl+Enter)", () => this.pathToSelection(o.combine), "pen-sel");
        b("Fill", "Fill the inside of the path with the colour", () => this.paintPath("fill"), "pen-fill");
        b("Stroke", "Paint along the path with the colour, the stroke's width wide", () => this.paintPath("stroke"), "pen-stroke");
        b("Mask", "The active layer's mask from the path: the inside shows", () => this.maskFromPath(), "pen-mask");
        if (!bar) b("Delete", "Delete the path", () => this.deletePath(), "pen-del");
        ts.append(row);
        note("Click: a corner. Drag: a smooth anchor. Click the first anchor to close, Enter to stop. "
             + "Click the path to add an anchor, an anchor to take it away. Ctrl+drag moves an anchor or handle, Alt+click turns an anchor corner / smooth, Alt+drag moves one handle alone.");
    },
};
