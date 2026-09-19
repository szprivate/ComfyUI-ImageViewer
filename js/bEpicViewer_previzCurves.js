// bEpicViewer_previzCurves.js
// The previz animation curves: the selected item's keys drawn as value over
// time, in a dock panel of their own (#curves-panel), alongside the previz
// panel and reached from the 3D toolbar.
//
// It used to share the Roto tool's strip above the timeline (#kf-editor). A
// graph you drag keys around in wants height, and that strip could only take
// it from the picture; as a docked panel it is sized, moved and stacked like
// every other panel, and the strip goes back to being the roto tool's alone.
//
// Deliberately NOT the roto editor's speed graph. Roto animates one shape, so
// its curve is about timing; here every channel is a plain number — X, Y and Z
// in world units, or degrees, or a field of view — so the graph shows the value
// itself. Drag a key sideways to retime it, up and down to change that one
// channel. Easing stays where it belongs, on the key (Smooth / Linear / Hold in
// the previz panel).
import * as S from "./bEpicViewer_scene3d.js";

const AXES = ["X", "Y", "Z"];
const AXIS_COLORS = ["#ff6b6b", "#8ce26b", "#6bb6ff"];
const FOV_COLOR = "#ffb04d";

// Which channels the editor offers, in panel order. `fov` is a single number,
// so it draws one curve rather than three.
const CHANNELS = [
    { prop: "position", label: "Move" },
    { prop: "rotation", label: "Rotate" },
    { prop: "scale", label: "Scale" },
    { prop: "fov", label: "FOV" },
];

const GRAPH = { top: 10, bottom: 90 };

