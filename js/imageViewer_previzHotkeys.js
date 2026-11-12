// imageViewer_previzHotkeys.js
// The 3D space's working keys and selection, Maya's way (clean-room: from how
// Maya behaves, none of its code):
//
//   F       over the 3D view: frame the selection (nothing selected: reset
//           the view); over the Outliner: open the tree down to the selection
//   Q       the Select tool (click / box, no gizmo); W E R as before
//   S       key every channel of the selection; Shift+S the channels selected
//           in the Channel Box (all of them when none is); Shift+W / E / R as before
//   K       held, with the left button dragged in the view: scrub the timeline
//   Shift+1 .. Shift+8   the Display menu's kinds on / off
//
// Clicks and boxes in the view come through previzSelectMany with Maya's
// modifiers: plain replaces, Shift toggles, Ctrl takes out, Ctrl+Shift adds.
import * as S from "./imageViewer_scene3d.js";
import { DISPLAY_KINDS } from "./imageViewer_view3dTools.js";

export const PrevizHotkeysMixin = {

    // ── Selection ────────────────────────────────────────────────────────────

    /**
     * Select `ids` as a click or a box does. The primary (gizmo, Channel Box,
     * curves) stays the one it was when it is still selected; otherwise it is
     * the first of what was added.
     */
    previzSelectMany(ids, mode = "replace", { primary: want = null } = {}) {
        const scene = this.previzScene();
        if (!scene) return;
        const list = (ids || []).filter((id) => S.itemById(scene, id));
        const now = new Set(this.previzSelectedIds());
        let next;
        if (mode === "replace") next = new Set(list);
        else if (mode === "add") next = new Set([...now, ...list]);
        else if (mode === "remove") { next = new Set(now); for (const id of list) next.delete(id); }
        else { next = new Set(now); for (const id of list) { if (next.has(id)) next.delete(id); else next.add(id); } }
        const keep = this._previzSelection && next.has(this._previzSelection) ? this._previzSelection : null;
        const fresh = list.find((id) => next.has(id) && !now.has(id));
        const primary = want && next.has(want) ? want
            : keep && mode !== "replace" ? keep
            : (fresh || (keep && next.has(keep) ? keep : [...next][0] || null));
        const also = this._previzAlso || (this._previzAlso = new Set());
        also.clear();
        for (const id of next) if (id !== primary) also.add(id);
        this._previzSelection = primary || null;
        if (this._model3d) {
            this._model3d.select(this._previzSelection);
            this._model3d.setAlsoSelected([...also]);
        }
        this._previzRenderPanel();
        this._previzRenderTicks();
        this.previzRefreshCurves();
    },

    // ── F ────────────────────────────────────────────────────────────────────

    /** Whether the pointer last moved over `el` (a panel of the viewer). */
    _previzPointerIn(el) {
        const t = this._hoverTarget;
        return !!(el && t && (el === t || (el.contains && el.contains(t))));
    },

    previzFKey() {
        if (this._previzPointerIn(this.previzPanel) && this.isPanelDocked && this.isPanelDocked("previz")) {
            this.previzRevealInOutliner();
            return;
        }
        const view = this._model3d;
        if (!view) return;
        const ids = this.previzSelectedIds();
        if (!ids.length || !view.frameItems(ids)) view.resetView();
    },

    /** Unfold every parent of the selection and bring its rows into view. */
    previzRevealInOutliner() {
        const scene = this.previzScene();
        if (!scene) return false;
        const ids = this.previzSelectedIds();
        if (!ids.length) return false;
        const collapsed = this._previzCollapsed || (this._previzCollapsed = new Set());
        for (const id of ids) {
            const seen = new Set();
            let it = S.itemById(scene, id);
            while (it && it.parent && !seen.has(it.parent)) {
                seen.add(it.parent);
                collapsed.delete(it.parent);
                it = S.itemById(scene, it.parent);
            }
        }
        this._previzRenderPanel();
        const ui = this._previzUI;
        const row = ui && ui.list && (ui.list.querySelector(`[data-item-id="${CSS.escape(this._previzSelection || ids[ids.length - 1])}"]`));
        if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
        return !!row;
    },

    // ── S / Shift+S ──────────────────────────────────────────────────────────

    /** Key the Channel Box's selected channels; all of them when none is selected. */
    previzKeySelectedChannels() {
        const props = this._cbSelectedProps ? this._cbSelectedProps() : [];
        if (props.length && this.previzKeyChannels) this.previzKeyChannels(props);
        else this.previzKeyAll();
    },

    // ── K (scrub) and Shift+digits (display) ─────────────────────────────────

    /** Asked by handleKeyDown on a 3D tab, before the keymap; true = taken. */
    previzKeyDown(e) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return false;
        if ((e.key === "k" || e.key === "K") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            this._previzKHeld = true;
            if (this._model3d && this._model3d.root) this._model3d.root.classList.add("scrub-ready");
            e.preventDefault();
            e.stopImmediatePropagation();
            return true;
        }
        // By the key's place, not its letter: Shift+1 is "!" on one keyboard and "!" or "+" on others.
        const m = /^Digit([1-9])$/.exec(e.code || "");
        if (m && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const kind = DISPLAY_KINDS[Number(m[1]) - 1];
            if (!kind) return false;
            this.previzToggleDisplay(kind.key);
            e.preventDefault();
            e.stopImmediatePropagation();
            return true;
        }
        return false;
    },

    previzKeyUp(e) {
        if (e.key === "k" || e.key === "K") this._previzKRelease();
    },

    _previzKRelease() {
        this._previzKHeld = false;
        if (this._model3d && this._model3d.root) this._model3d.root.classList.remove("scrub-ready");
    },

    previzToggleDisplay(kind, on) {
        const view = this._model3d;
        if (!view || !view.setDisplayed) return;
        view.setDisplayed(kind, on);
        if (kind === "grid" && this._syncModelPanelButtons) this._syncModelPanelButtons();
    },

    /** Where a K scrub starts: the frame and how many frames the view's width is. */
    previzScrubStart() {
        if (!this.isPrevizTab || !this.isPrevizTab()) return null;
        if (this.isPlaying) this.stop();
        const b = this.getTimelineBounds();
        return { frame: Math.round(this.currentFrame || 0), span: Math.max(1, b.max - b.min + 1) };
    },

    previzScrubTo(frame) {
        const b = this.getTimelineBounds();
        const f = Math.max(b.min, Math.min(b.max, Math.round(frame)));
        if (f !== Math.round(this.currentFrame || 0)) this.setFrame(f);
    },
};
