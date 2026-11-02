// bEpicViewer_editTitles.js
// A title of the Edit panel: what it may be (TITLE), how its words are laid out
// in its text box (layoutTitle) and how they are drawn (drawTitle). A title is a
// CLIP on a video track (clip.title holds its words and its look); everything a
// clip is done to - moved, trimmed, bladed, keyed, switched off - it is done to
// the same way, and its picture is a frame-sized layer with the words on it, laid
// over what is under it like any clip's picture (fxPlace / timeline_render.lay).
//
// title_render.py is the same arithmetic in Python (PIL), so the preview and the
// render agree: the same table, the same layout - glyph by glyph, by the font's
// own advances (no kerning, no ligatures: what both can do the same), the same
// line boxes, the same synthetic bold / italic where the family has no such face.
// A change to one is a change to the other (tests/test_edit_titles_parity.py).
//
// No DOM here: drawTitle draws on any 2D context it is given (a page's canvas,
// an OffscreenCanvas), so the layout runs under node.

// Every number: [default, low, high]. Lengths are in percent of the font size,
// the size in percent of the frame's height, the box in fractions of the frame
// (x / y its middle, y DOWN), tracking in thousandths of an em.
export const TITLE_NUM = {
    size: [6, 0.5, 40], track: [0, -200, 1000], line: [1.2, 0.5, 4], op: [1, 0, 1],
    sw: [7, 0, 50], shx: [0, -100, 100], shy: [0, -100, 100], shb: [0, 0, 100], sho: [0, 0, 1],
    bgo: [0, 0, 1], bgp: [20, 0, 200], bgr: [0, 0, 200],
    x: [0.5, 0, 1], y: [0.85, 0, 1], w: [0.9, 0.02, 1], h: [0.2, 0.02, 1],
};
export const TITLE_COLORS = { color: "#ffffff", sc: "#000000", shc: "#000000", bgc: "#000000" };
export const TITLE_FLAGS = ["bold", "italic", "underline", "strike"];
export const TITLE_CHOICES = { align: ["center", "left", "right", "justify"], valign: ["middle", "top", "bottom"], caps: ["none", "upper"] };
export const TITLE_FONT = "Arial";
export const MAX_TITLE_TEXT = 2000;

// The title's numbers that take keyframes, by the key's name in clip.fx.keys.
export const TITLE_KEYS = { tsize: "size", ttrack: "track", tline: "line", tsw: "sw" };

// When a font says nothing of its own (a web-safe family with no file): its ascent and descent, of an em.
export const DEFAULT_METRICS = { asc: 0.905, desc: 0.212 };
// Synthetic styles, for a family without that face: bold is an edge of the fill's
// own colour this share of the size wide; italic leans the glyphs by this much.
export const SYNTH_BOLD = 0.03;
export const SYNTH_ITALIC = 0.2;
// Underline and strike-through: where (from the baseline, down positive) and how thick, of the size.
export const UNDERLINE = { at: 0.08, thick: 0.06 };
export const STRIKE = { at: -0.28, thick: 0.06 };
// The families tried, in order, when the one asked for is not on the machine.
export const FALLBACK_FAMILIES = ["Arial", "Helvetica", "Liberation Sans", "DejaVu Sans", "Segoe UI"];
// The families offered without a font list from the server (drawn by the browser's own fonts).
export const WEB_SAFE = ["Arial", "Helvetica", "Times New Roman", "Georgia", "Courier New", "Verdana", "Trebuchet MS", "Impact"];

const isColor = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ""));
const r5 = (v) => Math.round(v * 100000) / 100000;

