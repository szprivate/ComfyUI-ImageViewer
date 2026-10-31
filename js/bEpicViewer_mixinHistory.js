// bEpicViewer_mixinHistory.js
// History panel: thumbnails, snapshots, folder loading, tab management.
//
// Three things a thumbnail click can mean, kept apart by modifier:
//   plain        — open that snapshot in the viewport (again to go back)
//   Shift        — pin it against the open one as a two-snapshot compare
//   Ctrl / Cmd   — add it to the multi-selection (+Shift for a range), which
//                  Shift+Delete and the drag-to-graph handler then act on
// Shift keeps compare because that is the older and more valuable gesture; the
// selection is the one that had to find another modifier.
import { api } from "../../scripts/api.js";
import { setPref, PREF } from "./bEpicViewer_settings.js";

// Snapshots kept per tab, unless the user sets another number at the foot of
// the history panel. With clip caching on, this is also how many videos can be
// held in RAM by history alone, so falling off the end has to release them.
export const HISTORY_LIMIT_DEFAULT = 40;
export const HISTORY_LIMIT_MAX = 500;

export function clampHistoryLimit(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, HISTORY_LIMIT_MAX) : HISTORY_LIMIT_DEFAULT;
}

// Collapse the burst of failures a rebuilt strip produces into one probe.
const PRUNE_DEBOUNCE_MS = 300;
// Gap before re-asking about a path the server just called unreachable. A
// snapshot can be pushed a beat before the file it names is fully on disk, and
// deleting on that race would throw away a perfectly good entry.
const PRUNE_CONFIRM_MS  = 1500;

// Thumbnails asked for at once. A browser keeps six connections to a server,
// and a tile whose render sits on a network share can take a second or more to
// come back - six of those and the picture a history switch asks for waits for
// a free connection. Four leaves room for it (and for the viewer's other calls).
const THUMB_LOADS_MAX = 4;
// How far outside the strip's visible part a tile already loads.
const THUMB_NEAR_MARGIN = '300px';

