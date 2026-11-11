// imageViewer_previzLayers.js
// The 3D space's Layers panel (display layers, selection sets, references)
// and its Character Picker, as two dock panels beside the Outliner. The data
// and its rules are imageViewer_sceneLayers.js; the drawing of a hidden,
// template or reference layer is imageViewer_model3d.js (_syncTemplates,
// _pick). Clean-room: written for this viewer.
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

const TABS = [["display", "Display"], ["sets", "Sets"], ["refs", "References"]];
const MODE_TITLE = {
    normal: "Normal: drawn and picked as usual (click: template)",
    template: "Template: a wire, not pickable, left out of a render (click: reference)",
    reference: "Reference: drawn as it is, not pickable in the view (click: normal)",
};
const NEXT_MODE = { normal: "template", template: "reference", reference: "normal" };
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
            exts: [".json"],
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

    // ── The Layers panel ─────────────────────────────────────────────────────

    _plBuild() {
        const host = this.layers3dPanel;
        if (!host) return null;
        const doc = host.ownerDocument;
        host.querySelectorAll(":scope > .pl-body").forEach((n) => n.remove());
        const root = doc.createElement("div");
        root.className = "pl-body";
        const tabs = doc.createElement("div");
        tabs.className = "pl-tabs";
        const tabBtns = new Map();
        for (const [id, label] of TABS) {
            const b = doc.createElement("button");
            b.className = "pl-tab";
            b.dataset.tab = id;
            b.textContent = label;
            b.onclick = () => { this._plTab = id; this._plRender(true); };
            tabs.append(b);
            tabBtns.set(id, b);
        }
        const bar = doc.createElement("div");
        bar.className = "pl-bar";
        const list = doc.createElement("div");
        list.className = "pl-list";
        root.append(tabs, bar, list);
        host.appendChild(root);
        this._plUI = { root, bar, list, tabBtns, sig: "" };
        return this._plUI;
    },

    _plSig(scene) {
        const sel = this.previzSelectedIds().join(",");
        const tab = this._plTab || "display";
        const part = tab === "display" ? JSON.stringify(scene.displayLayers || [])
            : tab === "sets" ? JSON.stringify(scene.selectionSets || [])
            : JSON.stringify((scene.references || []).map((r) => [r.id, r.namespace, r.path, r.follow, r.version, r._error || ""]));
        return `${tab}|${sel}|${this._plLayerSel || ""}|${this._plRenaming ? this._plRenaming.id : ""}|${part}`;
    },

    /** Draw the Layers panel; cheap when nothing it shows has changed (playback comes through here). */
    _plRender(force = false) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        if (!this.isPanelDocked || !this.isPanelDocked("layers3d")) return;
        const ui = (this._plUI && this._plUI.root.isConnected) ? this._plUI : this._plBuild();
        if (!ui) return;
        const scene = this.previzScene();
        const sig = this._plSig(scene);
        if (!force && sig === ui.sig) return;
        ui.sig = sig;
        const tab = this._plTab || "display";
        for (const [id, b] of ui.tabBtns) b.classList.toggle("active", id === tab);
        ui.bar.innerHTML = "";
        ui.list.innerHTML = "";
        if (tab === "display") this._plDrawDisplay(ui, scene);
        else if (tab === "sets") this._plDrawSets(ui, scene);
        else this._plDrawRefs(ui, scene);
    },

    _plButton(doc, label, title, run, cls = "") {
        const b = doc.createElement("button");
        b.className = `previz-btn pl-btn ${cls}`.trim();
        b.textContent = label;
        b.title = title;
        b.onclick = (e) => { e.stopPropagation(); run(e); };
        return b;
    },

    _plEmpty(ui, text) {
        const d = ui.list.ownerDocument.createElement("div");
        d.className = "previz-empty";
        d.textContent = text;
        ui.list.append(d);
    },

    /** A name that turns into a field on a double-click. */
    _plName(doc, kind, id, text, commit) {
        const span = doc.createElement("span");
        span.className = "pl-name";
        if (this._plRenaming && this._plRenaming.kind === kind && this._plRenaming.id === id) {
            const input = doc.createElement("input");
            input.className = "pl-rename";
            input.value = text;
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                this._plRenaming = null;
                if (ok && input.value.trim() && input.value.trim() !== text) commit(input.value.trim());
                else this._plRender(true);
            };
            input.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === "Enter") finish(true);
                else if (e.key === "Escape") finish(false);
            };
            input.onblur = () => finish(true);
            input.onclick = (e) => e.stopPropagation();
            span.append(input);
            (doc.defaultView || window).requestAnimationFrame(() => { input.focus(); input.select(); });
            return span;
        }
        span.textContent = text;
        span.ondblclick = (e) => { e.stopPropagation(); this._plRenaming = { kind, id }; this._plRender(true); };
        return span;
    },

    _plDrawDisplay(ui, scene) {
        const doc = ui.root.ownerDocument;
        const layers = L.displayLayers(scene);
        const sel = this.previzSelectedIds();
        const target = this._plLayerSel && L.layerById(scene, this._plLayerSel);
        ui.bar.append(
            this._plButton(doc, "New layer", "A new display layer holding what is selected", () => this.previzNewDisplayLayer()),
            this._plButton(doc, "Add", target ? `Put the selection on ${target.name}` : "Pick a layer first, then add the selection to it",
                           () => target && this.previzAddToLayer(target.id), target && sel.length ? "" : "off"),
            this._plButton(doc, "Remove", "Take the selection off its layer", () => this.previzRemoveFromLayers(),
                           sel.some((id) => L.layerOf(scene, id)) ? "" : "off"),
        );
        if (!layers.length) {
            this._plEmpty(ui, "No display layers. Select objects and press New layer.");
            return;
        }
        for (const layer of layers) {
            const row = doc.createElement("div");
            row.className = "pl-row" + (layer.id === this._plLayerSel ? " selected" : "") + (layer.ref ? " ref" : "");
            row.dataset.layerId = layer.id;
            const eye = this._plButton(doc, layer.visible ? "V" : "", layer.visible ? "Shown (click to hide)" : "Hidden (click to show)",
                                       () => this.previzSetLayer(layer.id, { visible: !layer.visible }), "pl-vis" + (layer.visible ? " on" : ""));
            const mode = this._plButton(doc, L.MODE_LABEL[layer.mode], MODE_TITLE[layer.mode],
                                        () => this.previzSetLayer(layer.id, { mode: NEXT_MODE[layer.mode] }), `pl-mode ${layer.mode}`);
            const swatch = this._plButton(doc, "", "Colour (a template's wire is drawn in it)", (e) => this._plColourMenu(layer, e), "pl-swatch");
            swatch.style.background = layer.color || "transparent";
            const name = this._plName(doc, "layer", layer.id, layer.name, (v) => this.previzSetLayer(layer.id, { name: v }));
            const count = doc.createElement("span");
            count.className = "pl-count";
            count.textContent = String(layer.members.length);
            row.append(eye, mode, swatch, name, count);
            row.onclick = (e) => {
                this._plLayerSel = layer.id;
                if (e.shiftKey || e.ctrlKey || e.metaKey) this.previzSelectLayer(layer.id, { add: true });
                else this._plRender(true);
            };
            row.oncontextmenu = (e) => this._plLayerMenu(layer, e);
            ui.list.append(row);
        }
    },

    _plColourMenu(layer, e) {
        const r = e.currentTarget.getBoundingClientRect();
        const entries = L.LAYER_COLORS.map((c) => ({
            label: `${layer.color === c ? "✓ " : ""}■ ${c}`, run: () => this.previzSetLayer(layer.id, { color: c }),
        }));
        entries.push("-", { label: `${layer.color ? "" : "✓ "}No colour`, run: () => this.previzSetLayer(layer.id, { color: null }) });
        const menu = this._previzOpenMenu(entries, r.left, r.bottom + 2, e.currentTarget);
        if (menu) [...menu.querySelectorAll(".previz-menu-item")].slice(0, L.LAYER_COLORS.length)
            .forEach((b, i) => { b.style.color = L.LAYER_COLORS[i]; });
    },

    _plLayerMenu(layer, e) {
        e.preventDefault();
        e.stopPropagation();
        this._plLayerSel = layer.id;
        const sel = this.previzSelectedIds();
        this._previzOpenMenu([
            { label: "Add selected objects", disabled: !sel.length, run: () => this.previzAddToLayer(layer.id) },
            { label: "Remove selected objects", disabled: !sel.some((id) => layer.members.includes(id)),
              run: () => this.previzRemoveFromLayers(sel.filter((id) => layer.members.includes(id))) },
            { label: "Select objects", disabled: !layer.members.length, run: () => this.previzSelectLayer(layer.id) },
            "-",
            { label: "Rename", run: () => { this._plRenaming = { kind: "layer", id: layer.id }; this._plRender(true); } },
            { label: "Move up", run: () => this.previzMoveLayer(layer.id, -1) },
            { label: "Move down", run: () => this.previzMoveLayer(layer.id, 1) },
            "-",
            { label: "Delete layer", title: "The objects stay; only the layer goes", run: () => this.previzDeleteLayer(layer.id) },
        ], e.clientX, e.clientY);
    },

    _plDrawSets(ui, scene) {
        const doc = ui.root.ownerDocument;
        const sets = L.selectionSets(scene);
        const sel = this.previzSelectedIds();
        ui.bar.append(this._plButton(doc, "New set", "A selection set of what is selected",
                                     () => this.previzNewSelectionSet(), sel.length ? "" : "off"));
        if (!sets.length) {
            this._plEmpty(ui, "No selection sets. Select controls or objects and press New set.");
            return;
        }
        const now = new Set(sel);
        for (const set of sets) {
            const row = doc.createElement("div");
            const all = set.members.length && set.members.every((id) => now.has(id));
            row.className = "pl-row" + (all ? " selected" : "") + (set.ref ? " ref" : "");
            row.dataset.setId = set.id;
            const name = this._plName(doc, "set", set.id, set.name, (v) => this.previzRenameSet(set.id, v));
            const count = doc.createElement("span");
            count.className = "pl-count";
            count.textContent = String(set.members.length);
            row.append(name, count);
            row.title = "Click: select the set. Shift / Ctrl: add it to the selection. Double-click the name to rename.";
            row.onclick = (e) => this.previzSelectSet(set.id, { add: e.shiftKey || e.ctrlKey || e.metaKey });
            row.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const s = this.previzSelectedIds();
                this._previzOpenMenu([
                    { label: "Select", run: () => this.previzSelectSet(set.id) },
                    { label: "Add selected", disabled: !s.length, run: () => this.previzAddToSet(set.id) },
                    { label: "Remove selected", disabled: !s.some((id) => set.members.includes(id)), run: () => this.previzRemoveFromSet(set.id) },
                    "-",
                    { label: "Rename", run: () => { this._plRenaming = { kind: "set", id: set.id }; this._plRender(true); } },
                    { label: "Delete set", title: "The objects stay; only the set goes", run: () => this.previzDeleteSet(set.id) },
                ], e.clientX, e.clientY);
            };
            ui.list.append(row);
        }
    },

    _plDrawRefs(ui, scene) {
        const doc = ui.root.ownerDocument;
        const refs = L.references(scene);
        ui.bar.append(
            this._plButton(doc, "Reference…", "Bring a saved scene (a character, a set) in, linked to its file",
                           () => this.previzReferenceDialog()),
            this._plButton(doc, "Check for updates", "Read every reference's file again and pick up newer versions",
                           () => this.previzCheckReferences(), refs.length ? "" : "off"),
        );
        if (!refs.length) {
            this._plEmpty(ui, "No references. Save a character as a scene, then Reference… it into each shot.");
            return;
        }
        for (const ref of refs) {
            const row = doc.createElement("div");
            row.className = "pl-row pl-refrow" + (ref._error ? " failed" : "");
            row.dataset.refId = ref.id;
            const name = this._plName(doc, "ref", ref.id, ref.namespace, (v) => this.previzRenameNamespace(ref.id, v));
            const file = doc.createElement("span");
            file.className = "pl-file";
            file.textContent = String(ref.path).split(/[\\/]/).pop();
            file.title = ref._error ? `Could not be read: ${ref._error}\n${ref.path}` : ref.path;
            const follow = this._plButton(doc, ref.follow === "pinned" ? "pinned" : "latest",
                ref.follow === "pinned" ? "Stays on this version (click: follow the newest version)"
                                        : "Follows the newest version of the file (click: stay on this one)",
                () => this.previzSetReferenceFollow(ref.id, ref.follow === "pinned" ? "latest" : "pinned"),
                `pl-follow ${ref.follow}`);
            const reload = this._plButton(doc, "↻", "Reload from the file now", () => this.previzReloadReference(ref.id, { force: true }));
            row.append(name, file, follow, reload);
            row.onclick = () => this.previzSelectReference(ref.id);
            row.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._previzOpenMenu([
                    { label: "Select its objects", run: () => this.previzSelectReference(ref.id) },
                    { label: "Reload", run: () => this.previzReloadReference(ref.id, { force: true }) },
                    { label: "Rename namespace", run: () => { this._plRenaming = { kind: "ref", id: ref.id }; this._plRender(true); } },
                    { label: ref.follow === "pinned" ? "Follow the latest version" : "Pin this version",
                      run: () => this.previzSetReferenceFollow(ref.id, ref.follow === "pinned" ? "latest" : "pinned") },
                    { label: "Reference it again", title: "A second copy under a namespace of its own",
                      run: () => this.previzReferenceScene(ref.path, { follow: ref.follow }) },
                    "-",
                    { label: "Remove reference", title: "Takes out everything it brought in, with the shot's keys on it",
                      run: () => this.previzRemoveReference(ref.id) },
                ], e.clientX, e.clientY);
            };
            ui.list.append(row);
        }
    },

    // ── The Character Picker ─────────────────────────────────────────────────

    /** The rigged characters of the scene: model items with controls. */
    previzCharacters() {
        const scene = this.previzScene();
        return ((scene && scene.items) || []).filter((it) => it.kind === "model" && controlsOf(scene, it.id).length);
    },

    /** The character the picker shows: the chosen one, else the selection's, else the first. */
    _pkCharacter() {
        const scene = this.previzScene();
        const chars = this.previzCharacters();
        if (!chars.length) return null;
        const sel = this.previzSelectedItem();
        const ofSel = sel ? (sel.kind === "model" ? sel.id : sel.control ? sel.control.model : null) : null;
        if (ofSel && chars.some((c) => c.id === ofSel) && this._pkFollow !== false) this._pkChar = ofSel;
        if (!this._pkChar || !S.itemById(scene, this._pkChar)) this._pkChar = chars[0].id;
        return S.itemById(scene, this._pkChar);
    },

    _pkBuild() {
        const host = this.pickerPanel;
        if (!host) return null;
        const doc = host.ownerDocument;
        host.querySelectorAll(":scope > .pk-body").forEach((n) => n.remove());
        const root = doc.createElement("div");
        root.className = "pk-body";
        const head = doc.createElement("div");
        head.className = "pk-head";
        const charSel = doc.createElement("select");
        charSel.className = "previz-sel pk-char";
        charSel.title = "Which character";
        charSel.onchange = () => { this._pkChar = charSel.value; this._pkRender(true); };
        const front = this._plButton(doc, "Front", "Seen from the front", () => { this._pkView = "front"; this._pkRender(true); }, "pk-front");
        const side = this._plButton(doc, "Side", "Seen from its left", () => { this._pkView = "side"; this._pkRender(true); }, "pk-side");
        const all = this._plButton(doc, "All", "Select every control of the character (Shift adds)", (e) => {
            const ch = this._pkCharacter();
            if (ch) this.previzSelectIds(controlsOf(this.previzScene(), ch.id).map((c) => c.id), { add: e.shiftKey });
        }, "pk-all");
        head.append(charSel, front, side, all);
        const wrap = doc.createElement("div");
        wrap.className = "pk-wrap";
        const stage = doc.createElement("div");
        stage.className = "pk-stage";
        wrap.append(stage);
        const sets = doc.createElement("div");
        sets.className = "pk-sets";
        root.append(head, wrap, sets);
        host.appendChild(root);
        this._pkUI = { root, charSel, front, side, wrap, stage, sets, sig: "", buttons: new Map() };
        this._pkWireMarquee(this._pkUI);
        return this._pkUI;
    },

    _pkRender(force = false) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        if (!this.isPanelDocked || !this.isPanelDocked("picker")) return;
        const ui = (this._pkUI && this._pkUI.root.isConnected) ? this._pkUI : this._pkBuild();
        if (!ui) return;
        const scene = this.previzScene();
        const ch = this._pkCharacter();
        const chars = this.previzCharacters();
        const view = this._pkView || "front";
        const ctrls = ch ? controlsOf(scene, ch.id) : [];
        const shape = `${chars.map((c) => `${c.id}:${c.name}`).join(",")}|${ch ? ch.id : ""}|${view}|`
                    + `${ctrls.map((c) => c.id).join(",")}|${JSON.stringify(scene.selectionSets || [])}`;
        if (force || shape !== ui.sig) {
            ui.sig = shape;
            this._pkDraw(ui, scene, ch, chars, view, ctrls);
        }
        // The selection only lights buttons; it never rebuilds them.
        const sel = new Set(this.previzSelectedIds());
        for (const [id, b] of ui.buttons) b.classList.toggle("on", sel.has(id));
        for (const b of ui.sets.querySelectorAll(".pk-set")) {
            const set = L.setById(scene, b.dataset.setId);
            b.classList.toggle("on", !!(set && set.members.length && set.members.every((id) => sel.has(id))));
        }
    },

    _pkDraw(ui, scene, ch, chars, view, ctrls) {
        const doc = ui.root.ownerDocument;
        ui.charSel.innerHTML = "";
        for (const c of chars) {
            const o = doc.createElement("option");
            o.value = c.id;
            o.textContent = c.name;
            ui.charSel.append(o);
        }
        ui.charSel.style.display = chars.length > 1 ? "" : "none";
        if (ch) ui.charSel.value = ch.id;
        ui.front.classList.toggle("active", view === "front");
        ui.side.classList.toggle("active", view === "side");
        ui.stage.innerHTML = "";
        ui.sets.innerHTML = "";
        ui.buttons.clear();
        if (!ch) {
            ui.stage.style.aspectRatio = "";
            const d = doc.createElement("div");
            d.className = "previz-empty";
            d.textContent = "No rigged character. Rig › Add controls on a character, and its picker is here.";
            ui.stage.append(d);
            return;
        }
        const lay = L.pickerLayout(scene, ch.id, view);
        ui.stage.style.aspectRatio = String(Math.max(0.2, Math.min(5, lay.aspect)));
        const COLOR = { L: "#4aa3ff", R: "#ff5a5a", C: "#ffd24d" };
        // Big ones first, so the small ones lie on top and can be hit.
        for (const b of [...lay.buttons].sort((x, y) => y.r - x.r)) {
            const el = doc.createElement("button");
            el.className = `pk-btn ${b.type}`;
            el.dataset.id = b.id;
            el.title = b.name + (b.role ? ` (${b.role})` : "");
            el.style.left = `${b.x * 100}%`;
            el.style.top = `${b.y * 100}%`;
            el.style.width = el.style.height = `${b.r * 200}%`;
            if (b.type === "root") { el.style.width = `${b.r * 400}%`; el.style.height = `${b.r * 60}%`; }
            if (b.type === "cog") { el.style.width = `${b.r * 300}%`; el.style.height = `${b.r * 90}%`; }
            el.style.setProperty("--pk", COLOR[b.side] || b.color);
            el.onpointerdown = (e) => e.stopPropagation();
            el.onclick = (e) => {
                e.stopPropagation();
                const add = e.shiftKey || e.ctrlKey || e.metaKey;
                if (add) this.previzSelect(b.id, { add: true });
                else this.previzSelect(b.id);
            };
            ui.stage.append(el);
            ui.buttons.set(b.id, el);
        }
        const mine = new Set([ch.id, ...ctrls.map((c) => c.id)]);
        for (const set of L.setsWithin(scene, [...mine])) {
            const el = doc.createElement("button");
            el.className = "previz-btn pk-set";
            el.dataset.setId = set.id;
            el.textContent = set.name.replace(/^[^:]*:/, "");
            el.title = `${set.name}: ${set.members.length} - Shift adds`;
            el.onclick = (e) => this.previzSelectSet(set.id, { add: e.shiftKey || e.ctrlKey || e.metaKey });
            ui.sets.append(el);
        }
        const add = this._plButton(doc, "+ Set", "A selection set of what is selected, shown here as a button",
                                   () => this.previzNewSelectionSet(), "pk-newset");
        ui.sets.append(add);
    },

    /** A drag on the picker's background selects the buttons inside the box. */
    _pkWireMarquee(ui) {
        const stage = ui.stage;
        stage.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest(".pk-btn")) return;
            const doc = stage.ownerDocument;
            const r0 = stage.getBoundingClientRect();
            const box = doc.createElement("div");
            box.className = "pk-marquee";
            stage.append(box);
            const x0 = e.clientX, y0 = e.clientY;
            const add = e.shiftKey || e.ctrlKey || e.metaKey;
            const place = (x1, y1) => {
                box.style.left = `${Math.min(x0, x1) - r0.left}px`;
                box.style.top = `${Math.min(y0, y1) - r0.top}px`;
                box.style.width = `${Math.abs(x1 - x0)}px`;
                box.style.height = `${Math.abs(y1 - y0)}px`;
            };
            place(x0, y0);
            const move = (ev) => place(ev.clientX, ev.clientY);
            const up = (ev) => {
                doc.removeEventListener("pointermove", move, true);
                doc.removeEventListener("pointerup", up, true);
                const a = { l: Math.min(x0, ev.clientX), r: Math.max(x0, ev.clientX), t: Math.min(y0, ev.clientY), b: Math.max(y0, ev.clientY) };
                box.remove();
                if (a.r - a.l < 3 && a.b - a.t < 3) { if (!add) this.previzSelect(null); return; }
                const hit = [];
                for (const [id, el] of ui.buttons) {
                    const br = el.getBoundingClientRect();
                    const cx = (br.left + br.right) / 2, cy = (br.top + br.bottom) / 2;
                    if (cx >= a.l && cx <= a.r && cy >= a.t && cy <= a.b) hit.push(id);
                }
                this.previzSelectIds(hit, { add });
            };
            doc.addEventListener("pointermove", move, true);
            doc.addEventListener("pointerup", up, true);
            e.preventDefault();
        });
    },
};
