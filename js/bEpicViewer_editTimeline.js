// bEpicViewer_editTimeline.js
// The Edit panel: the cut that lies beside a film, to read and to change.
//
// A film that was edited rather than generated usually has its edit next to it:
// an OpenTimelineIO file of the same name (agentY's edit stage writes one, and so
// can Resolve, Nuke Studio or Premiere). The panel (#edit-timeline-panel, dock id
// "editTimeline", the timeline button in the transport) draws it - a ruler, the
// texts, one block per shot with a mark on every dissolve, the sound - and lets
// it be cut:
//
//   drag a shot's edge      trim it (what follows moves with it)
//   drag a shot             put it elsewhere in the order
//   drag a text / its edge  move it / make it longer or shorter
//   drop files onto it      from the file browser, the history strip, or a node
//                           dragged off the canvas: new clips, where they land
//   the line under it       the selected shot's name, in point, length and the
//                           dissolve into it, as numbers; a text's words
//
// Save writes the cut back into the .otio (/bepic/timeline). NOTHING IS RENDERED:
// the viewer starts no process, so the film stays as it was until its maker
// renders the edited cut - the panel says so while the two differ. With no film
// on screen, dropping clips starts a new cut, saved into ComfyUI's output folder.
//
// What an edit does to a cut is worked out in bEpicViewer_editTimelineData.js
// (plain functions, run under node); this is the panel side. It is a dock panel
// like the curve editors, and like them it must work popped out into another
// window: elements come from the panel's own document, drags use pointer capture.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import * as D from "./bEpicViewer_editTimelineData.js";
import { nodeMediaClips, selectedNodes } from "./bEpicViewer_sendFromNode.js";
import { canvasContext, notice, openExportDialog } from "./bEpicViewer_exportUI.js";

