// node --test tests/test_edit_takes.mjs
// Several clips selected, and takes (bEpicViewer_editTimelineData.js): the same shot made again, kept beside the first.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/bEpicViewer_editTimelineData.js";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const cutOf = (clips, extra = {}) => ({ ...D.emptyCut("t"), clips, ...extra });
const NEW = { file: "D:/out/shot_03_v002.mp4", version: 2, created: "2026-10-31T10:00:00", note: "warmer" };

// ── several clips selected ──

test("ctrl toggles a clip in and out of the list, shift takes the range on one track", () => {
    const cut = cutOf([shot("a", 2), shot("b", 2), shot("c", 2), shot("d", 2)],
                      { tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [shot("e", 1, { at: 0 }), shot("f", 1, { at: 2 })] }] });
    let list = D.toggleSel([], { kind: "clip", i: 1 });
    list = D.toggleSel(list, { kind: "clip", i: 3 });
    assert.deepEqual(list.map(D.selId), ["V1:1", "V1:3"]);
    list = D.toggleSel(list, { kind: "clip", i: 1 });
    assert.deepEqual(list.map(D.selId), ["V1:3"]);
    assert.deepEqual(D.rangeSel(cut, { kind: "clip", i: 3 }, { kind: "clip", i: 1 }).map(D.selId), ["V1:1", "V1:2", "V1:3"]);
    // Another track than the anchor's: just the clicked one.
    assert.deepEqual(D.rangeSel(cut, { kind: "clip", i: 3 }, { kind: "tclip", track: "V2", i: 1 }).map(D.selId), ["V2:1"]);
    assert.deepEqual(D.rangeSel(cut, { kind: "tclip", track: "V2", i: 0 }, { kind: "tclip", track: "V2", i: 1 }).map(D.selId), ["V2:0", "V2:1"]);
    assert.deepEqual(D.rangeSel(cut, null, { kind: "clip", i: 2 }), [{ kind: "clip", i: 2 }]);
});

test("the selected clips are named for agentY: file, source in and out, track and id; the cap holds", () => {
    const cut = cutOf([shot("D:/out/a.mp4", 2, { name: "shot_01", in: 1 }), shot("D:/out/b.mp4", 4, { name: "shot_02", speed: 2 })],
                      { tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [shot("D:/out/c.mp4", 1, { name: "ins", at: 0, in: 3 })] }] });
    const got = D.selectedClips(cut, [{ kind: "tclip", track: "V2", i: 0 }, { kind: "clip", i: 1 }, { kind: "clip", i: 0 }, { kind: "clip", i: 9 }]);
    assert.deepEqual(got, [
        { name: "shot_01", file: "D:/out/a.mp4", in: 1, out: 3, track: "V1", id: "V1:0" },
        { name: "shot_02", file: "D:/out/b.mp4", in: 0, out: 8, track: "V1", id: "V1:1" },
        { name: "ins", file: "D:/out/c.mp4", in: 3, out: 4, track: "V2", id: "V2:0" },
    ]);
    const many = cutOf(Array.from({ length: 80 }, (_, i) => shot("f" + i, 1)));
    assert.equal(D.selectedClips(many, many.clips.map((_, i) => ({ kind: "clip", i }))).length, D.SELECTED_CAP);
});

test("the signature changes when clips are added, taken out or reordered, not when one is trimmed or gets a take", () => {
    const cut = cutOf([shot("a", 2, { ref: 0 }), shot("b", 2, { ref: 1 }), shot("c", 2, { ref: 2 })]);
    const sig = D.selSignature(cut);
    assert.notEqual(D.selSignature(D.moveClip(cut, 0, 2)), sig);
    assert.notEqual(D.selSignature(D.removeClip(cut, 1)), sig);
    assert.equal(D.selSignature(D.trimEnd(cut, 1, 1)), sig);
    assert.equal(D.selSignature(D.addTake(cut, "b", NEW)), sig);
});

// ── takes ──

