// imageViewer_paintPathTools.js
// Paint's tools for changing paths, beside the pen in one place of the toolbar (a right-click on the pen's
// button opens them as a row of icons): Path selection (A: the whole path - pick, move, Alt+drag a copy,
// arrows, Del), Direct selection (Shift+A: anchors and handles - pick, Shift+click more, drag a box round
// them, move them together, arrows, Del), Add anchor, Delete anchor and Convert point (corner <-> smooth).
// The pen keeps its own Ctrl / Alt ways of doing the same. A flat object of methods put onto the editor's
// prototype (PathToolsMixin); the pure parts are exported for the tests.
//
// Written from how such tools behave (a click picks, a drag moves, a box picks what it holds), not from
// any other program's code.

import * as D from "./imageViewer_paintData.js";
import { segmentHit, splitSegment } from "./imageViewer_paintPen.js";
import { paintIcon } from "./imageViewer_paintIcons.js";

/** The tools that work on paths (the pen first); every one shows the paths and takes the pen's Properties. */
export const PATH_TOOLS = ["pen", "penadd", "pendel", "penconv", "pathsel", "pathdirect"];
/** The shapes, each its own entry of the shape tool's place ("shape:<kind>": the shape tool with that shape). */
export const SHAPE_TOOLS = ["shape:rect", "shape:rounded", "shape:ellipse", "shape:polygon", "shape:line"];
/**
 * Tools that share one place in the toolbar: the group's name -> its tools, in the flyout's order. The place
 * shows the one used last; a right-click opens them all (Sebastian 2026-11-08: the same for the selections,
 * the brushes and the shapes as for the pen).
 */
export const TOOL_GROUPS = {
    select: ["marquee", "ellipse", "lasso"],
    paint: ["brush", "spot", "heal", "patch"],
    pen: PATH_TOOLS,
    shape: SHAPE_TOOLS,
};
/** What a right-click on the group's place offers, for its tooltip. */
export const GROUP_HINTS = { select: "the other selection tools", paint: "the healing brushes", pen: "the other path tools", shape: "the other shapes" };
/** The group a tool is in, or null ("shape" is the shape tool, whichever shape it draws). */
export const toolGroup = (t) => (t === "shape" ? "shape" : Object.keys(TOOL_GROUPS).find((g) => TOOL_GROUPS[g].includes(t)) || null);

/** The anchors of `path` inside the box (any two corners), as indices. */
export function anchorsInBox(path, x0, y0, x1, y1) {
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    const out = [];
    path.pts.forEach((a, i) => { if (a.x >= lx && a.x <= hx && a.y >= ly && a.y <= hy) out.push(i); });
    return out;
}

/** The anchors `idx` (all when null) moved by dx, dy with their handles: a new list of points. */
export function moveAnchors(pts, idx, dx, dy) {
    const pick = idx == null ? null : new Set(idx);
    return pts.map((a, i) => (pick && !pick.has(i) ? a : { ...a, x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy }));
}

/** The anchors `idx` taken away; a path with fewer than three anchors cannot stay closed. */
export function removeAnchors(path, idx) {
    const drop = new Set(idx);
    const pts = path.pts.filter((_, i) => !drop.has(i));
    return { ...path, pts, closed: path.closed && pts.length >= 3 };
}

