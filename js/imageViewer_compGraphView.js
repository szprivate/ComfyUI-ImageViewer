// imageViewer_compGraphView.js
// Another view of a comp's node graph (Sebastian 2026-11-23: "opening up a new Graph panel show a different
// view on the SAME graph network"). The editor (imageViewer_compEditor.js) keeps the one model, the undo and
// the selection; this is a second window onto it: its own pan/zoom, the same nodes and wires, redrawn after
// every graph render (editor.addGraphView). Moving a node here is one undo step there (editor.setNodes);
// clicking selects in both; the eye shows a node in the picture. Wiring new connections stays with the first
// graph, which has the port drags and the Tab menu.
import * as C from "./imageViewer_compModel.js";
import { CAT_COLOR } from "./imageViewer_compEditor.js";

const G = C.G;
const BD_TILE = "#5a6b80", NOTE_TILE = "#f2dc7a";
const NS = "http://www.w3.org/2000/svg";

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
};
const svgEl = (doc, tag, attrs) => {
    const n = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
};
const wirePath = (x1, y1, x2, y2) => {
    const c = C.wireCurve(x1, y1, x2, y2);
    return `M${c[0][0]},${c[0][1]} C${c[1][0]},${c[1][1]} ${c[2][0]},${c[2][1]} ${c[3][0]},${c[3][1]}`;
};

/**
 * Make a graph view in `host`, looking at `editor`'s comp. `saved` may carry its viewport {s,x,y,fitted}.
 * Returns { el, render, save, dispose }; the caller (the dock instance) attaches it to the comp tab's editor
 * and detaches when the tab changes.
 */
