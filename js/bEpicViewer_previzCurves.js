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
// itself.
//
// CHANNELS
// The left column lists them one per line, named the way a DCC names them:
// translate.x, rotate.z, scale.y, fov. Any set of them can be on screen at
// once — that is the whole point of a graph editor, and it is what the old
// "one property plus three axis toggles" could not do. A channel with no keys
// still draws, as the flat line its static value is.
//
// TANGENTS
// Click a key to select it and its handles appear; drag one to shape the
// curve. Handles move together unless Alt breaks them, and double-clicking one
// gives the key back to its ease (Smooth / Linear / Hold in the previz panel).
// The numbers live on the key itself — see the tangent notes in
// bEpicViewer_scene3d.js.
import * as S from "./bEpicViewer_scene3d.js";

// Every channel an item can have, in the order they are listed. Colour is by
// axis, shaded by property, so translate.x and rotate.x are never the same
// line twice.
const CHANNELS = [
    { key: "position.0", prop: "position", axis: 0, label: "translate.x", color: "#ff6b6b" },
    { key: "position.1", prop: "position", axis: 1, label: "translate.y", color: "#8ce26b" },
    { key: "position.2", prop: "position", axis: 2, label: "translate.z", color: "#6bb6ff" },
    { key: "rotation.0", prop: "rotation", axis: 0, label: "rotate.x", color: "#ff9d4d" },
    { key: "rotation.1", prop: "rotation", axis: 1, label: "rotate.y", color: "#c8e24d" },
    { key: "rotation.2", prop: "rotation", axis: 2, label: "rotate.z", color: "#4dc8ff" },
    { key: "scale.0", prop: "scale", axis: 0, label: "scale.x", color: "#ff6bd5" },
    { key: "scale.1", prop: "scale", axis: 1, label: "scale.y", color: "#6be2c8" },
    { key: "scale.2", prop: "scale", axis: 2, label: "scale.z", color: "#9d8cff" },
    { key: "fov", prop: "fov", axis: 0, label: "fov", color: "#ffd24d" },
];

const GRAPH = { top: 10, bottom: 90 };
// How far a tangent handle reaches, as a share of the frame range on screen.
const HANDLE_SPAN = 0.06;

