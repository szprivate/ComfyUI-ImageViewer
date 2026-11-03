// bEpicViewer_paintEditor.js
// Paint: a small picture editor - layers, a brush, selections, masks, adjustment layers - as one object
// that does not know the viewer. bEpicViewer_paintPanel.js is the glue (the tab, the dock panels, files,
// the agent); this file is the canvas, the tools and the two panels' contents (`parts.layers`, `parts.props`).
//
// The picture is drawn by bEpicViewer_paintData.js's arithmetic (composite / layPixels / layAdjust) into
// one RGBA buffer the size of the document, shown in a <canvas> that is zoomed and panned with CSS. While
// a stroke is painted only its rectangle is drawn again, over a copy of what lies under the layer (`below`).
//
// Undo: every change is ONE entry. A change of the document's shape (layers added, removed, moved, their
// switches, a filter that makes new pixels) keeps the document before and after - the layers' pixel
// buffers by reference, never copied; a stroke changes its layer's buffer IN PLACE and keeps the
// rectangle it touched, before and after. Entries are undone in order, so a buffer that a kept document
// refers to is always back in the state it had then.
import * as D from "./bEpicViewer_paintData.js";
import { paintIcon } from "./bEpicViewer_paintIcons.js";

export const PAINT_TOOLS = [
    ["move", "move", "Move", "V"], ["marquee", "marquee", "Rectangle select", "M"], ["ellipse", "ellipse", "Ellipse select", "Shift+M"],
    ["lasso", "lasso", "Lasso", "L"], ["wand", "wand", "Magic wand", "W"], ["crop", "crop", "Crop", "C"],
    ["brush", "brush", "Brush", "B"], ["eraser", "eraser", "Eraser", "E"], ["fill", "fill", "Paint bucket", "G"],
    ["picker", "picker", "Eyedropper", "I"], ["text", "text", "Text", "T"], ["hand", "hand", "Hand (hold Space)", "H"],
];
const TOOL_KEYS = { v: "move", m: "marquee", l: "lasso", w: "wand", c: "crop", b: "brush", e: "eraser", g: "fill", i: "picker",
                    t: "text", h: "hand" };
/** The keys, for the viewer's Show Hotkeys while a Paint tab is up. */
export const PAINT_KEYS = [
    ["V M L W C", "Move, select, lasso, magic wand, crop"], ["B E G I T H", "Brush, eraser, bucket, eyedropper, text, hand"],
    ["[ / ]", "Brush smaller / larger (Shift: softer / harder)"], ["X / D", "Swap / default colours"],
    ["Alt+click", "Pick a colour (brush, bucket)"], ["Space+drag", "Pan"], ["Wheel", "Zoom about the pointer"],
    ["Ctrl+0 / Ctrl+1", "Fit / 100%"], ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"], ["Ctrl+A / Ctrl+D", "Select all / deselect"],
    ["Ctrl+Shift+I", "Invert the selection"], ["Shift / Alt while selecting", "Add to / take from the selection"],
    ["Del", "Clear the selection on the layer"], ["Alt+Del", "Fill the selection with the colour"], ["Ctrl+J", "Duplicate the layer (the selection only, with one)"],
    ["Ctrl+E", "Merge down"], ["Ctrl+Shift+N", "New layer"], ["Arrows", "Nudge the layer (Move; Shift: 10 px)"],
    ["Enter / Esc", "Apply / cancel the crop or the text"], ["Ctrl+S / Ctrl+Shift+S", "Save / save as"],
];

const HISTORY_MAX = 60;
const HISTORY_BYTES = 768 * 1024 * 1024;
const STYLE = `
.paint-root { position: absolute; inset: 0; display: flex; flex-direction: column; background: #151518; color: #ddd;
  font: 12px/1.35 system-ui, "Segoe UI", sans-serif; user-select: none; }
.paint-bar { display: flex; align-items: center; gap: 2px; padding: 3px 6px; background: #1d1d21; border-bottom: 1px solid #2b2b30; flex: 0 0 auto; }
.paint-bar .paint-sep { width: 1px; height: 18px; background: #333; margin: 0 4px; }
.paint-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 26px; height: 24px; padding: 0 6px;
  background: transparent; border: 1px solid transparent; border-radius: 3px; color: #ccc; cursor: pointer; font: inherit; }
.paint-btn:hover { border-color: #f60; color: #fff; }
.paint-btn.on { background: #3a2a1d; border-color: #f60; color: #fff; }
.paint-btn:disabled { opacity: .35; cursor: default; border-color: transparent; }
.paint-menu-btn { padding: 0 8px; }
.paint-main { flex: 1 1 auto; display: flex; min-height: 0; }
.paint-tools { flex: 0 0 auto; display: flex; flex-direction: column; gap: 2px; padding: 4px 3px; background: #1d1d21; border-right: 1px solid #2b2b30; }
.paint-tools .paint-btn { width: 30px; height: 28px; padding: 0; }
.paint-colors { position: relative; width: 30px; height: 34px; margin-top: 6px; }
.paint-swatch { position: absolute; width: 18px; height: 18px; border: 1px solid #aaa; border-radius: 2px; cursor: pointer; padding: 0; }
.paint-swatch.fg { left: 0; top: 0; z-index: 1; } .paint-swatch.bg { left: 11px; top: 14px; }
.paint-wrap { position: relative; flex: 1 1 auto; overflow: hidden; outline: none; cursor: crosshair;
  background: #232327; touch-action: none; }
.paint-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.paint-world canvas.paint-canvas { display: block; background-color: #fff;
  background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%),
  linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%);
  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; box-shadow: 0 0 0 1px #000, 0 4px 24px rgba(0,0,0,.5); }
.paint-world.pixelated canvas.paint-canvas { image-rendering: pixelated; }
.paint-overlay { position: absolute; left: 0; top: 0; pointer-events: none; }
.paint-status { flex: 0 0 auto; display: flex; gap: 14px; padding: 2px 8px; background: #1d1d21; border-top: 1px solid #2b2b30; color: #999; font-size: 11px; white-space: nowrap; overflow: hidden; }
.paint-status b { color: #f60; font-weight: 600; }
.paint-text-input { position: absolute; z-index: 5; background: rgba(0,0,0,.15); border: 1px dashed #f60; outline: none; resize: none;
  padding: 0; margin: 0; overflow: hidden; white-space: pre; line-height: 1.25; }
.paint-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #999; text-align: center; padding: 20px; }
.paint-empty .t { font-size: 20px; color: #ddd; font-weight: 600; }
.paint-empty .row { display: flex; gap: 8px; }
.paint-big { background: #ff6a1a; border: 0; color: #111; font: 600 13px system-ui, sans-serif; padding: 8px 18px; border-radius: 4px; cursor: pointer; }
.paint-big.alt { background: #333; color: #ddd; }
.paint-big:hover { filter: brightness(1.1); }
/* the two dock panels */
.paint-panel { position: absolute; inset: 0; display: flex; flex-direction: column; background: #1b1b1f; color: #ddd;
  font: 12px/1.35 system-ui, "Segoe UI", sans-serif; }
.paint-lhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px; border-bottom: 1px solid #2b2b30; }
.paint-lhead select, .paint-panel select, .paint-panel input[type=number], .paint-panel input[type=text], .paint-panel textarea, .paint-dlg input, .paint-dlg select {
  background: #111; color: #ddd; border: 1px solid #3a3a40; border-radius: 3px; font: inherit; padding: 2px 4px; }
.paint-panel input[type=number] { width: 58px; color: #4fd6ee; }
.paint-panel input[type=range] { flex: 1 1 auto; min-width: 60px; accent-color: #f60; }
.paint-list { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
.paint-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-bottom: 1px solid #242429; cursor: pointer; }
.paint-row:hover { background: #24242a; }
.paint-row.active { background: #3a2a1d; }
.paint-row.drop-above { box-shadow: inset 0 2px 0 #f60; } .paint-row.drop-below { box-shadow: inset 0 -2px 0 #f60; }
.paint-row .eye { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; color: #bbb; flex: 0 0 auto; }
.paint-row .eye.off { color: #555; }
.paint-row canvas { flex: 0 0 auto; width: 40px; height: 30px; background: #888; border: 1px solid #444; }
.paint-row canvas.sel { border-color: #fff; box-shadow: 0 0 0 1px #f60; }
.paint-row .adj { flex: 0 0 auto; width: 40px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #444; color: #ccc; background: #222; }
.paint-row .adj.sel { border-color: #fff; box-shadow: 0 0 0 1px #f60; }
.paint-row .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paint-row .nm input { width: 100%; }
.paint-row .tag { color: #888; font-size: 10px; flex: 0 0 auto; }
.paint-row .lk { color: #f60; flex: 0 0 auto; display: inline-flex; }
.paint-lfoot { display: flex; gap: 2px; padding: 4px 6px; border-top: 1px solid #2b2b30; }
.paint-sect { border-bottom: 1px solid #2b2b30; padding: 6px 8px 8px; }
.paint-sect h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #f60; font-weight: 600; }
.paint-field { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.paint-field > label { flex: 0 0 92px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paint-field.wide > label { flex-basis: auto; }
.paint-props { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
.paint-props textarea { width: 100%; box-sizing: border-box; min-height: 52px; resize: vertical; }
.paint-note { color: #888; font-size: 11px; margin: 4px 0; }
.paint-gen { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.paint-gen .paint-btn { border-color: #3a3a40; }
.paint-curve { display: block; width: 100%; max-width: 260px; aspect-ratio: 1; background: #111; border: 1px solid #3a3a40; cursor: crosshair; }
/* dialogs over the editor */
.paint-dlg-shade { position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
.paint-dlg { background: #202024; border: 1px solid #f60; border-radius: 6px; padding: 12px 14px; min-width: 260px; max-width: 420px; color: #ddd;
  box-shadow: 0 10px 40px rgba(0,0,0,.6); }
.paint-dlg h3 { margin: 0 0 10px; font-size: 14px; color: #f60; }
.paint-dlg .paint-field > label { flex-basis: 110px; }
.paint-dlg .go { display: flex; justify-content: flex-end; gap: 6px; margin-top: 12px; }
.paint-dlg .note { color: #999; font-size: 11px; margin-top: 6px; }
`;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rectUnion = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

class PaintEditor {
    constructor(root, host) {
        this.root = root;
        this.host = host || {};
        this.d = root.ownerDocument;
        this.doc = null;
        this.pix = new Map();
        this.masks = new Map();
        this.sel = null;
        this.selSegs = null;
        this.tool = "brush";
        this.opts = {
            brush: { size: 24, hardness: 80, opacity: 100, spacing: 15 },
            eraser: { size: 40, hardness: 80, opacity: 100, spacing: 15 },
            fill: { tolerance: 32, contiguous: true, all: false },
            wand: { tolerance: 32, contiguous: true, all: true },
            select: { feather: 0 },
            text: { font: "sans-serif", size: 64, bold: false, italic: false, align: "left" },
        };
        this.fg = [255, 255, 255];
        this.bg = [0, 0, 0];
        this.view = { zoom: 1, x: 0, y: 0 };
        this.undoStack = [];
        this.redoStack = [];
        this.version = 0;
        this.savedVersion = 0;
        this.bufVer = new WeakMap();
        this.saved = new Map();
        this.editMask = false;
        this._build();
    }

    // ── building ─────────────────────────────────────────────────────────────

    el(tag, cls, props) {
        const e = this.d.createElement(tag);
        if (cls) e.className = cls;
        if (props) for (const [k, v] of Object.entries(props)) {
            if (k === "text") e.textContent = v;
            else if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
            else if (k in e) e[k] = v;
            else e.setAttribute(k, v);
        }
        return e;
    }

    btn(icon, title, run, cls = "") {
        const b = this.el("button", "paint-btn " + cls, { title, type: "button" });
        if (icon) b.append(paintIcon(this.d, icon));
        b.addEventListener("click", (e) => { e.stopPropagation(); run(e, b); });
        return b;
    }

    _build() {
        const style = this.el("style");
        style.textContent = STYLE;
        this.box = this.el("div", "paint-root");
        this.box.append(style);
        // The bar: files, the menus, undo.
        const bar = this.el("div", "paint-bar");
        bar.append(this.btn("newDoc", "New picture…", () => this.host.newDoc && this.host.newDoc()),
                   this.btn("open", "Open… (a picture, an .ora or a .psd)", () => this.host.open && this.host.open()),
                   this.btn("addImage", "Add a picture as a layer…", () => this.host.addImage && this.host.addImage()),
                   this.btn("save", "Save (Ctrl+S) - the menu: Save as, Export", (e, b) => this._menu(b, this._fileMenu())));
        bar.append(this.el("span", "paint-sep"));
        for (const [label, fn] of [["Edit", () => this._editMenu()], ["Select", () => this._selectMenu()], ["Image", () => this._imageMenu()],
                                   ["Layer", () => this._layerMenu()], ["Filter", () => this._filterMenu()], ["Generate", () => this._generateMenu()]]) {
            const b = this.el("button", "paint-btn paint-menu-btn", { type: "button", text: label });
            b.addEventListener("click", (e) => { e.stopPropagation(); this._menu(b, fn()); });
            bar.append(b);
        }
        bar.append(this.el("span", "paint-sep"));
        this.undoBtn = this.btn("undo", "Undo (Ctrl+Z)", () => this.undo());
        this.redoBtn = this.btn("redo", "Redo (Ctrl+Shift+Z)", () => this.redo());
        this.fitBtn = this.btn("fit", "Fit (Ctrl+0)", () => this.fit());
        bar.append(this.undoBtn, this.redoBtn, this.fitBtn);
        const main = this.el("div", "paint-main");
        // The tools.
        const tools = this.el("div", "paint-tools");
        this.toolBtns = {};
        for (const [id, icon, label, key] of PAINT_TOOLS) {
            const b = this.btn(icon, `${label} (${key})`, () => this.setTool(id));
            b.dataset.tool = id;
            this.toolBtns[id] = b;
            tools.append(b);
        }
        const colors = this.el("div", "paint-colors");
        this.fgBtn = this.el("button", "paint-swatch fg", { type: "button", title: "Colour (click to choose; X swaps, D resets)" });
        this.bgBtn = this.el("button", "paint-swatch bg", { type: "button", title: "Second colour" });
        this.fgBtn.addEventListener("click", () => this._chooseColor("fg"));
        this.bgBtn.addEventListener("click", () => this._chooseColor("bg"));
        colors.append(this.bgBtn, this.fgBtn);
        tools.append(colors, this.btn("swap", "Swap colours (X)", () => this.swapColors()));
        // The canvas.
        this.wrap = this.el("div", "paint-wrap", { tabIndex: 0 });
        this.world = this.el("div", "paint-world");
        this.canvas = this.el("canvas", "paint-canvas");
        this.world.append(this.canvas);
        this.overlay = this.el("canvas", "paint-overlay");
        this.wrap.append(this.world, this.overlay);
        main.append(tools, this.wrap);
        this.status = this.el("div", "paint-status");
        this.box.append(bar, main, this.status);
        this.root.append(this.box);
        // The panels.
        this.parts = { layers: this._buildLayersPart(), props: this._buildPropsPart() };
        this._wirePointer();
        this._ro = new (this.d.defaultView.ResizeObserver || ResizeObserver)(() => this._sizeOverlay());
        this._ro.observe(this.wrap);
        this._ants = this.d.defaultView.setInterval(() => { if (this.selSegs && this.wrap.isConnected) { this._antsPhase = ((this._antsPhase || 0) + 1) % 8; this.drawOverlay(); } }, 140);
        this.setTool("brush");
        this._swatches();
        this._showEmpty();
    }

