// imageViewer_compChannels.js
// Channels beyond r g b a, as a compositor has them: a picture carries, beside its rgba ({w, h, data}), any
// number of named extra channels ("mask.a", "depth.z", "motion.r" ...: "<layer>.<channel>"), each a
// Float32Array of w*h. renderNode keeps them beside each picture (one object of name -> array per node and
// frame); these are the pure rules for adding, removing, shuffling, writing into and moving them.
//
// src/comp_model.py has the same rules (the "channels" section), name for name and in the same order, so
// tests/test_comp_parity.py can compare the two. Imports nothing.

export const RGBA = ["r", "g", "b", "a"];
const IDX = { r: 0, g: 1, b: 2, a: 3 };
/** What a "pick" may be besides a channel: nothing written ("-"), black, white. */
export const PICK_CONSTANTS = ["-", "0", "1"];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A channel's name is valid: r g b a, or "<layer>.<channel>" of letters, digits and _ (the layer not "rgba"). */
export function isChannel(s) {
    if (IDX[s] !== undefined) return true;
    const i = typeof s === "string" ? s.indexOf(".") : -1;
    return i > 0 && NAME.test(s.slice(0, i)) && NAME.test(s.slice(i + 1)) && s.slice(0, i) !== "rgba";
}
/** A layer's name is valid: "rgba", or letters, digits and _ (not r g b a, which are channels). */
export function isLayer(s) { return s === "rgba" || (typeof s === "string" && NAME.test(s) && IDX[s] === undefined && s !== "rgb"); }
export const layerOf = (name) => (IDX[name] !== undefined ? "rgba" : name.slice(0, name.indexOf(".")));
/** The channels a layer is written as: rgba's own, else "<layer>.r" ... "<layer>.a". */
export const layerChannels = (layer) => (layer === "rgba" ? RGBA.slice() : RGBA.map((c) => `${layer}.${c}`));

/** The names a text lists (commas or spaces between): each a channel, a layer, "rgb" or "rgba"; the rest left out. */
export function parseChannels(text) {
    const out = [];
    for (const t of String(text || "").split(/[\s,;]+/)) if (t && (isChannel(t) || isLayer(t) || t === "rgb") && !out.includes(t)) out.push(t);
    return out;
}

/**
 * The channels a list names: a channel itself; "rgba" / "rgb" theirs; a layer the channels of it that are
 * there (``have``: the extra channels' names) or, when ``create``, its r g b a where none of it is there yet.
 */
export function expandChannels(tokens, have, create = false) {
    const out = [];
    const put = (c) => { if (!out.includes(c)) out.push(c); };
    for (const t of tokens) {
        if (t === "rgba") RGBA.forEach(put);
        else if (t === "rgb") ["r", "g", "b"].forEach(put);
        else if (isChannel(t)) put(t);
        else if (isLayer(t)) {
            const mine = have.filter((n) => layerOf(n) === t);
            (mine.length || !create ? mine : layerChannels(t)).forEach(put);
        }
    }
    return out;
}

/** One channel of a picture with its extras, as numbers per pixel (a copy for rgba; missing: none, null). */
export function channelOf(img, ex, name) {
    if (IDX[name] !== undefined) {
        const k = IDX[name], n = img.w * img.h, out = new Float32Array(n), d = img.data;
        for (let i = 0; i < n; i++) out[i] = d[i * 4 + k];
        return out;
    }
    return (ex && ex[name]) || null;
}

const copyPic = (img) => ({ w: img.w, h: img.h, data: new Float32Array(img.data) });

/** Put ``v`` (an array of w*h, or a number) into channel ``name`` of a copy-on-write picture / extras pair. */
function put(state, name, v) {
    const n = state.img.w * state.img.h;
    if (IDX[name] !== undefined) {
        if (!state.own) { state.img = copyPic(state.img); state.own = true; }
        const k = IDX[name], d = state.img.data;
        if (typeof v === "number") for (let i = 0; i < n; i++) d[i * 4 + k] = v;
        else for (let i = 0; i < n; i++) d[i * 4 + k] = v[i];
    } else {
        const a = new Float32Array(n);
        if (typeof v === "number") a.fill(v); else a.set(v);
        state.ex[name] = a;
    }
}
const start = (img, ex) => ({ img, own: false, ex: Object.assign({}, ex || {}) });

