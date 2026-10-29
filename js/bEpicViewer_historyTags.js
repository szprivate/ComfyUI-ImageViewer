// bEpicViewer_historyTags.js
// Colour tags on history snapshots, and a filter over them.
//
// Right-click a thumbnail (or a multi-selection) and pick a colour; the thumb
// wears it as a dot in its corner. The dropdown in the history footer then
// narrows the strip to one colour, or to everything tagged.
//
// A tag belongs to the IMAGE, not to a slot in the strip: every new render
// shifts every index by one, and removing a snapshot shifts the ones after it,
// so tags are kept in a map keyed by the snapshot's first image (its path, or
// type/subfolder/filename for ComfyUI's own outputs). The map is saved with
// the rest of the viewer state, trimmed to the images history still holds.
//
// The history's Clear button follows the filter: with one on, it removes only
// the snapshots the filter shows (clearHistoryFiltered) — every red one, say,
// or with "Untagged" everything that was not kept by a tag.

import {
    agentFilterValue, agentFilterName, buildAgentTagIndex, agentTagsOfSnapshot, agentTagIndexSig,
} from "./bEpicViewer_historyAgentTags.js";

// agentY's own tags (the `#name` of a canvas tag node or a remembered reference)
// are a second group of filter entries, "agent:<name>", fed by
// window.agentYViewerBridge.tags() - the same list the `#` menu offers.
const AGENT_REFRESH_MS = 3000;

export const HISTORY_TAGS = [
    { id: "red",    label: "Red",    color: "#e5484d" },
    { id: "orange", label: "Orange", color: "#f5a524" },
    { id: "yellow", label: "Yellow", color: "#e8d33f" },
    { id: "green",  label: "Green",  color: "#46c46b" },
    { id: "blue",   label: "Blue",   color: "#3e8ef7" },
    { id: "purple", label: "Purple", color: "#a15ef2" },
];
const TAG_BY_ID = Object.fromEntries(HISTORY_TAGS.map((t) => [t.id, t]));

/** "" shows everything, "any" everything tagged, "none" everything untagged,
 *  a tag id that colour only. */
const FILTER_ALL = "";
const FILTER_ANY = "any";
const FILTER_NONE = "none";

