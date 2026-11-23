// imageViewer_previzMatchmove.js
// The 3D space's matchmove: two dock panels and a menu.
//
//   Matchmove (dock id mmGuide)  the guide - seven steps (plate, lens, masks, track, solve, objects, scene), each
//                                with what it is for, its controls and what to watch out for.
//   Plate     (dock id mmPlate)  the plate at the viewer's frame, with the tracks, their trails, the masks, the lens
//                                lines and the solved points drawn over it; select, add, move and delete tracks,
//                                draw masks and lines.
//   Matchmove menu (the 3D menu bar) and the lower bar's Matchmove group open them.
//
// The heavy data (every track's keys, the solve) is a file of its own, <name>_v###.mm.json, saved by the export
// rule and then over itself (POST /imageviewer/mm_save); the scene only names it (scene.matchmove.file) and holds
// what was built from it: a "Matchmove" group whose transform is the orientation, the camera keyed on every
// frame, the undistorted plate on it, the tracked points as locators, the objects. The maths is the server's
// (src/matchmove*.py); the arithmetic on the page is imageViewer_matchmoveData.js. Written from scratch.
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import * as D from "./imageViewer_matchmoveData.js";
import * as MS from "./imageViewer_maskShape.js";
import { openFilePicker, notice, canvasContext } from "./imageViewer_exportUI.js";
import { openLensChart } from "./imageViewer_lensChart.js";
import { createMmGuideInstance, createMmPlateInstance } from "./imageViewer_previzMatchmoveInstance.js";

const PLATE_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".exr", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".dpx", ".heic", ".heif"];
const PICT_EXTS = [".exr", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".dpx", ".mp4", ".mov"];
const UNDO = 30;
const BACKPLATE_DISTANCE = 50;  // solve units (its points' median distance is 10)
const MAX_POINTS = 400;
const PLATE_SIZE = 1920;        // the longest side of the plate's pictures on the image plane         // locators made of the solved points (the best by error)

