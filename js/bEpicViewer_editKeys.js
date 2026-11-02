// bEpicViewer_editKeys.js
// The keys of the Edit panel, an editor's:
//
//   A            the Selection mode (the default; puts the blade away)
//   T            the Trim Edit mode: edges ripple, the middle of a cut rolls,
//                the body slips (upper half) or slides (lower half)
//   B            the blade (A, or Esc, puts it away)
//   Shift+T      an audio crossfade at the selected cut / the cut nearest the playhead (bEpicViewer_editXfade.js)
//   N            snapping on / off (hold S while dragging: the other way)
//   Ctrl+B, S    cut at the playhead
//   Del / Bksp   delete everything selected, leaving gaps (a lift) - on V1 too
//   Shift+Del    ripple delete: what follows closes up (a gap selected: closed)
//   Ctrl+Alt+L   unlink a film's sound onto a sound track / link a picture and its sound
//   D            disable / enable the selected clips (Resolve's Clip Enable)
//   E            extend the selected edit point (or the selected clip's out) to the playhead
//   Ctrl+Z       undo        Ctrl+Shift+Z, Ctrl+Y   redo
//   Ctrl+C       copy the selected clip     Alt+V   Paste Attributes... of it onto the selected clips
//   J K L        play backwards, stop, play
//   I / O        the start / end of the range played (the transport's own range)
//   ← →          a frame (Shift: a second)      ↑ ↓   the edit point before / after
//   Home / End   the first / last frame
//   Ctrl+= / Ctrl+-   zoom the timeline in / out      Shift+Z   the whole film
//   , .          an edit point selected: trim it a frame (Shift: a second), rippling in
//                the Trim mode; else MOVE the selected clips - never snapped
//   Alt+, Alt+.  slip the selected clip a frame of its source (Shift: a second)
//   Shift+S / A  through the cuts, three steps each: the left side (the outgoing out), both (a roll), the right
//                side (the incoming in), then the next cut - Shift+A the other way; Esc lets it go
//   Space        in the Trim mode with a cut selected: play around edit (1 s either side, looped)
//   Shift+R      the selected clip back at 100 % speed
//   Ctrl+L       one more turn of its loop (Ctrl+Shift+L: ping-pong)
//   X            in and out around the selected clip (else the shot under the playhead)
//   Alt+X, Shift+X   clear the in and out    Alt+I / Alt+O   clear one of them
//   Shift+I / Shift+O   go to the in / the out
//   Ctrl+Shift+M audio playback on / off (all of the cut's sound, playing and scrubbing)
//   Shift+M      audio scrubbing on / off (dragging the playhead or jogging plays grains of the sound)
//
//   ?            Show Hotkeys: the viewer's overlay lists these (EDIT_KEYS) while a cut's tab is up
//
// They act only while the timeline has the focus - a press in it gives it the
// focus (bEpicViewer_editTimeline.js) - and never while a field is typed into.
// The viewer's own key handler (handleKeyDown, on the window the viewer is in,
// popped out or not) asks editTlKeyDown first; the event's composed path is
// what says where it happened, since the panel lives in a shadow root (where a
// document listener only ever sees the host) or in another window.
import * as D from "./bEpicViewer_editTimelineData.js";

