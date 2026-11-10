// imageViewer_compModel.js
// Comp: the compositing document (*.comp.json), its edits and its pixel arithmetic.
//
// Plain ES module, no DOM: the Comp space (imageViewer_compPanel.js) draws with it, node runs it in the
// tests, and src/comp_model.py is the same arithmetic in numpy for the render and for the ComfyUI node
// (tests/test_comp_parity.py renders the same comps with both and compares them pixel by pixel).
//
// THE FORMAT ("comp": 1)
//   format  { width, height, fps, frames }                       frames = the comp's length
//   nodes   [ { id, type, name?, x, y, disable?, inputs: [id | null, ...], ...params, tracks? } ]
//   output  the id of the Output node the comp renders (the first Output when it is not set)
//
// One node graph, read two ways. The Node graph panel draws it as Nuke does, top to bottom. The Layers
// panel reads the same graph as a stack (layerStack): from the Output up the B pipe, every Merge is a
// layer whose picture is what comes down its A input (a source and the effects on it); what is at the top
// of the B pipe is the background. A branch that is more than a chain (a Merge inside an A input) is a
// layer of kind "group" there, edited in the graph. Nothing is stored twice.
//
// KEYS are Motion's (imageViewer_mgScene.js): static values on the node, animated ones in
// `tracks: { param: [{f, v, ease, ti?, to?}] }`, f = comp frame, and the same interpolation (paramAt calls
// Motion's valueAt), so Motion's stopwatch / key functions (imageViewer_mgModel.js) work on a node as on a layer.
//
// PIXELS are linear light, premultiplied RGBA, Float32Array w*h*4, top-left first (y down). A source is
// decoded once (decode8: sRGB 8-bit straight -> linear premultiplied), every node makes a picture of the
// comp's size (times the preview scale). Sampling is bilinear at pixel centres; outside a picture is
// transparent. Blur is Paint's (three box blurs, edge repeated; paint_math.blur_float).
import { valueAt } from "./imageViewer_mgScene.js";

export const COMP_VERSION = 1;
export const COMP_SUFFIX = ".comp.json";
export const MERGE_OPS = ["over", "under", "plus", "minus", "multiply", "screen", "max", "min", "difference",
    "in", "out", "atop", "mask", "stencil"];
export const FITS = ["fit", "fill", "none", "stretch"];
export const COLORSPACES = ["auto", "srgb", "linear"];

/**
 * The node types. `inputs` are the ports' names, in order (a Merge's B is input 0: the pipe runs through B).
 * A param: kind num | int | vec2 | color (linear RGBA) | enum | file | text; `key` = it can be animated.
 */
