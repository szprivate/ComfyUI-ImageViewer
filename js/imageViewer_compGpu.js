// imageViewer_compGpu.js
// The Comp preview on the graphics card (WebGL2, float32 textures). The per-pixel nodes - Constant, Merge,
// Grade, Premult / Unpremult, Transform, Reformat, Crop, Blur and the mask stage - run as shaders that follow
// renderNode's arithmetic in imageViewer_compModel.js (bilinear at pixel centres with transparent outside, Paint's
// three box blurs, the Merge and Grade formulas, pictures of other sizes laid bottom left on bottom left).
// Every other node, and the Reads, are made by renderNode on the CPU (through its cache) and handed over as
// textures. A comp with extra channels anywhere upstream is left to the CPU (the GPU carries rgba only).
//
// A region of interest: `roi` = [x0, y0, x1, y1] in pixels of the picture asked for; each pass then works only
// the part of its picture that the region needs (grown by a blur's reach, taken back through a transform), and
// the pixels outside it are left 0 - such a picture is for looking at, not for keeping (`img.roi` says so).
//
// It renders the same numbers as the CPU in float32 (the CPU works in float64 between steps): the browser test
// compares the two within 1e-4.
import * as C from "./imageViewer_compModel.js";

/** Nodes worked as shaders. */
export const GPU_TYPES = new Set(["constant", "merge", "grade", "premult", "unpremult", "transform", "reformat", "crop", "blur", "output"]);

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
out vec4 o;
// Picture k's pixel (x, y) (rows top down, as the CPU's data), 0 outside; dy lays it bottom left on the output.
vec4 px(sampler2D t, ivec2 sz, ivec2 q) {
    if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) return vec4(0.0);
    return texelFetch(t, q, 0);
}
ivec2 here() { return ivec2(gl_FragCoord.xy); }
`;

const FS = {
    copy: `uniform sampler2D A; uniform ivec2 aS; uniform int dy;
void main() { ivec2 q = here(); o = px(A, aS, ivec2(q.x, q.y - dy)); }`,
    constant: `uniform vec4 c;
void main() { o = vec4(c.rgb * c.a, c.a); }`,
    premult: `uniform sampler2D A; uniform ivec2 aS;
void main() { vec4 s = px(A, aS, here()); o = vec4(s.rgb * s.a, s.a); }`,
    unpremult: `uniform sampler2D A; uniform ivec2 aS;
void main() { vec4 s = px(A, aS, here()); o = s.a > 0.0 ? vec4(s.rgb / s.a, s.a) : s; }`,
    grade: `uniform sampler2D A; uniform ivec2 aS; uniform float gA, gB, gG, sat, mixv;
void main() {
    vec4 s = px(A, aS, here());
    float a = s.a;
    if (a <= 0.0) { o = s; return; }
    vec3 c = s.rgb / a, r;
    for (int k = 0; k < 3; k++) { float v = gA * c[k] + gB; if (gG != 1.0 && v > 0.0) v = pow(v, gG); r[k] = v; }
    if (sat != 1.0) { float l = 0.2126 * r.x + 0.7152 * r.y + 0.0722 * r.z; r = l + (r - l) * sat; }
    o = vec4((c + (r - c) * mixv) * a, a);
}`,
    // Bilinear at pixel centres through the inverse matrix (iv: a b c d e f as the CPU's mat), transparent outside.
    resample: `uniform sampler2D A; uniform ivec2 aS; uniform float iv[6];
void main() {
    vec2 P = gl_FragCoord.xy;
    float u = iv[0] * P.x + iv[2] * P.y + iv[4] - 0.5;
    float v = iv[1] * P.x + iv[3] * P.y + iv[5] - 0.5;
    float fx0 = floor(u), fy0 = floor(v);
    int x0 = int(fx0), y0 = int(fy0);
    if (x0 < -1 || y0 < -1 || x0 >= aS.x || y0 >= aS.y) { o = vec4(0.0); return; }
    float fx = u - fx0, fy = v - fy0;
    o = px(A, aS, ivec2(x0, y0)) * ((1.0 - fx) * (1.0 - fy)) + px(A, aS, ivec2(x0 + 1, y0)) * (fx * (1.0 - fy))
      + px(A, aS, ivec2(x0, y0 + 1)) * ((1.0 - fx) * fy) + px(A, aS, ivec2(x0 + 1, y0 + 1)) * (fx * fy);
}`,
    crop: `uniform sampler2D A; uniform ivec2 aS; uniform vec4 box; uniform float soft;
