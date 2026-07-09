// bEpicViewer_roto.js
// RotoMixin — the in-viewer Roto tool (modelled on Nuke's Roto node).
//
// Data model (serialized to the send-node's roto_data widget, consumed by
// roto_raster.py). All coordinates are normalized [0,1] relative to the image:
//   layer = {
//     id, name, visible, invert, feather, blur, dilate, opacity, closed:true,
//     transform:{tx,ty,rot,sx,sy,px,py},
//     points:[ {x,y, cin?:{x,y}, cout?:{x,y}, feather?:{x,y}} ],
//     keyframes?:{ "<frame>":[points] }
//   }
//   roto = { version:1, layers:[...], global:{invert,blur,dilate,feather} }
//
// Interaction is drawn in screen space via ToolsMixin's _normToDraw so shapes
// track zoom/pan/fit. Editing writes raw (untransformed) points; the shape
// transform + keyframe interpolation are applied for display and re-applied
// identically in Python at render time.

import { svgEl } from "./bEpicViewer_tools.js";
import { readToolStore, writeToolStore, ROTO_WIDGET } from "./bEpicViewer_nodeTools.js";

const HIT = 9;             // screen-px hit radius
const DEF_TF = () => ({ tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, px: 0.5, py: 0.5 });
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

let _rotoIdSeq = 1;

