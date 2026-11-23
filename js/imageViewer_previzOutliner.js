// imageViewer_previzOutliner.js
// The 3D Outliner's services: the filter of kinds shown, the search, folding, the selection over the rows on
// screen, and the row-drawing helpers the USD Contents rows share (imageViewer_previzUsd.js). The tree itself
// is built and drawn per instance (imageViewer_previzOutlinerInstance.js): the first one keeps its state on
// the viewer (st === this, so this._olFilter / this._previzCollapsed stay where every older caller reads them),
// every further one passes its own state object. What the rows are is decided in imageViewer_outlinerData.js
// (pure, tested under node). Its own design (clean-room): no code or assets of another program's outliner.
import * as S from "./imageViewer_scene3d.js";
import {
    OUTLINER_KINDS, OUTLINER_STATES, cleanOutlinerFilter, outlinerFilterIsOff,
    outlinerRows, searchNeedle, matchRange,
} from "./imageViewer_outlinerData.js";
import { outlinerIcon } from "./imageViewer_outlinerIcons.js";

const FILTER_KEY = "imageviewer.viewer.outlinerFilter";
const INDENT_PX = 14;

export const PrevizOutlinerMixin = {
    // ── The filter, kept per viewer ─────────────────────────────────────────

    /** The filter now: { hidden: [kind keys], state }. `st` is the view whose filter is asked for. */
    previzOutlinerFilter(st = this) {
        if (!st._olFilter) {
            let raw = null;
            try { raw = JSON.parse(this._viewerWindow().localStorage.getItem(FILTER_KEY) || "null"); } catch (_) {}
            st._olFilter = cleanOutlinerFilter(raw);
        }
        return st._olFilter;
    },

    /** Change the filter (a patch of { hidden, state }) and redraw. */
    previzSetOutlinerFilter(patch, st = this) {
        st._olFilter = cleanOutlinerFilter({ ...this.previzOutlinerFilter(st), ...(patch || {}) });
        try { this._viewerWindow().localStorage.setItem(FILTER_KEY, JSON.stringify(st._olFilter)); } catch (_) {}
        this._olSyncHead(st);
        this._previzRenderPanel();
    },

    /** Show or hide one kind of row. */
    previzOutlinerShowKind(key, on, st = this) {
        const hidden = new Set(this.previzOutlinerFilter(st).hidden);
        if (on) hidden.delete(key); else hidden.add(key);
        this.previzSetOutlinerFilter({ hidden: [...hidden] }, st);
    },

    /** The search field's words; "" clears it. */
    previzOutlinerSearch(text, st = this) {
        st._olQuery = String(text || "");
        const ui = st._previzUI;
        if (ui && ui.search && ui.search.value !== st._olQuery) ui.search.value = st._olQuery;
        this._olSyncHead(st);
        this._previzRenderPanel();
    },

    /** Unfold (open = true) or fold every row of the tree, skeletons included. */
    previzOutlinerFoldAll(open, st = this) {
        const scene = this.previzScene();
        const collapsed = st._previzCollapsed || (st._previzCollapsed = new Set());
        const skel = st._previzSkelOpen || (st._previzSkelOpen = new Set());
        for (const it of (scene && scene.items) || []) {
            if (!it) continue;
            if (open) collapsed.delete(it.id); else collapsed.add(it.id);
            if (it.kind === "model") {
                if (open) skel.add(`${it.id}:skeleton`); else skel.delete(`${it.id}:skeleton`);
            }
        }
        if (open && st._previzSkelClosed) st._previzSkelClosed.clear();
        this._previzRenderPanel();
    },

    /** The clear button and the lit funnel follow the search and the filter. */
    _olSyncHead(st = this) {
        const ui = st._previzUI;
        if (!ui || !ui.head) return;
        ui.clear.style.visibility = (st._olQuery || "").length ? "visible" : "hidden";
        const off = outlinerFilterIsOff(this.previzOutlinerFilter(st));
        ui.filter.classList.toggle("on", !off);
        ui.filter.title = off ? "Filter: which kinds of items the Outliner shows"
            : "Filter (some rows are hidden): which kinds of items the Outliner shows";
    },

    /** Select every item whose name (or a bone's) matches the search; `add` keeps the selection. */
    previzOutlinerSelectMatches(add = false, st = this) {
        const ids = this._olRows(st).filter((r) => !r.context).map((r) => r.item.id);
        if (!ids.length) return 0;
        if (this.previzSelectMany) this.previzSelectMany(ids, add ? "add" : "replace");
        return ids.length;
    },

    // ── The filter menu ─────────────────────────────────────────────────────
    // One at a time per viewer, hung off the panel's container; it edits the filter of the view that opened it.

    _olToggleFilterMenu(anchor, st = this) {
        if (this._olMenu) { this._olCloseFilterMenu(); return; }
        const host = this._previzMenuHost();
        if (!host) return;
        if (this._previzCloseAddMenu) this._previzCloseAddMenu();
        const doc = host.ownerDocument;
        const menu = doc.createElement("div");
        menu.className = "ol-menu";
        const fill = () => {
            menu.replaceChildren();
            const f = this.previzOutlinerFilter(st);
            const hidden = new Set(f.hidden);
            const title = (t) => Object.assign(doc.createElement("div"), { className: "ol-menu-title", textContent: t });
            menu.append(title("Show"));
            const grid = doc.createElement("div");
            grid.className = "ol-kinds";
            for (const k of OUTLINER_KINDS) {
                const b = doc.createElement("button");
                b.type = "button";
                b.className = "ol-kind-toggle" + (hidden.has(k.key) ? "" : " on");
                b.dataset.kind = k.key;
                b.setAttribute("aria-pressed", hidden.has(k.key) ? "false" : "true");
                b.title = (hidden.has(k.key) ? "Show " : "Hide ") + k.label.toLowerCase()
                    + (k.key === "bones" ? "" : "\n(their children still show, a level up)");
                const ic = doc.createElement("span");
                ic.className = "ol-kind";
                ic.dataset.kind = k.key;
                ic.append(outlinerIcon(doc, k.key));
                b.append(ic, Object.assign(doc.createElement("span"), { textContent: k.label }));
                b.onclick = (e) => { e.stopPropagation(); this.previzOutlinerShowKind(k.key, hidden.has(k.key), st); fill(); };
                grid.append(b);
            }
            menu.append(grid);
            menu.append(title("Rows"));
            const seg = doc.createElement("div");
            seg.className = "ol-seg";
            for (const s of OUTLINER_STATES) {
                const b = doc.createElement("button");
                b.type = "button";
                b.className = "ol-seg-btn" + (f.state === s.key ? " on" : "");
                b.dataset.state = s.key;
                b.textContent = s.label;
                b.title = s.key === "all" ? "Every row" : `Only ${s.label.toLowerCase()} items (and what they are in)`;
                b.onclick = (e) => { e.stopPropagation(); this.previzSetOutlinerFilter({ state: s.key }, st); fill(); };
                seg.append(b);
            }
            menu.append(seg);
            const foot = doc.createElement("div");
            foot.className = "ol-menu-foot";
            const act = (icon, label, run, cls = "") => {
                const b = doc.createElement("button");
                b.type = "button";
                b.className = "ol-menu-act" + (cls ? " " + cls : "");
                if (icon) b.append(outlinerIcon(doc, icon));
                b.append(Object.assign(doc.createElement("span"), { textContent: label }));
                b.onclick = (e) => { e.stopPropagation(); run(); fill(); };
                return b;
            };
            foot.append(
                act("unfoldAll", "Expand all", () => this.previzOutlinerFoldAll(true, st)),
                act("foldAll", "Collapse all", () => this.previzOutlinerFoldAll(false, st)),
                act("", "Reset", () => this.previzSetOutlinerFilter({ hidden: [], state: "all" }, st), "reset"),
            );
            menu.append(foot);
        };
        fill();
        host.append(menu);
        // Under the button, its right edge on the button's, held inside the host.
        const h = host.getBoundingClientRect(), a = anchor.getBoundingClientRect();
        const w = menu.offsetWidth;
        const left = Math.max(4, Math.min(a.right - h.left - w, h.width - w - 4));
        menu.style.left = `${left}px`;
        menu.style.top = `${a.bottom - h.top + 4}px`;
        anchor.classList.add("open");
        const away = (e) => {
            if (e.type === "keydown") { if (e.key === "Escape") this._olCloseFilterMenu(); return; }
            const path = e.composedPath ? e.composedPath() : [];
            if (path.includes(menu) || path.includes(anchor)) return;
            this._olCloseFilterMenu();
        };
        doc.addEventListener("pointerdown", away, true);
        doc.addEventListener("keydown", away, true);
        this._olMenu = { menu, anchor, doc, away, st };
    },

    _olCloseFilterMenu() {
        const m = this._olMenu;
        if (!m) return;
        m.doc.removeEventListener("pointerdown", m.away, true);
        m.doc.removeEventListener("keydown", m.away, true);
        m.menu.remove();
        m.anchor.classList.remove("open");
        this._olMenu = null;
    },

    // ── The rows ────────────────────────────────────────────────────────────

    /** The rows as the search and the filter stand. */
    _olRows(st = this) {
        const scene = this.previzScene();
        if (!scene) return [];
        return outlinerRows(scene, {
            needle: searchNeedle(st._olQuery),
            filter: this.previzOutlinerFilter(st),
            collapsed: st._previzCollapsed || (st._previzCollapsed = new Set()),
            isSelected: (id) => this.previzIsSelected(id),
            isAnimated: (it) => S.allKeyframeFrames(it).length > 0,
            bonesOf: (it) => (it.kind === "model" ? this._previzBonesOf(it.id).map((b) => b.name) : []),
            // The prims inside a model's asset (imageViewer_previzUsd.js).
            contentsOf: (it) => (it.kind === "model" && this.previzUsdContentNames ? this.previzUsdContentNames(it) : []),
            hasContents: (it) => (it.kind === "model" && this.previzUsdHasContents ? this.previzUsdHasContents(it) : false),
        });
    },

    /**
     * A click on a row, as a file list takes it: plain selects that one,
     * Ctrl toggles it, Shift selects every visible row from the last row
     * clicked without Shift (the anchor) to this one, Ctrl+Shift adds that
     * range to the selection. The clicked row becomes the primary.
     */
    _olClickSelect(id, e, st = this) {
        const ctrl = e.ctrlKey || e.metaKey;
        if (e.shiftKey && st._olAnchor && st._olAnchor !== id) {
            const ids = this._olRangeIds(st._olAnchor, id, st);
            if (ids) { this.previzSelectMany(ids, ctrl ? "add" : "replace", { primary: id }); return; }
        }
        st._olAnchor = id;
        this.previzSelect(id, { add: ctrl || e.shiftKey });
    },

    /** The ids of the visible rows from `a` to `b`, in order on screen; null if either is not shown. */
    _olRangeIds(a, b, st = this) {
        const ui = st._previzUI;
        const list = ui && ui.list;
        if (!list) return null;
        const ids = [...list.querySelectorAll(".ol-row[data-select-id]")].map((r) => r.dataset.selectId);
        const i = ids.indexOf(a), j = ids.indexOf(b);
        if (i < 0 || j < 0) return null;
        return [...new Set(ids.slice(Math.min(i, j), Math.max(i, j) + 1))];
    },

    // ── The row-drawing helpers (shared with the USD Contents rows) ─────────

    /** The name, with the part the search found marked. */
    _olName(doc, el, text, needle) {
        const m = matchRange(text, needle);
        if (!m) { el.textContent = text; return; }
        el.replaceChildren(
            doc.createTextNode(text.slice(0, m[0])),
            Object.assign(doc.createElement("mark"), { className: "ol-hit", textContent: text.slice(m[0], m[1]) }),
            doc.createTextNode(text.slice(m[1])));
    },

    /** The indent: one guide line per level. */
    _olIndent(doc, depth) {
        const ind = doc.createElement("span");
        ind.className = "ol-indent";
        ind.style.width = `${depth * INDENT_PX}px`;
        return ind;
    },

    /** The fold arrow: a chevron that turns; `fold` is null for a row with nothing below it. */
    _olTwisty(doc, fold) {
        const tw = doc.createElement("span");
        tw.className = "previz-twisty" + (fold ? (fold.open ? " open" : "") : " empty");
        if (fold) {
            tw.append(outlinerIcon(doc, "chevron"));
            tw.title = (fold.open ? "Fold this away" : "Show what is inside") + "\nShift+click: the whole branch";
            tw.setAttribute("role", "button");
            tw.setAttribute("aria-expanded", fold.open ? "true" : "false");
            tw.onclick = (e) => { e.stopPropagation(); fold.toggle(e.shiftKey); this._previzRenderPanel(); };
            // A double-click on the arrow must not rename the row.
            tw.ondblclick = (e) => e.stopPropagation();
        }
        return tw;
    },

    /** A small icon button at the row's right. */
    _olRowBtn(doc, cls, icon, title, run) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = cls;
        b.title = title;
        b.append(outlinerIcon(doc, icon));
        b.onclick = (e) => { e.stopPropagation(); run(e); };
        b.ondragstart = (e) => e.preventDefault();
        return b;
    },

    /** A loaded model's bones as [{ name, parent }], parents first; [] without a skeleton. */
    _previzBonesOf(modelId) {
        const view = this._model3d;
        const e = view && view._entries && view._entries.get(modelId);
        if (!e || !e.bones || !e.bones.size) return [];
        const names = e.boneOrder || [...e.bones.keys()];
        return names.map((n) => {
            const b = e.bones.get(n);
            return { name: n, parent: b && b.parent && b.parent.isBone ? b.parent.name : null };
        });
    },
};