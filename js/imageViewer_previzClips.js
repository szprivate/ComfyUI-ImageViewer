// imageViewer_previzClips.js
// The 3D space's Clip Sequencer panel (dock id "clips"): animation as clips on tracks that blend, loop, retime
// and line up, in the spirit of a DCC's time editor / story tool. The model and its maths are
// imageViewer_clipSeqData.js (pure); the drawing and the pointer/keys that edit it live in
// imageViewer_previzClipsInstance.js, one closure per panel.
//
// The panel comes in instances (Sebastian 2026-11-23): this mixin keeps the FIRST one — the element made in
// imageViewer.js — with its state on the viewer as it always was (st === this, so this._csUI / this._csViewState
// / this._csSel stay where older callers read them), and registers the maker the dock calls for every further
// one ("clips@2", ...). The clips themselves are the scene's (Q.seqOf, per tab, shared); an instance keeps its
// own time zoom, selection and focus. A refresh or a frame move fans out to the first one and every shown extra.
//
// Every edit is one undo step of the 3D scene (previzSnapshot / a drag's previzBeginDrag), then previzChanged -
// so the viewport, the rig, the render and the export all see the clips through scene3d.evaluateIn.

import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import * as Q from "./imageViewer_clipSeqData.js";
import { createClipsInstance } from "./imageViewer_previzClipsInstance.js";

