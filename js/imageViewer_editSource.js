// imageViewer_editSource.js
// The Edit tab's Source viewer, as Resolve's source monitor beside its timeline
// viewer: a file loaded on its own - a film, a still or a sound - with its own
// playhead and its own in / out, and the edits that bring the marked part into
// the cut: three-point editing.
//
// It is no dock panel: it stands in the main area LEFT of the picture
// (`editSourcePanel`, `.src-monitor`, made in imageViewer.js before #viewport),
// and only with a cut's tab. Two layouts, Resolve's Single / Dual Viewer:
// dual - the source left, the timeline's picture right, side by side; single -
// one viewer, showing the source OR the timeline, Q switching (`editSrcSwap`).
// On / off with the bar's Source viewer button or the Timeline group's item
// (`editSrcToggle`, kept as `_editTlWanted().editSource`); the layout and what a
// single viewer shows in localStorage `imageviewer.viewer.editViewer`.
//
//   F9  Insert          Shift+F9   -
//   F10 Overwrite       Shift+F10  Ripple overwrite
//   F11 Replace         Shift+F11  Fit to fill
//   F12 Place on top    Shift+F12  Append at end
//
// The edits are buttons in the timeline's own bar (SOURCE_BUTTONS, their icons
// in imageViewer_editIcons.js). The three points (`D.threePoint`): the source's
// in / out and the timeline's in / out (the transport's range,
// `_editTlRangeSeconds`), the timeline's playhead standing in for its in; the
// fourth follows. The edit itself is `D.sourceEdit`, one undo step through
// `_editTlApply`. Where it goes is Resolve's track patching: while the Source
// viewer is up every track header has a patch box at its left; the source's V1
// box stands on the video track a picture goes to, its A1 box on the sound
// track a sound goes to, and a click on another track's box moves it there
// (`editSrcPatchTo`; `view.srcTrack` / `view.srcAudio`, V1 / the first sound
// track when nothing was patched).
//
// Loaded by a drop (the History's thumbnails, the file browser's rows, files
// from the desktop - the same items a drop on the timeline takes, through
// `_editTlResolve`), by the clip menu's "Open in Source viewer", and by Match
// frame (F) while it is up. Shift+F is the way back: the playhead to where the
// cut shows the source's frame (`D.findSource`).
//
// The source's time is counted in the cut's frames: its playhead and marks land
// on 1/fps of the cut. Kept per viewer in localStorage (`imageviewer.viewer.editSource`).
import * as D from "./imageViewer_editTimelineData.js";
import { setEditIcon } from "./imageViewer_editIcons.js";

export const SOURCE_ID = "editSource";
const STORE = "imageviewer.viewer.editSource";
const VIEWER_STORE = "imageviewer.viewer.editViewer";
const DRAG_TYPE = "application/x-imageviewer-history";
const STILL_SECONDS = 3;
const SOUND = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;
const STILL = /\.(png|jpe?g|webp|tiff?|gif|bmp|avif|exr)$/i;

/** The edit buttons, in their order: [kind, label, key, shift, icon]. */
export const SOURCE_BUTTONS = [
    ["insert", "Insert", "F9", false, "srcInsert"],
    ["overwrite", "Overwrite", "F10", false, "srcOverwrite"],
    ["replace", "Replace", "F11", false, "srcReplace"],
    ["place", "Place on top", "F12", false, "srcPlace"],
    ["ripple", "Ripple overwrite", "F10", true, "srcRipple"],
    ["fit", "Fit to fill", "F11", true, "srcFit"],
    ["append", "Append at end", "F12", true, "srcAppend"],
];

/** The edit a function key stands for: (key, shift) -> kind, or "". */
export function sourceEditKey(key, shift) {
    const hit = SOURCE_BUTTONS.find((b) => b[2] === key && b[3] === !!shift);
    return hit ? hit[0] : "";
}