export const RotoMixin = {

    _rotoInit() {
        this._roto = {
            layers: [], global: { invert: false, blur: 0, dilate: 0, feather: 0 },
            selLayer: -1, selPts: new Set(), mode: "edit",
            showMask: false, autokey: false, featherKey: false,
            drawing: null, drag: null,
        };
        // Track the F key for per-point feather dragging.
        this._rotoKeyHandler = (e) => {
            if (e.key === "f" || e.key === "F") this._roto.featherKey = (e.type === "keydown");
        };
        window.addEventListener("keydown", this._rotoKeyHandler);
        window.addEventListener("keyup", this._rotoKeyHandler);
    },

    _rotoClearState() {
        if (!this._roto) return;
        this._roto.layers = [];
        this._roto.global = { invert: false, blur: 0, dilate: 0, feather: 0 };
        this._roto.selLayer = -1;
        this._roto.selPts = new Set();
        this._roto.drawing = null;
    },

    _rotoLoadFromNode(node) {
        this._rotoClearState();
        let raw = readToolStore(node, ROTO_WIDGET, "");
        if (!raw) { this._rotoRefreshPanel?.(); return; }
        try {
            const obj = JSON.parse(raw);
            if (obj && Array.isArray(obj.layers)) {
                this._roto.layers = obj.layers.map(normalizeLayer);
                if (obj.global) Object.assign(this._roto.global, obj.global);
                this._roto.selLayer = this._roto.layers.length ? 0 : -1;
            }
        } catch (e) { /* ignore malformed */ }
        this._rotoRefreshPanel?.();
    },

    _rotoSave() {
        const node = this._toolState.node;
        if (!node) return;
        const payload = {
            version: 1,
            layers: this._roto.layers,
            global: this._roto.global,
        };
        writeToolStore(node, ROTO_WIDGET, payload);
    },

    // ── activation / panel ────────────────────────────────────────────────────
    _rotoActivate(panel) {
        this._rotoPanel = panel;
        this._rotoBuildPanel();
    },

    _rotoDeactivate() {
        this._roto.drawing = null;
        this._roto.drag = null;
    },

    _rotoCurLayer() {
        const i = this._roto.selLayer;
        return (i >= 0 && i < this._roto.layers.length) ? this._roto.layers[i] : null;
    },

    _rotoAddLayer() {
        const layer = normalizeLayer({
            id: "l" + (_rotoIdSeq++),
            name: "Shape " + (this._roto.layers.length + 1),
            points: [],
        });
        this._roto.layers.push(layer);
        this._roto.selLayer = this._roto.layers.length - 1;
        this._roto.selPts = new Set();
        this._roto.drawing = layer;      // begin drawing this shape
        this._roto.mode = "draw";
        this._rotoRefreshPanel();
        this._toolRedraw();
    },

    _rotoDeleteLayer(i) {
        if (i < 0 || i >= this._roto.layers.length) return;
        this._roto.layers.splice(i, 1);
        if (this._roto.selLayer >= this._roto.layers.length) this._roto.selLayer = this._roto.layers.length - 1;
        this._roto.selPts = new Set();
        this._roto.drawing = null;
        this._rotoSave();
        this._rotoRefreshPanel();
        this._toolRedraw();
    },

    _rotoBuildPanel() {
        const p = this._rotoPanel;
        p.innerHTML = "";
        p.appendChild(el("h4", "Roto"));

        if (!this._toolState.node) {
            p.appendChild(el("div", "Active tab has no 'Send to bEpic Viewer' node, so roto can't be saved. Switch to a tab produced by that node.", "bepic-tool-hint"));
            return;
        }

        // Mode buttons
        const modeRow = el("div", "", "row");
        this._rotoModeBtns = {};
        for (const m of ["draw", "edit", "transform"]) {
            const b = el("button", m[0].toUpperCase() + m.slice(1), "bepic-act");
            b.style.flex = "1";
            b.onclick = () => { this._roto.mode = m; if (m !== "draw") this._roto.drawing = null; this._rotoRefreshModeBtns(); this._toolRedraw(); };
            this._rotoModeBtns[m] = b;
            modeRow.appendChild(b);
        }
        p.appendChild(modeRow);

        // Layer list
        this._rotoLayerList = el("div", "", "bepic-layer-list");
        p.appendChild(this._rotoLayerList);

        const layBtns = el("div", "", "row");
        const addB = el("button", "+ Shape", "bepic-act"); addB.style.flex = "1";
        addB.onclick = () => this._rotoAddLayer();
        const delB = el("button", "Delete", "bepic-act bepic-danger"); delB.style.flex = "1";
        delB.onclick = () => this._rotoDeleteLayer(this._roto.selLayer);
        layBtns.appendChild(addB); layBtns.appendChild(delB);
        p.appendChild(layBtns);

        // Per-shape sliders
        this._rotoShapeControls = el("div");
        p.appendChild(this._rotoShapeControls);

        // Keyframe controls
        const kfWrap = el("div");
        kfWrap.appendChild(el("h4", "Keyframes"));
        const kfRow = el("div", "", "row");
        const setK = el("button", "Set Key", "bepic-act"); setK.style.flex = "1";
        setK.onclick = () => this._rotoSetKey();
        const delK = el("button", "Del Key", "bepic-act"); delK.style.flex = "1";
        delK.onclick = () => this._rotoDelKey();
        kfRow.appendChild(setK); kfRow.appendChild(delK);
        kfWrap.appendChild(kfRow);
        this._rotoAutokeyCb = checkbox("Autokey", false, (v) => { this._roto.autokey = v; });
        kfWrap.appendChild(this._rotoAutokeyCb.row);
        this._rotoKfInfo = el("div", "", "bepic-tool-hint");
        kfWrap.appendChild(this._rotoKfInfo);
        p.appendChild(kfWrap);

        // Global controls
        p.appendChild(el("h4", "Global matte"));
        p.appendChild(slider("Feather", 0, 100, this._roto.global.feather, (v) => { this._roto.global.feather = v; this._rotoSave(); }));
        p.appendChild(slider("Blur", 0, 100, this._roto.global.blur, (v) => { this._roto.global.blur = v; this._rotoSave(); }));
        p.appendChild(slider("Dilate", -50, 50, this._roto.global.dilate, (v) => { this._roto.global.dilate = v; this._rotoSave(); }));
        this._rotoGlobalInvCb = checkbox("Invert all", this._roto.global.invert, (v) => { this._roto.global.invert = v; this._rotoSave(); });
        p.appendChild(this._rotoGlobalInvCb.row);

        // Preview toggle + hint
        this._rotoPreviewCb = checkbox("Show mask preview", this._roto.showMask, (v) => { this._roto.showMask = v; this._toolRedraw(); });
        p.appendChild(this._rotoPreviewCb.row);
        p.appendChild(el("div",
            "Draw: click to add points, drag to curve, click first point to close. " +
            "Edit: drag points/handles, Alt+click edge adds a point, R-click deletes, hold F+drag sets feather. " +
            "Alt+drag pans.", "bepic-tool-hint"));

        this._rotoRefreshModeBtns();
        this._rotoRefreshLayerList();
        this._rotoRefreshShapeControls();
        this._rotoRefreshKfInfo();
    },

    _rotoRefreshPanel() {
        if (this._toolState.active === "roto" && this._rotoPanel) this._rotoBuildPanel();
    },

    _rotoRefreshModeBtns() {
        if (!this._rotoModeBtns) return;
        for (const m in this._rotoModeBtns)
            this._rotoModeBtns[m].classList.toggle("active", this._roto.mode === m);
    },

    _rotoRefreshLayerList() {
        const list = this._rotoLayerList;
        if (!list) return;
        list.innerHTML = "";
        this._roto.layers.forEach((layer, i) => {
            const row = el("div", "", "bepic-layer-row" + (i === this._roto.selLayer ? " sel" : ""));
            const vis = el("span", layer.visible ? "◉" : "◎", "vis");
            vis.onclick = (e) => { e.stopPropagation(); layer.visible = !layer.visible; this._rotoSave(); this._rotoRefreshLayerList(); this._toolRedraw(); };
            const nm = el("span", layer.name || ("Shape " + (i + 1)), "nm");
            nm.ondblclick = (e) => {
                e.stopPropagation();
                const v = prompt("Shape name:", layer.name || "");
                if (v != null) { layer.name = v; this._rotoSave(); this._rotoRefreshLayerList(); }
            };
            const del = el("span", "✕", "del");
            del.onclick = (e) => { e.stopPropagation(); this._rotoDeleteLayer(i); };
            row.appendChild(vis); row.appendChild(nm); row.appendChild(del);
            row.onclick = () => {
                this._roto.selLayer = i; this._roto.selPts = new Set();
                if (this._roto.mode === "draw") this._roto.mode = "edit";
                this._rotoRefreshLayerList(); this._rotoRefreshShapeControls();
                this._rotoRefreshKfInfo(); this._rotoRefreshModeBtns(); this._toolRedraw();
            };
            list.appendChild(row);
        });
    },

    _rotoRefreshShapeControls() {
        const box = this._rotoShapeControls;
        if (!box) return;
        box.innerHTML = "";
        const layer = this._rotoCurLayer();
        if (!layer) return;
        box.appendChild(el("h4", "Shape matte"));
        box.appendChild(slider("Feather", 0, 100, layer.feather, (v) => { layer.feather = v; this._rotoSave(); }));
        box.appendChild(slider("Blur", 0, 100, layer.blur, (v) => { layer.blur = v; this._rotoSave(); }));
        box.appendChild(slider("Dilate", -50, 50, layer.dilate, (v) => { layer.dilate = v; this._rotoSave(); }));
        box.appendChild(slider("Opacity", 0, 100, Math.round(layer.opacity * 100), (v) => { layer.opacity = v / 100; this._rotoSave(); this._toolRedraw(); }));
        const inv = checkbox("Invert shape", layer.invert, (v) => { layer.invert = v; this._rotoSave(); });
        box.appendChild(inv.row);

        box.appendChild(el("h4", "Transform"));
        box.appendChild(numRow("Rotate°", layer.transform.rot, 1, (v) => { layer.transform.rot = v; this._rotoSave(); this._toolRedraw(); }));
        box.appendChild(numRow("Scale", layer.transform.sx, 0.01, (v) => { layer.transform.sx = layer.transform.sy = v; this._rotoSave(); this._toolRedraw(); }));
        const resetT = el("button", "Reset transform", "bepic-act");
        resetT.onclick = () => { layer.transform = DEF_TF(); this._rotoSave(); this._rotoRefreshShapeControls(); this._toolRedraw(); };
        box.appendChild(resetT);
    },

    _rotoRefreshKfInfo() {
        if (!this._rotoKfInfo) return;
        const layer = this._rotoCurLayer();
        const f = this._rotoFrame();
        if (!layer) { this._rotoKfInfo.textContent = ""; return; }
        const keys = layer.keyframes ? Object.keys(layer.keyframes).map(Number).sort((a, b) => a - b) : [];
        this._rotoKfInfo.innerHTML = keys.length
            ? `Frame ${f} · keys: ${keys.join(", ")}`
            : `Frame ${f} · static (no keys)`;
    },

    _rotoFrame() { return Math.max(0, Math.round(this.currentFrame || 0)); },

    // ── keyframe helpers ──────────────────────────────────────────────────────
    _rotoRawPoints(layer, frame) {
        const kfs = layer.keyframes;
        if (!kfs || Object.keys(kfs).length === 0) return layer.points || [];
        const frames = Object.keys(kfs).map(Number).sort((a, b) => a - b);
        if (frame <= frames[0]) return kfs[frames[0]];
        if (frame >= frames[frames.length - 1]) return kfs[frames[frames.length - 1]];
        let lo = frames[0], hi = frames[frames.length - 1];
        for (const fr of frames) { if (fr <= frame) lo = fr; if (fr >= frame) { hi = fr; break; } }
        if (hi === lo) return kfs[lo];
        const a = kfs[lo], b = kfs[hi];
        if (a.length !== b.length) return (frame - lo) <= (hi - frame) ? a : b;
        const t = (frame - lo) / (hi - lo);
        return a.map((pa, i) => interpPoint(pa, b[i], t));
    },

    // The array of raw points that edits should mutate for the current frame.
    _rotoEditablePoints(layer) {
        const f = this._rotoFrame();
        const animated = layer.keyframes && Object.keys(layer.keyframes).length > 0;
        if (animated) {
            if (!layer.keyframes[f]) layer.keyframes[f] = clonePoints(this._rotoRawPoints(layer, f));
            return layer.keyframes[f];
        }
        if (this._roto.autokey && f > 0) {
            layer.keyframes = layer.keyframes || {};
            layer.keyframes[f] = clonePoints(layer.points);
            // also anchor a key at 0 so interpolation has a start
            if (!layer.keyframes[0]) layer.keyframes[0] = clonePoints(layer.points);
            return layer.keyframes[f];
        }
        return layer.points;
    },

    _rotoSetKey() {
        const layer = this._rotoCurLayer();
        if (!layer) return;
        const f = this._rotoFrame();
        layer.keyframes = layer.keyframes || {};
        layer.keyframes[f] = clonePoints(this._rotoRawPoints(layer, f));
        this._rotoSave(); this._rotoRefreshKfInfo(); this._toolRedraw();
    },

    _rotoDelKey() {
        const layer = this._rotoCurLayer();
        if (!layer || !layer.keyframes) return;
        const f = this._rotoFrame();
        delete layer.keyframes[f];
        if (Object.keys(layer.keyframes).length === 0) delete layer.keyframes;
        this._rotoSave(); this._rotoRefreshKfInfo(); this._toolRedraw();
    },

    // ── transform (pixel-space, matches Python) ───────────────────────────────
    _rotoApplyTf(pt, tf) {
        const { w, h } = this._toolImgSize();
        if (!w || !h || !tf) return pt;
        let x = pt.x * w, y = pt.y * h;
        const px = tf.px * w, py = tf.py * h;
        let dx = (x - px) * tf.sx, dy = (y - py) * tf.sy;
        if (tf.rot) {
            const r = tf.rot * Math.PI / 180, ca = Math.cos(r), sa = Math.sin(r);
            [dx, dy] = [dx * ca - dy * sa, dx * sa + dy * ca];
        }
        x = dx + px + tf.tx * w; y = dy + py + tf.ty * h;
        return { x: x / w, y: y / h };
    },

    _rotoInvTf(pt, tf) {
        const { w, h } = this._toolImgSize();
        if (!w || !h || !tf) return pt;
        let x = pt.x * w, y = pt.y * h;
        const px = tf.px * w, py = tf.py * h;
        let dx = x - px - tf.tx * w, dy = y - py - tf.ty * h;
        if (tf.rot) {
            const r = -tf.rot * Math.PI / 180, ca = Math.cos(r), sa = Math.sin(r);
            [dx, dy] = [dx * ca - dy * sa, dx * sa + dy * ca];
        }
        dx /= (tf.sx || 1); dy /= (tf.sy || 1);
        return { x: (dx + px) / w, y: (dy + py) / h };
    },

    _rotoDisplayPoints(layer) {
        const raw = this._rotoRawPoints(layer, this._rotoFrame());
        const tf = layer.transform;
        return raw.map((p) => {
            const d = { ...this._rotoApplyTf({ x: p.x, y: p.y }, tf) };
            if (p.cin) d.cin = this._rotoApplyTf(p.cin, tf);
            if (p.cout) d.cout = this._rotoApplyTf(p.cout, tf);
            if (p.feather) d.feather = this._rotoApplyTf(p.feather, tf);
            return d;
        });
    },

    // ── rendering ─────────────────────────────────────────────────────────────
    _rotoRender() {
        const draw = this._toolDraw;
        const activeLayer = this._rotoCurLayer();

        // Mask preview (approximate): filled paths of all visible layers.
        if (this._roto.showMask) {
            for (const layer of this._roto.layers) {
                if (!layer.visible) continue;
                const d = this._rotoPathD(this._rotoDisplayPoints(layer), true);
                if (d) draw.appendChild(svgEl("path", {
                    d, fill: layer.invert ? "rgba(255,255,255,.12)" : "rgba(255,120,0,.28)",
                    stroke: "none",
                }));
            }
        }

        // Outlines for every layer; handles only for the selected one.
        this._roto.layers.forEach((layer, li) => {
            if (!layer.visible && li !== this._roto.selLayer) return;
            const dpts = this._rotoDisplayPoints(layer);
            const isSel = li === this._roto.selLayer;
            const closed = !(this._roto.drawing === layer);
            const d = this._rotoPathD(dpts, closed);
            if (d) draw.appendChild(svgEl("path", {
                d, fill: "none",
                stroke: isSel ? "#ff8a00" : "rgba(255,255,255,.55)",
                "stroke-width": isSel ? 1.6 : 1.2,
                "stroke-dasharray": this._roto.drawing === layer ? "4 3" : "none",
            }));
            if (!isSel) return;

            // Transform mode: bounding box
            if (this._roto.mode === "transform") this._rotoRenderTransformBox(dpts, layer);

            // Points + handles
            dpts.forEach((p, i) => {
                const scr = this._normToDraw(p.x, p.y);
                if (!scr) return;
                const selected = this._roto.selPts.has(i);

                // tangent + feather handles for selected points
                if (selected && this._roto.mode === "edit") {
                    for (const hk of ["cin", "cout"]) {
                        if (!p[hk]) continue;
                        const hs = this._normToDraw(p[hk].x, p[hk].y);
                        if (!hs) continue;
                        draw.appendChild(svgEl("line", { x1: scr.x, y1: scr.y, x2: hs.x, y2: hs.y, stroke: "#6cf", "stroke-width": 1 }));
                        draw.appendChild(svgEl("circle", { cx: hs.x, cy: hs.y, r: 3.5, fill: "#6cf", stroke: "#000", "stroke-width": 1, "data-h": hk, "data-i": i }));
                    }
                    if (p.feather) {
                        const fs = this._normToDraw(p.feather.x, p.feather.y);
                        if (fs) {
                            draw.appendChild(svgEl("line", { x1: scr.x, y1: scr.y, x2: fs.x, y2: fs.y, stroke: "#c9a", "stroke-width": 1, "stroke-dasharray": "3 2" }));
                            draw.appendChild(diamond(fs.x, fs.y, 4, "#e6a9ff"));
                        }
                    }
                }

                const sq = svgEl("rect", {
                    x: scr.x - 3.5, y: scr.y - 3.5, width: 7, height: 7,
                    fill: selected ? "#ff8a00" : "#fff", stroke: "#000", "stroke-width": 1,
                });
                draw.appendChild(sq);
            });
        });
    },

    _rotoRenderTransformBox(dpts, layer) {
        if (dpts.length < 2) return;
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (const p of dpts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
        const a = this._normToDraw(minX, minY), b = this._normToDraw(maxX, maxY);
        if (!a || !b) return;
        this._toolDraw.appendChild(svgEl("rect", {
            x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
            fill: "rgba(255,138,0,.06)", stroke: "#ff8a00", "stroke-width": 1, "stroke-dasharray": "5 3",
        }));
        // pivot marker
        const pv = this._normToDraw(layer.transform.px, layer.transform.py);
        if (pv) {
            this._toolDraw.appendChild(svgEl("circle", { cx: pv.x, cy: pv.y, r: 5, fill: "none", stroke: "#ff8a00", "stroke-width": 1 }));
            this._toolDraw.appendChild(svgEl("line", { x1: pv.x - 7, y1: pv.y, x2: pv.x + 7, y2: pv.y, stroke: "#ff8a00" }));
            this._toolDraw.appendChild(svgEl("line", { x1: pv.x, y1: pv.y - 7, x2: pv.x, y2: pv.y + 7, stroke: "#ff8a00" }));
        }
    },

    // Build an SVG path (screen coords) from display points with bezier tangents.
    _rotoPathD(dpts, closed) {
        if (!dpts || dpts.length < 2) {
            if (dpts && dpts.length === 1) {
                const s = this._normToDraw(dpts[0].x, dpts[0].y);
                return s ? `M ${s.x} ${s.y}` : null;
            }
            return null;
        }
        const S = (p) => this._normToDraw(p.x, p.y);
        const n = dpts.length;
        const start = S(dpts[0]);
        if (!start) return null;
        let d = `M ${start.x} ${start.y}`;
        const segCount = closed ? n : n - 1;
        for (let i = 0; i < segCount; i++) {
            const p0 = dpts[i], p1 = dpts[(i + 1) % n];
            const a = S(p0), b = S(p1);
            if (!a || !b) continue;
            const c0 = p0.cout ? S(p0.cout) : null;
            const c1 = p1.cin ? S(p1.cin) : null;
            if (c0 && c1) d += ` C ${c0.x} ${c0.y} ${c1.x} ${c1.y} ${b.x} ${b.y}`;
            else if (c0) d += ` Q ${c0.x} ${c0.y} ${b.x} ${b.y}`;
            else if (c1) d += ` Q ${c1.x} ${c1.y} ${b.x} ${b.y}`;
            else d += ` L ${b.x} ${b.y}`;
        }
        if (closed) d += " Z";
        return d;
    },

    // ── pointer handling ──────────────────────────────────────────────────────
    _rotoPointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return;
        const mode = this._roto.mode;

        if (mode === "draw") return this._rotoDrawDown(e, n);
        if (mode === "transform") return this._rotoTransformDown(e, n);
        return this._rotoEditDown(e, n);
    },

    _rotoDrawDown(e, n) {
        let layer = this._roto.drawing;
        if (!layer) {
            // start a fresh shape if none in progress
            this._rotoAddLayer();
            layer = this._roto.drawing;
        }
        const pts = layer.points;

        // Close the shape by clicking near the first point.
        if (pts.length >= 3) {
            const first = this._rotoApplyTf(pts[0], layer.transform);
            if (this._screenDist(n, first) <= HIT) {
                this._roto.drawing = null;
                this._roto.mode = "edit";
                this._rotoSave(); this._rotoRefreshModeBtns(); this._rotoRefreshKfInfo(); this._toolRedraw();
                return;
            }
        }

        // Add a point; drag to pull out symmetric bezier handles.
        const raw = this._rotoInvTf({ x: clamp01(n.x), y: clamp01(n.y) }, layer.transform);
        const pt = { x: raw.x, y: raw.y };
        pts.push(pt);
        const idx = pts.length - 1;
        this._toolRedraw();

        let dragged = false;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, layer.transform);
                dragged = true;
                pt.cout = { x: rawM.x, y: rawM.y };
                pt.cin = { x: 2 * pt.x - rawM.x, y: 2 * pt.y - rawM.y }; // mirror
                this._toolRedraw();
            },
            () => { if (dragged) this._rotoSave(); else this._rotoSave(); this._toolRedraw(); },
        );
    },

    _rotoEditDown(e, n) {
        const layer = this._rotoCurLayer();
        if (!layer) return;
        const tf = layer.transform;
        const dpts = this._rotoDisplayPoints(layer);
        const editPts = this._rotoEditablePoints(layer);

        // 1) tangent / feather handle hit (selected points only)
        for (const i of this._roto.selPts) {
            const p = dpts[i];
            if (!p) continue;
            for (const hk of ["cin", "cout", "feather"]) {
                if (!p[hk]) continue;
                if (this._screenDist(n, p[hk]) <= HIT) return this._rotoDragHandle(e, layer, editPts, i, hk);
            }
        }

        // 2) point hit
        let hitIdx = -1;
        for (let i = dpts.length - 1; i >= 0; i--) {
            if (this._screenDist(n, dpts[i]) <= HIT) { hitIdx = i; break; }
        }

        if (hitIdx >= 0) {
            // right-click / ctrl deletes
            if (e.button === 2 || e.ctrlKey) {
                editPts.splice(hitIdx, 1);
                this._roto.selPts = new Set();
                if (editPts.length < 2) { /* keep shape but degenerate */ }
                this._rotoSave(); this._toolRedraw();
                return;
            }
            // F+drag creates/moves a feather handle
            if (this._roto.featherKey) return this._rotoDragFeatherCreate(e, layer, editPts, hitIdx);

            if (e.shiftKey) {
                if (this._roto.selPts.has(hitIdx)) this._roto.selPts.delete(hitIdx);
                else this._roto.selPts.add(hitIdx);
            } else if (!this._roto.selPts.has(hitIdx)) {
                this._roto.selPts = new Set([hitIdx]);
            }
            this._rotoRefreshShapeControls?.();
            return this._rotoDragPoints(e, layer, editPts, n);
        }

        // 3) Alt+click on an edge inserts a point
        if (e.altKey) {
            const seg = this._rotoNearestSegment(dpts, n);
            if (seg && seg.dist <= HIT * 1.6) {
                const rawInsert = this._rotoInvTf(seg.point, tf);
                editPts.splice(seg.i + 1, 0, { x: rawInsert.x, y: rawInsert.y });
                this._roto.selPts = new Set([seg.i + 1]);
                this._rotoSave(); this._toolRedraw();
                return;
            }
        }

        // 4) empty: clear selection
        this._roto.selPts = new Set();
        this._toolRedraw();
    },

    _rotoDragPoints(e, layer, editPts, startNorm) {
        const tf = layer.transform;
        const startRaw = this._rotoInvTf(startNorm, tf);
        const origin = {};
        for (const i of this._roto.selPts) origin[i] = clonePoint(editPts[i]);
        let moved = false;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, tf);
                const dx = rawM.x - startRaw.x, dy = rawM.y - startRaw.y;
                moved = true;
                for (const i of this._roto.selPts) {
                    const o = origin[i]; if (!o) continue;
                    editPts[i].x = clamp01(o.x + dx); editPts[i].y = clamp01(o.y + dy);
                    for (const hk of ["cin", "cout", "feather"]) {
                        if (o[hk]) editPts[i][hk] = { x: o[hk].x + dx, y: o[hk].y + dy };
                    }
                }
                this._toolRedraw();
            },
            () => { if (moved) { this._rotoSave(); this._rotoRefreshKfInfo(); } this._toolRedraw(); },
        );
    },

    _rotoDragHandle(e, layer, editPts, i, hk) {
        const tf = layer.transform;
        const broken = e.altKey;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, tf);
                editPts[i][hk] = { x: rawM.x, y: rawM.y };
                // smooth: mirror the opposite tangent unless broken
                if ((hk === "cin" || hk === "cout") && !broken) {
                    const other = hk === "cin" ? "cout" : "cin";
                    const a = editPts[i];
                    a[other] = { x: 2 * a.x - rawM.x, y: 2 * a.y - rawM.y };
                }
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
    },

    _rotoDragFeatherCreate(e, layer, editPts, i) {
        const tf = layer.transform;
        this._roto.selPts = new Set([i]);
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, tf);
                editPts[i].feather = { x: rawM.x, y: rawM.y };
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
    },

    _rotoTransformDown(e, n) {
        const layer = this._rotoCurLayer();
        if (!layer) return;
        const tf = layer.transform;
        const startTx = tf.tx, startTy = tf.ty;
        const start = { x: n.x, y: n.y };
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                tf.tx = startTx + (m.x - start.x);
                tf.ty = startTy + (m.y - start.y);
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
    },

    _rotoNearestSegment(dpts, n) {
        if (dpts.length < 2) return null;
        let best = null;
        for (let i = 0; i < dpts.length; i++) {
            const a = dpts[i], b = dpts[(i + 1) % dpts.length];
            const cand = projectToSeg(n, a, b);
            const dist = this._screenDist(n, cand);
            if (!best || dist < best.dist) best = { i, point: cand, dist };
        }
        return best;
    },
};

