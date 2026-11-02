// node --test tests/test_edit_insert_zoom_scrub.mjs
// The insert edit at the playhead, the zoom about the playhead, the scrub grains and the trim two-up
// (bEpicViewer_editTimelineData.js, bEpicViewer_editAudio.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/bEpicViewer_editTimelineData.js";
import { SCRUB, scrubRate, planGrain, scrubSources, fillGrain, srcAt } from "../js/bEpicViewer_editAudio.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const base = () => ({ ...D.emptyCut("t"), clips: [shot("a.mp4", 4), shot("b.mp4", 4, { in: 1 })],
    texts: [{ text: "late", start: 6, length: 1 }, { text: "early", start: 1, length: 1 }],
    tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "o.mp4", name: "o", in: 0, length: 1, at: 5 }, { file: "p.mp4", name: "p", in: 0, length: 1, at: 0.5 }] },
             { id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "s.wav", name: "s", in: 0, length: 2, at: 4.5 }] }] });
const v1 = (cut) => cut.clips.map((c) => [c.file, c.in, c.length, c.gap || 0]);

// ── the insert ──

test("an insert inside a shot splits it and goes between the halves; what follows ripples; order kept", () => {
    const got = D.insertEdit(base(), [shot("n1.mp4", 1), shot("n2.png", 2)], 2.5);
    assert.equal(got.split, true);
    assert.deepEqual(v1(got.cut), [["a.mp4", 0, 2.5, 0], ["n1.mp4", 0, 1, 0], ["n2.png", 0, 2, 0], ["a.mp4", 2.5, 1.5, 0], ["b.mp4", 1, 4, 0]]);
    assert.equal(D.mainLength(got.cut), 11);
    assert.deepEqual(got.sel, { kind: "clip", i: 2 });
    assert.equal(got.end, 5.5);
    // The other tracks move on from the playhead: the overlay at 5 and the sound at 4.5 by 3 s, the one at 0.5 stays.
    assert.deepEqual(got.cut.tracks[0].clips.map((c) => c.at), [8, 0.5]);
    assert.deepEqual(got.cut.tracks[1].clips.map((c) => c.at), [7.5]);
    assert.deepEqual(got.cut.texts.map((x) => x.start), [9, 1]);
});

test("at a cut it goes in at that cut, no split; at 0 before everything; past the end with a gap", () => {
    const at = D.insertEdit(base(), [shot("n.mp4", 1)], 4);
    assert.equal(at.split, false);
    assert.deepEqual(v1(at.cut).map((x) => x[0]), ["a.mp4", "n.mp4", "b.mp4"]);
    assert.equal(at.end, 5);
    const zero = D.insertEdit(base(), [shot("n.mp4", 1)], 0);
    assert.deepEqual(v1(zero.cut).map((x) => x[0]), ["n.mp4", "a.mp4", "b.mp4"]);
    const past = D.insertEdit(base(), [shot("n.mp4", 1)], 10);
    assert.deepEqual(v1(past.cut).at(-1), ["n.mp4", 0, 1, 2]);
    assert.equal(past.end, 11);
});

test("in a gap it begins at that moment and the rest of the gap stays after it; a refused split goes to the nearer end", () => {
    const cut = { ...base(), clips: [shot("a.mp4", 2), shot("b.mp4", 2, { gap: 2 })] };
    const got = D.insertEdit(cut, [shot("n.mp4", 1)], 2.5);
    assert.deepEqual(v1(got.cut), [["a.mp4", 0, 2, 0], ["n.mp4", 0, 1, 0.5], ["b.mp4", 0, 2, 1.5]]);
    assert.equal(D.clipStarts(got.cut)[2], 5);      // b moved on by the inserted second
    // 1 frame from the end of a: no split, in after it.
    const near = D.insertEdit(base(), [shot("n.mp4", 1)], 4 - 1 / 24);
    assert.equal(near.split, false);
    assert.deepEqual(v1(near.cut).map((x) => x[0]), ["a.mp4", "n.mp4", "b.mp4"]);
});

