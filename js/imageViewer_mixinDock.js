// imageViewer_mixinDock.js
// Panel docking: where every panel sits, how much room it has, and the drag that moves it.
//
// WHY THIS EXISTS
// Placement used to be spread over six insertBefore/appendChild calls in four
// files, driven by two independent side flags plus one implicit rule ("history
// goes opposite params"). Every feature that touched layout had to re-derive
// the arrangement from those, and twice got it wrong. Both bugs were the same
// bug — no single place said where the panels are.
//
// So: one object says where everything is, and one function is allowed to act
// on it.
//
// THE LAYOUT IS A TREE OF SPLITS (Sebastian 2026-11-19: "more panels side by side, or split panels horizontally and
// vertically"; imageViewer_dockTree.js, pure):
//
//   dockLayout = { v: 2, root: { split: "col", children: [
//       { split: "row", children: [ { split: "col", rail: "left", px: 88, children: [{ id: "history" }] },
//                                   { view: true },
//                                   { split: "col", rail: "right", px: 300, children: [{ id: "params" }, ...] } ] },
//       { split: "row", rail: "bottom", px: 240, children: [{ id: "curves" }, ...] } ] } }
//
// A split lays its children out side by side ("row") or one above the other ("col"); a child takes `px` (fixed) or
// `size` (a share). The picture (`view`: the viewport and the Source viewer beside it) is a node like the panels, so
// a panel dropped on any edge of any panel - or of the picture, or of the whole area - splits that place in two. The
// three rails of before are the splits marked `rail`, and a saved layout of the rails' shape is read into this one
// (fromRails). Everything else — toggling a panel, restoring a layout, dropping a dragged panel — edits that object
// and calls applyDockLayout().
//
// TABS. A panel dropped onto the middle of another shares its place: the two
// are tabs of one slot, named in the title bar, one of them in front. In the
// layout that is two more fields on an entry - `tab`, the name of the group it
// is in, and `behind`, set on every member but the one in front. A panel that
// is behind is open (isPanelDocked) but not drawn; isPanelFront says which is.
// Members of a group lie next to each other in their split, and the slot's
// room is the front one's.
import { api } from "../../scripts/api.js";
import * as DT from "./imageViewer_dockTree.js";

// Names that are another panel now: the Channel Box lives in the Parameters panel (Sebastian 2026-11-12).
const DOCK_ALIASES = { channels: "params" };
const _dockId = (id) => DOCK_ALIASES[id] || id;

// The dockable panels, and the room each one needs to stay usable.
const DOCK_PANELS = {
    history: { prop: "historyPanel", label: "History",    minW: 60,  minH: 90,  defaultRail: "left" },
    // Enough for the header, the path field, a list worth reading and the
    // buttons; the preview shrinks into whatever is left over.
    browser: { prop: "browserPanel", label: "Files",      minW: 180, minH: 220, defaultRail: "right" },
    params:  { prop: "paramsPanel",  label: "Parameters", minW: 200, minH: 120, defaultRail: "right" },
    // The outliner: the scene's tree and the buttons over it. Its numbers
    // live next door, in the Channel Box, so each can be sized on its own.
    previz:  { prop: "previzPanel",  label: "Outliner",   minW: 190, minH: 140, defaultRail: "right" },
    // The Channel Box is no panel of its own: on a 3D tab it is what the Parameters panel shows
    // (imageViewer_previzChannels.js _cbParams). "channels" is still accepted as a name for it (DOCK_ALIASES).
    // Display layers, selection sets and references; and a character's picker (imageViewer_previzLayers.js).
    layers3d: { prop: "layers3dPanel", label: "Layers", minW: 190, minH: 140, defaultRail: "right" },
    picker: { prop: "pickerPanel", label: "Picker", minW: 190, minH: 200, defaultRail: "right", size: 2 },
    // The matchmove guide (step by step) and the plate it tracks on (imageViewer_previzMatchmove.js).
    mmGuide: { prop: "mmGuidePanel", label: "Matchmove", minW: 260, minH: 200, defaultRail: "right", size: 2 },
    mmPlate: { prop: "mmPlatePanel", label: "Plate", minW: 260, minH: 160, defaultRail: "bottom", size: 2, tabWith: "curves" },
    // The scene's animation layers (imageViewer_animLayersPanel.js).
    animLayers: { prop: "animLayersPanel", label: "Anim Layers", minW: 240, minH: 120, defaultRail: "right" },
    // A graph is only readable with some height under it, so this one asks for
    // more than the rest; the channel buttons set the width.
    curves:  { prop: "curvesPanel",  label: "Curve Editor", minW: 220, minH: 190, defaultRail: "bottom" },
    // Timing: keys as diamonds over time (imageViewer_previzDopeSheet.js), a tab beside the Curve Editor.
    // A second view: another open tab - a 3D scene, a picture - beside the picture (imageViewer_view2.js).
    view2: { prop: "view2Panel", label: "Second view", minW: 240, minH: 180, defaultRail: "right", size: 2 },
    dopeSheet: { prop: "dopeSheetPanel", label: "Dope Sheet", minW: 320, minH: 140, defaultRail: "bottom", tabWith: "curves" },
    // The Clip Sequencer (imageViewer_previzClips.js): clips on tracks, under the picture where time has width.
    clips: { prop: "clipsPanel", label: "Clip Sequencer", minW: 320, minH: 150, defaultRail: "bottom", tabWith: "curves" },
    // The roto shapes' timing, the same editor's look (imageViewer_rotoCurves.js);
    // the roto tool opens and closes it.
    rotoCurves: { prop: "rotoCurvesPanel", label: "Roto Curves", minW: 220, minH: 170, defaultRail: "right" },
    // Keyed node parameters (imageViewer_paramCurves.js); the ∿ button in the
    // Parameters header opens it.
    paramCurves: { prop: "paramCurvesPanel", label: "Parameter Curves", minW: 220, minH: 170, defaultRail: "right" },
    // A cut, to change and to play (imageViewer_editTimeline.js); the
    // transport's timeline button opens it. A timeline wants width, so it
    // starts under the picture.
    editTimeline: { prop: "editTimelinePanel", label: "Edit", minW: 320, minH: 150, defaultRail: "bottom" },
    // Its companions (imageViewer_editPanels.js). All three are up only while
    // a cut's tab is; the bar's Timeline group opens them.
    editInspector: { prop: "editInspectorPanel", label: "Inspector", minW: 290, minH: 200, defaultRail: "right" },
    editEffects: { prop: "editEffectsPanel", label: "Effects", minW: 220, minH: 150, defaultRail: "left" },
    // (The Source viewer is no panel: it stands left of the picture, imageViewer_editSource.js. A layout that
    // still names "editSource" is read without it.)
    // The Mixer has a place of its own: beside the timeline, under the picture, as Resolve's.
    editMixer: { prop: "editMixerPanel", label: "Mixer", minW: 200, minH: 220, defaultRail: "bottom", size: 0.4 },
    // (Agent code and Dataset are tabs of the main canvas, imageViewer_viewTabs.js. A saved layout that still names
    // "agentCode" or "loraDataset" is read without them: unknown ids are dropped by _normaliseDockLayout / applyDockData.)
    // The motion-graphics editor (imageViewer_mgPanel.js / imageViewer_mgEditor.js): a scene an agent wrote is a
    // TAB (preview in the main canvas, its transport is the viewer's bar); these are its other parts, up only with a
    // motion tab. (There was a Layers panel: the timeline's left column is the layer list now, and a saved layout that
    // still names "motionLayers" is read without it - unknown ids are dropped by _normaliseDockLayout / applyDockData.)
    motionProps: { prop: "motionPropsPanel", label: "Properties", minW: 240, minH: 200, defaultRail: "right", size: 2 },
    motionTimeline: { prop: "motionTimelinePanel", label: "Motion timeline", minW: 360, minH: 160, defaultRail: "bottom" },
    // Comp (imageViewer_compPanel.js / imageViewer_compEditor.js): a comp is a TAB (the picture in the main canvas, the
    // viewer's bar its time); these are its other parts, up only with a comp tab. The Node Graph is the way in, so it
    // is up by default, under the picture where a graph has width; Layers is the same graph as a stack, off at first.
    // A comp node's settings show in the Parameters panel (compPanel's _cpParams), not in a panel of their own.
    compGraph: { prop: "compGraphPanel", label: "Node Graph", minW: 320, minH: 160, defaultRail: "bottom", size: 2 },
    // Layers is a timeline (bars and keys over time), so it lives under the picture, a tab beside the Node graph.
    compLayers: { prop: "compLayersPanel", label: "Layers", minW: 320, minH: 120, defaultRail: "bottom", size: 1, tabWith: "compGraph" },
    // The Curve Editor: the selected comp nodes' keys (imageViewer_compCurves.js), off at first, under the picture.
    compCurves: { prop: "compCurvesPanel", label: "Curve Editor", minW: 320, minH: 140, defaultRail: "bottom", size: 1, tabWith: "compGraph" },
    // Paint (imageViewer_paintPanel.js / imageViewer_paintEditor.js): a picture is a TAB (the editor covers the main
    // canvas); these are its other parts, up only with a Paint tab.
    paintLayers: { prop: "paintLayersPanel", label: "Layers", minW: 220, minH: 180, defaultRail: "right", size: 2 },
    paintProps: { prop: "paintPropsPanel", label: "Properties", minW: 240, minH: 200, defaultRail: "right", size: 2 },
    // `tabWith`: a layout saved before the panel existed gets it as a tab behind that one, not as one more panel.
    paintTool: { prop: "paintToolPanel", label: "Tool options", minW: 220, minH: 120, defaultRail: "right", size: 2, tabWith: "paintProps" },
    paintEffects: { prop: "paintEffectsPanel", label: "Effects", minW: 240, minH: 160, defaultRail: "right", size: 2, tabWith: "paintProps" },
    paintGenerate: { prop: "paintGeneratePanel", label: "Generate", minW: 240, minH: 160, defaultRail: "right", size: 2, tabWith: "paintProps" },
    paintHistory: { prop: "paintHistoryPanel", label: "History", minW: 200, minH: 140, defaultRail: "right", size: 1 },
    // (The drawing tools' options have no panel of their own: while a tool is
    // on they take the Parameters panel over — ToolsMixin._toolShowDock.)
    // The agentY chat panel (imageViewer_agentPanel.js): agentY's own panel,
    // moved here from the ComfyUI sidebar while this panel is open.
    agentChat: { prop: "agentChatPanel", label: "agentY", minW: 280, minH: 260, defaultRail: "right", size: 2 },
};

