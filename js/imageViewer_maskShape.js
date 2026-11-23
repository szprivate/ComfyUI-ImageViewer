// imageViewer_maskShape.js
// The one shape every mask and roto tool draws with: the viewer's Roto tool (and Comp's Roto node, which uses
// it), Paint's pen paths and the Matchmove masks. Pure arithmetic plus one small drawing helper; no state.
//
// A shape is a list of points and a kind:
//   "bezier"  - each point is an anchor the curve passes through, with a tangent handle on each side
//               (a corner when the handles sit on the anchor);
//   "bspline" - each point is a control point the curve is pulled towards but does not pass through
//               (a uniform cubic B-spline: smooth everywhere, no tangents to set).
// Both come down to the same thing, anchors with handles `{x, y, ix, iy, ox, oy}` (absolute handles; ix / iy
// the one before the anchor, ox / oy the one after), drawn as one cubic per segment. `curveAnchors` makes
// those from either kind; `flattenAnchors` makes a polyline of them. src/mask_shape.py is the same arithmetic
// for the renders (roto_raster.py, paint_math.py, matchmove.py) - keep the two identical.
//
// Written from the textbook B-spline to Bezier conversion (each segment of a uniform cubic B-spline is the
// cubic with points (P0 + 4 P1 + P2) / 6, (2 P1 + P2) / 3, (P1 + 2 P2) / 3, (P1 + 4 P2 + P3) / 6), not
// from any other program's code.

export const SHAPE_KINDS = ["bezier", "bspline"];
export const SHAPE_LABELS = { bezier: "Bezier", bspline: "B-spline" };
export const SHAPE_TIPS = {
    bezier: "Bezier: the curve goes through every point; drag while placing a point to pull out its tangents",
    bspline: "B-spline: the curve is pulled smoothly towards every point, with no tangents to set",
};

/** "bezier" | "bspline" (anything else is "bezier"). */
export function shapeKind(v) { return v === "bspline" ? "bspline" : "bezier"; }

const fin = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** An anchor with no tangents. */
export function corner(x, y) { return { x, y, ix: x, iy: y, ox: x, oy: y }; }

/** Whether an anchor has a tangent on either side. */
export function hasHandles(a) { return a.ix !== a.x || a.iy !== a.y || a.ox !== a.x || a.oy !== a.y; }

/** The handles of a smooth anchor pulled out to (hx, hy): the out handle there, the in handle mirrored. */
export function mirrorHandles(a, hx, hy) { return { ...a, ox: hx, oy: hy, ix: 2 * a.x - hx, iy: 2 * a.y - hy }; }

/**
 * The anchors of a uniform cubic B-spline through control points [{x, y}]: one anchor per control point, at
 * (P[i-1] + 4 P[i] + P[i+1]) / 6, its out handle at (2 P[i] + P[i+1]) / 3 and its in handle at (P[i-1] + 2 P[i]) / 3.
 * An open spline is clamped by a mirrored point past each end (P[-1] = 2 P[0] - P[1]), so it starts on its first
 * control point and ends on its last.
 */
export function bsplineAnchors(ctrl, closed) {
    const n = ctrl.length;
    if (n < 3 && closed) closed = false;
    if (n < 2) return ctrl.map((p) => corner(p.x, p.y));
    const P = (i) => {
        if (closed) return ctrl[((i % n) + n) % n];
        if (i < 0) return { x: 2 * ctrl[0].x - ctrl[1].x, y: 2 * ctrl[0].y - ctrl[1].y };
        if (i >= n) return { x: 2 * ctrl[n - 1].x - ctrl[n - 2].x, y: 2 * ctrl[n - 1].y - ctrl[n - 2].y };
        return ctrl[i];
    };
    const out = [];
    for (let i = 0; i < n; i++) {
        const a = P(i - 1), b = P(i), c = P(i + 1);
        out.push({
            x: (a.x + 4 * b.x + c.x) / 6, y: (a.y + 4 * b.y + c.y) / 6,
            ix: (a.x + 2 * b.x) / 3, iy: (a.y + 2 * b.y) / 3,
            ox: (2 * b.x + c.x) / 3, oy: (2 * b.y + c.y) / 3,
        });
    }
    return out;
}

