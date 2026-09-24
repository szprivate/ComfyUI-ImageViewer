// bEpicViewer_worldMatch.js
// Matching a world to its reference picture, by measurement.
//
// The world is rendered from the reference camera — without the picture's own
// depth mesh, or it would only be compared with itself — and set against the
// picture on a 3 x 3 grid: per cell the brightness (as log luminance, which is
// how a change in light is seen), the colour balance (two opponent axes) and
// the contrast. The settings that decide the look without changing what is in
// the world — exposure, fill light, sun, fog, and how much photographed light
// each surface keeps — are then searched one at a time (golden-section, two
// passes) for the lowest error. Every try is one small render.
//
// A mixin on Model3DView like bEpicViewer_world3d.js, whose builders it
// leans on (entry.terrain.uniforms, the environment's lights).

import { environmentSettings, terrainSettings, referenceSettings } from "./bEpicViewer_worldData.js";

const GRID = 3;
const WIDTH = 160;            // renders and the picture are compared at this width

// Rows count differently: the middle band is where a picture's objects stand
// (cars, people, the far end) and the world's surfaces least resemble it.
const ROW_WEIGHT = [1, 0.5, 1];

function median(values) {
    if (!values.length) return 0;
    const v = Float32Array.from(values).sort();
    return v[v.length >> 1];
}

/**
 * Per cell, what its surface typically looks like: the MEDIAN log luminance
 * and colour, and the spread between its quartiles. Medians, not means: a few
 * cars, lamps or painted lines in the picture, which the world's surfaces
 * don't have, then leave the number alone instead of pulling the whole cell.
 */
function cellStats(data, w, h) {
    const n = GRID * GRID;
    const cells = Array.from({ length: n }, () => ({ l: [], a: [], b: [] }));
    for (let y = 0; y < h; y++) {
        const cy = Math.min(GRID - 1, Math.floor((y / h) * GRID));
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const c = cells[cy * GRID + Math.min(GRID - 1, Math.floor((x / w) * GRID))];
            c.l.push(Math.log(lum + 0.02)); c.a.push(r - g); c.b.push((r + g) / 2 - b);
        }
    }
    return cells.map((c) => {
        const sorted = Float32Array.from(c.l).sort();
        const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] || 0;
        return { logL: q(0.5), spread: q(0.75) - q(0.25), a: median(c.a), b: median(c.b) };
    });
}

/** The error between two sets of cell statistics, and its parts. */
export function matchError(render, ref) {
    let bright = 0, colour = 0, contrast = 0, weight = 0;
    for (let i = 0; i < ref.length; i++) {
        const wgt = ROW_WEIGHT[Math.floor(i / GRID)];
        const dl = render[i].logL - ref[i].logL;
        const ds = render[i].spread - ref[i].spread;
        const dc = Math.hypot(render[i].a - ref[i].a, render[i].b - ref[i].b) * 4;
        bright += wgt * dl * dl; contrast += wgt * ds * ds; colour += wgt * dc * dc; weight += wgt;
    }
    return { total: (bright + 0.5 * contrast + 0.5 * colour) / weight,
             brightness: bright / weight, contrast: contrast / weight, colour: colour / weight };
}

