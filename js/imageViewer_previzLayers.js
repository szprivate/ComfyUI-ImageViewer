// imageViewer_previzLayers.js
// The 3D space's Layers panel (display layers, selection sets, references)
// and its Character Picker, as two dock panels beside the Outliner. The data
// and its rules are imageViewer_sceneLayers.js; the drawing of a hidden,
// template or reference layer is imageViewer_model3d.js (_syncTemplates,
// _pick). Clean-room: written for this viewer.
//
// Both panels come in instances (Sebastian 2026-11-23): the drawing of each lives in
// imageViewer_previzLayersInstance.js, one closure per panel with its own tab, layer/character choice and view
// mode. This mixin keeps the FIRST of each — its state on the viewer as it always was (every older caller of
// this._plTab / this._pkChar / this._plUI reads and writes it still) — and registers the makers the dock calls
// for every further one ("layers3d@2", "picker@2", ...). The scene and the selection are shared; the previz*
// methods below act on them and stay here. _plRender / _pkRender refresh the first panel and fan out to every
// instance of the kind that is up and in front.
//
// Layers panel, three tabs:
//   Display     Maya's display layers: V shows / hides, the second button
//               goes normal -> T (template: a wire, not pickable, not
//               rendered) -> R (reference: drawn, not pickable); a swatch
//               for the colour. New layer takes the selection.
//   Sets        remembered selections. A click selects the set, Shift adds.
//   References  scene files brought in under a namespace. Each one follows
//               the newest version of its file (or stays pinned); a tab that
//               comes up checks them, and "Check for updates" does it now.
//               What the shot changed on a referenced item (its channels,
//               keys, visibility, parent) is kept across a reload.
//
// Picker: a character's controls as buttons, laid out from where they sit at
// rest, front or side, with the character's selection sets below. Click
// selects, Shift / Ctrl adds or takes out, a drag on the background draws a
// box round the buttons to select.
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import * as L from "./imageViewer_sceneLayers.js";
import { controlsOf } from "./imageViewer_rigData.js";
import { notice, openFilePicker } from "./imageViewer_exportUI.js";
import { createLayersInstance, createPickerInstance } from "./imageViewer_previzLayersInstance.js";

// How often a tab that comes up may look at its references' files again.
const CHECK_EVERY_MS = 15000;

