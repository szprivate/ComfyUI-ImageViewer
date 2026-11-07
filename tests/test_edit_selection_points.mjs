// node --test tests/test_edit_selection_points.mjs
// The Edit panel as Resolve's, the arithmetic: the scale below Fit, new tracks, several selected on any tracks,
// moves by frames, edit points and going from one to the next, deleting several, and snaps that land ON a frame.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (name, length, extra = {}) => ({ file: name + ".mp4", name, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const placed = (name, at, length, extra = {}) => ({ file: name + ".mp4", name, in: 0, length, at, color: "", volume: 1, ...extra });
const CUT = () => ({ ...D.emptyCut("t"), clips: [shot("a", 4), shot("b", 3), shot("c", 4)],
                     texts: [{ text: "hi", start: 1, length: 2 }], sound: [{ name: "music", file: "music.wav" }],
                     tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [placed("v", 2, 1)] },
                              { id: "A2", kind: "audio", name: "A2", off: false, clips: [placed("s", 5, 2)] }] });
const frame = (t, fps = 24) => t * fps;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg || ""} ${a} != ${b}`);

// ── 1. zoom ──

test("zoom limits: down to 0.25x, up to 64x; a hair off 1 is Fit", () => {
    assert.equal(D.clampZoom(0.1), D.MIN_ZOOM);
    assert.equal(D.MIN_ZOOM, 0.25);
    assert.equal(D.clampZoom(100), D.MAX_ZOOM);
    assert.equal(D.clampZoom(0.995), 1);
    assert.equal(D.clampZoom(NaN), 1);
});

test("below Fit the strip keeps the panel's width and stands for more seconds than the film", () => {
    assert.equal(D.viewSpan(11, 1), 11);
    assert.equal(D.viewSpan(11, 4), 11);
    assert.equal(D.viewSpan(11, 0.25), 44);
    assert.equal(D.areaPercent(0.25), 100);
    assert.equal(D.areaPercent(4), 400);
});

test("layout on a span: the film takes its share; the bed only under the film", () => {
    const lay = D.layoutCut(CUT(), 1, 44);
    assert.equal(lay.total, 44);
    assert.equal(lay.film, 11);
    near(lay.shots[2].left, (7 / 44) * 100);
    near(lay.shots[2].width, (4 / 44) * 100);
    near(lay.sound[0].width, 25);
    // Without a span, as it always was.
    assert.equal(D.layoutCut(CUT()).total, 11);
    assert.equal(D.layoutCut(CUT()).sound[0].width, 100);
});

test("a sound running on past the film is on the timeline: contentEnd", () => {
    const cut = CUT();
    cut.tracks[1].clips[0].at = 20;
    assert.equal(D.filmLength(cut), 11);
    assert.equal(D.contentEnd(cut), 22);
});

test("an edit keeps the seconds per pixel; Fit stays Fit", () => {
    assert.equal(D.keepScale(1, 10, 20), 1);
    assert.equal(D.keepScale(2, 10, 20), 4);
    assert.equal(D.keepScale(0.5, 20, 10), 0.25);
    assert.equal(D.keepScale(0.5, 0, 10), 0.5);
});

test("V1 past its end: a move and a drop land there with a gap before them", () => {
    const moved = D.moveShot(CUT(), 0, 30);
    assert.deepEqual(D.clipStarts(moved.cut)[moved.i], 30);
    const place = D.v1DropAt(CUT(), 20);
    assert.ok(place.past);
    assert.equal(place.moment, 20);
    const got = D.insertAt(CUT(), { file: "n.mp4", name: "n", length: 2 }, 20);
    assert.equal(got.i, 3);
    assert.equal(D.clipStarts(got.cut)[3], 20);
    assert.equal(got.cut.clips[3].gap, 9);
    assert.equal(D.filmLength(got.cut), 22);
    // At the end, it is the end: no gap.
    assert.ok(!D.v1DropAt(CUT(), 11).past);
});

// ── 2. new tracks ──

test("a clip into the empty room: picture up, sound down, a track of its own, the next id", () => {
    assert.equal(D.nextTrackId(CUT(), "video"), "V3");
    assert.equal(D.nextTrackId(CUT(), "audio"), "A3");
    const up = D.transferToNewTrack(CUT(), { kind: "clip", i: 1 }, "video", 2);
    assert.deepEqual(up.sel, { kind: "tclip", track: "V3", i: 0 });
    assert.equal(D.trackOf(up.cut, "V3").clips[0].at, 2);
    assert.equal(up.cut.clips.length, 2);
    assert.equal(D.clipStarts(up.cut)[1], 7, "the clips after it stay");
    const down = D.transferToNewTrack(CUT(), { kind: "tclip", track: "A2", i: 0 }, "audio", 6);
    assert.deepEqual(down.sel, { kind: "tclip", track: "A3", i: 0 });
    assert.equal(D.trackOf(down.cut, "A2").clips.length, 0);
    // Picture does not go down, sound does not go up, the last shot does not leave V1.
    assert.equal(D.transferToNewTrack(CUT(), { kind: "clip", i: 1 }, "audio", 2), null);
    assert.equal(D.transferToNewTrack(CUT(), { kind: "tclip", track: "A2", i: 0 }, "video", 2), null);
    const one = { ...D.emptyCut("t"), clips: [shot("a", 4)] };
    assert.equal(D.transferToNewTrack(one, { kind: "clip", i: 0 }, "video", 2), null);
});

// ── 4. several on any tracks ──

test("a list holds picture, placed sound, the bed, a text and a gap; each by its own id", () => {
    const cut = CUT();
    cut.clips[1].gap = 1;
    const list = [{ kind: "sound", i: 0 }, { kind: "tclip", track: "A2", i: 0 }, { kind: "clip", i: 0 }, { kind: "text", i: 0 }, { kind: "gap", i: 1 }];
    assert.deepEqual(D.pruneSel(cut, list).map(D.selId), ["T:0", "V1:0", "gap:1", "A2:0", "A1:0"]);
    // What is no longer there goes; a clip's gap that was closed too.
    assert.deepEqual(D.pruneSel(CUT(), list).map(D.selId), ["T:0", "V1:0", "A2:0", "A1:0"]);
    assert.deepEqual(D.toggleSel(D.toggleSel([], { kind: "sound", i: 0 }), { kind: "clip", i: 1 }).map(D.selId), ["A1:0", "V1:1"]);
    assert.equal(D.toggleSel([{ kind: "sound", i: 0 }], { kind: "sound", i: 0 }).length, 0);
    // A list made before a text or a clip of the bed went is let go.
    const fewer = { ...CUT(), sound: [] };
    assert.notEqual(D.selSignature(CUT()), D.selSignature(fewer));
    // agentY reads clips.
    assert.deepEqual(D.selectedClips(cut, list).map((c) => c.id), ["V1:0", "A2:0"]);
});

// ── 7. moving by frames ──

test("a clip on a track moves by a frame, not below the start", () => {
    const sel = { kind: "tclip", track: "V2", i: 0 };
    const got = D.moveSelection(CUT(), [sel], 1 / 24);
    near(frame(D.clipOf(got.cut, sel).at), 49);
    const held = D.moveSelection(CUT(), [sel], -10);
    assert.equal(D.clipOf(held.cut, sel).at, 0);
    assert.equal(held.delta, -2);
});

test("on V1 it goes into a gap and stops at the next clip; what follows stays where it is", () => {
    const cut = CUT();
    cut.clips[1].gap = 0.5;                                  // a 4, gap .5, b at 4.5 to 7.5, c at 7.5
    const sel = { kind: "clip", i: 1 };
    const back = D.moveSelection(cut, [sel], -0.25);
    assert.deepEqual(D.clipStarts(back.cut), [0, 4.25, 7.5]);
    const far = D.moveSelection(cut, [sel], -3);
    assert.deepEqual(D.clipStarts(far.cut), [0, 4, 7.5]);
    assert.equal(far.delta, -0.5);
    // Touching on the right: held.
    const none = D.moveSelection(cut, [sel], 1);
    assert.equal(none.delta, 0);
    assert.equal(none.cut, cut);
    // The last clip runs on free.
    const last = D.moveSelection(CUT(), [{ kind: "clip", i: 2 }], 2);
    assert.deepEqual(D.clipStarts(last.cut), [0, 4, 9]);
    // The first, to the start and no further.
    const first = { ...CUT() };
    first.clips[0].gap = 1;
    assert.deepEqual(D.clipStarts(D.moveSelection(first, [{ kind: "clip", i: 0 }], -5).cut), [0, 5, 8]);
});

test("several move together, by the most the tightest allows, on every track, a linked partner too", () => {
    const cut = CUT();
    cut.clips[2].gap = 1;                                    // c at 8
    cut.clips[2].link = "L";
    cut.tracks[1].clips[0].link = "L";
    const got = D.moveSelection(cut, [{ kind: "clip", i: 1 }, { kind: "tclip", track: "V2", i: 0 }, { kind: "text", i: 0 }], 0.5);
    assert.deepEqual(D.clipStarts(got.cut), [0, 4.5, 8]);
    assert.equal(got.cut.tracks[0].clips[0].at, 2.5);
    assert.equal(got.cut.texts[0].start, 1.5);
    assert.equal(D.moveSelection(cut, [{ kind: "clip", i: 1 }], 5).delta, 1, "the gap's length");
    // A run moves as one, and the partner with it.
    const run = D.moveSelection(cut, [{ kind: "clip", i: 2 }], 1);
    assert.equal(run.cut.tracks[1].clips[0].at, 6);
    assert.deepEqual(D.clipStarts(D.moveSelection({ ...CUT() }, [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }], 1).cut), [0, 5, 8]);
    // The bed and gaps do not move.
    assert.equal(D.moveSelection(cut, [{ kind: "sound", i: 0 }], 1).delta, 0);
});

// ── 5. edit points, 8. going from one to the next ──

test("the stops of V1: a roll where two clips touch, an edge beside a gap or a dissolve", () => {
    const cut = CUT();
    assert.deepEqual(D.editStops(cut).map((s) => [s.t, D.selId(s.a), D.selId(s.b)]),
                     [[0, "", "V1:0"], [4, "V1:0", "V1:1"], [7, "V1:1", "V1:2"], [11, "V1:2", ""]]);
    cut.clips[1].gap = 1;
    cut.clips[2].transition = 0.5;
    assert.deepEqual(D.editStops(cut).map((s) => [s.t, D.selId(s.a), D.selId(s.b)]),
                     [[0, "", "V1:0"], [4, "V1:0", ""], [5, "", "V1:1"], [7.5, "", "V1:2"], [8, "V1:1", ""], [11.5, "V1:2", ""]]);
});

test("the stops of another track, and stopping at each in turn, by frames", () => {
    const cut = CUT();
    cut.tracks[0].clips.push(placed("w", 3, 2), placed("x", 8, 1));
    const stops = D.editStops(cut, "V2");
    assert.deepEqual(stops.map((s) => s.t), [2, 3, 5, 8, 9]);
    assert.equal(D.selId(stops[1].a), "V2:0");
    assert.equal(D.selId(stops[1].b), "V2:1");
    const v1 = D.editStops(CUT());
    assert.equal(D.nextStop(v1, 0, 1, 24).t, 4);
    assert.equal(D.nextStop(v1, 96, 1, 24).t, 7, "on a stop, the next one");
    assert.equal(D.nextStop(v1, 96, -1, 24).t, 0);
    assert.equal(D.nextStop(v1, 100, -1, 24).t, 4);
    assert.equal(D.nextStop(v1, 0, -1, 24), null);
    assert.equal(D.nextStop(v1, 264, 1, 24), null);
});

test("a stop as an edit point, and what it does in each mode", () => {
    const [start, cutA, , end] = D.editStops(CUT());
    const roll = D.stopPoint(cutA);
    assert.equal(roll.act, "roll");
    assert.equal(D.selId(roll.a), "V1:0");
    assert.equal(D.selId(roll.b), "V1:1");
    assert.equal(D.pointAct(roll, false), "roll");
    assert.equal(D.pointAct(roll, true), "roll");
    const incoming = D.stopPoint(start), outgoing = D.stopPoint(end);
    assert.equal(incoming.side, "start");
    assert.equal(outgoing.side, "end");
    assert.equal(D.pointAct(incoming, false), "trim-in");
    assert.equal(D.pointAct(incoming, true), "ripple-in");
    assert.equal(D.pointAct(outgoing, false), "trim-out");
    assert.equal(D.pointAct(outgoing, true), "ripple-out");
});

test("edit-point trims per side: Selection opens a gap, Trim ripples, a roll moves both edges", () => {
    const f = 1 / 24, dur = { "a.mp4": 10, "b.mp4": 10 };
    const cut = CUT();
    // The outgoing edge, Selection: a shorter, a gap, b stays.
    let next = D.liftTrimEnd(cut, 0, 4 - f, dur);
    assert.deepEqual(D.clipStarts(next), [0, 4, 7]);
    near(next.clips[0].length, 4 - f);
    near(next.clips[1].gap, f);
    // Longer into a clip that touches it: held.
    assert.equal(D.liftTrimEnd(cut, 0, 4 + f, dur).clips[0].length, 4);
    // The incoming edge, Selection: b begins later, its end stays.
    next = D.liftTrimStart(cut, 1, f);
    near(D.clipStarts(next)[1], 4 + f);
    assert.equal(D.clipStarts(next)[2], 7);
    // The same edges in the Trim mode: what follows moves.
    next = D.trimEnd(cut, 0, 4 - f, dur);
    near(D.clipStarts(next)[1], 4 - f);
    near(D.clipStarts(next)[2], 7 - f);
    next = D.trimStart(cut, 1, f);
    near(D.clipStarts(next)[2], 7 - f);
    // A roll: both edges, the film's length kept.
    next = D.rollEdit(cut, 1, f, dur);
    near(D.clipStarts(next)[1], 4 + f);
    assert.equal(D.clipStarts(next)[2], 7);
    near(next.clips[0].length, 4 + f);
    near(next.clips[1].length, 3 - f);
});

// ── 9. marquee ──

test("a marquee touches what lies under it on all its rows, the bed and texts too", () => {
    const ids = (rows, a, b) => D.marqueeSel(CUT(), rows, a, b).map(D.selId);
    assert.deepEqual(ids(["V1"], 3, 5), ["V1:0", "V1:1"]);
    assert.deepEqual(ids(["V1"], 5, 3), ["V1:0", "V1:1"], "dragged either way");
    assert.deepEqual(ids(["V2", "V1", "A1", "A2"], 5.5, 6), ["V1:1", "A2:0", "A1:0"]);
    assert.deepEqual(ids(["T"], 0, 0.5), []);
    assert.deepEqual(ids(["T"], 0, 1.5), ["T:0"]);
    assert.deepEqual(ids(["V1", "A1"], 20, 30), [], "past the film: nothing");
});

// ── 10. deleting several ──

test("a lift of several: gaps stay, every track, partners too, one cut", () => {
    const cut = CUT();
    cut.clips[1].link = "L";
    cut.tracks[1].clips[0].link = "L";
    const got = D.deleteSelection(cut, [{ kind: "clip", i: 0 }, { kind: "clip", i: 1 }, { kind: "tclip", track: "V2", i: 0 }], false);
    assert.deepEqual(got.cut.clips.map((c) => c.name), ["c"]);
    assert.deepEqual(D.clipStarts(got.cut), [7], "the clip left stays where it is");
    assert.equal(got.cut.tracks[0].clips.length, 0);
    assert.equal(got.cut.tracks[1].clips.length, 0, "the linked sound went too");
    assert.equal(got.kept, false);
});

test("a ripple of several: what follows closes up on each clip's own track", () => {
    const cut = CUT();
    cut.tracks[0].clips = [placed("v", 1, 1), placed("w", 3, 1), placed("x", 6, 2)];
    const got = D.deleteSelection(cut, [{ kind: "clip", i: 0 }, { kind: "clip", i: 1 }, { kind: "tclip", track: "V2", i: 0 }, { kind: "tclip", track: "V2", i: 1 }], true);
    assert.deepEqual(D.clipStarts(got.cut), [0]);
    assert.deepEqual(got.cut.tracks[0].clips.map((c) => [c.name, c.at]), [["x", 4]]);
    assert.equal(got.cut.tracks[1].clips[0].at, 5, "another track stays");
});

test("a text, the bed and a gap go too; a gap and the clip after it both", () => {
    const cut = CUT();
    cut.clips[1].gap = 1;
    let got = D.deleteSelection(cut, [{ kind: "text", i: 0 }, { kind: "sound", i: 0 }, { kind: "gap", i: 1 }], false);
    assert.equal(got.cut.texts.length, 0);
    assert.equal(got.cut.sound.length, 0);
    assert.deepEqual(D.clipStarts(got.cut), [0, 4, 7]);
    got = D.deleteSelection(cut, [{ kind: "gap", i: 1 }, { kind: "clip", i: 1 }], false);
    assert.deepEqual(got.cut.clips.map((c) => c.name), ["a", "c"]);
    assert.deepEqual(D.clipStarts(got.cut), [0, 7], "the gap closed by 1, then b's place left empty");
});

test("V1 keeps its last shot, and says so; the bed is saved as it is left", () => {
    const all = [0, 1, 2].map((i) => ({ kind: "clip", i }));
    for (const ripple of [false, true]) {
        const got = D.deleteSelection(CUT(), all, ripple);
        assert.equal(got.cut.clips.length, 1);
        assert.equal(got.kept, true);
    }
    assert.deepEqual(D.toSave({ ...CUT(), sound: [] }).sound, []);
    assert.deepEqual(D.toSave(CUT()).sound, [{ name: "music", file: "music.wav", fadeIn: 0, fadeOut: 0 }]);
    assert.equal(D.sameCut(CUT(), { ...CUT(), sound: [] }), false);
});

// ── 6. snaps that land on a frame ──

for (const fps of [24, 25, 30, 23.976]) {
    for (const zoom of [0.25, 1, 4, 16, 64]) {
        test(`a snap lands ON the target's frame at ${fps} fps, zoom ${zoom}`, () => {
            const width = 1600 * Math.max(1, zoom), total = 60 / Math.min(1, zoom);
            const tol = D.snapSeconds(D.SNAP_PX, total, width);
            const hit = 137;
            const targets = [{ t: Math.round((hit / fps) * 10000) / 10000, kind: "clip", owner: "V1:0" }];   // as snapTargets stores it
            const off = tol * 0.6;
            // One edge, from either side.
            for (const raw of [hit / fps + off, hit / fps - off]) {
                const got = D.snapPoint(raw, targets, tol, fps);
                assert.ok(got.target);
                assert.ok(Math.abs(frame(got.t, fps) - hit) < 1e-9, `${frame(got.t, fps)}`);
            }
            // A span by its start, and by its end with a length of no whole number of frames.
            const len = 87.48 / fps;
            const byStart = D.snapMove(hit / fps + off, len, targets, tol, fps);
            assert.equal(byStart.edge, "start");
            assert.ok(Math.abs(frame(byStart.at, fps) - hit) < 1e-9);
            const byEnd = D.snapMove(hit / fps - len + off, len, targets, tol, fps);
            assert.equal(byEnd.edge, "end");
            assert.ok(Math.abs(frame(byEnd.at + len, fps) - hit) < 0.01, `${frame(byEnd.at + len, fps)}`);
            // Nothing near: on a frame all the same.
            const free = D.snapMove((hit + 500.4) / fps, len, targets, tol, fps);
            assert.equal(free.target, null);
            assert.equal(Math.round(frame(free.at, fps) * 1000) / 1000, hit + 500);
        });
    }
}

