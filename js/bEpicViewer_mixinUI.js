// bEpicViewer_mixinUI.js
// UI interactions: zoom/pan, compare slider, panel dragging/resizing,
// undocking, hotkeys, tab highlights, compare mode, slider modes.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

export const UIMixin = {

    // ── Exposure ─────────────────────────────────────────────────────────────

    setExposure(value) {
        const parsed = Number.isFinite(value) ? value : 0;
        this.exposure = Math.max(-4, Math.min(4, parsed));

        if (this.exposureSlider) this.exposureSlider.value = String(this.exposure);
        if (this.exposureValue) this.exposureValue.textContent = `${this.exposure.toFixed(1)} EV`;

        this.applyExposure();
    },

    resetExposure() {
        this.setExposure(0);
    },

    setChannelView(mode) {
        const allowed = new Set(['all', 'red', 'green', 'blue']);
        const next = allowed.has(mode) ? mode : 'all';
        this.channelView = next;
        if (this.rgbChannelSel && this.rgbChannelSel.value !== next) this.rgbChannelSel.value = next;
        this.applyExposure();
    },

    applyExposure() {
        const factor = Math.pow(2, Number.isFinite(this.exposure) ? this.exposure : 0);
        let channelFilter = '';
        if (this.channelView === 'red') channelFilter = 'url(#bepic-channel-red)';
        else if (this.channelView === 'green') channelFilter = 'url(#bepic-channel-green)';
        else if (this.channelView === 'blue') channelFilter = 'url(#bepic-channel-blue)';

        const exposureFilter = `brightness(${factor.toFixed(3)})`;
        const filter = channelFilter ? `${channelFilter} ${exposureFilter}` : exposureFilter;
        if (this.imgBase) this.imgBase.style.filter = filter;
        if (this.imgCompare) this.imgCompare.style.filter = filter;
        if (this.videoBase) this.videoBase.style.filter = filter;
    },

    // ── Hotkeys ──────────────────────────────────────────────────────────────

    handleKeyDown(e) {
        const target   = e.composedPath()[0];
        const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
        if (isTyping) return;

        if (e.key === 'e' || e.key === 'E') {
            this.isExposureModifierActive = true;
            return;
        }

        if (!this.isHovered) return;

        switch (e.key) {
            case "ArrowLeft":
                e.preventDefault();
                if (e.ctrlKey) this.setFrame(this.getTimelineBounds().min);
                else this.step(-1);
                break;
            case "ArrowRight":
                e.preventDefault();
                if (e.ctrlKey) this.setFrame(this.getTimelineBounds().max);
                else this.step(1);
                break;
            case "ArrowUp":
            case "ArrowDown":
                // navigate history panel items when visible
                if (this.historyPanel && this.historyPanel.style.display !== 'none') {
                    e.preventDefault();
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    if (typeof this.navigateHistory === 'function') this.navigateHistory(delta);
                }
                break;
            case " ":
                e.preventDefault();
                this.isPlaying ? this.stop() : this.play();
                break;
            case "Enter":
                if (e.altKey) { e.preventDefault(); app.queuePrompt(0); }
                break;
            case "f": case "F":
                e.preventDefault(); this.fitView(); break;
            case "c": case "C":
                e.preventDefault(); this.toggleCompare(); break;
            case "r": case "R":
                e.preventDefault();
                this.setChannelView(this.channelView === 'red' ? 'all' : 'red');
                break;
            case "g": case "G":
                e.preventDefault();
                this.setChannelView(this.channelView === 'green' ? 'all' : 'green');
                break;
            case "b": case "B":
                e.preventDefault();
                this.setChannelView(this.channelView === 'blue' ? 'all' : 'blue');
                break;
            case "1": case "2": case "3": case "4": case "5":
            case "6": case "7": case "8": case "9": {
                e.preventDefault();
                const idx  = parseInt(e.key) - 1;
                const tabs = this.getTabOrderForHotkeys();
                if (tabs.length > 1 && idx < tabs.length) this.switchTab(tabs[idx]);
                break;
            }
        }
    },

    handleKeyUp(e) {
        if (e.key === 'e' || e.key === 'E') {
            this.isExposureModifierActive = false;
            this.isExposureDragging = false;
        }
    },

    getTabOrderForHotkeys() {
        const container = this.tabsContainer || this.tabBar;
        if (container) {
            const domOrder = Array.from(container.querySelectorAll('.tab[data-tab]'))
                .map(el => el.dataset.tab)
                .filter(k => !!k && !!this.allTabs[k]);
            if (domOrder.length > 0) return domOrder;
        }

        if (Array.isArray(this.tabOrder) && this.tabOrder.length > 0) {
            const known = this.tabOrder.filter(k => !!this.allTabs[k]);
            if (known.length > 0) return known;
        }

        return Object.keys(this.allTabs);
    },

    // ── Undock / re-dock ─────────────────────────────────────────────────────

    toggleUndock() {
        if (this.popoutWindow && !this.popoutWindow.closed) {
            this.popoutWindow.onbeforeunload = null;
            this.popoutWindow.close();
            this.restoreDock();
        } else {
            this.popoutWindow = window.open("", "bEpicViewer", "width=800,height=600");
            if (!this.popoutWindow) return;

            this.popoutWindow.document.title = "bEpic Viewer";
            this.shadowRoot.querySelectorAll('style').forEach(s => this.popoutWindow.document.head.appendChild(s.cloneNode(true)));
            this.popoutWindow.document.body.appendChild(this.container);
            Object.assign(this.popoutWindow.document.body.style, { margin: "0", overflow: "hidden", backgroundColor: "#222" });

            try {
                const hostFont = window.getComputedStyle(this).fontFamily || 'sans-serif';
                this.popoutWindow.document.body.style.fontFamily = hostFont;
                this.container.style.fontFamily = hostFont;
            } catch (e) { console.warn('bEpicViewer: failed to copy font to popout', e); }

            // Copy CSS custom properties (icon sprites etc.) so mask-image vars work
            try {
                const computed = window.getComputedStyle(this);
                const iconProps = [
                    '--icon-play','--icon-pause','--icon-skip-start','--icon-skip-end','--icon-prev','--icon-next',
                    '--icon-fit','--icon-shape','--icon-rotate-slider','--icon-close','--icon-undock','--icon-layout',
                    '--icon-history','--icon-params','--icon-range','--icon-refresh','--icon-folder','--icon-delete',
                    '--icon-help','--icon-dock-left','--icon-dock-right','--icon-lock','--icon-unlock'
                ];

                iconProps.forEach(p => {
                    const v = computed.getPropertyValue(p);
                    if (v && v.trim() !== '') {
                        // set on popout document root so selectors referencing vars resolve
                        this.popoutWindow.document.documentElement.style.setProperty(p, v);
                        // also set on the container element as a fallback
                        this.container.style.setProperty(p, v);
                    }
                });
            } catch (e) {
                console.warn('bEpicViewer: failed to copy CSS variables to popout', e);
            }

            this.container.style.width  = "100vw";
            this.container.style.height = "100vh";
            this._setIcon(this.undockBtn, 'icon-dock');
            this.undockBtn.title        = "Dock to main window";
            this.style.display          = 'none';

            this.popoutWindow.onbeforeunload = () => this.restoreDock();
            this.popoutWindow.addEventListener('keydown', (e) => this.handleKeyDown(e));
            this.popoutWindow.addEventListener('keyup', (e) => this.handleKeyUp(e));
            this.bindClearButton();
        }
    },

    restoreDock() {
        this.shadowRoot.appendChild(this.container);
        this.popoutWindow               = null;
        this._setIcon(this.undockBtn, 'icon-undock');
        this.undockBtn.title            = "Undock to separate window";
        this.container.style.width      = "";
        this.container.style.height     = "";
        this.container.style.fontFamily = "";
        this.style.display              = 'flex';
        this.bindClearButton();
    },

    // ── Clear-cache button (window-agnostic) ─────────────────────────────────

    bindClearButton() {
        const clearBtn = this.container ? this.container.querySelector('#clear-cache-btn') : null;
        if (!clearBtn) return;
        clearBtn.onclick = null;
        clearBtn.onclick = async () => {
            const dlgWin = clearBtn.ownerDocument?.defaultView || window;
            if (!dlgWin.confirm('Clear bEpic temp files? This will permanently delete viewer cache images.')) return;

            const envApi   = (dlgWin.opener && dlgWin.opener.api)   ? dlgWin.opener.api   : api;
            const envFetch = (dlgWin.opener && dlgWin.opener.fetch) ? dlgWin.opener.fetch.bind(dlgWin.opener) : fetch;
            const url = envApi.apiURL('/bepic/clear_cache');

            try {
                const res = await envFetch(url);
                if (!res.ok) throw new Error('Request failed');
                const js = await res.json();
                dlgWin.alert(`Cleared ${js.deleted || 0} files from bEpic temp cache.`);
                try {
                    this.history        = {};
                    this.previewBackup  = null;
                    this.isViewingHistory = false;
                    const panel = this.historyPanel || this.shadowRoot.getElementById('history-panel');
                    if (panel) panel.style.display = 'none';
                    if (this._syncHistoryToggleState) this._syncHistoryToggleState();
                    if (this.historyStrip) this.historyStrip.innerHTML = '';
                    this.queuePersistViewerState();
                } catch (e) { console.warn('Failed to clear viewer history', e); }
            } catch (e) {
                console.error('clear cache failed', e);
                dlgWin.alert('Failed to clear cache: ' + e.message);
            }
        };
    },

    // ── Tab switch and highlights ─────────────────────────────────────────────

    captureTabViewState(key) {
        if (!key) return;
        if (!this.tabViewState || typeof this.tabViewState !== 'object') this.tabViewState = {};

        const prev = this.tabViewState[key] || {};
        const state = {
            frame: Number.isFinite(this.currentFrame) ? this.currentFrame : (Number.isFinite(prev.frame) ? prev.frame : 0),
            historyIndex: Number.isInteger(this.currentHistoryIndex) && this.currentHistoryKey === key
                ? this.currentHistoryIndex
                : (Number.isInteger(prev.historyIndex) ? prev.historyIndex : null),
            viewingHistory: !!(this.isViewingHistory && this.currentHistoryKey === key && Number.isInteger(this.currentHistoryIndex)),
        };

        this.tabViewState[key] = state;
    },

    getTabViewState(key) {
        if (!key || !this.tabViewState || typeof this.tabViewState !== 'object') return null;
        const s = this.tabViewState[key];
        return (s && typeof s === 'object') ? s : null;
    },

    switchTab(k) {
        const prevTab = this.activeTab;
        if (prevTab && prevTab !== k) this.captureTabViewState(prevTab);

        try {
            if (this.activeTab !== k && this.isViewingHistory && this.previewBackup && this.activeTab && this.allTabs[this.activeTab]) {
                this.allTabs[this.activeTab] = JSON.parse(JSON.stringify(this.previewBackup));
                this.previewBackup     = null;
                this.isViewingHistory  = false;
            }
        } catch (e) {}

        this.activeTab = k;
        this.tabBar.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === k);
        });
        this.updateTabHighlights();

        if (!this.isInputRangeLocked) this.playbackRange = null;
        this.updateRangeOverlay();
        if (this.isInputRangeLocked) this.syncInputRange();

        const imgs = this.allTabs[k];
        const tabState = this.getTabViewState(k);
        let restoredByHistory = false;

        if (tabState && Number.isInteger(tabState.historyIndex)) {
            const stack = this.history[k] || [];
            if (stack.length > 0) {
                const safeIdx = Math.max(0, Math.min(tabState.historyIndex, stack.length - 1));
                this.currentHistoryKey = k;
                this.currentHistoryIndex = safeIdx;

                if (tabState.viewingHistory) {
                    this.historyCompare = null;
                    this.openHistorySnapshot(k, safeIdx);
                    restoredByHistory = true;
                }
            }
        }

        if (imgs && imgs.length > 0) {
            if (!restoredByHistory) {
                this.applyTimelineBounds(imgs.length);
                const bounds = this.getTimelineBounds(imgs.length);
                const preferredFrame = tabState && Number.isFinite(tabState.frame) ? tabState.frame : this.currentFrame;
                const nextFrame = (preferredFrame >= bounds.min && preferredFrame <= bounds.max) ? preferredFrame : bounds.min;
                this.setFrame(nextFrame);
            }
        } else {
            if (this._exitVideoMode) this._exitVideoMode();
            this.imgBase.src = "";
            this.applyTimelineBounds(0);
            this.timeline.value = 0;
            this.container.querySelector('#cur-f').innerText = 0;
        }
        this.captureTabViewState(k);
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
        if (this._bindToolsToActiveTab) this._bindToolsToActiveTab();
        if (this.updateToolOverlay) this.updateToolOverlay();
    },

    updateTabHighlights() {
        if (!this.tabBar) return;
        this.tabBar.querySelectorAll('.tab').forEach(t => {
            if (this.historyCompare) { t.classList.remove('compare'); return; }
            t.classList.toggle('compare', !!(this.isComparing && t.dataset.tab === this.compareTab));
        });
    },

    // ── Compare mode ─────────────────────────────────────────────────────────

    toggleCompare() {
        this.isComparing = !this.isComparing;
        if (this.isComparing) {
            if (!this.compareTab) {
                const candidates = Object.keys(this.allTabs).filter(k => k !== this.activeTab);
                if (candidates.length > 0) this.compareTab = candidates[0];
            }
            this.rotateBtn.style.display   = "block";
            this.imgCompare.style.display  = "block";
            this.sliderMode                = 'vertical';
            this.slider.className          = 'slider-v';
            Object.assign(this.slider.style, { top: '0', bottom: '0', left: '', right: '', width: '2px', height: 'auto', display: 'block' });
            this.viewport.classList.remove('contact-mode');
            if (this.contactContainer) { this.contactContainer.style.transform = ''; this.contactContainer.style.width = ''; this.contactContainer.style.height = ''; }
            this.updateCompareVisuals();
            this.setFrame(this.currentFrame);
        } else {
            this.rotateBtn.style.display          = "none";
            this.imgCompare.style.display         = "none";
            this.slider.style.display             = "none";
            this.imgCompare.style.clipPath        = "none";
            this.viewport.classList.remove('contact-mode');
            this.viewport.style.transform         = '';
            if (this.contactContainer) { this.contactContainer.style.transform = ''; this.contactContainer.style.width = ''; this.contactContainer.style.height = ''; }
            this.resetContactImageSizing();
            if (this.sliderMode === 'contact') { this.sliderMode = 'vertical'; this.slider.className = 'slider-v'; }
            this.updateTransform();
            this.fitView();
        }
        this.updateTabHighlights();
    },

    // ── Slider modes ─────────────────────────────────────────────────────────

    toggleSliderOrientation() { this.cycleSliderMode(); },

    cycleSliderMode() {
        if (this.sliderMode === 'vertical')   this.setSliderMode('horizontal');
        else if (this.sliderMode === 'horizontal') this.setSliderMode('contact');
        else this.setSliderMode('vertical');
    },

    setSliderMode(mode) {
        this.sliderMode = mode;
        if (mode === 'contact') {
            this.slider.style.display         = 'none';
            this.imgCompare.style.display     = 'block';
            this.imgCompare.style.clipPath    = 'none';
            this.resizeContactContainer();
        } else {
            this.slider.style.display = 'block';
            if (this.contactContainer) { this.contactContainer.style.width = ''; this.contactContainer.style.height = ''; }
            this.resetContactImageSizing();
            if (mode === 'vertical') {
                this.slider.className = 'slider-v';
                Object.assign(this.slider.style, { top: '0', bottom: '0', left: '', right: '', width: '2px', height: 'auto' });
            } else {
                this.slider.className = 'slider-h';
                Object.assign(this.slider.style, { left: '0', right: '0', top: '', bottom: '', height: '2px', width: 'auto' });
            }
        }
        this.applyContactClass();
        this.updateCompareVisuals();
        this.updateTransform();
        this.fitView();
    },

    applyContactClass() {
        if (this.sliderMode === 'contact') {
            this.viewport.classList.add('contact-mode');
            this.resizeContactContainer();
        } else {
            this.viewport.classList.remove('contact-mode');
            this.resetContactImageSizing();
        }
    },

    resetContactImageSizing() {
        this.imgBase.style.width = '';
        this.imgBase.style.height = '';
        this.imgCompare.style.width = '';
        this.imgCompare.style.height = '';
    },

    getContactLayout() {
        const baseW = this.imgBase.naturalWidth || 0;
        const baseH = this.imgBase.naturalHeight || 0;
        const compW = this.imgCompare.naturalWidth || 0;
        const compH = this.imgCompare.naturalHeight || 0;

        if (!baseW || !baseH || !compW || !compH) return null;

        const targetH = Math.min(baseH, compH);
        const baseScale = baseH > targetH ? (targetH / baseH) : 1;
        const compScale = compH > targetH ? (targetH / compH) : 1;

        const baseDrawW = Math.max(1, Math.round(baseW * baseScale));
        const baseDrawH = Math.max(1, Math.round(baseH * baseScale));
        const compDrawW = Math.max(1, Math.round(compW * compScale));
        const compDrawH = Math.max(1, Math.round(compH * compScale));

        return {
            baseDrawW,
            baseDrawH,
            compDrawW,
            compDrawH,
            contW: baseDrawW + compDrawW,
            contH: Math.max(baseDrawH, compDrawH),
        };
    },

    resizeContactContainer() {
        if (!this.contactContainer) return;
        const layout = this.getContactLayout();
        if (!layout) {
            this.contactContainer.style.width = '';
            this.contactContainer.style.height = '';
            this.resetContactImageSizing();
            return;
        }

        this.contactContainer.style.width  = layout.contW + 'px';
        this.contactContainer.style.height = layout.contH + 'px';

        this.imgBase.style.width = layout.baseDrawW + 'px';
        this.imgBase.style.height = layout.baseDrawH + 'px';
        this.imgCompare.style.width = layout.compDrawW + 'px';
        this.imgCompare.style.height = layout.compDrawH + 'px';
    },

    // ── Compare slider drag ───────────────────────────────────────────────────

    setupCompareSlider() {
        this.slider.onmousedown = (e) => {
            this.isDraggingSlider = true;
            e.preventDefault();
            e.stopPropagation();
            const win = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                if (!this.isDraggingSlider) return;
                const rect    = this.viewport.getBoundingClientRect();
                const val     = this.sliderMode === "vertical"
                    ? (evt.clientX - rect.left)  / rect.width
                    : (evt.clientY - rect.top)   / rect.height;
                this.sliderPos = Math.max(0, Math.min(100, val * 100));
                this.updateCompareVisuals();
            };
            const onUp = () => {
                this.isDraggingSlider = false;
                win.removeEventListener('mousemove', onMove);
                win.removeEventListener('mouseup',   onUp);
            };
            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    updateCompareVisuals() {
        if (!this.isComparing) return;
        this.updateTabHighlights();
        const viewRect = this.viewport.getBoundingClientRect();
        const imgRect  = this.imgBase.getBoundingClientRect();
        if (this.sliderMode === "contact") {
            this.imgCompare.style.clipPath = "none";
        } else if (this.sliderMode === "vertical") {
            this.slider.style.left        = `${this.sliderPos}%`;
            this.slider.style.top         = "0";
            const sliderScreenX = (this.sliderPos / 100) * viewRect.width;
            const relX          = sliderScreenX - (imgRect.left - viewRect.left);
            this.imgCompare.style.clipPath = `inset(0 0 0 ${(relX / imgRect.width) * 100}%)`;
        } else {
            this.slider.style.top  = `${this.sliderPos}%`;
            this.slider.style.left = "0";
            const sliderScreenY = (this.sliderPos / 100) * viewRect.height;
            const relY          = sliderScreenY - (imgRect.top - viewRect.top);
            this.imgCompare.style.clipPath = `inset(${(relY / imgRect.height) * 100}% 0 0 0)`;
        }
    },

    // ── Transform / zoom ─────────────────────────────────────────────────────

    updateTransform() {
        // Skip no-op updates to reduce style invalidation
        const sig = `${this.panX},${this.panY},${this.zoom},${this.sliderMode}`;
        if (sig === this._lastTransformSig) return;
        this._lastTransformSig = sig;

        const t = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        if (this.sliderMode === 'contact' && this.contactContainer) {
            const contW    = this.contactContainer.offsetWidth;
            const contH    = this.contactContainer.offsetHeight;
            const viewRect = this.viewport.getBoundingClientRect();
            const tx = viewRect.width  / 2 - this.zoom * contW / 2 + this.panX;
            const ty = viewRect.height / 2 - this.zoom * contH / 2 + this.panY;
            this.contactContainer.style.transform = `translate(${tx}px, ${ty}px) scale(${this.zoom})`;
            this.viewport.style.transform  = '';
            this.imgBase.style.transform   = '';
            this.imgCompare.style.transform = '';
            if (this.videoBase) this.videoBase.style.transform = '';
        } else {
            if (this.contactContainer) this.contactContainer.style.transform = '';
            this.viewport.style.transform   = '';
            this.imgBase.style.transform    = t;
            this.imgCompare.style.transform = t;
            // Video shares the image zoom/pan transform so it scrubs, zooms and
            // pans exactly like an image sequence.
            if (this.videoBase) this.videoBase.style.transform = t;
        }
        this.updateImageFrame();
        this.updateCompareVisuals();
        this.updateTabHighlights();
        this.updateToolOverlay && this.updateToolOverlay();
    },

    updateImageFrame() {
        if (!this.imgFrame || !this.imgBase || !this.viewport) return;
        if (this.sliderMode === 'contact' || !this.imgBase.naturalWidth || !this.imgBase.naturalHeight) {
            this.imgFrame.style.display = 'none';
            return;
        }

        const elW = this.imgBase.clientWidth;
        const elH = this.imgBase.clientHeight;
        if (!elW || !elH) {
            this.imgFrame.style.display = 'none';
            return;
        }

        const fitScale = Math.min(elW / this.imgBase.naturalWidth, elH / this.imgBase.naturalHeight);
        const drawW = Math.max(1, this.imgBase.naturalWidth * fitScale);
        const drawH = Math.max(1, this.imgBase.naturalHeight * fitScale);
        const left = (elW - drawW) * 0.5;
        const top = (elH - drawH) * 0.5;

        this.imgFrame.style.left = `${left}px`;
        this.imgFrame.style.top = `${top}px`;
        this.imgFrame.style.width = `${drawW}px`;
        this.imgFrame.style.height = `${drawH}px`;
        this.imgFrame.style.transform = this.imgBase.style.transform || '';
        this.imgFrame.style.display = 'block';
    },

    // ── Zoom & pan ────────────────────────────────────────────────────────────

    // Zoom while keeping the image point under (clientX, clientY) fixed, so the
    // cursor position acts as the zoom anchor instead of the image centre.
    _zoomAt(newZoom, clientX, clientY) {
        newZoom = Math.max(0.05, Math.min(newZoom, 20.0));
        // Contact mode uses a different transform origin; fall back to plain zoom.
        if (this.sliderMode === 'contact') { this.zoom = newZoom; this.updateTransform(); return; }
        const rect = this.viewport.getBoundingClientRect();
        if (!rect.width || !rect.height) { this.zoom = newZoom; this.updateTransform(); return; }
        const sx = clientX - rect.left, sy = clientY - rect.top;
        const cx = rect.width / 2, cy = rect.height / 2;
        const ratio = newZoom / (this.zoom || 1);
        // screen(p) = C + zoom*(p-C) + pan  →  solve pan so the cursor point stays put
        this.panX = sx - cx - ratio * (sx - cx - this.panX);
        this.panY = sy - cy - ratio * (sy - cy - this.panY);
        this.zoom = newZoom;
        this.updateTransform();
    },

    // UI that lives inside the viewport and owns its own mouse events — pan/zoom
    // must keep its hands off, or it steals the drag from sliders and buttons.
    _overViewportChrome(e) {
        const t = e.target;
        return !!(t && t.closest && t.closest(
            '#exposure-control, .bepic-toolbar, .bepic-tool-panel'));
    },

    setupZoomAndPan() {
        this.viewport.oncontextmenu = (e) => e.preventDefault();
        this.viewport.onwheel       = (e) => {
            if (this._overViewportChrome(e)) return;
            e.preventDefault();
            this._zoomAt(this.zoom + (e.deltaY > 0 ? -0.1 : 0.1), e.clientX, e.clientY);
        };

        this.viewport.onmousedown = (e) => {
            if (e.target.id === 'compare-slider') return;
            if (this._overViewportChrome(e)) return;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            if (this.isExposureModifierActive) {
                this.isExposureDragging = true;
                e.preventDefault();
            } else if (e.button === 2) {
                this.isZooming = true;
                // Anchor the scrub-zoom at the point where the drag started.
                this._zoomAnchorX = e.clientX;
                this._zoomAnchorY = e.clientY;
                e.preventDefault();
            } else if (e.button === 1) {
                // Middle-button always pans (works even when a tool has taken
                // over left-drag).
                this.isPanning = true;
                e.preventDefault();
            } else if (e.button === 0) {
                this.isPanning = true;
                e.preventDefault();
            }

            const win = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                if (this.isExposureDragging) {
                    this.setExposure(this.exposure + (evt.clientX - this.lastMouseX) * 0.02);
                }
                if (this.isZooming) {
                    const nz = this.zoom + (evt.clientX - this.lastMouseX) * 0.005 * this.zoom;
                    this._zoomAt(nz, this._zoomAnchorX, this._zoomAnchorY);
                }
                if (this.isPanning) {
                    this.panX += evt.clientX - this.lastMouseX;
                    this.panY += evt.clientY - this.lastMouseY;
                    this.updateTransform();
                }
                this.lastMouseX = evt.clientX;
                this.lastMouseY = evt.clientY;
            };
            const onUp = (evt) => {
                if (evt.button === 2) this.isZooming = false;
                if (evt.button === 0 || evt.button === 1) this.isPanning = false;
                this.isExposureDragging = false;
                if (!this.isZooming && !this.isPanning && !this.isExposureDragging) {
                    win.removeEventListener('mousemove', onMove);
                    win.removeEventListener('mouseup',   onUp);
                }
            };
            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    // ── Panel resize handles ─────────────────────────────────────────────────

    setupResizing() {
        let activeR = null;
        this.shadowRoot.querySelectorAll('.resizer').forEach(r => {
            r.onmousedown = (e) => { activeR = e.target.className; e.preventDefault(); };
        });
        window.addEventListener('mousemove', (e) => {
            if (!activeR) return;
            const rect = this.getBoundingClientRect();
            if (activeR.includes('r-right')  || activeR.includes('r-br') || activeR.includes('r-tr')) { const w = e.clientX - rect.left;   if (w > 200) this.style.width  = `${w}px`; }
            if (activeR.includes('r-bottom') || activeR.includes('r-br') || activeR.includes('r-bl')) { const h = e.clientY - rect.top;    if (h > 200) this.style.height = `${h}px`; }
            if (activeR.includes('r-left')   || activeR.includes('r-bl') || activeR.includes('r-tl')) { const delta = rect.left - e.clientX; const nw = rect.width  + delta; if (nw > 200) { this.style.left = `${e.clientX}px`; this.style.width  = `${nw}px`; } }
            if (activeR.includes('r-top')    || activeR.includes('r-tr') || activeR.includes('r-tl')) { const delta = rect.top  - e.clientY; const nh = rect.height + delta; if (nh > 200) { this.style.top  = `${e.clientY}px`; this.style.height = `${nh}px`; } }
        });
        window.addEventListener('mouseup', () => { activeR = null; });
    },

    // ── History panel resize ─────────────────────────────────────────────────

    setupHistoryResizing() {
        if (!this.historyResizer || !this.historyPanel) return;
        this.historyResizer.onmousedown = (e) => {
            e.preventDefault();
            const startX     = e.clientX;
            const startWidth = this.historyPanel.getBoundingClientRect().width;
            const win        = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                try {
                    const panelRect = this.historyPanel.getBoundingClientRect();
                    const newWidth  = this.historyPanel.classList.contains('right')
                        ? Math.round(Math.max(60, Math.min(600, panelRect.right - evt.clientX)))
                        : Math.round(Math.max(60, Math.min(600, evt.clientX - panelRect.left)));
                    this.historyPanel.style.width = `${newWidth}px`;
                } catch (e) { /* ignore */ }
            };
            const onUp = () => { win.removeEventListener('mousemove', onMove); win.removeEventListener('mouseup', onUp); };
            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    // ── Panel dragging ────────────────────────────────────────────────────────

    setupPanelDragging() {
        const startDrag = (e) => {
            if (e.target.closest('.tab'))                return;
            if (e.target.closest('button, select, input')) return;
            const rect = this.getBoundingClientRect();
            if (e.clientY - rect.top > 40)               return;

            this.isDraggingPanel = true;
            this.dragStartX      = e.clientX - rect.left;
            this.dragStartY      = e.clientY - rect.top;

            this.style.bottom = "auto"; this.style.right  = "auto";
            this.style.width  = `${rect.width}px`;
            this.style.height = `${rect.height}px`;
            this.style.left   = `${rect.left}px`;
            this.style.top    = `${rect.top}px`;
            e.preventDefault();
        };

        this.tabBar.onmousedown       = startDrag;
        this.container.onmousedown    = startDrag;

        window.addEventListener('mousemove', (e) => {
            if (!this.isDraggingPanel) return;
            this.style.left = `${e.clientX - this.dragStartX}px`;
            this.style.top  = `${e.clientY - this.dragStartY}px`;
        });
        window.addEventListener('mouseup', () => { this.isDraggingPanel = false; });
    },
};
