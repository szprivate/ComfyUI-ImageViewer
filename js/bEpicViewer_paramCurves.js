// bEpicViewer_paramCurves.js
// Parameter Curves: the animated parameters of the node in the Parameters
// panel, drawn as value over time in a dock panel of their own
// (#param-curves-panel, dock id "paramCurves"). Opened from the ∿ button in
// the Parameters header.
//
// The same editor as previz's Animation Curves (bEpicViewer_previzCurves.js),
// built from the same parts (bEpicViewer_curveUI.js): a list of curves on the
// left, the graph on the right. Drag a key sideways to retime it, up and down
// to change it, double-click to delete it; click it for its tangent handles,
// Alt to break them, double-click a handle to hand the key back to its ease.
// Every parameter is one number, so a curve is simply the parameter's name.
import { app } from "../../scripts/app.js";
import * as A from "./bEpicViewer_paramAnimData.js";
import { buildCurvePanel, svgLine, tangentArm } from "./bEpicViewer_curveUI.js";

const GRAPH = { top: 10, bottom: 90 };
const HANDLE_SPAN = 0.06;
const PALETTE = ["#ff6b6b", "#8ce26b", "#6bb6ff", "#ffd24d", "#ff9d4d", "#c8e24d",
                 "#4dc8ff", "#ff6bd5", "#6be2c8", "#9d8cff"];