test("a target off the grid lands on its nearest frame, not between two", () => {
    const got = D.snapPoint(2.01, [{ t: 2.0125, kind: "clip", owner: "x" }], 0.1, 24);
    assert.equal(frame(got.t), 48);
    const span = D.snapMove(2.01, 1, [{ t: 2.0125, kind: "clip", owner: "x" }], 0.1, 24);
    assert.equal(frame(span.at), 48);
});

test("what a drag leaves out: itself, its partner, and the gaps beside them - not the clips beyond the gaps", () => {
    const cut = CUT();
    cut.clips[1].gap = 1;
    cut.clips[2].gap = 1;
    const out = D.snapExclude(cut, { kind: "clip", i: 1 });
    assert.deepEqual(out, ["V1:1", "gap:1", "gap:2"]);
    const targets = D.snapTargets(cut, { exclude: out }).filter((g) => g.owner.startsWith("V1") || g.owner.startsWith("gap"));
    const starts = D.clipStarts(cut);
    // b's own edges are gone, c's start and a's end (the far edges of those gaps) are not.
    assert.ok(!targets.some((g) => g.t === starts[1]));
    assert.ok(targets.some((g) => g.t === 4));
    assert.ok(targets.some((g) => g.t === starts[2]));
});

// ── sound split off: relink, resync, merge back ──

