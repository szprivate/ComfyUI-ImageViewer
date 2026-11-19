// imageViewer_previzChannels.js
// The Channel Box: the selected item's channels as Maya lays them out — one
// row per channel, the name on the left and its value on the right, keyed
// channels tinted red, and the shape's own attributes in a section below.
//
// It is a dock panel of its own, beside the Outliner rather than under it, so
// each can be sized, stacked or moved without the other.
//
// What it does, Maya's way:
//   - a typed value is SET on every selected item that has the channel (not
//     added to it — that is what the gizmo does);
//   - dragging a channel's name left and right scrubs its value (Shift for
//     big steps, Ctrl for fine ones), across every selected channel at once;
//   - clicking names selects channels (Ctrl toggles, Shift extends), and the
//     right-click menu keys or clears them.
//
// The rows are built once per selection and then only their values change,
// so playback — which comes through here every frame — neither rebuilds the
// panel nor steals the field you are typing in.
import * as S from "./imageViewer_scene3d.js";
import { openFilePicker } from "./imageViewer_exportUI.js";

// What an image plane's Path picker offers: pictures, films and the frames of sequences.
const PLANE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".exr", ".tif", ".tiff", ".dpx", ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];
import { constraintOf, parseWeightProp, weightRange } from "./imageViewer_constraintData.js";
import { AIM_LABELS, AIM_PROPS, ROLL_PROP, aimOn, aimSettings, defaultAimTarget, isAimProp } from "./imageViewer_cameraAim.js";
import * as L from "./imageViewer_cameraLens.js";
import { cleanState as cleanMaskState, parseRatio } from "./imageViewer_frameMasks.js";

// id → [prop, component, label, step]; component is null for a lone number.
const TRANSFORM = [
    ["position.0", "position", 0, "Translate X", 0.1],
    ["position.1", "position", 1, "Translate Y", 0.1],
    ["position.2", "position", 2, "Translate Z", 0.1],
    ["rotation.0", "rotation", 0, "Rotate X", 1],
    ["rotation.1", "rotation", 1, "Rotate Y", 1],
    ["rotation.2", "rotation", 2, "Rotate Z", 1],
    ["scale.0", "scale", 0, "Scale X", 0.01],
    ["scale.1", "scale", 1, "Scale Y", 0.01],
    ["scale.2", "scale", 2, "Scale Z", 0.01],
];
const PIVOT = [
    ["pivot.0", "pivot", 0, "Pivot X", 0.1],
    ["pivot.1", "pivot", 1, "Pivot Y", 0.1],
    ["pivot.2", "pivot", 2, "Pivot Z", 0.1],
];
const FOV = ["fov", "fov", null, "Field Of View", 1];
// A camera's lens rows that are not channels of their own (imageViewer_cameraLens.js): the focal length and
// the horizontal field of view are the field of view read another way (keyed as "fov"); the film back,
// lens shift, clipping planes and the mask's opacity are settings, not keyed.
const CAM_DERIVED = { focal: "fov", hfov: "fov" };
const CAM_STATIC = new Set(["resolution", "aperture", "shift", "clip", "maskOpacity"]);
/** The channel a row keys and locks: "fov" for the focal length, null for a setting. */
const keyProp = (prop) => (CAM_STATIC.has(prop) ? null : CAM_DERIVED[prop] || prop);

// The sizes a camera is most often asked to be.
const RESOLUTION_PRESETS = [
    ["HD 1080", 1920, 1080], ["HD 720", 1280, 720], ["UHD 4K", 3840, 2160],
    ["DCI 2K", 2048, 1080], ["DCI 4K", 4096, 2160], ["Square 1080", 1080, 1080],
    ["Vertical 1080", 1080, 1920], ["Scope 2.39", 2048, 858],
];

const fmt = (v) => {
    if (!Number.isFinite(v)) return "0";
    const r = Math.round(v * 1000) / 1000;
    return String(Object.is(r, -0) ? 0 : r);
};

/** The channels an item of this kind shows, in the order Maya lists them. */
function transformChannels(item) {
    if (item.kind === "camera") return TRANSFORM.slice(0, 6);
    // A rig control moves and turns its bone; it never scales it.
    if (item.kind === "control") return TRANSFORM.slice(0, 6);
    return [...TRANSFORM, ...PIVOT];
}

