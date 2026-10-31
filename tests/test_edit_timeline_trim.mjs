// node --test tests/test_edit_timeline_trim.mjs
// Trimming like an editor (bEpicViewer_editTimelineData.js): roll, slip, slide, the source limits of a trim,
// stills, retime (speed), loop extend, and the in / out of the range played.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/bEpicViewer_editTimelineData.js";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const DUR = { "a.mp4": 6, "b.mp4": 5, "c.mp4": 4 };

// ── roll ──

test("a roll moves the cut and keeps the film's length", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4, { in: 1 }), shot("c.mp4", 3)]);
    const got = D.rollEdit(cut, 1, 0.5, DUR);
    near(D.mainLength(got), D.mainLength(cut));
    near(got.clips[0].length, 4.5);
    near(got.clips[1].in, 1.5);
    near(got.clips[1].length, 3.5);
    near(D.clipStarts(got)[2], D.clipStarts(cut)[2]);       // what follows does not move
    const back = D.rollEdit(cut, 1, -0.8, DUR);
    near(back.clips[0].length, 3.2);
    near(back.clips[1].in, 0.2);
    near(D.mainLength(back), D.mainLength(cut));
});

test("a roll is held by the sources: the outgoing file's end, the incoming file's start", () => {
    const cut = cutOf([shot("a.mp4", 5), shot("b.mp4", 3, { in: 0.5 })]);
    const later = D.rollEdit(cut, 1, 3, DUR);                // a has only 1 s more
    near(later.clips[0].length, 6);
    near(later.clips[1].in, 1.5);
    const earlier = D.rollEdit(cut, 1, -3, DUR);             // b has only 0.5 s before its in
    near(earlier.clips[1].in, 0);
    near(earlier.clips[0].length, 4.5);
    near(D.mainLength(earlier), 8);
    near(D.mainLength(later), 8);
});

test("a roll keeps room for the dissolves", () => {
    const cut = cutOf([shot("a.mp4", 3), shot("b.mp4", 3, { transition: 1 }), shot("c.mp4", 3)]);
    const got = D.rollEdit(cut, 2, -10, DUR);
    assert.ok(got.clips[1].length >= 1 + 0.05 - 1e-6);
    near(got.clips[1].transition, 1);
    near(D.mainLength(got), D.mainLength(cut));
});

// ── slip ──

test("a slip moves in and out together and stops at the source's ends", () => {
    const cut = cutOf([shot("a.mp4", 2, { in: 1 }), shot("b.mp4", 3)]);
    const s = D.slipClip(cut, { kind: "clip", i: 0 }, 1.5, DUR);
    near(s.clips[0].in, 2.5);
    near(s.clips[0].length, 2);
    near(D.mainLength(s), D.mainLength(cut));
    near(D.slipClip(cut, { kind: "clip", i: 0 }, 10, DUR).clips[0].in, 4);      // 6 s file, 2 s used
    near(D.slipClip(cut, { kind: "clip", i: 0 }, -10, DUR).clips[0].in, 0);
    near(D.slipClip(cut, { kind: "clip", i: 0 }, 10).clips[0].in, 11);          // length not known: not held at the end
});

test("a still has nothing to slip; a placed clip slips in place", () => {
    const cut = cutOf([shot("p.png", 3)], { tracks: [{ id: "V2", kind: "video", name: "V2", off: false,
        clips: [{ file: "b.mp4", name: "b", in: 1, length: 2, at: 4, color: "", volume: 1 }] }] });
    assert.ok(D.sameCut(D.slipClip(cut, { kind: "clip", i: 0 }, 1, DUR), cut));
    const got = D.slipClip(cut, { kind: "tclip", track: "V2", i: 0 }, 0.5, DUR);
    const c = got.tracks[0].clips[0];
    assert.deepEqual([c.at, c.in, c.length], [4, 1.5, 2]);
});

test("setClipIn is a slip now: the length is kept", () => {
    const cut = cutOf([shot("a.mp4", 2, { in: 1 })]);
    const got = D.setClipIn(cut, 0, 3, DUR);
    assert.deepEqual([got.clips[0].in, got.clips[0].length], [3, 2]);
});

// ── slide ──

test("a slide moves a shot along the film, its neighbours give and take, the film keeps its length", () => {
    const cut = cutOf([shot("a.mp4", 3), shot("c.mp4", 2, { in: 1 }), shot("b.mp4", 3, { in: 1 })]);
    const got = D.slideClip(cut, 1, 0.75, DUR);
    near(got.clips[0].length, 3.75);
    assert.deepEqual([got.clips[1].in, got.clips[1].length], [1, 2]);        // the shot itself: unchanged
    near(got.clips[2].in, 1.75);
    near(got.clips[2].length, 2.25);
    near(D.clipStarts(got)[1], 3.75);
    near(D.mainLength(got), D.mainLength(cut));
    const left = D.slideClip(cut, 1, -5, DUR);           // b has 1 s of head; a keeps MIN_CLIP
    near(left.clips[2].in, 0);
    near(left.clips[0].length, 2);
    near(D.mainLength(left), D.mainLength(cut));
    assert.equal(D.slideClip(cut, 0, 1, DUR), null);     // no shot before it
    assert.equal(D.slideClip(cut, 2, 1, DUR), null);     // none after it
});

