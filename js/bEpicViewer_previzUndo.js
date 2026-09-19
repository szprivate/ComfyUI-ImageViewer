// bEpicViewer_previzUndo.js
// Undo and redo for a previz scene.
//
// A scene is small, serializable data (bEpicViewer_scene3d.js), so history is
// kept as whole snapshots rather than as a list of reversible commands: at a
// few kilobytes per step that is cheaper to keep than a command for every kind
// of edit is to write, and it can never drift out of step with the scene.
//
// A step is taken BEFORE an edit, so the top of the stack is always the state
// to go back to. Drags (a gizmo, a curve key, the camera) snapshot once when
// the drag starts, not on every mouse move — see previzBeginDrag.
import * as S from "./bEpicViewer_scene3d.js";

const LIMIT = 50;          // deep enough for a working session, bounded for memory

export const PrevizUndoMixin = {

    _undoState(key = this.activeTab) {
        if (!this._previzUndo) this._previzUndo = {};
        if (!this._previzUndo[key]) this._previzUndo[key] = { past: [], future: [] };
        return this._previzUndo[key];
    },

    /**
     * Remember the scene as it is now, before something changes it.
     * `label` is what the buttons' tooltips name, so it reads as the thing you
     * would be undoing.
     */
    previzSnapshot(label = "change") {
        const scene = this.previzScene();
        if (!scene) return;
        const state = this._undoState();
        state.past.push({ label, json: S.serializeScene(scene), selection: this._previzSelection });
        if (state.past.length > LIMIT) state.past.shift();
        state.future.length = 0;            // a new edit ends the redo line
        this._previzRefreshUndoButtons();
    },

    /** One snapshot for a whole drag, however many moves it turns out to be. */
    previzBeginDrag(label) {
        if (this._previzDragging) return;
        this._previzDragging = label || "move";
        this.previzSnapshot(this._previzDragging);
    },

    previzEndDrag() {
        this._previzDragging = null;
    },

    previzCanUndo() { return this._undoState().past.length > 0; },
    previzCanRedo() { return this._undoState().future.length > 0; },

    previzUndo() { return this._previzStep("past", "future"); },
    previzRedo() { return this._previzStep("future", "past"); },

    _previzStep(from, to) {
        const scene = this.previzScene();
        if (!scene) return false;
        const state = this._undoState();
        const step = state[from].pop();
        if (!step) return false;

        state[to].push({ label: step.label, json: S.serializeScene(scene),
                         selection: this._previzSelection });
        const restored = S.parseScene(step.json);
        this._setScene(this.activeTab, restored);
        // An item that was deleted and is back again needs its old selection; one
        // that is gone for good leaves the selection on whatever is first.
        this._previzSelection = S.itemById(restored, step.selection)
            ? step.selection : (restored.items.length ? restored.items[0].id : null);
        if (this._model3d) this._model3d.select(this._previzSelection);
        this.applyTimelineBounds();
        this.previzChanged({ reload: true });
        this._previzRefreshUndoButtons();
        return true;
    },

    _previzRefreshUndoButtons() {
        const ui = this._previzUI;
        if (!ui || !ui.undoBtn) return;
        const state = this._undoState();
        const last = state.past[state.past.length - 1];
        const next = state.future[state.future.length - 1];
        ui.undoBtn.disabled = !last;
        ui.redoBtn.disabled = !next;
        ui.undoBtn.title = last ? `Undo ${last.label}` : "Nothing to undo";
        ui.redoBtn.title = next ? `Redo ${next.label}` : "Nothing to redo";
    },
};