    _showEmpty() {
        if (this.doc) { if (this.emptyEl) this.emptyEl.remove(); this.emptyEl = null; return; }
        if (this.emptyEl) return;
        const box = this.el("div", "paint-empty");
        box.append(this.el("div", "t", { text: "Paint" }),
                   this.el("div", "", { text: "Open a picture to paint on it in layers, or start an empty one. An .ora or .psd opens with its layers." }));
        const row = this.el("div", "row");
        const o = this.el("button", "paint-big", { text: "Open…", type: "button" });
        o.addEventListener("click", () => this.host.open && this.host.open());
        const n = this.el("button", "paint-big alt", { text: "New…", type: "button" });
        n.addEventListener("click", () => this.host.newDoc && this.host.newDoc());
        row.append(o, n);
        box.append(row);
        this.wrap.append(box);
        this.emptyEl = box;
    }

    // ── the document ─────────────────────────────────────────────────────────

    /** A document from its description and pixels: { doc, pix: {id: Uint8ClampedArray}, masks: {id: Uint8Array}, selection }. */
    setDocument(data, { keepView = false, fresh = true } = {}) {
        this.doc = D.cleanDoc(data.doc);
        this.pix = new Map(Object.entries(data.pix || {}));
        this.masks = new Map(Object.entries(data.masks || {}));
        for (const L of this.doc.layers) {
            if (L.kind === "pixel" && !this.pix.has(L.id)) this.pix.set(L.id, new Uint8ClampedArray(L.w * L.h * 4));
            if (L.mask && !this.masks.has(L.id)) delete L.mask;
        }
        this.sel = data.selection && data.selection.length === this.doc.w * this.doc.h ? data.selection : null;
        this.editMask = false;
        this.crop = null;
        this._cancelText();
        if (fresh) {
            this.undoStack = [];
            this.redoStack = [];
            this.version = 0;
            this.savedVersion = 0;
            this._markSavedRefs();
        }
        this._resizeCanvas();
        this._selChanged();
        if (!keepView) this.fit();
        this.redraw();
        this.refreshPanels();
        this._showEmpty();
        this._emit();
    }

    _resizeCanvas() {
        const { w, h } = this.doc;
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        this.ctx = this.canvas.getContext("2d");
        if (!this.comp || this.comp.length !== w * h * 4) {
            this.comp = new Uint8ClampedArray(w * h * 4);
            this.imgData = new ImageData(this.comp, w, h);
        }
        this.below = null;
    }

    _pixOf = (L) => this.pix.get(L.id);
    _maskOf = (L) => (L.mask ? this.masks.get(L.id) || null : null);
    active() { return this.doc ? this.doc.layers.find((L) => L.id === this.doc.active) || null : null; }

    // ── drawing ──────────────────────────────────────────────────────────────

