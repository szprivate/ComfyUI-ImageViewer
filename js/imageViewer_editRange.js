// The in-out range lifted or extracted, Swap Clips, Select Forward - as Resolve's
// Edit page (EditRangeMixin, onto the panel). The arithmetic is in
// imageViewer_editTimelineData.js (liftRange, swapClip, selectForward), tested in
// tests/test_edit_range_swap.mjs; the panel in tests/test_edit_resolve_tools_browser.py.
//
// Del with nothing selected and an in and out set: LIFT the range off the tracks
// whose Auto Track Selector is on; Shift+Del: EXTRACT it (the hole closes).
// Ctrl+Shift+, / . : swap the selected clip with the one before / after it.
// Y: select the clips from the playhead on, on the selected clip's track (else
// V1); Alt+Y on every track; Shift+Y / Alt+Shift+Y the same backwards (Resolve's
// Ctrl+Y is Redo here).

import * as D from "./imageViewer_editTimelineData.js";

export const EditRangeMixin = {
    /** The in-out range in film seconds [a, b), or null. */
    _editTlRangeSeconds() {
        const r = this._editTlRange && this._editTlRange();
        if (!r || !this._editTlCut) return null;
        const fps = this._editTlCut.fps || 24;
        return { a: r.start / fps, b: (r.end + 1) / fps };
    },

    /** Lift (or with `ripple` extract) the in-out range: true when there was a range to act on. */
    editTlLiftRange(ripple) {
        const cut = this._editTlCut;
        const r = this._editTlRangeSeconds();
        if (!cut || !r) return false;
        const got = D.liftRange(cut, r.a, r.b, !!ripple, D.editMask(cut), cut.fps || 24);
        if (got.error) { this._editTlSay(got.error); return true; }
        this._editTlSel = null;
        this._editTlEditSel = null;
        this._editTlMulti = null;
        if (this._editTlApply(got.cut) === false) return true;
        if (ripple) this._editTlSeek(r.a);
        this._editTlSay((ripple ? "extracted " : "lifted ") + D.timecode(r.b - r.a, cut.fps || 24)
            + (got.kept ? " (a cut keeps its last shot)" : ""));
        return true;
    },

    /** Ctrl+Shift+, / . : the selected clip swapped with the one before (-1) / after (+1) it on its track. */
    editTlSwap(dir) {
        const cut = this._editTlCut, sel = this._editTlSel;
        if (!cut) return;
        if (!sel || (sel.kind !== "clip" && sel.kind !== "tclip")) { this._editTlSay("select a clip to swap"); return; }
        const got = D.swapClip(cut, sel, dir);
        if (!got) { this._editTlSay(dir < 0 ? "nothing before it to swap with" : "nothing after it to swap with"); return; }
        if (this._editTlApply(got.cut) === false) return;
        this._editTlEditSel = null;
        this._editTlMulti = null;
        this._editTlSel = got.sel;
        this.editTlRefresh();
    },

    /** Y and its variants: the clips from the playhead on (dir 1) or before it (-1), on this track or on all. */
    editTlSelectForward(dir, all) {
        const cut = this._editTlCut;
        if (!cut) return;
        const fps = cut.fps || 24;
        const t = (this.currentFrame || 0) / fps;
        const sel = this._editTlSel;
        const track = all ? null : (sel && (sel.kind === "clip" || sel.kind === "tclip") ? D.selTrack(sel) : "V1");
        const list = D.selectForward(cut, t, track, dir, fps);
        this._editTlEditSel = null;
        if (!list.length) {
            this._editTlSay("no clips " + (dir < 0 ? "before" : "after") + " the playhead" + (track ? " on " + track : ""));
            return;
        }
        // The primary selection is the clip nearest the playhead on that side.
        this._editTlSetSelList(list, dir < 0 ? list.filter((s) => s.kind === "clip").pop() || list[list.length - 1] : list[0]);
        this.editTlRefresh();
    },

    /** The ruler's menu rows for the range (_editTlRulerMenu). */
    _editTlRangeMenuRows() {
        const has = !!this._editTlRangeSeconds();
        return [
            { label: "Lift in–out (Del)", disabled: !has, run: () => this.editTlLiftRange(false) },
            { label: "Extract in–out (Shift+Del)", disabled: !has, run: () => this.editTlLiftRange(true) },
        ];
    },
};
