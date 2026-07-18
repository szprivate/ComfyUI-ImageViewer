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
        // One unified interaction (no draw/edit/transform mode switch): the
        // pointer's target decides the action. `drawing` holds the layer whose
        // outline is still being laid down; a multi-point `selPts` selection
        // shows a transform box.
        this._roto = {
            layers: [], global: { invert: false, blur: 0, dilate: 0, feather: 0 },
            selLayer: -1, selPts: new Set(),
            showMask: false, autokey: false,
            drawing: null, drag: null,
        };
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
            "<b>+ Shape</b>, then click to add points (drag to curve); click the first point to close. " +
            "After closing: drag a vertex to move it, single-click shows its tangents, " +
            "<b>Ctrl+drag</b> a vertex pulls feather, right-click a vertex deletes, Alt+click an edge inserts. " +
            "Drag from empty space across points to select them, then drag inside the box to move, " +
            "corners to scale, outside to rotate. Middle-drag pans.", "bepic-tool-hint"));

        this._rotoRefreshLayerList();
        this._rotoRefreshShapeControls();
        this._rotoRefreshKfInfo();
    },

    _rotoRefreshPanel() {
        if (this._toolState.active === "roto" && this._rotoPanel) this._rotoBuildPanel();
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
                this._roto.drawing = null;   // switching shapes ends any in-progress draw
                this._rotoRefreshLayerList(); this._rotoRefreshShapeControls();
                this._rotoRefreshKfInfo(); this._toolRedraw();
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

        // Mask preview: soft-edged fill of every visible layer, including the
        // per-point feather contour (see _rotoRenderPreview).
        if (this._roto.showMask) {
            for (const layer of this._roto.layers) {
                if (!layer.visible) continue;
                this._rotoRenderPreview(layer);
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

            // Tangent / feather handles only when a single point is selected, so a
            // click reveals its curve controls; a multi-selection shows the box.
            const showHandles = this._roto.selPts.size < 2 && this._roto.drawing !== layer;

            dpts.forEach((p, i) => {
                const scr = this._normToDraw(p.x, p.y);
                if (!scr) return;
                const selected = this._roto.selPts.has(i);

                if (selected && showHandles) {
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

            // Transform box around a multi-point selection.
            if (this._roto.selPts.size >= 2) {
                const box = this._rotoSelBox(dpts);
                if (box) this._rotoRenderSelBox(box);
            }
        });
    },

    // Preview one layer's matte: the feather contour (if any per-point feather)
    // under the core shape, both softened by an SVG blur sized from the feather
    // amount — an approximation of roto_raster.py's contour + distance ramp.
    _rotoRenderPreview(layer) {
        const draw = this._toolDraw;
        const dpts = this._rotoDisplayPoints(layer);
        const core = this._rotoPathD(dpts, true);
        if (!core) return;

        let parent = draw;
        const blur = this._rotoFeatherScreenPx(layer, dpts);
        if (blur > 0.3) {
            let defs = draw.querySelector("defs.bepic-rf-defs");
            if (!defs) { defs = svgEl("defs", { class: "bepic-rf-defs" }); draw.appendChild(defs); }
            const fid = "bepic-rf-" + (layer.id || "x");
            const filt = svgEl("filter", { id: fid, x: "-40%", y: "-40%", width: "180%", height: "180%" });
            filt.appendChild(svgEl("feGaussianBlur", { in: "SourceGraphic", stdDeviation: blur.toFixed(2) }));
            defs.appendChild(filt);
            parent = svgEl("g", { filter: `url(#${fid})` });
            draw.appendChild(parent);
        }

        if (dpts.some((p) => p.feather)) {
            const fd = this._rotoPathD(this._rotoFeatherPts(dpts), true);
            if (fd) parent.appendChild(svgEl("path", {
                d: fd, stroke: "none",
                fill: layer.invert ? "rgba(255,255,255,.06)" : "rgba(255,120,0,.16)",
            }));
        }
        parent.appendChild(svgEl("path", {
            d: core, stroke: "none",
            fill: layer.invert ? "rgba(255,255,255,.16)" : "rgba(255,120,0,.34)",
        }));
    },

    // Feather contour points: each vertex replaced by its feather point (falling
    // back to the vertex), keeping the original tangents — mirrors the Python
    // _contour(use_feather=True) so the preview matches the rendered matte.
    _rotoFeatherPts(dpts) {
        return dpts.map((p) => {
            const b = p.feather || p;
            const o = { x: b.x, y: b.y };
            if (p.cin) o.cin = p.cin;
            if (p.cout) o.cout = p.cout;
            return o;
        });
    },

    // Approximate feather softness in screen px: mean per-point feather offset
    // plus the shape/global feather sliders (image px → screen px), matching how
    // roto_raster.py combines them.
    _rotoFeatherScreenPx(layer, dpts) {
        let sum = 0, count = 0;
        for (const p of dpts) {
            if (!p.feather) continue;
            const a = this._normToClient(p.x, p.y);
            const b = this._normToClient(p.feather.x, p.feather.y);
            if (a && b) { sum += Math.hypot(a.x - b.x, a.y - b.y); count++; }
        }
        const perPoint = count ? (sum / count) : 0;

        const o = this._normToClient(0, 0), ex = this._normToClient(1, 0);
        const { w } = this._toolImgSize();
        const screenPerImgPx = (o && ex && w > 0) ? (Math.hypot(ex.x - o.x, ex.y - o.y) / w) : 0;
        const sliderPx = ((+layer.feather || 0) + (+this._roto.global.feather || 0)) * 0.5 * screenPerImgPx;

        return Math.min(60, perPoint * 0.5 + sliderPx);
    },

    // Axis-aligned box around the current multi-point selection (display space),
    // with screen-space corners for rendering + hit-testing.
    _rotoSelBox(dpts) {
        const sel = [...this._roto.selPts].filter((i) => dpts[i]);
        if (sel.length < 2) return null;
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (const i of sel) {
            const p = dpts[i];
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
        const cornersNorm = [
            { x: minX, y: minY }, { x: maxX, y: minY },
            { x: maxX, y: maxY }, { x: minX, y: maxY },
        ];
        const cornersScr = cornersNorm.map((c) => this._normToDraw(c.x, c.y));
        if (cornersScr.some((s) => !s)) return null;
        return { cornersNorm, cornersScr, centerNorm: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } };
    },

    _rotoRenderSelBox(box) {
        const scr = box.cornersScr;
        this._toolDraw.appendChild(svgEl("polygon", {
            points: scr.map((s) => `${s.x},${s.y}`).join(" "),
            fill: "rgba(255,138,0,.06)", stroke: "#ff8a00", "stroke-width": 1, "stroke-dasharray": "5 3",
        }));
        scr.forEach((s) => {
            this._toolDraw.appendChild(svgEl("rect", {
                x: s.x - 4, y: s.y - 4, width: 8, height: 8,
                fill: "#ffce85", stroke: "#000", "stroke-width": 1,
            }));
        });
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
    // One unified handler: while a shape is being drawn, clicks lay down points;
    // otherwise the pointer's target (vertex / handle / box / empty) picks the
    // action (see _rotoEditDown).
    _rotoPointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return false;
        if (this._roto.drawing) return this._rotoDrawDown(e, n);
        return this._rotoEditDown(e, n);
    },

    _rotoDrawDown(e, n) {
        if (e.button !== 0) return false;   // right-click → viewport zoom
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
                this._rotoSetPivotToCenter(layer);
                this._rotoSave(); this._rotoRefreshKfInfo(); this._toolRedraw();
                return true;
            }
        }

        // Add a point; drag to pull out symmetric bezier handles.
        const raw = this._rotoInvTf({ x: clamp01(n.x), y: clamp01(n.y) }, layer.transform);
        const pt = { x: raw.x, y: raw.y };
        pts.push(pt);
        this._toolRedraw();

        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, layer.transform);
                pt.cout = { x: rawM.x, y: rawM.y };
                pt.cin = { x: 2 * pt.x - rawM.x, y: 2 * pt.y - rawM.y }; // mirror
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
        return true;
    },

    // Unified edit + transform. Target-driven: handle → drag handle; box corner →
    // group scale; vertex → move (Ctrl+drag = feather); inside box → move group;
    // outside box → rotate group; empty → marquee select. Right-click deletes a
    // vertex (else falls through to viewport zoom).
    _rotoEditDown(e, n) {
        const layer = this._rotoCurLayer();
        if (!layer) return false;
        const tf = layer.transform;
        const dpts = this._rotoDisplayPoints(layer);
        const editPts = this._rotoEditablePoints(layer);

        // Right-click: delete a hit vertex, else let the viewport zoom.
        if (e.button === 2) {
            const hit = this._rotoHitPoint(dpts, n);
            if (hit >= 0) {
                editPts.splice(hit, 1);
                this._roto.selPts = new Set();
                this._rotoSave(); this._rotoRefreshShapeControls?.(); this._toolRedraw();
                return true;
            }
            return false;
        }
        if (e.button !== 0) return false;

        // 1) tangent / feather handle of the selected point (only shown, and thus
        // grabbable, for a single selection — a multi-selection shows the box).
        if (this._roto.selPts.size < 2) {
            for (const i of this._roto.selPts) {
                const p = dpts[i];
                if (!p) continue;
                for (const hk of ["cin", "cout", "feather"]) {
                    if (!p[hk]) continue;
                    if (this._screenDist(n, p[hk]) <= HIT) { this._rotoDragHandle(e, layer, editPts, i, hk); return true; }
                }
            }
        }

        // 2) transform-box corner → scale the selected group
        const box = this._roto.selPts.size >= 2 ? this._rotoSelBox(dpts) : null;
        if (box) {
            const cur = this._normToDraw(n.x, n.y);
            for (let i = 0; i < 4; i++) {
                const c = box.cornersScr[i];
                if (cur && Math.hypot(cur.x - c.x, cur.y - c.y) <= HIT + 3) {
                    this._rotoGroupScale(e, layer, editPts, dpts, box, i);
                    return true;
                }
            }
        }

        // 3) vertex hit → feather (Ctrl) / toggle (Shift) / select + move
        const hitIdx = this._rotoHitPoint(dpts, n);
        if (hitIdx >= 0) {
            if (e.ctrlKey) {   // Ctrl+drag pulls a feather handle (Nuke-style)
                if (!this._roto.selPts.has(hitIdx)) { this._roto.selPts = new Set([hitIdx]); this._rotoRefreshShapeControls?.(); }
                this._rotoDragFeatherCreate(e, layer, editPts, hitIdx);
                return true;
            }
            if (e.shiftKey) {
                if (this._roto.selPts.has(hitIdx)) this._roto.selPts.delete(hitIdx);
                else this._roto.selPts.add(hitIdx);
                this._rotoRefreshShapeControls?.(); this._toolRedraw();
                return true;
            }
            if (!this._roto.selPts.has(hitIdx)) this._roto.selPts = new Set([hitIdx]);
            this._rotoRefreshShapeControls?.();
            this._rotoDragPoints(e, layer, editPts, n);   // moves the whole selection
            return true;
        }

        // 4) with a box: inside → translate the group, outside → rotate / clear
        if (box) {
            if (pointInPoly(n, box.cornersNorm)) { this._rotoDragPoints(e, layer, editPts, n); return true; }
            this._rotoGroupRotate(e, layer, editPts, dpts, box, n);
            return true;
        }

        // 5) Alt+click on an edge inserts a point
        if (e.altKey) {
            const seg = this._rotoNearestSegment(dpts, n);
            if (seg && seg.dist <= HIT * 1.6) {
                const rawInsert = this._rotoInvTf(seg.point, tf);
                editPts.splice(seg.i + 1, 0, { x: rawInsert.x, y: rawInsert.y });
                this._roto.selPts = new Set([seg.i + 1]);
                this._rotoSave(); this._rotoRefreshShapeControls?.(); this._toolRedraw();
                return true;
            }
        }

        // 6) empty space → rubber-band marquee select
        return this._rotoMarquee(e, layer, n);
    },

    _rotoHitPoint(dpts, n) {
        for (let i = dpts.length - 1; i >= 0; i--) {
            if (this._screenDist(n, dpts[i]) <= HIT) return i;
        }
        return -1;
    },

    // Context hint + cursor for whatever the pointer is over — mirrors the
    // dispatch order in _rotoEditDown so the hint matches what a click would do.
    _rotoHoverContext(e, n) {
        const layer = this._rotoCurLayer();
        if (!layer) return { status: "<b>+ Shape</b> to start a roto shape", cursor: "default" };

        // While drawing, clicks lay points.
        if (this._roto.drawing) {
            const pts = this._roto.drawing.points || [];
            if (pts.length >= 3) {
                const first = this._rotoApplyTf(pts[0], layer.transform);
                if (this._screenDist(n, first) <= HIT) return { status: "<b>Click</b> to close the shape", cursor: "pointer" };
            }
            return { status: "<b>Click</b> add point · <b>drag</b> to curve · click the first point to close", cursor: "crosshair" };
        }

        const dpts = this._rotoDisplayPoints(layer);

        // Handle of a single selected point.
        if (this._roto.selPts.size < 2) {
            for (const i of this._roto.selPts) {
                const p = dpts[i]; if (!p) continue;
                if (p.feather && this._screenDist(n, p.feather) <= HIT) return { status: "<b>Drag</b> adjust feather", cursor: "move" };
                for (const hk of ["cin", "cout"]) {
                    if (p[hk] && this._screenDist(n, p[hk]) <= HIT) return { status: "<b>Drag</b> tangent · <b>Alt+drag</b> break it", cursor: "move" };
                }
            }
        }

        // Multi-selection transform box.
        if (this._roto.selPts.size >= 2) {
            const box = this._rotoSelBox(dpts);
            if (box) {
                const cur = this._normToDraw(n.x, n.y);
                for (let i = 0; i < 4; i++) {
                    const c = box.cornersScr[i];
                    if (cur && Math.hypot(cur.x - c.x, cur.y - c.y) <= HIT + 3) {
                        return { status: "<b>Drag</b> scale selection · <b>Shift</b> uniform", cursor: i % 2 === 0 ? "nwse-resize" : "nesw-resize" };
                    }
                }
                if (this._rotoHitPoint(dpts, n) >= 0) return { status: "<b>Drag</b> move · <b>Ctrl+drag</b> feather · <b>Right-click</b> delete", cursor: "move" };
                if (pointInPoly(n, box.cornersNorm)) return { status: "<b>Drag</b> move selection", cursor: "move" };
                return { status: "<b>Drag</b> rotate selection (<b>Shift</b> 15°) · <b>click</b> to clear", cursor: "crosshair" };
            }
        }

        // Vertex.
        if (this._rotoHitPoint(dpts, n) >= 0) {
            return { status: "<b>Drag</b> move · <b>Ctrl+drag</b> feather · <b>Right-click</b> delete", cursor: "move" };
        }

        // Edge (Alt inserts a point).
        const seg = this._rotoNearestSegment(dpts, n);
        if (seg && seg.dist <= HIT * 1.6) {
            return { status: "<b>Alt+click</b> insert point", cursor: e.altKey ? "copy" : "crosshair" };
        }

        // Empty space.
        return { status: "<b>Drag</b> to marquee-select points", cursor: "default" };
    },

    // Rubber-band select: pick every vertex inside the dragged rect. A click with
    // no drag clears the selection.
    _rotoMarquee(e, layer, startNorm) {
        const dpts = this._rotoDisplayPoints(layer);
        const rectEl = svgEl("rect", { fill: "rgba(108,180,255,.12)", stroke: "#6cf", "stroke-width": 1, "stroke-dasharray": "3 2" });
        this._toolDraw.appendChild(rectEl);
        let moved = false, cur = startNorm;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                cur = m;
                const a = this._normToDraw(startNorm.x, startNorm.y);
                const b = this._normToDraw(m.x, m.y);
                if (!a || !b) return;
                if (Math.hypot(b.x - a.x, b.y - a.y) > 3) moved = true;
                rectEl.setAttribute("x", Math.min(a.x, b.x));
                rectEl.setAttribute("y", Math.min(a.y, b.y));
                rectEl.setAttribute("width", Math.abs(b.x - a.x));
                rectEl.setAttribute("height", Math.abs(b.y - a.y));
            },
            () => {
                rectEl.remove();
                if (moved) {
                    const minX = Math.min(startNorm.x, cur.x), maxX = Math.max(startNorm.x, cur.x);
                    const minY = Math.min(startNorm.y, cur.y), maxY = Math.max(startNorm.y, cur.y);
                    const sel = new Set();
                    dpts.forEach((p, i) => { if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) sel.add(i); });
                    this._roto.selPts = sel;
                } else {
                    this._roto.selPts = new Set();
                }
                this._rotoRefreshShapeControls?.();
                this._toolRedraw();
            },
        );
        return true;
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

    // Group transforms edit the SELECTED points (not the layer transform). They
    // run in display-pixel space and invert the layer transform back to raw, so
    // the selection scales/rotates about the box centre exactly as drawn.
    _rotoGroupCapture(dpts) {
        const { w, h } = this._toolImgSize();
        const sel = [...this._roto.selPts].filter((i) => dpts[i]);
        const orig = {};
        for (const i of sel) {
            const p = dpts[i];
            orig[i] = { a: { x: p.x * w, y: p.y * h } };
            for (const hk of ["cin", "cout", "feather"]) if (p[hk]) orig[i][hk] = { x: p[hk].x * w, y: p[hk].y * h };
        }
        return { w, h, sel, orig };
    },

    // Write a transformed display-pixel point set back to raw editable points.
    _rotoGroupApply(layer, editPts, cap, map) {
        const { w, h } = cap;
        const tf = layer.transform;
        for (const i of cap.sel) {
            const o = cap.orig[i]; if (!o) continue;
            const na = map(o.a);
            const nn = this._rotoInvTf({ x: na.x / w, y: na.y / h }, tf);
            editPts[i].x = clamp01(nn.x); editPts[i].y = clamp01(nn.y);
            for (const hk of ["cin", "cout", "feather"]) {
                if (!o[hk]) continue;
                const hp = map(o[hk]);
                const hn = this._rotoInvTf({ x: hp.x / w, y: hp.y / h }, tf);
                editPts[i][hk] = { x: hn.x, y: hn.y };
            }
        }
        this._toolRedraw();
    },

    // Corner drag scales the selection about the box centre (Shift = uniform).
    _rotoGroupScale(e, layer, editPts, dpts, box, cornerIdx) {
        const cap = this._rotoGroupCapture(dpts);
        if (!cap.w || !cap.h || cap.sel.length < 2) return;
        const cx = box.centerNorm.x * cap.w, cy = box.centerNorm.y * cap.h;
        const g0 = { x: box.cornersNorm[cornerIdx].x * cap.w, y: box.cornersNorm[cornerIdx].y * cap.h };
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const mx = m.x * cap.w, my = m.y * cap.h;
                let fx = (mx - cx) / ((g0.x - cx) || 1e-6);
                let fy = (my - cy) / ((g0.y - cy) || 1e-6);
                if (ev.shiftKey) {
                    const denom = (g0.x - cx) ** 2 + (g0.y - cy) ** 2 || 1e-6;
                    fx = fy = ((mx - cx) * (g0.x - cx) + (my - cy) * (g0.y - cy)) / denom;
                }
                if (Math.abs(fx) < 1e-3) fx = (fx < 0 ? -1 : 1) * 1e-3;
                if (Math.abs(fy) < 1e-3) fy = (fy < 0 ? -1 : 1) * 1e-3;
                this._rotoGroupApply(layer, editPts, cap, (q) => ({ x: cx + fx * (q.x - cx), y: cy + fy * (q.y - cy) }));
            },
            () => { this._rotoSave(); this._rotoRefreshKfInfo?.(); this._toolRedraw(); },
        );
    },

    // Drag outside the box rotates the selection about its centre (Shift snaps to
    // 15°). A click with no movement clears the selection.
    _rotoGroupRotate(e, layer, editPts, dpts, box, startNorm) {
        const cap = this._rotoGroupCapture(dpts);
        if (!cap.w || !cap.h || cap.sel.length < 2) return;
        const cx = box.centerNorm.x * cap.w, cy = box.centerNorm.y * cap.h;
        const a0 = Math.atan2(startNorm.y * cap.h - cy, startNorm.x * cap.w - cx);
        let moved = false;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                moved = true;
                let da = Math.atan2(m.y * cap.h - cy, m.x * cap.w - cx) - a0;
                if (ev.shiftKey) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
                const ca = Math.cos(da), sa = Math.sin(da);
                this._rotoGroupApply(layer, editPts, cap, (q) => ({
                    x: cx + (q.x - cx) * ca - (q.y - cy) * sa,
                    y: cy + (q.x - cx) * sa + (q.y - cy) * ca,
                }));
            },
            () => {
                if (moved) { this._rotoSave(); this._rotoRefreshKfInfo?.(); }
                else { this._roto.selPts = new Set(); this._rotoRefreshShapeControls?.(); }
                this._toolRedraw();
            },
        );
    },

    _rotoSetPivotToCenter(layer) {
        const raw = layer.points;
        if (!raw || raw.length < 2) return;
        const tf = layer.transform;
        // moving the pivot only leaves the shape visually fixed for free when
        // the transform is still identity — do it right after drawing.
        if (tf.rot !== 0 || tf.sx !== 1 || tf.sy !== 1 || tf.tx !== 0 || tf.ty !== 0) return;
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (const p of raw) {
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
        tf.px = (minX + maxX) / 2;
        tf.py = (minY + maxY) / 2;
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

function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        const hit = ((yi > p.y) !== (yj > p.y)) &&
            (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-12) + xi);
        if (hit) inside = !inside;
    }
    return inside;
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
