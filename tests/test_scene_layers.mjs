// node --test tests/test_scene_layers.mjs
// Display layers, selection sets, the character picker's layout and references
// (imageViewer_sceneLayers.js), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../js/imageViewer_sceneLayers.js";
import * as S from "../js/imageViewer_scene3d.js";
import * as R from "../js/imageViewer_rigData.js";

const box = (name, parent = null) => ({ ...S.makePrimitiveItem("box", name), parent });

test("an item is on one display layer at most, and children take their parent's", () => {
    const scene = S.makeScene();
    const g = S.makeGroupItem("set"); scene.items.push(g);
    const a = box("a", g.id), b = box("b"); scene.items.push(a, b);
    const one = L.addDisplayLayer(scene, "props", [g.id, b.id]);
    const two = L.addDisplayLayer(scene, "props", [b.id]);
    assert.equal(two.name, "props1");
    assert.deepEqual(one.members, [g.id]);
    assert.deepEqual(two.members, [b.id]);
    assert.notEqual(one.color, two.color);

    one.mode = "template";
    let st = L.displayStates(scene);
    assert.equal(st.get(a.id).mode, "template", "the child of a templated group is templated");
    assert.equal(L.isPickable(st, a.id), false);
    assert.equal(L.isPickable(st, b.id), true);
    two.visible = false;
    st = L.displayStates(scene);
    assert.equal(st.get(b.id).visible, false);
    assert.equal(L.isPickable(st, b.id), false);

    // A child on a layer of its own that says reference: its own mode wins.
    const three = L.addDisplayLayer(scene, "ref", [a.id]);
    three.mode = "reference";
    st = L.displayStates(scene);
    assert.equal(st.get(a.id).mode, "reference");
    one.visible = false;
    st = L.displayStates(scene);
    assert.equal(st.get(a.id).visible, false, "a hidden layer above hides it whatever its own says");
});

test("layers and sets survive the widget, and drop members that are gone", () => {
    const scene = S.makeScene();
    const a = box("a"), b = box("b"); scene.items.push(a, b);
    const l = L.addDisplayLayer(scene, "bg", [a.id, b.id]); l.mode = "reference"; l.visible = false;
    L.addSelectionSet(scene, "both", [a.id, b.id]);
    const raw = JSON.parse(S.serializeScene(scene));
    raw.items = raw.items.filter((it) => it.id !== b.id);
    const back = S.parseScene(raw);
    assert.equal(back.displayLayers[0].mode, "reference");
    assert.equal(back.displayLayers[0].visible, false);
    assert.deepEqual(back.displayLayers[0].members, [a.id]);
    assert.deepEqual(back.selectionSets[0].members, [a.id]);
    // A plain scene stays plain.
    assert.equal(S.parseScene(S.serializeScene(S.makeScene())).displayLayers, undefined);
});

test("selection sets: add, remove, rename, sets within a character", () => {
    const scene = S.makeScene();
    const a = box("a"), b = box("b"), c = box("c"); scene.items.push(a, b, c);
    const s = L.addSelectionSet(scene, "arms", [a.id]);
    assert.equal(L.addToSet(scene, s.id, [a.id, b.id, "nope"]), 1);
    assert.deepEqual(s.members, [a.id, b.id]);
    assert.equal(L.removeFromSet(scene, s.id, [a.id]), 1);
    L.addSelectionSet(scene, "legs", [c.id]);
    assert.equal(L.renameSet(scene, s.id, "legs"), "legs1");
    assert.deepEqual(L.setsWithin(scene, [b.id]).map((x) => x.id), [s.id]);
    assert.ok(L.deleteSelectionSet(scene, s.id));
    assert.equal(L.selectionSets(scene).length, 1);
});

