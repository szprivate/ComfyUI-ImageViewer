// bEpicViewer_fullscreen.js
// Full screen: the viewport - the canvas and everything drawn on it (the
// picture or film, a compare, the drawing tools' overlays, a Paint, Motion or
// 3D tab) - fills the screen, and the panels, tab bar and transport stay
// behind. The playback keys still answer (the viewer is hovered the whole
// time), and Esc, the button again or Shift+F come back.
//
// It is the browser's own Fullscreen API on `this.viewport`, asked for in the
// document the viewport lives in now - the ComfyUI tab, or the popout while
// undocked - so the same code serves both. The viewport is inside the panel's
// shadow root while docked; `getRootNode().fullscreenElement` is how a shadow
// root says which of its own elements is full screen (the document only names
// the host).
//
// Menus and dialogs that are made outside the viewport (the transport's, the
// Edit panel's) are not on screen while it is full screen; that is the point
// of it. What changes size with it - the 3D view, Paint, the tools' overlays -
// already watches the viewport with a ResizeObserver; a picture's zoom is
// relative to its fit, so it scales with the box and keeps the user's zoom.

const ICON_ENTER = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const ICON_EXIT  = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

// How long the exit button stays up after the pointer last moved.
const EXIT_BTN_IDLE_MS = 2000;

export const FullscreenMixin = {

    /** Make the transport button and the exit button over the canvas, and listen for the change. */
    _initFullscreen() {
        const sr = this.shadowRoot;
        if (!this.viewport) return;

        // Made here, not in the markup, like the page-dock button: a cached copy of
        // the markup from before it existed would otherwise simply not have it.
        let btn = sr.getElementById('fullscreen-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'fullscreen-btn';
            btn.className = 'sprite-icon';
            const after = this.overlaysBtn || sr.getElementById('layout-btn');
            if (after && after.parentNode) after.parentNode.insertBefore(btn, after.nextSibling);
            else if (this.refreshBtn && this.refreshBtn.parentNode) this.refreshBtn.parentNode.insertBefore(btn, this.refreshBtn);
        }
        btn.onclick = () => this.toggleFullscreen();
        this.fullscreenBtn = btn;

        // Over the canvas, so it is there to click while the transport is not.
        let exit = this.viewport.querySelector('.fs-exit-btn');
        if (!exit) {
            exit = document.createElement('button');
            exit.className = 'fs-exit-btn';
            exit.innerHTML = ICON_EXIT;
            exit.title = 'Exit full screen (Esc)';
            this.viewport.appendChild(exit);
        }
        // Not a pan or a tool stroke on the canvas behind it.
        exit.onpointerdown = (e) => e.stopPropagation();
        exit.onmousedown   = (e) => e.stopPropagation();
        exit.onclick = (e) => { e.stopPropagation(); this.toggleFullscreen(false); };
        this._fsExitBtn = exit;

        // The event is fired at the element itself (and bubbles to its
        // document), so listening on the viewport follows it into the popout.
        this.viewport.addEventListener('fullscreenchange', () => this._onFullscreenChange());
        this.viewport.addEventListener('mousemove', () => this._fsPointerMoved());
        this._syncFullscreenButton();
    },

    /** Whether the canvas is full screen right now. */
    isFullscreen() {
        if (!this.viewport) return false;
        try {
            const root = this.viewport.getRootNode();
            return !!root && root.fullscreenElement === this.viewport;
        } catch (e) { return false; }
    },

    /** Into full screen and out again; `force` true / false asks for one of them. */
    async toggleFullscreen(force) {
        if (!this.viewport) return;
        const on   = this.isFullscreen();
        const want = (force === undefined) ? !on : !!force;
        if (want === on) return;
        const doc = this.viewport.ownerDocument || document;
        try {
            if (want) {
                if (!this.viewport.requestFullscreen) throw new Error('Fullscreen API not available');
                await this.viewport.requestFullscreen({ navigationUI: 'hide' });
            } else if (doc.fullscreenElement) {
                await doc.exitFullscreen();
            }
        } catch (e) {
            console.warn('bEpicViewer: full screen refused', e);
        }
    },

    _onFullscreenChange() {
        const on = this.isFullscreen();
        this._syncFullscreenButton();
        if (on) this._fsPointerMoved();
        else {
            clearTimeout(this._fsIdleTimer);
            this.viewport.classList.remove('fs-pointer');
        }
        // A picture's zoom is relative to its fit in the viewport (1 = fitted), so
        // it scales with the box by itself and the user's zoom and pan are kept;
        // only the side-by-side compare is sized in pixels, and is fitted again.
        // The 3D view, Paint and the tools' overlays follow the viewport with
        // ResizeObservers of their own.
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        win.requestAnimationFrame(() => {
            if (this._modelMode || this._paintOn) return;
            try {
                if (this.isComparing && this.sliderMode === 'contact') this.fitView();
                else this.updateTransform();
            } catch (e) {}
        });
    },

    _syncFullscreenButton() {
        const on = this.isFullscreen();
        if (this.fullscreenBtn) {
            this.fullscreenBtn.innerHTML = on ? ICON_EXIT : ICON_ENTER;
            this.fullscreenBtn.title = on ? 'Exit full screen (Esc)' : 'Full screen (Shift+F)';
            this.fullscreenBtn.classList.toggle('active', on);
        }
    },

    /** The exit button shows while the pointer moves, and goes after it rests. */
    _fsPointerMoved() {
        if (!this.isFullscreen()) return;
        this.viewport.classList.add('fs-pointer');
        clearTimeout(this._fsIdleTimer);
        this._fsIdleTimer = setTimeout(() => this.viewport.classList.remove('fs-pointer'), EXIT_BTN_IDLE_MS);
    },
};
