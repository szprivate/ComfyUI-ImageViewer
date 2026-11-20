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
import { openFilePicker, notice, canvasContext } from "./imageViewer_exportUI.js";
import { openLensChart } from "./imageViewer_lensChart.js";

const PLATE_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".exr", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".dpx", ".heic", ".heif"];
const PICT_EXTS = [".exr", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".dpx", ".mp4", ".mov"];
const TRAIL = 12;               // frames of trail drawn behind a track
const FRAME_CACHE = 48;         // frames of the plate kept as pictures
const UNDO = 30;
const BACKPLATE_DISTANCE = 50;  // solve units (its points' median distance is 10)
const MAX_POINTS = 400;
const PLATE_SIZE = 1920;        // the longest side of the plate's pictures on the image plane         // locators made of the solved points (the best by error)

const TOOLS = [
    ["select", "Select", "Click a track to pick it (Shift adds), drag a box or a lasso round several (Shift adds, Ctrl takes away), drag a picked one to move its key here"],
    ["add", "Add track", "Click a feature: a track is made there and followed through the shot"],
    ["mask", "Mask", "Click the corners of a mask, Enter or a double-click to close it; drag a corner to key it here"],
    ["lines", "Lines", "Click along something straight in the world (3 or more points), Enter to end the line"],
    ["ground", "Ground", "Click round the floor (3 or more corners), Enter or a double-click to end: the solved tracks inside set the ground"],
];

