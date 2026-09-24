// bEpicViewer_curveUI.js
// The parts of a curve editor that don't care what is being animated: the
// panel's skeleton (a list of curves on the left, the graph on the right, a
// draggable bar between them), and the arm drawn from a key to its tangent
// handle. Both the previz Animation Curves (bEpicViewer_previzCurves.js) and
// the Roto Curves (bEpicViewer_rotoCurves.js) are built from these, so the two
// panels look and handle alike — each keeps its own idea of what a curve is.
//
// Plain functions rather than a mixin: nothing here needs the viewer, and two
// mixins sharing method names on one prototype would silently overwrite each
// other (see CLAUDE.md).

/**
 * Build the body of a curve panel under the dock's title bar.
 *
 *   opts.listWidth   starting width of the list, in px
 *   opts.hint        the line of help under the graph
 *   opts.onListWidth (w) → remember the width the user dragged the list to
 *   opts.onResized   () → the graph's box changed: redraw
 *   opts.onBlank     (e) → a press on the graph away from any key
 *
 * Returns { body, empty, sub, list, wrap, svg }.
 */
export function buildCurvePanel(host, opts = {}) {
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

    // Left: the list. Right: the graph. The bar between them is draggable,
    // because a name like "Kitchen_set.translate.x" needs more room than "fov".
    const list = el("div", "curves-channels");
    list.style.width = `${opts.listWidth || 120}px`;
    const split = el("div", "curves-split");
    split.title = "Drag to give the names more or less room";
    split.onpointerdown = (e) => dragSplit(e, list, split, opts.onListWidth, opts.onResized);

    const right = el("div", "curves-graph-col");
    const sub = el("div", "curves-sub");
    right.append(sub);

    const wrap = el("div", "kf-graph");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "kf-graph-svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    wrap.append(svg);
    wrap.onmousedown = (e) => {
        if (e.target.closest(".kf-dot, .kf-tan")) return;
        if (opts.onBlank) opts.onBlank(e);
    };
    right.append(wrap);
    if (opts.hint) right.append(el("div", "bepic-tool-hint", opts.hint));

    body.append(list, split, right);
    host.append(empty, body);
    return { body, empty, sub, list, wrap, svg };
}

/**
 * Drag the bar between the list and the graph.
 *
 * Pointer capture rather than window listeners: a drag started here has to
 * keep receiving moves after the viewer is popped out into another document,
 * which is the same reason the dock's splitters use it.
 */
export function dragSplit(e, list, split, onWidth, onDone) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = list.getBoundingClientRect().width;
    split.classList.add("dragging");
    try { split.setPointerCapture(e.pointerId); } catch (_) {}
    const move = (ev) => {
        const w = Math.round(Math.max(54, Math.min(320, startW + (ev.clientX - startX))));
        if (onWidth) onWidth(w);
        list.style.width = `${w}px`;
    };
    const up = () => {
        split.removeEventListener("pointermove", move);
        split.removeEventListener("pointerup", up);
        split.removeEventListener("pointercancel", up);
        split.classList.remove("dragging");
        try { split.releasePointerCapture(e.pointerId); } catch (_) {}
        // The graph is measured in percentages of its box, and the box changed.
        if (onDone) onDone();
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
    split.addEventListener("pointercancel", up);
}

/** A line in the graph's SVG (0..100 on both axes), or another shape via attrs.tag. */
export function svgLine(svg, attrs) {
    const n = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", attrs.tag || "line");
    const a = { ...attrs };
    delete a.tag;
    a["vector-effect"] = "non-scaling-stroke";
    for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
    svg.append(n);
    return n;
}

/**
 * The arm from a key at (x1, y1) to its handle at (x2, y2), both in percent of
 * the graph. A rotated div rather than an SVG line: the SVG is stretched to the
 * box (preserveAspectRatio none), which would shear a line's angle.
 */
export function tangentArm(wrap, x1, y1, x2, y2, color) {
    const l = wrap.ownerDocument.createElement("div");
    l.className = "kf-tan-line";
    const rect = wrap.getBoundingClientRect();
    const dx = ((x2 - x1) / 100) * (rect.width || 1);
    const dy = ((y2 - y1) / 100) * (rect.height || 1);
    l.style.left = x1 + "%";
    l.style.top = y1 + "%";
    l.style.width = `${Math.hypot(dx, dy)}px`;
    l.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    l.style.background = color;
    wrap.append(l);
    return l;
}
