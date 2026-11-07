// node --test tests/test_edit_gaps_links.mjs
// V1 with gaps, the Selection mode's lift and overwrite, the Trim mode's ripple / roll / slip / slide
// next to gaps, and a film's picture and sound split apart (link groups) - imageViewer_editTimelineData.js.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const DUR = { "a.mp4": 10, "b.mp4": 10, "c.mp4": 10, "d.mp4": 10 };
const abc = () => cutOf([shot("a.mp4", 2), shot("b.mp4", 3), shot("c.mp4", 4)],
                        { tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [] },
                                   { id: "A2", kind: "audio", name: "A2", off: false, clips: [] }] });

// ── gaps ──

test("a gap is empty time before a clip: starts, lengths, the layout, the picture there", () => {
    const c = cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1.5 })]);
    assert.deepEqual(D.clipStarts(c), [0, 3.5]);
    near(D.mainLength(c), 6.5);
    near(D.filmLength(c), 6.5);
    assert.deepEqual(D.v1Gaps(c), [{ i: 1, start: 2, length: 1.5 }]);
    assert.equal(D.gapAt(c, 2.5), 1);
    assert.equal(D.gapAt(c, 1), -1);
    assert.equal(D.playAt(c, 2.5), null);                      // nothing of the cut plays in a gap
    const pic = D.pictureAt(c, 2.5);
    assert.equal(pic.clip, null);                               // black
    near(pic.end, 3.5);                                         // until the clip after it begins
    assert.equal(D.pictureAt(c, 3.6).clip.file, "b.mp4");
    near(D.playAt(c, 1).end, 2);                                // the clip before ends at its own end
    assert.equal(D.layoutCut(c).gaps.length, 1);
    assert.ok(D.editPoints(c).includes(3.5));
});

test("no dissolve into a gap: a clip after one comes in with a cut", () => {
    const c = D.setTransition(cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 })]), 1, 0.5);
    assert.equal(c.clips[1].transition, 0);
    const moved = D.trimEnd(cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1, transition: 0.5 })]), 0, 2);
    assert.equal(moved.clips[1].transition, 0);
});

test("Del lifts: on V1 a gap stays and the clips after it do not move; Shift+Del ripples", () => {
    const c = abc();
    const lifted = D.liftClip(c, { kind: "clip", i: 1 });
    assert.equal(lifted.clips.length, 2);
    assert.deepEqual(D.clipStarts(lifted), [0, 5]);            // c stays at 5
    near(lifted.clips[1].gap, 3);
    const rippled = D.rippleDelete(c, { kind: "clip", i: 1 });
    assert.deepEqual(D.clipStarts(rippled), [0, 2]);
    // A selected gap is closed by either.
    assert.deepEqual(D.clipStarts(D.liftClip(lifted, { kind: "gap", i: 1 })), [0, 2]);
    assert.deepEqual(D.clipStarts(D.rippleDelete(lifted, { kind: "gap", i: 1 })), [0, 2]);
    // Ripple-deleting a clip after a gap keeps the gap before it.
    const g = cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 }), shot("c.mp4", 4)]);
    const r = D.rippleDelete(g, { kind: "clip", i: 1 });
    assert.deepEqual(D.clipStarts(r), [0, 3]);
});

test("a V1 clip moved to V2 leaves a gap: the clips after it stay in place (Ctrl+Shift: they close up)", () => {
    const c = abc();
    const got = D.transferClip(c, { kind: "clip", i: 1 }, "V2", 2);
    assert.deepEqual(got.sel, { kind: "tclip", track: "V2", i: 0 });
    assert.deepEqual(D.clipStarts(got.cut), [0, 5]);
    near(D.trackOf(got.cut, "V2").clips[0].at, 2);
    near(D.filmLength(got.cut), 9);
    const ripple = D.transferClip(c, { kind: "clip", i: 1 }, "V2", 2, { ripple: true });
    assert.deepEqual(D.clipStarts(ripple.cut), [0, 2]);
    // And back onto V1 into its gap: an overwrite at that moment.
    const back = D.transferClip(got.cut, got.sel, "V1", 2);
    assert.deepEqual(D.clipStarts(back.cut), [0, 2, 5]);
    assert.equal(back.cut.clips[1].file, "b.mp4");
    assert.ok(!back.cut.clips[2].gap);
});

