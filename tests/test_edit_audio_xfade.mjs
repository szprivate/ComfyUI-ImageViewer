// Audio crossfades and fades, and the tracks' Lock / Auto Track Selector: the data module's arithmetic.
// Run: node --test tests/test_edit_audio_xfade.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

// V1: two films that meet (with handles), a sound track of two touching clips, a picture track.
const CUT = () => ({
    name: "t", fps: 24,
    clips: [{ file: "a.mp4", name: "a", in: 1, length: 4, transition: 0, volume: 1 },
            { file: "b.mp4", name: "b", in: 2, length: 4, transition: 0, volume: 1 }],
    texts: [{ text: "hi", start: 6, length: 1 }], sound: [{ name: "bed", file: "bed.wav" }],
    tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "o.mp4", name: "o", in: 0, length: 1, at: 5 }] },
             { id: "A2", kind: "audio", name: "A2", off: false,
               clips: [{ file: "s.wav", name: "s", in: 3, length: 2, at: 1 }, { file: "t.wav", name: "t", in: 1, length: 3, at: 3 }] }],
    off: {},
});
const DUR = { "a.mp4": 10, "b.mp4": 10, "s.wav": 10, "t.wav": 10 };

test("the three curves: 0 dB straight, +3 dB equal power, -3 dB x^1.5 - and their middles", () => {
    near(D.curveGain("0", 0.5), 0.5);
    near(D.curveGain("+3", 0.5), Math.SQRT1_2);
    near(D.curveGain("-3", 0.5), Math.pow(0.5, 1.5));
    for (const c of ["0", "+3", "-3"]) { near(D.curveGain(c, 0), 0); near(D.curveGain(c, 1), 1); }
    // +3 dB is equal power: the squares of the two sides add up to one all the way.
    for (let p = 0; p <= 1; p += 0.1) near(D.curveGain("+3", p) ** 2 + D.curveGain("+3", 1 - p) ** 2, 1);
    // 0 dB: the two gains add up to one.
    for (let p = 0; p <= 1; p += 0.1) near(D.curveGain("0", p) + D.curveGain("0", 1 - p), 1);
});

test("a crossfade at a V1 cut and at a sound-track cut: centred, moves nothing, its handles heard", () => {
    const got = D.addAudioXfade(CUT(), { kind: "clip", i: 1 }, { len: 1 }, DUR);
    assert.ok(got.cut, got.error);
    assert.deepEqual(got.sel, { kind: "xfade", track: "V1", i: 1 });
    assert.deepEqual(got.cut.clips[1].xfade, { len: 1, curve: "+3", align: "centre" });
    assert.deepEqual(D.clipStarts(got.cut), [0, 4]);          // nothing moved
    const env = D.audioEnv(got.cut, { kind: "clip", i: 1 });
    assert.deepEqual(env.xin, { b: 0.5, a: 0.5, curve: "+3" });
    const out = D.audioEnv(got.cut, { kind: "clip", i: 0 });
    assert.deepEqual(out.xout, { b: 0.5, a: 0.5, curve: "+3" });
    near(D.envGain(env, 0), Math.SQRT1_2);                     // at the cut: half way
    near(D.envGain(out, 4), Math.SQRT1_2);
    near(D.envGain(env, -0.5), 0); near(D.envGain(env, 0.5), 1); near(D.envGain(env, -0.6), 0);
    near(D.envGain(out, 4.5), 0); near(D.envGain(out, 3.5), 1);
    // The handles are heard from <audio>: the incoming before the cut, the outgoing after it.
    const h = D.soundItems(got.cut).filter((s) => s.handle);
    assert.deepEqual(h.map((s) => [s.handle, s.file, s.at, s.length, s.origin]), [["in", "b.mp4", 3.5, 0.5, 4], ["out", "a.mp4", 4, 0.5, 0]]);
    near(D.srcAt(got.cut.clips[1], -0.5), 1.5);
    // On A2: the second clip's sound starts half a second early, the first one's runs half a second on.
    const a2 = D.addAudioXfade(got.cut, { kind: "tclip", track: "A2", i: 1 }, { len: 1, curve: "0", align: "start" }, DUR).cut;
    const items = D.soundItems(a2).filter((s) => s.track === "A2");
    assert.deepEqual(items.map((s) => [s.at, s.length, s.origin]), [[1, 3, 1], [3, 3, 3]]);
    near(D.envGain(items[0].env, 2.5), 0.5);                   // "start": the clip going out runs on past its end
});

