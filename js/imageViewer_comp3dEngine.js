// imageViewer_comp3dEngine.js
// Comp's 3D nodes drawn by the 3D space's own renderer (Sebastian 2026-11-23: "enable Comp to use the 3D space's
// 3D room through its 3D nodes"). The nodes stay Comp's - Camera, Card, Shape, Project, Scene, PointCloud, Light,
// SceneFile, Render3D - and each is a thin wrapper: renderNode (imageViewer_compModel.js) gathers what they make
// as objects (sceneOf: meshes in world space with their pictures, points, lights, SceneFiles) and a camera
// (comp3d.cameraAt), and Render3D hands them to render() here, which draws them with a Model3DView of its own -
// the 3D space's viewport class, its scene, its models, splats, lights and world - and reads the picture back.
//
// The picture is SCENE-LINEAR and PREMULTIPLIED, as everything else in Comp: rendered into a float target (three
// applies neither tone mapping nor the output colour space to a render target), cleared to transparent black,
// Comp's pictures uploaded as they are (linear, premultiplied) and laid with "over" (ONE, ONE_MINUS_SRC_ALPHA).
// Antialiasing is supersampling, n x n samples a pixel, as Comp's own renderer does. depth.z is the planar
// distance to the nearest surface that covers a pixel (0: nothing), Comp's rule.
//
// Unlit unless the scene has lights: a Card shows its picture as it is (Comp's renderer's look); with a Light node
// (or a SceneFile's lights) cards and shapes are lit (diffuse; a light's intensity 1 at right angles gives the
// picture's own colour). A Projection is always unlit. A SceneFile wired to a Project (or a picture) puts it on its
// own meshes (all of them, or the ones its `objects` names) for the draw, unlit too; see sceneFileMeshes.
//
// render() is synchronous (renderNode is): everything slow - three.js, the models of a SceneFile - is made ready
// before the draw by ensure() and prepareScene(), which the editor awaits with the Reads (sourceNeeds' `engine` and
// `scene` needs). `sig` changes whenever what render() would draw changes for other reasons than its arguments, and
// is part of every 3D node's cache key.
import { Model3DView } from "./imageViewer_model3d.js";
import { MODEL_IMPORT_EXTS, makeModelItem, parseScene } from "./imageViewer_scene3d.js";
import { RoomMixin } from "./imageViewer_comp3dRoom.js";

const MAX_SAMPLES = 4;

// One unlit material for Comp's meshes: a picture (premultiplied), white without one, or a picture projected
// through a camera of Comp's (comp3d.project's arithmetic). The depth variant writes the planar depth where the
// surface covers (alpha > 0) and nothing elsewhere.
const VERT = `
attribute vec3 fnormal;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vFn;
varying float vDepth;
void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vFn = fnormal;
    vec4 mv = viewMatrix * w;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform sampler2D map;
uniform bool hasMap;
uniform bool proj;
uniform mat4 projView;
uniform float pk;
uniform float pky;
uniform float psx;
uniform vec3 projPos;
uniform bool frontOnly;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vFn;
varying float vDepth;
void main() {
    vec4 c = vec4(1.0);
    if (proj) {
        vec4 q = projView * vec4(vWorld, 1.0);
        float d = -q.z;
        vec2 uv = vec2((pk * q.x / d + psx + 1.0) * 0.5, (pky * q.y / d + 1.0) * 0.5);
        bool off = d <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
        if (frontOnly && dot(vFn, projPos - vWorld) <= 0.0) off = true;
        c = off ? vec4(0.0) : texture2D(map, uv);
    } else if (hasMap) c = texture2D(map, vUv);
#ifdef DEPTH_PASS
    if (c.a <= 0.0) discard;
    gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0);
#else
    if (c.a <= 0.0) discard;
    gl_FragColor = c;
#endif
}`;
const POINT_VERT = `
attribute vec4 pcolor;
uniform float psize;
varying vec4 vCol;
varying float vDepth;
void main() {
    vCol = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = psize;
}`;
const POINT_FRAG = `
varying vec4 vCol;
varying float vDepth;
void main() {
#ifdef DEPTH_PASS
    if (vCol.a <= 0.0) discard;
    gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0);
#else
    gl_FragColor = vCol;
#endif
}`;
const GENERIC_DEPTH = {
    vertexShader: "varying float vDepth;\nvoid main() {\n  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n  vDepth = -mv.z;\n  gl_Position = projectionMatrix * mv;\n}",
    fragmentShader: "varying float vDepth;\nvoid main() { gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }",
};