export const PrevizCurvesMixin = {

    _previzCurveHost() {
        return this.curvesPanel || null;
    },

    /** The channel on screen: the chosen one, or the first that has keys. */
    _previzCurveProp(item) {
        const wanted = this._previzCurveChannel;
        if (wanted && S.isAnimated(item, wanted)) return wanted;
        for (const { prop } of CHANNELS) {
            if (prop === "fov" && item.kind !== "camera") continue;
            if (S.isAnimated(item, prop)) return prop;
        }
        return null;
    },

    /**
     * Draw what the selection has to show.
     *
     * The panel is the dock's to open and close — previz only fills it in, and
     * says nothing at all while it is away. An item without keys still keeps
     * the panel: a graph that vanished whenever you clicked something else was
     * the strip's behaviour, and it made the panel feel broken.
     */
    previzRefreshCurves() {
        const host = this._previzCurveHost();
        if (!host) return;
        if (!this.isPrevizTab()) { this._previzHideCurves(); return; }
        if (!this.isPanelDocked("curves")) return;

        const ui = this._previzBuildCurveEditor(host);
        if (!ui) return;
        const item = this.previzSelectedItem();
        const prop = item ? this._previzCurveProp(item) : null;

        ui.body.style.display = prop ? "flex" : "none";
        ui.empty.style.display = prop ? "none" : "block";
        ui.empty.textContent = !item
            ? "Select something in the scene to see its animation."
            : `${item.name} has no keyframes yet — set one in the previz panel.`;
        if (!prop) { ui.sub.textContent = item ? item.name : ""; return; }

        const keys = S.track(item, prop).length;
        const label = (CHANNELS.find((c) => c.prop === prop) || {}).label || prop;
        ui.sub.textContent = `${item.name} · ${label} · ${keys} key${keys === 1 ? "" : "s"}`;
        this._previzDrawCurves(item, prop);
        this._previzSyncCurveButtons(item, prop);
    },

    /** Put the panel away — previz is over, or the tab is not a 3D one. */
    _previzHideCurves() {
        if (this.isPanelDocked && this.isPanelDocked("curves")) this.setPanelDocked("curves", false);
    },

    _previzBuildCurveEditor(host) {
        if (this._previzCurveUI && this._previzCurveUI.body.isConnected) return this._previzCurveUI;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        // The dock owns the title bar; everything below it is ours to replace.
        host.querySelectorAll(":scope > .curves-body, :scope > .curves-empty").forEach((n) => n.remove());

        const empty = el("div", "curves-empty");
        const body = el("div", "curves-body");

        const bar = el("div", "kf-channels");
        this._previzChannelBtns = {};
        for (const { prop, label } of CHANNELS) {
            const b = el("button", "previz-btn", label);
            b.onclick = () => { this._previzCurveChannel = prop; this.previzRefreshCurves(); };
            this._previzChannelBtns[prop] = b;
            bar.append(b);
        }
        this._previzAxisBtns = [];
        for (let i = 0; i < 3; i++) {
            const b = el("button", "kf-axis", AXES[i]);
            b.style.color = AXIS_COLORS[i];
            b.title = `Show or hide ${AXES[i]}`;
            b.onclick = () => {
                const hidden = this._previzHiddenAxes || (this._previzHiddenAxes = new Set());
                if (hidden.has(i)) hidden.delete(i); else hidden.add(i);
                this.previzRefreshCurves();
            };
            this._previzAxisBtns.push(b);
            bar.append(b);
        }
        const sub = el("div", "curves-sub");
        body.append(bar, sub);

        this._previzCurveWrap = el("div", "kf-graph");
        this._previzCurveSvg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        this._previzCurveSvg.setAttribute("class", "kf-graph-svg");
        this._previzCurveSvg.setAttribute("viewBox", "0 0 100 100");
        this._previzCurveSvg.setAttribute("preserveAspectRatio", "none");
        this._previzCurveWrap.append(this._previzCurveSvg);
        body.append(this._previzCurveWrap);

        body.append(el("div", "bepic-tool-hint",
            "Value over time. Drag a key sideways to retime it, up and down to change that channel; " +
            "double-click removes it. Easing is per key, in the previz panel."));
        host.append(empty, body);

        this._previzCurveUI = { body, empty, sub };
        return this._previzCurveUI;
    },

    _previzSyncCurveButtons(item, prop) {
        for (const { prop: p } of CHANNELS) {
            const btn = this._previzChannelBtns && this._previzChannelBtns[p];
            if (!btn) continue;
            const usable = (p !== "fov" || item.kind === "camera");
            btn.style.display = usable ? "" : "none";
            btn.classList.toggle("active", p === prop);
            btn.disabled = !S.isAnimated(item, p);
            btn.style.opacity = S.isAnimated(item, p) ? "1" : "0.45";
        }
        const hidden = this._previzHiddenAxes || new Set();
        for (let i = 0; i < 3; i++) {
            const b = this._previzAxisBtns[i];
            b.style.display = prop === "fov" ? "none" : "";
            b.classList.toggle("off", hidden.has(i));
        }
    },

    /** Frames → x%, values → y%, for the channel on screen. */
    _previzCurveGeom(item, prop) {
        const bounds = this.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);
        const keys = S.track(item, prop);
        const hidden = this._previzHiddenAxes || new Set();
        const axes = prop === "fov" ? [0] : [0, 1, 2].filter((i) => !hidden.has(i));

        let lo = Infinity, hi = -Infinity;
        for (const k of keys) {
            for (const a of axes) {
                const v = prop === "fov" ? k.v : k.v[a];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }       // a flat channel still needs a band
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;

        const X = (f) => ((f - bounds.min) / span) * 100;
        const Y = (v) => GRAPH.bottom - ((v - lo) / (hi - lo)) * (GRAPH.bottom - GRAPH.top);
        const frameAt = (xPct) => Math.round(bounds.min + (xPct / 100) * span);
        const valueAt = (yPct) => lo + ((GRAPH.bottom - yPct) / (GRAPH.bottom - GRAPH.top)) * (hi - lo);
        return { bounds, span, keys, axes, lo, hi, X, Y, frameAt, valueAt };
    },

    _previzDrawCurves(item, prop) {
        const svg = this._previzCurveSvg;
        if (!svg) return;
        const doc = svg.ownerDocument;
        const NS = "http://www.w3.org/2000/svg";
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const g = this._previzCurveGeom(item, prop);
        const line = (attrs) => {
            const n = doc.createElementNS(NS, attrs.tag || "line");
            delete attrs.tag;
            attrs["vector-effect"] = "non-scaling-stroke";
            for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
            return n;
        };

        svg.append(line({ x1: 0, y1: GRAPH.bottom, x2: 100, y2: GRAPH.bottom, stroke: "#333" }));
        svg.append(line({ x1: 0, y1: GRAPH.top, x2: 100, y2: GRAPH.top, stroke: "#262626" }));
        // Zero, when the channel's range crosses it — the line a move is read against.
        if (g.lo < 0 && g.hi > 0) {
            svg.append(line({ x1: 0, y1: g.Y(0), x2: 100, y2: g.Y(0), stroke: "#3a3a3a", "stroke-dasharray": "3 3" }));
        }
        for (const k of g.keys) {
            const x = g.X(k.f);
            svg.append(line({ x1: x, y1: GRAPH.top, x2: x, y2: GRAPH.bottom, stroke: "#ff8a00",
                              "stroke-dasharray": "2 2", opacity: 0.22 }));
        }

        // The curves themselves, sampled through the scene's own interpolation —
        // so smooth, linear and hold look here exactly as they play.
        const first = g.keys.length ? g.keys[0].f : 0;
        const last = g.keys.length ? g.keys[g.keys.length - 1].f : 0;
        const steps = Math.max(2, Math.min(240, Math.round((last - first) * 2) || 2));
        for (const a of g.axes) {
            let d = "";
            for (let i = 0; i <= steps; i++) {
                const f = first + ((last - first) * i) / steps;
                const value = S.valueAt(item, prop, f);
                const v = prop === "fov" ? value : value[a];
                d += (d === "" ? "M " : "L ") + g.X(f).toFixed(2) + " " + g.Y(v).toFixed(2) + " ";
            }
            svg.append(line({ tag: "path", d, fill: "none", "stroke-width": 2,
                              stroke: prop === "fov" ? FOV_COLOR : AXIS_COLORS[a] }));
        }

        const playhead = g.X(Math.round(this.currentFrame || 0));
        svg.append(line({ x1: playhead, y1: 0, x2: playhead, y2: 100, stroke: "#fff", opacity: 0.6 }));

        this._previzLayoutCurveDots(item, prop, g);
    },

    _previzLayoutCurveDots(item, prop, g) {
        const wrap = this._previzCurveWrap;
        if (!wrap) return;
        wrap.querySelectorAll(".kf-dot").forEach((d) => d.remove());
        const doc = wrap.ownerDocument;
        for (const k of g.keys) {
            for (const a of g.axes) {
                const v = prop === "fov" ? k.v : k.v[a];
                const dot = doc.createElement("div");
                dot.className = "kf-dot";
                dot.style.left = g.X(k.f) + "%";
                dot.style.top = g.Y(v) + "%";
                dot.style.background = prop === "fov" ? FOV_COLOR : AXIS_COLORS[a];
                const axis = prop === "fov" ? "" : ` ${AXES[a]}`;
                dot.title = `Frame ${k.f}${axis} = ${Math.round(v * 1000) / 1000}\n` +
                            "drag sideways to retime, up/down to change · double-click to delete";
                dot.onmousedown = (e) => this._previzCurveDotDown(e, item, prop, k.f, a);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    this.previzSnapshot("delete key");
                    S.removeKeyframe(item, k.f, prop);
                    this.previzChanged();
                };
                wrap.append(dot);
            }
        }
    },

    _previzCurveDotDown(e, item, prop, frame, axis) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const wrap = this._previzCurveWrap;
        const win = this._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        let current = frame;
        this.previzBeginDrag("move key");

        const onMove = (evt) => {
            const g = this._previzCurveGeom(item, prop);
            const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
            const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
            const wantFrame = Math.max(g.bounds.min, Math.min(g.bounds.max, g.frameAt(xPct)));
            const key = S.track(item, prop).find((k) => k.f === current);
            if (!key) return;

            // Sideways: retime the key (every channel of this property moves with
            // it — one key holds all three). Up/down: this channel's value only.
            const value = evt.shiftKey ? undefined : g.valueAt(yPct);
            const next = prop === "fov" ? (value === undefined ? key.v : value)
                                        : key.v.slice();
            if (prop !== "fov" && value !== undefined) next[axis] = value;

            if (wantFrame !== current && !S.track(item, prop).some((k) => k.f === wantFrame)) {
                S.removeKeyframe(item, current, prop);
                S.setKeyframe(item, prop, wantFrame, next, key.ease);
                current = wantFrame;
            } else {
                S.setKeyframe(item, prop, current, next, key.ease);
            }
            this.previzChanged({ persist: false, light: true });
        };
        const onUp = () => {
            win.removeEventListener("mousemove", onMove);
            win.removeEventListener("mouseup", onUp);
            this.previzEndDrag();
            this.previzChanged();          // one save at the end of the drag
        };
        win.addEventListener("mousemove", onMove);
        win.addEventListener("mouseup", onUp);
    },
};
