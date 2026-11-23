// imageViewer_previzOutlinerInstance.js
// One Outliner view: the 3D scene's tree, a search field and a filter of the kinds shown. The panel comes in
// instances (Sebastian 2026-11-23): the first one is the dock's "previz" panel and keeps its state on the
// viewer (st === viewer, so this._previzUI / this._previzCollapsed stay where every older caller reads them);
// every further one is made here with a state object of its own. The dock registers the maker
// (PrevizMixin._previzOutlinerRegisterMaker) and places the element.
//
// The scene and the selection are the viewer's, shared by every instance: a click on a row selects in the
// scene from any of them, and the menus are the viewer's one-at-a-time service (_previzOpenMenu). What is an
// instance's own is its view of the tree — the search text, the filter, the folded branches (items, skeletons
// and USD contents), the rename under way, the shift-range anchor and the scroll.
//
// What the rows are is decided in imageViewer_outlinerData.js (pure, tested under node); this file only draws
// them and answers the pointer. Its own design (clean-room): no code or assets of another program's outliner.
import * as S from "./imageViewer_scene3d.js";
import * as L from "./imageViewer_sceneLayers.js";
import {
    OUTLINER_KINDS, cleanOutlinerFilter, outlinerKindOf, boneRows, searchNeedle, matchRange, descendantIds,
} from "./imageViewer_outlinerData.js";
import { outlinerIcon } from "./imageViewer_outlinerIcons.js";

/**
 * Make an Outliner view in `host`. `st` holds what this view keeps of its own (the viewer itself for the first
 * one, a fresh object for every further one); `saved` is what a layout carried for it, if anything.
 * Returns the instance the dock keeps: { el, ui, build, refresh, wake, save, dispose }.
 */