test("a linked film is split with its sound; on a placed track only that track ripples", () => {
    const cut = { ...base(), clips: [shot("a.mp4", 4, { link: "L1", mute: true }), shot("b.mp4", 4)],
        tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "o.mp4", name: "o", in: 0, length: 4, at: 1 }] },
                 { id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "a.mp4", name: "a", in: 0, length: 4, at: 0, link: "L1" }] }] };
    const got = D.insertEdit(cut, [shot("n.mp4", 1)], 2);
    assert.deepEqual(got.cut.tracks[1].clips.map((c) => [c.at, c.in, c.length]), [[0, 0, 2], [3, 2, 2]]);
    const tr = D.insertEdit(cut, [shot("n.mp4", 1), shot("m.mp4", 1)], 2, "V2");
    assert.deepEqual(tr.cut.tracks[0].clips.map((c) => [c.file, c.at, c.length]), [["o.mp4", 1, 1], ["o.mp4", 4, 3], ["n.mp4", 2, 1], ["m.mp4", 3, 1]]);
    assert.deepEqual(v1(tr.cut), v1(cut), "V1 stays");
    assert.equal(tr.end, 4);
});

test("canvas nodes in the order of their place on the canvas", () => {
    const nodes = [{ id: 3, pos: [500, 0] }, { id: 1, pos: [100, 50] }, { id: 2, pos: [100, 10] }];
    assert.deepEqual(D.canvasOrder(nodes).map((n) => n.id), [2, 1, 3]);
});

// ── zoom about the playhead ──

test("the playhead keeps its screen x across a zoom; off screen it is centred", () => {
    const t = 6, span = 12, view = 800;
    const before = { span, width: 1600, scroll: 300 };       // x = 6/12*1600 - 300 = 500
    const got = D.zoomScroll(t, before, { span, width: 2400 }, view);
    assert.equal(got.centred, false);
    assert.equal(Math.round((t / span) * 2400 - got.scroll), 500);
    const off = D.zoomScroll(t, { span, width: 4800, scroll: 0 }, { span, width: 7200 }, view);
    assert.equal(off.centred, true);
    assert.equal(Math.round((t / span) * 7200 - off.scroll), view / 2);
    // Held to the strip: never scrolled before its start.
    const end = D.zoomScroll(0.1, { span, width: 2400, scroll: 100 }, { span, width: 1600 }, view);
    assert.equal(end.centred, true);
    assert.equal(end.scroll, 0);
});

// ── scrub grains ──

test("the rate follows the speed of the drag, clamped; still is silence; a first move is a step at rate 1", () => {
    assert.deepEqual(scrubRate(null, { t: 1, ms: 0 }), { rate: 1, dir: 1, step: true });
    assert.equal(scrubRate({ t: 1, ms: 0 }, { t: 1.02, ms: 20 }).rate, 1);
    assert.equal(scrubRate({ t: 1, ms: 0 }, { t: 1.2, ms: 20 }).rate, SCRUB.maxRate);
    assert.equal(scrubRate({ t: 1, ms: 0 }, { t: 1.001, ms: 20 }).rate, SCRUB.minRate);
    assert.equal(scrubRate({ t: 1, ms: 0 }, { t: 0.99, ms: 20 }).dir, -1);
    assert.equal(scrubRate({ t: 1, ms: 0 }, { t: 1, ms: 20 }), null);
    assert.equal(scrubRate({ t: 1, ms: 0 }, { t: 2, ms: 900 }).step, true, "long after: a new start");
});

test("a grain waits while the one before has more than its fade to run, else starts as it fades", () => {
    const p = planGrain({ t: 1, ms: 0 }, { t: 1.04, ms: 20 }, 0, 10);
    assert.equal(p.rate, 2);
    assert.ok(p.start >= 10);
    assert.equal(p.samples, Math.round(SCRUB.grain * 2 * SCRUB.sr));
    assert.equal(planGrain({ t: 1, ms: 0 }, { t: 1.04, ms: 20 }, 10.05, 10).wait, true);
    const q = planGrain({ t: 1, ms: 0 }, { t: 1.04, ms: 20 }, 10.02, 10);
    assert.ok(Math.abs(q.start - (10.02 - SCRUB.fade)) < 1e-9);
    assert.equal(planGrain({ t: 1, ms: 0 }, { t: 1, ms: 20 }, 0, 10), null);
});

