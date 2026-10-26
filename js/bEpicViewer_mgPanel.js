// bEpicViewer_mgPanel.js
// Motion: the editor for an agent's motion-graphics scene (*.mgscene.json) as a TAB of the viewer.
//
// A scene is opened like any other media: it gets a tab ("motion:<scene path>", no media frames)
// and the preview + transport fill the MAIN CANVAS. Its other parts are normal dock panels -
// Layers, Properties (with the curve) and Timeline - that follow the tab on screen: they come up
// with a motion tab and go away with it, and can be dragged, tabbed, resized and closed like any
// other (bEpicViewer_mixinDock.js). With no scene there is no empty panel: the Motion button
// opens a tab that says "Open a motion scene" and has the file picker behind its Open button.
//
// The editor itself is bEpicViewer_mgEditor.js (it does not know about the viewer); this mixin is
// the glue: opening a scene from a file, from a poster PNG or from the film beside it, saving it,
// resolving its assets, the Render button (relayed to agentY, see mg_render.py) and the "agent
// opened a scene" message (ComfyUI's "bepic.mg.open", from POST /bepic/push with a .mgscene.json).
import { api } from "../../scripts/api.js";
import { createMgEditor } from "./bEpicViewer_mgEditor.js";
import { notice, openFilePicker } from "./bEpicViewer_exportUI.js";
import { mgRefQuery, mgMayHaveScene, mgIsSceneFile } from "./bEpicViewer_mgRefs.js";

export const MG_PREFIX = "motion:";
/** The dock panels of a motion tab, and the editor part each one holds. */
export const MG_PANELS = { motionLayers: "layers", motionProps: "props", motionTimeline: "timeline" };

const dirOf = (p) => String(p || "").replace(/[\\/][^\\/]*$/, "");
const baseOf = (p) => String(p || "").split(/[\\/]/).pop();
const isUrl = (s) => /^(https?:|data:|blob:)/i.test(s);
export { mgRefQuery, mgMayHaveScene };

