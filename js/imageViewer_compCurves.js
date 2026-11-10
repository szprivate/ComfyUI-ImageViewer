// imageViewer_compCurves.js
// The Comp's Curve Editor (dock id "compCurves"): the keys of the selected nodes, value over time, one curve per
// animated parameter and axis (a position has x and y, a colour r g b a). Built from the same parts as the other
// curve panels of the viewer (imageViewer_curveUI.js: the list, the graph, the tangent arms), so it looks and
// handles alike: drag a key sideways to retime it and up / down to change it (Shift: only in time), double-click
// removes it; click a key for its tangents, drag a handle to shape the curve (Alt: that side only), double-click a
// handle to give the key back its ease.
//
// A plain function over a host element: the editor (imageViewer_compEditor.js) hands it what it needs, so the
// keys are the comp's own (Motion's format, {f, v, ease, ti?, to?}) and every change is one undo step there.
//
//   api.nodes()               the selected nodes, the shown one first
//   api.specOf(node, p)       the parameter's spec (kind, label, min / max)
//   api.valueAt(node, p, f)   its value at frame f (what the picture uses)
//   api.range()               {min, max} frames of the comp
//   api.frame()               the frame on screen
//   api.begin()               a change starts (the undo step is taken here)
//   api.changed()             the keys changed (the picture and Parameters follow)
//   api.end()                 the change is done
//   api.seek(f)               go to a frame (a click on the graph's ruler)
import { buildCurvePanel, svgLine, tangentArm } from "./imageViewer_curveUI.js";

const GRAPH = { top: 10, bottom: 90 };
const HANDLE_SPAN = 0.06;
const PALETTE = ["#ff6b6b", "#8ce26b", "#6bb6ff", "#ffd24d", "#ff9d4d", "#c8e24d", "#4dc8ff", "#ff6bd5", "#6be2c8", "#9d8cff"];
const AXES = { vec2: ["x", "y"], color: ["r", "g", "b", "a"] };
const AXIS_COLOR = { x: "#ff6b6b", y: "#8ce26b", r: "#ff6b6b", g: "#8ce26b", b: "#6bb6ff", a: "#d8d8dc" };

/** One curve per animated parameter and axis of the nodes: {id, node, p, axis, label, color, keys}. */
export function curveLines(nodes, specOf) {
    const out = [];
    let c = 0;
    for (const n of nodes) {
        for (const [p, keys] of Object.entries(n.tracks || {})) {
            if (!Array.isArray(keys) || !keys.length) continue;
            const d = specOf(n, p) || {};
            const axes = AXES[d.kind] || [null];
            const base = PALETTE[c++ % PALETTE.length];
            axes.forEach((ax, i) => out.push({
                id: `${n.id}.${p}${ax ? "." + ax : ""}`, node: n, p, axis: ax === null ? null : i,
                label: `${n.name || n.id}.${d.label || p}${ax ? "." + ax : ""}`,
                color: ax ? AXIS_COLOR[ax] : base, keys,
            }));
        }
    }
    return out;
}
const comp = (v, axis) => (axis === null ? Number(v) : Array.isArray(v) ? Number(v[axis]) : Number(v));
function setComp(v, axis, x) {
    if (axis === null) return x;
    const a = Array.isArray(v) ? v.slice() : [];
    a[axis] = x;
    return a;
}

