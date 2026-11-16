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
import * as Ag from "./imageViewer_agentSceneData.js";
const modelSource = Ag.modelSource;
import { SCATTER_TYPES, scatterSettings, terrainSettings } from "./imageViewer_worldData.js";
import {
    SCULPT_TOOLS, decodeSculpt, encodeSculpt, sculptDab, sculptEmpty,
    decodeLayerPaint, encodeLayerPaint, layerDab, LAYER_RES,
} from "./imageViewer_terrainSculpt.js";
import { PAINT_RES, decodePaint, encodePaint, stampBrush } from "./imageViewer_scatterPaint.js";
import { ERODE_DEFAULTS, MASK_KINDS, cleanErode } from "./imageViewer_terrainErode.js";

export const TERRAIN_AGENT_ACTIONS = [
    "terrain_add", "terrain_set", "terrain_sculpt", "terrain_paint", "terrain_clear", "terrain_height",
    "terrain_erode", "scatter_add", "scatter_set", "scatter_paint", "ground",
];

const TERRAIN_FIELDS = ["seed", "roughness", "size", "height", "segments", "rules"];
const SCATTER_FIELDS = ["count", "seed", "scale", "layer", "maxSlope", "color", "wind", "grid", "aspect", "lift",
                        "emissive", "roughness", "clear"];
const SCATTER_ALIASES = { max_slope: "maxSlope" };

const sleep = (win, ms) => new Promise((r) => (win || window).setTimeout(r, ms));
const isNum = (v) => Number.isFinite(Number(v));

// A layer's fields, and the other names an agent gives them (a texture sent as `texture` and
// `scale` was dropped without a word, and the floor stayed a flat colour).
const LAYER_FIELDS = ["name", "src", "color", "tile", "normal", "rough", "roughness", "normalScale", "baked"];
const LAYER_ALIASES = {
    texture: "src", image: "src", map: "src", albedo: "src", diffuse: "src", file: "src", path: "src",
    scale: "tile", tiling: "tile", repeat: "tile", tile_size: "tile",
    normal_map: "normal", roughness_map: "rough", rough_map: "rough", normal_scale: "normalScale", colour: "color",
};

/**
 * The layers an agent gave, by place (0 ground, 1 rock, 2 cliff, 3 peak): a list in that order,
 * where an entry may name its layer instead (`layer` or `name` matching). Field names through
 * LAYER_ALIASES; any other key is refused, naming the ones there are.
 */
