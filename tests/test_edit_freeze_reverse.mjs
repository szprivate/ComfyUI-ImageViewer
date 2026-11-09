// node --test tests/test_edit_freeze_reverse.mjs
// Freeze frame and reverse (imageViewer_editTimelineData.js: motionOf, stepOf, setMotion and the trims that follow them).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const V = (i) => ({ kind: "clip", i });

test("reverse plays the same stretch backwards: in becomes the moment at the head", () => {
    const cut = cutOf([shot("a.mp4", 2, { in: 1 })]);
    const r = D.setMotion(cut, V(0), "reverse");
    const c = r.clips[0];
    assert.equal(D.motionOf(c), "reverse");
    near(c.in, 3);
    near(c.length, 2);
    near(D.srcLocal(c, 0), 3);
    near(D.srcLocal(c, 0.5), 2.5);
    assert.deepEqual(D.srcSpan(c), { lo: 1, hi: 3 });
    assert.equal(D.stepOf(c), -1);
    assert.equal(D.clipSegment(c, 1).rev, true, "the player steps it frame by frame");
    // and forwards again: the same stretch
    const f = D.setMotion(r, V(0), "");
    assert.equal(D.motionOf(f.clips[0]), "");
    near(f.clips[0].in, 1);
    assert.equal(D.sameCut(f, cut), true);
    assert.equal(D.sameCut(r, cut), false);
});

test("reverse at a speed: the source runs back at that speed", () => {
    const c = D.setMotion(cutOf([shot("a.mp4", 2, { in: 0, speed: 2 })]), V(0), "reverse").clips[0];
    near(c.in, 4);
    near(D.srcLocal(c, 1), 2);
    near(D.stepOf(c), -2);
});

test("freeze holds the moment under u for the whole clip; speed and loop go", () => {
    const cut = cutOf([shot("a.mp4", 2, { in: 1, speed: 2 })]);
    const c = D.setMotion(cut, V(0), "freeze", 0.5).clips[0];
    assert.equal(D.motionOf(c), "freeze");
    near(c.in, 2);
    assert.equal(c.speed, undefined);
    near(D.srcLocal(c, 0), 2);
    near(D.srcLocal(c, 1.9), 2);
    assert.equal(D.stepOf(c), 0);
    assert.equal(D.outRoom(c, { "a.mp4": 3 }), Infinity, "a freeze grows as far as it is pulled");
    const looped = cutOf([shot("a.mp4", 4, { in: 0, loop: "loop", span: 1 })]);
    const fl = D.setMotion(looped, V(0), "freeze", 1.5).clips[0];
    assert.equal(fl.loop, undefined);
    near(fl.in, 0.5);
});

test("a still and a title have no motion", () => {
    const cut = cutOf([shot("a.png", 2)]);
    assert.equal(D.setMotion(cut, V(0), "reverse").clips[0].motion, undefined);
    assert.equal(D.motionOf({ title: { text: "x" }, motion: "freeze" }), "");
});

test("trims of a reversed clip: the head moves the source, the tail does not", () => {
    const cut = D.setMotion(cutOf([shot("a.mp4", 2, { in: 1 }), shot("b.mp4", 2)]), V(0), "reverse");
    const t = D.trimStart(cut, 0, 0.5).clips[0];        // the head 0.5 s later: an earlier moment
    near(t.in, 2.5);
    near(t.length, 1.5);
    near(D.srcLocal(t, 0), 2.5);
    const e = D.trimEnd(cut, 0, 2.5).clips[0];          // the tail later: still from 3 back
    near(e.in, 3);
    near(e.length, 2.5);
    near(D.outRoom(cut.clips[0]), 1, "back to the source's start: 3 s less the 2 it shows");
    near(D.inRoom(cut.clips[0], { "a.mp4": 5 }), 2, "towards the source's end, when it is known");
    assert.equal(D.inRoom(cut.clips[0]), Infinity);
});

test("a split of a reversed clip goes on backwards where the first piece stopped", () => {
    const cut = D.setMotion(cutOf([shot("a.mp4", 2, { in: 1 })]), V(0), "reverse");
    const s = D.splitClip(cut, V(0), 0.5).cut;
    assert.equal(s.clips.length, 2);
    near(s.clips[1].in, 2.5);
    assert.equal(s.clips[1].motion, "reverse");
    near(D.srcLocal(s.clips[1], 0), D.srcLocal(cut.clips[0], 0.5));
});

test("slip of a reversed clip is held so it never runs before the source's start", () => {
    const cut = D.setMotion(cutOf([shot("a.mp4", 2, { in: 1 })]), V(0), "reverse");
    near(D.slipClip(cut, V(0), -5, { "a.mp4": 6 }).clips[0].in, 2);
    near(D.slipClip(cut, V(0), 5, { "a.mp4": 6 }).clips[0].in, 6);
});

test("a frozen or reversed clip does not loop, retime of a freeze is its length, and Ask agentY says what goes", () => {
    const cut = D.setMotion(cutOf([shot("a.mp4", 2, { in: 1 })]), V(0), "freeze");
    const l = D.loopExtend(cut, V(0), 5, "loop").clips[0];
    assert.equal(D.loopOf(l), "");
    near(l.length, 5);
    const r = D.retimeClip(cut, V(0), 4).clips[0];
    assert.equal(r.speed, undefined);
    near(r.length, 4);
    // a loop asked for plays forwards again
    const lp = D.setLoop(D.setMotion(cutOf([shot("a.mp4", 2, { in: 1 })]), V(0), "reverse"), V(0), "loop").clips[0];
    assert.equal(D.motionOf(lp), "");
    assert.equal(D.loopOf(lp), "loop");
    assert.ok(D.agentLoses(cut).some((s) => /freeze/.test(s)));
});

test("frozen and reversed clips are silent: no crossfade, scrubbing hears nothing", () => {
    const cut = D.setMotion(cutOf([shot("a.mp4", 2), shot("b.mp4", 2)]), V(1), "reverse");
    assert.equal(D.xfadeFrom(cut, V(1)), null);
});

test("toSave states the motion, so taking it off reaches the file", () => {
    const cut = cutOf([shot("a.mp4", 2, { ref: 0 })]);
    const saved = D.toSave(D.setMotion(cut, V(0), "freeze")).clips[0];
    assert.equal(saved.motion, "freeze");
    assert.equal(D.toSave(cut).clips[0].motion, "");
});
