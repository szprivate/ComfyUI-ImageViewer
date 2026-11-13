// imageViewer_compEditor.js
// The Comp editor: a node graph (Nuke's way, top to bottom), the same graph as a stack of layers (After
// Effects' way), the selected node's properties, and the picture, for one *.comp.json.
//
// A plain function over a host element, like Motion's editor (imageViewer_mgEditor.js), whose look and key
// controls it shares: the Properties rows are Motion's (.mg-prop, the stopwatch, the key diamond, the same
// mgModel functions on a node's params), the composition settings are Motion's, and so are the context menus
// and the undo History. `host` holds the toolbar and the picture; `parts` = {graph, props, layers} are handed
// back for the viewer to seat in dock panels of their own (imageViewer_compPanel.js).
//
// opts:
//   transport: {toggle, step(n), first, last}  time is the host's (the viewer's own bar), as in Motion
//   onFrame(f)                 the user moved the time here (a key's frame); host moves it with setFrame(f, {fromHost})
//   onComp()                   length / frame rate / size changed
//   loadSource(node, frame, {scale, format}) -> Promise<picture | null>: a Read's pixels ({w, h, data, ow?, oh?}: shrunk, ow x oh is the file's size)
//   sourceInfo(node)           -> Promise<{kind, first, last, ...}>: what a Read's file is (for its row)
//   pickFile(cb)               the viewer's file picker; cb(path)
//   pathsOf(items)             what a History / file-browser drop names, as Read files (sequences as patterns); may return a promise
//   save(path, comp)           -> Promise
//   newComp(), open(), saveAs(comp)   the bar's file buttons (as Paint's: New, Open, Save with its menu)
//   render(path)               -> Promise<{message}>
//   notify(text, severity)
import * as C from "./imageViewer_compModel.js";
import * as O from "./imageViewer_compOps.js";
import * as CK from "./imageViewer_compColor.js";
import * as Mo from "./imageViewer_mgModel.js";
import { MG_CSS } from "./imageViewer_mgEditor.js";
import { paintIcon } from "./imageViewer_paintIcons.js";
import { createCompCurves } from "./imageViewer_compCurves.js";
import * as J from "./imageViewer_compJack.js";

const CSS = `
.cp-root{display:flex;flex-direction:column;position:absolute;inset:0;background:#0f0f12;color:#d8d8dc;font:12px/1.35 system-ui,Segoe UI,sans-serif;outline:none}
.cp-root *{box-sizing:border-box}
.cp-stage{flex:1;position:relative;overflow:hidden;cursor:default}
.cp-canvas{position:absolute;left:0;top:0;transform-origin:0 0;image-rendering:auto;box-shadow:0 0 0 1px #444}
.cp-info{position:absolute;left:8px;bottom:6px;opacity:.7;pointer-events:none;white-space:nowrap}
.cp-graph,.cp-layers{position:absolute;inset:0;background:#202024;color:#d8d8dc;font:12px/1.35 system-ui,Segoe UI,sans-serif;outline:none;overflow:hidden;user-select:none}
.cp-graph *,.cp-layers *{box-sizing:border-box}
.cp-world{position:absolute;left:0;top:0;transform-origin:0 0}
.cp-wires{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
.cp-node{position:absolute;width:${C.NODE_W}px;height:${C.NODE_H}px;border:1px solid #0008;border-radius:3px;display:flex;align-items:center;justify-content:center;
  font-weight:600;color:#111;cursor:grab;box-shadow:0 1px 3px #0008;white-space:nowrap;overflow:visible}
.cp-node .cp-nm{overflow:hidden;text-overflow:ellipsis;max-width:${C.NODE_W - 12}px;pointer-events:none}
.cp-node.sel{outline:2px solid #ffcf3a;outline-offset:1px}
.cp-node.viewed{box-shadow:0 0 0 2px #ff3b3b,0 1px 3px #0008}
.cp-node.viewed:after{content:"";position:absolute;left:-7px;top:9px;width:0;height:0;border:6px solid transparent;border-left:7px solid #ff3b3b}
.cp-vtag{position:absolute;right:100%;margin-right:9px;top:7px;font-size:10px;font-weight:700;color:#fff;background:#ff3b3b;border-radius:2px;padding:0 4px;pointer-events:none;letter-spacing:.03em}
.cp-eye{position:absolute;right:2px;top:50%;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;line-height:1;background:#0003;color:#111;cursor:pointer;opacity:0;z-index:3}
.cp-node:hover .cp-eye{opacity:.8}.cp-eye:hover{opacity:1!important;background:#ff3b3b;color:#fff}
.cp-node.viewed .cp-eye{opacity:1;background:#ff3b3b;color:#fff}
.cp-node.off{opacity:.45}.cp-node.off .cp-nm{text-decoration:line-through}
.cp-node .cp-sub{position:absolute;top:100%;left:0;right:0;text-align:center;font-weight:400;font-size:10px;color:#9a9aa2;margin-top:2px;pointer-events:none;overflow:hidden;text-overflow:ellipsis}
.cp-port{position:absolute;width:11px;height:11px;margin-left:-5.5px;border-radius:50%;background:#e8e8ea;border:1px solid #000;cursor:crosshair;z-index:2}
.cp-port.in{top:-6px}.cp-port.out{bottom:-6px;left:50%}
.cp-port:hover{background:#ffcf3a}
.cp-plabel{position:absolute;top:-19px;font-size:10px;color:#bbb;pointer-events:none;transform:translateX(-50%)}
.cp-wires path.cp-wire-hot{stroke:#ff6a1a!important;stroke-width:3!important}
.cp-wires path.cp-wire-cut{stroke:#ff3b30!important;stroke-width:3!important;stroke-dasharray:4 3!important}
.cp-wires polyline.cp-cutline{stroke:#ff3b30;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}
.cp-marquee{position:absolute;border:1px dashed #ffcf3a;background:#ffcf3a14;pointer-events:none}
.cp-hint{position:absolute;right:8px;bottom:6px;opacity:.45;pointer-events:none}
.cp-gbar{position:absolute;left:6px;top:6px;display:flex;gap:4px;z-index:3}
.cp-gbar .mg-btn{display:inline-flex;align-items:center;gap:4px}
.cp-gbar svg{width:14px;height:14px}
.cp-gbar .cp-ib{padding:2px 5px}
.cp-ibtn{display:inline-flex;align-items:center;justify-content:center;padding:3px 6px}
.cp-ibtn svg{width:16px;height:16px}
.cp-ibtn.dirty{color:#ff6a1a;border-color:#ff6a1a}
.cp-display{max-width:13em;text-overflow:ellipsis}
.cp-pop{position:absolute;z-index:40}
.cp-pop div.off{opacity:.4;cursor:default}.cp-pop div.off:hover{background:none}
.cp-pop div .cp-k{float:right;margin-left:18px;color:#8a8a92}
.cp-dlg-shade{position:absolute;inset:0;z-index:50;background:#0008;display:flex;align-items:center;justify-content:center}
.cp-dlg{background:#26262c;border:1px solid #44444c;border-radius:4px;padding:12px 14px;min-width:380px;max-width:92%;box-shadow:0 8px 28px #000a;color:#d8d8dc;font:12px/1.35 system-ui,Segoe UI,sans-serif}
.cp-dlg h3{margin:0 0 10px;font-size:13px}
.cp-dlg .cp-field{display:flex;align-items:center;gap:6px;margin:6px 0}
.cp-dlg .cp-field label{width:56px;color:#9a9aa2}
.cp-dlg input{flex:1;background:#141418;border:1px solid #44444c;color:#fff;font:inherit;padding:3px 5px}
.cp-dlg .cp-note{color:#9a9aa2;margin:8px 0}.cp-dlg .cp-note.error{color:#ff8a7a}
.cp-dlg .cp-go{display:flex;justify-content:flex-end;gap:6px;margin-top:10px}
.comp-params .mg-prop label,.mg-side .mg-prop label{width:96px}
.cp-tabmenu{position:absolute;z-index:30;background:#26262c;border:1px solid #44444c;border-radius:3px;padding:3px;box-shadow:0 4px 14px #0008;width:210px;display:flex;flex-direction:column}
.cp-tabmenu input{width:100%;background:#141418;border:1px solid #ff6a1a;color:#fff;font:inherit;padding:3px 5px;flex:0 0 auto}
.cp-tmlist{overflow-y:auto;overscroll-behavior:contain;margin-top:3px}
.cp-tmrow{padding:2px 8px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;white-space:nowrap}
.cp-tmrow.on{background:#3a2a1c}.cp-tmrow.act{color:#e8e8ea}
.cp-tmsub{color:#8a8a92;font-size:10px}
.cp-tmhead{padding:5px 6px 1px;color:#8a8a92;font-size:10px;text-transform:uppercase;letter-spacing:.04em;cursor:default}
.cp-tmnone{padding:4px 8px;color:#8a8a92;cursor:default}
.cp-lbar{display:flex;gap:4px;align-items:center;padding:4px 6px;border-bottom:1px solid #2c2c32;flex-wrap:wrap}
.cp-lrows{position:absolute;top:31px;left:0;right:0;bottom:0;overflow:auto}
.cp-lrow{display:flex;align-items:center;gap:6px;height:26px;padding:0 6px;border-bottom:1px solid #2a2a30;cursor:pointer}
.cp-lrow.sel{background:#2b2218}.cp-lrow:hover:not(.sel){background:#25252b}
.cp-lrow .cp-lname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-lrow.off .cp-lname{opacity:.4;text-decoration:line-through}
.cp-lrow select,.cp-lrow input{background:#141418;border:1px solid #34343c;color:#e6e6ea;border-radius:2px;font:inherit;padding:0 2px;height:20px}
.cp-lrow input{width:52px}
.cp-lrow .cp-lkind{font-size:10px;opacity:.55;width:62px;flex:none}
.cp-swatch{width:14px;height:14px;border-radius:2px;flex:none;border:1px solid #0008}
.cp-note{opacity:.6;padding:6px 2px}
.cp-over{position:absolute;left:0;top:0;transform-origin:0 0;overflow:visible;pointer-events:none}
.cp-over .cp-handle{fill:#0009;stroke:#3ad1ff;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:all;cursor:move}
.cp-over .cp-handle.small{stroke:#ffcf3a}
.cp-over .cp-hline{fill:none;stroke:#3ad1ff;stroke-width:1px;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}
.cp-over .cp-hline.solid{stroke-dasharray:none}
.cp-over .cp-jfill{fill:transparent;stroke:none;pointer-events:all;cursor:move}
.cp-over .cp-jring{fill:none;stroke:#3ad1ff;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:stroke;cursor:nwse-resize}
.cp-over .cp-jring:hover,.cp-over .cp-jsq:hover,.cp-over .cp-jbar:hover,.cp-over .cp-jctr:hover,.cp-over .cp-cedge:hover{stroke:#fff}
.cp-over .cp-jaxis{stroke:#3ad1ff;stroke-width:1px;vector-effect:non-scaling-stroke}
.cp-over .cp-jsq{fill:#0009;stroke:#3ad1ff;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:all;cursor:ew-resize}
.cp-over .cp-jsq[data-jack=n],.cp-over .cp-jsq[data-jack=s]{cursor:ns-resize}
.cp-over .cp-jsq[data-crop=tl],.cp-over .cp-jsq[data-crop=br]{cursor:nwse-resize}
.cp-over .cp-jsq[data-crop=tr],.cp-over .cp-jsq[data-crop=bl]{cursor:nesw-resize}
.cp-over .cp-jbar{fill:#0009;stroke:#ffcf3a;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:all;cursor:grab}
.cp-over .cp-jbar.skew{stroke:#c98aff;cursor:col-resize}
.cp-over .cp-jctr{fill:#0006;stroke:#3ad1ff;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:all;cursor:move}
.cp-over .cp-cinside{fill:transparent;pointer-events:all;cursor:move}
.cp-over .cp-cedge{stroke:transparent;pointer-events:stroke;vector-effect:non-scaling-stroke}
.cp-over .cp-cedge[data-crop=t],.cp-over .cp-cedge[data-crop=b]{cursor:ns-resize}
.cp-over .cp-cedge[data-crop=l],.cp-over .cp-cedge[data-crop=r]{cursor:ew-resize}
.mg-prop label.cp-scrub{cursor:ew-resize;user-select:none}
.mg-prop label.cp-scrub:hover{opacity:1;color:#3ad1ff}
.cp-pane{border:1px solid #ffffff14;border-radius:4px;margin:0 0 8px;background:#ffffff05}
.cp-pane.first{border-color:#ffcf3a55}
.cp-panehead{display:flex;align-items:center;gap:6px;padding:4px 6px;background:#ffffff0d;cursor:pointer;user-select:none;font-weight:600}
.cp-panehead .cp-panename{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-panehead .cp-panetype{color:#9aa;font-weight:400;font-size:11px}
.cp-panehead button{padding:0 6px;min-width:0}
.cp-pane > .mg-prop,.cp-pane > .mg-empty,.cp-pane > div{margin-left:4px;margin-right:4px}
input.cp-newch{flex:1;min-width:0}
.mg-prop input.cp-mixed::placeholder{color:#c9a24a;opacity:1}.mg-prop.cp-mixedrow label{color:#c9a24a}.cp-multi{color:#9aa}
.cp-stage.drawing,.cp-stage.picking{cursor:crosshair}
.cp-cctabs,.cp-ccrange{display:flex;flex-wrap:wrap;gap:3px;margin:6px 0 4px}
.cp-cctabs .mg-btn,.cp-ccrange .mg-btn{flex:1 1 auto;padding:2px 6px}
.cp-ccwheels{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin:4px 0}
.cp-ccwheel{display:flex;flex-direction:column;align-items:center;gap:2px}
.cp-ccwheel canvas{width:104px;height:104px;cursor:crosshair;touch-action:none}
.cp-ccval{font-size:11px;opacity:.75;text-align:center}
.cp-ccluma{width:100%;height:70px;background:rgba(0,0,0,.25);border-radius:3px}
`;
const CAT_COLOR = { Image: "#9aa6b8", Merge: "#6f9fe0", Transform: "#b39ddb", Color: "#86c98a", Filter: "#e0a060", Other: "#c8c8c8",
    Channel: "#9b8a6a", Time: "#d98fb0", Keyer: "#5fc4b8", Draw: "#d6c86a" };
const KIND_ICON = { layer: "▣", background: "▤", group: "⧉" };

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const NS = "http://www.w3.org/2000/svg";
const svgEl = (doc, tag, attrs = {}) => { const n = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
const toHex = (c) => "#" + [0, 1, 2].map((i) => hex2(C.linearToSrgb(Math.max(0, Math.min(1, c[i]))))).join("");
const fromHex = (h, a) => [1, 3, 5].map((i) => C.srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255)).concat([a]);

/** The editor's look (and Motion's, which it shares) in a document or shadow root, once. The node graph may be
 *  shown outside the viewer (ComfyUI's bottom panel, imageViewer_compComfyTab.js), so this is not only the viewer's. */
const GRID_KEY = "imageviewer.comp.grid";
/** The node graph's grid: shown, and whether nodes snap to it (per viewer, in localStorage). */
function loadGrid() {
    try { const v = JSON.parse(localStorage.getItem(GRID_KEY) || "null"); if (v && typeof v === "object") return { show: v.show !== false, snap: v.snap !== false }; }
    catch (_) { /* none kept */ }
    return { show: true, snap: true };
}
function keepGrid(g) { try { localStorage.setItem(GRID_KEY, JSON.stringify(g)); } catch (_) { /* not kept */ } }

