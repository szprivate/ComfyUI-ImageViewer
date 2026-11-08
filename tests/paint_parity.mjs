// The page's arithmetic on documents written by tests/test_paint_parity.py: reads <in>.json (the
// document, its layers' pixels and masks base64) and writes the composite (and the filters'
// results) base64 to <out>.json. Run by that test; not a test of its own.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [, , inFile, outFile] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
const D = await import(pathToFileURL(path.join(here, "..", "js", "imageViewer_paintData.js")).href);
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
    out[name] = res;
}
fs.writeFileSync(outFile, JSON.stringify(out));
