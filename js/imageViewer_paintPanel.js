// imageViewer_paintPanel.js
// Paint: a picture in layers as a TAB of the viewer - the glue between the editor
// (imageViewer_paintEditor.js, which does not know the viewer) and everything around it.
//
// A picture opened in Paint gets a tab ("paint:<the file>", or "paint:new-<n>" for a new canvas) and the
// editor covers the main canvas the way the Motion editor does; its two other parts are dock panels -
// Layers and Properties - that are up only with a Paint tab (they come back the way they were left).
// Paint has no time: the viewer's bar counts no frames on a Paint tab.
//
// The server keeps every open picture as a session (paint_routes.py): the page holds its token, reads the
// pixels raw from /imageviewer/paint/px and sends changed ones raw to /imageviewer/paint/stage before a save names
// them. Save writes an .ora (over its own, else the next version by the export rule, kind "paint");
// Export writes a flat picture or a .psd by the same rule. The agent changes a picture with edit_image
// (POST /imageviewer/paint/doc), which tells the page (ComfyUI's "imageviewer.paint.changed"): the tab takes the new
// document as ONE undo step. Generate runs a ready-made workflow for each action (POST /imageviewer/paint/generate
// fills it in, this page queues it, /imageviewer/paint/generate_place says how the picture goes back - a new
// layer, a mask, a selection); the choice "agentY builds one" asks agentY (window.agentYViewerBridge.feedback)
// from a snapshot of the picture (/imageviewer/paint/snapshot), to put the result back with edit_image.
import { api } from "../../scripts/api.js";
import { createPaintEditor, PAINT_KEYS } from "./imageViewer_paintEditor.js";
import { notice, openFilePicker, openExportDialog, canvasContext } from "./imageViewer_exportUI.js";
import { addRecentDoc } from "./imageViewer_recentDocs.js";
import { queueWithAuth } from "./imageViewer_comfyAuth.js";
import { maskBBox, composite } from "./imageViewer_paintData.js";
import { app } from "../../scripts/app.js";
import * as WC from "./imageViewer_paintCanvas.js";

export const PAINT_PREFIX = "paint:";
/** The dock panels of a Paint tab, and the editor part each one holds. */
// Dock panel id -> the editor's part it holds. They ship as Layers, History and, sharing one place as tabs,
// Properties | Tool options | Effects | Generate. The order is the order they are opened in when a Paint tab comes
// up: in a place shared as tabs the last one opened is in front, so Properties comes after the others.
export const PAINT_PANELS = { paintLayers: "layers", paintTool: "tool", paintEffects: "effects", paintGenerate: "generate",
                              paintProps: "props", paintHistory: "history" };
const PART_NOUN = { layers: "layers", props: "properties", tool: "tool options", effects: "effects", generate: "Generate", history: "history" };
export { PAINT_KEYS };

const PICTURE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".tga", ".gif", ".exr", ".hdr", ".dpx"];
const OPEN_EXTS = [...PICTURE_EXTS, ".ora", ".psd"];
const EXPORT_FORMATS = [{ value: "png", label: "PNG" }, { value: "jpg", label: "JPEG" }, { value: "webp", label: "WebP" },
                        { value: "tif", label: "TIFF" }, { value: "psd", label: "Photoshop (.psd)" }, { value: "ora", label: "OpenRaster (.ora)" }];
const baseOf = (p) => String(p || "").split(/[\\/]/).pop();
const stemOf = (p) => baseOf(p).replace(/\.[^.]+$/, "");
const extOf = (p) => { const m = /\.[^.\\/]+$/.exec(String(p || "")); return m ? m[0].toLowerCase() : ""; };

/** May this file open in Paint (a picture, an .ora, a .psd)? */
export function paintMayOpen(ref) {
    const name = typeof ref === "string" ? ref : (ref && (ref.path || ref.filename)) || "";
    return OPEN_EXTS.includes(extOf(name));
}

async function postJson(route, body) {
    const res = await api.fetchApi(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
}

/** Raw bytes, gzipped where the browser can (CompressionStream), for /imageviewer/paint/stage. */
async function packed(bytes) {
    if (typeof CompressionStream === "undefined" || bytes.byteLength < 4096) return { body: bytes, gz: false };
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
        return { body: await new Response(stream).arrayBuffer(), gz: true };
    } catch (_) { return { body: bytes, gz: false }; }
}

