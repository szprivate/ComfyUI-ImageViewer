// imageViewer_curvePanelsInstance.js
// One Roto Curves panel and one Parameter Curves panel, each as a closure with its own shown channels,
// key selection and list width. The panels come in instances (Sebastian 2026-11-23): the first of each
// keeps the plain id and its state on the viewer (st === viewer, so this._rotoCurveShown / _paramCurveShown
// and every older caller still read and write it); every further one ("rotoCurves@2", "paramCurves@2", ...)
// is made here with a state object of its own. The dock registers the makers (registerCurvePanelMakers)
// and places the element.
//
// What is shared and what is not: the roto tool's layers and the nodes' keyed tracks are the data, so two
// panels draw the same shapes / parameters and an edit in one shows in the other. The VIEW is each panel's
// own — which channels it shows, the key whose handles are up, the list width; a Parameter Curves instance
// can also pin itself to another node than the one the Parameters panel shows. The body is built from
// classes alone (buildCurvePanel), so an instance never repeats the markup's ids.
import { app } from "../../scripts/app.js";
import * as A from "./imageViewer_paramAnimData.js";
import { buildCurvePanel, svgLine, tangentArm } from "./imageViewer_curveUI.js";

const GRAPH = { top: 10, bottom: 90 };
const HANDLE_SPAN = 0.06;
const ROTO_PALETTE = ["#ff8a00", "#6bb6ff", "#8ce26b", "#ff6bd5", "#ffd24d", "#9d8cff", "#6be2c8", "#ff6b6b"];
const PARAM_PALETTE = ["#ff6b6b", "#8ce26b", "#6bb6ff", "#ffd24d", "#ff9d4d", "#c8e24d",
                       "#4dc8ff", "#ff6bd5", "#6be2c8", "#9d8cff"];

/**
 * The makers the dock calls for every further Roto Curves / Parameter Curves panel. Idempotent; called
 * from both mixins' facades. Startup comes through RotoCurvesMixin.rotoShowCurves (setActiveTool("none"))
 * before a restored layout is read, which is what lets a layout's instances survive the reload.
 */
export function registerCurvePanelMakers(v) {
    if (!v._dockMakers) return;
    const makers = v._dockMakers();
    if (!makers.rotoCurves) makers.rotoCurves = (vv, id, saved) => {
        const d = (vv._dockRootEl && vv._dockRootEl.ownerDocument)
            || (vv.rotoCurvesPanel && vv.rotoCurvesPanel.ownerDocument);
        const host = d.createElement("div");
        host.className = "curves-panel";
        // A new panel starts where the first one is (its channels and width), then walks on its own.
        const seed = saved || (vv._rotoCurveInst ? vv._rotoCurveInst.save() : null);
        return createRotoCurvesInstance(vv, host, {}, seed);
    };
    if (!makers.paramCurves) makers.paramCurves = (vv, id, saved) => {
        const d = (vv._dockRootEl && vv._dockRootEl.ownerDocument)
            || (vv.paramCurvesPanel && vv.paramCurvesPanel.ownerDocument);
        const host = d.createElement("div");
        host.className = "curves-panel";
        const seed = saved || (vv._paramCurveInst ? vv._paramCurveInst.save() : null);
        return createParamCurvesInstance(vv, host, {}, seed);
    };
}

/** A drag's window listeners, so dispose can let go of one still in flight. */
function makeDrag(offDrag) {
    return (win, move, up) => {
        const off = () => {
            win.removeEventListener("mousemove", move);
            win.removeEventListener("mouseup", up);
            offDrag.delete(off);
        };
        offDrag.add(off);
        win.addEventListener("mousemove", move);
        win.addEventListener("mouseup", up);
        return off;
    };
}

/**
 * Make a Roto Curves panel in `host`. `st` holds what this panel keeps of its own (the viewer itself for
 * the first one, a fresh object for every further one); `saved` is what a layout carried for it.
 * Returns the instance the dock keeps: { el, ui, refresh, wake, save, dispose }.
 */
