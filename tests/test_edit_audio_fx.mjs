// Sound effects: the table, a chain's edits and keys, and what the WebAudio nodes / ffmpeg filters are given.
// Run: node --test tests/test_edit_audio_fx.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../js/bEpicViewer_audioFxData.js";
import * as D from "../js/bEpicViewer_editTimelineData.js";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test("an effect is held to its table: defaults, ranges, the keyed params only, unknown ones left out", () => {
    const c = A.cleanAfx([{ type: "comp", p: { ratio: 99, thr: "x" } }, { type: "x" }, { type: "pan", keys: { pan: [{ t: 1, v: 3 }, { t: -1, v: 0 }], gain: [{ t: 0, v: 1 }] } }]);
    assert.equal(c.length, 2);
    assert.equal(c[0].p.ratio, 20);
    assert.equal(c[0].p.thr, -18);
    assert.deepEqual(c[1].keys, { pan: [{ t: 1, v: 1 }] });
    assert.equal(A.cleanAfx(Array.from({ length: 20 }, () => ({ type: "gain" }))).length, A.MAX_AFX);
});

test("bypass, reorder, auto-key and the keys' eases", () => {
    let c = [A.newAfx("eq"), A.newAfx("reverb")];
    c = A.patchAfx(c, 0, { on: false });
    assert.equal(c[0].on, false);
    c = A.moveAfx(c, 1, -1);
    assert.deepEqual(c.map((f) => f.type), ["reverb", "eq"]);
    c = A.setAfxKey(c, 0, "mix", 0, 0);
    c = A.setAfxKey(c, 0, "mix", 2, 1);
    near(A.afxParam(c[0], "mix", 1), 0.5);
    // A change to a keyed param is a key at that time (auto-key); an unkeyed one its number.
    c = A.patchAfx(c, 0, { mix: 0.8, decay: 2 }, 1);
    assert.deepEqual(c[0].keys.mix.map((k) => [k.t, k.v]), [[0, 0], [1, 0.8], [2, 1]]);
    assert.equal(c[0].p.decay, 2);
    c = A.removeAfxKey(c, 0, "mix", 1);
    assert.equal(c[0].keys.mix.length, 2);
    c[0].keys.mix[0].i = "hold";
    near(A.afxParam(A.cleanAfx(c)[0], "mix", 1.9), 0);
    // A preset sets its decay.
    assert.equal(A.patchAfx(c, 0, { preset: "hall" })[0].p.decay, A.REVERB_PRESETS.hall.decay);
});

test("the numbers for WebAudio and the ffmpeg filters", () => {
    const eq = A.cleanAfxOne({ type: "eq", p: { hp: 80, pk_g: 3, pk_f: 900, pk_q: 2, lp: 9000 } });
    assert.deepEqual(A.afxFfmpeg(eq), ["highpass=f=80:t=q:w=0.70711", "equalizer=f=900:t=q:w=2:g=3", "lowpass=f=9000:t=q:w=0.70711"]);
    assert.deepEqual(A.afxPlan(eq).eq.map((b) => b.kind), ["highpass", "peaking", "lowpass"]);
    const comp = A.afxPlan(A.cleanAfxOne({ type: "comp", p: { thr: -20, knee: 18, makeup: 6 } }));
    near(comp.ffmpeg.threshold, 0.1, 1e-5);
    near(comp.ffmpeg.knee, 7.94328, 1e-4);           // 18 dB as acompressor's factor
    near(comp.ffmpeg.makeup, 1.99526, 1e-4);
    assert.equal(comp.attack, 0.01);                  // WebAudio wants seconds
    assert.deepEqual(A.afxFfmpeg(A.cleanAfxOne({ type: "limit", p: { ceil: -6 } })), ["alimiter=limit=0.50119:release=50:level=false"]);
    assert.deepEqual(A.afxFfmpeg({ ...A.newAfx("limit"), on: false }), []);
    // StereoPanner: centre passes, hard right takes both sides into the right.
    assert.deepEqual(A.panGains(0).map((v) => Math.round(v * 1e6) / 1e6), [1, 0, 0, 1]);
    assert.deepEqual(A.panGains(1).map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 1, 1]);
    // The reverb's impulse response: its pre-delay silent, each channel of unit energy, the same each time.
    const ir = A.reverbIR("room", 0.5, 10, 48000);
    assert.equal(ir[0].length, 480 + 24000);
    assert.equal(ir[0][479], 0);
    near(ir[0].reduce((s, v) => s + v * v, 0), 1, 1e-4);
    assert.equal(A.reverbIR("room", 0.5, 10, 48000)[1][1000], ir[1][1000]);
});

const CUT = () => ({ name: "t", fps: 24, texts: [], sound: [{ name: "bed", file: "bed.wav" }], off: {},
    clips: [{ file: "a.mp4", name: "a", in: 0, length: 4, transition: 0 }, { file: "c.png", name: "c", in: 0, length: 2, transition: 0 }],
    tracks: [{ id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "s.wav", name: "s", in: 0, length: 4, at: 0 }] },
             { id: "V2", kind: "video", name: "V2", off: false, clips: [] }] });

test("clips and tracks carry chains: saved, compared, pasted, split", () => {
    const s = { kind: "tclip", track: "A2", i: 0 };
    assert.ok(D.afxTakes(CUT(), s));
    assert.ok(D.afxTakes(CUT(), { kind: "clip", i: 0 }));
    assert.ok(!D.afxTakes(CUT(), { kind: "clip", i: 1 }));       // a still has no sound
    assert.ok(D.afxTrack(CUT(), "A1") && D.afxTrack(CUT(), "A2") && !D.afxTrack(CUT(), "V2"));
    let cut = D.setClipAfx(CUT(), s, [A.newAfx("eq")]);
    cut = D.setTrackAfx(cut, "A2", [A.newAfx("comp")]);
    cut = D.setTrackAfx(cut, "A1", [A.newAfx("reverb")]);
    assert.equal(D.sameCut(cut, CUT()), false);
    assert.ok(D.cutHasAfx(cut));
    const saved = D.toSave(cut);
    assert.equal(saved.tracks[0].clips[0].afx[0].type, "eq");
    assert.equal(saved.tracks[0].afx[0].type, "comp");
    assert.equal(saved.afx.A1[0].type, "reverb");
    assert.deepEqual(D.toSave(CUT()).clips[0].afx, []);           // stated, so that taking one off reaches the file
    // Paste Attributes: the Audio FX group puts the source's chain on the target.
    const src = D.pasteSource(cut, s);
    const offer = D.pasteOffer(cut, src, [{ kind: "clip", i: 0 }]);
    assert.deepEqual(offer.afx, { source: true, targets: true });
    const pasted = D.pasteAttributes(cut, src, [{ kind: "clip", i: 0 }], { afx: true });
    assert.equal(D.clipAfx(pasted, { kind: "clip", i: 0 })[0].type, "eq");
    // A split: both halves keep the chain, the second's keys in its own time.
    let keyed = D.setClipAfx(CUT(), s, A.setAfxKey([A.newAfx("gain")], 0, "gain", 3, -6));
    const got = D.splitClip(keyed, s, 2);
    assert.equal(D.clipAfx(got.cut, { kind: "tclip", track: "A2", i: 1 })[0].keys.gain[0].t, 1);
    assert.equal(D.clipAfx(got.cut, s)[0].keys.gain[0].t, 3);
    // Taken off.
    assert.equal(D.clipOf(D.setClipAfx(cut, s, []), s).afx, undefined);
});
