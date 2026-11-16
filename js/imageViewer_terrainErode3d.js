// imageViewer_terrainErode3d.js
// Erosion running on a terrain in the 3D view, live: a mixin on Model3DView. The simulation is
// imageViewer_terrainErodeGpu.js (the GPU; float render targets) or, where the GPU cannot,
// imageViewer_terrainErode.js on the CPU a few steps a frame. The mesh follows as it runs; the
// panel (imageViewer_previzTerrain.js) turns the result into the terrain's sculpt when applied.
//
// The simulation's grid is the terrain's vertex grid; heights go in as metres / cell size.

import { cleanErode, makeState, erodeStep, erodeMasks } from "./imageViewer_terrainErode.js";
import { TerrainErodeGpu, erodeGpuOk } from "./imageViewer_terrainErodeGpu.js";

// Simulation steps a frame: GPU, CPU (a 257 x 257 CPU step is ~20 ms).
const GPU_STEPS = 10;
const CPU_STEPS = 1;

export const TerrainErode3DMixin = {

    terrainEroding() { return !!this._te; },

    /**
     * Start an erosion on terrain `id` with settings `opts` (paused until `terrainErodeRun`).
     * Answers an error text, or "".
     */
    terrainErodeBegin(id, opts) {
        this.terrainErodeEnd(false);
        if (this._sp && this.scatterPaintEnd) this.scatterPaintEnd();
        if (this._tb && this.terrainBrushEnd) this.terrainBrushEnd();
        const entry = this._entries.get(id);
        if (!entry || !entry.item || entry.item.kind !== "terrain") return "Select a terrain to erode.";
        if (!entry.terrain) return "The terrain is not built yet.";
        if (!this.renderer) return "The 3D view is not up.";
        const T = entry.terrain, n = T.seg + 1;
        const cell = Math.sqrt((T.size[0] / T.seg) * (T.size[1] / T.seg));
        const start = new Float32Array(n * n);
        for (let i = 0; i < start.length; i++) start[i] = (T.heights[i] * T.height) / cell;
        this._te = { id, T, n, cell, start, opts: cleanErode(opts), gpu: null, cpu: null, running: false,
                     raf: 0, win: this.win || window, done: 0 };
        this._teMakeSim();
        this._teReport();
        return "";
    },

    /** The simulation from the start heights: on the GPU when it can, else on the CPU. */
    _teMakeSim() {
        const te = this._te;
        if (te.gpu) te.gpu.dispose();
        te.gpu = null; te.cpu = null; te.done = 0;
        if (this.renderer && erodeGpuOk(this.renderer) && !this._teCpuOnly) {
            try { te.gpu = new TerrainErodeGpu(this.libs.THREE, this.renderer, te.n, te.start, te.opts); } catch (e) {
                console.warn("[ImageViewer] erosion on the GPU failed, using the CPU", e);
                te.gpu = null;
            }
        }
        if (!te.gpu) te.cpu = makeState(te.n, te.start);
    },

    /** Change the settings (also while it runs). */
    terrainErodeSet(opts) {
        const te = this._te;
        if (!te) return;
        te.opts = cleanErode({ ...te.opts, ...opts });
        if (te.gpu) te.gpu.setOptions(te.opts);
        this._teReport();
    },

    terrainErodeRun(on = true) {
        const te = this._te;
        if (!te) return;
        te.running = !!on && te.done < te.opts.iterations;
        if (te.running && !te.raf) te.raf = te.win.requestAnimationFrame(() => this._teTick());
        this._teReport();
    },

    /** Back to the terrain as it was when the erosion began (keeps the settings). */
    terrainErodeReset() {
        const te = this._te;
        if (!te) return;
        this._teStop();
        this._teShow(te.start);
        this._teMakeSim();
        this._teReport();
    },

    /**
     * Stop. With `keep`, answers the result: {heights (metres, n x n), masks, n}; otherwise the
     * mesh is put back as it was and nothing is answered.
     */
    terrainErodeEnd(keep = false) {
        const te = this._te;
        if (!te) return null;
        this._teStop();
        let out = null;
        if (keep && te.done > 0) {
            const st = te.gpu ? te.gpu.read(true) : te.cpu;
            const heights = new Float32Array(te.n * te.n);
            for (let i = 0; i < heights.length; i++) heights[i] = st.b[i] * te.cell;
            out = { id: te.id, n: te.n, heights, masks: erodeMasks(st), steps: te.done, base: te.T.base, height: te.T.height };
        } else {
            this._teShow(te.start);
        }
        if (te.gpu) te.gpu.dispose();
        this._te = null;
        if (this.hooks.onTerrainErode) this.hooks.onTerrainErode(null);
        return out;
    },

    /** The terrain eroded, while its mesh is still the one the erosion began on (else false). */
    terrainErodeFor(id) {
        const te = this._te;
        if (!te) return false;
        const entry = this._entries.get(te.id);
        return te.id === id && !!entry && entry.terrain === te.T;
    },

    terrainErodeState() {
        const te = this._te;
        return te ? { id: te.id, done: te.done, of: te.opts.iterations, running: te.running, gpu: !!te.gpu, opts: { ...te.opts } } : null;
    },

    _teStop() {
        const te = this._te;
        if (!te) return;
        te.running = false;
        if (te.raf) { te.win.cancelAnimationFrame(te.raf); te.raf = 0; }
    },

    _teTick() {
        const te = this._te;
        if (!te) return;
        te.raf = 0;
        if (!te.running) return;
        const want = Math.min(te.gpu ? GPU_STEPS : CPU_STEPS, te.opts.iterations - te.done);
        if (te.gpu) te.gpu.step(want);
        else for (let i = 0; i < want; i++) erodeStep(te.cpu, te.opts);
        te.done += want;
        const st = te.gpu ? te.gpu.read(false) : te.cpu;
        this._teShow(st.b);
        if (te.done >= te.opts.iterations) te.running = false;
        this._teReport();
        if (te.running) te.raf = te.win.requestAnimationFrame(() => this._teTick());
    },

    /** Grid heights (grid units) onto the terrain's mesh. */
    _teShow(b) {
        const te = this._te;
        const entry = te && this._entries.get(te.id);
        if (!entry || entry.terrain !== te.T) return;
        const T = te.T, geom = T.mesh.geometry, pos = geom.attributes.position;
        const H = T.height || 1;
        for (let i = 0; i < pos.count; i++) {
            const h = b[i] * te.cell;
            T.heights[i] = h / H;
            pos.setY(i, h);
        }
        pos.needsUpdate = true;
        geom.computeVertexNormals();
        geom.computeBoundingSphere();
        geom.computeBoundingBox();
        this.requestRender();
    },

    _teReport() {
        const te = this._te;
        if (te && this.hooks.onTerrainErode) {
            this.hooks.onTerrainErode({ done: te.done, of: te.opts.iterations, running: te.running, gpu: !!te.gpu });
        }
    },
};
