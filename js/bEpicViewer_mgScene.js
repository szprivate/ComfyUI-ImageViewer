// mgscene.js - the motion-graphics scene model: the one piece of code the render
// (Remotion) and the bEpic viewer's editor share, so a preview is the render.
//
// Plain ES module, no dependencies, no DOM: it runs in node, in the browser and
// inside Remotion's webpack. CANONICAL COPY: agentY-core
// (agenty_core/motion_graphics/renderer/src/mgscene.js). The viewer
// (ComfyUI-ImageViewer/js/bEpicViewer_mgScene.js) carries a byte-identical copy;
// both repos run the same golden vectors (tests/golden.json) against it, and the
// viewer's test compares the two files when the sibling checkout is there.
//
// THE FORMAT (*.mgscene.json, "mgscene": 1)
//   comp    { width, height, fps, duration (frames), background (css colour | null) }
//   assets  { id: {type:"image"|"video"|"font", src, width?, height?, family?, weight?} }
//   layers  [] in PAINTER'S ORDER: the first is the bottom, the last is on top
//           (the editor lists them top first, as After Effects does).
//
// A layer is flat, like a previz item: STATIC values sit on the layer, animated
// ones in `tracks`:
//   { id, name, type, parent, in, out, hidden, locked, blend,
//     anchor, position, scale, rotation, opacity, ...type fields..., tracks }
//   tracks  { prop: [ {f, v, ease, ti, to} ] }  f = COMP frame, v the value.
//   ease    how the segment AFTER the key goes: "linear" | "smooth" (default,
//           flat at both ends) | "hold" | "easeIn" | "easeOut" | "easeInOut" |
//           "backOut" | "expoOut" | [x1,y1,x2,y2] (a css cubic-bezier).
//   ti/to   hand-set tangents (value units per frame, same shape as v) - the
//           previz curve editor's model; when present the segment is the Hermite
//           they describe.
//
// TRANSFORM  M = T(position) . R(rotation) . S(scale/100) . T(-anchor), and a
// child's world matrix is parent.M * its own - parenting passes the transform on,
// NOT the opacity (After Effects / Lottie). `anchor` is a point in the layer's
// own space: the one that lands on `position` and that rotation and scale turn
// about. Shapes, images, videos and components are centred on their own origin;
// text sits on its origin with `align` deciding which side of it the text goes.
//
// The SVG a layer draws is built here as a string (layerSvg), so the preview and
// the render are the same markup in the same engine.

export const SCENE_VERSION = 1;
export const LAYER_TYPES = ["text", "shape", "image", "video", "group", "component"];
export const SHAPES = ["rect", "ellipse", "path"];
export const ALIGNS = ["left", "center", "right"];
export const FITS = ["contain", "cover", "fill"];
export const REVEAL_DIRS = ["right", "left", "down", "up"];
export const EASES = ["linear", "smooth", "hold", "easeIn", "easeOut", "easeInOut", "backOut", "expoOut"];
export const BLENDS = {
    normal: "normal", multiply: "multiply", screen: "screen", overlay: "overlay",
    add: "plus-lighter", darken: "darken", lighten: "lighten", "color-dodge": "color-dodge",
    difference: "difference",
};
const BEZIERS = {
    easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1],
    backOut: [0.34, 1.56, 0.64, 1], expoOut: [0.16, 1, 0.3, 1],
};

// kind: num | vec2 | color. `def` is the value of a layer that states none; null
// means "none" (no fill, no stroke).
export const PROPS = {
    anchor: { kind: "vec2", def: [0, 0] },
    position: { kind: "vec2", def: [0, 0] },
    scale: { kind: "vec2", def: [100, 100] },
    rotation: { kind: "num", def: 0 },
    opacity: { kind: "num", def: 100, min: 0, max: 100 },
    fill: { kind: "color", def: "#ffffff" },
    stroke: { kind: "color", def: null },
    strokeWidth: { kind: "num", def: 0, min: 0 },
    size: { kind: "vec2", def: [100, 100] },
    radius: { kind: "num", def: 0, min: 0 },
    fontSize: { kind: "num", def: 48, min: 1 },
    tracking: { kind: "num", def: 0 },
    reveal: { kind: "num", def: 1, min: 0, max: 1 },
    trimStart: { kind: "num", def: 0, min: 0, max: 1 },
    trimEnd: { kind: "num", def: 1, min: 0, max: 1 },
};
const TRANSFORM = ["anchor", "position", "scale", "rotation", "opacity"];
export const PROPS_BY_TYPE = {
    text: [...TRANSFORM, "fill", "stroke", "strokeWidth", "fontSize", "tracking", "reveal"],
    shape: [...TRANSFORM, "fill", "stroke", "strokeWidth", "size", "radius", "reveal", "trimStart", "trimEnd"],
    image: [...TRANSFORM, "size", "radius", "reveal"],
    video: [...TRANSFORM, "size", "radius", "reveal"],
    group: [...TRANSFORM],
    component: [...TRANSFORM, "size"],
};
export const ALL_PROPS = Object.keys(PROPS);
export const FONT_STACK = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clone = (v) => (Array.isArray(v) ? v.slice() : v);

