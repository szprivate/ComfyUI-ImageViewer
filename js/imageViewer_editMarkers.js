// imageViewer_editMarkers.js
// Markers in the Edit panel, as Resolve's: a mixin onto the panel
// (imageViewer_editTimeline.js); the arithmetic is the "markers" section of
// imageViewer_editTimelineData.js.
//
//   M              a marker at the playhead: on the selected clip when the
//                  playhead is inside it (a clip marker, which rides with the
//                  picture), else on the timeline; on a frame that has one,
//                  M opens it instead
//   Alt+M          take the markers at the playhead away
//   Shift+Up/Down  the marker before / after
//   a click        on a marker (on the ruler, or the small flag on a clip): the
//                  playhead goes there and the marker is selected (Del takes it
//                  away); a drag moves it, snapping; a double-click opens it -
//                  name, colour, note, duration; right-click: its menu
//
// Timeline markers are drawn on the ruler, a duration marker as a band; clip
// markers as small flags along the top of their clip. Both are snap targets.
import * as D from "./imageViewer_editTimelineData.js";

const COLOR_NAMES = { blue: "Blue", cyan: "Cyan", green: "Green", yellow: "Yellow", orange: "Orange", red: "Red",
                      pink: "Pink", purple: "Purple", magenta: "Magenta", white: "White" };

function label(m) {
    return (m.name || "Marker") + (m.note ? "\n" + m.note : "");
}

