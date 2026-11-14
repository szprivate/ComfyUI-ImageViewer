// imageViewer_previzAgentTerrain.js
// The agent's hands on the Terrain menu: a new terrain and its settings, sculpt and
// layer-paint strokes, scatters and where they grow, erosion run live in the view and
// applied, and the ground's height at given places (to stand a model or a camera on it).
// agentY-core's animate_scene sends these through POST /imageviewer/rig/agent like the
// rest of SCENE_AGENT_ACTIONS (imageViewer_previzAgentScene.js hands them on here).
//
// Strokes are given in world metres: {points: [[x, z], ...], radius, strength, hardness}.
// They go through the same dabs as the brushes in the view (imageViewer_terrainSculpt.js,
// imageViewer_scatterPaint.js), each stroke one undo step, as a stroke by hand is. The
// erosion is the Terrain > Erode… box itself, so it runs on screen, then Apply.

import * as S from "./imageViewer_scene3d.js";
import { SCATTER_TYPES, scatterSettings, terrainSettings } from "./imageViewer_worldData.js";
import {
    SCULPT_TOOLS, decodeSculpt, encodeSculpt, sculptDab, sculptEmpty,
    decodeLayerPaint, encodeLayerPaint, layerDab, LAYER_RES,
} from "./imageViewer_terrainSculpt.js";
import { PAINT_RES, decodePaint, encodePaint, stampBrush } from "./imageViewer_scatterPaint.js";
import { ERODE_DEFAULTS, MASK_KINDS, cleanErode } from "./imageViewer_terrainErode.js";

export const TERRAIN_AGENT_ACTIONS = [
    "terrain_add", "terrain_set", "terrain_sculpt", "terrain_paint", "terrain_clear", "terrain_height",
    "terrain_erode", "scatter_add", "scatter_set", "scatter_paint",
];

const TERRAIN_FIELDS = ["seed", "roughness", "size", "height", "segments", "rules"];
const SCATTER_FIELDS = ["count", "seed", "scale", "layer", "maxSlope", "color", "wind", "grid", "aspect", "lift",
                        "emissive", "roughness", "clear"];
const SCATTER_ALIASES = { max_slope: "maxSlope" };

const sleep = (win, ms) => new Promise((r) => (win || window).setTimeout(r, ms));
const isNum = (v) => Number.isFinite(Number(v));

