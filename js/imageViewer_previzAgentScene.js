// imageViewer_previzAgentScene.js
// The agent's hands on the 3D scene beyond one character's rig: the Clip
// Sequencer, cameras and turntables, renders and playblasts of the scene on
// screen, keys on any channel, animation-layer and display-layer settings,
// IK/FK, spaces, set-driven keys, custom attributes, a model brought in, and a
// USD stage of the shot. agentY-core's animate_scene sends them through the
// viewer's POST /imageviewer/rig/agent (rig_routes.AGENT_ACTIONS), the same road
// as animate_character; previzRigAgentRun hands every action named in
// SCENE_AGENT_ACTIONS to previzSceneAgent here.
//
// Each change is one undo step of the 3D scene, as the same edit by hand is.
// Items are named by id or by name (case ignored).
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import * as Q from "./imageViewer_clipSeqData.js";
import * as L from "./imageViewer_sceneLayers.js";
import * as A from "./imageViewer_agentSceneData.js";
import { bakedCopy } from "./imageViewer_constraints.js";
import { canvasContext } from "./imageViewer_exportUI.js";

/** Every action this mixin answers (none needs a character). */
export const SCENE_AGENT_ACTIONS = new Set([
    "scene_info", "scene_set", "add_model", "add_camera", "set_camera", "turntable", "render", "playblast",
    "key_set", "key_delete", "key_list",
    "layer_set", "layer_remove", "layer_merge_down",
    "display_layer_add", "display_layer_set", "display_layer_list",
    "clip_list", "clip_from_keys", "clip_place", "clip_set", "clip_split", "clip_remove", "clip_match", "clip_bake",
    "clip_track_add", "clip_track_set",
    "ikfk_switch", "ikfk_match", "space_set", "attr_add", "sdk_key", "sdk_remove",
    "export_usd",
]);

const CLIP_FIELDS = { start: "start", length: "length", in: "in", out: "out", speed: "speed", loop: "loop", weight: "weight",
                      blend_in: "blendIn", blend_out: "blendOut", pre: "pre", post: "post", mute: "mute", name: "name",
                      accumulate: "accumulate", color: "color" };
const TRACK_FIELDS = ["name", "mute", "solo", "lock", "weight", "mode"];

