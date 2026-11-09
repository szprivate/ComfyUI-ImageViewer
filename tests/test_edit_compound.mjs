// node --test tests/test_edit_compound.mjs
// Compound clips: made, laid out flat, folded back, taken apart (imageViewer_editTimelineData.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const near = (a, b, m = "") => assert.ok(Math.abs(a - b) < 1e-6, `${m} ${a} != ${b}`);
const base = () => ({
    ...D.emptyCut("t"),
    clips: [shot("a.mp4", 4), shot("b.mp4", 3, { in: 1 }), shot("c.mp4", 2), shot("d.mp4", 5)],
    tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [shot("t.png", 1, { at: 4.5 })] },
             { id: "A2", kind: "audio", name: "A2", off: false, clips: [shot("s.wav", 2, { at: 5 })] }],
});
const picture = (cut, t) => { const p = D.pictureAt(cut, t); return p && p.clip ? [p.clip.file, Math.round(D.srcLocal(p.clip, t - p.origin) * 1000) / 1000] : null; };

test("a compound of V1 shots holds them and what lies on the tracks in their time", () => {
    const cut = base();
    const r = D.makeCompound(cut, [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }, { kind: "tclip", track: "V2", i: 0 }, { kind: "tclip", track: "A2", i: 0 }], "Mid");
    assert.ok(!r.error, r.error);
    const c = r.cut.clips[1];
    assert.ok(D.isCompound(c));
    assert.equal(r.cut.clips.length, 3);
    near(c.length, 5);
    near(D.filmLength(r.cut), D.filmLength(cut));
    assert.equal(r.cut.tracks[0].clips.length, 0);
    assert.equal(r.cut.tracks[1].clips.length, 0);
    const inner = c.compound.cut;
    assert.deepEqual(inner.clips.map((x) => x.file), ["b.mp4", "c.mp4"]);
    near(inner.tracks[0].clips[0].at, 0.5);
    // no time of its own
    assert.equal(D.speedOf({ ...c, speed: 2 }), 1);
    near(D.srcRoom(c, {}), 5);                      // the inner film from its in point
    assert.equal(D.isStillClip(c), false);
});

test("flat, the compound plays what its clips played", () => {
    const cut = base();
    const { cut: comp } = D.makeCompound(cut, [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }, { kind: "tclip", track: "V2", i: 0 }], "Mid");
    const flat = D.flattenCut(comp);
    assert.equal(flat.clips.length, 4);
    for (const t of [0.5, 4.2, 4.7, 6.9, 7.5, 9.5, 11.9]) assert.deepEqual(picture(flat, t), picture(cut, t), "at " + t);
    assert.ok(flat.clips.slice(1, 3).every((x) => x.cpart && x.cpart.id === comp.clips[1].compound.id));
    const made = flat.tracks.find((k) => k.cpart);
    assert.equal(made.under, "V1");
    assert.equal(made.clips[0].file, "t.png");
    near(made.clips[0].at, 4.5);
    // a cut without compounds is left as it is
    assert.equal(D.flattenCut(cut), cut);
});

test("trimmed and moved, the compound shows that part of its film", () => {
    const { cut: comp } = D.makeCompound(base(), [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }], "Mid");
    const c = comp.clips[1];
    c.in = 2; c.length = 2;                          // 2 s into the inner film (b's last second, then c)
    const cut = comp;
    const flat = D.flattenCut(cut);
    near(D.filmLength(flat), D.filmLength(cut));
    assert.deepEqual(picture(flat, 4.2), ["b.mp4", 3.2]);
    assert.deepEqual(picture(flat, 5.7), ["c.mp4", 0.7]);
    assert.deepEqual(picture(flat, 6.5), ["d.mp4", 0.5]);
});