// A small T-posed character, as the rig tests build it.
function character() {
    const scene = S.makeScene();
    const model = S.makeModelItem({ path: "/x/hero.glb" }, "Hero");
    scene.items.push(model);
    const t = (p) => R.mat4.compose(p, [0, 0, 0, 1], [1, 1, 1]);
    const bones = [
        { name: "Hips", parent: null, world: t([0, 1, 0]) },
        { name: "Spine", parent: "Hips", world: t([0, 1.2, 0]) },
        { name: "Head", parent: "Spine", world: t([0, 1.6, 0]) },
        { name: "Head_End", parent: "Head", world: t([0, 1.8, 0]) },
        { name: "LeftArm", parent: "Spine", world: t([0.2, 1.5, 0]) },
        { name: "LeftHand", parent: "LeftArm", world: t([0.6, 1.5, 0]) },
        { name: "LeftHand_End", parent: "LeftHand", world: t([0.7, 1.5, 0]) },
        { name: "RightArm", parent: "Spine", world: t([-0.2, 1.5, 0]) },
        { name: "RightHand", parent: "RightArm", world: t([-0.6, 1.5, 0]) },
        { name: "RightHand_End", parent: "RightHand", world: t([-0.7, 1.5, 0]) },
    ];
    const rig = R.buildRig(model, { bones }, { humanoid: false, size: 1.8 });
    scene.items.push(rig.group, ...rig.items);
    return { scene, model };
}

test("the picker lays a character's controls out as seen from the front", () => {
    const { scene, model } = character();
    const lay = L.pickerLayout(scene, model.id, "front");
    const at = (name) => lay.buttons.find((b) => b.name === name);
    assert.equal(lay.buttons.length, R.controlsOf(scene, model.id).length);
    for (const b of lay.buttons) {
        assert.ok(b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1, `${b.name} inside`);
        assert.ok(b.r > 0);
    }
    assert.ok(at("LeftHand_fk").x > at("RightHand_fk").x, "the character's left is on your right");
    assert.ok(at("Head_fk").y < at("Hips_fk").y, "the head is above the hips");
    const side = L.pickerLayout(scene, model.id, "side");
    assert.ok(Math.abs(side.buttons.find((b) => b.name === "LeftHand_fk").x
        - side.buttons.find((b) => b.name === "RightHand_fk").x) < 1e-6, "seen from the side the hands line up");
    assert.deepEqual(L.pickerLayout(scene, "nobody").buttons, []);
});

test("a reference brings a file in under a namespace, ids and links its own", () => {
    const { scene: file, model } = character();
    L.addSelectionSet(file, "arms", R.controlsOf(file, model.id).filter((c) => /Arm|Hand/.test(c.name)).map((c) => c.id));
    const shot = S.makeScene();
    shot.items.push(box("floor"));
    const ref = L.addReference(shot, "/out/imageviewer/3d_scenes/hero_v003.json");
    assert.equal(ref.namespace, "hero");
    assert.equal(ref.version, 3);
    const res = L.mergeReference(shot, ref, S.parseScene(S.serializeScene(file)));
    assert.equal(res.added, file.items.length);
    const hero = shot.items.find((it) => it.name === "hero:Hero");
    assert.ok(hero && hero.ref && hero.ref.src === model.id);
    assert.equal(hero.id, L.refItemId(ref.id, model.id));
    // Every link inside it points at the copies.
    for (const c of R.controlsOf(shot, hero.id)) {
        assert.ok(c.name.startsWith("hero:"));
        assert.ok(S.itemById(shot, c.parent), "parent is in the shot");
    }
    assert.ok(R.rigGroupOf(shot, hero.id), "the rig group names the copy");
    assert.equal(L.selectionSets(shot)[0].name, "hero:arms");
    assert.ok(L.selectionSets(shot)[0].members.every((id) => S.itemById(shot, id)));

    // A second one of the same file is a second character.
    const ref2 = L.addReference(shot, ref.path);
    assert.equal(ref2.namespace, "hero1");
    L.mergeReference(shot, ref2, S.parseScene(S.serializeScene(file)));
    assert.equal(R.controlsOf(shot, L.refItemId(ref2.id, model.id)).length, R.controlsOf(file, model.id).length);

    // The widget keeps all of it.
    const back = S.parseScene(S.serializeScene(shot));
    assert.equal(back.references.length, 2);
    assert.equal(L.referencedItems(back, ref.id).length, file.items.length);
});

