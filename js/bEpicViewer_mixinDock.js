// bEpicViewer_mixinDock.js
// Panel docking: where the history strip, the file browser and the parameters
// panel sit, how wide and how tall they are, and the drag that moves them.
//
// WHY THIS EXISTS
// Placement used to be spread over six insertBefore/appendChild calls in four
// files, driven by two independent side flags plus one implicit rule ("history
// goes opposite params"). Every feature that touched layout had to re-derive
// the arrangement from those, and twice got it wrong: once by assuming the
// history strip was an overlay (its stylesheet said `absolute`, the code
// overrode it to `relative`), once by adding an offset for a collision that
// could not happen. Both bugs were the same bug — no single place said where
// the panels are.
//
// So: one object says where everything is, and one function is allowed to act
// on it.
//
//   dockLayout = {
//     left:   { width: 260, panels: [{ id:'history', size:1, hidden:false }] },
//     right:  { width: 320, panels: [{ id:'browser', size:1 }, { id:'params', size:1 }] },
//     bottom: { height: 240, panels: [{ id:'curves', size:1 }] },
//   }
//
// A side rail is a vertical stack sharing one width; `size` is each panel's
// share of the rail's height. The bottom rail — under the picture, above the
// timeline — is the same idea turned ninety degrees: one height, and `size` is
// each panel's share of its width. Everything below asks _railIsRow(side)
// rather than naming "bottom", so the two read as one rule with an axis. Everything else — toggling a panel, restoring a layout,
// dropping a dragged panel — edits that object and calls applyDockLayout().
import { api } from "../../scripts/api.js";

// The dockable panels, and the room each one needs to stay usable.
const DOCK_PANELS = {
    history: { prop: "historyPanel", label: "History",    minW: 60,  minH: 90,  defaultRail: "left"  },
    // Enough for the header, the path field, a list worth reading and the
    // buttons; the preview shrinks into whatever is left over.
    browser: { prop: "browserPanel", label: "Files",      minW: 180, minH: 220, defaultRail: "right" },
    params:  { prop: "paramsPanel",  label: "Parameters", minW: 200, minH: 120, defaultRail: "right" },
    // The outliner: the scene's tree and the buttons over it. Its numbers
    // live next door, in the Channel Box, so each can be sized on its own.
    previz:  { prop: "previzPanel",  label: "Outliner",   minW: 190, minH: 140, defaultRail: "right" },
    channels: { prop: "channelsPanel", label: "Channel Box", minW: 190, minH: 160, defaultRail: "right" },
    // A graph is only readable with some height under it, so this one asks for
    // more than the rest; the channel buttons set the width.
    curves:  { prop: "curvesPanel",  label: "Animation Curves", minW: 220, minH: 190, defaultRail: "right" },
    // The roto shapes' timing, the same editor's look (bEpicViewer_rotoCurves.js);
    // the roto tool opens and closes it.
    rotoCurves: { prop: "rotoCurvesPanel", label: "Roto Curves", minW: 220, minH: 170, defaultRail: "right" },
    // The drawing tools' options; the title bar says which tool (see
    // ToolsMixin._toolShowDock). It used to float over the picture.
    // `first`: a layout saved before this panel existed gets it at the top of
    // its rail, not the bottom — it is what you work in while a tool is on.
    tool:    { prop: "toolDockPanel", label: "Tool", minW: 200, minH: 160, defaultRail: "right", first: true, size: 2 },
};
const RAIL_SIDES = ["left", "right", "bottom"];
// Which way a rail stacks: the bottom one lays its panels out side by side.
const _isRow = (side) => side === "bottom";

const RAIL_MAX = 900;
// How far into the viewport an edge drop is offered.
const EDGE_ZONE = 0.28;
// Pointer travel before a press on a header becomes a drag rather than a click.
const DRAG_SLOP = 4;

