// imageViewer_previzCurvesInstance.js
// One Curve Editor for the 3D scene's animation: the selected items' keys drawn as value over time.
// The panel comes in instances (Sebastian 2026-11-23): the first one is the markup in imageViewer.html
// and keeps its state on the viewer (st === viewer, so this._previzCurveView / _previzCurveSel and every
// older caller still read and write it); every further one ("curves@2", ...) is made here with a state
// object of its own. The dock registers the maker (PrevizCurvesMixin._pcRegisterMaker) and places the element.
//
// What is shared and what is not: the scene's tracks and the item selection belong to the tab, so two
// editors draw the same scene. The viewport (pan/zoom), the shown channels, the list width and the KEY
// selection are each editor's own: the draw prunes the selection to the keys on ITS screen, so a shared
// selection would have two editors showing different channels undo each other's picks on every refresh.
// Edits (drag, Del, tangents, the tools) go to the shared tracks either way.
import * as S from "./imageViewer_scene3d.js";
import { eulerFilter as eulerFilterKeys } from "./imageViewer_eulerFilter.js";
import { notice } from "./imageViewer_exportUI.js";
import { buildCurvePanel, svgLine, tangentArm } from "./imageViewer_curveUI.js";
import * as A from "./imageViewer_animTools.js";

const INFINITY_LABELS = [["constant", "Constant"], ["linear", "Linear"], ["cycle", "Cycle"],
                         ["offset", "Cycle with offset"], ["oscillate", "Oscillate"]];

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

/**
 * Make a Curve Editor in `host`. `st` holds everything this editor keeps of its own (the viewer itself
 * for the first one, a fresh object for every further one); `saved` is what a layout carried for it.
 * Returns the instance the dock keeps: { el, ui, refresh, keyDown, wake, save, dispose, ... }.
 */
