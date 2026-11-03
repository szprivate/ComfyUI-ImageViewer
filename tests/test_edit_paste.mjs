// node --test tests/test_edit_paste.mjs
// Paste Attributes (bEpicViewer_editTimelineData.js): only the checked attributes go, to the targets that can
// take them; keys stand where they stood from the clip's start, cut off at the target's end.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/bEpicViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} != ${b}`);
const cutOf = () => ({ ...D.emptyCut("p"), clips: [
    shot("a.mp4", 4, { fx: { op: 0.5, zx: 2, zy: 2, rot: 30, fh: true, keys: { x: [{ t: 0.5, v: 0.1 }, { t: 3, v: 0.4 }] } }, volume: 0.3, color: "#ff0000", name: "A" }),
    shot("b.mp4", 2), shot("c.png", 3)],
    tracks: [{ id: "A2", kind: "audio", name: "A2", off: false, clips: [{ ...shot("s.wav", 5), at: 0 }] }] });
const S = (i) => ({ kind: "clip", i });

test("only the checked attributes are pasted, onto the targets that take them", () => {
    const cut = cutOf();
    const src = D.pasteSource(cut, S(0));
    const next = D.pasteAttributes(cut, src, [S(1), S(2)], { opacity: true, zoom: true });
    for (const i of [1, 2]) {
        const fx = next.clips[i].fx;
        assert.equal(fx.op, 0.5);
        assert.equal(fx.zx, 2);
        assert.equal(fx.zy, 2);
        assert.equal(fx.rot, undefined, "rotation was not checked");
        assert.equal(fx.fh, undefined);
        assert.equal(next.clips[i].volume, 1);
        assert.equal(next.clips[i].color, "");
    }
    assert.deepEqual(cut.clips[1].fx, undefined, "the cut given is not changed");
});

test("keys go relative to the clip's start and are cut off at the target's end", () => {
    const cut = cutOf();
    const src = D.pasteSource(cut, S(0));
    const next = D.pasteAttributes(cut, src, [S(1)], { position: true, keys: true });
    const k = next.clips[1].fx.keys.x;
    assert.equal(k.length, 2);
    near(k[0].t, 0.5);
    near(k[0].v, 0.1);
    near(k[1].t, 2, "a key at the 2 s clip's end");
    near(k[1].v, 0.1 + 0.3 * (1.5 / 2.5), "holding the value there");
    // Without keyframes: the value at the source's first frame, and the target's own keys of it go.
    const keyed = D.setKeys(cut, S(1), { x: 0.9 }, 1);
    const plain = D.pasteAttributes(keyed, src, [S(1)], { position: true });
    assert.equal(plain.clips[1].fx.keys, undefined);
    near(plain.clips[1].fx.x, 0.1);
});

test("what the dialog offers: the source's kind and the targets' ", () => {
    const cut = cutOf();
    const src = D.pasteSource(cut, S(0));
    const sound = { kind: "tclip", track: "A2", i: 0 };
    let o = D.pasteOffer(cut, src, [sound]);
    assert.equal(o.opacity.targets, false, "a sound clip has no picture");
    assert.equal(o.volume.targets, true);
    assert.equal(o.textlook.source, false);
    assert.equal(o.keys.source, true);
    o = D.pasteOffer(cut, src, [S(2)]);
    assert.equal(o.speed.targets, false, "a still has no speed");
    assert.equal(o.volume.targets, false, "nor sound");
    const plain = D.pasteSource(cut, S(1));
    assert.equal(D.pasteOffer(cut, plain, [S(0)]).keys.source, false, "no keys to paste");
    // Pasted onto the sound clip, the opacity is not set there, the volume is.
    const next = D.pasteAttributes(cut, src, [sound], { opacity: true, volume: true });
    assert.equal(next.tracks[0].clips[0].fx, undefined);
    assert.equal(next.tracks[0].clips[0].volume, 0.3);
});

test("speed, name, colour and a text's look", () => {
    let cut = cutOf();
    cut = D.setSpeed(cut, S(0), 2);
    const src = D.pasteSource(cut, S(0));
    const next = D.pasteAttributes(cut, src, [S(1), S(2)], { speed: true, name: true, color: true });
    assert.equal(D.speedOf(next.clips[1]), 2);
    near(next.clips[1].length, 1, "twice as fast: half as long");
    assert.equal(next.clips[2].length, 3, "a still keeps its length");
    assert.equal(next.clips[1].name, "A");
    assert.equal(next.clips[2].color, "#ff0000");
    let t = D.addText(D.addText(cut, "one", 0), "two", 3);
    t = D.setTextLook(t, 0, { size: 12, color: "#00ff00" });
    const ts = D.pasteSource(t, { kind: "text", i: 0 });
    const got = D.pasteAttributes(t, ts, [{ kind: "text", i: 1 }], { textlook: true });
    assert.equal(got.texts[1].size, 12);
    assert.equal(got.texts[1].color, "#00ff00");
    assert.equal(got.texts[1].text, "two");
});

test("the bed: fades and the bed's effects go, no volume; fades go to sound clips and back", () => {
    const fx = [{ type: "gain", p: { gain: -3 } }];
    const cut = { ...cutOf(), sound: [{ name: "m", file: "m.wav", fadeIn: 1.5 }, { name: "n", file: "n.wav" }], afx: { A1: fx } };
    const bed = { kind: "sound", i: 0 }, bed2 = { kind: "sound", i: 1 };
    const src = D.pasteSource(cut, bed);
    assert.ok(src && src.caps.bed);
    let o = D.pasteOffer(cut, src, [bed2]);
    assert.equal(o.volume.source, false);
    assert.equal(o.volume.targets, false);
    assert.equal(o.opacity.targets, false);
    assert.equal(o.fades.source && o.fades.targets, true);
    assert.equal(o.afx.source && o.afx.targets, true);
    let next = D.pasteAttributes(cut, src, [bed2], { fades: true, afx: true });
    assert.equal(next.sound[1].fadeIn, 1.5);
    assert.equal(D.trackAfx(next, "A1")[0].p.gain, -3);
    // onto a sound clip of A2, and a sound clip's fades and volume onto the bed (volume stays off)
    const a2 = { kind: "tclip", track: "A2", i: 0 };
    next = D.pasteAttributes(cut, src, [a2], { fades: true, afx: true, volume: true });
    assert.equal(next.tracks[0].clips[0].fadeIn, 1.5);
    assert.equal(next.tracks[0].clips[0].afx[0].p.gain, -3);
    assert.equal(next.tracks[0].clips[0].volume, 1, "the bed has no volume to give");
    const back = D.pasteAttributes(next, D.pasteSource(next, a2), [bed2], { fades: true, volume: true });
    assert.equal(back.sound[1].fadeIn, 1.5);
});