export function createOutlinerInstance(v, host, st, saved) {
    let wantScroll = saved && Number.isFinite(saved.scroll) ? saved.scroll : null;
    if (saved) {
        st._olQuery = typeof saved.query === "string" ? saved.query : "";
        if (saved.filter) st._olFilter = cleanOutlinerFilter(saved.filter);
        st._previzCollapsed = new Set(saved.collapsed || []);
        st._previzSkelOpen = new Set(saved.skelOpen || []);
        st._previzSkelClosed = new Set(saved.skelClosed || []);
        st._previzContentsOpen = new Set(saved.contentsOpen || []);
        st._previzContentsClosed = new Set(saved.contentsClosed || []);
    }
    st._olQuery = st._olQuery || "";
    st._previzCollapsed = st._previzCollapsed || new Set();
    st._previzSkelOpen = st._previzSkelOpen || new Set();
    st._previzSkelClosed = st._previzSkelClosed || new Set();
    st._previzContentsOpen = st._previzContentsOpen || new Set();
    st._previzContentsClosed = st._previzContentsClosed || new Set();
    st._olAnchor = st._olAnchor ?? null;
    st._previzLastClick = st._previzLastClick ?? null;

    build();

    /** The body, as classes only (an instance must not repeat the markup's ids). */
    function build() {
        const doc = host.ownerDocument;
        const old = host.querySelector(":scope > .previz-body .previz-list");
        if (old && wantScroll == null) wantScroll = old.scrollTop;
        const root = doc.createElement("div");
        root.className = "previz-body";

        // Everything that used to be a button here is in the 3D canvas's menu bar now
        // (imageViewer_previzMenuBar.js): the Outliner is the tree.
        v._previzBindDrops(host);

        const list = doc.createElement("div");
        list.className = "previz-list";
        // The space below the tree is "no parent": dropping a row here lifts it
        // out of whatever group it was in.
        list.ondragover = (e) => {
            if (!v._previzDragItem || e.target.closest(".previz-item")) return;
            e.preventDefault();
            v._previzClearDropMarks(st._previzUI);
            list.classList.add("drop-into");
        };
        list.ondragleave = () => list.classList.remove("drop-into");
        list.ondrop = (e) => {
            if (!v._previzDragItem || e.target.closest(".previz-item")) return;
            e.preventDefault();
            v._previzClearDropMarks(st._previzUI);
            v.previzMoveItems(v._previzDragIds(), null, null, st);
        };

        // A right-click on the empty space: what puts something into the scene
        // (Sebastian 2026-11-12) - the menu bar's Create menu and File > Import Model.
        list.oncontextmenu = (e) => {
            if (e.target.closest(".previz-item")) return;
            e.preventDefault();
            e.stopPropagation();
            v._previzOpenMenu(v._previzOutlinerSpaceMenuEntries(), e.clientX, e.clientY);
        };

        const head = buildHead(doc);
        root.append(head.head, list);
        // The title bar the dock built is a sibling and stays; only the outliner's own body is replaced.
        v._previzCloseAddMenu();
        host.querySelectorAll(":scope > .previz-body").forEach((n) => n.remove());
        host.appendChild(root);
        st._previzUI = { root, list, head: head.head, search: head.search, clear: head.clear, filter: head.filter };
        if (v._olCloseFilterMenu) v._olCloseFilterMenu();
        return st._previzUI;
    }

    /** The search field and the filter button, above the tree. */
    function buildHead(doc) {
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
        search.value = st._olQuery || "";
        search.oninput = () => v.previzOutlinerSearch(search.value, st);
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault(); e.stopPropagation();
                if (search.value) v.previzOutlinerSearch("", st);
                else search.blur();
            } else if (e.key === "Enter") {
                e.preventDefault(); e.stopPropagation();
                v.previzOutlinerSelectMatches(e.shiftKey || e.ctrlKey || e.metaKey, st);
            }
        });
        const clear = doc.createElement("button");
        clear.className = "ol-clear";
        clear.type = "button";
        clear.title = "Clear the search";
        clear.append(outlinerIcon(doc, "clear"));
        clear.onclick = (e) => { e.preventDefault(); v.previzOutlinerSearch("", st); search.focus(); };
        box.append(search, clear);

        const filter = doc.createElement("button");
        filter.className = "ol-filter-btn";
        filter.type = "button";
        filter.title = "Filter: which kinds of items the Outliner shows";
        filter.append(outlinerIcon(doc, "filter"));
        filter.onclick = (e) => { e.stopPropagation(); v._olToggleFilterMenu(filter, st); };
        head.append(box, filter);
        return { head, search, clear, filter };
    }

    const uiNow = () => (st._previzUI && st._previzUI.root.isConnected) ? st._previzUI : build();

    /** Draw the tree as this view's search and filter have it. */
    function refresh() {
        const scene = v.previzScene();
        if (!scene) return;
        const ui = uiNow();
        if (!ui) return;
        const doc = ui.root.ownerDocument;
        const scroll = ui.list.scrollTop;
        ui.list.innerHTML = "";
        const rows = v._olRows(st);
        const needle = searchNeedle(st._olQuery);
        const hiddenBones = v.previzOutlinerFilter(st).hidden.includes("bones");
        // The prim each row is in the saved scene, for its tooltip.
        st._olPrimPaths = v.previzUsdPrimPaths ? v.previzUsdPrimPaths(scene) : null;
        rows.forEach((r) => {
            ui.list.append(row(r.item, r.depth, doc, scene, r, needle));
            if (r.open && r.item.kind === "model" && !hiddenBones) skeletonRows(r.item, r.depth + 1, doc, scene, ui.list, needle);
            if (r.open && r.item.kind === "model" && v._previzContentsRows) contentsRows(r.item, r.depth + 1, doc, scene, ui.list, needle);
        });
        if (!rows.length) {
            const empty = doc.createElement("div");
            empty.className = "previz-empty";
            if (!scene.items.length) empty.textContent = "Drop a model in, or use File › Import Model…";
            else if (needle) empty.textContent = `Nothing is called “${st._olQuery.trim()}”.`;
            else empty.textContent = "The filter hides everything.";
            ui.list.append(empty);
        }
        // Stripes by place on screen, skeleton rows counted.
        let n = 0;
        for (const r of ui.list.children) if (r.classList.contains("previz-item")) r.classList.toggle("odd", n++ % 2 === 1);
        ui.list.scrollTop = scroll;
        v._olSyncHead(st);
        if (wantScroll != null) { ui.list.scrollTop = wantScroll; wantScroll = null; }
    }

    // The USD Contents rows are the viewer's (imageViewer_previzUsd.js) and read its fold sets; point those at
    // this view's while it draws, so each instance folds its own. The draw is synchronous, the sets put back
    // before anything else runs.
    function contentsRows(model, depth, doc, scene, list, needle) {
        const open = v._previzContentsOpen, closed = v._previzContentsClosed;
        v._previzContentsOpen = st._previzContentsOpen;
        v._previzContentsClosed = st._previzContentsClosed;
        try { v._previzContentsRows(model, depth, doc, scene, list, needle); }
        finally { v._previzContentsOpen = open; v._previzContentsClosed = closed; }
    }

    /**
     * One row of the outliner.
     *
     * Dragging a row onto another makes it a child of that one; dropping it on
     * the empty space below the tree puts it back at the top. That is the whole
     * grouping interface — there is no "add to group" command, because the
     * thing you want to say is where it goes.
     */
    function row(item, depth, doc, scene, info = null, needle = "") {
        const collapsed = st._previzCollapsed;
        const ui = st._previzUI;
        const r = doc.createElement("div");
        r.className = "previz-item ol-row"
            + (v.previzIsSelected(item.id) ? " selected" : "")
            + (item.id === v._previzSelection ? " primary" : "")
            + (info && info.context ? " context" : "")
            + (item.visible === false ? " hidden-item" : "")
            + (item.usd && item.usd.unloaded ? " unloaded" : "");
        r.dataset.itemId = item.id;
        r.dataset.selectId = item.id;
        r.dataset.kind = outlinerKindOf(item);
        r.draggable = true;
        r.onclick = (e) => {
            // A double-click is timed by hand: the first click re-renders the
            // tree, so the second lands on a new row and the browser never
            // sees the two as one dblclick.
            const now = Date.now();
            const last = st._previzLastClick;
            st._previzLastClick = { id: item.id, t: now };
            const add = e.shiftKey || e.ctrlKey || e.metaKey;
            if (!add && last && last.id === item.id && now - last.t < 400) {
                st._previzLastClick = null;
                v.previzBeginRename(item.id, st);
                return;
            }
            v._olClickSelect(item.id, e, st);
        };
        r.oncontextmenu = (e) => v._previzItemMenu(item.id, e, st);

        const hasKids = info ? info.hasKids
            : (S.childrenOf(scene, item.id).length || (item.kind === "model" && v._previzBonesOf(item.id).length));
        const open = info ? info.open : !collapsed.has(item.id);
        const twisty = v._olTwisty(doc, hasKids ? {
            open,
            toggle: (branch) => {
                const fold = !collapsed.has(item.id);
                const ids = branch ? [item.id, ...descendantIds(scene, item.id)] : [item.id];
                for (const id of ids) { if (fold) collapsed.add(id); else collapsed.delete(id); }
                if (branch && item.kind === "model") {
                    if (fold) st._previzSkelOpen.delete(`${item.id}:skeleton`); else st._previzSkelOpen.add(`${item.id}:skeleton`);
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
        v._olName(doc, name, item.name, needle);
        name.title = item.kind === "model" && item.src ? (item.src.path || item.src.filename || "") : item.name;
        const primPath = st._olPrimPaths && st._olPrimPaths.get(item.id);
        if (primPath) name.title = `${primPath}\n${name.title}`;
        if (item.ref) {
            const ref = L.referenceById(scene, item.ref.id);
            name.classList.add("ref");
            name.title = `${item.name}\nReferenced from ${ref ? ref.path : "a scene file"}`;
        }

        r.append(v._olIndent(doc, depth), twisty, kind, name);
        if (st._previzRenaming && st._previzRenaming.id === item.id) {
            v._previzMountRename(r, name, item, st);
        }
        // The right-hand side: marks first, then the buttons, the eye last.
        const end = doc.createElement("span");
        end.className = "ol-end";
        const failed = v._model3d ? v._model3d.itemError(item.id) : "";
        if (failed) {
            const warn = doc.createElement("span");
            warn.className = "previz-warn";
            warn.textContent = "!";
            warn.title = `This file could not be loaded:\n${failed}`;
            end.append(warn);
        }
        // Its mesh comes in as a payload in the saved scene (P); unloaded, it is dimmed.
        if (item.kind === "model" && item.src) {
            const arc = doc.createElement("span");
            arc.className = "ol-arc" + (item.usd && item.usd.unloaded ? " unloaded" : "");
            arc.textContent = "P";
            arc.title = item.usd && item.usd.unloaded
                ? "Payload, unloaded: in the scene and the file, not drawn (right-click: Load)"
                : "Payload: the mesh is referenced from its file, not written into the scene";
            end.append(arc);
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
            const look = v._olRowBtn(doc, "previz-look" + (on ? " active" : ""), "look",
                on ? "Back to the free view" : "Look through this camera", () => v.previzLookThrough(item.id));
            end.append(look);
        }
        const off = item.visible === false;
        const eye = v._olRowBtn(doc, "previz-eye" + (off ? " off" : ""), off ? "eyeOff" : "eye",
            item.kind === "group" ? "Show / hide the group and what is in it" : "Show / hide",
            () => { item.visible = item.visible === false; v.previzChanged(); });
        end.append(eye);
        r.append(end);

        r.ondragstart = (e) => {
            // Dragging one of a selection takes the selection along; any other
            // row goes alone. Not selected here: that would redraw the tree
            // and pull this row out from under the drag that just started.
            v._previzDragItem = item.id;
            r.classList.add("dragging");
            try { e.dataTransfer.setData("text/plain", item.name); } catch (_) {}
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        };
        r.ondragend = () => {
            v._previzDragItem = null;
            r.classList.remove("dragging");
            v._previzClearDropMarks(ui);
        };
        r.ondragover = (e) => {
            if (!v._previzDragItem) return;
            const drop = v._previzDropFor(r, item, e, scene, st);
            if (!drop) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            v._previzClearDropMarks(ui);
            r.classList.add(`drop-${drop.zone}`);
        };
        r.ondragleave = () => r.classList.remove("drop-into", "drop-before", "drop-after");
        r.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const drop = v._previzDragItem ? v._previzDropFor(r, item, e, scene, st) : null;
            v._previzClearDropMarks(ui);
            if (drop) v.previzMoveItems(v._previzDragIds(), drop.parent, drop.before, st);
        };
        return r;
    }

    /**
     * The skeleton under a model in the outliner: one "Skeleton" row (folded at
     * first) and its bones as a tree. Bones are the file's, not scene items, so
     * the rows only show them; a click selects the bone's FK control when the
     * character is rigged, else the model. A search opens it at the bones that match.
     */
    function skeletonRows(model, depth, doc, scene, list, needle = "") {
        const bones = v._previzBonesOf(model.id);
        if (!bones.length) return;
        const open = st._previzSkelOpen;
        const fk = new Map();
        for (const it of scene.items) {
            if (it.kind === "control" && it.control && it.control.model === model.id && it.control.type === "fk") fk.set(it.control.bone, it);
        }
        // The Skeleton row starts folded (open set); bones start unfolded (closed set).
        const closed = st._previzSkelClosed;
        const rowFor = (label, d, title, onclick, fold, opts = {}) => {
            const r = doc.createElement("div");
            r.className = "previz-item previz-bone ol-row" + (opts.context ? " context" : "")
                + (opts.selected ? " selected" : "");
            r.dataset.kind = "bones";
            const name = doc.createElement("span");
            name.className = "previz-name";
            v._olName(doc, name, label, opts.needle || "");
            name.title = title;
            const kind = doc.createElement("span");
            kind.className = "ol-kind" + (opts.joint ? " joint" : "");
            kind.dataset.kind = "bones";
            if (!opts.joint) kind.append(outlinerIcon(doc, "bones"));
            r.append(v._olIndent(doc, d), v._olTwisty(doc, fold), kind, name);
            if (opts.selectId) r.dataset.selectId = opts.selectId;
            r.onclick = onclick;
            list.append(r);
        };
        const skelKey = `${model.id}:skeleton`;
        const searching = !!needle && bones.some((b) => matchRange(b.name, needle));
        const isOpen = searching || open.has(skelKey);
        rowFor(`Skeleton (${bones.length} bones)`, depth,
            fk.size ? "The file's bones; click one to select its control." : "The file's bones. Rig → Add controls to animate them.",
            () => v.previzSelect(model.id),
            { open: isOpen, toggle: () => (open.has(skelKey) ? open.delete(skelKey) : open.add(skelKey)) },
            { context: searching });
        if (!isOpen) return;
        for (const b of boneRows(bones, { needle: searching ? needle : "", isClosed: (n) => closed.has(`${model.id}:bone:${n}`) })) {
            const key = `${model.id}:bone:${b.name}`;
            const ctrl = fk.get(b.name);
            rowFor(b.name, depth + 1 + b.depth, ctrl ? `${b.name}: selects ${ctrl.name}` : b.name,
                (e) => (ctrl ? v._olClickSelect(ctrl.id, e, st) : v.previzSelect(model.id, { add: e.ctrlKey || e.metaKey })),
                b.hasKids && { open: b.open, toggle: () => (closed.has(key) ? closed.delete(key) : closed.add(key)) },
                { selectId: ctrl ? ctrl.id : "", joint: true, needle: searching ? needle : "", context: b.context, selected: !!ctrl && v.previzIsSelected(ctrl.id) });
        }
    }

    return {
        el: host,
        get ui() { return st._previzUI; },
        build,
        refresh,
        /** The panel came into view: draw the tree as it stands (the space's layout decides whether it is up). */
        wake: refresh,
        save() {
            const ui = st._previzUI;
            return {
                query: st._olQuery || "",
                filter: v.previzOutlinerFilter(st),
                collapsed: [...st._previzCollapsed],
                skelOpen: [...st._previzSkelOpen],
                skelClosed: [...st._previzSkelClosed],
                contentsOpen: [...st._previzContentsOpen],
                contentsClosed: [...st._previzContentsClosed],
                scroll: (ui && ui.list && ui.list.scrollTop) || 0,
            };
        },
        dispose() {
            if (v._olMenu && v._olMenu.st === st) v._olCloseFilterMenu();
            st._previzRenaming = null;
            const ui = st._previzUI;
            if (ui) ui.root.remove();
            st._previzUI = null;
        },
    };
}