test("the sources at the playhead: picture on top, mutes, sound tracks, the bed, off tracks, retime and loop", () => {
    const cut = { ...D.emptyCut("s"), clips: [shot("a.mp4", 4), shot("b.mp4", 4, { mute: true }), shot("c.png", 2)],
        sound: [{ name: "bed", file: "bed.wav" }],
        tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "o.mp4", name: "o", in: 2, length: 2, at: 1, speed: 2 }] },
                 { id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "s.wav", name: "s", in: 1, length: 3, at: 5, volume: 0.5, loop: "loop", span: 1 }] }] };
    const files = (t, live) => scrubSources(cut, t, live).map((s) => [s.file, s.gain]);
    assert.deepEqual(files(0.5), [["a.mp4", 1], ["bed.wav", 1]]);
    assert.deepEqual(files(1.5), [["o.mp4", 1], ["bed.wav", 1]], "the higher track covers V1's sound");
    assert.deepEqual(files(5.5), [["bed.wav", 1], ["s.wav", 0.5]], "a muted film is silent");
    assert.deepEqual(files(9), [["bed.wav", 1]], "a still has no sound");
    assert.deepEqual(files(0.5, D.liveTracks({ ...cut, off: { A1: true } }, {})), [["a.mp4", 1]]);
    const o = scrubSources(cut, 1.5).find((s) => s.file === "o.mp4");
    assert.equal(srcAt(o.clip, 1.5 - o.origin), 3, "retimed: 0.5 s in at 2x is 1 s of source past in=2");
    const s = scrubSources(cut, 6.75).find((x) => x.file === "s.wav");
    assert.equal(srcAt(s.clip, 6.75 - s.origin), 1.75, "looped: 1.75 s in, a 1 s turn, from in=1");
});

test("a grain reads the sources at their moments, forwards or backwards, at their gains, with fades", () => {
    const sr = 100;
    const ramp = { data: Float32Array.from({ length: 1000 }, (_, i) => i / 1000), rate: sr };
    const src = [{ file: "x", gain: 0.5, clip: { in: 2, length: 5 }, origin: 1, start: 1, end: 6 }];
    const fwd = fillGrain(10, src, 3, 1, sr, () => ramp, 0);
    assert.ok(Math.abs(fwd[0] - 0.5 * 0.4) < 1e-6);          // film 3 s = source 4 s = sample 400
    assert.ok(Math.abs(fwd[9] - 0.5 * 0.409) < 1e-6);
    const back = fillGrain(10, src, 3, -1, sr, () => ramp, 0);
    assert.ok(back[9] < back[0], "backwards the source runs backwards");
    const faded = fillGrain(10, src, 3, 1, sr, () => ramp, 3);
    assert.equal(faded[0], 0);
    assert.ok(faded[5] > 0);
    assert.equal(fillGrain(10, src, 0, 1, sr, () => ramp, 0)[0], 0, "before the clip begins: nothing");
    assert.equal(fillGrain(10, src, 3, 1, sr, () => null, 0)[0], 0, "not decoded yet: left out");
});

// ── the two-up ──

test("the two-up frames: roll, ripple out / in, slip, slide - with retime and loop", () => {
    const fps = 24;
    const cut = { ...D.emptyCut("u"), clips: [shot("a.mp4", 2, { in: 1 }), shot("b.mp4", 2, { in: 3, speed: 2 }), shot("c.mp4", 2, { loop: "loop", span: 0.5 })] };
    const roll = D.twoUpFrames(cut, { act: "roll", sel: { kind: "clip", i: 1 }, a: { kind: "clip", i: 0 }, b: { kind: "clip", i: 1 } }, fps);
    assert.equal(roll.left.frame, 47);                       // the last frame of a: film frame 47
    assert.equal(roll.left.srcFrame, 24 + 47);               // a starts at 1 s of its source
    assert.equal(roll.right.frame, 48);
    assert.equal(roll.right.srcFrame, 72 + 1);               // b at 2x: half a frame in is a frame of source past 3 s
    const out = D.twoUpFrames(cut, { act: "ripple-out", sel: { kind: "clip", i: 0 }, side: "end" }, fps);
    assert.equal(out.right.sel.i, 1);
    const inn = D.twoUpFrames(cut, { act: "ripple-in", sel: { kind: "clip", i: 2 }, side: "start" }, fps);
    assert.equal(inn.left.sel.i, 1);
    assert.equal(inn.right.srcFrame, 0);
    const loopEnd = D.edgeFrame(cut, { kind: "clip", i: 2 }, "last", fps);
    assert.equal(loopEnd.srcFrame, 11, "the last frame of a looped clip is the end of its 0.5 s turn");
    const slip = D.twoUpFrames(cut, { act: "slip", sel: { kind: "clip", i: 0 } }, fps);
    assert.equal(slip.left.frame, 0);
    assert.equal(slip.right.frame, 47);
    const slide = D.twoUpFrames(cut, { act: "slide", sel: { kind: "clip", i: 1 } }, fps);
    assert.deepEqual([slide.left.sel.i, slide.right.sel.i], [0, 2]);
    const first = D.twoUpFrames(cut, { act: "ripple-in", sel: { kind: "clip", i: 0 }, side: "start" }, fps);
    assert.equal(first.left, null);
});

