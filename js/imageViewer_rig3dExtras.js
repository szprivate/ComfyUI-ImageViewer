// imageViewer_rig3dExtras.js
// The viewport half of the rigging extras (the data is imageViewer_rigExtras.js).
// Mixed into Model3DView after Rig3DMixin. Three jobs, all inside applyFrame:
//   - set-driven keys: an item's channels get what its drivers add before it
//     is placed (_rigDriven), and again live while a driver is dragged;
//   - blendshapes: a model's "bs:<morph>" channels set the influence of that
//     morph target on every mesh of the model that has it;
//   - spaces: a control in another space than its parent's has its rest node
//     follow that space (_rigApplySpaces), before the bones are posed.
import { evaluateDriven, spaceAt, spaceRestMatrix } from "./imageViewer_rigExtras.js";

const D2R = Math.PI / 180;

export const Rig3DExtrasMixin = {

    /** The items some driver reads, so a drag knows when to re-drive (cached per scene object). */
    _rigDriverIds() {
        const sc = this.scene3d;
        if (!sc) return new Set();
        const sig = sc.items;
        if (this._rigDrvCache && this._rigDrvCache.items === sig && this._rigDrvCache.n === sig.length) return this._rigDrvCache.ids;
        const ids = new Set();
        for (const it of sig) for (const d of it.drivers || []) ids.add(d.driver.id);
        this._rigDrvCache = { items: sig, n: sig.length, ids };
        return ids;
    },

    /** applyFrame's hook: the item's channels with its drivers, and its blendshapes put on. */
    _rigDriven(item, at, frame, entry) {
        const out = item.drivers && item.drivers.length ? evaluateDriven(this.scene3d, item, frame, 0, at) : at;
        if (entry && item.kind === "model") this._rigApplyMorphs(entry, item, out);
        return out;
    },

    /** Every morph-target name of a model's meshes, as three.js reads them from the file. */
    rigMorphNames(modelId) {
        const entry = this._entries && this._entries.get(modelId);
        const out = new Set();
        if (entry && entry.object) {
            entry.object.traverse((o) => {
                if (o.isMesh && o.morphTargetDictionary) for (const n of Object.keys(o.morphTargetDictionary)) out.add(n);
            });
        }
        return [...out];
    },

    /** Set the influences the item's "bs:" channels ask for (only those: the rest stay as the file / clip has them). */
    _rigApplyMorphs(entry, item, at) {
        if (!entry.object) return;
        const want = [];
        for (const k of Object.keys(at)) if (k.startsWith("bs:")) want.push([k.slice(3), at[k]]);
        if (!want.length && !entry.morphsSet) return;
        entry.object.traverse((o) => {
            if (!o.isMesh || !o.morphTargetDictionary || !o.morphTargetInfluences) return;
            for (const [n, v] of want) {
                const i = o.morphTargetDictionary[n];
                if (i !== undefined) o.morphTargetInfluences[i] = Math.max(0, Math.min(1, Number(v) || 0));
            }
        });
        // Morphs once set and then dropped from the item go back to 0.
        const now = new Set(want.map(([n]) => n));
        for (const n of entry.morphsSet || []) {
            if (now.has(n)) continue;
            entry.object.traverse((o) => {
                const i = o.morphTargetDictionary && o.morphTargetDictionary[n];
                if (i !== undefined && o.morphTargetInfluences) o.morphTargetInfluences[i] = 0;
            });
        }
        entry.morphsSet = now;
    },

    /** An item's world now in its character's model space (a control, the rig group, a bone's control). */
    _rigItemModelWorld(modelEntry, id) {
        const { THREE } = this.libs;
        const e = id && this._entries.get(id);
        if (!e) return null;
        const inv = this._rigModelInverse(modelEntry);
        const body = this._bodyOf(e);
        body.updateWorldMatrix(true, false);
        return new THREE.Matrix4().multiplyMatrices(inv, body.matrixWorld).toArray();
    },

    /** Controls in another space than their parent's: their rest node follows it. */
    _rigApplySpaces(frame = this.sceneFrame) {
        if (!this.scene3d) return;
        for (const item of this.scene3d.items || []) {
            if (item.kind !== "control" || !item.control || !(item.control.spaces && item.control.spaces.length)) continue;
            const entry = this._entries.get(item.id);
            const model = this._entries.get(item.control.model);
            if (!entry || !entry.top || !model) continue;
            const index = spaceAt(this.scene3d, item, frame);
            const m = index ? spaceRestMatrix(this.scene3d, item, index, (id) => this._rigItemModelWorld(model, id)) : item.rest;
            if (Array.isArray(m)) entry.top.matrix.fromArray(m);
            entry.top.matrixWorldNeedsUpdate = true;
            entry.top.updateMatrixWorld(true);
        }
    },

    /** World of an item for the panel's space switch (model space of its character). */
    rigItemWorld(modelId, id) {
        const model = this._entries.get(modelId);
        if (!model) return null;
        if (id && this._entries.get(id) && this._entries.get(id).root) {
            this.scene && this.scene.updateMatrixWorld(true);
        }
        return this._rigItemModelWorld(model, id);
    },

    /**
     * While a driver is dragged: put every driven item where its drivers say
     * now (the scene already holds the dragged numbers), so a facial control
     * moves the face under the mouse rather than when it is let go.
     */
    _rigDriveLive() {
        if (!this.scene3d) return;
        const drivers = this._rigDriverIds();
        if (!drivers.size || !drivers.has(this.selected)) return;
        const frame = this.sceneFrame;
        for (const item of this.scene3d.items || []) {
            if (!item.drivers || !item.drivers.length || item.id === this.selected) continue;
            const entry = this._entries.get(item.id);
            if (!entry) continue;
            const at = this._rigDriven(item, evaluateDriven(this.scene3d, item, frame), frame, entry);
            if (item.kind === "camera") continue;
            const pv = at.pivot || [0, 0, 0];
            entry.root.position.set(at.position[0] + pv[0], at.position[1] + pv[1], at.position[2] + pv[2]);
            entry.root.rotation.set(at.rotation[0] * D2R, at.rotation[1] * D2R, at.rotation[2] * D2R);
            entry.root.scale.set(...at.scale);
        }
        this.scene.updateMatrixWorld(true);
    },

    /** The IK blend a limb has now, its drivers included (what _rigSolve blends by). */
    _rigBlendOf(ik, frame) {
        const at = evaluateDriven(this.scene3d, ik, frame);
        return at.ikfk ?? ik.ikfk ?? 1;
    },
};