export function createRotoCurvesInstance(v, host, st, saved) {
    if (saved) {
        if (Array.isArray(saved.shown)) st._rotoCurveShown = new Set(saved.shown);
        if (saved.key) st._rotoCurveKey = saved.key;
        if (Number.isFinite(saved.listW) && saved.listW > 0) st._rotoCurveListW = saved.listW;
    }

    const ui = buildCurvePanel(host, {
        listWidth: st._rotoCurveListW || 110,
        onListWidth: (w) => { st._rotoCurveListW = w; },
        onResized: () => refresh(),
        onBlank: () => { st._rotoCurveKey = null; refresh(); },
        hint: "Each step up is a key. Drag a key sideways to retime it; double-click removes it. " +
              "Click a key for its ease handles — farther out is more ease, height is speed; " +
              "double-click a handle for the default ease.",
    });
    st._rotoCurveUI = ui;
    st._rotoCurveListSig = null;

    const offDrag = new Set();
    const drag = makeDrag(offDrag);

    /** Redraw from the tool's layers; the first panel is only asked while the tool is on. */
    function refresh() {
        if (!v._rotoCurvesOn()) {
            ui.body.style.display = "none";
            ui.empty.style.display = "block";
            ui.empty.textContent = "Turn on the Roto tool on a node to edit its shapes' timing here.";
            return;
        }
        const layers = v._roto.layers;
        const lines = curveLines();
        ui.body.style.display = layers.length ? "flex" : "none";
        ui.empty.style.display = layers.length ? "none" : "block";
        ui.empty.textContent = "Add a shape (+ Shape in the Roto panel) to animate it here.";
        if (!layers.length) return;

        syncCurveList(lines);
        const layer = v._rotoCurLayer();
        const nKeys = layer ? v._rotoCurKeys(layer).length : 0;
        ui.sub.textContent = !layer ? "Pick a shape"
            : nKeys ? `${layer.name} · ${nKeys} key${nKeys === 1 ? "" : "s"}`
            : `${layer.name} · no keys yet — press + beside the timeline`;
        drawCurves(lines);
    }

    /** The curves on the graph: a shape, its keys and its colour. */
    function curveLines() {
        const shown = st._rotoCurveShown;
        const out = [];
        v._roto.layers.forEach((layer, index) => {
            const keys = v._rotoCurKeys(layer);
            const on = shown && shown.size ? shown.has(layer.id) : keys.length > 0;
            if (on) out.push({ layer, index, keys, color: ROTO_PALETTE[index % ROTO_PALETTE.length] });
        });
        return out;
    }

    /**
     * The list: one row per shape. Rebuilt only when what it says changes — the panel redraws on every
     * frame during playback, and the list doesn't move.
     */
    function syncCurveList(lines) {
        const on = new Set(lines.map((l) => l.layer.id));
        const layers = v._roto.layers;
        const sig = JSON.stringify([v._roto.selLayer, [...on],
            layers.map((l) => [l.id, l.name, v._rotoCurKeys(l).length])]);
        if (sig === st._rotoCurveListSig) return;
        st._rotoCurveListSig = sig;
        const doc = ui.list.ownerDocument;
        ui.list.innerHTML = "";
        layers.forEach((layer, index) => {
            const row = doc.createElement("button");
            row.className = "curves-ch";
            row.textContent = layer.name || `Shape ${index + 1}`;
            row.style.setProperty("--ch", ROTO_PALETTE[index % ROTO_PALETTE.length]);
            const n = v._rotoCurKeys(layer).length;
            row.title = `${layer.name} · ${n ? n + " key" + (n === 1 ? "" : "s") : "no keys"}\n` +
                        "click: show this shape alone and work on it · Shift-click: add to the graph";
            row.classList.toggle("on", on.has(layer.id));
            row.classList.toggle("animated", n > 0);
            row.classList.toggle("current", index === v._roto.selLayer);
            row.onclick = (e) => pickCurve(layer, index, e.shiftKey || e.ctrlKey || e.metaKey);
            ui.list.append(row);
        });
    }

    function pickCurve(layer, index, add) {
        let shown = st._rotoCurveShown;
        if (!shown || !shown.size) shown = new Set(curveLines().map((l) => l.layer.id));
        if (add) {
            if (shown.has(layer.id)) shown.delete(layer.id); else shown.add(layer.id);
        } else {
            shown = new Set([layer.id]);
            // The shape you look at is the shape you key: pick it in the tool too.
            if (v._roto.selLayer !== index) {
                v._roto.selLayer = index;
                v._roto.selPts = new Set();
                v._roto.drawing = null;
                v._rotoRefreshLayerList?.();
                v._rotoRefreshShapeControls?.();
                v._toolRedraw?.();
            }
        }
        st._rotoCurveShown = shown;
        st._rotoCurveKey = null;
        v._rotoRefreshKfInfo();
    }

    // ── Geometry ─────────────────────────────────────────────────────────────

    /**
     * Frames → x%, and for one shape: key k sits at height k/(K-1), and each segment's 0..1 ease progress
     * is mapped into the band between its two keys, so a key's in- and out-handles live in one continuous
     * curve.
     */
    function geom(line) {
        const b = v.getTimelineBounds ? v.getTimelineBounds() : { min: 0, max: 0 };
        const span = Math.max(1, b.max - b.min);
        const X = (f) => ((f - b.min) / span) * 100;
        const Yv = (val) => GRAPH.bottom - val * (GRAPH.bottom - GRAPH.top);
        const keys = line ? line.keys : [];
        const K = keys.length;
        const level = (k) => (K <= 1 ? 0.5 : k / (K - 1));
        const segs = [];
        for (let s = 0; s < K - 1; s++) {
            const lo = keys[s], hi = keys[s + 1];
            segs.push({ s, lo, hi, x0: X(lo), x1: X(hi), v0: level(s), v1: level(s + 1) });
        }
        return { min: b.min, max: b.max, span, X, Yv, level, keys, K, segs };
    }

    /** Where a handle sits: out of key `seg.lo`, or into key `seg.hi`. */
    function handlePos(layer, seg, side, g) {
        const t = v._rotoKeyTangent(layer, side === "out" ? seg.lo : seg.hi);
        const dx = seg.x1 - seg.x0, dv = seg.v1 - seg.v0;
        return side === "out"
            ? { x: seg.x0 + dx * t.ox, y: g.Yv(seg.v0 + dv * t.oy) }
            : { x: seg.x0 + dx * t.ix, y: g.Yv(seg.v0 + dv * t.iy) };
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    function drawCurves(lines) {
        const svg = ui.svg, wrap = ui.wrap;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        const g0 = geom(null);
        svgLine(svg, { x1: 0, y1: GRAPH.bottom, x2: 100, y2: GRAPH.bottom, stroke: "#333" });
        svgLine(svg, { x1: 0, y1: GRAPH.top, x2: 100, y2: GRAPH.top, stroke: "#262626" });

        const doc = wrap.ownerDocument;
        const sel = st._rotoCurveKey;
        for (const line of lines) {
            const { layer, keys, color } = line;
            const g = geom(line);
            for (const f of keys) {
                svgLine(svg, { x1: g.X(f), y1: GRAPH.top, x2: g.X(f), y2: GRAPH.bottom, stroke: color,
                               "stroke-dasharray": "2 2", opacity: 0.22 });
            }
            // The curve, sampled through the tool's own easing — so a dragged handle and a Hold key look
            // here exactly as they play.
            if (g.K >= 2) {
                let d = "";
                for (const seg of g.segs) {
                    const steps = Math.max(8, Math.min(60, (seg.hi - seg.lo) * 2));
                    for (let i = 0; i <= steps; i++) {
                        const xf = i / steps;
                        const p = v._rotoSegEase(layer, seg.lo, seg.hi, xf);
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
                const hold = v._rotoKeyTangent(layer, f).hold;
                dot.title = `${layer.name} · key at frame ${f}${hold ? " (hold)" : ""}\n` +
                            "drag sideways to retime · click for ease handles · double-click to delete";
                dot.onmousedown = (e) => dotDown(e, layer, f);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (chosen) st._rotoCurveKey = null;
                    v._rotoDeleteKeyAt(layer, f);
                };
                wrap.append(dot);
                if (chosen) drawHandles(layer, k, g, color);
            }
        }
        const px = g0.X(v._rotoFrame());
        svgLine(svg, { x1: px, y1: 0, x2: px, y2: 100, stroke: "#fff", opacity: 0.6 });
    }

    /** The selected key's two handles: into it from the key before, out of it to the next. */
    function drawHandles(layer, k, g, color) {
        const wrap = ui.wrap;
        const doc = wrap.ownerDocument;
        const f = g.keys[k];
        const kx = g.X(f), ky = g.Yv(g.level(k));
        const sides = [];
        if (k > 0 && !v._rotoKeyTangent(layer, g.keys[k - 1]).hold) sides.push(["in", g.segs[k - 1]]);
        if (k < g.K - 1 && !v._rotoKeyTangent(layer, f).hold) sides.push(["out", g.segs[k]]);
        for (const [side, seg] of sides) {
            const p = handlePos(layer, seg, side, g);
            tangentArm(wrap, kx, ky, p.x, p.y, color);
            const h = doc.createElement("div");
            h.className = "kf-tan";
            h.style.left = p.x + "%";
            h.style.top = p.y + "%";
            h.style.borderColor = color;
            h.title = `${side === "out" ? "Ease out of" : "Ease into"} the key at frame ${f}\n` +
                      "drag: farther out = more ease, height = speed · double-click for the default ease";
            h.onmousedown = (e) => handleDown(e, layer, seg, side);
            h.ondblclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (layer.tangents) delete layer.tangents[String(f)];
                v._rotoSave();
                v._rotoRefreshKfInfo();
                v._toolRedraw();
            };
            wrap.append(h);
        }
    }

    // ── Dragging ─────────────────────────────────────────────────────────────

    /** Press on a key: select it (its handles show), and drag it sideways to retime. */
    function dotDown(e, layer, frame) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        st._rotoCurveKey = { id: layer.id, f: frame };
        const dot = e.currentTarget;
        const rect = ui.wrap.getBoundingClientRect();
        const g = geom({ keys: v._rotoCurKeys(layer) });
        // Keys keep their order: one can't be dragged past its neighbours.
        const idx = g.keys.indexOf(frame);
        const loBound = idx > 0 ? g.keys[idx - 1] + 1 : g.min;
        const hiBound = idx < g.keys.length - 1 ? g.keys[idx + 1] - 1 : g.max;
        const win = (v._viewerWindow && v._viewerWindow()) || dot.ownerDocument.defaultView || window;
        let target = frame;
        const move = (ev) => {
            ev.preventDefault();
            const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            target = Math.max(loBound, Math.min(hiBound, Math.round(g.min + pct * g.span)));
            dot.style.left = g.X(target) + "%";
        };
        const up = () => {
            off();
            if (target !== frame) {
                v._rotoMoveKey(layer, frame, target);
                st._rotoCurveKey = { id: layer.id, f: target };
            }
            v._rotoRefreshKfInfo();
        };
        const off = drag(win, move, up);
        // The ring now; the handles come with the redraw on release (a redraw here would replace the very
        // dot being dragged).
        dot.classList.add("chosen");
    }

    /**
     * Drag an ease handle. `side` "out" edits the left key's out control point, "in" the right key's in
     * control point — both in the segment's own normalised time/progress square: across is influence, up
     * is speed.
     */
    function handleDown(e, layer, seg, side) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const rect = ui.wrap.getBoundingClientRect();
        const win = (v._viewerWindow && v._viewerWindow()) || e.currentTarget.ownerDocument.defaultView || window;
        const key = side === "out" ? seg.lo : seg.hi;
        const move = (ev) => {
            ev.preventDefault();
            const gx = ((ev.clientX - rect.left) / rect.width) * 100;
            const gy = ((ev.clientY - rect.top) / rect.height) * 100;
            const frac = Math.max(0.02, Math.min(0.98, (gx - seg.x0) / ((seg.x1 - seg.x0) || 1)));
            const gv = (GRAPH.bottom - gy) / (GRAPH.bottom - GRAPH.top);
            const dv = seg.v1 - seg.v0;
            const val = Math.max(0, Math.min(1, dv === 0 ? 0 : (gv - seg.v0) / dv));
            if (side === "out") v._rotoSetKeyTangent(layer, key, { ox: frac, oy: val });
            else v._rotoSetKeyTangent(layer, key, { ix: frac, iy: val });
            v.rotoRefreshCurves();
            v._toolRedraw();
        };
        const up = () => {
            off();
            v._rotoSave();
        };
        const off = drag(win, move, up);
    }

    return {
        el: host,
        ui,
        refresh,
        wake() { refresh(); },
        save() {
            return { shown: st._rotoCurveShown ? [...st._rotoCurveShown] : null,
                     key: st._rotoCurveKey || null, listW: st._rotoCurveListW || null };
        },
        dispose() { for (const off of [...offDrag]) off(); },
    };
}