export const PrevizAgentSceneMixin = {

    /** Answers the result, or throws with what went wrong (previzRigAgentRun reports it). */
    async previzSceneAgent(action, a = {}) {
        const scene = this.previzScene();
        if (!scene) throw new Error("no 3D scene is up");
        const fn = this[`_asa_${action}`];
        if (typeof fn !== "function") throw new Error(`unknown action ${action}`);
        return fn.call(this, scene, a || {});
    },

    // ── Finding things ────────────────────────────────────────────────────

    _asaItem(scene, w, what = "item", { need = true } = {}) {
        if (w === undefined || w === null || w === "") {
            if (need) throw new Error(`name the ${what}`);
            return null;
        }
        const s = String(w).toLowerCase();
        const it = scene.items.find((i) => i.id === w) || scene.items.find((i) => String(i.name || "").toLowerCase() === s);
        if (!it) throw new Error(`no ${what} named ${w} in the 3D scene`);
        return it;
    },

    _asaModel(scene, w) {
        if (w) return this._asaItem(scene, w, "model");
        const models = scene.items.filter((i) => i.kind === "model");
        if (models.length === 1) return models[0];
        const sel = this.previzRigModelOf && this.previzRigModelOf();
        const m = sel && S.itemById(scene, sel);
        if (m) return m;
        throw new Error(models.length ? "name the model (there is more than one)" : "the scene has no model");
    },

    _asaSeq(make = false) {
        const scene = this.previzScene();
        if (make) return Q.ensureSeq(scene);
        const q = Q.seqOf(scene);
        return q ? Q.normalizeSeq(q) : null;
    },

    _asaClip(q, w) {
        if (!q) throw new Error("the scene has no clips");
        const at = Q.findClip(q, w);
        if (at) return at;
        const s = String(w || "").toLowerCase();
        for (const t of q.tracks) for (const c of t.clips) {
            if (String(Q.clipLabel(q, c)).toLowerCase() === s) return { clip: c, track: t };
        }
        throw new Error(w ? `no clip named ${w}` : "name the clip");
    },

    _asaTrack(q, w) {
        const t = Q.trackById(q, w) || q.tracks.find((x) => String(x.name).toLowerCase() === String(w || "").toLowerCase());
        if (!t) throw new Error(w ? `no clip track named ${w}` : "name the track");
        return t;
    },

    _asaSource(q, w) {
        const s = Q.sourceById(q, w) || q.sources.find((x) => String(x.name).toLowerCase() === String(w || "").toLowerCase());
        if (!s) throw new Error(w ? `no clip source named ${w}` : "name the source");
        return s;
    },

    _asaAnimLayer(scene, w) {
        const list = scene.animLayers || [];
        const s = String(w || "").toLowerCase();
        const l = list.find((x) => x.id === w) || list.find((x) => String(x.name).toLowerCase() === s);
        if (!l) throw new Error(w ? `no animation layer named ${w}` : "name the layer");
        return l;
    },

    _asaDisplayLayer(scene, w) {
        const list = L.displayLayers(scene);
        const s = String(w || "").toLowerCase();
        const l = list.find((x) => x.id === w) || list.find((x) => String(x.name).toLowerCase() === s);
        if (!l) throw new Error(w ? `no display layer named ${w}` : "name the display layer");
        return l;
    },

    _asaIds(scene, list) { return (Array.isArray(list) ? list : list ? [list] : []).map((w) => this._asaItem(scene, w).id); },

    _asaEnd(scene) { return Math.max(0, (scene.length || 1) - 1); },

    /** A clip-sequencer edit as one undo step (the panel's own _csEdit when it is there). */
    _asaClipEdit(label, fn) {
        let out = null, err = null;
        const r = this._csEdit(label, (q) => {
            try { out = fn(q); } catch (e) { err = e; return null; }
            if (out && out.error) return out;
            return out || null;
        }, { quiet: true });
        if (err) throw err;
        if (r && r.error) throw new Error(r.error);
        return out;
    },

    // ── The scene ─────────────────────────────────────────────────────────

    _asa_scene_info(scene) {
        return { scene: A.describeScene(scene), frame: Math.round(this.currentFrame || 0) };
    },

    _asa_scene_set(scene, a) {
        this.previzSnapshot("shot settings");
        if (a.length !== undefined) { scene.length = Math.max(1, Math.round(Number(a.length) || 1)); scene.lengthSet = true; }
        if (a.fps !== undefined && Number(a.fps) > 0) scene.fps = Number(a.fps);
        this.previzChanged();
        if (this.applyTimelineBounds) this.applyTimelineBounds();
        if (this.previzSyncTimelineFields) this.previzSyncTimelineFields();
        if (a.frame !== undefined) this.setFrame(Math.round(Number(a.frame) || 0));
        return { length: scene.length, fps: scene.fps };
    },

    async _asa_add_model(scene, a) {
        const path = String(a.path || "").trim();
        if (!path) throw new Error("add_model needs path: the model file (.glb, .fbx, .obj, .usd, .abc, ...)");
        const before = new Set(scene.items.map((i) => i.id));
        const n = await this.previzAddModels([{ path, name: a.name || path.split(/[\\/]/).pop() }]);
        if (!n) throw new Error(`could not add ${path}`);
        const item = scene.items.find((i) => !before.has(i.id) && i.kind === "model");
        if (item && a.name) item.name = S.uniqueName(scene, a.name, item.id);
        if (item && (a.position || a.rotation || a.scale)) {
            for (const k of ["position", "rotation", "scale"]) if (Array.isArray(a[k]) && a[k].length === 3) item[k] = a[k].map(Number);
            this.previzChanged();
        }
        try { if (this._modelView().whenLoaded) await this._modelView().whenLoaded(30000); } catch (_) { /* answered without */ }
        return { model: item ? item.name : null, id: item ? item.id : null };
    },

    // ── Cameras ───────────────────────────────────────────────────────────

    /** Rotation (degrees, XYZ) for a camera at `p` looking at `t` (Y up; a camera looks down -Z). */
    _asaLookAt(p, t) {
        const d = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
        const yaw = Math.atan2(-d[0], -d[2]);
        const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
        // Euler XYZ for R = Ry(yaw) Rx(pitch): solved from that matrix.
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
        // m = Ry * Rx, read back as three's XYZ Euler (m13 = sin y; x = atan2(-m23, m33); z = atan2(-m12, m11)).
        const m11 = cy, m12 = sy * sp, m13 = sy * cp, m23 = -sp, m33 = cy * cp;
        const b = Math.asin(Math.max(-1, Math.min(1, m13)));
        let ax, cz;
        if (Math.abs(m13) < 0.9999999) { ax = Math.atan2(-m23, m33); cz = Math.atan2(-m12, m11); } else { ax = Math.atan2(sp, cp); cz = 0; }
        const D = 180 / Math.PI;
        return [ax * D, b * D, cz * D];
    },

    _asa_add_camera(scene, a) {
        this.previzSnapshot("add camera");
        const view = this._modelView();
        const at = view.viewTransform();
        const position = Array.isArray(a.position) ? a.position.map(Number) : at.position;
        const rotation = Array.isArray(a.look_at) ? this._asaLookAt(position, a.look_at.map(Number))
            : Array.isArray(a.rotation) ? a.rotation.map(Number) : at.rotation;
        const patch = { position, rotation, fov: Number(a.fov) > 0 ? Number(a.fov) : at.fov };
        if (Array.isArray(a.resolution) && a.resolution.length === 2) patch.resolution = a.resolution.map((v) => Math.max(16, Math.round(Number(v))));
        const item = S.makeCameraItem(S.uniqueName(scene, a.name || "Camera"), patch);
        if (a.parent) item.parent = this._asaItem(scene, a.parent, "parent").id;
        scene.items.push(item);
        if (a.active !== false) scene.activeCamera = item.id;
        this.previzChanged({ reload: true });
        return { camera: item.name, id: item.id };
    },

    _asa_set_camera(scene, a) {
        const cam = this._asaItem(scene, a.camera || a.item, "camera");
        if (cam.kind !== "camera") throw new Error(`${cam.name} is not a camera`);
        this.previzSnapshot(`camera ${cam.name}`);
        if (Number(a.fov) > 0) S.setStaticValue(cam, "fov", Number(a.fov));
        if (Array.isArray(a.resolution) && a.resolution.length === 2) cam.resolution = a.resolution.map((v) => Math.max(16, Math.round(Number(v))));
        if (a.active !== false) scene.activeCamera = cam.id;
        this.previzChanged({ reload: true });
        return { camera: cam.name, active: scene.activeCamera === cam.id };
    },

    /** The subject's box over frames (meshes and, for a character, its bones - which carry the animation). */
    _asaSubjectBox(ids, frames) {
        const view = this._modelView();
        const { THREE } = view.libs;
        const boxes = [];
        const v = new THREE.Vector3();
        const was = view.sceneFrame || 0;
        try {
            for (const f of frames) {
                view.applyFrame(f);
                const box = new THREE.Box3();
                for (const id of ids) {
                    const e = view._entries.get(id);
                    if (!e || !e.root) continue;
                    e.root.updateMatrixWorld(true);
                    box.expandByObject(e.root);
                    if (e.bones) for (const b of e.bones.values()) box.expandByPoint(b.getWorldPosition(v));
                }
                if (!box.isEmpty()) boxes.push({ min: box.min.toArray(), max: box.max.toArray() });
            }
        } finally { view.applyFrame(was); }
        return A.sphereOf(boxes);
    },

    /**
     * A turntable camera: one pivot + camera rig ("Turntable" / "Turntable cam"),
     * keyed with a full turn over each range - every clip of the sequencer
     * (`clips`: "all" or names), or from..to. Answers the camera and the ranges.
     */
    async _asa_turntable(scene, a) {
        const subjectIds = a.target ? this._asaIds(scene, a.target)
            : scene.items.filter((i) => i.kind === "model").map((i) => i.id);
        if (!subjectIds.length) throw new Error("name the target: the scene has no model to turn around");
        let ranges = [];
        if (a.clips !== undefined && a.clips !== null && a.clips !== false) {
            const q = this._asaSeq(false);
            if (!q) throw new Error("the scene has no clips: make some with clip_from_keys, or give from / to");
            const r = A.pickClips(q, a.clips === true ? "all" : a.clips);
            if (r.missing.length) throw new Error(`no clip named ${r.missing.join(", ")}`);
            ranges = r.clips.map((c) => ({ from: c.from, to: c.to, clip: c.name }));
            if (!ranges.length) throw new Error("no clip to make a turntable for (all muted?)");
        } else {
            const from = a.from == null ? 0 : Math.round(Number(a.from));
            const to = a.to == null ? this._asaEnd(scene) : Math.round(Number(a.to));
            if (!(to >= from)) throw new Error("to must not come before from");
            ranges = [{ from, to, clip: null }];
        }
        const name = String(a.name || "Turntable").trim() || "Turntable";
        const camName = `${name} cam`;
        this.previzSnapshot(`turntable ${name}`);
        let pivot = scene.items.find((i) => i.name === name && i.kind === "group" && i.turntable);
        if (!pivot) {
            pivot = S.makeGroupItem(S.uniqueName(scene, name));
            pivot.turntable = true;
            scene.items.push(pivot);
        }
        let cam = scene.items.find((i) => i.kind === "camera" && i.parent === pivot.id);
        if (!cam) {
            cam = S.makeCameraItem(S.uniqueName(scene, camName), { position: [0, 0, 5], rotation: [0, 0, 0] });
            cam.parent = pivot.id;
            scene.items.push(cam);
        }
        if (Number(a.fov) > 0) cam.fov = Number(a.fov);
        if (Array.isArray(a.resolution) && a.resolution.length === 2) cam.resolution = a.resolution.map((v) => Math.max(16, Math.round(Number(v))));
        const [rw, rh] = S.cameraResolution(cam);
        const out = [];
        const keyBase = (fn) => (this.previzWithLayer ? this.previzWithLayer(null, fn) : fn());
        for (const rg of ranges) {
            const sub = this._asaSubjectBox(subjectIds, A.sampleFrames(rg.from, rg.to, 9));
            if (!sub) throw new Error("the target has nothing to measure (not loaded yet?)");
            const k = A.turntableRange(sub, rg.from, rg.to, { degrees: a.degrees, start_yaw: a.start_yaw, distance: a.distance,
                height: a.height, look_height: a.look_height, fov: S.staticValue(cam, "fov") || cam.fov || 35, aspect: rw / rh });
            keyBase(() => {
                for (const [it, set] of [[pivot, k.pivot], [cam, k.cam]]) {
                    for (const [prop, keys] of Object.entries(set)) {
                        // Off this range the keys of the others stand; on it, this range's.
                        const list = (S.baseTrack(it, prop) || []).filter((x) => x.f < rg.from || x.f > rg.to);
                        S.setTrack(it, prop, A.mergeKeys(list, keys));
                    }
                }
            });
            out.push({ clip: rg.clip, from: rg.from, to: rg.to, distance: k.distance, height: k.height, center: k.center });
        }
        if (a.active !== false) scene.activeCamera = cam.id;
        await this.previzChanged({ reload: true });
        return { camera: cam.name, camera_id: cam.id, pivot: pivot.name, ranges: out };
    },

    // ── Render and playblast ──────────────────────────────────────────────

    _asaRange(scene, a) {
        if (a.clip) {
            const q = this._asaSeq(false);
            const r = A.pickClips(q, [a.clip]);
            if (r.missing.length) throw new Error(`no clip named ${a.clip}`);
            return { start: r.clips[0].from, end: r.clips[0].to };
        }
        const start = a.from == null ? 0 : Math.max(0, Math.round(Number(a.from)));
        const end = a.to == null ? this._asaEnd(scene) : Math.round(Number(a.to));
        if (end < start) throw new Error("to must not come before from");
        return { start, end };
    },

    _asaCameraId(scene, w) {
        if (w === "" || w === "view") return "";
        if (!w) return null;
        const cam = this._asaItem(scene, w, "camera");
        if (cam.kind !== "camera") throw new Error(`${cam.name} is not a camera`);
        return cam.id;
    },

    _asaRenderResult(r) {
        if (!r) throw new Error("a render is already running in the viewer");
        if (!r.ok) throw new Error(r.message || "the render did not finish");
        return { path: (r.landed && r.landed[0]) || null, paths: r.landed || [], where: r.where || null, frames: r.frames, message: r.message };
    },

    async _asa_render(scene, a) {
        const { start, end } = this._asaRange(scene, a);
        const st = { start, end };
        const cam = this._asaCameraId(scene, a.camera);
        if (cam !== null) st.camera = cam;
        if (a.name) st.name = String(a.name);
        if (Number(a.width) > 0 && Number(a.height) > 0) { st.width = Math.round(a.width); st.height = Math.round(a.height); st.useCameraRes = false; }
        for (const k of ["format", "shading", "background", "color", "quality", "codec"]) if (a[k]) st[k] = a[k];
        for (const k of ["scale", "aa", "fps"]) if (Number(a[k]) > 0) st[k] = Number(a[k]);
        // The second renderer (imageViewer_view3dPathTrace.js): "raster" or "pathtraced".
        if (a.renderer === "raster" || a.renderer === "pathtraced") st.renderer = a.renderer;
        for (const k of ["samples", "bounces"]) if (Number(a[k]) > 0) st[k] = Math.round(Number(a[k]));
        if (a.add_node !== undefined) st.addNode = !!a.add_node;
        if (a.grid !== undefined) st.grid = !!a.grid;
        return this._asaRenderResult(await this.previzRender(st, { label: "Shot rendered" }));
    },

    async _asa_playblast(scene, a) {
        const { start, end } = this._asaRange(scene, a);
        const opts = { start, end };
        const cam = this._asaCameraId(scene, a.camera);
        if (cam !== null) opts.camera = cam;
        for (const k of ["format", "shading", "note"]) if (a[k]) opts[k] = a[k];
        if (Number(a.scale) > 0) opts.scale = Number(a.scale);
        if (a.hud !== undefined) opts.hud = !!a.hud;
        return this._asaRenderResult(await this.previzPlayblast(opts));
    },

    // ── Keys ──────────────────────────────────────────────────────────────

    _asaProp(it, prop) {
        const p = String(prop || "");
        if (!(S.TRACKS.includes(p) || S.isExtraProp(p))) {
            throw new Error(`prop is one of ${S.TRACKS.join(", ")}, or attr:<name> / bs:<shape> (got ${prop})`);
        }
        return p;
    },

    _asaOnLayer(scene, layer, fn) {
        if (layer === undefined) return fn();
        const id = layer === null || layer === "" || layer === "base" ? null : this._asaAnimLayer(scene, layer).id;
        return this.previzWithLayer ? this.previzWithLayer(id, fn) : fn();
    },

    _asa_key_set(scene, a) {
        const it = this._asaItem(scene, a.item);
        const keys = Array.isArray(a.keys) ? a.keys : [{ frame: a.frame, value: a.value, ease: a.ease }];
        const prop = this._asaProp(it, a.prop);
        this.previzSnapshot(`key ${it.name}.${prop}`);
        let n = 0;
        this._asaOnLayer(scene, a.layer, () => {
            for (const k of keys) {
                const f = k.frame === undefined || k.frame === null ? Math.round(this.currentFrame || 0) : Math.round(Number(k.frame));
                let v = k.value;
                if (v === undefined || v === null) v = S.currentValue(scene, it, prop, f);
                if (Array.isArray(v)) v = v.map(Number);
                else v = Number(v);
                if (Array.isArray(v) ? v.some((x) => !Number.isFinite(x)) : !Number.isFinite(v)) throw new Error(`a key on frame ${f} has no number`);
                const ease = ["smooth", "linear", "hold"].includes(k.ease) ? k.ease : undefined;
                // A vector channel keyed with one axis: that axis only, the others as they stand.
                if (k.axis !== undefined && k.axis !== null && !Array.isArray(v)) {
                    const cur = S.currentValue(scene, it, prop, f);
                    if (!Array.isArray(cur)) throw new Error(`${prop} has no axes`);
                    const ax = typeof k.axis === "number" ? k.axis : "xyz".indexOf(String(k.axis).toLowerCase());
                    if (!(ax >= 0 && ax < 3)) throw new Error("axis is 0..2 or x / y / z");
                    v = cur.slice(); v[ax] = Number(k.value);
                }
                if (a.solve === false) S.setKeyframe(it, prop, f, v, ease);
                else S.keyPose(scene, it, prop, f, v, ease);
                n++;
            }
        });
        this.previzChanged();
        return { item: it.name, prop, keys: n };
    },

    _asa_key_delete(scene, a) {
        const it = this._asaItem(scene, a.item);
        const frames = Array.isArray(a.frames) ? a.frames : a.frame !== undefined ? [a.frame] : null;
        const prop = a.prop ? this._asaProp(it, a.prop) : undefined;
        this.previzSnapshot(`delete keys ${it.name}`);
        let n = 0;
        this._asaOnLayer(scene, a.layer, () => {
            const fs = frames || S.allKeyframeFrames(it);
            for (const f of fs) {
                const before = JSON.stringify([it.tracks, it.layerTracks]);
                S.removeKeyframe(it, Math.round(Number(f)), prop);
                if (JSON.stringify([it.tracks, it.layerTracks]) !== before) n++;
            }
        });
        this.previzChanged();
        return { item: it.name, frames_cleared: n };
    },

    _asa_key_list(scene, a) {
        const it = this._asaItem(scene, a.item);
        const tracks = {};
        for (const [prop, keys] of Object.entries(it.tracks || {})) {
            if (!Array.isArray(keys) || !keys.length) continue;
            tracks[prop] = keys.slice(0, 200).map((k) => ({ frame: k.f, value: k.v, ease: k.ease || "smooth" }));
        }
        const layers = {};
        for (const [lid, lt] of Object.entries(it.layerTracks || {})) {
            const l = (scene.animLayers || []).find((x) => x.id === lid);
            const t = {};
            for (const [prop, keys] of Object.entries(lt || {})) if (Array.isArray(keys) && keys.length) t[prop] = keys.slice(0, 200).map((k) => ({ frame: k.f, value: k.v, ease: k.ease || "smooth" }));
            if (Object.keys(t).length) layers[l ? l.name : lid] = t;
        }
        const f = a.frame === undefined ? Math.round(this.currentFrame || 0) : Math.round(Number(a.frame));
        const now = {};
        for (const p of S.TRACKS) { const v = S.currentValue(scene, it, p, f); if (v !== undefined && v !== null) now[p] = v; }
        return { item: it.name, kind: it.kind, tracks, layers, frame: f, values: now };
    },

    // ── Animation layers ──────────────────────────────────────────────────

    _asa_layer_set(scene, a) {
        const l = this._asaAnimLayer(scene, a.layer);
        const patch = {};
        for (const k of ["mute", "solo", "lock"]) if (a[k] !== undefined) patch[k] = !!a[k];
        if (a.mode === "additive" || a.mode === "override") patch.mode = a.mode;
        if (a.name) patch.name = String(a.name);
        if (Object.keys(patch).length) this.previzLayerSet(l.id, patch, { label: `layer ${l.name}` });
        if (a.weight !== undefined) {
            const w = Math.max(0, Math.min(1, Number(a.weight)));
            if (a.frame !== undefined) {
                const was = this.currentFrame;
                this.setFrame(Math.round(Number(a.frame)));
                this.previzLayerWeight(l.id, w);
                if (a.key) { const has = (l.tracks && (l.tracks.weight || []).some((k) => k.f === Math.round(Number(a.frame)))); if (!has) this.previzLayerKeyWeight(l.id); }
                this.setFrame(was);
            } else this.previzLayerWeight(l.id, w);
        }
        if (a.active !== undefined) this.previzLayerSetActive(a.active ? l.id : null);
        return { layer: l.name, mode: l.mode, weight: l.weight, mute: !!l.mute, solo: !!l.solo, lock: !!l.lock,
                 active: (scene.activeLayer || null) === l.id };
    },

    _asa_layer_remove(scene, a) {
        const l = this._asaAnimLayer(scene, a.layer);
        this.previzLayerRemove(l.id);
        return { removed: l.name };
    },

    _asa_layer_merge_down(scene, a) {
        const l = this._asaAnimLayer(scene, a.layer);
        this.previzLayerMergeDown(l.id);
        return { merged: l.name, layers: (scene.animLayers || []).map((x) => x.name) };
    },

    // ── Display layers ────────────────────────────────────────────────────

    _asa_display_layer_add(scene, a) {
        const ids = this._asaIds(scene, a.items);
        const l = this.previzNewDisplayLayer(ids, a.name || null);
        if (!l) throw new Error("the display layer was not made");
        if (a.visible !== undefined || a.mode || a.color) this.previzSetLayer(l.id, { ...(a.visible !== undefined ? { visible: !!a.visible } : {}),
            ...(a.mode ? { mode: a.mode } : {}), ...(a.color ? { color: a.color } : {}) });
        return { layer: l.name, id: l.id, members: l.members.length };
    },

    _asa_display_layer_set(scene, a) {
        const l = this._asaDisplayLayer(scene, a.layer);
        if (a.add) this.previzAddToLayer(l.id, this._asaIds(scene, a.add));
        if (a.remove) this.previzRemoveFromLayers(this._asaIds(scene, a.remove).filter((id) => l.members.includes(id)));
        const patch = {};
        if (a.visible !== undefined) patch.visible = !!a.visible;
        if (a.mode) { if (!L.LAYER_MODES.includes(a.mode)) throw new Error(`mode is ${L.LAYER_MODES.join(", ")}`); patch.mode = a.mode; }
        if (a.color !== undefined) patch.color = a.color;
        if (a.name) patch.name = a.name;
        if (Object.keys(patch).length) this.previzSetLayer(l.id, patch);
        if (a.delete) { this.previzDeleteLayer(l.id); return { deleted: l.name }; }
        return { layer: l.name, visible: l.visible !== false, mode: l.mode, members: l.members.length };
    },

    _asa_display_layer_list(scene) {
        return { layers: L.displayLayers(scene).map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false, mode: l.mode || "normal",
            color: l.color || null, members: l.members.map((id) => (S.itemById(scene, id) || {}).name || id) })) };
    },

    // ── The Clip Sequencer ────────────────────────────────────────────────

    _asa_clip_list() {
        const q = this._asaSeq(false);
        const d = A.describeScene(this.previzScene());
        return { clips: (d && d.clips) || { sources: [], tracks: [] }, turntable_ranges: q ? A.pickClips(q).clips : [] };
    },

    /**
     * Keys into a clip: a character's controls (`model`) or `items`, over
     * from..to (default: the keys' own range), placed where the keys were (or
     * at `at`, on `track`). keep_keys leaves the keys on the items as well (the
     * clip then plays over them); place false makes the source only.
     */
    _asa_clip_from_keys(scene, a) {
        let ids, model = null, base;
        if (a.items) {
            ids = this._asaIds(scene, a.items);
            base = (S.itemById(scene, ids[0]) || {}).name || "clip";
        } else {
            const m = this._asaModel(scene, a.model);
            if (!R.isRigged(scene, m.id)) throw new Error(`${m.name} has no controls: rig it first (animate_character rig)`);
            ids = R.controlsOf(scene, m.id).map((c) => c.id);
            model = m.id;
            base = m.name;
        }
        let frames = [];
        for (const id of ids) frames.push(...S.keyframeFrames(S.itemById(scene, id)));
        frames = frames.sort((x, y) => x - y);
        if (!frames.length) throw new Error("nothing keyed to make a clip of");
        const lo = a.from == null ? frames[0] : Math.round(Number(a.from));
        const hi = a.to == null ? frames[frames.length - 1] : Math.round(Number(a.to));
        if (!(hi > lo)) throw new Error("a clip needs keys on at least two frames");
        const remove = a.keep_keys !== true;
        let made = null, src = null;
        this._asaClipEdit("clip from keys", (q) => {
            const n = q.sources.filter((s) => s.name.startsWith(base)).length + 1;
            src = Q.addSource(q, Q.captureSource(scene, ids, lo, hi, { name: a.name || `${base} ${n}`, model, keepAll: !!model, remove }));
            src.keep = true;
            if (a.place === false) return src;
            const track = a.track ? this._asaTrack(q, a.track) : Q.trackWithRoom(q, lo, hi);
            made = Q.addClip(q, track.id, src.id, a.at == null ? lo : Math.round(Number(a.at)));
            if (!made) return { error: "the track has no room there" };
            return made;
        });
        if (this.isPanelDocked && !this.isPanelDocked("clips")) this.setPanelDocked("clips", true);
        return { source: src && src.name, clip: made ? made.id : null, name: made ? (made.name || src.name) : null,
                 ...(made ? A.clipFrames(made) : {}), keys_moved: remove };
    },

    _asa_clip_place(scene, a) {
        const q0 = this._asaSeq(false);
        if (!q0) throw new Error("the scene has no clip sources yet (clip_from_keys, or motion with as_clip)");
        const src = this._asaSource(q0, a.source);
        const at = a.at == null ? Math.round(this.currentFrame || 0) : Math.round(Number(a.at));
        const c = this._asaClipEdit("add clip", (q) => {
            const s = Q.sourceById(q, src.id);
            const track = a.track ? this._asaTrack(q, a.track) : Q.trackWithRoom(q, at, at + s.length);
            const made = Q.addClip(q, track.id, s.id, at);
            if (!made) return { error: "the track has no room there" };
            const patch = this._asaClipPatch(scene, a);
            if (Object.keys(patch).length) Q.setClip(q, made.id, patch);
            return made;
        });
        return { clip: c.id, name: Q.clipLabel(this._asaSeq(false), c), ...A.clipFrames(c) };
    },

    _asaClipPatch(scene, a) {
        const patch = {};
        for (const [k, f] of Object.entries(CLIP_FIELDS)) {
            if (k === "name") { if (a.clip_name) patch.name = String(a.clip_name); continue; }
            if (a[k] !== undefined) patch[f] = a[k];
        }
        if (a.target) patch.target = this._asaModel(scene, a.target).id;
        if (patch.loop !== undefined && !Q.LOOPS.includes(patch.loop)) throw new Error(`loop is "", cycle or pingpong`);
        return patch;
    },

    _asa_clip_set(scene, a) {
        const q0 = this._asaSeq(false);
        const at = this._asaClip(q0, a.clip);
        const patch = this._asaClipPatch(scene, { ...a, clip_name: a.name });
        const id = at.clip.id;
        const c = this._asaClipEdit("clip", (q) => {
            if (a.track) {
                const t = this._asaTrack(q, a.track);
                Q.moveClip(q, id, patch.start ?? at.clip.start, t.id);
            }
            return Q.setClip(q, id, patch) || Q.findClip(q, id).clip;
        });
        const now = Q.findClip(this._asaSeq(false), id);
        return { clip: id, name: Q.clipLabel(this._asaSeq(false), now.clip), track: now.track.name, ...A.clipFrames(now.clip),
                 speed: now.clip.speed, loop: now.clip.loop || "", weight: now.clip.weight, changed: !!c };
    },

    _asa_clip_split(scene, a) {
        const q0 = this._asaSeq(false);
        const at = this._asaClip(q0, a.clip);
        const f = a.at == null ? Math.round(this.currentFrame || 0) : Math.round(Number(a.at));
        const r = this._asaClipEdit("split clip", (q) => Q.splitClip(q, at.clip.id, f) || { error: "it cannot be split there (inside the clip, not looping)" });
        return { a: r.a && r.a.id, b: r.b && r.b.id, at: f };
    },

    _asa_clip_remove(scene, a) {
        const q0 = this._asaSeq(false);
        const at = this._asaClip(q0, a.clip);
        this._asaClipEdit("delete clip", (q) => Q.removeClip(q, at.clip.id) || { error: "not removed (locked track?)" });
        return { removed: at.clip.id };
    },

    _asa_clip_match(scene, a) {
        const q0 = this._asaSeq(false);
        const at = this._asaClip(q0, a.clip);
        this._asaClipEdit("match clip", (q) => {
            const c = Q.findClip(q, at.clip.id);
            return Q.matchToPrevious(scene, q, c.clip) || { error: "there is no clip before this one on the same character to match to" };
        });
        return { matched: at.clip.id };
    },

    _asa_clip_bake(scene, a) {
        if (a.clip) {
            const q0 = this._asaSeq(false);
            const at = this._asaClip(q0, a.clip);
            this._csBakeOne(at.clip.id);
            return { baked: at.clip.id };
        }
        const r = this.previzClipsBake();
        if (!r || !r.items) throw new Error("nothing to bake");
        return { items: r.items, keys: r.keys };
    },

    _asa_clip_track_add(scene, a) {
        const t = this._asaClipEdit("add track", (q) => Q.addTrack(q, { name: a.name || null, mode: a.mode === "additive" ? "additive" : "override" }));
        return { track: t.name, id: t.id };
    },

    _asa_clip_track_set(scene, a) {
        const q0 = this._asaSeq(false);
        if (!q0) throw new Error("the scene has no clip tracks");
        const t0 = this._asaTrack(q0, a.track);
        if (a.delete) { this._asaClipEdit("delete track", (q) => Q.removeTrack(q, t0.id) || q); return { deleted: t0.name }; }
        this._asaClipEdit("track", (q) => {
            const t = Q.trackById(q, t0.id);
            for (const k of TRACK_FIELDS) if (a[k] !== undefined) t[k] = k === "weight" ? Math.max(0, Math.min(1, Number(a[k]))) : k === "name" || k === "mode" ? a[k] : !!a[k];
            if (!Q.MODES.includes(t.mode)) t.mode = "override";
            return t;
        });
        const t = Q.trackById(this._asaSeq(false), t0.id);
        return { track: t.name, mute: !!t.mute, solo: !!t.solo, lock: !!t.lock, weight: t.weight, mode: t.mode };
    },

    // ── Rig extras ────────────────────────────────────────────────────────

    _asaAt(a, fn) {
        if (a.frame === undefined || a.frame === null) return fn();
        const was = Math.round(this.currentFrame || 0);
        this.setFrame(Math.round(Number(a.frame)));
        try { return fn(); } finally { this.setFrame(was); }
    },

    _asa_ikfk_switch(scene, a) {
        const c = this._asaItem(scene, a.control, "control");
        if (a.to && !["ik", "fk"].includes(a.to)) throw new Error("to is ik or fk");
        this._asaAt(a, () => this.previzRigSwitchIkFk(c.id, a.to || null));
        const ik = this._previzRigIkFor ? this._previzRigIkFor(c.id) : null;
        const f = a.frame == null ? Math.round(this.currentFrame || 0) : Math.round(Number(a.frame));
        return { control: c.name, ikfk: ik ? S.currentValue(scene, ik, "ikfk", f) : null };
    },

    _asa_ikfk_match(scene, a) {
        const c = this._asaItem(scene, a.control, "control");
        this._asaAt(a, () => this.previzRigMatch(c.id, a.side === "ik" ? "ik" : "fk"));
        return { control: c.name, matched: a.side === "ik" ? "ik" : "fk" };
    },

    _asa_space_set(scene, a) {
        const c = this._asaItem(scene, a.control, "control");
        let to = a.space;
        if (typeof to === "string" && !/^\d+$/.test(to)) to = to === "parent" ? 0 : this._asaItem(scene, to, "space target").id;
        else to = Number(to || 0);
        this._asaAt(a, () => this.previzRigSetSpace(c.id, to));
        return { control: c.name, spaces: ((c.control && c.control.spaces) || []).map((id) => (S.itemById(scene, id) || {}).name || id) };
    },

    _asa_attr_add(scene, a) {
        const it = this._asaItem(scene, a.item);
        const n = this.previzRigAddAttr(it.id, { name: a.name, min: a.min ?? null, max: a.max ?? null, value: a.value ?? 0 });
        if (!n) throw new Error("the attribute was not made (a name of letters, digits, _)");
        return { item: it.name, prop: `attr:${n}` };
    },

    _asaChan(scene, c) {
        const it = this._asaItem(scene, c && c.item);
        const axis = c.axis === undefined || c.axis === null ? null
            : typeof c.axis === "number" ? c.axis : "xyz".indexOf(String(c.axis).toLowerCase());
        return { id: it.id, prop: this._asaProp(it, c.prop), axis: axis === -1 ? null : axis };
    },

    /**
     * A set-driven key. `driver` {item, prop, axis}, `driven` [{item, prop, axis}];
     * `driver_value` and the driven `value`s are set first (at `frame`), then keyed.
     */
    _asa_sdk_key(scene, a) {
        const driver = this._asaChan(scene, a.driver);
        const driven = (Array.isArray(a.driven) ? a.driven : [a.driven]).map((c) => ({ ...this._asaChan(scene, c), value: c.value }));
        return this._asaAt(a, () => {
            const f = Math.round(this.currentFrame || 0);
            const put = (ch, v) => {
                if (v === undefined || v === null) return;
                const it = S.itemById(scene, ch.id);
                const cur = S.currentValue(scene, it, ch.prop, f);
                const val = Array.isArray(cur) ? cur.map((x, i) => (i === (ch.axis || 0) ? Number(v) : x)) : Number(v);
                S.setPose(scene, it, ch.prop, f, val);
            };
            if (a.driver_value !== undefined || driven.some((d) => d.value !== undefined)) {
                this.previzSnapshot("pose for driven key");
                put(driver, a.driver_value);
                for (const d of driven) put(d, d.value);
                this.previzChanged();
            }
            const n = this.previzRigSdkKey({ id: driver.id, prop: driver.prop, axis: driver.axis },
                driven.map((d) => ({ id: d.id, prop: d.prop, axis: d.axis })));
            if (!n) throw new Error("no driven key was made");
            return { keyed: n };
        });
    },

    _asa_sdk_remove(scene, a) {
        const it = this._asaItem(scene, a.item);
        const list = it.drivers || [];
        const i = Number.isInteger(a.index) ? a.index : list.findIndex((d) => d.prop === a.prop);
        if (!(i >= 0 && i < list.length)) throw new Error(`${it.name} has no such driven key`);
        this.previzRigSdkRemove(it.id, i);
        return { item: it.name, left: (it.drivers || []).length };
    },

    // ── USD ───────────────────────────────────────────────────────────────

    async _asa_export_usd(scene, a) {
        const format = a.format === "usdc" ? "usdc" : "usda";
        const name = String(a.name || (this.previzRenderName && this.previzRenderName()) || "shot");
        // The stage carries keys, not constraints or clips: those are baked into a copy first (as File > Export USD does).
        const res = await fetch(api.apiURL("/imageviewer/usd_export"), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scene: bakedCopy(Q.withClipsBaked(scene)), name, format, rule: true, context: canvasContext() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`could not export the stage: ${data.error || res.status}`);
        return { path: data.path || null, relative: data.relative || null };
    },
};