export const EDIT_KEYS = [
    ["?", "This list (the viewer's Show Hotkeys button too)"],
    ["A", "Selection mode (the default): a drag moves a clip, an edge trims that edge only - gaps stay"],
    ["T", "Trim Edit mode: an edge ripples, the middle of a cut rolls, a clip's upper half slips, its lower half slides"],
    ["B", "Blade: click a clip to cut it there (A or Esc: put it away)"],
    ["Shift+T", "Add an audio crossfade at the selected cut, else at the cut nearest the playhead (the selected clip's track, else the auto-selected tracks); its bar: drag an edge for its length, Del removes it"],
    ["Volume line on a sound clip", "Drag it up / down: the level (dB shown); Alt+click: a point (the Inspector's volume key); drag a point in time and level; Alt+click or Del removes it; right-click a point: its ease; the track header's right-click hides it"],
    ["Fade handles", "The small squares at a sound clip's upper corners: drag them in for a fade in / out (the Inspector's Audio tab has the numbers)"],
    ["Track header: lock / auto-select", "The padlock: nothing on the track can be edited (still played and rendered). The pointer-in-a-box: Auto Track Selector - only tracks with it on are rippled, inserted into, cut by Ctrl+B and stepped through"],
    ["N", "Snapping on / off (the magnet): clip and gap edges on every track, playhead, in / out, texts, start"],
    ["Hold S while dragging", "Snap the other way for this drag"],
    ["Ctrl+B, S", "Cut the clip under the playhead"],
    ["Del / Backspace", "Delete everything selected, leaving gaps (a lift) - a linked sound or picture goes with it"],
    ["Shift+Del", "Ripple delete everything selected: what follows closes up (a selected gap: closed)"],
    ["Ctrl+click, Shift+click", "Select several, on any tracks: picture, sound, the music, texts"],
    ["Drag from an empty place", "Marquee: everything it touches, on all tracks, is selected (Shift: added); drag one of them: all move"],
    ["Click a cut", "Selects that edit point, green on what moves, in every mode: its outgoing edge, its incoming edge, or the middle (a roll)"],
    ["Shift+S / Shift+A", "Step through the cuts, three steps each: Shift+S the out of the clip before (left), both sides (a roll), the in of the clip after (right), then the next cut; Shift+A back. On the selected clip's track, else V1"],
    ["Space in the Trim mode, a cut selected", "Play around edit: a second before the cut to a second after it, looped; , / . move the cut while it plays"],
    ["Esc", "Let go of the edit point, then of the selection"],
    ["Inspector diamond \u25c7", "Keyframe the row at the playhead (filled: a key here); \u25c2 \u25b8 the key before / after; once animated, a change makes a key by itself; right-click: ease; its reset takes the keys too"],
    ["Keyframe marks on the selected clip", "Drag along the clip to move a key (snaps to frames and the playhead); click + Del takes it away; right-click: linear / ease in / ease out / ease in-out / hold"],
    ["D", "Disable / enable the selected clips (and their linked sound or picture): dimmed, not seen, not heard, not rendered - the track under shows"],
    ["Ctrl+Alt+L", "Unlink a film's sound onto a sound track / relink it, from either part (the offset stays; right-click: Resync, Merge audio back into clip)"],
    ["Ctrl+S", "Save the cut: the bar then says where it went"],
    ["Ctrl+Shift+S", "Save cut as\u2026: another name or folder, and the tab goes on with that file"],
    ["Ctrl+Shift+drag", "Insert a clip into the order (what follows moves); a plain drag overwrites and leaves a gap"],
    ["Drag above the top video / below the bottom sound track", "A new track, for a picture / a sound; also for a drop from outside"],
    ["E", "Extend the selected edit point or the clip's out to the playhead"],
    ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"],
    ["Ctrl+C", "Copy the selected clip (or text) - for Paste Attributes; also on its right-click menu"],
    ["Alt+V", "Paste Attributes…: the copied clip's zoom, position, anchor, rotation, flip, cropping, opacity, volume, keyframes, speed, name, colour or text look onto the selected clips (one undo step)"],
    ["J K L", "Play backwards / stop / play"],
    ["I / O", "Start / end of the range played"],
    ["← →", "A frame back / on (Shift: a second)"],
    ["↑ ↓", "The edit point before / after"],
    ["Home / End", "First / last frame"],
    ["Ctrl+= / Ctrl+-", "Zoom the timeline in / out, down to 0.25x: empty timeline after the film (also Ctrl + wheel)"],
    ["Shift+Z", "Zoom to fit: the whole film"],
    ["Edge drag", "Trim: left of a cut the outgoing shot's out, right of it the incoming in (the lit side); Trim mode: ripple"],
    ["Middle of a cut", "Roll: move the cut, the film keeps its length"],
    ["Alt+drag", "Slip: same place and length, another part of the source"],
    [", / .", "An edit point selected: trim it a frame (Shift: a second) - Trim mode ripples, Selection opens or closes a gap"],
    [", / . on a clip", "Move the selected clips a frame (Shift: a second). Selection: into a gap, stopping at the next clip. Trim: one clip slides. Several: all move, over what is there"],
    ["Drag one of several selected", "All move together - in time and up / down by tracks - over the clips they land on, leaving gaps (Selection mode)"],
    ["Alt+, / Alt+.", "Slip the selected clip a frame (Shift: a second)"],
    ["Alt+Shift+drag", "Slide (V1): the shot moves, its neighbours give and take"],
    ["Alt+drag an edge", "Retime: the source stays, the speed fills the new length"],
    ["Shift+R", "Speed back to 100 %"],
    ["Ctrl+drag the out-edge", "Loop extend: longer than the source, by playing it again"],
    ["Ctrl+L / Ctrl+Shift+L", "One more turn of the loop / of a ping-pong"],
    ["X", "In and out around the selected clip (else the shot under the playhead)"],
    ["Alt+X, Shift+X", "Clear the in and out"],
    ["Shift+I / Shift+O", "Go to the in / the out"],
    ["Alt+I / Alt+O", "Clear the in / the out"],
    ["Ctrl+drag the ruler", "Draw the in and out; right-click it: in / out here, clear"],
    ["Drag the playhead's line", "Scrub from anywhere down the tracks (within 4 px of the line); an edit point exactly under it still takes the click"],
    ["Ctrl+Shift+M", "Audio playback on / off: all of the cut's sound, playing and scrubbing (the speaker in the bar; the export is not touched)"],
    ["Shift+M", "Audio scrubbing on / off: dragging the playhead, J K L and the arrows play the sound under it, pitched with the speed"],
    ["Add > Files, Selected canvas nodes", "Insert at the playhead: a shot there is split, what follows moves on, the playhead goes to their end (nodes: left to right)"],
    ["Trim mode: trimming an edit", "The viewer shows the outgoing clip's last frame and the incoming one's first, side by side (slip: the new in and out)"],
];

