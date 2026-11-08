// Paint's layer styles in the editor (the section in Properties, the "fx" mark), locked transparency,
// and the clipboard (copy, cut, copy merged, paste, paste in place). Mixins onto PaintEditor.
// The styles' arithmetic is imageViewer_paintStyle.js.
import * as D from "./imageViewer_paintData.js";
import { STYLE_KINDS, STYLE_LABELS, STYLE_DEFAULTS, cleanStyle } from "./imageViewer_paintStyle.js";

const hex = (c) => D.rgbToHex(c[0], c[1], c[2]);

export const LayerFxMixin = {
    // ── layer styles ─────────────────────────────────────────────────────────

    /** Layer > Layer style…: the section in Properties for the active pixel layer. */
    openStyle(kind = null) {
        const L = this.active();
        if (!L || L.kind !== "pixel") { this._notify("A layer style goes on a pixel layer.", "info"); return false; }
        this._styleOpen = L.id;
        if (kind && !(L.style && L.style[kind])) this.setStyle(L, kind, { ...STYLE_DEFAULTS[kind] });
        this.refreshProps();
        if (this.host.showPanel) this.host.showPanel("effects");
        return true;
    },

    /** One effect of a layer's style set (patch merged into it) or taken off (null): one undo step. */
    setStyle(L, kind, patch, label = "Layer style") {
        return this.change(label, () => {
            const X = this.doc.layers.find((q) => q.id === L.id);
            if (!X) return false;
            const s = { ...(X.style || {}) };
            if (patch === null) delete s[kind];
            else s[kind] = { ...(STYLE_DEFAULTS[kind]), ...(s[kind] || {}), ...patch };
            const c = cleanStyle(s);
            if (c) X.style = c; else delete X.style;
        });
    },

    clearStyle(L) {
        return this.change("Clear layer style", () => {
            const X = this.doc.layers.find((q) => q.id === L.id);
            if (!X || !X.style) return false;
            delete X.style;
        });
    },

    _styleSection(L) {
        const s = this.el("div", "paint-sect paint-style");
        s.append(this.el("h4", "", { text: "Layer style" }));
        const st = L.style || {};
        // A slider drags live (one undo step when let go).
        const live = (kind, key) => (v) => {
            this.liveBegin();
            const X = this.active();
            if (!X || !X.style || !X.style[kind]) return;
            X.style[kind][key] = key === "opacity" ? v / 100 : v;
            X.style = cleanStyle(X.style);
            this.requestRedraw();
        };
        const end = () => this.liveEnd("Layer style");
        for (const k of STYLE_KINDS) {
            const e = st[k];
            const head = this.el("div", "paint-field paint-style-k");
            const on = this.el("input", "style-on", { type: "checkbox", checked: !!(e && e.on) });
            on.dataset.kind = k;
            on.addEventListener("change", () => {
                if (!e) this.setStyle(L, k, { on: true });
                else this.setStyle(L, k, { on: on.checked });
            });
            const lab = this.el("label", "paint-check");
            lab.append(on, this.el("span", "", { text: STYLE_LABELS[k] }));
            head.append(lab);
            if (e) {
                const col = this.el("input", "style-color", { type: "color", value: hex(e.color), title: "Its colour" });
                col.addEventListener("change", () => this.setStyle(L, k, { color: D.hexToRgb(col.value) }));
                const rm = this.el("button", "paint-btn style-rm", { type: "button", text: "×", title: "Take this effect off" });
                rm.addEventListener("click", () => this.setStyle(L, k, null));
                head.append(col, rm);
            }
            s.append(head);
            if (!e || !e.on) continue;
            this._slider(s, "Opacity %", Math.round(e.opacity * 100), 0, 100, 1, live(k, "opacity"), end);
            if (k === "shadow") {
                this._slider(s, "Angle °", e.angle, -180, 180, 1, live(k, "angle"), end);
                this._slider(s, "Distance", e.distance, 0, 1000, 1, live(k, "distance"), end);
            }
            if (k !== "overlay") this._slider(s, k === "stroke" ? "Size" : "Blur", e.size, k === "stroke" ? 1 : 0, k === "stroke" ? 100 : 250, 1, live(k, "size"), end);
        }
        const row = this.el("div", "paint-field");
        const clr = this.el("button", "paint-btn", { type: "button", text: "Clear the style" });
        clr.addEventListener("click", () => { this.clearStyle(L); this._styleOpen = null; this.refreshProps(); });
        if (L.style) { row.append(clr); s.append(row); }
        s.append(this.el("div", "paint-note", { text: "Settings, not pixels: change them at any time. The .ora keeps them; a .psd gets them baked in. Under the layer: the shadow, the glow, the stroke; the overlay tints the layer." }));
        return s;
    },

    // ── locked transparency ──────────────────────────────────────────────────

    toggleLockAlpha() {
        const set = this.pickedLayers().filter((L) => L.kind === "pixel");
        if (!set.length) { this._notify("Pick a pixel layer.", "info"); return false; }
        const v = !set.every((L) => L.lockAlpha);
        return this.setPickedProps((X) => { if (X.kind !== "pixel") return false; if (v) X.lockAlpha = true; else delete X.lockAlpha; },
                                   v ? "Lock transparency" : "Unlock transparency");
    },

    /** After a fill / bucket / gradient on a layer with locked transparency: its alpha as it was. */
    _keepAlpha(L, before, after) {
        if (!L.lockAlpha) return after;
        for (let i = 3; i < after.length; i += 4) after[i] = before[i];
        return after;
    },

    // ── the clipboard ────────────────────────────────────────────────────────

    /** What the selection holds (or all) of the active layer, or of the picture as it looks (merged). */
    _clipOf(merged) {
        const W = this.doc.w, H = this.doc.h;
        const box = this.sel ? D.maskBBox(this.sel, W, H) : { x: 0, y: 0, w: W, h: H };
        if (!box) return null;
        const out = new Uint8ClampedArray(box.w * box.h * 4);
        let src = null, sx = 0, sy = 0, sw = W, sh = H;
        if (merged) src = this.comp;
        else {
            const L = this.active();
            if (!L || L.kind !== "pixel") return null;
            src = this.pix.get(L.id); sx = L.x; sy = L.y; sw = L.w; sh = L.h;
        }
        for (let y = 0; y < box.h; y++) {
            for (let x = 0; x < box.w; x++) {
                const gx = box.x + x, gy = box.y + y, lx = gx - sx, ly = gy - sy;
                if (lx < 0 || ly < 0 || lx >= sw || ly >= sh) continue;
                const so = (ly * sw + lx) * 4, o = (y * box.w + x) * 4;
                out[o] = src[so]; out[o + 1] = src[so + 1]; out[o + 2] = src[so + 2];
                out[o + 3] = this.sel ? D.q8((src[so + 3] / 255) * (this.sel[gy * W + gx] / 255)) : src[so + 3];
            }
        }
        return { px: out, w: box.w, h: box.h, x: box.x, y: box.y };
    },

    /** Ctrl+C (Ctrl+Shift+C: merged): kept here, and put on the system clipboard as a PNG where the browser lets it. */
    copy(merged = false) {
        const c = this._clipOf(merged);
        if (!c) { this._notify(merged ? "Nothing to copy." : "Pick a pixel layer to copy from (Ctrl+Shift+C copies the picture as it looks).", "info"); return false; }
        this._clip = c;
        this._clipToSystem(c);
        this._notify(`Copied ${c.w} x ${c.h}${merged ? " (merged)" : ""}.`, "info");
        return true;
    },

    cut() {
        if (!this.copy(false)) return false;
        if (this.sel) this.clearSelection();
        else {
            const L = this.active();
            if (L && !L.locked) this.change("Cut", () => { this.pix.set(L.id, new Uint8ClampedArray(L.w * L.h * 4)); });
        }
        return true;
    },

    async _clipToSystem(c) {
        try {
            const nav = this.d.defaultView && this.d.defaultView.navigator;
            if (!nav || !nav.clipboard || !nav.clipboard.write || typeof ClipboardItem === "undefined") return;
            const cv = this.d.createElement("canvas");
            cv.width = c.w; cv.height = c.h;
            cv.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(c.px), c.w, c.h), 0, 0);
            const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
            if (blob) await nav.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            this._clipSystemAt = Date.now();
        } catch (_) { /* the browser said no (no focus, no permission): the copy here still holds */ }
    },

    /**
     * A picture as a new layer: in the middle of the view (in place: where it was copied from). From the
     * system clipboard's picture when there is one (a screenshot, an image copied in another program),
     * else from what was copied here.
     */
    async pastePicture(blob, inPlace = false) {
        let c = null;
        if (blob) {
            try {
                const bmp = await createImageBitmap(blob);
                const cv = this.d.createElement("canvas");
                cv.width = bmp.width; cv.height = bmp.height;
                const g = cv.getContext("2d");
                g.drawImage(bmp, 0, 0);
                c = { px: new Uint8ClampedArray(g.getImageData(0, 0, bmp.width, bmp.height).data), w: bmp.width, h: bmp.height, x: null, y: null };
            } catch (e) { this._notify("The clipboard's picture could not be read.", "warn"); }
            // The picture this editor put there itself: its own copy (exact, no PNG round trip, its place kept).
            const own = this._clip;
            if (c && own && this._clipSystemAt && c.w === own.w && c.h === own.h) c = own;
        }
        if (!c) c = this._clip;
        if (!c) { this._notify("Nothing to paste: copy a picture (or part of a layer) first.", "info"); return false; }
        let x, y;
        if (inPlace && c.x != null) { x = c.x; y = c.y; }
        else {
            const v = this.view, r = this.wrap.getBoundingClientRect();
            const cx = (r.width / 2 - v.x) / v.zoom, cy = (r.height / 2 - v.y) / v.zoom;
            x = Math.round((Number.isFinite(cx) ? cx : this.doc.w / 2) - c.w / 2);
            y = Math.round((Number.isFinite(cy) ? cy : this.doc.h / 2) - c.h / 2);
        }
        return this.addPixelLayer(new Uint8ClampedArray(c.px), c.w, c.h, this._freshName("Pasted"), x, y);
    },

    _freshName(base) {
        const names = new Set(this.doc.layers.map((L) => L.name));
        let n = 1;
        while (names.has(`${base} ${n}`)) n++;
        return `${base} ${n}`;
    },

    /** The page's paste event: armed by Ctrl+V on the editor (whose keydown is not prevented, so it comes). */
    _pasteWire() {
        const win = this.d.defaultView;
        if (!win || this._pasteWired === win) return;
        this._pasteWired = win;
        win.addEventListener("paste", (e) => {
            const armed = this._pasteArmed;
            if (!armed || Date.now() - armed.t > 1500) return;
            this._pasteArmed = null;
            e.preventDefault();
            e.stopImmediatePropagation();
            const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
            const img = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
            this.pastePicture(img ? img.getAsFile() : null, armed.inPlace);
        }, true);
    },

    /** Edit > Paste: the system clipboard read where the browser lets it, else what was copied here. */
    async pasteFromMenu(inPlace) {
        let blob = null;
        try {
            const nav = this.d.defaultView.navigator;
            if (nav.clipboard && nav.clipboard.read) {
                for (const it of await nav.clipboard.read()) {
                    const t = it.types.find((x) => x.startsWith("image/"));
                    if (t) { blob = await it.getType(t); break; }
                }
            }
        } catch (_) { /* not allowed: what was copied here */ }
        return this.pastePicture(blob, inPlace);
    },

    /** Ctrl+V: arm the paste event; when none comes (no focus in the page), paste what was copied here. */
    pasteKey(inPlace) {
        this._pasteWire();
        const armed = { t: Date.now(), inPlace };
        this._pasteArmed = armed;
        setTimeout(() => { if (this._pasteArmed === armed) { this._pasteArmed = null; this.pastePicture(null, inPlace); } }, 300);
    },
};
