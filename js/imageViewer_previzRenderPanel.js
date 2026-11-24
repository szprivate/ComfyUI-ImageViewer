// imageViewer_previzRenderPanel.js
// The 3D space's Render panel (Sebastian 2026-11-24): the render settings (the old Render dialog, merged in -
// previzRender's _renderFormBuild), a Render button that draws ONE frame through the render camera into the panel
// as four passes - Beauty, Depth (near = white), Normals (the camera's space) and Mask (white where something is) -
// and an AI workflow run over those passes, its result shown in the panel beside the raw render (pass switch, Wipe).
//
// The workflow is taken as Comp's AI Workflow node takes one (imageViewer_compAiWorkflow.js compAiTakeWorkflow:
// the open canvas, a workflow saved in ComfyUI, a .json file) or from the prepared list (Paint's edit and upscale
// built-ins); loaders titled comp:beauty / comp:depth / comp:normals / comp:mask take those passes (an untitled one
// the beauty), comp: titled nodes are the parameters, the first save (or comp:out) is the result, further saves are
// shown too. Each Render panel keeps a workflow of its own, on the scene (`scene.renderAi[panel id]` = {custom,
// values, last}), so it travels with the scene and two panels can show two looks of one frame.
//
// The server fills the workflow in (POST /imageviewer/render3d_ai, render3d_ai.py), the page queues it as Paint's
// Generate does (_paintQueue, with the sign-in) and waits for its outputs (_cpAiWaitNodes). One `this` with the panel.
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import { notice } from "./imageViewer_exportUI.js";
import { asPrompt } from "./imageViewer_compAiWorkflow.js";
import { showInstallLog } from "./imageViewer_installLog.js";

export const RENDER_PASSES = [["beauty", "Beauty"], ["depth", "Depth"], ["normals", "Normals"], ["mask", "Mask"]];
/** The prepared list: Paint's built-ins for these actions (they take one picture and a prompt). */
const PREPARED_ACTIONS = ["edit", "upscale"];

const STYLE = `
.r3-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.r3-bar { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-bottom: 1px solid #333; flex: none; flex-wrap: wrap; }
.r3-btn { background: #2d2d2d; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; min-height: 22px; white-space: nowrap; }
.r3-btn:hover:not(:disabled) { border-color: #777; }
.r3-btn:disabled { opacity: 0.45; cursor: default; }
.r3-btn.primary { background: #ff6600; border-color: #ff6600; color: #fff; }
.r3-btn.on { background: rgba(255, 102, 0, 0.22); border-color: #ff6600; color: #fff; }
.r3-passes { display: flex; gap: 2px; flex-wrap: wrap; }
.r3-sep { width: 1px; height: 16px; background: #3a3a3a; margin: 0 3px; }
.r3-info { margin-left: auto; color: #999; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.r3-info.stale { color: #e9b44c; }
.r3-stage { position: relative; flex: 1 1 auto; min-height: 120px; overflow: hidden; background: #111; }
.r3-stage img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
.r3-stage .r3-wipe-line { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #ff6600; cursor: ew-resize; display: none; }
.r3-stage.wipe .r3-wipe-line { display: block; }
.r3-stage .r3-tag { position: absolute; top: 6px; padding: 1px 6px; background: rgba(0,0,0,0.6); color: #ddd; font-size: 11px; border-radius: 3px; display: none; }
.r3-stage.wipe .r3-tag { display: block; }
.r3-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #888; text-align: center; padding: 12px; font-size: 12px; }
.r3-busy { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 8px; background: rgba(0,0,0,0.7); color: #ddd; font-size: 11px; display: none; }
.r3-busy.on { display: block; }
.r3-scroll { flex: 0 1 auto; max-height: 55%; overflow: auto; border-top: 1px solid #333; }
.r3-fold { border-bottom: 1px solid #2a2a2a; }
.r3-fold > summary { cursor: pointer; padding: 4px 8px; color: #ccc; font-size: 12px; user-select: none; }
.r3-fold > .r3-body { padding: 4px 8px 8px; }
.r3-row { display: flex; align-items: center; gap: 6px; min-height: 24px; flex-wrap: wrap; margin: 2px 0; }
.r3-label { flex: 0 0 72px; color: #aaa; text-align: right; font-size: 12px; }
.r3-wfname { color: #eee; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.r3-hint { color: #888; font-size: 11px; }
.r3-error { color: #ff7b72; font-size: 11px; white-space: pre-wrap; }
.r3-param { flex: 1 1 140px; min-width: 0; }
textarea.r3-param { min-height: 48px; resize: vertical; font: inherit; font-size: 12px; }
.r3-ask { border: 1px solid #ff6600; border-radius: 4px; padding: 6px 8px; margin: 6px 0; white-space: pre-wrap; font-size: 12px; }
.r3-form .rd-label { flex-basis: 72px; }
`;

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

