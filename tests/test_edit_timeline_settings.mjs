// node --test tests/test_edit_timeline_settings.mjs
// The timeline's settings (imageViewer_editTimelineData.js): its size, frame rate and scaling, the
// first picture into an empty timeline giving them, and where a picture of another size is drawn.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} != ${b}`);

test("a cut's settings, every part present; 0 is a size not set", () => {
    assert.deepEqual(D.cutSettings(D.emptyCut("c")), { fps: 24, width: 0, height: 0, fit: "fit", setBy: "" });
    assert.deepEqual(D.cutSettings({ fps: 25, width: 1920, height: 1080, fit: "fill", setBy: "hand" }),
                     { fps: 25, width: 1920, height: 1080, fit: "fill", setBy: "hand" });
    assert.equal(D.cutSettings({ fps: 25, width: 99999, height: 10, fit: "zoom" }).width, 0);
    assert.equal(D.cutSettings({ fit: "zoom" }).fit, "fit");
});

test("setCutSettings changes what is given, marks it as set by hand and leaves the clips where they are", () => {
    const cut = { ...D.emptyCut("c"), clips: [shot("a.mp4", 2), shot("b.mp4", 3)] };
    const next = D.setCutSettings(cut, { fps: 25, width: 1280, height: 720 });
    assert.equal(next.fps, 25);
    assert.equal(next.width, 1280);
    assert.equal(next.height, 720);
    assert.equal(next.setBy, "hand");
    assert.deepEqual(next.clips, cut.clips);
    assert.equal(cut.fps, 24, "the cut it was given is left alone");
    assert.equal(D.setCutSettings(next, { fit: "stretch" }).fit, "stretch");
    assert.equal(D.setCutSettings(next, { width: -5, height: 3 }).width, 1280, "a size that cannot be is refused");
    assert.equal(D.setCutSettings(next, { fps: 0 }).fps, 25);
});

test("the first picture into a timeline with no picture gives it its size and rate", () => {
    const cut = D.emptyCut("c");
    const got = D.adoptSettings(cut, { width: 3840, height: 2160, fps: 25, still: false });
    assert.equal(got.cut.width, 3840);
    assert.equal(got.cut.height, 2160);
    assert.equal(got.cut.fps, 25);
    assert.equal(got.cut.setBy || "", "", "taken from a clip, not set by hand");
    assert.match(got.took, /3840x2160/);
    // A picture has no rate: only its size.
    const pic = D.adoptSettings(cut, { width: 1080, height: 1920, fps: 0, still: true });
    assert.equal(pic.cut.fps, 24);
    assert.equal(pic.cut.width, 1080);
    // Not when the timeline has a picture, nor when its settings were set by hand.
    const full = { ...cut, clips: [shot("a.mp4", 2)] };
    assert.equal(D.adoptSettings(full, { width: 640, height: 480, fps: 30 }).cut, full);
    const hand = D.setCutSettings(cut, { fps: 50 });
    assert.equal(D.adoptSettings(hand, { width: 640, height: 480, fps: 30 }).cut, hand);
    // Sound on a track and titles do not count as a picture; a film on a video track does.
    const sound = { ...cut, tracks: [{ id: "A2", kind: "audio", name: "A2", clips: [{ ...shot("s.wav", 4), at: 0 }] },
                                     { id: "V2", kind: "video", name: "V2", clips: [{ ...shot("", 2), at: 0, title: { text: "hi" } }] }] };
    assert.ok(D.pictureless(sound));
    const placed = { ...cut, tracks: [{ id: "V2", kind: "video", name: "V2", clips: [{ ...shot("b.mp4", 2), at: 0 }] }] };
    assert.ok(!D.pictureless(placed));
});

test("the settings are saved, always stated, and a change of them is a change of the cut", () => {
    const cut = { ...D.emptyCut("c"), clips: [shot("a.mp4", 2)] };
    assert.deepEqual(D.toSave(cut).settings, { fps: 24, width: 0, height: 0, fit: "fit", set_by: "" });
    const next = D.setCutSettings(cut, { width: 1920, height: 1080, fit: "fill" });
    assert.deepEqual(D.toSave(next).settings, { fps: 24, width: 1920, height: 1080, fit: "fill", set_by: "hand" });
    assert.ok(!D.sameCut(cut, next));
    assert.ok(D.sameCut(next, { ...next }));
});

