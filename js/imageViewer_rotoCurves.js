// imageViewer_rotoCurves.js
// The roto shapes' animation curves, in a dock panel of their own
// (#roto-curves-panel, "Roto Curves"). It opens when the roto tool comes on and
// goes away with it, and is sized, moved and stacked like every other panel.
//
// The panel comes in instances (Sebastian 2026-11-23): the implementation lives in
// imageViewer_curvePanelsInstance.js, one closure per panel with its own shown shapes, key selection and
// list width. This mixin keeps the FIRST one — the markup in imageViewer.html — with its state on the
// viewer as it always was, and the tool's open/close still drives only it; every further one
// ("rotoCurves@2", ...) is opened from the + menu and lives in the layout. The tool's layers stay the
// shared data: two panels draw the same shapes, each through a view of its own.
//
// It is built from the same parts as the previz Animation Curves
// (imageViewer_curveUI.js): the list on the left, the graph on the right, the
// same dots, handles and arms. What a curve IS differs, though. A previz
// channel is a number, so its graph shows the value. A roto shape is a set of
// points that morphs from key to key, so its graph shows timing: how far along
// its journey from one key to the next the shape is at each frame — each key
// one step up, the ease between them shaped by the handles, After Effects'
// value graph for a path.
//
// LIST AND GRAPH
// One row per shape. A plain click shows that shape alone and makes it the
// shape the key buttons and the canvas work on; Shift/Ctrl-click adds or
// removes a shape from the graph. By default every animated shape is on it,
// each in its own colour.
//
// KEYS AND HANDLES
// Drag a key sideways to retime it (it can't pass its neighbours), double-click
// to delete it. Click a key for its handles: the one leaving it shapes the ease
// out, the one arriving at it the ease in; horizontal reach is how much ease,
// height is speed. Double-click a handle to give the key its default ease back.
// A Hold key has no handle out: the shape stays put until the next key.
//
// The data is the roto tool's own: layer.keyframes[frame] = points and
// layer.tangents[frame] = { ox, oy, ix, iy, hold } (see imageViewer_roto.js).
import { createRotoCurvesInstance, registerCurvePanelMakers } from "./imageViewer_curvePanelsInstance.js";

export const RotoCurvesMixin = {

    _rotoCurvesOn() {
        return !!(this._toolState && this._toolState.active === "roto" && this._toolState.node && this._roto);
    },

    /** Open or put away the panel — the roto tool's to decide, like previz's own. The first one only. */
    rotoShowCurves(on) {
        // Startup comes through here (setActiveTool("none")) before a restored layout is read: the makers
        // have to be known by then, or the layout's instances are dropped on the way in.
        registerCurvePanelMakers(this);
        if (!this.setPanelDocked || !this.isPanelDocked || !this.rotoCurvesPanel) return;
        if (!!this.isPanelDocked("rotoCurves") !== !!on) this.setPanelDocked("rotoCurves", !!on);
        // The extras stay in the layout; let them see the tool's state too, or they keep stale curves up.
        if (this._dockInstancesOf) {
            for (const { inst } of this._dockInstancesOf("rotoCurves")) inst.refresh();
        }
    },

    rotoToggleCurves() {
        if (!this.isPanelDocked) return;
        this.rotoShowCurves(!this.isPanelDocked("rotoCurves"));
    },

    /** Redraw the panel: after an edit, a frame change, or the panel coming up. Every shown one of them. */
    rotoRefreshCurves() {
        registerCurvePanelMakers(this);
        const host = this.rotoCurvesPanel;
        if (host && this._rotoCurvesOn() && this.isPanelDocked && this.isPanelDocked("rotoCurves")) {
            const inst = this._rotoCurvePrimary();
            if (inst) inst.refresh();
        }
        if (this._dockInstancesOf) {
            for (const { inst } of this._dockInstancesOf("rotoCurves")) inst.refresh();
        }
    },

    /** The first Roto Curves panel, its state on the viewer; made the first time the panel is asked for. */
    _rotoCurvePrimary() {
        const inst = this._rotoCurveInst;
        if (inst && inst.ui.body.isConnected) return inst;
        const host = this.rotoCurvesPanel;
        if (!host) return null;
        if (inst) { try { inst.dispose(); } catch (_) { /* gone */ } }
        this._rotoCurveInst = createRotoCurvesInstance(this, host, this, null);
        return this._rotoCurveInst;
    },

    _rotoBuildCurves(host) {
        const inst = this._rotoCurvePrimary();
        return inst ? inst.ui : null;
    },
};