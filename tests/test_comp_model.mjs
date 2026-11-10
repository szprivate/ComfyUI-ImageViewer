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