export function createCurvesInstance(v, host, st, saved) {
    if (saved) {
        const view = saved.view;
        if (view && [view.f0, view.f1, view.v0, view.v1].every(Number.isFinite)) {
            st._previzCurveView = { key: String(view.key || ""), f0: view.f0, f1: view.f1, v0: view.v0, v1: view.v1 };
        }
        if (Array.isArray(saved.shown)) st._previzCurveShown = new Set(saved.shown.map(String));
        if (Number.isFinite(saved.listW) && saved.listW > 0) st._previzCurveListW = saved.listW;
    }

    // The skeleton is shared with the Roto Curves (imageViewer_curveUI.js).
    const ui = buildCurvePanel(host, {
        listWidth: st._previzCurveListW || 120,
        onListWidth: (w) => { st._previzCurveListW = w; },
        onResized: () => refresh(),
        // A click on the graph itself, clear of any key, drops the selection — and with it the handles.
        // A drag there draws a box that selects the keys inside it.
        onBlank: (e) => blankDown(e),
        hint: "Click a key, Shift+click to add or take one away, Ctrl+click to take one away, or drag a box " +
              "on the empty graph. Drag a selected key to move them all - sideways retimes, up and down " +
              "changes the values (Shift holds one direction). Drag a handle to shape every selected " +
              "key's tangent, Alt to break it, double-click it for the ease again. Del removes the selected keys. " +
              "Wheel zooms (Shift: time only, Ctrl: values only), middle or Alt+drag pans, F fits.",
    });
    // Zoom and pan: taken in the capture phase, before a key or the box sees the press.
    ui.wrap.addEventListener("mousedown", (e) => navDown(e), true);
    ui.wrap.addEventListener("wheel", (e) => wheelZoom(e), { passive: false });
    ui.wrap.addEventListener("contextmenu", (e) => { if (e.altKey) e.preventDefault(); });
    // Focusable, so Del / Ctrl+A / Esc / F reach keyDown.
    ui.body.tabIndex = -1;
    ui.body.addEventListener("mousedown", () => { try { ui.body.focus({ preventScroll: true }); } catch (_) {} }, true);
    st._previzCurveWrap = ui.wrap;
    st._previzCurveSvg = ui.svg;
    st._previzCurveUI = ui;
    toolbar(ui);

    // A drag's window listeners, so dispose can let go of one still in flight.
    const offDrag = new Set();
    function drag(win, move, up) {
        const off = () => {
            win.removeEventListener("mousemove", move);
            win.removeEventListener("mouseup", up);
            offDrag.delete(off);
        };
        offDrag.add(off);
        win.addEventListener("mousemove", move);
        win.addEventListener("mouseup", up);
        return off;
    }

    /** One line of the graph: an object, a channel, and the colour it wears. */
    function curveLines() {
        const items = v._previzCurveItems();
        const picked = st._previzCurveShown;
        const out = [];
        items.forEach((item, index) => {
            const usable = v._previzChannelsFor(item);
            const chosen = picked && picked.size
                ? usable.filter((c) => picked.has(`${item.id}|${c.key}`))
                : usable.filter((c) => S.isAnimated(item, c.prop));
            for (const ch of chosen) {
                out.push({ ...ch, item, index, color: shade(ch.color, index),
                           label: items.length > 1 ? `${item.name}.${ch.label}` : ch.label });
            }
        });
        return out;
    }

    /**
     * Draw what the selection has to show.
     *
     * An item without keys still keeps the panel: a graph that vanished whenever you clicked something
     * else was the old strip's behaviour, and it made the panel feel broken.
     */
    function refresh() {
        const items = v._previzCurveItems();
        const lines = curveLines();
        ui.body.style.display = items.length ? "flex" : "none";
        ui.empty.style.display = items.length ? "none" : "block";
        ui.empty.textContent = "Select something in the scene to see its animation.";
        if (!items.length) return;

        syncChannelList(items, lines);
        const anyKeys = items.some((it) => S.keyframeFrames(it).length > 0);
        const what = items.length === 1 ? items[0].name : `${items.length} objects`;
        ui.sub.textContent = anyKeys
            ? `${what} · ${lines.length} channel${lines.length === 1 ? "" : "s"}`
            : `${what} · no keyframes yet`;
        drawCurves(lines);
    }

    // ── Tools: buffer curves, simplify, infinity, retime, Euler ─────────────

    /** The bar over the graph. Every tool works on the curves on screen. */
    function toolbar(ui) {
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
            v._previzOpenMenu(entries, r.left, r.bottom + 2, b);
        };
        ui.bufferBtn = btn("Buffer", "Keep a copy of the curves on screen (drawn grey behind them)",
            () => bufferSnap());
        ui.swapBtn = btn("Swap", "Trade the curves with the buffer copy - press again to trade back",
            () => bufferSwap());
        btn("Simplify\u2026", "Fewer keys for the same curve: drops what the curve does not need",
            (b) => v._dsAskNumber(b, "Keep within (% of each channel's range)", st._previzSimplifyTol ?? 1,
                (val) => { st._previzSimplifyTol = val; simplify(val / 100); }, { step: 0.1, min: 0.01 }));
        for (const [side, label] of [["pre", "Pre \u221e"], ["post", "Post \u221e"]]) {
            btn(`${label} \u25be`, side === "pre" ? "What the curves do before their first key"
                                                : "What the curves do after their last key",
                (b) => menuAt(b, INFINITY_LABELS.map(([mode, name]) => ({
                    label: name, run: () => infinity(side, mode) }))));
        }
        btn("Retime\u2026", "Spread or squeeze the keys between two frames; what comes after moves along",
            (b) => {
                const shown = trackList();
                const fr = shown.flatMap(({ id, prop }) => S.track(S.itemById(v.previzScene(), id), prop).map((k) => k.f));
                const lo = fr.length ? Math.min(...fr) : 0, hi = fr.length ? Math.max(...fr) : 24;
                v._dsAskFields(b, [
                    { name: "from", label: "From frame", value: lo },
                    { name: "to", label: "To frame", value: hi },
                    { name: "newTo", label: "Ends on frame", value: hi },
                    { name: "ripple", label: "Move later keys too", type: "checkbox", value: true },
                ], (val) => retime(val.from, val.to, val.newTo, val.ripple));
            });
        btn("Euler", EULER_TIP, () => eulerFilter());
        ui.fitBtn = btn("Fit", "Show the whole timeline and every curve again (F). Wheel zooms, " +
            "middle or Alt+drag pans, Alt+right drag zooms", () => fit());
        btn("Tangents \u25be", "Give every selected key this tangent",
            (b) => menuAt(b, [["smooth", "Smooth"], ["linear", "Linear"], ["hold", "Stepped"], ["flat", "Flat"]]
                .map(([mode, name]) => ({ label: name, run: () => setTangents(mode) }))));
        ui.sub.parentNode.insertBefore(bar, ui.sub);
        ui.tools = bar;
    }

    /** The tracks behind the curves on screen: one {id, prop} each. */
    function trackList() {
        const seen = new Set(), out = [];
        for (const l of curveLines()) {
            const k = `${l.item.id}|${l.prop}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ id: l.item.id, prop: l.prop });
        }
        return out;
    }

    function needTracks(what) {
        const tracks = trackList().filter(({ id, prop }) =>
            S.track(S.itemById(v.previzScene(), id), prop).length);
        if (!tracks.length) notice("info", what, "Show an animated channel in the Curve Editor first.");
        return tracks;
    }

    function bufferSnap() {
        const tracks = needTracks("Buffer curve");
        if (!tracks.length) return 0;
        st._previzCurveBuffer = A.snapshotTracks(v.previzScene().items, tracks);
        refresh();
        notice("info", "Buffer curve", `Kept ${tracks.length} curve${tracks.length === 1 ? "" : "s"}.`);
        return tracks.length;
    }

    function bufferSwap() {
        const buf = st._previzCurveBuffer;
        if (!buf || !buf.size) { notice("info", "Swap with buffer", "Press Buffer first to keep a copy."); return 0; }
        v.previzSnapshot("swap buffer curves");
        const { buffer, swapped } = A.swapTracks(v.previzScene().items, buf);
        st._previzCurveBuffer = buffer;
        v.previzChanged();
        return swapped;
    }

    function simplify(tolerance = 0.01) {
        const tracks = needTracks("Simplify");
        if (!tracks.length) return null;
        const scene = v.previzScene();
        v.previzSnapshot("simplify curves");
        let before = 0, after = 0, skipped = 0;
        for (const { id, prop } of tracks) {
            const r = A.simplifyTrack(S.itemById(scene, id), prop, tolerance);
            before += r.before; after += r.after; if (r.skipped) skipped++;
        }
        setSel([]);
        v.previzChanged();
        notice("success", "Simplify", `${before} keys \u2192 ${after}` +
               (skipped ? ` (${skipped} stepped curve${skipped === 1 ? "" : "s"} left as they were)` : "") + ".");
        return { before, after, skipped };
    }

    function infinity(side, mode) {
        const tracks = needTracks("Infinity");
        if (!tracks.length) return 0;
        const scene = v.previzScene();
        v.previzSnapshot(`${side === "pre" ? "pre" : "post"}-infinity ${mode}`);
        for (const { id, prop } of tracks) S.setInfinity(S.itemById(scene, id), prop, { [side]: mode });
        v.previzChanged();
        return tracks.length;
    }

    function retime(from, to, newTo, ripple = true) {
        const tracks = needTracks("Retime");
        if (!tracks.length) return 0;
        if (!(Number(to) > Number(from)) || !(Number(newTo) > Number(from))) {
            notice("info", "Retime", "The range has to end after it starts.");
            return 0;
        }
        v.previzSnapshot("retime keys");
        const n = A.retimeKeys(v.previzScene().items, tracks, Number(from), Number(to), Number(newTo), !!ripple);
        setSel([]);
        v.previzChanged();
        return n;
    }

    /**
     * Euler filter on the rotation tracks of the selected objects - or, when
     * this editor has been told which channels to show, only the objects that
     * have a rotate channel on screen. One undo step.
     */
    function eulerFilter() {
        const items = v._previzCurveItems();
        const picked = st._previzCurveShown;
        const targets = items.filter((it) => S.track(it, "rotation").length > 1
            && (!picked || !picked.size || [0, 1, 2].some((a) => picked.has(`${it.id}|rotation.${a}`))));
        if (!targets.length) {
            notice("info", "Euler filter", "Select an object with at least two rotation keys.");
            return 0;
        }
        const results = targets.map((it) => ({ it, r: eulerFilterKeys(S.track(it, "rotation")) }));
        const total = results.reduce((n, x) => n + x.r.changed, 0);
        if (!total) {
            notice("info", "Euler filter", "No flips found - 0 keys changed.");
            return 0;
        }
        v.previzSnapshot("Euler filter");
        for (const { it, r } of results) S.setTrack(it, "rotation", r.keys);
        v.previzChanged();
        notice("success", "Euler filter", `${total} key${total === 1 ? "" : "s"} changed on ` +
               `${targets.length} object${targets.length === 1 ? "" : "s"}.`);
        return total;
    }

    /**
     * Shift+click in the list: every channel row from the one clicked last to
     * this one is shown (the rest hidden), as a list's range select.
     */
    function rangeChannels(id) {
        const rows = [...ui.list.querySelectorAll(".curves-ch")].map((r) => r.dataset.ch);
        const a = rows.indexOf(st._previzCurveAnchor), b = rows.indexOf(id);
        if (a < 0 || b < 0) { toggleChannel(id, false); return; }
        st._previzCurveShown = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
        refresh();
    }

    /** Show or hide one channel of one object. Plain click picks it alone, Ctrl+click adds / takes away. */
    function toggleChannel(id, add) {
        st._previzCurveAnchor = id;
        let shown = st._previzCurveShown;
        if (!shown || !shown.size) {
            // The first click starts from what is on screen, so nothing jumps.
            shown = new Set(curveLines().map((l) => `${l.item.id}|${l.key}`));
        }
        if (add) {
            if (shown.has(id)) shown.delete(id); else shown.add(id);
        } else {
            shown = new Set([id]);
        }
        st._previzCurveShown = shown;
        refresh();
    }

    /**
     * The list: each object's name, then its channels under it.
     *
     * Rebuilt rather than hidden and shown, because which objects are in it
     * changes with the selection — and it is a couple of dozen small rows.
     */
    function syncChannelList(items, lines) {
        const doc = ui.list.ownerDocument;
        const on = new Set(lines.map((l) => `${l.item.id}|${l.key}`));
        const folded = st._previzCurveFolded || (st._previzCurveFolded = new Set());
        ui.list.innerHTML = "";
        items.forEach((item, index) => {
            if (items.length > 1) {
                const head = doc.createElement("button");
                head.className = "curves-obj" + (folded.has(item.id) ? " folded" : "");
                head.textContent = `${folded.has(item.id) ? "\u25b8" : "\u25be"} ${item.name}`;
                head.title = "Fold this object's channels away";
                head.onclick = () => {
                    if (folded.has(item.id)) folded.delete(item.id); else folded.add(item.id);
                    refresh();
                };
                ui.list.append(head);
                if (folded.has(item.id)) return;
            }
            for (const ch of v._previzChannelsFor(item)) {
                const id = `${item.id}|${ch.key}`;
                const row = doc.createElement("button");
                row.className = "curves-ch";
                row.textContent = ch.label;
                row.style.setProperty("--ch", shade(ch.color, index));
                row.title = `Show or hide ${item.name}.${ch.label}`;
                row.classList.toggle("on", on.has(id));
                row.classList.toggle("animated", S.isAnimated(item, ch.prop));
                if (items.length > 1) row.classList.add("nested");
                row.dataset.ch = id;
                row.onclick = (e) => {
                    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) rangeChannels(id);
                    else toggleChannel(id, e.ctrlKey || e.metaKey);
                };
                ui.list.append(row);
            }
        });
    }

    // ── Geometry ─────────────────────────────────────────────────────────────

    /** Frames → x%, values → y%, across every channel on screen. */
    function geom(lines) {
        const bounds = v.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);

        let lo = Infinity, hi = -Infinity;
        const see = (val) => { if (val < lo) lo = val; if (val > hi) hi = val; };
        for (const ch of lines) {
            const item = ch.item;
            const keys = S.track(item, ch.prop);
            if (!keys.length) { see(S.componentOf(S.editValueAt(item, ch.prop, bounds.min), ch.axis)); continue; }
            // A curve that goes on past its keys is drawn to the ends of the shot.
            const inf = S.infinityOf(item, ch.prop);
            if (keys.length > 1 && (inf.pre !== "constant" || inf.post !== "constant")) {
                for (let n = 0; n <= 48; n++) {
                    see(S.componentOf(S.editValueAt(item, ch.prop, bounds.min + (span * n) / 48), ch.axis));
                }
            }
            for (const k of keys) see(S.componentOf(k.v, ch.axis));
            // A curve with handles can leave the band its keys sit in, so the
            // drawn shape is sampled rather than guessed at.
            for (let i = 0; i < keys.length - 1; i++) {
                for (let n = 1; n < 8; n++) {
                    const f = keys[i].f + ((keys[i + 1].f - keys[i].f) * n) / 8;
                    see(S.componentOf(S.editValueAt(item, ch.prop, f), ch.axis));
                }
            }
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }       // a flat channel still needs a band
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;

        // Zoomed or panned: the view the user made, in place of the fit.
        const timeline = bounds;
        const view = viewFor(lines);
        let view0 = bounds, vspan = span;
        if (view) {
            view0 = { min: view.f0, max: view.f1 };
            vspan = view.f1 - view.f0;
            lo = view.v0; hi = view.v1;
        }
        const X = (f) => ((f - view0.min) / vspan) * 100;
        const Y = (val) => GRAPH.bottom - ((val - lo) / (hi - lo)) * (GRAPH.bottom - GRAPH.top);
        const frameAt = (xPct) => Math.round(view0.min + (xPct / 100) * vspan);
        const valueAt = (yPct) => lo + ((GRAPH.bottom - yPct) / (GRAPH.bottom - GRAPH.top)) * (hi - lo);
        return { bounds: view0, timeline, span: vspan, lo, hi, X, Y, frameAt, valueAt, lines, zoomed: !!view };
    }

    // ── Zoom and pan ─────────────────────────────────────────────────────────
    //
    // `_previzCurveView` = {key, f0, f1, v0, v1}: the frames and values the
    // graph spans once zoomed or panned; null (or made for other objects) is
    // the fit - the timeline's range across, every curve's band up and down.
    // Wheel zooms about the pointer (Shift: time only, Ctrl: values only);
    // the middle button or Alt + left drag pans; Alt + right drag zooms
    // (sideways time, up and down values); F or Fit goes back to the fit.

    function viewKey(lines) {
        return [...new Set((lines || []).map((l) => l.item.id))].join("|");
    }

    function viewFor(lines) {
        const view = st._previzCurveView;
        if (!view || view.key !== viewKey(lines)) return null;
        return view;
    }

    /** The view as it stands now, as numbers that can be changed. */
    function viewNow() {
        const lines = curveLines();
        const g = geom(lines);
        return { key: viewKey(lines), f0: g.bounds.min, f1: g.bounds.max, v0: g.lo, v1: g.hi };
    }

    function setView(view) {
        const MIN_F = 2, MIN_V = 1e-6;
        if (view) {
            if (view.f1 - view.f0 < MIN_F) { const m = (view.f0 + view.f1) / 2; view.f0 = m - MIN_F / 2; view.f1 = m + MIN_F / 2; }
            if (view.v1 - view.v0 < MIN_V) { const m = (view.v0 + view.v1) / 2; view.v0 = m - MIN_V / 2; view.v1 = m + MIN_V / 2; }
        }
        st._previzCurveView = view;
        refresh();
    }

    /** Back to the fit: the timeline's range, every curve's values. */
    function fit() { setView(null); }

    /**
     * Zoom by `kx` in time and `ky` in value (below 1 zooms in) about a point
     * given as shares of the graph (0..1 from the left, 0..1 from the top).
     */
    function zoom(kx, ky, ax = 0.5, ay = 0.5) {
        const now = viewNow();
        const fa = now.f0 + ax * (now.f1 - now.f0);
        const vy = (GRAPH.bottom - ay * 100) / (GRAPH.bottom - GRAPH.top);
        const va = now.v0 + vy * (now.v1 - now.v0);
        setView({ key: now.key,
            f0: fa - (fa - now.f0) * kx, f1: fa + (now.f1 - fa) * kx,
            v0: va - (va - now.v0) * ky, v1: va + (now.v1 - va) * ky });
    }

    /** Pan by `df` frames and `dv` values. */
    function pan(df, dv) {
        const now = viewNow();
        setView({ key: now.key, f0: now.f0 + df, f1: now.f1 + df, v0: now.v0 + dv, v1: now.v1 + dv });
    }

    function wheelZoom(e) {
        e.preventDefault();
        e.stopPropagation();
        const r = ui.wrap.getBoundingClientRect();
        const ax = (e.clientX - r.left) / (r.width || 1), ay = (e.clientY - r.top) / (r.height || 1);
        const d = e.deltaY || e.deltaX;
        const k = Math.exp(Math.max(-0.5, Math.min(0.5, d * 0.0015)));
        const ctrl = e.ctrlKey || e.metaKey;
        zoom(ctrl ? 1 : k, e.shiftKey ? 1 : k, ax, ay);
    }

    /** Middle / Alt+left drag pans, Alt+right drag zooms. Taken before the keys and the box see the press. */
    function navDown(e) {
        const panning = e.button === 1 || (e.button === 0 && e.altKey && !e.target.closest(".kf-tan"));
        const zooming = e.button === 2 && e.altKey;
        if (!panning && !zooming) return;
        e.preventDefault();
        e.stopPropagation();
        const wrap = ui.wrap;
        const win = v._viewerWindow();
        const r = wrap.getBoundingClientRect();
        const start = viewNow();
        const fpp = (start.f1 - start.f0) / (r.width || 1);
        const vpp = (start.v1 - start.v0) / (((GRAPH.bottom - GRAPH.top) / 100) * (r.height || 1));
        const ax = (e.clientX - r.left) / (r.width || 1), ay = (e.clientY - r.top) / (r.height || 1);
        const fa = start.f0 + ax * (start.f1 - start.f0);
        const va = start.v0 + ((GRAPH.bottom - ay * 100) / (GRAPH.bottom - GRAPH.top)) * (start.v1 - start.v0);
        wrap.classList.add(panning ? "panning" : "zooming");
        const onMove = (evt) => {
            const dx = evt.clientX - e.clientX, dy = evt.clientY - e.clientY;
            if (panning) {
                setView({ key: start.key, f0: start.f0 - dx * fpp, f1: start.f1 - dx * fpp,
                          v0: start.v0 + dy * vpp, v1: start.v1 + dy * vpp });
            } else {
                const kx = Math.exp(-dx * 0.005), ky = Math.exp(dy * 0.005);
                setView({ key: start.key,
                    f0: fa - (fa - start.f0) * kx, f1: fa + (start.f1 - fa) * kx,
                    v0: va - (va - start.v0) * ky, v1: va + (start.v1 - va) * ky });
            }
        };
        const off = drag(win, onMove, onUp);
        function onUp() {
            off();
            wrap.classList.remove("panning", "zooming");
        }
    }

    /** Frame and value numbers along the graph's bottom and left edges. */
    function ticks(g) {
        const wrap = ui.wrap;
        wrap.querySelectorAll(".curves-tick").forEach((n) => n.remove());
        const doc = wrap.ownerDocument;
        const r = wrap.getBoundingClientRect();
        const step = (span, px, want) => {
            const raw = span / Math.max(1, px / want);
            const p = Math.pow(10, Math.floor(Math.log10(raw)));
            for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
            return 10 * p;
        };
        const fs = Math.max(1, step(g.span, r.width || 400, 70));
        for (let f = Math.ceil(g.bounds.min / fs) * fs; f <= g.bounds.max; f += fs) {
            const t = doc.createElement("div");
            t.className = "curves-tick frame";
            t.style.left = g.X(f) + "%";
            t.textContent = String(Math.round(f));
            wrap.append(t);
        }
        const vs = step(g.hi - g.lo, ((GRAPH.bottom - GRAPH.top) / 100) * (r.height || 100), 28);
        const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(vs))));
        for (let val = Math.ceil(g.lo / vs) * vs; val <= g.hi; val += vs) {
            const y = g.Y(val);
            if (y < 4 || y > 96) continue;
            const t = doc.createElement("div");
            t.className = "curves-tick value";
            t.style.top = y + "%";
            t.textContent = (Math.abs(val) < vs / 2 ? 0 : val).toFixed(digits);
            wrap.append(t);
        }
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    function drawCurves(lines) {
        const svg = ui.svg;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const g = geom(lines);
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
        const buf = st._previzCurveBuffer;
        if (buf && buf.size) {
            for (const ch of g.lines) {
                const keys = buf.get(`${ch.item.id}|${ch.prop}`);
                if (!keys || !keys.length) continue;
                let d = "";
                for (let i = 0; i <= 160; i++) {
                    const f = g.bounds.min + (g.span * i) / 160;
                    const val = S.componentOf(A.bufferValueAt(ch.item, ch.prop, keys, f), ch.axis);
                    d += (d === "" ? "M " : "L ") + g.X(f).toFixed(2) + " " + g.Y(val).toFixed(2) + " ";
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
                const val = S.componentOf(S.editValueAt(item, ch.prop, g.bounds.min), ch.axis);
                d = `M 0 ${g.Y(val).toFixed(2)} L 100 ${g.Y(val).toFixed(2)}`;
            } else {
                const first = keys[0].f, last = keys[keys.length - 1].f;
                const steps = Math.max(2, Math.min(240, Math.round((last - first) * 2) || 2));
                for (let i = 0; i <= steps; i++) {
                    const f = first + ((last - first) * i) / steps;
                    const val = S.componentOf(S.editValueAt(item, ch.prop, f), ch.axis);
                    d += (d === "" ? "M " : "L ") + g.X(f).toFixed(2) + " " + g.Y(val).toFixed(2) + " ";
                }
            }
            line({ tag: "path", d, fill: "none", "stroke-width": 2, stroke: ch.color,
                   opacity: keys.length ? 1 : 0.5 });
            // Before the first key and after the last: what the infinity makes of it, dashed.
            // Infinity is the base layer's (an animation layer's curve holds its ends).
            if (keys.length > 1 && !S.editLayer(item)) {
                const inf = S.infinityOf(item, ch.prop);
                for (const [side, a, b] of [["pre", g.bounds.min, keys[0].f],
                                            ["post", keys[keys.length - 1].f, g.bounds.max]]) {
                    if (inf[side] === "constant" || b <= a) continue;
                    let e = "";
                    const n = Math.max(2, Math.min(240, Math.round((b - a) * 2)));
                    for (let i = 0; i <= n; i++) {
                        const f = a + ((b - a) * i) / n;
                        const val = S.componentOf(S.valueAt(item, ch.prop, f), ch.axis);
                        e += (e === "" ? "M " : "L ") + g.X(f).toFixed(2) + " " + g.Y(val).toFixed(2) + " ";
                    }
                    line({ tag: "path", d: e, fill: "none", "stroke-width": 1.5, stroke: ch.color,
                           "stroke-dasharray": "5 3", opacity: 0.6, class: `curves-infinity ${side}` });
                }
            }
        }

        const playhead = g.X(Math.round(v.currentFrame || 0));
        line({ x1: playhead, y1: 0, x2: playhead, y2: 100, stroke: "#fff", opacity: 0.6 });
        ticks(g);
        if (ui.fitBtn) ui.fitBtn.classList.toggle("on", !!g.zoomed);

        layoutDots(g);
    }

    function layoutDots(g) {
        const wrap = ui.wrap;
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        const doc = wrap.ownerDocument;
        const drawn = [];

        for (const ch of g.lines) {
            const item = ch.item;
            for (const k of S.track(item, ch.prop)) {
                const val = S.componentOf(k.v, ch.axis);
                const dot = doc.createElement("div");
                const me = { id: item.id, prop: ch.prop, axis: ch.axis, f: k.f };
                const chosen = isSel(me);
                if (chosen) drawn.push(me);
                dot.className = "kf-dot" + (chosen ? " chosen" : "");
                dot.style.left = g.X(k.f) + "%";
                dot.style.top = g.Y(val) + "%";
                dot.style.background = ch.color;
                dot.title = `${ch.label} · frame ${k.f} = ${Math.round(val * 1000) / 1000}\n` +
                            "drag to move every selected key · Shift+click adds / takes away · " +
                            "click for tangents · double-click to delete";
                dot.onmousedown = (e) => dotDown(e, item, ch, k.f, g);
                dot.dataset.item = item.id;
                dot.dataset.prop = ch.prop;
                dot.dataset.axis = String(ch.axis);
                dot.dataset.f = String(k.f);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    v.previzSnapshot("delete key");
                    S.removeKeyframe(item, k.f, ch.prop);
                    setSel(selList().filter((s) => !(s.id === item.id && s.prop === ch.prop && s.f === k.f)));
                    v.previzChanged();
                };
                wrap.append(dot);

                if (chosen) layoutTangents(item, ch, k, g);
            }
        }
        // What is selected but no longer on screen (another object picked, a
        // channel hidden, a key deleted) is let go: a drag moves only what you see.
        if (!st._previzCurveDragging) setSel(drawn, { keepPrimary: true });
    }

    // ── Selection ────────────────────────────────────────────────────────────
    //
    // A selected key is one DOT: an object, a property, an axis and a frame.
    // Retiming moves the whole key (one key holds all three axes of a
    // property); a value or a tangent changes only the axis that was picked.

    function selList() {
        return Array.isArray(st._previzCurveSel) ? st._previzCurveSel : [];
    }

    function selId(s) { return `${s.id}|${s.prop}|${s.axis}|${s.f}`; }

    function isSel(s) {
        const id = selId(s);
        return selList().some((x) => selId(x) === id);
    }

    /** Replace the selection; the last one is the key the handles were asked for. */
    function setSel(list, { keepPrimary = false } = {}) {
        const seen = new Set(), out = [];
        for (const s of list || []) {
            const id = selId(s);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id: s.id, prop: s.prop, axis: s.axis, f: s.f });
        }
        st._previzCurveSel = out;
        const p = st._previzCurveKey;
        if (keepPrimary && p && out.some((s) => selId(s) === selId(p))) return;
        st._previzCurveKey = out.length ? out[out.length - 1] : null;
    }

    /** The 3D view's modifiers: plain replaces, Shift toggles, Ctrl removes, Ctrl+Shift adds. */
    function mode(e) {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.shiftKey) return "add";
        if (ctrl) return "remove";
        if (e.shiftKey) return "toggle";
        return "replace";
    }

    /** Put `hits` into the selection the way `mode` says. */
    function applySel(hits, m) {
        const cur = selList();
        const ids = new Set(hits.map((h) => selId(h)));
        if (m === "replace") return setSel(hits);
        if (m === "remove") return setSel(cur.filter((s) => !ids.has(selId(s))), { keepPrimary: true });
        if (m === "add") return setSel([...cur, ...hits]);
        // toggle
        const on = new Set(cur.map((s) => selId(s)));
        const kept = cur.filter((s) => !ids.has(selId(s)));
        const added = hits.filter((h) => !on.has(selId(h)));
        return setSel([...kept, ...added], { keepPrimary: !added.length });
    }

    /** The keys of every dot on screen - Ctrl+A. */
    function selectAll() {
        const all = [...ui.wrap.querySelectorAll(".kf-dot")].map((d) => dotSel(d));
        setSel(all);
        refresh();
        return all.length;
    }

    function dotSel(d) {
        return { id: d.dataset.item, prop: d.dataset.prop, axis: Number(d.dataset.axis), f: Number(d.dataset.f) };
    }

    /** The selected keys as the anim tools name them: one {id, prop, f} per key. */
    function selKeys() {
        const seen = new Set(), out = [];
        for (const s of selList()) {
            const k = `${s.id}|${s.prop}|${s.f}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ id: s.id, prop: s.prop, f: s.f });
        }
        return out;
    }

    /** Del: the selected keys go (the whole key: every axis of its property). One undo step. */
    function deleteSelected() {
        const keys = selKeys();
        if (!keys.length) return 0;
        v.previzSnapshot("delete keys");
        const n = A.deleteKeys(v.previzScene().items, keys);
        setSel([]);
        v.previzChanged();
        return n;
    }

    /**
     * Smooth / Linear / Stepped (the key's ease, its hand-set handles go) or
     * Flat (a level handle on the selected axis) on every selected key.
     */
    function setTangents(m) {
        const sel = selList();
        if (!sel.length) { notice("info", "Tangents", "Select keys in the Curve Editor first."); return 0; }
        const scene = v.previzScene();
        v.previzSnapshot(`${m} tangents`);
        let n = 0;
        if (m === "flat") {
            for (const s of sel) if (S.setTangent(S.itemById(scene, s.id), s.prop, s.f, s.axis, 0, { side: "out" })) n++;
        } else {
            n = A.setKeysEase(scene.items, selKeys(), m);
        }
        v.previzChanged();
        return n;
    }

    /** This editor's keys, while it has the focus. */
    function keyDown(e) {
        if (!ui.body.isConnected || !e.composedPath().includes(ui.body)) return false;
        const k = e.key, mod = e.ctrlKey || e.metaKey;
        let done = true;
        if ((k === "Delete" || k === "Backspace") && selList().length) deleteSelected();
        else if (mod && (k === "a" || k === "A")) selectAll();
        else if (k === "Escape" && selList().length) { setSel([]); refresh(); }
        else if (!mod && !e.altKey && (k === "f" || k === "F")) fit();
        else done = false;
        if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
        return done;
    }

    /**
     * A press on the graph away from any key: a click lets the selection go
     * (with no modifier), a drag draws a box and selects the keys inside it.
     */
    function blankDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        const wrap = ui.wrap;
        const win = v._viewerWindow();
        const doc = wrap.ownerDocument;
        const m = mode(e);
        const rect = wrap.getBoundingClientRect();
        const x0 = e.clientX, y0 = e.clientY;
        let box = null;
        const span = (evt) => ({
            l: Math.min(x0, evt.clientX), t: Math.min(y0, evt.clientY),
            r: Math.max(x0, evt.clientX), b: Math.max(y0, evt.clientY),
        });
        const onMove = (evt) => {
            if (!box && Math.hypot(evt.clientX - x0, evt.clientY - y0) < 3) return;
            if (!box) {
                box = doc.createElement("div");
                box.className = "curves-marquee";
                wrap.append(box);
            }
            const r = span(evt);
            box.style.left = `${r.l - rect.left}px`;
            box.style.top = `${r.t - rect.top}px`;
            box.style.width = `${r.r - r.l}px`;
            box.style.height = `${r.b - r.t}px`;
        };
        const off = drag(win, onMove, onUp);
        function onUp(evt) {
            off();
            if (!box) {
                if (m === "replace") setSel([]);
                refresh();
                return;
            }
            box.remove();
            const r = span(evt);
            const hits = [];
            for (const d of wrap.querySelectorAll(".kf-dot")) {
                const b = d.getBoundingClientRect();
                const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
                if (cx >= r.l && cx <= r.r && cy >= r.t && cy <= r.b) hits.push(dotSel(d));
            }
            applySel(hits, m);
            refresh();
        }
    }

    /** The two handles of the selected key, on this channel's curve. */
    function layoutTangents(item, ch, key, g) {
        const wrap = ui.wrap;
        const doc = wrap.ownerDocument;
        const reach = Math.max(1, g.span * HANDLE_SPAN);
        const val = S.componentOf(key.v, ch.axis);

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
            const hy = val + dir * reach * slope;

            const x2 = g.X(hx), y2 = g.Y(hy);
            tangentArm(wrap, g.X(key.f), g.Y(val), x2, y2, ch.color);

            const h = doc.createElement("div");
            h.className = "kf-tan";
            h.style.left = x2 + "%";
            h.style.top = y2 + "%";
            h.style.borderColor = ch.color;
            h.title = `${ch.label} · ${side === "in" ? "incoming" : "outgoing"} tangent ` +
                      `(${Math.round(slope * 1000) / 1000} per frame)\n` +
                      "drag to shape · Alt to break the pair · double-click for the key's ease again";
            h.onmousedown = (e) => tangentDown(e, item, ch, key, side, g);
            h.ondblclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                v.previzSnapshot("reset tangents");
                const scene = v.previzScene();
                for (const s of selKeys()) S.clearTangents(S.itemById(scene, s.id), s.prop, s.f);
                S.clearTangents(item, ch.prop, key.f);
                v.previzChanged();
            };
            wrap.append(h);
        }
    }

    // ── Dragging ─────────────────────────────────────────────────────────────

    /**
     * Press on a key: pick it the way the modifiers say, then drag every
     * selected key by the same frames and the same value.
     *
     * Each move starts again from the tracks as they were at the press, so a
     * drag that passes over other keys leaves them as they were. The graph's
     * scale is the press's too - it would otherwise rescale under the pointer
     * as the values move. Shift held while dragging keeps to the direction the
     * drag started in (time or value).
     */
    function dotDown(e, item, ch, frame, g) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const me = { id: item.id, prop: ch.prop, axis: ch.axis, f: frame };
        const m = mode(e);
        const was = isSel(me);
        if (m === "remove" || (m === "toggle" && was)) {
            applySel([me], m);
            refresh();
            return;
        }
        if (m === "toggle" || m === "add") applySel([me], "add");
        else if (!was) setSel([me]);
        st._previzCurveKey = me;          // the one whose handles were asked for
        refresh();

        const scene = v.previzScene();
        const sel = selList().slice();
        // Per track (object + property): its keys at the press, the frames that
        // move and, per frame, the axes whose value moves.
        const tracks = new Map();
        for (const s of sel) {
            const tk = `${s.id}|${s.prop}`;
            let t = tracks.get(tk);
            if (!t) {
                const it = S.itemById(scene, s.id);
                if (!it) continue;
                t = { item: it, prop: s.prop, orig: JSON.parse(JSON.stringify(S.track(it, s.prop))), axes: new Map() };
                tracks.set(tk, t);
            }
            if (!t.axes.has(s.f)) t.axes.set(s.f, new Set());
            t.axes.get(s.f).add(s.axis);
        }
        let minF = Infinity, maxF = -Infinity;
        for (const s of sel) { minF = Math.min(minF, s.f); maxF = Math.max(maxF, s.f); }

        const wrap = ui.wrap;
        const win = v._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        const perValue = (GRAPH.bottom - GRAPH.top) / 100 * rect.height / ((g.hi - g.lo) || 1);
        const dfMin = Math.min(0, g.timeline.min - minF), dfMax = Math.max(0, g.timeline.max - maxF);
        let moved = false, applied = 0, lock = null;
        st._previzCurveDragging = true;
        v.previzBeginDrag(sel.length > 1 ? "move keys" : "move key");

        const build = (df, dv) => {
            const out = [];
            for (const t of tracks.values()) {
                const still = new Set(t.orig.filter((k) => !t.axes.has(k.f)).map((k) => k.f));
                const list = [];
                for (const k of t.orig) {
                    const nk = JSON.parse(JSON.stringify(k));
                    const axes = t.axes.get(k.f);
                    if (axes) {
                        nk.f = k.f + df;
                        if (still.has(nk.f)) return null;      // would land on a key that stays
                        if (dv) {
                            if (Array.isArray(nk.v)) for (const a of axes) nk.v[a] = Number(nk.v[a]) + dv;
                            else nk.v = Number(nk.v) + dv;
                        }
                    }
                    list.push(nk);
                }
                out.push([t, list]);
            }
            return out;
        };

        const onMove = (evt) => {
            const dx = evt.clientX - e.clientX, dy = evt.clientY - e.clientY;
            if (!moved && Math.hypot(dx, dy) < 2) return;
            moved = true;
            if (evt.shiftKey) { if (!lock) lock = Math.abs(dx) >= Math.abs(dy) ? "time" : "value"; }
            else lock = null;
            let df = Math.round((dx / (rect.width || 1)) * g.span);
            df = Math.max(dfMin, Math.min(dfMax, df));
            let dv = -dy / (perValue || 1);
            if (lock === "time") dv = 0;
            if (lock === "value") df = 0;
            let next = build(df, dv);
            if (!next) { df = applied; next = build(df, dv); }   // keep the last frame that fitted
            if (!next) return;
            for (const [t, list] of next) S.setTrack(t.item, t.prop, list);
            applied = df;
            st._previzCurveSel = sel.map((s) => ({ ...s, f: s.f + df }));
            st._previzCurveKey = { ...me, f: me.f + df };
            v.previzChanged({ persist: false, light: true });
        };
        const off = drag(win, onMove, onUp);
        function onUp() {
            off();
            st._previzCurveDragging = false;
            v.previzEndDrag();
            // A plain click on one of several selected keys picks that one alone.
            if (!moved && m === "replace" && was && sel.length > 1) setSel([me]);
            if (!moved) v.previzSnapshot("select key");   // keeps undo honest
            v.previzChanged();          // one save at the end of the drag
        }
    }

    /**
     * Drag a tangent handle.
     *
     * The slope is read straight off the pointer: where it is, relative to the
     * key, IS the direction the curve leaves in. Dragging back past the key
     * would flip the handle to the other side, so the reach is clamped to stay
     * on its own side of the key.
     *
     * With several keys selected each of their handles on that side turns by
     * the same angle on screen as the one dragged (every curve shares the
     * graph's scale), so a row of keys keeps their differences.
     */
    function tangentDown(e, item, ch, key, side, g) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const wrap = ui.wrap;
        const win = v._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        const broken = e.altKey;
        // Screen pixels per value over pixels per frame: slope -> screen angle.
        const k = ((GRAPH.bottom - GRAPH.top) / 100 * rect.height / ((g.hi - g.lo) || 1))
                / ((rect.width || 1) / (g.span || 1));
        const angle = (slope) => Math.atan(slope * k);
        const scene = v.previzScene();
        const me = { id: item.id, prop: ch.prop, axis: ch.axis, f: key.f };
        const others = selList()
            .filter((s) => selId(s) !== selId(me))
            .map((s) => {
                const it = S.itemById(scene, s.id);
                return it ? { s, it, a0: angle(S.tangentAt(it, s.prop, s.f, s.axis, side)) } : null;
            })
            .filter(Boolean);
        const a0 = angle(S.tangentAt(item, ch.prop, key.f, ch.axis, side));
        const LIMIT = Math.PI / 2 - 0.01;
        st._previzCurveDragging = true;
        v.previzBeginDrag(broken ? "break tangent" : (others.length ? "shape tangents" : "shape tangent"));

        const onMove = (evt) => {
            const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
            const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
            const dir = side === "in" ? -1 : 1;
            const df = (g.bounds.min + (xPct / 100) * g.span) - key.f;
            const minReach = Math.max(0.5, g.span * 0.01);
            const reach = dir * Math.max(minReach, dir * df);
            const dv = g.valueAt(yPct) - S.componentOf(key.v, ch.axis);
            const slope = dv / reach;
            S.setTangent(item, ch.prop, key.f, ch.axis, slope, { side, broken });
            const turn = angle(slope) - a0;
            for (const o of others) {
                const a = Math.max(-LIMIT, Math.min(LIMIT, o.a0 + turn));
                S.setTangent(o.it, o.s.prop, o.s.f, o.s.axis, Math.tan(a) / k, { side, broken });
            }
            v.previzChanged({ persist: false, light: true });
        };
        const off = drag(win, onMove, onUp);
        function onUp() {
            off();
            st._previzCurveDragging = false;
            v.previzEndDrag();
            v.previzChanged();
        }
    }

    return {
        el: host,
        ui,
        refresh,
        keyDown,
        viewNow,
        fit,
        zoom,
        pan,
        selectAll,
        deleteSelected,
        setTangents,
        eulerFilter,
        bufferSnap,
        bufferSwap,
        simplify,
        infinity,
        retime,
        wake() { refresh(); },
        save() {
            const view = st._previzCurveView;
            return {
                view: view ? { key: view.key, f0: view.f0, f1: view.f1, v0: view.v0, v1: view.v1 } : null,
                shown: st._previzCurveShown ? [...st._previzCurveShown] : null,
                listW: st._previzCurveListW || null,
            };
        },
        dispose() {
            for (const off of [...offDrag]) off();
            st._previzCurveDragging = false;
        },
    };
}