// node --test tests/test_comp_scopes.mjs
// The Comp viewer tools' arithmetic (js/imageViewer_compScopes.js) and the Paint node's stroke rules
// (js/imageViewer_compPaint.js). The Paint node's pixels are compared with numpy in tests/test_comp_parity.py.
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_compScopes.js";
import * as PT from "../js/imageViewer_compPaint.js";
import * as C from "../js/imageViewer_compModel.js";

const pic = (w, h, fill) => { const d = new Float32Array(w * h * 4); for (let i = 0; i < w * h; i++) d.set(fill(i % w, (i / w) | 0), i * 4); return { w, h, data: d }; };

test("a wipe shows A left of the line and B right of it; turned, it follows the angle", () => {
    const A = pic(10, 4, () => [1, 0, 0, 1]), B = pic(10, 4, () => [0, 0, 1, 1]);
    const o = S.compareImages(A, B, "wipe", { wipe: 0.3 });
    assert.equal(o.data[(1 * 10 + 2) * 4], 1);
    assert.equal(o.data[(1 * 10 + 3) * 4 + 2], 1);
    const t = S.compareImages(A, B, "wipe", { wipe: 0.5, angle: 90 });
    assert.equal(t.data[(0 * 10 + 5) * 4], 1, "the top is A when the line lies across");
    assert.equal(t.data[(3 * 10 + 5) * 4 + 2], 1, "the bottom is B");
    assert.equal(S.compareImages(A, null, "wipe"), A, "no B: A itself");
});

test("difference and mix; a smaller B meets A at the bottom left", () => {
    const A = pic(4, 4, () => [0.5, 0.2, 0, 1]), B = pic(2, 2, () => [0.25, 0.4, 0, 1]);
    const d = S.compareImages(A, B, "difference");
    assert.deepEqual(Array.from(d.data.subarray((3 * 4) * 4, (3 * 4) * 4 + 4)).map((v) => +v.toFixed(5)), [0.25, 0.2, 0, 0]);
    assert.deepEqual(Array.from(d.data.subarray(0, 4)).map((v) => +v.toFixed(5)), [0.5, 0.2, 0, 1], "top left: B is not there");
    const m = S.compareImages(A, A, "mix");
    assert.equal(m.data[0], 0.5);
});

test("the sampler reads a pixel and a box's mean, least and most", () => {
    const P = pic(4, 3, (x, y) => [x, y, 0.5, 1]);
    assert.deepEqual(S.sampleAt(P, 2.7, 1.2), [2, 1, 0.5, 1]);
    assert.equal(S.sampleAt(P, -1, 0), null);
    const st = S.boxStats(P, 3, 2, 1, 0);
    assert.equal(st.n, 4);
    assert.deepEqual(st.mean, [1.5, 0.5, 0.5, 1]);
    assert.deepEqual(st.min, [1, 0, 0.5, 1]);
    assert.deepEqual(st.max, [2, 1, 0.5, 1]);
    assert.deepEqual(S.straight([0.25, 0.5, 0, 0.5]), [0.5, 1, 0, 0.5]);
});

test("scopes: a histogram counts each value, a waveform per column, a vectorscope puts grey in the middle", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128, 255, 128, 128, 128, 255]);
    const h = S.histogram(px, 2, 2);
    assert.equal(h.r[255], 1); assert.equal(h.r[0], 1); assert.equal(h.r[128], 2); assert.equal(h.g[0], 2);
    const wf = S.waveform(px, 2, 2, 2, 256);
    assert.equal(wf.data[(255 - 0) * 2 + 1], 1, "black at the bottom of column 1");
    assert.equal(wf.data[(255 - 128) * 2 + 0] + wf.data[(255 - 128) * 2 + 1], 2, "the greys at 128");
    const vs = S.vectorscope(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1, 65);
    assert.equal(vs.data[32 * 65 + 32], 1);
    const [cb, cr] = S.chroma709(255, 0, 0);
    assert.ok(cr > 0.49 && cb < 0, "red is up and to the left");
});

test("out of range marks stripes over 1, under 0 and a bad alpha, leaving every other band", () => {
    const P = pic(16, 1, (x) => (x < 8 ? [2, 0, 0, 1] : [-0.1, 0, 0, 1]));
    const out = new Uint8ClampedArray(16 * 4);
    const n = S.markOutOfRange(P, out);
    assert.equal(n, 16);
    assert.deepEqual(Array.from(out.subarray(4 * 4, 4 * 4 + 3)), [255, 40, 40]);
    assert.deepEqual(Array.from(out.subarray(0, 3)), [0, 0, 0], "a band left as it was");
    assert.deepEqual(Array.from(out.subarray(12 * 4, 12 * 4 + 3)), [40, 110, 255]);
    assert.equal(S.markOutOfRange(pic(4, 1, () => [0.5, 1, 0, 1]), new Uint8ClampedArray(16)), 0);
});

