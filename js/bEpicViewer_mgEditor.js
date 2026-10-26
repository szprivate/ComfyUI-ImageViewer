// bEpicViewer_mgEditor.js
// The motion-graphics editor: layers, preview, timeline with keyframes, properties,
// a curve for the selected key and on-canvas gizmos, for one *.mgscene.json.
//
// It is a plain function over a host element - no dependency on the viewer's
// element or on ComfyUI - so the dock panel (bEpicViewer_mgPanel.js) and the
// standalone test page (tests/harness_mg) mount the same thing. What it needs from
// its surroundings arrives in `opts`:
//   assetUrl(src)            -> a url the browser can load for a scene asset's src
//   save(path, scene)        -> Promise, writes the file
//   render(path, scene)      -> Promise<{message}>, asks for a video
//   notify(text, severity)   -> a toast
//   split: true              -> the properties (with the curve) and the timeline (whose left column is the
//                               layer list) are NOT put in `host`: they are handed back as `parts`
//                               ({props, timeline}, plain elements), so the viewer can seat each in a dock
//                               panel of its own. `host` then holds the toolbar and the preview.
//   transport: {toggle, step(n), first, last}
//                            -> the host owns time (the viewer's own play / step / scrub bar): the editor has no
//                               transport of its own, plays nothing itself, and sends every time key through
//                               these. The host moves the playhead with editor.setFrame(f, {fromHost: true}).
//   onFrame(f)               -> the user moved the playhead here (ruler, playhead, track, a key); host-driven
//                               setFrame(..., {fromHost}) does not call it, so the two never echo.
//   onComp()                 -> the composition's length / frame rate / size changed (an edit, undo, load).
//
// The preview is the render: every SVG layer is drawn by layerSvg() from the shared
// module (bEpicViewer_mgScene.js), the same code agentY's Remotion renderer runs.
// Edits are the pure functions of bEpicViewer_mgModel.js, with a snapshot History for undo.
import * as S from "./bEpicViewer_mgScene.js";
import * as Mo from "./bEpicViewer_mgModel.js";

const NS = "http://www.w3.org/2000/svg";
const LABEL_W = 176;
const ROW_H = 22;
const AMBER = "#ff9d2e";