const SPLIT = () => {
    const cut = { ...D.emptyCut("t"), clips: [shot("a", 4), shot("b", 3)], tracks: [] };
    return D.unlinkClip(cut, { kind: "clip", i: 0 });
};

test("relink from one clip, either part: the partner by the group, the offset kept and measured", () => {
    for (const from of [{ kind: "clip", i: 0 }, null]) {
        const got = SPLIT();
        got.cut.tracks[0].clips[0].at = 0.5;
        const sel = from || got.sel;
        assert.equal(D.syncOffset(got.cut, sel), 0.5);
        const next = D.relinkAudio(got.cut, sel);
        assert.ok(!next.clips[0].unlinked && !next.tracks[0].clips[0].unlinked);
        assert.equal(next.clips[0].mute, true, "the picture stays silent: its sound is the clip");
        assert.equal(next.tracks[0].clips[0].at, 0.5);
        assert.equal(D.syncOffset(next, sel), 0.5);
        // Moved together from there, the offset kept.
        const moved = D.moveSelection(next, [{ kind: "tclip", track: next.tracks[0].id, i: 0 }], 0);
        assert.equal(moved.delta, 0);
    }
    assert.equal(D.relinkAudio({ ...D.emptyCut("t"), clips: [shot("a", 4)] }, { kind: "clip", i: 0 }), null);
});

