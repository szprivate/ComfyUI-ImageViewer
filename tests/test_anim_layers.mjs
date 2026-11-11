// node --test tests/test_anim_layers.mjs
// Animation layers (imageViewer_animLayers.js + the edit target in scene3d.js), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/imageViewer_scene3d.js";
import * as L from "../js/imageViewer_animLayers.js";

const near = (a, b, eps = 1e-6, msg = "") => {
    if (Array.isArray(a)) a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}[${i}] ${x} vs ${b[i]}`));
    else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);
};

function sceneWithBox() {
    const scene = S.makeScene();
    const box = S.makePrimitiveItem("box", "Box");
    scene.items.push(box);
    S.bindScene(scene);
    // Base: x goes 0 -> 10 over frames 0..10.
    S.setKeyframe(box, "position", 0, [0, 0, 0], "linear");
    S.setKeyframe(box, "position", 10, [10, 0, 0], "linear");
    return { scene, box };
}

test("without layers, evaluateIn is the base", () => {
    const { scene, box } = sceneWithBox();
    near(S.evaluateIn(scene, box, 5).position, [5, 0, 0]);
    near(S.valueIn(scene, box, "position", 5), S.valueAt(box, "position", 5));
});

test("an additive layer adds its curve times its weight", () => {
    const { scene, box } = sceneWithBox();
    const layer = L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "position", 0, [0, 2, 0], "linear");      // goes to the layer (active)
    assert.deepEqual(S.baseTrack(box, "position").length, 2, "the base keeps its two keys");
    assert.equal(S.track(box, "position").length, 1, "the layer has its one key");
    near(S.valueIn(scene, box, "position", 5), [5, 2, 0]);
    L.setLayer(scene, layer.id, { weight: 0.5 });
    near(S.valueIn(scene, box, "position", 5), [5, 1, 0]);
    L.setLayer(scene, layer.id, { mute: true });
    near(S.valueIn(scene, box, "position", 5), [5, 0, 0]);
});

test("additive scale multiplies; a layer of 1 changes nothing", () => {
    const { scene, box } = sceneWithBox();
    box.scale = [2, 2, 2];
    const layer = L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "scale", 0, [1, 1.5, 1]);
    near(S.valueIn(scene, box, "scale", 0), [2, 3, 2]);
    L.setLayer(scene, layer.id, { weight: 0.5 });
    near(S.valueIn(scene, box, "scale", 0), [2, 2.5, 2]);
});

test("an override layer replaces what is below, by its weight, only on the props it keys", () => {
    const { scene, box } = sceneWithBox();
    S.setKeyframe(box, "rotation", 0, [0, 90, 0]);
    const layer = L.addLayer(scene, { mode: "override" });
    S.setKeyframe(box, "position", 0, [0, 0, 7]);
    near(S.valueIn(scene, box, "position", 5), [0, 0, 7]);
    near(S.valueIn(scene, box, "rotation", 5), [0, 90, 0], 1e-6, "rotation passes through");
    L.setLayer(scene, layer.id, { weight: 0.25 });
    near(S.valueIn(scene, box, "position", 4), [3, 0, 1.75]);
});

test("solo plays only the soloed layers (and the base); lock refuses keys", () => {
    const { scene, box } = sceneWithBox();
    const a = L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "position", 0, [0, 1, 0]);
    const b = L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "position", 0, [0, 0, 1]);
    near(S.valueIn(scene, box, "position", 0), [0, 1, 1]);
    L.setLayer(scene, b.id, { solo: true });
    near(S.valueIn(scene, box, "position", 0), [0, 0, 1]);
    L.setLayer(scene, b.id, { lock: true });
    S.setKeyframe(box, "position", 3, [0, 0, 9]);
    assert.equal(S.track(box, "position").length, 1, "the locked layer took no key");
    assert.ok(S.editLocked(box));
    void a;
});

test("the weight is keyable", () => {
    const { scene, box } = sceneWithBox();
    const layer = L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "position", 0, [0, 10, 0]);
    L.keyLayerWeight(layer, 0, 0, "linear");
    L.keyLayerWeight(layer, 10, 1, "linear");
    near(L.layerWeightAt(layer, 5), 0.5);
    near(S.valueIn(scene, box, "position", 5), [5, 5, 0]);
});

test("keyPose keys the active layer so the whole stack shows the pose", () => {
    const { scene, box } = sceneWithBox();
    // An override layer above everything, at half weight, holding z = 4.
    const top = L.addLayer(scene, { mode: "override", select: false });
    L.setActiveLayer(scene, top.id);
    S.setKeyframe(box, "position", 0, [0, 0, 4]);
    L.setLayer(scene, top.id, { weight: 0.5 });
    // Key an additive layer UNDER it (moved below the top one).
    const mid = L.addLayer(scene, { mode: "additive" });
    L.moveLayer(scene, mid.id, -1);
    assert.equal(scene.activeLayer, mid.id);
    S.keyPose(scene, box, "position", 5, [1, 2, 3]);
    near(S.valueIn(scene, box, "position", 5), [1, 2, 3], 1e-6, "composite");
    // And the base, through both layers.
    L.setActiveLayer(scene, null);
    S.keyPose(scene, box, "position", 8, [-1, -2, -3]);
    near(S.valueIn(scene, box, "position", 8), [-1, -2, -3], 1e-6, "base composite");
});

test("setPose on a layer always keys; on the base it sets the static value when nothing animates", () => {
    const scene = S.makeScene();
    const box = S.makePrimitiveItem("box", "Box");
    scene.items.push(box);
    S.bindScene(scene);
    S.setPose(scene, box, "rotation", 0, [0, 30, 0]);
    near(box.rotation, [0, 30, 0]);
    assert.equal(S.baseTrack(box, "rotation").length, 0);
    L.addLayer(scene, { mode: "additive" });
    S.setPose(scene, box, "rotation", 4, [0, 45, 0]);
    near(S.track(box, "rotation")[0].v, [0, 15, 0], 1e-6, "the offset");
    near(S.valueIn(scene, box, "rotation", 4), [0, 45, 0]);
});

test("the curve editor's value is the layer's own curve", () => {
    const { scene, box } = sceneWithBox();
    L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "position", 0, [0, 0, 0], "linear");
    S.setKeyframe(box, "position", 10, [0, 4, 0], "linear");
    near(S.editValueAt(box, "position", 5), [0, 2, 0]);
    L.setActiveLayer(scene, null);
    near(S.editValueAt(box, "position", 5), [5, 0, 0]);
});

test("removeKeyframe and keyframeFrames follow the active layer; the scene ticks see every layer", () => {
    const { scene, box } = sceneWithBox();
    L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "position", 3, [0, 1, 0]);
    assert.deepEqual(S.keyframeFrames(box), [3]);
    assert.deepEqual(S.allKeyframeFrames(box), [0, 3, 10]);
    assert.deepEqual(S.sceneKeyframes(scene), [0, 3, 10]);
    S.removeKeyframe(box, 0);       // nothing at 0 on the layer: the base keeps its key
    assert.deepEqual(S.baseTrack(box, "position").map((k) => k.f), [0, 10]);
    S.removeKeyframe(box, 3);
    assert.deepEqual(S.keyframeFrames(box), []);
});

test("layers survive serialize / parse (undo, the node widget, a scene file)", () => {
    const { scene, box } = sceneWithBox();
    const layer = L.addLayer(scene, { mode: "override", name: "Take 2" });
    S.setKeyframe(box, "position", 0, [1, 1, 1]);
    L.keyLayerWeight(layer, 0, 0.3);
    L.setLayer(scene, layer.id, { solo: true, lock: true });
    const back = S.parseScene(S.serializeScene(scene));
    const b = back.items[0];
    assert.equal(back.animLayers.length, 1);
    assert.equal(back.activeLayer, layer.id);
    assert.deepEqual({ ...back.animLayers[0], tracks: undefined }, { ...scene.animLayers[0], tracks: undefined });
    assert.equal(back.animLayers[0].tracks.weight[0].v, 0.3);
    near(S.valueIn(back, b, "position", 0), S.valueIn(scene, box, "position", 0));
    // Bound by parseScene: a key goes to the active layer.
    assert.equal(S.editLayer(b).id, layer.id);
    // Keys on a layer the scene does not have are dropped.
    const raw = JSON.parse(S.serializeScene(scene));
    raw.items[0].layerTracks.ghost = { position: [{ f: 0, v: [9, 9, 9] }] };
    assert.deepEqual(Object.keys(S.parseScene(raw).items[0].layerTracks), [layer.id]);
});

test("merge down bakes what the two show into the lower layer, and the picture stays", () => {
    const { scene, box } = sceneWithBox();
    const a = L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(box, "position", 0, [0, 1, 0], "linear");
    S.setKeyframe(box, "position", 10, [0, 3, 0], "linear");
    const b = L.addLayer(scene, { mode: "override" });
    S.setKeyframe(box, "position", 4, [2, 2, 2]);
    L.setLayer(scene, b.id, { weight: 0.5 });
    const before = [0, 2, 5, 7, 10].map((f) => S.valueIn(scene, box, "position", f));
    assert.equal(L.mergeLayerDown(scene, b.id), a.id);
    assert.equal(scene.animLayers.length, 1);
    [0, 2, 5, 7, 10].forEach((f, i) => near(S.valueIn(scene, box, "position", f), before[i], 1e-6, `frame ${f}`));
    // And the last layer into the base.
    const pic = [0, 5, 10].map((f) => S.valueIn(scene, box, "position", f));
    assert.equal(L.mergeLayerDown(scene, a.id), null);
    assert.equal(scene.animLayers, undefined);
    [0, 5, 10].forEach((f, i) => near(S.valueIn(scene, box, "position", f), pic[i], 1e-6, `base ${f}`));
    assert.equal(box.layerTracks, undefined);
});

test("removing a layer takes its keys; moving changes the order", () => {
    const { scene, box } = sceneWithBox();
    const a = L.addLayer(scene, { mode: "additive", name: "A" });
    S.setKeyframe(box, "position", 0, [0, 1, 0]);
    const b = L.addLayer(scene, { mode: "additive", name: "B" });
    assert.deepEqual(scene.animLayers.map((l) => l.name), ["A", "B"]);
    L.moveLayer(scene, b.id, -1);
    assert.deepEqual(scene.animLayers.map((l) => l.name), ["B", "A"]);
    assert.ok(L.removeLayer(scene, a.id));
    assert.equal(box.layerTracks, undefined);
    assert.equal(L.addLayer(scene, { name: "B" }).name, "B2", "names stay unique");
});

test("extract moves base keys of the selection to an override layer, the picture unchanged", () => {
    const { scene, box } = sceneWithBox();
    const pic = [0, 5, 10].map((f) => S.valueIn(scene, box, "position", f));
    const layer = L.extractToLayer(scene, [box]);
    assert.equal(layer.mode, "override");
    assert.equal(S.baseTrack(box, "position").length, 0);
    [0, 5, 10].forEach((f, i) => near(S.valueIn(scene, box, "position", f), pic[i]));
});

test("ikfk on a layer blends and stays inside 0..1", () => {
    const scene = S.makeScene();
    const ik = { ...S.makeGroupItem("ik"), kind: "control", control: { type: "ik" }, ikfk: 1 };
    scene.items.push(ik);
    S.bindScene(scene);
    L.addLayer(scene, { mode: "additive" });
    S.setKeyframe(ik, "ikfk", 0, 0.5);
    near(S.valueIn(scene, ik, "ikfk", 0), 1);
    S.keyPose(scene, ik, "ikfk", 0, 0.25);
    near(S.valueIn(scene, ik, "ikfk", 0), 0.25);
});

test("thinKeys keeps the keys a straight line does not give", () => {
    const keys = [0, 1, 2, 3, 4].map((f) => ({ f, v: f < 3 ? f : 2 }));
    assert.deepEqual(L.thinKeys(keys).map((k) => k.f), [0, 2, 4]);
});
