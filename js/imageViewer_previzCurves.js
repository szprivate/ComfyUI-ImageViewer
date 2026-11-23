// imageViewer_previzCurves.js
// The previz animation curves: the selected item's keys drawn as value over
// time, in a dock panel of their own (#curves-panel), alongside the previz
// panel and reached from the 3D toolbar.
//
// The editor comes in instances (Sebastian 2026-11-23): the implementation lives in
// imageViewer_previzCurvesInstance.js, one closure per editor with its own viewport (pan/zoom), shown
// channels, list width and key selection. This mixin keeps the FIRST one — the markup in imageViewer.html —
// with its state on the viewer as it always was (every older caller of this._previzCurveView /
// this._previzCurveSel reads and writes it still), and registers the maker the dock calls for every
// further one ("curves@2", ...). The scene's tracks and the item selection stay the tab's shared data:
// two editors draw the same scene, each through a view of its own.
//
// Deliberately NOT the roto editor's speed graph. Roto animates one shape, so
// its curve is about timing; here every channel is a plain number — X, Y and Z
// in world units, or degrees, or a field of view — so the graph shows the value
// itself. The shared skeleton is imageViewer_curveUI.js.
//
// CHANNELS
// The left column lists them one per line, named the way a DCC names them:
// translate.x, rotate.z, scale.y, pivot.x, fov. Any set of them can be on
// screen at once — that is the whole point of a graph editor. A channel with
// no keys still draws, as the flat line its static value is. Select several
// objects and each gets its own section, headed by its name and foldable.
import { createCurvesInstance } from "./imageViewer_previzCurvesInstance.js";

// Every channel an item can have, in the order they are listed. Colour is by
// axis, shaded by property, so translate.x and rotate.x are never the same
// line twice.
const CHANNELS = [
    { key: "position.0", prop: "position", axis: 0, label: "translate.x", color: "#ff6b6b" },
    { key: "position.1", prop: "position", axis: 1, label: "translate.y", color: "#8ce26b" },
    { key: "position.2", prop: "position", axis: 2, label: "translate.z", color: "#6bb6ff" },
    { key: "rotation.0", prop: "rotation", axis: 0, label: "rotate.x", color: "#ff9d4d" },
    { key: "rotation.1", prop: "rotation", axis: 1, label: "rotate.y", color: "#c8e24d" },
    { key: "rotation.2", prop: "rotation", axis: 2, label: "rotate.z", color: "#4dc8ff" },
    { key: "scale.0", prop: "scale", axis: 0, label: "scale.x", color: "#ff6bd5" },
    { key: "scale.1", prop: "scale", axis: 1, label: "scale.y", color: "#6be2c8" },
    { key: "scale.2", prop: "scale", axis: 2, label: "scale.z", color: "#9d8cff" },
    { key: "pivot.0", prop: "pivot", axis: 0, label: "pivot.x", color: "#c98a8a" },
    { key: "pivot.1", prop: "pivot", axis: 1, label: "pivot.y", color: "#a5c98a" },
    { key: "pivot.2", prop: "pivot", axis: 2, label: "pivot.z", color: "#8aa8c9" },
    { key: "fov", prop: "fov", axis: 0, label: "fov", color: "#ffd24d" },
    { key: "ikfk", prop: "ikfk", axis: 0, label: "ikBlend", color: "#4dff9a" },
];