export const EditSourceMixin = {

    /** The Source viewer is wanted on the cut's tab (whether a single viewer shows it or the timeline). */
    _editSrcOn() {
        return !!(this.isEditTab && this.isEditTab() && this._editTlWanted && this._editTlWanted()[SOURCE_ID]);
    },

    /** It is on screen. */
    _editSrcUp() {
        if (!this._editSrcOn()) return false;
        const v = this._editSrcViewer();
        return v.mode === "dual" || v.show === "source";
    },

    /** { mode: "dual" | "single", show: "source" | "timeline" } (what a single viewer shows). */
    _editSrcViewer() {
        if (this._editSrcV) return this._editSrcV;
        let kept = null;
        try { kept = JSON.parse(window.localStorage.getItem(VIEWER_STORE) || "null"); } catch (_) {}
        kept = kept && typeof kept === "object" ? kept : {};
        this._editSrcV = { mode: kept.mode === "single" ? "single" : "dual", show: kept.show === "timeline" ? "timeline" : "source" };
        return this._editSrcV;
    },

    _editSrcViewerKeep() {
        try { window.localStorage.setItem(VIEWER_STORE, JSON.stringify(this._editSrcViewer())); } catch (_) {}
    },

    /** The Source viewer on / off (`on` omitted: the other way). */
    editSrcToggle(on) {
        if (!this.isEditTab || !this.isEditTab()) return false;
        const go = on === undefined ? !this._editSrcOn() : !!on;
        if (this._editTlWant) this._editTlWant(SOURCE_ID, go);
        if (go && this._editSrcViewer().mode === "single") this._editSrcViewer().show = "source";
        this._editSrcViewerKeep();
        this._editSrcLayout();
        if (this.editTlRefresh) this.editTlRefresh();
        if (this.barGroupsSync) this.barGroupsSync();
        return go;
    },

    /** Single or dual viewer (`mode` omitted: the other one), as Resolve's Workspace > Single Viewer Mode. */
    editSrcViewerMode(mode) {
        const v = this._editSrcViewer();
        v.mode = mode === "single" || mode === "dual" ? mode : v.mode === "dual" ? "single" : "dual";
        if (v.mode === "single") v.show = "source";
        this._editSrcViewerKeep();
        if (!this._editSrcOn()) { this.editSrcToggle(true); return v.mode; }
        this._editSrcLayout();
        if (this.editTlRefresh) this.editTlRefresh();
        return v.mode;
    },

    /** Q: a single viewer shows the other one - the source or the timeline. In dual mode: nothing. */
    editSrcSwap(show) {
        const v = this._editSrcViewer();
        if (!this._editSrcOn()) { if (show !== "timeline") this.editSrcToggle(true); return; }
        if (v.mode !== "single") return;
        v.show = show === "source" || show === "timeline" ? show : v.show === "source" ? "timeline" : "source";
        if (v.show === "source" && this.isPlaying && this.stop) this.stop();
        if (v.show === "timeline" && this._editSrcPlaying) this.editSrcPlay(false);
        this._editSrcViewerKeep();
        this._editSrcLayout();
        if (this.editTlRefresh) this.editTlRefresh();
    },

    /**
     * Make the main area match: the Source viewer left of the picture (dual), in its place (single,
     * showing the source), or gone. `onTab` false: a tab that is no cut's came up - it goes.
     */
    _editSrcLayout(onTab = true) {
        const host = this.editSourcePanel, vp = this.viewport;
        if (!host) return;
        const up = onTab && this._editSrcUp();
        const v = this._editSrcViewer();
        const alone = up && v.mode === "single";
        const was = host.style.display !== "none", wasHidden = !!(vp && vp.style.display === "none");
        host.style.display = up ? "flex" : "none";
        host.classList.toggle("single", alone);
        host.classList.toggle("dual", up && !alone);
        if (vp) vp.style.display = alone ? "none" : "";
        if (up && !was) this.editSrcRender();
        if (!up && this._editSrcPlaying) this.editSrcPlay(false);
        if ((was !== up || wasHidden !== alone) && this._afterViewportMoved) this._afterViewportMoved();
        this._editSrcCtlPlace();
        const ui = this._editTlUi;
        if (ui && ui.srcView) this._editSrcButtons(ui);
    },

    /**
     * The viewers' layout switch (single / dual) and, in single, the source / timeline swap: ONE small
     * group at the top right of whichever viewer stands at the right - the timeline's (`#viewport`) while
     * it is on screen, else the Source viewer's head - so it is always there and always at the right.
     */
    _editSrcCtlPlace() {
        const host = this.editSourcePanel, vp = this.viewport;
        if (!host) return;
        const doc = host.ownerDocument;
        let ctl = this._editSrcCtl;
        if (!ctl || ctl.ownerDocument !== doc) {
            if (ctl) ctl.remove();
            ctl = doc.createElement("div");
            ctl.className = "src-viewctl";
            const small = (icon, cls, fn) => {
                const b = doc.createElement("button");
                b.className = "edit-btn src-hbtn " + cls;
                setEditIcon(b, icon);
                b.addEventListener("pointerdown", (e) => e.stopPropagation());     // not a pan of the viewer
                b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
                return b;
            };
            // Only the layout switch: Q (and the bar's caret menu) swap a single viewer.
            ctl.append(small("dualViewer", "src-mode", () => this.editSrcViewerMode()));
            this._editSrcCtl = ctl;
        }
        const up = this._editSrcOn(), v = this._editSrcViewer();      // on, even while a single viewer shows the timeline
        const showsSource = v.mode === "single" && v.show === "source";
        const head = host.querySelector(":scope > .src-body > .src-head");
        const home = !up ? null : showsSource ? head : vp;
        if (!home) { ctl.remove(); return; }
        if (ctl.parentNode !== home) {
            if (home === head) head.insertBefore(ctl, head.querySelector(".src-close"));
            else home.append(ctl);
        }
        ctl.classList.toggle("in-head", home === head);
        const dual = v.mode === "dual";
        // ONE toggle, as the bar's other switches: lit while the two viewers stand side by side.
        const mode = ctl.querySelector(".src-mode");
        mode.classList.toggle("on", dual);
        mode.setAttribute("aria-pressed", dual ? "true" : "false");
        mode.title = dual ? "Dual viewer: on (source | timeline) - click for a single viewer"
                          : "Dual viewer: off - click for source and timeline side by side";
        this._editMonBarPlace();
        this._editMonShow();
    },

    // ── the two monitors: the timeline viewer's own bar, which one is active ──

    /** Both viewers on screen side by side (dual, the Source viewer up on a cut's tab). */
    _editMonDual() {
        return !!(this._editSrcUp && this._editSrcUp() && this._editSrcViewer().mode === "dual");
    },

    /** The timeline viewer (#viewport) is on screen on a cut's tab with the Source viewer on. */
    _editMonTlShown() {
        if (!this._editSrcOn || !this._editSrcOn()) return false;
        const v = this._editSrcViewer();
        return v.mode === "dual" || v.show === "timeline";
    },

    /**
     * Which monitor the playback keys drive: "source" or "timeline". With one of them on
     * screen, that one; side by side, the one clicked last (Resolve's active viewer).
     */
    editMonActive() {
        const src = !!(this._editSrcUp && this._editSrcUp()), tl = this._editMonTlShown();
        if (src && !tl) return "source";
        if (!src) return "timeline";
        return this._editMon === "source" ? "source" : "timeline";
    },

    /** Make `which` ("source" / "timeline") the active monitor (a click on it does). */
    editMonSet(which) {
        this._editMon = which === "source" ? "source" : "timeline";
        this._editMonShow();
        return this.editMonActive();
    },

    /** The white outline round the active monitor's picture - only while both stand side by side. */
    _editMonShow() {
        const dual = this._editMonDual(), act = this.editMonActive();
        if (this.editSourcePanel) this.editSourcePanel.classList.toggle("mon-active", dual && act === "source");
        if (this.viewport) this.viewport.classList.toggle("mon-active", dual && act === "timeline");
        this._editMonWire();
    },

    /** A press on the timeline viewer makes it the active one (once per element; it survives a pop-out). */
    _editMonWire() {
        const vp = this.viewport;
        if (!vp || vp._imageViewerMonWired) return;
        vp._imageViewerMonWired = true;
        vp.addEventListener("pointerdown", () => {
            if (this._editMonTlShown() && this.isEditTab && this.isEditTab()) this.editMonSet("timeline");
        }, true);
    },

    /**
     * A key for the monitors (asked by handleKeyDown after the timeline's own keys): with the
     * Source viewer focused, or active and the viewer hovered, its keys; with the timeline viewer
     * active and hovered, the timeline's transport keys (J K L, I O, X, Home End, Up Down, arrows).
     * -> true when it was taken.
     */
    editMonKeyDown(e) {
        if (!this._editSrcUp || !this._editSrcUp()) return false;
        if (!this.isEditTab || !this.isEditTab()) return false;
        const path = e.composedPath ? e.composedPath() : [];
        const t = path[0];
        if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable)) return false;
        if (path.some((n) => n && n.classList && n.classList.contains("edit-dialog"))) return false;
        const body = this.editSourcePanel.querySelector(":scope > .src-body");
        const inSrc = !!body && path.includes(body);
        const act = this.editMonActive();
        if (inSrc || (act === "source" && this.isHovered)) {
            if (e.ctrlKey || e.metaKey) return false;
            this._editSrcKey(e);
            if (!e.defaultPrevented) return false;
            e.stopImmediatePropagation();
            return true;
        }
        if (act !== "timeline" || !this.isHovered || !this._editTlCut || !this.editTlKeyDown) return false;
        if (e.ctrlKey || e.metaKey) return false;
        const low = String(e.key).toLowerCase();
        const letter = /^Key[A-Z]$/.test(e.code || "") ? e.code.slice(3).toLowerCase() : low;
        const transport = ["j", "k", "l", "i", "o", "x"].includes(letter)
            || ["Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);
        if (!transport) return false;
        this._editTlKeyForce = true;
        try { return !!this.editTlKeyDown(e); } finally { this._editTlKeyForce = false; }
    },

    /**
     * The timeline viewer's own bar (as the Source viewer's): the cut's scrub bar with its in / out,
     * play and the timecode, at the bottom of #viewport while the Source viewer is on - the same
     * playhead as the Edit timeline's (currentFrame), so the two are one.
     */
    _editMonBarPlace() {
        const vp = this.viewport;
        if (!vp) return;
        const doc = vp.ownerDocument;
        let bar = this._editMonBar;
        if (!bar || bar.ownerDocument !== doc) {
            if (bar) bar.remove();
            const el = (tag, cls, text) => {
                const n = doc.createElement(tag);
                if (cls) n.className = cls;
                if (text !== undefined) n.textContent = text;
                return n;
            };
            bar = el("div", "tl-monbar");
            const scrub = el("div", "src-scrub tlm-scrub");
            scrub.append(el("div", "src-range"), el("div", "src-line"));
            scrub.addEventListener("pointerdown", (e) => this._editMonScrubDown(e, scrub));
            const row = el("div", "src-row");
            const play = el("button", "edit-btn src-btn tlm-play", "▶");
            play.title = "Play / stop the cut (Space, with the timeline viewer active)";
            play.addEventListener("click", (e) => {
                e.stopPropagation();
                this.editMonSet("timeline");
                if (this.isPlaying) this.stop(); else this.play();
                this._editMonBarDraw();
            });
            const name = el("div", "src-name tlm-name", "Timeline");
            row.append(play, el("div", "src-tc tlm-tc"), name);
            bar.append(scrub, row);
            // Its own presses are not the viewer's pan, zoom or tools.
            for (const ev of ["mousedown", "pointerdown", "wheel", "dblclick", "contextmenu"]) {
                bar.addEventListener(ev, (e) => { e.stopPropagation(); if (ev === "pointerdown") this.editMonSet("timeline"); });
            }
            this._editMonBar = bar;
        }
        const show = this._editMonTlShown() && !!(this.isEditTab && this.isEditTab());
        // The viewer's path line stands where the bar does: the bar says it instead (_editMonBarDraw).
        vp.classList.toggle("has-monbar", show);
        if (!show) { bar.remove(); return; }
        if (bar.parentNode !== vp) vp.append(bar);
        this._editMonBarDraw();
    },

    /** The timeline viewer's bar as the frame stands (from _editTlPlayhead, once a frame). */
    _editMonBarDraw() {
        const bar = this._editMonBar, cut = this._editTlCut;
        if (!bar || !bar.isConnected || !cut) return;
        const fps = cut.fps || 24;
        const frames = Math.max(1, D.filmFrames(cut));
        const f = this.currentFrame || 0;
        const share = (fr) => Math.max(0, Math.min(1, fr / frames)) * 100;
        bar.querySelector(".src-line").style.left = share(f) + "%";
        const range = bar.querySelector(".src-range"), pr = this.playbackRange;
        if (pr && Number.isFinite(pr.start) && Number.isFinite(pr.end)) {
            range.style.display = "";
            range.style.left = share(pr.start) + "%";
            range.style.width = Math.max(0, share(pr.end + 1) - share(pr.start)) + "%";
        } else range.style.display = "none";
        let text = D.timecode(f / fps, fps);
        if (pr && Number.isFinite(pr.start) && Number.isFinite(pr.end)) {
            text += `  in ${D.timecode(pr.start / fps, fps)}  out ${D.timecode((pr.end + 1) / fps, fps)}  (${pr.end - pr.start + 1} fr)`;
        }
        const tc = bar.querySelector(".tlm-tc");
        if (tc.textContent !== text) tc.textContent = text;
        bar.dataset.head = String(f);
        const play = bar.querySelector(".tlm-play");
        const p = this.isPlaying ? "■" : "▶";
        if (play.textContent !== p) play.textContent = p;
        const name = bar.querySelector(".tlm-name");
        const pathBar = this.viewport && this.viewport.querySelector(":scope > .path-bar");
        const label = (pathBar && pathBar.textContent.trim()) || cut.name || "Timeline";
        if (name.textContent !== label) name.textContent = label;
    },

    _editMonScrubDown(e, scrub) {
        const cut = this._editTlCut;
        if (!cut || e.button !== 0) return;
        e.preventDefault();
        const frames = Math.max(1, D.filmFrames(cut));
        const at = (ev) => {
            const r = scrub.getBoundingClientRect();
            return Math.max(0, Math.min(frames - 1, Math.floor(((ev.clientX - r.left) / Math.max(1, r.width)) * frames)));
        };
        if (this.isPlaying) this.stop();
        const go = (ev) => { this.setFrame(at(ev)); if (this.editScrubAt) this.editScrubAt((this.currentFrame || 0) / (cut.fps || 24)); };
        go(e);
        const win = scrub.ownerDocument.defaultView || window;
        const up = () => { win.removeEventListener("pointermove", go); win.removeEventListener("pointerup", up); };
        win.addEventListener("pointermove", go);
        win.addEventListener("pointerup", up);
    },

    // ── the Source viewer's pan and zoom: the timeline viewer's (setupZoomAndPan) ──

    _editSrcZoomState() {
        if (!this._editSrcZ) this._editSrcZ = { zoom: 1, x: 0, y: 0 };
        return this._editSrcZ;
    },

    _editSrcTransform() {
        const z = this._editSrcZoomState(), m = this._editSrcEl;
        if (!m) return;
        m.style.transform = z.zoom === 1 && !z.x && !z.y ? "" : `translate(${z.x}px, ${z.y}px) scale(${z.zoom})`;
        const host = this.editSourcePanel, body = host && host.querySelector(":scope > .src-body");
        if (body) body.dataset.zoom = String(Math.round(z.zoom * 100) / 100);
    },

    /** F: the source fits its viewer again. */
    editSrcFit() {
        this._editSrcZ = { zoom: 1, x: 0, y: 0 };
        this._editSrcTransform();
    },

    /** Zoom keeping the point under (clientX, clientY) where it is, as the viewer's _zoomAt. */
    _editSrcZoomAt(zoom, clientX, clientY) {
        const z = this._editSrcZoomState();
        const host = this.editSourcePanel, view = host && host.querySelector(".src-view");
        zoom = Math.max(0.05, Math.min(zoom, 20));
        if (view) {
            const r = view.getBoundingClientRect();
            if (r.width && r.height) {
                const sx = clientX - r.left - r.width / 2, sy = clientY - r.top - r.height / 2;
                const ratio = zoom / (z.zoom || 1);
                z.x = sx - ratio * (sx - z.x);
                z.y = sy - ratio * (sy - z.y);
            }
        }
        z.zoom = zoom;
        this._editSrcTransform();
    },

    /** The wheel zooms at the pointer, a left or middle drag pans, a right drag zooms - as on the timeline viewer. */
    _editSrcWireView(view) {
        view.addEventListener("contextmenu", (e) => e.preventDefault());
        view.addEventListener("wheel", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const z = this._editSrcZoomState();
            this._editSrcZoomAt(z.zoom + (e.deltaY > 0 ? -0.1 : 0.1), e.clientX, e.clientY);
        }, { passive: false });
        view.addEventListener("mousedown", (e) => {
            if (e.button > 2) return;
            e.preventDefault();
            e.stopPropagation();
            const z = this._editSrcZoomState();
            const zooming = e.button === 2;
            const ax = e.clientX, ay = e.clientY;
            let lx = e.clientX, ly = e.clientY;
            const win = view.ownerDocument.defaultView || window;
            const move = (ev) => {
                if (zooming) this._editSrcZoomAt(z.zoom + (ev.clientX - lx) * 0.005 * z.zoom, ax, ay);
                else { z.x += ev.clientX - lx; z.y += ev.clientY - ly; this._editSrcTransform(); }
                lx = ev.clientX; ly = ev.clientY;
            };
            const up = () => { win.removeEventListener("mousemove", move); win.removeEventListener("mouseup", up); };
            win.addEventListener("mousemove", move);
            win.addEventListener("mouseup", up);
        });
    },

    /** The bar's Source buttons as things stand (from editTlRefresh). */
    _editSrcButtons(ui) {
        const on = this._editSrcOn();
        const s = this._editSrcState(), cut = this._editTlCut;
        ui.srcView.classList.toggle("on", on);
        ui.srcView.setAttribute("aria-pressed", on ? "true" : "false");
        for (const b of ui.srcEdits.querySelectorAll(".edit-srcedit")) {
            b.disabled = !s || !cut || (!!s.sound && b.dataset.edit === "place");
        }
        if (ui.body) ui.body.classList.toggle("patching", on);
    },

    _editSrcFps() {
        return (this._editTlCut && this._editTlCut.fps) || 24;
    },

    /** The loaded source: { file, name, still, sound, dur, in, out, head } or null. */
    _editSrcState() {
        if (this._editSrc !== undefined) return this._editSrc;
        let kept = null;
        try { kept = JSON.parse(window.localStorage.getItem(STORE) || "null"); } catch (_) {}
        this._editSrc = kept && kept.file ? kept : null;
        return this._editSrc;
    },

    _editSrcKeep() {
        try { window.localStorage.setItem(STORE, JSON.stringify(this._editSrc || null)); } catch (_) {}
    },

    /**
     * Load `item` ({ path, name }) into the Source viewer at `src` seconds of it,
     * opening the panel if it is not up. -> the source state.
     */
    async editSrcLoad(item, src = 0) {
        const file = item && (item.path || item.file);
        if (!file) return null;
        const still = STILL.test(file), sound = SOUND.test(file);
        let dur = still ? Infinity : 0;
        const tab = this.activeTab;
        if (!still && this._editTlProbe) {
            const info = (await this._editTlProbe([file]))[file];
            if (info && info.duration > 0) dur = info.duration;
        }
        // The user left the cut's tab while its length was asked for (a History
        // double-click goes to the snapshot's tab): kept, shown with the next cut.
        const left = this.activeTab !== tab;
        const fps = this._editSrcFps();
        const name = item.name || String(file).split(/[\\/]/).pop();
        this._editSrc = { file, name, still, sound, dur: dur || null, in: null, out: null,
                          head: still ? 0 : Math.max(0, Math.floor((Number(src) || 0) * fps + 1e-6) / fps) };
        this._editSrcKeep();
        this._editSrcEl = null;
        if (left) return this._editSrc;
        if (!this._editSrcOn()) this.editSrcToggle(true);
        else if (!this._editSrcUp()) this.editSrcSwap("source");
        this.editSrcRender();
        if (this.editTlRefresh) this.editTlRefresh();
        return this._editSrc;
    },

    /** The panel drawn: the picture, the scrub bar, the marks and the edit buttons. */
    editSrcRender() {
        const host = this.editSourcePanel;
        if (!host || !this._editSrcUp()) return;
        const s = this._editSrcState();
        const cut = this._editTlCut;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        let body = host.querySelector(":scope > .src-body");
        const key = s ? s.file : "";
        if (!body || body.dataset.file !== key) {
            body = el("div", "src-body");
            body.dataset.file = key;
            body.tabIndex = 0;
            body.addEventListener("keydown", (e) => this._editSrcKey(e));
            body.addEventListener("pointerdown", () => {
                this.editMonSet("source");                 // the active monitor: playback keys come here
                try { body.focus({ preventScroll: true }); } catch (_) {}
            });
            const carries = (e) => { try { const t = Array.from(e.dataTransfer.types || []); return t.includes(DRAG_TYPE) || t.includes("Files"); } catch (_) { return false; } };
            body.addEventListener("dragover", (e) => { if (!carries(e)) return; e.preventDefault(); body.classList.add("landing"); });
            body.addEventListener("dragleave", (e) => { if (!e.relatedTarget || !body.contains(e.relatedTarget)) body.classList.remove("landing"); });
            body.addEventListener("drop", (e) => {
                if (!carries(e)) return;
                e.preventDefault();
                e.stopPropagation();
                body.classList.remove("landing");
                this._editSrcDrop(e.dataTransfer);
            });
            const head = el("div", "src-head");
            const name = el("div", "src-name");
            const small = (icon, title, fn, cls) => {
                const b = el("button", "edit-btn src-hbtn " + cls);
                b.title = title;
                setEditIcon(b, icon);
                b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
                return b;
            };
            head.append(name, small("close", "Put the Source viewer away", () => this.editSrcToggle(false), "src-close"));
            const view = el("div", "src-view");
            this._editSrcWireView(view);
            this._editSrcZ = { zoom: 1, x: 0, y: 0 };      // a new file fits its viewer
            const scrub = el("div", "src-scrub");
            scrub.append(el("div", "src-range"), el("div", "src-line"));
            scrub.addEventListener("pointerdown", (e) => this._editSrcScrubDown(e, scrub));
            const row = el("div", "src-row");
            const tc = el("div", "src-tc");
            const btn = (label, title, fn, cls = "") => {
                const b = el("button", "edit-btn src-btn" + (cls ? " " + cls : ""), label);
                b.title = title;
                b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
                return b;
            };
            row.append(
                btn("▶", "Play / stop the source (Space, with the Source viewer focused)", () => this.editSrcPlay(), "src-play"),
                btn("I", "Mark the source's in at its playhead (I)", () => this.editSrcMark("in")),
                btn("O", "Mark the source's out at its playhead (O)", () => this.editSrcMark("out")),
                btn("×", "Clear the source's in and out (Alt+X / Shift+X)", () => this.editSrcMark(null)),
                tc);
            body.append(head, view, scrub, row);
            host.replaceChildren(body);
            this._editSrcEl = null;
        }
        const name = body.querySelector(".src-name");
        const view = body.querySelector(".src-view");
        name.textContent = s ? s.name : "Source: drop a clip here, or press F on the timeline";
        name.title = s ? s.file : "";
        body.classList.toggle("empty", !s);
        // The picture.
        if (s && !this._editSrcEl) {
            const obj = { path: s.file, external: true, name: s.name };
            const url = this._editPlayUrl && !s.still ? this._editPlayUrl(s.file) : this.buildImgUrl(obj, { noColor: true });
            const media = s.still ? el("img", "src-media") : el(s.sound ? "audio" : "video", "src-media");
            media.src = url;
            if (!s.still) {
                media.preload = "auto";
                media.addEventListener("loadedmetadata", () => {
                    if (!(s.dur > 0) && media.duration > 0 && Number.isFinite(media.duration)) { s.dur = media.duration; this._editSrcKeep(); }
                    try { media.currentTime = s.head + 0.5 / this._editSrcFps(); } catch (_) {}
                    this._editSrcDraw();
                });
                media.addEventListener("ended", () => this._editSrcStopped());
            }
            if (s.sound) { const note = el("div", "src-sound", "♪ " + s.name); view.replaceChildren(note, media); }
            else view.replaceChildren(media);
            this._editSrcEl = media;
            this._editSrcTransform();
        } else if (!s) view.replaceChildren();
        this._editSrcCtlPlace();
        this._editSrcDraw();
    },

    /** The scrub bar, the marks and the timecode as they stand. */
    _editSrcDraw() {
        const host = this.editSourcePanel;
        const body = host && host.querySelector(":scope > .src-body");
        if (!body) return;
        const s = this._editSrcState();
        const fps = this._editSrcFps();
        const len = s ? (s.still ? STILL_SECONDS : s.dur || 0) : 0;
        const share = (t) => (len > 0 ? Math.max(0, Math.min(1, t / len)) * 100 : 0);
        const range = body.querySelector(".src-range"), line = body.querySelector(".src-line");
        const has = (v) => v !== null && v !== undefined;
        if (s && (has(s.in) || has(s.out))) {
            const a = has(s.in) ? s.in : 0, b = has(s.out) ? s.out : len;
            range.style.display = "";
            range.style.left = share(a) + "%";
            range.style.width = Math.max(0, share(b) - share(a)) + "%";
        } else range.style.display = "none";
        line.style.left = share(s ? s.head : 0) + "%";
        line.style.display = s && !s.still ? "" : "none";
        const tc = body.querySelector(".src-tc");
        if (!s) { tc.textContent = ""; return; }
        const T = (t) => D.timecode(t, fps);
        let text = s.still ? "still" : T(s.head);
        if (has(s.in)) text += `  in ${T(s.in)}`;
        if (has(s.out)) text += `  out ${T(s.out)}`;
        if (has(s.in) && has(s.out)) text += `  (${Math.round((s.out - s.in) * fps)} fr)`;
        tc.textContent = text;
        body.dataset.head = String(Math.round(s.head * fps));
        const play = body.querySelector(".src-play");
        if (play) play.textContent = this._editSrcPlaying ? "■" : "▶";
    },

    // ── the source's own transport ───────────────────────────────────────────

    /** The source's playhead to `t` seconds (on the cut's frames, held to the source). */
    editSrcSeek(t) {
        const s = this._editSrcState();
        if (!s || s.still) return;
        const fps = this._editSrcFps();
        const end = s.dur > 0 ? s.dur - 1 / fps : Infinity;
        s.head = Math.max(0, Math.min(end, Math.floor((Number(t) || 0) * fps + 1e-6) / fps));
        const m = this._editSrcEl;
        if (m && !this._editSrcPlaying) { try { m.currentTime = s.head + 0.5 / fps; } catch (_) {} }
        this._editSrcKeep();
        this._editSrcDraw();
    },

    editSrcStep(frames) {
        const s = this._editSrcState();
        if (!s) return;
        this.editSrcSeek(s.head + frames / this._editSrcFps());
    },

    editSrcPlay(on) {
        const s = this._editSrcState(), m = this._editSrcEl;
        if (!s || s.still || !m) return;
        const go = on === undefined ? !this._editSrcPlaying : !!on;
        if (!go) { try { m.pause(); } catch (_) {} this._editSrcStopped(); return; }
        if (this.isPlaying && this.stop) this.stop();          // one thing plays at a time
        this._editSrcPlaying = true;
        try { const p = m.play(); if (p && p.catch) p.catch(() => this._editSrcStopped()); } catch (_) {}
        const win = this.editSourcePanel.ownerDocument.defaultView || window;
        const tick = () => {
            if (!this._editSrcPlaying) return;
            const fps = this._editSrcFps();
            s.head = Math.max(0, Math.floor(m.currentTime * fps + 1e-6) / fps);
            this._editSrcDraw();
            win.requestAnimationFrame(tick);
        };
        win.requestAnimationFrame(tick);
        this._editSrcDraw();
    },

    /**
     * J / K / L on the source: L plays (again: faster, up to 8x), K stops, J runs it backwards
     * on a timer (again: faster) - a film cannot be played backwards, only shown frame by frame.
     */
    editSrcShuttle(dir) {
        const s = this._editSrcState(), m = this._editSrcEl;
        const win = (this.editSourcePanel && this.editSourcePanel.ownerDocument.defaultView) || window;
        const back = this._editSrcBack;
        if (back) { win.clearInterval(back.id); this._editSrcBack = null; }
        if (!s || s.still || !m) return;
        if (dir === 0) { this.editSrcPlay(false); try { m.playbackRate = 1; } catch (_) {} return; }
        if (dir > 0) {
            const rate = this._editSrcPlaying ? Math.min(8, (m.playbackRate || 1) * 2) : 1;
            try { m.playbackRate = rate; } catch (_) {}
            if (!this._editSrcPlaying) this.editSrcPlay(true);
            return;
        }
        this.editSrcPlay(false);
        const rate = back ? Math.min(8, back.rate * 2) : 1;
        const fps = this._editSrcFps();
        const id = win.setInterval(() => {
            if (!s || s.head <= 0) { this.editSrcShuttle(0); return; }
            this.editSrcStep(-1);
        }, 1000 / (fps * rate));
        this._editSrcBack = { id, rate };
    },

    _editSrcStopped() {
        if (!this._editSrcPlaying) return;
        this._editSrcPlaying = false;
        this._editSrcKeep();
        this._editSrcDraw();
    },

    /** Mark the source's in or out at its playhead ("in" / "out"), or clear both (null). */
    editSrcMark(which) {
        const s = this._editSrcState();
        if (!s) return;
        const fps = this._editSrcFps();
        if (!which) { s.in = null; s.out = null; }
        else if (s.still) {
            // A still has no time of its own: its marks are a length from 0.
            if (which === "out") { s.in = 0; s.out = Math.max(1 / fps, s.out || STILL_SECONDS); }
        } else if (which === "in") {
            s.in = s.head;
            if (s.out !== null && s.out !== undefined && s.out <= s.in) s.out = null;
        } else {
            s.out = Math.round((s.head + 1 / fps) * 1e4) / 1e4;   // the out frame is in the range
            if (s.in !== null && s.in !== undefined && s.in >= s.out) s.in = null;
        }
        this._editSrcKeep();
        this._editSrcDraw();
    },

    _editSrcScrubDown(e, scrub) {
        const s = this._editSrcState();
        if (!s || s.still || !(s.dur > 0)) return;
        e.preventDefault();
        const at = (ev) => {
            const r = scrub.getBoundingClientRect();
            return Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width))) * s.dur;
        };
        if (this._editSrcPlaying) this.editSrcPlay(false);
        this.editSrcSeek(at(e));
        const win = scrub.ownerDocument.defaultView || window;
        const move = (ev) => this.editSrcSeek(at(ev));
        const up = () => { win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
    },

    _editSrcKey(e) {
        if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
        const low = String(e.key).toLowerCase();
        const fps = this._editSrcFps();
        let done = true;
        const kind = sourceEditKey(e.key, e.shiftKey);
        if (kind) this.editSrcEdit(kind);
        else if (e.key === " ") {
            if (this._editSrcBack) this.editSrcShuttle(0);
            else { if (!this._editSrcPlaying && this._editSrcEl) { try { this._editSrcEl.playbackRate = 1; } catch (_) {} } this.editSrcPlay(); }
        }
        else if ((low === "j" || low === "k" || low === "l") && !e.shiftKey && !e.altKey) this.editSrcShuttle(low === "j" ? -1 : low === "l" ? 1 : 0);
        else if (low === "f" && !e.shiftKey && !e.altKey) this.editSrcFit();
        else if (low === "i" && !e.altKey) this.editSrcMark("in");
        else if (low === "o" && !e.altKey) this.editSrcMark("out");
        else if (low === "x" && (e.altKey || e.shiftKey)) this.editSrcMark(null);
        else if (low === "f" && e.shiftKey) this.editSrcMatchBack();
        else if (low === "q" && !e.shiftKey && !e.altKey && !e.ctrlKey) this.editSrcSwap();
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") this.editSrcStep((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? Math.round(fps) : 1));
        else if (e.key === "Home") this.editSrcSeek(0);
        else if (e.key === "End") this.editSrcSeek(Infinity);
        else done = false;
        if (done) { e.preventDefault(); e.stopPropagation(); }
    },

    async _editSrcDrop(dt) {
        let items = [];
        try {
            const raw = dt.getData(DRAG_TYPE);
            if (raw) items = (JSON.parse(raw).items) || [];
        } catch (_) {}
        if (!items.length && dt.files && dt.files.length && this._editTlOsItems) items = this._editTlOsItems(dt.files);
        return this.editSrcLoadItems(items);
    },

    /**
     * Load the first of `items` (the History payload's items, a file browser
     * row, a canvas node's clips) into the Source viewer, its file found first
     * where it has only filename / type / subfolder. -> the source state or null.
     */
    async editSrcLoadItems(items) {
        if (!items || !items.length) return null;
        const got = this._editTlResolve ? await this._editTlResolve(items.slice(0, 1)) : { items };
        const it = got.items && got.items[0];
        if (!it || !it.path) { this._editTlSay("cannot load that into the Source viewer"); return null; }
        return this.editSrcLoad({ path: it.path, name: it.name || it.filename }, 0);
    },

    // ── where it goes, and the edit ─────────────────────────────────────────

    /** The tracks a source can go to: video tracks for a picture, sound tracks (not the bed) for a sound. */
    _editSrcTracks(cut, sound) {
        if (!cut) return [];
        const tracks = (cut.tracks || []).filter((k) => (sound ? k.kind === "audio" : k.kind === "video"));
        return sound ? tracks.map((k) => k.id) : ["V1", ...tracks.map((k) => k.id)];
    },

    /** The destination (the track patch): the track patched to, else V1 (a sound: the first sound track). */
    _editSrcDest(cut, sound) {
        const list = this._editSrcTracks(cut, sound);
        const v = this._editTlView || {};
        const picked = sound ? v.srcAudio : v.srcTrack;
        if (picked && list.includes(picked)) return picked;
        return list[0] || "";
    },

    /** Patch the source to track `id` (a video track: its picture; a sound track: its sound), as a click on its patch box. */
    editSrcPatchTo(id) {
        const cut = this._editTlCut, v = this._editTlView;
        if (!cut || !v) return false;
        if (this._editSrcTracks(cut, false).includes(id)) v.srcTrack = id;
        else if (this._editSrcTracks(cut, true).includes(id)) v.srcAudio = id;
        else return false;
        if (this.editTlRefresh) this.editTlRefresh();
        return true;
    },

    /** The bar's Source viewer button: on; in a single viewer showing the timeline, the source; else off. */
    editSrcViewerButton() {
        const v = this._editSrcViewer();
        if (this._editSrcOn() && v.mode === "single" && v.show === "timeline") this.editSrcSwap("source");
        else this.editSrcToggle();
    },

    /**
     * One of the source edits (SOURCE_BUTTONS) with what is marked: one undo step,
     * the new clip selected, the playhead after it. -> true when the cut changed.
     */
    editSrcEdit(kind) {
        const s = this._editSrcState();
        let cut = this._editTlCut;
        if (!s) { this._editTlSay("load a source first: drop a clip on the Source viewer, or F on the timeline"); return false; }
        if (!cut) return false;
        const fps = cut.fps || 24;
        const r = this._editTlRangeSeconds ? this._editTlRangeSeconds() : null;
        const head = (Number(this.currentFrame) || 0) / fps;
        const tl = { in: r ? r.a : null, out: r ? r.b : null, head };
        const has = (v) => v !== null && v !== undefined;
        let tp;
        if (s.still) {
            const length = has(s.in) && has(s.out) ? s.out - s.in : r ? r.b - r.a : STILL_SECONDS;
            tp = { in: 0, length, at: r ? r.a : head };
        } else {
            tp = D.threePoint({ in: s.in, out: s.out, head: s.head, dur: s.dur > 0 ? s.dur : Infinity }, tl);
        }
        if (kind === "fit" && !s.still) {
            const a = has(s.in) ? s.in : s.head;
            const b = has(s.out) ? s.out : s.dur;
            tp = b > a ? { in: a, length: b - a, at: tl.in } : { error: "mark the source's range first" };
        }
        if (tp.error) { this._editTlSay(tp.error); return false; }
        let track = this._editSrcDest(cut, s.sound);
        if (s.sound && !track) {
            cut = D.addTrack(cut, "audio");
            track = cut.tracks[cut.tracks.length - 1].id;
        }
        const res = D.sourceEdit(cut, kind, { file: s.file, name: s.name, in: tp.in, length: tp.length }, tp.at, {
            track: s.sound ? undefined : track, audio: s.sound ? track : undefined, mask: D.editMask(cut),
            head, srcHead: s.head, dur: s.dur > 0 ? s.dur : null, tlIn: tl.in, tlOut: tl.out,
        });
        if (res.error) { this._editTlSay(res.error); return false; }
        if (this._editTlApply(res.cut) === false) return false;
        this._editTlSel = res.sel;
        this._editTlMulti = null;
        const span = res.sel && D.selSpan(res.cut, res.sel);
        if (span && kind !== "replace" && this._editTlSeek) this._editTlSeek(span.end);
        this.editTlRefresh();
        const label = (SOURCE_BUTTONS.find((b) => b[0] === kind) || [kind, kind])[1];
        this._editTlSay(`${label}: ${s.name}, ${Math.round(tp.length * fps)} frames on ${res.sel && res.sel.track ? res.sel.track : "V1"}`);
        return true;
    },

    /** Shift+F, reverse match frame: the timeline's playhead to where the cut shows the source's frame. */
    editSrcMatchBack() {
        const s = this._editSrcState(), cut = this._editTlCut;
        if (!s || !cut) { this._editTlSay("load a source first"); return null; }
        const fps = cut.fps || 24;
        const hit = D.findSource(cut, s.file, s.still ? 0 : s.head + 0.5 / fps);
        if (!hit) { this._editTlSay(`the cut does not show ${s.name} at ${D.timecode(s.head, fps)}`); return null; }
        this._editTlSel = hit.sel;
        this._editTlMulti = null;
        if (this._editTlSeek) this._editTlSeek(Math.floor(hit.t * fps + 1e-6) / fps);
        this.editTlRefresh();
        return hit;
    },
};
