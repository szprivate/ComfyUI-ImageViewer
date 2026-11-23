// Channels locked in the Channel Box (imageViewer_scene3d.js setChannelsLocked / setPose; Sebastian 2026-11-19).
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_scene3d.js";

const scene = () => {
    const sc = S.makeScene();
    const it = S.makePrimitiveItem("box");
    it.position = [1, 2, 3];
    sc.items.push(it);
    return { sc, it };
};

test("a locked component keeps its value in every edit, the others move", () => {
    const { sc, it } = scene();
    S.setChannelsLocked(it, ["position.1"], true);
    assert.deepEqual(S.lockedChannels(it), ["position.1"]);
    assert.ok(S.isChannelLocked(it, "position", 1));
    assert.ok(!S.isChannelLocked(it, "position", 0));
    S.setPose(sc, it, "position", 0, [5, 9, 7]);
    assert.deepEqual(it.position, [5, 2, 7]);
    // Keyed too: the key holds the locked value.
    S.setPose(sc, it, "position", 10, [6, 9, 8], { key: true });
    assert.deepEqual(S.valueAt(it, "position", 10), [6, 2, 8]);
});

test("a fully locked vector and a locked lone number are not written at all", () => {
    const { sc, it } = scene();
    S.setChannelsLocked(it, ["rotation.0", "rotation.1", "rotation.2"], true);
    S.setPose(sc, it, "rotation", 0, [10, 20, 30], { key: true });
    assert.deepEqual(it.rotation, [0, 0, 0]);
    assert.equal(S.track(it, "rotation").length, 0);
    const cam = S.makeCameraItem ? S.makeCameraItem("Camera") : null;
    if (cam) {
        sc.items.push(cam);
        const fov = cam.fov;
        S.setChannelsLocked(cam, ["fov"], true);
        S.setPose(sc, cam, "fov", 0, fov + 20);
        assert.equal(cam.fov, fov);
    }
});

test("unlocking gives the channel back and the lock survives a save", () => {
    const { sc, it } = scene();
    S.setChannelsLocked(it, ["scale.0", "position.2"], true);
    const back = S.parseScene(JSON.stringify(sc)).items.find((x) => x.id === it.id);
    assert.deepEqual(back.locked, ["position.2", "scale.0"]);
    S.setChannelsLocked(it, ["scale.0", "position.2"], false);
    assert.equal(it.locked, undefined);
    S.setPose(sc, it, "position", 0, [0, 0, 0]);
    assert.deepEqual(it.position, [0, 0, 0]);
    // Rubbish in a file is left out.
    assert.equal(S.readLocked(["", 3, "position.0", "position.0"]).length, 1);
    assert.equal(S.readLocked("nope"), null);
});
