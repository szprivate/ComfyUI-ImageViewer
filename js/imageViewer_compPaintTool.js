// The Comp Paint node's tool: strokes painted on the picture while a Paint node is on top of the Parameters panel,
// and its section there (the tools, the brush, the list of strokes). The arithmetic is imageViewer_compPaint.js;
// this file is the pointer and the panel, and knows the editor only through `api` (see createCompEditor).
import * as PT from "./imageViewer_compPaint.js";

const BRUSH_KEY = "imageviewer.comp.paintBrush";
const TOOLS = [["select", "Select", "Pick a stroke on the picture to edit it"], ["color", "Brush", "Paint colour"],
    ["clone", "Clone", "Paint the picture from another place (Alt+click sets where from) or another frame"],
    ["reveal", "Reveal", "Paint the second input (reveal) through"], ["erase", "Eraser", "Take the picture away (alpha too)"]];

function loadBrush() {
    const d = { tool: "color", size: 40, hard: 0.6, opacity: 1, spacing: 0.1, color: [1, 1, 1, 1], life: "all", dt: 0, offset: [0, 0] };
    try {
        const v = JSON.parse(localStorage.getItem(BRUSH_KEY) || "null");
        if (v && typeof v === "object") {
            const s = PT.cleanStroke({ ...v, pts: [[0, 0]] });
            if (s) return { ...d, ...s, tool: TOOLS.some((t) => t[0] === v.tool) ? v.tool : d.tool, pts: undefined, ...(typeof v.link === "string" && v.link ? { link: v.link } : {}) };
        }
    } catch (_) { /* none kept */ }
    return d;
}

