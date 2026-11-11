// imageViewer_previzRigAI.js
// More AI animation for the Rig menu, mixed into the panel after PrevizRigToolsMixin:
//
//   * Restyle motion…     the motion the character has, done another way (Kimodo: the hips'
//                         path and timing - and, as close as asked, the hands, feet or whole
//                         body every few frames - are its constraints, the prompt is the style);
//   * Motion from video…  a person's motion in a film (MediaPipe's Pose Landmarker on the
//                         server, solved onto the character here: imageViewer_rigVideo.js),
//                         optionally smoothed by Kimodo into motion that stands on its feet;
//   * Lip sync from audio… mouth shapes read off a sound (src/lipsync.py) keyed on the
//                         character's own blendshapes (imageViewer_rigLipsync.js);
//   * every AI take onto an animation layer of its own when the scene has layers, so
//     the keys it was made from stay under it (pose to pose, then AI in-betweens on top);
//   * the agent's requests for constraints, layers and the pose library.
//
// Layers, constraints, blendshapes and the pose library are other mixins
// (imageViewer_previzLayers.js, imageViewer_previzConstraints.js, the rig extras): this
// file only calls them when they are there.
import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import * as M from "./imageViewer_rigMotion.js";
import * as V from "./imageViewer_rigVideo.js";
import * as L from "./imageViewer_rigLipsync.js";
import * as P from "./imageViewer_rigPoseSpec.js";
import { api } from "../../scripts/api.js";
import { notice, openExportDialog, openFilePicker } from "./imageViewer_exportUI.js";

const FILM_EXTS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"];
const SOUND_EXTS = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus", ...FILM_EXTS];
const nameOf = (ref) => String((ref && (ref.path || ref.filename)) || "").split(/[\\/]/).pop();
const extOf = (ref) => { const m = /\.[A-Za-z0-9]+$/.exec(nameOf(ref).split("?")[0]); return m ? m[0].toLowerCase() : ""; };
const refOf = (f) => (!f ? null : f.path ? { path: String(f.path) }
    : f.filename ? { filename: String(f.filename), type: f.type || "output", subfolder: f.subfolder || "" } : null);

