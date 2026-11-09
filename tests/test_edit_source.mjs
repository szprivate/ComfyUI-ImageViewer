// node --test tests/test_edit_source.mjs
// The source viewer's three-point edits and reverse match frame (imageViewer_editTimelineData.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const src = { file: "s.mp4", name: "s" };
const V1 = (cut) => cut.clips.map((c) => [c.file, Math.round(D.clipStarts(cut)[cut.clips.indexOf(c)] * 100) / 100, c.length, c.in]);

test("three points make the fourth", () => {
    // source in and out: their length, at the timeline's in, else the playhead
    assert.deepEqual(D.threePoint({ in: 1, out: 3, dur: 10 }, { head: 5 }), { in: 1, length: 2, at: 5 });
    assert.deepEqual(D.threePoint({ in: 1, out: 3, dur: 10 }, { in: 4, out: 9, head: 5 }), { in: 1, length: 2, at: 4 });
    // a lone timeline out back-times it
    assert.deepEqual(D.threePoint({ in: 1, out: 3, dur: 10 }, { out: 8, head: 0 }), { in: 1, length: 2, at: 6 });
    // a timeline range and one source point: the range's length
    assert.deepEqual(D.threePoint({ in: 2, dur: 10 }, { in: 1, out: 4 }), { in: 2, length: 3, at: 1 });
    assert.deepEqual(D.threePoint({ out: 6, dur: 10 }, { in: 1, out: 4 }), { in: 3, length: 3, at: 1 });
    assert.deepEqual(D.threePoint({ head: 7, dur: 10 }, { in: 1, out: 2 }), { in: 7, length: 1, at: 1 });
    // nothing marked on the timeline: from the source's in (or playhead) to its end
    assert.deepEqual(D.threePoint({ head: 4, dur: 10 }, { head: 2 }), { in: 4, length: 6, at: 2 });
    assert.match(D.threePoint({ head: 0, dur: Infinity }, { head: 0 }).error, /out point/);
    assert.match(D.threePoint({ out: 1, dur: 10 }, { in: 0, out: 3 }).error, /before/);
    assert.match(D.threePoint({ in: 8, dur: 10 }, { in: 0, out: 3 }).error, /shorter/);
});

test("insert and overwrite on V1", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)]);
    const ins = D.sourceEdit(cut, "insert", { ...src, in: 1, length: 2 }, 2);
    assert.deepEqual(V1(ins.cut), [["a.mp4", 0, 2, 0], ["s.mp4", 2, 2, 1], ["a.mp4", 4, 2, 2], ["b.mp4", 6, 4, 0]]);
    assert.deepEqual(ins.sel, { kind: "clip", i: 1 });
    const ow = D.sourceEdit(cut, "overwrite", { ...src, in: 1, length: 2 }, 3);
    assert.deepEqual(V1(ow.cut), [["a.mp4", 0, 3, 0], ["s.mp4", 3, 2, 1], ["b.mp4", 5, 3, 1]]);
    near(D.mainLength(ow.cut), 8);
});

test("replace keeps the clip's place and length, the source's playhead on the timeline's", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4, { speed: 2 })]);
    const r = D.sourceEdit(cut, "replace", { ...src, in: 0, length: 1 }, 0, { head: 5, srcHead: 10, dur: 20 });
    const c = r.cut.clips[1];
    assert.deepEqual([c.file, c.in, c.length, c.speed], ["s.mp4", 9, 4, undefined]);
    assert.match(D.sourceEdit(cut, "replace", { ...src, in: 0, length: 1 }, 0, { head: 5, srcHead: 0.5 }).error, /before/);
    assert.match(D.sourceEdit(cut, "replace", { ...src, in: 0, length: 1 }, 0, { head: 5, srcHead: 10, dur: 11 }).error, /after/);
});

