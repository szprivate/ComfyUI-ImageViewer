// bEpicViewer_annotate.js
// AnnotateMixin — the in-viewer Annotation tool. Unlike Roto / SAM3 (which
// persist vector data into a source node's widgets for a Python consumer), the
// Annotation tool is standalone markup: it draws freehand strokes, arrows,
// boxes and text over WHATEVER image the active tab is showing — including
// folder tabs and Explorer-dropped images that have no "Send to Viewer" node.
//
// "Export annotation" flattens the markup over the current image at native
// resolution into a PNG, saves it to ./output (via /bepic/save_annotation) and
// adds that file to the active tab's history strip, so it can be dragged onto
// the ComfyUI graph like any other history thumbnail.
//
// Annotations over a picture that is a file are filed under it (store key
// "img:<file>") and kept beside it like a video's; over a picture with no file
// (dropped in) they live in memory per tab (this._annotStore[tabKey]). Over a VIDEO
// they are feedback, so they carry the frames they belong to (item.f .. item.fe),
// are filed under the video (store key "vid:<video>") and are written to a sidecar
// beside it - all of that is in bEpicViewer_annotateVideo.js; this file only asks
// it through optional hooks (_annotVideo*), so it works without.
//
// Text marks can be moved, resized (corner handle), recoloured, edited
// (double-click) and deleted (Delete key / right-click) like the other shapes.
//
// Interaction is drawn in screen space via ToolsMixin's _normToDraw so shapes
// track zoom/pan/fit; items are stored in normalized [0,1] image coordinates.

import { svgEl, toolHelp } from "./bEpicViewer_tools.js";
import { api } from "../../scripts/api.js";
import { prefColor, PREF } from "./bEpicViewer_settings.js";
import { canvasContext, notice } from "./bEpicViewer_exportUI.js";
import { LINE_H, textLines } from "./bEpicViewer_annotateReport.js";

const ANNOT_COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759",
                      "#00c7be", "#0a84ff", "#ffffff", "#000000"];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
let _annotSeq = 0;
let _annotMeasureCtx = null;

function el(tag, props) {
    const e = document.createElement(tag);
    if (props) for (const k in props) e[k] = props[k];
    return e;
}