test("Selection mode: a shot moved on V1 lies over what is there and leaves a gap (an overwrite)", () => {
    const c = abc();
    // b (2..5) moved to 6: it covers c (5..9) from 6 to 9 - c is cut to 5..6, nothing after moves.
    const got = D.moveShot(c, 1, 6);
    assert.deepEqual(D.clipStarts(got.cut), [0, 5, 6]);
    assert.deepEqual(got.cut.clips.map((x) => x.file), ["a.mp4", "c.mp4", "b.mp4"]);
    near(got.cut.clips[1].gap, 3);                              // where b was
    near(got.cut.clips[1].length, 1);
    assert.equal(got.i, 2);
    // Inside a clip: it is cut in two around the moved one; the tail plays on from where it was.
    const inside = D.moveShot(cutOf([shot("a.mp4", 2), shot("b.mp4", 1), shot("c.mp4", 6)]), 1, 4);
    assert.deepEqual(inside.cut.clips.map((x) => [x.file, x.in, x.length]), [["a.mp4", 0, 2], ["c.mp4", 0, 1], ["b.mp4", 0, 1], ["c.mp4", 2, 4]]);
    assert.deepEqual(D.clipStarts(inside.cut), [0, 3, 4, 5]);
    // The only shot: just a gap before it.
    const one = D.moveShot(cutOf([shot("a.mp4", 2)]), 0, 1.5);
    near(D.clipStarts(one.cut)[0], 1.5);
    near(D.mainLength(one.cut), 3.5);
});

test("the insert (Ctrl+Shift+drag, drops on a clip) still ripples; a drop in a gap fills it from that moment", () => {
    const c = cutOf([shot("a.mp4", 2), shot("c.mp4", 4, { gap: 3 })]);
    const ins = D.insertClip(c, { file: "d.mp4", name: "d", length: 1 }, 1);
    assert.deepEqual(D.clipStarts(ins), [0, 5, 6]);             // the new clip goes after the gap, where c began
    const filled = D.insertAt(c, { file: "d.mp4", name: "d", length: 1 }, 3);
    assert.deepEqual(D.clipStarts(filled.cut), [0, 3, 5]);      // placed at 3, c stays at 5
    near(filled.cut.clips[1].gap, 1);
    near(filled.cut.clips[2].gap, 1);
    const over = D.insertAt(c, { file: "d.mp4", name: "d", length: 4 }, 3);
    assert.deepEqual(D.clipStarts(over.cut), [0, 3, 7]);        // longer than what is left of the gap: c pushed on
    const reorder = D.moveClip(cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 }), shot("c.mp4", 4)]), 2, 1);
    assert.deepEqual(reorder.clips.map((x) => x.file), ["a.mp4", "c.mp4", "b.mp4"]);
    assert.deepEqual(D.clipStarts(reorder), [0, 3, 7]);         // the gap stays before what is now second
});

test("Selection mode edges: a trim opens or fills a gap and never pushes the next clip", () => {
    const c = cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 }), shot("c.mp4", 4)]);
    const shorter = D.liftTrimEnd(c, 0, 1.5, DUR);
    assert.deepEqual(D.clipStarts(shorter), [0, 3, 6]);
    near(shorter.clips[1].gap, 1.5);
    const longer = D.liftTrimEnd(c, 0, 5, DUR);                 // only as far as the gap
    near(longer.clips[0].length, 3);
    assert.deepEqual(D.clipStarts(longer), [0, 3, 6]);
    assert.ok(!longer.clips[1].gap);
    const blocked = D.liftTrimEnd(c, 1, 4, DUR);                // b touches c: no room
    near(blocked.clips[1].length, 3);
    const head = D.liftTrimStart(c, 1, -2);                      // b's in only back over its gap (and its source: in 0)
    near(head.clips[1].length, 3);                              // its source has no frame before in 0
    const h2 = D.liftTrimStart(cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1, in: 4 })]), 1, -2);
    near(h2.clips[1].in, 3);
    near(h2.clips[1].length, 4);
    assert.deepEqual(D.clipStarts(h2), [0, 2]);
    const later = D.liftTrimStart(c, 2, 1);                      // c begins later: a gap opens before it
    assert.deepEqual(D.clipStarts(later), [0, 3, 7]);
    near(later.clips[2].in, 1);
});

test("Trim mode on V1 next to a gap: ripple keeps the gap, roll needs a cut, slide trades with the gap", () => {
    const c = cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1, in: 1 }), shot("c.mp4", 4, { in: 1 })]);
    const rip = D.trimEnd(c, 0, 2.5, DUR);
    assert.deepEqual(D.clipStarts(rip), [0, 3.5, 6.5]);         // the gap moves on, still 1
    const rin = D.trimStart(c, 1, 0.5);
    assert.deepEqual(D.clipStarts(rin), [0, 3, 5.5]);
    near(rin.clips[1].in, 1.5);
    assert.ok(D.sameCut(D.rollEdit(c, 1, 0.5, DUR), c));          // a gap is not a cut to roll
    const rolled = D.rollEdit(c, 2, 0.5, DUR);
    assert.deepEqual(D.clipStarts(rolled), [0, 3, 6.5]);
    near(D.mainLength(rolled), D.mainLength(c));
    const slid = D.slideClip(c, 1, -0.5, DUR);                   // into its gap: the gap shrinks, c begins earlier in its source
    assert.deepEqual(D.clipStarts(slid), [0, 2.5, 5.5]);
    near(slid.clips[1].gap, 0.5);
    near(slid.clips[2].in, 0.5);
    near(D.mainLength(slid), D.mainLength(c));
    const far = D.slideClip(c, 1, -5, DUR);                      // held by the gap
    near(D.clipStarts(far)[1], 2);
    const slip = D.slipClip(c, { kind: "clip", i: 1 }, 0.5, DUR);
    assert.deepEqual(D.clipStarts(slip), D.clipStarts(c));
    near(slip.clips[1].in, 1.5);
});