/** Depth (planar, 0 = nothing) as a near = white picture, scaled over the 1st..99th percentile of what is there. */
export function depthToGrey(depth) {
    const { w, h, data } = depth;
    const vals = [];
    const step = Math.max(1, Math.floor(data.length / 50000));
    for (let i = 0; i < data.length; i += step) if (data[i] > 0) vals.push(data[i]);
    vals.sort((a, b) => a - b);
    const lo = vals.length ? vals[Math.floor(vals.length * 0.01)] : 0;
    const hi = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))] : 1;
    const span = Math.max(1e-9, hi - lo);
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const z = data[i];
        const g = z > 0 ? Math.round(255 * (0.1 + 0.9 * (1 - Math.min(1, Math.max(0, (z - lo) / span))))) : 0;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g;
        px[i * 4 + 3] = 255;
    }
    return { w, h, px };
}

function pixelsToUrl(doc, { w, h, px }) {
    const c = doc.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
    return c.toDataURL("image/png");
}

/** A PNG data URL's alpha as a grey picture (white = covered). */
function alphaToGrey(doc, url) {
    return new Promise((resolve, reject) => {
        const img = new (doc.defaultView || window).Image();
        img.onload = () => {
            const c = doc.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height);
            const p = d.data;
            for (let i = 0; i < p.length; i += 4) { const a = p[i + 3]; p[i] = p[i + 1] = p[i + 2] = a; p[i + 3] = 255; }
            ctx.putImageData(d, 0, 0);
            resolve(c.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("the mask pass could not be read"));
        img.src = url;
    });
}

const viewUrl = (ref) => api.apiURL(`/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder || "")}`
    + `&type=${encodeURIComponent(ref.type || "output")}`);
const shown = (ref) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(ref && ref.filename || "");

