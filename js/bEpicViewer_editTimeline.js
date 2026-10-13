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
//   the buttons, top left   New (an empty cut, in its tab) · Add (files, or the
//                           nodes selected on the canvas) · Save / Export
//   drag on the ruler       scrub the film
//   click a shot            go to it (and to the cut's tab, from another one)
//   drag a shot's edge      trim it (what follows moves with it)
//   drag a shot             put it elsewhere in the order
//   drag a text / its edge  move it / make it longer or shorter
//   drop files onto it      from the file browser, the history strip, or a node
//                           dragged off the canvas: new clips, where they land
//   the line under it       the selected shot's name, in point, length and the
//                           dissolve into it, as numbers; a text's words
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
const PREFIX = "edit:";                       // an Edit tab's key (EditPlayMixin.isEditTab)
const STORE = "bepic.viewer.edits";           // the open cuts, across a reload
const hash = (text) => {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
};

export const EditTimelineMixin = {

    // ── opening ──────────────────────────────────────────────────────────────

    /** The timeline button, made on first use beside the layout button. */
    _editTlButton() {
        if (this._editTlBtn && this._editTlBtn.isConnected) return this._editTlBtn;
        const bar = this.container && this.container.querySelector(".transport");
        if (!bar) return null;
        const b = bar.ownerDocument.createElement("button");
        b.id = "edit-tl-btn";
        b.className = "sprite-icon edit-tl-btn";
        b.title = "Edit: the cut, to change and to play";
        b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
            + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<rect x="2" y="5" width="9" height="5" rx="1"/><rect x="13" y="5" width="9" height="5" rx="1"/>'
            + '<rect x="2" y="14" width="5" height="5" rx="1"/><rect x="9" y="14" width="13" height="5" rx="1"/></svg>';
        b.addEventListener("click", () => this.editTlToggle());
        const before = bar.querySelector("#layout-btn");
        // Beside the layout button - which the viewer wraps in a box of its own,
        // with an invisible menu laid over the whole box (.layout-picker-wrap). A
        // button put INSIDE that box sits under the menu: it shows the menu's
        // tooltip, a click opens the menu, and the wider box covers its neighbour.
        // So: before the box, in whatever holds the box.
        const at = before && (before.closest(".layout-picker-wrap") || before);
        if (at && at.parentNode) at.parentNode.insertBefore(b, at); else bar.append(b);
        this._editTlBtn = b;
        return b;
    },

    _editTlOpen() { return !!(this.isPanelDocked && this.isPanelDocked(DOCK_ID)); },

    /**
     * The transport's timeline button. On a film that has a cut beside it, it
     * opens that cut (its tab, and the panel); anywhere else it shows or hides
     * the panel.
     */
    async editTlToggle() {
        if (!this.setPanelDocked) return;
        if (this._editTlFilm && !this.isEditTab()) { await this.editTlOpenFilmCut(); return; }
        const open = !this._editTlOpen();
        // Put away by hand stays away: an Edit tab coming up no longer opens it.
        this._editTlAuto = open;
        this.setPanelDocked(DOCK_ID, open);
        this.editTlRefresh();
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
            target: this._editTlTarget || null, file: this._editTlFile || "",
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
        this._editTlSel = null;
        this._editTlNote = "";
        this._editTlNow = -1;
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
        if (this.setPanelDocked && !this._editTlOpen()) this.setPanelDocked(DOCK_ID, true);
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
        this._editTlButton();
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
    async editTlOpenFilmCut() {
        const film = this._editTlFilm;
        if (!film) return false;
        const key = PREFIX + "f" + hash(film.id);
        if (this.allTabs[key]) {
            if (this.setPanelDocked && !this._editTlOpen()) this.setPanelDocked(DOCK_ID, true);
            this.switchTab(key);
            return true;
        }
        const data = await this._editTlRead(film.obj);
        if (!data) { notice("warn", "No cut to open", "The timeline beside this film could not be read."); return false; }
        const name = data.edit.name || String(data.file || "cut").replace(/\.otio$/i, "");
        this._editTlOpenTab(key, name, { cut: data.edit, saved: data.edit, target: film.target, file: data.file || "" }, true);
        return true;
    },

    // An Edit tab came on screen (EditPlayMixin.editPlayEnter). `fresh`: from
    // another kind of tab - that is what brings the panel up with it.
    editTlTabShown(key, fresh) {
        if (fresh && this._editTlAuto !== false && this.setPanelDocked && !this._editTlOpen()) {
            this.setPanelDocked(DOCK_ID, true);
        }
        this.editTlRefresh();
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
        this._editTlSaved = data.edit;
        this._editTlCut = data.edit;
        this._editTlFile = data.file || "";
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
        const add = icon("icon-circle-plus", "+", "Add clips to the cut: files, or the nodes selected on the canvas",
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
        const film = button("Open this film\u2019s cut", "The film on screen has a timeline beside it: open it in an Edit tab",
                            () => this.editTlOpenFilmCut());
        const revert = button("Revert", "Throw away the changes since the last save", () => this._editTlRevert());
        const save = button("Save", "Write the cut into its timeline file", () => this._editTlSave());
        save.classList.add("primary");
        bar.append(fresh, add, out, film, sub, badge, revert, save);

        const area = el("div", "edit-area");
        const ruler = el("div", "edit-ruler");
        ruler.title = "Drag to scrub";
        const texts = el("div", "edit-track edit-texts");
        const shots = el("div", "edit-track edit-shots");
        const sound = el("div", "edit-track edit-sound");
        const head = el("div", "edit-head");
        const drop = el("div", "edit-drop");
        area.append(ruler, texts, shots, sound, head, drop);

        const inspect = el("div", "edit-inspect");
        const hint = el("div", "bepic-tool-hint");
        const empty = el("div", "curves-empty edit-empty");
        body.append(bar, area, inspect, hint, empty);
        host.append(body);

        // The ruler is the film's own scrub bar.
        ruler.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const go = (ev) => { const at = this._editTlTimeAt(ev.clientX); if (at != null) this._editTlSeek(at, true); };
            const up = () => {
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

        // New material: rows of the file browser, history thumbs, the viewport.
        body.addEventListener("dragover", (e) => {
            if (!this._editTlCarries(e)) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
            this._editTlDropMark(e.clientX);
        });
        body.addEventListener("dragleave", () => this._editTlDropMark(null));
        body.addEventListener("drop", (e) => {
            if (!this._editTlCarries(e)) return;
            e.preventDefault();
            e.stopPropagation();
            let payload = null;
            try { payload = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch (_) {}
            const at = this._editTlTimeAt(e.clientX);
            this._editTlDropMark(null);
            this._editTlAdd((payload && payload.items) || [], at);
        });
        this._editTlUi = { host, empty, body, sub, badge, revert, save, out, film, area, ruler, texts,
                           shots, sound, head, drop, inspect, hint };
        this._editTlWatchCanvas();
        return this._editTlUi;
    },

    _editTlCarries(e) {
        try { return Array.from(e.dataTransfer?.types || []).includes(DRAG_TYPE); } catch (_) { return false; }
    },

    /** Draw the panel from the cut as it stands. The one place it is drawn. */
    editTlRefresh() {
        const btn = this._editTlButton();
        const filmCut = !!(this._editTlFilm && !(this.isEditTab && this.isEditTab()));
        if (btn) {
            btn.classList.toggle("active", this._editTlOpen());
            btn.classList.toggle("has-cut", filmCut);
            btn.title = filmCut ? "Edit: open the cut of this film" : "Edit: the cut, to change and to play";
        }
        // With no cut in the panel, an Edit tab that is open takes its place.
        if (!this._editTlTab) {
            const first = this._editTlTabs()[0];
            if (first) this.editTlUse(first);
        }
        // The viewport plays the cut: a change is on screen with this redraw.
        if (this.editPlayCutChanged) this.editPlayCutChanged();
        if (this._editTlTab) this._editTlKeep();
        const host = this.editTimelinePanel;
        if (!host || !this._editTlOpen()) return;
        const ui = this._editTlBuild(host);
        const cut = this._editTlTab ? this._editTlCut : null;
        const has = !!(cut && cut.clips.length);
        const busy = !!this._editTlBusy;
        const dirty = this._editTlDirty();
        for (const part of [ui.area, ui.inspect, ui.hint]) part.style.display = has ? "" : "none";
        ui.empty.style.display = has ? "none" : "block";
        ui.empty.textContent = cut
            ? "This cut is empty. Add clips with the plus button, or drop them here - from the file browser, "
              + "the history strip, or a node dragged off the canvas."
            : "No cut is open. New starts one; so does adding or dropping clips here.";
        ui.film.style.display = filmCut ? "" : "none";
        ui.out.disabled = !has || busy;
        ui.save.disabled = !dirty || busy;
        ui.revert.disabled = !dirty || !this._editTlSaved || busy;
        ui.save.style.display = ui.revert.style.display = cut ? "" : "none";
        ui.badge.textContent = dirty ? (this._editTlSaved ? "changed \u2014 not saved" : "new cut \u2014 not saved") : "";
        ui.badge.className = "edit-badge" + (dirty ? " dirty" : "");
        if (!has) {
            this._editTlLay = null;
            ui.sub.textContent = cut ? (cut.name || "new cut") + (this._editTlNote ? " \u00b7 " + this._editTlNote : "") : "";
            return;
        }
        const lay = D.layoutCut(cut);
        this._editTlLay = lay;
        const n = cut.clips.length;
        ui.sub.textContent = `${cut.name || this._editTlFile || "new cut"} \u00b7 ${n} shot${n === 1 ? "" : "s"} \u00b7 `
            + D.lengthLabel(lay.total) + (this._editTlNote ? " \u00b7 " + this._editTlNote : "");
        ui.hint.textContent = (this._editTlOnScreen() ? "" : "Click a shot to bring this cut on screen. ")
            + "Drag on the ruler to scrub, a shot's edge to trim, a shot to reorder, a text to move. "
            + "Drop files or canvas nodes to add clips.";

        const doc = host.ownerDocument;
        const block = (cls, item, text) => {
            const b = doc.createElement("div");
            b.className = cls;
            b.style.left = item.left + "%";
            b.style.width = item.width + "%";
            b.title = item.title || "";
            if (text) b.textContent = text;
            return b;
        };
        ui.ruler.replaceChildren(...lay.ticks.map((t) => {
            const m = doc.createElement("div");
            m.className = "edit-tick";
            m.style.left = t.left + "%";
            m.textContent = t.label;
            return m;
        }));
        const sel = this._editTlSel;
        const kids = lay.shots.map((s) => {
            const b = block("edit-shot" + (sel && sel.kind === "clip" && sel.i === s.i ? " sel" : "")
                + (Number.isInteger(cut.clips[s.i].ref) ? "" : " new"), s, s.name);
            b.dataset.shot = String(s.i);
            b.addEventListener("pointerdown", (e) => this._editTlShotDown(e, b, s.i));
            b.addEventListener("pointermove", (e) => this._editTlEdgeCursor(e, b));
            return b;
        });
        for (const m of lay.mixes) kids.push(block("edit-mix", m, ""));
        ui.shots.replaceChildren(...kids);
        ui.texts.replaceChildren(...lay.texts.map((t) => {
            const b = block("edit-text" + (sel && sel.kind === "text" && sel.i === t.i ? " sel" : "")
                + (t.late ? " late" : ""), t, t.name);
            b.addEventListener("pointerdown", (e) => this._editTlTextDown(e, b, t.i));
            b.addEventListener("pointermove", (e) => this._editTlEdgeCursor(e, b));
            return b;
        }));
        ui.texts.style.display = lay.texts.length ? "" : "none";
        ui.sound.replaceChildren(...lay.sound.map((s) => block("edit-snd", s, s.name)));
        ui.sound.style.display = lay.sound.length ? "" : "none";
        this._editTlInspect();
        this._editTlNow = -1;
        this._editTlPlayhead();
    },

    // ── the line of numbers under the tracks ─────────────────────────────────

    _editTlInspect() {
        const ui = this._editTlUi;
        if (!ui) return;
        const cut = this._editTlCut;
        const sel = this._editTlSel;
        const doc = ui.host.ownerDocument;
        const fps = (cut && cut.fps) || 24;
        const field = (label, value, onChange, opts = {}) => {
            const wrap = doc.createElement("label");
            wrap.className = "edit-field" + (opts.wide ? " wide" : "");
            const span = doc.createElement("span");
            span.textContent = label;
            const input = doc.createElement("input");
            if (opts.text) { input.type = "text"; input.value = value; }
            else { input.type = "number"; input.step = "0.1"; input.min = "0"; input.value = String(Math.round(value * 1000) / 1000); }
            if (opts.disabled) input.disabled = true;
            input.addEventListener("change", () => onChange(opts.text ? input.value : D.toFrame(Number(input.value), fps)));
            // Typing a number must not reach the viewer's own hotkeys.
            input.addEventListener("keydown", (e) => e.stopPropagation());
            wrap.append(span, input);
            return wrap;
        };
        const button = (label, title, fn, disabled) => {
            const b = doc.createElement("button");
            b.className = "edit-btn";
            b.textContent = label;
            b.title = title;
            b.disabled = !!disabled;
            b.addEventListener("click", fn);
            return b;
        };
        if (!cut || !sel) {
            ui.inspect.replaceChildren(Object.assign(doc.createElement("span"),
                { className: "edit-none", textContent: "Select a shot or a text to change it by numbers." }));
            return;
        }
        if (sel.kind === "clip" && cut.clips[sel.i]) {
            const i = sel.i, c = cut.clips[i], n = cut.clips.length;
            ui.inspect.replaceChildren(
                field("shot " + (i + 1), c.name || "", (v) => this._editTlApply(D.renameClip(cut, i, v)), { text: true, wide: true }),
                field("in", c.in, (v) => this._editTlApply(D.setClipIn(cut, i, v))),
                field("length", c.length, (v) => this._editTlApply(D.trimEnd(cut, i, v))),
                field("dissolve in", c.transition || 0, (v) => this._editTlApply(D.setTransition(cut, i, v)), { disabled: i === 0 }),
                button("◀", "Earlier in the order", () => this._editTlMove(i, i - 1), i === 0),
                button("▶", "Later in the order", () => this._editTlMove(i, i + 1), i === n - 1),
                button("✕", "Take this shot out of the cut", () => {
                    this._editTlSel = null;
                    this._editTlApply(D.removeClip(cut, i));
                }, n <= 1),
            );
        } else if (sel.kind === "text" && cut.texts[sel.i]) {
            const i = sel.i, t = cut.texts[i];
            ui.inspect.replaceChildren(
                field("text", String(t.text || "").replace(/\n/g, " / "),
                      (v) => this._editTlApply(D.setText(cut, i, String(v).replace(/ \/ /g, "\n"))), { text: true, wide: true }),
                field("start", t.start, (v) => this._editTlApply(D.moveText(cut, i, v))),
                field("length", t.length, (v) => this._editTlApply(D.resizeText(cut, i, v))),
                button("✕", "Take this text off the film", () => {
                    this._editTlSel = null;
                    this._editTlApply(D.removeText(cut, i));
                }),
            );
        } else {
            this._editTlSel = null;
            this._editTlInspect();
        }
    },

    _editTlApply(cut) {
        this._editTlCut = cut;
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
        let moved = false;
        const move = (ev) => {
            const dx = ev.clientX - x0;
            if (!moved && Math.abs(dx) < DRAG_SLOP) return;
            moved = true;
            onMove(dx * perPx, ev);
        };
        const up = (ev) => {
            captor.removeEventListener("pointermove", move);
            captor.removeEventListener("pointerup", up);
            captor.removeEventListener("pointercancel", up);
            try { captor.releasePointerCapture(id); } catch (_) {}
            onUp(moved, ev);
        };
        captor.addEventListener("pointermove", move);
        captor.addEventListener("pointerup", up);
        captor.addEventListener("pointercancel", up);
    },

    _editTlShotDown(e, el, i) {
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const zone = this._editTlZone(e, el);
        const was = start.clips[i];
        this._editTlSel = { kind: "clip", i };
        this._editTlDrag(e, el, (seconds, ev) => {
            if (zone === "end") this._editTlCut = D.trimEnd(start, i, D.toFrame(was.length + seconds, fps));
            else if (zone === "start") this._editTlCut = D.trimStart(start, i, D.toFrame(seconds, fps));
            else { this._editTlDropMark(ev.clientX); return; }
            this.editTlRefresh();
        }, (moved, ev) => {
            this._editTlDropMark(null);
            if (moved && zone === "body") {
                const at = this._editTlTimeAt(ev.clientX);
                // Where it lands among the OTHERS: its own block is not a place to land.
                const others = D.removeClip(start, i);
                let to = at == null ? i : D.dropIndex(start.clips.length > 1 ? others : start, at);
                if (start.clips.length <= 1) to = 0;
                this._editTlMove(i, to);
                return;
            }
            if (!moved) this._editTlSeek(D.clipStarts(start)[i]);
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

    /** The line that shows where dropped or moved material will go. */
    _editTlDropMark(clientX) {
        const ui = this._editTlUi;
        if (!ui) return;
        const at = clientX == null ? null : this._editTlTimeAt(clientX);
        if (at == null || !this._editTlCut || !this._editTlLay) { ui.drop.style.display = "none"; return; }
        const cut = this._editTlCut;
        const idx = D.dropIndex(cut, at);
        const starts = D.clipStarts(cut);
        const where = idx < starts.length ? starts[idx] : this._editTlLay.total;
        ui.drop.style.display = "block";
        ui.drop.style.left = (where / this._editTlLay.total) * 100 + "%";
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
            if (this._editTlNow !== -2) {
                this._editTlNow = -2;
                for (const b of ui.shots.querySelectorAll(".edit-shot.on")) b.classList.remove("on");
            }
            return;
        }
        const fps = this._editTlCut.fps || 24;
        const seconds = ((this.currentFrame || 0) + 0.5) / fps;
        ui.head.style.display = "block";
        ui.head.style.left = Math.max(0, Math.min(100, (seconds / lay.total) * 100)) + "%";
        const at = D.playAt(this._editTlCut, seconds);
        const now = at ? at.i : -1;
        if (now === this._editTlNow) return;
        this._editTlNow = now;
        for (const b of ui.shots.querySelectorAll(".edit-shot")) {
            b.classList.toggle("on", b.dataset.shot === String(now));
        }
    },

    // ── new material ─────────────────────────────────────────────────────────

    // How long a file is. The server may not start a process to ask, but the
    // browser reads a video's header for nothing; a still stands for a while.
    _editTlLength(item) {
        if (item.length > 0) return Promise.resolve(item.length);
        if (item.kind !== "video") return Promise.resolve(STILL_SECONDS);
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

    /** Put files into the cut where they were dropped (`at` seconds; the end without it). */
    async _editTlAdd(items, at) {
        const usable = (items || []).filter((it) => it && it.path && !it.isSequence
            && (it.kind === "video" || it.kind === "image" || !it.kind));
        const skipped = (items || []).length - usable.length;
        if (!usable.length) {
            this._editTlNote = skipped ? "only single videos and pictures with a file can go into a cut" : "";
            this.editTlRefresh();
            return;
        }
        // No cut open: the clips start one, in a tab of its own - which stays
        // behind the tab they are being picked from.
        if (!this._editTlTab) this.editTlNew(false);
        let cut = this._editTlCut || D.emptyCut();
        let index = at == null || !cut.clips.length ? cut.clips.length : D.dropIndex(cut, at);
        let unread = 0;
        for (const it of usable) {
            let length = await this._editTlLength(it);
            if (!(length > 0)) { unread += 1; length = STILL_SECONDS; }
            const name = String(it.name || it.filename || it.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
            cut = D.insertClip(cut, { file: it.path, name, length: D.toFrame(length, cut.fps || 24) }, index);
            index += 1;
        }
        this._editTlSel = { kind: "clip", i: index - 1 };
        this._editTlNote = [
            skipped ? `${skipped} item(s) left out (sequences and 3D are not clips)` : "",
            unread ? `the length of ${unread} clip(s) could not be read - set it in the length field` : "",
        ].filter(Boolean).join(" · ");
        this._editTlCut = cut;
        if (this.setPanelDocked && !this._editTlOpen()) this.setPanelDocked(DOCK_ID, true);
        this.editTlRefresh();
    },

    async _editTlAddNodes(nodes, at) {
        const items = [];
        for (const node of nodes || []) {
            try { items.push(...await nodeMediaClips(node)); } catch (_) {}
        }
        if (!items.length) {
            this._editTlNote = "that node holds no file to cut (a loader, a saved result or a path does)";
            this.editTlRefresh();
            return;
        }
        await this._editTlAdd(items, at);
    },

    _editTlAddSelected() { return this._editTlAddNodes(selectedNodes(), null); },

    /** Add: files from disk, or what the canvas has selected. */
    _editTlAddMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const a = anchor.getBoundingClientRect();
        this._previzOpenMenu([
            { label: "Files\u2026", run: () => this._editTlAddFiles() },
            { label: "Selected canvas nodes", run: () => this._editTlAddSelected() },
        ], a.left, a.bottom + 2, anchor);
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

    async _editTlAddFiles() {
        await openFilePicker(this.container, {
            id: "clip",
            title: "Add clips",
            kind: "video",
            exts: [".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"],
            multiple: true,
            go: "Add",
            note: "Added at the end of the cut. Ctrl-click picks more than one.",
            onPick: async (files) => {
                await this._editTlAdd(files.map((f) => ({ path: f.path, name: f.name, kind: f.kind })), null);
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
            const at = this._editTlTimeAt(e.clientX);
            // After the canvas has finished its own handling of the release.
            (page.defaultView || window).setTimeout(() => {
                was.nodes.forEach((n, i) => { n.pos[0] = was.pos[i][0]; n.pos[1] = was.pos[i][1]; });
                if (app.graph && app.graph.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
                this._editTlAddNodes(was.nodes, at);
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
        const texts = this._editTlCut.texts.length;
        await openExportDialog(this.container, {
            title: "Export film",
            kind: "video",
            name: this._editTlCut.name || String(this._editTlFile || "cut").replace(/\.otio$/i, ""),
            formats: ["mp4", "mov"],
            values: this._editTlExport,
            go: "Render",
            note: texts ? `Its ${texts} text${texts === 1 ? " is" : "s are"} not drawn here: titles are drawn by `
                + "whatever made the timeline. The film it lies beside is left as it is." : "",
            onExport: (values, ui) => this._editTlExportRun(values, ui),
        });
    },

    async _editTlExportRun(values, ui) {
        this._editTlExport = { format: values.format, codec: values.codec, quality: values.quality };
        this._editTlBusy = true;
        this.editTlRefresh();
        ui.progress(0, 1, "Rendering…");
        let got = null, said = "";
        try {
            const res = await api.fetchApi("/bepic/timeline_render", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...this._editTlTarget, name: values.name, format: values.format,
                                       codec: values.codec, quality: values.quality, context: values.context }),
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
        this._editTlCut = this._editTlSaved;
        this._editTlSel = null;
        this._editTlNote = "";
        this.editTlRefresh();
    },
};
