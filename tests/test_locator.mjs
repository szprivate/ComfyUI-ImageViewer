// Locators (nulls) in the 3D scene model (imageViewer_scene3d.js) and the Outliner (imageViewer_outlinerData.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_scene3d.js";
import { outlinerKindOf, OUTLINER_KINDS } from "../js/imageViewer_outlinerData.js";

test("a locator is a group with a size, kept by a save and a load", () => {
    const loc = S.makeLocatorItem("Locator", 2.5);
    assert.equal(loc.kind, "group");
    assert.ok(S.isLocator(loc));
    assert.equal(S.locatorSize(loc), 2.5);
    const scene = S.makeScene({ items: [loc, { ...S.makeModelItem({ filename: "a.glb" }, "a"), parent: loc.id }] });
    const back = S.parseScene(S.serializeScene(scene));
    const again = back.items.find((i) => i.id === loc.id);
    assert.ok(S.isLocator(again));
    assert.equal(S.locatorSize(again), 2.5);
    assert.equal(back.items[1].parent, loc.id);
    // Keyed like any transform.
    S.setKeyframe(again, "position", 10, [1, 2, 3]);
    assert.deepEqual(S.evaluateIn(back, again, 10).position, [1, 2, 3]);
    // A plain group stays a group; a bad size falls back to 1.
    assert.equal(S.isLocator(S.makeGroupItem("g")), false);
    assert.equal(S.locatorSize({ locator: { size: -3 } }), 1);
});

test("the Outliner shows a locator as a kind of its own", () => {
    const loc = S.makeLocatorItem("L");
    assert.equal(outlinerKindOf(loc), "locator");
    assert.equal(outlinerKindOf(S.makeGroupItem("G")), "group");
    assert.ok(OUTLINER_KINDS.some((k) => k.key === "locator"));
});
