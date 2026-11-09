// node --test tests/test_edit_transitions.mjs
// Video transitions beyond the cross dissolve (imageViewer_editTimelineData.js "video transitions").
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips) => ({ ...D.emptyCut("t"), clips });

test("a dissolve's look: set, saved, compared, gone with the dissolve", () => {
    const cut = D.setTransition(cutOf([shot("a.mp4", 4), shot("b.mp4", 4)]), 1, 1);
    const dip = D.setTransitionLook(cut, 1, { type: "dip", color: "#FFFFFF" });
    assert.deepEqual(dip.clips[1].tfx, { type: "dip", color: "#ffffff" });
    assert.equal(D.sameCut(dip, cut), false, "a change of look is an edit (undo, unsaved)");
    assert.deepEqual(D.toSave(dip).clips.map((c) => c.tfx), [null, { type: "dip", color: "#ffffff" }]);
    assert.equal(D.setTransitionLook(dip, 1, null).clips[1].tfx, undefined, "a cross dissolve again");
    assert.equal(D.setTransition(dip, 1, 0).clips[1].tfx, undefined, "no dissolve, no look");
    assert.equal(D.setTransitionLook(cut, 0, { type: "wipe" }).clips[0].tfx, undefined, "nothing leads into the first shot");
    assert.deepEqual(D.cleanTfx({ type: "wipe", dir: "x" }), { type: "wipe", dir: "right" });
    assert.equal(D.cleanTfx({ type: "dissolve" }), null);
});

test("transitionLook: the opacities of the two shots, the dip's colour, the wipe's share", () => {
    assert.deepEqual(D.transitionLook(null, 0.25), { inn: 0.25, out: 1 });
    assert.deepEqual(D.transitionLook({ type: "dip", color: "#000000" }, 0.25), { inn: 0, out: 0.5, color: "#000000" });
    assert.deepEqual(D.transitionLook({ type: "dip", color: "#000000" }, 0.75), { inn: 0.5, out: 0, color: "#000000" });
    assert.deepEqual(D.transitionLook({ type: "wipe", dir: "up" }, 0.4), { inn: 1, out: 1, wipe: { dir: "up", share: 0.4 } });
});

test("swapping two shots leaves the wipe at its join", () => {
    let cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4), shot("c.mp4", 4)]);
    cut = D.setTransitionLook(D.setTransition(cut, 1, 1), 1, { type: "wipe", dir: "left" });
    const got = D.swapClip(cut, { kind: "clip", i: 0 }, 1);
    assert.equal(got.cut.clips[1].name, "a.mp4");
    assert.deepEqual(got.cut.clips[1].tfx, { type: "wipe", dir: "left" });
    assert.equal(got.cut.clips[0].tfx, undefined);
});
