// imageViewer_paintAdjustUI.js
// The adjustments' panels as a picture editor has them: a histogram of what goes into the adjustment
// (with what comes out drawn over it), Levels with its input and output sliders and a channel of its
// own, Curves on top of the histogram with presets and a point's numbers, Threshold on the histogram,
// and sliders whose tracks show what they do (Hue / Saturation's spectrum bars, Grade per channel).
//
// One editor for both places an adjustment is set: an adjustment layer's section in Properties and
// Filter > <adjustment> (into the pixels), a dialog with a live preview.
//
// The arithmetic at the top is pure (tests/test_paint_adjust_ui.mjs); AdjustUIMixin goes onto the
// editor's prototype. Written from how the tools behave, not from anyone's code.
import * as D from "./imageViewer_paintData.js";

// ── the arithmetic ───────────────────────────────────────────────────────────

/** Counts per value of R, G, B and luminance over the pixels with any alpha: { r, g, b, l, n }. */
export function histogram(px, step = 1) {
    const r = new Float64Array(256), g = new Float64Array(256), b = new Float64Array(256), l = new Float64Array(256);
    let n = 0;
    const st = Math.max(1, step | 0) * 4;
    for (let i = 0; i + 3 < px.length; i += st) {
        if (!px[i + 3]) continue;
        r[px[i]]++; g[px[i + 1]]++; b[px[i + 2]]++;
        l[Math.min(255, Math.floor(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] + 0.5))]++;
        n++;
    }
    return { r, g, b, l, n };
}

/** The counts after a table (256 values 0..1): what the histogram looks like once the adjustment is applied. */
export function remapHist(counts, lut) {
    const out = new Float64Array(256);
    for (let i = 0; i < 256; i++) if (counts[i]) out[D.q8(lut[i])] += counts[i];
    return out;
}

/** The luminance counts after three tables (R, G, B): each luminance value taken as a grey through them. */
export function remapLum(hist, luts) {
    const out = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
        if (hist.l[i]) out[D.q8(0.2126 * luts[0][i] + 0.7152 * luts[1][i] + 0.0722 * luts[2][i])] += hist.l[i];
    }
    return out;
}

/** Where the black and white points go so that `clip` (a share, 0.001 = 0.1 %) of the pixels is cut at each end. */
export function autoLevels(counts, clip = 0.001) {
    let n = 0;
    for (let i = 0; i < 256; i++) n += counts[i];
    if (!n) return { in_black: 0, in_white: 255 };
    const cut = n * clip;
    let lo = 0, acc = 0;
    while (lo < 254 && acc + counts[lo] <= cut) acc += counts[lo++];
    let hi = 255;
    acc = 0;
    while (hi > lo + 1 && acc + counts[hi] <= cut) acc += counts[hi--];
    return { in_black: lo, in_white: Math.max(lo + 1, hi) };
}

/** The grey slider of Levels: where between black and white (0..1) a gamma puts the middle grey, and back. */
export const gammaToShare = (gamma) => Math.min(0.99, Math.max(0.01, 0.5 ** gamma));
export const shareToGamma = (f) => Math.min(9.99, Math.max(0.1, Math.log(Math.min(0.99, Math.max(0.01, f))) / Math.log(0.5)));

/** Curves presets (points 0..255), as the usual ones go. */
export const CURVE_PRESETS = {
    linear: { label: "Linear", pts: [[0, 0], [255, 255]] },
    medium: { label: "Medium contrast", pts: [[0, 0], [64, 52], [192, 204], [255, 255]] },
    strong: { label: "Strong contrast", pts: [[0, 0], [64, 40], [192, 216], [255, 255]] },
    lighter: { label: "Lighter", pts: [[0, 0], [110, 145], [255, 255]] },
    darker: { label: "Darker", pts: [[0, 0], [145, 110], [255, 255]] },
    negative: { label: "Negative", pts: [[0, 255], [255, 0]] },
    crossfade: { label: "Faded (lifted blacks)", pts: [[0, 40], [128, 132], [255, 235]] },
};

/** The largest count to scale a histogram by: the ends left out (a clipped picture piles up there). */
export function histScale(...lists) {
    let m = 1;
    for (const c of lists) if (c) for (let i = 1; i < 255; i++) if (c[i] > m) m = c[i];
    return m * 1.08;
}

const LEVELS_KEYS = ["in_black", "in_white", "gamma", "out_black", "out_white"];
const LEVELS_ONE = { in_black: 0, in_white: 255, gamma: 1, out_black: 0, out_white: 255 };

/** Levels' numbers of one channel ("rgb" = the master). */
export function levelsOf(p, ch) {
    const q = ch === "rgb" ? p : p[ch];
    const out = {};
    for (const k of LEVELS_KEYS) out[k] = q && q[k] != null ? q[k] : LEVELS_ONE[k];
    return out;
}