// ── module-local helpers ──────────────────────────────────────────────────────

function normalizeLayer(l) {
    return {
        id: l.id || ("l" + (_rotoIdSeq++)),
        name: l.name || "Shape",
        visible: l.visible !== false,
        invert: !!l.invert,
        feather: +l.feather || 0,
        blur: +l.blur || 0,
        dilate: +l.dilate || 0,
        opacity: l.opacity == null ? 1 : +l.opacity,
        closed: true,
        transform: Object.assign(DEF_TF(), l.transform || {}),
        points: Array.isArray(l.points) ? l.points.map(clonePoint) : [],
        keyframes: l.keyframes && typeof l.keyframes === "object"
            ? Object.fromEntries(Object.entries(l.keyframes).map(([k, v]) => [k, (v || []).map(clonePoint)]))
            : undefined,
    };
}

function clonePoint(p) {
    const o = { x: +p.x, y: +p.y };
    if (p.cin) o.cin = { x: +p.cin.x, y: +p.cin.y };
    if (p.cout) o.cout = { x: +p.cout.x, y: +p.cout.y };
    if (p.feather) o.feather = { x: +p.feather.x, y: +p.feather.y };
    return o;
}

function clonePoints(arr) { return (arr || []).map(clonePoint); }

function interpPoint(a, b, t) {
    const o = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    for (const hk of ["cin", "cout", "feather"]) {
        if (a[hk] || b[hk]) {
            const da = a[hk] || { x: a.x, y: a.y };
            const db = b[hk] || { x: b.x, y: b.y };
            o[hk] = { x: lerp(da.x, db.x, t), y: lerp(da.y, db.y, t) };
        }
    }
    return o;
}

function projectToSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return { x: a.x + abx * t, y: a.y + aby * t };
}

// small DOM builders
function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) { if (/[<>]/.test(text) && tag !== "button") e.innerHTML = text; else e.textContent = text; }
    return e;
}

function diamond(x, y, r, fill) {
    return svgEl("polygon", {
        points: `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`,
        fill, stroke: "#000", "stroke-width": 1,
    });
}

function slider(label, min, max, value, onInput) {
    const row = el("div", "", "row");
    row.appendChild(el("label", label));
    const rng = document.createElement("input");
    rng.type = "range"; rng.min = min; rng.max = max; rng.value = value;
    const num = document.createElement("span");
    num.textContent = value; num.style.cssText = "width:30px;text-align:right;color:#0ce;";
    rng.oninput = () => { num.textContent = rng.value; onInput(parseFloat(rng.value)); };
    row.appendChild(rng); row.appendChild(num);
    return row;
}

function numRow(label, value, step, onChange) {
    const row = el("div", "", "row");
    row.appendChild(el("label", label));
    const num = document.createElement("input");
    num.type = "number"; num.step = step; num.value = value;
    num.onchange = () => onChange(parseFloat(num.value) || 0);
    row.appendChild(num);
    return row;
}

function checkbox(label, checked, onChange) {
    const row = el("div", "", "row");
    row.appendChild(el("label", label));
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!checked;
    cb.onchange = () => onChange(cb.checked);
    row.appendChild(cb);
    return { row, cb };
}
