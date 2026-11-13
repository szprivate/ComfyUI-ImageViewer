// imageViewer_view3dPathTrace.js
// The 3D space's second renderer: a path tracer, as a shading mode of the
// viewport ("Path traced") and as the render dialog's "Renderer".
//
// It is three-gpu-pathtracer (Garrett Johnson, MIT; vendor/three/
// three-gpu-pathtracer.module.js, with three-mesh-bvh, MIT) on the SAME
// three.js scene and WebGL renderer the viewport draws with, so the scene's
// meshes, materials (MeshStandard / MeshPhysical), textures and lights
// (point, spot, directional, RectAreaLight; ambient and hemisphere lights are
// not traced, an environment stands in for them) are what it traces. Nothing is
// converted and nothing runs on the server.
//
// The picture refines while nothing moves: each tick adds a sample (a tile at
// a time, so the page stays responsive) until `PT_VIEW_MAX`. A move of the
// camera starts again from one sample; a change of the scene (an object moved,
// a frame scrubbed, a light changed) rebuilds what the tracer holds of it.
//
// What is there to work with rather than to look at - grid, gizmo, camera
// frustums, rig controls, joints, selection boxes - is not traced: it is drawn
// over the traced picture by the rasteriser, depth-tested against the traced
// meshes (a depth-only pass of them first). Gaussian splats cannot be traced;
// they are drawn the same way, so a splat world stays visible around traced
// meshes but gives them no light. Split layouts (2 / 3 / 4 panes) stay raster.
import { api } from "../../scripts/api.js";

/** Samples the viewport stops at; a still view is as good as it gets by then. */
export const PT_VIEW_MAX = 1024;
/** Bounces of light the viewport traces: enough for interiors, still quick. */
export const PT_VIEW_BOUNCES = 5;

/** How long after the last change "Raster while moving" waits before tracing again. */
export const PT_RESUME_MS = 300;
const MOVE_KEY = "imageviewer.viewer.ptRasterWhileMoving";

let _ptPromise = null;
function loadPathTracer() {
    if (!_ptPromise) {
        _ptPromise = import(api.apiURL("/imageviewer/lib/three/three-gpu-pathtracer.module.js"))
            .catch((e) => { _ptPromise = null; throw e; });
    }
    return _ptPromise;
}

const round = (v) => Math.round(v * 1e4) / 1e4;

