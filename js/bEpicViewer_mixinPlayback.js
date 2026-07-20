// bEpicViewer_mixinPlayback.js
// Playback, timeline, frame navigation, zoom helpers, image URL builder.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

export const PlaybackMixin = {

    // ── Image URL builder ────────────────────────────────────────────────────

    buildImgUrl(imgObj) {
        if (!imgObj) return '';
        // Dropped OS files are served straight from an in-memory blob: URL — it is
        // already unique per file, so never cache-bust or rewrite it.
        if (imgObj.url) return imgObj.url;
        if (imgObj.path) {
            const endpoint = imgObj.external ? '/bepic/view_file' : '/bepic/raw_view';
            return api.apiURL(`${endpoint}?path=${encodeURIComponent(imgObj.path)}&t=${Date.now()}`);
        }
        let params = `?filename=${encodeURIComponent(imgObj.filename || '')}`;
        if (imgObj.type)     params += `&type=${imgObj.type}`;
        if (imgObj.subfolder) params += `&subfolder=${encodeURIComponent(imgObj.subfolder)}`;
        params += `&t=${Date.now()}`;
        return api.apiURL(`/view${params}`);
    },

    // Thumbnail URL for a frame. Video frames carry an extracted `thumb` PNG
    // because an <img> (history strip) can't render the video file itself.
    thumbUrl(imgObj) {
        if (imgObj && imgObj.thumb) {
            // A dropped video's poster is an inline data:/blob: URL, not a temp path.
            if (/^(data:|blob:)/.test(imgObj.thumb)) return imgObj.thumb;
            return this.buildImgUrl({ path: imgObj.thumb, type: "temp" });
        }
        return this.buildImgUrl(imgObj);
    },

    // ── Shape info overlay ───────────────────────────────────────────────────

    updateShapeInfo() {
        if (!this.showShape) { this.shapeOverlay.style.display = "none"; return; }
        if (this.imgBase.naturalWidth) {
            this.shapeOverlay.style.display = "block";
            const batchSize = this.getImgCount();
            const { naturalWidth: w, naturalHeight: h } = this.imgBase;
            let text = `Tensor Shape: [${batchSize}, ${h}, ${w}, 3]`;
            if (batchSize === 1) text += " [Still Frame]";
            this.shapeOverlay.innerText = text;
        } else {
            this.shapeOverlay.style.display = "none";
        }
    },

    // ── Tab / image count helpers ────────────────────────────────────────────

    getImgCount() {
        // A video tab holds a single frame dict but scrubs over many frames.
        if (this._videoMode && this._videoFrames > 0) return this._videoFrames;
        return (this.allTabs[this.activeTab] || []).length;
    },

    getActiveTabNode() {
        const key = this.activeTab;
        if (!key) return null;
        if (key.startsWith('send_')) return app.graph.getNodeById(key.slice(5)) || null;
        if (key.startsWith('tab')) {
            const idx = parseInt(key.replace('tab', '')) - 1;
            const vn  = this.viewerNode;
            if (!vn || !vn.inputs) return null;
            const inp = vn.inputs[idx];
            if (!inp || inp.link == null) return null;
            const link = app.graph.links[inp.link];
            if (!link) return null;
            return app.graph.getNodeById(link.origin_id) || null;
        }
        return null;
    },

    // ── Timeline bounds / range ──────────────────────────────────────────────

    getTimelineBounds(imgCount = this.getImgCount()) {
        if (this.isInputRangeLocked && this.lockedTimelineRange) {
            const start = Math.max(0, Math.floor(this.lockedTimelineRange.start));
            const end   = Math.max(start, Math.floor(this.lockedTimelineRange.end));
            return { min: start, max: end };
        }
        return { min: 0, max: Math.max(0, imgCount - 1) };
    },

    isShowingTrimmedSequence(imgCount = this.getImgCount()) {
        if (!this.isInputRangeLocked || !this.playbackRange) return false;
        const start = Math.max(0, Math.floor(this.playbackRange.start));
        const end   = Math.max(start, Math.floor(this.playbackRange.end));
        return imgCount <= Math.max(1, end - start + 1);
    },

    displayFrameToImageIndex(displayFrame, imgCount = this.getImgCount()) {
        if (imgCount <= 0) return 0;
        if (this.isInputRangeLocked && this.playbackRange && this.isShowingTrimmedSequence(imgCount)) {
            const start       = Math.max(0, Math.floor(this.playbackRange.start));
            const clampedDisp = Math.max(start, Math.min(Math.floor(displayFrame), this.playbackRange.end));
            return Math.max(0, Math.min(clampedDisp - start, imgCount - 1));
        }
        return Math.max(0, Math.min(Math.floor(displayFrame), imgCount - 1));
    },

    imageIndexToDisplayFrame(imgIndex, imgCount = this.getImgCount()) {
        if (this.isInputRangeLocked && this.playbackRange && this.isShowingTrimmedSequence(imgCount)) {
            return Math.max(0, Math.floor(this.playbackRange.start)) + imgIndex;
        }
        return imgIndex;
    },

    applyTimelineBounds(imgCount = this.getImgCount()) {
        const bounds           = this.getTimelineBounds(imgCount);
        this.timeline.min      = bounds.min;
        this.timeline.max      = bounds.max;
        this.container.querySelector('#total-f').innerText = bounds.max;
        this.updateTicks(Math.max(0, bounds.max - bounds.min));
        this.updateRangeOverlay(imgCount);
        // Keep roto keyframe ticks + curve editor aligned to new timeline bounds.
        if (this._toolState && this._toolState.active === 'roto') {
            this._rotoRenderTimelineKeys && this._rotoRenderTimelineKeys();
            this._rotoRefreshKfEditor && this._rotoRefreshKfEditor();
        }
        return bounds;
    },

    updateRangeOverlay(imgCount = this.getImgCount()) {
        const rangeEl = this.container.querySelector('#timeline-range');
        if (!rangeEl || !this.playbackRange) { if (rangeEl) rangeEl.style.display = 'none'; return; }

        const bounds      = this.getTimelineBounds(imgCount);
        const totalFrames = Math.max(0, bounds.max - bounds.min);
        const start = Math.max(bounds.min, Math.min(bounds.max, this.playbackRange.start));
        const end   = Math.max(start, Math.min(bounds.max, this.playbackRange.end));
        const leftPct  = totalFrames === 0 ? 0   : ((start - bounds.min) / totalFrames) * 100;
        const widthPct = totalFrames === 0 ? 100 : ((end - start) / totalFrames) * 100;

        rangeEl.style.display = 'block';
        rangeEl.style.left    = `${leftPct}%`;
        rangeEl.style.width   = `${widthPct}%`;
    },

    // ── Ticks ────────────────────────────────────────────────────────────────

    updateTicks(count) {
        const ticksContainer = this.container.querySelector('#timeline-ticks');
        if (!ticksContainer) return;

        // Fast-path: skip if tick count hasn't changed
        if (ticksContainer.dataset.lastCount === String(count)) return;
        ticksContainer.dataset.lastCount = String(count);

        if (count <= 0) { ticksContainer.innerHTML = ''; return; }

        const step = count > 500 ? Math.ceil(count / 500) : 1;
        const frag = document.createDocumentFragment();
        for (let i = 0; i <= count; i += step) {
            const tick = document.createElement('div');
            tick.className = 'tick' + ((i % 5 === 0) ? ' major' : '');
            frag.appendChild(tick);
        }
        ticksContainer.innerHTML = '';
        ticksContainer.appendChild(frag);
    },

    // ── Timeline event setup ─────────────────────────────────────────────────

    setupTimelineEvents() {
        const container = this.shadowRoot.getElementById('timeline-container');
        const rangeEl   = this.shadowRoot.getElementById('timeline-range');

        container.onmousedown = (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            e.stopPropagation();

            this.isSelectingRange = true;
            const rect        = container.getBoundingClientRect();
            const bounds      = this.getTimelineBounds();
            const totalFrames = Math.max(0, bounds.max - bounds.min);
            const startX      = e.clientX - rect.left;
            const startPct    = Math.max(0, Math.min(1, startX / rect.width));
            const startFrame  = bounds.min + Math.round(startPct * totalFrames);

            this.playbackRange = { start: startFrame, end: startFrame };
            rangeEl.style.display = 'block';
            rangeEl.style.left    = `${totalFrames === 0 ? 0 : ((startFrame - bounds.min) / totalFrames) * 100}%`;
            rangeEl.style.width   = '0%';

            const win = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                const currentPct   = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
                const currentFrame = bounds.min + Math.round(currentPct * totalFrames);
                const min = Math.min(startFrame, currentFrame);
                const max = Math.max(startFrame, currentFrame);
                this.playbackRange = { start: min, end: max };
                const leftPct  = totalFrames === 0 ? 0 : ((min - bounds.min) / totalFrames) * 100;
                const widthPct = totalFrames === 0 ? 0 : ((max - min) / totalFrames) * 100;
                rangeEl.style.left  = `${leftPct}%`;
                rangeEl.style.width = `${widthPct}%`;
            };

            const onUp = () => {
                win.removeEventListener('mousemove', onMove);
                win.removeEventListener('mouseup',   onUp);
                this.isSelectingRange = false;
                if (this.playbackRange.start === this.playbackRange.end) {
                    this.playbackRange = null;
                    rangeEl.style.display = 'none';
                }
                if (this.isInputRangeLocked) { this.applyTimelineBounds(); this.syncInputRange(); }
            };

            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    // ── View refresh ─────────────────────────────────────────────────────────

    refreshView() {
        const imgs = this.allTabs[this.activeTab];
        if (!imgs) return;
        this.applyTimelineBounds(imgs.length);
        const bounds    = this.getTimelineBounds(imgs.length);
        const safeFrame = Math.max(bounds.min, Math.min(this.currentFrame, bounds.max));
        this.setFrame(safeFrame);
    },

    // ── Frame display ─────────────────────────────────────────────────────────

    setFrame(idx) {
        // --- history-compare mode: show two fixed snapshot frames ---
        if (this.historyCompare) {
            const { key, baseIdx, otherIdx } = this.historyCompare;
            const baseArr  = (this.history[key] && this.history[key][baseIdx])  || [];
            const otherArr = (this.history[key] && this.history[key][otherIdx]) || [];
            const bfi = this.displayFrameToImageIndex(idx, baseArr.length);
            const ofi = this.displayFrameToImageIndex(idx, otherArr.length);
            this.currentFrame = idx;
            if (baseArr[bfi])  this._setImgSrcCached(this.imgBase,    this.buildImgUrl(baseArr[bfi]));
            if (otherArr[ofi]) this._setImgSrcCached(this.imgCompare, this.buildImgUrl(otherArr[ofi]));
            this.timeline.value = this.currentFrame;
            this.container.querySelector('#cur-f').innerText = this.currentFrame;
            if (this.imgBase.naturalWidth) this.updateShapeInfo();
            return;
        }

        const imgs = this.allTabs[this.activeTab];
        if (!imgs || imgs.length === 0) { this._exitVideoMode(); return; }

        // Video tab: a single {kind:"video"} entry scrubbed through the <video>.
        // Still refresh the compare slot so a video base shows the second tab in
        // the wipe (the early return used to skip the compare update below).
        if (this._frameIsVideo(imgs[0])) {
            this._videoSeek(idx, imgs[0]);
            this._updateCompareFrame(this.currentFrame);
            return;
        }
        this._exitVideoMode();

        const imgIdx = this.displayFrameToImageIndex(idx, imgs.length);
        if (!imgs[imgIdx]) return;
        this.currentFrame = this.imageIndexToDisplayFrame(imgIdx, imgs.length);

        const i       = imgs[imgIdx];
        const baseUrl = this.buildImgUrl(i);

        // Only update src when URL actually changes (avoids re-decode flicker)
        this._setImgSrcCached(this.imgBase, baseUrl, () => {
            if (this.sliderMode === 'contact') this.resizeContactContainer();
            if (this.updateImageFrame) this.updateImageFrame();
            if (this.updateShapeInfo) this.updateShapeInfo();
            if (this.updateToolOverlay) this.updateToolOverlay();
        });

        // Path bar
        if (this.pathBar) {
            if (i.external && i.path) {
                this.pathBar.textContent = i.path;
                this.pathBar.title       = i.path;
                this.pathBar.style.display = 'block';
            } else {
                this.pathBar.style.display = 'none';
            }
        }

        this._updateCompareFrame(this.currentFrame);

        this.timeline.value = this.currentFrame;
        this.container.querySelector('#cur-f').innerText = this.currentFrame;
        if (this.imgBase.naturalWidth) this.updateShapeInfo();
        // Roto keyframes are frame-dependent — refresh the overlay on scrub/play.
        if (this._toolState && this._toolState.active === "roto") {
            this._rotoRefreshKfInfo && this._rotoRefreshKfInfo();
            this._toolRedraw && this._toolRedraw();
        }
    },

    // Load the compare tab's frame into the compare slot. Called from both the
    // image and video base paths so either base still fills the wipe/split/contact
    // with the second tab. Images go to the compare <img>; a video compare tab is
    // routed to the dedicated compare <video> (an <img> can't decode a video).
    _updateCompareFrame(displayFrame) {
        if (!this.isComparing || !this.compareTab) { this._hideCompareVideo(); return; }
        const compImgs = this.allTabs[this.compareTab];
        if (!compImgs || compImgs.length === 0) return;

        // Video compare tab → drive the compare <video>.
        if (this._frameIsVideo(compImgs[0])) { this._compareVideoSync(displayFrame, compImgs[0]); return; }

        // Image compare tab → drive the compare <img>, hide the compare video.
        this._hideCompareVideo();
        if (this.imgCompare) this.imgCompare.style.display = "block";
        const compIdx = this.displayFrameToImageIndex(displayFrame, compImgs.length);
        const o = compImgs[compIdx];
        if (!o) return;
        this._setImgSrcCached(this.imgCompare, this.buildImgUrl(o), () => {
            if (this.sliderMode === 'contact') this.resizeContactContainer();
            if (this.updateImageFrame) this.updateImageFrame();
        });
    },

    // Show the compare tab's video in the compare <video>, seeking it to the same
    // frame index as the base. While playing it runs natively (rate matched to the
    // base fps) for smoothness; when paused/scrubbing it seeks by currentTime.
    _compareVideoSync(displayFrame, vObj) {
        const v = this.videoCompare;
        if (!v) return;
        const key = vObj.path || vObj.filename || "";
        if (v.dataset.key !== key) {
            v.dataset.key = key;
            v.loop  = true;
            v.muted = true;
            if (!v._cmpHandlersBound) {
                v.addEventListener("loadedmetadata", () => {
                    if (!this.isComparing) return;
                    if (!(this._compareVideoFrames > 0) && v.duration) {
                        this._compareVideoFrames = Math.max(1, Math.round(v.duration * (this._compareVideoFps || 24)));
                    }
                    if (this.sliderMode === 'contact') this.resizeContactContainer();
                    this.updateTransform && this.updateTransform();
                    // Re-seek: a currentTime set before metadata loaded is ignored.
                    this._updateCompareFrame(this.currentFrame);
                });
                v._cmpHandlersBound = true;
            }
            const url = this.buildImgUrl(vObj);
            if (v.src !== url) v.src = url;
            this._compareVideoFps    = (vObj.fps && vObj.fps > 0) ? vObj.fps : (this.fps || 24);
            this._compareVideoFrames = (vObj.frames && vObj.frames > 0) ? vObj.frames : 0;
        }

        // Reveal the compare video, hide the compare <img>. On first reveal, sync
        // its transform + clip once (ongoing changes flow through updateTransform /
        // the slider drag), so playback doesn't re-run layout every frame.
        const wasHidden = v.style.display === "none";
        if (this.imgCompare) this.imgCompare.style.display = "none";
        v.style.display = "block";
        if (wasHidden) {
            if (this.imgCompare) v.style.transform = this.imgCompare.style.transform;
            this.updateCompareVisuals && this.updateCompareVisuals();
        }

        const fps = this._compareVideoFps || 24;
        if (this.isPlaying) {
            this._compareVideoEnsurePlaying();
            const wantT = displayFrame / fps;
            if (Math.abs((v.currentTime || 0) - wantT) > 0.25) { try { v.currentTime = wantT; } catch (e) {} }
        } else {
            try { v.pause(); } catch (e) {}
            let frame = Math.floor(displayFrame);
            if (this._compareVideoFrames > 0) frame = Math.max(0, Math.min(frame, this._compareVideoFrames - 1));
            try { v.currentTime = frame / fps; } catch (e) {}
        }
    },

    // Play the compare video in lockstep with the base: rate = base fps / native
    // fps so one base frame advances one compare frame in real time.
    _compareVideoEnsurePlaying() {
        const v = this.videoCompare;
        if (!v) return;
        const native = this._compareVideoFps || 24;
        let rate = (this.fps || native) / native;
        if (!Number.isFinite(rate) || rate <= 0) rate = 1;
        rate = Math.max(0.0625, Math.min(16, rate));
        try { v.playbackRate = rate; } catch (e) {}
        if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    },

    _hideCompareVideo() {
        const v = this.videoCompare;
        if (!v) return;
        try { v.pause(); } catch (e) {}
        v.style.display = "none";
    },

    // Only assign src when it has actually changed, to prevent redundant decodes.
    _setImgSrcCached(imgEl, url, onLoadCallback) {
        imgEl.onerror = () => {};
        if (onLoadCallback) {
            imgEl.onload = onLoadCallback;
        } else {
            imgEl.onload = null;
        }
        if (imgEl.src !== url) imgEl.src = url;
    },

    // ── Video playback ────────────────────────────────────────────────────────
    // A "save to ./output" node writing mp4/mov/webm sends the viewer a single
    // {kind:"video", fps, frames} entry. The <video> element decodes it and is
    // driven by the same transport (play/timeline/step) and zoom/pan as images.

    _frameIsVideo(o) {
        return !!(o && (o.kind === "video" ||
            /\.(mp4|m4v|mov|webm|mkv)$/i.test(o.path || o.filename || "")));
    },

    _enterVideoMode(imgObj) {
        const v = this.videoBase;
        if (!v) return;
        // Key on the stable path, not the cache-busted URL — otherwise every
        // scrub would look like a new source and reload the whole video.
        const key = imgObj.path || imgObj.filename || "";
        if (this._videoMode && this._videoKey === key) return;   // already showing
        const wasVideo = this._videoMode;
        const url = this.buildImgUrl(imgObj);

        this._videoMode   = true;
        this._videoKey    = key;
        this._videoFps    = (imgObj.fps && imgObj.fps > 0) ? imgObj.fps : (this.fps || 24);
        this._videoFrames = (imgObj.frames && imgObj.frames > 0) ? imgObj.frames : 0;

        // The FPS field reflects the video's rate while it plays; remember the
        // user's setting (once, on the image→video transition) so switching to
        // another history item / image restores it.
        if (!wasVideo) this._savedFps = this.fps;
        this._setFpsUi(this._videoFps);

        if (this.imgBase)    this.imgBase.style.display = "none";
        // Keep the compare overlay up when comparing — the video is the base layer
        // and the compare <img> wipes over it.
        if (this.imgCompare) this.imgCompare.style.display = this.isComparing ? "block" : "none";
        if (this.imgFrame)   this.imgFrame.style.display = "none";
        v.style.display = "block";
        v.loop  = (this.loopMode === "loop" || this.loopMode === "ping-pong");
        v.muted = false;

        if (!this._videoHandlersBound) {
            v.addEventListener("timeupdate",     () => this._videoOnTimeUpdate());
            v.addEventListener("loadedmetadata", () => this._videoOnMeta());
            v.addEventListener("ended",          () => this._videoOnEnded());
            this._videoHandlersBound = true;
        }
        if (v.src !== url) v.src = url;
        this._applyVideoPlaybackRate();

        this.updateTransform();
        if (this.setImageFilter) this.setImageFilter();
        if (this.pathBar && imgObj.path) {
            this.pathBar.textContent = imgObj.path;
            this.pathBar.title       = imgObj.path;
            this.pathBar.style.display = "block";
        }
        if (this._videoFrames > 0) this.applyTimelineBounds(this._videoFrames);
    },

    _exitVideoMode() {
        if (!this._videoMode) return;
        this._videoMode = false;
        this._videoKey  = null;
        this._videoFrames = 0;
        const v = this.videoBase;
        if (v) {
            try { v.pause(); } catch (e) {}
            v.removeAttribute("src");
            try { v.load(); } catch (e) {}
            v.style.display = "none";
        }
        if (this.imgBase)    this.imgBase.style.display = "";
        if (this.imgCompare) this.imgCompare.style.display = this.isComparing ? "block" : "none";
        // Restore the FPS field to the user's setting from before the video.
        if (this._savedFps != null) { this._setFpsUi(this._savedFps); this._savedFps = null; }
    },

    // Set the playback fps and reflect it in the #fps-in field.
    _setFpsUi(value) {
        this.fps = value;
        const el = this.shadowRoot && this.shadowRoot.getElementById("fps-in");
        if (el) el.value = Number.isInteger(value) ? value : Math.round(value * 1000) / 1000;
    },

    _videoSeek(idx, imgObj) {
        this._enterVideoMode(imgObj);
        const fps = this._videoFps || 24;
        let frame = Math.floor(idx);
        frame = this._videoFrames > 0 ? Math.max(0, Math.min(frame, this._videoFrames - 1))
                                      : Math.max(0, frame);
        this.currentFrame = frame;
        try { this.videoBase.currentTime = frame / fps; } catch (e) {}
        if (this.timeline) this.timeline.value = frame;
        const curEl = this.container && this.container.querySelector("#cur-f");
        if (curEl) curEl.innerText = frame;
    },

    _videoOnMeta() {
        const v = this.videoBase;
        if (!this._videoMode || !v) return;
        if (!(this._videoFrames > 0)) {
            this._videoFrames = Math.max(1, Math.round((v.duration || 0) * (this._videoFps || 24)));
        }
        this.applyTimelineBounds(this._videoFrames);
        this.fitView();
        this._applyVideoPlaybackRate();
        if (this.timeline) this.timeline.value = this.currentFrame || 0;
    },

    _videoOnTimeUpdate() {
        const v = this.videoBase;
        if (!this._videoMode || !v) return;
        const fps = this._videoFps || 24;

        // Region playback (ctrl-drag selection on the timeline): keep the <video>
        // inside the selected range instead of playing the whole clip.
        if (this.isPlaying && this.playbackRange) {
            const startT = this.playbackRange.start / fps;
            const endT   = (this.playbackRange.end + 1) / fps;
            if (v.currentTime >= endT - 1e-3 || v.currentTime < startT - 1e-3) {
                if (this.loopMode === "once") {
                    this.stop();
                    try { v.currentTime = Math.max(startT, endT - 1 / fps); } catch (e) {}
                } else {
                    // loop + ping-pong both restart at the region start (a <video>
                    // can't scrub backwards smoothly, so ping-pong loops forward).
                    try { v.currentTime = startT; } catch (e) {}
                }
            }
        }

        const frame = Math.round((v.currentTime || 0) * fps);
        this.currentFrame = frame;
        if (this.timeline) this.timeline.value = frame;
        const curEl = this.container && this.container.querySelector("#cur-f");
        if (curEl) curEl.innerText = frame;
        // Native <video> playback doesn't go through setFrame, so advance the
        // compare overlay here to keep the wipe in sync while the video plays.
        this._updateCompareFrame(frame);
    },

    // Fired when the <video> plays past its end. If a region is active in a
    // looping mode the wrap in _videoOnTimeUpdate usually fires first, but when
    // the region ends on the last frame the clip can end naturally — restart it.
    _videoOnEnded() {
        const v = this.videoBase;
        if (!v) return;
        if (this._videoMode && this.isPlaying && this.playbackRange && this.loopMode !== "once") {
            const fps = this._videoFps || 24;
            try {
                v.currentTime = this.playbackRange.start / fps;
                const p = v.play();
                if (p && p.catch) p.catch(() => {});
            } catch (e) {}
            return;
        }
        if (!v.loop) this.stop();
    },

    // Drive <video> playback speed from the FPS field: rate = wanted / native, so
    // changing FPS re-times the clip (e.g. a 30-fps video at 60 plays 2× faster)
    // while the frame counter still maps through the native rate.
    _applyVideoPlaybackRate() {
        const v = this.videoBase;
        if (!v || !this._videoMode) return;
        const native = this._videoFps || 24;
        const want   = this.fps || native;
        let rate = want / native;
        if (!Number.isFinite(rate) || rate <= 0) rate = 1;
        rate = Math.max(0.0625, Math.min(16, rate));   // browsers reject extreme rates anyway
        try { v.playbackRate = rate; } catch (e) {}
    },

    // ── Playback ──────────────────────────────────────────────────────────────

    play() {
        this.stop();
        const count = this.getImgCount();
        if (count === 0) return;

        // Video tabs play through the browser's decoder; the timeline follows
        // via the <video>'s timeupdate events (see _enterVideoMode).
        if (this._videoMode && this.videoBase) {
            this.isPlaying = true;
            this._setIcon(this.playBtn, 'icon-pause');
            const v = this.videoBase;
            const fps = this._videoFps || 24;
            if (this.playbackRange) {
                // Region playback: manage looping manually (see _videoOnTimeUpdate),
                // and jump into the region if we're currently outside it.
                v.loop = false;
                const startT = this.playbackRange.start / fps;
                const endT   = (this.playbackRange.end + 1) / fps;
                if (v.currentTime < startT - 1e-3 || v.currentTime >= endT - 1e-3) {
                    try { v.currentTime = startT; } catch (e) {}
                }
            } else {
                v.loop = (this.loopMode === 'loop' || this.loopMode === 'ping-pong');
            }
            this._applyVideoPlaybackRate();
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
            return;
        }

        this.isPlaying        = true;
        this._setIcon(this.playBtn, 'icon-pause');

        const bounds = this.getTimelineBounds(count);
        let min = bounds.min;
        let max = bounds.max;

        if (this.playbackRange) {
            min = this.playbackRange.start;
            max = this.playbackRange.end;
            if (this.currentFrame < min || this.currentFrame > max) this.setFrame(min);
        }

        this.playbackInterval = setInterval(() => {
            let next = this.currentFrame + this.direction;
            if (this.loopMode === "ping-pong") {
                if (next >= max || next <= min) {
                    this.direction *= -1;
                    next = Math.max(min, Math.min(max, this.currentFrame + this.direction));
                }
            } else {
                if (next > max) {
                    if (this.loopMode === "loop") next = min; else { this.stop(); return; }
                } else if (next < min) {
                    if (this.loopMode === "loop") next = max; else { this.stop(); return; }
                }
            }
            this.setFrame(next);
        }, 1000 / this.fps);
    },

    stop() {
        this.isPlaying = false;
        this._setIcon(this.playBtn, 'icon-play');
        if (this.playbackInterval) clearInterval(this.playbackInterval);
        if (this._videoMode && this.videoBase) { try { this.videoBase.pause(); } catch (e) {} }
        if (this.videoCompare) { try { this.videoCompare.pause(); } catch (e) {} }
    },

    step(n) {
        this.stop();
        const c = this.getImgCount();
        if (!c) return;
        const bounds   = this.getTimelineBounds(c);
        const span     = Math.max(1, bounds.max - bounds.min + 1);
        const offset   = this.currentFrame - bounds.min;
        const wrapped  = ((offset + n) % span + span) % span;
        this.setFrame(bounds.min + wrapped);
    },

    // ── Fit view ──────────────────────────────────────────────────────────────

    fitView() {
        // Video tab: fit using the decoded video dimensions.
        if (this._videoMode && this.videoBase) {
            const vw = this.videoBase.videoWidth, vh = this.videoBase.videoHeight;
            if (!vw || !vh) return;
            try {
                const viewRect = this.viewport.getBoundingClientRect();
                const availW   = Math.max(10, viewRect.width  - 2);
                const availH   = Math.max(10, viewRect.height - 2);
                const contain  = Math.min(availW / vw, availH / vh);
                const dispW = Math.max(1, vw * contain), dispH = Math.max(1, vh * contain);
                const targetZoom = (availW / availH >= vw / vh) ? (availH / dispH) : (availW / dispW);
                this.zoom = Math.max(0.05, Math.min(20.0, targetZoom));
            } catch (e) { this.zoom = 1.0; }
            this.panX = 0; this.panY = 0;
            this.updateTransform();
            return;
        }
        if (!this.imgBase.naturalWidth) return;
        try {
            const viewRect = this.viewport.getBoundingClientRect();
            const availW   = Math.max(10, viewRect.width  - 2);
            const availH   = Math.max(10, viewRect.height - 2);

            const cmp = this._compareMediaSize ? this._compareMediaSize() : { w: this.imgCompare.naturalWidth, h: this.imgCompare.naturalHeight };
            if (this.sliderMode === 'contact' && cmp.w) {
                const groupW     = this.imgBase.naturalWidth  + cmp.w;
                const groupH     = Math.max(this.imgBase.naturalHeight, cmp.h);
                this.zoom        = Math.max(0.05, Math.min(20.0, Math.min(availW / groupW, availH / groupH)));
            } else {
                const imgW = this.imgBase.naturalWidth;
                const imgH = this.imgBase.naturalHeight;

                const viewAspect = availW / availH;
                const imgAspect  = imgW / imgH;

                const containScale   = Math.min(availW / imgW, availH / imgH);
                const baseDisplayedW = Math.max(1, imgW * containScale);
                const baseDisplayedH = Math.max(1, imgH * containScale);

                const fitByHeight = viewAspect >= imgAspect;
                const targetZoom  = fitByHeight
                    ? (availH / baseDisplayedH)
                    : (availW / baseDisplayedW);

                this.zoom = Math.max(0.05, Math.min(20.0, targetZoom));
            }
            this.panX = 0;
            this.panY = 0;
            this.updateTransform();
        } catch (e) {
            this.panX = 0; this.panY = 0; this.zoom = 1.0; this.updateTransform();
        }
    },

    // Set zoom so the media displays at `fraction` of its ACTUAL pixel size
    // (1.0 = 100% = one image pixel per screen pixel, e.g. a 1920×1080 clip fills
    // 1920 screen px). Unlike fitView (relative to the viewport), this is relative
    // to the media's native resolution. Used by the zoom menu's 100/75/50% items.
    setPixelZoom(fraction) {
        if (!Number.isFinite(fraction) || fraction <= 0) fraction = 1;

        // Contact-compare packs two images into a container with its own transform
        // origin; "actual size" isn't well-defined there, so apply plainly.
        if (this.sliderMode === 'contact') {
            this.zoom = Math.max(0.05, Math.min(20.0, fraction));
            this.panX = 0; this.panY = 0; this.updateTransform();
            return;
        }

        let natW = 0, natH = 0;
        if (this._videoMode && this.videoBase) {
            natW = this.videoBase.videoWidth; natH = this.videoBase.videoHeight;
        } else if (this.imgBase) {
            natW = this.imgBase.naturalWidth; natH = this.imgBase.naturalHeight;
        }

        if (natW && natH && this.viewport) {
            const viewRect = this.viewport.getBoundingClientRect();
            const availW   = Math.max(10, viewRect.width  - 2);
            const availH   = Math.max(10, viewRect.height - 2);
            // The <img>/<video> uses max-width/height:100% (.img-layer) so at
            // zoom=1 it renders at min(natural, contain) — CSS never upscales.
            const containScale = Math.min(availW / natW, availH / natH);
            const renderScale  = Math.min(1, containScale);
            const targetZoom   = fraction / renderScale;   // displayed px = natural px × fraction
            this.zoom = Math.max(0.05, Math.min(20.0, targetZoom));
        } else {
            this.zoom = Math.max(0.05, Math.min(20.0, fraction));
        }
        this.panX = 0; this.panY = 0;
        this.updateTransform();
    },

    // ── Input range sync ─────────────────────────────────────────────────────

    toggleInputRange() {
        this.isInputRangeLocked = !this.isInputRangeLocked;
        this.rangeBtn?.classList.toggle("active", this.isInputRangeLocked);
        if (this.isInputRangeLocked) {
            const currentBounds = { min: 0, max: Math.max(0, this.getImgCount() - 1) };
            this.lockedTimelineRange = { start: currentBounds.min, end: currentBounds.max };
            if (!this.playbackRange) this.playbackRange = { start: currentBounds.min, end: currentBounds.max };
            this.applyTimelineBounds();
            this.updateRangeOverlay();
            this.syncInputRange();
        } else {
            this.restoreInputRange();
            this.lockedTimelineRange = null;
            this.applyTimelineBounds();
            this.updateRangeOverlay();
        }
    },

    restoreInputRange() {
        this.originalNodeValues.forEach((vals, id) => {
            const n = app.graph.getNodeById(id);
            if (n && n.widgets) {
                const s = n.widgets.find(w => w.name === "skip_first_frames");
                const c = n.widgets.find(w => w.name === "frame_load_cap");
                if (s) s.value = vals.skip;
                if (c) c.value = vals.cap;
                n.onResize?.(n.size);
            }
        });
        this.originalNodeValues.clear();
        app.graph.setDirtyCanvas(true, true);
    },

    syncInputRange() {
        if (!this.isInputRangeLocked) return;
        const nodes = app.graph._nodes.filter(n => {
            if (!n.widgets) return false;
            const hasSkip = n.widgets.some(w => w.name === "skip_first_frames");
            const hasCap  = n.widgets.some(w => w.name === "frame_load_cap");
            const isLoader = (n.type && n.type.toLowerCase().includes("loadvideo")) || (n.title && n.title.toLowerCase().includes("load video"));
            return hasSkip && hasCap && isLoader;
        });

        const start = this.playbackRange ? this.playbackRange.start : 0;
        const cap   = this.playbackRange ? this.playbackRange.end - this.playbackRange.start + 1 : 0;

        nodes.forEach(n => {
            const skipW = n.widgets.find(w => w.name === "skip_first_frames");
            const capW  = n.widgets.find(w => w.name === "frame_load_cap");
            if (!this.originalNodeValues.has(n.id)) {
                this.originalNodeValues.set(n.id, { skip: skipW ? skipW.value : 0, cap: capW ? capW.value : 0 });
            }
            if (skipW) skipW.value = start;
            if (capW)  capW.value  = cap;
            n.onResize?.(n.size);
        });
        app.graph.setDirtyCanvas(true, true);
    },
};
