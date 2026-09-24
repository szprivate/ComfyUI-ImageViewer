// bEpicViewer_rotoCurves.js
// The roto shapes' animation curves, in a dock panel of their own
// (#roto-curves-panel, "Roto Curves"). It opens when the roto tool comes on and
// goes away with it, and is sized, moved and stacked like every other panel.
//
// It is built from the same parts as the previz Animation Curves
// (bEpicViewer_curveUI.js): the list on the left, the graph on the right, the
// same dots, handles and arms. What a curve IS differs, though. A previz
// channel is a number, so its graph shows the value. A roto shape is a set of
// points that morphs from key to key, so its graph shows timing: how far along
// its journey from one key to the next the shape is at each frame — each key
// one step up, the ease between them shaped by the handles, After Effects'
// value graph for a path.
//
// LIST AND GRAPH
// One row per shape. A plain click shows that shape alone and makes it the
// shape the key buttons and the canvas work on; Shift/Ctrl-click adds or
// removes a shape from the graph. By default every animated shape is on it,
// each in its own colour.
//
// KEYS AND HANDLES
// Drag a key sideways to retime it (it can't pass its neighbours), double-click
// to delete it. Click a key for its handles: the one leaving it shapes the ease
// out, the one arriving at it the ease in; horizontal reach is how much ease,
// height is speed. Double-click a handle to give the key its default ease back.
// A Hold key has no handle out: the shape stays put until the next key.
//
// The data is the roto tool's own: layer.keyframes[frame] = points and
// layer.tangents[frame] = { ox, oy, ix, iy, hold } (see bEpicViewer_roto.js).
import { buildCurvePanel, svgLine, tangentArm } from "./bEpicViewer_curveUI.js";

const PALETTE = ["#ff8a00", "#6bb6ff", "#8ce26b", "#ff6bd5", "#ffd24d", "#9d8cff", "#6be2c8", "#ff6b6b"];
const GRAPH = { top: 10, bottom: 90 };