export const PrevizCurvesMixin = {

    _previzCurveHost() {
        return this.curvesPanel || null;
    },

    /** Which channels an item can show at all: no field of view on a box. */
    _previzChannelsFor(item) {
        return CHANNELS.filter((c) => c.prop !== "fov" || item.kind === "camera");
    },

    /**
     * The channels on screen.
     *
     * Chosen by hand once anything has been clicked in the list; until then,
     * whatever the item actually animates — which is the answer nine times out
     * of ten, and beats opening on an empty graph.
     */
    _previzShownChannels(item) {
        const usable = this._previzChannelsFor(item);
        const picked = this._previzCurveShown;
        if (picked && picked.size) {
            const chosen = usable.filter((c) => picked.has(c.key));
            if (chosen.length) return chosen;
        }
        return usable.filter((c) => S.isAnimated(item, c.prop));
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
        const shown = item ? this._previzShownChannels(item) : [];
        const anyKeys = item ? S.keyframeFrames(item).length > 0 : false;

        ui.body.style.display = item ? "flex" : "none";
        ui.empty.style.display = item ? "none" : "block";
        ui.empty.textContent = "Select something in the scene to see its animation.";
        if (!item) return;

        this._previzSyncChannelList(ui, item, shown);
        ui.sub.textContent = anyKeys
            ? `${item.name} · ${shown.length} channel${shown.length === 1 ? "" : "s"}`
            : `${item.name} · no keyframes yet`;
        this._previzDrawCurves(item, shown);
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

        // Left: the channel list. Right: the graph, with its own header.
        const list = el("div", "curves-channels");
        this._previzChannelRows = {};
        for (const ch of CHANNELS) {
            const row = el("button", "curves-ch", ch.label);
            row.style.setProperty("--ch", ch.color);
            row.title = `Show or hide ${ch.label}`;
            row.onclick = (e) => this._previzToggleChannel(ch.key, e.shiftKey || e.ctrlKey || e.metaKey);
            this._previzChannelRows[ch.key] = row;
            list.append(row);
        }

        const right = el("div", "curves-graph-col");
        const sub = el("div", "curves-sub");
        right.append(sub);

        this._previzCurveWrap = el("div", "kf-graph");
        this._previzCurveSvg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        this._previzCurveSvg.setAttribute("class", "kf-graph-svg");
        this._previzCurveSvg.setAttribute("viewBox", "0 0 100 100");
        this._previzCurveSvg.setAttribute("preserveAspectRatio", "none");
        this._previzCurveWrap.append(this._previzCurveSvg);
        // A click on the graph itself, clear of any key, drops the selection —
        // and with it the handles.
        this._previzCurveWrap.onmousedown = (e) => {
            if (e.target.closest(".kf-dot, .kf-tan")) return;
            this._previzCurveKey = null;
            this.previzRefreshCurves();
        };
        right.append(this._previzCurveWrap);

        right.append(el("div", "bepic-tool-hint",
            "Drag a key sideways to retime it, up and down to change it; double-click removes it. " +
            "Click a key for its tangents — drag a handle to shape the curve, Alt to break it, " +
            "double-click it to hand the key back to its ease."));
        body.append(list, right);
        host.append(empty, body);

        this._previzCurveUI = { body, empty, sub, list };
        return this._previzCurveUI;
    },

    /** Show or hide one channel. Plain click picks it alone; Shift adds. */
    _previzToggleChannel(key, add) {
        const item = this.previzSelectedItem();
        if (!item) return;
        let shown = this._previzCurveShown;
        if (!shown || !shown.size) {
            // The first click starts from what is on screen, so nothing jumps.
            shown = new Set(this._previzShownChannels(item).map((c) => c.key));
        }
        if (add) {
            if (shown.has(key)) shown.delete(key); else shown.add(key);
        } else {
            shown = new Set([key]);
        }
        this._previzCurveShown = shown;
        this.previzRefreshCurves();
    },

    _previzSyncChannelList(ui, item, shown) {
        const usable = new Set(this._previzChannelsFor(item).map((c) => c.key));
        const on = new Set(shown.map((c) => c.key));
        for (const ch of CHANNELS) {
            const row = this._previzChannelRows[ch.key];
            if (!row) continue;
            row.style.display = usable.has(ch.key) ? "" : "none";
            row.classList.toggle("on", on.has(ch.key));
            row.classList.toggle("animated", S.isAnimated(item, ch.prop));
        }
    },

    // ── Geometry ─────────────────────────────────────────────────────────────

    /** Frames → x%, values → y%, across every channel on screen. */
    _previzCurveGeom(item, shown) {
        const bounds = this.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);

        let lo = Infinity, hi = -Infinity;
        const see = (v) => { if (v < lo) lo = v; if (v > hi) hi = v; };
        for (const ch of shown) {
            const keys = S.track(item, ch.prop);
            if (!keys.length) { see(S.componentOf(S.valueAt(item, ch.prop, bounds.min), ch.axis)); continue; }
            for (const k of keys) see(S.componentOf(k.v, ch.axis));
            // A curve with handles can leave the band its keys sit in, so the
            // drawn shape is sampled rather than guessed at.
            for (let i = 0; i < keys.length - 1; i++) {
                for (let n = 1; n < 8; n++) {
                    const f = keys[i].f + ((keys[i + 1].f - keys[i].f) * n) / 8;
                    see(S.componentOf(S.valueAt(item, ch.prop, f), ch.axis));
                }
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
        return { bounds, span, lo, hi, X, Y, frameAt, valueAt, shown };
    },

    // ── Drawing ──────────────────────────────────────────────────────────────

    _previzDrawCurves(item, shown) {
        const svg = this._previzCurveSvg;
        if (!svg) return;
        const doc = svg.ownerDocument;
        const NS = "http://www.w3.org/2000/svg";
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const g = this._previzCurveGeom(item, shown);
        const line = (attrs) => {
            const n = doc.createElementNS(NS, attrs.tag || "line");
            delete attrs.tag;
            attrs["vector-effect"] = "non-scaling-stroke";
            for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
            svg.append(n);
            return n;
        };

        line({ x1: 0, y1: GRAPH.bottom, x2: 100, y2: GRAPH.bottom, stroke: "#333" });
        line({ x1: 0, y1: GRAPH.top, x2: 100, y2: GRAPH.top, stroke: "#262626" });
        // Zero, when the band crosses it — the line a move is read against.
        if (g.lo < 0 && g.hi > 0) {
            line({ x1: 0, y1: g.Y(0), x2: 100, y2: g.Y(0), stroke: "#3a3a3a", "stroke-dasharray": "3 3" });
        }
        for (const f of S.keyframeFrames(item)) {
            const x = g.X(f);
            line({ x1: x, y1: GRAPH.top, x2: x, y2: GRAPH.bottom, stroke: "#ff8a00",
                   "stroke-dasharray": "2 2", opacity: 0.22 });
        }

        // The curves themselves, sampled through the scene's own interpolation —
        // so smooth, linear, hold and a dragged handle all look here exactly as
        // they play.
        for (const ch of g.shown) {
            const keys = S.track(item, ch.prop);
            let d = "";
            if (!keys.length) {
                const v = S.componentOf(S.valueAt(item, ch.prop, g.bounds.min), ch.axis);
                d = `M 0 ${g.Y(v).toFixed(2)} L 100 ${g.Y(v).toFixed(2)}`;
            } else {
                const first = keys[0].f, last = keys[keys.length - 1].f;
                const steps = Math.max(2, Math.min(240, Math.round((last - first) * 2) || 2));
                for (let i = 0; i <= steps; i++) {
                    const f = first + ((last - first) * i) / steps;
                    const v = S.componentOf(S.valueAt(item, ch.prop, f), ch.axis);
                    d += (d === "" ? "M " : "L ") + g.X(f).toFixed(2) + " " + g.Y(v).toFixed(2) + " ";
                }
            }
            line({ tag: "path", d, fill: "none", "stroke-width": 2, stroke: ch.color,
                   opacity: keys.length ? 1 : 0.5 });
        }

        const playhead = g.X(Math.round(this.currentFrame || 0));
        line({ x1: playhead, y1: 0, x2: playhead, y2: 100, stroke: "#fff", opacity: 0.6 });

        this._previzLayoutCurveDots(item, g);
    },

    _previzLayoutCurveDots(item, g) {
        const wrap = this._previzCurveWrap;
        if (!wrap) return;
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        const doc = wrap.ownerDocument;
        const sel = this._previzCurveKey;

        for (const ch of g.shown) {
            for (const k of S.track(item, ch.prop)) {
                const v = S.componentOf(k.v, ch.axis);
                const dot = doc.createElement("div");
                const chosen = !!sel && sel.prop === ch.prop && sel.f === k.f;
                dot.className = "kf-dot" + (chosen ? " chosen" : "");
                dot.style.left = g.X(k.f) + "%";
                dot.style.top = g.Y(v) + "%";
                dot.style.background = ch.color;
                dot.title = `${ch.label} · frame ${k.f} = ${Math.round(v * 1000) / 1000}\n` +
                            "drag sideways to retime, up/down to change · click for tangents · double-click to delete";
                dot.onmousedown = (e) => this._previzCurveDotDown(e, item, ch, k.f, g);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    this.previzSnapshot("delete key");
                    S.removeKeyframe(item, k.f, ch.prop);
                    if (chosen) this._previzCurveKey = null;
                    this.previzChanged();
                };
                wrap.append(dot);

                if (chosen) this._previzLayoutTangents(item, ch, k, g);
            }
        }
    },

    /** The two handles of the selected key, on this channel's curve. */
    _previzLayoutTangents(item, ch, key, g) {
        const wrap = this._previzCurveWrap;
        const doc = wrap.ownerDocument;
        const reach = Math.max(1, g.span * HANDLE_SPAN);
        const v = S.componentOf(key.v, ch.axis);

        for (const side of ["in", "out"]) {
            const keys = S.track(item, ch.prop);
            const i = keys.indexOf(key);
            // No handle where there is no curve: nothing comes into the first
            // key, and nothing leaves the last.
            if (side === "in" && i <= 0) continue;
            if (side === "out" && i >= keys.length - 1) continue;

            const slope = S.tangentAt(item, ch.prop, key.f, ch.axis, side);
            const dir = side === "in" ? -1 : 1;
            const hx = key.f + dir * reach;
            const hy = v + dir * reach * slope;

            const l = doc.createElement("div");
            l.className = "kf-tan-line";
            const x1 = g.X(key.f), y1 = g.Y(v), x2 = g.X(hx), y2 = g.Y(hy);
            const rect = wrap.getBoundingClientRect();
            const dx = ((x2 - x1) / 100) * (rect.width || 1);
            const dy = ((y2 - y1) / 100) * (rect.height || 1);
            l.style.left = x1 + "%";
            l.style.top = y1 + "%";
            l.style.width = `${Math.hypot(dx, dy)}px`;
            l.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
            l.style.background = ch.color;
            wrap.append(l);

            const h = doc.createElement("div");
            h.className = "kf-tan";
            h.style.left = x2 + "%";
            h.style.top = y2 + "%";
            h.style.borderColor = ch.color;
            h.title = `${ch.label} · ${side === "in" ? "incoming" : "outgoing"} tangent ` +
                      `(${Math.round(slope * 1000) / 1000} per frame)\n` +
                      "drag to shape · Alt to break the pair · double-click for the key's ease again";
            h.onmousedown = (e) => this._previzTangentDown(e, item, ch, key, side, g);
            h.ondblclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                this.previzSnapshot("reset tangents");
                S.clearTangents(item, ch.prop, key.f);
                this.previzChanged();
            };
            wrap.append(h);
        }
    },

    // ── Dragging ─────────────────────────────────────────────────────────────

    _previzCurveDotDown(e, item, ch, frame, geom) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Clicking a key is also how you ask for its handles.
        this._previzCurveKey = { prop: ch.prop, f: frame };
        const wrap = this._previzCurveWrap;
        const win = this._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        let current = frame;
        let moved = false;
        this.previzBeginDrag("move key");

        const onMove = (evt) => {
            moved = true;
            const g = this._previzCurveGeom(item, geom.shown);
            const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
            const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
            const wantFrame = Math.max(g.bounds.min, Math.min(g.bounds.max, g.frameAt(xPct)));
            const key = S.track(item, ch.prop).find((k) => k.f === current);
            if (!key) return;

            // Sideways: retime the key (every channel of this property moves with
            // it — one key holds all three). Up/down: this channel only.
            const value = evt.shiftKey ? undefined : g.valueAt(yPct);
            let next = key.v;
            if (value !== undefined) {
                next = Array.isArray(key.v) ? key.v.slice() : value;
                if (Array.isArray(next)) next[ch.axis] = value;
            }

            if (wantFrame !== current && !S.track(item, ch.prop).some((k) => k.f === wantFrame)) {
                S.removeKeyframe(item, current, ch.prop);
                S.setKeyframe(item, ch.prop, wantFrame, next, key.ease);
                current = wantFrame;
                this._previzCurveKey = { prop: ch.prop, f: current };
            } else {
                S.setKeyframe(item, ch.prop, current, next, key.ease);
            }
            this.previzChanged({ persist: false, light: true });
        };
        const onUp = () => {
            win.removeEventListener("mousemove", onMove);
            win.removeEventListener("mouseup", onUp);
            this.previzEndDrag();
            if (!moved) this.previzSnapshot("select key");   // keeps undo honest
            this.previzChanged();          // one save at the end of the drag
        };
        win.addEventListener("mousemove", onMove);
        win.addEventListener("mouseup", onUp);
    },

    /**
     * Drag a tangent handle.
     *
     * The slope is read straight off the pointer: where it is, relative to the
     * key, IS the direction the curve leaves in. Dragging back past the key
     * would flip the handle to the other side, so the reach is clamped to stay
     * on its own side of the key.
     */
    _previzTangentDown(e, item, ch, key, side, geom) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const wrap = this._previzCurveWrap;
        const win = this._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        const broken = e.altKey;
        this.previzBeginDrag(broken ? "break tangent" : "shape tangent");

        const onMove = (evt) => {
            const g = this._previzCurveGeom(item, geom.shown);
            const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
            const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
            const dir = side === "in" ? -1 : 1;
            const df = (g.bounds.min + (xPct / 100) * g.span) - key.f;
            const minReach = Math.max(0.5, g.span * 0.01);
            const reach = dir * Math.max(minReach, dir * df);
            const dv = g.valueAt(yPct) - S.componentOf(key.v, ch.axis);
            S.setTangent(item, ch.prop, key.f, ch.axis, dv / reach, { side, broken });
            this.previzChanged({ persist: false, light: true });
        };
        const onUp = () => {
            win.removeEventListener("mousemove", onMove);
            win.removeEventListener("mouseup", onUp);
            this.previzEndDrag();
            this.previzChanged();
        };
        win.addEventListener("mousemove", onMove);
        win.addEventListener("mouseup", onUp);
    },
};
