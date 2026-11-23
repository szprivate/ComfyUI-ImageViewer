// imageViewer_previzMatchmoveInstance.js
// One Matchmove guide and one Plate panel, each as a closure with its own view of the tab's matchmove. The
// panels come in instances (Sebastian 2026-11-23): the first of each keeps the plain id and its state on the
// viewer (st === viewer, so this._mmUI and every older caller of this._mmRender / this._mmDraw still read and
// write it); every further one is made here with a state object of its own. The dock registers the makers
// (PrevizMatchmoveMixin._mmRegisterMakers) and places the element.
//
// The matchmove itself is the TAB's (_mmTabs in imageViewer_previzMatchmove.js): the plate, the tracks, the
// masks, the solve, what is picked and the tool in hand are SHARED - two plates show the same shot and edit the
// same tracks, and a guide's buttons drive the same solve. What is an instance's own is its view of them: the
// guide's step and scroll, the plate's pan and zoom, its canvas and the frame loop that draws it. The step
// builders, the edits, undo, the autosave and the error graph's loop stay on the viewer.
import { api } from "../../scripts/api.js";
import * as D from "./imageViewer_matchmoveData.js";
import * as MS from "./imageViewer_maskShape.js";
import { notice } from "./imageViewer_exportUI.js";
import { setEditIcon } from "./imageViewer_editIcons.js";

const TRAIL = 12;               // frames of trail drawn behind a track
const FRAME_CACHE = 48;         // frames of the plate kept as pictures

const TOOLS = [
    ["select", "Select", "Click a track to pick it (Shift adds), drag a box or a lasso round several (Shift adds, Ctrl takes away), drag a picked one to move its key here"],
    ["add", "Add track", "Click a feature: a track is made there and followed through the shot"],
    ["mask", "Mask", "Click to place a mask's points (drag: pull out tangents), click the first point, Enter or a double-click to close it; drag a point to key it here"],
    ["lines", "Lines", "Click along something straight in the world (3 or more points), Enter to end the line"],
    ["ground", "Ground", "Click round the floor (3 or more corners), Enter or a double-click to end: the solved tracks inside set the ground"],
];

const TOOL_ICONS = { select: "select", add: "mmAdd", mask: "mmMask", lines: "mmLines", ground: "mmGround" };

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

/**
 * Make a Matchmove guide in `host`. `st` holds what this guide keeps of its own (the viewer itself for the first
 * one, a fresh object for every further one); `saved` is what a layout carried for it, if anything.
 * Returns the instance the dock keeps: { el, render, progress, wake, save, dispose }.
 */