export const NODE_TYPES = {
    read: { label: "Read", cat: "Image", inputs: [], params: {
        file: { kind: "file", def: "" },
        offset: { kind: "int", def: 0, help: "Frames to slide the footage by: +10 starts it 10 frames later" },
        colorspace: { kind: "enum", def: "auto", choices: COLORSPACES, help: "auto: EXR / HDR are linear, the rest sRGB" },
        fit: { kind: "enum", def: "fit", choices: FITS, help: "How a picture of another size is laid into the comp" },
    } },
    constant: { label: "Constant", cat: "Image", inputs: [], params: {
        color: { kind: "color", def: [0, 0, 0, 1], key: true },
    } },
    merge: { label: "Merge", cat: "Merge", inputs: ["B", "A", "mask"], params: {
        operation: { kind: "enum", def: "over", choices: MERGE_OPS },
        mix: { kind: "num", def: 1, min: 0, max: 1, step: 0.01, key: true },
    } },
    transform: { label: "Transform", cat: "Transform", inputs: ["src"], params: {
        translate: { kind: "vec2", def: [0, 0], key: true, step: 1 },
        rotate: { kind: "num", def: 0, key: true, step: 0.5 },
        scale: { kind: "vec2", def: [1, 1], key: true, step: 0.01 },
        center: { kind: "vec2", def: null, key: true, step: 1, help: "Empty: the middle of the comp" },
    } },
    grade: { label: "Grade", cat: "Color", inputs: ["src"], params: {
        blackpoint: { kind: "num", def: 0, key: true, step: 0.01 },
        whitepoint: { kind: "num", def: 1, key: true, step: 0.01 },
        lift: { kind: "num", def: 0, key: true, step: 0.01 },
        gain: { kind: "num", def: 1, key: true, step: 0.01 },
        multiply: { kind: "num", def: 1, key: true, step: 0.01 },
        offset: { kind: "num", def: 0, key: true, step: 0.01 },
        gamma: { kind: "num", def: 1, min: 0.01, key: true, step: 0.01 },
        saturation: { kind: "num", def: 1, min: 0, key: true, step: 0.01 },
        mix: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01 },
    } },
    blur: { label: "Blur", cat: "Filter", inputs: ["src"], params: {
        size: { kind: "num", def: 10, min: 0, max: 500, key: true, step: 0.5, help: "In pixels of the comp" },
    } },
    output: { label: "Output", cat: "Other", inputs: ["src"], params: {} },
};
export const TYPE_ORDER = ["read", "constant", "merge", "transform", "grade", "blur", "output"];
export const NODE_W = 120;
export const NODE_H = 30;

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// ── documents ────────────────────────────────────────────────────────────────

export function isCompPath(p) { return typeof p === "string" && p.toLowerCase().endsWith(COMP_SUFFIX); }

/** A new comp: a Constant into an Output, ready for a Read to be merged over it. */
export function newComp({ width = 1920, height = 1080, fps = 24, frames = 48 } = {}) {
    const comp = { comp: COMP_VERSION, format: { width, height, fps, frames }, nodes: [], output: "Output1" };
    const bg = addNode(comp, makeNode(comp, "constant", { x: 0, y: 0, color: [0, 0, 0, 1], name: "Background" }));
    addNode(comp, makeNode(comp, "output", { x: 0, y: 200, inputs: [bg.id] }));
    return comp;
}