test("Trim mode on a track of placed clips: ripple moves what follows, roll and slide between touching clips", () => {
    const c = cutOf([shot("a.mp4", 9)], { tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [
        { file: "a.mp4", name: "x", in: 1, length: 2, at: 1 }, { file: "b.mp4", name: "y", in: 1, length: 2, at: 3 },
        { file: "c.mp4", name: "z", in: 0, length: 1, at: 7 }] }] });
    const ats = (cut) => D.trackOf(cut, "V2").clips.map((x) => x.at);
    assert.deepEqual(ats(D.rippleTrackEnd(c, "V2", 0, 3, DUR)), [1, 4, 8]);
    const rin = D.rippleTrackStart(c, "V2", 0, 0.5);
    assert.deepEqual(ats(rin), [1, 2.5, 6.5]);
    near(D.trackOf(rin, "V2").clips[0].in, 1.5);
    assert.deepEqual(D.touching(c, "V2", 0), { before: -1, after: 1 });
    const roll = D.rollTrack(c, "V2", 0, 1, 0.5, DUR);
    assert.deepEqual(ats(roll), [1, 3.5, 7]);
    near(D.trackOf(roll, "V2").clips[0].length, 2.5);
    const slide = D.slideTrackClip(c, "V2", 1, 1, DUR);          // y slides on: x gives it room, the empty time after it takes
    assert.deepEqual(ats(slide), [1, 4, 7]);
    near(D.trackOf(slide, "V2").clips[0].length, 3);
    const held = D.slideTrackClip(c, "V2", 1, 9, DUR);           // up to z
    near(D.trackOf(held, "V2").clips[1].at, 5);
});

test("the auto edits count gaps; a split's second half has none", () => {
    const c = cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 }), shot("c.mp4", 4)]);
    const snapped = D.snapCutsToBeats(c, [6.2], { within: 0.5, durations: DUR });   // b's end is at 6
    near(snapped.clips[1].length, 3.2);
    const split = D.splitClip(c, { kind: "clip", i: 1 }, 4);
    assert.deepEqual(D.clipStarts(split.cut), [0, 3, 4, 6]);
    assert.ok(!split.cut.clips[2].gap);
    near(split.cut.clips[1].gap, 1);
});

test("gaps are saved and compared", () => {
    const c = cutOf([shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 })]);
    assert.equal(D.toSave(c).clips[1].gap, 1);
    assert.equal(D.toSave(c).clips[0].gap, 0);
    assert.ok(!D.sameCut(c, D.closeGap(c, 1)));
    assert.ok(D.agentLoses(c).some((x) => /gaps/.test(x)));
});

// ── picture and sound apart ──

test("unlink: the sound becomes a clip of its own on A2 (or the next free track), the film is muted", () => {
    const c = abc();
    const got = D.unlinkClip(c, { kind: "clip", i: 1 });
    assert.deepEqual(got.sel, { kind: "tclip", track: "A2", i: 0 });
    const v = got.cut.clips[1], a = D.trackOf(got.cut, "A2").clips[0];
    assert.equal(v.mute, true);
    assert.equal(a.file, "b.mp4");
    assert.deepEqual([a.at, a.in, a.length], [2, 0, 3]);
    assert.equal(v.link, a.link);
    assert.ok(v.unlinked && a.unlinked);
    assert.equal(D.clipVolume(v), 0);
    assert.equal(D.clipVolume(a), 1);
    // The sound of another film at the same moment: A2 is taken there, so a new track.
    const both = D.unlinkClip(D.moveShot(got.cut, 0, 2).cut, { kind: "clip", i: D.moveShot(got.cut, 0, 2).i });
    assert.ok(both);
    // A still has no sound to unlink; a sound clip is no film.
    assert.equal(D.unlinkClip(cutOf([shot("p.png", 3)]), { kind: "clip", i: 0 }), null);
    assert.equal(D.unlinkClip(got.cut, got.sel), null);
    // Saved: link, unlinked, mute always stated.
    const saved = D.toSave(got.cut);
    assert.deepEqual([saved.clips[1].link, saved.clips[1].unlinked, saved.clips[1].mute], [v.link, true, true]);
    assert.equal(saved.tracks[1].clips[0].link, v.link);
});

