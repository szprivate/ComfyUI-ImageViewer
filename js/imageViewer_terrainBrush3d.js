// imageViewer_terrainBrush3d.js
// The terrain brushes in the 3D view: sculpt (raise, lower, smooth, flatten, restore) and paint
// the ground layers, straight onto a terrain. A mixin on Model3DView (Object.assign'd in
// imageViewer_model3d.js); the data is imageViewer_terrainSculpt.js.
//
// A left drag on the terrain uses the tool (Ctrl / Cmd held: raise <-> lower, paint <-> erase),
// Alt still navigates, [ and ] size the brush, Esc or the bar's Done stops. The mesh changes in
// place while the stroke goes on; when the button is let go the stroke lands in the scene as one
// undo step (hooks.onTerrainEdit(id, patch)), which rebuilds the terrain - and the
// scatters on it, so they stand on the new ground.

import { terrainSettings } from "./imageViewer_worldData.js";
import {
    SCULPT_TOOLS, LAYER_TOOL, decodeSculpt, encodeSculpt, sculptDab, sculptEmpty, vertexAt,
    decodeLayerPaint, encodeLayerPaint, layerDab, layerAt, mixLayers, layerPaintEmpty, LAYER_RES,
} from "./imageViewer_terrainSculpt.js";

export const TERRAIN_TOOLS = [...SCULPT_TOOLS, LAYER_TOOL];
export const TERRAIN_BRUSH_DEFAULTS = { tool: "raise", layer: 1, radius: 10, strength: 0.5, hardness: 0.3 };