export const EditMarkersMixin = {

    /** The selected marker, while it still names one. */
    _editTlMarkerSel() {
        const w = this._editTlMarkSel;
        return w && D.markerOf(this._editTlCut, w) ? w : null;
    },

    // ── keys ─────────────────────────────────────────────────────────────────

    /** M: a marker at the playhead (on the selected clip when it is under the playhead) - or the one there, opened. */
    editTlMarkerAdd() {
        const cut = this._editTlCut;
        if (!cut) return;
        const fps = cut.fps || 24;
        const t = (this.currentFrame || 0) / fps;
        const sel = this._editTlSel && D.isClipSel(this._editTlSel) ? this._editTlSel : null;
        const got = D.addMarker(cut, t, { sel });
        if (!got.made) { this._editTlMarkSel = got.which; this.editTlRefresh(); this.editTlMarkerDialog(got.which); return; }
        this._editTlApply(got.cut);
        this._editTlMarkSel = got.which;
        this.editTlRefresh();
        this._editTlSay(`${got.which.kind === "cmarker" ? "clip" : "timeline"} marker at ${D.timecode(D.toFrame(t, fps), fps)} - M again (or a double-click) names it`);
    },

    /** Alt+M: the markers at the playhead taken away (one step). */
    editTlMarkerDeleteHere() {
        const cut = this._editTlCut;
        if (!cut) return;
        const fps = cut.fps || 24;
        const here = D.markersAt(cut, (this.currentFrame || 0) / fps, fps);
        if (!here.length) { this._editTlSay("no marker at the playhead"); return; }
        this._editTlMarkSel = null;
        this._editTlApply(D.removeMarkers(cut, here.map((m) => m.which)));
    },

    /** Del with a marker selected: that marker goes. True when it did. */
    editTlMarkerDeleteSelected() {
        const w = this._editTlMarkerSel();
        if (!w) return false;
        this._editTlMarkSel = null;
        this._editTlApply(D.removeMarkers(this._editTlCut, [w]));
        return true;
    },

    /** Shift+Up / Shift+Down: the playhead to the marker before / after. */
    editTlMarkerStep(dir) {
        const cut = this._editTlCut;
        if (!cut) return;
        const fps = cut.fps || 24;
        const m = D.nextMarker(cut, (this.currentFrame || 0) / fps, dir, fps);
        if (!m) { this._editTlSay(dir > 0 ? "no marker after the playhead" : "no marker before the playhead"); return; }
        this._editTlMarkSel = m.which;
        this._editTlSeek(m.t);
        this.editTlRefresh();
        if (m.name) this._editTlSay(`marker: ${m.name}`);
    },

    // ── drawing ──────────────────────────────────────────────────────────────

    /** The timeline's markers on the ruler (called with the in / out marks, on every redraw of the ruler). */
    _editTlMarkersDraw() {
        const ui = this._editTlUi, lay = this._editTlLay, cut = this._editTlCut;
        if (!ui || !ui.ruler || !lay || !cut) return;
        const doc = ui.ruler.ownerDocument;
        if (!ui.markers || !ui.markers.isConnected) {
            ui.markers = doc.createElement("div");
            ui.markers.className = "edit-markers";
            ui.ruler.append(ui.markers);
        }
        const fps = cut.fps || 24;
        const sel = this._editTlMarkerSel();
        const kids = [];
        (cut.markers || []).forEach((m, i) => {
            if (!(lay.total > 0)) return;
            const which = { kind: "marker", i };
            const el = doc.createElement("div");
            el.className = "edit-marker" + (sel && sel.kind === "marker" && sel.i === i ? " sel" : "") + (m.len > 0 ? " span" : "");
            el.style.left = (m.t / lay.total) * 100 + "%";
            if (m.len > 0) el.style.width = (m.len / lay.total) * 100 + "%";
            el.style.setProperty("--mk", D.MARKER_HEX[m.color] || D.MARKER_HEX.blue);
            el.dataset.i = String(i);
            el.title = `${label(m)}\n${D.timecode(m.t, fps)} - drag to move, double-click to edit, right-click for more`;
            this._editTlMarkerBind(el, which);
            kids.push(el);
        });
        ui.markers.replaceChildren(...kids);
    },

    /** The markers of a clip as small flags along its top (block `b`, the clip `c`, its selection `sel`). */
    _editTlClipMarks(b, sel, c) {
        const list = (c && c.markers) || [];
        if (!list.length) return;
        const len = Number(c.length) || 0;
        if (!(len > 0)) return;
        const doc = b.ownerDocument;
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        const picked = this._editTlMarkerSel();
        list.forEach((m, i) => {
            const u = D.clipMarkU(c, m);
            if (u == null) return;
            const which = { kind: "cmarker", sel, i };
            const el = doc.createElement("div");
            const on = picked && picked.kind === "cmarker" && picked.i === i && D.sameSel(picked.sel, sel);
            el.className = "edit-cmarker" + (on ? " sel" : "") + (m.len > 0 ? " span" : "");
            el.style.left = (u / len) * 100 + "%";
            if (m.len > 0) el.style.width = (Math.min(m.len, len - u) / len) * 100 + "%";
            el.style.setProperty("--mk", D.MARKER_HEX[m.color] || D.MARKER_HEX.blue);
            el.dataset.i = String(i);
            el.title = `${label(m)}\nclip marker, ${D.timecode(m.src, fps)} of the source - drag to move, double-click to edit`;
            this._editTlMarkerBind(el, which);
            b.append(el);
        });
    },

    // A marker's element: click selects and seeks, drag moves (snapping, one step), double-click edits, right-click: menu.
    _editTlMarkerBind(el, which) {
        el.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            const start = this._editTlCut;
            const m = D.markerOf(start, which);
            if (!m) return;
            const all = D.allMarkers(start);
            const t0 = (all.find((x) => x.which.kind === which.kind && x.which.i === which.i
                && (which.kind === "marker" || D.sameSel(x.which.sel, which.sel))) || {}).t || 0;
            this._editTlMarkSel = which;
            this._editTlSel = which.kind === "cmarker" ? which.sel : this._editTlSel;
            let now = which;
            this._editTlDrag(e, el, (seconds) => {
                // Snapped (not onto itself: the marker's own moment is left out of the targets).
                const t = this._editTlSnapAt(t0 + seconds, [D.markerId(which)]);
                const got = D.moveMarker(start, which, t);
                now = got.which;
                this._editTlMarkSel = now;
                this._editTlCut = got.cut;
                this.editTlRefresh();
            }, (moved) => {
                if (!moved) this._editTlSeek(t0);
                this._editTlMarkSel = now;
                this.editTlRefresh();
            });
        });
        el.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); this.editTlMarkerDialog(which); });
        el.addEventListener("contextmenu", (e) => this._editTlMarkerMenu(e, which));
    },

    _editTlMarkerMenu(e, which) {
        e.preventDefault();
        e.stopPropagation();
        const m = D.markerOf(this._editTlCut, which);
        if (!m) return;
        this._editTlMarkSel = which;
        this.editTlRefresh();
        const colours = D.MARKER_COLORS.map((c) => ({ label: (c === m.color ? "● " : "") + COLOR_NAMES[c],
                                                     run: () => this._editTlApply(D.editMarker(this._editTlCut, which, { color: c })) }));
        this._previzOpenMenu([
            { label: "Edit marker…", run: () => this.editTlMarkerDialog(which) },
            "-", ...colours, "-",
            { label: "Delete marker", run: () => { this._editTlMarkSel = null; this._editTlApply(D.removeMarkers(this._editTlCut, [which])); } },
            { label: `Delete all ${COLOR_NAMES[m.color]} markers`, run: () => {
                this._editTlMarkSel = null;
                this._editTlApply(D.removeMarkers(this._editTlCut, D.allMarkers(this._editTlCut).filter((x) => x.color === m.color).map((x) => x.which)));
            } },
        ], e.clientX, e.clientY);
    },

    /** A marker's dialog: name, colour, note, duration (frames). One step on OK. */
    editTlMarkerDialog(which) {
        const ui = this._editTlUi, cut = this._editTlCut;
        const m = D.markerOf(cut, which);
        if (!ui || !m) return;
        if (ui.dialog && ui.dialog.isConnected) { ui.dialog.remove(); ui.dialog = null; }
        const doc = ui.body.ownerDocument;
        const fps = cut.fps || 24;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const box = el("div", "edit-dialog edit-markerdlg");
        box.addEventListener("pointerdown", (e) => e.stopPropagation());
        const head = el("div", "edit-dialog-head");
        head.append(el("span", "edit-dialog-title", which.kind === "cmarker" ? "Clip marker" : "Timeline marker"));
        const close = el("button", "edit-btn", "✕");
        close.title = "Close";
        const done = () => { box.remove(); ui.dialog = null; };
        close.addEventListener("click", done);
        head.append(close);
        const t = (D.allMarkers(cut).find((x) => x.which.kind === which.kind && x.which.i === which.i
            && (which.kind === "marker" || D.sameSel(x.which.sel, which.sel))) || {}).t;
        const sub = el("div", "edit-dialog-sub", t == null ? "" : `at ${D.timecode(t, fps)}`
            + (which.kind === "cmarker" ? ` (${D.timecode(m.src, fps)} of the source)` : ""));
        const row = (name, input) => { const r = el("label", "edit-markerrow"); r.append(el("span", "", name), input); return r; };
        const name = el("input", "edit-markerin");
        name.value = m.name || "";
        name.placeholder = "Marker";
        const color = el("select", "edit-markerin");
        for (const c of D.MARKER_COLORS) {
            const o = el("option", "", COLOR_NAMES[c]);
            o.value = c;
            if (c === m.color) o.selected = true;
            color.append(o);
        }
        const dur = el("input", "edit-markerin");
        dur.type = "number";
        dur.min = "0";
        dur.step = "1";
        dur.value = String(Math.round((m.len || 0) * fps));
        dur.title = "Frames: 0 is a marker at a moment, more a duration marker";
        const note = el("textarea", "edit-brief");
        note.value = m.note || "";
        note.placeholder = "Notes";
        const ok = el("button", "edit-btn primary", "OK");
        const apply = () => {
            const frames = Math.max(0, Math.round(Number(dur.value) || 0));
            const next = D.editMarker(this._editTlCut, which, { name: name.value, color: color.value, note: note.value, len: frames / fps });
            done();
            this._editTlApply(next);
        };
        ok.addEventListener("click", apply);
        box.addEventListener("keydown", (e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
            else if (e.key === "Enter" && e.target !== note) { e.preventDefault(); e.stopPropagation(); apply(); }
        });
        box.append(head, sub, row("Name", name), row("Colour", color), row("Duration (frames)", dur), note, ok);
        ui.body.append(box);
        this._editTlCentre(box);
        ui.dialog = box;
        name.focus();
        name.select();
    },
};
