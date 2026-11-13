// imageViewer_previzTerrain.js
// The 3D menu bar's Terrain menu: a new terrain, the terrain brushes (Sculpt ▸, Paint
// layer ▸, imageViewer_terrainBrush3d.js), the Scattering submenu (the
// scatter types, painting where a scatter grows, clearing that paint), and the
// panel's side of the scatter brush - writing its strokes into the scene and
// the small bar of brush settings over the view while it is on.
//
// A mixin on the viewer panel like the other previz files. The brush in the
// view is imageViewer_scatterPaint3d.js, its data imageViewer_scatterPaint.js.

import * as S from "./imageViewer_scene3d.js";
import { SCATTER_TYPES, scatterSettings, terrainSettings } from "./imageViewer_worldData.js";

// The terrain brushes, as the menu and the bar name them (imageViewer_terrainBrush3d.js).
export const TERRAIN_TOOL_LABELS = { raise: "Raise", lower: "Lower", smooth: "Smooth", flatten: "Flatten",
                                     restore: "Restore", layer: "Paint layer" };
const TOOL_TIPS = {
    raise: "Raise the ground (Ctrl+drag lowers)", lower: "Lower the ground (Ctrl+drag raises)",
    smooth: "Smooth bumps and edges away", flatten: "Level the ground at the height the stroke starts on",
    restore: "Take sculpting away, back to the terrain as generated",
    layer: "Paint a ground layer (Ctrl+drag erases back to the slope and height rules)",
};

export const SCATTER_LABELS = { pine: "Pines", tree: "Trees", bush: "Bushes", grass: "Grass", rock: "Rocks",
                                column: "Columns", lamp: "Lamps", model: "Model…" };

const tick = (on, label) => (on ? "✓ " : "") + label;
const layerName = (l, i) => (l.name ? l.name[0].toUpperCase() + l.name.slice(1) : `Layer ${i + 1}`);

