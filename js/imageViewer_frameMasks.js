// imageViewer_frameMasks.js
// Framing masks: the picture dimmed outside a chosen aspect ratio (4:3, 16:9,
// 2.39:1, 9:16 ...), with a line at its edge and the ratio written in its
// corner, so a shot can be judged for a delivery format it was not made in.
// Sebastian 2026-11-12. Clean-room: plain DOM, nothing from another program.
//
// One mask at a time, its opacity set in the menu (0 = only the line), kept
// per viewer in localStorage STORE. Drawn in three places, the same way:
//  - the Viewer (and a cut's tab in the Edit space, which plays through the
//    same layers): over the picture, fitted inside it (`#frame-mask` in the
//    viewport, placed from updateImageFrame's rectangle and the zoom / pan);
//  - the 3D space: inside the camera gate while looking through a camera,
//    else over the whole view (Model3DView's `onGate` hook);
//  - not over Paint, Motion, Comp, the side by side view or with the
//    overlays off (imageViewer.css).
//
// The arithmetic (`parseRatio`, `maskRect`) is pure and tested under node
// (tests/test_frame_masks.mjs).
import { setEditIcon } from "./imageViewer_editIcons.js";

const STORE = "imageviewer.viewer.frameMasks";

/** The presets, in the menu's order: width / height. */
export const FRAME_MASKS = [
    { key: "1.33",  label: "4:3",           ratio: 4 / 3 },
    { key: "1.66",  label: "1.66:1",        ratio: 1.66 },
    { key: "1.78",  label: "16:9",          ratio: 16 / 9 },
    { key: "1.85",  label: "1.85:1",        ratio: 1.85 },
    { key: "2.00",  label: "2:1",           ratio: 2 },
    { key: "2.33",  label: "21:9",          ratio: 21 / 9 },
    { key: "2.39",  label: "2.39:1",        ratio: 2.39 },
    { key: "1.00",  label: "1:1",           ratio: 1 },
    { key: "0.80",  label: "4:5",           ratio: 4 / 5 },
    { key: "0.56",  label: "9:16",          ratio: 9 / 16 },
];

export const DEFAULT_STATE = { on: false, key: "2.39", custom: "", opacity: 0.75, line: true, label: true };

/**
 * A ratio as typed: "2.39", "2.39:1", "21:9", "21x9", "21/9". null when it is
 * not one (or is absurd: kept between 1:10 and 10:1).
 */
export function parseRatio(text) {
    const s = String(text == null ? "" : text).trim().replace(",", ".");
    if (!s) return null;
    const m = s.match(/^(\d*\.?\d+)\s*(?:[:x×/]\s*(\d*\.?\d+))?$/i);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] === undefined ? 1 : Number(m[2]);
    if (!(a > 0) || !(b > 0)) return null;
    const r = a / b;
    return r >= 0.1 && r <= 10 ? r : null;
}

/** The ratio a state stands for, and how to write it. null = no mask. */
export function maskOf(st) {
    if (!st || !st.on) return null;
    if (st.key === "custom") {
        const r = parseRatio(st.custom);
        return r ? { ratio: r, label: labelOf(st.custom, r) } : null;
    }
    const p = FRAME_MASKS.find((m) => m.key === st.key);
    return p ? { ratio: p.ratio, label: p.label } : null;
}

function labelOf(text, r) {
    const s = String(text).trim();
    return /[:x×/]/i.test(s) ? s.replace(/\s+/g, "").replace(/[x×/]/i, ":") : `${+r.toFixed(3)}:1`;
}

/**
 * The part of a w x h box a mask of `ratio` keeps: as large as fits, centred.
 * A box already of that shape (within half a pixel) is all kept.
 */
export function maskRect(w, h, ratio) {
    if (!(w > 0) || !(h > 0) || !(ratio > 0)) return null;
    if (w / h > ratio) {
        const mw = h * ratio;
        return { x: (w - mw) / 2, y: 0, w: mw, h };
    }
    const mh = w / ratio;
    return { x: 0, y: (h - mh) / 2, w, h: mh };
}

/** Clean a kept state (anything missing or out of range is the default's). */
export function cleanState(kept) {
    const st = { ...DEFAULT_STATE };
    if (!kept || typeof kept !== "object") return st;
    st.on = kept.on === true;
    if (kept.key === "custom" || FRAME_MASKS.some((m) => m.key === kept.key)) st.key = kept.key;
    if (typeof kept.custom === "string") st.custom = kept.custom.slice(0, 20);
    const op = Number(kept.opacity);
    if (Number.isFinite(op)) st.opacity = Math.min(1, Math.max(0, op));
    st.line = kept.line !== false;
    st.label = kept.label !== false;
    return st;
}

