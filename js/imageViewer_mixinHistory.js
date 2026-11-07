// imageViewer_mixinHistory.js
// History panel: thumbnails, snapshots, folder loading, tab management.
//
// Three things a thumbnail click can mean, kept apart by modifier:
//   plain        — open that snapshot in the viewport (again to go back)
//   Shift        — pin it against the open one as a two-snapshot compare
//   Ctrl / Cmd   — add it to the multi-selection (+Shift for a range), which
//                  Shift+Delete and the drag-to-graph handler then act on
// Shift keeps compare because that is the older and more valuable gesture; the
// selection is the one that had to find another modifier.
//
// There is one history for all tabs (imageViewer_historyData.js): a click shows
// the snapshot in the tab it was made in, switching to it. On a cut's tab a click
// only selects - plain, Ctrl, Shift for a range - so the cut stays on screen while
// thumbnails are dragged onto its timeline; a double-click opens the snapshot.
import { api } from "../../scripts/api.js";
import { setPref, PREF } from "./imageViewer_settings.js";
import { HISTORY_KEY, snapshotTab, stampSnapshot, snapshotGroup, setSnapshotGroup, historyGroups,
         liveIndexOf, historySections, historyDisplayOrder, foldIntoTab, groupFromLabel, snapshotNode } from "./imageViewer_historyData.js";

export { HISTORY_KEY };
/** The one Viewer tab: where media sent from a node, opened from the file
 *  browser, dropped in or exported is shown (each also a snapshot of the
 *  History), and where a snapshot whose own tab was closed is shown. A user tab
 *  ("folder_" prefix): the stale-tab sweep leaves it alone. Documents and the
 *  live tabs of Send to Viewer nodes keep tabs of their own. */
export const HISTORY_VIEW_TAB = "folder_history";
export const VIEWER_TAB_LABEL = "🖼 Viewer";

