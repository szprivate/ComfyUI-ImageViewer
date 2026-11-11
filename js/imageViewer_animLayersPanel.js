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
import * as S from "./imageViewer_scene3d.js";
import * as L from "./imageViewer_animLayers.js";
import { notice } from "./imageViewer_exportUI.js";

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

    _alBuild() {
        const host = this.animLayersPanel;
        if (!host) return null;
        const doc = host.ownerDocument;
        host.querySelectorAll(":scope > .al-body").forEach((n) => n.remove());
        const root = doc.createElement("div");
        root.className = "al-body";
        const bar = doc.createElement("div");
        bar.className = "al-bar";
        const btn = (text, title, run, cls = "") => {
            const b = doc.createElement("button");
            b.className = `previz-btn al-btn ${cls}`.trim();
            b.textContent = text;
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(e); };
            bar.append(b);
            return b;
        };
        btn("+ Add", "New additive layer: its keys are added on top of what is below (offsets)",
            () => this.previzLayerAdd({ mode: "additive" }), "al-add");
        btn("+ Over", "New override layer: its keys replace what is below, by the layer's weight",
            () => this.previzLayerAdd({ mode: "override", name: "Override" }), "al-addover");
        btn("Extract", "Move the selected items' keys on the active layer to a new layer above it",
            () => this.previzLayerExtract(), "al-extract");
        btn("Merge", "Merge the active layer into the layer under it (bakes what the two show together)",
            () => this.previzLayerMergeDown(), "al-merge");
        const up = btn("▲", "Move the active layer up", () => this._alMoveActive(1), "al-up");
        const down = btn("▼", "Move the active layer down", () => this._alMoveActive(-1), "al-down");
        const del = btn("✕", "Delete the active layer and its keys", () => {
            const id = this.previzScene() && this.previzScene().activeLayer;
            if (id) this.previzLayerRemove(id);
        }, "al-del");
        const list = doc.createElement("div");
        list.className = "al-list";
        root.append(bar, list);
        host.appendChild(root);
        this._alUI = { root, list, up, down, del, sig: "", rows: new Map() };
        return this._alUI;
    },

    _alMoveActive(dir) {
        const scene = this.previzScene();
        if (scene && scene.activeLayer) this.previzLayerMove(scene.activeLayer, dir);
    },

    /** Draw the panel (rows rebuilt only when the stack's shape changes). */
    _alRender() {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        if (!this.isPanelDocked || !this.isPanelDocked("animLayers")) return;
        const ui = (this._alUI && this._alUI.root.isConnected) ? this._alUI : this._alBuild();
        if (!ui) return;
        const scene = this.previzScene();
        const layers = (scene && scene.animLayers) || [];
        const sig = layers.map((l) => `${l.id}:${l.name}:${l.mode}:${l.mute}:${l.solo}:${l.lock}`).join("|")
            + `#${(scene && scene.activeLayer) || ""}`;
        if (sig !== ui.sig) {
            ui.sig = sig;
            this._alBuildRows(ui, scene, layers);
        }
        const active = scene && scene.activeLayer;
        const i = layers.findIndex((l) => l.id === active);
        ui.up.disabled = i < 0 || i === layers.length - 1;
        ui.down.disabled = i <= 0;
        ui.del.disabled = i < 0;
        this._alRefreshValues();
    },

    _alBuildRows(ui, scene, layers) {
        const doc = ui.list.ownerDocument;
        ui.list.innerHTML = "";
        ui.rows = new Map();
        const active = (scene && scene.activeLayer) || null;
        const solo = layers.some((l) => l.solo && !l.mute);
        const toggle = (label, title, on, run, cls) => {
            const b = doc.createElement("button");
            b.className = `al-tog ${cls}` + (on ? " on" : "");
            b.textContent = label;
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(); };
            return b;
        };
        // Top of the stack first, as a layer editor reads.
        for (const layer of [...layers].reverse()) {
            const row = doc.createElement("div");
            row.className = "al-row" + (layer.id === active ? " active" : "")
                + (layer.mute || (solo && !layer.solo) ? " silent" : "");
            row.dataset.layer = layer.id;
            row.title = L.describeLayer(scene, layer) + (layer.id === active ? " - keys go here" : " - click to key on this layer");
            row.onclick = () => this.previzLayerSetActive(layer.id);
            row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this._alMenu(layer, e); };

            const mode = toggle(layer.mode === "override" ? "O" : "A",
                layer.mode === "override" ? "Override - click for additive" : "Additive - click for override",
                false, () => this.previzLayerSet(layer.id, { mode: layer.mode === "override" ? "additive" : "override" },
                                                 { label: "layer mode" }), "al-mode " + layer.mode);
            const name = doc.createElement("span");
            name.className = "al-name";
            name.textContent = layer.name;
            name.ondblclick = (e) => { e.stopPropagation(); this._alRename(layer, name); };

            const slider = doc.createElement("input");
            slider.type = "range"; slider.min = "0"; slider.max = "1"; slider.step = "0.01";
            slider.className = "al-weight";
            slider.title = "Weight";
            slider.onclick = (e) => e.stopPropagation();
            slider.oninput = () => this.previzLayerWeight(layer.id, Number(slider.value), { live: true });
            // The drag's own undo step was taken at its first move.
            slider.onchange = () => { this.previzLayerWeight(layer.id, Number(slider.value)); this.previzEndDrag?.(); };
            const num = doc.createElement("input");
            num.className = "al-wnum";
            num.title = "Weight (0 - 1)";
            num.onclick = (e) => e.stopPropagation();
            num.onchange = () => {
                const v = Number(num.value);
                if (Number.isFinite(v)) this.previzLayerWeight(layer.id, Math.max(0, Math.min(1, v)));
            };
            const key = doc.createElement("button");
            key.className = "al-key";
            key.textContent = "◆";
            key.onclick = (e) => { e.stopPropagation(); this.previzLayerKeyWeight(layer.id); };

            const m = toggle("M", "Mute: the layer counts for nothing", layer.mute,
                () => this.previzLayerSet(layer.id, { mute: !layer.mute }, { label: "mute layer" }), "al-mute");
            const s = toggle("S", "Solo: only soloed layers (and the base) play", layer.solo,
                () => this.previzLayerSet(layer.id, { solo: !layer.solo }, { label: "solo layer" }), "al-solo");
            const l = toggle("L", "Lock: the layer takes no keys", layer.lock,
                () => this.previzLayerSet(layer.id, { lock: !layer.lock }, { label: "lock layer" }), "al-lock");
            row.append(mode, name, slider, num, key, m, s, l);
            ui.list.append(row);
            ui.rows.set(layer.id, { row, slider, num, key });
        }
        const base = doc.createElement("div");
        base.className = "al-row al-base" + (active ? "" : " active");
        base.dataset.layer = "";
        base.title = active ? "The item's own keys - click to key on them" : "The item's own keys - keys go here";
        base.onclick = () => this.previzLayerSetActive(null);
        const bname = doc.createElement("span");
        bname.className = "al-name";
        bname.textContent = "BaseAnimation";
        base.append(Object.assign(doc.createElement("span"), { className: "al-mode base", textContent: "–" }), bname);
        ui.list.append(base);
        if (!layers.length) {
            ui.list.append(Object.assign(doc.createElement("div"), {
                className: "al-empty",
                textContent: "No layers yet. Add one to key changes on top of the animation without touching its keys.",
            }));
        }
    },

    /** The weights and key diamonds as they stand at the playhead (cheap; every frame). */
    _alRefreshValues() {
        const ui = this._alUI;
        if (!ui || !ui.root.isConnected) return;
        const scene = this.previzScene();
        const f = Math.round(this.currentFrame || 0);
        for (const layer of (scene && scene.animLayers) || []) {
            const r = ui.rows.get(layer.id);
            if (!r) continue;
            const w = L.layerWeightAt(layer, f);
            const focused = r.num.ownerDocument.activeElement;
            if (focused !== r.slider) r.slider.value = String(w);
            if (focused !== r.num) r.num.value = String(Math.round(w * 100) / 100);
            const keys = (layer.tracks && layer.tracks.weight) || [];
            r.key.classList.toggle("keyed", keys.length > 0);
            r.key.classList.toggle("now", keys.some((k) => k.f === f));
            r.key.title = keys.length ? (keys.some((k) => k.f === f) ? "Remove the weight key here" : "Key the weight here")
                : "Key the weight here (the weight then animates)";
        }
    },

    _alRename(layer, nameEl) {
        const doc = nameEl.ownerDocument;
        const input = doc.createElement("input");
        input.className = "al-rename";
        input.value = layer.name;
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            if (ok && input.value.trim() && input.value.trim() !== layer.name) {
                this.previzLayerSet(layer.id, { name: input.value.trim() }, { label: "rename layer" });
            } else {
                input.replaceWith(nameEl);
            }
        };
        input.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
        };
        input.onclick = (e) => e.stopPropagation();
        input.onblur = () => finish(true);
    },

    _alMenu(layer, e) {
        const scene = this.previzScene();
        const members = L.layerMembers(scene, layer.id);
        this._previzOpenMenu([
            { label: "Make active", run: () => this.previzLayerSetActive(layer.id) },
            { label: `Select its items (${members.length})`, disabled: !members.length,
              title: "Nothing is keyed on this layer yet.",
              run: () => { members.forEach((it, i) => this.previzSelect(it.id, { add: i > 0 })); } },
            "-",
            { label: layer.mode === "override" ? "Make additive" : "Make override",
              run: () => this.previzLayerSet(layer.id, { mode: layer.mode === "override" ? "additive" : "override" }, { label: "layer mode" }) },
            { label: "Merge down", run: () => this.previzLayerMergeDown(layer.id) },
            { label: "Move up", run: () => this.previzLayerMove(layer.id, 1) },
            { label: "Move down", run: () => this.previzLayerMove(layer.id, -1) },
            "-",
            { label: "Delete layer", run: () => this.previzLayerRemove(layer.id) },
        ], e.clientX, e.clientY);
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