export const View3DPathTraceMixin = {

    /** Whether the viewport is drawn by the path tracer right now. */
    ptActive() {
        return this.materialMode === "pathtraced" && !this._ptFailed;
    },

    /** Samples the viewport's traced picture holds (0 when not tracing). */
    ptSamples() {
        return this._pt && this.ptActive() ? Math.floor(this._pt.samples) : 0;
    },

    /**
     * "Raster while moving" (View menu, off by default): while an object is
     * dragged or the scene plays, the view is drawn raster - no rebuild of the
     * tracer's scene per frame - and tracing starts again PT_RESUME_MS after
     * the last change. Kept per viewer in localStorage.
     */
    ptRasterWhileMoving() {
        if (this._ptMoveOpt === undefined) {
            try { this._ptMoveOpt = (this.win || window).localStorage.getItem(MOVE_KEY) === "1"; }
            catch (e) { this._ptMoveOpt = false; }
        }
        return this._ptMoveOpt;
    },

    ptSetRasterWhileMoving(on) {
        this._ptMoveOpt = !!on;
        try { (this.win || window).localStorage.setItem(MOVE_KEY, on ? "1" : "0"); } catch (e) { /* private window */ }
        this._ptMovingUntil = 0;
        this._ptLastSig = undefined;
        this.requestRender();
    },

    /** With the option on: whether the scene is moving now (raster this tick). */
    _ptMoving(cam) {
        if (!this.ptRasterWhileMoving()) return false;
        this.scene.updateMatrixWorld(true);
        const sig = this._ptSceneSig(this._ptContent(cam));
        const now = performance.now();
        if ((this._ptLastSig !== undefined && sig !== this._ptLastSig) || (this.gizmo && this.gizmo.dragging)) {
            this._ptMovingUntil = now + PT_RESUME_MS;
        }
        this._ptLastSig = sig;
        if (now >= (this._ptMovingUntil || 0)) return false;
        // Come back when it has been still long enough, even if nothing else asks for a frame.
        const win = this.win || window;
        if (this._ptResumeTimer) win.clearTimeout(this._ptResumeTimer);
        this._ptResumeTimer = win.setTimeout(() => { this._ptResumeTimer = 0; this.requestRender(); },
                                             Math.max(16, this._ptMovingUntil - now + 5));
        return true;
    },

    /** Load the library and make a tracer for this renderer. Resolves to it, or null. */
    async ptEnsure() {
        if (this._pt && this._ptFor === this.renderer) return this._pt;
        if (!this.renderer) return null;
        let lib;
        try {
            lib = await loadPathTracer();
        } catch (e) {
            console.warn("[ImageViewer] the path tracer could not be loaded", e);
            this._ptFailed = true;
            this._ptBadge();
            return null;
        }
        if (!this.renderer) return null;
        if (this._pt && this._ptFor === this.renderer) return this._pt;
        this._ptDispose();
        this._ptLib = lib;
        const pt = new lib.WebGLPathTracer(this.renderer);
        pt.bounces = PT_VIEW_BOUNCES;
        pt.filterGlossyFactor = 0.5;
        pt.tiles.set(2, 2);
        pt.minSamples = 1;
        pt.renderDelay = 0;
        pt.fadeDuration = 0;
        pt.dynamicLowRes = true;
        pt.lowResScale = 0.25;
        // Sized by _ptSetSize: a split layout traces one pane, not the whole canvas.
        pt.synchronizeRenderSize = false;
        // The raster pass under the first samples is the viewport's own (with its overlays).
        pt.rasterizeScene = false;
        this._pt = pt;
        this._ptFor = this.renderer;
        this._ptSig = null;
        return pt;
    },

    _ptDispose() {
        if (this._pt) {
            try { this._pt.dispose(); } catch (e) { /* the context may be gone */ }
        }
        this._pt = null;
        this._ptFor = null;
        this._ptSig = null;
        if (this._ptDepthMat) { this._ptDepthMat.dispose(); this._ptDepthMat = null; }
        if (this._ptEnv) { this._ptEnv.dispose(); this._ptEnv = null; }
    },

    /** Called by setMaterialMode: start (load) or stop tracing. */
    _ptModeChanged() {
        if (this.ptActive()) {
            this._ptSig = null;
            if (!this._pt) this.ptEnsure().then(() => this.requestRender());
        }
        this._ptBadge();
    },

    // ── What is traced ───────────────────────────────────────────────────────

    /** The objects that are there to work with, never traced (visible ones only). */
    _ptOverlayRoots() {
        const out = [];
        const add = (o) => { if (o && o.visible) out.push(o); };
        add(this.grid);
        add(this.gizmoHelper);
        add(this._pivotMark);
        add(this._pinGroup);
        add(this._spGroup);
        add(this._spRing);
        add(this._tbRing);
        for (const b of (this._alsoBoxes || new Map()).values()) add(b);
        for (const j of (this._joints || new Map()).values()) add(j.group);
        for (const st of (this._atlasViewsShown || new Map()).values()) add(st.group);
        for (const e of this._entries.values()) {
            add(e.helper);
            add(e.axes);
            if (e.isControl) add(e.top || e.root);
        }
        for (const m of (this._templated || new Map()).keys()) add(m);
        add(this._spark);
        this.scene.traverse((o) => {
            if (o === this.scene) return;
            const u = o.userData || {};
            if (u.imageViewerSplat || u.imageViewerSplatBounds || o.name === "splatbounds") add(o);
        });
        return out;
    },

    /** Hide `list`, run `fn`, show them again. */
    _ptHidden(list, fn) {
        const was = list.map((o) => o.visible);
        for (const o of list) o.visible = false;
        try { return fn(); } finally { list.forEach((o, i) => { o.visible = was[i]; }); }
    },

    /** The meshes the tracer sees through `cam`: visible, drawn, on a shown display layer. */
    _ptContent(cam) {
        const meshes = [];
        const invisible = (m) => (Array.isArray(m) ? m.every((x) => !x || x.visible === false) : !m || m.visible === false);
        this._ptHidden(this._ptOverlayRoots(), () => {
            this.scene.traverseVisible((o) => {
                if (!o.isMesh || invisible(o.material)) return;
                if (cam && !o.layers.test(cam.layers)) return;
                meshes.push(o);
            });
        });
        return meshes;
    },

    /**
     * The default rig's fill lights (ComfyUI's Load 3D rig: a key and four
     * directional fills, plus an ambient). Raster needs the fills to read the
     * shapes; traced they would cast four more hard shadows each, so the
     * tracer keeps the key only and lets the environment fill.
     */
    _ptFillLights() {
        const rig = (this.lights || []).filter((l) => l.isDirectionalLight && l.visible);
        return [...rig.slice(1), ...this._ptUnseenLights()];
    },

    /**
     * Lights that are visible themselves but under something hidden (a light
     * item switched off hides its root). The tracer looks at each light's own
     * `visible` only, so these would still shine; they are hidden around it.
     */
    _ptUnseenLights() {
        const out = [];
        this.scene.traverse((o) => {
            if (!o.isLight || !o.visible) return;
            for (let p = o.parent; p; p = p.parent) if (!p.visible) { out.push(o); return; }
        });
        return out;
    },

    /** Every visible mesh the tracer must not see, beside the overlays. */
    _ptExcluded(content) {
        const keep = new Set(content);
        const out = this._ptOverlayRoots();
        this.scene.traverseVisible((o) => { if (o.isMesh && !keep.has(o)) out.push(o); });
        return out;
    },

    /** A soft studio sky that stands in for the ambient light the tracer cannot trace. */
    _ptDefaultEnv() {
        if (!this._ptEnv && this._ptLib) {
            const { THREE } = this.libs;
            const env = new this._ptLib.GradientEquirectTexture(64);
            env.topColor.set(new THREE.Color(0.9, 0.92, 0.95));
            env.bottomColor.set(new THREE.Color(0.22, 0.22, 0.24));
            env.exponent = 1.2;
            env.update();
            this._ptEnv = env;
        }
        return this._ptEnv;
    },

    /**
     * Run `fn` with the scene as the tracer should read it: an environment when
     * the scene has none (at the ambient light's strength), and the viewport's
     * clear colour as the background unless the picture is to be transparent.
     */
    _ptWithSceneLook(transparent, fn) {
        const { THREE } = this.libs;
        const scene = this.scene;
        const env = scene.environment, envI = scene.environmentIntensity, bg = scene.background;
        // Only while the default lights are on (View > Default lights, studioLightsOn): with
        // them off the scene is lit by its own lights alone, as raster draws it.
        const ambient = (this.lights || []).find((l) => l.isAmbientLight);
        if (!env && ambient && ambient.visible) {
            scene.environment = this._ptDefaultEnv();
            scene.environmentIntensity = Math.max(0.15, Math.min(2, ambient.intensity * 0.5));
        }
        if (!bg && !transparent) {
            const c = this.renderer.getClearColor(new THREE.Color());
            if (this.renderer.getClearAlpha() > 0) scene.background = c;
        }
        try { return fn(); } finally {
            scene.environment = env;
            scene.environmentIntensity = envI;
            scene.background = bg;
        }
    },

    /** What the tracer would have to rebuild for: meshes, their places, materials, lights, frame. */
    _ptSceneSig(content) {
        const parts = [this.sceneFrame, content.length];
        for (const m of content) {
            const mat = Array.isArray(m.material) ? m.material : [m.material];
            parts.push(m.id, m.geometry && m.geometry.id, ...m.matrixWorld.elements.map(round));
            for (const x of mat) {
                if (!x) continue;
                parts.push(x.id, x.color ? x.color.getHex() : "", round(x.roughness ?? 0), round(x.metalness ?? 0),
                           x.emissive ? x.emissive.getHex() : "", round(x.emissiveIntensity ?? 0), round(x.opacity ?? 1),
                           round(x.transmission ?? 0), x.map ? x.map.id : "");
            }
            if (m.isSkinnedMesh && m.skeleton) {
                for (const b of m.skeleton.bones) parts.push(...b.matrixWorld.elements.slice(12, 15).map(round), round(b.quaternion.x + b.quaternion.y * 3 + b.quaternion.z * 7 + b.quaternion.w * 13));
            }
            if (m.morphTargetInfluences) parts.push(...m.morphTargetInfluences.map(round));
        }
        return parts.join(",");
    },

    _ptLightSig() {
        const parts = [];
        this.scene.traverse((o) => {
            if (!o.isLight) return;
            let shown = o.visible;
            for (let p = o.parent; p && shown; p = p.parent) shown = p.visible;
            parts.push(o.id, shown ? 1 : 0, o.color.getHex(), round(o.intensity), ...o.matrixWorld.elements.slice(12, 15).map(round));
            if (o.target) parts.push(...o.target.matrixWorld.elements.slice(12, 15).map(round));
            if (o.isSpotLight) parts.push(round(o.angle), round(o.penumbra));
            if (o.isRectAreaLight) parts.push(round(o.width), round(o.height));
        });
        const s = this.scene;
        parts.push(s.environment ? s.environment.id : "", round(s.environmentIntensity ?? 1), s.background && s.background.isColor ? s.background.getHex() : (s.background ? s.background.id : ""));
        return parts.join(",");
    },

    _ptCamSig(cam, w, h) {
        return [cam.id, w, h, ...cam.matrixWorld.elements.map(round), ...cam.projectionMatrix.elements.map(round)].join(",");
    },

    /**
     * Bring the tracer up to date with the scene as `cam` sees it. Returns
     * true when anything changed (and the samples started again).
     */
    _ptSync(cam, { transparent = false, size = null } = {}) {
        const pt = this._pt;
        this.scene.updateMatrixWorld(true);
        cam.updateMatrixWorld();
        const content = this._ptContent(cam);
        if (!size) size = this.renderer.getDrawingBufferSize(new this.libs.THREE.Vector2());
        this._ptSetSize(size.x, size.y);
        const sceneSig = this._ptSceneSig(content) + "|" + (transparent ? "t" : "o");
        const lightSig = this._ptLightSig();
        const camSig = this._ptCamSig(cam, size.x, size.y);
        const was = this._ptSig || {};
        if (was.scene !== sceneSig) {
            this._ptHidden([...this._ptExcluded(content), ...this._ptFillLights()], () =>
                this._ptWithSceneLook(transparent, () => pt.setScene(this.scene, cam)));
        } else if (was.lights !== lightSig) {
            this._ptHidden(this._ptFillLights(), () =>
                this._ptWithSceneLook(transparent, () => { pt.updateLights(); pt.updateEnvironment(); }));
        } else if (was.cam !== cam) {
            // Another pane made active: the same scene seen through its camera.
            pt.setCamera(cam);
        } else if (was.camSig !== camSig) {
            pt.updateCamera();
        } else {
            this._ptContentNow = content;
            return false;
        }
        this._ptContentNow = content;
        this._ptSig = { scene: sceneSig, lights: lightSig, camSig, cam };
        return true;
    },

    /** The traced picture's size in device pixels (the tracer and its low-resolution twin). */
    _ptSetSize(w, h) {
        const pt = this._pt;
        w = Math.max(1, Math.floor(w));
        h = Math.max(1, Math.floor(h));
        const cur = new this.libs.THREE.Vector2();
        pt._pathTracer.getSize(cur);
        if (cur.x === w && cur.y === h) return;
        pt._pathTracer.setSize(w, h);
        pt._lowResPathTracer.setSize(Math.max(1, Math.floor(w * pt.lowResScale)), Math.max(1, Math.floor(h * pt.lowResScale)));
        pt.reset();
    },

    /**
     * Draw the overlays (everything but the traced meshes) over the traced
     * picture on the canvas, hidden where a traced mesh is in front.
     */
    _ptDrawOverlays(cam, { overlays = true } = {}) {
        const { THREE } = this.libs;
        const r = this.renderer;
        const scene = this.scene;
        const content = this._ptContentNow || [];
        if (!this._ptDepthMat) this._ptDepthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
        const autoClear = r.autoClear, bg = scene.background, override = scene.overrideMaterial;
        const mask = cam.layers.mask;
        r.autoClear = false;
        try {
            scene.background = null;
            r.clearDepth();
            // The traced meshes' depth only.
            const contentSet = new Set(content);
            const others = [];
            scene.traverseVisible((o) => {
                if (o === scene || o.isLight || o.isCamera) return;
                if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && !contentSet.has(o)) others.push(o);
            });
            this._ptHidden([...others, ...this._ptOverlayRoots()], () => {
                scene.overrideMaterial = this._ptDepthMat;
                r.render(scene, cam);
            });
            scene.overrideMaterial = override;
            // Everything else, in its own look.
            if (overlays) this._ptHidden(content, () => r.render(scene, cam));
        } finally {
            r.autoClear = autoClear;
            scene.background = bg;
            scene.overrideMaterial = override;
            cam.layers.mask = mask;
        }
    },

    /**
     * One viewport tick while tracing: bring the tracer up to date, add a
     * sample, draw the overlays. Returns null when it cannot trace (not loaded
     * yet, failed, moving with "raster while moving") - the caller rasterises
     * then - else whether another tick is wanted. `pane`: in a split layout
     * the active pane's box (CSS px), whose viewport and scissor are set; the
     * tracer then works at that pane's size and draws into it.
     */
    _ptViewportTick(cam, pane = null) {
        if (!this.ptActive()) return null;
        if (pane) this._ptSplit = true;
        if (!this._pt || this._ptFor !== this.renderer) {
            this.ptEnsure().then((pt) => { if (pt) this.requestRender(); });
            this._ptBadge("Loading the path tracer…");
            return null;
        }
        const pt = this._pt;
        if (this._ptMoving(cam)) {
            this._ptBadge("Path traced · raster while moving");
            return null;
        }
        if (this._ptLimit !== PT_VIEW_MAX) { this._ptLimit = PT_VIEW_MAX; pt.bounces = PT_VIEW_BOUNCES; }
        try {
            const pr = this.renderer.getPixelRatio();
            const size = pane ? { x: pane.w * pr, y: pane.h * pr } : null;
            this._ptSync(cam, { size });
            // The raster picture under the low-resolution samples: the viewport as it is.
            if (pt.samples < 1) {
                if (pane) this.renderer.render(this.scene, cam);
                else this._worldRender(cam);
            }
            pt.pausePathTracing = pt.samples >= PT_VIEW_MAX;
            pt.renderSample();
            this._ptDrawOverlays(cam);
        } catch (e) {
            console.warn("[ImageViewer] path tracing failed; back to raster", e);
            this._ptFailed = true;
            this._ptBadge();
            return null;
        }
        this._ptBadge();
        return pt.samples < PT_VIEW_MAX || pt.isCompiling;
    },

    /** The little "Path traced · 120 samples" note in the stage's corner. */
    _ptBadge(text) {
        if (!this.stage) return;
        let b = this._ptBadgeEl;
        const on = this.materialMode === "pathtraced" && !this._rendering;
        if (!on) { if (b) b.style.display = "none"; return; }
        if (!b) {
            b = this._ptBadgeEl = this.doc.createElement("div");
            b.className = "model-pt-badge";
            this.stage.appendChild(b);
        }
        b.style.display = "";
        if (text) b.textContent = text;
        else if (this._ptFailed) b.textContent = "Path tracing is not available on this graphics card - shown raster";
        else if (!this._pt) b.textContent = "Loading the path tracer…";
        else if (this._pt.isCompiling) b.textContent = "Path traced · compiling…";
        else {
            const n = Math.floor(this._pt.samples);
            b.textContent = `Path traced${this._ptSplit ? " (active view)" : ""} · ${n} sample${n === 1 ? "" : "s"}${n >= PT_VIEW_MAX ? " (done)" : ""}`;
        }
        b.dataset.samples = this._pt ? String(Math.floor(this._pt.samples)) : "0";
    },

    // ── A render ─────────────────────────────────────────────────────────────

    /**
     * One path traced frame for a render, inside beginRender … endRender: the
     * same set-up as renderFrame (camera, gate, hidden overlays), then
     * `samples` samples with `bounces` bounces, yielding to the page between
     * tiles. Resolves to a PNG data URL, or null.
     */
    async renderFramePathTraced(frame, width, height, { samples = 256, bounces = 6, onSample = null, shouldStop = null } = {}) {
        const r = this._rendering;
        if (!r) return null;
        const pt = await this.ptEnsure();
        if (!pt || !this._rendering) return null;
        if (frame !== undefined && frame !== null) this.applyFrame(frame);
        this._renderHideOverlays();
        const cam = r.cam;
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(Math.round(width), Math.round(height), false);
        cam.aspect = width / height;
        if (r.item && this._renderGateFov) cam.fov = this._renderGateFov(r.item);
        cam.updateProjectionMatrix();
        const transparent = r.opts.background === "transparent";
        const wasBg = this.scene.background;
        // A colour background asked for is the background the rays see.
        const want = Math.max(1, Math.round(samples));
        this._ptLimit = want;
        pt.bounces = Math.max(1, Math.min(32, Math.round(bounces)));
        pt.pausePathTracing = false;
        pt.dynamicLowRes = false;
        this._ptSig = null;
        const win = this.win || window;
        try {
            this._ptSync(cam, { transparent });
            let lastYield = performance.now();
            let guard = 0;
            while (pt.samples < want) {
                if (shouldStop && shouldStop()) break;
                pt.renderSample();
                if (pt.isCompiling) {
                    await new Promise((res) => win.setTimeout(res, 50));
                    if (++guard > 1200) throw new Error("the path tracer did not compile");
                    continue;
                }
                if (onSample) onSample(Math.floor(pt.samples), want);
                // A tile at a time; hand the page a frame every ~30 ms so it stays alive.
                if (performance.now() - lastYield > 30) {
                    await new Promise((res) => win.requestAnimationFrame ? win.requestAnimationFrame(() => res()) : win.setTimeout(res, 0));
                    lastYield = performance.now();
                }
            }
            // The traced picture, with the grid / helpers if the render keeps them.
            pt.pausePathTracing = true;
            pt.renderSample();
            this._ptDrawOverlays(cam, { overlays: true });
            return this.canvas.toDataURL("image/png");
        } catch (e) {
            console.warn("[ImageViewer] path traced frame failed", e);
            return null;
        } finally {
            pt.dynamicLowRes = true;
            pt.pausePathTracing = false;
            this.scene.background = wasBg;
            this._ptSig = null;
        }
    },
};
