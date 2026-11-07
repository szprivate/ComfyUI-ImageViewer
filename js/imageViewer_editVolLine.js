// imageViewer_editVolLine.js
// The volume line on a sound clip (Avid Media Composer's / Resolve's rubber
// band): one line across the clip at its level, over its waveform - on the
// clips of the sound tracks and on V1's films with sound. Its points are the
// Inspector's volume keys (fx.keys.vol, clip time) - the same keys, so either
// place changes both, and a point goes on to the next as its key's ease says.
//
//   drag the line          the level: the clip's volume (no points), or every
//                          point by the same dB; the dB is read out while dragging
//   Alt+click the line     a point there, at the line's level (Alt, as Resolve's
//                          Alt-click on its volume line; Alt-drag on a clip's body
//                          still slips - the line is its own element)
//   drag a point           in time (onto frames, and the playhead within the
//                          snapping distance) and in level
//   click a point, Del     takes it away (so does Alt+click on it)
//   right-click a point    its ease (linear / in / out / in-out / hold)
//
// It is drawn on rows at least VOL_ROW_PX tall, on the tracks whose header menu
// (right-click) has "Show volume curve" on - all, until switched off (view.volCurve,
// kept with the cut's view). Several selected: only the clip pressed changes. A
// locked track's row takes no press (imageViewer_editTimeline.js), so its line
// cannot be changed. Fades and crossfades (envGain) multiply with it, in the
// player and the render (timeline_render.volume_curve / gain_line, every 10 ms).
import * as D from "./imageViewer_editTimelineData.js";

const SVG = "http://www.w3.org/2000/svg";
export const VOL_ROW_PX = 28;