export function createMmGuideInstance(v, host, st, saved) {
    const primary = st === v;
    let wantScroll = saved && Number.isFinite(saved.scroll) ? saved.scroll : null;
    let bar = null;
    if (!primary && saved && D.STEP_IDS.includes(saved.step)) st._mmGuideStep = saved.step;

    // The first guide shows the step the matchmove itself is on (it is saved with it); every further one keeps
    // its own, seeded from it, so two guides can stand on two steps of the same shot.
    const stepNow = (mm) => (primary ? mm.step : (st._mmGuideStep || mm.step));
    const setStep = (mm, id) => { if (primary) mm.step = id; else st._mmGuideStep = id; };

    /** Draw the guide. Called on every change; cheap enough (a few dozen rows). */
    function render(force = false) {
        const tab = v._mmCur();
        if (!tab) return;
        v._mmStyle(host);
        const doc = host.ownerDocument;
        // keep a field being typed into
        const active = doc.activeElement;
        if (active && host.contains(active) && active.tagName === "INPUT" && active.type !== "checkbox" && !force) return;
        const oldScroll = host.querySelector(".mm-scroll");
        const top = oldScroll ? oldScroll.scrollTop : (wantScroll || 0);
        wantScroll = null;
        host.querySelectorAll(":scope > .mm-body").forEach((n) => n.remove());
        const body = el(doc, "div", "mm-body");
        const mm = tab.mm;
        const step = stepNow(mm);
        const steps = el(doc, "div", "mm-steps");
        const done = v._mmDone(tab);
        D.MM_STEPS.forEach((s, n) => {
            const c = el(doc, "button", "mm-chip");
            c.append(el(doc, "span", "mm-chip-n", done[s.id] && step !== s.id ? "✓" : String(n + 1)), el(doc, "span", "mm-chip-l", s.label));
            c.dataset.step = s.id;
            c.title = `${n + 1}. ${s.title}`;
            c.classList.toggle("on", step === s.id);
            c.classList.toggle("done", !!done[s.id]);
            c.onclick = () => { setStep(mm, s.id); v._mmRender(); v._mmSaveSoon(tab); };
            steps.append(c);
        });
        const scroll = el(doc, "div", "mm-scroll");
        const spec = D.MM_STEPS.find((s) => s.id === step) || D.MM_STEPS[0];
        scroll.append(el(doc, "div", "mm-title", spec.title), v._mmHelp(doc, "mm-help", spec.help));
        if (tab.loadError) scroll.append(el(doc, "div", "mm-note bad", tab.loadError));
        bar = null;
        if (tab.busy) {
            const row = el(doc, "div", "mm-row");
            row.append(el(doc, "span", "", `${tab.busy.what}…`));
            const stop = el(doc, "button", "mm-btn", "Stop");
            stop.onclick = () => v._mmStop(tab);
            row.append(stop);
            const prog = el(doc, "div", "mm-progress");
            prog.append(el(doc, "div"));
            scroll.append(row, prog);
            bar = prog.firstChild;
            v._mmProgress();
        }
        const ctx = { doc, st: tab, mm, box: scroll, setStep: (id) => { setStep(mm, id); v._mmRender(); } };
        if (v._mmAskBox) v._mmAskBox(ctx);
        const draw = { plate: v._mmStepPlate, lens: v._mmStepLens, masks: v._mmStepMasks, track: v._mmStepTrack,
                       solve: v._mmStepSolve, objects: v._mmStepObjects, scene: v._mmStepScene }[spec.id];
        if (step !== "plate" && !mm.plate) scroll.append(el(doc, "div", "mm-note warn", "Pick the plate first (step 1)."));
        else draw.call(v, ctx);
        if (tab.saveError) scroll.append(el(doc, "div", "mm-note bad", `Not saved: ${tab.saveError}`));
        else if (tab.file) {
            const savedRow = el(doc, "div", "mm-saved");
            const name = el(doc, "span", "mm-note", `Saved as ${tab.file.split(/[\\/]/).pop()}`);
            name.title = tab.file;
            const copy = el(doc, "button", "mm-btn", "Copy path");
            copy.title = tab.file;
            copy.onclick = () => {
                const nav = (doc.defaultView || window).navigator;
                Promise.resolve(nav.clipboard && nav.clipboard.writeText(tab.file))
                    .then(() => notice("info", "Path copied", tab.file), () => notice("warn", "Not copied", tab.file));
            };
            savedRow.append(name, copy);
            scroll.append(savedRow);
        }
        const tips = el(doc, "details", "mm-tips");
        tips.open = !!tab.tipsOpen;
        tips.ontoggle = () => { tab.tipsOpen = tips.open; };
        tips.append(el(doc, "summary", "", "What to watch out for"));
        const ul = el(doc, "ul");
        for (const t of spec.tips) ul.append(el(doc, "li", "", t));
        tips.append(ul);
        scroll.append(tips);
        const nav = el(doc, "div", "mm-nav");
        const i = D.STEP_IDS.indexOf(step);
        const back = el(doc, "button", "mm-btn", "‹ Back");
        back.disabled = i <= 0;
        back.onclick = () => { setStep(mm, D.STEP_IDS[i - 1]); v._mmRender(); };
        const next = el(doc, "button", "mm-btn primary", "Next ›");
        next.disabled = i >= D.STEP_IDS.length - 1;
        next.onclick = () => { setStep(mm, D.STEP_IDS[i + 1]); v._mmRender(); v._mmSaveSoon(tab); };
        nav.append(back, next);
        body.append(steps, scroll, nav);
        host.append(body);
        scroll.scrollTop = top;
    }

    return {
        el: host,
        render,
        /** The job's progress, on this guide's own bar (every guide shows the same job). */
        progress(share) { if (bar) bar.style.width = `${Math.round(share * 100)}%`; },
        wake() { render(true); },
        save() {
            const tab = v._mmCur(false);
            const sc = host.querySelector(".mm-scroll");
            return { step: tab ? stepNow(tab.mm) : null, scroll: sc ? sc.scrollTop : 0 };
        },
        dispose() { bar = null; },
    };
}

/**
 * Make a Plate panel in `host`. `st` holds what this plate keeps of its own (the viewer itself for the first
 * one, a fresh object for every further one): its ui cache, its pan / zoom and its frame loop. `saved` is what
 * a layout carried for it. Returns the instance the dock keeps: { el, ui, ensure, draw, fit, keyTarget, wake,
 * save, dispose }.
 */