export const PrevizTerrainMixin = {

    /** The bar's Terrain menu. */
    _previzTerrainMenuEntries() {
        const scene = this.previzScene();
        const items = (scene && scene.items) || [];
        const hasTerrain = items.some((i) => i.kind === "terrain");
        const ground = this.previzTerrainTarget();
        const t = ground ? terrainSettings(ground) : null;
        const view = this._model3d;
        const on = !!(view && view.terrainBrushing && view.terrainBrushing());
        const cur = on ? view.terrainBrush().tool : null;
        const why = ground ? "" : (hasTerrain ? "Select a terrain." : "Add a terrain first.");
        const tool = (key) => ({ label: tick(cur === key, TERRAIN_TOOL_LABELS[key]), disabled: !ground, title: why || TOOL_TIPS[key],
                                 run: () => this.previzTerrainBrushStart(key) });
        return [
            { label: "New terrain", run: () => this.previzAddWorldItem("terrain") },
            "-",
            { label: "Sculpt", sub: ["raise", "lower", "smooth", "flatten", "restore"].map(tool) },
            { label: "Paint layer", sub: (t ? t.layers : []).map((l, i) => ({
                label: tick(cur === "layer" && view.terrainBrush().layer === i, layerName(l, i)),
                disabled: !ground, title: why || TOOL_TIPS.layer,
                run: () => this.previzTerrainBrushStart("layer", i) })), disabled: !ground, title: why },
            ...(on ? [{ label: "Stop editing terrain", title: "Esc", run: () => this.previzTerrainBrushStop() }] : []),
            { label: "Erode…", disabled: !ground, title: why || "Rain and sliding wear the ground into valleys, live; Apply keeps it",
              run: () => this.previzTerrainErodeOpen() },
            { label: "Clear sculpting", disabled: !(t && t.sculpt), title: why || "Back to the generated heights",
              run: () => this.previzTerrainClear("sculpt") },
            { label: "Clear layer paint", disabled: !(t && t.layerPaint), title: why || "Back to the slope and height rules",
              run: () => this.previzTerrainClear("layerPaint") },
            "-",
            { label: "Scattering", sub: this._previzScatterMenuEntries(hasTerrain) },
        ];
    },

    /** The terrain the brushes are for: the selected one, a selected scatter's, or the scene's only one. */
    previzTerrainTarget() {
        const scene = this.previzScene();
        if (!scene) return null;
        const sel = S.itemById(scene, this._previzSelection);
        if (sel && sel.kind === "terrain") return sel;
        if (sel && sel.kind === "scatter") {
            const t = S.itemById(scene, scatterSettings(sel).target);
            if (t && t.kind === "terrain") return t;
        }
        const all = scene.items.filter((i) => i.kind === "terrain");
        return all.length === 1 ? all[0] : null;
    },

    previzTerrainBrushStart(tool = "raise", layer = null, id = null) {
        const scene = this.previzScene();
        const item = id ? scene && S.itemById(scene, id) : this.previzTerrainTarget();
        if (!item || item.kind !== "terrain") { this._worldStatus("Select a terrain to edit."); return false; }
        if (tool !== "layer" && !(terrainSettings(item).height > 0)) {
            this._worldStatus("This terrain has no height to sculpt: set its Height above 0."); return false;
        }
        const view = this._modelView();
        const patch = { tool };
        if (layer != null) patch.layer = layer;
        const err = view.terrainBrushBegin(item.id, patch);
        if (err) { this._worldStatus(err); return false; }
        this._tbTab = this.activeTab;
        this._previzTerrainBar(item);
        return true;
    },

    previzTerrainBrushStop() {
        const view = this._model3d;
        if (view && view.terrainBrushEnd) view.terrainBrushEnd();
    },

    /** Sculpting ("sculpt") or the layer paint ("layerPaint") taken off a terrain. */
    previzTerrainClear(what, id = null) {
        const scene = this.previzScene();
        const item = id ? scene && S.itemById(scene, id) : this.previzTerrainTarget();
        if (!item || item.kind !== "terrain" || !terrainSettings(item)[what]) return;
        this.previzSnapshot(`clear ${item.name} ${what === "sculpt" ? "sculpting" : "layer paint"}`);
        item.terrain = { ...(item.terrain || {}), [what]: null };
        this.previzChanged({ reload: true });
    },

    /** A finished stroke of a terrain brush: one undo step, then the terrain (and its scatters) rebuilt. */
    previzTerrainEditWrite(id, patch) {
        const scene = this.previzScene();
        const item = scene && S.itemById(scene, id);
        if (!item || item.kind !== "terrain" || !patch || !Object.keys(patch).length) return;
        const label = "sculpt" in patch ? `sculpt ${item.name}` : `paint ${item.name} layers`;
        this.previzSnapshot(label);
        item.terrain = { ...(item.terrain || {}), ...patch };
        this.previzChanged({ reload: true });
    },

    /** From previzChanged while the terrain brushes are on. */
    _previzTerrainBrushCheck() {
        const view = this._model3d;
        if (!view || !view.terrainBrushing()) return;
        const scene = this.previzScene();
        const item = scene && S.itemById(scene, view._tb.id);
        if (this.activeTab !== this._tbTab || !item) { view.terrainBrushEnd(); return; }
        view.terrainBrushReload(item);
    },

    _previzTerrainBar(item) {
        this._previzTerrainBarDrop();
        const view = this._modelView();
        const doc = view.stage.ownerDocument;
        const el = (tag, cls, text) => Object.assign(doc.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});
        const bar = el("div", "model-spaint-bar model-terrain-bar");
        bar.append(el("span", "spb-title", `Edit ${item.name}`));
        const tools = el("div", "spb-mode");
        const btns = {};
        for (const key of ["raise", "lower", "smooth", "flatten", "restore", "layer"]) {
            const b = el("button", "spb-btn", key === "layer" ? "Paint" : TERRAIN_TOOL_LABELS[key]);
            b.title = TOOL_TIPS[key];
            b.dataset.tool = key;
            b.onclick = () => view.terrainBrushSet({ tool: key });
            tools.append(b);
            btns[key] = b;
        }
        bar.append(tools);
        const layer = el("select", "spb-num spb-layer");
        layer.title = "The ground layer Paint lays down";
        terrainSettings(item).layers.forEach((l, i) => layer.append(Object.assign(doc.createElement("option"),
            { value: String(i), textContent: layerName(l, i) })));
        layer.addEventListener("change", () => view.terrainBrushSet({ layer: Number(layer.value), tool: "layer" }));
        layer.addEventListener("keydown", (e) => e.stopPropagation());
        bar.append(layer);
        const field = (label, key, min, max, step, title) => {
            const wrap = el("label", "spb-field");
            wrap.title = title;
            wrap.append(el("span", "", label));
            const input = el("input", "spb-num");
            Object.assign(input, { type: "number", min, max, step });
            input.dataset.key = key;
            input.addEventListener("change", () => view.terrainBrushSet({ [key]: parseFloat(input.value) }));
            input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") input.blur(); });
            wrap.append(input);
            bar.append(wrap);
        };
        field("Size", "radius", 0.1, 1000, 1, "Brush radius in metres ([ and ] change it)");
        field("Strength", "strength", 0.01, 1, 0.05, "How much one dab does");
        field("Hardness", "hardness", 0, 0.99, 0.05, "Share of the brush at full strength before it fades");
        const done = el("button", "spb-btn spb-done", "Done");
        done.title = "Stop editing (Esc)";
        done.onclick = () => this.previzTerrainBrushStop();
        bar.append(done);
        for (const t of ["pointerdown", "wheel", "contextmenu"]) bar.addEventListener(t, (e) => e.stopPropagation());
        view.stage.append(bar);
        this._tbBar = { bar, btns, layer };
        this._previzTerrainBarSync(view.terrainBrush());
    },

    _previzTerrainBarSync(b) {
        const ui = this._tbBar;
        if (!ui) return;
        for (const [k, btn] of Object.entries(ui.btns)) btn.classList.toggle("on", k === b.tool);
        ui.layer.value = String(b.layer);
        ui.layer.classList.toggle("dim", b.tool !== "layer");
        for (const input of ui.bar.querySelectorAll("input[data-key]")) {
            if (input.ownerDocument.activeElement === input) continue;
            input.value = String(Math.round(b[input.dataset.key] * 100) / 100);
        }
    },

    _previzTerrainBarDrop() {
        if (this._tbBar) { this._tbBar.bar.remove(); this._tbBar = null; }
    },

    /** Terrain > Scattering: a new scatter of each type, then the brush. */
    _previzScatterMenuEntries(hasTerrain) {
        const needs = hasTerrain ? "" : "Add a terrain first: a scatter grows on one.";
        const out = SCATTER_TYPES.map((type) => ({
            label: SCATTER_LABELS[type], disabled: !hasTerrain, title: needs,
            run: () => this.previzAddWorldItem("scatter", type),
        }));
        const target = this.previzScatterTarget();
        const view = this._model3d;
        const painting = !!(view && view.scatterPainting && view.scatterPainting());
        const why = target ? "" : "Select a scatter (or have just one in the scene).";
        out.push("-",
            { label: tick(painting, "Paint scatter"), disabled: !painting && !target,
              title: painting ? "Stop painting (Esc)"
                  : (why || "Paint where it grows: left drag paints, Ctrl+drag erases, [ ] brush size, Esc stops"),
              run: () => (painting ? this.previzScatterPaintStop() : this.previzScatterPaintStart()) },
            { label: "Clear scatter paint", disabled: !target || !scatterSettings(target).paint,
              title: target ? "Grow anywhere again, as before it was painted" : why,
              run: () => this.previzScatterPaintClear() });
        return out;
    },

    /** The scatter the brush is for: the selected one, a selected terrain's only one, or the scene's only one. */
    previzScatterTarget() {
        const scene = this.previzScene();
        if (!scene) return null;
        const sel = S.itemById(scene, this._previzSelection);
        if (sel && sel.kind === "scatter") return sel;
        const scatters = scene.items.filter((i) => i.kind === "scatter");
        if (sel && sel.kind === "terrain") {
            const on = scatters.filter((i) => scatterSettings(i).target === sel.id);
            if (on.length === 1) return on[0];
        }
        return scatters.length === 1 ? scatters[0] : null;
    },

    previzScatterPaintStart(id = null) {
        const scene = this.previzScene();
        const item = id ? scene && S.itemById(scene, id) : this.previzScatterTarget();
        if (!item || item.kind !== "scatter") { this._worldStatus("Select a scatter to paint."); return false; }
        const view = this._modelView();
        const err = view.scatterPaintBegin(item.id);
        if (err) { this._worldStatus(err); return false; }
        this._spTab = this.activeTab;
        this._previzScatterBar(item);
        this._worldStatus(scatterSettings(item).paint ? "" : "Painting: the scatter now grows only where you paint.", 4000);
        return true;
    },

    previzScatterPaintStop() {
        const view = this._model3d;
        if (view && view.scatterPaintEnd) view.scatterPaintEnd();
    },

    /** The paint off: the scatter grows anywhere again. */
    previzScatterPaintClear(id = null) {
        const scene = this.previzScene();
        const item = id ? scene && S.itemById(scene, id) : this.previzScatterTarget();
        if (!item || item.kind !== "scatter" || !scatterSettings(item).paint) return;
        this.previzSnapshot(`clear ${item.name} paint`);
        item.scatter = { ...scatterSettings(item), paint: null };
        this.previzChanged({ reload: true });
    },

    /**
     * A stroke's paint into the scene. `first` (the press) takes the undo step;
     * `live` ones rebuild the scatter without saving; the one at let go saves.
     */
    previzScatterPaintWrite(id, paint, live, first) {
        const scene = this.previzScene();
        const item = scene && S.itemById(scene, id);
        if (!item || item.kind !== "scatter") return;
        if (first) this.previzSnapshot(`paint ${item.name}`);
        item.scatter = { ...scatterSettings(item), paint };
        if (live) this._worldLiveReload();
        else this.previzChanged({ reload: true });
    },

    /** From previzChanged while the brush is on: another tab, an undo, the scatter gone. */
    _previzScatterPaintCheck() {
        const view = this._model3d;
        if (!view || !view.scatterPainting()) return;
        const sp = view._sp;
        const scene = this.previzScene();
        const item = scene && S.itemById(scene, sp.id);
        if (this.activeTab !== this._spTab || !item) { view.scatterPaintEnd(); return; }
        view.scatterPaintReload(item);
    },

    // ── The brush bar ────────────────────────────────────────────────────────

    _previzScatterBar(item) {
        this._previzScatterBarDrop();
        const view = this._modelView();
        const doc = view.stage.ownerDocument;
        const bar = doc.createElement("div");
        bar.className = "model-spaint-bar";
        const el = (tag, cls, text) => Object.assign(doc.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});
        bar.append(el("span", "spb-title", `Paint ${item.name}`));
        const b = view.scatterBrush();
        const mode = el("div", "spb-mode");
        const paintBtn = el("button", "spb-btn", "Paint");
        const eraseBtn = el("button", "spb-btn", "Erase");
        paintBtn.title = "Left drag paints";
        eraseBtn.title = "Left drag erases (Ctrl+drag does the other)";
        paintBtn.onclick = () => view.scatterBrushSet({ erase: false });
        eraseBtn.onclick = () => view.scatterBrushSet({ erase: true });
        mode.append(paintBtn, eraseBtn);
        bar.append(mode);
        const slider = (label, key, min, max, step, title) => {
            const wrap = el("label", "spb-field");
            wrap.title = title;
            wrap.append(el("span", "", label));
            const input = el("input", "spb-num");
            Object.assign(input, { type: "number", min, max, step });
            input.dataset.key = key;
            input.addEventListener("change", () => view.scatterBrushSet({ [key]: parseFloat(input.value) }));
            input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") input.blur(); });
            wrap.append(input);
            bar.append(wrap);
            return input;
        };
        slider("Size", "radius", 0.05, 500, 0.5, "Brush radius in metres ([ and ] change it)");
        slider("Strength", "strength", 0.01, 1, 0.05, "How far one dab goes toward full (or empty)");
        slider("Hardness", "hardness", 0, 0.99, 0.05, "Share of the brush at full strength before it fades");
        const clear = el("button", "spb-btn", "Clear");
        clear.title = "Take the paint off: the scatter grows anywhere again";
        clear.onclick = () => { this.previzScatterPaintStop(); this.previzScatterPaintClear(item.id); };
        const done = el("button", "spb-btn spb-done", "Done");
        done.title = "Stop painting (Esc)";
        done.onclick = () => this.previzScatterPaintStop();
        bar.append(clear, done);
        // Presses on the bar are the bar's, not the view's.
        for (const t of ["pointerdown", "wheel", "contextmenu"]) bar.addEventListener(t, (e) => e.stopPropagation());
        view.stage.append(bar);
        this._spBar = { bar, paintBtn, eraseBtn };
        this._previzScatterBarSync(b);
    },

    _previzScatterBarSync(b) {
        const ui = this._spBar;
        if (!ui) return;
        ui.paintBtn.classList.toggle("on", !b.erase);
        ui.eraseBtn.classList.toggle("on", !!b.erase);
        for (const input of ui.bar.querySelectorAll("input[data-key]")) {
            if (input.ownerDocument.activeElement === input) continue;
            input.value = String(Math.round(b[input.dataset.key] * 100) / 100);
        }
    },

    _previzScatterBarDrop() {
        if (this._spBar) { this._spBar.bar.remove(); this._spBar = null; }
    },
};
