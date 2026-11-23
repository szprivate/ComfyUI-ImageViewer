// imageViewer_animLayersPanel.js
// The Anim Layers panel of the 3D space (dock id `animLayers`): the scene's
// animation layers, top of the stack first and the base at the bottom, as an
// animator's layer editor lays them out. The maths is imageViewer_animLayers.js;
// this is the panel and the edits (each one undo step).
//
// A row: the layer's name (double-click renames), its mode (A additive /
// O override, a click switches), its weight (slider and number; the diamond
// keys it at the playhead, so a layer can fade in and out), and Mute, Solo,
// Lock. Clicking a row makes it the ACTIVE layer: every key the gizmo, the
// Channel Box, the key bar, the Rig menu and the Curve Editor set or show is
// on that layer from then on (scene3d's edit functions follow it).
//
// AI motion takes are put on a layer of their own (previzLayerBakeTarget), so
// a take can be weighted, muted, soloed against another or merged down.
//
// The panel comes in instances: the drawing and the rows live in
// imageViewer_animLayersInstance.js, one closure per panel with its own rows, signature and scroll. This mixin
// keeps the FIRST one — the markup in imageViewer.html — with its state on the viewer as it always was
// (this._alUI), registers the maker the dock calls for every further one ("animLayers@2", ...), and fans a
// refresh out to all of them. The layers they show are the tab's scene, shared: an edit in one is seen by all.
import * as S from "./imageViewer_scene3d.js";
import * as L from "./imageViewer_animLayers.js";
import { notice } from "./imageViewer_exportUI.js";
import { createAnimLayersInstance } from "./imageViewer_animLayersInstance.js";

