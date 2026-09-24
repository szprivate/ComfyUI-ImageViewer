// bEpicViewer_paramAnim.js
// Keyframes on node parameters, from the Parameters panel.
//
// Nodes that declare an "animation" input (the bEpic image nodes — see
// bEpicViewer_paramAnimData.js for the format) get a key toggle beside each
// keyable parameter. The rules are Nuke's, because those are Nuke's nodes:
//
//   - the toggle keys the parameter at the viewer's frame, or takes the key
//     there off again; Alt-click drops the parameter's whole animation;
//   - once a parameter is animated, typing a value keys it at this frame —
//     there is no un-keyed edit of an animated value, so no Autokey either;
//   - the rows show the value at the frame, tinted blue when animated and a
//     deeper blue on a frame that has a key.
//
// The transport's key bar (built by the previz mixin) works on the node too,
// whenever neither a previz scene nor the roto tool has it: Set Key keys every
// animated parameter here, Delete Key takes this frame's keys off, and the
// ease menu re-eases them (and is how new keys leave their frame). The keys'
// frames tick the timeline, and the Parameter Curves panel
// (bEpicViewer_paramCurves.js) draws the curves.
import { app } from "../../scripts/app.js";
import * as A from "./bEpicViewer_paramAnimData.js";

export const ParamAnimMixin = {

    /** The node the Parameters panel shows, when it can be animated. */
    paramAnimNode() {
        if (this._paramsToolMode || this.currentParamNodeId == null) return null;
        const node = app.graph?.getNodeById?.(this.currentParamNodeId);
        return node && A.animatableNames(node) ? node : null;
    },

    _paramAnimFrame() {
        return Math.round(this.currentFrame || 0);
    },

    /** A parameter's value at the frame: its curve, or its widget. */
    paramAnimValue(node, name, tracks = A.readTracks(node)) {
        const w = (node.widgets || []).find((x) => x.name === name);
        let v = A.valueAt(tracks[name], this._paramAnimFrame(), w ? w.value : undefined);
        if (typeof v === "number" && A.isIntParam(node, name)) v = Math.round(v);
        return v;
    },

    /**
     * Where the panel's edits land (ParamsMixin.applyToSelectedNodes asks this
     * first). An animated parameter takes the value as a key at the frame;
     * returns false for anything that should go to the widget as before.
     */
    paramAnimApply(node, name, value) {
        if (!A.animatableNames(node)?.includes(name)) return false;
        const tracks = A.readTracks(node);
        if (!tracks[name]) return false;
        tracks[name] = A.setKey(tracks[name], this._paramAnimFrame(), value, this._paramEase);
        this.paramAnimWrite(node, tracks);
        this.paramAnimChanged({ rows: false });
        return true;
    },

    /** Key a parameter here, or take its key here off. */
    paramAnimToggleKey(node, name) {
        const tracks = A.readTracks(node);
        const f = this._paramAnimFrame();
        const keys = tracks[name] || [];
        if (keys.some((k) => k.f === f)) tracks[name] = A.removeKey(keys, f);
        else tracks[name] = A.setKey(keys, f, this.paramAnimValue(node, name, tracks), this._paramEase);
        this.paramAnimWrite(node, tracks);
        this.paramAnimChanged();
    },

    /**
     * Drop a parameter's animation. Its widget takes the value it had at this
     * frame, so the picture doesn't jump.
     */
    paramAnimClear(node, name) {
        const tracks = A.readTracks(node);
        if (!tracks[name]) return;
        delete tracks[name];
        this.paramAnimWrite(node, tracks);
        this.paramAnimChanged();
    },

    /** The key bar's Set Key: every animated parameter, keyed here. */
    paramAnimKeyAll() {
        const node = this.paramAnimNode();
        if (!node) return;
        const tracks = A.readTracks(node);
        const f = this._paramAnimFrame();
        for (const name of Object.keys(tracks)) {
            tracks[name] = A.setKey(tracks[name], f, this.paramAnimValue(node, name, tracks), this._paramEase);
        }
        this.paramAnimWrite(node, tracks);
        this.paramAnimChanged();
    },

    /** The key bar's Delete Key: this frame's keys, on every parameter. */
    paramAnimDeleteKeys(frame = this._paramAnimFrame()) {
        const node = this.paramAnimNode();
        if (!node) return;
        const tracks = A.readTracks(node);
        for (const name of Object.keys(tracks)) tracks[name] = A.removeKey(tracks[name], frame);
        this.paramAnimWrite(node, tracks);
        this.paramAnimChanged();
    },

    /** The ease menu: re-ease this frame's keys, and ease the ones to come. */
    paramAnimSetEase(ease) {
        this._paramEase = ease;
        const node = this.paramAnimNode();
        if (!node) return;
        const tracks = A.readTracks(node);
        const f = this._paramAnimFrame();
        for (const keys of Object.values(tracks)) for (const k of keys) if (k.f === f) k.ease = ease;
        this.paramAnimWrite(node, tracks);
        this.paramAnimChanged();
    },

    /**
     * Write a node's tracks back. A parameter whose last key just went leaves
     * its widget at the value it had at this frame — Nuke's rule, so taking
     * the animation off never makes the picture jump.
     */
    paramAnimWrite(node, tracks) {
        const before = A.readTracks(node);
        for (const name of Object.keys(before)) {
            if (tracks[name] && tracks[name].length) continue;
            const w = (node.widgets || []).find((x) => x.name === name);
            const v = this.paramAnimValue(node, name, before);
            if (w && v !== undefined && w.value !== v) { w.value = v; w.callback?.(v); }
        }
        A.writeTracks(node, tracks);
    },

    /** Everything that shows the keys, brought up to date. */
    paramAnimChanged({ rows = true } = {}) {
        if (rows) this.paramAnimDecorate();
        this.paramAnimRenderTicks();
        this.paramRefreshCurves?.();
        app.graph?.setDirtyCanvas?.(true, true);
    },

    /** The frame moved: new values in the rows, the playhead on the curves. */
    paramAnimFrameChanged() {
        if (!this.paramAnimNode()) return;
        this.paramAnimDecorate();
        this.paramAnimRenderTicks();
        this.paramRefreshCurves?.();
    },

    // ── The rows ─────────────────────────────────────────────────────────────

    /**
     * Give the panel's rows their key toggles, tints and values at the frame.
     * Runs after every rebuild (ParamsMixin.updateParamsPanel) and on every
     * frame change; the toggles are made once per row and then only updated.
     */
    paramAnimDecorate() {
        const content = this.paramsContent;
        if (!content) return;
        const node = this.paramAnimNode();
        const names = node ? new Set(A.animatableNames(node)) : null;
        this._paramAnimSyncCurvesButton(!!node);
        if (!node) return;
        const tracks = A.readTracks(node);
        const f = this._paramAnimFrame();
        const doc = content.ownerDocument;
        const focused = doc.activeElement;

        for (const row of content.querySelectorAll(".param-row")) {
            const name = row.dataset.paramName;
            if (!names.has(name)) continue;
            const keys = tracks[name];
            const onKey = !!keys && keys.some((k) => k.f === f);
            row.classList.toggle("anim-animated", !!keys);
            row.classList.toggle("anim-key", onKey);

            const label = row.querySelector(".param-label");
            let btn = label && label.querySelector(".param-key");
            if (label && !btn) {
                btn = doc.createElement("span");
                btn.className = "param-key";
                btn.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const n = app.graph?.getNodeById?.(this.currentParamNodeId);
                    if (!n) return;
                    if (e.altKey) this.paramAnimClear(n, name);
                    else this.paramAnimToggleKey(n, name);
                };
                label.prepend(btn);
            }
            if (btn) {
                btn.textContent = onKey ? "◆" : "◇";      // ◆ on a key, ◇ elsewhere
                btn.title = onKey ? `Remove the key at frame ${f}`
                                  : `Set a key at frame ${f}`;
                if (keys) btn.title += " · Alt-click drops the whole animation";
            }

            // The value at this frame — except in a field being typed into.
            const input = row.querySelector("input.param-input, input[type=number]");
            if (input && input !== focused) {
                const v = this.paramAnimValue(node, name, tracks);
                if (typeof v === "number") {
                    const shown = A.isIntParam(node, name) ? String(v) : String(Math.round(v * 1e4) / 1e4);
                    if (input.value !== shown) input.value = shown;
                }
            }
        }
    },

    /** The Parameters header's curves button, shown for animatable nodes. */
    _paramAnimSyncCurvesButton(show) {
        const header = this.paramsPanel && this.paramsPanel.querySelector(".params-header");
        if (!header) return;
        let b = header.querySelector("#params-curves-btn");
        if (!b && show) {
            b = header.ownerDocument.createElement("button");
            b.id = "params-curves-btn";
            b.className = "params-curves-btn";
            b.textContent = "∿";                               // ∿
            b.title = "Parameter Curves: this node's animation as graphs";
            b.onclick = (e) => { e.stopPropagation(); this.paramToggleCurves?.(); };
            header.insertBefore(b, this.paramsLockBtn || null);
        }
        if (b) {
            b.style.display = show ? "" : "none";
            b.classList.toggle("active", !!(this.isPanelDocked && this.isPanelDocked("paramCurves")));
        }
    },

    // ── The timeline ─────────────────────────────────────────────────────────

    /** Key ticks for the node, on the strip previz and roto use too. */
    paramAnimRenderTicks() {
        const host = this.container && this.container.querySelector("#kf-ticks");
        if (!host) return;
        const mine = this._keyBarContext && this._keyBarContext() === "params";
        if (!mine) {
            if (host.dataset.owner === "params") { host.innerHTML = ""; delete host.dataset.owner; }
            return;
        }
        host.dataset.owner = "params";
        host.innerHTML = "";
        const node = this.paramAnimNode();
        const frames = A.keyFrames(A.readTracks(node));
        const bounds = this.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);
        const cur = this._paramAnimFrame();
        const doc = host.ownerDocument;
        for (const f of frames) {
            if (f < bounds.min || f > bounds.max) continue;
            const tick = doc.createElement("div");
            tick.className = "kf-tick" + (f === cur ? " cur" : "");
            tick.style.left = `${((f - bounds.min) / span) * 100}%`;
            tick.title = `Keyframe ${f} — click to go there, double-click to delete`;
            tick.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); this.setFrame(f); };
            tick.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); this.paramAnimDeleteKeys(f); };
            host.appendChild(tick);
        }
    },
};