test("not enough media: shorter, the other side, or none", () => {
    const cut = CUT();
    cut.clips[1].in = 0.2;                                     // 0.2 s before the incoming's in
    const got = D.addAudioXfade(cut, { kind: "clip", i: 1 }, { len: 2 }, DUR);
    assert.deepEqual(got.cut.clips[1].xfade, { len: 0.4, curve: "+3", align: "centre" });
    assert.equal(got.fitted, true);
    cut.clips[1].in = 0;                                       // none before: it goes after the cut
    const g2 = D.addAudioXfade(cut, { kind: "clip", i: 1 }, { len: 2 }, DUR);
    assert.equal(g2.cut.clips[1].xfade.align, "start");
    assert.equal(g2.cut.clips[1].xfade.len, 2);
    const none = { ...DUR, "a.mp4": 5 };                       // a ends with its file (1 + 4 = 5)
    assert.ok(D.addAudioXfade(cut, { kind: "clip", i: 1 }, { len: 2 }, none).error);
    // No crossfade where a dissolve already crosses the sound, before a gap, or between clips that do not meet.
    const mix = D.setTransition(CUT(), 1, 1);
    assert.match(D.addAudioXfade(mix, { kind: "clip", i: 1 }, {}, DUR).error, /dissolve/);
    assert.ok(D.addAudioXfade(CUT(), { kind: "tclip", track: "A2", i: 0 }, {}, DUR).error);
});

test("a crossfade goes when its clips no longer meet; a fade takes its side's place and the other way round", () => {
    const cut = D.addAudioXfade(CUT(), { kind: "tclip", track: "A2", i: 1 }, {}, DUR).cut;
    const moved = D.moveTrackClip(cut, "A2", 1, 3.5);
    assert.equal(moved.tracks[1].clips[1].xfade, undefined);
    const faded = D.setFade(cut, { kind: "tclip", track: "A2", i: 0 }, "out", 0.5);
    assert.equal(faded.tracks[1].clips[1].xfade, undefined);
    assert.equal(faded.tracks[1].clips[0].fadeOut, 0.5);
    const again = D.addAudioXfade(faded, { kind: "tclip", track: "A2", i: 1 }, {}, DUR).cut;
    assert.equal(again.tracks[1].clips[0].fadeOut, undefined);
    assert.ok(D.removeAudioXfade(again, { kind: "xfade", track: "A2", i: 1 }).tracks[1].clips[1].xfade === undefined);
});

test("fades: straight lines of gain, held to the clip; the bed's over the whole film; saved and compared", () => {
    let cut = D.setFade(CUT(), { kind: "clip", i: 0 }, "in", 1);
    cut = D.setFade(cut, { kind: "clip", i: 0 }, "out", 5);   // more than is left: the two shared out
    const c = cut.clips[0];
    near(c.fadeIn + c.fadeOut, 4);
    const env = D.audioEnv(cut, { kind: "clip", i: 0 });
    near(D.envGain(env, 0), 0); near(D.envGain(env, c.fadeIn / 2), 0.5); near(D.envGain(env, 4), 0);
    assert.equal(D.sameCut(cut, CUT()), false);
    const s = D.toSave(cut).clips[0];
    near(s.fadeIn, c.fadeIn); assert.equal(s.xfade, null);
    const bed = D.setFade(CUT(), { kind: "sound", i: 0 }, "out", 2);
    const item = D.soundItems(bed).find((x) => x.file === "bed.wav");
    near(D.envGain(item.env, D.filmLength(bed) - 1), 0.5);
    assert.equal(D.toSave(bed).sound[0].fadeOut, 2);
});