float cover(float i, float lo, float hi) {
    if (soft > 0.0) { float c = i + 0.5; return clamp((c - lo) / soft, 0.0, 1.0) * clamp((hi - c) / soft, 0.0, 1.0); }
    return clamp(min(i + 1.0, hi) - max(i, lo), 0.0, 1.0);
}
void main() { ivec2 q = here(); o = px(A, aS, q) * (cover(float(q.x), box.x, box.z) * cover(float(q.y), box.y, box.w)); }`,
    // One box pass of 2r+1 along an axis, the edge value repeated (the CPU's boxAxis).
    box: `uniform sampler2D A; uniform ivec2 aS; uniform int r; uniform int horiz;
void main() {
    ivec2 q = here();
    vec4 s = vec4(0.0);
    for (int k = -r; k <= r; k++) {
        ivec2 t = horiz == 1 ? ivec2(clamp(q.x + k, 0, aS.x - 1), q.y) : ivec2(q.x, clamp(q.y + k, 0, aS.y - 1));
        s += texelFetch(A, t, 0);
    }
    o = s / float(2 * r + 1);
}`,
    merge: `uniform sampler2D B; uniform ivec2 bS; uniform sampler2D A; uniform ivec2 aS; uniform int aDy;
uniform sampler2D M; uniform ivec2 mS; uniform int mDy; uniform int hasM; uniform int op; uniform float mixv;
float f(int op, float A, float B, float a, float b) {
    if (op == 0) return A + B * (1.0 - a);
    if (op == 1) return A * (1.0 - b) + B;
    if (op == 2) return A + B;
    if (op == 3) return A - B;
    if (op == 4) return A * B;
    if (op == 5) return A + B - A * B;
    if (op == 6) return max(A, B);
    if (op == 7) return min(A, B);
    if (op == 8) return abs(A - B);
    if (op == 9) return A * b;
    if (op == 10) return A * (1.0 - b);
    if (op == 11) return A * b + B * (1.0 - a);
    if (op == 12) return B * a;
    return B * (1.0 - a);
}
void main() {
    ivec2 q = here();
    vec4 Bv = px(B, bS, q), Av = px(A, aS, ivec2(q.x, q.y - aDy));
    float t = hasM == 1 ? mixv * px(M, mS, ivec2(q.x, q.y - mDy)).a : mixv;
    vec4 r;
    for (int k = 0; k < 4; k++) r[k] = f(op, Av[k], Bv[k], Av.a, Bv.a);
    o = Bv + (r - Bv) * t;
}`,
    // The mask stage: in + (result - in) x mix x the mask's channel (inverted when asked).
    mask: `uniform sampler2D S; uniform ivec2 sS; uniform int sDy; uniform sampler2D R; uniform ivec2 rS;
