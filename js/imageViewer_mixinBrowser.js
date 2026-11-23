// imageViewer_mixinBrowser.js
// The file browser panel: a directory listing, a preview pane, and a drag source.
//
// The browser comes in instances (Sebastian 2026-11-23): the implementation lives in
// imageViewer_browserInstance.js, one closure per browser with its own folder, filter, selection and preview.
// This mixin keeps the FIRST one — the markup in imageViewer.html — with its state on the viewer as it always
// was (every older caller of this._browserDir / this.browseTo reads and writes it still), and registers the
// maker the dock calls for every further one ("browser@2", ...).
//
// It replaces the old "Open all images in folder" button, which shelled out to a tkinter dialog on the SERVER.
// Listing directories over the API costs one request per folder, works the same locally and remotely, and lets
// a single file be picked out. Where it opens: ComfyUI's input directory, which the server reports.
import { createBrowserInstance } from "./imageViewer_browserInstance.js";

export const BrowserMixin = {

    // ── Bootstrap ────────────────────────────────────────────────────────────

    _initFileBrowser() {
        const sr = this.shadowRoot;

        this.browserPanel   = sr.getElementById("browser-panel");
        if (!this.browserPanel) return;

        this.browserList    = sr.getElementById("browser-list");
        this.browserPathIn  = sr.getElementById("browser-path");
        this.browserRootSel = sr.getElementById("browser-root-sel");
        this.browserPreview = sr.getElementById("browser-preview-stage");
        this.browserPrevImg = sr.getElementById("browser-preview-img");
        this.browserPrevVid = sr.getElementById("browser-preview-vid");
        this.browserPrevMsg = sr.getElementById("browser-preview-msg");
        this.browserMeta    = sr.getElementById("browser-preview-meta");
        this.browserOpenBtn = sr.getElementById("browser-open-btn");
        this.browserFilterIn = sr.getElementById("browser-filter");
        this.browserKindSel  = sr.getElementById("browser-kind-sel");

        this.browserPanel.style.display = "none";
        // The first browser keeps its state on the viewer (st === this); the factory fills in the defaults,
        // binds the controls and draws the empty preview, as this init used to do itself.
        this._browserInst = createBrowserInstance(this, this.browserPanel, this, null);

        // Every further one: a panel of its own, seeded with where the first one is, then independent.
        this._dockMakers().browser = (v, id, saved) => {
            const d = (v._dockRootEl && v._dockRootEl.ownerDocument) || v.browserPanel.ownerDocument;
            const host = d.createElement("div");
            host.className = "browser-panel";
            const seed = saved || { dir: v._browserDir, filter: v._browserFilter, kinds: v._browserKinds,
                                    fold: v._browserFold, previewH: v._browserPreviewH };
            return createBrowserInstance(v, host, {}, seed);
        };

        this.browserToggleBtn = sr.getElementById("browser-toggle-btn");
        if (this.browserToggleBtn) this.browserToggleBtn.onclick = () => this.toggleFileBrowser();
        this._syncBrowserToggleState();
    },

    /** The folder this viewer was last left in, or null for the server default. */
    _savedBrowserDir() {
        try {
            const raw = window.localStorage.getItem(this._getViewerStateStorageKey());
            const parsed = raw ? JSON.parse(raw) : null;
            const dir = parsed && parsed.browserDir;
            return (typeof dir === "string" && dir) ? dir : null;
        } catch (e) { return null; }
    },

    _savedBrowserFilter() {
        try {
            const raw = window.localStorage.getItem(this._getViewerStateStorageKey());
            const parsed = raw ? JSON.parse(raw) : null;
            const f = (parsed && parsed.browserFilter) || {};
            return {
                text: typeof f.text === "string" ? f.text : "",
                kinds: typeof f.kinds === "string" ? f.kinds : "",
                fold: !!f.foldSequences,
            };
        } catch (e) { return { text: "", kinds: "", fold: false }; }
    },

    // ── The first browser, for callers that ask the viewer ───────────────────

    browseTo(dir, opts) { return this._browserInst && this._browserInst.browseTo(dir, opts); },
    _renderBrowserList() { return this._browserInst && this._browserInst.renderList(); },
    toggleBrowserFold(on) { return this._browserInst && this._browserInst.toggleFold(on); },
    _browserFilterChanged(opts) { return this._browserInst && this._browserInst.filterChanged(opts); },
    openBrowserSelection(files) { return this._browserInst && this._browserInst.openSelection(files); },
    _stopBrowserPreview() { return this._browserInst && this._browserInst.stopPreview(); },
    _setBrowserPreviewHeight(px) { return this._browserInst && this._browserInst.setPreviewHeight(px); },
    _selectedBrowserFiles() { return this._browserInst ? this._browserInst.selectedFiles() : []; },
    _browserFramesFor(paths) { return this._browserInst ? this._browserInst.framesFor(paths) : Promise.resolve([]); },

    // ── Show / hide ──────────────────────────────────────────────────────────

    toggleFileBrowser(force) {
        if (!this.browserPanel) return;
        const next = (force === undefined) ? !this.isFileBrowserOpen() : !!force;
        // Filling the panel in is _onPanelShown's job (mixinDock) — it fires for
        // every route that reveals a panel, not just this one.
        this.setPanelDocked("browser", next);
        if (!next) this._stopBrowserPreview();
        this._syncBrowserToggleState();
    },

    _syncBrowserToggleState() {
        if (!this.browserToggleBtn) return;
        this.browserToggleBtn.classList.toggle("active", this.isFileBrowserOpen());
    },

    isFileBrowserOpen() {
        return !!(this.isPanelDocked && this.isPanelDocked("browser"));
    },

    /**
     * Put text on the clipboard from a click. The synchronous copy goes first,
     * while the click still counts as a user gesture; the async API follows
     * where it exists. Uses the viewer's own document, which a popout moves.
     */
    copyTextToClipboard(text) {
        const doc = (this.container && this.container.ownerDocument) || document;
        try {
            const ta = doc.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.cssText = "position:fixed;opacity:0;top:0;left:0;pointer-events:none;";
            doc.body.appendChild(ta);
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(0, text.length);
            doc.execCommand("copy");
            doc.body.removeChild(ta);
        } catch (err) { console.warn("imageViewer: execCommand copy failed", err); }
        const nav = (doc.defaultView && doc.defaultView.navigator) || navigator;
        if (nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).catch(() => {});
    },

    /**
     * Put ready-made frames on screen, in the one Viewer tab.
     *
     * Images go into ONE tab as a sequence, so the timeline scrubs the folder; each video is a snapshot of its
     * own, because a video snapshot holds exactly one clip. Shared with the viewport drop target, so a file
     * dropped in from the browser lands the same way as one opened through the button.
     */
    openExternalFramesInViewer(frames, label) {
        if (!Array.isArray(frames) || frames.length === 0) return null;
        const images = frames.filter(f => f && !this._frameIsVideo(f));
        const videos = frames.filter(f => f &&  this._frameIsVideo(f));
        const snaps = [...(images.length ? [images] : []), ...videos.map((v) => [v])];
        return this.showInViewerTab(snaps);
    },
};