export const PaintPanelMixin = {

    _paintState() {
        if (!this._paint) {
            this._paint = { tabs: {}, want: {}, host: null, n: 0 };
            // The agent changed a picture (edit_image, POST /imageviewer/paint/doc): its tab takes it as one undo step.
            api.addEventListener("imageviewer.paint.changed", (e) => {
                const d = e && e.detail;
                if (d && d.from !== "page") this.paintChanged(d).catch((err) => console.warn("imageViewer: Paint change not taken", err));
            });
            // The agent is about to work on a picture open here (edit_image on the tab's token): hand over what is
            // not saved, so it works on the picture as it is on screen and nothing needs saving first.
            api.addEventListener("imageviewer.paint.sync", (e) => {
                const d = e && e.detail;
                if (d && d.token) this.paintHandOver(d.token, d.req).catch((err) => console.warn("imageViewer: Paint hand-over", err));
            });
        }
        return this._paint;
    },

    isPaintTab(key = this.activeTab) {
        return typeof key === "string" && key.startsWith(PAINT_PREFIX);
    },

    _paintActive() { return this._paintOn ? this._paintState().tabs[this.activeTab] || null : null; },

    // ── opening ──────────────────────────────────────────────────────────────

    /**
     * Open a picture, an .ora or a .psd in a Paint tab (and show the viewer). `ref` is a path or the
     * {filename, subfolder, type} a history item is known by. The same file twice is the same tab.
     */
    async paintOpen(ref, { quiet = false } = {}) {
        const st = this._paintState();
        const want = typeof ref === "string" ? ref : (ref && ref.path) || "";
        const same = want && Object.entries(st.tabs).find(([, r]) => r.source && r.source.replace(/\\/g, "/").toLowerCase() === want.replace(/\\/g, "/").toLowerCase());
        if (same && this.allTabs[same[0]]) {
            this._paintShow(same[0]);
            return true;
        }
        let data;
        try {
            data = await postJson("/imageviewer/paint/open", typeof ref === "string" ? { path: ref } : ref);
        } catch (e) {
            if (!quiet) notice("error", "Cannot open it in Paint", String(e.message || e));
            return false;
        }
        const source = data.source || want;
        const key = PAINT_PREFIX + (source || `new-${++st.n}`);
        const rec = st.tabs[key] || (st.tabs[key] = { el: null, editor: null });
        Object.assign(rec, { token: data.token, path: data.path || null, source, pending: data });
        addRecentDoc("paint", data.path || source);
        this._paintMakeTab(key, data.doc.name || stemOf(source) || "Paint");
        // The tab is there whatever happens next: a hiccup while it comes up is logged, not shown as "not opened".
        try { this._paintShow(key); } catch (e) { console.error("imageViewer: Paint tab shown with an error", e); }
        if (data.notes && data.notes.length) notice("info", "Opened with notes", data.notes.slice(0, 4).join("; "));
        return true;
    },

    /** A new canvas in a tab of its own: w x h, its ground white, black or transparent. */
    async paintNewBlank({ name = "paint", w = 1920, h = 1080, fill = "white" } = {}) {
        let data;
        try {
            data = await postJson("/imageviewer/paint/open", { new: { w: Math.round(w), h: Math.round(h), name: name || "paint", fill } });
        } catch (e) { notice("error", "No new picture", String(e.message || e)); return false; }
        const st = this._paintState();
        const key = PAINT_PREFIX + `new-${++st.n}`;
        st.tabs[key] = { el: null, editor: null, token: data.token, path: null, source: "", pending: data };
        this._paintMakeTab(key, data.doc.name);
        try { this._paintShow(key); } catch (e) { console.error("imageViewer: Paint tab shown with an error", e); }
        return true;
    },

    /** A new, empty canvas: its size and ground asked first (straight away with no picture to ask over). */
    paintNewDialog() {
        const rec = this._paintActive();
        const fields = [["name", "Name", "paint", "text"], ["w", "Width", 1920, 1, 16384], ["h", "Height", 1080, 1, 16384],
                        ["fill", "Ground", "white", ["white", "black", "transparent"]]];
        if (rec && rec.editor) rec.editor.dialog("New picture", fields, (v) => this.paintNewBlank(v));
        else this.paintNewBlank();
    },

    /** The bar's Paint item: the Paint tab that is open, else a new white canvas, 1920 x 1080. */
    paintBarOpen() {
        const open = (this.tabOrder || []).find((k) => this.isPaintTab(k) && k !== PAINT_PREFIX && this.allTabs[k]);
        if (open) { if (this.requestPanelOpen) this.requestPanelOpen(); this.switchTab(open); return Promise.resolve(true); }
        return this.paintNewBlank();
    },

    _paintMakeTab(key, label) {
        this.allTabs[key] = [];
        this.tabLabels[key] = "\u{1F58C} " + label;
        if (!this.tabOrder.includes(key)) this.tabOrder.push(key);
        this._rebuildTabBar(null);
    },

    _paintShow(key) {
        if (this.requestPanelOpen) this.requestPanelOpen();
        this.switchTab(key);
        // The empty "Paint" tab was only a way to ask for a picture.
        if (key !== PAINT_PREFIX && this.allTabs[PAINT_PREFIX]) this.closeTab(PAINT_PREFIX);
    },

    /** The file picker: a picture, an .ora or a .psd. */
    async paintPickOpen() {
        await openFilePicker(this.container, {
            id: "paint", title: "Open in Paint", kind: "paint", exts: OPEN_EXTS, go: "Open",
            note: "A picture opens as one layer; an .ora (Krita, GIMP, this) or a .psd opens with its layers.",
            onPick: async ([file]) => {
                if (!file) return { ok: false, message: "Pick a file." };
                let ok = false;
                try { ok = await this.paintOpen(file.path); }
                catch (e) { console.error("imageViewer: Paint open", e); ok = Object.values(this._paintState().tabs).some((r) => r.source === file.path); }
                return ok ? { ok: true } : { ok: false, message: `${file.name} could not be opened.` };
            },
        });
    },

    /** The file picker: pictures to add as layers of the picture on screen. */
    async paintPickAdd() {
        const rec = this._paintActive();
        if (!rec || !rec.editor || !rec.editor.doc) { this.paintPickOpen(); return; }
        await openFilePicker(this.container, {
            id: "paintAdd", title: "Add as a layer", kind: "image", exts: PICTURE_EXTS, multiple: true, go: "Add",
            note: "Each picture becomes a smart layer over the one selected, in the middle - fitted inside the canvas when it is bigger, its own pixels kept.",
            onPick: async (files) => {
                if (!files.length) return { ok: false, message: "Pick a picture." };
                for (const f of files) {
                    const ok = await this.paintAddImage(rec, f.path);
                    if (!ok) return { ok: false, message: `${f.name} could not be read.` };
                }
                return { ok: true };
            },
        });
    },

    /** One picture as a new layer: the server reads it (EXR and friends too), the bytes come raw. */
    async paintAddImage(rec, ref) {
        try {
            const data = await postJson("/imageviewer/paint/open", typeof ref === "string" ? { path: ref } : ref);
            const L = data.doc.layers.find((x) => x.kind === "pixel");
            const px = await this._paintFetch(data.token, { layer: L.id }, L.w * L.h * 4);
            // A smart layer: the picture keeps its own pixels, in the middle (fitted inside the canvas when bigger).
            rec.editor.addSmartLayer(new Uint8ClampedArray(px), L.w, L.h, data.doc.name || "Picture");
            return true;
        } catch (e) {
            notice("error", "Not added", String(e.message || e));
            return false;
        }
    },

    async _paintFetch(token, q, want) {
        const qs = new URLSearchParams({ token, ...q }).toString();
        const res = await api.fetchApi(`/imageviewer/paint/px?${qs}`, { cache: "no-store" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (want != null && buf.byteLength !== want) throw new Error(`the pixels came back the wrong size (${buf.byteLength} for ${want})`);
        return buf;
    },

    /** Every layer's pixels, mask and the selection of a session: what setDocument / replaceWith take. */
    async _paintLoad(token, meta, selection, have = null) {
        const pix = {}, masks = {}, srcs = {};
        const jobs = [];
        for (const L of meta.layers) {
            if (L.kind === "pixel") jobs.push(async () => { pix[L.id] = new Uint8ClampedArray(await this._paintFetch(token, { layer: L.id }, L.w * L.h * 4)); });
            if (L.mask) jobs.push(async () => { masks[L.id] = new Uint8Array(await this._paintFetch(token, { mask: L.id }, L.mask.w * L.mask.h)); });
            // A smart layer's source, once (the editor may hold it already: a source never changes).
            const sm = L.smart;
            if (sm && !(sm.src in srcs) && !(have && have.has(sm.src))) {
                srcs[sm.src] = null;
                jobs.push(async () => {
                    try { srcs[sm.src] = { px: new Uint8ClampedArray(await this._paintFetch(token, { src: sm.src }, sm.sw * sm.sh * 4)), w: sm.sw, h: sm.sh }; }
                    catch (_) { delete srcs[sm.src]; }          // the layer is then a plain one
                });
            }
        }
        let sel = null;
        if (selection) jobs.push(async () => { sel = new Uint8Array(await this._paintFetch(token, { sel: 1 }, meta.w * meta.h)); });
        // A few at a time: a picture of many layers should not open dozens of requests at once.
        for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map((f) => f()));
        for (const k of Object.keys(srcs)) if (!srcs[k]) delete srcs[k];
        return { doc: meta, pix, masks, selection: sel, srcs };
    },

    // ── the tab on screen ────────────────────────────────────────────────────

    _paintHostEl() {
        const st = this._paintState();
        if (st.host && st.host.isConnected) return st.host;
        const doc = this.viewport.ownerDocument;
        const host = doc.createElement("div");
        host.className = "paint-view";
        // The viewport pans, zooms and swallows the context menu; the editor has its own say over all of it.
        for (const type of ["mousedown", "pointerdown", "wheel", "contextmenu", "dblclick"]) host.addEventListener(type, (e) => e.stopPropagation());
        this._paintWireDrop(host);
        this.viewport.append(host);
        st.host = host;
        return host;
    },

    /** switchTab came to a Paint tab: the editor takes the main canvas, its panels come up. */
    paintTabEnter(key) {
        const st = this._paintState();
        let rec = st.tabs[key];
        if (!rec) {
            // A tab that came back with the page: open its file again (a new canvas cannot come back).
            const src = key.slice(PAINT_PREFIX.length);
            rec = st.tabs[key] = { el: null, editor: null, token: null, path: null, source: /^new-\d+$/.test(src) ? "" : src };
        }
        const first = !this._paintOn;
        this._paintOn = true;
        if (first) this._paintWarm();
        this.viewport.classList.add("paint-mode");
        const host = this._paintHostEl();
        host.style.display = "block";
        if (!rec.el) {
            rec.el = host.ownerDocument.createElement("div");
            rec.el.className = "paint-tab";
            host.append(rec.el);
        }
        for (const other of Object.values(st.tabs)) if (other.el) other.el.style.display = other === rec ? "block" : "none";
        this.stop();
        if (!rec.editor) this._paintBuild(key, rec);
        if (this.setPanelDocked) {
            for (const id of Object.keys(PAINT_PANELS)) {
                const want = st.want[id] !== false;
                if (want !== this.isPanelDocked(id)) this.setPanelDocked(id, want);
            }
            // The ones that were in front of their tabs when the last Paint tab went away are in front again.
            if (this.dockTabFront) for (const id of st.front || []) if (this.isPanelDocked(id) && !this.isPanelFront(id)) this.dockTabFront(id);
        }
        this._paintSeat(rec);
        if (first && this.barGroupsSync) this.barGroupsSync();
    },

    /** switchTab left a Paint tab (or the last one closed). */
    paintTabLeave() {
        if (!this._paintOn) return;
        const st = this._paintState();
        this._paintOn = false;
        this.viewport.classList.remove("paint-mode");
        if (st.host) st.host.style.display = "none";
        if (this.isPanelDocked && this.setPanelDocked) {
            st.front = Object.keys(PAINT_PANELS).filter((id) => this.isPanelFront && this.isPanelFront(id));
            for (const id of Object.keys(PAINT_PANELS)) {
                st.want[id] = this.isPanelDocked(id);
                if (this.isPanelDocked(id)) this.setPanelDocked(id, false);
            }
        }
        if (this.barGroupsSync) this.barGroupsSync();
    },

    /** The panels hold the active tab's editor parts. */
    _paintSeat(rec) {
        for (const [id, part] of Object.entries(PAINT_PANELS)) {
            const panel = this._dockPanelEl ? this._dockPanelEl(id) : null;
            const slot = panel ? panel.querySelector(":scope > .paint-slot") : null;
            if (!slot) continue;
            const el = rec && rec.editor ? rec.editor.parts[part] : null;
            if (el) { if (slot.firstChild !== el || slot.childNodes.length !== 1) slot.replaceChildren(el); }
            else {
                const n = slot.ownerDocument.createElement("div");
                n.className = "mg-note";
                n.textContent = "Open a picture in Paint to see its " + (PART_NOUN[part] || part) + ".";
                slot.replaceChildren(n);
            }
        }
    },

    /** The editor for a tab, and its picture when it has one. */
    async _paintBuild(key, rec) {
        rec.editor = createPaintEditor(rec.el, this._paintHost(key, rec));
        if (this.activeTab === key) this._paintSeat(rec);
        if (!rec.pending && rec.source) {
            try { rec.pending = await postJson("/imageviewer/paint/open", { path: rec.source }); }
            catch (e) { notice("error", "Cannot open it in Paint", `${baseOf(rec.source)}: ${e.message || e}`); return; }
            Object.assign(rec, { token: rec.pending.token, path: rec.pending.path || null });
        }
        if (!rec.pending) return;
        const data = rec.pending;
        rec.pending = null;
        try {
            const loaded = await this._paintLoad(data.token, data.doc, data.selection);
            rec.editor.setDocument(loaded);
        } catch (e) {
            notice("error", "The picture's pixels did not arrive", String(e.message || e));
        }
    },

    /** What the editor may ask of the viewer. */
    _paintHost(key, rec) {
        return {
            newDoc: () => this.paintNewDialog(),
            open: () => this.paintPickOpen(),
            addImage: () => this.paintPickAdd(),
            save: () => this.paintSave(rec),
            saveAs: () => this.paintSaveAs(rec),
            exportDoc: () => this.paintExport(rec),
            generate: (kind, opts) => this.paintGenerate(rec, kind, opts || {}),
            editSmart: (layerId) => this.paintEditSmart(rec, layerId),
            workflows: () => this.paintWorkflowsDialog(rec),
            generateDialog: (kind) => this.paintGenerateDialog(rec, kind),
            workflowFor: (kind) => this._paintWfLabel(kind),
            menu: (entries, x, y, anchor) => {
                if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
                this._previzOpenMenu(entries, x, y, anchor);
            },
            notify: (m, sev) => notice(sev || "info", m),
            showPanel: (part) => this.paintShowPanel(part),
            onChange: (dirty) => this._paintMarkTab(key, dirty),
        };
    },

    /** A Paint panel up and in front (Shift+F5 opens Fill in Properties), by its part ("effects") or its id. */
    paintShowPanel(part) {
        const id = PAINT_PANELS[part] ? part : Object.keys(PAINT_PANELS).find((k) => PAINT_PANELS[k] === part);
        if (!id || !this.setPanelDocked) return;
        if (!this.isPanelDocked(id)) { this.setPanelDocked(id, true); this._paintSeat(this._paintActive()); }
        else if (this.isPanelFront && !this.isPanelFront(id) && this.dockTabFront) this.dockTabFront(id);
    },

    _paintMarkTab(key, dirty) {
        const container = this.tabsContainer || this.tabBar;
        const btn = container && container.querySelector(`[data-tab="${CSS.escape(key)}"]`);
        if (btn) btn.classList.toggle("paint-dirty", !!dirty);
    },

    // ── saving ───────────────────────────────────────────────────────────────

    /** The page's document into its session (the changed pixels raw, the rest kept). */
    async _paintSync(rec) {
        if (!rec.token) throw new Error("this picture has no session - open it again");
        const s = rec.editor.toSave();
        const send = async (part, bytes) => {
            const { body, gz } = await packed(bytes);
            const res = await api.fetchApi(`/imageviewer/paint/stage?${new URLSearchParams({ token: rec.token, part })}`, {
                method: "POST", headers: { "Content-Type": "application/octet-stream", ...(gz ? { "X-ImageViewer-Enc": "gzip" } : {}) }, body,
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        };
        for (const [id, b] of Object.entries(s.layers)) await send("layer:" + id, b);
        for (const [id, b] of Object.entries(s.masks)) await send("mask:" + id, b);
        for (const [id, b] of Object.entries(s.sources || {})) await send("src:" + id, b);
        await send("sel", s.selection);
        return s;
    },

    /**
     * Edit contents of a smart layer: its source opened as a picture in a Paint tab of its own (a new canvas of
     * the source's size, the source its one layer). Saving that tab draws the layer again from what was saved
     * (_paintSmartBack) - every layer that shares the source, corners where they were, one undo step there.
     */
    async paintEditSmart(rec, layerId) {
        const ed = rec && rec.editor, L = ed && ed.doc && ed.doc.layers.find((x) => x.id === layerId);
        const S = L && L.smart && ed.srcs && ed.srcs.get(L.smart.src);
        if (!S) { notice("warn", "Not a smart layer", "Its source is not here."); return false; }
        try {
            const data = await postJson("/imageviewer/paint/open", { new: { w: S.w, h: S.h, name: `${L.name} contents`, fill: "transparent" } });
            const lid = data.doc.layers[0].id;
            data.doc.layers[0].name = L.name;
            const { body, gz } = await packed(S.px);
            const res = await api.fetchApi(`/imageviewer/paint/stage?${new URLSearchParams({ token: data.token, part: "layer:" + lid })}`, {
                method: "POST", headers: { "Content-Type": "application/octet-stream", ...(gz ? { "X-ImageViewer-Enc": "gzip" } : {}) }, body,
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
            await postJson("/imageviewer/paint/save", { token: data.token, meta: data.doc, keep: [], write: false });
            const st = this._paintState();
            const key = PAINT_PREFIX + `new-${++st.n}`;
            const parentKey = Object.keys(st.tabs).find((k) => st.tabs[k] === rec);
            st.tabs[key] = { el: null, editor: null, token: data.token, path: null, source: "", pending: data,
                             smartFor: { key: parentKey, layer: layerId, src: L.smart.src } };
            this._paintMakeTab(key, `${L.name} (contents)`);
            this._paintShow(key);
            notice("info", "Smart layer contents", `Save this tab to update ${L.name}.`);
            return true;
        } catch (e) {
            notice("error", "Could not open the contents", String(e.message || e));
            return false;
        }
    },

    /** A tab opened by Edit contents was saved: the smart layer it came from is drawn again from it. */
    _paintSmartBack(rec) {
        const f = rec && rec.smartFor;
        if (!f) return;
        const st = this._paintState(), parent = st.tabs[f.key], ped = parent && parent.editor, ed = rec.editor;
        if (!ped || !ped.doc || !ed || !ed.doc) { notice("warn", "The smart layer was not updated", "Its picture is not open any more."); return; }
        const flat = composite(ed.doc, ed._pixOf, ed._maskOf);
        if (!ped.replaceSource(f.src, flat, ed.doc.w, ed.doc.h)) { notice("warn", "The smart layer was not updated", "No layer uses that source any more."); return; }
        const L = ped.doc.layers.find((x) => x.id === f.layer);
        if (L && L.smart) f.src = L.smart.src;
        notice("success", "Smart layer updated", `${L ? L.name : "The layer"} is drawn from what was saved.`);
    },

    async paintSave(rec, { asNew = false, name = null } = {}) {
        if (!rec || !rec.editor || !rec.editor.doc) return null;
        try {
            const s = await this._paintSync(rec);
            const was = rec.path;
            const res = await postJson("/imageviewer/paint/save", { token: rec.token, meta: s.meta, keep: s.keep, as_new: asNew,
                                                               name: name || s.meta.name, context: canvasContext() });
            rec.path = res.path;
            if (res.path !== was) this._paintLanded(res.path);
            addRecentDoc("paint", res.path);
            rec.editor.markSaved();
            notice("success", "Saved", res.path);
            this._paintSmartBack(rec);
            return res.path;
        } catch (e) {
            notice("error", "Not saved", String(e.message || e));
            return null;
        }
    },

    /**
     * Save as…: a name, a format (.ora with everything, or .psd) and a folder (typed, or Browse… - the viewer's own
     * file picker, so the same folders); asks before writing over a file. The tab then works on the new file.
     */
    async paintSaveAs(rec) {
        const ed = rec && rec.editor;
        if (!ed || !ed.doc) return;
        const cur = rec.path || "";
        const dirOf = (p) => String(p || "").replace(/[\\/][^\\/]*$/, "");
        const stem = cur ? baseOf(cur).replace(/\.[^.]+$/, "") : (ed.doc.name || "paint");
        let start = cur && /\.(ora|psd)$/i.test(cur) ? dirOf(cur) : "";
        if (!start) {
            try {
                // Where pictures of this kind are kept: the shot's paint folder, else the viewer's own.
                const res = await api.fetchApi("/imageviewer/export_places", { method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind: "paint", context: canvasContext() }) });
                const places = res.ok ? ((await res.json()).places || []) : [];
                if (places[0] && places[0].path) start = places[0].path;
            } catch (_) { /* typed by hand then */ }
        }
        const el = (tag, cls, props) => ed.el(tag, cls, props);
        const shade = el("div", "paint-dlg-shade");
        const box = el("div", "paint-dlg paint-saveas");
        box.append(el("h3", "", { text: "Save as" }));
        const field = (label, ...parts) => { const r = el("div", "paint-field"); r.append(el("label", "", { text: label }), ...parts); box.append(r); return r; };
        const name = el("input", "paint-saveas-name", { type: "text", value: stem, spellcheck: false });
        field("Name", name);
        const fmt = el("select", "paint-saveas-format");
        fmt.append(el("option", "", { value: "ora", text: "OpenRaster (.ora) - everything kept" }),
                   el("option", "", { value: "psd", text: "Photoshop (.psd) - adjustments baked" }));
        fmt.value = cur && /\.psd$/i.test(cur) ? "psd" : "ora";
        field("Format", fmt);
        const folder = el("input", "paint-saveas-folder", { type: "text", value: start, spellcheck: false });
        const browse = el("button", "paint-btn paint-saveas-browse", { type: "button", text: "Browse\u2026" });
        field("Folder", folder, browse);
        const note = el("div", "note paint-saveas-note", { text: "The tab works on the new file from then on; the file it came from stays as it is." });
        box.append(note);
        const go = el("div", "go");
        const cancel = el("button", "paint-btn", { type: "button", text: "Cancel" });
        const over = el("button", "paint-btn paint-saveas-over", { type: "button", text: "Overwrite" });
        over.style.display = "none";
        const ok = el("button", "paint-btn on paint-saveas-go", { type: "button", text: "Save" });
        go.append(cancel, over, ok);
        box.append(go);
        shade.append(box);
        const shut = () => shade.remove();
        const send = async (overwrite) => {
            ok.disabled = over.disabled = true;
            over.style.display = "none";
            note.classList.remove("error");
            note.textContent = "Saving\u2026";
            try {
                const s = await this._paintSync(rec);
                const res = await postJson("/imageviewer/paint/save_as", { token: rec.token, meta: s.meta, keep: s.keep, folder: folder.value,
                                                                          name: name.value, format: fmt.value, overwrite });
                shut();
                rec.path = res.path;
                addRecentDoc("paint", res.path);
                ed.markSaved();
                this._paintSmartBack(rec);
                this._paintRelabel(rec, res.path);
                notice("success", "Saved", res.path + (res.notes && res.notes.length ? " - " + res.notes.join("; ") : ""));
                this._paintLanded(res.path);
            } catch (e) {
                ok.disabled = over.disabled = false;
                if (e.status === 409 && e.data && e.data.exists) {
                    note.textContent = `${baseOf(e.data.path)} is there already. Overwrite it?`;
                    over.style.display = "";
                    return;
                }
                note.textContent = "Not saved: " + String(e.message || e);
                note.classList.add("error");
            }
        };
        cancel.addEventListener("click", shut);
        ok.addEventListener("click", () => send(false));
        over.addEventListener("click", () => send(true));
        browse.addEventListener("click", () => openFilePicker(this.container, {
            id: "paintSaveAs", title: "Save as\u2026 into", kind: "paint", start: folder.value, folder: true,
            exts: [".ora", ".psd"], go: "This folder",
            onPick: async ([f]) => { if (f && f.path) folder.value = f.path; return { ok: true }; },
        }));
        box.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); shut(); }
            else if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.preventDefault(); send(false); }
        });
        shade.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (e.target === shade) shut(); });
        ed.box.append(shade);
        setTimeout(() => { name.focus(); name.select(); }, 0);
        return shade;
    },

    /** The tab's name after the file it works on now. */
    _paintRelabel(rec, path) {
        const key = Object.entries(this._paintState().tabs).find(([, r]) => r === rec)?.[0];
        if (!key || !this.tabLabels) return;
        this.tabLabels[key] = "\u{1F58C} " + baseOf(path);
        if (this._rebuildTabBar) this._rebuildTabBar(null);
    },

    /** A saved / exported .ora or .psd into the History, as every export lands there (a picture of how it looks). */
    _paintLanded(path) {
        if (this.exportLanded) this.exportLanded([path]).catch?.(() => {});
    },

    async paintExport(rec) {
        if (!rec || !rec.editor || !rec.editor.doc) return;
        this._paintExportLast = this._paintExportLast || { format: "png" };
        await openExportDialog(this.container, {
            title: "Export picture", kind: "paint", name: rec.editor.doc.name || "paint",
            fixed: EXPORT_FORMATS, values: this._paintExportLast,
            note: "PNG / JPEG / WebP / TIFF: the picture as it looks. PSD: the layers, their masks and blend modes; "
                + "an adjustment layer is merged into what is under it (Photoshop's own have other numbers).",
            onExport: async (v) => {
                this._paintExportLast = { format: v.format };
                try {
                    const s = await this._paintSync(rec);
                    const res = await postJson("/imageviewer/paint/export", { token: rec.token, meta: s.meta, keep: s.keep, format: v.format,
                                                                        name: v.name, context: v.context });
                    notice("success", "Exported", res.path + (res.notes && res.notes.length ? " - " + res.notes.join("; ") : ""));
                    if (this.exportLanded) this.exportLanded([res.path]);
                    return { ok: true };
                } catch (e) { return { ok: false, message: String(e.message || e) }; }
            },
        });
    },

    // ── the agent, and making pixels ─────────────────────────────────────────

    /** The server asks for the page's picture before the agent's change (paint_routes page_sync). */
    async paintHandOver(token, req) {
        const rec = Object.values(this._paintState().tabs).find((r) => r.token === token);
        if (!rec || !rec.editor || !rec.editor.doc) return;   // another window has it
        try {
            const s = await this._paintSync(rec);
            await postJson("/imageviewer/paint/save", { token, meta: s.meta, keep: s.keep, write: false, sync_req: req });
        } catch (e) {
            await postJson("/imageviewer/paint/save", { token, sync_req: req, failed: String(e.message || e) }).catch(() => {});
        }
    },

    /** The page is told that the agent changed a picture (edit_image): the tab takes it as one undo step. */
    async paintChanged(detail) {
        const st = this._paintState();
        const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
        const entry = Object.entries(st.tabs).find(([, r]) => r.token && detail.token && r.token === detail.token)
            || Object.entries(st.tabs).find(([, r]) => detail.path && (norm(r.path) === norm(detail.path) || norm(r.source) === norm(detail.path)));
        if (!entry) {
            if (detail.path && detail.open !== false) await this.paintOpen(detail.path, { quiet: true });
            return;
        }
        const [key, rec] = entry;
        if (!rec.editor || !rec.editor.doc) return;
        try {
            const was = rec.path;
            if (detail.path) rec.path = detail.path;
            if (detail.path && detail.path !== was && detail.written) {
                // A new canvas or a picture saved as an .ora for the first time: the tab works on that file now.
                this._paintRelabel(rec, detail.path);
                this._paintLanded(detail.path);
                addRecentDoc("paint", detail.path);
            }
            if (!detail.token) {
                const again = await postJson("/imageviewer/paint/open", { path: detail.path });
                rec.token = again.token;
            }
            const d = await this._paintDescribe(rec);
            const data = await this._paintLoad(rec.token, d.doc, d.selection, rec.editor && rec.editor.srcs);
            const wasDirty = rec.editor.isDirty();
            rec.editor.replaceWith(data, detail.label || "agentY");
            // Saved with the page's own unsaved changes in it (handed over first): nothing is unsaved now.
            if (detail.written && (!wasDirty || detail.synced)) rec.editor.markSaved();
            if (this.activeTab !== key && detail.focus) this.switchTab(key);
            const said = (detail.said || []).slice(0, 3).join("; ");
            notice("info", "agentY changed the picture", said);
        } catch (e) {
            notice("error", "The agent's change did not arrive", String(e.message || e));
        }
    },

    /**
     * The Generate menu and section. Heal, a plain extend and a plain upscale are done here (the server's ops on
     * the session); the rest run the workflow picked for them (src/paint_workflows/, or the user's own from
     * Settings - paint_generate.py), queued from this page; the choice "agentY builds one" asks agentY as before.
     */
    async paintGenerate(rec, kind, opts) {
        const ed = rec && rec.editor;
        if (!ed || !ed.doc) return;
        const W = ed.doc.w, H = ed.doc.h;
        const bottom = ed.doc.layers.find((L) => L.kind === "pixel");
        // Heal and the plain extend / upscale are done here: still a line in the bar while they run.
        const local = async (ops, label) => {
            const id = ed.genBegin && ed.genBegin(kind, label);
            if (id) ed.genUpdate(id, { text: "Working on it" });
            const ok = await this._paintApplyOps(rec, ops, label);
            if (id) ed.genEnd(id, ok, ok ? "Done" : "Did not work");
            return ok;
        };
        if (kind === "heal") {
            if (!ed.sel) { notice("warn", "Select what to fill first"); return; }
            const L = ed.active();
            await local([{ op: "heal", layer: L && L.kind === "pixel" ? L.id : bottom && bottom.id }], "Fill from the surroundings");
            return;
        }
        if (kind === "extend") {
            const px = Math.max(1, Math.round(Number(opts.px) || 128));
            const ops = [{ op: "canvas_size", w: W + 2 * px, h: H + 2 * px, anchor: "center" },
                         { op: "select", mode: "rect", x: px, y: px, w: W, h: H }, { op: "select", mode: "invert" }];
            if (!opts.ai && bottom) ops.push({ op: "heal", layer: bottom.id });
            if (!(await local(ops, "Extend the canvas")) || !opts.ai) return;
            return this._paintRun(rec, "extend", { ...opts, note: `The canvas was made ${px} px larger on every side; the new border is selected.` });
        }
        if (kind === "upscale" && !opts.ai) {
            await local([{ op: "resize", scale: Number(opts.k) || 2 }], "Upscale");
            return;
        }
        if ((kind === "fill" || kind === "remove") && !ed.sel) { notice("warn", "Select the place first", "Generate works inside the selection."); return; }
        if (kind === "select_objects" && !String(opts.prompt || "").trim() && !(opts.box && ed.sel)) {
            notice("warn", "Say what to select", "Or select around it and let SAM3 look inside the selection's box.");
            return;
        }
        if ((kind === "fill" || kind === "edit") && !String(opts.prompt || "").trim()) {
            notice("warn", kind === "fill" ? "Say what to make" : "Say what to change", "Type it into the prompt in Properties.");
            return;
        }
        return this._paintRun(rec, kind, opts);
    },

    /** Ops on the session (the page's document synced first), the result taken back as ONE undo step. */
    async _paintApplyOps(rec, ops, label) {
        const ed = rec.editor;
        try {
            const s = await this._paintSync(rec);
            await postJson("/imageviewer/paint/save", { token: rec.token, meta: s.meta, keep: s.keep, write: false });
            await postJson("/imageviewer/paint/doc", { doc: rec.token, ops, write: false, from: "page" });
            const d = await this._paintDescribe(rec);
            const data = await this._paintLoad(rec.token, d.doc, d.selection, rec.editor && rec.editor.srcs);
            ed.replaceWith(data, label);
            return true;
        } catch (e) { notice("error", label + " did not work", String(e.message || e)); return false; }
    },

    // ── Generate's workflows ─────────────────────────────────────────────────

    /** The workflows table (GET /imageviewer/paint/workflows), kept until a choice changes. */
    async _paintWorkflows(fresh = false) {
        if (this._paintWf && !fresh) return this._paintWf;
        try {
            const res = await api.fetchApi("/imageviewer/paint/workflows");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this._paintWf = await res.json();
        } catch (_) { this._paintWf = this._paintWf || null; }
        return this._paintWf;
    },

    /**
     * Asked once in the background when Paint comes up: the workflows table and the settings of the models the
     * dialogs open on, so that Upscale… and Select objects… open with everything at once.
     */
    _paintWarm() {
        if (this._paintWarmed) return;
        this._paintWarmed = true;
        this._paintWorkflows().then((t) => {
            const acts = (t && t.actions) || {};
            for (const kind of ["upscale", "select_objects"]) {
                const a = acts[kind];
                if (!a || !a.workflows) continue;
                const w = a.workflows.find((x) => x.id === a.choice) || a.workflows[0];
                if (w) this._paintTuneSpecs(w).catch(() => {});
            }
        }).catch(() => {});
    },

    /** What a Generate button runs, for its tooltip ("" while the table is not here). */
    _paintWfLabel(kind) {
        const a = this._paintWf && this._paintWf.actions && this._paintWf.actions[kind];
        if (!a) { this._paintWorkflows(); return ""; }
        if (a.choice === "agent") return "agentY builds a workflow";
        if (a.choice === "custom") return (a.custom && a.custom.name) || "My workflow";
        const w = a.workflows.find((x) => x.id === a.choice);
        return w ? w.label : a.choice;
    },

    /** Generate > Workflows…: which workflow each action runs (the same choice as in Settings). */
    async paintWorkflowsDialog(rec) {
        const ed = rec && rec.editor;
        if (!ed) return;
        let t = this._paintWf;                              // open at once with what is here, asked again behind it
        if (t) this._paintWorkflows(true);
        else t = await this._paintWorkflows(true);
        if (!t) { notice("error", "The workflows are not here", "This ComfyUI's viewer is older than the page."); return; }
        const fields = [];
        for (const [a, info] of Object.entries(t.actions)) {
            const opts = info.workflows.map((w) => ({ value: w.id, label: w.label + (w.missing.length ? (w.missing.every((m) => m.url) ? " - models to download" : " - missing " + w.missing.length) : "") }));
            if (info.custom) opts.push({ value: "custom", label: "My workflow: " + (info.custom.name || "custom") });
            opts.push({ value: "agent", label: "agentY builds one" });
            fields.push([a, info.label, info.choice, opts]);
        }
        ed.dialog("Generate workflows", fields, async (v) => {
            try {
                for (const [a, info] of Object.entries(t.actions)) {
                    if (v[a] && v[a] !== info.choice) await postJson("/imageviewer/paint/workflows", { action: a, choice: v[a] });
                }
                await this._paintWorkflows(true);
                ed.refreshProps && ed.refreshProps();
            } catch (e) { notice("error", "Not changed", String(e.message || e)); }
        }, "Your own workflows are added in Settings \u203a ComfyUI Image Viewer \u203a Paint.", { wide: true });
    },

    /** Run the workflow picked for *kind*: prepared by the server, queued here, the pictures laid back as layers. */
    async _paintRun(rec, kind, opts) {
        const ed = rec.editor;
        const t = await this._paintWorkflows();
        const a = t && t.actions && t.actions[kind];
        if (!t || (a && a.choice === "agent")) return this._paintAsk(rec, kind, opts);
        // Seen at once: the button busy, the bar up (imageViewer_paintGenStatus.js).
        const what = (a && a.label) || kind;
        const wfName = this._paintWfLabel(kind);
        const gid = ed.genBegin ? ed.genBegin(kind, wfName ? `${what} \u00b7 ${wfName}` : what) : 0;
        const say = (patch) => { if (gid) ed.genUpdate(gid, patch); };
        const over = (ok, msg) => { if (gid) ed.genEnd(gid, ok, msg); };
        rec.genBusy = (rec.genBusy || 0) + 1;
        let prep;
        const wid = opts.workflow || (a && a.choice) || null;
        const item = a && a.workflows.find((w) => w.id === wid);
        try {
            // Its model files first (asked before anything is fetched), then the workflow onto ComfyUI's canvas.
            if (item && !(await this._paintModelsReady(rec, item, say))) throw Object.assign(new Error("not now"), { quiet: true });
            const graph = item ? await this._paintOnCanvas(item, say) : null;
            say({ text: "Getting the picture ready" });
            const s = await this._paintSync(rec);
            await postJson("/imageviewer/paint/save", { token: rec.token, meta: s.meta, keep: s.keep, write: false });
            prep = await postJson("/imageviewer/paint/generate", { token: rec.token, action: kind, prompt: opts.prompt || "",
                                                                  workflow: wid, k: Number(opts.k) || 2, graph,
                                                                  tune: (item && item.tune.length && this._paintTune(wid)) || null,
                                                                  box: !!opts.box,
                                                                  variations: kind === "upscale" ? 1 : Math.max(1, Math.min(4, Number(opts.variations) || 1)) });
            // The group on the canvas shows what ran (the picture, the words, the seed): its root nodes' widgets.
            if (item) { try { WC.writeBack(app, wid, prep.graphs[0]); } catch (_) { /* only the record */ } }
        } catch (e) {
            rec.genBusy = Math.max(0, (rec.genBusy || 1) - 1);
            if (e.quiet) { over(false, "Not started"); return; }
            const miss = e.data && e.data.missing;
            if (miss && miss.length) {
                const list = miss.map((m) => (m.kind === "model" ? `${m.what} (${m.folder})` : `node ${m.what}`)).join(", ");
                notice("error", "The workflow needs what is not here", list + " - pick another in Generate \u203a Workflows\u2026");
                over(false, "Missing: " + list);
            } else {
                notice("error", "Generate did not start", String(e.message || e));
                over(false, String(e.message || e));
            }
            return;
        }
        const n = prep.graphs.length;
        const ops = [];
        let failed = null, stopped = false;
        const watches = prep.graphs.map((g) => ({ graph: g, id: null, started: false, done: false, stop: null }));
        // What the bar says: the run that is going (or the first one waiting), its node and ComfyUI's progress.
        const show = () => {
            const left = watches.filter((w) => !w.done);
            const w = left.find((x) => x.started) || left[0];
            if (!w) return;
            const k = watches.indexOf(w), of = n > 1 ? ` (${k + 1} of ${n})` : "";
            if (!w.started) { say({ text: "Waiting in ComfyUI's queue" + of, share: null, value: null, max: null }); return; }
            const node = w.node && w.graph[w.node];
            const name = node ? ((node._meta && node._meta.title && !/^paint:/i.test(node._meta.title) ? node._meta.title : node.class_type)) : "Running";
            const share = w.max ? (k + w.value / w.max) / n : null;
            say({ text: `${name}${of}`, share, value: w.max ? w.value : null, max: w.max || null });
        };
        const stopAll = async () => {
            stopped = true;
            say({ text: "Stopping", share: null, value: null, max: null });
            for (const w of watches) if (!w.done && w.stop) w.stop();
        };
        say({ text: `${prep.workflow} at ${prep.size[0]}x${prep.size[1]}` + (n > 1 ? `, ${n} variations` : ""), stop: stopAll });
        try {
            // Each one listened for from the moment it is queued: a later one may well finish first.
            const runs = [];
            for (const w of watches) {
                w.id = await this._paintQueue(w.graph);
                const p = this._paintWait(w.id, prep.output, {
                    start: () => { w.started = true; show(); },
                    node: (nodeId) => { w.started = true; w.node = nodeId; w.value = 0; w.max = 0; show(); },
                    progress: (v, m, nodeId) => { w.started = true; if (nodeId != null) w.node = nodeId; w.value = v; w.max = m; show(); },
                    stop: (fn) => { w.stop = fn; },
                });
                p.then(() => { w.done = true; show(); }, () => { w.done = true; show(); });
                runs.push(p);
            }
            show();
            for (let i = 0; i < runs.length; i++) {
                let img;
                try { img = await runs[i]; }
                catch (e) { failed = failed || e; continue; }
                say({ text: n > 1 ? `Laying in the result (${i + 1} of ${n})` : "Laying in the result", share: null, value: null, max: null, stop: null });
                const placed = await postJson("/imageviewer/paint/generate_place", { job: prep.job, image: img, n: i });
                ops.push(...placed.ops);
            }
        } catch (e) { failed = failed || e; }
        rec.genBusy = Math.max(0, (rec.genBusy || 1) - 1);
        const why = String((failed && failed.message) || failed || "no picture came back");
        if (!ops.length) {
            if (stopped) { over(false, "Stopped"); return; }
            notice("error", prep.label + " did not work", why);
            over(false, why);
            return;
        }
        if (!rec.editor || !rec.editor.doc) return;           // the tab was closed meanwhile
        if (failed && !stopped) notice("warn", "Not every variation came back", why);
        const ok = await this._paintApplyOps(rec, ops, prep.label);
        const made = ops.filter((o) => o.op === "add_layer").length;
        over(ok, ok ? (made > 1 ? `Done: ${made} new layers` : made ? "Done: a new layer" : "Done") : "The result could not be laid in");
    },

    // ── the workflow on ComfyUI's canvas, its model files, its settings ───────

    /**
     * Put the built-in *item* onto ComfyUI's canvas as a group of its own, once (found again by the mark its nodes
     * carry), and answer the prompt to run: for a canvas-format one what ComfyUI makes of that group - so a change
     * made there is run -, for an API-format one null (the server's copy runs; the group is the record).
     */
    async _paintOnCanvas(item, say) {
        const there = WC.nodesOf(app, item.id).length > 0;
        if (!there) {
            say({ text: "Putting the workflow onto the canvas" });
            const res = await api.fetchApi(`/imageviewer/paint/workflow?id=${encodeURIComponent(item.id)}`);
            if (!res.ok) throw new Error(`the workflow ${item.label} is not here (HTTP ${res.status})`);
            const wf = await res.json();
            const title = `Paint · ${item.label}`;
            if (wf.format === "ui") WC.pasteWorkflow(app, item.id, wf.workflow, title);
            else {
                try { WC.placeApiWorkflow(app, item.id, wf.workflow, title); }
                catch (e) { console.warn("[ImageViewer] Paint: the workflow could not be laid onto the canvas", e); }
            }
        }
        if (item.format !== "ui") return null;
        return WC.promptFromCanvas(app, item.id);
    },

    /**
     * Whether the model files *item* needs are here, fetching them when the user says so: asked first, with the
     * files, where they go and how large they are; the download shown in the bar (it can be stopped).
     */
    async _paintModelsReady(rec, item, say) {
        const ed = rec.editor;
        const ask = (title, note, okText) => new Promise((resolve) => {
            let answered = false;
            ed.dialog(title, [], () => { answered = true; resolve(true); }, note, { onCancel: () => { if (!answered) resolve(false); } });
            void okText;
        });
        if (item.first_run && item.first_run.length) {
            const key = "imageviewer.paint.firstRun." + item.id;
            let seen = false;
            try { seen = localStorage.getItem(key) === "1"; } catch (_) { /* asked again */ }
            if (!seen) {
                const yes = await ask("The model downloads itself",
                    `${item.label} is fetched by its node pack the first time it runs (into models/${item.first_run.join(", models/")}). `
                    + "That can take a while and some hundred MB. Run it?");
                if (!yes) return false;
                try { localStorage.setItem(key, "1"); } catch (_) { /* asked again next time */ }
            }
        }
        const gone = (item.missing || []).filter((m) => m.kind !== "node");
        if (!gone.length) return true;
        say({ text: "Looking up the model files" });
        const plan = await postJson("/imageviewer/paint/models", { workflow: item.id });
        const files = plan.files.filter((f) => f.url);
        if (!files.length) return true;            // nothing offered: the run says what is missing
        const mb = (n) => (n ? (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`) : "size not known");
        const list = files.map((f) => `• ${f.name} (${mb(f.size)}) into models/${f.folder}`).join("\n");
        const more = plan.unknown.length ? `\nNot offered for download (put them there yourself): ${plan.unknown.join(", ")}` : "";
        const yes = await ask("Download the models?",
            `${item.label} needs model files that are not on this machine:\n${list}\nTogether ${mb(plan.total)}, from Hugging Face.${more}`);
        if (!yes) return false;
        const { job } = await postJson("/imageviewer/paint/download", { workflow: item.id });
        let st;
        let cancelled = false;
        say({ text: "Downloading the models", share: 0, stop: async () => {
            cancelled = true;
            try { await postJson("/imageviewer/paint/download", { job, cancel: true }); } catch (_) { /* gone */ }
        } });
        for (;;) {
            await new Promise((r) => setTimeout(r, 1000));
            st = await postJson("/imageviewer/paint/download", { job });
            const total = st.files.reduce((t, f) => t + (f.size || 0), 0);
            const done = st.files.reduce((t, f) => t + (f.done || 0), 0);
            const now = st.files.find((f) => f.state === "fetching");
            say({ text: `Downloading ${now ? now.name : "the models"} · ${mb(done)} of ${mb(total)}`, share: total ? done / total : null });
            if (st.state !== "running") break;
        }
        say({ stop: null });
        if (st.state === "done") { await this._paintWorkflows(true); return true; }
        if (st.state === "stopped" || cancelled) return false;
        throw new Error("the download did not work: " + (st.error || st.state));
    },

    /** The settings kept for a workflow (its dialog's): {node ref: {input: value}}. */
    _paintTune(wid, set) {
        const key = "imageviewer.paint.tune." + wid;
        try {
            if (set !== undefined) { localStorage.setItem(key, JSON.stringify(set)); return set; }
            const v = JSON.parse(localStorage.getItem(key) || "null");
            return v && typeof v === "object" ? v : null;
        } catch (_) { return null; }
    },

    /**
     * The settings a workflow offers in its dialog: [{ref, cls, settings}] from ComfyUI's object_info. What it
     * reads (the workflow's file, each class's object_info) is kept for the session, so after the first time
     * this needs no request: `_paintTuneSpecsNow` answers from what is kept, or null while something is not.
     */
    async _paintTuneSpecs(item) {
        if (!item || !item.tune || !item.tune.length) return [];
        const files = this._paintWfFiles || (this._paintWfFiles = {});
        const infos = this._paintInfos || (this._paintInfos = {});
        if (!files[item.id]) {
            const res = await api.fetchApi(`/imageviewer/paint/workflow?id=${encodeURIComponent(item.id)}`);
            if (!res.ok) return [];
            files[item.id] = await res.json();
        }
        const wf = files[item.id];
        await Promise.all(item.tune.map(async (ref) => {
            const cls = this._paintTuneClass(wf, ref);
            if (!cls || infos[cls] !== undefined) return;
            try {
                const r = await api.fetchApi(`/object_info/${encodeURIComponent(cls)}`);
                infos[cls] = (r.ok && (await r.json())[cls]) || null;
            } catch (_) { infos[cls] = null; }
        }));
        return this._paintTuneSpecsNow(item) || [];
    },

    _paintTuneClass(wf, ref) {
        if (wf.format === "ui") return WC.uiClassOf(wf.workflow, ref);
        const k = WC.refIn(wf.workflow, ref);
        return k ? wf.workflow[k].class_type : null;
    },

    _paintTuneSpecsNow(item) {
        if (!item || !item.tune || !item.tune.length) return [];
        const wf = this._paintWfFiles && this._paintWfFiles[item.id];
        if (!wf) return null;
        const infos = this._paintInfos || {};
        const kept = this._paintTune(item.id) || {};
        const skip = item.scale ? [item.scale[1]] : [];
        const out = [];
        for (const ref of item.tune) {
            const cls = this._paintTuneClass(wf, ref);
            if (!cls) continue;
            if (infos[cls] === undefined) return null;
            const info = infos[cls];
            if (!info) continue;
            // What the node holds: the server's copy (an API-format one), then what was kept from the dialog.
            const k = wf.format === "ui" ? null : WC.refIn(wf.workflow, ref);
            const current = { ...((k && wf.workflow[k].inputs) || {}), ...(kept[ref] || {}) };
            const settings = WC.tuneSettings(info, current, skip);
            if (settings.length) out.push({ ref: String(ref), cls, title: info.display_name || cls, settings });
        }
        return out;
    },

    /**
     * Upscale… and Select objects…: the model (any workflow installed for it), what the action takes (times; the
     * words or the selection's box) and the model's own settings, read from ComfyUI (object_info) and kept per
     * workflow. Picking another model opens the dialog again with its settings.
     *
     * It opens AT ONCE: from the workflows table the page already has (asked again behind it) and the settings
     * known so far; a model whose settings are not known yet gets them a moment later (the dialog opened again
     * with what was typed kept, `pre`).
     */
    async paintGenerateDialog(rec, kind, wid, pre = null) {
        const ed = rec && rec.editor;
        if (!ed) return;
        let t = this._paintWf;
        if (t) this._paintWorkflows(true);              // fresh for next time; this one opens with what is here
        else t = await this._paintWorkflows(true);
        const a = t && t.actions && t.actions[kind];
        if (!a) { notice("error", "The workflows are not here", "This ComfyUI's viewer is older than the page."); return; }
        const PLAIN = "__plain";
        const models = a.workflows.map((w) => ({ value: w.id, label: w.label + (w.missing.length ? " - to download" : "") }));
        if (kind === "upscale") models.push({ value: PLAIN, label: "Plain resize (no AI)" });
        const last = this._paintDlgLast || (this._paintDlgLast = {});
        wid = wid || (last[kind] && models.some((m) => m.value === last[kind]) ? last[kind] : (models.some((m) => m.value === a.choice) ? a.choice : (models[0] && models[0].value)));
        if (!wid) { notice("warn", "Nothing installed for " + a.label, "Install a node pack for it, or pick agentY in Generate › Workflows…"); return; }
        const item = a.workflows.find((w) => w.id === wid);
        const known = this._paintTuneSpecsNow(item);
        const specs = known || [];
        const fields = [["wf", "Model", wid, models]];
        if (kind === "upscale") fields.push(["k", "Times", String(last.k || 2), ["2", "4"]]);
        if (kind === "select_objects") {
            fields.push(["text", "What to select", last.text || "", "text"]);
            fields.push(["box", "Look inside the selection's box", ed.sel ? "yes" : "no", ["yes", "no"]]);
        }
        for (const sp of specs) fields.push(...WC.dialogFields(sp.settings, `t:${sp.ref}:`));
        if (pre) for (const f of fields) if (f[0] !== "wf" && pre[f[0]] !== undefined) f[2] = pre[f[0]];
        let cur = null;
        const note = (kind === "select_objects"
            ? "SAM3 finds what the words name - or, with the box, what is inside the selection's box - and selects it. "
            : "") + (specs.length ? "The model's own settings are kept for the next run. " : "")
            + "The workflow goes onto ComfyUI's canvas as a group of its own.";
        let shade = null;
        shade = ed.dialog(a.label, fields, async (v) => {
            last[kind] = v.wf;
            // The model picked here is the one the action runs from now on (the Generate panel's button too).
            if (v.wf !== PLAIN && v.wf !== a.choice) {
                try { await postJson("/imageviewer/paint/workflows", { action: kind, choice: v.wf }); await this._paintWorkflows(true); }
                catch (_) { /* this run still uses it */ }
            }
            if (kind === "upscale") last.k = Number(v.k) || 2;
            if (kind === "select_objects") last.text = v.text;
            if (v.wf === PLAIN) { this.paintGenerate(rec, "upscale", { k: Number(v.k) || 2, ai: false }); return; }
            if (specs.length) {
                const tune = {};
                for (const sp of specs) tune[sp.ref] = WC.readFields(sp.settings, v, `t:${sp.ref}:`);
                this._paintTune(v.wf, tune);
            }
            if (kind === "upscale") this.paintGenerate(rec, "upscale", { k: Number(v.k) || 2, ai: true, workflow: v.wf });
            else this.paintGenerate(rec, kind, { prompt: v.text || "", box: v.box === "yes", workflow: v.wf });
        }, note, {
            wide: true,
            onInput: (v) => {
                cur = v;
                if (v.wf && v.wf !== wid && shade) {         // another model: its own settings
                    shade.remove();
                    shade = null;
                    last[kind] = v.wf;
                    if (v.k) last.k = Number(v.k) || 2;
                    if (v.text !== undefined) last.text = v.text;
                    this.paintGenerateDialog(rec, kind, v.wf, v);
                }
            },
        });
        if (!known && item) {
            // Its settings were not known yet: asked now, and the dialog opened again with them (what was typed kept).
            this._paintTuneSpecs(item).then((sp) => {
                if (!sp.length || !shade || !shade.isConnected) return;
                shade.remove();
                shade = null;
                this.paintGenerateDialog(rec, kind, wid, cur);
            }).catch(() => { /* opened without them */ });
        }
    },

    /** One API graph into ComfyUI's queue: its prompt id. */
    async _paintQueue(graph) {
        const r = await queueWithAuth(api, 0, { output: graph, workflow: {} });   // with the sign-in: API nodes need it
        const id = r && (r.prompt_id || r.promptId);
        if (!id) {
            const errs = r && r.node_errors && Object.values(r.node_errors).map((x) => (x.errors || []).map((y) => y.message).join(", ")).join("; ");
            throw new Error(errs || "ComfyUI did not take the workflow");
        }
        return id;
    },

    /** The first picture of the output node of prompt *id*, when it has run: { filename, subfolder, type }. */
    _paintWait(id, outNode, tell = {}) {
        return new Promise((resolve, reject) => {
            let over = false, timer = null;
            let running = false;     // started: an interrupt then hits this prompt, not somebody else's
            const on = (k, ...v) => { if (k !== "stop") running = true; try { if (tell[k]) tell[k](...v); } catch (_) { /* only the bar */ } };
            const pick = (out) => {
                const im = out && out.images && out.images[0];
                return im && im.filename ? { filename: im.filename, subfolder: im.subfolder || "", type: im.type || "output" } : null;
            };
            const end = (fn, v) => {
                if (over) return;
                over = true;
                clearInterval(timer);
                for (const [n, f] of hooks) api.removeEventListener(n, f);
                fn(v);
            };
            const fromHistory = async () => {
                try {
                    const res = await api.fetchApi(`/history/${encodeURIComponent(id)}`);
                    if (!res.ok) return false;
                    const h = (await res.json())[id];
                    if (!h) return false;
                    const im = pick(h.outputs && h.outputs[outNode]);
                    if (im) { end(resolve, im); return true; }
                    const st = h.status || {};
                    if (st.completed || st.status_str === "error") {
                        const msg = (st.messages || []).find((m) => m[0] === "execution_error");
                        end(reject, new Error(msg ? msg[1].exception_message : "the workflow gave no picture"));
                        return true;
                    }
                } catch (_) { /* asked again */ }
                return false;
            };
            const hooks = [
                ["executed", (e) => { const d = e.detail || {}; if (d.prompt_id === id && String(d.node) === String(outNode)) { const im = pick(d.output); if (im) end(resolve, im); } }],
                ["execution_error", (e) => { const d = e.detail || {}; if (d.prompt_id === id) end(reject, new Error(d.exception_message || "the workflow failed")); }],
                ["execution_interrupted", (e) => { const d = e.detail || {}; if (d.prompt_id === id) end(reject, new Error("stopped")); }],
                ["execution_success", (e) => { const d = e.detail || {}; if (d.prompt_id === id) fromHistory(); }],
                // For the bar: when it starts, which node runs, how far a sampler is.
                ["execution_start", (e) => { const d = e.detail || {}; if (d.prompt_id === id) on("start"); }],
                ["executing", (e) => { const d = e.detail || {}; const pid = d.prompt_id, node = d.node ?? d.display_node;
                                       if (pid === id && node != null) on("node", String(node)); }],
                ["progress", (e) => { const d = e.detail || {}; if (d.prompt_id === id) on("progress", Number(d.value) || 0, Number(d.max) || 0, d.node != null ? String(d.node) : null); }],
            ];
            for (const [n, f] of hooks) api.addEventListener(n, f);
            // Stop: out of the queue when it has not started, else interrupted (only this prompt, where ComfyUI knows how).
            on("stop", async () => {
                try { await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [id] }) }); } catch (_) { /* gone already */ }
                if (running && !over) {
                    try { await api.fetchApi("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: id }) }); } catch (_) { /* nothing running */ }
                }
                end(reject, new Error("stopped"));
            });
            timer = setInterval(fromHistory, 5000);     // a message missed (the socket reconnected): ComfyUI's history knows
        });
    },

    /** The session's document as the server has it now: { doc, selection, path }. */
    _paintDescribe(rec) {
        return postJson("/imageviewer/paint/describe", { token: rec.token });
    },

    /** Ask agentY: save, snapshot, a brief with the paths and the edit_image call that brings the result back. */
    async _paintAsk(rec, kind, opts) {
        const bridge = window.agentYViewerBridge;
        if (!bridge || typeof bridge.feedback !== "function") {
            notice("warn", "agentY is not connected", "Generate asks agentY to make the pixels; open its panel first.");
            return;
        }
        const path = rec.editor.isDirty() || !rec.path ? await this.paintSave(rec) : rec.path;
        if (!path) return;
        let snap;
        try { snap = await postJson("/imageviewer/paint/snapshot", { token: rec.token }); }
        catch (e) { notice("error", "No snapshot", String(e.message || e)); return; }
        const box = snap.box ? `${snap.box.w}x${snap.box.h} at ${snap.box.x},${snap.box.y}` : "none";
        const prompt = String(opts.prompt || "").trim();
        const call = (...ops) => `edit_image(doc=${JSON.stringify(path)}, ops=[${ops.join(", ")}])`;
        const k = Number(opts.k) || 2;
        const how = {
            fill: `Generative fill: make "${prompt}" inside the selection. Inpaint the picture with the mask (white = change), then put `
                + `the result back with ${call(`{"op": "add_layer", "file": <result>, "name": ${JSON.stringify(prompt.slice(0, 30) || "Fill")}, "mask": "selection"}`)}.`,
            remove: "Remove what is selected: inpaint the masked part so that it looks as if it was never there (no new object), then put "
                + `the result back with ${call('{"op": "add_layer", "file": <result>, "name": "Removed", "mask": "selection"}')}.`,
            background: "Remove the background: make a matte of the main subject (white = subject) from the picture, then "
                + `${call('{"op": "mask", "layer": "active", "from": "file", "file": <matte>}')} (a layer mask - nothing is erased).`,
            select_subject: "Select the subject: make a matte of the main subject (white = subject) from the picture, then "
                + `${call('{"op": "select", "mode": "file", "file": <matte>}')}.`,
            select_objects: `Select ${prompt ? `"${prompt}"` : "what is inside the selection's box"}: make a matte of it (white = it) from the picture, then `
                + `${call('{"op": "select", "mode": "file", "file": <matte>}')}.`,
            extend: `Extend the picture: outpaint the selected border so that it continues the picture${prompt ? ` (${prompt})` : ""}, then put `
                + `the result back with ${call('{"op": "add_layer", "file": <result>, "name": "Extended", "mask": "selection", "below": "active"}')}.`,
            edit: `Edit the picture as the prompt says: "${prompt}"${snap.selection ? " (only inside the selection)" : ""}. Use the picture's own size `
                + `(${snap.w}x${snap.h}), then put the result back with ${call(`{"op": "add_layer", "file": <result>, "name": "Edit", "fit": "cover"${snap.selection ? ', "mask": "selection"' : ""}}`)}.`,
            upscale: `Upscale ${k}x with detail: run an upscale workflow on the picture, then `
                + `${call(`{"op": "resize", "scale": ${k}}`, '{"op": "add_layer", "file": <result>, "name": "Upscaled"}')}.`,
        }[kind];
        if (!how) return;
        const text = [`[Paint] ${how}`, `Document: ${path}`, `Picture (as it looks): ${snap.picture} (${snap.w}x${snap.h})`,
                      snap.selection ? `Mask of the selection: ${snap.selection} (box ${box})` : "No selection.",
                      opts.note || "", "Do not change the user's other layers. Read the document first with edit_image(doc=...) if you need its layers."]
            .filter(Boolean).join("\n");
        try {
            await bridge.feedback({ text });
            notice("info", "Asked agentY", "The result comes back as a new layer here.");
        } catch (e) { notice("error", "agentY was not asked", String(e.message || e)); }
    },

    // ── keys, drops, closing ─────────────────────────────────────────────────

    /** The editor's keys while a Paint tab is up and the pointer is over the viewer (or the editor has focus). */
    paintKeyDown(e) {
        const rec = this._paintActive();
        if (!rec || !rec.editor) return false;
        const path = e.composedPath ? e.composedPath() : [];
        const inPanels = Object.keys(PAINT_PANELS).some((id) => { const p = this._dockPanelEl && this._dockPanelEl(id); return p && path.includes(p); });
        if (!this.isHovered && !path.includes(rec.el) && !inPanels) return false;
        if (rec.editor.keyDown(e)) { e.stopImmediatePropagation(); return true; }
        return false;
    },

    paintKeyUp(e) {
        const rec = this._paintActive();
        return !!(rec && rec.editor && rec.editor.keyUp(e));
    },

    /** A history / file-browser picture dropped onto the editor: a layer of the picture there, else opened. */
    _paintWireDrop(host) {
        if (host.__paintDropWired) return;
        host.__paintDropWired = true;
        const TYPE = "application/x-imageviewer-history";
        const has = (e) => Array.from(e.dataTransfer?.types || []).includes(TYPE);
        host.addEventListener("dragover", (e) => { if (has(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
        host.addEventListener("drop", async (e) => {
            if (!has(e)) return;
            let payload = null;
            try { payload = JSON.parse(e.dataTransfer.getData(TYPE)); } catch (_) {}
            const items = (payload && Array.isArray(payload.items) ? payload.items : []).filter((x) => x && paintMayOpen(x));
            if (!items.length) return;
            e.preventDefault(); e.stopPropagation();
            const rec = this._paintActive();
            const ref = (x) => (x.path ? x.path : { filename: x.filename, subfolder: x.subfolder, type: x.type });
            if (rec && rec.editor && rec.editor.doc) { for (const it of items) await this.paintAddImage(rec, ref(it)); }
            else await this.paintOpen(ref(items[0]));
        });
    },

    /** "Edit in Paint" on a context menu (history thumbs, the file browser). */
    paintAddEditItem(menu, ref, before) {
        if (!menu || !paintMayOpen(ref)) return;
        const item = menu.ownerDocument.createElement("div");
        item.className = "thumb-ctx-item paint-edit-item";
        item.textContent = "\u{1F58C} Edit in Paint";
        item.onclick = (ev) => { ev.stopPropagation(); menu.remove(); this.paintOpen(ref); };
        if (before && before.parentNode === menu) menu.insertBefore(item, before); else menu.appendChild(item);
    },

    /** closeTab asks first: a picture with changes that were not saved says so once and stays. */
    paintTabClosing(key) {
        if (!this.isPaintTab(key)) return true;
        const rec = this._paintState().tabs[key];
        if (rec && rec.editor && rec.editor.isDirty() && this._paintCloseAsked !== key) {
            this._paintCloseAsked = key;
            notice("warn", "Unsaved changes", `${(rec.editor.doc && rec.editor.doc.name) || "The picture"} has changes that were not saved. Close the tab again to throw them away.`);
            return false;
        }
        this._paintCloseAsked = null;
        return true;
    },

    paintTabClosed(key) {
        const st = this._paintState();
        const rec = st.tabs[key];
        if (!rec) return;
        if (rec.editor) { try { rec.editor.dispose(); } catch (_) { /* already gone */ } }
        if (rec.el) rec.el.remove();
        delete st.tabs[key];
        if (this.activeTab === key) this._paintSeat(null);
    },

    /** The selection's box, kept while the selection is the same buffer (viewerState is read often). */
    _paintSelBox(ed) {
        const c = this._paintSelBoxKept;
        // Quick Mask paints the selection in place: nothing kept while it is on, or from before it.
        if (c && c.sel === ed.sel && !ed.quick) return c.box;
        const box = maskBBox(ed.sel, ed.doc.w, ed.doc.h);
        this._paintSelBoxKept = ed.quick ? null : { sel: ed.sel, box };
        return box;
    },

    /** viewerState().paint: what the agent reads of the Paint tab on screen. */
    _agentPaint() {
        const rec = this._paintActive();
        if (!rec) return null;
        const ed = rec.editor, d = ed && ed.doc;
        if (!d) return { open: true, empty: true };
        const L = ed.active();
        return { open: true, path: rec.path || "", source: rec.source || "", name: d.name, w: d.w, h: d.h,
                 layers: d.layers.length, active: L ? L.name : "", tool: ed.tool, selection: !!ed.sel, dirty: ed.isDirty(),
                 selection_box: ed.sel ? this._paintSelBox(ed) : null, token: rec.token || "" };
    },
};