/** The comp a file holds, with defaults filled in and what cannot be used dropped: {comp, errors}. */
export function normalizeComp(raw) {
    const errors = [];
    if (!isObj(raw) || raw.comp !== COMP_VERSION) return { comp: newComp(), errors: ["not a comp (it needs \"comp\": 1)"] };
    const f = isObj(raw.format) ? raw.format : {};
    const int = (v, d, lo, hi) => (isNum(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
    const comp = {
        comp: COMP_VERSION,
        format: { width: int(f.width, 1920, 4, 16384), height: int(f.height, 1080, 4, 16384), fps: isNum(f.fps) && f.fps > 0 ? f.fps : 24,
            frames: int(f.frames, 48, 1, 100000) },
        nodes: [],
        output: typeof raw.output === "string" ? raw.output : null,
    };
    const seen = new Set();
    for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
        if (!isObj(n) || !NODE_TYPES[n.type]) { errors.push(`a node of unknown type ${isObj(n) ? n.type : n} was left out`); continue; }
        if (typeof n.id !== "string" || !n.id || seen.has(n.id)) { errors.push(`a ${n.type} node without its own id was left out`); continue; }
        seen.add(n.id);
        const t = NODE_TYPES[n.type];
        const node = clone(n);
        node.x = isNum(n.x) ? n.x : 0; node.y = isNum(n.y) ? n.y : 0;
        const ins = Array.isArray(n.inputs) ? n.inputs : [];
        node.inputs = t.inputs.map((_, i) => (typeof ins[i] === "string" ? ins[i] : null));
        if (node.tracks && !isObj(node.tracks)) delete node.tracks;
        comp.nodes.push(node);
    }
    for (const n of comp.nodes) n.inputs = n.inputs.map((id) => (id && seen.has(id) && id !== n.id ? id : null));
    // Cycles are not a picture: the input that closes one goes.
    for (const n of comp.nodes) n.inputs = n.inputs.map((id, i) => {
        if (!id) return null;
        n.inputs[i] = null;
        const bad = reaches(comp, id, n.id);
        if (bad) errors.push(`${n.id}: an input that made a loop was taken off`);
        return bad ? null : id;
    });
    if (!comp.output || !nodeById(comp, comp.output) || nodeById(comp, comp.output).type !== "output") {
        const o = comp.nodes.find((n) => n.type === "output");
        comp.output = o ? o.id : null;
    }
    return { comp, errors };
}

export function nodeById(comp, id) { return (comp && comp.nodes || []).find((n) => n.id === id) || null; }

export function uniqueId(comp, base) {
    const have = new Set((comp.nodes || []).map((n) => n.id));
    let k = 1;
    while (have.has(`${base}${k}`)) k++;
    return `${base}${k}`;
}

/** A new node of `type` (not yet in the comp). */
export function makeNode(comp, type, extra = {}) {
    const t = NODE_TYPES[type];
    if (!t) throw new Error(`unknown node type ${type}`);
    const node = { id: uniqueId(comp, t.label), type, x: 0, y: 0, inputs: t.inputs.map(() => null) };
    for (const [p, d] of Object.entries(t.params)) if (d.def !== null) node[p] = clone(d.def);
    Object.assign(node, clone(extra));
    node.inputs = t.inputs.map((_, i) => (extra.inputs && extra.inputs[i]) || null);
    return node;
}

export function addNode(comp, node) {
    comp.nodes.push(node);
    if (node.type === "output" && !comp.output) comp.output = node.id;
    return node;
}

/** The nodes reading `id`: [{node, port}]. */
export function consumers(comp, id) {
    const out = [];
    for (const n of comp.nodes) n.inputs.forEach((src, port) => { if (src === id) out.push({ node: n, port }); });
    return out;
}

/** Does `from` reach `to` going up the inputs (is `to` upstream of `from`, or the same)? */
export function reaches(comp, from, to) {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
        const id = stack.pop();
        if (id === to) return true;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const n = nodeById(comp, id);
        if (n) stack.push(...n.inputs);
    }
    return false;
}

/** Connect `src` into `dst`'s input `port`. Refused (false) when it would make a loop. */
export function connect(comp, dstId, port, srcId) {
    const dst = nodeById(comp, dstId);
    if (!dst || port < 0 || port >= dst.inputs.length) return false;
    if (srcId && (!nodeById(comp, srcId) || reaches(comp, srcId, dstId))) return false;
    dst.inputs[port] = srcId || null;
    return true;
}

export function disconnect(comp, dstId, port) { return connect(comp, dstId, port, null); }

/** Delete nodes as Nuke does: what read a node reads its first input instead. */
export function removeNodes(comp, ids) {
    const gone = new Set(ids);
    for (const id of ids) {
        const n = nodeById(comp, id);
        if (!n) continue;
        let up = n.inputs[0] || null;
        while (up && gone.has(up)) up = (nodeById(comp, up) || { inputs: [null] }).inputs[0] || null;
        for (const { node, port } of consumers(comp, id)) if (!gone.has(node.id)) node.inputs[port] = up && !reaches(comp, up, node.id) ? up : null;
    }
    comp.nodes = comp.nodes.filter((n) => !gone.has(n.id));
    if (gone.has(comp.output)) { const o = comp.nodes.find((n) => n.type === "output"); comp.output = o ? o.id : null; }
}

/**
 * Put a new node after `afterId` (Nuke's way: it takes over what read that node, and reads it); with nothing
 * selected it just goes in. A Merge put after a node takes it as its B. Returns the node.
 */