export const RotoCurvesMixin = {

    _rotoCurvesOn() {
        return !!(this._toolState && this._toolState.active === "roto" && this._toolState.node && this._roto);
    },

    /** Open or put away the panel — the roto tool's to decide, like previz's own. */
    rotoShowCurves(on) {
        if (!this.setPanelDocked || !this.isPanelDocked || !this.rotoCurvesPanel) return;
        if (!!this.isPanelDocked("rotoCurves") !== !!on) this.setPanelDocked("rotoCurves", !!on);
    },

    rotoToggleCurves() {
        if (!this.isPanelDocked) return;
        this.rotoShowCurves(!this.isPanelDocked("rotoCurves"));
    },

    /** Redraw the panel: after an edit, a frame change, or the panel coming up. */
    rotoRefreshCurves() {
        const host = this.rotoCurvesPanel;
        if (!host || !this._rotoCurvesOn()) return;
        if (!this.isPanelDocked || !this.isPanelDocked("rotoCurves")) return;
        const ui = this._rotoCurveUI && this._rotoCurveUI.body.isConnected
            ? this._rotoCurveUI : this._rotoBuildCurves(host);

        const layers = this._roto.layers;
        const lines = this._rotoCurveLines();
        ui.body.style.display = layers.length ? "flex" : "none";
        ui.empty.style.display = layers.length ? "none" : "block";
        ui.empty.textContent = "Add a shape (+ Shape in the Roto panel) to animate it here.";
        if (!layers.length) return;

        this._rotoSyncCurveList(ui, lines);
        const layer = this._rotoCurLayer();
        const nKeys = layer ? this._rotoCurKeys(layer).length : 0;
        ui.sub.textContent = !layer ? "Pick a shape"
            : nKeys ? `${layer.name} · ${nKeys} key${nKeys === 1 ? "" : "s"}`
            : `${layer.name} · no keys yet — press + beside the timeline`;
        this._rotoDrawCurves(lines);
    },

    _rotoBuildCurves(host) {
        this._rotoCurveUI = buildCurvePanel(host, {
            listWidth: this._rotoCurveListW || 110,
            onListWidth: (w) => { this._rotoCurveListW = w; },
            onResized: () => this.rotoRefreshCurves(),
            onBlank: () => { this._rotoCurveKey = null; this.rotoRefreshCurves(); },
            hint: "Each step up is a key. Drag a key sideways to retime it; double-click removes it. " +
                  "Click a key for its ease handles — farther out is more ease, height is speed; " +
                  "double-click a handle for the default ease.",
        });
        this._rotoCurveListSig = null;
        return this._rotoCurveUI;
    },

    /** The curves on the graph: a shape, its keys and its colour. */
    _rotoCurveLines() {
        const shown = this._rotoCurveShown;
        const out = [];
        this._roto.layers.forEach((layer, index) => {
            const keys = this._rotoCurKeys(layer);
            const on = shown && shown.size ? shown.has(layer.id) : keys.length > 0;
            if (on) out.push({ layer, index, keys, color: PALETTE[index % PALETTE.length] });
        });
        return out;
    },

    /**
     * The list: one row per shape. Rebuilt only when what it says changes — the
     * panel redraws on every frame during playback, and the list doesn't move.
     */
    _rotoSyncCurveList(ui, lines) {
        const on = new Set(lines.map((l) => l.layer.id));
        const layers = this._roto.layers;
        const sig = JSON.stringify([this._roto.selLayer, [...on],
            layers.map((l) => [l.id, l.name, this._rotoCurKeys(l).length])]);
        if (sig === this._rotoCurveListSig) return;
        this._rotoCurveListSig = sig;
        const doc = ui.list.ownerDocument;
        ui.list.innerHTML = "";
        layers.forEach((layer, index) => {
            const row = doc.createElement("button");
            row.className = "curves-ch";
            row.textContent = layer.name || `Shape ${index + 1}`;
            row.style.setProperty("--ch", PALETTE[index % PALETTE.length]);
            const n = this._rotoCurKeys(layer).length;
            row.title = `${layer.name} · ${n ? n + " key" + (n === 1 ? "" : "s") : "no keys"}\n` +
                        "click: show this shape alone and work on it · Shift-click: add to the graph";
            row.classList.toggle("on", on.has(layer.id));
            row.classList.toggle("animated", n > 0);
            row.classList.toggle("current", index === this._roto.selLayer);
            row.onclick = (e) => this._rotoPickCurve(layer, index, e.shiftKey || e.ctrlKey || e.metaKey);
            ui.list.append(row);
        });
    },

    _rotoPickCurve(layer, index, add) {
        let shown = this._rotoCurveShown;
        if (!shown || !shown.size) shown = new Set(this._rotoCurveLines().map((l) => l.layer.id));
        if (add) {
            if (shown.has(layer.id)) shown.delete(layer.id); else shown.add(layer.id);
        } else {
            shown = new Set([layer.id]);
            // The shape you look at is the shape you key: pick it in the tool too.
            if (this._roto.selLayer !== index) {
                this._roto.selLayer = index;
                this._roto.selPts = new Set();
                this._roto.drawing = null;
                this._rotoRefreshLayerList?.();
                this._rotoRefreshShapeControls?.();
                this._toolRedraw?.();
            }
        }
        this._rotoCurveShown = shown;
        this._rotoCurveKey = null;
        this._rotoRefreshKfInfo();
    },

    // ── Geometry ─────────────────────────────────────────────────────────────

    /**
     * Frames → x%, and for one shape: key k sits at height k/(K-1), and each
     * segment's 0..1 ease progress is mapped into the band between its two keys,
     * so a key's in- and out-handles live in one continuous curve.
     */
    _rotoCurveGeom(line) {
        const b = this.getTimelineBounds ? this.getTimelineBounds() : { min: 0, max: 0 };
        const span = Math.max(1, b.max - b.min);
        const X = (f) => ((f - b.min) / span) * 100;
        const Yv = (v) => GRAPH.bottom - v * (GRAPH.bottom - GRAPH.top);
        const keys = line ? line.keys : [];
        const K = keys.length;
        const level = (k) => (K <= 1 ? 0.5 : k / (K - 1));
        const segs = [];
        for (let s = 0; s < K - 1; s++) {
            const lo = keys[s], hi = keys[s + 1];
            segs.push({ s, lo, hi, x0: X(lo), x1: X(hi), v0: level(s), v1: level(s + 1) });
        }
        return { min: b.min, max: b.max, span, X, Yv, level, keys, K, segs };
    },

    /** Where a handle sits: out of key `seg.lo`, or into key `seg.hi`. */
    _rotoHandlePos(layer, seg, side, g) {
        const t = this._rotoKeyTangent(layer, side === "out" ? seg.lo : seg.hi);
        const dx = seg.x1 - seg.x0, dv = seg.v1 - seg.v0;
        return side === "out"
            ? { x: seg.x0 + dx * t.ox, y: g.Yv(seg.v0 + dv * t.oy) }
            : { x: seg.x0 + dx * t.ix, y: g.Yv(seg.v0 + dv * t.iy) };
    },

    // ── Drawing ──────────────────────────────────────────────────────────────

    _rotoDrawCurves(lines) {
        const ui = this._rotoCurveUI;
        const svg = ui.svg, wrap = ui.wrap;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        const g0 = this._rotoCurveGeom(null);
        svgLine(svg, { x1: 0, y1: GRAPH.bottom, x2: 100, y2: GRAPH.bottom, stroke: "#333" });
        svgLine(svg, { x1: 0, y1: GRAPH.top, x2: 100, y2: GRAPH.top, stroke: "#262626" });

        const doc = wrap.ownerDocument;
        const sel = this._rotoCurveKey;
        for (const line of lines) {
            const { layer, keys, color } = line;
            const g = this._rotoCurveGeom(line);
            for (const f of keys) {
                svgLine(svg, { x1: g.X(f), y1: GRAPH.top, x2: g.X(f), y2: GRAPH.bottom, stroke: color,
                               "stroke-dasharray": "2 2", opacity: 0.22 });
            }
            // The curve, sampled through the tool's own easing — so a dragged
            // handle and a Hold key look here exactly as they play.
            if (g.K >= 2) {
                let d = "";
                for (const seg of g.segs) {
                    const steps = Math.max(8, Math.min(60, (seg.hi - seg.lo) * 2));
                    for (let i = 0; i <= steps; i++) {
                        const xf = i / steps;
                        const p = this._rotoSegEase(layer, seg.lo, seg.hi, xf);
                        const x = seg.x0 + (seg.x1 - seg.x0) * xf;
                        const y = g.Yv(seg.v0 + (seg.v1 - seg.v0) * p);
                        d += (d === "" ? "M " : "L ") + x.toFixed(2) + " " + y.toFixed(2) + " ";
                    }
                }
                svgLine(svg, { tag: "path", d, fill: "none", "stroke-width": 2, stroke: color });
            }
            for (let k = 0; k < g.K; k++) {
                const f = keys[k];
                const chosen = !!sel && sel.id === layer.id && sel.f === f;
                const dot = doc.createElement("div");
                dot.className = "kf-dot" + (chosen ? " chosen" : "");
                dot.style.left = g.X(f) + "%";
                dot.style.top = g.Yv(g.level(k)) + "%";
                dot.style.background = color;
                const hold = this._rotoKeyTangent(layer, f).hold;
                dot.title = `${layer.name} · key at frame ${f}${hold ? " (hold)" : ""}\n` +
                            "drag sideways to retime · click for ease handles · double-click to delete";
                dot.onmousedown = (e) => this._rotoCurveDotDown(e, layer, f);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (chosen) this._rotoCurveKey = null;
                    this._rotoDeleteKeyAt(layer, f);
                };
                wrap.append(dot);
                if (chosen) this._rotoCurveHandles(layer, k, g, color);
            }
        }
        const px = g0.X(this._rotoFrame());
        svgLine(svg, { x1: px, y1: 0, x2: px, y2: 100, stroke: "#fff", opacity: 0.6 });
    },

    /** The selected key's two handles: into it from the key before, out of it to the next. */
    _rotoCurveHandles(layer, k, g, color) {
        const wrap = this._rotoCurveUI.wrap;
        const doc = wrap.ownerDocument;
        const f = g.keys[k];
        const kx = g.X(f), ky = g.Yv(g.level(k));
        const sides = [];
        if (k > 0 && !this._rotoKeyTangent(layer, g.keys[k - 1]).hold) sides.push(["in", g.segs[k - 1]]);
        if (k < g.K - 1 && !this._rotoKeyTangent(layer, f).hold) sides.push(["out", g.segs[k]]);
        for (const [side, seg] of sides) {
            const p = this._rotoHandlePos(layer, seg, side, g);
            tangentArm(wrap, kx, ky, p.x, p.y, color);
            const h = doc.createElement("div");
            h.className = "kf-tan";
            h.style.left = p.x + "%";
            h.style.top = p.y + "%";
            h.style.borderColor = color;
            h.title = `${side === "out" ? "Ease out of" : "Ease into"} the key at frame ${f}\n` +
                      "drag: farther out = more ease, height = speed · double-click for the default ease";
            h.onmousedown = (e) => this._rotoCurveHandleDown(e, layer, seg, side);
            h.ondblclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (layer.tangents) delete layer.tangents[String(f)];
                this._rotoSave();
                this._rotoRefreshKfInfo();
                this._toolRedraw();
            };
            wrap.append(h);
        }
    },

    // ── Dragging ─────────────────────────────────────────────────────────────

    /** Press on a key: select it (its handles show), and drag it sideways to retime. */
    _rotoCurveDotDown(e, layer, frame) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        this._rotoCurveKey = { id: layer.id, f: frame };
        const dot = e.currentTarget;
        const rect = this._rotoCurveUI.wrap.getBoundingClientRect();
        const g = this._rotoCurveGeom({ keys: this._rotoCurKeys(layer) });
        // Keys keep their order: one can't be dragged past its neighbours.
        const idx = g.keys.indexOf(frame);
        const loBound = idx > 0 ? g.keys[idx - 1] + 1 : g.min;
        const hiBound = idx < g.keys.length - 1 ? g.keys[idx + 1] - 1 : g.max;
        const win = (this._viewerWindow && this._viewerWindow()) || dot.ownerDocument.defaultView || window;
        let target = frame;
        const move = (ev) => {
            ev.preventDefault();
            const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            target = Math.max(loBound, Math.min(hiBound, Math.round(g.min + pct * g.span)));
            dot.style.left = g.X(target) + "%";
        };
        const up = () => {
            win.removeEventListener("mousemove", move);
            win.removeEventListener("mouseup", up);
            if (target !== frame) {
                this._rotoMoveKey(layer, frame, target);
                this._rotoCurveKey = { id: layer.id, f: target };
            }
            this._rotoRefreshKfInfo();
        };
        win.addEventListener("mousemove", move);
        win.addEventListener("mouseup", up);
        // The ring now; the handles come with the redraw on release (a redraw
        // here would replace the very dot being dragged).
        dot.classList.add("chosen");
    },

    /**
     * Drag an ease handle. `side` "out" edits the left key's out control point,
     * "in" the right key's in control point — both in the segment's own
     * normalised time/progress square: across is influence, up is speed.
     */
    _rotoCurveHandleDown(e, layer, seg, side) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const rect = this._rotoCurveUI.wrap.getBoundingClientRect();
        const win = (this._viewerWindow && this._viewerWindow()) || e.currentTarget.ownerDocument.defaultView || window;
        const key = side === "out" ? seg.lo : seg.hi;
        const move = (ev) => {
            ev.preventDefault();
            const gx = ((ev.clientX - rect.left) / rect.width) * 100;
            const gy = ((ev.clientY - rect.top) / rect.height) * 100;
            const frac = Math.max(0.02, Math.min(0.98, (gx - seg.x0) / ((seg.x1 - seg.x0) || 1)));
            const gv = (GRAPH.bottom - gy) / (GRAPH.bottom - GRAPH.top);
            const dv = seg.v1 - seg.v0;
            const val = Math.max(0, Math.min(1, dv === 0 ? 0 : (gv - seg.v0) / dv));
            if (side === "out") this._rotoSetKeyTangent(layer, key, { ox: frac, oy: val });
            else this._rotoSetKeyTangent(layer, key, { ix: frac, iy: val });
            this.rotoRefreshCurves();
            this._toolRedraw();
        };
        const up = () => {
            win.removeEventListener("mousemove", move);
            win.removeEventListener("mouseup", up);
            this._rotoSave();
        };
        win.addEventListener("mousemove", move);
        win.addEventListener("mouseup", up);
    },
};