/** The anchors the curve is drawn with: a Bezier shape's own points, a B-spline's from its control points. */
export function curveAnchors(pts, kind, closed) {
    if (shapeKind(kind) === "bspline") return bsplineAnchors(pts, closed);
    return pts.map((a) => ({ x: a.x, y: a.y, ix: fin(a.ix, a.x), iy: fin(a.iy, a.y), ox: fin(a.ox, a.x), oy: fin(a.oy, a.y) }));
}

/** How many straight pieces a segment is drawn with: about one per 3 units of its control polygon, 1 when straight. */
export function segmentSteps(a, b) {
    if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) return 1;
    const len = Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - a.ox, b.iy - a.oy) + Math.hypot(b.x - b.ix, b.y - b.iy);
    return Math.max(1, Math.min(128, Math.ceil(len / 3)));
}

export function bezierAt(a, b, t) {
    const u = 1 - t, A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, E = t * t * t;
    return [A * a.x + B * a.ox + C * b.ix + E * b.x, A * a.y + B * a.oy + C * b.iy + E * b.y];
}

/**
 * The anchors as a polyline [[x, y], ...]; a closed one's last segment back to the first anchor included (not
 * repeating it). `scale` multiplies the step count's measure, for shapes in units far from pixels (a roto shape
 * in shares of the picture passes the picture's size).
 */
export function flattenAnchors(anch, closed, scale = 1) {
    const out = [];
    if (!anch.length) return out;
    out.push([anch[0].x, anch[0].y]);
    const segs = closed ? anch.length : anch.length - 1;
    for (let i = 0; i < segs; i++) {
        const a = anch[i], b = anch[(i + 1) % anch.length];
        const n = scale === 1 ? segmentSteps(a, b) : segmentSteps(scaled(a, scale), scaled(b, scale));
        for (let k = 1; k <= n; k++) {
            if (closed && i === segs - 1 && k === n) break;
            out.push(k === n ? [b.x, b.y] : bezierAt(a, b, k / n));
        }
    }
    return out;
}
const scaled = (a, s) => ({ x: a.x * s, y: a.y * s, ix: a.ix * s, iy: a.iy * s, ox: a.ox * s, oy: a.oy * s });

/** A shape's polyline: `curveAnchors` then `flattenAnchors`. */
export function shapePolygon(pts, kind, closed, scale = 1) {
    return flattenAnchors(curveAnchors(pts, kind, closed), closed, scale);
}

/**
 * The curve as SVG path data (Path2D reads it too, so a canvas and an SVG overlay draw it the same way);
 * `S(x, y)` -> [sx, sy] puts a point on the screen.
 */
export function curveD(anch, closed, S) {
    if (!anch.length) return "";
    const f = (v) => (Math.round(v * 100) / 100);
    const p0 = S(anch[0].x, anch[0].y);
    let d = `M ${f(p0[0])} ${f(p0[1])}`;
    const segs = closed && anch.length > 2 ? anch.length : anch.length - 1;
    for (let i = 0; i < segs; i++) {
        const a = anch[i], b = anch[(i + 1) % anch.length];
        const q = S(b.x, b.y);
        if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) { d += ` L ${f(q[0])} ${f(q[1])}`; continue; }
        const c0 = S(a.ox, a.oy), c1 = S(b.ix, b.iy);
        d += ` C ${f(c0[0])} ${f(c0[1])} ${f(c1[0])} ${f(c1[1])} ${f(q[0])} ${f(q[1])}`;
    }
    if (closed && anch.length > 2) d += " Z";
    return d;
}

// ── point forms ───────────────────────────────────────────────────────────────
// Each tool keeps its points in its own form (saved files read as before); these turn them into anchors and back.

