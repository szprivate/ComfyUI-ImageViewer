// Paint's built-in brush tips (js/imageViewer_paintTipSet.js): drawn from numbers, the same every time.
//   node --test tests/test_paint_tipset.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_TIPS, builtinTips, makeBuiltinTip } from "../js/imageViewer_paintTipSet.js";

test("every built-in tip is a grey tip with ink in it, not filling its square", () => {
    const tips = builtinTips();
    assert.equal(tips.length, BUILTIN_TIPS.length);
    assert.ok(tips.length >= 12);
    assert.equal(new Set(tips.map((t) => t.id)).size, tips.length);
    for (const t of tips) {
        assert.ok(t.id.startsWith("builtin:") && t.builtin, t.id);
        assert.equal(t.a.length, t.w * t.h);
        let ink = 0, max = 0;
        for (const v of t.a) { ink += v; max = Math.max(max, v); }
        const mean = ink / t.a.length;
        assert.ok(max >= 200, `${t.id} has strong ink`);
        assert.ok(mean > 5 && mean < 200, `${t.id}: mean ${mean}`);
        assert.ok(t.spacing >= 1 && t.spacing <= 200, t.id);
    }
});

test("a built-in tip is the same every time it is drawn", () => {
    for (const [k] of BUILTIN_TIPS) assert.deepEqual(makeBuiltinTip(k).a, makeBuiltinTip(k).a, k);
    assert.equal(makeBuiltinTip("nope"), null);
});

test("the whole set is drawn quickly enough for Paint's start", () => {
    const t0 = performance.now();
    builtinTips();
    assert.ok(performance.now() - t0 < 1000);
});
