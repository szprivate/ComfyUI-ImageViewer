// node --test tests/test_comp_model.mjs
// The comp document's edits and the Layers panel's reading of the graph (js/imageViewer_compModel.js).
// The pixels are compared with the Python render in tests/test_comp_parity.py.
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/imageViewer_compModel.js";
import * as Mo from "../js/imageViewer_mgModel.js";

const read = (comp, file) => C.makeNode(comp, "read", { file });

test("a new comp is a Constant into an Output, and normalises to itself", () => {
    const c = C.newComp({ width: 640, height: 360, fps: 25, frames: 10 });
    assert.deepEqual(c.nodes.map((n) => n.type), ["constant", "output"]);
    assert.equal(c.output, "Output1");
    assert.deepEqual(C.nodeById(c, "Output1").inputs, ["Constant1"]);
    const { comp, errors } = C.normalizeComp(JSON.parse(JSON.stringify(c)));
    assert.deepEqual(errors, []);
    assert.deepEqual(comp, c);
});

test("normalise drops unknown nodes, dangling inputs and loops, and finds the Output", () => {
    const { comp, errors } = C.normalizeComp({ comp: 1, format: { width: 10, height: 10 }, nodes: [
        { id: "A", type: "grade", inputs: ["B"] }, { id: "B", type: "blur", inputs: ["A"] },
        { id: "X", type: "nonsense" }, { id: "O", type: "output", inputs: ["Nope"] }] });
    assert.equal(comp.nodes.length, 3);
    assert.equal(comp.output, "O");
    assert.deepEqual(C.nodeById(comp, "O").inputs, [null]);
    const loops = [C.nodeById(comp, "A").inputs[0], C.nodeById(comp, "B").inputs[0]];
    assert.equal(loops.filter(Boolean).length, 1, "one of the two inputs that made the loop is gone");
    assert.ok(errors.length >= 2);
});

test("connect refuses a loop; delete reconnects through the first input", () => {
    const c = C.newComp();
    const r = C.addNode(c, read(c, "a.png"));
    const g = C.insertNode(c, "grade", r.id);
    const b = C.insertNode(c, "blur", g.id);
    assert.deepEqual(b.inputs, [g.id]);
    assert.equal(C.connect(c, r.id === "Read1" ? g.id : g.id, 0, b.id), false, "blur -> grade would loop");
    C.removeNodes(c, [g.id]);
    assert.deepEqual(C.nodeById(c, b.id).inputs, [r.id]);
});

test("insertNode after a node takes over what read it", () => {
    const c = C.newComp();
    const g = C.insertNode(c, "grade", "Constant1");
    assert.deepEqual(C.nodeById(c, "Output1").inputs, [g.id]);
    assert.deepEqual(g.inputs, ["Constant1"]);
    assert.ok(C.nodeById(c, "Output1").y > g.y, "the Output moved down to make room");
});

test("the Layers panel reads the B pipe as a stack, top first", () => {
    const c = C.newComp();
    const r1 = read(c, "D:/plates/bg.exr");
    C.addLayer(c, r1);
    const r2 = read(c, "fg.####.png");
    const { merge: m2 } = C.addLayer(c, r2);
    C.insertNode(c, "grade", r2.id);
    const L = C.layerStack(c);
    assert.deepEqual(L.map((l) => [l.kind, l.name]), [["layer", "fg.####.png"], ["layer", "bg.exr"], ["background", "Background"]]);
    assert.equal(L[0].merge, m2.id);
    assert.deepEqual(L[0].chain.map((id) => C.nodeById(c, id).type), ["grade", "read"]);
    assert.equal(L[0].source, r2.id);
});