export const EditKeysMixin = {

    /** Does the focus lie in the timeline (and not in a field in it)? */
    _editTlFocused(e) {
        const ui = this._editTlUi;
        if (!ui || !ui.body.isConnected || !this._editTlOpen()) return false;
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(ui.body)) return false;
        // A dialog over the timeline (Paste Attributes, Save cut as...) has its own keys.
        if (path.some((n) => n && n.classList && n.classList.contains("edit-dialog"))) return false;
        const t = path[0];
        return !(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable));
    },

    /** A key pressed while the timeline has the focus: true when it was the timeline's. */
    editTlKeyDown(e) {
        // S held while dragging: snapping the other way for that drag (not a split).
        if (this._editTlDragging && this._editTlSnapKey && this._editTlSnapKey(e)) return true;
        if (!this._editTlFocused(e) || !this._editTlCut) return false;
        const key = e.key, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
        const low = String(key).toLowerCase();
        // The letter by its place on the keyboard: Alt and Shift change what e.key says.
        const letter = /^Key[A-Z]$/.test(e.code || "") ? e.code.slice(3).toLowerCase() : low;
        const comma = e.code === "Comma" || key === "," || key === "<";
        const period = e.code === "Period" || key === "." || key === ">";
        let done = true;
        if (alt && ctrl && letter === "l") this.editTlLinkToggle();
        else if (alt && !ctrl) {
            if (letter === "x") this._editTlSetRange(null);
            else if (letter === "i") this._editTlClearMark("in");
            else if (letter === "o") this._editTlClearMark("out");
            else if (letter === "v" && !shift) this.editTlPasteDialog();
            else if (comma || period) this.editTlSlipBy((comma ? -1 : 1) * (shift ? Math.round(this._editTlCut.fps || 24) : 1));
            else done = false;
        }
        else if (alt) done = false;
        else if (ctrl && letter === "l") this.editTlLoopOnce(shift ? "pingpong" : "loop");
        else if (ctrl && low === "z") { if (shift) this.editTlRedo(); else this.editTlUndo(); }
        else if (ctrl && low === "y") this.editTlRedo();
        else if (ctrl && letter === "c" && !shift) this.editTlCopy();
        else if (ctrl && low === "b") this.editTlSplitAtPlayhead();
        else if (ctrl && shift && letter === "m") this.editAudioToggle("play");
        else if (ctrl && letter === "s") {
            if (shift) this.editTlSaveAsDialog();
            else if (this._editTlDirty()) this._editTlSave();
            else this._editTlSay("nothing to save");
        }
        // Zoom, as in Resolve: Ctrl+= / Ctrl++ in, Ctrl+- out (the browser's own page zoom is kept off).
        else if (ctrl && (key === "=" || key === "+")) this._editTlZoom(this._editTlView.zoom * 1.5);
        else if (ctrl && (key === "-" || key === "_")) this._editTlZoom(this._editTlView.zoom / 1.5);
        else if (ctrl) done = false;
        else if (letter === "b" && !shift) this.editTlBladeToggle();
        // The edit before / after (S alone cuts; S held in a drag is the snapping, above).
        else if (letter === "a" && shift) this.editTlEditStep(-1);
        else if (letter === "s" && shift) this.editTlEditStep(1);
        else if (letter === "a" && !shift) this.editTlMode("select");
        else if (letter === "t" && !shift) this.editTlMode("trim");
        else if (letter === "t" && shift) this.editTlAudioXfadeKey();
        else if (letter === "n" && !shift) this.editTlSnapToggle();
        else if (letter === "e" && !shift) this.editTlExtendEdit();
        else if (letter === "d" && !shift) this.editTlDisableToggle();
        else if (low === "z" && shift) this._editTlZoom(1);
        else if (low === "s" && !shift) this.editTlSplitAtPlayhead();
        else if (key === "?") this.toggleHelpOverlay();
        else if (key === "Escape") {
            if (this._editTlKeySel) { this._editTlKeySel = null; this.editTlRefresh(); }
            else if (this._editTlVolSel) { this._editTlVolSel = null; this.editTlRefresh(); }
            else if (this._editTlMarks && this.editTlMarksCancel) this.editTlMarksCancel();
            else if (this._editTlBlade) this.editTlBladeToggle(false);
            else if (this._editTlEditPoint()) { this._editTlEditSel = null; this.editTlRefresh(); }
            else if (this._editTlSel) { this._editTlSel = null; this._editTlMulti = null; this.editTlRefresh(); }
            else done = false;
        }
        else if ((key === "Delete" || key === "Backspace") && this._editTlKeySel && this.editTlKeyDelete && this.editTlKeyDelete()) done = true;
        else if ((key === "Delete" || key === "Backspace") && this._editTlVolSel && this.editTlVolDelete && this.editTlVolDelete()) done = true;
        else if (key === "Delete" || key === "Backspace") done = this.editTlDelete(shift);
        else if (low === "j" && !shift) this._editTlShuttle(-1);
        else if (low === "k" && !shift) this._editTlShuttle(0);
        else if (low === "l" && !shift) this._editTlShuttle(1);
        else if (letter === "i") { if (shift) this._editTlGoMark("in"); else this._editTlMark("in"); }
        else if (letter === "o") { if (shift) this._editTlGoMark("out"); else this._editTlMark("out"); }
        else if (letter === "x") { if (shift) this._editTlSetRange(null); else this.editTlMarkClip(); }
        else if (letter === "r" && shift) this.editTlSpeedReset();
        else if (letter === "m" && shift) this.editAudioToggle("scrub");
        else if (comma || period) {
            const fps = this._editTlCut.fps || 24;
            this.editTlNudge((comma ? -1 : 1) * (shift ? Math.round(fps) : 1));
        }
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
        const f = Math.max(0, Math.min(D.filmFrames(this._editTlCut) - 1, Math.round(frame)));
        this.setFrame(f);
        // A jog is heard: a grain of the sound there (bEpicViewer_editAudio.js).
        if (this.editScrubAt) this.editScrubAt(f / (this._editTlCut.fps || 24));
    },

    _editTlJumpEdit(dir) {
        if (!this._editTlTransport()) return;
        const fps = this._editTlCut.fps || 24;
        const now = (this.currentFrame || 0);
        // The edits of the tracks whose Auto Track Selector is on (Resolve's Up / Down).
        const frames = D.editPoints(this._editTlCut, D.editMask(this._editTlCut)).map((t) => Math.round(t * fps));
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
            if (this.editScrubAt) this.editScrubAt((this.currentFrame || 0) / fps);    // heard backwards
        }, 1000 / fps);
    },
};