export const WorldMatchMixin = {

    /** The camera a world is matched through: one carrying a reference. */
    _matchCamera() {
        const pick = (e) => e && e.camera && referenceSettings(e.item);
        const ref = this._entries.get("refcam");
        if (pick(ref)) return ref;
        for (const e of this._entries.values()) if (pick(e)) return e;
        return null;
    },

    /** What the settings are now, and how far each may go. */
    _matchParams() {
        const env = [...this._entries.values()].find((e) => e.item.kind === "environment" && e.envApplied);
        if (!env) return null;
        const s = environmentSettings(env.item);
        const params = [
            { key: "exposure", path: ["env", "render.exposure"], value: s.render.exposure, lo: 0.15, hi: 6, log: true },
            { key: "fill", path: ["env", "ambient.intensity"], value: Math.max(0.05, s.ambient.intensity), lo: 0.05, hi: 12, log: true },
        ];
        if (s.sun.intensity > 0.05) {
            params.push({ key: "sun", path: ["env", "sun.intensity"], value: s.sun.intensity, lo: 0.05, hi: 12, log: true });
        }
        if (s.fog.density > 0) {
            params.push({ key: "fog", path: ["env", "fog.density"], value: s.fog.density, lo: 0.0005, hi: 0.08, log: true });
        }
        for (const e of this._entries.values()) {
            if (e.item.kind !== "terrain" || !e.terrain || !e.terrain.uniforms) continue;
            params.push({ key: `bake:${e.item.id}`, path: [e.item.id, "terrain.layers.0.baked"],
                          value: terrainSettings(e.item).layers[0].baked, lo: 0, hi: 1.5, log: false, entry: e });
        }
        return { env, params };
    },

    /** Put a set of values on screen without rebuilding anything. */
    _matchApply(env, params, values) {
        const s = environmentSettings(env.item);
        params.forEach((p, i) => {
            const v = values[i];
            if (p.key === "exposure") this.renderer.toneMappingExposure = this.exposure * v;
            else if (p.key === "fill") {
                const share = this.scene.environment ? s.render.fill : 1;
                for (const o of env.worldExtras || []) if (o.isHemisphereLight) o.intensity = v * share;
            } else if (p.key === "sun") {
                for (const o of env.worldExtras || []) if (o.isDirectionalLight) o.intensity = v;
            } else if (p.key === "fog") {
                if (this.scene.fog) this.scene.fog.density = v;
            } else if (p.entry) {
                p.entry.terrain.uniforms.uBake.value.x = v;
            }
        });
    },

    /** One small render from the camera, as RGBA bytes. */
    _matchGrab(camEntry, w, h, hidden) {
        const cam = camEntry.camera;
        cam.aspect = w / h;
        cam.fov = camEntry.item.fov || 35;
        cam.updateProjectionMatrix();
        for (const o of hidden) o.visible = false;
        this._worldRender(cam);
        for (const o of hidden) o.visible = true;
        const out = this._matchCanvas;
        out.getContext("2d").drawImage(this.renderer.domElement, 0, 0, w, h, 0, 0, w, h);
        return out.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    },

    /**
     * Match the world to its reference. Returns
     *   { before, after, values: {key: value}, ops: [edit operations], cells }
     * and leaves the matched values on screen (the caller saves them).
     */
    async matchReference({ onProgress, passes = 2 } = {}) {
        if (!this.libs || !this.renderer) throw new Error("the 3D view isn't running");
        const camEntry = this._matchCamera();
        if (!camEntry) throw new Error("no camera with a reference picture to match");
        const setup = this._matchParams();
        if (!setup) throw new Error("this world has no environment to adjust");
        const { env, params } = setup;
        const ref = referenceSettings(camEntry.item);
        const px = await this._worldPixels(ref.src, WIDTH);
        const w = px.width, h = px.height;
        const target = cellStats(px.data, w, h);

        // Render at the comparison size; everything that isn't the world is hidden.
        const ratio = this.renderer.getPixelRatio();
        const size = this.renderer.getSize(new this.libs.THREE.Vector2());
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(w, h, false);
        this._worldResize(w, h);
        this._matchCanvas = this.doc.createElement("canvas");
        this._matchCanvas.width = w; this._matchCanvas.height = h;
        const hidden = [this.grid, this.gizmoHelper, this._pinGroup, this._pivotMark].filter(Boolean);
        for (const e of this._entries.values()) {
            if (e.item.kind === "depthmesh" && e.object) hidden.push(e.object);
            if (e.helper) hidden.push(e.helper);
            if (e.axes) hidden.push(e.axes);
        }
        const values = params.map((p) => p.value);
        let evals = 0;
        const score = (vals) => {
            this._matchApply(env, params, vals);
            evals += 1;
            return matchError(cellStats(this._matchGrab(camEntry, w, h, hidden), w, h), target).total;
        };
        const yieldNow = () => new Promise((r) => this.win.setTimeout(r, 0));

        try {
            const before = matchError(cellStats(this._matchGrab(camEntry, w, h, hidden), w, h), target);
            let best = score(values);
            const G = (Math.sqrt(5) - 1) / 2;
            for (let pass = 0; pass < passes; pass++) {
                for (let i = 0; i < params.length; i++) {
                    const p = params[i];
                    const to = (t) => (p.log ? Math.exp(Math.log(p.lo) + t * (Math.log(p.hi) - Math.log(p.lo))) : p.lo + t * (p.hi - p.lo));
                    const at = (t) => { const v = values.slice(); v[i] = to(t); return score(v); };
                    // Golden-section over the whole range the first pass, then
                    // around the current value.
                    const cur = p.log ? (Math.log(values[i]) - Math.log(p.lo)) / (Math.log(p.hi) - Math.log(p.lo))
                                      : (values[i] - p.lo) / (p.hi - p.lo);
                    let a = pass === 0 ? 0 : Math.max(0, cur - 0.15), b = pass === 0 ? 1 : Math.min(1, cur + 0.15);
                    let c = b - G * (b - a), d = a + G * (b - a), fc = at(c), fd = at(d);
                    for (let k = 0; k < 7; k++) {
                        if (fc < fd) { b = d; d = c; fd = fc; c = b - G * (b - a); fc = at(c); }
                        else { a = c; c = d; fc = fd; d = a + G * (b - a); fd = at(d); }
                    }
                    const t = fc < fd ? c : d, f = Math.min(fc, fd);
                    if (f < best) { best = f; values[i] = to(t); }
                    if (onProgress) onProgress({ pass, param: p.key, error: best, evals });
                    await yieldNow();
                }
            }
            this._matchApply(env, params, values);
            const finalStats = cellStats(this._matchGrab(camEntry, w, h, hidden), w, h);
            const after = matchError(finalStats, target);
            const rows = ["top", "middle", "bottom"].map((name, r) => {
                const cells = [0, 1, 2].map((c) => r * GRID + c);
                const ratio = Math.exp(cells.reduce((s, i) => s + finalStats[i].logL - target[i].logL, 0) / 3);
                return { band: name, brightness_vs_picture: Math.round(ratio * 100) / 100 };
            });
            const round = (v) => (Math.abs(v) >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
            const ops = params.map((p, i) => ({ op: "set", id: p.path[0], path: p.path[1], value: round(values[i]) }));
            return {
                before: { total: round(before.total), brightness: round(before.brightness), colour: round(before.colour),
                          contrast: round(before.contrast) },
                after: { total: round(after.total), brightness: round(after.brightness), colour: round(after.colour),
                         contrast: round(after.contrast) },
                values: Object.fromEntries(params.map((p, i) => [p.key, round(values[i])])),
                rows, ops, evals,
            };
        } finally {
            this.renderer.setPixelRatio(ratio);
            this.renderer.setSize(size.x, size.y, false);
            this._resize();
        }
    },
};