export function createCompGraphView(host, editor, saved) {
    const doc = host.ownerDocument;
    const st = editor.state;
    const gv = (saved && saved.view && Number.isFinite(saved.view.s))
        ? { s: saved.view.s, x: saved.view.x || 0, y: saved.view.y || 0, fitted: !!saved.view.fitted }
        : { s: 1, x: 0, y: 0, fitted: false };
    // While a node is dragged its place is drawn ahead of the model; the move lands as one undo step on release.
    let drag = null;

    host.classList.add("comp-graph-view");
    const graph = el(doc, "div", "cp-graph"); graph.tabIndex = 0;
    const world = el(doc, "div", "cp-world");
    const wires = svgEl(doc, "svg", { class: "cp-wires" });
    world.append(wires);
    const crumbs = el(doc, "div", "cp-crumbs");
    const hint = el(doc, "div", "cp-hint", "Tab or right-click: add a node · drag: pan · wheel: zoom · drag a node: move it · double-click: show it in the picture (a group: go inside) · F: frame all");
    graph.append(world, hint);
    // The bar the first graph has: Add, grid, snap, align — the editor's own menus, opened here.
    const gbar = el(doc, "div", "cp-gbar");
    const ib = (cls, icon, title, fn) => {
        const b = el(doc, "button", "mg-btn cp-ib " + cls);
        b.title = title;
        b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
        return b;
    };
    const addBtn = el(doc, "button", "mg-btn cp-add");
    addBtn.title = "Add a node (Tab)";
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg><span>Add</span>';
    addBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    addBtn.addEventListener("click", (e) => { e.stopPropagation(); editor.graphMenus.add(graph); });
    const gridBtn = ib("cp-grid-btn", '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
        "Show the grid (G)", () => editor.graphMenus.grid({ show: !editor.graphMenus.gridState().show }));
    const snapBtn = ib("cp-snap-btn", '<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>',
        "Snap nodes to the grid (S)", () => editor.graphMenus.grid({ snap: !editor.graphMenus.gridState().snap }));
    const alignBtn = ib("cp-align-btn", '<rect width="6" height="16" x="4" y="6" rx="2"/><rect width="6" height="9" x="14" y="6" rx="2"/><path d="M22 2H2"/>',
        "Align the selected nodes", (b) => editor.graphMenus.align(b));
    gbar.append(addBtn, gridBtn, snapBtn, alignBtn, crumbs);
    graph.append(gbar);
    host.append(graph);

    const gc = () => G.levelView(() => editor.comp(), st.scope);
    const node = (id) => editor.node(id);
    const fid = (id) => (id ? G.flatId(st.scope, id) : id);
    const viewedId = () => (st.view && G.flatNode(editor.comp(), st.view) ? st.view : editor.comp().output);
    const posOf = (n) => (drag && drag.ids.has(n.id) ? { x: n.x + drag.dx, y: n.y + drag.dy } : { x: n.x, y: n.y });

    function placeWorld() {
        world.style.transform = `translate(${gv.x}px, ${gv.y}px) scale(${gv.s})`;
        const g = C.GRID * gv.s, GG = g * 4;
        if (!st.grid || !st.grid.show) { graph.style.backgroundImage = ""; graph.dataset.grid = "off"; }
        else {
            const line = (c) => [`linear-gradient(${c} 1px, transparent 1px)`, `linear-gradient(90deg, ${c} 1px, transparent 1px)`];
            const minor = g >= 6;
            graph.style.backgroundImage = [...line("#ffffff1c"), ...(minor ? line("#ffffff0b") : [])].join(",");
            graph.style.backgroundSize = [`${GG}px ${GG}px`, `${GG}px ${GG}px`, ...(minor ? [`${g}px ${g}px`, `${g}px ${g}px`] : [])].join(",");
            const at = `${gv.x}px ${gv.y}px`;
            graph.style.backgroundPosition = [at, at, ...(minor ? [at, at] : [])].join(",");
            graph.dataset.grid = minor ? "cells" : "major";
        }
    }

    function frameAll() {
        const ns = gc().nodes;
        if (!ns.length) return;
        const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
        const x0 = Math.min(...xs) - 30, x1 = Math.max(...ns.map((n) => n.x + C.nodeSize(n)[0])) + 30;
        const y0 = Math.min(...ys) - 40, y1 = Math.max(...ns.map((n) => n.y + C.nodeSize(n)[1])) + 40;
        const W = graph.clientWidth || 400, H = graph.clientHeight || 300;
        const s = Math.max(0.2, Math.min(1.5, Math.min(W / (x1 - x0), H / (y1 - y0))));
        gv.s = s; gv.x = (W - (x1 - x0) * s) / 2 - x0 * s; gv.y = (H - (y1 - y0) * s) / 2 - y0 * s; gv.fitted = true;
        placeWorld();
    }

    function renderCrumbs() {
        crumbs.replaceChildren();
        crumbs.style.display = st.scope.length ? "" : "none";
        const parts = [["Comp", []], ...st.scope.map((id, i) => {
            const g = G.groupAt(editor.comp(), st.scope.slice(0, i + 1));
            return [(g && (g.name || g.id)) || id, st.scope.slice(0, i + 1)];
        })];
        parts.forEach(([label, path], i) => {
            if (i) crumbs.append(el(doc, "span", "", "›"));
            const last = i === parts.length - 1;
            const b = el(doc, "button", last ? "cp-here" : "", label);
            b.title = last ? "The graph inside this group" : "Back to this graph";
            b.addEventListener("pointerdown", (e) => e.stopPropagation());
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                if (last) return;
                st.scope = path.slice(); st.sel = []; st.graph.fitted = false; gv.fitted = false;
                editor.refresh();
            });
            crumbs.append(b);
        });
    }

    function render() {
        if (!editor.comp()) return;
        for (const n of [...world.querySelectorAll(".cp-node, .cp-backdrop, .cp-sticky")]) n.remove();
        wires.replaceChildren();
        graph.classList.toggle("in-group", st.scope.length > 0);
        renderCrumbs();
        const viewed = viewedId();
        const lv = gc();
        const area = (n) => C.nodeSize(n)[0] * C.nodeSize(n)[1];
        for (const n of lv.nodes.filter((x) => x.type === "backdrop").sort((a, b) => area(b) - area(a))) {
            const [w, h] = C.nodeSize(n), tile = n.tile || BD_TILE, p = posOf(n);
            const b = el(doc, "div", "cp-backdrop" + (st.sel.includes(n.id) ? " sel" : ""));
            b.dataset.id = n.id;
            Object.assign(b.style, { left: p.x + "px", top: p.y + "px", width: w + "px", height: h + "px", background: tile + "40", borderColor: tile });
            const head = el(doc, "div", "cp-bdhead", n.name || "Backdrop");
            head.dataset.bd = n.id; head.style.background = tile + "b0";
            b.append(head);
            world.insertBefore(b, wires);
        }
        for (const n of lv.nodes) {
            if (n.type === "backdrop") continue;
            const p = posOf(n);
            if (n.type === "sticky") {
                const [w, h] = C.nodeSize(n);
                const s = el(doc, "div", "cp-sticky" + (st.sel.includes(n.id) ? " sel" : "") + (n.text ? "" : " empty"), n.text || "Double-click to write a note");
                s.dataset.id = n.id;
                Object.assign(s.style, { left: p.x + "px", top: p.y + "px", width: w + "px", height: h + "px", background: n.tile || NOTE_TILE });
                world.append(s);
                continue;
            }
            const t = C.NODE_TYPES[n.type];
            const isDot = n.type === "dot";
            const box = el(doc, "div", "cp-node" + (st.sel.includes(n.id) ? " sel" : "") + (fid(n.id) === viewed ? " viewed" : "") + (n.disable ? " off" : "")
                + (isDot ? " cp-dot" : "") + (n.type === "group" ? " cp-group" : "") + (n.type === "group_input" || n.type === "group_output" ? " cp-gio" : ""));
            box.dataset.id = n.id;
            box.style.left = p.x + "px"; box.style.top = p.y + "px";
            box.style.background = n.tile || (t && CAT_COLOR[t.cat]) || "#ccc";
            if (isDot) box.title = n.name || "Dot";
            else box.append(el(doc, "span", "cp-nm", n.name || n.id));
            if (n.type === "group") { box.append(el(doc, "span", "cp-gbadge", "⧉")); box.title = "A group: double-click to go inside"; }
            const sub = n.type === "read" ? C.sourceName(n) : n.type === "merge" ? (n.operation || "over") : n.type === "roto" ? `${((n.roto && n.roto.layers) || []).length} shape(s)`
                : n.type === "group" ? `${(n.nodes || []).filter((x) => !G.PASSING.has(x.type) && !G.GRAPH_ONLY.has(x.type)).length} node(s)`
                    : n.type === "group_input" ? `input ${(n.index ?? 0) + 1}` : n.type === "group_output" ? "the group's picture" : "";
            if (sub && sub !== (n.name || n.id)) box.append(el(doc, "span", "cp-sub", sub));
            const ins = C.inputsOf(n);
            ins.forEach((label, i) => {
                const port = el(doc, "div", "cp-port in"); port.dataset.port = String(i); port.dataset.id = n.id;
                if (!isDot) port.style.left = C.portX(n, i) + "px";
                port.title = `${label} input`;
                box.append(port);
                if (ins.length > 1) { const l = el(doc, "span", "cp-plabel", label); l.style.left = C.portX(n, i) + "px"; box.append(l); }
            });
            if (n.type !== "output" && n.type !== "group_output") { const port = el(doc, "div", "cp-port out"); port.dataset.out = n.id; port.title = "Connect in the first Node Graph panel"; box.append(port); }
            if (!isDot && n.type !== "group_input") {
                const isViewed = fid(n.id) === viewed, isOut = fid(n.id) === editor.comp().output;
                const eye = el(doc, "span", "cp-eye", "👁");
                eye.dataset.eye = n.id;
                eye.title = isViewed ? (isOut ? "The picture shows the comp's Output" : "Shown in the picture: click to show the Output again")
                    : "Show this node in the picture";
                box.append(eye);
                if (isViewed) box.append(el(doc, "span", "cp-vtag", isOut ? "OUTPUT" : "VIEWER"));
            }
            if (n.expr && Object.keys(n.expr).length) box.append(el(doc, "span", "cp-xbadge", "="));
            world.append(box);
            n.inputs.forEach((src, i) => {
                const s = src && node(src);
                if (!s) return;
                const sp = posOf(s), np = posOf(n);
                const path = svgEl(doc, "path", { d: wirePath(...C.outXY({ ...s, x: sp.x, y: sp.y }), ...C.inXY({ ...n, x: np.x, y: np.y }, i)),
                    fill: "none", stroke: i === 2 ? "#bbb" : i === 1 && (n.type === "merge" || n.type === "copy") ? "#ffcf3a" : i === 1 ? "#8fd0ff" : "#e8e8ea", "stroke-width": 1.6,
                    "stroke-dasharray": i === 2 ? "4 3" : "" });
                path.dataset.wire = `${src}>${n.id}:${i}`;
                wires.append(path);
            });
            for (const r of C.exprRefsOf(n)) {
                const m = node(r);
                if (!m || m === n) continue;
                const mp = posOf(m), np2 = posOf(n);
                const [mw, mh] = C.nodeSize(m), [, nh] = C.nodeSize(n);
                wires.append(svgEl(doc, "path", { class: "cp-link", d: `M${mp.x + mw},${mp.y + mh / 2} L${np2.x},${np2.y + nh / 2}` }));
            }
        }
        placeWorld();
        if (!gv.fitted && graph.clientWidth) frameAll();
        const gs = editor.graphMenus.gridState();
        gridBtn.classList.toggle("on", !!(gs && gs.show));
        snapBtn.classList.toggle("on", !!(gs && gs.snap));
    }

    // ── Looking around ───────────────────────────────────────────────────────

    graph.addEventListener("wheel", (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = graph.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const k = Math.exp(-e.deltaY * 0.0015);
        const s = Math.max(0.15, Math.min(3, gv.s * k));
        const kk = s / gv.s;
        gv.x = px - (px - gv.x) * kk; gv.y = py - (py - gv.y) * kk; gv.s = s; gv.fitted = false;
        placeWorld();
    }, { passive: false });

    const gxy = (e) => {
        const r = graph.getBoundingClientRect();
        return [(e.clientX - r.left - gv.x) / gv.s, (e.clientY - r.top - gv.y) / gv.s];
    };

    graph.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        // A held: the layout gesture; Y held: the wire cut - the first graph's, drawn here. Read before the focus
        // moves here (the first graph letting go of the focus lets go of a held key).
        const held = editor.graphMenus.held();
        graph.focus({ preventScroll: true });
        editor.graphMenus.close();
        if (held === "y" && !e.altKey) { e.stopPropagation(); editor.graphMenus.cutDrag(e, graph, gxy, wires); return; }
        if (held === "a" && !e.altKey && editor.graphMenus.layoutDrag(e, graph, gxy)) { e.stopPropagation(); return; }
        const eye = e.target.closest && e.target.closest(".cp-eye");
        if (eye) { e.stopPropagation(); editor.view(eye.dataset.eye); return; }
        const box = e.target.closest && e.target.closest(".cp-node, .cp-backdrop, .cp-sticky");
        const [sx, sy] = gxy(e);
        const cx = e.clientX, cy = e.clientY;
        let moved = false;
        if (box) {
            const id = box.dataset.id;
            // Ctrl (Cmd) + drag: the node and everything upstream of it; Shift + drag: everything downstream (as in
            // the first graph). Shift or Ctrl + click without a drag adds the node to the selection or takes it out.
            const chain = (e.ctrlKey || e.metaKey) ? "up" : e.shiftKey ? "down" : null;
            const toggles = e.shiftKey || e.ctrlKey;
            if (!chain && !st.sel.includes(id)) editor.select([id]);
            const ids = new Set(st.sel.includes(id) ? st.sel : [id]);
            const lv = gc();
            if (chain) for (const x of C.chainOf(lv, [...ids].filter((i) => { const n = node(i); return n && !G.GRAPH_ONLY.has(n.type); }), chain)) ids.add(x);
            for (const i of [...ids]) { const n = node(i); if (n && n.type === "backdrop") for (const x of C.backdropHolds(lv, i)) ids.add(x); }
            drag = { ids, dx: 0, dy: 0 };
            try { graph.setPointerCapture(e.pointerId); } catch (_) { /* synthetic event */ }
            const move = (ev) => {
                const [x, y] = gxy(ev);
                if (Math.abs(ev.clientX - cx) + Math.abs(ev.clientY - cy) > 3) moved = true;
                drag.dx = x - sx; drag.dy = y - sy;
                render();
            };
            const up = () => {
                graph.removeEventListener("pointermove", move);
                graph.removeEventListener("pointerup", up);
                graph.removeEventListener("pointercancel", up);
                const d = drag; drag = null;
                if (moved && d && (d.dx || d.dy)) {
                    const patches = {};
                    for (const id of d.ids) {
                        const n = node(id);
                        if (n) patches[id] = { x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) };
                    }
                    editor.setNodes(patches);   // one undo step, and every view redraws
                } else if (chain) {
                    if (toggles) editor.select(st.sel.includes(id) ? st.sel.filter((x) => x !== id) : [...st.sel, id]);
                    else editor.select([id]);
                } else render();
            };
            graph.addEventListener("pointermove", move);
            graph.addEventListener("pointerup", up);
            graph.addEventListener("pointercancel", up);
            e.stopPropagation();
            return;
        }
        // Blank: pan.
        const ox = gv.x, oy = gv.y;
        try { graph.setPointerCapture(e.pointerId); } catch (_) { /* synthetic event */ }
        const move = (ev) => {
            if (Math.abs(ev.clientX - cx) + Math.abs(ev.clientY - cy) > 3) moved = true;
            gv.x = ox + ev.clientX - cx; gv.y = oy + ev.clientY - cy; gv.fitted = false;
            placeWorld();
        };
        const up = () => {
            graph.removeEventListener("pointermove", move);
            graph.removeEventListener("pointerup", up);
            graph.removeEventListener("pointercancel", up);
            if (!moved) editor.select([]);
        };
        graph.addEventListener("pointermove", move);
        graph.addEventListener("pointerup", up);
        graph.addEventListener("pointercancel", up);
        e.stopPropagation();
    });

    graph.addEventListener("dblclick", (e) => {
        const box = e.target.closest && e.target.closest(".cp-node");
        if (!box) return;
        e.stopPropagation();
        const n = node(box.dataset.id);
        if (!n) return;
        if (n.type === "group") {
            st.scope = [...st.scope, n.id]; st.sel = []; st.graph.fitted = false; gv.fitted = false;
            editor.refresh();
            return;
        }
        editor.select([n.id]);
        editor.view(n.id);
    });

    graph.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.button === 0 && e.ctrlKey) return;   // a Mac's Ctrl + click: the upstream drag, no menu
        editor.graphMenus.context(e, gxy, graph);
    });

    graph.addEventListener("keydown", (e) => {
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
        const k = (e.key || "").toLowerCase();
        if ((k === "a" || k === "y") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); editor.graphMenus.hold(k, e.code); return; }
        if (e.key === "f" || e.key === "F") { e.preventDefault(); e.stopPropagation(); frameAll(); return; }
        if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); editor.graphMenus.add(graph); return; }
        if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); editor.graphMenus.remove(); return; }
        if (e.key === "d" || e.key === "D") { e.preventDefault(); e.stopPropagation(); editor.graphMenus.disable(); return; }
        if (e.key === "1") { const id = editor.selection()[0]; if (id) { e.preventDefault(); e.stopPropagation(); editor.view(id); } return; }
        if (e.key === "Backspace" && (e.ctrlKey || e.metaKey) && st.scope.length) {
            e.preventDefault(); e.stopPropagation();
            st.scope = st.scope.slice(0, -1); st.sel = []; st.graph.fitted = false; gv.fitted = false;
            editor.refresh();
        }
    });

    const RO = (graph.ownerDocument.defaultView || window).ResizeObserver;
    const ro = RO ? new RO(() => { if (!gv.fitted) frameAll(); else placeWorld(); }) : null;
    if (ro) ro.observe(graph);

    editor.addGraphView(render);
    render();

    return {
        el: host,
        render,
        save() { return { view: { s: gv.s, x: gv.x, y: gv.y, fitted: gv.fitted } }; },
        dispose() {
            editor.removeGraphView(render);
            if (ro) ro.disconnect();
            host.replaceChildren();
            host.classList.remove("comp-graph-view");
        },
    };
}