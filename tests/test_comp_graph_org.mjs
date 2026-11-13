// node --test tests/test_comp_graph_org.mjs
// The Comp graph's organisation: groups (made, taken apart, saved as tools, laid out flat), Dots, backdrops,
// sticky notes, and the expression language (js/imageViewer_compExpr.js). The pictures they make are compared
// with the Python render in tests/test_comp_parity.py (graph_cases).
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/imageViewer_compModel.js";
import * as E from "../js/imageViewer_compExpr.js";
import * as G from "../js/imageViewer_compGraph.js";

const chain = () => {
    const c = C.newComp({ width: 64, height: 32, fps: 24, frames: 10 });
    const out = C.nodeById(c, "Output1");
    const blur = C.addNode(c, C.makeNode(c, "blur", { inputs: ["Constant1"], x: 400, y: 70 }));
    const grade = C.addNode(c, C.makeNode(c, "grade", { inputs: [blur.id], x: 400, y: 140 }));
    out.inputs = [grade.id];
    return { c, blur, grade, out };
};

test("nodes put into a group keep the picture: their input becomes the group's, the Output reads the group", () => {
    const { c, blur, grade, out } = chain();
    const before = C.renderNode(c, "Output1", 0, {}).data;
    const r = C.groupNodes(c, [blur.id, grade.id]);
    assert.ok(r && r.group.type === "group");
    assert.equal(r.lost, 0);
    assert.deepEqual(r.group.inputs, ["Constant1"]);
    assert.equal(out.inputs[0], r.group.id);
    assert.deepEqual(r.group.nodes.map((n) => n.type).sort(), ["blur", "grade", "group_input", "group_output"]);
    assert.deepEqual(C.renderNode(c, "Output1", 0, {}).data, before);
    // ... and taken apart again, the same nodes are back in the graph, wired as before.
    const ids = C.ungroup(c, r.group.id);
    assert.deepEqual(ids.sort(), [blur.id, grade.id].sort());
    assert.equal(C.nodeById(c, blur.id).inputs[0], "Constant1");
    assert.equal(out.inputs[0], grade.id);
    assert.ok(!c.nodes.some((n) => n.type === "group"));
});

test("a flat comp names a group's nodes <group>/<id>, passes Dots on and leaves notes and backdrops out", () => {
    const { c, blur, grade } = chain();
    const { group } = C.groupNodes(c, [blur.id, grade.id], { name: "Look" });
    const dot = C.addNode(c, C.makeNode(c, "dot", { inputs: [group.id] }));
    C.nodeById(c, "Output1").inputs = [dot.id];
    C.addNode(c, C.makeNode(c, "backdrop"));
    C.addNode(c, C.makeNode(c, "sticky", { text: "hi" }));
    const flat = G.flattenComp(c);
    assert.deepEqual(flat.nodes.map((n) => n.id).sort(), ["Constant1", `${group.id}/${blur.id}`, `${group.id}/${grade.id}`, "Output1"].sort());
    assert.equal(C.nodeById(flat, "Output1").inputs[0], `${group.id}/${grade.id}`);
    assert.equal(G.resolveId(flat, dot.id), `${group.id}/${grade.id}`);
    assert.equal(G.flatNode(c, `${group.id}/${blur.id}`), group.nodes.find((n) => n.id === blur.id));
    // A disabled group passes its first input.
    group.disable = true;
    assert.equal(C.nodeById(G.flattenComp(c), "Output1").inputs[0], "Constant1");
});

test("a group saved as a tool is one group of nothing outside; put back in it is a group of its own", () => {
    const { c, blur, grade } = chain();
    const { group } = C.groupNodes(c, [blur.id, grade.id]);
    const tool = C.toolFragment(group, c.format, "Soft");
    assert.equal(tool.nodes.length, 1);
    assert.deepEqual(tool.nodes[0].inputs, [null]);
    assert.equal(tool.tool.name, "Soft");
    const g2 = C.insertTool(c, JSON.parse(JSON.stringify(tool)), { x: 300, y: 0 });
    assert.ok(g2 && g2.id !== group.id);
    assert.equal(g2.x, 300);
    assert.equal(c.nodes.filter((n) => n.type === "group").length, 2);
});

test("a backdrop round the selection holds it; what lies on it moves with it", () => {
    const { c, blur, grade } = chain();
    const b = C.addNode(c, C.backdropAround(c, [blur.id, grade.id]));
    assert.deepEqual(C.backdropHolds(c, b.id).sort(), [blur.id, grade.id].sort());
    assert.ok(!C.backdropHolds(c, b.id).includes("Output1"));
});

test("the expression language: maths, names, functions, references; no way out of it", () => {
    const env = { vars: { frame: 4, time: 4 / 24, fps: 24, width: 64, height: 32, value: 10 }, ref: (id, p, k) => (id === "Blur1" && p === "size" ? 7 : NaN) };
    const ev = (s) => E.evalExpr(s, env);
    assert.equal(ev("1 + 2 * 3 ^ 2"), 19);
    assert.equal(ev("frame % 3 == 1 ? 5 : 6"), 5);
    assert.equal(ev("clamp(value, 0, 3) + max(1, 2, 3)"), 6);
    assert.equal(ev("Blur1.size * 2"), 14);
    assert.equal(ev("round(2.5) + round(-2.5)"), 1);   // half up, as floor(x + 0.5)
    assert.ok(Number.isNaN(ev("Nope.size")));
    assert.equal(E.hash32(1), E.hash32(1));
    assert.ok(ev("random(3)") >= 0 && ev("random(3)") < 1);
    for (const bad of ["alert(1)", "constructor", "this", "a = 1", "(1", "1 +", "Blur1.size.q", "x => 1", "`1`"]) assert.ok(E.checkExpr(bad), bad);
    assert.equal(E.checkExpr("sin(time * pi) * width"), null);
    assert.deepEqual(E.exprRefs("Blur1.size + 'Odd one'.mix + frame"), ["Blur1", "Odd one"]);
});

test("a link reads back, and a node taken out of a group keeps what read it", () => {
    const s = E.linkExpr("Grade 1", "gain", 2, 0.5, -1);
    assert.equal(s, "'Grade 1'.gain.z * 0.5 - 1");
    assert.deepEqual(E.parseLink(s), { node: "Grade 1", param: "gain", comp: 2, scale: 0.5, offset: -1 });
    assert.equal(E.parseLink("frame * 2"), null);
    assert.equal(E.renameRef("Blur1.size + 'Blur1'.size + Blur10.size", "Blur1", "Blur3"), "Blur3.size + Blur3.size + Blur10.size");
});

test("a number follows its expression at every frame, through the graphs around it", () => {
    const { c, blur, grade } = chain();
    grade.expr = { gain: `${blur.id}.size / 10 + frame` };
    blur.size = 5;
    const { group } = C.groupNodes(c, [grade.id]);
    const flat = G.flattenComp(c);
    const g = C.nodeById(flat, `${group.id}/${grade.id}`);
    assert.equal(C.paramAt(g, "gain", 3), 3.5);
    // A loop of links leaves the numbers as they are instead of hanging.
    blur.expr = { size: `${group.id}.gain` };
    grade.expr = { gain: `${blur.id}.size` };
    assert.equal(typeof C.paramAt(C.nodeById(G.flattenComp(c), `${group.id}/${grade.id}`), "gain", 0), "number");
});
