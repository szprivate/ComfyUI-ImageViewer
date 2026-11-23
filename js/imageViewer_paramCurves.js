// imageViewer_paramCurves.js
// Parameter Curves: the animated parameters of the node in the Parameters
// panel, drawn as value over time in a dock panel of their own
// (#param-curves-panel, dock id "paramCurves"). Opened from the ∿ button in
// the Parameters header.
//
// The panel comes in instances (Sebastian 2026-11-23): the implementation lives in
// imageViewer_curvePanelsInstance.js, one closure per panel with its own shown parameters, key selection
// and list width. This mixin keeps the FIRST one — the markup in imageViewer.html — with its state on the
// viewer as it always was, following the Parameters panel's node; every further one ("paramCurves@2", ...)
// is opened from the + menu, lives in the layout, and can pin itself to another node with keyed tracks
// through the small select over its graph. The nodes' tracks stay the shared data: an edit in one panel
// shows in the others.
//
// The same editor as previz's Animation Curves (imageViewer_previzCurves.js),
// built from the same parts (imageViewer_curveUI.js): a list of curves on the
// left, the graph on the right. Drag a key sideways to retime it, up and down
// to change it, double-click to delete it; click it for its tangent handles,
// Alt to break them, double-click a handle to hand the key back to its ease.
// Every parameter is one number, so a curve is simply the parameter's name.
import { createParamCurvesInstance, registerCurvePanelMakers } from "./imageViewer_curvePanelsInstance.js";

export const ParamCurvesMixin = {

    /** Open or close the panel (the ∿ button in the Parameters header). The first one only. */
    paramToggleCurves() {
        registerCurvePanelMakers(this);
        if (!this.setPanelDocked) return;
        this.setPanelDocked("paramCurves", !this.isPanelDocked("paramCurves"));
        this.paramAnimDecorate?.();
    },

    /** Redraw the first panel and every shown extra: after an edit, a frame change, or one coming up. */
    paramRefreshCurves() {
        registerCurvePanelMakers(this);
        const host = this.paramCurvesPanel;
        if (host && this.isPanelDocked && this.isPanelDocked("paramCurves")) {
            const inst = this._paramCurvePrimary();
            if (inst) inst.refresh();
        }
        if (this._dockInstancesOf) {
            for (const { inst } of this._dockInstancesOf("paramCurves")) inst.refresh();
        }
    },

    /** The first Parameter Curves panel, its state on the viewer; made the first time it is asked for. */
    _paramCurvePrimary() {
        const inst = this._paramCurveInst;
        if (inst && inst.ui.body.isConnected) return inst;
        const host = this.paramCurvesPanel;
        if (!host) return null;
        if (inst) { try { inst.dispose(); } catch (_) { /* gone */ } }
        this._paramCurveInst = createParamCurvesInstance(this, host, this, null);
        return this._paramCurveInst;
    },

    _paramBuildCurves(host) {
        const inst = this._paramCurvePrimary();
        return inst ? inst.ui : null;
    },
};