/** Roto's point {x, y, cin?, cout?} -> an anchor. */
export function fromRoto(p) {
    return { x: +p.x, y: +p.y, ix: p.cin ? +p.cin.x : +p.x, iy: p.cin ? +p.cin.y : +p.y, ox: p.cout ? +p.cout.x : +p.x, oy: p.cout ? +p.cout.y : +p.y };
}
/** An anchor -> roto's point form (no cin / cout when the anchor has none). */
export function toRoto(a) {
    const o = { x: a.x, y: a.y };
    if (a.ix !== a.x || a.iy !== a.y || a.ox !== a.x || a.oy !== a.y) { o.cin = { x: a.ix, y: a.iy }; o.cout = { x: a.ox, y: a.oy }; }
    return o;
}
/** A Matchmove mask's point [x, y] or [x, y, ix, iy, ox, oy] -> an anchor. */
export function fromArr(p) {
    const x = +p[0], y = +p[1];
    return p.length >= 6 ? { x, y, ix: +p[2], iy: +p[3], ox: +p[4], oy: +p[5] } : corner(x, y);
}
/** An anchor -> [x, y] (a corner) or [x, y, ix, iy, ox, oy]. */
export function toArr(a) { return hasHandles(a) ? [a.x, a.y, a.ix, a.iy, a.ox, a.oy] : [a.x, a.y]; }

/**
 * A shape's anchors when its kind changes: Bezier -> B-spline keeps the points as control points (the tangents
 * go; the curve gets smoother); B-spline -> Bezier puts anchors with tangents where the B-spline's curve is,
 * so it looks exactly the same.
 */
export function convertShape(anch, from, to, closed) {
    from = shapeKind(from); to = shapeKind(to);
    if (from === to) return anch.map((a) => ({ ...a }));
    if (to === "bspline") return anch.map((a) => corner(a.x, a.y));
    return bsplineAnchors(anch, closed);
}

// ── the kind new shapes start as ─────────────────────────────────────────────
// One choice for every tool: picked in one, it is what the others start with too.

export const SHAPE_PREF_KEY = "imageviewer.viewer.maskShape";
export function preferredShape() {
    try { return shapeKind(globalThis.localStorage && globalThis.localStorage.getItem(SHAPE_PREF_KEY)); } catch { return "bezier"; }
}
export function setPreferredShape(kind) {
    try { globalThis.localStorage && globalThis.localStorage.setItem(SHAPE_PREF_KEY, shapeKind(kind)); } catch { /* private window */ }
}

// ── the guide drawn while a shape is drawn or edited ─────────────────────────
// The same look in every tool: tangents as blue lines with a dot at the end, a B-spline's control polygon
// dashed. `target` is a canvas 2D context or an SVG element; points are on the screen already.

export const GUIDE_COLOR = "#6cf";

/**
 * Draw `guide` = { handles: [[ax, ay, hx, hy], ...], polygon: [[x, y], ...], closed, preview: [[x, y], ...] }
 * (any part may be left out). `preview` is the curve from the last point to the pointer, dashed.
 */