// Distance from point (px,py) to segment (x1,y1)-(x2,y2), all in screen px.
function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export const AnnotateMixin = {

    // ── bootstrap ────────────────────────────────────────────────────────────
    _annotInit() {
        this._annotStore = {};   // { [tabKey]: item[] }
        this._annot = {
            tool: "pen", color: ANNOT_COLORS[0],
            size: 6, textSize: 42, userSized: false, includeImage: true,
            draft: null, textInput: null, textAnchor: null, textTabKey: null,
            textEdit: null, sel: null, hold: 1,
        };
        // Settings → bEpic Viewer.
        this._annot.color = prefColor(PREF.annotColor);
        this._annotApplySizePrefs();
        this._annotInjectStyles();
    },

    _annotInjectStyles() {
        if (this.shadowRoot.getElementById("bepic-annot-style")) return;
        const s = document.createElement("style");
        s.id = "bepic-annot-style";
        s.textContent = `
            .bepic-annot-row { display:flex; gap:4px; margin:5px 0; }
            .bepic-annot-row button { flex:1; }
            .bepic-annot-tool { background:#2a2a2a; color:#ddd; border:1px solid #555;
                border-radius:4px; cursor:pointer; padding:4px 0; font-size:14px; line-height:1; }
            .bepic-annot-tool:hover { background:#3a3a3a; }
            .bepic-annot-tool.active { color:#f60; border-color:#f60; }
            .bepic-annot-swatches { display:flex; gap:5px; flex-wrap:wrap; align-items:center; margin:6px 0; }
            .bepic-annot-swatch { width:18px; height:18px; border-radius:4px; padding:0;
                border:1px solid rgba(255,255,255,.3); cursor:pointer; }
            .bepic-annot-swatch.sel { box-shadow:0 0 0 2px #fff; }
            .bepic-annot-text-input { position:absolute; z-index:62; background:rgba(0,0,0,.4);
                border:1px dashed rgba(255,255,255,.8); padding:0 3px; outline:none;
                line-height:1.2; white-space:pre; resize:none; overflow:hidden; margin:0; box-sizing:content-box; }
        `;
        this.shadowRoot.appendChild(s);
    },

    // ── activation (called from ToolsMixin.setActiveTool) ─────────────────────
    _annotActivate(panel) {
        this._annotPanel = panel;
        if (!this._annotKeyBound) {
            this._annotKeyFn = (e) => this._annotKeyDown(e);
            // Capture, on the document: the viewer's own hotkeys must not see a
            // Delete that is meant for the selected text.
            document.addEventListener("keydown", this._annotKeyFn, true);
            this._annotKeyBound = true;
        }
        this._annotBuildPanel();
        this._annotVideoLoad?.();
        this._updateToolCursor();
    },

    _annotDeactivate() {
        this._annotCommitText();
        this._annot.draft = null;
        this._annot.sel = null;
    },

    // ── per-tab item store ────────────────────────────────────────────────────
    // What the marks are filed under: the tab, or - over a video - the video, so a
    // clip's marks follow the clip and not whichever tab happens to show it.
    _annotKey() {
        const m = this._annotMediaRef ? this._annotMediaRef() : null;
        if (m) return m.key;
        return (this._videoMode && this._videoKey) ? "vid:" + this._videoKey : this.activeTab;
    },

    _annotItems(create = true) {
        const key = this._annotKey();
        if (!key) return create ? [] : null;
        if (!this._annotStore[key]) {
            if (!create) return null;
            this._annotStore[key] = [];
        }
        return this._annotStore[key];
    },

    _annotAfterChange() {
        this._toolRedraw();
        this._annotUpdateInfo();
        this._annotMediaChanged?.();
    },

    // Over a video a mark is shown only on its frames; over a picture, always.
    _annotShown(it) {
        if (!this._videoMode || it.f === undefined) return true;
        const cur = Math.round(this.currentFrame || 0);
        return it.f <= cur && cur <= (it.fe === undefined ? it.f : it.fe);
    },

    _annotVisible() {
        return (this._annotItems(false) || []).filter((it) => this._annotShown(it));
    },

    // A finished mark goes into the store; over a video it is stamped with the
    // frames it belongs to (the current one, and the "hold" after it).
    _annotAdd(it) {
        if (!it.id) it.id = "a" + (++_annotSeq);
        this._annotVideoStamp?.(it);
        this._annotItems().push(it);
        this._annotAfterChange();
        return it;
    },

    _annotById(id) {
        return id ? (this._annotItems(false) || []).find((it) => it.id === id) || null : null;
    },

    _annotSelected() {
        const it = this._annotById(this._annot.sel);
        return it && this._annotShown(it) ? it : null;
    },

    _annotSelect(it) {
        this._annot.sel = it ? it.id : null;
        this._toolRedraw();
    },

    _annotRemove(it) {
        const arr = this._annotItems(false);
        const i = arr ? arr.indexOf(it) : -1;
        if (i < 0) return;
        arr.splice(i, 1);
        if (this._annot.sel === it.id) this._annot.sel = null;
        this._annotAfterChange();
    },

    // A text mark's box in image pixels: its lines at its size.
    _annotTextBox(it) {
        const size = it.size || 42;
        const ctx = (_annotMeasureCtx || (_annotMeasureCtx = document.createElement("canvas").getContext("2d")));
        ctx.font = `${size}px sans-serif`;
        let w = 0;
        const lines = textLines(it.text);
        for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
        return { w: Math.max(w, size * 0.6), h: lines.length * size * LINE_H };
    },

    // Screen px per image px (uniform — fit preserves aspect ratio).
    _annotScale() {
        const { w } = this._toolImgSize();
        if (!w) return 1;
        const a = this._normToClient(0, 0);
        const b = this._normToClient(1, 0);
        if (!a || !b) return 1;
        return Math.hypot(b.x - a.x, b.y - a.y) / w;
    },

    // ── rendering (screen-space SVG on ToolsMixin's _toolDraw) ────────────────
    _annotRender() {
        const scale = this._annotScale();
        for (const it of this._annotVisible()) this._annotRenderItem(it, scale);
        if (this._annot && this._annot.draft) this._annotRenderItem(this._annot.draft, scale);
        const sel = this._annotSelected();
        if (sel && sel.type === "text" && !sel._editing) this._annotRenderSelection(sel, scale);
    },

    // The dashed box and the corner handle of the selected text mark.
    _annotRenderSelection(it, scale) {
        const a = this._normToDraw(it.x, it.y);
        if (!a) return;
        const b = this._annotTextBox(it);
        const w = b.w * scale, h = b.h * scale;
        this._toolDraw.appendChild(svgEl("rect", {
            x: a.x - 3, y: a.y - 3, width: w + 6, height: h + 6, fill: "none",
            stroke: "#0a84ff", "stroke-width": 1.5, "stroke-dasharray": "5 3",
        }));
        this._toolDraw.appendChild(svgEl("rect", {
            x: a.x + w - 3, y: a.y + h - 3, width: 10, height: 10, fill: "#0a84ff",
            stroke: "#fff", "stroke-width": 1,
        }));
    },

    _annotRenderItem(it, scale) {
        const color = it.color || "#ff3b30";
        if (it.type === "text") {
            if (it._editing) return;
            const d = this._normToDraw(it.x, it.y);
            if (!d) return;
            const fs = Math.max(6, (it.size || 42) * scale);
            const t = svgEl("text", {
                x: d.x, y: d.y, fill: color,
                "font-family": "sans-serif", "font-size": fs,
                "dominant-baseline": "hanging", "paint-order": "stroke",
                stroke: "#000", "stroke-width": Math.max(1, fs * 0.06),
            });
            textLines(it.text).forEach((line, i) => {
                const ts = svgEl("tspan", { x: d.x, y: d.y + i * fs * LINE_H });
                ts.textContent = line;
                t.appendChild(ts);
            });
            this._toolDraw.appendChild(t);
            return;
        }
        const lw = Math.max(1, (it.width || 6) * scale);
        if (it.type === "pen") {
            const pts = it.pts.map((p) => this._normToDraw(p.x, p.y)).filter(Boolean);
            if (pts.length < 2) return;
            const d = "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
            this._toolDraw.appendChild(svgEl("path", {
                d, fill: "none", stroke: color, "stroke-width": lw,
                "stroke-linecap": "round", "stroke-linejoin": "round",
            }));
            return;
        }
        const a = this._normToDraw(it.a.x, it.a.y);
        const b = this._normToDraw(it.b.x, it.b.y);
        if (!a || !b) return;
        if (it.type === "rect") {
            this._toolDraw.appendChild(svgEl("rect", {
                x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
                fill: "none", stroke: color, "stroke-width": lw,
            }));
            return;
        }
        if (it.type === "arrow") {
            this._toolDraw.appendChild(svgEl("line", {
                x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                stroke: color, "stroke-width": lw, "stroke-linecap": "round",
            }));
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            const head = Math.max(8, lw * 3.2);
            const wing = Math.PI / 7;
            const hx1 = b.x - head * Math.cos(ang - wing), hy1 = b.y - head * Math.sin(ang - wing);
            const hx2 = b.x - head * Math.cos(ang + wing), hy2 = b.y - head * Math.sin(ang + wing);
            this._toolDraw.appendChild(svgEl("polygon", {
                points: `${b.x},${b.y} ${hx1},${hy1} ${hx2},${hy2}`, fill: color,
            }));
            return;
        }
    },

    // ── pointer (dispatched from ToolsMixin) ──────────────────────────────────
    _annotPointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return false;
        const tool = this._annot.tool;

        // Right-click deletes the topmost annotation under the cursor; on empty
        // space it falls through so the viewport can zoom.
        if (e.button === 2) {
            const hit = this._annotHitTest(n);
            if (hit) { this._annotRemove(hit); return true; }
            return false;
        }

        const again = this._annotIsDoubleDown(e, n);
        if (again) {
            this._annotLastDown = null;
            this._annot.draft = null;
            this._annotSelect(again);
            this._annotBeginText(null, again);
            return true;
        }

        if (tool === "text") {
            // On an existing text mark: select it, and drag to move (or its corner
            // handle to resize). Anywhere else: a new text box.
            const sel = this._annotSelected();
            if (sel && sel.type === "text" && this._annotOnHandle(sel, e)) {
                this._annotResizeDrag(sel, e); return true;
            }
            const hit = this._annotHitTest(n);
            if (hit && hit.type === "text") {
                this._annotCommitText();
                this._annotSelect(hit);
                this._annotMoveDrag(hit, n);
                return true;
            }
            this._annot.sel = null;
            this._annotBeginText(n);
            return true;
        }

        const color = this._annot.color;
        if (tool === "pen") {
            const it = { type: "pen", color, width: this._annot.size,
                         pts: [{ x: clamp01(n.x), y: clamp01(n.y) }] };
            this._annot.draft = it;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev); if (!m) return;
                    it.pts.push({ x: clamp01(m.x), y: clamp01(m.y) });
                    this._toolRedraw();
                },
                () => {
                    this._annot.draft = null;
                    if (it.pts.length > 1) this._annotAdd(it);
                    else this._toolRedraw();
                },
            );
            return true;
        }
        if (tool === "arrow" || tool === "rect") {
            const it = { type: tool, color, width: this._annot.size,
                         a: { x: clamp01(n.x), y: clamp01(n.y) },
                         b: { x: clamp01(n.x), y: clamp01(n.y) } };
            this._annot.draft = it;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev); if (!m) return;
                    it.b = { x: clamp01(m.x), y: clamp01(m.y) };
                    this._toolRedraw();
                },
                () => {
                    this._annot.draft = null;
                    if (this._screenDist(it.a, it.b) > 4) this._annotAdd(it);
                    else this._toolRedraw();
                },
            );
            return true;
        }
        return false;
    },

    _annotHoverContext(e, n) {
        const over = this._annotHitTest(n);
        if (over && over.type === "text") {
            return { status: "<b>Drag</b> moves the text · <b>Double-click</b> edits · <b>Delete</b> / right-click removes",
                     cursor: this._annot.tool === "text" ? "move" : "pointer" };
        }
        if (over) {
            return { status: "<b>Right-click</b> to delete this annotation", cursor: "pointer" };
        }
        const msg = {
            pen:   "<b>Drag</b> to draw freehand",
            arrow: "<b>Drag</b> to draw an arrow",
            rect:  "<b>Drag</b> to draw a box",
            text:  "<b>Click</b> to add text",
        }[this._annot.tool] || "";
        return {
            status: msg + " · <b>Right-click</b> deletes · <b>Middle-drag</b> pans",
            cursor: this._annot.tool === "text" ? "text" : "crosshair",
        };
    },

    // The topmost visible annotation near normalized point n, else null.
    _annotHitTest(n) {
        const c = this._normToClient(n.x, n.y);
        if (!c) return null;
        const scale = this._annotScale();
        const items = this._annotVisible();
        for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            const th = it.type === "text" ? 6 : Math.max(9, (it.width || 6) * scale * 0.5 + 5);
            if (this._annotItemDist(it, c.x, c.y, scale) <= th) return it;
        }
        return null;
    },

    // Is the pointer on the selected text mark's corner handle?
    _annotOnHandle(it, e) {
        const p = this._normToClient(it.x, it.y);
        if (!p) return false;
        const sc = this._annotScale();
        const b = this._annotTextBox(it);
        return Math.abs(e.clientX - (p.x + b.w * sc)) <= 9 && Math.abs(e.clientY - (p.y + b.h * sc)) <= 9;
    },

    // Drag a text mark; the pointer keeps its place on the text.
    _annotMoveDrag(it, n0) {
        const dx = n0.x - it.x, dy = n0.y - it.y;
        let moved = false;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev); if (!m) return;
                it.x = clamp01(m.x - dx); it.y = clamp01(m.y - dy);
                moved = true;
                this._toolRedraw();
            },
            () => { if (moved) this._annotAfterChange(); },
        );
    },

    // Drag the corner handle: the text grows with the pointer's distance from its
    // top-left corner.
    _annotResizeDrag(it, e0) {
        const p = this._normToClient(it.x, it.y);
        const d0 = Math.max(10, Math.hypot(e0.clientX - p.x, e0.clientY - p.y));
        const size0 = it.size || 42;
        this._toolDrag(
            (ev) => {
                const d = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
                it.size = Math.max(8, Math.min(400, Math.round(size0 * d / d0)));
                this._toolRedraw();
            },
            () => { this._annotAfterChange(); },
        );
    },

    _annotItemDist(it, cx, cy, scale) {
        if (it.type === "text") {
            const p = this._normToClient(it.x, it.y);
            if (!p) return Infinity;
            const b = this._annotTextBox(it);
            const w = b.w * scale, h = b.h * scale;
            if (cx >= p.x - 4 && cx <= p.x + w + 4 && cy >= p.y - 4 && cy <= p.y + h + 4) return 0;
            return Math.hypot(cx - p.x, cy - p.y);
        }
        if (it.type === "pen") {
            let best = Infinity;
            for (let i = 1; i < it.pts.length; i++) {
                const a = this._normToClient(it.pts[i - 1].x, it.pts[i - 1].y);
                const b = this._normToClient(it.pts[i].x, it.pts[i].y);
                if (a && b) best = Math.min(best, segDist(cx, cy, a.x, a.y, b.x, b.y));
            }
            return best;
        }
        const a = this._normToClient(it.a.x, it.a.y);
        const b = this._normToClient(it.b.x, it.b.y);
        if (!a || !b) return Infinity;
        if (it.type === "arrow") return segDist(cx, cy, a.x, a.y, b.x, b.y);
        if (it.type === "rect") {
            const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
            const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
            return Math.min(
                segDist(cx, cy, x1, y1, x2, y1), segDist(cx, cy, x2, y1, x2, y2),
                segDist(cx, cy, x2, y2, x1, y2), segDist(cx, cy, x1, y2, x1, y1));
        }
        return Infinity;
    },

    // ── text entry ────────────────────────────────────────────────────────────
    // A text box is a textarea over the picture: Enter sets it, Shift+Enter breaks
    // the line, Escape drops the edit. `item` edits an existing mark in place.
    _annotBeginText(n, item) {
        this._annotCommitText();
        const at = item ? { x: item.x, y: item.y } : n;
        const d = this._normToDraw(at.x, at.y);
        if (!d) return;
        const scale = this._annotScale();
        const size = item ? (item.size || 42) : this._annot.textSize;
        const inp = el("textarea", { className: "bepic-annot-text-input", rows: 1, spellcheck: false });
        inp.value = item ? (item.text || "") : "";
        inp.style.left = d.x + "px";
        inp.style.top = d.y + "px";
        inp.style.color = item ? (item.color || this._annot.color) : this._annot.color;
        inp.style.font = Math.max(9, size * scale) + "px sans-serif";
        inp.style.lineHeight = String(LINE_H);
        inp.style.minWidth = "40px";
        const fit = () => {
            inp.style.height = "auto";
            inp.style.width = "1px";
            inp.style.height = inp.scrollHeight + "px";
            inp.style.width = Math.max(40, inp.scrollWidth + 6) + "px";
        };
        inp.addEventListener("input", fit);
        // Keep the input's own mouse/keys from reaching the tool + viewer hotkeys.
        inp.addEventListener("mousedown", (ev) => ev.stopPropagation());
        inp.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this._annotCommitText(); }
            else if (ev.key === "Escape") { ev.preventDefault(); this._annotDiscardText(); }
        });
        inp.addEventListener("blur", () => this._annotCommitText());
        this.viewport.appendChild(inp);
        fit();
        this._annot.textInput = inp;
        this._annot.textEdit = item || null;
        if (item) { item._editing = true; this._toolRedraw(); }
        this._annot.textAnchor = { x: clamp01(at.x), y: clamp01(at.y) };
        this._annot.textTabKey = this._annotKey();
        // Now, and again once the press that opened the box has finished with focus.
        const focus = () => { try { inp.focus(); if (item) inp.select(); } catch (_) {} };
        focus();
        setTimeout(() => { if (this._annot.textInput === inp && document.activeElement !== inp
            && this.shadowRoot.activeElement !== inp) focus(); }, 0);
    },

    _annotCommitText() {
        const inp = this._annot.textInput;
        if (!inp) return;
        const val = inp.value.replace(/\s+$/, "");
        const anchor = this._annot.textAnchor;
        const key = this._annot.textTabKey;
        const item = this._annot.textEdit;
        this._annot.textInput = null;
        this._annot.textAnchor = null;
        this._annot.textTabKey = null;
        this._annot.textEdit = null;
        try { inp.remove(); } catch (_) {}
        if (item) {
            delete item._editing;
            if (val.trim()) item.text = val;
            else {
                const arr = this._annotStore[key] || [];
                const i = arr.indexOf(item);
                if (i >= 0) arr.splice(i, 1);
                if (this._annot.sel === item.id) this._annot.sel = null;
            }
        } else if (val.trim() && anchor && key) {
            const it = { id: "a" + (++_annotSeq), type: "text", color: this._annot.color,
                         size: this._annot.textSize, x: anchor.x, y: anchor.y, text: val };
            this._annotVideoStamp?.(it);
            (this._annotStore[key] || (this._annotStore[key] = [])).push(it);
            this._annot.sel = it.id;
        }
        this._annotAfterChange();
    },

    _annotDiscardText() {
        const inp = this._annot.textInput;
        const item = this._annot.textEdit;
        this._annot.textInput = null;
        this._annot.textAnchor = null;
        this._annot.textTabKey = null;
        this._annot.textEdit = null;
        if (item) delete item._editing;
        if (inp) try { inp.remove(); } catch (_) {}
        this._toolRedraw();
    },

    // A double-click on a text mark (with any tool) edits it. Read off two
    // presses, not the browser's dblclick: the first press redraws the marks, which
    // replaces the element it landed on, and the browser then sends no click.
    _annotIsDoubleDown(e, n) {
        const now = Date.now(), last = this._annotLastDown;
        this._annotLastDown = { t: now, x: e.clientX, y: e.clientY };
        if (!last || now - last.t > 400 || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 6) return null;
        const hit = this._annotHitTest(n);
        return hit && hit.type === "text" ? hit : null;
    },

    // Delete / Backspace removes the selected text mark (not while typing in it).
    _annotKeyDown(e) {
        if (this._toolState.active !== "annotate" || this._annot.textInput) return;
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "")) return;
        const sel = this._annotSelected();
        if (!sel) return;
        e.preventDefault(); e.stopPropagation();
        this._annotRemove(sel);
    },

    // ── panel ─────────────────────────────────────────────────────────────────
    _annotAutoSize() {
        if (this._annot.userSized) return;
        const { w, h } = this._toolImgSize();
        const m = Math.min(w || 0, h || 0);
        if (!m) return;
        this._annot.size = Math.max(2, Math.min(24, Math.round(m / 300)));
        this._annot.textSize = Math.max(14, Math.min(160, Math.round(m / 18)));
    },

    _annotBuildPanel() {
        const p = this._annotPanel;
        p.innerHTML = "";
        // Titled by the Tool dock panel's bar.

        // Sub-tool row.
        this._annotToolBtns = {};
        const toolRow = el("div", { className: "bepic-annot-row" });
        const addTool = (t, glyph, title) => {
            const b = el("button", { className: "bepic-annot-tool", title, textContent: glyph });
            b.onclick = () => this._annotSetTool(t);
            toolRow.appendChild(b);
            this._annotToolBtns[t] = b;
        };
        addTool("pen", "✎", "Freehand pen");
        addTool("arrow", "↗", "Arrow");
        addTool("rect", "▭", "Rectangle");
        addTool("text", "T", "Text");
        p.appendChild(toolRow);

        // Colour swatches + custom picker.
        this._annotAutoSize();
        const sw = el("div", { className: "bepic-annot-swatches" });
        this._annotSwatches = [];
        ANNOT_COLORS.forEach((col) => {
            const s = el("button", { className: "bepic-annot-swatch", title: col });
            s.style.background = col;
            s.onclick = () => this._annotSetColor(col);
            sw.appendChild(s);
            this._annotSwatches.push([s, col]);
        });
        const custom = el("input", { type: "color", title: "Custom colour", value: this._annot.color });
        custom.style.cssText = "width:24px;height:20px;padding:0;border:1px solid #555;background:#111;cursor:pointer;";
        custom.oninput = () => this._annotSetColor(custom.value);
        this._annotCustomColor = custom;
        sw.appendChild(custom);
        p.appendChild(sw);

        // Stroke size.
        const sizeRow = el("div", { className: "row" });
        sizeRow.appendChild(el("label", { textContent: "Size" }));
        const sizeIn = el("input", { type: "range", min: "1", max: "40", step: "1", value: this._annot.size });
        const sizeNum = el("input", { type: "number", min: "1", max: "200", value: this._annot.size });
        const syncSize = (v) => {
            v = Math.max(1, Math.min(200, Math.round(+v || 1)));
            this._annot.size = v; this._annot.userSized = true;
            sizeIn.value = Math.min(40, v); sizeNum.value = v;
        };
        sizeIn.oninput = () => syncSize(sizeIn.value);
        sizeNum.oninput = () => syncSize(sizeNum.value);
        sizeRow.appendChild(sizeIn); sizeRow.appendChild(sizeNum);
        p.appendChild(sizeRow);

        // Text size.
        const tsRow = el("div", { className: "row" });
        tsRow.appendChild(el("label", { textContent: "Text" }));
        const tsIn = el("input", { type: "range", min: "8", max: "200", step: "1", value: this._annot.textSize });
        const tsNum = el("input", { type: "number", min: "8", max: "400", value: this._annot.textSize });
        const syncTs = (v) => {
            v = Math.max(8, Math.min(400, Math.round(+v || 8)));
            this._annot.textSize = v; this._annot.userSized = true;
            tsIn.value = Math.min(200, v); tsNum.value = v;
            if (this._annot.textInput) this._annot.textInput.style.font =
                Math.max(9, v * this._annotScale()) + "px sans-serif";
            const sel = this._annotSelected();
            if (sel && sel.type === "text") { sel.size = v; this._annotAfterChange(); }
        };
        tsIn.oninput = () => syncTs(tsIn.value);
        tsNum.oninput = () => syncTs(tsNum.value);
        tsRow.appendChild(tsIn); tsRow.appendChild(tsNum);
        p.appendChild(tsRow);

        // Include-image toggle for the export.
        const incRow = el("label", { className: "row" });
        incRow.style.cursor = "pointer";
        incRow.appendChild(el("span", { textContent: "Include image" }));
        const inc = el("input", { type: "checkbox", checked: this._annot.includeImage });
        inc.onchange = () => { this._annot.includeImage = inc.checked; };
        incRow.appendChild(inc);
        p.appendChild(incRow);

        // Undo / Clear.
        const ucRow = el("div", { className: "bepic-annot-row" });
        const undo = el("button", { className: "bepic-act", textContent: "Undo" });
        undo.onclick = () => {
            const v = this._annotVisible();
            if (v.length) this._annotRemove(v[v.length - 1]);
        };
        const clr = el("button", { className: "bepic-act bepic-danger",
            textContent: this._videoMode ? "Clear frame" : "Clear" });
        clr.onclick = () => {
            // Over a video: the marks on this frame; the rest stay.
            const keep = (this._annotItems(false) || []).filter((it) => !this._annotShown(it));
            this._annotStore[this._annotKey()] = keep;
            this._annot.sel = null;
            this._annotAfterChange();
        };
        ucRow.appendChild(undo); ucRow.appendChild(clr);
        p.appendChild(ucRow);

        // Export.
        const exp = el("button", { className: "bepic-act", textContent: "Export annotation" });
        exp.style.cssText += "background:#3a2a10;border-color:#a60;color:#fff;font-weight:600;margin-top:6px;";
        exp.onclick = () => this._annotExport();
        this._annotExportBtn = exp;
        p.appendChild(exp);

        // Video range / navigation / send (bEpicViewer_annotateVideo.js); a picture
        // gets the send button alone.
        this._annotBuildSend?.(p);

        // Info + hint.
        this._annotInfoEl = el("div", { className: "bepic-tool-hint" });
        p.appendChild(this._annotInfoEl);
        p.appendChild(toolHelp("How to annotate",
            "Pen / Arrow / Box: <b>drag</b>. Text: <b>click</b> &amp; type (Enter sets).<br>"
            + "Click a text to select it: <b>drag</b> moves, the corner square resizes, "
            + "<b>double-click</b> edits, a colour recolours, <b>Delete</b> removes.<br>"
            + "Right-click an annotation to delete.<br>"
            + "Export saves a PNG to <b>./output</b> and adds it to History — then drag it onto the graph."));

        this._annotSetTool(this._annot.tool);
        this._annotSetColor(this._annot.color);
        this._annotUpdateInfo();
    },

    _annotSetTool(t) {
        this._annot.tool = t;
        if (this._annotToolBtns)
            for (const k in this._annotToolBtns) this._annotToolBtns[k].classList.toggle("active", k === t);
        if (t !== "text") this._annotCommitText();
        this._updateToolCursor();
    },

    _annotSetColor(col) {
        this._annot.color = col;
        if (this._annotSwatches)
            this._annotSwatches.forEach(([s, c]) =>
                s.classList.toggle("sel", c.toLowerCase() === String(col).toLowerCase()));
        if (this._annotCustomColor && /^#[0-9a-f]{6}$/i.test(col)) this._annotCustomColor.value = col;
        if (this._annot.textInput) this._annot.textInput.style.color = col;
        const sel = this._annotSelected();
        if (sel && sel.type === "text" && sel.color !== col) { sel.color = col; this._annotAfterChange(); }
    },

    _annotUpdateInfo() {
        if (!this._annotInfoEl) return;
        const n = (this._annotItems(false) || []).length;
        let t = n === 1 ? "1 annotation" : `${n} annotations`;
        if (this._videoMode && n) t += ` (${this._annotVisible().length} on this frame)`;
        this._annotInfoEl.textContent = t;
    },

    // ── export → PNG → ./output → history ─────────────────────────────────────
    async _annotExport() {
        // A video exports the frame on screen with the marks that are on it.
        const src = this._videoMode ? this.videoBase : this.imgBase;
        const w = this._videoMode ? (src && src.videoWidth) : (src && src.naturalWidth);
        const h = this._videoMode ? (src && src.videoHeight) : (src && src.naturalHeight);
        if (!w || !h) { this._toolSetStatus("<b>Annotate:</b> no image to export"); return; }

        this._annotCommitText();
        const items = this._annotVisible();
        const dataurl = this._annotFlatten(src, w, h, items, this._annot.includeImage);
        if (!dataurl) { this._toolSetStatus("<b>Annotate:</b> image is cross-origin — can't export"); return; }

        const btn = this._annotExportBtn;
        if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
        try {
            const resp = await api.fetchApi("/bepic/save_annotation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Named and placed by the rule every export follows: the shot's
                // folder when the canvas names one, and the next version.
                body: JSON.stringify({ dataurl, filename_prefix: "bEpic_annotation",
                                       name: "annotation", context: canvasContext() }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
            this._annotAddToHistory(data);
            this._toolSetStatus("<b>Annotate:</b> exported to History — drag the new thumbnail onto the graph");
            notice("success", "Annotation exported",
                   "output/" + [data.subfolder, data.filename].filter(Boolean).join("/"));
        } catch (e) {
            console.error("[annot] export failed", e);
            this._toolSetStatus("<b>Annotate:</b> export failed");
            notice("error", "Annotation not exported", String((e && e.message) || e));
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "Export annotation"; }
        }
    },

    // The picture (when asked for) with `items` drawn into it, as a PNG data URL;
    // null when the browser will not let the picture be read back.
    _annotFlatten(src, w, h, items, includeImage = true) {
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (includeImage) {
            try { ctx.drawImage(src, 0, 0, w, h); }
            catch (e) { console.warn("[annot] drawImage failed", e); }
        }
        for (const it of items) this._annotDrawItemToCtx(ctx, it, w, h);
        try { return canvas.toDataURL("image/png"); } catch (e) { return null; }
    },

    // Save a flattened PNG the way "Export annotation" does; resolves to the
    // saved file ({filename, subfolder, type, path}).
    async _annotSavePng(dataurl, name) {
        const resp = await api.fetchApi("/bepic/save_annotation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataurl, filename_prefix: "bEpic_annotation",
                                   name: name || "annotation", context: canvasContext() }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
        return data;
    },

    _annotDrawItemToCtx(ctx, it, w, h) {
        const color = it.color || "#ff3b30";
        ctx.save();
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        if (it.type === "text") {
            const size = it.size || 42;
            ctx.font = `${size}px sans-serif`;
            ctx.textBaseline = "top";
            ctx.lineWidth = Math.max(1, size * 0.12);
            ctx.strokeStyle = "#000";
            ctx.fillStyle = color;
            textLines(it.text).forEach((line, i) => {
                const y = it.y * h + i * size * LINE_H;
                try { ctx.strokeText(line, it.x * w, y); } catch (_) {}
                ctx.fillText(line, it.x * w, y);
            });
            ctx.restore(); return;
        }
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.lineWidth = Math.max(1, it.width || 6);
        if (it.type === "pen") {
            if (it.pts.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(it.pts[0].x * w, it.pts[0].y * h);
                for (let i = 1; i < it.pts.length; i++) ctx.lineTo(it.pts[i].x * w, it.pts[i].y * h);
                ctx.stroke();
            }
            ctx.restore(); return;
        }
        const ax = it.a.x * w, ay = it.a.y * h, bx = it.b.x * w, by = it.b.y * h;
        if (it.type === "rect") {
            ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
            ctx.restore(); return;
        }
        if (it.type === "arrow") {
            ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
            const ang = Math.atan2(by - ay, bx - ax);
            const head = Math.max(10, (it.width || 6) * 3.2);
            const wing = Math.PI / 7;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx - head * Math.cos(ang - wing), by - head * Math.sin(ang - wing));
            ctx.lineTo(bx - head * Math.cos(ang + wing), by - head * Math.sin(ang + wing));
            ctx.closePath(); ctx.fill();
        }
        ctx.restore();
    },

    _annotAddToHistory(saved) {
        const key = this.activeTab;
        if (!key || !saved || !saved.filename) return;
        const frame = {
            filename: saved.filename,
            subfolder: saved.subfolder || "",
            type: saved.type || "output",
            path: saved.path || null,
            name: saved.filename,
        };
        if (!this.history[key]) this.history[key] = [];
        // Always a new entry (each save writes its own file), so this doesn't go
        // through pushHistorySnapshot's de-dupe — but the cap still has to release
        // whatever falls off the end.
        this.history[key].unshift([frame]);
        this.trimHistory(key);

        const panel = this.historyPanel || this.shadowRoot.getElementById("history-panel");
        if (panel) panel.style.display = "flex";
        if (this._syncHistoryToggleState) this._syncHistoryToggleState();
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        if (this.queuePersistViewerState) this.queuePersistViewerState();
    },
};
