// The History's VFX actions on a clip: the pure part (imageViewer_clipVfxData.js). Run: node --test tests/test_clip_vfx.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as V from "../js/imageViewer_clipVfxData.js";

test("films are clips, pictures and sequences are not", () => {
    assert.ok(V.isClip({ path: "D:/out/shot.MP4" }));
    assert.ok(V.isClip({ filename: "a.mov", type: "output" }));
    assert.ok(V.isClip({ filename: "a.webm?x=1" }));
    assert.ok(!V.isClip({ path: "D:/out/a.png" }));
    assert.ok(!V.isClip({ filename: "frame.0001.exr" }));
    assert.ok(!V.isClip(null));
});

test("the route gets a path, or ComfyUI's own reference", () => {
    assert.deepEqual(V.clipRef({ path: "D:/a.mp4", filename: "a.mp4" }), { path: "D:/a.mp4" });
    assert.deepEqual(V.clipRef({ filename: "a.mp4" }), { filename: "a.mp4", type: "output", subfolder: "" });
    assert.equal(V.clipRef({}), null);
    assert.equal(V.clipStem({ path: "D:\\out\\shot 01.v2.mp4" }), "shot 01.v2");
});

test("the result lies beside its source: the source's group, else one named after it", () => {
    assert.equal(V.resultGroup("Seq 010", { path: "a.mp4" }), "Seq 010");
    assert.equal(V.resultGroup("", { path: "D:/x/plate.mov" }), "VFX: plate");
    assert.equal(V.resultLabel({ path: "plate.mov" }, "Alpha matte"), "plate \u00b7 Alpha matte");
});

test("reframe sides are multiples of 64, presets are found", () => {
    assert.equal(V.snapSide(1080), 1088);
    assert.equal(V.snapSide(100), 256);
    assert.equal(V.snapSide(4000), 1920);
    const P = [{ label: "16:9", width: 1920, height: 1088 }];
    assert.equal(V.presetOf(P, 1920, 1088), "16:9");
    assert.equal(V.presetOf(P, 1920, 1024), "custom");
});

test("how far all runs are", () => {
    assert.equal(V.share([]), null);
    assert.equal(V.share([{ done: false, max: 0 }]), null);
    assert.equal(V.share([{ done: true }, { value: 2, max: 8 }]), 0.625);
});
