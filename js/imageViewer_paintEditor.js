// imageViewer_paintEditor.js
// Paint: a small picture editor - layers, a brush, selections, masks, adjustment layers - as one object
// that does not know the viewer. imageViewer_paintPanel.js is the glue (the tab, the dock panels, files,
// the agent); this file is the canvas, the tools and the two panels' contents (`parts.layers`, `parts.props`).
//
// The picture is drawn by imageViewer_paintData.js's arithmetic (composite / layPixels / layAdjust) into
// one RGBA buffer the size of the document, shown in a <canvas> that is zoomed and panned with CSS. While
// a stroke is painted only its rectangle is drawn again, over a copy of what lies under the layer (`below`).
//
// Undo: every change is ONE entry. A change of the document's shape (layers added, removed, moved, their
// switches, a filter that makes new pixels) keeps the document before and after - the layers' pixel
// buffers by reference, never copied; a stroke changes its layer's buffer IN PLACE and keeps the
// rectangle it touched, before and after. Entries are undone in order, so a buffer that a kept document
// refers to is always back in the state it had then.
import * as D from "./imageViewer_paintData.js";
import { paintIcon } from "./imageViewer_paintIcons.js";
import { FILTERS } from "./imageViewer_paintFilters.js";
import { PenMixin } from "./imageViewer_paintPen.js";
import { WarpMixin } from "./imageViewer_paintWarp.js";
import { HealMixin } from "./imageViewer_paintHeal.js";
import { TipsMixin } from "./imageViewer_paintAbr.js";
import { DrawMixin, smudgeStart, smudgeDab, blurDab, SHAPE_KINDS } from "./imageViewer_paintDraw.js";
import { BUF_VER, STYLE_KINDS, STYLE_LABELS } from "./imageViewer_paintStyle.js";
import { LayerFxMixin } from "./imageViewer_paintLayerFx.js";
import { SelectGuidesMixin, RULER_PX } from "./imageViewer_paintSelect.js";
import { SmartMixin } from "./imageViewer_paintSmart.js";
import { LiquifyMixin } from "./imageViewer_paintLiquify.js";
import { PreviewMixin } from "./imageViewer_paintPreview.js";
import { PathToolsMixin, PATH_TOOLS, TOOL_GROUPS, GROUP_HINTS, toolGroup } from "./imageViewer_paintPathTools.js";
import { AdjustUIMixin, ADJUST_CSS } from "./imageViewer_paintAdjustUI.js";
import { SmartLayerMixin } from "./imageViewer_paintSmartLayer.js";
import { GenStatusMixin, GEN_CSS } from "./imageViewer_paintGenStatus.js";
import { BrushDragMixin } from "./imageViewer_paintBrushDrag.js";

/** A dialog slider's step for the range a..b: about a thousand steps, a whole number where the range is wide. */
export function dialogStep(a, b) {
    const span = b - a;
    if (span >= 100) return 1;
    const raw = span / 1000, p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw);
}
const roundTo = (v, step) => { const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)); return Number(v.toFixed(Math.min(6, d))); };

export const PAINT_TOOLS = [
    ["move", "transform", "Transform (move, scale, rotate, shear)", "V"], ["tfsel", "tfSel", "Transform selection: the selected pixels (Shift+V)", "Shift+V"], ["marquee", "marquee", "Rectangle select", "M"], ["ellipse", "ellipse", "Ellipse select", "Shift+M"],
    ["lasso", "lasso", "Lasso", "L"], ["pen", "pen", "Pen (paths)", "P"], ["penadd", "penAdd", "Add anchor point", "Shift+P"],
    ["pendel", "penDel", "Delete anchor point", "Shift+P"], ["penconv", "penConv", "Convert point: corner / smooth", "Shift+P"],
    ["pathsel", "pathSel", "Path selection: the whole path", "A"], ["pathdirect", "pathDirect", "Direct selection: anchors and handles", "Shift+A"], ["wand", "wand", "Magic wand", "W"], ["crop", "crop", "Crop", "C"],
    ["brush", "brush", "Brush", "B"], ["clone", "clone", "Clone stamp", "S"], ["spot", "bandage", "Spot healing brush", "J"], ["heal", "heal", "Healing brush (Shift+J)", "Shift+J"],
    ["patch", "patch", "Patch (Shift+J)", "Shift+J"], ["eraser", "eraser", "Eraser", "E"], ["fill", "fill", "Paint bucket", "G"],
    ["gradient", "gradient", "Gradient (Shift+G)", "Shift+G"], ["dodge", "dodge", "Dodge", "O"], ["burn", "burn", "Burn (Shift+O)", "Shift+O"],
    ["sponge", "sponge", "Sponge (Shift+O)", "Shift+O"], ["smudge", "smudge", "Smudge (Shift+R: blur)", "R"], ["blur", "blur", "Blur (Shift+R)", "Shift+R"], ["liquify", "liquify", "Liquify (Shift+Ctrl+X)", "Shift+Ctrl+X"], ["shape", "shape", "Shapes (Shift+U: the next shape)", "U"],
    ["shape:rect", "shapeRect", "Rectangle", "U"], ["shape:rounded", "shapeRounded", "Rounded rectangle", "Shift+U"], ["shape:ellipse", "shapeEllipse", "Ellipse", "Shift+U"],
    ["shape:polygon", "shapePolygon", "Polygon", "Shift+U"], ["shape:line", "shapeLine", "Line", "Shift+U"],
    ["picker", "picker", "Eyedropper (drag: the average of a box)", "I"], ["text", "text", "Text", "T"], ["hand", "hand", "Hand (hold Space)", "H"],
];
const TOOL_KEYS = { v: "move", m: "marquee", l: "lasso", p: "pen", j: "spot", w: "wand", c: "crop", b: "brush", s: "clone", e: "eraser", g: "fill", i: "picker",
                    t: "text", h: "hand", o: "dodge", r: "smudge", u: "shape", a: "pathsel" };