export const MgPanelMixin = {

    _mgState() {
        if (!this._mg) this._mg = { tabs: {}, want: {}, polling: 0, host: null };
        return this._mg;
    },

    isMotionTab(key = this.activeTab) {
        return typeof key === "string" && key.startsWith(MG_PREFIX);
    },

    // ── opening ──────────────────────────────────────────────────────────────

    /**
     * Open a scene in a motion tab (and show the viewer). `ref` is a path - of a scene file, of a poster
     * PNG that carries one, of the rendered film beside one - or the {filename, subfolder, type} a
     * history item is known by.
     */
    async mgOpenFile(ref) {
        const st = this._mgState();
        let data;
        try {
            const res = await api.fetchApi(`/bepic/mgscene?${mgRefQuery(ref)}`);
            data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        } catch (e) {
            notice("error", "Cannot open the scene", String(e.message || e));
            return false;
        }
        const key = MG_PREFIX + data.path;
        const known = !!this.allTabs[key] && !!st.tabs[key];
        let rec = st.tabs[key];
        if (known) {
            if (rec.editor && rec.editor.isDirty()) {
                notice("info", "The scene is open with changes", "Save or close its tab to read the file again.");
            } else if (rec.editor) rec.editor.load(data.scene, data.path);
            else rec.pending = data.scene;
        } else {
            rec = st.tabs[key] = { path: data.path, pending: data.scene, el: null, editor: null };
            this._mgMakeTab(key, baseOf(data.path).replace(/\.mgscene\.json$/i, ""));
        }
        if (this.requestPanelOpen) this.requestPanelOpen();
        this.switchTab(key);
        // The empty "Motion" tab was only a way to ask for a scene.
        if (this.allTabs[MG_PREFIX]) this.closeTab(MG_PREFIX);
        return true;
    },

    /** The Motion button: the tab that is open, else a tab that asks for a scene. */
    mgBarOpen() {
        const open = (this.tabOrder || []).find((k) => this.isMotionTab(k) && this.allTabs[k]);
        if (open) { this.switchTab(open); return; }
        this._mgState().tabs[MG_PREFIX] = { path: "", el: null, editor: null };
        this._mgMakeTab(MG_PREFIX, "Motion");
        if (this.requestPanelOpen) this.requestPanelOpen();
        this.switchTab(MG_PREFIX);
    },

    _mgMakeTab(key, label) {
        this.allTabs[key] = [];
        this.tabLabels[key] = "\u{1F3AC} " + label;
        if (!this.tabOrder.includes(key)) this.tabOrder.push(key);
        this._rebuildTabBar(null);
    },

    /** The file picker over the allowed folders: pick a *.mgscene.json (or a poster / film that has one). */
    async mgPickScene() {
        await openFilePicker(this.container, {
            id: "mgscene",
            title: "Open a motion scene",
            kind: "scene",
            exts: [".json", ".png", ".mp4", ".mov", ".webm"],
            go: "Open",
            note: "A *.mgscene.json file, or a rendered video / poster PNG that has its scene beside it.",
            onPick: async ([file]) => {
                if (!file) return { ok: false, message: "Pick a file." };
                if (!mgMayHaveScene(file.path || file.name)) return { ok: false, message: `${file.name} is not a motion scene.` };
                const ok = await this.mgOpenFile(file.path);
                return ok ? { ok: true } : { ok: false, message: `No motion scene belongs to ${file.name}.` };
            },
        });
    },

    /** Does a scene belong to this file (a poster PNG, a film, or a scene file itself)? Asked of the server. */
    async _mgHasScene(ref) {
        if (!mgMayHaveScene(ref)) return false;
        if (mgIsSceneFile(ref)) return true;
        try {
            const res = await api.fetchApi(`/bepic/mgscene?${mgRefQuery(ref)}&probe=1`);
            const data = await res.json().catch(() => ({}));
            return !!(res.ok && data.has_scene);
        } catch (_) { return false; }
    },
    _mgPngHasScene(path) { return this._mgHasScene(path); },

    /** Add "Edit in Motion" to a context menu, once the server says a scene belongs to the file. */
    mgAddEditItem(menu, ref, before) {
        if (!menu || !mgMayHaveScene(ref)) return;
        this._mgHasScene(ref).then((yes) => {
            if (!yes || !menu.isConnected || menu.querySelector(".mg-edit-item")) return;
            const edit = menu.ownerDocument.createElement("div");
            edit.className = "thumb-ctx-item mg-edit-item";
            edit.textContent = "\u{1F3AC} Edit in Motion";
            edit.onclick = (ev) => { ev.stopPropagation(); menu.remove(); this.mgOpenFile(ref); };
            if (before && before.parentNode === menu) menu.insertBefore(edit, before); else menu.appendChild(edit);
        });
    },

    // ── the tab on screen ────────────────────────────────────────────────────

    /** The layer in the viewport that every motion tab's editor sits in (made once). */
    _mgHostEl() {
        const st = this._mgState();
        if (st.host && st.host.isConnected) return st.host;
        const doc = this.viewport.ownerDocument;
        const host = doc.createElement("div");
        host.className = "motion-view";
        // The viewport pans, zooms and swallows the context menu; the editor has its own say over all of it.
        for (const type of ["mousedown", "wheel", "contextmenu", "dblclick"]) {
            host.addEventListener(type, (e) => e.stopPropagation());
        }
        this._mgWireDrop(host);
        this.viewport.append(host);
        st.host = host;
        return host;
    },

    /** switchTab came to a motion tab: the editor takes the main canvas, its panels come up. */
    mgTabEnter(key) {
        const st = this._mgState();
        let rec = st.tabs[key];
        if (!rec) rec = st.tabs[key] = { path: key.slice(MG_PREFIX.length), el: null, editor: null };
        const first = !this._mgOn;
        this._mgOn = true;
        this.viewport.classList.add("motion-mode");
        const host = this._mgHostEl();
        host.style.display = "block";
        if (!rec.el) {
            rec.el = host.ownerDocument.createElement("div");
            rec.el.className = "motion-tab";
            host.append(rec.el);
        }
        for (const other of Object.values(st.tabs)) if (other.el) other.el.style.display = other === rec ? "block" : "none";
        if (!rec.editor && !rec.shown) this._mgBuild(key, rec);
        // The tab's own panels, the way they were left (all up the first time).
        if (this.setPanelDocked) {
            for (const id of Object.keys(MG_PANELS)) {
                const want = st.want[id] !== false;
                if (want !== this.isPanelDocked(id)) this.setPanelDocked(id, want);
            }
        }
        this._mgSeat(rec);
        if (first && this.barGroupsSync) this.barGroupsSync();
    },

    /** switchTab left a motion tab (or the last one closed): the viewport is the picture's again. */
    mgTabLeave() {
        if (!this._mgOn) return;
        const st = this._mgState();
        this._mgOn = false;
        this.viewport.classList.remove("motion-mode");
        if (st.host) st.host.style.display = "none";
        if (this.isPanelDocked && this.setPanelDocked) {
            for (const id of Object.keys(MG_PANELS)) {
                st.want[id] = this.isPanelDocked(id);
                if (this.isPanelDocked(id)) this.setPanelDocked(id, false);
            }
        }
        if (this.barGroupsSync) this.barGroupsSync();
    },

    /** The panels hold the active tab's editor parts (each tab's editor made its own). */
    _mgSeat(rec) {
        for (const [id, part] of Object.entries(MG_PANELS)) {
            const slot = this._mgSlot(id);
            if (!slot) continue;
            const el = rec && rec.editor && rec.editor.parts ? rec.editor.parts[part] : null;
            if (el) { if (slot.firstChild !== el || slot.childNodes.length !== 1) slot.replaceChildren(el); }
            else slot.replaceChildren(this._mgNote(slot.ownerDocument, "Open a motion scene to see its " + part + "."));
        }
        if (rec && rec.editor) requestAnimationFrame(() => rec.editor.relayout && rec.editor.relayout());
    },

    _mgSlot(id) {
        const panel = this._dockPanelEl ? this._dockPanelEl(id) : null;
        return panel ? panel.querySelector(":scope > .mg-slot") : null;
    },

    _mgNote(doc, text) {
        const n = doc.createElement("div");
        n.className = "mg-note";
        n.textContent = text;
        return n;
    },

    /** Fill a tab's element: the editor when there is a scene, else the "Open a motion scene" state. */
    async _mgBuild(key, rec) {
        const doc = rec.el.ownerDocument;
        rec.shown = true;
        if (!rec.path) { this._mgEmptyState(rec); return; }
        if (!rec.pending) {
            // A tab that came back with the page: read its scene again.
            try {
                const res = await api.fetchApi(`/bepic/mgscene?${mgRefQuery(rec.path)}`);
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                rec.pending = data.scene;
            } catch (e) {
                rec.el.replaceChildren(this._mgNote(doc, `Cannot open ${baseOf(rec.path)}: ${e.message || e}`));
                return;
            }
        }
        const scene = rec.pending;
        rec.pending = null;
        rec.el.replaceChildren();
        const stage = doc.createElement("div");
        stage.className = "motion-stage";
        rec.el.append(stage);
        rec.editor = createMgEditor(stage, {
            split: true,
            assetUrl: (src) => this._mgAssetUrl(src, rec.path),
            save: (path, sc) => this._mgSave(path, sc),
            render: (path) => this._mgRender(path),
            notify: (m, sev) => notice(sev || "info", m),
        });
        const check = rec.editor.load(scene, rec.path);
        if (!check.ok) notice("warn", "The scene has problems", check.errors.slice(0, 3).map((x) => x.message).join("; "));
        if (this.activeTab === key) this._mgSeat(rec);
    },

    _mgEmptyState(rec) {
        const doc = rec.el.ownerDocument;
        const box = doc.createElement("div");
        box.className = "mg-open-state";
        const h = doc.createElement("div");
        h.className = "mg-open-title";
        h.textContent = "Open a motion scene";
        const p = doc.createElement("div");
        p.className = "mg-open-text";
        p.textContent = "Motion scenes (*.mgscene.json) are what the agent writes for titles, lower thirds and logo reveals. "
            + "Open one to edit its layers and keyframes here. A rendered video or poster PNG with its scene beside it opens too.";
        const b = doc.createElement("button");
        b.className = "mg-open-btn";
        b.textContent = "Open…";
        b.addEventListener("click", () => this.mgPickScene());
        box.append(h, p, b);
        rec.el.replaceChildren(box);
    },

    /** Dropping a history / file-browser picture or film onto the editor opens the scene it carries. */
    _mgWireDrop(host) {
        if (host.__mgDropWired) return;
        host.__mgDropWired = true;
        const TYPE = "application/x-bepic-history";
        const has = (e) => Array.from(e.dataTransfer?.types || []).includes(TYPE);
        host.addEventListener("dragover", (e) => { if (has(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
        host.addEventListener("drop", (e) => {
            if (!has(e)) return;
            let payload = null;
            try { payload = JSON.parse(e.dataTransfer.getData(TYPE)); } catch (_) {}
            const items = payload && Array.isArray(payload.items) ? payload.items : [];
            const it = items.find((x) => x && mgMayHaveScene(x));
            if (!it) return;
            e.preventDefault(); e.stopPropagation();
            this.mgOpenFile(it.path ? it.path : it);
        });
    },

    // ── closing ──────────────────────────────────────────────────────────────

    /** closeTab asks first: a scene with changes that were not saved says so once and stays. */
    mgTabClosing(key) {
        if (!this.isMotionTab(key)) return true;
        const rec = this._mgState().tabs[key];
        if (rec && rec.editor && rec.editor.isDirty() && this._mgCloseAsked !== key) {
            this._mgCloseAsked = key;
            notice("warn", "Unsaved changes", `${baseOf(rec.path)} has changes that were not saved. Close the tab again to throw them away.`);
            return false;
        }
        this._mgCloseAsked = null;
        return true;
    },

    /** The tab is gone: so is its editor. */
    mgTabClosed(key) {
        const st = this._mgState();
        const rec = st.tabs[key];
        if (!rec) return;
        if (rec.editor) { try { rec.editor.dispose(); } catch (_) { /* already gone */ } }
        if (rec.el) rec.el.remove();
        delete st.tabs[key];
        if (this.activeTab === key) this._mgSeat(null);
    },

    // ── files, assets, render ────────────────────────────────────────────────

    /** A url the browser can load for a scene asset: relative paths are beside the scene file. */
    _mgAssetUrl(src, scenePath) {
        if (!src || isUrl(src)) return src;
        const abs = /^([a-zA-Z]:[\\/]|\/)/.test(src) ? src : `${dirOf(scenePath)}/${src}`;
        return api.apiURL(`/bepic/view_file?path=${encodeURIComponent(abs)}&raw=1`);
    },

    async _mgSave(path, scene) {
        const res = await api.fetchApi("/bepic/mgscene", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, scene }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    },

    /** Ask agentY's host to render the saved scene; poll it and tell the user when the file exists. */
    async _mgRender(path) {
        const res = await api.fetchApi("/bepic/mg_render", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, format: "mp4" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const id = data.id;
        const st = this._mgState();
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/bepic/mg_render?id=${encodeURIComponent(id)}`);
                const d = await r.json().catch(() => ({}));
                if (d.state === "done") {
                    notice("success", "Render finished", d.path || "");
                    return;
                }
                if (d.state === "error" || !r.ok) { notice("error", "Render failed", d.error || ""); return; }
                st.polling = setTimeout(poll, 1500);
            } catch (e) { notice("error", "Render status lost", String(e.message || e)); }
        };
        st.polling = setTimeout(poll, 1500);
        return { message: "Rendering with agentY... you will get a note when the video is ready." };
    },
};