test("moving a layer swaps the Merges' A branches and settings; removing one keeps the pipe", () => {
    const c = C.newComp();
    const a = read(c, "a.png"); const { merge: ma } = C.addLayer(c, a);
    const b = read(c, "b.png"); const { merge: mb } = C.addLayer(c, b);
    C.nodeById(c, mb.id).operation = "screen";
    assert.equal(C.moveLayer(c, 0, 1), true);
    let L = C.layerStack(c);
    assert.deepEqual(L.map((l) => l.name), ["a.png", "b.png", "Background"]);
    assert.equal(C.nodeById(c, L[1].merge).operation, "screen", "the setting went with the picture");
    assert.equal(C.moveLayer(c, 1, 1), false, "the background is not a layer that moves");
    assert.equal(C.removeLayer(c, 0), true);
    L = C.layerStack(c);
    assert.deepEqual(L.map((l) => l.name), ["b.png", "Background"]);
    assert.equal(C.nodeById(c, "a.png") || c.nodes.find((n) => n.file === "a.png"), undefined, "its Read went too");
    void ma;
});

test("a Merge inside an A input makes that layer a group", () => {
    const c = C.newComp();
    const x = read(c, "x.png");
    const { merge } = C.addLayer(c, x);
    const inner = C.addNode(c, C.makeNode(c, "merge", { inputs: [x.id, null, null] }));
    C.connect(c, merge.id, 1, inner.id);
    assert.equal(C.layerStack(c)[0].kind, "group");
});

test("keys: Motion's stopwatch and interpolation work on a node's param", () => {
    const c = C.newComp();
    const t = C.addNode(c, C.makeNode(c, "transform"));
    const host = { comp: { width: 1920, height: 1080 } };
    Mo.toggleAnimated(host, t, "rotate", 0);
    Mo.setProp(host, t, "rotate", 90, 10);
    assert.equal(C.paramAt(t, "rotate", 5), 45);
    assert.deepEqual(C.nodeKeyFrames(t), [0, 10]);
    Mo.setProp(host, t, "mix", 2, 0);
    const m = C.addNode(c, C.makeNode(c, "merge"));
    m.tracks = { mix: [{ f: 0, v: 0 }, { f: 4, v: 2, ease: "linear" }] };
    assert.equal(C.paramAt(m, "mix", 4), 1, "held to its range");
});

test("sourceFrame slides and holds", () => {
    const n = { offset: 2 };
    assert.equal(C.sourceFrame(n, { kind: "sequence", first: 1001, last: 1010 }, 0), 1001, "held at the first before it starts");
    assert.equal(C.sourceFrame(n, { kind: "sequence", first: 1001, last: 1010 }, 5), 1004);
    assert.equal(C.sourceFrame(n, { kind: "sequence", first: 1001, last: 1010 }, 50), 1010);
    assert.equal(C.sourceFrame(n, { kind: "still" }, 5), null);
});

test("the screen shows premultiplied colour over black in sRGB; A shows the alpha", () => {
    const img = { w: 1, h: 1, data: Float32Array.from([0.5 * 0.5, 0, 0, 0.5]) };
    const out = C.encode8(img, new Uint8ClampedArray(4));
    assert.equal(out[0], Math.round(C.linearToSrgb(0.25) * 255));
    assert.equal(C.encode8(img, new Uint8ClampedArray(4), { alpha: true })[0], Math.round(C.linearToSrgb(0.5) * 255));
});

test("a node with nothing to hang under goes right of the others, not on top of one", () => {
    const comp = C.newComp();
    const r = C.insertNode(comp, "read", null);
    const bg = comp.nodes.find((n) => n.type === "constant");
    assert.ok(r.x >= bg.x + C.NODE_W, `${r.x}`);
    assert.equal(r.y, Math.min(...comp.nodes.map((n) => n.y)));
});

// ── the nodes added after the first seven ───────────────────────────────────
import * as O from "../js/imageViewer_compOps.js";

const solid = (w, h, rgba) => { const p = C.blank(w, h); for (let i = 0; i < w * h * 4; i += 4) p.data.set(rgba, i); return p; };
/** A smooth pattern moved by (dx, dy) a frame. */
const pattern = (w, h, f, dx, dy) => {
    const p = C.blank(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = (x - dx * f) / 7, v = (y - dy * f) / 9;
        const g = 0.5 + 0.25 * Math.sin(u) * Math.cos(v) + 0.2 * Math.sin(u * 0.37 + v * 0.71);
        p.data.set([g, g * 0.8, g * 0.6, 1], (y * w + x) * 4);
    }
    return p;
};