test("a clip's own Scaling is kept in its effect and wins over the timeline's", () => {
    assert.deepEqual(D.cleanFx({ fit: "fill", zx: 1 }), { fit: "fill" });
    assert.deepEqual(D.cleanFx({ fit: "squash" }), {});
    const cut = { ...D.emptyCut("c"), fit: "fill", clips: [shot("a.mp4", 2), shot("b.mp4", 2, { fx: { fit: "none" } })] };
    assert.equal(D.clipFit(cut, cut.clips[0]), "fill");
    assert.equal(D.clipFit(cut, cut.clips[1]), "none");
    const set = D.setClipFx(cut, { kind: "clip", i: 0 }, { fit: "stretch" });
    assert.equal(D.clipFit(set, set.clips[0]), "stretch");
    assert.equal(D.toSave(set).clips[0].fx.fit, "stretch");
    const back = D.setClipFx(set, { kind: "clip", i: 0 }, { fit: "" });
    assert.equal(D.clipFit(back, back.clips[0]), "fill", "back to the timeline's");
});

test("fitBox: fit, fill, stretch, none (timeline_render.fit)", () => {
    assert.deepEqual(D.fitBox(1280, 720, 1920, 1080, "fit"), { w: 1920, h: 1080 });
    assert.deepEqual(D.fitBox(1000, 1000, 1920, 1080, "fit"), { w: 1080, h: 1080 });
    assert.deepEqual(D.fitBox(1000, 1000, 1920, 1080, "fill"), { w: 1920, h: 1920 });
    assert.deepEqual(D.fitBox(1000, 1000, 1920, 1080, "stretch"), { w: 1920, h: 1080 });
    assert.deepEqual(D.fitBox(640, 480, 1920, 1080, "none"), { w: 640, h: 480 });
});

test("layerPlace: the frame fitted into the layer, the picture brought into the frame", () => {
    // A 1000 x 500 layer, a 16:9 timeline: the frame is 888.9 x 500 in the middle.
    const g = D.layerPlace(1080, 1080, 1000, 500, 1920, 1080, "fit");
    near(g.frame.w, 500 * 16 / 9);
    near(g.frame.h, 500);
    near(g.frame.x, (1000 - 500 * 16 / 9) / 2);
    // A square picture fitted: 500 x 500, which is also how the layer shows it whole - no scale.
    near(g.box.w, 500);
    near(g.sx, 1);
    near(g.sy, 1);
    // Filled: as wide as the frame, so scaled up from the layer's own picture.
    const f = D.layerPlace(1080, 1080, 1000, 500, 1920, 1080, "fill");
    near(f.box.w, 500 * 16 / 9);
    near(f.box.h, 500 * 16 / 9);
    near(f.sx, 16 / 9);
    // Its own pixels: a 960 x 540 picture in a 1920 x 1080 frame is half the frame.
    const n = D.layerPlace(960, 540, 1000, 500, 1920, 1080, "none");
    near(n.box.w, n.frame.w / 2);
    // No size for the timeline: the frame is the picture, as before.
    const old = D.layerPlace(800, 600, 1000, 500, 0, 0, "fill");
    near(old.frame.w, old.box.w);
    near(old.sx, 1);
});

test("fxPlace: a picture larger than the frame is cut off at the frame; a crop is of the picture", () => {
    const frame = { x: 100, y: 0, w: 800, h: 450 };
    const box = { x: 100, y: -175, w: 800, h: 800 };              // a square filling a 16:9 frame
    const p = D.fxPlace(D.NEUTRAL_FX, box, frame);
    assert.equal(p.transform, "");
    assert.deepEqual(p.poly.map(([x, y]) => [Math.round(x), Math.round(y)]), [[100, 0], [900, 0], [900, 450], [100, 450]]);
    // Fitted inside the frame: nothing to cut.
    assert.equal(D.fxPlace(D.NEUTRAL_FX, { x: 275, y: 0, w: 450, h: 450 }, frame).clip, "");
    // A crop of 10 % off the left is 10 % of the PICTURE's width; a position is of the FRAME's.
    const c = D.fxPlace({ ...D.NEUTRAL_FX, cl: 0.1 }, { x: 275, y: 0, w: 450, h: 450 }, frame);
    near(Math.min(...c.poly.map((q) => q[0])), 275 + 45);
    const m = D.fxPlace({ ...D.NEUTRAL_FX, x: 0.25 }, { x: 275, y: 0, w: 450, h: 450 }, frame);
    assert.match(m.transform, /^translate\(200px, 0px\)/);
    // Without a frame it is the box, as it always was.
    const same = D.fxPlace({ ...D.NEUTRAL_FX, cl: 0.1 }, { x: 0, y: 0, w: 100, h: 50 });
    near(Math.min(...same.poly.map((q) => q[0])), 10);
});