export const PrevizLayersMixin = {

    // ── Selection, from a list of ids ────────────────────────────────────────

    /** Select exactly these items (or add them, with `add`). The last is the primary. */
    previzSelectIds(ids, { add = false } = {}) {
        const scene = this.previzScene();
        if (!scene) return;
        const list = (ids || []).filter((id) => S.itemById(scene, id));
        const keep = add ? this.previzSelectedIds() : [];
        const all = [...new Set([...keep, ...list])];
        this._previzAlso = new Set(all.slice(0, -1));
        this._previzSelection = all.length ? all[all.length - 1] : null;
        if (this._model3d) {
            this._model3d.select(this._previzSelection);
            this._model3d.setAlsoSelected([...this._previzAlso]);
        }
        this._previzRenderPanel();
        this._previzRenderTicks();
        this.previzRefreshCurves();
    },

    // ── Display layers ───────────────────────────────────────────────────────

    previzNewDisplayLayer(ids = null, name = null) {
        const scene = this.previzScene();
        if (!scene) return null;
        this.previzSnapshot("new display layer");
        const layer = L.addDisplayLayer(scene, name || `layer${L.displayLayers(scene).length + 1}`,
                                        ids || this.previzSelectedIds());
        this._plLayerSel = layer.id;
        this.previzChanged();
        return layer;
    },

    previzAddToLayer(layerId, ids = null) {
        const scene = this.previzScene();
        const layer = L.layerById(scene, layerId);
        if (!layer) return 0;
        const list = ids || this.previzSelectedIds();
        if (!list.length) return 0;
        this.previzSnapshot(`add to ${layer.name}`);
        const n = L.addToLayer(scene, layerId, list);
        this.previzChanged();
        return n;
    },

    previzRemoveFromLayers(ids = null) {
        const scene = this.previzScene();
        const list = ids || this.previzSelectedIds();
        if (!scene || !list.length || !list.some((id) => L.layerOf(scene, id))) return 0;
        this.previzSnapshot("remove from layers");
        const n = L.removeFromLayers(scene, list);
        this.previzChanged();
        return n;
    },

    /** Change a layer: { visible, mode, color, name }. One undo step. */
    previzSetLayer(layerId, patch = {}) {
        const scene = this.previzScene();
        const layer = L.layerById(scene, layerId);
        if (!layer) return false;
        this.previzSnapshot(`change ${layer.name}`);
        if ("visible" in patch) layer.visible = !!patch.visible;
        if ("mode" in patch && L.LAYER_MODES.includes(patch.mode)) layer.mode = patch.mode;
        if ("color" in patch) layer.color = /^#[0-9a-f]{6}$/i.test(patch.color || "") ? patch.color.toLowerCase() : null;
        if ("name" in patch) L.renameLayer(scene, layerId, patch.name);
        // Something no longer pickable stays selected only if it is in the outliner's hands.
        this.previzChanged();
        return true;
    },

    previzDeleteLayer(layerId) {
        const scene = this.previzScene();
        const layer = L.layerById(scene, layerId);
        if (!layer) return false;
        this.previzSnapshot(`delete layer ${layer.name}`);
        L.deleteDisplayLayer(scene, layerId);
        if (this._plLayerSel === layerId) this._plLayerSel = null;
        this.previzChanged();
        return true;
    },

    previzMoveLayer(layerId, by) {
        const scene = this.previzScene();
        if (!L.layerById(scene, layerId)) return false;
        this.previzSnapshot("move layer");
        const ok = L.moveLayer(scene, layerId, by);
        this.previzChanged();
        return ok;
    },

    previzSelectLayer(layerId, { add = false } = {}) {
        const layer = L.layerById(this.previzScene(), layerId);
        if (layer) this.previzSelectIds(layer.members, { add });
    },

    // ── Selection sets ───────────────────────────────────────────────────────

    previzNewSelectionSet(ids = null, name = null) {
        const scene = this.previzScene();
        const list = ids || this.previzSelectedIds();
        if (!scene || !list.length) {
            notice("info", "Nothing selected", "Select what the set should hold first.");
            return null;
        }
        this.previzSnapshot("new selection set");
        const set = L.addSelectionSet(scene, name || `set${L.selectionSets(scene).length + 1}`, list);
        this.previzChanged();
        return set;
    },

    previzAddToSet(setId, ids = null) {
        const scene = this.previzScene();
        const set = L.setById(scene, setId);
        if (!set) return 0;
        this.previzSnapshot(`add to ${set.name}`);
        const n = L.addToSet(scene, setId, ids || this.previzSelectedIds());
        this.previzChanged();
        return n;
    },

    previzRemoveFromSet(setId, ids = null) {
        const scene = this.previzScene();
        const set = L.setById(scene, setId);
        if (!set) return 0;
        this.previzSnapshot(`remove from ${set.name}`);
        const n = L.removeFromSet(scene, setId, ids || this.previzSelectedIds());
        this.previzChanged();
        return n;
    },

    previzRenameSet(setId, name) {
        const scene = this.previzScene();
        if (!L.setById(scene, setId)) return null;
        this.previzSnapshot("rename set");
        const got = L.renameSet(scene, setId, name);
        this.previzChanged();
        return got;
    },

    previzDeleteSet(setId) {
        const scene = this.previzScene();
        const set = L.setById(scene, setId);
        if (!set) return false;
        this.previzSnapshot(`delete set ${set.name}`);
        L.deleteSelectionSet(scene, setId);
        this.previzChanged();
        return true;
    },

    previzSelectSet(setId, { add = false } = {}) {
        const set = L.setById(this.previzScene(), setId);
        if (set) this.previzSelectIds(set.members, { add });
    },

    // ── References ───────────────────────────────────────────────────────────

    /** Read a reference's file: its newest version when it follows the latest. */
    async _plFetchRef(ref) {
        const q = `path=${encodeURIComponent(ref.path)}&follow=${ref.follow === "pinned" ? "pinned" : "latest"}`;
        const res = await fetch(api.apiURL(`/imageviewer/scene_ref?${q}`));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `the server said ${res.status}`);
        return data;
    },

    _plApplyRef(scene, ref, data) {
        const file = S.parseScene(data.scene);
        // A reference of a file that holds this shot's own references comes in flat.
        const res = L.mergeReference(scene, ref, file);
        ref.path = data.path || ref.path;
        ref.version = data.version ?? L.versionOf(ref.path);
        ref.mtime = data.mtime ?? null;
        return res;
    },

    /** Bring a scene file in as a reference — a character for this shot, say. */
    async previzReferenceScene(path, { namespace = null, follow = "latest" } = {}) {
        const scene = this.previzScene();
        if (!scene || !path) return null;
        const probe = { path, follow, namespace: "x" };
        const data = await this._plFetchRef(probe);
        if (!data.scene || !Array.isArray(data.scene.items) || !data.scene.items.length) {
            throw new Error("that file has nothing this viewer can place");
        }
        this.previzSnapshot("reference a scene");
        const ref = L.addReference(scene, data.path || path, { namespace, follow });
        const res = this._plApplyRef(scene, ref, data);
        const top = L.referencedItems(scene, ref.id).find((it) => !it.parent);
        this._previzSelection = top ? top.id : this._previzSelection;
        if (this._previzAlso) this._previzAlso.clear();
        this._plTab = "refs";
        await this.previzChanged({ reload: true });
        notice("success", `Referenced as ${ref.namespace}`,
               `${res.items} item${res.items === 1 ? "" : "s"} from ${String(ref.path).split(/[\\/]/).pop()}`);
        return ref;
    },

    /** The file picker for a scene to reference. */
    async previzReferenceDialog() {
        await openFilePicker(this.container, {
            id: "scene",
            title: "Reference scene",
            kind: "scene",
            exts: [".usda", ".usdc", ".usd", ".json"],
            go: "Reference",
            note: "Brings the scene in under a namespace and keeps it linked: a newer version saved "
                + "of that file is picked up here. Pick it again for a second copy.",
            onPick: async ([file]) => {
                try {
                    await this.previzReferenceScene(file.path);
                    return { ok: true };
                } catch (e) {
                    return { ok: false, message: `Could not reference ${file.name}: ${(e && e.message) || e}` };
                }
            },
        });
    },

    /**
     * Read a reference's file again and bring the shot up to date with it.
     * `force` merges even when the file has not changed. Answers the merge's
     * counts, or null when nothing was new.
     */
    async previzReloadReference(refId, { force = false, quiet = false } = {}) {
        const scene = this.previzScene();
        const ref = L.referenceById(scene, refId);
        if (!ref) return null;
        let data;
        try {
            data = await this._plFetchRef(ref);
        } catch (e) {
            ref._error = String((e && e.message) || e);
            if (!quiet) notice("error", `Could not read ${ref.namespace}`, ref._error);
            this._plRender(true);
            return null;
        }
        delete ref._error;
        // The scene may have changed tab while the file was on its way.
        if (this.previzScene() !== scene || !L.referenceById(scene, refId)) return null;
        const same = data.path === ref.path && data.mtime != null && data.mtime === ref.mtime;
        if (same && !force) return null;
        const was = ref.version;
        this.previzSnapshot(`update ${ref.namespace}`);
        const res = this._plApplyRef(scene, ref, data);
        if (this._previzSelection && !S.itemById(scene, this._previzSelection)) this._previzSelection = null;
        await this.previzChanged({ reload: true });
        const moved = ref.version != null && was != null && ref.version !== was ? ` (v${was} → v${ref.version})` : "";
        const lost = res.lostKeys ? ` ${res.lostKeys} keyed item${res.lostKeys === 1 ? " is" : "s are"} gone from the file.` : "";
        notice(res.lostKeys ? "warn" : "info", `${ref.namespace} updated${moved}`,
               `${res.items} items, ${res.kept} kept the shot's changes.${lost}`);
        return res;
    },

    /** Look at every reference's file; pick up the ones that changed. */
    async previzCheckReferences({ quiet = false } = {}) {
        const scene = this.previzScene();
        let n = 0;
        for (const ref of [...L.references(scene)]) {
            if (await this.previzReloadReference(ref.id, { quiet })) n++;
        }
        if (!quiet && !n) notice("info", "References are up to date", "");
        this._plRender(true);
        return n;
    },

    /** A tab coming up looks at its references, not more often than CHECK_EVERY_MS. */
    _plMaybeCheck() {
        const scene = this.previzScene();
        if (!scene || !L.references(scene).length) return;
        const at = this._plCheckedAt || (this._plCheckedAt = new WeakMap());
        const now = Date.now();
        if (now - (at.get(scene) || 0) < CHECK_EVERY_MS) return;
        at.set(scene, now);
        Promise.resolve().then(() => this.previzCheckReferences({ quiet: true })).catch(() => {});
    },

    previzRemoveReference(refId) {
        const scene = this.previzScene();
        const ref = L.referenceById(scene, refId);
        if (!ref) return 0;
        this.previzSnapshot(`remove reference ${ref.namespace}`);
        const n = L.removeReference(scene, refId);
        if (this._previzSelection && !S.itemById(scene, this._previzSelection)) this._previzSelection = null;
        if (this._previzAlso) for (const id of [...this._previzAlso]) if (!S.itemById(scene, id)) this._previzAlso.delete(id);
        this.previzChanged({ reload: true });
        return n;
    },

    previzRenameNamespace(refId, name) {
        const scene = this.previzScene();
        if (!L.referenceById(scene, refId)) return null;
        this.previzSnapshot("rename namespace");
        const ns = L.renameNamespace(scene, refId, name);
        this.previzChanged();
        return ns;
    },

    previzSetReferenceFollow(refId, follow) {
        const ref = L.referenceById(this.previzScene(), refId);
        if (!ref) return false;
        this.previzSnapshot(follow === "pinned" ? `pin ${ref.namespace}` : `${ref.namespace} follows the latest`);
        ref.follow = follow === "pinned" ? "pinned" : "latest";
        this.previzChanged();
        if (ref.follow === "latest") this.previzReloadReference(refId, { quiet: true });
        return true;
    },

    previzSelectReference(refId) {
        this.previzSelectIds(L.referencedItems(this.previzScene(), refId).map((it) => it.id));
    },

    /** Why an edit may not touch a referenced item, or "" when it may. */
    _plRefusal(ids, what) {
        const scene = this.previzScene();
        const refd = (ids || []).map((id) => S.itemById(scene, id)).filter((it) => it && it.ref);
        if (!refd.length) return "";
        const ref = L.referenceById(scene, refd[0].ref.id);
        return `${refd[0].name} comes from the reference ${ref ? ref.namespace : ""}: ${what} it in its own file `
             + "(or remove the reference in Layers › References).";
    },

    // ── The panels' showing and hiding ───────────────────────────────────────

    /** Put both panels away with the 3D tab, and remember which were open. */
    _plHide() {
        const want = this._plWant || (this._plWant = new Set());
        for (const id of ["layers3d", "picker"]) {
            if (this.isPanelDocked && this.isPanelDocked(id)) { want.add(id); this.setPanelDocked(id, false); }
        }
    },

    /** ...and bring them back with the next one. */
    _plRestore() {
        const want = this._plWant;
        if (!want) return;
        for (const id of want) this.setPanelDocked(id, true);
        want.clear();
    },

    // ── Instances: the first of each kind, and the makers for the rest ───────

    /** Register the makers the dock calls for every further Layers / Picker panel. */
    _ensureLayerMakers() {
        if (!this._dockMakers) return;
        const makers = this._dockMakers();
        if (!makers.layers3d) makers.layers3d = (v, id, saved) => {
            const doc = (v._dockRootEl && v._dockRootEl.ownerDocument)
                || (v.layers3dPanel && v.layers3dPanel.ownerDocument);
            const host = doc.createElement("div");
            host.className = "previz-panel layers3d-panel right";
            return createLayersInstance(v, host, {}, saved || { tab: v._plTab, layerSel: v._plLayerSel });
        };
        if (!makers.picker) makers.picker = (v, id, saved) => {
            const doc = (v._dockRootEl && v._dockRootEl.ownerDocument)
                || (v.pickerPanel && v.pickerPanel.ownerDocument);
            const host = doc.createElement("div");
            host.className = "previz-panel picker-panel right";
            return createPickerInstance(v, host, {}, saved || { char: v._pkChar, view: v._pkView, follow: v._pkFollow });
        };
    },

    /** Called once at startup so a restored layout's instances are known before it is read. */
    _initPrevizLayerPanels() {
        this._ensureLayerMakers();
    },

    /** The first Layers panel, its state on the viewer (st === this). Made the first time it is shown. */
    _plPrimaryInst() {
        if (!this._plInst && this.layers3dPanel) {
            this._plInst = createLayersInstance(this, this.layers3dPanel, this, null);
        }
        return this._plInst || null;
    },

    /** The first Character Picker, its state on the viewer (st === this). */
    _pkPrimaryInst() {
        if (!this._pkInst && this.pickerPanel) {
            this._pkInst = createPickerInstance(this, this.pickerPanel, this, null);
        }
        return this._pkInst || null;
    },

    // ── The Layers panel ─────────────────────────────────────────────────────

    /** Draw the first Layers panel and every instance of it that is up and in front. */
    _plRender(force = false) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        this._ensureLayerMakers();
        if (this.isPanelDocked && this.isPanelDocked("layers3d")) {
            const inst = this._plPrimaryInst();
            if (inst) inst.render(force);
        }
        if (this._dockInstancesOf) {
            for (const { inst } of this._dockInstancesOf("layers3d")) inst.render(force);
        }
    },

    // ── The Character Picker ─────────────────────────────────────────────────

    /** The rigged characters of the scene: model items with controls. */
    previzCharacters() {
        const scene = this.previzScene();
        return ((scene && scene.items) || []).filter((it) => it.kind === "model" && controlsOf(scene, it.id).length);
    },

    /** Draw the first Character Picker and every instance of it that is up and in front. */
    _pkRender(force = false) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        this._ensureLayerMakers();
        if (this.isPanelDocked && this.isPanelDocked("picker")) {
            const inst = this._pkPrimaryInst();
            if (inst) inst.render(force);
        }
        if (this._dockInstancesOf) {
            for (const { inst } of this._dockInstancesOf("picker")) inst.render(force);
        }
    },
};