/** The patch that sets one channel's levels (a channel back at its defaults is null again). */
export function levelsPatch(p, ch, change) {
    const now = { ...levelsOf(p, ch), ...change };
    if (ch === "rgb") return now;
    const plain = LEVELS_KEYS.every((k) => Math.abs(now[k] - LEVELS_ONE[k]) < 1e-9);
    return { [ch]: plain ? null : now };
}

const CH_COLOR = { rgb: "#ddd", r: "#ff5a5a", g: "#5ad65a", b: "#5a8cff", l: "#ddd" };

// ── the panel side ───────────────────────────────────────────────────────────

export const ADJUST_CSS = `
.paint-adj { display: flex; flex-direction: column; gap: 4px; }
.paint-hist { display: block; width: 100%; height: 96px; background: #111; border: 1px solid #3a3a40; border-radius: 2px; }
.paint-hist.tall { height: 120px; }
.paint-hbar { display: flex; align-items: center; gap: 6px; }
.paint-hbar select { flex: 0 0 auto; }
.paint-hbar .paint-note { margin: 0; flex: 1; text-align: right; }
.paint-ltrack { position: relative; height: 14px; margin: 0 6px; }
.paint-ltrack.grad { height: 22px; }
.paint-ltrack .bar { position: absolute; left: 0; right: 0; top: 0; height: 8px; border-radius: 2px; border: 1px solid #3a3a40; }
.paint-ltrack .h { position: absolute; top: 0; width: 0; height: 0; transform: translateX(-6px); cursor: ew-resize; touch-action: none;
    border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 10px solid #fff; filter: drop-shadow(0 0 1px #000); }
.paint-ltrack.grad .h { top: 10px; }
.paint-ltrack .h.k { border-bottom-color: #000; filter: drop-shadow(0 0 1px #ccc); }
.paint-ltrack .h.m { border-bottom-color: #888; }
.paint-ltrack .h.on { filter: drop-shadow(0 0 2px #f60); }
.paint-nums { display: flex; justify-content: space-between; gap: 6px; }
.paint-nums input { width: 58px; }
.paint-nums .mid { text-align: center; }
.paint-adj .row-btns { display: flex; gap: 4px; flex-wrap: wrap; }
.paint-adj .sub { color: #999; font-size: 11px; margin-top: 4px; }
.paint-curvebox { position: relative; display: grid; grid-template-columns: 10px 1fr; grid-template-rows: 1fr 10px; gap: 2px; max-width: 280px; }
.paint-curvebox .paint-curve { grid-column: 2; grid-row: 1; max-width: none; outline: none; }
.paint-curvebox .vg { grid-column: 1; grid-row: 1; background: linear-gradient(to top, #000, #fff); border: 1px solid #3a3a40; }
.paint-curvebox .hg { grid-column: 2; grid-row: 2; background: linear-gradient(to right, #000, #fff); border: 1px solid #3a3a40; }
.paint-gs input[type=range] { -webkit-appearance: none; appearance: none; height: 8px; border-radius: 4px; border: 1px solid #3a3a40;
    background: var(--track, #333); padding: 0; margin: 0 2px; }
.paint-gs input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 11px; height: 14px; border-radius: 2px; background: #eee;
    border: 1px solid #222; box-shadow: 0 0 2px #000; cursor: ew-resize; }
.paint-gs input[type=range]::-moz-range-thumb { width: 10px; height: 13px; border-radius: 2px; background: #eee; border: 1px solid #222; }
.paint-spectrum { height: 9px; border: 1px solid #3a3a40; border-radius: 2px; margin: 1px 2px; }
.paint-adjdlg { width: 330px; max-width: calc(100% - 24px); }
.paint-adjdlg .paint-adj { margin: 4px 0 8px; }
`;

const hueTrack = "linear-gradient(to right, hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%))";
const spectrum = (shift = 0, sat = 100, light = 50) => {
    const stops = [];
    for (let i = 0; i <= 12; i++) stops.push(`hsl(${i * 30 + shift},${sat}%,${light}%)`);
    return `linear-gradient(to right, ${stops.join(", ")})`;
};
const TRACKS = {
    brightness: "linear-gradient(to right, #000, #888, #fff)",
    contrast: "linear-gradient(to right, #777, #777 48%, #000 49%, #000 50%, #fff 50%, #fff 51%, #777 52%), linear-gradient(to right, #666, #000 50%, #fff)",
    exposure: "linear-gradient(to right, #000, #555, #fff)",
    offset: "linear-gradient(to right, #000, #444, #999)",
    gamma: "linear-gradient(to right, #fff, #888, #222)",
    hue: hueTrack,
    saturation: "linear-gradient(to right, #808080, hsl(0,100%,50%))",
    lightness: "linear-gradient(to right, #000, hsl(0,100%,50%), #fff)",
    level: "linear-gradient(to right, #000, #fff)",
    r: "linear-gradient(to right, #003, #f33)", g: "linear-gradient(to right, #030, #3d3)", b: "linear-gradient(to right, #003, #46f)",
};