// ── trims and the source ──

test("a trim stops at the end of the file; a still grows as far as it is pulled, at either end", () => {
    const cut = cutOf([shot("a.mp4", 4, { in: 1 }), shot("p.png", 3)]);
    near(D.trimEnd(cut, 0, 9, DUR).clips[0].length, 5);
    near(D.trimEnd(cut, 0, 9).clips[0].length, 9);                    // not known: not held
    near(D.trimEnd(cut, 1, 12, DUR).clips[1].length, 12);
    const head = D.trimStart(cut, 1, -4);
    assert.deepEqual([head.clips[1].in, head.clips[1].length], [0, 7]);
    const film = D.trimStart(cut, 0, -4);
    assert.deepEqual([film.clips[0].in, film.clips[0].length], [0, 5]);
});

test("a placed still grows to the left as far as the film's start", () => {
    const cut = cutOf([shot("a.mp4", 6)], { tracks: [{ id: "V2", kind: "video", name: "V2", off: false,
        clips: [{ file: "p.png", name: "p", in: 0, length: 3, at: 2, color: "", volume: 1 }] }] });
    const c = D.trimTrackClipStart(cut, "V2", 0, -5).tracks[0].clips[0];
    assert.deepEqual([c.at, c.in, c.length], [0, 0, 5]);
    near(D.trimTrackClipEnd(cut, "V2", 0, 20, DUR).tracks[0].clips[0].length, 20);
});

// ── retime ──

test("retime: the length changes, the source in and out stay, the speed follows", () => {
    const cut = cutOf([shot("a.mp4", 4, { in: 1 }), shot("b.mp4", 2)]);
    const slow = D.retimeClip(cut, { kind: "clip", i: 0 }, 8);
    near(slow.clips[0].speed, 0.5);
    near(slow.clips[0].in, 1);
    near(D.srcUse(slow.clips[0]), 4);
    near(D.srcLocal(slow.clips[0], 2), 2);                  // 2 s into it: 1 s of source past the in
    const fast = D.retimeClip(slow, { kind: "clip", i: 0 }, 2);
    near(fast.clips[0].speed, 2);
    near(D.srcUse(fast.clips[0]), 4);
    const back = D.setSpeed(fast, { kind: "clip", i: 0 }, 1);
    assert.equal(back.clips[0].speed, undefined);           // 100 % is no speed at all
    near(back.clips[0].length, 4);
    near(D.retimeClip(cut, { kind: "clip", i: 0 }, 400).clips[0].speed, D.MIN_SPEED);
    near(D.retimeClip(cut, { kind: "clip", i: 0 }, 400).clips[0].length, 40);
    const still = D.retimeClip(cutOf([shot("p.png", 3)]), { kind: "clip", i: 0 }, 6);
    assert.deepEqual([still.clips[0].length, still.clips[0].speed], [6, undefined]);
});

test("a retimed clip trims and splits at its speed", () => {
    const cut = D.setSpeed(cutOf([shot("a.mp4", 2, { in: 1 })]), { kind: "clip", i: 0 }, 2);   // 1 s long, 2 s of source
    near(cut.clips[0].length, 1);
    near(D.trimEnd(cut, 0, 10, DUR).clips[0].length, 2.5);    // 5 s of source left at 2x
    const split = D.splitClip(cut, { kind: "clip", i: 0 }, 0.5);
    near(split.cut.clips[1].in, 2);
    near(split.cut.clips[1].speed, 2);
    const head = D.trimStart(cut, 0, 0.25);
    near(head.clips[0].in, 1.5);
});

// ── loops ──

test("loop extend: past the source, the source again; a loop shorter than a turn is a plain clip", () => {
    const cut = cutOf([shot("c.mp4", 4)]);
    const sel = { kind: "clip", i: 0 };
    const two = D.loopOnce(cut, sel, "loop", DUR);
    assert.equal(two.clips[0].loop, "loop");
    near(two.clips[0].span, 4);
    near(two.clips[0].length, 8);
    near(D.srcLocal(two.clips[0], 5), 1);
    assert.deepEqual(D.loopSeams(two.clips[0]), [4]);
    const three = D.loopOnce(two, sel, "loop", DUR);
    near(three.clips[0].length, 12);
    const short = D.trimEnd(three, 0, 3, DUR);
    assert.equal(short.clips[0].loop, undefined);
    near(short.clips[0].length, 3);
    const off = D.setLoop(three, sel, "");
    near(off.clips[0].length, 4);
    assert.equal(D.splitClip(three, sel, 6), null);          // a loop is not cut
});

