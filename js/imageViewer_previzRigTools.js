// imageViewer_previzRigTools.js
// The Rig menu's tools that reach past the page: export (FBX, USD, Alembic), auto-rigging
// (UniRig or SkinTokens) and AI motion (Kimodo: in-betweens and motion from text), plus the feet
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
import { showInstallLog } from "./imageViewer_installLog.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The auto-riggers: the server's engine name, the label, the dialog's line about it. */
export const AUTORIG_ENGINES = {
    skintokens: { label: "SkinTokens", hint: "UniRig's successor: skeleton and skin weights from one model, cleaner weights. Needs an NVIDIA GPU with 14 GB." },
    unirig: { label: "UniRig", hint: "Skeleton, then skin weights. Runs on about 8 GB, and on a Mac." },
};
const ENGINE_KEY = "imageviewer.viewer.autorigEngine";

/** The engine to offer first: the one chosen last if it is set up, else SkinTokens if it is, else UniRig. */
export function pickAutorigEngine(tools, remembered) {
    const ready = (e) => !!(tools && tools[e] && tools[e].ready);
    if (remembered && AUTORIG_ENGINES[remembered] && ready(remembered)) return remembered;
    if (ready("skintokens")) return "skintokens";
    if (ready("unirig")) return "unirig";
    return remembered && AUTORIG_ENGINES[remembered] ? remembered : "unirig";
}

function rememberedEngine() {
    try { return localStorage.getItem(ENGINE_KEY); } catch (_) { return null; }
}

