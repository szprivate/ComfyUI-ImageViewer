// node --test tests/test_rig_lipsync.mjs
// Lip sync: mouth curves onto the character's own blendshapes (imageViewer_rigLipsync.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../js/imageViewer_rigLipsync.js";

const curves = { frames: 4, open: [0, 1, 0.2, 0], round: [0, 0, 1, 0], wide: [0, 0, 0, 0], closed: [0, 0, 0, 1], hiss: [0, 0, 0, 0] };

test("ARKit names are found whatever their spelling, and only the ones there are used", () => {
    const set = L.pickSet(["JawOpen", "mouth_funnel", "mouthClose", "browInnerUp"]);
    assert.equal(set.id, "arkit");
    assert.deepEqual(Object.keys(set.shapes).sort(), ["JawOpen", "mouthClose", "mouth_funnel"]);
    const k = L.lipKeys(curves, set, 10, { tol: 0 });
    const at = (name, f) => k[name].find((x) => x.f === f).v;
    assert.deepEqual(k.JawOpen.map((x) => x.f), [10, 11, 12, 13]);
    assert.ok(at("JawOpen", 11) > 0.8);
    assert.ok(at("mouth_funnel", 12) > 0.25, "a round open mouth funnels");
    assert.equal(at("mouthClose", 13), 0.7);
});

test("viseme sets, and a single mouth-open shape, and nothing", () => {
    assert.equal(L.pickSet(["viseme_aa", "viseme_O", "viseme_PP"]).id, "visemes");
    const one = L.pickSet(["Smile", "MouthOpen"]);
    assert.equal(one.id, "open");
    assert.deepEqual(Object.keys(one.shapes), ["MouthOpen"]);
    assert.equal(L.pickSet(["Smile", "Blink"]), null);
});

test("keys on a straight line are thinned, the ends kept", () => {
    const keys = [0, 1, 2, 3, 4].map((f) => ({ f, v: f / 4 }));
    assert.deepEqual(L.thin(keys, 0.01).map((k) => k.f), [0, 4]);
    const bump = [0, 0, 1, 0, 0].map((v, f) => ({ f, v }));
    assert.deepEqual(L.thin(bump, 0.01).map((k) => k.f), [0, 1, 2, 3, 4]);
});