/** The tools that paint with a round brush (size, hardness, opacity, spacing, the pen). */
const BRUSHES = ["brush", "clone", "eraser", "spot", "heal", "dodge", "burn", "sponge", "smudge", "blur"];
/** The brushes that change the pixels under them rather than lay a colour down. */
const TONERS = ["dodge", "burn", "sponge"];
/** The brushes that take from a source point (Alt+click). */
const SOURCED = ["clone", "heal"];
/** The keys, for the viewer's Show Hotkeys while a Paint tab is up. */
export const PAINT_KEYS = [
    ["V M L P W C", "Transform, select, lasso, pen, magic wand, crop"],
    ["Shift+V", "Transform selection: move, scale and rotate the selected pixels (right-click the Transform tool)"],
    ["Pen", "Click: corner, drag: smooth anchor, first anchor: close, Enter: stop; Ctrl+drag: move, Alt+click: corner / smooth"],
    ["Ctrl+Enter (pen)", "The path as the selection (Shift: add, Alt: take away)"],
    ["Right-click the pen", "The path tools: add / delete anchor, convert point, path selection, direct selection"],
    ["Shift+P", "The next of pen, add anchor, delete anchor, convert point"],
    ["A / Shift+A", "Path selection (drag: the whole path, Alt: a copy) / direct selection (anchors; Shift+click, box)"],
    ["Arrows, Del (A)", "Nudge (Shift: 10 px) / delete the path or the picked anchors"], ["B S E G I T H", "Brush, clone stamp, eraser, bucket, eyedropper, text, hand"],
    ["[ / ]", "Brush smaller / larger (Shift: softer / harder)"],
    ["Hold B + drag / Alt+right-drag", "Any brush (the mask and Quick Mask too): sideways the size, up / down the opacity (Shift: the hardness); Liquify: the strength"], ["X / D", "Swap / default colours"],
    ["Alt+click", "Pick a colour (brush, bucket); the clone stamp and healing brush: where they take from"],
    ["J / Shift+J", "Spot healing brush / the next of healing brush, patch, spot healing"],
    ["G / Shift+G", "Paint bucket / gradient (Shift: 45° steps)"], ["O / Shift+O", "Dodge / the next of burn, sponge, dodge"], ["R / Shift+R", "Smudge / blur (Shift+R again: back to smudge)"],
    ["U / Shift+U", "Shapes / the next shape (Shift: square, Alt: from the middle)"],
    ["Transform: drag", "Inside: move; a handle: scale (Shift: keep the shape, Alt: about the middle); outside: rotate (Shift: 15°); Ctrl+edge handle: shear"],
    ["Shift+Ctrl+X", "Liquify (Enter applies, Esc cancels)"], ["Ctrl+R / Ctrl+; / Ctrl+Shift+;", "Rulers / guides / snapping"],
    ["Ctrl+T", "Transform the layer"], ["Shift+F5", "Fill… (in Properties)"], ["Del / Backspace in Layers", "Delete the layer (or its mask)"], ["Space+drag", "Pan"], ["Wheel", "Zoom about the pointer"],
    ["Ctrl+0 / Ctrl+1", "Fit / 100%"], ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"], ["Ctrl+A / Ctrl+D", "Select all / deselect"],
    ["Ctrl+Shift+I", "Invert the selection"], ["Shift / Alt while selecting", "Add to / take from the selection"],
    ["Del", "Clear the selection on the layer"], ["Alt+Del", "Fill the selection with the colour"], ["Ctrl+J", "Duplicate the layer (the selection only, with one)"],
    ["Ctrl+E", "Merge down (several picked: merge them; a group: merge it)"], ["Ctrl+Shift+N", "New layer"],
    ["Ctrl+G / Ctrl+Shift+G", "Group the picked layers / ungroup"],
    ["Ctrl+C / Ctrl+Shift+C / Ctrl+X", "Copy the selection (of the layer / merged) / cut"], ["Ctrl+V / Ctrl+Shift+V", "Paste as a new layer (in the middle / in place)"], ["Shift / Ctrl+click in Layers", "Pick a range / one more layer"],
    ["Ctrl+Alt+A", "Pick every layer"], ["Q", "Quick Mask: paint the selection (black takes away, white adds); Q again makes it the selection"],
    ["Alt+click a mask's thumbnail / \\", "See the active layer's mask on the canvas and paint on it (again or Esc: the picture; \\ is # on a German keyboard)"],
    ["Shift+\\", "The mask over the picture in red, or on its own"],
    ["Drag a layer onto a layer's middle", "It becomes that layer's mask (its brightness; transparent is black). Alt: keep the layer too"], ["Ctrl+click a thumbnail", "Its pixels (or the mask) as the selection (Ctrl+Shift: add, Ctrl+Alt: take away)"], ["Ctrl+Alt+G / Alt+click in Layers", "Clip the layer to the one under it (or release it)"], ["Arrows", "Nudge the layer (Move; Shift: 10 px)"],
    ["Enter / Esc", "Apply / cancel the crop, the transform or the text"], ["Ctrl+S / Ctrl+Shift+S", "Save / save as"],
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
.paint-optbar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 3px 8px; min-height: 26px; background: #19191d;
  border-bottom: 1px solid #2b2b30; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scrollbar-width: thin; }
.paint-optbar .paint-otool { color: #f60; font-weight: 600; flex: 0 0 auto; }
.paint-optbar .paint-field { margin: 0; flex: 0 0 auto; gap: 4px; }
.paint-optbar .paint-field > label { flex: 0 0 auto; color: #999; }
.paint-optbar input[type=range] { width: 80px; accent-color: #f60; }
.paint-optbar input[type=number], .paint-optbar select { background: #111; color: #4fd6ee; border: 1px solid #3a3a40; border-radius: 3px; font: inherit; padding: 1px 3px; }
.paint-optbar input[type=number] { width: 52px; }
.paint-optbar select { color: #ddd; }
.paint-optbar .paint-btn { height: 20px; border-color: #3a3a40; }
.paint-optbar .paint-note { margin: 0; }
.paint-tools { flex: 0 0 auto; display: flex; flex-direction: column; gap: 2px; padding: 4px 3px; background: #1d1d21; border-right: 1px solid #2b2b30; }
.paint-tools .paint-btn { width: 30px; height: 28px; padding: 0; }
.paint-btn.paint-grouped { position: relative; }
.paint-btn.paint-grouped::after { content: ""; position: absolute; right: 2px; bottom: 2px; border: 3px solid transparent; border-right-color: currentColor; border-bottom-color: currentColor; opacity: .6; }
.paint-flyout { position: absolute; z-index: 30; display: flex; gap: 2px; padding: 3px; background: #1d1d21; border: 1px solid #3a3a40; border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,.5); }
.paint-flyout .paint-btn { width: 30px; height: 28px; padding: 0; }
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
.paint-world.pixelated canvas.paint-canvas, .paint-world.pixelated canvas.paint-tint { image-rendering: pixelated; }
.paint-world canvas.paint-tint { position: absolute; left: 0; top: 0; pointer-events: none; display: none; }
.paint-maskbar { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 6; display: none; align-items: center; gap: 6px;
  padding: 3px 4px 3px 10px; background: rgba(24,24,28,.94); border: 1px solid #f60; border-radius: 4px; white-space: nowrap; cursor: default; max-width: calc(100% - 16px); }
.paint-maskbar.on { display: flex; }
.paint-maskbar b { color: #fff; overflow: hidden; text-overflow: ellipsis; } .paint-maskbar .note { color: #999; }
.paint-world canvas.paint-preview { position: absolute; left: 0; top: 0; pointer-events: none; display: none; background-color: #fff;
  background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%),
  linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%);
  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
.paint-btn.quick.on { color: #f66; }
.paint-overlay { position: absolute; left: 0; top: 0; pointer-events: none; }
.paint-status { flex: 0 0 auto; display: flex; gap: 14px; padding: 2px 8px; background: #1d1d21; border-top: 1px solid #2b2b30; color: #999; font-size: 11px; white-space: nowrap; overflow: hidden; }
.paint-status b { color: #f60; font-weight: 600; }
.paint-text-input { position: absolute; z-index: 5; background: rgba(0,0,0,.15); border: 1px dashed #f60; outline: none; resize: none;
  padding: 0; margin: 0; overflow: hidden; white-space: pre; line-height: 1.25; }
.paint-empty { position: absolute; inset: 0; cursor: default; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #999; text-align: center; padding: 20px; }
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
.paint-row.drop-inside { box-shadow: inset 0 0 0 2px #f60; }
.paint-row.drop-mask { position: relative; box-shadow: inset 0 0 0 2px #2bd; background: rgba(34,187,221,.12); }
.paint-row.drop-mask::after { content: "→ its mask"; position: absolute; right: 6px; top: 50%; transform: translateY(-50%); color: #2bd; font-size: 11px; pointer-events: none; }
.paint-row.picked { background: #2d2620; }
.paint-row.active.picked, .paint-row.active { background: #3a2a1d; }
.paint-row.dimmed .nm, .paint-row.dimmed canvas { opacity: .45; }
.paint-row .clipmark { color: #f60; flex: 0 0 auto; font-size: 14px; margin-left: -12px; width: 10px; }
.paint-row .nm.base { text-decoration: underline; text-underline-offset: 2px; }
.paint-row .caret { width: 14px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; color: #aaa; }
.paint-row .caret.none { visibility: hidden; }
.paint-row .grp { flex: 0 0 auto; width: 40px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #444; color: #e0b070; background: #222; }
.paint-row .grp.sel { border-color: #fff; box-shadow: 0 0 0 1px #f60; }
.paint-row .eye { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; color: #bbb; flex: 0 0 auto; }
.paint-row .eye.off { color: #555; }
.paint-row .eye.solo { color: #f60; }
.paint-lfoot .paint-btn.drop-hot { border-color: #f60; color: #f60; background: rgba(255,102,0,.15); }
.paint-row canvas { flex: 0 0 auto; width: 40px; height: 30px; background: #888; border: 1px solid #444; }
.paint-row canvas.sel { border-color: #fff; box-shadow: 0 0 0 1px #f60; }
.paint-row .adj { flex: 0 0 auto; width: 40px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #444; color: #ccc; background: #222; }
.paint-row .adj.sel { border-color: #fff; box-shadow: 0 0 0 1px #f60; }
.paint-row .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paint-row .nm input { width: 100%; }
.paint-row .tag { color: #888; font-size: 10px; flex: 0 0 auto; }
.paint-row .tag.so { color: #4fd6ee; border: 1px solid #2f6f7a; border-radius: 3px; padding: 0 3px; cursor: pointer; }
.paint-row .lk { color: #f60; flex: 0 0 auto; display: inline-flex; }
.paint-hist .paint-row { gap: 8px; }
.paint-hist .paint-row .hico { color: #888; flex: 0 0 auto; display: inline-flex; }
.paint-hist .paint-row.future { color: #666; }
.paint-hist .paint-row.future .hico { color: #555; }
.paint-hist .paint-row.saved .tag { color: #4fd6ee; }
.paint-fill { background: #22201c; }
.paint-fill .go { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.paint-lfoot { display: flex; gap: 2px; padding: 4px 6px; border-top: 1px solid #2b2b30; }
.paint-sect { border-bottom: 1px solid #2b2b30; padding: 6px 8px 8px; }
.paint-sect h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #f60; font-weight: 600; }
.paint-field { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.paint-field.wrap { flex-wrap: wrap; }
.paint-tips { display: flex; flex-wrap: wrap; gap: 3px; margin: 4px 0; }
.paint-tip { padding: 1px; border: 1px solid #444; background: #1b1b1b; border-radius: 3px; cursor: pointer; line-height: 0; }
.paint-tip.on { border-color: #4fd6ee; }
.paint-field > label { flex: 0 0 92px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paint-field.wide > label { flex-basis: auto; }
.paint-field > label.paint-check { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; color: #ddd; cursor: pointer; }
.paint-props { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
.paint-props textarea { width: 100%; box-sizing: border-box; min-height: 52px; resize: vertical; }
.paint-note { color: #888; font-size: 11px; margin: 4px 0; }
.paint-fx-for { padding: 6px 8px 0; }
.paint-gen { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.paint-gen .paint-btn { border-color: #3a3a40; }
.paint-curve { display: block; width: 100%; max-width: 260px; aspect-ratio: 1; background: #111; border: 1px solid #3a3a40; cursor: crosshair; }
/* dialogs over the editor */
.paint-dlg-shade { position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
.paint-dlg { background: #202024; border: 1px solid #f60; border-radius: 6px; padding: 12px 14px; min-width: 260px; max-width: 420px; color: #ddd;
  box-shadow: 0 10px 40px rgba(0,0,0,.6); }
.paint-dlg h3 { margin: 0 0 10px; font-size: 14px; color: #f60; }
.paint-dlg .paint-field > label { flex-basis: 110px; }
.paint-dlg .paint-field > select { flex: 1 1 auto; min-width: 0; max-width: 100%; }
.paint-dlg.wide { width: 560px; max-width: calc(100% - 24px); box-sizing: border-box; }
.paint-dlg.wide .paint-field { align-items: center; margin: 5px 0; }
.paint-dlg.wide .paint-field > label { flex: 0 0 170px; white-space: normal; overflow: visible; line-height: 1.25; }
.paint-dlg .paint-dlg-range { flex: 1 1 90px; min-width: 70px; background: none; border: 0; padding: 0; accent-color: #f60; }
.paint-dlg .paint-dlg-range + input[type=number] { width: 64px; flex: 0 0 auto; }
.paint-dlg .go { display: flex; justify-content: flex-end; gap: 6px; margin-top: 12px; }
.paint-dlg .note { color: #999; font-size: 11px; margin-top: 6px; white-space: pre-line; }
.paint-tipsdlg { max-width: 560px; width: min(560px, 92%); }
.paint-tipdrop { border: 1px dashed #666; border-radius: 5px; padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 6px; color: #bbb; }
.paint-tipdrop.hot { border-color: #f60; background: rgba(255,102,0,.08); }
.paint-tiplists { max-height: 46vh; overflow-y: auto; margin-top: 8px; }
.paint-tiphead { color: #f60; font-size: 12px; margin: 8px 0 4px; }
.paint-tipgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 4px; }
.paint-tipcell { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 2px; border: 1px solid #333; border-radius: 4px; background: #18181b; cursor: pointer; font-size: 10px; color: #aaa; text-align: center; }
.paint-tipcell:hover { border-color: #777; }
.paint-tipcell.on { border-color: #f60; color: #fff; }
.paint-tipcell span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paint-tipx { position: absolute; top: 1px; right: 1px; border: 0; background: none; color: #999; cursor: pointer; font-size: 12px; line-height: 1; padding: 1px 3px; }
.paint-tipx:hover { color: #f60; }
`;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rectUnion = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

class PaintEditor {
    /**
     * The document the editor is in NOW: the viewer pops out into another window and back, and with it
     * the editor. Frames, timers and new elements must come from that window - the main window's frames
     * are held back while it is behind the pop-out, so a drag showed nothing until it was let go.
     */
    get d() { return this.root.ownerDocument; }

    constructor(root, host) {
        this.root = root;
        this.host = host || {};
        this.doc = null;
        this.pix = new Map();
        this.masks = new Map();
        this.sel = null;
        this.selSegs = null;
        this.tool = "brush";
        this.opts = {
            brush: { size: 24, hardness: 80, opacity: 100, spacing: 15, penSize: true, penOpacity: false, tip: null, angle: 0, direction: false, flow: 100, scatter: 0, sizeJitter: 0, angleJitter: 0 },
            eraser: { size: 40, hardness: 80, opacity: 100, spacing: 15, penSize: true, penOpacity: false, tip: null, angle: 0, direction: false, flow: 100, scatter: 0, sizeJitter: 0, angleJitter: 0 },
            clone: { size: 40, hardness: 60, opacity: 100, spacing: 10, penSize: true, penOpacity: false, aligned: true, sample: "layer",
                     overlay: true, angle: 0, scale: 100, flip: false },
            spot: { size: 30, hardness: 50, opacity: 100, spacing: 10, penSize: true, penOpacity: false },
            heal: { size: 40, hardness: 50, opacity: 100, spacing: 10, penSize: true, penOpacity: false, aligned: true, sample: "layer",
                    overlay: true, angle: 0, scale: 100, flip: false },
            patch: { mode: "source" },
            dodge: { size: 60, hardness: 0, opacity: 50, spacing: 10, penSize: true, penOpacity: false, range: "midtones" },
            burn: { size: 60, hardness: 0, opacity: 50, spacing: 10, penSize: true, penOpacity: false, range: "midtones" },
            sponge: { size: 60, hardness: 0, opacity: 50, spacing: 10, penSize: true, penOpacity: false, sat: "desaturate" },
            smudge: { size: 30, hardness: 50, opacity: 50, spacing: 5, penSize: true, penOpacity: false, finger: false },
            blur: { size: 40, hardness: 0, opacity: 50, spacing: 15, penSize: true, penOpacity: false },
            gradient: { type: "linear", preset: "fg-bg", opacity: 100, reverse: false },
            shape: { kind: "rect", mode: "pixels", fill: true, stroke: false, width: 4, lineWidth: 4, radius: 20, sides: 6 },
            fill: { tolerance: 32, contiguous: true, all: false },
            wand: { tolerance: 32, contiguous: true, all: true },
            select: { feather: 0 },
            pen: { width: 3, feather: 0, combine: "replace" },
            warp: { n: 3 },
            liquify: { mode: "push", size: 100, strength: 50 },
            text: { font: "sans-serif", size: 64, bold: false, italic: false, align: "left" },
        };
        // Brush tips kept in this browser (imageViewer_paintAbr.js).
        this.tips = new Map();
        this._tipsLoad();
        this._brushTools = BRUSHES;
        this.fg = [255, 255, 255];
        this.bg = [0, 0, 0];
        this.view = { zoom: 1, x: 0, y: 0 };
        this.undoStack = [];
        this.redoStack = [];
        this.version = 0;
        this.savedVersion = 0;
        // Every change of a buffer counted (shared with the layer styles' cache, imageViewer_paintStyle.js).
        this.bufVer = BUF_VER;
        this.saved = new Map();
        this.editMask = false;
        this.picked = new Set();
        this.tf = null;
        this.cloneSrc = null;
        this._cloneOff = null;
        this._histDropped = 0;
        this._fillOpen = null;
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
        style.textContent = STYLE + ADJUST_CSS + GEN_CSS;
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
                                   ["Layer", () => this._layerMenu()], ["Filter", () => this._filterMenu()], ["View", () => this._viewMenu()], ["Generate", () => this._generateMenu()]]) {
            const b = this.el("button", "paint-btn paint-menu-btn", { type: "button", text: label });
            b.addEventListener("click", (e) => { e.stopPropagation(); this._menu(b, fn()); });
            bar.append(b);
        }
        bar.append(this.el("span", "paint-sep"));
        this.undoBtn = this.btn("undo", "Undo (Ctrl+Z)", () => this.undo());
        this.redoBtn = this.btn("redo", "Redo (Ctrl+Shift+Z)", () => this.redo());
        this.fitBtn = this.btn("fit", "Fit (Ctrl+0)", () => this.fit());
        bar.append(this.undoBtn, this.redoBtn, this.fitBtn);
        // The tool's options, in one row over the picture (the same as Properties' tool section).
        this.optBar = this.el("div", "paint-optbar");
        const main = this.el("div", "paint-main");
        // The tools.
        const tools = this.el("div", "paint-tools");
        this.toolBtns = {};
        for (const [id, icon, label, key] of PAINT_TOOLS) {
            if (id === "shape") continue;   // the shape tool's place is its shapes'
            const g = toolGroup(id);
            if (g) {
                // One place for the group: its first tool here, the others behind a right-click.
                if (id !== TOOL_GROUPS[g][0]) continue;
                const labels = {};
                for (const t of TOOL_GROUPS[g]) { const T = PAINT_TOOLS.find((x) => x[0] === t); labels[t] = { icon: T[1], title: `${T[2]} (${T[3]})` }; }
                const b = this._groupSlot(g, labels);
                b.title += ` - right-click: ${GROUP_HINTS[g]}`;
                for (const t of TOOL_GROUPS[g]) this.toolBtns[t] = b;
                if (g === "shape") this.toolBtns.shape = b;
                tools.append(b);
                continue;
            }
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
        this.quickBtn = this.btn("mask", "Quick Mask (Q): paint the selection - black takes away, white adds", () => this.toggleQuickMask(), "quick");
        tools.append(colors, this.btn("swap", "Swap colours (X)", () => this.swapColors()), this.quickBtn);
        // The canvas.
        this.wrap = this.el("div", "paint-wrap", { tabIndex: 0 });
        this.world = this.el("div", "paint-world");
        this.canvas = this.el("canvas", "paint-canvas");
        // Over the picture: Quick Mask's red, or a layer's mask on its own (Alt+click its thumbnail).
        this.tint = this.el("canvas", "paint-tint");
        this.world.append(this.canvas, this.tint);
        this.overlay = this.el("canvas", "paint-overlay");
        // The bar over the canvas while a mask is shown on it (setViewMask).
        this.maskBar = this.el("div", "paint-maskbar");
        for (const ev of ["pointerdown", "mousedown", "click", "dblclick", "wheel"]) this.maskBar.addEventListener(ev, (e) => e.stopPropagation());
        this.wrap.append(this.world, this.overlay, this.maskBar);
        main.append(tools, this.wrap);
        this.status = this.el("div", "paint-status");
        this.box.append(bar, this.optBar, main, this.status);
        this.root.append(this.box);
        // The panels.
        // Each part is a dock panel of its own (imageViewer_paintPanel.js PAINT_PANELS): the layers, the active layer's
        // properties, the tool's options, the layer's effects (style, smart filters), Generate and the history.
        this.parts = { layers: this._buildLayersPart(), props: this._buildPropsPart(), tool: this._buildToolPart(),
                       effects: this._buildEffectsPart(), generate: this._buildGeneratePart(), history: this._buildHistoryPart() };
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
        this._belowKept = null;
        this._solo = null;
        this.doc = D.cleanDoc(data.doc);
        this.pix = new Map(Object.entries(data.pix || {}));
        this.masks = new Map(Object.entries(data.masks || {}));
        // Smart layers' sources ({ id: { px, w, h } }); a layer whose source did not come is a plain pixel layer.
        if (fresh || !this.srcs) this.srcs = new Map();
        for (const [id, s] of Object.entries(data.srcs || {})) this.srcs.set(id, { px: s.px, w: s.w, h: s.h });
        for (const L of this.doc.layers) {
            if (L.smart && !this.srcs.has(L.smart.src)) delete L.smart;
            if (L.kind === "pixel" && !this.pix.has(L.id)) this.pix.set(L.id, new Uint8ClampedArray(L.w * L.h * 4));
            if (L.mask && !this.masks.has(L.id)) delete L.mask;
        }
        this.sel = data.selection && data.selection.length === this.doc.w * this.doc.h ? data.selection : null;
        this.editMask = false;
        this.picked = new Set(this.doc.active ? [this.doc.active] : []);
        this.quick = null;
        this.viewMask = null;
        this.crop = null;
        this.tf = null;
        this._cancelText();
        if (fresh) {
            this.undoStack = [];
            this.redoStack = [];
            this.version = 0;
            this.savedVersion = 0;
            this._histDropped = 0;
            this.cloneSrc = null;
            this._cloneOff = null;
            this._markSavedRefs();
        }
        this._resizeCanvas();
        this._selChanged();
        if (!keepView) this.fit();
        this.redraw();
        this.refreshPanels();
        this._showEmpty();
        this.setTool(this.tool);
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
    /** A layer's mask as it acts (feathered, cached by the buffer's version); while a stroke paints it, as it is. */
    _maskOf = (L) => {
        if (!L.mask) return null;
        const raw = this.masks.get(L.id) || null;
        if (!raw || !(L.mask.feather > 0)) return raw;
        const dr = this._drag;
        if (dr && dr.kind === "stroke" && dr.st.mask === raw) return raw;
        const sig = `${this.bufVer.get(raw) || 0}:${L.mask.feather}:${L.mask.w}x${L.mask.h}`;
        const c = this._featherCache || (this._featherCache = new WeakMap());
        const hit = c.get(raw);
        if (hit && hit.sig === sig) return hit.out;
        const out = D.maskAsItActs(L, raw);
        c.set(raw, { sig, out });
        return out;
    };
    active() { return this.doc ? this.doc.layers.find((L) => L.id === this.doc.active) || null : null; }

    // ── drawing ──────────────────────────────────────────────────────────────

    /** Draw again: all of it, or the rectangle {x0, y0, x1, y1} of the canvas. */
    redraw(rect = null) {
        if (!this.doc) return;
        const W = this.doc.w, H = this.doc.h;
        const r = rect ? { x0: clamp(Math.floor(rect.x0), 0, W), y0: clamp(Math.floor(rect.y0), 0, H),
                           x1: clamp(Math.ceil(rect.x1), 0, W), y1: clamp(Math.ceil(rect.y1), 0, H) } : { x0: 0, y0: 0, x1: W, y1: H };
        if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
        if (!rect) {
            this._previewHide();
            // A whole redraw asked for at the next frame is this one.
            if (this._raf && this._pending === null) { this.d.defaultView.cancelAnimationFrame(this._raf); this._raf = 0; this._pending = undefined; }
        }
        if (this.below && this._belowIdx != null) {
            // While a stroke runs: what is under the layer is kept; lay it and the layers above.
            for (let y = r.y0; y < r.y1; y++) this.comp.set(this.below.subarray((y * W + r.x0) * 4, (y * W + r.x1) * 4), (y * W + r.x0) * 4);
            D.composite(this.doc, this._pixOf, this._maskOf, r, this.comp, { keep: true, from: this._belowIdx });
        } else {
            D.composite(this.doc, this._pixOf, this._maskOf, r, this.comp);
        }
        this.ctx.putImageData(this.imgData, 0, 0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        this._tintDraw(r);
    }

    // ── Quick Mask and a mask on its own ─────────────────────────────────────

    /**
     * Q: the selection as a picture to paint on (`quick.m`, W x H, 255 = selected), shown as red where it is
     * not selected. The brush, eraser, bucket and Fill paint it (black takes away, white adds); Q again
     * makes it the selection (one undo step). Entered with no selection, everything is selected.
     */
    toggleQuickMask() {
        if (!this.doc) return;
        const W = this.doc.w, H = this.doc.h;
        if (!this.quick) {
            this._tfSettle();
            this.setViewMask(null);
            this.quick = { m: this.sel ? new Uint8Array(this.sel) : new Uint8Array(W * H).fill(255) };
        } else {
            const m = this.quick.m;
            this.quick = null;
            this.setSelection(m.some((v) => v) ? new Uint8Array(m) : null, "Quick Mask");
        }
        if (this.quickBtn) this.quickBtn.classList.toggle("on", !!this.quick);
        this._tintDraw();
        this.refreshProps();
        this._status();
    }

    /**
     * A layer's mask shown on the canvas (null: the picture again), to look at and paint on: the mask is made the
     * active part, so the brush, eraser, bucket, gradient, Fill and Del paint it and the canvas shows it as it
     * changes. `mode`: "alone" (the mask in grey, white shows) or "overlay" (the picture with red where the mask
     * hides); kept for the next time. Picking anything but this mask (a layer's pixels, another layer) ends it.
     */
    setViewMask(id, mode = null) {
        if (mode) this.viewMaskMode = mode;
        const L = id && this.doc ? this.doc.layers.find((x) => x.id === id) : null;
        if (L && L.mask) {
            if (this.quick) this.toggleQuickMask();
            this.viewMask = L.id;
            if (this.doc.active !== L.id || !this.editMask || this.picked.size !== 1) this.setActive(L.id, true);
        } else this.viewMask = null;
        this._tintDraw();
        this._maskBarDraw();
        this._status();
        if (this.propsBox) this.refreshProps();
    }

    /** \ : the active layer's mask on the canvas, or the picture again; Shift+\ : over the picture / alone. */
    toggleViewMask(switchMode = false) {
        if (!this.doc) return;
        if (this.viewMask && switchMode) return this.setViewMask(this.viewMask, this.viewMaskMode === "overlay" ? "alone" : "overlay");
        if (this.viewMask) return this.setViewMask(null);
        const L = this.active();
        if (!L || !L.mask) { this._notify(L ? `${L.name} has no mask. Add one in Layers (or drag a layer onto it).` : "No layer.", "info"); return; }
        this.setViewMask(L.id, switchMode ? "overlay" : null);
    }

    /** The mask on the canvas follows what is picked: another layer's mask picked shows that one, pixels end it. */
    _viewMaskFollow() {
        if (!this.viewMask || !this.doc) return;
        const A = this.active();
        const v = this.editMask && A && A.mask ? A.id : null;
        if (v === this.viewMask) return;
        this.viewMask = v;
        this._tintDraw();
        this._maskBarDraw();
    }

    _maskBarDraw() {
        const b = this.maskBar;
        if (!b) return;
        const L = this.viewMask && this.doc ? this.doc.layers.find((x) => x.id === this.viewMask) : null;
        b.classList.toggle("on", !!L);
        if (!L) { b.replaceChildren(); return; }
        const over = this.viewMaskMode === "overlay";
        const mode = this.el("button", "paint-btn", { type: "button", text: over ? "Mask alone" : "Over the picture",
            title: over ? "Show the mask on its own, in grey (Shift+\\)" : "Show the picture with red where the mask hides (Shift+\\)" });
        mode.addEventListener("click", () => this.setViewMask(L.id, over ? "alone" : "overlay"));
        const done = this.el("button", "paint-btn", { type: "button", text: "Show the picture", title: "Back to the picture (\\ or Esc); the mask stays as painted" });
        done.addEventListener("click", () => this.setViewMask(null));
        b.replaceChildren(this.el("b", "", { text: `Mask of ${L.name}` }),
                          this.el("span", "note", { text: L.mask.enabled ? "painting it - white shows, black hides" : "painting it - switched off" }), mode, done);
    }

    _tintDraw(r = null) {
        const t = this.tint;
        if (!t || !this.doc) return;
        const W = this.doc.w, H = this.doc.h;
        const L = this.viewMask ? this.doc.layers.find((x) => x.id === this.viewMask) : null;
        const on = !!(this.quick || (L && L.mask));
        t.style.display = on ? "block" : "none";
        if (!on) return;
        if (t.width !== W || t.height !== H) { t.width = W; t.height = H; r = null; this._tintImg = null; }
        if (!this._tintImg || this._tintImg.width !== W || this._tintImg.height !== H) this._tintImg = new ImageData(W, H);
        const im = this._tintImg.data;
        const x0 = r ? r.x0 : 0, y0 = r ? r.y0 : 0, x1 = r ? r.x1 : W, y1 = r ? r.y1 : H;
        if (this.quick) {
            const m = this.quick.m;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const i = y * W + x, o = i * 4;
                im[o] = 255; im[o + 1] = 0; im[o + 2] = 0; im[o + 3] = Math.round((255 - m[i]) * 0.5);
            }
        } else {
            const mk = L.mask, m = this._maskOf(L), dn = mk.density == null ? 1 : mk.density, over = this.viewMaskMode === "overlay";
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const mx = x - mk.x, my = y - mk.y;
                const v0 = mx >= 0 && my >= 0 && mx < mk.w && my < mk.h ? m[my * mk.w + mx] : mk.fill;
                const v = Math.round(255 - dn * (255 - v0)), o = (y * W + x) * 4;
                if (over) { im[o] = 255; im[o + 1] = 0; im[o + 2] = 0; im[o + 3] = Math.round((255 - v) * 0.5); }
                else { im[o] = im[o + 1] = im[o + 2] = v; im[o + 3] = 255; }
            }
        }
        t.getContext("2d").putImageData(this._tintImg, 0, 0, x0, y0, x1 - x0, y1 - y0);
    }

    /** A thumbnail's pixels (or a mask) as the selection: `how` replace / add / subtract. */
    loadSelection(L, fromMask, how = "replace") {
        const W = this.doc.w, H = this.doc.h, m = new Uint8Array(W * H);
        if (fromMask && L.mask) {
            const mk = L.mask, raw = this._maskOf(L), dn = mk.density == null ? 1 : mk.density;
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const mx = x - mk.x, my = y - mk.y;
                const v0 = mx >= 0 && my >= 0 && mx < mk.w && my < mk.h ? raw[my * mk.w + mx] : mk.fill;
                m[y * W + x] = Math.round(255 - dn * (255 - v0));
            }
        } else if (L.kind === "pixel") {
            const px = this.pix.get(L.id);
            for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
                const gx = x + L.x, gy = y + L.y;
                if (gx >= 0 && gy >= 0 && gx < W && gy < H) m[gy * W + gx] = px[(y * L.w + x) * 4 + 3];
            }
        } else return;
        const out = how === "replace" || !this.sel ? (how === "subtract" ? null : m) : D.combineMasks(this.sel, m, how === "add" ? "add" : "subtract");
        this.setSelection(out, fromMask ? "Select the mask" : "Select layer");
    }

    /**
     * Draw again at the next frame (sliders, drags). A whole redraw during a live edit or a drag on a big
     * picture is laid as the quick preview instead (`force`: always in full).
     */
    requestRedraw(rect = null, force = false) {
        if (rect === null && !force && this._previewWanted()) { this.requestPreview(); return; }
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
        // Inside a group what is under the layer is not one picture: no cache, the rectangle is laid whole.
        // A clipped layer is laid with its base: no cache either.
        if (L.parent || L.clip) { this._dropBelow(); return; }
        const i = D.layerIndex(this.doc, L.id);
        // The last stroke's picture of what was under its layer, when nothing under this one has changed
        // since (the layers' settings, their buffers and the buffers' versions): on a big picture laying it
        // again took most of a second at every press.
        const sig = this._belowSig(i), kept = this._belowKept;
        this.below = kept && kept.sig === sig ? kept.below : D.composite(this.doc, this._pixOf, this._maskOf, null, null, { to: i });
        this._belowIdx = i;
        this._belowKept = { sig, below: this.below };
    }

    /** What the picture under flat index i is made of, as a string (buffers by identity and version). */
    _belowSig(i) {
        const ids = this._bufIds || (this._bufIds = new WeakMap());
        const idOf = (b) => {
            if (!b) return "-";
            let v = ids.get(b);
            if (!v) { v = this._bufN = (this._bufN || 0) + 1; ids.set(b, v); }
            return `${v}.${this.bufVer.get(b) || 0}`;
        };
        const parts = [this.doc.w, this.doc.h, i];
        for (let j = 0; j < i; j++) {
            const L = this.doc.layers[j];
            parts.push(JSON.stringify(L), idOf(this.pix.get(L.id)), idOf(this.masks.get(L.id)));
        }
        return parts.join("|");
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
        // The pen's path; the patch being dragged.
        this._penDraw(c, X, Y);
        this._pathBoxDraw(c, X, Y);
        this._pickBoxDraw(c, X, Y);
        this._drawDraw(c, X, Y);
        this._patchDraw(c, X, Y);
        // The crop.
        if (this.crop) {
            const { x, y, w, h } = this.crop;
            c.fillStyle = "rgba(0,0,0,.55)";
            const ow = this.overlay.width / dpr, oh = this.overlay.height / dpr;
            c.beginPath(); c.rect(0, 0, ow, oh); c.rect(X(x), Y(y), w * v.zoom, h * v.zoom); c.fill("evenodd");
            c.strokeStyle = "#f60"; c.lineWidth = 1.5; c.strokeRect(X(x), Y(y), w * v.zoom, h * v.zoom);
            c.fillStyle = "#f60"; c.font = "11px system-ui"; c.fillText(`${Math.round(w)} x ${Math.round(h)}  (Enter applies, Esc cancels)`, X(x) + 4, Y(y) - 6);
        }
        // The layer's box and handles (Transform).
        this._wpDraw(c, X, Y);
        const g = (this.tool === "move" || this.tool === "tfsel") && !this.wp ? this._tfGeom() : null;
        if (g) {
            const m = D.tfMatrix(g.p), cs = D.tfCorners(m, g.w, g.h);
            c.strokeStyle = this.tf ? "#4fd6ee" : "rgba(0,200,255,.8)"; c.lineWidth = 1; c.setLineDash(this.tf ? [] : [3, 3]);
            c.beginPath();
            cs.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))));
            c.closePath(); c.stroke(); c.setLineDash([]);
            c.fillStyle = "#fff"; c.strokeStyle = "#000";
            for (const [u, w] of this._tfHandles(g.w, g.h)) {
                const [x, y] = D.applyM(m, u, w);
                c.fillRect(Math.round(X(x)) - 3.5, Math.round(Y(y)) - 3.5, 7, 7); c.strokeRect(Math.round(X(x)) - 3.5, Math.round(Y(y)) - 3.5, 7, 7);
            }
            c.beginPath(); c.arc(X(g.p.tx), Y(g.p.ty), 3, 0, Math.PI * 2); c.stroke();
        }
        // The clone stamp's source.
        if (SOURCED.includes(this.tool) && this.cloneSrc) {
            const h = this._hover;
            const s = h ? this._cloneFrom(h.x, h.y) : this.cloneSrc;
            if (s && h && this.opts[this.tool].overlay && !(this._drag && this._drag.kind === "stroke")) this._cloneOverlay(c, h, s, dpr);
            if (s) {
                const sx = X(s.x), sy = Y(s.y), r = Math.max(4, (this.opts[this.tool].size / 2) * v.zoom);
                for (const [col, wd] of [["rgba(0,0,0,.7)", 3], ["#fff", 1]]) {
                    c.strokeStyle = col; c.lineWidth = wd;
                    c.beginPath(); c.moveTo(sx - 8, sy); c.lineTo(sx + 8, sy); c.moveTo(sx, sy - 8); c.lineTo(sx, sy + 8); c.stroke();
                }
                c.strokeStyle = "rgba(255,255,255,.5)"; c.lineWidth = 1; c.setLineDash([3, 3]);
                c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
            }
        }
        // The brush: while its size / opacity is dragged (B held, or Alt+right-drag), at where that began.
        if (this._bd) this._bdDraw(c);
        else if ((BRUSHES.includes(this.tool) || this.tool === "liquify") && this._hover) {
            const o = this.opts[this.tool];
            c.strokeStyle = "rgba(255,255,255,.9)"; c.lineWidth = 1;
            c.beginPath(); c.arc(this._hover.sx, this._hover.sy, Math.max(1, (o.size / 2) * v.zoom), 0, Math.PI * 2); c.stroke();
            c.strokeStyle = "rgba(0,0,0,.6)";
            c.beginPath(); c.arc(this._hover.sx, this._hover.sy, Math.max(1, (o.size / 2) * v.zoom) + 1, 0, Math.PI * 2); c.stroke();
            // A small cross in the middle: the pointer stays visible however small the brush is on screen.
            const hx = Math.round(this._hover.sx) + 0.5, hy = Math.round(this._hover.sy) + 0.5;
            for (const [col, wd] of [["rgba(0,0,0,.6)", 3], ["#fff", 1]]) {
                c.strokeStyle = col; c.lineWidth = wd;
                c.beginPath(); c.moveTo(hx - 4, hy); c.lineTo(hx + 4, hy); c.moveTo(hx, hy - 4); c.lineTo(hx, hy + 4); c.stroke();
            }
        }
        // Guides and the rulers, over everything.
        this._guidesDraw(c, X, Y);
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
            if (this.quick) parts.push("<b>Quick Mask</b> (Q: back to the selection)");
            if (this.viewMask) parts.push("<b>showing the mask</b> (\\ or Esc: the picture)");
            if (SOURCED.includes(this.tool)) parts.push(this.cloneSrc ? `clone from ${Math.round(this.cloneSrc.x)}, ${Math.round(this.cloneSrc.y)}` : "<b>Alt+click: where to take from</b>");
            if (this.tf) parts.push("<b>transforming</b> (Enter applies, Esc cancels)");
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
        this._tfSettle();
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
            this._histDropped++;
            this.savedVersion = -1;              // the saved state can no longer be reached by undoing
        }
        this.version++;
        this._emit();
    }

    undo() {
        this._solo = null;
        if (this.tf) { this.tfCancel(); return; }
        if (this.wp) { this.wpCancel(); return; }
        if (this.lq) { this.lqCancel(); return; }
        const e = this.undoStack.pop();
        if (!e) return;
        e.undo();
        this.redoStack.push(e);
        this.version--;
        this._afterHistory();
    }

    redo() {
        this._solo = null;
        if (this.tf || this.wp || this.lq) return;
        const e = this.redoStack.pop();
        if (!e) return;
        e.redo();
        this.undoStack.push(e);
        this.version++;
        this._afterHistory();
    }

    /**
     * The History panel's click: the document as it was after step `i` (0: as it was opened), undoing or
     * redoing as many steps as that takes, drawn once.
     */
    goTo(i) {
        if (this.tf) this.tfCancel();
        i = clamp(i, 0, this.undoStack.length + this.redoStack.length);
        if (i === this.undoStack.length) return;
        while (this.undoStack.length > i) { const e = this.undoStack.pop(); e.undo(); this.redoStack.push(e); this.version--; }
        while (this.undoStack.length < i && this.redoStack.length) { const e = this.redoStack.pop(); e.redo(); this.undoStack.push(e); this.version++; }
        this._afterHistory();
    }

    _afterHistory() {
        this._prunePicked();
        if (this.pathId && !this.curPath()) this._penReset();
        else if (this.pathPt != null && !(this.curPath() && this.curPath().pts[this.pathPt])) this.pathPt = null;
        if (this.viewMask && !(this.doc.layers.find((L) => L.id === this.viewMask) || {}).mask) this.viewMask = null;
        this._viewMaskFollow();
        this._maskBarDraw();
        if (this.quick && this.quick.m.length !== this.doc.w * this.doc.h) this.quick = null;
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
        this.refreshHistory();
    }

    isDirty() { return !!this.doc && this.version !== this.savedVersion; }

    /** The document as it stands, to compare against later (structure changes). */
    _snap() {
        return { doc: JSON.parse(JSON.stringify(this.doc)), pix: new Map(this.pix), masks: new Map(this.masks), sel: this.sel };
    }

    _restore(s) {
        this._belowKept = null;
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
        this._tfSettle();
        const before = this._snap();
        let ok;
        this._smartDrawn = new Set();
        try { ok = fn(); this._smartUncut(); } catch (e) { this._restore(before); this._notify(String(e.message || e), "error"); return false; }
        if (ok === false) { this._restore(before); return false; }
        this._smartKeepOrForget(before);
        D.fixTree(this.doc.layers);
        this._prunePicked();
        const after = this._snap();
        this._push({ label, undo: () => this._restore(before), redo: () => this._restore(after), bytes: this._snapBytes(before, after) });
        this._afterHistory();
        return true;
    }

    /** A live change while a slider moves (no undo entry yet): `begin` once, `live` as it moves, `end` to keep it. */
    liveBegin() { if (!this._liveSnap) { this._tfSettle(); this._liveSnap = this._snap(); } }
    liveEnd(label) {
        const before = this._liveSnap;
        this._liveSnap = null;
        this._previewSettle();
        if (!before) return;
        this._smartDrawn = new Set();
        this._smartUncut();
        this._smartKeepOrForget(before);
        const after = this._snap();
        if (JSON.stringify(before.doc) === JSON.stringify(after.doc)) return;
        this._push({ label, undo: () => this._restore(before), redo: () => this._restore(after) });
        this._afterHistory();
    }

    _markSavedRefs() {
        this.saved = new Map();
        for (const [id, b] of this.pix) this.saved.set("p:" + id, [b, this.bufVer.get(b) || 0]);
        for (const [id, b] of this.masks) this.saved.set("m:" + id, [b, this.bufVer.get(b) || 0]);
        for (const id of Object.keys(this.doc ? this.usedSources() : {})) this.saved.set("s:" + id, true);
    }

    _bump(buf) { this.bufVer.set(buf, (this.bufVer.get(buf) || 0) + 1); }

    // ── layers ───────────────────────────────────────────────────────────────

    /**
     * Make a layer the active one. `how`: "toggle" (Ctrl+click: in or out of the picked layers), "range"
     * (Shift+click: every row from the last one clicked to this one, as the panel lists them), else this
     * one alone. The active layer is the one tools paint on; the picked ones are what Layers' commands
     * (delete, duplicate, group, merge, move, opacity, blend, lock, hide) take together.
     * While a mask is picked, Ctrl / Shift+click picks more MASKS: the picked layers that have one
     * (`pickedMasks`), which Delete and the trash take away.
     */
    setActive(id, mask = false, how = null) {
        if (!this.doc) return;
        const L = this.doc.layers.find((x) => x.id === id);
        if (!L) return;
        const keepMask = !!how && this.editMask && !!(this.active() || {}).mask;
        const em = !!(mask && L.mask) || (L.kind === "adjust" && mask);
        if (how === "toggle") {
            this.picked.add(this.doc.active);
            if (this.picked.has(id) && this.picked.size > 1) {
                // Out of the picked ones; the active layer stays, unless it is this one.
                this.picked.delete(id);
                id = this.doc.active === id ? [...this.picked].pop() : this.doc.active;
            } else this.picked.add(id);
            this._pickAnchor = id;
        } else if (how === "range") {
            const rows = this._panelRows().map((r) => r.L.id);
            const a = rows.indexOf(this._pickAnchor || this.doc.active), b = rows.indexOf(id);
            if (a >= 0 && b >= 0) this.picked = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
            else this.picked = new Set([id]);
        } else {
            if (this.doc.active === id && this.editMask === em && this.picked.size === 1 && this.picked.has(id)) return;
            this.picked = new Set([id]);
            this._pickAnchor = id;
        }
        if (keepMask) {
            // Picking masks: only layers that have one count.
            const withMask = new Set(this.doc.layers.filter((X) => X.mask).map((X) => X.id));
            this.picked = new Set([...this.picked].filter((x) => withMask.has(x)));
            if (!withMask.has(id)) id = this.doc.active;
            this.picked.add(id);
        }
        if (this.tf && this.tf.L.id !== id) this.tfCommit();
        this.doc.active = id;
        this.editMask = how ? keepMask : em;
        this._viewMaskFollow();
        this.refreshPanels();
        this.drawOverlay();
        this._status();
    }

    /** The masks picked (a mask picked, then Ctrl / Shift+click on rows): their layers, bottom first. */
    pickedMasks() {
        if (!this.doc || !this.editMask) return [];
        const L = this.active();
        if (!L || !L.mask) return [];
        return this.pickedLayers().filter((X) => X.mask);
    }

    /** Take the masks of these layers away: one undo step. */
    deleteMasks(ids) {
        if (!this.doc) return false;
        const Ls = this.doc.layers.filter((X) => ids.includes(X.id) && X.mask);
        if (!Ls.length) return false;
        return this.change(Ls.length > 1 ? `Delete ${Ls.length} masks` : "Delete mask", () => {
            for (const X of Ls) { delete X.mask; this.masks.delete(X.id); }
            if (this.viewMask && Ls.some((X) => X.id === this.viewMask)) this.viewMask = null;
            this.editMask = false;
        });
    }

    /**
     * A pixel layer made the mask of another layer (dragged onto its row's middle in Layers): the mask is the
     * layer's brightness where it is opaque, black where it is transparent (its own mask, when on, counted in);
     * the layer's opacity and blend are not. A mask the target had is replaced. The layer goes, unless `keep`
     * (Alt held when dropped). One undo step; the new mask is what the tools paint after it.
     */
    layerToMask(srcId, targetId, { keep = false } = {}) {
        const d = this.doc;
        if (!d) return false;
        const S = d.layers.find((x) => x.id === srcId), T = d.layers.find((x) => x.id === targetId);
        if (!S || !T || S === T) return false;
        const px = this.pix.get(S.id);
        if (S.kind !== "pixel" || !px) { this._notify("Only a pixel layer becomes a mask.", "warn"); return false; }
        if (T.locked) { this._notify(`${T.name} is locked.`, "warn"); return false; }
        if (!keep && S.locked) { this._notify(`${S.name} is locked (Alt+drop keeps it and still makes the mask).`, "warn"); return false; }
        return this.change(T.mask ? "Layer to mask (replaced)" : "Layer to mask", () => {
            const W = d.w, H = d.h, m = new Uint8Array(W * H);
            const sk = S.mask && S.mask.enabled !== false ? S.mask : null, sm = sk ? this._maskOf(S) : null;
            const sdn = sk ? (sk.density == null ? 1 : sk.density) : 0;
            for (let y = 0; y < S.h; y++) {
                const dy = S.y + y;
                if (dy < 0 || dy >= H) continue;
                for (let x = 0; x < S.w; x++) {
                    const dx = S.x + x;
                    if (dx < 0 || dx >= W) continue;
                    const o = (y * S.w + x) * 4;
                    let a = px[o + 3] / 255;
                    if (sk) {
                        const mx = dx - sk.x, my = dy - sk.y;
                        const v = mx >= 0 && my >= 0 && mx < sk.w && my < sk.h ? sm[my * sk.w + mx] : sk.fill;
                        a *= 1 - sdn * (1 - v / 255);
                    }
                    m[dy * W + dx] = D.q8((0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) / 255 * a);
                }
            }
            T.mask = { enabled: true, x: 0, y: 0, w: W, h: H, fill: 0 };
            this.masks.set(T.id, m);
            if (!keep) {
                d.layers = d.layers.filter((x) => x.id !== S.id);
                this.pix.delete(S.id);
                this.masks.delete(S.id);
                if (this.viewMask === S.id) this.viewMask = null;
            }
            d.active = T.id;
            this.picked = new Set([T.id]);
            this.editMask = true;
        });
    }

    /** Every layer picked in the Layers panel (the active one with them), bottom first. */
    pickedLayers() {
        if (!this.doc) return [];
        const out = this.doc.layers.filter((L) => this.picked.has(L.id) || L.id === this.doc.active);
        return out;
    }

    /** Ctrl+Alt+A: every layer picked. */
    pickAll() {
        if (!this.doc) return;
        this.picked = new Set(this.doc.layers.map((L) => L.id));
        this.refreshLayers();
    }

    _prunePicked() {
        if (!this.doc) { this.picked = new Set(); return; }
        const ids = new Set(this.doc.layers.map((L) => L.id));
        this.picked = new Set([...this.picked].filter((x) => ids.has(x)));
        if (this.doc.active && !ids.has(this.doc.active)) this.doc.active = this.doc.layers.length ? this.doc.layers[this.doc.layers.length - 1].id : null;
        // An active layer not among the picked was made active by itself (a new layer, a paste): it alone is picked.
        if (this.doc.active && !this.picked.has(this.doc.active)) this.picked = new Set([this.doc.active]);
    }

    /** Where a new layer goes: inside the active group (its top) when that is open, else just above the
     * active layer, in its group. Inside `change`; returns the index and sets L.parent. */
    _placeNew(L) {
        const A = this.active();
        if (!A) return this.doc.layers.length;
        if (A.kind === "group" && !A.collapsed) {
            L.parent = A.id;
            return D.layerIndex(this.doc, A.id);
        }
        if (A.parent) L.parent = A.parent; else delete L.parent;
        return D.layerIndex(this.doc, A.id) + 1;
    }

    newLayer(name = null, index = null) {
        return this.change("New layer", () => {
            const L = D.cleanLayer({ id: D.newId(), name: name || D.freshName(this.doc), kind: "pixel", x: 0, y: 0, w: this.doc.w, h: this.doc.h });
            this.pix.set(L.id, new Uint8ClampedArray(L.w * L.h * 4));
            const i = index == null ? this._placeNew(L) : index;
            this.doc.layers.splice(clamp(i, 0, this.doc.layers.length), 0, L);
            this.doc.active = L.id;
            this.editMask = false;
        });
    }

    /** An empty group where a new layer would go. */
    newGroup() {
        return this.change("New group", () => {
            const G = D.cleanLayer({ id: D.newId(), name: this._groupName(), kind: "group", blend: "pass_through" });
            const i = this._placeNew(G);
            this.doc.layers.splice(clamp(i, 0, this.doc.layers.length), 0, G);
            this.doc.active = G.id;
            this.editMask = false;
        });
    }

    _groupName() {
        const taken = new Set(this.doc.layers.map((L) => L.name));
        let n = this.doc.layers.filter((L) => L.kind === "group").length + 1;
        while (taken.has(`Group ${n}`)) n++;
        return `Group ${n}`;
    }

    /** A layer of these pixels (w x h at x, y), above the active one. */
    addPixelLayer(px, w, h, name, x = 0, y = 0, extra = {}) {
        return this.change("Add layer", () => {
            const L = D.cleanLayer({ id: D.newId(), name, kind: "pixel", x, y, w, h, ...extra });
            this.pix.set(L.id, px);
            const i = this.doc.layers.length ? this._placeNew(L) : 0;
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
            this.doc.layers.splice(this._placeNew(L), 0, L);
            this.doc.active = L.id;
            this.editMask = false;
        });
    }

    /** The picked layers out (a group with what is inside it). */
    deleteLayer(id = null) {
        if (!this.doc) return false;
        const ids = id ? [id] : D.outermost(this.doc, this.pickedLayers().map((L) => L.id));
        const gone = D.withInside(this.doc, ids);
        if (!gone.length) return false;
        if (gone.length >= this.doc.layers.length) { this._notify("The last layer stays.", "warn"); return false; }
        const locked = gone.find((L) => L.locked);
        if (locked) { this._notify(`${locked.name} is locked.`, "warn"); return false; }
        const label = gone.length > 1 ? (ids.length > 1 ? `Delete ${ids.length} layers` : "Delete group") : "Delete layer";
        return this.change(label, () => {
            const lowest = D.layerIndex(this.doc, gone[0].id);
            const g = new Set(gone.map((L) => L.id));
            this.doc.layers = this.doc.layers.filter((L) => !g.has(L.id));
            for (const x of g) { this.pix.delete(x); this.masks.delete(x); }
            this.doc.active = (this.doc.layers[Math.max(0, lowest - 1)] || this.doc.layers[0]).id;
            this.picked = new Set([this.doc.active]);
            this.editMask = false;
        });
    }

    /** Layers dragged onto Duplicate ("dup") or Delete ("del") in the Layers panel. */
    dropOnButton(ids, act) {
        const there = ids.filter((id) => this.doc && this.doc.layers.some((L) => L.id === id));
        if (!there.length) return false;
        this.picked = new Set(there);
        this.doc.active = there[there.length - 1];
        this.editMask = false;
        return act === "del" ? this.deleteLayer() : this.duplicateLayer({ whole: true });
    }

    /**
     * Solo (Alt+click an eye, or the Layers menu): only these layers seen - with the groups they are in and what is
     * inside them. Again on the same layers: every layer as it was before. Another layer while soloed: that one,
     * still going back to how it was before the first.
     */
    soloLayers(ids) {
        const d = this.doc;
        if (!d || !ids || !ids.length) return false;
        const key = [...ids].sort().join(",");
        if (this._solo && this._solo.key === key) return this.endSolo();
        const was = this._solo ? this._solo.was : new Map(d.layers.map((L) => [L.id, !!L.visible]));
        const keep = new Set();
        for (const L of D.withInside(d, ids)) keep.add(L.id);
        for (const id of ids) { const L = d.layers.find((x) => x.id === id); if (L) for (const P of D.ancestors(d, L)) keep.add(P.id); }
        const ok = this.change("Solo layer", () => { for (const L of d.layers) L.visible = keep.has(L.id); });
        if (ok !== false) this._solo = { key, ids: [...ids], was };
        this.refreshLayers();
        return ok;
    }

    /** Back from solo: every layer seen or hidden as it was before. */
    endSolo() {
        const s = this._solo;
        this._solo = null;
        if (!s || !this.doc) { this.refreshLayers(); return false; }
        const ok = this.change("End solo", () => { for (const L of this.doc.layers) if (s.was.has(L.id)) L.visible = s.was.get(L.id); });
        this.refreshLayers();
        return ok;
    }

    /** The layers soloed now (none when they were changed by hand since). */
    soloed() {
        const s = this._solo;
        if (!s || !this.doc) return [];
        return s.ids.filter((id) => this.doc.layers.some((L) => L.id === id));
    }

    duplicateLayer({ whole = false } = {}) {
        const L = this.active();
        if (!L) return false;
        const many = this.pickedLayers().length > 1;
        if (many || L.kind === "group") {
            return this.change(many ? "Duplicate layers" : "Duplicate group", () => {
                const tops = D.outermost(this.doc, this.pickedLayers().map((x) => x.id));
                const made = [];
                for (const id of tops) {
                    const T = this.doc.layers.find((x) => x.id === id);
                    const block = D.withInside(this.doc, [id]);
                    const map = new Map(block.map((x) => [x.id, D.newId()]));
                    const copies = block.map((x) => {
                        const C = JSON.parse(JSON.stringify(x));
                        C.id = map.get(x.id);
                        if (map.has(x.parent)) C.parent = map.get(x.parent);
                        C.locked = false;
                        if (this.pix.has(x.id)) this.pix.set(C.id, new Uint8ClampedArray(this.pix.get(x.id)));
                        if (this.masks.has(x.id)) this.masks.set(C.id, new Uint8Array(this.masks.get(x.id)));
                        return C;
                    });
                    copies[copies.length - 1].name = `${T.name} copy`;
                    this.doc.layers.splice(D.layerIndex(this.doc, id) + 1, 0, ...copies);
                    made.push(copies[copies.length - 1].id);
                }
                if (this.doc.layers.length > D.MAX_LAYERS) throw new Error(`at most ${D.MAX_LAYERS} layers`);
                this.doc.active = made[made.length - 1];
                this.picked = new Set(made);
            });
        }
        const viaSel = !!this.sel && L.kind === "pixel" && !whole;
        return this.change(viaSel ? "Layer via copy" : "Duplicate layer", () => {
            const C = JSON.parse(JSON.stringify(L));
            C.id = D.newId();
            C.locked = false;
            if (L.kind === "pixel") {
                let px = new Uint8ClampedArray(this.pix.get(L.id));
                if (viaSel) {
                    // Ctrl+J with a selection: only what is selected.
                    const m = D.maskForLayer(this.sel, this.doc.w, this.doc.h, L);
                    for (let i = 0; i < m.length; i++) px[i * 4 + 3] = D.q8((px[i * 4 + 3] / 255) * (m[i] / 255));
                    C.name = `${L.name} (selection)`;
                    delete C.text;
                    delete C.smart;
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

    /**
     * Layers (a group with what is in it) moved next to `targetId`: "above" / "below" it, in its group, or
     * "inside" it (a group: at its top). What the Layers panel's drag and drop does.
     */
    moveLayers(ids, targetId, where) {
        const d = this.doc;
        const T = d.layers.find((x) => x.id === targetId);
        if (!T) return false;
        const tops = D.outermost(d, ids);
        if (tops.includes(targetId) || tops.some((g) => D.isInside(d, T, g))) return false;
        if (where === "inside" && T.kind !== "group") where = "above";
        const n = tops.length;
        return this.change(n > 1 ? `Move ${n} layers` : (where === "inside" ? "Move into group" : "Move layer"), () => {
            const block = D.withInside(d, tops);
            const b = new Set(block.map((x) => x.id));
            const rest = d.layers.filter((x) => !b.has(x.id));
            const par = where === "inside" ? T.id : T.parent;
            if (par && D.ancestors(d, T).length + (where === "inside" ? 1 : 0) + this._depthOf(block, tops) > D.MAX_DEPTH) throw new Error(`Groups go at most ${D.MAX_DEPTH} deep.`);
            for (const id of tops) { const L = d.layers.find((x) => x.id === id); if (par) L.parent = par; else delete L.parent; }
            let j;
            if (where === "inside") j = rest.indexOf(T);
            else if (where === "above") j = rest.indexOf(T) + 1;
            else j = rest.indexOf(d.layers[D.subtreeRange(d, T.id)[0]]);
            d.layers = [...rest.slice(0, j), ...block, ...rest.slice(j)];
        });
    }

    _depthOf(block, tops) {
        // How deep the deepest layer of `block` is below its top.
        let best = 0;
        const byId = new Map(block.map((x) => [x.id, x]));
        for (const L of block) {
            let n = 0, p = L;
            while (p && !tops.includes(p.id) && n <= D.MAX_DEPTH) { p = byId.get(p.parent); n++; }
            best = Math.max(best, n);
        }
        return best;
    }

    /** Ctrl+G: the picked layers into a new group, where the top one of them was. */
    groupLayers() {
        const d = this.doc;
        if (!d || !d.layers.length) return false;
        const tops = D.outermost(d, this.pickedLayers().map((L) => L.id));
        if (!tops.length) return false;
        const topL = d.layers.find((x) => x.id === tops[tops.length - 1]);
        if (D.ancestors(d, topL).length >= D.MAX_DEPTH) { this._notify(`Groups go at most ${D.MAX_DEPTH} deep.`, "warn"); return false; }
        return this.change("Group layers", () => {
            const G = D.cleanLayer({ id: D.newId(), name: this._groupName(), kind: "group", blend: "pass_through" });
            if (topL.parent) G.parent = topL.parent;
            const block = D.withInside(d, tops);
            const b = new Set(block.map((x) => x.id));
            const lowestTop = d.layers[D.subtreeRange(d, topL.id)[0]];
            let j = d.layers.slice(0, d.layers.indexOf(lowestTop)).filter((x) => !b.has(x.id)).length;
            const rest = d.layers.filter((x) => !b.has(x.id));
            for (const id of tops) d.layers.find((x) => x.id === id).parent = G.id;
            d.layers = [...rest.slice(0, j), ...block, G, ...rest.slice(j)];
            d.active = G.id;
            this.picked = new Set([G.id]);
            this.editMask = false;
        });
    }

    /** Ctrl+Shift+G: the active group's layers out of it, in its place. */
    ungroup() {
        const G = this.active();
        if (!G || G.kind !== "group") { this._notify("Ungroup: pick a group.", "info"); return false; }
        if (G.locked) { this._notify(`${G.name} is locked.`, "warn"); return false; }
        return this.change("Ungroup", () => {
            const kids = this.doc.layers.filter((x) => x.parent === G.id);
            for (const x of kids) { if (G.parent) x.parent = G.parent; else delete x.parent; }
            this.doc.layers = this.doc.layers.filter((x) => x.id !== G.id);
            this.masks.delete(G.id);
            this.doc.active = kids.length ? kids[kids.length - 1].id : (this.doc.layers[0] || {}).id;
            this.picked = new Set(kids.map((x) => x.id));
            this.editMask = false;
        });
    }

    /**
     * Clip the picked layers to the layer under each (a clipping mask: they show only where it is), or
     * release them. A group is not clipped; layers can be clipped to a group.
     */
    toggleClip() {
        const P = this.pickedLayers().filter((L) => L.kind !== "group");
        if (!P.length) { this._notify("Clipping mask: pick a pixel or adjustment layer (a group is not clipped).", "info"); return false; }
        const A = this.active();
        const on = !(A && A.clip);
        if (on) {
            const lowest = P.find((L) => !this._clipBase(L, P));
            if (lowest) { this._notify(`${lowest.name} has no layer under it to clip to.`, "warn"); return false; }
        }
        return this.setPickedProps((L) => { if (L.kind === "group") return false; if (on) L.clip = true; else delete L.clip; },
                                   on ? "Create clipping mask" : "Release clipping mask");
    }

    /** The layer `L` would be clipped to: the nearest one under it in its group that is not clipped (nor in `also`). */
    _clipBase(L, also = []) {
        const d = this.doc, i = D.layerIndex(d, L.id);
        const skip = new Set(also.map((x) => x.id));
        for (let j = i - 1; j >= 0; j--) {
            const B = d.layers[j];
            if ((B.parent || null) !== (L.parent || null)) continue;
            if (B.clip || skip.has(B.id)) continue;
            return B.kind === "adjust" ? null : B;
        }
        return null;
    }

    /** Open / fold a group in the Layers panel (not an undo step). */
    toggleCollapsed(id) {
        const G = this.doc && this.doc.layers.find((x) => x.id === id);
        if (!G || G.kind !== "group") return;
        if (G.collapsed) delete G.collapsed; else G.collapsed = true;
        this.refreshLayers();
    }

    setLayerProps(id, patch, label = "Layer") {
        return this.change(label, () => {
            const L = this.doc.layers.find((x) => x.id === id);
            if (!L) return false;
            Object.assign(L, patch);
        });
    }

    /** One change on every picked layer: `fn(L)` (return false to leave one alone). */
    setPickedProps(fn, label) {
        return this.change(label, () => {
            let any = false;
            for (const L of this.pickedLayers()) if (fn(L) !== false) any = true;
            return any;
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

    /** Ctrl+E: several layers picked - merge them; a group - merge it; else this layer into the one under it (in its group). */
    mergeDown() {
        const L = this.active();
        if (!L) return false;
        if (this.pickedLayers().length > 1) return this.mergeLayers();
        if (L.kind === "group") return this.mergeGroup();
        const i = D.layerIndex(this.doc, L.id);
        let j = i - 1;
        while (j >= 0 && (this.doc.layers[j].parent || null) !== (L.parent || null)) j--;
        const B = this.doc.layers[j];
        if (!B) { this._notify(L.parent ? "Nothing under this layer in its group to merge into." : "Nothing under this layer to merge into.", "warn"); return false; }
        if (B.kind !== "pixel") { this._notify(`${B.name} is ${B.kind === "group" ? "a group" : "an adjustment layer"}: merge into a pixel layer.`, "warn"); return false; }
        if (L.locked || B.locked) { this._notify("A locked layer is not merged.", "warn"); return false; }
        return this.change("Merge down", () => this._mergeInto(L, B));
    }

    /** L laid onto the pixel layer B (both in the document, B grown to the canvas), L taken away, B active. */
    _mergeInto(L, B) {
        this._growToCanvas(B);
        const base = this.pix.get(B.id);
        const sub = { w: B.w, h: B.h, layers: [] };
        const lb = { ...B, x: 0, y: 0, opacity: 1, blend: "normal", visible: true };
        delete lb.mask;
        delete lb.parent;
        const lt = { ...L, visible: true };
        delete lt.parent;
        if (L.kind === "pixel") { lt.x = L.x - B.x; lt.y = L.y - B.y; }
        if (lt.mask) lt.mask = { ...lt.mask, x: lt.mask.x - B.x, y: lt.mask.y - B.y };
        sub.layers = [lb, lt];
        const out = D.composite(sub, (X) => (X.id === B.id ? base : this.pix.get(X.id)), (X) => (X === lt && lt.mask ? this._maskOf(L) : null));
        if (L.kind === "adjust") for (let k = 3; k < out.length; k += 4) out[k] = base[k];
        this.pix.set(B.id, out);
        delete B.text;
        delete B.smart;
        this.doc.layers.splice(D.layerIndex(this.doc, L.id), 1);
        this.pix.delete(L.id);
        this.masks.delete(L.id);
        this.doc.active = B.id;
        this.editMask = false;
    }

    /**
     * Layers laid alone (on nothing, as a document of the canvas's size): `tops` and what is in them, each
     * top as it is but out of its group. The picture they make (W x H).
     */
    _layAlone(tops, top = null) {
        const block = D.withInside(this.doc, tops).map((x) => ({ ...x }));
        for (const x of block) if (tops.includes(x.id)) { delete x.parent; if (top) Object.assign(x, top(x)); }
        const sub = { w: this.doc.w, h: this.doc.h, layers: block };
        return D.composite(sub, this._pixOf, this._maskOf);
    }

    /** The active group made one pixel layer: what it shows, alone, with the group's opacity, blend and mask kept on it. */
    mergeGroup() {
        const G = this.active();
        if (!G || G.kind !== "group") return false;
        const block = D.withInside(this.doc, [G.id]);
        if (block.some((x) => x.locked)) { this._notify("A locked layer is not merged.", "warn"); return false; }
        return this.change("Merge group", () => {
            const flat = this._layAlone([G.id], (x) => { const o = { visible: true, opacity: 1, blend: "normal" }; delete x.mask; return o; });
            const L = D.cleanLayer({ id: D.newId(), name: G.name, kind: "pixel", x: 0, y: 0, w: this.doc.w, h: this.doc.h,
                                     opacity: G.opacity, visible: G.visible, blend: D.BLEND_MODES.includes(G.blend) ? G.blend : "normal",
                                     parent: G.parent, mask: G.mask });
            if (G.mask) this.masks.set(L.id, this.masks.get(G.id));
            const at = D.subtreeRange(this.doc, G.id)[0];
            const b = new Set(block.map((x) => x.id));
            for (const x of b) { this.pix.delete(x); this.masks.delete(x); }
            this.pix.set(L.id, flat);
            const rest = this.doc.layers.filter((x) => !b.has(x.id));
            this.doc.layers = [...rest.slice(0, at), L, ...rest.slice(at)];
            this.doc.active = L.id;
            this.picked = new Set([L.id]);
            this.editMask = false;
        });
    }

    /** The picked layers made one (Ctrl+E with several): where the top one was, named as it is. Hidden ones are left out (and go). */
    mergeLayers() {
        const tops = D.outermost(this.doc, this.pickedLayers().map((x) => x.id));
        if (tops.length < 2 && !(tops.length === 1 && this.doc.layers.find((x) => x.id === tops[0]).kind === "group")) return false;
        const block = D.withInside(this.doc, tops);
        if (block.some((x) => x.locked)) { this._notify("A locked layer is not merged.", "warn"); return false; }
        const topL = this.doc.layers.find((x) => x.id === tops[tops.length - 1]);
        return this.change(`Merge ${tops.length} layers`, () => {
            const flat = this._layAlone(tops);
            const L = D.cleanLayer({ id: D.newId(), name: topL.name, kind: "pixel", x: 0, y: 0, w: this.doc.w, h: this.doc.h, parent: topL.parent });
            const b = new Set(block.map((x) => x.id));
            const at = this.doc.layers.slice(0, D.subtreeRange(this.doc, topL.id)[0]).filter((x) => !b.has(x.id)).length;
            for (const x of b) { this.pix.delete(x); this.masks.delete(x); }
            this.pix.set(L.id, flat);
            const rest = this.doc.layers.filter((x) => !b.has(x.id));
            this.doc.layers = [...rest.slice(0, at), L, ...rest.slice(at)];
            this.doc.active = L.id;
            this.picked = new Set([L.id]);
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
        if (cmd === "delete") {
            const many = this.pickedMasks();
            return this.deleteMasks(many.length > 1 ? many.map((X) => X.id) : [L.id]);
        }
        if (cmd === "invert") return this.change("Invert mask", () => { this.masks.set(L.id, D.invertMask(this.masks.get(L.id))); L.mask.fill = 255 - L.mask.fill; });
        if (cmd === "apply" && L.kind === "pixel") {
            return this.change("Apply mask", () => {
                const px = new Uint8ClampedArray(this.pix.get(L.id));
                const m = this._maskOf(L), mk = L.mask, dn = mk.density == null ? 1 : mk.density;
                for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
                    const mx = x + L.x - mk.x, my = y + L.y - mk.y;
                    const v = mx >= 0 && my >= 0 && mx < mk.w && my < mk.h ? m[my * mk.w + mx] : mk.fill;
                    const o = (y * L.w + x) * 4 + 3;
                    px[o] = D.q8((px[o] / 255) * (1 - dn * (1 - v / 255)));
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

    _pixelTarget(what, { smartOk = false } = {}) {
        const L = this.active();
        if (!L) return null;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return null; }
        if (L.kind !== "pixel") { this._notify(`${what}: pick a pixel layer (this one is ${L.kind === "group" ? "a group" : "an adjustment layer"}).`, "warn"); return null; }
        if (!smartOk && this._smartRefuses(L, what)) return null;
        return L;
    }

    /** Colour into the selection (or all of the layer), by `alpha` 0..1. */
    fillSelection(color = this.fg, alpha = 1) {
        const lum = Math.round(0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]);
        if (this._maskUp()) {
            let area = this.quick ? null : this.sel;
            if (alpha < 1) area = (area || new Uint8Array(this.doc.w * this.doc.h).fill(255)).map((v) => Math.round(v * alpha));
            if (this._fillMaskArea(area, lum, "Fill")) return true;
        }
        const L = this._pixelTarget("Fill");
        if (!L) return false;
        return this.change("Fill", () => {
            const px = this._growToCanvas(L);
            const t = this.sel ? D.maskForLayer(this.sel, this.doc.w, this.doc.h, L) : new Uint8Array(L.w * L.h).fill(255);
            this.pix.set(L.id, this._keepAlpha(L, px, D.fillOver(px, L.w, L.h, [...color, Math.round(alpha * 255)], t, 255)));
        });
    }

    /** Is Quick Mask up, or the active layer's mask picked (so fills go there)? */
    _maskUp() {
        const L = this.active();
        return !!this.quick || !!(L && L.mask && (this.editMask || L.kind !== "pixel"));
    }

    clearSelection() {
        if (this._maskUp()) {
            // On a mask (Quick Mask too): the selection hidden - black.
            if (!this.quick && !this.sel) { this._notify("Select what to clear first.", "info"); return false; }
            return this._fillMaskArea(this.quick ? null : this.sel, 0, "Clear");
        }
        const L = this._pixelTarget("Clear");
        if (!L) return false;
        if (!this.sel) { this._notify("Select what to clear first.", "info"); return false; }
        if (L.lockAlpha) return this.fillSelection(this.bg);      // its transparency is locked: the second colour
        return this.change("Clear", () => {
            const px = new Uint8ClampedArray(this.pix.get(L.id));
            const m = D.maskForLayer(this.sel, this.doc.w, this.doc.h, L);
            for (let i = 0; i < m.length; i++) px[i * 4 + 3] = D.q8((px[i * 4 + 3] / 255) * (1 - m[i] / 255));
            this.pix.set(L.id, px);
        });
    }

    /** The pixel layers a filter works on: every picked one (unlocked). Null (and said) when there are none. */
    _filterTargets(what) {
        const P = this.pickedLayers().filter((L) => L.kind === "pixel");
        if (!P.length) { this._notify(`${what}: pick a pixel layer (or several).`, "warn"); return null; }
        const lk = P.find((L) => L.locked);
        if (lk) { this._notify(`${lk.name} is locked.`, "warn"); return null; }
        const sm = P.find((L) => this.isSmart(L));
        if (sm && this._smartRefuses(sm, what)) return null;
        return P;
    }

    /** `run(px, w, h)` on a layer's pixels `px`, mixed back in by the selection when there is one. */
    _filtered(L, px, run) {
        const out = run(px, L.w, L.h);
        if (this.sel) {
            const m = D.maskForLayer(this.sel, this.doc.w, this.doc.h, L);
            for (let i = 0; i < m.length; i++) {
                const t = m[i] / 255;
                if (t >= 1) continue;
                for (let c = 0; c < 4; c++) out[i * 4 + c] = D.q8((px[i * 4 + c] / 255) * (1 - t) + (out[i * 4 + c] / 255) * t);
            }
        }
        return out;
    }

    /** A filter on every picked pixel layer, as one undo step. */
    applyFilter(label, run, targets = null) {
        const T = targets || this._filterTargets(label);
        if (!T) return false;
        return this.change(label, () => { for (const L of T) this.pix.set(L.id, this._filtered(L, this.pix.get(L.id), run)); });
    }

    /** Blur, sharpen or an adjustment baked into the picked pixel layers (in the selection when there is one). */
    filter(kind, p = {}) {
        const label = kind === "blur" ? "Gaussian blur" : kind === "sharpen" ? "Sharpen" : D.ADJUST_LABELS[kind];
        return this.applyFilter(label, (px, w, h) => (kind === "blur" ? D.blurPixels(px, w, h, p.radius || 4)
            : kind === "sharpen" ? D.sharpenPixels(px, w, h, p.radius || 2, p.amount == null ? 1 : p.amount)
            : D.adjustPixels(px, w, h, kind, p)));
    }

    /**
     * A filter's dialog with a live preview on the picture: `run(px, w, h, values)`. The preview puts the
     * filtered pixels in place without an undo step; OK makes it one, Cancel puts the pixels back.
     */
    filterDialog(label, fields, run) {
        const T = this._filterTargets(label);
        if (!T) return null;
        this._tfSettle();
        const orig = new Map(T.map((L) => [L.id, this.pix.get(L.id)]));
        let timer = 0, on = true;
        const back = () => { for (const [id, b] of orig) this.pix.set(id, b); this._dropBelow(); this.requestRedraw(); };
        const show = (v) => {
            if (!on) { back(); return; }
            for (const L of T) this.pix.set(L.id, this._filtered(L, orig.get(L.id), (px, w, h) => run(px, w, h, v)));
            this._dropBelow();
            this.requestRedraw();
        };
        // At most once a frame, with the newest values: shown WHILE a slider is dragged (a wait for the input to rest showed it only when let go).
        let want = null;
        const later = (v) => {
            want = v;
            if (timer) return;
            timer = this.d.defaultView.requestAnimationFrame(() => { timer = 0; show(want); });
        };
        return this.dialog(label, fields, (v) => {
            if (timer) this.d.defaultView.cancelAnimationFrame(timer);
            timer = 0;
            back();
            this.applyFilter(label, (px, w, h) => run(px, w, h, v), T);
        }, T.length > 1 ? `On ${T.length} layers.` : "", {
            preview: true,
            onInput: (v, prev) => { on = prev; later(v); },
            onCancel: () => { if (timer) this.d.defaultView.cancelAnimationFrame(timer); timer = 0; back(); },
        });
    }

    flipLayer(axis) {
        const L = this._pixelTarget("Flip", { smartOk: true });
        if (!L) return false;
        if (this.isSmart(L)) {
            const cx = L.x + L.w / 2, cy = L.y + L.h / 2, f = axis === "h" ? [-1, 1] : [1, -1];
            return this.change("Flip layer", () => this._smartApply(L, [f[0], 0, cx - f[0] * cx, 0, f[1], cy - f[1] * cy, 0, 0, 1]));
        }
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
        const L = this._pixelTarget("Rotate", { smartOk: true });
        if (!L) return false;
        if (this.isSmart(L)) {
            const cx = L.x + L.w / 2, cy = L.y + L.h / 2, r = deg * Math.PI / 180;
            const c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
            return this.change("Rotate layer", () => {
                this._smartApply(L, [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1]);
                if (L.mask) { delete L.mask; this.masks.delete(L.id); }
            });
        }
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
        const L = this._pixelTarget("Scale", { smartOk: true });
        if (!L) return false;
        if (this.isSmart(L)) {
            const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
            return this.change("Scale layer", () => {
                this._smartApply(L, [k, 0, cx - k * cx, 0, k, cy - k * cy, 0, 0, 1]);
                if (L.mask) { delete L.mask; this.masks.delete(L.id); }
            });
        }
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
        if (this.doc.paths) this.doc.paths = D.movePaths(this.doc.paths, dx, dy);
        if (this.doc.guides) this._setGuides(D.moveGuides(this.doc.guides, dx, dy), w, h);
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
            const ow = this.doc.w, oh = this.doc.h;
            this.doc.w = w; this.doc.h = h;          // a smart layer is drawn for the new canvas
            for (const L of this.doc.layers) {
                if (this.isSmart(L)) this._smartApply(L, [kx, 0, 0, 0, ky, 0, 0, 0, 1]);
                else if (L.kind === "pixel") {
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
            if (this.sel) this.sel = resampleMask(this.d, this.sel, ow, oh, w, h);
            if (this.doc.paths) this.doc.paths = D.movePaths(this.doc.paths, 0, 0, kx, ky);
            if (this.doc.guides) this._setGuides(D.moveGuides(this.doc.guides, 0, 0, kx, ky), w, h);
            this.doc.w = w; this.doc.h = h;
        });
        if (ok) this.fit();
        return ok;
    }

    // ── tools ────────────────────────────────────────────────────────────────

    setTool(t) {
        // "shape:<kind>" (a shape's own entry): the shape tool with that shape.
        if (typeof t === "string" && t.startsWith("shape:")) { this.opts.shape.kind = t.slice(6); t = "shape"; }
        if (t !== "crop") this.crop = null;
        if (t !== "text") this._commitText();
        if (this.tf && (t !== "move" && t !== "tfsel" || !!this.tf.float !== (t === "tfsel"))) this.tfCommit();
        if (t !== "move" && this.wp) this.wpCommit();
        if (t !== "liquify" && this.lq) this.lqCommit();
        if (t !== "pen") this._penOpen = false;
        this._closeFlyout();
        this.tool = t;
        this._groupShow(t);
        const on = this.toolBtns[t];
        for (const b of new Set(Object.values(this.toolBtns))) b.classList.toggle("on", b === on);
        this._cursor();
        this.refreshProps();
        this.drawOverlay();
        // Transform selection takes the selected pixels up at once, so their box shows (Photoshop's way).
        if (t === "tfsel" && !this.tf && this.sel && this.doc) this.tfBegin({ float: true });
    }

    /** The pointer's look over the picture: the tool's, none where the brush's circle stands in for it, the arrow with no picture. */
    _cursor(over = null) {
        const t = this.tool;
        if (!this.doc) { this.wrap.style.cursor = "default"; return; }
        if (over) { this.wrap.style.cursor = over; return; }
        const cursors = { hand: "grab", move: "move", text: "text", picker: "copy", pathsel: "default", pathdirect: "default" };
        this.wrap.style.cursor = cursors[t] || (BRUSHES.includes(t) || t === "liquify" ? "none" : "crosshair");
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

    /**
     * The eyedropper: a click takes the colour under it; dragged further than a few pixels it draws a box and
     * takes the average colour inside it, live while dragged.
     */
    _pickMove(dr, p, e) {
        dr.x1 = p.x; dr.y1 = p.y;
        if (!dr.box && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 3) dr.box = true;
        if (!dr.box) { this._pickAt(p); return; }
        this._pickArea(dr);
        this.drawOverlay();
    }

    _pickArea(dr) {
        if (!this.doc) return null;
        const c = D.areaAverage(this.comp, this.doc.w, this.doc.h, dr.x0, dr.y0, dr.x1, dr.y1);
        if (c) this.setColor("fg", c);
        dr.avg = c;
        return c;
    }

    _pickBoxDraw(c, X, Y) {
        const dr = this._drag;
        if (!dr || dr.kind !== "pick" || !dr.box) return;
        const x = Math.round(X(Math.min(dr.x0, dr.x1))) + 0.5, y = Math.round(Y(Math.min(dr.y0, dr.y1))) + 0.5;
        const w = Math.abs(dr.x1 - dr.x0) * this.view.zoom, h = Math.abs(dr.y1 - dr.y0) * this.view.zoom;
        c.lineWidth = 1;
        c.strokeStyle = "#000"; c.strokeRect(x, y, w, h);
        c.strokeStyle = "#fff"; c.setLineDash([4, 3]); c.strokeRect(x, y, w, h); c.setLineDash([]);
        if (dr.avg) {
            // The colour taken, in a swatch at the box's corner.
            const sx = x + w + 6, sy = y;
            c.fillStyle = D.rgbToHex(...dr.avg); c.fillRect(sx, sy, 22, 22);
            c.strokeStyle = "#fff"; c.strokeRect(sx + 0.5, sy + 0.5, 21, 21);
        }
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
        w.addEventListener("pointerdown", (e) => { this._layersFocus = false; this._down(e); });
        w.addEventListener("pointermove", (e) => this._move(e));
        w.addEventListener("pointerup", (e) => this._up(e));
        w.addEventListener("pointercancel", (e) => this._up(e));
        w.addEventListener("pointerleave", () => { this._hover = null; this.drawOverlay(); this._status(); });
        w.addEventListener("dblclick", (e) => {
            if (this.tool === "crop" && this.crop) { e.preventDefault(); this.applyCrop(); }
            else if (this.wp) { e.preventDefault(); this.wpCommit(); }
            else if ((this.tool === "move" || this.tool === "tfsel") && this.tf) { e.preventDefault(); this.tfCommit(); }
        });
        for (const t of ["mousedown", "dblclick", "contextmenu"]) w.addEventListener(t, (e) => e.stopPropagation());
    }

    _down(e) {
        if (!this.doc) return;
        this.wrap.focus({ preventScroll: true });
        if (this._bd) { this._bdEnd(); return; }       // a press while B is held ends the size drag (and paints nothing)
        // B held + left drag, or Alt+right-drag (Photoshop's, on Windows): the brush's size sideways, its opacity
        // up and down. Nothing is painted.
        if (this._bdTool() && ((e.button === 0 && this._bHeld) || (e.button === 2 && e.altKey))) {
            if (this._bHeld) this._bHeld.used = true;
            e.preventDefault();
            this.wrap.setPointerCapture(e.pointerId);
            this._bdBegin(e, "mouse");
            return;
        }
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
        if (this._guideDown(p)) return;
        if (this.wp) { this._wpDown(p); return; }
        const t = this.tool;
        if ((t === "brush" || t === "fill") && e.altKey) { this._pickAt(p); return; }
        if (SOURCED.includes(t) && e.altKey) { this.setCloneSource(p.x, p.y); return; }
        if (t === "patch") { this._patchDown(p, e); return; }
        if (t === "gradient") { this._gradDown(p, e); return; }
        if (t === "liquify") { this._lqDown(p); return; }
        if (t === "shape") { this._shapeDown(p, e); return; }
        if (t === "picker") { this._pickAt(p); this._drag = { kind: "pick", x0: p.x, y0: p.y, x1: p.x, y1: p.y, sx: e.clientX, sy: e.clientY, box: false }; return; }
        if (BRUSHES.includes(t)) { this._strokeStart(p, e); return; }
        if (t === "fill") { this._bucket(p); return; }
        if (t === "wand") { this._wand(p, e); return; }
        if (t === "marquee" || t === "ellipse") { const [x0, y0] = this._snapPt(p.x, p.y); this._drag = { kind: t, x0, y0, rect: null, e }; return; }
        if (t === "lasso") { this._drag = { kind: "lasso", pts: [[p.x, p.y]], e }; return; }
        if (t === "pen") { this._penDown(p, e); return; }
        if (PATH_TOOLS.includes(t)) { this._pathToolDown(p, e); return; }
        if (t === "move") {
            const set = this._moveSet();
            if (set) {
                if (set.some((x) => x.locked)) { this._notify("A locked layer is not moved.", "warn"); return; }
                this.liveBegin();
                const from = new Map(set.map((L) => [L.id, { x: L.x, y: L.y, mx: L.mask ? L.mask.x : 0, my: L.mask ? L.mask.y : 0 }]));
                this._drag = { kind: "mmove", set, from, p0: { x: p.x, y: p.y } };
                return;
            }
            this._tfDown(p, e);
            return;
        }
        if (t === "tfsel") { this._tfDown(p, e); return; }
        if (t === "crop") { this._cropStart(p); return; }
        if (t === "text") { this._textAt(p); return; }
    }

    _move(e) {
        if (!this.doc) return;
        this._lastClient = { clientX: e.clientX, clientY: e.clientY };
        if (this._bdMove(e)) return;
        const p = this.toImage(e);
        this._hover = p;
        const dr = this._drag;
        if (!dr) {
            const onRuler = this.rulers && (p.sx < RULER_PX || p.sy < RULER_PX);
            if (onRuler) this._cursor(p.sy < RULER_PX && p.sx >= RULER_PX ? "row-resize" : p.sx < RULER_PX && p.sy >= RULER_PX ? "col-resize" : "default");
            const gi = !onRuler && this.tool === "move" && !this.tf && !this.wp ? this._guideAt(p.sx, p.sy) : -1;
            if (gi >= 0) this._cursor(this._guides()[gi].axis === "x" ? "col-resize" : "row-resize");
            else if (this._onRuler) this._cursor();
            this._onRuler = onRuler ? "ruler" : gi >= 0 ? "guide" : null;
            if (BRUSHES.includes(this.tool) || this.tool === "liquify" || (this.tool === "pen" && this._penOpen) || this.rulers) this.drawOverlay();
            if (onRuler || this._onRuler === "guide") { this._status(); return; }
            if (BRUSHES.includes(this.tool) || this.tool === "liquify" || (this.tool === "pen" && this._penOpen)) { /* the overlay draws the pointer */ }
            else if (this.wp) this._cursor("crosshair");
            else if (this.tool === "move" && !this._space) this._cursor(this._moveSet() ? "move" : this._tfCursor(this._tfHit(p)));
            else if (this.tool === "tfsel" && !this._space) this._cursor(this.tf ? this._tfCursor(this._tfHit(p)) : this.sel ? "move" : "default");
            this._status();
            return;
        }
        if (dr.kind === "pan") {
            this.view.x = dr.vx + (e.clientX - dr.sx);
            this.view.y = dr.vy + (e.clientY - dr.sy);
            this._applyView();
            return;
        }
        if (dr.kind === "pick") { this._pickMove(dr, p, e); return; }
        if (dr.kind === "guide") { this._guideMove(dr, p); return; }
        if (dr.kind === "lq") { this._lqMove(dr, p); this.drawOverlay(); return; }
        if (dr.kind === "pen") { this._penMove(dr, p, e); return; }
        if (dr.kind === "pathmove" || dr.kind === "pathbox") { this._pathToolMove(dr, p, e); return; }
        if (dr.kind === "wp") { this._wpMove(dr, p); return; }
        if (dr.kind === "patch") { this._patchMove(dr, p); return; }
        if (dr.kind === "grad") { this._gradMove(dr, p, e); return; }
        if (dr.kind === "shape") { this._shapeMove(dr, p, e); return; }
        if (dr.kind === "stroke") {
            // A pen sends far more positions than pointermove fires: take every one, with its pressure.
            const all = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
            for (const ce of (all.length ? all : [e])) this._strokeTo(this.toImage(ce), D.pressureOf(ce.pointerType, ce.pressure));
            this.drawOverlay();
            return;
        }
        if (dr.kind === "marquee" || dr.kind === "ellipse") {
            const [px, py] = this._snapPt(p.x, p.y);
            let w = px - dr.x0, h = py - dr.y0;
            if (e.shiftKey && !dr.e.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
            dr.rect = { x: Math.min(dr.x0, dr.x0 + w), y: Math.min(dr.y0, dr.y0 + h), w: Math.abs(w), h: Math.abs(h) };
            this.drawOverlay();
            return;
        }
        if (dr.kind === "lasso") { dr.pts.push([p.x, p.y]); this.drawOverlay(); return; }
        if (dr.kind === "tf") { this._tfDrag(dr, p, e); return; }
        if (dr.kind === "mmove") {
            let dx = Math.round(p.x - dr.p0.x), dy = Math.round(p.y - dr.p0.y);
            [dx, dy] = this._snapMove(dr, dx, dy);
            this._shiftLayers(dr.set, dx, dy, dr.from);
            this.requestRedraw();
            return;
        }
        if (dr.kind === "crop") { this._cropMove(p); return; }
    }

    _up(e) {
        if (this._bd && this._bd.by === "mouse") {
            if (this.wrap.hasPointerCapture && this.wrap.hasPointerCapture(e.pointerId)) this.wrap.releasePointerCapture(e.pointerId);
            this._bdEnd();
            return;
        }
        const dr = this._drag;
        this._drag = null;
        this._previewSettle();
        if (this.wrap.hasPointerCapture && this.wrap.hasPointerCapture(e.pointerId)) this.wrap.releasePointerCapture(e.pointerId);
        if (!dr) return;
        if (dr.kind === "pan") { this.setTool(this.tool); return; }
        if (dr.kind === "stroke") { this._strokeEnd(dr.st); return; }
        if (dr.kind === "guide") { this._guideUp(dr); return; }
        if (dr.kind === "lq") { this._thumbsSoon(); this.refreshProps(); return; }
        if (dr.kind === "pen") { this._penUp(dr); return; }
        if (dr.kind === "pathmove" || dr.kind === "pathbox") { this._pathToolUp(dr); return; }
        if (dr.kind === "wp") { this._wpUp(); return; }
        if (dr.kind === "patch") { this._patchUp(dr); return; }
        if (dr.kind === "grad") { this._gradUp(dr); return; }
        if (dr.kind === "shape") { this._shapeUp(dr); return; }
        if (dr.kind === "pick") { if (dr.box) { this._pickArea(dr); this.drawOverlay(); } return; }
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
        if (dr.kind === "tf") { this._tfShow(true); return; }
        if (dr.kind === "mmove") { this.liveEnd(dr.set.length > 1 ? "Move layers" : "Move"); this.refreshProps(); return; }
        if (dr.kind === "crop") { this.drawOverlay(); return; }
    }

    // The brush and the eraser: on the layer's pixels, or on its mask (Layers panel: the mask's thumbnail).
    _strokeStart(p, e) {
        this._tfSettle();
        if (this.quick) { this._quickStroke(p, e); return; }
        const L = this.active();
        if (!L) return;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return; }
        if (L.kind === "group" && !(this.editMask && L.mask)) {
            this._notify(L.mask ? "A group has no pixels: pick a layer in it, or its mask's thumbnail to paint the mask." : "A group has no pixels: pick a layer in it (or add a mask to the group and paint that).", "info");
            return;
        }
        const onMask = this.editMask || L.kind === "adjust" || L.kind === "group";
        if (!onMask && !this.quick && this._smartRefuses(L, (PAINT_TOOLS.find((t) => t[0] === this.tool) || [, , "Painting"])[2].split(" (")[0])) return;
        const clone = SOURCED.includes(this.tool), heal = this.tool === "spot" ? "spot" : this.tool === "heal" ? "heal" : null;
        const what = { clone: "The clone stamp", spot: "The spot healing brush", heal: "The healing brush", dodge: "Dodge", burn: "Burn", sponge: "The sponge" }[this.tool];
        if ((clone || heal || TONERS.includes(this.tool)) && onMask) { this._notify(`${what} works on a layer's pixels: pick the layer (not its mask).`, "info"); return; }
        if (clone && !this.cloneSrc) { this._notify(`Alt+click where ${what.toLowerCase()} should take from first.`, "info"); return; }
        if (L.kind === "adjust" && !L.mask) this.addMask("all");
        if (L.kind === "pixel" && !onMask && !L.lockAlpha) {
            // A layer smaller than the canvas grows first (an undo entry of its own shape) - not with its transparency locked: nothing is added outside.
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
        if (clone) {
            // Where it takes from: the same offset for every stroke (aligned) once the first one set it, or from
            // the source point again at each stroke. The layer as it was before the stroke, or the picture.
            const off = o.aligned && this._cloneOff ? this._cloneOff
                : { dx: Math.round(this.cloneSrc.x - p.x), dy: Math.round(this.cloneSrc.y - p.y), ax: p.x, ay: p.y };
            this._cloneOff = off;
            st.clone = o.sample === "all"
                ? { src: new Uint8ClampedArray(this.comp), sw: this.doc.w, sh: this.doc.h, sx: 0, sy: 0, dx: off.dx, dy: off.dy }
                : { src: st.orig, sw: A.w, sh: A.h, sx: A.x, sy: A.y, dx: off.dx, dy: off.dy };
            // The source turned, scaled or flipped about where the offset was set.
            const m = D.cloneMatrix(o.angle, o.scale, o.flip);
            if (m) Object.assign(st.clone, { m, ax: off.ax, ay: off.ay });
        }
        if (heal) {
            st.heal = heal;
            st.healOpacity = o.opacity / 100;
            // While painting: the healing brush shows its source, the spot brush a dark wash where it will heal.
            if (heal === "spot") { st.color = [0, 0, 0]; st.opacity = 0.35; }
        }
        if (TONERS.includes(this.tool)) st.tone = { mode: this.tool, range: o.range, sat: o.sat };
        // Locked transparency: paint only where there is something, its alpha kept (the eraser paints the second colour).
        if (!onMask && A.lockAlpha) { st.lockAlpha = true; if (st.erase) { st.erase = false; st.color = this.bg; } }
        st.L = A;
        st.radius = Math.max(0.5, o.size / 2);
        if (this.tool === "smudge") st.smudge = smudgeStart(st.radius, o.finger, st.color);
        if (this.tool === "blur") st.blur = true;
        st.hard = o.hardness / 100;
        st.spacing = Math.max(0.01, o.spacing / 100);
        st.penSize = o.penSize !== false;
        st.penOpacity = !!o.penOpacity;
        this._tipInto(st, o);
        const pr = D.pressureOf(e.pointerType, e.pressure);
        st.last = [p.x, p.y, pr];
        if (st.way) { st.way.ax = p.x; st.way.ay = p.y; }
        st.carry = 0;
        st.touched = null;
        this._keepBelow(A);
        this._drag = { kind: "stroke", st };
        if (e.shiftKey && this._lastStrokeEnd && this._lastStrokeEnd.L === A.id) {
            // Shift-click: a straight line from where the last stroke ended (Direction: the tip along that line).
            const a = this._lastStrokeEnd;
            if (st.way) st.way = D.directionTurn({ ax: a.x, ay: a.y, vx: null, vy: null, dir: null }, p.x, p.y, 0.5);
            this._dab(st, [[p.x, p.y, pr]]);
            this._dab(st, D.pressureDabs(a.x, a.y, pr, p.x, p.y, pr, st.radius, st.spacing, 0, st.penSize).dabs);
        } else if (st.way) st.pending = [[p.x, p.y, pr]];       // Direction: the first dab waits until the stroke has a way
        else this._dab(st, [[p.x, p.y, pr]]);
    }

    /** A brush or eraser stroke on Quick Mask (white adds to the selection, black takes away; the eraser the other way). */
    _quickStroke(p, e) {
        if (SOURCED.includes(this.tool) || this.tool === "spot") { this._notify("Quick Mask is painted with the brush or the eraser.", "info"); return; }
        const W = this.doc.w, H = this.doc.h, m = this.quick.m;
        const o = this.opts[this.tool], erase = this.tool === "eraser";
        const gray = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < m.length; i++) { gray[i * 4] = gray[i * 4 + 1] = gray[i * 4 + 2] = m[i]; gray[i * 4 + 3] = 255; }
        const lum = Math.round(0.2126 * this.fg[0] + 0.7152 * this.fg[1] + 0.0722 * this.fg[2]);
        const v = erase ? 255 - lum : lum;
        const st = { px: gray, orig: new Uint8ClampedArray(gray), cover: new Float32Array(W * H), lw: W, lh: H, lx: 0, ly: 0,
                     color: [v, v, v], opacity: o.opacity / 100, erase: false, lockAlpha: true, sel: null, W, H, mask: m, onMask: true, quick: true };
        st.L = this.active() || { id: "" };
        st.radius = Math.max(0.5, o.size / 2);
        if (this.tool === "blur") st.blur = true;      // softens Quick Mask's edge
        st.hard = o.hardness / 100;
        st.spacing = Math.max(0.01, o.spacing / 100);
        st.penSize = o.penSize !== false;
        st.penOpacity = !!o.penOpacity;
        this._tipInto(st, o);
        const pr = D.pressureOf(e.pointerType, e.pressure);
        st.last = [p.x, p.y, pr];
        if (st.way) { st.way.ax = p.x; st.way.ay = p.y; }
        st.carry = 0;
        st.touched = null;
        this._drag = { kind: "stroke", st };
        this._dab(st, [[p.x, p.y, pr]]);
    }

    /**
     * What a fill paints when it is not a layer's pixels: Quick Mask, or the active layer's mask while that is
     * picked. `area` (W x H, 0..255, null = all) at the grey `v`, one undo step. False when neither is up.
     */
    _fillMaskArea(area, v, label) {
        const W = this.doc.w, H = this.doc.h;
        const put = (old, mk) => {
            const out = new Uint8Array(old);
            for (let y = 0; y < mk.h; y++) for (let x = 0; x < mk.w; x++) {
                const gx = x + mk.x, gy = y + mk.y;
                const inside = gx >= 0 && gy >= 0 && gx < W && gy < H;
                const t = area ? (inside ? area[gy * W + gx] / 255 : 0) : 1;
                // v: one grey, or a grey per canvas pixel (a gradient).
                const vv = typeof v === "number" ? v : inside ? v[gy * W + gx] : null;
                if (t > 0 && vv != null) { const i = y * mk.w + x; out[i] = Math.round(old[i] + (vv - old[i]) * t); }
            }
            return out;
        };
        if (this.quick) {
            const before = this.quick.m, after = put(before, { x: 0, y: 0, w: W, h: H });
            const q = this.quick;
            this._push({ label: "Quick Mask " + label.toLowerCase(), bytes: before.byteLength * 2,
                         undo: () => { q.m = before; this._tintDraw(); }, redo: () => { q.m = after; this._tintDraw(); } });
            q.m = after;
            this._tintDraw();
            return true;
        }
        const L = this.active();
        if (!L || !L.mask || !(this.editMask || L.kind !== "pixel")) return false;
        if (L.locked) { this._notify(`${L.name} is locked.`, "warn"); return true; }
        this.change(label + " (mask)", () => { this.masks.set(L.id, put(this.masks.get(L.id), L.mask)); });
        return true;
    }

    _strokeTo(p, pr = 1) {
        const st = this._drag.st;
        if (st.way) {
            st.way = D.directionTurn(st.way, p.x, p.y, Math.max(2, st.radius * 0.15));
            if (st.pending && st.way.dir != null) { const d = st.pending; st.pending = null; this._dab(st, d); }
        }
        const [x0, y0, p0] = st.last;
        const r = D.pressureDabs(x0, y0, p0, p.x, p.y, pr, st.radius, st.spacing, st.carry, st.penSize);
        st.carry = r.carry;
        st.last = [p.x, p.y, pr];
        if (r.dabs.length) this._dab(st, r.dabs);
    }

    /** The brush's tip, its angle and its jitter, onto a stroke. */
    _tipInto(st, o) {
        st.tip = o.tip && this.tips.get(o.tip) ? this.tips.get(o.tip) : null;
        st.tipAngle = ((o.angle || 0) * Math.PI) / 180;
        // Direction: the tip turns with the way the stroke goes (Angle is then on top of that way).
        st.way = st.tip && o.direction ? { ax: 0, ay: 0, vx: null, vy: null, dir: null } : null;
        // Flow: each dab lays only this much, and the dabs of one stroke build up to the opacity (D.stamp's st.build).
        const fl = o.flow == null ? 100 : Number(o.flow);
        st.build = fl > 0 && fl < 100 ? fl / 100 : 0;
        if (o.scatter || o.sizeJitter || o.angleJitter) {
            st.jit = { scatter: o.scatter, sizeJitter: o.sizeJitter, angleJitter: o.angleJitter };
            st.rand = D.seeded((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
        }
    }

    _dab(st, dabs) {
        let rect = null;
        for (const [x, y, pr = 1] of dabs) {
            const k = D.pressureScale(pr, st.penSize, st.penOpacity);
            const r = Math.max(0.5, st.radius * k.r);
            if (st.smudge) { rect = rectUnion(rect, smudgeDab(st, x, y, r, st.hard, st.opacity * k.a)); continue; }
            if (st.blur) { rect = rectUnion(rect, blurDab(st, x, y, r, st.hard, st.opacity * k.a)); continue; }
            const j = st.jit ? D.jitter(st.rand, r, st.jit) : null;
            const ang = (st.tipAngle || 0) + (st.way && st.way.dir != null ? st.way.dir : 0);
            rect = j ? rectUnion(rect, D.stamp(st, x + j.dx, y + j.dy, Math.max(0.5, r * j.k), st.hard, k.a, ang + j.da))
                     : rectUnion(rect, D.stamp(st, x, y, r, st.hard, k.a, ang));
        }
        if (!rect) return;
        if (st.onMask) {
            for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) st.mask[y * st.lw + x] = st.px[(y * st.lw + x) * 4];
        }
        st.touched = rectUnion(st.touched, rect);
        // A styled layer's look is cached by its buffer's version: count the dab so the style follows the stroke.
        // Its effects reach past the dab (a shadow's offset, a glow's blur): the whole picture is drawn again.
        if (st.L && (st.L.style || st.L.filters)) { this._bump(st.onMask ? st.mask : st.px); this.requestRedraw(null); return; }
        this.requestRedraw({ x0: rect.x0 + st.lx, y0: rect.y0 + st.ly, x1: rect.x1 + st.lx, y1: rect.y1 + st.ly });
    }

    _strokeEnd(s) {
        if (s && s.pending) { const d = s.pending; s.pending = null; this._dab(s, d); }     // a click with Direction: the tip as it is
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
        if (s.heal) this._healFinish(s);
        const before = cut(origBuf), after = cut(buf);
        this._bump(buf);
        const label = s.heal === "spot" ? "Spot healing brush" : s.heal ? "Healing brush" : s.clone ? "Clone stamp"
            : { eraser: "Eraser", dodge: "Dodge", burn: "Burn", sponge: "Sponge", smudge: "Smudge", blur: "Blur" }[this.tool] || "Brush";
        this._push({ label: (s.quick ? "Quick Mask " : "") + label, bytes: before.byteLength * 2,
                     undo: () => paste(buf, before), redo: () => paste(buf, after) });
        this._lastStrokeEnd = { L: s.L.id, x: s.last[0], y: s.last[1] };
        this.redraw(s.L.style || s.L.filters ? null : { x0: r.x0 + s.lx, y0: r.y0 + s.ly, x1: r.x1 + s.lx, y1: r.y1 + s.ly });
        this._thumbsSoon();
    }

    _bucket(p) {
        if (this._maskUp()) {
            // On a mask: the region of the picture as it looks (the bucket's tolerance), in the colour's grey.
            const x = Math.floor(p.x), y = Math.floor(p.y), W = this.doc.w, H = this.doc.h;
            if (x < 0 || y < 0 || x >= W || y >= H) return;
            const o = this.opts.fill;
            let area = D.floodMask(this.comp, W, H, x, y, o.tolerance, o.contiguous);
            if (this.sel && !this.quick) for (let i = 0; i < area.length; i++) area[i] = Math.min(area[i], this.sel[i]);
            this._fillMaskArea(area, Math.round(0.2126 * this.fg[0] + 0.7152 * this.fg[1] + 0.0722 * this.fg[2]), "Paint bucket");
            return;
        }
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
            this.pix.set(L.id, this._keepAlpha(L, px, D.fillOver(px, L.w, L.h, [...this.fg, 255], m, 255)));
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

    // The clone stamp: Alt+click sets where it takes from; the first stroke after that sets the offset.
    setCloneSource(x, y) {
        this.cloneSrc = { x, y };
        this._cloneOff = null;
        this.drawOverlay();
        this._status();
    }

    /** Where the clone stamp takes from for the pointer at (x, y) (canvas pixels), or null. */
    _cloneFrom(x, y) {
        const o = this.opts[SOURCED.includes(this.tool) ? this.tool : "clone"];
        const off = this._cloneOff;
        if (off && (o.aligned || (this._drag && this._drag.kind === "stroke"))) {
            const m = D.cloneMatrix(o.angle, o.scale, o.flip);
            if (!m || off.ax == null) return { x: x + off.dx, y: y + off.dy };
            const ux = x - off.ax, uy = y - off.ay;
            return { x: off.ax + off.dx + m.a * ux + m.c * uy, y: off.ay + off.dy + m.b * ux + m.d * uy };
        }
        return this.cloneSrc;
    }

    /** "Show overlay": what the brush would put down, inside its circle at the pointer (the picture at the source, half seen). */
    _cloneOverlay(c, h, s, dpr) {
        const o = this.opts[this.tool], v = this.view, r = Math.max(1, (o.size / 2) * v.zoom);
        const m = D.cloneMatrix(o.angle, o.scale, o.flip) || { a: 1, b: 0, c: 0, d: 1 };
        // The source's image point s lands on the pointer h; image point q lands on h + zoom * M^-1 (q - s).
        const det = m.a * m.d - m.b * m.c;
        if (!det) return;
        const ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det, z = v.zoom;
        c.save();
        c.beginPath(); c.arc(h.sx, h.sy, r, 0, Math.PI * 2); c.clip();
        c.globalAlpha = 0.5;
        c.imageSmoothingEnabled = z < 1;
        c.setTransform(dpr * z * ia, dpr * z * ib, dpr * z * ic, dpr * z * id,
                       dpr * (h.sx - z * (ia * s.x + ic * s.y)), dpr * (h.sy - z * (ib * s.x + id * s.y)));
        c.drawImage(this.canvas, 0, 0);
        c.restore();
    }

    // Transform (the Move tool's place, V): the active pixel layer under p = t + R·Shear·Scale·(u - c)
    // (imageViewer_paintData.js, tfMatrix). One session while the tool is on: its handles drag, the options
    // bar's numbers type, Enter or a double-click applies it (one undo entry), Esc throws it away. The layer
    // is shown at the nearest pixel while a handle moves and resampled (bilinear) when it is let go. A move
    // by whole pixels resamples nothing. The layer's mask is transformed with it.

    /** Anything that changes the document first applies a transform that is under way. */
    _tfSettle() { if (this.tf) this.tfCommit(); if (this.wp) this.wpCommit(); if (this.lq) this.lqCommit(); }

    _tfLayer(quiet = false) {
        const L = this.active();
        if (!L || L.kind !== "pixel") { if (!quiet) this._notify("Transform: pick a pixel layer.", "info"); return null; }
        if (L.locked) { if (!quiet) this._notify(`${L.name} is locked.`, "warn"); return null; }
        return L;
    }

    tfBegin({ float = false } = {}) {
        if (this.tf && !!this.tf.float === float) return this.tf;
        if (this.tf) this.tfCommit();
        this._commitText();
        if (float) return this._floatBegin();
        const L = this._tfLayer();
        if (!L) return null;
        const before = this._snap();
        const src = { px: this.pix.get(L.id), x: L.x, y: L.y, w: L.w, h: L.h,
                      mask: L.mask ? { m: this.masks.get(L.id), x: L.mask.x, y: L.mask.y, w: L.mask.w, h: L.mask.h, fill: L.mask.fill } : null };
        this.tf = { L, src, p: D.tfIdentity(L.x, L.y, L.w, L.h), before, smooth: true };
        this.refreshProps();
        this.drawOverlay();
        return this.tf;
    }

    /** What the overlay and the hit test go by: the session's transform, else the active layer as it lies. */
    _tfGeom() {
        if (this.tf) return { p: this.tf.p, w: this.tf.src.w, h: this.tf.src.h };
        if (this.tool === "tfsel") return null;
        const L = this.active();
        if (!L || L.kind !== "pixel") return null;
        return { p: D.tfIdentity(L.x, L.y, L.w, L.h), w: L.w, h: L.h };
    }

    /** The eight handles in the layer's own pixels: top left, top, top right, right, bottom right, bottom, bottom left, left. */
    _tfHandles(w, h) { return [[0, 0], [w / 2, 0], [w, 0], [w, h / 2], [w, h], [w / 2, h], [0, h], [0, h / 2]]; }

    /** What a press at p would do: { kind: "scale" | "move" | "rotate", i } or null (no pixel layer). */
    _tfHit(p) {
        const g = this._tfGeom();
        if (!g) return null;
        const m = D.tfMatrix(g.p), v = this.view;
        const H = this._tfHandles(g.w, g.h);
        let best = -1, bd = 8;
        H.forEach(([u, w], i) => {
            const [x, y] = D.applyM(m, u, w);
            const d = Math.hypot(v.x + x * v.zoom - p.sx, v.y + y * v.zoom - p.sy);
            if (d < bd) { bd = d; best = i; }
        });
        if (best >= 0) return { kind: "scale", i: best };
        const inv = D.invertM(m);
        if (inv) {
            const [u, w] = D.applyM(inv, p.x, p.y);
            if (u >= 0 && w >= 0 && u <= g.w && w <= g.h) return { kind: "move" };
        }
        return { kind: "rotate" };
    }

    _tfCursor(hit) {
        if (!hit) return "default";
        if (hit.kind === "move") return "move";
        if (hit.kind === "rotate") return ROTATE_CURSOR;
        const g = this._tfGeom(), m = D.tfMatrix(g.p);
        const [u, w] = this._tfHandles(g.w, g.h)[hit.i];
        const [x, y] = D.applyM(m, u, w);
        const ang = ((Math.atan2(y - g.p.ty, x - g.p.tx) * 180 / Math.PI) % 180 + 180) % 180;
        return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][Math.round(ang / 45) % 4];
    }

    _tfDown(p, e) {
        if (this.tool === "tfsel" && !this.tf && !this.tfBegin({ float: true })) return;
        const hit = this._tfHit(p);
        if (!hit) { this._tfLayer(); return; }
        const tf = this.tf || this.tfBegin();
        if (!tf) return;
        const dr = { kind: "tf", hit, p0: { x: p.x, y: p.y }, t0: { ...tf.p }, shear: hit.kind === "scale" && (e.ctrlKey || e.metaKey) && hit.i % 2 === 1 };
        if (hit.kind === "rotate") dr.a0 = Math.atan2(p.y - tf.p.ty, p.x - tf.p.tx);
        this._drag = dr;
    }

    _tfDrag(dr, p, e) {
        const tf = this.tf;
        if (!tf) return;
        const t0 = dr.t0, P = { ...t0 }, src = tf.src;
        if (dr.hit.kind === "move") {
            P.tx = t0.tx + Math.round(p.x - dr.p0.x);
            P.ty = t0.ty + Math.round(p.y - dr.p0.y);
            // The box's edges or middle pulled onto a guide, the canvas or another layer.
            const cs = D.tfCorners(D.tfMatrix(P), src.w, src.h), xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
            const [sx, sy] = this._snapBox(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), new Set([tf.L.id]));
            P.tx += Math.round(sx); P.ty += Math.round(sy);
        } else if (dr.hit.kind === "rotate") {
            let r = t0.r + (Math.atan2(p.y - t0.ty, p.x - t0.tx) - dr.a0) * 180 / Math.PI;
            if (e.shiftKey) r = Math.round(r / 15) * 15;
            P.r = ((r % 360) + 540) % 360 - 180;
        } else {
            const H = this._tfHandles(src.w, src.h), h = H[dr.hit.i];
            const a = e.altKey && !dr.shear ? [t0.cx, t0.cy] : H[(dr.hit.i + 4) % 8];
            const Pa = D.applyM(D.tfMatrix(t0), a[0], a[1]);
            const rr = t0.r * Math.PI / 180, cs = Math.cos(rr), sn = Math.sin(rr);
            const qx = p.x - Pa[0], qy = p.y - Pa[1];
            const du = h[0] - a[0], dv = h[1] - a[1];
            if (dr.shear) {
                // R⁻¹ (q - anchor) = Shear·Scale·(h - a): along the edge that moves, the shear.
                const lx = cs * qx + sn * qy, ly = -sn * qx + cs * qy;
                if (du === 0) P.kx = clamp(lx / (t0.sy * dv), -10, 10);
                else P.ky = clamp(ly / (t0.sx * du), -10, 10);
            } else {
                // (R·Shear)⁻¹ (q - anchor) = Scale·(h - a).
                const kx = t0.kx || 0, ky = t0.ky || 0;
                const B = { a: cs - sn * ky, b: sn + cs * ky, c: cs * kx - sn, d: sn * kx + cs, e: 0, f: 0 };
                const inv = D.invertM(B);
                if (!inv) return;
                const [lx, ly] = D.applyM(inv, qx, qy);
                let sx = du ? lx / du : t0.sx, sy = dv ? ly / dv : t0.sy;
                if (e.shiftKey && du && dv) {
                    const k = (lx * t0.sx * du + ly * t0.sy * dv) / ((t0.sx * du) ** 2 + (t0.sy * dv) ** 2);
                    sx = t0.sx * k; sy = t0.sy * k;
                }
                const minX = 1 / Math.max(1, src.w), minY = 1 / Math.max(1, src.h);
                P.sx = Math.abs(sx) < minX ? (sx < 0 ? -minX : minX) : sx;
                P.sy = Math.abs(sy) < minY ? (sy < 0 ? -minY : minY) : sy;
            }
            // The anchor stays where it was.
            const At = D.applyM(D.tfMatrix({ ...P, tx: 0, ty: 0 }), a[0], a[1]);
            P.tx = Pa[0] - At[0];
            P.ty = Pa[1] - At[1];
        }
        tf.p = P;
        this._tfShowSoon();
    }

    _tfShowSoon() {
        if (this._tfRaf) return;
        this._tfRaf = this.d.defaultView.requestAnimationFrame(() => { this._tfRaf = 0; this._tfShow(false); });
    }

    /** The layer as the session's transform makes it: at the nearest pixel (while dragging) or resampled. */
    _tfShow(smooth) {
        const tf = this.tf;
        if (!tf) return;
        if (this._tfRaf) { this.d.defaultView.cancelAnimationFrame(this._tfRaf); this._tfRaf = 0; }
        const { L, src, p } = tf;
        if (!smooth && !D.tfIsMove(p) && this._drag && this._drag.kind === "tf" && this._previewK() > 1) {
            // Dragged on a big picture: only the preview, at 1/k (the layer itself when let go).
            this._previewTransform(tf);
            tf.smooth = false;
            this.drawOverlay();
            this._tfFieldsRefresh();
            return;
        }
        this._pvOver = null;
        if (D.tfIsMove(p)) {
            const x = Math.round(p.tx - p.cx), y = Math.round(p.ty - p.cy);
            this.pix.set(L.id, src.px);
            Object.assign(L, { x, y, w: src.w, h: src.h });
            if (src.mask) {
                this.masks.set(L.id, src.mask.m);
                L.mask = { ...L.mask, x: src.mask.x + x - src.x, y: src.mask.y + y - src.y, w: src.mask.w, h: src.mask.h };
            }
        } else {
            const m = D.tfMatrix(p), box = D.tfBox(m, src.w, src.h);
            if (box.w > D.MAX_SIDE * 2 || box.h > D.MAX_SIDE * 2) return;      // far too big to be meant
            this.pix.set(L.id, D.tfPixels(src.px, src.w, src.h, m, box, smooth));
            Object.assign(L, { x: box.x, y: box.y, w: box.w, h: box.h });
            if (src.mask) {
                const mk = src.mask, ox = mk.x - src.x, oy = mk.y - src.y;
                const mm = { ...m, e: m.e + m.a * ox + m.c * oy, f: m.f + m.b * ox + m.d * oy };
                const mb = D.tfBox(mm, mk.w, mk.h);
                this.masks.set(L.id, D.tfMask(mk.m, mk.w, mk.h, mm, mb, mk.fill));
                L.mask = { ...L.mask, x: mb.x, y: mb.y, w: mb.w, h: mb.h };
            }
        }
        tf.smooth = smooth;
        this.requestRedraw();
        this.drawOverlay();
        this._tfFieldsRefresh();
    }

    /** The options bar's numbers: a change of the transform (a session begins when there is none). */
    tfSet(patch) {
        const tf = this.tf || this.tfBegin();
        if (!tf) return;
        Object.assign(tf.p, patch);
        this._tfShow(true);
    }

    tfCommit() {
        const tf = this.tf;
        if (!tf) return false;
        const p = tf.p;
        if (!tf.smooth || this._tfRaf) this._tfShow(true);
        const same = p.sx === 1 && p.sy === 1 && !(p.r % 360) && !p.kx && !p.ky && p.tx === tf.src.x + p.cx && p.ty === tf.src.y + p.cy;
        if (tf.float) return this._floatCommit(tf, same);
        if (same) {
            // Nothing changed: the layer is as it was (its own buffers), and no undo entry.
            this.tf = null;
            this.redraw();
            this.refreshProps();
            this.drawOverlay();
            return false;
        }
        this.tf = null;
        if (this.isSmart(tf.L)) {
            // Drawn again from its source: canvas -> canvas is the session's matrix after where the drawn layer was.
            const m = D.tfMatrix(p), S = tf.src;
            this._smartAfterSession(tf.L, [m.a, m.c, m.e - m.a * S.x - m.c * S.y, m.b, m.d, m.f - m.b * S.x - m.d * S.y, 0, 0, 1], S);
            this.redraw();
        }
        const before = tf.before, after = this._snap();
        this._push({ label: D.tfIsMove(p) ? "Move" : "Transform", undo: () => this._restore(before), redo: () => this._restore(after),
                     bytes: this._snapBytes(before, after) });
        this._afterHistory();
        this._thumbsSoon();
        return true;
    }

    tfCancel() {
        const tf = this.tf;
        if (!tf) return;
        if (this._tfRaf) { this.d.defaultView.cancelAnimationFrame(this._tfRaf); this._tfRaf = 0; }
        this.tf = null;
        this._restore(tf.before);
        this._afterHistory();
    }

    // Transform selection: the selected pixels of the active layer are lifted onto a floating layer of their own
    // (cut out where they were), transformed by the same session as a layer, and laid back down into the
    // layer when it is applied - with the selection moved the same way. One undo step for all of it; Esc
    // puts everything back as it was.

    _floatBegin() {
        const L = this._tfLayer();
        if (!L) return null;
        if (!this.sel) { this._notify("Transform selection: select the pixels to move first.", "info"); return null; }
        if (this.isSmart && this.isSmart(L)) { this._notify(`${L.name} is a smart layer: rasterize it to transform a part of it.`, "warn"); return null; }
        const W = this.doc.w, H = this.doc.h;
        const m = D.maskForLayer(this.sel, W, H, L);
        let x0 = L.w, y0 = L.h, x1 = -1, y1 = -1;
        for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) if (m[y * L.w + x]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (x1 < 0) { this._notify("Transform selection: the selection holds nothing of this layer.", "info"); return null; }
        const before = this._snap();
        const px = this.pix.get(L.id), fw = x1 - x0 + 1, fh = y1 - y0 + 1;
        const fl = new Uint8ClampedArray(fw * fh * 4), rest = new Uint8ClampedArray(px);
        const selCrop = new Uint8Array(fw * fh);
        let any = false;
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
            const i = (y + y0) * L.w + x + x0, o = y * fw + x, t = m[i] / 255;
            selCrop[o] = m[i];
            const a = px[i * 4 + 3];
            fl[o * 4] = px[i * 4]; fl[o * 4 + 1] = px[i * 4 + 1]; fl[o * 4 + 2] = px[i * 4 + 2];
            fl[o * 4 + 3] = D.q8((a / 255) * t);
            rest[i * 4 + 3] = D.q8((a / 255) * (1 - t));
            if (fl[o * 4 + 3]) any = true;
        }
        if (!any) { this._notify("Transform selection: the selected part of this layer is empty.", "info"); return null; }
        const F = { id: D.newId(), kind: "pixel", name: `${L.name} (floating)`, visible: true, opacity: 1, blend: "normal", locked: false,
                    x: L.x + x0, y: L.y + y0, w: fw, h: fh };
        if (L.parent) F.parent = L.parent;
        if (L.clip) F.clip = true;
        this.pix.set(L.id, rest);
        this.pix.set(F.id, fl);
        this.doc.layers.splice(D.layerIndex(this.doc, L.id) + 1, 0, F);
        this.doc.active = F.id;
        this.picked = new Set([F.id]);
        this.sel = null;                                  // the box stands for it while it floats
        const src = { px: fl, x: F.x, y: F.y, w: fw, h: fh, mask: null };
        this.tf = { L: F, src, p: D.tfIdentity(F.x, F.y, fw, fh), before, smooth: true, float: { base: L.id, selCrop } };
        this._selChanged();
        this.redraw();
        this.refreshPanels();
        this.drawOverlay();
        return this.tf;
    }

    /** The floating pixels laid into the layer they came from, the selection moved with them: one undo step. */
    _floatCommit(tf, same) {
        this.tf = null;
        if (same) { this._restore(tf.before); this._afterHistory(); return false; }
        const F = tf.L, B = this.doc.layers.find((x) => x.id === tf.float.base);
        if (!B) { this._restore(tf.before); this._afterHistory(); return false; }
        this._mergeInto(F, B);
        // The selection: the cut-out one under the same matrix, back into the canvas.
        const W = this.doc.w, H = this.doc.h, m = D.tfMatrix(tf.p), S = tf.src;
        const box = D.tfBox(m, S.w, S.h), sm = D.tfMask(tf.float.selCrop, S.w, S.h, m, box, 0);
        const sel = new Uint8Array(W * H);
        for (let y = 0; y < box.h; y++) {
            const gy = box.y + y;
            if (gy < 0 || gy >= H) continue;
            for (let x = 0; x < box.w; x++) {
                const gx = box.x + x;
                if (gx >= 0 && gx < W) sel[gy * W + gx] = sm[y * box.w + x];
            }
        }
        this.sel = sel.some((v) => v) ? sel : null;
        const before = tf.before, after = this._snap();
        this._push({ label: D.tfIsMove(tf.p) ? "Move selection" : "Transform selection", undo: () => this._restore(before), redo: () => this._restore(after),
                     bytes: this._snapBytes(before, after) });
        this._afterHistory();
        this._thumbsSoon();
        return true;
    }

    /** The transform's numbers, for the options bar and Properties: kept in step while a handle moves. */
    _tfFields(box) {
        const deg = (k) => Math.round(Math.atan(k || 0) * 1800 / Math.PI) / 10;
        const r1 = (v) => Math.round(v * 10) / 10;
        const rows = [
            ["X", (p) => r1(p.tx), (v) => ({ tx: v }), "The layer's middle, across"],
            ["Y", (p) => r1(p.ty), (v) => ({ ty: v }), "The layer's middle, down"],
            ["W %", (p) => r1(p.sx * 100), (v) => ({ sx: (v || 0.1) / 100 }), "Width, % of the layer's"],
            ["H %", (p) => r1(p.sy * 100), (v) => ({ sy: (v || 0.1) / 100 }), "Height, % of the layer's"],
            ["Angle °", (p) => r1(p.r), (v) => ({ r: v }), "Rotation, clockwise"],
            ["Shear H °", (p) => deg(p.kx), (v) => ({ kx: Math.tan(clamp(v, -84, 84) * Math.PI / 180) }), "Horizontal shear"],
            ["Shear V °", (p) => deg(p.ky), (v) => ({ ky: Math.tan(clamp(v, -84, 84) * Math.PI / 180) }), "Vertical shear"],
        ];
        this._tfInputs = (this._tfInputs || []).filter((x) => x.inp.isConnected);
        for (const [label, get, set, title] of rows) {
            const inp = this.el("input", "", { type: "number", step: "any", title });
            inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
            inp.addEventListener("change", () => { const v = Number(inp.value); if (Number.isFinite(v)) this.tfSet(set(v)); });
            this._tfInputs.push({ inp, get });
            this._field(box, label, inp);
        }
        const go = this.el("button", "paint-btn on", { type: "button", text: "Apply (Enter)", disabled: !this.tf });
        go.addEventListener("click", () => this.tfCommit());
        const no = this.el("button", "paint-btn", { type: "button", text: "Cancel (Esc)", disabled: !this.tf });
        no.addEventListener("click", () => this.tfCancel());
        box.append(go, no);
        this._tfFieldsRefresh();
    }

    _tfFieldsRefresh() {
        const g = this._tfGeom();
        for (const { inp, get } of this._tfInputs || []) {
            if (!inp.isConnected) continue;
            inp.disabled = !g;
            if (g && inp !== inp.ownerDocument.activeElement && (!inp.getRootNode || inp.getRootNode().activeElement !== inp)) inp.value = get(g.p);
        }
    }

    /** What the Move tool moves when it is more than one layer's transform: every pixel layer (and mask)
     * of the picked layers and groups. Null when it is one layer (the transform does that). */
    _moveSet() {
        const P = this.pickedLayers();
        if (!P.length || (P.length === 1 && P[0].kind !== "group")) return null;
        return D.withInside(this.doc, P.map((L) => L.id));
    }

    _shiftLayers(set, dx, dy, from = null) {
        for (const L of set) {
            const f = from ? from.get(L.id) : null;
            if (L.kind === "pixel") { L.x = (f ? f.x : L.x) + dx; L.y = (f ? f.y : L.y) + dy; }
            if (L.mask) { L.mask.x = (f ? f.mx : L.mask.x) + dx; L.mask.y = (f ? f.my : L.mask.y) + dy; }
        }
    }

    nudge(dx, dy) {
        if (this.tool === "tfsel" && !this.tf && !this.tfBegin({ float: true })) return;
        if (this.tf) { this.tf.p.tx += dx; this.tf.p.ty += dy; this._tfShow(true); return; }
        const set = this._moveSet();
        if (set) {
            if (set.some((x) => x.locked)) { this._notify("A locked layer is not moved.", "warn"); return; }
            this.change("Nudge", () => this._shiftLayers(set, dx, dy));
            return;
        }
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
        if (this._pathToolKey(e, take)) return true;
        if (this._penKey(e, take)) return true;
        // \ (AltGr+ß on a German keyboard, so Ctrl+Alt may come with it; or the key where US has it, # there).
        if (k === "\\" || (e.code === "Backslash" && !ctrl && !e.altKey)) return take(() => this.toggleViewMask(e.shiftKey));
        if (ctrl) {
            if (lk === "z" && e.shiftKey) return take(() => this.redo());
            if (lk === "z" || lk === "y") return take(() => (lk === "y" ? this.redo() : this.undo()));
            if (lk === "a" && e.altKey) return take(() => this.pickAll());
            if (lk === "a") return take(() => this.selectAll());
            if (lk === "g" && e.altKey) return take(() => this.toggleClip());
            if (lk === "g") return take(() => (e.shiftKey ? this.ungroup() : this.groupLayers()));
            if (lk === "d") return take(() => this.deselect());
            if (lk === "i" && e.shiftKey) return take(() => this.invertSelection());
            if (lk === "j") return take(() => this.duplicateLayer());
            if (lk === "c" && !e.altKey) return take(() => this.copy(e.shiftKey));
            if (lk === "x" && !e.altKey && !e.shiftKey) return take(() => this.cut());
            if (lk === "x" && e.shiftKey && !e.altKey) return take(() => this.setTool("liquify"));
            // Not prevented: the browser's paste event must still come (it carries the system clipboard's picture).
            if (lk === "v" && !e.altKey) { this.pasteKey(e.shiftKey); return true; }
            if (lk === "e") return take(() => this.mergeDown());
            if (lk === "n" && e.shiftKey) return take(() => this.newLayer());
            if (lk === "s") return take(() => (e.shiftKey ? this.host.saveAs && this.host.saveAs() : this.host.save && this.host.save()));
            if (lk === "o") return take(() => this.host.open && this.host.open());
            if (lk === "t") return take(() => { this.setTool("move"); this.tfBegin(); });
            if (lk === "r" && !e.shiftKey && !e.altKey) return take(() => this.toggleRulers());
            if (e.code === "Semicolon") return take(() => (e.shiftKey ? this.toggleSnap() : this.toggleGuides()));
            if (k === "0") return take(() => this.fit());
            if (k === "1") return take(() => this.zoomTo(1));
            if (k === "=" || k === "+") return take(() => this.zoomTo(this.view.zoom * 1.25));
            if (k === "-") return take(() => this.zoomTo(this.view.zoom / 1.25));
            return false;
        }
        if (lk === "b" && !e.altKey && !e.shiftKey) return take(() => this._bKey(e));
        if (k === " ") { e.preventDefault(); if (!this._space) { this._space = true; this.wrap.style.cursor = "grab"; } return true; }
        if (k === "F5" && e.shiftKey) return take(() => this.openFill());
        if (k === "Enter" && this.crop) return take(() => this.applyCrop());
        if (k === "Enter" && this.tf) return take(() => this.tfCommit());
        if (k === "Enter" && this.wp) return take(() => this.wpCommit());
        if (k === "Enter" && this.lq) return take(() => this.lqCommit());
        if (k === "Escape") return take(() => {
            if (this.wp) this.wpCancel();
            else if (this.lq) this.lqCancel();
            else if (this._fillOpen) this.closeFill();
            else if (this.viewMask) this.setViewMask(null);
            else if (this.tf) this.tfCancel();
            else if (this.crop) { this.crop = null; this.drawOverlay(); }
            else if (this.sel) this.deselect();
        });
        if ((k === "Delete" || k === "Backspace") && this._layersFocus && !e.altKey) {
            // In the Layers panel: the layer (or its mask, when that is what is picked) goes.
            const L = this.active();
            return take(() => (L && L.mask && this.editMask ? this.maskCmd("delete") : this.deleteLayer()));
        }
        if (k === "Delete" || k === "Backspace") return take(() => (e.altKey ? this.fillSelection(this.fg) : this.clearSelection()));
        if (k.startsWith("Arrow") && (this.tool === "move" || (this.tool === "tfsel" && (this.tf || this.sel)))) {
            const s = e.shiftKey ? 10 : 1;
            return take(() => this.nudge(k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0, k === "ArrowUp" ? -s : k === "ArrowDown" ? s : 0));
        }
        if (k === "[" || k === "]") {
            const o = this.opts[BRUSHES.includes(this.tool) || this.tool === "liquify" ? this.tool : "brush"];
            return take(() => {
                if (e.shiftKey) o.hardness = clamp(o.hardness + (k === "]" ? 10 : -10), 0, 100);
                else o.size = clamp(Math.round(o.size * (k === "]" ? 1.2 : 1 / 1.2) + (k === "]" ? 1 : -1)), 1, 2000);
                this.refreshProps(); this.drawOverlay();
            });
        }
        if (lk === "q" && !e.altKey && !e.shiftKey) return take(() => this.toggleQuickMask());
        if (lk === "x" && !e.altKey) return take(() => this.swapColors());
        if (lk === "d" && !e.altKey) return take(() => this.defaultColors());
        if (lk === "m" && e.shiftKey) return take(() => this.setTool("ellipse"));
        if (lk === "v" && e.shiftKey && !e.altKey) return take(() => this.setTool(this.tool === "tfsel" ? "move" : "tfsel"));
        if (lk === "g" && e.shiftKey && !e.altKey) return take(() => this.setTool(this.tool === "gradient" ? "fill" : "gradient"));
        if (lk === "r" && e.shiftKey && !e.altKey) return take(() => this.setTool(this.tool === "blur" ? "smudge" : "blur"));
        if (lk === "o" && e.shiftKey && !e.altKey) return take(() => this.setTool({ dodge: "burn", burn: "sponge", sponge: "dodge" }[this.tool] || "burn"));
        if (lk === "u" && e.shiftKey && !e.altKey) return take(() => {
            const s = this.opts.shape;
            if (this.tool === "shape") s.kind = SHAPE_KINDS[(SHAPE_KINDS.indexOf(s.kind) + 1) % SHAPE_KINDS.length];
            this.setTool("shape");
        });
        if (lk === "p" && e.shiftKey && !e.altKey) return take(() => this.setTool({ pen: "penadd", penadd: "pendel", pendel: "penconv", penconv: "pen" }[this.tool] || "penadd"));
        if (lk === "a" && e.shiftKey && !e.altKey) return take(() => this.setTool(this.tool === "pathdirect" ? "pathsel" : "pathdirect"));
        if (lk === "j" && e.shiftKey && !e.altKey) return take(() => this.setTool({ spot: "heal", heal: "patch", patch: "spot" }[this.tool] || "heal"));
        if (TOOL_KEYS[lk] && !e.altKey && !e.shiftKey) return take(() => this.setTool(TOOL_KEYS[lk]));
        return false;
    }

    /**
     * B: held, a left press on the canvas and a drag change the brush's size (sideways) and opacity (up / down;
     * Shift: hardness) - Photoshop's Alt+right-drag with a key; nothing is painted. Tapped (no press while held),
     * it picks the brush on letting go, so B held on the eraser changes the eraser. With a tool that has no brush,
     * B picks the brush at once and a press while it is held then drags the brush.
     */
    _bKey(e) {
        if (e.repeat || this._bHeld || this._bd) return;
        if (!this._bdTool()) { this.setTool("brush"); this._bHeld = { tap: null, used: false }; }
        else this._bHeld = { tap: this.tool !== "brush" ? () => this.setTool("brush") : null, used: false };
        // The key's release may never come here (the window left with B down).
        const win = this.d.defaultView, held = this._bHeld;
        const off = () => { win.removeEventListener("blur", off); if (this._bHeld === held) this._bHeld = null; };
        win.addEventListener("blur", off);
    }

    keyUp(e) {
        if (this._bHeld && (e.key || "").toLowerCase() === "b") {
            const h = this._bHeld;
            this._bHeld = null;                          // a drag going on ends when the button is let go
            if (!h.used && h.tap) h.tap();
            return true;
        }
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
                { label: "Cut (Ctrl+X)", run: () => this.cut() },
                { label: "Copy (Ctrl+C)", run: () => this.copy(false) },
                { label: "Copy merged (Ctrl+Shift+C)", run: () => this.copy(true) },
                { label: "Paste (Ctrl+V)", run: () => this.pasteFromMenu(false) },
                { label: "Paste in place (Ctrl+Shift+V)", run: () => this.pasteFromMenu(true) }, "-",
                { label: "Fill… (Shift+F5)", run: () => this.openFill() },
                { label: "Fill with the colour (Alt+Del)", run: () => this.fillSelection(this.fg) },
                { label: "Fill with the second colour", run: () => this.fillSelection(this.bg) },
                { label: "Clear (Del)", disabled: !this.sel, run: () => this.clearSelection() }, "-",
                { label: "Define brush tip from the selection", disabled: !this.sel, run: () => { this.tipFromSelection(); if (!BRUSHES.includes(this.tool)) this.setTool("brush"); } },
                { label: "Brush tips / Import .abr…", run: () => { if (!BRUSHES.includes(this.tool)) this.setTool("brush"); this.pickAbr(); } }];
    }

    _selectMenu() {
        return [{ label: "All (Ctrl+A)", run: () => this.selectAll() }, { label: "Deselect (Ctrl+D)", disabled: !this.sel, run: () => this.deselect() },
                { label: "Invert (Ctrl+Shift+I)", run: () => this.invertSelection() },
                { label: "Feather…", disabled: !this.sel, run: () => this.dialog("Feather", [["radius", "Radius (px)", 8, 0.5, 500]], (v) => this.featherSelection(v.radius)) },
                { label: "From the layer's pixels", run: () => this.selectLayerAlpha() },
                { label: "Colour range…", run: () => this.colorRangeDialog() }, "-",
                ...[["expand", "Expand…", "By (px)"], ["contract", "Contract…", "By (px)"], ["smooth", "Smooth…", "Radius (px)"], ["border", "Border…", "Width (px)"]].map(([kind, label, what]) => (
                    { label, disabled: !this.sel, run: () => this.dialog(label.slice(0, -1), [["r", what, kind === "border" ? 6 : 4, 1, 200]], (v) => this.modifySelection(kind, v.r)) })), "-",
                { label: "Foreground", run: () => this.host.generate && this.host.generate("select_subject", {}) },
                { label: "Objects (SAM3)…", disabled: !this.host.generateDialog, run: () => this.host.generateDialog("select_objects") }];
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
        const n = this.pickedLayers().length, grp = !!L && L.kind === "group";
        return [{ label: "New layer (Ctrl+Shift+N)", run: () => this.newLayer() },
                { label: "New group", run: () => this.newGroup() },
                { label: "Duplicate (Ctrl+J)", disabled: !L, run: () => this.duplicateLayer() },
                this._solo ? { label: "End solo (show the others again)", run: () => this.endSolo() }
                           : { label: n > 1 ? `Solo ${n} layers (Alt+click an eye)` : "Solo (Alt+click the eye)", disabled: !L, run: () => this.soloLayers(this.pickedLayers().map((x) => x.id)) },
                { label: n > 1 ? `Delete ${n} layers` : "Delete", disabled: !L, run: () => this.deleteLayer() },
                { label: n > 1 ? `Merge ${n} layers (Ctrl+E)` : grp ? "Merge group (Ctrl+E)" : "Merge down (Ctrl+E)", disabled: !L, run: () => this.mergeDown() }, "-",
                { label: n > 1 ? `Group ${n} layers (Ctrl+G)` : "Group (Ctrl+G)", disabled: !L, run: () => this.groupLayers() },
                { label: "Ungroup (Ctrl+Shift+G)", disabled: !grp, run: () => this.ungroup() },
                { label: L && L.clip ? "Release clipping mask (Ctrl+Alt+G)" : "Create clipping mask (Ctrl+Alt+G)", disabled: !L || grp, run: () => this.toggleClip() },
                { label: "Pick every layer (Ctrl+Alt+A)", run: () => this.pickAll() }, "-",
                ...adj, "-",
                { label: "Add mask (reveal all)", disabled: !L || !!L.mask, run: () => this.addMask("all") },
                { label: "Add mask from the selection", disabled: !L || !this.sel, run: () => this.addMask("selection") },
                { label: this.viewMask ? "Show the picture (\\)" : "Show the mask on the canvas (\\)", disabled: !this.viewMask && (!L || !L.mask), run: () => this.toggleViewMask() },
                { label: "Mask on / off", disabled: !L || !L.mask, run: () => this.maskCmd("toggle") },
                { label: "Invert the mask", disabled: !L || !L.mask, run: () => this.maskCmd("invert") },
                { label: "Apply the mask", disabled: !L || !L.mask || L.kind !== "pixel", run: () => this.maskCmd("apply") },
                { label: "Delete the mask", disabled: !L || !L.mask, run: () => this.maskCmd("delete") }, "-",
                { label: "Flip left-right", disabled: !L || L.kind !== "pixel", run: () => this.flipLayer("h") },
                { label: "Flip top-bottom", disabled: !L || L.kind !== "pixel", run: () => this.flipLayer("v") },
                { label: "Rotate 90° clockwise", disabled: !L || L.kind !== "pixel", run: () => this.rotateLayer(90) },
                { label: "Rotate 90° anticlockwise", disabled: !L || L.kind !== "pixel", run: () => this.rotateLayer(270) },
                { label: "Rotate 180°", disabled: !L || L.kind !== "pixel", run: () => this.rotateLayer(180) },
                { label: "Free transform (Ctrl+T)", disabled: !L || L.kind !== "pixel", run: () => { this.setTool("move"); this.tfBegin(); } },
                { label: "Transform selection (Shift+V)", disabled: !L || L.kind !== "pixel" || !this.sel, run: () => { this.setTool("tfsel"); this.tfBegin({ float: true }); } },
                { label: "Distort", disabled: !L || L.kind !== "pixel", run: () => this.wpBegin("distort") },
                { label: "Perspective", disabled: !L || L.kind !== "pixel", run: () => this.wpBegin("perspective") },
                { label: "Warp", disabled: !L || L.kind !== "pixel", run: () => this.wpBegin("warp", this.opts.warp.n) },
                { label: "Scale…", disabled: !L || L.kind !== "pixel", run: () => this.dialog("Scale layer", [["k", "Percent", 100, 1, 1600]], (v) => this.scaleLayer(v.k / 100)) },
                { label: L && L.locked ? "Unlock" : "Lock", disabled: !L, run: () => { const v = !L.locked; this.setPickedProps((x) => { x.locked = v; }, v ? "Lock" : "Unlock"); } },
                { label: L && L.lockAlpha ? "Unlock transparency" : "Lock transparency", disabled: !L || L.kind !== "pixel", run: () => this.toggleLockAlpha() }, "-",
                { label: "Layer style…", disabled: !L || L.kind !== "pixel", run: () => this.openStyle() },
                ...STYLE_KINDS.map((k) => ({ label: `  ${STYLE_LABELS[k]}`, disabled: !L || L.kind !== "pixel", run: () => this.openStyle(k) })),
                { label: "Clear layer style", disabled: !L || !L.style, run: () => this.clearStyle(L) }, "-",
                { label: "Convert to smart layer", disabled: !L || L.kind !== "pixel" || this.isSmart(L), run: () => this.convertToSmart() },
                { label: n > 1 ? `Rasterize ${n} layers` : "Rasterize (forget the smart layer's source)", disabled: !this.pickedLayers().some((x) => this.isSmart(x)), run: () => this.rasterize() },
                { label: "Edit smart layer contents…", disabled: !this.isSmart(L) || !this.host.editSmart, run: () => this.host.editSmart(L.id) },
                { label: "Reset smart layer", disabled: !this.isSmart(L), run: () => this.resetSmart() }, "-",
                { label: "Smart filters…", disabled: !L || L.kind !== "pixel", run: () => { this._smartOpen = L.id; this.refreshProps(); if (this.host.showPanel) this.host.showPanel("effects"); } },
                { label: "Bake smart filters", disabled: !L || !L.filters, run: () => this.bakeSmartFilters(L) },
                { label: "Clear smart filters", disabled: !L || !L.filters, run: () => this.clearSmartFilters(L) }];
    }

    _filterMenu() {
        const off = !this.pickedLayers().some((L) => L.kind === "pixel");
        const fd = (label, fields, run) => ({ label: label + "…", disabled: off, run: () => this.filterDialog(label, fields, run) });
        const own = (id) => fd(FILTERS[id].label, FILTERS[id].fields, FILTERS[id].run);
        const sm = this._smartMenu().map((it) => ({ ...it, label: it.label.replace(/^Smart /, "Smart filter: ") }));
        return [{ label: "Liquify… (Shift+Ctrl+X)", disabled: !this.active() || this.active().kind !== "pixel", run: () => this.lqBegin() }, "-",
                ...sm.slice(0, 2), { label: "Smart filter: an adjustment…", disabled: sm[0].disabled, run: () => this.smartAdjustDialog() }, "-",
                fd("Gaussian blur", [["radius", "Radius (px)", 4, 0.1, 250]], (px, w, h, v) => D.blurPixels(px, w, h, v.radius)),
                own("motion_blur"), "-",
                fd("Sharpen", [["radius", "Radius (px)", 2, 0.1, 100], ["amount", "Amount", 1, 0, 10]], (px, w, h, v) => D.sharpenPixels(px, w, h, v.radius, v.amount)),
                own("unsharp"), own("high_pass"), "-",
                own("median"), own("noise"), own("pixelate"),
                "-", ...D.ADJUST_TYPES.map((t) => (t === "invert"
                    ? { label: D.ADJUST_LABELS[t] + " (into the pixels)", disabled: off, run: () => this.filter(t, {}) }
                    : { label: D.ADJUST_LABELS[t] + " (into the pixels)…", disabled: off, run: () => this.adjustPixelsDialog(t) }))];
    }

    _generateMenu() {
        const g = (kind) => () => this.host.generate && this.host.generate(kind, { prompt: this._prompt || "", variations: this._variations || 1 });
        return [{ label: "Generative fill (the selection, with the prompt)", run: g("fill") },
                { label: "Remove object (the selection)", run: g("remove") },
                { label: "Edit with the prompt (the selection, else the picture)", run: g("edit") },
                { label: "Fill from the surroundings (here, no AI)", disabled: !this.sel, run: g("heal") },
                { label: "Remove background", run: g("background") },
                { label: "Select foreground", run: g("select_subject") },
                { label: "Select objects (SAM3)…", disabled: !this.host.generateDialog, run: () => this.host.generateDialog("select_objects") },
                { label: "Extend empty areas (around the layer)", run: () => this.extendEmpty() },
                { label: "Extend the canvas…", run: () => this.dialog("Extend the canvas", [["px", "Pixels each side", 128, 1, 4096], ["ai", "Fill the new part with the workflow", "yes", ["yes", "no"]]],
                     (v) => this.host.generate && this.host.generate("extend", { px: v.px, ai: v.ai === "yes", prompt: this._prompt || "", variations: this._variations || 1 })) },
                { label: "Upscale…", run: () => (this.host.generateDialog ? this.host.generateDialog("upscale")
                    : this.dialog("Upscale", [["k", "Times", "2", ["2", "4"]], ["ai", "With the workflow (else a plain resize)", "yes", ["yes", "no"]]],
                     (v) => this.host.generate && this.host.generate("upscale", { k: Number(v.k), ai: v.ai === "yes" }))) },
                "-",
                { label: "Generate panel (prompt, variations)", disabled: !this.host.showPanel, run: () => this.host.showPanel("generate") },
                { label: "Workflows…", disabled: !this.host.workflows, run: () => this.host.workflows && this.host.workflows() }];
    }

    /**
     * A small form over the editor: fields [key, label, default, min, max], [key, label, default, [choices]] or
     * [key, label, default, "text"]; a choice is a string or { value, label }.
     */
    dialog(title, fields, onOk, note = "", opts = {}) {
        const shade = this.el("div", "paint-dlg-shade");
        const box = this.el("div", "paint-dlg" + (opts.wide ? " wide" : ""));
        box.append(this.el("h3", "", { text: title }));
        const inputs = {};
        for (const [k, label, def, a, b] of fields) {
            const row = this.el("div", "paint-field");
            row.append(this.el("label", "", { text: label }));
            let inp;
            if (Array.isArray(a)) {
                inp = this.el("select");
                for (const c of a) {
                    inp.append(typeof c === "object" ? this.el("option", "", { value: c.value, text: c.label })
                                                     : this.el("option", "", { value: c, text: c.replace(/_/g, " ") }));
                }
                inp.value = def;
            } else if (a === "text") inp = this.el("input", "", { type: "text", value: def, spellcheck: false });
            else inp = this.el("input", "", { type: "number", value: def, min: a, max: b, step: "any" });
            inputs[k] = inp;
            // A number with a range: a slider beside it too, so that it can be dragged (and the preview follows the drag).
            if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && b > a) {
                const st = dialogStep(a, b);
                const r = this.el("input", "paint-dlg-range", { type: "range", min: a, max: b, step: st, value: def });
                r.addEventListener("input", () => { inp.value = String(roundTo(Number(r.value), st)); inp.dispatchEvent(new Event("input")); });
                r.addEventListener("change", () => inp.dispatchEvent(new Event("change")));
                inp.addEventListener("input", () => { if (inp.value !== "" && Number.isFinite(Number(inp.value))) r.value = inp.value; });
                row.append(r);
            }
            row.append(inp);
            box.append(row);
        }
        if (note) box.append(this.el("div", "note", { text: note }));
        let prev = null, beforeBtn = null;
        if (opts.preview) {
            const row = this.el("div", "paint-field");
            prev = this.el("input", "", { type: "checkbox", checked: true });
            // Held: the picture without the filter (the preview comes back when let go).
            beforeBtn = this.el("button", "paint-btn", { type: "button", text: "Before", title: "Hold to see the picture without it" });
            row.append(this.el("label", "", { text: "Preview" }), prev, beforeBtn);
            box.append(row);
        }
        const go = this.el("div", "go");
        const resetBtn = opts.preview ? this.el("button", "paint-btn", { text: "Reset", type: "button", title: "Every number back to where it started" }) : null;
        const cancel = this.el("button", "paint-btn", { text: "Cancel", type: "button" });
        const ok = this.el("button", "paint-btn on", { text: "OK", type: "button" });
        const read = () => {
            const v = {};
            for (const [k, , def, a, b] of fields) {
                const inp = inputs[k];
                v[k] = Array.isArray(a) || a === "text" ? inp.value : D.num(inp.value, def, a, b);
            }
            return v;
        };
        let over = false;
        const close = (cancelled = true) => { if (over) return; over = true; shade.remove(); if (cancelled && opts.onCancel) opts.onCancel(); };
        const done = () => { const v = read(); close(false); onOk(v); };
        if (opts.onInput) {
            const tell = () => opts.onInput(read(), prev ? prev.checked : true);
            for (const inp of [...Object.values(inputs), ...(prev ? [prev] : [])]) { inp.addEventListener("input", tell); inp.addEventListener("change", tell); }
            setTimeout(tell, 0);
        }
        if (beforeBtn && opts.onInput) {
            beforeBtn.addEventListener("pointerdown", () => opts.onInput(read(), false));
            for (const ev of ["pointerup", "pointerleave", "pointercancel"]) beforeBtn.addEventListener(ev, () => opts.onInput(read(), prev.checked));
        }
        if (resetBtn) {
            resetBtn.addEventListener("click", () => {
                for (const [k, , def] of fields) { inputs[k].value = def; inputs[k].dispatchEvent(new Event("input")); }
            });
        }
        cancel.addEventListener("click", () => close());
        ok.addEventListener("click", done);
        box.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); done(); } else if (e.key === "Escape") close(); });
        if (resetBtn) go.append(resetBtn);
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
        for (const m of D.GROUP_BLENDS) this.blendSel.append(this.el("option", "", { value: m, text: D.BLEND_LABELS[m] }));
        this.blendSel.addEventListener("change", () => {
            const v = this.blendSel.value;
            this.setPickedProps((L) => {
                if (L.kind === "adjust" || (v === "pass_through" && L.kind !== "group")) return false;
                L.blend = v;
            }, "Blend mode");
        });
        this.opRange = this.el("input", "", { type: "range", min: 0, max: 100, step: 1, title: "Opacity" });
        this.opNum = this.el("input", "", { type: "number", min: 0, max: 100, step: 1, title: "Opacity %" });
        const setOp = (v, end) => {
            const L = this.active();
            if (!L) return;
            this.liveBegin();
            const o = clamp(Number(v) / 100, 0, 1);
            for (const X of this.pickedLayers()) X.opacity = o;
            this.opRange.value = this.opNum.value = Math.round(o * 100);
            this.requestRedraw();
            if (end) this.liveEnd("Opacity");
        };
        this.opRange.addEventListener("input", () => setOp(this.opRange.value, false));
        this.opRange.addEventListener("change", () => setOp(this.opRange.value, true));
        this.opNum.addEventListener("change", () => setOp(this.opNum.value, true));
        this.lockBtn = this.btn("lockOpen", "Lock the layer", () => {
            const L = this.active();
            if (!L) return;
            const v = !L.locked;
            this.setPickedProps((X) => { X.locked = v; }, v ? "Lock" : "Unlock");
        });
        this.lockAlphaBtn = this.btn("lockAlpha", "Lock transparent pixels: paint only where the layer has something", () => this.toggleLockAlpha());
        head.append(this.blendSel, this.el("span", "", { text: "Opacity" }), this.opRange, this.opNum, this.lockAlphaBtn, this.lockBtn);
        this.layerList = this.el("div", "paint-list");
        const foot = this.el("div", "paint-lfoot");
        foot.append(this.btn("plus", "New layer (Ctrl+Shift+N)", () => this.newLayer()),
                    this.btn("folderPlus", "New group (with several layers picked: group them, Ctrl+G)", () => (this.pickedLayers().length > 1 ? this.groupLayers() : this.newGroup())),
                    this.btn("adjust", "New adjustment layer", (e, b) => this._menu(b, D.ADJUST_TYPES.map((t) => ({ label: D.ADJUST_LABELS[t], run: () => this.addAdjustment(t) })))),
                    this.btn("mask", "Add a mask (from the selection, with one)", () => this.addMask(this.sel ? "selection" : "all")),
                    (this.dupBtn = this.btn("copy", "Duplicate (Ctrl+J) - or drag layers onto it", () => this.duplicateLayer())),
                    this.btn("mergeDown", "Merge down (Ctrl+E)", () => this.mergeDown()),
                    (this.trashBtn = this.btn("trash", "Delete the picked layers (or the picked masks) - or drag layers or masks onto it",
                                              () => (this.pickedMasks().length ? this.maskCmd("delete") : this.deleteLayer()))));
        // A row dragged onto Duplicate or Delete: those layers copied / taken away (Photoshop's way).
        for (const [b, act] of [[this.dupBtn, "dup"], [this.trashBtn, "del"]]) {
            // Masks (a mask thumbnail dragged) go only onto Delete.
            b.addEventListener("dragover", (e) => {
                if (!this._rowDrag && !(this._maskDrag && act === "del")) return;
                e.preventDefault(); e.dataTransfer.dropEffect = act === "dup" ? "copy" : "move"; b.classList.add("drop-hot");
            });
            b.addEventListener("dragleave", () => b.classList.remove("drop-hot"));
            b.addEventListener("drop", (e) => {
                e.preventDefault(); e.stopPropagation();
                b.classList.remove("drop-hot");
                const ids = this._rowDrag, masks = this._maskDrag;
                this._rowDrag = null; this._maskDrag = null;
                if (masks && masks.length && act === "del") this.deleteMasks(masks);
                else if (ids && ids.length) this.dropOnButton(ids, act);
            });
        }
        p.append(head, this.layerList, foot);
        // Del / Backspace act on the layer while the Layers panel was the last thing pressed.
        p.addEventListener("pointerdown", () => { this._layersFocus = true; }, true);
        return p;
    }

    refreshPanels() { this.refreshLayers(); this.refreshProps(); }

    /** The Layers panel's rows, top first: {L, depth}, without what is in a folded group. */
    _panelRows() {
        const d = this.doc;
        if (!d) return [];
        const kids = D.childIndexes(d);
        const out = [];
        const walk = (key, depth) => {
            const list = kids.get(key) || [];
            for (let k = list.length - 1; k >= 0; k--) {
                const L = d.layers[list[k]];
                out.push({ L, depth });
                if (L.kind === "group" && !L.collapsed) walk(L.id, depth + 1);
            }
        };
        walk("", 0);
        return out;
    }

    refreshLayers() {
        const list = this.layerList;
        if (!list) return;
        list.replaceChildren();
        const d = this.doc;
        const L0 = this.active();
        for (const el of [this.blendSel, this.opRange, this.opNum]) el.disabled = !L0;
        if (!d) { list.append(this.el("div", "paint-note", { text: "Open a picture in Paint to see its layers." })); return; }
        if (L0) {
            // Pass Through is a group's only.
            for (const o of this.blendSel.options) o.hidden = o.value === "pass_through" && L0.kind !== "group";
            this.blendSel.value = L0.blend;
            this.blendSel.disabled = L0.kind === "adjust";
            this.opRange.value = this.opNum.value = Math.round(L0.opacity * 100);
            this.lockBtn.replaceChildren(paintIcon(this.d, L0.locked ? "lock" : "lockOpen"));
            this.lockBtn.classList.toggle("on", !!L0.locked);
            this.lockAlphaBtn.classList.toggle("on", !!L0.lockAlpha);
            this.lockAlphaBtn.disabled = L0.kind !== "pixel";
        }
        this._thumbJobs = [];
        const many = this.pickedLayers().length > 1;
        // The bases of clipping masks (their names underlined, as the clipped rows point at them).
        const clipBases = new Set();
        for (const L of d.layers) if (L.clip) { const B = this._clipBase(L); if (B) clipBases.add(B.id); }
        for (const { L, depth } of this._panelRows()) {
            const isG = L.kind === "group";
            const row = this.el("div", "paint-row" + (L.id === d.active ? " active" : "") + (many && this.picked.has(L.id) ? " picked" : "")
                + (D.ancestors(d, L).some((P) => !P.visible) ? " dimmed" : ""));
            row.dataset.id = L.id;
            row.draggable = true;
            row.style.paddingLeft = (6 + depth * 14 + (L.clip ? 14 : 0)) + "px";
            const how = (e) => (e.shiftKey ? "range" : (e.ctrlKey || e.metaKey) ? "toggle" : null);
            const eye = this.el("span", "eye" + (L.visible ? "" : " off"), { title: L.visible ? "Hide" : "Show" });
            eye.append(paintIcon(this.d, L.visible ? "eye" : "eyeOff", 15));
            if (this._solo && this._solo.ids.includes(L.id)) { eye.classList.add("solo"); eye.title = "Soloed - Alt+click to show the others again"; }
            else eye.title += " (Alt+click: solo)";
            eye.addEventListener("click", (e) => {
                e.stopPropagation();
                // Alt+click: solo (the picked layers when this is one of them).
                if (e.altKey) { this.soloLayers(this.picked.has(L.id) && this.picked.size > 1 ? this.pickedLayers().map((x) => x.id) : [L.id]); return; }
                this._solo = null;                 // seen / hidden by hand: no going back from solo any more
                // The eye of a picked layer hides / shows every picked one.
                const v = !L.visible;
                if (this.picked.has(L.id) && this.picked.size > 1) this.setPickedProps((X) => { X.visible = v; }, v ? "Show layers" : "Hide layers");
                else this.setLayerProps(L.id, { visible: v }, v ? "Show layer" : "Hide layer");
            });
            row.append(eye);
            const caret = this.el("span", "caret" + (isG ? "" : " none"), { title: isG ? (L.collapsed ? "Open the group" : "Fold the group") : "" });
            if (isG) {
                caret.append(paintIcon(this.d, L.collapsed ? "chevronRight" : "chevronDown", 12));
                caret.addEventListener("click", (e) => { e.stopPropagation(); this.toggleCollapsed(L.id); });
            }
            row.append(caret);
            const selThumb = L.id === d.active && !this.editMask;
            if (L.kind === "pixel") {
                const th = this.el("canvas", selThumb ? "sel" : "", { width: 40, height: 30, title: "The layer's pixels" });
                th.title = "The layer's pixels (Ctrl+click: select them; Ctrl+Shift: add, Ctrl+Alt: take away)";
                th.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (e.ctrlKey || e.metaKey) { this.loadSelection(L, false, e.shiftKey ? "add" : e.altKey ? "subtract" : "replace"); return; }
                    this.setActive(L.id, false, how(e));
                });
                this._thumbJobs.push([th, L, false]);
                row.append(th);
            } else if (isG) {
                const g = this.el("span", "grp" + (selThumb ? " sel" : ""), { title: `Group (${D.BLEND_LABELS[L.blend]}) - double-click the arrow or click it to fold` });
                g.append(paintIcon(this.d, "folder", 18));
                row.append(g);
            } else {
                const a = this.el("span", "adj" + (selThumb ? " sel" : ""), { title: D.ADJUST_LABELS[L.adjust.type] });
                a.append(paintIcon(this.d, "adjust", 18));
                row.append(a);
            }
            if (L.mask) {
                const maskPicked = this.editMask && (L.id === d.active || (this.picked.has(L.id) && !!(this.active() || {}).mask));
            const mt = this.el("canvas", maskPicked ? "sel" : "", { width: 40, height: 30,
                    title: "The mask: click to paint on it (white shows, black hides); Shift+click switches it off" });
                if (!L.mask.enabled) mt.style.opacity = ".35";
                mt.title = "The mask: click to paint on it (white shows, black hides); Shift+click switches it off; Alt+click (or \\) shows it on the canvas to paint on; Ctrl+click selects it; Ctrl / Shift+click other rows picks their masks too; drag onto the trash to delete";
                mt.draggable = true;
                mt.addEventListener("dragstart", (e) => {
                    // The mask alone (or every picked mask when it is one of them) - not the layer.
                    e.stopPropagation();
                    const many = maskPicked ? this.pickedMasks().map((X) => X.id) : [];
                    this._maskDrag = many.length ? many : [L.id];
                    this._rowDrag = null;
                    e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", L.name + " mask");
                });
                mt.addEventListener("dragend", (e) => { e.stopPropagation(); this._maskDrag = null; });
                mt.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const ctrl = e.ctrlKey || e.metaKey;
                    if (ctrl) { this.loadSelection(L, true, e.shiftKey ? "add" : e.altKey ? "subtract" : "replace"); return; }
                    if (e.altKey) { this.setActive(L.id, true); this.setViewMask(this.viewMask === L.id ? null : L.id); return; }
                    if (e.shiftKey) { this.setActive(L.id); this.maskCmd("toggle"); return; }
                    this.setActive(L.id, true);
                });
                this._thumbJobs.push([mt, L, true]);
                row.append(mt);
            }
            if (L.clip) row.insertBefore(this.el("span", "clipmark", { text: "↳", title: "Clipped to the layer under it (Alt+click releases it)" }), eye.nextSibling);
            const nm = this.el("span", "nm" + (clipBases.has(L.id) ? " base" : ""), { text: L.name, title: "Double-click to rename" });
            row.append(nm);
            if (L.text) row.append(this.el("span", "tag", { text: "T" }));
            if (L.blend !== "normal" && !(isG && L.blend === "pass_through")) row.append(this.el("span", "tag", { text: D.BLEND_LABELS[L.blend].split(" ")[0] }));
            if (L.style) {
                const fx = this.el("span", "tag fx", { text: "fx", title: "Layer style: click to change it" });
                fx.addEventListener("click", (e) => { e.stopPropagation(); this.setActive(L.id); this.openStyle(); });
                row.append(fx);
            }
            if (this.isSmart(L)) {
                const so = this.el("span", "tag so", { text: "smart", title: `A smart layer: drawn from its ${L.smart.sw} x ${L.smart.sh} source, so a transform keeps its detail` });
                so.addEventListener("click", (e) => { e.stopPropagation(); this.setActive(L.id); if (this.host.showPanel) this.host.showPanel("props"); });
                row.append(so);
            }
            if (L.filters) {
                const sf = this.el("span", "tag sf", { text: "sf", title: "Smart filters: click to change them" });
                sf.addEventListener("click", (e) => { e.stopPropagation(); this.setActive(L.id); this._smartOpen = L.id; this.refreshProps(); if (this.host.showPanel) this.host.showPanel("effects"); });
                row.append(sf);
            }
            if (L.lockAlpha) { const la = this.el("span", "lk la", { title: "Transparency locked" }); la.append(paintIcon(this.d, "lockAlpha", 12)); row.append(la); }
            if (L.locked) { const lk = this.el("span", "lk"); lk.append(paintIcon(this.d, "lock", 12)); row.append(lk); }
            row.addEventListener("click", (e) => {
                // A double-click on the name renames. Counted here, not by dblclick: the first click can draw
                // the list again, and the second one then lands on a new row.
                const now = Date.now(), last = this._rowClick;
                this._rowClick = { id: L.id, t: now };
                const onName = e.target && e.target.closest && e.target.closest(".nm");
                if (e.altKey && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                    // Alt+click: clip this layer to the one under it, or release it.
                    if (L.kind === "group") { this._notify("A group is not clipped; clip the layers above it to it.", "info"); return; }
                    if (!L.clip && !this._clipBase(L)) { this._notify(`${L.name} has no layer under it to clip to.`, "warn"); return; }
                    this.setLayerProps(L.id, { clip: !L.clip }, L.clip ? "Release clipping mask" : "Create clipping mask");
                    return;
                }
                const h = how(e);
                this.setActive(L.id, false, h);
                if (!h && onName && last && last.id === L.id && now - last.t < 450) {
                    this._rowClick = null;
                    const row2 = [...this.layerList.children].find((r) => r.dataset.id === L.id);
                    const nm2 = row2 && row2.querySelector(".nm");
                    const L2 = this.doc.layers.find((x) => x.id === L.id);
                    if (nm2 && L2 && !nm2.querySelector("input")) this._rename(nm2, L2);
                }
            });
            row.addEventListener("contextmenu", (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!this.picked.has(L.id)) this.setActive(L.id);
                else { this.doc.active = L.id; this.refreshPanels(); }
                if (this.host.menu) this.host.menu(this._layerMenu(), e.clientX, e.clientY, row);
            });
            // One pixel layer dragged onto the middle of another (not a group) row: it becomes that layer's mask.
            const asMask = () => {
                const ids = this._rowDrag;
                if (isG || !ids || ids.length !== 1 || ids[0] === L.id) return false;
                const S = d.layers.find((x) => x.id === ids[0]);
                return !!S && S.kind === "pixel";
            };
            const zone = (e) => {
                const r = row.getBoundingClientRect(), f = (e.clientY - r.top) / r.height;
                if (isG && f > 0.25 && f < 0.75) return "inside";
                if (f > 0.3 && f < 0.7 && asMask()) return "mask";
                return f < 0.5 ? "above" : "below";
            };
            row.addEventListener("dragstart", (e) => {
                // A picked row drags every picked layer; another row only itself.
                this._rowDrag = this.picked.has(L.id) ? this.pickedLayers().map((x) => x.id) : [L.id];
                e.dataTransfer.effectAllowed = "copyMove"; e.dataTransfer.setData("text/plain", L.name);
            });
            row.addEventListener("dragover", (e) => {
                if (!this._rowDrag) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const z = zone(e);
                row.classList.toggle("drop-above", z === "above"); row.classList.toggle("drop-below", z === "below"); row.classList.toggle("drop-inside", z === "inside");
                row.classList.toggle("drop-mask", z === "mask");
                row.title = z === "mask" ? "Drop: it becomes this layer's mask (Alt: keep the layer too)" : "";
            });
            row.addEventListener("dragleave", () => { row.classList.remove("drop-above", "drop-below", "drop-inside", "drop-mask"); row.title = ""; });
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("drop-above", "drop-below", "drop-inside", "drop-mask");
                row.title = "";
                const ids = this._rowDrag;
                let z = zone(e);
                this._rowDrag = null;
                if (!ids || ids.includes(L.id)) return;
                if (z === "mask") { this.layerToMask(ids[0], L.id, { keep: e.altKey }); return; }
                // Below an open group's row is inside it, at its top (where the list shows it).
                if (z === "below" && isG && !L.collapsed && (D.childIndexes(d).get(L.id) || []).length) z = "inside";
                this.moveLayers(ids, L.id, z);
            });
            row.addEventListener("dragend", () => { this._rowDrag = null; });
            list.append(row);
        }
        this._drawThumbs();
    }

    _rename(nm, L) {
        const inp = this.el("input", "", { type: "text", value: L.name });
        inp.addEventListener("pointerdown", (e) => e.stopPropagation());
        nm.replaceChildren(inp);
        inp.focus(); inp.select();
        let over = false;
        const done = (keep) => {
            if (over) return;
            over = true;
            const v = inp.value.trim();
            if (keep && v && v !== L.name) this.setLayerProps(L.id, { name: v.slice(0, 120) }, "Rename layer"); else this.refreshLayers();
        };
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

    /** A panel's box: one scrolling column (a press in it means the Layers panel is not the one keys go to). */
    _panelBox(cls) {
        const p = this.el("div", "paint-panel");
        const box = this.el("div", "paint-props " + cls);
        p.append(box);
        p.addEventListener("pointerdown", () => { this._layersFocus = false; }, true);
        return [p, box];
    }

    _buildPropsPart() { const [p, box] = this._panelBox("paint-props-layer"); this.propsBox = box; return p; }
    _buildToolPart() { const [p, box] = this._panelBox("paint-props-tool"); this.toolBox = box; return p; }
    _buildEffectsPart() { const [p, box] = this._panelBox("paint-props-effects"); this.effectsBox = box; return p; }

    /** Generate is built once: nothing in it depends on the document, and the prompt being typed stays put. */
    _buildGeneratePart() { const [p, box] = this._panelBox("paint-props-generate"); box.append(this._generateSection()); this.genBox = box; return p; }

    _field(parent, label, input, wide = false) {
        const row = this.el("div", "paint-field" + (wide ? " wide" : ""));
        if (label) row.append(this.el("label", "", { text: label, title: label }));
        row.append(...[].concat(input));
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

    /** The mask's own settings: density and feather (kept, not baked in), on / off, and the mask commands. */
    _maskSection(L) {
        const s = this.el("div", "paint-sect");
        s.append(this.el("h4", "", { text: "Mask" }));
        const mk = L.mask;
        const live = (patch) => { this.liveBegin(); Object.assign(L.mask, patch); this.requestRedraw(); if (this.viewMask === L.id) this._tintDraw(); };
        this._slider(s, "Density (%)", Math.round((mk.density == null ? 1 : mk.density) * 100), 0, 100, 1,
                     (v) => live({ density: v / 100 }), () => this.liveEnd("Mask density"));
        this._slider(s, "Feather (px)", mk.feather || 0, 0, 250, 0.5, (v) => live({ feather: v }), () => this.liveEnd("Mask feather"));
        const row = this.el("div", "paint-field");
        for (const [label, run] of [[mk.enabled ? "Switch off" : "Switch on", () => this.maskCmd("toggle")],
                                     [this.viewMask === L.id ? "Show the picture" : "Show on the canvas", () => this.setViewMask(this.viewMask === L.id ? null : L.id)],
                                     ["Select it", () => this.loadSelection(L, true)], ["Invert", () => this.maskCmd("invert")]]) {
            const b = this.el("button", "paint-btn", { type: "button", text: label });
            b.addEventListener("click", run);
            row.append(b);
        }
        s.append(row);
        s.append(this.el("div", "paint-note", { text: this.editMask || L.kind !== "pixel"
            ? "Painting the mask: brush, eraser, bucket, Fill and Del work on it (white shows, black hides)."
            : "Click the mask's thumbnail in Layers to paint it." }));
        return s;
    }

    /** Properties (the active layer, its mask, Fill), Tool options and Effects (style, smart filters) drawn again. */
    refreshProps() {
        if (this.tool === "shape") this._groupShow("shape");   // the shape picked in its options
        this._refreshOptBar();
        const L = this.active();
        const box = this.propsBox;
        if (box) {
            box.replaceChildren();
            if (this.quick) box.append(this.el("div", "paint-note", { text: "Quick Mask is on (Q): the brush, eraser, bucket and Fill paint the selection - black takes away (red), white adds. Q again makes it the selection." }));
            // Fill (Shift+F5), while it is asked for.
            if (this._fillOpen) box.append(this._fillSection());
            if (L) box.append(this._layerSection(L));
            if (this.isSmart(L)) box.append(this._smartLayerSection(L));
            if (L && L.mask) box.append(this._maskSection(L));
            if (!box.childNodes.length) box.append(this.el("div", "paint-note", { text: "Open or make a picture: the active layer's settings come here." }));
        }
        // The tool: the same controls as the options bar over the picture.
        const tb = this.toolBox;
        if (tb) {
            tb.replaceChildren();
            const ts = this.el("div", "paint-sect");
            const tool = PAINT_TOOLS.find((t) => t[0] === this.tool);
            ts.append(this.el("h4", "", { text: tool ? tool[2] : "Tool" }));
            this._propsTool = this.el("div");
            ts.append(this._propsTool);
            this._toolOptions(this._propsTool, false);
            const col = this.el("div", "paint-field");
            const fgc = this.el("input", "", { type: "color", value: D.rgbToHex(...this.fg) });
            fgc.addEventListener("input", () => { this.fg = D.hexToRgb(fgc.value); this._swatches(); });
            const bgc = this.el("input", "", { type: "color", value: D.rgbToHex(...this.bg) });
            bgc.addEventListener("input", () => { this.bg = D.hexToRgb(bgc.value); this._swatches(); });
            col.append(this.el("label", "", { text: "Colours" }), fgc, bgc);
            ts.append(col);
            tb.append(ts);
        }
        // The layer's effects: always there for a pixel layer, so they can be added here as well as from the menus.
        const eb = this.effectsBox;
        if (eb) {
            eb.replaceChildren();
            if (L && L.kind === "pixel") {
                eb.append(this.el("div", "paint-note paint-fx-for", { text: `Effects of "${L.name}"` }));
                eb.append(this._styleSection(L), this._smartSection(L));
            } else {
                eb.append(this.el("div", "paint-note", { text: L ? "A layer style and smart filters go on a pixel layer; pick one in Layers." : "Open or make a picture: the active layer's style and smart filters come here." }));
            }
        }
    }

    /** The options bar over the picture: the tool's name and its controls in one row. */
    _refreshOptBar() {
        const bar = this.optBar;
        if (!bar) return;
        bar.replaceChildren();
        const tool = PAINT_TOOLS.find((t) => t[0] === this.tool);
        bar.append(this.el("span", "paint-otool", { text: tool ? tool[2].split(" (")[0] : "" }));
        this._toolOptions(bar, true);
    }

    /** A control changed in one of the two places: the other one shows it too. */
    _optSync(fromBar) {
        if (fromBar) { if (this._propsTool && this._propsTool.isConnected) { this._propsTool.replaceChildren(); this._toolOptions(this._propsTool, false); } }
        else this._refreshOptBar();
    }

    /** The tool's controls, into the options bar (`bar`: one row, no notes) or Properties. */
    _toolOptions(ts, bar) {
        const o = this.opts;
        const sync = () => this._optSync(bar);
        const note = (text) => { if (!bar) ts.append(this.el("div", "paint-note", { text })); };
        const check = (obj, key, text, title = "") => {
            const c = this.el("input", "", { type: "checkbox", checked: !!obj[key] });
            c.addEventListener("change", () => { obj[key] = c.checked; sync(); });
            const l = this.el("label", "paint-check", { title });
            l.append(c, this.el("span", "", { text }));
            return l;
        };
        if (BRUSHES.includes(this.tool)) {
            const b = o[this.tool];
            this._slider(ts, "Size", b.size, 1, 1000, 1, (v) => { b.size = v; this.drawOverlay(); sync(); });
            this._slider(ts, "Hardness", b.hardness, 0, 100, 1, (v) => { b.hardness = v; sync(); });
            this._slider(ts, { dodge: "Exposure", burn: "Exposure", sponge: "Flow", smudge: "Strength", blur: "Strength" }[this.tool] || "Opacity", b.opacity, 1, 100, 1, (v) => { b.opacity = v; sync(); });
            if (this.tool === "brush" || this.tool === "eraser") {
                // Flow (as a paintbrush): each dab lays this much, and going over a place again in the same stroke
                // builds it up, never past Opacity.
                this._slider(ts, "Flow %", b.flow == null ? 100 : b.flow, 1, 100, 1, (v) => { b.flow = v; sync(); });
            }
            this._slider(ts, "Spacing %", b.spacing, 1, 100, 1, (v) => { b.spacing = v; sync(); });
            if (b.penSize === undefined) b.penSize = true;
            this._field(ts, "Pen pressure", [check(b, "penSize", "Size"), check(b, "penOpacity", "Opacity")])
                .title = "A pen tablet's pressure (Wacom, Windows Ink) sets each dab's size and / or opacity. A mouse paints at full.";
            if (b.tip !== undefined && !bar) this._tipOptions(ts, b, sync);
            if (SOURCED.includes(this.tool)) {
                const smp = this.el("select", "", { title: "What it takes its pixels from" });
                for (const [v, t] of [["layer", "This layer"], ["all", "All layers"]]) smp.append(this.el("option", "", { value: v, text: t }));
                smp.value = b.sample;
                smp.addEventListener("change", () => { b.sample = smp.value; sync(); });
                this._field(ts, "Sample", smp);
                this._field(ts, "", [check(b, "aligned", "Aligned", "On: every stroke keeps the same offset from where it takes. Off: each stroke takes from the source point again."),
                                     check(b, "overlay", "Show overlay", "Show what the brush would put down inside its circle before painting"),
                                     check(b, "flip", "Flip", "Take the source mirrored left to right")]);
                this._slider(ts, "Source angle °", b.angle, -180, 180, 1, (v) => { b.angle = v; this.drawOverlay(); sync(); });
                this._slider(ts, "Source scale %", b.scale, 10, 400, 1, (v) => { b.scale = v; this.drawOverlay(); sync(); });
                note((this.tool === "heal" ? "Paints the texture at the source, taking on the light and colour where it lands (when the stroke ends). " : "Paints what lies at the source (the cross). ")
                     + (this.cloneSrc ? "Alt+click sets a new source." : "Alt+click where to take from, then paint where it should go."));
            } else if (this.tool === "dodge" || this.tool === "burn") {
                const rg = this.el("select", "tone-range", { title: "Which part of the light it works on most" });
                for (const [v, t] of [["shadows", "Shadows"], ["midtones", "Midtones"], ["highlights", "Highlights"]]) rg.append(this.el("option", "", { value: v, text: t }));
                rg.value = b.range;
                rg.addEventListener("change", () => { b.range = rg.value; sync(); });
                this._field(ts, "Range", rg);
                note(this.tool === "dodge" ? "Lightens what it paints over; a new stroke lightens again." : "Darkens what it paints over; a new stroke darkens again.");
            } else if (this.tool === "sponge") {
                const md = this.el("select", "tone-sat");
                for (const [v, t] of [["desaturate", "Desaturate"], ["saturate", "Saturate"]]) md.append(this.el("option", "", { value: v, text: t }));
                md.value = b.sat;
                md.addEventListener("change", () => { b.sat = md.value; sync(); });
                this._field(ts, "Mode", md);
                note("Takes colour out of what it paints over (or puts more in).");
            } else if (this.tool === "smudge") {
                this._field(ts, "", [check(b, "finger", "Finger painting", "Each stroke starts with the colour on the brush")]);
                note("Drags the paint along the stroke, as a finger through wet paint.");
            } else if (this.tool === "blur") {
                note("Softens what it paints over; going over a place again softens it more. Works on a layer, its mask and Quick Mask.");
            } else if (this.tool === "spot") {
                note("Paint over a blemish: when the stroke ends it is filled from a place nearby that looks alike, blended into what is around it.");
            } else note(this.editMask ? "Painting the layer's MASK: white shows, black hides." : "Alt+click picks a colour; Shift+click draws a straight line.");
            note("Hold B and drag on the canvas (or Alt+right-drag): sideways the size, up and down the opacity - Shift: the hardness.");
        } else if (this.tool === "fill" || this.tool === "wand") {
            const f = o[this.tool];
            this._slider(ts, "Tolerance", f.tolerance, 0, 255, 1, (v) => { f.tolerance = v; sync(); });
            this._field(ts, "", [check(f, "contiguous", "Contiguous"), check(f, "all", "All layers")]);
        } else if (this.tool === "liquify") {
            this._lqOptions(ts, bar, sync, note);
        } else if (PATH_TOOLS.includes(this.tool)) {
            this._penOptions(ts, bar, sync, note);
        } else if (this.tool === "gradient" || this.tool === "shape") {
            this._drawOptions(ts, bar, sync, note);
        } else if (this.tool === "patch") {
            const md = this.el("select", "paint-patchmode", { title: "Source: the selection is filled from where it is dragged to. Destination: it is carried there." });
            for (const [v, t] of [["source", "Source"], ["destination", "Destination"]]) md.append(this.el("option", "", { value: v, text: t }));
            md.value = o.patch.mode;
            md.addEventListener("change", () => { o.patch.mode = md.value; sync(); });
            this._field(ts, "Patch", md);
            note("Draw round what to patch (or use any selection), then drag it to a place that looks right: it is filled from there and blended in.");
        } else if (["marquee", "ellipse", "lasso"].includes(this.tool)) {
            this._slider(ts, "Feather", o.select.feather, 0, 200, 0.5, (v) => { o.select.feather = v; sync(); });
            note("Shift adds to the selection, Alt takes from it, both keep what they share.");
        } else if (this.tool === "text") {
            const t = o.text;
            const font = this.el("input", "", { type: "text", value: t.font });
            font.addEventListener("change", () => { t.font = font.value || "sans-serif"; sync(); });
            font.addEventListener("keydown", (e) => e.stopPropagation());
            this._field(ts, "Font", font);
            this._slider(ts, "Size", t.size, 4, 1000, 1, (v) => { t.size = v; sync(); });
            this._field(ts, "", [check(t, "bold", "Bold"), check(t, "italic", "Italic")]);
            note("Click to write; Enter keeps it (Shift+Enter: a new line), Esc throws it away. Click a text layer to write it again.");
        } else if (this.tool === "crop") {
            const go = this.el("button", "paint-btn on", { type: "button", text: "Apply crop (Enter)" });
            go.addEventListener("click", () => this.applyCrop());
            ts.append(go);
            note("Drag a rectangle; drag inside it to move it.");
        } else if (this.tool === "tfsel") {
            this._tfFields(ts);
            note("Takes the selected pixels of the active layer and moves, scales and rotates them; the place they came from is left empty. "
                 + "Drag inside to move, a handle to scale, outside to rotate (Shift: 15° steps). Enter or a double-click puts them down, Esc puts them back.");
        } else if (this.tool === "move") {
            if (!this.wp) this._tfFields(ts);
            this._wpOptions(ts, bar);
            note("Drag inside to move, a handle to scale (Shift keeps the shape, Alt scales about the middle), outside to rotate (Shift: 15° steps); "
                 + "Ctrl+drag an edge's handle shears. The arrows nudge. Enter or a double-click applies, Esc cancels.");
        } else if (this.tool === "picker") {
            note("Click: the colour under the pointer becomes the brush's. Drag a box: the average colour inside it.");
        } else if (this.tool === "hand") {
            note("Drag to pan; the wheel zooms.");
        }
    }

    // Fill (Shift+F5, Edit > Fill…): a colour into the selection, in Properties.
    openFill() {
        if (!this.doc) return;
        this._fillOpen = this._fillOpen || { what: "fg", custom: D.rgbToHex(...this.fg), opacity: 100 };
        this.refreshProps();
        if (this.host.showPanel) this.host.showPanel("props");
        const b = this.propsBox && this.propsBox.querySelector(".paint-fill .paint-btn.on");
        if (b) setTimeout(() => b.focus(), 0);
    }

    closeFill() { this._fillOpen = null; this.refreshProps(); this.wrap.focus({ preventScroll: true }); }

    _fillSection() {
        const f = this._fillOpen;
        const s = this.el("div", "paint-sect paint-fill");
        s.append(this.el("h4", "", { text: "Fill" }));
        const what = this.el("select");
        for (const [v, t] of [["fg", "Colour"], ["bg", "Second colour"], ["custom", "Custom colour…"], ["black", "Black"], ["white", "White"], ["gray", "50% grey"]])
            what.append(this.el("option", "", { value: v, text: t }));
        what.value = f.what;
        const col = this.el("input", "", { type: "color", value: f.custom, title: "The custom colour" });
        const showCol = () => { col.style.display = what.value === "custom" ? "" : "none"; };
        what.addEventListener("change", () => { f.what = what.value; showCol(); });
        col.addEventListener("input", () => { f.custom = col.value; });
        showCol();
        this._field(s, "Contents", [what, col]);
        this._slider(s, "Opacity %", f.opacity, 1, 100, 1, (v) => { f.opacity = v; });
        const L = this.active();
        s.append(this.el("div", "paint-note", { text: `Into ${this.sel ? "the selection" : "the whole layer (nothing is selected)"}` + (L ? ` on ${L.name}.` : ".") }));
        const go = this.el("div", "go");
        const no = this.el("button", "paint-btn", { type: "button", text: "Cancel" });
        no.addEventListener("click", () => this.closeFill());
        const ok = this.el("button", "paint-btn on", { type: "button", text: "Fill" });
        ok.addEventListener("click", () => this.doFill());
        go.append(no, ok);
        s.append(go);
        s.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); this.closeFill(); }
            else if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.preventDefault(); this.doFill(); }
        });
        return s;
    }

    doFill() {
        const f = this._fillOpen;
        if (!f) return false;
        const rgb = { fg: this.fg, bg: this.bg, black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128] }[f.what] || D.hexToRgb(f.custom);
        const ok = this.fillSelection(rgb, clamp(f.opacity, 1, 100) / 100);
        if (ok) this.closeFill();
        return ok;
    }

    // ── the History panel ────────────────────────────────────────────────────

    _buildHistoryPart() {
        const p = this.el("div", "paint-panel");
        this.histList = this.el("div", "paint-list paint-hist");
        p.append(this.histList);
        p.addEventListener("pointerdown", () => { this._layersFocus = false; }, true);
        return p;
    }

    /** One row per step: the picture as it was opened, every step kept, the ones undone (dimmed, a click redoes them). */
    refreshHistory() {
        const list = this.histList;
        if (!list) return;
        if (!this.doc) { list.replaceChildren(this.el("div", "paint-note", { text: "Open a picture in Paint to see its history." })); return; }
        const steps = [...this.undoStack, ...this.redoStack.slice().reverse()];
        const cur = this.undoStack.length;
        const sig = `${this.version}|${cur}|${steps.length}|${this._histDropped}|${this.savedVersion}|` + steps.map((x) => x.label).join("\u0001");
        if (sig === this._histSig && list.childElementCount) return;
        this._histSig = sig;
        list.replaceChildren();
        // The version a row stands for: the steps before it count up from version - cur.
        const base = this.version - cur;
        const rows = [[this._histDropped ? `${this.doc.name || "Picture"} (older steps not kept)` : `Open ${this.doc.name || ""}`.trim(), "open"],
                      ...steps.map((x) => [x.label, "step"])];
        rows.forEach(([label, kind], i) => {
            const row = this.el("div", "paint-row" + (i === cur ? " active" : "") + (i > cur ? " future" : ""));
            row.dataset.step = String(i);
            const ic = this.el("span", "hico");
            ic.append(paintIcon(this.d, kind === "open" ? "open" : "history", 14));
            row.append(ic, this.el("span", "nm", { text: label }));
            if (base + i === this.savedVersion) { row.classList.add("saved"); row.append(this.el("span", "tag", { text: "saved" })); }
            row.title = i > cur ? "Undone: click to redo up to here" : i === cur ? "The picture as it is" : "Click to go back to here";
            row.addEventListener("click", () => this.goTo(i));
            list.append(row);
        });
        const act = list.children[cur];
        if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
    }

    _layerSection(L) {
        const s = this.el("div", "paint-sect");
        const n = this.pickedLayers().length;
        s.append(this.el("h4", "", { text: L.kind === "adjust" ? D.ADJUST_LABELS[L.adjust.type] : L.kind === "group" ? "Group" : L.text ? "Text layer" : "Layer" }));
        if (n > 1) s.append(this.el("div", "paint-note", { text: `${n} layers picked: Layers' opacity, blend, lock, eye, delete, duplicate, merge (Ctrl+E), group (Ctrl+G) and the Move tool take them all.` }));
        if (L.kind === "group") {
            const inside = D.withInside(this.doc, [L.id]).length - 1;
            s.append(this.el("div", "paint-note", { text: `${inside} layer${inside === 1 ? "" : "s"} inside` + (L.mask ? (L.mask.enabled ? " · mask on" : " · mask off") : "") }));
            s.append(this.el("div", "paint-note", { text: L.blend === "pass_through"
                ? "Pass Through: its layers mix with what is under the group as if they were not in one; an adjustment layer in it changes everything under it."
                : `${D.BLEND_LABELS[L.blend]}: its layers are laid together first, and that picture is laid on what is under the group; an adjustment layer in it changes only the group's layers.` }));
            return s;
        }
        if (L.kind === "adjust") {
            const t = L.adjust.type;
            const live = (patch) => { this.liveBegin(); L.adjust.params = D.cleanAdjust(t, { ...L.adjust.params, ...patch }); this.requestRedraw(); };
            const end = () => this.liveEnd(D.ADJUST_LABELS[t]);
            s.append(this._adjustEditor(t, () => L.adjust.params, live, end, () => this._adjHistUnder(L)));
            s.append(this.el("div", "paint-note", { text: L.clip ? "Clipped: it changes only the layer it is clipped to (Alt+click in Layers releases it)."
                : "It changes every layer under it. Paint its mask (or select first) to limit it, or Alt+click it in Layers to change only the layer under it." }));
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

    _generateSection() {
        const s = this.el("div", "paint-sect");
        s.append(this.el("h4", "", { text: "Generate" }));
        const ta = this.el("textarea", "", { value: this._prompt || "", placeholder: "What to make in the selection, or how to change it - e.g. \"a red umbrella\"" });
        ta.addEventListener("keydown", (e) => e.stopPropagation());
        ta.addEventListener("input", () => { this._prompt = ta.value; });
        s.append(ta);
        const row = this.el("div", "paint-gen");
        const uses = (kind) => { const w = this.host.workflowFor ? this.host.workflowFor(kind) : ""; return w ? ` (${w})` : ""; };
        const g = (label, kind, title, extra = () => ({})) => {
            const b = this.el("button", "paint-btn", { type: "button", text: label, title: title + uses(kind) });
            b.dataset.gen = kind;
            b.addEventListener("pointerenter", () => { b.title = title + uses(kind); });
            b.addEventListener("click", () => this.host.generate && this.host.generate(kind, { prompt: this._prompt || "", variations: this._variations || 1, ...extra() }));
            if (this.genRunning().some((j) => j.kind === kind)) b.classList.add("busy");     // a run going on while this was rebuilt
            row.append(b);
        };
        g("Generative fill", "fill", "Make what the prompt says inside the selection: a new layer, masked to it");
        g("Remove object", "remove", "Take what is selected away and fill the place: a new layer");
        g("Edit", "edit", "Change the selection (or the whole picture) as the prompt says: a new layer");
        g("Remove background", "background", "A mask on the layer that hides the background");
        g("Select foreground", "select_subject", "The selection becomes what stands in front (the background left out)");
        const e = this.el("button", "paint-btn", { type: "button", text: "Extend empty areas", title: "Select what the layer leaves empty on the canvas and fill it there (Generative fill)" + uses("fill") });
        e.addEventListener("pointerenter", () => { e.title = "Select what the layer leaves empty on the canvas and fill it there (Generative fill)" + uses("fill"); });
        e.addEventListener("click", () => this.extendEmpty());
        row.append(e);
        g("Extend 128 px", "extend", "A bigger canvas, the new part filled by the workflow", () => ({ px: 128, ai: true }));
        g("Upscale 2x", "upscale", "Twice the size, the detail made by the workflow", () => ({ k: 2, ai: true }));
        // The two with settings of their own: a dialog (the model, its settings; the words or the selection's box).
        const d = (label, kind, title) => {
            const b = this.el("button", "paint-btn", { type: "button", text: label, title });
            b.dataset.gen = kind;
            b.addEventListener("click", () => this.host.generateDialog && this.host.generateDialog(kind));
            if (this.genRunning().some((j) => j.kind === kind)) b.classList.add("busy");
            row.append(b);
        };
        d("Upscale…", "upscale", "Pick the upscaler and its settings");
        d("Select objects…", "select_objects", "SAM3: select what the words name, or what is inside the selection's box");
        const opt = this.el("div", "paint-field");
        const vs = this.el("select", "", { title: "How many versions to make (each a layer of its own)" });
        for (const n of [1, 2, 3, 4]) vs.append(this.el("option", "", { value: String(n), text: String(n) }));
        vs.value = String(this._variations || 1);
        vs.addEventListener("change", () => { this._variations = Number(vs.value) || 1; });
        const wf = this.el("button", "paint-btn", { type: "button", text: "Workflows…", title: "Which workflow each of these runs" });
        wf.addEventListener("click", () => this.host.workflows && this.host.workflows());
        opt.append(this.el("label", "", { text: "Variations" }), vs, wf);
        s.append(row, opt, this.el("div", "paint-note", { text: "Each runs a ready-made ComfyUI workflow at the size the model wants; the result comes back as a new layer. Your own workflows go in Settings \u203a ComfyUI Image Viewer \u203a Paint." }));
        return s;
    }

    // ── files ────────────────────────────────────────────────────────────────

    /**
     * What a save sends: { meta, layers: {id: Uint8ClampedArray}, masks: {id: Uint8Array}, selection, keep: [ids] } -
     * the pixels RAW (straight RGBA / grey), so nothing is rounded on the way (a canvas' PNG would premultiply);
     * a layer whose pixels did not change since the last save is named in `keep` and not sent again.
     */
    toSave({ all = false } = {}) {
        this._tfSettle();
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
        // Smart layers' sources: sent once (a source never changes; a new one has a new id).
        const sources = {};
        for (const [id, S] of Object.entries(this.usedSources())) if (all || !this.saved.has("s:" + id)) sources[id] = S.px;
        return { meta, layers, masks, selection, keep, sources };
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
        if (this.tf) this.tfCancel();
        const before = this._snap();
        const next = { doc: D.cleanDoc(data.doc), pix: new Map(Object.entries(data.pix || {})), masks: new Map(Object.entries(data.masks || {})),
                       sel: data.selection && data.selection.length === data.doc.w * data.doc.h ? data.selection : null };
        for (const [id, s] of Object.entries(data.srcs || {})) this._srcs().set(id, { px: s.px, w: s.w, h: s.h });
        for (const L of next.doc.layers) {
            if (L.smart && !this._srcs().has(L.smart.src)) delete L.smart;
            if (L.kind === "pixel" && !next.pix.has(L.id)) next.pix.set(L.id, new Uint8ClampedArray(L.w * L.h * 4));
        }
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

Object.assign(PaintEditor.prototype, PenMixin, WarpMixin, HealMixin, TipsMixin, DrawMixin, LayerFxMixin, SelectGuidesMixin, SmartMixin, LiquifyMixin, PathToolsMixin, PreviewMixin, AdjustUIMixin, SmartLayerMixin, GenStatusMixin, BrushDragMixin);

// Lucide's rotate-cw, white on black, as the pointer outside a transform's box.
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#000" stroke-width="4"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></g><g stroke="#fff" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></g></svg>')}") 12 12, alias`;

const ANCHOR = { top_left: [0, 0], top: [0.5, 0], top_right: [1, 0], left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
                 bottom_left: [0, 1], bottom: [0.5, 1], bottom_right: [1, 1] };
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
