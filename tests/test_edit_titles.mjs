// node --test tests/test_edit_titles.mjs
// Titles (imageViewer_editTitles.js, imageViewer_editTimelineData.js): a title is a clip on a video track and is
// cut, trimmed, moved, switched off, keyed and pasted by the clips' own edits; its look is held to the table; the
// texts of older cuts come in as titles; the layout puts each line where its alignment says.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";
import * as T from "../js/imageViewer_editTitles.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg || ""} ${a} != ${b}`);
const base = () => ({ ...D.emptyCut("t"), clips: [shot("a.mp4", 4), shot("b.mp4", 4)],
    tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ ...shot("o.png", 2), at: 5 }] }] });
const withTitle = (at = 1, length = 2) => D.addTitle(base(), { text: "Hello" }, at, length, "V2");

test("cleanTitle holds every field to the table and fills what is missing", () => {
    const t = T.cleanTitle({ size: 999, track: -5000, align: "middle", valign: "bottom", color: "#ABCDEF", bold: "yes", italic: true, font: ' Bad"Font\\ ' });
    assert.equal(t.size, 40);
    assert.equal(t.track, -200);
    assert.equal(t.align, "center", "an unknown alignment is the first one");
    assert.equal(t.valign, "bottom");
    assert.equal(t.color, "#abcdef");
    assert.equal(t.bold, false, "only true is true");
    assert.equal(t.italic, true);
    assert.equal(t.font, "BadFont");
    for (const k of Object.keys(T.TITLE_NUM)) assert.equal(typeof t[k], "number", k);
    assert.equal(T.cleanTitle({}).text, "Title");
    assert.equal(T.cleanTitle({ font: "" }).font, "Arial");
});

test("a title is added on a free video track, on the top one, else a new track above", () => {
    const a = D.addTitle(base(), { text: "One" }, 1, 2, "V2");
    assert.deepEqual(a.sel, { kind: "tclip", track: "V2", i: 1 });
    const c = D.clipOf(a.cut, a.sel);
    assert.equal(c.title.text, "One");
    assert.equal(c.name, "One");
    assert.equal(c.file, "");
    assert.equal(c.at, 1);
    // V2 is taken at 5..7: a title there goes onto a new track above.
    const b = D.addTitle(base(), { text: "Two" }, 5.5, 1, "V2");
    assert.equal(b.sel.track, "V3");
    assert.equal(b.cut.tracks.find((k) => k.id === "V3").kind, "video");
    // No track asked for: the top video track where it is free.
    const c3 = D.addTitle(b.cut, { text: "Three" }, 0, 1);
    assert.equal(c3.sel.track, "V3");
});

test("a title is no picture: pictureAt leaves it out, titlesAt has it with its rank and clip time", () => {
    const { cut, sel } = withTitle(1, 2);
    const at = D.pictureAt(cut, 1.5);
    assert.equal(at.sel.kind, "clip", "the shot under the title is the picture");
    assert.equal(at.over, undefined);
    const ts = D.titlesAt(cut, 1.5);
    assert.equal(ts.length, 1);
    assert.equal(ts[0].rank, 1);
    near(ts[0].u, 0.5);
    assert.equal(D.titlesAt(cut, 3.5).length, 0);
    assert.equal(D.pictureRank(cut, at), 0);
    // A switched-off track, a disabled title: not there.
    assert.equal(D.titlesAt(cut, 1.5, D.liveTracks(D.setTrackOff(cut, "V2", true))).length, 0);
    const off = D.toggleDisabled(cut, [sel]);
    assert.equal(off.off, true);
    assert.equal(D.titlesAt(off.cut, 1.5).length, 0);
});

test("a title is cut, trimmed, rolled, moved, deleted as a clip is", () => {
    const { cut, sel } = withTitle(1, 2);
    // The blade: both halves are titles with the same words.
    const s = D.splitClip(cut, sel, 2);
    const k = D.trackOf(s.cut, "V2");
    assert.equal(k.clips.filter((c) => c.title).length, 2);
    near(k.clips[sel.i].length, 1);
    near(D.clipOf(s.cut, s.sel).at, 2);
    assert.equal(D.clipOf(s.cut, s.sel).title.text, "Hello");
    // Trims: a title has no source length, so its head goes as early as the start of the film.
    const head = D.trimTrackClipStart(cut, "V2", sel.i, -1);
    near(D.clipOf(head, sel).at, 0);
    near(D.clipOf(head, sel).length, 3);
    near(D.clipOf(head, sel).in, 0, "a title has no in point");
    const tail = D.trimTrackClipEnd(cut, "V2", sel.i, 10, { "a.mp4": 4 });
    near(D.clipOf(tail, sel).length, 10);
    const rip = D.rippleTrackEnd(cut, "V2", sel.i, 3);
    near(D.trackOf(rip, "V2").clips.find((c) => c.file === "o.png").at, 6, "the clip after it rippled");
    // A move in time, as a group with a shot.
    const g = D.moveGroup(cut, [sel, { kind: "clip", i: 1 }], 0.5, 0);
    assert.ok(g);
    const moved = g.sel.find((x) => x.kind === "tclip");
    near(D.clipOf(g.cut, moved).at, 1.5);
    assert.equal(D.clipOf(g.cut, moved).title.text, "Hello");
    // Down a row: a title never goes onto V1, and holds the group with it.
    const down = D.moveGroup(cut, [sel], 0, 1);
    assert.equal(down.rows, 0);
    assert.equal(D.transferClip(cut, sel, "V1", 0), null, "not onto V1");
    // Up a row: a new track.
    const up = D.moveGroup(cut, [sel], 0, -1);
    assert.equal(up.sel[0].track, "V3");
    // Delete / ripple delete.
    const del = D.deleteSelection(cut, [sel], false);
    assert.equal(D.trackOf(del.cut || del, "V2").clips.filter((c) => c.title).length, 0);
});