test("lock: the flags, saved and undone with the cut; an edit that changes a locked track is found out", () => {
    let cut = D.setTrackFlag(CUT(), "A2", "lock", true);
    cut = D.setTrackFlag(cut, "V1", "auto", false);
    assert.deepEqual(D.trackFlags(cut, "A2"), { lock: true, auto: true });
    assert.deepEqual(D.trackFlags(cut, "V1"), { lock: false, auto: false });
    assert.equal(D.sameCut(cut, CUT()), false);
    const saved = D.toSave(cut);
    assert.equal(saved.tracks[1].lock, true); assert.equal(saved.auto.V1, false);
    assert.equal(D.editMask(cut).has("A2"), false);
    assert.equal(D.lockViolation(cut, D.moveTrackClip(cut, "A2", 0, 0)), "A2");
    assert.equal(D.lockViolation(cut, D.moveTrackClip(cut, "V2", 0, 1)), "");
    assert.equal(D.lockViolation(cut, D.removeTrack(cut, "A2")), "A2");
    // Delete skips what is on a locked track.
    const del = D.deleteSelection(cut, [{ kind: "tclip", track: "A2", i: 0 }, { kind: "tclip", track: "V2", i: 0 }], false).cut;
    assert.equal(del.tracks[1].clips.length, 2);
    assert.equal(del.tracks[0].clips.length, 0);
    assert.deepEqual(D.unlockedSel(cut, [{ kind: "tclip", track: "A2", i: 0 }, { kind: "clip", i: 0 }]), [{ kind: "clip", i: 0 }]);
});

test("auto track selector: a V1 ripple delete moves what follows on the selected tracks only", () => {
    const all = D.deleteSelection(CUT(), [{ kind: "clip", i: 0 }], true, D.editMask(CUT())).cut;
    // a (4 s) went: V2's clip at 5 moves to 1, A2's clips at 1 and 3 began before its end - the one at 3... at 3 < 4: stays.
    assert.deepEqual(all.tracks[0].clips.map((c) => c.at), [1]);
    assert.deepEqual(all.tracks[1].clips.map((c) => c.at), [1, 3]);
    assert.equal(all.texts[0].start, 2);
    const cut = D.setTrackFlag(CUT(), "V2", "auto", false);
    const some = D.deleteSelection(cut, [{ kind: "clip", i: 0 }], true, D.editMask(cut)).cut;
    assert.deepEqual(some.tracks[0].clips.map((c) => c.at), [5]);
    // A move back stops at a clip of the track that stays.
    const c2 = CUT(); c2.tracks[1].clips[1].at = 4.5;
    const held = D.rippleTracks(c2, 4, -4, new Set(["A2"]));
    assert.deepEqual(held.tracks[1].clips.map((c) => c.at), [1, 3]);
});

test("auto track selector: an insert, the blade at the playhead and Up / Down leave the tracks that are off alone", () => {
    const cut = D.setTrackFlag(CUT(), "A2", "auto", false);
    const got = D.insertEdit(cut, [{ file: "n.mp4", length: 2 }], 2, "V1", D.editMask(cut));
    assert.deepEqual(got.cut.tracks[1].clips.map((c) => c.at), [1, 3]);
    assert.deepEqual(got.cut.tracks[0].clips.map((c) => c.at), [7]);
    const cut2 = D.setTrackFlag(CUT(), "A2", "auto", false);
    const split = D.splitAt(cut2, 3.5, null, D.editMask(cut2));
    assert.equal(split.cut.tracks[1].clips.length, 2);       // A2 not cut
    assert.equal(split.cut.clips.length, 3);                  // V1 cut
    const locked = D.setTrackFlag(CUT(), "V1", "lock", true);
    const s2 = D.splitAt(locked, 3.5, null, D.editMask(locked));
    assert.equal(s2.cut.clips.length, 2);
    assert.ok(!D.editPoints(cut2, D.editMask(cut2)).includes(1));    // A2 clip start at 1 is not stepped to
    assert.ok(D.editPoints(cut2).includes(1));
});

test("a V1 ripple trim takes the selected tracks along (rippleV1Follow)", () => {
    const cut = CUT();
    const after = D.trimEnd(cut, 0, 3, DUR);
    const moved = D.rippleV1Follow(cut, after, 0, D.editMask(cut));
    assert.deepEqual(moved.tracks[0].clips.map((c) => c.at), [4]);
    assert.equal(moved.texts[0].start, 5);
});

