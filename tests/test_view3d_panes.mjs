// The 3D view's multi-view layouts and orientation axes (imageViewer_view3dPanes.js), the pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneRects, cleanPaneState, setSlotView, axesLayout } from "../js/imageViewer_view3dPanes.js";

test("the layouts cover the stage with a 2 px divider", () => {
    const quad = paneRects("quad", [0.5, 0.5], 200, 100);
    assert.equal(quad.length, 4);
    assert.deepEqual(quad[0], { slot: 0, x: 0, y: 0, w: 99, h: 49 });
    assert.deepEqual(quad[3], { slot: 3, x: 101, y: 51, w: 99, h: 49 });
    const three = paneRects("3", [0.25, 0.5], 200, 100);
    assert.deepEqual(three.map((p) => p.h), [100, 49, 49]);
    assert.equal(three[1].x, 51);
    assert.deepEqual(paneRects("single", [0.5, 0.5], 200, 100, 2), [{ slot: 2, x: 0, y: 0, w: 200, h: 100 }]);
    // Dividers are held inside the stage.
    assert.equal(paneRects("2h", [0.99, 0.5], 100, 100)[0].w, 89);
});

test("a kept state is made whole, a view is in one pane only", () => {
    const s = cleanPaneState({ layout: "nope", views: ["top", "top", "front", "right"], focus: 9 });
    assert.equal(s.layout, "single");
    assert.deepEqual(s.views, ["top", "persp", "front", "right"]);
    assert.equal(s.focus, 1);
    assert.deepEqual(cleanPaneState({ views: ["top", "left", "front", "right"] }).views, ["persp", "left", "front", "right"]);
    assert.deepEqual(setSlotView(["top", "persp", "front", "right"], 0, "persp"), ["persp", "top", "front", "right"]);
    assert.deepEqual(setSlotView(["top", "persp", "front", "right"], 2, "back"), ["top", "persp", "back", "right"]);
});

test("the axes turn with the camera", () => {
    // Looking down -Z (no turn): X to the right, Y up, Z at the viewer.
    const at = Object.fromEntries(axesLayout([0, 0, 0, 1], 84, 28).map((a) => [a.id, a]));
    assert.ok(Math.abs(at.x.x - 70) < 1e-9 && Math.abs(at.x.y - 42) < 1e-9);
    assert.ok(Math.abs(at.y.y - 14) < 1e-9);
    assert.ok(at.z.depth > 0.99 && at["-z"].depth < -0.99);
    // Drawn back to front: the last is the nearest.
    const order = axesLayout([0, 0, 0, 1]);
    assert.equal(order[order.length - 1].id, "z");
    // A quarter turn about Y (looking down -X from +X): -Z is to the left... Z to the right... X at the viewer.
    const s = Math.SQRT1_2;
    const turned = Object.fromEntries(axesLayout([0, s, 0, s], 84, 28).map((a) => [a.id, a]));
    assert.ok(turned.x.depth > 0.99);
    assert.ok(turned["-z"].x > 69);
});