test("a take replaces the file and keeps everything else; the original becomes v1", () => {
    const fx = { zx: 2 };
    const cut = cutOf([shot("D:/out/shot_03_v001.mp4", 3, { in: 1, color: "#ff0000", volume: 0.5, fx, speed: 1.5, name: "shot_03", transition: 0.5 }),
                       shot("D:/out/other.mp4", 2)]);
    cut.clips[1].transition = 0.4;
    const got = D.addTake(cut, "D:/out/shot_03_v001.mp4", NEW);
    const c = got.clips[0];
    assert.equal(c.file, NEW.file);
    assert.equal(c.in, 1);
    near(c.length, 3);
    assert.equal(c.speed, 1.5);
    assert.equal(c.color, "#ff0000");
    assert.equal(c.volume, 0.5);
    assert.deepEqual(c.fx, fx);
    assert.equal(c.name, "shot_03");
    assert.deepEqual(c.takes, [
        { file: "D:/out/shot_03_v001.mp4", version: 1, created: "", note: "original", active: false },
        { file: NEW.file, version: 2, created: NEW.created, note: "warmer", active: true },
    ]);
    assert.equal(got.clips[1].file, "D:/out/other.mp4");
    assert.equal(got.clips[1].takes, undefined);
    assert.equal(cut.clips[0].file, "D:/out/shot_03_v001.mp4", "the cut given is left alone");
    assert.equal(D.sameCut(cut, got), false, "a take is a change");
    assert.equal(D.sameCut(got, D.addTake(cut, "D:/out/shot_03_v001.mp4", NEW)), true);
});

test("the original's version comes from its name when it has one, else 1", () => {
    assert.equal(D.versionOf("D:/out/shot_03_v007.mp4"), 7);
    assert.equal(D.versionOf("D:\\out\\clip.final.v12.mov"), 12);
    assert.equal(D.versionOf("D:/out/preview.mp4"), 1);
    assert.equal(D.versionOf("D:/out/vision.mp4"), 1);
    const got = D.addTake(cutOf([shot("D:/out/x_v004.mp4", 2)]), "D:/out/x_v004.mp4", { file: "D:/out/x_v005.mp4", version: 5 });
    assert.equal(got.clips[0].takes[0].version, 4);
});

test("every clip of the file gets the take, on V1 and on the tracks; the path is compared by its meaning", () => {
    const cut = cutOf([shot("D:/Out/a.mp4", 2), shot("D:/out/b.mp4", 2), shot("D:\\out\\a.mp4", 1, { in: 2 })],
                      { tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [shot("d:/out/a.mp4", 1, { at: 1, in: 3 })] }] });
    const got = D.addTake(cut, "D:/out/a.mp4", { file: "D:/out/a_v002.mp4", version: 2 });
    assert.deepEqual(got.clips.map((c) => c.file), ["D:/out/a_v002.mp4", "D:/out/b.mp4", "D:/out/a_v002.mp4"]);
    assert.equal(got.tracks[0].clips[0].file, "D:/out/a_v002.mp4");
    assert.equal(got.tracks[0].clips[0].in, 3);
    assert.equal(got.tracks[0].clips[0].at, 1);
});

test("a file the cut does not use is a no-op; so is the same take twice (it stays one take)", () => {
    const cut = cutOf([shot("D:/out/a.mp4", 2)]);
    const none = D.addTake(cut, "D:/out/zzz.mp4", NEW);
    assert.equal(D.sameCut(cut, none), true);
    assert.equal(none.clips[0].takes, undefined);
    const once = D.addTake(cut, "D:/out/a.mp4", NEW);
    const twice = D.addTake(once, NEW.file, NEW);
    assert.equal(twice.clips[0].takes.length, 2);
    assert.equal(twice.clips[0].takes.filter((t) => t.active).length, 1);
});