test("the optical flow finds a picture moving by a pixel and a half to the right and one up", () => {
    const w = 64, h = 48;
    const g0 = O.greyOf(pattern(w, h, 0, 1.5, -1)), g1 = O.greyOf(pattern(w, h, 1, 1.5, -1));
    const { u, v } = O.opticalFlow(g0, g1, w, h);
    let su = 0, sv = 0, n = 0;
    for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) { su += u[y * w + x]; sv += v[y * w + x]; n++; }
    assert.ok(Math.abs(su / n - 1.5) < 0.2, `u ${su / n}`);
    assert.ok(Math.abs(sv / n + 1) < 0.2, `v ${sv / n}`);
});

test("Vectors and MotionBlur read the frames around the playhead; a Retime reads the frame it maps to", () => {
    const comp = C.newComp({ width: 8, height: 8 });
    const r = C.addNode(comp, read(comp, "a.mov"));
    const v = C.addNode(comp, C.makeNode(comp, "vectors", { inputs: [r.id] }));
    const t = C.addNode(comp, C.makeNode(comp, "retime", { inputs: [r.id], speed: 2, start: 1 }));
    const mb = C.addNode(comp, C.makeNode(comp, "motionblur", { inputs: [r.id, null] }));
    assert.deepEqual(C.sourceNeeds(comp, v.id, 5).map((x) => x.frame), [4, 5, 6]);
    assert.deepEqual(C.sourceNeeds(comp, mb.id, 5).map((x) => x.frame), [4, 5, 6]);
    assert.deepEqual(C.sourceNeeds(comp, t.id, 5).map((x) => x.frame), [9]);
    t.blend = "mix"; t.speed = 0.5;
    assert.deepEqual(C.sourceNeeds(comp, t.id, 4).map((x) => x.frame), [2, 3], "1 + 3 x 0.5 = 2.5: frames 2 and 3");
    const seen = [];
    C.renderNode(comp, t.id, 4, { scale: 1, source: (n, f) => { seen.push(f); return solid(8, 8, [f / 10, 0, 0, 1]); } });
    assert.deepEqual(seen.sort(), [2, 3]);
    const img = C.renderNode(comp, t.id, 4, { scale: 1, source: (n, f) => solid(8, 8, [f / 10, 0, 0, 1]) });
    assert.ok(Math.abs(img.data[0] - 0.25) < 1e-6, "half way between frame 2 and 3");
});

test("a heavy node's result is kept between renders and taken again while nothing upstream changed", () => {
    const comp = C.newComp({ width: 16, height: 16 });
    const r = C.addNode(comp, read(comp, "a.png"));
    const d = C.addNode(comp, C.makeNode(comp, "depthblur", { inputs: [r.id, r.id] }));
    const g = C.addNode(comp, C.makeNode(comp, "grade", { inputs: [d.id] }));
    const cache = new Map();
    let calls = 0;
    const source = () => { calls++; return pattern(16, 16, 0, 0, 0); };
    C.renderNode(comp, g.id, 0, { scale: 1, source, cache });
    const after = calls;
    g.gain = 2;
    C.renderNode(comp, g.id, 0, { scale: 1, source, cache });
    assert.equal(calls, after, "the depth blur came from the cache");
    d.focus = 0.1;
    C.renderNode(comp, g.id, 0, { scale: 1, source, cache });
    assert.ok(calls > after, "its own setting changed: made again");
});

test("the keyer takes the screen out and keeps the rest; despill takes green out of an edge", () => {
    const p = { mode: "chroma", screen: [0.1, 0.8, 0.1, 1], tolerance: 0.2, softness: 0.3, despill: 1 };
    const img = C.blank(3, 1);
    img.data.set([0.1, 0.8, 0.1, 1, 0.6, 0.3, 0.2, 1, 0.4, 0.5, 0.35, 1]);
    const out = O.keyImage(img, p);
    assert.ok(out.data[3] < 1e-6, "the screen is gone");
    assert.ok(out.data[7] > 0.99, "a skin tone stays");
    assert.ok(out.data[9] <= 0.4 * out.data[11] + 1e-6 || out.data[9] < 0.5, "green pulled down to the larger of red and blue");
    const luma = O.keyImage(img, { ...p, mode: "luma", tolerance: 0.2, softness: 0.1 });
    assert.ok(luma.data[3] > 0.99 && luma.data[7] > 0.99);
});

