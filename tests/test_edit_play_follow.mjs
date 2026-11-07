// node --test tests/test_edit_play_follow.mjs
// How the Edit tab's player keeps a <video> or <audio> beside the film's clock (imageViewer_editPlay.js):
// nudged for a little drift, sought only when far off, left alone while a seek settles.
import test from "node:test";
import assert from "node:assert/strict";
import { FOLLOW, followRate, followPlan } from "../js/imageViewer_editPlay.js";

test("within FOLLOW.ok the rate is the rate", () => {
    assert.equal(followRate(1, 0), 1);
    assert.equal(followRate(1, FOLLOW.ok * 0.9), 1);
    assert.equal(followRate(1.5, -FOLLOW.ok * 0.9), 1.5);
});

test("behind runs faster, ahead slower, at most FOLLOW.nudge, in FOLLOW.step steps", () => {
    const behind = followRate(1, -0.1), ahead = followRate(1, 0.1);
    assert.ok(behind > 1 && ahead < 1);
    assert.ok(Math.abs(followRate(1, -10) - (1 + FOLLOW.nudge)) < 1e-9);
    assert.ok(Math.abs(followRate(1, 10) - (1 - FOLLOW.nudge)) < 1e-9);
    for (const d of [-0.2, -0.07, 0.04, 0.13]) {
        const k = (followRate(1, d) - 1) / FOLLOW.step;
        assert.ok(Math.abs(k - Math.round(k)) < 1e-9, `a whole step: ${d}`);
    }
    // Relative to the rate it is nudged from (a retimed clip, the fps field).
    assert.ok(Math.abs(followRate(2, -10) - 2 * (1 + FOLLOW.nudge)) < 1e-9);
});

test("a little drift is never a seek - only past FOLLOW.seek", () => {
    for (const d of [0.05, 0.1, 0.2, -0.2]) assert.equal(followPlan(5 + d, 5, 1, Infinity).seek, undefined, `drift ${d}`);
    assert.equal(followPlan(5.3, 5, 1, Infinity).seek, true);
    assert.equal(followPlan(4.6, 5, 1, Infinity).seek, true);
    // A clip retimed to 2x covers twice the source per second: its seek lies twice as far.
    assert.equal(followPlan(5.4, 5, 2, Infinity, 2).seek, undefined);
    assert.equal(followPlan(5.6, 5, 2, Infinity, 2).seek, true);
});

test("while a seek settles nothing is done", () => {
    assert.deepEqual(followPlan(9, 5, 1, FOLLOW.settle - 1), { rate: 1 });
    assert.deepEqual(followPlan(5.1, 5, 1, 0), { rate: 1 });
    assert.equal(followPlan(9, 5, 1, FOLLOW.settle).seek, true);
});