export const ParamCurvesMixin = {

    /** Open or close the panel (the ∿ button in the Parameters header). */
    paramToggleCurves() {
        if (!this.setPanelDocked) return;
        this.setPanelDocked("paramCurves", !this.isPanelDocked("paramCurves"));
        this.paramAnimDecorate?.();
    },

    /** The node's curves: the animated parameters, or the ones picked in the list. */
    _paramCurveLines(node, tracks) {
        const names = A.animatableNames(node) || [];
        const picked = this._paramCurveShown && this._paramCurveShown.get(node.id);
        const colour = (name) => PALETTE[names.indexOf(name) % PALETTE.length];
        const chosen = picked && picked.size ? names.filter((n) => picked.has(n))
                                             : names.filter((n) => tracks[n]);
        return chosen.map((name) => ({ name, color: colour(name), keys: tracks[name] || [] }));
    },

    paramRefreshCurves() {
        const host = this.paramCurvesPanel;
        if (!host || !this.isPanelDocked || !this.isPanelDocked("paramCurves")) return;
        const ui = this._paramBuildCurves(host);
        const node = this.paramAnimNode ? this.paramAnimNode() : null;
        ui.body.style.display = node ? "flex" : "none";
        ui.empty.style.display = node ? "none" : "block";
        ui.empty.textContent = "Select a bEpic node that can be animated (Transform, Grade, Blur, …) " +
                               "to see its curves.";
        if (!node) return;
        const tracks = A.readTracks(node);
        const lines = this._paramCurveLines(node, tracks);
        this._paramSyncCurveList(ui, node, tracks, lines);
        const animated = Object.keys(tracks).length;
        ui.sub.textContent = animated
            ? `${node.title || node.type} · ${animated} animated`
            : `${node.title || node.type} · no keys yet — ◇ beside a parameter keys it`;
        this._paramDrawCurves(node, lines);
    },

    _paramBuildCurves(host) {
        if (this._paramCurveUI && this._paramCurveUI.body.isConnected) return this._paramCurveUI;
        const ui = buildCurvePanel(host, {
            listWidth: this._paramCurveListW || 130,
            onListWidth: (w) => { this._paramCurveListW = w; },
            onResized: () => this.paramRefreshCurves(),
            onBlank: () => { this._paramCurveKey = null; this.paramRefreshCurves(); },
            hint: "Drag a key sideways to retime it, up and down to change it; double-click removes it. " +
                  "Click a key for its tangents — drag a handle to shape the curve, Alt to break it, " +
                  "double-click it to hand the key back to its ease.",
        });
        this._paramCurveUI = ui;
        return ui;
    },

    /** Show or hide one parameter's curve. Plain click picks it alone. */
    _paramToggleCurve(node, name, add, lines) {
        const all = this._paramCurveShown || (this._paramCurveShown = new Map());
        let shown = all.get(node.id);
        if (!shown || !shown.size) shown = new Set(lines.map((l) => l.name));
        if (add) { if (shown.has(name)) shown.delete(name); else shown.add(name); }
        else shown = new Set([name]);
        all.set(node.id, shown);
        this.paramRefreshCurves();
    },

    _paramSyncCurveList(ui, node, tracks, lines) {
        const doc = ui.list.ownerDocument;
        const on = new Set(lines.map((l) => l.name));
        const names = A.animatableNames(node) || [];
        // Animated parameters first: on a node with eighty knobs they are the
        // ones you came for.
        const order = names.filter((n) => tracks[n]).concat(names.filter((n) => !tracks[n]));
        ui.list.innerHTML = "";
        for (const name of order) {
            const row = doc.createElement("button");
            row.className = "curves-ch";
            row.textContent = name;
            row.style.setProperty("--ch", PALETTE[names.indexOf(name) % PALETTE.length]);
            row.title = `Show or hide ${name} (Shift/Ctrl adds to what is shown)`;
            row.classList.toggle("on", on.has(name));
            row.classList.toggle("animated", !!tracks[name]);
            row.onclick = (e) => this._paramToggleCurve(node, name, e.shiftKey || e.ctrlKey || e.metaKey, lines);
            ui.list.append(row);
        }
    },

    // ── Geometry & drawing ───────────────────────────────────────────────────

    _paramCurveGeom(node, lines) {
        const bounds = this.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);
        let lo = Infinity, hi = -Infinity;
        const see = (v) => { if (typeof v !== "number") return; if (v < lo) lo = v; if (v > hi) hi = v; };
        for (const l of lines) {
            if (!l.keys.length) { see(this._paramStatic(node, l.name)); continue; }
            for (const k of l.keys) see(k.v);
            for (let i = 0; i < l.keys.length - 1; i++) {
                for (let n = 1; n < 8; n++) {
                    see(A.valueAt(l.keys, l.keys[i].f + ((l.keys[i + 1].f - l.keys[i].f) * n) / 8));
                }
            }
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;
        const X = (f) => ((f - bounds.min) / span) * 100;
        const Y = (v) => GRAPH.bottom - ((v - lo) / (hi - lo)) * (GRAPH.bottom - GRAPH.top);
        const frameAt = (xPct) => Math.round(bounds.min + (xPct / 100) * span);
        const valueAt = (yPct) => lo + ((GRAPH.bottom - yPct) / (GRAPH.bottom - GRAPH.top)) * (hi - lo);
        return { bounds, span, lo, hi, X, Y, frameAt, valueAt };
    },

    _paramStatic(node, name) {
        const w = (node.widgets || []).find((x) => x.name === name);
        return w ? w.value : 0;
    },

    _paramDrawCurves(node, lines) {
        const ui = this._paramCurveUI;
        const svg = ui.svg;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const g = this._paramCurveGeom(node, lines);
        const line = (attrs) => svgLine(svg, attrs);
        line({ x1: 0, y1: GRAPH.bottom, x2: 100, y2: GRAPH.bottom, stroke: "#333" });
        line({ x1: 0, y1: GRAPH.top, x2: 100, y2: GRAPH.top, stroke: "#262626" });
        if (g.lo < 0 && g.hi > 0) {
            line({ x1: 0, y1: g.Y(0), x2: 100, y2: g.Y(0), stroke: "#3a3a3a", "stroke-dasharray": "3 3" });
        }
        for (const f of new Set(lines.flatMap((l) => l.keys.map((k) => k.f)))) {
            line({ x1: g.X(f), y1: GRAPH.top, x2: g.X(f), y2: GRAPH.bottom, stroke: "#ff8a00",
                   "stroke-dasharray": "2 2", opacity: 0.22 });
        }
        for (const l of lines) {
            let d = "";
            if (!l.keys.length) {
                const y = g.Y(this._paramStatic(node, l.name)).toFixed(2);
                d = `M 0 ${y} L 100 ${y}`;
            } else {
                // Before the first key and after the last the value holds.
                const first = l.keys[0].f, last = l.keys[l.keys.length - 1].f;
                d = `M 0 ${g.Y(l.keys[0].v).toFixed(2)} `;
                const steps = Math.max(2, Math.min(240, Math.round((last - first) * 2) || 2));
                for (let i = 0; i <= steps; i++) {
                    const f = first + ((last - first) * i) / steps;
                    d += `L ${g.X(f).toFixed(2)} ${g.Y(A.valueAt(l.keys, f)).toFixed(2)} `;
                }
                d += `L 100 ${g.Y(l.keys[l.keys.length - 1].v).toFixed(2)}`;
            }
            line({ tag: "path", d, fill: "none", "stroke-width": 2, stroke: l.color,
                   opacity: l.keys.length ? 1 : 0.5 });
        }
        const playhead = g.X(Math.round(this.currentFrame || 0));
        line({ x1: playhead, y1: 0, x2: playhead, y2: 100, stroke: "#fff", opacity: 0.6 });
        this._paramLayoutDots(node, lines, g);
    },

    _paramLayoutDots(node, lines, g) {
        const wrap = this._paramCurveUI.wrap;
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        const doc = wrap.ownerDocument;
        const sel = this._paramCurveKey;
        for (const l of lines) {
            for (const k of l.keys) {
                const chosen = !!sel && sel.node === node.id && sel.name === l.name && sel.f === k.f;
                const dot = doc.createElement("div");
                dot.className = "kf-dot" + (chosen ? " chosen" : "");
                dot.style.left = g.X(k.f) + "%";
                dot.style.top = g.Y(k.v) + "%";
                dot.style.background = l.color;
                dot.title = `${l.name} · frame ${k.f} = ${Math.round(k.v * 1000) / 1000}\n` +
                            "drag sideways to retime, up/down to change · click for tangents · double-click to delete";
                dot.onmousedown = (e) => this._paramDotDown(e, node, l.name, k.f, lines);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const tracks = A.readTracks(node);
                    tracks[l.name] = A.removeKey(tracks[l.name], k.f);
                    if (chosen) this._paramCurveKey = null;
                    this.paramAnimWrite(node, tracks);
                    this.paramAnimChanged();
                };
                wrap.append(dot);
                if (chosen) this._paramLayoutTangents(node, l, k, g);
            }
        }
    },

    _paramLayoutTangents(node, l, key, g) {
        const wrap = this._paramCurveUI.wrap;
        const doc = wrap.ownerDocument;
        const reach = Math.max(1, g.span * HANDLE_SPAN);
        const i = l.keys.findIndex((k) => k.f === key.f);
        for (const side of ["in", "out"]) {
            if (side === "in" && i <= 0) continue;
            if (side === "out" && i >= l.keys.length - 1) continue;
            const slope = A.tangentAt(l.keys, key.f, side);
            const dir = side === "in" ? -1 : 1;
            const x2 = g.X(key.f + dir * reach), y2 = g.Y(key.v + dir * reach * slope);
            tangentArm(wrap, g.X(key.f), g.Y(key.v), x2, y2, l.color);
            const h = doc.createElement("div");
            h.className = "kf-tan";
            h.style.left = x2 + "%";
            h.style.top = y2 + "%";
            h.style.borderColor = l.color;
            h.title = `${l.name} · ${side === "in" ? "incoming" : "outgoing"} tangent ` +
                      `(${Math.round(slope * 1000) / 1000} per frame)\n` +
                      "drag to shape · Alt to break the pair · double-click for the key's ease again";
            h.onmousedown = (e) => this._paramTangentDown(e, node, l.name, key.f, side);
            h.ondblclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const tracks = A.readTracks(node);
                A.clearTangents(tracks[l.name], key.f);
                this.paramAnimWrite(node, tracks);
                this.paramAnimChanged();
            };
            wrap.append(h);
        }
    },

    // ── Dragging ─────────────────────────────────────────────────────────────

    _paramDotDown(e, node, name, frame, lines) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        this._paramCurveKey = { node: node.id, name, f: frame };
        const wrap = this._paramCurveUI.wrap;
        const win = this._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        const isInt = A.isIntParam(node, name);
        let current = frame;
        // The value band is held for the drag, or the graph would rescale
        // under the pointer as the key moves.
        const g = this._paramCurveGeom(node, lines);

        const onMove = (evt) => {
            const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
            const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
            const tracks = A.readTracks(node);
            const keys = tracks[name] || [];
            const key = keys.find((k) => k.f === current);
            if (!key) return;
            let v = evt.shiftKey ? key.v : g.valueAt(yPct);
            if (isInt) v = Math.round(v);
            const want = Math.max(g.bounds.min, Math.min(g.bounds.max, g.frameAt(xPct)));
            let next = keys;
            if (want !== current && !keys.some((k) => k.f === want)) {
                const moved = { ...key, f: want, v };
                next = A.removeKey(keys, current).concat([moved]).sort((a, b) => a.f - b.f);
                current = want;
                this._paramCurveKey = { node: node.id, name, f: current };
            } else {
                key.v = v;
            }
            tracks[name] = next;
            this.paramAnimWrite(node, tracks);
            this.paramAnimChanged();
        };
        const onUp = () => {
            win.removeEventListener("mousemove", onMove);
            win.removeEventListener("mouseup", onUp);
            this.paramAnimChanged();
        };
        win.addEventListener("mousemove", onMove);
        win.addEventListener("mouseup", onUp);
        this.paramRefreshCurves();
    },

    _paramTangentDown(e, node, name, frame, side) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const wrap = this._paramCurveUI.wrap;
        const win = this._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        const broken = e.altKey;
        const tracks0 = A.readTracks(node);
        const g = this._paramCurveGeom(node, this._paramCurveLines(node, tracks0));

        const onMove = (evt) => {
            const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
            const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
            const tracks = A.readTracks(node);
            const key = (tracks[name] || []).find((k) => k.f === frame);
            if (!key) return;
            const dir = side === "in" ? -1 : 1;
            const df = (g.bounds.min + (xPct / 100) * g.span) - frame;
            const reach = dir * Math.max(Math.max(0.5, g.span * 0.01), dir * df);
            A.setTangent(tracks[name], frame, (g.valueAt(yPct) - key.v) / reach, side, broken);
            this.paramAnimWrite(node, tracks);
            this.paramAnimChanged();
        };
        const onUp = () => {
            win.removeEventListener("mousemove", onMove);
            win.removeEventListener("mouseup", onUp);
        };
        win.addEventListener("mousemove", onMove);
        win.addEventListener("mouseup", onUp);
    },
};