export function createCompCurves(host, api) {
    const doc = host.ownerDocument;
    const st = { hidden: new Set(), key: null, listW: 150 };
    const ui = buildCurvePanel(host, {
        listWidth: st.listW,
        onListWidth: (w) => { st.listW = w; },
        onResized: () => draw(),
        onBlank: () => { st.key = null; draw(); },
        hint: "Drag a key sideways to retime it, up and down to change it (Shift: in time only); double-click removes it. " +
              "Click a key for its tangents: drag a handle to shape the curve, Alt for that side only, double-click it for the key's ease again.",
    });
    host.classList.add("cp-curves");

    const shown = () => curveLines(api.nodes(), api.specOf).filter((l) => !st.hidden.has(l.id));

    function geom(lines) {
        const r = api.range();
        const span = Math.max(1, r.max - r.min);
        let lo = Infinity, hi = -Infinity;
        const see = (v) => { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
        for (const l of lines) {
            for (const k of l.keys) see(comp(k.v, l.axis));
            const f0 = l.keys[0].f, f1 = l.keys[l.keys.length - 1].f;
            for (let i = 0; i <= 24; i++) see(comp(api.valueAt(l.node, l.p, f0 + ((f1 - f0) * i) / 24), l.axis));
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;
        const X = (f) => ((f - r.min) / span) * 100;
        const Y = (v) => GRAPH.bottom - ((v - lo) / (hi - lo)) * (GRAPH.bottom - GRAPH.top);
        const frameAt = (x) => Math.round(r.min + (x / 100) * span);
        const valueAt = (y) => lo + ((GRAPH.bottom - y) / (GRAPH.bottom - GRAPH.top)) * (hi - lo);
        return { r, span, lo, hi, X, Y, frameAt, valueAt };
    }

    function list(lines) {
        const all = curveLines(api.nodes(), api.specOf);
        ui.list.replaceChildren();
        for (const l of all) {
            const row = doc.createElement("button");
            row.className = "curves-ch animated";
            row.textContent = l.label;
            row.dataset.curve = l.id;
            row.style.setProperty("--ch", l.color);
            row.classList.toggle("on", !st.hidden.has(l.id));
            row.title = `Show or hide ${l.label} (a plain click shows it alone, Shift / Ctrl adds or takes it away)`;
            row.onclick = (e) => {
                if (e.shiftKey || e.ctrlKey || e.metaKey) { if (st.hidden.has(l.id)) st.hidden.delete(l.id); else st.hidden.add(l.id); }
                else { st.hidden = new Set(all.map((x) => x.id).filter((id) => id !== l.id)); if (lines.length === 1 && lines[0].id === l.id) st.hidden.clear(); }
                draw();
            };
            ui.list.append(row);
        }
    }

    // The slope of the curve on one side of a key, as the picture has it (what the arm shows when no tangent is set).
    function slopeAt(l, k, side) {
        const t = side === "in" ? k.ti : k.to;
        if (t !== undefined && t !== null) return comp(t, l.axis);
        const e = 0.01, v = comp(k.v, l.axis);
        const w = comp(api.valueAt(l.node, l.p, k.f + (side === "in" ? -e : e)), l.axis);
        return side === "in" ? (v - w) / e : (w - v) / e;
    }

    function draw() {
        const nodes = api.nodes();
        const lines = shown();
        ui.body.style.display = nodes.length ? "flex" : "none";
        ui.empty.style.display = nodes.length ? "none" : "block";
        ui.empty.textContent = "Select nodes in the Node Graph to see their keys (the stopwatch beside a parameter animates it).";
        if (!nodes.length) return;
        list(lines);
        const any = curveLines(nodes, api.specOf).length;
        ui.sub.textContent = any ? `${nodes.length === 1 ? nodes[0].name || nodes[0].id : nodes.length + " nodes"} · ${any} curve${any === 1 ? "" : "s"}`
            : "No keys yet: the stopwatch beside a parameter animates it";
        const svg = ui.svg;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const g = geom(lines);
        const line = (a) => svgLine(svg, a);
        line({ x1: 0, y1: GRAPH.bottom, x2: 100, y2: GRAPH.bottom, stroke: "#333" });
        line({ x1: 0, y1: GRAPH.top, x2: 100, y2: GRAPH.top, stroke: "#262626" });
        if (g.lo < 0 && g.hi > 0) line({ x1: 0, y1: g.Y(0), x2: 100, y2: g.Y(0), stroke: "#3a3a3a", "stroke-dasharray": "3 3" });
        for (const l of lines) {
            const steps = Math.max(24, Math.min(400, g.span * 2));
            let d = "";
            for (let i = 0; i <= steps; i++) {
                const f = g.r.min + (g.span * i) / steps;
                d += `${i ? "L" : "M"} ${g.X(f).toFixed(2)} ${g.Y(comp(api.valueAt(l.node, l.p, f), l.axis)).toFixed(2)} `;
            }
            line({ tag: "path", d, fill: "none", "stroke-width": 2, stroke: l.color, "data-curve": l.id });
        }
        const ph = g.X(api.frame());
        line({ x1: ph, y1: 0, x2: ph, y2: 100, stroke: "#fff", opacity: 0.6 });
        dots(lines, g);
    }

    function dots(lines, g) {
        const wrap = ui.wrap;
        wrap.querySelectorAll(".kf-dot, .kf-tan, .kf-tan-line").forEach((d) => d.remove());
        for (const l of lines) {
            for (const k of l.keys) {
                const chosen = !!st.key && st.key.id === l.id && st.key.f === k.f;
                const v = comp(k.v, l.axis);
                const dot = doc.createElement("div");
                dot.className = "kf-dot" + (chosen ? " chosen" : "");
                dot.dataset.curve = l.id; dot.dataset.f = k.f;
                dot.style.left = g.X(k.f) + "%"; dot.style.top = g.Y(v) + "%"; dot.style.background = l.color;
                dot.title = `${l.label} · frame ${k.f} = ${Math.round(v * 1000) / 1000}`;
                dot.onpointerdown = (e) => keyDown(e, l, k.f, g);
                dot.ondblclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    api.begin();
                    const keys = l.node.tracks[l.p];
                    const i = keys.findIndex((x) => x.f === k.f);
                    if (i >= 0) keys.splice(i, 1);
                    if (!keys.length) { l.node[l.p] = k.v; delete l.node.tracks[l.p]; }
                    st.key = null;
                    api.changed(); api.end();
                };
                wrap.append(dot);
                if (chosen) tangents(l, k, g);
            }
        }
    }

    function tangents(l, k, g) {
        const wrap = ui.wrap;
        const i = l.keys.indexOf(k);
        const reach = Math.max(1, g.span * HANDLE_SPAN);
        for (const side of ["in", "out"]) {
            if (side === "in" && i <= 0) continue;
            if (side === "out" && i >= l.keys.length - 1) continue;
            const s = slopeAt(l, k, side), dir = side === "in" ? -1 : 1, v = comp(k.v, l.axis);
            const x2 = g.X(k.f + dir * reach), y2 = g.Y(v + dir * reach * s);
            tangentArm(wrap, g.X(k.f), g.Y(v), x2, y2, l.color);
            const h = doc.createElement("div");
            h.className = "kf-tan"; h.dataset.side = side;
            h.style.left = x2 + "%"; h.style.top = y2 + "%"; h.style.borderColor = l.color;
            h.title = `${side === "in" ? "Incoming" : "Outgoing"} tangent (${Math.round(s * 1000) / 1000} a frame): drag to shape, Alt for this side only, double-click for the key's ease`;
            h.onpointerdown = (e) => tanDown(e, l, k.f, side, g);
            h.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); api.begin(); delete k.ti; delete k.to; api.changed(); api.end(); };
            wrap.append(h);
        }
    }

    const pct = (e, rect) => [Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)),
                              Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100))];

    function keyDown(e, l, f0, g) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        st.key = { id: l.id, f: f0 };
        const rect = ui.wrap.getBoundingClientRect();
        const win = doc.defaultView || window;
        const d = api.specOf(l.node, l.p) || {};
        let cur = f0, started = false;
        const sx = e.clientX, sy = e.clientY;
        const move = (ev) => {
            if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
            if (!started) { api.begin(); started = true; }
            const [x, y] = pct(ev, rect);
            const keys = l.node.tracks && l.node.tracks[l.p];
            const k = keys && keys.find((q) => q.f === cur);
            if (!k) return;
            if (!ev.shiftKey) {
                let v = g.valueAt(y);
                if (d.kind === "int") v = Math.round(v);
                if (d.min !== undefined) v = Math.max(d.min, v);
                if (d.max !== undefined) v = Math.min(d.max, v);
                k.v = setComp(k.v, l.axis, Math.round(v * 1e4) / 1e4);
            }
            const want = Math.max(g.r.min, Math.min(g.r.max, g.frameAt(x)));
            if (want !== cur && !keys.some((q) => q.f === want)) { k.f = want; cur = want; keys.sort((a, b) => a.f - b.f); st.key = { id: l.id, f: cur }; }
            api.changed();
        };
        const up = () => { win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); if (started) api.end(); else draw(); };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
        draw();
    }

    function tanDown(e, l, f, side, g) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const rect = ui.wrap.getBoundingClientRect();
        const win = doc.defaultView || window;
        const broken = e.altKey;
        let started = false;
        const move = (ev) => {
            const k = (l.node.tracks && l.node.tracks[l.p] || []).find((q) => q.f === f);
            if (!k) return;
            if (!started) {
                api.begin(); started = true;
                // Both sides start from what the picture has now, so setting one does not bend the other.
                for (const s of ["ti", "to"]) if (k[s] === undefined) k[s] = l.axis === null ? slopeAt(l, k, s === "ti" ? "in" : "out")
                    : (Array.isArray(k.v) ? k.v : []).map((_, ax) => slopeAt({ ...l, axis: ax }, k, s === "ti" ? "in" : "out"));
            }
            const [x, y] = pct(ev, rect);
            const dir = side === "in" ? -1 : 1;
            const df = (g.r.min + (x / 100) * g.span) - f;
            const reach = dir * Math.max(Math.max(0.5, g.span * 0.01), dir * df);
            const s = (g.valueAt(y) - comp(k.v, l.axis)) / reach;
            const put = (key) => { k[key] = setComp(k[key], l.axis, s); };
            put(side === "in" ? "ti" : "to");
            if (!broken) put(side === "in" ? "to" : "ti");
            api.changed();
        };
        const up = () => { win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); if (started) api.end(); };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
    }

    ui.svg.addEventListener("dblclick", (e) => {
        const r = ui.wrap.getBoundingClientRect();
        const g = geom(shown());
        if (api.seek) api.seek(g.frameAt(((e.clientX - r.left) / r.width) * 100));
    });

    return { el: host, draw, state: st };
}