export const PrevizAgentTerrainMixin = {

    // ── Finding things ────────────────────────────────────────────────────

    _asaTerrain(scene, w) {
        if (w) {
            const it = this._asaItem(scene, w, "terrain");
            if (it.kind !== "terrain") throw new Error(`${w} is not a terrain`);
            return it;
        }
        const all = scene.items.filter((i) => i.kind === "terrain");
        if (all.length === 1) return all[0];
        throw new Error(all.length ? "name the terrain (there is more than one)" : "the scene has no terrain: terrain_add first");
    },

    _asaScatter(scene, w) {
        if (w) {
            const it = this._asaItem(scene, w, "scatter");
            if (it.kind !== "scatter") throw new Error(`${w} is not a scatter`);
            return it;
        }
        const all = scene.items.filter((i) => i.kind === "scatter");
        if (all.length === 1) return all[0];
        throw new Error(all.length ? "name the scatter (there is more than one)" : "the scene has no scatter: scatter_add first");
    },

    /** The terrain as built in the view (its heights and mesh), once the view has caught up with the scene. */
    async _asaBuilt(item, ms = 30000) {
        const view = this._modelView();
        const win = this._viewerWindow ? this._viewerWindow() : window;
        try { if (view.whenLoaded) await view.whenLoaded(ms); } catch (_) { /* checked below */ }
        const t = terrainSettings(item);
        const until = Date.now() + ms;
        for (;;) {
            const entry = view._entries && view._entries.get(item.id);
            const T = entry && entry.terrain;
            if (T && T.seg === t.segments && T.height === t.height && T.size[0] === t.size[0] && T.size[1] === t.size[1]) {
                return { view, entry, T };
            }
            if (Date.now() > until) throw new Error(`${item.name} is not built in the view yet`);
            await sleep(win, 50);
        }
    },

    /** World [x, z] (or [x, y, z]) to the terrain's u, v (0..1), and metres to its radii. */
    _asaUV(built, p) {
        const { view, entry, T } = built;
        const { THREE } = view.libs;
        const body = view._bodyOf(entry);
        body.updateMatrixWorld(true);
        const w = p.length >= 3 ? new THREE.Vector3(+p[0], +p[1], +p[2]) : new THREE.Vector3(+p[0], 0, +p[1]);
        const local = body.worldToLocal(w);
        return [local.x / T.size[0] + 0.5, local.z / T.size[1] + 0.5];
    },

    _asaRadii(built, r) {
        const { view, entry, T } = built;
        const { THREE } = view.libs;
        const s = new THREE.Vector3();
        view._bodyOf(entry).matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
        return [r / (T.size[0] * (Math.abs(s.x) || 1)), r / (T.size[1] * (Math.abs(s.z) || 1))];
    },

    /** A stroke's points as u, v, with dabs a quarter of the brush apart between them. */
    _asaStrokeUV(built, stroke, ru, rv) {
        const pts = Array.isArray(stroke.points) ? stroke.points : stroke.point ? [stroke.point] : [];
        const uv = pts.filter((p) => Array.isArray(p) && p.length >= 2 && p.every(isNum)).map((p) => this._asaUV(built, p));
        if (!uv.length) throw new Error("a stroke needs points: [[x, z], ...] in metres");
        const out = [uv[0]];
        for (let i = 1; i < uv.length; i++) {
            const [u0, v0] = uv[i - 1], [u1, v1] = uv[i];
            const steps = Math.min(2000, Math.max(1, Math.ceil(Math.hypot((u1 - u0) / ru, (v1 - v0) / rv) * 4)));
            for (let k = 1; k <= steps; k++) out.push([u0 + (u1 - u0) * k / steps, v0 + (v1 - v0) * k / steps]);
        }
        return out;
    },

    _asaStrokes(a) {
        const list = Array.isArray(a.strokes) ? a.strokes : (a.points || a.point) ? [a] : [];
        if (!list.length) throw new Error("give strokes: [{points: [[x, z], ...], radius, strength, hardness}]");
        return list;
    },

    // ── Terrains ──────────────────────────────────────────────────────────

    _asaTerrainPatch(item, a) {
        const t = { ...(item.terrain || {}) };
        for (const k of TERRAIN_FIELDS) if (a[k] !== undefined) t[k] = a[k];
        if (Array.isArray(a.layers)) {
            const cur = terrainSettings(item).layers;
            t.layers = cur.map((l, i) => ({ ...((item.terrain && item.terrain.layers && item.terrain.layers[i]) || {}),
                                           ...(a.layers[i] && typeof a.layers[i] === "object" ? a.layers[i] : {}) }));
        }
        item.terrain = t;
        for (const k of ["position", "rotation", "scale"]) if (Array.isArray(a[k]) && a[k].length === 3 && a[k].every(isNum)) item[k] = a[k].map(Number);
    },

    _asaTerrainOut(item) {
        const t = terrainSettings(item);
        return { terrain: item.name, id: item.id, size: t.size, height: t.height, seed: t.seed, roughness: t.roughness,
                 segments: t.segments, layers: t.layers.map((l) => l.name), sculpted: !!t.sculpt, layer_painted: !!t.layerPaint };
    },

    async _asa_terrain_add(scene, a) {
        const item = this.previzAddWorldItem("terrain");
        if (!item) throw new Error("could not add a terrain");
        if (a.name) item.name = S.uniqueName(scene, a.name, item.id);
        this._asaTerrainPatch(item, a);
        this.previzChanged({ reload: true });
        await this._asaBuilt(item);
        return this._asaTerrainOut(item);
    },

    async _asa_terrain_set(scene, a) {
        const item = this._asaTerrain(scene, a.terrain);
        this.previzSnapshot(`set ${item.name}`);
        if (a.name) item.name = S.uniqueName(scene, a.name, item.id);
        this._asaTerrainPatch(item, a);
        this.previzChanged({ reload: true });
        await this._asaBuilt(item);
        return this._asaTerrainOut(item);
    },

    /** Sculpt strokes: raise, lower, smooth, flatten (to a height, or the one under the first point), restore. */
    async _asa_terrain_sculpt(scene, a) {
        const item = this._asaTerrain(scene, a.terrain);
        if (!(terrainSettings(item).height > 0)) throw new Error(`${item.name} is flat: terrain_set height above 0 first`);
        const win = this._viewerWindow ? this._viewerWindow() : window;
        let done = 0;
        for (const st of this._asaStrokes(a)) {
            const tool = st.tool || a.tool || "raise";
            if (!SCULPT_TOOLS.includes(tool)) throw new Error(`tool is one of ${SCULPT_TOOLS.join(", ")}`);
            const built = await this._asaBuilt(item);
            const T = built.T, n = T.seg + 1;
            const grid = decodeSculpt(terrainSettings(item).sculpt, n);
            const base = new Float32Array(n * n);
            for (let i = 0; i < base.length; i++) base[i] = T.base[i] * T.height;
            const radius = Math.max(0.1, Number(st.radius ?? a.radius ?? 10));
            const strength = Math.min(1, Math.max(0.01, Number(st.strength ?? a.strength ?? 0.5)));
            const hardness = Math.min(0.99, Math.max(0, Number(st.hardness ?? a.hardness ?? 0.3)));
            const [ru, rv] = this._asaRadii(built, radius);
            const dabs = this._asaStrokeUV(built, st, ru, rv);
            // A given rise in metres spreads over the dabs; otherwise the brush's own amount per dab.
            const per = isNum(st.amount) ? Number(st.amount) / Math.max(1, dabs.length / 4) : strength * radius * 0.03;
            let to = isNum(st.to) ? Number(st.to) : null;
            if (tool === "flatten" && to === null) {
                const [u, v] = dabs[0];
                const x = Math.round(u * (n - 1)), y = Math.round(v * (n - 1));
                const i = Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x));
                to = base[i] + grid.cells[i];
            }
            const reps = Math.max(1, Math.min(20, Math.round(Number(st.passes ?? 1))));
            for (let r = 0; r < reps; r++) {
                for (const [u, v] of dabs) sculptDab(grid, base, u, v, ru, rv, { tool, amount: per, strength: strength * 0.5, hardness, to: to ?? 0 });
            }
            this.previzTerrainEditWrite(item.id, { sculpt: sculptEmpty(grid) ? null : encodeSculpt(grid) });
            done += 1;
            if (a.pause !== 0) await sleep(win, Math.max(0, Number(a.pause ?? 150)));
        }
        await this._asaBuilt(item);
        return { terrain: item.name, strokes: done };
    },

    /** Layer-paint strokes: layer 0..3 (ground, rock, cliff, peak by default), or erase back to the rules. */
    async _asa_terrain_paint(scene, a) {
        const item = this._asaTerrain(scene, a.terrain);
        const win = this._viewerWindow ? this._viewerWindow() : window;
        const names = terrainSettings(item).layers.map((l) => String(l.name || "").toLowerCase());
        let done = 0;
        for (const st of this._asaStrokes(a)) {
            let layer = st.layer ?? a.layer ?? 1;
            if (typeof layer === "string" && !isNum(layer)) {
                const i = names.indexOf(layer.toLowerCase());
                if (i < 0) throw new Error(`layer is 0-3 or one of ${names.join(", ")}`);
                layer = i;
            }
            layer = Math.min(3, Math.max(0, Math.round(Number(layer)) || 0));
            const built = await this._asaBuilt(item);
            const grid = decodeLayerPaint(terrainSettings(item).layerPaint, LAYER_RES);
            const radius = Math.max(0.1, Number(st.radius ?? a.radius ?? 10));
            const strength = Math.min(1, Math.max(0.01, Number(st.strength ?? a.strength ?? 0.6)));
            const hardness = Math.min(0.99, Math.max(0, Number(st.hardness ?? a.hardness ?? 0.3)));
            const erase = !!(st.erase ?? a.erase);
            const [ru, rv] = this._asaRadii(built, radius);
            for (const [u, v] of this._asaStrokeUV(built, st, ru, rv)) layerDab(grid, u, v, ru, rv, { layer, strength: strength * 0.5, hardness, erase });
            this.previzTerrainEditWrite(item.id, { layerPaint: encodeLayerPaint(grid) });
            done += 1;
            if (a.pause !== 0) await sleep(win, Math.max(0, Number(a.pause ?? 150)));
        }
        await this._asaBuilt(item);
        return { terrain: item.name, strokes: done };
    },

    async _asa_terrain_clear(scene, a) {
        const what = a.what === "layer_paint" || a.what === "layerPaint" ? "layerPaint"
            : a.what === "scatter_paint" ? "scatter" : "sculpt";
        if (what === "scatter") {
            const s = this._asaScatter(scene, a.scatter);
            this.previzScatterPaintClear(s.id);
            return { scatter: s.name, cleared: "paint" };
        }
        const item = this._asaTerrain(scene, a.terrain);
        this.previzTerrainClear(what, item.id);
        await this._asaBuilt(item);
        return { terrain: item.name, cleared: what === "sculpt" ? "sculpt" : "layer_paint" };
    },

    /** The ground's world height at [x, z] points: where to stand a model or a camera. */
    async _asa_terrain_height(scene, a) {
        const item = this._asaTerrain(scene, a.terrain);
        const built = await this._asaBuilt(item);
        const pts = Array.isArray(a.points) ? a.points : a.point ? [a.point] : [[0, 0]];
        return {
            terrain: item.name,
            points: pts.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => {
                const x = +p[0], z = +p[p.length >= 3 ? 2 : 1];
                const y = built.view._terrainHeightAt(built.entry, x, z);
                return { x, z, y: y == null ? null : Math.round(y * 1000) / 1000, inside: y != null };
            }),
        };
    },

    /**
     * Terrain > Erode… run in the view: settings (ERODE_DEFAULTS' names), Run until the
     * steps are done, then Apply (unless apply: false, which leaves the box open).
     */
    async _asa_terrain_erode(scene, a) {
        const item = this._asaTerrain(scene, a.terrain);
        await this._asaBuilt(item);
        if (!this.previzTerrainErodeOpen(item.id)) throw new Error(`could not start eroding ${item.name}`);
        const view = this._modelView();
        const opts = {};
        for (const k of Object.keys(ERODE_DEFAULTS)) if (a[k] !== undefined) opts[k] = a[k];
        if (a.steps !== undefined) opts.iterations = a.steps;
        this.previzTerrainErodeSet(cleanErode({ ...view.terrainErodeState().opts, ...opts }));
        this.previzTerrainErodeRun(true);
        const win = this._viewerWindow ? this._viewerWindow() : window;
        const until = Date.now() + Math.max(5, Number(a.timeout_seconds ?? 600)) * 1000;
        let st = view.terrainErodeState();
        while (st && st.done < st.of) {
            if (Date.now() > until) { this.previzTerrainErodeCancel(); throw new Error(`erosion stopped at ${st.done} of ${st.of} steps: too slow`); }
            if (!st.running) this.previzTerrainErodeRun(true);
            await sleep(win, 100);
            st = view.terrainErodeState();
        }
        if (!st) throw new Error("the erosion was closed while it ran");
        const out = { terrain: item.name, steps: st.done, gpu: st.gpu, settings: st.opts };
        if (a.apply === false) return { ...out, applied: false };
        const follow = {};
        for (const [w, kind] of Object.entries(a.follow || {})) {
            if (kind && !MASK_KINDS.includes(kind)) throw new Error(`follow takes one of ${MASK_KINDS.join(", ")}`);
            follow[this._asaScatter(scene, w).id] = kind;
        }
        const err = this.previzTerrainErodeApply({ layers: a.layers !== false, follow });
        if (err) throw new Error(err);
        await this._asaBuilt(item);
        return { ...out, applied: true };
    },

    // ── Scatters ──────────────────────────────────────────────────────────

    _asaScatterPatch(item, a) {
        const s = { ...(item.scatter || {}) };
        for (const [k, v] of Object.entries(a)) {
            const key = SCATTER_ALIASES[k] || k;
            if (SCATTER_FIELDS.includes(key) && v !== undefined) s[key] = v;
        }
        item.scatter = s;
    },

    _asaScatterOut(item) {
        const s = scatterSettings(item);
        const view = this._model3d;
        const entry = view && view._entries && view._entries.get(item.id);
        const mesh = entry && entry.object && entry.object.children && entry.object.children.find((c) => c.isInstancedMesh);
        return { scatter: item.name, id: item.id, type: s.source.type, on: s.target, count: s.count, scale: s.scale,
                 painted: !!s.paint, instances: mesh ? mesh.count : null };
    },

    async _asa_scatter_add(scene, a) {
        const type = a.type || "tree";
        if (!SCATTER_TYPES.includes(type)) throw new Error(`type is one of ${SCATTER_TYPES.join(", ")}`);
        const terrain = this._asaTerrain(scene, a.terrain);
        if (type === "model" && !a.path) throw new Error("a model scatter needs path: the model file");
        const prevSel = this._previzSelection;
        this._previzSelection = terrain.id;
        let item;
        if (type === "model") {
            // previzAddWorldItem asks the File Browser for the model; the agent names it instead.
            const keep = this._selectedBrowserFiles;
            const name = String(a.path).split(/[\\/]/).pop();
            this._selectedBrowserFiles = () => [{ kind: "model", path: String(a.path), name }];
            try { item = this.previzAddWorldItem("scatter", "model"); } finally { this._selectedBrowserFiles = keep; }
        } else {
            item = this.previzAddWorldItem("scatter", type);
        }
        if (!item) { this._previzSelection = prevSel; throw new Error(`could not add a ${type} scatter`); }
        if (a.name) item.name = S.uniqueName(scene, a.name, item.id);
        this._asaScatterPatch(item, a);
        this.previzChanged({ reload: true });
        await this._asaBuilt(terrain);
        return this._asaScatterOut(item);
    },

    async _asa_scatter_set(scene, a) {
        const item = this._asaScatter(scene, a.scatter);
        this.previzSnapshot(`set ${item.name}`);
        if (a.name) item.name = S.uniqueName(scene, a.name, item.id);
        this._asaScatterPatch(item, a);
        this.previzChanged({ reload: true });
        const t = S.itemById(scene, scatterSettings(item).target);
        if (t) await this._asaBuilt(t);
        return this._asaScatterOut(item);
    },

    /** Paint where a scatter grows (erase: take paint away); once painted it grows only on paint. */
    async _asa_scatter_paint(scene, a) {
        const item = this._asaScatter(scene, a.scatter);
        const terrain = S.itemById(scene, scatterSettings(item).target);
        if (!terrain || terrain.kind !== "terrain") throw new Error(`${item.name} grows on no terrain`);
        const win = this._viewerWindow ? this._viewerWindow() : window;
        let done = 0;
        for (const st of this._asaStrokes(a)) {
            const built = await this._asaBuilt(terrain);
            const grid = decodePaint(scatterSettings(item).paint, PAINT_RES);
            const radius = Math.max(0.1, Number(st.radius ?? a.radius ?? 10));
            const strength = Math.min(1, Math.max(0.01, Number(st.strength ?? a.strength ?? 0.8)));
            const hardness = Math.min(0.99, Math.max(0, Number(st.hardness ?? a.hardness ?? 0.3)));
            const erase = !!(st.erase ?? a.erase);
            const [ru, rv] = this._asaRadii(built, radius);
            for (const [u, v] of this._asaStrokeUV(built, st, ru, rv)) stampBrush(grid, u, v, ru, rv, { strength, hardness, erase });
            this.previzScatterPaintWrite(item.id, encodePaint(grid), false, true);
            done += 1;
            if (a.pause !== 0) await sleep(win, Math.max(0, Number(a.pause ?? 150)));
        }
        await this._asaBuilt(terrain);
        return { ...this._asaScatterOut(item), strokes: done };
    },
};
