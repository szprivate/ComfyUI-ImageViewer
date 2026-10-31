// node --test tests/test_edit_timeline_data.mjs
// The Edit panel's arithmetic (bEpicViewer_editTimelineData.js): the blade, deleting, the undo stack, snapping,
// and the deterministic Auto edit modes.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/bEpicViewer_editTimelineData.js";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const shot = (file, length, extra = {}) => ({ ref: undefined, file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const lengths = (cut) => cut.clips.map((c) => Math.round(c.length * 1000) / 1000);

// ── the blade ──

test("a shot cut in two keeps the film: same length, the halves one after the other", () => {
    const cut = cutOf([shot("a.mp4", 4, { ref: 0, in: 1, color: "#ff0000", fx: { zx: 2 } }), shot("b.mp4", 3, { ref: 1 })]);
    const got = D.splitClip(cut, { kind: "clip", i: 0 }, 1.5);
    assert.ok(got);
    const [a, b, c] = got.cut.clips;
    assert.deepEqual(lengths(got.cut), [1.5, 2.5, 3]);
    assert.equal(a.in, 1);
    assert.equal(b.in, 2.5);                       // the second half starts where the first ended, in the source
    assert.equal(b.transition, 0);                 // no dissolve at a split
    assert.equal(b.ref, 0);                        // both halves name the item: what another program wrote survives
    assert.equal(b.color, "#ff0000");
    assert.deepEqual(b.fx, { zx: 2 });
    assert.notEqual(b.fx, a.fx);                   // a copy, not the same object
    assert.equal(c.ref, 1);
    near(D.mainLength(got.cut), D.mainLength(cut));
    assert.deepEqual(got.sel, { kind: "clip", i: 1 });
    assert.equal(cut.clips.length, 2, "the cut given is left alone");
});

test("no split too near a clip's end or inside a dissolve", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4, { transition: 1 })]);
    assert.equal(D.splitClip(cut, { kind: "clip", i: 0 }, 0.05), null);
    assert.equal(D.splitClip(cut, { kind: "clip", i: 0 }, 3.5), null);     // in the dissolve out of a (3..4)
    assert.ok(D.splitClip(cut, { kind: "clip", i: 0 }, 2.5));
    const starts = D.clipStarts(cut);
    assert.equal(D.splitClip(cut, { kind: "clip", i: 1 }, starts[1] + 0.5), null);   // in the dissolve into b
    assert.ok(D.splitClip(cut, { kind: "clip", i: 1 }, starts[1] + 2));
});

test("a placed clip splits in place: both halves stay where they were in the film", () => {
    const cut = cutOf([shot("a.mp4", 6)], {
        tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "o.mp4", name: "o", in: 2, length: 3, at: 1, color: "", volume: 1 }] }],
    });
    const got = D.splitClip(cut, { kind: "tclip", track: "V2", i: 0 }, 2);
    const [a, b] = got.cut.tracks[0].clips;
    assert.deepEqual([a.at, a.in, a.length], [1, 2, 1]);
    assert.deepEqual([b.at, b.in, b.length], [2, 3, 2]);
});

test("split at the playhead: the selected clip, or every clip there", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)], {
        tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "o.mp4", name: "o", in: 0, length: 4, at: 1, color: "", volume: 1 }] }],
    });
    const all = D.splitAt(cut, 2);
    assert.equal(all.count, 2);
    assert.equal(all.cut.clips.length, 3);
    assert.equal(all.cut.tracks[0].clips.length, 2);
    const one = D.splitAt(cut, 2, { kind: "tclip", track: "V2", i: 0 });
    assert.equal(one.count, 1);
    assert.equal(one.cut.clips.length, 2);
    assert.equal(D.splitAt(cutOf([shot("a.mp4", 4), shot("b.mp4", 4)]), 4), null, "on a join there is nothing to cut");
});

// ── deleting ──

