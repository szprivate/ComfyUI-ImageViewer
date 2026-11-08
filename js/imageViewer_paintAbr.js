// imageViewer_paintAbr.js
// Paint's brush tips: reading the sampled brushes of an .abr file the user picks, keeping tips in the
// browser (IndexedDB), making one from the selection, and choosing one for the brush and the eraser.
//
// The .abr reader follows the file's structure as it can be observed and as open format write-ups
// describe it: a big-endian header (version 1 / 2: a list of brushes, each typed and sized; version 6 /
// 10: "8BIM" sections, the "samp" one holding the sampled tips), each sampled tip a bounding rectangle,
// a bit depth, and its grey pixels raw or PackBits-compressed per row. Only sampled tips are read
// (computed round brushes and the brush settings in "desc" are left out, and said so). Nothing of
// Adobe's or any other program's code is used, and no brushes ship with the viewer: it reads only what
// the user gives it.
//
// readAbr / packbits / tipFromPixels / shrinkTip are pure (tests/test_paint_abr.mjs); TipsMixin is on the editor.

export const MAX_TIP_SIDE = 1024;

class Reader {
    constructor(b) { this.b = b; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); this.p = 0; }
    get left() { return this.b.length - this.p; }
    u8() { return this.v.getUint8(this.p++); }
    u16() { const x = this.v.getUint16(this.p); this.p += 2; return x; }
    i16() { const x = this.v.getInt16(this.p); this.p += 2; return x; }
    u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
    i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
    str(n) { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
}

/** PackBits: `n` bytes out of `src` from `p`; returns [bytes, the position after]. */
export function packbits(src, p, n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n && p < src.length) {
        let k = src[p++];
        if (k > 127) k -= 256;
        if (k >= 0) { for (let i = 0; i <= k && o < n && p < src.length; i++) out[o++] = src[p++]; }
        else if (k !== -128) { const v = src[p++]; for (let i = 0; i < 1 - k && o < n; i++) out[o++] = v; }
    }
    return [out, p];
}

/** One tip's pixels after its rectangle, depth and compression: a grey w x h (8-bit) or null when it does not fit. */
function readSample(r, w, h, depth, comp, end) {
    if (!(w > 0 && h > 0 && w <= 30000 && h <= 30000) || (depth !== 8 && depth !== 16) || (comp !== 0 && comp !== 1)) return null;
    const bpp = depth / 8, n = w * h;
    let raw;
    if (comp === 0) {
        if (r.p + n * bpp > end) return null;
        raw = r.b.subarray(r.p, r.p + n * bpp);
        r.p += n * bpp;
    } else {
        const counts = [];
        const rows = h * bpp > 0 ? h : 0;
        if (r.p + rows * 2 > end) return null;
        for (let i = 0; i < rows; i++) counts.push(r.u16());
        raw = new Uint8Array(n * bpp);
        for (let i = 0; i < rows; i++) {
            const [row] = packbits(r.b.subarray(0, Math.min(end, r.p + counts[i])), r.p, w * bpp);
            raw.set(row, i * w * bpp);
            r.p += counts[i];
            if (r.p > end) return null;
        }
    }
    if (bpp === 1) return new Uint8Array(raw);
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = raw[i * 2];            // 16-bit: the high byte
    return a;
}

/**
 * The sampled tips of an .abr file: { version, tips: [{ name, w, h, a (grey, 255 paints), spacing? }], left: n, notes }.
 * Throws on a file that is not an .abr.
 */
