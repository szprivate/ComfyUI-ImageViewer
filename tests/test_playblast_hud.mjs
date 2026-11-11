// node --test tests/test_playblast_hud.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { focalOf, hudFields, timecode } from "../js/imageViewer_playblastHud.js";

test("timecode and lens", () => {
    assert.equal(timecode(0, 24), "00:00:00:00");
    assert.equal(timecode(24 * 61 + 5, 24), "00:01:01:05");
    assert.equal(timecode(30, 29.97), "00:00:01:00");
    assert.ok(Math.abs(focalOf(2 * Math.atan(12 / 50) * 180 / Math.PI) - 50) < 1e-9, "50 mm on a 24 mm gate");
});

test("the corners say shot, camera and lens, frame, timecode", () => {
    const f = hudFields({ shot: "sh010", camera: "shotCam", fov: 2 * Math.atan(12 / 35) * 180 / Math.PI,
                          frame: 12, start: 0, end: 47, fps: 24, width: 960, height: 540,
                          date: new Date(2026, 10, 11, 9, 5), note: "blocking" });
    assert.equal(f.topLeft, "sh010");
    assert.equal(f.topRight, "shotCam · 35.0 mm");
    assert.equal(f.bottomLeft, "Frame 12  [0–47]");
    assert.equal(f.bottomCenter, "blocking");
    assert.equal(f.bottomRight, "00:00:00:12 · 24 fps · 960×540");
    assert.equal(hudFields({ date: new Date(2026, 10, 11, 9, 5) }).bottomCenter, "2026-11-11 09:05");
    assert.equal(hudFields({}).topRight, "Free view");
});