export const PrevizChannelsMixin = {

    // ── The Parameters panel is the Channel Box on a 3D tab ──────────────────
    // As a Comp tab shows its node there (imageViewer_compPanel.js _cpParams): ComfyUI's
    // widgets, a tool's options and the lock step aside (.cb-mode), the selection monitor
    // stands down (_cbParamsMode), and #channels-panel is the .cb-params box inside the panel.

    /** The Channel Box's box inside the Parameters panel (moved there once). */
    _cbParamsBox() {
        const panel = this.paramsPanel;
        const box = this.channelsPanel;
        if (!panel || !box) return null;
        if (box.parentNode !== panel) {
            box.className = "cb-params";
            panel.append(box);
        }
        return box;
    },

    /** On a 3D tab the Parameters panel is the Channel Box (open unless put away there); off it, ComfyUI's again. */
    _cbParams(on) {
        const panel = this.paramsPanel;
        if (!panel || !this.setPanelDocked || !this.isPanelDocked) return;
        if (on) {
            if (this._cbParamsMode || !this._cbParamsBox()) return;
            this._cbParamsMode = true;
            this._cbParamsOpenBefore = this.isPanelDocked("params");
            panel.classList.add("cb-mode");
            const want = this._cbParamsWant === undefined ? this._cbParamsOpenBefore : this._cbParamsWant;
            if (want !== this.isPanelDocked("params")) this.setPanelDocked("params", want);
            this._cbParamsTitle();
            this._previzRenderChannels();
        } else if (this._cbParamsMode) {
            this._cbParamsWant = this.isPanelDocked("params");
            this._cbParamsMode = false;
            panel.classList.remove("cb-mode");
            if (this.paramsTitle) this.paramsTitle.innerText = "No Node Selected";
            if (this.currentParamNodeId != null) this.updateParamsPanel?.(true);
            if (this.isPanelDocked("params") !== !!this._cbParamsOpenBefore) this.setPanelDocked("params", !!this._cbParamsOpenBefore);
        }
    },

    _cbParamsTitle() {
        if (!this._cbParamsMode || !this.paramsTitle) return;
        const t = "Channel Box";
        if (this.paramsTitle.innerText !== t) this.paramsTitle.innerText = t;
    },

    /** The Channel Box panel's body — built on first use, like the Outliner's. */
    _cbBuild() {
        const host = this.channelsPanel;
        if (!host) return null;
        const doc = host.ownerDocument;
        host.querySelectorAll(":scope > .cb-body").forEach((n) => n.remove());
        const root = doc.createElement("div");
        root.className = "cb-body";
        host.appendChild(root);
        // Right-click anywhere in the box: the channel under the pointer joins
        // the selection first, as it does in Maya.
        root.addEventListener("contextmenu", (e) => this._cbMenu(e));
        this._cbUI = { root, sig: "", rows: new Map(), name: null };
        return this._cbUI;
    },

    /** Draw or refresh the Channel Box for the current selection. */
    _previzRenderChannels() {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        if (!this._cbParamsMode || !this.isPanelDocked || !this.isPanelDocked("params")) return;
        const ui = (this._cbUI && this._cbUI.root.isConnected) ? this._cbUI : this._cbBuild();
        if (!ui) return;
        const item = this.previzSelectedItem();
        const ids = this.previzSelectedIds();
        const scene = this.previzScene();
        const looking = !!(item && scene && scene.activeCamera === item.id);
        // Everything that decides WHICH rows there are. Values are not in it.
        const sig = item ? `${ids.join(",")}|${item.kind}|${looking}|${this._cbConstraintSig ? this._cbConstraintSig(item) : ""}|${Object.keys(item.attrs || {}).join(",")}|${this._cbMorphs(item).length}|${item.kind === "light" && item.light ? `${item.light.type}:${(item.light.fixture || {}).shape}` : ""}|${aimOn(item)}|${item.kind === "camera" && item.mask ? item.mask.key : ""}` : "";
        if (sig !== ui.sig) {
            ui.sig = sig;
            this._cbBuildRows(ui, item, ids, looking);
        }
        this._cbFillValues(ui, item);
    },

    _cbBuildRows(ui, item, ids, looking) {
        const root = ui.root;
        const doc = root.ownerDocument;
        root.innerHTML = "";
        ui.rows = new Map();
        ui.name = null;
        const valid = new Set();
        if (!item) {
            root.append(Object.assign(doc.createElement("div"), {
                className: "cb-empty", textContent: "Nothing selected.",
            }));
            this._cbSel = new Set();
            return;
        }

        // The name, as the box's heading — editable in place.
        const name = doc.createElement("input");
        name.className = "cb-name";
        name.spellcheck = false;
        name.title = "Name";
        name.onchange = () => { this.previzRename(item.id, name.value); };
        name.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") name.blur();
            if (e.key === "Escape") { name.value = (this.previzSelectedItem() || item).name; name.blur(); }
        });
        root.append(name);
        ui.name = name;
        if (ids.length > 1) {
            root.append(Object.assign(doc.createElement("div"), {
                className: "cb-note",
                textContent: `${ids.length} selected — values set here go to all of them.`,
            }));
        }
        if (looking) {
            root.append(Object.assign(doc.createElement("div"), {
                className: "cb-note",
                textContent: "Looking through this camera: the gate shows what it renders.",
            }));
        }

        const table = doc.createElement("div");
        table.className = "cb-table";
        root.append(table);
        const numberRow = (id, prop, comp, label, step, section = table) => {
            valid.add(id);
            const row = doc.createElement("div");
            row.className = "cb-row";
            row.dataset.ch = id;
            const tag = doc.createElement("span");
            tag.className = "cb-label";
            tag.textContent = label;
            tag.title = "Click to select · drag left/right to change (Shift ×10, Ctrl ×0.1)";
            const input = doc.createElement("input");
            input.className = "cb-val";
            input.spellcheck = false;
            input.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Enter") { input.blur(); }
                else if (e.key === "Escape") { input.dataset.cancel = "1"; input.blur(); }
            });
            input.addEventListener("focus", () => input.select());
            input.onchange = () => {
                if (input.dataset.cancel) { delete input.dataset.cancel; this._previzRenderChannels(); return; }
                // The live item: undo and redo replace the objects under unchanged rows.
                const now = this.previzSelectedItem() || item;
                // Typed into one of several selected channels: the value goes to all of them.
                const sel = this._cbSel && this._cbSel.has(id) && this._cbSel.size > 1 ? [...this._cbSel] : null;
                if (sel) { this.previzSetChannels(sel, input.value); return; }
                const v = this._cbParse(input.value, this._cbValue(now, prop, comp));
                if (v === null) { this._previzRenderChannels(); return; }
                this.previzSetChannel(prop, comp, v);
            };
            input.onblur = () => { if (input.dataset.cancel) { delete input.dataset.cancel; this._previzRenderChannels(); } };
            tag.addEventListener("pointerdown", (e) => this._cbLabelDown(e, id, prop, comp, step, tag));
            row.append(tag, input);
            section.append(row);
            ui.rows.set(id, { row, input, prop, comp, kind: "number" });
        };

        for (const [id, prop, comp, label, step] of transformChannels(item)) {
            numberRow(id, prop, comp, label, step);
        }

        // Visibility: on / off, as Maya writes it. Not keyable here.
        {
            valid.add("visible");
            const row = doc.createElement("div");
            row.className = "cb-row";
            row.dataset.ch = "visible";
            const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Visibility" });
            tag.addEventListener("pointerdown", (e) => this._cbLabelDown(e, "visible", null, null, 0, tag));
            const sel = doc.createElement("select");
            sel.className = "cb-val cb-sel";
            for (const v of ["on", "off"]) sel.append(Object.assign(doc.createElement("option"), { value: v, textContent: v }));
            sel.onchange = () => this.previzSetVisible(sel.value === "on");
            row.append(tag, sel);
            table.append(row);
            ui.rows.set("visible", { row, input: sel, kind: "visible" });
        }

        // The shape's own attributes, under a heading of their own.
        const shape = (title) => {
            root.append(Object.assign(doc.createElement("div"), { className: "cb-section", textContent: "SHAPES" }));
            root.append(Object.assign(doc.createElement("div"), { className: "cb-shape", textContent: title }));
            const t = doc.createElement("div");
            t.className = "cb-table";
            root.append(t);
            return t;
        };
        if (item.kind === "camera") {
            const t = shape(`${item.name}Shape`);
            numberRow("focal", "focal", null, "Focal Length", 0.5, t);
            numberRow(FOV[0], FOV[1], FOV[2], "Vertical FOV", FOV[4], t);
            numberRow("hfov", "hfov", null, "Horizontal FOV", 1, t);
            numberRow("res.0", "resolution", 0, "Resolution W", 1, t);
            numberRow("res.1", "resolution", 1, "Resolution H", 1, t);
            const row = doc.createElement("div");
            row.className = "cb-row";
            const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Preset" });
            const sel = doc.createElement("select");
            sel.className = "cb-val cb-sel";
            sel.append(Object.assign(doc.createElement("option"), { value: "", textContent: "—" }));
            for (const [label, w, h] of RESOLUTION_PRESETS) {
                sel.append(Object.assign(doc.createElement("option"), { value: `${w}x${h}`, textContent: `${label}  ${w}×${h}` }));
            }
            sel.onchange = () => {
                const [w, h] = sel.value.split("x").map(Number);
                if (w && h) this.previzSetResolution([w, h]);
            };
            row.append(tag, sel);
            t.append(row);
            ui.rows.set("preset", { row, input: sel, kind: "preset" });
            this._cbLensRows(ui, item, t, numberRow, valid);
            // Look At: off by default; on, the camera faces its target and the
            // target's numbers are channels (imageViewer_cameraAim.js).
            {
                valid.add("aim");
                const r2 = doc.createElement("div");
                r2.className = "cb-row";
                r2.dataset.ch = "aim";
                const tag2 = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Look At" });
                tag2.title = "On: the camera turns to face its target, which is dragged in the viewport while the camera is selected; Rotate Z is then its roll";
                const aimSel = doc.createElement("select");
                aimSel.className = "cb-val cb-sel";
                for (const v of ["off", "on"]) aimSel.append(Object.assign(doc.createElement("option"), { value: v, textContent: v }));
                aimSel.onchange = () => this.previzSetAimOn(aimSel.value === "on");
                r2.append(tag2, aimSel);
                t.append(r2);
                ui.rows.set("aim", { row: r2, input: aimSel, kind: "aim" });
            }
            if (aimOn(item)) {
                AIM_PROPS.forEach((p, i) => numberRow(p, p, null, AIM_LABELS[i], 0.1, t));
                // Turns the camera about the line to its target, in degrees.
                numberRow(ROLL_PROP, ROLL_PROP, null, "Roll", 1, t);
            }
        } else if (item.kind === "control" && item.control && item.control.type === "ik") {
            // 1 follows this IK control, 0 the limb's FK controls; keyable.
            const t = shape(`${item.name}Shape`);
            numberRow("ikfk", "ikfk", null, "IK Blend", 0.1, t);
        } else if (S.isLocator(item)) {
            // A locator's Size: the cross's half length (not its scale, which its children take).
            const t = shape(`${item.name}Shape`);
            const row = doc.createElement("div");
            row.className = "cb-row";
            row.dataset.ch = "locatorSize";
            const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Size" });
            const inp = doc.createElement("input");
            inp.className = "cb-val";
            inp.type = "number"; inp.min = "0.001"; inp.step = "0.1";
            inp.addEventListener("keydown", (e) => e.stopPropagation());
            inp.onchange = () => this.previzSetLocatorSize(Number(inp.value));
            this._cbScrub(tag, {
                step: 0.01,
                read: () => S.locatorSize(this.previzSelectedItem() || item),
                write: (v) => this.previzSetLocatorSize(Math.max(0.001, Math.round(v * 1000) / 1000), { live: true }),
                end: () => { this.previzEndDrag(); this.previzChanged(); },
            });
            row.append(tag, inp);
            t.append(row);
            ui.rows.set("locatorSize", { row, input: inp, kind: "locator" });
        } else if (item.kind === "imageplane") {
            const t = shape(`${item.name}Shape`);
            // Path: the picture, film or sequence on the plane - typed, pasted or picked (… ) - and the frame
            // its film or sequence starts on (Sebastian 2026-11-19: swap the plate after it came in).
            const pr = doc.createElement("div");
            pr.className = "cb-row cb-path-row";
            pr.dataset.ch = "planePath";
            pr.append(Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Path" }));
            const pin = doc.createElement("input");
            pin.className = "cb-val cb-path";
            pin.type = "text";
            pin.spellcheck = false;
            pin.placeholder = "a picture, a film or shot.####.exr";
            pin.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") pin.blur(); });
            pin.onchange = () => {
                const cur = S.planePath(this.previzSelectedItem() || item);
                if (pin.value.trim() && pin.value.trim() !== cur) {
                    this.previzSetPlanePath(null, pin.value).then((r) => { if (!r.ok) pin.value = cur; });
                } else pin.value = cur;
            };
            const browse = Object.assign(doc.createElement("button"), { className: "cb-path-pick", textContent: "…",
                title: "Pick a picture, a film or one frame of a sequence (the whole sequence is taken)" });
            browse.type = "button";
            browse.onclick = () => openFilePicker(this.container, {
                id: "imageplane", title: "Picture for the image plane", kind: "video", go: "Use",
                exts: PLANE_EXTS,
                note: "A picture, a film, or one frame of a numbered sequence (the whole sequence is taken).",
                onPick: (files) => this.previzSetPlanePath(null, files[0].path),
            });
            const box = Object.assign(doc.createElement("div"), { className: "cb-path-box" });
            box.append(pin, browse);
            pr.append(box);
            t.append(pr);
            ui.rows.set("planePath", { row: pr, input: pin, kind: "planePath" });

            const orow = doc.createElement("div");
            orow.className = "cb-row";
            orow.dataset.ch = "planeOffset";
            const oTag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Frame offset",
                title: "Scene frames before the film or sequence starts (its first frame is shown at this frame)" });
            const oin = doc.createElement("input");
            oin.className = "cb-val";
            oin.type = "number"; oin.step = "1";
            oin.addEventListener("keydown", (e) => e.stopPropagation());
            oin.onchange = () => this.previzSetPlane(null, { offset: Math.round(Number(oin.value) || 0) });
            this._cbScrub(oTag, {
                step: 0.2,
                read: () => S.planeSettings(this.previzSelectedItem() || item).offset,
                write: (v) => this.previzSetPlane(null, { offset: Math.round(v) }, { live: true }),
                end: () => { this.previzEndDrag(); this.previzChanged(); },
            });
            orow.append(oTag, oin);
            t.append(orow);
            ui.rows.set("offset", { row: orow, input: oin, kind: "plane", field: "offset" });

            const row = doc.createElement("div");
            row.className = "cb-row";
            const opTag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Opacity" });
            row.append(opTag);
            const op = doc.createElement("input");
            op.className = "cb-val";
            op.type = "number"; op.min = "0"; op.max = "1"; op.step = "0.05";
            op.addEventListener("keydown", (e) => e.stopPropagation());
            op.onchange = () => this.previzSetPlane(null, { opacity: Number(op.value) });
            this._cbScrub(opTag, {
                step: 0.01,
                read: () => S.planeSettings(this.previzSelectedItem() || item).opacity,
                write: (v) => this.previzSetPlane(null, { opacity: Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 }, { live: true }),
                end: () => { this.previzEndDrag(); this.previzChanged(); },
            });
            row.append(op);
            t.append(row);
            ui.rows.set("opacity", { row, input: op, kind: "plane", field: "opacity" });

            for (const [field, label] of [["lit", "Lit"], ["doubleSided", "Double-sided"]]) {
                const r2 = doc.createElement("div");
                r2.className = "cb-row";
                r2.append(Object.assign(doc.createElement("span"), { className: "cb-label", textContent: label }));
                const sel = doc.createElement("select");
                sel.className = "cb-val cb-sel";
                for (const v of ["on", "off"]) {
                    sel.append(Object.assign(doc.createElement("option"), { value: v, textContent: v }));
                }
                sel.onchange = () => this.previzSetPlane(null, { [field]: sel.value === "on" });
                r2.append(sel);
                t.append(r2);
                ui.rows.set(field, { row: r2, input: sel, kind: "plane", field });
            }
        } else if (item.kind === "primitive") {
            const t = shape(`${item.name}Shape`);
            const row = doc.createElement("div");
            row.className = "cb-row";
            const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Colour" });
            const swatch = doc.createElement("input");
            swatch.type = "color";
            swatch.className = "cb-color";
            swatch.oninput = () => {
                for (const one of this._cbItems()) if (one.kind === "primitive") one.color = swatch.value;
                // A colour change repaints the shape; it doesn't rebuild it.
                this.previzChanged({ reload: true });
            };
            row.append(tag, swatch);
            t.append(row);
            ui.rows.set("color", { row, input: swatch, kind: "color" });
        }
        // Custom attributes (any item; a rig control's usually) and a model's blendshapes:
        // the extra channels of imageViewer_scene3d.js, keyable like the rest.
        const attrs = Object.keys(item.attrs || {});
        if (attrs.length) {
            root.append(Object.assign(doc.createElement("div"), { className: "cb-section", textContent: "ATTRIBUTES" }));
            const t = doc.createElement("div");
            t.className = "cb-table";
            root.append(t);
            for (const n of attrs) numberRow(`attr:${n}`, `attr:${n}`, null, n, 0.1, t);
        }
        const morphs = this._cbMorphs(item);
        if (morphs.length) {
            root.append(Object.assign(doc.createElement("div"), { className: "cb-section", textContent: "BLENDSHAPES" }));
            const t = doc.createElement("div");
            t.className = "cb-table";
            root.append(t);
            for (const n of morphs) numberRow(`bs:${n}`, `bs:${n}`, null, n, 0.01, t);
        }
        // World settings, and a camera's reference (imageViewer_previzWorld.js).
        if (this._cbWorldRows) this._cbWorldRows(ui, item, shape, doc);
        // Constraints on the item: their weights and settings (imageViewer_previzConstraints.js).
        if (this._cbConstraintRows) this._cbConstraintRows(ui, item, doc, numberRow);
        if (item.kind !== "camera" && S.offsetOf(item) && !S.isGroundOffset(item)) {
            root.append(Object.assign(doc.createElement("div"), {
                className: "cb-note", textContent: "Transformations frozen (Edit → Freeze).",
            }));
        }

        // A channel selection outlives a redraw, as long as its rows are still here.
        this._cbSel = new Set([...(this._cbSel || [])].filter((id) => valid.has(id)));
    },

    /** Put the current numbers in, and colour what is keyed. */
    _cbFillValues(ui, item) {
        if (!item) return;
        if (this._cbConstraintTint) this._cbConstraintTint(ui, item);
        const doc = ui.root.ownerDocument;
        const focused = doc.activeElement;
        const frame = Math.round(this.currentFrame || 0);
        if (ui.name && focused !== ui.name) ui.name.value = item.name;
        for (const [id, r] of ui.rows) {
            r.row.classList.toggle("selected", !!(this._cbSel && this._cbSel.has(id)));
            if (r.kind === "number") {
                if (focused !== r.input) r.input.value = fmt(this._cbValue(item, r.prop, r.comp));
                const kp = keyProp(r.prop);
                const keys = kp ? S.track(item, kp) : [];
                r.row.classList.toggle("keyed", keys.length > 0);
                r.row.classList.toggle("keyed-now", keys.some((k) => k.f === frame));
                // Locked (Lock Selected): greyed out, nothing typed or dragged changes it.
                const locked = !!kp && this._cbItems().some((it) => S.isChannelLocked(it, kp, kp === r.prop ? r.comp : null));
                r.row.classList.toggle("locked", locked);
                r.input.readOnly = locked;
                r.input.title = locked ? "Locked: right-click › Unlock Selected" : "";
            } else if (r.kind === "visible") {
                r.input.value = item.visible === false ? "off" : "on";
            } else if (r.kind === "aim") {
                if (focused !== r.input) r.input.value = aimOn(item) ? "on" : "off";
            } else if (r.kind === "preset") {
                const [w, h] = S.cameraResolution(item);
                const match = RESOLUTION_PRESETS.find(([, pw, ph]) => pw === w && ph === h);
                if (focused !== r.input) r.input.value = match ? `${w}x${h}` : "";
            } else if (r.kind === "lensSel" || r.kind === "maskSel" || r.kind === "maskText") {
                if (focused !== r.input) r.input.value = r.read(item);
            } else if (r.kind === "color") {
                if (focused !== r.input) r.input.value = item.color || S.DEFAULT_COLOR;
            } else if (r.kind === "world") {
                this._cbWorldFill(r, item, focused);
            } else if (r.kind === "locator") {
                if (focused !== r.input) r.input.value = fmt(S.locatorSize(item));
            } else if (r.kind === "plane") {
                const opts = S.planeSettings(item);
                if (focused !== r.input) {
                    r.input.value = r.field === "opacity" || r.field === "offset" ? String(opts[r.field])
                        : (opts[r.field] ? "on" : "off");
                }
            } else if (r.kind === "planePath") {
                if (focused !== r.input && r.input.value !== S.planePath(item)) {
                    r.input.value = S.planePath(item);
                    r.input.title = r.input.value;
                    // The file's name is what tells plates apart: show the end of the path.
                    const inp = r.input;
                    inp.scrollLeft = inp.scrollWidth;
                    (inp.ownerDocument.defaultView || window).requestAnimationFrame(() => { inp.scrollLeft = inp.scrollWidth; });
                }
            }
        }
    },

    /** A model's blendshape (morph target) names, as its file has them. */
    _cbMorphs(item) {
        if (!item || item.kind !== "model") return [];
        const view = this._modelView && this._modelView();
        const names = view && view.rigMorphNames ? view.rigMorphNames(item.id) : [];
        return names.slice().sort((a, b) => a.localeCompare(b));
    },

    _cbValue(item, prop, comp) {
        if (prop === "resolution") return S.cameraResolution(item)[comp];
        if (item.kind === "camera" && (prop in CAM_DERIVED || CAM_STATIC.has(prop))) return this._cbLensValue(item, prop, comp);
        // What is on screen: every animation layer counted.
        const v = S.currentValue(this.previzScene(), item, prop, Math.round(this.currentFrame || 0));
        return comp === null ? v : v[comp];
    },

    /** A typed value: a number, or Maya's relative forms (+=2, -=2, *=2, /=2). */
    _cbParse(text, current) {
        const t = String(text || "").trim();
        const rel = /^([+\-*/])=\s*(-?\d*\.?\d+(?:e-?\d+)?)$/i.exec(t);
        if (rel) {
            const n = Number(rel[2]);
            return { "+": current + n, "-": current - n, "*": current * n, "/": n ? current / n : current }[rel[1]];
        }
        const n = Number(t);
        return t !== "" && Number.isFinite(n) ? n : null;
    },

    /** The items a channel edit reaches: everything selected. */
    _cbItems() {
        const scene = this.previzScene();
        return this.previzSelectedIds().map((id) => S.itemById(scene, id)).filter(Boolean);
    },

    /**
     * Set one channel to `value` on every selected item that has it.
     * `live` is for the middle of a scrub: one undo step for the whole drag,
     * and the full update when it ends.
     */
    previzSetChannel(prop, comp, value, { live = false, from = null } = {}) {
        const items = this._cbItems();
        if (!items.length) return;
        const label = prop === "fov" || prop === "hfov" ? "field of view" : prop === "focal" ? "focal length"
            : prop === "aperture" ? "film back" : prop === "shift" ? "lens shift" : prop === "clip" ? "clipping"
            : prop === "maskOpacity" ? "mask opacity" : prop === ROLL_PROP ? "roll" : isAimProp(prop) ? "look-at target"
            : S.isExtraProp(prop) ? "constraint weight" : prop;
        if (live) this.previzBeginDrag(`set ${label}`);
        else if (!this._previzDragging) this.previzSnapshot(`set ${label}`);
        const frame = Math.round(this.currentFrame || 0);
        const view = this._modelView();
        for (const item of items) {
            const start = from && from.has(item.id) ? from.get(item.id) : null;
            const v = start !== null && typeof value === "function" ? value(start) : value;
            if (prop in CAM_DERIVED || (CAM_STATIC.has(prop) && prop !== "resolution")) {
                if (item.kind !== "camera") continue;
                this._cbLensWrite(item, prop, comp, v, frame);
                continue;
            }
            if (prop === "resolution") {
                if (item.kind !== "camera") continue;
                const res = S.cameraResolution(item);
                res[comp] = Math.max(1, Math.round(v));
                item.resolution = res;
                continue;
            }
            if (isAimProp(prop)) {
                // A camera's look-at target: only on cameras that look at one.
                if (!aimOn(item)) continue;
                this._cbWrite(item, prop, v, frame);
                continue;
            }
            if (S.isExtraProp(prop)) {
                // A constraint's weight, a custom attribute or a blendshape:
                // only on the items that have it, held to its range.
                const w = parseWeightProp(prop);
                if (w && !constraintOf(item, w.cid)) continue;
                if (prop.startsWith("attr:") && !(item.attrs && item.attrs[prop.slice(5)])) continue;
                if (prop.startsWith("bs:") && item.kind !== "model") continue;
                const [lo, hi] = w ? weightRange(prop) : S.extraRange(item, prop);
                this._cbWrite(item, prop, Math.min(hi, Math.max(lo, v)), frame);
                continue;
            }
            if (prop === "ikfk") {
                if (!(item.kind === "control" && item.control && item.control.type === "ik")) continue;
                this._cbWrite(item, "ikfk", Math.min(1, Math.max(0, v)), frame);
                continue;
            }
            if (prop === "fov") {
                if (item.kind !== "camera") continue;
                this._cbWrite(item, "fov", Math.min(170, Math.max(1, v)), frame);
                continue;
            }
            if (item.kind === "camera" && (prop === "scale" || prop === "pivot")) continue;
            if (prop === "pivot") {
                // A pivot is where a thing turns, not where it is: the item
                // stays put and its position makes up the difference.
                if (!view._pivotShiftLocal || !view.libs) continue;
                const at = S.evaluateIn(this.previzScene(), item, frame);
                const now = at.pivot || [0, 0, 0];
                const e = [0, 0, 0];
                e[comp] = v - now[comp];
                const shifted = view._pivotShiftLocal(at, new view.libs.THREE.Vector3(...e));
                this._cbWrite(item, "position", shifted.position, frame);
                this._cbWrite(item, "pivot", shifted.pivot, frame);
                continue;
            }
            const next = S.currentValue(this.previzScene(), item, prop, frame).slice();
            next[comp] = v;
            this._cbWrite(item, prop, next, frame);
        }
        if (live) {
            view.applyFrame(this.currentFrame || 0);
            this._previzRenderChannels();
        } else {
            this.previzChanged();
        }
    },

    /**
     * Maya's Channel Box with several channels selected: what is typed into one
     * of them is set on every one (on every selected item). A relative form
     * (+=2, *=2) works from each channel's own value. One undo step.
     */
    previzSetChannels(channelIds, text) {
        const rows = (channelIds || []).map((ch) => this._cbUI && this._cbUI.rows.get(ch))
            .filter((r) => r && r.kind === "number");
        const items = this._cbItems();
        if (!rows.length || !items.length) return false;
        const probe = this._cbParse(text, 0);
        if (probe === null) { this._previzRenderChannels(); return false; }
        this.previzBeginDrag("set channels");
        for (const r of rows) {
            const from = new Map(items.map((it) => [it.id, this._cbValue(it, r.prop, r.comp)]));
            this.previzSetChannel(r.prop, r.comp, (start) => {
                const v = this._cbParse(text, start);
                return v === null ? start : v;
            }, { live: true, from });
        }
        this.previzEndDrag();
        this.previzChanged();
        return true;
    },

    /** Write a value the way every edit does: a key when it animates. */
    _cbWrite(item, prop, value, frame) {
        // Through the animation layers, as the gizmo does (scene3d.setPose).
        S.setPose(this.previzScene(), item, prop, frame, value, { key: this._previzAutokey });
    },

    previzSetVisible(on) {
        const items = this._cbItems();
        if (!items.length) return;
        this.previzSnapshot(on ? "show" : "hide");
        for (const item of items) item.visible = !!on;
        this.previzChanged();
    },

    /**
     * Switch a look-at target on or off, for every selected camera. On, the
     * target goes where the camera already looks (so nothing jumps) unless it
     * has one; off, the camera keeps the direction it faced, written into its
     * rotation at this frame.
     */
    previzSetAimOn(on) {
        const cams = this._cbItems().filter((it) => it.kind === "camera" && aimOn(it) !== !!on);
        if (!cams.length) return;
        this.previzSnapshot(on ? "look at on" : "look at off");
        const frame = Math.round(this.currentFrame || 0);
        const scene = this.previzScene();
        const view = this._modelView && this._modelView();
        for (const cam of cams) {
            if (on) {
                const had = cam.aim && Array.isArray(cam.aim.target);
                const at = S.evaluateIn(scene, cam, frame);
                // Looking through it, the orbit centre is where the view is looking.
                let d = null;
                if (view && view.controls && scene.activeCamera === cam.id) {
                    const t = view.controls.target, p = at.position;
                    d = Math.hypot(t.x - p[0], t.y - p[1], t.z - p[2]);
                }
                // Its roll now, so switching on does not tilt the picture.
                const entry = view && view._entries && view._entries.get(cam.id);
                const roll = entry && entry.root && view._aimRollOf ? view._aimRollOf(entry.root.quaternion) * 180 / Math.PI : 0;
                cam.aim = { on: true, target: had ? aimSettings(cam).target : defaultAimTarget({ position: at.position, rotation: at.rotation }, d),
                            roll: Math.round(roll * 1000) / 1000 };
            } else {
                // What the view shows now (the aimed direction), kept as its rotation.
                const entry = view && view._entries && view._entries.get(cam.id);
                if (entry && entry.root && view.readTransform) {
                    this._cbWrite(cam, "rotation", view.readTransform(entry.root, cam).rotation, frame);
                }
                cam.aim = { ...aimSettings(cam), on: false };
            }
        }
        this.previzChanged();
    },

    /** A camera's look-at target dragged in the viewport: its three channels. */
    previzSetAimTarget(id, target, { live = false } = {}) {
        const scene = this.previzScene();
        const cam = S.itemById(scene, id);
        if (!cam || !aimOn(cam) || !Array.isArray(target)) return;
        if (live) this.previzBeginDrag(`move ${cam.name}'s target`);
        else if (!this._previzDragging) this.previzSnapshot(`move ${cam.name}'s target`);
        const frame = Math.round(this.currentFrame || 0);
        AIM_PROPS.forEach((p, i) => this._cbWrite(cam, p, Number(target[i]) || 0, frame));
        if (live) this._previzRefreshFields();
        else this.previzChanged();
    },

    // ── A camera's lens, film back and mask (imageViewer_cameraLens.js) ─────────

    /** The rows under the resolution: film back, sensor fit, lens shift, clipping, the camera's own mask. */
    _cbLensRows(ui, item, t, numberRow, valid) {
        const doc = t.ownerDocument;
        const select = (id, label, title, options, read, write, kind = "lensSel") => {
            valid.add(id);
            const row = doc.createElement("div");
            row.className = "cb-row";
            row.dataset.ch = id;
            const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: label, title });
            const sel = doc.createElement("select");
            sel.className = "cb-val cb-sel";
            for (const [v, text] of options) sel.append(Object.assign(doc.createElement("option"), { value: v, textContent: text }));
            sel.onchange = () => write(sel.value);
            row.append(tag, sel);
            t.append(row);
            ui.rows.set(id, { row, input: sel, kind, read });
        };
        numberRow("aperture.0", "aperture", 0, "Film Back W", 0.1, t);
        numberRow("aperture.1", "aperture", 1, "Film Back H", 0.1, t);
        select("filmBack", "Film Back", "The camera body: its sensor or film gate in millimetres (the focal length is kept)",
            [["", "—"], ...L.FILM_BACKS.map(([label, w, h]) => [`${w}x${h}`, `${label}  ${w} × ${h}`])],
            (it) => { const [w, h] = L.lensSettings(it).aperture; const m = L.FILM_BACKS.find(([, a, b]) => a === w && b === h); return m ? `${w}x${h}` : ""; },
            (v) => { const [w, h] = v.split("x").map(Number); if (w && h) this.previzSetCameraLens({ aperture: [w, h] }); });
        select("sensorFit", "Sensor Fit", "How the film back meets a picture of another shape: the picture inside it as large as fits, or its width / height the picture's",
            [["fill", "fill"], ["horizontal", "horizontal"], ["vertical", "vertical"]],
            (it) => L.lensSettings(it).fit, (v) => this.previzSetCameraLens({ fit: v }));
        numberRow("shift.0", "shift", 0, "Lens Shift X", 0.01, t);
        numberRow("shift.1", "shift", 1, "Lens Shift Y", 0.01, t);
        numberRow("clip.0", "clip", 0, "Near Clip", 0.01, t);
        numberRow("clip.1", "clip", 1, "Far Clip", 10, t);
        for (const [id, text] of [["shift.0", "Moves the picture across the film back, as a share of its width (the view does not turn)"],
                                  ["shift.1", "Moves the picture up or down the film back, as a share of its height"],
                                  ["clip.0", "Nearest distance drawn; 0 = chosen from the scene's size"],
                                  ["clip.1", "Farthest distance drawn; 0 = chosen from the scene's size"]]) {
            const r = ui.rows.get(id);
            if (r) r.row.querySelector(".cb-label").title = text;
        }
        // The camera's own framing mask: drawn in its gate wherever it is looked through.
        select("mask", "Mask", "A framing mask of this camera's own, drawn in its gate wherever it is looked through; none = the viewer's",
            L.maskChoices(), (it) => (it.mask && it.mask.on ? it.mask.key : ""),
            (v) => this.previzSetCameraMask(v ? { on: true, key: v } : null), "maskSel");
        if (item.mask && item.mask.key === "custom") {
            valid.add("maskRatio");
            const row = doc.createElement("div");
            row.className = "cb-row";
            row.dataset.ch = "maskRatio";
            const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Mask Ratio", title: "2.39, 2.39:1, 21:9 ..." });
            const inp = doc.createElement("input");
            inp.className = "cb-val";
            inp.spellcheck = false;
            inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
            inp.onchange = () => { if (parseRatio(inp.value)) this.previzSetCameraMask({ custom: inp.value.trim() }); else this._previzRenderChannels(); };
            row.append(tag, inp);
            t.append(row);
            ui.rows.set("maskRatio", { row, input: inp, kind: "maskText", read: (it) => (it.mask && it.mask.custom) || "" });
        }
        if (item.mask && item.mask.on) numberRow("maskOpacity", "maskOpacity", null, "Mask Opacity", 0.05, t);
    },

    /** A lens row's value: the focal length and horizontal fov from the field of view, or a setting. */
    _cbLensValue(item, prop, comp) {
        const frame = Math.round(this.currentFrame || 0);
        const [rw, rh] = S.cameraResolution(item);
        const fov = () => S.currentValue(this.previzScene(), item, "fov", frame);
        const lens = L.lensSettings(item);
        if (prop === "focal") return L.focalFromFov(lens, rw / rh, fov());
        if (prop === "hfov") return L.horizontalFov(rw / rh, fov());
        if (prop === "aperture") return lens.aperture[comp];
        if (prop === "shift") return lens.shift[comp];
        if (prop === "clip") return comp ? lens.far : lens.near;
        if (prop === "maskOpacity") return item.mask ? item.mask.opacity : 0.75;
        return 0;
    },

    /** Write a lens row on one camera (inside previzSetChannel's undo step). */
    _cbLensWrite(item, prop, comp, v, frame) {
        const [rw, rh] = S.cameraResolution(item);
        const lens = L.lensSettings(item);
        if (prop === "focal") {
            if (!(v > 0)) return;
            this._cbWrite(item, "fov", Math.min(170, Math.max(1, L.fovFromFocal(lens, rw / rh, v))), frame);
        } else if (prop === "hfov") {
            this._cbWrite(item, "fov", Math.min(170, Math.max(1, L.verticalFov(rw / rh, Math.min(175, Math.max(1, v))))), frame);
        } else if (prop === "aperture") {
            const a = lens.aperture.slice();
            a[comp] = Math.max(0.2, v);
            this._cbLensSet(item, { aperture: a });
        } else if (prop === "shift") {
            const sh = lens.shift.slice();
            sh[comp] = v;
            this._cbLensSet(item, { shift: sh });
        } else if (prop === "clip") {
            this._cbLensSet(item, comp ? { far: Math.max(0, v) } : { near: Math.max(0, v) });
        } else if (prop === "maskOpacity") {
            if (!item.mask) return;
            item.mask = { ...item.mask, opacity: Math.min(1, Math.max(0, v)) };
            this._cbMaskRedraw();
        }
    },

    /**
     * Change a camera's lens settings. A new film back or sensor fit keeps the FOCAL LENGTH, as changing the
     * camera body behind the same lens does: the field of view (each key of it, when it is animated) follows.
     */
    _cbLensSet(item, patch) {
        const before = L.lensSettings(item);
        const after = L.lensSettings({ ...before, ...patch });
        const [rw, rh] = S.cameraResolution(item);
        const ar = rw / rh;
        const refit = (fov) => L.fovFromFocal(after, ar, L.focalFromFov(before, ar, fov));
        if (before.aperture.join() !== after.aperture.join() || before.fit !== after.fit) {
            const keys = S.track(item, "fov");
            if (keys.length) for (const k of keys) k.v = Math.min(170, Math.max(1, refit(k.v)));
            item.fov = Math.min(170, Math.max(1, refit(Number(item.fov) || 35)));
        }
        const clean = L.cleanLens(after);
        if (clean) item.lens = clean; else delete item.lens;
    },

    /** A lens setting for every selected camera (the film back and sensor fit menus); one undo step. */
    previzSetCameraLens(patch, ids = null) {
        const scene = this.previzScene();
        const cams = (ids ? ids.map((id) => S.itemById(scene, id)) : this._cbItems()).filter((it) => it && it.kind === "camera");
        if (!cams.length) return false;
        this.previzSnapshot("set lens");
        for (const cam of cams) this._cbLensSet(cam, patch);
        this.previzChanged();
        return true;
    },

    /** A camera's own framing mask (patch over what it has; null = none of its own); one undo step. */
    previzSetCameraMask(patch, ids = null) {
        const scene = this.previzScene();
        const cams = (ids ? ids.map((id) => S.itemById(scene, id)) : this._cbItems()).filter((it) => it && it.kind === "camera");
        if (!cams.length) return false;
        this.previzSnapshot("set camera mask");
        for (const cam of cams) {
            if (patch === null) { delete cam.mask; continue; }
            const next = cleanMaskState({ ...(cam.mask || (this._frameMask ? this._frameMask() : {})), ...patch, on: true });
            if (next.key === "custom" && !parseRatio(next.custom)) next.custom = "2.39:1";
            cam.mask = next;
        }
        this.previzChanged();
        this._cbMaskRedraw();
        return true;
    },

    _cbMaskRedraw() {
        if (this._frameMaskGate && this._fmGate !== undefined) this._frameMaskGate(this._fmGate);
    },

    /** A camera's picture size, for every selected camera. */
    previzSetResolution(res) {
        const cams = this._cbItems().filter((it) => it.kind === "camera");
        if (!cams.length) return;
        this.previzSnapshot("set resolution");
        for (const cam of cams) cam.resolution = res.map((v) => Math.max(1, Math.round(v)));
        this.previzChanged();
    },

    // ── Channel names: click to select, drag to scrub ────────────────────────

    _cbLabelDown(e, id, prop, comp, step, tag) {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX;
        const item = this.previzSelectedItem();
        let scrubbing = false;
        let from = null, channels = null;
        try { tag.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic event has no pointer */ }
        const move = (ev) => {
            const dx = ev.clientX - x0;
            if (!scrubbing) {
                if (Math.abs(dx) < 3 || prop === null) return;
                scrubbing = true;
                // The dragged channel and every other selected one scrub together.
                const sel = this._cbSel && this._cbSel.has(id) ? [...this._cbSel] : [id];
                channels = sel.map((ch) => this._cbUI && this._cbUI.rows.get(ch))
                    .filter((r) => r && r.kind === "number");
                from = channels.map((r) => new Map(this._cbItems().map((it) => [it.id, this._cbValue(it, r.prop, r.comp)])));
            }
            const scale = ev.shiftKey ? 10 : (ev.ctrlKey || ev.metaKey) ? 0.1 : 1;
            const delta = dx * step * scale;
            channels.forEach((r, i) => {
                this.previzSetChannel(r.prop, r.comp, (start) => start + delta, { live: true, from: from[i] });
            });
        };
        const up = (ev) => {
            tag.removeEventListener("pointermove", move);
            tag.removeEventListener("pointerup", up);
            tag.removeEventListener("pointercancel", up);
            if (scrubbing) {
                this.previzEndDrag();
                this.previzChanged();
                return;
            }
            if (!item) return;
            this._cbSelect(id, ev || e);
        };
        tag.addEventListener("pointermove", move);
        tag.addEventListener("pointerup", up);
        tag.addEventListener("pointercancel", up);
    },

    /**
     * The name of a row that is not a channel (a light's, a world's or an image plane's
     * settings) as a slider: dragged left / right it changes the number (Shift ×10,
     * Ctrl ×0.1), one undo step for the whole drag. `read()` is the number at the
     * press, `write(v)` sets it live, `end()` closes the drag.
     */
    _cbScrub(tag, { step, read, write, end }) {
        tag.classList.add("cb-scrub");
        tag.title = "Drag left/right to change (Shift ×10, Ctrl ×0.1)";
        tag.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const x0 = e.clientX;
            let from = null;
            try { tag.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic event has no pointer */ }
            const move = (ev) => {
                const dx = ev.clientX - x0;
                if (from === null) {
                    if (Math.abs(dx) < 3) return;
                    from = read();
                    if (from === null || !Number.isFinite(from)) { from = null; return; }
                }
                const scale = ev.shiftKey ? 10 : (ev.ctrlKey || ev.metaKey) ? 0.1 : 1;
                write(from + dx * step * scale);
            };
            const up = () => {
                tag.removeEventListener("pointermove", move);
                tag.removeEventListener("pointerup", up);
                tag.removeEventListener("pointercancel", up);
                if (from !== null) end();
            };
            tag.addEventListener("pointermove", move);
            tag.addEventListener("pointerup", up);
            tag.addEventListener("pointercancel", up);
        });
    },

    /** Maya's channel selection: click, Ctrl toggles, Shift extends a run. */
    _cbSelect(id, e) {
        const sel = this._cbSel || (this._cbSel = new Set());
        const order = this._cbUI ? [...this._cbUI.rows.keys()] : [id];
        if (e && e.shiftKey && this._cbAnchor && order.includes(this._cbAnchor)) {
            const a = order.indexOf(this._cbAnchor), b = order.indexOf(id);
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
                if (order[i] !== "preset" && order[i] !== "color") sel.add(order[i]);
            }
        } else if (e && (e.ctrlKey || e.metaKey)) {
            if (sel.has(id)) sel.delete(id); else sel.add(id);
            this._cbAnchor = id;
        } else {
            sel.clear();
            sel.add(id);
            this._cbAnchor = id;
        }
        this._previzRenderChannels();
    },

    /** The props behind the selected channels — what keying acts on. */
    _cbSelectedProps() {
        const props = new Set();
        for (const id of this._cbSel || []) {
            const r = this._cbUI && this._cbUI.rows.get(id);
            if (r && r.kind === "number" && keyProp(r.prop)) props.add(keyProp(r.prop));
        }
        return [...props];
    },

    _cbMenu(e) {
        e.preventDefault();
        e.stopPropagation();
        const row = e.target.closest && e.target.closest(".cb-row");
        if (row && row.dataset.ch && !(this._cbSel && this._cbSel.has(row.dataset.ch))) {
            this._cbSelect(row.dataset.ch, {});
        }
        const props = this._cbSelectedProps();
        const any = this.previzSelectedIds().length > 0;
        const chans = this._cbSelectedChannels();
        const items = this._cbItems();
        const anyLocked = chans.some((c) => items.some((it) => S.lockedChannels(it).includes(c)));
        const allLocked = chans.length > 0 && chans.every((c) => items.every((it) => S.lockedChannels(it).includes(c)));
        this._previzOpenMenu([
            { label: "Key Selected", disabled: !props.length, run: () => this.previzKeyChannels(props) },
            { label: "Key All", disabled: !any, run: () => this.previzKeyAll() },
            "-",
            { label: "Delete Key At Frame", disabled: !props.length, run: () => this.previzDeleteChannelKeys(props, { all: false }) },
            { label: "Delete All Keys", disabled: !props.length, run: () => this.previzDeleteChannelKeys(props, { all: true }) },
            "-",
            { label: "Lock Selected", disabled: !chans.length || allLocked, run: () => this.previzLockChannels(chans, true) },
            { label: "Unlock Selected", disabled: !anyLocked, run: () => this.previzLockChannels(chans, false) },
        ], e.clientX, e.clientY);
    },

    /** The selected channels a lock can hold: the number rows, by their ids ("position.0", "fov" ...). */
    _cbSelectedChannels() {
        const out = [];
        for (const id of this._cbSel || []) {
            const r = this._cbUI && this._cbUI.rows.get(id);
            if (r && r.kind === "number" && keyProp(r.prop)) out.push(keyProp(r.prop) === r.prop ? id : keyProp(r.prop));
        }
        return out;
    },

    /**
     * Lock or unlock channels on everything selected (Sebastian 2026-11-19: a
     * lock on any parameter of the Parameters panel). A locked channel keeps
     * its value: scene3d's setPose / keyPose put it back in every edit, and the
     * gizmo hides the handles of a locked axis. One undo step.
     */
    previzLockChannels(ids, on) {
        const items = this._cbItems();
        if (!items.length || !ids || !ids.length) return false;
        this.previzSnapshot(on ? "lock channels" : "unlock channels");
        for (const item of items) S.setChannelsLocked(item, ids, on);
        this.previzChanged();
        const view = this._modelView && this._modelView();
        if (view && view._syncSelection) view._syncSelection();
        return true;
    },

    /** Key the given props on everything selected, at the playhead. */
    previzKeyChannels(props) {
        const items = this._cbItems();
        if (!items.length || !props.length) return;
        if (this.previzLayerRefuseLocked && this.previzLayerRefuseLocked()) return;
        this.previzSnapshot("key selected");
        const frame = Math.round(this.currentFrame || 0);
        const scene = this.previzScene();
        for (const item of items) {
            for (const p of props) {
                if (p === "fov" && item.kind !== "camera") continue;
                if (p === "ikfk" && !(item.kind === "control" && item.control && item.control.type === "ik")) continue;
                if (p.startsWith("attr:") && !(item.attrs && item.attrs[p.slice(5)])) continue;
                if (p.startsWith("bs:") && item.kind !== "model") continue;
                if (isAimProp(p) && !aimOn(item)) continue;
                if (item.kind === "control" && (p === "scale" || p === "pivot")) continue;
                if (item.kind === "camera" && (p === "scale" || p === "pivot")) continue;
                S.keyPose(scene, item, p, frame, S.currentValue(scene, item, p, frame), this._previzEase || "smooth");
            }
        }
        this.previzChanged();
    },

    previzDeleteChannelKeys(props, { all = false } = {}) {
        const items = this._cbItems();
        if (!items.length || !props.length) return;
        if (this.previzLayerRefuseLocked && this.previzLayerRefuseLocked()) return;
        this.previzSnapshot(all ? "delete keys" : "delete key");
        const frame = Math.round(this.currentFrame || 0);
        const onLayer = !!S.activeLayerOf(this.previzScene());
        for (const item of items) {
            for (const p of props) {
                if (all && onLayer) {
                    // On an animation layer the channel simply leaves the layer.
                    S.setTrack(item, p, []);
                } else if (all) {
                    // The channel stops animating and keeps the value it has here.
                    const hold = S.valueAt(item, p, frame);
                    if (item.tracks) delete item.tracks[p];
                    S.setStaticValue(item, p, hold);
                } else {
                    S.removeKeyframe(item, frame, p);
                }
            }
        }
        this.previzChanged();
    },

    _previzHideChannels() {
        // The Parameters panel goes back to ComfyUI's node when the 3D tab is left (_cbParams).
    },
};