test("a second change makes v3 next to v2 and v1; a version already used is not taken twice", () => {
    let cut = cutOf([shot("D:/out/s_v001.mp4", 2)]);
    cut = D.addTake(cut, "D:/out/s_v001.mp4", { file: "D:/out/s_v002.mp4", version: 2 });
    cut = D.addTake(cut, "D:/out/s_v002.mp4", { file: "D:/out/s_v003.mp4", version: 3, note: "again" });
    assert.deepEqual(cut.clips[0].takes.map((t) => [t.version, t.active]), [[1, false], [2, false], [3, true]]);
    cut = D.addTake(cut, "D:/out/s_v003.mp4", { file: "D:/out/other.mp4", version: 2 });
    assert.deepEqual(cut.clips[0].takes.map((t) => t.version), [1, 2, 3, 4]);
});

test("a shorter source shortens the clip and keeps the in point; retime slows it down to fill the length instead", () => {
    const cut = cutOf([shot("D:/out/a.mp4", 4, { in: 1 })]);
    const durations = { "D:/out/shot_03_v002.mp4": 3 };
    const cut1 = D.addTake(cut, "D:/out/a.mp4", NEW, { durations });
    assert.equal(cut1.clips[0].in, 1);
    near(cut1.clips[0].length, 2);
    assert.equal(cut1.clips[0].speed, undefined);
    assert.equal(cut1.clips[0].takes[1].len, 4, "it remembers the length it had");
    const cut2 = D.addTake(cut, "D:/out/a.mp4", NEW, { durations, retime: true });
    assert.equal(cut2.clips[0].in, 1);
    near(cut2.clips[0].length, 4);
    near(cut2.clips[0].speed, 0.5);
    // A longer source changes nothing.
    const long = D.addTake(cut, "D:/out/a.mp4", NEW, { durations: { [NEW.file]: 30 } });
    near(long.clips[0].length, 4);
    // An in point past the end of the source is pulled back, and the clip never gets below the minimum.
    const past = D.addTake(cutOf([shot("D:/out/a.mp4", 2, { in: 5 })]), "D:/out/a.mp4", NEW, { durations });
    assert.ok(past.clips[0].length >= D.MIN_CLIP);
    assert.ok(past.clips[0].in + past.clips[0].length <= 3 + 1e-6);
});

test("Retime to fit fills the length the clip had before a shorter take shortened it", () => {
    const cut = cutOf([shot("D:/out/a.mp4", 4, { in: 0 })]);
    const durations = { [NEW.file]: 2 };
    const short = D.addTake(cut, "D:/out/a.mp4", NEW, { durations });
    near(short.clips[0].length, 2);
    const fit = D.retimeToFit(short, { kind: "clip", i: 0 }, durations);
    near(fit.clips[0].length, 4);
    near(fit.clips[0].speed, 0.5);
    assert.equal(D.activeTake(fit.clips[0]).len, undefined);
    assert.equal(D.sameCut(D.retimeToFit(fit, { kind: "clip", i: 0 }, durations), fit), true, "nothing left to fit");
});

test("switching takes goes back and forth, one clip at a time, with the same fit", () => {
    const cut0 = cutOf([shot("D:/out/a_v001.mp4", 4, { in: 1, color: "#00ff00" }), shot("D:/out/a_v001.mp4", 2, { in: 0 })]);
    const durations = { "D:/out/a_v001.mp4": 10, [NEW.file]: 3 };
    const cut = D.addTake(cut0, "D:/out/a_v001.mp4", NEW, { durations });
    const sel = { kind: "clip", i: 0 };
    const back = D.switchTake(cut, sel, 1, { durations });
    assert.equal(back.clips[0].file, "D:/out/a_v001.mp4");
    assert.equal(back.clips[0].color, "#00ff00");
    assert.deepEqual(back.clips[0].takes.map((t) => t.active), [true, false]);
    assert.equal(back.clips[1].file, NEW.file, "the other clip of the same file keeps its take");
    const fwd = D.switchTake(back, sel, 2, { durations });
    assert.equal(fwd.clips[0].file, NEW.file);
    near(fwd.clips[0].length, 2);                  // 3 s of source from the 1 s in point
    assert.equal(D.switchTake(fwd, sel, 9).clips[0].file, NEW.file, "an unknown version is a no-op");
    const one = D.switchTake(fwd, { kind: "clip", i: 1 }, 1);
    assert.deepEqual(one.clips.map((c) => c.file), [NEW.file, "D:/out/a_v001.mp4"], "only the clip asked is switched");
    assert.equal(D.sameCut(D.switchTake(cut0, sel, 2), cut0), true, "a clip with no takes: unchanged");
});