test("guides: the safe areas are 93 % and 90 % of the format, in its middle", () => {
    const g = S.guideRects(1920, 1080);
    assert.deepEqual(g.format, [0, 0, 1920, 1080]);
    assert.deepEqual(g.action.map((v) => Math.round(v * 10) / 10), [67.2, 37.8, 1785.6, 1004.4]);
    assert.deepEqual(g.title.map((v) => Math.round(v * 10) / 10), [96, 54, 1728, 972]);
});

test("paint strokes: cleaned, kept to their frames, found on the picture", () => {
    assert.equal(PT.cleanStroke({ pts: [] }), null);
    const s = PT.cleanStroke({ tool: "nope", pts: [[1, 2], ["x", 3], [4, 5]], size: -3, life: "range", f: 9, f1: 3 });
    assert.equal(s.tool, "color");
    assert.deepEqual(s.pts, [[1, 2], [4, 5]]);
    assert.equal(s.size, 0.5);
    for (const [f, on] of [[2, false], [3, true], [9, true], [10, false]]) assert.equal(PT.strokeLive(s, f), on, `frame ${f}`);
    assert.equal(PT.strokeLive({ ...s, life: "from", f: 4 }, 3), false);
    assert.equal(PT.strokeLive({ ...s, life: "to", f: 4 }, 3), true);
    assert.equal(PT.strokeLive({ ...s, life: "all", off: true }, 3), false, "a hidden stroke is never on");
    const list = [{ pts: [[0, 0], [100, 0]], size: 10 }, { pts: [[50, 50]], size: 20, life: "single", f: 2 }];
    assert.equal(PT.strokeAt(list, 0, 30, 4), 0);
    assert.equal(PT.strokeAt(list, 2, 55, 52), 1);
    assert.equal(PT.strokeAt(list, 0, 55, 52), -1, "not on frame 0");
    assert.deepEqual(PT.paintFrames([{ tool: "clone", pts: [[0, 0]], dt: -1 }, { tool: "reveal", pts: [[0, 0]], dt: 2 }], 5), { clone: [4], reveal: [7] });
});

test("a stroke's dabs are spaced by its size, and a linked stroke moves with its Transform", () => {
    const s = PT.cleanStroke({ pts: [[0, 0], [100, 0]], size: 20, spacing: 0.25 });
    const d = PT.strokeDabs(s);
    assert.equal(d.length, 21);
    assert.deepEqual(d[1], [5, 0]);
    const comp = C.newComp({ width: 200, height: 100 });
    const t = C.makeNode(comp, "transform", { inputs: ["Constant1"], tracks: { translate: [{ f: 0, v: [0, 0] }, { f: 10, v: [20, 10] }] } });
    C.addNode(comp, t);
    const m = C.linkMatrix(comp, { link: t.id, f: 0 }, 5);
    assert.deepEqual(m.map((v) => Math.round(v * 1000) / 1000), [1, 0, 0, 1, 10, 5]);
    assert.equal(C.linkMatrix(comp, { f: 0 }, 5), null);
});

test("a Paint node renders its strokes over its input; reveal needs its second input", () => {
    const comp = C.newComp({ width: 40, height: 20 });
    C.nodeById(comp, "Constant1").color = [0.2, 0.2, 0.2, 1];
    const p = C.makeNode(comp, "paint", { inputs: ["Constant1"], strokes: [
        { tool: "color", pts: [[5, 10], [15, 10]], size: 6, hard: 1, color: [1, 0, 0, 1] },
        { tool: "reveal", pts: [[30, 10]], size: 6, hard: 1 },
    ] });
    C.addNode(comp, p);
    const img = C.renderNode(comp, p.id, 0, {});
    const at = (x, y) => Array.from(img.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
    assert.deepEqual(at(10, 10), [1, 0, 0, 1]);
    assert.deepEqual(at(30, 10).map((v) => +v.toFixed(4)), [0.2, 0.2, 0.2, 1], "no reveal input: nothing revealed");
    assert.ok(C.TYPE_ORDER.includes("paint"));
    assert.deepEqual(C.NODE_TYPES.paint.inputs, ["src", "reveal"]);
});

test("a Paint node's cache key changes with the Transform its strokes follow", () => {
    const comp = C.newComp({ width: 40, height: 20 });
    const t = C.addNode(comp, C.makeNode(comp, "transform", { inputs: ["Constant1"] }));
    const p = C.addNode(comp, C.makeNode(comp, "paint", { inputs: ["Constant1"], strokes: [{ pts: [[1, 1]], link: t.id }] }));
    const before = C.upstreamHash(comp, p.id);
    t.translate = [5, 0];
    assert.notEqual(C.upstreamHash(comp, p.id), before);
});