// ── several clips moved together (Selection mode: over what is there) ──

const four = () => ({ ...D.emptyCut("g"), clips: [shot("a", 2), shot("b", 2), shot("c", 2), shot("d", 2)],
    tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "v", name: "v", in: 0, length: 2, at: 1 }] },
             { id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "s", name: "s", in: 0, length: 2, at: 6 }] }] });
const lay = (c) => ({ v1: c.clips.map((x, i) => [x.file, D.clipStarts(c)[i], x.length, x.in]),
                      tr: Object.fromEntries(c.tracks.map((k) => [k.id, k.clips.map((x) => [x.file, x.at, x.length])])) });

test("a group moved left passes the clip before it and lies over it; held only at 0", () => {
    const g = D.moveGroup(four(), [{ kind: "clip", i: 2 }, { kind: "clip", i: 3 }], -3);
    assert.deepEqual(lay(g.cut).v1, [["a", 0, 1, 0], ["c", 1, 2, 0], ["d", 3, 2, 0]]);       // b covered, a cut back
    assert.deepEqual(g.sel, [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }]);
    const held = D.moveGroup(four(), [{ kind: "clip", i: 2 }, { kind: "clip", i: 3 }], -10);
    assert.equal(held.delta, -4);
});

test("a group moved right leaves gaps and cuts what it falls on; the clips not moving stay put", () => {
    const g = D.moveGroup(four(), [{ kind: "clip", i: 0 }, { kind: "tclip", track: "A2", i: 0 }], 3);
    assert.deepEqual(lay(g.cut).v1, [["b", 2, 1, 0], ["a", 3, 2, 0], ["c", 5, 1, 1], ["d", 6, 2, 0]]);
    assert.deepEqual(lay(g.cut).tr.A2, [["s", 9, 2]]);
    const far = D.moveGroup(four(), [{ kind: "clip", i: 0 }, { kind: "clip", i: 1 }], 5);
    assert.deepEqual(lay(far.cut).v1.map((x) => [x[0], x[1]]), [["c", 4], ["a", 5], ["b", 7]]);   // c's head stays, d covered
});

test("a group moved by rows: pictures on video tracks (a new one past the top), sounds on sound tracks; a partner follows in time", () => {
    const up = D.moveGroup(four(), [{ kind: "clip", i: 1 }, { kind: "tclip", track: "V2", i: 0 }], 0, -1);
    assert.deepEqual(lay(up.cut).tr.V2, [["b", 2, 2]]);
    assert.deepEqual(lay(up.cut).tr.V3, [["v", 1, 2]]);
    assert.equal(up.rows, -1);
    const down = D.moveGroup(four(), [{ kind: "tclip", track: "A2", i: 0 }], 0, 1);
    assert.deepEqual(lay(down.cut).tr.A3, [["s", 6, 2]]);
    const low = D.moveGroup(four(), [{ kind: "clip", i: 1 }], 0, 3);
    assert.equal(low.rows, 0, "nothing below V1");
    const linked = { ...four(), clips: four().clips.map((c, i) => (i === 0 ? { ...c, link: "L1", mute: true } : c)),
        tracks: [four().tracks[0], { ...four().tracks[1], clips: [{ file: "a", name: "a", in: 0, length: 2, at: 0, link: "L1" }] }] };
    const g = D.moveGroup(linked, [{ kind: "clip", i: 0 }, { kind: "clip", i: 2 }], 1, -1);
    assert.deepEqual(lay(g.cut).tr.A2, [["a", 1, 2]], "the sound went along in time, on its own track");
});

test("a mixed group moved by rows: the pictures go, the sounds stay on sound tracks (and the other way round)", () => {
    const up = D.moveGroup(four(), [{ kind: "clip", i: 1 }, { kind: "tclip", track: "A2", i: 0 }], 0, -1);
    assert.deepEqual([up.rowsVideo, up.rowsAudio], [-1, 0]);
    assert.deepEqual(lay(up.cut).tr.V2.map((x) => x[0]).sort(), ["b", "v"]);
    assert.deepEqual(lay(up.cut).tr.A2, [["s", 6, 2]]);
    const down = D.moveGroup(four(), [{ kind: "clip", i: 1 }, { kind: "tclip", track: "A2", i: 0 }], 0, 1);
    assert.deepEqual([down.rowsVideo, down.rowsAudio], [0, 1]);
    assert.deepEqual(lay(down.cut).tr.A3, [["s", 6, 2]]);
    assert.equal(lay(down.cut).v1[1][0], "b");
});

// ── Shift+S / Shift+A: three steps per cut ──