test("ping-pong runs back; a retimed loop loops the retimed clip", () => {
    const cut = D.loopExtend(cutOf([shot("c.mp4", 2, { in: 1 })]), { kind: "clip", i: 0 }, 6, "pingpong", DUR);
    const c = cut.clips[0];
    near(D.srcLocal(c, 0.5), 1.5);
    near(D.srcLocal(c, 2.5), 2.5);           // on the way back: 0.5 s back from the out point (3)
    near(D.srcLocal(c, 4.5), 1.5);
    const seg = D.clipSegment(c, 2.5);
    assert.deepEqual([seg.u0, seg.u1, seg.base, seg.rev], [2, 4, 3, true]);
    const fast = D.setSpeed(D.loopOnce(cutOf([shot("c.mp4", 2)]), { kind: "clip", i: 0 }, "loop", DUR), { kind: "clip", i: 0 }, 2);
    near(fast.clips[0].length, 2);            // two turns of 2 s of source at 2x
    assert.deepEqual(D.loopSeams(fast.clips[0]), [1]);
    const still = D.loopOnce(cutOf([shot("p.png", 3)]), { kind: "clip", i: 0 }, "loop");
    assert.deepEqual([still.clips[0].length, still.clips[0].loop], [6, undefined]);
});

test("speed and loop are saved, compared, carried to another track, and played", () => {
    const cut = D.loopOnce(D.setSpeed(cutOf([shot("a.mp4", 2), shot("b.mp4", 2)]), { kind: "clip", i: 0 }, 0.5), { kind: "clip", i: 0 }, "pingpong", DUR);
    const saved = D.toSave(cut).clips[0];
    assert.deepEqual([saved.speed, saved.loop, saved.span], [0.5, "pingpong", 2]);
    assert.deepEqual([D.toSave(cut).clips[1].speed, D.toSave(cut).clips[1].loop], [1, ""]);
    assert.ok(!D.sameCut(cut, D.setSpeed(cut, { kind: "clip", i: 0 }, 1)));
    const t = D.addTrack(cut, "video");
    const moved = D.transferClip(t, { kind: "clip", i: 0 }, "V2", 0).cut.tracks[0].clips[0];
    assert.deepEqual([moved.speed, moved.loop, moved.span], [0.5, "pingpong", 2]);
    const at = D.pictureAt(cut, 5);                          // 4..8 is the way back of the ping-pong
    assert.equal(at.rev, true);
    near(at.segAt, 4);
    near(at.local, 1.5);
    near(at.end, 8);
});

// ── in and out ──

test("in and out: set, pushed along, held to the film, snapped, a clip's range", () => {
    assert.deepEqual(D.setMark(null, "in", 10, 99), { start: 10, end: 99 });
    assert.deepEqual(D.setMark({ start: 10, end: 40 }, "out", 5, 99), { start: 5, end: 5 });
    assert.deepEqual(D.setMark({ start: 10, end: 40 }, "in", 50, 99), { start: 50, end: 50 });
    assert.deepEqual(D.setMark({ start: 10, end: 40 }, "out", 500, 99), { start: 10, end: 99 });
    assert.deepEqual(D.setMark({ start: 10, end: 40 }, "in", -3, 99), { start: 0, end: 40 });
    assert.equal(D.snapFrame(47, [0, 48, 96], 3), 48);
    assert.equal(D.snapFrame(43, [0, 48, 96], 3), 43);
    const cut = cutOf([shot("a.mp4", 2), shot("b.mp4", 3)]);
    assert.deepEqual(D.clipRange(cut, { kind: "clip", i: 1 }, 24), { start: 48, end: 119 });
    assert.deepEqual(D.rangeSeconds({ start: 48, end: 119 }, 24), [2, 5]);
    assert.deepEqual(D.shotsIn(cut, 1.9, 2.5), [0, 1]);
    assert.deepEqual(D.shotsIn(cut, 2, 5), [1]);
    assert.equal(D.timecode(62.5, 24), "00:01:02:12");
});

test("each trim is one new cut: the undo stack takes it whole", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4, { in: 1 }), shot("c.mp4", 3)]);
    let h = D.emptyHistory();
    const rolled = D.rollEdit(cut, 1, 0.5, DUR);
    h = D.historyPush(h, cut);
    const slipped = D.slipClip(rolled, { kind: "clip", i: 2 }, 0.5, DUR);
    h = D.historyPush(h, rolled);
    const u1 = D.historyUndo(h, slipped);
    assert.equal(u1.cut, rolled);
    const u2 = D.historyUndo(u1.history, u1.cut);
    assert.equal(u2.cut, cut);
    assert.equal(cut.clips[0].length, 4, "the cut given is left alone");
});
