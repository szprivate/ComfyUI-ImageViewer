// imageViewer_rig3d.js
// The viewport half of character rigs (the data is imageViewer_rigData.js).
//
// Mixed into Model3DView. Three jobs:
//   - a CONTROL item is drawn as a line shape (circle, box, foot, diamond...)
//     drawn over the character so it can always be clicked, hung under a node
//     carrying its rest matrix so its own channels read zero at rest;
//   - a skinned model's bones are read once, at load, as they are in the
//     file: that is the rest pose every control is measured against;
//   - every frame, once the items are placed, the bones are POSED from the
//     controls: FK controls turn their bones, IK controls solve their limbs
//     (two-bone, with a pole), and IK/FK blends the two.
// Rendering a shot hides the controls, as it hides every other helper.
import { mat4, quat, v3, solveTwoBone, controlsOf } from "./imageViewer_rigData.js";

const CTRL_ORDER = 999;

export const Rig3DMixin = {

    // ── Controls as objects ───────────────────────────────────────────────

    /** A control: its rest node above the root, and a line shape in its body. */
    _rigBuildControl(entry, item) {
        const { THREE } = this.libs;
        entry.key = JSON.stringify(item.control && item.control.shape);
        const shape = this._rigShape(item.control && item.control.shape);
        shape.userData.imageViewerItemId = item.id;
        shape.renderOrder = CTRL_ORDER;
        shape.traverse((o) => { o.userData.imageViewerItemId = item.id; o.renderOrder = CTRL_ORDER; });
        this._bodyOf(entry).add(shape);
        entry.object = shape;
        entry.isControl = true;
        entry.stats = { meshes: 0, vertices: 0, triangles: 0 };
        void THREE;
        return entry;
    },

    _rigShape(spec = {}) {
        const { THREE } = this.libs;
        const size = spec.size || 0.1;
        const pts = [];          // pairs of points: line segments
        const seg = (a, b) => { pts.push(a, b); };
        const ring = (r, axis = [0, 1, 0], n = 32, y = 0) => {
            const q = quat.between([0, 1, 0], axis);
            let prev = null;
            for (let i = 0; i <= n; i++) {
                const t = (i / n) * Math.PI * 2;
                const p = quat.rotate(q, [Math.cos(t) * r, y, Math.sin(t) * r]);
                if (prev) seg(prev, p);
                prev = p;
            }
        };
        const type = spec.type || "circle";
        if (type === "circle") ring(size, spec.axis || [0, 1, 0]);
        else if (type === "square") {
            const q = quat.between([0, 1, 0], spec.axis || [0, 1, 0]);
            const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => quat.rotate(q, [x * size, 0, z * size]));
            for (let i = 0; i < 4; i++) seg(c[i], c[(i + 1) % 4]);
        } else if (type === "root") {
            ring(size, [0, 1, 0], 48);
            // An arrow pointing the way the character faces (+Z).
            seg([0, 0, size], [0, 0, size * 1.35]);
            seg([0, 0, size * 1.35], [size * 0.12, 0, size * 1.2]);
            seg([0, 0, size * 1.35], [-size * 0.12, 0, size * 1.2]);
        } else if (type === "cube") {
            const s = size;
            const c = [];
            for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) c.push([x, y, z]);
            const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
            for (const [a, b] of edges) seg(c[a], c[b]);
        } else if (type === "foot") {
            // A slipper on the floor under the ankle, longer in front.
            const w = size * 0.6, back = -size * 0.7, front = size * 1.9, y = -size * 0.95;
            const c = [[-w, y, back], [w, y, back], [w, y, front], [-w, y, front]];
            for (let i = 0; i < 4; i++) seg(c[i], c[(i + 1) % 4]);
            seg([0, y, back], [0, 0, 0]);
            ring(size * 0.35, [0, 1, 0], 16);
        } else if (type === "diamond") {
            const s = size;
            const p = [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s]];
            for (const a of [0, 1]) for (const b of [2, 3, 4, 5]) seg(p[a], p[b]);
            for (const a of [2, 3]) for (const b of [4, 5]) seg(p[a], p[b]);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
        const mat = new THREE.LineBasicMaterial({
            color: spec.color || "#ffd24d", depthTest: false, depthWrite: false, transparent: true, opacity: 0.95,
        });
        const lines = new THREE.LineSegments(geo, mat);
        lines.name = "control";
        lines.userData.baseColor = spec.color || "#ffd24d";
        lines.frustumCulled = false;
        return lines;
    },

    /** The selected controls light up white; the rest wear their side's colour. */
    _rigSyncHighlight() {
        const sel = new Set([this.selected, ...(this._alsoIds || [])]);
        for (const [id, e] of this._entries) {
            if (!e.isControl || !e.object || !e.object.material) continue;
            e.object.material.color.set(sel.has(id) ? "#ffffff" : e.object.userData.baseColor);
        }
    },

    /** Whether the scene has controls for this model item. */
    _rigged(modelId) {
        return !!(this.scene3d && (this.scene3d.items || []).some(
            (it) => it.kind === "control" && it.control && it.control.model === modelId));
    },

    // ── The skeleton as the file has it ───────────────────────────────────

    /** Read a loaded model's bones and their rest pose (their local TRS at load). */
    _rigCapture(entry) {
        entry.bones = new Map();
        entry.boneRest = new Map();
        entry.boneOrder = [];
        if (!entry.object) return;
        const used = new Set();
        entry.object.traverse((o) => {
            if (!o.isBone) return;
            // Bone names are how controls find their bones, so they must be
            // unique; a file that repeats one gets the later ones numbered.
            let name = o.name || "bone";
            if (used.has(name)) { let i = 2; while (used.has(`${name}_${i}`)) i++; name = `${name}_${i}`; o.name = name; }
            used.add(name);
            entry.bones.set(name, o);
            entry.boneRest.set(name, { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() });
            entry.boneOrder.push(name);
        });
    },

    /** Model space: the space of the model item's own geometry (its `inner` node). */
    _rigModelInverse(entry) {
        const { THREE } = this.libs;
        const inner = this._bodyOf(entry);
        inner.updateWorldMatrix(true, false);
        return new THREE.Matrix4().copy(inner.matrixWorld).invert();
    },

    /**
     * The skeleton of a model item at rest, in model space:
     * { bones: [{ name, parent, world }] }, parents before children.
     * Null when the model has no bones (or is not loaded yet).
     */
    rigSkeleton(modelId) {
        const entry = this._entries.get(modelId);
        if (!entry || !entry.bones || !entry.bones.size) return null;
        const { THREE } = this.libs;
        // Back to rest for the measurement, then pose again.
        for (const [name, bone] of entry.bones) {
            const r = entry.boneRest.get(name);
            bone.position.fromArray(r.p); bone.quaternion.fromArray(r.q); bone.scale.fromArray(r.s);
        }
        entry.object.updateMatrixWorld(true);
        const inv = this._rigModelInverse(entry);
        const bones = [];
        for (const name of entry.boneOrder) {
            const bone = entry.bones.get(name);
            const world = new THREE.Matrix4().multiplyMatrices(inv, bone.matrixWorld);
            bones.push({ name, parent: bone.parent && bone.parent.isBone ? bone.parent.name : null, world: world.toArray() });
        }
        this.applyFrame(this.sceneFrame);
        return { bones };
    },

    // ── Posing the bones from the controls ────────────────────────────────

    /** Pose every rigged character at the frame the items were just placed at. */
    _rigApplyAll() {
        if (!this.scene3d) return;
        const byModel = new Map();
        for (const it of this.scene3d.items || []) {
            if (it.kind !== "control" || !it.control) continue;
            if (!byModel.has(it.control.model)) byModel.set(it.control.model, []);
            byModel.get(it.control.model).push(it);
        }
        for (const [modelId, controls] of byModel) {
            const entry = this._entries.get(modelId);
            if (entry && entry.bones && entry.bones.size) this._rigApply(entry, controls);
        }
    },

    /** Where each control is, in model space, right now. */
    _rigControlWorlds(entry, controls) {
        const { THREE } = this.libs;
        entry.root.updateMatrixWorld(true);
        const inv = this._rigModelInverse(entry);
        const out = new Map();
        const m = new THREE.Matrix4();
        for (const c of controls) {
            const ce = this._entries.get(c.id);
            if (!ce) continue;
            m.multiplyMatrices(inv, ce.root.matrixWorld);
            out.set(c.id, m.toArray());
        }
        return out;
    },

    /**
     * The pose the controls ask for: model-space world matrices per bone,
     * FK first, then each limb's IK blended in. Answers Map name -> 4x4.
     */
    _rigSolve(entry, controls, frame = this.sceneFrame) {
        const cw = this._rigControlWorlds(entry, controls);
        const fkByBone = new Map();
        const iks = [];
        const byId = new Map(controls.map((c) => [c.id, c]));
        for (const c of controls) {
            if (c.control.type === "fk" && c.control.bone) fkByBone.set(c.control.bone, c);
            if (c.control.type === "ik" && c.control.chain) iks.push(c);
        }
        const restLocal = (name) => {
            const r = entry.boneRest.get(name);
            return mat4.compose(r.p, r.q, r.s);
        };
        const parentName = (name) => {
            const b = entry.bones.get(name);
            return b && b.parent && b.parent.isBone ? b.parent.name : null;
        };
        // The parent object of the skeleton's top bones, in model space.
        const { THREE } = this.libs;
        const inv = this._rigModelInverse(entry);
        const topParent = (name) => {
            const b = entry.bones.get(name);
            if (!b.parent) return mat4.identity();
            b.parent.updateWorldMatrix(true, false);
            return new THREE.Matrix4().multiplyMatrices(inv, b.parent.matrixWorld).toArray();
        };
        // 1. FK.
        const fk = new Map();
        for (const name of entry.boneOrder) {
            const ctrl = fkByBone.get(name);
            const p = parentName(name);
            if (ctrl && cw.has(ctrl.id) && ctrl.control.bind) fk.set(name, mat4.mul(cw.get(ctrl.id), ctrl.control.bind));
            else fk.set(name, mat4.mul(p ? fk.get(p) : topParent(name), restLocal(name)));
        }
        // 2. IK, per limb, over the FK pose.
        const override = new Map();
        for (const ik of iks) {
            const [na, nb, nc] = ik.control.chain;
            if (!fk.has(na) || !fk.has(nb) || !fk.has(nc) || !cw.has(ik.id)) continue;
            // What the item was placed with this frame (keys, clips, layers), else its own keys.
            const placed = frame === this.sceneFrame && this._entries.get(ik.id) && this._entries.get(ik.id).at;
            const blend = Math.max(0, Math.min(1, placed && Number.isFinite(placed.ikfk) ? placed.ikfk
                : ik.tracks && ik.tracks.ikfk && ik.tracks.ikfk.length
                ? this._rigScalarAt(ik, "ikfk", frame) : (ik.ikfk ?? 1)));
            if (blend <= 0) continue;
            const A = mat4.decompose(fk.get(na)), B = mat4.decompose(fk.get(nb)), C = mat4.decompose(fk.get(nc));
            const endWorld = mat4.mul(cw.get(ik.id), ik.control.bind || mat4.identity());
            const E = mat4.decompose(endWorld);
            const pole = ik.control.pole && cw.has(ik.control.pole) ? cw.get(ik.control.pole) : null;
            const polePos = pole ? [pole[12], pole[13], pole[14]] : v3.add(B.p, [0, 0, 1]);
            const sol = solveTwoBone({
                pa: A.p, pb: B.p, pc: C.p, qa: A.q, qb: B.q,
                target: E.p, pole: polePos, hinge: ik.control.hinge || [0, 0, 1], lengths: ik.control.lengths,
            });
            const qa = blend >= 1 ? sol.qa : quat.slerp(A.q, sol.qa, blend);
            const qb = blend >= 1 ? sol.qb : quat.slerp(B.q, sol.qb, blend);
            const qc = blend >= 1 ? E.q : quat.slerp(C.q, E.q, blend);
            const wa = mat4.compose(A.p, qa, A.s);
            const lb = restLocal(nb);
            const pb = mat4.point(wa, [lb[12], lb[13], lb[14]]);
            const wb = mat4.compose(pb, qb, B.s);
            const lc = restLocal(nc);
            const pc = mat4.point(wb, [lc[12], lc[13], lc[14]]);
            const wc = mat4.compose(pc, qc, C.s);
            override.set(na, wa); override.set(nb, wb); override.set(nc, wc);
            void byId;
        }
        if (!override.size) return fk;
        // 3. Everything under an IK'd bone keeps its FK pose relative to its parent.
        const out = new Map();
        for (const name of entry.boneOrder) {
            if (override.has(name)) { out.set(name, override.get(name)); continue; }
            const p = parentName(name);
            if (p && (override.has(p) || out.get(p) !== fk.get(p))) {
                out.set(name, mat4.mul(out.get(p), mat4.mul(mat4.invert(fk.get(p)), fk.get(name))));
            } else out.set(name, fk.get(name));
        }
        return out;
    },

    _rigScalarAt(item, prop, frame) {
        // scene3d.valueAt, without importing the scene module twice over.
        const keys = item.tracks[prop];
        if (!keys || !keys.length) return item[prop];
        if (frame <= keys[0].f) return keys[0].v;
        const last = keys[keys.length - 1];
        if (frame >= last.f) return last.v;
        let i = 0;
        while (i < keys.length - 1 && keys[i + 1].f <= frame) i++;
        const a = keys[i], b = keys[i + 1];
        if (a.ease === "hold") return a.v;
        let t = (frame - a.f) / Math.max(1e-9, b.f - a.f);
        if (a.ease !== "linear") t = t * t * (3 - 2 * t);
        return a.v + (b.v - a.v) * t;
    },

    /** Put a pose on the bones: model-space worlds back into each bone's local TRS. */
    _rigSetPose(entry, worlds) {
        const { THREE } = this.libs;
        const inv = this._rigModelInverse(entry);
        const tmp = new THREE.Matrix4();
        for (const name of entry.boneOrder) {
            const bone = entry.bones.get(name);
            const w = worlds.get(name);
            if (!w) continue;
            let parentW;
            if (bone.parent && bone.parent.isBone && worlds.has(bone.parent.name)) parentW = worlds.get(bone.parent.name);
            else if (bone.parent) {
                bone.parent.updateWorldMatrix(true, false);
                parentW = tmp.multiplyMatrices(inv, bone.parent.matrixWorld).toArray();
            } else parentW = mat4.identity();
            const local = mat4.mul(mat4.invert(parentW), w);
            const d = mat4.decompose(local);
            bone.position.fromArray(d.p);
            bone.quaternion.fromArray(d.q);
            bone.scale.fromArray(d.s);
        }
        entry.object.updateMatrixWorld(true);
    },

    _rigApply(entry, controls) {
        const worlds = this._rigSolve(entry, controls);
        entry.rigPose = worlds;
        this._rigSetPose(entry, worlds);
    },

    /**
     * Where the bones are now, model space: Map name -> 4x4. What matching
     * IK to FK and baking read. Null for a model without bones.
     */
    rigPose(modelId) {
        const entry = this._entries.get(modelId);
        if (!entry || !entry.bones || !entry.bones.size) return null;
        if (entry.rigPose) return entry.rigPose;
        entry.object.updateMatrixWorld(true);
        const { THREE } = this.libs;
        const inv = this._rigModelInverse(entry);
        const out = new Map();
        for (const name of entry.boneOrder) {
            out.set(name, new THREE.Matrix4().multiplyMatrices(inv, entry.bones.get(name).matrixWorld).toArray());
        }
        return out;
    },

    /** The bones' pose at `frame` without disturbing the view (for baking and export). */
    rigPoseAt(modelId, frame) {
        const was = this.sceneFrame;
        this.applyFrame(frame);
        const entry = this._entries.get(modelId);
        let pose = null;
        if (entry && entry.bones && entry.bones.size) {
            if (this._rigged(modelId)) pose = new Map(entry.rigPose || []);
            else {
                entry.object.updateMatrixWorld(true);
                pose = this.rigPose(modelId);
                pose = new Map(pose);
            }
        }
        if (was !== frame) this.applyFrame(was);
        return pose;
    },

    /** Every control's model-space world matrix right now: Map id -> 4x4. */
    rigControlWorlds(modelId) {
        const entry = this._entries.get(modelId);
        if (!entry || !this.scene3d) return new Map();
        return this._rigControlWorlds(entry, controlsOf(this.scene3d, modelId));
    },

    /** The bones' poses at several frames (one walk through them): [{ f, pose: Map name -> 4x4 }]. */
    rigPosesAt(modelId, frames) {
        const was = this.sceneFrame;
        const entry = this._entries.get(modelId);
        const out = [];
        if (!entry || !entry.bones || !entry.bones.size) return out;
        for (const f of frames) {
            this.applyFrame(f);
            if (this._rigged(modelId)) out.push({ f, pose: new Map(entry.rigPose || []) });
            else { entry.object.updateMatrixWorld(true); out.push({ f, pose: new Map(this.rigPose(modelId)) }); }
        }
        this.applyFrame(was);
        return out;
    },

    /**
     * A character as numbers, for src/rig_export.py: its bones at rest (local
     * TRS under their parent bone, or in model space at the top), its meshes as
     * they lie at rest in model space (skin weights by bone index; a mesh that
     * is not skinned but hangs under a bone is weighted fully to it), and every
     * bone's local TRS on each of `frames`, plus where the model is in the
     * scene. Answers { meta, parts } (parts: name -> typed array) or null.
     */
    rigExportData(modelId, frames) {
        const entry = this._entries.get(modelId);
        if (!entry || !entry.object) return null;
        const { THREE } = this.libs;
        const was = this.sceneFrame;
        const names = entry.boneOrder || [];
        const index = new Map(names.map((n, i) => [n, i]));
        const parentOf = (n) => {
            const b = entry.bones.get(n);
            return b.parent && b.parent.isBone && index.has(b.parent.name) ? index.get(b.parent.name) : -1;
        };
        const trs = (m) => {
            const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
            m.decompose(t, q, s);
            return { t: t.toArray(), q: q.toArray(), s: s.toArray() };
        };
        const local = (worlds, i, p) => (p >= 0 ? new THREE.Matrix4().copy(worlds[p]).invert().multiply(worlds[i]) : worlds[i].clone());

        // Rest: the bones as the file has them.
        for (const [name, bone] of entry.bones) {
            const r = entry.boneRest.get(name);
            bone.position.fromArray(r.p); bone.quaternion.fromArray(r.q); bone.scale.fromArray(r.s);
        }
        entry.object.updateMatrixWorld(true);
        let inv = this._rigModelInverse(entry);
        const restW = names.map((n) => new THREE.Matrix4().multiplyMatrices(inv, entry.bones.get(n).matrixWorld));
        const bones = names.map((n, i) => {
            const p = parentOf(n);
            return { name: n, parent: p, rest: trs(local(restW, i, p)), bind: restW[i].toArray() };
        });

        const parts = {};
        const meshes = [];
        const v = new THREE.Vector3();
        entry.object.traverse((o) => {
            if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || o.userData.imageViewerHelper) return;
            const g = o.geometry, pos = g.attributes.position, n = pos.count, k = meshes.length;
            const out = new Float32Array(n * 3);
            const toModel = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
            for (let i = 0; i < n; i++) {
                v.fromBufferAttribute(pos, i);
                if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
                v.applyMatrix4(toModel);
                out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
            }
            const m = { name: o.name || `mesh${k}`, positions: `f32:p${k}`, indices: `u32:i${k}` };
            parts[`p${k}`] = out;
            parts[`i${k}`] = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
            if (g.attributes.uv) { parts[`u${k}`] = Float32Array.from(g.attributes.uv.array); m.uvs = `f32:u${k}`; }
            let joints = null, weights = null;
            if (o.isSkinnedMesh && g.attributes.skinIndex && g.attributes.skinWeight) {
                const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
                joints = new Uint32Array(n * 4); weights = new Float32Array(n * 4);
                const map = o.skeleton.bones.map((b) => (index.has(b.name) ? index.get(b.name) : 0));
                for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) {
                    joints[i * 4 + c] = map[si.getComponent(i, c)] || 0;
                    weights[i * 4 + c] = sw.getComponent(i, c);
                }
            } else if (names.length) {
                let a = o.parent;
                while (a && !(a.isBone && index.has(a.name))) a = a.parent;
                if (a) {
                    joints = new Uint32Array(n * 4); weights = new Float32Array(n * 4);
                    for (let i = 0; i < n; i++) { joints[i * 4] = index.get(a.name); weights[i * 4] = 1; }
                }
            }
            if (joints) { parts[`j${k}`] = joints; parts[`w${k}`] = weights; m.joints = `u32:j${k}`; m.weights = `f32:w${k}`; }
            meshes.push(m);
        });

        // The frames.
        const F = frames.length, B = names.length;
        const anim = new Float32Array(F * B * 10), rootAnim = new Float32Array(F * 10);
        let rootMatrix = null;
        frames.forEach((f, fi) => {
            this.applyFrame(f);
            entry.object.updateMatrixWorld(true);
            const body = this._bodyOf(entry);
            body.updateWorldMatrix(true, false);
            if (!rootMatrix) rootMatrix = body.matrixWorld.toArray();
            const r = trs(body.matrixWorld);
            rootAnim.set([...r.t, ...r.q, ...r.s], fi * 10);
            inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
            const w = names.map((n) => new THREE.Matrix4().multiplyMatrices(inv, entry.bones.get(n).matrixWorld));
            names.forEach((n, i) => {
                const l = trs(local(w, i, bones[i].parent));
                anim.set([...l.t, ...l.q, ...l.s], (fi * B + i) * 10);
            });
        });
        this.applyFrame(was);
        if (B) parts.anim = anim;
        parts.rootAnim = rootAnim;
        const root = trs(new THREE.Matrix4().fromArray(rootMatrix || new THREE.Matrix4().toArray()));
        return {
            meta: { frames, bones, meshes, root, rootMatrix, anim: B ? "f32:anim" : null, rootAnim: "f32:rootAnim" },
            parts,
        };
    },

    /** A model item's skinned meshes, for export: [{ mesh, name }]. */
    rigMeshes(modelId) {
        const entry = this._entries.get(modelId);
        const out = [];
        if (!entry || !entry.object) return out;
        entry.object.traverse((o) => { if (o.isMesh) out.push(o); });
        return out;
    },
};