export function insertNode(comp, type, afterId, extra = {}) {
    const after = afterId ? nodeById(comp, afterId) : null;
    const node = makeNode(comp, type, Object.assign(after ? { x: after.x, y: after.y + 70 } : freeSpot(comp), extra));
    addNode(comp, node);
    if (after && after.type !== "output" && node.inputs.length) {
        for (const { node: c, port } of consumers(comp, after.id)) if (c.id !== node.id) c.inputs[port] = node.id;
        node.inputs[0] = after.id;
        // Make room: what was below moves down with it.
        shiftBelow(comp, node, after.id);
    }
    return node;
}

/** Where a node with nothing to hang under goes: right of everything, level with the topmost. */
export function freeSpot(comp) {
    if (!comp.nodes.length) return { x: 0, y: 0 };
    let right = -Infinity, top = Infinity;
    for (const n of comp.nodes) { right = Math.max(right, n.x); top = Math.min(top, n.y); }
    return { x: Math.round(right + NODE_W + 40), y: Math.round(top) };
}

function shiftBelow(comp, node, aboveId) {
    const moved = new Set([node.id, aboveId]);
    const walk = (id) => {
        for (const { node: c } of consumers(comp, id)) {
            if (moved.has(c.id)) continue;
            moved.add(c.id);
            if (c.y < node.y + NODE_H + 20) c.y += 70;
            walk(c.id);
        }
    };
    walk(node.id);
}

// ── keys and values ──────────────────────────────────────────────────────────

/** A param's value at `frame`: its keys (Motion's interpolation), else its value, else the type's default. */
export function paramAt(node, p, frame) {
    const d = NODE_TYPES[node.type] && NODE_TYPES[node.type].params[p];
    const own = node[p] !== undefined ? node[p] : d ? d.def : undefined;
    if (!d || !d.key) return clone(own);
    const v = valueAt({ tracks: node.tracks, [p]: own }, p, frame);
    if (d.kind === "num" && isNum(v)) {
        let x = v;
        if (d.min !== undefined && x < d.min) x = d.min;
        if (d.max !== undefined && x > d.max) x = d.max;
        return x;
    }
    return v;
}

/** Every key frame of a node, sorted. */
export function nodeKeyFrames(node) {
    const out = new Set();
    for (const list of Object.values((node && node.tracks) || {})) for (const k of list || []) out.add(k.f);
    return [...out].sort((a, b) => a - b);
}

// ── the stack the Layers panel shows ─────────────────────────────────────────

const CHAIN = new Set(["transform", "grade", "blur"]);

/**
 * The comp as layers, top first: [{ kind: "layer" | "background" | "group", merge?, chain: [ids top-down],
 * source?, name }]. `chain` runs from the node the Merge reads (its A) up to the source; `source` is the
 * Read / Input / Constant at its end. A layer whose A branch holds another Merge is a "group".
 */
export function layerStack(comp) {
    const out = [];
    const outNode = nodeById(comp, comp.output);
    let id = outNode ? outNode.inputs[0] : null;
    const seen = new Set();
    const branch = (start) => {
        const chain = [];
        let cur = start, group = false;
        while (cur && !seen.has(cur)) {
            const n = nodeById(comp, cur);
            if (!n) break;
            chain.push(n.id);
            if (CHAIN.has(n.type)) { cur = n.inputs[0]; continue; }
            if (n.type === "merge") group = true;
            break;
        }
        const last = chain.length ? nodeById(comp, chain[chain.length - 1]) : null;
        const source = last && !CHAIN.has(last.type) && last.type !== "merge" ? last : null;
        return { chain, source, group };
    };
    while (id && !seen.has(id)) {
        const n = nodeById(comp, id);
        if (!n) break;
        seen.add(id);
        if (n.type === "merge") {
            const b = branch(n.inputs[1]);
            out.push({ kind: b.group ? "group" : "layer", merge: n.id, chain: b.chain, source: b.source ? b.source.id : null,
                name: n.name || (b.source ? b.source.name || sourceName(b.source) : b.group ? "Group" : "(nothing in A)") });
            id = n.inputs[0];
            continue;
        }
        const b = branch(id);
        out.push({ kind: b.group ? "group" : "background", merge: null, chain: b.chain, source: b.source ? b.source.id : null,
            name: b.source ? b.source.name || sourceName(b.source) : "Background" });
        break;
    }
    return out;
}

