// Paint's dialogs: the step of the slider put beside a number with a range.
// Run: node --test tests/test_paint_dialog.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { dialogStep } from "../js/imageViewer_paintEditor.js";

test("a wide range steps by whole numbers, a narrow one in about a thousand nice steps", () => {
    assert.equal(dialogStep(-100, 100), 1);
    assert.equal(dialogStep(0.1, 250), 1);
    assert.equal(dialogStep(0, 10), 0.01);
    assert.equal(dialogStep(0, 1), 0.001);
    assert.equal(dialogStep(0.1, 3), 0.005);
});
