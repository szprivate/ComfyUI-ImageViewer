// imageViewer_editMatch.js
// Match frame (F, Resolve's): the clip under the playhead - the selected one when
// the playhead is in it, else the picture on top there - is opened from its own
// file in the Source viewer (a single viewer switches to it, as Resolve's), on the
// frame the cut shows; without a Source viewer (an older page), in the Viewer tab. Its arithmetic is
// `matchFrame` in imageViewer_editTimelineData.js (srcLocal: speed, loops,
// reverse, freeze and ramps counted). Into the Viewer tab, the cut's tab is left, as any Open is;
// the History's strip and the tab bar bring it back.
import * as D from "./imageViewer_editTimelineData.js";

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
