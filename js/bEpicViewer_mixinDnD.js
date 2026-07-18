// bEpicViewer_mixinDnD.js
// Two drag-and-drop bridges:
//   1. Explorer → viewer:  drop OS files (images/videos) onto the viewport to
//      open them in a new tab. Files are shown straight from blob: URLs (no
//      upload, no on-disk path needed), so these tabs are ephemeral — they are
//      excluded from persisted state and their object URLs are revoked on close.
//   2. History → ComfyUI graph:  drag a history thumbnail onto the node graph to
//      create a path-based loader that references the ORIGINAL file on disk (no
//      upload / no duplicate copy):
//        • image → VHS "Load Image (Path)" (VHS_LoadImagePath), path in `image`
//        • video → VHS "Load Video (Path)" (VHS_LoadVideoPath), path in `video`
//      Items with no on-disk path (dropped-from-Explorer blobs, or filename-only
//      frames), or when VHS isn't installed, fall back to a native upload loader:
//      image → LoadImage, video → LoadVideo (both copy the file into /input).
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

const _IMG_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|svg|ico)$/i;
const _VID_RE = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;

export const DnDMixin = {

    // ── 1. Explorer → viewer ─────────────────────────────────────────────────

    setupExplorerDrop() {
        const vp = this.viewport;
        if (!vp || this._explorerDropBound) return;
        this._explorerDropBound = true;
        this._dropSeq = 0;

        const hasFiles = (e) => {
            try { return Array.from(e.dataTransfer?.types || []).includes("Files"); }
            catch (_) { return false; }
        };
        const hint = (on) => { try { vp.classList.toggle("bepic-drop-hover", on); } catch (_) {} };

        vp.addEventListener("dragenter", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); e.stopPropagation(); hint(true);
        });
        vp.addEventListener("dragover", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); e.stopPropagation();
            try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
            hint(true);
        });
        vp.addEventListener("dragleave", (e) => {
            // Only clear when the pointer actually leaves the viewport, not when
            // it crosses onto a child element inside it.
            if (!e.relatedTarget || !vp.contains(e.relatedTarget)) hint(false);
        });
        vp.addEventListener("drop", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); e.stopPropagation(); hint(false);
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length) this._addDroppedFiles(files);
        });
    },

    _frameForDroppedFile(file, isVideo) {
        const url = URL.createObjectURL(file);
        (this._droppedObjectUrls || (this._droppedObjectUrls = [])).push(url);
        // A unique, stable filename keys the frame (used as the video-mode key so
        // scrubbing doesn't reload, and so two same-named clips don't collide).
        const frame = {
            url,
            name: file.name,
            filename: `drop${++this._dropSeq}_${file.name}`,
            external: true,
            dropped: true,
        };
        if (isVideo) {
            frame.kind = "video"; frame.fps = this.fps || 24;
        } else {
            // Images show their name in the path bar; videos key off `filename`
            // instead (see _enterVideoMode) so leave `path` unset for them.
            frame.path = file.name;
        }
        return frame;
    },

    _addDroppedFiles(files) {
        const images = [], videos = [];
        for (const f of files) {
            const isVid = (f.type && f.type.startsWith("video/")) || _VID_RE.test(f.name);
            const isImg = (f.type && f.type.startsWith("image/")) || _IMG_RE.test(f.name);
            if (isVid) videos.push(f);
            else if (isImg) images.push(f);
        }
        if (!images.length && !videos.length) return;

        let firstKey = null;

        // All dropped images share one browsable tab (mirrors "Open Folder":
        // each image is its own history entry, the tab shows one at a time).
        if (images.length) {
            const key = `dropped_${Date.now()}_${++this._dropSeq}`;
            const frames = images.map((f) => this._frameForDroppedFile(f, false));
            this.allTabs[key]   = [frames[0]];
            this.history[key]   = frames.map((fr) => [fr]);
            this.tabLabels[key] = images.length > 1 ? `📥 ${images.length} images` : `📥 ${images[0].name}`;
            firstKey = firstKey || key;
        }

        // A video tab holds a single video, so each dropped clip gets its own tab.
        for (const f of videos) {
            const key   = `dropped_${Date.now()}_${++this._dropSeq}`;
            const frame = this._frameForDroppedFile(f, true);
            this.allTabs[key]   = [frame];
            this.history[key]   = [[frame]];
            this.tabLabels[key] = `📥 ${f.name}`;
            firstKey = firstKey || key;
            // <img> can't render a video file — extract a poster frame for the strip.
            this._generateDroppedVideoPoster(frame);
        }

        const allKeys = Object.keys(this.allTabs);
        const known   = this.tabOrder.filter((k) => allKeys.includes(k));
        const added   = allKeys.filter((k) => !known.includes(k));
        this.tabOrder = [...known, ...added];

        if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
        this._rebuildTabBar(null);
        if (firstKey) this.switchTab(firstKey);

        const panel = this.historyPanel || this.shadowRoot.getElementById("history-panel");
        if (panel) { panel.style.display = "flex"; this._historyPanelSig = null; this.renderHistoryPanel(); }
        this._syncHistoryToggleState && this._syncHistoryToggleState();
    },

    // Grab a poster frame from a dropped video (blob: URL, same-origin so the
    // canvas isn't tainted) and stash it on the frame as an inline data: URL so
    // the history strip's <img> has something to show.
    _generateDroppedVideoPoster(frame) {
        if (!frame || !frame.url) return;
        let done = false;
        const v = document.createElement("video");
        v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous";
        const cleanup = () => { try { v.removeAttribute("src"); v.load(); } catch (_) {} };
        const draw = () => {
            if (done) return; done = true;
            try {
                const w = v.videoWidth || 160, h = v.videoHeight || 90;
                const c = document.createElement("canvas");
                c.width = w; c.height = h;
                c.getContext("2d").drawImage(v, 0, 0, w, h);
                frame.thumb = c.toDataURL("image/jpeg", 0.6);
                this._historyPanelSig = null;
                if (this.renderHistoryPanel) this.renderHistoryPanel();
            } catch (_) {}
            cleanup();
        };
        v.addEventListener("loadedmetadata", () => {
            try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (_) { draw(); }
        }, { once: true });
        v.addEventListener("seeked", draw, { once: true });
        v.addEventListener("error", () => { done = true; cleanup(); }, { once: true });
        try { v.src = frame.url; } catch (_) {}
    },

    // Revoke a dropped tab's object URLs when it is closed (called from closeTab).
    _revokeDroppedTab(key) {
        try {
            const seen = new Set();
            const scan = (arr) => (arr || []).forEach((fr) => {
                if (fr && fr.dropped && fr.url && !seen.has(fr.url)) { seen.add(fr.url); URL.revokeObjectURL(fr.url); }
            });
            scan(this.allTabs[key]);
            (this.history[key] || []).forEach(scan);
        } catch (_) {}
    },

    // ── 2. History → ComfyUI graph ───────────────────────────────────────────

    // Make a history-strip thumbnail a drag source for the node graph.
    _makeHistoryThumbDraggable(thumb, imgObj) {
        if (!thumb || !imgObj) return;
        thumb.draggable = true;
        const img = thumb.querySelector("img");
        if (img) img.draggable = false;   // let the container own the drag, not the <img>
        thumb.addEventListener("dragstart", (e) => {
            const payload = {
                path:      imgObj.path || null,
                url:       imgObj.url || null,
                filename:  imgObj.filename || imgObj.name || null,
                subfolder: imgObj.subfolder || "",
                type:      imgObj.type || null,
                external:  !!imgObj.external,
                dropped:   !!imgObj.dropped,
                kind:      imgObj.kind || (this._frameIsVideo(imgObj) ? "video" : "image"),
                thumb:     imgObj.thumb || null,
            };
            try {
                e.dataTransfer.setData("application/x-bepic-history", JSON.stringify(payload));
                e.dataTransfer.effectAllowed = "copy";
                if (img && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(img, 20, 20);
            } catch (_) {}
        });
    },

    _dragHasHistoryPayload(e) {
        try { return Array.from(e.dataTransfer?.types || []).includes("application/x-bepic-history"); }
        catch (_) { return false; }
    },

    setupGraphDropTarget() {
        if (this._graphDropBound) return;
        const attach = () => {
            const cv = (app.canvas && app.canvas.canvas) ||
                       app.canvasEl ||
                       document.getElementById("graph-canvas") ||
                       document.querySelector("canvas.litegraph");
            if (!cv) return false;
            this._graphDropBound = true;
            cv.addEventListener("dragover", (e) => {
                if (!this._dragHasHistoryPayload(e)) return;   // let ComfyUI handle its own drops
                e.preventDefault();
                try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
            });
            cv.addEventListener("drop", (e) => {
                if (!this._dragHasHistoryPayload(e)) return;
                e.preventDefault(); e.stopPropagation();
                let payload = null;
                try { payload = JSON.parse(e.dataTransfer.getData("application/x-bepic-history")); } catch (_) {}
                if (payload) this._dropHistoryOntoGraph(payload, e);
            });
            return true;
        };
        if (attach()) return;
        // The graph canvas may not exist yet at viewer init — retry briefly.
        let tries = 0;
        const timer = setInterval(() => { if (attach() || ++tries > 40) clearInterval(timer); }, 250);
    },

    // Build a fetchable URL for a history payload (mirrors buildImgUrl, no cache-bust).
    _frameFetchUrl(p) {
        if (p.url) return p.url;
        if (p.path) {
            const endpoint = p.external ? "/bepic/view_file" : "/bepic/raw_view";
            return api.apiURL(`${endpoint}?path=${encodeURIComponent(p.path)}`);
        }
        if (p.filename) {
            let q = `?filename=${encodeURIComponent(p.filename)}`;
            if (p.type)      q += `&type=${p.type}`;
            if (p.subfolder) q += `&subfolder=${encodeURIComponent(p.subfolder)}`;
            return api.apiURL(`/view${q}`);
        }
        return "";
    },

    _basename(p) {
        return String(p || "").replace(/\\/g, "/").split("/").pop() || "image.png";
    },

    async _dropHistoryOntoGraph(payload, e) {
        try {
            const isVideo = payload.kind === "video";
            const absPath = this._absPathForPayload(payload);

            // Preferred path: a VHS "(Path)" loader that references the ORIGINAL
            // file on disk — no upload, no duplicate copy in /input.
            if (absPath) {
                const type   = isVideo ? "VHS_LoadVideoPath" : "VHS_LoadImagePath";
                const widget = isVideo ? "video" : "image";
                if (this._nodeTypeAvailable(type)) {
                    this._createPathLoaderNode(type, widget, absPath, e);
                    return;
                }
                // VHS not installed → fall through to the native upload loader.
            }

            // Fallback: upload a copy to /input and use a native loader that reads
            // from there — image → LoadImage, video → LoadVideo (both accept
            // uploads). Also covers dropped-from-Explorer blobs that have no path.
            await this._dropViaUpload(payload, e, isVideo);
        } catch (err) {
            console.error("[bEpicViewer] drop-to-graph failed", err);
        }
    },

    // Absolute on-disk path for a history payload, or null when there isn't one
    // (dropped blob items, or filename/type-only frames without a real path).
    _absPathForPayload(p) {
        if (!p || p.dropped) return null;
        const path = p.path || "";
        return /^([a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(path) ? path : null;
    },

    _nodeTypeAvailable(type) {
        const LG = window.LiteGraph;
        return !!(LG && LG.registered_node_types && LG.registered_node_types[type]);
    },

    _createPathLoaderNode(type, widgetName, absPath, e) {
        const LG = window.LiteGraph;
        if (!LG || !LG.createNode) { console.warn("[bEpicViewer] LiteGraph unavailable"); return; }
        const node = LG.createNode(type);
        if (!node) { console.warn("[bEpicViewer] could not create node", type); return; }
        app.graph.add(node);

        try {
            const pos = app.canvas.convertEventToCanvasOffset(e);
            if (pos) node.pos = [pos[0] - (node.size?.[0] || 0) / 2, pos[1] - 20];
        } catch (_) {}

        const w = node.widgets && (
            node.widgets.find((x) => x.name === widgetName) ||
            node.widgets.find((x) => x.name === "video" || x.name === "image")
        );
        if (w) {
            try {
                w.value = absPath;                                   // OS abs path (VHS validates it server-side)
                if (typeof w.callback === "function") w.callback(absPath);
            } catch (_) {}
        }
        try { node.onResize?.(node.size); } catch (_) {}
        try { app.graph.setDirtyCanvas(true, true); } catch (_) {}
        try { if (app.canvas && app.canvas.selectNode) app.canvas.selectNode(node); } catch (_) {}
    },

    // Fallback for items without an absolute path (dropped blobs, filename-only
    // frames) or when VHS isn't installed: upload a copy to /input and drop a
    // native loader that reads from there.
    //   image → LoadImage (widget "image"),  video → LoadVideo (widget "file").
    async _dropViaUpload(payload, e, isVideo) {
        const fetchUrl = this._frameFetchUrl(payload);
        if (!fetchUrl) return;
        let fname = this._basename(payload.filename || payload.path || (isVideo ? "video.mp4" : "image.png"));
        const resp = await fetch(fetchUrl);
        if (!resp.ok) throw new Error(`fetch ${resp.status}`);
        const blob = await resp.blob();
        if (isVideo) {
            if (!/\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i.test(fname)) fname += ".mp4";
        } else {
            if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(fname)) fname += ".png";
        }
        const file = new File([blob], fname, { type: blob.type || (isVideo ? "video/mp4" : "image/png") });
        const uploaded = await this._uploadFileToInput(file);
        if (!uploaded) throw new Error("upload failed");

        if (isVideo) this._createNativeLoaderNode("LoadVideo", "file",  uploaded, e);
        else         this._createNativeLoaderNode("LoadImage", "image", uploaded, e);
    },

    // ComfyUI's /upload/image saves any uploaded file (image OR video) to /input.
    async _uploadFileToInput(file) {
        const body = new FormData();
        body.append("image", file, file.name);
        body.append("overwrite", "true");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body });
        if (resp.status !== 200) return null;
        const data = await resp.json();
        let path = data.name;
        if (data.subfolder) path = `${data.subfolder}/${path}`;
        return { path, name: data.name, subfolder: data.subfolder || "", type: data.type || "input" };
    },

    _createNativeLoaderNode(type, widgetName, uploaded, e) {
        const LG = window.LiteGraph;
        if (!LG || !LG.createNode) { console.warn("[bEpicViewer] LiteGraph unavailable"); return; }
        const node = LG.createNode(type);
        if (!node) { console.warn("[bEpicViewer] could not create node", type, "(is it installed?)"); return; }
        app.graph.add(node);

        try {
            const pos = app.canvas.convertEventToCanvasOffset(e);
            if (pos) node.pos = [pos[0] - (node.size?.[0] || 0) / 2, pos[1] - 20];
        } catch (_) {}

        const w = node.widgets && (
            node.widgets.find((x) => x.name === widgetName) ||
            node.widgets.find((x) => x.type === "combo")
        );
        if (w) {
            try {
                if (w.options && Array.isArray(w.options.values) && !w.options.values.includes(uploaded.path)) {
                    w.options.values.push(uploaded.path);
                }
                w.value = uploaded.path;
                if (typeof w.callback === "function") w.callback(uploaded.path);
            } catch (_) {}
        }
        try { node.onResize?.(node.size); } catch (_) {}
        try { app.graph.setDirtyCanvas(true, true); } catch (_) {}
        try { if (app.canvas && app.canvas.selectNode) app.canvas.selectNode(node); } catch (_) {}
    },
};
