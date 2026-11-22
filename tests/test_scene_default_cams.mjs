// The default view camera (imageViewer_scene3d.js): the main perspective view's
// camera is a normal scene camera (Sebastian 2026-11-22) - every scene starts
// with it, hidden, the Outliner lists it, USD keeps it, and navigating the view
// moves it like any other camera. The extra perspective views keep cameras of
// their own in the viewer instead (imageViewer_view3dPanes.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScene, parseScene, serializeScene, cameras, defaultViewCamera,
         makeDefaultViewCamera, untouchedDefaultViewCamera, lookRotation,
         DEFAULT_VIEW_CAMERAS } from "../js/imageViewer_scene3d.js";

const VIEWS = DEFAULT_VIEW_CAMERAS.map((s) => s.view);

test("a new scene starts with the one default view camera, hidden", () => {
    const scene = makeScene();
    assert.deepEqual(cameras(scene).map((c) => c.view), VIEWS);
    assert.deepEqual(cameras(scene).map((c) => c.name), ["Perspective"]);
    assert.equal(scene.items.length, 1);             // nothing else in a new scene
    // Furniture, not content: the Outliner's eye starts off on it.
    assert.equal(scene.items[0].visible, false);
    assert.equal(defaultViewCamera(scene, "persp").kind, "camera");
});

test("the default camera looks at the scene from its own side", () => {
    for (const spec of DEFAULT_VIEW_CAMERAS) {
        const item = makeDefaultViewCamera(spec);
        // The camera's forward (-Z turned by its rotation) points at the target.
        const [rx, ry] = item.rotation.map((d) => d * Math.PI / 180);
        const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
        // v' = RX * RY * RZ * v, three's XYZ order, on (0, 0, -1); RZ leaves it.
        let [x, y, z] = [0, 0, -1];
        [x, y, z] = [cy * x + sy * z, y, -sy * x + cy * z];            // RY
        [x, y, z] = [x, cx * y - sx * z, sx * y + cx * z];             // RX
        const l = Math.hypot(...spec.from);
        const dot = (x * -spec.from[0] + y * -spec.from[1] + z * -spec.from[2]) / l;
        assert.ok(dot > 0.999, `${spec.view} looks at the scene (${dot})`);
        assert.ok(untouchedDefaultViewCamera(item));
    }
    // Straight down keeps +Z as up's fallback axis without NaN.
    const down = lookRotation([0, 5, 0], [0, 0, 0]);
    assert.ok(down.every((v) => Number.isFinite(v)));
});

test("an older scene gains the camera it lacks, a saved one keeps its own", () => {
    const old = parseScene({ items: [{ kind: "model", name: "hero", src: { path: "/x.usd" } }] });
    assert.deepEqual(cameras(old).map((c) => c.view), VIEWS);
    assert.equal(old.items.length, 2);               // the model stays, ahead of the camera
    assert.equal(old.items[0].name, "hero");

    const kept = parseScene(serializeScene(old));
    assert.deepEqual(cameras(kept).map((c) => c.id), cameras(old).map((c) => c.id));
    assert.deepEqual(cameras(kept).map((c) => c.view), VIEWS);

    // A moved default stays where it was put: seeding never fights the user.
    const moved = parseScene(serializeScene(old));
    const persp = defaultViewCamera(moved, "persp");
    persp.position = [1, 2, 3];
    assert.equal(untouchedDefaultViewCamera(persp), false);
    const again = parseScene(serializeScene(moved));
    assert.deepEqual(defaultViewCamera(again, "persp").position, [1, 2, 3]);
});

test("two cameras claiming the view: the first keeps the flag", () => {
    const scene = parseScene({ items: [
        { kind: "camera", name: "a", view: "persp" },
        { kind: "camera", name: "b", view: "persp" },
    ] });
    const flagged = cameras(scene).filter((c) => c.view === "persp");
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].name, "a");
    // The view is taken, so nothing is seeded; the camera that lost the flag
    // stays - it is a camera like any other.
    assert.equal(cameras(scene).length, 2);
});