export const PrevizCurvesMixin = {

    _previzCurveHost() {
        return this.curvesPanel || null;
    },

    /** Which channels an item can show at all: no field of view on a box. */
    _previzChannelsFor(item) {
        const ik = item.kind === "control" && item.control && item.control.type === "ik";
        const own = CHANNELS.filter((c) => (c.prop !== "fov" || item.kind === "camera")
                                   && (c.prop !== "pivot" || (item.kind !== "camera" && item.kind !== "control"))
                                   && (c.prop !== "scale" || item.kind !== "control")
                                   && (c.prop !== "ikfk" || ik));
        // A constraint's weights are channels too (imageViewer_previzConstraints.js).
        const extra = this._previzConstraintCurveChannels ? this._previzConstraintCurveChannels(item) : [];
        return extra.length ? [...own, ...extra] : own;
    },

    /** The objects the editors are showing: everything selected, in scene order. */
    _previzCurveItems() {
        const scene = this.previzScene();
        if (!scene) return [];
        return (scene.items || []).filter((it) => this.previzIsSelected(it.id));
    },

    // ── Instances ───────────────────────────────────────────────────────────

    /** The maker the dock calls for every further Curve Editor ("curves@2", ...), with a state of its own. */
    _pcRegisterMaker() {
        if (this._dockMakers().curves) return;
        this._dockMakers().curves = (v, id, saved) => {
            const d = (v._dockRootEl && v._dockRootEl.ownerDocument) || (v.curvesPanel && v.curvesPanel.ownerDocument);
            const host = d.createElement("div");
            host.className = "curves-panel";
            // A new editor starts where the first one is (its view and channels), then walks on its own.
            const seed = saved || (v._previzCurveInst ? v._previzCurveInst.save() : null);
            return createCurvesInstance(v, host, {}, seed);
        };
    },

    /** The first Curve Editor, its state on the viewer; made the first time the panel is asked for. */
    _pcPrimary() {
        this._pcRegisterMaker();
        const inst = this._previzCurveInst;
        if (inst && inst.ui.body.isConnected) return inst;
        const host = this._previzCurveHost();
        if (!host) return null;
        if (inst) { try { inst.dispose(); } catch (_) { /* gone */ } }
        this._previzCurveInst = createCurvesInstance(this, host, this, null);
        return this._previzCurveInst;
    },

    _previzBuildCurveEditor(host) {
        const inst = this._pcPrimary();
        return inst ? inst.ui : null;
    },

    /**
     * Draw what the selection has to show, in the first editor and every shown extra.
     *
     * The panel is the dock's to open and close — previz only fills it in, and
     * says nothing at all while it is away.
     */
    previzRefreshCurves() {
        // The Dope Sheet is redrawn by everything that redraws the curves.
        if (this.previzRefreshDopeSheet) this.previzRefreshDopeSheet();
        const inst = this._pcPrimary();
        if (inst) {
            if (!this.isPrevizTab()) this._previzHideCurves();
            else if (this.isPanelDocked("curves")) inst.refresh();
        }
        for (const { inst: extra } of this._dockInstancesOf("curves")) extra.refresh();
    },

    /** Put the panel away — previz is over, or the tab is not a 3D one. */
    _previzHideCurves() {
        if (this.isPanelDocked && this.isPanelDocked("curves")) this.setPanelDocked("curves", false);
    },

    /** Asked by handleKeyDown first; true when any Curve Editor took the key. */
    previzCurveKeyDown(e) {
        if (this._previzCurveInst && this._previzCurveInst.keyDown(e)) return true;
        for (const { inst: extra } of this._dockInstancesOf("curves")) if (extra.keyDown(e)) return true;
        return false;
    },

    // ── The first editor, for callers that ask the viewer ───────────────────

    _previzCurveViewNow() { const i = this._pcPrimary(); return i ? i.viewNow() : null; },
    previzEulerFilter() { const i = this._pcPrimary(); return i ? i.eulerFilter() : 0; },
    previzCurveBufferSnap() { const i = this._pcPrimary(); return i ? i.bufferSnap() : 0; },
    previzCurveBufferSwap() { const i = this._pcPrimary(); return i ? i.bufferSwap() : 0; },
    previzCurveSimplify(tolerance = 0.01) { const i = this._pcPrimary(); return i ? i.simplify(tolerance) : null; },
    previzCurveInfinity(side, mode) { const i = this._pcPrimary(); return i ? i.infinity(side, mode) : 0; },
    previzCurveRetime(from, to, newTo, ripple = true) { const i = this._pcPrimary(); return i ? i.retime(from, to, newTo, ripple) : 0; },
    previzCurveFit() { const i = this._pcPrimary(); if (i) i.fit(); },
    previzCurveZoom(kx, ky, ax = 0.5, ay = 0.5) { const i = this._pcPrimary(); if (i) i.zoom(kx, ky, ax, ay); },
    previzCurvePan(df, dv) { const i = this._pcPrimary(); if (i) i.pan(df, dv); },
    previzCurveSelectAll() { const i = this._pcPrimary(); return i ? i.selectAll() : 0; },
    previzCurveDeleteSelected() { const i = this._pcPrimary(); return i ? i.deleteSelected() : 0; },
    previzCurveSetTangents(mode) { const i = this._pcPrimary(); return i ? i.setTangents(mode) : 0; },
};