test("the sound clip moved and trimmed on its own: a J cut and an L cut; the picture stays", () => {
    const got = D.unlinkClip(abc(), { kind: "clip", i: 1 });
    const j = D.moveTrackClip(got.cut, "A2", 0, 1.5);                       // the sound comes in half a second early
    const jl = D.trimTrackClipEnd(j, "A2", 0, 4.5, DUR);                     // and runs on a second past the picture
    const a = D.trackOf(jl, "A2").clips[0];
    assert.deepEqual([a.at, a.length], [1.5, 4.5]);
    assert.deepEqual(D.clipStarts(jl), D.clipStarts(got.cut));
    assert.equal(jl.clips[1].length, 3);
    // Unlinked: following does nothing.
    assert.equal(D.followLink(got.cut, j, { kind: "tclip", track: "A2", i: 0 }), j);
    // Deleted on its own, the picture stays (still muted).
    const gone = D.liftClip(jl, { kind: "tclip", track: "A2", i: 0 });
    assert.equal(gone.clips.length, 3);
    assert.equal(D.deleteWithLink(jl, { kind: "tclip", track: "A2", i: 0 }, false).clips.length, 3);
});

test("link clips: the pair moves, trims, splits and goes together again", () => {
    const un = D.unlinkClip(abc(), { kind: "clip", i: 1 });
    const off = D.moveTrackClip(un.cut, "A2", 0, 1.5);
    const linked = D.linkClips(off, { kind: "clip", i: 1 }, { kind: "tclip", track: "A2", i: 0 }).cut;
    assert.ok(!linked.clips[1].unlinked && linked.clips[1].link);
    assert.deepEqual(D.linkPartner(linked, { kind: "clip", i: 1 }), { kind: "tclip", track: "A2", i: 0 });
    // Not a pair: two pictures, or different files.
    assert.equal(D.linkClips(off, { kind: "clip", i: 0 }, { kind: "tclip", track: "A2", i: 0 }), null);
    // The picture moved on V1: its sound moves by as much, the J cut kept.
    const moved = D.moveShot(linked, 1, 6);
    const follow = D.followLink(linked, moved.cut, { kind: "clip", i: 1 });
    near(D.trackOf(follow, "A2").clips[0].at, 5.5);
    // The picture's out trimmed by a ripple: the sound's out too, and what follows it on A2 moves on.
    const two = D.placeClip(linked, "A2", { file: "d.mp4", name: "d", length: 1 }, 6);
    const rip = D.followLink(two, D.trimEnd(two, 1, 3.5, DUR), { kind: "clip", i: 1 }, { ripple: true });
    const a2 = D.trackOf(rip, "A2").clips;
    near(a2[0].length, 3.5);
    near(a2[1].at, 6.5);
    // The blade cuts both, each pair of halves a link group of its own.
    const cut = D.splitWithLink(linked, { kind: "clip", i: 1 }, 4);
    const halves = D.trackOf(cut.cut, "A2").clips;
    assert.equal(halves.length, 2);
    assert.equal(cut.cut.clips[2].link, halves[1].link);
    assert.notEqual(cut.cut.clips[1].link, cut.cut.clips[2].link);
    // Deleted together.
    const del = D.deleteWithLink(linked, { kind: "clip", i: 1 }, false);
    assert.equal(D.trackOf(del, "A2").clips.length, 0);
    assert.deepEqual(D.clipStarts(del), [0, 5]);
    // Ctrl+Alt+L on a linked pair unlinks it again.
    const again = D.unlinkClip(linked, { kind: "clip", i: 1 });
    assert.ok(again.cut.clips[1].unlinked);
    assert.equal(D.trackOf(again.cut, "A2").clips.length, 1);
});

test("every operation is one undo step: the cut before it comes back whole", () => {
    let h = D.emptyHistory();
    let cut = abc();
    const steps = [(c) => D.unlinkClip(c, { kind: "clip", i: 1 }).cut, (c) => D.liftClip(c, { kind: "clip", i: 0 }),
                   (c) => D.moveTrackClip(c, "A2", 0, 1), (c) => D.closeGap(c, 0)];
    const seen = [cut];
    for (const step of steps) { const next = step(cut); h = D.historyPush(h, cut); cut = next; seen.push(cut); }
    for (let k = steps.length - 1; k >= 0; k--) {
        const got = D.historyUndo(h, cut);
        h = got.history; cut = got.cut;
        assert.ok(D.sameCut(cut, seen[k]));
    }
});
