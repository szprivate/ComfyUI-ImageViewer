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
import * as L from "./imageViewer_cameraLens.js";
import { FRAME_MASKS } from "./imageViewer_frameMasks.js";
import { AIM_LABELS, AIM_PROPS, ROLL_PROP, aimOn, aimSettings, defaultAimTarget, isAimProp } from "./imageViewer_cameraAim.js";

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
// Numbers of a camera's shape that are not channels of their own: the focal length and the horizontal field of
// view are the keyed `fov` read another way (LENS_PROPS), the rest are kept as they are (STATIC_PROPS).
const LENS_PROPS = new Set(["focal", "hfov"]);
const STATIC_PROPS = new Set(["resolution", "filmback", "clip", "maskOpacity"]);

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

// Which sections of the Channel Box are folded, by key (_cbGroup).
const FOLDS_KEY = "imageviewer.viewer.channelBoxFolds";
function readFolds() {
    try { const v = JSON.parse(localStorage.getItem(FOLDS_KEY) || "{}"); return v && typeof v === "object" ? v : {}; }
    catch (_) { return {}; }
}

const KIND_TITLES = {
    camera: "Camera", light: "Light", environment: "Environment", terrain: "Terrain", scatter: "Scatter",
    depthmesh: "Depth Mesh", imageplane: "Image Plane", model: "Model", group: "Group",
};
/** The heading of an item's own properties: "Camera Properties", "Box Properties", "IK Control Properties". */
export function cbPropsTitle(item) {
    if (!item) return "Properties";
    if (S.isLocator(item)) return "Locator Properties";
    if (item.kind === "control") return `${item.control && item.control.type === "ik" ? "IK " : ""}Control Properties`;
    if (item.kind === "light" && item.light && item.light.type) {
        const t = String(item.light.type);
        return `${t[0].toUpperCase()}${t.slice(1)} Light Properties`;
    }
    if (item.kind === "primitive") {
        const t = String((item.primitive && item.primitive.type) || "shape");
        return `${t[0].toUpperCase()}${t.slice(1)} Properties`;
    }
    return `${KIND_TITLES[item.kind] || "Object"} Properties`;
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
        const sig = item ? `${ids.join(",")}|${item.kind}|${looking}|${this._cbConstraintSig ? this._cbConstraintSig(item) : ""}|${Object.keys(item.attrs || {}).join(",")}|${this._cbMorphs(item).length}|${item.kind === "light" && item.light ? `${item.light.type}:${(item.light.fixture || {}).shape}` : ""}|${aimOn(item)}|${item.frameMask ? `${item.frameMask.on}:${item.frameMask.key}` : ""}` : "";
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

        // Transform, the item's own properties, attributes ...: sections that fold (Sebastian 2026-11-20).
        const table = this._cbGroup(root, "transform", "Transform");
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

        // The item's own properties, named by what it is ("Camera Properties"), in a section of their own;
        // `key` "reference" is a camera's reference picture (imageViewer_previzWorld.js).
        const shape = (key = "object") => key === "reference"
            ? this._cbGroup(root, "reference", "Camera Reference")
            : this._cbGroup(root, "object", cbPropsTitle(item));
        if (item.kind === "camera") {
            const t = shape();
            // A select row of the camera's shape: `opts` [[value, text]], `kind` names it in ui.rows.
            const selectRow = (id, label, opts, onchange, tip = "") => {
                valid.add(id);
                const r = doc.createElement("div");
                r.className = "cb-row";
                r.dataset.ch = id;
                const tg = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: label });
                if (tip) tg.title = tip;
                const sl = doc.createElement("select");
                sl.className = "cb-val cb-sel";
                for (const [v, txt] of opts) sl.append(Object.assign(doc.createElement("option"), { value: v, textContent: txt }));
                sl.onchange = () => onchange(sl.value);
                r.append(tg, sl);
                t.append(r);
                ui.rows.set(id, { row: r, input: sl, kind: id });
            };
            // The lens (imageViewer_cameraLens.js): the focal length and both fields of view are one number,
            // the keyed `fov`, read through the film back and how the picture lies on it.
            numberRow("focal", "focal", null, "Focal Length (mm)", 0.5, t);
            numberRow(FOV[0], FOV[1], FOV[2], "Vertical FOV", FOV[4], t);
            numberRow("hfov", "hfov", null, "Horizontal FOV", 1, t);
            selectRow("filmPreset", "Film Back", [["", "—"], ...L.FILMBACK_PRESETS.map(([n, w, h]) => [`${w}x${h}`, `${n}  ${w} × ${h}`])],
                      (v) => { const [w, h] = v.split("x").map(Number); if (w && h) this.previzSetFilmback([w, h]); });
            numberRow("fb.0", "filmback", 0, "Aperture W (mm)", 0.1, t);
            numberRow("fb.1", "filmback", 1, "Aperture H (mm)", 0.1, t);
            selectRow("filmFit", "Film Fit", L.FILM_FITS.map((f) => [f, L.FILM_FIT_LABELS[f]]), (v) => this.previzSetFilmFit(v),
                      "How the picture lies on the film back: its width on the film's width (Horizontal), its height on the film's height (Vertical), inside it (Fill) or around it (Overscan)");
            numberRow("clip.0", "clip", 0, "Near Clip", 0.01, t);
            numberRow("clip.1", "clip", 1, "Far Clip", 10, t);
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
            // Its own framing mask, drawn while it is looked through (imageViewer_frameMasks.js); "viewer" = the
            // viewer's mask (the button right of Toggle Overlays).
            selectRow("frameMask", "Framing Mask",
                      [["viewer", "As the viewer's"], ["off", "off"], ...FRAME_MASKS.map((m) => [m.key, m.label]), ["custom", "Own ratio…"]],
                      (v) => this.previzSetCameraMask(v),
                      "Dims the picture outside an aspect ratio while looking through this camera");
            if (item.frameMask && item.frameMask.on) {
                if (item.frameMask.key === "custom") {
                    valid.add("maskRatio");
                    const r = doc.createElement("div");
                    r.className = "cb-row";
                    r.dataset.ch = "maskRatio";
                    const tg = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Mask Ratio" });
                    const inp = doc.createElement("input");
                    inp.className = "cb-val";
                    inp.placeholder = "2.39 or 21:9";
                    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
                    inp.onchange = () => this.previzSetCameraMask("custom", { custom: inp.value });
                    r.append(tg, inp);
                    t.append(r);
                    ui.rows.set("maskRatio", { row: r, input: inp, kind: "maskRatio" });
                }
                numberRow("maskOpacity", "maskOpacity", null, "Mask Opacity", 0.05, t);
            }
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
            const t = shape();
            numberRow("ikfk", "ikfk", null, "IK Blend", 0.1, t);
        } else if (S.isLocator(item)) {
            // A locator's Size: the cross's half length (not its scale, which its children take).
            const t = shape();
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
            const t = shape();
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
            const t = shape();
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
            const t = this._cbGroup(root, "attributes", "Attributes");
            for (const n of attrs) numberRow(`attr:${n}`, `attr:${n}`, null, n, 0.1, t);
        }
        const morphs = this._cbMorphs(item);
        if (morphs.length) {
            const t = this._cbGroup(root, "blendshapes", "Blendshapes");
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

    /**
     * A section of the box that folds: its heading (a click folds or unfolds it, kept per viewer in
     * localStorage FOLDS_KEY by `key`), and the body the rows go into, which is returned.
     */
    _cbGroup(root, key, title) {
        const doc = root.ownerDocument;
        const wrap = Object.assign(doc.createElement("div"), { className: "cb-group" });
        wrap.dataset.group = key;
        const head = Object.assign(doc.createElement("div"), { className: "cb-section cb-group-head", title: "Click to fold or unfold" });
        head.append(Object.assign(doc.createElement("span"), { className: "cb-chev" }),
                    Object.assign(doc.createElement("span"), { className: "cb-group-title", textContent: title }));
        const body = Object.assign(doc.createElement("div"), { className: "cb-table cb-group-body" });
        wrap.classList.toggle("folded", !!readFolds()[key]);
        head.addEventListener("pointerdown", (e) => e.stopPropagation());
        head.onclick = () => {
            const folds = readFolds();
            const on = !wrap.classList.contains("folded");
            wrap.classList.toggle("folded", on);
            if (on) folds[key] = true; else delete folds[key];
            try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folds)); } catch (_) { /* private window */ }
        };
        wrap.append(head, body);
        root.append(wrap);
        return body;
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
                const keyable = !STATIC_PROPS.has(r.prop);
                const keys = keyable ? S.track(item, LENS_PROPS.has(r.prop) ? "fov" : r.prop) : [];
                r.row.classList.toggle("keyed", keys.length > 0);
                r.row.classList.toggle("keyed-now", keys.some((k) => k.f === frame));
                // Locked (Lock Selected): greyed out, nothing typed or dragged changes it.
                const locked = this._cbItems().some((it) => LENS_PROPS.has(r.prop) ? S.isChannelLocked(it, "fov", null)
                                                                                    : S.isChannelLocked(it, r.prop, r.comp));
                r.row.classList.toggle("locked", locked);
                r.input.readOnly = locked;
                r.input.title = locked ? "Locked: right-click › Unlock Selected" : "";
            } else if (r.kind === "filmPreset") {
                const [w, h] = L.filmbackOf(item);
                const match = L.FILMBACK_PRESETS.find(([, pw, ph]) => pw === w && ph === h);
                if (focused !== r.input) r.input.value = match ? `${w}x${h}` : "";
            } else if (r.kind === "filmFit") {
                if (focused !== r.input) r.input.value = L.filmFitOf(item);
            } else if (r.kind === "frameMask") {
                const m = item.frameMask;
                if (focused !== r.input) r.input.value = !m ? "viewer" : !m.on ? "off" : m.key;
            } else if (r.kind === "maskRatio") {
                if (focused !== r.input) r.input.value = (item.frameMask && item.frameMask.custom) || "";
            } else if (r.kind === "visible") {
                r.input.value = item.visible === false ? "off" : "on";
            } else if (r.kind === "aim") {
                if (focused !== r.input) r.input.value = aimOn(item) ? "on" : "off";
            } else if (r.kind === "preset") {
                const [w, h] = S.cameraResolution(item);
                const match = RESOLUTION_PRESETS.find(([, pw, ph]) => pw === w && ph === h);
                if (focused !== r.input) r.input.value = match ? `${w}x${h}` : "";
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
        if (prop === "filmback") return L.filmbackOf(item)[comp];
        if (prop === "clip") return L.clipOf(item)[comp];
        if (prop === "maskOpacity") return item.frameMask ? item.frameMask.opacity : 0.75;
        if (LENS_PROPS.has(prop)) {
            const fov = S.currentValue(this.previzScene(), item, "fov", Math.round(this.currentFrame || 0));
            const a = this._cbAspect(item);
            return prop === "focal" ? L.focalOf(item, fov, a) : L.horizontalFov(fov, a);
        }
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
        const label = prop === "fov" ? "field of view" : prop === ROLL_PROP ? "roll" : isAimProp(prop) ? "look-at target"
            : S.isExtraProp(prop) ? "constraint weight" : prop;
        if (live) this.previzBeginDrag(`set ${label}`);
        else if (!this._previzDragging) this.previzSnapshot(`set ${label}`);
        const frame = Math.round(this.currentFrame || 0);
        const view = this._modelView();
        for (const item of items) {
            const start = from && from.has(item.id) ? from.get(item.id) : null;
            const v = start !== null && typeof value === "function" ? value(start) : value;
            if (prop === "filmback" || prop === "clip") {
                if (item.kind !== "camera") continue;
                if (prop === "filmback") {
                    const fb = L.filmbackOf(item);
                    fb[comp] = Math.min(200, Math.max(0.1, v));
                    this._cbFilmback(item, fb, frame);
                } else {
                    const c = L.clipOf(item);
                    c[comp] = Math.max(1e-5, v);
                    if (comp === 0 && c[1] <= c[0]) c[1] = c[0] * 10;
                    if (comp === 1 && c[1] <= c[0]) c[1] = c[0] * 1.001;
                    item.clip = L.clipOf({ clip: c });
                }
                continue;
            }
            if (prop === "maskOpacity") {
                if (item.kind !== "camera" || !item.frameMask) continue;
                item.frameMask = { ...item.frameMask, opacity: Math.min(1, Math.max(0, v)) };
                continue;
            }
            if (LENS_PROPS.has(prop)) {
                // The focal length or the horizontal field of view: written as the keyed vertical one.
                if (item.kind !== "camera") continue;
                const a = this._cbAspect(item);
                const fov = prop === "focal" ? L.fovFromFocal(item, Math.max(0.1, v), a) : L.fovFromHorizontal(v, a);
                this._cbWrite(item, "fov", Math.min(170, Math.max(1, fov)), frame);
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

    /** A camera's picture size, for every selected camera. */
    /** The picture's shape (width / height) of a camera. */
    _cbAspect(item) {
        const [w, h] = S.cameraResolution(item);
        return w / h;
    },

    /**
     * A new film back on a camera. As a camera body is changed for another: the lens stays, so the focal length
     * is kept and the field of view follows - unless the field of view is keyed, which is then kept.
     */
    _cbFilmback(item, fb, frame) {
        const keyed = S.track(item, "fov").length > 0;
        const a = this._cbAspect(item);
        const focal = L.focalOf(item, S.currentValue(this.previzScene(), item, "fov", frame), a);
        item.filmback = L.filmbackOf({ filmback: fb });
        if (!keyed) item.fov = Math.min(170, Math.max(1, L.fovFromFocal(item, focal, a)));
    },

    previzSetFilmback(fb) {
        const cams = this._cbItems().filter((it) => it.kind === "camera");
        if (!cams.length) return;
        this.previzSnapshot("set film back");
        const frame = Math.round(this.currentFrame || 0);
        for (const cam of cams) this._cbFilmback(cam, fb, frame);
        this.previzChanged();
    },

    /** How the picture lies on the film back; keeps the focal length as a new film back does. */
    previzSetFilmFit(fit) {
        if (!L.FILM_FITS.includes(fit)) return;
        const cams = this._cbItems().filter((it) => it.kind === "camera");
        if (!cams.length) return;
        this.previzSnapshot("set film fit");
        const frame = Math.round(this.currentFrame || 0);
        for (const cam of cams) {
            const keyed = S.track(cam, "fov").length > 0;
            const a = this._cbAspect(cam);
            const focal = L.focalOf(cam, S.currentValue(this.previzScene(), cam, "fov", frame), a);
            if (fit === "horizontal") delete cam.filmFit; else cam.filmFit = fit;
            if (!keyed) cam.fov = Math.min(170, Math.max(1, L.fovFromFocal(cam, focal, a)));
        }
        this.previzChanged();
    },

    /**
     * A camera's own framing mask: "viewer" (none of its own: the viewer's), "off", a preset's key or "custom"
     * (`patch.custom` its ratio). Kept opacity, line and label carry over.
     */
    previzSetCameraMask(key, patch = {}) {
        const cams = this._cbItems().filter((it) => it.kind === "camera");
        if (!cams.length) return;
        this.previzSnapshot("set framing mask");
        for (const cam of cams) {
            if (key === "viewer") { delete cam.frameMask; continue; }
            const was = cam.frameMask || {};
            const base = this._frameMask ? this._frameMask() : {};
            cam.frameMask = L.readCameraMask({
                opacity: was.opacity ?? base.opacity, line: was.line ?? base.line, label: was.label ?? base.label,
                custom: was.custom || "",
                ...(key === "off" ? { on: false, key: was.key || base.key } : { on: true, key }),
                ...patch,
            });
        }
        this.previzChanged();
        if (this.frameMaskSync) { this._fmSig = null; this.frameMaskSync(); }
    },

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
            if (r && r.kind === "number" && !STATIC_PROPS.has(r.prop)) props.add(LENS_PROPS.has(r.prop) ? "fov" : r.prop);
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
            if (r && r.kind === "number" && !STATIC_PROPS.has(r.prop)) out.push(LENS_PROPS.has(r.prop) ? "fov" : id);
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
