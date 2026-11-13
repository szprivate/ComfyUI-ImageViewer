// node --test tests/test_comp_copy_layers.mjs
// Copies in the Comp graph (duplicate, copy / paste: copyNodes, pasteNodes) and where the Layers panel reads
// from when nothing is wired into the Output (layerRoot, looseSources, layerFrom).
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/imageViewer_compModel.js";
import * as G from "../js/imageViewer_compGraph.js";

const chain = () => {
    const c = C.newComp({ width: 64, height: 32, fps: 24, frames: 10 });
    const out = C.nodeById(c, "Output1");
    const blur = C.addNode(c, C.makeNode(c, "blur", { inputs: ["Constant1"], x: 400, y: 70 }));
    const grade = C.addNode(c, C.makeNode(c, "grade", { inputs: [blur.id], x: 400, y: 140 }));
    out.inputs = [grade.id];
    return { c, blur, grade, out };
};

test("copies get new ids, keep the wires among themselves and drop the ones from outside", () => {
    const { c, blur, grade } = chain();
    blur.size = 7;
    const made = C.pasteNodes(c, C.copyNodes(c, [blur.id, grade.id]), { dx: 40, dy: 40 });
    assert.equal(made.length, 2);
    const [b2, g2] = made;
    assert.notEqual(b2.id, blur.id); assert.notEqual(g2.id, grade.id);
    assert.equal(b2.type, "blur"); assert.equal(b2.size, 7);
    assert.equal(b2.inputs[0], null, "the wire from the Constant outside is not kept");
    assert.equal(g2.inputs[0], b2.id, "the wire between the copies is");
    assert.deepEqual([b2.x, b2.y], [blur.x + 40, blur.y + 40]);
    // the originals are as they were
    assert.equal(blur.inputs[0], "Constant1"); assert.equal(grade.inputs[0], blur.id);
    assert.equal(new Set(c.nodes.map((n) => n.id)).size, c.nodes.length, "ids stay unique");
    assert.deepEqual(C.normalizeComp(JSON.parse(JSON.stringify(c))).errors, []);
});

test("with `outer` the copies read what the originals read; an Output is never copied", () => {
    const { c, blur, out } = chain();
    const made = C.pasteNodes(c, C.copyNodes(c, [blur.id, out.id]), { outer: true });
    assert.equal(made.length, 1);
    assert.equal(made[0].inputs[0], "Constant1");
    assert.equal(C.copyNodes(c, [out.id]), null);
    assert.equal(c.nodes.filter((n) => n.type === "output").length, 1);
});

test("a paste lands with its middle at a point, and a second paste gets ids of its own", () => {
    const { c, blur, grade } = chain();
    const frag = C.copyNodes(c, [blur.id, grade.id]);
    const a = C.pasteNodes(c, frag, { at: [1000, 500] });
    const b = C.pasteNodes(c, frag, { at: [1000, 500] });
    assert.notEqual(a[0].id, b[0].id);
    const [w, h] = C.nodeSize(a[0]);
    assert.ok(Math.abs((a[0].x + a[1].x + w) / 2 - 1000) <= 1);
    assert.ok(Math.abs((a[0].y + a[1].y + h) / 2 - 500) <= 1);
    assert.equal(frag.nodes[0].id, blur.id, "the fragment itself is not changed by pasting");
});

test("expression links between the copies follow the copies, also when ids shift into each other", () => {
    const c = C.newComp();
    const b1 = C.addNode(c, C.makeNode(c, "blur", {}));           // Blur1
    const b2 = C.addNode(c, C.makeNode(c, "blur", { expr: { size: `${b1.id}.size * 2` } }));   // Blur2 reads Blur1
    const made = C.pasteNodes(c, C.copyNodes(c, [b1.id, b2.id]));
    assert.deepEqual(made.map((n) => n.id), ["Blur3", "Blur4"]);
    assert.equal(made[1].expr.size, "Blur3.size * 2");
    assert.equal(b2.expr.size, "Blur1.size * 2");
    // a link to a node that was not copied stays on that node
    const lone = C.pasteNodes(c, C.copyNodes(c, [b2.id]));
    assert.equal(lone[0].expr.size, "Blur1.size * 2");
});

test("a group is copied whole, and copies go into a group's own graph too", () => {
    const { c, blur, grade } = chain();
    const { group } = C.groupNodes(c, [blur.id, grade.id]);
    const [g2] = C.pasteNodes(c, C.copyNodes(c, [group.id]), { dx: 200 });
    assert.equal(g2.type, "group"); assert.notEqual(g2.id, group.id);
    assert.deepEqual(g2.nodes.map((n) => n.id), group.nodes.map((n) => n.id));
    assert.notEqual(g2.nodes, group.nodes);
    assert.deepEqual(g2.inputs, [null]);
    const level = G.levelView(() => c, [group.id]);
    const inner = C.pasteNodes(level, C.copyNodes(level, [blur.id]), { dx: 40 });
    assert.equal(inner.length, 1);
    assert.ok(group.nodes.some((n) => n.id === inner[0].id));
    assert.ok(!c.nodes.some((n) => n.id === inner[0].id));
});

test("a Read that nothing is wired to is still a layer: the Layers read from it while the Output reads nothing", () => {
    const c = C.newComp();
    C.removeNodes(c, ["Constant1"]);
    assert.deepEqual(C.layerStack(c), []);
    const read = C.addNode(c, C.makeNode(c, "read", { file: "plate.mov", x: 300, y: 0 }));
    const grade = C.addNode(c, C.makeNode(c, "grade", { inputs: [read.id], x: 300, y: 70 }));
    const root = C.layerRoot(c);
    assert.deepEqual(root, { id: grade.id, loose: true });
    const L = C.layerStack(c, root.id);
    assert.equal(L.length, 1);
    assert.equal(L[0].source, read.id); assert.equal(L[0].name, "plate.mov");
    // the node looked at wins over the largest tree
    const other = C.addNode(c, C.makeNode(c, "read", { file: "b.png" }));
    assert.equal(C.layerRoot(c, other.id).id, other.id);
    // once the Output reads something, that is the root
    C.nodeById(c, "Output1").inputs = [grade.id];
    assert.deepEqual(C.layerRoot(c, other.id), { id: grade.id, loose: false });
    assert.deepEqual(C.looseSources(c, C.layerStack(c)), [other.id]);
});

test("a loose Read becomes a layer on top without being made again", () => {
    const c = C.newComp();
    const read = C.addNode(c, C.makeNode(c, "read", { file: "fg.png", x: 300, y: 0 }));
    assert.deepEqual(C.looseSources(c, C.layerStack(c)), [read.id]);
    const { merge } = C.layerFrom(c, read.id);
    assert.deepEqual(merge.inputs.slice(0, 2), ["Constant1", read.id]);
    const L = C.layerStack(c);
    assert.equal(L[0].source, read.id); assert.equal(L[0].merge, merge.id);
    assert.deepEqual(C.looseSources(c, L), []);
    assert.equal(c.nodes.filter((n) => n.type === "read").length, 1);
    // into an Output that reads nothing it goes straight in
    const d = C.newComp(); C.removeNodes(d, ["Constant1"]);
    const r = C.addNode(d, C.makeNode(d, "read", { file: "a.png" }));
    assert.equal(C.layerFrom(d, r.id).merge, null);
    assert.equal(C.nodeById(d, "Output1").inputs[0], r.id);
});