test("delete lifts on a track (the gap stays) and ripples on one with Shift", () => {
    const k = { id: "V2", kind: "video", name: "V2", off: false, clips: [
        { file: "x.mp4", name: "x", in: 0, length: 2, at: 0, color: "", volume: 1 },
        { file: "y.mp4", name: "y", in: 0, length: 2, at: 3, color: "", volume: 1 },
        { file: "z.mp4", name: "z", in: 0, length: 1, at: 6, color: "", volume: 1 }] };
    const cut = cutOf([shot("a.mp4", 8)], { tracks: [k] });
    const lifted = D.liftClip(cut, { kind: "tclip", track: "V2", i: 1 });
    assert.deepEqual(lifted.tracks[0].clips.map((c) => c.at), [0, 6]);
    const rippled = D.rippleDelete(cut, { kind: "tclip", track: "V2", i: 1 });
    assert.deepEqual(rippled.tracks[0].clips.map((c) => c.at), [0, 4]);
});

test("on V1 a delete closes up, and the cut's last shot stays", () => {
    const cut = cutOf([shot("a.mp4", 2), shot("b.mp4", 3), shot("c.mp4", 4)]);
    const gone = D.rippleDelete(cut, { kind: "clip", i: 1 });
    assert.deepEqual(gone.clips.map((c) => c.file), ["a.mp4", "c.mp4"]);
    assert.deepEqual(D.clipStarts(gone), [0, 2]);
    const single = cutOf([shot("a.mp4", 2)]);
    assert.equal(D.liftClip(single, { kind: "clip", i: 0 }).clips.length, 1);
});

// ── the undo stack ──

test("undo and redo walk the cuts that were, and a new edit drops the redo", () => {
    const c0 = cutOf([shot("a.mp4", 4)]);
    const c1 = D.splitClip(c0, { kind: "clip", i: 0 }, 2).cut;
    const c2 = D.rippleDelete(c1, { kind: "clip", i: 0 });
    let h = D.emptyHistory();
    h = D.historyPush(h, c0);
    h = D.historyPush(h, c1);
    const u1 = D.historyUndo(h, c2);
    assert.equal(u1.cut, c1);
    const u2 = D.historyUndo(u1.history, u1.cut);
    assert.equal(u2.cut, c0);
    assert.equal(D.historyUndo(u2.history, u2.cut), null);
    const r1 = D.historyRedo(u2.history, u2.cut);
    assert.equal(r1.cut, c1);
    const r2 = D.historyRedo(r1.history, r1.cut);
    assert.equal(r2.cut, c2);
    assert.equal(D.historyRedo(r2.history, r2.cut), null);
    const branched = D.historyPush(u1.history, u1.cut);
    assert.equal(branched.future.length, 0);
    let deep = D.emptyHistory();
    for (let i = 0; i < 10; i++) deep = D.historyPush(deep, i, 4);
    assert.deepEqual(deep.past, [6, 7, 8, 9]);
});

// ── snapping ──

test("a moment snaps to the nearest edit point within reach", () => {
    const cut = cutOf([shot("a.mp4", 2), shot("b.mp4", 3)], { texts: [{ text: "hi", start: 0.7, length: 1 }] });
    assert.deepEqual(D.editPoints(cut), [0, 0.7, 1.7, 2, 5]);
    assert.equal(D.snapTime(2.08, [...D.editPoints(cut), 3.3], 0.1), 2);
    assert.equal(D.snapTime(3.25, [...D.editPoints(cut), 3.3], 0.1), 3.3);
    assert.equal(D.snapTime(3.6, D.editPoints(cut), 0.1), 3.6);
});

// ── auto edit ──