export function readAbr(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const r = new Reader(b);
    if (b.length < 4) throw new Error("not an .abr file");
    const version = r.u16();
    const tips = [], notes = [];
    let left = 0;
    if (version === 1 || version === 2) {
        const count = r.u16();
        for (let k = 0; k < count && r.left >= 6; k++) {
            const type = r.u16(), size = r.u32(), end = Math.min(b.length, r.p + size);
            if (type === 2) {
                r.u32();                                            // misc
                const spacing = r.u16();
                let name = `Brush ${tips.length + 1}`;
                if (version === 2) {
                    const n = r.u32();
                    let s = "";
                    for (let i = 0; i < n && r.p + 2 <= end; i++) s += String.fromCharCode(r.u16());
                    name = s.replace(/\0+$/, "") || name;
                }
                r.u8();                                             // antialiasing
                r.p += 8;                                           // the short rectangle
                const top = r.i32(), lft = r.i32(), bottom = r.i32(), right = r.i32();
                const depth = r.u16(), comp = r.u8();
                const a = readSample(r, right - lft, bottom - top, depth, comp, end);
                if (a) tips.push({ name, w: right - lft, h: bottom - top, a, spacing: spacing || undefined });
                else left++;
            } else left++;
            r.p = end;
        }
        if (left) notes.push(`${left} brush(es) that are not sampled tips (computed round brushes) were left out`);
        return { version, tips, left, notes };
    }
    if (version !== 6 && version !== 10) throw new Error(`an .abr of version ${version} is not one this reads (1, 2, 6, 10)`);
    const sub = r.u16();
    while (r.left >= 12) {
        const sig = r.str(4);
        if (sig !== "8BIM") break;
        const key = r.str(4), len = r.u32(), end = Math.min(b.length, r.p + len);
        if (key === "samp") {
            while (r.p + 4 <= end) {
                const blen = r.u32(), start = r.p, bend = Math.min(end, start + blen);
                const idLen = r.u8();
                const id = r.str(Math.min(idLen, bend - r.p));
                // After the id: a block of settings (10 bytes in sub-version 1, 264 in 2) and then the rectangle.
                // Both are tried: the one whose rectangle, depth and compression make sense is taken.
                let a = null, w = 0, h = 0;
                for (const skip of sub === 1 ? [10, 264] : [264, 10]) {
                    r.p = start + 1 + idLen + skip;
                    if (r.p + 19 > bend) continue;
                    const top = r.i32(), lft = r.i32(), bottom = r.i32(), right = r.i32();
                    const depth = r.u16(), comp = r.u8();
                    w = right - lft; h = bottom - top;
                    a = readSample(r, w, h, depth, comp, bend);
                    if (a) break;
                }
                if (a) tips.push({ name: `Brush ${tips.length + 1}`, w, h, a, id });
                else left++;
                r.p = start + blen + ((4 - (blen % 4)) % 4);       // blocks are padded to 4 bytes
            }
        } else if (key === "desc") notes.push("the brushes' settings (spacing, dynamics) are not read: the tips come with the brush's own");
        r.p = end + (len % 2);
    }
    if (left) notes.push(`${left} tip(s) could not be read and were left out`);
    return { version, tips, left, notes };
}

/** A tip shrunk (area average) so its longer side is at most `max` px. */
export function shrinkTip(t, max = MAX_TIP_SIDE) {
    const k = Math.max(t.w, t.h) / max;
    if (k <= 1) return t;
    const w = Math.max(1, Math.round(t.w / k)), h = Math.max(1, Math.round(t.h / k)), a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const x0 = Math.floor((x * t.w) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * t.w) / w));
        const y0 = Math.floor((y * t.h) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * t.h) / h));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += t.a[yy * t.w + xx];
        a[y * w + x] = Math.round(s / ((x1 - x0) * (y1 - y0)));
    }
    return { ...t, w, h, a };
}

/** A tip from RGBA pixels (w x h) under a mask (0..255, the same size, or null): dark paints, as a brush is defined. */
export function tipFromPixels(px, w, h, mask = null) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const val = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const m = mask ? mask[i] / 255 : 1, al = px[i * 4 + 3] / 255;
        const lum = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
        const v = Math.round((255 - lum) * al * m);
        val[i] = v;
        if (v > 0) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const tw = x1 - x0 + 1, th = y1 - y0 + 1, a = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) a.set(val.subarray((y + y0) * w + x0, (y + y0) * w + x0 + tw), y * tw);
    return { w: tw, h: th, a };
}