export function createMmPlateInstance(v, host, st, saved) {
    const primary = st === v;
    const id = primary ? "mmPlate" : host.dataset.panel;
    const tab = () => v._mmCur(false);
    let offDrag = null;
    let watch = null;

    if (!primary) {
        const t = tab();
        st.view = saved && saved.view ? { ...saved.view } : (t && t.view ? { ...t.view } : null);
        st.plateFor = t && t.mm.plate ? t.mm.plate.path : null;
    }

    /** The view this plate draws with: the tab's own for the first one, its own (seeded from the tab's) after that. */
    const viewOfTab = (t) => (primary ? t.view : st.view);

    function viewFor(t, ui) {
        const w = ui.stage.clientWidth, h = ui.stage.clientHeight;
        if (primary) {
            if (!t.view) t.view = v._mmFit(t, w, h);
            return t.view;
        }
        const path = t.mm.plate ? t.mm.plate.path : null;
        if (st.plateFor !== path) { st.plateFor = path; st.view = null; }   // another plate: fit it again
        if (!st.view) st.view = v._mmFit(t, w, h);
        return st.view;
    }

    /** The panel is up, in front and not folded: only then does its canvas need drawing. */
    function alive() {
        const ui = st._mmUI;
        return !!(ui && ui.root.isConnected && v.isPrevizTab && v.isPrevizTab()
                  && v.isPanelDocked && v.isPanelDocked(id) && v.isPanelFront && v.isPanelFront(id)
                  && !(v.isPanelCollapsed && v.isPanelCollapsed(id)));
    }

    function build() {
        host.querySelectorAll(":scope > .mm-plate").forEach((n) => n.remove());
        const doc = host.ownerDocument;
        const root = el(doc, "div", "mm-plate");
        // three groups: the tools (and how Select drags) | what is drawn over the plate | the view
        const bar = el(doc, "div", "mm-pbar");
        const group = () => { const g = el(doc, "div", "mm-pgroup"); bar.append(g); return g; };
        const sep = () => bar.append(el(doc, "span", "mm-psep"));
        const icon = (b, name) => { const t = b.title; setEditIcon(b, name); b.title = t; };
        const gTools = group();
        const tools = {};
        let shape = null;
        for (const [tid, label, title] of TOOLS) {
            const b = el(doc, "button", "mm-btn", label);
            b.title = `${label}: ${title}`;
            b.dataset.tool = tid;
            b.onclick = () => v.matchmoveTool(tid);
            icon(b, TOOL_ICONS[tid]);
            tools[tid] = b;
            gTools.append(b);
            if (tid === "mask") {
                // Bezier / B-spline: the picked mask is turned to it, new masks start as it (shared by every mask tool).
                const sw = MS.shapeSwitch(doc, MS.preferredShape(), (k) => v.matchmoveMaskShape(k), { label: "" });
                sw.classList.add("mm-mask-shape");
                gTools.append(sw);
                tools.__shape = sw;
            }
            if (tid === "select") {
                shape = el(doc, "button", "mm-btn mm-select-shape", "");
                shape.title = "Box or lasso: how a drag with Select picks tracks (Shift adds, Ctrl takes away)";
                shape.onclick = () => { const t = v._mmCur(); t.selectShape = t.selectShape === "lasso" ? "box" : "lasso"; if (t.tool !== "select") v.matchmoveTool("select"); v._mmPlateEnsure(); };
                gTools.append(shape);
            }
        }
        sep();
        const gShow = group();
        const toggles = {};
        for (const [tid, label, title, ic] of [["trails", "Trails", "the tracks' paths over the last frames", "mmTrails"],
                                               ["solved", "Solved", "where the solved 3D points land (cyan): far from their track = a bad track", "mmSolved"]]) {
            const b = el(doc, "button", "mm-btn", label);
            b.title = `${label}: ${title}`;
            b.onclick = () => { const t = v._mmCur(); t.show[tid] = !t.show[tid]; v._mmDraw(); v._mmPlateEnsure(); };
            icon(b, ic);
            toggles[tid] = b;
            gShow.append(b);
        }
        sep();
        const gView = group();
        const fit = el(doc, "button", "mm-btn mm-fit", "Fit");
        fit.title = "Fit: the whole plate in view (F)";
        fit.onclick = () => fitView();
        icon(fit, "fit");
        gView.append(fit);
        const info = el(doc, "span", "mm-info", "");
        bar.append(info);
        const stage = el(doc, "div", "mm-stage");
        stage.tabIndex = 0;
        const canvas = el(doc, "canvas");
        const empty = el(doc, "div", "mm-empty", "");
        stage.append(canvas, empty);
        root.append(bar, stage);
        host.append(root);
        const ui = { root, bar, tools, toggles, shape, info, stage, canvas, empty, lastFrame: -1, raf: 0 };
        st._mmUI = ui;
        wire(ui);
        // A fold opened, a splitter moved or a place come back: the loop had stopped, and the size says so.
        try {
            watch = new (doc.defaultView || window).ResizeObserver(() => { const u = st._mmUI; if (u) { u.dirty = true; loop(); } });
            watch.observe(stage);
        } catch (_) { watch = null; }
        return ui;
    }

    const uiNow = () => {
        const ui = st._mmUI;
        return (ui && ui.root.isConnected && ui.root.parentNode === host) ? ui : build();
    };

    /** The bar as the tab's tool and switches stand, and the frame loop going. */
    function ensure() {
        if (!v.isPanelDocked || !v.isPanelDocked(id)) return null;
        const t = v._mmCur();
        if (!t) return null;
        v._mmStyle(host);
        const ui = uiNow();
        for (const [tid, b] of Object.entries(ui.tools)) if (tid !== "__shape") b.classList.toggle("on", t.tool === tid);
        if (ui.tools.__shape) {
            const pick = t.maskSel && t.mm.masks.find((q) => q.id === t.maskSel && !q.matte);
            ui.tools.__shape.style.display = t.tool === "mask" ? "" : "none";
            ui.tools.__shape.setShape(pick ? pick.shape : MS.preferredShape());
        }
        for (const [tid, b] of Object.entries(ui.toggles)) b.classList.toggle("on", !!t.show[tid]);
        const lasso = t.selectShape === "lasso";
        if (ui.shape.dataset.icon !== (lasso ? "mmLasso" : "mmBox")) {
            const title = ui.shape.title;
            setEditIcon(ui.shape, lasso ? "mmLasso" : "mmBox");
            ui.shape.title = title;
        }
        ui.shape.dataset.shape = lasso ? "lasso" : "box";
        loop();
        return ui;
    }

    /** A frame loop of this plate's own while it is up and in front: redraws when the frame or the size changed. */
    function loop() {
        const ui = st._mmUI;
        if (!ui || ui.raf) return;
        const win = ui.root.ownerDocument.defaultView || window;
        const tick = () => {
            ui.raf = 0;
            if (!alive()) return;
            const f = Math.round(v.currentFrame || 0);
            const w = ui.stage.clientWidth, h = ui.stage.clientHeight;
            if (f !== ui.lastFrame || w !== ui.lastW || h !== ui.lastH || ui.dirty) {
                ui.lastFrame = f; ui.lastW = w; ui.lastH = h; ui.dirty = false;
                drawNow();
            }
            ui.raf = win.requestAnimationFrame(tick);
        };
        ui.raf = win.requestAnimationFrame(tick);
    }

    function draw() {
        if (st._mmUI) st._mmUI.dirty = true;
        loop();
    }

    function fitView() {
        const t = tab();
        if (primary) { if (t) t.view = null; } else st.view = null;
        draw();
    }

    /** The plate's picture at frame f: a cached Image of mm_frame (undistorted when asked); null while it loads. */
    function frameImage(t, ui, f, size) {
        const mm = t.mm;
        const lens = t.show.undistort ? v._mmLens(mm) : null;
        const key = `${f}|${size}|${lens ? `${lens.k1},${lens.k2}` : ""}`;
        let img = t.frames.get(key);
        if (img) { t.frames.delete(key); t.frames.set(key, img); return img.complete && img.naturalWidth ? img : (t.frameNear || null); }
        const doc = ui.root.ownerDocument;
        img = new (doc.defaultView || window).Image();
        const q = { path: mm.plate.path, frame: f, size };
        if (lens && (lens.k1 || lens.k2)) {
            q.k1 = lens.k1; q.k2 = lens.k2;
            if (lens.center) { q.cx = lens.center[0]; q.cy = lens.center[1]; }
        }
        img.onload = () => { t.frameNear = img; v._mmDraw(); };
        img.src = api.apiURL(`/imageviewer/mm_frame?${new URLSearchParams(q)}`);
        t.frames.set(key, img);
        while (t.frames.size > FRAME_CACHE) t.frames.delete(t.frames.keys().next().value);
        return t.frameNear || null;
    }

    function drawNow() {
        const ui = st._mmUI;
        const t = tab();
        if (!ui || !t) return;
        const doc = ui.root.ownerDocument;
        const dpr = (doc.defaultView || window).devicePixelRatio || 1;
        const w = ui.stage.clientWidth, h = ui.stage.clientHeight;
        const c = ui.canvas;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const g = c.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        const mm = t.mm;
        ui.empty.style.display = mm.plate ? "none" : "flex";
        if (!mm.plate) {
            ui.empty.textContent = "No plate yet: pick one in the Matchmove guide (step 1).";
            ui.info.textContent = "";
            return;
        }
        const view = viewFor(t, ui);
        const toScreen = (x, y) => v._mmToScreen(t, x, y, view);
        const anchor = (a) => v._mmAnchorToScreen(t, a, view);
        const f = Math.max(0, Math.min(mm.plate.frames - 1, Math.round(v.currentFrame || 0)));
        const size = Math.max(128, Math.min(4096, Math.ceil(Math.max(mm.plate.width, mm.plate.height) * view.zoom * dpr / 256) * 256));
        const img = frameImage(t, ui, f, size);
        if (img) g.drawImage(img, view.x, view.y, mm.plate.width * view.zoom, mm.plate.height * view.zoom);
        g.strokeStyle = "#444";
        g.strokeRect(view.x, view.y, mm.plate.width * view.zoom, mm.plate.height * view.zoom);
        // masks
        for (const m of mm.masks) {
            if (m.matte) {
                const mc = v._mmMatteCanvas && v._mmMatteCanvas(m, f, doc);
                if (mc && !t.show.undistort) g.drawImage(mc, view.x, view.y, mm.plate.width * view.zoom, mm.plate.height * view.zoom);
                if (t.maskSel === m.id) { g.strokeStyle = "#fff"; g.strokeRect(view.x + 1, view.y + 1, mm.plate.width * view.zoom - 2, mm.plate.height * view.zoom - 2); }
                continue;
            }
            const pts = D.maskAt(m, f);
            if (pts.length < 3) continue;
            const poly = D.maskPolygon(m, f);
            g.beginPath();
            poly.forEach(([x, y], i) => { const [a, b] = toScreen(x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
            g.closePath();
            g.fillStyle = !m.on ? "rgba(120,120,120,0.12)" : m.mode === "object" ? "rgba(80,160,255,0.18)" : "rgba(255,60,60,0.2)";
            g.fill();
            g.strokeStyle = t.maskSel === m.id ? "#fff" : m.mode === "object" ? "#5aa0ff" : "#ff5050";
            g.lineWidth = t.maskSel === m.id ? 1.5 : 1;
            g.stroke();
            if (t.maskSel === m.id && t.tool === "mask") {
                const keyed = m.keys.some((k) => k.f === f);
                // The same guide as every mask tool: a B-spline's control polygon, the picked point's tangents.
                const scr = pts.map((p) => anchor(MS.fromArr(p)));
                if (m.shape === "bspline") MS.drawGuide(g, { polygon: scr.map((a) => [a.x, a.y]), closed: true });
                else if (t.maskPt != null && scr[t.maskPt]) MS.drawGuide(g, { handles: MS.handleLines(scr, [t.maskPt]) });
                scr.forEach((a, i) => { g.fillStyle = i === t.maskPt ? "#ff8a00" : keyed ? "#ffcc00" : "#fff"; g.fillRect(a.x - 3, a.y - 3, 6, 6); });
            }
        }
        // lens lines
        if (mm.lens.lines.length || (t.drawing && t.tool === "lines")) {
            g.strokeStyle = "#ffd24a";
            g.lineWidth = 1.5;
            for (const line of [...mm.lens.lines, ...(t.drawing && t.tool === "lines" ? [t.drawing] : [])]) {
                g.beginPath();
                line.forEach(([x, y], i) => { const [a, b] = toScreen(x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
                g.stroke();
                for (const [x, y] of line) { const [a, b] = toScreen(x, y); g.fillStyle = "#ffd24a"; g.fillRect(a - 2, b - 2, 4, 4); }
            }
        }
        // the ground's shape (while the Ground tool is up)
        if (t.tool === "ground" && t.groundRegion && t.groundRegion.pts.length >= 3) {
            g.beginPath();
            t.groundRegion.pts.forEach(([x, y], i) => { const [a, b] = toScreen(x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
            g.closePath();
            g.fillStyle = "rgba(90,220,120,0.14)";
            g.fill();
            g.strokeStyle = "#5adc78";
            g.lineWidth = 1;
            g.stroke();
        }
        if (t.drawing && t.tool === "mask" && t.drawing.length) {
            // A mask on its way: its curve so far, and the tangents of the point just placed (Bezier) or the
            // control polygon (B-spline) - the guide every mask tool draws.
            const kind = MS.preferredShape();
            const scr = t.drawing.map((p) => anchor(MS.fromArr(p)));
            g.strokeStyle = "#fff";
            g.lineWidth = 1.5;
            g.stroke(new Path2D(MS.curveD(MS.curveAnchors(scr, kind, false), false, (x, y) => [x, y])));
            if (kind === "bspline") MS.drawGuide(g, { polygon: scr.map((a) => [a.x, a.y]) });
            else MS.drawGuide(g, { handles: MS.handleLines(scr, [scr.length - 2, scr.length - 1].filter((i) => i >= 0)) });
            for (const a of scr) { g.fillStyle = "#fff"; g.fillRect(a.x - 3, a.y - 3, 6, 6); }
        }
        if (t.drawing && t.tool === "ground" && t.drawing.length) {
            g.strokeStyle = "#5adc78";
            g.beginPath();
            t.drawing.forEach(([x, y], i) => { const [a, b] = toScreen(x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
            g.stroke();
        }
        // tracks
        const errOf = new Map(((mm.solve && mm.solve.points) || []).map((p) => [p.id, p]));
        let shown = 0;
        for (const tr of mm.tracks) {
            const k = D.keyAt(tr, f);
            const sel = t.sel.has(tr.id);
            if (t.show.trails && (k || sel)) {
                g.beginPath();
                let started = false;
                for (const q of tr.keys) {
                    if (q[0] < f - TRAIL || q[0] > f) continue;
                    const [a, b] = toScreen(q[1], q[2]);
                    if (started) g.lineTo(a, b); else { g.moveTo(a, b); started = true; }
                }
                g.strokeStyle = sel ? "rgba(255,255,255,0.8)" : "rgba(255,170,60,0.5)";
                g.lineWidth = 1;
                g.stroke();
            }
            if (!k) continue;
            shown++;
            const [a, b] = toScreen(k[1], k[2]);
            const e = errOf.get(tr.id);
            const col = !tr.on ? "#777" : tr.group !== "camera" ? "#5aa0ff" : e ? (e.error < 0.5 ? "#6ce06c" : e.error < 1 ? "#e8d04a" : "#ef5050") : "#ffaa3c";
            g.strokeStyle = sel ? "#fff" : col;
            g.lineWidth = sel ? 2 : 1.2;
            const r = sel ? 6 : 4;
            g.beginPath();
            g.moveTo(a - r, b); g.lineTo(a + r, b); g.moveTo(a, b - r); g.lineTo(a, b + r);
            g.stroke();
            if (sel) { g.strokeRect(a - 8, b - 8, 16, 16); }
            if (t.show.solved && e && mm.solve) {
                const pr = D.projectPoint(mm.solve, f, e.X, v._mmLens(mm), mm.plate.width, mm.plate.height);
                if (pr) {
                    const [pa, pb] = toScreen(pr[0], pr[1]);
                    g.strokeStyle = "#3fd0e0";
                    g.beginPath(); g.arc(pa, pb, 2.5, 0, Math.PI * 2); g.stroke();
                    g.beginPath(); g.moveTo(a, b); g.lineTo(pa, pb); g.stroke();
                }
            }
        }
        // measurements: their tracks joined on this frame (green: holds after the solve, orange: not yet / off)
        for (const con of mm.constraints || []) {
            const at = con.ids.map((cid) => { const tr = mm.tracks.find((q) => q.id === cid); const k = tr && D.keyAt(tr, f); return k ? toScreen(k[1], k[2]) : null; });
            if (at.filter(Boolean).length < 2) continue;
            const r = D.constraintResult(mm.solve, con.id);
            g.strokeStyle = con.on === false ? "rgba(150,150,150,0.6)" : r && r.ok ? "rgba(90,220,120,0.85)" : "rgba(255,170,60,0.85)";
            g.lineWidth = 1.5;
            g.setLineDash(con.kind === "distance" ? [] : [5, 3]);
            g.beginPath();
            let started = false;
            for (const q of at) { if (!q) continue; if (started) g.lineTo(q[0], q[1]); else { g.moveTo(q[0], q[1]); started = true; } }
            if (con.kind === "plane" && at.filter(Boolean).length >= 3) g.closePath();
            g.stroke();
            g.setLineDash([]);
            if (con.kind === "distance" && at[0] && at[1]) {
                g.fillStyle = g.strokeStyle;
                g.font = "11px sans-serif";
                g.fillText(`${Number(con.value.toFixed(3))} m`, (at[0][0] + at[1][0]) / 2 + 4, (at[0][1] + at[1][1]) / 2 - 4);
            }
        }
        if (v._mmDrawPins) v._mmDrawPins(g, t, f, toScreen);
        if (t.lasso && t.lasso.length > 1) {
            g.strokeStyle = "#fff";
            g.setLineDash([4, 3]);
            g.beginPath();
            g.moveTo(t.lasso[0][0], t.lasso[0][1]);
            for (const [x, y] of t.lasso.slice(1)) g.lineTo(x, y);
            g.closePath();
            g.stroke();
            g.setLineDash([]);
        }
        if (t.box) {
            g.strokeStyle = "#fff";
            g.setLineDash([4, 3]);
            g.strokeRect(Math.min(t.box[0], t.box[2]), Math.min(t.box[1], t.box[3]), Math.abs(t.box[2] - t.box[0]), Math.abs(t.box[3] - t.box[1]));
            g.setLineDash([]);
        }
        const tool = TOOLS.find((q) => q[0] === t.tool);
        ui.info.textContent = `frame ${f} · ${shown} tracks here${t.sel.size ? ` · ${t.sel.size} picked` : ""}${mm.solve ? ` · solve ${Number(mm.solve.rms).toFixed(2)} px` : ""} · ${tool ? tool[1] : ""}`;
        ui.stage.dataset.frame = String(f);
        ui.stage.dataset.shown = String(shown);
    }

    function wire(ui) {
        const stage = ui.stage;
        const pos = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        stage.addEventListener("wheel", (e) => {
            const t = tab();
            const view = t && viewOfTab(t);
            if (!t || !view) return;
            e.preventDefault();
            const [sx, sy] = pos(e);
            const k = Math.exp(-e.deltaY * 0.0015);
            view.x = sx - (sx - view.x) * k; view.y = sy - (sy - view.y) * k; view.zoom *= k;
            v._mmDraw();
        }, { passive: false });
        stage.addEventListener("pointerdown", (e) => {
            const t = tab();
            const view = t && t.mm.plate && viewOfTab(t);
            if (!t || !view) return;
            stage.focus();
            st._mmFocused = true;
            const toPlate = (sx, sy) => v._mmToPlate(t, sx, sy, view);
            const [sx, sy] = pos(e);
            const win = stage.ownerDocument.defaultView || window;
            const f = Math.round(v.currentFrame || 0);
            let move = null, up = null;
            // The Mask tool's Alt+click (add a point / pull out tangents) and right-click (take a point away) on the
            // picked mask come before Alt-drag panning; anywhere else they pan / do nothing as before.
            if (t.tool === "mask" && !t.drawing && (e.button === 2 || (e.button === 0 && e.altKey))) {
                const [px, py] = toPlate(sx, sy);
                const m = t.maskSel && t.mm.masks.find((q) => q.id === t.maskSel && !q.matte);
                const r = m ? maskDown(t, view, m, e, px, py, 9 / view.zoom, f, pos) : false;
                if (r) { move = r.move || null; up = r.up || null; v._mmDraw(); if (!move) return; }
            }
            if (move) { /* the mask's own drag */ }
            else if (e.button === 1 || (e.button === 0 && e.altKey)) {
                const v0 = { ...view };
                move = (ev) => { const [x, y] = pos(ev); view.x = v0.x + x - sx; view.y = v0.y + y - sy; v._mmDraw(); };
            } else if (e.button === 0) {
                const [px, py] = toPlate(sx, sy);
                const radius = 9 / view.zoom;
                if (t.tool === "add") {
                    v.matchmoveAddTrackAt(px, py).catch((err) => notice("error", "Track", err.message));
                    return;
                }
                if (t.tool === "lines" || t.tool === "ground") {
                    t.drawing = t.drawing || [];
                    t.drawing.push([px, py]);
                    if (e.detail >= 2 && t.tool === "ground" && t.drawing.length >= 4) t.drawing.pop();
                    if (e.detail >= 2) v._mmFinishDrawing(t);
                    v._mmDraw();
                    return;
                }
                if (t.tool === "mask") {
                    const m = t.maskSel && t.mm.masks.find((q) => q.id === t.maskSel && !q.matte);
                    const r = maskDown(t, view, m, e, px, py, radius, f, pos);
                    if (r) { move = r.move || null; up = r.up || null; }
                    v._mmDraw();
                    if (!move) return;
                }
                if (t.tool === "select") {
                    const hit = D.trackNear(t.mm, f, px, py, radius);
                    if (hit) {
                        if (e.shiftKey || e.ctrlKey || e.metaKey) { if (t.sel.has(hit.id)) t.sel.delete(hit.id); else t.sel.add(hit.id); }
                        else if (!t.sel.has(hit.id)) t.sel = new Set([hit.id]);
                        let first = true;
                        const k0 = D.keyAt(hit, f).slice();
                        move = (ev) => {
                            const [qx, qy] = toPlate(...pos(ev));
                            if (Math.hypot(qx - px, qy - py) * view.zoom < 2 && first) return;
                            if (first) { v._mmEdit("move key", (m) => { const tr = m.tracks.find((q) => q.id === hit.id); D.setKey(tr, f, qx, qy, 1); tr.manual = true; }); first = false; }
                            else { D.setKey(t.mm.tracks.find((q) => q.id === hit.id), f, k0[1] + qx - px, k0[2] + qy - py, 1); v._mmDraw(); }
                        };
                        up = () => { if (!first) v._mmChanged(t); else { v._mmRender(); v._mmDraw(); } };
                    } else {
                        // a box, or a lasso (the bar's Box / Lasso switch): plain replaces, Shift adds, Ctrl takes away
                        const remove = e.ctrlKey || e.metaKey;
                        if (!e.shiftKey && !remove) t.sel.clear();
                        const take = (ids) => { for (const cid of ids) if (remove) t.sel.delete(cid); else t.sel.add(cid); };
                        if (t.selectShape === "lasso") {
                            t.lasso = [[sx, sy]];
                            move = (ev) => {
                                const [x, y] = pos(ev);
                                const l = t.lasso[t.lasso.length - 1];
                                if (Math.hypot(x - l[0], y - l[1]) >= 3) { t.lasso.push([x, y]); v._mmDraw(); }
                            };
                            up = () => {
                                const poly = t.lasso.map(([x, y]) => toPlate(x, y));
                                t.lasso = null;
                                if (poly.length >= 3) take(D.tracksInPolygon(t.mm, f, poly));
                                v._mmRender(); v._mmDraw();
                            };
                        } else {
                            t.box = [sx, sy, sx, sy];
                            move = (ev) => { const [x, y] = pos(ev); t.box[2] = x; t.box[3] = y; v._mmDraw(); };
                            up = () => {
                                const [x0, y0] = toPlate(t.box[0], t.box[1]);
                                const [x1, y1] = toPlate(t.box[2], t.box[3]);
                                take(D.tracksInRect(t.mm, f, x0, y0, x1, y1));
                                t.box = null;
                                v._mmRender(); v._mmDraw();
                            };
                        }
                    }
                    v._mmDraw();
                }
            }
            if (!move) return;
            e.preventDefault();
            const mv = (ev) => move(ev);
            const off = () => {
                win.removeEventListener("pointermove", mv);
                win.removeEventListener("pointerup", end);
            };
            const end = (ev) => { off(); offDrag = null; if (up) up(ev); };
            offDrag = off;
            win.addEventListener("pointermove", mv);
            win.addEventListener("pointerup", end);
        });
        stage.addEventListener("focusout", () => { st._mmFocused = false; });
        stage.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    /**
     * A press with the Mask tool, by the rules every mask tool shares (imageViewer_maskShape.js): while drawing, a
     * click places a point and its drag pulls out the point's tangents (a B-spline's: moves it), the first point /
     * a double-click closes; on the picked mask, a point or a tangent is dragged (keyed at this frame), Alt+click
     * on the outline adds a point, right-click on a point takes it away; elsewhere a new mask is begun.
     * -> {move, up} for a drag, {} when the press was taken, false when it was not (Alt pans, then).
     */
    function maskDown(t, view, m, e, px, py, radius, f, pos) {
        const toScreen = (x, y) => v._mmToScreen(t, x, y, view);
        const toPlate = (sx, sy) => v._mmToPlate(t, sx, sy, view);
        const kind = MS.preferredShape();
        const place = () => {
            const pt = [px, py];
            t.drawing.push(pt);
            const s0 = toScreen(px, py);
            return {
                move: (ev) => {
                    const [qx, qy] = toPlate(...pos(ev));
                    const at = t.drawing && t.drawing.indexOf(pt);
                    if (at == null || at < 0) return;
                    if (kind === "bspline") { t.drawing[at] = [qx, qy]; v._mmDraw(); return; }
                    const s1 = toScreen(qx, qy);
                    if (Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < 2) return;
                    t.drawing[at] = [px, py, 2 * px - qx, 2 * py - qy, qx, qy];
                    v._mmDraw();
                },
                up: () => v._mmDraw(),
            };
        };
        if (t.drawing) {
            if (e.button !== 0) return false;
            const d = t.drawing;
            if (d.length >= 3 && (MS.isDoubleClick(t, e, e.clientX, e.clientY) || Math.hypot(d[0][0] - px, d[0][1] - py) <= radius)) { v._mmFinishDrawing(t); return {}; }
            return place();
        }
        if (m) {
            const pts = D.maskAt(m, f).map((p) => p.slice());
            const key = (fn) => {
                let first = true;
                return (ev) => {
                    fn(toPlate(...pos(ev)), ev);
                    if (first) { v._mmEdit("mask key", (mm2) => D.setMaskKey(mm2.masks.find((q) => q.id === m.id), f, pts)); first = false; }
                    else { D.setMaskKey(t.mm.masks.find((q) => q.id === m.id), f, pts); v._mmDraw(); }
                };
            };
            // the picked point's tangents (Bezier)
            if (m.shape !== "bspline" && t.maskPt != null && pts[t.maskPt]) {
                const i = t.maskPt, a = MS.fromArr(pts[i]);
                for (const side of ["in", "out"]) {
                    const hx = side === "in" ? a.ix : a.ox, hy = side === "in" ? a.iy : a.oy;
                    if ((hx !== a.x || hy !== a.y) && Math.hypot(hx - px, hy - py) <= radius) {
                        return { move: key(([qx, qy], ev) => {
                            const b = { ...a };
                            if (side === "in") { b.ix = qx; b.iy = qy; } else { b.ox = qx; b.oy = qy; }
                            if (!ev.altKey) {   // the other side mirrored, unless Alt breaks the tangent
                                if (side === "in") { b.ox = 2 * a.x - qx; b.oy = 2 * a.y - qy; } else { b.ix = 2 * a.x - qx; b.iy = 2 * a.y - qy; }
                            }
                            pts[i] = [b.x, b.y, b.ix, b.iy, b.ox, b.oy];
                        }), up: () => v._mmChanged(t) };
                    }
                }
            }
            const i = pts.findIndex((p) => Math.hypot(p[0] - px, p[1] - py) <= radius);
            if (i >= 0 && e.button === 2) {
                if (pts.length <= 3) { notice("warn", "Mask", "A mask needs three points; delete the mask instead."); return {}; }
                v._mmEdit("mask point", (mm2) => { for (const k of mm2.masks.find((q) => q.id === m.id).keys) if (k.pts.length === pts.length) k.pts.splice(i, 1); });
                t.maskPt = null;
                v._mmChanged(t);
                return {};
            }
            if (e.button === 2) return false;
            if (i >= 0 && e.button === 0 && e.altKey && m.shape !== "bspline") {
                // Alt+drag on a point pulls out its tangents (mirrored), as when it was placed
                t.maskPt = i;
                const a = MS.fromArr(pts[i]);
                return { move: key(([qx, qy]) => { pts[i] = [a.x, a.y, 2 * a.x - qx, 2 * a.y - qy, qx, qy]; }), up: () => v._mmChanged(t) };
            }
            if (i >= 0 && e.button === 0) {
                t.maskPt = i;
                const a = MS.fromArr(pts[i]);
                return { move: key(([qx, qy]) => {
                    const dx = qx - a.x, dy = qy - a.y;   // the tangents ride along
                    pts[i] = pts[i].length >= 6 ? [qx, qy, a.ix + dx, a.iy + dy, a.ox + dx, a.oy + dy] : [qx, qy];
                }), up: () => v._mmChanged(t) };
            }
            const poly = D.maskPolygon(m, f);
            if (e.button === 0 && e.altKey) {
                // a point on the outline between the two around it, in every key (keys keep as many points)
                const anch = MS.curveAnchors(pts.map(MS.fromArr), m.shape, true);
                let best = null;
                anch.forEach((a, j) => {
                    const b = anch[(j + 1) % anch.length];
                    for (let k = 1; k < 24; k++) {
                        const [x, y] = MS.bezierAt(a, b, k / 24), dd = Math.hypot(x - px, y - py);
                        if (!best || dd < best.d) best = { j, t: k / 24, d: dd };
                    }
                });
                if (!best || best.d > radius * 1.6) return false;
                {
                    v._mmEdit("mask point", (mm2) => {
                        const mk = mm2.masks.find((q) => q.id === m.id);
                        for (const k of mk.keys) {
                            if (k.pts.length !== pts.length) continue;
                            const A = MS.curveAnchors(k.pts.map(MS.fromArr), mk.shape, true);
                            const [x, y] = MS.bezierAt(A[best.j], A[(best.j + 1) % A.length], best.t);
                            k.pts.splice(best.j + 1, 0, [x, y]);
                        }
                    });
                    t.maskPt = best.j + 1;
                    v._mmChanged(t);
                }
                return {};
            }
            if (e.button === 0 && !D.pointInPolygon(poly, px, py)) {
                t.maskSel = null;
                t.maskPt = null;
                t.drawing = [];
                return place();
            }
            return {};
        }
        if (e.button !== 0) return false;
        t.drawing = [];
        t.maskPt = null;
        return place();
    }

    return {
        el: host,
        get ui() { return st._mmUI || null; },
        ensure,
        draw,
        fit: fitView,
        /** Whether this plate's stage took the key (the viewer's mmKeyDown asks each plate in turn). */
        keyTarget(e) {
            const ui = st._mmUI;
            if (!ui || !st._mmFocused || !ui.root.isConnected) return false;
            const path = e.composedPath ? e.composedPath() : [];
            return path.includes(ui.stage);
        },
        wake() { ensure(); draw(); },
        save() {
            const t = tab();
            const view = t ? viewOfTab(t) : st.view;
            return { view: view ? { zoom: view.zoom, x: view.x, y: view.y } : null };
        },
        dispose() {
            const ui = st._mmUI;
            if (ui && ui.raf) {
                const win = ui.root.ownerDocument.defaultView || window;
                try { win.cancelAnimationFrame(ui.raf); } catch (_) { /* gone */ }
                ui.raf = 0;
            }
            if (watch) { try { watch.disconnect(); } catch (_) { /* gone */ } watch = null; }
            if (offDrag) { offDrag(); offDrag = null; }
        },
    };
}