    /** Draw again: all of it, or the rectangle {x0, y0, x1, y1} of the canvas. */
    redraw(rect = null) {
        if (!this.doc) return;
        const W = this.doc.w, H = this.doc.h;
        const r = rect ? { x0: clamp(Math.floor(rect.x0), 0, W), y0: clamp(Math.floor(rect.y0), 0, H),
                           x1: clamp(Math.ceil(rect.x1), 0, W), y1: clamp(Math.ceil(rect.y1), 0, H) } : { x0: 0, y0: 0, x1: W, y1: H };
        if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
        if (this.below && this._belowIdx != null) {
            // While a stroke runs: what is under the layer is kept; lay it and the layers above.
            for (let y = r.y0; y < r.y1; y++) this.comp.set(this.below.subarray((y * W + r.x0) * 4, (y * W + r.x1) * 4), (y * W + r.x0) * 4);
            D.composite(this.doc, this._pixOf, this._maskOf, r, this.comp, { keep: true, from: this._belowIdx });
        } else {
            D.composite(this.doc, this._pixOf, this._maskOf, r, this.comp);
        }
        this.ctx.putImageData(this.imgData, 0, 0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    }

    /** Draw again at the next frame (sliders, drags). */
    requestRedraw(rect = null) {
        this._pending = this._pending === undefined ? rect : (this._pending === null || rect === null ? null : rectUnion(this._pending, rect));
        if (this._raf) return;
        this._raf = this.d.defaultView.requestAnimationFrame(() => {
            this._raf = 0;
            const r = this._pending;
            this._pending = undefined;
            this.redraw(r);
        });
    }

    _keepBelow(L) {
        const i = D.layerIndex(this.doc, L.id);
        this.below = D.composite(this.doc, this._pixOf, this._maskOf, null, null, { to: i });
        this._belowIdx = i;
    }

    _dropBelow() { this.below = null; this._belowIdx = null; }

    // ── the view ─────────────────────────────────────────────────────────────

    _applyView() {
        const v = this.view;
        this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
        this.world.classList.toggle("pixelated", v.zoom >= 2);
        this.drawOverlay();
        this._status();
    }

    fit() {
        if (!this.doc) return;
        const r = this.wrap.getBoundingClientRect();
        const pad = 24;
        const z = Math.min((r.width - pad * 2) / this.doc.w, (r.height - pad * 2) / this.doc.h);
        this.view.zoom = clamp(Number.isFinite(z) && z > 0 ? z : 1, 0.02, 32);
        this.view.x = (r.width - this.doc.w * this.view.zoom) / 2;
        this.view.y = (r.height - this.doc.h * this.view.zoom) / 2;
        this._applyView();
    }

    zoomTo(z, cx = null, cy = null) {
        const r = this.wrap.getBoundingClientRect();
        if (cx === null) { cx = r.width / 2; cy = r.height / 2; }
        const nz = clamp(z, 0.02, 64);
        const ix = (cx - this.view.x) / this.view.zoom, iy = (cy - this.view.y) / this.view.zoom;
        this.view.zoom = nz;
        this.view.x = cx - ix * nz;
        this.view.y = cy - iy * nz;
        this._applyView();
    }

    toImage(e) {
        const r = this.wrap.getBoundingClientRect();
        return { x: (e.clientX - r.left - this.view.x) / this.view.zoom, y: (e.clientY - r.top - this.view.y) / this.view.zoom,
                 sx: e.clientX - r.left, sy: e.clientY - r.top };
    }

    _sizeOverlay() {
        const r = this.wrap.getBoundingClientRect();
        const dpr = this.d.defaultView.devicePixelRatio || 1;
        this.overlay.width = Math.max(1, Math.round(r.width * dpr));
        this.overlay.height = Math.max(1, Math.round(r.height * dpr));
        this.overlay.style.width = r.width + "px";
        this.overlay.style.height = r.height + "px";
        if (this.doc && !this._fitted && r.width > 50) { this._fitted = true; this.fit(); }
        this.drawOverlay();
    }

    /** The overlay: the selection's edge, what a tool is drawing, the brush, the crop. */
    drawOverlay() {
        const c = this.overlay.getContext("2d");
        const dpr = this.d.defaultView.devicePixelRatio || 1;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, this.overlay.width, this.overlay.height);
        if (!this.doc) return;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const v = this.view;
        const X = (x) => v.x + x * v.zoom, Y = (y) => v.y + y * v.zoom;
        // The selection.
        if (this.selSegs) {
            c.beginPath();
            const s = this.selSegs;
            for (let i = 0; i < s.length; i += 4) { c.moveTo(X(s[i]) + 0.5, Y(s[i + 1]) + 0.5); c.lineTo(X(s[i + 2]) + 0.5, Y(s[i + 3]) + 0.5); }
            c.lineWidth = 1;
            c.setLineDash([4, 4]);
            c.strokeStyle = "#000"; c.lineDashOffset = this._antsPhase || 0; c.stroke();
            c.strokeStyle = "#fff"; c.lineDashOffset = (this._antsPhase || 0) + 4; c.stroke();
            c.setLineDash([]);
        }
        const dr = this._drag;
        // A rectangle or ellipse being drawn, a lasso.
        if (dr && (dr.kind === "marquee" || dr.kind === "ellipse") && dr.rect) {
            const { x, y, w, h } = dr.rect;
            c.strokeStyle = "#fff"; c.setLineDash([5, 3]); c.lineWidth = 1;
            c.beginPath();
            if (dr.kind === "ellipse") c.ellipse(X(x + w / 2), Y(y + h / 2), Math.abs(w * v.zoom / 2), Math.abs(h * v.zoom / 2), 0, 0, Math.PI * 2);
            else c.rect(X(x) + 0.5, Y(y) + 0.5, w * v.zoom, h * v.zoom);
            c.stroke(); c.setLineDash([]);
        }
        if (dr && dr.kind === "lasso" && dr.pts.length > 1) {
            c.strokeStyle = "#fff"; c.lineWidth = 1; c.setLineDash([5, 3]);
            c.beginPath();
            dr.pts.forEach((p, i) => (i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))));
            c.stroke(); c.setLineDash([]);
        }
        // The crop.
        if (this.crop) {
            const { x, y, w, h } = this.crop;
            c.fillStyle = "rgba(0,0,0,.55)";
            const ow = this.overlay.width / dpr, oh = this.overlay.height / dpr;
            c.beginPath(); c.rect(0, 0, ow, oh); c.rect(X(x), Y(y), w * v.zoom, h * v.zoom); c.fill("evenodd");
            c.strokeStyle = "#f60"; c.lineWidth = 1.5; c.strokeRect(X(x), Y(y), w * v.zoom, h * v.zoom);
            c.fillStyle = "#f60"; c.font = "11px system-ui"; c.fillText(`${Math.round(w)} x ${Math.round(h)}  (Enter applies, Esc cancels)`, X(x) + 4, Y(y) - 6);
        }
        // The layer's box (Move).
        const L = this.active();
        if (this.tool === "move" && L && L.kind === "pixel") {
            c.strokeStyle = "rgba(0,200,255,.8)"; c.setLineDash([3, 3]); c.lineWidth = 1;
            c.strokeRect(X(L.x) + 0.5, Y(L.y) + 0.5, L.w * v.zoom, L.h * v.zoom); c.setLineDash([]);
        }
        // The brush.
        if ((this.tool === "brush" || this.tool === "eraser") && this._hover) {
            const o = this.opts[this.tool];
            c.strokeStyle = "rgba(255,255,255,.9)"; c.lineWidth = 1;
            c.beginPath(); c.arc(this._hover.sx, this._hover.sy, Math.max(1, (o.size / 2) * v.zoom), 0, Math.PI * 2); c.stroke();
            c.strokeStyle = "rgba(0,0,0,.6)";
            c.beginPath(); c.arc(this._hover.sx, this._hover.sy, Math.max(1, (o.size / 2) * v.zoom) + 1, 0, Math.PI * 2); c.stroke();
        }
    }

    _status() {
        if (!this.status) return;
        const d = this.doc;
        const parts = [];
        if (d) {
            parts.push(`<b>${d.w} x ${d.h}</b>`, `${Math.round(this.view.zoom * 100)}%`);
            if (this._hover) {
                const x = Math.floor(this._hover.x), y = Math.floor(this._hover.y);
                if (x >= 0 && y >= 0 && x < d.w && y < d.h) {
                    const i = (y * d.w + x) * 4, p = this.comp;
                    parts.push(`${x}, ${y}`, `RGBA ${p[i]} ${p[i + 1]} ${p[i + 2]} ${p[i + 3]}`);
                }
            }
            const bb = this.sel ? D.maskBBox(this.sel, d.w, d.h) : null;
            if (bb) parts.push(`selection ${bb.w} x ${bb.h}`);
            if (this.editMask) parts.push("<b>painting the mask</b>");
            const L = this.active();
            if (L) parts.push(`layer: ${escapeHtml(L.name)}`);
        }
        this.status.innerHTML = parts.join("<span>·</span>");
    }

    // ── the selection ────────────────────────────────────────────────────────

    _selChanged() {
        const d = this.doc;
        this.selSegs = null;
        if (d && this.sel) {
            const W = d.w, H = d.h, m = this.sel;
            const segs = [];
            // Horizontal edges: between row y-1 and y; vertical: between column x-1 and x. Runs merged.
            for (let y = 0; y <= H; y++) {
                let start = -1;
                for (let x = 0; x <= W; x++) {
                    const a = y > 0 && x < W ? m[(y - 1) * W + x] >= 128 : false;
                    const b = y < H && x < W ? m[y * W + x] >= 128 : false;
                    const edge = x < W && a !== b;
                    if (edge && start < 0) start = x;
                    if (!edge && start >= 0) { segs.push(start, y, x, y); start = -1; }
                }
            }
            for (let x = 0; x <= W; x++) {
                let start = -1;
                for (let y = 0; y <= H; y++) {
                    const a = x > 0 && y < H ? m[y * W + x - 1] >= 128 : false;
                    const b = x < W && y < H ? m[y * W + x] >= 128 : false;
                    const edge = y < H && a !== b;
                    if (edge && start < 0) start = y;
                    if (!edge && start >= 0) { segs.push(x, start, x, y); start = -1; }
                }
            }
            if (segs.length) this.selSegs = new Float32Array(segs);
            else this.sel = null;
        }
        this.drawOverlay();
        this._status();
    }

    setSelection(mask, label = "Select") {
        const before = this.sel, after = mask && mask.some((v) => v) ? mask : null;
        if (before === after) return;
        this._push({ label, undo: () => { this.sel = before; this._selChanged(); }, redo: () => { this.sel = after; this._selChanged(); } });
        this.sel = after;
        this._selChanged();
    }

    selectAll() { if (this.doc) this.setSelection(new Uint8Array(this.doc.w * this.doc.h).fill(255), "Select all"); }
    deselect() { this.setSelection(null, "Deselect"); }
    invertSelection() {
        if (!this.doc) return;
        this.setSelection(this.sel ? D.invertMask(this.sel) : new Uint8Array(this.doc.w * this.doc.h).fill(255), "Invert selection");
    }
    featherSelection(r) { if (this.sel) this.setSelection(D.feather(this.sel, this.doc.w, this.doc.h, r), "Feather"); }

    _combine(neu, e) {
        const op = e && e.shiftKey && e.altKey ? "intersect" : e && e.shiftKey ? "add" : e && e.altKey ? "subtract" : "replace";
        let m = D.combineMasks(op === "replace" ? null : this.sel, neu, op);
        if (this.opts.select.feather > 0) m = D.feather(m, this.doc.w, this.doc.h, this.opts.select.feather);
        return m;
    }

    // ── history ──────────────────────────────────────────────────────────────

    _push(entry) {
        entry.bytes = entry.bytes || 0;
        this.undoStack.push(entry);
        this.redoStack = [];
        let bytes = this.undoStack.reduce((s, x) => s + x.bytes, 0);
        while (this.undoStack.length > HISTORY_MAX || (bytes > HISTORY_BYTES && this.undoStack.length > 1)) {
            bytes -= this.undoStack.shift().bytes;
            this.savedVersion = -1;              // the saved state can no longer be reached by undoing
        }
        this.version++;
        this._emit();
    }

    undo() {
        const e = this.undoStack.pop();
        if (!e) return;
        e.undo();
        this.redoStack.push(e);
        this.version--;
        this._afterHistory();
    }

    redo() {
        const e = this.redoStack.pop();
        if (!e) return;
        e.redo();
        this.undoStack.push(e);
        this.version++;
        this._afterHistory();
    }

    _afterHistory() {
        this._dropBelow();
        this._resizeCanvas();
        this.redraw();
        this._selChanged();
        this.refreshPanels();
        this._emit();
    }

    _emit() {
        if (this.undoBtn) { this.undoBtn.disabled = !this.undoStack.length; this.redoBtn.disabled = !this.redoStack.length; }
        if (this.host.onChange) this.host.onChange(this.isDirty());
        this._status();
    }

    isDirty() { return !!this.doc && this.version !== this.savedVersion; }

    /** The document as it stands, to compare against later (structure changes). */
    _snap() {
        return { doc: JSON.parse(JSON.stringify(this.doc)), pix: new Map(this.pix), masks: new Map(this.masks), sel: this.sel };
    }

    _restore(s) {
        this.doc = JSON.parse(JSON.stringify(s.doc));
        this.pix = new Map(s.pix);
        this.masks = new Map(s.masks);
        this.sel = s.sel;
    }

    _snapBytes(before, after) {
        let n = 0;
        for (const [id, b] of after.pix) if (before.pix.get(id) !== b) n += b.byteLength;
        for (const [id, b] of after.masks) if (before.masks.get(id) !== b) n += b.byteLength;
        return n;
    }

    /** Change the document's shape: `fn` changes it (new buffers, never old ones in place); one undo entry. */
    change(label, fn) {
        if (!this.doc) return false;
        const before = this._snap();
        let ok;
        try { ok = fn(); } catch (e) { this._restore(before); this._notify(String(e.message || e), "error"); return false; }
        if (ok === false) { this._restore(before); return false; }
        const after = this._snap();
        this._push({ label, undo: () => this._restore(before), redo: () => this._restore(after), bytes: this._snapBytes(before, after) });
        this._afterHistory();
        return true;
    }

    /** A live change while a slider moves (no undo entry yet): `begin` once, `live` as it moves, `end` to keep it. */
    liveBegin() { if (!this._liveSnap) this._liveSnap = this._snap(); }
    liveEnd(label) {
        const before = this._liveSnap;
        this._liveSnap = null;
        if (!before) return;
        const after = this._snap();
        if (JSON.stringify(before.doc) === JSON.stringify(after.doc)) return;
        this._push({ label, undo: () => this._restore(before), redo: () => this._restore(after) });
        this._afterHistory();
    }

    _markSavedRefs() {
        this.saved = new Map();
        for (const [id, b] of this.pix) this.saved.set("p:" + id, [b, this.bufVer.get(b) || 0]);
        for (const [id, b] of this.masks) this.saved.set("m:" + id, [b, this.bufVer.get(b) || 0]);
    }

    _bump(buf) { this.bufVer.set(buf, (this.bufVer.get(buf) || 0) + 1); }

    // ── layers ───────────────────────────────────────────────────────────────

    setActive(id, mask = false) {
        if (!this.doc) return;
        const L = this.doc.layers.find((x) => x.id === id);
        if (!L) return;
        this.doc.active = id;
        this.editMask = !!(mask && L.mask) || (L.kind === "adjust" && mask);
        this.refreshPanels();
        this.drawOverlay();
        this._status();
    }

    newLayer(name = null, index = null) {
        return this.change("New layer", () => {
            const L = D.cleanLayer({ id: D.newId(), name: name || D.freshName(this.doc), kind: "pixel", x: 0, y: 0, w: this.doc.w, h: this.doc.h });
            this.pix.set(L.id, new Uint8ClampedArray(L.w * L.h * 4));
            const i = index == null ? D.layerIndex(this.doc, this.doc.active) + 1 : index;
            this.doc.layers.splice(clamp(i, 0, this.doc.layers.length), 0, L);
            this.doc.active = L.id;
            this.editMask = false;
        });
    }

    /** A layer of these pixels (w x h at x, y), above the active one. */
    addPixelLayer(px, w, h, name, x = 0, y = 0, extra = {}) {
        return this.change("Add layer", () => {
            const L = D.cleanLayer({ id: D.newId(), name, kind: "pixel", x, y, w, h, ...extra });
            this.pix.set(L.id, px);
            const i = this.doc.layers.length ? D.layerIndex(this.doc, this.doc.active) + 1 : 0;
            this.doc.layers.splice(i, 0, L);
            this.doc.active = L.id;
            this.editMask = false;
        });
    }

    addAdjustment(type) {
        return this.change("New " + D.ADJUST_LABELS[type], () => {
            const L = D.cleanLayer({ id: D.newId(), name: D.ADJUST_LABELS[type], kind: "adjust", adjust: { type, params: D.ADJUST_DEFAULTS[type] } });
            if (this.sel) {
                L.mask = { enabled: true, x: 0, y: 0, w: this.doc.w, h: this.doc.h, fill: 0 };
                this.masks.set(L.id, new Uint8Array(this.sel));
            }
            this.doc.layers.splice(D.layerIndex(this.doc, this.doc.active) + 1, 0, L);
            this.doc.active = L.id;
            this.editMask = false;
        });
    }

    deleteLayer(id = this.doc && this.doc.active) {
        if (!this.doc || this.doc.layers.length <= 1) { this._notify("The last layer stays.", "warn"); return false; }
        const L = this.doc.layers.find((x) => x.id === id);
        if (!L) return false;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return false; }
        return this.change("Delete layer", () => {
            const i = D.layerIndex(this.doc, id);
            this.doc.layers.splice(i, 1);
            this.pix.delete(id);
            this.masks.delete(id);
            this.doc.active = (this.doc.layers[Math.max(0, i - 1)] || this.doc.layers[0]).id;
            this.editMask = false;
        });
    }

    duplicateLayer() {
        const L = this.active();
        if (!L) return false;
        return this.change(this.sel && L.kind === "pixel" ? "Layer via copy" : "Duplicate layer", () => {
            const C = JSON.parse(JSON.stringify(L));
            C.id = D.newId();
            C.locked = false;
            if (L.kind === "pixel") {
                let px = new Uint8ClampedArray(this.pix.get(L.id));
                if (this.sel) {
                    // Ctrl+J with a selection: only what is selected.
                    const m = D.maskForLayer(this.sel, this.doc.w, this.doc.h, L);
                    for (let i = 0; i < m.length; i++) px[i * 4 + 3] = D.q8((px[i * 4 + 3] / 255) * (m[i] / 255));
                    C.name = `${L.name} (selection)`;
                    delete C.text;
                } else C.name = `${L.name} copy`;
                this.pix.set(C.id, px);
            } else C.name = `${L.name} copy`;
            if (L.mask) this.masks.set(C.id, new Uint8Array(this.masks.get(L.id)));
            this.doc.layers.splice(D.layerIndex(this.doc, L.id) + 1, 0, C);
            this.doc.active = C.id;
        });
    }

    moveLayer(id, toIndex) {
        return this.change("Move layer", () => {
            const i = D.layerIndex(this.doc, id);
            if (i < 0) return false;
            const [L] = this.doc.layers.splice(i, 1);
            this.doc.layers.splice(clamp(toIndex, 0, this.doc.layers.length), 0, L);
        });
    }

    setLayerProps(id, patch, label = "Layer") {
        return this.change(label, () => {
            const L = this.doc.layers.find((x) => x.id === id);
            if (!L) return false;
            Object.assign(L, patch);
        });
    }

    /** The pixel layer grown to cover the canvas (a new buffer; what lay outside is kept). Inside `change`. */
    _growToCanvas(L) {
        const W = this.doc.w, H = this.doc.h;
        const x0 = Math.min(0, L.x), y0 = Math.min(0, L.y), x1 = Math.max(W, L.x + L.w), y1 = Math.max(H, L.y + L.h);
        if (x0 === L.x && y0 === L.y && x1 - x0 === L.w && y1 - y0 === L.h) return this.pix.get(L.id);
        const nw = x1 - x0, nh = y1 - y0;
        const big = new Uint8ClampedArray(nw * nh * 4);
        const old = this.pix.get(L.id);
        for (let y = 0; y < L.h; y++) big.set(old.subarray(y * L.w * 4, (y + 1) * L.w * 4), ((y + L.y - y0) * nw + (L.x - x0)) * 4);
        this.pix.set(L.id, big);
        Object.assign(L, { x: x0, y: y0, w: nw, h: nh });
        return big;
    }

    mergeDown() {
        const L = this.active();
        if (!L) return false;
        const i = D.layerIndex(this.doc, L.id);
        const B = this.doc.layers[i - 1];
        if (!B) { this._notify("Nothing under this layer to merge into.", "warn"); return false; }
        if (B.kind !== "pixel") { this._notify(`${B.name} is an adjustment layer: merge into a pixel layer.`, "warn"); return false; }
        if (L.locked || B.locked) { this._notify("A locked layer is not merged.", "warn"); return false; }
        return this.change("Merge down", () => {
            this._growToCanvas(B);
            const base = this.pix.get(B.id);
            const sub = { w: B.w, h: B.h, layers: [] };
            const lb = { ...B, x: 0, y: 0, opacity: 1, blend: "normal", visible: true };
            delete lb.mask;
            const lt = { ...L, visible: true };
            if (L.kind === "pixel") { lt.x = L.x - B.x; lt.y = L.y - B.y; }
            if (lt.mask) lt.mask = { ...lt.mask, x: lt.mask.x - B.x, y: lt.mask.y - B.y };
            sub.layers = [lb, lt];
            const out = D.composite(sub, (X) => (X.id === B.id ? base : this.pix.get(X.id)), (X) => (X === lt && lt.mask ? this.masks.get(L.id) : null));
            if (L.kind === "adjust") for (let k = 3; k < out.length; k += 4) out[k] = base[k];
            this.pix.set(B.id, out);
            delete B.text;
            this.doc.layers.splice(i, 1);
            this.pix.delete(L.id);
            this.masks.delete(L.id);
            this.doc.active = B.id;
            this.editMask = false;
        });
    }

    flatten() {
        return this.change("Flatten", () => {
            const flat = D.composite(this.doc, this._pixOf, this._maskOf);
            const L = D.cleanLayer({ id: D.newId(), name: "Background", kind: "pixel", x: 0, y: 0, w: this.doc.w, h: this.doc.h });
            this.pix = new Map([[L.id, flat]]);
            this.masks = new Map();
            this.doc.layers = [L];
            this.doc.active = L.id;
            this.editMask = false;
        });
    }

    addMask(from = "all") {
        const L = this.active();
        if (!L) return false;
        if (L.mask && from !== "selection") { this._notify("This layer has a mask.", "info"); return false; }
        return this.change("Add mask", () => {
            const W = this.doc.w, H = this.doc.h;
            let m;
            if (from === "selection" && this.sel) m = new Uint8Array(this.sel);
            else if (from === "hide") m = new Uint8Array(W * H);
            else m = new Uint8Array(W * H).fill(255);
            L.mask = { enabled: true, x: 0, y: 0, w: W, h: H, fill: from === "all" ? 255 : 0 };
            this.masks.set(L.id, m);
            this.editMask = true;
        });
    }

    maskCmd(cmd) {
        const L = this.active();
        if (!L || !L.mask) return false;
        if (cmd === "toggle") return this.setLayerProps(L.id, { mask: { ...L.mask, enabled: !L.mask.enabled } }, "Mask on / off");
        if (cmd === "delete") return this.change("Delete mask", () => { delete L.mask; this.masks.delete(L.id); this.editMask = false; });
        if (cmd === "invert") return this.change("Invert mask", () => { this.masks.set(L.id, D.invertMask(this.masks.get(L.id))); L.mask.fill = 255 - L.mask.fill; });
        if (cmd === "apply" && L.kind === "pixel") {
            return this.change("Apply mask", () => {
                const px = new Uint8ClampedArray(this.pix.get(L.id));
                const m = this.masks.get(L.id), mk = L.mask;
                for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
                    const mx = x + L.x - mk.x, my = y + L.y - mk.y;
                    const v = mx >= 0 && my >= 0 && mx < mk.w && my < mk.h ? m[my * mk.w + mx] : mk.fill;
                    const o = (y * L.w + x) * 4 + 3;
                    px[o] = D.q8((px[o] / 255) * (v / 255));
                }
                this.pix.set(L.id, px);
                delete L.mask;
                this.masks.delete(L.id);
                this.editMask = false;
            });
        }
        return false;
    }

    // ── changes of the pixels ────────────────────────────────────────────────

    _pixelTarget(what) {
        const L = this.active();
        if (!L) return null;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return null; }
        if (L.kind !== "pixel") { this._notify(`${what}: pick a pixel layer (this one is an adjustment layer).`, "warn"); return null; }
        return L;
    }

    /** Colour into the selection (or all of the layer), by `alpha` 0..1. */
    fillSelection(color = this.fg, alpha = 1) {
        const L = this._pixelTarget("Fill");
        if (!L) return false;
        return this.change("Fill", () => {
            const px = this._growToCanvas(L);
            const t = this.sel ? D.maskForLayer(this.sel, this.doc.w, this.doc.h, L) : new Uint8Array(L.w * L.h).fill(255);
            this.pix.set(L.id, D.fillOver(px, L.w, L.h, [...color, Math.round(alpha * 255)], t, 255));
        });
    }

    clearSelection() {
        const L = this._pixelTarget("Clear");
        if (!L) return false;
        if (!this.sel) { this._notify("Select what to clear first.", "info"); return false; }
        return this.change("Clear", () => {
            const px = new Uint8ClampedArray(this.pix.get(L.id));
            const m = D.maskForLayer(this.sel, this.doc.w, this.doc.h, L);
            for (let i = 0; i < m.length; i++) px[i * 4 + 3] = D.q8((px[i * 4 + 3] / 255) * (1 - m[i] / 255));
            this.pix.set(L.id, px);
        });
    }

    /** A filter on the active pixel layer (in the selection when there is one). */
    filter(kind, p = {}) {
        const L = this._pixelTarget(kind === "blur" ? "Blur" : "Sharpen");
        if (!L) return false;
        return this.change(kind === "blur" ? "Gaussian blur" : kind === "sharpen" ? "Sharpen" : D.ADJUST_LABELS[kind], () => {
            const px = this.pix.get(L.id);
            let out;
            if (kind === "blur") out = D.blurPixels(px, L.w, L.h, p.radius || 4);
            else if (kind === "sharpen") out = D.sharpenPixels(px, L.w, L.h, p.radius || 2, p.amount == null ? 1 : p.amount);
            else out = D.adjustPixels(px, L.w, L.h, kind, p);
            if (this.sel) {
                const m = D.maskForLayer(this.sel, this.doc.w, this.doc.h, L);
                for (let i = 0; i < m.length; i++) {
                    const t = m[i] / 255;
                    if (t >= 1) continue;
                    for (let c = 0; c < 4; c++) out[i * 4 + c] = D.q8((px[i * 4 + c] / 255) * (1 - t) + (out[i * 4 + c] / 255) * t);
                }
            }
            this.pix.set(L.id, out);
        });
    }

    flipLayer(axis) {
        const L = this._pixelTarget("Flip");
        if (!L) return false;
        return this.change("Flip layer", () => {
            const src = this.pix.get(L.id), out = new Uint8ClampedArray(src.length);
            for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
                const sx = axis === "h" ? L.w - 1 - x : x, sy = axis === "v" ? L.h - 1 - y : y;
                out.set(src.subarray((sy * L.w + sx) * 4, (sy * L.w + sx) * 4 + 4), (y * L.w + x) * 4);
            }
            this.pix.set(L.id, out);
        });
    }

    rotateLayer(deg) {
        const L = this._pixelTarget("Rotate");
        if (!L) return false;
        return this.change("Rotate layer", () => {
            const src = this.pix.get(L.id);
            const nw = deg === 180 ? L.w : L.h, nh = deg === 180 ? L.h : L.w;
            const out = new Uint8ClampedArray(nw * nh * 4);
            for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
                let nx, ny;
                if (deg === 90) { nx = L.h - 1 - y; ny = x; } else if (deg === 270) { nx = y; ny = L.w - 1 - x; } else { nx = L.w - 1 - x; ny = L.h - 1 - y; }
                out.set(src.subarray((y * L.w + x) * 4, (y * L.w + x) * 4 + 4), (ny * nw + nx) * 4);
            }
            const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
            this.pix.set(L.id, out);
            Object.assign(L, { w: nw, h: nh, x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2) });
            if (L.mask) { delete L.mask; this.masks.delete(L.id); }
        });
    }

    /** Scale the active layer by k (the browser's resampling). */
    scaleLayer(k) {
        const L = this._pixelTarget("Scale");
        if (!L) return false;
        return this.change("Scale layer", () => {
            const nw = Math.max(1, Math.round(L.w * k)), nh = Math.max(1, Math.round(L.h * k));
            const out = resample(this.d, this.pix.get(L.id), L.w, L.h, nw, nh);
            const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
            this.pix.set(L.id, out);
            Object.assign(L, { w: nw, h: nh, x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2) });
            if (L.mask) { delete L.mask; this.masks.delete(L.id); }
        });
    }

    /** Move everything by dx, dy and make the canvas w x h (crop, canvas size). Inside `change`. */
    _reframe(w, h, dx, dy) {
        for (const L of this.doc.layers) {
            if (L.kind === "pixel") { L.x += dx; L.y += dy; }
            if (L.mask) { L.mask.x += dx; L.mask.y += dy; }
        }
        if (this.sel) {
            const old = this.sel, ow = this.doc.w, oh = this.doc.h, s = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) {
                const sy = y - dy;
                if (sy < 0 || sy >= oh) continue;
                for (let x = 0; x < w; x++) { const sx = x - dx; if (sx >= 0 && sx < ow) s[y * w + x] = old[sy * ow + sx]; }
            }
            this.sel = s.some((v) => v) ? s : null;
        }
        this.doc.w = w;
        this.doc.h = h;
    }

    cropTo(x, y, w, h) {
        x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
        if (w < 1 || h < 1) return false;
        const ok = this.change("Crop", () => this._reframe(w, h, -x, -y));
        if (ok) this.fit();
        return ok;
    }

    canvasSize(w, h, ax = 0.5, ay = 0.5) {
        const ok = this.change("Canvas size", () => this._reframe(w, h, Math.round((w - this.doc.w) * ax), Math.round((h - this.doc.h) * ay)));
        if (ok) this.fit();
        return ok;
    }

    imageSize(w, h) {
        const kx = w / this.doc.w, ky = h / this.doc.h;
        const ok = this.change("Image size", () => {
            for (const L of this.doc.layers) {
                if (L.kind === "pixel") {
                    const nw = Math.max(1, Math.round(L.w * kx)), nh = Math.max(1, Math.round(L.h * ky));
                    this.pix.set(L.id, resample(this.d, this.pix.get(L.id), L.w, L.h, nw, nh));
                    Object.assign(L, { x: Math.round(L.x * kx), y: Math.round(L.y * ky), w: nw, h: nh });
                }
                if (L.mask) {
                    const m = L.mask, nw = Math.max(1, Math.round(m.w * kx)), nh = Math.max(1, Math.round(m.h * ky));
                    this.masks.set(L.id, resampleMask(this.d, this.masks.get(L.id), m.w, m.h, nw, nh));
                    Object.assign(m, { x: Math.round(m.x * kx), y: Math.round(m.y * ky), w: nw, h: nh });
                }
            }
            if (this.sel) this.sel = resampleMask(this.d, this.sel, this.doc.w, this.doc.h, w, h);
            this.doc.w = w; this.doc.h = h;
        });
        if (ok) this.fit();
        return ok;
    }

    // ── tools ────────────────────────────────────────────────────────────────

    setTool(t) {
        if (t !== "crop") this.crop = null;
        if (t !== "text") this._commitText();
        this.tool = t;
        for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle("on", id === t);
        const cursors = { hand: "grab", move: "move", text: "text", picker: "copy" };
        this.wrap.style.cursor = cursors[t] || ((t === "brush" || t === "eraser") ? "none" : "crosshair");
        this.refreshProps();
        this.drawOverlay();
    }

    swapColors() { [this.fg, this.bg] = [this.bg, this.fg]; this._swatches(); this.refreshProps(); }
    defaultColors() { this.fg = [255, 255, 255]; this.bg = [0, 0, 0]; this._swatches(); this.refreshProps(); }
    setColor(which, rgb) { this[which] = rgb.slice(0, 3); this._swatches(); this.refreshProps(); }
    _swatches() {
        if (!this.fgBtn) return;
        this.fgBtn.style.background = D.rgbToHex(...this.fg);
        this.bgBtn.style.background = D.rgbToHex(...this.bg);
    }
    _chooseColor(which) {
        const inp = this.el("input", "", { type: "color", value: D.rgbToHex(...this[which]) });
        inp.style.position = "fixed"; inp.style.opacity = "0"; inp.style.pointerEvents = "none";
        this.box.append(inp);
        inp.addEventListener("input", () => this.setColor(which, D.hexToRgb(inp.value)));
        inp.addEventListener("change", () => inp.remove());
        inp.addEventListener("blur", () => setTimeout(() => inp.remove(), 200));
        inp.click();
    }

    _pickAt(p) {
        const x = Math.floor(p.x), y = Math.floor(p.y);
        if (!this.doc || x < 0 || y < 0 || x >= this.doc.w || y >= this.doc.h) return;
        const i = (y * this.doc.w + x) * 4;
        this.setColor("fg", [this.comp[i], this.comp[i + 1], this.comp[i + 2]]);
    }

    _wirePointer() {
        const w = this.wrap;
        w.addEventListener("contextmenu", (e) => e.preventDefault());
        w.addEventListener("wheel", (e) => {
            if (!this.doc) return;
            e.preventDefault();
            e.stopPropagation();
            const p = this.toImage(e);
            if (e.shiftKey && !e.ctrlKey) { this.view.x -= e.deltaY; this._applyView(); return; }
            const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
            this.zoomTo(this.view.zoom * k, p.sx, p.sy);
        }, { passive: false });
        w.addEventListener("pointerdown", (e) => this._down(e));
        w.addEventListener("pointermove", (e) => this._move(e));
        w.addEventListener("pointerup", (e) => this._up(e));
        w.addEventListener("pointercancel", (e) => this._up(e));
        w.addEventListener("pointerleave", () => { this._hover = null; this.drawOverlay(); this._status(); });
        w.addEventListener("dblclick", (e) => { if (this.tool === "crop" && this.crop) { e.preventDefault(); this.applyCrop(); } });
        for (const t of ["mousedown", "dblclick", "contextmenu"]) w.addEventListener(t, (e) => e.stopPropagation());
    }

    _down(e) {
        if (!this.doc) return;
        this.wrap.focus({ preventScroll: true });
        const p = this.toImage(e);
        if (e.button === 1 || this._space || this.tool === "hand") {
            e.preventDefault();
            this._drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
            this.wrap.setPointerCapture(e.pointerId);
            this.wrap.style.cursor = "grabbing";
            return;
        }
        if (e.button !== 0) return;
        this.wrap.setPointerCapture(e.pointerId);
        const t = this.tool;
        if ((t === "brush" || t === "fill") && e.altKey) { this._pickAt(p); return; }
        if (t === "picker") { this._pickAt(p); this._drag = { kind: "pick" }; return; }
        if (t === "brush" || t === "eraser") { this._strokeStart(p, e); return; }
        if (t === "fill") { this._bucket(p); return; }
        if (t === "wand") { this._wand(p, e); return; }
        if (t === "marquee" || t === "ellipse") { this._drag = { kind: t, x0: p.x, y0: p.y, rect: null, e }; return; }
        if (t === "lasso") { this._drag = { kind: "lasso", pts: [[p.x, p.y]], e }; return; }
        if (t === "move") { this._moveStart(p); return; }
        if (t === "crop") { this._cropStart(p); return; }
        if (t === "text") { this._textAt(p); return; }
    }

    _move(e) {
        if (!this.doc) return;
        const p = this.toImage(e);
        this._hover = p;
        const dr = this._drag;
        if (!dr) { if (this.tool === "brush" || this.tool === "eraser") this.drawOverlay(); this._status(); return; }
        if (dr.kind === "pan") {
            this.view.x = dr.vx + (e.clientX - dr.sx);
            this.view.y = dr.vy + (e.clientY - dr.sy);
            this._applyView();
            return;
        }
        if (dr.kind === "pick") { this._pickAt(p); return; }
        if (dr.kind === "stroke") { this._strokeTo(p); return; }
        if (dr.kind === "marquee" || dr.kind === "ellipse") {
            let w = p.x - dr.x0, h = p.y - dr.y0;
            if (e.shiftKey && !dr.e.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
            dr.rect = { x: Math.min(dr.x0, dr.x0 + w), y: Math.min(dr.y0, dr.y0 + h), w: Math.abs(w), h: Math.abs(h) };
            this.drawOverlay();
            return;
        }
        if (dr.kind === "lasso") { dr.pts.push([p.x, p.y]); this.drawOverlay(); return; }
        if (dr.kind === "move") {
            const dx = Math.round(p.x - dr.p0.x), dy = Math.round(p.y - dr.p0.y);
            dr.L.x = dr.x + dx; dr.L.y = dr.y + dy;
            if (dr.L.mask) { dr.L.mask.x = dr.mx + dx; dr.L.mask.y = dr.my + dy; }
            this.requestRedraw();
            this.drawOverlay();
            return;
        }
        if (dr.kind === "crop") { this._cropMove(p); return; }
    }

    _up(e) {
        const dr = this._drag;
        this._drag = null;
        if (this.wrap.hasPointerCapture && this.wrap.hasPointerCapture(e.pointerId)) this.wrap.releasePointerCapture(e.pointerId);
        if (!dr) return;
        if (dr.kind === "pan") { this.setTool(this.tool); return; }
        if (dr.kind === "stroke") { this._strokeEnd(dr.st); return; }
        if (dr.kind === "marquee" || dr.kind === "ellipse") {
            if (!dr.rect || dr.rect.w < 1 || dr.rect.h < 1) { if (!dr.e.shiftKey && !dr.e.altKey) this.deselect(); else this.drawOverlay(); return; }
            const { x, y, w, h } = dr.rect;
            const m = (dr.kind === "marquee" ? D.rectMask : D.ellipseMask)(this.doc.w, this.doc.h, x, y, w, h);
            this.setSelection(this._combine(m, dr.e), dr.kind === "marquee" ? "Rectangle select" : "Ellipse select");
            return;
        }
        if (dr.kind === "lasso") {
            if (dr.pts.length < 3) { this.drawOverlay(); return; }
            this.setSelection(this._combine(D.polygonMask(this.doc.w, this.doc.h, dr.pts), dr.e), "Lasso");
            return;
        }
        if (dr.kind === "move") { this._moveEnd(dr); return; }
        if (dr.kind === "crop") { this.drawOverlay(); return; }
    }

    // The brush and the eraser: on the layer's pixels, or on its mask (Layers panel: the mask's thumbnail).
    _strokeStart(p, e) {
        const L = this.active();
        if (!L) return;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return; }
        const onMask = this.editMask || L.kind === "adjust";
        if (L.kind === "adjust" && !L.mask) this.addMask("all");
        if (L.kind === "pixel" && !onMask) {
            // A layer smaller than the canvas grows first (an undo entry of its own shape).
            const W = this.doc.w, H = this.doc.h;
            if (L.x > 0 || L.y > 0 || L.x + L.w < W || L.y + L.h < H) this.change("Grow layer", () => { this._growToCanvas(this.active()); });
        }
        const A = this.active();
        const o = this.opts[this.tool];
        const erase = this.tool === "eraser";
        let st;
        if (onMask) {
            const mk = A.mask, m = this.masks.get(A.id);
            const gray = new Uint8ClampedArray(mk.w * mk.h * 4);
            for (let i = 0; i < m.length; i++) { gray[i * 4] = gray[i * 4 + 1] = gray[i * 4 + 2] = m[i]; gray[i * 4 + 3] = 255; }
            const lum = Math.round(0.2126 * this.fg[0] + 0.7152 * this.fg[1] + 0.0722 * this.fg[2]);
            const v = erase ? 255 - lum : lum;
            st = { px: gray, orig: new Uint8ClampedArray(gray), cover: new Float32Array(mk.w * mk.h), lw: mk.w, lh: mk.h, lx: mk.x, ly: mk.y,
                   color: [v, v, v], opacity: o.opacity / 100, erase: false, lockAlpha: true, sel: this.sel, W: this.doc.w, H: this.doc.h,
                   mask: m, onMask: true };
        } else {
            const px = this.pix.get(A.id);
            st = { px, orig: new Uint8ClampedArray(px), cover: new Float32Array(A.w * A.h), lw: A.w, lh: A.h, lx: A.x, ly: A.y,
                   color: this.fg, opacity: o.opacity / 100, erase, lockAlpha: false, sel: this.sel, W: this.doc.w, H: this.doc.h };
        }
        st.L = A;
        st.radius = Math.max(0.5, o.size / 2);
        st.hard = o.hardness / 100;
        st.spacing = Math.max(0.01, o.spacing / 100);
        st.last = [p.x, p.y];
        st.carry = 0;
        st.touched = null;
        this._keepBelow(A);
        this._drag = { kind: "stroke", st };
        this._dab(st, [[p.x, p.y]]);
        if (e.shiftKey && this._lastStrokeEnd && this._lastStrokeEnd.L === A.id) {
            // Shift-click: a straight line from where the last stroke ended.
            const a = this._lastStrokeEnd;
            this._dab(st, D.dabsAlong(a.x, a.y, p.x, p.y, st.radius, st.spacing).dabs);
        }
    }

    _strokeTo(p) {
        const st = this._drag.st;
        const r = D.dabsAlong(st.last[0], st.last[1], p.x, p.y, st.radius, st.spacing, st.carry);
        st.carry = r.carry;
        st.last = [p.x, p.y];
        if (r.dabs.length) this._dab(st, r.dabs);
    }

    _dab(st, dabs) {
        let rect = null;
        for (const [x, y] of dabs) rect = rectUnion(rect, D.stamp(st, x, y, st.radius, st.hard));
        if (!rect) return;
        if (st.onMask) {
            for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) st.mask[y * st.lw + x] = st.px[(y * st.lw + x) * 4];
        }
        st.touched = rectUnion(st.touched, rect);
        this.requestRedraw({ x0: rect.x0 + st.lx, y0: rect.y0 + st.ly, x1: rect.x1 + st.lx, y1: rect.y1 + st.ly });
    }

    _strokeEnd(s) {
        this._dropBelow();
        if (!s || !s.touched) { this.redraw(); return; }
        const r = s.touched, lw = s.lw;
        const ch = s.onMask ? 1 : 4;
        const buf = s.onMask ? s.mask : s.px;
        const origBuf = s.onMask ? (() => { const o = new Uint8Array(s.mask.length); for (let i = 0; i < o.length; i++) o[i] = s.orig[i * 4]; return o; })() : s.orig;
        const cut = (b) => {
            const w = r.x1 - r.x0, out = new (b.constructor)(w * (r.y1 - r.y0) * ch);
            for (let y = r.y0; y < r.y1; y++) out.set(b.subarray((y * lw + r.x0) * ch, (y * lw + r.x1) * ch), (y - r.y0) * w * ch);
            return out;
        };
        const paste = (b, part) => {
            const w = r.x1 - r.x0;
            for (let y = r.y0; y < r.y1; y++) b.set(part.subarray((y - r.y0) * w * ch, (y - r.y0 + 1) * w * ch), (y * lw + r.x0) * ch);
            this._bump(b);
        };
        const before = cut(origBuf), after = cut(buf);
        this._bump(buf);
        this._push({ label: this.tool === "eraser" ? "Eraser" : "Brush", bytes: before.byteLength * 2,
                     undo: () => paste(buf, before), redo: () => paste(buf, after) });
        this._lastStrokeEnd = { L: s.L.id, x: s.last[0], y: s.last[1] };
        this.redraw({ x0: r.x0 + s.lx, y0: r.y0 + s.ly, x1: r.x1 + s.lx, y1: r.y1 + s.ly });
        this._thumbsSoon();
    }

    _bucket(p) {
        const L = this._pixelTarget("Paint bucket");
        if (!L) return;
        const x = Math.floor(p.x), y = Math.floor(p.y), W = this.doc.w, H = this.doc.h;
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const o = this.opts.fill;
        this.change("Paint bucket", () => {
            const px = this._growToCanvas(L);
            let m;
            if (o.all) {
                const full = D.floodMask(this.comp, W, H, x, y, o.tolerance, o.contiguous);
                m = D.maskForLayer(full, W, H, L);
            } else m = D.floodMask(px, L.w, L.h, x - L.x, y - L.y, o.tolerance, o.contiguous);
            if (this.sel) { const s = D.maskForLayer(this.sel, W, H, L); for (let i = 0; i < m.length; i++) m[i] = Math.min(m[i], s[i]); }
            this.pix.set(L.id, D.fillOver(px, L.w, L.h, [...this.fg, 255], m, 255));
        });
    }

    _wand(p, e) {
        const x = Math.floor(p.x), y = Math.floor(p.y), W = this.doc.w, H = this.doc.h;
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const o = this.opts.wand;
        let m;
        const L = this.active();
        if (o.all || !L || L.kind !== "pixel") m = D.floodMask(this.comp, W, H, x, y, o.tolerance, o.contiguous);
        else {
            const lm = D.floodMask(this.pix.get(L.id), L.w, L.h, x - L.x, y - L.y, o.tolerance, o.contiguous);
            m = new Uint8Array(W * H);
            for (let yy = 0; yy < L.h; yy++) for (let xx = 0; xx < L.w; xx++) {
                const gx = xx + L.x, gy = yy + L.y;
                if (gx >= 0 && gy >= 0 && gx < W && gy < H) m[gy * W + gx] = lm[yy * L.w + xx];
            }
        }
        this.setSelection(this._combine(m, e), "Magic wand");
    }

    _moveStart(p) {
        const L = this.active();
        if (!L || L.kind !== "pixel") { this._notify("Move: pick a pixel layer.", "info"); return; }
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return; }
        this._drag = { kind: "move", L, p0: p, x: L.x, y: L.y, mx: L.mask ? L.mask.x : 0, my: L.mask ? L.mask.y : 0, before: this._snap() };
    }

    _moveEnd(dr) {
        if (dr.L.x === dr.x && dr.L.y === dr.y) return;
        const after = this._snap(), before = dr.before;
        this._push({ label: "Move", undo: () => this._restore(before), redo: () => this._restore(after) });
        this._afterHistory();
    }

    nudge(dx, dy) {
        const L = this.active();
        if (!L || L.kind !== "pixel" || L.locked) return;
        this.change("Nudge", () => {
            L.x += dx; L.y += dy;
            if (L.mask) { L.mask.x += dx; L.mask.y += dy; }
        });
    }

    // Crop: drag a rectangle, drag inside it to move it, Enter (or a double-click) applies, Esc cancels.
    _cropStart(p) {
        const c = this.crop;
        if (c && p.x >= c.x && p.y >= c.y && p.x <= c.x + c.w && p.y <= c.y + c.h) this._drag = { kind: "crop", move: true, p0: p, c0: { ...c } };
        else this._drag = { kind: "crop", move: false, p0: p };
    }

    _cropMove(p) {
        const dr = this._drag;
        if (dr.move) this.crop = { ...dr.c0, x: Math.round(dr.c0.x + p.x - dr.p0.x), y: Math.round(dr.c0.y + p.y - dr.p0.y) };
        else {
            const x0 = Math.round(Math.min(dr.p0.x, p.x)), y0 = Math.round(Math.min(dr.p0.y, p.y));
            this.crop = { x: x0, y: y0, w: Math.round(Math.abs(p.x - dr.p0.x)), h: Math.round(Math.abs(p.y - dr.p0.y)) };
        }
        this.drawOverlay();
    }

    applyCrop() {
        const c = this.crop;
        this.crop = null;
        if (!c || c.w < 1 || c.h < 1) { this.drawOverlay(); return; }
        this.cropTo(c.x, c.y, c.w, c.h);
    }

    // Text: a click puts a box there (or opens the text layer under it again); Enter keeps it, Esc throws it away.
    _textAt(p) {
        if (this.textBox) { this._commitText(); return; }
        const L = this.active();
        let edit = null;
        if (L && L.text && p.x >= L.x && p.y >= L.y && p.x <= L.x + L.w && p.y <= L.y + L.h) edit = L;
        const o = edit ? { ...edit.text } : { ...this.opts.text, color: D.rgbToHex(...this.fg), text: "" };
        const at = edit ? { x: edit.x, y: edit.y } : { x: Math.round(p.x), y: Math.round(p.y - o.size * 0.2) };
        const ta = this.el("textarea", "paint-text-input");
        ta.value = o.text;
        const v = this.view;
        Object.assign(ta.style, { left: (v.x + at.x * v.zoom) + "px", top: (v.y + at.y * v.zoom) + "px",
            font: `${o.italic ? "italic " : ""}${o.bold ? "bold " : ""}${o.size * v.zoom}px ${o.font}`, color: o.color,
            minWidth: (o.size * v.zoom * 2) + "px", minHeight: (o.size * v.zoom * 1.3) + "px", textAlign: o.align });
        const grow = () => { ta.style.width = "0px"; ta.style.height = "0px"; ta.style.width = (ta.scrollWidth + 8) + "px"; ta.style.height = (ta.scrollHeight + 2) + "px"; };
        ta.addEventListener("input", grow);
        ta.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); this._cancelText(); }
            else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._commitText(); }
        });
        ta.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.wrap.append(ta);
        grow();
        setTimeout(() => ta.focus(), 0);
        this.textBox = { ta, at, o, edit };
    }

    _cancelText() {
        if (!this.textBox) return;
        this.textBox.ta.remove();
        this.textBox = null;
    }

    _commitText() {
        const tb = this.textBox;
        if (!tb) return;
        this.textBox = null;
        const text = tb.ta.value;
        tb.ta.remove();
        if (!text.trim()) { if (tb.edit) this.wrap.focus(); return; }
        const t = D.cleanText({ ...tb.o, text });
        const r = renderText(this.d, t);
        if (tb.edit) {
            const L = tb.edit;
            this.change("Edit text", () => {
                this.pix.set(L.id, r.px);
                Object.assign(L, { w: r.w, h: r.h, text: t, name: text.split("\n")[0].slice(0, 40) || L.name });
            });
        } else this.addPixelLayer(r.px, r.w, r.h, text.split("\n")[0].slice(0, 40) || "Text", tb.at.x, tb.at.y, { text: t });
    }

    /** Draw a text layer again with a new look (the Properties panel). */
    retext(patch) {
        const L = this.active();
        if (!L || !L.text) return;
        const t = D.cleanText({ ...L.text, ...patch });
        const r = renderText(this.d, t);
        this.change("Text", () => { this.pix.set(L.id, r.px); Object.assign(L, { w: r.w, h: r.h, text: t }); });
    }

    // ── keys ─────────────────────────────────────────────────────────────────

    /** A key while the editor is up; true when it took it. */
    keyDown(e) {
        if (!this.doc) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o" && this.host.open) { e.preventDefault(); this.host.open(); return true; }
            return false;
        }
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return false;
        const k = e.key, lk = k.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
        const take = (fn) => { e.preventDefault(); fn(); return true; };
        if (ctrl) {
            if (lk === "z" && e.shiftKey) return take(() => this.redo());
            if (lk === "z" || lk === "y") return take(() => (lk === "y" ? this.redo() : this.undo()));
            if (lk === "a") return take(() => this.selectAll());
            if (lk === "d") return take(() => this.deselect());
            if (lk === "i" && e.shiftKey) return take(() => this.invertSelection());
            if (lk === "j") return take(() => this.duplicateLayer());
            if (lk === "e") return take(() => this.mergeDown());
            if (lk === "n" && e.shiftKey) return take(() => this.newLayer());
            if (lk === "s") return take(() => (e.shiftKey ? this.host.saveAs && this.host.saveAs() : this.host.save && this.host.save()));
            if (lk === "o") return take(() => this.host.open && this.host.open());
            if (k === "0") return take(() => this.fit());
            if (k === "1") return take(() => this.zoomTo(1));
            if (k === "=" || k === "+") return take(() => this.zoomTo(this.view.zoom * 1.25));
            if (k === "-") return take(() => this.zoomTo(this.view.zoom / 1.25));
            return false;
        }
        if (k === " ") { e.preventDefault(); if (!this._space) { this._space = true; this.wrap.style.cursor = "grab"; } return true; }
        if (k === "Enter" && this.crop) return take(() => this.applyCrop());
        if (k === "Escape") return take(() => { if (this.crop) { this.crop = null; this.drawOverlay(); } else if (this.sel) this.deselect(); });
        if (k === "Delete" || k === "Backspace") return take(() => (e.altKey ? this.fillSelection(this.fg) : this.clearSelection()));
        if (k.startsWith("Arrow") && this.tool === "move") {
            const s = e.shiftKey ? 10 : 1;
            return take(() => this.nudge(k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0, k === "ArrowUp" ? -s : k === "ArrowDown" ? s : 0));
        }
        if (k === "[" || k === "]") {
            const o = this.opts[this.tool === "eraser" ? "eraser" : "brush"];
            return take(() => {
                if (e.shiftKey) o.hardness = clamp(o.hardness + (k === "]" ? 10 : -10), 0, 100);
                else o.size = clamp(Math.round(o.size * (k === "]" ? 1.2 : 1 / 1.2) + (k === "]" ? 1 : -1)), 1, 2000);
                this.refreshProps(); this.drawOverlay();
            });
        }
        if (lk === "x" && !e.altKey) return take(() => this.swapColors());
        if (lk === "d" && !e.altKey) return take(() => this.defaultColors());
        if (lk === "m" && e.shiftKey) return take(() => this.setTool("ellipse"));
        if (TOOL_KEYS[lk] && !e.altKey && !e.shiftKey) return take(() => this.setTool(TOOL_KEYS[lk]));
        return false;
    }

    keyUp(e) {
        if (e.key === " " && this._space) { this._space = false; this.setTool(this.tool); return true; }
        return false;
    }

    // ── menus and dialogs ────────────────────────────────────────────────────

    _menu(anchor, entries) {
        if (this.host.menu) {
            const r = anchor.getBoundingClientRect();
            this.host.menu(entries, r.left, r.bottom + 2, anchor);
        }
    }

    _fileMenu() {
        return [{ label: "Save (Ctrl+S)", run: () => this.host.save && this.host.save() },
                { label: "Save as… (Ctrl+Shift+S)", run: () => this.host.saveAs && this.host.saveAs() },
                "-", { label: "Export… (PNG, JPEG, WebP, TIFF, PSD)", run: () => this.host.exportDoc && this.host.exportDoc() },
                "-", { label: "Open… (Ctrl+O)", run: () => this.host.open && this.host.open() },
                { label: "Add picture as layer…", run: () => this.host.addImage && this.host.addImage() },
                { label: "New picture…", run: () => this.host.newDoc && this.host.newDoc() }];
    }

    _editMenu() {
        const u = this.undoStack[this.undoStack.length - 1], r = this.redoStack[this.redoStack.length - 1];
        return [{ label: `Undo${u ? " " + u.label : ""} (Ctrl+Z)`, disabled: !u, run: () => this.undo() },
                { label: `Redo${r ? " " + r.label : ""} (Ctrl+Shift+Z)`, disabled: !r, run: () => this.redo() }, "-",
                { label: "Fill with the colour (Alt+Del)", run: () => this.fillSelection(this.fg) },
                { label: "Fill with the second colour", run: () => this.fillSelection(this.bg) },
                { label: "Clear (Del)", disabled: !this.sel, run: () => this.clearSelection() }];
    }

    _selectMenu() {
        return [{ label: "All (Ctrl+A)", run: () => this.selectAll() }, { label: "Deselect (Ctrl+D)", disabled: !this.sel, run: () => this.deselect() },
                { label: "Invert (Ctrl+Shift+I)", run: () => this.invertSelection() },
                { label: "Feather…", disabled: !this.sel, run: () => this.dialog("Feather", [["radius", "Radius (px)", 8, 0.5, 500]], (v) => this.featherSelection(v.radius)) },
                { label: "From the layer's pixels", run: () => this.selectLayerAlpha() }, "-",
                { label: "Subject (agentY)…", run: () => this.host.generate && this.host.generate("select_subject", {}) }];
    }

    selectLayerAlpha() {
        const L = this.active();
        if (!L || L.kind !== "pixel") return;
        const W = this.doc.w, H = this.doc.h, m = new Uint8Array(W * H), px = this.pix.get(L.id);
        for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
            const gx = x + L.x, gy = y + L.y;
            if (gx >= 0 && gy >= 0 && gx < W && gy < H) m[gy * W + gx] = px[(y * L.w + x) * 4 + 3];
        }
        this.setSelection(m, "Select layer");
    }

    _imageMenu() {
        const d = this.doc;
        return [{ label: "Canvas size…", run: () => this.dialog("Canvas size", [["w", "Width", d.w, 1, D.MAX_SIDE], ["h", "Height", d.h, 1, D.MAX_SIDE],
                     ["anchor", "Anchor", "center", ["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"]]],
                     (v) => { const [ax, ay] = ANCHOR[v.anchor] || [0.5, 0.5]; this.canvasSize(Math.round(v.w), Math.round(v.h), ax, ay); }) },
                { label: "Image size…", run: () => this.dialog("Image size", [["w", "Width", d.w, 1, D.MAX_SIDE], ["h", "Height (0: keep the shape)", 0, 0, D.MAX_SIDE]],
                     (v) => this.imageSize(Math.round(v.w), Math.round(v.h || (d.h * v.w) / d.w))) },
                { label: "Crop to the selection", disabled: !this.sel, run: () => { const b = D.maskBBox(this.sel, d.w, d.h); if (b) this.cropTo(b.x, b.y, b.w, b.h); } },
                "-", { label: "Flatten", run: () => this.flatten() }];
    }

    _layerMenu() {
        const L = this.active();
        const adj = D.ADJUST_TYPES.map((t) => ({ label: "New " + D.ADJUST_LABELS[t] + " layer", run: () => this.addAdjustment(t) }));
        return [{ label: "New layer (Ctrl+Shift+N)", run: () => this.newLayer() },
                { label: "Duplicate (Ctrl+J)", disabled: !L, run: () => this.duplicateLayer() },
                { label: "Delete", disabled: !L, run: () => this.deleteLayer() },
                { label: "Merge down (Ctrl+E)", disabled: !L, run: () => this.mergeDown() }, "-",
                ...adj, "-",
                { label: "Add mask (reveal all)", disabled: !L || !!L.mask, run: () => this.addMask("all") },
                { label: "Add mask from the selection", disabled: !L || !this.sel, run: () => this.addMask("selection") },
                { label: "Mask on / off", disabled: !L || !L.mask, run: () => this.maskCmd("toggle") },
                { label: "Invert the mask", disabled: !L || !L.mask, run: () => this.maskCmd("invert") },
                { label: "Apply the mask", disabled: !L || !L.mask || L.kind !== "pixel", run: () => this.maskCmd("apply") },
                { label: "Delete the mask", disabled: !L || !L.mask, run: () => this.maskCmd("delete") }, "-",
                { label: "Flip left-right", disabled: !L || L.kind !== "pixel", run: () => this.flipLayer("h") },
                { label: "Flip top-bottom", disabled: !L || L.kind !== "pixel", run: () => this.flipLayer("v") },
                { label: "Rotate 90° clockwise", disabled: !L || L.kind !== "pixel", run: () => this.rotateLayer(90) },
                { label: "Rotate 90° anticlockwise", disabled: !L || L.kind !== "pixel", run: () => this.rotateLayer(270) },
                { label: "Rotate 180°", disabled: !L || L.kind !== "pixel", run: () => this.rotateLayer(180) },
                { label: "Scale…", disabled: !L || L.kind !== "pixel", run: () => this.dialog("Scale layer", [["k", "Percent", 100, 1, 1600]], (v) => this.scaleLayer(v.k / 100)) },
                { label: L && L.locked ? "Unlock" : "Lock", disabled: !L, run: () => this.setLayerProps(L.id, { locked: !L.locked }, "Lock") }];
    }

    _filterMenu() {
        const L = this.active();
        const off = !L || L.kind !== "pixel";
        return [{ label: "Gaussian blur…", disabled: off, run: () => this.dialog("Gaussian blur", [["radius", "Radius (px)", 4, 0.1, 250]], (v) => this.filter("blur", v)) },
                { label: "Sharpen…", disabled: off, run: () => this.dialog("Sharpen", [["radius", "Radius (px)", 2, 0.1, 100], ["amount", "Amount", 1, 0, 10]], (v) => this.filter("sharpen", v)) },
                "-", ...D.ADJUST_TYPES.filter((t) => t !== "curves").map((t) => ({ label: D.ADJUST_LABELS[t] + " (into the pixels)…", disabled: off,
                    run: () => (D.ADJUST_FIELDS[t].length ? this.dialog(D.ADJUST_LABELS[t], D.ADJUST_FIELDS[t].map(([k, l, a, b]) => [k, l, triple1(D.ADJUST_DEFAULTS[t][k]), a, b]),
                        (v) => this.filter(t, expandTriples(t, v))) : this.filter(t, {})) }))];
    }

    _generateMenu() {
        const g = (kind) => () => this.host.generate && this.host.generate(kind, { prompt: this._prompt || "" });
        return [{ label: "Generative fill (the selection, with the prompt)", run: g("fill") },
                { label: "Remove object (the selection)", run: g("remove") },
                { label: "Fill from the surroundings (here, no AI)", disabled: !this.sel, run: g("heal") },
                { label: "Remove background", run: g("background") },
                { label: "Select subject", run: g("select_subject") },
                { label: "Extend the canvas…", run: () => this.dialog("Extend the canvas", [["px", "Pixels each side", 128, 1, 4096], ["ai", "Fill the new part with agentY", "yes", ["yes", "no"]]],
                     (v) => this.host.generate && this.host.generate("extend", { px: v.px, ai: v.ai === "yes", prompt: this._prompt || "" })) },
                { label: "Upscale…", run: () => this.dialog("Upscale", [["k", "Times", "2", ["2", "4"]], ["ai", "With agentY (else a plain resize)", "yes", ["yes", "no"]]],
                     (v) => this.host.generate && this.host.generate("upscale", { k: Number(v.k), ai: v.ai === "yes" })) }];
    }

    /** A small form over the editor: fields [key, label, default, min, max], [key, label, default, [choices]] or [key, label, default, "text"]. */
    dialog(title, fields, onOk, note = "") {
        const shade = this.el("div", "paint-dlg-shade");
        const box = this.el("div", "paint-dlg");
        box.append(this.el("h3", "", { text: title }));
        const inputs = {};
        for (const [k, label, def, a, b] of fields) {
            const row = this.el("div", "paint-field");
            row.append(this.el("label", "", { text: label }));
            let inp;
            if (Array.isArray(a)) {
                inp = this.el("select");
                for (const c of a) inp.append(this.el("option", "", { value: c, text: c.replace(/_/g, " ") }));
                inp.value = def;
            } else if (a === "text") inp = this.el("input", "", { type: "text", value: def, spellcheck: false });
            else inp = this.el("input", "", { type: "number", value: def, min: a, max: b, step: "any" });
            inputs[k] = inp;
            row.append(inp);
            box.append(row);
        }
        if (note) box.append(this.el("div", "note", { text: note }));
        const go = this.el("div", "go");
        const cancel = this.el("button", "paint-btn", { text: "Cancel", type: "button" });
        const ok = this.el("button", "paint-btn on", { text: "OK", type: "button" });
        const close = () => shade.remove();
        const done = () => {
            const v = {};
            for (const [k, , def, a, b] of fields) {
                const inp = inputs[k];
                v[k] = Array.isArray(a) || a === "text" ? inp.value : D.num(inp.value, def, a, b);
            }
            close();
            onOk(v);
        };
        cancel.addEventListener("click", close);
        ok.addEventListener("click", done);
        box.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); done(); } else if (e.key === "Escape") close(); });
        go.append(cancel, ok);
        box.append(go);
        shade.append(box);
        shade.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (e.target === shade) close(); });
        this.box.append(shade);
        const first = box.querySelector("input, select");
        if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 0);
        return shade;
    }

    _notify(msg, sev = "info") { if (this.host.notify) this.host.notify(msg, sev); }

    // ── the Layers panel ─────────────────────────────────────────────────────

    _buildLayersPart() {
        const p = this.el("div", "paint-panel");
        const head = this.el("div", "paint-lhead");
        this.blendSel = this.el("select", "", { title: "Blend mode" });
        for (const m of D.BLEND_MODES) this.blendSel.append(this.el("option", "", { value: m, text: D.BLEND_LABELS[m] }));
        this.blendSel.addEventListener("change", () => { const L = this.active(); if (L) this.setLayerProps(L.id, { blend: this.blendSel.value }, "Blend mode"); });
        this.opRange = this.el("input", "", { type: "range", min: 0, max: 100, step: 1, title: "Opacity" });
        this.opNum = this.el("input", "", { type: "number", min: 0, max: 100, step: 1, title: "Opacity %" });
        const setOp = (v, end) => {
            const L = this.active();
            if (!L) return;
            this.liveBegin();
            L.opacity = clamp(Number(v) / 100, 0, 1);
            this.opRange.value = this.opNum.value = Math.round(L.opacity * 100);
            this.requestRedraw();
            if (end) this.liveEnd("Opacity");
        };
        this.opRange.addEventListener("input", () => setOp(this.opRange.value, false));
        this.opRange.addEventListener("change", () => setOp(this.opRange.value, true));
        this.opNum.addEventListener("change", () => setOp(this.opNum.value, true));
        this.lockBtn = this.btn("lockOpen", "Lock the layer", () => { const L = this.active(); if (L) this.setLayerProps(L.id, { locked: !L.locked }, "Lock"); });
        head.append(this.blendSel, this.el("span", "", { text: "Opacity" }), this.opRange, this.opNum, this.lockBtn);
        this.layerList = this.el("div", "paint-list");
        const foot = this.el("div", "paint-lfoot");
        foot.append(this.btn("plus", "New layer (Ctrl+Shift+N)", () => this.newLayer()),
                    this.btn("adjust", "New adjustment layer", (e, b) => this._menu(b, D.ADJUST_TYPES.map((t) => ({ label: D.ADJUST_LABELS[t], run: () => this.addAdjustment(t) })))),
                    this.btn("mask", "Add a mask (from the selection, with one)", () => this.addMask(this.sel ? "selection" : "all")),
                    this.btn("copy", "Duplicate (Ctrl+J)", () => this.duplicateLayer()),
                    this.btn("mergeDown", "Merge down (Ctrl+E)", () => this.mergeDown()),
                    this.btn("trash", "Delete the layer", () => this.deleteLayer()));
        p.append(head, this.layerList, foot);
        return p;
    }

    refreshPanels() { this.refreshLayers(); this.refreshProps(); }

    refreshLayers() {
        const list = this.layerList;
        if (!list) return;
        list.replaceChildren();
        const d = this.doc;
        const L0 = this.active();
        for (const el of [this.blendSel, this.opRange, this.opNum]) el.disabled = !L0;
        if (!d) { list.append(this.el("div", "paint-note", { text: "Open a picture in Paint to see its layers." })); return; }
        if (L0) {
            this.blendSel.value = L0.blend;
            this.blendSel.disabled = L0.kind === "adjust";
            this.opRange.value = this.opNum.value = Math.round(L0.opacity * 100);
            this.lockBtn.replaceChildren(paintIcon(this.d, L0.locked ? "lock" : "lockOpen"));
            this.lockBtn.classList.toggle("on", !!L0.locked);
        }
        this._thumbJobs = [];
        for (const L of D.panelOrder(d)) {
            const row = this.el("div", "paint-row" + (L.id === d.active ? " active" : ""));
            row.dataset.id = L.id;
            row.draggable = true;
            const eye = this.el("span", "eye" + (L.visible ? "" : " off"), { title: L.visible ? "Hide" : "Show" });
            eye.append(paintIcon(this.d, L.visible ? "eye" : "eyeOff", 15));
            eye.addEventListener("click", (e) => { e.stopPropagation(); this.setLayerProps(L.id, { visible: !L.visible }, L.visible ? "Hide layer" : "Show layer"); });
            row.append(eye);
            if (L.kind === "pixel") {
                const th = this.el("canvas", (L.id === d.active && !this.editMask) ? "sel" : "", { width: 40, height: 30, title: "The layer's pixels" });
                th.addEventListener("click", (e) => { e.stopPropagation(); this.setActive(L.id, false); });
                this._thumbJobs.push([th, L, false]);
                row.append(th);
            } else {
                const a = this.el("span", "adj" + ((L.id === d.active && !this.editMask) ? " sel" : ""), { title: D.ADJUST_LABELS[L.adjust.type] });
                a.append(paintIcon(this.d, "adjust", 18));
                row.append(a);
            }
            if (L.mask) {
                const mt = this.el("canvas", (L.id === d.active && this.editMask) ? "sel" : "", { width: 40, height: 30,
                    title: "The mask: click to paint on it (white shows, black hides); Shift+click switches it off" });
                if (!L.mask.enabled) mt.style.opacity = ".35";
                mt.addEventListener("click", (e) => { e.stopPropagation(); if (e.shiftKey) { this.setActive(L.id); this.maskCmd("toggle"); } else this.setActive(L.id, true); });
                this._thumbJobs.push([mt, L, true]);
                row.append(mt);
            }
            const nm = this.el("span", "nm", { text: L.name, title: "Double-click to rename" });
            nm.addEventListener("dblclick", (e) => { e.stopPropagation(); this._rename(nm, L); });
            row.append(nm);
            if (L.text) row.append(this.el("span", "tag", { text: "T" }));
            if (L.blend !== "normal") row.append(this.el("span", "tag", { text: D.BLEND_LABELS[L.blend].split(" ")[0] }));
            if (L.locked) { const lk = this.el("span", "lk"); lk.append(paintIcon(this.d, "lock", 12)); row.append(lk); }
            row.addEventListener("click", () => this.setActive(L.id, false));
            row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.setActive(L.id); if (this.host.menu) this.host.menu(this._layerMenu(), e.clientX, e.clientY, row); });
            row.addEventListener("dragstart", (e) => { this._rowDrag = L.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", L.name); });
            row.addEventListener("dragover", (e) => {
                if (!this._rowDrag) return;
                e.preventDefault();
                const r = row.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
                row.classList.toggle("drop-above", above); row.classList.toggle("drop-below", !above);
            });
            row.addEventListener("dragleave", () => row.classList.remove("drop-above", "drop-below"));
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("drop-above", "drop-below");
                const id = this._rowDrag;
                this._rowDrag = null;
                if (!id || id === L.id) return;
                const r = row.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
                // The list is top first: above a row is a higher index.
                const from = D.layerIndex(d, id);
                let to = D.layerIndex(d, L.id) + (above ? 1 : 0);
                if (from < to) to -= 1;
                if (from !== to) this.moveLayer(id, to);
            });
            row.addEventListener("dragend", () => { this._rowDrag = null; });
            list.append(row);
        }
        this._drawThumbs();
    }

    _rename(nm, L) {
        const inp = this.el("input", "", { type: "text", value: L.name });
        nm.replaceChildren(inp);
        inp.focus(); inp.select();
        const done = (keep) => { const v = inp.value.trim(); if (keep && v && v !== L.name) this.setLayerProps(L.id, { name: v.slice(0, 120) }, "Rename"); else this.refreshLayers(); };
        inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
        inp.addEventListener("blur", () => done(true));
        inp.addEventListener("click", (e) => e.stopPropagation());
    }

    _thumbsSoon() {
        if (this._thumbT) return;
        this._thumbT = this.d.defaultView.setTimeout(() => { this._thumbT = 0; this._drawThumbs(); }, 250);
    }

    _drawThumbs() {
        for (const [cv, L, mask] of this._thumbJobs || []) {
            const g = cv.getContext("2d");
            g.clearRect(0, 0, cv.width, cv.height);
            const W = this.doc.w, H = this.doc.h;
            const k = Math.min(cv.width / W, cv.height / H);
            const ox = (cv.width - W * k) / 2, oy = (cv.height - H * k) / 2;
            if (mask) {
                const m = this.masks.get(L.id), mk = L.mask;
                if (!m) continue;
                g.fillStyle = mk.fill ? "#fff" : "#000"; g.fillRect(ox, oy, W * k, H * k);
                const im = new ImageData(mk.w, mk.h);
                for (let i = 0; i < m.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = m[i]; im.data[i * 4 + 3] = 255; }
                drawScaled(this.d, g, im, ox + mk.x * k, oy + mk.y * k, mk.w * k, mk.h * k);
            } else {
                const px = this.pix.get(L.id);
                if (!px || !L.w || !L.h) continue;
                g.fillStyle = "#777"; g.fillRect(ox, oy, W * k, H * k);
                drawScaled(this.d, g, new ImageData(new Uint8ClampedArray(px), L.w, L.h), ox + L.x * k, oy + L.y * k, L.w * k, L.h * k);
            }
        }
    }

    // ── the Properties panel ─────────────────────────────────────────────────

    _buildPropsPart() {
        const p = this.el("div", "paint-panel");
        this.propsBox = this.el("div", "paint-props");
        p.append(this.propsBox);
        return p;
    }

    _field(parent, label, input, wide = false) {
        const row = this.el("div", "paint-field" + (wide ? " wide" : ""));
        row.append(this.el("label", "", { text: label, title: label }), ...[].concat(input));
        parent.append(row);
        return row;
    }

    _slider(parent, label, value, min, max, step, onLive, onEnd) {
        const r = this.el("input", "", { type: "range", min, max, step, value });
        const n = this.el("input", "", { type: "number", min, max, step, value });
        r.addEventListener("input", () => { n.value = r.value; onLive(Number(r.value)); });
        r.addEventListener("change", () => onEnd && onEnd(Number(r.value)));
        n.addEventListener("change", () => { const v = D.num(n.value, value, min, max); r.value = n.value = v; onLive(v); if (onEnd) onEnd(v); });
        n.addEventListener("keydown", (e) => e.stopPropagation());
        return this._field(parent, label, [r, n]);
    }

    refreshProps() {
        const box = this.propsBox;
        if (!box) return;
        box.replaceChildren();
        // The tool.
        const ts = this.el("div", "paint-sect");
        const tool = PAINT_TOOLS.find((t) => t[0] === this.tool);
        ts.append(this.el("h4", "", { text: tool ? tool[2] : "Tool" }));
        const o = this.opts;
        if (this.tool === "brush" || this.tool === "eraser") {
            const b = o[this.tool];
            this._slider(ts, "Size", b.size, 1, 1000, 1, (v) => { b.size = v; this.drawOverlay(); });
            this._slider(ts, "Hardness", b.hardness, 0, 100, 1, (v) => { b.hardness = v; });
            this._slider(ts, "Opacity", b.opacity, 1, 100, 1, (v) => { b.opacity = v; });
            this._slider(ts, "Spacing %", b.spacing, 1, 100, 1, (v) => { b.spacing = v; });
            ts.append(this.el("div", "paint-note", { text: this.editMask ? "Painting the layer's MASK: white shows, black hides." : "Alt+click picks a colour; Shift+click draws a straight line." }));
        } else if (this.tool === "fill" || this.tool === "wand") {
            const f = o[this.tool];
            this._slider(ts, "Tolerance", f.tolerance, 0, 255, 1, (v) => { f.tolerance = v; });
            const c1 = this.el("input", "", { type: "checkbox", checked: f.contiguous });
            c1.addEventListener("change", () => { f.contiguous = c1.checked; });
            this._field(ts, "Contiguous", c1);
            const c2 = this.el("input", "", { type: "checkbox", checked: f.all });
            c2.addEventListener("change", () => { f.all = c2.checked; });
            this._field(ts, "All layers", c2);
        } else if (["marquee", "ellipse", "lasso"].includes(this.tool)) {
            this._slider(ts, "Feather", o.select.feather, 0, 200, 0.5, (v) => { o.select.feather = v; });
            ts.append(this.el("div", "paint-note", { text: "Shift adds to the selection, Alt takes from it, both keep what they share." }));
        } else if (this.tool === "text") {
            const t = o.text;
            const font = this.el("input", "", { type: "text", value: t.font });
            font.addEventListener("change", () => { t.font = font.value || "sans-serif"; });
            font.addEventListener("keydown", (e) => e.stopPropagation());
            this._field(ts, "Font", font);
            this._slider(ts, "Size", t.size, 4, 1000, 1, (v) => { t.size = v; });
            const bold = this.el("input", "", { type: "checkbox", checked: t.bold });
            bold.addEventListener("change", () => { t.bold = bold.checked; });
            const it = this.el("input", "", { type: "checkbox", checked: t.italic });
            it.addEventListener("change", () => { t.italic = it.checked; });
            this._field(ts, "Bold / italic", [bold, it]);
            ts.append(this.el("div", "paint-note", { text: "Click to write; Enter keeps it (Shift+Enter: a new line), Esc throws it away. Click a text layer to write it again." }));
        } else if (this.tool === "crop") {
            const go = this.el("button", "paint-btn on", { type: "button", text: "Apply crop (Enter)" });
            go.addEventListener("click", () => this.applyCrop());
            ts.append(go, this.el("div", "paint-note", { text: "Drag a rectangle; drag inside it to move it." }));
        } else if (this.tool === "move") {
            ts.append(this.el("div", "paint-note", { text: "Drag to move the layer (its mask goes with it); the arrows nudge it." }));
        } else if (this.tool === "picker") {
            ts.append(this.el("div", "paint-note", { text: "Click or drag over the picture: its colour becomes the brush's." }));
        }
        const col = this.el("div", "paint-field");
        const fgc = this.el("input", "", { type: "color", value: D.rgbToHex(...this.fg) });
        fgc.addEventListener("input", () => { this.fg = D.hexToRgb(fgc.value); this._swatches(); });
        const bgc = this.el("input", "", { type: "color", value: D.rgbToHex(...this.bg) });
        bgc.addEventListener("input", () => { this.bg = D.hexToRgb(bgc.value); this._swatches(); });
        col.append(this.el("label", "", { text: "Colours" }), fgc, bgc);
        ts.append(col);
        box.append(ts);
        // The layer.
        const L = this.active();
        if (L) box.append(this._layerSection(L));
        // Generate.
        box.append(this._generateSection());
    }

    _layerSection(L) {
        const s = this.el("div", "paint-sect");
        s.append(this.el("h4", "", { text: L.kind === "adjust" ? D.ADJUST_LABELS[L.adjust.type] : L.text ? "Text layer" : "Layer" }));
        if (L.kind === "adjust") {
            const t = L.adjust.type;
            const live = (patch) => { this.liveBegin(); L.adjust.params = D.cleanAdjust(t, { ...L.adjust.params, ...patch }); this.requestRedraw(); };
            const end = () => this.liveEnd(D.ADJUST_LABELS[t]);
            if (t === "curves") s.append(this._curveEditor(L, live, end));
            for (const [k, label, a, b, step] of D.ADJUST_FIELDS[t]) {
                const v = L.adjust.params[k];
                if (Array.isArray(v)) {
                    // Grade: one slider for all three, and a field per channel.
                    this._slider(s, label, v[0], a, b, step, (x) => live({ [k]: [x, x, x] }), end);
                    const trio = ["R", "G", "B"].map((c, i) => {
                        const n = this.el("input", "", { type: "number", min: a, max: b, step, value: v[i], title: c });
                        n.addEventListener("change", () => { const arr = [...L.adjust.params[k]]; arr[i] = D.num(n.value, v[i], a, b); live({ [k]: arr }); end(); });
                        n.addEventListener("keydown", (e) => e.stopPropagation());
                        return n;
                    });
                    this._field(s, "  R G B", trio);
                } else this._slider(s, label, v, a, b, step, (x) => live({ [k]: x }), end);
            }
            if (!D.ADJUST_FIELDS[t].length && t !== "curves") s.append(this.el("div", "paint-note", { text: "Nothing to set: it inverts what is under it." }));
            s.append(this.el("div", "paint-note", { text: "It changes every layer under it. Paint its mask (or select first) to limit it." }));
        } else if (L.text) {
            const t = L.text;
            const ta = this.el("textarea", "", { value: t.text });
            ta.addEventListener("keydown", (e) => e.stopPropagation());
            ta.addEventListener("change", () => this.retext({ text: ta.value }));
            s.append(ta);
            const font = this.el("input", "", { type: "text", value: t.font });
            font.addEventListener("keydown", (e) => e.stopPropagation());
            font.addEventListener("change", () => this.retext({ font: font.value }));
            this._field(s, "Font", font);
            const size = this.el("input", "", { type: "number", value: t.size, min: 4, max: 2000 });
            size.addEventListener("keydown", (e) => e.stopPropagation());
            size.addEventListener("change", () => this.retext({ size: D.num(size.value, t.size, 4, 2000) }));
            this._field(s, "Size", size);
            const c = this.el("input", "", { type: "color", value: t.color });
            c.addEventListener("change", () => this.retext({ color: c.value }));
            this._field(s, "Colour", c);
            const bold = this.el("input", "", { type: "checkbox", checked: t.bold });
            bold.addEventListener("change", () => this.retext({ bold: bold.checked }));
            const it = this.el("input", "", { type: "checkbox", checked: t.italic });
            it.addEventListener("change", () => this.retext({ italic: it.checked }));
            this._field(s, "Bold / italic", [bold, it]);
            const al = this.el("select");
            for (const a of ["left", "center", "right"]) al.append(this.el("option", "", { value: a, text: a }));
            al.value = t.align;
            al.addEventListener("change", () => this.retext({ align: al.value }));
            this._field(s, "Align", al);
        } else {
            s.append(this.el("div", "paint-note", { text: `${L.w} x ${L.h} at ${L.x}, ${L.y}` + (L.mask ? (L.mask.enabled ? " · mask on" : " · mask off") : "") }));
        }
        return s;
    }

    _curveEditor(L, live, end) {
        const wrap = this.el("div");
        const ch = this.el("select");
        for (const [v, t] of [["rgb", "RGB"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]]) ch.append(this.el("option", "", { value: v, text: t }));
        ch.value = this._curveCh || "rgb";
        ch.addEventListener("change", () => { this._curveCh = ch.value; draw(); });
        const cv = this.el("canvas", "paint-curve", { width: 256, height: 256, title: "Drag a point; click to add one; right-click takes one away" });
        const pts = () => L.adjust.params[ch.value] || [[0, 0], [255, 255]];
        const draw = () => {
            const g = cv.getContext("2d");
            g.fillStyle = "#111"; g.fillRect(0, 0, 256, 256);
            g.strokeStyle = "#2a2a30"; g.lineWidth = 1;
            for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * 64 + 0.5, 0); g.lineTo(i * 64 + 0.5, 256); g.moveTo(0, i * 64 + 0.5); g.lineTo(256, i * 64 + 0.5); g.stroke(); }
            const lut = D.curveLut(pts());
            g.strokeStyle = { rgb: "#ddd", r: "#f55", g: "#5d5", b: "#58f" }[ch.value]; g.lineWidth = 2;
            g.beginPath();
            for (let x = 0; x < 256; x++) { const y = 255 - lut[x] * 255; if (x) g.lineTo(x, y); else g.moveTo(x, y); }
            g.stroke();
            g.fillStyle = "#f60";
            for (const [x, y] of pts()) { g.beginPath(); g.arc(x, 255 - y, 4, 0, Math.PI * 2); g.fill(); }
        };
        let dragI = -1;
        const at = (e) => { const r = cv.getBoundingClientRect(); return [clamp((e.clientX - r.left) * 256 / r.width, 0, 255), clamp(255 - (e.clientY - r.top) * 256 / r.height, 0, 255)]; };
        cv.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            const [x, y] = at(e);
            const list = pts().map((p) => p.slice());
            let i = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 10);
            if (e.button === 2) {
                if (i > 0 && i < list.length - 1) { list.splice(i, 1); live({ [ch.value]: list }); end(); draw(); }
                return;
            }
            if (i < 0) { list.push([x, y]); list.sort((a, b) => a[0] - b[0]); i = list.findIndex((p) => p[0] === x && p[1] === y); live({ [ch.value]: list }); }
            dragI = i;
            cv.setPointerCapture(e.pointerId);
            draw();
        });
        cv.addEventListener("pointermove", (e) => {
            if (dragI < 0) return;
            const [x, y] = at(e);
            const list = pts().map((p) => p.slice());
            const lo = dragI > 0 ? list[dragI - 1][0] + 1 : 0, hi = dragI < list.length - 1 ? list[dragI + 1][0] - 1 : 255;
            list[dragI] = [dragI === 0 ? 0 : dragI === list.length - 1 ? 255 : clamp(x, lo, hi), y];
            if (dragI === 0) list[0][0] = Math.min(list[0][0], hi);
            live({ [ch.value]: list });
            draw();
        });
        cv.addEventListener("pointerup", () => { if (dragI >= 0) { dragI = -1; end(); } });
        cv.addEventListener("contextmenu", (e) => e.preventDefault());
        wrap.append(this._field(wrap, "Channel", ch), cv);
        draw();
        return wrap;
    }

    _generateSection() {
        const s = this.el("div", "paint-sect");
        s.append(this.el("h4", "", { text: "Generate (agentY)" }));
        const ta = this.el("textarea", "", { value: this._prompt || "", placeholder: "What to make in the selection - e.g. \"a red umbrella\"" });
        ta.addEventListener("keydown", (e) => e.stopPropagation());
        ta.addEventListener("input", () => { this._prompt = ta.value; });
        s.append(ta);
        const row = this.el("div", "paint-gen");
        const g = (label, kind, title, extra = () => ({})) => {
            const b = this.el("button", "paint-btn", { type: "button", text: label, title });
            b.addEventListener("click", () => this.host.generate && this.host.generate(kind, { prompt: this._prompt || "", ...extra() }));
            row.append(b);
        };
        g("Generative fill", "fill", "Make what the prompt says inside the selection: a new layer, masked to it");
        g("Remove object", "remove", "Take what is selected away and fill the place: a new layer");
        g("Fill around", "heal", "Fill the selection from what is around it, here and without AI");
        g("Remove background", "background", "A mask on the layer that hides the background");
        g("Select subject", "select_subject", "The selection becomes the main subject");
        g("Extend 128 px", "extend", "A bigger canvas, the new part filled by agentY", () => ({ px: 128, ai: true }));
        g("Upscale 2x", "upscale", "Twice the size, the detail made by agentY", () => ({ k: 2, ai: true }));
        s.append(row, this.el("div", "paint-note", { text: "The picture is saved first; agentY makes the pixels and puts them back as a layer here." }));
        return s;
    }

    // ── files ────────────────────────────────────────────────────────────────

    /**
     * What a save sends: { meta, layers: {id: Uint8ClampedArray}, masks: {id: Uint8Array}, selection, keep: [ids] } -
     * the pixels RAW (straight RGBA / grey), so nothing is rounded on the way (a canvas' PNG would premultiply);
     * a layer whose pixels did not change since the last save is named in `keep` and not sent again.
     */
    toSave({ all = false } = {}) {
        const meta = JSON.parse(JSON.stringify(this.doc));
        const layers = {}, masks = {}, keep = [];
        for (const L of this.doc.layers) {
            const b = L.kind === "pixel" ? this.pix.get(L.id) : null, was = this.saved.get("p:" + L.id);
            const samePx = L.kind !== "pixel" || (!all && was && was[0] === b && was[1] === (this.bufVer.get(b) || 0));
            const sameMask = !L.mask || (!all && this._sameMask(L));
            if (samePx && sameMask) { keep.push(L.id); continue; }
            // A layer is kept whole or sent whole: its pixels and its mask go together.
            if (L.kind === "pixel") layers[L.id] = b;
            if (L.mask) masks[L.id] = this.masks.get(L.id);
        }
        const selection = this.sel || new Uint8Array(this.doc.w * this.doc.h);
        return { meta, layers, masks, selection, keep };
    }

    _sameMask(L) {
        const b = this.masks.get(L.id), was = this.saved.get("m:" + L.id);
        return !!(was && was[0] === b && was[1] === (this.bufVer.get(b) || 0));
    }

    markSaved() { this.savedVersion = this.version; this._markSavedRefs(); this._emit(); }

    /** The picture as it looks, as a PNG Blob. */
    async flatPng() { return toPng(this.d, D.composite(this.doc, this._pixOf, this._maskOf), this.doc.w, this.doc.h); }

    /** The document the agent changed replaces this one, as one undo step. */
    replaceWith(data, label = "agentY") {
        const before = this._snap();
        const next = { doc: D.cleanDoc(data.doc), pix: new Map(Object.entries(data.pix || {})), masks: new Map(Object.entries(data.masks || {})),
                       sel: data.selection && data.selection.length === data.doc.w * data.doc.h ? data.selection : null };
        for (const L of next.doc.layers) if (L.kind === "pixel" && !next.pix.has(L.id)) next.pix.set(L.id, new Uint8ClampedArray(L.w * L.h * 4));
        const sizeChanged = next.doc.w !== this.doc.w || next.doc.h !== this.doc.h;
        this._restore(next);
        const after = this._snap();
        this._push({ label, undo: () => this._restore(before), redo: () => this._restore(after), bytes: this._snapBytes(before, after) });
        this._afterHistory();
        if (sizeChanged) this.fit();
    }

    dispose() {
        try { this._ro.disconnect(); } catch (_) { /* gone */ }
        this.d.defaultView.clearInterval(this._ants);
        this.box.remove();
        for (const p of Object.values(this.parts)) p.remove();
    }
}