export const TerrainBrush3DMixin = {

    terrainBrushing() { return !!this._tb; },

    terrainBrush() {
        if (!this._tbBrush) this._tbBrush = { ...TERRAIN_BRUSH_DEFAULTS };
        return this._tbBrush;
    },

    terrainBrushSet(patch) {
        const b = this.terrainBrush();
        if (patch.tool != null && TERRAIN_TOOLS.includes(patch.tool)) b.tool = patch.tool;
        if (patch.layer != null) b.layer = Math.min(3, Math.max(0, Math.round(Number(patch.layer)) || 0));
        if (patch.radius != null) b.radius = Math.min(1000, Math.max(0.1, Number(patch.radius) || b.radius));
        if (patch.strength != null) b.strength = Math.min(1, Math.max(0.01, Number(patch.strength) || 0.01));
        if (patch.hardness != null) b.hardness = Math.min(0.99, Math.max(0, Number(patch.hardness) || 0));
        if (this._tbRing) this._tbRing.scale.setScalar(b.radius);
        if (this.hooks.onTerrainBrush) this.hooks.onTerrainBrush(b);
        this.requestRender();
        return b;
    },

    /** Start the terrain brushes on terrain `id`. Answers an error text, or "". */
    terrainBrushBegin(id, patch = null) {
        if (this._sp && this.scatterPaintEnd) this.scatterPaintEnd();
        this.terrainBrushEnd();
        const entry = this._entries.get(id);
        if (!entry || !entry.item || entry.item.kind !== "terrain") return "Select a terrain to edit.";
        if (!entry.terrain) return "The terrain is not built yet.";
        if (!this.canvas) return "The 3D view is not up.";
        if (patch) this.terrainBrushSet(patch);
        this._tb = { id, stroke: null, canvas: this.canvas, win: this.win || window };
        this._tbLoad(entry);
        const { THREE } = this.libs;
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
            side: THREE.DoubleSide, toneMapped: false, fog: false }));
        ring.add(new THREE.Mesh(new THREE.RingGeometry(0, 0.03, 16).rotateX(-Math.PI / 2), ring.material));
        ring.name = "terrainbrush";
        ring.renderOrder = 999;
        ring.visible = false;
        ring.raycast = () => {};
        ring.children[0].raycast = () => {};
        ring.scale.setScalar(this.terrainBrush().radius);
        this.scene.add(ring);
        this._tbRing = ring;
        const c = this.canvas;
        this._tbMove = (e) => this._tbPointerMove(e);
        this._tbUp = (e) => this._tbPointerUp(e);
        this._tbLeave = () => { if (this._tbRing && !(this._tb && this._tb.stroke)) { this._tbRing.visible = false; this.requestRender(); } };
        this._tbKey = (e) => this._tbKeyDown(e);
        c.addEventListener("pointermove", this._tbMove);
        c.addEventListener("pointerup", this._tbUp);
        c.addEventListener("pointercancel", this._tbUp);
        c.addEventListener("pointerleave", this._tbLeave);
        this._tb.win.addEventListener("keydown", this._tbKey, true);
        this.root.classList.add("scatter-painting");
        this.requestRender();
        return "";
    },

    terrainBrushEnd() {
        const tb = this._tb;
        if (!tb) return;
        if (tb.stroke) this._tbFinish();
        const c = tb.canvas;
        c.removeEventListener("pointermove", this._tbMove);
        c.removeEventListener("pointerup", this._tbUp);
        c.removeEventListener("pointercancel", this._tbUp);
        c.removeEventListener("pointerleave", this._tbLeave);
        tb.win.removeEventListener("keydown", this._tbKey, true);
        if (this._tbRing) {
            this.scene.remove(this._tbRing);
            this._tbRing.geometry.dispose();
            this._tbRing.children[0].geometry.dispose();
            this._tbRing.material.dispose();
            this._tbRing = null;
        }
        this._tb = null;
        this.root.classList.remove("scatter-painting");
        if (this.hooks.onTerrainBrushEnd) this.hooks.onTerrainBrushEnd(tb.id);
        this.requestRender();
    },

    /** Take the terrain's edits (again): after a rebuild, an undo, a typed value. */
    terrainBrushReload(item) {
        const tb = this._tb;
        if (!tb || tb.stroke) return;
        if (!item || item.kind !== "terrain") { this.terrainBrushEnd(); return; }
        tb.item = item;
        tb.stale = true;              // read again at the next press, from the rebuilt terrain
    },

    /** The brush's grids from the terrain as built: sculpt on its vertex grid, the layer paint. */
    _tbLoad(entry) {
        const tb = this._tb, T = entry.terrain;
        const t = terrainSettings(entry.item);
        const n = T.seg + 1;
        tb.n = n;
        tb.sculpt = decodeSculpt(t.sculpt, n);
        tb.paint = decodeLayerPaint(t.layerPaint, LAYER_RES);
        tb.base = new Float32Array(n * n);
        for (let i = 0; i < tb.base.length; i++) tb.base[i] = T.base[i] * T.height;
        tb.mesh = T.mesh;
        tb.stale = false;
    },

    _tbKeyDown(e) {
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        let took = true;
        if (e.key === "Escape") this.terrainBrushEnd();
        else if (e.key === "[") this.terrainBrushSet({ radius: this.terrainBrush().radius / 1.25 });
        else if (e.key === "]") this.terrainBrushSet({ radius: this.terrainBrush().radius * 1.25 });
        else took = false;
        if (took) { e.preventDefault(); e.stopImmediatePropagation(); }
    },

    _tbEntry() {
        const e = this._tb && this._entries.get(this._tb.id);
        return e && e.terrain ? e : null;
    },

    /** Where the pointer meets the terrain: {u, v, point, normal, sx, sz, T} or null. */
    _tbHit(e) {
        const entry = this._tbEntry();
        if (!entry) return null;
        const { THREE } = this.libs;
        const T = entry.terrain;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1,
                                      -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.activeCameraObject());
        ray.layers.enableAll();
        const hits = ray.intersectObject(T.mesh, false);
        if (!hits.length) return null;
        const body = this._bodyOf(entry);
        body.updateMatrixWorld(true);
        const local = body.worldToLocal(hits[0].point.clone());
        const s = new THREE.Vector3();
        body.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
        const normal = hits[0].face ? hits[0].face.normal.clone().transformDirection(T.mesh.matrixWorld) : new THREE.Vector3(0, 1, 0);
        return { u: local.x / T.size[0] + 0.5, v: local.z / T.size[1] + 0.5, y: local.y, point: hits[0].point, normal,
                 sx: Math.abs(s.x) || 1, sz: Math.abs(s.z) || 1, T };
    },

    _tbRingAt(hit, invert = false) {
        const ring = this._tbRing;
        if (!ring) return;
        if (!hit) { ring.visible = false; this.requestRender(); return; }
        const { THREE } = this.libs;
        ring.visible = true;
        ring.position.copy(hit.point).addScaledVector(hit.normal, 0.05);
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hit.normal);
        ring.material.color.set(invert ? 0x6fb6ff : 0xffffff);
        this.requestRender();
    },

    /** The tool a stroke uses: Ctrl turns raise into lower and the other way round, paint into erase. */
    _tbTool(e) {
        const b = this.terrainBrush();
        const flip = !!(e.ctrlKey || e.metaKey);
        if (!flip) return { tool: b.tool, erase: false };
        if (b.tool === "raise") return { tool: "lower", erase: false };
        if (b.tool === "lower") return { tool: "raise", erase: false };
        return { tool: b.tool, erase: b.tool === LAYER_TOOL };
    },

    /** From _onPointerDown (capture): a left press without Alt. True when it took the press. */
    _tbDown(e) {
        const tb = this._tb;
        if (!tb || e.button !== 0 || e.altKey) return false;
        if (tb.canvas !== this.canvas) { this.terrainBrushEnd(); return false; }
        const entry = this._tbEntry();
        if (!entry) return false;
        if (tb.stale || tb.mesh !== entry.terrain.mesh) this._tbLoad(entry);
        const hit = this._tbHit(e);
        if (!hit) return false;
        const { tool, erase } = this._tbTool(e);
        // Flatten holds the ground at the height where the stroke began.
        const to = vertexAt({ res: tb.n, cells: tb.base }, hit.u, hit.v) + vertexAt(tb.sculpt, hit.u, hit.v);
        tb.stroke = { id: e.pointerId, u: hit.u, v: hit.v, tool, erase, to, changed: false };
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
        this._tbDab(hit, hit.u, hit.v);
        this._tbRingAt(hit, tool === "lower" || erase);
        return true;
    },

    _tbPointerMove(e) {
        const tb = this._tb;
        if (!tb) return;
        if (e.altKey && !tb.stroke) { this._tbRingAt(null); return; }
        const hit = this._tbHit(e);
        const st = tb.stroke;
        const inv = st ? (st.tool === "lower" || st.erase) : this._tbTool(e).tool === "lower" || this._tbTool(e).erase;
        this._tbRingAt(hit, inv);
        if (!st || e.pointerId !== st.id || !hit) return;
        // Dabs a quarter of the brush apart along the way.
        const [ru, rv] = this._tbRadii(hit);
        const steps = Math.max(1, Math.ceil(Math.hypot((hit.u - st.u) / ru, (hit.v - st.v) / rv) * 4));
        if (steps > 64) { st.u = hit.u; st.v = hit.v; }
        for (let i = 1; i <= Math.min(steps, 64); i++) {
            const t = i / Math.min(steps, 64);
            this._tbDab(hit, st.u + (hit.u - st.u) * t, st.v + (hit.v - st.v) * t);
        }
        st.u = hit.u; st.v = hit.v;
    },

    _tbRadii(hit) {
        const r = this.terrainBrush().radius;
        return [r / (hit.T.size[0] * hit.sx), r / (hit.T.size[1] * hit.sz)];
    },

    /** One dab at u, v, and the mesh changed to match. */
    _tbDab(hit, u, v) {
        const tb = this._tb, st = tb.stroke, b = this.terrainBrush();
        const [ru, rv] = this._tbRadii(hit);
        const T = hit.T;
        if (st.tool === LAYER_TOOL) {
            if (!layerDab(tb.paint, u, v, ru, rv, { layer: b.layer, strength: b.strength * 0.5, hardness: b.hardness, erase: st.erase })) return;
            st.changed = true;
            this._tbLayersToMesh(T, u, v, ru, rv);
            return;
        }
        const box = sculptDab(tb.sculpt, tb.base, u, v, ru, rv, {
            tool: st.tool, amount: b.strength * b.radius * 0.03, strength: b.strength * 0.5, hardness: b.hardness, to: st.to });
        if (!box) return;
        st.changed = true;
        const [x0, y0, x1, y1] = box, n = tb.n;
        const pos = T.mesh.geometry.attributes.position;
        const H = T.height || 1;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const i = y * n + x, h = tb.base[i] + tb.sculpt.cells[i];
                T.heights[i] = h / H;
                pos.setY(i, h);
            }
        }
        pos.needsUpdate = true;
        T.mesh.geometry.computeVertexNormals();
        T.mesh.geometry.computeBoundingSphere();
        T.mesh.geometry.computeBoundingBox();
        this.requestRender();
    },

    /** The layer paint into the mesh's layer weights, around u, v. */
    _tbLayersToMesh(T, u, v, ru, rv) {
        const tb = this._tb, n = tb.n, seg = n - 1;
        const attr = T.mesh.geometry.attributes.aSplat;
        const x0 = Math.max(0, Math.floor((u - ru) * seg) - 1), x1 = Math.min(seg, Math.ceil((u + ru) * seg) + 1);
        const y0 = Math.max(0, Math.floor((v - rv) * seg) - 1), y1 = Math.min(seg, Math.ceil((v + rv) * seg) + 1);
        const p4 = [0, 0, 0, 0], r4 = [0, 0, 0, 0], o4 = [0, 0, 0, 0];
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const i = y * n + x;
                layerAt(tb.paint, x / seg, y / seg, p4);
                for (let k = 0; k < 4; k++) r4[k] = T.ruleWeights[i * 4 + k];
                mixLayers(r4, p4, o4);
                for (let k = 0; k < 4; k++) attr.array[i * 4 + k] = o4[k];
            }
        }
        attr.needsUpdate = true;
        this.requestRender();
    },

    _tbPointerUp(e) {
        const tb = this._tb;
        if (!tb || !tb.stroke || (e && e.pointerId !== tb.stroke.id)) return;
        try { this.canvas.releasePointerCapture(tb.stroke.id); } catch (_) { /* gone */ }
        this._tbFinish();
    },

    _tbFinish() {
        const tb = this._tb, st = tb.stroke;
        tb.stroke = null;
        if (!this.hooks.onTerrainEdit || !st.changed) return;
        const patch = st.tool === LAYER_TOOL
            ? { layerPaint: layerPaintEmpty(tb.paint) ? null : encodeLayerPaint(tb.paint) }
            : { sculpt: sculptEmpty(tb.sculpt) ? null : encodeSculpt(tb.sculpt) };
        tb.stale = true;
        this.hooks.onTerrainEdit(tb.id, patch);
    },
};
