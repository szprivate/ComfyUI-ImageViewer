// The framing masks' arithmetic (js/imageViewer_frameMasks.js). Run: node --test tests/test_frame_masks.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseRatio, maskRect, maskOf, cleanState, FRAME_MASKS, DEFAULT_STATE } from "../js/imageViewer_frameMasks.js";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test("ratios are read as typed", () => {
    near(parseRatio("2.39"), 2.39, "plain");
    near(parseRatio("2.39:1"), 2.39, "with :1");
    near(parseRatio("21:9"), 21 / 9, "21:9");
    near(parseRatio("16x9"), 16 / 9, "16x9");
    near(parseRatio(" 4 / 5 "), 0.8, "4/5 with spaces");
    near(parseRatio("1,85"), 1.85, "a decimal comma");
    for (const bad of ["", "abc", "0", "0:1", "1:0", "-2", "100", "1:100", "2.39:"]) assert.equal(parseRatio(bad), null, bad);
});

test("a wider mask than the picture leaves bars top and bottom", () => {
    const r = maskRect(1920, 1080, 2.39);
    near(r.w, 1920, "full width");
    near(r.h, 1920 / 2.39, "height");
    near(r.y, (1080 - 1920 / 2.39) / 2, "centred");
    assert.equal(r.x, 0);
});

test("a narrower mask leaves bars left and right", () => {
    const r = maskRect(1920, 1080, 9 / 16);
    near(r.h, 1080, "full height");
    near(r.w, 1080 * 9 / 16, "width");
    near(r.x, (1920 - r.w) / 2, "centred");
    const same = maskRect(1600, 900, 16 / 9);
    near(same.w, 1600, "same shape w"); near(same.h, 900, "same shape h");
    assert.equal(maskRect(0, 10, 1), null);
});

test("the state: presets, custom ratios, opacity held", () => {
    assert.equal(maskOf({ ...DEFAULT_STATE, on: false }), null);
    assert.equal(maskOf({ ...DEFAULT_STATE, on: true, key: "2.33" }).label, "21:9");
    assert.deepEqual(maskOf({ on: true, key: "custom", custom: "3x2" }), { ratio: 1.5, label: "3:2" });
    assert.equal(maskOf({ on: true, key: "custom", custom: "2.2" }).label, "2.2:1");
    assert.equal(maskOf({ on: true, key: "custom", custom: "nope" }), null);
    const st = cleanState({ on: true, key: "bogus", opacity: 7, line: false });
    assert.equal(st.key, DEFAULT_STATE.key);
    assert.equal(st.opacity, 1);
    assert.equal(st.line, false);
    assert.equal(st.label, true);
    assert.deepEqual(cleanState("junk"), DEFAULT_STATE);
    for (const k of ["4:3", "16:9", "21:9", "9:16", "1:1", "4:5", "1.85:1", "2.39:1"]) assert.ok(FRAME_MASKS.some((m) => m.label === k), k);
});
