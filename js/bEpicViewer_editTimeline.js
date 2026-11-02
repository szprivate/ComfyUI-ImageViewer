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
//                           nodes, a new track) · Save / Export. Add's files and canvas
//                           nodes are an INSERT at the playhead (a shot there split, what
//                           follows moved on, the playhead then at their end; nodes left
//                           to right as they stand on the canvas; on the selected clip's
//                           video track, else V1)
//   − + Fit, top right      zoom the timeline about the PLAYHEAD (it keeps its x; out of view, it is centred);
//                           so do Ctrl+= / Ctrl+- and Shift+Z (fit). Ctrl + wheel zooms about the pointer, as Resolve's.
//   the speaker, the wave   audio playback on / off (Ctrl+Shift+M: all of the cut's sound, playing and
//                           scrubbing) and audio scrubbing on / off (Shift+M) - bEpicViewer_editAudio.js
//                           Below Fit (down to 0.25x) empty timeline lies after the film, to move or drop clips onto.
//                           The wheel alone, or the middle button dragged, pans it
//   a track's header        its switch (off: not seen, not heard, not rendered),
//                           S to solo it (only the soloed are played; a way of
//                           looking, not saved), its lower edge to make it taller
//   drag on the ruler       scrub the film (heard, pitched with the speed); Ctrl+drag / right-click: the in and out
//   the playhead's line     grabbed anywhere down the tracks (within 4 px; ew-resize): a scrub too. Over a
//                           clip the line comes first, unless an edit point lies exactly under it
//   click a clip            select it and go to it; right-click: its colour, remove, Recreate
//                           with changes… (agentY), its takes; Ctrl+click / Shift+click: several
//                           selected, on any tracks (bEpicViewer_editTakes.js); a drag from an
//                           empty place: a selection rectangle (Shift adds)
//   click a clip's edge     selects that edit point in every mode, green on what will move:
//                           , / . trim it, Shift+A / Shift+S go from edit to edit
//   the modes               A Selection (the default), T Trim Edit, B the blade -
//                           buttons in the bar too, the one that is on lit
//   drag a shot's edge      Selection: trim that edge only (a gap opens or is
//                           filled, nothing else moves); Trim: a ripple trim. The
//                           middle of a cut rolls it; Alt: slip / retime,
//                           Alt+Shift: slide, Ctrl on the out-edge: loop; in the
//                           Trim mode the body's upper half slips, its lower half
//                           slides (bEpicViewer_editTrim.js)
//   drag a shot             Selection: to another moment - it lies over what is
//                           there and leaves a gap (V1 holds gaps); Ctrl+Shift+drag:
//                           into the order (an insert, what follows moves) - or
//                           onto another track (the clips after it stay), or above the top
//                           video / below the bottom sound track: a new track
//   a gap on V1             click it to select it; Del / Shift+Del closes it
//   Ctrl+Alt+L / right-click  Unlink a film's sound onto a sound track (A2 or the
//                           next free one), or Link a picture and its sound again
//   snapping (N, the magnet)  every drag snaps to clip and gap edges on all tracks,
//                           the playhead, the in / out, the texts, the start (and,
//                           its own switch, the music's beats); hold S while
//                           dragging to snap the other way for that drag
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
import { setEditIcon } from "./bEpicViewer_editIcons.js";
import { canvasContext, exportTarget, notice, openExportDialog, openFilePicker } from "./bEpicViewer_exportUI.js";