// -- colours -------------------------------------------------------------------

/** "#rgb" / "#rrggbb" / "#rrggbbaa" / "rgb()" / "rgba()" -> [r,g,b,a] (a 0..1), or null. */
export function parseColor(s) {
    if (typeof s !== "string") return null;
    const t = s.trim().toLowerCase();
    if (t === "transparent") return [0, 0, 0, 0];
    let m = /^#([0-9a-f]{3})$/.exec(t);
    if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t);
    if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
}

/** [r,g,b,a] -> "#rrggbb" (alpha 1) or "rgba(r,g,b,a)". */
export function formatColor(c) {
    const q = (x) => Math.max(0, Math.min(255, Math.round(x)));
    const a = Math.max(0, Math.min(1, c[3] === undefined ? 1 : c[3]));
    if (a >= 0.9995) return "#" + [q(c[0]), q(c[1]), q(c[2])].map((v) => v.toString(16).padStart(2, "0")).join("");
    return `rgba(${q(c[0])},${q(c[1])},${q(c[2])},${+a.toFixed(4)})`;
}

// -- keyframes -----------------------------------------------------------------

/** Keyframes of one property, sorted. Never null. */
export function track(layer, prop) {
    const t = layer && layer.tracks && layer.tracks[prop];
    return Array.isArray(t) ? t : [];
}

function cubicBezierY(x1, y1, x2, y2, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
    const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
    const dbx = (t) => 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
    let t = x;
    for (let i = 0; i < 8; i++) {                       // Newton
        const e = bx(t) - x;
        if (Math.abs(e) < 1e-7) return by(t);
        const d = dbx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
    }
    let lo = 0, hi = 1;                                  // bisection fallback
    t = x;
    for (let i = 0; i < 40; i++) {
        const e = bx(t) - x;
        if (Math.abs(e) < 1e-7) break;
        if (e > 0) hi = t; else lo = t;
        t = (lo + hi) / 2;
    }
    return by(t);
}

/** The eased progress 0..1 of a bezier-named ease at linear progress t, or null when the ease is not one. */
export function bezierProgress(ease, t) {
    const b = Array.isArray(ease) ? ease : BEZIERS[ease];
    if (!b || b.length !== 4) return null;
    return cubicBezierY(b[0], b[1], b[2], b[3], t);
}

function hermite(p0, p1, m0, m1, t, span) {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * span * m0
         + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * span * m1;
}

function autoSlope(ease, from, to, span) {
    return ease === "linear" && span > 0 ? (to - from) / span : 0;
}

const comp = (value, axis) => (Array.isArray(value) ? value[axis] : value);

/** Slope a key has on one side, hand-set or implied by its ease (what a curve editor draws handles from). */
export function tangentAt(layer, prop, frame, axis = 0, side = "out") {
    const keys = track(layer, prop);
    const i = keys.findIndex((k) => k.f === frame);
    if (i < 0) return 0;
    const own = side === "in" ? keys[i].ti : keys[i].to;
    if (own !== undefined) return comp(own, axis);
    const other = side === "in" ? keys[i - 1] : keys[i + 1];
    if (!other) return 0;
    const [from, to] = side === "in" ? [other, keys[i]] : [keys[i], other];
    return autoSlope(from.ease, comp(from.v, axis), comp(to.v, axis), to.f - from.f);
}

function toVec(kind, v) {
    if (kind === "color") return parseColor(v) || [0, 0, 0, 1];
    return v;
}

