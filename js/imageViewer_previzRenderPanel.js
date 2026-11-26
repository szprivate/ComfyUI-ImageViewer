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
// The bar (Sebastian 2026-11-24, second round): Render (the passes, then the workflow when AI is on), AI, IPR (the
// passes drawn again whenever the scene, the camera or the frame changes - at a preview size, the workflow not
// run), Region (a box drawn on the picture: only it is rendered - the camera's projection narrowed onto it, so
// the path tracer traces only the box - and only it goes through the workflow, the answer pasted back with a
// soft edge), the passes as one menu, Wipe. The prompt is a field under the picture, kept per panel on the
// scene (`renderAi[id].prompt`), and goes into the workflow's prompt (its "Positive prompt" node) whichever
// workflow is on; the agent reads and writes it (render_panel_* actions, imageViewer_previzAgentRender.js).
//
// The server fills the workflow in (POST /imageviewer/render3d_ai, render3d_ai.py), the page queues it as Paint's
// Generate does (_paintQueue, with the sign-in) and waits for its outputs (_cpAiWaitNodes). One `this` with the panel.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import * as S from "./imageViewer_scene3d.js";
import { notice, canvasContext, openFilePicker } from "./imageViewer_exportUI.js";
import { asPrompt } from "./imageViewer_compAiWorkflow.js";
import { floatDialog, wirePictureDrop } from "./imageViewer_atlasDrops.js";
import * as A from "./imageViewer_atlasRender.js";
import { showInstallLog } from "./imageViewer_installLog.js";

export const RENDER_PASSES = [["beauty", "Beauty"], ["depth", "Depth"], ["normals", "Normals"], ["mask", "Mask"]];
/** The prepared list: Paint's built-ins for these actions (they take one picture and a prompt). */
const PREPARED_ACTIONS = ["edit", "upscale"];
/** The main models shown at the top of the menu (Sebastian 2026-11-25: "the workflow list is super long");
 *  every other prepared workflow is under "More workflows". In this order, where this ComfyUI has them. */
export const MAIN_PREPARED = [
    "nano_banana_pro_edit", "nano_banana2_edit", "gpt_image_25_edit", "seedream5_edit",
    "flux2_klein_9b_edit", "qwen2511_lightning_edit", "flux_kontext_edit",
    "magnific_precise", "seedvr2_7b", "upscale_model",
];
/** Reference pictures a panel keeps (render3d_ai.MAX_REFS), sent at most this long on their longest side. */
export const MAX_REFS = 4;
const REF_SIDE = 2048;
/** What a prepared workflow's prompt calls its pictures, for the hint under the references. */
const REF_HINTS = {
    comp_r3_qwen2511: "In the prompt: image 1 is the render, image 2 its depth, image 3 the first reference (one is used).",
    comp_r3_gpt25: "In the prompt: image 1 is the render, image 2 its depth, images 3 and 4 the references.",
};

/** The reference loaders a workflow has (render3d_ai.ref_index): how many pictures it can take. */
export function refSlots(custom) {
    let n = 0;
    for (const x of (custom && custom.inputs) || []) {
        if (x.kind && x.kind !== "picture") continue;
        const m = String(x.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "").match(/^(.*?)_?(\d*)$/);
        if (!m || !["ref", "reference", "style", "refimage", "ref_image", "reference_image"].includes(m[1])) continue;
        const i = m[2] ? Number(m[2]) : 1;
        if (i >= 1 && i <= MAX_REFS) n = Math.max(n, i);
    }
    return n;
}