const STYLE = `
.mm-body { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; color: #ddd; }
.mm-steps { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px 6px 4px; border-bottom: 1px solid #333; }
.mm-chip { flex: 1 1 auto; min-width: 0; padding: 3px 4px; border-radius: 4px; border: 1px solid #3a3a3a;
  background: #252525; color: #aaa; font-size: 11px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mm-chip.done { color: #9fd89f; border-color: #345; }
.mm-chip.on { background: #ff6600; color: #fff; border-color: #ff6600; }
.mm-scroll { flex: 1 1 auto; overflow: auto; padding: 8px 10px 10px; }
.mm-title { font-size: 14px; font-weight: 600; margin: 2px 0 6px; }
.mm-help { color: #bbb; line-height: 1.4; margin-bottom: 8px; }
.mm-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; flex-wrap: wrap; }
.mm-row > label { color: #aaa; min-width: 84px; }
.mm-row input[type=number], .mm-row input[type=text] { width: 70px; background: #1b1b1b; color: #eee; border: 1px solid #3a3a3a; border-radius: 3px; padding: 2px 4px; }
.mm-row select { background: #1b1b1b; color: #eee; border: 1px solid #3a3a3a; border-radius: 3px; }
.mm-btn { background: #2d2d2d; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
.mm-btn:hover { border-color: #777; }
.mm-btn.primary { background: #ff6600; border-color: #ff6600; color: #fff; }
.mm-btn:disabled { opacity: 0.45; cursor: default; }
.mm-note { color: #9a9a9a; font-size: 11px; margin: 4px 0; line-height: 1.35; }
.mm-note.warn { color: #e8b04a; }
.mm-note.bad { color: #ef6b6b; }
.mm-good { color: #9fd89f; }
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
.mm-pbar .mm-btn { padding: 2px 7px; font-size: 11px; }
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

export const PrevizMatchmoveMixin = {

    // ── the state of this tab's matchmove ────────────────────────────────────

    _mmCur(create = true) {
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
        // The 3D tab went: the plate in the main view goes with it (and comes back with the next 3D tab).
        if (this._mmPlateMainSync) this._mmPlateMainSync();
    },

    _mmRestore() {
        const want = this._mmWant;
        if (this._mmPlateMain) { this._mmPlateEnsure(); this._mmPlateMainSync(); }
        if (!want) return;
        for (const id of want) this.setPanelDocked(id, true);
        want.clear();
    },

    _mmPanelShown(id) {
        if (id === "mmGuide") this._mmRender(true);
        else this._mmPlateEnsure();
    },

    /** Draw the guide. Called on every change; cheap enough (a few dozen rows). */
    _mmRender(force = false) {
        const host = this.mmGuidePanel;
        if (!host || !this.isPanelDocked || !this.isPanelDocked("mmGuide")) { this._mmPlateEnsure(); return; }
        const st = this._mmCur();
        if (!st) return;
        this._mmStyle(host);
        const doc = host.ownerDocument;
        // keep a field being typed into
        const active = doc.activeElement;
        if (active && host.contains(active) && active.tagName === "INPUT" && active.type !== "checkbox" && !force) return;
        const oldScroll = host.querySelector(".mm-scroll");
        const top = oldScroll ? oldScroll.scrollTop : 0;
        host.querySelectorAll(":scope > .mm-body").forEach((n) => n.remove());
        const body = el(doc, "div", "mm-body");
        const mm = st.mm;
        const steps = el(doc, "div", "mm-steps");
        const done = this._mmDone(st);
        for (const s of D.MM_STEPS) {
            const c = el(doc, "button", "mm-chip", s.label);
            c.dataset.step = s.id;
            c.title = s.title;
            c.classList.toggle("on", mm.step === s.id);
            c.classList.toggle("done", !!done[s.id]);
            c.onclick = () => { mm.step = s.id; this._mmRender(); this._mmSaveSoon(st); };
            steps.append(c);
        }
        const scroll = el(doc, "div", "mm-scroll");
        const spec = D.MM_STEPS.find((s) => s.id === mm.step) || D.MM_STEPS[0];
        scroll.append(el(doc, "div", "mm-title", spec.title), el(doc, "div", "mm-help", spec.help));
        if (st.loadError) scroll.append(el(doc, "div", "mm-note bad", st.loadError));
        if (st.busy) {
            const row = el(doc, "div", "mm-row");
            row.append(el(doc, "span", "", `${st.busy.what}…`));
            const stop = el(doc, "button", "mm-btn", "Stop");
            stop.onclick = () => this._mmStop(st);
            row.append(stop);
            const bar = el(doc, "div", "mm-progress");
            bar.append(el(doc, "div"));
            scroll.append(row, bar);
            st.progressBar = bar.firstChild;
            this._mmProgress();
        }
        const ctx = { doc, st, mm, box: scroll };
        if (this._mmAskBox) this._mmAskBox(ctx);
        const draw = { plate: this._mmStepPlate, lens: this._mmStepLens, masks: this._mmStepMasks, track: this._mmStepTrack,
                       solve: this._mmStepSolve, objects: this._mmStepObjects, scene: this._mmStepScene }[spec.id];
        if (mm.step !== "plate" && !mm.plate) scroll.append(el(doc, "div", "mm-note warn", "Pick the plate first (step 1)."));
        else draw.call(this, ctx);
        if (st.saveError) scroll.append(el(doc, "div", "mm-note bad", `Not saved: ${st.saveError}`));
        else if (st.file) scroll.append(el(doc, "div", "mm-note", `Kept in ${st.file}`));
        const tips = el(doc, "details", "mm-tips");
        tips.open = !!st.tipsOpen;
        tips.ontoggle = () => { st.tipsOpen = tips.open; };
        tips.append(el(doc, "summary", "", "What to watch out for"));
        const ul = el(doc, "ul");
        for (const t of spec.tips) ul.append(el(doc, "li", "", t));
        tips.append(ul);
        scroll.append(tips);
        const nav = el(doc, "div", "mm-nav");
        const i = D.STEP_IDS.indexOf(mm.step);
        const back = el(doc, "button", "mm-btn", "‹ Back");
        back.disabled = i <= 0;
        back.onclick = () => { mm.step = D.STEP_IDS[i - 1]; this._mmRender(); };
        const next = el(doc, "button", "mm-btn primary", "Next ›");
        next.disabled = i >= D.STEP_IDS.length - 1;
        next.onclick = () => { mm.step = D.STEP_IDS[i + 1]; this._mmRender(); this._mmSaveSoon(st); };
        nav.append(back, next);
        body.append(steps, scroll, nav);
        host.append(body);
        scroll.scrollTop = top;
        this._mmPlateEnsure();
    },

    _mmProgress() {
        const st = this._mmCur(false);
        if (st && st.busy && st.progressBar) {
            const share = st.busy.total ? Math.min(1, st.busy.done / st.busy.total) : 0;
            st.progressBar.style.width = `${Math.round(share * 100)}%`;
        }
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
        const row = el(ctx.doc, "div", "mm-row");
        if (label) row.append(el(ctx.doc, "label", "", label));
        row.append(...kids.filter(Boolean));
        ctx.box.append(row);
        return row;
    },

    _mmBtn(ctx, text, run, { primary = false, title = "", disabled = false } = {}) {
        const b = el(ctx.doc, "button", `mm-btn${primary ? " primary" : ""}`, text);
        b.title = title;
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

    _mmNote(ctx, text, kind = "") { ctx.box.append(el(ctx.doc, "div", `mm-note ${kind}`.trim(), text)); },

    // ── step 1: the plate ────────────────────────────────────────────────────

    _mmStepPlate(ctx) {
        const { mm, st } = ctx;
        this._mmRow(ctx, "", this._mmBtn(ctx, mm.plate ? "Another plate…" : "Choose the plate…", () => this.matchmovePickPlate(), { primary: !mm.plate }),
                    this._mmBtn(ctx, "From the History", () => this.matchmovePlateFromHistory(), { title: "The film or picture picked in the History" }),
                    this._mmBtn(ctx, "Open matchmove…", () => this.matchmoveOpenFile(), { title: "A matchmove saved before (.mm.json)" }));
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
        this._mmRow(ctx, "", this._mmBtn(ctx, "Draw a mask", () => { st.maskSel = null; this.matchmoveTool("mask"); }, { primary: true }));
        if (this._mmMatteSection) this._mmMatteSection(ctx);
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
        this._mmRow(ctx, "Hard shots",
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
        ctx.box.append(g);
        requestAnimationFrame(() => this._mmBars(g, stats.counts, 8, "tracks a frame (red: under 8)"));
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
    },

    /** A small bar graph: one bar a frame, red under `least`. */
    _mmBars(canvas, values, least, label, { max = null } = {}) {
        const dpr = (canvas.ownerDocument.defaultView || window).devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        canvas.width = w * dpr; canvas.height = h * dpr;
        const g = canvas.getContext("2d");
        g.scale(dpr, dpr);
        const top = max || Math.max(1, ...values);
        const n = values.length || 1;
        for (let i = 0; i < n; i++) {
            const v = values[i] || 0;
            const bad = least === null ? false : (least < 0 ? v > -least : v < least);
            g.fillStyle = bad ? "#d05050" : "#5c8a5c";
            const bh = Math.max(1, (v / top) * (h - 12));
            g.fillRect((i / n) * w, h - bh, Math.max(1, w / n - 0.5), bh);
        }
        g.fillStyle = "#888";
        g.font = "10px sans-serif";
        g.fillText(label, 4, 10);
        const f = this.currentFrame || 0;
        g.fillStyle = "#ff6600";
        g.fillRect((f / n) * w, 0, 1, h);
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
        this._mmRow(ctx, "Camera", this._mmSelect(ctx, [["auto", "Find out"], ["free", "Moves freely"], ["tripod", "Only turns (tripod)"]], s.mode,
                                                  (v) => this._mmEdit("solve mode", (m) => { m.settings.mode = v; })));
        this._mmRow(ctx, "Focal length", this._mmSelect(ctx, [["auto", mm.camera.focalKnown ? "Start from the camera's, refine it" : "Find it"], ["on", "Refine it"], ["off", "Keep it fixed"]], s.refine,
                                                        (v) => this._mmEdit("refine", (m) => { m.settings.refine = v; })));
        this._mmMeasurements(ctx);
        this._mmRow(ctx, "", this._mmBtn(ctx, mm.solve ? "Solve again" : "Solve the camera", () => this.matchmoveSolve(), { primary: true, disabled: mm.tracks.length < 8 }));
        if (mm.tracks.length < 8) this._mmNote(ctx, "Track the plate first: a solve needs 8 or more tracks on every frame.", "warn");
        const sv = mm.solve;
        if (!sv) return;
        const facts = el(ctx.doc, "div", "mm-facts");
        const verdict = D.solveVerdict(sv.rms);
        const rms = el(ctx.doc, "div", sv.rms < 1 ? "mm-good" : "mm-note warn", `Error ${Number(sv.rms).toFixed(3)} px - ${verdict}`);
        facts.append(rms,
                     el(ctx.doc, "div", "", `${Object.keys(sv.frames).length} frames solved · ${sv.mode === "tripod" ? "a tripod (turns only)" : "a moving camera"}`),
                     el(ctx.doc, "div", "", `Focal length ${Number(sv.focal_px).toFixed(1)} px${D.focalMmOf(sv.focal_px, mm) ? ` = ${D.focalMmOf(sv.focal_px, mm).toFixed(2)} mm` : ""} · vertical ${Number(sv.fov_v).toFixed(2)}°`),
                     el(ctx.doc, "div", "", `${(sv.points || []).length} points in 3D`));
        if (sv.units === "m") facts.append(el(ctx.doc, "div", "mm-good", "1 unit = 1 metre, from the distances measured"));
        const fc = sv.focal_check;
        if (fc && (fc.weak || fc.better)) facts.append(el(ctx.doc, "div", "mm-note warn mm-proportions",
            fc.better ? `Proportions: a focal length 10 % ${fc.better === "short" ? "shorter" : "longer"} fits better - the depth is likely squashed or stretched.`
                      : "Proportions: the shot does not pin its focal length down, so the depth may be squashed or stretched. Measure two distances or a right angle."));
        else if (fc) facts.append(el(ctx.doc, "div", "mm-good mm-proportions", "Proportions: the focal length is pinned down by the shot."));
        for (const n of sv.notes || []) facts.append(el(ctx.doc, "div", "mm-note", n));
        ctx.box.append(facts);
        const n = mm.plate.frames;
        const per = Array.from({ length: n }, (_, f) => Number((sv.per_frame || {})[f]) || 0);
        const g = el(ctx.doc, "canvas", "mm-graph");
        ctx.box.append(g);
        requestAnimationFrame(() => this._mmBars(g, per, -1, "error a frame, px (red: over 1)", { max: Math.max(1.5, ...per) }));
        const worst = (sv.points || []).slice().sort((a, b) => b.error - a.error).slice(0, 12);
        if (worst.length) {
            this._mmNote(ctx, "The worst tracks (click to pick, then look at them on the plate):");
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
            ctx.box.append(list);
        }
        const share = st.worstShare || 10;
        this._mmRow(ctx, "Clean up", this._mmBtn(ctx, "Delete the worst", () => this._mmEdit("delete worst", (m) => D.removeTracks(m, D.withoutMeasured(m, D.worstTracks(m.solve, { share: share / 100 }))))),
                    this._mmNum(ctx, share, (v) => { st.worstShare = Math.max(1, Math.min(50, v || 10)); }, { step: 1, width: "44px" }), el(ctx.doc, "span", "", "%"),
                    this._mmBtn(ctx, "over 1 px", () => this._mmEdit("delete over 1 px", (m) => D.removeTracks(m, D.withoutMeasured(m, D.worstTracks(m.solve, { px: 1 }))))));
        this._mmRow(ctx, "", this._mmBtn(ctx, "Into the scene ›", () => { mm.step = "scene"; this._mmRender(); }));
    },

    /** The Measurements section of the Solve step: real distances and shapes from the tracks picked. */
    _mmMeasurements(ctx) {
        const { mm, st } = ctx;
        const box = el(ctx.doc, "div", "mm-facts mm-measure");
        box.append(el(ctx.doc, "div", "", "Measurements"),
                   el(ctx.doc, "div", "mm-note", "Pick tracks in the Plate panel (click, Shift+click, a box or the lasso), then say what they are. They keep the solve's proportions true: two distances in different directions, or a right angle, cure a squashed solve."));
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

    async matchmoveSolve() {
        const st = this._mmCur();
        const mm = st.mm;
        const p = mm.plate;
        const fpx = this._mmFocalFor(mm) || (mm.settings.refine === "off" && st.lensFocal) || null;
        // "auto": find it when not known, else start from the camera's and refine it - a camera's metadata (a
        // phone's above all: stabilisation crops) is near, and a focal length held a little off squashes the depth
        const refine = mm.settings.refine === "on" ? true : mm.settings.refine === "off" ? false : fpx ? true : null;
        const d = await this._mmJob(st, "Solving", this._mmPost("/imageviewer/mm_solve", {
            width: p.width, height: p.height, tracks: mm.tracks.filter((t) => t.on), lens: this._mmLens(mm), focal_px: fpx || undefined,
            mode: mm.settings.mode, refine, pixel_aspect: D.pixelAspect(mm),
            constraints: (mm.constraints || []).filter((c) => c.on !== false),
        }));
        const res = d.result || {};
        if (d.state === "error" || res.error) throw new Error(res.error || d.error || "the solve failed");
        if (d.state === "stopped") return;
        this._mmEdit("solve", (m) => { m.solve = res; m.objectSolves = {}; });
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
            { label: tick(docked("mmPlate"), "Plate"), run: () => { if (this._mmPlateMain) this.matchmovePlateMain(false); else this.togglePanelDocked("mmPlate"); } },
            { label: tick(this._mmPlateMainShown(), "Plate in the main view"), disabled: !st,
              title: "The plate in place of the 3D view, and back", run: () => this.matchmovePlateMain() },
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

    // ── the Plate in the main view ───────────────────────────────────────────
    // Sebastian 2026-11-19: "The Plate panel should become a main panel, so I can switch easily between the 3D
    // view and the Plate panel". The plate is then drawn over the main view (`.mm-plate-main` in the dock view's
    // body, the 3D view under it as it was - nothing re-parented, nothing resized) and its dock panel is put away;
    // the main view's switch, the Plate's own ⇄ button and the Matchmove menu switch back.

    /** Whether the plate is drawn anywhere: in the main view (on a 3D tab with a matchmove) or as its panel. */
    _mmPlateUp() {
        if (this._mmPlateMainShown()) return true;
        return !!(this.isPanelDocked && this.isPanelDocked("mmPlate"));
    },

    /** The plate is in the main view right now. */
    _mmPlateMainShown() {
        return !!(this._mmPlateMain && this.isPrevizTab && this.isPrevizTab() && this._mmCur && this._mmCur());
    },

    /** Where the plate is drawn: the main view's overlay, or the Plate panel. */
    _mmPlateHost() {
        if (!this._mmPlateMain) return this.mmPlatePanel;
        const body = this.dockViewBody;
        if (!body) return this.mmPlatePanel;
        let h = body.querySelector(":scope > .mm-plate-main");
        if (!h) {
            h = body.ownerDocument.createElement("div");
            h.className = "mm-plate-main";
            body.append(h);
        }
        return h;
    },

    /** Show or hide the main view's plate by the state (also from dockViewTitleSync, which switchTab calls). */
    _mmPlateOverlayShow() {
        const body = this.dockViewBody;
        const h = body && body.querySelector(":scope > .mm-plate-main");
        const on = this._mmPlateMainShown();
        if (h) h.style.display = on ? "block" : "none";
        return on;
    },

    /** The overlay and the main view's name. */
    _mmPlateMainSync() {
        if (this.dockViewTitleSync) this.dockViewTitleSync();
        else this._mmPlateOverlayShow();
    },

    /**
     * The plate in the main view (true), back in its panel (false), or the other way round (no argument).
     * Answers whether it is in the main view now.
     */
    matchmovePlateMain(on) {
        const want = on === undefined ? !this._mmPlateMain : !!on;
        if (want === !!this._mmPlateMain) { this._mmPlateEnsure(); this._mmPlateMainSync(); return want; }
        const old = this._mmUI;
        if (old && old.raf) { const w = old.root.ownerDocument.defaultView || window; w.cancelAnimationFrame(old.raf); }
        if (old && old.root) old.root.remove();
        this._mmUI = null;
        if (want) {
            this._mmPlateWasDocked = !!(this.isPanelDocked && this.isPanelDocked("mmPlate"));
            this._mmPlateMain = true;
            if (this._mmPlateWasDocked) this.setPanelDocked("mmPlate", false);
        } else {
            this._mmPlateMain = false;
            const h = this.dockViewBody && this.dockViewBody.querySelector(":scope > .mm-plate-main");
            if (h) h.remove();
            if (this._mmPlateWasDocked !== false && this.setPanelDocked) {
                this.setPanelDocked("mmPlate", true);
                if (this.dockTabFront) this.dockTabFront("mmPlate");
            }
        }
        try { localStorage.setItem("imageviewer.viewer.mmPlateMain", want ? "1" : "0"); } catch (_) { /* not kept */ }
        this._mmPlateEnsure();
        this._mmPlateMainSync();
        const ui = this._mmUI;
        if (ui && ui.stage) { try { ui.stage.focus({ preventScroll: true }); } catch (_) { /* fine */ } }
        return want;
    },

    /** The main view's switch menu: the 3D view and the plate, on a 3D tab with a matchmove. */
    matchmoveViewEntries() {
        if (!(this.isPrevizTab && this.isPrevizTab() && this._mmCur && this._mmCur())) return [];
        const main = this._mmPlateMainShown();
        return [{ head: "Matchmove" },
            { label: (main ? "     " : "\u2713  ") + "3D view", title: "The 3D view in the main view", run: () => this.matchmovePlateMain(false) },
            { label: (main ? "\u2713  " : "     ") + "Plate", title: "The plate, its tracks and masks in the main view",
              run: () => this.matchmovePlateMain(true) }];
    },

    _mmPlateEnsure() {
        if (this._mmPlateMain === undefined) {
            let kept = null;
            try { kept = localStorage.getItem("imageviewer.viewer.mmPlateMain"); } catch (_) { kept = null; }
            this._mmPlateMain = kept === "1";
        }
        const host = this._mmPlateHost();
        this._mmPlateMainSync();
        if (!host || !this._mmPlateUp() || (this._mmPlateMain && !this._mmPlateMainShown())) return null;
        const st = this._mmCur();
        if (!st) return null;
        this._mmStyle(host);
        let ui = this._mmUI;
        if (!ui || !ui.root.isConnected || ui.root.parentNode !== host) {
            host.querySelectorAll(":scope > .mm-plate").forEach((n) => n.remove());
            const doc = host.ownerDocument;
            const root = el(doc, "div", "mm-plate");
            const bar = el(doc, "div", "mm-pbar");
            const tools = {};
            for (const [id, label, title] of TOOLS) {
                const b = el(doc, "button", "mm-btn", label);
                b.title = title;
                b.dataset.tool = id;
                b.onclick = () => this.matchmoveTool(id);
                tools[id] = b;
                bar.append(b);
            }
            const toggles = {};
            for (const [id, label, title] of [["trails", "Trails", "The tracks' paths over the last frames"],
                                               ["solved", "Solved", "Where the solved 3D points land (cyan): far from their track = a bad track"]]) {
                const b = el(doc, "button", "mm-btn", label);
                b.title = title;
                b.onclick = () => { const s = this._mmCur(); s.show[id] = !s.show[id]; this._mmDraw(); };
                toggles[id] = b;
                bar.append(b);
            }
            const shape = el(doc, "button", "mm-btn mm-select-shape", "Box");
            shape.title = "How a drag with Select picks tracks: a box, or a lasso drawn round them (Shift adds, Ctrl takes away)";
            shape.onclick = () => { const s2 = this._mmCur(); s2.selectShape = s2.selectShape === "lasso" ? "box" : "lasso"; if (s2.tool !== "select") this.matchmoveTool("select"); this._mmPlateEnsure(); };
            bar.append(shape);
            const swap = el(doc, "button", "mm-btn mm-plate-swap", "");
            swap.onclick = () => this.matchmovePlateMain();
            bar.append(swap);
            const fit = el(doc, "button", "mm-btn", "Fit");
            fit.title = "The whole plate in view (F)";
            fit.onclick = () => { this._mmCur().view = null; this._mmDraw(); };
            const info = el(doc, "span", "mm-info", "");
            bar.append(fit, info);
            const stage = el(doc, "div", "mm-stage");
            stage.tabIndex = 0;
            const canvas = el(doc, "canvas");
            const empty = el(doc, "div", "mm-empty", "");
            stage.append(canvas, empty);
            root.append(bar, stage);
            host.append(root);
            ui = this._mmUI = { root, bar, tools, toggles, shape, info, stage, canvas, empty, lastFrame: -1, raf: 0 };
            this._mmWirePlate(ui);
        }
        for (const [id, b] of Object.entries(ui.tools)) b.classList.toggle("on", st.tool === id);
        for (const [id, b] of Object.entries(ui.toggles)) b.classList.toggle("on", !!st.show[id]);
        const inMain = !!this._mmPlateMain;
        ui.swap = ui.swap || ui.bar.querySelector(".mm-plate-swap");
        if (ui.swap) {
            ui.swap.textContent = inMain ? "⇄ 3D view" : "⇄ Main view";
            ui.swap.title = inMain ? "Back to the 3D view in the main view; the plate goes back to its panel"
                                   : "The plate in the main view, in place of the 3D view";
        }
        ui.shape.textContent = st.selectShape === "lasso" ? "Lasso" : "Box";
        ui.shape.classList.toggle("on", st.selectShape === "lasso");
        this._mmLoop();
        return ui;
    },

    /** A frame loop while the panel is up: redraws when the viewer's frame or the panel's size changed. */
    _mmLoop() {
        const ui = this._mmUI;
        if (!ui || ui.raf) return;
        const win = ui.root.ownerDocument.defaultView || window;
        const tick = () => {
            ui.raf = 0;
            if (!ui.root.isConnected || !this._mmPlateUp() || !this.isPrevizTab || !this.isPrevizTab()) return;
            const f = Math.round(this.currentFrame || 0);
            const w = ui.stage.clientWidth, h = ui.stage.clientHeight;
            if (f !== ui.lastFrame || w !== ui.lastW || h !== ui.lastH || ui.dirty) {
                ui.lastFrame = f; ui.lastW = w; ui.lastH = h; ui.dirty = false;
                this._mmDrawNow();
            }
            ui.raf = win.requestAnimationFrame(tick);
        };
        ui.raf = win.requestAnimationFrame(tick);
    },

    _mmDraw() {
        if (this._mmUI) this._mmUI.dirty = true;
        this._mmLoop();
    },

    /** The plate's picture at frame f: a cached Image of mm_frame (undistorted when asked); null while it loads. */
    _mmFrameImage(st, f, size) {
        const mm = st.mm;
        const lens = st.show.undistort ? this._mmLens(mm) : null;
        const key = `${f}|${size}|${lens ? `${lens.k1},${lens.k2}` : ""}`;
        let img = st.frames.get(key);
        if (img) { st.frames.delete(key); st.frames.set(key, img); return img.complete && img.naturalWidth ? img : (st.frameNear || null); }
        const doc = this._mmUI.root.ownerDocument;
        img = new (doc.defaultView || window).Image();
        const q = { path: mm.plate.path, frame: f, size };
        if (lens && (lens.k1 || lens.k2)) {
            q.k1 = lens.k1; q.k2 = lens.k2;
            if (lens.center) { q.cx = lens.center[0]; q.cy = lens.center[1]; }
        }
        img.onload = () => { st.frameNear = img; this._mmDraw(); };
        img.src = api.apiURL(`/imageviewer/mm_frame?${new URLSearchParams(q)}`);
        st.frames.set(key, img);
        while (st.frames.size > FRAME_CACHE) st.frames.delete(st.frames.keys().next().value);
        return st.frameNear || null;
    },

    _mmFit(st, w, h) {
        const p = st.mm.plate;
        const z = Math.min(w / p.width, h / p.height) * 0.96;
        return { zoom: z, x: (w - p.width * z) / 2, y: (h - p.height * z) / 2 };
    },

    _mmToScreen(st, x, y) {
        const v = st.view;
        if (st.show.undistort) [x, y] = D.lensPoint(x, y, "undistort", this._mmLens(st.mm), st.mm.plate.width, st.mm.plate.height);
        return [x * v.zoom + v.x, y * v.zoom + v.y];
    },

    _mmToPlate(st, sx, sy) {
        const v = st.view;
        let x = (sx - v.x) / v.zoom, y = (sy - v.y) / v.zoom;
        if (st.show.undistort) [x, y] = D.lensPoint(x, y, "distort", this._mmLens(st.mm), st.mm.plate.width, st.mm.plate.height);
        return [x, y];
    },

    _mmDrawNow() {
        const ui = this._mmUI;
        const st = this._mmCur(false);
        if (!ui || !st) return;
        const doc = ui.root.ownerDocument;
        const dpr = (doc.defaultView || window).devicePixelRatio || 1;
        const w = ui.stage.clientWidth, h = ui.stage.clientHeight;
        const c = ui.canvas;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const g = c.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        const mm = st.mm;
        ui.empty.style.display = mm.plate ? "none" : "flex";
        if (!mm.plate) {
            ui.empty.textContent = "No plate yet: pick one in the Matchmove guide (step 1).";
            ui.info.textContent = "";
            return;
        }
        if (!st.view) st.view = this._mmFit(st, w, h);
        const f = Math.max(0, Math.min(mm.plate.frames - 1, Math.round(this.currentFrame || 0)));
        const v = st.view;
        const size = Math.max(128, Math.min(4096, Math.ceil(Math.max(mm.plate.width, mm.plate.height) * v.zoom * dpr / 256) * 256));
        const img = this._mmFrameImage(st, f, size);
        if (img) g.drawImage(img, v.x, v.y, mm.plate.width * v.zoom, mm.plate.height * v.zoom);
        g.strokeStyle = "#444";
        g.strokeRect(v.x, v.y, mm.plate.width * v.zoom, mm.plate.height * v.zoom);
        // masks
        for (const m of mm.masks) {
            if (m.matte) {
                const mc = this._mmMatteCanvas && this._mmMatteCanvas(m, f, doc);
                if (mc && !st.show.undistort) g.drawImage(mc, v.x, v.y, mm.plate.width * v.zoom, mm.plate.height * v.zoom);
                if (st.maskSel === m.id) { g.strokeStyle = "#fff"; g.strokeRect(v.x + 1, v.y + 1, mm.plate.width * v.zoom - 2, mm.plate.height * v.zoom - 2); }
                continue;
            }
            const pts = D.maskAt(m, f);
            if (pts.length < 3) continue;
            g.beginPath();
            pts.forEach(([x, y], i) => { const [a, b] = this._mmToScreen(st, x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
            g.closePath();
            g.fillStyle = !m.on ? "rgba(120,120,120,0.12)" : m.mode === "object" ? "rgba(80,160,255,0.18)" : "rgba(255,60,60,0.2)";
            g.fill();
            g.strokeStyle = st.maskSel === m.id ? "#fff" : m.mode === "object" ? "#5aa0ff" : "#ff5050";
            g.lineWidth = st.maskSel === m.id ? 1.5 : 1;
            g.stroke();
            if (st.maskSel === m.id && st.tool === "mask") {
                const keyed = m.keys.some((k) => k.f === f);
                for (const [x, y] of pts) { const [a, b] = this._mmToScreen(st, x, y); g.fillStyle = keyed ? "#ffcc00" : "#fff"; g.fillRect(a - 3, b - 3, 6, 6); }
            }
        }
        // lens lines
        if (mm.lens.lines.length || (st.drawing && st.tool === "lines")) {
            g.strokeStyle = "#ffd24a";
            g.lineWidth = 1.5;
            for (const line of [...mm.lens.lines, ...(st.drawing && st.tool === "lines" ? [st.drawing] : [])]) {
                g.beginPath();
                line.forEach(([x, y], i) => { const [a, b] = this._mmToScreen(st, x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
                g.stroke();
                for (const [x, y] of line) { const [a, b] = this._mmToScreen(st, x, y); g.fillStyle = "#ffd24a"; g.fillRect(a - 2, b - 2, 4, 4); }
            }
        }
        // the ground's shape (while the Ground tool is up)
        if (st.tool === "ground" && st.groundRegion && st.groundRegion.pts.length >= 3) {
            g.beginPath();
            st.groundRegion.pts.forEach(([x, y], i) => { const [a, b] = this._mmToScreen(st, x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
            g.closePath();
            g.fillStyle = "rgba(90,220,120,0.14)";
            g.fill();
            g.strokeStyle = "#5adc78";
            g.lineWidth = 1;
            g.stroke();
        }
        if (st.drawing && (st.tool === "mask" || st.tool === "ground") && st.drawing.length) {
            g.strokeStyle = st.tool === "ground" ? "#5adc78" : "#fff";
            g.beginPath();
            st.drawing.forEach(([x, y], i) => { const [a, b] = this._mmToScreen(st, x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
            g.stroke();
        }
        // tracks
        const errOf = new Map(((mm.solve && mm.solve.points) || []).map((p) => [p.id, p]));
        let shown = 0;
        for (const t of mm.tracks) {
            const k = D.keyAt(t, f);
            const sel = st.sel.has(t.id);
            if (st.show.trails && (k || sel)) {
                g.beginPath();
                let started = false;
                for (const q of t.keys) {
                    if (q[0] < f - TRAIL || q[0] > f) continue;
                    const [a, b] = this._mmToScreen(st, q[1], q[2]);
                    if (started) g.lineTo(a, b); else { g.moveTo(a, b); started = true; }
                }
                g.strokeStyle = sel ? "rgba(255,255,255,0.8)" : "rgba(255,170,60,0.5)";
                g.lineWidth = 1;
                g.stroke();
            }
            if (!k) continue;
            shown++;
            const [a, b] = this._mmToScreen(st, k[1], k[2]);
            const e = errOf.get(t.id);
            const col = !t.on ? "#777" : t.group !== "camera" ? "#5aa0ff" : e ? (e.error < 0.5 ? "#6ce06c" : e.error < 1 ? "#e8d04a" : "#ef5050") : "#ffaa3c";
            g.strokeStyle = sel ? "#fff" : col;
            g.lineWidth = sel ? 2 : 1.2;
            const r = sel ? 6 : 4;
            g.beginPath();
            g.moveTo(a - r, b); g.lineTo(a + r, b); g.moveTo(a, b - r); g.lineTo(a, b + r);
            g.stroke();
            if (sel) { g.strokeRect(a - 8, b - 8, 16, 16); }
            if (st.show.solved && e && mm.solve) {
                const pr = D.projectPoint(mm.solve, f, e.X, this._mmLens(mm), mm.plate.width, mm.plate.height);
                if (pr) {
                    const [pa, pb] = this._mmToScreen(st, pr[0], pr[1]);
                    g.strokeStyle = "#3fd0e0";
                    g.beginPath(); g.arc(pa, pb, 2.5, 0, Math.PI * 2); g.stroke();
                    g.beginPath(); g.moveTo(a, b); g.lineTo(pa, pb); g.stroke();
                }
            }
        }
        // measurements: their tracks joined on this frame (green: holds after the solve, orange: not yet / off)
        for (const c of mm.constraints || []) {
            const at = c.ids.map((id) => { const t = mm.tracks.find((q) => q.id === id); const k = t && D.keyAt(t, f); return k ? this._mmToScreen(st, k[1], k[2]) : null; });
            if (at.filter(Boolean).length < 2) continue;
            const r = D.constraintResult(mm.solve, c.id);
            g.strokeStyle = c.on === false ? "rgba(150,150,150,0.6)" : r && r.ok ? "rgba(90,220,120,0.85)" : "rgba(255,170,60,0.85)";
            g.lineWidth = 1.5;
            g.setLineDash(c.kind === "distance" ? [] : [5, 3]);
            g.beginPath();
            let started = false;
            for (const q of at) { if (!q) continue; if (started) g.lineTo(q[0], q[1]); else { g.moveTo(q[0], q[1]); started = true; } }
            if (c.kind === "plane" && at.filter(Boolean).length >= 3) g.closePath();
            g.stroke();
            g.setLineDash([]);
            if (c.kind === "distance" && at[0] && at[1]) {
                g.fillStyle = g.strokeStyle;
                g.font = "11px sans-serif";
                g.fillText(`${Number(c.value.toFixed(3))} m`, (at[0][0] + at[1][0]) / 2 + 4, (at[0][1] + at[1][1]) / 2 - 4);
            }
        }
        if (st.lasso && st.lasso.length > 1) {
            g.strokeStyle = "#fff";
            g.setLineDash([4, 3]);
            g.beginPath();
            g.moveTo(st.lasso[0][0], st.lasso[0][1]);
            for (const [x, y] of st.lasso.slice(1)) g.lineTo(x, y);
            g.closePath();
            g.stroke();
            g.setLineDash([]);
        }
        if (st.box) {
            g.strokeStyle = "#fff";
            g.setLineDash([4, 3]);
            g.strokeRect(Math.min(st.box[0], st.box[2]), Math.min(st.box[1], st.box[3]), Math.abs(st.box[2] - st.box[0]), Math.abs(st.box[3] - st.box[1]));
            g.setLineDash([]);
        }
        const tool = TOOLS.find((t) => t[0] === st.tool);
        ui.info.textContent = `frame ${f} · ${shown} tracks here${st.sel.size ? ` · ${st.sel.size} picked` : ""}${mm.solve ? ` · solve ${Number(mm.solve.rms).toFixed(2)} px` : ""} · ${tool ? tool[1] : ""}`;
        ui.stage.dataset.frame = String(f);
        ui.stage.dataset.shown = String(shown);
    },

    _mmWirePlate(ui) {
        const stage = ui.stage;
        const pos = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        stage.addEventListener("wheel", (e) => {
            const st = this._mmCur(false);
            if (!st || !st.view) return;
            e.preventDefault();
            const [sx, sy] = pos(e);
            const k = Math.exp(-e.deltaY * 0.0015);
            const v = st.view;
            v.x = sx - (sx - v.x) * k; v.y = sy - (sy - v.y) * k; v.zoom *= k;
            this._mmDraw();
        }, { passive: false });
        stage.addEventListener("pointerdown", (e) => {
            const st = this._mmCur(false);
            if (!st || !st.mm.plate || !st.view) return;
            stage.focus();
            this._mmFocused = true;
            const [sx, sy] = pos(e);
            const win = stage.ownerDocument.defaultView || window;
            const f = Math.round(this.currentFrame || 0);
            let move = null, up = null;
            if (e.button === 1 || (e.button === 0 && e.altKey)) {
                const v0 = { ...st.view };
                move = (ev) => { const [x, y] = pos(ev); st.view.x = v0.x + x - sx; st.view.y = v0.y + y - sy; this._mmDraw(); };
            } else if (e.button === 0) {
                const [px, py] = this._mmToPlate(st, sx, sy);
                const radius = 9 / st.view.zoom;
                if (st.tool === "add") {
                    this.matchmoveAddTrackAt(px, py).catch((err) => notice("error", "Track", err.message));
                    return;
                }
                if (st.tool === "lines" || st.tool === "ground") {
                    st.drawing = st.drawing || [];
                    st.drawing.push([px, py]);
                    if (e.detail >= 2 && st.tool === "ground" && st.drawing.length >= 4) st.drawing.pop();
                    if (e.detail >= 2) this._mmFinishDrawing(st);
                    this._mmDraw();
                    return;
                }
                if (st.tool === "mask") {
                    const m = st.maskSel && st.mm.masks.find((q) => q.id === st.maskSel);
                    if (m && !st.drawing) {
                        const pts = D.maskAt(m, f).map((p) => p.slice());
                        const i = pts.findIndex(([x, y]) => Math.hypot(x - px, y - py) <= radius);
                        if (i >= 0) {
                            let first = true;
                            move = (ev) => {
                                const [qx, qy] = this._mmToPlate(st, ...pos(ev));
                                pts[i] = [qx, qy];
                                if (first) { this._mmEdit("mask key", (mm2) => D.setMaskKey(mm2.masks.find((q) => q.id === m.id), f, pts)); first = false; }
                                else { D.setMaskKey(st.mm.masks.find((q) => q.id === m.id), f, pts); this._mmDraw(); }
                            };
                            up = () => this._mmChanged(st);
                        } else if (!D.pointInPolygon(pts, px, py)) {
                            st.maskSel = null;
                            st.drawing = [[px, py]];
                        }
                    } else {
                        st.drawing = st.drawing || [];
                        st.drawing.push([px, py]);
                        if (e.detail >= 2 && st.drawing.length >= 4) { st.drawing.pop(); this._mmFinishDrawing(st); }
                    }
                    this._mmDraw();
                    if (!move) return;
                }
                if (st.tool === "select") {
                    const hit = D.trackNear(st.mm, f, px, py, radius);
                    if (hit) {
                        if (e.shiftKey || e.ctrlKey || e.metaKey) { if (st.sel.has(hit.id)) st.sel.delete(hit.id); else st.sel.add(hit.id); }
                        else if (!st.sel.has(hit.id)) st.sel = new Set([hit.id]);
                        let first = true;
                        const k0 = D.keyAt(hit, f).slice();
                        move = (ev) => {
                            const [qx, qy] = this._mmToPlate(st, ...pos(ev));
                            if (Math.hypot(qx - px, qy - py) * st.view.zoom < 2 && first) return;
                            if (first) { this._mmEdit("move key", (m) => { const t = m.tracks.find((q) => q.id === hit.id); D.setKey(t, f, qx, qy, 1); t.manual = true; }); first = false; }
                            else { D.setKey(st.mm.tracks.find((q) => q.id === hit.id), f, k0[1] + qx - px, k0[2] + qy - py, 1); this._mmDraw(); }
                        };
                        up = () => { if (!first) this._mmChanged(st); else { this._mmRender(); this._mmDraw(); } };
                    } else {
                        // a box, or a lasso (the bar's Box / Lasso switch): plain replaces, Shift adds, Ctrl takes away
                        const remove = e.ctrlKey || e.metaKey;
                        if (!e.shiftKey && !remove) st.sel.clear();
                        const take = (ids) => { for (const id of ids) if (remove) st.sel.delete(id); else st.sel.add(id); };
                        if (st.selectShape === "lasso") {
                            st.lasso = [[sx, sy]];
                            move = (ev) => {
                                const [x, y] = pos(ev);
                                const l = st.lasso[st.lasso.length - 1];
                                if (Math.hypot(x - l[0], y - l[1]) >= 3) { st.lasso.push([x, y]); this._mmDraw(); }
                            };
                            up = () => {
                                const poly = st.lasso.map(([x, y]) => this._mmToPlate(st, x, y));
                                st.lasso = null;
                                if (poly.length >= 3) take(D.tracksInPolygon(st.mm, f, poly));
                                this._mmRender(); this._mmDraw();
                            };
                        } else {
                            st.box = [sx, sy, sx, sy];
                            move = (ev) => { const [x, y] = pos(ev); st.box[2] = x; st.box[3] = y; this._mmDraw(); };
                            up = () => {
                                const [x0, y0] = this._mmToPlate(st, st.box[0], st.box[1]);
                                const [x1, y1] = this._mmToPlate(st, st.box[2], st.box[3]);
                                take(D.tracksInRect(st.mm, f, x0, y0, x1, y1));
                                st.box = null;
                                this._mmRender(); this._mmDraw();
                            };
                        }
                    }
                    this._mmDraw();
                }
            }
            if (!move) return;
            e.preventDefault();
            const mv = (ev) => move(ev);
            const end = (ev) => {
                win.removeEventListener("pointermove", mv);
                win.removeEventListener("pointerup", end);
                if (up) up(ev);
            };
            win.addEventListener("pointermove", mv);
            win.addEventListener("pointerup", end);
        });
        stage.addEventListener("focusout", () => { this._mmFocused = false; });
        stage.addEventListener("contextmenu", (e) => e.preventDefault());
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
            this._mmEdit("mask", (m) => {
                if (forObj) m.masks = m.masks.filter((q) => !(q.mode === "object" && q.object === forObj));
                id = D.newId(m, "k");
                const obj = forObj && m.objects.find((o) => o.id === forObj);
                m.masks.push({ id, name: obj ? obj.name : `Mask ${m.masks.length + 1}`, mode: obj ? "object" : "exclude", object: obj ? obj.id : "",
                               on: true, keys: [{ f, pts: pts.map((p) => [p[0], p[1]]) }] });
            });
            st.maskSel = id;
        }
        this._mmDraw();
    },

    /** Asked by handleKeyDown first; true when the Plate panel took the key. */
    mmKeyDown(e) {
        const ui = this._mmUI;
        if (!ui || !this._mmFocused || !ui.root.isConnected || !this.isPrevizTab || !this.isPrevizTab()) return false;
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(ui.stage)) return false;
        const st = this._mmCur(false);
        if (!st) return false;
        const k = e.key, ctrl = e.ctrlKey || e.metaKey;
        const f = Math.round(this.currentFrame || 0);
        let done = true;
        if (k === "Enter") { if (st.drawing) this._mmFinishDrawing(st); else done = false; }
        else if (k === "Escape") { if (st.drawing) st.drawing = null; else if (st.sel.size) st.sel.clear(); else st.maskSel = null; this._mmRender(); this._mmDraw(); }
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
        else if (!ctrl && (k === "f" || k === "F")) { st.view = null; this._mmDraw(); }
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