const ANCHOR = { top_left: [0, 0], top: [0.5, 0], top_right: [1, 0], left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
                 bottom_left: [0, 1], bottom: [0.5, 1], bottom_right: [1, 1] };
const triple1 = (v) => (Array.isArray(v) ? v[0] : v);
function expandTriples(t, v) {
    const out = { ...v };
    for (const [k] of D.ADJUST_FIELDS[t]) if (Array.isArray(D.ADJUST_DEFAULTS[t][k])) out[k] = [v[k], v[k], v[k]];
    return out;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function canvasOf(doc, w, h) {
    const c = doc.createElement("canvas");
    c.width = w; c.height = h;
    return c;
}

function drawScaled(doc, g, imageData, x, y, w, h) {
    const c = canvasOf(doc, imageData.width, imageData.height);
    c.getContext("2d").putImageData(imageData, 0, 0);
    g.imageSmoothingQuality = "high";
    g.drawImage(c, x, y, w, h);
}

/** Pixels w x h resampled to nw x nh by the browser (premultiplied, high quality). */
function resample(doc, px, w, h, nw, nh) {
    const a = canvasOf(doc, w, h);
    a.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
    const b = canvasOf(doc, nw, nh);
    const g = b.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(a, 0, 0, nw, nh);
    return new Uint8ClampedArray(g.getImageData(0, 0, nw, nh).data);
}

function resampleMask(doc, m, w, h, nw, nh) {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < m.length; i++) { px[i * 4] = m[i]; px[i * 4 + 3] = 255; }
    const out = resample(doc, px, w, h, nw, nh);
    const r = new Uint8Array(nw * nh);
    for (let i = 0; i < r.length; i++) r[i] = out[i * 4];
    return r;
}