test("Shift+S walks LEFT, BOTH, RIGHT through each cut and Shift+A back; the ends; from the playhead", () => {
    const cut = { ...D.emptyCut("e"), clips: [shot("a", 2), shot("b", 2), shot("c", 2, { gap: 1 })] };
    const steps = D.editSteps(D.editStops(cut, "V1"));
    // 0: a's in; 2: a | b; 4: b's out; 5: c's in; 7: c's out.
    assert.deepEqual(steps.map((s) => [s.t, s.state]),
        [[0, "right"], [2, "left"], [2, "both"], [2, "right"], [4, "left"], [5, "right"], [7, "left"]]);
    const walk = (dir, n, start = null, from = 0) => {
        let p = start, out = [];
        for (let k = 0; k < n; k++) {
            const s = D.nextEditStep(steps, p, from, dir, 24);
            if (!s) { out.push(null); break; }
            p = D.stepPoint(s);
            out.push([s.t, s.state, p.act]);
        }
        return out;
    };
    assert.deepEqual(walk(1, 4, null, 24), [[2, "left", "trim-out"], [2, "both", "roll"], [2, "right", "trim-in"], [4, "left", "trim-out"]]);
    assert.deepEqual(walk(-1, 4, null, 48), [[2, "right", "trim-in"], [2, "both", "roll"], [2, "left", "trim-out"], [0, "right", "trim-in"]]);
    // From the last step forwards: none; from the first backwards: none.
    assert.equal(D.nextEditStep(steps, D.stepPoint(steps[steps.length - 1]), 0, 1, 24), null);
    assert.equal(D.nextEditStep(steps, D.stepPoint(steps[0]), 0, -1, 24), null);
    // A selected roll goes on to the right side; a selected in-edge back to both.
    const roll = D.stepPoint(steps[2]);
    assert.equal(D.nextEditStep(steps, roll, 0, 1, 24).state, "right");
    assert.equal(D.nextEditStep(steps, D.stepPoint(steps[3]), 0, -1, 24).state, "both");
    assert.equal(D.pointAct(D.stepPoint(steps[1]), true), "ripple-out");
    assert.equal(D.pointAct(D.stepPoint(steps[3]), false), "trim-in");
});

// ── D: clips switched off ──

test("D switches the selected clips off with their linked partners, and on again when all were off", () => {
    const cut = { ...D.emptyCut("d"), clips: [shot("a", 2, { link: "L1", mute: true }), shot("b", 2)],
        tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "o", name: "o", in: 0, length: 1, at: 0.5 }] },
                 { id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "a", name: "a", in: 0, length: 2, at: 0, link: "L1" },
                                                                         { file: "u", name: "u", in: 0, length: 2, at: 2, link: "L2", unlinked: true }] }] };
    const off = D.toggleDisabled(cut, [{ kind: "clip", i: 0 }]);
    assert.equal(off.off, true);
    assert.equal(off.cut.clips[0].disabled, true);
    assert.equal(off.cut.tracks[1].clips[0].disabled, true, "the linked sound with it");
    assert.equal(cut.clips[0].disabled, undefined, "a new cut: the old one untouched (undo)");
    // Off: a gap on V1 (the overlay at 0.5..1.5 shows there), its sound silent.
    assert.equal(D.pictureAt(off.cut, 0.2).clip, null);
    assert.equal(D.pictureAt(off.cut, 1.0).clip.file, "o");
    assert.deepEqual(D.soundItems(off.cut).map((s) => s.file), ["u"]);
    // The overlay off too: black there, then b.
    const both = D.toggleDisabled(off.cut, [{ kind: "tclip", track: "V2", i: 0 }]).cut;
    assert.equal(D.pictureAt(both, 1.0).clip, null);
    assert.equal(D.pictureAt(both, 2.5).clip.file, "b");
    // A mixed selection with one on: all off; all off: all on again; an unlinked partner stays as it is.
    const mixed = D.toggleDisabled(off.cut, [{ kind: "clip", i: 0 }, { kind: "clip", i: 1 }]);
    assert.equal(mixed.off, true);
    const on = D.toggleDisabled(mixed.cut, [{ kind: "clip", i: 0 }, { kind: "clip", i: 1 }]);
    assert.equal(on.off, false);
    assert.equal(on.cut.clips.some((c) => c.disabled), false);
    assert.equal(on.cut.tracks[1].clips[1].disabled, undefined);
    assert.equal(D.sameCut(cut, off.cut), false, "a change to save");
    assert.equal(D.toSave(off.cut).clips[0].disabled, true);
});
