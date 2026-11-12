// The arithmetic of a film on an image plane (js/imageViewer_view3dVideoPlane.js).
// Run: node --test tests/test_view3d_video_plane.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { isVideoSrc, videoTime } from "../js/imageViewer_view3dVideoPlane.js";

test("a film is told from a still by its kind or its name", () => {
    assert.equal(isVideoSrc({ path: "D:/out/plate.mp4" }), true);
    assert.equal(isVideoSrc({ filename: "clip.MOV", type: "output" }), true);
    assert.equal(isVideoSrc({ kind: "video", filename: "upload_123" }), true);
    assert.equal(isVideoSrc({ path: "D:/out/still.png" }), false);
    assert.equal(isVideoSrc({ path: "D:/out/still.exr" }), false);
    assert.equal(isVideoSrc(null), false);
});

test("the scene frame is the film's frame, read at its middle", () => {
    assert.equal(videoTime(0, 24, 10), 0.5 / 24);
    assert.equal(videoTime(12, 24, 10), 12.5 / 24);
    assert.equal(videoTime(12.7, 24, 10), 12.5 / 24);
    assert.equal(videoTime(48, 25, 10), 48.5 / 25);
});

test("before its start the first frame shows, past its end the last is held", () => {
    assert.equal(videoTime(-5, 24, 2), 0);
    assert.equal(videoTime(1000, 24, 2), 2 - 0.5 / 24);
    assert.equal(videoTime(10, 24, 2, 8), 2.5 / 24);
    assert.equal(videoTime(5, 24, 2, 8), 0);
});

test("no duration yet, no fps: still a time", () => {
    assert.equal(videoTime(24, 24, NaN), 24.5 / 24);
    assert.equal(videoTime(24, 0, 10), 24.5 / 24);
});
