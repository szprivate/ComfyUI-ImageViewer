// imageViewer_compPanel.js
// Comp: a node graph of pixel operations (Nuke's way) over pictures, films and sequences, as a TAB of the
// viewer - a space of its own beside Motion, shaped like it.
//
// A comp is a file (*.comp.json). It gets a tab ("comp:<path>"), the picture fills the MAIN CANVAS, and its
// other parts are dock panels that come up with a comp tab and go with it: Node Graph (up by default - the
// node editor is how a comp is worked on), Properties, and Layers (the same graph as a stack of layers,
// After Effects' way; off by default). Without a comp the Comp button opens a tab that offers New and Open.
//
// TIME is the viewer's own bar, as in Motion: on a comp tab the playback mixin counts the comp's frames
// (_cpFrameCount) and hands setFrame here (_cpSetFrame); the fps and last-frame boxes edit the comp's format.
//
// The editor is imageViewer_compEditor.js (it knows nothing of the viewer); this mixin is the glue: the
// files (/imageviewer/comp, comp_new), a Read's pixels (/imageviewer/comp_pixels: float16 from the server's
// own reader, so EXR and films preview as they render), the Render dialog (the shared export dialog;
// /imageviewer/comp_render), and where a render lands: the History, and the ComfyUI canvas as a loader node.
import { api } from "../../scripts/api.js";
import { createCompEditor } from "./imageViewer_compEditor.js";
import { canvasContext, notice, openExportDialog, openFilePicker } from "./imageViewer_exportUI.js";
import { addRecentDoc } from "./imageViewer_recentDocs.js";
import { COMP_SUFFIX, isCompPath, sourceName } from "./imageViewer_compModel.js";

export const COMP_PREFIX = "comp:";
/** The dock panels of a comp tab, and the editor part each one holds. */
export const COMP_PANELS = { compGraph: "graph", compProps: "props", compLayers: "layers" };
/** Which of them are up the first time (the node editor is the default way in). */
const FIRST_UP = { compGraph: true, compProps: true, compLayers: false };

const baseOf = (p) => String(p || "").split(/[\\/]/).pop();
const nameOf = (p) => baseOf(p).replace(/\.comp\.json$/i, "");
const MEDIA_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".exr", ".hdr", ".bmp",
    ".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"];
const CACHE_BYTES = 768 * 1024 * 1024;
/** A picked file that looks like one frame of a numbered still sequence (shot.0012.exr, plate_1001.png). */
const SEQ_FRAME = /[._]\d{3,}\.(exr|png|jpe?g|tiff?|hdr|webp|bmp)$/i;

// float16 -> float32, once.
let F16 = null;
function f16Table() {
    if (F16) return F16;
    F16 = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
        F16[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
    }
    return F16;
}

/** A sequence's frame numbers as the user writes them: shot.0001.exr picked -> shot.####.exr. */
export function asSequencePattern(path, isSeq) {
    if (!isSeq) return path;
    return String(path).replace(/(\d+)(\.[A-Za-z0-9]+)$/, (_, d, ext) => "#".repeat(d.length) + ext);
}

