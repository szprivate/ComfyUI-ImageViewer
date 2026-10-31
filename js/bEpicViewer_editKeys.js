// bEpicViewer_editKeys.js
// The keys of the Edit panel, an editor's:
//
//   B            the blade (A, or Esc, puts it away)
//   Ctrl+B, S    cut at the playhead
//   Del / Bksp   delete the selection, leaving a gap on a track of placed clips
//   Shift+Del    ripple delete: what follows closes up
//   Ctrl+Z       undo        Ctrl+Shift+Z, Ctrl+Y   redo
//   J K L        play backwards, stop, play
//   I / O        the start / end of the range played (the transport's own range)
//   ← →          a frame (Shift: a second)      ↑ ↓   the edit point before / after
//   Home / End   the first / last frame
//
// They act only while the timeline has the focus - a press in it gives it the
// focus (bEpicViewer_editTimeline.js) - and never while a field is typed into.
// The viewer's own key handler (handleKeyDown, on the window the viewer is in,
// popped out or not) asks editTlKeyDown first; the event's composed path is
// what says where it happened, since the panel lives in a shadow root (where a
// document listener only ever sees the host) or in another window.
import * as D from "./bEpicViewer_editTimelineData.js";

export const EDIT_KEYS = [
    ["B", "Blade: click a clip to cut it there (A or Esc: put it away)"],
    ["Ctrl+B, S", "Cut the clip under the playhead"],
    ["Del", "Delete (a gap stays on a track of placed clips)"],
    ["Shift+Del", "Ripple delete: what follows closes up"],
    ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"],
    ["J K L", "Play backwards / stop / play"],
    ["I / O", "Start / end of the range played"],
    ["← →", "A frame back / on (Shift: a second)"],
    ["↑ ↓", "The edit point before / after"],
    ["Home / End", "First / last frame"],
];

export const EditKeysMixin = {

    /** Does the focus lie in the timeline (and not in a field in it)? */
    _editTlFocused(e) {
        const ui = this._editTlUi;
        if (!ui || !ui.body.isConnected || !this._editTlOpen()) return false;
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(ui.body)) return false;
        const t = path[0];
        return !(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable));
    },

    /** A key pressed while the timeline has the focus: true when it was the timeline's. */
    editTlKeyDown(e) {
        if (!this._editTlFocused(e) || !this._editTlCut) return false;
        const key = e.key, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
        const low = String(key).toLowerCase();
        let done = true;
        if (alt) done = false;
        else if (ctrl && low === "z") { if (shift) this.editTlRedo(); else this.editTlUndo(); }
        else if (ctrl && low === "y") this.editTlRedo();
        else if (ctrl && low === "b") this.editTlSplitAtPlayhead();
        else if (ctrl) done = false;
        else if (low === "b" && !shift) this.editTlBladeToggle();
        else if (low === "a" && !shift) this.editTlBladeToggle(false);
        else if (low === "s" && !shift) this.editTlSplitAtPlayhead();
        else if (key === "Escape") {
            if (this._editTlMarks && this.editTlMarksCancel) this.editTlMarksCancel();
            else if (this._editTlBlade) this.editTlBladeToggle(false);
            else if (this._editTlSel) { this._editTlSel = null; this.editTlRefresh(); }
            else done = false;
        }
        else if (key === "Delete" || key === "Backspace") done = this.editTlDelete(shift);
        else if (low === "j" && !shift) this._editTlShuttle(-1);
        else if (low === "k" && !shift) this._editTlShuttle(0);
        else if (low === "l" && !shift) this._editTlShuttle(1);
        else if (low === "i" && !shift) this._editTlMark("in");
        else if (low === "o" && !shift) this._editTlMark("out");
        else if (key === "ArrowLeft" || key === "ArrowRight") {
            const fps = this._editTlCut.fps || 24;
            this._editTlGoFrame((this.currentFrame || 0) + (key === "ArrowLeft" ? -1 : 1) * (shift ? Math.round(fps) : 1));
        }
        else if (key === "ArrowUp" || key === "ArrowDown") this._editTlJumpEdit(key === "ArrowUp" ? -1 : 1);
        else if (key === "Home") this._editTlGoFrame(0);
        else if (key === "End") this._editTlGoFrame(D.filmFrames(this._editTlCut) - 1);
        else done = false;
        if (done) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
        return done;
    },

    // The transport works on the cut's tab: it comes up if another is.
    _editTlTransport() {
        if (!this._editTlTab || !this.allTabs[this._editTlTab]) return false;
        if (!this._editTlOnScreen()) this.switchTab(this._editTlTab);
        return this._editTlOnScreen();
    },

    _editTlGoFrame(frame) {
        if (!this._editTlTransport()) return;
        this._editTlShuttle(0, true);
        if (this.isPlaying) this.stop();
        this.setFrame(Math.max(0, Math.min(D.filmFrames(this._editTlCut) - 1, Math.round(frame))));
    },

    _editTlJumpEdit(dir) {
        if (!this._editTlTransport()) return;
        const fps = this._editTlCut.fps || 24;
        const now = (this.currentFrame || 0);
        const frames = D.editPoints(this._editTlCut).map((t) => Math.round(t * fps));
        const to = dir < 0 ? frames.filter((f) => f < now).pop() : frames.find((f) => f > now);
        if (to !== undefined) this._editTlGoFrame(to);
    },

    // J / K / L. L plays as the transport does; J runs the frames backwards on
    // a timer (a film cannot be played backwards, only shown frame by frame).
    _editTlShuttle(dir, quiet) {
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        if (this._editTlBack) { win.clearInterval(this._editTlBack); this._editTlBack = 0; }
        if (quiet) return;
        if (!this._editTlTransport()) return;
        if (dir === 0) { if (this.isPlaying) this.stop(); return; }
        if (dir > 0) { if (!this.isPlaying) this.play(); return; }
        if (this.isPlaying) this.stop();
        const fps = this._editTlCut.fps || 24;
        this._editTlBack = win.setInterval(() => {
            if (!this._editTlOnScreen() || (this.currentFrame || 0) <= 0) { this._editTlShuttle(0, true); return; }
            this.setFrame((this.currentFrame || 0) - 1);
        }, 1000 / fps);
    },

    // I / O: the range the transport plays and loops (its own playbackRange,
    // the one Ctrl-drag on its bar sets), shown on the timeline's ruler too.
    _editTlMark(which) {
        if (!this._editTlTransport()) return;
        const last = D.filmFrames(this._editTlCut) - 1;
        const now = Math.max(0, Math.min(last, this.currentFrame || 0));
        const r = this.playbackRange || { start: 0, end: last };
        this.playbackRange = which === "in" ? { start: now, end: Math.max(now, r.end) } : { start: Math.min(now, r.start), end: now };
        if (this.updateRangeOverlay) this.updateRangeOverlay();
        this.editTlRefresh();
    },
};