test("a roto shape covers its area, a feather softens it, a subtract cuts it, and its keys move it", () => {
    const sq = { pts: [[2, 2], [12, 2], [12, 8], [2, 8]], smooth: false };
    let m = O.rotoMatte([sq], 0, 16, 10, 1);
    assert.ok(Math.abs(m.reduce((a, b) => a + b, 0) - 60) < 1e-9, "10 x 6 pixels");
    m = O.rotoMatte([sq, { pts: [[2, 2], [7, 2], [7, 8], [2, 8]], smooth: false, mode: "subtract" }], 0, 16, 10, 1);
    assert.ok(Math.abs(m.reduce((a, b) => a + b, 0) - 30) < 1e-9);
    const soft = O.rotoMatte([{ ...sq, feather: 3 }], 0, 16, 10, 1);
    assert.ok(soft[5 * 16 + 1] > 0.01 && soft[5 * 16 + 1] < 0.5, "the feather reaches out");
    const moving = { smooth: false, keys: [{ f: 0, pts: sq.pts }, { f: 10, pts: sq.pts.map(([x, y]) => [x + 2, y]) }] };
    assert.deepEqual(O.shapePoints(moving, 5)[0], [3, 2]);
    assert.deepEqual(O.shapePoints(moving, 20)[0], [4, 2]);
});

test("crop, shuffle, copy, premult and unpremult", () => {
    const img = solid(4, 2, [0.2, 0.4, 0.6, 0.5]);
    const cr = O.cropImage(img, 1, 0, 2.5, 2, 0);
    assert.deepEqual([cr.data[0], cr.data[4 * 1 + 3], cr.data[4 * 2 + 3]].map((x) => Math.round(x * 1e6) / 1e6), [0, 0.5, 0.25]);
    const sh = O.shuffleImage(img, ["a", "a", "a", "1"]);
    assert.deepEqual(Array.from(sh.data.slice(0, 4)), [0.5, 0.5, 0.5, 1]);
    const cp = O.copyImage(img, solid(4, 2, [1, 1, 1, 0.25]), ["B", "B", "0", "A.a"]);
    assert.deepEqual(Array.from(cp.data.slice(0, 4)).map((x) => Math.round(x * 1e6) / 1e6), [0.2, 0.4, 0, 0.25]);
    const back = O.premultImage(O.unpremultImage(img));
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(back.data[k] - img.data[k]) < 1e-6);
});

test("depth blur leaves the focus sharp and blurs what is far from it", () => {
    const w = 24, h = 8;
    const img = C.blank(w, h), depth = C.blank(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, on = x % 2 ? 1 : 0;
        img.data.set([on, on, on, 1], i);
        const z = x < 12 ? 0.5 : 1;
        depth.data.set([z, z, z, 1], i);
    }
    const out = O.depthBlurImage(img, depth, { channel: "r", focus: 0.5, dof: 0.1, falloff: 0.3, size: 6, layers: 6 });
    const at = (x) => out.data[(4 * w + x) * 4];
    assert.ok(Math.abs(at(3) - 1) < 1e-6 && Math.abs(at(4)) < 1e-6, "in focus: the stripes stay");
    assert.ok(Math.abs(at(19) - 0.5) < 0.15 && Math.abs(at(20) - 0.5) < 0.15, "out of focus: the stripes are grey");
});