/**
 * Make a Parameter Curves panel in `host`. Same split as the Roto Curves: the nodes' tracks are shared,
 * the shown channels, key selection and list width are this panel's own (`st`). An extra panel also keeps
 * its own node binding — it follows the Parameters panel's node until its header select pins another.
 * Returns the instance the dock keeps: { el, ui, refresh, wake, save, dispose }.
 */
export function createParamCurvesInstance(v, host, st, saved) {
    if (saved) {
        if (saved.shown && typeof saved.shown === "object") {
            st._paramCurveShown = new Map(Object.entries(saved.shown).map(([id, names]) => [id, new Set(names)]));
        }
        if (saved.key) st._paramCurveKey = saved.key;
        if (Number.isFinite(saved.listW) && saved.listW > 0) st._paramCurveListW = saved.listW;
        if (saved.nodeId != null) st._paramCurveNode = String(saved.nodeId);
    }

    const doc = host.ownerDocument;
    // The first panel follows the Parameters panel as it always did; an extra one can pick its own node.
    let nodeSel = null;
    let nodeSelSig = null;
    if (st !== v) {
        host.querySelectorAll(":scope > .curves-node-bar").forEach((n) => n.remove());
        const bar = doc.createElement("div");
        bar.className = "curves-node-bar";
        nodeSel = doc.createElement("select");
        nodeSel.className = "curves-node-sel";
        nodeSel.title = "Whose keyed parameters this panel shows — Follow Parameters tracks the Parameters panel";
        nodeSel.onchange = () => {
            st._paramCurveNode = nodeSel.value || null;
            st._paramCurveKey = null;
            refresh();
            v.queuePersistViewerState && v.queuePersistViewerState();
        };
        bar.append(nodeSel);
        host.append(bar);
    }

    const ui = buildCurvePanel(host, {
        listWidth: st._paramCurveListW || 130,
        onListWidth: (w) => { st._paramCurveListW = w; },
        onResized: () => refresh(),
        onBlank: () => { st._paramCurveKey = null; refresh(); },
        hint: "Drag a key sideways to retime it, up and down to change it; double-click removes it. " +
              "Click a key for its tangents — drag a handle to shape the curve, Alt to break it, " +
              "double-click it to hand the key back to its ease.",
    });
    st._paramCurveUI = ui;

    const offDrag = new Set();
    const drag = makeDrag(offDrag);

    /** The node this panel shows: its pin while set, else the one the Parameters panel shows. */
    function boundNode() {
        if (st._paramCurveNode != null) {
            const n = app.graph?.getNodeById?.(st._paramCurveNode);
            if (n) return n;
            st._paramCurveNode = null;   // the node it was pinned to is gone
        }
        return v.paramAnimNode ? v.paramAnimNode() : null;
    }

    /** The pick list: nodes with keyed tracks, and the pinned one even before it has keys. */
    function syncNodeSel() {
        if (!nodeSel) return;
        const nodes = ((app.graph && (app.graph._nodes || app.graph.nodes)) || [])
            .filter((n) => Object.keys(A.readTracks(n)).length);
        const pinned = st._paramCurveNode != null ? app.graph?.getNodeById?.(st._paramCurveNode) : null;
        if (pinned && !nodes.includes(pinned)) nodes.push(pinned);
        const sig = JSON.stringify(nodes.map((n) => [n.id, n.title || n.type]));
        if (sig !== nodeSelSig) {
            nodeSelSig = sig;
            nodeSel.innerHTML = "";
            const follow = doc.createElement("option");
            follow.value = "";
            follow.textContent = "Follow Parameters";
            nodeSel.append(follow);
            for (const n of nodes) {
                const o = doc.createElement("option");
                o.value = String(n.id);
                o.textContent = n.title || n.type;
                nodeSel.append(o);
            }
        }
        nodeSel.value = st._paramCurveNode != null ? String(st._paramCurveNode) : "";
    }

    function refresh() {
        const node = boundNode();
        syncNodeSel();
        ui.body.style.display = node ? "flex" : "none";
        ui.empty.style.display = node ? "none" : "block";
        ui.empty.textContent = "Select a bEpic node that can be animated (Transform, Grade, Blur, …) " +
                               "to see its curves.";
        if (!node) return;
        const tracks = A.readTracks(node);
        const lines = curveLines(node, tracks);
        syncCurveList(node, tracks, lines);
        const animated = Object.keys(tracks).length;
        ui.sub.textContent = animated
            ? `${node.title || node.type} · ${animated} animated`
            : `${node.title || node.type} · no keys yet — ◇ beside a parameter keys it`;
        drawCurves(node, lines);
    }

    /** The node's curves: the animated parameters, or the ones picked in the list. */
    function curveLines(node, tracks) {
        const names = A.animatableNames(node) || [];
        const picked = st._paramCurveShown && st._paramCurveShown.get(String(node.id));
        const colour = (name) => PARAM_PALETTE[names.indexOf(name) % PARAM_PALETTE.length];
        const chosen = picked && picked.size ? names.filter((n) => picked.has(n))
                                             : names.filter((n) => tracks[n]);
        return chosen.map((name) => ({ name, color: colour(name), keys: tracks[name] || [] }));
    }

    /** Show or hide one parameter's curve. Plain click picks it alone. */
    function toggleCurve(node, name, add, lines) {
        const all = st._paramCurveShown || (st._paramCurveShown = new Map());
        const id = String(node.id);
        let shown = all.get(id);
        if (!shown || !shown.size) shown = new Set(lines.map((l) => l.name));
        if (add) { if (shown.has(name)) shown.delete(name); else shown.add(name); }
        else shown = new Set([name]);
        all.set(id, shown);
        refresh();
    }

    function syncCurveList(node, tracks, lines) {
        const listDoc = ui.list.ownerDocument;
        const on = new Set(lines.map((l) => l.name));
        const names = A.animatableNames(node) || [];
        // Animated parameters first: on a node with eighty knobs they are the ones you came for.
        const order = names.filter((n) => tracks[n]).concat(names.filter((n) => !tracks[n]));
        ui.list.innerHTML = "";
        for (const name of order) {
            const row = listDoc.createElement("button");
            row.className = "curves-ch";
            row.textContent = name;
            row.style.setProperty("--ch", PARAM_PALETTE[names.indexOf(name) % PARAM_PALETTE.length]);
            row.title = `Show or hide ${name} (Shift/Ctrl adds to what is shown)`;
            row.classList.toggle("on", on.has(name));
            row.classList.toggle("animated", !!tracks[name]);
            row.onclick = (e) => toggleCurve(node, name, e.shiftKey || e.ctrlKey || e.metaKey, lines);
            ui.list.append(row);
        }
    }

    // ── Geometry & drawing ───────────────────────────────────────────────────

    function geom(node, lines) {
        const bounds = v.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);
        let lo = Infinity, hi = -Infinity;
        const see = (val) => { if (typeof val !== "number") return; if (val < lo) lo = val; if (val > hi) hi = val; };
        for (const l of lines) {
            if (!l.keys.length) { see(staticVal(node, l.name)); continue; }
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
        const Y = (val) => GRAPH.bottom - ((val - lo) / (hi - lo)) * (GRAPH.bottom - GRAPH.top);
        const frameAt = (xPct) => Math.round(bounds.min + (xPct / 100) * span);
        const valueAt = (yPct) => lo + ((GRAPH.bottom - yPct) / (GRAPH.bottom - GRAPH.top)) * (hi - lo);
        return { bounds, span, lo, hi, X, Y, frameAt, valueAt };
    }

    function staticVal(node, name) {
        const w = (node.widgets || []).find((x) => x.name === name);
        return w ? w.value : 0;
    }

    function drawCurves(node, lines) {
        const svg = ui.svg;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const g = geom(node, lines);
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
                const y = g.Y(staticVal(node, l.name)).toFixed(2);
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
        const playhead = g.X(Math.round(v.currentFrame || 0));
        line({ x1: playhead, y1: 0, x2: playhead, y2: 100, stroke: "#fff", opacity: 0.6 });
        layoutDots(node, lines, g);
    }

    function layoutDots(node, lines, g) {
        const wrap = ui.wrap;
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        const dotDoc = wrap.ownerDocument;
        const sel = st._paramCurveKey;
        for (const l of lines) {
            for (const k of l.keys) {
                const chosen = !!sel && sel.node === String(node.id) && sel.name === l.name && sel.f === k.f;
                const dot = dotDoc.createElement("div");
                dot.className = "kf-dot" + (chosen ? " chosen" : "");
                dot.style.left = g.X(k.f) + "%";
                dot.style.top = g.Y(k.v) + "%";
                dot.style.background = l.color;
                dot.title = `${l.name} · frame ${k.f} = ${Math.round(k.v * 1000) / 1000}\n` +
                            "drag sideways to retime, up/down to change · click for tangents · double-click to delete";
                dot.onmousedown = (e) => dotDown(e, node, l.name, k.f, lines);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const tracks = A.readTracks(node);
                    tracks[l.name] = A.removeKey(tracks[l.name], k.f);
                    if (chosen) st._paramCurveKey = null;
                    v.paramAnimWrite(node, tracks);
                    v.paramAnimChanged();
                };
                wrap.append(dot);
                if (chosen) layoutTangents(node, l, k, g);
            }
        }
    }

    function layoutTangents(node, l, key, g) {
        const wrap = ui.wrap;
        const tanDoc = wrap.ownerDocument;
        const reach = Math.max(1, g.span * HANDLE_SPAN);
        const i = l.keys.findIndex((k) => k.f === key.f);
        for (const side of ["in", "out"]) {
            if (side === "in" && i <= 0) continue;
            if (side === "out" && i >= l.keys.length - 1) continue;
            const slope = A.tangentAt(l.keys, key.f, side);
            const dir = side === "in" ? -1 : 1;
            const x2 = g.X(key.f + dir * reach), y2 = g.Y(key.v + dir * reach * slope);
            tangentArm(wrap, g.X(key.f), g.Y(key.v), x2, y2, l.color);
            const h = tanDoc.createElement("div");
            h.className = "kf-tan";
            h.style.left = x2 + "%";
            h.style.top = y2 + "%";
            h.style.borderColor = l.color;
            h.title = `${l.name} · ${side === "in" ? "incoming" : "outgoing"} tangent ` +
                      `(${Math.round(slope * 1000) / 1000} per frame)\n` +
                      "drag to shape · Alt to break the pair · double-click for the key's ease again";
            h.onmousedown = (e) => tangentDown(e, node, l.name, key.f, side);
            h.ondblclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const tracks = A.readTracks(node);
                A.clearTangents(tracks[l.name], key.f);
                v.paramAnimWrite(node, tracks);
                v.paramAnimChanged();
            };
            wrap.append(h);
        }
    }

    // ── Dragging ─────────────────────────────────────────────────────────────

    function dotDown(e, node, name, frame, lines) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        st._paramCurveKey = { node: String(node.id), name, f: frame };
        const wrap = ui.wrap;
        const win = v._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        const isInt = A.isIntParam(node, name);
        let current = frame;
        // The value band is held for the drag, or the graph would rescale under the pointer as the key moves.
        const g = geom(node, lines);

        const onMove = (evt) => {
            const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
            const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
            const tracks = A.readTracks(node);
            const keys = tracks[name] || [];
            const key = keys.find((k) => k.f === current);
            if (!key) return;
            let val = evt.shiftKey ? key.v : g.valueAt(yPct);
            if (isInt) val = Math.round(val);
            const want = Math.max(g.bounds.min, Math.min(g.bounds.max, g.frameAt(xPct)));
            let next = keys;
            if (want !== current && !keys.some((k) => k.f === want)) {
                const moved = { ...key, f: want, v: val };
                next = A.removeKey(keys, current).concat([moved]).sort((a, b) => a.f - b.f);
                current = want;
                st._paramCurveKey = { node: String(node.id), name, f: current };
            } else {
                key.v = val;
            }
            tracks[name] = next;
            v.paramAnimWrite(node, tracks);
            v.paramAnimChanged();
        };
        const onUp = () => {
            off();
            v.paramAnimChanged();
        };
        const off = drag(win, onMove, onUp);
        refresh();
    }

    function tangentDown(e, node, name, frame, side) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const wrap = ui.wrap;
        const win = v._viewerWindow();
        const rect = wrap.getBoundingClientRect();
        const broken = e.altKey;
        const tracks0 = A.readTracks(node);
        const g = geom(node, curveLines(node, tracks0));

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
            v.paramAnimWrite(node, tracks);
            v.paramAnimChanged();
        };
        const onUp = () => { off(); };
        const off = drag(win, onMove, onUp);
    }

    return {
        el: host,
        ui,
        refresh,
        wake() { refresh(); },
        save() {
            const shown = st._paramCurveShown
                ? Object.fromEntries([...st._paramCurveShown].map(([id, set]) => [id, [...set]]))
                : null;
            return { shown, key: st._paramCurveKey || null, listW: st._paramCurveListW || null,
                     nodeId: st._paramCurveNode != null ? String(st._paramCurveNode) : null };
        },
        dispose() { for (const off of [...offDrag]) off(); },
    };
}