// imageViewer_editMatch.js
// Match frame (F, Resolve's): the clip under the playhead - the selected one when
// the playhead is in it, else the picture on top there - is opened from its own
// file in the Source viewer (a single viewer switches to it, as Resolve's), on the
// frame the cut shows; without a Source viewer (an older page), in the Viewer tab. Its arithmetic is
// `matchFrame` in imageViewer_editTimelineData.js (srcLocal: speed, loops,
// reverse, freeze and ramps counted). Into the Viewer tab, the cut's tab is left, as any Open is;
// the History's strip and the tab bar bring it back.
//
// Still frame (G): the same frame, written as a PNG at the source's own size and put into the
// History; Alt+G also inserts it into the cut at the playhead as a still.
import { api } from "../../scripts/api.js";
import * as D from "./imageViewer_editTimelineData.js";
import { canvasContext } from "./imageViewer_exportUI.js";

export const EditMatchMixin = {

    /** What F would open: matchFrame at the middle of the playhead's frame. */
    _editTlMatchAt() {
        const cut = this._editTlCut;
        if (!cut) return null;
        const fps = cut.fps || 24;
        const t = ((Number(this.currentFrame) || 0) + 0.5) / fps;
        // A compound clip has no file: what it shows there is one of its inner clips, in the cut as it plays.
        // (its places differ from the panel's, so the selection is not used there).
        const flat = this._editFlat ? this._editFlat(cut) : cut;
        return D.matchFrame(flat, t, flat === cut ? this._editTlSel : null, this._editTlLive ? this._editTlLive() : null);
    },

    /** F: the source of the frame under the playhead, in the Viewer tab, on that frame. -> the match, or null. */
    async editTlMatchFrame() {
        const hit = this._editTlMatchAt();
        if (!hit) { this._editTlSay("nothing to match here: no clip with a file under the playhead"); return null; }
        // On a cut's tab: the Source viewer, as Resolve's match frame loads its source monitor.
        if (this._editSrcOn && this._editSrcOn() && this.editSrcLoad) {
            await this.editSrcLoad({ path: hit.file, name: hit.name }, hit.src);
            return hit;
        }
        const frames = this._browserFramesFor ? (await this._browserFramesFor([hit.file])).filter(Boolean) : [];
        if (!frames.length || !frames[0].length) { this._editTlSay(`cannot open ${hit.name || hit.file}`); return null; }
        const snap = frames[0];
        if (snap[0] && typeof snap[0] === "object") snap[0].matchSrc = hit.src;
        this.showInViewerTab([snap], { dedupe: false });
        if (!hit.still) await this._editTlMatchSeek(hit.src);
        return hit;
    },

    /**
     * G: a still of the frame under the playhead - the source frame of the selected clip when the
     * playhead is in it, else of the picture on top - saved as a PNG (the export rule's place for
     * a frame) and put into the History. `insert` (Alt+G) also inserts it at the playhead, on the
     * selected clip's video track, else V1: one undo step. -> { path, ... } or null.
     */
    async editTlStillFrame({ insert = false } = {}) {
        const hit = this._editTlMatchAt();
        if (!hit) { this._editTlSay("no still to make here: no clip with a picture under the playhead"); return null; }
        if (this._editTlStillBusy) return null;
        this._editTlStillBusy = true;
        let made = null;
        try {
            const stem = String(hit.file).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
            const res = await api.fetchApi("/imageviewer/timeline_still", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ file: hit.file, src: hit.src, name: hit.name || stem, context: canvasContext() }),
            });
            if (!res.ok) {
                this._editTlSay(`no still made: ${(await res.text().catch(() => "")) || res.status}`);
                return null;
            }
            made = await res.json();
        } catch (e) {
            this._editTlSay(`no still made: ${(e && e.message) || e}`);
            return null;
        } finally {
            this._editTlStillBusy = false;
        }
        let shown = false;
        try {
            const res = await api.fetchApi("/imageviewer/push", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths: [made.path], group: "Edit stills", label: "Still frame", focus: false }),
            });
            const body = await res.json().catch(() => ({}));
            shown = !!(res.ok && body.shown);
        } catch (_) {}
        if (insert) {
            await this._editTlAdd([{ path: made.path, name: made.name, kind: "image" }], this._editTlNowSeconds(), "", "",
                                  { insert: true, track: this._editTlInsertTrack() });
        }
        this._editTlSay(`still frame ${made.width} x ${made.height}${insert ? ", inserted at the playhead" : ""}: `
                        + `${made.path}${shown ? " (in the History, Edit stills)" : ""}`);
        return made;
    },

    // The film in the Viewer tab to the source moment: once it knows its frames (its rate comes with them).
    async _editTlMatchSeek(src) {
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        for (let k = 0; k < 120; k++) {
            if (this._videoMode && this._videoFrames > 0) break;
            await new Promise((r) => win.setTimeout(r, 25));
        }
        if (!this._videoMode) return;
        const fps = this._videoFps || 24;
        this.setFrame(Math.floor(src * fps + 1e-6));
    },
};
