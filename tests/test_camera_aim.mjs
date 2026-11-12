// A camera's look-at target (imageViewer_cameraAim.js), the pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AIM_PROPS, ROLL_PROP, aimOn, aimSettings, defaultAimTarget, forwardOf, readAim } from "../js/imageViewer_cameraAim.js";
import * as S from "../js/imageViewer_scene3d.js";

const near = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test("a new camera has its look-at off", () => {
    const cam = S.makeCameraItem("Cam");
    assert.equal(aimOn(cam), false);
    assert.equal(aimSettings(cam).on, false);
});

test("a camera with no rotation looks down -Z; turned, as three turns it", () => {
    assert.ok(near(forwardOf([0, 0, 0]), [0, 0, -1]));
    assert.ok(near(forwardOf([0, 90, 0]), [-1, 0, 0]));
    assert.ok(near(forwardOf([-90, 0, 0]), [0, -1, 0]));
    // Roll does not change where it looks.
    assert.ok(near(forwardOf([0, 0, 45]), [0, 0, -1]));
});

test("a target switched on lands where the camera already looks", () => {
    // At (0, 0, 10) looking down -Z: the origin is 10 in front of it.
    assert.ok(near(defaultAimTarget({ position: [0, 0, 10], rotation: [0, 0, 0] }), [0, 0, 0]));
    // Looking away from the origin: ten units ahead.
    assert.ok(near(defaultAimTarget({ position: [0, 0, 10], rotation: [0, 180, 0] }), [0, 0, 20], 1e-6));
    // A distance given (the orbit centre) wins.
    assert.ok(near(defaultAimTarget({ position: [0, 0, 10], rotation: [0, 0, 0] }, 4), [0, 0, 6]));
});

test("the target's numbers are channels: static, then keyed", () => {
    const cam = S.makeCameraItem("Cam", { aim: { on: true, target: [1, 2, 3] } });
    assert.deepEqual(AIM_PROPS.map((p) => S.staticValue(cam, p)), [1, 2, 3]);
    S.setStaticValue(cam, "aim:y", 5);
    assert.deepEqual(cam.aim.target, [1, 5, 3]);
    assert.ok(S.isTrackProp("aim:x"));
    S.setKeyframe(cam, "aim:x", 0, 0);
    S.setKeyframe(cam, "aim:x", 10, 10);
    const mid = S.valueAt(cam, "aim:x", 5);
    assert.ok(mid > 0 && mid < 10);
    assert.equal(S.evaluate(cam, 10)["aim:x"], 10);
});

test("a scene keeps a camera's look-at, and a camera without one stays without", () => {
    const scene = S.parseScene({
        items: [
            { id: "c1", kind: "camera", name: "A", aim: { on: true, target: [1, 0, -2] } },
            { id: "c2", kind: "camera", name: "B" },
            { id: "c3", kind: "camera", name: "C", aim: { on: "yes", target: ["x", 1, 2] } },
        ],
    });
    const [a, b, c] = scene.items;
    assert.deepEqual(a.aim, { on: true, target: [1, 0, -2] });
    assert.equal(b.aim, undefined);
    assert.equal(c.aim, undefined);
    assert.equal(readAim({ on: false, target: [0, 0, 0] }).on, false);
});

test("the roll is a channel of its own, kept with the scene", () => {
    const cam = S.makeCameraItem("Cam", { aim: { on: true, target: [0, 0, 0] } });
    assert.equal(S.staticValue(cam, ROLL_PROP), 0);
    S.setStaticValue(cam, ROLL_PROP, 30);
    assert.equal(cam.aim.roll, 30);
    assert.deepEqual(cam.aim.target, [0, 0, 0]);
    S.setKeyframe(cam, ROLL_PROP, 0, 0);
    S.setKeyframe(cam, ROLL_PROP, 10, 90);
    assert.equal(S.valueAt(cam, ROLL_PROP, 10), 90);
    const back = S.parseScene({ items: [{ id: "c", kind: "camera", aim: { on: true, target: [1, 2, 3], roll: 15 } }] });
    assert.deepEqual(back.items[0].aim, { on: true, target: [1, 2, 3], roll: 15 });
});