export const PrevizRigAIMixin = {

    // ── Layers ────────────────────────────────────────────────────────────

    /** Whether the scene has animation layers to put a take on (the layers mixin is there). */
    previzLayersAvailable() {
        return typeof this.previzLayerAdd === "function" && typeof this.previzWithLayer === "function";
    },

    /** A "put it on a new layer" checkbox for a dialog: { label, box }. */
    _previzLayerBox(el, checked = true) {
        const box = Object.assign(el("input"), { type: "checkbox", checked });
        const label = el("label", "rd-sub");
        label.append(box, " On a new animation layer (the keys under it stay)");
        return { label, box };
    },

    /**
     * Bake poses onto the character's controls, on a layer when `layer` says so:
     * "new" (a new override layer named after the take), a layer id, or null (as before).
     * Answers { keys, layer }.
     */
    _previzRigBakeInto(modelId, frames, opts, layer = null) {
        if (!layer || !this.previzLayersAvailable()) return { keys: this.previzRigBakePoses(modelId, frames, opts), layer: null };
        let id = layer;
        if (layer === "new") {
            const model = S.itemById(this.previzScene(), modelId);
            const base = `${opts.label || "AI"}${model ? ` · ${model.name}` : ""}`;
            id = typeof this.previzLayerBakeTarget === "function"
                ? this.previzLayerBakeTarget(modelId, null, base)
                : this.previzLayerAdd({ name: base, mode: "override", select: false });
        }
        let keys = 0;
        this.previzWithLayer(id, () => { keys = this.previzRigBakePoses(modelId, frames, opts); });
        return { keys, layer: id };
    },

    // ── Media: a film or a sound from the History or a file ───────────────

    /** The History's selected (else open) frame of one of `exts`, as the routes take it. */
    _previzRigMediaFromHistory(exts) {
        const picked = (this.selectedHistorySnapshots ? this.selectedHistorySnapshots() : []).map((p) => p.imgObj);
        const stack = (this.history && this.historyKey && this.history[this.historyKey()]) || [];
        const open = stack[this.currentHistoryIndex || 0];
        for (const f of [...picked, open && open[0]]) {
            const ref = refOf(f);
            if (ref && exts.includes(extOf(ref))) return ref;
        }
        return null;
    },

    /** A dialog row for a film / sound: its name, From History and Browse… Answers { row, get }. */
    _previzRigMediaRow(el, row, { label, exts, kind }) {
        let ref = this._previzRigMediaFromHistory(exts);
        const name = el("span", "rd-sub", ref ? nameOf(ref) : "none picked");
        const hist = el("button", "rd-btn", "From History");
        hist.type = "button";
        hist.title = `The ${kind} selected (or open) in the History strip`;
        hist.onclick = () => {
            const got = this._previzRigMediaFromHistory(exts);
            if (!got) { notice("info", `No ${kind} in the History`, `Select a ${kind} in the History strip first.`); return; }
            ref = got; name.textContent = nameOf(ref);
        };
        const browse = el("button", "rd-btn", "Browse…");
        browse.type = "button";
        browse.onclick = () => openFilePicker(this.container, {
            id: `rig-${kind}`, title: `A ${kind}`, kind: "video", exts, go: "Pick",
            onPick: async (files) => { if (files[0]) { ref = { path: files[0].path }; name.textContent = files[0].name; } return { ok: true }; },
        });
        return { row: row(label, name, hist, browse), get: () => ref };
    },

    // ── Restyle ───────────────────────────────────────────────────────────

    async previzRestyleDialog(modelId = this.previzRigModelOf()) {
        const ready = await this._previzRigAIReady(modelId, "kimodo", () => this.previzRestyleDialog(modelId));
        if (!ready) return;
        const { scene, model, tools } = ready;
        const keyed = this.previzRigKeyedFrames(modelId);
        if (keyed.length < 2) { notice("info", "Nothing to restyle", "Key or generate some motion on the character first."); return; }
        let prompt, from, to, strength, seed, feet, onLayer;
        await openExportDialog(this.container, {
            title: "Restyle motion (Kimodo)", kind: "character", where: false, name: model.name, go: "Restyle",
            fixed: [{ value: tools.kimodo.model, label: tools.kimodo.model }],
            rows: ({ el, row }) => {
                prompt = Object.assign(el("textarea", "rd-in rd-text"), { rows: 3, spellcheck: true,
                    placeholder: "A tired old man walks slowly. / A proud soldier marches. / A person sneaks on tiptoe." });
                prompt.style.width = "100%";
                from = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: keyed[0], min: 0 });
                to = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: keyed[keyed.length - 1], min: 0 });
                strength = el("select", "rd-in");
                for (const [v, t] of [["loose", "Loose: the path and timing only"], ["medium", "Medium: hands and feet every half second"],
                                      ["close", "Close: the whole body every third of a second"]]) {
                    const o = el("option", "", t); o.value = v; strength.append(o);
                }
                strength.value = "medium";
                seed = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: "", placeholder: "random" });
                feet = Object.assign(el("input"), { type: "checkbox", checked: true });
                const lf = el("label", "rd-sub"); lf.append(feet, " Pin the feet where they stand");
                const rows = [row("Style", prompt), row("Frames", from, el("span", "rd-sub", "to"), to), row("Keep", strength),
                              row("Seed", seed), row("Feet", lf)];
                if (this.previzLayersAvailable()) rows.push(row("Layer", (onLayer = this._previzLayerBox(el, true)).label));
                return rows;
            },
            note: "The character goes the same way at the same time; the prompt says how. The closer it keeps, the less the style changes.",
            onExport: async (_v, { progress }) => {
                const out = await this.previzRigRestyle(modelId, {
                    prompt: prompt.value, from: Number(from.value), to: Number(to.value), strength: strength.value,
                    seed: seed.value === "" ? null : Number(seed.value), feet: feet.checked,
                    layer: onLayer && onLayer.box.checked ? "new" : null, progress: (line) => progress(0.5, 1, line),
                });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", "Motion restyled", `${out.frames} frames keyed on ${model.name}${out.layer ? " on a new layer" : ""}.`);
                return { ok: true };
            },
        });
    },

    /** The character's motion over [from, to], restyled by `prompt`, keyed back over it. */
    async previzRigRestyle(modelId, { prompt = "", from = null, to = null, strength = "medium", seed = null, feet = true,
                                      layer = null, progress = null } = {}) {
        const scene = this.previzScene();
        const info = this._previzRigMotionRest(modelId);
        if (!info) return { ok: false, message: "The character needs humanoid controls." };
        if (!String(prompt || "").trim()) return { ok: false, message: "Describe the style." };
        const keyed = this.previzRigKeyedFrames(modelId);
        from = Math.max(0, Math.round(from != null ? from : keyed[0] || 0));
        to = Math.round(to != null ? to : keyed[keyed.length - 1] || from + 1);
        if (to - from < 4) return { ok: false, message: "A restyle needs a few frames of motion." };
        const list = [];
        for (let f = from; f <= to; f++) list.push(f);
        const fps = scene.fps || 24;
        const req = M.restyleRequest(this._modelView().rigPosesAt(modelId, list), info.rest, info.scale, fps, strength);
        const job = await this._previzRigJob("/imageviewer/rig/motion", {
            mode: "restyle", prompt: String(prompt).trim(), frames: req.frames, keys: req.keys, path: req.path,
            seed, heading: req.heading,
        }, { progress });
        if (job.state !== "done") return { ok: false, message: `The motion was not restyled: ${job.error || job.state}` };
        return this.previzRigApplyMotion(modelId, job.result, { from, to, origin: req.origin, feet, mode: "restyle",
                                                                 layer, keepEnds: false, label: "AI restyle" });
    },

    // ── Motion from a film ────────────────────────────────────────────────

    async previzVideoMotionDialog(modelId = this.previzRigModelOf()) {
        const ready = await this._previzRigAIReady(modelId, "posetrack", () => this.previzVideoMotionDialog(modelId));
        if (!ready) return;
        const { model, tools } = ready;
        let media, at, step, inPlace, smooth, clean, prompt, feet, onLayer, filmFrom, filmTo;
        await openExportDialog(this.container, {
            title: "Motion from video", kind: "character", where: false, name: model.name, go: "Track",
            fixed: [{ value: "posetrack", label: "MediaPipe Pose Landmarker" }],
            rows: ({ el, row }) => {
                media = this._previzRigMediaRow(el, row, { label: "Film", exts: FILM_EXTS, kind: "film" });
                filmFrom = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 0, min: 0 });
                filmTo = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: "", placeholder: "end" });
                at = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: Math.round(this.currentFrame || 0), min: 0 });
                step = el("select", "rd-in");
                for (const [v, t] of [["1", "every frame"], ["2", "every 2nd frame (faster)"], ["3", "every 3rd frame"]]) {
                    const o = el("option", "", t); o.value = v; step.append(o);
                }
                smooth = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 1.5, min: 0, max: 6, step: 0.5 });
                inPlace = Object.assign(el("input"), { type: "checkbox", checked: false });
                const lp = el("label", "rd-sub"); lp.append(inPlace, " In place (no travel; for a camera that moves)");
                clean = Object.assign(el("input"), { type: "checkbox", checked: !!(tools.kimodo && tools.kimodo.ready) });
                clean.disabled = !(tools.kimodo && tools.kimodo.ready);
                const lc = el("label", "rd-sub"); lc.append(clean, " Clean up with Kimodo (smooth, on its feet)");
                if (clean.disabled) lc.title = "Kimodo is not set up (Rig › Set up…)";
                prompt = Object.assign(el("input", "rd-in rd-text"), { value: "", placeholder: "Optional, for the clean-up: a person dances" });
                prompt.style.width = "100%";
                feet = Object.assign(el("input"), { type: "checkbox", checked: true });
                const lf = el("label", "rd-sub"); lf.append(feet, " Pin the feet where they stand");
                const rows = [media.row, row("Film frames", filmFrom, el("span", "rd-sub", "to"), filmTo), row("Scene frame", at),
                              row("Read", step), row("Smoothing", smooth, el("span", "rd-sub", "frames")), row("Travel", lp),
                              row("Clean-up", lc), row("Clean-up prompt", prompt), row("Feet", lf)];
                if (this.previzLayersAvailable()) rows.push(row("Layer", (onLayer = this._previzLayerBox(el, true)).label));
                return rows;
            },
            note: "One person, whole body in view, head visible, within about 4 m of a camera that stands still. "
                + "The motion is keyed on the controls from the scene frame on.",
            onExport: async (_v, { progress }) => {
                const src = media.get();
                if (!src) return { ok: false, message: "Pick a film first." };
                const out = await this.previzRigVideoMotion(modelId, {
                    src, at: Number(at.value), filmFrom: Number(filmFrom.value) || 0,
                    filmTo: filmTo.value === "" ? null : Number(filmTo.value), step: Number(step.value) || 1,
                    smooth: Number(smooth.value), inPlace: inPlace.checked, clean: clean.checked, prompt: prompt.value,
                    feet: feet.checked, layer: onLayer && onLayer.box.checked ? "new" : null,
                    progress: (line) => progress(0.5, 1, line),
                });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", "Motion from video", `${out.frames} frames keyed on ${model.name}${out.layer ? " on a new layer" : ""}.`);
                return { ok: true };
            },
        });
    },

    /** Track the person in a film and key their motion on the character from scene frame `at`. */
    async previzRigVideoMotion(modelId, { src, at = 0, filmFrom = 0, filmTo = null, step = 1, smooth = 1.5, inPlace = false,
                                          clean = false, prompt = "", feet = true, layer = null, progress = null, fov = 50 } = {}) {
        const scene = this.previzScene();
        const info = this._previzRigMotionRest(modelId);
        if (!info) return { ok: false, message: "The character needs humanoid controls." };
        if (!src) return { ok: false, message: "No film." };
        const job = await this._previzRigJob("/imageviewer/rig/video_pose", {
            src, start: Math.max(0, Math.round(filmFrom)), end: filmTo == null ? -1 : Math.round(filmTo), step,
        }, { progress });
        if (job.state !== "done") return { ok: false, message: `The film was not tracked: ${job.error || job.state}` };
        let motion;
        try {
            motion = V.solveFilm(job.result, { smooth, inPlace, fov });
        } catch (e) {
            return { ok: false, message: String(e.message || e) };
        }
        const fps = scene.fps || 24;
        const n = motion.samples[0].rot.length;
        const from = Math.max(0, Math.round(at));
        const to = from + Math.max(1, Math.round(((n - 1) / motion.fps) * fps));
        // The film's person stands at the origin of the motion: put them where the character's hips are at `from`.
        const [p0] = this._modelView().rigPosesAt(modelId, [from]);
        const h = p0.pose.get(info.rest.roles.hips);
        const origin = [h[12], h[14]];
        if (clean) {
            if (progress) progress("Cleaning the motion up with Kimodo…");
            const k = V.filmKeys(motion, 6);
            const job2 = await this._previzRigJob("/imageviewer/rig/motion", {
                mode: "inbetween", prompt: String(prompt || "").trim() || "A person moves naturally.",
                frames: k.frames, keys: k.keys, path: k.path, heading: M.headingOf(k.keys[0]),
            }, { progress });
            if (job2.state !== "done") return { ok: false, message: `Kimodo's clean-up failed: ${job2.error || job2.state}` };
            motion = job2.result;
        }
        return this.previzRigApplyMotion(modelId, motion, { from, to, origin, feet, mode: "video", layer, keepEnds: false,
                                                             label: "Video motion" });
    },

    // ── Lip sync ──────────────────────────────────────────────────────────

    /** The character's blendshape names (the rig extras' view helper, else the meshes' own dictionaries). */
    _previzMorphNames(modelId) {
        const view = this._modelView();
        if (view && typeof view.rigMorphNames === "function") return view.rigMorphNames(modelId) || [];
        const names = new Set();
        const entry = view && view._entries && view._entries.get ? view._entries.get(modelId) : null;
        const obj = entry && entry.object;
        if (obj && obj.traverse) obj.traverse((o) => { if (o.morphTargetDictionary) Object.keys(o.morphTargetDictionary).forEach((n) => names.add(n)); });
        return [...names];
    },

    /** Whether blendshape keys can be written (the scene model takes "bs:" tracks): asked of a scratch item. */
    _previzCanKeyMorphs() {
        const probe = {};
        S.setKeyframe(probe, "bs:probe", 0, 0, "linear");
        return !!(probe.tracks && probe.tracks["bs:probe"]);
    },

    async previzLipSyncDialog(modelId = this.previzRigModelOf()) {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model) { notice("info", "Select a character."); return; }
        const set = L.pickSet(this._previzMorphNames(modelId));
        if (!set) {
            notice("info", "No mouth shapes", `${model.name} has no blendshapes for the mouth (ARKit's jawOpen, visemes like viseme_aa, or a mouth-open shape).`);
            return;
        }
        if (!this._previzCanKeyMorphs()) {
            notice("info", "Blendshape keys are not here yet", "This viewer cannot key blendshapes yet: update the viewer.");
            return;
        }
        let media, at, start, seconds, strength, lead;
        await openExportDialog(this.container, {
            title: "Lip sync from audio", kind: "character", where: false, name: model.name, go: "Key the mouth",
            fixed: [{ value: set.id, label: `${set.label} (${Object.keys(set.shapes).length} shapes)` }],
            rows: ({ el, row }) => {
                media = this._previzRigMediaRow(el, row, { label: "Sound", exts: SOUND_EXTS, kind: "sound" });
                at = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: Math.round(this.currentFrame || 0), min: 0 });
                start = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 0, min: 0, step: 0.1 });
                seconds = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: "", placeholder: "to the end", min: 0, step: 0.1 });
                strength = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 1, min: 0.1, max: 2, step: 0.1 });
                lead = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 1, min: 0, max: 6 });
                return [media.row, row("Scene frame", at), row("Sound from", start, el("span", "rd-sub", "s, for"), seconds, el("span", "rd-sub", "s")),
                        row("Strength", strength), row("Lead", lead, el("span", "rd-sub", "frames (the mouth moves before it sounds)"))];
            },
            note: "Read from the sound itself (loudness and where its energy lies), not word by word: good for chatter and "
                + "song, rough on single sounds. The keys are ordinary blendshape keys to tidy up by hand.",
            onExport: async (_v, { progress }) => {
                const src = media.get();
                if (!src) return { ok: false, message: "Pick a sound (or a film with sound) first." };
                progress(0.3, 1, "Listening…");
                const out = await this.previzRigLipSync(modelId, {
                    src, at: Number(at.value), start: Number(start.value) || 0,
                    seconds: seconds.value === "" ? null : Number(seconds.value), strength: Number(strength.value) || 1,
                    lead: Number(lead.value) || 0,
                });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", "Lip sync", `${out.frames} frames, ${out.keys} keys on ${out.shapes} shapes of ${model.name}.`);
                return { ok: true };
            },
        });
    },

    /** Read the mouth off a sound and key the character's blendshapes from scene frame `at`. */
    async previzRigLipSync(modelId, { src, at = 0, start = 0, seconds = null, strength = 1, lead = 1, smooth = 1 } = {}) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        if (!model) return { ok: false, message: "No such character." };
        const set = L.pickSet(this._previzMorphNames(modelId));
        if (!set) return { ok: false, message: `${model.name} has no blendshapes for the mouth.` };
        if (!this._previzCanKeyMorphs()) return { ok: false, message: "this viewer cannot key blendshapes yet (update the viewer)" };
        const fps = scene.fps || 24;
        let res, body;
        try {
            res = await fetch(api.apiURL("/imageviewer/rig/lipsync"), {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ src, fps, start, seconds, strength, lead, smooth }),
            });
            body = await res.json().catch(() => ({}));
        } catch (e) {
            return { ok: false, message: String(e.message || e) };
        }
        if (!res.ok) return { ok: false, message: body.error || `HTTP ${res.status}` };
        const from = Math.max(0, Math.round(at));
        const keys = L.lipKeys(body, set, from);
        const last = from + body.frames - 1;
        this.previzSnapshot("lip sync");
        let count = 0;
        for (const [name, list] of Object.entries(keys)) {
            const prop = `bs:${name}`;
            const kept = S.track(model, prop).filter((k) => k.f < from || k.f > last);
            if (model.tracks) { if (kept.length) model.tracks[prop] = kept; else delete model.tracks[prop]; }
            for (const k of list) { S.setKeyframe(model, prop, k.f, k.v, "linear"); count++; }
        }
        if (scene.length < last + 1) { scene.length = last + 1; scene.lengthSet = true; }
        this.previzChanged();
        return { ok: true, frames: body.frames, keys: count, shapes: Object.keys(keys).length, set: set.id, last };
    },

    // ── Shared ────────────────────────────────────────────────────────────

    /** A humanoid rig and the tool set up (else the install dialog, then `again`): { scene, model, tools } or null. */
    async _previzRigAIReady(modelId, tool, again) {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model) { notice("info", "Select a rigged character."); return null; }
        if (!this._previzRigMotionRest(modelId)) {
            notice("info", "This needs humanoid controls", "Rig › Add controls; the character must read as a humanoid.");
            return null;
        }
        const tools = await this._previzRigTools();
        if (!tools[tool] || !tools[tool].ready) {
            if (!tools[tool]) { notice("warn", "Not set up", "The viewer could not ask the server (or it is too old)."); return null; }
            this.previzRigInstallDialog(tools, tool, again);
            return null;
        }
        return { scene, model, tools };
    },

    /** The Rig menu's entries for this file (inserted after the AI motion ones). */
    previzRigAIEntries(modelId, { rigged }) {
        return [
            ...(this.previzPoseDialog ? [{ label: "Pose…", disabled: !rigged, run: () => this.previzPoseDialog(modelId) }] : []),
            { label: "Restyle motion…", disabled: !rigged, run: () => this.previzRestyleDialog(modelId) },
            { label: "Motion from video…", disabled: !rigged, run: () => this.previzVideoMotionDialog(modelId) },
            { label: "Lip sync from audio…", disabled: !modelId, run: () => this.previzLipSyncDialog(modelId) },
        ];
    },

    // ── The agent ─────────────────────────────────────────────────────────

    /** Whether an agent action works on the scene rather than one character (no model needed). */
    previzRigSceneAction(action) {
        return SCENE_ACTIONS.has(action);
    },

    /**
     * The agent's actions beyond the Rig menu's own (previzRigAgentRun hands them here):
     * restyle, video_motion, lipsync, and the layers / constraints / pose library ops,
     * which call those mixins when they are there. Answers the result, or throws.
     */
    async previzRigAgentExtra(action, model, a) {
        if (!model && !SCENE_ACTIONS.has(action)) throw new Error("name the model");
        const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
        const need = (fn, what) => {
            if (typeof this[fn] !== "function") throw new Error(`${what} are not in this viewer yet (update the viewer)`);
            return this[fn].bind(this);
        };
        const scene = this.previzScene();
        const byName = (w) => {
            if (!w) return null;
            const s = String(w).toLowerCase();
            const it = scene.items.find((i) => i.id === w) || scene.items.find((i) => String(i.name || "").toLowerCase() === s);
            if (!it) throw new Error(`no item named ${w} in the 3D scene`);
            return it.id;
        };
        const layerOpt = a.layer === true || a.layer === "new" ? "new" : a.layer || null;
        switch (action) {
            case "restyle":
                return this.previzRigRestyle(model.id, { prompt: a.prompt || "", from: a.from == null ? null : num(a.from),
                    to: a.to == null ? null : num(a.to), strength: a.strength || "medium",
                    seed: a.seed == null ? null : Number(a.seed), feet: a.feet !== false, layer: layerOpt });
            case "video_motion":
                return this.previzRigVideoMotion(model.id, { src: a.src || (a.path ? { path: a.path } : null),
                    at: num(a.from, Math.round(this.currentFrame || 0)), filmFrom: num(a.film_from, 0),
                    filmTo: a.film_to == null ? null : num(a.film_to), step: num(a.step, 1), smooth: num(a.smooth, 1.5),
                    inPlace: !!a.in_place, clean: !!a.clean, prompt: a.prompt || "", feet: a.feet !== false, layer: layerOpt });
            case "lipsync":
                return this.previzRigLipSync(model.id, { src: a.src || (a.path ? { path: a.path } : null),
                    at: num(a.from, Math.round(this.currentFrame || 0)), start: num(a.start, 0),
                    seconds: a.seconds == null ? null : num(a.seconds), strength: num(a.strength, 1), lead: num(a.lead, 1) });
            case "layer_add": {
                const id = need("previzLayerAdd", "Animation layers")({ name: a.name || "Layer", mode: a.mode === "additive" ? "additive" : "override",
                    weight: num(a.weight, 1), select: a.select !== false });
                return { layer: id };
            }
            case "layer_list":
                return { layers: ((scene.animLayers) || []).map((l) => ({ id: l.id, name: l.name, mode: l.mode, weight: l.weight,
                    mute: !!l.mute, solo: !!l.solo, lock: !!l.lock })), active: scene.activeLayer || null };
            case "constrain": {
                const id = need("previzConstrain", "Constraints")(a.type || "parent", {
                    driven: byName(a.driven), targets: (a.targets || []).map(byName), maintainOffset: a.maintain_offset !== false,
                    weights: a.weights, skip: a.skip, aim: a.aim });
                if (!id) throw new Error("the constraint was not made (check driven and targets)");
                return { constraint: id };
            }
            case "remove_constraint":
                return { removed: need("previzRemoveConstraint", "Constraints")(byName(a.driven), a.constraint || null) };
            case "list_constraints":
                return { constraints: need("previzListConstraints", "Constraints")(a.item ? byName(a.item) : null) };
            case "bake_constraints":
                return { keys: need("previzBakeConstraints", "Constraints")(a.items ? a.items.map(byName) : null,
                    { first: num(a.from, 0), last: num(a.to, Math.max(0, (scene.length || 1) - 1)), remove: a.remove !== false }) };
            case "pose_list":
                return { poses: await need("previzPoseList", "The pose library")() };
            case "pose_save":
                if (!a.name) throw new Error("pose_save needs a name");
                await need("previzPoseSave", "The pose library")(a.name, { modelId: model.id });
                return { saved: a.name };
            case "pose_apply":
                if (!a.name) throw new Error("pose_apply needs a name");
                await need("previzPoseApply", "The pose library")(a.name, { modelId: model.id, blend: num(a.blend, 1),
                    mirror: !!a.mirror, key: a.key !== false });
                return { applied: a.name };
            case "pose_delete":
                await need("previzPoseDelete", "The pose library")(a.name);
                return { deleted: a.name };
            case "pose": {
                const out = await need("previzRigPose", "Single poses")(model.id, { preset: a.preset || null, joints: a.joints || null,
                    hips: a.hips || null, mirror: a.mirror || null, ground: a.ground !== false,
                    frame: a.frame == null ? (a.from == null ? null : num(a.from)) : num(a.frame),
                    prompt: a.prompt || "", seed: a.seed == null ? null : Number(a.seed), layer: layerOpt });
                if (!out.ok) throw new Error(out.message);
                return { frame: out.frame, keys: out.keys, layer: out.layer, not_understood: out.unknown };
            }
            case "pose_presets":
                return { presets: P.presetList(), parts: Object.fromEntries(Object.entries(P.PARTS).map(([k, v]) => [k, { moves: v.moves, sided: !!v.sided }])) };
            case "flip_pose":
                need("previzRigFlipPose", "Flip pose")(model.id);
                return {};
            default:
                throw new Error(`unknown action ${action}`);
        }
    },
};

/** Actions the agent may ask for that work on the scene rather than on one character. */
export const SCENE_ACTIONS = new Set(["layer_add", "layer_list", "constrain", "remove_constraint", "list_constraints",
                                      "bake_constraints", "pose_list", "pose_delete", "pose_presets"]);