// Snapshots kept in the one history (every tab's), unless the user sets another
// number at the foot of the history panel. With clip caching on, this is also how
// many videos can be held in RAM by history alone, so falling off the end has to
// release them. It was 40 per tab while every tab had a history of its own.
export const HISTORY_LIMIT_DEFAULT = 100;
export const HISTORY_LIMIT_OLD_DEFAULT = 40;
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

    // ── One history for every tab ────────────────────────────────────────────
    //
    // There is ONE history, `this.history[HISTORY_KEY]`, newest first, whatever
    // tab a snapshot was made in (imageViewer_historyData.js). Each snapshot
    // remembers that tab (`fromTab`), so a click shows it there; groups (and
    // labels) sort the strip. Everything that acts on "the strip" asks
    // historyKey(), which is always HISTORY_KEY.
    //
    // A cut's tab ("edit:…") shows the same strip, there to be dragged onto the
    // timeline: a click only selects (Ctrl / Shift add to it, and agentY reads it
    // as the selection) and never takes the user off the cut; a double-click
    // opens the snapshot in its tab. historyBorrows() says the strip is like that.

    /** Whether a click in the strip only selects (tab `key` is a cut's: the cut stays on screen). */
    historyBorrows(key = this.activeTab) {
        return !!(key && this.isEditTab && this.isEditTab(key));
    },

    /** The key of the one history the strip shows. */
    historyKey() {
        return HISTORY_KEY;
    },

    /** The history, newest first (made when first asked for). */
    historyStack() {
        if (!this.history || typeof this.history !== 'object') this.history = {};
        if (!Array.isArray(this.history[HISTORY_KEY])) this.history[HISTORY_KEY] = [];
        return this.history[HISTORY_KEY];
    },

    _historyTabLabel(key) {
        let label = "";
        try { label = this._resolveTabLabel ? this._resolveTabLabel(key) : ""; } catch (_) { label = ""; }
        return String(label || (this.tabLabels || {})[key] || key || "");
    },

    /** The tab a snapshot opens in: the tab it was made in while that is open,
     *  else the History tab (made for it). */
    _historyTabFor(snapshot) {
        const from = snapshotTab(snapshot);
        if (from && this.allTabs && this.allTabs[from] && !this.historyBorrows(from)) return from;
        return HISTORY_VIEW_TAB;
    },

    /** The History tab: where a snapshot whose own tab was closed is shown. */
    _ensureHistoryViewTab(snapshot) {
        const fresh = !this.allTabs[HISTORY_VIEW_TAB];
        this.allTabs[HISTORY_VIEW_TAB] = JSON.parse(JSON.stringify(snapshot));
        this.tabLabels[HISTORY_VIEW_TAB] = VIEWER_TAB_LABEL;
        if (fresh) {
            this.tabOrder = [...(this.tabOrder || []).filter((k) => k !== HISTORY_VIEW_TAB), HISTORY_VIEW_TAB];
            if (this._rebuildTabBar) this._rebuildTabBar(null);
        }
    },

    /**
     * Put media on screen in the one Viewer tab: every snapshot of `snapshots`
     * into the History (the first on top) and the first shown - or, with
     * `show` false, only into the History unless the Viewer tab is up anyway
     * (an export must not take the work off screen). `nodeId`: the graph node
     * it came from, for the Parameters panel. -> the tab's key, or null.
     */
    showInViewerTab(snapshots, { show = true, nodeId = null, dedupe = true } = {}) {
        const list = (snapshots || []).filter((s) => Array.isArray(s) && s.length > 0);
        if (!list.length) return null;
        const tab = HISTORY_VIEW_TAB;
        // Each remembers the node it came from: the Parameters panel and the
        // Roto / SAM3 tools follow the snapshot on screen (openHistorySnapshot).
        if (nodeId != null) for (const s of list) if (s[0] && typeof s[0] === "object") s[0].fromNode = String(nodeId);
        for (const s of [...list].reverse()) this.pushHistorySnapshot(tab, s, { dedupe });
        const fresh = !this.allTabs[tab];
        const up = show || this.activeTab === tab || fresh;
        if (up) {
            this.allTabs[tab] = JSON.parse(JSON.stringify(list[0]));
            if (nodeId != null) this.tabSourceNodeIds[tab] = nodeId;
            else if (this.tabSourceNodeIds) delete this.tabSourceNodeIds[tab];
        }
        this.tabLabels[tab] = VIEWER_TAB_LABEL;
        if (!(this.tabOrder || []).includes(tab)) this.tabOrder = [...(this.tabOrder || []), tab];
        if (show || this.activeTab === tab) {
            // Show what was just put there, not wherever the strip was.
            if (this.activeTab === tab || !this.isViewingHistory) {
                this.isViewingHistory = false;
                this.previewBackup    = null;
            }
            this.historyCompare      = null;
            this.currentHistoryKey   = this.historyKey();
            this.currentHistoryIndex = 0;
            // ...nor the older snapshot the tab was left on.
            const st = this.tabViewState && this.tabViewState[tab];
            if (st) { st.viewingHistory = false; st.historyIndex = null; }
            if (show && (!this.popoutWindow || this.popoutWindow.closed)) this.style.display = "flex";
            if (this._rebuildTabBar) this._rebuildTabBar(null);
            this.switchTab(tab);
            if (show) {
                const panel = this.historyPanel || this.shadowRoot.getElementById("history-panel");
                if (panel) panel.style.display = "flex";
                this._syncHistoryToggleState?.();
            }
        } else if (this._rebuildTabBar) this._rebuildTabBar(null);
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState?.();
        return tab;
    },

    /**
     * A render a node (or the agent) sent: into the History, in `group`
     * unless its frames name one already, and shown in the Viewer tab only
     * when that is what the user is looking at the newest of - the Viewer tab
     * up on the newest snapshot (live, or the top one picked), not comparing.
     * Looking at an older one, or at another tab, it waits in the strip.
     * `focus` (the agent asked to have it seen) always shows it; so does the
     * first render of a viewer that has no tab at all. -> the Viewer tab's key.
     */
    takeRenderInViewer(snapshot, { group = "", nodeId = null, focus = false } = {}) {
        if (!Array.isArray(snapshot) || !snapshot.length) return null;
        const tab = HISTORY_VIEW_TAB;
        const shot = JSON.parse(JSON.stringify(snapshot));
        const g = groupFromLabel(group);
        if (g && !snapshotGroup(shot)) setSnapshotGroup(shot, g);
        if (nodeId != null && shot[0] && typeof shot[0] === "object") shot[0].fromNode = String(nodeId);
        const fresh = !this.allTabs[tab];
        const onNewest = this.activeTab === tab && !this.historyCompare && !this.isComparing
            && (!this.isViewingHistory || this.currentHistoryIndex === 0);
        if (focus || onNewest || (fresh && !this.activeTab)) {
            this.showInViewerTab([shot], { show: focus || fresh, nodeId });
            return tab;
        }
        this.pushHistorySnapshot(tab, shot);
        if (fresh) {
            // The tab is made for it, behind whatever is up.
            this.allTabs[tab] = JSON.parse(JSON.stringify(shot));
            this.tabLabels[tab] = VIEWER_TAB_LABEL;
            if (nodeId != null) this.tabSourceNodeIds[tab] = nodeId;
            if (!(this.tabOrder || []).includes(tab)) this.tabOrder = [...(this.tabOrder || []), tab];
        }
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState?.();
        return tab;
    },

    /**
     * Tabs that are groups of the Viewer tab now (a Send to Viewer node's,
     * agentY's named ones): their snapshots become the Viewer tab's, each in
     * the group of its tab's name unless it has one, and the tabs close. The
     * Viewer tab takes the first one's place in the bar and, if one of them
     * was up, its picture. -> how many were folded.
     */
    foldTabsIntoViewer(keys) {
        const tab = HISTORY_VIEW_TAB;
        const folded = (keys || []).filter((k) => k && k !== tab && this.allTabs[k]);
        if (!folded.length) return 0;
        const groups = {};
        for (const k of folded) groups[k] = groupFromLabel(this._historyTabLabel(k));
        // Each snapshot remembers its tab's node (the tools and Parameters follow it).
        for (const s of this.historyStack()) {
            const from = snapshotTab(s), node = this.tabSourceNodeIds && this.tabSourceNodeIds[from];
            if (folded.includes(from) && node != null && s[0] && s[0].fromNode == null) s[0].fromNode = String(node);
        }
        this.history[HISTORY_KEY] = foldIntoTab(this.historyStack(), folded, tab, groups);
        const wasUp = folded.includes(this.activeTab) ? this.activeTab : null;
        const shown = (wasUp && this.allTabs[wasUp]) || this.allTabs[tab]
            || this.history[HISTORY_KEY].find((s) => snapshotTab(s) === tab) || this.allTabs[folded[0]];
        const order = this.tabOrder || [];
        const at = order.findIndex((k) => folded.includes(k) || k === tab);
        for (const k of folded) {
            delete this.allTabs[k]; delete this.tabLabels[k];
            if (this.tabColors) delete this.tabColors[k];
            if (this.tabViewState) delete this.tabViewState[k];
            if (this.tabSourceNodeIds && wasUp !== k) delete this.tabSourceNodeIds[k];
        }
        if (wasUp && this.tabSourceNodeIds && this.tabSourceNodeIds[wasUp] != null) {
            this.tabSourceNodeIds[tab] = this.tabSourceNodeIds[wasUp];
            delete this.tabSourceNodeIds[wasUp];
        }
        if (this.isComparing && folded.includes(this.compareTab) && this.toggleCompare) this.toggleCompare();
        this.allTabs[tab] = JSON.parse(JSON.stringify(shown || []));
        this.tabLabels[tab] = VIEWER_TAB_LABEL;
        const rest = order.filter((k) => !folded.includes(k) && k !== tab);
        rest.splice(at < 0 ? rest.length : Math.min(at, rest.length), 0, tab);
        this.tabOrder = rest;
        if (wasUp) {
            this.activeTab = null;
            this.isViewingHistory = false;
            this.previewBackup = null;
            this.switchTab(tab);
        }
        if (this._rebuildTabBar) this._rebuildTabBar(null);
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState?.();
        return folded.length;
    },

    /**
     * A Roto / SAM3 tool just came onto `node` from the canvas selection: in
     * the Viewer tab, show the newest snapshot that node made (what its own
     * tab used to show). On any other tab, or with none, nothing changes.
     */
    _toolShowNodePicture(node) {
        if (!node || node.id == null || this.activeTab !== HISTORY_VIEW_TAB) return false;
        const id = String(node.id);
        if (String((this.tabSourceNodeIds || {})[HISTORY_VIEW_TAB] ?? "") === id) return false;
        const idx = this.historyStack().findIndex((s) => snapshotNode(s) === id);
        if (idx < 0) return false;
        this.openHistorySnapshot(HISTORY_KEY, idx);
        return true;
    },

    // ── History stack ────────────────────────────────────────────────────────

    // Prepend a snapshot made in tab `tab`, skipping an exact repeat of that
    // tab's newest one (unless `dedupe` is false: an annotation or an export is
    // always a new file). Returns whether anything was added. Every history push
    // goes through here, so the cap is applied - and paid for - in one place, and
    // what points into the stack by index is moved along (onHistoryPrepended).
    pushHistorySnapshot(tab, snapshot, { dedupe = true } = {}) {
        if (!Array.isArray(snapshot) || snapshot.length === 0) return false;
        const stack = this.historyStack();
        const stamped = stampSnapshot(snapshot, tab);
        if (dedupe) {
            const live = liveIndexOf(stack, tab);
            if (live >= 0 && JSON.stringify(stack[live]) === JSON.stringify(stamped)) return false;
        }
        stack.unshift(stamped);
        this.onHistoryPrepended(HISTORY_KEY);
        this.trimHistory(HISTORY_KEY);
        return true;
    },

    // Drop snapshots past the cap.
    trimHistory(key = HISTORY_KEY) {
        const stack = this.history[key];
        if (!Array.isArray(stack)) return;
        const limit = clampHistoryLimit(this.historyLimit);
        while (stack.length > limit) stack.pop();
    },

    // A new cap from the panel footer. Lowering it drops the oldest snapshots
    // straight away, rather than on the next push — through
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
            const res = await fetch(api.apiURL('/imageviewer/probe_paths'), {
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
        } catch (e) { console.warn('imageViewer history push failed', e); }

        this.allTabs[nodeId] = processed;

        if (didPrepend && this.activeTab === nodeId) {
            this.currentHistoryKey = HISTORY_KEY;
            this.currentHistoryIndex = 0;
            this.isViewingHistory = false;
            this.previewBackup = null;
            this.historyCompare = null;
            this._historyCompareEntered = false;
            this.currentFrame = this.getTimelineBounds(processed.length).min;
        }

        if (this.activeTab === nodeId && didPrepend) this.refreshView();
        // One strip for every tab: a new snapshot is in it whichever tab is up.
        if (didPrepend) this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    // ── Multi-selection ──────────────────────────────────────────────────────
    //
    // Ctrl/Cmd-click builds it, Ctrl+Shift-click extends it as a range. Plain
    // Shift-click is deliberately left alone: that is the two-snapshot compare
    // pin, and it is the more valuable gesture of the two.
    //
    // It lives on the one history (its key is HISTORY_KEY), so it can hold
    // snapshots of several tabs. Transient by design: not persisted, and dropped whenever the stack it
    // indexes into shifts underneath it.

    // The selection holds the snapshots themselves (the stack's own array for
    // each frame), never their positions or file paths: two renders of the same
    // file are two items, and a new render shifting the strip moves nothing.

    _historySel() {
        if (!this._historySelSet) this._historySelSet = new Set();
        return this._historySelSet;
    },

    isHistoryItemSelected(key, idx) {
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
        const snap = (this.history[key] || [])[idx];
        return this._historySelKey === key && !!snap && this._historySel().has(snap);
    },

    /** The selected indices for a tab, ascending. Empty when it isn't the one. */
    historySelectionIndices(key = this.historyKey()) {
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
        if (this._historySelKey !== key) return [];
        const stack = this.history[key] || [];
        const set = this._historySel();
        const out = [];
        stack.forEach((snap, i) => { if (set.has(snap)) out.push(i); });
        return out;
    },

    /** `[{ imgObj, snapshot }]` for the selection, in strip order. */
    selectedHistorySnapshots(key = this.historyKey()) {
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
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
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
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
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
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
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
        const stack = this.history[key] || [];
        const from = this._historySelKey === key && this._historySelAnchor
            ? stack.indexOf(this._historySelAnchor) : -1;
        if (from < 0) {
            this.toggleHistorySelection(key, idx);
            return;
        }
        // A range as the strip shows it (sections by group), not by stack index.
        const order = this.historyDisplayIndices(key);
        const a = order.indexOf(from), b = order.indexOf(idx);
        const set = this._historySel();
        if (a < 0 || b < 0) {
            const [lo, hi] = from < idx ? [from, idx] : [idx, from];
            for (let i = lo; i <= hi; i++) if (stack[i]) set.add(stack[i]);
        } else {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) if (stack[order[i]]) set.add(stack[order[i]]);
        }
        this._paintHistorySelection();
    },

    // Toggling classes rather than re-rendering: a rebuild drops and re-decodes
    // every thumbnail, which is far too much for a click that changed nothing
    // but which items are highlighted. renderHistoryPanel applies the same
    // classes from state, so a rebuild for other reasons keeps them.
    // A lone selected item is just the open one (it has its own border), so the
    // highlight only shows once there are two or more - except on a borrowed
    // strip, where nothing is open and a click only selects.
    _paintHistorySelection() {
        if (!this.historyStrip) return;
        const picked = this.historySelectionIndices(this.historyKey());
        const selected = new Set(picked.length > 1 || this.historyBorrows() ? picked : []);
        for (const thumb of this.historyStrip.children) {
            const idx = Number(thumb.dataset ? thumb.dataset.idx : NaN);
            if (Number.isInteger(idx)) thumb.classList.toggle('multi', selected.has(idx));
        }
        // A multi-item compare follows the selection (ContactGridMixin).
        if (this._multiCompareSelectionChanged) this._multiCompareSelectionChanged();
    },

    /** Whether tab `tab`'s picture must stay as it is when a new render for it
     *  lands: the user is looking at an older snapshot there, or comparing. */
    isHistorySelectionPinned(tab) {
        if (this.historyCompare) return true;
        if (this.isViewingHistory && this.activeTab === tab) return true;
        if (this.isComparing && (this.activeTab === tab || this.compareTab === tab)) return true;
        return false;
    },

    // A snapshot went onto the front of the stack: what points into it by index
    // moves one along (the selection holds the snapshots themselves).
    onHistoryPrepended(key = HISTORY_KEY) {
        const stack = this.history[key] || [];
        const last = Math.max(0, stack.length - 1);

        if (this.currentHistoryKey === key && Number.isInteger(this.currentHistoryIndex)) {
            this.currentHistoryIndex = Math.min(this.currentHistoryIndex + 1, last);
        }

        if (this.historyCompare && this.historyCompare.key === key) {
            this.historyCompare.baseIdx = Math.min(this.historyCompare.baseIdx + 1, last);
            this.historyCompare.otherIdx = Math.min(this.historyCompare.otherIdx + 1, last);
        }

        // Where each tab was looking (switchTab opens it again).
        for (const st of Object.values(this.tabViewState || {})) {
            if (st && Number.isInteger(st.historyIndex)) st.historyIndex = Math.min(st.historyIndex + 1, last);
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
        // Loaded once already (a filter change or any rebuild remakes the tiles):
        // set it now, from the browser's cache, so the tile never shows empty.
        // No request, so the lazy queue and its cap of THUMB_LOADS_MAX do not apply.
        if (this._thumbLoaded && this._thumbLoaded.has(url)) { imgEl.loading = 'eager'; imgEl.src = url; return; }
        imgEl._imageViewerThumbUrl = url;
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
            const url = img._imageViewerThumbUrl;
            img._imageViewerThumbUrl = null;
            if (!url || !img.isConnected) continue;
            L.inflight.add(img);
            const done = (ev) => {
                if (ev && ev.type === 'load') {
                    const seen = this._thumbLoaded || (this._thumbLoaded = new Set());
                    seen.add(url);
                    if (seen.size > 3000) seen.delete(seen.values().next().value);
                }
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

    /** The stack indices as the strip shows them, top to bottom: by group, the
     *  tag filter applied, collapsed groups left out. */
    historyDisplayIndices(key = HISTORY_KEY) {
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
        const stack = this.history[key] || [];
        const visible = this.historyTagVisible ? (s) => this.historyTagVisible(s) : null;
        return historyDisplayOrder(stack, visible, this._historyCollapsedSet());
    },

    _historyCollapsedSet() {
        if (!(this.historyCollapsed instanceof Set)) this.historyCollapsed = new Set(Array.isArray(this.historyCollapsed) ? this.historyCollapsed : []);
        return this.historyCollapsed;
    },

    /** Fold a group's section of the strip away, or open it again. */
    toggleHistoryGroupCollapsed(group) {
        const set = this._historyCollapsedSet();
        const g = String(group || "");
        if (set.has(g)) set.delete(g); else set.add(g);
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState?.();
    },

    /** Which snapshot is the open one, the orange-bordered tile: the one being
     *  looked at, else the newest one of the tab that is up (its live picture). */
    _historyOpenIndex() {
        if (this.historyBorrows()) return null;
        const stack = this.history[HISTORY_KEY] || [];
        if (this.isViewingHistory && this.currentHistoryKey === HISTORY_KEY && Number.isInteger(this.currentHistoryIndex)
            && this.currentHistoryIndex >= 0 && this.currentHistoryIndex < stack.length) {
            return this.currentHistoryIndex;
        }
        const live = liveIndexOf(stack, this.activeTab);
        return live >= 0 ? live : null;
    },

    // The open item's highlight, set on the tiles already in the strip - what
    // renderHistoryPanel would draw for it, without making the tiles again.
    _paintHistoryCurrent(key) {
        if (!this.historyStrip) return;
        for (const thumb of this.historyStrip.children) {
            if (!thumb.classList || !thumb.classList.contains('history-thumb')) continue;
            const idx = Number(thumb.dataset ? thumb.dataset.idx : NaN);
            const isSelected = !this.historyBorrows() && this.currentHistoryKey === key && this.currentHistoryIndex === idx;
            if (thumb.classList.contains('selected') === isSelected) continue;
            thumb.classList.toggle('selected', isSelected);
            thumb.style.border = isSelected ? '2px solid #f60' : '';
        }
        this._paintHistorySelection();
    },

    /** A group's heading in the strip: its name and count; a click folds it, and
     *  thumbnails dropped on it move into that group. */
    _historyGroupHeading(doc, section, anyGroups) {
        const g = section.group;
        if (!g && !anyGroups) return null;           // no groups at all: no heading
        const h = doc.createElement('div');
        h.className = 'history-group';
        const collapsed = this._historyCollapsedSet().has(g);
        h.classList.toggle('collapsed', collapsed);
        h.dataset.group = g;
        const caret = doc.createElement('span');
        caret.className = 'history-group-caret';
        caret.textContent = collapsed ? '▸' : '▾';
        const name = doc.createElement('span');
        name.className = 'history-group-name';
        name.textContent = g || 'No group';
        const count = doc.createElement('span');
        count.className = 'history-group-count';
        count.textContent = String(section.count);
        h.append(caret, name, count);
        if (g) {
            // Rename it: the pencil, or a right-click on the heading.
            const pen = doc.createElement('span');
            pen.className = 'history-group-rename';
            pen.textContent = '✎';
            pen.title = `Rename the group "${g}"`;
            pen.onclick = (ev) => { ev.stopPropagation(); this._historyGroupRenameField(h, g); };
            h.insertBefore(pen, count);
            h.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); this._historyGroupRenameField(h, g); };
        }
        h.title = `${g ? `Group "${g}"` : 'Not in a group'}: ${section.count} snapshot${section.count === 1 ? '' : 's'}\n`
                + `Click to ${collapsed ? 'show' : 'fold away'}; drop thumbnails here to move them ${g ? 'into this group' : 'out of their group'}`
                + (g ? '\n✎ or right-click to rename it' : '');
        h.onmousedown = (ev) => ev.stopPropagation();
        h.onclick = (ev) => { ev.stopPropagation(); this.toggleHistoryGroupCollapsed(g); };
        // A thumbnail dragged in the strip (HistoryMixin keeps what it carries).
        h.addEventListener('dragover', (ev) => {
            if (!this._historyDragSnaps) return;
            ev.preventDefault();
            try { ev.dataTransfer.dropEffect = 'move'; } catch (_) {}
            h.classList.add('drop');
        });
        h.addEventListener('dragleave', () => h.classList.remove('drop'));
        h.addEventListener('drop', (ev) => {
            h.classList.remove('drop');
            const snaps = this._historyDragSnaps;
            if (!snaps) return;
            ev.preventDefault();
            ev.stopPropagation();
            this._historyDragSnaps = null;
            this.setHistoryGroupOf(snaps, g);
        });
        return h;
    },

    renderHistoryPanel() {
        if (!this.historyStrip) return;
        // On a cut's tab a click only selects (historyBorrows, at the top).
        const borrowed = this.historyBorrows();
        const key   = HISTORY_KEY;
        const stack = this.history[key] || [];

        // The open tile: the snapshot looked at, or the tab's own newest.
        const open = this._historyOpenIndex();
        if (!borrowed) {
            this.currentHistoryKey   = open == null ? null : key;
            this.currentHistoryIndex = open;
        }

        // --- fast-path: skip full DOM rebuild if nothing changed ---
        const collapsed = this._historyCollapsedSet();
        const layoutSig = JSON.stringify({ key, borrowed, len: stack.length, cmp: this.historyCompare,
                                           groups: stack.map((s) => snapshotGroup(s)).join('\u0001'),
                                           collapsed: [...collapsed].sort(),
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

        // The tag filter in the footer (HistoryTagsMixin).
        if (this._syncHistoryTagFilter) this._syncHistoryTagFilter();

        // One section per group, the group used last first (imageViewer_historyData.js).
        const visible = this.historyTagVisible ? (s) => this.historyTagVisible(s) : null;
        const sections = historySections(stack, visible, collapsed);
        const anyGroups = sections.some((sec) => sec.group);

        // A tile is made ONCE per snapshot and kept (_historyTiles, by the
        // snapshot itself) for as long as what it shows stays the same: every
        // new render used to remake the whole strip - twice, switchTab and then
        // showInViewerTab - and each new tile set its <img> again, so a strip of
        // N tiles was N elements, N listeners and N decodes per render. Only
        // what depends on the tile's place (its index, its highlight) is painted
        // on every pass (paintThumb); the handlers read the index off the tile.
        const tiles = (this._historyTiles instanceof WeakMap) ? this._historyTiles : (this._historyTiles = new WeakMap());
        const used = new Set();
        const tileSig = (snapshot, imgObj, url) => {
            const from = snapshotTab(snapshot);
            let agent = '';
            try { agent = this.historyAgentTagSig ? this.historyAgentTagSig(snapshot) : ''; } catch (e) { /* ignore */ }
            return [borrowed ? 1 : 0, url || '', snapshotGroup(snapshot), (imgObj && imgObj.label) || '',
                    (this.historyTagOf && this.historyTagOf(snapshot)) || '', from ? this._historyTabLabel(from) : '', agent].join('\u0002');
        };
        const buildThumb = (snapshot, imgObj, url) => {
            const thumb     = document.createElement('div');
            thumb.className = 'history-thumb';
            const at = () => Number(thumb.dataset.idx);

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
                // anything is removed. A failed tile is not kept: the next pass
                // makes it again, so a file that arrived late still shows.
                imgEl.onerror = () => { thumb._imageViewerFailed = true; this.noteMediaLoadFailed(imgObj); };
                try { this._loadThumb(imgEl, url); } catch (e) { /* ignore */ }
            }
            thumb.appendChild(imgEl);
            const tagDot = this.historyTagDot ? this.historyTagDot(snapshot) : null;
            if (tagDot) thumb.appendChild(tagDot);
            const caption = this.historyThumbCaption ? this.historyThumbCaption(document, snapshot) : null;
            if (caption) thumb.appendChild(caption);
            const agentTag = this.historyAgentTagBadge ? this.historyAgentTagBadge(document, snapshot) : null;
            if (agentTag) thumb.appendChild(agentTag);
            // Drag source: drop onto the ComfyUI graph to make a loader node. The
            // whole snapshot is passed so multi-image sequences map to a sequence
            // loader (see _makeHistoryThumbDraggable / _sequenceDirForSnapshot);
            // key and index let a drag pick up the whole selection at once.
            if (imgObj && this._makeHistoryThumbDraggable) {
                this._makeHistoryThumbDraggable(thumb, imgObj, snapshot, key, at);
            }
            // ...and onto a group's heading, to move it (and the selection it is in).
            thumb.addEventListener('dragstart', () => {
                this._historyDragSnaps = this.isHistoryItemSelected(key, at())
                    ? this.selectedHistorySnapshots(key).map((p) => p.snapshot) : [snapshot];
            });
            thumb.addEventListener('dragend', () => { this._historyDragSnaps = null; });

            // Don't preventDefault here — that would block the native drag start
            // used to drop thumbnails onto the graph. stopPropagation still keeps
            // the mousedown from reaching any parent panel handler.
            thumb.onmousedown  = ev => ev.stopPropagation();
            thumb.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); this.showThumbContextMenu(ev, imgObj, key, at()); };
            // On a cut's tab a click selects and the cut stays on screen; a
            // double-click opens the snapshot in its tab.
            if (borrowed) {
                thumb.onclick = (ev) => {
                    ev.stopPropagation();
                    const idx = at();
                    if (ev.shiftKey) this.extendHistorySelection(key, idx);
                    else if (ev.ctrlKey || ev.metaKey) this.toggleHistorySelection(key, idx);
                    else this.startHistorySelection(key, idx);
                };
                thumb.ondblclick = (ev) => {
                    ev.stopPropagation();
                    const idx = at();
                    if (this.historyCompare) this.exitHistoryCompare();
                    this.openHistorySnapshot(key, idx);
                    this.startHistorySelection(key, idx);
                };
                return thumb;
            }
            thumb.onclick = (ev) => {
                ev.stopPropagation();
                const idx = at();

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

                if (ev.shiftKey && Number.isInteger(this.currentHistoryIndex) && this.currentHistoryKey === key) {
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
                }
            };
            return thumb;
        };
        // What depends on where the tile is: its index, its title, its highlights.
        const multiOn = borrowed || this.historySelectionIndices(key).length > 1;
        const paintThumb = (thumb, snapshot, imgObj, idx) => {
            thumb.dataset.idx = String(idx);
            const what = imgObj && imgObj.label ? ` - ${imgObj.label}` : '';
            const from = snapshotTab(snapshot);
            const fromWords = from ? `, from ${this._historyTabLabel(from)}` : '';
            const groupWords = snapshotGroup(snapshot) ? ` (group ${snapshotGroup(snapshot)})` : '';
            thumb.title = borrowed
                ? `History ${idx + 1}${what}${fromWords}${groupWords}\n` +
                  `Drag onto the timeline to add it to the cut\n` +
                  `Click to select it, Ctrl+click to add to the selection, Shift+click for a range\n` +
                  `Double-click to open it in its tab\n` +
                  `Right-click to tag it or move it to another group`
                : `History ${idx + 1}${what}${fromWords}${groupWords}\n` +
                          `Click to show it (in its tab), then Ctrl+click to add to the selection, Ctrl+Shift+click for a range\n` +
                          `Shift+click to compare against the open snapshot\n` +
                          `C with several Ctrl-selected: compare them (3+: a Contact Sheet of all)\n` +
                          `Drag onto a group's heading to move it there; right-click to tag it or pick a group`;
            const isSelected = !borrowed && (this.currentHistoryKey === key && this.currentHistoryIndex === idx);
            thumb.classList.toggle('selected', isSelected);
            thumb.style.border = isSelected ? '2px solid #f60' : '';
            const cmp = this.historyCompare && this.historyCompare.key === key ? this.historyCompare : null;
            thumb.classList.toggle('base', !!cmp && idx === cmp.baseIdx);
            thumb.classList.toggle('compare', !!cmp && idx === cmp.otherIdx);
            thumb.classList.toggle('multi', multiOn && this.isHistoryItemSelected(key, idx));
        };
        const makeThumb = (snapshot, idx) => {
            const imgObj = (snapshot && snapshot.length > 0) ? snapshot[0] : null;
            let url = null;
            if (imgObj) { try { url = this.thumbUrl(imgObj); } catch (e) { /* ignore */ } }
            const sig = tileSig(snapshot, imgObj, url);
            const kept = snapshot && typeof snapshot === 'object' ? tiles.get(snapshot) : null;
            let thumb = kept && kept.sig === sig && !kept.el._imageViewerFailed && !used.has(kept.el) ? kept.el : null;
            if (!thumb) {
                thumb = buildThumb(snapshot, imgObj, url);
                if (snapshot && typeof snapshot === 'object' && !(kept && used.has(kept.el))) tiles.set(snapshot, { el: thumb, sig });
            }
            used.add(thumb);
            paintThumb(thumb, snapshot, imgObj, idx);
            return thumb;
        };

        // Headings are kept the same way, by what they show.
        const headsBefore = this._historyHeadings instanceof Map ? this._historyHeadings : new Map();
        const headsNow = new Map();
        const nodes = [];
        for (const sec of sections) {
            const hk = `${anyGroups ? 1 : 0}\u0002${sec.group}\u0002${sec.count}\u0002${collapsed.has(sec.group) ? 1 : 0}`;
            let heading = headsBefore.get(hk);
            // One with its rename field open is made again: leaving the field redraws to get the name back.
            if (heading === undefined || headsNow.has(hk) || (heading && heading.querySelector('input'))) {
                heading = this._historyGroupHeading(document, sec, anyGroups);
            }
            headsNow.set(hk, heading);
            if (heading) {
                heading.classList.remove('drop');
                nodes.push(heading);
            }
            for (const idx of sec.indices) nodes.push(makeThumb(stack[idx], idx));
        }
        this._historyHeadings = headsNow;

        if (stack.length && !nodes.length) {
            const none = document.createElement('div');
            none.className = 'history-tag-empty';
            none.textContent = 'Nothing tagged like that here';
            nodes.push(none);
        } else if (borrowed && !stack.length) {
            const none = document.createElement('div');
            none.className = 'history-tag-empty';
            none.textContent = 'No history yet. Renders show here, to drag onto the cut.';
            nodes.push(none);
        }
        // Replace strip contents in one operation - and not at all when the
        // tiles are already there in that order (a forced redraw that changed
        // nothing), so the strip is not laid out again for nothing.
        const cur = this.historyStrip.children;
        const same = cur.length === nodes.length && nodes.every((n, i) => cur[i] === n);
        if (!same) this.historyStrip.replaceChildren(...nodes);

        // Only reached when the signature changed, so this rides on real rebuilds
        // — a restore from localStorage, a new output, a tab switch — rather than
        // on every call. Paths already verified are skipped, so a settled session
        // sends nothing.
        this.scheduleHistoryPrune();

        if (this.historyClearBtn) this.historyClearBtn.disabled = stack.length === 0;
        // With a tag filter on, Clear clears what it shows (HistoryTagsMixin).
        if (this._syncHistoryClearTitle) this._syncHistoryClearTitle();
    },

    /**
     * Show snapshot `index` of the history: in the tab it was made in (switching
     * to it), or, with that tab closed, in the History tab. The tab's own
     * picture is kept in previewBackup and comes back with restoreHistoryView or
     * when the user leaves the tab.
     */
    openHistorySnapshot(key, index) {
        key = HISTORY_KEY;
        const stack = this.history[key];
        if (!stack || !stack[index]) return;
        const snap = stack[index];
        const tab = this._historyTabFor(snap);
        const fresh = tab === HISTORY_VIEW_TAB && !this.allTabs[tab];
        if (fresh) this._ensureHistoryViewTab(snap);
        // Its tab first: switchTab hands the tab it leaves its own picture back.
        if (this.activeTab !== tab) this.switchTab(tab);
        if (fresh) {
            // A Viewer tab made for it has no picture of its own: the snapshot is it.
            this.allTabs[tab] = JSON.parse(JSON.stringify(snap));
            this.previewBackup = JSON.parse(JSON.stringify(snap));
        } else if (!this.previewBackup) {
            this.previewBackup = this.allTabs[tab] ? JSON.parse(JSON.stringify(this.allTabs[tab])) : null;
        }
        this.allTabs[tab]        = JSON.parse(JSON.stringify(snap));
        // In the Viewer tab the node behind the picture is the snapshot's.
        let movedNode = false;
        if (tab === HISTORY_VIEW_TAB && this.tabSourceNodeIds) {
            const from = snapshotNode(snap);
            movedNode = String(this.tabSourceNodeIds[tab] ?? "") !== String(from ?? "");
            if (from != null) this.tabSourceNodeIds[tab] = from;
            else delete this.tabSourceNodeIds[tab];
        }
        if (movedNode && this._toolRebindIfMoved) this._toolRebindIfMoved();
        this.isViewingHistory    = true;
        this.currentHistoryKey   = key;
        this.currentHistoryIndex = index;
        this.refreshView();
        if (typeof this.captureTabViewState === 'function') this.captureTabViewState(tab);
        // The strip's signature knows the open index, so this only moves the
        // highlight - unless something else about the strip changed as well.
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    /**
     * Move the current history selection up/down by the given delta, through
     * the strip as it is drawn (by group, the filter applied).
     * Positive delta moves forward (down arrow), negative moves backward.
     */
    navigateHistory(delta) {
        // On a cut's tab the strip opens nothing in the viewport: the cut stays on screen.
        if (this.historyBorrows()) return;
        const key = HISTORY_KEY;
        const order = this.historyDisplayIndices(key);
        if (order.length === 0) return;
        const cur = Number.isInteger(this.currentHistoryIndex) ? order.indexOf(this.currentHistoryIndex) : -1;
        const pos = cur < 0 ? (delta > 0 ? 0 : order.length - 1)
                            : Math.min(Math.max(cur + delta, 0), order.length - 1);
        if (pos === cur) return;
        const newIdx = order[pos];
        this.openHistorySnapshot(key, newIdx);
        // after rendering ensure the selected thumb is visible
        try {
            const panel = this.historyStrip || (this.historyPanel && this.historyPanel.querySelector('.history-strip'));
            const sel = panel && panel.querySelector('.history-thumb.selected');
            if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) { /* ignore */ }
    },

    // ── Groups, after the fact ───────────────────────────────────────────────

    /** The groups the history holds, the one used last first. */
    historyGroupNames() {
        return historyGroups(this.history[HISTORY_KEY] || []);
    },

    /** Put these snapshots (the stack's own arrays) into `group` ("" takes them
     *  out of their group). What a tab shows of them follows. */
    setHistoryGroupOf(snaps, group) {
        const list = (snaps || []).filter(Array.isArray);
        if (!list.length) return;
        for (const s of list) setSnapshotGroup(s, group);
        // The same pictures where a tab shows them now (a snapshot open in its
        // tab is a copy of it), so the caption and agentY's state agree.
        const paths = new Set(list.flatMap((s) => s.map((fr) => this._historyFrameKey(fr))).filter(Boolean));
        const touch = (frames) => { for (const fr of frames || []) if (paths.has(this._historyFrameKey(fr))) setSnapshotGroup([fr], group); };
        for (const frames of Object.values(this.allTabs || {})) if (Array.isArray(frames)) touch(frames);
        if (Array.isArray(this.previewBackup)) touch(this.previewBackup);
        const g = String(group || "").trim();
        this._historyCollapsedSet().delete(g);       // show where they went
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState?.();
    },

    /** Rename group `from` to `to` (an existing name: the two become one).
     *  -> whether anything changed. */
    renameHistoryGroup(from, to) {
        const a = String(from || '').trim(), b = String(to || '').trim();
        if (!a || !b || a === b) return false;
        const snaps = (this.history[HISTORY_KEY] || []).filter((s) => snapshotGroup(s) === a);
        if (!snaps.length) return false;
        const set = this._historyCollapsedSet();
        const folded = set.has(a);
        set.delete(a);
        this.setHistoryGroupOf(snaps, b);
        // A folded group stays folded under its new name (setHistoryGroupOf opens it).
        if (folded) { set.add(b); this._historyPanelSig = null; this.renderHistoryPanel(); }
        return true;
    },

    /** The heading's name as a field: Enter renames, Esc or leaving it does not. */
    _historyGroupRenameField(h, group) {
        const doc = h.ownerDocument || document;
        const name = h.querySelector('.history-group-name');
        if (!name || h.querySelector('input')) return;
        const input = doc.createElement('input');
        input.className = 'history-group-input';
        input.value = group;
        input.title = 'Enter renames the group; a name that is there already merges the two';
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            const to = input.value.trim();
            if (ok && to && to !== group) { this.renameHistoryGroup(group, to); return; }
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        };
        for (const type of ['click', 'mousedown', 'dblclick', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();      // the viewer's and ComfyUI's keys stay out of it
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        name.replaceWith(input);
        input.focus();
        input.select();
    },

    /** Put the snapshots at `indices` into `group`. */
    setHistoryGroup(key, indices, group) {
        const stack = this.history[HISTORY_KEY] || [];
        this.setHistoryGroupOf((indices || []).map((i) => stack[i]).filter(Boolean), group);
    },

    _historyFrameKey(fr) {
        if (!fr || typeof fr !== 'object') return '';
        if (fr.path) return `p:${String(fr.path).replace(/\\/g, '/')}`;
        if (fr.filename) return `f:${fr.type || ''}|${fr.subfolder || ''}|${fr.filename}`;
        return fr.url ? `u:${fr.url}` : '';
    },

    /** The thumbnail menu's "Move to group" row: opens the list of groups below it. */
    _historyGroupMenuRows(doc, menu, key, indices) {
        const stack = this.history[HISTORY_KEY] || [];
        const snaps = indices.map((i) => stack[i]).filter(Boolean);
        const current = new Set(snaps.map((s) => snapshotGroup(s)));
        const n = snaps.length;
        const head = doc.createElement('div');
        head.className = 'thumb-ctx-item thumb-ctx-group thumb-ctx-keep';
        head.textContent = n > 1 ? `📁 Move ${n} to group ▸` : '📁 Move to group ▸';
        head.title = 'Put it into another group of the history (or a new one)';
        const rows = [];
        const sub = (text, title, run, on = false) => {
            const el = doc.createElement('div');
            el.className = 'thumb-ctx-item thumb-ctx-sub' + (on ? ' on' : '');
            el.textContent = text;
            el.title = title;
            el.onclick = (e) => { e.stopPropagation(); menu.remove(); run(); };
            return el;
        };
        head.onclick = (e) => {
            e.stopPropagation();
            if (rows.length) { rows.forEach((r) => r.remove()); rows.length = 0; head.textContent = head.textContent.replace('▾', '▸'); return; }
            head.textContent = head.textContent.replace('▸', '▾');
            const only = current.size === 1 ? [...current][0] : null;
            for (const g of this.historyGroupNames()) {
                rows.push(sub(`${only === g ? '✓ ' : ''}${g}`, `Move into "${g}"`, () => this.setHistoryGroupOf(snaps, g), only === g));
            }
            rows.push(sub('＋ New group…', 'Name a new group and move it there', () => {
                const win = doc.defaultView || window;
                const name = String(win.prompt('Name of the new group:', '') || '').trim();
                if (name) this.setHistoryGroupOf(snaps, name);
            }));
            if ([...current].some(Boolean)) {
                rows.push(sub('✕ No group', 'Take it out of its group', () => this.setHistoryGroupOf(snaps, '')));
            }
            let at = head;
            for (const r of rows) { at.after(r); at = r; }
        };
        return head;
    },

    // ── Thumbnail context menu ───────────────────────────────────────────────

    showThumbContextMenu(ev, imgObj, key, idx) {
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
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
        // Another group for it, after the fact (the strip is sorted by group).
        menu.appendChild(this._historyGroupMenuRows(doc, menu, key, batch.length > 1 ? batch : [idx]));
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
        // What it was made from, and what was made from it (DepsPanelMixin).
        if (batch.length <= 1 && this.depsAddMenuItem && imgObj) {
            this.depsAddMenuItem(menu, imgObj.path ? imgObj.path : { filename: imgObj.filename, subfolder: imgObj.subfolder, type: imgObj.type }, removeItem);
        }
        // A picture can be painted on in layers (PaintPanelMixin).
        if (batch.length <= 1 && this.paintAddEditItem && imgObj) {
            this.paintAddEditItem(menu, imgObj.path ? imgObj.path : { filename: imgObj.filename, subfolder: imgObj.subfolder, type: imgObj.type }, removeItem);
        }

        const panelRect = this.container.getBoundingClientRect();
        menu.style.left = `${ev.clientX - panelRect.left}px`;
        menu.style.top  = `${ev.clientY - panelRect.top}px`;
        this.container.appendChild(menu);

        // A row that opens more rows (Move to group) keeps the menu up.
        const dismiss = (e) => {
            if (e && e.target && e.target.closest && e.target.closest('.thumb-ctx-keep')) return;
            menu.remove(); this.container.removeEventListener('click', dismiss, true);
        };
        setTimeout(() => this.container.addEventListener('click', dismiss, true), 0);
    },

    /** Remove several snapshots of one tab in a single go. */
    removeHistoryItems(key, indices) {
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
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
        // On a cut's tab Shift+Delete is the Edit panel's ripple delete; the
        // borrowed strip's items go by their right-click menu.
        if (this.historyBorrows()) return false;
        const key = HISTORY_KEY;
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
        if (this.historyBorrows()) return false;
        const key = HISTORY_KEY;
        if (this.historySelectionIndices(key).length > 0) return true;
        return !!(this.isViewingHistory && this.currentHistoryKey === key &&
                  Number.isInteger(this.currentHistoryIndex));
    },

    removeHistoryItem(key, index) {
        key = HISTORY_KEY;   // one history: a tab's key (older callers) means it too
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
        const stack = this.history[HISTORY_KEY] || [];
        // The newest snapshot of the tab that is up (what a render last put there).
        const live = liveIndexOf(stack, this.activeTab);
        if (live < 0) { this.restoreHistoryView(); return; }
        // Drop any stale backup, then show the newest visible snapshot.
        this.previewBackup = null;
        this.openHistorySnapshot(HISTORY_KEY, live);
        // Anchor the live-view backup to that newest snapshot so a later click
        // on the selected thumb returns here, not to a removed item.
        this.previewBackup = stack[live] ? JSON.parse(JSON.stringify(stack[live])) : null;
    },

    // ── Opening files off disk ─────────────────────────────────────
    // Lives in imageViewer_mixinBrowser.js now. What stood here raised a
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
        // ...and so does a picture in Paint (PaintPanelMixin).
        if (this.paintTabClosing && this.paintTabClosing(key) === false) return;
        // ...and so does a code / dataset tab (ViewTabsMixin).
        if (this.vtTabClosing && this.vtTabClosing(key) === false) return;
        if (this._revokeDroppedTab) this._revokeDroppedTab(key);   // free blob: URLs of dropped files
        // A 3D tab's picture is an overlay, not an <img>: closing the tab has to
        // take it down, or it keeps hanging over whatever comes next (or over an
        // empty viewer, when this was the last tab). Whichever tab is shown next
        // puts it back if it needs it.
        if (this.activeTab === key && this._exitModelMode) this._exitModelMode();
        if (this.activeTab === key && this._mgOn) this.mgTabLeave();
        if (this.activeTab === key && this._paintOn) this.paintTabLeave();
        if (this.activeTab === key && this._vtOn) this.vtLeave();
        this.tabOrder = this.tabOrder.filter(k => k !== key);
        delete this.allTabs[key];
        delete this.tabLabels[key];
        delete this.customLayouts[key];
        const container = this.tabsContainer || this.tabBar;
        // CSS.escape: a Paint tab's key is a path, and a Windows path's backslashes are escapes in a selector.
        const btn = container && container.querySelector(`[data-tab="${CSS.escape(key)}"]`);
        if (btn) btn.remove();
        if (this.mgTabClosed) this.mgTabClosed(key);
        if (this.paintTabClosed) this.paintTabClosed(key);
        if (this.vtTabClosed) this.vtTabClosed(key);
        if (this.activeTab === key) {
            const remaining = Object.keys(this.allTabs);
            if (remaining.length > 0) {
                try { this.switchTab(remaining[0]); } catch (e) { console.error("imageViewer: switching after a closed tab", e); }
            } else {
                this.activeTab = null;
                if (this.imgBase)  this.imgBase.src = '';
                this._updatePathBar(null);
                this.applyTimelineBounds(0);
            }
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        } else {
            // The history keeps what the tab made; its tooltips name the tab.
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
        if (!container || container._imageViewerTabDropZone) return;
        container._imageViewerTabDropZone = true;
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