export function sourceName(n) {
    if (!n) return "";
    if (n.type === "read") return String(n.file || "Read").split(/[\\/]/).pop() || n.id;
    return n.name || n.id;
}

/** Swap two layers' places (i and i + d in layerStack's order): their Merges trade A branches and settings. */
export function moveLayer(comp, i, d) {
    const L = layerStack(comp);
    const a = L[i], b = L[i + d];
    if (!a || !b || !a.merge || !b.merge) return false;
    const ma = nodeById(comp, a.merge), mb = nodeById(comp, b.merge);
    for (const k of ["operation", "mix", "disable", "name", "tracks"]) { const t = ma[k]; ma[k] = mb[k]; mb[k] = t; if (ma[k] === undefined) delete ma[k]; if (mb[k] === undefined) delete mb[k]; }
    const tA = ma.inputs[1]; ma.inputs[1] = mb.inputs[1]; mb.inputs[1] = tA;
    const tM = ma.inputs[2]; ma.inputs[2] = mb.inputs[2]; mb.inputs[2] = tM;
    // The branches keep their place on screen beside their Merge.
    const shift = (start, dx, dy) => { for (const id of branchIds(comp, start)) { const n = nodeById(comp, id); n.x += dx; n.y += dy; } };
    const dy = mb.y - ma.y;
    shift(ma.inputs[1], 0, dy); shift(mb.inputs[1], 0, -dy);
    return true;
}

function branchIds(comp, start) {
    const out = [];
    let cur = start;
    while (cur && !out.includes(cur)) {
        const n = nodeById(comp, cur);
        if (!n || consumers(comp, cur).length > 1) break;
        out.push(cur);
        if (!CHAIN.has(n.type)) break;
        cur = n.inputs[0];
    }
    return out;
}

/** A new layer on top of the stack: `source` (a node not yet in the comp) merged over what the Output reads. */
export function addLayer(comp, source) {
    const outNode = nodeById(comp, comp.output) || addNode(comp, makeNode(comp, "output", { x: 0, y: 200 }));
    if (!comp.output) comp.output = outNode.id;
    const top = outNode.inputs[0] ? nodeById(comp, outNode.inputs[0]) : null;
    const merge = makeNode(comp, "merge", { x: outNode.x, y: outNode.y });
    source.x = merge.x + 180; source.y = merge.y - 70;
    addNode(comp, source);
    addNode(comp, merge);
    merge.inputs = [top ? top.id : null, source.id, null];
    outNode.inputs[0] = merge.id;
    outNode.y += 70;
    for (const n of comp.nodes) if (n !== outNode && n.y > merge.y && reaches(comp, n.id, merge.id)) n.y += 70;
    return { merge, source };
}

/** Take a layer out: its Merge goes (B passes on), and so does its branch when nothing else reads it. */
export function removeLayer(comp, i) {
    const L = layerStack(comp)[i];
    if (!L || !L.merge) return false;
    const ids = [L.merge, ...branchIds(comp, nodeById(comp, L.merge).inputs[1])];
    removeNodes(comp, ids);
    return true;
}

// ── pixels ───────────────────────────────────────────────────────────────────

export function blank(w, h) { return { w, h, data: new Float32Array(w * h * 4) }; }

export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

/** 8-bit straight RGBA (sRGB, or linear when `linear`) -> a picture: linear, premultiplied floats. */
export function decode8(u8, w, h, linear = false) {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = linear ? i / 255 : srgbToLinear(i / 255);
    const out = blank(w, h), d = out.data;
    for (let i = 0; i < w * h * 4; i += 4) {
        const a = u8[i + 3] / 255;
        d[i] = lut[u8[i]] * a; d[i + 1] = lut[u8[i + 1]] * a; d[i + 2] = lut[u8[i + 2]] * a; d[i + 3] = a;
    }
    return out;
}

