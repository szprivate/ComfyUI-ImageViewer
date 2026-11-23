// node --test tests/test_comp_ai_workflow.mjs
// A ComfyUI workflow of the user's own in a Comp AI node, as the page's comp model reads it (imageViewer_compExtra.js
// customOf ... aiLayerReads, compModel's inputsOf / paramAt / formatAt / aiKey / renderNode). The server's twin is
// tests/test_comp_ai_workflow.py.
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/imageViewer_compModel.js";

const custom = {
    graph: { 1: { class_type: "LoadImage", inputs: { image: "x" } }, 9: { class_type: "SaveImage", inputs: { images: ["1", 0] } } },
    name: "Mine", source: "canvas", sig: "abc",
    inputs: [{ name: "plate", node: "1", kind: "picture" }, { name: "mask", node: "2", kind: "mask" }],
    outputs: [{ name: "out", node: "9", kind: "picture" }, { name: "depth", node: "10", kind: "picture" }],
    params: [{ id: "wf_steps", name: "steps", node: "5", input: "steps", kind: "int", def: 20 },
        { id: "wf_prompt", name: "prompt", node: "4", input: "text", kind: "prompt", def: "a car" },
        { id: "wf_hires", name: "hires", node: "6", input: "on", kind: "bool", def: true }],
};

function comp() {
    const c = C.newComp({ width: 8, height: 4, fps: 24, frames: 4 });
    const r = C.makeNode(c, "read", { file: "plate.png" }); C.addNode(c, r);
    const a = C.makeNode(c, "ai_workflow"); C.addNode(c, a);
    return { c, r, a };
}

test("an AI Workflow node has one src until it takes a workflow, then the workflow's inputs", () => {
    const { r, a } = comp();
    assert.deepEqual(C.inputsOf(a), ["src"]);
    a.inputs = [r.id];
    a.custom = custom;
    assert.deepEqual(C.inputsOf(a), ["plate", "mask"]);
    assert.ok(C.EX.usesCustom(a));
    // Another AI node keeps its own ports and runs its own workflow only when it picked it.
    const m = { type: "ai_matte", custom, inputs: [] };
    assert.deepEqual(C.inputsOf(m), ["src"]);
    assert.ok(!C.EX.usesCustom(m));
    m.workflow = "custom";
    assert.ok(C.EX.usesCustom(m));
});

test("a workflow's parameters are the node's: defaults, keys on numbers, and a key that sees them", () => {
    const { c, r, a } = comp();
    a.inputs = [r.id, null];
    a.custom = custom;
    assert.equal(C.paramAt(a, "wf_steps", 0), 20);
    assert.equal(C.paramAt(a, "wf_hires", 0), "on");
    assert.equal(C.EX.wfParamDef(a, "wf_prompt").kind, "prompt");
    assert.equal(C.EX.wfParamDef(a, "wf_steps").key, true);
    assert.equal(C.EX.wfParamDef(a, "wf_nope"), null);
    a.tracks = { wf_steps: [{ f: 0, v: 10 }, { f: 2, v: 30 }] };
    assert.equal(C.paramAt(a, "wf_steps", 1), 20);
    const k0 = C.aiKey(c, a);
    a.wf_prompt = "a truck";
    assert.notEqual(C.aiKey(c, a), k0);
    const k1 = C.aiKey(c, a);
    a.custom = { ...custom, sig: "other" };
    assert.notEqual(C.aiKey(c, a), k1);
});

test("its result has its own size, and its further outputs are layers of its picture", () => {
    const { c, r, a } = comp();
    a.inputs = [r.id, null];
    a.custom = custom;
    assert.deepEqual(C.formatAt(c, a.id), { width: 8, height: 4 });        // before it ran: what comes in
    a.results = { frames: { 0: "o.0000.png" }, layers: { depth: { 0: "d.0000.png" } }, width: 6, height: 2 };
    assert.deepEqual(C.formatAt(c, a.id), { width: 6, height: 2 });
    const solid = (w, h, v) => ({ w, h, data: new Float32Array(w * h * 4).fill(v) });
    const img = C.renderNode(c, a.id, 3, { scale: 1, source: (n) => (n.file === "o.0000.png" ? solid(6, 2, 0.25) : n.file === "d.0000.png" ? solid(6, 2, 0.75) : solid(8, 4, 1)) });
    assert.equal(img.w, 6);
    assert.equal(img.h, 2);
    assert.ok(Math.abs(img.data[0] - 0.25) < 1e-6);
    assert.ok(img.ch["depth.r"] && Math.abs(img.ch["depth.r"][0] - 0.75) < 1e-6);
    const reads = C.EX.aiLayerReads(a, 2);
    assert.equal(reads.length, 1);
    assert.equal(reads[0][1].file, "d.0000.png");
});

test("the page reads every picture an output answered, and knows the canvas's format", () => {
    assert.deepEqual(C.EX.outputRefs({ images: [{ filename: "a.png" }], gifs: [{ filename: "b.mp4", subfolder: "s", type: "temp" }] }),
        [{ filename: "a.png", subfolder: "", type: "output" }, { filename: "b.mp4", subfolder: "s", type: "temp" }]);
    assert.ok(C.EX.isCanvasFormat({ nodes: [], links: [] }));
    assert.ok(!C.EX.isCanvasFormat({ 1: { class_type: "X", inputs: {} } }));
});
