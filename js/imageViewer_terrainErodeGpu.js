// imageViewer_terrainErodeGpu.js
// The erosion of imageViewer_terrainErode.js on the GPU: the same passes, one fragment shader
// each, over float render targets the size of the terrain's vertex grid, ping-ponged. The CPU
// file is the reference; tests/test_terrain_erode_browser.py runs both and compares them.
//
// Targets (RGBA float, n x n): S = (ground, water, sediment, -), F = the four outflows
// (left, right, up = y-1, down = y+1), V = (u, v, -, -) water velocity, M = the masks
// (flow, deposited, eroded, deepest water).

import { cleanErode, GRAVITY, BANK_ANGLE, BANK_RATE } from "./imageViewer_terrainErode.js";

const VERT = `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Shared: texel fetches with the edge rules of the CPU version.
const HEAD = `
precision highp float;
precision highp int;
layout(location = 0) out highp vec4 fragOut;
uniform int uN;
uniform float uDt;
ivec2 cell() { return ivec2(gl_FragCoord.xy); }
bool inside(ivec2 p) { return p.x >= 0 && p.y >= 0 && p.x < uN && p.y < uN; }
vec4 clampFetch(sampler2D t, ivec2 p) { return texelFetch(t, clamp(p, ivec2(0), ivec2(uN - 1)), 0); }
`;

const RAIN = HEAD + `
uniform sampler2D uS; uniform float uRain;
void main() { vec4 s = texelFetch(uS, cell(), 0); s.y += uDt * uRain; fragOut = s; }`;

const FLUX = HEAD + `
uniform sampler2D uS; uniform sampler2D uF; uniform float uG;
float lvl(ivec2 p, float own) { if (!inside(p)) return own; vec4 s = texelFetch(uS, p, 0); return s.x + s.y; }
void main() {
    ivec2 c = cell(); vec4 s = texelFetch(uS, c, 0); vec4 f = texelFetch(uF, c, 0);
    float H = s.x + s.y;
    float fl = max(0.0, f.x + uDt * uG * (H - lvl(c + ivec2(-1, 0), s.x)));
    float fr = max(0.0, f.y + uDt * uG * (H - lvl(c + ivec2(1, 0), s.x)));
    float fu = max(0.0, f.z + uDt * uG * (H - lvl(c + ivec2(0, -1), s.x)));
    float fd = max(0.0, f.w + uDt * uG * (H - lvl(c + ivec2(0, 1), s.x)));
    float sum = fl + fr + fu + fd;
    float k = sum > 0.0 ? min(1.0, s.y / (sum * uDt)) : 0.0;
    fragOut = vec4(fl, fr, fu, fd) * k;
}`;

const FLOWIN = `
float fin(ivec2 p, int k) { if (!inside(p)) return 0.0; return texelFetch(uF, p, 0)[k]; }
`;

const WATER = HEAD + `
uniform sampler2D uS; uniform sampler2D uF;` + FLOWIN + `
void main() {
    ivec2 c = cell(); vec4 s = texelFetch(uS, c, 0); vec4 f = texelFetch(uF, c, 0);
    float inflow = fin(c + ivec2(-1, 0), 1) + fin(c + ivec2(1, 0), 0) + fin(c + ivec2(0, -1), 3) + fin(c + ivec2(0, 1), 2);
    float outflow = f.x + f.y + f.z + f.w;
    s.y = max(0.0, s.y + uDt * (inflow - outflow));
    fragOut = s;
}`;

const VELOCITY = HEAD + `
uniform sampler2D uS1; uniform sampler2D uS2; uniform sampler2D uF;` + FLOWIN + `
void main() {
    ivec2 c = cell(); vec4 f = texelFetch(uF, c, 0);
    float wx = (fin(c + ivec2(-1, 0), 1) - f.x + f.y - fin(c + ivec2(1, 0), 0)) * 0.5;
    float wy = (fin(c + ivec2(0, -1), 3) - f.z + f.w - fin(c + ivec2(0, 1), 2)) * 0.5;
    float dm = (texelFetch(uS1, c, 0).y + texelFetch(uS2, c, 0).y) * 0.5;
    fragOut = dm > 1e-4 ? vec4(wx / dm, wy / dm, 0.0, 0.0) : vec4(0.0);
}`;

// What one cell erodes (a > 0) or deposits (a < 0) this step: both the ERODE and MASKS passes.
const AMOUNT = `
uniform sampler2D uS; uniform sampler2D uV;
uniform float uCap; uniform float uDis; uniform float uDep; uniform float uMinSlope;
float amount(ivec2 c, vec4 s, float speed) {
    float gx = (clampFetch(uS, c + ivec2(1, 0)).x - clampFetch(uS, c + ivec2(-1, 0)).x) * 0.5;
    float gy = (clampFetch(uS, c + ivec2(0, 1)).x - clampFetch(uS, c + ivec2(0, -1)).x) * 0.5;
    float g2 = gx * gx + gy * gy;
    float sn = sqrt(g2 / (1.0 + g2));
    float cap = uCap * max(sn, uMinSlope) * speed * min(1.0, s.y * 4.0);
    if (cap > s.z) {
        float lo = s.x;
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            lo = min(lo, clampFetch(uS, c + ivec2(dx, dy)).x);
        }
        return min(uDt * uDis * (cap - s.z), max(0.0, s.x - lo));
    }
    return -uDt * uDep * (s.z - cap);
}
`;

const ERODE = HEAD + AMOUNT + `
void main() {
    ivec2 c = cell(); vec4 s = texelFetch(uS, c, 0); vec4 v = texelFetch(uV, c, 0);
    float a = amount(c, s, length(v.xy));
    s.x -= a; s.z += a;
    fragOut = s;
}`;

const MASKS = HEAD + AMOUNT + `
uniform sampler2D uM;
void main() {
    ivec2 c = cell(); vec4 s = texelFetch(uS, c, 0); vec4 v = texelFetch(uV, c, 0); vec4 m = texelFetch(uM, c, 0);
    float speed = length(v.xy);
    float a = amount(c, s, speed);
    m.x += speed * s.y * uDt;
    if (a > 0.0) m.z += a; else m.y -= a;
    m.w = max(m.w, s.y);
    fragOut = m;
}`;

const ADVECT = HEAD + `
uniform sampler2D uS; uniform sampler2D uV; uniform float uEvap;
void main() {
    ivec2 c = cell(); vec4 s = texelFetch(uS, c, 0); vec4 v = texelFetch(uV, c, 0);
    float n1 = float(uN - 1);
    float px = float(c.x) - v.x * uDt, py = float(c.y) - v.y * uDt;
    float sed = 0.0;
    if (px >= 0.0 && py >= 0.0 && px <= n1 && py <= n1) {
        int x0 = min(uN - 2, int(floor(px))), y0 = min(uN - 2, int(floor(py)));
        float tx = px - float(x0), ty = py - float(y0);
        sed = (texelFetch(uS, ivec2(x0, y0), 0).z * (1.0 - tx) + texelFetch(uS, ivec2(x0 + 1, y0), 0).z * tx) * (1.0 - ty)
            + (texelFetch(uS, ivec2(x0, y0 + 1), 0).z * (1.0 - tx) + texelFetch(uS, ivec2(x0 + 1, y0 + 1), 0).z * tx) * ty;
    }
    fragOut = vec4(s.x, s.y * max(0.0, 1.0 - uEvap * uDt), sed, 0.0);
}`;

const THERMAL = HEAD + `
uniform sampler2D uS; uniform float uTan; uniform float uK;
void main() {
    ivec2 c = cell(); vec4 s = texelFetch(uS, c, 0);
    float h = s.x, delta = 0.0;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        ivec2 p = c + ivec2(dx, dy);
        if (!inside(p)) continue;
        float hn = texelFetch(uS, p, 0).x;
        float lim = uTan * ((dx != 0 && dy != 0) ? 1.41421356237 : 1.0);
        delta += max(0.0, hn - h - lim) - max(0.0, h - hn - lim);
    }
    s.x = h + delta * uK * 0.5;
    fragOut = s;
}`;

/** Whether this renderer can run the erosion (float render targets). */
export function erodeGpuOk(renderer) {
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) return false;
    return !!renderer.extensions.get("EXT_color_buffer_float");
}

export class TerrainErodeGpu {
    /** `b`: n x n ground heights in grid units (row y, column x). */
    constructor(THREE, renderer, n, b, opts) {
        this.THREE = THREE;
        this.renderer = renderer;
        this.n = n;
        this.opts = cleanErode(opts);
        this.steps = 0;
        const rt = () => new THREE.WebGLRenderTarget(n, n, {
            type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
        });
        this.S = [rt(), rt(), rt()];
        this.F = [rt(), rt()];
        this.V = rt();
        this.M = [rt(), rt()];
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this.quad.frustumCulled = false;
        this.scene.add(this.quad);
        const mat = (frag, uniforms) => new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag,
            uniforms: { uN: { value: n }, uDt: { value: this.opts.dt }, ...uniforms }, depthTest: false, depthWrite: false,
        });
        const t = () => ({ value: null });
        this.mats = {
            rain: mat(RAIN, { uS: t(), uRain: { value: 0 } }),
            flux: mat(FLUX, { uS: t(), uF: t(), uG: { value: GRAVITY } }),
            water: mat(WATER, { uS: t(), uF: t() }),
            velocity: mat(VELOCITY, { uS1: t(), uS2: t(), uF: t() }),
            erode: mat(ERODE, { uS: t(), uV: t(), uCap: { value: 0 }, uDis: { value: 0 }, uDep: { value: 0 }, uMinSlope: { value: 0 } }),
            masks: mat(MASKS, { uS: t(), uV: t(), uM: t(), uCap: { value: 0 }, uDis: { value: 0 }, uDep: { value: 0 }, uMinSlope: { value: 0 } }),
            advect: mat(ADVECT, { uS: t(), uV: t(), uEvap: { value: 0 } }),
            thermal: mat(THERMAL, { uS: t(), uTan: { value: 0 }, uK: { value: 0 } }),
        };
        this.setOptions(opts);
        // The start: ground in S, everything else zero.
        const data = new Float32Array(n * n * 4);
        for (let i = 0; i < n * n; i++) data[i * 4] = b[i];
        const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.FloatType);
        tex.needsUpdate = true;
        this._withState(() => {
            const copy = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT,
                fragmentShader: HEAD + "uniform sampler2D uS; void main() { fragOut = texelFetch(uS, cell(), 0); }",
                uniforms: { uN: { value: n }, uDt: { value: 0 }, uS: { value: tex } } });
            this._pass(copy, this.S[0]);
            const zero = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT,
                fragmentShader: HEAD + "void main() { fragOut = vec4(0.0); }" });
            for (const r of [this.F[0], this.F[1], this.V, this.M[0], this.M[1]]) this._pass(zero, r);
            copy.dispose(); zero.dispose();
        });
        tex.dispose();
        this.si = 0; this.fi = 0; this.mi = 0;
    }

    setOptions(opts) {
        const o = this.opts = cleanErode({ ...this.opts, ...opts });
        for (const m of Object.values(this.mats)) m.uniforms.uDt.value = o.dt;
        this.mats.rain.uniforms.uRain.value = o.rain;
        for (const k of ["erode", "masks"]) {
            const u = this.mats[k].uniforms;
            u.uCap.value = o.capacity; u.uDis.value = o.dissolve; u.uDep.value = o.deposit; u.uMinSlope.value = o.minSlope;
        }
        this.mats.advect.uniforms.uEvap.value = o.evaporation;
    }

    _pass(material, target) {
        this.quad.material = material;
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, this.camera);
    }

    /** The renderer's own state put back after `fn` (the view draws with viewport / scissor per pane). */
    _withState(fn) {
        const r = this.renderer, THREE = this.THREE;
        const target = r.getRenderTarget();
        const vp = r.getViewport(new THREE.Vector4()), sc = r.getScissor(new THREE.Vector4()), sct = r.getScissorTest();
        const auto = r.autoClear, xr = r.xr && r.xr.enabled;
        r.setScissorTest(false);
        r.autoClear = false;
        if (r.xr) r.xr.enabled = false;
        try { fn(); } finally {
            r.setRenderTarget(target);
            r.setViewport(vp); r.setScissor(sc); r.setScissorTest(sct);
            r.autoClear = auto;
            if (r.xr) r.xr.enabled = xr;
        }
    }

    /** `count` steps of the simulation. */
    step(count = 1) {
        const o = this.opts, m = this.mats;
        this._withState(() => {
            for (let k = 0; k < count; k++) {
                if (o.mode !== "thermal") this._hydraulic();
                if (o.mode !== "hydraulic") this._thermal(o.talus, o.thermal);
                this.steps += 1;
            }
        });
        return this;
    }

    _next(i) { return (i + 1) % 3; }

    _hydraulic() {
        const m = this.mats, S = this.S;
        let a = this.si;
        const b = this._next(a), c = this._next(b);
        // rain: S[a] -> S[b]
        m.rain.uniforms.uS.value = S[a].texture; this._pass(m.rain, S[b]);
        // flux: S[b], F -> F'
        m.flux.uniforms.uS.value = S[b].texture; m.flux.uniforms.uF.value = this.F[this.fi].texture;
        this.fi = 1 - this.fi; this._pass(m.flux, this.F[this.fi]);
        const F = this.F[this.fi].texture;
        // water: S[b] -> S[c]; velocity from S[b] (before) and S[c] (after)
        m.water.uniforms.uS.value = S[b].texture; m.water.uniforms.uF.value = F; this._pass(m.water, S[c]);
        m.velocity.uniforms.uS1.value = S[b].texture; m.velocity.uniforms.uS2.value = S[c].texture;
        m.velocity.uniforms.uF.value = F; this._pass(m.velocity, this.V);
        // masks and erosion both read S[c] (water moved, ground as it was)
        m.masks.uniforms.uS.value = S[c].texture; m.masks.uniforms.uV.value = this.V.texture;
        m.masks.uniforms.uM.value = this.M[this.mi].texture; this.mi = 1 - this.mi; this._pass(m.masks, this.M[this.mi]);
        m.erode.uniforms.uS.value = S[c].texture; m.erode.uniforms.uV.value = this.V.texture; this._pass(m.erode, S[a]);
        // advect + evaporate: S[a] -> S[b]
        m.advect.uniforms.uS.value = S[a].texture; m.advect.uniforms.uV.value = this.V.texture; this._pass(m.advect, S[b]);
        this.si = b;
        this._thermal(BANK_ANGLE, BANK_RATE);
    }

    _thermal(talus, rate) {
        const m = this.mats.thermal, a = this.si, b = this._next(a);
        m.uniforms.uS.value = this.S[a].texture;
        m.uniforms.uTan.value = Math.tan(talus * Math.PI / 180);
        m.uniforms.uK.value = Math.min(1, this.opts.dt * rate) / 8;
        this._pass(m, this.S[b]);
        this.si = b;
    }

    /** The state read back: {b, d, s} (n x n each) and, with `masks`, {flow, dep, ero, wet}. */
    read(masks = false) {
        const n = this.n, buf = new Float32Array(n * n * 4);
        const out = { n, b: new Float32Array(n * n), d: new Float32Array(n * n), s: new Float32Array(n * n), steps: this.steps };
        this._withState(() => this.renderer.readRenderTargetPixels(this.S[this.si], 0, 0, n, n, buf));
        for (let i = 0; i < n * n; i++) { out.b[i] = buf[i * 4]; out.d[i] = buf[i * 4 + 1]; out.s[i] = buf[i * 4 + 2]; }
        if (masks) {
            this._withState(() => this.renderer.readRenderTargetPixels(this.M[this.mi], 0, 0, n, n, buf));
            for (const k of ["flow", "dep", "ero", "wet"]) out[k] = new Float32Array(n * n);
            for (let i = 0; i < n * n; i++) {
                out.flow[i] = buf[i * 4]; out.dep[i] = buf[i * 4 + 1]; out.ero[i] = buf[i * 4 + 2]; out.wet[i] = buf[i * 4 + 3];
            }
        }
        return out;
    }

    dispose() {
        for (const r of [...this.S, ...this.F, this.V, ...this.M]) r.dispose();
        for (const m of Object.values(this.mats)) m.dispose();
        this.quad.geometry.dispose();
    }
}
