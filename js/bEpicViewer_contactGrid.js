// bEpicViewer_contactGrid.js
// Contact Sheet for three or more history snapshots: every selected item in a
// grid, videos playing in step off the viewer's own transport.
//
// How it is entered. Ctrl+click two or more thumbnails in the History strip,
// then turn compare on (C, or Contact Sheet from the rotate button). The first
// two of the selection are pinned as the ordinary history compare pair (A and
// B), so the wipe modes work exactly as before; with three or more the
// Contact Sheet becomes this grid instead of the two-up strip.
//
// Order is the SELECTION order: the item you clicked first is A, the next one
// B, and so on (a Ctrl+Shift range adds its items in strip order). The
// selection is a Set of the snapshots themselves, so a new render landing in
// the strip moves nothing.
//
// Sync. One clock drives every cell: the longest clip in the grid plays
// natively and is the master; every other clip follows it frame for frame
// (the same frame INDEX in each cell), corrected on every animation frame by
// nudging its playbackRate, or by a seek when it is too far off. A clip that is
// shorter than the master HOLDS its last frame until the master loops, so the
// whole sheet restarts together. Play/pause, scrub and frame-step go through
// the viewer's normal play()/stop()/setFrame(), which hand over to the grid
// while it is up (the same pattern the Edit tab and motion tabs use).
//
// The layout math (gridLayout) is pure and exported for node --test
// (tests/test_contact_grid.mjs); the mixin below touches the DOM.

/** Most cells drawn at once; the hint says "showing 16 of N" past it. */
export const CONTACT_GRID_CAP = 16;
const DEFAULT_ASPECT = 16 / 9;

/** Largest w x h of aspect `a` (w/h) inside a box, centred in it. */
export function fitRect(a, x, y, w, h) {
    const asp = a > 0 && Number.isFinite(a) ? a : DEFAULT_ASPECT;
    let fw = w, fh = w / asp;
    if (fh > h) { fh = h; fw = h * asp; }
    return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh };
}

/**
 * Columns and rows for `n` cells in a `W` x `H` view, chosen to show the most
 * picture: every column count is tried and the one whose cells, each
 * letterboxed to its own item's aspect ratio, cover the largest total area
 * wins (fewer empty slots breaks a tie). An incomplete last row is centred.
 *
 * `aspects[i]` is item i's width/height (unknown: 16:9).
 * Returns { cols, rows, cellW, cellH, cells: [{ x, y, w, h, fit: {x,y,w,h} }] }.
 */
export function gridLayout(n, W, H, aspects = [], opts = {}) {
    const gap = opts.gap != null ? opts.gap : 6;
    const pad = opts.pad != null ? opts.pad : 8;
    const count = Math.max(0, Math.floor(n) || 0);
    const empty = { cols: 0, rows: 0, cellW: 0, cellH: 0, cells: [] };
    if (!count || !(W > 0) || !(H > 0)) return empty;
    const aspect = (i) => {
        const a = Number(aspects[i]);
        return a > 0 && Number.isFinite(a) ? a : DEFAULT_ASPECT;
    };
    let best = null;
    for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        // A column count that leaves a whole row empty is the same grid as a
        // smaller one, only worse.
        if (cols > 1 && Math.ceil(count / (cols - 1)) === rows) continue;
        const cw = (W - 2 * pad - gap * (cols - 1)) / cols;
        const ch = (H - 2 * pad - gap * (rows - 1)) / rows;
        if (!(cw > 0) || !(ch > 0)) continue;
        let area = 0;
        for (let i = 0; i < count; i++) {
            const f = fitRect(aspect(i), 0, 0, cw, ch);
            area += f.w * f.h;
        }
        const waste = cols * rows - count;
        if (!best || area > best.area + 1e-6 || (Math.abs(area - best.area) <= 1e-6 && waste < best.waste)) {
            best = { cols, rows, cw, ch, area, waste };
        }
    }
    if (!best) return empty;
    const { cols, rows, cw, ch } = best;
    const cells = [];
    const usedH = rows * ch + (rows - 1) * gap;
    const top = (H - usedH) / 2;
    for (let i = 0; i < count; i++) {
        const row = Math.floor(i / cols), col = i % cols;
        const inRow = row === rows - 1 ? count - row * cols : cols;
        const rowW = inRow * cw + (inRow - 1) * gap;
        const left = (W - rowW) / 2;
        const x = left + col * (cw + gap), y = top + row * (ch + gap);
        cells.push({ x, y, w: cw, h: ch, fit: fitRect(aspect(i), x, y, cw, ch) });
    }
    return { cols, rows, cellW: cw, cellH: ch, cells };
}