export const HistoryMixin = {

    // ── History stack ────────────────────────────────────────────────────────

    // Prepend a snapshot, skipping an exact repeat of the newest one. Returns
    // whether anything was added. Every history push goes through here so the cap
    // is applied — and paid for — in one place.
    pushHistorySnapshot(key, snapshot) {
        const stack = this.history[key] || (this.history[key] = []);
        const json  = JSON.stringify(snapshot);
        if (stack.length > 0 && JSON.stringify(stack[0]) === json) return false;
        stack.unshift(JSON.parse(json));
        this.trimHistory(key);
        return true;
    },

    // Drop snapshots past the cap.
    trimHistory(key) {
        const stack = this.history[key];
        if (!Array.isArray(stack)) return;
        const limit = clampHistoryLimit(this.historyLimit);
        while (stack.length > limit) stack.pop();
    },

    // A new cap from the panel footer. Lowering it drops the oldest snapshots
    // of every tab straight away, rather than on each tab's next push — through
    // removeHistoryItems, which also leaves a snapshot on screen, a compare or
    // a selection that pointed at one of them.
    setHistoryLimit(value) {
        // A cleared or nonsense entry puts the old number back — falling to
        // the default instead could quietly cut history short.
        if (!(Math.round(Number(value)) >= 1)) {
            this._syncHistoryLimitInput();
            return;
        }
        this.historyLimit = clampHistoryLimit(value);
        this._syncHistoryLimitInput();
        setPref(PREF.historyLimit, this.historyLimit);
        for (const key of Object.keys(this.history || {})) {
            const stack = this.history[key];
            if (!Array.isArray(stack) || stack.length <= this.historyLimit) continue;
            const past = [];
            for (let i = this.historyLimit; i < stack.length; i++) past.push(i);
            this.removeHistoryItems(key, past);
        }
        this.queuePersistViewerState?.();
    },

    _syncHistoryLimitInput() {
        const input = this.historyLimitInput;
        if (input) input.value = String(clampHistoryLimit(this.historyLimit));
    },

    // ── Pruning snapshots whose files are gone ───────────────────────────────
    //
    // History outlives the files it points at: a temp dir that got cleaned, an
    // output root belonging to another machine. Those entries used to sit in the
    // strip as broken thumbnails that failed again on every redraw — and the
    // server logged a line for each one. They're now dropped silently instead.
    //
    // Nothing is removed on a guess. A file counts as gone only when the server
    // says so twice, so a request that fails outright (server restarting, offline)
    // or a snapshot that landed a beat ahead of its file leaves history intact.

    _probeSeen() {
        if (!this._probeGood) this._probeGood = new Set();
        if (!this._probeDead) this._probeDead = new Set();
        return { good: this._probeGood, dead: this._probeDead };
    },

    // Forget what was verified, so the next pass re-checks everything. Called when
    // a load actually fails: a path that probed healthy earlier clearly isn't now.
    resetHistoryProbeCache() {
        this._probeGood = new Set();
        this._probeDead = new Set();
    },

    // A media element failed to load. Re-verify rather than trust the cache, then
    // let the normal pass decide whether anything should actually go.
    //
    // `frame`, when the caller knows it, is what failed: only its path is asked
    // about again. Forgetting EVERYTHING on any failure re-checked the whole
    // history - hundreds of paths, seconds of round trips to a network share -
    // and a tile that fails for good (a video's poster in a cleaned temp folder)
    // fails again every time the strip is drawn.
    noteMediaLoadFailed(frame) {
        const entry = frame ? this._probeEntry(frame) : null;
        if (entry) {
            const { good, dead } = this._probeSeen();
            good.delete(entry.path);
            dead.delete(entry.path);
        } else {
            this.resetHistoryProbeCache();
        }
        this.scheduleHistoryPrune();
    },

    scheduleHistoryPrune() {
        if (this._historyPruneTimer) return;
        this._historyPruneTimer = setTimeout(() => {
            this._historyPruneTimer = null;
            this.pruneMissingHistory();
        }, PRUNE_DEBOUNCE_MS);
    },

    // Walk every snapshot in history, handing each to `visit`.
    _eachSnapshot(visit) {
        for (const key of Object.keys(this.history || {})) {
            const stack = this.history[key];
            if (!Array.isArray(stack)) continue;
            for (const snapshot of stack) {
                if (Array.isArray(snapshot) && snapshot.length > 0) visit(snapshot, key);
            }
        }
    },

    // Frames without a `path` (a workflow's own SaveImage output, served by
    // ComfyUI's /view) and blob-backed dropped files aren't ours to judge, so
    // they're never probed and never pruned.
    _probeEntry(fr) {
        if (!fr || fr.url || !fr.path) return null;
        return { path: fr.path, external: !!fr.external };
    },

    _dedupeEntries(entries) {
        const { good, dead } = this._probeSeen();
        const seen = new Set();
        const out  = [];
        for (const e of entries) {
            if (!e || seen.has(e.path) || good.has(e.path) || dead.has(e.path)) continue;
            seen.add(e.path);
            out.push(e);
        }
        return out;
    },

    // The opening pass asks about the FIRST frame of each snapshot only. Probing
    // every frame would stat a whole sequence per snapshot — tens of thousands of
    // files across a full history, which is slow enough to notice on network
    // storage. Files disappear a directory at a time, so the first frame is a
    // reliable suspect; the frames behind it are only checked once it fails.
    _historyPathsToProbe() {
        const out = [];
        this._eachSnapshot((snapshot) => {
            const e = this._probeEntry(snapshot[0]);
            if (e) out.push(e);
        });
        return this._dedupeEntries(out);
    },

    // Every frame of the snapshots whose lead frame came back unreachable. This is
    // what makes "the whole snapshot is gone" the actual test rather than a guess
    // from one file.
    _pathsBehind(leadPaths) {
        const out = [];
        this._eachSnapshot((snapshot) => {
            const lead = this._probeEntry(snapshot[0]);
            if (!lead || !leadPaths.has(lead.path)) return;
            for (const fr of snapshot) {
                const e = this._probeEntry(fr);
                if (e) out.push(e);
            }
        });
        // Suspect paths are deliberately re-asked here, so skip the seen-cache.
        const seen = new Set();
        return out.filter(e => (seen.has(e.path) ? false : (seen.add(e.path), true)));
    },

    // Ask the server which of these it can't serve. Returns a Set of paths, or
    // null when the question couldn't be put — which is not the same answer as
    // "all fine", and callers must not treat it as one.
    async _probePaths(entries) {
        if (!entries || entries.length === 0) return new Set();
        try {
            const res = await fetch(api.apiURL('/bepic/probe_paths'), {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ paths: entries }),
            });
            if (!res.ok) return null;      // older server without the route
            const data = await res.json();
            const list = Array.isArray(data && data.unreachable) ? data.unreachable : [];
            return new Set(list.map(e => (e && typeof e === 'object') ? e.path : e).filter(Boolean));
        } catch (e) {
            return null;
        }
    },

    async pruneMissingHistory() {
        if (this._historyPruneInFlight) return;
        const entries = this._historyPathsToProbe();
        if (entries.length === 0) return;
        this._historyPruneInFlight = true;
        try {
            const { good, dead } = this._probeSeen();

            const missing = await this._probePaths(entries);
            if (!missing) return;
            for (const e of entries) if (!missing.has(e.path)) good.add(e.path);
            if (missing.size === 0) return;

            await new Promise(r => setTimeout(r, PRUNE_CONFIRM_MS));
            const suspects  = this._pathsBehind(missing);
            const confirmed = await this._probePaths(suspects);
            if (!confirmed || confirmed.size === 0) return;
            for (const e of suspects) {
                if (confirmed.has(e.path)) dead.add(e.path);
                else good.add(e.path);
            }

            this._removeHistoryEntriesFor(confirmed);
        } finally {
            this._historyPruneInFlight = false;
        }
    },

    _removeHistoryEntriesFor(missing) {
        let removed = 0;
        for (const key of Object.keys(this.history || {})) {
            const stack = this.history[key];
            if (!Array.isArray(stack)) continue;
            // Back to front: removeHistoryItem re-indexes everything after `idx`,
            // and it is what keeps the selection, the pinned compare pair and the
            // RAM cache consistent with the shortened stack.
            for (let idx = stack.length - 1; idx >= 0; idx--) {
                if (!this._snapshotIsDead(stack[idx], missing)) continue;
                this.removeHistoryItem(key, idx);
                removed++;
            }
        }
        if (removed > 0) {
            // Pruning happens behind the user's back, so a selection that
            // survived it would point at whatever slid into those slots.
            this.clearHistorySelection();
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        return removed;
    },

    // A snapshot goes only when there is nothing left behind it. A sequence that
    // lost some of its frames still opens, so it stays.
    _snapshotIsDead(snapshot, missing) {
        if (!Array.isArray(snapshot) || snapshot.length === 0) return false;
        for (const fr of snapshot) {
            if (!fr || fr.url || !fr.path) return false;
            if (!missing.has(fr.path)) return false;
        }
        return true;
    },

    // ── Per-node image update + history push ────────────────────────────────

    updateNodeImages(nodeId, images) {
        const processed = images.map(img => ({
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
        }));
        let didPrepend = false;
        try {
            didPrepend = this.pushHistorySnapshot(nodeId, processed);
        } catch (e) { console.warn('bEpicViewer history push failed', e); }

        if (didPrepend) this.onHistoryPrepended(nodeId);

        this.allTabs[nodeId] = processed;

        if (didPrepend) {
            this.currentHistoryKey = nodeId;
            this.currentHistoryIndex = 0;
            if (this.activeTab === nodeId) {
                this.isViewingHistory = false;
                this.previewBackup = null;
                this.historyCompare = null;
                this._historyCompareEntered = false;
                this.currentFrame = this.getTimelineBounds(processed.length).min;
            }
        }

        if (this.activeTab === nodeId) {
            if (didPrepend) this.refreshView();
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        this.queuePersistViewerState();
    },

    // ── Multi-selection ──────────────────────────────────────────────────────
    //
    // Ctrl/Cmd-click builds it, Ctrl+Shift-click extends it as a range. Plain
    // Shift-click is deliberately left alone: that is the two-snapshot compare
    // pin, and it is the more valuable gesture of the two.
    //
    // It lives per tab -- the strip only ever shows one tab's stack, and a
    // selection spanning tabs could not be shown, dragged or deleted as a unit.
    // Transient by design: not persisted, and dropped whenever the stack it
    // indexes into shifts underneath it.

    // The selection holds the snapshots themselves (the stack's own array for
    // each frame), never their positions or file paths: two renders of the same
    // file are two items, and a new render shifting the strip moves nothing.

    _historySel() {
        if (!this._historySelSet) this._historySelSet = new Set();
        return this._historySelSet;
    },

    isHistoryItemSelected(key, idx) {
        const snap = (this.history[key] || [])[idx];
        return this._historySelKey === key && !!snap && this._historySel().has(snap);
    },

    /** The selected indices for a tab, ascending. Empty when it isn't the one. */
    historySelectionIndices(key = this.activeTab) {
        if (this._historySelKey !== key) return [];
        const stack = this.history[key] || [];
        const set = this._historySel();
        const out = [];
        stack.forEach((snap, i) => { if (set.has(snap)) out.push(i); });
        return out;
    },

    /** `[{ imgObj, snapshot }]` for the selection, in strip order. */
    selectedHistorySnapshots(key = this.activeTab) {
        const stack = this.history[key] || [];
        return this.historySelectionIndices(key)
            .map((i) => ({ imgObj: stack[i] && stack[i][0], snapshot: stack[i] }))
            .filter((entry) => entry.imgObj);
    },

    clearHistorySelection() {
        if (!this._historySelKey && this._historySel().size === 0) return;
        this._historySelKey = null;
        this._historySelAnchor = null;
        this._historySel().clear();
        this._paintHistorySelection();
    },

    /** A plain click: this item alone is the selection, and the anchor for what
     *  follows (Ctrl+click adds to it, Ctrl+Shift+click ranges from it). */
    startHistorySelection(key, idx) {
        const snap = (this.history[key] || [])[idx];
        this._historySelKey = key;
        this._historySel().clear();
        this._historySelAnchor = null;
        if (snap) {
            this._historySel().add(snap);
            this._historySelAnchor = snap;
        }
        this._paintHistorySelection();
    },

    toggleHistorySelection(key, idx) {
        const snap = (this.history[key] || [])[idx];
        if (!snap) return;
        if (this._historySelKey !== key) {
            this._historySelKey = key;
            this._historySel().clear();
        }
        const set = this._historySel();
        if (set.has(snap)) set.delete(snap);
        else set.add(snap);
        this._historySelAnchor = set.has(snap) ? snap : null;
        this._paintHistorySelection();
    },

    extendHistorySelection(key, idx) {
        const stack = this.history[key] || [];
        const from = this._historySelKey === key && this._historySelAnchor
            ? stack.indexOf(this._historySelAnchor) : -1;
        if (from < 0) {
            this.toggleHistorySelection(key, idx);
            return;
        }
        const set = this._historySel();
        const [lo, hi] = from < idx ? [from, idx] : [idx, from];
        for (let i = lo; i <= hi; i++) if (stack[i]) set.add(stack[i]);
        this._paintHistorySelection();
    },

    // Toggling classes rather than re-rendering: a rebuild drops and re-decodes
    // every thumbnail, which is far too much for a click that changed nothing
    // but which items are highlighted. renderHistoryPanel applies the same
    // classes from state, so a rebuild for other reasons keeps them.
    // A lone selected item is just the open one (it has its own border), so the
    // highlight only shows once there are two or more.
    _paintHistorySelection() {
        if (!this.historyStrip) return;
        const picked = this.historySelectionIndices(this.activeTab);
        const selected = new Set(picked.length > 1 ? picked : []);
        for (const thumb of this.historyStrip.children) {
            const idx = Number(thumb.dataset ? thumb.dataset.idx : NaN);
            if (Number.isInteger(idx)) thumb.classList.toggle('multi', selected.has(idx));
        }
        // A multi-item compare follows the selection (ContactGridMixin).
        if (this._multiCompareSelectionChanged) this._multiCompareSelectionChanged();
    },

    isHistorySelectionPinned(key) {
        if (this.historyCompare && this.historyCompare.key === key) return true;
        if (this.isViewingHistory && this.currentHistoryKey === key) return true;
        if (this.isComparing && (this.activeTab === key || this.compareTab === key)) return true;
        return false;
    },

    onHistoryPrepended(key) {
        const stack = this.history[key] || [];

        if (this.currentHistoryKey === key && Number.isInteger(this.currentHistoryIndex)) {
            this.currentHistoryIndex = Math.min(this.currentHistoryIndex + 1, Math.max(0, stack.length - 1));
        }

        // The selection holds the snapshots themselves, so it needs no shifting.

        if (this.historyCompare && this.historyCompare.key === key) {
            this.historyCompare.baseIdx = Math.min(this.historyCompare.baseIdx + 1, Math.max(0, stack.length - 1));
            this.historyCompare.otherIdx = Math.min(this.historyCompare.otherIdx + 1, Math.max(0, stack.length - 1));
        }
    },

    // ── History compare helpers ──────────────────────────────────────────────

    // Pin two snapshots of one tab against each other. Both layers are fed from
    // `historyCompare` by _baseFrames / _compareFrames, so this only has to put
    // the viewer into compare mode and let the normal setFrame path load, scale
    // and clip them — the same code that drives a two-tab compare, video
    // snapshots included.
    enterHistoryCompare() {
        if (!this.historyCompare) return;
        // Only the first entry records what to restore. Re-pinning the second
        // snapshot calls straight back in here, and without this guard it would
        // overwrite the saved state with the compare mode we just switched on —
        // leaving compare stuck on after exiting.
        if (!this._historyCompareEntered) {
            this._historyCompareEntered = true;
            this._savedComparing  = this.isComparing;
            this._savedCompareTab = this.compareTab;
        }
        // The compare layer belongs to the snapshot now, not to a tab.
        this.compareTab = null;

        if (!this.isComparing) {
            this.toggleCompare();          // ends in setFrame + updateTransform
        } else {
            // Zoom/pan don't change when only the pinned pair does, so
            // updateTransform would skip its no-op signature — the compare layer's
            // own scale and clip have to be re-derived directly.
            this.setFrame(this.currentFrame);
            this.updateTransform();
            this._syncCompareLayout();
        }
        this.updateTabHighlights();
        this.renderHistoryPanel();
    },

    exitHistoryCompare() {
        if (!this.historyCompare) return;
        this.historyCompare = null;
        this._historyCompareEntered = false;
        this._multiCompare = null;          // the Contact Sheet grid's list (ContactGridMixin)
        if (this._gridSync) this._gridSync();
        this.compareTab = this._savedComparing ? this._savedCompareTab : null;
        if (!this._savedComparing && this.isComparing) {
            this.toggleCompare();
        } else {
            // Rebuild both layers from the live tab now that the snapshots are
            // no longer the source.
            this.refreshView();
            this.updateTransform();
        }
        this.updateTabHighlights();
        this.renderHistoryPanel();
    },

    // ── Thumbnail loading ────────────────────────────────────────────────────
    //
    // What loading="lazy" did - only tiles at or near the visible part of the
    // strip load - plus a cap on how many are asked for at once (THUMB_LOADS_MAX).
    // The strip itself is the observer's root, so this also works with the
    // viewer popped out into its own window.

    _thumbLoader() {
        const strip = this.historyStrip;
        const win = (strip && strip.ownerDocument && strip.ownerDocument.defaultView) || null;
        if (!strip || !win || typeof win.IntersectionObserver !== 'function') return null;
        let L = this._thumbLoad;
        if (L && L.strip === strip && L.win === win) return L;
        // First use, or the strip moved to another window: pick up what was waiting.
        const waiting = L ? [...L.watched] : [];
        if (L && L.io) L.io.disconnect();
        L = this._thumbLoad = { strip, win, near: new Set(), watched: new Set(), inflight: new Set(), io: null };
        L.io = new win.IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) L.near.add(e.target);
                else L.near.delete(e.target);
            }
            this._pumpThumbs();
        }, { root: strip, rootMargin: THUMB_NEAR_MARGIN });
        for (const img of waiting) { L.watched.add(img); L.io.observe(img); }
        return L;
    },

    // Point a strip tile at its thumbnail - now, or once it is near the visible
    // part of the strip and a load slot is free.
    _loadThumb(imgEl, url) {
        if (!url) return;
        const L = /^(data:|blob:)/.test(url) ? null : this._thumbLoader();
        if (!L) { imgEl.src = url; return; }
        imgEl._bepicThumbUrl = url;
        L.watched.add(imgEl);
        L.io.observe(imgEl);
    },

    _pumpThumbs() {
        const L = this._thumbLoad;
        if (!L) return;
        // A tile dropped by a rebuild no longer holds a slot (nor waits for one).
        for (const img of L.inflight) if (!img.isConnected) L.inflight.delete(img);
        for (const img of L.watched) {
            if (!img.isConnected) { L.near.delete(img); L.watched.delete(img); L.io.unobserve(img); }
        }
        for (const img of L.near) {
            if (L.inflight.size >= THUMB_LOADS_MAX) break;
            L.near.delete(img);
            L.watched.delete(img);
            L.io.unobserve(img);
            const url = img._bepicThumbUrl;
            img._bepicThumbUrl = null;
            if (!url || !img.isConnected) continue;
            L.inflight.add(img);
            const done = () => {
                img.removeEventListener('load', done);
                img.removeEventListener('error', done);
                L.inflight.delete(img);
                this._pumpThumbs();
            };
            img.addEventListener('load', done);
            img.addEventListener('error', done);
            // It is near the view already: no second, browser-side wait.
            img.loading = 'eager';
            img.src = url;
        }
    },

    // ── Render thumbnail strip ───────────────────────────────────────────────

    // The open item's highlight, set on the tiles already in the strip - what
    // renderHistoryPanel would draw for it, without making the tiles again.
    _paintHistoryCurrent(key) {
        if (!this.historyStrip) return;
        for (const thumb of this.historyStrip.children) {
            if (!thumb.classList || !thumb.classList.contains('history-thumb')) continue;
            const idx = Number(thumb.dataset ? thumb.dataset.idx : NaN);
            const isSelected = this.currentHistoryKey === key && this.currentHistoryIndex === idx;
            if (thumb.classList.contains('selected') === isSelected) continue;
            thumb.classList.toggle('selected', isSelected);
            thumb.style.border = isSelected ? '2px solid #f60' : '';
        }
        this._paintHistorySelection();
    },

    renderHistoryPanel() {
        if (!this.historyStrip) return;
        const key   = this.activeTab;
        const stack = this.history[key] || [];

        // Normalise selection pointer
        if (stack.length > 0 && (this.currentHistoryKey !== key || this.currentHistoryIndex == null || this.currentHistoryIndex < 0 || this.currentHistoryIndex >= stack.length)) {
            this.currentHistoryKey   = key;
            this.currentHistoryIndex = 0;
        }

        // --- fast-path: skip full DOM rebuild if nothing changed ---
        const layoutSig = JSON.stringify({ key, len: stack.length, cmp: this.historyCompare,
                                           tags: this.historyTagSig ? this.historyTagSig(stack) : "" });
        const newSig = `${layoutSig}|${this.currentHistoryIndex}`;
        if (newSig === this._historyPanelSig) return;
        // Only the open item moved (a click in the strip, the arrow keys): move
        // its highlight instead of rebuilding the strip. A rebuild makes every
        // tile anew, and every new tile asks for its thumbnail again - on a
        // history switch, that was a strip's worth of requests and decodes
        // queued in front of the picture the switch was waiting for.
        // A caller that wants a real rebuild clears _historyPanelSig.
        if (this._historyPanelSig && this._historyPanelLayoutSig === layoutSig) {
            this._historyPanelSig = newSig;
            this._paintHistoryCurrent(key);
            return;
        }
        this._historyPanelSig = newSig;
        this._historyPanelLayoutSig = layoutSig;

        const frag = document.createDocumentFragment();
        // The tag filter in the footer (HistoryTagsMixin).
        if (this._syncHistoryTagFilter) this._syncHistoryTagFilter();

        // Stage headings (AgentYMixin): a heading wherever the group changes.
        const groupRun = {};
        stack.forEach((snapshot, idx) => {
            // Hidden by the tag filter; indices stay the stack's own.
            if (this.historyTagVisible && !this.historyTagVisible(snapshot)) return;
            const imgObj    = (snapshot && snapshot.length > 0) ? snapshot[0] : null;
            const thumb     = document.createElement('div');
            thumb.className = 'history-thumb';

            const imgEl = document.createElement('img');
            if (imgObj) {
                // An image snapshot has no separate poster, so this <img> points at
                // the full-resolution render — and a decoded bitmap stays resident
                // for as long as the element is attached. Twenty of those per tab,
                // one more with every render, was the memory that kept climbing.
                // Lazy means only the thumbnails actually scrolled into view pay
                // for a decode; the rest cost nothing until you look at them.
                imgEl.loading  = 'lazy';
                imgEl.decoding = 'async';
                // A thumbnail is only a hint that something is wrong — a video's
                // poster is a separate temp file, so it can be gone while the clip
                // itself is fine. The prune pass checks the real media before
                // anything is removed.
                imgEl.onerror = () => this.noteMediaLoadFailed(imgObj);
                try { this._loadThumb(imgEl, this.thumbUrl(imgObj)); } catch (e) { /* ignore */ }
            }
            thumb.appendChild(imgEl);
            const tagDot = this.historyTagDot ? this.historyTagDot(snapshot) : null;
            if (tagDot) thumb.appendChild(tagDot);
            const caption = this.historyThumbCaption ? this.historyThumbCaption(document, snapshot) : null;
            if (caption) thumb.appendChild(caption);
            const agentTag = this.historyAgentTagBadge ? this.historyAgentTagBadge(document, snapshot) : null;
            if (agentTag) thumb.appendChild(agentTag);
            thumb.dataset.idx = String(idx);
            const what = imgObj && imgObj.label ? ` - ${imgObj.label}` : '';
            thumb.title = `History ${idx + 1}${what}\n` +
                          `Click, then Ctrl+click to add to the selection, Ctrl+Shift+click for a range\n` +
                          `Shift+click to compare against the open snapshot\n` +
                          `C with several Ctrl-selected: compare them (3+: a Contact Sheet of all)\n` +
                          `Right-click to tag it with a colour`;
            // Drag source: drop onto the ComfyUI graph to make a loader node. The
            // whole snapshot is passed so multi-image sequences map to a sequence
            // loader (see _makeHistoryThumbDraggable / _sequenceDirForSnapshot);
            // key and index let a drag pick up the whole selection at once.
            if (imgObj && this._makeHistoryThumbDraggable) {
                this._makeHistoryThumbDraggable(thumb, imgObj, snapshot, key, idx);
            }

            const isSelected = (this.currentHistoryKey === key && this.currentHistoryIndex === idx);
            if (isSelected) {
                thumb.classList.add('selected');
                thumb.style.border = '2px solid #f60';
            }

            if (this.historyCompare && this.historyCompare.key === key) {
                if (idx === this.historyCompare.baseIdx)  thumb.classList.add('base');
                if (idx === this.historyCompare.otherIdx) thumb.classList.add('compare');
            }

            if (this.isHistoryItemSelected(key, idx) && this.historySelectionIndices(key).length > 1) thumb.classList.add('multi');

            // Don't preventDefault here — that would block the native drag start
            // used to drop thumbnails onto the graph. stopPropagation still keeps
            // the mousedown from reaching any parent panel handler.
            thumb.onmousedown  = ev => ev.stopPropagation();
            thumb.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); this.showThumbContextMenu(ev, imgObj, key, idx); };
            thumb.onclick = (ev) => {
                ev.stopPropagation();

                // Ctrl/Cmd owns multi-selection so that plain Shift stays with
                // compare. Neither changes what the viewport is showing.
                if (ev.ctrlKey || ev.metaKey) {
                    if (ev.shiftKey) this.extendHistorySelection(key, idx);
                    else             this.toggleHistorySelection(key, idx);
                    return;
                }

                // Any other click is about the view, but the item it opens is
                // also where a selection starts: Ctrl+click then adds to it.
                this.startHistorySelection(key, idx);

                if (ev.shiftKey && this.isViewingHistory && this.currentHistoryKey === key) {
                    if (!this.historyCompare) {
                        this.historyCompare = { key, baseIdx: this.currentHistoryIndex, otherIdx: idx };
                        this.enterHistoryCompare();
                    } else if (this.historyCompare.key === key && (idx === this.historyCompare.baseIdx || idx === this.historyCompare.otherIdx)) {
                        this.exitHistoryCompare();
                    } else {
                        this.historyCompare.otherIdx = idx;
                        this.enterHistoryCompare();
                    }
                    return;
                }

                // Unpin first so toggleCompare acts on tab state rather than on
                // the snapshot compare we are leaving (exitHistoryCompare already
                // turns compare off when it wasn't on beforehand).
                if (this.historyCompare) this.exitHistoryCompare();
                if (this.isComparing) this.toggleCompare();

                if (this.isViewingHistory && this.currentHistoryKey === key && this.currentHistoryIndex === idx) {
                    this.restoreHistoryView();
                } else {
                    this.historyCompare      = null;
                    this.openHistorySnapshot(key, idx);
                    this.currentHistoryKey   = key;
                    this.currentHistoryIndex = idx;
                }
            };

                const heading = this.historyGroupHeader ? this.historyGroupHeader(document, snapshot, groupRun) : null;
                if (heading) frag.appendChild(heading);
                frag.appendChild(thumb);
        });

        // Replace strip contents in one operation
        this.historyStrip.innerHTML = '';
        this.historyStrip.appendChild(frag);
        if (stack.length && !this.historyStrip.childElementCount) {
            const none = document.createElement('div');
            none.className = 'history-tag-empty';
            none.textContent = 'Nothing tagged like that here';
            this.historyStrip.appendChild(none);
        }

        // Only reached when the signature changed, so this rides on real rebuilds
        // — a restore from localStorage, a new output, a tab switch — rather than
        // on every call. Paths already verified are skipped, so a settled session
        // sends nothing.
        this.scheduleHistoryPrune();

        let totalHistory = 0;
        Object.values(this.history).forEach(arr => { totalHistory += arr?.length || 0; });
        const canClear = key ? stack.length > 0 : totalHistory > 0;
        if (this.historyClearBtn) this.historyClearBtn.disabled = !canClear;
        // With a tag filter on, Clear clears what it shows (HistoryTagsMixin).
        if (this._syncHistoryClearTitle) this._syncHistoryClearTitle();
    },

    openHistorySnapshot(key, index) {
        if (!this.history[key] || !this.history[key][index]) return;
        if (!this.previewBackup) this.previewBackup = this.allTabs[key] ? JSON.parse(JSON.stringify(this.allTabs[key])) : null;
        this.allTabs[key]        = JSON.parse(JSON.stringify(this.history[key][index]));
        this.isViewingHistory    = true;
        this.currentHistoryKey   = key;
        this.currentHistoryIndex = index;
        if (this.activeTab !== key) this.switchTab(key);
        else this.refreshView();
        if (typeof this.captureTabViewState === 'function') this.captureTabViewState(key);
        // The strip's signature knows the open index, so this only moves the
        // highlight - unless something else about the strip changed as well.
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    /**
     * Move the current history selection up/down by the given delta.
     * Positive delta moves forward (down arrow), negative moves backward.
     */
    navigateHistory(delta) {
        const key = this.activeTab;
        const stack = this.history[key] || [];
        if (stack.length === 0) return;
        if (this.currentHistoryKey !== key || !Number.isInteger(this.currentHistoryIndex)) {
            this.currentHistoryKey = key;
            this.currentHistoryIndex = 0;
        }
        let newIdx = this.currentHistoryIndex + delta;
        newIdx = Math.min(Math.max(newIdx, 0), stack.length - 1);
        // With a tag filter on, step through what the strip shows.
        const shown = this.historyVisibleIndices ? this.historyVisibleIndices(key) : null;
        if (shown && shown.length && shown.length < stack.length) {
            const cur = this.currentHistoryIndex;
            const next = delta > 0 ? shown.find((i) => i > cur) : [...shown].reverse().find((i) => i < cur);
            if (next === undefined) return;
            newIdx = next;
        }
        if (newIdx === this.currentHistoryIndex) return;
        this.currentHistoryIndex = newIdx;
        this.openHistorySnapshot(key, newIdx);
        // after rendering ensure the selected thumb is visible
        try {
            const panel = this.historyStrip || (this.historyPanel && this.historyPanel.querySelector('.history-strip'));
            const sel = panel && panel.querySelector('.history-thumb.selected');
            if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) { /* ignore */ }
    },

    // ── Thumbnail context menu ───────────────────────────────────────────────

    showThumbContextMenu(ev, imgObj, key, idx) {
        const doc = (this.container && this.container.ownerDocument) ? this.container.ownerDocument : document;
        const existing = this.container ? this.container.querySelector('#thumb-ctx-menu') : null;
        if (existing) existing.remove();

        let copyPath = '';
        if (imgObj && imgObj.path) {
            copyPath = imgObj.path;
        } else if (imgObj && imgObj.filename) {
            copyPath = imgObj.subfolder ? `${imgObj.subfolder}/${imgObj.filename}` : imgObj.filename;
        }

        const menu = doc.createElement('div');
        menu.id = 'thumb-ctx-menu';
        menu.className = 'thumb-ctx-menu';

        const item = doc.createElement('div');
        item.className = 'thumb-ctx-item';
        item.textContent = '📋 Copy image path';
        item.onclick = (e) => {
            e.stopPropagation();
            menu.remove();
            this.copyTextToClipboard(copyPath);     // BrowserMixin; the browser's menu shares it
        };
        menu.appendChild(item);

        // Right-clicking inside a selection acts on all of it; right-clicking
        // outside one acts on the item under the cursor, as it always did.
        const batch = this.isHistoryItemSelected(key, idx)
            ? this.historySelectionIndices(key) : [];

        // agentY: tag the picture, approve it at a review stop (AgentYMixin).
        if (this.agentYMenuItems) {
            for (const el of this.agentYMenuItems(doc, menu, key, batch.length > 1 ? batch : [idx])) menu.appendChild(el);
        }
        // Colour tags (HistoryTagsMixin), for the same items Remove acts on.
        if (this.historyTagMenuRow) {
            menu.appendChild(this.historyTagMenuRow(doc, menu, key, batch.length > 1 ? batch : [idx]));
        }
        const removeItem = doc.createElement('div');
        removeItem.className = 'thumb-ctx-item';
        removeItem.textContent = batch.length > 1
            ? `🗑 Remove ${batch.length} from history`
            : '🗑 Remove from history';
        removeItem.onclick = (e) => {
            e.stopPropagation();
            menu.remove();
            if (batch.length > 1) this.removeHistoryItems(key, batch);
            else this.removeHistoryItem(key, idx);
        };
        menu.appendChild(removeItem);
        // A scene, or the film / poster of one, can be edited in the Motion editor (MgPanelMixin).
        if (batch.length <= 1 && this.mgAddEditItem && imgObj) {
            this.mgAddEditItem(menu, imgObj.path ? imgObj.path : { filename: imgObj.filename, subfolder: imgObj.subfolder, type: imgObj.type }, removeItem);
        }

        const panelRect = this.container.getBoundingClientRect();
        menu.style.left = `${ev.clientX - panelRect.left}px`;
        menu.style.top  = `${ev.clientY - panelRect.top}px`;
        this.container.appendChild(menu);

        const dismiss = () => { menu.remove(); this.container.removeEventListener('click', dismiss, true); };
        setTimeout(() => this.container.addEventListener('click', dismiss, true), 0);
    },

    /** Remove several snapshots of one tab in a single go. */
    removeHistoryItems(key, indices) {
        // Back to front: removeHistoryItem re-indexes everything after the one it
        // drops, so the lower indices are only correct while they are still ahead.
        const ordered = [...new Set(indices)].filter(Number.isInteger).sort((a, b) => b - a);
        if (ordered.length === 0) return;
        for (const index of ordered) this.removeHistoryItem(key, index);
        // Whatever survived has shifted; the old indices no longer mean anything.
        this.clearHistorySelection();
    },

    /**
     * What the Shift+Delete hotkey removes: the multi-selection when there is one,
     * otherwise the snapshot currently open in the viewer. Does nothing when
     * neither applies, so the key falls through to whatever else wants it.
     */
    deleteSelectedHistory() {
        const key = this.activeTab;
        const selected = this.historySelectionIndices(key);
        if (selected.length > 0) {
            this.removeHistoryItems(key, selected);
            return true;
        }
        if (this.isViewingHistory && this.currentHistoryKey === key &&
            Number.isInteger(this.currentHistoryIndex)) {
            this.removeHistoryItem(key, this.currentHistoryIndex);
            return true;
        }
        return false;
    },

    /** True when Shift+Delete has something to act on -- see deleteSelectedHistory. */
    hasDeletableHistory() {
        const key = this.activeTab;
        if (this.historySelectionIndices(key).length > 0) return true;
        return !!(this.isViewingHistory && this.currentHistoryKey === key &&
                  Number.isInteger(this.currentHistoryIndex));
    },

    removeHistoryItem(key, index) {
        const stack = this.history[key];
        if (!Array.isArray(stack) || index < 0 || index >= stack.length) return;

        if (this.isViewingHistory && this.currentHistoryKey === key && this.currentHistoryIndex === index) {
            this.restoreHistoryView();
        }

        stack.splice(index, 1);

        if (this.currentHistoryKey === key && Number.isInteger(this.currentHistoryIndex)) {
            if (this.currentHistoryIndex > index) {
                this.currentHistoryIndex -= 1;
            } else if (this.currentHistoryIndex >= stack.length) {
                this.currentHistoryIndex = stack.length > 0 ? stack.length - 1 : null;
            }
            if (this.currentHistoryIndex == null) this.currentHistoryKey = null;
        }

        if (this.historyCompare && this.historyCompare.key === key) {
            const baseWasDeleted = this.historyCompare.baseIdx === index;
            const otherWasDeleted = this.historyCompare.otherIdx === index;

            if (baseWasDeleted || otherWasDeleted || stack.length < 2) {
                this.exitHistoryCompare();
            } else {
                if (this.historyCompare.baseIdx > index) this.historyCompare.baseIdx -= 1;
                if (this.historyCompare.otherIdx > index) this.historyCompare.otherIdx -= 1;
            }
        }

        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    restoreHistoryView() {
        if (!this.previewBackup || !this.activeTab) return;
        this.allTabs[this.activeTab] = JSON.parse(JSON.stringify(this.previewBackup));
        this.previewBackup           = null;
        this.isViewingHistory        = false;
        this.currentHistoryKey       = null;
        this.currentHistoryIndex     = null;
        this._historyPanelSig        = null;
        this.refreshView();
        this.renderHistoryPanel();
        if (typeof this.captureTabViewState === 'function') this.captureTabViewState(this.activeTab);
        this.queuePersistViewerState();
    },

    /**
     * Clicking an empty area of the history strip returns the viewer to the
     * newest snapshot that's actually VISIBLE in the panel (index 0), rather
     * than restoring the saved live-view backup. That backup can be stale —
     * e.g. after removing the first history item, the live view still holds
     * the removed snapshot, so restoring it would resurrect the deleted item.
     */
    jumpToLatestVisibleHistory() {
        const key   = this.activeTab;
        const stack = this.history[key] || [];
        if (stack.length === 0) { this.restoreHistoryView(); return; }
        // Drop any stale backup, then show the newest visible snapshot.
        this.previewBackup = null;
        this.openHistorySnapshot(key, 0);
        // Anchor the live-view backup to that newest snapshot so a later click
        // on the selected thumb returns here, not to a removed item.
        this.previewBackup = this.history[key][0]
            ? JSON.parse(JSON.stringify(this.history[key][0]))
            : null;
    },

    // ── Opening files off disk ─────────────────────────────────────
    // Lives in bEpicViewer_mixinBrowser.js now. What stood here raised a
    // tkinter folder dialog on the SERVER, so it appeared on whatever machine
    // ComfyUI runs on — invisible over a remote session — blocked the event
    // loop while it was up, and could only ever return a whole folder of
    // stills. The browser panel lists directories over the API instead.

    // ── Tab helpers ──────────────────────────────────────────────────────────

    saveTabOrder() {
        const container = this.tabsContainer || this.tabBar;
        if (!container) return;
        this.tabOrder = Array.from(container.querySelectorAll('.tab[data-tab]')).map(el => el.dataset.tab);
        this.queuePersistViewerState();
    },

    closeTab(key) {
        // A cut with changes that were not saved asks once (EditTimelineMixin).
        if (this.editTlTabClosing && this.editTlTabClosing(key) === false) return;
        // ...and so does a motion scene (MgPanelMixin).
        if (this.mgTabClosing && this.mgTabClosing(key) === false) return;
        // ...and so does a code / dataset tab (ViewTabsMixin).
        if (this.vtTabClosing && this.vtTabClosing(key) === false) return;
        if (this._revokeDroppedTab) this._revokeDroppedTab(key);   // free blob: URLs of dropped files
        // A 3D tab's picture is an overlay, not an <img>: closing the tab has to
        // take it down, or it keeps hanging over whatever comes next (or over an
        // empty viewer, when this was the last tab). Whichever tab is shown next
        // puts it back if it needs it.
        if (this.activeTab === key && this._exitModelMode) this._exitModelMode();
        if (this.activeTab === key && this._mgOn) this.mgTabLeave();
        if (this.activeTab === key && this._vtOn) this.vtLeave();
        this.tabOrder = this.tabOrder.filter(k => k !== key);
        delete this.allTabs[key];
        delete this.tabLabels[key];
        delete this.customLayouts[key];
        const container = this.tabsContainer || this.tabBar;
        const btn = container && container.querySelector(`[data-tab="${key}"]`);
        if (btn) btn.remove();
        if (this.mgTabClosed) this.mgTabClosed(key);
        if (this.vtTabClosed) this.vtTabClosed(key);
        if (this.activeTab === key) {
            const remaining = Object.keys(this.allTabs);
            if (remaining.length > 0) {
                this.switchTab(remaining[0]);
            } else {
                this.activeTab = null;
                if (this.imgBase)  this.imgBase.src = '';
                this._updatePathBar(null);
                this.applyTimelineBounds(0);
            }
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        this.queuePersistViewerState();
    },

    // ── Private: create a draggable tab button element ───────────────────────
    _makeTabButton(key, labelText) {
        const btn = document.createElement('div');
        btn.className  = 'tab';
        btn.dataset.tab = key;
        btn.title       = labelText;

        const span = document.createElement('span');
        span.className = 'tab-label';           // truncated with an ellipsis; the title has it whole
        span.textContent = labelText;
        btn.appendChild(span);

        // User-assigned tab color (right-click → pick), applied via CSS custom
        // properties so hover/active styling keeps working.
        if (typeof this._applyTabColor === 'function') this._applyTabColor(btn, key);
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof this._openTabColorMenu === 'function') this._openTabColorMenu(key, e.clientX, e.clientY);
        });

        // Reordering is previewed live: the dragged tab itself moves through the
        // bar as the pointer passes each neighbour's middle, and the others
        // slide aside. Dropping keeps the order; Esc, or letting go anywhere
        // else, puts the tab back where it started.
        btn.draggable = true;
        btn.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', key);
            btn.classList.add('dragging');
            const container = btn.parentNode;
            this._tabDrag = { btn, container, home: btn.nextSibling, dropped: false };
            this._ensureTabBarDropZone(container);
        });
        btn.addEventListener('dragend', () => {
            btn.classList.remove('dragging');
            const drag = this._tabDrag;
            this._tabDrag = null;
            if (!drag) return;
            if (drag.dropped) { this.saveTabOrder(); return; }
            // Cancelled: back to where it was picked up.
            if (drag.home && drag.home.parentNode === drag.container) drag.container.insertBefore(btn, drag.home);
            else drag.container.appendChild(btn);
        });
        btn.addEventListener('dragover', (e) => {
            const drag = this._tabDrag;
            if (!drag) return;               // not a tab drag (e.g. a history thumb)
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (btn === drag.btn) return;
            const rect = btn.getBoundingClientRect();
            const before = e.clientX < rect.left + rect.width / 2;
            const target = before ? btn : btn.nextSibling;
            if (target === drag.btn || target === drag.btn.nextSibling) return;   // already there
            this._moveTabAnimated(drag.container, drag.btn, target);
        });
        btn.addEventListener('drop', (e) => {
            if (!this._tabDrag) return;
            e.preventDefault();
            this._tabDrag.dropped = true;
        });

        return btn;
    },

    /** The bar itself accepts the drop too, so letting go between tabs keeps the order. */
    _ensureTabBarDropZone(container) {
        if (!container || container._bepicTabDropZone) return;
        container._bepicTabDropZone = true;
        container.addEventListener('dragover', (e) => {
            if (!this._tabDrag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        container.addEventListener('drop', (e) => {
            if (!this._tabDrag) return;
            e.preventDefault();
            this._tabDrag.dropped = true;
        });
    },

    /**
     * Move `btn` before `target` (null: to the end), sliding the tabs it passes
     * into their new places rather than letting them jump: each is shifted back
     * to where it was drawn, then eased to where it now belongs.
     */
    _moveTabAnimated(container, btn, target) {
        const tabs = [...container.querySelectorAll('.tab')].filter((t) => t !== btn);
        const before = new Map(tabs.map((t) => [t, t.getBoundingClientRect().left]));
        container.insertBefore(btn, target);
        for (const t of tabs) {
            const dx = before.get(t) - t.getBoundingClientRect().left;
            if (!dx) continue;
            t.style.transition = 'none';
            t.style.transform = `translateX(${dx}px)`;
            t.getBoundingClientRect();                    // commit the start position
            t.style.transition = 'transform 140ms ease';
            t.style.transform = '';
        }
    },
};
