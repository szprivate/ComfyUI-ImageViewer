// The default view cameras (imageViewer_scene3d.js): the main perspective view
// and the six flat views each have a normal scene camera (Sebastian 2026-11-22)
// - every scene starts with them, hidden, the Outliner lists them, USD keeps
// them, and navigating a view moves its camera like any other. The flat ones
// are orthographic: their `ortho` is the width of their picture in world units.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScene, parseScene, serializeScene, cameras, defaultViewCamera,
         makeDefaultViewCamera, untouchedDefaultViewCamera, lookRotation,
         DEFAULT_VIEW_CAMERAS } from "../js/imageViewer_scene3d.js";

const VIEWS = DEFAULT_VIEW_CAMERAS.map((s) => s.view);
const FLATS = DEFAULT_VIEW_CAMERAS.filter((s) => s.up).map((s) => s.view);

test("a new scene starts with the seven default view cameras, hidden", () => {
    const scene = makeScene();
    assert.deepEqual(cameras(scene).map((c) => c.view), VIEWS);
    assert.equal(scene.items.length, 7);             // nothing else in a new scene
    // Furniture, not content: the Outliner's eye starts off on all of them.
    assert.deepEqual(cameras(scene).map((c) => c.visible), [false, false, false, false, false, false, false]);
    // The flat ones are orthographic, the perspective one is not.
    for (const view of VIEWS) {
        const cam = defaultViewCamera(scene, view);
        if (FLATS.includes(view)) {
            assert.equal(cam.projection, "orthographic", view);
            assert.equal(cam.ortho, 4, view);
        } else {
            assert.equal(cam.projection, undefined, view);
        }
    }
});

test("every default camera looks at the scene from its own side, upright as its view", () => {
    for (const spec of DEFAULT_VIEW_CAMERAS) {
        const item = makeDefaultViewCamera(spec);
        // The camera's forward (-Z turned by its rotation) points at the target,
        // and its +Y is the view's up.
        const [rx, ry, rz] = item.rotation.map((d) => d * Math.PI / 180);
        const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry),
              cz = Math.cos(rz), sz = Math.sin(rz);
        const rot = (v) => {
            let [x, y, z] = v;
            [x, y, z] = [cz * x - sz * y, sz * x + cz * y, z];            // RZ
            [x, y, z] = [cy * x + sy * z, y, -sy * x + cy * z];           // RY
            [x, y, z] = [x, cx * y - sx * z, sx * y + cx * z];            // RX
            return [x, y, z];
        };
        const fwd = rot([0, 0, -1]), up = rot([0, 1, 0]);
        const wantUp = spec.up || [0, 1, 0];
        const l = Math.hypot(...spec.from);
        const dot = (fwd[0] * -spec.from[0] + fwd[1] * -spec.from[1] + fwd[2] * -spec.from[2]) / l;
        assert.ok(dot > 0.999, `${spec.view} looks at the scene (${dot})`);
        const ud = (up[0] * wantUp[0] + up[1] * wantUp[1] + up[2] * wantUp[2]);
        // A flat view stands exactly upright; the tilted perspective view only
        // leans with its own tilt (no roll).
        assert.ok(ud > (spec.up ? 0.999 : 0.9), `${spec.view} stands upright (${ud})`);
        assert.ok(untouchedDefaultViewCamera(item));
    }
    // Straight down keeps an up axis without NaN.
    assert.ok(lookRotation([0, 5, 0], [0, 0, 0], [0, 0, -1]).every((v) => Number.isFinite(v)));
});

test("an older scene gains the cameras it lacks, a saved one keeps its own", () => {
    const old = parseScene({ items: [{ kind: "model", name: "hero", src: { path: "/x.usd" } }] });
    assert.deepEqual(cameras(old).map((c) => c.view), VIEWS);
    assert.equal(old.items.length, 8);               // the model stays, ahead of the cameras
    assert.equal(old.items[0].name, "hero");

    const kept = parseScene(serializeScene(old));
    assert.deepEqual(cameras(kept).map((c) => c.id), cameras(old).map((c) => c.id));
    assert.deepEqual(cameras(kept).map((c) => c.view), VIEWS);
    assert.equal(defaultViewCamera(kept, "top").projection, "orthographic");

    // A moved default stays where it was put: seeding never fights the user.
    const moved = parseScene(serializeScene(old));
    const top = defaultViewCamera(moved, "top");
    top.ortho = 12;
    assert.equal(untouchedDefaultViewCamera(top), false);
    const again = parseScene(serializeScene(moved));
    assert.equal(defaultViewCamera(again, "top").ortho, 12);
});

test("two cameras claiming a view: the first keeps the flag", () => {
    const scene = parseScene({ items: [
        { kind: "camera", name: "a", view: "top" },
        { kind: "camera", name: "b", view: "top" },
    ] });
    const flagged = cameras(scene).filter((c) => c.view === "top");
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].name, "a");
    // The other views are seeded; top is not seeded twice. The camera that lost
    // the flag stays - it is a camera like any other.
    assert.equal(cameras(scene).length, VIEWS.length + 1);
});
