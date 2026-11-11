// imageViewer_previzRigTools.js
// The Rig menu's tools that reach past the page: export (FBX, Alembic), auto-rigging
// (UniRig) and AI motion (Kimodo: in-betweens and motion from text), plus the feet
// clean-up. Mixed into the panel after PrevizRigMixin.
//
// The page does the character's part - it has the meshes, the bones and the rig's
// pose on every frame - and the server writes the files or runs the models
// (src/rig_routes.py). A motion comes back on the model's own skeleton and is put
// on the character here (imageViewer_rigMotion.js), then baked onto its controls,
// so it is edited like any other keys.
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import * as M from "./imageViewer_rigMotion.js";
import { notice, openExportDialog } from "./imageViewer_exportUI.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PrevizRigToolsMixin = {

    // ── Export ────────────────────────────────────────────────────────────

    /** The character's numbers for an export, over frames [first, last] of the shot. */
    previzRigExportData(modelId, first, last) {
        const view = this._modelView();
        if (!view || !view.rigExportData) return null;
        const frames = [];
        for (let f = first; f <= last; f++) frames.push(f);
        return view.rigExportData(modelId, frames);
    },

    /** Export a character: FBX (skeleton, skin, keys on every frame) or Alembic (the meshes baked). */
    async previzExportCharacter(modelId = this.previzRigModelOf(), fmt = "fbx") {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model) { notice("info", "Select a character to export."); return; }
        const last = Math.max(0, (scene.length || 1) - 1);
        let rangeFirst, rangeLast;
        await openExportDialog(this.container, {
            title: fmt === "abc" ? "Export Alembic" : "Export FBX",
            kind: "character",
            name: model.name,
            fixed: fmt === "abc" ? [{ value: "abc", label: "Alembic, baked meshes (.abc)" }]
                                 : [{ value: "fbx", label: "FBX, skeleton + skin + keys (.fbx)" }],
            rows: ({ el, row }) => {
                rangeFirst = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 0, min: 0 });
                rangeLast = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: last, min: 0 });
                return [row("Frames", rangeFirst, el("span", "rd-sub", "to"), rangeLast)];
            },
            note: fmt === "abc" ? "Every mesh of the character as the rig deforms it, one sample per frame."
                                : "The bones keyed on every frame, the meshes skinned to them, in metres (Y up).",
            onExport: async (v, { progress }) => {
                const a = Math.max(0, Math.round(Number(rangeFirst.value) || 0));
                const b = Math.max(a, Math.round(Number(rangeLast.value) || 0));
                progress(0, 2, "Reading the character…");
                const out = await this.previzRigExport(modelId, v.format, { first: a, last: b, name: v.name, context: v.context });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", fmt === "abc" ? "Alembic exported" : "FBX exported", out.relative ? "output/" + out.relative : out.path);
                return { ok: true };
            },
        });
    },

    /** The export without the dialog (the agent's tool and tests use it): { ok, path, relative } or { ok: false, message }. */
    async previzRigExport(modelId, format = "fbx", { first = 0, last = null, name = null, context = null } = {}) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        if (!model) return { ok: false, message: "no such character" };
        const end = last == null ? Math.max(0, (scene.length || 1) - 1) : last;
        const data = this.previzRigExportData(modelId, first, end);
        if (!data) return { ok: false, message: "The character is not loaded." };
        if (format === "fbx" && !data.meta.bones.length) return { ok: false, message: "FBX export needs a skeleton: rig the character first." };
        const meta = { ...data.meta, format, name: name || model.name, fps: scene.fps || 24, context };
        const body = new FormData();
        body.append("meta", new Blob([JSON.stringify(meta)], { type: "application/json" }));
        for (const [k, arr] of Object.entries(data.parts)) body.append(k, new Blob([arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)]), k);
        const res = await fetch(api.apiURL("/imageviewer/rig/export"), { method: "POST", body, headers: { "X-ImageViewer-Rig": "1" } });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, message: `Could not export: ${out.error || res.status}` };
        return out;
    },

    // ── The models ────────────────────────────────────────────────────────

    async _previzRigTools() {
        try {
            const res = await fetch(api.apiURL("/imageviewer/rig/tools"));
            return res.ok ? await res.json() : {};
        } catch {
            return {};
        }
    },

    /** Start a job on the server and wait for it: answers its last state. */
    async _previzRigJob(path, body, { progress, until } = {}) {
        const res = await fetch(api.apiURL(path), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        let job = await res.json().catch(() => ({}));
        if (!res.ok) return { state: "error", error: job.error || `HTTP ${res.status}` };
        this._previzRigRunning = job.job;
        let n = 0;
        while (job.state === "running") {
            await sleep(Math.min(1500, 300 + n++ * 150));
            if (until && until()) {
                await fetch(api.apiURL("/imageviewer/rig/job"), {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job: job.job, cancel: true }),
                }).catch(() => {});
            }
            const r = await fetch(api.apiURL(`/imageviewer/rig/job?job=${encodeURIComponent(job.job)}`));
            job = await r.json().catch(() => ({ state: "error", error: `HTTP ${r.status}` }));
            if (progress && job.log && job.log.length) progress(job.log[job.log.length - 1], job.seconds);
        }
        this._previzRigRunning = null;
        return job;
    },

    // ── Setting the tools up ──────────────────────────────────────────────

    /**
     * The Install dialog: sets UniRig and / or Kimodo up on the machine ComfyUI runs on
     * (scripts/rig/install_rig_tools.py, as a server job) and then goes on with `then`.
     * `need` is the tool the user asked for ("unirig" or "kimodo"), or null from the Rig menu.
     */
    async previzRigInstallDialog(tools = null, need = null, then = null) {
        tools = tools || await this._previzRigTools();
        if (!tools.install) { notice("warn", "The character tools cannot be installed from here", "The viewer could not ask the server."); return; }
        const missing = ["unirig", "kimodo"].filter((t) => !(tools[t] && tools[t].ready));
        let folder, both, token;
        const NAMES = { unirig: "auto-rigging (UniRig)", kimodo: "AI motion (Kimodo)" };
        await openExportDialog(this.container, {
            title: "Set up the character tools",
            kind: "character",
            plain: true,
            background: true,
            where: false,
            fixed: [{ value: "install", label: "" }],
            go: tools.install.running ? "Watch the install" : "Install",
            rows: ({ el, row }) => {
                const what = need
                    ? `${NAMES[need][0].toUpperCase()}${NAMES[need].slice(1)} is not set up on this machine yet.`
                    : (missing.length ? `Not set up yet: ${missing.map((t) => NAMES[t]).join(" and ")}.` : "Both are set up; installing again updates them.");
                const rows = [el("div", "rd-hint", what)];
                folder = Object.assign(el("input", "rd-in rd-text"), { value: tools.install.root, spellcheck: false });
                folder.style.width = "100%";
                rows.push(row("Folder", folder));
                const others = missing.filter((t) => t !== need);
                if (need && others.length) {
                    both = Object.assign(el("input"), { type: "checkbox", checked: true });
                    const lb = el("label", "rd-sub"); lb.append(both, ` Also ${NAMES[others[0]]}`);
                    rows.push(row("Tools", lb));
                }
                if (!tools.install.hf_token) {
                    token = Object.assign(el("input", "rd-in rd-text"), { type: "password", placeholder: "hf_…", autocomplete: "off" });
                    token.style.width = "100%";
                    rows.push(row("Hugging Face", token));
                    rows.push(el("div", "rd-hint",
                        "AI motion's text encoder is Meta's Llama 3 8B Instruct, a gated model: ask for access on its Hugging Face "
                        + "page (meta-llama/Meta-Llama-3-8B-Instruct), then paste a read token from huggingface.co/settings/tokens. "
                        + "It is saved where Hugging Face's own tools keep it, on this machine only."));
                }
                return rows;
            },
            note: "Each tool gets its own Python environment in the folder (they need versions of PyTorch that ComfyUI's must not get). "
                + "About 15-20 GB with the models, 20-40 minutes. ComfyUI keeps running and nothing needs a restart; "
                + "closing this window leaves the install running.",
            onExport: async (_v, { progress }) => {
                let job;
                if (tools.install.running) {
                    job = { job: tools.install.running, state: "running" };
                } else {
                    const only = need && !(both && both.checked) ? need
                        : (!need && missing.length === 1 ? missing[0] : null);
                    const res = await fetch(api.apiURL("/imageviewer/rig/install"), {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ root: folder.value.trim(), only, hf_token: token && token.value.trim() || undefined }),
                    });
                    job = await res.json().catch(() => ({}));
                    if (!res.ok) return { ok: false, message: job.error || `HTTP ${res.status}` };
                }
                progress(0.02, 1, "Starting…");
                const out = await this._previzRigInstallWait(job, progress);
                if (out.state !== "done") return { ok: false, message: out.state === "cancelled" ? "Cancelled." : (out.error || out.state) };
                const now = await this._previzRigTools();
                if (need && !(now[need] && now[need].ready)) return { ok: false, message: (now[need] && now[need].why) || "Still not set up." };
                notice("success", "Character tools set up", need ? `${NAMES[need]} is ready.` : "Auto-rigging and AI motion are ready.");
                if (then) setTimeout(() => then(), 0);
                return { ok: true };
            },
        });
    },

    /** Follow an install job: the bar follows the commands it has run, the text its last line. */
    async _previzRigInstallWait(job, progress) {
        let n = 0;
        while (job.state === "running") {
            await sleep(Math.min(2000, 400 + n++ * 200));
            const r = await fetch(api.apiURL(`/imageviewer/rig/job?job=${encodeURIComponent(job.job)}`));
            const next = await r.json().catch(() => null);
            if (!next) continue;           // a missed poll while pip keeps the server busy
            job = next;
            const line = (job.log || []).filter((l) => l.trim()).pop() || "";
            progress(job.share != null ? job.share : 0.5, 1, line.length > 140 ? line.slice(0, 137) + "…" : line);
        }
        return job;
    },

    // ── Auto-rig ──────────────────────────────────────────────────────────

    async previzAutoRigDialog(modelId = this.previzRigModelOf()) {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model) { notice("info", "Select the model to rig."); return; }
        const tools = await this._previzRigTools();
        if (!tools.unirig || !tools.unirig.ready) {
            if (!tools.unirig) { notice("warn", "Auto-rigging is not set up", "The viewer could not ask the server."); return; }
            return this.previzRigInstallDialog(tools, "unirig", () => this.previzAutoRigDialog(modelId));
        }
        let seed, humanoid;
        await openExportDialog(this.container, {
            title: "Auto-rig (UniRig)",
            kind: "character",
            name: model.name,
            go: "Rig",
            fixed: [{ value: "glb", label: "A skinned copy of the model (.glb)" }],
            rows: ({ el, row }) => {
                seed = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 12345 });
                humanoid = Object.assign(el("input"), { type: "checkbox", checked: true });
                const lab = el("label", "rd-sub");
                lab.append(humanoid, " Humanoid controls when it reads as one");
                const rows = [row("Seed", seed, el("span", "rd-sub", "another seed, another skeleton")), row("Controls", lab)];
                if (this.previzHasSkeleton(modelId)) {
                    const n = this._modelView()._entries.get(modelId).bones.size;
                    rows.unshift(el("div", "rd-hint", `${model.name} already has a skeleton (${n} bones). `
                        + "Auto-rigging replaces it with UniRig's; to animate the one it has, use Rig → Add controls instead."));
                }
                return rows;
            },
            note: "UniRig predicts a skeleton and skin weights for any character - people, animals, creatures. It runs on this machine's GPU and takes a minute or two.",
            onExport: async (v, { progress }) => {
                const out = await this.previzAutoRig(modelId, { name: v.name, context: v.context, seed: Number(seed.value) || 12345,
                    humanoid: humanoid.checked, progress: (line) => progress(0.5, 1, line) });
                if (!out.ok) return { ok: false, message: out.message };
                return { ok: true };
            },
        });
    },

    /** Rig a model with UniRig and put the rigged copy in its place, with controls. */
    async previzAutoRig(modelId, { name = null, context = null, seed = 12345, humanoid = true, progress = null } = {}) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        if (!model) return { ok: false, message: "no such model" };
        const job = await this._previzRigJob("/imageviewer/rig/autorig",
            { src: model.src, name: name || model.name, context, seed }, { progress });
        if (job.state !== "done") return { ok: false, message: `Auto-rigging failed: ${job.error || job.state}` };
        this.previzSnapshot("auto-rig");
        model.src = { path: job.result.path, name: job.result.name, format: "glb" };
        await this.previzChanged({ reload: true });
        const view = this._modelView();
        if (view && view.whenLoaded) await view.whenLoaded(30000);
        if (this._rigSkelCache) this._rigSkelCache.delete(modelId);
        if (!this.previzHasSkeleton(modelId)) return { ok: false, message: "The rigged model has no skeleton." };
        const rig = await this.previzRigCharacter(modelId, { humanoid });
        notice("success", "Character rigged", `${rig && rig.humanoid ? "Humanoid" : "FK"} controls on ${model.name}. The rigged model is output/${job.result.relative || job.result.name}.`);
        return { ok: true, path: job.result.path, humanoid: !!(rig && rig.humanoid) };
    },

    // ── AI motion ─────────────────────────────────────────────────────────

    /** What the motion needs to know of a humanoid character: its rest, and its size against the model's. */
    _previzRigMotionRest(modelId) {
        const scene = this.previzScene();
        const group = R.rigGroupOf(scene, modelId);
        if (!group || !group.rig || !group.rig.humanoid) return null;
        const skel = this._previzRigSkeletonCache(modelId);
        if (!skel) return null;
        const rest = M.humanoidRest(skel, group.rig.roles || {});
        return { rest, scale: M.motionScale(rest) };
    },

    /** The frames the rig's controls have keys on, sorted. */
    previzRigKeyedFrames(modelId) {
        const frames = new Set();
        for (const c of R.controlsOf(this.previzScene(), modelId)) {
            for (const p of ["position", "rotation"]) for (const k of S.track(c, p)) frames.add(k.f);
        }
        return [...frames].sort((a, b) => a - b);
    },

    async previzMotionDialog(modelId = this.previzRigModelOf(), mode = "text") {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model) { notice("info", "Select a rigged character."); return; }
        if (!this._previzRigMotionRest(modelId)) {
            notice("info", "AI motion needs humanoid controls", "Rig → Add controls; the character must read as a humanoid (creatures come later).");
            return;
        }
        const tools = await this._previzRigTools();
        if (!tools.kimodo || !tools.kimodo.ready) {
            if (!tools.kimodo) { notice("warn", "AI motion is not set up", "The viewer could not ask the server."); return; }
            return this.previzRigInstallDialog(tools, "kimodo", () => this.previzMotionDialog(modelId, mode));
        }
        const fps = scene.fps || 24;
        const now = Math.round(this.currentFrame || 0);
        const keyed = this.previzRigKeyedFrames(modelId);
        let a = now, b = Math.min(Math.max(now + 1, (scene.length || 1) - 1), now + Math.round(4 * fps));
        if (mode === "inbetween") {
            const before = keyed.filter((f) => f <= now), after = keyed.filter((f) => f > now);
            if (!before.length || !after.length) {
                notice("info", "Put the playhead between two keyed poses", "The in-between fills the frames between the keys before and after it.");
                return;
            }
            a = before[before.length - 1]; b = after[0];
        }
        let prompt, from, to, seed, feet, start;
        await openExportDialog(this.container, {
            title: mode === "inbetween" ? "AI in-between (Kimodo)" : "Motion from text (Kimodo)",
            kind: "character",
            where: false,
            name: model.name,
            go: "Generate",
            fixed: [{ value: tools.kimodo.model, label: tools.kimodo.model }],
            rows: ({ el, row }) => {
                prompt = Object.assign(el("textarea", "rd-in rd-text"), { rows: 3, spellcheck: true,
                    placeholder: mode === "inbetween" ? "Optional: how it moves between the poses (a person walks, then turns)" : "A person walks forward, stops and waves." });
                prompt.style.width = "100%";
                from = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: a, min: 0 });
                to = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: b, min: 0 });
                seed = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: "", placeholder: "random" });
                feet = Object.assign(el("input"), { type: "checkbox", checked: true });
                const lf = el("label", "rd-sub"); lf.append(feet, " Pin the feet where they stand, keep them above the floor");
                const rows = [row("Motion", prompt), row("Frames", from, el("span", "rd-sub", "to"), to), row("Seed", seed), row("Feet", lf)];
                if (mode === "text") {
                    start = Object.assign(el("input"), { type: "checkbox", checked: true });
                    const ls = el("label", "rd-sub"); ls.append(start, " Start from the pose on the first frame");
                    rows.push(row("Start", ls));
                }
                return rows;
            },
            note: mode === "inbetween"
                ? "Fills the frames between the keyed poses with motion that hits every key in the range. The keys are replaced by the result, keyed on the controls."
                : "Generates the motion and keys it on the controls over the frames, from where the character stands.",
            onExport: async (v, { progress }) => {
                const out = await this.previzRigGenerateMotion(modelId, {
                    mode, prompt: prompt.value, from: Number(from.value), to: Number(to.value),
                    seed: seed.value === "" ? null : Number(seed.value), feet: feet.checked, fromPose: !start || start.checked,
                    progress: (line) => progress(0.5, 1, line),
                });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", mode === "inbetween" ? "In-between generated" : "Motion generated",
                    `${out.frames} frames keyed on ${model.name} (${out.keys} keys).`);
                return { ok: true };
            },
        });
    },

    /**
     * Generate a motion and key it on the character's controls over [from, to].
     * mode "inbetween": the keyed poses in the range are the model's constraints and
     * the frames between the first and last are replaced; "text": from the prompt
     * alone, starting where (and, with fromPose, as) the character is at `from`.
     */
    async previzRigGenerateMotion(modelId, { mode = "text", prompt = "", from = 0, to = 48, seed = null, feet = true,
                                             fromPose = true, progress = null, samples = 1, sample = 0 } = {}) {
        const scene = this.previzScene();
        const info = this._previzRigMotionRest(modelId);
        if (!info) return { ok: false, message: "The character needs humanoid controls." };
        const { rest, scale } = info;
        const fps = scene.fps || 24;
        from = Math.max(0, Math.round(from)); to = Math.max(from + 1, Math.round(to));
        const view = this._modelView();
        let keys = [], origin, heading = 0, frames;
        if (mode === "inbetween") {
            const keyed = this.previzRigKeyedFrames(modelId).filter((f) => f >= from && f <= to);
            if (keyed.length < 2) return { ok: false, message: "An in-between needs two keyed poses in the range." };
            from = keyed[0]; to = keyed[keyed.length - 1];
            const k = M.inbetweenKeys(view.rigPosesAt(modelId, keyed), rest, scale, fps);
            ({ keys, origin, heading, frames } = k);
        } else {
            const [p0] = view.rigPosesAt(modelId, [from]);
            const h = p0.pose.get(rest.roles.hips);
            origin = [h[12], h[14]];
            const k0 = M.poseToSoma(p0.pose, rest, scale, origin);
            heading = M.headingOf(k0);
            if (fromPose) keys = [{ frame: 0, ...k0 }];
            frames = Math.max(8, Math.round((to - from) / fps * M.MOTION_FPS) + 1);
        }
        const job = await this._previzRigJob("/imageviewer/rig/motion", {
            mode, prompt: String(prompt || "").trim() || (mode === "inbetween" ? "A person moves naturally." : ""),
            frames, keys, seed, samples, heading,
        }, { progress });
        if (job.state !== "done") return { ok: false, message: `The motion was not generated: ${job.error || job.state}` };
        return this.previzRigApplyMotion(modelId, job.result, { from, to, origin, feet, sample, mode });
    },

    /** Put a motion from the model onto the character and key it on its controls. */
    previzRigApplyMotion(modelId, motion, { from, to, origin = [0, 0], feet = true, sample = 0, mode = "text" } = {}) {
        const scene = this.previzScene();
        const info = this._previzRigMotionRest(modelId);
        if (!info || !motion || !motion.samples || !motion.samples[sample]) return { ok: false, message: "No motion to apply." };
        const { rest, scale } = info;
        const fps = scene.fps || 24;
        const index = new Map(motion.joints.map((n, i) => [n, i]));
        const count = to - from + 1;
        const frames = M.resample(motion.samples[sample], fps, from, count).map((fr) => ({
            f: fr.f, contacts: fr.contacts, pose: M.somaToPose(fr.rot, fr.root, index, rest, scale, origin),
        }));
        if (feet) M.cleanFeet(frames, rest);
        // An in-between keeps the keys it was made between; what is between them is the model's.
        const bake = mode === "inbetween" ? frames.filter((fr) => fr.f > from && fr.f < to) : frames;
        if (scene.length < to + 1) { scene.length = to + 1; scene.lengthSet = true; }
        const keys = this.previzRigBakePoses(modelId, bake, { label: mode === "inbetween" ? "AI in-between" : "AI motion", moveCog: true, ikfk: 0 });
        return { ok: true, frames: bake.length, keys };
    },

    // ── The agent ─────────────────────────────────────────────────────────

    /** The model item an agent names (id or name), else the selected one, else the scene's only one. */
    _previzRigFind(which) {
        const scene = this.previzScene();
        const models = ((scene && scene.items) || []).filter((it) => it.kind === "model");
        if (which) {
            const w = String(which).toLowerCase();
            return models.find((m) => m.id === which) || models.find((m) => String(m.name || "").toLowerCase() === w) || null;
        }
        const sel = this.previzRigModelOf && this.previzRigModelOf();
        return (sel && models.find((m) => m.id === sel)) || (models.length === 1 ? models[0] : null);
    },

    /** A request from rig_routes' /imageviewer/rig/agent: { id, action, args }. Reported to /rig/agent_done. */
    async previzRigAgentRun(req) {
        if (!req || !req.id) return;
        // One page answers: the one whose 3D scene is up (every open page gets the message).
        if (!this._modelMode || !this.isPrevizTab || !this.isPrevizTab()) return;
        const report = (body) => fetch(api.apiURL("/imageviewer/rig/agent_done"), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: req.id, ...body }),
        }).catch(() => {});
        const a = req.args || {};
        try {
            const model = this._previzRigFind(a.model);
            if (!model) throw new Error(a.model ? `no model named ${a.model} in the 3D scene` : "name the model (more than one in the scene, none selected)");
            await report({ state: "running" });
            const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
            const scene = this.previzScene();
            const end = Math.max(0, (scene.length || 1) - 1);
            let result;
            switch (req.action) {
                case "rig": {
                    const rig = await this.previzRigCharacter(model.id, { humanoid: a.humanoid !== false });
                    if (!rig) throw new Error("the model has no skeleton: use action autorig");
                    result = { humanoid: !!rig.humanoid, missing: rig.missing || [] };
                    break;
                }
                case "remove_rig": this.previzRemoveRig(model.id); result = {}; break;
                case "autorig": result = await this.previzAutoRig(model.id, { seed: num(a.seed, 12345), humanoid: a.humanoid !== false }); break;
                case "motion":
                case "inbetween":
                    result = await this.previzRigGenerateMotion(model.id, {
                        mode: req.action === "motion" ? "text" : "inbetween", prompt: a.prompt || "",
                        from: num(a.from, req.action === "motion" ? Math.round(this.currentFrame || 0) : 0),
                        to: num(a.to, end), seed: a.seed == null ? null : Number(a.seed), feet: a.feet !== false,
                        fromPose: a.from_pose !== false,
                    });
                    break;
                case "clean_feet": result = this.previzRigCleanFeet(model.id, { from: a.from == null ? null : num(a.from), to: a.to == null ? null : num(a.to) }); break;
                case "export":
                    result = await this.previzRigExport(model.id, a.format === "abc" ? "abc" : "fbx",
                        { first: num(a.from, 0), last: num(a.to, end), name: a.name || null });
                    break;
                default: throw new Error(`unknown action ${req.action}`);
            }
            if (result && result.ok === false) throw new Error(result.message || "it did not work");
            await report({ state: "done", result: { model: model.name, ...(result || {}) } });
        } catch (e) {
            await report({ state: "error", error: String((e && e.message) || e) });
        }
    },

    // ── Feet ──────────────────────────────────────────────────────────────

    /** Pin the standing feet and keep them out of the floor, over the shot (or [from, to]), re-keyed. */
    previzRigCleanFeet(modelId = this.previzRigModelOf(), { from = null, to = null } = {}) {
        const scene = this.previzScene();
        const info = this._previzRigMotionRest(modelId);
        if (!info) { notice("info", "Cleaning the feet needs humanoid controls."); return { ok: false }; }
        const keyed = this.previzRigKeyedFrames(modelId);
        const a = from != null ? from : (keyed.length ? keyed[0] : 0);
        const b = to != null ? to : (keyed.length ? keyed[keyed.length - 1] : (scene.length || 1) - 1);
        if (b - a < 2) { notice("info", "There is no motion to clean: key a few frames first."); return { ok: false }; }
        const list = [];
        for (let f = a; f <= b; f++) list.push(f);
        const frames = this._modelView().rigPosesAt(modelId, list);
        const report = M.cleanFeet(frames, info.rest);
        if (!report.pinned && !report.lifted) { notice("info", "The feet were already clean."); return { ok: true, ...report, keys: 0 }; }
        const keys = this.previzRigBakePoses(modelId, frames, { label: "clean feet", moveCog: true, ikfk: 0 });
        notice("success", "Feet cleaned", `${report.pinned} frames pinned, ${report.lifted} lifted out of the floor.`);
        return { ok: true, ...report, keys };
    },
};
