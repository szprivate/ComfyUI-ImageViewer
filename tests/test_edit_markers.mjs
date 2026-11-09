// node --test tests/test_edit_markers.mjs
// Markers (imageViewer_editTimelineData.js): on the timeline and on clips, how they ride with the clips, snapping, the file.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });

test("M on the timeline: a marker at the frame, not doubled, kept in time order", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)]);
    const one = D.addMarker(cut, 2.51, { color: "red" });
    assert.equal(one.made, true);
    assert.deepEqual(one.cut.markers, [{ t: 2.5, len: 0, name: "", note: "", color: "red" }]);
    const again = D.addMarker(one.cut, 2.5);
    assert.equal(again.made, false);
    assert.equal(again.cut, one.cut);
    const two = D.addMarker(one.cut, 1).cut;
    assert.deepEqual(two.markers.map((m) => m.t), [1, 2.5]);
    assert.equal(cut.markers.length, 0, "the cut it came from is not touched");
});

test("a clip marker is a moment of the source: it rides with moves, trims and speed, and a trim can hide it", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4, { in: 1 })]);
    const got = D.addMarker(cut, 5, { sel: { kind: "clip", i: 1 } });
    assert.deepEqual(got.which, { kind: "cmarker", sel: { kind: "clip", i: 1 }, i: 0 });
    assert.equal(got.cut.clips[1].markers[0].src, 2, "a second into b, which starts 1 s into its file");
    assert.deepEqual(D.allMarkers(got.cut).map((m) => m.t), [5]);
    // The clip before it gets longer: the marker moves with b.
    const longer = { ...got.cut, clips: [{ ...got.cut.clips[0], length: 5 }, got.cut.clips[1]] };
    assert.deepEqual(D.allMarkers(longer).map((m) => m.t), [6]);
    // b's in trimmed later by half a second: the marker is half a second nearer b's start.
    const trimmed = { ...got.cut, clips: [got.cut.clips[0], { ...got.cut.clips[1], in: 1.5, length: 3.5 }] };
    assert.deepEqual(D.allMarkers(trimmed).map((m) => m.t), [4.5]);
    // Past the marker: hidden, kept.
    const past = { ...got.cut, clips: [got.cut.clips[0], { ...got.cut.clips[1], in: 2.5, length: 2 }] };
    assert.deepEqual(D.allMarkers(past), []);
    assert.equal(past.clips[1].markers.length, 1);
    // At 2x the source runs twice as fast past the marker.
    const fast = { ...got.cut, clips: [got.cut.clips[0], { ...got.cut.clips[1], speed: 2, length: 2 }] };
    assert.deepEqual(D.allMarkers(fast).map((m) => m.t), [4.5]);
    // A placed clip's marker too.
    const placed = cutOf([shot("a.mp4", 4)], { tracks: [{ id: "V2", kind: "video", name: "V2", clips: [{ ...shot("c.mp4", 2, { in: 3 }), at: 1 }] }] });
    const p = D.addMarker(placed, 1.5, { sel: { kind: "tclip", track: "V2", i: 0 } });
    assert.equal(p.cut.tracks[0].clips[0].markers[0].src, 3.5);
    assert.deepEqual(D.allMarkers({ ...p.cut, tracks: [{ ...p.cut.tracks[0], clips: [{ ...p.cut.tracks[0].clips[0], at: 2 }] }] }).map((m) => m.t), [2.5]);
});

test("a clip marker asked for outside the clip lands on the timeline", () => {
    const cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)]);
    const got = D.addMarker(cut, 1, { sel: { kind: "clip", i: 1 } });
    assert.equal(got.which.kind, "marker");
});

test("edit, move, remove, next / previous, markers at a frame", () => {
    let cut = cutOf([shot("a.mp4", 4), shot("b.mp4", 4)]);
    cut = D.addMarker(cut, 1).cut;
    const c = D.addMarker(cut, 6, { sel: { kind: "clip", i: 1 } });
    cut = c.cut;
    cut = D.editMarker(cut, { kind: "marker", i: 0 }, { name: "x", note: "y", color: "purple", len: 0.5 });
    assert.deepEqual(cut.markers[0], { t: 1, len: 0.5, name: "x", note: "y", color: "purple" });
    const moved = D.moveMarker(cut, { kind: "marker", i: 0 }, 3.01);
    assert.equal(moved.cut.markers[0].t, 3);
    assert.deepEqual(moved.which, { kind: "marker", i: 0 });
    const cm = D.moveMarker(cut, c.which, 7.5);
    assert.equal(cm.cut.clips[1].markers[0].src, 3.5);
    const held = D.moveMarker(cut, c.which, 20);
    assert.ok(Math.abs(held.cut.clips[1].markers[0].src - (4 - 1 / 24)) < 1e-3, "held inside its clip");
    assert.equal(D.nextMarker(cut, 0, 1).t, 1);
    assert.equal(D.nextMarker(cut, 1, 1).t, 6);
    assert.equal(D.nextMarker(cut, 6, 1), null);
    assert.equal(D.nextMarker(cut, 6, -1).t, 1);
    assert.equal(D.markersAt(cut, 6.01).length, 1);
    const gone = D.removeMarkers(cut, [{ kind: "marker", i: 0 }, c.which]);
    assert.deepEqual(D.allMarkers(gone), []);
});

test("markers are snap targets, are an unsaved change, go into the save and are let go of their refs by detach", () => {
    const cut = cutOf([shot("a.mp4", 4, { ref: 0, markers: [{ src: 1, len: 0, name: "", note: "", color: "blue", ref: 2 }] })],
                      { markers: [{ t: 2, len: 0, name: "m", note: "", color: "blue", ref: 0 }] });
    const t = D.snapTargets(cut).filter((g) => g.kind === "marker").map((g) => g.t);
    assert.deepEqual(t, [1, 2]);
    assert.equal(D.sameCut(cut, D.editMarker(cut, { kind: "marker", i: 0 }, { name: "n" })), false);
    assert.equal(D.sameCut(cut, D.editMarker(cut, { kind: "cmarker", sel: { kind: "clip", i: 0 }, i: 0 }, { name: "n" })), false);
    assert.equal(D.sameCut(cut, { ...cut }), true);
    const saved = D.toSave(cut);
    assert.deepEqual(saved.markers, [{ t: 2, len: 0, name: "m", note: "", color: "blue", ref: 0 }]);
    assert.deepEqual(saved.clips[0].markers, [{ src: 1, len: 0, name: "", note: "", color: "blue", ref: 2 }]);
    assert.deepEqual(D.toSave({ ...cut, clips: [{ ...cut.clips[0], markers: undefined }] }).clips[0].markers, [], "always stated: one taken away goes");
    const loose = D.detach(cut);
    assert.equal(loose.markers[0].ref, undefined);
    assert.equal(loose.clips[0].markers[0].ref, undefined);
});

test("a split keeps a clip's markers on the piece they lie in", () => {
    let cut = cutOf([shot("a.mp4", 4)]);
    cut = D.addMarker(cut, 1, { sel: { kind: "clip", i: 0 } }).cut;
    cut = D.addMarker(cut, 3, { sel: { kind: "clip", i: 0 } }).cut;
    const split = D.splitClip(cut, { kind: "clip", i: 0 }, 2).cut;
    assert.deepEqual(D.allMarkers(split).map((m) => [m.t, m.which.sel.i]), [[1, 0], [3, 1]]);
});
