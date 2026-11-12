// node --test tests/test_outliner_data.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    outlinerRows, boneRows, cleanOutlinerFilter, outlinerFilterIsOff, outlinerKindOf,
    matchRange, searchNeedle, descendantIds,
} from "../js/imageViewer_outlinerData.js";

const scene = {
    items: [
        { id: "g", kind: "group", name: "Set", parent: null },
        { id: "m", kind: "model", name: "Hero", parent: "g" },
        { id: "k", kind: "control", name: "arm_L_ik", parent: "m" },
        { id: "c", kind: "camera", name: "shotCam", parent: null, visible: false },
        { id: "p", kind: "primitive", name: "Box", parent: "g" },
        { id: "l", kind: "light", name: "Key light", parent: null },
        { id: "t", kind: "terrain", name: "Ground", parent: null },
    ],
};
const names = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.item.name}`);

test("everything, parents first, with depths and arrows", () => {
    const rows = outlinerRows(scene);
    assert.deepEqual(names(rows), ["Set", "  Hero", "    arm_L_ik", "  Box", "shotCam", "Key light", "Ground"]);
    assert.equal(rows[0].hasKids, true);
    assert.equal(rows[3].hasKids, false);
});

test("a folded row keeps its arrow and hides what is inside", () => {
    const rows = outlinerRows(scene, { collapsed: new Set(["g"]) });
    assert.deepEqual(names(rows), ["Set", "shotCam", "Key light", "Ground"]);
    assert.equal(rows[0].hasKids, true);
    assert.equal(rows[0].open, false);
});

test("a search keeps the matches and what they are in, unfolded", () => {
    const rows = outlinerRows(scene, { needle: searchNeedle(" ARM "), collapsed: new Set(["g", "m"]) });
    assert.deepEqual(names(rows), ["Set", "  Hero", "    arm_L_ik"]);
    assert.deepEqual(rows.map((r) => r.context), [true, true, false]);
    assert.equal(rows[2].match, true);
});

test("a search finds a model by its bones", () => {
    const rows = outlinerRows(scene, { needle: "hips", bonesOf: (it) => (it.id === "m" ? ["mixamorigHips"] : []) });
    assert.deepEqual(names(rows), ["Set", "  Hero"]);
    assert.equal(rows[1].context, false);
    assert.equal(rows[1].hasKids, true);
});

test("a hidden kind's children take its place a level up", () => {
    const rows = outlinerRows(scene, { filter: { hidden: ["group"] } });
    assert.deepEqual(names(rows), ["Hero", "  arm_L_ik", "Box", "shotCam", "Key light", "Ground"]);
    const noCtrl = outlinerRows(scene, { filter: { hidden: ["control", "light", "world"] } });
    assert.deepEqual(names(noCtrl), ["Set", "  Hero", "  Box", "shotCam"]);
    assert.equal(noCtrl[1].hasKids, false);
});

test("the state filter: visible, selected, animated", () => {
    assert.ok(!names(outlinerRows(scene, { filter: { state: "visible" } })).includes("shotCam"));
    const sel = outlinerRows(scene, { filter: { state: "selected" }, isSelected: (id) => id === "k" });
    assert.deepEqual(names(sel), ["Set", "  Hero", "    arm_L_ik"]);
    assert.deepEqual(sel.map((r) => r.context), [true, true, false]);
    const anim = outlinerRows(scene, { filter: { state: "animated" }, isAnimated: (it) => it.id === "c" });
    assert.deepEqual(names(anim), ["shotCam"]);
});

test("bones: a tree, folding, and a search", () => {
    const bones = [{ name: "Hips", parent: null }, { name: "Spine", parent: "Hips" }, { name: "LeftLeg", parent: "Hips" }, { name: "Head", parent: "Spine" }];
    assert.deepEqual(boneRows(bones).map((b) => `${b.depth}${b.name}`), ["0Hips", "1Spine", "2Head", "1LeftLeg"]);
    assert.deepEqual(boneRows(bones, { isClosed: (n) => n === "Spine" }).map((b) => b.name), ["Hips", "Spine", "LeftLeg"]);
    const found = boneRows(bones, { needle: "head", isClosed: () => true });
    assert.deepEqual(found.map((b) => [b.name, b.context]), [["Hips", true], ["Spine", true], ["Head", false]]);
});

test("filter cleaning, kinds, ranges, descendants", () => {
    assert.deepEqual(cleanOutlinerFilter({ hidden: ["camera", "nope", "camera"], state: "x" }), { hidden: ["camera"], state: "all" });
    assert.equal(outlinerFilterIsOff(null), true);
    assert.equal(outlinerFilterIsOff({ hidden: ["bones"] }), false);
    assert.equal(outlinerKindOf({ kind: "scatter" }), "world");
    assert.equal(outlinerKindOf({ kind: "something" }), "model");
    assert.deepEqual(matchRange("shotCam", "cam"), [4, 7]);
    assert.equal(matchRange("shotCam", ""), null);
    assert.deepEqual(descendantIds(scene, "g").sort(), ["k", "m", "p"]);
});

test("a parent loop does not hang", () => {
    const loop = { items: [{ id: "a", kind: "group", name: "A", parent: "b" }, { id: "b", kind: "group", name: "B", parent: "a" }] };
    assert.deepEqual(outlinerRows(loop), []);
});
