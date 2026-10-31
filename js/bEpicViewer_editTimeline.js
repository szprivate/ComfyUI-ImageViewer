// bEpicViewer_editTimeline.js
// The Edit panel: a cut - shots in an order, each a piece of a file - to make,
// to change and to play.
//
// A cut is an OpenTimelineIO file. One lies beside a film that was edited rather
// than generated (agentY's edit stage writes one, and so can Resolve, Nuke Studio
// or Premiere); one is started here with New, or by adding clips. Every cut that
// is open has a TAB of its own ("edit:…"), and in that tab the viewport plays the
// cut from the clips' own files (bEpicViewer_editPlay.js) - so an edit is seen
// and heard before anything is rendered. The panel (#edit-timeline-panel, dock id
// "editTimeline", the timeline button in the transport) draws it - a ruler, the
// texts, one block per shot with a mark on every dissolve, the sound:
//
//   the buttons, top left   New (an empty cut, in its tab) · Add (files, canvas
//                           nodes, a new track) · Save / Export
//   − + Fit, top right      zoom the timeline; so do Ctrl + wheel (at the pointer), Ctrl+= / Ctrl+- and Shift+Z (fit).
//                           The wheel alone, or the middle button dragged, pans it
//   a track's header        its switch (off: not seen, not heard, not rendered),
//                           S to solo it (only the soloed are played; a way of
//                           looking, not saved), its lower edge to make it taller
//   drag on the ruler       scrub the film; Ctrl+drag / right-click: the in and out
//   click a clip            select it and go to it; right-click: its colour, remove
//   drag a shot's edge      trim it (what follows moves with it); the middle of a
//                           cut rolls it; Alt: slip / retime, Alt+Shift: slide,
//                           Ctrl on the out-edge: loop (bEpicViewer_editTrim.js)
//   drag a shot             put it elsewhere in the order - or onto another track
//   a clip on a higher track  drag it to another moment, its edges to trim it, or
//                           onto another track (onto V1: between the shots there)
//   a dissolve              the bar over the join: drag its edge to make it longer
//                           or shorter, click it for the Inspector
//   drag a text / its edge  move it / make it longer or shorter
//   drop files onto a track from the file browser, the History, the desktop
//                           (copied into input/edits), ComfyUI's queue, or a node
//                           dragged off the canvas: new clips, where they land
//                           (snapped to edit points and the playhead)
//   the blade (B)           a click on a clip cuts it there; Ctrl+B / S cuts at the
//                           playhead; Del lifts, Shift+Del ripple-deletes;
//                           Ctrl+Z / Ctrl+Shift+Z undo and redo (bEpicViewer_editKeys.js)
//   Auto edit…              cut on the beat, an even rhythm, a reference's rhythm,
//                           the best part of each shot - or ask agentY
//                           (bEpicViewer_editAuto.js)
//
// Inside each clip its filmstrip and its waveform (bEpicViewer_editMedia.js),
// read by the server (timeline_media.py) and drawn only where they are seen.
//
// The numbers of what is selected are in the Inspector, and transitions, texts
// and plain colours in Effects (bEpicViewer_editPanels.js) - three panels that
// are up only while a cut's tab is.
//
// Save writes the cut into its .otio (/bepic/timeline); Export renders the film
// of it (/bepic/timeline_render), which lands as a file of its own.
//
// What an edit does to a cut is worked out in bEpicViewer_editTimelineData.js
// (plain functions, run under node); this is the panel side. It is a dock panel
// like the curve editors, and like them it must work popped out into another
// window: elements come from the panel's own document, drags use pointer capture.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import * as D from "./bEpicViewer_editTimelineData.js";
import { nodeMediaClips, selectedNodes } from "./bEpicViewer_sendFromNode.js";
import { canvasContext, notice, openExportDialog, openFilePicker } from "./bEpicViewer_exportUI.js";

const DOCK_ID = "editTimeline";
const EDGE_PX = 7;          // how close to a block's end a press is a trim
const DRAG_SLOP = 4;        // travel before a press on a shot becomes a move
const STILL_SECONDS = 3;
const DRAG_TYPE = "application/x-bepic-history";
const EFFECT_TYPE = "application/x-bepic-effect";      // an item of the Effects panel, dragged
const PREFIX = "edit:";                       // an Edit tab's key (EditPlayMixin.isEditTab)
// The three panels that belong to a cut. They are up only while a cut's tab is.
export const EDIT_PANELS = ["editTimeline", "editInspector", "editEffects"];
const PANELS_STORE = "bepic.viewer.editPanels";
// Tall enough for a filmstrip with the sound under it, and for a waveform.
const ROW_HEIGHT = { text: 16, video: 44, audio: 30 };
const SNAP_PX = 8;          // how near (on screen) a drop or a move snaps to an edit point or the playhead
const SOUND_EXTS = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"];
const FILM_EXTS = [".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"];
const STILL_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"];
const ext = (path) => (/\.[^.\\/]+$/.exec(String(path || "")) || [""])[0].toLowerCase();
const STORE = "bepic.viewer.edits";           // the open cuts, across a reload
const hash = (text) => {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
};