test("snap cuts to the beat: each cut to the nearest beat within reach, the earlier ones first", () => {
    const cut = cutOf([shot("a.mp4", 1.9), shot("b.mp4", 2.2), shot("c.mp4", 3)]);
    const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
    const got = D.snapCutsToBeats(cut, beats, { within: 0.3 });
    assert.deepEqual(D.clipStarts(got), [0, 2, 4]);      // 1.9 -> 2; then 2 + 2.2 = 4.2 -> 4
    assert.equal(got.clips[2].length, 3, "the last shot has no cut after it");
    const far = D.snapCutsToBeats(cut, [10, 20], { within: 0.3 });
    assert.deepEqual(lengths(far), lengths(cut), "no beat near: nothing moves");
    const short = D.snapCutsToBeats(cut, beats, { within: 0.3, durations: { "a.mp4": 1.95 } });
    assert.equal(short.clips[0].length, 1.9, "never longer than the file");
});

test("cut on the beat: each shot lasts N beats", () => {
    const cut = cutOf([shot("a.mp4", 5), shot("b.png", 5), shot("c.mp4", 5)]);
    const beats = D.everyNth([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75, 5.25], 1);
    const got = D.cutOnBeats(cut, beats, { every: 2 });
    // shot 1 ends on the 2nd beat after 0 (0.75), shot 2 on the 2nd after that (1.75), ...
    assert.deepEqual(D.clipStarts(got), [0, 0.75, 1.75]);
    near(D.mainLength(got), 2.75);
    const capped = D.cutOnBeats(cut, beats, { every: 4, durations: { "a.mp4": 1.0 } });
    near(capped.clips[0].length, 0.75);       // its file ends at 1 s: the last beat it reaches
    near(capped.clips[1].length, 2.75 - 0.75);    // the next four beats: 1.25, 1.75, 2.25, 2.75
    const some = D.cutOnBeats(cut, beats, { every: 2, indices: [1] });
    assert.equal(some.clips[0].length, 5);
    assert.equal(some.clips[2].length, 5);
    near(some.clips[1].length, 5.25 - 5);     // from 5 s only one beat is left: it ends on that one
});

test("every N-th beat, and beats of a sound placed later in the film", () => {
    assert.deepEqual(D.everyNth([1, 2, 3, 4, 5], 2), [1, 3, 5]);
    assert.deepEqual(D.beatsInFilm([0.5, 1, 1.5, 2], { at: 10, in: 1, length: 0.75 }), [10, 10.5]);
});

test("even rhythm, and fit to a length", () => {
    const cut = cutOf([shot("a.mp4", 5), shot("b.mp4", 1), shot("c.png", 4)]);
    assert.deepEqual(lengths(D.evenRhythm(cut, 2)), [2, 2, 2]);
    assert.deepEqual(lengths(D.evenRhythm(cut, 2, { durations: { "b.mp4": 1.5 } })), [2, 1.5, 2]);
    const fit = D.fitLength(cut, 5);
    near(D.mainLength(fit), 5);
    near(fit.clips[0].length / fit.clips[2].length, 5 / 4);       // one share for all
    const longer = D.fitLength(cut, 20, { durations: { "a.mp4": 6, "b.mp4": 1 } });
    near(longer.clips[0].length, 6);                             // as far as the file goes
    near(longer.clips[1].length, 1);
    near(D.mainLength(longer), 20);                               // the still takes the rest
    const withMix = cutOf([shot("a.mp4", 4), shot("b.mp4", 4, { transition: 1 })]);
    near(D.mainLength(D.fitLength(withMix, 5)), 5);
});

test("rhythm of a reference film: its shot lengths in order, repeating", () => {
    const cut = cutOf([shot("a.mp4", 5), shot("b.mp4", 5), shot("c.mp4", 5)]);
    assert.deepEqual(lengths(D.rhythmFrom(cut, [1, 2])), [1, 2, 1]);
    assert.deepEqual(lengths(D.rhythmFrom(cut, [3], { durations: { "b.mp4": 2 } })), [3, 2, 3]);
    assert.deepEqual(lengths(D.rhythmFrom(cut, [1, 2], { indices: [2] })), [5, 5, 1]);
});

test("best part: the head and tail of each shot off, stills alone", () => {
    const cut = cutOf([shot("a.mp4", 10, { in: 2 }), shot("b.png", 3)]);
    const got = D.bestPart(cut, { head: 0.1, tail: 0.2 });
    near(got.clips[0].in, 3);
    near(got.clips[0].length, 7);
    assert.equal(got.clips[1].length, 3);
});

