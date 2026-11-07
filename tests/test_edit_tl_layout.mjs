// node --test tests/test_edit_tl_layout.mjs
// The timeline's own layout arithmetic (imageViewer_editTimelineData.js): the playhead readout left of the
// ruler (timecode or frames, and what is typed into it), Shift + wheel track heights, the splitter between
// the video and the sound section. The panel side is in tests/test_edit_timeline_browser.py (test_26_*).
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

test("the readout: a timecode at the cut's fps, or the frame's number", () => {
    assert.equal(D.playheadLabel(0, 24, "tc"), "00:00:00:00");
    assert.equal(D.playheadLabel(25, 24, "tc"), "00:00:01:01");
    assert.equal(D.playheadLabel(24 * 3661 + 5, 24, "tc"), "01:01:01:05");
    assert.equal(D.playheadLabel(30, 30, "tc"), "00:00:01:00");
    assert.equal(D.playheadLabel(29, 30, "tc"), "00:00:00:29");
    // 23.976: the frames count at 24 a second, as the in / out's titles do (D.timecode).
    assert.equal(D.playheadLabel(24, 23.976, "tc"), "00:00:01:00");
    assert.equal(D.playheadLabel(25, 24, "frames"), "25");
    assert.equal(D.playheadLabel(-3, 24, "frames"), "0");
    assert.equal(D.playheadLabel(12.6, 24, "frames"), "13");
});

test("typed into the readout: a timecode, fewer parts, a frame number, on / back", () => {
    assert.equal(D.parsePlayhead("00:00:01:01", 24), 25);
    assert.equal(D.parsePlayhead("1:00", 24), 24);            // SS:FF
    assert.equal(D.parsePlayhead("2:00:00", 24), 2 * 60 * 24); // MM:SS:FF
    assert.equal(D.parsePlayhead("01;00;00;12", 25), 3600 * 25 + 12);
    assert.equal(D.parsePlayhead("1.12", 30), 42);
    assert.equal(D.parsePlayhead(" 120 ", 24), 120);
    assert.equal(D.parsePlayhead("+10", 24, 100), 110);
    assert.equal(D.parsePlayhead("-1:00", 24, 100), 76);
    assert.equal(D.parsePlayhead("-500", 24, 100), 0);
    for (const bad of ["", "  ", "abc", "1:2:3:4:5", "1::2", "12a"]) assert.equal(D.parsePlayhead(bad, 24), null, bad);
});

test("Shift + wheel: a row an eighth taller or lower a notch, at least a pixel, within 12..160", () => {
    assert.equal(D.stepTrackHeight(44, 1), 50);
    assert.equal(D.stepTrackHeight(44, -1), 39);
    assert.equal(D.stepTrackHeight(12, 1), 14);
    assert.equal(D.stepTrackHeight(13, -1), 12);
    assert.equal(D.stepTrackHeight(12, -1), 12);
    assert.equal(D.stepTrackHeight(155, 1), 160);
    assert.equal(D.stepTrackHeight(160, 1), 160);
    assert.equal(D.stepTrackHeight(500, -1), 142);
    // Notches there and back come home near where they began.
    let h = 30;
    for (let i = 0; i < 5; i++) h = D.stepTrackHeight(h, 1);
    for (let i = 0; i < 5; i++) h = D.stepTrackHeight(h, -1);
    assert.ok(Math.abs(h - 30) <= 2, String(h));
});

test("the splitter: dragged it stays where it was put; else the video tracks' height, up to 70 % when not all fits", () => {
    // Everything fits: the video section is as tall as its tracks.
    assert.equal(D.splitHeight(null, 400, 150, 100), 150);
    // Not all fits: the video gets up to 70 %, more where the sound needs less.
    assert.equal(D.splitHeight(null, 400, 500, 300), 280);
    assert.equal(D.splitHeight(null, 400, 250, 300), 250);
    assert.equal(D.splitHeight(null, 400, 500, 50), 350);
    assert.equal(D.splitHeight(null, 400, 120, 600), 120);
    // Dragged: where it was put, each section keeping 24 px.
    assert.equal(D.splitHeight(90, 400, 500, 300), 90);
    assert.equal(D.splitHeight(5, 400, 500, 300), 24);
    assert.equal(D.splitHeight(399, 400, 500, 300), 376);
    // A panel too short for two minimums: halves.
    assert.equal(D.splitHeight(null, 30, 100, 100), 15);
    assert.equal(D.splitHeight(null, 0, 100, 100), 0);
});