/** Add Channels: each channel the list names that is not there yet, filled with ``value`` (r g b a are always there). */
export function addChannels(img, ex, tokens, value) {
    const s = start(img, ex);
    for (const c of expandChannels(tokens, Object.keys(s.ex), true)) if (IDX[c] === undefined && !s.ex[c]) put(s, c, value);
    return [s.img, s.ex];
}

/** Remove Channels: "remove" takes the channels named away, "keep" all others; r g b a cannot go, they turn black. */
export function removeChannels(img, ex, tokens, keep) {
    const s = start(img, ex);
    const named = expandChannels(tokens, Object.keys(s.ex), false);
    const gone = keep ? [...RGBA, ...Object.keys(s.ex)].filter((c) => !named.includes(c)) : named;
    for (const c of gone) { if (IDX[c] !== undefined) put(s, c, 0); else delete s.ex[c]; }
    return [s.img, s.ex];
}

/**
 * Shuffle: the four channels of layer ``out`` ("rgba" or an extra layer) from ``picks``, one per channel:
 * any channel of the input, "0", "1", or "-" (not written: rgba keeps its own, a layer's channel is not made).
 * Every pick reads the input as it came in. A channel picked that is not there reads 0.
 */
export function shuffleChannels(img, ex, out, picks) {
    const s = start(img, ex);
    const read = picks.map((p) => (p === "-" ? null : p === "0" ? 0 : p === "1" ? 1 : channelOf(img, ex, p) || 0));
    const dst = layerChannels(isLayer(out) ? out : "rgba");
    dst.forEach((c, k) => { if (read[k] !== null) put(s, c, read[k]); });
    return [s.img, s.ex];
}

/** What a node writes: "rgba" (its whole picture, as before), one channel, or a layer (all four of it). */
export function isTarget(t) { return isChannel(t) || isLayer(t); }
/**
 * A node that makes something writes it into ``target`` of what comes in (``base``, ``bex``): "rgba" is the
 * node's own picture ``P`` and the input's extras; a layer gets P's r g b a; one channel gets P's channel of
 * the same letter (".a" of a layer, r g b a), any other name P's alpha.
 */
export function writeTarget(base, bex, P, target) {
    if (!isTarget(target) || target === "rgba") return [P, Object.assign({}, bex || {})];
    const s = start(base, bex);
    if (isLayer(target)) layerChannels(target).forEach((c, k) => put(s, c, channelOf(P, null, RGBA[k])));
    else {
        const letter = IDX[target] !== undefined ? target : target.slice(target.indexOf(".") + 1);
        put(s, target, channelOf(P, null, IDX[letter] !== undefined ? letter : "a"));
    }
    return [s.img, s.ex];
}

/** The extras put through a picture operation ``fn`` (rgba picture -> rgba picture), four at a time. */
export function mapExtras(ex, w, h, fn) {
    const names = Object.keys(ex || {});
    if (!names.length) return {};
    const out = {};
    for (let g = 0; g < names.length; g += 4) {
        const grp = names.slice(g, g + 4), pic = { w, h, data: new Float32Array(w * h * 4) };
        grp.forEach((nm, k) => { const a = ex[nm]; for (let i = 0; i < w * h; i++) pic.data[i * 4 + k] = a[i]; });
        const r = fn(pic);
        grp.forEach((nm, k) => { const a = new Float32Array(r.w * r.h); for (let i = 0; i < r.w * r.h; i++) a[i] = r.data[i * 4 + k]; out[nm] = a; });
    }
    return out;
}