const STYLE = `
.mm-body { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; color: #ddd; container-type: inline-size; }
.mm-steps { display: flex; flex-wrap: nowrap; gap: 2px; padding: 6px 6px 4px; border-bottom: 1px solid #333; }
.mm-chip { flex: 1 1 0; min-width: 0; min-height: 24px; display: flex; align-items: center; justify-content: center; gap: 4px; padding: 3px 4px;
  border-radius: 4px; border: 1px solid #3a3a3a; background: #252525; color: #aaa; font-size: 11px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.mm-chip .mm-chip-n { flex: none; width: 15px; height: 15px; line-height: 15px; border-radius: 50%; background: #333; color: #ccc; font-size: 10px; text-align: center; }
.mm-chip .mm-chip-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mm-chip.done { color: #9fd89f; border-color: #345; }
.mm-chip.done .mm-chip-n { background: #2f4a33; color: #9fd89f; }
.mm-chip.on { flex: 0 0 auto; background: #ff6600; color: #fff; border-color: #ff6600; }
.mm-chip.on .mm-chip-n { background: rgba(0, 0, 0, 0.25); color: #fff; }
@container (max-width: 420px) { .mm-chip:not(.on) .mm-chip-l { display: none; } }
.mm-scroll { flex: 1 1 auto; overflow: auto; padding: 8px 10px 10px; }
.mm-title { font-size: 14px; font-weight: 600; margin: 2px 0 4px; }
.mm-help { color: #bbb; line-height: 1.4; margin-bottom: 8px; }
.mm-more-text { display: none; }
.mm-open .mm-more-text { display: inline; }
.mm-q { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; min-width: 15px; min-height: 0; max-height: 15px;
  box-sizing: border-box; margin-left: 5px; padding: 0;
  border-radius: 50%; border: 1px solid #555; background: none; color: #aaa; font-size: 10px; line-height: 1; cursor: pointer; vertical-align: 1px; }
.mm-q:hover, .mm-open .mm-q { border-color: #ff6600; color: #ff6600; }
.mm-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; flex-wrap: wrap; }
.mm-row.mm-lab { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px; }
.mm-row.mm-lab > label { color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-fields { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.mm-row.mm-lab > .mm-fields:not(.mm-wrap) { flex-wrap: nowrap; }
.mm-row.mm-lab > .mm-fields > * { flex: 0 1 auto; min-width: 0; }
.mm-row.mm-lab > .mm-fields > input { flex: 0 0 auto; }
.mm-row.mm-lab > .mm-fields > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mm-row > label { color: #aaa; min-width: 84px; }
.mm-row input[type=number], .mm-row input[type=text] { width: 58px; background: #1b1b1b; color: #eee; border: 1px solid #3a3a3a; border-radius: 3px; padding: 2px 4px; }
.mm-row select { background: #1b1b1b; color: #eee; border: 1px solid #3a3a3a; border-radius: 3px; min-height: 22px; padding: 2px 4px; text-align: left; max-width: 100%; text-overflow: ellipsis; }
.mm-btn { background: #2d2d2d; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 3px 9px; cursor: pointer; font-size: 12px; min-height: 24px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mm-btn:hover { border-color: #777; }
.mm-btn.primary { background: #ff6600; border-color: #ff6600; color: #fff; }
.mm-btn.on { background: rgba(255, 102, 0, 0.22); border-color: #ff6600; color: #fff; }
.mm-ai-mask { border-left: 2px solid #ff6600; padding-left: 8px; margin: 2px 0 8px; }
.mm-btn:disabled { opacity: 0.45; cursor: default; }
.mm-note { color: #9a9a9a; font-size: 11px; margin: 4px 0; line-height: 1.35; }
.mm-note.warn { color: #e8b04a; }
.mm-note.bad { color: #ef6b6b; }
.mm-good { color: #9fd89f; }
.mm-summary { display: flex; align-items: center; gap: 6px; margin: 2px 0 8px; font-weight: 600; }
.mm-summary .mm-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #e8b04a; }
.mm-summary.good .mm-dot { background: #6fcf7f; }
.mm-summary.bad .mm-dot { background: #ef6b6b; }
.mm-fold { border-top: 1px solid #2e2e2e; margin: 0; }
.mm-fold > summary { cursor: pointer; color: #bbb; padding: 5px 0; list-style: none; display: flex; align-items: center; gap: 6px; }
.mm-fold > summary::-webkit-details-marker { display: none; }
.mm-fold > summary::before { content: "▸"; color: #777; width: 9px; }
.mm-fold[open] > summary::before { content: "▾"; }
.mm-fold > summary .mm-fold-sum { margin-left: auto; color: #888; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mm-fold > .mm-fold-body { padding: 0 0 6px; }
.mm-saved { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.mm-saved .mm-note { margin: 0; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-saved .mm-btn { padding: 1px 7px; font-size: 11px; flex: none; }
.mm-facts { background: #1c1c1c; border: 1px solid #333; border-radius: 4px; padding: 6px 8px; margin: 6px 0; line-height: 1.5; }
.mm-tips { margin-top: 10px; border-top: 1px solid #333; padding-top: 6px; }
.mm-tips summary { cursor: pointer; color: #aaa; }
.mm-tips li { color: #aaa; margin: 4px 0; line-height: 1.35; }
.mm-list { border: 1px solid #333; border-radius: 4px; max-height: 160px; overflow: auto; margin: 4px 0; }
.mm-li { display: flex; align-items: center; gap: 6px; padding: 2px 6px; border-bottom: 1px solid #2a2a2a; cursor: pointer; }
.mm-li:hover { background: #2a2a2a; }
.mm-li.sel { background: #3a2a1a; }
.mm-li .grow { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-graph { width: 100%; height: 60px; background: #1a1a1a; border: 1px solid #333; border-radius: 3px; display: block; margin: 4px 0; }
.mm-nav { display: flex; justify-content: space-between; padding: 6px 8px; border-top: 1px solid #333; }
.mm-progress { height: 4px; background: #333; border-radius: 2px; overflow: hidden; margin: 4px 0; }
.mm-progress > div { height: 100%; background: #ff6600; width: 0; }
.mm-plate { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.mm-pbar { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-bottom: 1px solid #333; flex-wrap: nowrap; overflow: hidden; }
.mm-pbar .mm-btn { padding: 2px 7px; font-size: 11px; flex: none; min-height: 22px; }
.mm-pbar .mm-btn.edit-iconbtn { padding: 2px 5px; gap: 4px; }
.mm-pbar .mm-btn .edit-icon { width: 14px; height: 14px; }
.mm-pgroup { display: flex; align-items: center; gap: 2px; flex: none; }
.mm-psep { width: 1px; height: 16px; background: #3a3a3a; margin: 0 4px; flex: none; }
.mm-pbar .mm-btn.on { background: #ff6600; border-color: #ff6600; color: #fff; }
.mm-pbar .mm-info { margin-left: auto; color: #999; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mm-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; background: #111; outline: none; }
.mm-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.mm-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #888; text-align: center; padding: 12px; }
`;

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stemOf = (p) => String(p || "").split(/[\\/]/).pop().replace(/\.mm\.json$|\.[^.]+$/, "").replace(/[.#%]+\d*d?$/, "").replace(/[._-]+$/, "") || "plate";

/** The error graph's top: 1.5 px at least, else a little over most frames' error, so one wild frame does not flatten
 *  the rest (it is drawn to the top, red). */
export function errorScale(per) {
    const v = per.filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return 1.5;
    const p95 = v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
    return Math.max(1.5, Math.min(v[v.length - 1], p95 * 1.25));
}

export const PrevizMatchmoveMixin = {

    // ── the state of this tab's matchmove ────────────────────────────────────

    _mmCur(create = true) {
        this._mmRegisterMakers();
        if (!this.isPrevizTab || !this.isPrevizTab()) return null;
        const key = this.activeTab;
        this._mmTabs = this._mmTabs || {};
        let st = this._mmTabs[key];
        if (!st && create) {
            st = this._mmTabs[key] = { key, mm: D.newMatchmove(), file: null, sel: new Set(), tool: "select",
                                       undo: [], redo: [], frames: new Map(), view: null, busy: null, maskSel: null,
                                       drawing: null, show: { trails: true, solved: true, undistort: false } };
            const scene = this.previzScene();
            if (scene && scene.matchmove && scene.matchmove.file) st.loading = this._mmLoadFile(st, scene.matchmove.file);
        }
        return st || null;
    },

    async _mmLoadFile(st, path) {
        try {
            const d = await this._mmGet("/imageviewer/mm_load", { path });
            clearTimeout(st.saveTimer);                    // an edit before the file came in is not saved over it
            st.mm = D.cleanMatchmove(d.data);
            st.file = d.path;
            st.frames.clear();
            this._mmRender();
        } catch (e) {
            st.loadError = `The matchmove file was not read: ${e.message}`;
            this._mmRender();
        }
    },

    async _mmGet(url, params = {}) {
        const r = await api.fetchApi(`${url}?${new URLSearchParams(params)}`, { cache: "no-store" });
        const d = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
        if (!r.ok) throw new Error(d.error || `${r.status}`);
        return d;
    },

    async _mmPost(url, body) {
        const r = await api.fetchApi(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
        if (!r.ok) throw new Error(d.error || `${r.status}`);
        return d;
    },

    /** Wait for a server job, telling `tick(job)` how it goes; st.busy names it so the guide can show it and stop it. */
    async _mmJob(st, what, start, tick) {
        const { job: jid } = await start;
        st.busy = { what, job: jid, done: 0, total: 0 };
        this._mmRender();
        try {
            for (;;) {
                await sleep(250);
                const d = await this._mmGet("/imageviewer/mm_job", { job: jid });
                st.busy.done = d.done || 0;
                st.busy.total = d.total || d.count || 0;
                st.busy.stage = d.stage || "";
                if (tick) tick(d);
                this._mmProgress();
                if (d.state !== "running") return d;
            }
        } finally {
            st.busy = null;
            this._mmRender();
        }
    },

    async _mmStop(st) {
        if (st && st.busy && st.busy.stop) { st.busy.stopped = true; st.busy.stop(); }
        if (st && st.busy && st.busy.job) {
            try { await this._mmPost("/imageviewer/mm_job", { job: st.busy.job, cancel: true }); } catch (_) { /* gone */ }
        }
    },

    /** An edit of the matchmove: one undo step on the plate panel's stack, then saved soon. */
    _mmEdit(label, fn) {
        const st = this._mmCur();
        if (!st) return;
        st.undo.push({ label, json: JSON.stringify(st.mm) });
        if (st.undo.length > UNDO) st.undo.shift();
        st.redo.length = 0;
        fn(st.mm, st);
        this._mmChanged(st);
    },

    _mmUndo(redo = false) {
        const st = this._mmCur(false);
        if (!st) return;
        const from = redo ? st.redo : st.undo, to = redo ? st.undo : st.redo;
        const step = from.pop();
        if (!step) return;
        to.push({ label: step.label, json: JSON.stringify(st.mm) });
        st.mm = D.cleanMatchmove(JSON.parse(step.json));
        st.mm.solve = JSON.parse(step.json).solve || null;
        this._mmChanged(st);
    },

    _mmChanged(st) {
        this._mmRender();
        this._mmDraw();
        this._mmSaveSoon(st);
    },

    _mmSaveSoon(st) {
        if (!st || !st.mm.plate) return;
        clearTimeout(st.saveTimer);
        st.saveTimer = setTimeout(() => this._mmSave(st), 1500);
    },

    async _mmSave(st, { quiet = true } = {}) {
        if (!st || !st.mm.plate) return null;
        clearTimeout(st.saveTimer);
        try {
            const d = await this._mmPost("/imageviewer/mm_save", { data: st.mm, path: st.file || undefined,
                                                                   name: `${stemOf(st.mm.plate.path)}_mm`, context: canvasContext() });
            st.file = d.path;
            const scene = this.previzScene(st.key);
            if (scene && (!scene.matchmove || scene.matchmove.file !== d.path)) {
                scene.matchmove = { ...(scene.matchmove || {}), file: d.path };
                if (this.previzPersist) this.previzPersist(st.key);
                if (this.queuePersistViewerState) this.queuePersistViewerState();
            }
            st.saveError = null;
            if (!quiet) notice("success", "Matchmove saved", d.path);
            return d.path;
        } catch (e) {
            st.saveError = e.message;
            this._mmRender();
            return null;
        }
    },

    // ── opening ──────────────────────────────────────────────────────────────

    /** The Matchmove menu's and the lower bar's "Open Matchmove…": this 3D tab, or a new one, with both panels up. */
    matchmoveOpen() {
        if (!this.isPrevizTab || !this.isPrevizTab()) this.previzNewTab("Matchmove");
        if (this.requestPanelOpen) this.requestPanelOpen();
        this.setPanelDocked("mmGuide", true);
        this.setPanelDocked("mmPlate", true);
        if (this.dockTabFront) this.dockTabFront("mmPlate");
        const st = this._mmCur();
        this._mmRender(true);
        if (st && !st.mm.plate && !st.file) this.matchmovePickPlate();
    },

    matchmovePickPlate() {
        const st = this._mmCur();
        if (!st) return;
        openFilePicker(this.container, {
            id: "matchmove-plate", title: "The plate to track", kind: "video", exts: PLATE_EXTS, go: "Open",
            note: "A film, or one frame of a numbered sequence (the whole sequence is taken). An iPhone film or HEIC photo brings its camera, and a Cinematic film its depth.",
            onPick: async (files) => {
                try { await this.matchmoveSetPlate(files[0].path); return { ok: true }; }
                catch (e) { return { ok: false, message: e.message }; }
            },
        });
    },

    /** A plate from the History's selection (or the snapshot on screen). */
    matchmovePlateFromHistory() {
        const snaps = (this.selectedHistorySnapshots && this.selectedHistorySnapshots().map((p) => p.snapshot)) || [];
        const frame = snaps.length ? (Array.isArray(snaps[0]) ? snaps[0][0] : snaps[0]) : null;
        const path = frame && (frame.path || frame.fullpath || frame.abspath);
        if (!path) { notice("warn", "No plate", "Pick a film or a picture in the History first (its file must be on disk)."); return; }
        this.matchmoveSetPlate(path).catch((e) => notice("error", "Plate not opened", e.message));
    },

    async matchmoveSetPlate(path) {
        const st = this._mmCur();
        if (!st) throw new Error("Open a 3D tab first.");
        const d = await this._mmGet("/imageviewer/mm_plate", { path });
        this._mmEdit("plate", (mm) => {
            const fresh = !mm.plate || mm.plate.path !== d.path;
            mm.plate = D.cleanPlate({ path: d.path, name: d.name, frames: d.frames, width: d.width, height: d.height,
                                      fps: d.fps, first: d.first, kind: d.kind });
            if (fresh) {
                mm.tracks = []; mm.solve = null; mm.objectSolves = {};
                mm.settings.from = 0; mm.settings.to = null;
                st.file = null;                            // a new plate is a new matchmove
            }
            const c = d.camera || {};
            if (c.focal_mm) { mm.camera.focalMm = c.focal_mm; mm.camera.focalKnown = true; }
            // a phone stabilises and lens-corrects its film, which crops it a little: its focal length is a
            // good start, not the answer
            if (fresh && c.phone && c.phone.apple && c.phone.tracks && c.focal_mm) mm.settings.refine = "on";
            if (c.sensor_mm) mm.camera.sensor = c.sensor_mm.slice(0, 2);
            mm.camera.pixelAspect = Number(c.pixel_aspect) > 0 ? Number(c.pixel_aspect) : 1;
            mm.camera.preset = "";
            mm.camera.model = [c.make, c.model].filter(Boolean).join(" ");
            mm.camera.lens = c.lens || "";
            st.facts = c;
        });
        st.frames.clear();
        st.view = null;
        this.setFrame && this.setFrame(0);
        await this._mmSave(st);
    },

    // ── panels ───────────────────────────────────────────────────────────────

    _mmStyle(host) {
        if (!host.querySelector(":scope > style[data-mm]")) {
            const s = el(host.ownerDocument, "style");
            s.dataset.mm = "1";
            s.textContent = STYLE;
            host.prepend(s);
        }
    },

    /** Both panels go with the 3D tab and come back with the next one (as Layers does). */
    _mmHide() {
        const want = this._mmWant || (this._mmWant = new Set());
        for (const id of ["mmGuide", "mmPlate"]) {
            if (this.isPanelDocked && this.isPanelDocked(id)) { want.add(id); this.setPanelDocked(id, false); }
        }
        if (this.updateShapeInfo) this.updateShapeInfo();
    },

    _mmRestore() {
        const want = this._mmWant;
        if (!want) return;
        for (const id of want) this.setPanelDocked(id, true);
        want.clear();
    },

    _mmPanelShown(id) {
        if (id === "mmGuide") this._mmRender(true);
        else this._mmPlateEnsure();
    },

    // ── the panels as instances ──────────────────────────────────────────────
    // The first guide and the first plate are the markup's own panels, their state on the viewer (st === this),
    // so this._mmUI and every older caller stay where they were. Every further one is made by the factories
    // (imageViewer_previzMatchmoveInstance.js) with a state of its own: the matchmove is the tab's and shared,
    // the view of it (the guide's step and scroll, the plate's pan and zoom) is each panel's own.

    _mmRegisterMakers() {
        if (!this._dockMakers) return;
        const makers = this._dockMakers();
        if (makers.mmGuide) return;
        const hostOf = (v, cls) => {
            const doc = (v._dockRootEl && v._dockRootEl.ownerDocument)
                || (v.mmGuidePanel && v.mmGuidePanel.ownerDocument);
            if (!doc) return null;
            const host = doc.createElement("div");
            host.className = `previz-panel ${cls}`;
            return host;
        };
        makers.mmGuide = (v, id, saved) => {
            const host = hostOf(v, "mm-guide-panel");
            return host ? createMmGuideInstance(v, host, {}, saved) : null;
        };
        makers.mmPlate = (v, id, saved) => {
            const host = hostOf(v, "mm-plate-panel");
            if (!host) return null;
            host.dataset.panel = id;
            return createMmPlateInstance(v, host, {}, saved);
        };
    },

    /** The first guide: the markup's panel, its state on the viewer. */
    _mmGuidePrimary() {
        const host = this.mmGuidePanel;
        if (!host) return null;
        if (!this._mmGuideInst || this._mmGuideInst.el !== host) this._mmGuideInst = createMmGuideInstance(this, host, this, null);
        return this._mmGuideInst;
    },

    /** The first plate: the markup's panel, its state on the viewer (this._mmUI). */
    _mmPlatePrimary() {
        const host = this.mmPlatePanel;
        if (!host || !this._mmPlateUp() || !this._mmCur()) return null;
        if (!this._mmPlateInst || this._mmPlateInst.el !== host) this._mmPlateInst = createMmPlateInstance(this, host, this, null);
        return this._mmPlateInst;
    },

    _mmGuideExtras() {
        const found = this._dockInstancesOf ? this._dockInstancesOf("mmGuide") : [];
        return found.filter((x) => x.inst !== this._mmGuideInst);
    },

    _mmPlateExtras() {
        const found = this._dockInstancesOf ? this._dockInstancesOf("mmPlate") : [];
        return found.filter((x) => x.inst !== this._mmPlateInst);
    },

    /** Every guide up: the first one and the instances in front. */
    _mmGuideAll() {
        const out = this._mmGuideInst ? [this._mmGuideInst] : [];
        for (const { inst } of this._mmGuideExtras()) out.push(inst);
        return out;
    },

    _mmPlateAll() {
        const out = this._mmPlateInst ? [this._mmPlateInst] : [];
        for (const { inst } of this._mmPlateExtras()) out.push(inst);
        return out;
    },

    /** Draw the guides: the first one when it is open, and every instance in front. */
    _mmRender(force = false) {
        const host = this.mmGuidePanel;
        const up = host && this.isPanelDocked && this.isPanelDocked("mmGuide");
        if (up) {
            const st = this._mmCur();
            if (!st) return;
            this._mmGuidePrimary().render(force);
        }
        for (const { inst } of this._mmGuideExtras()) inst.render(force);
        this._mmPlateEnsure();
        if (up && this.updateShapeInfo) this.updateShapeInfo();
    },

    /** Matchmove is up on this tab: its panels are out and it has a plate (the 3D view's scene stats stand aside). */
    _mmShown() {
        if (!this.isPrevizTab || !this.isPrevizTab()) return false;
        const st = this._mmCur(false);
        const up = (this.isPanelDocked && this.isPanelDocked("mmGuide")) || (this._mmPlateUp && this._mmPlateUp());
        return !!(st && st.mm.plate && up);
    },

    /**
     * A help text cut to its first sentence; the rest behind a "?" (stays in the DOM, only hidden). Which ones are
     * open is remembered while the viewer is up.
     */
    _mmHelp(doc, cls, text) {
        const box = el(doc, "div", cls);
        const t = String(text || "");
        const m = t.match(/^(.+?[.!?:])\s+(\S[\s\S]*)$/);
        if (!m) { box.textContent = t; return box; }
        const open = this._mmHelpOpen || (this._mmHelpOpen = new Set());
        box.classList.toggle("mm-open", open.has(t));
        const q = el(doc, "button", "mm-q", "?");
        q.title = "More about this";
        q.onclick = () => {
            if (open.has(t)) open.delete(t); else open.add(t);
            box.classList.toggle("mm-open", open.has(t));
        };
        box.append(doc.createTextNode(m[1]), el(doc, "span", "mm-more-text", ` ${m[2]}`), q);
        return box;
    },

    /** A foldable section; its body is the ctx to draw into. Open / closed kept per viewer by key. */
    _mmFold(ctx, key, title, summary = "") {
        const folds = this._mmFolds || (this._mmFolds = (() => {
            try { return new Set(JSON.parse(localStorage.getItem("imageviewer.viewer.mmFolds") || "[]")); } catch (_) { return new Set(); }
        })());
        const d = el(ctx.doc, "details", "mm-fold");
        d.dataset.fold = key;
        d.open = folds.has(key);
        const sum = el(ctx.doc, "summary", "", "");
        sum.append(el(ctx.doc, "span", "", title));
        if (summary) sum.append(el(ctx.doc, "span", "mm-fold-sum", summary));
        const body = el(ctx.doc, "div", "mm-fold-body");
        d.append(sum, body);
        d.ontoggle = () => {
            if (d.open) folds.add(key); else folds.delete(key);
            try { localStorage.setItem("imageviewer.viewer.mmFolds", JSON.stringify([...folds])); } catch (_) { /* kept for this visit only */ }
            if (d.open) for (const c of body.querySelectorAll("canvas.mm-graph")) if (c._mmRedraw) c._mmRedraw();
        };
        ctx.box.append(d);
        return { ...ctx, box: body };
    },

    _mmProgress() {
        const st = this._mmCur(false);
        if (!st || !st.busy) return;
        const share = st.busy.total ? Math.min(1, st.busy.done / st.busy.total) : 0;
        for (const inst of this._mmGuideAll()) inst.progress(share);
    },

    _mmDone(st) {
        const mm = st.mm;
        return {
            plate: !!mm.plate, lens: mm.lens.source !== "none" || !!mm.lens.k1, masks: mm.masks.length > 0,
            track: mm.tracks.length >= 8, solve: !!mm.solve, objects: Object.keys(mm.objectSolves || {}).length > 0,
            scene: !!(mm.scene && mm.scene.group),
        };
    },

    // small builders
    _mmRow(ctx, label, ...kids) {
        const row = el(ctx.doc, "div", label ? "mm-row mm-lab" : "mm-row");
        if (label) {
            const l = el(ctx.doc, "label", "", label);
            l.title = label;
            const fields = el(ctx.doc, "div", "mm-fields");
            const list = kids.filter(Boolean);
            // buttons alone wrap whole; a row with a field keeps to one line and shrinks instead
            if (list.length > 1 && list.every((k) => k.tagName === "BUTTON")) fields.classList.add("mm-wrap");
            fields.append(...list);
            row.append(l, fields);
        } else row.append(...kids.filter(Boolean));
        ctx.box.append(row);
        return row;
    },

    _mmBtn(ctx, text, run, { primary = false, title = "", disabled = false } = {}) {
        const b = el(ctx.doc, "button", `mm-btn${primary ? " primary" : ""}`, text);
        b.title = title || text;
        b.disabled = disabled || !!ctx.st.busy;
        b.onclick = () => { Promise.resolve(run()).catch((e) => notice("error", text.replace(/…$/, ""), e.message)); };
        return b;
    },

    _mmNum(ctx, value, commit, { step = "any", min, max, width } = {}) {
        const i = el(ctx.doc, "input");
        i.type = "number";
        i.step = step;
        if (min !== undefined) i.min = min;
        if (max !== undefined) i.max = max;
        if (width) i.style.width = width;
        i.value = value === null || value === undefined ? "" : String(value);
        i.onchange = () => { const v = i.value === "" ? null : Number(i.value); commit(Number.isFinite(v) ? v : null); };
        return i;
    },

    _mmSelect(ctx, options, value, commit) {
        const s = el(ctx.doc, "select");
        for (const [v, label] of options) {
            const o = el(ctx.doc, "option", "", label);
            o.value = v;
            s.append(o);
        }
        s.value = value;
        s.onchange = () => commit(s.value);
        return s;
    },

    /** A note; a long plain one (an explanation, not a warning or a result) shows its first sentence and a "?". */
    _mmNote(ctx, text, kind = "") {
        const cls = `mm-note ${kind}`.trim();
        ctx.box.append(!kind && String(text).length > 110 ? this._mmHelp(ctx.doc, cls, text) : el(ctx.doc, "div", cls, text));
    },

    // ── step 1: the plate ────────────────────────────────────────────────────

    _mmStepPlate(ctx) {
        const { mm, st } = ctx;
        // one "Open" menu for the ways in; with no plate yet, choosing one is the step's main button
        const entries = [
            { label: mm.plate ? "Another plate…" : "Choose the plate…", title: "A film, a picture or a sequence on disk", run: () => this.matchmovePickPlate() },
            { label: "From the History", title: "The film or picture picked in the History", run: () => this.matchmovePlateFromHistory() },
            { label: "Open matchmove…", title: "A matchmove saved before (.mm.json)", run: () => this.matchmoveOpenFile() },
        ];
        const open = this._mmBtn(ctx, "Open ▾", () => {
            const r = open.getBoundingClientRect();
            this._previzOpenMenu(mm.plate ? entries : entries.slice(1), r.left, r.bottom + 2, open);
        }, { title: mm.plate ? "Another plate, one from the History, or a matchmove saved before" : "A plate from the History, or a matchmove saved before" });
        open.classList.add("mm-open-menu");
        this._mmRow(ctx, "", mm.plate ? null : this._mmBtn(ctx, "Choose the plate…", () => this.matchmovePickPlate(), { primary: true }), open);
        if (!mm.plate) return;
        const p = mm.plate;
        const facts = el(ctx.doc, "div", "mm-facts");
        facts.append(el(ctx.doc, "div", "", p.name),
                     el(ctx.doc, "div", "", `${p.width} × ${p.height} · ${p.frames} frames · ${p.fps} fps`));
        const f = st.facts || {};
        if (mm.camera.model || mm.camera.lens) facts.append(el(ctx.doc, "div", "", [mm.camera.model, mm.camera.lens].filter(Boolean).join(" · ")));
        const from = [...new Set(Object.values(f.sources || {}))].filter(Boolean);
        if (from.length) facts.append(el(ctx.doc, "div", "mm-good", `Read from: ${from.join(", ")}`));
        else if (st.facts) facts.append(el(ctx.doc, "div", "mm-note warn", "The plate says nothing about its camera: type what you know, or leave the focal length unknown."));
        for (const n of f.notes || []) facts.append(el(ctx.doc, "div", "mm-note", n));
        ctx.box.append(facts);
        if (f.phone) this._mmPhoneSection(ctx, f.phone);
        const cam = mm.camera;
        const presets = [["", "Pick a camera… (or type below)"], ...D.CAMERA_PRESETS.map((q) => [q.id, q.name])];
        const pick = this._mmSelect(ctx, presets, cam.preset || "", (v) => v && this._mmEdit("camera preset", (m) => D.applyCameraPreset(m, v)));
        pick.classList.add("mm-camera-preset");
        pick.title = "Sets the sensor (and a phone's lens as its 35 mm equivalent) and the pixel aspect";
        pick.style.minWidth = "0";
        pick.style.flex = "1 1 auto";
        this._mmRow(ctx, "Camera", pick);
        this._mmRow(ctx, "Focal length", this._mmNum(ctx, cam.focalMm, (v) => this._mmEdit("focal length", (m) => { m.camera.focalMm = v; m.camera.focalKnown = !!v; m.camera.preset = ""; })),
                    el(ctx.doc, "span", "", "mm"));
        this._mmRow(ctx, "Sensor (recorded)", this._mmNum(ctx, cam.sensor[0], (v) => v && this._mmEdit("sensor", (m) => { m.camera.sensor[0] = v; m.camera.preset = ""; })),
                    el(ctx.doc, "span", "", "×"),
                    this._mmNum(ctx, cam.sensor[1], (v) => v && this._mmEdit("sensor", (m) => { m.camera.sensor[1] = v; m.camera.preset = ""; })),
                    el(ctx.doc, "span", "", "mm"));
        const pa = this._mmNum(ctx, D.pixelAspect(mm), (v) => this._mmEdit("pixel aspect", (m) => { m.camera.pixelAspect = v >= 0.2 && v <= 5 ? v : 1; }), { step: 0.01, width: "60px" });
        pa.classList.add("mm-pixel-aspect");
        this._mmRow(ctx, "Pixel aspect", pa, el(ctx.doc, "span", "mm-note", "1 = square; 2 = a 2× anamorphic squeeze"));
        const known = el(ctx.doc, "input");
        known.type = "checkbox";
        known.checked = !!(cam.focalKnown && cam.focalMm);
        known.disabled = !cam.focalMm;
        known.onchange = () => this._mmEdit("focal known", (m) => { m.camera.focalKnown = known.checked; });
        const lab = el(ctx.doc, "label", "", "");
        lab.append(known, ctx.doc.createTextNode(" Start the solve from this focal length"));
        lab.style.minWidth = "0";
        this._mmRow(ctx, "", lab);
        const fpx = D.focalPx(mm);
        if (fpx) this._mmNote(ctx, `${fpx.toFixed(1)} px · vertical field of view ${D.fovV(fpx, p.height).toFixed(2)}°`);
    },

    /** What else an iPhone film or photo holds: the lens, the turn, its timed metadata and its depth. */
    _mmPhoneSection(ctx, ph) {
        const { mm, st, doc } = ctx;
        const box = el(doc, "div", "mm-facts");
        box.append(el(doc, "div", "", ph.tracks ? "From the phone's film" : "From the phone's photo"));
        const lens = ph.lens || {};
        const bits = [lens.camera && `${lens.camera} camera`, lens.side && `${lens.side}`, lens.fnumber && `f/${lens.fnumber}`].filter(Boolean);
        if (bits.length) box.append(el(doc, "div", "", bits.join(" · ")));
        if (ph.rotation) box.append(el(doc, "div", "", `Recorded on its side, turned ${ph.rotation}° upright here`));
        if (ph.software || ph.created) box.append(el(doc, "div", "", [ph.software && `iOS ${ph.software}`, ph.created].filter(Boolean).join(" · ")));
        if (ph.timed && ph.timed.length) {
            const t = el(doc, "div", "", `Timed metadata: ${ph.timed.length} key(s)`);
            t.title = ph.timed.join("\n");
            box.append(t);
        }
        if (ph.motion && ph.motion.length) box.append(el(doc, "div", "mm-good", `Motion: ${ph.motion.join(", ")}`));
        const dep = ph.depth;
        if (dep && ph.tracks) box.append(el(doc, "div", "mm-good", `Cinematic depth: ${dep.width} × ${dep.height}, ${dep.samples} pictures`));
        else if (dep) box.append(el(doc, "div", "mm-good", `Depth picture: ${dep.width} × ${dep.height}${ph.depth_file ? ` (saved as ${String(ph.depth_file).split(/[\\/]/).pop()})` : ""}`));
        ctx.box.append(box);
        if (dep && ph.tracks && mm.plate) {
            this._mmRow(ctx, "", this._mmBtn(ctx, st.phoneDepthShown ? "Hide the depth" : "Show the depth", () => { st.phoneDepthShown = !st.phoneDepthShown; this._mmRender(); },
                                             { title: "The film's depth at the current frame (bright = near)" }),
                        this._mmBtn(ctx, "Save the depth as pictures", () => this.matchmovePhoneExport(),
                                    { title: "The depth track as a 16-bit picture sequence beside the plate's copies, one picture a frame" }));
            if (st.phoneDepthShown) {
                const img = el(doc, "img", "mm-phone-depth");
                img.style.cssText = "max-width:100%;max-height:180px;display:block;margin:4px 0;image-rendering:pixelated";
                img.src = api.apiURL(`/imageviewer/mm_phone_depth_view?${new URLSearchParams({ path: mm.plate.path, frame: String(this.currentFrame || 0) })}`);
                img.onerror = () => { img.replaceWith(el(doc, "div", "mm-note warn", "The depth could not be read at this frame.")); };
                ctx.box.append(img);
            }
        }
    },

    async matchmovePhoneExport() {
        const st = this._mmCur();
        if (!st || !st.mm.plate) return;
        st.busy = { what: "Saving the phone's depth" };
        this._mmRender();
        try {
            const d = await this._mmPost("/imageviewer/mm_phone_export", { path: st.mm.plate.path });
            notice("info", "Depth saved", `${d.frames} picture(s), ${d.width} × ${d.height}: ${d.pattern}`);
            return d;
        } finally {
            st.busy = null;
            this._mmRender();
        }
    },

    matchmoveOpenFile() {
        const st = this._mmCur();
        if (!st) return;
        openFilePicker(this.container, {
            id: "matchmove-file", title: "Open a matchmove", kind: "matchmove", exts: [".json"], go: "Open",
            note: "A matchmove saved by this panel (.mm.json).",
            onPick: async (files) => {
                const path = files[0].path;
                if (!/\.mm\.json$/i.test(path)) return { ok: false, message: "That is not a matchmove (.mm.json)." };
                await this._mmLoadFile(st, path);
                return { ok: !st.loadError, message: st.loadError || "" };
            },
        });
    },

    // ── step 2: the lens ─────────────────────────────────────────────────────

    _mmStepLens(ctx) {
        const { mm, st } = ctx;
        const L = mm.lens;
        this._mmRow(ctx, "Distortion", this._mmSelect(ctx, [["none", "None (undistorted plate or CG)"], ["grid", "From a lens grid"],
                                                            ["lines", "From lines on the plate"], ["typed", "Typed in"], ["comp", "From a Comp"]],
                                                     L.source, (v) => this._mmEdit("lens source", (m) => {
                                                         m.lens.source = v;
                                                         if (v === "none") { m.lens.k1 = 0; m.lens.k2 = 0; m.lens.center = null; }
                                                     })));
        if (L.source === "grid") {
            this._mmNote(ctx, "A checkerboard or a grid of lines, shot with this lens at this focus, filling the frame. Several frames (the chart in different places) are better than one.");
            this._mmRow(ctx, "No chart?", this._mmBtn(ctx, "Show a chart to film…", () => this.matchmoveLensChart(),
                                                       { title: "A checkerboard full screen on this monitor (or a tablet's): film it with the shot's lens, then choose that film here" }));
            const g = L.grid || {};
            this._mmRow(ctx, "Grid plate", el(ctx.doc, "span", "mm-note", g.path ? g.path.split(/[\\/]/).pop() : "none yet"),
                        this._mmBtn(ctx, "Choose…", () => this._mmPickGrid(st)),
                        this._mmBtn(ctx, "Use the plate", () => this._mmEdit("grid plate", (m) => { m.lens.grid = { ...(m.lens.grid || {}), path: m.plate.path }; }),
                                    { title: "The chart is in this shot" }));
            this._mmRow(ctx, "Chart", this._mmSelect(ctx, [["auto", "Find out"], ["checker", "Checkerboard"], ["lines", "Grid of lines"]], g.kind || "auto",
                                                       (v) => this._mmEdit("chart", (m) => { m.lens.grid = { ...(m.lens.grid || {}), kind: v }; })));
            const fr = el(ctx.doc, "input");
            fr.type = "text";
            fr.style.width = "110px";
            fr.value = (g.frames || [0]).join(", ");
            fr.title = "Frames of the grid plate to read, e.g. 0, 12, 24";
            fr.onchange = () => this._mmEdit("grid frames", (m) => {
                m.lens.grid = { ...(m.lens.grid || {}), frames: fr.value.split(/[\s,;]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 12) };
            });
            this._mmRow(ctx, "Frames", fr);
            this._mmLensOptions(ctx);
            this._mmRow(ctx, "", this._mmBtn(ctx, "Find the lens", () => this.matchmoveLensFromGrid(), { primary: true, disabled: !g.path }));
        } else if (L.source === "lines") {
            this._mmNote(ctx, "In the Plate panel pick Lines and click along edges that are straight in the world - door frames, horizons, building edges - with 3 or more points each, out to the corners. Six or more lines, spread over the frame.");
            this._mmRow(ctx, "", el(ctx.doc, "span", "", `${L.lines.length} line(s) drawn`),
                        this._mmBtn(ctx, "Draw lines", () => this.matchmoveTool("lines")),
                        this._mmBtn(ctx, "Clear lines", () => this._mmEdit("clear lines", (m) => { m.lens.lines = []; }), { disabled: !L.lines.length }));
            this._mmLensOptions(ctx);
            this._mmRow(ctx, "", this._mmBtn(ctx, "Straighten the lines", () => this.matchmoveLensFromLines(), { primary: true, disabled: L.lines.length < 1 }));
        } else if (L.source === "comp") {
            this._mmRow(ctx, "", this._mmBtn(ctx, "Take from a Comp…", () => this.matchmoveLensFromComp(), { primary: true }));
        }
        if (L.source !== "none") {
            this._mmRow(ctx, "k1", this._mmNum(ctx, L.k1, (v) => this._mmEdit("k1", (m) => { m.lens.k1 = v || 0; if (m.lens.source === "none") m.lens.source = "typed"; })),
                        el(ctx.doc, "label", "", "k2"),
                        this._mmNum(ctx, L.k2, (v) => this._mmEdit("k2", (m) => { m.lens.k2 = v || 0; })));
            if (L.center) this._mmNote(ctx, `Centre ${L.center[0].toFixed(1)}, ${L.center[1].toFixed(1)} px`);
            if (L.error !== null && L.error !== undefined) this._mmNote(ctx, `Fit: ${Number(L.error).toFixed(3)} px left over`, L.error > 1 ? "warn" : "");
            if (L.coverage !== null && L.coverage !== undefined && L.coverage < 0.6) this._mmNote(ctx, `The chart covered ${(L.coverage * 100).toFixed(0)} % of the frame: the corners are guessed. Shoot it filling the frame.`, "warn");
            for (const n of L.notes || []) this._mmNote(ctx, n);
            if (st.lensFocal) this._mmNote(ctx, `The grid also says the focal length is about ${st.lensFocal.toFixed(1)} px.`);
        }
        this._mmRow(ctx, "With Comp", this._mmBtn(ctx, "Open in Comp", () => this.matchmoveLensToComp("undistort"), { title: "A comp: the plate → Lens Distortion (these numbers, undistort) → Output", disabled: !mm.plate }),
                    this._mmBtn(ctx, "Redistort comp", () => this.matchmoveLensToComp("redistort"), { title: "The same node set to redistort, for CG rendered through the solved camera" }));
        this._mmRow(ctx, "ST maps", this._mmBtn(ctx, "Undistort map", () => this.matchmoveStmap("undistort")),
                    this._mmBtn(ctx, "Redistort map", () => this.matchmoveStmap("redistort")));
        const show = el(ctx.doc, "input");
        show.type = "checkbox";
        show.checked = !!st.show.undistort;
        show.onchange = () => { st.show.undistort = show.checked; st.frames.clear(); this._mmDraw(); };
        const lab = el(ctx.doc, "label", "", "");
        lab.style.minWidth = "0";
        lab.append(show, ctx.doc.createTextNode(" Show the plate undistorted"));
        this._mmRow(ctx, "", lab);
    },

    _mmLensOptions(ctx) {
        const { st } = ctx;
        const o = st.lensOpts || (st.lensOpts = { fitCenter: false, k2: "auto" });
        const fc = el(ctx.doc, "input");
        fc.type = "checkbox";
        fc.checked = o.fitCenter;
        fc.onchange = () => { o.fitCenter = fc.checked; };
        const lab = el(ctx.doc, "label", "", "");
        lab.style.minWidth = "0";
        lab.append(fc, ctx.doc.createTextNode(" Find the centre too"));
        this._mmRow(ctx, "", lab, el(ctx.doc, "label", "", "k2"),
                    this._mmSelect(ctx, [["auto", "if the data allows"], ["on", "always"], ["off", "never"]], o.k2, (v) => { o.k2 = v; }));
    },

    _mmK2(st) {
        const v = (st.lensOpts || {}).k2;
        return v === "on" ? true : v === "off" ? false : null;
    },

    _mmPickGrid(st) {
        openFilePicker(this.container, {
            id: "matchmove-grid", title: "The lens grid", kind: "video", exts: PICT_EXTS, go: "Use",
            onPick: async (files) => {
                this._mmEdit("grid plate", (m) => { m.lens.grid = { ...(m.lens.grid || {}), path: files[0].path }; });
                return { ok: true };
            },
        });
    },

    async matchmoveLensFromGrid() {
        const st = this._mmCur();
        const g = st.mm.lens.grid || {};
        st.busy = { what: "Reading the grid" };
        this._mmRender();
        try {
            const d = await this._mmPost("/imageviewer/mm_lens_grid", { path: g.path, frames: g.frames || [0], kind: g.kind || "auto",
                                                                        fit_center: !!(st.lensOpts || {}).fitCenter, k2: this._mmK2(st) });
            st.busy = null;
            if (!d.points) { notice("warn", "No chart found", (d.notes || []).join(" ") || "No checkerboard or grid of lines was found."); return; }
            this._mmEdit("lens from grid", (m) => {
                Object.assign(m.lens, { k1: d.k1, k2: d.k2, center: d.center || null, error: d.error, coverage: d.coverage ?? null,
                                        notes: d.notes || [], source: "grid" });
            });
            st.lensFocal = d.focal_px || null;             // the lens step says it
        } finally {
            st.busy = null;
            this._mmRender();
        }
    },

    async matchmoveLensFromLines() {
        const st = this._mmCur();
        const p = st.mm.plate;
        const d = await this._mmPost("/imageviewer/mm_lens_lines", { width: p.width, height: p.height, lines: st.mm.lens.lines,
                                                                     fit_center: !!(st.lensOpts || {}).fitCenter, k2: this._mmK2(st) });
        this._mmEdit("lens from lines", (m) => {
            Object.assign(m.lens, { k1: d.k1, k2: d.k2, center: d.center || null, error: d.error, coverage: null, notes: d.notes || [], source: "lines" });
        });
        st.frames.clear();
    },

    matchmoveLensFromComp() {
        openFilePicker(this.container, {
            id: "matchmove-comp", title: "The comp with the lens", kind: "comp", exts: [".json"], go: "Use",
            note: "Its first Lens Distortion node gives k1, k2 and the centre.",
            onPick: async (files) => {
                try {
                    const d = await this._mmGet("/imageviewer/mm_from_comp", { path: files[0].path });
                    this._mmEdit("lens from comp", (m) => { Object.assign(m.lens, { k1: d.k1, k2: d.k2, center: d.center || null, source: "comp", error: null, notes: [`From ${files[0].name}`] }); });
                    this._mmCur().frames.clear();
                    return { ok: true };
                } catch (e) { return { ok: false, message: e.message }; }
            },
        });
    },

    // ── a plate on an image plane (the view asks; imageViewer_view3dVideoPlane.js) ──

    /** {frames, width, height, fps} of a plate path, asked once a while per path. */
    async plateInfo(src) {
        const path = src && src.path;
        if (!path) throw new Error("no plate named");
        const cache = this._plateInfos || (this._plateInfos = new Map());
        const hit = cache.get(path);
        if (hit && Date.now() - hit.at < 30000) return hit.info;
        const d = await this._mmGet("/imageviewer/mm_plate", { path });
        const info = { frames: d.frames, width: d.width, height: d.height, fps: d.fps, path: d.path, kind: d.kind };
        cache.set(path, { at: Date.now(), info });
        return info;
    },

    /** The URL of picture n (0 = the plate's first) of a plate, undistorted by the src's lens. */
    plateFrameUrl(src, n) {
        const q = { path: src.path, frame: Math.max(0, Math.round(n) || 0), size: src.size || PLATE_SIZE };
        const lens = src.lens;
        if (lens && (lens.k1 || lens.k2)) {
            q.k1 = lens.k1 || 0; q.k2 = lens.k2 || 0;
            if (Array.isArray(lens.center)) { q.cx = lens.center[0]; q.cy = lens.center[1]; }
        }
        return api.apiURL(`/imageviewer/mm_frame?${new URLSearchParams(q)}`);
    },

    _mmLens(mm) {
        const L = mm.lens;
        return { k1: L.k1 || 0, k2: L.k2 || 0, center: L.center || null };
    },

    async matchmoveLensToComp(mode = "undistort") {
        const st = this._mmCur();
        const mm = st.mm;
        const d = await this._mmPost("/imageviewer/mm_to_comp", { path: mm.plate.path, lens: this._mmLens(mm), mode,
                                                                  name: `${stemOf(mm.plate.path)}_lens_${mode}`, context: canvasContext() });
        notice("success", "Comp made", d.path);
        if (this.compOpenFile) this.compOpenFile(d.path);
    },

    async matchmoveStmap(mode) {
        const st = this._mmCur();
        const p = st.mm.plate;
        const d = await this._mmPost("/imageviewer/mm_stmap", { width: p.width, height: p.height, lens: this._mmLens(st.mm), mode,
                                                                name: `${stemOf(p.path)}_${mode}_stmap`, context: canvasContext() });
        notice("success", "ST map written", d.path);
        if (this.exportLanded) this.exportLanded([d.path]);
    },

    // ── step 3: masks ────────────────────────────────────────────────────────

    _mmStepMasks(ctx) {
        const { mm, st } = ctx;
        // Sebastian 2026-11-20: Mask with AI beside Draw Mask; its options only while it is on
        const draw = this._mmBtn(ctx, "Draw Mask", () => { st.maskSel = null; st.aiMaskOpen = false; this.matchmoveTool("mask"); this._mmRender(); },
                                 { title: "Draw a mask on the plate: drag its corners, keyed on the frame shown" });
        draw.classList.add("mm-mask-draw");
        draw.classList.toggle("on", st.tool === "mask" && !st.aiMaskOpen);
        const ai = this._mmBtn(ctx, "Mask with AI", () => { st.aiMaskOpen = !st.aiMaskOpen; this._mmRender(); },
                               { title: "Let a model mask what moves over the whole shot: its options, then Generate Mask" });
        ai.classList.add("mm-mask-ai");
        ai.classList.toggle("on", !!st.aiMaskOpen);
        this._mmRow(ctx, "", draw, ai);
        if (st.aiMaskOpen && this._mmMatteSection) this._mmMatteSection(ctx);
        if (!mm.masks.length) { this._mmNote(ctx, "No masks: every feature found is used for the camera."); return; }
        const list = el(ctx.doc, "div", "mm-list");
        for (const m of mm.masks) {
            const li = el(ctx.doc, "div", "mm-li");
            li.classList.toggle("sel", st.maskSel === m.id);
            const on = el(ctx.doc, "input");
            on.type = "checkbox";
            on.checked = m.on;
            on.onclick = (e) => e.stopPropagation();
            on.onchange = () => this._mmEdit("mask on", (q) => { q.masks.find((x) => x.id === m.id).on = on.checked; });
            const name = el(ctx.doc, "span", "grow", m.matte ? `${m.name} · AI matte` : `${m.name} · ${m.keys.length} key(s)`);
            const mode = this._mmSelect(ctx, [["exclude", "Keep out"], ...mm.objects.map((o) => [`object:${o.id}`, `Object: ${o.name}`])],
                                        m.mode === "object" ? `object:${m.object}` : "exclude",
                                        (v) => this._mmEdit("mask mode", (q) => {
                                            const x = q.masks.find((y) => y.id === m.id);
                                            if (v === "exclude") { x.mode = "exclude"; x.object = ""; } else { x.mode = "object"; x.object = v.slice(7); }
                                        }));
            mode.onclick = (e) => e.stopPropagation();
            const del = el(ctx.doc, "button", "mm-btn", "✕");
            del.title = "Delete the mask";
            del.onclick = (e) => { e.stopPropagation(); this._mmEdit("delete mask", (q) => { q.masks = q.masks.filter((x) => x.id !== m.id); }); };
            li.append(on, name, mode, del);
            li.onclick = () => { st.maskSel = m.id; if (!m.matte) this.matchmoveTool("mask"); this._mmRender(); this._mmDraw(); };
            list.append(li);
            if (m.matte && st.maskSel === m.id && this._mmMatteRow) this._mmMatteRow({ ...ctx, box: list }, m);
        }
        ctx.box.append(list);
        this._mmNote(ctx, "Pick a mask and drag its corners in the Plate panel: the shape is keyed on that frame and moves straight between keys.");
    },

    // ── step 4: tracking ─────────────────────────────────────────────────────

    _mmStepTrack(ctx) {
        const { mm, st } = ctx;
        const s = mm.settings;
        const last = (mm.plate.frames || 1) - 1;
        this._mmRow(ctx, "Features", this._mmNum(ctx, s.n, (v) => v && this._mmEdit("features", (m) => { m.settings.n = Math.round(v); }), { step: 10, min: 8, max: 1000 }),
                    el(ctx.doc, "label", "", "Quality"),
                    this._mmNum(ctx, s.minNcc, (v) => v && this._mmEdit("quality", (m) => { m.settings.minNcc = v; }), { step: 0.05, min: 0.3, max: 0.99 }));
        this._mmRow(ctx, "Frames", this._mmNum(ctx, s.from, (v) => this._mmEdit("from", (m) => { m.settings.from = Math.max(0, Math.round(v || 0)); }), { step: 1, min: 0, max: last }),
                    el(ctx.doc, "span", "", "to"),
                    this._mmNum(ctx, s.to === null ? last : s.to, (v) => this._mmEdit("to", (m) => { m.settings.to = v === null ? null : Math.round(v); }), { step: 1, min: 0, max: last }));
        const rg = D.trackRange(mm);
        this._mmRow(ctx, "Direction", this._mmSelect(ctx, [["both", "Both ways"], ["forward", "Forwards"], ["backward", "Backwards"]], rg.direction,
                                                     (v) => this._mmEdit("direction", (m) => { m.settings.direction = v; })));
        this._mmRow(ctx, "Start at", this._mmNum(ctx, rg.start, (v) => this._mmEdit("start", (m) => { m.settings.start = v === null ? null : Math.max(0, Math.round(v)); }), { step: 1, min: 0, max: last }),
                    this._mmBtn(ctx, "This frame", () => this._mmEdit("start", (m) => { m.settings.start = Math.round(this.currentFrame || 0); }), { title: "Start tracking from the frame shown" }));
        this._mmRow(ctx, "", this._mmBtn(ctx, mm.tracks.length ? "Track more" : "Track the plate", () => this.matchmoveAutoTrack(), { primary: true }),
                    this._mmBtn(ctx, "Add a track by hand", () => this.matchmoveTool("add")));
        if (!mm.tracks.length) {
            this._mmNote(ctx, "Hard shot? Start on the frame where the picture is clearest and track both ways.");
            return;
        }
        this._mmRow(ctx, "",
                    this._mmBtn(ctx, "New points on this frame", () => this.matchmoveTrackFrom([Math.round(this.currentFrame || 0)]),
                                { title: "Find new features on the frame shown, clear of the tracks there, and follow them the way set above" }),
                    this._mmBtn(ctx, st.sel.size ? `Carry on picked (${st.sel.size})` : "Carry tracks on", () => this.matchmoveExtendTracks(),
                                { title: "Follow tracks on past where they stopped (the way set above)" }));
        const stats = D.trackStats(mm);
        const facts = el(ctx.doc, "div", "mm-facts");
        facts.append(el(ctx.doc, "div", "", `${stats.camera} camera tracks (${stats.on} on), half of them ${stats.medianLength}+ frames long`),
                     el(ctx.doc, "div", "", `Fewest on a frame: ${stats.leastPerFrame}`));
        ctx.box.append(facts);
        const g = el(ctx.doc, "canvas", "mm-graph");
        g._mmRedraw = () => this._mmBars(g, stats.counts, 8, "tracks a frame (red: under 8)");
        ctx.box.append(g);
        this._mmGraphWatch(g);
        if (stats.thin.length) {
            this._mmNote(ctx, `Too few tracks on frames ${stats.thin.slice(0, 4).map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(", ")}${stats.thin.length > 4 ? " …" : ""}: add tracks there, or the camera will jump.`, "warn");
            this._mmRow(ctx, "", this._mmBtn(ctx, "Find new points on the thin frames", () => this.matchmoveFillThin(), { primary: true,
                title: "New features in the middle of every thin stretch, followed both ways" }));
        }
        const minLen = st.minLen || 10;
        this._mmRow(ctx, "Clean up", this._mmBtn(ctx, `Delete tracks under`, () => this._mmEdit("delete short", (m) => D.removeTracks(m, D.shortTracks(m, minLen)))),
                    this._mmNum(ctx, minLen, (v) => { st.minLen = Math.max(2, Math.round(v || 10)); }, { step: 1, min: 2, width: "48px" }), el(ctx.doc, "span", "", "frames"));
        this._mmRow(ctx, "", this._mmBtn(ctx, `Delete picked (${st.sel.size})`, () => this.matchmoveDeleteSelected(), { disabled: !st.sel.size }),
                    this._mmBtn(ctx, "Delete all", () => this._mmEdit("delete all tracks", (m) => { m.tracks = []; m.solve = null; })));
        this._mmDepthCheckSection(ctx);
    },

    /** A small bar graph: one bar a frame, red under `least`. */
    /**
     * A bar a frame, the playhead an orange line on its frame's bar. `least` > 0: red under it; < 0: red over -least.
     * `max`: the top of the scale (a bar over it is drawn to the top); `line`: a dashed line at that value.
     */
    _mmBars(canvas, values, least, label, { max = null, line = null } = {}) {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return false;
        const dpr = (canvas.ownerDocument.defaultView || window).devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        const g = canvas.getContext("2d");
        g.scale(dpr, dpr);
        const top = max || Math.max(1, ...values);
        const n = values.length || 1;
        const room = h - 12;
        for (let i = 0; i < n; i++) {
            const v = values[i] || 0;
            const bad = least === null ? false : (least < 0 ? v > -least : v < least);
            g.fillStyle = bad ? "#d05050" : "#5c8a5c";
            const bh = Math.max(1, Math.min(1, v / top) * room);
            g.fillRect((i / n) * w, h - bh, Math.max(1, w / n - 0.5), bh);
        }
        if (line !== null && line < top) {
            g.strokeStyle = "rgba(255,255,255,0.25)";
            g.setLineDash([3, 3]);
            const y = Math.round(h - (line / top) * room) + 0.5;
            g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
            g.setLineDash([]);
        }
        g.fillStyle = "#888";
        g.font = "10px sans-serif";
        g.fillText(label, 4, 10);
        // the playhead: on the middle of its frame's bar, as the timeline shows it
        const f = Math.max(0, Math.min(n - 1, Math.round(this.currentFrame || 0)));
        g.fillStyle = "#ff6600";
        g.fillRect(Math.round(((f + 0.5) / n) * w) - 1, 0, 2, h);
        canvas._mmDrawn = `${f}|${w}|${h}`;
        return true;
    },

    /**
     * Keep a guide graph drawn: when it gets a size (a fold opened, the panel shown or resized, popped out) and
     * when the playhead moves, so its orange line stays on the frame shown. One loop for every graph; it stops when
     * none is left in the page.
     */
    _mmGraphWatch(canvas) {
        const set = this._mmGraphs || (this._mmGraphs = new Set());
        set.add(canvas);
        const tick = () => {
            this._mmGraphRaf = 0;
            const f = Math.round(this.currentFrame || 0);
            let win = null;
            for (const c of [...set]) {
                if (!c.isConnected) { set.delete(c); continue; }
                win = win || c.ownerDocument.defaultView;
                const w = c.clientWidth, h = c.clientHeight;
                if (!w || !h || !c._mmRedraw) continue;
                if (c._mmDrawn !== `${f}|${w}|${h}`) c._mmRedraw();
            }
            if (set.size && win) this._mmGraphRaf = win.requestAnimationFrame(tick);
        };
        if (this._mmGraphRaf) return;
        const win = canvas.ownerDocument.defaultView || window;
        this._mmGraphRaf = win.requestAnimationFrame(tick);
    },

    /** Find features from the start frame and follow them the way set (forwards, backwards or both). */
    async matchmoveAutoTrack() {
        const rg = D.trackRange(this._mmCur().mm);
        return this.matchmoveTrackFrom([rg.start]);
    },

    /** One track job of a hard shot: new features on the `seeds` frames (clear of the tracks there) and / or the
     *  tracks `extend` carried on past their ends, the way the settings say; the answer merged into the shot. */
    async matchmoveTrackFrom(seeds, { extend = [], direction = null, label = "Tracking" } = {}) {
        const st = this._mmCur();
        const mm = st.mm;
        const s = mm.settings;
        const rg = D.trackRange(mm);
        const d = await this._mmJob(st, label, this._mmPost("/imageviewer/mm_track", {
            path: mm.plate.path, from: rg.from, to: rg.to, mode: "auto", n: s.n, min_ncc: s.minNcc,
            min_dist: s.minDist || undefined, masks: mm.masks.filter((m) => m.on), start_id: mm.nextId, prefix: "t",
            direction: direction || rg.direction, seeds, extend, tracks: D.tracksForServer(mm),
        }));
        if (d.state === "error") throw new Error(d.error || "the tracking failed");
        const got = d.tracks || [];
        let more = 0;
        this._mmEdit(extend.length ? "carry tracks on" : "track", (m) => {
            D.addTracks(m, got);
            more = D.addExtended(m, d.extended);
            m.solve = null;
        });
        const said = [got.length ? `${got.length} new tracks` : "", more ? `${more} more keys on ${Object.keys(d.extended || {}).length} tracks` : ""].filter(Boolean);
        notice("info", "Tracked", `${said.join(", ") || "Nothing new found"}${d.state === "stopped" ? " (stopped)" : ""}.`);
        return { added: got.length, keys: more };
    },

    /** New features in the middle of each stretch of thin frames, followed both ways. */
    async matchmoveFillThin() {
        const mm = this._mmCur().mm;
        const rg = D.trackRange(mm);
        const seeds = D.thinSeeds(mm, 8, rg.from, rg.to);
        if (!seeds.length) { notice("info", "Tracked", "No thin frames in the range."); return { added: 0, keys: 0 }; }
        return this.matchmoveTrackFrom(seeds, { direction: "both", label: "Finding new points" });
    },

    /** The picked tracks (or all) carried on past where they stopped. */
    async matchmoveExtendTracks(ids = null) {
        const st = this._mmCur();
        const pick = ids || (st.sel.size ? [...st.sel] : st.mm.tracks.filter((t) => t.on).map((t) => t.id));
        if (!pick.length) return { added: 0, keys: 0 };
        return this.matchmoveTrackFrom([], { extend: pick, label: "Carrying tracks on" });
    },

    /** A track by hand at the frame shown, followed forwards and backwards through the shot. */
    async matchmoveAddTrackAt(x, y) {
        const st = this._mmCur();
        const mm = st.mm;
        const f = Math.round(this.currentFrame || 0);
        let id;
        this._mmEdit("add track", (m) => {
            id = D.newId(m, "m");
            m.tracks.push({ id, name: id, group: st.trackGroup || "camera", on: true, manual: true, keys: [[f, x, y, 1]] });
        });
        st.sel = new Set([id]);
        const last = mm.plate.frames - 1;
        for (const to of [last, 0]) {
            if (to === f) continue;
            const d = await this._mmJob(st, "Following the track", this._mmPost("/imageviewer/mm_track", {
                path: mm.plate.path, from: f, to, mode: "points", points: [{ id, x, y }],
            }));
            const keys = (d.keys && d.keys[id]) || [];
            const t = st.mm.tracks.find((q) => q.id === id);
            if (!t) return;
            for (const k of keys) if (k[0] !== f) D.setKey(t, k[0], k[1], k[2], k[3]);
            this._mmChanged(st);
        }
    },

    matchmoveDeleteSelected() {
        const st = this._mmCur();
        if (!st || !st.sel.size) return;
        const ids = [...st.sel];
        this._mmEdit("delete tracks", (m) => D.removeTracks(m, ids));
        st.sel.clear();
        this._mmChanged(st);
    },

    // ── step 5: solve ────────────────────────────────────────────────────────

    _mmStepSolve(ctx) {
        const { mm, st } = ctx;
        const s = mm.settings;
        const sv = mm.solve;
        // the button and the one-line answer first; the settings under them; the details folded below
        this._mmRow(ctx, "", this._mmBtn(ctx, sv ? "Solve again" : "Solve the camera", () => this.matchmoveSolve(), { primary: true, disabled: mm.tracks.length < 8 }));
        if (mm.tracks.length < 8) this._mmNote(ctx, "Track the plate first: a solve needs 8 or more tracks on every frame.", "warn");
        if (sv) {
            const fmm = D.focalMmOf(sv.focal_px, mm);
            const line = el(ctx.doc, "div", `mm-summary ${sv.rms < 0.5 ? "good" : sv.rms < 1 ? "" : "bad"}`.trim());
            line.append(el(ctx.doc, "span", "mm-dot"),
                        el(ctx.doc, "span", "", `${Number(sv.rms).toFixed(2)} px · ${fmm ? `${fmm.toFixed(1)} mm` : `${Number(sv.focal_px).toFixed(0)} px focal`} · ${D.solveVerdict(sv.rms)}`));
            line.title = `Error ${Number(sv.rms).toFixed(3)} px over ${Object.keys(sv.frames).length} frames`;
            ctx.box.append(line);
        }
        this._mmRow(ctx, "Camera", this._mmSelect(ctx, [["auto", "Find out"], ["free", "Moves freely"], ["tripod", "Only turns (tripod)"]], s.mode,
                                                  (v) => this._mmEdit("solve mode", (m) => { m.settings.mode = v; })));
        this._mmRow(ctx, "Focal length", this._mmSelect(ctx, [["auto", mm.camera.focalKnown ? "Start from the camera's, refine it" : "Find it"], ["on", "Refine it"], ["off", "Keep it fixed"]], s.refine,
                                                        (v) => this._mmEdit("refine", (m) => { m.settings.refine = v; })));
        this._mmDepthSection(ctx);
        const nm = (mm.constraints || []).length;
        this._mmMeasurements(this._mmFold(ctx, "solve-measure", "Measurements", nm ? `${nm} set` : "none"));
        if (this._mmGeometrySection) this._mmGeometrySection(ctx);
        if (!sv) return;
        const dctx = this._mmFold(ctx, "solve-details", "Details", `${Object.keys(sv.frames).length} frames · ${(sv.points || []).length} points`);
        const facts = el(ctx.doc, "div", "mm-facts");
        const verdict = D.solveVerdict(sv.rms);
        const rms = el(ctx.doc, "div", sv.rms < 1 ? "mm-good" : "mm-note warn", `Error ${Number(sv.rms).toFixed(3)} px - ${verdict}`);
        facts.append(rms,
                     el(ctx.doc, "div", "", `${Object.keys(sv.frames).length} frames solved · ${sv.mode === "tripod" ? "a tripod (turns only)" : "a moving camera"}`),
                     el(ctx.doc, "div", "", `Focal length ${Number(sv.focal_px).toFixed(1)} px${D.focalMmOf(sv.focal_px, mm) ? ` = ${D.focalMmOf(sv.focal_px, mm).toFixed(2)} mm` : ""} · vertical ${Number(sv.fov_v).toFixed(2)}°`),
                     el(ctx.doc, "div", "", `${(sv.points || []).length} points in 3D`));
        if (sv.units === "m") facts.append(el(ctx.doc, "div", "mm-good", "1 unit = 1 metre, from the distances measured"));
        const fc = sv.focal_check;
        if (fc && fc.held_by_depth && !fc.better) facts.append(el(ctx.doc, "div", "mm-good mm-proportions", "Proportions: the tracks alone leave the focal length loose; the depth held it."));
        else if (fc && (fc.weak || fc.better)) facts.append(el(ctx.doc, "div", "mm-note warn mm-proportions",
            fc.better ? `Proportions: a focal length 10 % ${fc.better === "short" ? "shorter" : "longer"} fits better - the depth is likely squashed or stretched.`
                      : "Proportions: the shot does not pin its focal length down, so the depth may be squashed or stretched. Measure two distances or a right angle."));
        else if (fc) facts.append(el(ctx.doc, "div", "mm-good mm-proportions", "Proportions: the focal length is pinned down by the shot."));
        this._mmDepthFacts(dctx, facts, sv);
        for (const n of sv.notes || []) facts.append(el(ctx.doc, "div", "mm-note", n));
        dctx.box.append(facts);
        // a warning in the details shows on the fold's own line, so it is not missed while folded
        if (fc && (fc.weak || fc.better) && !(fc.held_by_depth && !fc.better)) {
            const sum = dctx.box.parentNode.querySelector(":scope > summary .mm-fold-sum");
            if (sum) { sum.textContent = "proportions loose"; sum.classList.add("mm-note", "warn"); }
        }
        const n = mm.plate.frames;
        const per = Array.from({ length: n }, (_, f) => Number((sv.per_frame || {})[f]) || 0);
        const over = per.filter((v) => v > 1).length;
        const gctx = this._mmFold(ctx, "solve-graph", "Error per frame", over ? `${over} frame(s) over 1 px` : `max ${Math.max(0, ...per).toFixed(2)} px`);
        const g = el(ctx.doc, "canvas", "mm-graph");
        g.dataset.graph = "error";
        g._mmRedraw = () => this._mmBars(g, per, -1, "error a frame, px (red: over 1)", { max: errorScale(per), line: 1 });
        gctx.box.append(g);
        this._mmGraphWatch(g);
        const worst = (sv.points || []).slice().sort((a, b) => b.error - a.error).slice(0, 12);
        const wctx = this._mmFold(ctx, "solve-worst", "Worst tracks and clean-up", worst.length ? `worst ${Number(worst[0].error).toFixed(2)} px` : "");
        if (worst.length) {
            this._mmNote(wctx, "Click to pick, then look at them on the plate:");
            const list = el(ctx.doc, "div", "mm-list");
            for (const p of worst) {
                const li = el(ctx.doc, "div", "mm-li", "");
                li.classList.toggle("sel", st.sel.has(p.id));
                li.append(el(ctx.doc, "span", "grow", p.id), el(ctx.doc, "span", p.error > 1 ? "mm-note warn" : "mm-note", `${Number(p.error).toFixed(2)} px`));
                li.onclick = (e) => {
                    if (!e.shiftKey) st.sel.clear();
                    st.sel.add(p.id);
                    const t = mm.tracks.find((q) => q.id === p.id);
                    if (t && t.keys.length && this.setFrame) this.setFrame(t.keys[t.keys.length >> 1][0]);
                    this._mmRender(); this._mmDraw();
                };
                list.append(li);
            }
            wctx.box.append(list);
        }
        const share = st.worstShare || 10;
        this._mmRow(wctx, "Delete", this._mmBtn(wctx, "The worst", () => this._mmEdit("delete worst", (m) => D.removeTracks(m, D.withoutMeasured(m, D.worstTracks(m.solve, { share: share / 100 })))),
                                                { title: "Delete the worst share of the tracks (measured tracks are kept)" }),
                    this._mmNum(wctx, share, (v) => { st.worstShare = Math.max(1, Math.min(50, v || 10)); }, { step: 1, width: "40px" }), el(ctx.doc, "span", "", "%"),
                    this._mmBtn(wctx, "Over 1 px", () => this._mmEdit("delete over 1 px", (m) => D.removeTracks(m, D.withoutMeasured(m, D.worstTracks(m.solve, { px: 1 })))),
                                { title: "Delete every track whose error is over 1 px (measured tracks are kept)" }));
        this._mmRow(ctx, "", this._mmBtn(ctx, "Into the scene ›", () => ctx.setStep("scene")));
    },

    /** The Measurements section of the Solve step: real distances and shapes from the tracks picked. */
    _mmMeasurements(ctx) {
        const { mm, st } = ctx;
        const box = el(ctx.doc, "div", "mm-measure");
        box.append(this._mmHelp(ctx.doc, "mm-note", "Pick tracks in the Plate panel, then say what they are. Click, Shift+click, a box or the lasso picks them. They keep the solve's proportions true: two distances in different directions, or a right angle, cure a squashed solve."));
        const picked = [...st.sel];
        const row = el(ctx.doc, "div", "mm-row");
        const dist = this._mmNum(ctx, st.measureMetres ?? null, (v) => { st.measureMetres = v; }, { step: 0.01, width: "60px" });
        dist.classList.add("mm-measure-metres");
        const add = (kind) => {
            const ids = [...st.sel];
            let err = null;
            this._mmEdit("measurement", (m) => { const r = D.addConstraint(m, kind, ids, st.measureMetres); if (r.error) err = r.error; });
            if (err) notice("warn", "Measurement", err);
        };
        const b = (kind, label) => {
            const k = D.CONSTRAINT_KINDS[kind];
            const btn = this._mmBtn(ctx, label, () => add(kind), { title: k.help, disabled: picked.length < k.picks[0] || picked.length > k.picks[1] });
            btn.dataset.measure = kind;
            return btn;
        };
        row.append(b("distance", "Distance"), dist, el(ctx.doc, "span", "", "m"));
        const row2 = el(ctx.doc, "div", "mm-row");
        row2.append(b("plane", "On a plane"), b("line", "On a line"), b("right", "Right angle"));
        box.append(row, row2, el(ctx.doc, "div", "mm-note", `${picked.length} track(s) picked${picked.length === 3 ? " (a right angle: end, corner, end - in the order picked)" : ""}`));
        const list = el(ctx.doc, "div", "mm-list");
        for (const c of mm.constraints || []) {
            const r = D.constraintResult(mm.solve, c.id);
            const li = el(ctx.doc, "div", "mm-li mm-constraint", "");
            li.dataset.kind = c.kind;
            const on = el(ctx.doc, "input");
            on.type = "checkbox";
            on.checked = c.on !== false;
            on.title = "Used in the solve";
            on.onclick = (e) => e.stopPropagation();
            on.onchange = () => this._mmEdit("measurement on / off", (m) => { m.constraints.find((q) => q.id === c.id).on = on.checked; });
            const label = `${D.CONSTRAINT_KINDS[c.kind].name}${c.kind === "distance" ? ` ${Number(c.value.toFixed(3))} m` : ""} · ${c.ids.length > 4 ? `${c.ids.slice(0, 3).join(", ")} +${c.ids.length - 3}` : c.ids.join(", ")}`;
            li.append(on, el(ctx.doc, "span", "grow", label));
            if (r) li.append(el(ctx.doc, "span", r.ok ? "mm-good" : "mm-note warn", r.text));
            const del = this._mmBtn(ctx, "×", () => this._mmEdit("measurement removed", (m) => { m.constraints = m.constraints.filter((q) => q.id !== c.id); }), { title: "Remove this measurement" });
            li.append(del);
            li.onclick = () => { st.sel = new Set(c.ids); this._mmRender(); this._mmDraw(); };
            list.append(li);
        }
        if ((mm.constraints || []).length) box.append(list);
        ctx.box.append(box);
    },

    _mmFocalFor(mm) {
        const fpx = D.focalPx(mm);
        return mm.camera.focalKnown && fpx ? fpx : null;
    },

    async matchmoveSolve({ ask = true } = {}) {
        const st = this._mmCur();
        // AI depth chosen but not run yet: run it first (the solve takes its frames as key frames)
        if (st.mm.settings.depth === "ai" && !st.mm.depthRun && !(await this.matchmoveDepthRun({ ask }))) return;
        const mm = st.mm;
        const p = mm.plate;
        const fpx = this._mmFocalFor(mm) || (mm.settings.refine === "off" && st.lensFocal) || null;
        // "auto": find it when not known, else start from the camera's and refine it - a camera's metadata (a
        // phone's above all: stabilisation crops) is near, and a focal length held a little off squashes the depth
        const refine = mm.settings.refine === "on" ? true : mm.settings.refine === "off" ? false : fpx ? true : null;
        const depth = D.depthRequest(mm);
        const d = await this._mmJob(st, "Solving", this._mmPost("/imageviewer/mm_solve", {
            width: p.width, height: p.height, tracks: mm.tracks.filter((t) => t.on), lens: this._mmLens(mm), focal_px: fpx || undefined,
            mode: mm.settings.mode, refine, pixel_aspect: D.pixelAspect(mm),
            constraints: (mm.constraints || []).filter((c) => c.on !== false),
            ...(depth ? { depth } : {}),
            ...(D.surveyRequest(mm) || {}),
        }));
        const res = d.result || {};
        if (d.state === "error" || res.error) throw new Error(res.error || d.error || "the solve failed");
        if (d.state === "stopped") return;
        this._mmEdit("solve", (m) => {
            m.solve = res; m.objectSolves = {};
            // placed on the geometry: the solve is already in the 3D space's axes and units
            if (res.surveyed) m.orient = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 };
        });
        notice(res.rms < 1 ? "success" : "warn", "Solved", `Error ${Number(res.rms).toFixed(3)} px (${D.solveVerdict(res.rms)}).`);
    },

    // ── step 6: objects ──────────────────────────────────────────────────────

    _mmStepObjects(ctx) {
        const { mm, st } = ctx;
        if (!mm.solve) { this._mmNote(ctx, "Solve the camera first: an object is solved through it.", "warn"); return; }
        this._mmRow(ctx, "", this._mmBtn(ctx, "New object", () => this.matchmoveNewObject(), { primary: !mm.objects.length }));
        for (const o of mm.objects) {
            const facts = el(ctx.doc, "div", "mm-facts");
            const n = mm.tracks.filter((t) => t.group === o.id).length;
            const sol = mm.objectSolves[o.id];
            facts.append(el(ctx.doc, "div", "", `${o.name} · ${n} track(s)`));
            if (sol) facts.append(el(ctx.doc, "div", sol.rms < 1 ? "mm-good" : "mm-note warn", `Solved: ${Number(sol.rms).toFixed(3)} px, ${Object.keys(sol.frames).length} frames`));
            const mask = mm.masks.find((m) => m.mode === "object" && m.object === o.id);
            const row = el(ctx.doc, "div", "mm-row");
            row.append(
                this._mmBtn(ctx, mask ? "Redraw its mask" : "Draw its mask", () => { st.newMaskFor = o.id; st.maskSel = mask ? mask.id : null; this.matchmoveTool("mask"); }),
                this._mmBtn(ctx, "Track inside it", () => this.matchmoveTrackObject(o.id), { disabled: !mask }),
                this._mmBtn(ctx, "Add by hand", () => { st.trackGroup = o.id; this.matchmoveTool("add"); }),
                this._mmBtn(ctx, "Solve", () => this.matchmoveSolveObject(o.id), { primary: true, disabled: n < 6 }));
            facts.append(row);
            const sc = el(ctx.doc, "div", "mm-row");
            sc.append(el(ctx.doc, "label", "", "Scale"), this._mmNum(ctx, o.scale ?? null, (v) => this._mmEdit("object scale", (m) => { m.objects.find((x) => x.id === o.id).scale = v; }), { width: "60px" }),
                      el(ctx.doc, "span", "mm-note", "blank: from the scene's points"));
            facts.append(sc);
            ctx.box.append(facts);
        }
    },

    matchmoveNewObject() {
        const st = this._mmCur();
        this._mmEdit("new object", (m) => {
            const id = D.newId(m, "o");
            m.objects.push({ id, name: `Object ${m.objects.length + 1}` });
            st.newMaskFor = id;
        });
        st.maskSel = null;
        this.matchmoveTool("mask");
    },

    async matchmoveTrackObject(oid) {
        const st = this._mmCur();
        const mm = st.mm;
        const s = mm.settings;
        const last = mm.plate.frames - 1;
        const masks = mm.masks.filter((m) => m.on);
        const d = await this._mmJob(st, "Tracking the object", this._mmPost("/imageviewer/mm_track", {
            path: mm.plate.path, from: s.from, to: s.to === null ? last : s.to, mode: "auto", n: Math.max(40, Math.round(s.n / 3)),
            min_ncc: s.minNcc, masks, start_id: mm.nextId, prefix: "t",
        }));
        if (d.state === "error") throw new Error(d.error);
        // what fell inside the object's mask belongs to it (the server gives it the object's id); keep only those
        const mine = (d.tracks || []).filter((t) => t.group === oid);
        this._mmEdit("track object", (m) => D.addTracks(m, mine));
        notice("info", "Object tracked", `${mine.length} tracks on it.`);
    },

    async matchmoveSolveObject(oid) {
        const st = this._mmCur();
        const mm = st.mm;
        const o = mm.objects.find((x) => x.id === oid);
        const d = await this._mmJob(st, "Solving the object", this._mmPost("/imageviewer/mm_solve", {
            width: mm.plate.width, height: mm.plate.height, tracks: mm.tracks.filter((t) => t.on), lens: this._mmLens(mm),
            object: oid, camera: mm.solve, scale: (o && o.scale) || undefined,
        }));
        const res = d.result || {};
        if (d.state === "error" || res.error) throw new Error(res.error || d.error);
        this._mmEdit("solve object", (m) => { m.objectSolves[oid] = res; });
    },

    // ── step 7: into the scene ───────────────────────────────────────────────

    _mmStepScene(ctx) {
        const { mm, st } = ctx;
        if (!mm.solve) { this._mmNote(ctx, "Solve the camera first.", "warn"); return; }
        if (this._mmGeometrySceneNote) this._mmGeometrySceneNote(ctx);
        const built = mm.scene && mm.scene.group && S.itemById(this.previzScene(), mm.scene.group);
        const bp = st.backplate !== false;
        const cb = el(ctx.doc, "input");
        cb.type = "checkbox";
        cb.checked = bp;
        cb.onchange = () => { st.backplate = cb.checked; };
        const lab = el(ctx.doc, "label", "", "");
        lab.style.minWidth = "0";
        lab.append(cb, ctx.doc.createTextNode(" With the undistorted plate on the camera"));
        this._mmRow(ctx, "", lab);
        this._mmRow(ctx, "", this._mmBtn(ctx, built ? "Build again" : "Build in the scene", () => this.matchmoveBuild(), { primary: true }),
                    this._mmBtn(ctx, "Look through it", () => this.previzLookThroughSet(mm.scene.camera), { disabled: !built }));
        if (!built) return;
        if (this._mmGroundSection) this._mmGroundSection(ctx);
        this._mmNote(ctx, "Or orient by hand: pick tracks in the Plate panel (they need a solved point), then:");
        const n = this._mmPickedPoints(st).length;
        this._mmRow(ctx, "", this._mmBtn(ctx, "Ground from picked", () => this.matchmoveOrient("ground"), { disabled: n < 3, title: "Three or more points on the floor" }),
                    this._mmBtn(ctx, "Origin at picked", () => this.matchmoveOrient("origin"), { disabled: n < 1 }));
        this._mmRow(ctx, "", this._mmBtn(ctx, "X axis along two", () => this.matchmoveOrient("x"), { disabled: n !== 2 }),
                    this._mmBtn(ctx, "Z axis along two", () => this.matchmoveOrient("z"), { disabled: n !== 2 }));
        const dist = st.dist || 1;
        this._mmRow(ctx, "", this._mmBtn(ctx, "Two picked are", () => this.matchmoveOrient("scale", dist), { disabled: n !== 2 }),
                    this._mmNum(ctx, dist, (v) => { st.dist = v > 0 ? v : 1; }, { width: "56px" }), el(ctx.doc, "span", "", "apart (scene units)"));
        this._mmNote(ctx, `${n} picked track(s) with a 3D point.`);
        this._mmNote(ctx, "Check the track with geometry on picked points:");
        this._mmRow(ctx, "", this._mmBtn(ctx, "Plane", () => this.matchmoveGeometry("plane"), { disabled: n < 3 }),
                    this._mmBtn(ctx, "Box", () => this.matchmoveGeometry("box"), { disabled: n < 1 }),
                    this._mmBtn(ctx, "Locator", () => this.matchmoveGeometry("locator"), { disabled: n < 1 }));
    },

    /** The picked tracks' solved points, in the 3D space's axes (inside the Matchmove group). */
    _mmPickedPoints(st) {
        const sv = st.mm.solve;
        if (!sv) return [];
        const by = new Map((sv.points || []).map((p) => [p.id, p]));
        return [...st.sel].map((id) => by.get(id)).filter(Boolean).map((p) => D.pointToScene(p.X));
    },

    _mmRemoveBuilt(scene, gid) {
        if (!gid) return;
        const gone = new Set([gid]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const it of scene.items) if (it.parent && gone.has(it.parent) && !gone.has(it.id)) { gone.add(it.id); grew = true; }
        }
        scene.items = scene.items.filter((it) => !gone.has(it.id));
        if (scene.activeCamera && gone.has(scene.activeCamera)) scene.activeCamera = null;
    },

    async matchmoveBuild() {
        const st = this._mmCur();
        const mm = st.mm;
        const sv = mm.solve;
        if (!sv) throw new Error("Solve the camera first.");
        const scene = this.previzScene(st.key);
        if (!scene) return;
        this.previzSnapshot("matchmove into the scene");
        // what is built is seen in the 3D view: bring it up over the plate
        if (this._mmPlateMainShown()) this.matchmovePlateMain(false);
        this._mmRemoveBuilt(scene, mm.scene.group);
        const p = mm.plate;
        const group = S.makeGroupItem(S.uniqueName(scene, "Matchmove"));
        Object.assign(group, D.orientToItem(mm.orient));
        group.matchmove = true;
        const fovv = D.fovV(sv.focal_px, p.height);
        const pxa = Number(sv.pixel_aspect) > 0 ? Number(sv.pixel_aspect) : 1;
        // the gate in square pixels: a 2x squeezed plate is twice as wide on screen
        const cam = S.makeCameraItem(S.uniqueName(scene, "Matchmove camera"), { fov: fovv, resolution: [Math.round(p.width * pxa), p.height] });
        // The plate's camera body as the film back: its recorded width across the picture, so the Channel Box's
        // focal length is the lens's (a squeezed plate's picture is the sensor's width times the squeeze).
        const sensor = Array.isArray(mm.camera.sensor) && mm.camera.sensor.length === 2 ? mm.camera.sensor : [36, 24];
        cam.filmback = [Math.round(sensor[0] * pxa * 1000) / 1000, sensor[1]];
        cam.parent = group.id;
        const frames = Object.keys(sv.frames).map(Number).sort((a, b) => a - b);
        let prev = null;
        for (const f of frames) {
            const c = sv.frames[f];
            const it = D.cameraToItem(c.R, c.t);
            const rot = D.unwrapEuler(it.rotation, prev);
            prev = rot;
            S.setKeyframe(cam, "position", f, it.position, "linear");
            S.setKeyframe(cam, "rotation", f, rot, "linear");
            if (f === frames[0]) { cam.position = it.position.slice(); cam.rotation = rot.slice(); }
        }
        const items = [group, cam];
        let plateItem = null;
        if (st.backplate !== false) {
            // The plate itself, read frame by frame and undistorted on the server: it follows the timeline in any
            // browser, and its Path in the Channel Box swaps it for another.
            const lens = this._mmLens(mm);
            plateItem = S.makeImagePlaneItem({ path: p.path, name: p.name || "Plate", kind: "plate",
                                               ...(lens.k1 || lens.k2 ? { lens } : {}) }, "Plate");
            delete plateItem.offset;
            Object.assign(plateItem, D.backplatePlace(fovv, D.backplateDistance(sv, BACKPLATE_DISTANCE)));
            if (pxa !== 1) plateItem.scale = [plateItem.scale[0] * pxa, plateItem.scale[1], plateItem.scale[2]];
            plateItem.parent = cam.id;
            items.push(plateItem);
        }
        const ptsGroup = S.makeGroupItem("Track points");
        ptsGroup.parent = group.id;
        items.push(ptsGroup);
        const best = (sv.points || []).slice().sort((a, b) => a.error - b.error).slice(0, MAX_POINTS);
        for (const q of best) {
            const loc = S.makeLocatorItem(q.id, 0.12);
            loc.position = D.pointToScene(q.X);
            loc.parent = ptsGroup.id;
            loc.mmTrack = q.id;
            items.push(loc);
        }
        for (const o of mm.objects) {
            const os = mm.objectSolves[o.id];
            if (!os) continue;
            const og = S.makeGroupItem(S.uniqueName(scene, o.name));
            og.parent = group.id;
            let pr = null;
            for (const f of Object.keys(os.frames).map(Number).sort((a, b) => a - b)) {
                const c = os.frames[f];
                const it = D.objectToItem(c.R, c.t);
                const rot = D.unwrapEuler(it.rotation, pr);
                pr = rot;
                S.setKeyframe(og, "position", f, it.position, "linear");
                S.setKeyframe(og, "rotation", f, rot, "linear");
            }
            items.push(og);
            for (const q of os.points || []) {
                const loc = S.makeLocatorItem(`${o.name} ${q.id}`, 0.12);
                loc.position = D.pointToScene(q.X);
                loc.parent = og.id;
                items.push(loc);
            }
        }
        scene.items.push(...items);
        scene.fps = p.fps;
        scene.length = p.frames;
        scene.lengthSet = true;
        scene.activeCamera = cam.id;
        mm.scene = { ...mm.scene, group: group.id, camera: cam.id, plate: plateItem ? plateItem.id : null, points: ptsGroup.id };
        scene.matchmove = { ...(scene.matchmove || {}), group: group.id, ...(st.file ? { file: st.file } : {}) };
        if (this._model3d) this._model3d.setActiveCamera(cam.id);
        this._previzSelection = cam.id;
        await this.previzChanged({ reload: true });
        // The timeline takes the shot's new length: its slider too, or its old thumb stays as a second playhead.
        if (this.applyTimelineBounds) this.applyTimelineBounds();
        if (this.previzSyncTimelineFields) this.previzSyncTimelineFields();
        this._mmChanged(st);
        // the scene names the file now; what was built is in it at once
        await this._mmSave(st);
    },

    _mmGroupItem(st) {
        return st.mm.scene && st.mm.scene.group ? S.itemById(this.previzScene(st.key), st.mm.scene.group) : null;
    },

    matchmoveOrient(how, dist) {
        const st = this._mmCur();
        const mm = st.mm;
        const pts = this._mmPickedPoints(st);
        let o = mm.orient;
        if (how === "ground") {
            const f = Math.round(this.currentFrame || 0);
            o = D.orientGround(o, pts, D.cameraCentre(mm.solve, f) || D.cameraCentre(mm.solve, Object.keys(mm.solve.frames)[0]));
        } else if (how === "origin") {
            const c = [0, 1, 2].map((i) => pts.reduce((s, p) => s + p[i], 0) / pts.length);
            o = D.orientOrigin(o, c);
        } else if (how === "x" || how === "z") o = D.orientAxis(o, pts[0], pts[1], how);
        else if (how === "scale") o = D.orientScale(o, pts[0], pts[1], dist);
        if (o.error) { notice("warn", "Not oriented", o.error); return; }
        this._mmApplyOrient(st, o, how);
    },

    matchmoveGeometry(kind) {
        const st = this._mmCur();
        const g = this._mmGroupItem(st);
        const scene = this.previzScene(st.key);
        if (!g || !scene) return;
        const pts = this._mmPickedPoints(st);
        const at = D.geometryOnPoints(kind, pts);
        if (!at) return;
        this.previzSnapshot(`matchmove ${kind}`);
        const item = kind === "locator" ? S.makeLocatorItem(S.uniqueName(scene, "Locator"), 0.5) : S.makePrimitiveItem(kind);
        if (kind !== "locator") item.name = S.uniqueName(scene, item.name);
        Object.assign(item, at);
        item.parent = g.id;
        scene.items.push(item);
        this._previzSelection = item.id;
        this.previzChanged({ reload: true });
    },

    // ── the menu ─────────────────────────────────────────────────────────────

    _previzMatchmoveMenuEntries() {
        const st = this._mmCur(false);
        const mm = st && st.mm;
        const docked = (id) => this.isPanelDocked && this.isPanelDocked(id);
        const tick = (on, label) => (on ? "✓ " : "") + label;
        return [
            { label: "Open Matchmove…", run: () => this.matchmoveOpen() },
            { label: "Choose the plate…", run: () => { this.matchmoveOpen(); this.matchmovePickPlate(); } },
            { label: "Open matchmove file…", run: () => { this.matchmoveOpen(); this.matchmoveOpenFile(); } },
            { label: "Save matchmove", disabled: !(mm && mm.plate), run: () => this._mmSave(st, { quiet: false }) },
            "-",
            { label: tick(docked("mmGuide"), "Matchmove guide"), run: () => this.togglePanelDocked("mmGuide") },
            { label: tick(docked("mmPlate"), "Plate"), run: () => this.togglePanelDocked("mmPlate") },
            "-",
            ...D.MM_STEPS.map((s) => ({ label: tick(mm && mm.step === s.id, s.title), disabled: !(mm && (mm.plate || s.id === "plate")),
                                        run: () => { this.matchmoveOpen(); this._mmCur().mm.step = s.id; this._mmRender(); } })),
            "-",
            { label: "Track the plate", disabled: !(mm && mm.plate), run: () => this.matchmoveAutoTrack().catch((e) => notice("error", "Tracking", e.message)) },
            { label: "New points on this frame", disabled: !(mm && mm.plate), run: () => this.matchmoveTrackFrom([Math.round(this.currentFrame || 0)]).catch((e) => notice("error", "Tracking", e.message)) },
            { label: "New points on the thin frames", disabled: !(mm && mm.tracks.length), run: () => this.matchmoveFillThin().catch((e) => notice("error", "Tracking", e.message)) },
            { label: "Carry tracks on", disabled: !(mm && mm.tracks.length), run: () => this.matchmoveExtendTracks().catch((e) => notice("error", "Tracking", e.message)) },
            { label: "Solve the camera", disabled: !(mm && mm.tracks.length >= 8), run: () => this.matchmoveSolve().catch((e) => notice("error", "Solve", e.message)) },
            { label: "Build in the scene", disabled: !(mm && mm.solve), run: () => this.matchmoveBuild().catch((e) => notice("error", "Build", e.message)) },
            { label: "Lens into Comp", disabled: !(mm && mm.plate), run: () => this.matchmoveLensToComp("undistort").catch((e) => notice("error", "Comp", e.message)) },
            { label: "Lens chart, full screen…", title: "A checkerboard to film with the shot's lens; the lens step reads that film", run: () => this.matchmoveLensChart() },
        ];
    },

    /** The lens chart full screen in the viewer's window (the pop-out's when popped out). */
    matchmoveLensChart() {
        const doc = (this._viewerWindow ? this._viewerWindow() : window).document;
        return openLensChart(doc);
    },

    // ── the Plate panel ──────────────────────────────────────────────────────

    /** The Bezier / B-spline switch of the Mask tool: the picked mask (every key) turned to it; new masks start as
     *  it (the choice is shared with every mask tool). A B-spline made Bezier keeps its exact outline. */
    matchmoveMaskShape(kind) {
        const st = this._mmCur(false);
        if (!st) return;
        kind = MS.shapeKind(kind);
        MS.setPreferredShape(kind);
        const m = st.maskSel && st.mm.masks.find((q) => q.id === st.maskSel && !q.matte);
        if (m && MS.shapeKind(m.shape) !== kind) {
            this._mmEdit("mask shape", (mm2) => {
                const q = mm2.masks.find((x) => x.id === m.id);
                for (const k of q.keys) k.pts = MS.convertShape(k.pts.map(MS.fromArr), q.shape, kind, true).map(MS.toArr);
                if (kind === "bspline") q.shape = "bspline"; else delete q.shape;
            });
            this._mmChanged(st);
        }
        this._mmPlateEnsure();
        this._mmDraw();
    },

    matchmoveTool(tool) {
        const st = this._mmCur();
        if (!st) return;
        if (!this._mmPlateUp()) { this.setPanelDocked("mmPlate", true); if (this.dockTabFront) this.dockTabFront("mmPlate"); }
        if (tool !== "add" && st.tool === "add") st.trackGroup = null;
        st.tool = tool;
        st.drawing = null;
        this._mmPlateEnsure();
        this._mmDraw();
    },

    // ── the Plate as a tab of the main view ──────────────────────────────────
    // Sebastian 2026-11-19: "The Plate panel should become a main panel, so I can switch easily between the 3D
    // view and the Plate panel"; 2026-11-20: the button that drew the plate over the 3D view stopped working - the
    // Plate opens as a tab of the main view instead (the main view takes panels as tabs since then). The dock moves
    // it there once (`dockIntoViewTab`, imageViewer_mixinDock.js); a user who drags it elsewhere keeps it there. The
    // tabs on the main view's title bar switch between the 3D view and the plate.

    /** Whether the plate's panel is open (in front or behind a tab). */
    _mmPlateUp() {
        return !!(this.isPanelDocked && this.isPanelDocked("mmPlate"));
    },

    /** The plate is up as a tab of the main view, in front of the 3D view. */
    _mmPlateMainShown() {
        return !!(this.isPanelViewTab && this.isPanelViewTab("mmPlate") && this.isPanelFront && this.isPanelFront("mmPlate")
                  && this.isPrevizTab && this.isPrevizTab() && this._mmCur && this._mmCur());
    },

    /**
     * The plate in front in the main view (true) or the 3D view in front (false); no argument switches. The plate
     * is moved into the main view's place first if it is elsewhere. Answers whether the plate is in front now.
     */
    matchmovePlateMain(on) {
        const want = on === undefined ? !this._mmPlateMainShown() : !!on;
        if (want) {
            if (this.dockIntoViewTab) this.dockIntoViewTab("mmPlate", { front: true });
            this.setPanelDocked("mmPlate", true);
            if (this.dockTabFront) this.dockTabFront("mmPlate");
        } else if (this.isPanelViewTab && this.isPanelViewTab("mmPlate") && this.dockViewFront) {
            this.dockViewFront();
        }
        this._mmPlateEnsure();
        const ui = this._mmUI;
        if (want && ui && ui.stage) { try { ui.stage.focus({ preventScroll: true }); } catch (_) { /* fine */ } }
        return this._mmPlateMainShown();
    },

    /** The plate panels: the first one when it is open, and every instance in front. */
    _mmPlateEnsure() {
        const inst = this._mmPlatePrimary();
        const ui = inst ? inst.ensure() : null;
        for (const { inst: extra } of this._mmPlateExtras()) extra.ensure();
        return ui;
    },

    /** Every plate draws itself: its own canvas, its own view, its own frame loop. */
    _mmDraw() {
        for (const inst of this._mmPlateAll()) inst.draw();
    },

    _mmFit(st, w, h) {
        const p = st.mm.plate;
        const z = Math.min(w / p.width, h / p.height) * 0.96;
        return { zoom: z, x: (w - p.width * z) / 2, y: (h - p.height * z) / 2 };
    },

    // Plate coordinates. `view` is the pan / zoom of the plate asking: the tab's own for the first panel, an
    // instance's own for every further one (the tracks and the lens are the tab's either way).

    _mmToScreen(st, x, y, view = st.view) {
        if (st.show.undistort) [x, y] = D.lensPoint(x, y, "undistort", this._mmLens(st.mm), st.mm.plate.width, st.mm.plate.height);
        return [x * view.zoom + view.x, y * view.zoom + view.y];
    },

    _mmToPlate(st, sx, sy, view = st.view) {
        let x = (sx - view.x) / view.zoom, y = (sy - view.y) / view.zoom;
        if (st.show.undistort) [x, y] = D.lensPoint(x, y, "distort", this._mmLens(st.mm), st.mm.plate.width, st.mm.plate.height);
        return [x, y];
    },

    /** A screen anchor from a plate anchor (the point and its tangents). */
    _mmAnchorToScreen(st, a, view = st.view) {
        const [x, y] = this._mmToScreen(st, a.x, a.y, view), [ix, iy] = this._mmToScreen(st, a.ix, a.iy, view), [ox, oy] = this._mmToScreen(st, a.ox, a.oy, view);
        return { x, y, ix, iy, ox, oy };
    },

    _mmFinishDrawing(st) {
        const pts = st.drawing || [];
        st.drawing = null;
        if (st.tool === "lines") {
            if (pts.length >= 3) this._mmEdit("line", (m) => { m.lens.lines.push(pts.map((p) => [Number(p[0].toFixed(2)), Number(p[1].toFixed(2))])); if (m.lens.source === "none") m.lens.source = "lines"; });
            else notice("warn", "Line too short", "A line needs 3 or more points.");
        } else if (st.tool === "ground") {
            if (pts.length >= 3) this.matchmoveGroundRegion(pts);
            else notice("warn", "Shape too small", "Click three or more corners round the floor.");
        } else if (st.tool === "mask") {
            if (pts.length < 3) return;
            const f = Math.round(this.currentFrame || 0);
            const forObj = st.newMaskFor;
            st.newMaskFor = null;
            let id;
            const kind = MS.preferredShape();
            this._mmEdit("mask", (m) => {
                if (forObj) m.masks = m.masks.filter((q) => !(q.mode === "object" && q.object === forObj));
                id = D.newId(m, "k");
                const obj = forObj && m.objects.find((o) => o.id === forObj);
                m.masks.push({ id, name: obj ? obj.name : `Mask ${m.masks.length + 1}`, mode: obj ? "object" : "exclude", object: obj ? obj.id : "",
                               on: true, ...(kind === "bspline" ? { shape: "bspline" } : {}),
                               keys: [{ f, pts: pts.map((p) => (kind === "bspline" ? [p[0], p[1]] : p.slice(0, p.length >= 6 ? 6 : 2))) }] });
            });
            st.maskSel = id;
        }
        this._mmDraw();
    },

    /** Asked by handleKeyDown first; true when the Plate panel took the key. */
    mmKeyDown(e) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return false;
        // whichever plate has the focus: the edits are the tab's, the view fitted is that panel's own
        const plate = this._mmPlateAll().find((inst) => inst.keyTarget(e));
        if (!plate) return false;
        const st = this._mmCur(false);
        if (!st) return false;
        const k = e.key, ctrl = e.ctrlKey || e.metaKey;
        const f = Math.round(this.currentFrame || 0);
        let done = true;
        if (k === "Enter") { if (st.drawing) this._mmFinishDrawing(st); else done = false; }
        else if (k === "Escape") { if (st.drawing) st.drawing = null; else if (st.sel.size) st.sel.clear(); else st.maskSel = null; this._mmRender(); this._mmDraw(); }
        else if ((k === "Delete" || k === "Backspace") && st.drawing && st.tool === "mask") {
            // the point placed last taken back, as in every mask tool
            st.drawing.pop();
            if (!st.drawing.length) st.drawing = null;
            this._mmDraw();
        }
        else if (k === "Delete" || k === "Backspace") {
            if (st.sel.size) this.matchmoveDeleteSelected();
            else if (st.maskSel) this._mmEdit("delete mask", (m) => { m.masks = m.masks.filter((q) => q.id !== st.maskSel); st.maskSel = null; });
        } else if (!ctrl && (k === "[" || k === "]") && st.sel.size) {
            const ids = [...st.sel];
            this._mmEdit(k === "[" ? "trim before" : "trim after", (m) => {
                for (const t of m.tracks) if (ids.includes(t.id)) D.trimTrack(t, f, k === "[" ? "before" : "after");
                m.tracks = m.tracks.filter((t) => t.keys.length);
            });
        } else if (ctrl && (k === "z" || k === "Z")) this._mmUndo(e.shiftKey);
        else if (ctrl && (k === "y" || k === "Y")) this._mmUndo(true);
        else if (ctrl && (k === "a" || k === "A")) { st.sel = new Set(st.mm.tracks.filter((t) => D.keyAt(t, f)).map((t) => t.id)); this._mmRender(); this._mmDraw(); }
        else if (!ctrl && (k === "f" || k === "F")) plate.fit();
        else if (!ctrl && (k === "q" || k === "Q")) this.matchmoveTool("select");
        else if (!ctrl && (k === "t" || k === "T")) this.matchmoveTool("add");
        else if (!ctrl && (k === "m" || k === "M")) this.matchmoveTool("mask");
        else if (!ctrl && (k === "l" || k === "L")) this.matchmoveTool("lines");
        else if (!ctrl && (k === "g" || k === "G")) this.matchmoveTool("ground");
        else if (!ctrl && (k === "o" || k === "O") && st.sel.size) {
            const ids = [...st.sel];
            this._mmEdit("track on / off", (m) => { for (const t of m.tracks) if (ids.includes(t.id)) t.on = !t.on; });
        } else done = false;
        if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
        return done;
    },
};
