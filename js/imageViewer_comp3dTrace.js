// imageViewer_comp3dTrace.js
// Render3D's "path traced" renderer (Sebastian 2026-11-23: the plan's phase 4): the same scene the raster renderer
// draws (imageViewer_comp3dEngine.js) traced by the 3D space's path tracer (three-gpu-pathtracer, MIT, vendored) and
// read back as a float picture - scene-linear and premultiplied like the rest of Comp: rays that hit nothing count
// as transparent black, so the alpha is each pixel's share of rays that hit something.
//
// renderNode is synchronous and a trace takes many frames, so a trace is a JOB of the engine's, keyed by the
// Render3D node, its frame and everything upstream (the model's key): render3d asks `traced(key)` and, until the
// job is done, draws the raster picture and starts `trace()`; when it is done the engine's `sig` changes (every 3D
// node's cache key holds it) and the editor draws again, now with the traced picture. A Write job's frames
// (editor.render3dFrame) wait for their traces. One job at a time: a newer key stops the running one.
//
// How Comp's objects are traced. The tracer reads ordinary three.js materials only, so:
// - a Card / Shape with a picture and no light in the scene is EMISSIVE (black albedo, the picture as its emissive
//   map): it shows its picture as it is, as the raster renderer's unlit look does, and lights what is around it;
//   with lights it is a plain diffuse surface whose albedo is its picture;
// - the tracer keeps textures at 8 bits, so a picture brighter than 1 is scaled down into its map and its
//   emissive intensity carries the scale back;
// - a picture is straight in the map (premultiplied / alpha) and its alpha is the surface's coverage;
// - a Projection is baked first: each triangle of the mesh gets a cell of its own in a texture (a card keeps its
//   own uv), the projection drawn into it with the raster renderer's arithmetic, and that texture is its map.
// The tracer's own limits stay: splats, point clouds and ambient lights are not traced.
import { loadPathTracer, ptMissing } from "./imageViewer_view3dPathTrace.js";
import { downsample } from "./imageViewer_comp3dEngine.js";

export const TRACE_KEEP = 16;
const BAKE_SIDE = 1024;

const BAKE_VERT = `
attribute vec2 auv;
attribute vec3 fnormal;
varying vec3 vWorld;
varying vec3 vFn;
void main() {
    vWorld = position;
    vFn = fnormal;
    gl_Position = vec4(auv * 2.0 - 1.0, 0.0, 1.0);
}`;
const BAKE_FRAG = `
uniform sampler2D map;
uniform mat4 projView;
uniform float pk;
uniform float pky;
uniform float psx;
uniform vec3 projPos;
uniform bool frontOnly;
varying vec3 vWorld;
varying vec3 vFn;
void main() {
    vec4 q = projView * vec4(vWorld, 1.0);
    float d = -q.z;
    vec2 uv = vec2((pk * q.x / d + psx + 1.0) * 0.5, (pky * q.y / d + 1.0) * 0.5);
    bool off = d <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
    if (frontOnly && dot(vFn, projPos - vWorld) <= 0.0) off = true;
    gl_FragColor = off ? vec4(0.0) : texture2D(map, uv);
}`;

/** Each triangle of a mesh its own cell of a square texture: [u, v] per corner (3 per triangle). */
export function atlasUvs(nt) {
    const c = Math.max(1, Math.ceil(Math.sqrt(nt))), s = 1 / c, pad = s * 0.08;
    const out = new Float32Array(nt * 6);
    for (let t = 0; t < nt; t++) {
        const x = (t % c) * s, y = Math.floor(t / c) * s;
        out.set([x + pad, y + pad, x + s - pad * 2, y + pad, x + pad, y + s - pad * 2], t * 6);
    }
    return out;
}

/**
 * A premultiplied float picture (rows bottom-up, as a texture holds them) as a straight one fit for 8 bits:
 * {data, gain} - the colour divided by the alpha and by `gain`, the brightest colour value (at least 1).
 */