export function createPaintTool(api) {
    const { doc, el, svgEl } = api;
    const b = loadBrush();
    delete b.pts;
    const st = { brush: b, sel: -1, nodeId: null, srcPt: null, hover: null, drawing: null };
    const keep = () => { try { localStorage.setItem(BRUSH_KEY, JSON.stringify(st.brush)); } catch (_) { /* not kept */ } };
    const r3 = (x) => Math.round(x * 1000) / 1000;

    /** The Paint node the tool works on: the primary selection, when it is a Paint node that is on. */
    const target = () => { const n = api.primary(); return n && n.type === "paint" && !n.disable ? n : null; };
    const strokesOf = (n) => (Array.isArray(n.strokes) ? n.strokes : []);
    const at = (n, e) => { const p = api.compXY(e), off = api.downBy(api.inFmt(n)); return [p[0], p[1] - off]; };
    function edit(fn) {
        const n = target();
        if (!n) return;
        api.push();
        n.strokes = strokesOf(n).map((s) => JSON.parse(JSON.stringify(s)));
        fn(n);
        api.changed();
    }

    // ── on the picture ──────────────────────────────────────────────────
    /** A press on the stage: true when the tool took it (drawing, picking a stroke, setting a clone source). */
    function down(e) {
        const n = target();
        if (!n || e.button !== 0) return false;
        if (st.nodeId !== n.id) { st.nodeId = n.id; st.sel = -1; }
        const xy = at(n, e), tool = st.brush.tool;
        if (tool === "select") {
            const i = PT.strokeAt(strokesOf(n), api.frame(), xy[0], xy[1]);
            if (i < 0) { if (st.sel >= 0) { st.sel = -1; api.redraw(); } return false; }
            st.sel = i; api.redraw();
            e.preventDefault();
            return true;
        }
        e.preventDefault(); e.stopPropagation();
        if (e.altKey && (tool === "clone" || tool === "reveal")) { st.srcPt = xy; api.overlay(); api.toast("Clone source set: the next stroke paints from there", "info"); return true; }
        const s = {
            tool, pts: [xy], size: st.brush.size, hard: st.brush.hard, opacity: st.brush.opacity, spacing: st.brush.spacing,
            life: st.brush.life, f: api.frame(),
        };
        if (tool === "color") s.color = st.brush.color.slice();
        if (tool === "clone" || tool === "reveal") {
            if (st.srcPt) { st.brush.offset = [r3(st.srcPt[0] - xy[0]), r3(st.srcPt[1] - xy[1])]; st.srcPt = null; keep(); }
            s.offset = st.brush.offset.slice();
            if (st.brush.dt) s.dt = st.brush.dt;
        }
        if (st.brush.link && api.node(st.brush.link)) s.link = st.brush.link;
        if (s.life === "range") s.f1 = api.frame();
        api.push();
        n.strokes = strokesOf(n).concat([s]);
        const idx = n.strokes.length - 1;
        st.drawing = { n, s, raw: [xy] };
        api.stage.setPointerCapture(e.pointerId);
        api.live();
        api.stage.onpointermove = (ev) => {
            const p = at(n, ev);
            st.drawing.raw.push(p);
            s.pts = PT.thinPoints(st.drawing.raw, Math.max(0.5, s.size * s.spacing * 0.25));
            st.hover = p;
            api.live(); api.overlay();
        };
        api.stage.onpointerup = () => {
            api.stage.onpointermove = null; api.stage.onpointerup = null;
            s.pts = PT.thinPoints(st.drawing.raw, Math.max(0.5, s.size * s.spacing * 0.25));
            st.drawing = null; st.sel = idx;
            api.changed();
        };
        return true;
    }
    /** The pointer over the stage: the brush's circle follows it. */
    function move(e) {
        const n = target();
        if (!n || st.brush.tool === "select") { if (st.hover) { st.hover = null; api.overlay(); } return; }
        st.hover = at(n, e);
        drawCursor();
    }
    function leave() { if (st.hover && !st.drawing) { st.hover = null; drawCursor(); } }
    let cursorEl = null;
    function drawCursor() {
        if (cursorEl) cursorEl.remove();
        cursorEl = null;
        const n = target(), layer = api.layer();
        if (!n || !st.hover || !layer || st.brush.tool === "select") return;
        cursorEl = svgEl(doc, "g", { class: "cp-pbrush" });
        const [x, y] = st.hover, r = st.brush.size / 2;
        cursorEl.append(svgEl(doc, "circle", { cx: x, cy: y, r }));
        if ((st.brush.tool === "clone" || st.brush.tool === "reveal") && !st.srcPt) {
            const [ox, oy] = st.brush.offset;
            if (ox || oy) {
                const z = api.zoom(), k = 6 / z;
                cursorEl.append(svgEl(doc, "circle", { class: "src", cx: x + ox, cy: y + oy, r }),
                    svgEl(doc, "line", { class: "src", x1: x + ox - k, y1: y + oy, x2: x + ox + k, y2: y + oy }),
                    svgEl(doc, "line", { class: "src", x1: x + ox, y1: y + oy - k, x2: x + ox, y2: y + oy + k }));
            }
        }
        layer.append(cursorEl);
    }
    /** The node's overlay: the selected stroke's line, a clone source waiting, the brush. */
    function overlay(layer) {
        const n = target();
        cursorEl = null;
        if (!n) return;
        if (st.nodeId !== n.id) { st.nodeId = n.id; st.sel = -1; }
        const z = api.zoom();
        const s = st.sel >= 0 ? PT.cleanStroke(strokesOf(n)[st.sel]) : null;
        if (s && !st.drawing) {
            const pts = s.pts.map((p) => p.join(",")).join(" ");
            layer.append(svgEl(doc, "polyline", { class: "cp-pline", points: pts, "stroke-width": Math.max(1, s.size) }));
            layer.append(svgEl(doc, "polyline", { class: "cp-hline solid", points: pts }));
        }
        if (st.srcPt) {
            const [x, y] = st.srcPt, k = 9 / z;
            layer.append(svgEl(doc, "circle", { class: "cp-handle small", cx: x, cy: y, r: 4 / z }),
                svgEl(doc, "line", { class: "cp-hline solid", x1: x - k, y1: y, x2: x + k, y2: y }),
                svgEl(doc, "line", { class: "cp-hline solid", x1: x, y1: y - k, x2: x, y2: y + k }));
        }
        drawCursor();
    }
    function key(e) {
        const n = target();
        if (!n) return false;
        const k = e.key;
        if (k === "[" || k === "]") { st.brush.size = Math.max(1, Math.min(2000, Math.round(st.brush.size * (k === "]" ? 1.2 : 1 / 1.2)))); keep(); drawCursor(); api.props(); return true; }
        if ((k === "Delete" || k === "Backspace") && st.sel >= 0 && st.sel < strokesOf(n).length) { const i = st.sel; st.sel = -1; edit((m) => m.strokes.splice(i, 1)); return true; }
        if (k === "Escape" && (st.sel >= 0 || st.srcPt)) { st.sel = -1; st.srcPt = null; api.redraw(); return true; }
        return false;
    }

    // ── the panel ───────────────────────────────────────────────────────
    const row = (label, ...kids) => { const r = el(doc, "div", "mg-prop"); r.append(el(doc, "label", "", label), ...kids); return r; };
    const num = (v, step, fn, d) => api.numInput(v, step, (x) => { if (x !== null) fn(x); }, d);
    const select = (choices, value, fn) => {
        const s = el(doc, "select");
        for (const [v, label] of choices) s.append(new Option(label, v));
        s.value = value;
        s.onchange = () => fn(s.value);
        return s;
    };
    const lifeChoices = PT.PAINT_LIFE.map((v) => [v, PT.PAINT_LIFE_LABELS[v]]);
    const linkChoices = () => [["", "nothing"], ...api.comp().nodes.filter((m) => m.type === "transform").map((m) => [m.id, m.name || m.id])];
    const colorInput = (c, fn) => {
        const i = el(doc, "input"); i.type = "color"; i.value = api.toHex(c);
        i.onchange = () => fn(api.fromHex(i.value, c[3] ?? 1));
        return i;
    };
    function brushRows(box) {
        const B = st.brush, t = B.tool;
        const set = (k, v) => { B[k] = v; keep(); drawCursor(); };
        box.append(row("size", num(B.size, 1, (v) => set("size", Math.max(0.5, v)), { min: 0.5 })));
        box.append(row("hardness", num(B.hard, 0.05, (v) => set("hard", Math.max(0, Math.min(1, v))), { min: 0, max: 1 })));
        box.append(row("opacity", num(B.opacity, 0.05, (v) => set("opacity", Math.max(0, Math.min(1, v))), { min: 0, max: 1 })));
        box.append(row("spacing", num(B.spacing, 0.02, (v) => set("spacing", Math.max(0.02, Math.min(2, v))), { min: 0.02, max: 2 })));
        if (t === "color") box.append(row("colour", colorInput(B.color, (c) => set("color", c))));
        if (t === "clone" || t === "reveal") {
            box.append(row("from x / y", num(B.offset[0], 1, (v) => set("offset", [v, B.offset[1]])), num(B.offset[1], 1, (v) => set("offset", [B.offset[0], v]))));
            box.append(row("from frame", num(B.dt, 1, (v) => set("dt", Math.round(v)), { title: "Frames from the one shown: -1 paints from the frame before" })));
        }
        box.append(row("frames", select(lifeChoices, B.life, (v) => set("life", v))));
        box.append(row("follow", select(linkChoices(), B.link || "", (v) => { if (v) set("link", v); else { delete B.link; keep(); } })));
    }
    function strokeRows(box, n, i) {
        const s = PT.cleanStroke(strokesOf(n)[i]);
        if (!s) return;
        const ed = (fn) => edit((m) => fn(m.strokes[i]));
        box.append(el(doc, "div", "cp-psub", `Stroke ${i + 1}: ${PT.PAINT_TOOL_LABELS[s.tool]}`));
        box.append(row("frames", select(lifeChoices, s.life, (v) => ed((x) => { x.life = v; if (v === "range" && x.f1 === undefined) x.f1 = x.f ?? 0; }))));
        if (s.life !== "all") box.append(row(s.life === "range" ? "f / f1" : "frame", num(s.f, 1, (v) => ed((x) => { x.f = Math.round(v); })),
            ...(s.life === "range" ? [num(s.f1, 1, (v) => ed((x) => { x.f1 = Math.round(v); }))] : [])));
        box.append(row("size", num(s.size, 1, (v) => ed((x) => { x.size = Math.max(0.5, v); }), { min: 0.5 })));
        box.append(row("hardness", num(s.hard, 0.05, (v) => ed((x) => { x.hard = Math.max(0, Math.min(1, v)); }), { min: 0, max: 1 })));
        box.append(row("opacity", num(s.opacity, 0.05, (v) => ed((x) => { x.opacity = Math.max(0, Math.min(1, v)); }), { min: 0, max: 1 })));
        if (s.tool === "color") box.append(row("colour", colorInput(s.color, (c) => ed((x) => { x.color = c; }))));
        if (s.tool === "clone" || s.tool === "reveal") {
            box.append(row("from x / y", num(s.offset[0], 1, (v) => ed((x) => { x.offset = [v, s.offset[1]]; })), num(s.offset[1], 1, (v) => ed((x) => { x.offset = [s.offset[0], v]; }))));
            box.append(row("from frame", num(s.dt, 1, (v) => ed((x) => { x.dt = Math.round(v); }))));
        }
        box.append(row("follow", select(linkChoices(), s.link || "", (v) => ed((x) => { if (v) x.link = v; else delete x.link; }))));
    }
    /** The Paint node's section of its panel (the panel on top only: the tool works on that one). */
    function section(n, box, first) {
        if (st.nodeId !== n.id) { st.nodeId = n.id; st.sel = -1; }
        if (!first) { box.append(el(doc, "div", "mg-empty", "Strokes are painted in the panel on top: click this node in the graph to bring it there.")); return; }
        const tools = el(doc, "div", "cp-ptools");
        for (const [t, label, tip] of TOOLS) {
            const bt = api.btn(label, tip, () => { st.brush.tool = t; keep(); api.props(); api.overlay(); }, st.brush.tool === t ? "on" : "");
            bt.dataset.ptool = t;
            tools.append(bt);
        }
        box.append(tools);
        if (st.brush.tool !== "select") { const rows = el(doc, "div", "cp-pbrushrows"); brushRows(rows); box.append(rows); }
        const list = strokesOf(n);
        const head = el(doc, "div", "cp-psub", `Strokes (${list.length})`);
        box.append(head);
        if (!list.length) box.append(el(doc, "div", "mg-empty", "Drag on the picture to paint. [ and ] change the size; Alt+click sets a clone source."));
        const rows = el(doc, "div", "cp-plist");
        list.forEach((raw, i) => {
            const s = PT.cleanStroke(raw);
            if (!s) return;
            const r = el(doc, "div", "cp-prow" + (i === st.sel ? " sel" : "") + (s.off ? " off" : "") + (PT.strokeLive(s, api.frame()) ? "" : " idle"));
            r.dataset.stroke = String(i);
            const eye = el(doc, "span", "mg-ic" + (s.off ? "" : " on"), "👁");
            eye.title = "Show / hide this stroke";
            eye.onclick = (ev) => { ev.stopPropagation(); edit((m) => { if (m.strokes[i].off) delete m.strokes[i].off; else m.strokes[i].off = true; }); };
            const life = s.life === "all" ? "all" : s.life === "range" ? `${Math.min(s.f, s.f1)}–${Math.max(s.f, s.f1)}` : `${PT.PAINT_LIFE_LABELS[s.life]} ${s.f}`;
            const x = el(doc, "span", "cp-pdel", "×");
            x.title = "Delete this stroke";
            x.onclick = (ev) => { ev.stopPropagation(); if (st.sel === i) st.sel = -1; else if (st.sel > i) st.sel--; edit((m) => m.strokes.splice(i, 1)); };
            r.append(eye, el(doc, "span", "cp-pname", `${i + 1} · ${PT.PAINT_TOOL_LABELS[s.tool]}`), el(doc, "span", "cp-plife", life), x);
            r.onclick = () => { st.sel = st.sel === i ? -1 : i; api.props(); api.overlay(); };
            rows.append(r);
        });
        box.append(rows);
        if (st.sel >= 0 && st.sel < list.length) strokeRows(box, n, st.sel);
    }
    return { down, move, leave, overlay, key, section, state: st, active: () => !!target() && st.brush.tool !== "select" };
}