test("a pair trimmed differently but on the same moments is in sync; a resync moves the sound only", () => {
    const got = SPLIT();
    const s = got.cut.tracks[0].clips[0];
    s.at = 1; s.in = 1; s.length = 2;
    assert.equal(D.syncOffset(got.cut, got.sel), 0);
    assert.equal(D.resyncAudio(got.cut, got.sel), null);
    s.at = 2;
    const next = D.resyncAudio(got.cut, { kind: "clip", i: 0 });
    assert.equal(next.tracks[0].clips[0].at, 1);
    assert.equal(D.syncOffset(next, got.sel), 0);
    assert.deepEqual(D.clipStarts(next), [0, 4]);
    // Early, before the start of the film: it loses its head.
    s.at = 0; s.in = 3;
    const early = D.resyncAudio(got.cut, got.sel);
    assert.equal(early.tracks[0].clips[0].at, 3);
    s.at = 0; s.in = 0; got.cut.clips[0].in = 2;
    const head = D.resyncAudio(got.cut, got.sel);
    assert.equal(head.tracks[0].clips[0].at, 0);
    assert.equal(D.syncOffset(head, got.sel), 0);
});

test("merge back from either part: the sound clip gone, the picture sounding, the group over", () => {
    for (const from of [{ kind: "clip", i: 0 }, null]) {
        const got = SPLIT();
        const out = D.mergeAudio(got.cut, from || got.sel);
        assert.deepEqual(out.sel, { kind: "clip", i: 0 });
        assert.equal(out.cut.tracks[0].clips.length, 0);
        const v = out.cut.clips[0];
        assert.ok(v.mute === undefined && v.link === undefined && v.unlinked === undefined);
        assert.equal(D.clipVolume(v), 1);
        assert.equal(D.mergeAudio(out.cut, out.sel), null, "nothing left to merge");
    }
    // Its sound clip deleted first: the clip just gets its sound back.
    const got = SPLIT();
    const lone = D.deleteSelection(got.cut, [got.sel], false).cut;
    assert.equal(lone.clips[0].mute, true);
    assert.equal(D.clipVolume(D.mergeAudio(lone, { kind: "clip", i: 0 }).cut.clips[0]), 1);
    // Never both: sound clip and sounding picture.
    assert.equal(D.clipVolume(SPLIT().cut.clips[0]), 0);
    assert.equal(D.clipVolume(D.linkClips(SPLIT().cut, { kind: "clip", i: 0 }, SPLIT().sel).cut.clips[0]), 0);
});