export const EditTimelineMixin = {

    // ── opening ──────────────────────────────────────────────────────────────

    _editTlOpen() { return !!(this.isPanelDocked && this.isPanelDocked(DOCK_ID)); },

    /**
     * "Edit" in the bar's Timeline group. The Edit panels belong to a cut's tab:
     * from any other tab this goes to one - the cut of the film on screen, a cut
     * that is open, or a new one. On a cut's tab it shows or hides the panel.
     */
    async editTlToggle() {
        if (!this.setPanelDocked) return;
        if (this.isEditTab()) { this.editTlPanelToggle(DOCK_ID); return; }
        this._editTlWant(DOCK_ID, true);
        if (this._editTlFilm) { await this.editTlOpenFilmCut(); return; }
        const open = this._editTlTabs()[0];
        if (open) this.switchTab(open); else this.editTlNew();
    },

    /** Show or hide one of the Edit panels (only on a cut's tab), and remember it. */
    editTlPanelToggle(id) {
        if (!this.isEditTab() || !this.setPanelDocked) return;
        const open = !this.isPanelDocked(id);
        this._editTlWant(id, open);
        this.setPanelDocked(id, open);
        this.editTlRefresh();
    },

    // Which of the Edit panels come up with a cut's tab: the ones that were up
    // when the last one was left.
    _editTlWanted() {
        if (this._editTlWantedNow) return this._editTlWantedNow;
        let kept = null;
        try { kept = JSON.parse(window.localStorage.getItem(PANELS_STORE) || "null"); } catch (_) {}
        this._editTlWantedNow = { editTimeline: true, editInspector: true, editEffects: false,
                                  ...((kept && typeof kept === "object") ? kept : {}) };
        return this._editTlWantedNow;
    },

    _editTlWant(id, on) {
        const want = this._editTlWanted();
        want[id] = !!on;
        try { window.localStorage.setItem(PANELS_STORE, JSON.stringify(want)); } catch (_) {}
    },

    // ── the cuts: one to a tab ───────────────────────────────────────────────
    //
    // Every open cut has a tab and a record here, { cut, saved, target, file }.
    // The panel shows ONE of them - the Edit tab that was up last (`_editTlTab`)
    // - and keeps showing it while other tabs are looked at, so that clips can
    // be dragged out of their History into it. Its record is spread over the
    // `_editTl*` fields; the others wait in `_editTlCuts`. They are kept in
    // localStorage, so a reload loses no work.

    _editTlAll() {
        if (this._editTlCuts) return this._editTlCuts;
        let kept = null;
        try { kept = JSON.parse(window.localStorage.getItem(STORE) || "null"); } catch (_) {}
        this._editTlCuts = (kept && typeof kept === "object" && !Array.isArray(kept)) ? kept : {};
        return this._editTlCuts;
    },

    _editTlStash() {
        if (!this._editTlTab) return;
        this._editTlAll()[this._editTlTab] = {
            cut: this._editTlCut, saved: this._editTlSaved || null,
            target: this._editTlTarget || null, file: this._editTlFile || "", otio: this._editTlOtio || "",
            view: this._editTlView || null,
        };
    },

    // Written a moment later, and once: a drag changes the cut on every move.
    _editTlKeep() {
        this._editTlStash();
        if (this._editTlKeepTimer) return;
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        this._editTlKeepTimer = win.setTimeout(() => {
            this._editTlKeepTimer = 0;
            const all = this._editTlAll();
            const out = {};
            for (const key of Object.keys(all)) if (this.allTabs && this.allTabs[key]) out[key] = all[key];
            try { window.localStorage.setItem(STORE, JSON.stringify(out)); } catch (_) {}
        }, 400);
    },

    /** The open Edit tabs, in tab order. */
    _editTlTabs() {
        return (this.tabOrder || []).filter((k) => this.isEditTab(k) && this.allTabs[k]);
    },

    /** Make `key`'s cut the one in the panel. */
    editTlUse(key) {
        if (this._editTlTab === key) return;
        this._editTlStash();
        const s = this._editTlAll()[key] || {};
        const label = String((this.tabLabels && this.tabLabels[key]) || "").replace(/^[^\w]+/, "");
        this._editTlTab = key;
        this._editTlCut = s.cut || D.emptyCut(label || "cut");
        this._editTlSaved = s.saved || null;
        this._editTlTarget = s.target || null;
        this._editTlFile = s.file || "";
        this._editTlOtio = s.otio || "";
        // How this cut is looked at: zoom, the tracks' heights, what is soloed.
        const view = (s.view && typeof s.view === "object") ? s.view : {};
        const range = view.range && Number.isFinite(view.range.start) && Number.isFinite(view.range.end) ? { start: view.range.start, end: view.range.end } : null;
        this._editTlView = { zoom: Math.max(1, Math.min(64, Number(view.zoom) || 1)), heights: { ...(view.heights || {}) },
                             solo: { ...(view.solo || {}) }, textsOff: !!view.textsOff, range };
        this._editTlSel = null;
        this._editTlNote = "";
        this._editTlNow = "";
    },

    /** The tracks that are seen and heard: not switched off, or soloed (liveTracks). */
    _editTlLive() {
        return D.liveTracks(this._editTlCut, (this._editTlView && this._editTlView.solo) || {});
    },

    // A cut gets its tab. `focus`: come up on screen too - not when clips were
    // dropped from another tab, which the user is still picking from.
    _editTlOpenTab(key, name, record, focus) {
        this._editTlStash();
        this._editTlAll()[key] = record;
        if (this._editTlTab === key) this._editTlTab = null;          // read the record again
        if (!this.allTabs[key]) {
            this.allTabs[key] = [];
            this.tabLabels[key] = "\u2702 " + name;
            if (!this.tabOrder.includes(key)) this.tabOrder.push(key);
            this._rebuildTabBar(null);
        }
        this._editTlWant(DOCK_ID, true);
        if (focus && this.editTlAnswerArrived) this.editTlAnswerArrived(key, record);
        if (focus) {
            if (this.requestPanelOpen) this.requestPanelOpen();
            this.switchTab(key);
        } else {
            this.editTlUse(key);
        }
        this.editTlRefresh();
        return key;
    },

    /** New: an empty cut, in a tab of its own. */
    editTlNew(focus = true) {
        this._editTlStash();
        const all = this._editTlAll();
        const taken = new Set(this._editTlTabs().map((k) => all[k] && all[k].cut && all[k].cut.name));
        let n = 1;
        while (taken.has("cut" + n)) n += 1;
        const name = "cut" + n;
        return this._editTlOpenTab(PREFIX + "n" + Date.now().toString(36), name,
                                   { cut: D.emptyCut(name), saved: null, target: null, file: "" }, focus);
    },

    async _editTlRead(obj) {
        try {
            const res = await api.fetchApi("/bepic/timeline" + D.timelineQuery(obj));
            const data = res.ok ? await res.json() : null;
            return data && data.edit ? data : null;
        } catch (e) { return null; }
    },

    // A film came on screen (or left: pass null). Asked once per film: has it a
    // cut beside it? If so the timeline button says so, and opens it.
    async editTlShow(obj) {
        const target = D.timelineTarget(obj);
        const id = target ? JSON.stringify(target) : "";
        if (id === this._editTlFilmId) return;
        this._editTlFilmId = id;
        this._editTlFilm = null;
        this.editTlRefresh();
        if (!target) return;
        const data = await this._editTlRead(obj);
        if (this._editTlFilmId !== id || !data) return;
        this._editTlFilm = { id, obj, target };
        this.editTlRefresh();
    },

    /** Open the cut of the film on screen in its Edit tab (read again: it may have been saved since). */
    async editTlOpenFilmCut(given) {
        const film = given || this._editTlFilm;
        if (!film) return false;
        const key = PREFIX + "f" + hash(film.id);
        if (this.allTabs[key]) {
            this._editTlWant(DOCK_ID, true);
            this.switchTab(key);
            return true;
        }
        const data = await this._editTlRead(film.obj);
        if (!data) { notice("warn", "No cut to open", "The timeline beside this film could not be read."); return false; }
        const name = data.edit.name || String(data.file || "cut").replace(/\.otio$/i, "");
        this._editTlOpenTab(key, name, { cut: data.edit, saved: data.edit, target: film.target, file: data.file || "",
                                         otio: data.otio || "" }, true);
        return true;
    },

    /** Open the cut beside a film that is not (yet) on screen - an agent's "open the edit". */
    async editTlOpenCutOf(obj) {
        const target = D.timelineTarget(obj);
        if (!target) return false;
        return this.editTlOpenFilmCut({ id: JSON.stringify(target), obj, target });
    },

    // A cut's tab came on screen (EditPlayMixin.editPlayEnter): its panels come
    // up with it, the ones that were up when a cut's tab was last left.
    editTlTabShown(key, fresh) {
        const want = this._editTlWanted();
        if (this.setPanelDocked) {
            for (const id of EDIT_PANELS) {
                if (!!want[id] !== this.isPanelDocked(id)) this.setPanelDocked(id, !!want[id]);
            }
            // Where they share a place as tabs, the one that was in front is again.
            for (const id of want.front || []) {
                if (this.isPanelDocked(id) && this.isPanelFront && !this.isPanelFront(id)) this.dockTabFront(id);
            }
        }
        this.editTlRefresh();
    },

    // Another kind of tab came on screen (switchTab): the Edit panels go, since
    // what they show belongs to a cut. `left`: a cut's tab was up until now, so
    // which panels were open is remembered for the next one.
    editTlTabHidden(left) {
        if (!this.isPanelDocked || !this.setPanelDocked) return;
        if (left && this.isPanelFront) {
            this._editTlWanted().front = EDIT_PANELS.filter((id) => this.isPanelFront(id));
        }
        for (const id of EDIT_PANELS) {
            const open = this.isPanelDocked(id);
            if (left) this._editTlWant(id, open);
            if (open) this.setPanelDocked(id, false);
        }
        if (this.barGroupsSync) this.barGroupsSync();
    },

    // An Edit tab is being closed (closeTab). A cut with unsaved changes says so
    // once and stays; the second close throws them away.
    editTlTabClosing(key) {
        if (!this.isEditTab || !this.isEditTab(key)) return true;
        this._editTlStash();
        const all = this._editTlAll();
        if (this._editTlDirtyOf(all[key]) && this._editTlCloseAsked !== key) {
            this._editTlCloseAsked = key;
            notice("warn", "This cut has changes that are not saved", "Close the tab again to throw them away.");
            return false;
        }
        this._editTlCloseAsked = null;
        if (this.activeTab === key && this.editPlayLeave) this.editPlayLeave();
        delete all[key];
        if (this._editTlTab === key) {
            this._editTlTab = null;
            this._editTlCut = null;
            this._editTlSaved = null;
            this._editTlTarget = null;
            this._editTlSel = null;
        }
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        win.setTimeout(() => { this._editTlKeep(); this.editTlRefresh(); }, 0);
        return true;
    },

    _editTlLoaded(data) {
        // The file was written anew: what its items' `ref`s named has moved, so
        // the cuts on the undo stack hold their clips by file from now on.
        const h = this._editTlTab && this._editTlHistories && this._editTlHistories[this._editTlTab];
        if (h) this._editTlHistories[this._editTlTab] = { past: h.past.map(D.detach), future: h.future.map(D.detach) };
        this._editTlSaved = data.edit;
        this._editTlCut = data.edit;
        this._editTlFile = data.file || "";
        if (data.otio) this._editTlOtio = data.otio;
        this._editTlSel = null;
        this._editTlNote = "";
    },

    _editTlDirtyOf(s) {
        if (!s || !s.cut) return false;
        if (!s.saved) return s.cut.clips.length > 0;                  // a new cut, never saved
        return !D.sameCut(s.cut, s.saved);
    },

    _editTlDirty() {
        return !!this._editTlTab && this._editTlDirtyOf({ cut: this._editTlCut, saved: this._editTlSaved });
    },

    /** Is the cut in the panel the one the viewport is playing? */
    _editTlOnScreen() {
        return !!(this._editTlTab && this._editPlayOn && this.activeTab === this._editTlTab);
    },

    /** One line of news in the panel's header (the player says what it cannot play). */
    _editTlSay(text) {
        if (this._editTlNote === text) return;
        this._editTlNote = text;
        this.editTlRefresh();
    },

    // ── the panel ────────────────────────────────────────────────────────────

    _editTlBuild(host) {
        if (this._editTlUi && this._editTlUi.host === host && this._editTlUi.body.isConnected) return this._editTlUi;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        host.querySelectorAll(":scope > .edit-body, :scope > .curves-empty").forEach((n) => n.remove());
        const body = el("div", "edit-body");

        const bar = el("div", "edit-bar");
        // In and out, top left, the Outliner's buttons at the Outliner's size:
        // New, Add, then Save / Export.
        const icon = (key, fallback, title, fn) => {
            const b = el("button", "previz-btn previz-icon", fallback);      // the text stands in if the skin is missing
            b.title = title;
            this._setIcon(b, key);
            b.addEventListener("click", () => fn(b));
            return b;
        };
        const fresh = icon("icon-file", "\u25a1", "New: an empty cut, in a tab of its own", () => this.editTlNew());
        const add = icon("icon-circle-plus", "+", "Add clips (files, or the nodes selected on the canvas) or a track",
                         (b) => this._editTlAddMenu(b));
        const out = icon("icon-save", "\u2193", "Save this cut, or export it as a film", (b) => this._editTlOutMenu(b));
        const sub = el("div", "curves-sub edit-sub");
        const badge = el("div", "edit-badge");
        const button = (label, title, fn) => {
            const b = el("button", "edit-btn", label);
            b.title = title;
            b.addEventListener("click", fn);
            return b;
        };
        // Cutting: the blade, a cut at the playhead, undo / redo, Auto edit.
        const blade = button("\u2702", "Blade (B): click a clip to cut it there. Ctrl+B or S cuts at the playhead",
                             () => this.editTlBladeToggle());
        blade.classList.add("edit-blade-btn");
        const split = button("Split", "Cut the clip under the playhead (Ctrl+B, S)", () => this.editTlSplitAtPlayhead());
        const undo = button("\u21b6", "Undo (Ctrl+Z)", () => this.editTlUndo());
        const redo = button("\u21b7", "Redo (Ctrl+Shift+Z)", () => this.editTlRedo());
        const auto = button("Auto edit\u2026", "Cut on the beat, an even rhythm, a reference's rhythm, the best part "
                            + "of each shot - or ask agentY", () => this.editTlAutoDialog && this.editTlAutoDialog());
        const cuts = button("Detect cuts", "Scene cut detection: where the selected film - or every film on V1 - "
                            + "changes shot; shown as marks first, then split", () => this.editTlDetectSelected());
        const keys = button("?", "The timeline's keys", (ev) => this.editTlKeysHelp && this.editTlKeysHelp(ev.currentTarget));
        const take = button("", "", () => this.editTlTakeAnswer && this.editTlTakeAnswer());
        take.classList.add("primary", "edit-take");
        take.style.display = "none";
        const zoomOut = button("\u2212", "Zoom out (Ctrl+- or Ctrl + wheel)", () => this._editTlZoom(this._editTlView.zoom / 1.5));
        const zoomIn = button("+", "Zoom in (Ctrl+= or Ctrl + wheel)", () => this._editTlZoom(this._editTlView.zoom * 1.5));
        const zoomFit = button("Fit", "The whole film in view (Shift+Z)", () => this._editTlZoom(1));
        bar.append(fresh, add, out, blade, split, undo, redo, auto, cuts, take, sub, badge, zoomOut, zoomIn, zoomFit, keys);

        // The tracks: their headers in a column that stays, the tracks beside it
        // in a strip that is as wide as the zoom makes it and scrolls.
        const main = el("div", "edit-main");
        const heads = el("div", "edit-heads");
        const scroll = el("div", "edit-scroll");
        const area = el("div", "edit-area");
        const ruler = el("div", "edit-ruler");
        ruler.title = "Drag to scrub. Ctrl+drag: set the in and out; right-click: in / out here, clear";
        const rows = el("div", "edit-rows");
        const head = el("div", "edit-head");
        const drop = el("div", "edit-drop");
        area.append(ruler, rows, head, drop);
        scroll.append(area);
        main.append(heads, scroll);

        const hint = el("div", "bepic-tool-hint");
        const empty = el("div", "curves-empty edit-empty");
        body.append(bar, main, hint, empty);
        host.append(body);
        // The keys of the timeline (bEpicViewer_editKeys.js) act only while it
        // has the focus: a press anywhere in it takes it - but not from a field
        // that is being typed into.
        body.tabIndex = 0;
        body.addEventListener("pointerdown", (e) => {
            const t = e.composedPath ? e.composedPath()[0] : e.target;
            if (t && /^(INPUT|TEXTAREA|SELECT|BUTTON|OPTION)$/.test(t.tagName || "")) return;
            try { body.focus({ preventScroll: true }); } catch (_) {}
        }, true);
        // The blade's line follows the pointer over the clips.
        rows.addEventListener("pointermove", (e) => this._editTlBladeHover(e));
        rows.addEventListener("pointerleave", () => this._editTlBladeHover(null));
        // What is drawn inside the clips follows what is in view.
        const redraw = () => { if (this.editMediaSchedule) this.editMediaSchedule(); };
        scroll.addEventListener("scroll", redraw, { passive: true });
        main.addEventListener("scroll", redraw, { passive: true });
        const win = doc.defaultView || window;
        if (win.ResizeObserver) new win.ResizeObserver(redraw).observe(scroll);

        // The ruler is the film's own scrub bar.
        ruler.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            // Ctrl+drag draws the in..out, as Ctrl-drag on the transport's bar does (bEpicViewer_editTrim.js).
            if ((e.ctrlKey || e.metaKey) && this._editTlRangeDrag) { this._editTlRangeDrag(e); return; }
            e.preventDefault();
            this._editTlScrubbing = true;
            const go = (ev) => { const at = this._editTlTimeAt(ev.clientX); if (at != null) this._editTlSeek(at, true); };
            const up = () => {
                this._editTlScrubbing = false;
                ruler.removeEventListener("pointermove", go);
                ruler.removeEventListener("pointerup", up);
                ruler.removeEventListener("pointercancel", up);
                try { ruler.releasePointerCapture(e.pointerId); } catch (_) {}
            };
            try { ruler.setPointerCapture(e.pointerId); } catch (_) {}
            ruler.addEventListener("pointermove", go);
            ruler.addEventListener("pointerup", up);
            ruler.addEventListener("pointercancel", up);
            go(e);
        });
        // Right-click: set the in or the out here, mark the shot, clear them.
        ruler.addEventListener("contextmenu", (e) => { if (this._editTlRulerMenu) this._editTlRulerMenu(e); });

        // Zoom and pan. Ctrl + wheel zooms about the pointer; the wheel alone
        // moves along the film (a timeline has nowhere else to scroll to); the
        // middle button drags it.
        scroll.addEventListener("wheel", (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                this._editTlZoom(this._editTlView.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX);
            } else if (scroll.scrollWidth > scroll.clientWidth + 1) {
                e.preventDefault();
                scroll.scrollLeft += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
            }
        }, { passive: false });
        scroll.addEventListener("pointerdown", (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            const x0 = e.clientX, left0 = scroll.scrollLeft;
            const move = (ev) => { scroll.scrollLeft = left0 - (ev.clientX - x0); };
            const up = () => {
                scroll.removeEventListener("pointermove", move);
                scroll.removeEventListener("pointerup", up);
                scroll.removeEventListener("pointercancel", up);
                try { scroll.releasePointerCapture(e.pointerId); } catch (_) {}
            };
            try { scroll.setPointerCapture(e.pointerId); } catch (_) {}
            scroll.addEventListener("pointermove", move);
            scroll.addEventListener("pointerup", up);
            scroll.addEventListener("pointercancel", up);
        });
        // A press on a track where nothing lies takes the selection off.
        rows.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || !(e.target.classList && e.target.classList.contains("edit-track"))) return;
            if (this._editTlSel) { this._editTlSel = null; this.editTlRefresh(); }
        });

        // New material: rows of the file browser, history thumbs, the viewport -
        // and what is dragged out of the Effects panel.
        // Also files from the desktop (copied into input/edits on the way), and
        // pictures dragged out of ComfyUI's own queue / assets list (a link to
        // its /view, which names the file the way ComfyUI does).
        const carries = (e) => (this._editTlCarries(e) ? "files"
            : this._editTlCarries(e, EFFECT_TYPE) ? "effect"
            : this._editTlCarries(e, "Files") ? "os"
            : this._editTlCarries(e, "text/uri-list") ? "uri" : "");
        const rowOf = (e) => {
            const path = e.composedPath ? e.composedPath() : [e.target];
            const row = path.find((n) => n && n.classList && n.classList.contains("edit-track"));
            return row ? row.dataset.track : "";
        };
        body.addEventListener("dragover", (e) => {
            const what = carries(e);
            if (!what) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
            this._editTlDropMark(e.clientX, what === "effect" ? "free" : rowOf(e), true);
        });
        body.addEventListener("dragleave", (e) => {
            if (!e.relatedTarget || !body.contains(e.relatedTarget)) this._editTlDropMark(null);
        });
        body.addEventListener("drop", (e) => {
            const what = carries(e);
            if (!what) return;
            e.preventDefault();
            e.stopPropagation();
            const raw = this._editTlTimeAt(e.clientX);
            const track = rowOf(e);
            const at = raw == null ? null : this._editTlSnap(raw, track);
            this._editTlDropMark(null);
            if (what === "os") { this._editTlAdd(this._editTlOsItems(e.dataTransfer.files), at, track); return; }
            if (what === "uri") { this._editTlAdd(this._editTlUriItems(e.dataTransfer), at, track); return; }
            let payload = null;
            try { payload = JSON.parse(e.dataTransfer.getData(what === "effect" ? EFFECT_TYPE : DRAG_TYPE)); } catch (_) {}
            if (what === "effect") { if (payload && this.editFxApply) this.editFxApply(payload, at, track); return; }
            this._editTlAdd((payload && payload.items) || [], at, track);
        });
        this._editTlUi = { host, empty, body, sub, badge, out, main, heads, scroll, area, ruler, rows,
                           head, drop, hint, blade, split, undo, redo, auto, cuts, take };
        this._editTlWatchCanvas();
        return this._editTlUi;
    },

    _editTlCarries(e, type = DRAG_TYPE) {
        try { return Array.from(e.dataTransfer?.types || []).includes(type); } catch (_) { return false; }
    },

    /** Draw the Edit panels from the cut as it stands. The one place they are drawn. */
    editTlRefresh() {
        if (this.barGroupsSync) this.barGroupsSync();
        // With no cut in the panel, an Edit tab that is open takes its place.
        if (!this._editTlTab) {
            const first = this._editTlTabs()[0];
            if (first) this.editTlUse(first);
        }
        // The viewport plays the cut: a change is on screen with this redraw.
        if (this.editPlayCutChanged) this.editPlayCutChanged();
        if (this._editTlTab) this._editTlKeep();
        if (this._editTlTab && this._editTlKnowFiles) this._editTlKnowFiles(this._editTlCut);
        // The numbers of what is selected, and what can be put into the cut.
        if (this.editPanelsRefresh) this.editPanelsRefresh();
        const host = this.editTimelinePanel;
        if (!host || !this._editTlOpen()) return;
        const ui = this._editTlBuild(host);
        const cut = this._editTlTab ? this._editTlCut : null;
        const lay = cut ? D.layoutCut(cut, this._editTlView.zoom) : null;
        const has = !!(lay && lay.total > 0);
        const busy = !!this._editTlBusy;
        const dirty = this._editTlDirty();
        for (const part of [ui.main, ui.hint]) part.style.display = has ? "" : "none";
        ui.empty.style.display = has ? "none" : "block";
        ui.empty.textContent = cut
            ? "This cut is empty. Add clips with the plus button, or drop them here - from the desktop, the file "
              + "browser, the History, ComfyUI's queue, or a node dragged off the canvas."
            : "No cut is open. New starts one; so does adding or dropping clips here.";
        ui.out.disabled = !has || busy;
        const hist = this._editTlHistory();
        ui.undo.disabled = !cut || !hist.past.length;
        ui.redo.disabled = !cut || !hist.future.length;
        ui.split.disabled = ui.auto.disabled = ui.cuts.disabled = !has;
        ui.blade.classList.toggle("on", !!this._editTlBlade);
        ui.body.classList.toggle("blade", !!this._editTlBlade && has);
        if (this.editTlAnswerButton) this.editTlAnswerButton(ui.take); else ui.take.style.display = "none";
        ui.badge.textContent = dirty ? (this._editTlSaved ? "changed \u2014 not saved" : "new cut \u2014 not saved") : "";
        ui.badge.className = "edit-badge" + (dirty ? " dirty" : "");
        if (!has) {
            this._editTlLay = null;
            if (ui.cutbar) ui.cutbar.style.display = "none";
            ui.sub.textContent = cut ? (cut.name || "new cut") + (this._editTlNote ? " \u00b7 " + this._editTlNote : "") : "";
            return;
        }
        this._editTlLay = lay;
        const view = this._editTlView;
        const live = this._editTlLive();
        const n = cut.clips.length;
        ui.sub.textContent = `${cut.name || this._editTlFile || "new cut"} \u00b7 ${n} shot${n === 1 ? "" : "s"} \u00b7 `
            + D.lengthLabel(lay.total) + (this._editTlNote ? " \u00b7 " + this._editTlNote : "");
        ui.hint.textContent = this._editTlBlade
            ? "Blade: click a clip to cut it there (B or Esc to put it away). Ctrl+Z undoes."
            : "Drag on the ruler to scrub, a clip's edge to trim (the middle of a cut: roll), a shot to reorder. "
              + "Alt+drag: slip (on an edge: retime), Alt+Shift+drag: slide, Ctrl+drag the out-edge: loop. "
              + "Ctrl + wheel zooms. I / O / X: in and out. ? lists the keys. Drop files onto a track.";
        ui.area.style.width = (view.zoom * 100) + "%";

        const doc = host.ownerDocument;
        const sel = this._editTlSel;
        const picked = (kind, i, track) => !!sel && sel.kind === kind && sel.i === i && (kind !== "tclip" || sel.track === track);
        const block = (cls, item, text) => {
            const b = doc.createElement("div");
            b.className = cls;
            b.style.left = item.left + "%";
            b.style.width = item.width + "%";
            b.title = item.title || "";
            if (text) {
                // In a span of its own, over the filmstrip and the waveform drawn under it.
                const label = doc.createElement("span");
                label.className = "edit-label";
                label.textContent = text;
                b.append(label);
            }
            if (item.color) { b.style.background = item.color; b.style.borderColor = item.color; b.classList.add("tinted"); }
            return b;
        };
        ui.ruler.replaceChildren(...lay.ticks.map((t) => {
            const m = doc.createElement("div");
            m.className = "edit-tick";
            m.style.left = t.left + "%";
            m.textContent = t.label;
            return m;
        }));
        // Top to bottom as an editor lays them out: the texts, the video tracks
        // from the highest down to the cut itself, then the sound.
        const list = [];
        if (lay.texts.length) list.push({ id: "T", kind: "text", name: "Text" });
        for (const k of lay.tracks.filter((x) => x.kind !== "audio").reverse()) list.push({ id: k.id, kind: "video", name: k.name, track: k });
        list.push({ id: "V1", kind: "video", name: "V1" });
        if (lay.sound.length) list.push({ id: "A1", kind: "audio", name: "A1" });
        for (const k of lay.tracks.filter((x) => x.kind === "audio")) list.push({ id: k.id, kind: "audio", name: k.name, track: k });

        const headEls = [Object.assign(doc.createElement("div"), { className: "edit-headrow edit-headruler" })];
        const rowEls = [];
        for (const row of list) {
            const height = Math.max(12, Math.min(160, Number(view.heights[row.id]) || ROW_HEIGHT[row.kind]));
            const dead = row.id === "T" ? !!(cut.off && cut.off.T) : !live.has(row.id);
            const tr = doc.createElement("div");
            tr.className = `edit-track edit-k-${row.kind}` + (dead ? " dead" : "");
            tr.dataset.track = row.id;
            tr.style.height = height + "px";
            const kids = [];
            if (row.id === "T") {
                for (const x of lay.texts) {
                    const b = block("edit-text" + (picked("text", x.i) ? " sel" : "") + (x.late ? " late" : ""), x, x.name);
                    b.addEventListener("pointerdown", (e) => this._editTlTextDown(e, b, x.i));
                    b.addEventListener("pointermove", (e) => this._editTlEdgeCursor(e, b));
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "text", i: x.i }));
                    kids.push(b);
                }
            } else if (row.id === "V1") {
                for (const s of lay.shots) {
                    const b = block("edit-shot" + (picked("clip", s.i) ? " sel" : "")
                        + (Number.isInteger(cut.clips[s.i].ref) ? "" : " new"), s, s.name);
                    b.dataset.key = "V1:" + s.i;
                    b._media = { file: cut.clips[s.i].file, in: Number(cut.clips[s.i].in) || 0, length: s.length,
                                 row: "video", volume: cut.clips[s.i].volume, clip: cut.clips[s.i] };
                    this._editTlBadges(b, cut.clips[s.i]);
                    b.addEventListener("pointerdown", (e) => this._editTlShotDown(e, b, s.i));
                    b.addEventListener("pointermove", (e) => this._editTlHover(e, b, { kind: "clip", i: s.i }));
                    b.addEventListener("pointerleave", () => this._editTlHoverEnd());
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "clip", i: s.i }));
                    kids.push(b);
                }
                // A dissolve: a bar over the join, as long as the dissolve is.
                for (const m of lay.mixes) {
                    const b = block("edit-mix" + (picked("mix", m.i) ? " sel" : ""), m, "Cross Dissolve");
                    b.addEventListener("pointerdown", (e) => this._editTlMixDown(e, b, m.i));
                    b.addEventListener("pointermove", (e) => this._editTlMixHover(e, b, m.i));
                    b.addEventListener("pointerleave", () => this._editTlHoverEnd());
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "mix", i: m.i }));
                    kids.push(b);
                }
            } else if (row.id === "A1") {
                for (const [k, s] of lay.sound.entries()) {
                    const b = block("edit-snd", s, s.name);
                    b._media = { file: cut.sound[k].file, in: 0, length: lay.total, row: "audio", volume: 1 };
                    kids.push(b);
                }
            } else {
                for (const c of row.track.items) {
                    const b = block((row.kind === "audio" ? "edit-shot edit-sclip" : "edit-shot edit-tclip")
                        + (picked("tclip", c.i, row.id) ? " sel" : ""), c, c.name);
                    b.dataset.key = row.id + ":" + c.i;
                    const tc = row.track.items[c.i] && D.trackOf(cut, row.id).clips[c.i];
                    b._media = { file: tc.file, in: Number(tc.in) || 0, length: c.length, row: row.kind, volume: tc.volume, clip: tc };
                    this._editTlBadges(b, tc);
                    b.addEventListener("pointerdown", (e) => this._editTlTrackClipDown(e, b, row.id, c.i));
                    b.addEventListener("pointermove", (e) => this._editTlHover(e, b, { kind: "tclip", track: row.id, i: c.i }));
                    b.addEventListener("pointerleave", () => this._editTlHoverEnd());
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "tclip", track: row.id, i: c.i }));
                    kids.push(b);
                }
            }
            tr.append(...kids);
            rowEls.push(tr);
            headEls.push(this._editTlHeadRow(doc, row, height, dead, tr));
        }
        ui.heads.replaceChildren(...headEls);
        ui.rows.replaceChildren(...rowEls);
        this._editTlNow = "";
        // The in and out (the transport's own range: played, looped, exported).
        if (this._editTlRulerMarks) this._editTlRulerMarks();
        if (this.editTlMarksDraw) this.editTlMarksDraw(ui, cut, lay);
        this._editTlPlayhead();
        if (this.editMediaSchedule) this.editMediaSchedule();
    },

    // A track's header: its name, its switch, its solo, and - on its lower edge -
    // its height.
    _editTlHeadRow(doc, row, height, dead, trackEl) {
        const view = this._editTlView;
        const hd = doc.createElement("div");
        hd.className = "edit-headrow" + (dead ? " dead" : "");
        hd.style.height = height + "px";
        const name = doc.createElement("span");
        name.className = "edit-hname";
        name.textContent = row.name;
        name.title = row.id === "V1" ? "The cut itself: one shot after the other"
            : row.id === "A1" ? "The sound under the whole film"
            : row.id === "T" ? "Texts" : (row.kind === "audio" ? "A sound track: its clips lie under the film"
                                                              : "A video track: its clips cover what is under them");
        const small = (label, title, on, fn) => {
            const b = doc.createElement("button");
            b.className = "edit-hbtn" + (on ? " on" : "");
            b.textContent = label;
            b.title = title;
            b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
            return b;
        };
        const cut = this._editTlCut;
        const off = row.track ? !!row.track.off : !!(cut.off && cut.off[row.id]);
        hd.append(name, small("\u25cf", off ? "Switched off - click to switch this track on"
                                             : "Switch this track off: not seen, not heard, not rendered", !off,
                              () => this._editTlApply(D.setTrackOff(cut, row.id, !off))));
        if (row.id !== "T") {
            hd.append(small("S", "Solo: play only the soloed tracks of this kind (not saved, not rendered)",
                            !!view.solo[row.id], () => {
                if (view.solo[row.id]) delete view.solo[row.id]; else view.solo[row.id] = true;
                if (this.editPlayLiveChanged) this.editPlayLiveChanged();
                this.editTlRefresh();
            }));
        }
        if (row.track) {
            hd.append(small("\u2715", "Remove this track and what is on it", false, () => {
                delete view.solo[row.id];
                if (this._editTlSel && this._editTlSel.track === row.id) this._editTlSel = null;
                this._editTlApply(D.removeTrack(cut, row.id));
            }));
        }
        const grip = doc.createElement("div");
        grip.className = "edit-hgrip";
        grip.title = "Drag to change this track's height";
        grip.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const y0 = e.clientY;
            const move = (ev) => {
                const h = Math.max(12, Math.min(160, height + (ev.clientY - y0)));
                view.heights[row.id] = h;
                hd.style.height = h + "px";
                trackEl.style.height = h + "px";
            };
            const up = () => {
                grip.removeEventListener("pointermove", move);
                grip.removeEventListener("pointerup", up);
                grip.removeEventListener("pointercancel", up);
                try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
                this.editTlRefresh();
            };
            try { grip.setPointerCapture(e.pointerId); } catch (_) {}
            grip.addEventListener("pointermove", move);
            grip.addEventListener("pointerup", up);
            grip.addEventListener("pointercancel", up);
        });
        hd.append(grip);
        return hd;
    },

    /** Zoom the timeline to `zoom` (1 = the whole film), keeping the moment under `clientX` where it is. */
    _editTlZoom(zoom, clientX) {
        const ui = this._editTlUi;
        const view = this._editTlView;
        if (!ui || !view) return;
        const sc = ui.scroll;
        const box = sc.getBoundingClientRect();
        const ax = clientX == null ? box.width / 2 : Math.max(0, Math.min(box.width, clientX - box.left));
        const share = sc.scrollWidth > 0 ? (sc.scrollLeft + ax) / sc.scrollWidth : 0;
        view.zoom = Math.max(1, Math.min(64, Number(zoom) || 1));
        ui.area.style.width = (view.zoom * 100) + "%";
        sc.scrollLeft = Math.max(0, share * sc.scrollWidth - ax);
        this.editTlRefresh();
    },

    // Right-click on a clip: its colour, and taking it out.
    _editTlClipMenu(e, sel) {
        e.preventDefault();
        e.stopPropagation();
        this._editTlSel = sel;
        this.editTlRefresh();
        const entries = [{ label: sel.kind === "text" ? "Remove this text" : sel.kind === "mix" ? "Remove this dissolve" : "Remove from the cut",
                           disabled: sel.kind === "clip" && this._editTlCut.clips.length <= 1,
                           run: () => this._editTlRemove(sel) }];
        const clip = D.clipOf(this._editTlCut, sel);
        if (clip && FILM_EXTS.includes(ext(clip.file))) {
            entries.push({ label: "Detect cuts", run: () => this.editTlDetectCuts([sel]) });
        }
        if (sel.kind === "clip" || sel.kind === "tclip") {
            entries.push({ label: "Split at the playhead", disabled: !this._editTlOnScreen(), run: () => this.editTlSplitAtPlayhead() });
        }
        const menu = this._previzOpenMenu(entries, e.clientX, e.clientY);
        if (!menu || sel.kind === "text" || sel.kind === "mix") return;
        menu.prepend(this._editTlSwatches(menu.ownerDocument, D.clipOf(this._editTlCut, sel), (color) => {
            this._previzCloseAddMenu();
            this._editTlApply(D.setClipProps(this._editTlCut, sel, { color }));
        }));
    },

    /** A row of colours to give a clip (and "none"); used by the menu and the Inspector. */
    _editTlSwatches(doc, clip, pick) {
        const box = doc.createElement("div");
        box.className = "edit-swatches";
        const now = String((clip && clip.color) || "").toLowerCase();
        for (const color of ["", ...this._tabColorPalette()]) {
            const b = doc.createElement("button");
            b.className = "edit-swatch" + (color.toLowerCase() === now ? " on" : "") + (color ? "" : " none");
            b.title = color ? color : "No colour";
            if (color) b.style.background = color;
            b.addEventListener("click", (ev) => { ev.stopPropagation(); pick(color); });
            box.append(b);
        }
        return box;
    },

    _editTlRemove(sel) {
        const cut = this._editTlCut;
        this._editTlSel = null;
        if (sel.kind === "clip") this._editTlApply(D.removeClip(cut, sel.i));
        else if (sel.kind === "tclip") this._editTlApply(D.removeTrackClip(cut, sel.track, sel.i));
        else if (sel.kind === "text") this._editTlApply(D.removeText(cut, sel.i));
        else if (sel.kind === "mix") this._editTlApply(D.setTransition(cut, sel.i, 0));
    },

    _editTlApply(cut) {
        // One step of the undo stack - but a drag records itself once, when it is let go.
        if (!this._editTlDragging) this._editTlRecord(this._editTlCut, cut);
        this._editTlCut = cut;
        this._editTlNote = "";
        this.editTlRefresh();
    },

    // ── undo ─────────────────────────────────────────────────────────────────
    //
    // One stack per cut's tab: the cuts that were (editTimelineData.historyPush).
    // Not kept across a reload - what is kept is the cut itself.

    _editTlHistory(key = this._editTlTab) {
        if (!this._editTlHistories) this._editTlHistories = {};
        if (!key) return D.emptyHistory();
        return this._editTlHistories[key] || (this._editTlHistories[key] = D.emptyHistory());
    },

    /** `before` gave way to `after`: remember it, unless nothing the panel shows changed. */
    _editTlRecord(before, after) {
        if (!this._editTlTab || !before || before === after || (after && D.sameCut(before, after))) return;
        const h = this._editTlHistory();
        this._editTlHistories[this._editTlTab] = D.historyPush(h, before);
    },

    editTlUndo() { this._editTlStep(D.historyUndo); },
    editTlRedo() { this._editTlStep(D.historyRedo); },

    _editTlStep(how) {
        if (!this._editTlTab || !this._editTlCut || this._editTlDragging) return;
        const got = how(this._editTlHistory(), this._editTlCut);
        if (!got) { this._editTlSay(how === D.historyUndo ? "nothing to undo" : "nothing to redo"); return; }
        this._editTlHistories[this._editTlTab] = got.history;
        this._editTlCut = got.cut;
        // The selection may name a clip the cut no longer has.
        if (this._editTlSel && !(this._editTlSel.kind === "text" ? got.cut.texts[this._editTlSel.i]
                                 : this._editTlSel.kind === "mix" ? got.cut.clips[this._editTlSel.i]
                                 : D.clipOf(got.cut, this._editTlSel))) this._editTlSel = null;
        this._editTlNote = "";
        this.editTlRefresh();
    },

    _editTlMove(from, to) {
        const cut = D.moveClip(this._editTlCut, from, to);
        this._editTlSel = { kind: "clip", i: Math.max(0, Math.min(cut.clips.length - 1, to)) };
        this._editTlApply(cut);
    },

    // ── dragging ─────────────────────────────────────────────────────────────

    /** The moment of the film under a pointer's x. */
    _editTlTimeAt(clientX) {
        const ui = this._editTlUi;
        const lay = this._editTlLay;
        if (!ui || !lay || !(lay.total > 0) || !ui.body.isConnected || ui.body.style.display === "none") return null;
        const box = ui.area.getBoundingClientRect();
        if (!(box.width > 0)) return null;
        return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * lay.total;
    },

    _editTlZone(e, el) {
        const box = el.getBoundingClientRect();
        const edge = Math.min(EDGE_PX, box.width / 3);
        if (e.clientX - box.left <= edge) return "start";
        if (box.right - e.clientX <= edge) return "end";
        return "body";
    },

    _editTlEdgeCursor(e, el) {
        if (e.buttons) return;
        el.style.cursor = this._editTlZone(e, el) === "body" ? "" : "ew-resize";
    },

    // One drag: pointer capture on the pressed block (so it keeps working in a
    // popped-out window), every move worked out from the cut as it was at the
    // press - never from the half-dragged one - and one redraw per move.
    _editTlDrag(e, el, onMove, onUp) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const ui = this._editTlUi;
        const box = ui.area.getBoundingClientRect();
        const perPx = box.width > 0 ? this._editTlLay.total / box.width : 0;
        const x0 = e.clientX;
        const id = e.pointerId;
        const captor = ui.area;          // the block itself is replaced on every redraw
        try { captor.setPointerCapture(id); } catch (_) {}
        // The whole drag is one step of the undo stack.
        const before = this._editTlCut;
        this._editTlDragging = true;
        const y0 = e.clientY;
        let moved = false;
        const move = (ev) => {
            const dx = ev.clientX - x0;
            // Sideways or up and down: a clip is also dragged from one track to another.
            if (!moved && Math.hypot(dx, ev.clientY - y0) < DRAG_SLOP) return;
            moved = true;
            onMove(dx * perPx, ev);
        };
        const up = (ev) => {
            captor.removeEventListener("pointermove", move);
            captor.removeEventListener("pointerup", up);
            captor.removeEventListener("pointercancel", up);
            try { captor.releasePointerCapture(id); } catch (_) {}
            try { onUp(moved, ev); } finally {
                this._editTlDragging = false;
                if (this._editTlCut !== before) { this._editTlRecord(before, this._editTlCut); this.editTlRefresh(); }
            }
        };
        captor.addEventListener("pointermove", move);
        captor.addEventListener("pointerup", up);
        captor.addEventListener("pointercancel", up);
    },

    // The track under the pointer that a clip may be dropped onto ("" for none).
    // `sel` is the clip being dragged: a sound cannot become a picture, nor a
    // picture a sound, and a cut cannot lose its only shot.
    _editTlTrackUnder(ev, sel) {
        const ui = this._editTlUi;
        const cut = this._editTlCut;
        const root = ui.body.getRootNode();
        const hit = root && root.elementFromPoint ? root.elementFromPoint(ev.clientX, ev.clientY) : null;
        const row = hit && hit.closest ? hit.closest(".edit-track") : null;
        const id = row ? row.dataset.track : "";
        if (!id || id === "T" || id === "A1") return "";
        const from = sel.kind === "clip" ? "V1" : sel.track;
        if (id === from) return id;
        const clip = D.clipOf(cut, sel);
        const target = D.trackOf(cut, id);
        const source = D.trackOf(cut, from);
        const still = D.isStill(clip.file) && !SOUND_EXTS.includes(ext(clip.file));
        if (target && target.kind === "audio") return still ? "" : id;            // a film gives its sound
        if (source && source.kind === "audio" && !FILM_EXTS.includes(ext(clip.file))) return "";
        if (sel.kind === "clip" && cut.clips.length <= 1) return "";
        return id;
    },

    // What is being dragged, drawn where it would land: on the track under the
    // pointer, at the pointer's moment. null takes it away.
    _editTlGhost(spec) {
        const ui = this._editTlUi;
        if (!ui) return;
        for (const r of ui.rows.querySelectorAll(".edit-track.landing")) r.classList.remove("landing");
        if (!spec) { if (ui.ghost) ui.ghost.style.display = "none"; return; }
        if (!ui.ghost || !ui.ghost.isConnected) {
            ui.ghost = ui.area.ownerDocument.createElement("div");
            ui.ghost.className = "edit-ghost";
            ui.area.append(ui.ghost);
        }
        const row = ui.rows.querySelector(`.edit-track[data-track="${spec.track}"]`);
        if (!row) { ui.ghost.style.display = "none"; return; }
        row.classList.add("landing");
        const a = ui.area.getBoundingClientRect(), r = row.getBoundingClientRect();
        const total = this._editTlLay.total || 1;
        ui.ghost.style.display = "block";
        ui.ghost.style.top = (r.top - a.top) + "px";
        ui.ghost.style.height = r.height + "px";
        ui.ghost.style.left = Math.max(0, (spec.at / total) * 100) + "%";
        ui.ghost.style.width = Math.max(0.5, (spec.length / total) * 100) + "%";
        ui.ghost.textContent = spec.name || "";
    },

    _editTlShotDown(e, el, i) {
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const zone = this._editTlZone(e, el);
        const was = start.clips[i];
        const sel = { kind: "clip", i };
        if (this._editTlBlade) { this._editTlBladeCut(e, sel); return; }
        // An edge, or a modifier held: trim, roll, retime, loop, slip, slide (bEpicViewer_editTrim.js).
        if (this._editTlTrimDown && this._editTlTrimDown(e, el, sel)) return;
        const began = D.clipStarts(start)[i];
        const grab = (this._editTlTimeAt(e.clientX) || began) - began;       // where in the clip it was taken hold of
        this._editTlSel = sel;
        let onto = "V1";
        this._editTlDrag(e, el, (seconds, ev) => {
            if (zone === "end") this._editTlCut = D.trimEnd(start, i, D.toFrame(was.length + seconds, fps));
            else if (zone === "start") this._editTlCut = D.trimStart(start, i, D.toFrame(seconds, fps));
            else {
                // The body: to another place in the order, or onto another track.
                onto = this._editTlTrackUnder(ev, sel) || "V1";
                const at = Math.max(0, (this._editTlTimeAt(ev.clientX) || 0) - grab);
                if (onto === "V1") { this._editTlGhost(null); this._editTlDropMark(ev.clientX); }
                else { this._editTlDropMark(null); this._editTlGhost({ track: onto, at, length: was.length, name: was.name }); }
                return;
            }
            this.editTlRefresh();
        }, (moved, ev) => {
            this._editTlDropMark(null);
            this._editTlGhost(null);
            if (moved && zone === "body") {
                const at = this._editTlTimeAt(ev.clientX);
                if (onto !== "V1") {
                    const got = D.transferClip(start, sel, onto, D.toFrame(Math.max(0, (at || 0) - grab), fps));
                    if (got) { this._editTlSel = got.sel; this._editTlApply(got.cut); return; }
                }
                // Where it lands among the OTHERS: its own block is not a place to land.
                const others = D.removeClip(start, i);
                let to = at == null ? i : D.dropIndex(start.clips.length > 1 ? others : start, at);
                if (start.clips.length <= 1) to = 0;
                this._editTlMove(i, to);
                return;
            }
            if (!moved) this._editTlSeek(began);
            this.editTlRefresh();
        });
    },

    // A dissolve's bar: its edges make it longer or shorter (the join it sits on
    // stays the end of the shot before it), a click selects it.
    _editTlMixDown(e, el, i) {
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const zone = this._editTlZone(e, el);
        const was = Number(start.clips[i].transition) || 0;
        // Its body pressed: the cut under it rolls, the dissolve with it.
        if (zone === "body" && e.button === 0 && this._editTlMixRoll) { this._editTlMixRoll(e, el, i); return; }
        this._editTlSel = { kind: "mix", i };
        this._editTlDrag(e, el, (seconds) => {
            if (zone === "body") return;
            const length = Math.max(1 / fps, D.toFrame(was + (zone === "end" ? seconds : -seconds), fps));
            this._editTlCut = D.setTransition(start, i, length);
            this.editTlRefresh();
        }, (moved) => {
            if (!moved) this._editTlSeek(D.clipStarts(start)[i]);
            this.editTlRefresh();
        });
    },

    // A clip on a higher track: it is PLACED, so a drag moves it to another
    // moment and nothing else moves with it.
    _editTlTrackClipDown(e, el, id, i) {
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const zone = this._editTlZone(e, el);
        const was = D.trackOf(start, id).clips[i];
        const sel = { kind: "tclip", track: id, i };
        if (this._editTlBlade) { this._editTlBladeCut(e, sel); return; }
        if (this._editTlTrimDown && this._editTlTrimDown(e, el, sel)) return;
        this._editTlSel = sel;
        let onto = id;
        // Its edges snap to the other clips' edges and to the playhead.
        const others = D.editPoints(D.removeTrackClip(start, id, i));
        this._editTlDrag(e, el, (seconds, ev) => {
            if (zone === "end") this._editTlCut = D.trimTrackClipEnd(start, id, i, D.toFrame(was.length + seconds, fps));
            else if (zone === "start") this._editTlCut = D.trimTrackClipStart(start, id, i, D.toFrame(seconds, fps));
            else {
                onto = this._editTlTrackUnder(ev, sel) || id;
                let at = D.toFrame(Math.max(0, was.at + seconds), fps);
                if (onto === id) {
                    at = this._editTlSnapSpan(at, Number(was.length) || 0, others);
                    this._editTlGhost(null);
                    this._editTlDropMark(null);
                    this._editTlCut = D.moveTrackClip(start, id, i, at);
                    this.editTlRefresh();
                    return;
                }
                // Over another track: it stays where it was until it is let go there.
                if (this._editTlCut !== start) { this._editTlCut = start; this.editTlRefresh(); }
                if (onto === "V1") { this._editTlGhost(null); this._editTlDropMark(ev.clientX); }
                else { this._editTlDropMark(null); this._editTlGhost({ track: onto, at, length: was.length, name: was.name }); }
                return;
            }
            this.editTlRefresh();
        }, (moved, ev) => {
            this._editTlDropMark(null);
            this._editTlGhost(null);
            if (moved && zone === "body" && onto !== id) {
                const at = onto === "V1" ? (this._editTlTimeAt(ev.clientX) || 0)
                                         : D.toFrame(Math.max(0, was.at + ((this._editTlTimeAt(ev.clientX) || 0) - (this._editTlTimeAt(e.clientX) || 0))), fps);
                const got = D.transferClip(start, sel, onto, at);
                if (got) { this._editTlSel = got.sel; this._editTlApply(got.cut); return; }
            }
            if (!moved) this._editTlSeek(was.at);
            this.editTlRefresh();
        });
    },

    _editTlTextDown(e, el, i) {
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const zone = this._editTlZone(e, el);
        const was = start.texts[i];
        this._editTlSel = { kind: "text", i };
        this._editTlDrag(e, el, (seconds) => {
            if (zone === "end") this._editTlCut = D.resizeText(start, i, D.toFrame(was.length + seconds, fps));
            else if (zone === "start") this._editTlCut = D.trimTextStart(start, i, D.toFrame(was.start + seconds, fps));
            else this._editTlCut = D.moveText(start, i, D.toFrame(was.start + seconds, fps));
            this.editTlRefresh();
        }, (moved) => {
            if (!moved) this._editTlSeek(was.start);
            this.editTlRefresh();
        });
    },

    // The line that shows where dropped or moved material will go: between two
    // shots on the cut itself; at the pointer's own moment on a track where
    // clips are placed (`where` names the track, or is "free").
    _editTlDropMark(clientX, where, snap) {
        const ui = this._editTlUi;
        if (!ui) return;
        for (const r of ui.rows.querySelectorAll(".edit-track.landing")) if (r.dataset.track !== where) r.classList.remove("landing");
        const at = clientX == null ? null : this._editTlTimeAt(clientX);
        if (at == null || !this._editTlCut || !this._editTlLay) { ui.drop.style.display = "none"; return; }
        const cut = this._editTlCut;
        let moment = snap ? this._editTlSnap(at, where) : at;
        // The track it lands on is lit, as a moved clip's is.
        if (snap && where) {
            const row = [...ui.rows.querySelectorAll(".edit-track")].find((r) => r.dataset.track === where);
            if (row) row.classList.add("landing");
        }
        if (!(where === "free" || (where && D.trackOf(cut, where)))) {
            const idx = D.dropIndex(cut, at);
            const starts = D.clipStarts(cut);
            moment = idx < starts.length ? starts[idx] : D.mainLength(cut);
        }
        ui.drop.style.display = "block";
        ui.drop.style.left = (moment / this._editTlLay.total) * 100 + "%";
    },

    // ── snapping ─────────────────────────────────────────────────────────────

    /** How many seconds SNAP_PX pixels are at the zoom the timeline is at. */
    _editTlSnapTolerance() {
        const ui = this._editTlUi, lay = this._editTlLay;
        if (!ui || !lay || !(lay.total > 0)) return 0;
        const w = ui.area.getBoundingClientRect().width;
        return w > 0 ? SNAP_PX * lay.total / w : 0;
    },

    /** The places a moment snaps to: the edit points, and the playhead. */
    _editTlSnapPoints(points) {
        const out = [...(points || D.editPoints(this._editTlCut)), D.filmLength(this._editTlCut)];
        if (this._editTlOnScreen()) out.push((this.currentFrame || 0) / (this._editTlCut.fps || 24));
        return out;
    },

    /** A moment of a drop, snapped and on a frame. */
    _editTlSnap(seconds) {
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        const t = D.snapTime(seconds, this._editTlSnapPoints(), this._editTlSnapTolerance());
        return D.toFrame(Math.max(0, t), fps);
    },

    /** A clip `length` long moved to begin at `at`: its start or its end snaps, whichever is nearer. */
    _editTlSnapSpan(at, length, points) {
        const pts = this._editTlSnapPoints(points), tol = this._editTlSnapTolerance();
        const a = D.snapTime(at, pts, tol), b = D.snapTime(at + length, pts, tol) - length;
        const da = Math.abs(a - at), db = Math.abs(b - at);
        const best = (da && (!db || da <= db)) ? a : (db ? b : at);
        return D.toFrame(Math.max(0, best), (this._editTlCut && this._editTlCut.fps) || 24);
    },

    // ── the blade ────────────────────────────────────────────────────────────

    editTlBladeToggle(on) {
        this._editTlBlade = on === undefined ? !this._editTlBlade : !!on;
        if (!this._editTlBlade) this._editTlBladeHover(null);
        this.editTlRefresh();
    },

    /** The moment the blade would cut at, under a pointer: on a frame, snapped to the playhead and the edges. */
    _editTlBladeTime(clientX) {
        const t = this._editTlTimeAt(clientX);
        if (t == null) return null;
        const fps = this._editTlCut.fps || 24;
        return D.toFrame(D.snapTime(t, this._editTlSnapPoints(), this._editTlSnapTolerance()), fps);
    },

    _editTlBladeHover(e) {
        const ui = this._editTlUi;
        if (!ui) return;
        if (!ui.bladeLine || !ui.bladeLine.isConnected) {
            ui.bladeLine = ui.area.ownerDocument.createElement("div");
            ui.bladeLine.className = "edit-bladeline";
            ui.area.append(ui.bladeLine);
        }
        const t = e && this._editTlBlade && !e.buttons ? this._editTlBladeTime(e.clientX) : null;
        if (t == null || !this._editTlLay) { ui.bladeLine.style.display = "none"; return; }
        ui.bladeLine.style.display = "block";
        ui.bladeLine.style.left = (t / this._editTlLay.total) * 100 + "%";
    },

    // A click with the blade: the clip is cut where it was clicked.
    _editTlBladeCut(e, sel) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const t = this._editTlBladeTime(e.clientX);
        const got = t == null ? null : D.splitClip(this._editTlCut, sel, t);
        if (!got) { this._editTlSay("not cut: too near the clip's end, inside a dissolve, or the clip loops (take its loop off first)"); return; }
        this._editTlSel = got.sel;
        this._editTlApply(got.cut);
    },

    /** "Detect cuts": the selected clip, or every film on V1. */
    editTlDetectSelected() {
        const sel = this._editTlSel;
        if (sel && (sel.kind === "clip" || sel.kind === "tclip")) return this.editTlDetectCuts([sel]);
        // With an in and out set: the shots between them, and only the cuts there.
        const span = this._editTlRangeSpan();
        const cut = this._editTlCut;
        const shots = span ? D.shotsIn(cut, span[0], span[1]) : (cut ? cut.clips.map((_, i) => i) : []);
        return this.editTlDetectCuts(shots.map((i) => ({ kind: "clip", i })), span);
    },

    /** The in..out in seconds of the film, or null when none is set. */
    _editTlRangeSpan() {
        const r = this._editTlRange ? this._editTlRange() : null;
        return r && this._editTlCut ? D.rangeSeconds(r, this._editTlCut.fps || 24) : null;
    },

    /** Ctrl+B / S: cut what is under the playhead (the selected clip, when it is there). */
    editTlSplitAtPlayhead() {
        if (!this._editTlCut || !this._editTlOnScreen()) {
            this._editTlSay("the cut is not on screen: open its tab to cut at the playhead");
            return;
        }
        // At the START of the frame on screen: that frame is the first of the second half.
        const t = (this.currentFrame || 0) / (this._editTlCut.fps || 24);
        const got = D.splitAt(this._editTlCut, t, this._editTlSel);
        if (!got) { this._editTlSay("nothing to cut at the playhead"); return; }
        this._editTlSel = got.sel;
        this._editTlApply(got.cut);
    },

    /** Del / Shift+Del: take the selection out - leaving a gap, or closing it (ripple). */
    editTlDelete(ripple) {
        const sel = this._editTlSel;
        if (!sel || !this._editTlCut) return false;
        if (sel.kind === "clip" && this._editTlCut.clips.length <= 1) { this._editTlSay("a cut keeps its last shot"); return true; }
        this._editTlSel = null;
        this._editTlApply(ripple ? D.rippleDelete(this._editTlCut, sel) : D.liftClip(this._editTlCut, sel));
        return true;
    },

    // ── the film under it ────────────────────────────────────────────────────

    // Go to a moment of the cut - in its tab, which comes up if another is.
    // `under`: the frame that holds the moment (a scrub); without it the first
    // frame at or after it, which for a shot's start is that shot's first frame.
    _editTlSeek(seconds, under) {
        if (!this._editTlTab || !this.allTabs[this._editTlTab]) return;
        if (!this._editTlOnScreen()) this.switchTab(this._editTlTab);
        if (!this._editTlOnScreen()) return;
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        if (this.isPlaying) this.stop();
        this.setFrame(Math.max(0, under ? Math.floor(seconds * fps + 1e-6) : Math.ceil(seconds * fps - 1e-6)));
    },

    // The line that follows the frame. Called whenever the frame moves
    // (_toolsFrameChanged), so it has to cost nothing while the panel is away.
    _editTlPlayhead() {
        const ui = this._editTlUi;
        const lay = this._editTlLay;
        if (!ui || !ui.body.isConnected || !this._editTlOpen()) return;
        if (!lay || !(lay.total > 0) || !this._editTlOnScreen()) {
            ui.head.style.display = "none";
            return;
        }
        const fps = this._editTlCut.fps || 24;
        const seconds = ((this.currentFrame || 0) + 0.5) / fps;
        ui.head.style.display = "block";
        ui.head.style.left = Math.max(0, Math.min(100, (seconds / lay.total) * 100)) + "%";
        // Zoomed in, the playhead is followed - a screenful at a time - when the
        // FRAME moved (playing, the transport's bar, a key), not when the cut was
        // only redrawn, and not under the ruler being scrubbed.
        const sc = ui.scroll;
        const moved = this._editTlHeadFrame !== this.currentFrame;
        this._editTlHeadFrame = this.currentFrame;
        if (moved && !this._editTlScrubbing && sc.scrollWidth > sc.clientWidth + 1) {
            const x = (seconds / lay.total) * sc.scrollWidth;
            if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 8) sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.1);
        }
        const at = D.pictureAt(this._editTlCut, seconds, this._editTlLive());
        const now = at ? at.key : "";
        if (now === this._editTlNow) return;
        this._editTlNow = now;
        for (const b of ui.rows.querySelectorAll(".edit-shot")) b.classList.toggle("on", !!now && b.dataset.key === now);
    },

    /** Where the playhead is in the film, in seconds (0 when the cut is not on screen). */
    _editTlNowSeconds() {
        if (!this._editTlOnScreen() || !this._editTlCut) return 0;
        return Math.max(0, (this.currentFrame || 0)) / (this._editTlCut.fps || 24);
    },

    // ── new material ─────────────────────────────────────────────────────────

    // How long a file is: the server reads its header (/bepic/timeline_probe,
    // PyAV in its own process - no program is started); where it cannot, the
    // browser reads a video's header for nothing. A still stands for a while.
    async _editTlLength(item) {
        if (item.length > 0) return item.length;
        // A picture stands for a while; a film or a sound says how long it is.
        const e = ext(item.path);
        const timed = item.kind === "video" || item.kind === "audio" || FILM_EXTS.includes(e) || SOUND_EXTS.includes(e);
        if (!timed || STILL_EXTS.includes(e)) return STILL_SECONDS;
        const info = (await this._editTlProbe([item.path]))[item.path];
        if (info && info.duration > 0) return info.duration;
        return this._editTlBrowserLength(item);
    },

    /** What the server knows of files: { path: { duration, audio, video, still } }, asked once per file. */
    async _editTlProbe(paths) {
        if (!this._editTlInfo) this._editTlInfo = new Map();
        const want = [...new Set((paths || []).filter((p) => p && !this._editTlInfo.has(p)))];
        for (let i = 0; i < want.length; i += 100) {
            const part = want.slice(i, i + 100);
            let got = null;
            try {
                const res = await api.fetchApi("/bepic/timeline_probe", {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: part }),
                });
                if (res.ok) got = await res.json();
            } catch (_) {}
            for (const p of part) {
                const info = got && got.info && got.info[p];
                // An error is kept too (not asked again); a failed request is not.
                if (info) this._editTlInfo.set(p, info);
            }
        }
        const out = {};
        for (const p of paths || []) if (this._editTlInfo.has(p)) out[p] = this._editTlInfo.get(p);
        return out;
    },

    /** The lengths of the files of the cut's shots that are known: { file: seconds } (editTimelineData.room). */
    async _editTlDurations(cut) {
        const files = [...new Set(((cut && cut.clips) || []).map((c) => c.file).filter((f) => f && !D.isStill(f)))];
        const info = await this._editTlProbe(files);
        const out = {};
        for (const f of files) if (info[f] && info[f].duration > 0) out[f] = info[f].duration;
        return out;
    },

    _editTlBrowserLength(item) {
        const doc = (this.editTimelinePanel && this.editTimelinePanel.ownerDocument) || document;
        const win = doc.defaultView || window;
        return new Promise((resolve) => {
            const v = doc.createElement("video");
            let done = false;
            const finish = (seconds) => {
                if (done) return;
                done = true;
                win.clearTimeout(timer);
                v.removeAttribute("src");
                try { v.load(); } catch (_) {}
                // 0 = could not be read (a page in the background does not load
                // media at all): the caller says so rather than guess silently.
                resolve(seconds > 0 && Number.isFinite(seconds) ? seconds : 0);
            };
            const timer = win.setTimeout(() => finish(0), 8000);
            v.preload = "metadata";
            v.muted = true;
            v.addEventListener("loadedmetadata", () => finish(v.duration));
            v.addEventListener("error", () => finish(0));
            v.src = this.buildImgUrl(item, { noColor: true });
        });
    },

    /** What a file is to a cut: "film", "still", "sound" - or "" for nothing a cut can hold. */
    _editTlKindOf(it) {
        const e = ext(it.path || it.name || it.filename);
        if (SOUND_EXTS.includes(e) || it.kind === "audio") return "sound";
        if (FILM_EXTS.includes(e) || it.kind === "video") return "film";
        if (STILL_EXTS.includes(e) || it.kind === "image" || (!it.kind && /\.(gif|bmp|avif)$/i.test(e))) return "still";
        return "";
    },

    /** Files dropped from the desktop, as items to add (copied into input/edits by _editTlResolve). */
    _editTlOsItems(files) {
        return Array.from(files || []).map((f) => {
            const type = String(f.type || "");
            const kind = type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "video"
                : type.startsWith("image/") ? "image" : "";
            return { blob: f, name: f.name, kind };
        });
    },

    // Pictures dragged out of ComfyUI's queue / assets list arrive as links to
    // its /view, which names the file as ComfyUI does: filename, type, subfolder.
    _editTlUriItems(dt) {
        let text = "";
        try { text = dt.getData("text/uri-list") || ""; } catch (_) {}
        const out = [];
        for (const line of text.split(/\r?\n/)) {
            const s = line.trim();
            if (!s || s.startsWith("#")) continue;
            let u = null;
            try { u = new URL(s, window.location.href); } catch (_) { continue; }
            const name = u.searchParams.get("filename");
            if (!/\/view$/.test(u.pathname) || !name) continue;
            out.push({ filename: name, type: u.searchParams.get("type") || "output",
                       subfolder: u.searchParams.get("subfolder") || "", name });
        }
        return out;
    },

    /**
     * Every item named by a path a cut can hold. A file from the desktop (or one
     * dropped into the viewer earlier, which is only in the browser) is copied
     * into input/edits (/bepic/timeline_upload); one named the way ComfyUI names
     * its outputs is found (/bepic/timeline_locate). Returns { items, lost }.
     */
    async _editTlResolve(items) {
        const out = [];
        let lost = 0;
        const find = [];
        const blobs = items.filter((it) => !it.path && (it.blob || (it.url && /^blob:/.test(it.url))));
        if (blobs.length) this._editTlSay(`copying ${blobs.length} file${blobs.length === 1 ? "" : "s"} into input/edits…`);
        for (const it of items) {
            if (it.path) { out.push(it); continue; }
            if (it.blob || (it.url && /^blob:/.test(it.url))) {
                let blob = it.blob || null;
                try {
                    if (!blob) { const r = await fetch(it.url); blob = r.ok ? await r.blob() : null; }
                } catch (_) { blob = null; }
                const name = it.name || it.filename || "clip";
                const kept = blob ? await this._editTlUpload(blob, name) : null;
                if (kept) out.push({ ...it, blob: undefined, url: undefined, path: kept.path, name });
                else lost += 1;
                continue;
            }
            if (it.filename) { find.push(it); out.push(it); continue; }
            lost += 1;
        }
        if (find.length) {
            let paths = [];
            try {
                const res = await api.fetchApi("/bepic/timeline_locate", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ items: find.map((it) => ({ filename: it.filename, type: it.type, subfolder: it.subfolder })) }),
                });
                if (res.ok) paths = (await res.json()).paths || [];
            } catch (_) {}
            find.forEach((it, k) => { it.path = paths[k] || ""; });
        }
        const kept = out.filter((it) => it.path);
        return { items: kept, lost: lost + (out.length - kept.length) };
    },

    async _editTlUpload(blob, name) {
        const form = new FormData();
        form.append("file", blob, name);
        try {
            const res = await api.fetchApi("/bepic/timeline_upload", { method: "POST", body: form });
            return res.ok ? await res.json() : null;
        } catch (_) { return null; }
    },

    /**
     * Put files into the cut where they were dropped. A film or a picture
     * dropped on the cut itself (V1) goes between the shots there (`at`
     * seconds; the end without it); on a video track it is placed at `at`, one
     * after the other. Sound goes onto a sound track - the one it was dropped
     * on, else the first there is, else a new one - placed at `at`. A sound
     * track also takes films, for their sound.
     */
    async _editTlAdd(items, at, track) {
        if (!this._editTlTab) this.editTlNew(true);            // no cut open: the clips start one
        const given = (items || []).filter(Boolean);
        if (!given.length) return;
        const { items: named, lost } = await this._editTlResolve(given);
        const onto = track ? D.trackOf(this._editTlCut, track) : null;
        const plan = [];
        let skipped = lost;
        for (const it of named) {
            const kind = this._editTlKindOf(it);
            if (!kind || it.isSequence) { skipped += 1; continue; }
            if (onto && onto.kind === "audio") {
                if (kind === "still") { skipped += 1; continue; }
                plan.push({ it, kind, where: "sound" });
            } else if (kind === "sound") plan.push({ it, kind, where: "sound" });
            else plan.push({ it, kind, where: onto ? "track" : "V1" });
        }
        if (!plan.length) {
            this._editTlNote = skipped ? "only single films, pictures and sounds with a file can go into a cut" : "";
            this.editTlRefresh();
            return;
        }
        await this._editTlProbe(plan.map((p) => p.it.path));
        let cut = this._editTlCut || D.emptyCut();
        const fps = cut.fps || 24;
        let index = at == null || !cut.clips.length ? cut.clips.length : D.dropIndex(cut, at);
        const start = D.toFrame(at == null ? this._editTlNowSeconds() : at, fps);
        let moment = start, soundMoment = start;
        let soundId = onto && onto.kind === "audio" ? onto.id : "";
        let unread = 0, sel = null;
        for (const { it, where } of plan) {
            let length = await this._editTlLength(it);
            if (!(length > 0)) { unread += 1; length = STILL_SECONDS; }
            const name = String(it.name || it.filename || it.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
            const clip = { file: it.path, name, length: D.toFrame(length, fps), color: it.color || "" };
            if (where === "sound") {
                if (!soundId) {
                    const first = (cut.tracks || []).find((k) => k.kind === "audio");
                    if (!first) cut = D.addTrack(cut, "audio");
                    soundId = (first || cut.tracks[cut.tracks.length - 1]).id;
                }
                cut = D.placeClip(cut, soundId, clip, soundMoment);
                soundMoment = D.toFrame(soundMoment + clip.length, fps);
                sel = { kind: "tclip", track: soundId, i: D.trackOf(cut, soundId).clips.length - 1 };
            } else if (where === "track") {
                cut = D.placeClip(cut, onto.id, clip, moment);
                moment = D.toFrame(moment + clip.length, fps);
                sel = { kind: "tclip", track: onto.id, i: D.trackOf(cut, onto.id).clips.length - 1 };
            } else {
                cut = D.insertClip(cut, clip, index);
                sel = { kind: "clip", i: index };
                index += 1;
            }
        }
        this._editTlSel = sel;
        this._editTlNote = [
            skipped ? `${skipped} item(s) left out` : "",
            unread ? `the length of ${unread} clip(s) could not be read - set it in the Inspector` : "",
        ].filter(Boolean).join(" · ");
        this._editTlRecord(this._editTlCut, cut);
        this._editTlCut = cut;
        this.editTlRefresh();
    },

    async _editTlAddNodes(nodes, at, track) {
        const items = [];
        for (const node of nodes || []) {
            try { items.push(...await nodeMediaClips(node)); } catch (_) {}
        }
        if (!items.length) {
            this._editTlNote = "that node holds no file to cut (a loader, a saved result or a path does)";
            this.editTlRefresh();
            return;
        }
        await this._editTlAdd(items, at, track);
    },

    _editTlAddSelected() { return this._editTlAddNodes(selectedNodes(), null); },

    /** Add: files from disk, or what the canvas has selected. */
    _editTlAddMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const a = anchor.getBoundingClientRect();
        const cut = this._editTlTab ? this._editTlCut : null;
        const entries = [
            { label: "Files\u2026", run: () => this._editTlAddFiles() },
            { label: "Selected canvas nodes", run: () => this._editTlAddSelected() },
        ];
        // Onto a track of its own: placed at the playhead.
        for (const k of (cut && cut.tracks) || []) {
            entries.push({ label: `Files onto ${k.name}\u2026`, run: () => this._editTlAddFiles(k.id) });
        }
        entries.push("-",
            { label: "New video track", disabled: !cut, run: () => this._editTlApply(D.addTrack(this._editTlCut, "video")) },
            { label: "New sound track", disabled: !cut, run: () => this._editTlApply(D.addTrack(this._editTlCut, "audio")) });
        this._previzOpenMenu(entries, a.left, a.bottom + 2, anchor);
    },

    /** Out: keep the cut, or make the film of it. */
    _editTlOutMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const dirty = this._editTlDirty();
        const a = anchor.getBoundingClientRect();
        this._previzOpenMenu([
            { label: "Save cut", disabled: !dirty, run: () => this._editTlSave() },
            { label: "Revert to saved", disabled: !dirty || !this._editTlSaved, run: () => this._editTlRevert() },
            "-",
            { label: "Export film\u2026", run: () => this._editTlRender() },
        ], a.left, a.bottom + 2, anchor);
    },

    async _editTlAddFiles(track) {
        const onto = track ? D.trackOf(this._editTlCut, track) : null;
        const sound = !!onto && onto.kind === "audio";
        await openFilePicker(this.container, {
            id: sound ? "sound" : "clip",
            title: onto ? `Add to ${onto.name}` : "Add clips",
            kind: "video",
            exts: sound ? [...SOUND_EXTS, ...FILM_EXTS] : [...FILM_EXTS, ...STILL_EXTS],
            multiple: true,
            go: "Add",
            note: (onto ? "Placed at the playhead, one after the other." : "Added at the end of the cut.")
                + " Ctrl-click picks more than one.",
            onPick: async (files) => {
                await this._editTlAdd(files.map((f) => ({ path: f.path, name: f.name, kind: f.kind })),
                                      onto ? this._editTlNowSeconds() : null, track);
                return { ok: true };
            },
        });
    },

    // A node dragged off the canvas and let go over the panel is a clip. The
    // canvas keeps the pointer for the whole drag, so the panel never sees it:
    // the page is watched instead, and the node is put back where it was picked
    // up - it was being pointed with, not moved.
    _editTlWatchCanvas() {
        if (this._editTlCanvasBound) return;
        const canvasEl = app.canvas && app.canvas.canvas;
        const page = canvasEl && canvasEl.ownerDocument;
        if (!page) return;
        this._editTlCanvasBound = true;
        let held = null;
        page.addEventListener("pointerdown", (e) => {
            held = null;
            if (e.button !== 0 || e.target !== canvasEl || !this._editTlOpen()) return;
            const over = app.canvas.node_over;
            if (!over) return;
            const picked = Object.values(app.canvas.selected_nodes || {});
            const nodes = picked.includes(over) ? picked : [over];
            held = { x: e.clientX, y: e.clientY, nodes, pos: nodes.map((n) => [n.pos[0], n.pos[1]]) };
        }, true);
        page.addEventListener("pointerup", (e) => {
            const was = held;
            held = null;
            if (!was || Math.hypot(e.clientX - was.x, e.clientY - was.y) < 12) return;
            const host = this.editTimelinePanel;
            // Only a panel on the canvas's own page can be dropped onto.
            if (!host || host.ownerDocument !== page || !this._editTlOpen()) return;
            const box = host.getBoundingClientRect();
            if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) return;
            const raw = this._editTlTimeAt(e.clientX);
            const at = raw == null ? null : this._editTlSnap(raw);
            // The track under the release, as for any other drop.
            const root = host.getRootNode();
            const hit = root && root.elementFromPoint ? root.elementFromPoint(e.clientX, e.clientY) : null;
            const row = hit && hit.closest ? hit.closest(".edit-track") : null;
            const track = row ? row.dataset.track : "";
            // After the canvas has finished its own handling of the release.
            (page.defaultView || window).setTimeout(() => {
                was.nodes.forEach((n, i) => { n.pos[0] = was.pos[i][0]; n.pos[1] = was.pos[i][1]; });
                if (app.graph && app.graph.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
                this._editTlAddNodes(was.nodes, at, track === "V1" || track === "T" || track === "A1" ? "" : track);
            }, 0);
        }, true);
    },

    // ── saving ───────────────────────────────────────────────────────────────

    async _editTlSave() {
        const cut = this._editTlCut;
        if (!cut || !this._editTlDirty()) return;
        const creating = !this._editTlSaved;
        const body = creating ? { new: true, name: cut.name || "cut", context: canvasContext(), edit: D.toSave(cut) }
                              : { ...this._editTlTarget, edit: D.toSave(cut) };
        let data = null, said = "";
        try {
            const res = await api.fetchApi("/bepic/timeline", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            if (res.ok) data = await res.json(); else said = await res.text();
        } catch (e) { said = String(e && e.message || e); }
        if (!data || !data.edit) {
            this._editTlNote = said || "not saved";
            this.editTlRefresh();
            return;
        }
        if (data.target) this._editTlTarget = data.target;
        this._editTlLoaded(data);
        this._editTlNote = creating ? "saved as " + (data.file || "a new timeline") : "saved";
        this.editTlRefresh();
    },

    // Export the cut as a film, rendered in the viewer. What is rendered is the
    // SAVED cut, so unsaved changes are saved first. The dialog is the one every
    // export uses (bEpicViewer_exportUI.js): name, format, codec, quality, and
    // where it will land, by the rule all exports follow.
    async _editTlRender() {
        if (this._editTlBusy) return;
        if (!this._editTlCut || !this._editTlCut.clips.length) {
            notice("info", "Nothing to export", "This cut has no clips yet.");
            return;
        }
        if (this._editTlDirty()) {
            await this._editTlSave();
            if (this._editTlDirty()) return;             // the save said why
        }
        if (!this._editTlTarget) return;
        await openExportDialog(this.container, {
            title: "Export film",
            kind: "video",
            name: this._editTlCut.name || String(this._editTlFile || "cut").replace(/\.otio$/i, ""),
            formats: ["mp4", "mov"],
            values: this._editTlExport,
            go: "Render",
            // With an in and out set: the whole film, or only what lies between them.
            rows: (make) => {
                const r = this._editTlRange ? this._editTlRange() : null;
                if (!r) { this._editTlExportRange = false; return []; }
                const fps = this._editTlCut.fps || 24;
                const what = make.select([["all", "Whole film"],
                    ["range", `In\u2013out only (${D.timecode(r.start / fps, fps)} \u2013 ${D.timecode((r.end + 1) / fps, fps)}, ${r.end - r.start + 1} frames)`]],
                    this._editTlExportRange === false ? "all" : "range");
                this._editTlExportRange = what.value === "range";
                what.dataset.field = "range";
                what.addEventListener("change", () => { this._editTlExportRange = what.value === "range"; });
                return [make.row("Export", what)];
            },
            note: "A film of its own, as the next version; an earlier one is never written over.",
            onExport: (values, ui) => this._editTlExportRun(values, ui),
        });
    },

    async _editTlExportRun(values, ui) {
        this._editTlExport = { format: values.format, codec: values.codec, quality: values.quality };
        this._editTlBusy = true;
        this.editTlRefresh();
        ui.progress(0, 1, "Rendering…");
        const range = this._editTlExportRange && this._editTlRange ? this._editTlRange() : null;
        let got = null, said = "";
        try {
            const res = await api.fetchApi("/bepic/timeline_render", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...this._editTlTarget, name: values.name, format: values.format,
                                       codec: values.codec, quality: values.quality, context: values.context,
                                       ...(range ? { frames: [range.start, range.end] } : {}) }),
            });
            if (res.ok) got = await res.json(); else said = await res.text();
        } catch (e) { said = String(e && e.message || e); }
        this._editTlBusy = false;
        if (!got || !got.path) {
            this.editTlRefresh();
            return { ok: false, error: true, message: said || "Nothing was rendered." };
        }
        const left = got.texts_left_out;
        this._editTlNote = "exported as " + got.name;
        this.editTlRefresh();
        notice("success", "Film exported" + (left ? ` - without its ${left} text${left === 1 ? "" : "s"}` : ""),
               "output/" + (got.relative || got.name));
        // Up on screen, in a tab of its own, beside the cut it was made from.
        if (this.openExternalFramesInViewer) {
            this.openExternalFramesInViewer(
                [{ path: got.path, name: got.name, external: true, kind: "video", fps: got.fps, frames: got.frames }],
                got.name);
        }
        return { ok: true };
    },

    _editTlRevert() {
        if (!this._editTlSaved) return;
        this._editTlRecord(this._editTlCut, this._editTlSaved);
        this._editTlCut = this._editTlSaved;
        this._editTlSel = null;
        this._editTlNote = "";
        this.editTlRefresh();
    },
};