export function drawGuide(target, guide) {
    if (!target || !guide) return;
    const isCanvas = typeof target.beginPath === "function";
    const poly = guide.polygon && guide.polygon.length > 1 ? guide.polygon : null;
    const prev = guide.preview && guide.preview.length > 1 ? guide.preview : null;
    const handles = guide.handles || [];
    if (isCanvas) {
        const g = target;
        g.save();
        g.lineWidth = 1;
        if (poly) {
            g.strokeStyle = "rgba(102,204,255,0.75)";
            g.setLineDash([4, 3]);
            g.beginPath();
            poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
            if (guide.closed && poly.length > 2) g.closePath();
            g.stroke();
        }
        if (prev) {
            g.strokeStyle = "rgba(255,255,255,0.6)";
            g.setLineDash([3, 3]);
            g.beginPath();
            prev.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
            g.stroke();
        }
        g.setLineDash([]);
        for (const [ax, ay, hx, hy] of handles) {
            g.strokeStyle = GUIDE_COLOR;
            g.beginPath(); g.moveTo(ax, ay); g.lineTo(hx, hy); g.stroke();
            g.fillStyle = GUIDE_COLOR; g.strokeStyle = "#000";
            g.beginPath(); g.arc(hx, hy, 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
        }
        g.restore();
        return;
    }
    const doc = target.ownerDocument;
    const mk = (tag, attrs) => {
        const e = doc.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        target.appendChild(e);
        return e;
    };
    const pts = (list) => list.map(([x, y]) => `${x},${y}`).join(" ");
    if (poly) mk(guide.closed && poly.length > 2 ? "polygon" : "polyline", { points: pts(poly), fill: "none", stroke: "rgba(102,204,255,0.75)", "stroke-width": 1, "stroke-dasharray": "4 3", class: "mask-guide-polygon" });
    if (prev) mk("polyline", { points: pts(prev), fill: "none", stroke: "rgba(255,255,255,0.6)", "stroke-width": 1, "stroke-dasharray": "3 3", class: "mask-guide-preview" });
    for (const [ax, ay, hx, hy] of handles) {
        mk("line", { x1: ax, y1: ay, x2: hx, y2: hy, stroke: GUIDE_COLOR, "stroke-width": 1, class: "mask-guide-tangent" });
        mk("circle", { cx: hx, cy: hy, r: 3.5, fill: GUIDE_COLOR, stroke: "#000", "stroke-width": 1, class: "mask-guide-handle" });
    }
}

/** The tangents of anchors `idx` (screen anchors), skipping a side that sits on its anchor: the guide's `handles`. */
export function handleLines(anch, idx) {
    const out = [];
    for (const i of idx) {
        const a = anch[i];
        if (!a) continue;
        if (a.ix !== a.x || a.iy !== a.y) out.push([a.x, a.y, a.ix, a.iy]);
        if (a.ox !== a.x || a.oy !== a.y) out.push([a.x, a.y, a.ox, a.oy]);
    }
    return out;
}

/**
 * The Bezier / B-spline switch every tool shows (the same two buttons), as DOM in `doc`. `onChange(kind)` runs
 * when one is pressed; the switch also remembers the kind for new shapes everywhere (setPreferredShape).
 */
export function shapeSwitch(doc, value, onChange, { label = "Shape" } = {}) {
    const wrap = doc.createElement("div");
    wrap.className = "mask-shape-switch";
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
    if (label) {
        const l = doc.createElement("span");
        l.textContent = label;
        l.style.cssText = "opacity:.75;font-size:11px;";
        wrap.appendChild(l);
    }
    const seg = doc.createElement("div");
    seg.style.cssText = "display:inline-flex;border:1px solid rgba(255,255,255,.18);border-radius:4px;overflow:hidden;";
    wrap.appendChild(seg);
    const btns = {};
    const paint = (v) => {
        for (const k of SHAPE_KINDS) {
            const on = k === v;
            btns[k].setAttribute("aria-pressed", on ? "true" : "false");
            btns[k].style.background = on ? "#2b6a87" : "transparent";
            btns[k].style.color = on ? "#fff" : "rgba(225,232,238,.8)";
        }
    };
    for (const k of SHAPE_KINDS) {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = SHAPE_LABELS[k];
        b.title = SHAPE_TIPS[k];
        b.dataset.shape = k;
        b.className = "mask-shape-btn";
        b.style.cssText = "border:0;padding:2px 8px;font:inherit;font-size:11px;cursor:pointer;";
        b.addEventListener("click", (e) => { e.stopPropagation(); setPreferredShape(k); paint(k); onChange(k); });
        btns[k] = b;
        seg.appendChild(b);
    }
    paint(shapeKind(value));
    wrap.setShape = (v) => paint(shapeKind(v));
    return wrap;
}

/**
 * Whether this press is the second of a double-click: counted here (time and place of the press before,
 * kept on `memo`), because a pointerdown's `detail` is 0 in Chrome. `x`, `y` are screen pixels.
 */
export function isDoubleClick(memo, e, x, y, ms = 450, px = 6) {
    const t = (e && e.timeStamp) || Date.now();
    const last = memo._dbl;
    const dbl = !!(last && t - last.t <= ms && Math.hypot(x - last.x, y - last.y) <= px);
    memo._dbl = dbl ? null : { t, x, y };
    return dbl || !!(e && e.detail >= 2 && e.type !== "pointerdown");
}

/** The drawing rules every mask and roto tool follows (for their help texts). */
export const DRAW_RULES =
    "Click to place a point; drag while placing it to pull out its tangents (Bezier). " +
    "Click the first point, double-click or press Enter to close the shape; Backspace takes the last point back, Esc drops the shape. " +
    "Alt+click an edge to add a point, right-click a point to take it away.";