export const PrevizClipsMixin = {

    // ── Shared scene helpers (the clips are the scene's, not an instance's) ──

    _csScene() { return this.isPrevizTab && this.isPrevizTab() ? this.previzScene() : null; },
    _csSeq(make = false) {
        const scene = this._csScene();
        if (!scene) return null;
        if (make) return Q.ensureSeq(scene);
        const q = Q.seqOf(scene);
        return q ? Q.normalizeSeq(q) : null;
    },

    /** Frames covered by the strip: the shot, and anything the clips reach past it. */
    _csSpan(scene, q) {
        const r = q && Q.seqRange(q);
        const hi = Math.max(scene.length || 1, r ? r.hi : 0) + 48;
        return { lo: Math.min(0, r ? Math.floor(r.lo) - 12 : 0), hi };
    },

    /** How far the clip before `c` on its track still plays into it (the automatic cross-fade). */
    _csPrevOverlap(q, c) {
        const at = Q.findClip(q, c.id);
        if (!at) return 0;
        let o = 0;
        for (let j = 0; j < at.index; j++) {
            const p = at.track.clips[j];
            if (!p.mute) o = Math.max(o, Math.min(c.length, Q.clipEnd(p) - c.start));
        }
        return Math.max(0, o);
    },

    /** Push a snapshot taken before an edit (the edit is already done). */
    _csPushUndo(label, json) {
        const state = this._undoState();
        state.past.push({ label, json, selection: this._previzSelection });
        if (state.past.length > 100) state.past.shift();
        state.future.length = 0;
        if (this._previzRefreshUndoButtons) this._previzRefreshUndoButtons();
    },

    /** A clip running past the shot's end makes the shot longer. */
    _csGrowShot(scene, q) {
        const r = Q.seqRange(q);
        if (!r) return;
        const end = Math.ceil(r.hi) + 1;
        if (end > (scene.length || 0)) {
            scene.length = end;
            scene.lengthSet = true;
            if (this.applyTimelineBounds) this.applyTimelineBounds();
            if (this.previzSyncTimelineFields) this.previzSyncTimelineFields();
        }
    },

    /**
     * What "Clip from keys" takes: a whole character when something of a rigged one is selected (all its
     * controls, its root among them so the clip can be placed), else the selected items that have keys.
     */
    _csCaptureTargets() {
        const scene = this._csScene();
        const modelId = this.previzRigModelOf ? this.previzRigModelOf() : null;
        if (modelId && R.isRigged(scene, modelId)) {
            const model = S.itemById(scene, modelId);
            return { ids: R.controlsOf(scene, modelId).map((c) => c.id), model: modelId, name: model ? model.name : "character", keepAll: true };
        }
        const ids = (this.previzSelectedIds ? this.previzSelectedIds() : []).filter((id) => S.keyframeFrames(S.itemById(scene, id)).length);
        const first = ids.length && S.itemById(scene, ids[ids.length - 1]);
        return { ids, model: null, name: first ? first.name : "clip", keepAll: false };
    },

    /** One file animation of a rigged character, as a keys source on its controls (the controls are left as they were). */
    _csBakeFileClip(modelId, e, clip, frames, name) {
        const scene = this._csScene();
        const view = this._modelView();
        const ctrls = R.controlsOf(scene, modelId);
        const saved = ctrls.map((c) => [c, JSON.parse(JSON.stringify(c.tracks || {}))]);
        const fps = scene.fps || 24;
        const inv = view._rigModelInverse(e);
        const { THREE } = view.libs;
        const m = new THREE.Matrix4();
        const action = e.mixer.clipAction(clip);
        e.mixer.stopAllAction();
        action.play();
        const poses = [];
        for (let f = 0; f <= frames; f++) {
            e.mixer.setTime(Math.min(clip.duration, f / fps));
            e.object.updateMatrixWorld(true);
            const pose = new Map();
            for (const nm of e.boneOrder) pose.set(nm, m.multiplyMatrices(inv, e.bones.get(nm).matrixWorld).toArray());
            poses.push({ f, pose });
        }
        e.mixer.stopAllAction();
        if (e.clips[0]) e.mixer.clipAction(e.clips[0]).play();
        // The bake writes keys and a snapshot of its own: put the controls back after taking the keys.
        const undo = this._undoState();
        const depth = undo.past.length;
        for (const c of ctrls) c.tracks = {};
        this.previzRigBakePoses(modelId, poses, { label: "file animation" });
        undo.past.length = depth;
        const src = Q.captureSource(scene, ctrls.map((c) => c.id), 0, frames, { name, model: modelId, made: "file", remove: false, keepAll: true });
        for (const [c, t] of saved) c.tracks = t;
        return src;
    },

    // ── Instances ───────────────────────────────────────────────────────────

    /** The maker the dock calls for every further Clip Sequencer ("clips@2", ...), with a state of its own. */
    _csRegisterMaker() {
        if (this._dockMakers().clips) return;
        this._dockMakers().clips = (v, id, saved) => {
            const d = (v._dockRootEl && v._dockRootEl.ownerDocument) || (v.clipsPanel && v.clipsPanel.ownerDocument);
            const host = d.createElement("div");
            host.className = "curves-panel clips-panel";
            const seed = saved || (v._clipsInst ? v._clipsInst.save() : null);
            return createClipsInstance(v, host, {}, seed);
        };
    },

    /** The first Clip Sequencer, its state on the viewer; made the first time the panel is asked for. */
    _csPrimary() {
        this._csRegisterMaker();
        if (!this._clipsInst && this.clipsPanel) this._clipsInst = createClipsInstance(this, this.clipsPanel, this, null);
        return this._clipsInst;
    },

    _previzHideClips() {
        if (this.isPanelDocked && this.isPanelDocked("clips")) this.setPanelDocked("clips", false);
    },

    /** Draw the panel for the scene on screen (or put it away off a 3D tab), and every shown extra. */
    previzRefreshClips() {
        const inst = this._csPrimary();
        if (inst) {
            if (!this.isPrevizTab || !this.isPrevizTab()) this._previzHideClips();
            else if (this.isPanelDocked && this.isPanelDocked("clips")) inst.refresh();
        }
        for (const { inst: extra } of this._dockInstancesOf("clips")) extra.refresh();
    },

    /** The playhead only (the frame moved), in the first panel and every shown extra. */
    previzClipsFrame() {
        const inst = this._clipsInst;
        if (inst && this.isPanelDocked && this.isPanelDocked("clips")) inst.frame();
        for (const { inst: extra } of this._dockInstancesOf("clips")) extra.frame();
    },

    /** Asked by handleKeyDown first; true when any Clip Sequencer took the key. */
    clipSeqKeyDown(e) {
        if (this._clipsInst && this._clipsInst.keyDown(e)) return true;
        for (const { inst: extra } of this._dockInstancesOf("clips")) if (extra.keyDown(e)) return true;
        return false;
    },

    // ── The first panel, for callers that ask the viewer ────────────────────

    _csEdit(label, fn, opts) { const i = this._csPrimary(); return i && i.edit(label, fn, opts); },
    _csSelect(id) { const i = this._csPrimary(); return i && i.select(id); },
    previzClipsAddTrack(above = null) { const i = this._csPrimary(); return i && i.addTrack(above); },
    previzClipsFromKeys(opts) { const i = this._csPrimary(); return i && i.fromKeys(opts); },
    previzClipsPlace(sourceId, at) { const i = this._csPrimary(); return i && i.place(sourceId, at); },
    previzClipsFileSources(modelId) { const i = this._csPrimary(); return i && i.fileSources(modelId); },
    previzClipsMatch(id) { const i = this._csPrimary(); return i && i.match(id); },
    previzClipsBake() { const i = this._csPrimary(); return i && i.bake(); },
    previzClipsFit() { const i = this._csPrimary(); return i && i.fit(); },
    previzClipsSplit(id) { const i = this._csPrimary(); return i && i.split(id); },
    _csBakeOne(id) { const i = this._csPrimary(); return i && i.bakeOne(id); },
    previzClipsLandTake(modelId, from, to, saved, name) { const i = this._csPrimary(); return i && i.landTake(modelId, from, to, saved, name); },
};