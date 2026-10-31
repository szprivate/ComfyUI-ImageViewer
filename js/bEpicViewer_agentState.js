// bEpicViewer_agentState.js
// AgentStateMixin - the panel's half of window.bEpicViewerApi.viewerState() and
// .annotations(): it gathers a plain snapshot of its own JS state and hands it to
// the pure functions in bEpicViewer_viewerState.js.
//
// Only JS state is read - this.activeTab, this.currentFrame, the annotation
// store - never the DOM, so the answer is the same whether the viewer is docked,
// full screen or popped out into its own window (where the container has left
// the shadow root). Every part is guarded: a half-built panel answers with what
// it has, and nothing here may throw into agentY's message send.

import { describeViewerState, annotationReport } from "./bEpicViewer_viewerState.js";
import { frameKind } from "./bEpicViewer_historySelection.js";

const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };

export const AgentStateMixin = {

    /** "popout" | "fullscreen" | "docked" | "floating" | "closed". */
    _agentDisplay() {
        if (this.popoutWindow && !this.popoutWindow.closed) return "popout";
        if (!this.viewerToggleEnabled && !this._viewerOnly) return "closed";
        if (this._viewerOnly) return "fullscreen";
        const side = safe(() => (this.pageDockSide ? this.pageDockSide() : ""), "");
        return side ? "docked" : "floating";
    },

    _agentTabLabel(key) {
        return safe(() => (this._resolveTabLabel ? this._resolveTabLabel(key) : (this.tabLabels || {})[key]), "")
            || (this.tabLabels || {})[key] || "";
    },

    _agentTabMode(key) {
        if (this.isEditTab && this.isEditTab(key)) return "edit";
        if (safe(() => this.isPrevizTab && this.isPrevizTab(key), false)) return "previz";
        if (safe(() => this.vtKindOf && this.vtKindOf(key), "")) return String(this.vtKindOf(key));
        if (key !== this.activeTab) return "";
        if (this._mgOn) return "motion";
        if (this._modelMode) return "3d";
        if (this._videoMode) return "video";
        const n = ((this.allTabs || {})[key] || []).length;
        return n > 1 ? "sequence" : "image";
    },

    /** The frame on screen and where it sits in its tab. */
    _agentShownFrame() {
        const frames = safe(() => this._baseFrames(), null) || [];
        if (!frames.length) return null;
        const index = this._videoMode ? 0
            : safe(() => this.displayFrameToImageIndex(this.currentFrame, frames.length), 0) || 0;
        return { frame: frames[index], index, of: frames.length };
    },

    _agentTimeline() {
        const frames = safe(() => this.getImgCount(), 0) || 0;
        let fps = this.fps || 0;
        if (this._videoMode && this._videoFps > 0) fps = this._videoFps;
        if (this._editPlayOn) fps = safe(() => this.editPlayFps(), fps);
        const range = this.playbackRange
            || (this.isInputRangeLocked && this.lockedTimelineRange) || null;
        return {
            video: !!this._videoMode, frames, fps,
            current: Number(this.currentFrame) || 0,
            range: range ? { start: Number(range.start), end: Number(range.end) } : null,
            rangeLocked: !!this.isInputRangeLocked,
            loop: this.loopMode || "", playing: !!this.isPlaying,
        };
    },

    _agentEdit() {
        const open = safe(() => !!(this.isPanelDocked && this.isPanelDocked("editTimeline")), false);
        if (!open && !this._editPlayOn) return null;
        const cut = this._editTlCut;
        const out = { open: true, tab: this._editTlTab || "" };
        if (cut) {
            out.cut = cut.name || "";
            out.clips = Array.isArray(cut.clips) ? cut.clips.length : 0;
            out.fps = cut.fps || 0;
            const sel = this._editTlSel;
            if (sel && sel.kind) {
                const s = { kind: sel.kind, index: sel.i, track: sel.track || "" };
                const list = sel.kind === "text" ? cut.texts
                    : sel.kind === "sound" ? cut.sound
                    : sel.kind === "tclip" ? safe(() => (cut.tracks.find((t) => t.id === sel.track) || {}).clips, null)
                    : cut.clips;
                const c = Array.isArray(list) ? list[sel.i] : null;
                if (c) {
                    s.name = c.name || ""; s.file = c.file || ""; s.text = c.text || "";
                    if (typeof c.in === "number") s.in = c.in;
                    if (typeof c.length === "number") s.length = c.length;
                }
                out.selected = s;
            }
        }
        return out;
    },

    _agentCompare() {
        const hc = this.historyCompare;
        const wipe = { mode: this.sliderMode || "", position: Number(this.sliderPos) };
        if (hc && hc.key) {
            const stack = (this.history || {})[hc.key] || [];
            const out = {
                mode: "history", wipe,
                a: { index: hc.baseIdx, frame: (stack[hc.baseIdx] || [])[0] },
                b: { index: hc.otherIdx, frame: (stack[hc.otherIdx] || [])[0] },
            };
            // Three or more Ctrl-selected snapshots (ContactGridMixin): how many,
            // and on the Contact Sheet grid which ones it shows - indices only.
            const n = safe(() => (this.multiCompareCount ? this.multiCompareCount() : 0), 0) || 0;
            if (n >= 2) out.items = n;
            const grid = safe(() => (this.gridInfo ? this.gridInfo() : null), null);
            if (grid) {
                out.mode = "contact";
                out.shown = grid.shown;
                out.indices = grid.indices;
                out.grid = [grid.cols, grid.rows];
            }
            return out;
        }
        if (this.isComparing && this.compareTab) {
            const shown = this._agentShownFrame();
            return {
                mode: "tab", wipe, tabB: this.compareTab,
                a: shown ? { frame: shown.frame } : null,
                b: { frame: ((this.allTabs || {})[this.compareTab] || [])[0] },
            };
        }
        return null;
    },

    _agentCamera() {
        if (!this._modelMode || !this._model3d) return null;
        const view = this._model3d;
        const cam = safe(() => view.activeCameraObject(), null);
        if (!cam) return null;
        safe(() => cam.updateMatrixWorld(true));
        const e = cam.matrixWorld && cam.matrixWorld.elements;
        const id = safe(() => view.scene3d && view.scene3d.activeCamera, null);
        const entry = id ? safe(() => view._entries.get(id), null) : null;
        return {
            name: entry && entry.item && !view._walk ? entry.item.name || "" : "",
            fov: (entry && entry.item && entry.item.fov) || cam.fov,
            aspect: cam.aspect,
            position: e ? [e[12], e[13], e[14]] : null,
            cameraWorld: e ? Array.from(e) : null,
        };
    },

    _agentAnnotCounts() {
        const items = safe(() => this._annotItems(false), null) || [];
        if (!items.length) return null;
        const out = { count: items.length };
        if (this._videoMode) {
            out.ranges = safe(() => this._annotGroups().length, 0);
            out.onFrame = safe(() => this._annotVisible().length, 0);
        }
        return out;
    },

    /** The snapshot describeViewerState shapes. */
    agentViewerSnapshot() {
        const display = this._agentDisplay();
        const open = display !== "closed";
        const snap = {
            open, display,
            visible: safe(() => this._agentViewerVisible(), open),
            dockSide: display === "docked" ? safe(() => this.pageDockSide(), "") : "",
        };
        if (!open) return snap;
        const key = this.activeTab;
        const order = (Array.isArray(this.tabOrder) && this.tabOrder.length ? this.tabOrder : Object.keys(this.allTabs || {}))
            .filter((k) => (this.allTabs || {})[k]);
        snap.tabs = order.map((k) => ({
            key: k, label: this._agentTabLabel(k),
            frames: ((this.allTabs || {})[k] || []).length,
            history: ((this.history || {})[k] || []).length,
        }));
        if (key) snap.tab = { key, label: this._agentTabLabel(key), mode: this._agentTabMode(key) };
        const shown = this._agentShownFrame();
        if (shown && shown.frame) {
            const fr = shown.frame;
            const p = typeof fr.path === "string" ? fr.path : "";
            snap.item = {
                frame: fr, index: shown.index, of: shown.of,
                historyIndex: this.isViewingHistory && this.currentHistoryKey === key ? this.currentHistoryIndex : null,
                agentTag: p && this._agentTags ? this._agentTags[p] || "" : "",
                colorTag: safe(() => this.historyTagOf([fr]), "") || "",
            };
        }
        snap.timeline = this._agentTimeline();
        snap.edit = this._agentEdit();
        snap.compare = this._agentCompare();
        snap.view = { zoom: this.zoom, panX: this.panX, panY: this.panY,
                      channel: this.channelView, exposure: this.exposure };
        snap.camera = safe(() => this._agentCamera(), null);
        snap.annotations = this._agentAnnotCounts();
        return snap;
    },

    /** window.bEpicViewerApi.viewerState(): plain data, never throws. */
    agentViewerState() {
        try {
            return describeViewerState(this.agentViewerSnapshot());
        } catch (e) {
            return { source: "viewer", open: false, visible: false, display: "closed", error: String(e && e.message || e) };
        }
    },

    /**
     * window.bEpicViewerApi.annotations(): the Annotation tool's marks on the item
     * on screen. `opts`: { frame (video: only the marks on that frame), raw (also
     * the stored marks, normalised - what a mask is drawn from) }.
     */
    agentViewerAnnotations(opts = {}) {
        try {
            const video = !!this._videoMode;
            const shown = this._agentShownFrame();
            const fr = shown && shown.frame;
            const media = safe(() => this._annotMediaRef && this._annotMediaRef(), null);
            const st = media ? (this._annotMedia || {})[media.key] : null;
            const src = video ? this.videoBase : this.imgBase;
            const w = video ? (src && src.videoWidth) : (src && src.naturalWidth);
            const h = video ? (src && src.videoHeight) : (src && src.naturalHeight);
            const source = (st && st.mediaPath) || (fr && typeof fr.path === "string" ? fr.path : "")
                || (video ? this._videoKey || "" : "");
            const frame = Number.isInteger(opts.frame) && opts.frame >= 0 ? opts.frame : undefined;
            const out = annotationReport({
                kind: video ? "video" : "image", source, w: w || (st && st.width) || 0, h: h || (st && st.height) || 0,
                fps: video ? this._videoFps : 0, frames: video ? this._videoFrames : 0,
                items: safe(() => this._annotItems(false), null) || [],
                frame, raw: !!opts.raw,
            });
            if (fr && !video) out.item_kind = frameKind(fr);
            if (fr && !source) {
                // No file behind it (a dropped picture): the marks are scratch work.
                out.unsaved = true;
            }
            if (st) out.saved_beside = !!(st.persist && st.loaded);
            if (this._toolState && this._toolState.active === "annotate") out.tool_open = true;
            return out;
        } catch (e) {
            return { kind: "image", count: 0, annotations: [], error: String(e && e.message || e) };
        }
    },
};
