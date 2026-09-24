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

export const HISTORY_TAGS = [
    { id: "red",    label: "Red",    color: "#e5484d" },
    { id: "orange", label: "Orange", color: "#f5a524" },
    { id: "yellow", label: "Yellow", color: "#e8d33f" },
    { id: "green",  label: "Green",  color: "#46c46b" },
    { id: "blue",   label: "Blue",   color: "#3e8ef7" },
    { id: "purple", label: "Purple", color: "#a15ef2" },
];
const TAG_BY_ID = Object.fromEntries(HISTORY_TAGS.map((t) => [t.id, t]));

/** "" shows everything, "any" everything tagged, a tag id that colour only. */
const FILTER_ALL = "";
const FILTER_ANY = "any";

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
        return f === FILTER_ANY ? !!tag : tag === f;
    },

    /** Indices of the active tab's snapshots the filter shows, newest first. */
    historyVisibleIndices(key = this.activeTab) {
        const stack = this.history[key] || [];
        const out = [];
        stack.forEach((s, i) => { if (this.historyTagVisible(s)) out.push(i); });
        return out;
    },

    setHistoryTagFilter(value) {
        this.historyTagFilter = value === FILTER_ANY || TAG_BY_ID[value] ? value : FILTER_ALL;
        this._syncHistoryTagFilter();
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    /** A signature of what tags and filter mean for this stack, for the strip's fast path. */
    historyTagSig(stack) {
        return `${this.historyTagFilter || ""}|${(stack || []).map((s) => this.historyTagOf(s) || "").join(",")}`;
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
            for (const t of HISTORY_TAGS) opt(t.id, `● ${t.label}`, t.color);
            sel.onchange = () => this.setHistoryTagFilter(sel.value);
            // The panel's own click handler leaves compare mode; ComfyUI's key
            // handler would take the arrow keys. Neither is wanted here.
            for (const type of ["click", "mousedown", "keydown", "keyup"]) {
                sel.addEventListener(type, (e) => e.stopPropagation());
            }
            footer.insertBefore(sel, footer.firstChild);
        }
        const f = this.historyTagFilter || FILTER_ALL;
        if (sel.value !== f) sel.value = f;
        const tag = TAG_BY_ID[f];
        sel.style.color = tag ? tag.color : "";
        sel.classList.toggle("on", f !== FILTER_ALL);
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