// ── keeping them (IndexedDB, per browser) ───────────────────────────────────

const DB = "imageviewer-paint-tips", STORE = "tips";

function openDb(win) {
    return new Promise((ok, no) => {
        let q;
        try { q = win.indexedDB.open(DB, 1); } catch (e) { no(e); return; }
        q.onupgradeneeded = () => { q.result.createObjectStore(STORE, { keyPath: "id" }); };
        q.onsuccess = () => ok(q.result);
        q.onerror = () => no(q.error);
    });
}

async function tx(win, mode, fn) {
    const db = await openDb(win);
    return new Promise((ok, no) => {
        const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
        const res = fn(st);
        t.oncomplete = () => { db.close(); ok(res && "result" in res ? res.result : undefined); };
        t.onerror = () => { db.close(); no(t.error); };
    });
}

export const TipsMixin = {
    /** The tips kept in this browser, into this.tips (a Map by id); without IndexedDB they live as long as the page. */
    async _tipsLoad() {
        this.tips = this.tips || new Map();
        try {
            const all = await tx(this.d.defaultView, "readonly", (st) => st.getAll());
            for (const t of all || []) this.tips.set(t.id, { ...t, a: new Uint8Array(t.a) });
        } catch (_) { /* no IndexedDB here (a private window): kept in memory only */ }
        this.refreshProps && this.doc && this.refreshProps();
    },

    async _tipKeep(t) {
        const id = "tip-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
        const tip = { id, name: String(t.name || "Brush").slice(0, 80), w: t.w, h: t.h, a: t.a, spacing: t.spacing };
        this.tips.set(id, tip);
        try { await tx(this.d.defaultView, "readwrite", (st) => st.put({ ...tip, a: tip.a.buffer.slice(tip.a.byteOffset, tip.a.byteOffset + tip.a.byteLength) })); } catch (_) { /* memory only */ }
        return tip;
    },

    async tipDelete(id) {
        this.tips.delete(id);
        for (const k of ["brush", "eraser"]) if (this.opts[k].tip === id) this.opts[k].tip = null;
        try { await tx(this.d.defaultView, "readwrite", (st) => st.delete(id)); } catch (_) { /* memory only */ }
        this.refreshProps();
    },

    async tipInvert(id) {
        const t = this.tips.get(id);
        if (!t) return;
        const users = ["brush", "eraser"].filter((k) => this.opts[k].tip === id);
        await this.tipDelete(id);
        const n = await this._tipKeep({ ...t, a: t.a.map((v) => 255 - v) });
        for (const k of users) this.opts[k].tip = n.id;
        this.refreshProps();
    },

    /** Brushes from an .abr's bytes: kept, the first chosen; returns what was read. */
    async importAbr(bytes, fileName = "brushes.abr") {
        let r;
        try { r = readAbr(bytes); } catch (e) { this._notify(`${fileName}: ${e.message || e}`, "error"); return null; }
        const base = fileName.replace(/\.abr$/i, "");
        const kept = [];
        for (const [i, t] of r.tips.entries()) kept.push(await this._tipKeep({ ...shrinkTip(t), name: t.name.startsWith("Brush ") ? `${base} ${i + 1}` : t.name }));
        const tool = this.opts[this.tool] && this.opts[this.tool].tip !== undefined ? this.tool : "brush";
        if (kept.length) { this.opts[tool].tip = kept[0].id; if (kept[0].spacing) this.opts[tool].spacing = Math.min(100, Math.max(1, kept[0].spacing)); }
        this._notify(`${fileName}: ${kept.length} brush tip${kept.length === 1 ? "" : "s"}` + (r.notes.length ? ` (${r.notes.join("; ")})` : ""), kept.length ? "info" : "warn");
        this.refreshProps();
        return { ...r, kept };
    },

    /** Ask for an .abr file (the browser's own file dialog: the file never goes to the server). */
    pickAbr() {
        const inp = this.d.createElement("input");
        inp.type = "file";
        inp.accept = ".abr";
        inp.addEventListener("change", async () => {
            const f = inp.files && inp.files[0];
            if (f) await this.importAbr(new Uint8Array(await f.arrayBuffer()), f.name);
        });
        inp.click();
    },

    /** A tip from what the selection holds of the picture as it looks (Edit > Define brush): dark paints. */
    async tipFromSelection() {
        if (!this.sel) { this._notify("Select what the brush tip should be first.", "info"); return null; }
        const t = tipFromPixels(this.comp, this.doc.w, this.doc.h, this.sel);
        if (!t) { this._notify("The selection holds nothing dark enough to be a tip (dark paints).", "info"); return null; }
        const tip = await this._tipKeep({ ...shrinkTip(t), name: `Tip ${this.tips.size + 1}` });
        const tool = this.opts[this.tool] && this.opts[this.tool].tip !== undefined ? this.tool : "brush";
        this.opts[tool].tip = tip.id;
        this.refreshProps();
        return tip;
    },

    /** The tip's row of Properties: Round and every tip as a small picture, the buttons, its angle and the jitter. */
    _tipOptions(ts, b, sync) {
        const row = this.el("div", "paint-tips");
        const add = (id, title, draw) => {
            const btn = this.el("button", "paint-tip" + ((b.tip || null) === id ? " on" : ""), { type: "button", title });
            btn.dataset.tip = id || "round";
            const cv = this.el("canvas");
            cv.width = cv.height = 28;
            draw(cv.getContext("2d"));
            btn.append(cv);
            btn.addEventListener("click", () => {
                b.tip = id;
                const t = id && this.tips.get(id);
                if (t && t.spacing) b.spacing = Math.min(100, Math.max(1, t.spacing));
                this.refreshProps(); sync();
            });
            row.append(btn);
        };
        add(null, "Round (size, hardness)", (c) => { c.fillStyle = "#ddd"; c.beginPath(); c.arc(14, 14, 10, 0, Math.PI * 2); c.fill(); });
        for (const t of this.tips.values()) {
            add(t.id, `${t.name} (${t.w} x ${t.h})`, (c) => {
                const k = 26 / Math.max(t.w, t.h), w = Math.max(1, Math.round(t.w * k)), h = Math.max(1, Math.round(t.h * k));
                const im = c.createImageData(w, h);
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                    const v = t.a[Math.min(t.h - 1, Math.floor(y / k)) * t.w + Math.min(t.w - 1, Math.floor(x / k))];
                    im.data.set([221, 221, 221, v], (y * w + x) * 4);
                }
                c.putImageData(im, Math.round((28 - w) / 2), Math.round((28 - h) / 2));
            });
        }
        ts.append(row);
        const btns = this.el("div", "paint-field wrap");
        const B = (text, title, run, cls) => { const x = this.el("button", "paint-btn " + cls, { type: "button", text, title }); x.addEventListener("click", run); btns.append(x); };
        B("Import .abr…", "Read the sampled brush tips of a brush file (.abr); they are kept in this browser", () => this.pickAbr(), "tip-import");
        B("From selection", "Make a tip of what is selected (dark paints)", () => this.tipFromSelection(), "tip-sel");
        if (b.tip) {
            B("Invert", "Paint with the light parts instead", () => this.tipInvert(b.tip), "tip-invert");
            B("Delete", "Forget this tip", () => this.tipDelete(b.tip), "tip-del");
        }
        ts.append(btns);
        if (b.tip) this._slider(ts, "Angle °", b.angle || 0, -180, 180, 1, (v) => { b.angle = v; sync(); });
        this._slider(ts, "Scatter %", b.scatter || 0, 0, 500, 1, (v) => { b.scatter = v; sync(); });
        this._slider(ts, "Size jitter %", b.sizeJitter || 0, 0, 100, 1, (v) => { b.sizeJitter = v; sync(); });
        this._slider(ts, "Angle jitter %", b.angleJitter || 0, 0, 100, 1, (v) => { b.angleJitter = v; sync(); });
    },
};