test("a reload takes the file's changes and keeps the shot's", () => {
    const { scene: file, model } = character();
    const shot = S.makeScene();
    const ref = L.addReference(shot, "/out/hero_v001.json");
    L.mergeReference(shot, ref, S.parseScene(S.serializeScene(file)));
    const ctrlSrc = R.controlsOf(file, model.id).find((c) => c.name === "LeftArm_fk");
    const handSrc = R.controlsOf(file, model.id).find((c) => c.name === "LeftHand_fk");
    const arm = S.itemById(shot, L.refItemId(ref.id, ctrlSrc.id));
    // The shot animates the arm and moves the character.
    S.setKeyframe(arm, "rotation", 0, [0, 0, 0]);
    S.setKeyframe(arm, "rotation", 10, [0, 0, -45]);
    const hero = S.itemById(shot, L.refItemId(ref.id, model.id));
    hero.position = [3, 0, 0];
    const set = L.addSelectionSet(shot, "shot picks", [arm.id]);

    // The character file is fixed: the hand's shape is bigger, the model sits elsewhere, a control is gone.
    const v2 = S.parseScene(S.serializeScene(file));
    v2.items.find((it) => it.id === handSrc.id).control.shape.size = 0.5;
    v2.items.find((it) => it.id === model.id).src = { path: "/x/hero_fixed.glb" };
    v2.items.find((it) => it.id === model.id).scale = [2, 2, 2];
    const gone = v2.items.find((it) => it.name === "RightHand_fk");
    v2.items = v2.items.filter((it) => it !== gone && it.parent !== gone.id);
    S.repairTree(v2);
    const res = L.mergeReference(shot, ref, v2);

    const arm2 = S.itemById(shot, arm.id);
    assert.equal(S.keyframeFrames(arm2).length, 2, "the shot's keys are kept");
    const hero2 = S.itemById(shot, hero.id);
    assert.deepEqual(hero2.position, [3, 0, 0], "the shot's move is kept");
    assert.deepEqual(hero2.scale, [2, 2, 2], "an untouched field takes the file's change");
    assert.equal(hero2.src.path, "/x/hero_fixed.glb");
    assert.equal(S.itemById(shot, L.refItemId(ref.id, handSrc.id)).control.shape.size, 0.5);
    assert.equal(S.itemById(shot, L.refItemId(ref.id, gone.id)), null);
    assert.ok(res.removed >= 1 && res.kept === 2);
    assert.deepEqual(L.setById(shot, set.id).members, [arm.id], "the shot's set still names the arm");

    // And the next reload keeps what the shot kept, without a further change.
    L.mergeReference(shot, ref, v2);
    assert.deepEqual(S.itemById(shot, hero.id).position, [3, 0, 0]);
    assert.equal(S.keyframeFrames(S.itemById(shot, arm.id)).length, 2);
});

test("namespaces and removing a reference", () => {
    const { scene: file } = character();
    const shot = S.makeScene();
    shot.items.push(box("floor"));
    const ref = L.addReference(shot, "/o/SQ01/SH010/scenes/v002/sh010_v002_hero.json");
    assert.equal(ref.namespace, "hero");
    L.mergeReference(shot, ref, file);
    L.addDisplayLayer(shot, "chars", L.referencedItems(shot, ref.id).slice(0, 1).map((it) => it.id));
    assert.equal(L.renameNamespace(shot, ref.id, "villain"), "villain");
    assert.ok(L.referencedItems(shot, ref.id).every((it) => it.name.startsWith("villain:")));
    const n = L.removeReference(shot, ref.id);
    assert.equal(n, file.items.length);
    assert.equal(shot.items.length, 1);
    assert.deepEqual(shot.displayLayers[0].members, []);
    assert.equal(shot.references, undefined);
    assert.equal(L.versionOf("a/b/hero_v012.json"), 12);
    assert.equal(L.versionOf("a/b/hero.json"), null);
});
