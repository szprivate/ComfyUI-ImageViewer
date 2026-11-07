// imageViewer_editTwoUp.js
// The trim view, as Resolve's: with the Trim Edit mode on, while an edit point
// is trimmed or rolled (dragged, or nudged with , / .), the viewer shows two
// frames side by side - on the left the LAST frame of the clip going out, on
// the right the FIRST frame of the clip coming in - each with its timecode,
// both following the edit as it moves. A slip shows the slipped clip's new
// first and last frames (its in and out), a slide the last frame of the clip
// before it and the first of the clip after it. What is shown is the frame of
// the source that plays at that edge (twoUpFrames: retime and loop counted).
//
// It comes up at the press (or the nudge) and goes when the drag is let go,
// TWOUP_HOLD ms after the last nudge, or when the Trim mode is left. And it is
// there AT REST too: in the Trim mode, whenever the playhead stands on a cut (on
// the track of the selected clip or edit point, else V1; within half a frame)
// - after a step, Shift+A / S or a scrub - until the playhead leaves the cut,
// the film plays, or the Trim mode is left (editTwoUpRest; debounced, so a
// scrub does not ask for a frame at every move). A trim that ends with the
// playhead on a cut leaves that view up instead of fading it. It is a
// layer of its own over the viewport (#viewport, in the shadow root - so full
// screen and the pop-out carry it), with a <video> and an <img> per side: the
// player's own layers and the playhead are not touched, so nothing fights the
// ganged playhead. A film is sought to the frame's moment (its middle, so the
// frame is exact); while a seek is on the next one waits for it (`seeked`) and
// the frame that is up stays up meanwhile, as the player does.
import * as D from "./imageViewer_editTimelineData.js";

export const TWOUP_HOLD = 900;
export const TWOUP_REST_DELAY = 70;

