// Dynamic trim, as Resolve's (W; EditDynamicMixin, onto the panel; tests in
// tests/test_edit_resolve_tools_browser.py). With it on, J / K / L do not move
// the playhead over the film but MOVE THE EDIT while it runs: the selected edit
// point is trimmed (a roll, a ripple or a trim, as , / . would - _editTlTrimCompute),
// else the selected clip is slipped (Trim mode, slipClip) or slid (Selection,
// slideClip / slideTrackClip with its linked partner); each tick is worked out
// from the cut at the start of the run, so no rounding adds up. One frame per
// frame of the clock. L again runs faster (2x, 4x, 8x), J the same backwards,
// K stops. The playhead stays on the edit and the trim two-up shows both sides,
// as with the keys. A whole run is ONE undo step. With nothing to trim selected
// J / K / L are the shuttle as before. Leaving the Edit panel, switching the mode
// off, any press in the timeline or a held edge (source end, start of film)
// stops it.

import * as D from "./imageViewer_editTimelineData.js";

const MAX_RATE = 8;

export const EditDynamicMixin = {
    /** W: dynamic trim on / off (`on` forces it). */
    editTlDynamicToggle(on) {
        const next = on === undefined ? !this._editTlDynamic : !!on;
        if (!next) this._editTlDynStop();
        this._editTlDynamic = next;
        this._editTlSay(next ? "dynamic trim: J / K / L trim the selected edit point (or slip / slide the clip)" : "dynamic trim off");
        this.editTlRefresh();
    },

    /** What J / K / L would move now: "edit", "slip", "slide" - or "" (they shuttle). */
    _editTlDynTarget() {
        if (!this._editTlDynamic || !this._editTlCut) return "";
        if (this._editTlEditPoint && this._editTlEditPoint()) return "edit";
        const sel = this._editTlSel;
        if (!sel || (sel.kind !== "clip" && sel.kind !== "tclip")) return "";
        if (this._editTlSelAll().length > 1) return "";
        return this._editTlTrimMode ? "slip" : "slide";
    },

    /** J / K / L in dynamic trim: true when it took the key. */
    editTlDynKey(dir) {
        const run = this._editTlDyn;
        if (dir === 0) { if (run) { this._editTlDynStop(); return true; } return false; }
        const what = run ? run.what : this._editTlDynTarget();
        if (!what) return false;
        if (run && run.dir === dir) { run.rate = Math.min(MAX_RATE, run.rate * 2); this._editTlDynSay(); return true; }
        if (run) { run.dir = dir; run.rate = 1; this._editTlDynSay(); return true; }
        this._editTlDynStart(what, dir);
        return true;
    },

    _editTlDynStart(what, dir) {
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        if (this._editTlShuttle) this._editTlShuttle(0, true);
        if (this.isPlaying) this.stop();
        const fps = this._editTlCut.fps || 24;
        const h = this._editTlHistory();
        const run = {
            what, dir, rate: 1, tab: this._editTlTab, cut: this._editTlCut, sel: this._editTlSel,
            info: what === "edit" ? this._editTlEditPoint() : null,
            history: { past: [...h.past], future: [...h.future] }, frames: 0, timer: 0,
        };
        if (run.info) run.live = this._editTlEditLive(run.info);
        this._editTlDyn = run;
        run.timer = win.setInterval(() => this._editTlDynTick(), 1000 / fps);
        this._editTlDynSay();
    },

    _editTlDynSay() {
        const run = this._editTlDyn;
        if (!run) return;
        const name = { edit: "trimming", slip: "slipping", slide: "sliding" }[run.what];
        this._editTlSay(`dynamic ${name} ${run.dir < 0 ? "◀" : "▶"} ${run.rate}x (K stops)`);
    },

    // One frame of the clock: the edit moves `rate` frames - always worked out from the cut at the start
    // of the run and the frames moved in all, so no rounding adds up. Held (nothing changed), the run stops.
    _editTlDynTick() {
        const run = this._editTlDyn;
        if (!run || this._editTlTab !== run.tab || !this._editTlCut || !this._editTlOpen || !this._editTlOpen()) { this._editTlDynStop(); return; }
        const total = run.frames + run.dir * run.rate;
        const next = this._editTlDynCut(run, total);
        if (!next || D.sameCut(next, this._editTlCut)) { this._editTlDynStop("held"); return; }
        if (this._editTlApply(next) === false) { this._editTlDynStop("held"); return; }
        run.frames = total;
        const fps = next.fps || 24;
        if (run.what === "edit") {
            const t = this._editTlEditTime(run.info, next);
            if (Number.isFinite(t)) this._editTlGoFrame(Math.round(t * fps));
        }
        if (this.editTwoUpPulse && (run.what !== "edit" || this._editTlTrimMode)) this.editTwoUpPulse(run.what === "edit" ? run.live : { act: run.what, sel: run.sel }, next);
    },

    // The cut with the run's edit moved `frames` from where it stood at the start.
    _editTlDynCut(run, frames) {
        const cut = run.cut, d = frames / (cut.fps || 24), s = run.sel;
        if (run.what === "edit") return this._editTlTrimCompute(run.live, cut, d);
        if (run.what === "slip") return D.slipClip(cut, s, d, this._editTlDur());
        const slid = s.kind === "clip" ? D.slideClip(cut, s.i, d, this._editTlDur()) : D.slideTrackClip(cut, s.track, s.i, d, this._editTlDur());
        return slid ? D.followLink(cut, slid, s) : null;
    },

    /** The run ends: the steps it made become one step of the undo stack. */
    _editTlDynStop(why) {
        const run = this._editTlDyn;
        if (!run) return;
        this._editTlDyn = null;
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        win.clearInterval(run.timer);
        if (this._editTlHistories && run.tab && this._editTlCut && !D.sameCut(run.cut, this._editTlCut) && this._editTlTab === run.tab) {
            this._editTlHistories[run.tab] = D.historyPush(run.history, run.cut);
        }
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        this._editTlSay((why === "held" ? "held: " : "dynamic trim stopped: ")
            + `${run.frames >= 0 ? "+" : "−"}${Math.abs(run.frames)}f` + (why === "held" ? " (as far as it goes)" : "")
            + ` · ${D.timecode(Math.abs(run.frames) / fps, fps)}`);
        if (this.editTlRefresh) this.editTlRefresh();
    },
};
