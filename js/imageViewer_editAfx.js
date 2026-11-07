// imageViewer_editAfx.js
// Sound effects in the Edit panel, as Resolve's Effects Library / Fairlight FX:
// the Effects panel's "Audio FX" category lists them (EQ, Compressor, Limiter,
// Reverb, Delay, Gain, Pan); one is DRAGGED onto
//
//   a sound clip (a clip of a sound track, or a film with sound)   - that clip only
//   a sound track's empty lane, or its header (the bed's too)       - the whole track
//
// with the target lit while it is over it (.afx-target); a locked track takes
// none. Double-clicking one in the library puts it on the selected clips, else on
// the selected track. What is applied shows as marks: "fx" on a clip, a badge per
// effect in a track's header - a click opens it in the Inspector (the clip's
// Audio tab, Audio FX; the track's Track FX), where effects are added ("+ Add
// effect"), bypassed, reordered, removed and their params set and keyed (mix,
// gain, pan). The chain order: clip effects, the clip's volume and fades, the
// track's effects, the mix. Data: imageViewer_audioFxData.js; playing:
// imageViewer_editAfxPlay.js; rendering: audio_fx.py.
import * as A from "./imageViewer_audioFxData.js";
import * as D from "./imageViewer_editTimelineData.js";

export const AFX_DRAG = "application/x-imageviewer-afx";

