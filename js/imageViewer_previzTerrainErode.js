// imageViewer_previzTerrainErode.js
// Terrain > Erode…: the panel's side of the erosion (imageViewer_terrainErode3d.js runs it in
// the view). A box over the view with the settings, Run / Pause, Reset, Apply and Cancel. Apply
// writes the eroded heights into the terrain's sculpt (one undo step, so the scatters follow and
// Clear sculpting takes it off again), and, as asked, rock and ground into its layer paint and
// a mask into the paint of the scatters that grow on it.
//
// A mixin on the viewer panel like the other previz files.

import * as S from "./imageViewer_scene3d.js";
import { scatterSettings, terrainSettings } from "./imageViewer_worldData.js";
import { ERODE_DEFAULTS, cleanErode, erodedSculpt, erodedLayerPaint, maskToCells } from "./imageViewer_terrainErode.js";
import { encodeSculpt, sculptEmpty, decodeLayerPaint, encodeLayerPaint, LAYER_RES } from "./imageViewer_terrainSculpt.js";
import { encodePaint, PAINT_RES } from "./imageViewer_scatterPaint.js";

const STORE = "imageviewer.viewer.erode";

// The settings as the box shows them: [key, label, min, max, step, tip].
const FIELDS = [
    ["iterations", "Steps", 1, 100000, 100, "How long it runs. More steps cut deeper valleys"],
    ["rain", "Rain", 0, 1, 0.002, "Water falling on every cell each step"],
    ["evaporation", "Evaporation", 0, 10, 0.05, "How fast the water dries up: lower lets rivers run further"],
    ["capacity", "Carry", 0, 20, 0.05, "How much sediment running water can hold"],
    ["dissolve", "Wear", 0, 5, 0.01, "How fast fast water wears the ground away"],
    ["deposit", "Settle", 0, 5, 0.01, "How fast slow water lays its sediment down"],
    ["talus", "Slope angle", 1, 89, 1, "Ground steeper than this (degrees) slides down"],
    ["thermal", "Slide", 0, 5, 0.05, "How fast steep ground slides"],
];

export const ERODE_MODE_LABELS = { both: "Water and sliding", hydraulic: "Water only", thermal: "Sliding only" };

// What a scatter can follow from the erosion: a mask of erodeMasks, or "" (left as it is).
export const SCATTER_FOLLOW = [
    ["", "Leave as it is"], ["wetness", "Wet ground"], ["dry", "Dry ground"],
    ["deposit", "Laid-down ground"], ["erosion", "Worn ground"], ["flow", "Where water ran"],
];

const store = {
    read() { try { return JSON.parse(localStorage.getItem(STORE) || "null") || {}; } catch (_) { return {}; } },
    write(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (_) { /* private window */ } },
};

