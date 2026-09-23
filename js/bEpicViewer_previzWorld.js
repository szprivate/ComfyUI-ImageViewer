// bEpicViewer_previzWorld.js
// The panel's side of worlds: adding world items, their settings in the
// channel box, walking, the reference over a camera, and feedback notes.
//
// A mixin on the viewer panel like the other previz files. The 3D side is
// bEpicViewer_world3d.js; the data is bEpicViewer_worldData.js. Worlds made by
// ComfyUI-bEpicWorlds arrive as ordinary previz scenes with a `world` block;
// notes left here are posted to that pack's /bepic_worlds/feedback route, and
// kept in the scene alone when the pack isn't installed.

import { api } from "../../scripts/api.js";
import * as S from "./bEpicViewer_scene3d.js";
import {
    WORLD_KINDS, WORLD_FIELDS, SCATTER_TYPES, makeEnvironmentItem, makeTerrainItem, makeScatterItem,
    makeDepthMeshItem, getPath, setPath, referenceSettings,
} from "./bEpicViewer_worldData.js";

const SCATTER_LABELS = { pine: "Pines", tree: "Trees", bush: "Bushes", grass: "Grass", rock: "Rocks",
                         column: "Columns", model: "Model…" };

export const PrevizWorldMixin = {

    /** Whether this tab's scene is (or has) a world. */
    previzHasWorld(key = this.activeTab) {
        const scene = this.previzScene(key);
        return !!(scene && (scene.world || (scene.items || []).some((i) => WORLD_KINDS.includes(i.kind))));
    },

    /** The Add menu's World section. */
    _previzWorldMenuEntries() {
        const entries = [
            { label: "World: Environment (sky, sun, fog)", run: () => this.previzAddWorldItem("environment") },
            { label: "World: Terrain", run: () => this.previzAddWorldItem("terrain") },
        ];
        for (const type of SCATTER_TYPES) {
            entries.push({ label: `World: Scatter ${SCATTER_LABELS[type]}`, run: () => this.previzAddWorldItem("scatter", type) });
        }
        entries.push({ label: "World: Depth mesh… (picture + depth map)", run: () => this.previzAddWorldItem("depthmesh") });
        entries.push({ label: "World: Reference on camera…", run: () => this.previzSetCameraReference() });
        return entries;
    },

    _worldId(scene, base) {
        const taken = new Set((scene.items || []).map((i) => i.id));
        if (!taken.has(base)) return base;
        let n = 1;
        while (taken.has(`${base}_${n}`)) n += 1;
        return `${base}_${n}`;
    },

    _worldStatus(text, ms = 6000) {
        const view = this._modelView();
        view._setStatus(text);
        if (ms) this._viewerWindow().setTimeout(() => view._setStatus(""), ms);
    },

    previzAddWorldItem(kind, type = "tree") {
        const scene = this.previzScene();
        if (!scene) return null;
        let item;
        if (kind === "environment") {
            if (scene.items.some((i) => i.kind === "environment")) {
                this._worldStatus("This scene already has an environment — edit it in the channel box.");
                return null;
            }
            item = makeEnvironmentItem(this._worldId(scene, "env"));
        } else if (kind === "terrain") {
            item = makeTerrainItem(this._worldId(scene, "terrain"));
        } else if (kind === "scatter") {
            const terrain = scene.items.find((i) => i.kind === "terrain");
            if (!terrain) { this._worldStatus("Add a terrain first — a scatter grows on one."); return null; }
            item = makeScatterItem(this._worldId(scene, `scatter_${type}`), type, terrain.id);
            if (type === "model") {
                const picked = (this._selectedBrowserFiles ? this._selectedBrowserFiles() || [] : [])
                    .filter((f) => f && f.kind === "model");
                if (!picked.length) {
                    if (this.setPanelDocked) this.setPanelDocked("browser", true);
                    this._worldStatus("Pick a model in the File Browser, then choose Scatter Model… again.");
                    return null;
                }
                item.scatter.source.src = { path: picked[0].path, name: picked[0].name, external: true };
                item.name = `${picked[0].name} scatter`;
            }
        } else if (kind === "depthmesh") {
            const pics = this._previzPictures();
            const depth = pics.find((p) => /depth|disp/i.test(p.name || "")) || pics[1];
            const picture = pics.find((p) => p !== depth);
            if (!picture || !depth) {
                if (this.setPanelDocked) this.setPanelDocked("browser", true);
                this._worldStatus("Select two images in the File Browser — the picture and its depth map "
                                  + "(named …depth… or picked second) — then choose Depth mesh again.");
                return null;
            }
            item = makeDepthMeshItem(this._worldId(scene, "hero"), picture, depth);
            // Where a reference camera stands, a depth mesh belongs.
            const cam = scene.items.find((i) => i.id === "refcam") || scene.items.find((i) => i.kind === "camera");
            if (cam) { item.position = cam.position.slice(); item.rotation = cam.rotation.slice(); }
        } else {
            return null;
        }
        item.name = S.uniqueName(scene, item.name);
        this.previzSnapshot(`add ${item.name}`);
        scene.items.push(item);
        this._previzSelection = item.id;
        this.previzChanged({ reload: true });
        return item;
    },

    /** Put the picked picture over the selected camera's view, to match against. */
    previzSetCameraReference() {
        const scene = this.previzScene();
        const cam = scene && S.itemById(scene, this._previzSelection);
        if (!cam || cam.kind !== "camera") { this._worldStatus("Select a camera first."); return; }
        const pics = this._previzPictures();
        if (!pics.length) {
            if (this.setPanelDocked) this.setPanelDocked("browser", true);
            this._worldStatus("Pick the reference image in the File Browser, then choose this again.");
            return;
        }
        this.previzSnapshot("camera reference");
        cam.reference = { src: pics[0], opacity: 0.5, wipe: 1 };
        this.previzChanged({ reload: true });
        this._worldStatus("Look through the camera to compare — opacity and wipe are in the channel box.");
    },

    /** Set one world setting on the selection (or `id`), rebuilding what it changes. */
    previzSetWorldField(path, value, id = null) {
        const scene = this.previzScene();
        if (!scene) return;
        const items = this._previzIdList(id).map((one) => S.itemById(scene, one)).filter(Boolean);
        if (!items.length) return;
        this.previzSnapshot(`set ${path}`);
        for (const item of items) {
            const fields = WORLD_FIELDS[item.kind] || [];
            if (!fields.some((f) => f.path === path)) continue;
            setPath(item, path, value);
        }
        // The reference overlay is HTML over the view; it only needs a redraw.
        if (path.startsWith("reference.")) {
            const view = this._modelView();
            view._syncGate();
            this.previzChanged();
            return;
        }
        this.previzChanged({ reload: true });
    },

    // ── Channel box ──────────────────────────────────────────────────────────

    /** The rows for a world item's settings (or a camera's reference). */
    _cbWorldRows(ui, item, shape, doc) {
        const fields = (WORLD_FIELDS[item.kind] || []).filter((f) => !f.needs || getPath(item, f.needs));
        if (!fields.length) return;
        const title = item.kind === "camera" ? "Reference" : `${item.name}Settings`;
        const t = shape(title);
        for (const f of fields) {
            const row = doc.createElement("div");
            row.className = "cb-row";
            row.append(Object.assign(doc.createElement("span"), { className: "cb-label", textContent: f.label }));
            let input;
            if (f.type === "select" || f.type === "bool") {
                input = doc.createElement("select");
                input.className = "cb-val cb-sel";
                const opts = f.type === "bool" ? ["on", "off"] : f.options;
                for (const v of opts) input.append(Object.assign(doc.createElement("option"), { value: v, textContent: v }));
                input.onchange = () => this.previzSetWorldField(f.path, f.type === "bool" ? input.value === "on" : input.value);
            } else if (f.type === "color") {
                input = doc.createElement("input");
                input.type = "color";
                input.className = "cb-color";
                input.onchange = () => this.previzSetWorldField(f.path, input.value);
            } else {
                input = doc.createElement("input");
                input.className = "cb-val";
                input.type = "number";
                if (f.step != null) input.step = String(f.step);
                if (f.min != null) input.min = String(f.min);
                if (f.max != null) input.max = String(f.max);
                input.onchange = () => {
                    let v = Number(input.value);
                    if (!Number.isFinite(v)) { this._previzRenderChannels(); return; }
                    if (f.min != null) v = Math.max(f.min, v);
                    if (f.max != null) v = Math.min(f.max, v);
                    if (Number.isInteger(f.step)) v = Math.round(v);
                    this.previzSetWorldField(f.path, v);
                };
            }
            input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") input.blur(); });
            row.append(input);
            t.append(row);
            ui.rows.set(`world:${f.path}`, { row, input, kind: "world", field: f });
        }
        // A scatter that couldn't place everything says why.
        const note = this._modelView().itemNote(item.id);
        if (note) ui.root.append(Object.assign(doc.createElement("div"), { className: "cb-note", textContent: note }));
    },

    _cbWorldFill(r, item, focused) {
        if (focused === r.input) return;
        const v = getPath(item, r.field.path);
        if (r.field.type === "bool") r.input.value = v ? "on" : "off";
        else if (v !== undefined && v !== null) r.input.value = String(v);
    },

    // ── Walking ──────────────────────────────────────────────────────────────

    previzWalkToggle() {
        if (!this.isPrevizTab()) return false;
        const view = this._modelView();
        return view.walkToggle();
    },

    _onWalkChange(on) {
        const ui = this._previzUI;
        if (ui && ui.walkBtn) ui.walkBtn.classList.toggle("active", !!on);
        if (!on) this.previzChanged({ persist: false });
    },

    // ── Feedback ─────────────────────────────────────────────────────────────

    /** Click-to-place a note: the next click in the view says where. */
    previzFeedbackPlace() {
        if (!this.isPrevizTab()) return;
        const view = this._modelView();
        if (view.walking) { view._walkNote(); return; }
        view._placingNote = true;
        view.root.classList.add("placing-note");
        this._worldStatus("Click where the note belongs (Esc cancels).", 0);
        const win = this._viewerWindow();
        const cancel = (e) => {
            if (e.key !== "Escape") return;
            win.removeEventListener("keydown", cancel, true);
            if (view._placingNote) {
                view._placingNote = false;
                view.root.classList.remove("placing-note");
                view._setStatus("");
            }
        };
        win.addEventListener("keydown", cancel, true);
    },

    /** The view asked for a note at `point`, seen as `seen` ({camera, snapshot}). */
    async _previzFeedbackSubmit(point, seen) {
        const scene = this.previzScene();
        if (!scene) return;
        const win = this._viewerWindow();
        const view = this._modelView();
        view._setStatus("");
        const text = win.prompt("Your note about this spot (the agent reads it with the snapshot):", "");
        if (!text || !text.trim()) {
            if (view.walking) view._setStatus("Walking — click to look around · W A S D to move · Shift run · F note · Esc stop");
            return;
        }
        const world = scene.world;
        let entry = null, local = true;
        if (world && world.name) {
            try {
                const res = await api.fetchApi("/bepic_worlds/feedback", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: world.name, version: world.version, text: text.trim(), point,
                                           camera: seen && seen.camera, snapshot: seen && seen.snapshot }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.id) { entry = data; local = false; }
                else if (res.status !== 404) throw new Error(data.error || `the server answered ${res.status}`);
            } catch (e) {
                this._worldStatus(`The note could not be sent: ${(e && e.message) || e} — kept in this scene.`);
            }
        }
        if (!scene.world) scene.world = { name: "", version: 1, schema: 1, feedback: [] };
        const list = scene.world.feedback || (scene.world.feedback = []);
        list.push({ id: entry ? entry.id : `local_${Date.now().toString(36)}`, n: entry ? entry.n : list.length + 1,
                    text: text.trim(), point, local });
        view.syncFeedbackPins();
        this.previzChanged();
        this._worldStatus(local
            ? (world && world.name ? "Note kept in this scene — the bEpic Worlds pack isn't answering."
                                   : "Note kept in this scene (it isn't a bEpic world, so no agent will read it).")
            : `Note #${entry.n} sent — the agent sees it with get_feedback.`);
    },

    _previzPinClicked(pin) {
        this._worldStatus(`#${pin.n}: ${pin.text}${pin.local ? "  (kept in this scene only)" : ""}`, 8000);
    },

    /** Whether a camera item carries a reference picture. */
    previzHasReference(item) {
        return !!referenceSettings(item);
    },
};
