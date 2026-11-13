// imageViewer_previzWorld.js
// The panel's side of worlds: adding world items, their settings in the
// channel box, walking, the reference over a camera, and feedback notes.
//
// A mixin on the viewer panel like the other previz files. The 3D side is
// imageViewer_world3d.js; the data is imageViewer_worldData.js. Worlds made by
// ComfyUI-bEpicWorlds arrive as ordinary previz scenes with a `world` block;
// notes left here are posted to that pack's /bepic_worlds/feedback route, and
// kept in the scene alone when the pack isn't installed.

import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import { SPLAT_FORMATS, modelFormatOf } from "./imageViewer_model3d.js";
import {
    WORLD_KINDS, WORLD_FIELDS, SCATTER_TYPES, makeEnvironmentItem, makeTerrainItem, makeScatterItem,
    makeDepthMeshItem, makeLightItem, getPath, setPath, referenceSettings,
    worldFields, lightSettings, LIGHT_DEFAULTS, LIGHT_TYPES, LIGHT_LABELS, DEFAULT_LIGHTS,
} from "./imageViewer_worldData.js";

// A world field's name dragged one pixel moves it by this share of its step (a sun's azimuth,
// step 5, turns a degree a pixel).
const WORLD_DRAG_SHARE = 0.2;

export const PrevizWorldMixin = {

    /** Whether this tab's scene is (or has) a world. */
    previzHasWorld(key = this.activeTab) {
        const scene = this.previzScene(key);
        return !!(scene && (scene.world || (scene.items || []).some((i) => WORLD_KINDS.includes(i.kind))));
    },

    /**
     * Whether the scene holds a Gaussian splat: a splat file by its extension, or a .ply the view has loaded
     * and found to be one (the header decides, so that needs the view's stats).
     */
    previzHasSplat(key = this.activeTab) {
        const scene = this.previzScene(key);
        if (!scene || !Array.isArray(scene.items)) return false;
        const view = key === this.activeTab ? this._model3d : null;
        return scene.items.some((item) => {
            const p = item && item.kind === "model" && item.src && item.src.path;
            if (typeof p !== "string") return false;
            if (SPLAT_FORMATS.includes(modelFormatOf({ path: p }))) return true;
            const e = view && view._entries && view._entries.get(item.id);
            return !!(e && e.stats && e.stats.splats > 0);
        });
    },

    /** Whether the Walk button (Shift+J) applies: a viewer world to walk, or an Atlas world or a splat to fly through. */
    previzCanMove(key = this.activeTab) {
        return this.previzHasWorld(key) || !!(this.previzAtlasItem && this.previzAtlasItem(key)) || this.previzHasSplat(key);
    },

    /**
     * Create > World. Terrain and its scatters are the bar's own Terrain menu
     * (imageViewer_previzTerrain.js); the World kit's Lamp is gone from here, a
     * light is Create > Light (Sebastian 2026-11-13). Scenes holding a Lamp keep it.
     */
    _previzWorldMenuEntries() {
        return [
            { label: "World: Environment (sky, sun, fog)", run: () => this.previzAddWorldItem("environment") },
            { label: "World: Depth mesh… (picture + depth map)", run: () => this.previzAddWorldItem("depthmesh") },
            { label: "World: Reference on camera…", run: () => this.previzSetCameraReference() },
        ];
    },

    /** Create > Light: one row per light type. */
    _previzLightMenuEntries() {
        return LIGHT_TYPES.map((t) => ({ label: LIGHT_LABELS[t].replace(/ light$/, ""), run: () => this.previzAddLight(t) }));
    },

    /** Add a light of `type` (point, spot, directional, area, dome) and select it. */
    previzAddLight(type = "point") {
        return this.previzAddWorldItem("light", LIGHT_TYPES.includes(type) ? type : "point");
    },

    /** The scene's default (studio) lights: "auto" (off once the scene has a light of its own), "on" or "off". */
    previzDefaultLights() {
        const scene = this.previzScene();
        return scene && DEFAULT_LIGHTS.includes(scene.defaultLights) ? scene.defaultLights : "auto";
    },

    previzSetDefaultLights(mode) {
        const scene = this.previzScene();
        if (!scene || !DEFAULT_LIGHTS.includes(mode) || this.previzDefaultLights() === mode) return;
        this.previzSnapshot("default lights");
        if (mode === "auto") delete scene.defaultLights; else scene.defaultLights = mode;
        this.previzChanged();
        const view = this._modelView();
        if (view && view._worldSyncStudio) { view._worldSyncStudio(); view.requestRender(); }
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
            // On the selected terrain (or the selected scatter's), else the scene's first.
            const sel = S.itemById(scene, this._previzSelection);
            const selGround = sel && (sel.kind === "terrain" ? sel
                : sel.kind === "scatter" ? S.itemById(scene, sel.scatter && sel.scatter.target) : null);
            const terrain = selGround && selGround.kind === "terrain" ? selGround
                : scene.items.find((i) => i.kind === "terrain");
            if (!terrain) { this._worldStatus("Add a terrain first — a scatter grows on one."); return null; }
            item = makeScatterItem(this._worldId(scene, `scatter_${type}`), type, terrain.id);
            if (type === "model") {
                const picked = (this._selectedBrowserFiles ? this._selectedBrowserFiles() || [] : [])
                    .filter((f) => f && f.kind === "model");
                if (!picked.length) {
                    if (this.setPanelDocked) this.setPanelDocked("browser", true);
                    this._worldStatus("Pick a model in the File Browser, then choose Terrain > Scattering > Model… again.");
                    return null;
                }
                item.scatter.source.src = { path: picked[0].path, name: picked[0].name, external: true };
                item.name = `${picked[0].name} scatter`;
            }
        } else if (kind === "light") {
            // `type` here is the light's (Create > Light); the World kit's Lamp passes none.
            const lightType = LIGHT_TYPES.includes(type) ? type : null;
            // At its own place over the world origin (makeLightItem: a lamp 3
            // up, a point light 4 up, a spot over the front), not over the
            // orbit centre, which after Frame all is a model's middle.
            item = makeLightItem(this._worldId(scene, "light"), lightType);
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
    previzSetWorldField(path, value, id = null, { live = false } = {}) {
        const scene = this.previzScene();
        if (!scene) return;
        const items = this._previzIdList(id).map((one) => S.itemById(scene, one)).filter(Boolean);
        if (!items.length) return;
        // A drag of the row's name: one undo step for all of it (previzEndDrag at the end).
        if (live) this.previzBeginDrag(`set ${path}`);
        else if (!this._previzDragging) this.previzSnapshot(`set ${path}`);
        for (const item of items) {
            const fields = WORLD_FIELDS[item.kind] || [];
            if (!fields.some((f) => f.path === path)) continue;
            setPath(item, path, value);
            // Another type of light starts at that type's brightness: a sun's 3 lux is no bulb's 100 cd.
            if (path === "light.type" && LIGHT_DEFAULTS[value]) {
                item.light = { ...item.light, ...LIGHT_DEFAULTS[value] };
                item.light = lightSettings(item);
            }
        }
        // The reference overlay is HTML over the view; it only needs a redraw.
        if (path.startsWith("reference.")) {
            const view = this._modelView();
            view._syncGate();
            this.previzChanged(live ? { light: true, persist: false } : {});
            return;
        }
        if (live) { this._worldLiveReload(); return; }
        this.previzChanged({ reload: true });
    },

    /**
     * The view rebuilt in the middle of a drag: at most one rebuild at a time (a terrain
     * takes a while), and one more with the latest numbers when moves came in meanwhile.
     */
    _worldLiveReload() {
        if (this._worldReloading) { this._worldReloadAgain = true; return; }
        this._worldReloading = true;
        Promise.resolve(this.previzChanged({ reload: true, light: true, persist: false }))
            .catch(() => {})
            .finally(() => {
                this._worldReloading = false;
                if (this._worldReloadAgain) { this._worldReloadAgain = false; this._worldLiveReload(); }
            });
    },

    /** A typed or dragged number for a world field, held to its range and step. */
    _worldFieldNumber(f, v) {
        if (!Number.isFinite(v)) return null;
        if (f.min != null) v = Math.max(f.min, v);
        if (f.max != null) v = Math.min(f.max, v);
        if (Number.isInteger(f.step)) return Math.round(v);
        return Math.round(v * 1e4) / 1e4;
    },

    // ── Channel box ──────────────────────────────────────────────────────────

    /** The rows for a world item's settings (or a camera's reference). */
    _cbWorldRows(ui, item, shape, doc) {
        const fields = worldFields(item).filter((f) => !f.needs || getPath(item, f.needs));
        if (!fields.length) return;
        const title = item.kind === "camera" ? "Reference" : `${item.name} settings`;
        const t = shape(title);
        for (const f of fields) {
            const row = doc.createElement("div");
            row.className = "cb-row";
            const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: f.label });
            row.append(tag);
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
                    const v = this._worldFieldNumber(f, Number(input.value));
                    if (v === null) { this._previzRenderChannels(); return; }
                    this.previzSetWorldField(f.path, v);
                };
                // Its name is a slider, as a channel's is (_cbScrub).
                this._cbScrub(tag, {
                    step: (f.step || 1) * WORLD_DRAG_SHARE,
                    read: () => {
                        const now = this.previzSelectedItem() || item;
                        const v = Number(getPath(now, f.path));
                        return Number.isFinite(v) ? v : null;
                    },
                    write: (v) => {
                        const n = this._worldFieldNumber(f, v);
                        if (n !== null) this.previzSetWorldField(f.path, n, null, { live: true });
                    },
                    end: () => { this.previzEndDrag(); this.previzChanged({ reload: true }); },
                });
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

    /**
     * Start or stop moving through the world. An Atlas world or a splat is flown (no ground, see
     * imageViewer_atlasRender.js), a viewer world walked. Answers whether it is on now.
     */
    previzWalkToggle() {
        if (!this.isPrevizTab()) return false;
        const view = this._modelView();
        if (view.walking) { view.walkExit(); return false; }
        const fly = !this.previzHasWorld() && ((this.previzAtlasItem && this.previzAtlasItem()) || this.previzHasSplat());
        return !!(fly ? view.flyEnter() : view.walkEnter());
    },

    _onWalkChange(on) {
        const ui = this._previzUI;
        if (ui && ui.walkBtn) ui.walkBtn.classList.toggle("active", !!on);
        if (this._model3d && this._model3d._syncToolbar) this._model3d._syncToolbar();
        if (!on) this.previzChanged({ persist: false });
    },

    // ── Matching the reference ───────────────────────────────────────────────

    /**
     * Measure the world against its reference picture and set exposure, fill,
     * sun, fog and baked light to match (imageViewer_worldMatch.js). A world
     * from the worlds pack is saved there as a new version, with the error
     * before and after in its note; any other scene keeps the values here.
     */
    async previzMatchReference() {
        const scene = this.previzScene();
        if (!scene || this._matching) return null;
        const view = this._modelView();
        if (view.walking) view.walkExit();
        this._matching = true;
        const ui = this._previzUI;
        if (ui && ui.matchBtn) ui.matchBtn.classList.add("active");
        view._setStatus("Matching the world to its reference…");
        try {
            const res = await view.matchReference({
                onProgress: (p) => view._setStatus(`Matching the world to its reference… ${p.param}, error ${p.error.toFixed(3)}`),
            });
            const pct = res.before.total > 0 ? Math.round((1 - res.after.total / res.before.total) * 100) : 0;
            const bands = res.rows.map((r) => `${r.band} ${r.brightness_vs_picture}×`).join(", ");
            const note = `matched to the reference: error ${res.before.total} → ${res.after.total} (${pct}% less); `
                       + `brightness vs picture: ${bands}`;
            this.previzSnapshot("match reference");
            for (const op of res.ops) {
                const item = S.itemById(scene, op.id);
                if (item) setPath(item, op.path, op.value);
            }
            let saved = false;
            if (scene.world && scene.world.name) {
                try {
                    const r = await api.fetchApi("/bepic_worlds/edit", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: scene.world.name, ops: res.ops, note, open_in_viewer: true }),
                    });
                    saved = r.ok;
                } catch (e) { /* kept in the scene below */ }
            }
            await this.previzChanged({ reload: true });
            view._setStatus(`${saved ? "Saved as a new version — " : ""}${note}`);
            this._viewerWindow().setTimeout(() => view._setStatus(""), 9000);
            return { ...res, note, saved };
        } catch (e) {
            view._setStatus(`Could not match: ${(e && e.message) || e}`, true);
            this._viewerWindow().setTimeout(() => view._setStatus(""), 7000);
            return null;
        } finally {
            this._matching = false;
            if (ui && ui.matchBtn) ui.matchBtn.classList.remove("active");
        }
    },

    /** The worlds pack asked (for an agent) to match a world: open it, then match. */
    async previzMatchWorld(name) {
        const key = `world:${name}`;
        if (!this.allTabs[key]) return null;
        if (this.activeTab !== key) this.switchTab(key);
        await this.previzChanged({ reload: true, persist: false });
        return this.previzMatchReference();
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
            if (view.walking) view._setStatus("Walking — hold the left mouse button to look · W A S D to move · Shift run · F note · Esc stop");
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