// A SceneFile's own meshes with a picture of Comp's on them (Sebastian 2026-11-23: "enable to project onto actual
// meshes as well"): three's unlit MeshBasicMaterial, so skinned, morphed and instanced meshes deform as they do in
// the 3D space, with its colour replaced at the end by the projected picture (the arithmetic of FRAG above) or, wired
// without a Project, the picture on the mesh's own UVs. Its faces' outward side comes from the derivatives of the
// world position (the mesh's normals may be missing or smoothed), turned by gl_FrontFacing. The meshes stay solid:
// their depth is laid first (render's hold-out pass), so a part the picture does not reach is a transparent hole that
// hides the mesh's own far side and what is behind it, and depth.z is the mesh's wherever it is.
const MESH_PROJ_PARS = `
uniform sampler2D ivMap;
uniform bool ivProj;
uniform mat4 ivProjView;
uniform float ivPk;
uniform float ivPky;
uniform float ivPsx;
uniform vec3 ivProjPos;
uniform bool ivFrontOnly;
varying vec3 ivWorld;
varying vec2 ivUv;
`;
const MESH_PROJ_VERT = `
    vec4 ivW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
    ivW = instanceMatrix * ivW;
#endif
    ivWorld = (modelMatrix * ivW).xyz;
    ivUv = uv;
`;
const MESH_PROJ_FRAG = `
    vec4 ivC;
    if (ivProj) {
        vec4 q = ivProjView * vec4(ivWorld, 1.0);
        float d = -q.z;
        vec2 puv = vec2((ivPk * q.x / d + ivPsx + 1.0) * 0.5, (ivPky * q.y / d + 1.0) * 0.5);
        bool off = d <= 0.0 || puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0;
        if (ivFrontOnly) {
            vec3 fn = normalize(cross(dFdx(ivWorld), dFdy(ivWorld)));
            if (dot(fn, cameraPosition - ivWorld) < 0.0) fn = -fn;
            if (!gl_FrontFacing) fn = -fn;
            if (dot(fn, ivProjPos - ivWorld) <= 0.0) off = true;
        }
        ivC = off ? vec4(0.0) : texture2D(ivMap, puv);
    } else ivC = texture2D(ivMap, ivUv);
    if (ivC.a <= 0.0) discard;
    gl_FragColor = ivC;
`;

/** Which of the view's meshes a SceneFile object (sceneOf's {kind: "scenefile", id, objects}) puts its picture on:
 *  every mesh of that SceneFile's items but cameras and lights, or with `objects` (names, comma separated) the
 *  items of those names and the nodes inside a model of those names, with what is under them. */
