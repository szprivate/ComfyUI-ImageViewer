// node --test tests/test_edit_speed_ramp.mjs
// Speed ramps: a clip's speed keyed ("spd"), its source the integral of that speed (imageViewer_editTimelineData.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const near = (a, b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const V = (i) => ({ kind: "clip", i });
const ramped = (keys, extra = {}) => shot("a.mp4", 4, { in: 1, fx: { keys: { spd: keys } }, ...extra });

test("the source is the integral of the speed: linear, held before the first key and after the last", () => {
    const c = ramped([{ t: 1, v: 1 }, { t: 3, v: 3 }]);
    assert.equal(D.rampOf(c).length, 2);
    near(D.srcLocal(c, 0.5), 1.5);                 // 1 x 0.5 before the first key
    near(D.srcLocal(c, 2), 1 + 1 + 1.5);           // + the trapezoid from 1 to 2: (1 + 2) / 2
    near(D.srcLocal(c, 3), 1 + 1 + 4);             // + (1 + 3) / 2 x 2
    near(D.srcLocal(c, 4), 1 + 1 + 4 + 3);         // + 3 x 1 after the last
    near(D.srcUse(c), 8);
    assert.deepEqual(D.srcSpan(c), { lo: 1, hi: 9 });
    assert.equal(D.clipSegment(c, 2).rev, true, "the player steps it");
});

test("eases and holds integrate as the keys draw them", () => {
    const steps = 20000;
    for (const i of ["in", "out", "inout", "hold"]) {
        const keys = [{ t: 0, v: 0.5, i }, { t: 2, v: 2.5 }];
        let sum = 0;
        for (let k = 0; k < steps; k++) sum += D.keyValue(keys, (k + 0.5) / steps * 2) * 2 / steps;
        near(D.rampAdvance(keys, 2), sum, 1e-3);
    }
});

test("the Speed row's diamond starts a ramp at the clip's speed, and autoKey sets a key", () => {
    let cut = cutOf([shot("a.mp4", 4, { speed: 2 })]);
    cut = D.toggleKeys(cut, V(0), ["spd"], 0);
    near(D.keysOf(cut.clips[0], "spd")[0].v, 2);
    near(D.srcUse(cut.clips[0]), 8);          // one key at its speed: the same source
    cut = D.autoKey(cut, V(0), { spd: 0.5 }, 3);
    assert.equal(D.keysOf(cut.clips[0], "spd").length, 2);
    near(cut.clips[0].length, 4);             // the length stays
    near(D.srcUse(cut.clips[0]), 2 * 3 - 1.5 * 3 / 2 + 0.5);
    // unkeyed, autoKey's speed is a plain retime
    const plain = D.autoKey(cutOf([shot("a.mp4", 4)]), V(0), { spd: 2 }, 0);
    near(plain.clips[0].length, 2);
});

test("a split goes on where the first piece stopped; its second piece has the ramp from there", () => {
    const cut = cutOf([ramped([{ t: 1, v: 1 }, { t: 3, v: 3 }])]);
    const s = D.splitClip(cut, V(0), 2).cut;
    near(s.clips[1].in, D.srcLocal(cut.clips[0], 2));
    near(D.srcLocal(s.clips[1], 1.5), D.srcLocal(cut.clips[0], 3.5));
});

test("a head trim keeps what the rest of the clip shows", () => {
    const cut = cutOf([ramped([{ t: 1, v: 1 }, { t: 3, v: 3 }]), shot("b.mp4", 2)]);
    const t = D.trimStart(cut, 0, 1.5).clips[0];
    near(t.length, 2.5);
    near(D.srcLocal(t, 0), D.srcLocal(cut.clips[0], 1.5));
    near(D.srcLocal(t, 2), D.srcLocal(cut.clips[0], 3.5));
});

test("a ramped clip is not retimed, does not loop, is silent, and Ask agentY says so", () => {
    const cut = cutOf([ramped([{ t: 1, v: 1 }, { t: 3, v: 3 }]), shot("b.mp4", 2)]);
    assert.equal(D.sameCut(D.retimeClip(cut, V(0), 8), cut), true);
    assert.equal(D.sameCut(D.setSpeed(cut, V(0), 2), cut), true);
    assert.equal(D.loopOf({ ...cut.clips[0], loop: "loop", span: 1 }), "");
    assert.equal(D.xfadeFrom(cutOf([shot("b.mp4", 2), cut.clips[0]]), V(1)), null);
    assert.ok(D.agentLoses(cut).some((x) => /ramp/.test(x)));
    // a freeze wins over the ramp, and the ramp is back when it is taken off
    const f = D.setMotion(cut, V(0), "freeze");
    assert.equal(D.rampOf(f.clips[0]).length, 0);
    assert.equal(D.rampOf(D.setMotion(f, V(0), "").clips[0]).length, 2);
});

test("a clip marker rides on a ramp", () => {
    const c = ramped([{ t: 1, v: 1 }, { t: 3, v: 3 }]);
    const src = D.clipMarkSrc(c, 2.5);
    near(D.clipMarkU(c, { src, len: 0 }), 2.5, 1e-3);
});