export const PathToolsMixin = {
    /** The anchors picked on the path being worked on (Direct selection), as a Set of indices. */
    _pathPicked() {
        const s = this._pathPts;
        if (!s || s.id !== this.pathId) return new Set(this.pathPt != null ? [this.pathPt] : []);
        return s.set;
    },
    _setPathPicked(idx) {
        const set = new Set(idx);
        this._pathPts = { id: this.pathId, set };
        this.pathPt = set.size ? [...set][set.size - 1] : null;
    },

    /** The path under the pointer - an anchor of it, or its curve; the one being worked on first. */
    _pathUnder(p, tol) {
        const cur = this.curPath(), all = this._paths().filter((q) => q.pts.length);
        const order = cur && cur.pts.length ? [cur, ...all.filter((q) => q !== cur)] : all;
        for (const q of order) if (D.pathHit(q, p.x, p.y, tol, false)) return q;
        for (const q of order) if (segmentHit(q, p.x, p.y, tol)) return q;
        return null;
    },

    _pickPath(P) {
        if (this.pathId !== (P && P.id)) { this.pathId = P ? P.id : null; this.pathPt = null; this._pathPts = null; this.refreshProps(); }
        this._penOpen = false;
    },

    /** The press of a path tool other than the pen. */
    _pathToolDown(p, e) {
        this._tfSettle();
        const t = this.tool, tol = this._penTol();
        this._penOpen = false;
        if (t === "pathsel") return this._pathSelDown(p, e, tol);
        if (t === "pathdirect") return this._pathDirectDown(p, e, tol);
        const cur = this.curPath();
        // A handle of the path being worked on (Convert point moves one handle alone).
        const hh = cur && cur.pts.length ? D.pathHit(cur, p.x, p.y, tol, true) : null;
        const P = hh ? cur : this._pathUnder(p, tol);
        this._pickPath(P);
        if (!P) { this.drawOverlay(); return; }
        const hit = hh || D.pathHit(P, p.x, p.y, tol, false);
        if (t === "pendel") {
            if (hit && hit.part === "a") this.deleteAnchor(hit.i);
            else this.drawOverlay();
            return;
        }
        if (t === "penconv") {
            if (!hit) { this.drawOverlay(); return; }
            this.liveBegin();
            const a = P.pts[hit.i];
            if (hit.part !== "a") { this._drag = { kind: "pen", P, i: hit.i, part: hit.part, free: true, label: "Move handle" }; return; }
            this.pathPt = hit.i;
            this._setPathPicked([hit.i]);
            if (a.ix !== a.x || a.iy !== a.y || a.ox !== a.x || a.oy !== a.y) {
                P.pts[hit.i] = { ...a, ix: a.x, iy: a.y, ox: a.x, oy: a.y, smooth: false };
                this.liveEnd("Corner anchor");
                this.drawOverlay();
                return;
            }
            this._drag = { kind: "pen", P, i: hit.i, part: "out", mirror: true, label: "Smooth anchor" };
            return;
        }
        // Add anchor: on the curve, a new anchor there (dragged on from the press); on an anchor, that anchor is picked.
        if (hit && hit.part === "a") { this._setPathPicked([hit.i]); this.drawOverlay(); return; }
        const sh = segmentHit(P, p.x, p.y, tol);
        if (!sh) { this.drawOverlay(); return; }
        this.liveBegin();
        const j = (sh.i + 1) % P.pts.length;
        const [a, m, b] = splitSegment(P.pts[sh.i], P.pts[j], sh.t);
        const pts = P.pts.slice();
        pts[sh.i] = a; pts[j] = b;
        pts.splice(sh.i + 1, 0, m);
        P.pts = pts;
        this._setPathPicked([sh.i + 1]);
        this._drag = { kind: "pen", P, i: sh.i + 1, part: "a", label: "Add anchor" };
        this.drawOverlay();
    },

    /** Path selection: the path under the pointer is picked and dragged whole (Alt: a copy of it). */
    _pathSelDown(p, e, tol) {
        let P = this._pathUnder(p, tol);
        if (!P) { this._pickPath(null); this.drawOverlay(); return; }
        this.liveBegin();
        if (e.altKey) {
            const names = new Set(this._paths().map((q) => q.name));
            let name = `${P.name} copy`, n = 2;
            while (names.has(name)) name = `${P.name} copy ${n++}`;
            const C = { ...P, id: D.newId(), name, pts: P.pts.map((a) => ({ ...a })) };
            this.doc.paths.push(C);
            P = C;
        }
        this._pickPath(P);
        this._setPathPicked([]);
        this._drag = { kind: "pathmove", P, idx: null, pts0: P.pts, p0: { x: p.x, y: p.y }, label: e.altKey ? "Duplicate path" : "Move path" };
        this.refreshProps();
        this.drawOverlay();
    },

    /** Direct selection: a handle is dragged; an anchor is picked (Shift: one more / one less) and the picked ones dragged together;
     *  the curve picks its path and drags the anchors at its two ends; nothing: a box that picks the anchors inside it. */
    _pathDirectDown(p, e, tol) {
        const cur = this.curPath();
        const picked = this._pathPicked();
        if (cur && cur.pts.length) {
            const hh = D.pathHit(cur, p.x, p.y, tol, true);
            if (hh && hh.part !== "a") {
                this.liveBegin();
                const a = cur.pts[hh.i], hx = hh.part === "in" ? a.ix : a.ox, hy = hh.part === "in" ? a.iy : a.oy;
                this._drag = { kind: "pen", P: cur, i: hh.i, part: hh.part, free: e.altKey, label: "Move handle", grab: { dx: hx - p.x, dy: hy - p.y } };
                return;
            }
        }
        const P = this._pathUnder(p, tol);
        if (!P) {
            this._drag = { kind: "pathbox", x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey };
            this.drawOverlay();
            return;
        }
        const same = P === cur;
        this._pickPath(P);
        const hit = D.pathHit(P, p.x, p.y, tol, false);
        let idx;
        if (hit) {
            const set = same ? new Set(picked) : new Set();
            if (e.shiftKey) { if (set.has(hit.i)) set.delete(hit.i); else set.add(hit.i); }
            else if (!set.has(hit.i)) { set.clear(); set.add(hit.i); }
            this._setPathPicked([...set]);
            if (!set.has(hit.i)) { this.drawOverlay(); return; }
            idx = [...set];
        } else {
            const sh = segmentHit(P, p.x, p.y, tol);
            idx = sh ? [sh.i, (sh.i + 1) % P.pts.length] : [];
            this._setPathPicked(e.shiftKey && same ? [...picked, ...idx] : idx);
            idx = [...this._pathPicked()];
        }
        this.liveBegin();
        this._drag = { kind: "pathmove", P, idx, pts0: P.pts, p0: { x: p.x, y: p.y }, label: idx.length > 1 ? "Move anchors" : "Move anchor" };
        this.refreshProps();
        this.drawOverlay();
    },

    _pathToolMove(dr, p, e) {
        if (dr.kind === "pathbox") { dr.x1 = p.x; dr.y1 = p.y; this.drawOverlay(); return; }
        let dx = p.x - dr.p0.x, dy = p.y - dr.p0.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        dr.P.pts = moveAnchors(dr.pts0, dr.idx, dx, dy);
        dr.moved = dr.moved || Math.hypot(dx, dy) * this.view.zoom >= 1;
        this.drawOverlay();
    },

    _pathToolUp(dr) {
        if (dr.kind === "pathbox") {
            const small = Math.hypot(dr.x1 - dr.x0, dr.y1 - dr.y0) * this.view.zoom < 3;
            if (small) { if (!dr.add) this._pickPath(null); this.drawOverlay(); return; }
            // The anchors of the path worked on, else of the first path with anchors in the box.
            const cur = this.curPath();
            let P = cur && anchorsInBox(cur, dr.x0, dr.y0, dr.x1, dr.y1).length ? cur : null;
            if (!P && !(dr.add && cur)) P = this._paths().find((q) => anchorsInBox(q, dr.x0, dr.y0, dr.x1, dr.y1).length) || null;
            if (!P) { if (!dr.add) this._pickPath(null); this.drawOverlay(); return; }
            const got = anchorsInBox(P, dr.x0, dr.y0, dr.x1, dr.y1);
            const keep = dr.add && P === cur ? [...this._pathPicked()] : [];
            this._pickPath(P);
            this._setPathPicked([...new Set([...keep, ...got])]);
            this.refreshProps();
            this.drawOverlay();
            return;
        }
        if (!dr.moved && !dr.label.startsWith("Duplicate")) dr.P.pts = dr.pts0;
        this.liveEnd(dr.label);
        this.refreshProps();
        this.drawOverlay();
    },

    /** The picked anchors (Direct selection) or the whole path (Path selection) moved by dx, dy: one step. */
    nudgePath(dx, dy) {
        const P = this.curPath();
        if (!P || !P.pts.length) return false;
        const idx = this.tool === "pathsel" ? null : [...this._pathPicked()];
        if (idx && !idx.length) return false;
        return this.change(idx ? "Nudge anchors" : "Nudge path", () => { P.pts = moveAnchors(P.pts, idx, dx, dy); });
    },

    /** The picked anchors taken away (Direct selection): one step; the path goes when none is left. */
    deletePickedAnchors() {
        const P = this.curPath(), idx = [...this._pathPicked()];
        if (!P || !idx.length) return false;
        if (idx.length === 1) return this.deleteAnchor(idx[0]);
        return this.change("Delete anchors", () => {
            const Q = removeAnchors(P, idx);
            P.pts = Q.pts; P.closed = Q.closed;
            if (!P.pts.length) { this.doc.paths = this._paths().filter((q) => q !== P); this._penReset(); }
            if (this.doc.paths && !this.doc.paths.length) delete this.doc.paths;
            this._setPathPicked([]);
        });
    },

    /** Keys of the path tools other than the pen's own: arrows nudge, Del deletes, Esc lets go. */
    _pathToolKey(e, take) {
        const t = this.tool;
        if (t !== "pathsel" && t !== "pathdirect") return false;
        const k = e.key;
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (k.startsWith("Arrow") && this.curPath()) {
            const s = e.shiftKey ? 10 : 1;
            return take(() => this.nudgePath(k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0, k === "ArrowUp" ? -s : k === "ArrowDown" ? s : 0));
        }
        if ((k === "Delete" || k === "Backspace") && this.curPath() && !this._layersFocus) {
            return take(() => (t === "pathdirect" && this._pathPicked().size ? this.deletePickedAnchors() : this.deletePath()));
        }
        if (k === "Escape" && this.pathId) {
            return take(() => { if (t === "pathdirect" && this._pathPicked().size) { this._setPathPicked([]); this.drawOverlay(); } else this.selectPath(null); });
        }
        return false;
    },

    /** The box being dragged by Direct selection. */
    _pathBoxDraw(c, X, Y) {
        const dr = this._drag;
        if (!dr || dr.kind !== "pathbox") return;
        c.strokeStyle = "#4fd6ee"; c.lineWidth = 1; c.setLineDash([4, 3]);
        c.strokeRect(Math.round(X(Math.min(dr.x0, dr.x1))) + 0.5, Math.round(Y(Math.min(dr.y0, dr.y1))) + 0.5,
                     Math.abs(dr.x1 - dr.x0) * this.view.zoom, Math.abs(dr.y1 - dr.y0) * this.view.zoom);
        c.setLineDash([]);
    },

    // ── the toolbar's shared places ─────────────────────────────────────────

    /** The button that stands for a group of tools: it shows the one used last; a right-click opens all of them. */
    _groupSlot(group, labels) {
        const first = TOOL_GROUPS[group][0];
        const b = this.btn(labels[first].icon, labels[first].title, () => this.setTool(b.dataset.tool));
        b.classList.add("paint-grouped");
        b.dataset.tool = first;
        b.dataset.group = group;
        b.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this._toolFlyout(group, b); });
        if (!this._groupLabels) this._groupLabels = {};
        this._groupLabels[group] = labels;
        return b;
    },

    /** The entry of a group that stands for tool `t` now: the shape tool is the entry of the shape it draws. */
    _groupEntry(t) { return t === "shape" ? `shape:${this.opts.shape.kind}` : t; },

    /** The group's slot shows tool `t` (its icon and title). */
    _groupShow(t) {
        const g = toolGroup(t), b = g && this.toolBtns[t];
        t = this._groupEntry(t);
        if (!b || b.dataset.tool === t) return;
        const L = this._groupLabels[g][t];
        if (!L) return;
        b.dataset.tool = t;
        b.title = `${L.title} - right-click: ${GROUP_HINTS[g] || "the others"}`;
        b.replaceChildren(paintIcon(this.d, L.icon));
    },

    /** The row of the group's tools beside its button; a click picks one. */
    _toolFlyout(group, anchor) {
        this._closeFlyout();
        const fly = this.el("div", "paint-flyout");
        fly.dataset.group = group;
        for (const t of TOOL_GROUPS[group]) {
            const L = this._groupLabels[group][t];
            const b = this.btn(L.icon, L.title, () => { this._closeFlyout(); this.setTool(t); });
            b.dataset.tool = t;
            if (t === this._groupEntry(this.tool)) b.classList.add("on");
            fly.append(b);
        }
        for (const ev of ["pointerdown", "mousedown", "contextmenu"]) fly.addEventListener(ev, (e) => { e.stopPropagation(); if (ev === "contextmenu") e.preventDefault(); });
        this.box.append(fly);
        const r = anchor.getBoundingClientRect(), br = this.box.getBoundingClientRect();
        fly.style.left = `${r.right - br.left + 2}px`;
        fly.style.top = `${r.top - br.top}px`;
        this._flyout = fly;
        // Anywhere else, or Esc, puts it away.
        const away = (e) => { if (!(e.composedPath ? e.composedPath() : []).includes(fly)) this._closeFlyout(); };
        const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); this._closeFlyout(); } };
        // Inside the editor (it may sit in a shadow root, where the window does not see which element was pressed) and outside it.
        const win = this.d.defaultView, box = this.box;
        const outside = (e) => { if (!(e.composedPath ? e.composedPath() : []).includes(box)) this._closeFlyout(); };
        box.addEventListener("pointerdown", away, true);
        win.addEventListener("pointerdown", outside, true);
        win.addEventListener("keydown", esc, true);
        this._flyoutOff = () => { box.removeEventListener("pointerdown", away, true); win.removeEventListener("pointerdown", outside, true); win.removeEventListener("keydown", esc, true); };
        return fly;
    },

    _closeFlyout() {
        if (this._flyoutOff) { this._flyoutOff(); this._flyoutOff = null; }
        if (this._flyout) { this._flyout.remove(); this._flyout = null; }
    },
};
