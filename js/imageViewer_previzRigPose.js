// imageViewer_previzRigPose.js
// One pose on a humanoid character, keyed on one frame: from named poses ("sit",
// "arms_crossed" ...) and joints described in words (imageViewer_rigPoseSpec.js), from
// a picture of a person (MediaPipe's Pose Landmarker through /imageviewer/rig/video_pose,
// solved by solvePicturePose), or from a prompt through Kimodo (a short motion made from where the character stands,
// its last frame kept). Mixed into the panel after PrevizRigAIMixin; the Rig menu's
// "Pose…" and the agent's `pose` action come here.
import * as M from "./imageViewer_rigMotion.js";
import * as P from "./imageViewer_rigPoseSpec.js";
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
     * the turn the picture shows. A prompt is used only when none of those, no preset and no
     * joints are given: then the pose comes from Kimodo. Answers
     * { ok, frame, keys, unknown, layer } or { ok: false, message }.
     */
    async previzRigPose(modelId, { preset = null, joints = null, hips = null, mirror = null, ground = true,
                                   contacts = null, limits = true, image = null, landmarks = null, facing = "keep",
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
        let motion, unknown = [], placed = [];
        const words = String(prompt || "").trim();
        if (image || landmarks) {
            let lm = landmarks;
            if (!lm) {
                const tools = await this._previzRigTools();
                if (!tools.posetrack || !tools.posetrack.ready) {
                    return { ok: false, message: `A pose from a picture needs the pose tracker: ${(tools.posetrack && tools.posetrack.why) || "Rig → Set up…"}` };
                }
                const job = await this._previzRigJob("/imageviewer/rig/video_pose", { src: image }, { progress });
                if (job.state !== "done") return { ok: false, message: `The picture was not read: ${job.error || job.state}` };
                const fr = (job.result.frames || [])[0];
                lm = fr && fr.world;
                if (!lm) return { ok: false, message: "No person was found in the picture." };
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
        return { ok: true, frame: f, keys: out.keys, layer: out.layer || null, unknown, contacts: placed };
    },

    /** Kimodo makes about two seconds from where the character stands; its last frame, in place, is the pose. */
    async _previzRigPoseFromPrompt(prompt, { k0, heading, seed, progress }) {
        const tools = await this._previzRigTools();
        if (!tools.kimodo || !tools.kimodo.ready) return { message: "A pose from a prompt needs Kimodo (Rig → Set up…); name a preset or joints instead." };
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
        const tracker = !!(tools.posetrack && tools.posetrack.ready);
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
                    placeholder: kimodo ? "or in words: a person sits and reads a book" : "in words needs Kimodo (Rig → Set up…)" });
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
                if (!tracker) {
                    picture.row.title = "Pose from a picture needs the pose tracker (Rig → Set up…, Motion from video)";
                    picture.row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
                }
                limitBox = Object.assign(el("input"), { type: "checkbox", checked: true });
                const ll = el("label", "rd-sub"); ll.append(limitBox, " Keep joints in their natural range");
                const rows = [row("Poses", grid), row("Words", prompt), picture.row, row("Picture facing", lfp), row("On the floor", fl), row("Limits", ll), row("Frame", at)];
                if (this.previzLayersAvailable && this.previzLayersAvailable()) rows.push(row("Layer", (onLayer = this._previzLayerBox(el, false)).label));
                return rows;
            },
            note: "Ticked poses are laid over each other in order (sit + arms crossed); a picture picked is used instead of them "
                + "(one person, whole body in view). The pose is keyed on that frame; the body is put on the floor, "
                + "on the first part ticked under On the floor, and the others are reached down to it.",
            onExport: async (_v, { progress }) => {
                const preset = boxes.filter((x) => x.b.checked).map((x) => x.name);
                const pic = tracker ? picture.get() : null;
                const out = await this.previzRigPose(modelId, {
                    image: pic, facing: facePic.checked ? "picture" : "keep",
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