test("takes are saved with the clip: cleaned, one active, at most 50", () => {
    const base = cutOf([shot("D:/out/a.mp4", 2, { ref: 0 })]);
    const cut = D.addTake(base, "D:/out/a.mp4", NEW);
    const saved = D.toSave(cut);
    assert.equal(saved.clips[0].takes.length, 2);
    assert.equal(D.toSave(base).clips[0].takes, undefined, "a clip with no takes writes none");
    const messy = D.cleanTakes([{ file: "x", version: 1, active: true }, { file: "y", version: 2, active: true }, { nope: 1 }, "str", { file: "z", version: 3, note: "n".repeat(500) }]);
    assert.deepEqual(messy.map((t) => t.active), [true, false, false]);
    assert.equal(messy[2].note.length, 200);
    assert.equal(D.cleanTakes(Array.from({ length: 90 }, (_, i) => ({ file: "f" + i, version: i }))).length, D.MAX_TAKES);
});

test("usesFile finds a file on V1 and on the tracks, by meaning", () => {
    const cut = cutOf([shot("D:/out/a.mp4", 2)], { tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [shot("D:\\out\\b.mp4", 1, { at: 0 })] }] });
    assert.equal(D.usesFile(cut, "d:/OUT/a.mp4"), true);
    assert.equal(D.usesFile(cut, "D:/out/b.mp4"), true);
    assert.equal(D.usesFile(cut, "D:/out/c.mp4"), false);
    assert.equal(D.usesFile(cut, ""), false);
});

// ── what agentY reads ──

import { describeViewerState, EDIT_SELECTED_CAP } from "../js/bEpicViewer_viewerState.js";

test("viewerState().edit.selected is a list of the clips, with the .otio; a text stays one object as selected_item", () => {
    const clips = [{ name: "shot_01", file: "D:/out/a.mp4", in: 1, out: 4, track: "V1", id: "V1:0" },
                   { name: "shot_03", file: "D:/out/c.mp4", in: 2.12345, out: 6, track: "V1", id: "V1:2" }];
    const s = describeViewerState({ open: true, display: "docked",
        edit: { open: true, tab: "edit:cut", cut: "cut", clips: 3, fps: 24, otio: "D:/cuts/cut.otio", selected: clips } });
    assert.deepEqual(s.edit.selected, [
        { name: "shot_01", file: "D:/out/a.mp4", in: 1, out: 4, track: "V1", id: "V1:0" },
        { name: "shot_03", file: "D:/out/c.mp4", in: 2.123, out: 6, track: "V1", id: "V1:2" }]);
    assert.equal(s.edit.otio, "D:/cuts/cut.otio");
    assert.equal(s.edit.selected_item, undefined);
    const t = describeViewerState({ open: true, display: "docked",
        edit: { open: true, tab: "edit:cut", cut: "cut", clips: 3, fps: 24, selected_item: { kind: "text", index: 0, text: "Hello" } } });
    assert.equal(t.edit.selected, undefined);
    assert.deepEqual(t.edit.selected_item, { kind: "text", index: 0, text: "Hello" });
    const big = describeViewerState({ open: true, display: "docked",
        edit: { open: true, selected: Array.from({ length: 80 }, (_, i) => ({ name: "s" + i, file: "f" + i, in: 0, out: 1, track: "V1", id: "V1:" + i })), selected_total: 80 } });
    assert.equal(big.edit.selected.length, EDIT_SELECTED_CAP);
    assert.equal(big.edit.selected_total, 80);
});