/** The frame a cell shows for the sheet's frame: the same index, held on its last. */
export function cellFrame(frame, cellFrames) {
    const f = Math.max(0, Math.floor(Number(frame) || 0));
    return cellFrames > 0 ? Math.min(f, cellFrames - 1) : f;
}

/** Playback rate that takes a follower from `drift` seconds off back onto the master. */
export function followRate(baseRate, drift) {
    const k = Math.max(-0.25, Math.min(0.25, -drift * 2));
    return Math.max(0.0625, Math.min(16, baseRate * (1 + k)));
}

const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv)$/i;
const isVideo = (o) => !!(o && (o.kind === "video" || VIDEO_RE.test(o.path || o.filename || "")));
const baseName = (o) => String((o && (o.name || o.filename || o.path)) || "").split(/[\\/]/).pop();
/** A follower further off than this is sought rather than nudged (seconds). */
const SEEK_DRIFT = 0.25;

export const ContactGridMixin = {

    // ── Which snapshots, in which order ─────────────────────────────────────

    /** The active tab's Ctrl-selection in click order: [{ snap, idx }]. */
    _gridSelectionOrdered(key = this.activeTab) {
        if (!this._historySelSet || this._historySelKey !== key) return [];
        const stack = (this.history || {})[key] || [];
        const out = [];
        for (const snap of this._historySelSet) {
            const idx = stack.indexOf(snap);
            if (idx >= 0) out.push({ snap, idx });
        }
        return out;
    },

    /** The multi compare's items that still exist, in order: [{ snap, idx }]. */
    _multiCompareItems() {
        const mc = this._multiCompare;
        if (!mc) return [];
        const stack = (this.history || {})[mc.key] || [];
        const out = [];
        for (const snap of mc.snaps) {
            const idx = stack.indexOf(snap);
            if (idx >= 0) out.push({ snap, idx });
        }
        return out;
    },

    /** How many items the multi compare holds (0 when there is none). */
    multiCompareCount() {
        const hc = this.historyCompare;
        if (!this._multiCompare || !hc || hc.key !== this._multiCompare.key) return 0;
        return this._multiCompareItems().length;
    },

    /**
     * Turn a Ctrl-selection of `min`+ snapshots into a compare: the first two are
     * the A/B pair every mode uses, the whole list feeds the Contact Sheet grid.
     * Leaves the slider mode alone; the caller picks it.
     */
    _tryEnterMultiCompare(min = 2) {
        const key = this.activeTab;
        const sel = this._gridSelectionOrdered(key);
        if (sel.length < min) return false;
        this._multiCompare = { key, snaps: sel.map((s) => s.snap) };
        this.historyCompare = { key, baseIdx: sel[0].idx, otherIdx: sel[1].idx };
        this.enterHistoryCompare();
        return true;
    },

    /** Re-pin A/B to the first two items after the list changed. */
    _multiComparePinPair() {
        const items = this._multiCompareItems();
        const hc = this.historyCompare;
        if (items.length < 2 || !hc) return;
        if (hc.baseIdx === items[0].idx && hc.otherIdx === items[1].idx) return;
        hc.baseIdx = items[0].idx;
        hc.otherIdx = items[1].idx;
        if (!this._gridOn) {
            this.setFrame(this.currentFrame);
            this.updateTransform();
            this._syncCompareLayout();
        }
        this._historyPanelSig = null;
        this.renderHistoryPanel();
    },

    /** Ctrl+click while a multi compare is up: it follows the selection. */
    _multiCompareSelectionChanged() {
        const mc = this._multiCompare;
        if (!mc || !this.isComparing || this.activeTab !== mc.key) return;
        const sel = this._gridSelectionOrdered(mc.key);
        if (sel.length < 2) return;                 // a plain click, about to leave compare
        const snaps = sel.map((s) => s.snap);
        if (snaps.length === mc.snaps.length && snaps.every((s, i) => s === mc.snaps[i])) return;
        mc.snaps = snaps;
        this._multiComparePinPair();
        this._gridSync();
    },

    /** Make item `pos` of the list A: it moves to the front, the rest keep their order. */
    multiCompareMakeA(pos) {
        const mc = this._multiCompare;
        if (!mc || pos <= 0 || pos >= mc.snaps.length) return;
        const [snap] = mc.snaps.splice(pos, 1);
        mc.snaps.unshift(snap);
        this._multiComparePinPair();
        this._gridSync(true);
    },

    /** Leave the compare and open item `pos` on its own. */
    multiCompareOpen(pos) {
        const items = this._multiCompareItems();
        const it = items[pos];
        if (!it) return;
        const key = this._multiCompare.key;
        this.exitHistoryCompare();
        if (this.isComparing) this.toggleCompare();
        this.startHistorySelection && this.startHistorySelection(key, it.idx);
        this.openHistorySnapshot(key, it.idx);
    },

    // ── Showing it ──────────────────────────────────────────────────────────

    _gridWanted() {
        return !!(this.isComparing && this.sliderMode === "contact" && this._multiCompare
            && this.activeTab === this._multiCompare.key && this.multiCompareCount() >= 3);
    },

    /** Bring the grid, the hint and the cells in line with the state. Cheap when nothing changed. */
    _gridSync(force = false) {
        const want = this._gridWanted();
        if (want && !this._gridOn) this._gridShow();
        else if (!want && this._gridOn) this._gridHide();
        else if (want && this._gridOn) this._gridReconcile(force);
        this._gridHint();
    },

    _gridEnsureDom() {
        const vp = this.viewport;
        if (!vp) return null;
        if (this._gridEl && this._gridEl.isConnected && this._gridEl.parentNode === vp) return this._gridEl;
        const doc = vp.ownerDocument || document;
        const el = doc.createElement("div");
        el.className = "contact-grid";
        // Pan/zoom keeps its hands off (_overViewportChrome); the cells take the clicks.
        el.addEventListener("mousedown", (e) => { if (e.button === 0) e.stopPropagation(); });
        el.addEventListener("wheel", (e) => { e.stopPropagation(); e.preventDefault(); }, { passive: false });
        vp.appendChild(el);
        this._gridEl = el;
        return el;
    },

    _gridHintEl() {
        const vp = this.viewport;
        if (!vp) return null;
        if (this._gridHintNode && this._gridHintNode.parentNode === vp) return this._gridHintNode;
        const el = (vp.ownerDocument || document).createElement("div");
        el.className = "contact-grid-hint";
        vp.appendChild(el);
        this._gridHintNode = el;
        return el;
    },

    /** "Comparing 1 and 2 of N" in a wipe; "showing 16 of N" on a capped sheet. */
    _gridHint() {
        const n = this.isComparing && this._multiCompare && this.activeTab === this._multiCompare.key
            ? this.multiCompareCount() : 0;
        let text = "";
        if (n >= 3 && this.sliderMode !== "contact") text = `Comparing 1 and 2 of ${n}; Contact Sheet shows all`;
        else if (n > CONTACT_GRID_CAP && this._gridOn) text = `Showing ${CONTACT_GRID_CAP} of ${n}`;
        if (!text && !this._gridHintNode) return;
        const el = this._gridHintEl();
        if (!el) return;
        if (el.textContent !== text) el.textContent = text;
        el.style.display = text ? "block" : "none";
    },

    _gridShow() {
        const wasPlaying = !!this.isPlaying;
        if (wasPlaying) this.stop();
        if (this._hideCompareVideo) this._hideCompareVideo();
        if (this._videoMode && this.videoBase) { try { this.videoBase.pause(); } catch (e) {} }
        this._gridOn = true;
        this._grid = { cells: [], sig: "", layoutSig: "", playing: false, raf: null };
        this.viewport.classList.add("grid-mode");
        const el = this._gridEnsureDom();
        if (el) el.style.display = "block";
        this._gridReconcile(true);
        this.applyTimelineBounds();
        this._gridSetFrame(this.currentFrame || 0);
        if (wasPlaying) this.play();
    },

    _gridHide() {
        const wasPlaying = !!this.isPlaying;
        if (wasPlaying) this.stop();
        this._gridStopClock();
        const g = this._grid;
        if (g) for (const c of g.cells) this._gridReleaseCell(c);
        if (this._gridEl) { this._gridEl.innerHTML = ""; this._gridEl.style.display = "none"; }
        this._grid = null;
        this._gridOn = false;
        if (this.viewport) this.viewport.classList.remove("grid-mode");
        // Back to the base/compare layers: put them on the frame the sheet was on.
        this.applyTimelineBounds();
        this.setFrame(this.currentFrame || 0);
        if (wasPlaying && this.isComparing) this.play();
    },

    _gridReleaseCell(c) {
        if (c && c.video) {
            try { c.video.pause(); } catch (e) {}
            c.video.removeAttribute("src");
            try { c.video.load(); } catch (e) {}
        }
    },

    /** Build or reuse one cell per item (a cell is keyed by its snapshot), then lay them out. */
    _gridReconcile(force = false) {
        const g = this._grid, el = this._gridEl;
        if (!g || !el) return;
        const items = this._multiCompareItems();
        const shown = items.slice(0, CONTACT_GRID_CAP);
        const tags = this._agentTags || {};
        const sig = shown.map((it) => {
            const fr = it.snap[0] || {};
            return `${it.idx}:${fr.path || fr.filename || ""}:${tags[fr.path] || ""}`;
        }).join("|") + `|${items.length}`;
        if (force || sig !== g.sig) {
            g.sig = sig;
            const old = new Map(g.cells.map((c) => [c.snap, c]));
            const cells = [];
            shown.forEach((it, pos) => {
                const c = old.get(it.snap) || this._gridMakeCell(it.snap);
                old.delete(it.snap);
                c.idx = it.idx;
                c.pos = pos;
                this._gridLabel(c, pos, items.length);
                cells.push(c);
            });
            for (const c of old.values()) { this._gridReleaseCell(c); c.el.remove(); }
            for (const c of cells) el.appendChild(c.el);     // re-append = re-order
            g.cells = cells;
            g.layoutSig = "";
            this.applyTimelineBounds();
            this._gridApplyFilter();
        }
        this._gridLayout();
    },

    _gridMakeCell(snap) {
        const doc = (this._gridEl && this._gridEl.ownerDocument) || document;
        const fr = snap[0] || {};
        const el = doc.createElement("div");
        el.className = "cg-cell";
        const c = { snap, el, fr, video: null, img: null, frames: 0, fps: 0, aspect: 0, held: false };
        if (isVideo(fr)) {
            const v = doc.createElement("video");
            v.className = "cg-media";
            v.muted = true;
            v.playsInline = true;
            v.loop = false;
            v.preload = "auto";
            c.video = v;
            c.fps = fr.fps > 0 ? fr.fps : (this.fps || 24);
            c.frames = fr.frames > 0 ? fr.frames : 0;
            v.addEventListener("loadedmetadata", () => {
                if (!(c.frames > 0) && v.duration) c.frames = Math.max(1, Math.round(v.duration * c.fps));
                if (v.videoWidth && v.videoHeight) c.aspect = v.videoWidth / v.videoHeight;
                if (!this._gridOn) return;
                this.applyTimelineBounds();
                if (this._grid) this._grid.layoutSig = "";
                this._gridLayout();
                if (!this.isPlaying) this._gridSeekCell(c, this.currentFrame || 0);
            });
            v.addEventListener("resize", () => {
                if (v.videoWidth && v.videoHeight) c.aspect = v.videoWidth / v.videoHeight;
                if (this._grid) this._grid.layoutSig = "";
            });
            v.src = this.buildImgUrl(fr);
            el.appendChild(v);
        } else {
            const img = doc.createElement("img");
            img.className = "cg-media";
            img.decoding = "async";
            img.draggable = false;
            img.addEventListener("load", () => {
                if (img.naturalWidth && img.naturalHeight) c.aspect = img.naturalWidth / img.naturalHeight;
                if (this._grid) this._grid.layoutSig = "";
                this._gridLayout();
            });
            c.img = img;
            c.frames = snap.length > 1 ? snap.length : 0;     // a sequence steps with the sheet
            this._gridSetImg(c, 0);
            el.appendChild(img);
        }
        const label = doc.createElement("div");
        label.className = "cg-label";
        el.appendChild(label);
        c.label = label;
        // A click makes the cell A - after a beat, so the cell is still under the
        // pointer when the second click of a double-click (open it alone) lands.
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            const win = this._viewerWindow ? this._viewerWindow() : window;
            if (this._gridClickTimer) win.clearTimeout(this._gridClickTimer);
            this._gridClickTimer = null;
            if (e.detail > 1) return;                   // the second click of a double-click
            this._gridClickTimer = win.setTimeout(() => { this._gridClickTimer = null; this.multiCompareMakeA(c.pos); }, 260);
        });
        el.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            const win = this._viewerWindow ? this._viewerWindow() : window;
            if (this._gridClickTimer) { win.clearTimeout(this._gridClickTimer); this._gridClickTimer = null; }
            this.multiCompareOpen(c.pos);
        });
        return c;
    },

    _gridSetImg(c, frame) {
        const fr = c.snap[cellFrame(frame, c.snap.length)] || c.fr;
        const url = this.buildImgUrl(fr);
        if (c.imgUrl === url) return;
        c.imgUrl = url;
        c.img.src = url;
        const m = /[?&]ev=(-?[\d.]+)/.exec(url || "");
        c.ev = m ? Number(m[1]) : 0;
    },

    _gridLabel(c, pos, total) {
        const fr = c.fr;
        const tag = (this._agentTags || {})[fr.path] || "";
        const parts = [];
        const mark = pos === 0 ? "A" : pos === 1 ? "B" : String(pos + 1);
        const name = baseName(fr);
        const label = fr.label && fr.label !== name ? fr.label : "";
        c.label.innerHTML = "";
        const doc = c.label.ownerDocument || document;
        const add = (cls, text) => {
            const s = doc.createElement("span");
            s.className = cls;
            s.textContent = text;
            c.label.appendChild(s);
        };
        add(pos < 2 ? "cg-mark cg-ab" : "cg-mark", mark);
        add("cg-name", name || `History ${c.idx + 1}`);
        if (label) add("cg-ver", label);
        if (tag) add("cg-tag", `#${tag}`);
        parts.push(`${mark}: ${name}`);
        if (label) parts.push(label);
        if (tag) parts.push(`#${tag}`);
        c.el.title = `${parts.join("  ")}\nHistory ${c.idx + 1} of the strip, ${pos + 1} of ${total} here\n`
            + "Click: make it A   Double-click: open it on its own";
        c.el.classList.toggle("cg-a", pos === 0);
        c.el.classList.toggle("cg-b", pos === 1);
    },

    _gridLayout() {
        const g = this._grid, el = this._gridEl;
        if (!g || !el) return;
        const W = el.clientWidth, H = el.clientHeight;
        const sig = `${W}x${H}:` + g.cells.map((c) => (c.aspect || 0).toFixed(3)).join(",");
        if (sig === g.layoutSig) return;
        g.layoutSig = sig;
        const lay = gridLayout(g.cells.length, W, H, g.cells.map((c) => c.aspect));
        g.cols = lay.cols; g.rows = lay.rows;
        lay.cells.forEach((r, i) => {
            const c = g.cells[i];
            Object.assign(c.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        });
    },

    /** Exposure and channel isolation, as display filters on every cell. */
    _gridApplyFilter() {
        const g = this._grid;
        if (!g) return;
        const exposure = Number.isFinite(this.exposure) ? this.exposure : 0;
        const ch = this.channelView;
        const channel = ch === "red" ? "url(#bepic-channel-red)" : ch === "green" ? "url(#bepic-channel-green)"
            : ch === "blue" ? "url(#bepic-channel-blue)" : "";
        for (const c of g.cells) {
            const m = c.video || c.img;
            if (!m) continue;
            const b = `brightness(${Math.pow(2, exposure - (c.ev || 0)).toFixed(3)})`;
            m.style.filter = channel ? `${channel} ${b}` : b;
        }
    },

    // ── The transport ───────────────────────────────────────────────────────

    /** The sheet's length: its longest clip or sequence (frames). */
    _gridFrameCount() {
        const g = this._grid;
        if (!g) return 1;
        let n = 1;
        for (const c of g.cells) if (c.frames > n) n = c.frames;
        return n;
    },

    /** The fps the sheet runs at: the master clip's own. */
    _gridFps() {
        const m = this._gridMaster();
        return (m && m.fps) || this.fps || 24;
    },

    /** The longest clip; it plays natively and every other one follows it. */
    _gridMaster() {
        const g = this._grid;
        if (!g) return null;
        let best = null;
        for (const c of g.cells) if (c.video && (!best || c.frames > best.frames)) best = c;
        return best;
    },

    _gridSeekCell(c, frame) {
        if (c.video) {
            const f = cellFrame(frame, c.frames);
            c.held = c.frames > 0 && Math.floor(frame) >= c.frames - 1;
            const t = (f + 0.5) / (c.fps || 24);
            // A held clip asked for its last frame again stays put: re-seeking a
            // paused clip to where it already is can land it on its very end.
            if (c.video.paused && Math.abs((c.video.currentTime || 0) - t) < 1e-3) return;
            try { c.video.currentTime = t; } catch (e) {}
        } else if (c.img && c.snap.length > 1) {
            this._gridSetImg(c, frame);
        }
    },

    /** setFrame while the grid is up: every cell to the same frame index. */
    _gridSetFrame(idx) {
        const bounds = this.getTimelineBounds();
        const f = Math.max(bounds.min, Math.min(Math.floor(Number(idx) || 0), bounds.max));
        this.currentFrame = f;
        const g = this._grid;
        if (g) for (const c of g.cells) {
            if (c.video && !this.isPlaying) { try { c.video.pause(); } catch (e) {} }
            this._gridSeekCell(c, f);
        }
        this._gridShowFrame(f);
    },

    _gridShowFrame(f) {
        if (this.timeline) this.timeline.value = f;
        const cur = this.container && this.container.querySelector("#cur-f");
        if (cur) cur.innerText = f;
    },

    _gridPlay() {
        const g = this._grid;
        if (!g) return;
        this.isPlaying = true;
        this._setIcon && this._setIcon(this.playBtn, "icon-pause");
        const bounds = this.getTimelineBounds();
        if (this.currentFrame >= bounds.max) this._gridSetFrame(bounds.min);
        const fps = this._gridFps();
        for (const c of g.cells) {
            if (!c.video) continue;
            this._gridSeekCell(c, this.currentFrame);
            if (c.held) continue;
            try { c.video.playbackRate = fps / (c.fps || fps); } catch (e) {}
            const p = c.video.play();
            if (p && p.catch) p.catch(() => {});
        }
        g.clock = { t0: this._gridNow(), f0: this.currentFrame };
        this._gridStartClock();
    },

    _gridStop() {
        const g = this._grid;
        this._gridStopClock();
        if (!g) return;
        for (const c of g.cells) if (c.video) { try { c.video.pause(); } catch (e) {} }
    },

    _gridNow() {
        const win = this._viewerWindow ? this._viewerWindow() : window;
        return ((win && win.performance) || performance).now();
    },

    _gridStartClock() {
        this._gridStopClock();
        const win = this._viewerWindow ? this._viewerWindow() : window;
        const g = this._grid;
        if (!g || !win || !win.requestAnimationFrame) return;
        g.rafWin = win;
        const tick = () => {
            if (!this._grid || !this.isPlaying || !this._gridOn) { if (this._grid) this._grid.raf = null; return; }
            try { this._gridTick(); } catch (e) { /* a bad frame must not end playback */ }
            if (this._grid && this._grid.raf != null) this._grid.raf = win.requestAnimationFrame(tick);
        };
        g.raf = win.requestAnimationFrame(tick);
    },

    _gridStopClock() {
        const g = this._grid;
        if (!g || g.raf == null) return;
        try { (g.rafWin || window).cancelAnimationFrame(g.raf); } catch (e) {}
        g.raf = null;
    },

    /** One animation frame of playback: read the master, line every follower up on it. */
    _gridTick() {
        const g = this._grid;
        const bounds = this.getTimelineBounds();
        const master = this._gridMaster();
        const fps = this._gridFps();
        let frameF;
        if (master && master.video.readyState >= 2) {
            frameF = master.video.currentTime * master.fps - 0.5;
            if (master.video.ended) frameF = bounds.max + 1;
        } else {
            frameF = g.clock.f0 + (this._gridNow() - g.clock.t0) / 1000 * fps;
        }
        if (frameF >= bounds.max + 0.5 || frameF < bounds.min - 1) {
            if (this.loopMode === "once") { this.stop(); this._gridSetFrame(bounds.max); return; }
            // Loop (ping-pong loops forward, as a <video> base does): everything back to the start together.
            for (const c of g.cells) if (c.video) { try { c.video.pause(); } catch (e) {} }
            this._gridSetFrame(bounds.min);
            this._gridPlay();
            return;
        }
        const f = Math.max(bounds.min, Math.floor(frameF + 1e-6));
        if (f !== this.currentFrame) {
            this.currentFrame = f;
            this._gridShowFrame(f);
            for (const c of g.cells) if (c.img && c.snap.length > 1) this._gridSetImg(c, f);
        }
        for (const c of g.cells) {
            if (!c.video || c === master) continue;
            const v = c.video;
            const last = c.frames > 0 ? c.frames - 1 : Infinity;
            if (frameF >= last) {
                // Shorter than the master: hold its last frame until the sheet loops.
                if (!c.held) { c.held = true; try { v.pause(); v.currentTime = (last + 0.5) / c.fps; } catch (e) {} }
                continue;
            }
            const want = (frameF + 0.5) / c.fps;
            const base = fps / c.fps;
            if (c.held || v.paused) {
                c.held = false;
                try { v.currentTime = want; v.playbackRate = base; } catch (e) {}
                const p = v.play(); if (p && p.catch) p.catch(() => {});
                continue;
            }
            const drift = (v.currentTime || 0) - want;
            if (Math.abs(drift) > SEEK_DRIFT) { try { v.currentTime = want; } catch (e) {} continue; }
            // Rate changes are not free for the media pipeline: only in 2 % steps.
            const r = Math.round(followRate(base, drift) / base * 50) / 50 * base;
            if (Math.abs(v.playbackRate - r) > 1e-3) { try { v.playbackRate = r; } catch (e) {} }
        }
    },

    /** The panel moved between windows (pop out / back): a moved <video> is paused, the frame callback is stale. */
    _gridAfterMove() {
        if (!this._gridOn || !this._grid) return;
        this._grid.layoutSig = "";
        this._gridLayout();
        if (this.isPlaying) this._gridPlay();
        else this._gridSetFrame(this.currentFrame || 0);
    },

    /** Timing of the cells against each other, for tests and the report: seconds and frames. */
    gridSyncStats() {
        const g = this._grid;
        if (!g) return null;
        const vids = g.cells.filter((c) => c.video && !c.held);
        const frames = vids.map((c) => c.video.currentTime * c.fps);
        const spread = frames.length ? Math.max(...frames) - Math.min(...frames) : 0;
        return { videos: vids.length, frames, spread, playing: !!this.isPlaying,
                 dropped: g.cells.filter((c) => c.video).map((c) => {
                     const q = c.video.getVideoPlaybackQuality ? c.video.getVideoPlaybackQuality() : null;
                     return q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null;
                 }) };
    },

    /** What the grid shows, for viewerState and the tests. */
    gridInfo() {
        const g = this._grid;
        if (!this._gridOn || !g) return null;
        return { items: this.multiCompareCount(), shown: g.cells.length, cols: g.cols || 0, rows: g.rows || 0,
                 indices: g.cells.map((c) => c.idx) };
    },
};