export function installCompStyles(rootNode) {
    const doc = rootNode.ownerDocument || rootNode;
    for (const [attr, text] of [["data-mg", MG_CSS], ["data-comp", CSS]]) {
        if (!rootNode.querySelector || !rootNode.querySelector(`style[${attr}]`)) {
            const style = el(doc, "style"); style.setAttribute(attr, "1"); style.textContent = text;
            (rootNode.head || rootNode).appendChild(style);
        }
    }
}

export function createCompEditor(host, opts = {}) {
    const o = opts;
    const doc = host.ownerDocument;
    const rootNode = host.getRootNode ? host.getRootNode() : doc;
    const st = {
        comp: null, path: "", dirty: false, hist: new Mo.History(), sel: [], view: null, frame: 0,
        proxy: "auto", channel: "rgb", ev: 0, layer: "rgba", zoom: { s: 1, x: 0, y: 0, fit: true }, graph: { s: 1, x: 40, y: 40, fitted: false },
        layerSel: null, draw: null, pick: null, ocio: null, display: "",
        grid: loadGrid(),
        held: null,                 // "a" (lay out) / "y" (cut wires) while that key is held over the graph
        batch: new Map(), batchN: 0, // when each selected node joined the selection (one box = one batch)
    };
    // OCIO transforms baked for the preview, by ocioKey: {lut, at, why} once answered, the promise while asked.
    // Every draw waits for the SAME request (a second draw during a slow first bake once found nothing, drew
    // the plain picture, and the first draw - stale by then - was thrown away: the display menu did nothing);
    // a refusal is asked again after LUT_RETRY_MS, and said in the info line.
    const luts = new Map(), lutAsk = new Map();
    const LUT_RETRY_MS = 15000;
    const lutOf = (spec) => { const e = luts.get(C.OC.ocioKey(spec)); return (e && e.lut) || null; };
    const displaySpec = () => { if (!st.display) return null; const [display, view] = st.display.split("\u0001"); return { src: "", display, view }; };
    async function needLuts(specs) {
        if (!o.ocioLut) return;
        await Promise.all(specs.map((spec) => {
            const k = C.OC.ocioKey(spec);
            const had = luts.get(k);
            if (had && (had.lut || performance.now() - had.at < LUT_RETRY_MS)) return null;
            if (!lutAsk.has(k)) {
                lutAsk.set(k, (async () => {
                    let lut = null, why = "";
                    try { lut = await o.ocioLut(spec); if (!lut) why = "the server could not bake it"; } catch (e) { why = String((e && e.message) || e); }
                    luts.set(k, { lut, at: performance.now(), why });
                    lutAsk.delete(k);
                })());
            }
            return lutAsk.get(k);
        }));
    }
    if (o.ocioInfo) o.ocioInfo().then((info) => { st.ocio = info; if (st.comp) { renderBar(); renderProps(); } }).catch(() => {});
    // Every node's results, kept between renders within CACHE_BYTES (renderNode's ctx.cache, cacheAll): a change
    // makes again only what is downstream of it, and a frame seen before (or rendered ahead) comes back at once.
    const heavy = new Map();
    const CACHE_BYTES = 640 * 1024 * 1024;
    // The frames of the picture on screen whose result is kept: f -> {key, hash, id, scale} (cachedFrames()).
    const frameKeys = new Map();
    let ahead = null;           // the frames being rendered ahead while nothing else happens
    const AHEAD = 48;
    let lastPics = null;
    let renderGen = 0, renderQueued = false, lastMs = 0, lastScale = 1, lastShown = 0, drawnGen = 0;
    const SHOW_EVERY_MS = 120;
    const infos = new Map();

    installCompStyles(rootNode);

    // ── skeleton ─────────────────────────────────────────────────────────────
    host.replaceChildren();
    const root = el(doc, "div", "cp-root"); root.tabIndex = 0;
    const bar = el(doc, "div", "mg-bar");
    const stage = el(doc, "div", "cp-stage");
    const canvas = el(doc, "canvas", "cp-canvas");
    const info = el(doc, "div", "cp-info");
    const over = svgEl(doc, "svg", { class: "cp-over" });
    stage.append(canvas, over, info);
    root.append(bar, stage);
    host.append(root);
    const graph = el(doc, "div", "cp-graph"); graph.tabIndex = 0;
    const world = el(doc, "div", "cp-world");
    const wires = svgEl(doc, "svg", { class: "cp-wires" });
    world.append(wires);
    graph.append(world, el(doc, "div", "cp-hint", "Tab or right-click: add a node · 1 or 👁: show it in the picture · D: disable · Del: delete · F: frame all"));
    // In and out of a panel are buttons at its top left (Add here): the list Tab opens.
    const gbar = el(doc, "div", "cp-gbar");
    const addBtn = el(doc, "button", "mg-btn cp-add");
    addBtn.title = "Add a node (Tab) - with a node selected, it goes in under it";
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg><span>Add</span>';
    addBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    addBtn.addEventListener("click", (e) => { e.stopPropagation(); tabMenu({ left: 6, top: 34 }); });
    const ICON = {
        grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
        snap: '<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>',
        align: '<rect width="6" height="16" x="4" y="6" rx="2"/><rect width="6" height="9" x="14" y="6" rx="2"/><path d="M22 2H2"/>',
    };
    const gbtn = (icon, title, fn) => {
        const b = el(doc, "button", "mg-btn cp-ib");
        b.title = title;
        b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[icon]}</svg>`;
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
        return b;
    };
    const gridBtn = gbtn("grid", "Show the grid (G)", () => setGrid({ show: !st.grid.show }));
    const snapBtn = gbtn("snap", "Snap nodes to the grid (S; hold Shift while dragging to place freely)", () => setGrid({ snap: !st.grid.snap }));
    const alignBtn = gbtn("align", "Align the selected nodes", (b) => popMenu(b, alignItems()));
    gridBtn.classList.add("cp-grid-btn"); snapBtn.classList.add("cp-snap-btn"); alignBtn.classList.add("cp-align-btn");
    gbar.append(addBtn, gridBtn, snapBtn, alignBtn);
    graph.append(gbar);
    const props = el(doc, "div", "mg-side mg-part"); props.tabIndex = 0;
    const layers = el(doc, "div", "cp-layers"); layers.tabIndex = 0;
    const curvesEl = el(doc, "div", "cp-curves-part");
    const parts = { graph, props, layers, curves: curvesEl };
    // The Curve Editor: the selected nodes' keys (imageViewer_compCurves.js); every change one undo step here.
    let curvesUI = null, curvesPushed = false;
    function curves() {
        if (curvesUI) return curvesUI;
        curvesUI = createCompCurves(curvesEl, {
            nodes: () => (st.comp ? [primary(), ...st.sel.map(node)].filter((n, i, a) => n && a.indexOf(n) === i) : []),
            specOf: (n, p) => (C.NODE_TYPES[n.type] && C.NODE_TYPES[n.type].params[p]) || null,
            valueAt: (n, p, f) => C.paramAt(n, p, f),
            range: () => ({ min: 0, max: Math.max(1, (st.comp ? st.comp.format.frames : 2) - 1) }),
            frame: () => st.frame,
            begin: () => { if (liveBak.size) liveRestore(); st.hist.push(st.comp); curvesPushed = true; },
            changed: () => { queueRender(); renderOverlay(); curvesUI.draw(); },
            end: () => { if (curvesPushed) { st.dirty = true; curvesPushed = false; refresh(["bar", "props", "stage", "graph", "curves"]); } },
            seek: (f) => setFrame(f),
        });
        return curvesUI;
    }

    const btn = (label, title, fn, cls = "") => { const b = el(doc, "button", "mg-btn " + cls, label); b.title = title; b.onclick = fn; return b; };
    const toast = (m, sev) => { try { o.notify(m, sev); } catch (_) { /* no toasts */ } };
    const comp = () => st.comp;
    const fmt = () => st.comp.format;
    const node = (id) => C.nodeById(st.comp, id);
    const primary = () => (st.sel.length ? node(st.sel[st.sel.length - 1]) : null);
    const keyHost = () => ({ comp: { width: fmt().width, height: fmt().height } });
    /** The nodes a Parameters change reaches: every selected node of the shown node's type, the shown one first
     *  (as ComfyUI's Parameters panel does for several selected nodes). */
    // Every selected node has a panel of its own (Nuke's Properties bin): a change goes to that node only.
    const targetsOf = (n) => [n];
    let pane = null;   // the panel being filled
    const sameVal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    /** Write ``p`` on every target: ``fn(its value now)`` -> its new value (keyed when the param is keyed). */
    function writeAll(n, p, d, fn) {
        for (const t of targetsOf(n)) {
            const v = fn(C.paramAt(t, p, st.frame), t);
            if (v === undefined) continue;
            if (d.key) Mo.setProp(keyHost(), t, p, v, st.frame); else t[p] = v;
        }
    }

    // ── live edits: a value typed or picked shows at once, and becomes one undo step when it is committed ──
    const liveBak = new Map();   // "<node id>\0<param>" -> the value and keys before the live edit began
    const cloneV = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    function liveWrite(n, p, d, fn) {
        for (const t of targetsOf(n)) {
            const k = t.id + "\0" + p;
            if (!liveBak.has(k)) liveBak.set(k, { v: cloneV(t[p]), had: !!(t.tracks && p in t.tracks), tr: cloneV(t.tracks && t.tracks[p]) });
        }
        writeAll(n, p, d, fn);
        queueRender(); renderOverlay();
    }
    /** Puts back what the live edits changed (before the committed change, or when they are dropped). */
    function liveRestore() {
        for (const [k, b] of liveBak) {
            const [id, p] = k.split("\0");
            const t = node(id);
            if (!t) continue;
            if (b.v === undefined) delete t[p]; else t[p] = b.v;
            if (b.had) { t.tracks = t.tracks || {}; t.tracks[p] = b.tr; } else if (t.tracks) delete t.tracks[p];
        }
        liveBak.clear();
    }
    function mutate(fn, { structure = true } = {}) {
        if (liveBak.size) liveRestore();
        st.hist.push(st.comp);
        fn();
        st.dirty = true;
        refresh(structure ? ["bar", "graph", "props", "layers", "stage"] : ["bar", "props", "stage", "graph"]);
    }
    function fixSel() {
        st.sel = st.sel.filter((id) => node(id));
        if (st.view && !node(st.view)) st.view = null;
    }
    function undo() { if (liveBak.size) liveRestore(); const s = st.hist.undo(st.comp); if (s) { st.comp = s; st.dirty = true; fixSel(); refresh(); o.onComp && o.onComp(); } }
    function redo() { if (liveBak.size) liveRestore(); const s = st.hist.redo(st.comp); if (s) { st.comp = s; st.dirty = true; fixSel(); refresh(); o.onComp && o.onComp(); } }
    function refresh(which = ["bar", "graph", "props", "layers", "stage"]) {
        if (!st.comp) return;
        if (which.includes("bar")) renderBar();
        if (which.includes("graph")) renderGraph();
        if (which.includes("props")) {
            renderProps();
            if (st.refocus) {
                const f = [...props.querySelectorAll("[data-fk]")].find((x) => x.dataset.fk === st.refocus);
                st.refocus = null;
                if (f) { f.focus({ preventScroll: true }); f.select && f.select(); }
            }
        }
        if (which.includes("layers")) renderLayers();
        if (which.includes("stage")) { queueRender(); renderOverlay(); }
        if (curvesEl.isConnected && (which.includes("curves") || which.includes("props"))) curves().draw();
    }

    // ── toolbar ──────────────────────────────────────────────────────────────
    // Exposure and the channel shown are the VIEWER's (its exposure bar, seated over this picture by the panel,
    // and E + drag): `setViewing` is how they reach here. Without a viewer the R G B A keys still work.
    function setChannel(c) {
        c = C.VIEW_CHANNELS.some((x) => x[0] === c) ? c : "rgb";
        if (o.setChannel) o.setChannel(c);
        else { st.channel = c; queueRender(); }
    }
    let layerSel = null, lastLayers = [];
    function fillLayers(layers) {
        lastLayers = layers;
        if (!layerSel) return;
        const want = ["rgba", ...layers];
        if (st.layer !== "rgba" && !want.includes(st.layer)) want.push(st.layer);
        if ([...layerSel.options].map((x) => x.value).join("|") !== want.join("|")) {
            layerSel.replaceChildren(...want.map((l) => new Option(l === st.layer && !["rgba", ...layers].includes(l) ? `${l} (not here)` : l, l)));
        }
        layerSel.value = st.layer;
        layerSel.style.display = want.length > 1 ? "" : "none";
    }
    function renderBar() {
        bar.replaceChildren();
        const t = el(doc, "span", "mg-title", (st.path ? st.path.split(/[\\/]/).pop() : "comp") + (st.dirty ? " •" : ""));
        t.title = st.path || "";
        const proxy = el(doc, "select", "mg-btn");
        for (const [v, label] of [["auto", "Proxy: auto"], ["1", "Full"], ["0.5", "1/2"], ["0.25", "1/4"]]) proxy.append(new Option(label, v));
        proxy.value = st.proxy;
        proxy.title = "The picture's resolution while you work (the render is always full size)";
        proxy.onchange = () => { st.proxy = proxy.value; queueRender(); };
        let disp = null;
        if (st.ocio && st.ocio.available && st.ocio.displays.length) {
            disp = el(doc, "select", "mg-btn cp-display");
            disp.append(new Option("sRGB (plain)", ""));
            for (const d of st.ocio.displays) for (const v of d.views) disp.append(new Option(`${d.name} · ${v}`, `${d.name}\u0001${v}`));
            disp.value = st.display;
            disp.title = `How the picture is shown: plain sRGB, or a display and view of the OCIO config (${st.ocio.source}; working space ${st.ocio.working})`;
            disp.onchange = () => { st.display = disp.value; if (o.onDisplay) o.onDisplay(st.display); queueRender(); };
        }
        // The layer the picture shows: rgba, or a layer of extra channels of the node on show (filled at each draw).
        layerSel = el(doc, "select", "mg-btn cp-layer");
        layerSel.title = "The layer shown: rgba, or a layer of extra channels (one channel shows as grey)";
        fillLayers(lastLayers);
        layerSel.onchange = () => { st.layer = layerSel.value; queueRender(); };
        const ib = (icon, title, fn, cls = "") => {
            const b = el(doc, "button", "mg-btn cp-ibtn " + cls);
            b.title = title; b.append(paintIcon(doc, icon));
            b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
            return b;
        };
        bar.append(
            ib("newDoc", "New comp…", () => o.newComp && o.newComp(), "cp-new"),
            ib("open", "Open… (Ctrl+O) a comp", () => o.open && o.open(), "cp-open"),
            ib("save", "Save (Ctrl+S) - the menu: Save as, Render, Export to Nuke", (b) => popMenu(b, fileItems()), "cp-save" + (st.dirty ? " dirty" : "")),
            el(doc, "span", "mg-sep"),
            t,
            el(doc, "span", "mg-sep"),
            btn("↶", "Undo (Ctrl+Z)", undo), btn("↷", "Redo (Ctrl+Shift+Z)", redo),
            el(doc, "span", "mg-sep"), proxy, ...(disp ? [disp] : []), layerSel, ...[o.barControl && o.barControl()].filter(Boolean),
            btn("Fit", "Fit the picture (F on the picture)", () => { st.zoom.fit = true; layoutCanvas(); }),
            el(doc, "span", "mg-info", `${fmt().width}×${fmt().height} · ${fmt().fps} fps · ${fmt().frames} f`));
    }
    function fileItems() {
        return [["Save", save, !!st.path, "Ctrl+S"], ["Save as…", saveAs, !!o.saveAs, "Ctrl+Shift+S"], null,
            ["Render…", doRender, !!o.render], ["Export to Nuke…", doNuke, !!o.exportNuke], null,
            ["Open…", () => o.open && o.open(), !!o.open, "Ctrl+O"], ["New comp", () => o.newComp && o.newComp(), !!o.newComp]];
    }
    async function saveAs() { if (st.comp && o.saveAs) await o.saveAs(st.comp); }
    async function save() {
        if (!st.path || !o.save) return;
        try { await o.save(st.path, st.comp); st.dirty = false; renderBar(); toast("Saved", "success"); }
        catch (e) { toast("Not saved: " + (e.message || e), "error"); }
    }
    async function doRender() {
        if (st.dirty) await save();
        if (st.dirty || !o.render) return;
        try { const r = await o.render(st.path); if (r && r.message) toast(r.message, "info"); }
        catch (e) { toast("Render failed: " + (e.message || e), "error"); }
    }

    async function doNuke() {
        if (st.dirty) await save();
        if (st.dirty || !o.exportNuke) return;
        try { await o.exportNuke(st.path); }
        catch (e) { toast("Export failed: " + (e.message || e), "error"); }
    }

    // ── the picture ──────────────────────────────────────────────────────────
    function viewedId() { return st.view && node(st.view) ? st.view : st.comp.output; }
    /** The size of the picture on screen, in pixels of the comp (a Reformat upstream changes it). */
    const viewFmt = () => C.formatAt(st.comp, viewedId());
    /** The size that comes into node n (the pixels its numbers are in); without an input, the comp's. */
    const inFmt = (n) => (n && n.inputs && n.inputs[0] ? C.formatAt(st.comp, n.inputs[0]) : fmt());
    /** How far down the picture on screen a picture of size f lies (both laid with their bottom lefts together). */
    const downBy = (f) => viewFmt().height - f.height;
    function scaleNow() {
        if (st.proxy !== "auto") return Number(st.proxy) || 1;
        const px = fmt().width * fmt().height;
        return px > 4.2e6 ? 0.25 : px > 1.1e6 ? 0.5 : 1;
    }
    const win = () => (root.ownerDocument && root.ownerDocument.defaultView) || window;
    let moveGen = 0;
    function queueRender() {
        if (renderQueued) return;
        renderQueued = true;
        // The window the picture is in NOW: popped out, the viewer moves into another window, and the one it was
        // made in stops its frames once it is behind (the picture then stayed empty).
        const g = moveGen;
        win().requestAnimationFrame(() => { if (g !== moveGen) return; renderQueued = false; draw(); });
    }
    async function draw() {
        if (!st.comp) return;
        const gen = ++renderGen;
        const id = viewedId();
        const f = st.frame;
        const scale = scaleNow();
        const pics = new Map();
        try {
            const needs = C.sourceNeeds(st.comp, id, f);
            await Promise.all(needs.map(async ({ node: n, frame: nf }) => {
                const p = o.loadSource ? await o.loadSource(n, nf, { scale, format: fmt() }).catch(() => null) : null;
                pics.set(`${n.id}@${nf}`, p);
            }));
            const ds = displaySpec();
            await needLuts(C.ocioNeeds(st.comp, f).map((x) => x.spec).concat(ds ? [ds] : []));
        } catch (_) { /* drawn without */ }
        if (!st.comp) return;
        // A newer picture was asked for while this one loaded (the timeline dragged, a value typed): it is drawn
        // anyway when nothing was drawn for a while, so a scrub shows frames as it goes instead of only at its end.
        if (gen < drawnGen || (gen !== renderGen && performance.now() - lastShown < SHOW_EVERY_MS)) return;
        lastShown = performance.now(); drawnGen = gen;
        lastPics = { pics, scale, frame: f };
        const t0 = performance.now();
        const keysUsed = new Map();
        const img = C.renderNode(st.comp, id, f, { scale, source: (n, nf) => pics.get(`${n.id}@${nf}`) || null, cache: heavy, matte,
            ocio: lutOf, cacheAll: true, cacheBytes: CACHE_BYTES, keysUsed });
        noteFrame(id, f, scale, keysUsed);
        aheadSoon();
        lastMs = Math.round(performance.now() - t0);
        lastScale = scale;
        if (canvas.width !== img.w || canvas.height !== img.h) { canvas.width = img.w; canvas.height = img.h; }
        const ctx = canvas.getContext("2d");
        const data = ctx.createImageData(img.w, img.h);
        const ds = displaySpec(), dl = ds && lutOf(ds);
        // Exposure and the channel are the viewer's, not the comp's: the render never sees them.
        const layers = C.CH.layersOf(Object.keys(img.ch || {}));
        fillLayers(layers);
        const shownImg = layers.includes(st.layer) ? C.CH.layerPicture(img, img.ch, st.layer) : img;
        C.viewEncode(shownImg, data.data, { gain: Math.pow(2, st.ev), channel: st.channel,
            color: dl ? (r, g, b) => C.OC.lutColor(dl, r, g, b) : null });
        ctx.putImageData(data, 0, 0);
        layoutCanvas();
        const v = node(id), vf = viewFmt();
        const size = vf.width !== fmt().width || vf.height !== fmt().height ? ` · ${vf.width}×${vf.height}` : "";
        const lay = st.layer !== "rgba" ? (layers.includes(st.layer) ? ` · ${st.layer}` : ` · no ${st.layer} here: rgba`) : "";
        const chan = lay + (st.channel === "rgb" ? "" : " · " + C.VIEW_CHANNELS.find((c) => c[0] === st.channel)[1].toLowerCase());
        const ev = st.ev && st.channel !== "a" ? ` · ${st.ev > 0 ? "+" : ""}${st.ev.toFixed(1)} EV` : "";
        const lutFail = ds && !dl && luts.get(C.OC.ocioKey(ds));
        const shown = ds ? (dl ? ` · ${ds.display} / ${ds.view}` : lutFail ? ` · OCIO display failed (${lutFail.why}): plain sRGB` : " · OCIO display loading…") : "";
        info.textContent = `Viewing ${v ? v.name || v.id : "nothing"}${size}${chan}${ev}${shown} · ${scale === 1 ? "full" : "1/" + Math.round(1 / scale)} · ${lastMs} ms`;
    }
    /** Frame f of node id is in the cache under the key renderNode used: remembered for the timeline's marks. */
    function noteFrame(id, f, scale, keysUsed) {
        const key = keysUsed.get(`${id}@${f}`);
        if (!key) return;
        frameKeys.set(f, { key, id, scale, hash: C.upstreamHash(st.comp, id) });
        if (o.onCache) o.onCache();
    }
    /** The frames of the picture on screen as it is now set up that are kept and come back without work. */
    function cachedFrames() {
        const out = new Set();
        if (!st.comp) return out;
        const id = viewedId(), scale = scaleNow(), hash = C.upstreamHash(st.comp, id);
        for (const [f, e] of frameKeys) if (e.id === id && e.scale === scale && e.hash === hash && heavy.has(e.key)) out.add(f);
        return out;
    }
    // ── rendering ahead: while nothing else happens, the next frames of the picture on screen are made and kept
    // (only the picture itself, so the cache holds frames rather than every node of a few), at most AHEAD and
    // at most half the cache; it stops at the first change, a newer draw or playback, and starts again later.
    function aheadSoon() {
        if (ahead) { clearTimeout(ahead.t); ahead.stop = true; ahead = null; }
        if (!st.comp || (o.playing && o.playing())) return;
        const job = { stop: false, gen: renderGen, t: 0 };
        job.t = win().setTimeout(() => aheadRun(job), 400);
        ahead = job;
    }
    async function aheadRun(job) {
        const id = viewedId(), scale = scaleNow(), F = st.comp.format.frames, start = st.frame;
        const fb = Math.max(1, Math.round(viewFmt().width * scale) * Math.round(viewFmt().height * scale) * 16);
        const n = Math.min(AHEAD, F - 1, Math.floor(CACHE_BYTES / 2 / fb));
        let made = 0;
        for (let k = 1; k <= n; k++) {
            if (job.stop || job.gen !== renderGen || !st.comp || (o.playing && o.playing())) return;
            const f = (start + k) % F;
            if (cachedFrames().has(f)) continue;
            const pics = new Map();
            try {
                await Promise.all(C.sourceNeeds(st.comp, id, f).map(async ({ node: nn, frame: nf }) => {
                    pics.set(`${nn.id}@${nf}`, o.loadSource ? await o.loadSource(nn, nf, { scale, format: fmt() }).catch(() => null) : null);
                }));
            } catch (_) { /* made without */ }
            if (job.stop || job.gen !== renderGen || !st.comp) return;
            const keysUsed = new Map();
            C.renderNode(st.comp, id, f, { scale, source: (s2, nf) => pics.get(`${s2.id}@${nf}`) || null, cache: heavy, matte,
                ocio: lutOf, cacheIds: new Set([id]), cacheBytes: CACHE_BYTES, keysUsed });
            noteFrame(id, f, scale, keysUsed);
            made++;
            // A breath between frames, so the page stays live.
            await new Promise((r) => win().setTimeout(r, 0));
        }
        if (job === ahead) ahead = null;
        return made;
    }
    function layoutCanvas() {
        if (!st.comp) return;
        const W = stage.clientWidth || 1, H = stage.clientHeight || 1;
        const vf = viewFmt(), cw = vf.width, ch = vf.height;
        if (st.zoom.fit) {
            const s = Math.min((W - 24) / cw, (H - 24) / ch);
            st.zoom.s = s > 0 ? s : 1;
            st.zoom.x = (W - cw * st.zoom.s) / 2; st.zoom.y = (H - ch * st.zoom.s) / 2;
        }
        canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
        canvas.style.transform = `translate(${st.zoom.x}px, ${st.zoom.y}px) scale(${st.zoom.s})`;
        over.setAttribute("width", cw); over.setAttribute("height", ch);
        over.style.transform = canvas.style.transform;
        if (o.onView) o.onView();
    }
    stage.addEventListener("wheel", (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const k = Math.exp(-e.deltaY * 0.0015);
        st.zoom.fit = false;
        st.zoom.x = px - (px - st.zoom.x) * k; st.zoom.y = py - (py - st.zoom.y) * k; st.zoom.s *= k;
        layoutCanvas();
    }, { passive: false });
    stage.addEventListener("pointerdown", (e) => {
        root.focus({ preventScroll: true });
        // E held: a drag sideways changes the exposure, as in the viewer.
        if (e.button === 0 && o.exposureHeld && o.exposureHeld()) {
            e.preventDefault(); stage.setPointerCapture(e.pointerId);
            let lx = e.clientX;
            stage.onpointermove = (ev) => { o.nudgeExposure((ev.clientX - lx) * 0.02); lx = ev.clientX; };
            stage.onpointerup = () => { stage.onpointermove = null; };
            return;
        }
        if (e.button === 0 && st.pick) { e.preventDefault(); pickAt(compXY(e)); return; }
        // Otherwise the left or the middle button pans the picture - the left one not while the Roto tool owns it.
        if (e.button !== 0 && e.button !== 1) return;
        if (e.button === 0 && st.toolOn) return;
        e.preventDefault(); stage.setPointerCapture(e.pointerId);
        const sx = e.clientX, sy = e.clientY, ox = st.zoom.x, oy = st.zoom.y;
        stage.onpointermove = (ev) => { st.zoom.fit = false; st.zoom.x = ox + ev.clientX - sx; st.zoom.y = oy + ev.clientY - sy; layoutCanvas(); };
        stage.onpointerup = () => { stage.onpointermove = null; };
    });
    stage.addEventListener("dblclick", () => { if (st.toolOn) return; st.zoom.fit = true; layoutCanvas(); });

    // ── on the picture: Roto shapes and the colour picker ────────────────────
    function compXY(e) {
        const r = stage.getBoundingClientRect();
        return [(e.clientX - r.left - st.zoom.x) / st.zoom.s, (e.clientY - r.top - st.zoom.y) / st.zoom.s];
    }
    /** A Roto node's matte for the preview: the page's (the viewer's Roto code), at W x H of the comp's frame. */
    function matte(n, f, W, H) {
        return o.rotoMatte ? o.rotoMatte(n.roto, f, fmt().width, fmt().height, W, H, doc) : null;
    }
    /** The Roto tool wrote a node's shapes: changes that come close together are one undo step. */
    let rotoBurst = 0;
    function setRoto(id, value) {
        const n = node(id);
        if (!n) return;
        if (liveBak.size) liveRestore();
        if (!rotoBurst) st.hist.push(st.comp);
        win().clearTimeout(rotoBurst);
        rotoBurst = win().setTimeout(() => { rotoBurst = 0; }, 600);
        if (value) n.roto = value; else delete n.roto;
        st.dirty = true;
        refresh(["bar", "stage", "graph"]);
    }
    function renderOverlay() {
        over.replaceChildren();
        stage.classList.toggle("picking", !!st.pick);
        drawHandles();
        if (o.onView) o.onView();
    }
    /** The points of the selected node that are dragged on the picture: [{param, at: [x, y], set(xy) -> value, small?}]. */
    function handlesOf(n) {
        const F = inFmt(n), mid = [F.width / 2, F.height / 2];
        const at = (p, def) => C.paramAt(n, p, st.frame) || def;
        const r1 = (v) => Math.round(v * 10) / 10;
        if (n.type === "lensflare") return [{ param: "position", at: at("position", mid), set: (xy) => [r1(xy[0]), r1(xy[1])], title: "The light" }];
        return [];
    }
    let layer = over;   // where the handles go: a group in the pixels of the selected node's input
    function drawHandles() {
        const n = primary();
        if (!n || n.disable) return;
        st.hoff = downBy(inFmt(n));
        layer = svgEl(doc, "g", { transform: `translate(0 ${st.hoff})` });
        over.append(layer);
        if (n.type === "transform") { drawJack(n); return; }
        if (n.type === "crop") { drawCropBox(n); return; }
        const hs = handlesOf(n);
        if (!hs.length) return;
        const z = st.zoom.s || 1;
        hs.forEach((h) => {
            const g = svgEl(doc, "circle", { class: "cp-handle" + (h.small ? " small" : ""), cx: h.at[0], cy: h.at[1], r: (h.small ? 4 : 7) / z });
            g.dataset.param = h.param;
            const tip = svgEl(doc, "title", {}); tip.textContent = `${h.title} (${h.param}): drag`; g.append(tip);
            g.addEventListener("pointerdown", (e) => dragPatch(e, n.id, (xy0, xy) => ({ [h.param]: h.set([h.at[0] + xy[0] - xy0[0], h.at[1] + xy[1] - xy0[1]]) })));
            layer.append(g);
            if (!h.small) {
                const k = 11 / z;
                layer.append(svgEl(doc, "line", { class: "cp-hline", x1: h.at[0] - k, y1: h.at[1], x2: h.at[0] + k, y2: h.at[1] }));
                layer.append(svgEl(doc, "line", { class: "cp-hline", x1: h.at[0], y1: h.at[1] - k, x2: h.at[0], y2: h.at[1] + k }));
            }
        });
    }
    const tipped = (elm, text) => { const t = svgEl(doc, "title", {}); t.textContent = text; elm.append(t); return elm; };
    const ROUND = { translate: 10, center: 10, rotate: 100, scale: 1000, skew: 1000, topleft: 10, bottomright: 10 };
    const rounded = (p, v) => { const k = ROUND[p] || 1000, r = (x) => Math.round(x * k) / k; return Array.isArray(v) ? v.map(r) : r(v); };
    /** The Transform's jack: move (the middle), the centre (Ctrl), the ring and its squares (scale), the bars (turn, skew). */
    function drawJack(n) {
        const z = st.zoom.s || 1;
        const v = J.transformValues((p) => C.paramAt(n, p, st.frame), inFmt(n));
        const g = J.jackGeom(v, z);
        const part = (elm, name, tip) => {
            elm.dataset.jack = name;
            tipped(elm, tip);
            elm.addEventListener("pointerdown", (e) => {
                const which = name === "move" && (e.ctrlKey || e.metaKey) ? "centre" : name;
                const v0 = J.transformValues((p) => C.paramAt(node(n.id), p, st.frame), inFmt(n));
                dragPatch(e, n.id, (xy0, xy, ev) => J.jackDrag(which, v0, xy0, xy, z, { shift: ev.shiftKey }));
            });
            layer.append(elm);
            return elm;
        };
        const pts = (a) => a.map((p) => p.join(",")).join(" ");
        // The inside of the ring moves it too (as the middle does); drawn first so the rest lies over it.
        part(svgEl(doc, "polygon", { class: "cp-jfill", points: pts(g.ring) }), "move", "Drag: move · Shift: along one axis · Ctrl: move the centre only");
        part(svgEl(doc, "polygon", { class: "cp-jring", points: pts(g.ring) }), "ring", "Drag the ring: scale evenly");
        layer.append(svgEl(doc, "line", { class: "cp-jaxis", x1: g.O[0], y1: g.O[1], x2: g.rot[0], y2: g.rot[1] }));
        layer.append(svgEl(doc, "line", { class: "cp-jaxis", x1: g.O[0], y1: g.O[1], x2: g.skew[0], y2: g.skew[1] }));
        part(svgEl(doc, "circle", { class: "cp-jbar rot", cx: g.rot[0], cy: g.rot[1], r: 5 / z }), "rot", "Drag: turn (rotate) · Shift: in 15° steps");
        part(svgEl(doc, "circle", { class: "cp-jbar skew", cx: g.skew[0], cy: g.skew[1], r: 4 / z }), "skew", "Drag sideways: skew");
        for (const [k, tip] of [["e", "Drag: scale across · Shift: evenly"], ["w", "Drag: scale across · Shift: evenly"], ["n", "Drag: scale up and down · Shift: evenly"], ["s", "Drag: scale up and down · Shift: evenly"]]) {
            const q = g[k], h = 4 / z;
            part(svgEl(doc, "rect", { class: "cp-jsq", x: q[0] - h, y: q[1] - h, width: 2 * h, height: 2 * h }), k, tip);
        }
        const c = 9 / z;
        part(svgEl(doc, "circle", { class: "cp-jctr", cx: g.O[0], cy: g.O[1], r: c }), "move", "Drag: move · Shift: along one axis · Ctrl: move the centre only");
        layer.append(svgEl(doc, "line", { class: "cp-hline", x1: g.O[0] - c * 1.6, y1: g.O[1], x2: g.O[0] + c * 1.6, y2: g.O[1] }));
        layer.append(svgEl(doc, "line", { class: "cp-hline", x1: g.O[0], y1: g.O[1] - c * 1.6, x2: g.O[0], y2: g.O[1] + c * 1.6 }));
    }
    /** The Crop's box: an edge or a corner moves those sides, inside moves the box. */
    function drawCropBox(n) {
        const z = st.zoom.s || 1, F = inFmt(n);
        const tl = C.paramAt(n, "topleft", st.frame) || [0, 0], br = C.paramAt(n, "bottomright", st.frame) || [F.width, F.height];
        const x0 = Math.min(tl[0], br[0]), x1 = Math.max(tl[0], br[0]), y0 = Math.min(tl[1], br[1]), y1 = Math.max(tl[1], br[1]);
        const part = (elm, name, tip) => {
            elm.dataset.crop = name;
            tipped(elm, tip);
            elm.addEventListener("pointerdown", (e) => {
                const a = (C.paramAt(node(n.id), "topleft", st.frame) || [0, 0]).slice(), b = (C.paramAt(node(n.id), "bottomright", st.frame) || [F.width, F.height]).slice();
                dragPatch(e, n.id, (xy0, xy) => J.cropDrag(name, a, b, [xy[0] - xy0[0], xy[1] - xy0[1]]));
            });
            layer.append(elm);
        };
        part(svgEl(doc, "rect", { class: "cp-cinside", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }), "inside", "Drag: move the box");
        const w = 9;   // screen pixels (the stroke does not scale)
        part(svgEl(doc, "line", { class: "cp-cedge", x1: x0, y1: y0, x2: x1, y2: y0, "stroke-width": w }), "t", "Drag: the top edge");
        part(svgEl(doc, "line", { class: "cp-cedge", x1: x0, y1: y1, x2: x1, y2: y1, "stroke-width": w }), "b", "Drag: the bottom edge");
        part(svgEl(doc, "line", { class: "cp-cedge", x1: x0, y1: y0, x2: x0, y2: y1, "stroke-width": w }), "l", "Drag: the left edge");
        part(svgEl(doc, "line", { class: "cp-cedge", x1: x1, y1: y0, x2: x1, y2: y1, "stroke-width": w }), "r", "Drag: the right edge");
        layer.append(svgEl(doc, "rect", { class: "cp-hline solid", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
        const h = 4 / z;
        for (const [name, x, y] of [["tl", x0, y0], ["tr", x1, y0], ["bl", x0, y1], ["br", x1, y1]])
            part(svgEl(doc, "rect", { class: "cp-jsq", x: x - h, y: y - h, width: 2 * h, height: 2 * h }), name, "Drag: this corner");
    }
    /** A handle dragged: compute(xy0, xy, ev) gives the values; at the playhead (a key there when animated); one undo step. */
    function dragPatch(e, id, compute) {
        if (e.button !== 0 || st.pick) return;
        e.preventDefault(); e.stopPropagation();
        stage.setPointerCapture(e.pointerId);
        const specs = C.NODE_TYPES[node(id).type].params;
        // In the pixels of the node's input (the handles' group is shifted by st.hoff).
        const at = (ev) => { const p = compXY(ev); return [p[0], p[1] - (st.hoff || 0)]; };
        const xy0 = at(e);
        let pushed = false;
        stage.onpointermove = (ev) => {
            const xy = at(ev);
            if (!pushed) { if (Math.hypot(xy[0] - xy0[0], xy[1] - xy0[1]) * (st.zoom.s || 1) < 2) return; st.hist.push(st.comp); pushed = true; }
            const patch = compute(xy0, xy, ev), n = node(id);
            for (const [p, raw] of Object.entries(patch)) {
                const v = rounded(p, raw);
                if (specs[p] && specs[p].key) Mo.setProp(keyHost(), n, p, v, st.frame); else n[p] = v;
            }
            renderOverlay(); queueRender();
        };
        stage.onpointerup = () => {
            stage.onpointermove = null; stage.onpointerup = null;
            if (pushed) { st.dirty = true; refresh(["bar", "props", "stage", "graph"]); }
        };
    }
    function startPick(nodeId, param) {
        st.pick = { node: nodeId, param };
        renderOverlay();
        toast("Click the picture to take its colour", "info");
    }
    function pickAt(xy) {
        const pk = st.pick;
        st.pick = null;
        renderOverlay();
        const n = node(pk.node);
        if (!n || !lastPics) return;
        // The colour that goes INTO the node (what a keyer sees), else what is on screen.
        const srcId = n.inputs && n.inputs[0] ? n.inputs[0] : viewedId();
        const { pics, scale, frame } = lastPics;
        const img = C.renderNode(st.comp, srcId, frame, { scale, source: (s, nf) => pics.get(`${s.id}@${nf}`) || null, cache: heavy, matte,
            ocio: lutOf, cacheAll: true, cacheBytes: CACHE_BYTES });
        const dy = downBy(C.formatAt(st.comp, srcId));   // the picture clicked on and the one read may differ in size
        const x = Math.max(0, Math.min(img.w - 1, Math.floor(xy[0] * scale))), y = Math.max(0, Math.min(img.h - 1, Math.floor((xy[1] - dy) * scale)));
        const i = (y * img.w + x) * 4, a = img.data[i + 3];
        const old = C.paramAt(n, pk.param, st.frame) || [0, 0, 0, 1];
        const c = a > 0 ? [img.data[i] / a, img.data[i + 1] / a, img.data[i + 2] / a, old[3]] : [img.data[i], img.data[i + 1], img.data[i + 2], old[3]];
        mutate(() => Mo.setProp(keyHost(), n, pk.param, c.map((v) => r3(v)), st.frame), { structure: false });
    }

    // ── the node graph ───────────────────────────────────────────────────────
    function gxy(e) {
        const r = graph.getBoundingClientRect();
        return [(e.clientX - r.left - st.graph.x) / st.graph.s, (e.clientY - r.top - st.graph.y) / st.graph.s];
    }
    function placeWorld() {
        world.style.transform = `translate(${st.graph.x}px, ${st.graph.y}px) scale(${st.graph.s})`;
        // The grid: a line every cell, a stronger one every fourth; the cells are left out when they get too small to see.
        const g = C.GRID * st.graph.s, G = g * 4;
        if (!st.grid.show) { graph.style.backgroundImage = ""; graph.dataset.grid = "off"; }
        else {
            const line = (c) => [`linear-gradient(${c} 1px, transparent 1px)`, `linear-gradient(90deg, ${c} 1px, transparent 1px)`];
            const minor = g >= 6;
            graph.style.backgroundImage = [...line("#ffffff1c"), ...(minor ? line("#ffffff0b") : [])].join(",");
            graph.style.backgroundSize = [`${G}px ${G}px`, `${G}px ${G}px`, ...(minor ? [`${g}px ${g}px`, `${g}px ${g}px`] : [])].join(",");
            const at = `${st.graph.x}px ${st.graph.y}px`;
            graph.style.backgroundPosition = [at, at, ...(minor ? [at, at] : [])].join(",");
            graph.dataset.grid = minor ? "cells" : "major";
        }
        gridBtn.classList.toggle("on", st.grid.show);
        snapBtn.classList.toggle("on", st.grid.snap);
    }
    function setGrid(patch) {
        Object.assign(st.grid, patch);
        keepGrid(st.grid);
        placeWorld();
    }
    /** The Align menu: the selected nodes lined up (one undo step); "Snap to grid" takes every node when none is. */
    function alignItems() {
        const ids = st.sel.filter((id) => node(id));
        const n = ids.length;
        const run = (how) => () => {
            const which = how === "grid" && !n ? st.comp.nodes.map((x) => x.id) : ids;
            mutate(() => { C.alignNodes(st.comp, which, how, { snap: st.grid.snap }); }, { structure: false });
        };
        return [
            [n ? `Snap ${n === 1 ? "the node" : `the ${n} nodes`} to the grid` : "Snap every node to the grid", run("grid")],
            null,
            ["Align left edges", run("left"), n >= 2], ["Align in a column", run("centre"), n >= 2], ["Align right edges", run("right"), n >= 2],
            null,
            ["Align top edges", run("top"), n >= 2], ["Align in a row", run("middle"), n >= 2], ["Align bottom edges", run("bottom"), n >= 2],
            null,
            ["Spread out across", run("hspace"), n >= 3], ["Spread out down", run("vspace"), n >= 3],
        ];
    }
    function frameAll() {
        const ns = st.comp.nodes;
        if (!ns.length) return;
        const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
        const x0 = Math.min(...xs) - 30, x1 = Math.max(...xs) + C.NODE_W + 30, y0 = Math.min(...ys) - 40, y1 = Math.max(...ys) + C.NODE_H + 40;
        const W = graph.clientWidth || 400, H = graph.clientHeight || 300;
        const s = Math.max(0.2, Math.min(1.5, Math.min(W / (x1 - x0), H / (y1 - y0))));
        st.graph = { s, x: (W - (x1 - x0) * s) / 2 - x0 * s, y: (H - (y1 - y0) * s) / 2 - y0 * s, fitted: true };
        placeWorld();
    }
    const portX = (n, i) => C.portX(n, i);
    function wirePath(x1, y1, x2, y2) {
        const c = C.wireCurve(x1, y1, x2, y2);
        return `M${c[0][0]},${c[0][1]} C${c[1][0]},${c[1][1]} ${c[2][0]},${c[2][1]} ${c[3][0]},${c[3][1]}`;
    }
    function renderGraph() {
        for (const n of [...world.querySelectorAll(".cp-node")]) n.remove();
        wires.replaceChildren();
        const viewed = viewedId();
        for (const n of st.comp.nodes) {
            const t = C.NODE_TYPES[n.type];
            const box = el(doc, "div", "cp-node" + (st.sel.includes(n.id) ? " sel" : "") + (n.id === viewed ? " viewed" : "") + (n.disable ? " off" : ""));
            box.dataset.id = n.id;
            box.style.left = n.x + "px"; box.style.top = n.y + "px";
            box.style.background = CAT_COLOR[t.cat] || "#ccc";
            box.append(el(doc, "span", "cp-nm", n.name || n.id));
            const sub = n.type === "read" ? C.sourceName(n) : n.type === "merge" ? (n.operation || "over") : n.type === "roto" ? `${((n.roto && n.roto.layers) || []).length} shape(s)` : "";
            if (sub && sub !== (n.name || n.id)) box.append(el(doc, "span", "cp-sub", sub));
            t.inputs.forEach((label, i) => {
                const p = el(doc, "div", "cp-port in"); p.dataset.port = String(i); p.dataset.id = n.id; p.style.left = portX(n, i) + "px";
                p.title = `${label} input`;
                box.append(p);
                if (t.inputs.length > 1) { const l = el(doc, "span", "cp-plabel", label); l.style.left = portX(n, i) + "px"; box.append(l); }
            });
            if (n.type !== "output") { const p = el(doc, "div", "cp-port out"); p.dataset.out = n.id; p.title = "Drag onto an input to connect"; box.append(p); }
            const isViewed = n.id === viewed;
            const eye = el(doc, "span", "cp-eye", "👁");
            eye.dataset.eye = n.id;
            eye.title = isViewed ? (n.id === st.comp.output ? "The picture shows the comp's Output" : "Shown in the picture: click to show the Output again")
                : "Show this node in the picture (1)";
            box.append(eye);
            if (isViewed) box.append(el(doc, "span", "cp-vtag", n.id === st.comp.output ? "OUTPUT" : "VIEWER"));
            world.append(box);
            n.inputs.forEach((src, i) => {
                const s = src && node(src);
                if (!s) return;
                const path = svgEl(doc, "path", { d: wirePath(s.x + C.NODE_W / 2, s.y + C.NODE_H, n.x + portX(n, i), n.y),
                    fill: "none", stroke: i === 2 ? "#bbb" : i === 1 && (n.type === "merge" || n.type === "copy") ? "#ffcf3a" : i === 1 ? "#8fd0ff" : "#e8e8ea", "stroke-width": 1.6,
                    "stroke-dasharray": i === 2 ? "4 3" : "" });
                path.dataset.wire = `${src}>${n.id}:${i}`;
                if (st.wireHot === path.dataset.wire) path.classList.add("cp-wire-hot");
                wires.append(path);
            });
        }
        placeWorld();
        if (!st.graph.fitted && graph.clientWidth) frameAll();
    }
    /** Each selected node's batch: the nodes that joined the selection together share one (the layout gesture's order). */
    function syncBatches() {
        const live = new Set(st.sel);
        for (const id of [...st.batch.keys()]) if (!live.has(id)) st.batch.delete(id);
        let fresh = false;
        for (const id of st.sel) if (!st.batch.has(id)) { if (!fresh) { st.batchN++; fresh = true; } st.batch.set(id, st.batchN); }
    }
    function select(ids, { add = false } = {}) {
        st.sel = add ? [...new Set([...st.sel, ...ids])] : ids.slice();
        if (!add) st.batch.clear();
        syncBatches();
        refresh(["graph", "props", "layers"]);
        renderOverlay();
        if (o.onSelect) o.onSelect(primary());
    }
    graph.addEventListener("wheel", (e) => {
        if (e.target.closest && e.target.closest(".cp-tabmenu, .mg-ctx")) return;   // a menu scrolls
        e.preventDefault();
        const r = graph.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const k = Math.exp(-e.deltaY * 0.0015);
        const s = Math.max(0.15, Math.min(3, st.graph.s * k));
        const kk = s / st.graph.s;
        st.graph.x = px - (px - st.graph.x) * kk; st.graph.y = py - (py - st.graph.y) * kk; st.graph.s = s;
        placeWorld();
    }, { passive: false });
    graph.addEventListener("pointerdown", (e) => {
        graph.focus({ preventScroll: true });
        closeMenus();
        const target = e.target;
        if (e.button === 1 || (e.button === 0 && e.altKey)) return panGraph(e);
        if (e.button !== 0) return;
        if (st.held === "y") return cutDrag(e);
        if (st.held === "a" && st.sel.filter((id) => node(id)).length >= 2) return layoutDrag(e);
        if (target.dataset && target.dataset.eye) {
            e.preventDefault(); e.stopPropagation();
            const id = target.dataset.eye;
            return setView(id === viewedId() ? st.comp.output : id);
        }
        if (target.dataset && target.dataset.out) return dragWire(e, target.dataset.out, null);
        if (target.classList && target.classList.contains("in")) {
            const dst = node(target.dataset.id), port = Number(target.dataset.port);
            const src = dst && dst.inputs[port];
            return dragWire(e, src, { dst: dst.id, port });
        }
        const box = target.closest ? target.closest(".cp-node") : null;
        if (box) return dragNodes(e, box.dataset.id);
        return marquee(e);
    });
    graph.addEventListener("dblclick", (e) => {
        const box = e.target.closest ? e.target.closest(".cp-node") : null;
        if (box) { select([box.dataset.id]); if (o.showProps) o.showProps(); }
    });
    function panGraph(e) {
        e.preventDefault(); graph.setPointerCapture(e.pointerId);
        const sx = e.clientX, sy = e.clientY, ox = st.graph.x, oy = st.graph.y;
        graph.onpointermove = (ev) => { st.graph.x = ox + ev.clientX - sx; st.graph.y = oy + ev.clientY - sy; placeWorld(); };
        graph.onpointerup = () => { graph.onpointermove = null; };
    }
    function dragNodes(e, id) {
        e.preventDefault(); graph.setPointerCapture(e.pointerId);
        if (e.shiftKey || e.ctrlKey) {
            // (A gesture before this one left its handlers: a marquee's let-go once emptied the selection here.)
            graph.onpointermove = null; graph.onpointerup = null;
            st.sel = st.sel.includes(id) ? st.sel.filter((x) => x !== id) : [...st.sel, id];
            syncBatches();
            refresh(["graph", "props", "layers"]);
            return;
        }
        if (!st.sel.includes(id)) select([id]);
        else { st.sel = [...st.sel.filter((x) => x !== id), id]; refresh(["props", "layers"]); }
        const [sx, sy] = gxy(e);
        const start = new Map(st.sel.map((sid) => [sid, [node(sid).x, node(sid).y]]));
        let moved = false;
        const [px0, py0] = start.get(id);
        graph.onpointermove = (ev) => {
            const [x, y] = gxy(ev);
            if (!moved && Math.hypot(x - sx, y - sy) < 3) return;
            if (!moved) { st.hist.push(st.comp); moved = true; }
            // Snapping: the pressed node lands on the grid and the others keep their places to it. Shift: freely.
            let dx = x - sx, dy = y - sy;
            if (st.grid.snap && !ev.shiftKey) { dx = C.snapTo(px0 + dx) - px0; dy = C.snapTo(py0 + dy) - py0; }
            for (const [sid, [x0, y0]] of start) { const n = node(sid); if (n) { n.x = Math.round(x0 + dx); n.y = Math.round(y0 + dy); } }
            // One free node over a wire: the wire lights up, and letting go puts the node into it (Nuke's way).
            const me = start.size === 1 ? node(id) : null;
            hotWire = me ? C.wireUnder(st.comp, id, me.x + C.NODE_W / 2, me.y + C.NODE_H / 2, Math.max(8, 12 / st.graph.s)) : null;
            st.wireHot = hotWire ? `${hotWire.src}>${hotWire.dst}:${hotWire.port}` : null;
            renderGraph();
        };
        let hotWire = null;
        graph.onpointerup = () => {
            graph.onpointermove = null;
            st.wireHot = null;
            if (moved && hotWire && C.spliceNode(st.comp, id, hotWire)) { st.dirty = true; refresh(); return; }
            if (moved) { st.dirty = true; renderBar(); renderGraph(); }
        };
    }
    function dragWire(e, srcId, from) {
        e.preventDefault(); graph.setPointerCapture(e.pointerId);
        const src = srcId ? node(srcId) : null;
        const ghost = svgEl(doc, "path", { fill: "none", stroke: "#ffcf3a", "stroke-width": 1.6, "stroke-dasharray": "5 3" });
        wires.append(ghost);
        const fixed = from ? [node(from.dst).x + portX(node(from.dst), from.port), node(from.dst).y] : null;
        const draw_ = (x, y) => {
            if (from && !src) ghost.setAttribute("d", wirePath(x, y, fixed[0], fixed[1]));
            else if (src && !from) ghost.setAttribute("d", wirePath(src.x + C.NODE_W / 2, src.y + C.NODE_H, x, y));
            else ghost.setAttribute("d", wirePath(src.x + C.NODE_W / 2, src.y + C.NODE_H, x, y));
        };
        draw_(...gxy(e));
        graph.onpointermove = (ev) => draw_(...gxy(ev));
        graph.onpointerup = (ev) => {
            graph.onpointermove = null;
            ghost.remove();
            const hit = (graph.getRootNode().elementFromPoint ? graph.getRootNode() : doc).elementFromPoint(ev.clientX, ev.clientY);
            const port = hit && hit.classList && hit.classList.contains("in") ? hit : null;
            const outHit = hit && hit.dataset && hit.dataset.out ? hit.dataset.out : null;
            if (from && !src && outHit) { mutate(() => { if (!C.connect(st.comp, from.dst, from.port, outHit)) toast("That would make a loop", "warn"); }); return; }
            if (port && src) {
                const dst = port.dataset.id, p = Number(port.dataset.port);
                mutate(() => {
                    if (from) C.disconnect(st.comp, from.dst, from.port);
                    if (!C.connect(st.comp, dst, p, src.id)) toast("That would make a loop", "warn");
                });
            } else if (from && src) mutate(() => C.disconnect(st.comp, from.dst, from.port));
            else renderGraph();
        };
    }
    /** A held + drag: the selected nodes in one row (a drag across) or one column (a drag down), in the order they
     *  were picked, gliding there; the axis follows the drag and can change while it lasts. One undo step. */
    const LAYOUT_MS = 180;
    function layoutDrag(e) {
        e.preventDefault(); e.stopPropagation(); graph.setPointerCapture(e.pointerId);
        syncBatches();
        const [sx, sy] = gxy(e);
        const items = st.sel.map(node).filter(Boolean).map((n) => ({ id: n.id, x: n.x, y: n.y, batch: st.batch.get(n.id) }));
        const before = cloneV(st.comp);
        let axis = null, tween = null, moved = false;
        const step = () => {
            if (!tween) return;
            const t = Math.min(1, (performance.now() - tween.t0) / LAYOUT_MS), k = 1 - Math.pow(1 - t, 3);
            for (const it of tween.items) { const n = node(it.id); if (n) { n.x = Math.round(it.fx + (it.tx - it.fx) * k); n.y = Math.round(it.fy + (it.ty - it.fy) * k); } }
            renderGraph();
            if (t < 1) win().requestAnimationFrame(step); else tween = null;
        };
        graph.onpointermove = (ev) => {
            const [x, y] = gxy(ev);
            const a = C.layoutAxis(x - sx, y - sy);
            if (!a || a === axis) return;
            axis = a; moved = true;
            const to = new Map(C.layoutTargets(items, axis, { snap: st.grid.snap }).map((p) => [p.id, p]));
            const going = !tween;
            tween = { t0: performance.now(), items: items.map((it) => { const n = node(it.id); return { id: it.id, fx: n.x, fy: n.y, tx: to.get(it.id).x, ty: to.get(it.id).y }; }) };
            if (going) win().requestAnimationFrame(step);
        };
        graph.onpointerup = () => {
            graph.onpointermove = null;
            if (!moved) return;
            if (tween) { tween.t0 = -1e9; step(); }
            st.hist.push(before);
            st.dirty = true; renderBar(); renderGraph();
        };
    }
    /** Y held + drag: a red stroke; every wire it crosses is cut when let go. One undo step. */
    function cutDrag(e) {
        e.preventDefault(); e.stopPropagation(); graph.setPointerCapture(e.pointerId);
        let prev = gxy(e);
        const pts = [prev], cut = new Map();
        const line = svgEl(doc, "polyline", { class: "cp-cutline", fill: "none" });
        wires.append(line);
        const draw_ = () => {
            line.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
            for (const p of wires.querySelectorAll("path[data-wire]")) p.classList.toggle("cp-wire-cut", cut.has(p.dataset.wire));
        };
        graph.onpointermove = (ev) => {
            const q = gxy(ev);
            for (const w of C.wiresCrossed(st.comp, prev, q)) cut.set(`${w.src}>${w.dst}:${w.port}`, w);
            pts.push(q); prev = q;
            draw_();
        };
        graph.onpointerup = () => {
            graph.onpointermove = null;
            line.remove();
            if (cut.size) mutate(() => { C.cutWires(st.comp, [...cut.values()]); });
            else renderGraph();
        };
    }
    function marquee(e) {
        e.preventDefault(); graph.setPointerCapture(e.pointerId);
        const r = graph.getBoundingClientRect();
        const box = el(doc, "div", "cp-marquee");
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        let moved = false;
        graph.onpointermove = (ev) => {
            const x = ev.clientX - r.left, y = ev.clientY - r.top;
            if (!moved && Math.hypot(x - sx, y - sy) < 4) return;
            if (!moved) { graph.append(box); moved = true; }
            Object.assign(box.style, { left: Math.min(x, sx) + "px", top: Math.min(y, sy) + "px", width: Math.abs(x - sx) + "px", height: Math.abs(y - sy) + "px" });
        };
        graph.onpointerup = (ev) => {
            graph.onpointermove = null;
            if (!moved) { select([]); return; }
            box.remove();
            const toW = (px, py) => [(px - st.graph.x) / st.graph.s, (py - st.graph.y) / st.graph.s];
            const [ax, ay] = toW(Math.min(sx, ev.clientX - r.left), Math.min(sy, ev.clientY - r.top));
            const [bx, by] = toW(Math.max(sx, ev.clientX - r.left), Math.max(sy, ev.clientY - r.top));
            const ids = st.comp.nodes.filter((n) => n.x + C.NODE_W > ax && n.x < bx && n.y + C.NODE_H > ay && n.y < by).map((n) => n.id);
            select(ids, { add: ev.shiftKey });
        };
    }

    // ── menus (Motion's look) ────────────────────────────────────────────────
    let menuEl = null;
    function closeMenus() { if (menuEl) { menuEl.remove(); menuEl = null; } }
    /** A menu dropped from a button: ``items`` = [[label, fn, enabled?, keys?] | null (a line)]. */
    function popMenu(anchor, items) {
        if (menuEl && menuEl._from === anchor) { closeMenus(); return null; }
        closeMenus();
        const box = anchor.closest(".cp-graph") || root;
        const m = el(doc, "div", "mg-ctx cp-pop");
        m._from = anchor;
        for (const it of items) {
            if (!it) { m.append(el(doc, "hr")); continue; }
            const [label, fn, on = true, keys] = it;
            const d = el(doc, "div", on ? "" : "off", label);
            if (keys) d.append(el(doc, "span", "cp-k", keys));
            if (on) d.onclick = (ev) => { ev.stopPropagation(); closeMenus(); fn(); };
            m.append(d);
        }
        for (const t of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) m.addEventListener(t, (ev) => ev.stopPropagation());
        const a = anchor.getBoundingClientRect(), r = box.getBoundingClientRect();
        m.style.left = Math.max(0, a.left - r.left) + "px"; m.style.top = (a.bottom - r.top + 2) + "px";
        box.append(m);
        menuEl = m;
        const mr = m.getBoundingClientRect();
        if (mr.right > r.right) m.style.left = Math.max(0, r.width - mr.width - 4) + "px";
        if (mr.bottom > r.bottom) { m.style.maxHeight = Math.max(80, r.bottom - mr.top - 4) + "px"; m.style.overflowY = "auto"; }
        return m;
    }
    root.addEventListener("pointerdown", (e) => { if (menuEl && !e.composedPath().includes(menuEl)) closeMenus(); }, true);
    function addNodeAt(type, at) {
        mutate(() => {
            const after = primary();
            const extra = at ? { x: Math.round(at[0] - C.NODE_W / 2), y: Math.round(at[1] - C.NODE_H / 2) } : {};
            const n = C.insertNode(st.comp, type, at ? null : after && after.id, extra);
            if (st.grid.snap) { n.x = C.snapTo(n.x); n.y = C.snapTo(n.y); }
            if (type === "read" && o.pickFile) o.pickFile((path) => mutate(() => { const r = node(n.id); if (r) r.file = path; }, { structure: false }));
            st.sel = [n.id];
        });
    }
    graph.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const box = e.target.closest ? e.target.closest(".cp-node") : null;
        const at = gxy(e);
        const r = graph.getBoundingClientRect();
        const where = { left: e.clientX - r.left, top: e.clientY - r.top };
        if (box) {
            const id = box.dataset.id;
            if (!st.sel.includes(id)) select([id]);
            tabMenu(where, { actions: [
                ["View this node (1)", () => setView(id)],
                [node(id).disable ? "Enable (D)" : "Disable (D)", () => toggleDisable()],
                ["Rename…", () => renameNode(id)],
                ["Delete (Del)", () => removeSel()]] });
        } else tabMenu(where, { place: at, actions: [["Frame all (F)", frameAll]] });
    });
    function setView(id) { st.view = id === st.comp.output ? null : id; refresh(["graph", "stage"]); }
    function toggleDisable() { const ids = st.sel.filter((id) => node(id) && node(id).type !== "output"); if (ids.length) mutate(() => { const off = !ids.every((id) => node(id).disable); for (const id of ids) { if (off) node(id).disable = true; else delete node(id).disable; } }); }
    function removeSel() { const ids = st.sel.filter((id) => node(id)); if (ids.length) mutate(() => { C.removeNodes(st.comp, ids); st.sel = []; fixSel(); }); }
    function renameNode(id) {
        const box = world.querySelector(`.cp-node[data-id="${id}"]`);
        if (!box) return;
        const i = el(doc, "input", "mg-rename"); i.value = node(id).name || node(id).id;
        Object.assign(i.style, { position: "absolute", inset: "2px", width: "auto", zIndex: 5, background: "#0f0f12", color: "#fff", border: "1px solid #ff6a1a" });
        box.append(i); i.focus(); i.select();
        let done = false;
        const fin = (keep) => { if (done) return; done = true; const v = i.value.trim(); if (keep && v && v !== (node(id).name || node(id).id)) mutate(() => { node(id).name = v; }); else renderGraph(); };
        i.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") fin(true); if (e.key === "Escape") fin(false); };
        i.onblur = () => fin(true);
        i.onpointerdown = (e) => e.stopPropagation();
    }
    /** The node menu (Tab, the Add button, a right-click on the graph): a field to type into on top - a node's
     *  name, its category or its id finds it - and below it the actions given, then every node by category. The
     *  list scrolls (the graph's wheel zooms everywhere else) and is as tall as the room below it in the graph.
     *  ``at``: where it opens in the graph ({left, top}); ``place``: where a new node goes in the graph's own
     *  coordinates (null: under the selected node); ``actions``: [[label, fn]] shown first. */
    function tabMenu(at, { place = null, actions = [] } = {}) {
        closeMenus();
        const m = el(doc, "div", "cp-tabmenu");
        const inp = el(doc, "input"); inp.placeholder = "Type to find a node…"; inp.spellcheck = false;
        const list = el(doc, "div", "cp-tmlist");
        m.append(inp, list);
        for (const t of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) m.addEventListener(t, (ev) => ev.stopPropagation());
        m.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: true });
        let on = 0;
        const words = (t) => [C.NODE_TYPES[t].label, C.NODE_TYPES[t].cat || "", t].join(" ").toLowerCase();
        const rows = () => {
            const q = inp.value.trim().toLowerCase();
            const out = [];
            const acts = actions.filter((a) => a && (!q || a[0].toLowerCase().includes(q)));
            for (const a of acts) out.push({ label: a[0], run: a[1], act: true });
            const types = C.TYPE_ORDER.filter((t) => !q || q.split(/\s+/).every((w) => words(t).includes(w)));
            if (q) {
                // Names that begin with what is typed first.
                const starts = (t) => (C.NODE_TYPES[t].label.toLowerCase().startsWith(q) ? 0 : 1);
                types.sort((a, b) => starts(a) - starts(b));
                for (const t of types) out.push({ label: C.NODE_TYPES[t].label, sub: C.NODE_TYPES[t].cat, type: t });
            } else {
                const cats = [];
                for (const t of types) { const c = C.NODE_TYPES[t].cat || "Other"; if (!cats.includes(c)) cats.push(c); }
                for (const c of cats) {
                    out.push({ head: c });
                    for (const t of types) if ((C.NODE_TYPES[t].cat || "Other") === c) out.push({ label: C.NODE_TYPES[t].label, type: t });
                }
            }
            return out;
        };
        const pickable = (r) => r && !r.head;
        const choose = (r) => {
            closeMenus(); graph.focus({ preventScroll: true });
            if (!r) return;
            if (r.run) r.run(); else addNodeAt(r.type, place);
        };
        const draw_ = () => {
            const rs = rows();
            const ids = rs.map((r, i) => (pickable(r) ? i : -1)).filter((i) => i >= 0);
            if (!ids.includes(on)) on = ids.length ? ids[0] : -1;
            list.replaceChildren();
            rs.forEach((r, i) => {
                if (r.head) { list.append(el(doc, "div", "cp-tmhead", r.head)); return; }
                const d = el(doc, "div", "cp-tmrow" + (i === on ? " on" : "") + (r.act ? " act" : ""), r.label);
                if (r.sub) d.append(el(doc, "span", "cp-tmsub", r.sub));
                d.dataset.i = i;
                if (r.type) d.dataset.type = r.type;
                d.onclick = () => choose(r);
                d.onpointermove = () => { if (on !== i) { on = i; for (const x of list.querySelectorAll(".on")) x.classList.remove("on"); d.classList.add("on"); } };
                list.append(d);
            });
            if (!ids.length) list.append(el(doc, "div", "cp-tmnone", "No node by that name"));
            m._rows = rs;
        };
        const step = (dir) => {
            const rs = m._rows || [];
            let i = on;
            do { i += dir; } while (i >= 0 && i < rs.length && !pickable(rs[i]));
            if (i >= 0 && i < rs.length) on = i;
            draw_();
            const d = list.querySelector(".on");
            if (d) d.scrollIntoView({ block: "nearest" });
        };
        inp.oninput = () => { on = -1; draw_(); list.scrollTop = 0; };
        inp.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") { step(1); e.preventDefault(); }
            else if (e.key === "ArrowUp") { step(-1); e.preventDefault(); }
            else if (e.key === "PageDown" || e.key === "PageUp") { for (let k = 0; k < 8; k++) step(e.key === "PageDown" ? 1 : -1); e.preventDefault(); }
            else if (e.key === "Enter") { e.preventDefault(); choose((m._rows || [])[on]); }
            else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeMenus(); graph.focus({ preventScroll: true }); }
        };
        const W = graph.clientWidth, H = graph.clientHeight;
        let left = at ? at.left : Math.max(4, W / 2 - 100), top = at ? at.top : 30;
        left = Math.max(4, Math.min(left, W - 214));
        // Room below; when there is little of it, the menu opens higher up.
        const want = 360;
        if (H - top - 8 < Math.min(want, H * 0.6)) top = Math.max(4, H - 8 - Math.min(want, H - 12));
        m.style.left = left + "px"; m.style.top = top + "px";
        list.style.maxHeight = Math.max(80, H - top - 8 - 30) + "px";
        graph.append(m); menuEl = m;
        draw_(); inp.focus({ preventScroll: true });
        return m;
    }

    // ── keys (graph, layers, properties and the picture) ─────────────────────
    function keyDown(e, part = e.currentTarget) {
        if (e._cpDone) return true;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return false;
        const k = e.key, ctrl = e.ctrlKey || e.metaKey;
        let used = true;
        if (st.pick && k === "Escape") { st.pick = null; renderOverlay(); renderProps(); }
        else if (ctrl && k.toLowerCase() === "z") { if (e.shiftKey) redo(); else undo(); }
        else if (ctrl && k.toLowerCase() === "y") redo();
        else if (ctrl && e.shiftKey && k.toLowerCase() === "s") saveAs();
        else if (ctrl && k.toLowerCase() === "s") save();
        else if (ctrl && k.toLowerCase() === "o" && o.open) o.open();
        else if (!ctrl && !e.altKey && (k.toLowerCase() === "a" || k.toLowerCase() === "y") && part === graph) st.held = k.toLowerCase();
        else if (!ctrl && k.toLowerCase() === "g" && part === graph) setGrid({ show: !st.grid.show });
        else if (!ctrl && k.toLowerCase() === "s" && part === graph) setGrid({ snap: !st.grid.snap });
        else if (k === "Tab" && part === graph) tabMenu();
        else if ((k === "Delete" || k === "Backspace") && part !== root) removeSel();
        else if (k.toLowerCase() === "d" && !ctrl && part === graph) toggleDisable();
        else if (k === "1" && primary()) setView(primary().id);
        else if (k.toLowerCase() === "f" && part === graph) frameAll();
        else if (k.toLowerCase() === "f" && part === root) { st.zoom.fit = true; layoutCanvas(); }
        else if (!ctrl && !e.altKey && part === root && "rgba".includes(k.toLowerCase()) && k.length === 1) setChannel(st.channel === k.toLowerCase() ? "rgb" : k.toLowerCase());
        else if (k === " " && o.transport) o.transport.toggle();
        else if (k === "ArrowLeft" && o.transport) o.transport.step(-1);
        else if (k === "ArrowRight" && o.transport) o.transport.step(1);
        else used = false;
        if (used) { e.preventDefault(); e.stopPropagation(); e._cpDone = true; }
        return used;
    }
    for (const part of [graph, layers, props, root]) part.addEventListener("keydown", keyDown);
    // The gesture keys are let go: a keyup anywhere (a held key's up comes where the focus is), or the window's blur.
    const letGo = (e) => { if (!e || !e.key || ["a", "y"].includes(e.key.toLowerCase())) st.held = null; };
    root.addEventListener("keyup", letGo, true);
    graph.addEventListener("blur", () => { if (!graph.onpointermove) st.held = null; });

    // ── drops: History thumbnails / file-browser rows become Reads ───────────
    const DROP = "application/x-imageviewer-history";
    function wireDrop(target, place) {
        target.addEventListener("dragover", (e) => { if (Array.from(e.dataTransfer?.types || []).includes(DROP)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
        target.addEventListener("drop", (e) => {
            if (!Array.from(e.dataTransfer?.types || []).includes(DROP)) return;
            e.preventDefault(); e.stopPropagation();
            let payload = null;
            try { payload = JSON.parse(e.dataTransfer.getData(DROP)); } catch (_) { /* not ours */ }
            const items = payload && Array.isArray(payload.items) ? payload.items : [];
            // pathsOf may have to ask the server (an item with no path): a promise then.
            Promise.resolve(o.pathsOf ? o.pathsOf(items) : items.map((it) => it && it.path).filter(Boolean))
                .then((files) => { if (files && files.length) place(files, e); });
        });
    }
    wireDrop(graph, (files, e) => mutate(() => {
        const [x, y] = gxy(e);
        st.sel = files.map((f, i) => C.addNode(st.comp, C.makeNode(st.comp, "read", { file: f, x: Math.round(x - C.NODE_W / 2 + i * 140), y: Math.round(y) })).id);
    }));
    wireDrop(layers, (files) => mutate(() => { for (const f of files) st.sel = [C.addLayer(st.comp, C.makeNode(st.comp, "read", { file: f })).source.id]; }));
    wireDrop(stage, (files) => mutate(() => { for (const f of files) st.sel = [C.addLayer(st.comp, C.makeNode(st.comp, "read", { file: f })).source.id]; }));

    // ── properties (Motion's rows) ───────────────────────────────────────────
    const field = (label, input) => { const r = el(doc, "div", "mg-prop"); r.append(el(doc, "label", "", label), input); return r; };
    function numInput(value, step, onCommit, d = {}) {
        const i = el(doc, "input"); i.type = "number"; i.step = step || 0.01; i.value = value === null || value === undefined ? "" : r3(value);
        if (d.min !== undefined) i.min = d.min; if (d.max !== undefined) i.max = d.max;
        // A field taken out by the redraw its own change caused can report the change again on blur: once only.
        i.onchange = () => { if (i._sent === i.value) return; i._sent = i.value; const v = parseFloat(i.value); onCommit(Number.isFinite(v) ? v : null); };
        // Typed: shown at once (d.onLive), committed as one undo step at Enter / leaving the field.
        if (d.onLive) i.oninput = () => {
            const v = parseFloat(i.value);
            if (!Number.isFinite(v)) return;
            const lo = d.min !== undefined ? d.min : -Infinity, hi = d.max !== undefined ? d.max : Infinity;
            d.onLive(Math.min(hi, Math.max(lo, v)));
        };
        // Up / Down: a step (Shift x10, Ctrl / Alt x0.1), and the field keeps the focus after the redraw.
        i.addEventListener("keydown", (e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault(); e.stopPropagation();
            const k = e.shiftKey ? 10 : (e.ctrlKey || e.metaKey || e.altKey) ? 0.1 : 1;
            const v = (parseFloat(i.value) || 0) + (e.key === "ArrowUp" ? 1 : -1) * (parseFloat(step) || 0.01) * k;
            const lo = d.min !== undefined ? d.min : -Infinity, hi = d.max !== undefined ? d.max : Infinity;
            if (i.dataset.fk) st.refocus = i.dataset.fk;
            if (d.onStep) { d.onStep((e.key === "ArrowUp" ? 1 : -1) * (parseFloat(step) || 0.01) * k, lo, hi); return; }
            onCommit(Math.round(Math.min(hi, Math.max(lo, v)) * 1e6) / 1e6);
        });
        return i;
    }
    const withFk = (i, o2) => { i.title = o2.title; i.dataset.fk = o2.fk; return i; };
    /** A number's label dragged left / right changes it live (Shift x10, Ctrl / Alt x0.1); one undo step. */
    function scrubLabel(lab, inp, id, p, d) {
        lab.classList.add("cp-scrub");
        lab.title = `${lab.title} - drag left or right to change it (Shift faster, Ctrl finer)`;
        lab.onpointerdown = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const step = d.kind === "int" ? 0.25 : (d.step || 0.01);
            const n0 = node(id);
            const starts = targetsOf(n0).map((t) => [t.id, Number(C.paramAt(t, p, st.frame)) || 0]);
            let last = e.clientX, acc = 0, pushed = false;
            lab.setPointerCapture(e.pointerId);
            lab.onpointermove = (ev) => {
                const dx = ev.clientX - last;
                if (!pushed && Math.abs(ev.clientX - e.clientX) < 3) return;
                if (!pushed) { st.hist.push(st.comp); pushed = true; }
                last = ev.clientX;
                acc += dx * step * (ev.shiftKey ? 10 : (ev.ctrlKey || ev.metaKey || ev.altKey) ? 0.1 : 1);
                for (const [tid, v0] of starts) {
                    let v = v0 + acc;
                    if (d.min !== undefined) v = Math.max(d.min, v);
                    if (d.max !== undefined) v = Math.min(d.max, v);
                    v = d.kind === "int" ? Math.round(v) : Math.round(v * 1e4) / 1e4;
                    const t = node(tid);
                    if (!t) continue;
                    if (d.key) Mo.setProp(keyHost(), t, p, v, st.frame); else t[p] = v;
                    if (tid === id && !inp.classList.contains("cp-mixed")) inp.value = r3(v);
                }
                queueRender(); renderOverlay();
            };
            lab.onpointerup = () => {
                lab.onpointermove = null; lab.onpointerup = null;
                if (pushed) { st.dirty = true; refresh(["bar", "props", "stage", "graph"]); }
            };
        };
    }
    function paramRow(n, p, d) {
        const row = el(doc, "div", "mg-prop");
        const animated = d.key && Mo.isAnimated(n, p);
        const tg = targetsOf(n);
        const cur = C.paramAt(n, p, st.frame);
        const mixed = tg.some((t) => !sameVal(C.paramAt(t, p, st.frame), cur));
        if (mixed) { row.classList.add("cp-mixedrow"); row.title = `Differs across the ${tg.length} selected nodes: a change sets it on all of them`; }
        if (d.key) {
            const sw = el(doc, "span", "mg-sw" + (animated ? " on" : ""), "⏱");
            sw.title = animated ? "Animated: click to stop animating (keeps the value at the playhead)" : "Click to animate (a key at the playhead)";
            sw.onclick = () => mutate(() => {
                for (const t of tg) {
                    if (!!Mo.isAnimated(t, p) !== !!animated) continue;
                    if (!animated && (t[p] === undefined || t[p] === null)) t[p] = C.paramAt(t, p, st.frame) ?? (p === "center" || p === "position" ? [inFmt(t).width / 2, inFmt(t).height / 2] : d.def);
                    Mo.toggleAnimated(keyHost(), t, p, st.frame);
                }
            }, { structure: false });
            row.append(sw);
        } else row.append(el(doc, "span", "mg-sw", ""));
        const lab = el(doc, "label", "", d.label || p); lab.title = d.help ? `${p}: ${d.help}` : p;
        row.append(lab);
        const write = (v) => mutate(() => writeAll(n, p, d, () => v), { structure: false });
        const mix = (i) => { if (mixed) { i.value = ""; i.placeholder = "—"; i.classList.add("cp-mixed"); } return i; };
        if (d.kind === "num" || d.kind === "int") {
            const onStep = tg.length > 1 ? (dl, lo, hi) => mutate(() => writeAll(n, p, d, (old) => {
                const v = Math.round(Math.min(hi, Math.max(lo, (Number(old) || 0) + dl)) * 1e6) / 1e6;
                return d.kind === "int" ? Math.round(v) : v;
            }), { structure: false }) : undefined;
            const onLive = (v) => liveWrite(n, p, d, () => (d.kind === "int" ? Math.round(v) : v));
            const inp = mix(numInput(cur, d.kind === "int" ? 1 : d.step, (v) => { if (v !== null) write(d.kind === "int" ? Math.round(v) : v); }, Object.assign({}, d, { onStep, onLive })));
            inp.dataset.fk = `${n.id}:${p}`;
            scrubLabel(lab, inp, n.id, p, d);
            row.append(inp);
        }
        else if (d.kind === "vec2") {
            const mid = p === "center" || p === "position";
            const base = cur || (mid ? [inFmt(n).width / 2, inFmt(n).height / 2] : [0, 0]);
            const axisMixed = (a) => tg.some((t) => { const tv = C.paramAt(t, p, st.frame); return (tv ? tv[a] : null) !== (cur ? cur[a] : null); });
            for (let a = 0; a < 2; a++) {
                const i = withFk(numInput(cur ? cur[a] : null, d.step || 1, (v) => {
                    if (v === null && mid && !animated) { mutate(() => { for (const t of tg) if (!Mo.isAnimated(t, p)) delete t[p]; }, { structure: false }); return; }
                    if (v === null) return;
                    mutate(() => writeAll(n, p, d, (old) => { const nv = (old || base).slice(); nv[a] = v; return nv; }), { structure: false });
                }, { onLive: (v) => liveWrite(n, p, d, (old) => { const nv = (old || base).slice(); nv[a] = v; return nv; }) }), { title: a ? "y (pixels, down)" : "x (pixels)", fk: `${n.id}:${p}:${a}` });
                if (axisMixed(a)) { i.value = ""; i.placeholder = "—"; i.classList.add("cp-mixed"); }
                row.append(i);
            }
        } else if (d.kind === "color") {
            const c = cur || [0, 0, 0, 1];
            const pick = el(doc, "input"); pick.type = "color"; pick.value = toHex(c);
            pick.oninput = () => { const rgb = fromHex(pick.value, 1); liveWrite(n, p, d, (old) => [rgb[0], rgb[1], rgb[2], (old || c)[3]]); };
            pick.onchange = () => { const rgb = fromHex(pick.value, 1); mutate(() => writeAll(n, p, d, (old) => [rgb[0], rgb[1], rgb[2], (old || c)[3]]), { structure: false }); };
            const alpha = numInput(c[3], 0.01, (v) => { if (v !== null) mutate(() => writeAll(n, p, d, (old) => { const o2 = old || c; return [o2[0], o2[1], o2[2], Math.max(0, Math.min(1, v))]; }), { structure: false }); },
                { min: 0, max: 1, onLive: (v) => liveWrite(n, p, d, (old) => { const o2 = old || c; return [o2[0], o2[1], o2[2], v]; }) });
            if (tg.some((t) => (C.paramAt(t, p, st.frame) || c)[3] !== c[3])) { alpha.value = ""; alpha.placeholder = "—"; alpha.classList.add("cp-mixed"); }
            row.append(pick, alpha,
                btn("⌖", "Take the colour from the picture (what goes into this node)", () => startPick(n.id, p), st.pick && st.pick.node === n.id ? "on" : ""));
            pick.title = "Colour (shown in sRGB, kept linear)";
        } else if (d.kind === "ocio_cs" || d.kind === "ocio_display" || d.kind === "ocio_view") {
            const sel = el(doc, "select");
            const info = st.ocio && st.ocio.available ? st.ocio : null;
            const value = String(cur ?? d.def ?? "");
            const opt = (v, label) => sel.append(new Option(label, v));
            if (d.kind === "ocio_cs") {
                if (d.choices) for (const ch of d.choices) opt(ch, ch);
                else opt("", `(working${info ? ": " + info.working : ""})`);
                if (info) for (const c of info.colorspaces) opt(c.name, c.family ? `${c.family} / ${c.name}` : c.name);
            } else if (d.kind === "ocio_display") {
                opt("", `(default${info && info.default_display ? ": " + info.default_display : ""})`);
                if (info) for (const x of info.displays) opt(x.name, x.name);
            } else {
                const dn = C.paramAt(n, "display", st.frame) || (info && info.default_display) || "";
                const dd = info && info.displays.find((x) => x.name === dn);
                opt("", `(default${dd ? ": " + dd.default : ""})`);
                if (dd) for (const v of dd.views) opt(v, v);
            }
            if (![...sel.options].some((x) => x.value === value)) opt(value, `${value} (not in this config)`);
            sel.value = value;
            if (!info && d.kind !== "ocio_cs") sel.title = "No OpenColorIO on the server: the node passes its picture through";
            sel.onchange = () => write(sel.value);
            row.append(sel);
        } else if (d.kind === "enum") {
            const s = el(doc, "select");
            for (const ch of d.choices) s.append(new Option(String(ch), String(ch)));
            s.value = String(cur ?? d.def);
            if (mixed) { const o2 = new Option("— (differs)", "\u0000"); o2.disabled = true; s.prepend(o2); s.value = "\u0000"; }
            s.onchange = () => write(typeof d.def === "number" ? Number(s.value) : s.value);
            row.append(s);
        } else if (d.kind === "chan" || d.kind === "target" || d.kind === "layer") {
            row.append(channelSelect(n, p, d, String(cur ?? d.def), write));
        } else if (d.kind === "chanlist") {
            const i = el(doc, "input"); i.type = "text"; i.value = cur ?? d.def ?? ""; i.placeholder = "mask.a, depth.z";
            const fromIdx = d.from === "mask" ? C.maskIndex(n.type) : 0;
        const have = C.channelsAt(st.comp, n.inputs[fromIdx]);
            i.title = `${d.help || ""}${have.length ? `\nComing in: ${have.join(", ")}` : "\nNothing but r g b a comes in"}`;
            i.onchange = () => write(i.value.trim());
            row.append(i);
        } else if (d.kind === "file") {
            const i = el(doc, "input"); i.type = "text"; i.value = mixed ? "" : (cur || ""); i.placeholder = mixed ? "— (differs)" : "a picture, a film, or shot.####.exr";
            i.onchange = () => write(i.value.trim());
            const b = btn("…", "Choose a file", () => o.pickFile && o.pickFile((path) => write(path)));
            row.append(i, b);
        }
        if (d.key) {
            const key = el(doc, "span", "mg-key", animated ? (Mo.keyAt(n, p, st.frame) ? "◆" : "◇") : "");
            key.title = "Key at the playhead (click to add or remove)";
            key.onclick = () => {
                if (!animated) return;
                const had = Mo.keyAt(n, p, st.frame);
                mutate(() => { for (const t of tg) { if (!Mo.isAnimated(t, p)) continue; if (had) { if (Mo.keyAt(t, p, st.frame)) Mo.removeKey(t, p, st.frame); } else Mo.setProp(keyHost(), t, p, C.paramAt(t, p, st.frame), st.frame); } }, { structure: false });
            };
            row.append(key);
        }
        return row;
    }
    /**
     * A channel menu. "chan": a channel of what comes in (or 0 / 1, and - for Shuffle's "not written");
     * "target": where a node writes - rgba, one channel, a layer, or a new one typed in; "layer": a layer only.
     */
    function channelSelect(n, p, d, value, write) {
        const have = C.channelsAt(st.comp, n.inputs[0]);
        const s = el(doc, "select");
        const add = (v, label, parent = s) => parent.append(new Option(label || v, v));
        const group = (label) => { const g = doc.createElement("optgroup"); g.label = label; s.append(g); return g; };
        if (d.kind === "chan") {
            for (const c of C.CH.RGBA) add(c);
            if (have.length) { const g = group("extra"); for (const c of have) add(c, c, g); }
            if (d.from !== "mask") {
                const g = group("constant");
                add("0", "0 (black)", g); add("1", "1 (white)", g);
                if (n.type === "shuffle") add("-", "- (not written)", g);
            }
        } else {
            add("rgba", "rgba (the whole picture)");
            const layers = C.CH.layersOf(have);
            if (d.kind === "target") { const g = group("one channel"); for (const c of C.CH.RGBA) add(c, c, g); for (const c of have) add(c, c, g); }
            if (layers.length) { const g = group("layer"); for (const l of layers) add(l, l, g); }
            add("\u0001", d.kind === "layer" ? "New layer…" : "New channel or layer…");
        }
        if (![...s.options].some((x) => x.value === value)) add(value, `${value} (not there)`);
        s.value = value;
        s.onchange = () => {
            if (s.value !== "\u0001") { write(s.value); return; }
            const i = el(doc, "input"); i.type = "text"; i.placeholder = d.kind === "layer" ? "a layer: mask" : "mask.a, or a layer: mask";
            i.className = "cp-newch";
            const done = (ok) => {
                const v = i.value.trim();
                if (ok && (d.kind === "layer" ? C.CH.isLayer(v) : C.CH.isTarget(v))) write(v);
                else { if (ok && v) toast(`"${v}" is not a ${d.kind === "layer" ? "layer" : "channel"} name: letters, digits and _, a channel as layer.name`, "warn"); renderProps(); }
            };
            i.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
            i.onblur = () => done(true);
            s.replaceWith(i);
            i.focus();
        };
        return s;
    }
    /** The Roto node's shapes are the viewer's Roto tool's: its options go into this slot, its outlines over the picture. */
    function rotoSection(n) {
        const slot = el(doc, "div", "cp-roto-slot");
        pane.append(slot);
        if (o.roto && o.roto.mount) o.roto.mount(n, slot);
        else slot.append(el(doc, "div", "mg-empty", "The shapes are drawn with the viewer's Roto tool."));
    }
    // ColorCorrect, laid out as Color Finesse is: a tab per kind of correction, a bar of luma ranges.
    const CC_TABS = [["hsl", "HSL"], ["rgb", "RGB"], ["offsets", "Hue offsets"], ["luma", "Luma ranges"], ["secondary", "Secondaries"]];
    const CC_RANGE_BAR = [["master", "Master"], ["highlights", "Highlights"], ["midtones", "Midtones"], ["shadows", "Shadows"]];
    function ccSection(n, params) {
        const cc = st.cc || (st.cc = { tab: "hsl", range: "master", sec: "secA" });
        const rows = (pred) => { for (const [p, d] of Object.entries(params)) if (pred(d, p)) pane.append(paramRow(n, p, d)); };
        rows((d) => d.tab === "general");
        const tabs = el(doc, "div", "cp-cctabs");
        for (const [id, label] of CC_TABS) tabs.append(btn(label, "", () => { cc.tab = id; renderProps(); }, cc.tab === id ? "on" : ""));
        pane.append(tabs);
        const bar = (items, cur, set) => { const b = el(doc, "div", "cp-ccrange"); for (const [id, label] of items) b.append(btn(label, "", () => { set(id); renderProps(); }, cur === id ? "on" : "")); pane.append(b); };
        if (cc.tab === "hsl" || cc.tab === "rgb") {
            bar(CC_RANGE_BAR, cc.range, (id) => { cc.range = id; });
            rows((d) => d.tab === cc.tab && d.range === cc.range);
        } else if (cc.tab === "offsets") {
            const grid = el(doc, "div", "cp-ccwheels");
            for (const [R, label] of CC_RANGE_BAR) grid.append(ccWheel(n, R, label));
            pane.append(grid);
            pane.append(el(doc, "div", "mg-empty", "Drag in a wheel to push that range towards a colour; double-click puts it back. Shadows lift, the others balance."));
            rows((d) => d.tab === "offsets");
        } else if (cc.tab === "luma") {
            pane.append(ccLumaGraph(n));
            rows((d) => d.tab === "luma");
            pane.append(el(doc, "div", "mg-empty", "View (above) shows a range's weight as grey on the picture."));
        } else {
            bar([["secA", "Secondary A"], ["secB", "Secondary B"]], cc.sec, (id) => { cc.sec = id; });
            rows((d) => d.tab === "secondary" && d.range === cc.sec);
            pane.append(el(doc, "div", "mg-empty", "Turn it on, take the colour with ⌖, and set View to its secondary to see what it holds."));
        }
    }
    function ccWheel(n, R, label) {
        const box = el(doc, "div", "cp-ccwheel");
        const S = 104, rad = S / 2 - 4;
        const cv = el(doc, "canvas"); cv.width = S; cv.height = S;
        const val = el(doc, "div", "cp-ccval");
        const draw = () => {
            const hue = C.paramAt(n, `${R}_tint_hue`, st.frame), amt = C.paramAt(n, `${R}_tint`, st.frame);
            const g = cv.getContext("2d"), im = g.createImageData(S, S);
            for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
                const dx = x + 0.5 - S / 2, dy = S / 2 - (y + 0.5), d = Math.hypot(dx, dy) / rad, j = (y * S + x) * 4;
                if (d > 1) continue;
                const a = Math.atan2(dy, dx);
                for (let k = 0; k < 3; k++) im.data[j + k] = Math.round(255 * (0.5 + 0.45 * d * Math.cos(a - (k * 2 * Math.PI) / 3)));
                im.data[j + 3] = 255;
            }
            g.putImageData(im, 0, 0);
            const a = (hue * Math.PI) / 180, r = (amt / 100) * rad;
            g.strokeStyle = "rgba(0,0,0,.5)"; g.beginPath(); g.moveTo(S / 2 - 5, S / 2); g.lineTo(S / 2 + 5, S / 2); g.moveTo(S / 2, S / 2 - 5); g.lineTo(S / 2, S / 2 + 5); g.stroke();
            g.lineWidth = 2; g.strokeStyle = "#fff"; g.beginPath(); g.arc(S / 2 + r * Math.cos(a), S / 2 - r * Math.sin(a), 5, 0, 2 * Math.PI); g.stroke();
            val.textContent = `${label} ${Math.round(((hue % 360) + 360) % 360)}° ${Math.round(amt)}`;
        };
        const set = (ev) => {
            const b = cv.getBoundingClientRect(), dx = ev.clientX - b.left - (b.width / 2), dy = b.top + b.height / 2 - ev.clientY;
            let hue = (Math.atan2(dy, dx) * 180) / Math.PI; if (hue < 0) hue += 360;
            const amt = Math.min(100, (Math.hypot(dx, dy) / ((rad * b.width) / S)) * 100);
            const nn = node(n.id);
            for (const t of targetsOf(nn)) {
                Mo.setProp(keyHost(), t, `${R}_tint_hue`, Math.round(hue * 10) / 10, st.frame);
                Mo.setProp(keyHost(), t, `${R}_tint`, Math.round(amt * 10) / 10, st.frame);
            }
            n = nn; draw(); queueRender();
        };
        cv.onpointerdown = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            st.hist.push(st.comp);
            cv.setPointerCapture(e.pointerId);
            set(e);
            cv.onpointermove = set;
            cv.onpointerup = () => { cv.onpointermove = null; cv.onpointerup = null; st.dirty = true; refresh(["bar", "props", "stage", "graph"]); };
        };
        cv.ondblclick = () => mutate(() => { for (const t of targetsOf(node(n.id))) { Mo.setProp(keyHost(), t, `${R}_tint`, 0, st.frame); Mo.setProp(keyHost(), t, `${R}_tint_hue`, 0, st.frame); } }, { structure: false });
        cv.title = `${label}: drag to push towards a colour, double-click to reset`;
        draw();
        box.append(cv, val);
        return box;
    }
    function ccLumaGraph(n) {
        const W = 220, H = 70, NS = "http://www.w3.org/2000/svg";
        const svg = doc.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "cp-ccluma");
        const se = C.paramAt(n, "shadow_end", st.frame), hs = C.paramAt(n, "highlight_start", st.frame);
        const pts = [[], [], []];
        for (let i = 0; i <= 64; i++) { const Y = i / 64, w = CK.rangeWeights(Y, se, hs); for (let k = 0; k < 3; k++) pts[k].push(`${(Y * W).toFixed(1)},${(H - 4 - w[k] * (H - 8)).toFixed(1)}`); }
        ["#6a8cff", "#9fd18a", "#ffd27a"].forEach((col, k) => {
            const pl = doc.createElementNS(NS, "polyline");
            pl.setAttribute("points", pts[k].join(" ")); pl.setAttribute("fill", "none"); pl.setAttribute("stroke", col); pl.setAttribute("stroke-width", "2");
            svg.append(pl);
        });
        const wrap = el(doc, "div", "cp-cclumawrap");
        wrap.append(svg, el(doc, "div", "cp-ccval", "Shadows (blue), midtones (green), highlights (yellow) over luma as shown"));
        return wrap;
    }
    function renderProps() {
        props.replaceChildren();
        const n = primary();
        if (!n) {
            const f = fmt();
            props.append(el(doc, "h4", "", "Composition"));
            for (const [k, lo, step] of [["width", 4, 1], ["height", 4, 1], ["fps", 1, 1], ["frames", 1, 1]]) {
                props.append(field(k, numInput(f[k], step, (v) => { if (v !== null && v >= lo) mutate(() => { f[k] = k === "fps" ? v : Math.round(v); }); if (o.onComp) o.onComp(); }, { min: lo })));
            }
            props.append(el(doc, "div", "mg-empty", "Select a node to edit it. Tab in the Node graph adds one; a History thumbnail dropped on the graph, the layers or the picture becomes a Read."));
            return;
        }
        // One panel per selected node, the one picked last on top (Nuke's Properties bin), at most MAX_PANES.
        const shown = [n, ...st.sel.slice(0, -1).reverse().map(node).filter((x) => x && x !== n)].slice(0, MAX_PANES);
        shown.forEach((m, i) => nodePane(m, i === 0));
        if (st.sel.length > MAX_PANES) props.append(el(doc, "div", "mg-empty cp-multi", `${st.sel.length - MAX_PANES} more selected: their panels are not shown.`));
    }
    const MAX_PANES = 10;
    function nodePane(n, first) {
        const t = C.NODE_TYPES[n.type];
        const box = el(doc, "div", "cp-pane" + (first ? " first" : ""));
        box.dataset.pane = n.id;
        props.append(box);
        const folded = st.folded && st.folded.has(n.id);
        const head = el(doc, "div", "cp-panehead" + (folded ? " folded" : ""));
        const fold = el(doc, "span", "cp-panefold", folded ? "▸" : "▾");
        head.append(fold, el(doc, "span", "cp-panename", `${n.name || n.id}`), el(doc, "span", "cp-panetype", t.label));
        const x = btn("×", "Close this panel (the node leaves the selection)", () => select(st.sel.filter((id) => id !== n.id)));
        head.append(x);
        head.onclick = (e) => {
            if (e.target === x) return;
            st.folded = st.folded || new Set();
            if (st.folded.has(n.id)) st.folded.delete(n.id); else st.folded.add(n.id);
            renderProps();
        };
        head.title = "Click to fold / unfold";
        box.append(head);
        if (folded) return;
        pane = box;
        try { paneBody(n, t, first); } finally { pane = null; }
    }
    function paneBody(n, t, first) {
        const name = el(doc, "input"); name.type = "text"; name.value = n.name || ""; name.placeholder = n.id;
        name.onchange = () => mutate(() => { if (name.value.trim()) n.name = name.value.trim(); else delete n.name; });
        pane.append(field("name", name));
        if (n.type !== "output") {
            const dis = el(doc, "input"); dis.type = "checkbox"; dis.checked = !!n.disable;
            dis.onchange = () => mutate(() => { if (dis.checked) n.disable = true; else delete n.disable; });
            pane.append(field("disable", dis));
        }
        const ps = Object.entries(t.params);
        // The mask's channel and invert only matter with something in the mask input.
        const mi = C.maskIndex(n.type), masked = mi >= 0 && !!n.inputs[mi];
        const maskRow = (p) => p === "mask_channel" || p === "mask_invert";
        if (n.type === "colorcorrect") {
            ccSection(n, t.params);
            if (masked) for (const [p, d] of ps) if (maskRow(p)) pane.append(paramRow(n, p, d));
        } else for (const [p, d] of ps) if (d.kind !== "roto" && (masked || !maskRow(p))) pane.append(paramRow(n, p, d));
        if (n.type === "roto") {
            if (first) rotoSection(n);
            else pane.append(el(doc, "div", "mg-empty", "The shapes are drawn in the panel on top: click this node in the graph to bring it there."));
        }
        if (first && n.type !== "roto" && o.roto && o.roto.unmount) o.roto.unmount();
        if (n.type === "read") {
            const line = el(doc, "div", "mg-empty", "…");
            pane.append(line);
            if (o.sourceInfo) o.sourceInfo(n).then((inf) => {
                line.textContent = !inf || inf.kind === "missing" ? "No such file (yet)." : inf.kind === "refused" ? "Not in the folders the viewer may read."
                    : inf.kind === "still" ? "A still picture." : `${inf.kind === "video" ? "A film" : "A sequence"}: frames ${inf.first}–${inf.last}${inf.fps ? ` at ${r3(inf.fps)} fps` : ""}.`;
            }).catch(() => { line.textContent = ""; });
        }
        if (n.type === "output") pane.append(el(doc, "div", "mg-empty", "What the comp renders: Render… writes it by the export rule, into the History and onto the ComfyUI canvas."));
        const keys = C.nodeKeyFrames(n);
        if (keys.length) {
            const row = el(doc, "div", "mg-prop");
            row.append(el(doc, "label", "", "keys"));
            for (const f of keys.slice(0, 24)) { const b = btn(String(f), "Go to this key", () => o.onFrame && o.onFrame(f), f === st.frame ? "on" : ""); row.append(b); }
            row.style.flexWrap = "wrap";
            pane.append(row);
        }
    }

    // ── layers (the same graph, After Effects' way) ──────────────────────────
    function renderLayers() {
        layers.replaceChildren();
        const lbar = el(doc, "div", "cp-lbar");
        const L = C.layerStack(st.comp);
        const selIdx = L.findIndex((l) => l.merge && (st.sel.includes(l.merge) || l.chain.some((id) => st.sel.includes(id))));
        lbar.append(
            btn("+ Footage…", "A new layer on top: a picture, a film or a sequence", () => o.pickFile && o.pickFile((path) => mutate(() => { st.sel = [C.addLayer(st.comp, C.makeNode(st.comp, "read", { file: path })).source.id]; }))),
            btn("+ Solid", "A new layer on top: a colour", () => mutate(() => { st.sel = [C.addLayer(st.comp, C.makeNode(st.comp, "constant", { color: [1, 1, 1, 1], name: "Solid" })).source.id]; })),
            btn("▲", "Move the selected layer up", () => { if (selIdx > 0) mutate(() => C.moveLayer(st.comp, selIdx, -1)); }),
            btn("▼", "Move the selected layer down", () => { if (selIdx >= 0) mutate(() => C.moveLayer(st.comp, selIdx, 1)); }),
            btn("🗑", "Delete the selected layer", () => { if (selIdx >= 0) mutate(() => { C.removeLayer(st.comp, selIdx); st.sel = []; }); }));
        layers.append(lbar);
        const rows = el(doc, "div", "cp-lrows");
        if (!L.length) rows.append(el(doc, "div", "cp-note", "Nothing reaches the Output yet. Add footage, or wire a node into the Output in the Node graph."));
        L.forEach((l, i) => {
            const m = l.merge ? node(l.merge) : null;
            const src = l.source ? node(l.source) : null;
            const row = el(doc, "div", "cp-lrow" + (i === selIdx || (!m && l.chain.some((id) => st.sel.includes(id))) ? " sel" : "") + (m && m.disable ? " off" : ""));
            const eye = el(doc, "span", "mg-ic" + (m && m.disable ? "" : " on"), "👁");
            eye.title = m ? "Show / hide the layer (its Merge's disable)" : "The background is always there";
            eye.onclick = (e) => { e.stopPropagation(); if (m) mutate(() => { if (m.disable) delete m.disable; else m.disable = true; }); };
            const sw = el(doc, "span", "cp-swatch");
            sw.style.background = src ? CAT_COLOR[C.NODE_TYPES[src.type].cat] : "#666";
            row.append(eye, sw, el(doc, "span", "cp-lkind", `${KIND_ICON[l.kind]} ${l.kind}`), el(doc, "span", "cp-lname", l.name));
            if (l.chain.length > 1) row.lastChild.title = l.chain.map((id) => node(id).name || id).join(" ← ");
            if (m) {
                const op = el(doc, "select");
                for (const x of C.MERGE_OPS) op.append(new Option(x, x));
                op.value = m.operation || "over";
                op.onclick = (e) => e.stopPropagation();
                op.onchange = () => mutate(() => { m.operation = op.value; });
                const mix = el(doc, "input"); mix.type = "number"; mix.min = 0; mix.max = 1; mix.step = 0.05; mix.value = r3(C.paramAt(m, "mix", st.frame));
                mix.title = "Opacity (the Merge's mix)";
                mix.onclick = (e) => e.stopPropagation();
                mix.onchange = () => { const v = parseFloat(mix.value); if (Number.isFinite(v)) mutate(() => Mo.setProp(keyHost(), m, "mix", Math.max(0, Math.min(1, v)), st.frame), { structure: false }); };
                row.append(op, mix);
            }
            row.onclick = () => select(l.source ? [l.source] : l.chain.slice(0, 1));
            rows.append(row);
        });
        layers.append(rows);
    }

    // ── time ─────────────────────────────────────────────────────────────────
    function setFrame(f, { fromHost = false } = {}) {
        st.frame = Math.max(0, Math.round(f));
        if (!fromHost && o.onFrame) o.onFrame(st.frame);
        queueRender();
        renderOverlay();
        if (primary() && (Object.keys(primary().tracks || {}).length || primary().type === "roto")) renderProps();
        if (curvesEl.isConnected && st.sel.length) curves().draw();
    }

    // Made in the window the editor is in, and made again when it moves (an observer of another window's
    // elements is not told of their sizes).
    let ro = null;
    function observe() {
        if (ro) ro.disconnect();
        const RO = win().ResizeObserver || (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
        ro = RO ? new RO(() => { layoutCanvas(); if (!st.graph.fitted) renderGraph(); }) : null;
        if (ro) { ro.observe(stage); ro.observe(graph); }
    }
    observe();
    /** The editor's elements moved into another window (the viewer popped out or back in). */
    function moved() {
        moveGen++;                 // a frame asked of the window left behind may never come
        renderQueued = false;
        observe();
        layoutCanvas();
        queueRender();
    }

    return {
        parts,
        state: st,
        /** The frames of the picture on screen kept in the cache (the timeline's marks). */
        cachedFrames,
        /** Forget every kept result (a source changed on disk). */
        clearCache: () => { heavy.clear(); heavy.__bytes = 0; frameKeys.clear(); if (o.onCache) o.onCache(); },
        /** Render ahead now (the tests; normally after a pause). Resolves with the frames made. */
        renderAhead: () => { if (ahead) { clearTimeout(ahead.t); ahead.stop = true; } const job = { stop: false, gen: renderGen, t: 0 }; ahead = job; return aheadRun(job); },
        setDisplay: (v) => { st.display = v || ""; renderBar(); queueRender(); },
        /** How the picture is looked at: {ev, channel} (either may be left out). */
        stage,
        barRefresh: () => renderBar(),
        /** How the picture is looked at: {ev, channel} (either may be left out) - only what is shown. */
        setViewing: (v) => { if (!v) return; let changed = false;
            if (v.ev !== undefined) { const ev = Math.max(-6, Math.min(6, Number(v.ev) || 0)); changed = changed || ev !== st.ev; st.ev = ev; }
            if (v.channel !== undefined) { const c = C.VIEW_CHANNELS.some((x) => x[0] === v.channel) ? v.channel : "rgb"; changed = changed || c !== st.channel; st.channel = c; }
            if (changed) queueRender(); },
        load(raw, path) {
            const { comp: c, errors } = C.normalizeComp(raw);
            st.comp = c; st.path = path || ""; st.dirty = false; st.hist = new Mo.History(); st.sel = []; st.view = null;
            st.pick = null; heavy.clear(); heavy.__bytes = 0; frameKeys.clear(); lastPics = null;
            if (o.onCache) o.onCache();
            st.zoom.fit = true; st.graph.fitted = false;
            refresh();
            return { ok: !errors.length, errors };
        },
        comp: () => st.comp,
        isDirty: () => st.dirty,
        /** Saved elsewhere (Save as): nothing left unsaved here. */
        markSaved() { st.dirty = false; renderBar(); },
        setFrame,
        setFormat(patch) { mutate(() => Object.assign(st.comp.format, patch)); if (o.onComp) o.onComp(); },
        refresh: () => refresh(),
        relayout() { layoutCanvas(); if (!st.graph.fitted) frameAll(); if (curvesEl.isConnected) curves().draw(); },
        curves: () => curves(),
        moved,
        setRoto,
        node: (id) => node(id),
        stage,
        /** The picture's box in the stage's pixels (x, y, w, h) and the comp's size (cw, ch). */
        // The comp's format on screen (where the Roto tool draws): at the bottom left of the picture shown.
        canvasBox: () => ({ x: st.zoom.x, y: st.zoom.y + (st.comp ? downBy(fmt()) : 0) * st.zoom.s, w: fmt().width * st.zoom.s, h: fmt().height * st.zoom.s, cw: fmt().width, ch: fmt().height }),
        /** The Roto tool is on the picture: the left button is its, not the pan's. */
        setToolOn(on) { st.toolOn = !!on; },
        /** A key the viewer's window saw first (its hotkeys run in the capture phase): handled here when it is the
         *  comp's own - with the focus in the graph, Layers, Properties or the picture. True when it was. */
        handleKey(e) {
            const path = e.composedPath ? e.composedPath() : [];
            const part = [graph, layers, props, root].find((p) => path.includes(p));
            if (!part) return false;
            return keyDown(e, part);
        },
        rerender: () => queueRender(),
        frameAll,
        select: (ids) => select(ids),
        selected: () => primary(),
        view: (id) => setView(id),
        addNode: (type, extra) => { let n; mutate(() => { n = C.insertNode(st.comp, type, primary() && primary().id, extra || {}); st.sel = [n.id]; }); return n; },
        undo, redo, save,
        lastRender: () => ({ ms: lastMs, scale: lastScale, width: canvas.width, height: canvas.height }),
        canvas,
        dispose() { if (ro) ro.disconnect(); closeMenus(); infos.clear(); },
    };
}