async function post(route, body) {
    const res = await api.fetchApi(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
}

/**
 * One Render panel in `host`. `st` is its state ({} for an instance; the first panel's lives on the viewer as
 * `_r3St`); `saved` what an instance kept ({pass, wipe, wipeX, folds}).
 */
export function createRenderPanelInstance(v, host, st, saved, id) {
    Object.assign(st, { id, pass: "beauty", wipe: false, wipeX: 0.5, passes: null, frame: null, camera: null,
                        ai: null, busy: null, error: "", folds: { ai: true, settings: false } }, saved ? {
        pass: saved.pass || "beauty", wipe: !!saved.wipe, wipeX: Number.isFinite(saved.wipeX) ? saved.wipeX : 0.5,
        folds: { ai: true, settings: false, ...(saved.folds || {}) } } : {});
    const doc = () => host.ownerDocument;
    let ui = null;

    const scene = () => v.previzScene && v.previzScene();
    const keep = () => {
        const sc = scene();
        if (!sc) return null;
        if (!sc.renderAi || typeof sc.renderAi !== "object") sc.renderAi = {};
        return sc.renderAi[id] || (sc.renderAi[id] = {});
    };
    const mine = () => { const sc = scene(); return (sc && sc.renderAi && sc.renderAi[id]) || {}; };
    const persist = () => { if (v.previzPersist) v.previzPersist(); };

    function build() {
        host.querySelectorAll(":scope > .r3-panel, :scope > style[data-r3]").forEach((n) => n.remove());
        const d = doc();
        const style = el(d, "style"); style.dataset.r3 = "1"; style.textContent = STYLE;
        const root = el(d, "div", "r3-panel");
        const bar = el(d, "div", "r3-bar");
        const render = el(d, "button", "r3-btn primary r3-render", "Render");
        render.title = "Render this frame through the render camera into the panel (beauty, depth, normals, mask)";
        render.onclick = () => (v._previzRendering && st.busy && st.busy.kind === "render" ? (v._previzRenderStop = true) : v.previzRenderStill(st));
        const passes = el(d, "div", "r3-passes");
        const wipe = el(d, "button", "r3-btn r3-wipe-btn", "Wipe");
        wipe.title = "Compare the AI result with the beauty: drag the line";
        wipe.onclick = () => { st.wipe = !st.wipe; if (st.wipe && st.ai) st.pass = "ai"; draw(); };
        const info = el(d, "span", "r3-info");
        bar.append(render, el(d, "span", "r3-sep"), passes, wipe, info);

        const stage = el(d, "div", "r3-stage");
        stage.tabIndex = -1;
        const imgA = el(d, "img", "r3-a"); imgA.alt = "";
        const imgB = el(d, "img", "r3-b"); imgB.alt = "";
        const line = el(d, "div", "r3-wipe-line");
        const tagL = el(d, "span", "r3-tag", "AI"); tagL.style.left = "6px";
        const tagR = el(d, "span", "r3-tag", "Beauty"); tagR.style.right = "6px";
        const empty = el(d, "div", "r3-empty", "Press Render to draw this frame through the render camera.");
        const busy = el(d, "div", "r3-busy");
        stage.append(imgA, imgB, line, tagL, tagR, empty, busy);
        const moveWipe = (e) => {
            const r = stage.getBoundingClientRect();
            if (!r.width) return;
            st.wipeX = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            placeWipe();
        };
        stage.addEventListener("pointerdown", (e) => {
            if (!st.wipe || e.button !== 0) return;
            e.preventDefault();
            moveWipe(e);
            const up = () => { stage.removeEventListener("pointermove", moveWipe); stage.removeEventListener("pointerup", up); };
            stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
            stage.addEventListener("pointermove", moveWipe);
            stage.addEventListener("pointerup", up);
        });

        const scroll = el(d, "div", "r3-scroll");
        const fold = (key, title) => {
            const f = el(d, "details", `r3-fold r3-fold-${key}`);
            f.open = !!st.folds[key];
            f.addEventListener("toggle", () => { st.folds[key] = f.open; });
            const sum = el(d, "summary", "", title);
            const body = el(d, "div", "r3-body");
            f.append(sum, body);
            scroll.append(f);
            return { f, body, sum };
        };
        const aiFold = fold("ai", "AI workflow");
        const setFold = fold("settings", "Render settings");
        root.append(bar, stage, scroll);
        host.append(style, root);
        ui = { root, bar, render, passes, wipe, info, stage, imgA, imgB, line, tagL, tagR, empty, busy, aiFold, setFold,
               form: null, formScene: null, aiSig: null };
        buildForm();
        buildAi();
        draw();
        return ui;
    }

    function buildForm() {
        const sc = scene();
        if (!ui || !sc || ui.formScene === sc) return;
        ui.setFold.body.textContent = "";
        ui.form = v._renderFormBuild(ui.setFold.body, { onChange: () => draw() });
        ui.form.root.classList.add("r3-form");
        ui.formScene = sc;
    }

    // ── the AI workflow ──────────────────────────────────────────────────────

    function aiSig() {
        const k = mine();
        const c = k.custom;
        return JSON.stringify([c ? [c.sig, c.name, c.source, c.path] : null, !!st.run, st.askDl ? 1 : 0, st.error]);
    }

    function buildAi() {
        if (!ui) return;
        const sig = aiSig();
        if (ui.aiSig === sig) return;
        ui.aiSig = sig;
        const d = doc();
        const body = ui.aiFold.body;
        body.textContent = "";
        const k = mine();
        const c = k.custom;
        const head = el(d, "div", "r3-row");
        const pick = el(d, "button", "r3-btn r3-wf-pick", c ? "Change ▾" : "Choose workflow ▾");
        pick.title = "The open canvas, a workflow saved in ComfyUI, a .json file, or a prepared one";
        pick.onclick = () => v._r3PickMenu(st, pick);
        head.append(el(d, "span", "r3-label", "Workflow"));
        if (c) {
            const name = el(d, "span", "r3-wfname", c.name || "My workflow");
            name.title = `${c.name || ""} (${c.source === "canvas" ? "from the canvas" : c.source === "saved" ? `saved: ${c.path}` : c.source === "prepared" ? "prepared" : `file: ${c.path || ""}`})`;
            head.append(name);
        }
        head.append(pick);
        if (c && c.source !== "prepared") {
            const again = el(d, "button", "r3-btn r3-wf-reload", "Reload");
            again.title = "Take the workflow again from where it came";
            again.onclick = () => v._r3Take(st, c.source === "canvas" ? { how: "canvas" } : c.source === "saved" ? { how: "saved", path: c.path } : { how: "file" });
            head.append(again);
        }
        if (c) {
            const off = el(d, "button", "r3-btn r3-wf-clear", "✕");
            off.title = "Take the workflow off this panel";
            off.onclick = () => { const kk = keep(); if (kk) { delete kk.custom; delete kk.values; delete kk.last; } st.ai = null; if (st.pass.startsWith("ai")) st.pass = "beauty"; st.wipe = false; persist(); ui.aiSig = null; buildAi(); draw(); };
            head.append(off);
        }
        body.append(head);
        if (!c) {
            body.append(el(d, "div", "r3-hint", "A workflow's LoadImage nodes titled comp:beauty, comp:depth, comp:normals or comp:mask take those passes "
                + "(an untitled one takes the beauty); nodes titled comp:<name> become its settings here; its first save is the result."));
        } else {
            const takes = [...new Set((c.inputs || []).map((x) => v._r3PassOf(x)))];
            body.append(Object.assign(el(d, "div", "r3-hint r3-takes"),
                { textContent: `Takes: ${takes.length ? takes.join(", ") : "nothing (it runs on its own)"} · gives: ${(c.outputs || []).map((o) => o.name).join(", ")}` }));
            const vals = k.values || {};
            for (const p of c.params || []) {
                const r = el(d, "div", "r3-row");
                r.append(el(d, "span", "r3-label", p.name));
                let inp;
                const cur = vals[p.id] !== undefined ? vals[p.id] : p.def;
                if (p.kind === "prompt" || (typeof p.def === "string" && p.def.length > 40)) {
                    inp = el(d, "textarea", "rd-in r3-param");
                    inp.value = String(cur ?? "");
                } else if (p.kind === "bool") {
                    inp = el(d, "input", "r3-param-bool"); inp.type = "checkbox"; inp.checked = !!cur;
                } else if (p.kind === "int" || p.kind === "num") {
                    inp = el(d, "input", "rd-in rd-num r3-param"); inp.type = "number";
                    inp.step = p.kind === "int" ? "1" : "any"; inp.value = String(cur ?? "");
                } else {
                    inp = el(d, "input", "rd-in r3-param"); inp.value = String(cur ?? "");
                }
                inp.dataset.param = p.id;
                inp.addEventListener("keydown", (e) => e.stopPropagation());
                inp.addEventListener("change", () => {
                    const kk = keep();
                    if (!kk) return;
                    kk.values = kk.values || {};
                    kk.values[p.id] = p.kind === "bool" ? inp.checked : (p.kind === "int" || p.kind === "num") ? Number(inp.value) : inp.value;
                    persist();
                });
                r.append(inp);
                body.append(r);
            }
        }
        if (st.askDl) {
            const a = el(d, "div", "r3-ask", st.askDl.text);
            const row = el(d, "div", "r3-row");
            const yes = el(d, "button", "r3-btn primary r3-dl-yes", "Download");
            const no = el(d, "button", "r3-btn r3-dl-no", "Not now");
            yes.onclick = () => st.askDl.answer(true);
            no.onclick = () => st.askDl.answer(false);
            row.append(yes, no);
            a.append(row);
            body.append(a);
        }
        const go = el(d, "div", "r3-row");
        const run = el(d, "button", "r3-btn primary r3-run", st.run ? "Stop" : "Run");
        run.title = "Render this frame (when it is not rendered yet) and run the workflow on it";
        run.disabled = !c && !st.run;
        run.onclick = () => (st.run ? v._r3Stop(st) : v.previzRenderAi(st));
        go.append(el(d, "span", "r3-label", ""), run);
        body.append(go);
        if (st.error) body.append(el(d, "div", "r3-error", st.error));
    }

    // ── drawing ──────────────────────────────────────────────────────────────

    function passList() {
        const out = RENDER_PASSES.map(([k, label]) => [k, label]);
        if (st.ai) {
            out.push(["ai", "AI"]);
            for (const name of Object.keys(st.ai.more || {})) out.push([`ai:${name}`, `AI ${name}`]);
        }
        return out;
    }

    function urlOf(pass) {
        if (pass === "ai") return st.ai && st.ai.url;
        if (pass.startsWith("ai:")) return st.ai && st.ai.more && st.ai.more[pass.slice(3)];
        return st.passes && st.passes[pass + "Show"] || (st.passes && st.passes[pass]);
    }

    function placeWipe() {
        if (!ui) return;
        const pct = `${(st.wipeX * 100).toFixed(2)}%`;
        ui.line.style.left = pct;
        ui.imgB.style.clipPath = st.wipe ? `inset(0 ${(100 - st.wipeX * 100).toFixed(2)}% 0 0)` : "";
    }

    function draw() {
        if (!ui || !ui.root.isConnected) return;
        buildForm();
        buildAi();
        const d = doc();
        const list = passList();
        if (!list.some(([k]) => k === st.pass)) st.pass = "beauty";
        if (!st.ai) st.wipe = false;
        const sig = JSON.stringify(list.map(([k]) => k)) + st.pass;
        if (ui.passSig !== sig) {
            ui.passSig = sig;
            ui.passes.textContent = "";
            for (const [k, label] of list) {
                const b = el(d, "button", "r3-btn r3-pass" + (k === st.pass && !st.wipe ? " on" : ""), label);
                b.dataset.pass = k;
                b.onclick = () => { st.pass = k; st.wipe = false; draw(); };
                ui.passes.append(b);
            }
        }
        for (const b of ui.passes.children) {
            b.classList.toggle("on", b.dataset.pass === st.pass && !st.wipe);
            b.disabled = b.dataset.pass.startsWith("ai") ? !urlOf(b.dataset.pass) : !st.passes;
        }
        ui.wipe.disabled = !st.ai || !st.passes;
        ui.wipe.classList.toggle("on", st.wipe);
        ui.wipe.style.display = st.ai ? "" : "none";
        ui.stage.classList.toggle("wipe", st.wipe);
        const setSrc = (img, url) => { if (url) { if (img.getAttribute("src") !== url) img.src = url; img.style.display = ""; } else { img.removeAttribute("src"); img.style.display = "none"; } };
        if (st.wipe) {
            setSrc(ui.imgA, urlOf("beauty"));
            setSrc(ui.imgB, urlOf("ai"));
        } else {
            setSrc(ui.imgA, urlOf(st.pass));
            setSrc(ui.imgB, null);
        }
        placeWipe();
        ui.empty.style.display = urlOf(st.wipe ? "beauty" : st.pass) ? "none" : "";
        const b = st.busy;
        ui.busy.classList.toggle("on", !!b);
        ui.busy.textContent = b ? b.text : "";
        ui.render.textContent = b && b.kind === "render" ? "Stop" : "Render";
        ui.render.disabled = !!(st.run && !(b && b.kind === "render")) || !!(v._previzRendering && !(b && b.kind === "render"));
        // What the picture is, and whether the playhead has moved on since.
        const f = Math.round(v.currentFrame || 0);
        const stale = st.frame !== null && st.frame !== f;
        ui.info.classList.toggle("stale", stale);
        ui.info.textContent = st.frame === null ? "" : `${st.size ? `${st.size.w}×${st.size.h} · ` : ""}frame ${st.frame}${stale ? ` (now ${f})` : ""}`;
        ui.info.title = stale ? "The playhead has moved since this render: press Render again" : "";
    }

    function refresh() {
        if (!ui || !ui.root.isConnected || ui.root.ownerDocument !== host.ownerDocument) build();
        else {
            if (ui.form && ui.form.refresh) ui.form.refresh();
            draw();
        }
    }

    // The last result this panel had, from the scene (its pictures are files in ComfyUI's output).
    function restoreLast() {
        const last = mine().last;
        if (!st.ai && last && last.main) {
            st.ai = { url: viewUrl(last.main), more: {}, frame: last.frame };
            for (const [n, ref] of Object.entries(last.more || {})) st.ai.more[n] = viewUrl(ref);
        }
    }
    restoreLast();

    st.draw = draw;
    st.keep = keep;
    st.mine = mine;
    st.persist = persist;
    st.panel = () => ui;
    st.rebuildAi = () => { if (ui) { ui.aiSig = null; buildAi(); } };
    build();
    return {
        el: host,
        refresh,
        build,
        wake: () => refresh(),
        save: () => ({ pass: st.pass, wipe: st.wipe, wipeX: st.wipeX, folds: { ...st.folds } }),
        dispose: () => { if (st.run) v._r3Stop(st); },
        st,
    };
}

export const PrevizRenderPanelMixin = {

    // ── the panels ───────────────────────────────────────────────────────────

    _r3RegisterMaker() {
        if (!this._dockMakers || this._dockMakers().render3d) return;
        this._dockMakers().render3d = (v, id, saved) => {
            const doc = (v._dockRootEl && v._dockRootEl.ownerDocument) || (v.render3dPanel && v.render3dPanel.ownerDocument);
            if (!doc) return null;
            const host = doc.createElement("div");
            host.className = "previz-panel render3d-panel";
            host.dataset.panel = id;
            return createRenderPanelInstance(v, host, {}, saved, id);
        };
    },

    /** The first Render panel: the markup's, its state on the viewer (this._r3St). */
    _r3Primary() {
        this._r3RegisterMaker();
        const host = this.render3dPanel;
        if (!host) return null;
        if (!this._r3Inst || this._r3Inst.el !== host) {
            this._r3St = {};
            this._r3Inst = createRenderPanelInstance(this, host, this._r3St, null, "render3d");
        }
        return this._r3Inst;
    },

    /** Every Render panel up: the first one when docked, and the instances in front. */
    _r3All() {
        const out = [];
        if (this.isPanelDocked && this.isPanelDocked("render3d") && this.isPrevizTab && this.isPrevizTab()) {
            const p = this._r3Primary();
            if (p) out.push(p);
        }
        const found = this._dockInstancesOf ? this._dockInstancesOf("render3d") : [];
        for (const { inst } of found) if (inst !== this._r3Inst) out.push(inst);
        return out;
    },

    /** Draw the Render panels (cheap: the playhead's frame and the camera list). */
    _r3Refresh() {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        this._r3RegisterMaker();
        for (const inst of this._r3All()) { try { inst.refresh(); } catch (e) { console.warn("[ImageViewer] Render panel", e); } }
    },

    /** Render… and the Windows menu: the panel up and in front; `settings` unfolds the render settings. */
    previzRenderPanelOpen({ settings = false } = {}) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return null;
        this.setPanelDocked("render3d", true);
        if (this.dockTabFront) this.dockTabFront("render3d");
        const inst = this._r3Primary();
        if (!inst) return null;
        if (settings) {
            inst.st.folds.settings = true;
            const ui = inst.st.panel();
            if (ui) { ui.setFold.f.open = true; ui.setFold.f.scrollIntoView && ui.setFold.f.scrollIntoView({ block: "nearest" }); }
        }
        inst.refresh();
        return inst;
    },

    /** The panels go with the 3D tab and come back with the next one (as the Matchmove panels do). */
    _r3Hide() {
        if (this.isPanelDocked && this.isPanelDocked("render3d")) { this._r3Want = true; this.setPanelDocked("render3d", false); }
    },

    _r3Restore() {
        if (this._r3Want) { this._r3Want = false; this.setPanelDocked("render3d", true); }
    },

    /** The pass a workflow input takes: as render3d_ai.pass_for on the server (its name, else its kind). */
    _r3PassOf(x) {
        const n = String((x && x.name) || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
        const names = {
            depth: ["depth", "z", "zdepth", "z_depth", "depth_z", "depthmap", "depth_map"],
            normals: ["normal", "normals", "n", "normalmap", "normal_map", "nrm"],
            mask: ["mask", "alpha", "matte", "a", "holdout"],
            beauty: ["beauty", "render", "rgb", "color", "colour", "src", "image", "plate", "rgba"],
        };
        for (const [p, list] of Object.entries(names)) if (list.includes(n)) return p;
        for (const p of ["depth", "normals", "mask"]) if (names[p].some((a) => a.length > 2 && n.startsWith(a))) return p;
        return x && x.kind === "mask" ? "mask" : "beauty";
    },

    // ── one frame, four passes ───────────────────────────────────────────────

    /**
     * Render the current frame through the render camera into panel `st`: beauty (raster or path traced, as the
     * settings say), depth, normals and mask. Answers whether it drew.
     */
    async previzRenderStill(st) {
        const scene = this.previzScene();
        const view = this._modelView && this._modelView();
        if (!scene || !view || this._previzRendering) return false;
        const s = S.renderSettings(scene);
        const camera = this._renderCameraId(s, scene);
        const { w, h } = this._renderSize(s, scene);
        const f = Math.round(this.currentFrame || 0);
        const traced = s.renderer === "pathtraced";
        const doc = this.container.ownerDocument;
        this._previzRendering = true;
        this._previzRenderStop = false;
        st.busy = { kind: "render", text: `Rendering frame ${f}…` };
        st.error = "";
        st.draw && st.draw();
        const out = {};
        let ok = false;
        try {
            const begin = (o) => {
                if (!view.beginRender({ camera, grid: s.grid, helpers: s.helpers, ...o }))
                    throw new Error("the 3D view is not ready");
            };
            begin({ shading: traced ? "original" : s.shading, background: s.background, color: s.color, aa: traced ? 1 : s.aa });
            if (view.prepareVideoPlanes) { view.applyFrame(f); await view.prepareVideoPlanes(f); }
            out.beauty = traced
                ? await view.renderFramePathTraced(f, w, h, {
                    samples: s.samples, bounces: s.bounces, shouldStop: () => this._previzRenderStop,
                    onSample: (n, want) => { st.busy.text = `Path tracing frame ${f}: sample ${n} of ${want}`; st.draw && st.draw(); },
                })
                : view.renderFrame(f, w, h);
            if (this._previzRenderStop) throw Object.assign(new Error("stopped"), { stopped: true });
            if (!out.beauty) throw new Error(traced ? "the path tracer produced no image" : "the renderer produced no image");
            const depth = view.renderDepth ? view.renderDepth(w, h) : null;
            view.endRender();
            out.depth = depth ? pixelsToUrl(doc, depthToGrey(depth)) : null;
            // The normals: the camera's space, a flat blue where nothing is (what a normal map has there).
            begin({ shading: "normal", background: "color", color: "#8080ff", aa: s.aa, grid: false, helpers: false });
            out.normals = view.renderFrame(f, w, h);
            view.endRender();
            // The mask: what covers the frame, from a transparent render's alpha.
            begin({ shading: "clay", background: "transparent", aa: s.aa, grid: false, helpers: false });
            const cover = view.renderFrame(f, w, h);
            view.endRender();
            out.mask = cover ? await alphaToGrey(doc, cover) : null;
            if (!out.depth) out.depth = out.mask;      // no float targets: at least where something is
            st.passes = out;
            st.frame = f;
            st.camera = camera;
            st.size = { w, h };
            if (!st.pass || (!st.pass.startsWith("ai"))) st.pass = st.pass || "beauty";
            ok = true;
        } catch (e) {
            if (!e.stopped) {
                st.error = `Render: ${(e && e.message) || e}`;
                console.warn("[ImageViewer] Render panel", e);
            }
        } finally {
            if (view._rendering) view.endRender();
            this._previzRendering = false;
            this._previzRenderStop = false;
            st.busy = null;
            if (st.rebuildAi) st.rebuildAi();
            st.draw && st.draw();
        }
        return ok;
    },

    // ── the workflow ─────────────────────────────────────────────────────────

    /** The menu of ways to take a workflow, beside `anchor`. */
    async _r3PickMenu(st, anchor) {
        const r = anchor.getBoundingClientRect();
        const [saved, prepared] = await Promise.all([
            this._cpWfSaved ? this._cpWfSaved() : [],
            this._r3Prepared().catch(() => []),
        ]);
        const entries = [
            { label: "From the canvas", run: () => this._r3Take(st, { how: "canvas" }) },
            { label: "Saved workflow", sub: saved.length ? saved.slice(0, 60).map((p) => ({ label: p.replace(/\.json$/i, ""), run: () => this._r3Take(st, { how: "saved", path: p }) }))
                : [{ label: "No saved workflows", disabled: true }] },
            { label: "From a file…", run: () => this._r3Take(st, { how: "file" }) },
            "-",
        ];
        const row = (it) => ({
            label: it.label + (it.api ? " (API)" : it.missing && it.missing.some((m) => m.kind !== "node") ? " (download)" : ""),
            title: it.missing && it.missing.length ? `Needs: ${it.missing.map((m) => m.what).join(", ")}` : (it.about || ""),
            run: () => this._r3TakePrepared(st, it),
        });
        const real = prepared.filter((it) => it.group === "render"), other = prepared.filter((it) => it.group !== "render");
        entries.push({ head: "Realistic render" },
            ...(real.length ? real.map(row) : [{ label: "None installed in this ComfyUI", disabled: true }]));
        if (other.length) entries.push({ head: "Edit the picture" }, ...other.map(row));
        this._previzOpenMenu(entries, r.left, r.bottom + 2, anchor);
    },

    /** The prepared workflows this ComfyUI has: the realistic-render list, then Paint's built-ins that edit or upscale one picture. */
    async _r3Prepared() {
        const seen = new Set(), out = [];
        // The realistic-render list first (the comp table's "render3d" list: depth ControlNet, image edit, API).
        try {
            const r = await api.fetchApi("/imageviewer/comp_ai_workflows", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "render3d" }) });
            if (r.ok) {
                const t = await r.json();
                for (const w of t.workflows || []) { seen.add(w.id); out.push({ ...w, action: "render", group: "render" }); }
            }
        } catch (_e) { /* the list is optional */ }
        const res = await api.fetchApi("/imageviewer/paint/workflows");
        if (!res.ok) return out;
        const t = await res.json();
        for (const a of PREPARED_ACTIONS) {
            for (const w of (t.actions && t.actions[a] && t.actions[a].workflows) || []) {
                if (seen.has(w.id)) continue;
                seen.add(w.id);
                out.push({ ...w, action: a });
            }
        }
        return out;
    },

    /** Keep a workflow taken (`custom`, as Comp's make_custom answers) on panel `st`. */
    _r3Keep(st, custom) {
        const k = st.keep();
        if (!k) return;
        const before = k.custom;
        k.custom = custom;
        // The values typed stay where the same parameter is still there.
        if (k.values && before) {
            const ids = new Set((custom.params || []).map((p) => p.id));
            for (const id of Object.keys(k.values)) if (!ids.has(id)) delete k.values[id];
        }
        st.error = "";
        st.persist();
        if (st.rebuildAi) st.rebuildAi();
        st.draw && st.draw();
    },

    async _r3Take(st, how) {
        const custom = this.compAiTakeWorkflow ? await this.compAiTakeWorkflow(how) : null;
        if (!custom) return;
        if (custom.error) { st.error = custom.error; if (st.rebuildAi) st.rebuildAi(); return; }
        this._r3Keep(st, custom);
    },

    async _r3TakePrepared(st, item) {
        try {
            const res = await api.fetchApi(`/imageviewer/paint/workflow?id=${encodeURIComponent(item.id)}`);
            if (!res.ok) throw new Error(`the workflow ${item.label} is not here (HTTP ${res.status})`);
            const file = await res.json();
            const graph = await asPrompt(file.workflow);
            const { custom } = await post("/imageviewer/comp_ai_inspect", { graph, name: item.label, source: "file", path: item.id });
            custom.source = "prepared";
            custom.path = item.id;
            this._r3Keep(st, custom);
        } catch (e) {
            st.error = String((e && e.message) || e);
            if (st.rebuildAi) st.rebuildAi();
        }
    },

    /** Ask in the panel (no dialog over the viewer): resolves true / false. */
    _r3Ask(st, text) {
        return new Promise((resolve) => {
            st.askDl = { text, answer: (yes) => { st.askDl = null; if (st.rebuildAi) st.rebuildAi(); resolve(yes); } };
            if (st.rebuildAi) st.rebuildAi();
        });
    },

    /** A prepared workflow's model files, asked for and fetched (Paint's routes). False when not now. */
    async _r3ModelsReady(st, id, label, run) {
        const mb = (n) => (n ? (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`) : "size not known");
        const plan = await post("/imageviewer/paint/models", { workflow: id });
        const files = (plan.files || []).filter((f) => f.url);
        if (!files.length) return false;
        const list = files.map((f) => `• ${f.name} (${mb(f.size)}) into models/${f.folder}`).join("\n");
        if (!(await this._r3Ask(st, `${label} needs model files that are not on this machine:\n${list}\nTogether ${mb(plan.total)}, from Hugging Face.`))) return false;
        const { job } = await post("/imageviewer/paint/download", { workflow: id });
        showInstallLog(job, { host: this.container });
        run.stop = () => { post("/imageviewer/paint/download", { job, cancel: true }).catch(() => {}); };
        let s;
        try {
            for (;;) {
                await new Promise((r) => setTimeout(r, 1000));
                s = await post("/imageviewer/paint/download", { job });
                const done = s.files.reduce((t, f) => t + (f.done || 0), 0), total = s.files.reduce((t, f) => t + (f.size || 0), 0);
                st.busy = { kind: "ai", text: `Downloading the models · ${mb(done)} of ${mb(total)}` };
                st.draw && st.draw();
                if (s.state !== "running") break;
            }
        } finally { run.stop = null; }
        return s.state === "done";
    },

    _r3Stop(st) {
        const run = st.run;
        if (!run) return;
        run.stopped = true;
        if (run.stop) run.stop();
    },

    /**
     * Run panel `st`'s workflow on the frame: rendered first when the panel has no render of this frame, then
     * filled in by the server, queued, and its outputs shown (the first as "AI", the others beside it).
     */
    async previzRenderAi(st) {
        const k = st.mine();
        const c = k.custom;
        if (!c) { st.error = "Choose a workflow first."; if (st.rebuildAi) st.rebuildAi(); return null; }
        if (st.run) return null;
        const f = Math.round(this.currentFrame || 0);
        const sc = this.previzScene();
        if (!st.passes || st.frame !== f || st.camera !== this._renderCameraId(S.renderSettings(sc), sc)) {
            if (!(await this.previzRenderStill(st))) return null;
        }
        const run = st.run = { stopped: false, stop: null };
        st.error = "";
        if (st.rebuildAi) st.rebuildAi();
        const tell = (text) => { st.busy = { kind: "ai", text }; st.draw && st.draw(); };
        let answer = null;
        try {
            tell(`${c.name || "Workflow"}: preparing`);
            let prep;
            for (let tries = 0; ; tries++) {
                try {
                    prep = await post("/imageviewer/render3d_ai", { custom: c, values: k.values || {}, passes: st.passes, frame: st.frame });
                    break;
                } catch (e) {
                    const miss = e.data && e.data.missing;
                    if (e.status === 404 || e.status === 405) throw new Error("this ComfyUI does not know the route yet: restart ComfyUI after updating the viewer");
                    if (miss && miss.length && c.source === "prepared" && tries === 0 && miss.every((m) => m.kind !== "node")) {
                        if (await this._r3ModelsReady(st, c.path, c.name, run)) continue;
                    }
                    if (miss && miss.length) {
                        throw new Error("The workflow needs what is not here: " + miss.map((m) => (m.kind === "model" ? `${m.what} (${m.folder})` : `node ${m.what}`)).join(", ")
                            + " - install the node pack or put the model file into its ComfyUI folder");
                    }
                    throw e;
                }
            }
            if (run.stopped) throw Object.assign(new Error("stopped"), { stopped: true });
            tell(`${c.name || "Workflow"}: queued`);
            const pid = await this._paintQueue(prep.graph);
            const outs = Object.keys(prep.outputs || {});
            tell(`${c.name || "Workflow"}: running`);
            let images;
            try {
                images = await this._cpAiWaitNodes(pid, outs, run, (n) => tell(`${c.name || "Workflow"}: ${n} of ${outs.length} outputs in`));
            } catch (e) {
                if (e.images && Object.keys(e.images).length) images = e.images; else throw e;
            }
            const last = { frame: st.frame, main: null, more: {} };
            const ai = { url: null, more: {}, frame: st.frame };
            for (const [node, name] of Object.entries(prep.outputs)) {
                const ref = (images[node] || []).find(shown) || (images[node] || [])[0];
                if (!ref) continue;
                if (name === prep.main) { last.main = ref; ai.url = viewUrl(ref); } else { last.more[name] = ref; ai.more[name] = viewUrl(ref); }
            }
            if (!ai.url) {
                const first = Object.keys(ai.more)[0];
                if (!first) throw new Error("the workflow gave no pictures");
                ai.url = ai.more[first]; last.main = last.more[first];
                delete ai.more[first]; delete last.more[first];
            }
            if (last.main && !shown(last.main)) st.error = `${last.main.filename}: the browser cannot show this file type here`;
            st.ai = ai;
            st.pass = "ai";
            const kk = st.keep();
            if (kk) { kk.last = last; st.persist(); }
            answer = { ok: true, frame: st.frame, outputs: Object.keys(images).length, uses: prep.uses };
        } catch (e) {
            if (run.stopped || e.stopped || String(e.message) === "stopped") { st.error = "Stopped."; answer = { ok: false, stopped: true }; }
            else {
                st.error = String((e && e.message) || e);
                console.warn("[ImageViewer] Render panel AI", e);
                answer = { ok: false, error: st.error };
            }
        } finally {
            st.run = null;
            st.busy = null;
            if (st.rebuildAi) st.rebuildAi();
            st.draw && st.draw();
        }
        if (answer && answer.ok) notice("info", `${c.name || "The workflow"}: the result is in`, `Frame ${answer.frame}, in the Render panel.`);
        return answer;
    },
};