function fromVec(kind, v) {
    if (kind === "color") return formatColor(v);
    return v;
}

function interpolate(kind, a, b, frame) {
    const span = b.f - a.f;
    if (a.ease === "hold" || span <= 0) return clone(a.v);
    const t = (frame - a.f) / span;
    const va = toVec(kind, a.v), vb = toVec(kind, b.v);
    const hasTan = a.to !== undefined || b.ti !== undefined;
    const bez = hasTan ? null : bezierProgress(a.ease, t);
    const each = (axis) => {
        const p0 = comp(va, axis), p1 = comp(vb, axis);
        if (hasTan || a.ease === "smooth" || a.ease === undefined) {
            const m0 = a.to !== undefined ? comp(a.to, axis) : autoSlope(a.ease, p0, p1, span);
            const m1 = b.ti !== undefined ? comp(b.ti, axis) : autoSlope(a.ease, p0, p1, span);
            return hermite(p0, p1, m0, m1, t, span);
        }
        if (bez !== null) return p0 + (p1 - p0) * bez;
        return p0 + (p1 - p0) * t;                         // linear
    };
    const out = Array.isArray(va) ? va.map((_, axis) => each(axis)) : each(0);
    return fromVec(kind, out);
}

/** The value of one property at `frame`: its keys, else its static value, else the default (null = none). */
export function valueAt(layer, prop, frame) {
    const def = PROPS[prop];
    const keys = track(layer, prop);
    if (keys.length === 0) {
        const own = layer ? layer[prop] : undefined;
        if (own !== undefined) return clone(own);
        return def ? clone(def.def) : undefined;
    }
    if (frame <= keys[0].f) return clone(keys[0].v);
    const last = keys[keys.length - 1];
    if (frame >= last.f) return clone(last.v);
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].f <= frame) i++;
    return interpolate(def ? def.kind : "num", keys[i], keys[i + 1], frame);
}

function clampProp(prop, v) {
    const d = PROPS[prop];
    if (!d || d.kind !== "num" || !isNum(v)) return v;
    if (d.min !== undefined && v < d.min) v = d.min;
    if (d.max !== undefined && v > d.max) v = d.max;
    return v;
}

