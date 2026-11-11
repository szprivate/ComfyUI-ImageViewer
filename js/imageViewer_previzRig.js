// imageViewer_previzRig.js
// The Rig menu of the 3D space: put animation controls on a character, take
// them off, switch a limb between IK and FK without it jumping, key or reset
// the whole rig, and turn a pose sequence — a clip in the file, a motion from
// the AI, a retargeted take — into keys on the controls.
//
// The data and maths are imageViewer_rigData.js; the viewport half (drawing
// controls, posing bones) is imageViewer_rig3d.js. Everything here goes
// through the scene like any other edit: one undo step, the node widget
// written, the outliner and curves refreshed.
import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import { notice } from "./imageViewer_exportUI.js";

export const PrevizRigMixin = {

    /** The character an item belongs to: a model, its rig group or one of its controls. */
    previzRigModelOf(id = this._previzSelection) {
        const scene = this.previzScene();
        for (let it = id ? S.itemById(scene, id) : null; it; it = it.parent ? S.itemById(scene, it.parent) : null) {
            if (it.kind === "model") return it.id;
            if (it.kind === "control" && it.control) return it.control.model;
            if (it.kind === "group" && it.rig) return it.rig.model;
        }
        return null;
    },

    /** Whether the model item has bones a rig can drive (it must be loaded). */
    previzHasSkeleton(modelId) {
        const view = this._modelView();
        const e = view && view._entries && view._entries.get(modelId);
        return !!(e && e.bones && e.bones.size);
    },

    /**
     * Put controls on a character. A humanoid (found by its bone names, or by
     * its shape when the names say nothing) gets a root, a COG, FK on every
     * bone and IK with poles on both arms and legs; anything else — a dog, a
     * dragon, a crane — gets FK on every bone under a root.
     */
    async previzRigCharacter(modelId = this.previzRigModelOf(), { humanoid = true } = {}) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        if (!model || model.kind !== "model") { notice("warn", "Select a character (a skinned model) to rig."); return null; }
        const view = this._modelView();
        const skel = view.rigSkeleton && view.rigSkeleton(modelId);
        if (!skel || !skel.bones.length) {
            notice("info", `${model.name} has no skeleton. Auto-rig it first (Rig → Auto-rig…).`);
            return null;
        }
        this.previzSnapshot(`rig ${model.name}`);
        this._previzRigDrop(modelId);
        const rig = R.buildRig(model, skel, { humanoid });
        rig.group.name = S.uniqueName(scene, rig.group.name);
        scene.items.push(rig.group);
        for (const it of rig.items) {
            it.name = S.uniqueName(scene, it.name);
            scene.items.push(it);
        }
        // Forty-odd controls would bury the outliner: the rig starts folded.
        (this._previzCollapsed || (this._previzCollapsed = new Set())).add(rig.group.id);
        const pick = rig.items.find((c) => c.control.type === "cog") || rig.items[0];
        this._previzSelection = pick ? pick.id : modelId;
        if (this._previzAlso) this._previzAlso.clear();
        await this.previzChanged({ reload: true });
        const what = rig.humanoid ? "humanoid: IK arms and legs, FK on every bone"
                                  : `FK on every bone${humanoid ? " (no humanoid limbs found)" : ""}`;
        notice("info", `Rigged ${model.name} — ${what}.`);
        return rig;
    },

    /** Take a character's rig off; its bones go back to the file's own pose. */
    previzRemoveRig(modelId = this.previzRigModelOf()) {
        const scene = this.previzScene();
        if (!modelId || !R.isRigged(scene, modelId) && !R.rigGroupOf(scene, modelId)) return;
        this.previzSnapshot("remove rig");
        this._previzRigDrop(modelId);
        this._previzSelection = modelId;
        this.previzChanged({ reload: true });
    },

    _previzRigDrop(modelId) {
        const scene = this.previzScene();
        const group = R.rigGroupOf(scene, modelId);
        const gone = new Set(R.controlsOf(scene, modelId).map((c) => c.id));
        if (group) {
            gone.add(group.id);
            for (const d of S.descendantsOf(scene, group.id)) gone.add(d.id);
        }
        scene.items = scene.items.filter((it) => !gone.has(it.id));
        // The bones the controls were posing go back to the file's rest pose.
        const view = this._modelView();
        const e = view && view._entries && view._entries.get(modelId);
        if (e && e.bones) {
            for (const [name, bone] of e.bones) {
                const r = e.boneRest.get(name);
                bone.position.fromArray(r.p); bone.quaternion.fromArray(r.q); bone.scale.fromArray(r.s);
            }
            e.rigPose = null;
        }
    },

    /** Select every control of the character. */
    previzRigSelectControls(modelId = this.previzRigModelOf(), filter = null) {
        const all = R.controlsOf(this.previzScene(), modelId).filter((c) => !filter || filter(c));
        if (!all.length) return;
        this.previzSelect(all[0].id);
        for (const c of all.slice(1)) this.previzSelect(c.id, { add: true });
    },

    /** Key every control of the character at the playhead. */
    previzRigKeyAll(modelId = this.previzRigModelOf()) {
        const ctrls = R.controlsOf(this.previzScene(), modelId);
        if (!ctrls.length) return;
        this.previzSnapshot("key rig");
        const frame = Math.round(this.currentFrame || 0);
        for (const c of ctrls) {
            for (const p of c.control.type === "ik" ? ["position", "rotation", "ikfk"] : ["position", "rotation"]) {
                S.setKeyframe(c, p, frame, S.valueAt(c, p, frame), this._previzEase || "smooth");
            }
        }
        this.previzChanged();
    },

    /** Every control back to its rest pose at the playhead (keyed where it animates). */
    previzRigToRest(modelId = this.previzRigModelOf(), { only = null } = {}) {
        const ctrls = R.controlsOf(this.previzScene(), modelId).filter((c) => !only || only.includes(c.id));
        if (!ctrls.length) return;
        this.previzSnapshot("rest pose");
        const frame = Math.round(this.currentFrame || 0);
        for (const c of ctrls) {
            this._previzRigWrite(c, "position", [0, 0, 0], frame);
            this._previzRigWrite(c, "rotation", [0, 0, 0], frame);
        }
        this.previzChanged();
    },

    _previzRigWrite(item, prop, value, frame, { key = false } = {}) {
        if (key || this._previzAutokey || S.isAnimated(item, prop)) {
            S.setKeyframe(item, prop, frame, value, this._previzEase || "smooth");
        } else item[prop] = Array.isArray(value) ? value.slice() : value;
    },

    /** The model-space world matrix of an item's parent (a control's parent: another control or the rig group). */
    _previzRigParentWorld(scene, item, worlds, frame) {
        if (item.parent && worlds.has(item.parent)) return worlds.get(item.parent);
        // The rig group (or anything else between the model and the control).
        let m = R.mat4.identity();
        const chain = [];
        for (let p = item.parent ? S.itemById(scene, item.parent) : null; p && p.kind !== "model"; p = p.parent ? S.itemById(scene, p.parent) : null) {
            chain.unshift(p);
        }
        for (const p of chain) {
            const at = S.evaluate(p, frame);
            const local = p.kind === "control" ? R.controlLocal(p, at)
                : R.mat4.mul(R.mat4.mul(R.mat4.compose(R.v3.add(at.position, at.pivot), R.quat.fromEulerDeg(at.rotation), at.scale),
                                        R.mat4.compose(R.v3.scale(at.pivot, -1), [0, 0, 0, 1], [1, 1, 1])),
                             S.offsetOf(p) || R.mat4.identity());
            m = R.mat4.mul(m, local);
        }
        return m;
    },

    /**
     * Control channels that put the character in `pose` (Map bone -> model
     * space 4x4). FK controls follow their bones; IK controls and poles are
     * placed where the limbs are, so either mode shows the same pose; the
     * root and COG keep their channels unless `moveCog`. Answers Map id -> {position, rotation}.
     */
    _previzRigChannelsFor(modelId, pose, frame, { near = null, moveCog = false } = {}) {
        const scene = this.previzScene();
        const ctrls = R.controlsOf(scene, modelId);
        const worlds = new Map();
        const out = new Map();
        const rigGroup = R.rigGroupOf(scene, modelId);
        const roles = (rigGroup && rigGroup.rig && rigGroup.rig.roles) || {};
        for (const c of ctrls) {
            const parentW = this._previzRigParentWorld(scene, c, worlds, frame);
            const at = S.evaluate(c, frame);
            let want = null;
            const t = c.control.type;
            if (t === "fk" && pose.has(c.control.bone) && c.control.bind) {
                want = R.mat4.mul(pose.get(c.control.bone), R.mat4.invert(c.control.bind));
            } else if (t === "ik" && c.control.chain && pose.has(c.control.chain[2])) {
                want = R.mat4.mul(pose.get(c.control.chain[2]), R.mat4.invert(c.control.bind || R.mat4.identity()));
            } else if (t === "pole") {
                const ik = c.control.ik && S.itemById(scene, c.control.ik);
                const chain = ik && ik.control.chain;
                if (chain && chain.every((n) => pose.has(n))) {
                    const [a, b, e] = chain.map((n) => { const m = pose.get(n); return [m[12], m[13], m[14]]; });
                    const axis = R.v3.norm(R.v3.sub(e, a));
                    let off = R.v3.sub(b, R.v3.add(a, R.v3.scale(axis, R.v3.dot(R.v3.sub(b, a), axis))));
                    const len = R.v3.dist(a, b) + R.v3.dist(b, e);
                    if (R.v3.len(off) < 1e-4 * len) {
                        // Straight: keep the pole on the side it is on now.
                        const now = R.mat4.mul(parentW, R.controlLocal(c, at));
                        off = R.v3.sub([now[12], now[13], now[14]], b);
                        off = R.v3.sub(off, R.v3.scale(axis, R.v3.dot(off, axis)));
                    }
                    const p = R.v3.add(b, R.v3.scale(R.v3.norm(off), len * 0.6));
                    want = R.mat4.compose(p, [0, 0, 0, 1], [1, 1, 1]);
                }
            } else if (t === "cog" && moveCog && roles.hips && pose.has(roles.hips)) {
                const h = pose.get(roles.hips);
                want = R.mat4.compose([h[12], h[13], h[14]], [0, 0, 0, 1], [1, 1, 1]);
            }
            let local;
            if (want) {
                local = R.mat4.mul(R.mat4.invert(parentW), want);
                const ch = R.channelsForLocal(c, local, (near && near.get(c.id)) || at.rotation);
                out.set(c.id, ch);
                worlds.set(c.id, want);
            } else {
                local = R.controlLocal(c, at);
                worlds.set(c.id, R.mat4.mul(parentW, local));
            }
        }
        return out;
    },

    /**
     * Switch a limb (an IK control, its pole or one of its FK controls)
     * between IK and FK at the playhead WITHOUT a jump: the side being
     * switched to is first put exactly where the limb is.
     */
    previzRigSwitchIkFk(id = this._previzSelection, to = null) {
        const scene = this.previzScene();
        const ik = this._previzRigIkFor(id);
        if (!ik) { notice("info", "Select a limb's IK control, pole or FK control to switch it."); return; }
        const modelId = ik.control.model;
        const frame = Math.round(this.currentFrame || 0);
        const now = S.valueAt(ik, "ikfk", frame);
        const target = to === "ik" ? 1 : to === "fk" ? 0 : (now >= 0.5 ? 0 : 1);
        const pose = this._modelView().rigPose(modelId);
        if (!pose) return;
        this.previzSnapshot(target ? "switch to IK" : "switch to FK");
        const chans = this._previzRigChannelsFor(modelId, pose, frame);
        const pole = ik.control.pole && S.itemById(scene, ik.control.pole);
        const fkIds = new Set(R.controlsOf(scene, modelId)
            .filter((c) => c.control.type === "fk" && ik.control.chain.includes(c.control.bone)).map((c) => c.id));
        const touch = target ? [ik.id, pole && pole.id].filter(Boolean) : [...fkIds];
        for (const cid of touch) {
            const c = S.itemById(scene, cid);
            const ch = chans.get(cid);
            if (!c || !ch) continue;
            const key = S.isAnimated(c, "position") || S.isAnimated(c, "rotation") || S.isAnimated(ik, "ikfk");
            this._previzRigWrite(c, "position", ch.position, frame, { key });
            this._previzRigWrite(c, "rotation", ch.rotation, frame, { key });
        }
        // The blend: keyed with a hold when the limb is animated, so the
        // switch happens on this frame and not over the frames before it.
        if (S.isAnimated(ik, "ikfk") || this._previzAutokey || S.keyframeFrames(ik).length) {
            S.setKeyframe(ik, "ikfk", frame, target, "hold");
            const keys = S.track(ik, "ikfk");
            const prev = keys.filter((k) => k.f < frame).pop();
            if (prev) prev.ease = "hold";
            else if (frame > 0) S.setKeyframe(ik, "ikfk", Math.max(0, frame - 1), 1 - target, "hold");
        } else ik.ikfk = target;
        this.previzChanged();
    },

    _previzRigIkFor(id) {
        const scene = this.previzScene();
        const it = id && S.itemById(scene, id);
        if (!it || it.kind !== "control") return null;
        if (it.control.type === "ik") return it;
        if (it.control.type === "pole") return S.itemById(scene, it.control.ik);
        if (it.control.type === "fk") {
            return R.controlsOf(scene, it.control.model)
                .find((c) => c.control.type === "ik" && c.control.chain && c.control.chain.includes(it.control.bone)) || null;
        }
        return null;
    },

    /** Mirror the selected controls' pose onto the other side (L <-> R). */
    previzRigMirrorPose(ids = this.previzSelectedIds()) {
        const scene = this.previzScene();
        const ctrls = ids.map((id) => S.itemById(scene, id)).filter((c) => c && c.kind === "control");
        if (!ctrls.length) return;
        const modelId = ctrls[0].control.model;
        const all = R.controlsOf(scene, modelId);
        const twin = (c) => {
            const flip = (s) => String(s || "").replace(/(Left|Right|\.L|\.R|_l\b|_r\b|_L\b|_R\b|L_|R_)/g,
                (m) => ({ Left: "Right", Right: "Left", ".L": ".R", ".R": ".L", _l: "_r", _r: "_l", _L: "_R", _R: "_L", L_: "R_", R_: "L_" }[m] || m));
            if (c.control.type === "fk") return all.find((o) => o.control.type === "fk" && o.control.bone === flip(c.control.bone));
            return all.find((o) => o.control.type === c.control.type && o.control.role === flip(c.control.role));
        };
        this.previzSnapshot("mirror pose");
        const frame = Math.round(this.currentFrame || 0);
        for (const c of ctrls) {
            const o = twin(c);
            if (!o || o === c) continue;
            // Controls are built mirror-wise from mirrored bones: across the
            // character's X, a rotation (x, y, z) mirrors to (x, -y, -z) and a
            // move (x, y, z) to (-x, y, z) for world-aligned controls. Bone-
            // aligned FK controls mirror their rotation as it is.
            const p = S.valueAt(c, "position", frame), r = S.valueAt(c, "rotation", frame);
            const world = c.control.type !== "fk";
            this._previzRigWrite(o, "position", world ? [-p[0], p[1], p[2]] : p.slice(), frame);
            this._previzRigWrite(o, "rotation", world ? [r[0], -r[1], -r[2]] : r.slice(), frame);
        }
        this.previzChanged();
    },

    /**
     * Turn a pose per frame into keys on the controls.
     * `frames`: [{ f, pose: Map bone -> model-space 4x4 }]. The limbs are
     * keyed in FK and the IK controls follow along, keyed too, so the blend
     * can be switched afterwards without a jump. The keys are thinned to the
     * ones that matter (`tolerance` in degrees / scene units).
     */
    previzRigBakePoses(modelId, frames, { label = "bake", tolerance = 0.05, ikfk = 0, moveCog = false } = {}) {
        const scene = this.previzScene();
        const ctrls = R.controlsOf(scene, modelId);
        if (!ctrls.length || !frames.length) return 0;
        this.previzSnapshot(label);
        const lo = frames[0].f, hi = frames[frames.length - 1].f;
        // Clear what was there over the range, so the bake is all that is left on it.
        for (const c of ctrls) {
            for (const p of ["position", "rotation", "ikfk"]) {
                const keys = S.track(c, p);
                if (keys.length) c.tracks[p] = keys.filter((k) => k.f < lo || k.f > hi);
                if (c.tracks[p] && !c.tracks[p].length) delete c.tracks[p];
            }
        }
        const samples = new Map(ctrls.map((c) => [c.id, { position: [], rotation: [] }]));
        let near = null;
        for (const fr of frames) {
            const chans = this._previzRigChannelsFor(modelId, fr.pose, fr.f, { near, moveCog });
            near = new Map();
            for (const [id, ch] of chans) {
                samples.get(id).position.push({ f: fr.f, v: ch.position });
                samples.get(id).rotation.push({ f: fr.f, v: ch.rotation });
                near.set(id, ch.rotation);
            }
        }
        const height = this._previzRigHeight(modelId);
        let keys = 0;
        for (const c of ctrls) {
            const s = samples.get(c.id);
            for (const prop of ["position", "rotation"]) {
                if (!s[prop].length) continue;
                const tol = prop === "rotation" ? tolerance : tolerance * 0.002 * height;
                // A bone that only turns: its position stays at rest, no keys for it.
                if (prop === "position" && c.control.type === "fk"
                    && s[prop].every((k) => Math.abs(k.v[0]) + Math.abs(k.v[1]) + Math.abs(k.v[2]) < 1e-4 * height)) continue;
                for (const k of R.reduceKeys(s[prop], tol)) {
                    S.setKeyframe(c, prop, k.f, k.v, "linear");
                    keys++;
                }
            }
            if (c.control.type === "ik") {
                S.setKeyframe(c, "ikfk", lo, ikfk, "hold");
                if (hi > lo) S.setKeyframe(c, "ikfk", hi, ikfk, "hold");
            }
        }
        this.previzChanged();
        return keys;
    },

    _previzRigHeight(modelId) {
        const skel = this._previzRigSkeletonCache(modelId);
        if (!skel) return 1;
        let lo = Infinity, hi = -Infinity;
        for (const b of skel.bones) { lo = Math.min(lo, b.world[13]); hi = Math.max(hi, b.world[13]); }
        return Math.max(1e-3, hi - lo);
    },

    _previzRigSkeletonCache(modelId) {
        if (!this._rigSkelCache) this._rigSkelCache = new Map();
        if (!this._rigSkelCache.has(modelId)) {
            const s = this._modelView().rigSkeleton && this._modelView().rigSkeleton(modelId);
            if (!s) return null;
            this._rigSkelCache.set(modelId, s);
        }
        return this._rigSkelCache.get(modelId);
    },

    /**
     * The model's own clip (the animation in its file), baked onto its
     * controls over the shot, so it can be edited key by key.
     */
    previzRigBakeClip(modelId = this.previzRigModelOf()) {
        const scene = this.previzScene();
        const view = this._modelView();
        const e = view._entries.get(modelId);
        if (!e || !e.mixer || !e.clips || !e.clips.length) { notice("info", "This character has no animation of its own to bake."); return 0; }
        if (!R.isRigged(scene, modelId)) { notice("info", "Rig the character first (Rig → Add controls)."); return 0; }
        const fps = scene.fps || 24;
        const frames = [];
        const last = Math.min(scene.length - 1, Math.ceil(e.clips[0].duration * fps));
        const inv = view._rigModelInverse(e);
        const { THREE } = view.libs;
        const m = new THREE.Matrix4();
        for (let f = 0; f <= last; f++) {
            e.mixer.setTime(f / fps);
            e.object.updateMatrixWorld(true);
            const pose = new Map();
            for (const name of e.boneOrder) pose.set(name, m.multiplyMatrices(inv, e.bones.get(name).matrixWorld).toArray());
            frames.push({ f, pose });
        }
        const n = this.previzRigBakePoses(modelId, frames, { label: "bake clip" });
        notice("info", `Baked ${frames.length} frames of the clip onto the controls (${n} keys).`);
        return n;
    },

    /** The Rig menu, under the 3D panel's Rig button. */
    _previzToggleRigMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const scene = this.previzScene();
        const modelId = this.previzRigModelOf();
        const model = modelId && S.itemById(scene, modelId);
        const rigged = !!(modelId && R.isRigged(scene, modelId));
        const bones = !!(modelId && this.previzHasSkeleton(modelId));
        const sel = S.itemById(scene, this._previzSelection);
        const ik = sel && this._previzRigIkFor(sel.id);
        const entries = [
            { label: model ? `Add controls to ${model.name}` : "Add controls", disabled: !bones,
              run: () => this.previzRigCharacter(modelId) },
            { label: "Add FK controls only", disabled: !bones, run: () => this.previzRigCharacter(modelId, { humanoid: false }) },
            { label: "Auto-rig…", disabled: !model || bones,
              run: () => this.previzAutoRigDialog && this.previzAutoRigDialog(modelId) },
            { label: "Remove rig", disabled: !rigged, run: () => this.previzRemoveRig(modelId) },
            "-",
            { label: "Select all controls", disabled: !rigged, run: () => this.previzRigSelectControls(modelId) },
            { label: "Key all controls", disabled: !rigged, run: () => this.previzRigKeyAll(modelId) },
            { label: "Rest pose", disabled: !rigged, run: () => this.previzRigToRest(modelId) },
            { label: "Mirror pose", disabled: !rigged || !sel || sel.kind !== "control", run: () => this.previzRigMirrorPose() },
            { label: ik ? (S.valueAt(ik, "ikfk", Math.round(this.currentFrame || 0)) >= 0.5 ? "Switch limb to FK" : "Switch limb to IK") : "Switch limb IK / FK",
              disabled: !ik, run: () => this.previzRigSwitchIkFk(sel.id) },
            { label: "Bake file's animation to controls", disabled: !rigged, run: () => this.previzRigBakeClip(modelId) },
            "-",
            { label: "AI in-between…", disabled: !rigged, run: () => this.previzMotionDialog && this.previzMotionDialog(modelId, "inbetween") },
            { label: "Generate motion from text…", disabled: !rigged, run: () => this.previzMotionDialog && this.previzMotionDialog(modelId, "text") },
            { label: "Clean up feet", disabled: !rigged, run: () => this.previzRigCleanFeet && this.previzRigCleanFeet(modelId) },
            "-",
            { label: "Export FBX…", disabled: !bones, run: () => this.previzExportCharacter && this.previzExportCharacter(modelId, "fbx") },
            { label: "Export Alembic…", disabled: !model, run: () => this.previzExportCharacter && this.previzExportCharacter(modelId, "abc") },
        ];
        const a = anchor.getBoundingClientRect();
        this._previzOpenMenu(entries, a.left, a.bottom + 2, anchor);
    },
};