const RAIL_SIDES = ["left", "right", "bottom"];
// The room a rail had before anybody dragged it.
const RAIL_PX = { left: 88, right: 300, bottom: 240 };
// How far into the picture an edge drop is offered.
const EDGE_ZONE = 0.28;
// The band along the whole area's edge that means "beside everything".
const ROOT_ZONE = 12;
// Between two places: the splitter.
const GAP = 5;
// Pointer travel before a press on a header becomes a drag rather than a click.
const DRAG_SLOP = 4;
// The main view, where a panel id is asked for (its drag, its maximise). Never a key of DOCK_PANELS.
const VIEW_ID = "__view__";
// A panel's least room, with the room round its card (a 3 px margin each side).
const CARD = 6;
const _minOf = (id) => { const s = DOCK_PANELS[id]; return s ? { w: s.minW + CARD, h: s.minH + CARD } : null; };
const _known = (id) => !!DOCK_PANELS[id];
// What the old shape's default was; the tree's default is read from it, so both say the same.
const DEFAULT_RAILS = () => ({
    left:   { width: 88,  panels: [{ id: "history", size: 1, hidden: true  }] },
    right:  { width: 300, panels: [{ id: "browser", size: 1, hidden: true  },
                                   { id: "previz",  size: 1, hidden: true  },
                                   { id: "layers3d", size: 1, hidden: true },
                                   { id: "picker", size: 2, hidden: true },
                                   { id: "mmGuide", size: 2, hidden: true },
                                   { id: "animLayers", size: 1, hidden: true },
                                   { id: "rotoCurves", size: 1, hidden: true },
                                   { id: "paramCurves", size: 1, hidden: true },
                                   { id: "motionProps", size: 2, hidden: true },
                                   { id: "paintLayers", size: 2, hidden: true },
                                   { id: "paintProps", size: 2, hidden: true, tab: "paint", behind: false },
                                   { id: "paintTool", size: 2, hidden: true, tab: "paint", behind: true },
                                   { id: "paintEffects", size: 2, hidden: true, tab: "paint", behind: true },
                                   { id: "paintGenerate", size: 2, hidden: true, tab: "paint", behind: true },
                                   { id: "paintHistory", size: 1, hidden: true },
                                   { id: "params",  size: 1, hidden: false }] },
    // A graph over time wants width: the Curve Editor lives under the picture.
    bottom: { height: 240, panels: [{ id: "curves", size: 1, hidden: true, tab: "tcurves", behind: false },
                                    { id: "dopeSheet", size: 1, hidden: true, tab: "tcurves", behind: true },
                                    { id: "clips", size: 1, hidden: true, tab: "tcurves", behind: true },
                                    { id: "mmPlate", size: 1, hidden: true, tab: "tcurves", behind: true },
                                    { id: "motionTimeline", size: 1, hidden: true },
                                    { id: "compGraph", size: 1, hidden: true, tab: "comp", behind: false },
                                    { id: "compLayers", size: 1, hidden: true, tab: "comp", behind: true },
                                    { id: "compCurves", size: 1, hidden: true, tab: "comp", behind: true }] },
});

