// imageViewer_previzOutliner.js
// The 3D Outliner's tree: a search field, a filter of the kinds shown, fold
// arrows, and the rows themselves (a mixin onto the panel, PrevizOutlinerMixin,
// assigned onto PrevizMixin at the end of imageViewer_mixinPreviz.js).
// What the rows are is decided in imageViewer_outlinerData.js (pure, tested
// under node); this file only draws them and answers the pointer.
// Its own design (clean-room): no code or assets of another program's outliner.
import * as S from "./imageViewer_scene3d.js";
import * as L from "./imageViewer_sceneLayers.js";
import {
    OUTLINER_KINDS, OUTLINER_STATES, cleanOutlinerFilter, outlinerFilterIsOff,
    outlinerKindOf, outlinerRows, boneRows, searchNeedle, matchRange, descendantIds,
} from "./imageViewer_outlinerData.js";
import { outlinerIcon } from "./imageViewer_outlinerIcons.js";

const FILTER_KEY = "imageviewer.viewer.outlinerFilter";
const INDENT_PX = 14;

export const PrevizOutlinerMixin = {
    // ── The filter, kept per viewer ─────────────────────────────────────────

    /** The filter now: { hidden: [kind keys], state }. */
    previzOutlinerFilter() {
        if (!this._olFilter) {
            let raw = null;
            try { raw = JSON.parse(this._viewerWindow().localStorage.getItem(FILTER_KEY) || "null"); } catch (_) {}
            this._olFilter = cleanOutlinerFilter(raw);
        }
        return this._olFilter;
    },

    /** Change the filter (a patch of { hidden, state }) and redraw. */
    previzSetOutlinerFilter(patch) {
        this._olFilter = cleanOutlinerFilter({ ...this.previzOutlinerFilter(), ...(patch || {}) });
        try { this._viewerWindow().localStorage.setItem(FILTER_KEY, JSON.stringify(this._olFilter)); } catch (_) {}
        this._olSyncHead();
        this._previzRenderPanel();
    },

    /** Show or hide one kind of row. */
    previzOutlinerShowKind(key, on) {
        const hidden = new Set(this.previzOutlinerFilter().hidden);
        if (on) hidden.delete(key); else hidden.add(key);
        this.previzSetOutlinerFilter({ hidden: [...hidden] });
    },

    /** The search field's words; "" clears it. */
    previzOutlinerSearch(text) {
        this._olQuery = String(text || "");
        const ui = this._previzUI;
        if (ui && ui.search && ui.search.value !== this._olQuery) ui.search.value = this._olQuery;
        this._olSyncHead();
        this._previzRenderPanel();
    },

    /** Unfold (open = true) or fold every row of the tree, skeletons included. */
    previzOutlinerFoldAll(open) {
        const scene = this.previzScene();
        const collapsed = this._previzCollapsed || (this._previzCollapsed = new Set());
        const skel = this._previzSkelOpen || (this._previzSkelOpen = new Set());
        for (const it of (scene && scene.items) || []) {
            if (!it) continue;
            if (open) collapsed.delete(it.id); else collapsed.add(it.id);
            if (it.kind === "model") {
                if (open) skel.add(`${it.id}:skeleton`); else skel.delete(`${it.id}:skeleton`);
            }
        }
        if (open && this._previzSkelClosed) this._previzSkelClosed.clear();
        this._previzRenderPanel();
    },

    // ── The head: search and filter ─────────────────────────────────────────

    /** The search field and the filter button, above the tree (from _previzBuildPanel). */
    _olBuildHead(doc) {
        const head = doc.createElement("div");
        head.className = "ol-head";
        const box = doc.createElement("label");
        box.className = "ol-searchbox";
        box.append(outlinerIcon(doc, "search", "ol-searchicon"));
        const search = doc.createElement("input");
        search.type = "search";
        search.className = "ol-search";
        search.placeholder = "Search";
        search.spellcheck = false;
        search.autocomplete = "off";
        search.title = "Find items and bones by name.\nEnter selects what matches, Esc clears.";
        search.value = this._olQuery || "";
        search.oninput = () => this.previzOutlinerSearch(search.value);
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault(); e.stopPropagation();
                if (search.value) this.previzOutlinerSearch("");
                else search.blur();
            } else if (e.key === "Enter") {
                e.preventDefault(); e.stopPropagation();
                this.previzOutlinerSelectMatches(e.shiftKey || e.ctrlKey || e.metaKey);
            }
        });
        const clear = doc.createElement("button");
        clear.className = "ol-clear";
        clear.type = "button";
        clear.title = "Clear the search";
        clear.append(outlinerIcon(doc, "clear"));
        clear.onclick = (e) => { e.preventDefault(); this.previzOutlinerSearch(""); search.focus(); };
        box.append(search, clear);

        const filter = doc.createElement("button");
        filter.className = "ol-filter-btn";
        filter.type = "button";
        filter.title = "Filter: which kinds of items the Outliner shows";
        filter.append(outlinerIcon(doc, "filter"));
        filter.onclick = (e) => { e.stopPropagation(); this._olToggleFilterMenu(filter); };
        head.append(box, filter);
        return { head, search, clear, filter };
    },

    /** The clear button and the lit funnel follow the search and the filter. */
    _olSyncHead() {
        const ui = this._previzUI;
        if (!ui || !ui.head) return;
        ui.clear.style.visibility = (this._olQuery || "").length ? "visible" : "hidden";
        const off = outlinerFilterIsOff(this.previzOutlinerFilter());
        ui.filter.classList.toggle("on", !off);
        ui.filter.title = off ? "Filter: which kinds of items the Outliner shows"
            : "Filter (some rows are hidden): which kinds of items the Outliner shows";
    },

    /** Select every item whose name (or a bone's) matches the search; `add` keeps the selection. */
    previzOutlinerSelectMatches(add = false) {
        const ids = this._olRows().filter((r) => !r.context).map((r) => r.item.id);
        if (!ids.length) return 0;
        if (this.previzSelectMany) this.previzSelectMany(ids, add ? "add" : "replace");
        return ids.length;
    },

    // ── The filter menu ─────────────────────────────────────────────────────

    _olToggleFilterMenu(anchor) {
        if (this._olMenu) { this._olCloseFilterMenu(); return; }
        const host = this._previzMenuHost();
        if (!host) return;
        if (this._previzCloseAddMenu) this._previzCloseAddMenu();
        const doc = host.ownerDocument;
        const menu = doc.createElement("div");
        menu.className = "ol-menu";
        const fill = () => {
            menu.replaceChildren();
            const f = this.previzOutlinerFilter();
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
                b.onclick = (e) => { e.stopPropagation(); this.previzOutlinerShowKind(k.key, hidden.has(k.key)); fill(); };
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
                b.onclick = (e) => { e.stopPropagation(); this.previzSetOutlinerFilter({ state: s.key }); fill(); };
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
                act("unfoldAll", "Expand all", () => this.previzOutlinerFoldAll(true)),
                act("foldAll", "Collapse all", () => this.previzOutlinerFoldAll(false)),
                act("", "Reset", () => this.previzSetOutlinerFilter({ hidden: [], state: "all" }), "reset"),
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
        this._olMenu = { menu, anchor, doc, away };
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

    // ── The tree ────────────────────────────────────────────────────────────

    /** The rows as the search and the filter stand. */
    _olRows() {
        const scene = this.previzScene();
        if (!scene) return [];
        return outlinerRows(scene, {
            needle: searchNeedle(this._olQuery),
            filter: this.previzOutlinerFilter(),
            collapsed: this._previzCollapsed || (this._previzCollapsed = new Set()),
            isSelected: (id) => this.previzIsSelected(id),
            isAnimated: (it) => S.allKeyframeFrames(it).length > 0,
            bonesOf: (it) => (it.kind === "model" ? this._previzBonesOf(it.id).map((b) => b.name) : []),
        });
    },

    /** Draw the tree into ui.list (from _previzRenderPanel). */
    _olDrawTree(ui, scene, doc) {
        const scroll = ui.list.scrollTop;
        ui.list.innerHTML = "";
        const rows = this._olRows();
        const needle = searchNeedle(this._olQuery);
        const hiddenBones = this.previzOutlinerFilter().hidden.includes("bones");
        rows.forEach((r) => {
            const row = this._previzOutlinerRow(r.item, r.depth, doc, scene, r, needle);
            ui.list.append(row);
            if (r.open && r.item.kind === "model" && !hiddenBones) this._previzSkeletonRows(r.item, r.depth + 1, doc, scene, ui.list, needle);
        });
        if (!rows.length) {
            const empty = doc.createElement("div");
            empty.className = "previz-empty";
            if (!scene.items.length) empty.textContent = "Drop a model in, or use File › Import Model…";
            else if (needle) empty.textContent = `Nothing is called “${this._olQuery.trim()}”.`;
            else empty.textContent = "The filter hides everything.";
            ui.list.append(empty);
        }
        // Stripes by place on screen, skeleton rows counted.
        let n = 0;
        for (const row of ui.list.children) if (row.classList.contains("previz-item")) row.classList.toggle("odd", n++ % 2 === 1);
        ui.list.scrollTop = scroll;
        this._olSyncHead();
    },

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

    /**
     * One row of the outliner.
     *
     * Dragging a row onto another makes it a child of that one; dropping it on
     * the empty space below the tree puts it back at the top. That is the whole
     * grouping interface — there is no "add to group" command, because the
     * thing you want to say is where it goes.
     */
    _previzOutlinerRow(item, depth, doc, scene, info = null, needle = "") {
        const collapsed = this._previzCollapsed || (this._previzCollapsed = new Set());
        const row = doc.createElement("div");
        row.className = "previz-item ol-row"
            + (this.previzIsSelected(item.id) ? " selected" : "")
            + (item.id === this._previzSelection ? " primary" : "")
            + (info && info.context ? " context" : "")
            + (item.visible === false ? " hidden-item" : "");
        row.dataset.itemId = item.id;
        row.dataset.kind = outlinerKindOf(item);
        row.draggable = true;
        row.onclick = (e) => {
            // A double-click is timed by hand: the first click re-renders the
            // tree, so the second lands on a new row and the browser never
            // sees the two as one dblclick.
            const now = Date.now();
            const last = this._previzLastClick;
            this._previzLastClick = { id: item.id, t: now };
            const add = e.shiftKey || e.ctrlKey || e.metaKey;
            if (!add && last && last.id === item.id && now - last.t < 400) {
                this._previzLastClick = null;
                this.previzBeginRename(item.id);
                return;
            }
            this.previzSelect(item.id, { add });
        };
        row.oncontextmenu = (e) => this._previzItemMenu(item.id, e);

        const hasKids = info ? info.hasKids
            : (S.childrenOf(scene, item.id).length || (item.kind === "model" && this._previzBonesOf(item.id).length));
        const open = info ? info.open : !collapsed.has(item.id);
        const twisty = this._olTwisty(doc, hasKids ? {
            open,
            toggle: (branch) => {
                const fold = !collapsed.has(item.id);
                const ids = branch ? [item.id, ...descendantIds(scene, item.id)] : [item.id];
                for (const id of ids) { if (fold) collapsed.add(id); else collapsed.delete(id); }
                if (branch && item.kind === "model") {
                    const skel = this._previzSkelOpen || (this._previzSkelOpen = new Set());
                    if (fold) skel.delete(`${item.id}:skeleton`); else skel.add(`${item.id}:skeleton`);
                }
            },
        } : null);

        const kind = doc.createElement("span");
        kind.className = "ol-kind";
        kind.dataset.kind = outlinerKindOf(item);
        kind.append(outlinerIcon(doc, outlinerKindOf(item)));
        kind.title = (OUTLINER_KINDS.find((k) => k.key === outlinerKindOf(item)) || {}).label || item.kind;

        const name = doc.createElement("span");
        name.className = "previz-name";
        this._olName(doc, name, item.name, needle);
        name.title = item.kind === "model" && item.src ? (item.src.path || item.src.filename || "") : item.name;
        if (item.ref) {
            const ref = L.referenceById(scene, item.ref.id);
            name.classList.add("ref");
            name.title = `${item.name}\nReferenced from ${ref ? ref.path : "a scene file"}`;
        }

        row.append(this._olIndent(doc, depth), twisty, kind, name);
        if (this._previzRenaming && this._previzRenaming.id === item.id) {
            this._previzMountRename(row, name, item);
        }
        // The right-hand side: marks first, then the buttons, the eye last.
        const end = doc.createElement("span");
        end.className = "ol-end";
        const failed = this._model3d ? this._model3d.itemError(item.id) : "";
        if (failed) {
            const warn = doc.createElement("span");
            warn.className = "previz-warn";
            warn.textContent = "!";
            warn.title = `This file could not be loaded:\n${failed}`;
            end.append(warn);
        }
        const keys = S.allKeyframeFrames(item).length;
        if (keys) {
            const dot = doc.createElement("span");
            dot.className = "ol-keys";
            dot.title = `${keys} keyframes`;
            end.append(dot);
        }
        // Its display layer: a swatch, with T or R when the layer says template or reference.
        const layer = L.layerOf(scene, item.id);
        if (layer) {
            const tag = doc.createElement("span");
            tag.className = `previz-layer ${layer.mode}` + (layer.visible ? "" : " hidden");
            tag.textContent = L.MODE_LABEL[layer.mode];
            if (layer.color) tag.style.setProperty("--layer", layer.color);
            tag.title = `On display layer ${layer.name}` + (layer.mode !== "normal" ? ` (${layer.mode})` : "")
                + (layer.visible ? "" : ", hidden");
            end.append(tag);
        }
        if (item.kind === "camera") {
            const on = scene.activeCamera === item.id;
            const look = this._olRowBtn(doc, "previz-look" + (on ? " active" : ""), "look",
                on ? "Back to the free view" : "Look through this camera", () => this.previzLookThrough(item.id));
            end.append(look);
        }
        const off = item.visible === false;
        const eye = this._olRowBtn(doc, "previz-eye" + (off ? " off" : ""), off ? "eyeOff" : "eye",
            item.kind === "group" ? "Show / hide the group and what is in it" : "Show / hide",
            () => { item.visible = item.visible === false; this.previzChanged(); });
        end.append(eye);
        row.append(end);

        row.ondragstart = (e) => {
            // Dragging one of a selection takes the selection along; any other
            // row goes alone. Not selected here: that would redraw the tree
            // and pull this row out from under the drag that just started.
            this._previzDragItem = item.id;
            row.classList.add("dragging");
            try { e.dataTransfer.setData("text/plain", item.name); } catch (_) {}
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        };
        row.ondragend = () => {
            this._previzDragItem = null;
            row.classList.remove("dragging");
            this._previzClearDropMarks();
        };
        row.ondragover = (e) => {
            if (!this._previzDragItem) return;
            const drop = this._previzDropFor(row, item, e, scene);
            if (!drop) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            this._previzClearDropMarks();
            row.classList.add(`drop-${drop.zone}`);
        };
        row.ondragleave = () => row.classList.remove("drop-into", "drop-before", "drop-after");
        row.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const drop = this._previzDragItem ? this._previzDropFor(row, item, e, scene) : null;
            this._previzClearDropMarks();
            if (drop) this.previzMoveItems(this._previzDragIds(), drop.parent, drop.before);
        };
        return row;
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

    /**
     * The skeleton under a model in the outliner: one "Skeleton" row (folded at
     * first) and its bones as a tree. Bones are the file's, not scene items, so
     * the rows only show them; a click selects the bone's FK control when the
     * character is rigged, else the model. A search opens it at the bones that match.
     */
    _previzSkeletonRows(model, depth, doc, scene, list, needle = "") {
        const bones = this._previzBonesOf(model.id);
        if (!bones.length) return;
        const open = this._previzSkelOpen || (this._previzSkelOpen = new Set());
        const fk = new Map();
        for (const it of scene.items) {
            if (it.kind === "control" && it.control && it.control.model === model.id && it.control.type === "fk") fk.set(it.control.bone, it);
        }
        // The Skeleton row starts folded (open set); bones start unfolded (closed set).
        const closed = this._previzSkelClosed || (this._previzSkelClosed = new Set());
        const rowFor = (label, d, title, onclick, fold, opts = {}) => {
            const row = doc.createElement("div");
            row.className = "previz-item previz-bone ol-row" + (opts.context ? " context" : "")
                + (opts.selected ? " selected" : "");
            row.dataset.kind = "bones";
            const name = doc.createElement("span");
            name.className = "previz-name";
            this._olName(doc, name, label, opts.needle || "");
            name.title = title;
            const kind = doc.createElement("span");
            kind.className = "ol-kind" + (opts.joint ? " joint" : "");
            kind.dataset.kind = "bones";
            if (!opts.joint) kind.append(outlinerIcon(doc, "bones"));
            row.append(this._olIndent(doc, d), this._olTwisty(doc, fold), kind, name);
            row.onclick = onclick;
            list.append(row);
        };
        const skelKey = `${model.id}:skeleton`;
        const searching = !!needle && bones.some((b) => matchRange(b.name, needle));
        const isOpen = searching || open.has(skelKey);
        rowFor(`Skeleton (${bones.length} bones)`, depth,
            fk.size ? "The file's bones; click one to select its control." : "The file's bones. Rig → Add controls to animate them.",
            () => this.previzSelect(model.id),
            { open: isOpen, toggle: () => (open.has(skelKey) ? open.delete(skelKey) : open.add(skelKey)) },
            { context: searching });
        if (!isOpen) return;
        for (const b of boneRows(bones, { needle: searching ? needle : "", isClosed: (n) => closed.has(`${model.id}:bone:${n}`) })) {
            const key = `${model.id}:bone:${b.name}`;
            const ctrl = fk.get(b.name);
            rowFor(b.name, depth + 1 + b.depth, ctrl ? `${b.name}: selects ${ctrl.name}` : b.name,
                (e) => this.previzSelect(ctrl ? ctrl.id : model.id, { add: e.shiftKey || e.ctrlKey || e.metaKey }),
                b.hasKids && { open: b.open, toggle: () => (closed.has(key) ? closed.delete(key) : closed.add(key)) },
                { joint: true, needle: searching ? needle : "", context: b.context, selected: !!ctrl && this.previzIsSelected(ctrl.id) });
        }
    },
};
