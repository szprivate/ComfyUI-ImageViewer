// bEpicViewer_mixinPlayback.js
// Playback, timeline, frame navigation, zoom helpers, image URL builder.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

export const PlaybackMixin = {

    // ── Image URL builder ────────────────────────────────────────────────────

    buildImgUrl(imgObj) {
        if (!imgObj) return '';
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

    getImgCount() { return (this.allTabs[this.activeTab] || []).length; },

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
        if (!imgs || imgs.length === 0) return;
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

        if (this.isComparing && this.compareTab && this.allTabs[this.compareTab]) {
            const compImgs = this.allTabs[this.compareTab];
            const compIdx  = this.displayFrameToImageIndex(this.currentFrame, compImgs.length);
            if (compImgs[compIdx]) {
                this._setImgSrcCached(this.imgCompare, this.buildImgUrl(compImgs[compIdx]), () => {
                    if (this.sliderMode === 'contact') this.resizeContactContainer();
                    if (this.updateImageFrame) this.updateImageFrame();
                });
            }
        }

        this.timeline.value = this.currentFrame;
        this.container.querySelector('#cur-f').innerText = this.currentFrame;
        if (this.imgBase.naturalWidth) this.updateShapeInfo();
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

    // ── Playback ──────────────────────────────────────────────────────────────

    play() {
        this.stop();
        const count = this.getImgCount();
        if (count === 0) return;

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
        if (!this.imgBase.naturalWidth) return;
        try {
            const viewRect = this.viewport.getBoundingClientRect();
            const availW   = Math.max(10, viewRect.width  - 2);
            const availH   = Math.max(10, viewRect.height - 2);

            if (this.sliderMode === 'contact' && this.imgCompare.naturalWidth) {
                const groupW     = this.imgBase.naturalWidth  + this.imgCompare.naturalWidth;
                const groupH     = Math.max(this.imgBase.naturalHeight, this.imgCompare.naturalHeight);
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