export function sceneFileMeshes(entries, ob) {
    const want = String(ob.objects || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const out = new Set();
    const usable = (o) => o.isMesh && !o.isLine && !o.isPoints && !o.isSprite && o.name !== "splatbounds" && o.name !== "worldsky"
        && !(o.userData && (o.userData.imageViewerNoShadow || o.userData.imageViewerSplat || o.userData.imageViewerSplatBounds || o.userData.imageViewerLightGlyph));
    const all = (root) => root.traverse((o) => { if (usable(o)) out.add(o); });
    for (const [id, entry] of entries) {
        const parts = String(id).split("::");
        if (parts[0] !== ob.id) continue;
        const it = (entry && entry.item) || {}, root = entry && (entry.top || entry.root);
        if (!root || it.kind === "camera" || it.kind === "light") continue;
        if (!want.length || want.includes(String(it.name || "").toLowerCase()) || want.includes(parts.slice(1).join("::").toLowerCase())) { all(root); continue; }
        root.traverse((o) => { if (o !== root && o.name && want.includes(String(o.name).toLowerCase())) all(o); });
    }
    return [...out];
}

/** A scene file of the 3D space (read by /imageviewer/scene): USD stages and the older JSON scenes. */
export const SCENE_FILE_EXTS = [".usda", ".usdc", ".usd", ".json"];

/** Is `path` a model a SceneFile opens on its own, as the 3D space's Import Model does (glTF, FBX, OBJ, STL, PLY,
 *  USDZ, Alembic, splats)? A .usd / .usda / .usdc is read as a scene instead (a foreign stage becomes its items). */
export function isModelFile(path) {
    const m = /\.[^./\\]+$/.exec(String(path || "").trim().toLowerCase());
    return !!m && MODEL_IMPORT_EXTS.includes(m[0]) && !SCENE_FILE_EXTS.includes(m[0]);
}

/** The scene a SceneFile makes of one model file: the model at the origin, named after the file. */
export function modelScene(path) {
    const file = String(path || "").trim();
    const name = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, "") || "model";
    const item = makeModelItem({ path: file, name, kind: "model" }, name);
    item.id = "model";
    return { items: [item], render: { start: 0 } };
}

/** A row-major 4 x 4 (comp3d's) as three's Matrix4 (whose set() takes rows). */
const mat4 = (THREE, m) => new THREE.Matrix4().set(...m);

/** The projection of a Comp camera (comp3d.cameraAt): x_ndc = k x / d + sx, y_ndc = ky y / d, d = -z. */
export function compProjection(cam) {
    const n = Math.max(1e-6, cam.near), f = Math.max(n * 1.0001, cam.far);
    return [cam.k, 0, -cam.sx, 0,
        0, cam.ky, 0, 0,
        0, 0, -(f + n) / (f - n), -2 * f * n / (f - n),
        0, 0, -1, 0];
}

/** Rows of a float RGBA read-back (bottom-up) into a top-down picture, averaged over n x n samples. */
export function downsample(px, SW, SH, n) {
    const W = Math.max(1, Math.floor(SW / n)), H = Math.max(1, Math.floor(SH / n));
    const data = new Float32Array(W * H * 4), nn = n * n;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < n; j++) {
            const row = SH - 1 - (y * n + j);
            for (let i = 0; i < n; i++) {
                const s = (row * SW + x * n + i) * 4;
                r += px[s]; g += px[s + 1]; b += px[s + 2]; a += px[s + 3];
            }
        }
        const o = (y * W + x) * 4;
        data[o] = r / nn; data[o + 1] = g / nn; data[o + 2] = b / nn; data[o + 3] = a / nn;
    }
    return { w: W, h: H, data };
}

/** The nearest depth of n x n samples (0 = nothing), rows top-down. */
export function downsampleDepth(px, SW, SH, n) {
    const W = Math.max(1, Math.floor(SW / n)), H = Math.max(1, Math.floor(SH / n));
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let near = Infinity;
        for (let j = 0; j < n; j++) {
            const row = SH - 1 - (y * n + j);
            for (let i = 0; i < n; i++) {
                const z = px[(row * SW + x * n + i) * 4];
                if (Number.isFinite(z) && z > 0 && z < near) near = z;
            }
        }
        out[y * W + x] = near < Infinity ? near : 0;
    }
    return out;
}

/** Several scenes of the 3D space as one: each item's id (and parent) prefixed by its SceneFile node's id. */
export function mergeScenes(entries) {
    const list = [...entries];
    if (!list.length) return parseScene({ items: [] });
    const first = list[0][1].scene;
    const items = [];
    for (const [nid, { scene }] of list) {
        for (const it of (scene && scene.items) || []) {
            const c = Object.assign({}, it, { id: `${nid}::${it.id}` });
            if (it.parent) c.parent = `${nid}::${it.parent}`;
            items.push(c);
        }
    }
    return Object.assign({}, first, { items, activeCamera: null });
}