test("the speed and loop of a title are none; a slip has nothing to move", () => {
    const { cut, sel } = withTitle(1, 2);
    const sp = D.setSpeed(cut, sel, 2);
    assert.equal(D.speedOf(D.clipOf(sp, sel)), 1);
    assert.equal(D.loopOf(D.clipOf(D.setLoop(cut, sel, "loop"), sel)), "");
    assert.equal(D.isStillClip(D.clipOf(cut, sel)), true);
});

test("the title's numbers take keys: titleAt, autoKey, split keeps the look from jumping", () => {
    const { cut, sel } = withTitle(0, 4);
    let next = D.toggleKeys(cut, sel, ["tsize"], 0);
    next = D.setKeys(next, sel, { tsize: 20 }, 2);
    const c = D.clipOf(next, sel);
    near(D.titleAt(c, 0).size, 6);
    near(D.titleAt(c, 1).size, 13);
    near(D.titleAt(c, 3).size, 20);
    // autoKey on a keyed number makes a key; on an unkeyed one it is not a FX number (the Inspector sets the title).
    const auto = D.autoKey(next, sel, { tsize: 10 }, 1);
    near(D.titleAt(D.clipOf(auto, sel), 1).size, 10);
    const s = D.splitClip(next, sel, 1);
    near(D.titleAt(D.clipOf(s.cut, s.sel), 0).size, 13, "the second half begins where the first ended");
    // cleanKeys holds them to the table's range.
    assert.equal(D.cleanKeys({ tsize: [{ t: 0, v: 500 }] }).tsize[0].v, 40);
});

test("setTitle changes the look of every selected title and leaves clips alone", () => {
    const a = withTitle(0, 2);
    const b = D.addTitle(a.cut, { text: "World" }, 0, 2);
    const both = [a.sel, b.sel, { kind: "clip", i: 0 }];
    const next = D.setTitle(b.cut, both, { bold: true, align: "right", font: "Georgia" });
    for (const s of [a.sel, b.sel]) {
        const t = D.clipOf(next, s).title;
        assert.equal(t.bold, true);
        assert.equal(t.align, "right");
        assert.equal(t.font, "Georgia");
    }
    assert.equal(next.clips[0].title, undefined);
    const words = D.setTitle(next, [a.sel], { text: "New words\nline two" });
    assert.equal(D.clipOf(words, a.sel).name, "New words", "a name that was its words follows them");
    assert.equal(D.clipOf(words, b.sel).title.text, "World");
});

test("saved: a title goes as its look, no file; sameCut sees a change of look", () => {
    const { cut, sel } = withTitle(1, 2);
    const saved = D.toSave(cut).tracks.find((k) => k.id === "V2").clips.find((c) => c.title);
    assert.equal(saved.file, undefined);
    assert.equal(saved.title.text, "Hello");
    assert.equal(saved.at, 1);
    assert.ok(D.sameCut(cut, cut));
    assert.ok(!D.sameCut(cut, D.setTitle(cut, [sel], { italic: true })));
});

test("the texts of an older cut come in as titles, overlapping ones on tracks of their own", () => {
    const old = { ...base(), texts: [{ ref: 0, text: "First", start: 0, length: 3, size: 10, x: 0.3, y: 0.2, color: "#ff0000" },
                                     { ref: 1, text: "Second", start: 1, length: 1 }, { text: "Third", start: 3, length: 1 }],
                  off: { T: true } };
    const cut = D.textsToTitles(old);
    assert.equal(cut.texts.length, 0);
    const added = cut.tracks.filter((k) => k.clips.some((c) => c.title));
    assert.equal(added.length, 2, "two texts overlap: two tracks");
    assert.ok(added.every((k) => k.off), "the texts' switch is the tracks' switch");
    const first = added[0].clips[0];
    assert.equal(first.title.text, "First");
    assert.equal(first.title.size, 10);
    assert.equal(first.title.x, 0.3);
    assert.equal(first.title.color, "#ff0000");
    assert.equal(first.mark, 0);
    assert.equal(added[0].clips[1].title.text, "Third", "the third fits after the first");
    assert.equal(D.toSave(cut).tracks.find((k) => k.id === added[0].id).clips[0].mark, 0);
    assert.equal(D.textsToTitles(base()).tracks.length, 1, "no texts: as it was");
});