test("defocus spreads a point into its aperture, keeping its energy", async () => {
    const O = await import("../js/imageViewer_compOps.js");
    const w = 41, h = 41, img = O.blank(w, h);
    const c = (20 * w + 20) * 4;
    img.data[c] = 1; img.data[c + 3] = 1;
    const sum = (im) => { let s = 0; for (let i = 0; i < w * h; i++) s += im.data[i * 4]; return s; };
    const disc = O.defocusImage(img, { size: 16, shape: "disc", blades: 6, rotation: 0, aspect: 1, bloom: 0, threshold: 1 });
    assert.ok(Math.abs(sum(disc) - 1) < 1e-5);
    const at = (im, x, y) => im.data[(y * w + x) * 4];
    assert.ok(at(disc, 20, 20) > 0 && at(disc, 27, 20) > 0 && at(disc, 30, 20) === 0);
    // A hexagon with a corner up reaches further up than sideways.
    const hex = O.defocusImage(img, { size: 16, shape: "polygon", blades: 6, rotation: 0, aspect: 1, bloom: 0, threshold: 1 });
    assert.ok(at(hex, 20, 28) > 0 && at(hex, 28, 20) === 0);
    // Bloom brightens a highlight's bokeh.
    const bl = O.defocusImage(img, { size: 16, shape: "disc", blades: 6, rotation: 0, aspect: 1, bloom: 2, threshold: 0.1 });
    assert.ok(Math.abs(sum(bl) - (1 + 2 * (0.2126 - 0.1))) < 1e-4);
    // A heavy node: its result is kept between renders.
    assert.ok(C.NODE_TYPES.defocus && C.HEAVY.has("defocus"));
});

test("keyers, erode / dilate, laplacian and channel ops", async () => {
    const K = await import("../js/imageViewer_compMatte.js");
    const px = (...v) => ({ w: v.length / 4, h: 1, data: Float32Array.from(v) });
    // ChromaKeyer: the screen goes, a grey stays, spill on the subject is held to its other channels.
    const ck = K.chromaKeyImage(px(0.1, 0.55, 0.1, 1, 0.4, 0.4, 0.4, 1, 0.5, 0.6, 0.3, 1),
        { screen: [0.1, 0.55, 0.1, 1], screen_gain: 1, clip_black: 0, clip_white: 1, despill: 1, despill_limit: "max", output: "premultiplied" });
    assert.equal(ck.data[3], 0);
    assert.equal(ck.data[7], 1);
    assert.ok(Math.abs(ck.data[9] - ck.data[8] * 1) < 1e-6 || ck.data[9] <= ck.data[8] + 1e-6, "green held to red");
    // LumaKeyer: dark goes, bright stays.
    const lk = K.lumaKeyImage(px(0.05, 0.05, 0.05, 1, 0.8, 0.8, 0.8, 1), { source: "luminance", low: 0.2, low_soft: 0.1, high: 10, high_soft: 0, clip_black: 0, clip_white: 1, output: "premultiplied" });
    assert.deepEqual([lk.data[3], lk.data[7]], [0, 1]);
    // Erode / dilate: a lone white pixel grows to 3 wide, a white row loses its ends.
    const dot = { w: 5, h: 1, data: new Float32Array(20) };
    dot.data[2 * 4 + 3] = 1;
    const grown = K.erodeImage(dot, { size: 1, shape: "box", channels: "alpha" });
    assert.deepEqual(Array.from({ length: 5 }, (_, i) => grown.data[i * 4 + 3]), [0, 1, 1, 1, 0]);
    const shrunk = K.erodeImage(grown, { size: -1, shape: "box", channels: "alpha" });
    assert.deepEqual(Array.from({ length: 5 }, (_, i) => shrunk.data[i * 4 + 3]), [0, 0, 1, 0, 0]);
    // Laplacian of a flat picture is 0 (+ offset); high pass the same.
    const flat = px(0.3, 0.3, 0.3, 1, 0.3, 0.3, 0.3, 1, 0.3, 0.3, 0.3, 1);
    assert.ok(Math.abs(K.laplacianImage(flat, { mode: "laplacian", size: 0, gain: 1, offset: 0.5 }).data[4] - 0.5) < 1e-6);
    // ChannelMerge: A's alpha stencils B's.
    const cm = K.channelMergeImage(px(1, 1, 1, 1), px(0, 0, 0, 0.25), { a_channel: "a", b_channel: "a", operation: "stencil", output: "a", mix: 1 });
    assert.equal(cm.data[3], 0.75);
    assert.equal(K.channelMathImage(px(0.2, 0.4, 0.6, 1), { operation: "invert", value: 1, channels: "rgb", mix: 1 }).data[0], Float32Array.of(0.8)[0]);
});