function rememberEngine(engine) {
    try { localStorage.setItem(ENGINE_KEY, engine); } catch (_) { /* private window */ }
}

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

    /**
     * Export a character: FBX or USD (skeleton, skin, keys on every frame - what Maya, Blender
     * and Unreal read) or Alembic (the meshes baked). FBX and USD also carry the viewer's rig,
     * live, for the way back (imageViewer_previzRigRoundTrip.js).
     */
    async previzExportCharacter(modelId = this.previzRigModelOf(), fmt = "fbx") {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model) { notice("info", "Select a character to export."); return; }
        const last = Math.max(0, (scene.length || 1) - 1);
        const rigged = R.isRigged(scene, modelId);
        let rangeFirst, rangeLast, keep;
        const FIXED = {
            abc: [{ value: "abc", label: "Alembic, baked meshes (.abc)" }],
            fbx: [{ value: "fbx", label: "FBX, skeleton + skin + keys (.fbx)" }],
            usd: [{ value: "usd", label: "USD, UsdSkel skeleton + skin + keys (.usd)" }],
        };
        await openExportDialog(this.container, {
            title: { abc: "Export Alembic", fbx: "Export FBX", usd: "Export USD" }[fmt] || "Export FBX",
            kind: "character",
            name: model.name,
            fixed: FIXED[fmt] || FIXED.fbx,
            rows: ({ el, row }) => {
                rangeFirst = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 0, min: 0 });
                rangeLast = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: last, min: 0 });
                const rows = [row("Frames", rangeFirst, el("span", "rd-sub", "to"), rangeLast)];
                if (fmt !== "abc") {
                    keep = Object.assign(el("input"), { type: "checkbox", checked: rigged, disabled: !rigged });
                    const lab = el("label", "rd-sub");
                    lab.append(keep, document.createTextNode(rigged ? " Keep the rig in the file, for bringing it back here"
                                                                    : " (no rig on this character: only the motion goes)"));
                    rows.push(row("Viewer rig", lab));
                }
                return rows;
            },
            note: fmt === "abc" ? "Every mesh of the character as the rig deforms it, one sample per frame."
                : (fmt === "usd" ? "UsdSkel, in metres (Y up), time codes = frames. " : "The bones keyed on every frame, the meshes skinned to them, in metres (Y up). ")
                  + "Other applications get the motion baked (layers and constraints included); the viewer's rig rides along unchanged.",
            onExport: async (v, { progress }) => {
                const a = Math.max(0, Math.round(Number(rangeFirst.value) || 0));
                const b = Math.max(a, Math.round(Number(rangeLast.value) || 0));
                progress(0, 2, "Reading the character…");
                const out = await this.previzRigExport(modelId, v.format, { first: a, last: b, name: v.name, context: v.context,
                                                                          live: !!(keep && keep.checked) });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", { abc: "Alembic exported", usd: "USD exported" }[fmt] || "FBX exported",
                       out.relative ? "output/" + out.relative : out.path);
                return { ok: true };
            },
        });
    },

    /** The export without the dialog (the agent's tool and tests use it): { ok, path, relative } or { ok: false, message }. */
    async previzRigExport(modelId, format = "fbx", { first = 0, last = null, name = null, context = null, live = true } = {}) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        if (!model) return { ok: false, message: "no such character" };
        const end = last == null ? Math.max(0, (scene.length || 1) - 1) : last;
        const data = this.previzRigExportData(modelId, first, end);
        if (!data) return { ok: false, message: "The character is not loaded." };
        if (format !== "abc" && !data.meta.bones.length) return { ok: false, message: `${format.toUpperCase()} export needs a skeleton: rig the character first.` };
        const meta = { ...data.meta, format, name: name || model.name, fps: scene.fps || 24, context };
        if (live && format !== "abc" && this.previzRigLivePayload) {
            const rig = this.previzRigLivePayload(modelId, data);
            if (rig) meta.live = rig;
        }
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
        const missing = ["unirig", "skintokens", "kimodo", "posetrack"].filter((t) => tools[t] && !tools[t].ready);
        let folder, both, token;
        const NAMES = { unirig: "auto-rigging (UniRig)", skintokens: "auto-rigging (SkinTokens, 14 GB GPU)",
            kimodo: "AI motion (Kimodo)", posetrack: "motion from video (MediaPipe pose)" };
        await openExportDialog(this.container, {
            title: "Install AI rigging / motion models",
            kind: "character",
            plain: true,
            background: true,
            where: false,
            fixed: [{ value: "install", label: "" }],
            go: tools.install.running ? "Watch the install" : "Install",
            rows: ({ el, row }) => {
                const what = need
                    ? `${NAMES[need][0].toUpperCase()}${NAMES[need].slice(1)} is not set up on this machine yet.`
                    : (missing.length ? `Not set up yet: ${missing.map((t) => NAMES[t]).join(" and ")}.` : "All are set up; installing again updates them.");
                const rows = [el("div", "rd-hint", what)];
                folder = Object.assign(el("input", "rd-in rd-text"), { value: tools.install.root, spellcheck: false });
                folder.style.width = "100%";
                rows.push(row("Folder", folder));
                const others = missing.filter((t) => t !== need);
                if (need && others.length) {
                    both = Object.assign(el("input"), { type: "checkbox", checked: true });
                    const lb = el("label", "rd-sub"); lb.append(both, ` Also ${others.map((t) => NAMES[t]).join(" and ")}`);
                    rows.push(row("Tools", lb));
                }
                if (!tools.install.hf_token) {
                    token = Object.assign(el("input", "rd-in rd-text"), { type: "password", placeholder: "hf_…", autocomplete: "off" });
                    token.style.width = "100%";
                    rows.push(row("Hugging Face", token));
                    rows.push(el("div", "rd-hint",
                        "AI motion's text encoder is Meta's Llama 3 8B Instruct. With a read token from huggingface.co/settings/tokens "
                        + "whose account has access to meta-llama/Meta-Llama-3-8B-Instruct it comes from Meta; without that access "
                        + "(or a token) from NousResearch's ungated copy of the same weights. "
                        + "The token is saved where Hugging Face's own tools keep it, on this machine only."));
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
                showInstallLog(job.job, { host: this.container });   // the live log of pip / git / the downloads
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
        if (!tools.unirig) { notice("warn", "Auto-rigging is not set up", "The viewer could not ask the server."); return; }
        const anyReady = Object.keys(AUTORIG_ENGINES).some((e) => tools[e] && tools[e].ready);
        if (!anyReady) return this.previzRigInstallDialog(tools, "unirig", () => this.previzAutoRigDialog(modelId));
        const hasSkel = this.previzHasSkeleton(modelId);
        let seed, humanoid, engine, keep, keepRow, hint, skelHint;
        const first = pickAutorigEngine(tools, rememberedEngine());
        await openExportDialog(this.container, {
            title: "Auto-rig",
            kind: "character",
            name: model.name,
            go: "Rig",
            fixed: [{ value: "glb", label: "A skinned copy of the model (.glb)" }],
            rows: ({ el, row }) => {
                engine = el("select", "rd-in rig-engine");
                for (const [value, e] of Object.entries(AUTORIG_ENGINES)) {
                    const ready = tools[value] && tools[value].ready;
                    const o = Object.assign(el("option"), { value, textContent: ready ? e.label : `${e.label} (not set up: choose it to set it up)` });
                    engine.append(o);
                }
                engine.value = first;
                hint = el("span", "rd-sub", "");
                seed = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: 12345 });
                humanoid = Object.assign(el("input"), { type: "checkbox", checked: true });
                const lab = el("label", "rd-sub");
                lab.append(humanoid, " Humanoid controls when it reads as one");
                const rows = [row("Engine", engine, hint), row("Seed", seed, el("span", "rd-sub", "another seed, another skeleton")), row("Controls", lab)];
                if (hasSkel) {
                    const n = this._modelView()._entries.get(modelId).bones.size;
                    keep = Object.assign(el("input"), { type: "checkbox", checked: false });
                    const kl = el("label", "rd-sub");
                    kl.append(keep, " Keep its skeleton: new skin weights only");
                    keepRow = row("Skeleton", kl);
                    rows.splice(1, 0, keepRow);
                    skelHint = el("div", "rd-hint", "");
                    rows.unshift(skelHint);
                    skelHint.dataset.bones = String(n);
                }
                const sync = () => {
                    const e = engine.value;
                    hint.textContent = AUTORIG_ENGINES[e].hint;
                    if (keepRow) {
                        keepRow.style.display = e === "skintokens" ? "" : "none";
                        if (e !== "skintokens") keep.checked = false;
                        const n = skelHint.dataset.bones;
                        skelHint.textContent = keep.checked
                            ? `${model.name}'s skeleton (${n} bones) stays; SkinTokens weights the mesh to it.`
                            : `${model.name} already has a skeleton (${n} bones). Auto-rigging replaces it with ${AUTORIG_ENGINES[e].label}'s`
                              + (e === "skintokens" ? " unless you keep it below" : "; to animate the one it has, use Rig → Add controls instead") + ".";
                    }
                };
                engine.addEventListener("change", sync);
                if (keep) keep.addEventListener("change", sync);
                sync();
                return rows;
            },
            note: "Auto-rigging predicts a skeleton and skin weights for any character - people, animals, creatures. It runs on this machine's GPU and takes a minute or two.",
            onExport: async (v, { progress }) => {
                const e = engine.value;
                if (!(tools[e] && tools[e].ready)) {
                    setTimeout(() => this.previzRigInstallDialog(tools, e, () => this.previzAutoRigDialog(modelId)), 0);
                    return { ok: true };
                }
                rememberEngine(e);
                const out = await this.previzAutoRig(modelId, { name: v.name, context: v.context, seed: Number(seed.value) || 12345,
                    humanoid: humanoid.checked, engine: e, keepSkeleton: !!(keep && keep.checked),
                    progress: (line) => progress(0.5, 1, line) });
                if (!out.ok) return { ok: false, message: out.message };
                return { ok: true };
            },
        });
    },

    /** Rig a model with UniRig or SkinTokens and put the rigged copy in its place, with controls.
     * `engine` null = the one the dialog would offer first; `keepSkeleton` (SkinTokens) = skin weights only. */
    async previzAutoRig(modelId, { name = null, context = null, seed = 12345, humanoid = true, progress = null,
        engine = null, keepSkeleton = false } = {}) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        if (!model) return { ok: false, message: "no such model" };
        if (!engine) engine = pickAutorigEngine(await this._previzRigTools(), rememberedEngine());
        if (!AUTORIG_ENGINES[engine]) return { ok: false, message: `engine is ${Object.keys(AUTORIG_ENGINES).join(" or ")}` };
        if (keepSkeleton && engine !== "skintokens") return { ok: false, message: "only SkinTokens keeps the model's own skeleton" };
        if (keepSkeleton && !this.previzHasSkeleton(modelId)) return { ok: false, message: "the model has no skeleton to keep" };
        const job = await this._previzRigJob("/imageviewer/rig/autorig",
            { src: model.src, name: name || model.name, context, seed, engine, keep_skeleton: !!keepSkeleton }, { progress });
        if (job.state !== "done") return { ok: false, message: `Auto-rigging failed: ${job.error || job.state}` };
        this.previzSnapshot("auto-rig");
        model.src = { path: job.result.path, name: job.result.name, format: "glb" };
        await this.previzChanged({ reload: true });
        const view = this._modelView();
        if (view && view.whenLoaded) await view.whenLoaded(30000);
        if (this._rigSkelCache) this._rigSkelCache.delete(modelId);
        if (!this.previzHasSkeleton(modelId)) return { ok: false, message: "The rigged model has no skeleton." };
        const rig = await this.previzRigCharacter(modelId, { humanoid });
        const by = AUTORIG_ENGINES[job.result.engine || engine].label;
        notice("success", "Character rigged", `${by}: ${rig && rig.humanoid ? "humanoid" : "FK"} controls on ${model.name}. The rigged model is output/${job.result.relative || job.result.name}.`);
        return { ok: true, path: job.result.path, humanoid: !!(rig && rig.humanoid), engine: job.result.engine || engine };
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
            // Poses keyed on any animation layer (an AI take lies on a layer of its own).
            const sets = [c.tracks, ...Object.values(c.layerTracks || {})];
            for (const set of sets) for (const p of ["position", "rotation"]) for (const k of (set && set[p]) || []) frames.add(k.f);
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
        let prompt, from, to, seed, feet, start, onLayer, asClip;
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
                if (this.previzLayersAvailable && this.previzLayersAvailable()) rows.push(row("Layer", (onLayer = this._previzLayerBox(el, true)).label));
                if (mode === "text") {
                    start = Object.assign(el("input"), { type: "checkbox", checked: true });
                    const ls = el("label", "rd-sub"); ls.append(start, " Start from the pose on the first frame");
                    rows.push(row("Start", ls));
                    // A take as a clip of the Clip Sequencer (imageViewer_previzClips.js) instead of keys.
                    asClip = Object.assign(el("input"), { type: "checkbox", checked: !!this._rigTakeAsClip });
                    const lc = el("label", "rd-sub"); lc.append(asClip, " Land as a clip in the Clip Sequencer (each take a clip you can blend, loop and compare)");
                    rows.push(row("Take", lc));
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
                    layer: onLayer && onLayer.box.checked ? "new" : null,
                    asClip: !!(asClip && asClip.checked),
                    progress: (line) => progress(0.5, 1, line),
                });
                if (!out.ok) return { ok: false, message: out.message };
                if (asClip) this._rigTakeAsClip = asClip.checked;
                notice("success", mode === "inbetween" ? "In-between generated" : "Motion generated",
                    out.clip ? `${out.frames} frames, a clip on the Clip Sequencer's “${out.clip}” track.`
                             : `${out.frames} frames keyed on ${model.name} (${out.keys} keys).`);
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
                                             fromPose = true, progress = null, samples = 1, sample = 0, layer = null, asClip = false } = {}) {
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
        return this.previzRigApplyMotion(modelId, job.result, { from, to, origin, feet, sample, mode, layer,
            asClip: asClip && mode === "text", name: String(prompt || "").trim() });
    },

    /** Put a motion from the model onto the character and key it on its controls (or, with asClip, as a clip of the Clip Sequencer). */
    previzRigApplyMotion(modelId, motion, { from, to, origin = [0, 0], feet = true, sample = 0, mode = "text",
                                           layer = null, keepEnds = mode === "inbetween", label = null, asClip = false, name = "" } = {}) {
        const scene = this.previzScene();
        const info = this._previzRigMotionRest(modelId);
        if (!info || !motion || !motion.samples || !motion.samples[sample]) return { ok: false, message: "No motion to apply." };
        const { rest, scale } = info;
        const fps = scene.fps || 24;
        const index = new Map(motion.joints.map((n, i) => [n, i]));
        const count = to - from + 1;
        const frames = M.resample(motion.samples[sample], fps, from, count, motion.fps || M.MOTION_FPS).map((fr) => ({
            f: fr.f, contacts: fr.contacts, pose: M.somaToPose(fr.rot, fr.root, index, rest, scale, origin),
        }));
        if (feet) M.cleanFeet(frames, rest);
        // An in-between keeps the keys it was made between; what is between them is the model's.
        const bake = keepEnds ? frames.filter((fr) => fr.f > from && fr.f < to) : frames;
        if (!bake.length) return { ok: false, message: "No frames to key between those poses." };
        if (scene.length < to + 1) { scene.length = to + 1; scene.lengthSet = true; }
        const what = label || (mode === "inbetween" ? "AI in-between" : "AI motion");
        // A take that lands as a clip: the controls' own keys are put back after it is taken off them.
        const saved = asClip && this.previzClipsLandTake
            ? new Map(R.controlsOf(scene, modelId).map((c) => [c.id, JSON.parse(JSON.stringify(c.tracks || {}))])) : null;
        if (saved) {
            const keys = this.previzRigBakePoses(modelId, bake, { label: what, moveCog: true, ikfk: 0 });
            const words = name.length > 28 ? `${name.slice(0, 27)}\u2026` : name;
            const c = this.previzClipsLandTake(modelId, from, to, saved, `AI: ${words || "motion"}${sample ? ` #${sample + 1}` : ""}`);
            const q = scene.sequencer;
            const t = c && q && q.tracks.find((tr) => tr.clips.includes(c));
            return { ok: true, frames: bake.length, keys, clip: t ? t.name : "AI takes" };
        }
        // On an animation layer of its own when asked (and the scene has layers): the keys under it stay.
        const { keys, layer: onLayer } = this._previzRigBakeInto
            ? this._previzRigBakeInto(modelId, bake, { label: what, moveCog: true, ikfk: 0 }, layer)
            : { keys: this.previzRigBakePoses(modelId, bake, { label: what, moveCog: true, ikfk: 0 }), layer: null };
        // A new layer for the take weighs 1 over the frames it covers and 0 outside
        // them: an override layer would hold the take's end pose for ever otherwise.
        const L = layer === "new" && onLayer && (scene.animLayers || []).find((l) => l.id === onLayer);
        if (L) {
            const lo = bake[0].f, hi = bake[bake.length - 1].f;
            L.tracks = { ...(L.tracks || {}), weight: [{ f: lo - 1, v: 0, ease: "hold" }, { f: lo, v: 1, ease: "hold" }, { f: hi + 1, v: 0, ease: "hold" }] };
            this.previzLayersChanged?.();
        }
        return { ok: true, frames: bake.length, keys, layer: onLayer };
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
            const sceneWide = this.previzRigSceneAction && this.previzRigSceneAction(req.action);
            if (!model && !sceneWide) throw new Error(a.model ? `no model named ${a.model} in the 3D scene` : "name the model (more than one in the scene, none selected)");
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
                case "autorig": result = await this.previzAutoRig(model.id, { seed: num(a.seed, 12345), humanoid: a.humanoid !== false,
                    engine: a.engine || null, keepSkeleton: !!a.keep_skeleton }); break;
                case "motion":
                case "inbetween":
                    result = await this.previzRigGenerateMotion(model.id, {
                        mode: req.action === "motion" ? "text" : "inbetween", prompt: a.prompt || "",
                        from: num(a.from, req.action === "motion" ? Math.round(this.currentFrame || 0) : 0),
                        to: num(a.to, end), seed: a.seed == null ? null : Number(a.seed), feet: a.feet !== false,
                        fromPose: a.from_pose !== false, asClip: !!a.as_clip,
                    });
                    break;
                case "clean_feet": result = this.previzRigCleanFeet(model.id, { from: a.from == null ? null : num(a.from), to: a.to == null ? null : num(a.to) }); break;
                case "export":
                    result = await this.previzRigExport(model.id, ["abc", "usd"].includes(a.format) ? a.format : "fbx",
                        { first: num(a.from, 0), last: num(a.to, end), name: a.name || null, live: a.live !== false });
                    break;
                case "add_motion":
                    if (!a.path) throw new Error("name the file: path");
                    result = await this.previzRigAddMotion(model.id, { path: a.path },
                        { how: ["restore", "bake"].includes(a.how) ? a.how : "auto", start: a.from == null ? null : num(a.from) });
                    break;
                default:
                    if (!this.previzRigAgentExtra) throw new Error(`unknown action ${req.action}`);
                    result = await this.previzRigAgentExtra(req.action, model, a);
            }
            if (result && result.ok === false) throw new Error(result.message || "it did not work");
            await report({ state: "done", result: { ...(model ? { model: model.name } : {}), ...(result || {}) } });
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
