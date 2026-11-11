// imageViewer_previzCurves.js
// The previz animation curves: the selected item's keys drawn as value over
// time, in a dock panel of their own (#curves-panel), alongside the previz
// panel and reached from the 3D toolbar.
//
// It used to share the Roto tool's strip above the timeline (#kf-editor). A
// graph you drag keys around in wants height, and that strip could only take
// it from the picture; as a docked panel it is sized, moved and stacked like
// every other panel. The roto tool has since followed it into a panel of its
// own (imageViewer_rotoCurves.js), built from the same parts
// (imageViewer_curveUI.js), and the strip is gone.
//
// Deliberately NOT the roto editor's speed graph. Roto animates one shape, so
// its curve is about timing; here every channel is a plain number — X, Y and Z
// in world units, or degrees, or a field of view — so the graph shows the value
// itself.
//
// CHANNELS
// The left column lists them one per line, named the way a DCC names them:
// translate.x, rotate.z, scale.y, pivot.x, fov. Any set of them can be on
// screen at once — that is the whole point of a graph editor, and it is what
// the old "one property plus three axis toggles" could not do. A channel with
// no keys still draws, as the flat line its static value is.
//
// Select several objects and each gets its own section, headed by its name and
// foldable, so a scene's worth of channels stays a list you can read. A curve
// is then Name.channel — the full name is on every key's tooltip — and each
// object's shade of a colour is its own, so two objects' translate.x are told
// apart at a glance.
//
// TANGENTS
// Click a key to select it and its handles appear; drag one to shape the
// curve. Handles move together unless Alt breaks them, and double-clicking one
// gives the key back to its ease (Smooth / Linear / Hold in the previz panel).
// The numbers live on the key itself — see the tangent notes in
// imageViewer_scene3d.js.
import * as S from "./imageViewer_scene3d.js";
import { eulerFilter } from "./imageViewer_eulerFilter.js";
import { notice } from "./imageViewer_exportUI.js";
import { buildCurvePanel, svgLine, tangentArm } from "./imageViewer_curveUI.js";
import * as A from "./imageViewer_animTools.js";

const INFINITY_LABELS = [["constant", "Constant"], ["linear", "Linear"], ["cycle", "Cycle"],
                         ["offset", "Cycle with offset"], ["oscillate", "Oscillate"]];

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
    { key: "pivot.0", prop: "pivot", axis: 0, label: "pivot.x", color: "#c98a8a" },
    { key: "pivot.1", prop: "pivot", axis: 1, label: "pivot.y", color: "#a5c98a" },
    { key: "pivot.2", prop: "pivot", axis: 2, label: "pivot.z", color: "#8aa8c9" },
    { key: "fov", prop: "fov", axis: 0, label: "fov", color: "#ffd24d" },
    { key: "ikfk", prop: "ikfk", axis: 0, label: "ikBlend", color: "#4dff9a" },
];

const EULER_TIP = "Euler filter — removes 180° flips between rotation keys so turns interpolate " +
                 "smoothly; the poses at the keys don't change.";

const GRAPH = { top: 10, bottom: 90 };

/**
 * One object's shade of a channel colour.
 *
 * The first object keeps the colour as it is; the ones after it are lightened
 * and darkened in turn, which stays legible far longer than picking unrelated
 * hues per object would.
 */
