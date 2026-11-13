// node tests/comp_parity.mjs <cases.json> <out.json>
// The page's comp arithmetic (js/imageViewer_compModel.js) on the cases tests/test_comp_parity.py wrote:
// each case is {comp, frame, sources: {nodeId: {w, h, u8: [..], linear}}}; the answer is the Output's
// picture per case as a list of floats, plus the node table (so Python can check its own against it).
import { readFileSync, writeFileSync } from "node:fs";
import * as C from "../js/imageViewer_compModel.js";

const [, , inPath, outPath] = process.argv;
const cases = JSON.parse(readFileSync(inPath, "utf8"));
const out = { pictures: [], table: {} };
for (const [type, t] of Object.entries(C.NODE_TYPES)) {
    out.table[type] = { inputs: t.inputs, params: Object.fromEntries(Object.entries(t.params).map(([p, d]) =>
        [p, { kind: d.kind, def: d.def, key: !!d.key, min: d.min ?? null, max: d.max ?? null, choices: d.choices ?? null }])) };
}
for (const c of cases) {
    const { comp } = C.normalizeComp(c.comp);
    const pics = {};
    for (const [id, s] of Object.entries(c.sources || {})) pics[id] = C.decode8(Uint8ClampedArray.from(s.u8), s.w, s.h, !!s.linear);
    const deeps = {};
    for (const [id, d] of Object.entries(c.deep || {})) deeps[id] = { w: d.w, h: d.h, n: Uint32Array.from(d.n), s: Float32Array.from(d.s) };
    const img = C.renderNode(comp, comp.output, c.frame, { scale: c.scale || 1, view: c.view || null,
        source: (n, f) => pics[C.srcKey(n, f)] || pics[`${n.id}@${f}`] || pics[n.id] || null,
        deepSource: (n) => deeps[n.id] || null,
        ocio: c.ocio ? (spec) => (spec.dst === "matrixspace" ? { ...c.ocio.mat, data: Float32Array.from(c.ocio.mat.data) } : { ...c.ocio.lut, data: Float32Array.from(c.ocio.lut.data) }) : null });
    out.pictures.push({ w: img.w, h: img.h, data: Array.from(img.data), ch: Object.fromEntries(Object.entries(img.ch || {}).map(([k, v]) => [k, Array.from(v)])) });
}
writeFileSync(outPath, JSON.stringify(out));