const CSS = `
.mg-root{display:flex;flex-direction:column;height:100%;min-height:0;background:#1b1b1f;color:#d8d8dc;font:12px/1.35 system-ui,Segoe UI,sans-serif;outline:none;position:relative}
.mg-root *{box-sizing:border-box}
.mg-bar{display:flex;gap:4px;align-items:center;padding:4px 6px;border-bottom:1px solid #2c2c32;flex-wrap:wrap}
.mg-bar .mg-title{font-weight:600;margin-right:6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-btn{background:#2b2b31;border:1px solid #3a3a42;color:#d8d8dc;border-radius:3px;padding:2px 7px;cursor:pointer;font:inherit}
.mg-btn:hover{background:#35353d}.mg-btn[disabled]{opacity:.4;cursor:default}.mg-btn.on{background:#ff6a1a;border-color:#ff6a1a;color:#111}
.mg-info{opacity:.6;white-space:nowrap}
.mg-sep{width:1px;height:16px;background:#3a3a42;margin:0 3px}
.mg-main{display:flex;flex:1;min-height:0}
.mg-ic{width:16px;text-align:center;opacity:.55;cursor:pointer;flex:none;user-select:none}.mg-ic.on{opacity:1}
.mg-type{font-size:10px;opacity:.5;width:14px;text-align:center;flex:none}
.mg-center{flex:1;display:flex;flex-direction:column;min-width:0}
.mg-stage-wrap{flex:1;min-height:80px;position:relative;overflow:hidden;background:#0f0f12}
.mg-stage{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;box-shadow:0 0 0 1px #444;isolation:isolate}
.mg-stage>div{position:absolute;left:0;top:0;width:0;height:0}
.mg-gizmo{position:absolute;left:0;top:0;transform-origin:0 0;overflow:visible;pointer-events:none}
.mg-transport{display:flex;gap:6px;align-items:center;padding:3px 6px;border-top:1px solid #2c2c32}
.mg-transport input{width:54px}
.mg-side{width:236px;border-left:1px solid #2c2c32;overflow:auto;flex:none;padding:4px 6px}
.mg-side h4{margin:8px 0 3px;font-size:11px;text-transform:uppercase;opacity:.55;font-weight:600}
.mg-prop{display:flex;align-items:center;gap:3px;margin:2px 0}
.mg-prop label{width:66px;flex:none;opacity:.8;overflow:hidden;text-overflow:ellipsis}
.mg-prop input[type=number],.mg-prop input[type=text],.mg-prop select,.mg-prop textarea{flex:1;min-width:0;background:#141418;border:1px solid #34343c;color:#e6e6ea;border-radius:2px;padding:1px 3px;font:inherit}
.mg-prop textarea{height:44px;resize:vertical}.mg-prop input[type=color]{width:34px;height:20px;padding:0;border:1px solid #34343c;background:none}
.mg-sw{width:16px;text-align:center;cursor:pointer;opacity:.5;flex:none;user-select:none}.mg-sw.on{opacity:1;color:${AMBER}}
.mg-key{width:16px;text-align:center;cursor:pointer;color:${AMBER};flex:none;user-select:none}
.mg-tl{user-select:none;height:210px;min-height:60px;overflow:auto;border-top:1px solid #2c2c32;position:relative;flex:none;background:#17171b}
.mg-tl-in{position:relative}
.mg-trow{display:flex;height:${ROW_H}px}
.mg-tlabel{position:sticky;left:0;z-index:3;width:${LABEL_W}px;flex:none;background:#1b1b1f;border-right:1px solid #2c2c32;padding:0 4px;display:flex;align-items:center;gap:3px;overflow:hidden;white-space:nowrap}
.mg-tlabel.sub{padding-left:40px;opacity:.8}.mg-trow.sel .mg-tlabel{background:#2b2218}
.mg-trow.mg-layer-row .mg-tlabel{cursor:pointer;user-select:none}.mg-trow.mg-layer-row:not(.sel):hover .mg-tlabel{background:#25252b}
.mg-trow.mg-hidden .mg-tlabel .mg-name,.mg-trow.mg-hidden .mg-type{opacity:.4}
.mg-tlabel .mg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.mg-tlabel input.mg-rename{flex:1;min-width:0;background:#0f0f12;border:1px solid #ff6a1a;color:#fff;font:inherit;padding:0 2px;border-radius:2px;height:18px}
.mg-ruler .mg-tlabel{gap:2px;padding:0 2px}
.mg-ruler .mg-btn{padding:0 5px;line-height:16px;height:18px}
.mg-trow.mg-drag-src{opacity:.45}
.mg-dropline{position:absolute;left:0;width:${LABEL_W}px;height:2px;background:#ff6a1a;z-index:6;pointer-events:none}
.mg-ctx{position:absolute;z-index:20;min-width:140px;background:#26262c;border:1px solid #44444c;border-radius:3px;padding:2px 0;box-shadow:0 4px 14px #0008}
.mg-ctx div{padding:3px 12px;cursor:pointer;white-space:nowrap}.mg-ctx div:hover{background:#3a2a1c}.mg-ctx hr{border:0;border-top:1px solid #3a3a42;margin:2px 0}
.mg-ttrack{position:relative;flex:none;border-bottom:1px solid #202026}
.mg-ruler .mg-ttrack{background:#202026;cursor:ew-resize;overflow:hidden}
.mg-tick{position:absolute;top:0;bottom:0;border-left:1px solid #34343c;font-size:9px;padding-left:2px;opacity:.7;pointer-events:none}
.mg-bar-range{position:absolute;top:6px;height:10px;background:#3a4a66;border-radius:2px;opacity:.7}
.mg-dia{position:absolute;top:5px;width:11px;height:11px;margin-left:-5px;background:${AMBER};transform:rotate(45deg) scale(.78);border:1px solid #402a00;cursor:pointer}
.mg-dia.agg{background:#b98a4a;pointer-events:none}.mg-dia.sel{background:#fff;border-color:#ff6a1a}
.mg-playhead{position:absolute;top:0;bottom:0;width:0;border-left:1px solid #ff3b3b;z-index:2;pointer-events:none}
.mg-ph-grip{position:absolute;top:0;margin-left:-8px;width:15px;height:${ROW_H}px;cursor:ew-resize;z-index:2}
.mg-ph-grip:before{content:"";position:absolute;top:3px;left:2px;border:6px solid transparent;border-top:9px solid #ff3b3b;border-bottom:0}
.mg-ph-grip:after{content:"";position:absolute;top:12px;bottom:0;left:7px;border-left:1px solid #ff3b3b}
.mg-ruler{position:sticky;top:0;z-index:5}
.mg-ttrack{touch-action:none}
.mg-curve{margin-top:4px}.mg-curve svg{width:100%;height:120px;background:#121216;border:1px solid #2c2c32;touch-action:none}
.mg-empty{padding:18px;opacity:.6}
.mg-part{background:#1b1b1f;color:#d8d8dc;font:12px/1.35 system-ui,Segoe UI,sans-serif;outline:none;position:absolute;inset:0;overflow:auto}
.mg-part,.mg-part *{box-sizing:border-box}
.mg-side.mg-part{width:auto;border:0}
.mg-tl.mg-part{height:auto;border:0;min-height:0}
.mg-toast{position:absolute;right:8px;bottom:8px;background:#2b2b31;border:1px solid #444;padding:4px 8px;border-radius:3px;z-index:9}
.mg-vid{background:#223;color:#9ab;font-size:20px;display:flex;align-items:center;justify-content:center;border:2px dashed #557}
`;

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const svgEl = (doc, tag, attrs = {}) => {
    const n = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round2 = (x) => Math.round(x * 100) / 100;
const TYPE_ICON = { text: "T", shape: "■", image: "▣", video: "▶", group: "○", component: "⚙" };
const FIELD_NUM = { fontSize: [1, 1], tracking: [0.5, 1], strokeWidth: [0.5, 0.5], radius: [1, 0.5], reveal: [0.01, 0.01],
    trimStart: [0.01, 0.01], trimEnd: [0.01, 0.01], opacity: [1, 1], rotation: [1, 1], scale: [1, 1] };
const GROUPS = {
    Transform: ["anchor", "position", "scale", "rotation", "opacity"],
    Appearance: ["size", "radius", "fill", "stroke", "strokeWidth", "fontSize", "tracking", "reveal", "trimStart", "trimEnd"],
};
const EASE_CHOICES = ["smooth", "linear", "hold", "easeIn", "easeOut", "easeInOut", "backOut", "expoOut"];

export function createMgEditor(host, opts = {}) {
    const doc = host.ownerDocument;
    const rootNode = host.getRootNode ? host.getRootNode() : doc;
    const o = Object.assign({ assetUrl: (s) => s, save: async () => {}, render: async () => ({ message: "no renderer" }), notify: () => {},
        onFrame: () => {}, onComp: () => {} }, opts);
    const st = {
        scene: null, path: "", sel: null, keys: [], frame: 0, playing: false, dirty: false, autokey: false,
        hist: new Mo.History(), clip: null, zoom: 1, curveAxis: 0, view: { s: 1, x: 0, y: 0 }, fit: true,
    };
    let dragging = null;
    let raf = 0;
    let phEl = null;          // the playhead of the timeline as last built (moved in place, never rebuilt per frame)
    let scrubbing = false;    // a playhead drag is on: nothing may rebuild the timeline under it
    let compSig = "";
    const videos = new Map();

    // -- skeleton ----------------------------------------------------------------------------
    if (!rootNode.querySelector || !rootNode.querySelector("style[data-mg]")) {
        const style = el(doc, "style"); style.setAttribute("data-mg", "1"); style.textContent = CSS;
        (rootNode.head || rootNode).appendChild(style);
    }
    host.replaceChildren();
    const root = el(doc, "div", "mg-root"); root.tabIndex = 0;
    const bar = el(doc, "div", "mg-bar");
    const main = el(doc, "div", "mg-main");
    const center = el(doc, "div", "mg-center");
    const stageWrap = el(doc, "div", "mg-stage-wrap");
    const stage = el(doc, "div", "mg-stage");
    const gizmo = svgEl(doc, "svg", { class: "mg-gizmo" });
    stageWrap.append(stage, gizmo);
    // The editor's own transport: only when nobody else owns time (the standalone page). Inside the viewer the
    // viewer's play / step / scrub bar is the transport.
    const hosted = !!o.transport;
    const transport = el(doc, "div", "mg-transport");
    center.append(stageWrap);
    if (!hosted) center.append(transport);
    const side = el(doc, "div", "mg-side");
    const tl = el(doc, "div", "mg-tl");
    if (o.split) {
        // Seated by the caller, each in a panel of its own; the keys must work there too.
        for (const part of [side, tl]) { part.classList.add("mg-part"); part.tabIndex = 0; }
        main.append(center);
        root.append(bar, main);
    } else {
        main.append(center, side);
        root.append(bar, main, tl);
    }
    host.append(root);

    const btn = (label, title, fn, cls = "") => {
        const b = el(doc, "button", "mg-btn " + cls, label); b.title = title; b.onclick = fn; return b;
    };

    // -- helpers -------------------------------------------------------------------------------
    const scene = () => st.scene;
    const layer = () => (st.scene && st.sel ? Mo.layerOf(st.scene, st.sel) : null);
    const comp = () => st.scene.comp;
    const dur = () => comp().duration;
    const resolved = () => S.evaluateScene(st.scene, st.frame);
    const toast = (m, sev) => { try { o.notify(m, sev); } catch (_) { /* host has no toasts */ } };

    function mutate(fn, { coalesce = false } = {}) {
        if (!st.scene) return;
        if (!coalesce) st.hist.push(st.scene);
        fn();
        st.dirty = true;
        refresh();
    }
    function refresh(parts) {
        if (!st.scene) return;
        const all = !parts;
        if (all || parts.includes("bar")) renderBar();
        if (all || parts.includes("stage")) renderStage();
        if (all || parts.includes("transport")) renderTransport();
        if (all || parts.includes("props")) renderProps();
        if (all || parts.includes("timeline")) renderTimeline();
        if (all || parts.includes("gizmo")) renderGizmo();
        compChanged();
    }
    /** The composition's length / frame rate / size moved (an edit, undo, load): the host's bar follows. */
    function compChanged() {
        const c = st.scene && st.scene.comp;
        const sig = c ? `${c.duration}|${c.fps}|${c.width}|${c.height}` : "";
        if (sig === compSig) return;
        compSig = sig;
        if (c && st.frame > c.duration - 1) st.frame = Math.max(0, c.duration - 1);
        try { o.onComp(c); } catch (_) { /* host has no bar */ }
    }

    // -- toolbar -----------------------------------------------------------------------------
    function renderBar() {
        bar.replaceChildren();
        const title = el(doc, "span", "mg-title", (st.path ? st.path.split(/[\\/]/).pop() : "no scene") + (st.dirty ? " •" : ""));
        title.title = st.path;
        const undo = btn("↶", "Undo (Ctrl+Z)", () => undo_());
        undo.disabled = !st.hist.canUndo;
        const redo = btn("↷", "Redo (Ctrl+Y)", () => redo_());
        redo.disabled = !st.hist.canRedo;
        bar.append(title, btn("Save", "Save the scene file (Ctrl+S)", () => save()), undo, redo, el(doc, "span", "mg-sep"));
        const c = st.scene.comp;
        bar.append(el(doc, "span", "mg-info", `${c.width}×${c.height} · ${c.fps} fps · ${c.duration} f`), el(doc, "span", "mg-sep"),
            btn("Auto-key", "On: changing a value that is not animated yet starts its animation (a key at the playhead)",
                () => { st.autokey = !st.autokey; renderBar(); }, st.autokey ? "on" : ""),
            btn("Fit", "Fit the picture to the panel", () => { st.fit = true; layoutStage(); }),
            el(doc, "span", "mg-sep"),
            btn("Render", "Render the scene to a video with agentY's renderer", () => doRender()));
    }

    function addLayer(kind) {
        mutate(() => {
            const type = kind === "rect" || kind === "ellipse" ? "shape" : kind;
            const l = Mo.makeLayer(st.scene, type, kind === "ellipse" ? { shape: "ellipse", size: [300, 300] } : {});
            l.in = undefined; delete l.in;
            Mo.addLayer(st.scene, l);
            st.sel = l.id; st.keys = [];
        });
    }
    function moveSel(d) { if (st.sel) mutate(() => Mo.moveLayer(st.scene, st.sel, d)); }
    function dupSel() { if (st.sel) mutate(() => { const c = Mo.duplicateLayer(st.scene, st.sel); if (c) st.sel = c.id; }); }
    function delSel() { if (st.sel) mutate(() => { Mo.removeLayer(st.scene, st.sel); st.sel = null; st.keys = []; }); }
    function undo_() { const s = st.hist.undo(st.scene); if (s) { st.scene = s; st.dirty = true; fixSel(); refresh(); } }
    function redo_() { const s = st.hist.redo(st.scene); if (s) { st.scene = s; st.dirty = true; fixSel(); refresh(); } }
    function fixSel() { if (st.sel && !Mo.layerOf(st.scene, st.sel)) st.sel = null; st.keys = st.keys.filter((k) => Mo.layerOf(st.scene, k.id)); }
    async function save() {
        if (!st.path) { toast("This scene has no file yet.", "warn"); return false; }
        const v = S.validateScene(st.scene);
        if (!v.ok) { toast("Not saved: " + v.errors[0].message, "error"); return false; }
        try { await o.save(st.path, st.scene); st.dirty = false; renderBar(); toast("Saved " + st.path.split(/[\\/]/).pop(), "success"); return true; }
        catch (e) { toast("Save failed: " + (e.message || e), "error"); return false; }
    }
    async function doRender() {
        if (st.dirty && !(await save())) return;
        try { const r = await o.render(st.path, st.scene); toast((r && r.message) || "Render requested", "info"); }
        catch (e) { toast("Render failed: " + (e.message || e), "error"); }
    }

    // -- layers: the timeline's left column is the layer list (see renderTimeline) ----------------------------
    function parentDepth(l) {
        let d = 0, cur = l;
        while (cur && cur.parent && d < 20) { cur = Mo.layerOf(st.scene, cur.parent); d++; }
        return d;
    }
    function select(id) {
        if (id === st.sel && !st.keys.length) return;
        st.sel = id; st.keys = [];
        refresh(["props", "timeline", "gizmo"]);
    }
    function renameLayer(l, nameEl) {
        const inp = el(doc, "input", "mg-rename"); inp.type = "text"; inp.value = l.name || l.id;
        nameEl.replaceWith(inp);
        inp.focus(); inp.select();
        let done = false;
        const finish = (commit) => {
            if (done) return; done = true;
            const v = inp.value.trim();
            if (commit && v && v !== (l.name || l.id)) mutate(() => { l.name = v; }); else refresh(["timeline"]);
        };
        inp.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        });
        inp.addEventListener("blur", () => finish(true));
        for (const t of ["pointerdown", "click", "dblclick"]) inp.addEventListener(t, (e) => e.stopPropagation());
    }
    /** Drag a layer row to a new place in the stack (the pointer stays on `tl`: nothing is rebuilt until the drop). */
    function reorderDrag(e, l, rowEl) {
        const rows = () => [...inner_().querySelectorAll(".mg-layer-row")];
        const n = st.scene.layers.length;
        const from = rows().indexOf(rowEl);
        if (from < 0 || n < 2) return;
        const y0 = e.clientY; let moving = false, to = from, line = null;
        const target = (y) => {
            const rs = rows();
            for (let i = 0; i < rs.length; i++) { const r = rs[i].getBoundingClientRect(); if (y < r.bottom) return i; }
            return rs.length - 1;
        };
        const onMove = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            if (!moving) {
                if (Math.abs(ev.clientY - y0) < 4) return;
                moving = true; scrubbing = true;
                try { tl.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
                rowEl.classList.add("mg-drag-src");
                line = el(doc, "div", "mg-dropline"); inner_().append(line);
            }
            to = clamp(target(ev.clientY), 0, rows().length - 1);
            const rs = rows(), r = rs[to].getBoundingClientRect(), ir = inner_().getBoundingClientRect();
            line.style.top = (to <= from ? r.top : r.bottom) - ir.top - 1 + "px";
        };
        const onUp = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            tl.removeEventListener("pointermove", onMove);
            tl.removeEventListener("pointerup", onUp);
            tl.removeEventListener("pointercancel", onUp);
            try { tl.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
            scrubbing = false;
            if (!moving) return;
            suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
            if (ev.type === "pointercancel" || to === from) { refresh(["timeline"]); return; }
            // the list shows the top layer first: display row i is layers[n-1-i], so moving up the list is +index
            mutate(() => { Mo.moveLayer(st.scene, l.id, from - to); });
        };
        tl.addEventListener("pointermove", onMove);
        tl.addEventListener("pointerup", onUp);
        tl.addEventListener("pointercancel", onUp);
    }
    let suppressClick = false;
    const inner_ = () => tl.querySelector(".mg-tl-in");

    let ctxAway = null;
    function closeCtx() {
        for (const m of tl.querySelectorAll(".mg-ctx")) m.remove();
        if (ctxAway) { doc.removeEventListener("pointerdown", ctxAway, true); ctxAway = null; }
    }
    /** A small menu at the pointer (inside the timeline panel): items are [label, fn] or "-". */
    function showMenu(e, items) {
        closeCtx();
        const m = el(doc, "div", "mg-ctx");
        for (const it of items) {
            if (it === "-") { m.append(el(doc, "hr")); continue; }
            const d = el(doc, "div", "", it[0]);
            d.onclick = (ev) => { ev.stopPropagation(); closeCtx(); it[1](); };
            m.append(d);
        }
        const r = tl.getBoundingClientRect();
        m.style.left = Math.min(e.clientX - r.left + tl.scrollLeft, tl.scrollLeft + Math.max(0, tl.clientWidth - 160)) + "px";
        m.style.top = Math.min(e.clientY - r.top + tl.scrollTop, tl.scrollTop + Math.max(0, tl.clientHeight - 24 * items.length)) + "px";
        for (const t of ["pointerdown", "click", "dblclick"]) m.addEventListener(t, (ev) => ev.stopPropagation());
        tl.append(m);
        // (the panel lives in a shadow root: the event is retargeted to its host here, so ask the path)
        ctxAway = (ev) => { if (!ev.composedPath().includes(m)) closeCtx(); };
        doc.addEventListener("pointerdown", ctxAway, true);
    }
    const ADD_KINDS = [["text", "Text"], ["rect", "Rectangle"], ["ellipse", "Ellipse"], ["group", "Group"]];
    function addItems() { return ADD_KINDS.map(([k, label]) => ["Add " + label, () => addLayer(k)]); }
    function layerItems(l) {
        return [["Rename", () => { select(l.id); const n = tl.querySelector(`.mg-layer-row[data-layer="${CSS_escape(l.id)}"] .mg-name`); if (n) renameLayer(l, n); }],
            ["Duplicate", () => { select(l.id); dupSel(); }],
            ["Move up", () => { select(l.id); moveSel(1); }],
            ["Move down", () => { select(l.id); moveSel(-1); }],
            ["Delete", () => { select(l.id); delSel(); }],
            "-", ...addItems()];
    }

    // -- stage ---------------------------------------------------------------------------------------
    function ctxFor() { return { width: comp().width, height: comp().height, assetUrl: (_id, a) => o.assetUrl(a.src) }; }
    function ensureFonts() {
        const css = S.fontFaceCss(st.scene, (_id, a) => o.assetUrl(a.src));
        let tag = stage.querySelector("style[data-mgfonts]");
        if (css && !tag) { tag = el(doc, "style"); tag.setAttribute("data-mgfonts", "1"); }
        if (tag) { tag.textContent = css; }
        return tag;
    }
    function renderStage() {
        const c = comp();
        stage.style.width = c.width + "px"; stage.style.height = c.height + "px";
        stage.style.background = c.background || "repeating-conic-gradient(#222 0 25%, #2a2a2a 0 50%) 0 0/24px 24px";
        const ctx = ctxFor();
        const nodes = [];
        const fonts = ensureFonts();
        if (fonts) nodes.push(fonts);
        const seen = new Set();
        for (const res of resolved()) {
            if (!res.active) continue;
            if (S.isSvgLayer(res.type)) {
                const svg = S.layerSvg(st.scene, res, ctx);
                if (!svg) continue;
                const d = el(doc, "div"); d.dataset.layer = res.id; d.innerHTML = svg;
                nodes.push(d);
            } else if (res.type === "video" && res.opacity > 0) {
                nodes.push(videoNode(res)); seen.add(res.id);
            } else if (res.type === "component" && res.opacity > 0) {
                const d = el(doc, "div", "mg-vid", res.layer.component || "component");
                Object.assign(d.style, S.htmlLayerStyle(res), { width: res.props.size[0] + "px", height: res.props.size[1] + "px" });
                nodes.push(d);
            }
        }
        for (const [id, v] of videos) if (!seen.has(id)) { v.remove(); videos.delete(id); }
        stage.replaceChildren(...nodes);
        layoutStage();
    }
    function videoNode(res) {
        let v = videos.get(res.id);
        const a = st.scene.assets[res.layer.asset];
        if (!v) {
            v = el(doc, "video"); v.muted = true; v.preload = "auto"; v.playsInline = true;
            v.src = o.assetUrl(a.src); videos.set(res.id, v);
        }
        const wrap = el(doc, "div");
        Object.assign(v.style, S.htmlLayerStyle(res), { width: res.props.size[0] + "px", height: res.props.size[1] + "px",
            objectFit: { contain: "contain", cover: "cover", fill: "fill" }[res.layer.fit || "cover"] });
        v.style.position = "absolute";
        const t = (st.frame - (res.layer.in || 0) + (res.layer.startFrom || 0)) / comp().fps;
        try { if (Math.abs(v.currentTime - t) > 0.02) v.currentTime = Math.max(0, t); } catch (_) { /* not loaded yet */ }
        wrap.append(v);
        wrap.style.cssText = "position:absolute;left:0;top:0;width:0;height:0";
        return wrap;
    }
    function layoutStage() {
        const c = comp();
        const w = stageWrap.clientWidth || 600, h = stageWrap.clientHeight || 340;
        if (st.fit) {
            const s = Math.min((w - 24) / c.width, (h - 24) / c.height);
            st.view = { s: s > 0 ? s : 0.1, x: (w - c.width * s) / 2, y: (h - c.height * s) / 2 };
        }
        const t = `translate(${st.view.x}px,${st.view.y}px) scale(${st.view.s})`;
        stage.style.transform = t;
        gizmo.style.transform = t;
        gizmo.setAttribute("width", c.width); gizmo.setAttribute("height", c.height);
        gizmo.style.width = c.width + "px"; gizmo.style.height = c.height + "px";
    }
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { if (st.scene) { layoutStage(); renderTimeline(); } }) : null;
    if (ro) { ro.observe(stageWrap); ro.observe(tl); }

    // stage-space point from a pointer event
    function stagePoint(e) {
        const r = stageWrap.getBoundingClientRect();
        return [(e.clientX - r.left - st.view.x) / st.view.s, (e.clientY - r.top - st.view.y) / st.view.s];
    }
    stageWrap.addEventListener("wheel", (e) => {
        e.preventDefault();
        st.fit = false;
        const r = stageWrap.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const ns = clamp(st.view.s * k, 0.05, 8);
        st.view.x = px - (px - st.view.x) * (ns / st.view.s);
        st.view.y = py - (py - st.view.y) * (ns / st.view.s);
        st.view.s = ns;
        layoutStage();
    }, { passive: false });

    // measured local box of a layer (text is measured by the browser), else the shared estimate
    function boxOf(res) {
        if (res.type === "text") {
            const g = stage.querySelector(`[data-layer="${CSS_escape(res.id)}"] svg > g`);
            try {
                const b = g && g.getBBox();
                if (b && b.width > 0) return [b.x, b.y, b.width, b.height];
            } catch (_) { /* not rendered */ }
        }
        return S.localBox(res);
    }
    const CSS_escape = (s) => (doc.defaultView.CSS && doc.defaultView.CSS.escape ? doc.defaultView.CSS.escape(s) : String(s).replace(/"/g, '\\"'));

    function hit(pt) {
        const list = resolved();
        for (let i = list.length - 1; i >= 0; i--) {
            const res = list[i];
            if (!res.active || res.layer.locked || res.type === "group") continue;
            const inv = S.matInvert(res.world);
            const b = boxOf(res);
            if (!inv || !b) continue;
            const [x, y] = S.matApply(inv, pt[0], pt[1]);
            if (x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]) return res.id;
        }
        return null;
    }

    // -- gizmo ---------------------------------------------------------------------------------------------
    function renderGizmo() {
        gizmo.replaceChildren();
        const l = layer();
        if (!l || l.locked || !S.PROPS_BY_TYPE[l.type]) return;
        const list = resolved();
        const res = list.find((r) => r.id === l.id);
        if (!res || !res.active) return;
        const k = 1 / st.view.s;
        const add = (tag, a) => { const n = svgEl(doc, tag, a); gizmo.append(n); return n; };
        const b = boxOf(res);
        const W = (x, y) => S.matApply(res.world, x, y);
        if (b) {
            const pts = [W(b[0], b[1]), W(b[0] + b[2], b[1]), W(b[0] + b[2], b[1] + b[3]), W(b[0], b[1] + b[3])];
            add("polygon", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: "#4da3ff", "stroke-width": 1.5 * k });
            pts.forEach((p, i) => add("rect", { x: p[0] - 5 * k, y: p[1] - 5 * k, width: 10 * k, height: 10 * k, fill: "#fff", stroke: "#4da3ff",
                "stroke-width": k, "data-h": "scale" + i, style: "pointer-events:all;cursor:nwse-resize" }));
            const top = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
            const dir = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
            const len = Math.hypot(dir[0], dir[1]) || 1;
            const nrm = [dir[1] / len, -dir[0] / len];
            const rp = [top[0] + nrm[0] * 28 * k, top[1] + nrm[1] * 28 * k];
            add("line", { x1: top[0], y1: top[1], x2: rp[0], y2: rp[1], stroke: "#4da3ff", "stroke-width": k });
            add("circle", { cx: rp[0], cy: rp[1], r: 6 * k, fill: "#4da3ff", "data-h": "rotate", style: "pointer-events:all;cursor:grab" });
            // the move target: the box itself
            add("polygon", { points: pts.map((p) => p.join(",")).join(" "), fill: "rgba(77,163,255,0.001)", "data-h": "move", style: "pointer-events:all;cursor:move" });
            // handles after the move area so they stay on top
            gizmo.querySelectorAll("[data-h^=scale],[data-h=rotate]").forEach((n) => gizmo.append(n));
        }
        const anchorW = S.matApply(res.world, res.props.anchor[0], res.props.anchor[1]);
        add("circle", { cx: anchorW[0], cy: anchorW[1], r: 5 * k, fill: "none", stroke: "#ff3b3b", "stroke-width": 1.5 * k, "data-h": "anchor", style: "pointer-events:all;cursor:crosshair" });
        add("line", { x1: anchorW[0] - 9 * k, y1: anchorW[1], x2: anchorW[0] + 9 * k, y2: anchorW[1], stroke: "#ff3b3b", "stroke-width": k });
        add("line", { x1: anchorW[0], y1: anchorW[1] - 9 * k, x2: anchorW[0], y2: anchorW[1] + 9 * k, stroke: "#ff3b3b", "stroke-width": k });
    }

    // Writing a value from the preview: static when not animated; a key when animated; a first key when Auto-key is on.
    function writeProp(l, prop, value) {
        if (!Mo.isAnimated(l, prop) && st.autokey) Mo.toggleAnimated(st.scene, l, prop, st.frame);
        Mo.setProp(st.scene, l, prop, value, st.frame);
    }
    function parentLinear(res) {
        const parent = res.layer.parent && resolved().find((r) => r.id === res.layer.parent);
        return parent ? parent.world : S.IDENTITY;
    }

    stageWrap.addEventListener("pointerdown", (e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) {          // pan
            st.fit = false;
            dragging = { kind: "pan", x: e.clientX, y: e.clientY, v: { ...st.view } };
            stageWrap.setPointerCapture(e.pointerId); e.preventDefault(); return;
        }
        if (e.button !== 0) return;
        const h = e.target && e.target.getAttribute ? e.target.getAttribute("data-h") : null;
        const pt = stagePoint(e);
        let l = layer();
        if (!h) {
            const id = hit(pt);
            if (!id) { if (st.sel) select(null); return; }
            if (id !== st.sel) select(id);
            l = layer();
        }
        if (!l || l.locked) return;
        const res = resolved().find((r) => r.id === l.id);
        const kind = h || "move";
        st.hist.push(st.scene);
        const pw = parentLinear(res);
        const anchorW = S.matApply(res.world, res.props.anchor[0], res.props.anchor[1]);
        dragging = {
            kind, start: pt, res, l, pw, pos: res.props.position.slice(), scale: res.props.scale.slice(), rot: res.props.rotation,
            anchor: res.props.anchor.slice(), anchorW,
            r0: Math.hypot(pt[0] - anchorW[0], pt[1] - anchorW[1]) || 1,
            a0: Math.atan2(pt[1] - anchorW[1], pt[0] - anchorW[0]),
        };
        stageWrap.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    stageWrap.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        if (dragging.kind === "pan") {
            st.view.x = dragging.v.x + e.clientX - dragging.x; st.view.y = dragging.v.y + e.clientY - dragging.y;
            layoutStage(); return;
        }
        const d = dragging, pt = stagePoint(e), l = d.l;
        if (d.kind === "move") {
            const inv = S.matInvert([d.pw[0], d.pw[1], d.pw[2], d.pw[3], 0, 0]);
            const dx = pt[0] - d.start[0], dy = pt[1] - d.start[1];
            const local = inv ? [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy] : [dx, dy];
            let nx = d.pos[0] + local[0], ny = d.pos[1] + local[1];
            if (e.shiftKey) { if (Math.abs(local[0]) > Math.abs(local[1])) ny = d.pos[1]; else nx = d.pos[0]; }
            writeProp(l, "position", [round2(nx), round2(ny)]);
        } else if (d.kind.startsWith("scale")) {
            const r = Math.hypot(pt[0] - d.anchorW[0], pt[1] - d.anchorW[1]) / d.r0;
            const sc = e.shiftKey ? [d.scale[0] * r, d.scale[1] * r] : [d.scale[0] * r, d.scale[1] * r];
            writeProp(l, "scale", sc.map(round2));
        } else if (d.kind === "rotate") {
            const a = Math.atan2(pt[1] - d.anchorW[1], pt[0] - d.anchorW[0]);
            let deg = d.rot + ((a - d.a0) * 180) / Math.PI;
            if (e.shiftKey) deg = Math.round(deg / 15) * 15;
            writeProp(l, "rotation", round2(deg));
        } else if (d.kind === "anchor") {
            // The pointer in the layer's own space is the new anchor; the position follows so the layer stays put.
            const inv = S.matInvert(d.res.world);
            const loc = inv ? S.matApply(inv, pt[0], pt[1]) : d.anchor;
            const na = [round2(loc[0]), round2(loc[1])];
            const m0 = S.localMatrix(d.pos, d.rot, d.scale, d.anchor);
            const np = S.matApply(m0, na[0], na[1]);
            writeProp(l, "anchor", na);
            writeProp(l, "position", [round2(np[0]), round2(np[1])]);
        }
        st.dirty = true;
        refresh(["bar", "stage", "props", "timeline", "gizmo"]);
    });
    const endDrag = () => { dragging = null; };
    stageWrap.addEventListener("pointerup", endDrag);
    stageWrap.addEventListener("pointercancel", endDrag);

    // -- transport -----------------------------------------------------------------------------------------------
    // Only the standalone page has one (see `hosted`); in the viewer the viewer's own bar plays, steps and scrubs.
    function renderTransport() {
        if (hosted) return;
        transport.replaceChildren();
        const c = comp();
        const play = btn(st.playing ? "⏸" : "▶", "Play / pause (Space)", () => togglePlay());
        const rew = btn("⏮", "To the start (Home)", () => setFrame(0));
        const fr = el(doc, "input"); fr.type = "number"; fr.value = st.frame; fr.min = 0; fr.max = c.duration - 1;
        fr.title = "Current frame";
        fr.onchange = () => setFrame(parseInt(fr.value, 10) || 0);
        const secs = el(doc, "span", "", `/ ${c.duration - 1}   ${(st.frame / c.fps).toFixed(2)}s @ ${c.fps}fps   ${c.width}×${c.height}`);
        const len = el(doc, "input"); len.type = "number"; len.value = c.duration; len.title = "Length of the composition in frames";
        len.onchange = () => mutate(() => Mo.setDuration(st.scene, parseInt(len.value, 10) || c.duration));
        const lab = el(doc, "span", "", "Length");
        transport.append(rew, play, fr, secs, el(doc, "span", "mg-sep"), lab, len);
    }
    /**
     * Put the playhead on frame `f`. Only the picture, the gizmo, the properties and the playhead move: the timeline is
     * NOT rebuilt (a rebuild per frame is what used to cut a scrub short). `live` skips the properties (playing, dragging);
     * `fromHost` means the host's bar already knows (it asked), so it is not told again.
     */
    function setFrame(f, { keepPlaying = false, live = false, fromHost = false } = {}) {
        if (!st.scene) return;
        const nf = clamp(Math.round(Number(f) || 0), 0, dur() - 1);
        const moved = nf !== st.frame;
        st.frame = nf;
        if (!hosted && !keepPlaying && st.playing) togglePlay();
        refresh(live ? ["stage", "transport", "gizmo"] : ["stage", "transport", "props", "gizmo"]);
        movePlayhead();
        if (!fromHost && (moved || hosted)) { try { o.onFrame(nf); } catch (_) { /* host has no bar */ } }
    }
    function togglePlay() {
        if (hosted) { o.transport.toggle(); return; }
        st.playing = !st.playing;
        for (const v of videos.values()) { try { v.pause(); } catch (_) { /* */ } }
        if (st.playing) {
            const t0 = performance.now(), f0 = st.frame >= dur() - 1 ? 0 : st.frame;
            const tick = (t) => {
                if (!st.playing) return;
                const f = f0 + Math.floor(((t - t0) / 1000) * comp().fps);
                st.frame = f % dur();
                refresh(["stage", "transport", "gizmo"]);
                movePlayhead(true);
                raf = requestAnimationFrame(tick);
            };
            raf = requestAnimationFrame(tick);
        } else cancelAnimationFrame(raf);
        renderTransport();
    }

    // -- properties ---------------------------------------------------------------------------------------------------
    function propRow(l, prop) {
        const def = S.PROPS[prop];
        const animated = Mo.isAnimated(l, prop);
        const row = el(doc, "div", "mg-prop");
        const sw = el(doc, "span", "mg-sw" + (animated ? " on" : ""), "⏱");
        sw.title = animated ? "Animated: click to stop animating (keeps the value at the playhead)" : "Click to animate (a key at the playhead)";
        sw.onclick = () => mutate(() => { Mo.toggleAnimated(st.scene, l, prop, st.frame); });
        row.append(sw, el(doc, "label", "", prop));
        const cur = S.evaluateLayer(st.scene, l, st.frame)[prop];
        const commit = (v) => { mutate(() => writeProp(l, prop, v), { coalesce: false }); };
        if (def.kind === "num") {
            const i = el(doc, "input"); i.type = "number"; i.step = (FIELD_NUM[prop] || [1])[1] ?? 1; i.value = round2(cur);
            if (def.min !== undefined) i.min = def.min; if (def.max !== undefined) i.max = def.max;
            i.onchange = () => { const v = parseFloat(i.value); if (Number.isFinite(v)) commit(v); };
            row.append(i);
        } else if (def.kind === "vec2") {
            for (let a = 0; a < 2; a++) {
                const i = el(doc, "input"); i.type = "number"; i.step = 1; i.value = round2(cur[a]);
                i.onchange = () => { const v = parseFloat(i.value); if (Number.isFinite(v)) { const n = cur.slice(); n[a] = v; commit(n); } };
                row.append(i);
            }
        } else if (def.kind === "color") {
            const i = el(doc, "input"); i.type = "color";
            const parsed = cur ? S.parseColor(cur) : null;
            i.value = parsed ? S.formatColor([parsed[0], parsed[1], parsed[2], 1]) : "#000000";
            i.style.opacity = cur ? 1 : 0.3;
            i.onchange = () => commit(i.value);
            const none = el(doc, "span", "mg-sw", "∅"); none.title = "No " + prop;
            none.onclick = () => { if (!animated) mutate(() => { l[prop] = null; }); };
            row.append(i, none);
        }
        const key = el(doc, "span", "mg-key", animated ? (Mo.keyAt(l, prop, st.frame) ? "◆" : "◇") : "");
        key.title = "Key at the playhead (click to add or remove)";
        key.onclick = () => { if (!animated) return; mutate(() => { if (Mo.keyAt(l, prop, st.frame)) Mo.removeKey(l, prop, st.frame); else Mo.addKey(st.scene, l, prop, st.frame); }); };
        row.append(key);
        return row;
    }
    const field = (label, input) => { const r = el(doc, "div", "mg-prop"); r.append(el(doc, "label", "", label), input); return r; };
    function textInput(l, key, { area = false, type = "text", num = false } = {}) {
        const i = el(doc, area ? "textarea" : "input"); if (!area) i.type = num ? "number" : type;
        i.value = l[key] ?? "";
        i.onchange = () => mutate(() => {
            if (num) { const v = parseFloat(i.value); if (Number.isFinite(v)) l[key] = v; else delete l[key]; }
            else if (i.value === "") delete l[key]; else l[key] = i.value;
        });
        return i;
    }
    function selectInput(l, key, choices, dflt) {
        const s = el(doc, "select");
        for (const c of choices) s.append(new Option(c, c));
        s.value = l[key] ?? dflt;
        s.onchange = () => mutate(() => { if (s.value === dflt) delete l[key]; else l[key] = s.value; });
        return s;
    }
    function renderProps() {
        side.replaceChildren();
        const l = layer();
        if (!l) {
            const c = comp();
            side.append(el(doc, "h4", "", "Composition"));
            const bg = el(doc, "input"); bg.type = "color"; bg.value = c.background && S.parseColor(c.background) ? S.formatColor([...S.parseColor(c.background).slice(0, 3), 1]) : "#000000";
            bg.onchange = () => mutate(() => { c.background = bg.value; });
            side.append(field("background", bg));
            for (const [k, lo] of [["width", 16], ["height", 16], ["fps", 1]]) {
                const i = el(doc, "input"); i.type = "number"; i.value = c[k];
                i.onchange = () => mutate(() => { const v = parseInt(i.value, 10); if (v >= lo) c[k] = v; });
                side.append(field(k, i));
            }
            side.append(el(doc, "div", "mg-empty", "Select a layer to edit it."));
            return;
        }
        side.append(el(doc, "h4", "", `${l.name || l.id} — ${l.type}`));
        const allowed = S.PROPS_BY_TYPE[l.type];
        side.append(el(doc, "h4", "", "Transform"));
        for (const p of GROUPS.Transform) side.append(propRow(l, p));
        if (l.type === "text") {
            side.append(el(doc, "h4", "", "Text"));
            side.append(field("text", textInput(l, "text", { area: true })));
            side.append(field("font", textInput(l, "font")));
            side.append(field("weight", textInput(l, "weight", { num: true })));
            side.append(field("align", selectInput(l, "align", S.ALIGNS, "left")));
            side.append(field("lineHeight", textInput(l, "lineHeight", { num: true })));
        }
        if (l.type === "shape") {
            side.append(el(doc, "h4", "", "Shape"));
            side.append(field("shape", selectInput(l, "shape", S.SHAPES, "rect")));
            if ((l.shape || "rect") === "path") side.append(field("d", textInput(l, "d")));
        }
        if (l.type === "image" || l.type === "video") {
            side.append(el(doc, "h4", "", l.type));
            side.append(field("asset", selectInput(l, "asset", Object.keys(st.scene.assets).filter((k) => st.scene.assets[k].type === l.type), l.asset || "")));
            side.append(field("fit", selectInput(l, "fit", S.FITS, l.type === "video" ? "cover" : "contain")));
        }
        if (l.type === "component") {
            side.append(el(doc, "h4", "", "Component"));
            side.append(field("component", textInput(l, "component")));
            const params = el(doc, "textarea"); params.value = JSON.stringify(l.params || {}, null, 1);
            params.onchange = () => { try { const v = JSON.parse(params.value); mutate(() => { l.params = v; }); } catch (_) { toast("params must be JSON", "warn"); } };
            side.append(field("params", params));
        }
        side.append(el(doc, "h4", "", "Appearance"));
        for (const p of GROUPS.Appearance) if (allowed.includes(p)) side.append(propRow(l, p));
        side.append(el(doc, "h4", "", "Layer"));
        side.append(field("blend", selectInput(l, "blend", Object.keys(S.BLENDS), "normal")));
        side.append(field("in", textInput(l, "in", { num: true })));
        side.append(field("out", textInput(l, "out", { num: true })));
        const par = el(doc, "select");
        par.append(new Option("(none)", ""));
        for (const o2 of st.scene.layers) if (Mo.canParent(st.scene, l.id, o2.id) && o2.id !== l.id) par.append(new Option(o2.name || o2.id, o2.id));
        par.value = l.parent || "";
        par.onchange = () => mutate(() => { if (par.value) l.parent = par.value; else delete l.parent; });
        side.append(field("parent", par));
        if (["fill", "stroke"].some((p) => allowed.includes(p)) || true) side.append(renderCurve(l));
    }

    // -- the curve of the selected key ----------------------------------------------------------------------------------------
    function renderCurve(l) {
        const wrap = el(doc, "div", "mg-curve");
        const sel = st.keys.filter((k) => k.id === l.id);
        const last = sel[sel.length - 1];
        wrap.append(el(doc, "h4", "", "Curve"));
        if (!last) { wrap.append(el(doc, "div", "mg-empty", "Click a keyframe in the timeline to shape its easing.")); return wrap; }
        const keys = Mo.keyAt(l, last.prop, last.f) ? S.track(l, last.prop) : [];
        const key = Mo.keyAt(l, last.prop, last.f);
        if (!key) return wrap;
        const def = S.PROPS[last.prop];
        if (def.kind === "color") { wrap.append(el(doc, "div", "mg-empty", "Colours ease with the same curve; pick an ease:")); }
        const ease = el(doc, "select");
        for (const c of [...EASE_CHOICES, "custom"]) ease.append(new Option(c, c));
        ease.value = key.ti !== undefined || key.to !== undefined || Array.isArray(key.ease) ? "custom" : (key.ease || "smooth");
        ease.onchange = () => { if (ease.value !== "custom") mutate(() => { for (const k of sel) { const kk = Mo.keyAt(l, k.prop, k.f); if (kk) Mo.setEase(l, k.prop, k.f, ease.value); } }); };
        wrap.append(field("ease", ease));
        if (def.kind === "color") return wrap;
        const axes = def.kind === "vec2" ? 2 : 1;
        if (axes === 2) {
            const ax = el(doc, "select"); ax.append(new Option("x", "0"), new Option("y", "1")); ax.value = String(st.curveAxis);
            ax.onchange = () => { st.curveAxis = parseInt(ax.value, 10); renderProps(); };
            wrap.append(field("axis", ax));
        }
        const axis = axes === 2 ? st.curveAxis : 0;
        // graph over the whole track, a bit padded
        const f0 = keys[0].f, f1 = keys[keys.length - 1].f, span = Math.max(1, f1 - f0);
        const samples = [];
        const N = 96;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i <= N; i++) {
            const f = f0 + (span * i) / N;
            const v = S.valueAt(l, last.prop, f);
            const x = Array.isArray(v) ? v[axis] : v;
            samples.push([f, x]); lo = Math.min(lo, x); hi = Math.max(hi, x);
        }
        for (const k of keys) { const x = Array.isArray(k.v) ? k.v[axis] : k.v; lo = Math.min(lo, x); hi = Math.max(hi, x); }
        if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
        const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
        const W = 220, H = 120;
        const X = (f) => 8 + ((f - f0) / span) * (W - 16);
        const Y = (v) => H - 8 - ((v - lo) / (hi - lo)) * (H - 16);
        const iX = (x) => f0 + ((x - 8) / (W - 16)) * span;
        const iY = (y) => lo + ((H - 8 - y) / (H - 16)) * (hi - lo);
        const svg = svgEl(doc, "svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
        svg.append(svgEl(doc, "polyline", { points: samples.map((s) => `${X(s[0])},${Y(s[1])}`).join(" "), fill: "none", stroke: "#8fd0ff", "stroke-width": 1.5 }));
        const px = X(st.frame);
        if (st.frame >= f0 && st.frame <= f1) svg.append(svgEl(doc, "line", { x1: px, x2: px, y1: 0, y2: H, stroke: "#ff3b3b", "stroke-width": 0.8 }));
        const comp_ = (v) => (Array.isArray(v) ? v[axis] : v);
        keys.forEach((k, i) => {
            const isSel = k.f === last.f;
            svg.append(svgEl(doc, "circle", { cx: X(k.f), cy: Y(comp_(k.v)), r: isSel ? 4 : 3, fill: isSel ? "#fff" : AMBER, stroke: "#000", "stroke-width": 0.5 }));
            if (!isSel) return;
            for (const side_ of ["in", "out"]) {
                const nb = side_ === "in" ? keys[i - 1] : keys[i + 1];
                if (!nb) continue;
                const slope = S.tangentAt(l, last.prop, k.f, axis, side_);
                const dfr = (side_ === "in" ? -1 : 1) * Math.abs(nb.f - k.f) / 3;
                const hx = X(k.f + dfr), hy = Y(comp_(k.v) + slope * dfr);
                svg.append(svgEl(doc, "line", { x1: X(k.f), y1: Y(comp_(k.v)), x2: hx, y2: hy, stroke: "#aaa", "stroke-width": 0.8 }));
                const h = svgEl(doc, "circle", { cx: hx, cy: hy, r: 3.5, fill: "#4da3ff", stroke: "#000", "stroke-width": 0.5, style: "cursor:pointer" });
                h.onpointerdown = (e) => {
                    e.preventDefault(); h.setPointerCapture(e.pointerId); st.hist.push(st.scene);
                    const rect = svg.getBoundingClientRect();
                    h.onpointermove = (ev) => {
                        const x = ((ev.clientX - rect.left) / rect.width) * W, y = ((ev.clientY - rect.top) / rect.height) * H;
                        const df = iX(x) - k.f, dv = iY(y) - comp_(k.v);
                        if (Math.abs(df) < 1e-3) return;
                        Mo.setTangent(l, last.prop, k.f, axis, dv / df, { side: side_, broken: ev.altKey });
                        st.dirty = true; refresh(["bar", "stage", "gizmo", "timeline"]); ease.value = "custom";
                        renderCurveInto(wrap, l);
                    };
                    h.onpointerup = () => { h.onpointermove = null; renderProps(); };
                };
                svg.append(h);
            }
        });
        wrap.append(svg);
        wrap.append(el(doc, "div", "mg-empty", "Drag a blue handle to shape the curve (Alt breaks the pair). Choosing an ease resets the handles."));
        return wrap;
    }
    function renderCurveInto(wrap, l) {
        const fresh = renderCurve(l);
        wrap.replaceWith(fresh);
    }

    // -- timeline -----------------------------------------------------------------------------------------------------------------
    function ppf() {
        const avail = Math.max(200, tl.clientWidth - LABEL_W - 20);
        return (avail / Math.max(1, dur())) * st.zoom;
    }
    /** Move the playhead (line and ruler grip) to the current frame without rebuilding the timeline. */
    function movePlayhead(follow = false) {
        if (!phEl || !st.scene) return;
        const k = ppf();
        phEl.style.left = LABEL_W + st.frame * k + "px";
        if (phEl._grip) phEl._grip.style.left = st.frame * k + "px";
        if (follow && !scrubbing) {            // playing a zoomed timeline: keep the playhead on screen
            const x = LABEL_W + st.frame * k;
            if (x > tl.scrollLeft + tl.clientWidth - 12 || x < tl.scrollLeft + LABEL_W) tl.scrollLeft = Math.max(0, x - LABEL_W - 40);
        }
    }
    /**
     * Scrub: drag the playhead along the timeline. The pointer is captured by `tl` - the one element that is never
     * replaced - and the frame is read off tl's own box, so nothing that rebuilds the rows (a selection, an edit, the
     * resize observer) can detach the drag. `grab` is how far inside the playhead the pointer took hold of it.
     */
    function startScrub(e, grab = 0) {
        if (e.button !== undefined && e.button !== 0) return;
        scrubbing = true;
        const at = (ev) => {
            const r = tl.getBoundingClientRect();
            return (ev.clientX - r.left - tl.clientLeft - LABEL_W + tl.scrollLeft - grab) / ppf();
        };
        try { tl.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
        setFrame(at(e), { live: true });
        const onMove = (ev) => { if (ev.pointerId === e.pointerId) setFrame(at(ev), { live: true }); };
        const onUp = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            tl.removeEventListener("pointermove", onMove);
            tl.removeEventListener("pointerup", onUp);
            tl.removeEventListener("pointercancel", onUp);
            tl.removeEventListener("lostpointercapture", onUp);
            try { tl.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
            scrubbing = false;
            refresh(["props", "timeline"]);
        };
        tl.addEventListener("pointermove", onMove);
        tl.addEventListener("pointerup", onUp);
        tl.addEventListener("pointercancel", onUp);
        tl.addEventListener("lostpointercapture", onUp);
    }
    function renderTimeline() {
        if (!st.scene) return;
        // A drag that holds the pointer (scrub, reorder) must not lose its rows; it asks for a rebuild when it is over.
        if (scrubbing) return;
        const keepL = tl.scrollLeft, keepT = tl.scrollTop;
        tl.replaceChildren();
        const k = ppf(), total = dur() * k;
        const inner = el(doc, "div", "mg-tl-in");
        inner.style.width = LABEL_W + total + 20 + "px";
        const row = (label, cls = "", sub = false) => {
            const r = el(doc, "div", "mg-trow " + cls);
            const lab = el(doc, "div", "mg-tlabel" + (sub ? " sub" : ""));
            if (label instanceof Node) lab.append(label); else if (label) lab.textContent = label;
            const track_ = el(doc, "div", "mg-ttrack"); track_.style.width = total + "px";
            r.append(lab, track_); inner.append(r);
            return { r, lab, track: track_ };
        };
        // ruler: the layer actions on the left, the frames (click or drag anywhere in them to move time) on the right
        const ruler = row("", "mg-ruler");
        const step = [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * k >= 42) || 240;
        for (let f = 0; f <= dur(); f += step) {
            const t = el(doc, "div", "mg-tick", String(f)); t.style.left = f * k + "px"; ruler.track.append(t);
        }
        const act = (label, title, fn) => { const b = btn(label, title, fn); b.onpointerdown = (e) => e.stopPropagation(); return b; };
        ruler.lab.append(
            act("+", "Add a layer (Text, Rectangle, Ellipse, Group)", (e) => showMenu(e, addItems())),
            act("\u29C9", "Duplicate the layer", () => dupSel()),
            act("\u25B2", "Move the layer up (drawn later)", () => moveSel(1)),
            act("\u25BC", "Move the layer down", () => moveSel(-1)),
            act("\u2715", "Delete the layer (Delete)", () => delSel()));
        ruler.lab.oncontextmenu = (e) => { e.preventDefault(); showMenu(e, addItems()); };
        ruler.track.onpointerdown = (e) => startScrub(e);
        // the playhead: a line over the rows, and its grip in the ruler (the part to take hold of)
        const ph = el(doc, "div", "mg-playhead"); ph.style.left = LABEL_W + st.frame * k + "px";
        const grip = el(doc, "div", "mg-ph-grip"); grip.style.left = st.frame * k + "px"; grip.title = "Drag to move time";
        grip.onpointerdown = (e) => {
            e.stopPropagation();
            const r = tl.getBoundingClientRect();
            startScrub(e, e.clientX - (r.left + tl.clientLeft + LABEL_W - tl.scrollLeft + st.frame * ppf()));
        };
        ruler.track.append(grip);
        ph._grip = grip; phEl = ph;
        const scrubOnTrack = (track_, id) => {
            track_.onpointerdown = (e) => {
                if (e.button !== 0 || e.target.closest(".mg-dia")) return;
                if (id && id !== st.sel) select(id);
                startScrub(e);
            };
        };
        const layers = st.scene.layers;
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            const r = row("", "mg-layer-row" + (l.id === st.sel ? " sel" : "") + (l.hidden ? " mg-hidden" : ""));
            r.r.dataset.layer = l.id;
            const lab = r.lab;
            lab.style.paddingLeft = 4 + parentDepth(l) * 10 + "px";
            const eye = el(doc, "span", "mg-ic mg-eye" + (l.hidden ? "" : " on"), l.hidden ? "\u25CB" : "\u25CF");
            eye.title = "Show / hide";
            const lock = el(doc, "span", "mg-ic mg-lock" + (l.locked ? " on" : ""), l.locked ? "\u{1F512}" : "\u{1F513}");
            lock.title = "Lock (the preview cannot select or move it)";
            for (const ic of [eye, lock]) ic.onpointerdown = (e) => e.stopPropagation();
            eye.onclick = (e) => { e.stopPropagation(); mutate(() => { if (l.hidden) delete l.hidden; else l.hidden = true; }); };
            lock.onclick = (e) => { e.stopPropagation(); mutate(() => { if (l.locked) delete l.locked; else l.locked = true; }); };
            const name = el(doc, "span", "mg-name", l.name || l.id);
            lab.title = `${l.id} (${l.type}) - click to select, double-click to rename, drag to reorder, right-click for more`;
            lab.append(eye, lock, el(doc, "span", "mg-type", TYPE_ICON[l.type] || "?"), name);
            lab.onclick = (e) => { if (suppressClick || e.target.closest(".mg-ic,input")) return; closeCtx(); select(l.id); };
            lab.ondblclick = (e) => { if (e.target.closest(".mg-ic,input")) return; renameLayer(l, lab.querySelector(".mg-name")); };
            lab.onpointerdown = (e) => { if (e.button === 0 && !e.target.closest(".mg-ic,input")) reorderDrag(e, l, r.r); };
            lab.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); select(l.id); showMenu(e, layerItems(l)); };
            scrubOnTrack(r.track, l.id);
            const a = l.in ?? 0, b = l.out ?? dur();
            const range = el(doc, "div", "mg-bar-range"); range.style.left = a * k + "px"; range.style.width = Math.max(2, (b - a) * k) + "px";
            r.track.append(range);
            const frames = new Set();
            for (const t of Object.values(l.tracks || {})) for (const kk of t) frames.add(kk.f);
            if (l.id !== st.sel) for (const f of frames) { const d = el(doc, "div", "mg-dia agg"); d.style.left = f * k + "px"; r.track.append(d); }
            if (l.id === st.sel) {
                for (const prop of Mo.animatedProps(l)) {
                    const pr = row(prop, "", true);
                    scrubOnTrack(pr.track, null);
                    for (const kk of S.track(l, prop)) {
                        const on = st.keys.some((s) => s.id === l.id && s.prop === prop && s.f === kk.f);
                        const d = el(doc, "div", "mg-dia" + (on ? " sel" : "")); d.style.left = kk.f * k + "px";
                        d.title = `${prop} @ ${kk.f}: ${JSON.stringify(kk.v)} (${kk.ease || "smooth"})`;
                        d.onpointerdown = (e) => keyDown(e, l, prop, kk.f, k);
                        pr.track.append(d);
                    }
                }
            }
        }
        if (!layers.length) inner.append(el(doc, "div", "mg-empty", "No layers. Add one with + above."));
        inner.append(ph);
        tl.append(inner);
        tl.scrollLeft = keepL; tl.scrollTop = keepT;
    }
    function keyDown(e, l, prop, f, k) {
        e.stopPropagation(); e.preventDefault();
        const idx = st.keys.findIndex((s) => s.id === l.id && s.prop === prop && s.f === f);
        if (e.shiftKey) { if (idx >= 0) st.keys.splice(idx, 1); else st.keys.push({ id: l.id, prop, f }); }
        else if (idx < 0) st.keys = [{ id: l.id, prop, f }];
        const orig = JSON.stringify(st.scene.layers);
        const x0 = e.clientX; let moved = false;
        const sel0 = st.keys.map((s) => ({ ...s }));
        // The drag listens on the timeline container, not on the diamond: every refresh rebuilds the
        // timeline, which would detach a diamond holding the pointer capture and end the drag.
        const target = tl;
        try { target.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
        const onMove = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            const df =Math.round((ev.clientX - x0) / k);
            if (!df && !moved) return;
            if (!moved) { moved = true; st.hist.push(st.scene); }
            const base = JSON.parse(orig);
            st.scene.layers.forEach((ly, i) => { ly.tracks = base[i].tracks; if (!base[i].tracks) delete ly.tracks; });
            const next = [];
            for (const id of new Set(sel0.map((s) => s.id))) {
                const ly = Mo.layerOf(st.scene, id);
                next.push(...Mo.moveKeys(ly, sel0.filter((s) => s.id === id), df).map((s) => ({ id, ...s })));
            }
            st.keys = next; st.dirty = true;
            refresh(["bar", "stage", "timeline", "gizmo"]);
        };
        const onUp = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", onUp);
            target.removeEventListener("pointercancel", onUp);
            try { target.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
            if (moved) refresh(); else { setFrame(f); refresh(["props", "timeline"]); }
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
        target.addEventListener("pointercancel", onUp);
        refresh(["props", "timeline"]);
    }

    // -- keyboard -------------------------------------------------------------------------------------------------------------------------
    const onKey = (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        const typing = tag === "input" || tag === "textarea" || tag === "select";
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo_() : undo_(); e.stopPropagation(); return; }
        if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo_(); e.stopPropagation(); return; }
        if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); e.stopPropagation(); return; }
        if (typing) return;
        if (mod && e.key.toLowerCase() === "c" && st.keys.length) {
            const l = Mo.layerOf(st.scene, st.keys[0].id);
            st.clip = Mo.copyKeys(l, st.keys.filter((k) => k.id === l.id)); e.preventDefault(); e.stopPropagation(); return;
        }
        if (mod && e.key.toLowerCase() === "v" && st.clip && layer()) {
            e.preventDefault(); e.stopPropagation();
            mutate(() => { const l = layer(); st.keys = Mo.pasteKeys(l, st.clip, st.frame).map((s) => ({ id: l.id, ...s })); });
            return;
        }
        // Time keys: inside the viewer they go to the viewer's own transport (the one path; when the pointer is over the
        // viewer its key handler has already taken them and this is not reached), on the standalone page to this editor.
        const T = o.transport;
        if (e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePlay(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); T ? T.step(e.shiftKey ? -10 : -1) : setFrame(st.frame - (e.shiftKey ? 10 : 1)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); T ? T.step(e.shiftKey ? 10 : 1) : setFrame(st.frame + (e.shiftKey ? 10 : 1)); }
        else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); T ? T.first() : setFrame(0); }
        else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); T ? T.last() : setFrame(dur() - 1); }
        else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault(); e.stopPropagation();
            if (st.keys.length) mutate(() => { for (const k of st.keys) { const l = Mo.layerOf(st.scene, k.id); if (l) Mo.removeKey(l, k.prop, k.f); } st.keys = []; });
            else delSel();
        }
    };
    root.addEventListener("keydown", onKey);
    const focusOnPress = (e) => { const t = (e.target.tagName || "").toLowerCase(); if (!["input", "textarea", "select"].includes(t)) e.currentTarget.focus({ preventScroll: true }); };
    root.addEventListener("pointerdown", focusOnPress, true);
    if (o.split) for (const part of [side, tl]) { part.addEventListener("keydown", onKey); part.addEventListener("pointerdown", focusOnPress, true); }
    tl.addEventListener("wheel", (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        st.zoom = clamp(st.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 1, 16);
        renderTimeline();
    }, { passive: false });

    // -- public ---------------------------------------------------------------------------------------------------------------------------
    return {
        state: st,
        root,
        parts: o.split ? { props: side, timeline: tl } : null,
        load(sceneObj, path = "") {
            st.scene = S.normalizeScene(sceneObj);
            st.path = path; st.sel = null; st.keys = []; st.frame = 0; st.dirty = false; st.hist = new Mo.History(); st.fit = true;
            compSig = "";
            if (st.playing) togglePlay();
            refresh();
            return S.validateScene(st.scene);
        },
        getScene: () => st.scene,
        setFrame, select, save, undo: undo_, redo: redo_, refresh,
        comp: () => (st.scene ? st.scene.comp : null),
        /** The host's bar changed the composition's length (frames) or frame rate: an undoable edit. */
        setComp(patch) {
            if (!st.scene) return;
            mutate(() => {
                if (patch.duration != null) Mo.setDuration(st.scene, patch.duration);
                if (patch.fps > 0) st.scene.comp.fps = patch.fps;
            });
        },
        isDirty: () => st.dirty,
        path: () => st.path,
        setPath(p) { st.path = p; renderBar(); },
        focus() { try { root.focus({ preventScroll: true }); } catch (_) { /* detached */ } },
        /** The viewer's panels came or went: the preview and the timeline measure themselves again. */
        relayout() { if (st.scene) { layoutStage(); renderTimeline(); } },
        dispose() {
            if (st.playing) togglePlay();
            cancelAnimationFrame(raf);
            if (ro) ro.disconnect();
            host.replaceChildren();
            if (o.split) for (const part of [side, tl]) part.remove();
        },
    };
}
