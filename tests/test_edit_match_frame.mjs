// node --test tests/test_edit_match_frame.mjs
// Match frame: the source moment of what the cut shows (imageViewer_editTimelineData.js matchFrame).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("on V1: the shot under the playhead, at its source moment", () => {
    const cut = cutOf([shot("a.mp4", 2, { in: 1 }), shot("b.mp4", 3, { in: 5 })]);
    const a = D.matchFrame(cut, 0.5);
    assert.equal(a.file, "a.mp4");
    near(a.src, 1.5);
    assert.deepEqual(a.sel, { kind: "clip", i: 0 });
    const b = D.matchFrame(cut, 3);
    assert.equal(b.file, "b.mp4");
    near(b.src, 6);
});

test("speed, reverse, freeze and a ramp are counted", () => {
    near(D.matchFrame(cutOf([shot("a.mp4", 2, { in: 1, speed: 2 })]), 0.5).src, 2);
    near(D.matchFrame(cutOf([shot("a.mp4", 2, { in: 3, motion: "reverse" })]), 0.5).src, 2.5);
    near(D.matchFrame(cutOf([shot("a.mp4", 2, { in: 1.25, motion: "freeze" })]), 1.7).src, 1.25);
    const ramp = shot("a.mp4", 4, { in: 1, fx: { keys: { spd: [{ t: 1, v: 1 }, { t: 3, v: 3 }] } } });
    near(D.matchFrame(cutOf([ramp]), 2).src, D.srcLocal(ramp, 2));
});

test("the picture on top wins, and the selected clip wins when the playhead is in it", () => {
    const cut = cutOf([shot("a.mp4", 4)], { tracks: [{ id: "V2", kind: "video", name: "V2", off: false,
        clips: [{ ...shot("over.mp4", 1, { in: 2 }), at: 1 }] }, { id: "A2", kind: "audio", name: "A2", off: false,
        clips: [{ ...shot("s.wav", 2, { in: 0.5 }), at: 1 }] }] });
    const top = D.matchFrame(cut, 1.5);
    assert.equal(top.file, "over.mp4");
    near(top.src, 2.5);
    assert.equal(D.matchFrame(cut, 1.5, { kind: "clip", i: 0 }).file, "a.mp4");
    const snd = D.matchFrame(cut, 1.5, { kind: "tclip", track: "A2", i: 0 });
    assert.equal(snd.file, "s.wav");
    near(snd.src, 1);
    // a selected clip the playhead is not in: what is on screen
    assert.equal(D.matchFrame(cut, 3, { kind: "tclip", track: "V2", i: 0 }).file, "a.mp4");
    // V2 off (not live): V1
    assert.equal(D.matchFrame(cut, 1.5, null, new Set(["V1"])).file, "a.mp4");
});

test("a still is matched at 0, a gap or a title is nothing", () => {
    const st = D.matchFrame(cutOf([shot("p.png", 2)]), 1);
    assert.equal(st.still, true);
    assert.equal(st.src, 0);
    assert.equal(D.matchFrame(cutOf([shot("a.mp4", 1), shot("b.mp4", 1, { gap: 1 })]), 1.5), null);
    const t = cutOf([shot("a.mp4", 1)], { tracks: [{ id: "V2", kind: "video", name: "V2", off: false,
        clips: [{ title: { text: "x" }, name: "x", at: 0, length: 1 }] }] });
    assert.equal(D.matchFrame(t, 0.5, { kind: "tclip", track: "V2", i: 0 }).file, "a.mp4");
    assert.equal(D.matchFrame(null, 0), null);
});