test("title clips: a locked title track takes no edit, an auto-select-off one is not rippled or cut", () => {
    let cut = D.addTitle(CUT(), { text: "Hello" }, 6, 2, "V2").cut;
    const k = cut.tracks.find((t) => t.id === "V2");
    const ti = k.clips.findIndex((c) => c.title);
    assert.ok(ti >= 0);
    const locked = D.setTrackFlag(cut, "V2", "lock", true);
    assert.equal(D.lockViolation(locked, D.moveTrackClip(locked, "V2", ti, 1)), "V2");
    const del = D.deleteSelection(locked, [{ kind: "tclip", track: "V2", i: ti }], false).cut;
    assert.ok(del.tracks.find((t) => t.id === "V2").clips.some((c) => c.title));
    const off = D.setTrackFlag(cut, "V2", "auto", false);
    const rip = D.deleteSelection(off, [{ kind: "clip", i: 0 }], true, D.editMask(off)).cut;
    assert.equal(rip.tracks.find((t) => t.id === "V2").clips[ti].at, 6);
    const on = D.deleteSelection(cut, [{ kind: "clip", i: 0 }], true, D.editMask(cut)).cut;
    assert.equal(on.tracks.find((t) => t.id === "V2").clips[ti].at, 2);
    const split = D.splitAt(off, 6.5, null, D.editMask(off));
    assert.equal((split ? split.cut : off).tracks.find((t) => t.id === "V2").clips.filter((c) => c.title).length, 1);
});

// ── the volume line ──

const SND = () => ({ ...CUT(), tracks: [{ id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "s.wav", name: "s", in: 0, length: 4, at: 0, volume: 0.5 }] }] });
const A2 = { kind: "tclip", track: "A2", i: 0 };

test("the volume line's scale: dB, from 0 at the top to -60 at the bottom, and back", () => {
    near(D.volY(1), 0); near(D.volY(D.dbVol(-30)), 0.5); assert.equal(D.volY(0), 1);
    for (const y of [0, 0.1, 0.5, 0.9]) near(D.volY(D.yVol(y)), y, 1e-9);
    assert.equal(D.dbLabel(0.5), "-6.0 dB");
    assert.equal(D.dbLabel(0), "-inf dB");
});

test("a flat line is the clip's volume; its points are the Inspector's volume keys", () => {
    assert.deepEqual(D.volLine(SND().tracks[0].clips[0], 4), [{ u: 0, v: 0.5 }, { u: 4, v: 0.5 }]);
    let cut = D.setVolLine(SND(), A2, 0.25, 1);
    assert.equal(D.clipOf(cut, A2).volume, 0.25);
    cut = D.addVolPoint(cut, A2, 1);                      // Alt+click: a key, at the line's level
    cut = D.addVolPoint(cut, A2, 3);
    assert.deepEqual(D.keysOf(D.clipOf(cut, A2), "vol"), [{ t: 1, v: 0.25 }, { t: 3, v: 0.25 }]);
    // Moved in time and level: the same key the Inspector's diamonds see.
    cut = D.moveVolPoint(cut, A2, 3, 2.5, 1);
    assert.deepEqual(D.keysOf(D.clipOf(cut, A2), "vol"), [{ t: 1, v: 0.25 }, { t: 2.5, v: 1 }]);
    assert.ok(D.keyedAt(D.clipOf(cut, A2), ["vol"], 2.5));
    // Held between its neighbours.
    cut = D.moveVolPoint(cut, A2, 2.5, 0.5, 1);
    assert.ok(D.keysOf(D.clipOf(cut, A2), "vol")[1].t > 1);
    // The ease of a key shapes the line between it and the next (setKeyInterp, the Inspector's right-click).
    const eased = D.setKeyInterp(cut, A2, ["vol"], 1, "hold");
    const line = D.volLine(D.clipOf(eased, A2), 4);
    assert.ok(line.filter((p) => p.u > 1 && p.u < D.keysOf(D.clipOf(eased, A2), "vol")[1].t).every((p) => Math.abs(p.v - 0.25) < 1e-9));
    // The line dragged with points: every point by the same dB.
    const up = D.setVolLine(cut, A2, 0.5, 1);
    const ks = D.keysOf(D.clipOf(up, A2), "vol");
    near(ks[0].v, 0.5); near(ks[1].v, 1);                 // +6 dB, held at 0 dB
    // Removed (Del / Alt+click): the last one gone, the clip has its number again.
    let gone = D.removeVolPoint(D.removeVolPoint(cut, A2, 1), A2, ks[1].t);
    assert.equal(D.keysOf(D.clipOf(gone, A2), "vol").length, 0);
    assert.equal(D.paramAt(D.clipOf(gone, A2), "vol", 2), 0.25);
});

test("the volume line, fades and crossfades multiply", () => {
    let cut = D.addVolPoint(D.setVolLine(SND(), A2, 0.5, 0), A2, 0);
    cut = D.setFade(cut, A2, "in", 2);
    const c = D.clipOf(cut, A2);
    near(D.clipVolume(c, 1) * D.envGain(D.audioEnv(cut, A2), 1), 0.25);
});