const DOCK_ID = "editTimeline";
const EDGE_PX = 7;          // how close to a block's end a press is a trim
const DRAG_SLOP = 4;        // travel before a press on a shot becomes a move
const STILL_SECONDS = 3;
const DRAG_TYPE = "application/x-bepic-history";

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
        b.title = "Edit: the timeline of this film";
        b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
            + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<rect x="2" y="5" width="9" height="5" rx="1"/><rect x="13" y="5" width="9" height="5" rx="1"/>'
            + '<rect x="2" y="14" width="5" height="5" rx="1"/><rect x="9" y="14" width="13" height="5" rx="1"/></svg>';
        b.addEventListener("click", () => this.editTlToggle());
        const before = bar.querySelector("#layout-btn");
        if (before) bar.insertBefore(b, before); else bar.append(b);
        this._editTlBtn = b;
        return b;
    },

    _editTlOpen() { return !!(this.isPanelDocked && this.isPanelDocked(DOCK_ID)); },

    /** Open or close the panel (the transport's timeline button). */
    editTlToggle() {
        if (!this.setPanelDocked) return;
        const open = !this._editTlOpen();
        // Closed by hand stays closed: a film with a cut no longer opens it by itself.
        this._editTlAuto = open;
        this.setPanelDocked(DOCK_ID, open);
        this.editTlRefresh();
    },

    // A film came on screen (or left: pass null). Asks once per film. A cut with
    // changes that were not saved is not swept away by another film coming up.
    async editTlShow(obj) {
        this._editTlButton();
        const target = D.timelineTarget(obj);
        const key = target ? JSON.stringify(target) : "";
        if (key === this._editTlKey) return;
        if (this._editTlDirty()) { this._editTlPending = obj; this.editTlRefresh(); return; }
        // A cut of its own (started here, no film yet) stays up while films
        // without a timeline come and go: there is nowhere else to find it again.
        const own = !!(this._editTlCut && this._editTlTarget
            && String(this._editTlTarget.path || "").toLowerCase().endsWith(".otio"));
        const clear = () => {
            this._editTlTarget = null;
            this._editTlSaved = null;
            this._editTlCut = null;
            this._editTlSel = null;
        };
        this._editTlAsked = key;
        this._editTlPending = null;
        if (!own) { this._editTlKey = key; clear(); this.editTlRefresh(); }
        if (!target) return;
        let data = null;
        try {
            const res = await api.fetchApi("/bepic/timeline" + D.timelineQuery(obj));
            if (res.ok) data = await res.json();
        } catch (e) { data = null; }
        if (this._editTlAsked !== key || this._editTlDirty()) return;
        if (!data || !data.edit) return;
        this._editTlKey = key;
        this._editTlTarget = target;
        this._editTlLoaded(data);
        // A film with a cut brings its panel up, unless it was put away by hand.
        if (this._editTlAuto !== false && this.setPanelDocked && !this._editTlOpen()) {
            this.setPanelDocked(DOCK_ID, true);
        }
        this.editTlRefresh();
    },

    _editTlLoaded(data) {
        this._editTlSaved = data.edit;
        this._editTlCut = data.edit;
        this._editTlFile = data.file || "";
        this._editTlSel = null;
        // What a render just said stays up when its film comes on screen.
        this._editTlNote = this._editTlKeepNote || "";
        this._editTlKeepNote = "";
    },

    _editTlDirty() {
        if (!this._editTlCut) return false;
        if (!this._editTlSaved) return this._editTlCut.clips.length > 0;      // a new cut, never saved
        return !D.sameCut(this._editTlCut, this._editTlSaved);
    },

    // Does the film on screen show THIS cut? Not once the cut was changed, here
    // or in an earlier session (the file is stamped when it is saved from here).
    _editTlIsFilm() {
        return !!(this._editTlSaved && this._editTlTarget && this._videoMode
            && !this._editTlSaved.edited && !this._editTlDirty()
            && !String(this._editTlTarget.path || "").toLowerCase().endsWith(".otio"));
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
        const empty = el("div", "curves-empty");
        const body = el("div", "edit-body");

        const bar = el("div", "edit-bar");
        const sub = el("div", "curves-sub edit-sub");
        const badge = el("div", "edit-badge");
        const button = (label, title, fn) => {
            const b = el("button", "edit-btn", label);
            b.title = title;
            b.addEventListener("click", fn);
            return b;
        };
        const add = button("＋ nodes", "Add the media of the nodes selected on the canvas as clips",
                           () => this._editTlAddSelected());
        const revert = button("Revert", "Throw away the changes since the last save", () => this._editTlRevert());
        const save = button("Save", "Write the cut into the timeline file. The film is not rendered again.",
                            () => this._editTlSave());
        save.classList.add("primary");
        const render = button("Export…", "Export this cut as a film, rendered here in the viewer: picture, "
            + "dissolves and sound. Texts are not drawn. The film it lies beside is left as it is.",
            () => this._editTlRender());
        bar.append(sub, badge, add, revert, save, render);

        const area = el("div", "edit-area");
        const ruler = el("div", "edit-ruler");
        const texts = el("div", "edit-track edit-texts");
        const shots = el("div", "edit-track edit-shots");
        const sound = el("div", "edit-track edit-sound");
        const head = el("div", "edit-head");
        const drop = el("div", "edit-drop");
        area.append(ruler, texts, shots, sound, head, drop);

        const inspect = el("div", "edit-inspect");
        const hint = el("div", "bepic-tool-hint",
            "Drag a shot's edge to trim, a shot to reorder, a text to move. Drop files or canvas nodes to add clips.");
        body.append(bar, area, inspect, hint);
        host.append(empty, body);

        // New material: rows of the file browser, history thumbs, the viewport.
        for (const zone of [body, empty]) {
            zone.addEventListener("dragover", (e) => {
                if (!this._editTlCarries(e)) return;
                e.preventDefault();
                try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
                this._editTlDropMark(e.clientX);
            });
            zone.addEventListener("dragleave", () => this._editTlDropMark(null));
            zone.addEventListener("drop", (e) => {
                if (!this._editTlCarries(e)) return;
                e.preventDefault();
                e.stopPropagation();
                let payload = null;
                try { payload = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch (_) {}
                const at = this._editTlTimeAt(e.clientX);
                this._editTlDropMark(null);
                this._editTlAdd((payload && payload.items) || [], at);
            });
        }
        this._editTlUi = { host, empty, body, sub, badge, add, revert, save, render, area, ruler, texts,
                           shots, sound, head, drop, inspect };
        this._editTlWatchCanvas();
        return this._editTlUi;
    },

    _editTlCarries(e) {
        try { return Array.from(e.dataTransfer?.types || []).includes(DRAG_TYPE); } catch (_) { return false; }
    },

    /** Draw the panel from the cut as it stands. The one place it is drawn. */
    editTlRefresh() {
        const btn = this._editTlButton();
        if (btn) {
            btn.classList.toggle("active", this._editTlOpen());
            btn.classList.toggle("has-cut", !!this._editTlCut);
        }
        const host = this.editTimelinePanel;
        if (!host || !this._editTlOpen()) return;
        const ui = this._editTlBuild(host);
        const cut = this._editTlCut;
        const has = !!(cut && cut.clips.length);
        ui.body.style.display = has ? "flex" : "none";
        ui.empty.style.display = has ? "none" : "block";
        ui.empty.textContent = "This film has no timeline beside it. Drop clips here - from the file browser, "
            + "the history strip, or a node dragged off the canvas - to start a new cut.";
        if (!has) return;
        const lay = D.layoutCut(cut);
        this._editTlLay = lay;
        const dirty = this._editTlDirty();
        const isFilm = this._editTlIsFilm();
        const n = cut.clips.length;
        ui.sub.textContent = `${cut.name || this._editTlFile || "new cut"} · ${n} shot${n === 1 ? "" : "s"} · `
            + D.lengthLabel(lay.total) + (this._editTlNote ? " · " + this._editTlNote : "");
        ui.badge.textContent = dirty ? (this._editTlSaved ? "changed — not saved" : "new cut — not saved")
            : (isFilm ? "" : (this._editTlSaved && this._editTlSaved.edited
                ? "saved — the film has not been rendered again" : ""));
        ui.badge.className = "edit-badge" + (dirty ? " dirty" : "");
        ui.badge.title = this._editTlPending ? "Another film came on screen: save or revert to see its cut." : "";
        ui.save.disabled = !dirty || !!this._editTlBusy;
        ui.revert.disabled = !dirty || !this._editTlSaved || !!this._editTlBusy;
        ui.render.disabled = !!this._editTlBusy;
        ui.render.textContent = this._editTlBusy ? "Rendering…" : "Export…";

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
        this._editTlPlayhead();
    },

    // Kept for the playback mixin, which calls it when a film's length is known.
    _editTlDraw() { this.editTlRefresh(); },

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

    // Go to a moment of the film - only while the film on screen IS this cut.
    _editTlSeek(seconds) {
        if (!this._editTlIsFilm()) return;
        const fps = this._videoFps || this.fps || 24;
        if (this.stop && this.isPlaying) this.stop();
        this.setFrame(Math.max(0, Math.ceil(seconds * fps - 1e-6)));
    },

    // The line that follows the frame. Called whenever the frame moves
    // (_toolsFrameChanged), so it has to cost nothing while the panel is away.
    _editTlPlayhead() {
        const ui = this._editTlUi;
        const lay = this._editTlLay;
        if (!ui || !lay || !ui.body.isConnected || !this._editTlOpen()) return;
        if (!this._editTlIsFilm() || !(lay.total > 0)) { ui.head.style.display = "none"; return; }
        const fps = this._videoFps || this.fps || 24;
        const seconds = ((this.currentFrame || 0) + 0.5) / fps;
        ui.head.style.display = "block";
        ui.head.style.left = Math.max(0, Math.min(100, (seconds / lay.total) * 100)) + "%";
        const now = D.clipAt(this._editTlCut, seconds);
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
        if (!this._editTlCut) {                  // the first clips of a new cut
            this._editTlSaved = null;
            this._editTlTarget = null;
            this._editTlKey = "new";
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
        if (data.target) { this._editTlTarget = data.target; this._editTlKey = JSON.stringify(data.target); }
        this._editTlLoaded(data);
        this._editTlNote = creating ? "saved as " + (data.file || "a new timeline") : "saved";
        this.editTlRefresh();
        // A film that came on screen while this cut had unsaved changes.
        if (this._editTlPending) { const next = this._editTlPending; this._editTlPending = null; this.editTlShow(next); }
    },

    // Export the cut as a film, rendered in the viewer. What is rendered is the
    // SAVED cut, so unsaved changes are saved first. The dialog is the one every
    // export uses (bEpicViewer_exportUI.js): name, format, codec, quality, and
    // where it will land, by the rule all exports follow.
    async _editTlRender() {
        if (this._editTlBusy || !this._editTlCut || !this._editTlCut.clips.length) return;
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
        this._editTlKeepNote = this._editTlNote;
        this.editTlRefresh();
        notice("success", "Film exported" + (left ? ` - without its ${left} text${left === 1 ? "" : "s"}` : ""),
               "output/" + (got.relative || got.name));
        // Up on screen, in a tab of its own; its timeline is read with it.
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
        if (this._editTlPending) { const next = this._editTlPending; this._editTlPending = null; this.editTlShow(next); }
    },
};
