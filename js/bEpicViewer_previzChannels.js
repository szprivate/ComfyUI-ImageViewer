// bEpicViewer_previzChannels.js
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
import * as S from "./bEpicViewer_scene3d.js";

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
    return [...TRANSFORM, ...PIVOT];
}

export const PrevizChannelsMixin = {

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
        if (!this.isPanelDocked || !this.isPanelDocked("channels")) return;
        const ui = (this._cbUI && this._cbUI.root.isConnected) ? this._cbUI : this._cbBuild();
        if (!ui) return;
        const item = this.previzSelectedItem();
        const ids = this.previzSelectedIds();
        const scene = this.previzScene();
        const looking = !!(item && scene && scene.activeCamera === item.id);
        // Everything that decides WHICH rows there are. Values are not in it.
        const sig = item ? `${ids.join(",")}|${item.kind}|${looking}` : "";
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
            numberRow(FOV[0], FOV[1], FOV[2], FOV[3], FOV[4], t);
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
        if (item.kind !== "camera" && S.offsetOf(item)) {
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
        const doc = ui.root.ownerDocument;
        const focused = doc.activeElement;
        const frame = Math.round(this.currentFrame || 0);
        if (ui.name && focused !== ui.name) ui.name.value = item.name;
        for (const [id, r] of ui.rows) {
            r.row.classList.toggle("selected", !!(this._cbSel && this._cbSel.has(id)));
            if (r.kind === "number") {
                if (focused !== r.input) r.input.value = fmt(this._cbValue(item, r.prop, r.comp));
                const keyable = r.prop !== "resolution";
                const keys = keyable ? S.track(item, r.prop) : [];
                r.row.classList.toggle("keyed", keys.length > 0);
                r.row.classList.toggle("keyed-now", keys.some((k) => k.f === frame));
            } else if (r.kind === "visible") {
                r.input.value = item.visible === false ? "off" : "on";
            } else if (r.kind === "preset") {
                const [w, h] = S.cameraResolution(item);
                const match = RESOLUTION_PRESETS.find(([, pw, ph]) => pw === w && ph === h);
                if (focused !== r.input) r.input.value = match ? `${w}x${h}` : "";
            } else if (r.kind === "color") {
                if (focused !== r.input) r.input.value = item.color || S.DEFAULT_COLOR;
            }
        }
    },

    _cbValue(item, prop, comp) {
        if (prop === "resolution") return S.cameraResolution(item)[comp];
        const v = S.valueAt(item, prop, Math.round(this.currentFrame || 0));
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
        const label = prop === "fov" ? "field of view" : prop;
        if (live) this.previzBeginDrag(`set ${label}`);
        else if (!this._previzDragging) this.previzSnapshot(`set ${label}`);
        const frame = Math.round(this.currentFrame || 0);
        const view = this._modelView();
        for (const item of items) {
            const start = from && from.has(item.id) ? from.get(item.id) : null;
            const v = start !== null && typeof value === "function" ? value(start) : value;
            if (prop === "resolution") {
                if (item.kind !== "camera") continue;
                const res = S.cameraResolution(item);
                res[comp] = Math.max(1, Math.round(v));
                item.resolution = res;
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
                const at = S.evaluate(item, frame);
                const now = at.pivot || [0, 0, 0];
                const e = [0, 0, 0];
                e[comp] = v - now[comp];
                const shifted = view._pivotShiftLocal(at, new view.libs.THREE.Vector3(...e));
                this._cbWrite(item, "position", shifted.position, frame);
                this._cbWrite(item, "pivot", shifted.pivot, frame);
                continue;
            }
            const next = S.valueAt(item, prop, frame).slice();
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

    /** Write a value the way every edit does: a key when it animates. */
    _cbWrite(item, prop, value, frame) {
        if (this._previzAutokey || S.isAnimated(item, prop)) S.setKeyframe(item, prop, frame, value);
        else item[prop] = Array.isArray(value) ? value.slice() : value;
    },

    previzSetVisible(on) {
        const items = this._cbItems();
        if (!items.length) return;
        this.previzSnapshot(on ? "show" : "hide");
        for (const item of items) item.visible = !!on;
        this.previzChanged();
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
                if (Math.abs(dx) < 3 || prop === null || prop === "resolution") return;
                scrubbing = true;
                // The dragged channel and every other selected one scrub together.
                const sel = this._cbSel && this._cbSel.has(id) ? [...this._cbSel] : [id];
                channels = sel.map((ch) => this._cbUI && this._cbUI.rows.get(ch))
                    .filter((r) => r && r.kind === "number" && r.prop !== "resolution");
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
            if (r && r.kind === "number" && r.prop !== "resolution") props.add(r.prop);
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
        this._previzOpenMenu([
            { label: "Key Selected", disabled: !props.length, run: () => this.previzKeyChannels(props) },
            { label: "Key All", disabled: !any, run: () => this.previzKeyAll() },
            "-",
            { label: "Delete Key At Frame", disabled: !props.length, run: () => this.previzDeleteChannelKeys(props, { all: false }) },
            { label: "Delete All Keys", disabled: !props.length, run: () => this.previzDeleteChannelKeys(props, { all: true }) },
        ], e.clientX, e.clientY);
    },

    /** Key the given props on everything selected, at the playhead. */
    previzKeyChannels(props) {
        const items = this._cbItems();
        if (!items.length || !props.length) return;
        this.previzSnapshot("key selected");
        const frame = Math.round(this.currentFrame || 0);
        for (const item of items) {
            for (const p of props) {
                if (p === "fov" && item.kind !== "camera") continue;
                if (item.kind === "camera" && (p === "scale" || p === "pivot")) continue;
                S.setKeyframe(item, p, frame, S.valueAt(item, p, frame), this._previzEase || "smooth");
            }
        }
        this.previzChanged();
    },

    previzDeleteChannelKeys(props, { all = false } = {}) {
        const items = this._cbItems();
        if (!items.length || !props.length) return;
        this.previzSnapshot(all ? "delete keys" : "delete key");
        const frame = Math.round(this.currentFrame || 0);
        for (const item of items) {
            for (const p of props) {
                if (all) {
                    // The channel stops animating and keeps the value it has here.
                    const hold = S.valueAt(item, p, frame);
                    if (item.tracks) delete item.tracks[p];
                    item[p] = Array.isArray(hold) ? hold.slice() : hold;
                } else {
                    S.removeKeyframe(item, frame, p);
                }
            }
        }
        this.previzChanged();
    },

    _previzHideChannels() {
        if (this.isPanelDocked && this.isPanelDocked("channels")) this.setPanelDocked("channels", false);
    },
};