/** A picture -> 8-bit RGBA for the screen: premultiplied colour over black, sRGB; `alpha` shows the alpha. */
export function encode8(img, out, { alpha = false } = {}) {
    const d = img.data;
    const lut = new Uint8ClampedArray(4096);
    for (let i = 0; i < 4096; i++) lut[i] = Math.round(linearToSrgb(i / 4095) * 255);
    const q = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : lut[(v * 4095 + 0.5) | 0]);
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        if (alpha) { const a = q(d[i + 3]); out[i] = out[i + 1] = out[i + 2] = a; }
        else { out[i] = q(d[i]); out[i + 1] = q(d[i + 1]); out[i + 2] = q(d[i + 2]); }
        out[i + 3] = 255;
    }
    return out;
}

// 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (Motion's convention).
export const mat = {
    mul: (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]],
    inv: (m) => { const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
        return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]; },
    t: (x, y) => [1, 0, 0, 1, x, y],
    s: (x, y) => [x, 0, 0, y, 0, 0],
    r: (deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; },
};

/** `src` drawn through `m` (source pixels -> output pixels) into a w x h picture, bilinear, transparent outside. */
export function resample(src, m, w, h) {
    const out = blank(w, h), o = out.data, s = src.data, sw = src.w, sh = src.h;
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 && sw === w && sh === h) { o.set(s); return out; }
    const iv = mat.inv(m);
    for (let y = 0; y < h; y++) {
        const py = y + 0.5;
        for (let x = 0; x < w; x++) {
            const px = x + 0.5;
            const u = iv[0] * px + iv[2] * py + iv[4] - 0.5;
            const v = iv[1] * px + iv[3] * py + iv[5] - 0.5;
            const x0 = Math.floor(u), y0 = Math.floor(v);
            if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) continue;
            const fx = u - x0, fy = v - y0;
            const oi = (y * w + x) * 4;
            for (let j = 0; j < 4; j++) {
                const yy = y0 + (j >> 1), xx = x0 + (j & 1);
                if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
                const wgt = ((j & 1) ? fx : 1 - fx) * ((j >> 1) ? fy : 1 - fy);
                if (!wgt) continue;
                const si = (yy * sw + xx) * 4;
                o[oi] += s[si] * wgt; o[oi + 1] += s[si + 1] * wgt; o[oi + 2] += s[si + 2] * wgt; o[oi + 3] += s[si + 3] * wgt;
            }
        }
    }
    return out;
}

/** The matrix that lays a sw x sh source into a w x h picture by `fit`. */
/** Lay a picture of sw x sh into w x h. `k` is what one of its pixels is in the picture's pixels for "none"
 *  (the proxy scale, times how much smaller than the file a shrunk source was handed over). */
export function fitMatrix(sw, sh, w, h, fit, k = 1) {
    let kx = k, ky = k;
    if (fit === "fit") kx = ky = Math.min(w / sw, h / sh);
    else if (fit === "fill") kx = ky = Math.max(w / sw, h / sh);
    else if (fit === "stretch") { kx = w / sw; ky = h / sh; }
    return mat.mul(mat.t(w / 2, h / 2), mat.mul(mat.s(kx, ky), mat.t(-sw / 2, -sh / 2)));
}

/** A Transform node's matrix at `frame`, in pixels of a picture `scale` times the comp's size. */
export function transformMatrix(node, frame, format, scale = 1) {
    const t = paramAt(node, "translate", frame) || [0, 0];
    const r = paramAt(node, "rotate", frame) || 0;
    const sc = paramAt(node, "scale", frame) || [1, 1];
    const c = paramAt(node, "center", frame) || [format.width / 2, format.height / 2];
    const cx = c[0] * scale, cy = c[1] * scale;
    return mat.mul(mat.t(t[0] * scale + cx, t[1] * scale + cy), mat.mul(mat.r(r), mat.mul(mat.s(sc[0], sc[1]), mat.t(-cx, -cy))));
}