/** A kept reference ({path} | {filename, type, subfolder}, name) cleaned; null when it names no file. */
export function cleanRef(r) {
    if (!r || typeof r !== "object") return null;
    const ref = A.pictureRef(r);
    if (!ref) return null;
    const name = String(r.name || r.filename || String(r.path || "").split(/[\\/]/).pop() || "picture");
    return { ...ref, name };
}

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
select.r3-pass-select { background: #2d2d2d; color: #eee; border: 1px solid #444; border-radius: 4px; font-size: 11px; min-height: 22px; padding: 0 4px; }
.r3-prompt { display: flex; gap: 6px; align-items: flex-start; padding: 4px 6px; border-top: 1px solid #333; flex: none; }
.r3-prompt textarea { flex: 1 1 auto; min-width: 0; min-height: 34px; max-height: 120px; resize: vertical; font: inherit; font-size: 12px;
    background: #1c1c1c; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 3px 6px; }
.r3-prompt textarea:disabled { opacity: 0.5; }
.r3-prompt .r3-label { flex: none; padding-top: 4px; }
.r3-refs { display: flex; gap: 6px; align-items: center; padding: 2px 6px 4px; flex: none; flex-wrap: wrap; }
.r3-refs .r3-label { flex: none; }
.r3-refs.drop-on { outline: 1px dashed #ff6600; outline-offset: -2px; }
.r3-ref { position: relative; width: 44px; height: 44px; border: 1px solid #444; border-radius: 4px; overflow: hidden; background: #1c1c1c; flex: none; }
.r3-ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
.r3-ref .r3-ref-n { position: absolute; left: 2px; bottom: 1px; font-size: 9px; color: #fff; text-shadow: 0 0 2px #000; }
.r3-ref .r3-ref-x { position: absolute; right: 0; top: 0; width: 15px; height: 15px; padding: 0; border: none; border-radius: 0 0 0 4px;
    background: rgba(0,0,0,0.65); color: #eee; font-size: 10px; line-height: 15px; cursor: pointer; display: none; }
.r3-ref:hover .r3-ref-x { display: block; }
.r3-ref.unused { opacity: 0.4; }
.r3-refs .r3-hint { flex: 1 1 160px; min-width: 0; }
.r3-stack { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 6px; }
.r3-stack-row { display: flex; align-items: center; gap: 6px; padding: 2px 6px; border: 1px solid #3a3a3a; border-radius: 4px;
    background: #232323; color: #ccc; font-size: 12px; cursor: pointer; user-select: none; }
.r3-stack-row:hover { border-color: #666; }
.r3-stack-row.sel { border-color: #ff6600; background: rgba(255, 102, 0, 0.14); color: #fff; }
.r3-stack-row .r3-stack-n { color: #888; flex: none; }
.r3-stack-row .r3-stack-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r3-stack-add { align-self: flex-start; }
.r3-stage .r3-region { position: absolute; border: 1px dashed #ff6600; box-shadow: 0 0 0 9999px rgba(0,0,0,0.35); pointer-events: none; display: none; }
.r3-stage.region-on { cursor: crosshair; }
.r3-stage.region-on .r3-region.has { display: block; }
`;

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

/** Depth (planar, 0 = nothing) as a near = white picture, scaled over the 1st..99th percentile of what is there. */
export function depthToGrey(depth, range = null) {
    const { w, h, data } = depth;
    let lo, hi;
    if (range && Number.isFinite(range.lo) && Number.isFinite(range.hi)) ({ lo, hi } = range);      // a region: the frame's scale
    else {
        const vals = [];
        const step = Math.max(1, Math.floor(data.length / 50000));
        for (let i = 0; i < data.length; i += step) if (data[i] > 0) vals.push(data[i]);
        vals.sort((a, b) => a - b);
        lo = vals.length ? vals[Math.floor(vals.length * 0.01)] : 0;
        hi = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))] : 1;
    }
    const span = Math.max(1e-9, hi - lo);
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const z = data[i];
        const g = z > 0 ? Math.round(255 * (0.1 + 0.9 * (1 - Math.min(1, Math.max(0, (z - lo) / span))))) : 0;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g;
        px[i * 4 + 3] = 255;
    }
    return { w, h, px, range: { lo, hi } };
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

/** A region box [x0, y0, x1, y1] (shares of the picture, y down), or null. */
export function cleanBox(b) {
    if (!Array.isArray(b) || b.length !== 4) return null;
    const v = b.map(Number);
    if (!v.every(Number.isFinite)) return null;
    const c = (x) => Math.min(1, Math.max(0, x));
    const x0 = c(Math.min(v[0], v[2])), x1 = c(Math.max(v[0], v[2])), y0 = c(Math.min(v[1], v[3])), y1 = c(Math.max(v[1], v[3]));
    return x1 - x0 >= 0.01 && y1 - y0 >= 0.01 ? [x0, y0, x1, y1] : null;
}

/** A box in whole pixels of a w x h picture: {x, y, w, h}. */
export function boxPixels(box, w, h) {
    const x = Math.floor(box[0] * w), y = Math.floor(box[1] * h);
    return { x, y, w: Math.max(1, Math.ceil(box[2] * w) - x), h: Math.max(1, Math.ceil(box[3] * h) - y) };
}

/** The workflow's prompt parameter (what the panel's prompt field fills), or null. */
export function promptParam(custom) {
    return ((custom && custom.params) || []).find((p) => p.kind === "prompt") || null;
}

/** The values a run sends: the ones typed, with the panel's prompt in the workflow's prompt. */
export function runValues(keep, custom) {
    const out = { ...((keep && keep.values) || {}) };
    const p = promptParam(custom);
    const text = keep && typeof keep.prompt === "string" ? keep.prompt.trim() : "";
    if (p && text) out[p.id] = text;
    return out;
}

/**
 * The panel's stack of AI workflows (Sebastian 2026-11-25, as Blender's modifier stack): layer 1
 * runs on the render's passes, every next one on the picture the layer before it gave. The layer
 * selected in the list is mirrored in the panel's `custom` / `values`, so everything that reads
 * one workflow (the settings below the list, the agent, the references) keeps working as it did.
 * Answers the stack. `st.sel` is the selected layer's index (a panel's own, not saved).
 */
function stackSync(k, st) {
    if (!k) return [];
    if (!Array.isArray(k.stack)) k.stack = k.custom ? [{ custom: k.custom, values: k.values || {} }] : [];
    const i = Math.max(0, Math.min(st.sel || 0, k.stack.length));
    if (k.custom) k.stack[i] = { custom: k.custom, values: k.values || {} };
    st.sel = i;
    return k.stack;
}

/** Select layer `i` (the stack's length = a fresh, empty slot a picked workflow becomes). */
function stackSelect(k, st, i) {
    stackSync(k, st);
    const n = Math.max(0, Math.min(i, k.stack.length));
    const l = k.stack[n];
    st.sel = n;
    if (l) { k.custom = l.custom; k.values = l.values || {}; }
    else { delete k.custom; delete k.values; }
}

/** A picture the panel shows (a file URL or a data URL) as a PNG data URL, for the next layer's passes. */
async function asDataUrl(doc, url) {
    if (/^data:image\/png;/.test(url)) return url;
    const img = await loadImg(doc, url);
    const c = doc.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png");
}

const loadImg = (doc, url) => new Promise((resolve, reject) => {
    const img = new (doc.defaultView || window).Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("a picture could not be read"));
    img.src = url;
});

/** `url` cropped to pixel box `r` (a PNG data URL). */
async function cropUrl(doc, url, r) {
    const img = await loadImg(doc, url);
    const c = doc.createElement("canvas");
    c.width = r.w; c.height = r.h;
    c.getContext("2d").drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return c.toDataURL("image/png");
}

/** A region run's `under` chain, at most 8 deep (the oldest dropped). */
function trimChain(last, n = 0) {
    if (!last) return null;
    const out = { ...last };
    out.under = n >= 7 ? null : trimChain(last.under, n + 1);
    if (!out.under) delete out.under;
    return out;
}

/** The soft edge of a region's paste: 3 % of its shorter side, 2 to 24 pixels. */
export const featherOf = (r) => Math.max(2, Math.min(24, Math.round(Math.min(r.w, r.h) * 0.03)));

/**
 * `part` pasted into `base` at pixel box `r` (scaled to it), its edge faded over `feather` pixels (0 = hard),
 * as a PNG data URL of `size` ({w, h}: the render's; the base is scaled to it - a workflow's answer need not be
 * the render's size), else of the base's own size.
 */
async function pasteUrl(doc, base, part, r, feather = 0, size = null) {
    const [a, b] = await Promise.all([loadImg(doc, base), loadImg(doc, part)]);
    const c = doc.createElement("canvas");
    c.width = size ? size.w : a.naturalWidth; c.height = size ? size.h : a.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(a, 0, 0, c.width, c.height);
    const t = doc.createElement("canvas");
    t.width = r.w; t.height = r.h;
    const tc = t.getContext("2d");
    tc.imageSmoothingQuality = "high";
    tc.drawImage(b, 0, 0, r.w, r.h);
    const fe = Math.min(feather, Math.floor(r.w / 2), Math.floor(r.h / 2));
    if (fe > 0) {
        const d = tc.getImageData(0, 0, r.w, r.h), p = d.data;
        for (let y = 0; y < r.h; y++) {
            // A side on the picture's own edge is not faded: nothing is beyond it.
            const ey = Math.min(r.y > 0 ? y + 0.5 : Infinity, r.y + r.h < c.height ? r.h - y - 0.5 : Infinity);
            for (let x = 0; x < r.w; x++) {
                const e = Math.min(ey, r.x > 0 ? x + 0.5 : Infinity, r.x + r.w < c.width ? r.w - x - 0.5 : Infinity);
                if (e < fe) { const k = (y * r.w + x) * 4 + 3; p[k] = Math.round(p[k] * Math.max(0, e / fe)); }
            }
        }
        tc.putImageData(d, 0, 0);
    }
    ctx.drawImage(t, r.x, r.y);
    return c.toDataURL("image/png");
}

/**
 * One Render panel in `host`. `st` is its state ({} for an instance; the first panel's lives on the viewer as
 * `_r3St`); `saved` what an instance kept ({pass, wipe, wipeX, folds}).
 */
export function createRenderPanelInstance(v, host, st, saved, id) {
    Object.assign(st, { id, pass: "beauty", wipe: false, wipeX: 0.5, passes: null, frame: null, camera: null,
                        ai: null, busy: null, error: "", folds: { ai: true, settings: false },
                        aiOn: true, ipr: false, region: { on: false, box: null } }, saved ? {
        pass: saved.pass || "beauty", wipe: !!saved.wipe, wipeX: Number.isFinite(saved.wipeX) ? saved.wipeX : 0.5,
        folds: { ai: true, settings: false, ...(saved.folds || {}) }, aiOn: saved.aiOn !== false, ipr: !!saved.ipr,
        region: { on: !!(saved.region && saved.region.on), box: cleanBox(saved.region && saved.region.box) } } : {});
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
        if (ui && ui.setWin) ui.setWin.shade.remove();
        host.querySelectorAll(":scope > .r3-panel, :scope > style[data-r3]").forEach((n) => n.remove());
        const d = doc();
        const style = el(d, "style"); style.dataset.r3 = "1"; style.textContent = STYLE;
        const root = el(d, "div", "r3-panel");
        const bar = el(d, "div", "r3-bar");
        const render = el(d, "button", "r3-btn primary r3-render", "Render");
        render.title = "Render this frame through the render camera (beauty, depth, normals, mask), then run the workflow when AI is on";
        render.onclick = () => {
            if (st.run) return v._r3Stop(st);
            if (v._previzRendering && st.busy && st.busy.kind === "render") { v._previzRenderStop = true; return; }
            v.previzRenderPanelRender(st);
        };
        const aiBtn = el(d, "button", "r3-btn r3-ai-btn", "AI");
        aiBtn.title = "Render runs the panel's workflow on the passes (off: the passes only)";
        aiBtn.onclick = () => { st.aiOn = !st.aiOn; draw(); };
        const iprBtn = el(d, "button", "r3-btn r3-ipr-btn", "IPR");
        iprBtn.title = "Interactive preview: the passes are drawn again whenever the scene, the camera or the frame changes (a preview size; the workflow is not run)";
        iprBtn.onclick = () => v.previzRenderPanelIpr(st, !st.ipr);
        const regionBtn = el(d, "button", "r3-btn r3-region-btn", "Region");
        regionBtn.title = "Region render: drag a box on the picture; only it is rendered and only it goes through the workflow (double-click: the whole frame)";
        regionBtn.onclick = () => { st.region.on = !st.region.on; draw(); };
        const passes = el(d, "select", "r3-pass-select");
        passes.title = "The pass shown";
        passes.addEventListener("change", () => { st.pass = passes.value; st.wipe = false; draw(); });
        passes.addEventListener("keydown", (e) => e.stopPropagation());
        const wipe = el(d, "button", "r3-btn r3-wipe-btn", "Wipe");
        wipe.title = "Compare the AI result with the beauty: drag the line";
        wipe.onclick = () => { st.wipe = !st.wipe; if (st.wipe && st.ai) st.pass = "ai"; draw(); };
        const info = el(d, "span", "r3-info");
        const setBtn = el(d, "button", "r3-btn r3-settings-btn", "Settings");
        setBtn.title = "The render settings (camera, size, renderer, samples, output) in a floating window";
        setBtn.onclick = () => settingsWin(!(ui.setWin && ui.setWin.shade.isConnected));
        // The camera this panel renders through (Sebastian 2026-11-25): the settings' Camera,
        // reachable without the settings window.
        const camSel = el(d, "select", "r3-pass-select r3-cam-select");
        camSel.title = "The camera this panel renders through";
        camSel.addEventListener("change", () => v.previzRenderPanelCamera(st, camSel.value));
        camSel.addEventListener("keydown", (e) => e.stopPropagation());
        bar.append(render, aiBtn, iprBtn, regionBtn, setBtn, camSel, el(d, "span", "r3-sep"), passes, wipe, info);

        const stage = el(d, "div", "r3-stage");
        stage.tabIndex = -1;
        const imgA = el(d, "img", "r3-a"); imgA.alt = "";
        const imgB = el(d, "img", "r3-b"); imgB.alt = "";
        const line = el(d, "div", "r3-wipe-line");
        const tagL = el(d, "span", "r3-tag", "AI"); tagL.style.left = "6px";
        const tagR = el(d, "span", "r3-tag", "Beauty"); tagR.style.right = "6px";
        const empty = el(d, "div", "r3-empty", "Press Render to draw this frame through the render camera.");
        const busy = el(d, "div", "r3-busy");
        const regionEl = el(d, "div", "r3-region");
        stage.append(imgA, imgB, line, regionEl, tagL, tagR, empty, busy);
        // Where the picture lies in the stage (object-fit: contain), in stage pixels.
        const picRect = () => {
            const r = stage.getBoundingClientRect();
            const sz = st.size || { w: 16, h: 9 };
            const k = Math.min(r.width / sz.w, r.height / sz.h);
            const w = sz.w * k, h = sz.h * k;
            return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h, stage: r };
        };
        const toShare = (e) => {
            const p = picRect();
            return [Math.min(1, Math.max(0, (e.clientX - p.left) / (p.width || 1))), Math.min(1, Math.max(0, (e.clientY - p.top) / (p.height || 1)))];
        };
        const drawRegion = (e0) => {
            const a = toShare(e0);
            const move = (e) => { const b = toShare(e); st.region.box = cleanBox([a[0], a[1], b[0], b[1]]); placeRegion(); };
            const up = () => { stage.removeEventListener("pointermove", move); stage.removeEventListener("pointerup", up); v._r3Saved && v._r3Saved(st); };
            stage.setPointerCapture && stage.setPointerCapture(e0.pointerId);
            stage.addEventListener("pointermove", move);
            stage.addEventListener("pointerup", up);
        };
        stage.addEventListener("dblclick", () => { if (st.region.on) { st.region.box = null; placeRegion(); } });
        const moveWipe = (e) => {
            const r = stage.getBoundingClientRect();
            if (!r.width) return;
            st.wipeX = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            placeWipe();
        };
        stage.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            if (st.region.on && e.target !== line) { e.preventDefault(); drawRegion(e); return; }
            if (!st.wipe) return;
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
        // The prompt: the panel's own, whichever workflow is on (it fills the workflow's prompt).
        const promptRow = el(d, "div", "r3-prompt");
        const prompt = el(d, "textarea", "r3-prompt-in");
        prompt.rows = 2;
        prompt.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); prompt.blur(); v.previzRenderPanelRender(st); }
        });
        prompt.addEventListener("input", () => {
            const kk = keep();
            if (!kk) return;
            kk.prompt = prompt.value;
            clearTimeout(ui.promptTimer);
            ui.promptTimer = setTimeout(persist, 400);
        });
        prompt.addEventListener("change", persist);
        promptRow.append(el(d, "span", "r3-label", "Prompt"), prompt);
        // Reference pictures (a style, a product, a face): loaders named ref / ref2 ... take them.
        const refsRow = el(d, "div", "r3-refs");
        const refsList = el(d, "div", "r3-refs-list");
        refsList.style.display = "contents";
        const refAdd = el(d, "button", "r3-btn r3-ref-add", "+");
        refAdd.title = "Add a reference picture: the History selection or a file (or drop one here)";
        refAdd.onclick = () => {
            const r = refAdd.getBoundingClientRect();
            v._previzOpenMenu([
                { label: "The History selection", run: () => {
                    const got = (v.selectedHistorySnapshots ? v.selectedHistorySnapshots() : []).map((x) => x.imgObj)
                        .filter((f) => f && A.isAtlasPicture(f) && A.pictureRef(f));
                    if (!got.length) { notice("info", "Reference pictures", "Select pictures in the History strip first (Ctrl+click for several)."); return; }
                    v.previzRenderPanelRefs(st, { add: got });
                } },
                { label: "From a file…", run: () => openFilePicker(v.container, {
                    id: "render3d-refs", title: "Reference pictures", kind: "image", exts: [".png", ".jpg", ".jpeg", ".webp"],
                    multiple: true, go: "Add", note: `Up to ${MAX_REFS} pictures the workflow takes beside the render.`,
                    onPick: async (files) => { v.previzRenderPanelRefs(st, { add: files.map((f) => ({ path: f.path, name: f.name })) }); return { ok: true }; },
                }) },
                ...((mine().refs || []).length ? ["-", { label: "Remove all", run: () => v.previzRenderPanelRefs(st, { set: [] }) }] : []),
            ], r.left, r.bottom + 2, refAdd);
        };
        const refHint = el(d, "span", "r3-hint r3-ref-hint");
        refsRow.append(el(d, "span", "r3-label", "Refs"), refsList, refAdd, refHint);
        wirePictureDrop(refsRow, {
            onItems: (items) => v.previzRenderPanelRefs(st, { add: items }),
            onSkipped: (n) => notice("warn", "Reference pictures", `${n} file(s) left out: only pictures (png, jpg, webp).`),
            onStatus: (text, bad) => { if (bad) notice("error", "Reference pictures", text); },
        });
        root.append(bar, stage, promptRow, refsRow, scroll);
        host.append(style, root);
        ui = { root, bar, render, aiBtn, iprBtn, regionBtn, passes, wipe, info, stage, imgA, imgB, line, regionEl, tagL, tagR, empty, busy,
               aiFold, setBtn, setWin: null, camSel, prompt, promptRow, refsRow, refsList, refAdd, refHint, refSig: null, picRect, form: null, formScene: null, aiSig: null };
        buildForm();
        buildAi();
        draw();
        return ui;
    }

    /** The render settings in a floating window (not modal: the panel and the viewer stay usable), one per panel. */
    function settingsWin(open) {
        if (!ui) return;
        const w = ui.setWin;
        if (!open) { if (w) { w.shade.remove(); } ui.setWin = null; ui.form = null; ui.formScene = null; draw(); return; }
        if (w && w.shade.isConnected) return;
        const d = doc();
        const shade = el(d, "div", "rd-shade r3-setwin");
        const box = el(d, "div", "rd-box");
        const head = el(d, "div", "rd-head");
        const x = el(d, "button", "rd-x", "✕");
        x.title = "Close";
        x.onclick = () => settingsWin(false);
        head.append(el(d, "span", "rd-title", "Render settings"), x);
        const body = el(d, "div", "r3-form-host");
        box.append(head, body);
        shade.append(box);
        floatDialog(shade, box, head);
        v.container.append(shade);
        ui.setWin = { shade, box, body };
        ui.formScene = null;
        buildForm();
        draw();
    }

    function buildForm() {
        const sc = scene();
        if (!ui || !sc || !ui.setWin || ui.formScene === sc) return;
        ui.setWin.body.textContent = "";
        ui.form = v._renderFormBuild(ui.setWin.body, { onChange: () => draw() });
        ui.form.root.classList.add("r3-form");
        ui.formScene = sc;
    }

    // ── the AI workflow ──────────────────────────────────────────────────────

    function aiSig() {
        const k = mine();
        const c = k.custom;
        return JSON.stringify([c ? [c.sig, c.name, c.source, c.path] : null, !!st.run, st.askDl ? 1 : 0, st.error,
                               (k.stack || []).map((l) => (l.custom && [l.custom.sig, l.custom.name]) || null), st.sel || 0]);
    }

    /** Take layer `i` out of the stack; an empty stack takes the panel's result with it. */
    function removeLayer(i) {
        const kk = keep();
        if (!kk) return;
        stackSync(kk, st);                       // the selection back into its layer first
        kk.stack.splice(i, 1);
        // Select the layer that took its place (or the last one), without writing anything back:
        // stackSync would mirror the still-current workflow into the shortened stack again.
        const n = kk.stack.length;
        const sel = (st.sel || 0) > i ? (st.sel || 0) - 1 : (st.sel || 0);
        st.sel = Math.max(0, Math.min(sel, n - 1));
        const l = n ? kk.stack[st.sel] : null;
        if (l) { kk.custom = l.custom; kk.values = l.values || {}; }
        else {
            delete kk.custom; delete kk.values; delete kk.last;
            st.ai = null;
            if (st.pass && st.pass.startsWith("ai")) st.pass = "beauty";
            st.wipe = false;
        }
        st.persist(); ui.aiSig = null; buildAi(); draw();
    }

    /** Right-click a stack layer: replace it, put it on the canvas, move it, take it away. */
    function stackMenu(e, i) {
        const k = mine();
        const n = (k.stack || []).length;
        const l = (k.stack || [])[i];
        const move = (dir) => {
            const kk = keep();
            if (!kk) return;
            stackSync(kk, st);
            const j = i + dir;
            if (j < 0 || j >= kk.stack.length) return;
            [kk.stack[i], kk.stack[j]] = [kk.stack[j], kk.stack[i]];
            if ((st.sel || 0) === i) st.sel = j; else if ((st.sel || 0) === j) st.sel = i;
            stackSelect(kk, st, st.sel || 0);
            st.persist(); ui.aiSig = null; buildAi(); draw();
        };
        v._previzOpenMenu([
            { label: "Replace workflow…", run: () => {
                const kk = keep();
                if (!kk) return;
                stackSelect(kk, st, i);
                st.persist(); ui.aiSig = null; buildAi(); draw();
                v._r3PickMenu(st, e.target);
            } },
            { label: "Load workflow in Canvas", disabled: !(l && l.custom && l.custom.graph),
              title: "Put this layer's workflow on the open canvas",
              run: () => { app.loadGraphData(l.custom.graph, true, true, l.custom.name || "render3d"); } },
            "-",
            { label: "Move up", disabled: i === 0, run: () => move(-1) },
            { label: "Move down", disabled: i === n - 1, run: () => move(1) },
            "-",
            { label: "Remove", run: () => removeLayer(i) },
        ], e.clientX, e.clientY);
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
        // The stack (Sebastian 2026-11-25): layer 1 runs on the passes, every next one on the
        // picture the layer before gave; the selected layer is what the settings below edit.
        const stack = stackSync(k, st);
        const listBox = el(d, "div", "r3-stack");
        stack.forEach((l, i) => {
            const row = el(d, "div", "r3-stack-row" + (i === (st.sel || 0) ? " sel" : ""));
            row.append(el(d, "span", "r3-stack-n", `${i + 1}`),
                       el(d, "span", "r3-stack-name", (l.custom && (l.custom.name || "My workflow")) || "—"));
            row.title = "Click to edit this layer; right-click: replace, move, load in Canvas, remove";
            row.addEventListener("click", () => {
                const kk = keep();
                if (!kk || (st.sel || 0) === i) return;
                stackSelect(kk, st, i);
                st.persist(); ui.aiSig = null; buildAi(); draw();
            });
            row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); stackMenu(ev, i); });
            listBox.append(row);
        });
        const add = el(d, "button", "r3-btn r3-stack-add", stack.length ? "+ Add layer" : "+ Choose workflow");
        add.title = stack.length
            ? "Put another workflow on top: what the last layer gives is what it gets"
            : "The workflow this panel runs on its render";
        add.onclick = () => {
            const kk = keep();
            if (!kk) return;
            stackSync(kk, st);
            stackSelect(kk, st, kk.stack.length);
            st.persist(); ui.aiSig = null; buildAi(); draw();
            v._r3PickMenu(st, add);
        };
        listBox.append(add);
        body.append(listBox);
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
            off.title = "Take this layer off the stack";
            off.onclick = () => removeLayer(st.sel || 0);
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
            const pp = promptParam(c);
            for (const p of c.params || []) {
                if (p === pp) continue;            // the prompt field under the picture is this one
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
                    stackSync(kk, st);
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
        const run = el(d, "button", "r3-btn r3-run", st.run ? "Stop" : "Run again");
        run.title = "Run the stack again on this render: the layers in order, each on the picture the one before gave (a new seed; the frame is rendered first when it is not yet)";
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

    function placeRegion() {
        if (!ui) return;
        const b = st.region.box;
        ui.regionEl.classList.toggle("has", !!b);
        ui.stage.classList.toggle("region-on", !!st.region.on);
        if (!b) return;
        const p = ui.picRect(), s0 = p.stage;
        Object.assign(ui.regionEl.style, {
            left: `${p.left - s0.left + b[0] * p.width}px`, top: `${p.top - s0.top + b[1] * p.height}px`,
            width: `${(b[2] - b[0]) * p.width}px`, height: `${(b[3] - b[1]) * p.height}px`,
        });
        ui.regionEl.style.display = st.region.on ? "" : "none";
    }

    function placeWipe() {
        if (!ui) return;
        const pct = `${(st.wipeX * 100).toFixed(2)}%`;
        ui.line.style.left = pct;
        ui.imgB.style.clipPath = st.wipe ? `inset(0 ${(100 - st.wipeX * 100).toFixed(2)}% 0 0)` : "";
    }

    /** The reference strip: a thumbnail per kept picture (× takes it away), and what the workflow does with them. */
    function drawRefs(c) {
        const refs = mine().refs || [];
        const slots = refSlots(c);
        const sig = JSON.stringify([refs, slots]);
        if (ui.refSig === sig) return;
        ui.refSig = sig;
        const d = doc();
        ui.refsList.textContent = "";
        refs.forEach((r, i) => {
            const t = el(d, "div", "r3-ref" + (c && i >= slots ? " unused" : ""));
            t.title = r.name + (c && i >= slots ? " (this workflow does not take it)" : "");
            const img = el(d, "img");
            img.draggable = false;
            try { img.src = v.thumbUrl ? v.thumbUrl(r.path ? { path: r.path, external: true } : r) : ""; } catch (_) { /* no picture */ }
            const x = el(d, "button", "r3-ref-x", "×");
            x.title = "Remove";
            x.onclick = (e) => { e.stopPropagation(); v.previzRenderPanelRefs(st, { remove: i }); };
            t.append(img, el(d, "span", "r3-ref-n", `ref${i + 1}`), x);
            ui.refsList.append(t);
        });
        ui.refAdd.disabled = refs.length >= MAX_REFS;
        ui.refHint.textContent = !refs.length
            ? (!c ? "Drop pictures here for a workflow that takes references." : slots ? `This workflow takes ${slots === 1 ? "one reference picture" : `up to ${slots} reference pictures`}: drop them here.` : "")
            : !c ? "" : !slots ? "This workflow takes no reference pictures (name a loader comp:ref1 in your own)."
            : (c.source === "prepared" && REF_HINTS[c.path]) || `Used: ${Math.min(refs.length, slots)} of ${refs.length}.`;
    }

    function draw() {
        if (!ui || !ui.root.isConnected) return;
        buildForm();
        buildAi();
        const d = doc();
        const list = passList();
        if (!list.some(([k]) => k === st.pass)) st.pass = "beauty";
        if (!st.ai) st.wipe = false;
        const sig = JSON.stringify(list.map(([k]) => k));
        if (ui.passSig !== sig) {
            ui.passSig = sig;
            ui.passes.textContent = "";
            for (const [k, label] of list) {
                const o = el(d, "option", "", label);
                o.value = k;
                ui.passes.append(o);
            }
        }
        for (const o of ui.passes.options) o.disabled = o.value.startsWith("ai") ? !urlOf(o.value) : !st.passes;
        if (ui.passes.value !== st.pass) ui.passes.value = st.pass;
        ui.passes.disabled = !st.passes && !st.ai;
        // The bar's camera list: the scene's cameras, the one the settings render through ticked by value.
        const sc = scene();
        const camWant = [["", "Free view"], ...(sc ? S.cameras(sc) : []).map((cc) => [cc.id, cc.name])];
        const camSig = JSON.stringify(camWant);
        if (ui.camSig !== camSig) {
            ui.camSig = camSig;
            ui.camSel.textContent = "";
            for (const [k, label] of camWant) ui.camSel.append(Object.assign(el(d, "option"), { value: k, textContent: label }));
        }
        const camNow = sc ? v._renderCameraId(S.renderSettings(sc), sc) : "";
        if (ui.camSel.value !== camNow) ui.camSel.value = camNow;
        const c = mine().custom;
        const layers = (mine().stack || []).length;
        ui.aiBtn.classList.toggle("on", !!(st.aiOn && c));
        ui.aiBtn.disabled = !c;
        ui.aiBtn.title = c ? (layers > 1
            ? `Render runs the stack's ${layers} layers in order on the passes (off: the passes only)`
            : `Render runs ${c.name || "the workflow"} on the passes (off: the passes only)`)
            : "Choose a workflow (AI workflow below) to run it on the render";
        ui.iprBtn.classList.toggle("on", !!st.ipr);
        ui.regionBtn.classList.toggle("on", !!st.region.on);
        const pp = promptParam(c);
        const want = mine().prompt || "";
        if (ui.prompt.ownerDocument.activeElement !== ui.prompt && ui.prompt.value !== want) ui.prompt.value = want;
        ui.prompt.disabled = !!(c && !pp);
        ui.prompt.placeholder = !c ? "Describe the scene: what everything is made of, where, the light. Used by the workflow you choose."
            : pp ? `Describe the scene (empty: the workflow's own - ${String(pp.def || "").slice(0, 90)}${String(pp.def || "").length > 90 ? "…" : ""})`
            : "This workflow takes no prompt";
        drawRefs(c);
        ui.wipe.disabled = !st.ai || !st.passes;
        ui.wipe.classList.toggle("on", st.wipe);
        ui.setBtn.classList.toggle("on", !!(ui.setWin && ui.setWin.shade.isConnected));
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
        placeRegion();
        ui.empty.style.display = urlOf(st.wipe ? "beauty" : st.pass) ? "none" : "";
        const b = st.busy;
        ui.busy.classList.toggle("on", !!b);
        ui.busy.textContent = b ? b.text : "";
        const going = !!(st.run || (b && b.kind === "render" && !st.iprBusy));
        ui.render.textContent = going ? "Stop" : st.region.on && st.region.box ? "Render region" : "Render";
        ui.render.disabled = !going && !!v._previzRendering;
        // What the picture is, and whether the playhead has moved on since.
        const f = Math.round(v.currentFrame || 0);
        const stale = st.frame !== null && st.frame !== f;
        ui.info.classList.toggle("stale", stale);
        ui.info.textContent = st.frame === null ? "" : `${st.size ? `${st.size.w}×${st.size.h} · ` : ""}frame ${st.frame}${st.passes && st.passes.preview ? " · preview" : ""}${stale ? ` (now ${f})` : ""}`;
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
        if (st.ai || !last || !last.main) return;
        const more = {};
        for (const [n, ref] of Object.entries(last.more || {})) more[n] = viewUrl(ref);
        if (!last.region) { st.ai = { url: viewUrl(last.main), more, frame: last.frame }; return; }
        // A region run: pasted over the runs before it (one over the beauty needs that render: not shown then).
        v._r3Compose(doc(), last).then((url) => {
            if (url && !st.ai && mine().last === last) { st.ai = { url, more, frame: last.frame }; draw(); }
        }).catch(() => {});
    }
    restoreLast();

    st.draw = draw;
    st.keep = keep;
    st.mine = mine;
    st.persist = persist;
    st.panel = () => ui;
    st.settingsWin = settingsWin;
    st.rebuildAi = () => { if (ui) { ui.aiSig = null; buildAi(); } };
    build();
    if (st.ipr) { st.ipr = false; v.previzRenderPanelIpr(st, true); }
    return {
        el: host,
        refresh,
        build,
        wake: () => refresh(),
        save: () => ({ pass: st.pass, wipe: st.wipe, wipeX: st.wipeX, folds: { ...st.folds }, aiOn: st.aiOn, ipr: st.ipr,
                       region: { on: st.region.on, box: st.region.box } }),
        dispose: () => { settingsWin(false); if (st.run) v._r3Stop(st); v.previzRenderPanelIpr(st, false, { keep: true }); },
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
        inst.refresh();
        if (settings && inst.st.settingsWin) inst.st.settingsWin(true);
        return inst;
    },

    /** The camera a Render panel renders through, chosen in its bar: the settings' Camera, kept on the scene. */
    previzRenderPanelCamera(st, id) {
        const scene = this.previzScene();
        if (!scene) return;
        const camera = S.cameras(scene).some((c) => c.id === id) ? id : "";
        this._renderKeep({ ...S.renderSettings(scene), camera });
        this._r3Refresh();
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
        const ref = (!x || !x.kind || x.kind === "picture") ? refSlots({ inputs: [{ name: n }] }) : 0;
        if (ref) return `ref${ref}`;
        for (const [p, list] of Object.entries(names)) if (list.includes(n)) return p;
        for (const p of ["depth", "normals", "mask"]) if (names[p].some((a) => a.length > 2 && n.startsWith(a))) return p;
        return x && x.kind === "mask" ? "mask" : "beauty";
    },

    // ── one frame, four passes ───────────────────────────────────────────────

    /** Render (the bar's button, Ctrl+Enter in the prompt, the agent): the passes, then the workflow when AI is on. */
    async previzRenderPanelRender(st, { ai = null } = {}) {
        const c = st.mine && st.mine().custom;
        if ((ai === null ? st.aiOn : ai) && c) return this.previzRenderAi(st, { fresh: true });
        const ok = await this.previzRenderStill(st);
        return { ok, frame: st.frame, region: ok && st.lastRegion ? st.lastRegion : null };
    },

    /**
     * Render the current frame through the render camera into panel `st`: beauty (raster or path traced, as the
     * settings say), depth, normals and mask. Answers whether it drew.
     * `preview` (IPR): at a size that fits the panel, the path tracer at a few samples, the region left out.
     * With the panel's region on (and a full render of this frame, camera and size there to paste into) only the
     * box is rendered - the camera's projection narrowed onto it - and pasted into the passes there.
     */
    async previzRenderStill(st, { preview = false } = {}) {
        const scene = this.previzScene();
        const view = this._modelView && this._modelView();
        if (!scene || !view || this._previzRendering) return false;
        view._keepFrame = true;       // the viewport's last frame stands in for the canvas while a render owns it
        const s = S.renderSettings(scene);
        const camera = this._renderCameraId(s, scene);
        let { w, h } = this._renderSize(s, scene);
        const f = Math.round(this.currentFrame || 0);
        if (preview) {
            const ui = st.panel && st.panel();
            const sr = ui && ui.stage.getBoundingClientRect();
            const dpr = (this._viewerWindow ? this._viewerWindow() : window).devicePixelRatio || 1;
            const fit = sr && sr.width ? Math.min(1, (sr.width * dpr) / w, (sr.height * dpr) / h) : 0.5;
            const k = Math.max(Math.min(1, 320 / Math.max(w, h)), Math.min(fit, 960 / Math.max(w, h)));
            w = Math.max(2, Math.round(w * k)); h = Math.max(2, Math.round(h * k));
        }
        const traced = s.renderer === "pathtraced";
        const doc = this.container.ownerDocument;
        const box = !preview && st.region && st.region.on ? cleanBox(st.region.box) : null;
        const base = st.passes;
        const region = box && base && !base.preview && st.frame === f && st.camera === camera && st.size
            && st.size.w === w && st.size.h === h && st.depthRange ? boxPixels(box, w, h) : null;
        // The box in whole pixels, as the projection narrows onto it.
        const rbox = region ? [region.x / w, region.y / h, (region.x + region.w) / w, (region.y + region.h) / h] : null;
        const RW = region ? region.w : w, RH = region ? region.h : h;
        this._previzRendering = true;
        this._previzRenderStop = false;
        st.iprBusy = preview;
        st.busy = { kind: "render", text: preview ? `Preview of frame ${f}…` : region ? `Rendering the region of frame ${f}…` : `Rendering frame ${f}…` };
        if (!preview) st.error = "";
        st.draw && st.draw();
        const out = {};
        let ok = false;
        try {
            const begin = (o) => {
                if (!view.beginRender({ camera, grid: s.grid, helpers: s.helpers, region: rbox, ...o }))
                    throw new Error("the 3D view is not ready");
            };
            begin({ shading: traced ? "original" : s.shading, background: s.background, color: s.color, aa: traced ? 1 : preview ? 1 : s.aa });
            if (view.prepareVideoPlanes) { view.applyFrame(f); await view.prepareVideoPlanes(f); }
            out.beauty = traced
                ? await view.renderFramePathTraced(f, RW, RH, {
                    samples: preview ? Math.min(s.samples || 16, 16) : s.samples, bounces: s.bounces, shouldStop: () => this._previzRenderStop,
                    onSample: (n, want) => { st.busy.text = `Path tracing frame ${f}${region ? " (region)" : ""}: sample ${n} of ${want}`; st.draw && st.draw(); },
                })
                : view.renderFrame(f, RW, RH);
            if (this._previzRenderStop) throw Object.assign(new Error("stopped"), { stopped: true });
            if (!out.beauty) throw new Error(traced ? "the path tracer produced no image" : "the renderer produced no image");
            const depth = view.renderDepth ? view.renderDepth(RW, RH) : null;
            view.endRender();
            let range = null;
            if (depth) {
                const g = depthToGrey(depth, region ? st.depthRange : null);
                range = g.range;
                out.depth = pixelsToUrl(doc, g);
            }
            // The normals: the camera's space, a flat blue where nothing is (what a normal map has there).
            begin({ shading: "normal", background: "color", color: "#8080ff", aa: preview ? 1 : s.aa, grid: false, helpers: false });
            out.normals = view.renderFrame(f, RW, RH);
            view.endRender();
            // The mask: what covers the frame, from a transparent render's alpha.
            begin({ shading: "clay", background: "transparent", aa: preview ? 1 : s.aa, grid: false, helpers: false });
            const cover = view.renderFrame(f, RW, RH);
            view.endRender();
            out.mask = cover ? await alphaToGrey(doc, cover) : null;
            if (!out.depth) out.depth = out.mask;      // no float targets: at least where something is
            if (region) {
                for (const k of ["beauty", "depth", "normals", "mask"]) {
                    if (out[k] && base[k]) out[k] = await pasteUrl(doc, base[k], out[k], region, 0);
                }
                st.lastRegion = box;
            } else {
                st.lastRegion = null;
                if (!preview) st.depthRange = range;
            }
            if (preview) out.preview = true;
            else this._r3History(st, "Beauty", out.beauty);
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
            st.iprBusy = false;
            if (st.rebuildAi) st.rebuildAi();
            st.draw && st.draw();
        }
        return ok;
    },

    /**
     * A finished render into the History (Sebastian 2026-11-24: so the main viewer's wipe, compare and Contact Sheet
     * work on it): saved by the export rule as the next version, then pushed as a group "3D renders", not switched to.
     */
    async _r3History(st, label, url) {
        if (!url) return;
        try {
            const doc = this.container.ownerDocument;
            let data = url;
            if (!/^data:image\/(png|jpeg);/.test(url)) {
                const img = await loadImg(doc, url);
                const c = doc.createElement("canvas");
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                c.getContext("2d").drawImage(img, 0, 0);
                data = c.toDataURL("image/png");
            }
            const name = `${(this.previzRenderName && this.previzRenderName()) || "render"}_${label.toLowerCase()}`;
            const res = await api.fetchApi("/imageviewer/save_annotation", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dataurl: data, name, context: canvasContext() }),
            });
            const saved = await res.json().catch(() => ({}));
            if (!res.ok || !saved.path) throw new Error(saved.error || `HTTP ${res.status}`);
            await post("/imageviewer/push", { paths: [saved.path], tab_name: "3D renders", group: "3D renders",
                                              label: `${label} · frame ${st.frame}`, focus: false });
        } catch (e) {
            console.warn("[ImageViewer] Render panel: the render did not reach the History", e);
        }
    },

    /** What an IPR redraw follows: the frame, the render settings and camera, the meshes, lights and the view. */
    _r3IprSig(st) {
        const scene = this.previzScene();
        const view = this._modelView && this._modelView();
        if (!scene || !view) return null;
        const s = S.renderSettings(scene);
        const camId = this._renderCameraId(s, scene);
        const parts = [Math.round(this.currentFrame || 0), JSON.stringify(s), camId];
        if (camId) parts.push(JSON.stringify(S.itemById(scene, camId)));
        else if (view.camera) parts.push(view.camera.matrixWorld.elements.map((x) => x.toFixed(4)).join(","));
        try {
            if (view._ptSceneSig && view._ptContent) parts.push(view._ptSceneSig(view._ptContent(null)));
            if (view._ptLightSig) parts.push(view._ptLightSig());
        } catch (_e) { /* a view without the tracer's helpers: the scene's own numbers */ }
        return parts.join("|");
    },

    /**
     * IPR on panel `st`: a preview of the passes whenever what it renders changed (checked 4 times a second,
     * drawn after it has held still for a moment). The workflow is not run; Render still renders in full.
     */
    previzRenderPanelIpr(st, on, { keep = false } = {}) {
        if (st.iprTimer) { (st.iprWin || window).clearInterval(st.iprTimer); st.iprTimer = null; }
        if (!keep) st.ipr = !!on;
        if (on && !keep) {
            const win = this._viewerWindow ? this._viewerWindow() : window;
            st.iprWin = win;
            st.iprSeen = null;
            st.iprDone = null;
            st.iprTimer = win.setInterval(() => {
                const ui = st.panel && st.panel();
                if (!ui || !ui.root.isConnected) { this.previzRenderPanelIpr(st, false, { keep: true }); return; }
                if (!this.isPrevizTab || !this.isPrevizTab() || this._previzRendering || st.run || !ui.root.offsetParent) return;
                const sig = this._r3IprSig(st);
                if (sig === null) return;
                if (sig !== st.iprSeen) { st.iprSeen = sig; return; }       // still moving: wait until it holds
                if (sig === st.iprDone) return;
                st.iprDone = sig;
                this.previzRenderStill(st, { preview: true }).catch(() => {});
            }, 250);
        }
        st.draw && st.draw();
        if (this._r3Saved) this._r3Saved(st);
    },

    /** The panel's look (pass, wipe, AI, IPR, region) kept with the dock layout. */
    _r3Saved() {
        if (this.queuePersistViewerState) this.queuePersistViewerState();
    },

    /** A region run's picture: its result pasted over what was there before (`last.under`, as far as it goes). */
    async _r3Compose(doc, last, depth = 0) {
        if (!last || !last.main) return null;
        const url = viewUrl(last.main);
        if (!last.region) return url;
        if (!last.under || depth > 8) return null;
        const under = await this._r3Compose(doc, last.under, depth + 1);
        if (!under) return null;
        const img = await loadImg(doc, under);
        const size = last.size && last.size.w > 0 ? last.size : { w: img.naturalWidth, h: img.naturalHeight };
        const r = boxPixels(last.region, size.w, size.h);
        return pasteUrl(doc, under, url, r, featherOf(r), size);
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
            { label: "Saved workflow", sub: saved.length ? saved.slice(0, 300).map((p) => ({ label: p.replace(/\.json$/i, ""), run: () => this._r3Take(st, { how: "saved", path: p }) }))
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
        // The main models only; the rest of Paint's list (dozens) under one submenu, which scrolls.
        const rank = (it) => MAIN_PREPARED.indexOf(it.id);
        const main = other.filter((it) => rank(it) >= 0).sort((a, b) => rank(a) - rank(b));
        const more = other.filter((it) => rank(it) < 0);
        const edits = main.filter((it) => it.action !== "upscale"), ups = main.filter((it) => it.action === "upscale");
        if (edits.length) entries.push({ head: "Edit the picture" }, ...edits.map(row));
        if (ups.length) entries.push({ head: "Upscale" }, ...ups.map(row));
        if (more.length) {
            const moreEdit = more.filter((it) => it.action !== "upscale"), moreUp = more.filter((it) => it.action === "upscale");
            entries.push("-", { label: `More workflows (${more.length})`, sub: [
                ...(moreEdit.length ? [{ head: "Edit" }, ...moreEdit.map(row)] : []),
                ...(moreUp.length ? [{ head: "Upscale" }, ...moreUp.map(row)] : []),
            ] });
        }
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
        stackSync(k, st);
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

    /** Change panel `st`'s reference pictures: `add` items ({path} | History items), `remove` an index, `set` a list. */
    previzRenderPanelRefs(st, { add = null, remove = null, set = null } = {}) {
        const k = st.keep();
        if (!k) return [];
        let refs = (set ? set : (k.refs || [])).map(cleanRef).filter(Boolean);
        if (Number.isInteger(remove)) refs.splice(remove, 1);
        if (add) {
            for (const r of add.map(cleanRef).filter(Boolean)) {
                const key = JSON.stringify(A.pictureRef(r));
                if (!refs.some((x) => JSON.stringify(A.pictureRef(x)) === key)) refs.push(r);
            }
        }
        if (refs.length > MAX_REFS) {
            notice("info", "Reference pictures", `The panel keeps ${MAX_REFS}: the first ${MAX_REFS} are kept.`);
            refs = refs.slice(0, MAX_REFS);
        }
        if (refs.length) k.refs = refs; else delete k.refs;
        st.persist();
        st.draw && st.draw();
        return refs;
    },

    /** The first `n` kept references as data URLs (at most REF_SIDE on their longest side), for render3d_ai. */
    async _r3RefData(refs, n) {
        const out = [];
        const doc = this.container.ownerDocument;
        for (const r of (refs || []).slice(0, Math.max(0, n))) {
            const url = this.buildImgUrl(r.path ? { path: r.path, external: true } : r, { noColor: true });
            let img;
            try { img = await loadImg(doc, url); } catch (_e) { throw new Error(`the reference picture ${r.name} could not be read`); }
            const sc = Math.min(1, REF_SIDE / Math.max(img.naturalWidth, img.naturalHeight, 1));
            const cv = doc.createElement("canvas");
            cv.width = Math.max(1, Math.round(img.naturalWidth * sc));
            cv.height = Math.max(1, Math.round(img.naturalHeight * sc));
            cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
            out.push(cv.toDataURL("image/png"));
        }
        return out;
    },

    _r3Stop(st) {
        const run = st.run;
        if (!run) return;
        run.stopped = true;
        if (run.stop) run.stop();
    },

    /**
     * One workflow of the stack over `passes` (PNG data URLs): filled in by the server, queued as
     * Paint's Generate is, its outputs read back (the first as the layer's picture). `under` is
     * what a region's answer is pasted over. Answers { ai, last, answer }; throws when it failed.
     */
    async _r3RunOne(st, c, values, passes, { box, rpx, run, tell, under, sameFrame }) {
        const k = st.mine();
        const doc = this.container.ownerDocument;
        tell(`${c.name || "Workflow"}: preparing`);
        let prep;
        for (let tries = 0; ; tries++) {
            try {
                let use = passes;
                if (rpx) {
                    use = {};
                    for (const p of ["beauty", "depth", "normals", "mask"]) if (passes[p]) use[p] = await cropUrl(doc, passes[p], rpx);
                }
                const refs = await this._r3RefData(k.refs, refSlots(c));
                prep = await post("/imageviewer/render3d_ai", { custom: c, values, passes: use, frame: st.frame, refs });
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
        ai.size = st.size ? { ...st.size } : null;
        if (rpx) {
            // Over the picture the layer before gave (the beauty for the first), the other outputs are the box's own.
            ai.url = await pasteUrl(doc, under, ai.url, rpx, featherOf(rpx), st.size);
            last.region = box;
            last.size = { ...st.size };
            const prev = st.mine().last;
            last.under = sameFrame && prev && prev.frame === st.frame ? trimChain(prev) : null;
            if (!last.under) last.base = "beauty";
        }
        return { ai, last, answer: { ok: true, frame: st.frame, outputs: Object.keys(images).length, uses: prep.uses,
                                     region: box, prompt: values[(promptParam(c) || {}).id] ?? null, main: last.main } };
    },

    /**
     * Run panel `st`'s stack on the frame: rendered first when the panel has no render of this frame,
     * then each layer in order - the first on the passes, every next one on the picture the layer
     * before gave - and the last one's outputs shown (the first as "AI", the others beside it).
     */
    async previzRenderAi(st, { fresh = false } = {}) {
        const k = st.mine();
        const stack = stackSync(k, st).filter((l) => l && l.custom);
        if (!stack.length) { st.error = "Choose a workflow first."; if (st.rebuildAi) st.rebuildAi(); return null; }
        if (st.run) return null;
        const f = Math.round(this.currentFrame || 0);
        const sc = this.previzScene();
        if (fresh || !st.passes || st.passes.preview || st.frame !== f || st.camera !== this._renderCameraId(S.renderSettings(sc), sc)) {
            if (!(await this.previzRenderStill(st))) return { ok: false, error: st.error || "the render did not draw" };
        }
        // A region: only the box goes through the workflows, and each answer is pasted back over the frame.
        const box = st.region && st.region.on ? cleanBox(st.region.box) : null;
        const doc = this.container.ownerDocument;
        const rpx = box && st.size ? boxPixels(box, st.size.w, st.size.h) : null;
        const sameFrame = st.ai && st.ai.frame === st.frame && st.ai.size && st.size && st.ai.size.w === st.size.w && st.ai.size.h === st.size.h;
        const run = st.run = { stopped: false, stop: null };
        st.error = "";
        if (st.rebuildAi) st.rebuildAi();
        const tell = (text) => { st.busy = { kind: "ai", text }; st.draw && st.draw(); };
        let answer = null;
        try {
            let passes = st.passes, ai = null, last = null;
            for (let i = 0; i < stack.length; i++) {
                const c = stack[i].custom;
                if (i > 0) {
                    if (!ai || !ai.url) throw new Error("a layer gave no picture for the next");
                    passes = { ...st.passes, beauty: await asDataUrl(doc, ai.url) };
                    tell(`Layer ${i + 1} of ${stack.length}: ${c.name || "workflow"}`);
                }
                const one = await this._r3RunOne(st, c, runValues({ values: stack[i].values, prompt: k.prompt }, c), passes, {
                    box, rpx, run, tell,
                    under: i === 0 ? (sameFrame ? st.ai.url : st.passes.beauty) : ai.url,
                    sameFrame: i === 0 && sameFrame,
                });
                ai = one.ai; last = one.last; answer = one.answer;
            }
            if (last.main && !shown(last.main)) st.error = `${last.main.filename}: the browser cannot show this file type here`;
            st.ai = ai;
            st.pass = "ai";
            this._r3History(st, stack.length > 1 ? `AI stack ${stack.length}` : "AI", ai.url);
            const kk = st.keep();
            if (kk) { kk.last = last; st.persist(); }
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
        if (answer && answer.ok) {
            const top = stack[stack.length - 1].custom;
            notice("info", `${stack.length > 1 ? `The stack (${stack.length} layers, last ${top.name || "workflow"})` : (top.name || "The workflow")}: the result is in`,
                   `Frame ${answer.frame}, in the Render panel.`);
        }
        return answer;
    },
};