uniform sampler2D M; uniform ivec2 mS; uniform int mDy; uniform int hasM; uniform int ch; uniform int inv; uniform float mixv;
void main() {
    ivec2 q = here();
    vec4 s = px(S, sS, ivec2(q.x, q.y - sDy)), r = px(R, rS, q);
    float m = 1.0;
    if (hasM == 1) { m = px(M, mS, ivec2(q.x, q.y - mDy))[ch]; if (inv == 1) m = 1.0 - m; }
    o = s + (r - s) * (mixv * m);
}`,
};

const OP_INDEX = Object.fromEntries(C.MERGE_OPS.map((k, i) => [k, i]));

/** A GPU renderer, or null where WebGL2 with float targets is not there. */
export function createCompGpu(doc = document) {
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const progs = {};
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VS);
    const prog = (name) => {
        if (progs[name]) return progs[name];
        const p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, HEAD + FS[name]));
        gl.bindAttribLocation(p, 0, "p");
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
        const loc = {};
        progs[name] = { p, u: (k) => (k in loc ? loc[k] : (loc[k] = gl.getUniformLocation(p, k))) };
        return progs[name];
    };
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const fbo = gl.createFramebuffer();
    // Textures by size, given back after each render (a render makes many of one size).
    const pool = new Map();
    let live = [];
    const texOf = (w, h) => {
        const k = `${w}x${h}`, free = pool.get(k);
        let t = free && free.pop();
        if (!t) {
            t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
            for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
            t.__k = k; t.__w = w; t.__h = h;
        }
        live.push(t);
        return t;
    };
    const release = () => { for (const t of live) { if (!pool.has(t.__k)) pool.set(t.__k, []); pool.get(t.__k).push(t); } live = []; };
    const upload = (img) => {
        const t = texOf(img.w, img.h);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, img.w, img.h, gl.RGBA, gl.FLOAT, img.data);
        return { t, w: img.w, h: img.h };
    };
    // One pass: program `name` into a new w x h texture; `bind(u, unit)` sets uniforms and samplers. Only the
    // rows / columns in `area` are worked (the rest stay 0).
    const pass = (name, w, h, area, set) => {
        const pr = prog(name);
        const out = texOf(w, h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
        gl.viewport(0, 0, w, h);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const a = area ? C.O.boxClip(area, w, h) : [0, 0, w, h];
        if (C.O.boxEmpty(a)) return { t: out, w, h };
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(a[0], a[1], a[2] - a[0], a[3] - a[1]);
        gl.useProgram(pr.p);
        let unit = 0;
        const tex = (name, tx) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tx.t); gl.uniform1i(pr.u(name), unit); unit++; };
        set({ tex, i: (k, v) => gl.uniform1i(pr.u(k), v), f: (k, v) => gl.uniform1f(pr.u(k), v), i2: (k, x, y) => gl.uniform2i(pr.u(k), x, y),
            f4: (k, v) => gl.uniform4f(pr.u(k), v[0], v[1], v[2], v[3]), fv: (k, v) => gl.uniform1fv(pr.u(k), v) });
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.SCISSOR_TEST);
        return { t: out, w, h };
    };
    const readBack = (tx) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx.t, 0);
        const data = new Float32Array(tx.w * tx.h * 4);
        gl.readPixels(0, 0, tx.w, tx.h, gl.RGBA, gl.FLOAT, data);
        return { w: tx.w, h: tx.h, data };
    };

    /** Whether the GPU can do node `id`'s picture: rgba only, and at least one shader node in it. */
    function canRender(comp, id) {
        comp = C.G.flattenComp(comp); id = C.G.resolveId(comp, id);
        let shaders = 0, ok = true;
        const seen = new Set();
        const walk = (nid) => {
            if (!nid || seen.has(nid) || !ok) return;
            seen.add(nid);
            const n = C.nodeById(comp, nid);
            if (!n) return;
            if (C.channelsAt(comp, nid).length) { ok = false; return; }
            if (!n.disable && GPU_TYPES.has(n.type) && n.type !== "output") shaders++;
            for (const s of n.inputs) walk(s);
        };
        walk(id);
        return ok && shaders > 0;
    }

    /**
     * Node `id`'s picture at `frame`, as renderNode makes it (ctx as renderNode's: scale, source, cache ...),
     * with `roi` the region worked. Null when the GPU cannot (the caller renders on the CPU).
     */
    function render(comp, id, frame, ctx, roi = null) {
        comp = C.G.flattenComp(comp); id = C.G.resolveId(comp, id);
        if (!canRender(comp, id)) return null;
        const scale = ctx.scale || 1;
        const W = Math.max(1, Math.round(comp.format.width * scale)), H = Math.max(1, Math.round(comp.format.height * scale));
        const sizeOf = (nid) => { const F = C.formatAt(comp, nid); return [Math.max(1, Math.round(F.width * scale)), Math.max(1, Math.round(F.height * scale))]; };
        if (Math.max(W, H) > maxSize) return null;
        // The area each node's picture is needed over (pixels of that picture), from the region asked for back up the graph.
        const need = new Map();
        const ask = (nid, area) => {
            if (!nid) return;
            const n = C.nodeById(comp, nid);
            if (!n) return;
            const [w, h] = sizeOf(nid);
            const a = area ? C.O.boxClip(area, w, h) : [0, 0, w, h];
            const had = need.get(nid);
            const now = had ? C.O.boxUnion(had, a) : a;
            if (had && had[0] === now[0] && had[1] === now[1] && had[2] === now[2] && had[3] === now[3]) return;
            need.set(nid, now);
            const up = (k, box) => n.inputs[k] && ask(n.inputs[k], box);
            const bl = (k, box) => { const [, h2] = n.inputs[k] ? sizeOf(n.inputs[k]) : [0, 0]; return [box[0], box[1] - (h - h2), box[2], box[3] - (h - h2)]; };
            if (n.disable || !GPU_TYPES.has(n.type)) { for (let k = 0; k < n.inputs.length; k++) up(k, null); return; }
            if (n.type === "blur") {
                const sz = C.paramAt(n, "size", frame) * scale, sig = Math.max(0, sz) / 2;
                const reach = sig > 0 ? C.boxesForGauss(sig).reduce((t, s) => t + ((s - 1) >> 1), 0) + 1 : 0;
                up(0, C.O.boxGrow(now, reach, w, h));
            } else if (n.type === "transform" || n.type === "reformat") {
                const m = n.type === "transform" ? C.transformMatrix(n, frame, C.formatAt(comp, n.inputs[0]), scale) : C.reformatLayout(n, frame, C.formatAt(comp, n.inputs[0]), scale).m;
                const iv = C.mat.inv(m);
                let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
                for (const [x, y] of [[now[0], now[1]], [now[2], now[1]], [now[0], now[3]], [now[2], now[3]]]) {
                    const X = iv[0] * x + iv[2] * y + iv[4], Y = iv[1] * x + iv[3] * y + iv[5];
                    lx = Math.min(lx, X); hx = Math.max(hx, X); ly = Math.min(ly, Y); hy = Math.max(hy, Y);
                }
                up(0, [Math.floor(lx) - 2, Math.floor(ly) - 2, Math.ceil(hx) + 2, Math.ceil(hy) + 2]);
            } else {
                // Per pixel: the same pixels of each input, laid bottom left.
                for (let k = 0; k < n.inputs.length; k++) up(k, bl(k, now));
            }
            if (C.MASKABLE.has(n.type)) { const mi = C.maskIndex(n.type); up(0, bl(0, now)); up(mi, bl(mi, now)); }
        };
        ask(id, roi);
        const memo = new Map();
        const cpu = (nid) => upload(C.renderNode(comp, nid, frame, ctx));
        const blankTex = (w, h) => pass("constant", w, h, [0, 0, 0, 0], () => {});
        const ev = (nid) => {
            if (!nid) return blankTex(W, H);
            if (memo.has(nid)) return memo.get(nid);
            const n = C.nodeById(comp, nid);
            let r;
            if (!n) r = blankTex(W, H);
            else if (n.disable) r = n.inputs.length && n.inputs[0] ? ev(n.inputs[0]) : blankTex(W, H);
            else if (!GPU_TYPES.has(n.type)) r = cpu(nid);
            else r = shade(n);
            if (n && !n.disable && C.MASKABLE.has(n.type)) r = maskStage(n, r);
            memo.set(nid, r);
            return r;
        };
        const area = (n) => need.get(n.id) || null;
        const dyOf = (outH, tx) => outH - tx.h;
        const P = (n, k) => C.paramAt(n, k, frame);
        const shade = (n) => {
            const [w, h] = sizeOf(n.id);
            const A = area(n);
            switch (n.type) {
            case "output": return n.inputs[0] ? ev(n.inputs[0]) : blankTex(W, H);
            case "constant": { const c = P(n, "color") || [0, 0, 0, 1]; return pass("constant", w, h, A, (u) => u.f4("c", c)); }
            case "premult": case "unpremult": { const s = ev(n.inputs[0]); return pass(n.type, s.w, s.h, A, (u) => { u.tex("A", s); u.i2("aS", s.w, s.h); }); }
            case "grade": {
                const p = {};
                for (const k of Object.keys(C.NODE_TYPES.grade.params)) p[k] = P(n, k);
                const gA = (p.multiply * (p.gain - p.lift)) / ((p.whitepoint - p.blackpoint) || 1e-6), gB = p.offset + p.lift - gA * p.blackpoint;
                const s = ev(n.inputs[0]);
                return pass("grade", s.w, s.h, A, (u) => { u.tex("A", s); u.i2("aS", s.w, s.h); u.f("gA", gA); u.f("gB", gB); u.f("gG", 1 / (p.gamma || 1e-6)); u.f("sat", p.saturation); u.f("mixv", p.mix); });
            }
            case "transform": case "reformat": {
                const s = ev(n.inputs[0]), F = C.formatAt(comp, n.inputs[0]);
                let m, ow = s.w, oh = s.h;
                if (n.type === "transform") m = C.transformMatrix(n, frame, F, scale);
                else { const L = C.reformatLayout(n, frame, F, scale); m = L.m; ow = L.w; oh = L.h; }
                const iv = C.mat.inv(m);
                return pass("resample", ow, oh, A, (u) => { u.tex("A", s); u.i2("aS", s.w, s.h); u.fv("iv", Float32Array.from(iv)); });
            }
            case "crop": {
                const s = ev(n.inputs[0]);
                const tl = P(n, "topleft") || [0, 0], F = C.formatAt(comp, n.inputs[0]), br = P(n, "bottomright") || [F.width, F.height];
                return pass("crop", s.w, s.h, A, (u) => { u.tex("A", s); u.i2("aS", s.w, s.h); u.f4("box", [tl[0] * scale, tl[1] * scale, br[0] * scale, br[1] * scale]); u.f("soft", P(n, "softness") * scale); });
            }
            case "blur": {
                let s = ev(n.inputs[0]);
                const sig = Math.max(0, P(n, "size") * scale) / 2;
                if (sig <= 0) return s;
                const grow = (b, r) => (b ? C.O.boxGrow(b, r, s.w, s.h) : null);
                const boxes = C.boxesForGauss(sig);
                let left = boxes.reduce((t, b) => t + 2 * ((b - 1) >> 1), 0);
                for (const b of boxes) {
                    const r = (b - 1) >> 1;
                    // Each pass works what the passes after it still need.
                    left -= r; const s1 = s; s = pass("box", s1.w, s1.h, grow(A, left + 1), (u) => { u.tex("A", s1); u.i2("aS", s1.w, s1.h); u.i("r", r); u.i("horiz", 1); });
                    left -= r; const s2 = s; s = pass("box", s2.w, s2.h, grow(A, left + 1), (u) => { u.tex("A", s2); u.i2("aS", s2.w, s2.h); u.i("r", r); u.i("horiz", 0); });
                }
                return s;
            }
            case "merge": {
                const Bt = n.inputs[0] ? ev(n.inputs[0]) : blankTex(W, H);
                if (!C.mergeLive(n, frame)) return Bt;
                const At = n.inputs[1] ? ev(n.inputs[1]) : blankTex(W, H);
                const Mt = n.inputs[2] ? ev(n.inputs[2]) : null;
                return pass("merge", Bt.w, Bt.h, A, (u) => {
                    u.tex("B", Bt); u.i2("bS", Bt.w, Bt.h); u.tex("A", At); u.i2("aS", At.w, At.h); u.i("aDy", dyOf(Bt.h, At));
                    u.tex("M", Mt || At); u.i2("mS", (Mt || At).w, (Mt || At).h); u.i("mDy", dyOf(Bt.h, Mt || At)); u.i("hasM", Mt ? 1 : 0);
                    u.i("op", OP_INDEX[n.operation || "over"] ?? 0); u.f("mixv", P(n, "mix"));
                });
            }
            default: return cpu(n.id);
            }
        };
        const maskStage = (n, r) => {
            const mix = C.OWN_MIX.has(n.type) ? 1 : P(n, "mix");
            const mi = n.inputs[C.maskIndex(n.type)];
            if (!mi && mix === 1) return r;
            const s = n.inputs[0] ? ev(n.inputs[0]) : blankTex(r.w, r.h);
            const M = mi ? ev(mi) : null;
            const ch = { r: 0, g: 1, b: 2, a: 3 }[n.mask_channel || "a"] ?? 3;
            return pass("mask", r.w, r.h, area(n), (u) => {
                u.tex("S", s); u.i2("sS", s.w, s.h); u.i("sDy", dyOf(r.h, s)); u.tex("R", r); u.i2("rS", r.w, r.h);
                u.tex("M", M || r); u.i2("mS", (M || r).w, (M || r).h); u.i("mDy", dyOf(r.h, M || r)); u.i("hasM", M ? 1 : 0);
                u.i("ch", ch); u.i("inv", (n.mask_invert || "off") === "on" ? 1 : 0); u.f("mixv", mix);
            });
        };
        try {
            const out = readBack(ev(id));
            if (roi) out.roi = need.get(id);
            out.ch = {};
            return out;
        } finally {
            release();
        }
    }
    return { gl, canRender, render, maxSize, dispose: () => { const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } };
}