/** `given` held to what a title may be, every part of it present. */
export function cleanTitle(given) {
    const g = given && typeof given === "object" ? given : {};
    const out = { text: String(g.text == null ? "Title" : g.text).slice(0, MAX_TITLE_TEXT) };
    const font = String(g.font == null ? "" : g.font).replace(/[\u0000-\u001f"\\]/g, "").trim().slice(0, 120);
    out.font = font || TITLE_FONT;
    for (const [k, [def, lo, hi]] of Object.entries(TITLE_NUM)) {
        const v = Number(g[k]);
        out[k] = g[k] === undefined || g[k] === null || g[k] === "" || !Number.isFinite(v) ? def : r5(Math.max(lo, Math.min(hi, v)));
    }
    for (const [k, def] of Object.entries(TITLE_COLORS)) out[k] = isColor(g[k]) ? String(g[k]).toLowerCase() : def;
    for (const k of TITLE_FLAGS) out[k] = g[k] === true;
    for (const [k, list] of Object.entries(TITLE_CHOICES)) out[k] = list.includes(g[k]) ? g[k] : list[0];
    return out;
}

/** A title made from a text of an older cut ({ text, size, x, y, color }): it looks as the text did. */
export function titleFromText(t) {
    const o = t || {};
    return cleanTitle({ text: o.text, size: o.size, x: o.x, y: o.y, color: o.color });
}

/** The words as they are drawn: in capitals for caps "upper". */
export function titleWords(look) {
    const s = String((look && look.text) || "").replace(/\r/g, "");
    return look && look.caps === "upper" ? s.toUpperCase() : s;
}

/**
 * The face a title is drawn with: `fonts` is the server's list ([{ family, faces:
 * { regular, bold, italic, bolditalic } }], a face { id, url, asc, desc }), or
 * empty. Answers { family, face, bold, italic (synthetic ones still to do),
 * missing (the family asked for is not there), web (no file: the browser's own) }.
 * title_render.resolve_face is the same choice.
 */
export function resolveFace(fonts, family, bold, italic) {
    const list = Array.isArray(fonts) ? fonts : [];
    const find = (name) => list.find((f) => String(f.family).toLowerCase() === String(name || "").toLowerCase());
    let fam = find(family);
    const missing = !fam;
    if (!fam) for (const name of FALLBACK_FAMILIES) { fam = find(name); if (fam) break; }
    if (!fam && list.length) fam = list[0];
    if (!fam) return { family: family || TITLE_FONT, face: null, bold: !!bold, italic: !!italic, missing: !WEB_SAFE.includes(family), web: true };
    const faces = fam.faces || {};
    const want = (bold ? "bold" : "") + (italic ? "italic" : "") || "regular";
    if (faces[want]) return { family: fam.family, face: faces[want], bold: false, italic: false, missing, web: false };
    // Nearest face, the rest synthetic.
    const tries = bold && italic ? [["bold", false, true], ["italic", true, false], ["regular", true, true]]
        : bold ? [["regular", true, false]] : italic ? [["regular", false, true]] : [];
    for (const [k, b, i] of tries) if (faces[k]) return { family: fam.family, face: faces[k], bold: b, italic: i, missing, web: false };
    const any = faces.regular || faces.bold || faces.italic || faces.bolditalic || null;
    return { family: fam.family, face: any, bold: !!bold, italic: !!italic, missing, web: !any };
}

/**
 * Where every glyph of a title goes in a W x H frame. `measure(ch)` is the
 * advance of one character at the font size (in pixels, the font's own linear
 * advance - no kerning); `metrics` { asc, desc } of an em. Returns
 *
 *   { px, lines: [{ text, x0, x1, base, top, glyphs: [{ ch, x }] }], box: { x0, y0, x1, y1 } | null,
 *     block: { x0, y0, x1, y1 }, strokePx, boldPx, under: [{x0, x1, y, h}], shadow: { dx, dy, blur } }
 *
 * The same in title_render.layout.
 */
export function layoutTitle(look, W, H, measure, metrics = DEFAULT_METRICS, synth = {}) {
    const L = cleanTitle(look);
    const px = Math.max(1, H * L.size / 100);
    const trk = L.track / 1000 * px;
    const boxW = L.w * W, boxH = L.h * H;
    const boxL = L.x * W - boxW / 2, boxT = L.y * H - boxH / 2;
    const lineH = L.line * px;
    const adv = new Map();
    const a = (ch) => { if (!adv.has(ch)) adv.set(ch, Number(measure(ch)) || 0); return adv.get(ch); };
    const width = (s) => { let w = 0; for (const ch of s) w += a(ch) + trk; return s.length ? w - trk : 0; };
    // Lines: the paragraphs, each wrapped at the box's width by words (a word wider than the box keeps a line of its own).
    const lines = [];
    for (const para of titleWords(L).split("\n")) {
        const words = para.split(/ +/).filter((w) => w.length);
        if (!words.length) { lines.push({ text: "", last: true }); continue; }
        let line = "";
        for (const word of words) {
            const cand = line ? line + " " + word : word;
            if (line && width(cand) > boxW + 1e-6) { lines.push({ text: line, last: false }); line = word; }
            else line = cand;
        }
        lines.push({ text: line, last: true });
    }
    const blockH = lines.length * lineH;
    const top = L.valign === "top" ? boxT : L.valign === "bottom" ? boxT + boxH - blockH : boxT + (boxH - blockH) / 2;
    const asc = Number(metrics && metrics.asc) || DEFAULT_METRICS.asc, desc = Number(metrics && metrics.desc) || DEFAULT_METRICS.desc;
    const out = [];
    let bx0 = Infinity, bx1 = -Infinity;
    lines.forEach((ln, k) => {
        const lw = width(ln.text);
        const spaces = [...ln.text].filter((ch) => ch === " ").length;
        const stretch = L.align === "justify" && !ln.last && spaces > 0 ? (boxW - lw) / spaces : 0;
        const x0 = L.align === "right" ? boxL + boxW - lw : L.align === "center" ? boxL + (boxW - lw) / 2 : boxL;
        const lineTop = top + k * lineH;
        const base = lineTop + (lineH - (asc + desc) * px) / 2 + asc * px;
        const glyphs = [];
        let x = x0;
        for (const ch of ln.text) {
            glyphs.push({ ch, x });
            x += a(ch) + trk + (ch === " " ? stretch : 0);
        }
        const x1 = x0 + lw + stretch * spaces;
        if (ln.text.length) { bx0 = Math.min(bx0, x0); bx1 = Math.max(bx1, x1); }
        out.push({ text: ln.text, x0, x1, base, top: lineTop, glyphs });
    });
    if (!(bx1 > bx0)) { bx0 = bx1 = L.x * W; }
    const block = { x0: bx0, y0: top, x1: bx1, y1: top + blockH };
    const pad = L.bgp / 100 * px;
    const box = L.bgo > 0 ? { x0: bx0 - pad, y0: top - pad, x1: bx1 + pad, y1: top + blockH + pad,
                              r: Math.min(L.bgr / 100 * px, (bx1 - bx0 + 2 * pad) / 2, (blockH + 2 * pad) / 2) } : null;
    const under = [];
    for (const ln of out) {
        if (!ln.text.length) continue;
        const t = Math.max(1, UNDERLINE.thick * px);
        if (L.underline) under.push({ x0: ln.x0, x1: ln.x1, y: ln.base + UNDERLINE.at * px, h: t });
        if (L.strike) under.push({ x0: ln.x0, x1: ln.x1, y: ln.base + STRIKE.at * px - Math.max(1, STRIKE.thick * px) / 2, h: Math.max(1, STRIKE.thick * px) });
    }
    return {
        px, look: L, lines: out, block, box, under,
        strokePx: L.sw > 0 ? Math.max(1, Math.round(L.sw / 100 * px)) : 0,
        boldPx: synth.bold ? Math.max(1, Math.round(SYNTH_BOLD * px)) : 0,
        italic: !!synth.italic,
        shadow: L.sho > 0 ? { dx: L.shx / 100 * px, dy: L.shy / 100 * px, blur: L.shb / 100 * px } : null,
    };
}

const rgba = (hex, alpha) => {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
};

function roundRect(ctx, x0, y0, x1, y1, r) {
    ctx.beginPath();
    if (r > 0 && ctx.roundRect) ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r);
    else ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fill();
}

/**
 * Draw a laid-out title (layoutTitle) on `ctx`, a W x H frame that is otherwise
 * left as it is. `font` is the CSS font of the face at the size (`${px}px "name"`),
 * `makeCanvas(w, h)` a canvas to draw the words on before they go on the frame
 * (for the shadow). The order is the render's: the box, the shadow, the
 * outline, the fill and its lines.
 */
export function drawTitle(ctx, lay, W, H, font, makeCanvas) {
    const L = lay.look;
    if (lay.box) {
        ctx.save();
        ctx.fillStyle = rgba(L.bgc, L.bgo);
        roundRect(ctx, lay.box.x0, lay.box.y0, lay.box.x1, lay.box.y1, lay.box.r);
        ctx.restore();
    }
    const words = makeCanvas(W, H);
    const g = words.getContext("2d");
    g.font = font;
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    try { g.fontKerning = "none"; } catch (_) {}
    try { g.textRendering = "optimizeSpeed"; } catch (_) {}
    g.lineJoin = "round";
    const each = (fn) => {
        for (const ln of lay.lines) {
            if (!ln.glyphs.length) continue;
            g.save();
            // Synthetic italic: the line leans about its baseline.
            if (lay.italic) g.transform(1, 0, -SYNTH_ITALIC, 1, SYNTH_ITALIC * ln.base, 0);
            for (const q of ln.glyphs) if (q.ch !== " ") fn(q, ln);
            g.restore();
        }
    };
    if (lay.strokePx > 0) {
        g.strokeStyle = L.sc;
        g.lineWidth = 2 * (lay.strokePx + lay.boldPx);
        each((q, ln) => g.strokeText(q.ch, q.x, ln.base));
        g.fillStyle = L.sc;
        for (const u of lay.under) g.fillRect(u.x0 - lay.strokePx, u.y - lay.strokePx, u.x1 - u.x0 + 2 * lay.strokePx, u.h + 2 * lay.strokePx);
    }
    g.fillStyle = L.color;
    if (lay.boldPx > 0) {
        g.strokeStyle = L.color;
        g.lineWidth = 2 * lay.boldPx;
        each((q, ln) => g.strokeText(q.ch, q.x, ln.base));
    }
    each((q, ln) => g.fillText(q.ch, q.x, ln.base));
    for (const u of lay.under) g.fillRect(u.x0, u.y, u.x1 - u.x0, u.h);
    if (lay.shadow) {
        const sh = makeCanvas(W, H);
        const s = sh.getContext("2d");
        s.fillStyle = L.shc;
        s.fillRect(0, 0, W, H);
        s.globalCompositeOperation = "destination-in";
        s.drawImage(words, 0, 0);
        ctx.save();
        ctx.globalAlpha = L.sho * L.op;
        if (lay.shadow.blur > 0) ctx.filter = `blur(${lay.shadow.blur}px)`;
        ctx.drawImage(sh, lay.shadow.dx, lay.shadow.dy);
        ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = L.op;
    ctx.drawImage(words, 0, 0);
    ctx.restore();
}
