// imageViewer_previzRigExtras.js
// The Rig menu's extras, the panel half (the data and maths are
// imageViewer_rigExtras.js; the viewport half imageViewer_rig3dExtras.js):
//   - the POSE LIBRARY: a window of saved poses, kept per OS user on the server
//     (src/rig_poses.py), applied at any weight, mirrored or not, onto all of a
//     character's controls or the selected ones; Copy / Paste pose; Flip pose;
//   - SPACE SWITCHING: a control follows its parent, the world, the root, the
//     COG, the chest, the head or a hand, switched at the playhead without a
//     jump (a hold key on its "space" channel);
//   - MATCH IK / FK without switching the blend;
//   - SET-DRIVEN KEYS: a window like Maya's - load a driver channel, load the
//     driven channels, pose, Key;
//   - CUSTOM ATTRIBUTES on controls (keyable "attr:" channels) and the
//     model's BLENDSHAPES (keyable "bs:" channels), both in the Channel Box;
//   - FACIAL CONTROLS: joysticks on a board beside the head that drive the
//     blendshapes through set-driven keys.
// Everything goes through the scene like any other edit: one undo step, the
// node widget written, the outliner and curves refreshed.
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import * as X from "./imageViewer_rigExtras.js";
import * as DRV from "./imageViewer_rigDrivers.js";
import { notice } from "./imageViewer_exportUI.js";

const FLOAT_CSS = `
.rx-float { position: absolute; z-index: 290; min-width: 260px; max-width: 420px; max-height: 80%;
  display: flex; flex-direction: column; background: #1b1b1b; border: 1px solid #444; border-radius: 4px;
  box-shadow: 0 6px 18px rgba(0,0,0,.6); color: #ccc; font-size: 11px; }
.rx-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: #242424; border-bottom: 1px solid #333;
  cursor: move; user-select: none; border-radius: 4px 4px 0 0; }
.rx-head b { flex: 1; font-weight: 600; color: #ddd; }
.rx-x { background: none; border: none; color: #aaa; cursor: pointer; font-size: 13px; padding: 0 4px; }
.rx-x:hover { color: #fff; }
.rx-body { padding: 6px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.rx-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rx-row > label { display: flex; align-items: center; gap: 4px; }
.rx-btn { background: #222; color: #ccc; border: 1px solid #444; border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
.rx-btn:hover { background: #333; color: #fff; }
.rx-btn:disabled { opacity: .4; cursor: default; }
.rx-in { background: #111; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px 4px; font-size: 11px; min-width: 0; }
.rx-sub { color: #888; }
.rx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 6px; }
.rx-pose { display: flex; flex-direction: column; gap: 2px; border: 1px solid #333; border-radius: 3px; padding: 3px; cursor: pointer; background: #161616; }
.rx-pose:hover { border-color: #666; }
.rx-pose.sel { border-color: #f60; }
.rx-pose img, .rx-pose .rx-noimg { width: 100%; aspect-ratio: 1; object-fit: cover; background: #282828; border-radius: 2px; }
.rx-pose span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rx-list { border: 1px solid #333; border-radius: 3px; background: #161616; max-height: 160px; overflow-y: auto; }
.rx-li { display: flex; align-items: center; gap: 4px; padding: 2px 4px; }
.rx-li:hover { background: #242424; }
.rx-li.sel { background: #3a2a1a; }
.rx-li span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rx-sec { color: #999; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; margin-top: 2px; }
`;

const VEC = [["position", "translate"], ["rotation", "rotate"]];

