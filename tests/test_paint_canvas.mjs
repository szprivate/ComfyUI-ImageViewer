// Paint's Generate workflows and ComfyUI: the plain helpers of js/imageViewer_paintCanvas.js.
//     node --test tests/test_paint_canvas.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as WC from "../js/imageViewer_paintCanvas.js";

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