/** Both inputs' extras: B's, and A's that B has not. */
export function unionExtras(bex, aex) {
    const out = Object.assign({}, bex || {});
    for (const [k, v] of Object.entries(aex || {})) if (!(k in out)) out[k] = v;
    return out;
}

/** Two frames' extras mixed as their pictures are (a channel only one has: the other's is 0). */
export function mixExtras(ax, bx, t, n) {
    const out = {};
    const zero = new Float32Array(n);
    for (const k of [...new Set([...Object.keys(ax || {}), ...Object.keys(bx || {})])]) {
        const x = (ax && ax[k]) || zero, y = (bx && bx[k]) || zero, o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = x[i] + (y[i] - x[i]) * t;
        out[k] = o;
    }
    return out;
}

/** A layer of a picture as a picture to look at: rgba itself, or the layer's channels in r g b a (one channel: grey, opaque). */
export function layerPicture(img, ex, layer) {
    if (!layer || layer === "rgba") return img;
    const names = Object.keys(ex || {}).filter((n) => layerOf(n) === layer);
    const n = img.w * img.h, out = { w: img.w, h: img.h, data: new Float32Array(n * 4) }, d = out.data;
    if (names.length === 1) {
        const a = ex[names[0]];
        for (let i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = a[i]; d[i * 4 + 3] = 1; }
        return out;
    }
    const others = names.filter((nm) => !RGBA.includes(nm.slice(layer.length + 1)));
    RGBA.forEach((c, k) => {
        const a = (ex[`${layer}.${c}`]) || (k < 3 ? ex[others[k]] : null);
        if (a) for (let i = 0; i < n; i++) d[i * 4 + k] = a[i];
        else if (k === 3) for (let i = 0; i < n; i++) d[i * 4 + 3] = 1;
    });
    return out;
}

/** The layers among extra channels' names, each once, in order. */
export function layersOf(names) {
    const out = [];
    for (const n of names) { const l = layerOf(n); if (l !== "rgba" && !out.includes(l)) out.push(l); }
    return out;
}

/**
 * The Roto node: matte ``m`` (w*h numbers) written into ``target`` of what comes in (``src`` - or nothing -
 * with its extras ``sex``). The shapes' own picture is white cut by the matte. "rgba": with an input, premult
 * on cuts it by the matte (all four), off keeps its colour and makes the matte its alpha; without one, the
 * white shapes. Any other target: the matte goes into it (writeTarget), and premult on multiplies what comes
 * in's rgb by the matte first.
 */
export function rotoWrite(m, w, h, src, sex, target, premult) {
    const n = w * h;
    const P = { w, h, data: new Float32Array(n * 4) };
    for (let i = 0; i < n; i++) { const v = m[i]; P.data[i * 4] = v; P.data[i * 4 + 1] = v; P.data[i * 4 + 2] = v; P.data[i * 4 + 3] = v; }
    const ex = Object.assign({}, sex || {});
    if (!isTarget(target) || target === "rgba") {
        if (!src) return [P, ex];
        const out = { w, h, data: new Float32Array(n * 4) }, s = src.data, o = out.data;
        for (let i = 0; i < n; i++) {
            const v = m[i], j = i * 4;
            if (premult) { o[j] = s[j] * v; o[j + 1] = s[j + 1] * v; o[j + 2] = s[j + 2] * v; o[j + 3] = s[j + 3] * v; }
            else { o[j] = s[j]; o[j + 1] = s[j + 1]; o[j + 2] = s[j + 2]; o[j + 3] = v; }
        }
        return [out, ex];
    }
    let base = src || { w, h, data: new Float32Array(n * 4) };
    if (src && premult) {
        const out = { w, h, data: new Float32Array(src.data) }, o = out.data;
        for (let i = 0; i < n; i++) { const v = m[i], j = i * 4; o[j] = o[j] * v; o[j + 1] = o[j + 1] * v; o[j + 2] = o[j + 2] * v; }
        base = out;
    }
    return writeTarget(base, ex, P, target);
}