test("saved flat and read back, the compound comes back", () => {
    const { cut: comp } = D.makeCompound(base(), [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }, { kind: "tclip", track: "A2", i: 0 }], "Mid");
    const saved = D.toSave(comp);
    assert.ok(saved.compounds[comp.clips[1].compound.id]);
    assert.ok(saved.clips.some((x) => x.cpart));
    // what the file gives back: the flat cut, tracks numbered by kind
    const flat = D.flattenCut(comp);
    const count = { video: 1, audio: 1 };
    const read = { ...flat, tracks: flat.tracks.map((k) => { count[k.kind] += 1; const id = (k.kind === "video" ? "V" : "A") + count[k.kind]; return { ...k, id, name: k.cpart ? k.name : id }; }) };
    const back = D.regroupCut(read);
    assert.equal(back.clips.length, 3);
    assert.ok(D.isCompound(back.clips[1]));
    assert.deepEqual(back.tracks.map((k) => k.id), ["V2", "A2"]);
    assert.ok(D.sameCut(back, comp), "the same cut as before the save");
    // a cut without compounds is left as it is
    const plain = base();
    assert.equal(D.regroupCut(plain), plain);
});

test("a compound on a track, and one taken apart again", () => {
    const cut = base();
    cut.tracks[0].clips.push(shot("u.png", 1, { at: 7 }));
    const r = D.makeCompound(cut, [{ kind: "tclip", track: "V2", i: 0 }, { kind: "tclip", track: "V2", i: 1 }], "Overlays");
    assert.ok(!r.error, r.error);
    const k = r.cut.tracks.find((t) => t.id === "V2");
    assert.equal(k.clips.length, 1);
    near(k.clips[0].at, 4.5);
    near(k.clips[0].length, 3.5);
    const flat = D.flattenCut(r.cut);
    for (const t of [4.7, 6, 7.5]) assert.deepEqual(picture(flat, t), picture(cut, t), "at " + t);
    const apart = D.decomposeCompound(r.cut, r.sel);
    assert.ok(!apart.error, apart.error);
    assert.equal(D.hasCompound(apart.cut), false);
    const v2 = apart.cut.tracks.find((t) => t.id === "V2");
    assert.deepEqual(v2.clips.map((x) => [x.file, x.at]), [["t.png", 4.5], ["u.png", 7]]);
    assert.ok(!apart.cut.clips.some((x) => x.cpart));
});

test("refused where it makes no sense", () => {
    const cut = base();
    assert.match(D.makeCompound(cut, [{ kind: "clip", i: 0 }, { kind: "clip", i: 2 }]).error, /next to each other/);
    assert.match(D.makeCompound(cut, []).error, /select/);
    assert.match(D.decomposeCompound(cut, { kind: "clip", i: 0 }).error, /not a compound/);
    const { cut: comp } = D.makeCompound(cut, [{ kind: "clip", i: 1 }]);
    const sel = { kind: "clip", i: 1 };
    assert.ok(D.sameCut(D.setSpeed(comp, sel, 2), comp));
    assert.ok(D.sameCut(D.setMotion(comp, sel, "reverse"), comp));
});

test("a compound inside a compound plays flat too", () => {
    const cut = base();
    const one = D.makeCompound(cut, [{ kind: "clip", i: 1 }, { kind: "clip", i: 2 }], "In").cut;
    const two = D.makeCompound(one, [{ kind: "clip", i: 0 }, { kind: "clip", i: 1 }], "Out");
    assert.ok(!two.error, two.error);
    assert.equal(two.cut.clips.length, 2);
    const flat = D.flattenCut(two.cut);
    for (const t of [1, 4.5, 6.5, 8]) assert.deepEqual(picture(flat, t), picture(cut, t), "at " + t);
    const outer = two.cut.clips[0].compound.id;
    assert.ok(flat.clips.slice(0, 3).every((x) => x.cpart.id === outer));
    const saved = D.toSave(two.cut);
    assert.deepEqual(Object.keys(saved.compounds), [outer]);
});