function shade(hex, index) {
    if (!index) return hex;
    const n = parseInt(hex.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const step = Math.ceil(index / 2) * 0.26;
    const towards = index % 2 ? 255 : 0;          // lighter, then darker, ...
    const mixed = rgb.map((c) => Math.round(c + (towards - c) * Math.min(0.8, step)));
    return "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("");
}
// How far a tangent handle reaches, as a share of the frame range on screen.
const HANDLE_SPAN = 0.06;

export const PrevizCurvesMixin = {

    _previzCurveHost() {
        return this.curvesPanel || null;
    },

    /** Which channels an item can show at all: no field of view on a box. */
    _previzChannelsFor(item) {
        const ik = item.kind === "control" && item.control && item.control.type === "ik";
        const own = CHANNELS.filter((c) => (c.prop !== "fov" || item.kind === "camera")
                                   && (c.prop !== "pivot" || (item.kind !== "camera" && item.kind !== "control"))
                                   && (c.prop !== "scale" || item.kind !== "control")
                                   && (c.prop !== "ikfk" || ik));
        // A constraint's weights are channels too (imageViewer_previzConstraints.js).
        const extra = this._previzConstraintCurveChannels ? this._previzConstraintCurveChannels(item) : [];
        return extra.length ? [...own, ...extra] : own;
    },

    /** The objects the editor is showing: everything selected, in scene order. */
    _previzCurveItems() {
        const scene = this.previzScene();
        if (!scene) return [];
        return (scene.items || []).filter((it) => this.previzIsSelected(it.id));
    },

    /**
     * Euler filter on the rotation tracks of the selected objects - or, when
     * the panel has been told which channels to show, only the objects that
     * have a rotate channel on screen. One undo step.
     */
    previzEulerFilter() {
        const items = this._previzCurveItems();
        const picked = this._previzCurveShown;
        const targets = items.filter((it) => S.track(it, "rotation").length > 1
            && (!picked || !picked.size || [0, 1, 2].some((a) => picked.has(`${it.id}|rotation.${a}`))));
        if (!targets.length) {
            notice("info", "Euler filter", "Select an object with at least two rotation keys.");
            return 0;
        }
        const results = targets.map((it) => ({ it, r: eulerFilter(S.track(it, "rotation")) }));
        const total = results.reduce((n, x) => n + x.r.changed, 0);
        if (!total) {
            notice("info", "Euler filter", "No flips found - 0 keys changed.");
            return 0;
        }
        this.previzSnapshot("Euler filter");
        for (const { it, r } of results) it.tracks.rotation = r.keys;
        this.previzChanged();
        notice("success", "Euler filter", `${total} key${total === 1 ? "" : "s"} changed on ` +
               `${targets.length} object${targets.length === 1 ? "" : "s"}.`);
        return total;
    },

    /** One line of the graph: an object, a channel, and the colour it wears. */
    _previzCurveLines() {
        const items = this._previzCurveItems();
        const picked = this._previzCurveShown;
        const out = [];
        items.forEach((item, index) => {
            const usable = this._previzChannelsFor(item);
            const chosen = picked && picked.size
                ? usable.filter((c) => picked.has(`${item.id}|${c.key}`))
                : usable.filter((c) => S.isAnimated(item, c.prop));
            for (const ch of chosen) {
                out.push({ ...ch, item, index, color: shade(ch.color, index),
                           label: items.length > 1 ? `${item.name}.${ch.label}` : ch.label });
            }
        });
        return out;
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
        // The Dope Sheet is redrawn by everything that redraws the curves.
        if (this.previzRefreshDopeSheet) this.previzRefreshDopeSheet();
        const host = this._previzCurveHost();
        if (!host) return;
        if (!this.isPrevizTab()) { this._previzHideCurves(); return; }
        if (!this.isPanelDocked("curves")) return;

        const ui = this._previzBuildCurveEditor(host);
        if (!ui) return;
        const items = this._previzCurveItems();
        const lines = this._previzCurveLines();

        ui.body.style.display = items.length ? "flex" : "none";
        ui.empty.style.display = items.length ? "none" : "block";
        ui.empty.textContent = "Select something in the scene to see its animation.";
        if (!items.length) return;

        this._previzSyncChannelList(ui, items, lines);
        const anyKeys = items.some((it) => S.keyframeFrames(it).length > 0);
        const what = items.length === 1 ? items[0].name : `${items.length} objects`;
        ui.sub.textContent = anyKeys
            ? `${what} · ${lines.length} channel${lines.length === 1 ? "" : "s"}`
            : `${what} · no keyframes yet`;
        this._previzDrawCurves(lines);
    },

    /** Put the panel away — previz is over, or the tab is not a 3D one. */
    _previzHideCurves() {
        if (this.isPanelDocked && this.isPanelDocked("curves")) this.setPanelDocked("curves", false);
    },

    _previzBuildCurveEditor(host) {
        if (this._previzCurveUI && this._previzCurveUI.body.isConnected) return this._previzCurveUI;
        // The skeleton is shared with the Roto Curves (imageViewer_curveUI.js).
        const ui = buildCurvePanel(host, {
            listWidth: this._previzCurveListW || 120,
            onListWidth: (w) => { this._previzCurveListW = w; },
            onResized: () => this.previzRefreshCurves(),
            // A click on the graph itself, clear of any key, drops the
            // selection — and with it the handles.
            onBlank: () => { this._previzCurveKey = null; this.previzRefreshCurves(); },
            hint: "Drag a key sideways to retime it, up and down to change it; double-click removes it. " +
                  "Click a key for its tangents — drag a handle to shape the curve, Alt to break it, " +
                  "double-click it to hand the key back to its ease.",
        });
        this._previzCurveWrap = ui.wrap;
        this._previzCurveSvg = ui.svg;
        this._previzCurveUI = ui;
        this._previzCurveToolbar(ui);
        return ui;
    },

    // ── Tools: buffer curves, simplify, infinity, retime, Euler ─────────────

    /** The bar over the graph. Every tool works on the curves on screen. */
    _previzCurveToolbar(ui) {
        const doc = ui.sub.ownerDocument;
        const bar = doc.createElement("div");
        bar.className = "curves-tools";
        const btn = (label, title, run) => {
            const b = doc.createElement("button");
            b.className = "previz-btn curves-tool";
            b.textContent = label;
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(b); };
            bar.append(b);
            return b;
        };
        const menuAt = (b, entries) => {
            const r = b.getBoundingClientRect();
            this._previzOpenMenu(entries, r.left, r.bottom + 2, b);
        };
        ui.bufferBtn = btn("Buffer", "Keep a copy of the curves on screen (drawn grey behind them)",
            () => this.previzCurveBufferSnap());
        ui.swapBtn = btn("Swap", "Trade the curves with the buffer copy - press again to trade back",
            () => this.previzCurveBufferSwap());
        btn("Simplify\u2026", "Fewer keys for the same curve: drops what the curve does not need",
            (b) => this._dsAskNumber(b, "Keep within (% of each channel's range)", this._previzSimplifyTol ?? 1,
                (v) => { this._previzSimplifyTol = v; this.previzCurveSimplify(v / 100); }, { step: 0.1, min: 0.01 }));
        for (const [side, label] of [["pre", "Pre \u221e"], ["post", "Post \u221e"]]) {
            btn(`${label} \u25be`, side === "pre" ? "What the curves do before their first key"
                                                : "What the curves do after their last key",
                (b) => menuAt(b, INFINITY_LABELS.map(([mode, name]) => ({
                    label: name, run: () => this.previzCurveInfinity(side, mode) }))));
        }
        btn("Retime\u2026", "Spread or squeeze the keys between two frames; what comes after moves along",
            (b) => {
                const shown = this._previzCurveTrackList();
                const fr = shown.flatMap(({ id, prop }) => S.track(S.itemById(this.previzScene(), id), prop).map((k) => k.f));
                const lo = fr.length ? Math.min(...fr) : 0, hi = fr.length ? Math.max(...fr) : 24;
                this._dsAskFields(b, [
                    { name: "from", label: "From frame", value: lo },
                    { name: "to", label: "To frame", value: hi },
                    { name: "newTo", label: "Ends on frame", value: hi },
                    { name: "ripple", label: "Move later keys too", type: "checkbox", value: true },
                ], (v) => this.previzCurveRetime(v.from, v.to, v.newTo, v.ripple));
            });
        btn("Euler", EULER_TIP, () => this.previzEulerFilter());
        ui.sub.parentNode.insertBefore(bar, ui.sub);
        ui.tools = bar;
    },

    /** The tracks behind the curves on screen: one {id, prop} each. */
    _previzCurveTrackList() {
        const seen = new Set(), out = [];
        for (const l of this._previzCurveLines()) {
            const k = `${l.item.id}|${l.prop}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ id: l.item.id, prop: l.prop });
        }
        return out;
    },

    _previzCurveNeedTracks(what) {
        const tracks = this._previzCurveTrackList().filter(({ id, prop }) =>
            S.track(S.itemById(this.previzScene(), id), prop).length);
        if (!tracks.length) notice("info", what, "Show an animated channel in the Curve Editor first.");
        return tracks;
    },

    previzCurveBufferSnap() {
        const tracks = this._previzCurveNeedTracks("Buffer curve");
        if (!tracks.length) return 0;
        this._previzCurveBuffer = A.snapshotTracks(this.previzScene().items, tracks);
        this.previzRefreshCurves();
        notice("info", "Buffer curve", `Kept ${tracks.length} curve${tracks.length === 1 ? "" : "s"}.`);
        return tracks.length;
    },

    previzCurveBufferSwap() {
        const buf = this._previzCurveBuffer;
        if (!buf || !buf.size) { notice("info", "Swap with buffer", "Press Buffer first to keep a copy."); return 0; }
        this.previzSnapshot("swap buffer curves");
        const { buffer, swapped } = A.swapTracks(this.previzScene().items, buf);
        this._previzCurveBuffer = buffer;
        this.previzChanged();
        return swapped;
    },

    previzCurveSimplify(tolerance = 0.01) {
        const tracks = this._previzCurveNeedTracks("Simplify");
        if (!tracks.length) return null;
        const scene = this.previzScene();
        this.previzSnapshot("simplify curves");
        let before = 0, after = 0, skipped = 0;
        for (const { id, prop } of tracks) {
            const r = A.simplifyTrack(S.itemById(scene, id), prop, tolerance);
            before += r.before; after += r.after; if (r.skipped) skipped++;
        }
        this._previzCurveKey = null;
        this.previzChanged();
        notice("success", "Simplify", `${before} keys \u2192 ${after}` +
               (skipped ? ` (${skipped} stepped curve${skipped === 1 ? "" : "s"} left as they were)` : "") + ".");
        return { before, after, skipped };
    },

    previzCurveInfinity(side, mode) {
        const tracks = this._previzCurveNeedTracks("Infinity");
        if (!tracks.length) return 0;
        const scene = this.previzScene();
        this.previzSnapshot(`${side === "pre" ? "pre" : "post"}-infinity ${mode}`);
        for (const { id, prop } of tracks) S.setInfinity(S.itemById(scene, id), prop, { [side]: mode });
        this.previzChanged();
        return tracks.length;
    },

    previzCurveRetime(from, to, newTo, ripple = true) {
        const tracks = this._previzCurveNeedTracks("Retime");
        if (!tracks.length) return 0;
        if (!(Number(to) > Number(from)) || !(Number(newTo) > Number(from))) {
            notice("info", "Retime", "The range has to end after it starts.");
            return 0;
        }
        this.previzSnapshot("retime keys");
        const n = A.retimeKeys(this.previzScene().items, tracks, Number(from), Number(to), Number(newTo), !!ripple);
        this._previzCurveKey = null;
        this.previzChanged();
        return n;
    },

    /** Show or hide one channel of one object. Plain click picks it alone. */
    _previzToggleChannel(id, add) {
        let shown = this._previzCurveShown;
        if (!shown || !shown.size) {
            // The first click starts from what is on screen, so nothing jumps.
            shown = new Set(this._previzCurveLines().map((l) => `${l.item.id}|${l.key}`));
        }
        if (add) {
            if (shown.has(id)) shown.delete(id); else shown.add(id);
        } else {
            shown = new Set([id]);
        }
        this._previzCurveShown = shown;
        this.previzRefreshCurves();
    },

    /**
     * The list: each object's name, then its channels under it.
     *
     * Rebuilt rather than hidden and shown, because which objects are in it
     * changes with the selection — and it is a couple of dozen small rows.
     */
    _previzSyncChannelList(ui, items, lines) {
        const doc = ui.list.ownerDocument;
        const on = new Set(lines.map((l) => `${l.item.id}|${l.key}`));
        const folded = this._previzCurveFolded || (this._previzCurveFolded = new Set());
        ui.list.innerHTML = "";
        items.forEach((item, index) => {
            if (items.length > 1) {
                const head = doc.createElement("button");
                head.className = "curves-obj" + (folded.has(item.id) ? " folded" : "");
                head.textContent = `${folded.has(item.id) ? "\u25b8" : "\u25be"} ${item.name}`;
                head.title = "Fold this object's channels away";
                head.onclick = () => {
                    if (folded.has(item.id)) folded.delete(item.id); else folded.add(item.id);
                    this.previzRefreshCurves();
                };
                ui.list.append(head);
                if (folded.has(item.id)) return;
            }
            for (const ch of this._previzChannelsFor(item)) {
                const id = `${item.id}|${ch.key}`;
                const row = doc.createElement("button");
                row.className = "curves-ch";
                row.textContent = ch.label;
                row.style.setProperty("--ch", shade(ch.color, index));
                row.title = `Show or hide ${item.name}.${ch.label}`;
                row.classList.toggle("on", on.has(id));
                row.classList.toggle("animated", S.isAnimated(item, ch.prop));
                row.onclick = (e) => this._previzToggleChannel(id, e.shiftKey || e.ctrlKey || e.metaKey);
                ui.list.append(row);
            }
        });
    },

    // ── Geometry ─────────────────────────────────────────────────────────────

    /** Frames → x%, values → y%, across every channel on screen. */
    _previzCurveGeom(lines) {
        const bounds = this.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);

        let lo = Infinity, hi = -Infinity;
        const see = (v) => { if (v < lo) lo = v; if (v > hi) hi = v; };
        for (const ch of lines) {
            const item = ch.item;
            const keys = S.track(item, ch.prop);
            if (!keys.length) { see(S.componentOf(S.valueAt(item, ch.prop, bounds.min), ch.axis)); continue; }
            // A curve that goes on past its keys is drawn to the ends of the shot.
            const inf = S.infinityOf(item, ch.prop);
            if (keys.length > 1 && (inf.pre !== "constant" || inf.post !== "constant")) {
                for (let n = 0; n <= 48; n++) {
                    see(S.componentOf(S.valueAt(item, ch.prop, bounds.min + (span * n) / 48), ch.axis));
                }
            }
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
        return { bounds, span, lo, hi, X, Y, frameAt, valueAt, lines };
    },

    // ── Drawing ──────────────────────────────────────────────────────────────

    _previzDrawCurves(lines) {
        const svg = this._previzCurveSvg;
        if (!svg) return;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const g = this._previzCurveGeom(lines);
        const line = (attrs) => svgLine(svg, attrs);

        line({ x1: 0, y1: GRAPH.bottom, x2: 100, y2: GRAPH.bottom, stroke: "#333" });
        line({ x1: 0, y1: GRAPH.top, x2: 100, y2: GRAPH.top, stroke: "#262626" });
        // Zero, when the band crosses it — the line a move is read against.
        if (g.lo < 0 && g.hi > 0) {
            line({ x1: 0, y1: g.Y(0), x2: 100, y2: g.Y(0), stroke: "#3a3a3a", "stroke-dasharray": "3 3" });
        }
        const everyKey = new Set();
        for (const ch of g.lines) for (const f of S.keyframeFrames(ch.item)) everyKey.add(f);
        for (const f of everyKey) {
            const x = g.X(f);
            line({ x1: x, y1: GRAPH.top, x2: x, y2: GRAPH.bottom, stroke: "#ff8a00",
                   "stroke-dasharray": "2 2", opacity: 0.22 });
        }

        // The buffer copies first, grey and dashed under the live curves.
        const buf = this._previzCurveBuffer;
        if (buf && buf.size) {
            for (const ch of g.lines) {
                const keys = buf.get(`${ch.item.id}|${ch.prop}`);
                if (!keys || !keys.length) continue;
                let d = "";
                for (let i = 0; i <= 160; i++) {
                    const f = g.bounds.min + (g.span * i) / 160;
                    const v = S.componentOf(A.bufferValueAt(ch.item, ch.prop, keys, f), ch.axis);
                    d += (d === "" ? "M " : "L ") + g.X(f).toFixed(2) + " " + g.Y(v).toFixed(2) + " ";
                }
                line({ tag: "path", d, fill: "none", "stroke-width": 1.5, stroke: "#8a8a8a",
                       "stroke-dasharray": "4 3", opacity: 0.7, class: "curves-buffer" });
            }
        }

        // The curves themselves, sampled through the scene's own interpolation —
        // so smooth, linear, hold and a dragged handle all look here exactly as
        // they play.
        for (const ch of g.lines) {
            const item = ch.item;
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
            // Before the first key and after the last: what the infinity makes of it, dashed.
            if (keys.length > 1) {
                const inf = S.infinityOf(item, ch.prop);
                for (const [side, a, b] of [["pre", g.bounds.min, keys[0].f],
                                            ["post", keys[keys.length - 1].f, g.bounds.max]]) {
                    if (inf[side] === "constant" || b <= a) continue;
                    let e = "";
                    const n = Math.max(2, Math.min(240, Math.round((b - a) * 2)));
                    for (let i = 0; i <= n; i++) {
                        const f = a + ((b - a) * i) / n;
                        const v = S.componentOf(S.valueAt(item, ch.prop, f), ch.axis);
                        e += (e === "" ? "M " : "L ") + g.X(f).toFixed(2) + " " + g.Y(v).toFixed(2) + " ";
                    }
                    line({ tag: "path", d: e, fill: "none", "stroke-width": 1.5, stroke: ch.color,
                           "stroke-dasharray": "5 3", opacity: 0.6, class: `curves-infinity ${side}` });
                }
            }
        }

        const playhead = g.X(Math.round(this.currentFrame || 0));
        line({ x1: playhead, y1: 0, x2: playhead, y2: 100, stroke: "#fff", opacity: 0.6 });

        this._previzLayoutCurveDots(g);
    },

    _previzLayoutCurveDots(g) {
        const wrap = this._previzCurveWrap;
        if (!wrap) return;
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        const doc = wrap.ownerDocument;
        const sel = this._previzCurveKey;

        for (const ch of g.lines) {
            const item = ch.item;
            for (const k of S.track(item, ch.prop)) {
                const v = S.componentOf(k.v, ch.axis);
                const dot = doc.createElement("div");
                const chosen = !!sel && sel.id === item.id && sel.prop === ch.prop && sel.f === k.f;
                dot.className = "kf-dot" + (chosen ? " chosen" : "");
                dot.style.left = g.X(k.f) + "%";
                dot.style.top = g.Y(v) + "%";
                dot.style.background = ch.color;
                dot.title = `${ch.label} · frame ${k.f} = ${Math.round(v * 1000) / 1000}\n` +
                            "drag sideways to retime, up/down to change · click for tangents · double-click to delete";
                dot.onmousedown = (e) => this._previzCurveDotDown(e, item, ch, k.f, g);
                dot.dataset.item = item.id;
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

            const x2 = g.X(hx), y2 = g.Y(hy);
            tangentArm(wrap, g.X(key.f), g.Y(v), x2, y2, ch.color);

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
        this._previzCurveKey = { id: item.id, prop: ch.prop, f: frame };
        const wrap = this._previzCurveWrap;
        const win = this._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        let current = frame;
        let moved = false;
        this.previzBeginDrag("move key");

        const onMove = (evt) => {
            moved = true;
            const g = this._previzCurveGeom(geom.lines);
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
                this._previzCurveKey = { id: item.id, prop: ch.prop, f: current };
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
            const g = this._previzCurveGeom(geom.lines);
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