// ── the panel ────────────────────────────────────────────────────────────────

export const FrameMasksMixin = {

    /** The state (loaded once). */
    _frameMask() {
        if (this._fmState) return this._fmState;
        let kept = null;
        try { kept = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (_) { kept = null; }
        this._fmState = cleanState(kept);
        return this._fmState;
    },

    /** Change the state (a patch), keep it, redraw every mask and the button. */
    frameMaskSet(patch) {
        const st = Object.assign(this._frameMask(), patch || {});
        Object.assign(st, cleanState(st));
        try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (_) {}
        this._fmSig = null;
        this._fmGateSig = null;
        this.frameMaskSync();
        this._frameMaskDrawBtn();
        const menu = this.container && this.container.querySelector("#frame-mask-menu");
        if (menu && menu._sync) menu._sync();
    },

    /** On / off (the button, Shift+G). Switching on with a custom ratio that does not read takes the default preset. */
    frameMaskToggle(on) {
        const st = this._frameMask();
        const want = on === undefined ? !st.on : !!on;
        const patch = { on: want };
        if (want && st.key === "custom" && !parseRatio(st.custom)) patch.key = DEFAULT_STATE.key;
        this.frameMaskSet(patch);
    },

    /** The button and its caret, right of Toggle Overlays (made here, not in the markup, like the sound switches). */
    _initFrameMasks() {
        const sr = this.shadowRoot;
        if (!sr || !this.viewport) return;
        let btn = sr.getElementById("frame-mask-btn");
        let more = sr.getElementById("frame-mask-more-btn");
        if (!btn) {
            btn = document.createElement("button");
            btn.id = "frame-mask-btn";
            btn.className = "sprite-icon";
            more = document.createElement("button");
            more.id = "frame-mask-more-btn";
            more.className = "audio-caret";
            more.textContent = "▾";
            more.title = "Framing mask: the ratio and its opacity";
            const after = this.overlaysBtn || sr.getElementById("layout-btn");
            if (after && after.parentNode) {
                after.parentNode.insertBefore(btn, after.nextSibling);
                btn.parentNode.insertBefore(more, btn.nextSibling);
            } else if (this.refreshBtn && this.refreshBtn.parentNode) {
                this.refreshBtn.parentNode.insertBefore(btn, this.refreshBtn);
                this.refreshBtn.parentNode.insertBefore(more, this.refreshBtn);
            }
        }
        btn.onclick = () => this.frameMaskToggle();
        btn.oncontextmenu = (e) => this._frameMaskMenu(e, more);
        more.onclick = (e) => this._frameMaskMenu(e, more);
        this.frameMaskBtn = btn;
        this.frameMaskMoreBtn = more;

        let layer = this.viewport.querySelector("#frame-mask");
        if (!layer) {
            layer = document.createElement("div");
            layer.id = "frame-mask";
            layer.className = "frame-mask";
            this.viewport.appendChild(layer);
        }
        this._fmLayer = layer;
        this._frameMaskDrawBtn();
        this.frameMaskSync();
    },

    _frameMaskDrawBtn() {
        const btn = this.frameMaskBtn;
        if (!btn) return;
        const st = this._frameMask();
        const m = maskOf(st);
        if (btn.dataset.icon !== "frameMask") setEditIcon(btn, "frameMask");
        btn.classList.toggle("active", !!m);
        btn.setAttribute("aria-pressed", m ? "true" : "false");
        btn.title = m
            ? `Framing mask ${m.label} is on: click to switch it off (Shift+G). Right-click or ▾: ratio and opacity`
            : "Framing mask: dim the picture outside an aspect ratio - 16:9, 2.39:1, 9:16 ... (Shift+G). Right-click or ▾ to choose";
    },

    /**
     * Fill a mask element for a box of w x h: a clip of the box's size with the
     * kept part as a hole whose shadow is the shade, its line and its label.
     * A signature on the element skips a redraw that would change nothing.
     */
    _frameMaskFill(el, w, h) {
        const m = maskOf(this._frameMask());
        const r = m && maskRect(w, h, m.ratio);
        if (!r) { el.style.display = "none"; el.dataset.ratio = ""; return; }
        const st = this._frameMask();
        const sig = `${w}|${h}|${m.ratio}|${st.opacity}|${st.line}|${st.label}|${m.label}`;
        el.style.display = "block";
        if (el._fmSig === sig) return;
        el._fmSig = sig;
        let hole = el.firstChild;
        if (!hole) {
            const doc = el.ownerDocument || document;
            hole = doc.createElement("div");
            hole.className = "frame-mask-hole";
            const label = doc.createElement("span");
            label.className = "frame-mask-label";
            hole.append(label);
            el.append(hole);
        }
        const px = (v) => `${Math.round(v * 100) / 100}px`;
        Object.assign(hole.style, { left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) });
        hole.style.boxShadow = `0 0 0 ${Math.ceil(Math.max(w, h) * 2)}px rgba(0, 0, 0, ${st.opacity})`;
        hole.classList.toggle("no-line", !st.line);
        const label = hole.firstChild;
        label.textContent = m.label;
        label.style.display = st.label ? "" : "none";
        el.dataset.ratio = String(m.ratio);
    },

    /**
     * The Viewer's mask, over the picture as it is drawn: the picture's box from
     * updateImageFrame (untransformed) taken through the zoom and pan, so the
     * line stays one pixel at any zoom. Called from updateImageFrame, which runs
     * on every zoom, pan, resize and new picture.
     */
    frameMaskSync(box) {
        const layer = this._fmLayer;
        if (layer) {
            const b = box || this._fmBox;
            if (box) this._fmBox = box;
            const m = maskOf(this._frameMask());
            if (!m || !b || !b.w || !b.h) layer.style.display = "none";
            else {
                const z = Number(this.zoom) || 1;
                const w = b.w * z, h = b.h * z;
                const cx = b.x + b.w / 2 + (Number(this.panX) || 0);
                const cy = b.y + b.h / 2 + (Number(this.panY) || 0);
                layer.style.left = `${cx - w / 2}px`;
                layer.style.top = `${cy - h / 2}px`;
                layer.style.width = `${w}px`;
                layer.style.height = `${h}px`;
                this._frameMaskFill(layer, w, h);
            }
        }
        // The 3D view's, from the gate it last told.
        if (this._model3d && this._fmGate !== undefined) this._frameMaskGate(this._fmGate);
    },

    /** The picture went away (none, a side by side view): no box to mask. */
    frameMaskClear() {
        this._fmBox = null;
        if (this._fmLayer) this._fmLayer.style.display = "none";
    },

    /**
     * Model3DView's `onGate`: `g` = the rectangle to mask in the stage's pixels
     * (the camera gate, or the whole stage), or null (split panes). The mask
     * goes inside the stage, under the gate's frame and label.
     */
    _frameMaskGate(g) {
        // Kept on the panel: the view tells its first gate while it is still being made.
        this._fmGate = g || null;
        const view = this._model3d;
        if (!view || !view.stage) return;
        let el = view._fmEl;
        if (!el || el.parentNode !== view.stage) {
            const doc = view.stage.ownerDocument || document;
            el = doc.createElement("div");
            el.className = "frame-mask frame-mask-3d";
            view.stage.appendChild(el);
            view._fmEl = el;
        }
        if (!g || !g.w || !g.h || !maskOf(this._frameMask())) { el.style.display = "none"; return; }
        Object.assign(el.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
        this._frameMaskFill(el, g.w, g.h);
    },

    /** The menu: on / off, the ratios, a ratio of one's own, opacity, line and label. */
    _frameMaskMenu(ev, anchor) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        const host = this.container;
        if (!host) return null;
        const doc = host.ownerDocument;
        const old = host.querySelector("#frame-mask-menu");
        if (old) { old._close ? old._close() : old.remove(); return null; }
        const st = () => this._frameMask();
        const menu = doc.createElement("div");
        menu.id = "frame-mask-menu";
        menu.className = "thumb-ctx-menu overlays-menu frame-mask-menu";
        menu.addEventListener("mousedown", (e) => e.stopPropagation());
        menu.addEventListener("pointerdown", (e) => e.stopPropagation());
        menu.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
        // Typing a ratio is not a viewer key.
        menu.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
        const syncs = [];
        const row = (cls) => { const el = doc.createElement("div"); el.className = cls; menu.append(el); return el; };
        const sep = () => row("overlays-menu-sep");

        // On / off.
        const onRow = doc.createElement("label");
        onRow.className = "overlays-menu-row all";
        onRow.dataset.mask = "on";
        const onText = doc.createElement("span");
        onText.textContent = "Framing mask";
        const onBox = doc.createElement("input");
        onBox.type = "checkbox";
        onBox.className = "overlays-switch";
        onBox.onchange = () => this.frameMaskToggle(onBox.checked);
        onRow.append(onText, onBox);
        menu.append(onRow);
        syncs.push(() => { onBox.checked = !!maskOf(st()); });
        sep();

        // The ratios: a grid of buttons, the one in use lit.
        const grid = row("frame-mask-grid");
        for (const p of FRAME_MASKS) {
            const b = doc.createElement("button");
            b.type = "button";
            b.className = "frame-mask-pick";
            b.dataset.mask = p.key;
            b.textContent = p.label;
            b.title = `${p.label} (${p.ratio.toFixed(2)}:1)`;
            b.onclick = () => this.frameMaskSet({ on: true, key: p.key });
            grid.append(b);
            syncs.push(() => b.classList.toggle("on", st().on && st().key === p.key));
        }
        // A ratio of one's own.
        const custom = row("frame-mask-custom");
        const cLabel = doc.createElement("span");
        cLabel.textContent = "Custom";
        const cInput = doc.createElement("input");
        cInput.type = "text";
        cInput.className = "frame-mask-input";
        cInput.placeholder = "e.g. 2.2 or 3:2";
        cInput.value = st().custom || "";
        const tryCustom = () => {
            const ok = !!parseRatio(cInput.value);
            cInput.classList.toggle("bad", !ok && cInput.value.trim() !== "");
            if (ok) this.frameMaskSet({ on: true, key: "custom", custom: cInput.value.trim() });
        };
        cInput.oninput = tryCustom;
        cInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); tryCustom(); } };
        custom.append(cLabel, cInput);
        syncs.push(() => custom.classList.toggle("on", st().on && st().key === "custom"));
        sep();

        // Opacity.
        const opRow = row("frame-mask-opacity");
        const opText = doc.createElement("span");
        opText.textContent = "Opacity";
        const op = doc.createElement("input");
        op.type = "range";
        op.min = "0"; op.max = "100"; op.step = "1";
        op.className = "frame-mask-slider";
        const opVal = doc.createElement("span");
        opVal.className = "frame-mask-value";
        op.oninput = () => { opVal.textContent = `${op.value}%`; this.frameMaskSet({ opacity: Number(op.value) / 100 }); };
        opRow.append(opText, op, opVal);
        syncs.push(() => { const v = Math.round(st().opacity * 100); if (Number(op.value) !== v) op.value = String(v); opVal.textContent = `${v}%`; });

        // Line and label.
        const sw = (key, label, tip) => {
            const el = doc.createElement("label");
            el.className = "overlays-menu-row";
            el.dataset.mask = key;
            el.title = tip;
            const t = doc.createElement("span");
            t.textContent = label;
            const box = doc.createElement("input");
            box.type = "checkbox";
            box.className = "overlays-switch";
            box.onchange = () => this.frameMaskSet({ [key]: box.checked });
            el.append(t, box);
            menu.append(el);
            syncs.push(() => { box.checked = !!st()[key]; });
        };
        sw("line", "Edge line", "A thin line where the mask begins");
        sw("label", "Ratio label", "The ratio written in the mask's corner");

        const sync = () => syncs.forEach((f) => f());
        sync();
        host.appendChild(menu);

        // Above the button, inside the panel (as the overlays menu).
        const r = host.getBoundingClientRect();
        const b = (anchor || this.frameMaskBtn || ev.target).getBoundingClientRect();
        const w = menu.offsetWidth, h = menu.offsetHeight;
        const view = doc.defaultView || window;
        const right = Math.min(r.right, view.innerWidth) - r.left;
        const left = Math.max(4, Math.min(b.left - r.left, right - w - 4));
        let top = b.top - r.top - h - 4;
        if (top < 4) top = Math.min(b.bottom - r.top + 4, r.height - h - 4);
        menu.style.left = `${left}px`;
        menu.style.top = `${Math.max(4, top)}px`;

        const dismiss = (e) => {
            if (e.type === "keydown") { if (e.key !== "Escape") return; }
            else if ((e.composedPath ? e.composedPath() : [e.target]).includes(menu)) return;
            close();
        };
        const close = () => {
            menu.remove();
            doc.removeEventListener("mousedown", dismiss, true);
            view.removeEventListener("keydown", dismiss, true);
        };
        setTimeout(() => {
            if (!menu.isConnected) return;
            doc.addEventListener("mousedown", dismiss, true);
            view.addEventListener("keydown", dismiss, true);
        }, 0);
        menu._sync = sync;
        menu._close = close;
        return menu;
    },
};