export function boxesForGauss(sigma, n = 3) {
    if (sigma <= 0) return new Array(n).fill(1);
    const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl -= 1;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** Mean over 2r+1 along one axis, the edge value repeated (paint_math._box_axis), in place on a Float64Array. */
function boxAxis(a, w, h, r, horizontal) {
    if (r <= 0) return;
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    const stride = horizontal ? 4 : w * 4, lineStep = horizontal ? w * 4 : 4;
    const acc = new Float64Array(n + 2 * r + 2);
    const div = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
        const base = line * lineStep;
        for (let ch = 0; ch < 4; ch++) {
            // padded: r+1 copies of the first, the line, r copies of the last; cumulative sums
            let sum = 0;
            acc[0] = 0;
            const P = n + 2 * r + 1;
            for (let k = 0; k < P; k++) {
                let idx = k - (r + 1);
                if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
                sum += a[base + idx * stride + ch];
                acc[k + 1] = sum;
            }
            for (let i = 0; i < n; i++) a[base + i * stride + ch] = (acc[i + 2 * r + 2] - acc[i + 1]) / div;
        }
    }
}

export function blurImage(img, size) {
    const sigma = Math.max(0, size) / 2;
    if (sigma <= 0) return img;
    const a = Float64Array.from(img.data);
    for (const s of boxesForGauss(sigma)) {
        const r = (s - 1) >> 1;
        boxAxis(a, img.w, img.h, r, true);
        boxAxis(a, img.w, img.h, r, false);
    }
    return { w: img.w, h: img.h, data: Float32Array.from(a) };
}

export function gradeImage(img, p) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    const A = (p.multiply * (p.gain - p.lift)) / ((p.whitepoint - p.blackpoint) || 1e-6);
    const B = p.offset + p.lift - A * p.blackpoint;
    const g = 1 / (p.gamma || 1e-6), sat = p.saturation, mix = p.mix;
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        const a = s[i + 3];
        o[i + 3] = a;
        if (a <= 0) { o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; continue; }
        const c = [s[i] / a, s[i + 1] / a, s[i + 2] / a];
        const r = [0, 0, 0];
        for (let k = 0; k < 3; k++) { let v = A * c[k] + B; if (g !== 1 && v > 0) v = Math.pow(v, g); r[k] = v; }
        if (sat !== 1) { const l = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]; for (let k = 0; k < 3; k++) r[k] = l + (r[k] - l) * sat; }
        for (let k = 0; k < 3; k++) o[i + k] = (c[k] + (r[k] - c[k]) * mix) * a;
    }
    return out;
}

const OPS = {
    over: (A, B, a) => A + B * (1 - a),
    under: (A, B, a, b) => A * (1 - b) + B,
    plus: (A, B) => A + B,
    minus: (A, B) => A - B,
    multiply: (A, B) => A * B,
    screen: (A, B) => A + B - A * B,
    max: (A, B) => Math.max(A, B),
    min: (A, B) => Math.min(A, B),
    difference: (A, B) => Math.abs(A - B),
    in: (A, B, a, b) => A * b,
    out: (A, B, a, b) => A * (1 - b),
    atop: (A, B, a, b) => A * b + B * (1 - a),
    mask: (A, B, a) => B * a,
    stencil: (A, B, a) => B * (1 - a),
};

export function mergeImages(Bimg, Aimg, Mimg, op, mix) {
    const w = Bimg.w, h = Bimg.h, out = blank(w, h), o = out.data, B = Bimg.data, A = Aimg.data, M = Mimg ? Mimg.data : null;
    const f = OPS[op] || OPS.over;
    for (let i = 0; i < w * h * 4; i += 4) {
        const a = A[i + 3], b = B[i + 3];
        const t = M ? mix * M[i + 3] : mix;
        for (let k = 0; k < 4; k++) { const r = f(A[i + k], B[i + k], a, b); o[i + k] = B[i + k] + (r - B[i + k]) * t; }
    }
    return out;
}