export class Comp3DEngine {
    /** host: an element of the page the hidden view lives in. onChange(): what it draws changed (a scene arrived).
     *  hooks: the Model3DView hooks that find a model's file (srcUrl, resolveResource, plateInfo, plateFrameUrl) -
     *  without srcUrl a SceneFile's models were never loaded, only its shapes drawn. */
    constructor(host, { onChange, hooks } = {}) {
        this.box = host.ownerDocument.createElement("div");
        this.box.className = "comp3d-engine";
        // Never shown: a view of its own, drawn into float targets. 1 x 1 keeps the canvas small.
        Object.assign(this.box.style, { position: "absolute", width: "1px", height: "1px", overflow: "hidden", visibility: "hidden", pointerEvents: "none", left: "-10px", top: "-10px" });
        host.append(this.box);
        this.onChange = onChange || null;
        this.hooks = hooks || {};
        this.view = null;
        this.ready = false;
        this.why = "";
        this._rev = 0;
        this._files = new Map();      // SceneFile node id -> {key, scene}
        this._setKey = "";
        this._setting = null;
        this._tex = new Map();        // a picture -> its texture, kept while it is drawn
        this._targets = {};
        this._ensuring = null;
    }

    /** The document the engine is in NOW: popped out, the box moves into the other window's document. */
    get doc() { return this.box.ownerDocument; }

    get sig() { return `${this.ready ? 1 : 0}.${this._rev}`; }

    /** Make the view and its renderer (once); true when it can render floats. */
    ensure() {
        if (this._ensuring) return this._ensuring;
        this._ensuring = (async () => {
            try {
                this.view = new Model3DView(this.box, Object.assign({}, this.hooks));
                await this.view.ensure();
                const r = this.view.renderer, gl = r && r.getContext();
                // WebGL 2 asked without `instanceof`: popped out, the context comes from the other window's realm,
                // whose WebGL2RenderingContext is another object (Safari then said "no float pictures").
                const gl2 = !!(gl && (r.capabilities ? r.capabilities.isWebGL2 !== false : typeof gl.texStorage2D === "function"));
                const floats = !!(gl2 && (r.extensions.has("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_float")));
                const ok = gl2 && floats;
                this.ready = ok;
                this.why = ok ? "" : !gl ? "no WebGL context" : !gl2 ? "this browser has no WebGL 2"
                    : "this browser cannot render to float pictures (EXT_color_buffer_float)";
                // Nothing of the viewport's own: no grid, no default lights unless a scene asks for them.
                if (this.view.grid) this.view.grid.visible = false;
                await this.view.setScene(parseScene({ items: [] }), 0);
                this._rev++;
            } catch (e) {
                this.ready = false;
                this.why = String((e && e.message) || e);
                console.warn("[ImageViewer] Comp's 3D renderer could not start", e);
            }
            return this.ready;
        })();
        return this._ensuring;
    }

    /** A SceneFile's scene, loaded into the view with its models before a draw uses it. `key` says when it changed. */
    async prepareScene(nodeId, scene, key) {
        await this.ensure();
        if (!this.ready) return false;
        const had = this._files.get(nodeId);
        if (!had || had.key !== key) this._files.set(nodeId, { key, scene: parseScene(scene) });
        return this._apply();
    }

    /** SceneFile nodes no longer in the comp are let go. */
    keepOnly(ids) {
        let gone = false;
        for (const id of [...this._files.keys()]) if (!ids.has(id)) { this._files.delete(id); gone = true; }
        if (gone) this._apply();
    }

