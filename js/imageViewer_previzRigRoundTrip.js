// imageViewer_previzRigRoundTrip.js
// A character to Maya, Blender or Unreal and back: the rig carried live inside an
// exported FBX / USD, and the Rig menu's "Add motion from file…", which brings an
// FBX, USD or glTF file's motion onto a rigged character - the viewer's own rig
// as it was when the file is one of its exports and unchanged, else the file's
// motion baked onto the controls (any skeleton: matched by name, then by humanoid
// role). Mixed into the panel after PrevizRigToolsMixin; the arithmetic is in
// imageViewer_rigLive.js (pure), the files in src/rig_export.py / rig_import.py.
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import * as L from "./imageViewer_rigLive.js";
import * as Q from "./imageViewer_clipSeqData.js";
import { notice, openExportDialog, openFilePicker } from "./imageViewer_exportUI.js";

const MOTION_EXTS = [".fbx", ".usd", ".usda", ".usdc", ".usdz", ".glb", ".gltf"];
const extOf = (p) => { const m = String(p || "").toLowerCase().match(/\.[a-z0-9]+$/); return m ? m[0] : ""; };

export const PrevizRigRoundTripMixin = {

    // ── Out: the rig, for the file ────────────────────────────────────────

    /**
     * The JSON a character's export carries for the way back (imageViewer_rigLive.js):
     * null when the character has no rig. `data` is previzRigExportData's answer; the
     * fingerprint is taken from the same numbers the file is written from.
     */
    previzRigLivePayload(modelId, data) {
        const scene = this.previzScene();
        if (!R.isRigged(scene, modelId) || !data) return null;
        const meta = data.meta;
        const poses = this._previzRigPosesOfExport(meta, data.parts);
        return L.collectRigLive(scene, modelId, {
            bones: meta.bones.map((b) => b.name), panel: this,
            fingerprint: L.fingerprint(poses),
            range: [meta.frames[0], meta.frames[meta.frames.length - 1]], fps: scene.fps || 24,
        });
    },

    /** The bones' model-space worlds on each exported frame, from the export's local TRS. */
    _previzRigPosesOfExport(meta, parts) {
        const B = meta.bones.length, anim = parts.anim;
        if (!B || !anim) return [];
        const bones = meta.bones.map((b) => ({ name: b.name, parent: b.parent >= 0 ? meta.bones[b.parent].name : null }));
        return meta.frames.map((f, fi) => {
            const locals = new Map();
            meta.bones.forEach((b, i) => {
                const o = (fi * B + i) * 10;
                locals.set(b.name, R.mat4.compose([anim[o], anim[o + 1], anim[o + 2]], [anim[o + 3], anim[o + 4], anim[o + 5], anim[o + 6]],
                                                  [anim[o + 7], anim[o + 8], anim[o + 9]]));
            });
            return { f, pose: L.worldsFromLocals(bones, locals) };
        });
    },

    // ── Back: reading a file ──────────────────────────────────────────────

    /**
     * What a file brings: { info (the server's rig_import answer, or {} for glTF), src: { bones, frames, t0, t1 } | null }.
     * `file`: { path } (picked) or { url, ext } (tests, a file the page can fetch itself). `src.bones` are at
     * rest in the file's model space (Y up), `src.frames` [{ t, worlds: Map }] one per scene frame.
     */
    async previzRigReadMotion(file, { fps = null, clips = null } = {}) {
        const ext = file.ext || extOf(file.path || file.url);
        if (!MOTION_EXTS.includes(ext)) throw new Error(`${ext || "this file"} carries no motion the viewer reads`);
        let info = {};
        if (file.path && ext !== ".glb" && ext !== ".gltf") {
            const res = await fetch(api.apiURL("/imageviewer/rig/read_motion"), {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file.path }),
            });
            info = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(info.error || (await res.text().catch(() => "")) || `the server answered ${res.status}`);
        } else if (file.info) info = file.info;
        const sceneFps = fps || this.previzScene().fps || 24;
        const src = ext.startsWith(".usd") ? this._previzRigUsdMotion(info, sceneFps)
                                           : await this._previzRigLoadedMotion(file, ext, info, sceneFps, clips);
        // Every take in the file (`clips` "all": each animation of an FBX / glTF), named for the clip sequencer.
        const base = String(file.name || file.path || file.url || "motion").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
        let takes = null;
        if (src && src.takes) {
            const named = src.takes.filter((t) => t.frames.length);
            takes = named.map((t) => ({ name: named.length === 1 || !t.name || /^mixamo\.com$/i.test(t.name) ? base : `${base} - ${t.name}`,
                                        src: { bones: src.bones, frames: t.frames, t0: t.t0, t1: t.t1 } }));
        } else if (src && src.frames.length) takes = [{ name: base, src }];
        return { info, src, takes };
    },

    /** A USD skeleton's animation (sampled by the server per time code) on the scene's frames. */
    _previzRigUsdMotion(info, sceneFps) {
        if (!info.joints || !info.joints.length) return null;
        const M = R.mat4;
        let front = info.skel_to_model && info.skel_to_model.length === 16 ? info.skel_to_model : M.identity();
        if (info.up === "z") front = M.mul(L.Z_UP_TO_Y_UP, front);
        const bones = info.joints.map((j) => ({ name: j.name, parent: j.parent >= 0 ? info.joints[j.parent].name : null }));
        const fix = (m) => M.mul(front, m);
        let rest;
        if (info.bind && info.bind.length === bones.length) rest = new Map(bones.map((b, i) => [b.name, info.bind[i]]));
        else rest = L.worldsFromLocals(bones, new Map(bones.map((b, i) => [b.name, info.rest[i]])));
        const fileFps = info.fps || sceneFps;
        const samples = (info.frames || []).map((tc, k) => {
            const locals = new Map();
            info.anim[k].forEach((a, i) => locals.set(bones[i].name, M.compose(a.slice(0, 3), a.slice(3, 7), a.slice(7, 10))));
            return { t: tc / fileFps, worlds: L.worldsFromLocals(bones, locals) };
        });
        if (!samples.length) return null;
        // One sample per scene frame: the nearest of the file's (USD sampled every time code already).
        const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
        const frames = [];
        for (let f = Math.round(t0 * sceneFps); f <= Math.round(t1 * sceneFps); f++) {
            const t = f / sceneFps;
            let best = samples[0];
            for (const s of samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
            frames.push({ f, t, worlds: new Map([...best.worlds].map(([n, m]) => [n, fix(m)])) });
        }
        return { bones: bones.map((b) => ({ ...b, world: fix(rest.get(b.name)) })), frames, t0, t1 };
    },

    /** An FBX / glTF loaded by three.js in the page, its first clip sampled on the scene's frames. */
    async _previzRigLoadedMotion(file, ext, info, sceneFps, which = null) {
        const view = this._modelView();
        if (!view || !view._load) throw new Error("the 3D view is not up");
        const url = file.url || this.buildImgUrl({ path: file.path, external: true, raw: true }, { noColor: true });
        const { object, animations } = await view._load(0, url, ext.slice(1));
        const { THREE } = view.libs;
        const bones = [];
        // three.js's FBX reader gives a bone shared by two skinned meshes (Mixamo's Alpha_Surface and
        // Alpha_Joints) a copy of itself as a child, of the same name: the copy only follows, it is left out.
        object.traverse((o) => { if (o.isBone && !(o.parent && o.parent.isBone && o.parent.name === o.name)) bones.push(o); });
        if (!bones.length) throw new Error("the file has no skeleton");
        const names = new Set(bones.map((b) => b.name));
        // The character's own space: what the top bone hangs under (an FBX's character node), so the
        // node's own place in the file is left out, as it is on the way out.
        const topBone = bones.find((b) => !(b.parent && b.parent.isBone && names.has(b.parent.name)));
        const space = topBone.parent || object;
        object.updateMatrixWorld(true);
        const up = info.up === "z" ? new THREE.Matrix4().fromArray(L.Z_UP_TO_Y_UP) : null;
        const inModel = (world) => {
            const m = new THREE.Matrix4().copy(space.matrixWorld).invert().multiply(world);
            if (up) m.premultiply(up);
            return m.toArray();
        };
        // Rest: the bind pose the skin was made in, where there is one; else the file's own pose.
        const bindOf = new Map();
        object.traverse((o) => {
            if (!o.isSkinnedMesh || !o.skeleton) return;
            o.skeleton.bones.forEach((b, i) => {
                if (!bindOf.has(b.name) && o.skeleton.boneInverses[i]) {
                    bindOf.set(b.name, new THREE.Matrix4().copy(o.bindMatrix).multiply(new THREE.Matrix4().copy(o.skeleton.boneInverses[i]).invert()));
                }
            });
        });
        const parentName = (b) => (b.parent && b.parent.isBone && names.has(b.parent.name) ? b.parent.name : null);
        const asIs = bones.map((b) => ({ name: b.name, parent: parentName(b), world: inModel(b.matrixWorld) }));
        const bound = bones.map((b) => ({ name: b.name, parent: parentName(b), world: inModel(bindOf.get(b.name) || b.matrixWorld) }));
        // The bind pose is the rest when it lies where the skeleton does: an application's file can hold its
        // binds in other units or another space than its nodes (Blender's, through its unit and axis
        // options), and three.js reads the nodes. Else the file's own pose of the nodes is the rest.
        const h = L.skeletonHeight(asIs);
        const agrees = Math.abs(L.skeletonHeight(bound) - h) < 0.05 * h
            && bound.every((b, i) => R.v3.dist(b.world.slice(12, 15), asIs[i].world.slice(12, 15)) < 0.25 * h);
        const restBones = bindOf.size && agrees ? bound : asIs;
        // The clip that moves the most of these bones (an application may write one per object), the longest of those.
        const moved = (c) => new Set(c.tracks.map((t) => t.name.split(".")[0]).filter((n) => names.has(n))).size;
        const list = [...(animations || [])];
        const clip = [...list].sort((a, b) => moved(b) - moved(a) || b.duration - a.duration)[0];
        if (!clip) return { bones: restBones, frames: [], t0: 0, t1: 0, clips: 0, takes: which === "all" ? [] : null };
        const mixer = new THREE.AnimationMixer(object);
        const sample = (c) => {
            let t0 = Infinity, t1 = 0;
            for (const tr of c.tracks) if (tr.times.length) { t0 = Math.min(t0, tr.times[0]); t1 = Math.max(t1, tr.times[tr.times.length - 1]); }
            if (!Number.isFinite(t0)) t0 = 0;
            t1 = Math.max(t1, t0, c.duration > t0 ? c.duration : t0);
            mixer.stopAllAction();
            const action = mixer.clipAction(c);
            action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; action.reset(); action.play();
            const frames = [];
            for (let f = Math.round(t0 * sceneFps); f <= Math.round(t1 * sceneFps); f++) {
                const t = Math.min(t1, Math.max(t0, f / sceneFps));
                mixer.setTime(t);
                object.updateMatrixWorld(true);
                frames.push({ f, t, worlds: new Map(bones.map((b) => [b.name, inModel(b.matrixWorld)])) });
            }
            mixer.stopAllAction();
            return { frames, t0, t1 };
        };
        // Every clip that moves one of the bones (`which` "all"), else the one asked for by index, else the best.
        const pick = Number.isInteger(which) && list[which] ? list[which] : clip;
        const main = sample(pick);
        const takes = which === "all"
            ? list.filter((c) => moved(c) > 0).map((c) => (c === pick ? { name: c.name, ...main } : { name: c.name, ...sample(c) }))
            : null;
        return { bones: restBones, frames: main.frames, t0: main.t0, t1: main.t1, clips: animations.length, takes };
    },

    // ── Back: onto the character ──────────────────────────────────────────

    /**
     * What to do with a read file for this character: { live: {ok, why}, unchanged, bones, frames }.
     * `unchanged`: the file's motion is the motion the rig in it was exported with.
     */
    previzRigMotionPlan(modelId, read) {
        const skel = this._previzRigSkeletonCache(modelId);
        const names = skel ? skel.bones.map((b) => b.name) : [];
        const liveData = read.info && read.info.live;
        const live = L.canRestore(liveData, names);
        let unchanged = false;
        if (live.ok && liveData.fingerprint && read.src && read.src.frames.length) {
            const tol = 0.004 * L.skeletonHeight(read.src.bones) + 1e-4;
            unchanged = L.sameFingerprint(liveData.fingerprint, read.src.frames.map((fr) => ({ f: fr.f, pose: fr.worlds })), tol);
        }
        return { live, unchanged, frames: read.src ? read.src.frames.length : 0, bones: read.src ? read.src.bones.length : 0 };
    },

    /** The viewer's rig carried in the file back onto the character, as it was. */
    previzRigRestoreLive(modelId, live) {
        const scene = this.previzScene();
        this.previzSnapshot("restore rig");
        const view = this._modelView();
        if (R.isRigged(scene, modelId)) this._previzRigDrop(modelId);
        const { items } = L.restoreRigLive(scene, modelId, live, {
            newId: () => S.newId("c"), panel: this,
            clean: (list) => {
                // Through the scene's own reader, as a saved scene would be: unknown fields go, numbers are numbers.
                // The rest of the scene goes along so that parents outside the rig are found.
                const want = new Set(list.map((it) => it.id));
                const others = scene.items.filter((it) => !want.has(it.id));
                const parsed = S.parseScene(JSON.parse(S.serializeScene({ ...scene, items: [...others, ...list] })));
                const back = parsed && parsed.items ? parsed.items.filter((it) => want.has(it.id)) : [];
                return back.length === list.length ? back : list;
            },
        });
        if (this._rigSkelCache) this._rigSkelCache.delete(modelId);
        if (view && view._entries && view._entries.get(modelId)) view._entries.get(modelId).rigPose = null;
        const group = R.rigGroupOf(scene, modelId);
        if (group) (this._previzCollapsed || (this._previzCollapsed = new Set())).add(group.id);
        if (live.range && scene.length < live.range[1] + 1) { scene.length = live.range[1] + 1; scene.lengthSet = true; }
        this.previzChanged({ reload: true });
        return { ok: true, items: items.length };
    },

    /** The file's motion baked onto the character's controls, from scene frame `start` (default: where the file has it). */
    previzRigBakeFileMotion(modelId, src, { start = null } = {}) {
        const scene = this.previzScene();
        const skel = this._previzRigSkeletonCache(modelId);
        if (!skel || !src || !src.frames.length) return { ok: false, message: "The file has no motion." };
        let roles = null;
        const group = R.rigGroupOf(scene, modelId);
        if (group && group.rig && group.rig.humanoid) {
            const sm = R.matchHumanoid(src.bones.map((b) => ({ name: b.name, parent: b.parent, head: [b.world[12], b.world[13], b.world[14]] })));
            if (sm.humanoid) roles = { src: sm.roles, dst: group.rig.roles || {} };
        }
        const match = L.matchBones(src.bones.map((b) => b.name), skel.bones.map((b) => b.name), roles);
        if (!match.size) return { ok: false, message: "None of the file's bones are this character's (by name or by humanoid role)." };
        const shift = start == null ? 0 : start - src.frames[0].f;
        const frames = L.retarget(src, skel, match).map((fr) => ({ f: fr.f + shift, pose: fr.pose })).filter((fr) => fr.f >= 0);
        if (!frames.length) return { ok: false, message: "The motion lies before frame 0." };
        const last = frames[frames.length - 1].f;
        if (scene.length < last + 1) { scene.length = last + 1; scene.lengthSet = true; }
        const keys = this.previzRigBakePoses(modelId, frames, { label: "add motion", moveCog: true, ikfk: 0 });
        return { ok: true, frames: frames.length, keys, matched: match.size, of: skel.bones.length,
                 first: frames[0].f, last };
    },

    /**
     * Read a file and bring it onto the character: `how` "auto" (the rig back when the file is an
     * unchanged export of it, else the motion baked), "restore" or "bake". The agent's tool and the
     * tests use it; the dialog asks first.
     */
    async previzRigAddMotion(modelId, file, { how = "auto", start = null, read = null } = {}) {
        const scene = this.previzScene();
        if (!R.isRigged(scene, modelId) && how !== "restore") {
            const r0 = read || await this.previzRigReadMotion(file);
            const p0 = this.previzRigMotionPlan(modelId, r0);
            if (!p0.live.ok) return { ok: false, message: "Rig the character first (Rig → Add controls)." };
            read = r0;
            how = "restore";
        }
        read = read || await this.previzRigReadMotion(file);
        const plan = this.previzRigMotionPlan(modelId, read);
        if (how === "auto") how = plan.live.ok && plan.unchanged ? "restore" : "bake";
        if (how === "restore") {
            if (!plan.live.ok) return { ok: false, message: `The rig cannot come back: ${plan.live.why}.` };
            return { ...this.previzRigRestoreLive(modelId, read.info.live), how, unchanged: plan.unchanged };
        }
        return { ...this.previzRigBakeFileMotion(modelId, read.src, { start }), how };
    },

    /**
     * Several motions onto a rigged character at once (several Mixamo files, or a file with
     * several animations): each is matched and baked as `previzRigBakeFileMotion` does, but
     * kept as a source of the Clip sequencer instead of keys on the controls - the controls
     * are left as they were. `place`: the clips also go on a track one after another from
     * frame `start`. `takes` [{ name, src }] (previzRigReadMotion's). One undo step.
     */
    previzRigAddMotionClips(modelId, takes, { start = 0, place = true } = {}) {
        const scene = this.previzScene();
        const skel = this._previzRigSkeletonCache(modelId);
        if (!R.isRigged(scene, modelId) || !skel) return { ok: false, message: "Rig the character first (Rig → Add controls)." };
        if (!this._csEdit) return { ok: false, message: "The Clip sequencer is not available." };
        const group = R.rigGroupOf(scene, modelId);
        const ctrls = R.controlsOf(scene, modelId);
        const out = { ok: true, sources: [], clips: 0, skipped: [] };
        let at = Math.max(0, Math.round(start));
        const r = this._csEdit(takes.length > 1 ? `add ${takes.length} motions` : "add motion", (q) => {
            const undo = this._undoState ? this._undoState() : null;
            const depth = undo ? undo.past.length : 0;
            for (const take of takes) {
                const src = take.src;
                if (!src || !src.frames.length) { out.skipped.push(`${take.name} (no motion)`); continue; }
                let roles = null;
                if (group && group.rig && group.rig.humanoid) {
                    const sm = R.matchHumanoid(src.bones.map((b) => ({ name: b.name, parent: b.parent, head: [b.world[12], b.world[13], b.world[14]] })));
                    if (sm.humanoid) roles = { src: sm.roles, dst: group.rig.roles || {} };
                }
                const match = L.matchBones(src.bones.map((b) => b.name), skel.bones.map((b) => b.name), roles);
                if (!match.size) { out.skipped.push(`${take.name} (no bones in common)`); continue; }
                const f0 = src.frames[0].f;
                const frames = L.retarget(src, skel, match).map((fr) => ({ f: fr.f - f0, pose: fr.pose }));
                const last = frames[frames.length - 1].f;
                // Baked onto the controls, taken off them as a source, and the controls put back as they were.
                const saved = ctrls.map((c) => [c, JSON.parse(JSON.stringify(c.tracks || {}))]);
                for (const c of ctrls) c.tracks = {};
                this.previzRigBakePoses(modelId, frames, { label: "add motion", moveCog: true, ikfk: 0, snapshot: false });
                const made = Q.captureSource(scene, ctrls.map((c) => c.id), 0, Math.max(1, last),
                                             { name: take.name, model: modelId, made: "file", remove: false, keepAll: true });
                for (const [c, t] of saved) c.tracks = t;
                made.keep = true;
                Q.addSource(q, made);
                out.sources.push({ id: made.id, name: made.name, length: made.length, matched: match.size, of: skel.bones.length });
                if (place) {
                    const track = Q.trackWithRoom(q, at, at + made.length, q.tracks.length ? q.tracks[0].id : null);
                    if (track && Q.addClip(q, track.id, made.id, at)) { out.clips++; at += made.length; }
                }
            }
            if (undo) undo.past.length = depth;
            return out.sources.length ? q : { error: `Nothing added: ${out.skipped.join(", ") || "no motion"}.` };
        });
        if (!r || r.error) return { ok: false, message: (r && r.error) || "Nothing added." };
        return out;
    },

    /** Rig menu › Add motion from file…: pick an FBX / USD / glTF, then say what it will do. */
    async previzAddMotionDialog(modelId = this.previzRigModelOf()) {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model) { notice("info", "Select a character first."); return; }
        if (!this.previzHasSkeleton(modelId)) { notice("info", `${model.name} has no skeleton to put a motion on.`); return; }
        openFilePicker(this.container, {
            id: "motion", title: "Add motion from file", kind: "character", exts: MOTION_EXTS, go: "Add", multiple: true,
            note: "An FBX, USD or glTF character with animation (a Mixamo download, say). Ctrl or Shift + click picks "
                + "several: they go into the Clip sequencer. The viewer's own exports bring their rig back.",
            onPick: async (files) => {
                const reads = [];
                for (const f of files) {
                    try {
                        reads.push({ f, read: await this.previzRigReadMotion({ path: f.path, name: f.name }, { clips: "all" }) });
                    } catch (e) {
                        return { ok: false, message: `Could not read ${f.name}: ${(e && e.message) || e}` };
                    }
                }
                const takes = reads.flatMap((x) => x.read.takes || []);
                if (reads.length === 1 && takes.length <= 1) setTimeout(() => this._previzAddMotionAsk(modelId, reads[0].f, reads[0].read), 0);
                else setTimeout(() => this._previzAddMotionsAsk(modelId, reads, takes), 0);
                return { ok: true };
            },
        });
    },

    /** Several motions picked (or one file with several animations): as clips in the Clip sequencer. */
    async _previzAddMotionsAsk(modelId, reads, takes) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        if (!R.isRigged(scene, modelId)) { notice("info", "Rig the character first (Rig → Add controls), then add the motions."); return; }
        if (!takes.length) { notice("info", reads.length > 1 ? "None of these files has an animation." : `${reads[0].f.name} has no animation.`); return; }
        let how, start;
        await openExportDialog(this.container, {
            title: "Add motions from files", kind: "character", plain: true, where: false,
            fixed: [{ value: "motion", label: "" }], go: "Add",
            rows: ({ el, row }) => {
                how = el("select", "rd-in");
                const opt = (value, label) => how.append(Object.assign(el("option"), { value, textContent: label }));
                opt("place", "Add as clips, one after another on a track");
                opt("sources", "Add as sources only (place them with Add clip ▾)");
                start = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: Math.max(0, Math.round(this.currentFrame || 0)), min: 0 });
                const list = takes.map((t) => `${t.name} (${t.src.frames.length} f)`).join(", ");
                const rows = [row("Motions", el("span", "rd-sub", `${takes.length} from ${reads.length} file${reads.length === 1 ? "" : "s"}: ${list}`)),
                              row("Do", how), row("Start at frame", start)];
                how.onchange = () => { start.disabled = how.value !== "place"; };
                how.onchange();
                return rows;
            },
            note: "Each motion is matched to this character's bones by name, then by humanoid role, and kept as a source in the "
                + "Clip sequencer, where clips can be moved, blended and looped. The controls' own keys are left as they are.",
            onExport: async (v, { progress }) => {
                progress(0, 1, "Adding the motions…");
                const out = this.previzRigAddMotionClips(modelId, takes, {
                    start: Math.max(0, Math.round(Number(start.value) || 0)), place: how.value === "place",
                });
                if (!out.ok) return { ok: false, message: out.message };
                if (this.setPanelDocked) { try { this.setPanelDocked("clips", true); } catch (_) { /* no Clip panel */ } }
                notice("success", `${out.sources.length} motion${out.sources.length === 1 ? "" : "s"} on ${model.name}`,
                       (out.clips ? `${out.clips} clip${out.clips === 1 ? "" : "s"} placed in the Clip sequencer.` : "Sources in the Clip sequencer: Add clip ▾ places them.")
                       + (out.skipped.length ? ` Left out: ${out.skipped.join(", ")}.` : ""));
                return { ok: true };
            },
        });
    },

    async _previzAddMotionAsk(modelId, f, read) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        const plan = this.previzRigMotionPlan(modelId, read);
        const rigged = R.isRigged(scene, modelId);
        if (!plan.live.ok && !rigged) { notice("info", "Rig the character first (Rig → Add controls), then add the motion."); return; }
        if (!plan.live.ok && !plan.frames) { notice("info", `${f.name} has no animation.`); return; }
        let how, start;
        const first = read.src && read.src.frames.length ? read.src.frames[0].f : 0;
        await openExportDialog(this.container, {
            title: "Add motion from file", kind: "character", plain: true, where: false,
            fixed: [{ value: "motion", label: "" }], go: "Add",
            rows: ({ el, row }) => {
                how = el("select", "rd-in");
                const opt = (value, label) => how.append(Object.assign(el("option"), { value, textContent: label }));
                if (plan.live.ok) opt("restore", plan.unchanged ? "Bring the rig back as it was (unchanged since export)" : "Bring the rig back as exported (drops the changes made elsewhere)");
                if (plan.frames && rigged) opt("bake", "Bake the file's motion onto the controls");
                how.value = plan.live.ok && (plan.unchanged || !plan.frames || !rigged) ? "restore" : "bake";
                start = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: Math.max(0, first), min: 0 });
                const rows = [row("From the file", el("span", "rd-sub", `${f.name}: ${plan.frames} frames, ${plan.bones} bones`)), row("Do", how),
                              row("Start at frame", start)];
                how.onchange = () => { start.disabled = how.value === "restore"; };
                how.onchange();
                return rows;
            },
            note: plan.live.ok
                ? (plan.unchanged ? "This file is one of the viewer's exports of this character and its motion is unchanged."
                                  : "This file is one of the viewer's exports, but its motion was changed in another application since.")
                : "The motion is matched to this character's bones by name, then by humanoid role, and keyed on the controls.",
            onExport: async (v, { progress }) => {
                progress(0, 1, "Adding the motion…");
                const out = await this.previzRigAddMotion(modelId, { path: f.path }, {
                    how: how.value, start: Math.max(0, Math.round(Number(start.value) || 0)), read,
                });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", out.how === "restore" ? `${model.name}'s rig is back` : "Motion added",
                       out.how === "restore" ? `${out.items} rig items from ${f.name}`
                                             : `${out.frames} frames, ${out.keys} keys; ${out.matched} of ${out.of} bones followed the file.`);
                return { ok: true };
            },
        });
    },
};