test("ripple overwrite: the shot under the playhead becomes the source range, what follows moves", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)], { tracks: [{ id: "V2", kind: "video", name: "V2", off: false,
        clips: [{ ...shot("o.mp4", 1), at: 6 }] }] });
    const r = D.sourceEdit(cut, "ripple", { ...src, in: 2, length: 1.5 }, 0, { head: 1 });
    assert.deepEqual(V1(r.cut), [["s.mp4", 0, 1.5, 2], ["b.mp4", 1.5, 4, 0]]);
    near(r.cut.tracks[0].clips[0].at, 3.5);
});

test("fit to fill retimes the source into the timeline's range", () => {
    const cut = cutOf([shot("a.mp4", 8)]);
    const r = D.sourceEdit(cut, "fit", { ...src, in: 0, length: 4 }, 0, { tlIn: 2, tlOut: 4 });
    const c = r.cut.clips[r.sel.i];
    assert.deepEqual([c.file, c.length, c.speed], ["s.mp4", 2, 2]);
    near(D.srcUse(c), 4);
    assert.match(D.sourceEdit(cut, "fit", { ...src, in: 0, length: 4 }, 0, {}).error, /in and an out/);
    assert.match(D.sourceEdit(cut, "fit", { ...src, in: 0, length: 40 }, 0, { tlIn: 0, tlOut: 1 }).error, /%/);
});

test("place on top, append, and a sound source on a sound track", () => {
    const cut = cutOf([shot("a.mp4", 8)], { tracks: [
        { id: "V2", kind: "video", name: "V2", off: false, clips: [{ ...shot("o.mp4", 2), at: 1 }] },
        { id: "A2", kind: "audio", name: "A2", off: false, clips: [{ ...shot("m.wav", 4), at: 0 }] }] });
    const p = D.sourceEdit(cut, "place", { ...src, in: 0, length: 2 }, 2);
    assert.equal(p.sel.track, "V3", "V2 is taken there: a new track");
    const p2 = D.sourceEdit(cut, "place", { ...src, in: 0, length: 2 }, 4);
    assert.equal(p2.sel.track, "V2");
    const ap = D.sourceEdit(cut, "append", { ...src, in: 0, length: 2 }, 0);
    assert.deepEqual(V1(ap.cut).at(-1), ["s.mp4", 8, 2, 0]);
    const snd = D.sourceEdit(cut, "insert", { file: "v.wav", name: "v", in: 0, length: 1 }, 2, { audio: "A2" });
    const a2 = snd.cut.tracks.find((k) => k.id === "A2").clips.map((c) => [c.file, c.at, c.length]).sort((x, y) => x[1] - y[1]);
    assert.deepEqual(a2, [["m.wav", 0, 2], ["v.wav", 2, 1], ["m.wav", 3, 2]]);
    assert.match(D.sourceEdit(cut, "overwrite", { file: "v.wav", in: 0, length: 1 }, 0, { audio: "A1" }).error, /sound track/);
});

test("reverse match frame finds where the cut shows a moment of a file", () => {
    const cut = cutOf([shot("a.mp4", 2), shot("s.mp4", 3, { in: 4 }), shot("s.mp4", 2, { in: 10, motion: "reverse" })]);
    const f = D.findSource(cut, "s.mp4", 5);
    assert.deepEqual(f.sel, { kind: "clip", i: 1 });
    near(f.t, 3);
    const r = D.findSource(cut, "s.mp4", 9.5);
    assert.deepEqual(r.sel, { kind: "clip", i: 2 });
    near(r.t, 5.5);
    assert.equal(D.findSource(cut, "s.mp4", 20), null);
    assert.equal(D.findSource(cut, "x.mp4", 0), null);
});

test("the function keys", async () => {
    const { sourceEditKey } = await import("../js/imageViewer_editSource.js");
    assert.deepEqual([["F9", false], ["F10", false], ["F11", false], ["F12", false], ["F10", true], ["F11", true], ["F12", true], ["F9", true]]
        .map(([k, s]) => sourceEditKey(k, s)), ["insert", "overwrite", "replace", "place", "ripple", "fit", "append", ""]);
});