export function straightForMap(src) {
    const data = new Float32Array(src.length);
    let gain = 1;
    for (let i = 0; i < src.length; i += 4) {
        const a = src[i + 3];
        if (a > 1e-6) for (let k = 0; k < 3; k++) { const v = src[i + k] / a; if (v > gain) gain = v; }
    }
    for (let i = 0; i < src.length; i += 4) {
        const a = Math.max(0, Math.min(1, src[i + 3]));
        const div = src[i + 3] > 1e-6 ? src[i + 3] * gain : 1;
        data[i] = Math.max(0, src[i] / div); data[i + 1] = Math.max(0, src[i + 1] / div); data[i + 2] = Math.max(0, src[i + 2] / div);
        data[i + 3] = a;
    }
    return { data, gain };
}

export const TraceMixin = {
    /** The traced picture of `key` when its job is done, else null. */
    traced(key) {
        const t = this._tracedDone && this._tracedDone.get(key);
        if (!t) return null;
        this._tracedDone.delete(key); this._tracedDone.set(key, t);   // kept as used last
        return t;
    },

    /** The running (or done) job of `key`: a promise of {img} or null. */
    tracing(key) { return this._traceJob && this._traceJob.key === key ? this._traceJob.promise : null; },

    /** Why the tracer cannot run here ("" when it can, or before it was tried). */
    get traceWhy() { return this._traceWhy || ""; },

    async _tracer() {
        if (this._pt) return this._pt;
        const R = this.view && this.view.renderer;
        if (!R) return null;
        const missing = ptMissing(R.getContext && R.getContext());
        if (missing) { this._traceWhy = missing; return null; }
        let lib;
        try { lib = await loadPathTracer(); } catch (e) { this._traceWhy = "the path tracer could not be loaded"; return null; }
        if (this._pt) return this._pt;
        const pt = new lib.WebGLPathTracer(R);
        pt.renderToCanvas = false;
        pt.synchronizeRenderSize = false;
        pt.rasterizeScene = false;
        pt.dynamicLowRes = false;
        pt.renderDelay = 0;
        pt.minSamples = 1;
        pt.fadeDuration = 0;
        pt.filterGlossyFactor = 0.5;
        pt.tiles.set(2, 2);
        this._pt = pt;
        return pt;
    },

    /**
     * Trace `objs` through `cam` at W x H: {samples, bounces, key, onSample(done, of)} -> a promise of
     * {img: {w, h, data}} (premultiplied, scene-linear, rows top-down) or null. A newer key stops this one.
     */
    trace(objs, cam, W, H, { samples = 64, bounces = 5, key = "", onSample = null } = {}) {
        if (this._traceJob && this._traceJob.key === key) return this._traceJob.promise;
        if (this._traceJob) this._traceJob.stop = true;
        const job = { key, stop: false, promise: null };
        const before = this._traceJob;
        this._traceJob = job;
        job.promise = (async () => {
            if (before) await before.promise.catch(() => null);
            if (job.stop) return null;
            // How far it is, for the viewer's info line (redrawn now and then while it runs).
            let shown = 0;
            const tell = (done, of) => {
                this.traceProgress = { done, of };
                if (onSample) onSample(done, of);
                const now = performance.now();
                if (now - shown > 500 && this.onProgress) { shown = now; this.onProgress(); }
            };
            this._traceWhy = "";
            const out = await this._traceRun(objs, cam, W, H, samples, bounces, job, tell).catch((e) => {
                console.warn("[ImageViewer] Comp's path traced render failed", e);
                this._traceWhy = String((e && e.message) || e).split("\n")[0];
                return null;
            });
            if (this._traceJob === job) { this._traceJob = null; this.traceProgress = null; }
            if (out && !job.stop) {
                this._tracedDone = this._tracedDone || new Map();
                this._tracedDone.set(key, out);
                while (this._tracedDone.size > TRACE_KEEP) this._tracedDone.delete(this._tracedDone.keys().next().value);
                this._rev++;
                if (this.onChange) this.onChange();
            }
            return out;
        })();
        return job.promise;
    },

    /** A texture of the tracer's kind from a premultiplied Comp picture: {tex, gain}. */
    _traceTex(THREE, img) {
        const W = img.w, H = img.h, src = new Float32Array(W * H * 4);
        for (let y = 0; y < H; y++) src.set(img.data.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
        return this._traceTexFrom(THREE, src, W, H);
    },

    _traceTexFrom(THREE, src, W, H) {
        const { data, gain } = straightForMap(src);
        const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.NoColorSpace;
        tex.flipY = false;
        tex.needsUpdate = true;
        return { tex, gain };
    },

    /** A projection drawn into a texture laid on `geo`'s uv (a card) or an atlas of its triangles. */
    _traceBake(THREE, ob, geo) {
        const R = this.view.renderer, nt = geo.attributes.position.count / 3;
        const auv = nt <= 2 ? geo.attributes.uv.array.slice() : atlasUvs(nt);
        geo.setAttribute("auv", new THREE.BufferAttribute(auv, 2));
        const side = BAKE_SIDE, rt = new THREE.WebGLRenderTarget(side, side, { type: THREE.FloatType, format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
        const src = this._texture(THREE, ob.proj.img), c = ob.proj.cam;
        const m = new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.DoubleSide,
            depthTest: false, depthWrite: false, blending: THREE.NoBlending,
            uniforms: { map: { value: src }, projView: { value: new THREE.Matrix4().set(...c.view) }, pk: { value: c.k },
                pky: { value: c.ky }, psx: { value: c.sx }, projPos: { value: new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]) },
                frontOnly: { value: ob.faces === "front" } } });
        const mesh = new THREE.Mesh(geo, m);
        mesh.frustumCulled = false;
        const sc = new THREE.Scene(), cam = new THREE.Camera();
        sc.add(mesh);
        const before = R.getRenderTarget(), clear = R.getClearColor(new THREE.Color()), ca = R.getClearAlpha();
        const px = new Float32Array(side * side * 4);
        try {
            R.setRenderTarget(rt);
            R.setClearColor(0x000000, 0);
            R.clear(true, false, false);
            R.render(sc, cam);
            R.readRenderTargetPixels(rt, 0, 0, side, side, px);
        } finally {
            R.setRenderTarget(before);
            R.setClearColor(clear, ca);
            m.dispose(); rt.dispose();
        }
        geo.setAttribute("uv", new THREE.BufferAttribute(auv, 2));
        return this._traceTexFrom(THREE, px, side, side);
    },

    async _traceRun(objs, cam, W, H, samples, bounces, job, onSample) {
        if (!this.ready || !this.view) return null;
        const pt = await this._tracer();
        if (!pt || job.stop) return null;
        const v = this.view, { THREE } = v.libs, R = v.renderer;
        W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));

        // The scene as render() stages it, only as long as the tracer takes to read it (setScene copies the
        // geometry, materials, textures, lights and camera): the tracing itself runs on its own copies.
        const files = objs.filter((o) => o.kind === "scenefile");
        const on = new Set(files.map((o) => o.id));
        if (files.length) v.applyFrame(files[0].frame);
        const restore = [];
        const hide = (o) => { if (o && o.visible) { o.visible = false; restore.push(o); } };
        for (const [id, entry] of v._entries) {
            const root = entry.top || entry.root;
            if (root && !on.has(String(id).split("::")[0])) hide(root);
        }
        const sceneLights = files.length > 0 && [...v._entries.values()].some((e) => e.item && e.item.kind === "light" && on.has(String(e.item.id).split("::")[0]));
        const lights = objs.filter((o) => o.kind === "light");
        const lit = lights.length > 0 || sceneLights;
        const group = new THREE.Group();
        group.name = "comp3d-trace";
        const textures = [];
        for (const ob of objs) {
            if (ob.kind === "mesh") {
                const g = this._meshOf(THREE, ob);
                const t = ob.proj ? this._traceBake(THREE, ob, g) : ob.tex ? this._traceTex(THREE, ob.tex) : null;
                if (t) textures.push(t.tex);
                const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide });
                if (t) { mat.map = t.tex; mat.transparent = true; }
                if (!lit && t) { mat.color.setRGB(0, 0, 0); mat.emissive.setRGB(1, 1, 1); mat.emissiveMap = t.tex; mat.emissiveIntensity = t.gain; }
                else if (!lit) { mat.color.setRGB(0, 0, 0); mat.emissive.setRGB(1, 1, 1); }
                else if (t && t.gain > 1) mat.color.setScalar(Math.min(1, t.gain));
                const mesh = new THREE.Mesh(g, mat);
                mesh.frustumCulled = false;
                group.add(mesh);
            } else if (ob.kind === "light") group.add(this._lightOf(THREE, ob));
        }
        v.scene.add(group);
        const keepRendering = v._rendering;
        v._rendering = { opts: { grid: false, helpers: false }, restore: [] };
        v._renderHideOverlays();
        const overlays = v._rendering.restore;
        if (v._lightsFrame) v._lightsFrame();
        if (lights.length || !files.length) for (const l of v.lights || []) hide(l);
        hide(v.grid); hide(v.gridOrigin);
        if (this._room) { hide(this._room.group); hide(this._room.helper); }
        v.scene.traverse((o) => {
            if (o === v.scene || !o.visible) return;
            if ((o.userData && (o.userData.imageViewerSplat || o.userData.imageViewerSplatBounds)) || o.name === "splatbounds" || o === v._spark
                || o.isLine || o.isPoints || o.isSprite) hide(o);
        });
        const camera = new THREE.PerspectiveCamera();
        camera.matrixAutoUpdate = false;
        camera.matrixWorldAutoUpdate = false;
        camera.matrixWorld.copy(new THREE.Matrix4().set(...cam.world));
        camera.matrix.copy(camera.matrixWorld);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        const n = Math.max(1e-6, cam.near), f = Math.max(n * 1.0001, cam.far);
        camera.projectionMatrix.set(cam.k, 0, -cam.sx, 0, 0, cam.ky, 0, 0, 0, 0, -(f + n) / (f - n), -2 * f * n / (f - n), 0, 0, -1, 0);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        const background = v.scene.background;
        try {
            v.scene.background = null;
            pt.bounces = Math.max(1, Math.min(32, Math.round(bounces) || 1));
            pt._pathTracer.setSize(W, H);
            pt._lowResPathTracer.setSize(Math.max(1, W >> 2), Math.max(1, H >> 2));
            pt.setScene(v.scene, camera);
        } finally {
            v.scene.background = background;
            for (let i = overlays.length - 1; i >= 0; i--) { const [obj, k, value] = overlays[i]; obj[k] = value; }
            v._rendering = keepRendering;
            for (const o of restore) o.visible = true;
            v.scene.remove(group);
            group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        }

        // The samples, a few tiles a frame, yielding to the page in between.
        const want = Math.max(1, Math.round(samples));
        const win = this.doc.defaultView || window;
        pt.reset();
        pt.pausePathTracing = false;
        let guard = 0, last = performance.now();
        while (pt.samples < want) {
            if (job.stop) { for (const t of textures) t.dispose(); return null; }
            pt.renderSample();
            if (pt.isCompiling) {
                await new Promise((res) => win.setTimeout(res, 40));
                if (++guard > 1500) throw new Error("the path tracer did not compile");
                continue;
            }
            if (onSample) onSample(Math.floor(pt.samples), want);
            if (performance.now() - last > 24) { await new Promise((res) => win.setTimeout(res, 0)); last = performance.now(); }
        }
        const px = new Float32Array(W * H * 4);
        R.readRenderTargetPixels(pt.target, 0, 0, W, H, px);
        for (const t of textures) t.dispose();
        // No background seen by a ray: its share of the pixel is transparent black.
        if (pt._pathTracer.material.backgroundAlpha !== 0) for (let i = 3; i < px.length; i += 4) px[i] = 1;
        return { img: downsample(px, W, H, 1), samples: Math.floor(pt.samples) };
    },

    traceDispose() {
        if (this._traceJob) this._traceJob.stop = true;
        if (this._pt) { try { this._pt.dispose(); } catch (_) { /* gone */ } this._pt = null; }
        if (this._tracedDone) this._tracedDone.clear();
    },
};
