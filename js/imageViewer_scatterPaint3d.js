// imageViewer_scatterPaint3d.js
// The scatter brush in the 3D view: paint where a scatter grows, straight onto
// its terrain. A mixin on Model3DView (Object.assign'd in imageViewer_model3d.js).
//
// While painting, a left drag on the terrain paints (Ctrl / Cmd held: erases),
// Alt still navigates, [ and ] size the brush, Esc or the bar's Done stops.
// The paint shows as an orange wash over the terrain and a ring under the
// pointer; the scatter itself is rebuilt as the stroke goes (at most one
// rebuild at a time, the panel's _worldLiveReload), and the stroke lands in
// the scene as one undo step when the button is let go
// (hooks.onScatterPaint(id, paint, live)). The data side is
// imageViewer_scatterPaint.js.

import { scatterSettings } from "./imageViewer_worldData.js";
import { decodePaint, encodePaint, strokeBrush, stampBrush, emptyGrid, PAINT_RES } from "./imageViewer_scatterPaint.js";

// How often a stroke hands its paint to the scene while it goes on.
const LIVE_MS = 120;
const WASH = 0xff7a1a;

export const SCATTER_BRUSH_DEFAULTS = { radius: 4, strength: 0.5, hardness: 0.4, erase: false };

export const ScatterPaint3DMixin = {

    /** Whether the scatter brush is on. */
    scatterPainting() { return !!this._sp; },

    /** The brush's settings (radius in metres, strength and hardness 0..1, erase). */
    scatterBrush() {
        if (!this._spBrush) this._spBrush = { ...SCATTER_BRUSH_DEFAULTS };
        return this._spBrush;
    },

    scatterBrushSet(patch) {
        const b = this.scatterBrush();
        if (patch.radius != null) b.radius = Math.min(500, Math.max(0.05, Number(patch.radius) || b.radius));
        if (patch.strength != null) b.strength = Math.min(1, Math.max(0.01, Number(patch.strength) || 0.01));
        if (patch.hardness != null) b.hardness = Math.min(0.99, Math.max(0, Number(patch.hardness) || 0));
        if (patch.erase != null) b.erase = !!patch.erase;
        if (this._sp) this._spRingSize();
        if (this.hooks.onScatterBrush) this.hooks.onScatterBrush(b);
        this.requestRender();
        return b;
    },

    /**
     * Start painting scatter `id`. The terrain it grows on must be built.
     * Answers an error text, or "" when the brush is on.
     */
    scatterPaintBegin(id) {
        if (this._tb && this.terrainBrushEnd) this.terrainBrushEnd();
        if (this._te && this.terrainErodeEnd) this.terrainErodeEnd(false);
        this.scatterPaintEnd();
        const entry = this._entries.get(id);
        if (!entry || !entry.item || entry.item.kind !== "scatter") return "Select a scatter to paint.";
        const s = scatterSettings(entry.item);
        const ground = this._entries.get(s.target);
        if (!ground || !ground.terrain) return "This scatter's terrain is not there (or not built yet).";
        if (!this.canvas) return "The 3D view is not up.";
        const grid = s.paint ? decodePaint(s.paint) : emptyGrid(PAINT_RES);
        this._sp = { id, target: s.target, grid, stroke: null, lastLive: 0, hover: null, canvas: this.canvas };
        this._spBuildOverlay();
        const c = this.canvas;
        this._spMove = (e) => this._spPointerMove(e);
        this._spUp = (e) => this._spPointerUp(e);
        this._spLeave = () => { if (this._sp && this._spRing) { this._spRing.visible = false; this.requestRender(); } };
        c.addEventListener("pointermove", this._spMove);
        c.addEventListener("pointerup", this._spUp);
        c.addEventListener("pointercancel", this._spUp);
        c.addEventListener("pointerleave", this._spLeave);
        this._spKey = (e) => this._spKeyDown(e);
        this._sp.win = this.win || window;
        this._sp.win.addEventListener("keydown", this._spKey, true);
        this.root.classList.add("scatter-painting");
        this.requestRender();
        return "";
    },

    /** Stop painting (a stroke still going is finished first). */
    scatterPaintEnd() {
        const sp = this._sp;
        if (!sp) return;
        if (sp.stroke) this._spFinishStroke();
        const c = sp.canvas;
        if (c) {
            c.removeEventListener("pointermove", this._spMove);
            c.removeEventListener("pointerup", this._spUp);
            c.removeEventListener("pointercancel", this._spUp);
            c.removeEventListener("pointerleave", this._spLeave);
        }
        if (sp.win) sp.win.removeEventListener("keydown", this._spKey, true);
        this._spDropOverlay();
        this._sp = null;
        this.root.classList.remove("scatter-painting");
        if (this.hooks.onScatterPaintEnd) this.hooks.onScatterPaintEnd(sp.id);
        this.requestRender();
    },

    /** A scene change from elsewhere (undo, a typed value): take its paint again. */
    scatterPaintReload(item) {
        const sp = this._sp;
        if (!sp || sp.stroke) return;
        if (!item || item.kind !== "scatter") { this.scatterPaintEnd(); return; }
        const s = scatterSettings(item);
        sp.grid = s.paint ? decodePaint(s.paint) : emptyGrid(PAINT_RES);
        if (s.target !== sp.target) { sp.target = s.target; this._spDropOverlay(); this._spBuildOverlay(); }
        else this._spUpload();
    },

    /** Esc stops, [ and ] size the brush - not while typing in a field. */
    _spKeyDown(e) {
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        let took = true;
        if (e.key === "Escape") this.scatterPaintEnd();
        else if (e.key === "[") this.scatterBrushSet({ radius: this.scatterBrush().radius / 1.25 });
        else if (e.key === "]") this.scatterBrushSet({ radius: this.scatterBrush().radius * 1.25 });
        else took = false;
        if (took) { e.preventDefault(); e.stopImmediatePropagation(); }
    },

    // ── The wash and the ring ────────────────────────────────────────────────

    _spTerrain() {
        const ground = this._sp && this._entries.get(this._sp.target);
        return ground && ground.terrain ? ground : null;
    },

    _spBuildOverlay() {
        const { THREE } = this.libs;
        const sp = this._sp, ground = this._spTerrain();
        if (!sp || !ground) return;
        const res = sp.grid.res;
        const bytes = new Uint8Array(res * res * 4);
        const tex = new THREE.DataTexture(bytes, res, res, THREE.RGBAFormat);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.colorSpace = THREE.NoColorSpace;
        const mat = new THREE.MeshBasicMaterial({
            color: WASH, transparent: true, opacity: 0.4, alphaMap: tex, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false,
            toneMapped: false,
        });
        const wash = new THREE.Mesh(ground.terrain.mesh.geometry, mat);
        wash.name = "scatterpaint";
        wash.renderOrder = 5;
        wash.raycast = () => {};
        wash.userData.imageViewerNoShadow = true;
        const ringGeom = new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2);
        const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
            side: THREE.DoubleSide, toneMapped: false, fog: false }));
        const inner = new THREE.Mesh(new THREE.RingGeometry(0.0, 0.04, 16).rotateX(-Math.PI / 2), ring.material);
        ring.add(inner);
        ring.renderOrder = 999;
        ring.visible = false;
        ring.raycast = () => {};
        inner.raycast = () => {};
        const group = new THREE.Group();
        group.name = "scatterpaint";
        group.add(wash);
        this._bodyOf(ground).add(group);
        this.scene.add(ring);
        this._spGroup = group;
        this._spWash = wash;
        this._spTex = tex;
        this._spRing = ring;
        this._spMesh = ground.terrain.mesh;
        this._spUpload();
        this._spRingSize();
    },

    _spDropOverlay() {
        if (this._spGroup && this._spGroup.parent) this._spGroup.parent.remove(this._spGroup);
        if (this._spRing && this._spRing.parent) this._spRing.parent.remove(this._spRing);
        if (this._spWash) this._spWash.material.dispose();      // the geometry is the terrain's
        if (this._spTex) this._spTex.dispose();
        if (this._spRing) {
            this._spRing.geometry.dispose();
            for (const c of this._spRing.children) c.geometry.dispose();
            this._spRing.material.dispose();
        }
        this._spGroup = this._spWash = this._spTex = this._spRing = this._spMesh = null;
    },

    /** The grid into the wash's texture. A texture's first row is the plane's v = 0, its far (-Z) edge is v = 1. */
    _spUpload() {
        const sp = this._sp, tex = this._spTex;
        if (!sp || !tex) return;
        const n = sp.grid.res, c = sp.grid.cells, d = tex.image.data;
        for (let y = 0; y < n; y++) {
            const row = (n - 1 - y) * n;        // plane uv v runs from +Z (0) to -Z (1); grid v from -Z
            for (let x = 0; x < n; x++) {
                const a = Math.round(Math.min(1, c[y * n + x]) * 255), i = (row + x) * 4;
                d[i] = d[i + 1] = d[i + 2] = d[i + 3] = a;
            }
        }
        tex.needsUpdate = true;
        this.requestRender();
    },

    /** The ring's size: the brush's radius in the world. */
    _spRingSize() {
        if (this._spRing) this._spRing.scale.setScalar(this.scatterBrush().radius);
    },

    /** Keep the wash on the terrain when the terrain was rebuilt under it. */
    _spKeep() {
        const ground = this._spTerrain();
        if (!ground) return false;
        if (ground.terrain.mesh !== this._spMesh) { this._spDropOverlay(); this._spBuildOverlay(); }
        return true;
    },

    // ── Pointer ──────────────────────────────────────────────────────────────

    /** Where the pointer meets the terrain: {u, v, point, normal, scale} or null. */
    _spHit(e) {
        const { THREE } = this.libs;
        if (!this._spKeep()) return null;
        const ground = this._spTerrain(), T = ground.terrain;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1,
                                      -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.activeCameraObject());
        // The Display menu sorts meshes onto three.js layers; the terrain is hit whatever its layer.
        ray.layers.enableAll();
        const hits = ray.intersectObject(T.mesh, false);
        if (!hits.length) return null;
        const body = this._bodyOf(ground);
        body.updateMatrixWorld(true);
        const local = body.worldToLocal(hits[0].point.clone());
        const s = new THREE.Vector3();
        body.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
        const normal = hits[0].face ? hits[0].face.normal.clone().transformDirection(T.mesh.matrixWorld) : new THREE.Vector3(0, 1, 0);
        return { u: local.x / T.size[0] + 0.5, v: local.z / T.size[1] + 0.5, point: hits[0].point, normal,
                 sx: Math.abs(s.x) || 1, sz: Math.abs(s.z) || 1, size: T.size };
    },

    _spRingAt(hit) {
        const ring = this._spRing;
        if (!ring) return;
        if (!hit) { ring.visible = false; this.requestRender(); return; }
        const { THREE } = this.libs;
        ring.visible = true;
        ring.position.copy(hit.point).addScaledVector(hit.normal, 0.02);
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hit.normal);
        const erase = this._sp && this._sp.stroke ? this._sp.stroke.erase : this.scatterBrush().erase;
        ring.material.color.set(erase ? 0x6fb6ff : 0xffffff);
        this.requestRender();
    },

    /** The brush's radius as shares of the terrain's width and depth. */
    _spRadii(hit) {
        const r = this.scatterBrush().radius;
        return [r / (hit.size[0] * hit.sx), r / (hit.size[1] * hit.sz)];
    },

    /** From _onPointerDown (capture): a left press without Alt paints. True when it took the press. */
    _spDown(e) {
        const sp = this._sp;
        if (!sp || e.button !== 0 || e.altKey) return false;
        if (sp.canvas !== this.canvas) { this.scatterPaintEnd(); return false; }
        const hit = this._spHit(e);
        if (!hit) return false;
        const b = this.scatterBrush();
        const erase = b.erase !== !!(e.ctrlKey || e.metaKey);
        sp.stroke = { id: e.pointerId, u: hit.u, v: hit.v, erase };
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
        const [ru, rv] = this._spRadii(hit);
        stampBrush(sp.grid, hit.u, hit.v, ru, rv, { strength: b.strength, hardness: b.hardness, erase });
        this._spUpload();
        this._spRingAt(hit);
        this._spLive(true);
        return true;
    },

    _spPointerMove(e) {
        const sp = this._sp;
        if (!sp) return;
        if (e.altKey && !sp.stroke) { this._spRingAt(null); return; }
        const hit = this._spHit(e);
        this._spRingAt(hit);
        const st = sp.stroke;
        if (!st || e.pointerId !== st.id || !hit) return;
        const b = this.scatterBrush();
        const [ru, rv] = this._spRadii(hit);
        if (strokeBrush(sp.grid, st.u, st.v, hit.u, hit.v, ru, rv,
                        { strength: b.strength * 0.5, hardness: b.hardness, erase: st.erase })) {
            this._spUpload();
            this._spLive(false);
        }
        st.u = hit.u; st.v = hit.v;
    },

    _spPointerUp(e) {
        const sp = this._sp;
        if (!sp || !sp.stroke || (e && e.pointerId !== sp.stroke.id)) return;
        try { this.canvas.releasePointerCapture(sp.stroke.id); } catch (_) { /* gone */ }
        this._spFinishStroke();
    },

    _spFinishStroke() {
        const sp = this._sp;
        sp.stroke = null;
        if (this.hooks.onScatterPaint) this.hooks.onScatterPaint(sp.id, encodePaint(sp.grid), false);
    },

    /** The paint into the scene now and then while a stroke goes on (no undo step), so the scatter follows. */
    _spLive(first) {
        const sp = this._sp;
        const now = (this.win || window).performance.now();
        if (!first && now - sp.lastLive < LIVE_MS) return;
        sp.lastLive = now;
        if (this.hooks.onScatterPaint) this.hooks.onScatterPaint(sp.id, encodePaint(sp.grid), true, first);
    },
};