export const AdjustUIMixin = {
    /** The look is part of the editor's own style sheet (ADJUST_CSS); kept as a hook. */
    _adjCss() {},

    /**
     * The histogram of what goes INTO adjustment layer L: the layers under it laid together, at most about
     * 0.4 megapixels (the document shrunk as the drag preview does). Kept until the document changes.
     */
    _adjHistUnder(L) {
        const d = this.doc;
        const idx = D.layerIndex(d, L.id);
        const key = `${this.version}|${L.id}|${idx}|${d.layers.length}`;
        if (this._adjHist && this._adjHist.key === key) return this._adjHist.h;
        const k = Math.max(1, Math.ceil(Math.sqrt((d.w * d.h) / 400000)));
        let doc = d, pix = this._pixOf, mk = this._maskOf;
        if (k > 1 && this._previewDoc) {
            const pv = this._previewDoc(k);
            doc = pv.doc;
            pix = (X) => pv.px.get(X.id);
            mk = (X) => pv.mk.get(X.id);
        }
        const below = { ...doc, layers: doc.layers.slice(0, Math.max(0, idx)) };
        const h = below.layers.length ? histogram(D.composite(below, pix, mk)) : histogram(new Uint8ClampedArray(0));
        this._adjHist = { key, h };
        return h;
    },

    /** The histogram of pixels (a layer the adjustment goes into, for Filter > <adjustment>). */
    _adjHistOf(px) {
        return histogram(px, Math.max(1, Math.floor(px.length / 4 / 400000)));
    },

    /** Draw `counts` (and `after`, a line) into canvas `cv`; marks: [{ x: 0..255, color }]. */
    _adjDrawHist(cv, hist, ch, luts = null, marks = []) {
        const w = cv.width = Math.max(256, Math.round((cv.clientWidth || 256) * (this.d.defaultView.devicePixelRatio || 1)));
        const h = cv.height = Math.max(60, Math.round((cv.clientHeight || 96) * (this.d.defaultView.devicePixelRatio || 1)));
        const g = cv.getContext("2d");
        g.fillStyle = "#111"; g.fillRect(0, 0, w, h);
        g.strokeStyle = "#26262b"; g.lineWidth = 1;
        for (let i = 1; i < 4; i++) { const x = Math.round(i * w / 4) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
        if (!hist || !hist.n) {
            g.fillStyle = "#666"; g.font = `${Math.round(h / 8)}px sans-serif`; g.textAlign = "center";
            g.fillText("nothing under it", w / 2, h / 2);
            return;
        }
        const area = (counts, color, scale) => {
            g.fillStyle = color;
            g.beginPath(); g.moveTo(0, h);
            for (let i = 0; i < 256; i++) {
                const y = h - Math.min(1, counts[i] / scale) * (h - 2);
                g.lineTo(i * w / 256, y); g.lineTo((i + 1) * w / 256, y);
            }
            g.lineTo(w, h); g.closePath(); g.fill();
        };
        const line = (counts, color, scale) => {
            g.strokeStyle = color; g.lineWidth = Math.max(1, w / 256);
            g.beginPath();
            for (let i = 0; i < 256; i++) {
                const y = h - Math.min(1, counts[i] / scale) * (h - 2);
                if (i) g.lineTo((i + 0.5) * w / 256, y); else g.moveTo(0.5 * w / 256, y);
            }
            g.stroke();
        };
        let after = null;
        const same = (a, b) => { for (let i = 0; i < 256; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false; return true; };
        if (ch === "l") {
            // Luminance, as Levels and Threshold show it: grey, and what comes out as a line when it differs.
            if (luts) { after = remapLum(hist, luts); if (same(after, hist.l)) after = null; }
            const sc = histScale(hist.l, after);
            area(hist.l, "rgba(205,205,210,.9)", sc);
            if (after) line(after, "#f80", sc);
        } else if (ch === "rgb") {
            // The three channels added together (white where they agree), the luminance as a line over them.
            const sc = histScale(hist.r, hist.g, hist.b);
            g.globalCompositeOperation = "lighter";
            area(hist.r, "rgba(200,40,40,.85)", sc); area(hist.g, "rgba(40,190,40,.85)", sc); area(hist.b, "rgba(50,80,230,.85)", sc);
            g.globalCompositeOperation = "source-over";
            if (luts) { after = remapLum(hist, luts); if (same(after, hist.l)) after = null; }
            line(hist.l, "rgba(230,230,230,.55)", histScale(hist.l, after));
            if (after) line(after, "#f80", histScale(hist.l, after));
        } else {
            const counts = hist[ch];
            if (luts) { after = remapHist(counts, luts[{ r: 0, g: 1, b: 2 }[ch]]); if (same(after, counts)) after = null; }
            const sc = histScale(counts, after);
            area(counts, { r: "rgba(220,60,60,.8)", g: "rgba(60,200,60,.8)", b: "rgba(70,110,240,.8)" }[ch], sc);
            if (after) line(after, "#f80", sc);
        }
        for (const m of marks) {
            g.strokeStyle = m.color || "#f60"; g.lineWidth = Math.max(1, w / 256);
            const x = Math.round((m.x + 0.5) * w / 256) + 0.5;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        }
    },

    /** A slider whose track shows what it does (`track` a CSS background). */
    _gslider(parent, label, value, min, max, step, track, onLive, onEnd) {
        const row = this._slider(parent, label, value, min, max, step, onLive, onEnd);
        row.classList.add("paint-gs");
        const r = row.querySelector("input[type=range]");
        if (r && track) r.style.setProperty("--track", track);
        return row;
    },

    /**
     * The editor of adjustment `t`: `get()` its params now, `live(patch)` while something moves (no undo step),
     * `end()` when it is let go, `hist()` the histogram of what goes in (or null).
     */
    _adjustEditor(t, get, live, end, hist) {
        this._adjCss();
        const box = this.el("div", "paint-adj");
        box.dataset.adjust = t;
        const luts = () => { try { return D.adjustLuts(t, get()); } catch (_) { return null; } };
        if (t === "levels") this._levelsUI(box, get, live, end, hist, luts);
        else if (t === "curves") this._curvesUI(box, get, live, end, hist, luts);
        else if (t === "threshold") this._thresholdUI(box, get, live, end, hist);
        else {
            // A histogram of what goes in and (for the ones a table describes) what comes out.
            const top = this.el("div", "paint-hbar");
            const ch = this.el("select", "", { title: "Channel shown" });
            for (const [v, s] of [["rgb", "Colours"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]]) ch.append(this.el("option", "", { value: v, text: s }));
            ch.value = this._adjHistCh || "rgb";
            top.append(ch, this.el("div", "paint-note", { text: t === "hue_saturation" ? "under it" : "under it · orange: after" }));
            const cv = this.el("canvas", "paint-hist");
            box.append(top, cv);
            const draw = () => this._adjDrawHist(cv, hist(), ch.value, t === "hue_saturation" ? null : luts());
            ch.addEventListener("change", () => { this._adjHistCh = ch.value; draw(); });
            const lv = (patch) => { live(patch); draw(); if (spec) spec(); };
            let spec = null;
            if (t === "hue_saturation") {
                const p = get();
                this._gslider(box, "Hue", p.hue, -180, 180, 1, TRACKS.hue, (x) => lv({ hue: x }), end);
                this._gslider(box, "Saturation", p.saturation, -100, 100, 1, TRACKS.saturation, (x) => lv({ saturation: x }), end);
                this._gslider(box, "Lightness", p.lightness, -100, 100, 1, TRACKS.lightness, (x) => lv({ lightness: x }), end);
                // The colours before (top) and after (bottom), as the dialog's two bars show them.
                const a = this.el("div", "paint-spectrum", { title: "Before" }), b = this.el("div", "paint-spectrum", { title: "After" });
                a.style.background = spectrum();
                spec = () => {
                    const q = get();
                    const l = q.lightness > 0 ? 50 + 50 * q.lightness / 100 : 50 * (1 + q.lightness / 100);
                    b.style.background = spectrum(q.hue, Math.max(0, Math.min(100, 100 + q.saturation)), l);
                };
                spec();
                box.append(a, b);
            } else if (t === "brightness_contrast" || t === "exposure") {
                for (const [k, label, lo, hi, step] of D.ADJUST_FIELDS[t]) {
                    this._gslider(box, label, get()[k], lo, hi, step, TRACKS[k], (x) => lv({ [k]: x }), end);
                }
            } else if (t === "grade") {
                for (const [k, label, lo, hi, step] of D.ADJUST_FIELDS[t]) {
                    box.append(this.el("div", "sub", { text: label }));
                    const v = get()[k];
                    const same = v[0] === v[1] && v[1] === v[2];
                    this._gslider(box, "All", same ? v[0] : (v[0] + v[1] + v[2]) / 3, lo, hi, step, TRACKS[k === "lift" ? "brightness" : k === "gain" ? "exposure" : "gamma"],
                                  (x) => lv({ [k]: [x, x, x] }), () => { end(); this._adjRefresh(box); });
                    ["r", "g", "b"].forEach((c, i) => {
                        this._gslider(box, { r: "Red", g: "Green", b: "Blue" }[c], v[i], lo, hi, step, TRACKS[c],
                                      (x) => { const arr = [...get()[k]]; arr[i] = x; lv({ [k]: arr }); }, end);
                    });
                }
            } else if (t === "invert") {
                box.append(this.el("div", "paint-note", { text: "Nothing to set: it inverts what is under it." }));
            }
            box._adjDraw = draw;
            this._adjWhenShown(cv, draw);
        }
        return box;
    },

    /** Draw once the canvas has its size (a section is built before it is in the panel). */
    _adjWhenShown(cv, draw) {
        const win = this.d.defaultView;
        win.requestAnimationFrame(() => draw());
    },

    /** Rebuild an editor in place (after a change that moves several of its controls). */
    _adjRefresh(box) { if (box._adjRebuild) box._adjRebuild(); else this.refreshProps(); },

    // ── Levels ──

    _levelsUI(box, get, live, end, hist, luts) {
        const top = this.el("div", "paint-hbar");
        const ch = this.el("select", "", { title: "The channel these levels are for" });
        for (const [v, s] of [["rgb", "RGB"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]]) ch.append(this.el("option", "", { value: v, text: s }));
        ch.value = this._levelsCh || "rgb";
        const auto = this.el("button", "paint-btn", { type: "button", text: "Auto", title: "Black and white points where 0.1 % of the pixels are cut off" });
        const reset = this.el("button", "paint-btn", { type: "button", text: "Reset", title: "This channel back to no change" });
        top.append(ch, this.el("div", "paint-note", { text: "" }), auto, reset);
        const cv = this.el("canvas", "paint-hist tall");
        const inT = this.el("div", "paint-ltrack");
        const hk = this.el("div", "h k", { title: "Input black" }), hm = this.el("div", "h m", { title: "Midtones (gamma)" }), hw = this.el("div", "h", { title: "Input white" });
        inT.append(hk, hm, hw);
        const nIn = this.el("div", "paint-nums");
        const num = (min, max, step, title) => {
            const n = this.el("input", "", { type: "number", min, max, step, title });
            n.addEventListener("keydown", (e) => e.stopPropagation());
            return n;
        };
        const ib = num(0, 254, 1, "Input black"), gm = num(0.1, 9.99, 0.01, "Gamma"), iw = num(1, 255, 1, "Input white");
        gm.classList.add("mid");
        nIn.append(ib, gm, iw);
        const outT = this.el("div", "paint-ltrack grad");
        const bar = this.el("div", "bar");
        bar.style.background = "linear-gradient(to right, #000, #fff)";
        const ok = this.el("div", "h k", { title: "Output black" }), ow = this.el("div", "h", { title: "Output white" });
        outT.append(bar, ok, ow);
        const nOut = this.el("div", "paint-nums");
        const ob = num(0, 255, 1, "Output black"), owN = num(0, 255, 1, "Output white");
        nOut.append(ob, owN);
        box.append(top, cv, inT, nIn, this.el("div", "sub", { text: "Output levels" }), outT, nOut);

        const cur = () => levelsOf(get(), ch.value);
        const set = (change) => { live(levelsPatch(get(), ch.value, change)); sync(); };
        const counts = () => { const h = hist(); return h ? (ch.value === "rgb" ? h.l : h[ch.value]) : null; };
        const sync = () => {
            const q = cur();
            const pos = (v) => `${(v / 255) * 100}%`;
            hk.style.left = pos(q.in_black); hw.style.left = pos(q.in_white);
            hm.style.left = pos(q.in_black + (q.in_white - q.in_black) * gammaToShare(q.gamma));
            ok.style.left = pos(q.out_black); ow.style.left = pos(q.out_white);
            for (const [n, v] of [[ib, q.in_black], [gm, q.gamma], [iw, q.in_white], [ob, q.out_black], [owN, q.out_white]]) {
                if (this.d.activeElement !== n && n.getRootNode().activeElement !== n) n.value = String(Math.round(v * 100) / 100);
            }
            const c = { rgb: "#ddd", r: CH_COLOR.r, g: CH_COLOR.g, b: CH_COLOR.b }[ch.value];
            this._adjDrawHist(cv, hist(), ch.value === "rgb" ? "l" : ch.value, luts(), [{ x: q.in_black, color: "#555" }, { x: q.in_white, color: "#aaa" }]);
            top.querySelector(".paint-note").textContent = ch.value === "rgb" ? "" : "after the RGB levels";
            top.querySelector(".paint-note").style.color = c;
        };
        const drag = (h, onX) => {
            h.addEventListener("pointerdown", (e) => {
                e.preventDefault(); e.stopPropagation();
                h.setPointerCapture(e.pointerId);
                h.classList.add("on");
                const r = h.parentNode.getBoundingClientRect();
                const mv = (ev) => onX(Math.min(255, Math.max(0, ((ev.clientX - r.left) / Math.max(1, r.width)) * 255)));
                const up = () => { h.classList.remove("on"); h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up); end(); };
                h.addEventListener("pointermove", mv); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
            });
        };
        drag(hk, (x) => { const q = cur(); set({ in_black: Math.round(Math.min(x, q.in_white - 2)) }); });
        drag(hw, (x) => { const q = cur(); set({ in_white: Math.round(Math.max(x, q.in_black + 2)) }); });
        drag(hm, (x) => { const q = cur(); set({ gamma: Math.round(shareToGamma((x - q.in_black) / Math.max(1, q.in_white - q.in_black)) * 100) / 100 }); });
        drag(ok, (x) => set({ out_black: Math.round(x) }));
        drag(ow, (x) => set({ out_white: Math.round(x) }));
        for (const [n, k, lo, hi] of [[ib, "in_black", 0, 254], [gm, "gamma", 0.1, 9.99], [iw, "in_white", 1, 255], [ob, "out_black", 0, 255], [owN, "out_white", 0, 255]]) {
            n.addEventListener("change", () => { set({ [k]: D.num(n.value, cur()[k], lo, hi) }); end(); });
        }
        ch.addEventListener("change", () => { this._levelsCh = ch.value; sync(); });
        auto.addEventListener("click", () => {
            const c = counts();
            if (!c) return;
            const h = hist();
            if (ch.value === "rgb" && h) {
                // Auto on RGB: each channel stretched on its own (the usual "Auto Tone"), the master left alone.
                const p = {};
                for (const c2 of ["r", "g", "b"]) p[c2] = { ...LEVELS_ONE, ...autoLevels(h[c2]) };
                live(p);
            } else set(autoLevels(c));
            end(); sync();
        });
        reset.addEventListener("click", () => { set({ ...LEVELS_ONE }); end(); });
        box._adjDraw = sync;
        this._adjWhenShown(cv, sync);
    },

    // ── Curves ──

    _curvesUI(box, get, live, end, hist, luts) {
        const top = this.el("div", "paint-hbar");
        const ch = this.el("select", "", { title: "The channel this curve is for" });
        for (const [v, s] of [["rgb", "RGB"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]]) ch.append(this.el("option", "", { value: v, text: s }));
        ch.value = this._curveCh || "rgb";
        const pre = this.el("select", "", { title: "Preset" });
        pre.append(this.el("option", "", { value: "", text: "Preset…" }));
        for (const [k, v] of Object.entries(CURVE_PRESETS)) pre.append(this.el("option", "", { value: k, text: v.label }));
        const reset = this.el("button", "paint-btn", { type: "button", text: "Reset", title: "This channel back to a straight line" });
        top.append(ch, pre, reset);
        const wrap = this.el("div", "paint-curvebox");
        const cv = this.el("canvas", "paint-curve", { width: 512, height: 512, tabIndex: 0,
            title: "Click to add a point and drag it; drag a point off the graph, or Del, to take it away; arrows move the picked point" });
        wrap.append(this.el("div", "vg"), cv, this.el("div", "hg"));
        const nums = this.el("div", "paint-nums");
        const mk = (title) => { const n = this.el("input", "", { type: "number", min: 0, max: 255, step: 1, title }); n.addEventListener("keydown", (e) => e.stopPropagation()); return n; };
        const nIn = mk("Input"), nOut = mk("Output");
        nums.append(this.el("span", "", { text: "Input" }), nIn, this.el("span", "", { text: "Output" }), nOut);
        box.append(top, wrap, nums);
        let sel = -1;
        const pts = () => (get()[ch.value] || [[0, 0], [255, 255]]).map((p) => p.slice());
        const put = (list) => live({ [ch.value]: list });
        const draw = () => {
            const S = cv.width, g = cv.getContext("2d"), k = S / 256;
            g.fillStyle = "#111"; g.fillRect(0, 0, S, S);
            // What goes in, faint behind the curve.
            const h = hist();
            if (h && h.n) {
                const counts = ch.value === "rgb" ? h.l : h[ch.value];
                const sc = histScale(counts);
                g.fillStyle = ch.value === "rgb" ? "rgba(200,200,200,.16)" : { r: "rgba(255,80,80,.2)", g: "rgba(80,220,80,.2)", b: "rgba(90,130,255,.22)" }[ch.value];
                g.beginPath(); g.moveTo(0, S);
                for (let i = 0; i < 256; i++) { const y = S - Math.min(1, counts[i] / sc) * S * 0.9; g.lineTo(i * k, y); g.lineTo((i + 1) * k, y); }
                g.lineTo(S, S); g.closePath(); g.fill();
            }
            g.strokeStyle = "#2c2c32"; g.lineWidth = 1;
            for (let i = 1; i < 4; i++) { const x = Math.round(i * S / 4) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.moveTo(0, x); g.lineTo(S, x); g.stroke(); }
            g.strokeStyle = "#3a3a40"; g.beginPath(); g.moveTo(0, S); g.lineTo(S, 0); g.stroke();
            // The other channels' curves, thin.
            const p = get();
            for (const c of ["rgb", "r", "g", "b"]) {
                if (c === ch.value || !p[c] || (c === "rgb" && p.rgb.length === 2 && p.rgb[0][1] === 0 && p.rgb[1][1] === 255 && p.rgb[0][0] === 0 && p.rgb[1][0] === 255)) continue;
                const lut = D.curveLut(p[c]);
                g.strokeStyle = CH_COLOR[c] + "88"; g.lineWidth = 1;
                g.beginPath();
                for (let x = 0; x < 256; x++) { const y = S - lut[x] * S; if (x) g.lineTo((x + 0.5) * k, y); else g.moveTo(0, y); }
                g.stroke();
            }
            const list = pts(), lut = D.curveLut(list);
            g.strokeStyle = CH_COLOR[ch.value]; g.lineWidth = 2 * Math.max(1, k / 2);
            g.beginPath();
            for (let x = 0; x < 256; x++) { const y = S - lut[x] * S; if (x) g.lineTo((x + 0.5) * k, y); else g.moveTo(0, y); }
            g.stroke();
            list.forEach(([x, y], i) => {
                g.fillStyle = i === sel ? "#f60" : "#111"; g.strokeStyle = i === sel ? "#f60" : "#ddd"; g.lineWidth = 1.5;
                g.beginPath(); g.rect(x * k - 4 * k / 2, S - y * k - 4 * k / 2, 4 * k, 4 * k); g.fill(); g.stroke();
            });
            const q = list[sel];
            nIn.disabled = nOut.disabled = !q;
            if (q) { nIn.value = String(Math.round(q[0])); nOut.value = String(Math.round(q[1])); } else { nIn.value = nOut.value = ""; }
        };
        const at = (e) => {
            const r = cv.getBoundingClientRect();
            return [((e.clientX - r.left) / r.width) * 255, (1 - (e.clientY - r.top) / r.height) * 255, r];
        };
        cv.addEventListener("pointerdown", (e) => {
            e.preventDefault(); e.stopPropagation();
            cv.focus();
            const [x, y] = at(e);
            const list = pts();
            let i = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 9);
            if (e.button === 2) {
                if (i >= 0 && list.length > 2) { list.splice(i, 1); sel = -1; put(list); end(); draw(); }
                return;
            }
            if (i < 0) {
                const nx = Math.round(Math.min(255, Math.max(0, x)));
                if (list.some((p) => Math.abs(p[0] - nx) < 2)) return;
                list.push([nx, Math.round(Math.min(255, Math.max(0, y)))]);
                list.sort((a, b) => a[0] - b[0]);
                i = list.findIndex((p) => p[0] === nx);
                put(list);
            }
            sel = i;
            cv.setPointerCapture(e.pointerId);
            let off = false;
            const mv = (ev) => {
                const [mx, my, r] = at(ev);
                const L2 = pts();
                if (sel < 0 || sel >= L2.length) return;
                // Dragged well off the graph: the point goes (back if it comes back), as long as two stay.
                off = L2.length > 2 && (ev.clientX < r.left - 24 || ev.clientX > r.right + 24 || ev.clientY < r.top - 24 || ev.clientY > r.bottom + 24);
                const lo = sel > 0 ? L2[sel - 1][0] + 1 : 0, hi = sel < L2.length - 1 ? L2[sel + 1][0] - 1 : 255;
                L2[sel] = [Math.round(Math.min(hi, Math.max(lo, mx))), Math.round(Math.min(255, Math.max(0, my)))];
                put(L2);
                draw();
                cv.style.cursor = off ? "no-drop" : "";
            };
            const up = () => {
                cv.removeEventListener("pointermove", mv); cv.removeEventListener("pointerup", up); cv.removeEventListener("pointercancel", up);
                cv.style.cursor = "";
                if (off) { const L2 = pts(); if (L2.length > 2) { L2.splice(sel, 1); put(L2); } sel = -1; }
                end(); draw();
            };
            cv.addEventListener("pointermove", mv); cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
            draw();
        });
        cv.addEventListener("contextmenu", (e) => e.preventDefault());
        cv.addEventListener("keydown", (e) => {
            e.stopPropagation();
            const list = pts();
            if (sel < 0 || sel >= list.length) return;
            if ((e.key === "Delete" || e.key === "Backspace") && list.length > 2) { e.preventDefault(); list.splice(sel, 1); sel = -1; put(list); end(); draw(); return; }
            const step = e.shiftKey ? 10 : 1;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
            if (!d) return;
            e.preventDefault();
            const lo = sel > 0 ? list[sel - 1][0] + 1 : 0, hi = sel < list.length - 1 ? list[sel + 1][0] - 1 : 255;
            list[sel] = [Math.min(hi, Math.max(lo, list[sel][0] + d[0])), Math.min(255, Math.max(0, list[sel][1] + d[1]))];
            put(list); end(); draw();
        });
        for (const [n, i] of [[nIn, 0], [nOut, 1]]) {
            n.addEventListener("change", () => {
                const list = pts();
                if (sel < 0 || sel >= list.length) return;
                const lo = i === 0 ? (sel > 0 ? list[sel - 1][0] + 1 : 0) : 0;
                const hi = i === 0 ? (sel < list.length - 1 ? list[sel + 1][0] - 1 : 255) : 255;
                list[sel][i] = D.num(n.value, list[sel][i], lo, hi);
                put(list); end(); draw();
            });
        }
        ch.addEventListener("change", () => { this._curveCh = ch.value; sel = -1; draw(); });
        pre.addEventListener("change", () => {
            const p = CURVE_PRESETS[pre.value];
            pre.value = "";
            if (!p) return;
            sel = -1; put(p.pts.map((q) => q.slice())); end(); draw();
        });
        reset.addEventListener("click", () => { sel = -1; live({ [ch.value]: ch.value === "rgb" ? [[0, 0], [255, 255]] : null }); end(); draw(); });
        box._adjDraw = draw;
        this._adjWhenShown(cv, draw);
    },

    // ── Threshold ──

    _thresholdUI(box, get, live, end, hist) {
        const cv = this.el("canvas", "paint-hist tall", { title: "Click or drag on the histogram to set the level" });
        box.append(cv);
        let slider = null;
        const draw = () => this._adjDrawHist(cv, hist(), "l", null, [{ x: get().level, color: "#f60" }]);
        const set = (v) => {
            live({ level: v });
            draw();
            if (slider) { for (const i of slider.querySelectorAll("input")) i.value = String(v); }
        };
        slider = this._gslider(box, "Level", get().level, 1, 255, 1, TRACKS.level, (x) => { live({ level: x }); draw(); }, end);
        cv.addEventListener("pointerdown", (e) => {
            e.preventDefault(); e.stopPropagation();
            cv.setPointerCapture(e.pointerId);
            const r = cv.getBoundingClientRect();
            const mv = (ev) => set(Math.round(Math.min(255, Math.max(1, ((ev.clientX - r.left) / r.width) * 255))));
            const up = () => { cv.removeEventListener("pointermove", mv); cv.removeEventListener("pointerup", up); end(); };
            mv(e);
            cv.addEventListener("pointermove", mv); cv.addEventListener("pointerup", up);
        });
        box.append(this.el("div", "paint-note", { text: "Lighter than the level turns white, darker black (by luminance)." }));
        box._adjDraw = draw;
        this._adjWhenShown(cv, draw);
    },

    // ── into the pixels: Filter > <adjustment> ──

    /**
     * An adjustment baked into the picked pixel layers, in a dialog with the same editor as an adjustment
     * layer has, the picture previewed live (no undo step until OK, Cancel puts it back).
     */
    adjustPixelsDialog(t) {
        const label = D.ADJUST_LABELS[t];
        const T = this._filterTargets(label);
        if (!T) return null;
        this._tfSettle();
        this._adjCss();
        const orig = new Map(T.map((L) => [L.id, this.pix.get(L.id)]));
        let params = D.cleanAdjust(t, D.ADJUST_DEFAULTS[t]);
        let on = true, timer = 0, over = false;
        const win = this.d.defaultView;
        const back = () => { for (const [id, b] of orig) this.pix.set(id, b); this._dropBelow(); this.requestRedraw(); };
        const show = () => {
            if (!on) { back(); return; }
            for (const L of T) this.pix.set(L.id, this._filtered(L, orig.get(L.id), (px, w, h) => D.adjustPixels(px, w, h, t, params)));
            this._dropBelow();
            this.requestRedraw();
        };
        const later = () => { if (!timer) timer = win.requestAnimationFrame(() => { timer = 0; show(); }); };
        const L0 = T[T.length - 1];
        const h0 = this._adjHistOf(orig.get(L0.id));
        const shade = this.el("div", "paint-dlg-shade");
        const box = this.el("div", "paint-dlg paint-adjdlg");
        box.append(this.el("h3", "", { text: label + (T.length > 1 ? ` (${T.length} layers)` : "") }));
        let ed = null;
        const build = () => {
            const n = this._adjustEditor(t, () => params, (patch) => { params = D.cleanAdjust(t, { ...params, ...patch }); later(); }, () => later(), () => h0);
            n._adjRebuild = () => { const m = build(); n.replaceWith(m); ed = m; };
            return n;
        };
        ed = build();
        box.append(ed);
        const row = this.el("div", "paint-field");
        const prev = this.el("input", "", { type: "checkbox", checked: true });
        prev.addEventListener("change", () => { on = prev.checked; later(); });
        const before = this.el("button", "paint-btn", { type: "button", text: "Before", title: "Hold to see the picture without it" });
        before.addEventListener("pointerdown", () => { on = false; show(); });
        for (const ev of ["pointerup", "pointerleave", "pointercancel"]) before.addEventListener(ev, () => { if (!on) { on = prev.checked; show(); } });
        row.append(this.el("label", "", { text: "Preview" }), prev, before);
        box.append(row);
        const go = this.el("div", "go");
        const reset = this.el("button", "paint-btn", { type: "button", text: "Reset" });
        const cancel = this.el("button", "paint-btn", { type: "button", text: "Cancel" });
        const ok = this.el("button", "paint-btn on", { type: "button", text: "OK" });
        go.append(reset, cancel, ok);
        box.append(go);
        shade.append(box);
        const close = () => { if (over) return; over = true; if (timer) win.cancelAnimationFrame(timer); timer = 0; shade.remove(); };
        reset.addEventListener("click", () => { params = D.cleanAdjust(t, D.ADJUST_DEFAULTS[t]); const m = build(); ed.replaceWith(m); ed = m; later(); });
        cancel.addEventListener("click", () => { close(); back(); });
        ok.addEventListener("click", () => {
            close();
            back();
            const p = params;
            this.applyFilter(label, (px, w, h) => D.adjustPixels(px, w, h, t, p), T);
        });
        box.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { close(); back(); }
            else if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.preventDefault(); ok.click(); }
        });
        shade.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.box.append(shade);
        later();
        return shade;
    },
};