test("what changed, in words; and a cut made to stand on its own", () => {
    const cut = cutOf([shot("a.mp4", 2, { ref: 0 }), shot("b.mp4", 2, { ref: 1 })]);
    assert.deepEqual(D.describeChanges(cut, cut).lines, ["nothing changed"]);
    const even = D.evenRhythm(cut, 1);
    const said = D.describeChanges(cut, even);
    assert.equal(said.changed, 2);
    assert.ok(said.lines.includes("2 shots changed"));
    assert.ok(said.lines.includes("1 cut moved"));
    assert.ok(said.lines.some((l) => l.includes("4.0s") && l.includes("2.0s")));
    const loose = D.detach({ ...cut, texts: [{ ref: 0, text: "x", start: 0, length: 1 }],
                             tracks: [{ id: "V2", kind: "video", name: "V2", clips: [{ ref: [1, 0], file: "o.mp4", at: 0, in: 0, length: 1 }] }] });
    assert.ok(loose.clips.every((c) => !("ref" in c)));
    assert.ok(!("ref" in loose.texts[0]) && !("ref" in loose.tracks[0].clips[0]));
    assert.ok(D.toSave(loose).clips.every((c) => c.file));
});

test("what agentY would not read back is named", () => {
    assert.deepEqual(D.agentLoses(cutOf([shot("a.mp4", 2)])), []);
    const rich = cutOf([shot("a.mp4", 2, { fx: { op: 0.5 } })], {
        texts: [{ text: "x", start: 0, length: 1, size: 12 }],
        tracks: [{ id: "A2", kind: "audio", name: "A2", clips: [{ file: "m.wav", at: 0, in: 0, length: 1 }] }],
    });
    assert.equal(D.agentLoses(rich).length, 3);
});

// ── scene cut detection ──

test("detected cuts: only those inside the clip's trim, at the sensitivity, as moments of the film", () => {
    const cuts = [{ t: 1, score: 0.3, ratio: 20, kind: "cut" }, { t: 2.5, score: 0.05, ratio: 9, kind: "cut" },
                  { t: 3.5, score: 0.45, ratio: 10, kind: "dissolve" }, { t: 5, score: 0.7, ratio: 1.5, kind: "cut" },
                  { t: 6, score: 0.5, ratio: 30, kind: "cut" }];
    const clip = shot("e.mp4", 4.5, { in: 0.5 });          // shows 0.5 .. 5 of its file
    const marks = D.cutMarks(cuts, clip, 10, 0.5, 24);
    assert.deepEqual(marks.map((m) => m.t), [10.5, 13]);  // 1 and 3.5 of the file; 2.5 too soft, 5 not standing out, 6 trimmed off
    assert.deepEqual(marks.map((m) => m.kind), ["cut", "dissolve"]);
    assert.equal(D.cutMarks(cuts, clip, 10, 1, 24).length, 3, "more sensitive: the soft one too");
    assert.ok(D.cutThreshold(0) > D.cutThreshold(0.5) && D.cutThreshold(0.5) > D.cutThreshold(1));
});

test("split at all: one clip cut at every mark, the film unchanged", () => {
    const cut = cutOf([shot("a.mp4", 2), shot("e.mp4", 6, { in: 1, ref: 3 }), shot("b.mp4", 2)]);
    const got = D.splitAtMany(cut, { kind: "clip", i: 1 }, [5, 3, 4, 2.02, 3]);
    assert.equal(got.count, 3, "2.02 is too near the clip's start");
    assert.deepEqual(lengths(got.cut), [2, 1, 1, 1, 3, 2]);
    assert.deepEqual(got.cut.clips.slice(1, 5).map((c) => c.in), [1, 2, 3, 4]);
    assert.ok(got.cut.clips.slice(1, 5).every((c) => c.ref === 3));
    near(D.mainLength(got.cut), D.mainLength(cut));
});