export const EditTwoUpMixin = {

    // The layer, made once per viewport (again if the viewer was moved into another window).
    _editTwoUpLayer() {
        const port = this.container && this.container.querySelector("#viewport");
        if (!port) return null;
        const t = this._etu;
        if (t && t.root.isConnected && t.root.parentNode === port) return t;
        if (t && t.root.parentNode) t.root.remove();
        const doc = port.ownerDocument;
        const root = doc.createElement("div");
        root.className = "edit-twoup";
        root.style.display = "none";
        const side = (name) => {
            const box = doc.createElement("div");
            box.className = "edit-twoup-side";
            box.dataset.side = name;
            // A click on a pane picks that side of the cut (editTwoUpPick); none of it reaches the viewer's own handlers.
            for (const ev of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu"]) box.addEventListener(ev, (e) => e.stopPropagation());
            box.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); this.editTwoUpPick(name); });
            const pic = doc.createElement("div");
            pic.className = "edit-twoup-pic";
            const v = doc.createElement("video");
            v.muted = true;
            v.playsInline = true;
            v.preload = "auto";
            v.style.display = "none";
            v.addEventListener("seeked", () => {
                // The last move asked for another frame while this seek was on: go there now.
                if (v._want != null && Math.abs((v.currentTime || 0) - v._want) > 1e-3) { try { v.currentTime = v._want; } catch (_) {} }
            });
            const img = doc.createElement("img");
            img.draggable = false;
            img.style.display = "none";
            const none = doc.createElement("div");
            none.className = "edit-twoup-none";
            pic.append(v, img, none);
            const label = doc.createElement("div");
            label.className = "edit-twoup-label";
            box.append(pic, label);
            return { box, v, img, none, label };
        };
        const left = side("left"), right = side("right");
        root.append(left.box, right.box);
        port.append(root);
        this._etu = { root, left, right };
        return this._etu;
    },

    /** Is the two-up up? */
    editTwoUpShown() { return !!(this._etu && this._etu.root.isConnected && this._etu.root.style.display !== "none"); },

    /**
     * Show the two frames of edit `info` ({ act, sel, a, b, side }) as the cut
     * `cut` stands (the cut in the panel without one). Only in the Trim mode,
     * and only while the cut is the tab on screen.
     */
    editTwoUpShow(info, cut) {
        // Not while the cut plays (play around edit shows the film itself, as Resolve's does).
        if (!this._editTlTrimMode || !info || this.isPlaying || !this._editTlOnScreen || !this._editTlOnScreen()) { this.editTwoUpHide(); return; }
        const c = cut || this._editTlCut;
        const fps = (c && c.fps) || 24;
        const fr = D.twoUpFrames(c, info, fps);
        if (!fr) { this.editTwoUpHide(); return; }
        const layer = this._editTwoUpLayer();
        if (!layer) return;
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        if (this._etuTimer) { win.clearTimeout(this._etuTimer); this._etuTimer = 0; }
        if (this._etuRestTimer) { win.clearTimeout(this._etuRestTimer); this._etuRestTimer = 0; }
        const slip = fr.act === "slip";
        this._editTwoUpSide(layer.left, fr.left, slip ? "In" : "Out", fps);
        this._editTwoUpSide(layer.right, fr.right, slip ? "Out" : "In", fps);
        layer.root.dataset.act = fr.act;
        layer.root.style.display = "flex";
        this._editTwoUpMark();
    },

    /** The stop under the playhead on the selected track ({ t, a, b }), the cut the panes stand for; null off a cut. */
    _editTwoUpStop() {
        const cut = this._editTlCut;
        if (!this._editTlTrimMode || this.isPlaying || !cut || !this._editTlOnScreen || !this._editTlOnScreen()) return null;
        const point = this._editTlEditPoint ? this._editTlEditPoint() : null;
        const on = point ? point.sel : this._editTlSel;
        const track = on && on.kind === "tclip" ? on.track : "V1";
        const fps = cut.fps || 24, head = this.currentFrame || 0;
        return D.editStops(cut, track).find((st) => Math.abs(st.t * fps - head) < 0.5) || null;
    },

    /** Which pane(s) the selected edit point is on this cut: "left", "right", "both" or "" (data-pick, drawn by the css). */
    _editTwoUpMark() {
        const t = this._etu;
        if (!t) return;
        const stop = this._editTwoUpStop(), point = this._editTlEditPoint ? this._editTlEditPoint() : null;
        let pick = "";
        if (stop && point) {
            const same = (x, y) => x && y && D.selId(x) === D.selId(y);
            const here = point.act === "roll" ? same(point.a, stop.a) && same(point.b, stop.b)
                : point.side === "end" ? same(point.sel, stop.a) : same(point.sel, stop.b);
            if (here) pick = D.pointState(point);
        }
        t.root.dataset.pick = pick;
    },

    /**
     * A click on a pane: the left one selects the cut's LEFT side (the outgoing clip's out), the right one
     * its RIGHT side (the incoming clip's in) - Shift+A / S's two states, so , / . trim that side and the
     * green marks follow. Clicking the side that is the only one selected picks BOTH (a roll), as Resolve's
     * toggle does; clicking a pane while both are selected picks that side. A side the cut has not (the
     * film's start or end, a gap) does nothing.
     */
    editTwoUpPick(name) {
        const stop = this._editTwoUpStop();
        if (!stop) return;
        const side = name === "left" ? stop.a : stop.b;
        if (!side) return;
        this._editTwoUpMark();
        const cur = this._etu && this._etu.root.dataset.pick;
        let state = name;
        if (cur === name && stop.a && stop.b) state = "both";
        this._editTlEditSel = D.stepPoint({ t: stop.t, stop, state });
        this._editTlMulti = null;
        this._editTlSel = this._editTlEditSel.sel;
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        this._editTlSay({ left: "the out of the clip before the cut", both: "both sides: a roll", right: "the in of the clip after the cut" }[state]
                        + ` · ${D.timecode(stop.t, fps)}`);
        this.editTlRefresh();
        this._editTwoUpMark();
        const ui = this._editTlUi;
        if (ui && ui.body && ui.body.focus) { try { ui.body.focus({ preventScroll: true }); } catch (_) {} }
    },

    /** A nudge: shown, then put away TWOUP_HOLD ms after the last one. */
    editTwoUpPulse(info, cut) {
        this.editTwoUpShow(info, cut);
        if (!this.editTwoUpShown()) return;
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        if (this._etuTimer) win.clearTimeout(this._etuTimer);
        this._etuTimer = win.setTimeout(() => { this._etuTimer = 0; this.editTwoUpHide(); this.editTwoUpRest(); }, TWOUP_HOLD);
    },

    /** The edit point the playhead rests on, as an edit ({ act: "roll", sel, a, b }) - null off a cut. */
    _editTwoUpRestInfo() {
        const cut = this._editTlCut;
        if (!this._editTlTrimMode || this.isPlaying || !cut || !this._editTlOnScreen || !this._editTlOnScreen()) return null;
        const sel = this._editTlSel;
        const on = this._editTlEditPoint ? (this._editTlEditPoint() || {}).sel || sel : sel;
        const track = on && on.kind === "tclip" ? on.track : "V1";
        const fps = cut.fps || 24, head = this.currentFrame || 0;
        const stop = D.editStops(cut, track).find((st) => Math.abs(st.t * fps - head) < 0.5);
        if (!stop) return null;
        return { act: "roll", sel: stop.b || stop.a, a: stop.a, b: stop.b };
    },

    /**
     * Settle the two-up for where the playhead is (called whenever it moves, the mode or
     * the play state changes): up on a cut, away off it. Away at once; up after a short
     * pause, so a scrub asks for the frame it comes to rest on. A trim or a nudge in
     * progress is left alone (its own view, put away by the drag's end / TWOUP_HOLD).
     */
    editTwoUpRest() {
        // A selected edit point holds the playhead on its cut first (imageViewer_editTrim.js), so the view below rests on it.
        if (this._editTlTrimFollow) this._editTlTrimFollow();
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        if (this._etuRestTimer) { win.clearTimeout(this._etuRestTimer); this._etuRestTimer = 0; }
        if (this._etuDrag || this._etuTimer) return;
        if (!this._editTwoUpRestInfo()) { this.editTwoUpHide(); return; }
        this._etuRestTimer = win.setTimeout(() => {
            this._etuRestTimer = 0;
            if (this._etuDrag || this._etuTimer) return;
            const info = this._editTwoUpRestInfo();
            if (info) this.editTwoUpShow(info, this._editTlCut); else this.editTwoUpHide();
        }, TWOUP_REST_DELAY);
    },

    editTwoUpHide() {
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        if (this._etuTimer) { win.clearTimeout(this._etuTimer); this._etuTimer = 0; }
        if (this._etuRestTimer) { win.clearTimeout(this._etuRestTimer); this._etuRestTimer = 0; }
        const t = this._etu;
        if (!t || t.root.style.display === "none") return;
        t.root.style.display = "none";
        for (const s of [t.left, t.right]) { try { s.v.pause(); } catch (_) {} }
    },

    // One side: the frame `f` (edgeFrame) of its clip, or "no clip" for none.
    _editTwoUpSide(side, f, word, fps) {
        const box = side.box;
        if (!f) {
            side.v.style.display = side.img.style.display = "none";
            side.none.style.display = "flex";
            side.none.textContent = word === "Out" ? "start of the track" : "end of the track";
            side.label.textContent = word;
            box.dataset.frame = box.dataset.srcFrame = box.dataset.clip = "";
            return;
        }
        side.none.style.display = "none";
        const clip = f.clip;
        const url = this.buildImgUrl({ path: clip.file, external: true }, { noColor: true });
        const name = clip.name || String(clip.file || "").split(/[\\/]/).pop();
        box.dataset.frame = String(f.frame);
        box.dataset.srcFrame = f.still ? "" : String(f.srcFrame);
        box.dataset.clip = D.selId(f.sel);
        const tl = D.timecode(f.frame / fps, fps);
        side.label.textContent = `${word} · ${name} · ${tl}` + (f.still ? "" : ` · src ${D.timecode(f.srcFrame / fps, fps)}`);
        if (f.still || D.isStill(clip.file)) {
            side.v.style.display = "none";
            if (side.img._url !== url) { side.img._url = url; side.img.src = url; }
            side.img.style.display = "block";
            return;
        }
        side.img.style.display = "none";
        const v = side.v;
        if (v._url !== url) { v._url = url; v.src = url; }
        v._want = f.src;
        v.style.display = "block";
        // The frame up stays up while the next is sought; a seek running takes the next one when it is done.
        if (!v.seeking && Math.abs((v.currentTime || 0) - f.src) > 1e-3) { try { v.currentTime = f.src; } catch (_) {} }
    },
};