export const DockMixin = {

    // ── Bootstrap ────────────────────────────────────────────────────────────

    _initDock() {
        const sr = this.shadowRoot;
        const main = sr.querySelector(".main-area");
        this.dockOverlay = sr.getElementById("dock-overlay");
        if (!main || !this.viewport || !this.viewport.parentNode) return;
        const doc = main.ownerDocument;
        // The rails of the old markup: the tree draws splits of its own. (A rail element a cached older page still
        // has is simply taken out.)
        for (const id of ["dock-left", "dock-right", "dock-bottom", "rail-splitter-left", "rail-splitter-right", "rail-splitter-bottom"]) {
            const el = sr.getElementById(id);
            if (el) el.remove();
        }
        // The picture's place: the viewport and, left of it, the Source viewer (which is made before #viewport,
        // so it lands in here too when it comes later). Moved once, before anything plays.
        let view = sr.getElementById("dock-view");
        if (!view) {
            view = doc.createElement("div");
            view.id = "dock-view";
            view.className = "dock-view";
            this.viewport.parentNode.insertBefore(view, this.viewport);
            const src = this.editSourcePanel;
            if (src && src.parentNode === view.parentNode) view.appendChild(src);
            view.appendChild(this.viewport);
        }
        // The main view is a panel too (Sebastian 2026-11-19): a title bar above the picture, the picture's own
        // elements in a body under it. Moved once, here, before anything plays.
        let body = view.querySelector(":scope > .dock-view-body");
        if (!body) {
            body = doc.createElement("div");
            body.className = "dock-view-body";
            for (const c of [...view.children]) if (!c.classList.contains("panel-titlebar")) body.appendChild(c);
            view.appendChild(body);
        }
        this.dockViewBody = body;
        this.dockViewEl = view;
        this._ensureViewTitlebar();
        let root = sr.getElementById("dock-root");
        if (!root) {
            root = doc.createElement("div");
            root.id = "dock-root";
            root.className = "dock-split dock-rail dock-root";
            main.insertBefore(root, main.firstChild);
        }
        this._dockRootEl = root;
        // Kept for anything still asking for a rail's element: the split that rail became.
        const self = this;
        this.railEl = {};
        for (const side of RAIL_SIDES) {
            Object.defineProperty(this.railEl, side, { enumerable: true, get() {
                const n = self.dockLayout && DT.railNode(self.dockLayout.root, side);
                return n ? self._dockNodeEl(n) : null;
            } });
        }

        // Hidden until the first layout pass places them, so nothing flashes at
        // the edge of the viewport on the way to its place.
        for (const id of Object.keys(DOCK_PANELS)) {
            const el = this._dockPanelEl(id);
            if (el) el.style.display = "none";
        }

        this.dockLayout = this._defaultDockLayout();
        this._bindDockDrag();
        this.applyDockLayout();
        // The lower bar's panel groups (imageViewer_barGroups.js). On its own: a
        // bar that cannot be built must not take docking down with it.
        for (const make of ["_barGroupsBuild"]) {
            try { if (this[make]) this[make](); }
            catch (e) { console.warn(`imageViewer: ${make} failed`, e); }
        }
    },

    _dockPanelEl(id) {
        const spec = DOCK_PANELS[id];
        return spec ? (this[spec.prop] || null) : null;
    },

    /** A node's element: a panel's own, the picture's place, or the split's box (made the first time). */
    _dockNodeEl(n) {
        if (!n) return null;
        if (DT.isPanel(n)) return this._dockPanelEl(n.id);
        if (DT.isView(n)) return this.dockViewEl || null;
        if (this.dockLayout && n === this.dockLayout.root) return this._dockRootEl || null;
        const map = this._dockSplitEls || (this._dockSplitEls = new WeakMap());
        let el = map.get(n);
        if (!el && this._dockRootEl) {
            el = this._dockRootEl.ownerDocument.createElement("div");
            el.className = "dock-split dock-rail";
            map.set(n, el);
        }
        return el || null;
    },

    _defaultDockLayout() {
        // Matches what the viewer opened with before docking existed: the
        // parameters panel showing on the right, the others put away.
        const L = DT.fromRails(DEFAULT_RAILS());
        L.root = DT.tidy(L.root, _known);
        return L;
    },

    // ── The single writer ────────────────────────────────────────────────────

    /**
     * Make the DOM match dockLayout. The ONLY function that moves a panel,
     * sizes a place, or shows a splitter — if layout looks wrong, it is either
     * this function or the object it was handed, and nowhere else.
     *
     * Order inside a split is CSS `order`, so an element is moved only when its split changes: re-appending the
     * picture would pause a playing film.
     */
    applyDockLayout() {
        if (!this._dockRootEl) return;
        this._normaliseDockLayout();
        const root = this.dockLayout.root;
        const used = new Set();
        const place = (n, parentEl, parent, order) => {
            const el = this._dockNodeEl(n);
            if (!el) return;
            used.add(el);
            if (parentEl && el.parentNode !== parentEl) parentEl.appendChild(el);
            el.style.order = String(order);
            if (DT.isPanel(n)) {
                const row = parent && parent.split === "row";
                const side = DT.sideOf(root, n.id);
                el.classList.add("dock-card");
                el.classList.toggle("left", !row && side === "left");
                el.classList.toggle("right", !row && side !== "left");
                el.classList.toggle("bottom", !!row);
                const folded = !!n.collapsed && !n.hidden;
                el.classList.toggle("dock-collapsed", folded);
                const spec = DOCK_PANELS[n.id];
                // Along the split: its own minimum. Across: the split owns that, as a rail owned its width.
                el.style.minHeight = folded || row ? "" : `${spec.minH}px`;
                el.style.minWidth = row && !folded ? `${spec.minW}px` : "";
                el.style.width = "";
                el.style.height = "";
                return;
            }
            if (!DT.isSplit(n)) return;
            el.classList.add("dock-split", "dock-rail");
            el.classList.toggle("bottom", n.split === "row");
            el.style.flexDirection = n.split === "row" ? "row" : "column";
            if (n.rail) el.dataset.rail = n.rail; else delete el.dataset.rail;
            n.children.forEach((c, i) => place(c, el, n, i * 2));
            this._dockFlexSplit(n);
        };
        place(root, null, null, 0);
        this._dockRootEl.style.display = "flex";
        // A split box no longer in the tree goes (its panels have moved on by now).
        for (const el of [...this._dockRootEl.querySelectorAll(".dock-split")]) {
            if (!used.has(el)) el.remove();
        }

        // Kept in step for anything still reading it (icons, older call sites).
        const lr = (id, was) => { const s = this._dockSideOf(id); return s === "left" || s === "right" ? s : (was || "right"); };
        this.paramsSide  = lr("params", this.paramsSide);
        this.browserSide = lr("browser", this.browserSide);
        this._syncDockTabs();
        this._dockMaxSync();
        this._syncPanelToggleButtons();
        this._notifyPanelsShown();

        // Compare geometry and the frame outline are measured against the
        // viewport, which has just changed width.
        if (this._afterViewportMoved) this._afterViewportMoved();
    },

    /** One split's children: shown or not, their room, and a splitter between each two shown ones. */
    _dockFlexSplit(n, sizesOnly = false) {
        const el = this._dockNodeEl(n);
        if (!el) return;
        const row = n.split === "row";
        const axis = row ? "w" : "h";
        // During a splitter's drag only the sizes change: the splitter under the pointer must stay.
        if (!sizesOnly) el.querySelectorAll(":scope > .stack-splitter").forEach((s) => s.remove());
        for (const c of n.children) {
            const ce = this._dockNodeEl(c);
            if (ce && (!DT.isLive(c) || c.behind)) ce.style.display = "none";
        }
        const flex = DT.flexOf(n);
        flex.forEach((f, k) => {
            const ce = this._dockNodeEl(f.node);
            if (!ce) return;
            ce.style.display = "flex";
            let basis = f.basis;
            // A fixed place is never less than what its panels need.
            if (typeof basis === "number" && f.grow === 0) basis = Math.max(basis, DT.minSize(f.node, axis, _minOf, GAP));
            ce.style.flex = `${f.grow} ${f.grow > 0 ? 1 : 0} ${typeof basis === "number" ? basis + "px" : basis}`;
            if (k === 0 || sizesOnly) return;
            const prev = flex[k - 1];
            // A folded panel has no room to give or take.
            if (DT.allFolded(f.node) || DT.allFolded(prev.node)) return;
            const sp = el.ownerDocument.createElement("div");
            sp.className = row ? "stack-splitter horizontal" : "stack-splitter";
            sp.style.order = String(n.children.indexOf(f.node) * 2 - 1);
            if (DT.isPanel(prev.node)) sp.dataset.after = prev.node.id;
            if (DT.isPanel(f.node)) sp.dataset.before = f.node.id;
            sp.title = "Resize";
            el.appendChild(sp);
            this._dockBindSplitter(sp, n, prev.node, f.node);
        });
        el.style.display = DT.isLive(n) || n === this.dockLayout.root ? "flex" : "none";
    },

    // The title bar of a panel that shares its place names every panel there:
    // the one in front as it is, the others as tabs to press. The main view can be one of them.
    _syncDockTabs() {
        DT.walk(this.dockLayout.root, (entry, parent) => {
            if (!DT.isTabbable(entry) || !parent) return;
            const isView = DT.isView(entry);
            const el = isView ? this.dockViewEl : this._dockPanelEl(entry.id);
            const bar = el && el.querySelector(":scope > .panel-titlebar");
            const name = bar && bar.querySelector(":scope > .pt-name");
            if (!name) return;
            const mates = DT.tabMates(parent.children, entry.tab).filter((p) => !p.hidden);
            if (entry.hidden || entry.behind || mates.length < 2) {
                if (name._tabs) {
                    name._tabs = ""; name.classList.remove("pt-tabs");
                    name.textContent = isView ? this._dockViewText() : DOCK_PANELS[entry.id].label;
                }
                return;
            }
            const label = (p) => (DT.isView(p) ? this._dockViewText() : DOCK_PANELS[p.id].label);
            const sig = mates.map(label).join(",") + "|" + label(entry);
            if (name._tabs === sig) return;
            name._tabs = sig;
            name.classList.add("pt-tabs");
            const doc = name.ownerDocument;
            name.replaceChildren(...mates.map((p) => {
                const front = p === entry;
                // The front one is part of the bar (it is what a drag takes
                // hold of); the others are buttons, and a press brings them up.
                const tab = doc.createElement(front ? "span" : "button");
                tab.className = "pt-tab" + (front ? " on" : "") + (DT.isView(p) ? " pt-tab-view" : "");
                tab.textContent = label(p);
                if (!front) {
                    tab.title = DT.isView(p) ? "Show the main view" : "Show " + DOCK_PANELS[p.id].label;
                    tab.addEventListener("pointerdown", (e) => e.stopPropagation());
                    tab.addEventListener("click", (e) => {
                        e.stopPropagation();
                        if (DT.isView(p)) this.dockViewFront(); else this.dockTabFront(p.id);
                    });
                }
                return tab;
            }));
        });
    },

    /** The split a rail became; made beside the picture (the bottom one under everything) when there is none. */
    _dockRail(side, entry) {
        const L = this.dockLayout;
        let rail = DT.railNode(L.root, side);
        if (rail) { if (entry) rail.children.push(entry); return rail; }
        rail = { split: side === "bottom" ? "row" : "col", rail: side, children: entry ? [entry] : [] };
        if (side === "bottom") L.root = DT.insertBeside(L.root, L.root, "bottom", rail, RAIL_PX.bottom);
        else L.root = DT.insertBeside(L.root, DT.findView(L.root).node, side, rail, RAIL_PX[side]);
        return rail;
    },

    /** Drop unknown ids, re-home missing ones, and keep every panel exactly once. */
    _normaliseDockLayout() {
        if (!DT.isTreeLayout(this.dockLayout)) {
            this.dockLayout = DT.isRailLayout(this.dockLayout) ? DT.fromRails(this.dockLayout) : this._defaultDockLayout();
        }
        const L = this.dockLayout;
        L.root = DT.tidy(L.root, _known);
        // Once each: a panel's home moved to the strip under the picture. A layout saved before that has it, put
        // away, beside the picture: the Curve Editor; the Mixer (it shipped in the right rail, where it shared the
        // height with the Inspector); the Comp's Layers (a timeline now, a tab beside the Node graph).
        const once = (flag, fn) => {
            try {
                if (window.localStorage.getItem(flag)) return;
                window.localStorage.setItem(flag, "1");
                fn();
            } catch (_) { /* no storage: it stays where the layout has it */ }
        };
        once("imageviewer.viewer.curvesBottom", () => {
            const s = this._dockSideOf("curves");
            if (s !== "left" && s !== "right") return;
            const entry = DT.detach(L.root, "curves");
            if (entry) { entry.size = 1; L.root = DT.tidy(L.root, _known); this._dockRail("bottom", entry); }
        });
        once("imageviewer.viewer.mixerBottom", () => this._dockMixerHome());
        once("imageviewer.viewer.compLayersBottom", () => this._dockCompLayersHome());
        // A panel the saved layout never mentioned (a viewer upgraded mid-flight)
        // goes back to where it shipped, put away rather than sprung on the user.
        const seen = new Set(DT.panels(L.root).map((p) => p.id));
        for (const [id, spec] of Object.entries(DOCK_PANELS)) {
            if (seen.has(id)) continue;
            // `size`: its share of its place, until the user drags it.
            const entry = { id, size: spec.size || 1, hidden: true };
            const near = spec.tabWith ? DT.locate(L.root, spec.tabWith) : null;
            if (near && near.parent) {
                const list = near.parent.children;
                if (!near.node.tab) { near.node.tab = "t" + spec.tabWith; near.node.behind = false; }
                Object.assign(entry, { tab: near.node.tab, behind: true });
                if (near.node.size > 0) entry.size = near.node.size;
                let at = near.index;
                list.forEach((p, i) => { if (p.tab === entry.tab) at = i; });
                list.splice(at + 1, 0, entry);
                seen.add(id);
                continue;
            }
            const rail = this._dockRail(spec.defaultRail);
            if (spec.first) rail.children.unshift(entry); else rail.children.push(entry);
            seen.add(id);
        }
        L.root = DT.tidy(L.root, _known);
    },

    // The Mixer into the strip under the picture, right after the Edit timeline (its own place there).
    _dockMixerHome() {
        const L = this.dockLayout;
        const s = this._dockSideOf("editMixer");
        if (s !== "left" && s !== "right" && s !== "top") return;
        const entry = DT.detach(L.root, "editMixer");
        if (!entry) return;
        L.root = DT.tidy(L.root, _known);
        const tl = DT.locate(L.root, "editTimeline");
        if (tl && tl.parent && tl.parent.split === "row") {
            entry.size = Math.max(0.2, (tl.node.size || 1) * 0.4);
            tl.parent.children.splice(tl.index + 1, 0, entry);
            return;
        }
        entry.size = DOCK_PANELS.editMixer.size;
        this._dockRail("bottom", entry);
    },

    // The Comp's Layers into the strip under the picture, a tab behind the Node graph.
    _dockCompLayersHome() {
        const L = this.dockLayout;
        const s = this._dockSideOf("compLayers");
        if (s !== "left" && s !== "right" && s !== "top") return;
        const entry = DT.detach(L.root, "compLayers");
        if (!entry) return;
        L.root = DT.tidy(L.root, _known);
        const g = DT.locate(L.root, "compGraph");
        if (!g || !g.parent) { entry.size = 1; this._dockRail("bottom", entry); return; }
        if (!g.node.tab) { g.node.tab = "comp"; g.node.behind = false; }
        Object.assign(entry, { tab: g.node.tab, behind: true, hidden: !!entry.hidden });
        if (g.node.size > 0) entry.size = g.node.size;
        g.parent.children.splice(g.index + 1, 0, entry);
    },

    // ── Queries ──────────────────────────────────────────────────────────────

    /** Which way from the picture a panel is: "left", "right", "bottom" (or "top"), null when it is not there. */
    _dockSideOf(id) {
        return this.dockLayout && DT.isTreeLayout(this.dockLayout) ? DT.sideOf(this.dockLayout.root, id) : null;
    },

    /** Where a panel's entry is: { side (its split), index, entry, list (the split's children) }, or null. */
    _dockEntry(id) {
        if (!this.dockLayout || !DT.isTreeLayout(this.dockLayout)) return null;
        const at = DT.locate(this.dockLayout.root, id);
        if (!at || !at.parent) return null;
        return { side: at.parent, index: at.index, entry: at.node, list: at.parent.children };
    },

    /** Every panel entry of the layout, in order (what tests and the bar read instead of the old rails). */
    dockPanelEntries() {
        return this.dockLayout && DT.isTreeLayout(this.dockLayout) ? DT.panels(this.dockLayout.root) : [];
    },

    /**
     * The panels by the side of the picture they are on, in the old rails' shape - { left, right, bottom, top }:
     * { panels: [entries] } - for reading (tests, anything that asked the rails). The entries are the layout's own.
     */
    dockRailsView() {
        const out = { left: { panels: [] }, right: { panels: [] }, bottom: { panels: [] }, top: { panels: [] } };
        for (const p of this.dockPanelEntries()) out[this._dockSideOf(p.id) || "right"].panels.push(p);
        return out;
    },

    /** Set the room of a rail (the split it became): its width, or the bottom one's height. */
    dockSetRailSize(side, px) {
        const rail = this.dockLayout && DT.railNode(this.dockLayout.root, side);
        if (!rail || !(px > 0)) return false;
        rail.px = Math.round(px);
        this.applyDockLayout();
        return true;
    },

    isPanelDocked(id) {
        id = _dockId(id);
        const found = this._dockEntry(id);
        return !!(found && !found.entry.hidden);
    },

    /** Is the panel open AND the one drawn in its place (not behind another's tab)? */
    isPanelFront(id) {
        id = _dockId(id);
        const found = this._dockEntry(id);
        return !!(found && !found.entry.hidden && !found.entry.behind);
    },

    _dockTabMates(found) {
        const tab = found.entry.tab;
        return tab ? DT.tabMates(found.list, tab) : [found.entry];
    },

    /** Is the main view behind a panel's tab (Sebastian 2026-11-20: panels can be tabs of the main view)? */
    isViewBehind() {
        const v = this.dockLayout && DT.findView(this.dockLayout.root);
        return !!(v && v.node.tab && v.node.behind);
    },

    /** Bring the main view to the front of the place it shares with panels as tabs. */
    dockViewFront() {
        const v = this.dockLayout && DT.findView(this.dockLayout.root);
        if (!v || !v.parent || !v.node.tab || !v.node.behind) return false;
        const mates = DT.tabMates(v.parent.children, v.node.tab);
        const was = mates.find((p) => !p.hidden && !p.behind && p !== v.node);
        if (was && was.size > 0) v.node.size = was.size;
        for (const p of mates) p.behind = p !== v.node;
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
        if (this.updateTransform) { try { this.updateTransform(); } catch (_) { /* drawn on the next change */ } }
        return true;
    },

    // One entry takes another's room in a place (a tab coming to the front).
    _dockTakeRoom(to, from) {
        for (const k of ["size", "px"]) { if (from[k] > 0) to[k] = from[k]; else delete to[k]; }
    },

    /** Bring a panel to the front of the place it shares. */
    dockTabFront(id) {
        const found = this._dockEntry(id);
        if (!found || found.entry.hidden) return;
        const mates = this._dockTabMates(found);
        const was = mates.find((p) => !p.hidden && !p.behind && p !== found.entry);
        if (was) this._dockTakeRoom(found.entry, was);   // the place keeps its room
        for (const p of mates) p.behind = p !== found.entry;
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    /** Put a panel into the place of another, as a tab beside it, in front. */
    dockPanelAsTab(id, ontoId) {
        const onView = ontoId === "view";
        if (id === ontoId || !DOCK_PANELS[id] || !(onView ? DT.findView(this.dockLayout.root) : DT.locate(this.dockLayout.root, ontoId))) return;
        const L = this.dockLayout;
        const entry = DT.detach(L.root, id);
        if (!entry) return;
        L.root = DT.tidy(L.root, _known);
        L.root = DT.tidy(DT.insertAsTab(L.root, ontoId, entry), _known);
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    // ── Mutations (each ends in one applyDockLayout) ─────────────────────────

    /** Show or hide a panel, keeping the place it had. */
    setPanelDocked(id, visible) {
        id = _dockId(id);
        const found = this._dockEntry(id);
        if (!found) return;
        found.entry.hidden = !visible;
        // Opened: it comes up in front of the place it shares.
        if (visible && found.entry.tab) {
            const mates = this._dockTabMates(found);
            const was = mates.find((p) => !p.hidden && !p.behind && p !== found.entry);
            if (was) this._dockTakeRoom(found.entry, was);
            for (const p of mates) p.behind = p !== found.entry;
        }
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    togglePanelDocked(id) {
        this.setPanelDocked(id, !this.isPanelDocked(id));
        return this.isPanelDocked(id);
    },

    /** Move a panel into a rail - the place beside the picture on `side` - at `index` (default: its end). */
    dockPanelTo(id, side, index) {
        if (!DOCK_PANELS[id] || !RAIL_SIDES.includes(side)) return;
        const L = this.dockLayout;
        const entry = DT.detach(L.root, id);
        if (!entry) return;
        L.root = DT.tidy(L.root, _known);
        const rail = this._dockRail(side);
        const at = (index == null) ? rail.children.length : Math.max(0, Math.min(rail.children.length, index));
        rail.children.splice(at, 0, entry);
        // Sizes are shares, so a stack of new arrivals should start out even.
        rail.children.forEach((p) => { if (!(p.px > 0)) p.size = 1; });
        L.root = DT.tidy(L.root, _known);
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    /**
     * Move a panel beside a place: `ref` is { kind: "panel", id } | { kind: "view" } (the picture) | { kind: "root" }
     * (the whole area), `edge` "left" / "right" / "top" / "bottom". That place is split in two, or the panel joins
     * the split it is in when that runs the same way.
     */
    dockPanelBeside(id, ref, edge) {
        if (!DOCK_PANELS[id] || !DT.EDGES.includes(edge) || !ref) return false;
        if (ref.kind === "panel" && (ref.id === id || !DT.locate(this.dockLayout.root, ref.id))) return false;
        const L = this.dockLayout;
        const entry = DT.detach(L.root, id);
        if (!entry) return false;
        entry.hidden = false;
        L.root = DT.tidy(L.root, _known);
        const node = ref.kind === "view" ? DT.findView(L.root).node
            : ref.kind === "root" ? L.root
            : DT.locate(L.root, ref.id)?.node;
        const spec = DOCK_PANELS[id];
        const px = DT.edgeDir(edge) === "row" ? Math.max(spec.minW, 300) : Math.max(spec.minH, 240);
        L.root = DT.tidy(DT.insertBeside(L.root, node || L.root, edge, entry, px), _known);
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
        return true;
    },

    /**
     * Wake up any panel that has just come into view.
     *
     * A panel becomes visible by several routes — its toolbar toggle, a
     * restored layout, the session state reloading, a drag that lands it
     * somewhere — and each of them used to have to remember to fill the panel
     * in. Restoring the session did not, so leaving the file browser open and
     * reloading gave you the panel with an empty path bar and no listing: it
     * looked broken when it had simply never been told to fetch.
     *
     * Every one of those routes ends in applyDockLayout, so the notice belongs
     * here and the callers can forget about it.
     */
    _notifyPanelsShown() {
        const before = this._dockShown || new Set();
        const now = new Set();
        // In front counts: a tab brought up is a panel coming into view.
        for (const p of DT.panels(this.dockLayout.root)) if (!p.hidden && !p.behind) now.add(p.id);
        this._dockShown = now;
        if (before.has("agentChat") && !now.has("agentChat")) {
            try { this._agentPanelRelease(); }
            catch (e) { console.warn("imageViewer: agentY panel could not go back", e); }
        }
        for (const id of now) {
            if (before.has(id)) continue;
            try { this._onPanelShown(id); }
            catch (e) { console.warn(`imageViewer: ${id} panel failed to wake up`, e); }
        }
    },

    _onPanelShown(id) {
        if (id === "browser") {
            // First time up, go and read a folder; after that the listing it
            // already holds is still good.
            if (!this._browserLoaded) this.browseTo(this._browserDir, { force: true });
            else this._renderBrowserList();
        } else if (id === "history") {
            this._historyPanelSig = null;
            if (this.renderHistoryPanel) this.renderHistoryPanel();
        } else if (id === "params") {
            if (this._cpParamsMode) { if (this.compPanelShown) this.compPanelShown(); this._cpParamsTitle?.(); }
            else if (this._cbParamsMode) { if (this._previzRenderChannels) this._previzRenderChannels(); }
            else if (this.updateParamsPanel) this.updateParamsPanel(true);
        } else if (id === "editTimeline" || id === "editInspector" || id === "editEffects" || id === "editMixer" || id === "editSource") {
            if (this.editTlRefresh) this.editTlRefresh();
        } else if (id === "curves") {
            if (this.previzRefreshCurves) this.previzRefreshCurves();
        } else if (id === "view2") {
            if (this.view2Wake) this.view2Wake();
        } else if (id === "dopeSheet") {
            if (this.previzRefreshDopeSheet) this.previzRefreshDopeSheet();
        } else if (id === "clips") {
            if (this.previzRefreshClips) this.previzRefreshClips();
        } else if (id === "rotoCurves") {
            if (this.rotoRefreshCurves) this.rotoRefreshCurves();
        } else if (id === "paramCurves") {
            if (this.paramRefreshCurves) this.paramRefreshCurves();
        } else if (id === "motionProps" || id === "motionTimeline") {
            if (this._mgOn && this._mgSeat) this._mgSeat(this._mgState().tabs[this.activeTab]);
        } else if (id === "compGraph" || id === "compLayers" || id === "compCurves") {
            if (this.compPanelShown) this.compPanelShown();
        } else if (id.startsWith("paint")) {
            if (this._paintOn && this._paintSeat) this._paintSeat(this._paintActive());
        } else if (id === "editTimeline") {
            if (this.editTlRefresh) this.editTlRefresh();
        } else if (id === "layers3d") {
            if (this._plRender) this._plRender(true);
        } else if (id === "picker") {
            if (this._pkRender) this._pkRender(true);
        } else if (id === "mmGuide" || id === "mmPlate") {
            if (this._mmPanelShown) this._mmPanelShown(id);
        } else if (id === "animLayers") {
            if (this._alRender) this._alRender();
        } else if (id === "agentChat") {
            if (this._agentPanelMount) this._agentPanelMount();
        } else if (id === "previz") {
            // A panel with nothing to show puts itself away again: without a
            // scene on the tab there is no outliner, no transform and no keys.
            if (this._previzRenderPanel) this._previzRenderPanel();
        }
    },

    /** The toolbar's toggles, lit from the dock rather than from each other. */
    _syncPanelToggleButtons() {
        if (this.historyToggleBtn) {
            this.historyToggleBtn.classList.toggle("active", this.isPanelDocked("history"));
        }
        if (this.browserToggleBtn) {
            this.browserToggleBtn.classList.toggle("active", this.isPanelDocked("browser"));
        }
        // Previz and its curves are reached from the 3D toolbar, over the
        // canvas they belong to, rather than from the playback bar.
        if (this._syncModelPanelButtons) this._syncModelPanelButtons();
        if (this.paramsBtn) {
            const open = this.isPanelDocked("params");
            this.paramsBtn.style.color = open ? "#f60" : "#eee";
            this.paramsBtn.classList.toggle("active", open);
        }
        // The ∿ in the Parameters header, lit while Parameter Curves is up.
        if (this._paramAnimSyncCurvesButton) this._paramAnimSyncCurvesButton(!!this.paramAnimNode?.());
        // Closing the Parameters panel takes the key bar off its node.
        if (this.keyBarSync) this.keyBarSync();
        // The bar's groups are lit by what is up.
        if (this.barGroupsSync) this.barGroupsSync();
    },

    // ── Splitters ────────────────────────────────────────────────────────────

    /**
     * Pointer-capture drag helper.
     *
     * Capture is per ELEMENT, not per window, so a drag started here keeps
     * receiving moves after the viewer is popped out into another document —
     * which listeners bound to `window` do not (see the undock notes on
     * _watchViewportResize).
     */
    _pointerDrag(el, e, onMove, onUp) {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        let done = false;
        const move = (ev) => { if (!done) onMove(ev); };
        const up = (ev) => {
            if (done) return;
            done = true;
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            el.removeEventListener("lostpointercapture", up);
            try { el.releasePointerCapture(e.pointerId); } catch (_) {}
            if (onUp) onUp(ev);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        // Capture taken away (the window lost the button, the header was re-parented): the drag is over; without
        // this the overlay and the dimmed panel stayed up until a reload.
        el.addEventListener("lostpointercapture", up);
    },

    /**
     * The splitter between two places of a split. A fixed place (a rail's width, a panel beside the picture) takes
     * the pointer's travel; two shares trade between them; two fixed places trade pixels.
     */
    _dockBindSplitter(sp, split, a, b) {
        sp.addEventListener("pointerdown", (e) => {
            const aEl = this._dockNodeEl(a), bEl = this._dockNodeEl(b);
            if (!aEl || !bEl) return;
            const row = split.split === "row";
            const axis = row ? "width" : "height";
            const mk = row ? "w" : "h";
            const startAt = row ? e.clientX : e.clientY;
            const aS = aEl.getBoundingClientRect()[axis];
            const bS = bEl.getBoundingClientRect()[axis];
            const total = aS + bS;
            if (total <= 0) return;
            const aMin = DT.minSize(a, mk, _minOf, GAP), bMin = DT.minSize(b, mk, _minOf, GAP);
            const flex = DT.flexOf(split);
            const fixed = (n) => { const f = flex.find((x) => x.node === n); return !!f && f.grow === 0 && typeof f.basis === "number"; };
            const fa = fixed(a), fb = fixed(b);
            const byPx = !flex.some((f) => f.basis === 0 && !(f.node.px > 0 && !DT.containsView(f.node)));
            const share = (a.size > 0 ? a.size : 1) + (b.size > 0 ? b.size : 1);

            sp.classList.add("dragging");
            this._pointerDrag(sp, e, (ev) => {
                const d = (row ? ev.clientX : ev.clientY) - startAt;
                const na = Math.max(aMin, Math.min(total - bMin, aS + d));
                if (fa && fb || byPx) { a.px = Math.round(na); b.px = Math.round(total - na); }
                else if (fa) a.px = Math.round(na);
                else if (fb) b.px = Math.round(total - na);
                else { a.size = share * (na / total); b.size = share - a.size; }
                this._dockFlexSplit(split, true);
                if (this._afterViewportMoved) this._afterViewportMoved();
            }, () => {
                sp.classList.remove("dragging");
                if (this._afterViewportMoved) this._afterViewportMoved();
                this.queuePersistViewerState && this.queuePersistViewerState();
            });
        });
    },

    // ── Drag a panel by its header to re-dock it ─────────────────────────────

    /**
     * Give a panel its title bar, once.
     *
     * Built here rather than written into the markup three times: the bar is
     * the same for every panel and the dock already knows their names. It is
     * also the drag handle — the content headers below it carry real controls
     * (a node title, a folder path, buttons), so grabbing one to move a panel
     * always felt like grabbing the wrong thing.
     */
    _ensurePanelTitlebar(id) {
        const el = this._dockPanelEl(id);
        if (!el) return null;
        let bar = el.querySelector(":scope > .panel-titlebar");
        if (!bar) {
            const doc = el.ownerDocument;
            bar = doc.createElement("div");
            bar.className = "panel-titlebar";

            // The switch (Blender's editor-type button): the panel is a container, and this
            // changes what it holds, in place (dockSwitchPanel). Was a plain drag grip.
            const grip = doc.createElement("button");
            grip.className = "pt-switch";
            grip.id = `${id}-switch-btn`;
            grip.title = "Show another panel here";
            grip.setAttribute("aria-haspopup", "menu");
            this._dockSwitchIcon(grip);
            const name = doc.createElement("span");
            name.className = "pt-name";
            name.textContent = DOCK_PANELS[id].label;
            // No Switch Side button: dragging the bar puts the panel exactly
            // where you want it, including which rail and in what order, so a
            // button that only flips it between two of those was redundant.
            const hide = doc.createElement("button");
            hide.className = "pt-btn pt-close";
            hide.id = `${id}-hide-btn`;
            hide.title = "Hide this panel";
            hide.textContent = "\u2715";
            // Fold to the title bar, and fill the viewer for a while (Houdini's maximise): two small buttons.
            const fold = doc.createElement("button");
            fold.className = "pt-btn pt-fold";
            fold.id = `${id}-fold-btn`;
            const max = doc.createElement("button");
            max.className = "pt-btn pt-max";
            max.id = `${id}-max-btn`;
            this._dockBarIcons(id, fold, max);

            bar.append(grip, name, fold, max, hide);
            el.insertBefore(bar, el.firstChild);

            for (const b of [fold, max, grip]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
            grip.addEventListener("click", (e) => { e.stopPropagation(); this._dockSwitchMenu(id, grip); });
            fold.addEventListener("click", (e) => { e.stopPropagation(); this.dockToggleCollapsed(id); });
            max.addEventListener("click", (e) => { e.stopPropagation(); this.dockToggleMaximized(id); });
            bar.addEventListener("dblclick", (e) => { if (!e.target.closest("button, select, input, a")) this.dockToggleCollapsed(id); });

            hide.addEventListener("pointerdown", (e) => e.stopPropagation());
            hide.addEventListener("click", (e) => { e.stopPropagation(); this.setPanelDocked(id, false); });

            bar.addEventListener("pointerdown", (e) => this._onDockHeaderDown(id, bar, e));
        }
        return bar;
    },

    // ── The main view as a panel ─────────────────────────────────────────────
    //
    // The picture's place has a title bar of its own (Sebastian 2026-11-19: "main views should become panels as
    // well"): its switch picks the tab it shows, its name says which, it is dragged like any panel - beside a
    // panel, a place or the whole area, or onto a panel's middle to trade places with it - and it fills the
    // viewer with the maximise button. It has no close and no fold: there is always one.

    _ensureViewTitlebar() {
        const el = this.dockViewEl;
        if (!el) return null;
        let bar = el.querySelector(":scope > .panel-titlebar");
        if (bar) return bar;
        const doc = el.ownerDocument;
        bar = doc.createElement("div");
        bar.className = "panel-titlebar view-titlebar";
        const grip = doc.createElement("button");
        grip.className = "pt-switch";
        grip.id = "view-switch-btn";
        grip.title = "Show another tab here";
        grip.setAttribute("aria-haspopup", "menu");
        this._dockSwitchIcon(grip);
        const name = doc.createElement("span");
        name.className = "pt-name";
        const max = doc.createElement("button");
        max.className = "pt-btn pt-max";
        max.id = "view-max-btn";
        const fold = doc.createElement("button");      // only for _dockBarIcons; never shown
        bar.append(grip, name, max);
        el.insertBefore(bar, el.firstChild);
        this._dockViewFold = fold;
        this._dockBarIcons(VIEW_ID, fold, max);
        for (const b of [max, grip]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
        grip.addEventListener("click", (e) => { e.stopPropagation(); this._dockViewMenu(grip); });
        max.addEventListener("click", (e) => { e.stopPropagation(); this.dockToggleMaximized(VIEW_ID); });
        bar.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) this.dockToggleMaximized(VIEW_ID); });
        bar.addEventListener("pointerdown", (e) => this._onDockHeaderDown(VIEW_ID, bar, e));
        this.dockViewTitleSync();
        return bar;
    },

    _dockViewLabel(key) {
        if (!key) return "";
        if (this._historyTabLabel) { try { return this._historyTabLabel(key) || key; } catch (_) { /* below */ } }
        return key;
    },

    /** The main view's name: the tab it shows. Called by switchTab and whenever the layout is drawn. */
    dockViewTitleSync() {
        const bar = this.dockViewEl && this.dockViewEl.querySelector(":scope > .panel-titlebar");
        const name = bar && bar.querySelector(":scope > .pt-name");
        // A matchmove's plate may stand in the main view in place of the 3D view (imageViewer_previzMatchmove.js).
        const plate = this._mmPlateOverlayShow ? this._mmPlateOverlayShow() : false;
        if (!name) return;
        const label = this._dockViewLabel(this.activeTab);
        name.title = label ? `Main view: ${label}` : "Main view";
        // Sharing its place with panels as tabs: the tabs carry the name (the label changes with the tab shown).
        if (name._tabs) { this._syncDockTabs(); return; }
        const text = this._dockViewText(plate);
        if (name.textContent !== text) name.textContent = text;
    },

    /** What the main view is called: the tab it shows. */
    _dockViewText(plate) {
        if (plate === undefined) plate = !!(this._mmPlateMainShown && this._mmPlateMainShown());
        const label = this._dockViewLabel(this.activeTab);
        return plate ? `Plate · ${label || "3D"}` : label ? label : "Main view";
    },

    /** The main view's switch: every open tab, the one shown ticked; then the panels it can trade places with. */
    _dockViewMenu(btn) {
        if (this._previzAddMenu) { const was = this._dockSwitchOpen; this._previzCloseAddMenu(); if (was === VIEW_ID) return; }
        const entries = [{ head: "Show in the main view" }];
        const tabs = (Array.isArray(this.tabOrder) ? this.tabOrder : Object.keys(this.allTabs || {}))
            .filter((k) => this.allTabs && this.allTabs[k]);
        for (const k of tabs) {
            const here = k === this.activeTab;
            entries.push({ label: (here ? "\u2713  " : "     ") + this._dockViewLabel(k),
                           title: here ? "Shown here" : "Show this tab here",
                           run: () => { if (!here && this.switchTab) this.switchTab(k); } });
        }
        const extra = this.matchmoveViewEntries ? this.matchmoveViewEntries() : [];
        if (extra.length) entries.push("-", ...extra);
        const mates = DT.panels(this.dockLayout.root).filter((p) => !p.hidden && !p.behind && !p.tab && this._dockPanelEl(p.id));
        if (mates.length) {
            entries.push("-", { head: "Trade places with" });
            for (const p of mates) entries.push({ label: "     " + DOCK_PANELS[p.id].label, title: "The main view and this panel swap places",
                                                  run: () => this.dockViewSwap(p.id) });
        }
        const r = btn.getBoundingClientRect();
        const menu = this._previzOpenMenu && this._previzOpenMenu(entries, r.left, r.bottom + 3, btn);
        if (!menu) return;
        menu.classList.add("bar-menu", "pt-switch-menu", "view-switch-menu");
        this._dockSwitchOpen = VIEW_ID;
        btn.classList.add("open");
        const win = btn.ownerDocument.defaultView || window;
        const off = () => { if (!menu.isConnected) { btn.classList.remove("open"); this._dockSwitchOpen = null; } else win.requestAnimationFrame(off); };
        win.requestAnimationFrame(off);
    },

    /** Take the view node out of the tree as it is (no tidy: tidy would put a new one back). */
    _dockTakeView(root) {
        const at = DT.findView(root);
        if (!at || !at.parent) return null;
        at.parent.children.splice(at.index, 1);
        const v = at.node;
        delete v.px; delete v.size;
        return v;
    },

    /**
     * Move the main view beside a place: `ref` as dockPanelBeside's ({ kind: "panel", id } | { kind: "root" }),
     * `edge` left / right / top / bottom. The view takes a share; the panels keep what they had.
     */
    dockViewBeside(ref, edge) {
        if (!DT.EDGES.includes(edge) || !ref || ref.kind === "view") return false;
        const L = this.dockLayout;
        if (ref.kind === "panel" && !DT.locate(L.root, ref.id)) return false;
        const v = this._dockTakeView(L.root);
        if (!v) return false;
        const node = ref.kind === "root" ? L.root : DT.locate(L.root, ref.id).node;
        L.root = DT.tidy(DT.insertBeside(L.root, node, edge, v), _known);
        this._dockAfterViewMove();
        return true;
    },

    /** The main view and a panel trade places (each takes the other's room). A panel in a tab group stays put. */
    dockViewSwap(panelId) {
        const L = this.dockLayout;
        const p = DT.locate(L.root, _dockId(panelId)), v = DT.findView(L.root);
        if (!p || !v || !p.parent || !v.parent || p.node.tab || v.node.tab || p.node.hidden) return false;
        const room = (n) => ({ px: n.px, size: n.size });
        const rp = room(p.node), rv = room(v.node);
        p.parent.children[p.index] = v.node;
        v.parent.children[v.index] = p.node;
        const put = (n, r) => { delete n.px; delete n.size; if (r.px > 0) n.px = r.px; if (r.size > 0) n.size = r.size; };
        put(v.node, rp); put(p.node, rv);
        // The panel had the view's room, which was a share: it keeps the view's share where the view's chain was.
        L.root = DT.tidy(L.root, _known);
        this._dockAfterViewMove();
        return true;
    },

    _dockAfterViewMove() {
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
        // The picture's box changed: fit it again (the viewer's own resize observer does too, a frame later).
        if (this.updateTransform) { try { this.updateTransform(); } catch (_) { /* drawn on the next change */ } }
    },

    // ── Switching what a panel shows (the button left of its name) ──────────

    _dockSwitchIcon(btn) {
        const doc = btn.ownerDocument, NS = "http://www.w3.org/2000/svg";
        const svg = (paths, cls) => {
            const s = doc.createElementNS(NS, "svg");
            s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
            s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
            if (cls) s.setAttribute("class", cls);
            for (const [tag, at] of paths) {
                const n = doc.createElementNS(NS, tag);
                for (const [k, v] of Object.entries(at)) n.setAttribute(k, v);
                s.append(n);
            }
            return s;
        };
        // Lucide's panels-top-left and chevron-down, as shapes (ISC licence).
        btn.replaceChildren(
            svg([["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M3 9h18" }], ["path", { d: "M9 21V9" }]]),
            svg([["path", { d: "m6 9 6 6 6-6" }]], "pt-caret"));
    },

    /**
     * The panels a place can switch to, by space: [{ title, items: [{ id, label }] }].
     * The bar's groups say which panels belong to which space and when they can be up
     * (BarGroupsMixin.panelSwitchGroups); without them, every panel there is.
     */
    _dockSwitchGroups() {
        if (this.panelSwitchGroups) return this.panelSwitchGroups();
        return [{ title: "Panels", items: Object.keys(DOCK_PANELS).filter((id) => this._dockPanelEl(id))
            .map((id) => ({ id, label: DOCK_PANELS[id].label })) }];
    },

    _dockSwitchMenu(id, btn) {
        if (this._previzAddMenu) { const was = this._dockSwitchOpen; this._previzCloseAddMenu(); if (was === id) return; }
        const entries = [];
        for (const g of this._dockSwitchGroups()) {
            if (entries.length) entries.push("-");
            entries.push({ head: g.title });
            for (const it of g.items) {
                const here = it.id === _dockId(id);
                const elsewhere = !here && this.isPanelDocked(it.id);
                entries.push({
                    label: (here ? "\u2713  " : "     ") + it.label,
                    title: here ? "Shown here" : elsewhere ? "Open in another place: the two swap places" : "Show it here instead",
                    run: () => { if (!here) this.dockSwitchPanel(id, it.id); },
                });
            }
        }
        const r = btn.getBoundingClientRect();
        const menu = this._previzOpenMenu && this._previzOpenMenu(entries, r.left, r.bottom + 3, btn);
        if (!menu) return;
        menu.classList.add("bar-menu", "pt-switch-menu");
        this._dockSwitchOpen = id;
        btn.classList.add("open");
        // Lit while its menu is up; any way the menu goes puts it out.
        const win = btn.ownerDocument.defaultView || window;
        const off = () => { if (!menu.isConnected) { btn.classList.remove("open"); this._dockSwitchOpen = null; } else win.requestAnimationFrame(off); };
        win.requestAnimationFrame(off);
    },

    /**
     * Show `toId` in the place `fromId` has: the panels are containers, this changes what one holds.
     * The two trade places - the one asked for comes up where the other was (its share of the rail,
     * its tabs, folded or not), and the other goes where it was: hidden if it was hidden, else
     * shown there, so a panel open elsewhere is never lost. One dockLayout change.
     */
    dockSwitchPanel(fromId, toId) {
        fromId = _dockId(fromId); toId = _dockId(toId);
        if (fromId === toId || !DOCK_PANELS[toId] || !this._dockPanelEl(toId)) return false;
        const a = this._dockEntry(fromId), b = this._dockEntry(toId);
        if (!a || !b) return false;
        const PLACE = ["size", "px", "tab", "behind", "collapsed", "hidden"];
        const take = (e) => Object.fromEntries(PLACE.map((k) => [k, e[k]]));
        const pa = take(a.entry), pb = take(b.entry);
        const put = (e, p) => { for (const k of PLACE) { if (p[k] === undefined) delete e[k]; else e[k] = p[k]; } };
        a.list[a.index] = b.entry;
        b.list[b.index] = a.entry;
        put(b.entry, pa); put(a.entry, pb);
        b.entry.hidden = false;
        if (this._dockMaxId === fromId) this._dockMaxId = toId;
        else if (this._dockMaxId === toId) this._dockMaxId = fromId;
        // (A place as narrow as the history strip is widened to the newcomer's minimum when it is drawn.)
        // The Edit panels remember which of them are up for the next cut's tab.
        if (this._editTlWant && this.isEditTab && this.isEditTab()) {
            for (const [pid, on] of [[fromId, !pb.hidden], [toId, true]]) {
                if (/^edit(Timeline|Inspector|Effects|Mixer)$/.test(pid)) this._editTlWant(pid, on);
            }
        }
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
        if (this.barGroupsSync) this.barGroupsSync();
        if (this.editTlRefresh && this.isEditTab && this.isEditTab()) this.editTlRefresh();
        return true;
    },

    // ── Folding a panel, and one panel filling the viewer ───────────────────

    _dockEntryOf(id) {
        const found = this._dockEntry(id);
        return found ? found.entry : null;
    },

    isPanelCollapsed(id) { const e = this._dockEntryOf(id); return !!(e && e.collapsed); },

    /** Fold a panel to its title bar (kept in the layout), or open it again. A tab group folds as one. */
    dockToggleCollapsed(id, on) {
        const found = this._dockEntry(id);
        if (!found) return;
        const e = found.entry;
        const want = on === undefined ? !e.collapsed : !!on;
        if (want && this._dockMaxId === id) this._dockMaxId = null;
        const group = this._dockTabMates(found);
        for (const p of group) { if (want) p.collapsed = true; else delete p.collapsed; }
        this.applyDockLayout();
        if (this.queuePersistViewerState) this.queuePersistViewerState();
    },

    isPanelMaximized(id) { return this._dockMaxId === id; },

    /** One panel over the whole viewer between its tab bar and its transport, until pressed again (not saved). */
    dockToggleMaximized(id, on) {
        const want = on === undefined ? this._dockMaxId !== id : !!on;
        if (want && id === VIEW_ID && this.isViewBehind()) this.dockViewFront();
        if (want && id !== VIEW_ID) {
            const e = this._dockEntryOf(id);
            if (!e || e.hidden) return;
            if (e.collapsed) this.dockToggleCollapsed(id, false);
            if (e.behind) this.dockTabFront(id);
        }
        this._dockMaxId = want ? id : (this._dockMaxId === id ? null : this._dockMaxId);
        this.applyDockLayout();
    },

    _dockBarIcons(id, fold, max) {
        const doc = fold.ownerDocument;
        const svg = (d) => {
            const NS = "http://www.w3.org/2000/svg";
            const s = doc.createElementNS(NS, "svg");
            s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
            s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
            for (const pd of d) { const p = doc.createElementNS(NS, "path"); p.setAttribute("d", pd); s.append(p); }
            return s;
        };
        const folded = this.isPanelCollapsed(id), maxed = this.isPanelMaximized(id);
        const fk = folded ? "f1" : "f0", mk = maxed ? "m1" : "m0";
        // Lucide's chevron-down / chevron-up, maximize-2 / minimize-2 (as shapes, ISC licence).
        if (fold.dataset.k !== fk) {
            fold.dataset.k = fk;
            fold.replaceChildren(svg([folded ? "m6 9 6 6 6-6" : "m18 15-6-6-6 6"]));
            fold.title = folded ? "Open this panel again (or double-click its title)" : "Fold this panel to its title bar (or double-click its title)";
        }
        if (max.dataset.k !== mk) {
            max.dataset.k = mk;
            max.replaceChildren(svg(maxed ? ["m14 10 7-7", "M20 10h-6V4", "m3 21 7-7", "M4 14h6v6"] : ["M15 3h6v6", "m21 3-7 7", "m3 21 7-7", "M9 21H3v-6"]));
            max.title = maxed ? "Put this panel back" : "Fill the viewer with this panel";
            max.classList.toggle("on", maxed);
        }
    },

    /** Lay the maximised panel over the viewer (fixed, so no rail's overflow clips it) and keep it there. */
    _dockMaxSync() {
        const id = this._dockMaxId;
        const e = id && id !== VIEW_ID && this._dockEntryOf(id);
        if (id && id !== VIEW_ID && (!e || e.hidden || e.behind)) this._dockMaxId = null;
        const cur = this._dockMaxId;
        const vbar = this.dockViewEl && this.dockViewEl.querySelector(":scope > .panel-titlebar");
        const vmax = vbar && vbar.querySelector(":scope > .pt-max");
        if (vmax && this._dockViewFold) this._dockBarIcons(VIEW_ID, this._dockViewFold, vmax);
        const vel = this.dockViewEl;
        if (vel && cur !== VIEW_ID && vel.classList.contains("dock-max")) {
            vel.classList.remove("dock-max");
            for (const k of ["position", "left", "top", "width", "height", "zIndex"]) vel.style[k] = "";
        }
        this.dockViewTitleSync();
        for (const pid of Object.keys(DOCK_PANELS)) {
            const el = this._dockPanelEl(pid);
            if (!el) continue;
            const bar = el.querySelector(":scope > .panel-titlebar");
            const fold = bar && bar.querySelector(":scope > .pt-fold"), max = bar && bar.querySelector(":scope > .pt-max");
            if (fold && max) this._dockBarIcons(pid, fold, max);
            const on = pid === cur;
            if (!on && el.classList.contains("dock-max")) {
                el.classList.remove("dock-max");
                for (const k of ["position", "left", "top", "width", "height", "zIndex"]) el.style[k] = "";
            }
        }
        this.container && this.container.classList.toggle("has-dock-max", !!cur);
        if (!cur) { this._dockMaxPlace = null; return; }
        const el = cur === VIEW_ID ? this.dockViewEl : this._dockPanelEl(cur);
        if (!el) { this._dockMaxId = null; return; }
        el.classList.add("dock-max");
        const place = () => {
            if (this._dockMaxId !== cur || !el.isConnected) return;
            const c = this.container, sr = this.shadowRoot;
            const top = sr.querySelector(".main-area"), ctl = sr.querySelector(".controls");
            const cr = c.getBoundingClientRect();
            const y0 = top ? top.getBoundingClientRect().top : cr.top;
            const y1 = ctl && ctl.offsetParent ? ctl.getBoundingClientRect().top : cr.bottom;
            const want = `${cr.left}|${y0}|${cr.width}|${y1 - y0}`;
            if (el._maxAt !== want) {
                el._maxAt = want;
                Object.assign(el.style, { position: "fixed", left: `${cr.left}px`, top: `${y0}px`, width: `${cr.width}px`,
                                          height: `${Math.max(60, y1 - y0)}px`, zIndex: "60" });
            }
            (el.ownerDocument.defaultView || window).requestAnimationFrame(place);
        };
        el._maxAt = "";                      // placed again on the next frame
        if (this._dockMaxPlace !== cur) { this._dockMaxPlace = cur; place(); }
    },

    _bindDockDrag() {
        for (const id of Object.keys(DOCK_PANELS)) this._ensurePanelTitlebar(id);
    },

    _onDockHeaderDown(id, header, e) {
        if (e.button !== 0) return;
        // The header carries real controls; a press on one of those is a click.
        if (e.target.closest("button, select, input, a")) return;

        const startX = e.clientX, startY = e.clientY;
        let started = false;
        let target = null;

        this._pointerDrag(header, e, (ev) => {
            if (!started) {
                if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_SLOP) return;
                started = true;
                this._beginDockDrag(id);
            }
            target = this._dockDropTarget(ev.clientX, ev.clientY, id);
            this._paintDockPreview(target, ev.clientX, ev.clientY, id);
        }, () => {
            if (!started) return;
            const cancelled = !!this._dockDragCancelled;
            this._endDockDrag(id);
            if (cancelled) return;
            this._dockDrop(id, target);
        });
    },

    /** What a drop does: into a place as a tab, or beside a place (which splits it). */
    _dockDrop(id, target) {
        if (!target) return false;
        if (id === VIEW_ID) {
            if (target.kind === "tab") return this.dockViewSwap(target.ref.id);
            if (target.kind === "edge") return this.dockViewBeside(target.ref, target.edge);
            return false;
        }
        if (target.kind === "tab") { this.dockPanelAsTab(id, target.ref.kind === "view" ? "view" : target.ref.id); return true; }
        if (target.kind === "edge") return this.dockPanelBeside(id, target.ref, target.edge);
        return false;
    },

    _beginDockDrag(id) {
        this._dockDragId = id;
        // Escape cancels ONE drag. The flag used to be set and never cleared, so after a single Escape every later
        // drag found "nowhere" to drop and panels could not be moved again until the page was reloaded.
        this._dockDragCancelled = false;
        // An embedded frame under the pointer must not take the moves away from the header.
        this.container?.classList?.add("dock-drag-on");
        const el = id === VIEW_ID ? this.dockViewEl : this._dockPanelEl(id);
        if (el) {
            el.classList.add("dock-dragging");
            const bar = el.querySelector(":scope > .panel-titlebar");
            if (bar) bar.classList.add("dragging");
        }
        if (!this.dockOverlay) return;

        const doc = this.dockOverlay.ownerDocument;
        this.dockOverlay.innerHTML = "";
        this._dockPreviewEl = doc.createElement("div");
        this._dockPreviewEl.className = "dock-preview";
        this._dockGhostEl = doc.createElement("div");
        this._dockGhostEl.className = "dock-ghost";
        this._dockGhostEl.textContent = id === VIEW_ID ? "Main view" : DOCK_PANELS[id].label;
        this.dockOverlay.appendChild(this._dockPreviewEl);
        this.dockOverlay.appendChild(this._dockGhostEl);
        this.dockOverlay.classList.add("active");

        this._dockMeasure();

        const esc = (ev) => {
            if (ev.key !== "Escape") return;
            this._dockDragCancelled = true;
            this._endDockDrag(id);
        };
        this._dockEscHandler = esc;
        (this.container.ownerDocument.defaultView || window).addEventListener("keydown", esc, true);
    },

    _endDockDrag(id) {
        this.container?.classList?.remove("dock-drag-on");
        const el = id === VIEW_ID ? this.dockViewEl : this._dockPanelEl(id);
        if (el) {
            el.classList.remove("dock-dragging");
            const bar = el.querySelector(":scope > .panel-titlebar");
            if (bar) bar.classList.remove("dragging");
        }
        if (this.dockOverlay) {
            this.dockOverlay.classList.remove("active");
            this.dockOverlay.innerHTML = "";
        }
        this._dockPreviewEl = this._dockGhostEl = null;
        this._dockDragId = null;
        if (this._dockEscHandler) {
            (this.container.ownerDocument.defaultView || window)
                .removeEventListener("keydown", this._dockEscHandler, true);
            this._dockEscHandler = null;
        }
    },

    // Measured once per drag: nothing moves until the drop, so every pointermove after this is arithmetic — no
    // layout reads, no thrash.
    _dockMeasure() {
        const mainArea = (this.dockOverlay && this.dockOverlay.parentNode) || this._dockRootEl.parentNode;
        const view = this.dockViewEl || this.viewport;
        this._dockRects = {
            main: mainArea.getBoundingClientRect(),
            root: this._dockRootEl.getBoundingClientRect(),
            viewport: view.getBoundingClientRect(),
            panels: [],
        };
        for (const p of DT.panels(this.dockLayout.root)) {
            if (p.hidden || p.behind) continue;
            const pel = this._dockPanelEl(p.id);
            if (!pel) continue;
            const r = pel.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) this._dockRects.panels.push({ id: p.id, r });
        }
        return this._dockRects;
    },

    /**
     * Where would a drop at (x, y) put the panel? null for "nowhere".
     *
     * Along the whole area's edge: beside everything. Over a docked panel: its middle means INTO its place, as a
     * tab; nearer an edge, beside it on that edge (the place splits in two). Over the outer part of the picture:
     * beside the picture on that side; its middle: into the main view's place, as a tab.
     */
    _dockDropTarget(x, y, dragId) {
        const R = this._dockRects;
        if (!R) return null;
        if (this._dockDragCancelled) return null;

        const inside = (r) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        const m = R.root;
        if (inside(m)) {
            const d = { left: x - m.left, right: m.right - x, top: y - m.top, bottom: m.bottom - y };
            const edge = DT.EDGES.find((k) => d[k] < ROOT_ZONE);
            if (edge) return { kind: "edge", ref: { kind: "root" }, edge, r: m, side: edge };
        }
        for (const p of R.panels) {
            if (!inside(p.r)) continue;
            if (p.id === dragId) return null;
            const fx = (x - p.r.left) / Math.max(1, p.r.width), fy = (y - p.r.top) / Math.max(1, p.r.height);
            // The main view dropped on a panel's middle trades places with it (not with one of a tab group, nor while
            // it is a tab itself).
            const tabbed = dragId === VIEW_ID && (DT.locate(this.dockLayout.root, p.id)?.node?.tab || DT.findView(this.dockLayout.root)?.node?.tab);
            if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7 && !tabbed) return { kind: "tab", ref: p };
            const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
            const edge = DT.EDGES.reduce((a, k) => (d[k] < d[a] ? k : a), "left");
            return { kind: "edge", ref: { kind: "panel", id: p.id }, edge, r: p.r, side: edge };
        }
        const v = R.viewport;
        if (dragId === VIEW_ID) return null;
        if (inside(v)) {
            const fx = (x - v.left) / Math.max(1, v.width), fy = (y - v.top) / Math.max(1, v.height);
            // Above and below are shallower bands than the sides: a strip over or under the picture, not half of it.
            let edge = null;
            if (fx <= EDGE_ZONE) edge = "left";
            else if (fx >= 1 - EDGE_ZONE) edge = "right";
            else if (fy >= 1 - EDGE_ZONE / 2) edge = "bottom";
            else if (fy <= EDGE_ZONE / 2) edge = "top";
            if (edge) return { kind: "edge", ref: { kind: "view" }, edge, r: v, side: edge };
            // The middle of the picture: into its place, as a tab of the main view.
            return { kind: "tab", ref: { kind: "view", r: v }, r: v };
        }
        return null;
    },

    _paintDockPreview(target, x, y, dragId) {
        const prev = this._dockPreviewEl, ghost = this._dockGhostEl, R = this._dockRects;
        if (!prev || !R) return;
        const main = R.main;
        if (ghost) {
            ghost.style.left = `${x - main.left + 12}px`;
            ghost.style.top  = `${y - main.top + 12}px`;
        }
        if (!target) { prev.classList.remove("shown"); return; }

        const put = (l, t, w, h) => {
            prev.style.left = `${l - main.left}px`;
            prev.style.top = `${t - main.top}px`;
            prev.style.width = `${w}px`;
            prev.style.height = `${h}px`;
            prev.classList.add("shown");
        };
        const r = target.r || target.ref.r;
        // Onto a panel: the whole of it, since its place is what is shared.
        if (target.kind === "tab") { put(r.left, r.top, r.width, r.height); return; }
        // Beside a place: the band of it the panel will take - half of a panel, its own size beside the picture.
        const spec = DOCK_PANELS[dragId] || { minW: 200, minH: 150 };
        const half = target.ref.kind === "panel" || dragId === VIEW_ID;
        if (target.edge === "left" || target.edge === "right") {
            const w = Math.min(r.width / 2, half ? r.width / 2 : Math.max(spec.minW, 300));
            put(target.edge === "left" ? r.left : r.right - w, r.top, w, r.height);
            return;
        }
        const h = Math.min(r.height / 2, half ? r.height / 2 : Math.max(spec.minH, 240));
        put(r.left, target.edge === "top" ? r.top : r.bottom - h, r.width, h);
    },

    // ── Spaces: a layout each ────────────────────────────────────────────────
    //
    // Each space (Viewer, 3D, Comp, Edit, Paint, Motion, Farm; a tab of no space counts as the Viewer) keeps a layout
    // of its own (Sebastian 2026-11-19: "the spaces then become presets of panel layouts that suit each space").
    // switchTab keeps the layout of the space it leaves (dockSpaceLeave, before that space puts its panels away) and
    // brings up the layout of the space it enters (dockSpaceEnter, before that space shows its panels). A space seen
    // for the first time starts from the layout as it is; Reset gives it the default one again.

    _dockSpaceOf(tab) {
        const s = tab && this._tabSpaceKind ? this._tabSpaceKind(tab) : "";
        return s || "viewer";
    },

    /** The layouts kept per space (clean copies), { space: root }. */
    _dockSpaceMap() {
        if (!this._dockSpaces || typeof this._dockSpaces !== "object") this._dockSpaces = {};
        return this._dockSpaces;
    },

    /** Leaving `prevTab` for `nextTab`: when that changes the space, the layout as it is goes with the space left. */
    dockSpaceLeave(prevTab, nextTab) {
        if (!this.dockLayout || !DT.isTreeLayout(this.dockLayout)) return;
        const from = this._dockSpace || this._dockSpaceOf(prevTab);
        if (from === this._dockSpaceOf(nextTab)) return;
        this._dockSpaceMap()[from] = DT.cleanCopy(this.dockLayout.root);
    },

    /** Entering `tab`: its space's layout comes up (one seen for the first time keeps the layout as it is). */
    dockSpaceEnter(tab) {
        const to = this._dockSpaceOf(tab);
        if (to === this._dockSpace) return false;
        this._dockSpace = to;
        const saved = this._dockSpaceMap()[to];
        if (!saved || !DT.isSplit(saved)) return false;
        this.dockLayout = { v: DT.LAYOUT_VERSION, root: DT.tidy(DT.cleanCopy(saved), _known) };
        this.applyDockLayout();
        return true;
    },

    /** The space that is up ("viewer", "3d", "comp", "edit", "paint", "motion", "farm"). */
    dockSpace() {
        return this._dockSpace || this._dockSpaceOf(this.activeTab);
    },

    /**
     * Give the space that is up its default layout again: the rails around the picture, the Parameters panel open;
     * the space then opens its own panels as it does when its tab comes up.
     */
    dockSpaceReset() {
        const space = this.dockSpace();
        delete this._dockSpaceMap()[space];
        this._dockMaxId = null;
        this.dockLayout = this._defaultDockLayout();
        this.applyDockLayout();
        if (this.activeTab && this.switchTab) {
            try { this.switchTab(this.activeTab); } catch (e) { console.warn("imageViewer: the space could not show its panels again", e); }
        }
        this.queuePersistViewerState && this.queuePersistViewerState();
        return space;
    },

    // ── Persistence ──────────────────────────────────────────────────────────

    serializeDock() {
        this._normaliseDockLayout();
        const out = { v: DT.LAYOUT_VERSION, root: DT.cleanCopy(this.dockLayout.root) };
        // The other spaces' layouts, and which space this one is.
        const space = this.dockSpace();
        const spaces = {};
        for (const [k, root] of Object.entries(this._dockSpaceMap())) if (k !== space && DT.isSplit(root)) spaces[k] = root;
        if (Object.keys(spaces).length) out.spaces = spaces;
        out.space = space;
        return out;
    },

    /** Take a saved layout: the tree's shape, or the three rails' (read into the tree). */
    applyDockData(data) {
        if (!data || typeof data !== "object") return false;
        let L = null;
        if (DT.isTreeLayout(data)) L = { v: DT.LAYOUT_VERSION, root: DT.cleanCopy(data.root) };
        else if (DT.isRailLayout(data)) L = DT.fromRails(data);
        if (!L) return false;
        L.root = DT.tidy(L.root, _known);
        // The spaces' layouts, when the saved one has them (a layout of the rails' shape has one for all).
        if (DT.isTreeLayout(data)) {
            const spaces = {};
            if (data.spaces && typeof data.spaces === "object") {
                for (const [k, root] of Object.entries(data.spaces)) if (DT.isSplit(root)) spaces[k] = DT.cleanCopy(root);
            }
            this._dockSpaces = spaces;
            // Saved while another space was up: that one's layout is kept for it, and this space's comes up.
            const here = this.dockSpace();
            const was = typeof data.space === "string" && data.space ? data.space : here;
            if (was !== here) {
                spaces[was] = DT.cleanCopy(L.root);
                if (spaces[here]) L.root = DT.tidy(DT.cleanCopy(spaces[here]), _known);
            }
            delete spaces[here];
            this._dockSpace = here;
        }
        this.dockLayout = L;
        this.applyDockLayout();
        return true;
    },

    /**
     * Build a dock layout out of the pre-docking shape.
     *
     * Saved layouts and stored factory defaults carry `params {visible,width,
     * side}`, `history {visible,width}` and `browser {visible,width,side}`, and
     * live in the user's ComfyUI folder — they outlive this change, so they get
     * read rather than discarded. The old rule that the history strip sat
     * opposite the parameters panel is applied here to place it.
     */
    dockLayoutFromLegacy(data) {
        if (!data || (!data.params && !data.history && !data.browser)) return null;
        const px = (v, fallback) => {
            const n = parseInt(String(v || ""), 10);
            return Number.isFinite(n) && n > 0 ? n : fallback;
        };
        const paramsSide  = (data.params && data.params.side === "left") ? "left" : "right";
        const historySide = paramsSide === "left" ? "right" : "left";
        const browserSide = (data.browser && (data.browser.side === "left" || data.browser.side === "right"))
            ? data.browser.side : paramsSide;

        const layout = {
            left:   { width: 88,  panels: [] },
            right:  { width: 300, panels: [] },
            bottom: { height: 240, panels: [] },
        };
        const place = (id, side, visible, width) => {
            layout[side].panels.push({ id, size: 1, hidden: !visible });
            if (width) layout[side].width = Math.max(layout[side].width, width);
        };
        // Order within a rail: the panel nearest the viewport goes last, which
        // is where each of them used to sit.
        place("history", historySide, data.history ? !!data.history.visible : false, px(data.history && data.history.width, 88));
        place("params",  paramsSide,  data.params  ? !!data.params.visible  : true,  px(data.params && data.params.width, 300));
        place("browser", browserSide, data.browser ? !!data.browser.visible : false, px(data.browser && data.browser.width, 300));
        return layout;
    },
};

export { DOCK_PANELS };