// -- 2D matrices: [a,b,c,d,e,f], the SVG convention (x' = ax + cy + e, y' = bx + dy + f) ----

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function matMul(m, n) {
    return [
        m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

export function matApply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function matInvert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) return null;
    const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** T(position) . R . S . T(-anchor) */
export function localMatrix(position, rotation, scale, anchor) {
    const r = (rotation * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    const sx = scale[0] / 100, sy = scale[1] / 100;
    const rs = [cs * sx, sn * sx, -sn * sy, cs * sy, 0, 0];
    const m = matMul([1, 0, 0, 1, position[0], position[1]], rs);
    return matMul(m, [1, 0, 0, 1, -anchor[0], -anchor[1]]);
}

export function matrixCss(m) {
    return `matrix(${m.map((x) => +x.toFixed(6)).join(",")})`;
}

// -- evaluating a scene ----------------------------------------------------------

export function layerById(scene, id) {
    return ((scene && scene.layers) || []).find((l) => l.id === id) || null;
}

/** Is the layer on screen at `frame`: not hidden, and inside [in, out). */
export function isActive(scene, layer, frame) {
    if (!layer || layer.hidden) return false;
    const dur = (scene && scene.comp && scene.comp.duration) || Infinity;
    const a = isNum(layer.in) ? layer.in : 0;
    const b = isNum(layer.out) ? layer.out : dur;
    return frame >= a && frame < b;
}

function assetSize(scene, layer) {
    const a = layer.asset && scene.assets && scene.assets[layer.asset];
    if (a && isNum(a.width) && isNum(a.height)) return [a.width, a.height];
    return null;
}

/** Every property of a layer at `frame`, defaults filled in. */
export function evaluateLayer(scene, layer, frame) {
    const out = {};
    for (const prop of PROPS_BY_TYPE[layer.type] || TRANSFORM) {
        let v = valueAt(layer, prop, frame);
        if (prop === "size" && track(layer, "size").length === 0 && layer.size === undefined) {
            v = assetSize(scene, layer) || (layer.type === "component" || layer.type === "image" || layer.type === "video"
                ? [scene.comp.width, scene.comp.height] : v);
        }
        if (prop === "fill" && layer.type === "text" && track(layer, "fill").length === 0 && layer.fill === undefined) v = "#ffffff";
        out[prop] = clampProp(prop, v);
    }
    return out;
}

/**
 * The scene at `frame`: one entry per layer in painter's order.
 *   { layer, id, type, active, props, world: matrix, opacity: 0..1 }
 * `world` is computed for hidden/out-of-range layers too (they can still be parents).
 */
export function evaluateScene(scene, frame) {
    const byId = new Map();
    for (const l of scene.layers || []) byId.set(l.id, l);
    const local = new Map();
    const worldOf = (layer, depth = 0) => {
        if (local.has(layer.id)) return local.get(layer.id).world;
        const props = evaluateLayer(scene, layer, frame);
        let world = localMatrix(props.position, props.rotation, props.scale, props.anchor);
        const parent = layer.parent && byId.get(layer.parent);
        if (parent && parent !== layer && depth < 64) world = matMul(worldOf(parent, depth + 1), world);
        local.set(layer.id, { props, world });
        return world;
    };
    return (scene.layers || []).map((layer) => {
        worldOf(layer);
        const { props, world } = local.get(layer.id);
        return {
            layer, id: layer.id, type: layer.type, active: isActive(scene, layer, frame),
            props, world, opacity: Math.max(0, Math.min(1, (props.opacity ?? 100) / 100)),
        };
    });
}

/** Frames where any layer has a key, sorted. */
export function sceneKeyframes(scene) {
    const out = new Set();
    for (const l of scene.layers || []) for (const t of Object.values(l.tracks || {})) for (const k of t) out.add(k.f);
    return [...out].sort((a, b) => a - b);
}

// -- boxes (for the editor's gizmo and hit-testing) -------------------------------

function textLines(layer) {
    const s = typeof layer.text === "string" ? layer.text : "";
    return s.split("\n");
}

/**
 * The layer's box in its own space as [x, y, w, h], or null for a group. A text
 * box is an estimate (glyph widths are the browser's); the editor measures the real
 * one with getBBox() when it can.
 */
export function localBox(res) {
    const p = res.props;
    if (res.type === "text") {
        const lines = textLines(res.layer);
        const fs = p.fontSize, lh = fs * (isNum(res.layer.lineHeight) ? res.layer.lineHeight : 1.15);
        const chars = Math.max(1, ...lines.map((l) => l.length));
        const w = chars * fs * 0.56 + Math.max(0, chars - 1) * (p.tracking || 0);
        const h = lh * lines.length;
        const align = res.layer.align || "left";
        const x = align === "center" ? -w / 2 : align === "right" ? -w : 0;
        return [x, -h / 2, w, h];
    }
    if (res.type === "group") return null;
    const [w, h] = p.size || [100, 100];
    return [-w / 2, -h / 2, w, h];
}

// -- drawing: the SVG a layer is -----------------------------------------------------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (x) => +(+x).toFixed(4);
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");

/** @font-face rules for the scene's font assets. `url(asset)` turns an asset into a loadable url. */
export function fontFaceCss(scene, url) {
    const out = [];
    for (const [id, a] of Object.entries(scene.assets || {})) {
        if (!a || a.type !== "font") continue;
        out.push(`@font-face{font-family:"${a.family || id}";src:url("${url(id, a)}");font-weight:${a.weight || 400};font-style:${a.style || "normal"};}`);
    }
    return out.join("\n");
}

function fontFamily(scene, layer) {
    const f = layer.font;
    if (!f) return FONT_STACK;
    const a = scene.assets && scene.assets[f];
    const fam = a && a.type === "font" ? (a.family || f) : f;
    return `"${String(fam).replace(/"/g, "")}", ${FONT_STACK}`;
}

export function blendCss(layer) {
    return BLENDS[layer.blend] || "normal";
}

function paintAttrs(p, withFill = true) {
    let s = "";
    if (withFill) s += ` fill="${p.fill ? esc(p.fill) : "none"}"`;
    if (p.stroke && p.strokeWidth > 0) {
        s += ` stroke="${esc(p.stroke)}" stroke-width="${num(p.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round"`;
    }
    return s;
}

function trimAttrs(p) {
    const a = Math.max(0, Math.min(1, p.trimStart ?? 0)), b = Math.max(0, Math.min(1, p.trimEnd ?? 1));
    if (a <= 0 && b >= 1) return "";
    const len = Math.max(0, b - a);
    return ` pathLength="1" stroke-dasharray="${num(len)} ${num(2 - len)}" stroke-dashoffset="${num(-a)}"`;
}

/** The inner SVG (no transform) of a layer, or "" for those drawn as HTML (video, component) or not at all. */
function layerBody(scene, res, ctx) {
    const { layer, props: p } = res;
    if (res.type === "text") {
        const lines = textLines(layer);
        const fs = p.fontSize, lh = fs * (isNum(layer.lineHeight) ? layer.lineHeight : 1.15);
        const anchor = { left: "start", center: "middle", right: "end" }[layer.align || "left"] || "start";
        const y0 = -((lines.length - 1) * lh) / 2;
        const tspans = lines.map((ln, i) =>
            `<tspan x="0" y="${num(y0 + i * lh)}">${esc(ln) || "&#160;"}</tspan>`).join("");
        return `<text font-family="${esc(fontFamily(scene, layer))}" font-size="${num(fs)}" font-weight="${layer.weight || 400}"`
            + `${layer.italic ? ' font-style="italic"' : ""} letter-spacing="${num(p.tracking || 0)}" text-anchor="${anchor}"`
            + ` dominant-baseline="central" xml:space="preserve"${paintAttrs(p)}>${tspans}</text>`;
    }
    if (res.type === "shape") {
        const [w, h] = p.size;
        const trim = trimAttrs(p);
        const kind = layer.shape || "rect";
        if (kind === "ellipse") {
            return `<ellipse cx="0" cy="0" rx="${num(w / 2)}" ry="${num(h / 2)}"${paintAttrs(p)}${trim}/>`;
        }
        if (kind === "path") {
            return `<path d="${esc(layer.d || "")}"${paintAttrs(p)}${trim}/>`;
        }
        const r = Math.min(p.radius || 0, Math.min(w, h) / 2);
        return `<rect x="${num(-w / 2)}" y="${num(-h / 2)}" width="${num(w)}" height="${num(h)}"`
            + `${r > 0 ? ` rx="${num(r)}"` : ""}${paintAttrs(p)}${trim}/>`;
    }
    if (res.type === "image") {
        const a = scene.assets && scene.assets[layer.asset];
        const href = a && ctx.assetUrl ? ctx.assetUrl(layer.asset, a) : "";
        if (!href) return "";
        const [w, h] = p.size;
        const par = { contain: "xMidYMid meet", cover: "xMidYMid slice", fill: "none" }[layer.fit || "contain"] || "xMidYMid meet";
        const r = p.radius || 0;
        const clip = r > 0
            ? `<clipPath id="mgr_${safeId(layer.id)}"><rect x="${num(-w / 2)}" y="${num(-h / 2)}" width="${num(w)}" height="${num(h)}" rx="${num(r)}"/></clipPath>`
            : "";
        return `${clip}<image href="${esc(href)}" x="${num(-w / 2)}" y="${num(-h / 2)}" width="${num(w)}" height="${num(h)}"`
            + ` preserveAspectRatio="${par}"${r > 0 ? ` clip-path="url(#mgr_${safeId(layer.id)})"` : ""}/>`;
    }
    return "";
}

/** True when a layer is drawn as an SVG (text, shape, image); video and component are HTML, group is nothing. */
export function isSvgLayer(type) {
    return type === "text" || type === "shape" || type === "image";
}

/** Style for a layer drawn as an HTML box (video, component): sized, centred on its origin, transformed. */
export function htmlLayerStyle(res) {
    const [w, h] = res.props.size || [100, 100];
    const style = {
        position: "absolute", left: 0, top: 0, width: w, height: h,
        transformOrigin: "0 0", transform: `${matrixCss(res.world)} translate(${num(-w / 2)}px, ${num(-h / 2)}px)`,
        opacity: res.opacity, mixBlendMode: blendCss(res.layer),
    };
    const r = res.props.radius || 0;
    if (r > 0) style.borderRadius = r;
    if (res.props.reveal !== undefined && res.props.reveal < 1) {
        const rv = Math.max(0, res.props.reveal), dir = res.layer.revealDir || "right";
        style.clipPath = dir === "right" ? `inset(0 ${num((1 - rv) * 100)}% 0 0)`
            : dir === "left" ? `inset(0 0 0 ${num((1 - rv) * 100)}%)`
            : dir === "down" ? `inset(0 0 ${num((1 - rv) * 100)}% 0)` : `inset(${num((1 - rv) * 100)}% 0 0 0)`;
    }
    return style;
}

/**
 * The full-canvas <svg> markup of one layer at one frame ("" when there is nothing
 * to draw: inactive, a group, or not an SVG layer). Elements are absolutely
 * positioned over one another; the caller stacks them in painter's order.
 *   ctx: { width, height, assetUrl(id, asset) -> url }
 */
export function layerSvg(scene, res, ctx) {
    if (!res.active || !isSvgLayer(res.type) || res.opacity <= 0) return "";
    const body = layerBody(scene, res, ctx);
    if (!body) return "";
    let inner = body, defs = "";
    const rv = res.props.reveal;
    if (rv !== undefined && rv < 1) {
        const r = Math.max(0, rv), dir = res.layer.revealDir || "right";
        const rect = dir === "right" ? `x="0" y="0" width="${num(r)}" height="1"`
            : dir === "left" ? `x="${num(1 - r)}" y="0" width="${num(r)}" height="1"`
            : dir === "down" ? `x="0" y="0" width="1" height="${num(r)}"` : `x="0" y="${num(1 - r)}" width="1" height="${num(r)}"`;
        const cid = `mgc_${safeId(res.id)}`;
        defs = `<defs><clipPath id="${cid}" clipPathUnits="objectBoundingBox"><rect ${rect}/></clipPath></defs>`;
        inner = `<g clip-path="url(#${cid})">${body}</g>`;
    }
    const w = ctx.width, h = ctx.height;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"`
        + ` style="position:absolute;left:0;top:0;overflow:visible;mix-blend-mode:${blendCss(res.layer)}">`
        + `${defs}<g transform="${matrixCss(res.world)}" opacity="${num(res.opacity)}">${inner}</g></svg>`;
}

// -- validating -------------------------------------------------------------------------

const ISSUE = (code, path, message) => ({ code, path, message });

function checkValue(prop, v) {
    const d = PROPS[prop];
    if (d.kind === "num") return isNum(v);
    if (d.kind === "vec2") return Array.isArray(v) && v.length === 2 && v.every(isNum);
    if (d.kind === "color") return v === null ? false : parseColor(v) !== null;
    return false;
}

function easeOk(e) {
    return e === undefined || EASES.includes(e) || (Array.isArray(e) && e.length === 4 && e.every(isNum)
        && e[0] >= 0 && e[0] <= 1 && e[2] >= 0 && e[2] <= 1);
}

/**
 * Check a scene. Returns { ok, errors, warnings }, each issue {code, path, message}.
 * The same rules, with the same codes, are in agenty_core/motion_graphics/schema.py
 * (tests/validate_cases.json holds the cases both must agree on).
 */
export function validateScene(scene) {
    const errors = [], warnings = [];
    const E = (c, p, m) => errors.push(ISSUE(c, p, m));
    const W = (c, p, m) => warnings.push(ISSUE(c, p, m));
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
        E("E_SCENE", "", "the scene is not a JSON object");
        return { ok: false, errors, warnings };
    }
    if (scene.mgscene !== SCENE_VERSION) E("E_VERSION", "mgscene", `"mgscene" must be ${SCENE_VERSION}`);
    const c = scene.comp;
    let duration = Infinity;
    if (!c || typeof c !== "object") E("E_COMP", "comp", "comp {width, height, fps, duration} is missing");
    else {
        for (const [k, lo, hi] of [["width", 16, 8192], ["height", 16, 8192], ["fps", 1, 120], ["duration", 1, 360000]]) {
            if (!Number.isInteger(c[k]) || c[k] < lo || c[k] > hi) E("E_COMP", `comp.${k}`, `comp.${k} must be an integer from ${lo} to ${hi}`);
        }
        if (Number.isInteger(c.duration)) duration = c.duration;
        if (c.background !== undefined && c.background !== null && parseColor(c.background) === null) {
            E("E_COLOR", "comp.background", "comp.background is not a colour");
        }
    }
    const assets = scene.assets === undefined ? {} : scene.assets;
    if (assets === null || typeof assets !== "object" || Array.isArray(assets)) E("E_ASSET", "assets", "assets must be an object");
    else {
        for (const [id, a] of Object.entries(assets)) {
            if (!a || !["image", "video", "font"].includes(a.type)) E("E_ASSET", `assets.${id}`, 'an asset needs type "image", "video" or "font"');
            else if (typeof a.src !== "string" || !a.src) E("E_ASSET", `assets.${id}.src`, "an asset needs a src (path or url)");
        }
    }
    if (!Array.isArray(scene.layers)) {
        E("E_LAYERS", "layers", "layers must be an array");
        return { ok: false, errors, warnings };
    }
    const ids = new Map();
    scene.layers.forEach((l, i) => {
        const p = `layers[${i}]`;
        if (!l || typeof l !== "object") { E("E_LAYER", p, "a layer must be an object"); return; }
        if (typeof l.id !== "string" || !l.id) E("E_LAYER_ID", `${p}.id`, "every layer needs a string id");
        else if (ids.has(l.id)) E("E_LAYER_ID", `${p}.id`, `duplicate layer id "${l.id}"`);
        else ids.set(l.id, l);
    });
    scene.layers.forEach((l, i) => {
        if (!l || typeof l !== "object") return;
        const p = `layers[${i}]`, name = l.id || p;
        if (!LAYER_TYPES.includes(l.type)) { E("E_LAYER_TYPE", `${p}.type`, `layer "${name}": type must be one of ${LAYER_TYPES.join(", ")}`); return; }
        if (l.parent !== undefined && l.parent !== null) {
            if (!ids.has(l.parent)) E("E_PARENT", `${p}.parent`, `layer "${name}": parent "${l.parent}" does not exist`);
            else {
                let cur = l, hops = 0;
                while (cur && cur.parent && hops++ < 1000) {
                    cur = ids.get(cur.parent);
                    if (cur === l) { E("E_PARENT", `${p}.parent`, `layer "${name}": parents form a loop`); break; }
                }
            }
        }
        for (const k of ["in", "out"]) {
            if (l[k] !== undefined && !isNum(l[k])) E("E_RANGE", `${p}.${k}`, `layer "${name}": ${k} must be a frame number`);
        }
        if (isNum(l.in) && isNum(l.out) && l.out <= l.in) E("E_RANGE", `${p}.out`, `layer "${name}": out must be after in`);
        if (isNum(l.in) && l.in >= duration) W("W_RANGE", `${p}.in`, `layer "${name}" starts after the composition ends`);
        if (l.blend !== undefined && !(l.blend in BLENDS)) E("E_BLEND", `${p}.blend`, `layer "${name}": blend must be one of ${Object.keys(BLENDS).join(", ")}`);
        const allowed = PROPS_BY_TYPE[l.type];
        for (const prop of ALL_PROPS) {
            if (l[prop] === undefined) continue;
            if (!allowed.includes(prop)) { W("W_PROP", `${p}.${prop}`, `layer "${name}": ${prop} has no effect on a ${l.type} layer`); continue; }
            const nullable = prop === "fill" || prop === "stroke";
            if (l[prop] === null && nullable) continue;
            if (!checkValue(prop, l[prop])) E(PROPS[prop].kind === "color" ? "E_COLOR" : "E_VALUE", `${p}.${prop}`, `layer "${name}": ${prop} is not a valid ${PROPS[prop].kind}`);
        }
        if (l.tracks !== undefined && (l.tracks === null || typeof l.tracks !== "object" || Array.isArray(l.tracks))) {
            E("E_TRACK", `${p}.tracks`, "tracks must be an object of arrays");
        } else {
            for (const [prop, keys] of Object.entries(l.tracks || {})) {
                const tp = `${p}.tracks.${prop}`;
                if (!PROPS[prop] || !allowed.includes(prop)) { E("E_TRACK_PROP", tp, `layer "${name}": ${prop} cannot be animated on a ${l.type} layer`); continue; }
                if (!Array.isArray(keys) || !keys.length) { E("E_TRACK", tp, "a track is a non-empty array of keys"); continue; }
                let last = -Infinity, sorted = true;
                keys.forEach((k, j) => {
                    const kp = `${tp}[${j}]`;
                    if (!k || !isNum(k.f)) { E("E_KEY", kp, "a key needs a numeric f (comp frame)"); return; }
                    if (!checkValue(prop, k.v)) E(PROPS[prop].kind === "color" ? "E_COLOR" : "E_KEY", `${kp}.v`, `${prop} key value is not a valid ${PROPS[prop].kind}`);
                    if (!easeOk(k.ease)) E("E_EASE", `${kp}.ease`, `ease must be one of ${EASES.join(", ")} or [x1,y1,x2,y2]`);
                    if (k.f < last) sorted = false;
                    if (k.f === last) E("E_KEY", kp, `two keys on frame ${k.f}`);
                    last = Math.max(last, k.f);
                });
                if (!sorted) W("W_KEY_ORDER", tp, "keys are not sorted by frame (they are used sorted)");
                if (isNum(duration) && keys.some((k) => k && isNum(k.f) && k.f > duration)) W("W_RANGE", tp, "a key lies after the end of the composition");
            }
        }
        if (l.type === "text" && typeof l.text !== "string") E("E_TEXT", `${p}.text`, `text layer "${name}" needs a text string`);
        if (l.type === "shape") {
            const kind = l.shape === undefined ? "rect" : l.shape;
            if (!SHAPES.includes(kind)) E("E_SHAPE", `${p}.shape`, `shape must be one of ${SHAPES.join(", ")}`);
            if (kind === "path" && (typeof l.d !== "string" || !l.d.trim())) E("E_SHAPE", `${p}.d`, `path shape "${name}" needs d (SVG path data)`);
        }
        if (l.type === "image" || l.type === "video") {
            const a = assets && assets[l.asset];
            if (!l.asset || !a) E("E_ASSET_REF", `${p}.asset`, `${l.type} layer "${name}" needs asset naming an entry of assets`);
            else if (a.type !== l.type) E("E_ASSET_REF", `${p}.asset`, `layer "${name}": asset "${l.asset}" is a ${a.type}, not a ${l.type}`);
        }
        if (l.type === "component" && (typeof l.component !== "string" || !l.component)) E("E_COMPONENT", `${p}.component`, `component layer "${name}" needs the name of a registered component`);
        if (l.align !== undefined && !ALIGNS.includes(l.align)) E("E_VALUE", `${p}.align`, `align must be one of ${ALIGNS.join(", ")}`);
        if (l.fit !== undefined && !FITS.includes(l.fit)) E("E_VALUE", `${p}.fit`, `fit must be one of ${FITS.join(", ")}`);
        if (l.revealDir !== undefined && !REVEAL_DIRS.includes(l.revealDir)) E("E_VALUE", `${p}.revealDir`, `revealDir must be one of ${REVEAL_DIRS.join(", ")}`);
        if (l.font !== undefined && (typeof l.font !== "string")) E("E_VALUE", `${p}.font`, "font is a family name or a font asset id");
    });
    return { ok: errors.length === 0, errors, warnings };
}

// -- normalising --------------------------------------------------------------------------

/** A tolerant copy: defaults on comp, keys sorted, nothing invented on layers. */
export function normalizeScene(raw) {
    const s = JSON.parse(JSON.stringify(raw || {}));
    s.mgscene = SCENE_VERSION;
    s.comp = Object.assign({ width: 1920, height: 1080, fps: 30, duration: 90, background: "#000000" }, s.comp || {});
    if (!s.assets || typeof s.assets !== "object") s.assets = {};
    if (!Array.isArray(s.layers)) s.layers = [];
    for (const l of s.layers) {
        if (l.tracks && typeof l.tracks === "object") {
            for (const k of Object.keys(l.tracks)) {
                if (Array.isArray(l.tracks[k])) l.tracks[k].sort((a, b) => a.f - b.f);
                if (!l.tracks[k] || !l.tracks[k].length) delete l.tracks[k];
            }
        }
    }
    return s;
}

/** The SVG-ish stage of a whole frame as a list of {id, svg} in painter's order (video/component layers excluded). */
export function frameSvgs(scene, frame, ctx) {
    const c = Object.assign({ width: scene.comp.width, height: scene.comp.height }, ctx || {});
    return evaluateScene(scene, frame).map((res) => ({ id: res.id, svg: layerSvg(scene, res, c) })).filter((x) => x.svg);
}