export const DockMixin = {

    // ── Bootstrap ────────────────────────────────────────────────────────────

    _initDock() {
        const sr = this.shadowRoot;
        this._ensureBottomRail();
        this.railEl = {
            left:   sr.getElementById("dock-left"),
            right:  sr.getElementById("dock-right"),
            bottom: sr.getElementById("dock-bottom"),
        };
        this.railSplitter = {
            left:   sr.getElementById("rail-splitter-left"),
            right:  sr.getElementById("rail-splitter-right"),
            bottom: sr.getElementById("rail-splitter-bottom"),
        };
        this.dockOverlay = sr.getElementById("dock-overlay");
        if (!this.railEl.left || !this.railEl.right) return;

        // Hidden until the first layout pass places them, so nothing flashes at
        // the edge of the viewport on the way to its rail.
        for (const id of Object.keys(DOCK_PANELS)) {
            const el = this._dockPanelEl(id);
            if (el) el.style.display = "none";
        }

        this.dockLayout = this._defaultDockLayout();
        this._bindRailSplitters();
        this._bindDockDrag();
        this.applyDockLayout();
    },

    /**
     * The bottom rail, built here when the markup doesn't carry it.
     *
     * A viewer can come up against an older cached bEpicViewer.html (the
     * parameters panel is rebuilt the same way, and for the same reason), and
     * a missing rail would take docking down with it rather than simply
     * leaving one side unavailable.
     */
    _ensureBottomRail() {
        const sr = this.shadowRoot;
        if (sr.getElementById("dock-bottom")) return;
        const main = sr.querySelector(".main-area");
        const controls = sr.querySelector(".controls");
        if (!main || !main.parentNode) return;
        const doc = main.ownerDocument;
        const mk = (id, cls) => {
            const n = doc.createElement("div");
            n.id = id; n.className = cls; n.dataset.rail = "bottom";
            return n;
        };
        const sp = mk("rail-splitter-bottom", "rail-splitter horizontal");
        sp.title = "Resize";
        const rail = mk("dock-bottom", "dock-rail bottom");
        const at = (controls && controls.parentNode === main.parentNode) ? controls : main.nextSibling;
        main.parentNode.insertBefore(sp, at);
        main.parentNode.insertBefore(rail, at);
    },

    _dockPanelEl(id) {
        const spec = DOCK_PANELS[id];
        return spec ? (this[spec.prop] || null) : null;
    },

    _defaultDockLayout() {
        // Matches what the viewer opened with before docking existed: the
        // parameters panel showing on the right, the other two put away.
        return {
            left:   { width: 88,  panels: [{ id: "history", size: 1, hidden: true  }] },
            right:  { width: 300, panels: [{ id: "tool",    size: 2, hidden: true  },
                                           { id: "browser", size: 1, hidden: true  },
                                           { id: "previz",  size: 1, hidden: true  },
                                           { id: "channels", size: 1, hidden: true },
                                           { id: "curves",  size: 1, hidden: true  },
                                           { id: "rotoCurves", size: 1, hidden: true },
                                           { id: "params",  size: 1, hidden: false }] },
            bottom: { height: 240, panels: [] },
        };
    },

    // ── The single writer ────────────────────────────────────────────────────

    /**
     * Make the DOM match dockLayout. The ONLY function that moves a panel,
     * sizes a rail, or shows a splitter — if layout looks wrong, it is either
     * this function or the object it was handed, and nowhere else.
     */
    applyDockLayout() {
        if (!this.railEl || !this.railEl.left) return;
        this._normaliseDockLayout();

        for (const side of RAIL_SIDES) {
            const rail = this.railEl[side];
            if (!rail) continue;
            const row = _isRow(side);
            const spec = this.dockLayout[side];
            const shown = spec.panels.filter(p => !p.hidden);

            // Splitters are rebuilt each pass; they belong between panels, and
            // which panels are in the rail is exactly what may have changed.
            rail.querySelectorAll(".stack-splitter").forEach(el => el.remove());

            spec.panels.forEach((entry) => {
                const el = this._dockPanelEl(entry.id);
                if (!el) return;
                if (el.parentNode !== rail) rail.appendChild(el);
                else rail.appendChild(el);           // re-append: array order wins
                el.style.display = entry.hidden ? "none" : "flex";
                el.style.flex    = `${entry.size || 1} 1 0`;
                el.style.minHeight = `${DOCK_PANELS[entry.id].minH}px`;
                // Whichever way the rail runs, the rail owns the other axis.
                el.style.minWidth = row ? `${DOCK_PANELS[entry.id].minW}px` : "";
                el.style.width   = "";
                el.style.height  = "";
                el.classList.toggle("left",   side === "left");
                el.classList.toggle("right",  side === "right");
                el.classList.toggle("bottom", row);
            });

            // One splitter between each adjacent visible pair.
            shown.forEach((entry, i) => {
                if (i === 0) return;
                const el = this._dockPanelEl(entry.id);
                if (!el) return;
                const sp = el.ownerDocument.createElement("div");
                sp.className = row ? "stack-splitter horizontal" : "stack-splitter";
                sp.dataset.rail = side;
                sp.dataset.after = shown[i - 1].id;
                sp.dataset.before = entry.id;
                rail.insertBefore(sp, el);
                this._bindStackSplitter(sp);
            });

            const active = shown.length > 0;
            rail.style.display = active ? "flex" : "none";
            rail.style.width   = (active && !row) ? `${this._railSize(side)}px` : "";
            rail.style.height  = (active && row)  ? `${this._railSize(side)}px` : "";
            if (this.railSplitter[side]) {
                this.railSplitter[side].style.display = active ? "block" : "none";
            }
        }

        // Kept in step for anything still reading it (icons, older call sites).
        this.paramsSide  = this._dockSideOf("params")  || this.paramsSide  || "right";
        this.browserSide = this._dockSideOf("browser") || this.browserSide || "right";
        this._syncPanelToggleButtons();
        this._notifyPanelsShown();

        // Compare geometry and the frame outline are measured against the
        // viewport, which has just changed width.
        if (this._afterViewportMoved) this._afterViewportMoved();
    },

    /**
     * A rail's one measurement — its width, or the bottom rail's height —
     * clamped to what the panels in it can live with.
     */
    _railSize(side) {
        const spec = this.dockLayout[side];
        const row = _isRow(side);
        const shown = spec.panels.filter(p => !p.hidden);
        const min = shown.reduce((m, p) => Math.max(m, DOCK_PANELS[p.id][row ? "minH" : "minW"]), 60);
        const want = (row ? spec.height : spec.width) || min;
        return Math.round(Math.max(min, Math.min(RAIL_MAX, want)));
    },

    /** Write that measurement back, to whichever field the rail keeps it in. */
    _setRailSize(side, px) {
        const spec = this.dockLayout[side];
        if (_isRow(side)) spec.height = px; else spec.width = px;
    },

    /** Drop unknown ids, re-home missing ones, and keep every panel exactly once. */
    _normaliseDockLayout() {
        if (!this.dockLayout) this.dockLayout = this._defaultDockLayout();
        const seen = new Set();
        for (const side of RAIL_SIDES) {
            const spec = this.dockLayout[side] || (this.dockLayout[side] = { width: 300, panels: [] });
            if (!Array.isArray(spec.panels)) spec.panels = [];
            spec.panels = spec.panels.filter((p) => {
                if (!p || !DOCK_PANELS[p.id] || seen.has(p.id)) return false;
                seen.add(p.id);
                if (!(p.size > 0)) p.size = 1;
                p.hidden = !!p.hidden;
                return true;
            });
            if (_isRow(side)) { if (!(spec.height > 0)) spec.height = 240; }
            else if (!(spec.width > 0)) spec.width = 300;
        }
        // A panel the saved layout never mentioned (a viewer upgraded mid-flight)
        // goes back to where it shipped, put away rather than sprung on the user.
        for (const [id, spec] of Object.entries(DOCK_PANELS)) {
            if (seen.has(id)) continue;
            // `size`: its share of the rail's height, until the user drags it.
            const entry = { id, size: spec.size || 1, hidden: true };
            if (spec.first) this.dockLayout[spec.defaultRail].panels.unshift(entry);
            else this.dockLayout[spec.defaultRail].panels.push(entry);
        }
    },

    // ── Queries ──────────────────────────────────────────────────────────────

    _dockSideOf(id) {
        for (const side of RAIL_SIDES) {
            if ((this.dockLayout?.[side]?.panels || []).some(p => p.id === id)) return side;
        }
        return null;
    },

    _dockEntry(id) {
        for (const side of RAIL_SIDES) {
            const list = this.dockLayout?.[side]?.panels || [];
            const i = list.findIndex(p => p.id === id);
            if (i >= 0) return { side, index: i, entry: list[i] };
        }
        return null;
    },

    isPanelDocked(id) {
        const found = this._dockEntry(id);
        return !!(found && !found.entry.hidden);
    },

    // ── Mutations (each ends in one applyDockLayout) ─────────────────────────

    /** Show or hide a panel, keeping the slot it had. */
    setPanelDocked(id, visible) {
        const found = this._dockEntry(id);
        if (!found) return;
        found.entry.hidden = !visible;
        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    togglePanelDocked(id) {
        this.setPanelDocked(id, !this.isPanelDocked(id));
        return this.isPanelDocked(id);
    },

    /** Move a panel into `side` at `index` (default: the end of that rail). */
    dockPanelTo(id, side, index) {
        if (!DOCK_PANELS[id] || !RAIL_SIDES.includes(side)) return;
        const found = this._dockEntry(id);
        if (!found) return;
        const entry = found.entry;
        this.dockLayout[found.side].panels.splice(found.index, 1);

        const target = this.dockLayout[side].panels;
        const at = (index == null) ? target.length : Math.max(0, Math.min(target.length, index));
        target.splice(at, 0, entry);

        // A rail that has only ever held the history strip is 88px wide; the
        // parameters panel arriving there would be unusable at that width.
        const spec = this.dockLayout[side];
        this._setRailSize(side, Math.max(_isRow(side) ? (spec.height || 0) : (spec.width || 0),
                                         DOCK_PANELS[id][_isRow(side) ? "minH" : "minW"]));

        // Sizes are shares, so a stack of new arrivals should start out even.
        target.forEach(p => { p.size = 1; });

        this.applyDockLayout();
        this.queuePersistViewerState && this.queuePersistViewerState();
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
        for (const side of RAIL_SIDES) {
            for (const p of this.dockLayout[side].panels) if (!p.hidden) now.add(p.id);
        }
        this._dockShown = now;
        for (const id of now) {
            if (before.has(id)) continue;
            try { this._onPanelShown(id); }
            catch (e) { console.warn(`bEpicViewer: ${id} panel failed to wake up`, e); }
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
            if (this.updateParamsPanel) this.updateParamsPanel(true);
        } else if (id === "curves") {
            if (this.previzRefreshCurves) this.previzRefreshCurves();
        } else if (id === "rotoCurves") {
            if (this.rotoRefreshCurves) this.rotoRefreshCurves();
        } else if (id === "tool") {
            if (this._toolRefreshPanel) this._toolRefreshPanel();
        } else if (id === "channels") {
            if (this._previzRenderChannels) this._previzRenderChannels();
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
        const move = (ev) => onMove(ev);
        const up = (ev) => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            try { el.releasePointerCapture(e.pointerId); } catch (_) {}
            if (onUp) onUp(ev);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
    },

    _bindRailSplitters() {
        for (const side of RAIL_SIDES) {
            const sp = this.railSplitter[side];
            if (!sp || sp._dockBound) continue;
            sp._dockBound = true;
            sp.addEventListener("pointerdown", (e) => {
                const row = _isRow(side);
                const start = row ? e.clientY : e.clientX;
                const startSize = this._railSize(side);
                sp.classList.add("dragging");
                this._pointerDrag(sp, e, (ev) => {
                    // Each rail grows away from the picture: the left one with
                    // the pointer, the right and bottom ones against it.
                    const d = (row ? ev.clientY : ev.clientX) - start;
                    this._setRailSize(side, side === "left" ? startSize + d : startSize - d);
                    const px = this._railSize(side);
                    this._setRailSize(side, px);
                    this.railEl[side].style[row ? "height" : "width"] = `${px}px`;
                    if (this._afterViewportMoved) this._afterViewportMoved();
                }, () => {
                    sp.classList.remove("dragging");
                    this.queuePersistViewerState && this.queuePersistViewerState();
                });
            });
        }
    },

    _bindStackSplitter(sp) {
        sp.addEventListener("pointerdown", (e) => {
            const side = sp.dataset.rail;
            const aId = sp.dataset.after, bId = sp.dataset.before;
            const a = this._dockEntry(aId), b = this._dockEntry(bId);
            const aEl = this._dockPanelEl(aId), bEl = this._dockPanelEl(bId);
            if (!a || !b || !aEl || !bEl) return;

            // Along the rail: heights in a side rail, widths in the bottom one.
            const row = _isRow(side);
            const axis = row ? "width" : "height";
            const startAt = row ? e.clientX : e.clientY;
            const aH = aEl.getBoundingClientRect()[axis];
            const bH = bEl.getBoundingClientRect()[axis];
            const total = aH + bH;
            const share = a.entry.size + b.entry.size;
            if (total <= 0 || share <= 0) return;
            const key = row ? "minW" : "minH";
            const aMin = DOCK_PANELS[aId][key], bMin = DOCK_PANELS[bId][key];

            sp.classList.add("dragging");
            this._pointerDrag(sp, e, (ev) => {
                const dy = (row ? ev.clientX : ev.clientY) - startAt;
                const newAH = Math.max(aMin, Math.min(total - bMin, aH + dy));
                a.entry.size = share * (newAH / total);
                b.entry.size = share - a.entry.size;
                aEl.style.flex = `${a.entry.size} 1 0`;
                bEl.style.flex = `${b.entry.size} 1 0`;
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

            const grip = doc.createElement("span");
            grip.className = "pt-grip";
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

            bar.append(grip, name, hide);
            el.insertBefore(bar, el.firstChild);

            hide.addEventListener("pointerdown", (e) => e.stopPropagation());
            hide.addEventListener("click", (e) => { e.stopPropagation(); this.setPanelDocked(id, false); });

            bar.addEventListener("pointerdown", (e) => this._onDockHeaderDown(id, bar, e));
        }
        return bar;
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
            this._endDockDrag(id);
            if (target) this.dockPanelTo(id, target.side, target.index);
        });
    },

    _beginDockDrag(id) {
        this._dockDragId = id;
        const el = this._dockPanelEl(id);
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
        this._dockGhostEl.textContent = DOCK_PANELS[id].label;
        this.dockOverlay.appendChild(this._dockPreviewEl);
        this.dockOverlay.appendChild(this._dockGhostEl);
        this.dockOverlay.classList.add("active");

        // Measured once: nothing moves until the drop, so every pointermove
        // after this is arithmetic — no layout reads, no thrash.
        const mainArea = this.dockOverlay.parentNode;
        this._dockRects = {
            main: mainArea.getBoundingClientRect(),
            viewport: this.viewport.getBoundingClientRect(),
            rails: {},
            panels: [],
        };
        for (const side of RAIL_SIDES) {
            const rail = this.railEl[side];
            const active = !!rail && rail.style.display !== "none";
            this._dockRects.rails[side] = active ? rail.getBoundingClientRect() : null;
            (this.dockLayout[side].panels || []).forEach((p, i) => {
                if (p.hidden) return;
                const pel = this._dockPanelEl(p.id);
                if (!pel) return;
                this._dockRects.panels.push({ id: p.id, side, index: i, r: pel.getBoundingClientRect() });
            });
        }

        const esc = (ev) => {
            if (ev.key !== "Escape") return;
            this._dockDragCancelled = true;
            this._endDockDrag(id);
        };
        this._dockEscHandler = esc;
        (this.container.ownerDocument.defaultView || window).addEventListener("keydown", esc, true);
    },

    _endDockDrag(id) {
        const el = this._dockPanelEl(id);
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

    /**
     * Where would a drop at (x, y) put the panel? null for "nowhere".
     *
     * Over a docked panel: its top half means above it, its bottom half below.
     * Over the outer quarter-ish of the viewport: the end of that rail.
     * Anywhere else — the middle of the picture — is not a drop.
     */
    _dockDropTarget(x, y, dragId) {
        const R = this._dockRects;
        if (!R) return null;
        if (this._dockDragCancelled) return null;

        const inside = (r) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

        for (const p of R.panels) {
            if (!inside(p.r)) continue;
            // "Before" is up in a side rail and left in the bottom one.
            const above = _isRow(p.side) ? (x < p.r.left + p.r.width / 2)
                                         : (y < p.r.top + p.r.height / 2);
            let index = above ? p.index : p.index + 1;
            // Dropping either side of itself changes nothing.
            const cur = this._dockEntry(dragId);
            if (cur && cur.side === p.side && (index === cur.index || index === cur.index + 1)) return null;
            if (cur && cur.side === p.side && cur.index < index) index -= 1;
            return { side: p.side, index, kind: above ? "before" : "after", ref: p };
        }

        const v = R.viewport;
        if (inside(v)) {
            const edge = v.width * EDGE_ZONE;
            if (x <= v.left + edge)  return { side: "left",  index: null, kind: "edge" };
            if (x >= v.right - edge) return { side: "right", index: null, kind: "edge" };
            // The bottom edge is a shallower band than the sides: it is a strip
            // under the picture, not half of it.
            if (this.railEl.bottom && y >= v.bottom - v.height * (EDGE_ZONE / 2)) {
                return { side: "bottom", index: null, kind: "edge" };
            }
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

        if (target.kind === "edge") {
            const rail = R.rails[target.side];
            if (target.side === "bottom") {
                // The rail sits under .main-area, so the band is drawn along
                // the foot of the picture — where the panel will appear.
                const h = rail ? rail.height : Math.max(DOCK_PANELS[dragId].minH, 200);
                put(main.left, main.bottom - h, main.width, h);
                return;
            }
            const w = rail ? rail.width : Math.max(DOCK_PANELS[dragId].minW, 260);
            const l = target.side === "left" ? main.left : main.right - w;
            put(l, main.top, w, main.height);
            return;
        }
        // Insert beside a panel: a band at that edge of it.
        const r = target.ref.r;
        if (_isRow(target.side)) {
            const w = Math.max(24, Math.min(r.width / 2, 120));
            put(target.kind === "before" ? r.left : r.right - w, r.top, w, r.height);
            return;
        }
        const h = Math.max(24, Math.min(r.height / 2, 120));
        put(r.left, target.kind === "before" ? r.top : r.bottom - h, r.width, h);
    },

    // ── Persistence ──────────────────────────────────────────────────────────

    serializeDock() {
        this._normaliseDockLayout();
        return JSON.parse(JSON.stringify(this.dockLayout));
    },

    applyDockData(data) {
        if (!data || typeof data !== "object") return false;
        if (!data.left && !data.right) return false;
        this.dockLayout = {
            left:   { width: 88,  panels: [] },
            right:  { width: 300, panels: [] },
            bottom: { height: 240, panels: [] },
        };
        for (const side of RAIL_SIDES) {
            const src = data[side];
            if (!src) continue;
            if (src.width > 0)  this.dockLayout[side].width = src.width;
            if (src.height > 0) this.dockLayout[side].height = src.height;
            if (Array.isArray(src.panels)) {
                this.dockLayout[side].panels = src.panels
                    .filter(p => p && DOCK_PANELS[p.id])
                    .map(p => ({ id: p.id, size: p.size > 0 ? p.size : 1, hidden: !!p.hidden }));
            }
        }
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
