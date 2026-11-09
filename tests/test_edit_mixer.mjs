// node --test tests/test_edit_mixer.mjs
// The Mixer's faders and pans are the track's last Gain / Pan effect (imageViewer_audioFxData.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../js/imageViewer_audioFxData.js";
import * as D from "../js/imageViewer_editTimelineData.js";

test("no effect is a fader at 0 dB and a pan in the middle", () => {
    assert.deepEqual(A.mixerLevel([], "gain", 0), { v: 0, keyed: false, i: -1 });
    assert.equal(A.mixerLevel([], "pan", 0).v, 0);
});

test("a fader moved off rest adds a Gain effect at the end, and back at rest takes it away", () => {
    const eq = A.newAfx("eq");
    let c = A.setMixerLevel([eq], "gain", -6, 0);
    assert.equal(c.length, 2);
    assert.equal(c[1].type, "gain");
    assert.equal(c[1].p.gain, -6);
    assert.equal(A.mixerLevel(c, "gain", 0).v, -6);
    c = A.setMixerLevel(c, "gain", 0, 0);
    assert.deepEqual(c.map((fx) => fx.type), ["eq"]);
    assert.equal(A.setMixerLevel([], "gain", 0, 0).length, 0, "at rest with none: nothing is added");
});

test("the fader is the LAST gain of the chain, held to its range", () => {
    const g1 = { ...A.newAfx("gain"), p: { gain: 3 } }, g2 = { ...A.newAfx("gain"), p: { gain: -2 } };
    assert.equal(A.mixerLevel([g1, g2], "gain", 0).v, -2);
    const c = A.setMixerLevel([g1, g2], "gain", 99, 0);
    assert.equal(c[0].p.gain, 3);
    assert.equal(c[1].p.gain, 24);
    assert.equal(A.setMixerLevel([], "pan", -5, 0)[0].p.pan, -1);
});

test("a bypassed gain reads as rest, and a move switches it on", () => {
    const g = { ...A.newAfx("gain"), on: false, p: { gain: -10 } };
    assert.equal(A.mixerLevel([g], "gain", 0).v, 0);
    const c = A.setMixerLevel([g], "gain", -3, 0);
    assert.equal(c[0].on, true);
    assert.equal(c[0].p.gain, -3);
});

test("a keyed fader takes a key at the playhead", () => {
    const g = { ...A.newAfx("gain"), keys: { gain: [{ t: 0, v: 0 }, { t: 4, v: -12 }] } };
    const at = A.mixerLevel([g], "gain", 2);
    assert.equal(at.keyed, true);
    assert.ok(Math.abs(at.v - -6) < 1e-6);
    const c = A.setMixerLevel([g], "gain", -20, 2);
    assert.equal(c[0].keys.gain.length, 3);
    assert.equal(A.mixerLevel(c, "gain", 2).v, -20);
    assert.equal(A.setMixerLevel([g], "gain", 0, 2)[0].keys.gain.length, 3, "a keyed one at rest stays (a key)");
});

test("the peak in dB, held to the floor", () => {
    assert.equal(A.peakDb(new Float32Array(8)), -60);
    assert.ok(Math.abs(A.peakDb(Float32Array.from([0, -0.5, 0.25])) - 20 * Math.log10(0.5)) < 1e-6);
    assert.equal(A.peakDb(Float32Array.from([1e-6]), -60), -60);
    assert.ok(A.peakDb(Float32Array.from([1.5])) > 0, "over");
});

test("on a cut: the bed and a sound track take it, V1 does not", () => {
    const cut = { ...D.emptyCut("t"), tracks: [{ id: "A2", kind: "audio", clips: [] }] };
    const c = D.setTrackAfx(cut, "A2", A.setMixerLevel(D.trackAfx(cut, "A2"), "gain", -4, 0));
    assert.equal(A.mixerLevel(D.trackAfx(c, "A2"), "gain", 0).v, -4);
    assert.equal(!!D.afxTrack(cut, "V1"), false);
    assert.equal(!!D.afxTrack(cut, "A1"), true);
});