export const EditVolLineMixin = {

    /** Is the volume line shown on track `id`? */
    _editTlVolShown(id) {
        const v = this._editTlView;
        return !(v && v.volCurve && v.volCurve[id] === false);
    },

    /** The header menu's switch for track `id`'s volume line. */
    _editTlVolToggle(id) {
        const v = this._editTlView;
        if (!v) return;
        v.volCurve = { ...(v.volCurve || {}) };
        if (this._editTlVolShown(id)) v.volCurve[id] = false; else delete v.volCurve[id];
        this.editTlRefresh();
    },

    /** The line and its points on sound block `b`: `sel` its clip, `length` its seconds, `height` its row's, `row` its track. */
    _editTlVolLine(b, sel, length, height, row) {
        const cut = this._editTlCut;
        const c = cut && D.clipOf(cut, sel);
        if (!c || !(length > 0) || height < VOL_ROW_PX || !this._editTlVolShown(row)) return;
        const doc = b.ownerDocument;
        const pts = D.volLine(c, length);
        const svg = doc.createElementNS(SVG, "svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("class", "edit-volline");
        const xy = pts.map((p) => `${(p.u / length * 100).toFixed(3)},${(D.volY(p.v) * 100).toFixed(3)}`).join(" ");
        for (const cls of ["hit", "line"]) {
            const pl = doc.createElementNS(SVG, "polyline");
            pl.setAttribute("points", xy);
            pl.setAttribute("class", cls);
            svg.append(pl);
        }
        const hit = svg.firstChild;
        hit.addEventListener("pointerdown", (e) => this._editTlVolLineDown(e, b, sel, length));
        hit.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
        b.append(svg);
        b.dataset.vol = String(Math.round(D.paramAt(c, "vol", 0) * 1000) / 1000);
        const chosen = this._editTlVolSel;
        for (const k of D.volPoints(c)) {
            if (k.t > length + 1e-6) continue;
            const p = doc.createElement("div");
            const on = chosen && D.sameSel(chosen.sel, sel) && Math.abs(chosen.t - k.t) < 1e-6;
            p.className = "edit-volpt" + (k.i ? " ease" : "") + (k.i === "hold" ? " hold" : "") + (on ? " sel" : "");
            p.style.left = (k.t / length * 100) + "%";
            p.style.top = (D.volY(k.v) * 100) + "%";
            p.dataset.t = String(k.t);
            p.title = `${D.dbLabel(k.v)} at ${D.lengthLabel(k.t)} of the clip - drag it; Alt+click or Del takes it away; right-click: its ease`;
            p.addEventListener("pointerdown", (e) => this._editTlVolPointDown(e, b, sel, k, length));
            p.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._editTlVolSel = { sel, t: k.t };
                if (this._editKeyInterpMenu) this._editKeyInterpMenu(e, sel, ["vol"], k.t);
            });
            b.append(p);
        }
    },

    // The clip time and the gain under a pointer on block `b`.
    _editTlVolAt(ev, b, length) {
        const r = b.getBoundingClientRect();
        const u = Math.max(0, Math.min(length, (ev.clientX - r.left) / Math.max(1, r.width) * length));
        return { u, v: D.yVol((ev.clientY - r.top) / Math.max(1, r.height)) };
    },

    // A clip time moved onto a frame - and onto the playhead when that is within the snapping distance.
    _editTlVolSnap(sel, u) {
        const cut = this._editTlCut;
        const fps = cut.fps || 24;
        const start = this._editTlPlace ? this._editTlPlace(cut, sel).start : 0;
        let t = D.toFrame(start + u, fps);
        const lay = this._editTlLay, ui = this._editTlUi;
        if (lay && ui && this._editTlOnScreen()) {
            const head = (this.currentFrame || 0) / fps;
            const tol = D.snapSeconds(D.SNAP_PX, lay.total, ui.area.getBoundingClientRect().width);
            if (Math.abs(head - t) <= tol) t = head;
        }
        return Math.round((t - start) * 10000) / 10000;
    },

    _editTlVolLineDown(e, b, sel, length) {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const start = this._editTlCut;
        const at = this._editTlVolAt(e, b, length);
        if (e.altKey) {
            // Alt+click: a point there, at the line's level.
            const u = Math.max(0, Math.min(length, this._editTlVolSnap(sel, at.u)));
            this._editTlVolSel = { sel, t: Math.round(u * 10000) / 10000 };
            this._editTlApply(D.addVolPoint(start, sel, u));
            return;
        }
        this._editTlVolSel = null;
        const c = D.clipOf(start, sel);
        const v0 = D.paramAt(c, "vol", at.u);
        const y0 = e.clientY, r = b.getBoundingClientRect();
        this._editTlDrag(e, b, (_s, ev) => {
            const v = D.yVol(D.volY(v0) + (ev.clientY - y0) / Math.max(1, r.height));
            this._editTlCut = D.setVolLine(start, sel, v, at.u);
            this._editTlNote = "volume " + D.dbLabel(v);
            this.editTlRefresh();
        }, () => this.editTlRefresh());
    },

    _editTlVolPointDown(e, b, sel, k, length) {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const start = this._editTlCut;
        if (e.altKey) {
            this._editTlVolSel = null;
            this._editTlApply(D.removeVolPoint(start, sel, k.t));
            return;
        }
        this._editTlVolSel = { sel, t: k.t };
        const r = b.getBoundingClientRect();
        const y0 = e.clientY;
        this._editTlDrag(e, b, (seconds, ev) => {
            const u = Math.max(0, Math.min(length, this._editTlVolSnap(sel, k.t + seconds)));
            const v = D.yVol(D.volY(k.v) + (ev.clientY - y0) / Math.max(1, r.height));
            this._editTlCut = D.moveVolPoint(start, sel, k.t, u, v);
            const moved = D.volPoints(D.clipOf(this._editTlCut, sel)).find((p) => Math.abs(p.v - Math.round(v * 1e5) / 1e5) < 1e-4 && Math.abs(p.t - u) < 2e-3);
            this._editTlVolSel = { sel, t: moved ? moved.t : u };
            this._editTlNote = `volume ${D.dbLabel(v)} at ${D.timecode(u, start.fps || 24)}`;
            this.editTlRefresh();
        }, () => this.editTlRefresh());
    },

    /** Del with a point of a volume line chosen: it goes (true when there was one). */
    editTlVolDelete() {
        const s = this._editTlVolSel;
        if (!s || !this._editTlCut || !D.clipOf(this._editTlCut, s.sel)) return false;
        this._editTlVolSel = null;
        this._editTlApply(D.removeVolPoint(this._editTlCut, s.sel, s.t));
        return true;
    },
};