const DOCK_ID = "editTimeline";
const EDGE_PX = 7;          // how close to a block's end a press is a trim
const HEAD_PX = 4;          // how close to the playhead's line, over the tracks, a press grabs it
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
        // The texts of an older cut (or of one kept from before) are titles now: clips on video tracks.
        this._editTlCut = D.textsToTitles(s.cut) || D.emptyCut(label || "cut");
        this._editTlSaved = s.saved ? D.textsToTitles(s.saved) : null;
        this._editTlTarget = s.target || null;
        this._editTlFile = s.file || "";
        this._editTlOtio = s.otio || "";
        // How this cut is looked at: zoom, the tracks' heights, what is soloed.
        const view = (s.view && typeof s.view === "object") ? s.view : {};
        const range = view.range && Number.isFinite(view.range.start) && Number.isFinite(view.range.end) ? { start: view.range.start, end: view.range.end } : null;
        this._editTlView = { zoom: D.clampZoom(view.zoom), end: Number(view.end) || 0, heights: { ...(view.heights || {}) },
                             solo: { ...(view.solo || {}) }, textsOff: !!view.textsOff, range,
                             // Snapping: on unless switched off (N); the beats of the music its own switch, off.
                             snap: view.snap !== false, snapBeats: !!view.snapBeats };
        this._editTlSel = null;
        this._editTlEditSel = null;
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
        const savedBar = el("div", "edit-saved");
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
        // The modes, as Resolve's: Selection (A), Trim Edit (T), the blade (B). The lit one is on.
        const pick = button("", "Selection mode (A): drag a clip to move it, an edge to trim that edge only - "
                            + "nothing else moves (gaps stay)", () => this.editTlMode("select"));
        pick.classList.add("edit-tool");
        setEditIcon(pick, "select");
        const trimBtn = button("", "Trim Edit mode (T): an edge ripples, the middle of a cut rolls, the upper half "
                               + "of a clip slips, the lower half slides", () => this.editTlMode("trim"));
        trimBtn.classList.add("edit-tool");
        setEditIcon(trimBtn, "trim");
        const blade = button("", "Blade (B): click a clip to cut it there. Ctrl+B or S cuts at the playhead",
                             () => this.editTlBladeToggle());
        blade.classList.add("edit-blade-btn", "edit-tool");
        setEditIcon(blade, "blade");
        const snap = button("", "Snapping (N): drags snap to clip and gap edges, the playhead, the in / out and the texts. "
                            + "Hold S while dragging to snap the other way", () => this.editTlSnapToggle());
        setEditIcon(snap, "snap");
        snap.classList.add("edit-snap-btn");
        const beats = button("", "Snap to the beats of the music too (once Auto edit has read them)", () => this.editTlSnapToggle("beats"));
        beats.classList.add("edit-snapbeat-btn");
        setEditIcon(beats, "beats");
        const split = button("", "Split: cut the clip under the playhead (Ctrl+B, S)", () => this.editTlSplitAtPlayhead());
        setEditIcon(split, "split");
        const undo = button("\u21b6", "Undo (Ctrl+Z)", () => this.editTlUndo());
        const redo = button("\u21b7", "Redo (Ctrl+Shift+Z)", () => this.editTlRedo());
        const auto = button("Auto edit\u2026", "Cut on the beat, an even rhythm, a reference's rhythm, the best part "
                            + "of each shot - or ask agentY", () => this.editTlAutoDialog && this.editTlAutoDialog());
        const cuts = button("Detect cuts", "Scene cut detection: where the selected film - or every film on V1 - "
                            + "changes shot; shown as marks first, then split", () => this.editTlDetectSelected());
        const take = button("", "", () => this.editTlTakeAnswer && this.editTlTakeAnswer());
        take.classList.add("primary", "edit-take");
        take.style.display = "none";
        const zoomOut = button("", "Zoom out, past the end of the film too (Ctrl+- or Ctrl + wheel)", () => this._editTlZoom(this._editTlView.zoom / 1.5));
        const zoomIn = button("", "Zoom in (Ctrl+= or Ctrl + wheel)", () => this._editTlZoom(this._editTlView.zoom * 1.5));
        const zoomFit = button("", "Zoom to fit: the whole film across the width (Shift+Z)", () => this._editTlZoom(1));
        setEditIcon(zoomOut, "zoomOut");
        setEditIcon(zoomIn, "zoomIn");
        setEditIcon(zoomFit, "fit");
        // Sound, as Resolve's two switches: audio playback (all of it, playing and scrubbing) and audio scrubbing.
        const audio = button("", "Audio playback on / off (Ctrl+Shift+M)", () => this.editAudioToggle("play"));
        audio.classList.add("edit-audio-btn");
        setEditIcon(audio, "volume");
        const scrubAudio = button("", "Audio scrubbing on / off (Shift+M)", () => this.editAudioToggle("scrub"));
        scrubAudio.classList.add("edit-scrubaudio-btn");
        setEditIcon(scrubAudio, "scrub");
        bar.append(fresh, add, out, pick, trimBtn, blade, snap, beats, split, undo, redo, auto, cuts, take, sub, badge,
                   audio, scrubAudio, zoomOut, zoomIn, zoomFit);

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
        body.append(bar, savedBar, main, hint, empty);
        host.append(body);
        // The keys of the timeline (bEpicViewer_editKeys.js) act only while it
        // has the focus: a press anywhere in it takes it - but not from a field
        // that is being typed into.
        body.tabIndex = 0;
        body.addEventListener("pointerdown", (e) => {
            const t = e.composedPath ? e.composedPath()[0] : e.target;
            // A press anywhere but on a keyframe mark lets go of the selected keyframe.
            if (this._editTlKeySel && !(t && t.classList && t.classList.contains("edit-keymark"))) this._editTlKeySel = null;
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
            this._editTlScrubDrag(e, ruler);
        });
        // The playhead's line is grabbed anywhere down the tracks too (within HEAD_PX of it):
        // over a clip the line comes first - unless an edit point lies exactly under it (_editTlHeadHit).
        rows.addEventListener("pointermove", (e) => this._editTlHeadHover(e), true);
        rows.addEventListener("pointerleave", () => this._editTlHeadHover(null));
        rows.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || !this._editTlHeadHit(e)) return;
            e.stopPropagation();
            this._editTlHoverEnd?.();
            this._editTlScrubDrag(e, rows);
        }, true);
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
        // A press where nothing lies: a selection rectangle, if it is dragged; a click takes the selection off.
        scroll.addEventListener("pointerdown", (e) => this._editTlMarqueeDown(e));

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
            const room = what === "effect" ? "" : this._editTlRoomAt(e.clientY);
            this._editTlDropMark(e.clientX, what === "effect" ? "free" : room ? "new:" + room : rowOf(e), true);
        });
        body.addEventListener("dragleave", (e) => {
            if (!e.relatedTarget || !body.contains(e.relatedTarget)) { this._editTlDropMark(null); this._editTlSnapLine(null); }
        });
        body.addEventListener("drop", (e) => {
            const what = carries(e);
            if (!what) return;
            e.preventDefault();
            e.stopPropagation();
            const raw = this._editTlTimeAt(e.clientX);
            const track = rowOf(e);
            const room = what === "effect" ? "" : this._editTlRoomAt(e.clientY);
            const at = raw == null ? null : this._editTlSnap(raw, track);
            this._editTlDropMark(null);
            this._editTlSnapLine(null);
            if (what === "os") { this._editTlAdd(this._editTlOsItems(e.dataTransfer.files), at, track, room); return; }
            if (what === "uri") { this._editTlAdd(this._editTlUriItems(e.dataTransfer), at, track, room); return; }
            let payload = null;
            try { payload = JSON.parse(e.dataTransfer.getData(what === "effect" ? EFFECT_TYPE : DRAG_TYPE)); } catch (_) {}
            if (what === "effect") { if (payload && this.editFxApply) this.editFxApply(payload, at, track); return; }
            this._editTlAdd((payload && payload.items) || [], at, track, room);
        });
        this._editTlUi = { host, savedBar, empty, body, sub, badge, out, main, heads, scroll, area, ruler, rows,
                           head, drop, hint, blade, split, undo, redo, auto, cuts, take, pick, trimBtn, snap, beats, zoomOut, zoomIn, zoomFit,
                           audio, scrubAudio };
        this._editTlWatchCanvas();
        return this._editTlUi;
    },

    _editTlCarries(e, type = DRAG_TYPE) {
        try { return Array.from(e.dataTransfer?.types || []).includes(type); } catch (_) { return false; }
    },

    /** Draw the Edit panels from the cut as it stands. The one place they are drawn. */
    editTlRefresh() {
        D.stampIds(this._editTlCut);
        if (this.barGroupsSync) this.barGroupsSync();
        // With no cut in the panel, an Edit tab that is open takes its place.
        if (!this._editTlTab) {
            const first = this._editTlTabs()[0];
            if (first) this.editTlUse(first);
        }
        // The viewport plays the cut: a change is on screen with this redraw.
        if (this.editPlayCutChanged) this.editPlayCutChanged();
        if (this.editTwoUpRest) this.editTwoUpRest();            // the cut, the track or the tab may have changed under a resting playhead
        if (this._editTlTab) this._editTlKeep();
        if (this._editTlTab && this._editTlKnowFiles) this._editTlKnowFiles(this._editTlCut);
        // The numbers of what is selected, and what can be put into the cut.
        if (this.editPanelsRefresh) this.editPanelsRefresh();
        const host = this.editTimelinePanel;
        if (!host || !this._editTlOpen()) return;
        const ui = this._editTlBuild(host);
        const cut = this._editTlTab ? this._editTlCut : null;
        // The scale. A drag holds the seconds per pixel it began with, whatever it does to the film's length
        // (a timeline scaled to the film would slide under the pointer); else an edit keeps them too, Fit staying Fit.
        const lock = this._editTlLock;
        let span = 0, wide = 100;
        if (cut) {
            const end = D.contentEnd(cut);
            if (lock) {
                span = Math.max(lock.span, end);
                wide = lock.wide * span / lock.span;
            } else {
                const v = this._editTlView;
                if (end > 0) { v.zoom = D.keepScale(v.zoom, v.end, end); v.end = end; }
                span = D.viewSpan(end, v.zoom);
                wide = D.areaPercent(v.zoom);
            }
        }
        const lay = cut ? D.layoutCut(cut, this._editTlView.zoom, span) : null;
        const has = !!(lay && lay.total > 0);
        const busy = !!this._editTlBusy;
        const dirty = this._editTlDirty();
        for (const part of [ui.main, ui.hint]) part.style.display = has ? "" : "none";
        ui.empty.style.display = has ? "none" : "block";
        ui.empty.textContent = cut
            ? "This cut is empty. Add clips with the plus button, or drop them here - from the desktop, the file "
              + "browser, the History, ComfyUI's queue, or a node dragged off the canvas."
            : "No cut is open. New starts one; so does adding or dropping clips here.";
        ui.out.disabled = busy;          // Open cut... is there with nothing open too
        const hist = this._editTlHistory();
        ui.undo.disabled = !cut || !hist.past.length;
        ui.redo.disabled = !cut || !hist.future.length;
        ui.split.disabled = ui.auto.disabled = ui.cuts.disabled = !has;
        ui.blade.classList.toggle("on", !!this._editTlBlade);
        ui.pick.classList.toggle("on", !this._editTlBlade && !this._editTlTrimMode);
        ui.trimBtn.classList.toggle("on", !this._editTlBlade && !!this._editTlTrimMode);
        ui.body.classList.toggle("blade", !!this._editTlBlade && has);
        ui.body.classList.toggle("trim", !this._editTlBlade && !!this._editTlTrimMode && has);
        const snapOn = !this._editTlView || this._editTlView.snap !== false;
        ui.snap.classList.toggle("on", snapOn);
        ui.snap.setAttribute("aria-pressed", snapOn ? "true" : "false");
        ui.beats.classList.toggle("on", !!(this._editTlView && this._editTlView.snapBeats));
        ui.beats.disabled = !snapOn;
        if (this._editAudioButtons) this._editAudioButtons(ui);
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
        ui.savedBar.dataset.file = this.editTlFilePath();
        ui.sub.textContent = `${cut.name || this._editTlFile || "new cut"} \u00b7 ${n} shot${n === 1 ? "" : "s"} \u00b7 `
            + D.lengthLabel(lay.film) + (this._editTlNote ? " \u00b7 " + this._editTlNote : "");
        ui.hint.textContent = this._editTlBlade
            ? "Blade: click a clip to cut it there (A, or B or Esc, to put it away). Ctrl+Z undoes."
            : this._editTlTrimMode
            ? "Trim Edit (T): an edge ripples (what follows moves), the middle of a cut rolls, a clip's upper half slips, "
              + "its lower half slides. Click a cut: , / . trim it, rippling. Shift+A / Shift+S: edit to edit. A: back to Selection."
            : "Drag a clip to move it (it leaves a gap; Ctrl+Shift+drag inserts; above the top track: a new one), an edge to trim. Click a cut: "
              + ", / . trim it; on a clip they move it (Alt: slip). Drag from an empty place: select. Del lifts, Shift+Del ripples. T: Trim, N: snap. All the keys: Show Hotkeys.";
        ui.hint.title = ui.hint.textContent;
        ui.area.style.width = wide + "%";

        const doc = host.ownerDocument;
        const sel = this._editTlSel;
        const picked = (kind, i, track) => !!sel && sel.kind === kind && sel.i === i && (kind !== "tclip" || sel.track === track);
        // Several selected are outlined (.msel) as well as the one the panel works on (.sel).
        const several = this._editTlSelAll();
        const also = (kind, i, track) => (this._editTlInMulti(several, kind, i, track) ? " msel" : "");
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
        // The empty room above the top video track and below the bottom sound track: a clip let go there gets a new track.
        const room = (kind) => {
            const z = doc.createElement("div");
            z.className = "edit-room";
            z.dataset.room = kind;
            z.dataset.label = "+ " + D.nextTrackId(cut, kind);
            z.title = kind === "audio" ? "Drop a sound here: a new sound track" : "Drop a clip here: a new video track";
            rowEls.push(z);
            headEls.push(Object.assign(doc.createElement("div"), { className: "edit-headrow edit-headroom" }));
        };
        let roomed = false;
        for (const row of list) {
            if (!roomed && row.kind === "video") { room("video"); roomed = true; }
            const height = Math.max(12, Math.min(160, Number(view.heights[row.id]) || ROW_HEIGHT[row.kind]));
            const dead = row.id === "T" ? !!(cut.off && cut.off.T) : !live.has(row.id);
            const tr = doc.createElement("div");
            tr.className = `edit-track edit-k-${row.kind}` + (dead ? " dead" : "");
            tr.dataset.track = row.id;
            tr.style.height = height + "px";
            const kids = [];
            if (row.id === "T") {
                for (const x of lay.texts) {
                    const b = block("edit-text" + (picked("text", x.i) ? " sel" : "") + also("text", x.i) + (x.late ? " late" : ""), x, x.name);
                    b.dataset.key = "T:" + x.i;
                    b.addEventListener("pointerdown", (e) => this._editTlTextDown(e, b, x.i));
                    b.addEventListener("pointermove", (e) => this._editTlEdgeCursor(e, b));
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "text", i: x.i }));
                    kids.push(b);
                }
            } else if (row.id === "V1") {
                for (const s of lay.shots) {
                    const b = block("edit-shot" + (picked("clip", s.i) ? " sel" : "") + also("clip", s.i)
                        + (Number.isInteger(cut.clips[s.i].ref) ? "" : " new") + (cut.clips[s.i].disabled ? " disabled" : ""), s, s.name);
                    b.dataset.key = "V1:" + s.i;
                    b._media = { file: cut.clips[s.i].file, in: Number(cut.clips[s.i].in) || 0, length: s.length,
                                 row: "video", volume: cut.clips[s.i].volume, clip: cut.clips[s.i] };
                    this._editTlBadges(b, cut.clips[s.i]);
                    if (picked("clip", s.i) && this._editTlKeyMarks) this._editTlKeyMarks(b, { kind: "clip", i: s.i }, cut.clips[s.i]);
                    this._editTlTakeBadge(b, cut.clips[s.i]);
                    this._editTlLinkBadge(b, cut.clips[s.i], "video");
                    b.addEventListener("pointerdown", (e) => this._editTlShotDown(e, b, s.i));
                    b.addEventListener("pointermove", (e) => this._editTlHover(e, b, { kind: "clip", i: s.i }));
                    b.addEventListener("pointerleave", () => this._editTlHoverEnd());
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "clip", i: s.i }));
                    kids.push(b);
                }
                // A gap: empty time - black, or what a higher track shows. Clicked, it is selected (Del closes it).
                for (const g of lay.gaps || []) {
                    const b = block("edit-gap" + (picked("gap", g.i) ? " sel" : "") + also("gap", g.i), g, "");
                    b.dataset.key = "gap:" + g.i;
                    b.addEventListener("pointerdown", (e) => {
                        if (e.button !== 0 || this._editTlBlade) return;
                        e.stopPropagation();
                        if (this._editTlMultiDown(e, b, { kind: "gap", i: g.i })) return;
                        this._editTlSel = { kind: "gap", i: g.i };
                        this._editTlEditSel = null;
                        this.editTlRefresh();
                    });
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "gap", i: g.i }));
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
                    const b = block("edit-snd" + (picked("sound", k) ? " sel" : "") + also("sound", k), s, s.name);
                    b.dataset.bed = String(k);
                    b._media = { file: cut.sound[k].file, in: 0, length: lay.film, row: "audio", volume: 1 };
                    b.addEventListener("pointerdown", (e) => this._editTlBedDown(e, b, k));
                    b.addEventListener("contextmenu", (e) => this._editTlClipMenu(e, { kind: "sound", i: k }));
                    kids.push(b);
                }
            } else {
                for (const c of row.track.items) {
                    const tclip = D.trackOf(cut, row.id).clips[c.i];
                    const b = block((row.kind === "audio" ? "edit-shot edit-sclip" : "edit-shot edit-tclip")
                        + (picked("tclip", c.i, row.id) ? " sel" : "") + also("tclip", c.i, row.id) + (tclip && tclip.disabled ? " disabled" : "")
                        + (tclip && tclip.title ? " edit-titleclip" : ""), c, c.name);
                    b.dataset.key = row.id + ":" + c.i;
                    const tc = row.track.items[c.i] && D.trackOf(cut, row.id).clips[c.i];
                    b._media = { file: tc.file, in: Number(tc.in) || 0, length: c.length, row: row.kind, volume: tc.volume, clip: tc };
                    this._editTlBadges(b, tc);
                    if (picked("tclip", c.i, row.id) && this._editTlKeyMarks) this._editTlKeyMarks(b, { kind: "tclip", track: row.id, i: c.i }, tc);
                    this._editTlTakeBadge(b, tc);
                    this._editTlLinkBadge(b, tc, row.kind);
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
        room("audio");
        ui.heads.replaceChildren(...headEls);
        ui.rows.replaceChildren(...rowEls);
        this._editTlSnapPlace();
        this._editTlNow = "";
        // The in and out (the transport's own range: played, looped, exported).
        if (this._editTlRulerMarks) this._editTlRulerMarks();
        if (this.editTlMarksDraw) this.editTlMarksDraw(ui, cut, lay);
        if (this._editTlEditMarkDraw) this._editTlEditMarkDraw();
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

    /**
     * Zoom the timeline to `zoom` (1 = the whole film; below it, empty timeline
     * after the film). With `clientX` (Ctrl + wheel) the moment under the pointer
     * stays where it is, as Resolve's wheel zooms; without it (Ctrl+= / Ctrl+-, the
     * buttons, Shift+Z) the PLAYHEAD keeps its x on screen - centred when it was
     * out of view (D.zoomScroll).
     */
    _editTlZoom(zoom, clientX) {
        const ui = this._editTlUi;
        const view = this._editTlView;
        if (!ui || !view) return;
        const sc = ui.scroll;
        const box = sc.getBoundingClientRect();
        const lay = this._editTlLay;
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        const onHead = clientX == null && this._editTlOnScreen() && lay && lay.total > 0;
        if (onHead) {
            const head = (this.currentFrame || 0) / fps;
            // The area's own scroll: how far of it lies left of the visible box.
            const a0 = ui.area.getBoundingClientRect();
            const before = { span: lay.total, width: a0.width, scroll: box.left - a0.left };
            view.zoom = D.clampZoom(zoom);
            ui.area.style.width = D.areaPercent(view.zoom) + "%";
            this.editTlRefresh();
            const now = this._editTlLay;
            if (!now || !(now.total > 0)) return;
            const a1 = ui.area.getBoundingClientRect();
            const after = { span: now.total, width: a1.width };
            const got = D.zoomScroll(head, before, after, sc.clientWidth);
            sc.scrollLeft = got.scroll + (a1.left - box.left + sc.scrollLeft);   // where the area begins in the scrolled content
            if (this.editMediaSchedule) this.editMediaSchedule();
            return;
        }
        const ax = clientX == null ? box.width / 2 : Math.max(0, Math.min(box.width, clientX - box.left));
        const share = sc.scrollWidth > 0 ? (sc.scrollLeft + ax) / sc.scrollWidth : 0;
        view.zoom = D.clampZoom(zoom);
        ui.area.style.width = D.areaPercent(view.zoom) + "%";
        sc.scrollLeft = Math.max(0, share * sc.scrollWidth - ax);
        this.editTlRefresh();
    },

    /**
     * Scrub: the playhead follows the pointer from the press `e` on `el` (the
     * ruler, or the line grabbed on the tracks), snapping as everything does -
     * to everything but itself - and the sound under it is heard (editScrubAt).
     */
    _editTlScrubDrag(e, el) {
        e.preventDefault();
        this._editTlScrubbing = true;
        const go = (ev) => {
            const at = this._editTlTimeAt(ev.clientX);
            if (at == null) return;
            this._editTlSeek(this._editTlSnapAt(at, [], { noHead: true }), true);
            if (this.editScrubAt) this.editScrubAt(at);
        };
        const up = () => {
            this._editTlScrubbing = false;
            this._editTlSnapLine(null);
            el.removeEventListener("pointermove", go);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            try { el.releasePointerCapture(e.pointerId); } catch (_) {}
            if (this._editTlUi) this._editTlUi.body.classList.remove("head-drag");
        };
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        el.addEventListener("pointermove", go);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        if (el !== this._editTlUi?.ruler) this._editTlUi?.body.classList.add("head-drag");
        go(e);
    },

    /**
     * Is the pointer of `e` on the playhead's line (within HEAD_PX of it, over
     * the tracks)? The line comes before the clip under it - but where an edit
     * point of the track under the pointer lies exactly at the playhead (within
     * half a frame), the press is the edit point's: that is how a cut the
     * playhead is parked on is still clicked, as in Resolve. Not with the blade.
     */
    _editTlHeadHit(e) {
        const ui = this._editTlUi, lay = this._editTlLay, cut = this._editTlCut;
        if (!e || !ui || !lay || !(lay.total > 0) || !cut || this._editTlBlade || !this._editTlOnScreen()) return false;
        if (ui.head.style.display === "none") return false;
        const x = ui.head.getBoundingClientRect().left;
        if (Math.abs(e.clientX - x) > HEAD_PX) return false;
        const fps = cut.fps || 24;
        const head = (this.currentFrame || 0) / fps;
        const path = e.composedPath ? e.composedPath() : [e.target];
        const row = path.find((n) => n && n.classList && n.classList.contains("edit-track"));
        const track = row ? row.dataset.track : "";
        if (track === "V1" || (track && D.trackOf(cut, track))) {
            if (D.editStops(cut, track).some((st) => Math.abs(st.t - head) < 0.5 / fps)) return false;
        }
        return true;
    },

    /** Over the playhead's line on the tracks: the ew-resize cursor (CSS .head-hot), and the clip under it is not lit. */
    _editTlHeadHover(e) {
        const ui = this._editTlUi;
        if (!ui) return;
        const hot = !!e && !e.buttons && this._editTlHeadHit(e);
        if (hot && !ui.body.classList.contains("head-hot")) this._editTlHoverEnd?.();
        ui.body.classList.toggle("head-hot", hot);
        if (hot) e.stopPropagation();
    },

    // Right-click on a clip: its colour, and taking it out.
    _editTlClipMenu(e, sel) {
        e.preventDefault();
        e.stopPropagation();
        // A clip of a selection of several keeps it (and one that is not in it joins it); else it is the selection.
        if (D.isItemSel(sel)) this._editTlMenuSelect(sel); else this._editTlSel = sel;
        this.editTlRefresh();
        if (sel.kind === "sound") {
            this._previzOpenMenu([{ label: "Remove this sound from the cut", run: () => this._editTlRemove(sel) }], e.clientX, e.clientY);
            return;
        }
        if (sel.kind === "gap") {
            this._previzOpenMenu([{ label: "Close gap (ripple delete: the clips after it move up)",
                                    run: () => { this._editTlSel = null; this._editTlApply(D.closeGap(this._editTlCut, sel.i)); } }],
                                 e.clientX, e.clientY);
            return;
        }
        const entries = [{ label: sel.kind === "text" ? "Remove this text" : sel.kind === "mix" ? "Remove this dissolve" : "Remove from the cut",
                           disabled: sel.kind === "clip" && this._editTlCut.clips.length <= 1,
                           run: () => this._editTlRemove(sel) }];
        if (D.isClipSel(sel) || sel.kind === "text") {
            // Resolve's Copy / Paste Attributes (bEpicViewer_editPaste.js), first.
            entries.unshift({ label: "Copy (Ctrl+C)", run: () => this.editTlCopy(sel) },
                            { label: "Paste Attributes… (Alt+V)", disabled: !this._editTlClipboard, run: () => this.editTlPasteDialog() }, "-");
        }
        const clip = D.clipOf(this._editTlCut, sel);
        if (sel.kind === "clip" || sel.kind === "tclip") entries.push(...this._editTlLinkEntries(sel));
        if (clip && FILM_EXTS.includes(ext(clip.file))) {
            entries.push({ label: "Detect cuts", run: () => this.editTlDetectCuts([sel]) });
        }
        if (sel.kind === "clip" || sel.kind === "tclip") {
            entries.push({ label: "Split at the playhead", disabled: !this._editTlOnScreen(), run: () => this.editTlSplitAtPlayhead() });
            const off = !!(D.clipOf(this._editTlCut, sel) || {}).disabled;
            entries.push({ label: off ? "Enable clip (D)" : "Disable clip (D)", run: () => this.editTlDisableToggle() });
            const many = this._editTlSelList().length;
            entries.push("-", { label: many > 1 ? `Recreate ${many} shots with changes…` : "Recreate with changes…",
                                run: () => this.editTlRecreateDialog(sel) });
            entries.push(...this._editTlTakeEntries(sel));
        }
        const menu = this._previzOpenMenu(entries, e.clientX, e.clientY);
        if (!menu || sel.kind === "text" || sel.kind === "mix") return;
        menu.prepend(this._editTlSwatches(menu.ownerDocument, D.clipOf(this._editTlCut, sel), (color) => {
            this._previzCloseAddMenu();
            this._editTlApply(D.setClipProps(this._editTlCut, sel, { color }));
        }));
        // The swatches made it taller after it was placed: inside the viewer again.
        const room = menu.parentElement.getBoundingClientRect().bottom - 12 - menu.getBoundingClientRect().bottom;
        if (room < 0) menu.style.top = Math.max(0, parseFloat(menu.style.top) + room) + "px";
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
        // "Remove from the cut" lifts, as Del does: a gap stays, a linked partner goes with it.
        if (sel.kind === "clip" || sel.kind === "tclip") this._editTlApply(D.deleteWithLink(cut, sel, false));
        else if (sel.kind === "text") this._editTlApply(D.removeText(cut, sel.i));
        else if (sel.kind === "sound") this._editTlApply(D.deleteSelection(cut, [sel], false).cut);
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
        const prev = D.stampIds(this._editTlCut);
        const got = how(this._editTlHistory(), this._editTlCut);
        if (!got) { this._editTlSay(how === D.historyUndo ? "nothing to undo" : "nothing to redo"); return; }
        // What was selected stays selected where the item still is: found by its uid, not its index.
        const was = this._editTlSelAll();
        const primary = this._editTlSel;
        const pid = primary ? D.identOf(prev, primary) : null;
        const point = this._editTlEditSel;
        this._editTlHistories[this._editTlTab] = got.history;
        this._editTlCut = got.cut;
        this._editTlMulti = null;
        D.stampIds(got.cut);
        const keep = was.map((s) => D.locateIdent(got.cut, D.identOf(prev, s))).filter(Boolean);
        const prim = pid ? D.locateIdent(got.cut, pid) : null;
        if (keep.length) this._editTlSetSelList(keep, prim);
        else if (primary && !D.isItemSel(primary)) {
            // A mix (the music bed's level) is not an item: it stays while the cut has its place.
            this._editTlSel = primary.kind === "mix" && got.cut.clips[primary.i] ? primary : null;
        } else this._editTlSel = null;
        this._editTlEditSel = null;
        if (point && point.sel) {
            const at = (s) => D.locateIdent(got.cut, D.identOf(prev, s));
            const sel = at(point.sel), a = point.a ? at(point.a) : null, b = point.b ? at(point.b) : null;
            if (sel && (!point.a || (a && b))) this._editTlEditSel = { ...point, sel, ...(point.a ? { a, b } : {}) };
        }
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
        const share = Math.max(0, (clientX - box.left) / box.width);
        // A drag may run on past the strip's right end: the strip grows with it, at the same scale.
        return (this._editTlLock ? share : Math.min(1, share)) * lay.total;
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
        // The scale is held for the whole drag (editTlRefresh), and how far it has gone is read off the timeline
        // itself, not from pixels at the press: so scrolling during the drag cannot put it off.
        this._editTlLock = { span: this._editTlLay.total, wide: parseFloat(ui.area.style.width) || 100 };
        const t0 = this._editTlTimeAt(e.clientX) || 0;
        const x0 = e.clientX;
        const id = e.pointerId;
        const captor = ui.area;          // the block itself is replaced on every redraw
        try { captor.setPointerCapture(id); } catch (_) {}
        // The whole drag is one step of the undo stack.
        const before = this._editTlCut;
        this._editTlDragging = true;
        this._editTlDragBase = before;
        this._editTlDragHead = this.currentFrame || 0;
        // S held while dragging snaps the other way for as long as it is held (not a split, then).
        // (The viewer's own key handler, on the window, asks editTlKeyDown first, which hands S to this while a drag is on.)
        const doc = ui.area.ownerDocument;
        const flip = (ev) => {
            if (ev.code !== "KeyS" && String(ev.key).toLowerCase() !== "s") return false;
            if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
            ev.preventDefault();
            ev.stopImmediatePropagation();
            const held = ev.type === "keydown";
            if (this._editTlSnapFlip === held) return true;
            this._editTlSnapFlip = held;
            if (this._editTlLastMove) move(this._editTlLastMove);
            return true;
        };
        this._editTlSnapKey = flip;
        const win = doc.defaultView || window;
        win.addEventListener("keydown", flip, true);
        win.addEventListener("keyup", flip, true);
        const y0 = e.clientY;
        let moved = false;
        const move = (ev) => {
            this._editTlLastMove = ev;
            const dx = ev.clientX - x0;
            // Sideways or up and down: a clip is also dragged from one track to another.
            if (!moved && Math.hypot(dx, ev.clientY - y0) < DRAG_SLOP) return;
            moved = true;
            onMove((this._editTlTimeAt(ev.clientX) || 0) - t0, ev);
        };
        const up = (ev) => {
            captor.removeEventListener("pointermove", move);
            captor.removeEventListener("pointerup", up);
            captor.removeEventListener("pointercancel", up);
            win.removeEventListener("keydown", flip, true);
            win.removeEventListener("keyup", flip, true);
            this._editTlSnapKey = null;
            this._editTlSnapFlip = false;
            this._editTlLastMove = null;
            this._editTlSnapLine(null);
            try { captor.releasePointerCapture(id); } catch (_) {}
            try { onUp(moved, ev); } finally {
                this._editTlDragging = false;
                this._editTlDragHead = null;
                this._editTlLock = null;
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

    /** The empty room a pointer's y is in: "video" above the top video track, "audio" below the bottom row, else "". In the panel only. */
    _editTlRoomAt(clientY) {
        const ui = this._editTlUi;
        if (!ui) return "";
        // The tracks scroll inside a short panel: past its edge counts, if the room itself is out of view (a little way past it only).
        const box = ui.main.getBoundingClientRect();
        if (clientY < box.top - 60 || clientY > box.bottom + 60) return "";
        const rows = [...ui.rows.querySelectorAll(".edit-track")];
        const top = rows.find((r) => r.classList.contains("edit-k-video"));
        const last = rows[rows.length - 1];
        if (top && clientY < Math.max(top.getBoundingClientRect().top, box.top)) return "video";
        if (last && clientY > Math.min(last.getBoundingClientRect().bottom, box.bottom)) return "audio";
        return "";
    },

    /** "new:video" / "new:audio" when clip `sel` dragged there would get a new track: picture upwards, sound downwards. */
    _editTlRoomFor(ev, sel) {
        const room = this._editTlRoomAt(ev.clientY);
        if (!room || D.selKind(this._editTlCut, sel) !== room) return "";
        if (sel.kind === "clip" && this._editTlCut.clips.length <= 1) return "";
        return "new:" + room;
    },

    // A row (or the empty room) by what a drag calls it.
    _editTlRowEl(where) {
        const ui = this._editTlUi;
        if (String(where).startsWith("new:")) return ui.rows.querySelector(`.edit-room[data-room="${String(where).slice(4)}"]`);
        return [...ui.rows.querySelectorAll(".edit-track")].find((r) => r.dataset.track === where) || null;
    },

    // What is being dragged, drawn where it would land: on the track under the
    // pointer, at the pointer's moment. null takes it away.
    _editTlGhost(spec) {
        const ui = this._editTlUi;
        if (!ui) return;
        for (const r of ui.rows.querySelectorAll(".edit-track.landing, .edit-room.landing")) r.classList.remove("landing");
        if (!spec) { if (ui.ghost) ui.ghost.style.display = "none"; return; }
        if (!ui.ghost || !ui.ghost.isConnected) {
            ui.ghost = ui.area.ownerDocument.createElement("div");
            ui.ghost.className = "edit-ghost";
            ui.area.append(ui.ghost);
        }
        const row = this._editTlRowEl(spec.track);
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
        const was = start.clips[i];
        const sel = { kind: "clip", i };
        if (this._editTlBlade) { this._editTlBladeCut(e, sel); return; }
        // Ctrl+Shift+drag: into the order (an insert), as Resolve's. Ctrl or Shift alone: several selected.
        const insert = !!((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey);
        // Ctrl / Shift on a clip's body: several clips selected (bEpicViewer_editTakes.js).
        if (!insert && this._editTlMultiDown(e, el, sel)) return;
        // A plain press on one of several selected: they move together.
        if (!insert && this._editTlGroupDown(e, el, sel)) return;
        // An edge, or a modifier held: trim, roll, retime, loop, slip, slide (bEpicViewer_editTrim.js).
        if (!insert && this._editTlTrimDown && this._editTlTrimDown(e, el, sel)) return;
        const began = D.clipStarts(start)[i];
        const grab = (this._editTlTimeAt(e.clientX) || began) - began;       // where in the clip it was taken hold of
        this._editTlSel = sel;
        this._editTlEditSel = null;
        const exclude = D.snapExclude(start, sel);
        let onto = "V1", landed = began;
        this._editTlDrag(e, el, (seconds, ev) => {
            onto = this._editTlRoomFor(ev, sel) || this._editTlTrackUnder(ev, sel) || "V1";
            const raw = Math.max(0, (this._editTlTimeAt(ev.clientX) || 0) - grab);
            if (onto === "V1" && insert) {
                if (this._editTlCut !== start) { this._editTlCut = start; this.editTlRefresh(); }
                this._editTlGhost(null); this._editTlDropMark(ev.clientX);
                return;
            }
            const at = Math.max(0, this._editTlSnapSpanAt(raw, Number(was.length) || 0, exclude));
            landed = at;
            if (onto === "V1") {
                // Selection mode: it goes there, over what is there, and leaves a gap where it was.
                this._editTlGhost(null); this._editTlDropMark(null);
                const got = D.moveShot(start, i, at);
                if (got) {
                    this._editTlCut = D.followLink(start, got.cut, sel);
                    this._editTlSel = { kind: "clip", i: got.i };
                }
                this.editTlRefresh();
                return;
            }
            if (this._editTlCut !== start) { this._editTlCut = start; this._editTlSel = sel; this.editTlRefresh(); }
            this._editTlDropMark(null);
            this._editTlGhost({ track: onto, at, length: was.length, name: was.name });
        }, (moved, ev) => {
            this._editTlDropMark(null);
            this._editTlGhost(null);
            if (!moved) { this._editTlSeek(began); this.editTlRefresh(); return; }
            if (onto !== "V1") {
                // Onto another track: the clips after it on V1 stay where they are (a gap is left) - Ctrl+Shift: they close up.
                const got = this._editTlLand(start, sel, onto, landed, insert);
                this._editTlCut = start;
                if (got) { this._editTlSel = got.sel; this._editTlApply(D.followLink(start, got.cut, sel)); return; }
                this._editTlSel = sel;
                this.editTlRefresh();
                return;
            }
            if (insert) {
                // Where it lands among the OTHERS: its own block is not a place to land.
                const at = this._editTlTimeAt(ev.clientX);
                const others = D.removeClip(start, i);
                let to = at == null ? i : D.dropIndex(start.clips.length > 1 ? others : start, at);
                if (start.clips.length <= 1) to = 0;
                this._editTlCut = start;
                this._editTlMove(i, to);
                return;
            }
            this.editTlRefresh();
        });
    },

    // A dragged clip let go on another track - or in the empty room, which makes a new one (one step of the undo stack).
    _editTlLand(start, sel, onto, at, ripple) {
        if (String(onto).startsWith("new:")) return D.transferToNewTrack(start, sel, onto.slice(4), at, { ripple });
        return D.transferClip(start, sel, onto, at, { ripple });
    },

    /**
     * Several selected, one of them pressed in Selection mode: all of them move
     * together, as Resolve's - the same time (the pressed one's edges snapping)
     * and the same number of tracks up or down, each on its own kind of track
     * (past the top video / bottom sound track: a new one). They pass over the
     * clips that are not moving and lie OVER what is at their new place (D.moveGroup:
     * covered clips go, overlapped ones are trimmed or split); gaps stay where
     * they were; held only at the film's start. One undo step. (The Trim mode's
     * body press slips / slides the pressed clip, as Resolve's does.)
     */
    _editTlGroupDown(e, el, sel) {
        const list = this._editTlSelAll();
        if (list.length < 2 || !list.some((s) => D.sameSel(s, sel))) return false;
        // A picture and its linked sound are one clip to a drag: it may lie over what is at its new place.
        const partner = D.isClipSel(sel) ? D.linkPartner(this._editTlCut, sel) : null;
        if (list.length === 2 && partner && list.some((s) => D.sameSel(s, partner))) return false;
        if (this._editTlZone(e, el) !== "body" || this._editTlTrimMode || e.altKey) return false;
        const start = this._editTlCut;
        const span = D.selSpan(start, sel);
        const exclude = list.flatMap((s) => D.snapExclude(start, s));
        const from = this._editTlRowIndex(sel.kind === "clip" ? "V1" : sel.kind === "tclip" ? sel.track : "");
        this._editTlSel = sel;
        this._editTlEditSel = null;
        this._editTlDrag(e, el, (seconds, ev) => {
            const at = Math.max(0, this._editTlSnapSpanAt(span.start + seconds, span.end - span.start, exclude));
            const rows = from ? this._editTlRowsMoved(from, ev) : 0;
            const got = D.moveGroup(start, list, at - span.start, rows);
            if (!got) { this._editTlCut = start; this._editTlSetSelList(list, sel); this.editTlRefresh(); return; }
            if (Math.abs(got.delta - (at - span.start)) > 1e-6) this._editTlSnapLine(null);       // held: it is not where the line says
            this._editTlCut = got.cut;
            this._editTlSetSelList(got.sel, got.moved[D.selId(sel)] || null);
            this.editTlRefresh();
        }, (moved) => {
            if (!moved) { this._editTlCut = start; this._editTlMulti = null; this._editTlSel = sel; this._editTlSeek(span.start); }
            this.editTlRefresh();
        });
        return true;
    },

    /** A track's row among the rows of its kind, top down: { kind, i, n } - sound tracks without A1 (the bed). */
    _editTlRowIndex(track) {
        const ui = this._editTlUi;
        if (!ui || !track) return null;
        const rows = [...ui.rows.querySelectorAll(".edit-track")];
        const row = rows.find((r) => r.dataset.track === track);
        if (!row) return null;
        const kind = row.classList.contains("edit-k-audio") ? "audio" : "video";
        const same = rows.filter((r) => r.classList.contains("edit-k-" + kind) && r.dataset.track !== "A1");
        return { kind, i: same.indexOf(row), n: same.length, ids: same.map((r) => r.dataset.track) };
    },

    /** How many rows of its own kind a drag from row `from` has gone down (negative: up); past the end, into the room: one more. */
    _editTlRowsMoved(from, ev) {
        const room = this._editTlRoomAt(ev.clientY);
        if (room === from.kind) return from.kind === "video" ? -1 - from.i : from.n - from.i;
        // The rows as they are now (a redraw during the drag replaces the elements).
        const all = [...this._editTlUi.rows.querySelectorAll(".edit-track")];
        const ys = from.ids.map((id) => all.find((r) => r.dataset.track === id)).filter(Boolean).map((r) => r.getBoundingClientRect());
        const k = ys.findIndex((b) => ev.clientY >= b.top && ev.clientY < b.bottom);
        if (k >= 0) return k - from.i;
        if (!ys.length) return 0;
        if (ev.clientY < ys[0].top) return from.kind === "video" ? -from.i : 0;      // above its own kind: the top one
        if (ev.clientY >= ys[ys.length - 1].bottom) return from.kind === "audio" ? from.n - 1 - from.i : 0;
        return 0;
    },

    // The music bed under the film: selected, alone or with others.
    _editTlBedDown(e, el, k) {
        if (e.button !== 0 || this._editTlBlade) return;
        e.preventDefault();
        e.stopPropagation();
        const sel = { kind: "sound", i: k };
        if (this._editTlMultiDown(e, el, sel)) return;
        this._editTlMulti = null;
        this._editTlSel = sel;
        this._editTlEditSel = null;
        this.editTlRefresh();
    },

    // A press where nothing lies. Dragged: a rectangle, and what it touches on all the tracks is selected
    // (Shift, Ctrl: added to what was). A click takes the selection off.
    _editTlMarqueeDown(e) {
        const ui = this._editTlUi;
        if (e.button !== 0 || !ui) return;
        const t = e.target;
        const free = t && t.classList && (t.classList.contains("edit-track") || t.classList.contains("edit-room") || t.classList.contains("edit-rows")
            || t.classList.contains("edit-area") || t === ui.scroll);
        if (!free) return;
        // The scroll bars are part of the element too.
        const sb = ui.scroll.getBoundingClientRect();
        if (e.clientY > sb.top + ui.scroll.clientHeight || e.clientX > sb.left + ui.scroll.clientWidth) return;
        const clear = () => {
            if (this._editTlSel || this._editTlEditSel || this._editTlMulti) {
                this._editTlSel = null; this._editTlEditSel = null; this._editTlMulti = null;
                this.editTlRefresh();
            }
        };
        if (this._editTlBlade) { clear(); return; }
        e.preventDefault();
        const add = !!(e.shiftKey || e.ctrlKey || e.metaKey);
        const base = add ? this._editTlSelAll() : [];
        const x0 = e.clientX, y0 = e.clientY;
        const t0 = this._editTlTimeAt(x0) || 0;
        const area = ui.area, id = e.pointerId;
        const doc = area.ownerDocument;
        let box = null, last = "";
        const move = (ev) => {
            if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_SLOP) return;
            if (!box) { box = doc.createElement("div"); box.className = "edit-marquee"; area.append(box); }
            const a = area.getBoundingClientRect();
            const left = Math.min(x0, ev.clientX), top = Math.min(y0, ev.clientY);
            const right = Math.max(x0, ev.clientX), bottom = Math.max(y0, ev.clientY);
            box.style.left = (left - a.left) + "px";
            box.style.top = (top - a.top) + "px";
            box.style.width = (right - left) + "px";
            box.style.height = (bottom - top) + "px";
            const rows = [...ui.rows.querySelectorAll(".edit-track")].filter((r) => {
                const q = r.getBoundingClientRect();
                return q.bottom >= top && q.top <= bottom;
            }).map((r) => r.dataset.track);
            const list = [...base, ...D.marqueeSel(this._editTlCut, rows, t0, this._editTlTimeAt(ev.clientX) || 0)];
            const now = list.map(D.selId).join();
            if (now === last) return;
            last = now;
            this._editTlEditSel = null;
            this._editTlSetSelList(list);
            this.editTlRefresh();
        };
        const up = () => {
            area.removeEventListener("pointermove", move);
            area.removeEventListener("pointerup", up);
            area.removeEventListener("pointercancel", up);
            try { area.releasePointerCapture(id); } catch (_) {}
            if (box) box.remove(); else if (!add) clear();
        };
        try { area.setPointerCapture(id); } catch (_) {}
        area.addEventListener("pointermove", move);
        area.addEventListener("pointerup", up);
        area.addEventListener("pointercancel", up);
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
        const insert = !!((e.ctrlKey || e.metaKey) && e.shiftKey);
        if (!insert && this._editTlMultiDown(e, el, sel)) return;
        if (!insert && this._editTlGroupDown(e, el, sel)) return;
        if (!insert && this._editTlTrimDown && this._editTlTrimDown(e, el, sel)) return;
        this._editTlSel = sel;
        this._editTlEditSel = null;
        let onto = id, landed = Number(was.at) || 0;
        // Its edges snap to every other clip's edges, the playhead, ... (not its own, nor its partner's).
        const exclude = D.snapExclude(start, sel);
        this._editTlDrag(e, el, (seconds, ev) => {
            if (zone === "end") this._editTlCut = D.followLink(start, D.trimTrackClipEnd(start, id, i, D.toFrame(was.length + seconds, fps)), sel);
            else if (zone === "start") this._editTlCut = D.followLink(start, D.trimTrackClipStart(start, id, i, D.toFrame(seconds, fps)), sel);
            else {
                onto = this._editTlRoomFor(ev, sel) || this._editTlTrackUnder(ev, sel) || id;
                const at = Math.max(0, this._editTlSnapSpanAt(Math.max(0, was.at + seconds), Number(was.length) || 0, exclude));
                landed = at;
                if (onto === id) {
                    this._editTlGhost(null);
                    this._editTlDropMark(null);
                    this._editTlCut = D.followLink(start, D.moveTrackClip(start, id, i, at), sel);
                    this.editTlRefresh();
                    return;
                }
                // Over another track: it stays where it was until it is let go there.
                if (this._editTlCut !== start) { this._editTlCut = start; this.editTlRefresh(); }
                if (onto === "V1" && insert) { this._editTlGhost(null); this._editTlDropMark(ev.clientX); }
                else { this._editTlDropMark(null); this._editTlGhost({ track: onto, at, length: was.length, name: was.name }); }
                return;
            }
            this.editTlRefresh();
        }, (moved, ev) => {
            this._editTlDropMark(null);
            this._editTlGhost(null);
            if (moved && zone === "body" && onto !== id) {
                // Onto V1: laid over what is there at its moment (Ctrl+Shift: put into the order there).
                const at = onto === "V1" && insert ? (this._editTlTimeAt(ev.clientX) || 0) : landed;
                const got = this._editTlLand(start, sel, onto, at, insert);
                this._editTlCut = start;
                if (got) { this._editTlSel = got.sel; this._editTlApply(D.followLink(start, got.cut, sel)); return; }
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
        if (this._editTlMultiDown(e, el, { kind: "text", i })) return;
        if (this._editTlGroupDown(e, el, { kind: "text", i })) return;
        this._editTlSel = { kind: "text", i };
        const own = ["T:" + i];
        this._editTlDrag(e, el, (seconds) => {
            const end0 = Number(was.start) + Number(was.length);
            if (zone === "end") this._editTlCut = D.resizeText(start, i, D.toFrame(this._editTlSnapAt(end0 + seconds, own) - was.start, fps));
            else if (zone === "start") this._editTlCut = D.trimTextStart(start, i, D.toFrame(this._editTlSnapAt(was.start + seconds, own), fps));
            else this._editTlCut = D.moveText(start, i, this._editTlSnapSpanAt(was.start + seconds, Number(was.length), own));
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
        for (const r of ui.rows.querySelectorAll(".edit-track.landing, .edit-room.landing")) if (r.dataset.track !== where) r.classList.remove("landing");
        const at = clientX == null ? null : this._editTlTimeAt(clientX);
        if (at == null || !this._editTlCut || !this._editTlLay) { ui.drop.style.display = "none"; return; }
        const cut = this._editTlCut;
        let moment = snap ? this._editTlSnap(at, where) : at;
        if (!snap) this._editTlSnapLine(null);
        // The track it lands on is lit, as a moved clip's is.
        if (snap && where) {
            const row = this._editTlRowEl(where);
            if (row) row.classList.add("landing");
        }
        if (!(where === "free" || String(where).startsWith("new:") || (where && D.trackOf(cut, where)))) {
            // On V1: between two shots - or, in a gap, the moment itself (it is placed there).
            moment = D.v1DropAt(cut, snap ? moment : at).moment;
        }
        ui.drop.style.display = "block";
        ui.drop.style.left = (moment / this._editTlLay.total) * 100 + "%";
    },

    // ── snapping ─────────────────────────────────────────────────────────────

    /** How many seconds D.SNAP_PX pixels are at the zoom the timeline is at. */
    _editTlSnapTolerance() {
        const ui = this._editTlUi, lay = this._editTlLay;
        if (!ui || !lay || !(lay.total > 0)) return 0;
        return D.snapSeconds(D.SNAP_PX, lay.total, ui.area.getBoundingClientRect().width);
    },

    /** Is snapping on now: the switch (N, the magnet) - turned the other way while S is held in a drag. */
    _editTlSnapping() {
        const on = !this._editTlView || this._editTlView.snap !== false;
        return this._editTlSnapFlip ? !on : on;
    },

    /** N / the magnet: snapping on or off (`what` "beats": the beats of the music as targets too). Kept with the cut. */
    editTlSnapToggle(what) {
        const view = this._editTlView;
        if (!view) return;
        if (what === "beats") {
            view.snapBeats = !view.snapBeats;
            this._editTlSay(view.snapBeats ? (this._editTlBeatTimes().length ? "snapping to the beats too"
                                                                              : "snapping to the beats too, once Auto edit (On the beat) has read them")
                                           : "not snapping to the beats");
        } else {
            view.snap = view.snap === false;
            this._editTlSay(view.snap ? "snapping on (N)" : "snapping off (N)");
        }
        this._editTlKeep();
        this.editTlRefresh();
    },

    /** The beats of the music, as moments of the film, where Auto edit has read them (editAuto keeps them). */
    _editTlBeatTimes() {
        const known = this._editTlBeatsKnown && this._editTlBeatsKnown[this._editTlTab];
        return Array.isArray(known) ? known : [];
    },

    /**
     * Everything a drag can snap to now (D.snapTargets), but the ids in `exclude`.
     * `opts.noHead`: not the playhead (it is what is being dragged); `noRange`: not the in / out.
     */
    _editTlTargets(exclude, opts = {}) {
        // The cut as it was when the drag began: what is being dragged must not drag its targets along.
        const cut = (this._editTlDragging && this._editTlDragBase) || this._editTlCut;
        const fps = (cut && cut.fps) || 24;
        const span = !opts.noRange && this._editTlRangeSpan ? this._editTlRangeSpan() : null;
        const view = this._editTlView || {};
        return D.snapTargets(cut, {
            exclude,
            // Where the playhead stood when the drag began: in the Trim mode it follows the edge being dragged (_editTlTrimFollow).
            playhead: !opts.noHead && this._editTlOnScreen()
                ? (this._editTlDragging && this._editTlDragHead != null ? this._editTlDragHead : (this.currentFrame || 0)) / fps : null,
            range: span,
            beats: view.snapBeats ? this._editTlBeatTimes() : [],
        });
    },

    /**
     * THE snapping: `seconds` moved onto the nearest target within D.SNAP_PX pixels
     * (whatever the zoom) while snapping is on - and the snap line drawn at it, the
     * target lit. Snapped, the answer is ON the target's frame, which is where the
     * line stands. Off, or nothing near: as it is, and no line.
     */
    _editTlSnapAt(seconds, exclude = [], opts = {}) {
        if (!this._editTlSnapping()) { this._editTlSnapLine(null); return seconds; }
        const got = D.snapResolve(seconds, this._editTlTargets(exclude, opts), this._editTlSnapTolerance());
        this._editTlSnapLine(got.target);
        return got.target ? D.toFrame(got.t, (this._editTlCut && this._editTlCut.fps) || 24) : seconds;
    },

    /** A span `length` long beginning at `at`, snapped by its start or its end: the start it lands on - not to be rounded further (D.snapMove). */
    _editTlSnapSpanAt(at, length, exclude = []) {
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        if (!this._editTlSnapping()) { this._editTlSnapLine(null); return D.toFrame(at, fps); }
        const got = D.snapMove(at, length, this._editTlTargets(exclude), this._editTlSnapTolerance(), fps);
        this._editTlSnapLine(got.target);
        return got.at;
    },

    /** The snap line: thin, down every track, at the target snapped to - and the target lit a moment. null: away. */
    _editTlSnapLine(target) {
        const ui = this._editTlUi, lay = this._editTlLay;
        if (!ui) return;
        if (!ui.snapLine || !ui.snapLine.isConnected) {
            ui.snapLine = ui.area.ownerDocument.createElement("div");
            ui.snapLine.className = "edit-snapline";
            ui.area.append(ui.snapLine);
        }
        const line = ui.snapLine;
        this._editTlSnapTarget = target && lay && lay.total > 0 ? target : null;
        if (!target || !lay || !(lay.total > 0)) {
            line.style.display = "none";
            line.dataset.kind = "";
            this._editTlSnapHit = null;
            for (const b of ui.rows.querySelectorAll(".snap-hit")) b.classList.remove("snap-hit");
            return;
        }
        line.style.display = "block";
        this._editTlSnapPlace();
        line.dataset.kind = target.kind;
        line.title = target.label || "";
        const key = target.kind + ":" + target.owner + ":" + target.t;
        if (this._editTlSnapHit === key) return;
        this._editTlSnapHit = key;
        // The target lights up a moment (again whenever another one is snapped to).
        line.classList.remove("flash");
        void line.offsetWidth;
        line.classList.add("flash");
        for (const b of ui.rows.querySelectorAll(".snap-hit")) b.classList.remove("snap-hit");
        if (target.owner) {
            const hit = [...ui.rows.querySelectorAll(".edit-shot, .edit-gap, .edit-text")].find((b) => b.dataset.key === target.owner
                || (target.owner.startsWith("T:") && b.classList.contains("edit-text") && b.dataset.key === target.owner));
            if (hit) hit.classList.add("snap-hit");
        }
    },

    // The line at its target's frame, on the scale the timeline has NOW: called again by every redraw.
    _editTlSnapPlace() {
        const ui = this._editTlUi, lay = this._editTlLay, g = this._editTlSnapTarget;
        if (!ui || !ui.snapLine || !g || !lay || !(lay.total > 0)) return;
        const t = D.toFrame(g.t, (this._editTlCut && this._editTlCut.fps) || 24);
        ui.snapLine.style.left = Math.max(0, Math.min(100, (t / lay.total) * 100)) + "%";
    },

    /** A moment of a drop, snapped and on a frame. */
    _editTlSnap(seconds) {
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        return D.toFrame(Math.max(0, this._editTlSnapAt(seconds)), fps);
    },

    // ── the blade ────────────────────────────────────────────────────────────

    editTlBladeToggle(on) {
        this._editTlBlade = on === undefined ? !this._editTlBlade : !!on;
        if (!this._editTlBlade) this._editTlBladeHover(null);
        this.editTlRefresh();
    },

    /**
     * D: the selected clips switched off - or on again (Resolve's Clip Enable),
     * their linked partners with them unless unlinked (D.toggleDisabled). A
     * disabled clip is dimmed, not seen and not heard, and not rendered. One step.
     */
    editTlDisableToggle() {
        const cut = this._editTlCut;
        const list = this._editTlSelAll().filter(D.isClipSel);
        if (!cut || !list.length) { this._editTlSay("select a clip to disable it (D)"); return; }
        const got = D.toggleDisabled(cut, list);
        if (!got) return;
        const primary = this._editTlSel;
        this._editTlApply(got.cut);
        if (list.length > 1) this._editTlSetSelList(list, primary);
        this._editTlSay(`${got.count} clip(s) ${got.off ? "disabled: not seen, not heard, not rendered" : "enabled again"}`);
    },

    /** The mode, as Resolve's: "select" (A, the default), "trim" (T) - either puts the blade (B) away. */
    editTlMode(mode) {
        this._editTlTrimMode = mode === "trim";
        this._editTlFollow = null;                  // the Trim mode (again): a selected cut takes the playhead
        if (!this._editTlTrimMode && this.editTwoUpHide) this.editTwoUpHide();      // the two-up is the Trim mode's
        if (this._editTlTrimMode && this.editTwoUpRest) this.editTwoUpRest();
        this._editTlHoverAct = null;
        if (this._editTlTrimShow) this._editTlTrimShow(null);
        this.editTlBladeToggle(false);
    },

    /** The moment the blade would cut at, under a pointer: on a frame, snapped to the playhead and the edges. */
    _editTlBladeTime(clientX) {
        const t = this._editTlTimeAt(clientX);
        if (t == null) return null;
        const fps = this._editTlCut.fps || 24;
        return D.toFrame(this._editTlSnapAt(t), fps);
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
        if (t == null || !this._editTlLay) { ui.bladeLine.style.display = "none"; if (!this._editTlDragging) this._editTlSnapLine(null); return; }
        ui.bladeLine.style.display = "block";
        ui.bladeLine.style.left = (t / this._editTlLay.total) * 100 + "%";
    },

    // A click with the blade: the clip is cut where it was clicked.
    _editTlBladeCut(e, sel) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const t = this._editTlBladeTime(e.clientX);
        const got = t == null ? null : D.splitWithLink(this._editTlCut, sel, t);
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

    /**
     * Del / Shift+Del: EVERYTHING selected goes, as one step of the undo stack - leaving
     * gaps, or closing up (ripple). A clip linked to its sound (or picture) takes it with it;
     * a gap is closed, either way; a text and a clip of the bed go.
     */
    editTlDelete(ripple) {
        const sel = this._editTlSel;
        const cut = this._editTlCut;
        if (!sel || !cut) return false;
        if (sel.kind === "mix") {
            this._editTlSel = null;
            this._editTlEditSel = null;
            this._editTlApply(D.liftClip(cut, sel));
            return true;
        }
        const got = D.deleteSelection(cut, this._editTlSelAll(), !!ripple);
        if (D.sameCut(got.cut, cut)) { if (got.kept) this._editTlSay("a cut keeps its last shot"); return true; }
        this._editTlSel = null;
        this._editTlEditSel = null;
        this._editTlMulti = null;
        this._editTlApply(got.cut);
        if (got.kept) this._editTlSay("a cut keeps its last shot");
        return true;
    },

    // ── picture and sound apart ──────────────────────────────────────────────

    /** Does a clip's film have sound? (what /bepic/timeline_probe said; a film not yet asked about is taken to) */
    _editTlHasSound(clip) {
        if (!clip || D.isStillClip(clip) || !FILM_EXTS.includes(ext(clip.file))) return false;
        const info = this._editTlInfo && this._editTlInfo.get(clip.file);
        return !info || info.audio !== false;
    },

    /** A clip's link mark: a chain while its picture and sound go together, a broken one when they are apart. */
    _editTlLinkBadge(b, clip, kind) {
        const paired = !!clip.link;
        const linked = paired ? !clip.unlinked : (kind === "video" && !clip.mute && this._editTlHasSound(clip));
        if (!paired && !linked) return;
        // Linked but not in step, as Resolve shows it: by how many frames, on both parts.
        const off = paired && linked ? this._editTlOutOfSync(clip, kind) : 0;
        if (off) {
            const tag = b.ownerDocument.createElement("span");
            tag.className = "edit-badge-sync";
            tag.textContent = (off > 0 ? "+" : "\u2212") + Math.abs(off);
            tag.title = `Picture and sound are ${Math.abs(off)} frames out of sync (right-click: Resync)`;
            b.append(tag);
        }
        const tag = b.ownerDocument.createElement("span");
        tag.className = "edit-badge-link" + (linked ? "" : " off") + (paired ? " pair" : "");
        tag.title = paired ? (linked ? "Linked to its " + (kind === "audio" ? "picture" : "sound") + ": moved, trimmed, cut and deleted together (Ctrl+Alt+L unlinks)"
                                    : "Unlinked from its " + (kind === "audio" ? "picture" : "sound") + ": each moves on its own (Ctrl+Alt+L relinks)")
                           : "Picture and sound linked (Ctrl+Alt+L: unlink - its sound becomes a clip of its own on a sound track)";
        b.classList.add("has-link");
        b.append(tag);
    },

    // How many frames a linked clip's sound is off its picture (0: in step). `clip` as drawn; found again by its identity.
    _editTlOutOfSync(clip, kind) {
        const cut = this._editTlCut;
        const member = D.linkMembers(cut, clip.link).find((s) => D.clipOf(cut, s) === clip);
        return member ? Math.round(D.syncOffset(cut, member) * (cut.fps || 24)) : 0;
    },

    /** The right-click entries of picture and sound: Unlink / Relink, Resync, Merge back, Link clips. */
    _editTlLinkEntries(sel) {
        const cut = this._editTlCut;
        const c = D.clipOf(cut, sel);
        if (!c) return [];
        const out = [];
        const partner = D.linkPartner(cut, sel, false);
        const pair = this._editTlLinkPair();
        if (pair) out.push({ label: "Link clips (Ctrl+Alt+L)", run: () => this.editTlLinkToggle() });
        else if (partner && c.unlinked) out.push({ label: "Relink audio (Ctrl+Alt+L)", run: () => this.editTlLinkToggle() });
        else if (partner) out.push({ label: "Unlink audio / video (Ctrl+Alt+L)", run: () => this.editTlLinkToggle() });
        else if (D.selKind(cut, sel) === "video" && !c.link && !c.mute) {
            out.push({ label: "Unlink audio / video (Ctrl+Alt+L)", disabled: !this._editTlHasSound(c), run: () => this.editTlLinkToggle() });
        }
        if (partner && D.syncOffset(cut, sel)) {
            out.push({ label: "Resync (the sound back onto the picture)", run: () => { const n = D.resyncAudio(cut, sel); if (n) this._editTlApply(n); } });
        }
        if (D.mergeAudio(cut, sel)) {
            out.push({ label: "Merge audio back into clip", run: () => {
                const got = D.mergeAudio(this._editTlCut, sel);
                if (!got) return;
                this._editTlMulti = null;
                this._editTlSel = got.sel;
                this._editTlApply(got.cut);
                this._editTlSay("the sound is back in the clip");
            } });
        }
        return out;
    },

    /** A picture and a sound clip of the same file among the clips selected: [video, sound], or null. */
    _editTlLinkPair() {
        const cut = this._editTlCut;
        const list = this._editTlSelList ? this._editTlSelList() : [];
        if (list.length !== 2) return null;
        const [a, b] = list;
        const ca = D.clipOf(cut, a), cb = D.clipOf(cut, b);
        if (!ca || !cb || D.normFile(ca.file) !== D.normFile(cb.file) || D.selKind(cut, a) === D.selKind(cut, b)) return null;
        if (ca.link && ca.link === cb.link && !ca.unlinked && !cb.unlinked) return null;          // linked already
        return D.selKind(cut, a) === "video" ? [a, b] : [b, a];
    },

    /**
     * Ctrl+Alt+L (Resolve's Link Clips): two selected clips of one file, a picture
     * and its sound, are linked; a linked clip is unlinked; a film with its sound in
     * it gets the sound as a clip of its own. One step of the undo stack.
     */
    editTlLinkToggle() {
        const cut = this._editTlCut;
        if (!cut) return;
        const pair = this._editTlLinkPair();
        if (pair) {
            const got = D.linkClips(cut, pair[0], pair[1]);
            if (got) { this._editTlApply(got.cut); this._editTlSay("linked: picture and sound go together"); }
            return;
        }
        const sel = this._editTlSel;
        const c = sel && D.clipOf(cut, sel);
        if (!c) { this._editTlSay("select a film with sound to unlink it - or its picture and its sound to link them"); return; }
        // One clip of a split pair is enough: its partner is found by the link group. The offset stays (Resync puts it right).
        if (c.link && c.unlinked) {
            const back = D.relinkAudio(cut, sel);
            if (!back) { this._editTlSay("its other part is gone - right-click: Merge audio back into clip"); return; }
            this._editTlApply(back);
            this._editTlSay("relinked: picture and sound go together");
            return;
        }
        if (!c.link && (D.selKind(cut, sel) !== "video" || !this._editTlHasSound(c))) { this._editTlSay("this clip has no sound to unlink"); return; }
        const got = D.unlinkClip(cut, sel);
        if (!got) { this._editTlSay("this clip has no sound to unlink"); return; }
        this._editTlApply(got.cut);
        const k = D.trackOf(got.cut, got.sel.track);
        this._editTlSay(c.link ? "unlinked: picture and sound move on their own" : `its sound is a clip of its own now, on ${k ? k.name : "a sound track"}`);
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
        // Past the end of the film (zoomed out, the ruler goes on): its last frame.
        const last = this._editTlCut ? Math.max(0, D.filmFrames(this._editTlCut) - 1) : Infinity;
        this.setFrame(Math.max(0, Math.min(last, under ? Math.floor(seconds * fps + 1e-6) : Math.ceil(seconds * fps - 1e-6))));
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
        // Drawn at the START of the frame: where a clip snapped to it lands and where a cut there would be.
        ui.head.style.left = Math.max(0, Math.min(100, (((this.currentFrame || 0) / fps) / lay.total) * 100)) + "%";
        // Zoomed in, the playhead is followed - a screenful at a time - when the
        // FRAME moved (playing, the transport's bar, a key), not when the cut was
        // only redrawn, and not under the ruler being scrubbed.
        const sc = ui.scroll;
        const moved = this._editTlHeadFrame !== this.currentFrame;
        this._editTlHeadFrame = this.currentFrame;
        if (moved && !this._editTlScrubbing && !this._editTlDragging && sc.scrollWidth > sc.clientWidth + 1) {
            const x = (seconds / lay.total) * sc.scrollWidth;
            // On a selected cut in the Trim mode the cut comes to the middle (_editTlTrimFollow); else a screenful on.
            const mid = this._editTlTrimMode && this._editTlEditPoint && this._editTlEditPoint();
            if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 8) sc.scrollLeft = Math.max(0, x - sc.clientWidth * (mid ? 0.5 : 0.1));
        }
        // The Inspector reads the selected clip at the playhead: its numbers when keyed, its diamonds.
        if (moved && !this.isPlaying && this.editPanelsRefresh && D.isClipSel(this._editTlSel)) {
            const c = D.clipOf(this._editTlCut, this._editTlSel), span = c && D.selSpan(this._editTlCut, this._editTlSel);
            const inside = !!span && seconds >= span.start && seconds < span.end;
            if (c && (D.hasKeys(c) || inside !== this._editInspInside)) this.editPanelsRefresh();
            this._editInspInside = inside;
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
     * track also takes films, for their sound. `room` ("video" / "audio"): let go in
     * the empty room above the top video or below the bottom sound track - what
     * belongs there goes onto a new track of that kind, in the same undo step.
     * `opts.insert`: Resolve's insert edit at `at` (the Add menu: at the
     * playhead) - films and pictures go in there in their order, on `opts.track`
     * (the video track of the selected clip, else V1), a shot there split around
     * them and what follows rippled (D.insertEdit); the playhead then stands at their end.
     */
    async _editTlAdd(items, at, track, room = "", opts = {}) {
        if (!this._editTlTab) this.editTlNew(true);            // no cut open: the clips start one
        const given = (items || []).filter(Boolean);
        if (!given.length) return;
        const { items: named, lost } = await this._editTlResolve(given);
        let onto = track ? D.trackOf(this._editTlCut, track) : null;
        const plan = [];
        let skipped = lost;
        for (const it of named) {
            const kind = this._editTlKindOf(it);
            if (!kind || it.isSequence) { skipped += 1; continue; }
            if (room === "video" && kind !== "sound") plan.push({ it, kind, where: "newtrack" });
            else if (room === "audio" && kind !== "still") plan.push({ it, kind, where: "newsound" });
            else if (room === "audio") plan.push({ it, kind, where: "V1" });
            else if (onto && onto.kind === "audio") {
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
        const ins = [];                 // an insert edit: the films and pictures, in their order
        if (plan.some((p) => p.where === "newtrack")) { cut = D.addTrack(cut, "video"); onto = cut.tracks[cut.tracks.length - 1]; }
        if (plan.some((p) => p.where === "newsound")) { cut = D.addTrack(cut, "audio"); soundId = cut.tracks[cut.tracks.length - 1].id; }
        for (const { it, where: place } of plan) {
            const where = place === "newtrack" ? "track" : place === "newsound" ? "sound" : place;
            let length = await this._editTlLength(it);
            if (!(length > 0)) { unread += 1; length = STILL_SECONDS; }
            const name = String(it.name || it.filename || it.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
            const clip = { file: it.path, name, length: D.toFrame(length, fps), color: it.color || "" };
            if (opts.insert && where !== "sound") { ins.push(clip); continue; }
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
            } else if (at != null && cut.clips.length && (D.gapAt(cut, moment) >= 0 || moment > D.mainLength(cut) + 1e-6)) {
                // Into a gap of V1, or past its end: placed at that moment (what does not fit there pushes the clips after it on).
                const got = D.insertAt(cut, clip, moment);
                cut = got.cut;
                sel = { kind: "clip", i: got.i };
                index = got.i + 1;
                moment = D.toFrame(moment + clip.length, fps);
            } else {
                cut = D.insertClip(cut, clip, index);
                sel = { kind: "clip", i: index };
                index += 1;
            }
        }
        let end = null, split = false;
        if (ins.length) {
            const got = D.insertEdit(cut, ins, start, opts.track || "V1");
            cut = got.cut;
            sel = got.sel;
            end = got.end;
            split = got.split;
            this._editTlMulti = null;
            this._editTlEditSel = null;
        }
        this._editTlSel = sel;
        this._editTlNote = [
            ins.length ? `${ins.length} clip(s) inserted at ${D.timecode(start, fps)}${split ? ", the shot there split" : ""}` : "",
            skipped ? `${skipped} item(s) left out` : "",
            unread ? `the length of ${unread} clip(s) could not be read - set it in the Inspector` : "",
        ].filter(Boolean).join(" · ");
        this._editTlRecord(this._editTlCut, cut);
        this._editTlCut = cut;
        this.editTlRefresh();
        // After an insert the playhead stands at the end of what went in, as Resolve's does.
        if (end != null) this._editTlSeek(end);
    },

    /** Where an insert from the Add menu goes: the video track of the selected clip, else V1. */
    _editTlInsertTrack() {
        const s = this._editTlSel, cut = this._editTlCut;
        const k = s && s.kind === "tclip" && cut ? D.trackOf(cut, s.track) : null;
        return k && k.kind !== "audio" ? k.id : "V1";
    },

    async _editTlAddNodes(nodes, at, track, room = "", opts = {}) {
        const items = [];
        // Several nodes go in left to right as they stand on the canvas (then top to bottom).
        for (const node of D.canvasOrder(nodes)) {
            try { items.push(...await nodeMediaClips(node)); } catch (_) {}
        }
        if (!items.length) {
            this._editTlNote = "that node holds no file to cut (a loader, a saved result or a path does)";
            this.editTlRefresh();
            return;
        }
        await this._editTlAdd(items, at, track, room, opts);
    },

    /** Add > Selected canvas nodes: an insert edit at the playhead (see _editTlAdd). */
    _editTlAddSelected() {
        return this._editTlAddNodes(selectedNodes(), this._editTlNowSeconds(), "", "", { insert: true, track: this._editTlInsertTrack() });
    },

    /** Add: files from disk, or what the canvas has selected. */
    _editTlAddMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const a = anchor.getBoundingClientRect();
        const cut = this._editTlTab ? this._editTlCut : null;
        const entries = [
            { label: "Files\u2026 (inserted at the playhead)", run: () => this._editTlAddFiles() },
            { label: "Selected canvas nodes (inserted at the playhead)", run: () => this._editTlAddSelected() },
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
        const has = !!(this._editTlCut && this._editTlCut.clips.length);
        const a = anchor.getBoundingClientRect();
        this._previzOpenMenu([
            { label: "Save cut (Ctrl+S)", disabled: !dirty, run: () => this._editTlSave() },
            { label: "Save cut as\u2026 (Ctrl+Shift+S)", disabled: !has, run: () => this.editTlSaveAsDialog() },
            { label: "Open cut\u2026", run: () => this.editTlOpenDialog() },
            { label: "Revert to saved", disabled: !dirty || !this._editTlSaved, run: () => this._editTlRevert() },
            "-",
            { label: "Export film\u2026", disabled: !has, run: () => this._editTlRender() },
            { label: "Export to Resolve\u2026", disabled: !has, run: () => this.editTlResolveDialog() },
        ], a.left, a.bottom + 2, anchor);
    },

    async _editTlAddFiles(track) {
        const onto = track ? D.trackOf(this._editTlCut, track) : null;
        const sound = !!onto && onto.kind === "audio";
        await this._editTlPicker({
            id: sound ? "sound" : "clip",
            title: onto ? `Add to ${onto.name}` : "Add clips",
            kind: "video",
            exts: sound ? [...SOUND_EXTS, ...FILM_EXTS] : [...FILM_EXTS, ...STILL_EXTS],
            multiple: true,
            go: "Add",
            note: (onto ? "Placed at the playhead, one after the other."
                        : "Inserted at the playhead: a shot there is split, what follows moves on.")
                + " Ctrl-click picks more than one.",
            onPick: async (files) => {
                const list = files.map((f) => ({ path: f.path, name: f.name, kind: f.kind }));
                if (onto) await this._editTlAdd(list, this._editTlNowSeconds(), track);
                else await this._editTlAdd(list, this._editTlNowSeconds(), "", "", { insert: true, track: this._editTlInsertTrack() });
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
            const room = this._editTlRoomAt(e.clientY);
            // After the canvas has finished its own handling of the release.
            (page.defaultView || window).setTimeout(() => {
                was.nodes.forEach((n, i) => { n.pos[0] = was.pos[i][0]; n.pos[1] = was.pos[i][1]; });
                if (app.graph && app.graph.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
                this._editTlAddNodes(was.nodes, at, track === "V1" || track === "T" || track === "A1" ? "" : track, room);
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
            this._editTlSaveFailed(said);
            return;
        }
        this._editTlSavedTo(data, creating ? "saved as " + (data.file || "a new timeline") : "saved");
    },

    // A save that did not happen says why, and stays said: the cut is still marked as not saved.
    _editTlSaveFailed(said) {
        const why = String(said || "no answer from the server").replace(/^not saved:\s*/i, "").slice(0, 400);
        this._editTlNote = "not saved";
        this._editTlSavedShow({ error: "Not saved: " + why });
        notice("error", "The cut was not saved", why);
        this.editTlRefresh();
    },

    // A save that happened: the panel works on the file as it now reads, and says where it is.
    _editTlSavedTo(data, note) {
        if (data.target) this._editTlTarget = data.target;
        this._editTlLoaded(data);
        this._editTlMulti = null;
        this._editTlEditSel = null;
        this._editTlNote = note;
        this._editTlSavedShow({ path: data.path || data.otio || "" });
        this.editTlRefresh();
    },

    /** The strip under the bar: "Saved to <the whole path>", Copy path, Show in file browser - or why it was not saved. */
    _editTlSavedShow({ path, error }) {
        const ui = this._editTlUi;
        if (!ui) return;
        const box = ui.savedBar, doc = box.ownerDocument, win = doc.defaultView || window;
        if (this._editTlSavedTimer) { win.clearTimeout(this._editTlSavedTimer); this._editTlSavedTimer = 0; }
        const hide = () => { box.style.display = "none"; };
        const btn = (label, title, fn) => {
            const b = doc.createElement("button");
            b.className = "edit-btn";
            b.textContent = label;
            b.title = title;
            b.addEventListener("click", fn);
            return b;
        };
        const text = doc.createElement("span");
        text.className = "edit-saved-text";
        text.textContent = error || "Saved to " + path;
        text.title = text.textContent;
        const parts = [text];
        if (!error) {
            const copy = btn("Copy path", "Copy the file's whole path", async () => { copy.textContent = (await this._editTlCopy(path)) ? "Copied" : "Could not copy"; });
            parts.push(copy);
            if (this.browseTo) parts.push(btn("Show in file browser", "Open the file browser at its folder", () => this.editTlShowInBrowser(path)));
        }
        parts.push(btn("\u2715", "Close", hide));
        box.replaceChildren(...parts);
        box.classList.toggle("error", !!error);
        box.style.display = "flex";
        box.style.top = (ui.body.querySelector(".edit-bar").offsetHeight + 4) + "px";
        // A failure stays until it is read; the path for long enough to be read.
        if (!error) this._editTlSavedTimer = win.setTimeout(hide, 15000);
    },

    async _editTlCopy(text) {
        const doc = this._editTlUi.body.ownerDocument, win = doc.defaultView || window;
        try { await win.navigator.clipboard.writeText(text); return true; } catch (_) {}
        const t = doc.createElement("textarea");
        t.value = text;
        doc.body.append(t);
        t.select();
        let ok = false;
        try { ok = doc.execCommand("copy"); } catch (_) {}
        t.remove();
        return ok;
    },

    editTlShowInBrowser(path) {
        const folder = String(path || "").replace(/[\\/][^\\/]*$/, "");
        if (this.setPanelDocked && !this.isPanelDocked("browser")) this.setPanelDocked("browser", true);
        if (this.browseTo) this.browseTo(folder, { force: true });
    },

    /** The file of the cut in the panel, or "" when it has not been saved. */
    editTlFilePath() {
        return this._editTlOtio || (this._editTlTarget && this._editTlTarget.path) || "";
    },

    /** Save cut as...: a name and a folder; the tab then works on the new file, the old one stays as it was. */
    async editTlSaveAsDialog() {
        const ui = this._editTlUi, cut = this._editTlCut;
        if (!ui || !cut) return;
        if (ui.dialog && ui.dialog.isConnected) ui.dialog.remove();
        const doc = ui.body.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const file = this.editTlFilePath();
        const stem = file ? file.split(/[\\/]/).pop().replace(/\.otio$/i, "") : (cut.name || "cut");
        let start = file ? file.replace(/[\\/][^\\/]*$/, "") : "";
        if (!start) {
            const where = await exportTarget("edit", stem, "otio", canvasContext());
            if (where && where.path) start = where.path.replace(/[\\/][^\\/]*$/, "");
        }
        const box = el("div", "edit-dialog edit-saveas");
        const head = el("div", "edit-dialog-head");
        const close = el("button", "edit-btn", "\u2715");
        close.title = "Close (Esc)";
        head.append(el("span", "edit-dialog-title", "Save cut as\u2026"), close);
        const name = el("input", "edit-saveas-name");
        name.value = stem;
        name.spellcheck = false;
        const folder = el("input", "edit-saveas-folder");
        folder.value = start;
        folder.spellcheck = false;
        const browse = el("button", "edit-btn edit-saveas-browse", "Browse\u2026");
        const row = (label, ...parts) => { const r = el("label", "edit-saveas-row"); r.append(el("span", "", label), ...parts); return r; };
        const go = el("button", "edit-btn primary edit-saveas-go", "Save");
        const yes = el("button", "edit-btn edit-saveas-yes", "Overwrite");
        yes.style.display = "none";
        const note = el("div", "edit-none edit-saveas-note", "Saved as .otio. The file it was opened from stays as it is; a later Save writes to the new one.");
        const shut = () => { box.remove(); ui.dialog = null; };
        const send = async (overwrite) => {
            go.disabled = yes.disabled = true;
            yes.style.display = "none";
            note.textContent = "Saving\u2026";
            let res = null, data = null, said = "";
            try {
                res = await api.fetchApi("/bepic/timeline_save_as", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: name.value, folder: folder.value, overwrite, edit: D.toSave(this._editTlCut),
                                           ...(this._editTlSaved && this._editTlTarget ? { source: this._editTlTarget } : {}) }),
                });
                if (res.status === 409) data = await res.json();
                else if (res.ok) data = await res.json();
                else said = (res.status === 404 || res.status === 405) ? "this ComfyUI does not know Save cut as yet: restart it" : await res.text();
            } catch (e) { said = String((e && e.message) || e); }
            go.disabled = yes.disabled = false;
            if (res && res.status === 409 && data) {
                note.textContent = `${String(data.path || "").split(/[\\/]/).pop()} is there already. Overwrite it?`;
                yes.style.display = "";
                return;
            }
            if (!data || !data.edit) {
                note.textContent = "Not saved: " + String(said || "no answer").replace(/^not saved:\s*/i, "");
                note.classList.add("error");
                return;
            }
            shut();
            this._editTlSavedTo(data, "saved as " + (data.file || ""));
            const label = String(data.file || "").replace(/\.otio$/i, "");
            if (label && this._editTlTab && this.tabLabels) {
                this.tabLabels[this._editTlTab] = "\u2702 " + label;
                if (this._rebuildTabBar) this._rebuildTabBar(null);
            }
        };
        close.addEventListener("click", shut);
        go.addEventListener("click", () => send(false));
        yes.addEventListener("click", () => send(true));
        browse.addEventListener("click", (e) => {
            e.preventDefault();
            this._editTlPicker({ id: "cut_folder", title: "Save cut as\u2026 into", kind: "edit", start: folder.value, folder: true, exts: [".otio"], go: "This folder",
                onPick: async ([f]) => { folder.value = f.path; return { ok: true }; } });
        });
        box.addEventListener("pointerdown", (e) => e.stopPropagation());
        box.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); shut(); }
            else if (e.key === "Enter") { e.preventDefault(); send(false); }
        });
        box.append(head, row("Name", name), row("Folder", folder, browse), go, yes, note);
        ui.body.append(box);
        this._editTlCentre(box);
        ui.dialog = box;
        name.focus();
        name.select();
    },

    /** Open cut...: pick a saved .otio. */
    editTlOpenDialog() {
        return this._editTlPicker({
            id: "cut", title: "Open cut", kind: "edit", exts: [".otio"], go: "Open",
            note: "A cut opens in a tab of its own. Where it was saved is in the Inspector's Timeline section.",
            onPick: async ([f]) => ((await this.editTlOpenPath(f.path)) ? { ok: true } : { ok: false, message: "That timeline could not be read." }),
        });
    },

    /** A saved cut, by its file: its tab if it is open, else a new one. */
    async editTlOpenPath(path) {
        this._editTlStash();
        const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
        const all = this._editTlAll();
        const open = Object.keys(all).find((k) => this.allTabs[k] && norm((all[k] && all[k].otio) || (all[k] && all[k].target && all[k].target.path)) === norm(path));
        if (open) { this._editTlWant(DOCK_ID, true); this.switchTab(open); return true; }
        return this.editTlOpenCutOf({ path, external: 1 });
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
        await this._editTlExportDialog({
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
        // A title whose font is not on this machine was drawn with another: the render says which.
        if (Array.isArray(got.notes) && got.notes.length) notice("warn", "Titles drawn with another font", got.notes.join(" / "));
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