export const PrevizRigExtrasMixin = {

    // ── A floating window over the viewer ─────────────────────────────────

    /** A small window inside the viewer (popout-safe: made in the viewer's own document). */
    _rxFloat(key, title) {
        const host = this._previzMenuHost();
        if (!host) return null;
        const doc = host.ownerDocument;
        this._rxFloats = this._rxFloats || new Map();
        const old = this._rxFloats.get(key);
        if (old && old.isConnected && old.ownerDocument === doc) { old.querySelector(".rx-body").replaceChildren(); return old; }
        if (old) old.remove();
        if (!host.querySelector("style[data-rx]")) {
            const st = doc.createElement("style");
            st.dataset.rx = "1";
            st.textContent = FLOAT_CSS;
            host.append(st);
        }
        const box = doc.createElement("div");
        box.className = "rx-float";
        box.dataset.rx = key;
        const head = doc.createElement("div");
        head.className = "rx-head";
        head.append(Object.assign(doc.createElement("b"), { textContent: title }));
        const x = Object.assign(doc.createElement("button"), { className: "rx-x", textContent: "×", title: "Close" });
        x.onclick = () => box.remove();
        head.append(x);
        const body = doc.createElement("div");
        body.className = "rx-body";
        box.append(head, body);
        // Keys typed into a field stay in it (the 3D space's own hotkeys must not see them).
        box.addEventListener("keydown", (e) => e.stopPropagation());
        host.append(box);
        const h = host.getBoundingClientRect();
        const n = this._rxFloats.size;
        box.style.left = `${Math.max(8, h.width - 440 - 24 * n)}px`;
        box.style.top = `${40 + 24 * n}px`;
        head.addEventListener("pointerdown", (e) => {
            if (e.target === x) return;
            e.preventDefault();
            const sx = e.clientX, sy = e.clientY, ox = box.offsetLeft, oy = box.offsetTop;
            const move = (ev) => {
                box.style.left = `${Math.max(0, Math.min(h.width - 60, ox + ev.clientX - sx))}px`;
                box.style.top = `${Math.max(0, Math.min(h.height - 30, oy + ev.clientY - sy))}px`;
            };
            const up = () => { doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); };
            doc.addEventListener("pointermove", move);
            doc.addEventListener("pointerup", up);
        });
        this._rxFloats.set(key, box);
        return box;
    },

    _rxEl(box, tag, cls = "", text = "") {
        const e = box.ownerDocument.createElement(tag);
        if (cls) e.className = cls;
        if (text) e.textContent = text;
        return e;
    },

    _rxButton(box, label, run, title = "") {
        const b = this._rxEl(box, "button", "rx-btn", label);
        if (title) b.title = title;
        b.onclick = () => Promise.resolve().then(run).catch((err) => {
            console.error(`[ImageViewer] ${label}:`, err);
            notice("error", `${label} did not work`, String((err && err.message) || err));
        });
        return b;
    },

    _rxFrame() { return Math.round(this.currentFrame || 0); },

    /** Write a channel the way every rig edit does: a key where it animates (or autokey is on), else its number. */
    _rxWrite(item, prop, value, frame, { key = false, ease = null } = {}) {
        if (key || this._previzAutokey || S.isAnimated(item, prop)) {
            S.setKeyframe(item, prop, frame, Array.isArray(value) ? value.slice() : value, ease || this._previzEase || "smooth");
        } else S.setStaticValue(item, prop, value);
    },

    // ── The pose library ──────────────────────────────────────────────────

    async _rxPoseCall(body) {
        const r = await api.fetchApi("/imageviewer/rig/poses", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `the server answered ${r.status}`);
        return j;
    },

    /** The library, newest first (cached; `refresh` asks the server again). */
    async previzPoseList({ refresh = false } = {}) {
        if (!this._rxPoses || refresh) this._rxPoses = (await this._rxPoseCall({ op: "list" })).poses || [];
        return this._rxPoses.map((p) => ({ name: p.name, model: p.model, controls: Object.keys(p.controls).length,
                                           created: p.created, thumb: p.thumb || null }));
    },

    _rxPoseByName(name) {
        const k = String(name || "").trim().toLowerCase();
        return (this._rxPoses || []).find((p) => p.name.toLowerCase() === k) || null;
    },

    /** Save the character's pose at the playhead (all its controls, or `ids`) under `name`. */
    async previzPoseSave(name, { modelId = this.previzRigModelOf(), ids = null, thumb = true } = {}) {
        const scene = this.previzScene();
        const model = modelId && S.itemById(scene, modelId);
        if (!model || !R.isRigged(scene, modelId)) throw new Error("Select a rigged character (or one of its controls).");
        const pose = X.capturePose(scene, modelId, this._rxFrame(), { ids });
        pose.name = String(name || "").trim() || `${model.name} pose`;
        pose.model = model.name;
        pose.created = Date.now() / 1000;
        if (thumb) {
            const view = this._modelView();
            const t = view && view.captureThumbnail && view.captureThumbnail(128);
            if (t) pose.thumb = t;
        }
        const saved = (await this._rxPoseCall({ op: "save", pose })).pose;
        this._rxPoses = [saved, ...(this._rxPoses || []).filter((p) => p.name.toLowerCase() !== saved.name.toLowerCase())];
        return { name: saved.name, controls: Object.keys(saved.controls).length };
    },

    async previzPoseDelete(name) {
        await this._rxPoseCall({ op: "delete", name });
        this._rxPoses = (this._rxPoses || []).filter((p) => p.name.toLowerCase() !== String(name).toLowerCase());
    },

    async previzPoseRename(name, to) {
        const p = (await this._rxPoseCall({ op: "rename", name, to })).pose;
        await this.previzPoseList({ refresh: true });
        return p.name;
    },

    /**
     * Put a pose on the character at the playhead. `blend` 0..1 mixes it with
     * the pose the character has; `mirror` puts it on the other side; `ids`
     * limits it to some controls. Keys where the controls animate (or with
     * autokey, or `key`). Answers { matched, missing }.
     */
    async previzPoseApply(name, { modelId = this.previzRigModelOf(), ids = null, blend = 1, mirror = false, key = false, pose = null } = {}) {
        const scene = this.previzScene();
        if (!pose) {
            if (!this._rxPoses) await this.previzPoseList();
            pose = this._rxPoseByName(name);
        }
        if (!pose) throw new Error(`There is no pose called ${name}.`);
        if (!modelId || !R.isRigged(scene, modelId)) throw new Error("Select a rigged character (or one of its controls).");
        const frame = this._rxFrame();
        this.previzSnapshot(`pose ${pose.name || "paste"}`);
        let target = pose;
        if (mirror) {
            // Put it on as it is, read the bones, mirror them, then blend that in instead.
            const before = new Map(X.controlsOfModel(scene, modelId).map((c) => [c.id, JSON.parse(JSON.stringify({ position: c.position, rotation: c.rotation, tracks: c.tracks, ikfk: c.ikfk }))]));
            const { writes } = X.poseWrites(scene, modelId, pose, frame, { blend: 1 });
            for (const w of writes) if (w.prop === "position" || w.prop === "rotation" || w.prop === "ikfk") this._rxWrite(S.itemById(scene, w.id), w.prop, w.value, frame, { key: true });
            this._modelView().applyFrame(this.currentFrame || 0);
            const flipped = this._rxFlippedChannels(modelId, frame);
            // Back to how it was, then the mirrored one is the pose to blend in.
            for (const c of X.controlsOfModel(scene, modelId)) {
                const b = before.get(c.id);
                c.position = b.position; c.rotation = b.rotation; c.tracks = b.tracks;
                if (b.ikfk !== undefined) c.ikfk = b.ikfk;
            }
            this._modelView().applyFrame(this.currentFrame || 0);
            const controls = {};
            for (const c of X.controlsOfModel(scene, modelId)) {
                const k = X.poseKey(c);
                const ch = flipped.get(c.id);
                // The IK blend and the attributes come from the other side's entry.
                const src = pose.controls[X.flipName(k)] || pose.controls[k] || {};
                if (ch) controls[k] = { ...ch, ...(Number.isFinite(src.ikfk) ? { ikfk: src.ikfk } : {}), ...(src.attrs ? { attrs: src.attrs } : {}) };
                else if (c.control.type === "face" && src.position) controls[k] = { ...src, position: [-src.position[0], src.position[1], src.position[2]] };
            }
            target = { controls, blendshapes: _flipShapes(pose.blendshapes) };
        }
        const { writes, matched, missing } = X.poseWrites(scene, modelId, target, frame, { ids, blend });
        for (const w of writes) this._rxWrite(S.itemById(scene, w.id), w.prop, w.value, frame, { key });
        await this.previzChanged();
        return { matched, missing };
    },

    /** Copy the character's pose (or the selected controls') to paste on another frame or character. */
    previzPoseCopy(modelId = this.previzRigModelOf()) {
        const scene = this.previzScene();
        if (!modelId || !R.isRigged(scene, modelId)) { notice("info", "Select a rigged character to copy its pose."); return null; }
        const sel = this.previzSelectedIds().filter((id) => { const it = S.itemById(scene, id); return it && it.kind === "control"; });
        this._rxClipboard = X.capturePose(scene, modelId, this._rxFrame(), { ids: sel.length > 1 ? sel : null });
        notice("info", `Pose copied (${Object.keys(this._rxClipboard.controls).length} controls).`);
        return this._rxClipboard;
    },

    async previzPosePaste(modelId = this.previzRigModelOf(), opts = {}) {
        if (!this._rxClipboard) { notice("info", "Copy a pose first (Rig → Copy pose)."); return null; }
        return this.previzPoseApply(null, { modelId, pose: this._rxClipboard, ...opts });
    },

    /** The control channels of the character's bones mirrored left to right (whole body). */
    _rxFlippedChannels(modelId, frame) {
        const view = this._modelView();
        const pose = view && view.rigPose(modelId);
        const skel = this._previzRigSkeletonCache(modelId);
        if (!pose || !skel) return new Map();
        const rest = new Map(skel.bones.map((b) => [b.name, b.world]));
        const flipped = X.flipBonesPose(new Map(pose), rest);
        return this._previzRigChannelsFor(modelId, flipped, frame, { moveCog: true });
    },

    /**
     * Mirror the whole pose: left becomes right and right left, the spine and
     * head turned the other way. `ids` limits what is written (default: all).
     */
    previzRigFlipPose(modelId = this.previzRigModelOf(), { ids = null } = {}) {
        const scene = this.previzScene();
        if (!modelId || !R.isRigged(scene, modelId)) { notice("info", "Select a rigged character to flip its pose."); return; }
        const frame = this._rxFrame();
        const chans = this._rxFlippedChannels(modelId, frame);
        if (!chans.size) return;
        this.previzSnapshot("flip pose");
        const only = ids && ids.length ? new Set(ids) : null;
        // The IK blend and the attributes go with their side too.
        const ctrls = X.controlsOfModel(scene, modelId);
        const twin = new Map(ctrls.map((c) => [c.id, ctrls.find((o) => X.poseKey(o) === X.flipName(X.poseKey(c))) || c]));
        const blends = new Map(ctrls.filter((c) => c.control.type === "ik").map((c) => [c.id, S.valueAt(twin.get(c.id), "ikfk", frame)]));
        for (const [id, ch] of chans) {
            if (only && !only.has(id)) continue;
            const c = S.itemById(scene, id);
            if (c.control.type === "face") continue;
            this._rxWrite(c, "position", ch.position, frame);
            this._rxWrite(c, "rotation", ch.rotation, frame);
        }
        for (const [id, v] of blends) if (!only || only.has(id)) this._rxWrite(S.itemById(scene, id), "ikfk", v, frame);
        const model = S.itemById(scene, modelId);
        const flippedShapes = _flipShapes(Object.fromEntries(S.namedProps(model).filter((p) => p.startsWith("bs:")).map((p) => [p.slice(3), S.valueAt(model, p, frame)])));
        if (!only) for (const [n, v] of Object.entries(flippedShapes || {})) this._rxWrite(model, `bs:${n}`, v, frame);
        this.previzChanged();
    },

    /** The Pose Library window. */
    async previzPoseLibrary(modelId = this.previzRigModelOf()) {
        const box = this._rxFloat("poses", "Pose library");
        if (!box) return;
        const body = box.querySelector(".rx-body");
        const scene = this.previzScene();
        const model = () => {
            const id = this.previzRigModelOf() || modelId;
            return id && R.isRigged(this.previzScene(), id) ? id : null;
        };
        const el = (t, c, x) => this._rxEl(box, t, c, x);
        const name = Object.assign(el("input", "rx-in"), { placeholder: "Pose name", spellcheck: false });
        name.style.flex = "1";
        const selOnly = Object.assign(el("input"), { type: "checkbox" });
        const lSel = el("label"); lSel.append(selOnly, "Selected controls only");
        const blend = Object.assign(el("input"), { type: "range", min: "0", max: "100", value: "100" });
        const blendN = el("span", "rx-sub", "100 %");
        blend.oninput = () => { blendN.textContent = `${blend.value} %`; };
        const mirror = Object.assign(el("input"), { type: "checkbox" });
        const lMir = el("label"); lMir.append(mirror, "Mirrored");
        const keyIt = Object.assign(el("input"), { type: "checkbox", checked: !!this._previzAutokey });
        const lKey = el("label"); lKey.append(keyIt, "Key");
        const grid = el("div", "rx-grid");
        const status = el("div", "rx-sub");
        let picked = null;
        const ids = () => {
            if (!selOnly.checked) return null;
            const sc = this.previzScene();
            return this.previzSelectedIds().filter((id) => { const it = S.itemById(sc, id); return it && it.kind === "control"; });
        };
        const apply = async (p) => {
            const m = model();
            if (!m) { notice("info", "Select a rigged character (or one of its controls)."); return; }
            const r = await this.previzPoseApply(p.name, { modelId: m, ids: ids(), blend: Number(blend.value) / 100, mirror: mirror.checked, key: keyIt.checked });
            status.textContent = `${p.name}: ${r.matched} controls posed${r.missing.length ? `, ${r.missing.length} not on this rig` : ""}.`;
        };
        const draw = async () => {
            let list;
            try { list = await this.previzPoseList(); } catch (e) { status.textContent = `The library could not be read: ${e.message}`; return; }
            grid.replaceChildren();
            if (!list.length) grid.append(el("div", "rx-sub", "No poses yet: pose the character, give it a name and Save."));
            for (const p of list) {
                const card = el("div", `rx-pose${picked === p.name ? " sel" : ""}`);
                card.title = `${p.name}${p.model ? ` (${p.model})` : ""} · ${p.controls} controls\nDouble-click to apply`;
                if (p.thumb) card.append(Object.assign(el("img"), { src: p.thumb, alt: "" }));
                else card.append(el("div", "rx-noimg"));
                card.append(el("span", "", p.name));
                card.onclick = () => { picked = p.name; name.value = p.name; draw(); };
                card.ondblclick = () => apply(p);
                grid.append(card);
            }
        };
        const save = this._rxButton(box, "Save", async () => {
            const m = model();
            if (!m) { notice("info", "Select a rigged character (or one of its controls)."); return; }
            const r = await this.previzPoseSave(name.value, { modelId: m, ids: ids() });
            picked = r.name;
            status.textContent = `Saved ${r.name} (${r.controls} controls).`;
            draw();
        }, "Save the pose at the playhead under this name (a pose of the same name is replaced)");
        const ap = this._rxButton(box, "Apply", () => { const p = this._rxPoseByName(picked); if (p) return apply(p); notice("info", "Pick a pose first."); });
        const ren = this._rxButton(box, "Rename", async () => {
            if (!picked || !name.value.trim() || name.value.trim() === picked) { notice("info", "Pick a pose, type its new name, then Rename."); return; }
            picked = await this.previzPoseRename(picked, name.value.trim());
            draw();
        });
        const del = this._rxButton(box, "Delete", async () => {
            if (!picked) { notice("info", "Pick a pose first."); return; }
            await this.previzPoseDelete(picked);
            status.textContent = `Deleted ${picked}.`;
            picked = null;
            draw();
        });
        const r1 = el("div", "rx-row"); r1.append(name, save);
        const r2 = el("div", "rx-row"); r2.append(el("span", "rx-sub", "Blend"), blend, blendN, lMir, lKey);
        const r3 = el("div", "rx-row"); r3.append(lSel);
        const r4 = el("div", "rx-row"); r4.append(ap, ren, del,
            this._rxButton(box, "Flip pose", () => { const m = model(); if (m) this.previzRigFlipPose(m, { ids: ids() }); }, "Mirror the whole body left to right"));
        body.append(r1, grid, r2, r3, r4, status);
        void scene;
        await draw();
        return box;
    },

    // ── Spaces ────────────────────────────────────────────────────────────

    /**
     * Put a control into a space (an index into spacesOf, or a target id) at
     * the playhead, keeping it where it is. Animated: a hold key on "space"
     * here and the old space on the frame before, so the frames before are
     * untouched.
     */
    previzRigSetSpace(id, to) {
        const scene = this.previzScene();
        const c = S.itemById(scene, id);
        if (!c || c.kind !== "control") { notice("info", "Select a control to switch its space."); return; }
        const view = this._modelView();
        const modelId = c.control.model;
        let index = typeof to === "number" ? to : null;
        if (index === null) {
            if (!to || to === c.parent) index = 0;
            else {
                if (!S.itemById(scene, to)) return;
                c.control.spaces = c.control.spaces || [];
                let i = c.control.spaces.indexOf(to);
                if (i < 0) { this.previzSnapshot("space"); c.control.spaces.push(to); i = c.control.spaces.length - 1; }
                index = i + 1;
            }
        }
        const frame = this._rxFrame();
        const was = X.spaceAt(scene, c, frame);
        if (was === index) return;
        this.previzSnapshot(`space ${X.spacesOf(scene, c)[index] ? X.spacesOf(scene, c)[index].name : index}`);
        view.applyFrame(this.currentFrame || 0);
        const worldOf = (x) => view.rigItemWorld(modelId, x);
        const now = view.rigItemWorld(modelId, c.id);
        const ch = X.channelsInSpace(scene, c, index, now, worldOf, S.valueAt(c, "rotation", frame));
        const animated = S.isAnimated(c, "position") || S.isAnimated(c, "rotation") || S.isAnimated(c, "space") || this._previzAutokey;
        if (animated) {
            if (frame > 0) {
                // The frame before keeps the old space and what it had there.
                const pf = frame - 1;
                S.setKeyframe(c, "position", pf, S.valueAt(c, "position", pf));
                S.setKeyframe(c, "rotation", pf, S.valueAt(c, "rotation", pf));
                S.setKeyframe(c, "space", pf, X.spaceAt(scene, c, pf), "hold");
            }
            S.setKeyframe(c, "position", frame, ch.position);
            S.setKeyframe(c, "rotation", frame, ch.rotation);
            S.setKeyframe(c, "space", frame, index, "hold");
            for (const k of S.track(c, "space")) k.ease = "hold";
        } else {
            c.position = ch.position;
            c.rotation = ch.rotation;
            c.space = index;
            if (!index) delete c.space;
        }
        this.previzChanged();
    },

    _previzRigSpaceMenu(anchor, id = this._previzSelection) {
        const scene = this.previzScene();
        const c = S.itemById(scene, id);
        if (!c || c.kind !== "control") { notice("info", "Select a control to switch its space."); return; }
        const frame = this._rxFrame();
        const cur = X.spaceAt(scene, c, frame);
        const have = X.spacesOf(scene, c);
        const entries = have.map((s, i) => ({ label: `${i === cur ? "✓ " : "   "}${i ? s.name : `Parent (${(S.itemById(scene, c.parent) || {}).name || "rig"})`}`,
                                              run: () => this.previzRigSetSpace(c.id, i) }));
        const more = X.spaceCandidates(scene, c).filter((s) => !have.some((h) => h.id === s.id));
        if (more.length) entries.push("-");
        for (const s of more) entries.push({ label: `   ${s.name}`, run: () => this.previzRigSetSpace(c.id, s.id) });
        const other = this.previzSelectedIds().find((x) => x !== c.id);
        if (other && !have.some((h) => h.id === other) && !more.some((m) => m.id === other)) {
            entries.push("-", { label: `   ${(S.itemById(scene, other) || {}).name} (selected)`, run: () => this.previzRigSetSpace(c.id, other) });
        }
        const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 200, bottom: 100 };
        this._previzOpenMenu(entries, r.left, r.bottom + 2, anchor);
    },

    /** Match one side of a limb to the other at the playhead without switching the blend. `side` "fk" or "ik". */
    previzRigMatch(id = this._previzSelection, side = "fk") {
        const scene = this.previzScene();
        const ik = this._previzRigIkFor(id);
        if (!ik) { notice("info", "Select a limb's IK control, pole or FK control."); return; }
        const modelId = ik.control.model;
        const frame = this._rxFrame();
        const pose = this._modelView().rigPose(modelId);
        if (!pose) return;
        this.previzSnapshot(side === "fk" ? "match FK to IK" : "match IK to FK");
        const chans = this._previzRigChannelsFor(modelId, pose, frame);
        const ids = side === "ik" ? [ik.id, ik.control.pole].filter(Boolean)
            : R.controlsOf(scene, modelId).filter((c) => c.control.type === "fk" && ik.control.chain.includes(c.control.bone)).map((c) => c.id);
        for (const cid of ids) {
            const c = S.itemById(scene, cid);
            const ch = chans.get(cid);
            if (!c || !ch) continue;
            this._rxWrite(c, "position", ch.position, frame);
            this._rxWrite(c, "rotation", ch.rotation, frame);
        }
        this.previzChanged();
    },

    // ── Custom attributes ─────────────────────────────────────────────────

    /** Add a keyable number to a control: { name, min, max, value }. */
    previzRigAddAttr(id, { name, min = null, max = null, value = 0 } = {}) {
        const c = S.itemById(this.previzScene(), id);
        const n = String(name || "").trim().replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
        if (!c || !n) return null;
        this.previzSnapshot(`add attribute ${n}`);
        c.attrs = c.attrs || {};
        c.attrs[n] = { value: Number(value) || 0 };
        if (Number.isFinite(min) && min !== null) c.attrs[n].min = Number(min);
        if (Number.isFinite(max) && max !== null) c.attrs[n].max = Number(max);
        S.setStaticValue(c, `attr:${n}`, c.attrs[n].value);
        if (this._cbUI) this._cbUI.sig = "";
        this.previzChanged();
        return n;
    },

    previzRigDeleteAttr(id, name) {
        const scene = this.previzScene();
        const c = S.itemById(scene, id);
        if (!c || !c.attrs || !c.attrs[name]) return;
        this.previzSnapshot(`delete attribute ${name}`);
        delete c.attrs[name];
        if (!Object.keys(c.attrs).length) delete c.attrs;
        if (c.tracks) delete c.tracks[`attr:${name}`];
        for (const it of scene.items) {
            if (!it.drivers) continue;
            it.drivers = it.drivers.filter((d) => !(d.driver.id === id && d.driver.prop === `attr:${name}`) && !(it.id === id && d.prop === `attr:${name}`));
            if (!it.drivers.length) delete it.drivers;
        }
        if (this._cbUI) this._cbUI.sig = "";
        this.previzChanged();
    },

    async previzRigAttrDialog(id = this._previzSelection) {
        const c = S.itemById(this.previzScene(), id);
        if (!c) { notice("info", "Select an item to add an attribute to."); return; }
        const box = this._rxFloat("attr", `Add attribute to ${c.name}`);
        const body = box.querySelector(".rx-body");
        const el = (t, cl, x) => this._rxEl(box, t, cl, x);
        const name = Object.assign(el("input", "rx-in"), { placeholder: "fist", spellcheck: false });
        const lo = Object.assign(el("input", "rx-in"), { type: "number", placeholder: "none", style: "width:60px" });
        const hi = Object.assign(el("input", "rx-in"), { type: "number", placeholder: "none", style: "width:60px" });
        const def = Object.assign(el("input", "rx-in"), { type: "number", value: "0", style: "width:60px" });
        const r1 = el("div", "rx-row"); r1.append(el("span", "rx-sub", "Name"), name);
        const r2 = el("div", "rx-row"); r2.append(el("span", "rx-sub", "Min"), lo, el("span", "rx-sub", "Max"), hi, el("span", "rx-sub", "Default"), def);
        const r3 = el("div", "rx-row");
        r3.append(this._rxButton(box, "Add", () => {
            const n = this.previzRigAddAttr(c.id, { name: name.value, min: lo.value === "" ? null : Number(lo.value),
                                                    max: hi.value === "" ? null : Number(hi.value), value: Number(def.value) });
            if (n) box.remove();
        }));
        body.append(r1, r2, r3, el("div", "rx-sub", "A number in the Channel Box: keyable, and a driver for set-driven keys."));
        name.focus();
    },

    // ── Set-driven keys ───────────────────────────────────────────────────

    /** The channels of an item a set-driven key can read or move: [{ prop, axis, label }]. */
    previzRigChannelsOf(item) {
        if (!item) return [];
        const out = [];
        const vecs = item.kind === "control" ? VEC : [...VEC, ["scale", "scale"]];
        for (const [p, l] of vecs) for (let a = 0; a < 3; a++) out.push({ prop: p, axis: a, label: `${l}${"XYZ"[a]}` });
        if (item.kind === "control" && item.control && item.control.type === "ik") out.push({ prop: "ikfk", axis: null, label: "ikBlend" });
        for (const n of Object.keys(item.attrs || {})) out.push({ prop: `attr:${n}`, axis: null, label: n });
        if (item.kind === "model") {
            const view = this._modelView();
            for (const n of X.sortMorphs((view && view.rigMorphNames && view.rigMorphNames(item.id)) || [])) {
                out.push({ prop: `bs:${n}`, axis: null, label: n });
            }
        }
        return out;
    },

    /**
     * Key the driven channels against the driver's value now, Maya's way: the
     * driven channels are posed by hand, then Key folds what changed since the
     * curve's first key into the curve and puts the channel back, so nothing
     * jumps and the driver now gives that pose.
     * `driver` { id, prop, axis }; `driven` [{ id, prop, axis }].
     */
    previzRigSdkKey(driver, driven) {
        const scene = this.previzScene();
        if (!driver || !S.itemById(scene, driver.id) || !driven || !driven.length) return 0;
        const frame = this._rxFrame();
        const x = X.channelValue(scene, driver.id, driver.prop, driver.axis, frame);
        if (!Number.isFinite(x)) return 0;
        this.previzSnapshot("set driven key");
        let n = 0;
        for (const t of driven) {
            const it = S.itemById(scene, t.id);
            if (!it || it.id === driver.id && t.prop === driver.prop && (t.axis ?? null) === (driver.axis ?? null)) continue;
            const axis = t.axis ?? null;
            const own = S.valueAt(it, t.prop, frame);
            const base = Array.isArray(own) ? own[axis || 0] : own;
            it.drivers = it.drivers || [];
            let d = DRV.findDriver(it, t.prop, axis, driver);
            if (!d) {
                d = { prop: t.prop, axis, driver: { id: driver.id, prop: driver.prop, axis: driver.axis ?? null }, keys: [], ease: "smooth", rest: base };
                it.drivers.push(d);
            }
            const v = DRV.curveAt(d.keys, x, d.ease) + (base - (d.rest ?? 0));
            DRV.setDriverKey(d, x, v);
            // The channel goes back to where the curve is measured from.
            if (Math.abs(base - (d.rest ?? 0)) > 1e-9) {
                const back = Array.isArray(own) ? own.map((q, i) => (i === (axis || 0) ? d.rest : q)) : d.rest;
                this._rxWrite(it, t.prop, back, frame);
            }
            n++;
        }
        this.previzChanged();
        return n;
    },

    previzRigSdkRemove(id, index) {
        const it = S.itemById(this.previzScene(), id);
        if (!it || !it.drivers || !it.drivers[index]) return;
        this.previzSnapshot("remove driven key");
        it.drivers.splice(index, 1);
        if (!it.drivers.length) delete it.drivers;
        this.previzChanged();
    },

    /** The Set Driven Key window. */
    previzSdkWindow() {
        const box = this._rxFloat("sdk", "Set Driven Key");
        if (!box) return;
        const body = box.querySelector(".rx-body");
        const el = (t, c, x) => this._rxEl(box, t, c, x);
        const st = this._rxSdk = this._rxSdk || { driver: null, dprop: null, driven: [], props: new Set() };
        const dName = el("span", "", "—");
        const dList = el("div", "rx-list");
        const tName = el("span", "", "—");
        const tList = el("div", "rx-list");
        const existing = el("div", "rx-list");
        const status = el("div", "rx-sub");
        const filter = Object.assign(el("input", "rx-in"), { placeholder: "filter", spellcheck: false });
        const chKey = (c) => `${c.prop}|${c.axis ?? ""}`;
        const draw = () => {
            const scene = this.previzScene();
            const drv = st.driver && S.itemById(scene, st.driver);
            dName.textContent = drv ? drv.name : "—";
            dList.replaceChildren();
            for (const c of this.previzRigChannelsOf(drv)) {
                const li = el("div", `rx-li${st.dprop === chKey(c) ? " sel" : ""}`);
                li.append(el("span", "", c.label), el("span", "rx-sub", drv ? String(Math.round(X.channelValue(scene, drv.id, c.prop, c.axis, this._rxFrame()) * 1000) / 1000) : ""));
                li.onclick = () => { st.dprop = chKey(c); draw(); };
                dList.append(li);
            }
            const items = st.driven.map((id) => S.itemById(scene, id)).filter(Boolean);
            tName.textContent = items.length ? items.map((i) => i.name).join(", ") : "—";
            tList.replaceChildren();
            const seen = new Set();
            const f = filter.value.trim().toLowerCase();
            for (const it of items) {
                for (const c of this.previzRigChannelsOf(it)) {
                    const k = chKey(c);
                    if (seen.has(k) || (f && !c.label.toLowerCase().includes(f))) continue;
                    seen.add(k);
                    const li = el("div", `rx-li${st.props.has(k) ? " sel" : ""}`);
                    li.append(el("span", "", c.label));
                    li.onclick = (e) => {
                        if (!(e.ctrlKey || e.shiftKey || e.metaKey)) st.props = new Set([k]);
                        else if (st.props.has(k)) st.props.delete(k);
                        else st.props.add(k);
                        draw();
                    };
                    tList.append(li);
                }
            }
            existing.replaceChildren();
            let any = false;
            for (const it of scene.items) {
                (it.drivers || []).forEach((d, i) => {
                    any = true;
                    const src = S.itemById(scene, d.driver.id);
                    const li = el("div", "rx-li");
                    li.append(el("span", "", `${it.name}.${DRV.channelLabel(d.prop, d.axis)} ← ${src ? src.name : "?"}.${DRV.channelLabel(d.driver.prop, d.driver.axis)} (${d.keys.length} keys)`));
                    const rm = this._rxButton(box, "×", () => { this.previzRigSdkRemove(it.id, i); draw(); }, "Remove this driven key");
                    li.append(rm);
                    existing.append(li);
                });
            }
            if (!any) existing.append(el("div", "rx-li rx-sub", "No driven keys yet."));
        };
        filter.oninput = draw;
        const r1 = el("div", "rx-row"); r1.append(el("span", "rx-sec", "Driver"), dName,
            this._rxButton(box, "Load selected", () => { st.driver = this._previzSelection || null; st.dprop = null; draw(); }));
        const r2 = el("div", "rx-row"); r2.append(el("span", "rx-sec", "Driven"), tName,
            this._rxButton(box, "Load selected", () => { st.driven = this.previzSelectedIds().filter((id) => id !== st.driver); st.props = new Set(); draw(); }));
        const r3 = el("div", "rx-row");
        r3.append(this._rxButton(box, "Key", () => {
            if (!st.driver || !st.dprop) { notice("info", "Load a driver and pick its channel."); return; }
            if (!st.driven.length || !st.props.size) { notice("info", "Load the driven items and pick their channels (Ctrl-click for several)."); return; }
            const [dp, da] = st.dprop.split("|");
            const targets = [];
            for (const id of st.driven) for (const k of st.props) {
                const [p, a] = k.split("|");
                if (this.previzRigChannelsOf(S.itemById(this.previzScene(), id)).some((c) => chKey(c) === k)) targets.push({ id, prop: p, axis: a === "" ? null : Number(a) });
            }
            const n = this.previzRigSdkKey({ id: st.driver, prop: dp, axis: da === "" ? null : Number(da) }, targets);
            status.textContent = `Keyed ${n} driven channel${n === 1 ? "" : "s"}.`;
            draw();
        }, "Pose the driven channels for the driver's value now, then Key"),
        this._rxButton(box, "Refresh", draw));
        body.append(r1, dList, r2, filter, tList, r3, status, el("div", "rx-sec", "Driven keys in the scene"), existing,
            el("div", "rx-sub", "Key once at the driver's rest, then move the driver, pose the driven channels and Key again. What a curve gives is added to the channel's own value."));
        draw();
        return box;
    },

    // ── Blendshapes and facial controls ───────────────────────────────────

    /** Every blendshape of the model back to 0 at the playhead (keyed where they animate). */
    previzRigResetShapes(modelId = this.previzRigModelOf()) {
        const model = S.itemById(this.previzScene(), modelId);
        if (!model) return;
        this.previzSnapshot("reset blendshapes");
        const frame = this._rxFrame();
        for (const p of S.namedProps(model)) if (p.startsWith("bs:")) this._rxWrite(model, p, 0, frame);
        this.previzChanged();
    },

    previzRigKeyShapes(modelId = this.previzRigModelOf()) {
        const model = S.itemById(this.previzScene(), modelId);
        const view = this._modelView();
        if (!model || !view) return;
        this.previzSnapshot("key blendshapes");
        const frame = this._rxFrame();
        for (const n of view.rigMorphNames(modelId)) S.setKeyframe(model, `bs:${n}`, frame, S.valueAt(model, `bs:${n}`, frame), this._previzEase || "smooth");
        this.previzChanged();
    },

    /**
     * Facial controls: a board beside the head with joysticks that drive the
     * character's blendshapes, found by their names. Answers what was reached.
     */
    previzRigAddFace(modelId = this.previzRigModelOf()) {
        const scene = this.previzScene();
        const model = S.itemById(scene, modelId);
        const view = this._modelView();
        if (!model || model.kind !== "model") { notice("info", "Select a character with blendshapes."); return null; }
        const morphs = (view && view.rigMorphNames(modelId)) || [];
        if (!morphs.length) { notice("info", `${model.name} has no blendshapes (morph targets) in its file.`); return null; }
        const group = R.rigGroupOf(scene, modelId);
        const headCtrl = R.controlsOf(scene, modelId).find((c) => c.control.type === "fk" && c.control.role === "head");
        const skel = this._previzRigSkeletonCache(modelId);
        let head = null;
        const roles = group && group.rig && group.rig.roles;
        if (skel && roles && roles.head) {
            const b = skel.bones.find((x) => x.name === roles.head);
            if (b) head = [b.world[12], b.world[13], b.world[14]];
        }
        const height = skel ? this._previzRigHeight(modelId) : 1.7;
        if (!head) {
            const box = view.boundsOf && view.boundsOf(modelId);
            head = box ? [0, box.max[1] - 0.08 * (box.max[1] - box.min[1]), 0] : [0, 0.93 * height, 0];
        }
        this.previzSnapshot("facial controls");
        this._previzRigDropFace(modelId);
        let parentId = headCtrl ? headCtrl.id : group ? group.id : null;
        if (!parentId) {
            // No rig: a group of its own under the character holds the board.
            const g = { id: S.newId("g"), kind: "group", name: S.uniqueName(scene, `${model.name} face`), parent: model.id,
                        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0], visible: true, tracks: {},
                        rig: { model: model.id, humanoid: false, roles: {} } };
            scene.items.push(g);
            parentId = g.id;
        }
        const face = X.buildFaceRig(scene, model, morphs, { parentId, head, height });
        if (!face.items.length) { notice("info", `None of ${model.name}'s blendshapes has a name the facial controls know.`, "They are all in the Channel Box under BLENDSHAPES."); return face; }
        for (const it of face.items) { it.name = S.uniqueName(scene, it.name); scene.items.push(it); }
        model.drivers = [...(model.drivers || []), ...face.drivers];
        this._previzSelection = face.items[0].id;
        this.previzChanged({ reload: true });
        notice("info", `Facial controls for ${model.name}: ${face.used.length} blendshapes on ${face.items.length - 1} controls.`,
            face.unused.length ? `${face.unused.length} more are in the Channel Box under BLENDSHAPES.` : "");
        return face;
    },

    _previzRigDropFace(modelId) {
        const scene = this.previzScene();
        const gone = new Set(R.controlsOf(scene, modelId).filter((c) => c.control.type === "face").map((c) => c.id));
        if (!gone.size) return;
        scene.items = scene.items.filter((it) => !gone.has(it.id));
        for (const id of gone) DRV.dropDriversOf(scene, id);
    },

    previzRigRemoveFace(modelId = this.previzRigModelOf()) {
        this.previzSnapshot("remove facial controls");
        this._previzRigDropFace(modelId);
        this._previzSelection = modelId;
        this.previzChanged({ reload: true });
    },

    // ── The Rig menu ──────────────────────────────────────────────────────

    /** Put the extras into the Rig menu's entries (imageViewer_previzRig.js asks). */
    _previzRigMenuExtras(entries, { modelId, model, rigged, sel, ik, anchor }) {
        this._rxMenuAnchor = anchor;
        const at = (label) => entries.findIndex((e) => e && e.label === label);
        const ctrl = sel && sel.kind === "control" ? sel : null;
        const morphs = !!(modelId && this._modelView() && this._modelView().rigMorphNames(modelId).length);
        const face = !!(modelId && R.controlsOf(this.previzScene(), modelId).some((c) => c.control.type === "face"));
        const posing = [
            { label: "Flip pose", disabled: !rigged, title: rigged ? "" : undefined, run: () => this.previzRigFlipPose(modelId) },
            { label: "Copy pose", disabled: !rigged, run: () => this.previzPoseCopy(modelId) },
            { label: "Paste pose", disabled: !rigged || !this._rxClipboard, title: this._rxClipboard ? "" : "Copy a pose first.", run: () => this.previzPosePaste(modelId) },
            { label: "Pose library…", run: () => this.previzPoseLibrary(modelId) },
        ];
        const mirror = at("Mirror pose");
        entries.splice(mirror >= 0 ? mirror + 1 : entries.length, 0, ...posing);
        const sw = entries.findIndex((e) => e && /Switch limb/.test(e.label));
        const limb = [
            { label: "Match FK to IK", disabled: !ik, run: () => this.previzRigMatch(sel.id, "fk") },
            { label: "Match IK to FK", disabled: !ik, run: () => this.previzRigMatch(sel.id, "ik") },
            { label: "Space…", disabled: !ctrl, title: ctrl ? "" : "Select a control to switch the space it follows.",
              run: () => this._previzRigSpaceMenu(this._rxMenuAnchor, ctrl.id) },
        ];
        entries.splice(sw >= 0 ? sw + 1 : entries.length, 0, ...limb);
        const ai = at("AI in-between…");
        const more = [
            { label: "Set Driven Key…", run: () => this.previzSdkWindow() },
            { label: "Add attribute…", disabled: !sel, run: () => this.previzRigAttrDialog(sel.id) },
            { label: "Add facial controls", disabled: !morphs, title: morphs ? "" : (model ? `${model.name} has no blendshapes.` : "Select a character first."),
              run: () => this.previzRigAddFace(modelId) },
            { label: "Remove facial controls", disabled: !face, run: () => this.previzRigRemoveFace(modelId) },
            { label: "Key all blendshapes", disabled: !morphs, run: () => this.previzRigKeyShapes(modelId) },
            { label: "Reset blendshapes", disabled: !morphs, run: () => this.previzRigResetShapes(modelId) },
            "-",
        ];
        entries.splice(ai >= 0 ? ai : entries.length, 0, ...more);
    },
};

/** Blendshape weights left to right (a shape with no twin stays). */
function _flipShapes(bs) {
    if (!bs) return bs;
    const names = Object.keys(bs);
    const out = {};
    for (const n of names) {
        const twin = names.find((m) => m !== n && X.morphKey(m) === X.morphKey(X.flipName(n))) || n;
        out[twin] = bs[n];
    }
    return out;
}