export const HistoryTagsMixin = {

    /** What a snapshot's tag is filed under: its first image. */
    historyTagKey(snapshot) {
        const o = Array.isArray(snapshot) ? snapshot[0] : snapshot;
        if (!o) return null;
        if (o.path) return `p:${String(o.path).replace(/\\/g, "/")}`;
        if (o.filename) return `f:${o.type || ""}|${o.subfolder || ""}|${o.filename}`;
        return o.url ? `u:${o.url}` : null;
    },

    historyTagOf(snapshot) {
        const k = this.historyTagKey(snapshot);
        const id = k && this.historyTags ? this.historyTags[k] : null;
        return id && TAG_BY_ID[id] ? id : null;
    },

    /** Tag (or, with null, untag) some snapshots of one tab. */
    setHistoryTag(key, indices, tagId) {
        const stack = this.history[key] || [];
        if (!this.historyTags) this.historyTags = {};
        for (const i of indices) {
            const k = this.historyTagKey(stack[i]);
            if (!k) continue;
            if (tagId && TAG_BY_ID[tagId]) this.historyTags[k] = tagId;
            else delete this.historyTags[k];
        }
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    /** Whether the footer's filter lets this snapshot through. */
    historyTagVisible(snapshot) {
        const f = this.historyTagFilter || FILTER_ALL;
        if (f === FILTER_ALL) return true;
        const tag = this.historyTagOf(snapshot);
        if (f === FILTER_ANY) return !!tag;
        if (f === FILTER_NONE) return !tag;
        const agent = agentFilterName(f);
        if (agent) return agentTagsOfSnapshot(this._agentTagIndex, snapshot).includes(agent);
        return tag === f;
    },

    /** Indices of the active tab's snapshots the filter shows, newest first. */
    historyVisibleIndices(key = this.activeTab) {
        const stack = this.history[key] || [];
        const out = [];
        stack.forEach((s, i) => { if (this.historyTagVisible(s)) out.push(i); });
        return out;
    },

    setHistoryTagFilter(value) {
        this.historyTagFilter = value === FILTER_ANY || value === FILTER_NONE || TAG_BY_ID[value]
            || agentFilterName(value) ? value : FILTER_ALL;
        this._syncHistoryTagFilter();
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    /** A signature of what tags and filter mean for this stack, for the strip's fast path. */
    historyTagSig(stack) {
        const agent = agentFilterName(this.historyTagFilter) ? agentTagIndexSig(this._agentTagIndex) : "";
        return `${this.historyTagFilter || ""}|${(stack || []).map((s) => this.historyTagOf(s) || "").join(",")}|${agent}`;
    },

    /** The tags worth saving: the ones on images history still holds. */
    historyTagsToPersist(history) {
        const out = {};
        if (!this.historyTags) return out;
        for (const stack of Object.values(history || {})) {
            for (const s of stack || []) {
                const k = this.historyTagKey(s);
                if (k && this.historyTags[k]) out[k] = this.historyTags[k];
            }
        }
        return out;
    },

    // ── The footer's filter ──────────────────────────────────────────────────

    /** The filter dropdown, made in the history footer the first time it's needed. */
    _syncHistoryTagFilter() {
        const footer = this.historyPanel && this.historyPanel.querySelector(".history-footer");
        if (!footer) return;
        let sel = footer.querySelector(".history-tag-filter");
        if (!sel) {
            const doc = footer.ownerDocument;
            sel = doc.createElement("select");
            sel.className = "history-tag-filter";
            sel.title = "Show only the snapshots with this tag";
            const opt = (value, text, color) => {
                const o = doc.createElement("option");
                o.value = value;
                o.textContent = text;
                if (color) o.style.color = color;
                sel.append(o);
            };
            opt(FILTER_ALL, "All");
            opt(FILTER_ANY, "● Tagged");
            opt(FILTER_NONE, "○ Untagged");
            for (const t of HISTORY_TAGS) opt(t.id, `● ${t.label}`, t.color);
            sel.onchange = () => this.setHistoryTagFilter(sel.value);
            // The panel's own click handler leaves compare mode; ComfyUI's key
            // handler would take the arrow keys. Neither is wanted here.
            for (const type of ["click", "mousedown", "keydown", "keyup"]) {
                sel.addEventListener(type, (e) => e.stopPropagation());
            }
            // Opening the list reads agentY's tags afresh, so a tag made a moment ago is in it.
            sel.addEventListener("mousedown", () => this.refreshAgentTags({ fresh: true }));
            footer.insertBefore(sel, footer.firstChild);
        }
        this._syncAgentTagOptions(sel);
        const f = this.historyTagFilter || FILTER_ALL;
        if (sel.value !== f) sel.value = f;
        const tag = TAG_BY_ID[f];
        sel.style.color = tag ? tag.color : "";
        sel.classList.toggle("on", f !== FILTER_ALL);
        this._syncHistoryClearTitle();
    },

    // ── agentY's tags in the filter ──────────────────────────────────────────

    /** The bridge's tag reader, or null when agentY is not on the page. */
    _agentBridgeTags() {
        const b = typeof window !== "undefined" ? window.agentYViewerBridge : null;
        return b && typeof b.tags === "function" ? b.tags : null;
    },

    /**
     * Read agentY's tags again and, when they differ from what the filter shows,
     * rebuild its group and repaint the strip. Cheap enough for a timer: the canvas
     * part is a walk of the open graphs, the remembered part is cached by the
     * bridge. Resolves to whether anything changed.
     */
    async refreshAgentTags(opts) {
        const get = this._agentBridgeTags();
        if (!get) return false;
        let list = null;
        try { list = await get(opts || {}); } catch (_) { return false; }
        if (!Array.isArray(list)) return false;
        const index = buildAgentTagIndex(list, this._agentTags);
        const sig = agentTagIndexSig(index);
        this._agentTagsLoaded = true;
        if (sig === this._agentTagSig) return false;
        this._agentTagSig = sig;
        this._agentTagIndex = index;
        // A tag that no longer exists cannot be the filter: show everything again.
        const cur = agentFilterName(this.historyTagFilter);
        if (cur && !index.names.includes(cur)) this.historyTagFilter = FILTER_ALL;
        this._syncHistoryTagFilter();
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
        return true;
    },

    /** Keep the list current while the viewer can be seen (docked, full-screen or popped out). */
    startAgentTagWatch() {
        if (this._agentTagTimer) return;
        const tick = () => {
            if (this._agentViewerVisible && !this._agentViewerVisible()) return;
            this.refreshAgentTags();
        };
        this._agentTagTimer = setInterval(tick, AGENT_REFRESH_MS);
        tick();
    },

    /** The "agentY tags" group of the dropdown, rebuilt only when its names change. */
    _syncAgentTagOptions(sel) {
        const names = this._agentTagIndex ? this._agentTagIndex.names : [];
        const cur = agentFilterName(this.historyTagFilter);
        // The saved filter may name a tag the first read has not brought back yet.
        const shown = cur && !names.includes(cur) && !this._agentTagsLoaded ? [...names, cur] : names;
        const sig = shown.join(",");
        let group = sel.querySelector("optgroup.history-agent-tags");
        if (!shown.length) { if (group) group.remove(); sel._agentSig = ""; return; }
        if (group && sel._agentSig === sig) return;
        const doc = sel.ownerDocument;
        if (!group) {
            group = doc.createElement("optgroup");
            group.className = "history-agent-tags";
            group.label = "agentY tags";
            sel.append(group);
        }
        group.replaceChildren();
        for (const n of shown) {
            const o = doc.createElement("option");
            o.value = agentFilterValue(n);
            o.textContent = `#${n}`;
            group.append(o);
        }
        sel._agentSig = sig;
    },

    /** What the filter is called in a sentence: "red", "tagged", "untagged". */
    _historyFilterWords() {
        const f = this.historyTagFilter || FILTER_ALL;
        if (f === FILTER_ANY) return "tagged";
        if (f === FILTER_NONE) return "untagged";
        if (agentFilterName(f)) return `#${agentFilterName(f)}`;
        return TAG_BY_ID[f] ? TAG_BY_ID[f].label.toLowerCase() : "";
    },

    /** The Clear button says what it will clear. */
    _syncHistoryClearTitle() {
        const btn = this.historyClearBtn;
        if (!btn) return;
        const words = this._historyFilterWords();
        if (!words || !this.activeTab) { btn.title = "Clear History"; return; }
        const n = this.historyVisibleIndices().length;
        btn.title = `Clear the ${n} ${words} snapshot${n === 1 ? "" : "s"} of this tab (the filter decides)`;
        btn.disabled = n === 0;
    },

    /**
     * The Clear button with a filter on: remove only what the filter shows, in
     * the active tab, after asking. Returns false when no filter is on, so the
     * button goes on to clear the whole history as before.
     */
    clearHistoryFiltered(dlgWin) {
        const words = this._historyFilterWords();
        const key = this.activeTab;
        if (!words || !key) return false;
        const shown = this.historyVisibleIndices(key);
        if (!shown.length) return true;
        const label = (this.tabLabels && this.tabLabels[key]) || key;
        const what = `${shown.length} ${words} snapshot${shown.length === 1 ? "" : "s"}`;
        if (!dlgWin.confirm(`Remove the ${what} from the history of ${label}?`)) return true;
        this.removeHistoryItems(key, shown);
        return true;
    },

    // ── Pieces the strip and its menu use ────────────────────────────────────

    /** The dot a tagged thumbnail wears. */
    historyTagDot(snapshot) {
        const tag = TAG_BY_ID[this.historyTagOf(snapshot)];
        if (!tag) return null;
        const dot = document.createElement("span");
        dot.className = "history-tag-dot";
        dot.style.background = tag.color;
        dot.title = `Tagged ${tag.label.toLowerCase()}`;
        return dot;
    },

    /** The context menu's row of colours, acting on `indices` of tab `key`. */
    historyTagMenuRow(doc, menu, key, indices) {
        const row = doc.createElement("div");
        row.className = "thumb-ctx-tags";
        const current = indices.length === 1 ? this.historyTagOf((this.history[key] || [])[indices[0]]) : null;
        const pick = (id) => (e) => { e.stopPropagation(); menu.remove(); this.setHistoryTag(key, indices, id); };
        for (const t of HISTORY_TAGS) {
            const b = doc.createElement("span");
            b.className = "thumb-ctx-tag" + (current === t.id ? " sel" : "");
            b.style.background = t.color;
            b.title = indices.length > 1 ? `Tag ${indices.length} ${t.label.toLowerCase()}` : `Tag ${t.label.toLowerCase()}`;
            b.onclick = pick(t.id);
            row.append(b);
        }
        const none = doc.createElement("span");
        none.className = "thumb-ctx-tag none";
        none.textContent = "✕";
        none.title = indices.length > 1 ? `Remove the tags of ${indices.length}` : "Remove the tag";
        none.onclick = pick(null);
        row.append(none);
        return row;
    },
};