test("Paste Attributes: a title's look goes onto titles, its words stay; video attributes as for clips", () => {
    const a = withTitle(0, 2);
    const b = D.addTitle(a.cut, { text: "Other", size: 3 }, 0, 2);
    let cut = D.setTitle(b.cut, [a.sel], { bold: true, size: 15, color: "#00ff00", align: "left" });
    cut = D.setClipFx(cut, a.sel, { op: 0.5 });
    const src = D.pasteSource(cut, a.sel);
    assert.equal(src.caps.title, true);
    const offer = D.pasteOffer(cut, src, [b.sel, { kind: "clip", i: 0 }]);
    assert.ok(offer.textlook.source && offer.textlook.targets);
    assert.ok(!offer.speed.source, "a title has no speed");
    const next = D.pasteAttributes(cut, src, [b.sel, { kind: "clip", i: 0 }], { textlook: true, opacity: true });
    const t = D.clipOf(next, b.sel).title;
    assert.equal(t.text, "Other", "the words are its own");
    assert.equal(t.bold, true);
    assert.equal(t.size, 15);
    assert.equal(t.align, "left");
    near(D.clipOf(next, b.sel).fx.op, 0.5);
    near(next.clips[0].fx.op, 0.5, "a clip takes the opacity");
    assert.equal(next.clips[0].title, undefined);
});

test("layoutTitle: alignment, wrapping, valign, tracking and the box", () => {
    const measure = (ch) => (ch === " " ? 5 : 10);           // 10 px a letter, 5 a space
    const look = { text: "ab cd", size: 10, x: 0.5, y: 0.5, w: 0.5, h: 0.5, line: 1, align: "left", valign: "top" };
    const W = 200, H = 100;                                  // px = 10; box 100 x 50 at (50, 25)
    let L = T.layoutTitle(look, W, H, measure, { asc: 0.8, desc: 0.2 });
    assert.equal(L.px, 10);
    assert.equal(L.lines.length, 1);
    near(L.lines[0].x0, 50);
    near(L.lines[0].x1, 50 + 45);
    near(L.lines[0].base, 25 + 8, "top + (lineH - em)/2 + asc");
    L = T.layoutTitle({ ...look, align: "right" }, W, H, measure);
    near(L.lines[0].x1, 150);
    L = T.layoutTitle({ ...look, align: "center", valign: "bottom" }, W, H, measure, { asc: 0.8, desc: 0.2 });
    near(L.lines[0].x0, 50 + (100 - 45) / 2);
    near(L.lines[0].top, 75 - 10);
    // Wrapping at the box's width, and justify stretches all but the last line of a paragraph.
    L = T.layoutTitle({ ...look, text: "aaaa bbbb cccc", align: "justify" }, W, H, measure);
    assert.deepEqual(L.lines.map((l) => l.text), ["aaaa bbbb", "cccc"]);
    near(L.lines[0].x1, 150, "justified to the box's width");
    near(L.lines[1].x1, 50 + 40, "the last line is not stretched");
    // Tracking: thousandths of an em after every letter but the last.
    L = T.layoutTitle({ ...look, text: "abc", track: 100 }, W, H, measure);
    near(L.lines[0].x1 - L.lines[0].x0, 30 + 2 * 1);
    near(L.lines[0].glyphs[1].x - L.lines[0].glyphs[0].x, 11);
    // Upper case, underline, the background box with its padding.
    L = T.layoutTitle({ ...look, text: "ab", caps: "upper", underline: true, bgo: 0.5, bgp: 50 }, W, H, measure);
    assert.equal(L.lines[0].text, "AB");
    assert.equal(L.under.length, 1);
    near(L.box.x0, 50 - 5);
    near(L.box.x1, 70 + 5);
    // Synthetic styles.
    L = T.layoutTitle({ ...look, sw: 10 }, W, H, measure, undefined, { bold: true, italic: true });
    assert.equal(L.strokePx, 1);
    assert.equal(L.boldPx, 1);
    assert.equal(L.italic, true);
});

test("resolveFace: the face asked for, the nearest with synthetic styles, a fallback family", () => {
    const fonts = [{ family: "Arial", faces: { regular: { id: "a" }, bold: { id: "ab" } } },
                   { family: "Mono", faces: { regular: { id: "m" } } }];
    assert.equal(T.resolveFace(fonts, "arial", true, false).face.id, "ab");
    const bi = T.resolveFace(fonts, "Arial", true, true);
    assert.equal(bi.face.id, "ab");
    assert.equal(bi.italic, true);
    assert.equal(bi.bold, false);
    const m = T.resolveFace(fonts, "Mono", true, false);
    assert.equal(m.face.id, "m");
    assert.equal(m.bold, true);
    const gone = T.resolveFace(fonts, "Nope", false, false);
    assert.equal(gone.family, "Arial");
    assert.equal(gone.missing, true);
    const none = T.resolveFace([], "Georgia", false, false);
    assert.equal(none.web, true);
    assert.equal(none.missing, false, "a web-safe family is drawn by the browser's own fonts");
});