export const EditAfxMixin = {

    /** What a drag over `e` would put an effect on: { sel } (a clip), { track }, or null. */
    _editAfxTargetAt(e) {
        const cut = this._editTlCut;
        if (!cut) return null;
        const path = e.composedPath ? e.composedPath() : [e.target];
        const block = path.find((n) => n && n.dataset && n.dataset.key && n.classList && n.classList.contains("edit-shot"));
        const row = path.find((n) => n && n.classList && (n.classList.contains("edit-track") || n.classList.contains("edit-headrow")) && n.dataset.track);
        if (block) {
            const [tid, i] = [block.dataset.key.slice(0, block.dataset.key.lastIndexOf(":")), Number(block.dataset.key.split(":").pop())];
            const sel = tid === "V1" ? { kind: "clip", i } : { kind: "tclip", track: tid, i };
            if (D.afxTakes(cut, sel)) return { sel, el: block, track: tid };
        }
        const bed = path.find((n) => n && n.classList && n.classList.contains("edit-snd"));
        if (bed) return { track: "A1", el: bed.closest(".edit-track") || bed };
        if (row && D.afxTrack(cut, row.dataset.track)) return { track: row.dataset.track, el: row };
        return null;
    },

    /** The lit target of a drag (null puts the light out). */
    _editAfxMark(t) {
        const ui = this._editTlUi;
        if (!ui) return;
        for (const n of ui.body.querySelectorAll(".afx-target")) n.classList.remove("afx-target");
        if (t && t.el) t.el.classList.add("afx-target");
    },

    /** An effect of `type` dropped on target `t` (_editAfxTargetAt): one undo step. */
    editAfxDrop(type, t) {
        const cut = this._editTlCut;
        this._editAfxMark(null);
        if (!cut || !A.AFX[type] || !t) { this._editTlSay("drop a sound effect on a sound clip, or on a sound track's lane or header"); return false; }
        const track = t.sel ? D.selTrack(t.sel) : t.track;
        if (D.trackFlags(cut, track).lock) { this._editTlSay(`${track} is locked: it takes no effect`); return false; }
        const fx = A.newAfx(type);
        if (t.sel) {
            const list = D.clipAfx(cut, t.sel);
            if (list.length >= A.MAX_AFX) { this._editTlSay("that clip has as many effects as it can"); return false; }
            this._editTlSel = t.sel;
            this._editInspTab = "audio";
            this._editAfxOpen = { where: "clip", i: list.length };
            this._editTlApply(D.setClipAfx(cut, t.sel, [...list, fx]));
            this._editTlSay(`${A.AFX[type].name} on the clip`);
        } else {
            const list = D.trackAfx(cut, track);
            if (list.length >= A.MAX_AFX) { this._editTlSay("that track has as many effects as it can"); return false; }
            this._editTlSel = { kind: "track", track };
            this._editAfxOpen = { where: "track", i: list.length };
            this._editTlApply(D.setTrackAfx(cut, track, [...list, fx]));
            this._editTlSay(`${A.AFX[type].name} on track ${track}`);
        }
        return true;
    },

    /** Double-click in the library: onto the selected sound clips, else the selected track. */
    editAfxAdd(type) {
        const cut = this._editTlCut;
        if (!cut || !A.AFX[type]) return false;
        const sel = this._editTlSel;
        if (sel && sel.kind === "track") return this.editAfxDrop(type, { track: sel.track });
        const clips = (this._editTlSelAll ? this._editTlSelAll() : [sel]).filter((s) => s && D.afxTakes(cut, s) && !D.trackFlags(cut, D.selTrack(s)).lock);
        if (!clips.length) { this._editTlSay("select sound clips or a sound track (click its name), or drag the effect onto one"); return false; }
        let next = cut;
        for (const s of clips) { const list = D.clipAfx(next, s); if (list.length < A.MAX_AFX) next = D.setClipAfx(next, s, [...list, A.newAfx(type)]); }
        this._editInspTab = "audio";
        this._editTlApply(next);
        this._editTlSay(`${A.AFX[type].name} on ${clips.length} clip${clips.length === 1 ? "" : "s"}`);
        return true;
    },

    /** The "fx" mark on a clip's block that has effects; a click opens them in the Inspector. */
    _editAfxClipBadge(b, sel, clip) {
        const list = A.cleanAfx(clip && clip.afx);
        if (!list.length) return;
        const doc = b.ownerDocument;
        const m = doc.createElement("span");
        m.className = "edit-badge-afx" + (A.afxActive(list) ? "" : " off");
        m.textContent = "fx";
        m.title = "Sound effects: " + list.map((fx) => A.AFX[fx.type].name + (fx.on ? "" : " (bypassed)")).join(", ") + " - click: the Inspector";
        m.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            this._editTlSel = sel;
            this._editTlEditSel = null;
            this._editInspTab = "audio";
            this._editAfxOpen = { where: "clip", i: 0 };
            if (this._editTlOpenInspector) this._editTlOpenInspector();
            this.editTlRefresh();
        });
        b.append(m);
    },

    /** A track header's effect badges (and its name selects the track, for its Track FX). */
    _editAfxHeadBadges(hd, row) {
        const cut = this._editTlCut;
        if (!cut || !D.afxTrack(cut, row.id)) return;
        hd.dataset.track = row.id;
        const list = D.trackAfx(cut, row.id);
        const doc = hd.ownerDocument;
        const box = doc.createElement("span");
        box.className = "edit-afxbadges";
        const open = (i) => {
            this._editTlSel = { kind: "track", track: row.id };
            this._editTlEditSel = null;
            this._editTlMulti = null;
            this._editAfxOpen = { where: "track", i };
            if (this._editTlOpenInspector) this._editTlOpenInspector();
            this.editTlRefresh();
        };
        list.forEach((fx, i) => {
            const m = doc.createElement("button");
            m.className = "edit-afxbadge" + (fx.on ? "" : " off");
            m.textContent = A.AFX_SHORT[fx.type];
            m.title = `${A.AFX[fx.type].name}${fx.on ? "" : " (bypassed)"} on the whole track - click: its params in the Inspector`;
            m.addEventListener("click", (e) => { e.stopPropagation(); open(i); });
            box.append(m);
        });
        const name = hd.querySelector(".edit-hname");
        if (name) {
            name.style.cursor = "pointer";
            name.title += " - click: this track's sound effects (Track FX) in the Inspector";
            name.addEventListener("click", (e) => { e.stopPropagation(); open(0); });
            name.after(box);
        } else hd.append(box);
        const sel = this._editTlSel;
        if (sel && sel.kind === "track" && sel.track === row.id) hd.classList.add("sel");
    },
};