export const AnimLayersMixin = {

    // ── Edits the rest of the viewer (and the agent) call ────────────────────

    /** A new layer on top (made active unless `select` is false). Returns its id. */
    previzLayerAdd({ name, mode = "additive", weight = 1, select = true, snapshot = true } = {}) {
        const scene = this.previzScene();
        if (!scene) return null;
        if (snapshot) this.previzSnapshot(`new ${mode} layer`);
        const layer = L.addLayer(scene, { name, mode, weight, select });
        this.previzLayersChanged();
        return layer ? layer.id : null;
    },

    /** Run `fn` with `layerId` as the layer keys go to, then put the old one back. */
    previzWithLayer(layerId, fn) {
        const scene = this.previzScene();
        if (!scene) return fn();
        const before = scene.activeLayer || null;
        L.setActiveLayer(scene, layerId);
        try {
            return fn();
        } finally {
            L.setActiveLayer(scene, before);
        }
    },

    /**
     * The layer an AI take for `modelId` is keyed on: `layerId` when it is a
     * layer of this scene, else a new override layer named for the take.
     */
    previzLayerBakeTarget(modelId, layerId = null, opts = {}) {
        // A string is the layer's whole name (the AI bake passes "AI motion · Character");
        // that new layer is its own undo step, so undoing the take's keys leaves it empty, not gone.
        const named = typeof opts === "string";
        const { name = "AI motion", snapshot = named } = named ? { name: opts } : (opts || {});
        const scene = this.previzScene();
        if (!scene) return null;
        if (layerId && L.layerById(scene, layerId)) return layerId;
        const model = named ? null : S.itemById(scene, modelId);
        const label = model ? `${name} ${model.name}` : name;
        return this.previzLayerAdd({ name: label, mode: "override", select: false, snapshot });
    },

    previzLayerSetActive(id) {
        const scene = this.previzScene();
        if (!scene) return;
        L.setActiveLayer(scene, id);
        // Not an undo step: which layer is being keyed is a way of working, not a change.
        this.previzLayersChanged({ persist: true });
    },

    previzLayerSet(id, patch, { label = "layer", live = false } = {}) {
        const scene = this.previzScene();
        if (!scene || !L.layerById(scene, id)) return;
        if (live) this.previzBeginDrag && this.previzBeginDrag(label);
        else if (!this._previzDragging) this.previzSnapshot(label);
        L.setLayer(scene, id, patch);
        if (live) { this._modelView().applyFrame(this.currentFrame || 0); this._previzRenderChannels?.(); this._alRefreshValues(); }
        else this.previzLayersChanged();
    },

    previzLayerRemove(id) {
        const scene = this.previzScene();
        const layer = L.layerById(scene, id);
        if (!layer) return;
        this.previzSnapshot(`delete layer ${layer.name}`);
        L.removeLayer(scene, id);
        this.previzLayersChanged();
    },

    previzLayerMove(id, dir) {
        const scene = this.previzScene();
        if (!L.layerById(scene, id)) return;
        this.previzSnapshot("move layer");
        L.moveLayer(scene, id, dir);
        this.previzLayersChanged();
    },

    previzLayerMergeDown(id = this.previzScene() && this.previzScene().activeLayer) {
        const scene = this.previzScene();
        const layer = L.layerById(scene, id);
        if (!layer) { notice("info", "Merge layer down", "Pick a layer (not the base) to merge into the one beneath it."); return; }
        const list = scene.animLayers;
        const below = list[list.indexOf(layer) - 1];
        if (below && below.lock) { notice("info", "Merge layer down", `${below.name} is locked.`); return; }
        this.previzSnapshot(`merge ${layer.name} down`);
        L.mergeLayerDown(scene, id);
        this.previzLayersChanged();
    },

    /** The selected items' keys on the active layer, moved to a new layer above it. */
    previzLayerExtract() {
        const scene = this.previzScene();
        const items = this.previzSelectedIds().map((x) => S.itemById(scene, x)).filter(Boolean);
        if (!items.length) { notice("info", "Extract to layer", "Select the items whose keys should go to a layer of their own."); return; }
        if (this.previzLayerRefuseLocked()) return;
        this.previzSnapshot("extract to layer");
        L.extractToLayer(scene, items, { name: "Extracted" });
        this.previzLayersChanged();
    },

    /** Key (or unkey) a layer's weight at the playhead. */
    previzLayerKeyWeight(id) {
        const scene = this.previzScene();
        const layer = L.layerById(scene, id);
        if (!layer) return;
        const f = Math.round(this.currentFrame || 0);
        const has = layer.tracks && (layer.tracks.weight || []).some((k) => k.f === f);
        this.previzSnapshot(has ? "unkey layer weight" : "key layer weight");
        if (has) L.removeLayerWeightKey(layer, f);
        else L.keyLayerWeight(layer, f, L.layerWeightAt(layer, f), this._previzEase || "smooth");
        this.previzLayersChanged();
    },

    /** Set a layer's weight; keyed at the playhead when its weight already animates. */
    previzLayerWeight(id, w, { live = false } = {}) {
        const scene = this.previzScene();
        const layer = L.layerById(scene, id);
        if (!layer) return;
        const keyed = layer.tracks && layer.tracks.weight && layer.tracks.weight.length;
        if (!keyed) { this.previzLayerSet(id, { weight: w }, { label: "layer weight", live }); return; }
        if (live) this.previzBeginDrag && this.previzBeginDrag("layer weight");
        else if (!this._previzDragging) this.previzSnapshot("layer weight");
        L.keyLayerWeight(layer, Math.round(this.currentFrame || 0), w, null);
        if (live) { this._modelView().applyFrame(this.currentFrame || 0); this._previzRenderChannels?.(); this._alRefreshValues(); }
        else this.previzLayersChanged();
    },

    /** True (and says so) when the layer keys would go to is locked. */
    previzLayerRefuseLocked() {
        const layer = S.activeLayerOf(this.previzScene());
        if (layer && layer.lock) {
            notice("info", "The layer is locked", `${layer.name} takes no keys while it is locked. Unlock it in Anim Layers, or pick another layer.`);
            return true;
        }
        return false;
    },

    /** After any layer change: the picture, the panels, the ticks, the saved scene. */
    previzLayersChanged({ persist = true } = {}) {
        this._alRender();
        if (this.previzChanged) this.previzChanged({ persist });
    },

    // ── The panel ────────────────────────────────────────────────────────────

    /** The first panel: the markup's, its state on the viewer (st === this) so this._alUI stays where it was. */
    _alPrimary() {
        this._alRegisterMaker();
        const host = this.animLayersPanel;
        if (!host) return null;
        if (!this._alInst || this._alInst.el !== host) this._alInst = createAnimLayersInstance(this, host, this, null);
        return this._alInst;
    },

    /** Every further one: a panel of its own, showing the same stack, with rows and scroll of its own. */
    _alRegisterMaker() {
        if (!this._dockMakers || this._dockMakers().animLayers) return;
        this._dockMakers().animLayers = (v, id, saved) => {
            const doc = (v._dockRootEl && v._dockRootEl.ownerDocument)
                || (v.animLayersPanel && v.animLayersPanel.ownerDocument);
            if (!doc) return null;
            const host = doc.createElement("div");
            host.className = "previz-panel anim-layers-panel";
            return createAnimLayersInstance(v, host, {}, saved);
        };
    },

    _alBuild() {
        const inst = this._alPrimary();
        return inst ? inst.build() : null;
    },

    _alMoveActive(dir) {
        const scene = this.previzScene();
        if (scene && scene.activeLayer) this.previzLayerMove(scene.activeLayer, dir);
    },

    /** The instances of this kind that are up and in front (the first one is not among them). */
    _alExtraInstances() {
        const found = this._dockInstancesOf ? this._dockInstancesOf("animLayers") : [];
        return found.filter((x) => x.inst !== this._alInst);
    },

    /** Draw the panel: the first one when it is open, and every instance in front. */
    _alRender() {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        // Registered even while the panel is put away, so the dock's + menu offers another one.
        this._alRegisterMaker();
        if (this.isPanelDocked && this.isPanelDocked("animLayers")) this._alPrimary()?.refresh();
        for (const { inst } of this._alExtraInstances()) inst.refresh();
    },

    /** The weights and key diamonds as they stand at the playhead (cheap; every frame). */
    _alRefreshValues() {
        if (this._alInst) this._alInst.refreshValues();
        for (const { inst } of this._alExtraInstances()) inst.refreshValues();
    },

    _previzHideLayers() {
        if (this.isPanelDocked && this.isPanelDocked("animLayers")) this.setPanelDocked("animLayers", false);
    },

    /** What the agent sees of the layers (viewerState). */
    previzLayersState() {
        const scene = this.previzScene();
        if (!scene || !scene.animLayers) return null;
        const f = Math.round(this.currentFrame || 0);
        return {
            active: scene.activeLayer || null,
            layers: scene.animLayers.map((l) => ({
                id: l.id, name: l.name, mode: l.mode, weight: L.layerWeightAt(l, f),
                mute: l.mute, solo: l.solo, lock: l.lock, items: L.layerMembers(scene, l.id).length,
            })),
        };
    },
};
