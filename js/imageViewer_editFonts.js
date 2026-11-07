// imageViewer_editFonts.js
// The fonts a title is drawn with: the machine's families (GET /imageviewer/fonts,
// title_render.font_list on the server - the same list the render resolves a
// family in, so both draw with the same FILE), each face loaded into the page as
// a FontFace of its own ("imageviewerf-<id>", GET /imageviewer/font_file?id=) in the document
// the title is drawn in (the viewer's, or the pop-out's). Without the list (an
// older server) the web-safe families are offered and drawn by the browser.
// ComfyUI's api is imported when the list is first asked for (this module is also loaded under node, by the player's tests).
let api = null;
import { DEFAULT_METRICS, WEB_SAFE, drawTitle, layoutTitle, resolveFace } from "./imageViewer_editTitles.js";

let listing = null;            // the promise of the list
let known = null;              // the list once it came: { fonts, fallback }
const faces = new WeakMap();   // document -> Map(id -> "loading" | "ready" | "failed")

/** The machine's font families: { fonts: [{ family, faces }], fallback } (an empty list without the route). */
export function fontList(refresh = false) {
    if (listing && !refresh) return listing;
    listing = (async () => {
        try {
            if (!api) api = (await import("../../scripts/api.js")).api;
            const res = await api.fetchApi("/imageviewer/fonts" + (refresh ? "?refresh=1" : ""));
            if (!res.ok) throw new Error(String(res.status));
            const got = await res.json();
            known = { fonts: Array.isArray(got.fonts) ? got.fonts : [], fallback: got.fallback || [] };
        } catch (_) {
            known = { fonts: [], fallback: [] };
        }
        return known;
    })();
    return listing;
}

/** The list if it has come (null before). */
export function fontsKnown() { return known; }

/** The families a picker offers: the machine's, else the web-safe ones. */
export function familyNames() {
    const list = known && known.fonts.length ? known.fonts.map((f) => f.family) : WEB_SAFE;
    return [...new Set(list)];
}

/**
 * How a title's look is drawn in `doc`: { css (the CSS family, quoted), metrics,
 * synth { bold, italic }, ready (the face is loaded), missing (the family is not
 * on this machine), family (the one drawn with) }. A face not loaded yet is
 * started, and `onReady` called when it is.
 */
export function titleFace(doc, look, onReady) {
    const got = resolveFace(known ? known.fonts : [], look.font, look.bold, look.italic);
    if (!got.face) {
        // No file: the browser's own family (web-safe), its own bold and italic.
        const css = `"${String(got.family).replace(/"/g, "")}", sans-serif`;
        return { css, metrics: DEFAULT_METRICS, synth: {}, ready: true, missing: got.missing, family: got.family, webStyle: true };
    }
    const id = got.face.id;
    const name = "imageviewerf-" + id;
    let map = faces.get(doc);
    if (!map) { map = new Map(); faces.set(doc, map); }
    const state = map.get(id);
    if (!state) {
        map.set(id, "loading");
        try {
            const url = api && api.apiURL ? api.apiURL(got.face.url) : got.face.url;
            const ff = new (doc.defaultView || window).FontFace(name, `url("${url}")`);
            doc.fonts.add(ff);
            ff.load().then(() => { map.set(id, "ready"); if (onReady) onReady(); },
                           () => { map.set(id, "failed"); if (onReady) onReady(); });
        } catch (_) { map.set(id, "failed"); }
    }
    const now = map.get(id);
    return {
        css: now === "failed" ? "sans-serif" : `"${name}"`,
        metrics: { asc: Number(got.face.asc) || DEFAULT_METRICS.asc, desc: Number(got.face.desc) || DEFAULT_METRICS.desc },
        synth: { bold: got.bold, italic: got.italic }, ready: now !== "loading", missing: got.missing, family: got.family,
        failed: now === "failed",
    };
}

/** What to say of a title's font where it is not on this machine ("" when it is). */
export function fontNote(look) {
    if (!known) return "";
    const got = resolveFace(known.fonts, look.font, look.bold, look.italic);
    if (!got.missing) return "";
    return `${look.font} is not on this machine: drawn with ${got.family}` + (known.fonts.length ? "" : " (no font list from the server)");
}

/**
 * A title drawn on `canvas` (cleared first) in the frame `box` ({ x, y, w, h }
 * in the canvas's own pixels): the face loaded for its document, the layout and
 * the drawing of imageViewer_editTitles.js. `onReady` is called when a face that
 * was still loading has come (draw it again then). Returns titleFace's answer.
 */
export function paintTitle(canvas, look, box, onReady) {
    const doc = canvas.ownerDocument;
    const f = titleFace(doc, look, onReady);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const W = box.w, H = box.h;
    if (!(W > 0 && H > 0)) return f;
    const style = f.webStyle ? `${look.italic ? "italic " : ""}${look.bold ? "bold " : ""}` : "";
    const font = (px) => `${style}${px}px ${f.css}`;
    const make = (w, h) => {
        const c = doc.createElement("canvas");
        c.width = Math.max(1, Math.ceil(w));
        c.height = Math.max(1, Math.ceil(h));
        return c;
    };
    const probe = make(4, 4).getContext("2d");
    probe.font = font(200);
    try { probe.fontKerning = "none"; } catch (_) {}
    const px = Math.max(1, H * Number(look.size) / 100);
    const lay = layoutTitle(look, W, H, (ch) => probe.measureText(ch).width * px / 200, f.metrics, f.synth);
    ctx.save();
    ctx.translate(box.x, box.y);
    drawTitle(ctx, lay, W, H, font(lay.px), make);
    ctx.restore();
    return f;
}