/** A text layer's pixels, drawn by the browser: { px, w, h }. */
export function renderText(doc, t) {
    const font = `${t.italic ? "italic " : ""}${t.bold ? "bold " : ""}${t.size}px ${t.font}`;
    const probe = canvasOf(doc, 1, 1).getContext("2d");
    probe.font = font;
    const lines = t.text.split("\n");
    const lh = Math.round(t.size * 1.25);
    const widths = lines.map((l) => probe.measureText(l || " ").width);
    const w = Math.max(1, Math.ceil(Math.max(...widths)) + 8), h = Math.max(1, lh * lines.length + 8);
    const c = canvasOf(doc, w, h);
    const g = c.getContext("2d");
    g.font = font;
    g.fillStyle = t.color;
    g.textBaseline = "top";
    lines.forEach((l, i) => {
        const x = t.align === "center" ? (w - widths[i]) / 2 : t.align === "right" ? w - widths[i] - 4 : 4;
        g.fillText(l, x, 4 + i * lh + (lh - t.size) / 2);
    });
    return { px: new Uint8ClampedArray(g.getImageData(0, 0, w, h).data), w, h };
}

function blobOf(c) {
    if (c.convertToBlob) return c.convertToBlob({ type: "image/png" });
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("the picture could not be encoded"))), "image/png"));
}

/** Straight RGBA as a PNG Blob (a canvas does this losslessly for straight alpha only at 255; see note). */
export async function toPng(doc, px, w, h) {
    if (!w || !h) { w = 1; h = 1; px = new Uint8ClampedArray(4); }
    const c = canvasOf(doc, w, h);
    // putImageData writes the bytes as they are; the PNG the canvas encodes keeps them where alpha is 255
    // and, through premultiplication, rounds the colour of half see-through pixels by a level or so.
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
    return blobOf(c);
}

async function maskToPng(doc, m, w, h) {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < m.length; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = m[i]; px[i * 4 + 3] = 255; }
    return toPng(doc, px, w, h);
}

export function createPaintEditor(root, host) {
    return new PaintEditor(root, host);
}