export const CompPanelMixin = {

    _cpState() {
        if (!this._cp) this._cp = { tabs: {}, want: {}, host: null, cache: new Map(), cacheBytes: 0, infos: new Map(), last: {} };
        return this._cp;
    },

    isCompTab(key = this.activeTab) {
        return typeof key === "string" && key.startsWith(COMP_PREFIX);
    },

    // ── opening ──────────────────────────────────────────────────────────────

    /** Open a comp file in a comp tab (and show the viewer). */
    async compOpenFile(path) {
        const st = this._cpState();
        let data;
        try {
            const res = await api.fetchApi(`/imageviewer/comp?path=${encodeURIComponent(path)}`);
            data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        } catch (e) {
            notice("error", "Cannot open the comp", String(e.message || e));
            return false;
        }
        this._cpShowDoc(data.path, data.comp);
        return true;
    },

    _cpShowDoc(path, comp) {
        const st = this._cpState();
        const key = COMP_PREFIX + path;
        addRecentDoc("comp", path);
        let rec = st.tabs[key];
        if (this.allTabs[key] && rec) {
            if (rec.editor && rec.editor.isDirty()) notice("info", "The comp is open with changes", "Save or close its tab to read the file again.");
            else if (rec.editor) rec.editor.load(comp, path);
            else rec.pending = comp;
        } else {
            rec = st.tabs[key] = { path, pending: comp, el: null, editor: null };
            this._cpMakeTab(key, nameOf(path));
        }
        if (this.requestPanelOpen) this.requestPanelOpen();
        this.switchTab(key);
        if (this.allTabs[COMP_PREFIX]) this.closeTab(COMP_PREFIX);
    },

    /** A new comp file, by the export rule (in the shot's folder when the canvas names one). */
    async compNew(name = "comp") {
        try {
            const res = await api.fetchApi("/imageviewer/comp_new", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, context: canvasContext() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            this._cpShowDoc(data.path, data.comp);
            return data.path;
        } catch (e) {
            notice("error", "No new comp", String(e.message || e));
            return null;
        }
    },

    /** The Comp button: the tab that is open, else a tab that offers New and Open. */
    compBarOpen() {
        const open = (this.tabOrder || []).find((k) => this.isCompTab(k) && this.allTabs[k]);
        if (open) { this.switchTab(open); return; }
        this._cpState().tabs[COMP_PREFIX] = { path: "", el: null, editor: null };
        this._cpMakeTab(COMP_PREFIX, "Comp");
        if (this.requestPanelOpen) this.requestPanelOpen();
        this.switchTab(COMP_PREFIX);
    },

    _cpMakeTab(key, label) {
        this.allTabs[key] = [];
        this.tabLabels[key] = "\u{1F39E}\u{FE0F} " + label;
        if (!this.tabOrder.includes(key)) this.tabOrder.push(key);
        this._rebuildTabBar(null);
    },

    async compPickFile() {
        await openFilePicker(this.container, {
            id: "comp", title: "Open a comp", kind: "comp", exts: [".json"], go: "Open",
            note: `A comp file (*${COMP_SUFFIX}).`,
            onPick: async ([file]) => {
                if (!file) return { ok: false, message: "Pick a file." };
                if (!isCompPath(file.path || file.name)) return { ok: false, message: `${file.name} is not a comp (*${COMP_SUFFIX}).` };
                return (await this.compOpenFile(file.path)) ? { ok: true } : { ok: false, message: `Could not open ${file.name}.` };
            },
        });
    },

    // ── the tab on screen ────────────────────────────────────────────────────

    _cpHostEl() {
        const st = this._cpState();
        if (st.host && st.host.isConnected) return st.host;
        const doc = this.viewport.ownerDocument;
        const host = doc.createElement("div");
        host.className = "comp-view";
        for (const type of ["mousedown", "wheel", "contextmenu", "dblclick"]) host.addEventListener(type, (e) => e.stopPropagation());
        this.viewport.append(host);
        st.host = host;
        return host;
    },

    compTabEnter(key) {
        const st = this._cpState();
        let rec = st.tabs[key];
        if (!rec) rec = st.tabs[key] = { path: key.slice(COMP_PREFIX.length), el: null, editor: null };
        const first = !this._cpOn;
        this._cpOn = true;
        this.viewport.classList.add("comp-mode");
        const host = this._cpHostEl();
        host.style.display = "block";
        if (!rec.el) {
            rec.el = host.ownerDocument.createElement("div");
            rec.el.className = "comp-tab";
            host.append(rec.el);
        }
        for (const other of Object.values(st.tabs)) if (other.el) other.el.style.display = other === rec ? "block" : "none";
        this.stop();
        if (!rec.editor && !rec.shown) this._cpBuild(key, rec);
        if (this.setPanelDocked) {
            for (const id of Object.keys(COMP_PANELS)) {
                const want = st.want[id] === undefined ? FIRST_UP[id] : st.want[id];
                if (want !== this.isPanelDocked(id)) this.setPanelDocked(id, want);
            }
        }
        this._cpSeat(rec);
        this._cpSyncBar();
        if (first && this.barGroupsSync) this.barGroupsSync();
    },

    compTabLeave() {
        if (!this._cpOn) return;
        const st = this._cpState();
        this._cpOn = false;
        this.stop();
        if (this._cpSavedFps != null) { this._setFpsUi(this._cpSavedFps); this._cpSavedFps = null; }
        const endEl = this.container.querySelector("#total-f");
        if (endEl) { endEl.readOnly = true; endEl.classList.remove("editable"); endEl.title = "Last frame"; }
        this.viewport.classList.remove("comp-mode");
        if (st.host) st.host.style.display = "none";
        this._cpSeatBottom(null);
        if (this.isPanelDocked && this.setPanelDocked) {
            for (const id of Object.keys(COMP_PANELS)) {
                st.want[id] = this.isPanelDocked(id);
                if (this.isPanelDocked(id)) this.setPanelDocked(id, false);
            }
        }
        if (this.barGroupsSync) this.barGroupsSync();
    },

    // ── time: the viewer's bar drives the comp ───────────────────────────────

    _cpActive() { return this._cpOn ? this._cpState().tabs[this.activeTab] || null : null; },

    /** The editor of the comp tab on screen, or null (the agent's state and the tests read it). */
    compEditor() { const r = this._cpActive(); return r ? r.editor : null; },

    _cpFrameCount() {
        const rec = this._cpActive();
        const c = rec && rec.editor ? rec.editor.comp() : null;
        return c ? c.format.frames : 0;
    },

    _cpSetFrame(idx) {
        const rec = this._cpActive();
        const ed = rec && rec.editor;
        const max = Math.max(0, this._cpFrameCount() - 1);
        const f = Math.max(0, Math.min(Math.round(Number(idx) || 0), max));
        this.currentFrame = f;
        this.timeline.value = f;
        const cur = this.container.querySelector("#cur-f");
        if (cur) cur.innerText = f;
        if (ed && ed.state.frame !== f) ed.setFrame(f, { fromHost: true });
    },

    _cpSyncBar() {
        if (!this._cpOn) return;
        const rec = this._cpActive();
        const ed = rec && rec.editor;
        const c = ed ? ed.comp() : null;
        const fps = c ? c.format.fps : 0;
        if (fps > 0 && this.fps !== fps) {
            if (this._cpSavedFps == null) this._cpSavedFps = this.fps;
            const was = this.isPlaying;
            this._setFpsUi(fps);
            if (was) { this.stop(); this.play(); }
        }
        this.applyTimelineBounds();
        const f = ed ? Math.min(ed.state.frame, Math.max(0, this._cpFrameCount() - 1)) : 0;
        this.currentFrame = f;
        this.timeline.value = f;
        const cur = this.container.querySelector("#cur-f");
        if (cur) cur.innerText = f;
        const endEl = this.container.querySelector("#total-f");
        if (endEl) {
            endEl.readOnly = !c;
            endEl.classList.toggle("editable", !!c);
            endEl.title = c ? "The comp's last frame - type to make it longer or shorter" : "Last frame";
        }
    },

    /** The bar's last-frame / fps boxes: Motion's patch ({duration} = frames, {fps}) onto the comp's format. */
    compSetFormat(patch) {
        const rec = this._cpActive();
        if (!rec || !rec.editor) return;
        const f = {};
        if (patch.duration != null) f.frames = Math.max(1, Math.round(patch.duration));
        if (patch.fps != null && patch.fps > 0) f.fps = patch.fps;
        if (Object.keys(f).length) rec.editor.setFormat(f);
    },

    _cpSeat(rec) {
        for (const [id, part] of Object.entries(COMP_PANELS)) {
            const slot = this._cpSlot(id);
            if (!slot) continue;
            const el = rec && rec.editor && rec.editor.parts ? rec.editor.parts[part] : null;
            if (el && part === "graph" && this._cpBottom) {
                // The graph is in ComfyUI's bottom panel (imageViewer_compComfyTab.js); this panel says where.
                const note = this._cpNote(slot.ownerDocument, "The node graph is open in ComfyUI's bottom panel (its Comp tab). ");
                const back = slot.ownerDocument.createElement("button");
                back.className = "mg-btn";
                back.textContent = "Show it here";
                back.addEventListener("click", () => this.compBottomDetach(this._cpBottom));
                note.append(back);
                slot.replaceChildren(note);
            } else if (el) { if (slot.firstChild !== el || slot.childNodes.length !== 1) slot.replaceChildren(el); }
            else slot.replaceChildren(this._cpNote(slot.ownerDocument, "Open a comp to see its " + (part === "graph" ? "node graph" : part) + "."));
        }
        this._cpSeatBottom(rec);
        if (rec && rec.editor) requestAnimationFrame(() => rec.editor.relayout && rec.editor.relayout());
    },

    // ── ComfyUI's bottom panel (imageViewer_compComfyTab.js) ─────────────────

    /** The bottom panel's Comp tab is up: the graph of the comp on screen goes there. */
    compBottomAttach(slot) {
        this._cpBottom = slot;
        this._cpSeat(this._cpActive());
    },

    /** It went (or "Show it here"): the graph comes back to the Node Graph panel. */
    compBottomDetach(slot) {
        if (slot && this._cpBottom !== slot) return;
        const was = this._cpBottom;
        this._cpBottom = null;
        this._cpSeat(this._cpActive());
        if (was && was.isConnected) this._cpSeatBottomNote(was, "The node graph is in the viewer's Node Graph panel.", "Show it here",
            () => this.compBottomAttach(was));
    },

    _cpSeatBottom(rec) {
        const slot = this._cpBottom;
        if (!slot) return;
        const el = rec && rec.editor && rec.editor.parts ? rec.editor.parts.graph : null;
        if (el) { if (slot.firstChild !== el || slot.childNodes.length !== 1) slot.replaceChildren(el); return; }
        this._cpSeatBottomNote(slot, "The viewer is not on a comp. Its node graph shows here while it is.", "Open Comp…", () => {
            if (this.requestPanelOpen) this.requestPanelOpen();
            this.spaceOpen("comp");
        });
    },

    _cpSeatBottomNote(slot, text, label, fn) {
        const doc = slot.ownerDocument;
        const box = doc.createElement("div");
        box.className = "ivc-note";
        box.append(Object.assign(doc.createElement("div"), { textContent: text }));
        const b = doc.createElement("button");
        b.textContent = label;
        b.addEventListener("click", fn);
        box.append(b);
        slot.replaceChildren(box);
    },

    _cpSlot(id) {
        const panel = this._dockPanelEl ? this._dockPanelEl(id) : null;
        return panel ? panel.querySelector(":scope > .comp-slot") : null;
    },

    /** A comp panel was opened (the bar's Comp group, a tab of the dock): its part goes into it. */
    compPanelShown() { if (this._cpOn) this._cpSeat(this._cpActive()); },

    _cpNote(doc, text) {
        const n = doc.createElement("div");
        n.className = "mg-note";
        n.textContent = text;
        return n;
    },

    async _cpBuild(key, rec) {
        const doc = rec.el.ownerDocument;
        rec.shown = true;
        if (!rec.path) { this._cpEmptyState(rec); return; }
        if (!rec.pending) {
            try {
                const res = await api.fetchApi(`/imageviewer/comp?path=${encodeURIComponent(rec.path)}`);
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                rec.pending = data.comp;
            } catch (e) {
                rec.el.replaceChildren(this._cpNote(doc, `Cannot open ${baseOf(rec.path)}: ${e.message || e}`));
                return;
            }
        }
        const comp = rec.pending;
        rec.pending = null;
        rec.el.replaceChildren();
        const stage = doc.createElement("div");
        stage.className = "comp-stage";
        rec.el.append(stage);
        const bounds = () => this.getTimelineBounds();
        rec.editor = createCompEditor(stage, {
            transport: {
                toggle: () => { this.isPlaying ? this.stop() : this.play(); },
                step: (n) => this.step(n),
                first: () => { this.stop(); this.setFrame(bounds().min); },
                last: () => { this.stop(); this.setFrame(bounds().max); },
            },
            onFrame: (f) => { if (this.activeTab === key) { this.stop(); this.setFrame(f); } },
            onComp: () => { if (this.activeTab === key) this._cpSyncBar(); },
            showProps: () => { if (this.setPanelDocked && !this.isPanelDocked("compProps")) this.setPanelDocked("compProps", true); else if (this.dockTabFront) this.dockTabFront("compProps"); },
            loadSource: (node, frame, how) => this._cpLoadSource(rec, node, frame, how),
            sourceInfo: (node) => this._cpSourceInfo(rec, node),
            pickFile: (cb) => this._cpPickFootage(cb),
            pathsOf: (items) => this.compPathsOf(items),
            save: (path, c) => this._cpSave(path, c),
            render: () => this.compRenderDialog(rec),
            notify: (m, sev) => notice(sev || "info", m),
        });
        const check = rec.editor.load(comp, rec.path);
        if (!check.ok) notice("warn", "The comp has problems", check.errors.slice(0, 3).join("; "));
        if (this.activeTab === key) { this._cpSyncBar(); this._cpSeat(rec); }
    },

    _cpEmptyState(rec) {
        const doc = rec.el.ownerDocument;
        const box = doc.createElement("div");
        box.className = "mg-open-state";
        const h = doc.createElement("div");
        h.className = "mg-open-title";
        h.textContent = "Comp";
        const p = doc.createElement("div");
        p.className = "mg-open-text";
        p.textContent = "A node graph over pictures, films and sequences: Merge, Transform, Grade, Blur, keyed over time, "
            + "in linear float. Make a new comp, or open a *.comp.json.";
        const row = doc.createElement("div");
        row.style.cssText = "display:flex;gap:8px;justify-content:center";
        const mk = (label, fn) => { const b = doc.createElement("button"); b.className = "mg-open-btn"; b.textContent = label; b.addEventListener("click", fn); return b; };
        row.append(mk("New comp", () => this.compNew()), mk("Open…", () => this.compPickFile()));
        box.append(h, p, row);
        rec.el.replaceChildren(box);
    },

    // ── what the Reads show ──────────────────────────────────────────────────

    async _cpSourceInfo(rec, node) {
        const st = this._cpState();
        const key = `${rec.path}|${node.file}`;
        if (st.infos.has(key)) return st.infos.get(key);
        const q = new URLSearchParams({ file: node.file || "", comp: rec.path });
        const p = api.fetchApi(`/imageviewer/comp_source?${q}`).then((r) => r.json()).catch(() => ({ kind: "missing" }));
        st.infos.set(key, p);
        const info = await p;
        if (info.kind === "missing") setTimeout(() => st.infos.delete(key), 3000);   // it may be written yet
        return info;
    },

    async _cpLoadSource(rec, node, frame, how = {}) {
        if (!node.file) return null;
        const st = this._cpState();
        const info = await this._cpSourceInfo(rec, node);
        if (!info || !["still", "sequence", "video"].includes(info.kind)) return null;
        const fmt = how.format || { width: 1920, height: 1080 };
        const most = Math.min(4096, Math.max(64, Math.ceil(Math.max(fmt.width, fmt.height) * (how.scale || 1) * 1.5)));
        const f = info.kind === "still" ? 0 : frame;
        const key = [rec.path, node.file, node.colorspace || "auto", node.offset || 0, f, most].join("|");
        const hit = st.cache.get(key);
        if (hit) { st.cache.delete(key); st.cache.set(key, hit); return hit; }
        const q = new URLSearchParams({ file: node.file, comp: rec.path, frame: String(frame), offset: String(node.offset || 0),
            cs: node.colorspace || "auto", max: String(most) });
        const res = await api.fetchApi(`/imageviewer/comp_pixels?${q}`);
        if (!res.ok) return null;
        const w = Number(res.headers.get("X-Comp-W")), h = Number(res.headers.get("X-Comp-H"));
        let buf = await res.arrayBuffer();
        if (res.headers.get("X-ImageViewer-Enc") === "gzip" || new Uint8Array(buf, 0, 2)[0] === 0x1f) {
            buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        }
        const half = new Uint16Array(buf);
        const T = f16Table();
        const data = new Float32Array(half.length);
        for (let i = 0; i < half.length; i++) data[i] = T[half[i]];
        const pic = { w, h, data, ow: Number(res.headers.get("X-Comp-OW")) || w, oh: Number(res.headers.get("X-Comp-OH")) || h };
        st.cache.set(key, pic);
        st.cacheBytes += data.byteLength;
        while (st.cacheBytes > CACHE_BYTES && st.cache.size > 1) {
            const [k, v] = st.cache.entries().next().value;
            st.cache.delete(k);
            st.cacheBytes -= v.data.byteLength;
        }
        return pic;
    },

    _cpPickFootage(cb) {
        openFilePicker(this.container, {
            id: "comp-footage", title: "Footage for the comp", kind: "image", exts: MEDIA_EXTS, go: "Use",
            note: "A picture, a film, or one frame of a numbered sequence (the whole sequence is used).",
            onPick: async ([file]) => {
                if (!file) return { ok: false, message: "Pick a file." };
                cb(asSequencePattern(file.path, SEQ_FRAME.test(file.name)));
                return { ok: true };
            },
        });
    },

    /** Something dragged out of the History onto a comp: the files it names, as paths (sequences as patterns). */
    compPathsOf(items) {
        const out = [];
        for (const it of items || []) {
            if (!it) continue;
            let p = it.path || "";
            if (it.isSequence && p) p = asSequencePattern(p, true);
            if (p) out.push(p);
        }
        return out;
    },

    // ── closing ──────────────────────────────────────────────────────────────

    compTabClosing(key) {
        if (!this.isCompTab(key)) return true;
        const rec = this._cpState().tabs[key];
        if (rec && rec.editor && rec.editor.isDirty() && this._cpCloseAsked !== key) {
            this._cpCloseAsked = key;
            notice("warn", "Unsaved changes", `${baseOf(rec.path)} has changes that were not saved. Close the tab again to throw them away.`);
            return false;
        }
        this._cpCloseAsked = null;
        return true;
    },

    compTabClosed(key) {
        const st = this._cpState();
        const rec = st.tabs[key];
        if (!rec) return;
        if (rec.editor) { try { rec.editor.dispose(); } catch (_) { /* already gone */ } }
        if (rec.el) rec.el.remove();
        delete st.tabs[key];
        if (this.activeTab === key) this._cpSeat(null);
    },

    // ── saving, rendering, where a render lands ──────────────────────────────

    async _cpSave(path, comp) {
        const res = await api.fetchApi("/imageviewer/comp", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, comp }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        addRecentDoc("comp", path);
    },

    /** The export dialog every export of the viewer uses, for the comp's Output. */
    async compRenderDialog(rec = this._cpActive()) {
        if (!rec || !rec.editor || !rec.path) return null;
        const ed = rec.editor;
        const st = this._cpState();
        const last = st.last;
        const frames = ed.comp().format.frames;
        const range = this.playbackRange;
        let rangeSel, codecSel, qualitySel, canvasBox;
        return openExportDialog(this.container, {
            title: "Render comp", kind: "comp", name: nameOf(rec.path), go: "Render",
            fixed: [
                { value: "png", label: "PNG sequence (8-bit, alpha)" },
                { value: "exr", label: "EXR sequence (linear, half float)" },
                { value: "tif", label: "TIFF sequence (8-bit, alpha)" },
                { value: "mp4", label: "MP4 film" },
                { value: "mov", label: "MOV film" },
                { value: "webm", label: "WebM film" },
            ],
            values: { format: last.format || "png" },
            rows: (make) => {
                const opts = [["all", `All frames (0–${frames - 1})`], ["here", `This frame (${ed.state.frame})`]];
                if (range && range.end > range.start) opts.splice(1, 0, ["range", `In to out (${range.start}–${range.end})`]);
                rangeSel = make.select(opts, last.range || "all");
                codecSel = make.select([["prores", "ProRes 422"], ["h264", "H.264"]], last.codec || "prores");
                qualitySel = make.select([["high", "High"], ["medium", "Medium"], ["low", "Low"]], last.quality || "high");
                const film = make.row("Film", make.el("span", "rd-sub", "Codec"), codecSel, make.el("span", "rd-sub", "Quality"), qualitySel);
                canvasBox = make.el("input");
                canvasBox.type = "checkbox";
                canvasBox.checked = last.canvas !== false;
                const lab = make.el("label", "rd-inline");
                lab.append(canvasBox, make.el("span", "", " and a loader node on the ComfyUI canvas"));
                // The film row is for films only, and the codec choice for MOV only. The format menu is the
                // dialog's first select (made before these rows).
                const sync = () => {
                    const sel = this.container.querySelector(".export-dlg .rd-box select");
                    const fmt = sel ? sel.value : "";
                    film.style.display = /^(mp4|mov|webm)$/.test(fmt) ? "" : "none";
                    for (const n of [codecSel, codecSel.previousSibling]) if (n) n.style.display = fmt === "mov" ? "" : "none";
                };
                requestAnimationFrame(() => {
                    const sel = this.container.querySelector(".export-dlg .rd-box select");
                    if (sel) sel.addEventListener("change", sync);
                    sync();
                });
                return [make.row("Frames", rangeSel), film, make.row("Lands in", make.el("span", "rd-sub", "The History"), lab)];
            },
            note: "Rendered here in full float, at full size, whatever the preview's proxy is.",
            onExport: async (v, ui) => {
                const which = rangeSel.value;
                const [first, lastF] = which === "here" ? [ed.state.frame, ed.state.frame]
                    : which === "range" && range ? [range.start, range.end] : [0, frames - 1];
                Object.assign(st.last, { format: v.format, range: which, codec: codecSel.value, quality: qualitySel.value, canvas: canvasBox.checked });
                if (ed.isDirty()) await ed.save();
                if (ed.isDirty()) return { ok: false, message: "The comp could not be saved, so it was not rendered." };
                const got = await this.compRender(rec.path, {
                    format: v.format, name: v.name, context: v.context, first, last: lastF,
                    codec: v.format === "mov" ? codecSel.value : undefined, quality: qualitySel.value,
                }, (done, total) => ui.progress(done, total, `Frame ${done} of ${total}`));
                if (!got.ok) return got;
                this.compLand(got.result, { canvas: canvasBox.checked });
                return { ok: true };
            },
        });
    },

    /** Render the saved comp on the server and wait for it: {ok, result} or {ok: false, message}. */
    async compRender(path, spec, progress) {
        const res = await api.fetchApi("/imageviewer/comp_render", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ path }, spec)),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: true, message: data.error || `HTTP ${res.status}` };
        for (;;) {
            await new Promise((r) => setTimeout(r, 300));
            const r = await api.fetchApi(`/imageviewer/comp_render?job=${encodeURIComponent(data.job)}`);
            const s = await r.json().catch(() => ({}));
            if (progress) progress(s.done || 0, s.total || data.total || 1);
            if (s.state === "done") return { ok: true, result: s.result };
            if (s.state !== "running") return { ok: false, error: true, message: s.error || "The render stopped." };
        }
    },

    /** A finished render: said with its path, put in the History, and (unless asked not to) on the canvas. */
    async compLand(result, { canvas = true } = {}) {
        if (!result) return;
        notice("success", "Comp rendered", "output/" + (result.relative || baseOf(result.path)));
        if (result.notes && result.notes.length) notice("warn", "Some footage was not there", result.notes.slice(0, 3).join("; "));
        const landed = result.kind === "video" ? [result.path] : (result.paths || [result.path]);
        if (this.exportLanded) this.exportLanded(landed);
        if (canvas && this.previzNodeForRender) {
            await this.previzNodeForRender(result.kind === "video"
                ? { kind: "video", path: result.path }
                : { kind: "image", isSequence: !!result.isSequence, seqDir: result.seqDir, path: result.path });
        }
    },
};

export { sourceName };
