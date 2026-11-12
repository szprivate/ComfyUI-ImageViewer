// imageViewer_previzRigPose.js
// One pose on a humanoid character, keyed on one frame: from named poses ("sit",
// "arms_crossed" ...) and joints described in words (imageViewer_rigPoseSpec.js), from
// a picture of a person (MediaPipe's Pose Landmarker through /imageviewer/rig/video_pose,
// solved by solvePicturePose), or from a prompt through Kimodo (a short motion made from where the character stands,
// its last frame kept). Mixed into the panel after PrevizRigAIMixin; the Rig menu's
// "Pose…" and the agent's `pose` action come here.
import * as M from "./imageViewer_rigMotion.js";
import * as P from "./imageViewer_rigPoseSpec.js";
import { api } from "../../scripts/api.js";
import { notice, openExportDialog } from "./imageViewer_exportUI.js";

const PICTURE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"];

// The parts the dialog can put on the floor (imageViewer_rigPoseFix.js CONTACT_LIMBS).
const FLOOR_PARTS = [["hand.L", "left hand"], ["hand.R", "right hand"], ["knee.L", "left knee"],
                     ["foot.L", "left foot"], ["foot.R", "right foot"], ["knee.R", "right knee"]];

export const PrevizRigPoseMixin = {

    /**
     * Pose the character on `frame` (default the current one) and key it there.
     * { preset: name | [names], joints: { part: { move: degrees } }, hips: { height, offset },
     *   mirror: "L" | "R", ground, contacts, limits, image, landmarks, facing, prompt, seed, layer }.
     * `image` (a picture: {path} or {filename, subfolder, type}) or `landmarks` (its 33
     * MediaPipe world landmarks) takes the pose from the picture; `facing: "picture"` keeps
     * the turn the picture shows; `via` "sam3d" (ComfyUI's SAM 3D Body nodes), "mediapipe" or
     * "auto" (SAM 3D Body when it is there). A prompt is used only when none of those, no preset and no
     * joints are given: then the pose comes from Kimodo. Answers
     * { ok, frame, keys, unknown, layer } or { ok: false, message }.
     */
    async previzRigPose(modelId, { preset = null, joints = null, hips = null, mirror = null, ground = true,
                                   contacts = null, limits = true, image = null, landmarks = null, facing = "keep", via = "auto", fov = 0,
                                   frame = null, prompt = "", seed = null, layer = null, progress = null } = {}) {
        const scene = this.previzScene();
        const info = this._previzRigMotionRest && this._previzRigMotionRest(modelId);
        if (!info) return { ok: false, message: "Posing needs a humanoid character with controls (Rig → Add controls)." };
        const { rest, scale } = info;
        const f = Math.max(0, Math.round(frame == null ? (this.currentFrame || 0) : Number(frame)));
        const [p0] = this._modelView().rigPosesAt(modelId, [f]);
        const h = p0.pose.get(rest.roles.hips);
        const origin = [h[12], h[14]];
        const k0 = M.poseToSoma(p0.pose, rest, scale, origin);
        const model = (scene.items || []).find((it) => it.id === modelId);
        const heading = P.poseBaseHeading(model, M.headingOf(k0));
        let motion, unknown = [], placed = [], used = null;
        const words = String(prompt || "").trim();
        if (image || landmarks) {
            let lm = landmarks;
            used = landmarks ? "landmarks" : null;
            if (!lm) {
                const got = await this._previzRigPictureLandmarks(image, { via, fov, progress });
                if (!got.ok) return got;
                lm = got.landmarks; used = got.via;
            }
            const r = P.resolvePose({ contacts });
            let solved;
            try {
                solved = P.solvePicturePose(lm, { heading, facing, ground, limits, contacts: r.contacts });
            } catch (e) {
                return { ok: false, message: String(e.message || e) };
            }
            motion = P.poseMotion(solved);
            placed = solved.contacts;
            unknown = (solved.unknownContacts || []).map((c) => `contact ${c}`);
        } else if (words && !preset && !(joints && Object.keys(joints).length)) {
            motion = await this._previzRigPoseFromPrompt(words, { k0, heading, seed, progress });
            if (!motion.samples) return { ok: false, message: motion.message };
        } else {
            const r = P.resolvePose({ preset, joints, hips, mirror, contacts });
            unknown = r.unknown;
            if (!Object.keys(r.parts).length && !(preset && [].concat(preset).some((p) => /^t[_\s-]?pose$/i.test(String(p).trim())))) {
                return { ok: false, message: `Nothing to pose${unknown.length ? ` (not understood: ${unknown.join(", ")})` : ""}. `
                    + `Name a preset (${Object.keys(P.PRESETS).join(", ")}) or joints.` };
            }
            const solved = P.solvePoseSpec(r.parts, { heading, ground, hips: r.hips, limits, contacts: r.contacts });
            motion = P.poseMotion(solved);
            placed = solved.contacts;
            unknown = unknown.concat((solved.unknownContacts || []).map((c) => `contact ${c}`));
        }
        if (scene.length < f + 1) { scene.length = f + 1; scene.lengthSet = true; }
        const out = this.previzRigApplyMotion(modelId, motion, { from: f, to: f, origin, feet: false, mode: "pose", label: "Pose", layer });
        if (!out.ok) return out;
        P.rememberPoseBase(model, f, heading, motion);
        this.setFrame?.(f);
        return { ok: true, frame: f, keys: out.keys, layer: out.layer || null, unknown, contacts: placed,
                 ...(used ? { via: used } : {}) };
    },

    /**
     * A picture's person as MediaPipe's 33 world landmarks: through ComfyUI's own SAM 3D Body nodes
     * (a graph queued like Paint's Generate, ending in the pack's ImageViewerBodyPose; body_pose.py)
     * or MediaPipe's Pose Landmarker (/imageviewer/rig/video_pose). Answers { ok, landmarks, via } or
     * { ok: false, message }.
     */
    async _previzRigPictureLandmarks(image, { via = "auto", fov = 0, progress = null } = {}) {
        const tools = await this._previzRigTools();
        const sam = tools.sam3dbody && tools.sam3dbody.ready, mp = tools.posetrack && tools.posetrack.ready;
        const use = via === "sam3d" || via === "mediapipe" ? via : sam ? "sam3d" : mp ? "mediapipe" : null;
        if (!use) {
            return { ok: false, message: "A pose from a picture needs SAM 3D Body (its weights in models/detection: the Pose dialog fetches them) "
                + "or the pose tracker (Rig → Install AI rigging / motion models…)." };
        }
        if (use === "mediapipe") {
            if (!mp) return { ok: false, message: `The pose tracker is not set up: ${(tools.posetrack && tools.posetrack.why) || "Rig → Install AI rigging / motion models…"}` };
            const job = await this._previzRigJob("/imageviewer/rig/video_pose", { src: image }, { progress });
            if (job.state !== "done") return { ok: false, message: `The picture was not read: ${job.error || job.state}` };
            const fr = (job.result.frames || [])[0];
            if (!fr || !fr.world) return { ok: false, message: "No person was found in the picture." };
            return { ok: true, landmarks: fr.world, via: "mediapipe" };
        }
        if (progress) progress("Reading the picture with SAM 3D Body…");
        const res = await fetch(api.apiURL("/imageviewer/rig/body_pose"), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ src: image, fov }),
        });
        const prep = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, message: prep.error || `HTTP ${res.status}` };
        let answer;
        try {
            const id = await this._paintQueue(prep.graph);
            answer = await this._paintWait(id, prep.output, {
                pick: (out) => (out && out.imageviewer_body && out.imageviewer_body[0]) || null,
                node: () => { if (progress) progress("SAM 3D Body is running…"); },
            });
        } catch (e) {
            return { ok: false, message: `SAM 3D Body did not run: ${e.message || e}` };
        }
        const person = answer && answer.people && answer.people[0];
        if (!person) return { ok: false, message: "SAM 3D Body found no person in the picture." };
        return { ok: true, landmarks: person.landmarks, via: "sam3d" };
    },

    /** Fetch SAM 3D Body's weights into models/detection; `say(text)` hears how far. Answers true when they are there. */
    async previzRigGetSam3dBody(say = () => {}) {
        const post = async (body) => {
            const r = await fetch(api.apiURL("/imageviewer/rig/body_pose_download"), {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            return j;
        };
        try {
            const start = await post({});
            if (!start.job) return true;
            for (;;) {
                await new Promise((r) => setTimeout(r, 1000));
                const st = await post({ job: start.job });
                const f = (st.files || [])[0] || {};
                const mb = (n) => `${Math.round((n || 0) / 1e6)} MB`;
                say(st.state === "running" ? `Downloading ${f.name || "the weights"}: ${mb(f.done)}${f.size ? ` of ${mb(f.size)}` : ""}` : st.state);
                if (st.state === "done") return true;
                if (st.state !== "running") { say(`The download ${st.state}: ${st.error || ""}`); return false; }
            }
        } catch (e) {
            say(`The download failed: ${e.message || e}`);
            return false;
        }
    },

    /** Kimodo makes about two seconds from where the character stands; its last frame, in place, is the pose. */
    async _previzRigPoseFromPrompt(prompt, { k0, heading, seed, progress }) {
        const tools = await this._previzRigTools();
        if (!tools.kimodo || !tools.kimodo.ready) return { message: "A pose from a prompt needs Kimodo (Rig → Install AI rigging / motion models…); name a preset or joints instead." };
        const frames = 2 * M.MOTION_FPS + 1;
        const job = await this._previzRigJob("/imageviewer/rig/motion", {
            mode: "text", prompt: `${prompt.replace(/[.\s]+$/, "")}, then holds still.`,
            frames, keys: [{ frame: 0, ...k0 }], seed, samples: 1, heading,
        }, { progress });
        if (job.state !== "done") return { message: `The pose was not made: ${job.error || job.state}` };
        const m = job.result, s = m.samples && m.samples[0];
        if (!s || !s.rot.length) return { message: "Kimodo answered no motion." };
        const last = s.rot.length - 1;
        const root = s.root[last];
        // Where the first frame stood, so the character does not walk off.
        return { fps: m.fps, joints: m.joints, samples: [{ rot: [s.rot[last]], root: [[s.root[0][0], root[1], s.root[0][2]]], contacts: null }] };
    },

    /** The Rig menu's Pose…: named poses ticked, a few words for Kimodo, the frame, a layer. */
    async previzPoseDialog(modelId = this.previzRigModelOf()) {
        if (!modelId || !this._previzRigMotionRest(modelId)) {
            notice("info", "Posing needs humanoid controls", "Rig → Add controls; the character must read as a humanoid.");
            return;
        }
        const tools = await this._previzRigTools();
        const kimodo = !!(tools.kimodo && tools.kimodo.ready);
        let boxes = [], prompt, at, onLayer, floor = [], limitBox, picture, facePic;
        const sam = tools.sam3dbody || {};
        const tracker = !!((tools.posetrack && tools.posetrack.ready) || sam.ready);
        let viaSel;
        await openExportDialog(this.container, {
            title: "Pose the character", kind: "character", where: false, name: "pose", go: "Pose",
            rows: ({ el, row }) => {
                const grid = el("div", "rd-sub");
                grid.style.cssText = "display:grid;grid-template-columns:repeat(3,auto);gap:2px 12px";
                boxes = P.presetList().map(({ name, note }) => {
                    const b = Object.assign(el("input"), { type: "checkbox" });
                    const l = el("label", "rd-sub"); l.title = note; l.append(b, ` ${name.replace(/_/g, " ")}`);
                    grid.append(l);
                    return { name, b };
                });
                prompt = Object.assign(el("input", "rd-in"), { type: "text", disabled: !kimodo,
                    placeholder: kimodo ? "or in words: a person sits and reads a book" : "in words needs Kimodo (Rig → Install AI rigging / motion models…)" });
                prompt.style.width = "100%";
                at = Object.assign(el("input", "rd-in rd-num"), { type: "number", value: Math.round(this.currentFrame || 0), min: 0 });
                const fl = el("div", "rd-sub");
                fl.style.cssText = "display:grid;grid-template-columns:repeat(3,auto);gap:2px 12px";
                floor = FLOOR_PARTS.map(([key, label]) => {
                    const b = Object.assign(el("input"), { type: "checkbox" });
                    const l = el("label", "rd-sub"); l.append(b, ` ${label}`);
                    fl.append(l);
                    return { key, b };
                });
                picture = this._previzRigMediaRow(el, row, { label: "Picture", exts: PICTURE_EXTS, kind: "picture", auto: false });
                facePic = Object.assign(el("input"), { type: "checkbox", checked: false });
                const lfp = el("label", "rd-sub"); lfp.append(facePic, " Turn the character as the person in the picture is turned");
                viaSel = el("select", "rd-in");
                for (const [v, t, ok] of [["sam3d", "SAM 3D Body (ComfyUI)", sam.ready], ["mediapipe", "MediaPipe (Rig › Install AI rigging / motion models…)", tools.posetrack && tools.posetrack.ready]]) {
                    const o = el("option", "", ok ? t : `${t} - not set up`); o.value = v; o.disabled = !ok; viaSel.append(o);
                }
                viaSel.value = sam.ready ? "sam3d" : "mediapipe";
                const viaRow = [viaSel];
                const weightsOnly = !sam.ready && (sam.missing || []).length && (sam.missing || []).every((m) => m.kind === "model");
                if (weightsOnly) {
                    const get = el("button", "rd-btn", "Get SAM 3D Body");
                    get.type = "button";
                    get.title = "Fetch sam_3d_body_dinov3_bf16.safetensors (Comfy-Org's, Meta's SAM License) into models/detection";
                    const said = el("span", "rd-sub", "");
                    get.onclick = async () => {
                        get.disabled = true;
                        const ok = await this.previzRigGetSam3dBody((t) => { said.textContent = t; });
                        if (ok) {
                            said.textContent = "SAM 3D Body is there.";
                            const o = viaSel.querySelector('option[value="sam3d"]');
                            o.disabled = false; o.textContent = "SAM 3D Body (ComfyUI)"; viaSel.value = "sam3d";
                            picture.row.querySelectorAll("button").forEach((b) => { b.disabled = false; });
                        } else get.disabled = false;
                    };
                    viaRow.push(get, said);
                } else if (!sam.ready && sam.why) viaSel.title = `SAM 3D Body: ${sam.why}`;
                this._previzRigViaRow = row("Read with", ...viaRow);
                if (!tracker) {
                    picture.row.title = "Pose from a picture needs SAM 3D Body or the pose tracker";
                    picture.row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
                }
                limitBox = Object.assign(el("input"), { type: "checkbox", checked: true });
                const ll = el("label", "rd-sub"); ll.append(limitBox, " Keep joints in their natural range");
                const rows = [row("Poses", grid), row("Words", prompt), picture.row, this._previzRigViaRow, row("Picture facing", lfp), row("On the floor", fl), row("Limits", ll), row("Frame", at)];
                if (this.previzLayersAvailable && this.previzLayersAvailable()) rows.push(row("Layer", (onLayer = this._previzLayerBox(el, false)).label));
                return rows;
            },
            note: "Ticked poses are laid over each other in order (sit + arms crossed); a picture picked is used instead of them "
                + "(one person, whole body in view). The pose is keyed on that frame; the body is put on the floor, "
                + "on the first part ticked under On the floor, and the others are reached down to it.",
            onExport: async (_v, { progress }) => {
                const preset = boxes.filter((x) => x.b.checked).map((x) => x.name);
                const pic = picture.get();
                const out = await this.previzRigPose(modelId, {
                    image: pic, facing: facePic.checked ? "picture" : "keep", via: viaSel.value,
                    preset: preset.length ? preset : null, prompt: preset.length ? "" : prompt.value,
                    frame: Number(at.value), layer: onLayer && onLayer.box.checked ? "new" : null,
                    contacts: floor.filter((x) => x.b.checked).map((x) => x.key), limits: limitBox.checked,
                    progress: (line) => progress(0.5, 1, line),
                });
                if (!out.ok) return { ok: false, message: out.message };
                notice("success", "Posed", `Keyed on frame ${out.frame} (${out.keys} keys).`);
                return { ok: true };
            },
        });
    },
};