    async _apply() {
        const key = [...this._files].map(([id, f]) => `${id}=${f.key}`).join("|");
        if (key === this._setKey) return this._setting || true;
        this._setKey = key;
        // One setScene at a time: a scene followed live (a 3D tab being edited) asks again before the last is in.
        const job = (this._setting || Promise.resolve()).catch(() => null).then(async () => {
            if (key !== this._setKey) return true;       // a newer one is on its way
            await this.view.setScene(mergeScenes(this._files), 0);
            await this.view.whenLoaded().catch(() => null);
            this._rev++;
            if (this.onChange) this.onChange();
            return true;
        });
        this._setting = job;
        return job;
    }

    _texture(THREE, img) {
        let t = this._tex.get(img);
        if (t) { t.used = true; return t.tex; }
        const W = img.w, H = img.h, src = img.data, data = new Float32Array(W * H * 4);
        // Comp's rows run top-down, a texture's from the bottom.
        for (let y = 0; y < H; y++) data.set(src.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
        const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
        const lin = this.view.renderer.extensions.has("OES_texture_float_linear");
        tex.minFilter = tex.magFilter = lin ? THREE.LinearFilter : THREE.NearestFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.NoColorSpace;
        tex.premultiplyAlpha = false;
        tex.flipY = false;
        tex.needsUpdate = true;
        this._tex.set(img, { tex, used: true });
        return tex;
    }

    _target(name, W, H) {
        const { THREE } = this.view.libs;
        let t = this._targets[name];
        if (t && (t.width !== W || t.height !== H)) { t.dispose(); t = null; }
        if (!t) {
            t = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat,
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, colorSpace: THREE.NoColorSpace });
            this._targets[name] = t;
        }
        return t;
    }

    _compMaterial(THREE, ob, lit, depth) {
        const blend = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };
        const map = ob.proj ? this._texture(THREE, ob.proj.img) : ob.tex ? this._texture(THREE, ob.tex) : null;
        if (lit && !ob.proj && !depth) {
            // Diffuse only, so a premultiplied picture stays premultiplied: lit(albedo x a) = lit(albedo) x a.
            return new THREE.MeshLambertMaterial(Object.assign({ map, color: 0xffffff, transparent: true, side: THREE.DoubleSide,
                alphaTest: 1e-6, premultipliedAlpha: false }, blend));
        }
        const u = { map: { value: map }, hasMap: { value: !!map }, proj: { value: !!ob.proj }, projView: { value: new THREE.Matrix4() },
            pk: { value: 1 }, pky: { value: 1 }, psx: { value: 0 }, projPos: { value: new THREE.Vector3() }, frontOnly: { value: ob.faces === "front" } };
        if (ob.proj) {
            const c = ob.proj.cam;
            u.projView.value = mat4(THREE, c.view);
            u.pk.value = c.k; u.pky.value = c.ky; u.psx.value = c.sx;
            u.projPos.value.set(c.pos[0], c.pos[1], c.pos[2]);
        }
        return new THREE.ShaderMaterial(Object.assign({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
            defines: depth ? { DEPTH_PASS: 1 } : {} }, depth ? { blending: THREE.NoBlending } : Object.assign({ transparent: true }, blend)));
    }

    /** The material a SceneFile's meshes are drawn with while it carries a picture (MESH_PROJ_* above). */
    _sceneFileMaterial(THREE, ob) {
        const img = ob.proj ? ob.proj.img : ob.tex;
        const u = { ivMap: { value: this._texture(THREE, img) }, ivProj: { value: !!ob.proj }, ivProjView: { value: new THREE.Matrix4() },
            ivPk: { value: 1 }, ivPky: { value: 1 }, ivPsx: { value: 0 }, ivProjPos: { value: new THREE.Vector3() }, ivFrontOnly: { value: ob.faces === "front" } };
        if (ob.proj) {
            const c = ob.proj.cam;
            u.ivProjView.value = mat4(THREE, c.view);
            u.ivPk.value = c.k; u.ivPky.value = c.ky; u.ivPsx.value = c.sx;
            u.ivProjPos.value.set(c.pos[0], c.pos[1], c.pos[2]);
        }
        const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, premultipliedAlpha: false, blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor });
        m.onBeforeCompile = (sh) => {
            Object.assign(sh.uniforms, u);
            sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\n" + MESH_PROJ_PARS)
                .replace("#include <project_vertex>", "#include <project_vertex>\n" + MESH_PROJ_VERT);
            sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\n" + MESH_PROJ_PARS)
                .replace("#include <dithering_fragment>", "#include <dithering_fragment>\n" + MESH_PROJ_FRAG);
        };
        m.customProgramCacheKey = () => "imageviewer-comp-mesh-proj";
        return m;
    }

    _meshOf(THREE, ob) {
        const P = ob.pos, U = ob.uv, T = ob.tri, nt = T.length / 3;
        const pos = new Float32Array(nt * 9), uv = new Float32Array(nt * 6), fn = new Float32Array(nt * 9);
        for (let t = 0; t < nt; t++) {
            const ids = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
            for (let k = 0; k < 3; k++) {
                const q = ids[k];
                pos.set([P[q * 3], P[q * 3 + 1], P[q * 3 + 2]], (t * 3 + k) * 3);
                uv.set([U[q * 2], U[q * 2 + 1]], (t * 3 + k) * 2);
            }
            const a = pos.subarray(t * 9, t * 9 + 3), b = pos.subarray(t * 9 + 3, t * 9 + 6), c = pos.subarray(t * 9 + 6, t * 9 + 9);
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
            const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
            for (let k = 0; k < 3; k++) fn.set([nx, ny, nz], (t * 3 + k) * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        g.setAttribute("fnormal", new THREE.BufferAttribute(fn, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(fn.slice(), 3));
        return g;
    }

    _pointsOf(THREE, ob, n, depth) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(ob.pos), 3));
        g.setAttribute("pcolor", new THREE.BufferAttribute(Float32Array.from(ob.col), 4));
        const m = new THREE.ShaderMaterial({ uniforms: { psize: { value: Math.max(1, ob.size * n) } }, vertexShader: POINT_VERT,
            fragmentShader: POINT_FRAG, blending: THREE.NoBlending, defines: depth ? { DEPTH_PASS: 1 } : {} });
        return new THREE.Points(g, m);
    }

    _lightOf(THREE, ob) {
        const c = ob.color || [1, 1, 1, 1], col = new THREE.Color(c[0], c[1], c[2]);
        // three's diffuse is albedo / pi x irradiance: intensity 1 at right angles is the albedo itself.
        const I = (Number(ob.intensity) || 0) * Math.PI;
        let L;
        if (ob.type === "ambient") L = new THREE.AmbientLight(col, I);
        else if (ob.type === "directional") L = new THREE.DirectionalLight(col, I);
        else if (ob.type === "spot") L = new THREE.SpotLight(col, I, 0, (Math.max(1, Math.min(89, ob.cone || 30)) * Math.PI) / 180, 0.1, 0);
        else L = new THREE.PointLight(col, I, 0, 0);
        const m = mat4(THREE, ob.world);
        m.decompose(L.position, L.quaternion, L.scale);
        L.scale.set(1, 1, 1);
        if (L.target) { L.target.position.set(0, 0, -1); L.add(L.target); }
        return L;
    }

    /**
     * Draw `objs` (renderNode's sceneOf) through `cam` (comp3d.cameraAt) at W x H with n x n samples a pixel:
     * {img: {w, h, data}, depth} - premultiplied, scene-linear, rows top-down - or null when it cannot.
     */
    render(objs, cam, W, H, n = 1, info = null) {
        if (!this.ready || !this.view || !this.view.renderer) return null;
        const v = this.view, { THREE } = v.libs, R = v.renderer;
        const max = (R.capabilities && R.capabilities.maxTextureSize) || 4096;
        n = Math.max(1, Math.min(MAX_SAMPLES, Math.round(n) || 1));
        while (n > 1 && Math.max(W, H) * n > max) n--;
        const SW = Math.min(max, W * n), SH = Math.min(max, H * n);
        for (const t of this._tex.values()) t.used = false;

        // The SceneFiles drawn: their items shown at their frame, the others' hidden.
        const files = objs.filter((o) => o.kind === "scenefile");
        const on = new Set(files.map((o) => o.id));
        if (files.length) v.applyFrame(files[0].frame);
        const hidden = [];
        for (const [id, entry] of v._entries) {
            const nid = String(id).split("::")[0];
            const root = entry.top || entry.root;
            if (root && root.visible && !on.has(nid)) { root.visible = false; hidden.push(root); }
        }
        const sceneLights = files.length > 0 && [...v._entries.values()].some((e) => e.item && e.item.kind === "light" && on.has(String(e.item.id).split("::")[0]));

        // Comp's own objects, made for this draw.
        const lights = objs.filter((o) => o.kind === "light");
        const lit = lights.length > 0 || sceneLights;
        const group = new THREE.Group();
        group.name = "comp3d";
        const made = [];   // [object, colour material, depth material]
        for (const ob of objs) {
            if (ob.kind === "mesh") {
                const g = this._meshOf(THREE, ob);
                const mesh = new THREE.Mesh(g, this._compMaterial(THREE, ob, lit, false));
                mesh.frustumCulled = false;
                group.add(mesh);
                made.push([mesh, mesh.material, this._compMaterial(THREE, ob, lit, true)]);
            } else if (ob.kind === "points") {
                const p = this._pointsOf(THREE, ob, n, false);
                p.frustumCulled = false;
                group.add(p);
                made.push([p, p.material, this._pointsOf(THREE, ob, n, true).material]);
            } else if (ob.kind === "light") group.add(this._lightOf(THREE, ob));
        }
        v.scene.add(group);

        // A SceneFile wired to a Project (or a picture): its meshes take the picture for this draw.
        const swapped = [];   // [mesh, its own material, the picture's material]
        for (const ob of files) {
            if (!ob.proj && !ob.tex) continue;
            const cm = this._sceneFileMaterial(THREE, ob);
            const meshes = sceneFileMeshes(v._entries, ob);
            for (const mesh of meshes) { swapped.push([mesh, mesh.material, cm]); mesh.material = cm; }
            if (!meshes.length) cm.dispose();
        }

        // The camera: Comp's, its matrices as they are.
        const camera = this._cam || (this._cam = new THREE.PerspectiveCamera());
        camera.matrixAutoUpdate = false;
        camera.matrixWorldAutoUpdate = false;
        camera.matrixWorld.copy(mat4(THREE, cam.world));
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        camera.matrix.copy(camera.matrixWorld);
        camera.projectionMatrix.copy(mat4(THREE, compProjection(cam)));
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        camera.layers.enableAll();

        // What is there to work with is not in the picture (the grid, gizmos, helpers), nor the viewport's
        // studio lights unless the scene asks for them (and never beside Comp's own lights).
        const restore = [];
        const hide = (o) => { if (o && o.visible) { o.visible = false; restore.push(o); } };
        const keepRendering = v._rendering;
        v._rendering = { opts: { grid: false, helpers: false }, restore: [] };
        v._renderHideOverlays();
        const overlays = v._rendering.restore;
        if (v._lightsFrame) v._lightsFrame();
        if (lights.length || !files.length) for (const l of v.lights || []) hide(l);
        hide(v.grid); hide(v.gridOrigin);
        if (this._room) { hide(this._room.group); hide(this._room.helper); }
        const background = v.scene.background, override = v.scene.overrideMaterial;
        const clear = R.getClearColor(new THREE.Color()), clearAlpha = R.getClearAlpha(), before = R.getRenderTarget();
        const autoClear = R.autoClear;
        let out = null;
        try {
            v.scene.background = null;
            R.setClearColor(0x000000, 0);
            // The picture.
            const ct = this._target("color", SW, SH);
            R.setRenderTarget(ct);
            R.clear(true, true, true);
            if (swapped.length) {
                // Hold-out: the picture's meshes' depth first, so only their nearest surface takes the picture.
                const hold = this._holdMat || (this._holdMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
                R.autoClear = false;
                for (const [o] of swapped) { o.material = hold; R.render(o, camera); }
                for (const [o, , c] of swapped) o.material = c;
            }
            R.render(v.scene, camera);
            R.autoClear = autoClear;
            const px = new Float32Array(SW * SH * 4);
            R.readRenderTargetPixels(ct, 0, 0, SW, SH, px);
            const img = downsample(px, SW, SH, n);
            // The depth: the 3D space's things with one material, Comp's with their own (covered where alpha > 0).
            const dt = this._target("depth", SW, SH);
            R.setRenderTarget(dt);
            R.clear(true, true, true);
            const dm = this._depthMat || (this._depthMat = new THREE.ShaderMaterial(Object.assign({ side: THREE.DoubleSide }, GENERIC_DEPTH)));
            group.visible = false;
            const nohide = [];
            v.scene.traverse((o) => {
                if (!o.visible || o === v.scene) return;
                if (o.userData && (o.userData.imageViewerSplat || o.userData.imageViewerSplatBounds) || o.name === "splatbounds" || o === v._spark) { o.visible = false; nohide.push(o); return; }
                if (o.isLine || o.isPoints || o.isSprite) { o.visible = false; nohide.push(o); }
            });
            v.scene.overrideMaterial = dm;
            R.render(v.scene, camera);
            v.scene.overrideMaterial = override;
            for (const o of nohide) o.visible = true;
            group.visible = true;
            for (const [o, , d] of made) o.material = d;
            R.autoClear = false;
            R.render(group, camera);
            R.autoClear = autoClear;
            for (const [o, c] of made) o.material = c;
            const dpx = new Float32Array(SW * SH * 4);
            R.readRenderTargetPixels(dt, 0, 0, SW, SH, dpx);
            out = { img, depth: downsampleDepth(dpx, SW, SH, n) };
        } catch (e) {
            console.warn("[ImageViewer] Comp's 3D render failed", e);
            out = null;
        } finally {
            R.autoClear = autoClear;
            R.setRenderTarget(before);
            R.setClearColor(clear, clearAlpha);
            v.scene.background = background;
            v.scene.overrideMaterial = override;
            for (const o of restore) o.visible = true;
            for (let i = overlays.length - 1; i >= 0; i--) { const [obj, key, value] = overlays[i]; obj[key] = value; }
            v._rendering = keepRendering;
            for (const r of hidden) r.visible = true;
            const mats = new Set();
            for (const [o, own, c] of swapped) { o.material = own; mats.add(c); }
            for (const m of mats) m.dispose();
            v.scene.remove(group);
            group.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material && !made.some(([, c]) => c === o.material)) o.material.dispose();
            });
            for (const [, c, d] of made) { c.dispose(); d.dispose(); }
            // Pictures not drawn this time are let go.
            for (const [img, t] of [...this._tex]) if (!t.used) { t.tex.dispose(); this._tex.delete(img); }
        }
        // What the room shows (imageViewer_comp3dRoom.js): the last scene drawn and its camera.
        if (out) { this._last = { objs, cam, info }; if (this._room) this.roomSync(); }
        return out;
    }

    dispose() {
        if (this._room) this.closeRoom();
        for (const t of this._tex.values()) t.tex.dispose();
        this._tex.clear();
        for (const t of Object.values(this._targets)) t.dispose();
        this._targets = {};
        if (this.view && this.view._disposeRenderer) { try { this.view._disposeRenderer(); } catch (_) { /* gone */ } }
        this.box.remove();
        this.ready = false;
    }
}

// The 3D room of Comp's viewer: the same view, brought on screen.
Object.defineProperties(Comp3DEngine.prototype, Object.getOwnPropertyDescriptors(RoomMixin));
