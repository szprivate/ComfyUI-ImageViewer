// The page's arithmetic on documents written by tests/test_paint_parity.py: reads <in>.json (the
// document, its layers' pixels and masks base64) and writes the composite (and the filters'
// results) base64 to <out>.json. Run by that test; not a test of its own.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [, , inFile, outFile] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
const D = await import(pathToFileURL(path.join(here, "..", "js", "imageViewer_paintData.js")).href);
const W = await import(pathToFileURL(path.join(here, "..", "js", "imageViewer_paintWarp.js")).href);
const G = await import(pathToFileURL(path.join(here, "..", "js", "imageViewer_paintDraw.js")).href);
const S = await import(pathToFileURL(path.join(here, "..", "js", "imageViewer_paintSelect.js")).href);
const SL = await import(pathToFileURL(path.join(here, "..", "js", "imageViewer_paintSmartLayer.js")).href);
const job = JSON.parse(fs.readFileSync(inFile, "utf8"));
const dec = (b) => new Uint8Array(Buffer.from(b, "base64"));
const enc = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
const out = {};
for (const [name, c] of Object.entries(job.cases)) {
    const doc = D.cleanDoc(c.doc);
    const px = {}, masks = {};
    for (const [id, b] of Object.entries(c.px)) px[id] = new Uint8ClampedArray(dec(b));
    for (const [id, b] of Object.entries(c.masks)) masks[id] = dec(b);
    const res = { composite: enc(D.composite(doc, (L) => px[L.id], (L) => D.maskAsItActs(L, masks[L.id] || null))) };
    if (c.filters) {
        const L = doc.layers[0], p = px[L.id];
        res.blur = enc(D.blurPixels(p, L.w, L.h, c.filters.blur));
        res.sharpen = enc(D.sharpenPixels(p, L.w, L.h, c.filters.radius, c.filters.amount));
        res.feather = enc(D.feather(D.ellipseMask(L.w, L.h, 3, 4, L.w * 0.6, L.h * 0.5), L.w, L.h, c.filters.blur));
        res.polygon = enc(D.polygonMask(L.w, L.h, c.filters.polygon));
        res.ellipse = enc(D.ellipseMask(L.w, L.h, 2.5, 3.2, L.w * 0.7, L.h * 0.6));
    }
    if (c.path) {
        const P = D.cleanPath(c.path.path), W = c.path.w, H = c.path.h;
        const line = D.flattenPath(P);
        res.path_line = line;
        res.path_fill = enc(D.pathMask(W, H, P));
        res.path_stroke = enc(D.strokeMask(W, H, line, P.closed, c.path.width));
    }
    if (c.smart) {
        // A source drawn by a canvas matrix: its pixels, box and level, and the halved source.
        const sp = c.smart, src = { px: new Uint8ClampedArray(dec(sp.src)), w: sp.w, h: sp.h };
        res.smart = sp.mats.map((cm) => { const r = SL.render(src, cm, sp.W, sp.H); return { px: enc(r.px), box: r.box, m: r.m, cut: r.cut, k: SL.levelFor(cm, sp.w, sp.h) }; });
        res.halve = enc(SL.halveRGBA(src.px, sp.w, sp.h).px);
    }
    if (c.distort) {
        const L = doc.layers[0], r = W.perspectiveLayer(px[L.id], L.w, L.h, c.distort);
        res.distort = enc(r.px);
        res.distort_box = r.box;
    }
    if (c.draw) {
        res.gradients = c.draw.gradients.map((g) => enc(G.gradientPixels(c.draw.w, c.draw.h, c.draw.ox, c.draw.oy, g)));
        res.shapes = c.draw.shapes.map((q) => D.flattenPath(D.cleanPath(G.shapePath(q.kind, q.x0, q.y0, q.x1, q.y1, q))));
        res.stops = c.draw.presets.map(([p, fg, bg]) => G.gradientStops(p, fg, bg));
    }
    if (c.select) {
        const q = c.select, m = dec(q.mask), sp = new Uint8ClampedArray(dec(q.px));
        const fn = { expand: S.expandMask, contract: S.contractMask, smooth: S.smoothMask, border: S.borderMask };
        res.modify = q.modify.map(([k, r]) => enc(fn[k](m, q.w, q.h, r)));
        res.range = q.range.map(([col, f]) => enc(S.colorRange(sp, q.w, q.h, col, f)));
    }
    res.guides = doc.guides || [];
    out[name] = res;
}
fs.writeFileSync(outFile, JSON.stringify(out));
