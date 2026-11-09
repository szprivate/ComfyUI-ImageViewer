// node --test tests/test_edit_range_swap.mjs
// Lift / extract of the in-out range, Swap Clips and Select Forward (imageViewer_editTimelineData.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const placed = (file, at, length, extra = {}) => ({ file, name: file, in: 0, at, length, volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const spans = (cut) => { const st = D.clipStarts(cut); return cut.clips.map((c, i) => [c.name, st[i], st[i] + c.length]); };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("lift: the range is cut out of V1 and the tracks, gaps stay, nothing moves", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)], {
        tracks: [{ id: "V2", kind: "video", clips: [placed("t.png", 1, 6)] }, { id: "A2", kind: "audio", clips: [placed("s.wav", 6, 2)] }],
    });
    const got = D.liftRange(cut, 3, 5, false, D.editMask(cut));
    assert.ok(!got.error, got.error);
    assert.deepEqual(spans(got.cut).map((s) => s.map((v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v))),
        [["a.mp4", 0, 3], ["b.mp4", 5, 8]]);
    near(D.mainLength(got.cut), 8);
    const v2 = got.cut.tracks[0].clips.map((c) => [c.at, c.at + c.length]);
    assert.deepEqual(v2, [[1, 3], [5, 7]]);
    assert.deepEqual(got.cut.tracks[1].clips.map((c) => c.at), [6], "a clip after the out is not touched");
});

test("extract: the hole closes - V1, the selected tracks and the markers after the out move up", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)], {
        tracks: [{ id: "A2", kind: "audio", clips: [placed("s.wav", 6, 2)] }],
        markers: [{ t: 4, len: 0, name: "in", note: "", color: "red" }, { t: 7, len: 0, name: "after", note: "", color: "blue" }],
    });
    const got = D.liftRange(cut, 3, 5, true, D.editMask(cut));
    assert.ok(!got.error, got.error);
    near(D.mainLength(got.cut), 6);
    assert.deepEqual(spans(got.cut).map((s) => s[1]), [0, 3]);
    assert.equal(got.cut.clips[1].in, 1, "b is cut a second into its file");
    assert.deepEqual(got.cut.tracks[0].clips.map((c) => c.at), [4]);
    assert.deepEqual(got.cut.markers.map((m) => [m.name, m.t]), [["after", 5]], "the marker inside goes, the one after moves");
});

test("a track whose Auto Track Selector is off, or that is locked, keeps what it has", () => {
    const cut = cutOf([shot("a.mp4", 8)], {
        tracks: [{ id: "V2", kind: "video", clips: [placed("t.png", 2, 4)], auto: false }],
    });
    const got = D.liftRange(cut, 3, 5, true, D.editMask(cut));
    assert.ok(!got.error, got.error);
    near(D.mainLength(got.cut), 6);
    assert.deepEqual(got.cut.tracks[0].clips.map((c) => [c.at, c.length]), [[2, 4]]);
});

test("extract of a range in a gap closes the gap; an empty range on no track is said", () => {
    const cut = cutOf([shot("a.mp4", 2), shot("b.mp4", 2, { gap: 3 })]);
    const got = D.liftRange(cut, 2, 4, true, D.editMask(cut));
    assert.ok(!got.error, got.error);
    near(D.mainLength(got.cut), 5);
    assert.equal(got.cut.clips[1].gap, 1);
    assert.ok(D.liftRange(cut, 2, 4, false, D.editMask(cut)).error);
    assert.ok(D.liftRange(cut, 2, 2, false, D.editMask(cut)).error);
});

test("a range that would cut through a dissolve is refused", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4, { transition: 1 })]);
    // The dissolve lies from 3 to 4.
    const got = D.liftRange(cut, 3.5, 5, false, D.editMask(cut));
    assert.ok(got.error);
});

test("swap on V1: the shots trade places, the gaps stay at their joins", () => {
    const cut = cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 }), shot("c.mp4", 1)]);
    const got = D.swapClip(cut, { kind: "clip", i: 0 }, 1);
    assert.deepEqual(got.sel, { kind: "clip", i: 1 });
    assert.deepEqual(spans(got.cut), [["b.mp4", 0, 3], ["a.mp4", 4, 6], ["c.mp4", 6, 7]]);
    assert.equal(D.swapClip(cut, { kind: "clip", i: 0 }, -1), null, "nothing before the first");
    const back = D.swapClip(got.cut, { kind: "clip", i: 1 }, -1);
    assert.deepEqual(spans(back.cut), spans(cut));
});

test("swap on a placed track keeps the gap between the two; a linked partner follows", () => {
    const cut = cutOf([shot("a.mp4", 10)], {
        tracks: [
            { id: "V2", kind: "video", clips: [placed("x.mp4", 1, 2, { link: "L1" }), placed("y.mp4", 4, 3)] },
            { id: "A2", kind: "audio", clips: [placed("x.mp4", 1, 2, { link: "L1" })] },
        ],
    });
    const got = D.swapClip(cut, { kind: "tclip", track: "V2", i: 0 }, 1);
    assert.ok(got);
    const v2 = got.cut.tracks[0].clips.map((c) => [c.name, c.at]);
    assert.deepEqual(v2.sort((p, q) => p[1] - q[1]), [["y.mp4", 1], ["x.mp4", 5]]);
    assert.deepEqual(got.cut.tracks[1].clips.map((c) => c.at), [5], "the sound of x went along");
});

test("select forward: on one track from the playhead on, on all tracks, and backwards; locked tracks are left out", () => {
    const cut = cutOf([shot("a.mp4", 2), shot("b.mp4", 2), shot("c.mp4", 2)], {
        tracks: [{ id: "V2", kind: "video", clips: [placed("t.png", 0.5, 1), placed("u.png", 4.5, 1)] },
                 { id: "A2", kind: "audio", clips: [placed("s.wav", 3, 1)], lock: true }],
    });
    assert.deepEqual(D.selectForward(cut, 3, "V1", 1).map(D.selId), ["V1:1", "V1:2"]);
    assert.deepEqual(D.selectForward(cut, 3, null, 1).map(D.selId), ["V1:1", "V1:2", "V2:1"]);
    assert.deepEqual(D.selectForward(cut, 3, null, -1).map(D.selId), ["V1:0", "V1:1", "V2:0"]);
    assert.deepEqual(D.selectForward(cut, 3, "A2", 1), []);
});