export const PAINT_TOOL_CSS = `
.cp-ptools{display:flex;flex-wrap:wrap;gap:3px;margin:6px 4px 4px}
.cp-ptools .mg-btn{flex:1 1 auto;padding:2px 6px}
.cp-psub{margin:8px 4px 3px;font-weight:600;color:#bbb}
.cp-plist{display:flex;flex-direction:column;gap:1px;margin:0 4px;max-height:180px;overflow:auto}
.cp-prow{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:3px;cursor:pointer;background:#ffffff06}
.cp-prow:hover{background:#ffffff12}.cp-prow.sel{background:#ffcf3a33}
.cp-prow.off .cp-pname{text-decoration:line-through;opacity:.6}.cp-prow.idle{opacity:.55}
.cp-pname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cp-plife{color:#9aa;font-size:11px}
.cp-pdel{opacity:.6;padding:0 3px}.cp-pdel:hover{opacity:1;color:#ff6a6a}
.cp-over .cp-pbrush circle{fill:none;stroke:#fff;stroke-width:1px;vector-effect:non-scaling-stroke;mix-blend-mode:difference}
.cp-over .cp-pbrush .src{fill:none;stroke:#ffcf3a;stroke-width:1px;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.cp-over .cp-pline{fill:none;stroke:#3ad1ff33;stroke-linecap:round;stroke-linejoin:round}
.cp-stage.painting{cursor:crosshair}
`;