export const PrevizTerrainErodeMixin = {

    /** Terrain > Erode…: the box for the terrain the brushes are for. */
    previzTerrainErodeOpen(id = null) {
        const scene = this.previzScene();
        const item = id ? scene && S.itemById(scene, id) : this.previzTerrainTarget();
        if (!item || item.kind !== "terrain") { this._worldStatus("Select a terrain to erode."); return false; }
        if (!(terrainSettings(item).height > 0)) {
            this._worldStatus("This terrain is flat: set its Height above 0 to erode it."); return false;
        }
        const kept = store.read();
        const view = this._modelView();
        const err = view.terrainErodeBegin(item.id, cleanErode({ ...ERODE_DEFAULTS, ...(kept.opts || {}) }));
        if (err) { this._worldStatus(err); return false; }
        this._teTab = this.activeTab;
        this._erodeApply = { layers: kept.layers !== false, follow: {} };
        this._previzErodeBox(item);
        return true;
    },

    previzTerrainErodeRun(on = true) {
        const view = this._model3d;
        if (view && view.terrainEroding()) view.terrainErodeRun(on);
    },

    previzTerrainErodeReset() {
        const view = this._model3d;
        if (view && view.terrainEroding()) view.terrainErodeReset();
    },

    /** Change settings (also while it runs). */
    previzTerrainErodeSet(opts) {
        const view = this._model3d;
        if (!view || !view.terrainEroding()) return;
        view.terrainErodeSet(opts);
        const st = view.terrainErodeState();
        store.write({ ...store.read(), opts: st.opts });
    },

    previzTerrainErodeCancel() {
        const view = this._model3d;
        if (view && view.terrainEroding()) view.terrainErodeEnd(false);
    },

    /**
     * The eroded terrain into the scene, one undo step: its heights as sculpt, and with
     * `layers` rock and ground in its layer paint, with `follow` ({scatterId: mask}) each
     * scatter's paint from that mask. Answers an error text, or "".
     */
    previzTerrainErodeApply({ layers, follow } = {}) {
        const view = this._model3d;
        if (!view || !view.terrainEroding()) return "Nothing is eroding.";
        const want = this._erodeApply || {};
        layers = layers ?? want.layers ?? true;
        follow = follow ?? want.follow ?? {};
        const st = view.terrainErodeState();
        const scene = this.previzScene();
        const item = scene && S.itemById(scene, st.id);
        if (!item) { view.terrainErodeEnd(false); return "The terrain is gone."; }
        if (!st.done) return "Run it first: nothing has eroded yet.";
        const out = view.terrainErodeEnd(true);
        if (!out || !out.base || out.base.length !== out.n * out.n) return "The terrain changed while it ran.";
        const { grid, unit } = erodedSculpt(out.heights, out.base, out.height, out.n);
        this.previzSnapshot(`erode ${item.name}`);
        const t = terrainSettings(item);
        const patch = { sculpt: sculptEmpty(grid, unit) ? null : encodeSculpt(grid, unit) };
        if (layers) {
            const prev = t.layerPaint ? decodeLayerPaint(t.layerPaint) : null;
            const res = prev ? prev.res : LAYER_RES;
            patch.layerPaint = encodeLayerPaint({ res, cells: erodedLayerPaint(out.masks, out.n, res, 1, prev && prev.cells) });
        }
        item.terrain = { ...(item.terrain || {}), ...patch };
        for (const [sid, kind] of Object.entries(follow || {})) {
            const s = S.itemById(scene, sid);
            const mask = kind && out.masks[kind];
            if (!s || s.kind !== "scatter" || !mask || scatterSettings(s).target !== item.id) continue;
            s.scatter = { ...scatterSettings(s), paint: encodePaint({ res: PAINT_RES, cells: maskToCells(mask, out.n, PAINT_RES) }) };
        }
        this.previzChanged({ reload: true });
        this._worldStatus(`Eroded ${item.name}: ${out.steps} steps. Clear sculpting takes it off again.`, 5000);
        return "";
    },

    /** From previzChanged while it erodes: another tab, an undo, the terrain gone or rebuilt. */
    _previzTerrainErodeCheck() {
        const view = this._model3d;
        if (!view || !view.terrainEroding()) return;
        const st = view.terrainErodeState();
        const scene = this.previzScene();
        const item = scene && S.itemById(scene, st.id);
        if (this.activeTab !== this._teTab || !item || !view.terrainErodeFor(st.id)) view.terrainErodeEnd(false);
    },

    // ── The box ──────────────────────────────────────────────────────────────

    _previzErodeBox(item) {
        this._previzErodeBoxDrop();
        const view = this._modelView();
        const doc = view.stage.ownerDocument;
        const el = (tag, cls, text) => Object.assign(doc.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});
        const box = el("div", "model-erode-box");
        box.append(el("div", "meb-title", `Erode ${item.name}`));
        const st = view.terrainErodeState();
        const grid = el("div", "meb-grid");
        const keyStop = (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); };
        const row = (label, input, tip) => {
            const l = el("label", "meb-label", label);
            l.title = tip;
            input.title = tip;
            grid.append(l, input);
        };
        const mode = el("select", "meb-in");
        mode.dataset.key = "mode";
        for (const [k, v] of Object.entries(ERODE_MODE_LABELS)) mode.append(Object.assign(doc.createElement("option"), { value: k, textContent: v }));
        mode.addEventListener("change", () => this.previzTerrainErodeSet({ mode: mode.value }));
        mode.addEventListener("keydown", keyStop);
        row("Erode by", mode, "Water carving valleys, steep ground sliding, or both");
        for (const [key, label, min, max, step, tip] of FIELDS) {
            const input = el("input", "meb-in");
            Object.assign(input, { type: "number", min, max, step });
            input.dataset.key = key;
            input.addEventListener("change", () => this.previzTerrainErodeSet({ [key]: parseFloat(input.value) }));
            input.addEventListener("keydown", keyStop);
            row(label, input, tip);
        }
        box.append(grid);

        // What Apply also does.
        const opts = el("div", "meb-apply");
        const layersBox = el("label", "meb-check");
        const layersIn = el("input");
        layersIn.type = "checkbox";
        layersIn.checked = this._erodeApply.layers;
        layersIn.className = "meb-layers";
        layersIn.addEventListener("change", () => {
            this._erodeApply.layers = layersIn.checked;
            store.write({ ...store.read(), layers: layersIn.checked });
        });
        layersBox.append(layersIn, el("span", "", "Paint rock where worn, ground where laid down"));
        opts.append(layersBox);
        const scene = this.previzScene();
        const scatters = scene.items.filter((i) => i.kind === "scatter" && scatterSettings(i).target === item.id);
        for (const s of scatters) {
            const wrap = el("label", "meb-follow");
            wrap.append(el("span", "", `${s.name} grows on`));
            const sel = el("select", "meb-in");
            sel.dataset.scatter = s.id;
            for (const [k, v] of SCATTER_FOLLOW) sel.append(Object.assign(doc.createElement("option"), { value: k, textContent: v }));
            sel.addEventListener("change", () => { this._erodeApply.follow[s.id] = sel.value; });
            sel.addEventListener("keydown", keyStop);
            wrap.title = "On Apply, the scatter's paint becomes this part of the terrain";
            wrap.append(sel);
            opts.append(wrap);
        }
        box.append(opts);

        const progress = el("div", "meb-progress");
        const bar = el("div", "meb-bar");
        const fill = el("div", "meb-fill");
        bar.append(fill);
        const text = el("div", "meb-text");
        progress.append(bar, text);
        box.append(progress);

        const btns = el("div", "meb-btns");
        const run = el("button", "spb-btn meb-run", "Run");
        run.onclick = () => {
            const s = view.terrainErodeState();
            if (s) this.previzTerrainErodeRun(!s.running);
        };
        const reset = el("button", "spb-btn meb-reset", "Reset");
        reset.title = "Back to the terrain as it was, to run again";
        reset.onclick = () => this.previzTerrainErodeReset();
        const apply = el("button", "spb-btn meb-ok", "Apply");
        apply.title = "Keep it: into the terrain's sculpting, one undo step";
        apply.onclick = () => { const err = this.previzTerrainErodeApply(); if (err) this._worldStatus(err); };
        const cancel = el("button", "spb-btn meb-cancel", "Cancel");
        cancel.title = "Put the terrain back and close";
        cancel.onclick = () => this.previzTerrainErodeCancel();
        btns.append(run, reset, apply, cancel);
        box.append(btns);

        for (const t of ["pointerdown", "wheel", "contextmenu", "keydown"]) box.addEventListener(t, (e) => e.stopPropagation());
        view.stage.append(box);
        this._teBox = { box, run, apply, fill, text };
        for (const input of box.querySelectorAll("[data-key]")) input.value = String(st.opts[input.dataset.key]);
        this._previzErodeSync(st);
    },

    /** The view's report: {done, of, running, gpu}, or null when it ended. */
    _previzErodeSync(s) {
        if (!s) { this._previzErodeBoxDrop(); return; }
        const ui = this._teBox;
        if (!ui) return;
        ui.run.textContent = s.running ? "Pause" : (s.done >= s.of ? "Done" : (s.done ? "Go on" : "Run"));
        ui.run.disabled = !s.running && s.done >= s.of;
        ui.run.classList.toggle("on", s.running);
        ui.apply.disabled = !s.done;
        ui.fill.style.width = `${Math.min(100, (s.done / Math.max(1, s.of)) * 100)}%`;
        ui.text.textContent = `${s.done} / ${s.of} steps · ${s.gpu ? "on the GPU" : "on the CPU (slower)"}`;
    },

    _previzErodeBoxDrop() {
        if (this._teBox) { this._teBox.box.remove(); this._teBox = null; }
    },
};
