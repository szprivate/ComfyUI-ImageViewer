// bEpicViewer_exportView.js
// Exporting what is on screen, and where every export ends up.
//
// "Export…" in the transport (and in the History panel's title bar) writes the
// tab being looked at: the current frame as a PNG, or the whole clip as a film.
// Those two and no more - a comparison, a wipe, the drawing tools' overlays are
// ways of looking, not something there is a file of. A 3D scene has an export of
// its own (the Outliner's), and the button opens that one there.
//
// The dialog, the formats and the place a file lands are the ones every export
// shares (bEpicViewer_exportUI.js, export_rules.py); the work is the server's
// (export_view.py).
//
// `exportLanded` is the other half of the rule: whatever a feature exports is
// said once, with its path, and put in the History of one tab - "Exports" -
// newest first, where it can be looked at, compared and dragged onto the graph.
import { api } from "../../scripts/api.js";
import { notice, openExportDialog } from "./bEpicViewer_exportUI.js";

const TAB = "folder_exports";          // "folder_": a tab the user made, kept by the stale-tab sweep
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
    + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

const hasFile = (f) => !!f && !f.dropped && !!(f.path || f.filename);
const fileRef = (f) => ({ path: f.path || "", filename: f.filename || "", subfolder: f.subfolder || "", type: f.type || "" });
const stem = (f) => String((f && (f.name || f.filename || f.path)) || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");

export const ExportViewMixin = {

    /** The export button, made on first use beside the layout button. */
    _exportViewButton() {
        if (this._exportViewBtn && this._exportViewBtn.isConnected) return this._exportViewBtn;
        const bar = this.container && this.container.querySelector(".transport");
        if (!bar) return null;
        const b = bar.ownerDocument.createElement("button");
        b.id = "export-view-btn";
        b.className = "sprite-icon export-view-btn";
        b.title = "Export what is on screen: the current frame, or the whole clip";
        b.innerHTML = ICON;
        b.addEventListener("click", () => this.exportViewDialog());
        const before = bar.querySelector("#layout-btn");
        // Beside the layout button - which the viewer wraps in a box of its own,
        // with an invisible menu laid over the whole box (.layout-picker-wrap). A
        // button put INSIDE that box sits under the menu: it shows the menu's
        // tooltip, a click opens the menu, and the wider box covers its neighbour.
        // So: before the box, in whatever holds the box.
        const at = before && (before.closest(".layout-picker-wrap") || before);
        if (at && at.parentNode) at.parentNode.insertBefore(b, at); else bar.append(b);
        this._exportViewBtn = b;
        return b;
    },

    /** What the tab on screen is, as something to export; null when it is empty. */
    _exportViewSource() {
        if (this.isPrevizTab && this.isPrevizTab()) return { kind: "previz" };
        if (this.isEditTab && this.isEditTab()) return { kind: "edit" };
        const frames = (this._baseFrames && this._baseFrames()) || [];
        if (!frames.length) return null;
        if (this._frameIsVideo(frames[0])) {
            return { kind: "video", frames: [frames[0]], index: Math.max(0, Math.floor(this.currentFrame || 0)) };
        }
        const at = frames[this.displayFrameToImageIndex(this.currentFrame, frames.length)];
        if (this._frameIsModel && this._frameIsModel(at)) return { kind: "model" };
        const pictures = frames.filter((f) => f && !(this._frameIsModel && this._frameIsModel(f)) && !this._frameIsVideo(f));
        if (!pictures.length) return null;
        return { kind: pictures.length > 1 ? "sequence" : "picture", frames: pictures,
                 index: Math.max(0, pictures.indexOf(at)) };
    },

    /** The picture in the player, for a clip or image only the browser holds. */
    _exportViewGrab() {
        const el = this._videoMode ? this.videoBase : this.imgBase;
        const w = el && (el.videoWidth || el.naturalWidth), h = el && (el.videoHeight || el.naturalHeight);
        if (!w || !h) return null;
        try {
            const c = el.ownerDocument.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d").drawImage(el, 0, 0);
            return c.toDataURL("image/png");
        } catch (_) { return null; }
    },

    /** Open the export dialog for the tab on screen. `scope`: "frame" or "clip". */
    async exportViewDialog(scope) {
        scope = typeof scope === "string" ? scope : null;
        const src = this._exportViewSource();
        if (!src) { notice("warn", "Nothing to export", "There is nothing on screen."); return; }
        if (src.kind === "previz") { if (this.previzRenderDialog) this.previzRenderDialog(); return; }
        if (src.kind === "edit") { if (this._editTlRender) this._editTlRender(); return; }
        if (src.kind === "model") {
            notice("info", "Nothing to export here",
                   "A 3D model is exported from a 3D scene: Export is in its Outliner.");
            return;
        }
        const onDisk = src.frames.every(hasFile);
        const whole = src.kind !== "picture" && onDisk;
        scope = whole ? (scope || this._exportViewScope || "frame") : "frame";
        const many = src.frames.length;
        const tab = String((this.tabLabels && this.tabLabels[this.activeTab]) || "").replace(/^[^\w]+/, "");
        const name = stem(src.frames[0]).replace(/[._-]?\d{3,}$/, "") || tab || "export";
        const fps = Number(this.fps) || 24;
        let dlg = null;
        dlg = await openExportDialog(this.container, {
            title: scope === "clip" ? "Export clip" : "Export frame",
            kind: scope === "clip" ? "video" : "frame",
            name,
            ...(scope === "clip"
                ? { formats: ["mp4", "mov"], values: this._exportViewLast, go: "Render" }
                : { fixed: [{ value: "png", label: "PNG" }] }),
            rows: (make) => {
                const what = make.select([
                    ["frame", src.kind === "picture" ? "This picture" : `Current frame (${src.index + (src.kind === "video" ? 0 : 1)})`],
                    ["clip", src.kind === "video" ? "Whole clip" : `Whole sequence (${many} frames)`],
                ], scope);
                [...what.options].forEach((o) => { if (o.value === "clip") o.disabled = !whole; });
                what.title = whole ? "" : (onDisk ? "One picture: there is no clip to export."
                    : "This is held by the browser only, so only the frame on screen can be exported.");
                what.addEventListener("change", () => {
                    this._exportViewScope = what.value;
                    if (dlg) dlg.close();
                    this.exportViewDialog(what.value);
                });
                return [make.row("Export", what)];
            },
            note: scope === "clip"
                ? (src.kind === "video" ? "The clip, written again in this format, with its sound."
                    : `One frame per picture, at ${fps} fps, each as it is shown.`)
                : "The picture as it is shown, through the colourspace picked in the viewer - "
                  + "without the exposure, a comparison or anything drawn over it.",
            onExport: (values, ui) => this._exportViewRun(src, scope, values, ui, fps),
        });
    },

    async _exportViewRun(src, scope, values, ui, fps) {
        const first = src.frames[0];
        const body = { scope, name: values.name, context: values.context, frame: src.index, fps,
                       cs: (this.colorParam && this.colorParam(src.frames[src.index] || first)) || "" };
        if (scope === "clip") {
            this._exportViewLast = { format: values.format, codec: values.codec, quality: values.quality };
            Object.assign(body, { format: values.format, codec: values.codec, quality: values.quality,
                                  files: src.frames.map(fileRef) });
            ui.progress(0, 1, "Rendering…");
        } else if (src.frames.every(hasFile)) {
            body.files = src.kind === "video" ? [fileRef(first)] : [fileRef(src.frames[src.index] || first)];
            body.frame = src.kind === "video" ? src.index : 0;
        } else {
            body.dataurl = this._exportViewGrab();
            if (!body.dataurl) return { ok: false, message: "The picture could not be read out of the player." };
        }
        let got = null, said = "";
        try {
            const res = await api.fetchApi("/bepic/export_view", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            if (res.ok) got = await res.json(); else said = await res.text();
        } catch (e) { said = String((e && e.message) || e); }
        if (!got || !got.path) return { ok: false, message: said || "Nothing was exported." };
        notice("success", scope === "clip" ? "Clip exported" : "Frame exported", "output/" + (got.relative || got.name));
        this.exportLanded([got.path]);
        return { ok: true };
    },

    /**
     * Put exported files in History: one tab, "Exports", each export a snapshot
     * in it, newest first. The tab is made on the first export and is not
     * switched to unless `focus` - an export must not take the work off screen.
     */
    async exportLanded(paths, { focus = false } = {}) {
        if (!this._browserFramesFor || !paths || !paths.length) return null;
        const frames = (await this._browserFramesFor(paths)).filter(Boolean);
        if (!frames.length) return null;
        const fresh = !this.allTabs[TAB];
        this.allTabs[TAB] = frames;
        if (!this.history[TAB]) this.history[TAB] = [];
        this.history[TAB].unshift(frames);
        if (this.trimHistory) this.trimHistory(TAB);
        this.tabLabels[TAB] = "↓ Exports";
        if (fresh) {
            this.tabOrder = [...(this.tabOrder || []).filter((k) => k !== TAB), TAB];
            if (this._rebuildTabBar) this._rebuildTabBar(null);
        }
        if (focus || this.activeTab === TAB) this.switchTab(TAB);
        this._historyPanelSig = null;
        if (this.renderHistoryPanel) this.renderHistoryPanel();
        if (this.queuePersistViewerState) this.queuePersistViewerState();
        return TAB;
    },
};