export function layersByPlace(given, names, fileSource = modelSource) {
    const out = [];
    given.forEach((g, i) => {
        if (!g || typeof g !== "object") return;
        const l = {};
        let at = i;
        for (const [k0, v] of Object.entries(g)) {
            if (k0 === "layer") {
                const j = typeof v === "number" ? v : names.indexOf(String(v).toLowerCase());
                if (!(j >= 0 && j < names.length)) throw new Error(`no terrain layer ${v}: the layers are ${names.join(", ")}`);
                at = j;
                continue;
            }
            const k = LAYER_ALIASES[k0] || k0;
            if (!LAYER_FIELDS.includes(k)) {
                throw new Error(`a terrain layer has no "${k0}": its fields are ${LAYER_FIELDS.join(", ")} (src = the texture file, tile = metres one repeat covers)`);
            }
            // A file given as a path string (what an agent sends) is the {path} / ComfyUI-file object the
            // terrain reads; a string was dropped as no file.
            if (["src", "normal", "rough"].includes(k) && typeof v === "string") {
                const f = v.trim() ? fileSource(v.trim()) : null;
                if (v.trim() && !f) throw new Error(`cannot read ${v}: give the texture's absolute path, or one inside ComfyUI's output or input folder`);
                l[k] = f;
                continue;
            }
            l[k] = v;
        }
        if (g.layer === undefined && typeof g.name === "string" && names.includes(g.name.toLowerCase()) && !given.some((o, j) => j !== i && o && o.layer !== undefined)) {
            at = names.indexOf(g.name.toLowerCase());
            delete l.name;
        }
        if (at >= names.length) throw new Error(`a terrain has ${names.length} layers (${names.join(", ")})`);
        // The shader multiplies a layer's texture by its colour: a texture given without one shows as it is.
        if (l.src && l.color === undefined) l.color = "#ffffff";
        // A texture taken away (src null / "") without a colour: the layer goes back to its own colour, not
        // the white a texture was given (promo run 2026-11-15: a grey previz asked for src null stayed white).
        if ("src" in l && !l.src && l.color === undefined) l.color = null;
        out[at] = { ...(out[at] || {}), ...l };
    });
    return out;
}

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
            const given = layersByPlace(a.layers, cur.map((l) => l.name));
            t.layers = cur.map((l, i) => {
                const m = { ...((item.terrain && item.terrain.layers && item.terrain.layers[i]) || {}), ...(given[i] || {}) };
                if (m.color === null) delete m.color;          // its default colour (terrainSettings)
                return m;
            });
        }
        item.terrain = t;
        for (const k of ["position", "rotation", "scale"]) if (Array.isArray(a[k]) && a[k].length === 3 && a[k].every(isNum)) item[k] = a[k].map(Number);
    },

    _asaTerrainOut(item) {
        const t = terrainSettings(item);
        return { terrain: item.name, id: item.id, size: t.size, height: t.height, seed: t.seed, roughness: t.roughness,
                 segments: t.segments, layers: t.layers.map((l) => l.name), sculpted: !!t.sculpt, layer_painted: !!t.layerPaint,
                 // What each layer shows now, so a change can be checked from the answer.
                 layer_looks: t.layers.map((l) => ({ name: l.name, texture: l.src ? (l.src.path || [l.src.type, l.src.subfolder, l.src.filename].filter(Boolean).join("/")) : null,
                                                     color: l.color, tile: l.tile })) };
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
     * Stand an item on the ground: its bottom on the terrain under it (the only terrain, or
     * `terrain`; with none, y = 0) and, with tilt (the default), turned to the slope - its long and
     * short sides along the ground under its four ends - then lifted until no point of its underside
     * (a 5 x 5 grid) is below the ground, so a car on a hill neither floats nor cuts into it. Static,
     * it is moved; animated, every position (and rotation) key is, and with `step` a key is put every
     * `step` frames first, so a drive follows the hills between its keys. A top-level item.
     */
    async _asa_ground(scene, a) {
        const it = this._asaItem(scene, a.item);
        const terrains = scene.items.filter((i) => i.kind === "terrain");
        const ter = a.terrain ? this._asaTerrain(scene, a.terrain) : terrains.length === 1 ? terrains[0] : null;
        if (!a.terrain && terrains.length > 1) throw new Error("name the terrain to stand it on (there is more than one)");
        if (it.parent) throw new Error(`${it.name} hangs under another item: ground the item at the top`);
        const built = ter ? await this._asaBuilt(ter) : null;
        if (!(await this._asaMeasure([it.id], [0]))) throw new Error(`${it.name} has nothing to measure (not loaded yet?)`);
        const groundAt = (x, z) => {
            if (!built) return 0;
            const y = built.view._terrainHeightAt(built.entry, x, z);
            if (y == null) throw new Error(`${it.name} is off ${ter.name} at x ${Math.round(x * 100) / 100}, z ${Math.round(z * 100) / 100}`);
            return y;
        };
        const { THREE } = this._modelView().libs;
        const tilt = a.tilt !== false;
        const lift = Number.isFinite(Number(a.clearance)) ? Number(a.clearance) : 0.01;
        // smooth: the tilt averaged over that many frames either side (bumps and steps in the ground
        // smaller than the window do not shake it); max_tilt: no more than that many degrees off level.
        const smooth = Math.max(0, Math.round(Number(a.smooth) || 0));
        const maxTilt = Number.isFinite(Number(a.max_tilt)) && Number(a.max_tilt) >= 0 ? Number(a.max_tilt) : null;
        const local = this._asaLocalBox(scene, it);
        if (!local) throw new Error(`${it.name} has nothing to measure (not loaded yet?)`);
        this.previzSnapshot(`ground ${it.name}`);
        const keyed = (S.baseTrack(it, "position") || []).length > 0;
        const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);
        const D = Math.PI / 180;
        const quatOf = (rot) => new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * D, rot[1] * D, rot[2] * D, "XYZ"));
        let frames;
        if (!keyed) frames = [Math.round(this.currentFrame || 0)];
        else {
            const step = Math.round(Number(a.step) || 0);
            const keys = S.baseTrack(it, "position");
            const set = new Set(keys.map((k) => k.f));
            if (tilt) for (const k of S.baseTrack(it, "rotation") || []) set.add(k.f);
            if (step > 0) for (let f = keys[0].f; f < keys[keys.length - 1].f; f += step) set.add(f);
            frames = [...set].sort((x, y) => x - y);
        }
        // Measured on the curves as they stand, then keyed: a key put first would move what is measured after it.
        const base = frames.map((f) => {
            const pos = S.currentValue(scene, it, "position", f), rot = S.currentValue(scene, it, "rotation", f);
            // Level first (only its heading kept, unless keep_turn): a second ground - after the terrain
            // changed - then starts from the car standing level, not from the lean the first one gave it.
            const q0 = tilt && !a.keep_turn ? this._asaHeadingOnly(quatOf(rot)) : quatOf(rot);
            const lv = tilt && !a.keep_turn ? this._asaNearEuler(q0, rot) : rot;
            return { f, pos, rot, q0, qt: tilt ? this._asaGroundTilt(it, pos, lv, local, groundAt) : new THREE.Quaternion() };
        });
        if (tilt && smooth > 0 && base.length > 1) {
            // Averaged by time, not by key: every frame of the window, the tilt there read off the nearest measured frames.
            const tiltAt = (f) => {
                let i = 0;
                while (i < base.length - 1 && base[i + 1].f <= f) i++;
                if (i >= base.length - 1 || f <= base[0].f) return base[f <= base[0].f ? 0 : base.length - 1].qt;
                const t = (f - base[i].f) / (base[i + 1].f - base[i].f);
                return base[i].qt.clone().slerp(base[i + 1].qt, t);
            };
            const sm = base.map((b) => {
                const acc = new THREE.Vector4();
                for (let d = -smooth; d <= smooth; d++) {
                    const q = tiltAt(b.f + d);
                    const sgn = q.w < 0 ? -1 : 1;
                    acc.x += q.x * sgn; acc.y += q.y * sgn; acc.z += q.z * sgn; acc.w += q.w * sgn;
                }
                return new THREE.Quaternion(acc.x, acc.y, acc.z, acc.w).normalize();
            });
            base.forEach((b, i) => { b.qt = sm[i]; });
        }
        if (maxTilt != null) for (const b of base) {
            const ang = 2 * Math.acos(Math.min(1, Math.abs(b.qt.w))) / D;
            if (ang > maxTilt && ang > 1e-6) b.qt = new THREE.Quaternion().slerp(b.qt, maxTilt / ang);
        }
        // Euler angles chosen frame by frame nearest the last ones: of the two XYZ triples of a turn, the
        // one that keeps the curves continuous, so a car heading near +-90 degrees does not spin between keys.
        let prev = null;
        const want = base.map((b) => {
            const q = b.qt.clone().multiply(b.q0);
            const y = this._asaGroundLift(it, b.pos, q, local, groundAt, lift);
            const rot = this._asaNearEuler(q, prev || b.rot);
            prev = rot;
            return { f: b.f, position: [b.pos[0], y, b.pos[2]], rotation: rot };
        });
        if (!keyed) {
            const r = want[0];
            it.position = round(r.position);
            if (tilt && !(S.baseTrack(it, "rotation") || []).length) it.rotation = round(r.rotation);
            else if (tilt) S.setKeyframe(it, "rotation", r.f, round(r.rotation));
        } else {
            const keys = S.baseTrack(it, "position").slice(), rkeys = (S.baseTrack(it, "rotation") || []).slice();
            for (const r of want) {
                const k = keys.find((x) => x.f === r.f);
                S.setKeyframe(it, "position", r.f, round(r.position), k ? k.ease : "linear");
                if (tilt) {
                    const rk = rkeys.find((x) => x.f === r.f);
                    S.setKeyframe(it, "rotation", r.f, round(r.rotation), rk ? rk.ease : "linear");
                }
            }
        }
        this.previzChanged();
        // Read back from the keys as they now play, every frame (between keys too): what the car really does.
        const f0 = frames[0], f1 = frames[frames.length - 1];
        let mostPitch = 0, mostRoll = 0, mostTilt = 0, mostDip = Infinity, worstAt = f0;
        const lean = (q) => {
            const xa = new THREE.Vector3(1, 0, 0).applyQuaternion(q), za = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
            const ya = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
            return { pitch: Math.asin(Math.max(-1, Math.min(1, za.y))) / D, roll: Math.asin(Math.max(-1, Math.min(1, xa.y))) / D,
                     tilt: Math.acos(Math.max(-1, Math.min(1, ya.y))) / D };
        };
        for (let f = f0; f <= f1; f++) {
            const pos = S.currentValue(scene, it, "position", f), rot = S.currentValue(scene, it, "rotation", f);
            const l = lean(quatOf(rot));
            mostPitch = Math.max(mostPitch, Math.abs(l.pitch)); mostRoll = Math.max(mostRoll, Math.abs(l.roll));
            if (l.tilt > mostTilt) { mostTilt = l.tilt; worstAt = f; }
            mostDip = Math.min(mostDip, this._asaGroundLift(it, pos, quatOf(rot), local, groundAt, 0, true));
        }
        const r1 = (v) => Math.round(v * 10) / 10;
        const out = { item: it.name, terrain: ter ? ter.name : null, keyed, tilt, smooth, max_tilt: maxTilt, frames: want.length,
                      first: { frame: want[0].f, y: Math.round(want[0].position[1] * 100) / 100 }, last: { frame: want[want.length - 1].f, y: Math.round(want[want.length - 1].position[1] * 100) / 100 },
                      most_pitch: r1(mostPitch), most_roll: r1(mostRoll), most_tilt: r1(mostTilt), most_tilt_at: worstAt,
                      lowest_clearance: Math.round(mostDip * 1000) / 1000 };
        if (mostTilt > 25) out.warning = `it leans ${r1(mostTilt)} degrees at frame ${worstAt}: the ground is rough there - smooth it, or ground again with smooth (e.g. 6) or max_tilt`;
        return out;
    },

    /**
     * The item's box in its own space (the frame's channels taken off the drawn meshes): what lies
     * under it, wherever it stands. Null before it has loaded.
     */
    _asaLocalBox(scene, it) {
        const view = this._modelView();
        const { THREE } = view.libs;
        const e = view._entries.get(it.id);
        if (!e || !e.root) return null;
        const f = view.sceneFrame || 0;
        view.applyFrame(f);
        e.root.updateMatrixWorld(true);
        const inv = this._asaItemMatrix(THREE, it, S.currentValue(scene, it, "position", f), S.currentValue(scene, it, "rotation", f)).invert();
        const box = new THREE.Box3(), b = new THREE.Box3(), m = new THREE.Matrix4();
        e.root.traverse((o) => {
            if (!o.isMesh || !o.geometry || o.visible === false) return;
            if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
            b.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
            box.union(b);
        });
        return box.isEmpty() ? null : box;
    },

    /** The item's own matrix for a position and rotation (degrees, XYZ), with its pivot and scale. */
    _asaItemMatrix(THREE, it, pos, rot, quat = null) {
        const pv = Array.isArray(it.pivot) ? it.pivot.map(Number) : [0, 0, 0];
        const sc = Array.isArray(it.scale) ? it.scale.map(Number) : [1, 1, 1];
        const q = quat || new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot.map((d) => (Number(d) || 0) * Math.PI / 180), "XYZ"));
        const m = new THREE.Matrix4().compose(new THREE.Vector3(pos[0] + pv[0], pos[1] + pv[1], pos[2] + pv[2]), q, new THREE.Vector3(...sc));
        return m.multiply(new THREE.Matrix4().makeTranslation(-pv[0], -pv[1], -pv[2]));
    },

    /** The turn that lays the item's ends onto the ground under them (identity where the ground gives none). */
    _asaGroundTilt(it, pos, rot, local, groundAt) {
        const { THREE } = this._modelView().libs;
        const D = Math.PI / 180;
        const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * D, rot[1] * D, rot[2] * D, "XYZ"));
        const M = this._asaItemMatrix(THREE, it, pos, rot, q0);
        const c = local.getCenter(new THREE.Vector3());
        const at = (x, z) => new THREE.Vector3(x, local.min.y, z).applyMatrix4(M);
        const ends = { xp: at(local.max.x, c.z), xm: at(local.min.x, c.z), zp: at(c.x, local.max.z), zm: at(c.x, local.min.z) };
        const flat = (v) => new THREE.Vector3(v.x, 0, v.z);
        const onGround = (v) => new THREE.Vector3(v.x, groundAt(v.x, v.z), v.z);
        const ax = onGround(ends.xp).sub(onGround(ends.xm)), az = onGround(ends.zp).sub(onGround(ends.zm));
        const fx = flat(ends.xp).sub(flat(ends.xm)), fz = flat(ends.zp).sub(flat(ends.zm));
        if (!(ax.lengthSq() > 1e-8 && az.lengthSq() > 1e-8 && fx.lengthSq() > 1e-8 && fz.lengthSq() > 1e-8)) return new THREE.Quaternion();
        // The basis the ground gives (x along the item's x ends, up square to both) against the flat one.
        const basis = (x, z) => {
            x = x.clone().normalize();
            const y = new THREE.Vector3().crossVectors(z, x).normalize();
            const zz = new THREE.Vector3().crossVectors(x, y);
            return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, zz));
        };
        return basis(ax, az).multiply(basis(fx, fz).invert());
    },

    /**
     * The height that puts the item's whole underside (a 5 x 5 grid) `lift` above the ground, turned
     * by q; with `clearance` true the lowest clearance itself (negative = in the ground).
     */
    _asaGroundLift(it, pos, q, local, groundAt, lift, clearance = false) {
        const { THREE } = this._modelView().libs;
        const M = this._asaItemMatrix(THREE, it, pos, null, q);
        let worst = Infinity;
        for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
            const p = new THREE.Vector3(local.min.x + (local.max.x - local.min.x) * i / 4, local.min.y,
                                        local.min.z + (local.max.z - local.min.z) * j / 4).applyMatrix4(M);
            worst = Math.min(worst, p.y - groundAt(p.x, p.z));
        }
        return clearance ? worst : pos[1] - worst + lift;
    },

    /** q with only its turn about Y left: the way its nose (+Z, else +X) points, level. */
    _asaHeadingOnly(q) {
        const { THREE } = this._modelView().libs;
        const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        let yaw;
        if (Math.hypot(z.x, z.z) > 1e-3) yaw = Math.atan2(z.x, z.z);
        else { const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q); yaw = Math.atan2(-x.z, x.x); }
        return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    },

    /** XYZ Euler degrees of q nearest `ref`: both triples of the turn, each wrapped to it, the closer one. */
    _asaNearEuler(q, ref) {
        const { THREE } = this._modelView().libs;
        const D = Math.PI / 180;
        const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
        const a = [e.x / D, e.y / D, e.z / D], b = [a[0] + 180, 180 - a[1], a[2] + 180];
        const near = (v, old) => v + 360 * Math.round((old - v) / 360);
        const wa = a.map((v, i) => near(v, ref[i])), wb = b.map((v, i) => near(v, ref[i]));
        const dist = (w) => w.reduce((s, v, i) => s + Math.abs(v - ref[i]), 0);
        return dist(wb) < dist(wa) ? wb : wa;
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
