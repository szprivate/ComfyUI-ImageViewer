// Paint's Generate workflows on ComfyUI's canvas: the plain helpers of js/imageViewer_paintCanvas.js.
//     node --test tests/test_paint_canvas.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as WC from "../js/imageViewer_paintCanvas.js";

test("a saved workflow becomes what the canvas' paste takes", () => {
    const ui = { nodes: [{ id: 1, type: "LoadImage" }], links: [[7, 1, 0, 2, 0, "IMAGE"]], definitions: { subgraphs: [{ id: "s" }] } };
    const c = WC.toClipboard(ui);
    assert.deepEqual(c.links, [{ id: 7, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "IMAGE" }]);
    assert.deepEqual(c.subgraphs, [{ id: "s" }]);
    c.nodes[0].type = "x";
    assert.equal(ui.nodes[0].type, "LoadImage");           // a copy
});

test("only one workflow's nodes are taken out of the canvas' prompt, with what is wired into them", () => {
    const out = {
        "5": { class_type: "LoadImage", inputs: { image: "a.png" } },
        "6:1": { class_type: "Inner", inputs: { image: ["5", 0], extra: ["20", 0] } },
        "7": { class_type: "SaveImage", inputs: { images: ["6:1", 0] } },
        "20": { class_type: "UserNode", inputs: {} },
        "30": { class_type: "SomethingElse", inputs: {} },
    };
    assert.deepEqual(Object.keys(WC.promptOf(out, [5, 6, 7])).sort(), ["20", "5", "6:1", "7"]);
});

test("a new group goes to the right of what is there", () => {
    assert.deepEqual(WC.freeSpot([]), [0, 0]);
    assert.deepEqual(WC.freeSpot([{ pos: [0, 50], size: [100, 10] }, { pos: [300, 10], size: [200, 10] }]), [620, 10]);
});

test("plain inputs, a dynamic combo before what hangs on it", () => {
    assert.deepEqual(WC.plainInputs({ "model.scale_factor": 2, image: ["1", 0], model: "crystal" }).map((x) => x[0]), ["model", "model.scale_factor"]);
});

test("refs by id or by title", () => {
    const g = { "3": { _meta: { title: "paint:tune" } }, "4": {} };
    assert.equal(WC.refIn(g, "4"), "4");
    assert.equal(WC.refIn(g, "Paint:Tune"), "3");
    assert.equal(WC.refIn(g, "paint:box"), null);
    const ui = { nodes: [{ id: 2, type: "LoadImage" }], definitions: { subgraphs: [{ nodes: [{ id: 75, type: "SAM3_Detect", title: "paint:tune" }] }] } };
    assert.equal(WC.uiClassOf(ui, "paint:tune"), "SAM3_Detect");
    assert.equal(WC.uiClassOf(ui, 2), "LoadImage");
});

test("a node's settings for a dialog: no seeds, no sockets, no links, a dynamic combo's own", () => {
    const info = { input: {
        required: {
            image: ["IMAGE"],
            model: ["COMFY_DYNAMICCOMBO_V3", { options: [
                { key: "crystal", inputs: { required: { scale_factor: ["FLOAT", { default: 2, min: 1, max: 4 }], creativity: ["INT", { default: 0, min: 0, max: 10 }] } } },
                { key: "other", inputs: { required: { k: ["INT", {}] } } }] }],
            seed: ["INT", { default: 0 }],
            mode: [["fast", "best"], { default: "best" }],
            prompt: ["STRING", { multiline: true }],
        },
        optional: { refine: ["BOOLEAN", { default: true }], linked: ["FLOAT", {}] },
    } };
    const s = WC.tuneSettings(info, { "model.creativity": 3, linked: ["9", 0] }, ["model.scale_factor"]);
    assert.deepEqual(s.map((x) => x.name), ["model", "model.creativity", "mode", "refine"]);
    assert.equal(s.find((x) => x.name === "model.creativity").value, 3);
    assert.equal(s.find((x) => x.name === "mode").value, "best");
    const f = WC.dialogFields(s, "t:a:");
    assert.deepEqual(f.find((x) => x[0] === "t:a:refine"), ["t:a:refine", "refine", "yes", ["yes", "no"]]);
    assert.deepEqual(f.find((x) => x[0] === "t:a:model.creativity"), ["t:a:model.creativity", "creativity", 3, 0, 10]);
    const v = WC.readFields(s, { "t:a:model": "crystal", "t:a:model.creativity": "4.6", "t:a:mode": "fast", "t:a:refine": "no" }, "t:a:");
    assert.deepEqual(v, { model: "crystal", "model.creativity": 5, mode: "fast", refine: false });
});

test("setting a widget calls its callback (a dynamic combo grows its inputs)", () => {
    let told = null;
    const n = { widgets: [{ name: "model", value: "a", callback: (v) => { told = v; } }] };
    assert.equal(WC.setWidget(n, "model", "b"), true);
    assert.equal(told, "b");
    assert.equal(WC.setWidget(n, "nope", 1), false);
});