/**
 * The picture `id` makes at `frame`. ctx: { scale, source(node, frame) -> picture | null (a Read's / Input's
 * pixels at their own size, linear premultiplied), cache?: Map }. Returns a picture of the comp's size x scale.
 */
export function renderNode(comp, id, frame, ctx) {
    const scale = ctx.scale || 1;
    const W = Math.max(1, Math.round(comp.format.width * scale)), H = Math.max(1, Math.round(comp.format.height * scale));
    const memo = ctx.memo || (ctx.memo = new Map());
    const run = (nid, depth) => {
        if (!nid || depth > 256) return blank(W, H);
        if (memo.has(nid)) return memo.get(nid);
        const n = nodeById(comp, nid);
        let img;
        if (!n) img = blank(W, H);
        else if (n.disable) img = NODE_TYPES[n.type].inputs.length ? run(n.inputs[0], depth + 1) : blank(W, H);
        else if (n.type === "read") {
            const src = ctx.source ? ctx.source(n, frame) : null;
            // A source may come shrunk (the page's proxy): `ow` x `oh` is the file's own size then.
            const k = src ? scale * (src.ow ? src.ow / src.w : 1) : 1;
            img = src ? resample(src, fitMatrix(src.w, src.h, W, H, n.fit || "fit", k), W, H) : blank(W, H);
        } else if (n.type === "constant") {
            const c = paramAt(n, "color", frame) || [0, 0, 0, 1];
            img = blank(W, H);
            const a = c[3];
            for (let i = 0; i < W * H * 4; i += 4) { img.data[i] = c[0] * a; img.data[i + 1] = c[1] * a; img.data[i + 2] = c[2] * a; img.data[i + 3] = a; }
        } else if (n.type === "merge") {
            const B = run(n.inputs[0], depth + 1), A = run(n.inputs[1], depth + 1);
            const M = n.inputs[2] ? run(n.inputs[2], depth + 1) : null;
            img = mergeImages(B, A, M, n.operation || "over", paramAt(n, "mix", frame));
        } else if (n.type === "transform") {
            img = resample(run(n.inputs[0], depth + 1), transformMatrix(n, frame, comp.format, scale), W, H);
        } else if (n.type === "grade") {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.grade.params)) p[k] = paramAt(n, k, frame);
            img = gradeImage(run(n.inputs[0], depth + 1), p);
        } else if (n.type === "blur") {
            img = blurImage(run(n.inputs[0], depth + 1), paramAt(n, "size", frame) * scale);
        } else if (n.type === "output") img = run(n.inputs[0], depth + 1);
        else img = blank(W, H);
        memo.set(nid, img);
        return img;
    };
    return run(id, 0);
}

/** The Reads `id` depends on (what has to be loaded before it can be drawn). */
export function sourcesOf(comp, id) {
    const out = [];
    const seen = new Set();
    const walk = (nid) => {
        if (!nid || seen.has(nid)) return;
        seen.add(nid);
        const n = nodeById(comp, nid);
        if (!n || n.disable && !n.inputs.length) return;
        if (n.type === "read") out.push(n);
        for (const [i, s] of n.inputs.entries()) if (!n.disable || i === 0) walk(s);
    };
    walk(id);
    return out;
}

/** Which file frame a Read shows at comp frame `f`, given what its file is ({kind, first, last}). */
export function sourceFrame(node, info, f) {
    if (!info || info.kind === "still") return null;
    const first = isNum(info.first) ? info.first : 0;
    const last = isNum(info.last) ? info.last : first;
    const n = first + f - (node.offset || 0);
    return Math.max(first, Math.min(last, n));
}
