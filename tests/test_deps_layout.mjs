// The Dependencies tab's layout (js/imageViewer_depsLayout.js). Run: node --test tests/test_deps_layout.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { layout, foldGraph, foldId, ranks, edgePath, FOLD_AT, NODE_H, GAP_Y } from "../js/imageViewer_depsLayout.js";

const n = (id, extra = {}) => ({ id, file: id, kind: "", exists: true, ...extra });
const e = (from, to, kind = "") => ({ from, to, kind, label: kind });

test("inputs sit above what was made from them (top to bottom)", () => {
    const g = { nodes: [n("plate", { kind: "source" }), n("depth", { kind: "depth", root: true }), n("render", { kind: "render" })],
                edges: [e("plate", "depth", "depth"), e("depth", "render", "render")] };
    const L = layout(g);
    const y = Object.fromEntries(L.nodes.map((x) => [x.id, x.y]));
    assert.ok(y.plate < y.depth && y.depth < y.render);
    assert.equal(y.depth - y.plate, NODE_H + GAP_Y);
    const edge = L.edges.find((x) => x.from === "plate");
    assert.ok(edge.y1 < edge.y2, "edges run downwards");
    assert.match(edgePath(edge), /^M[\d.]+,[\d.]+ C/);
});

test("a merge sits below the lower of its inputs", () => {
    const g = { nodes: [n("plate"), n("mask"), n("frame"), n("comp")],
                edges: [e("plate", "mask"), e("mask", "comp"), e("frame", "comp"), e("plate", "frame")] };
    const r = ranks(new Map(g.nodes.map((x) => [x.id, x])), g.edges);
    assert.equal(r.get("plate"), 0);
    assert.equal(r.get("mask"), 1);
    assert.equal(r.get("comp"), 2);
});

test("many sibling passes fold into one node until unfolded", () => {
    const kids = Array.from({ length: FOLD_AT + 2 }, (_, i) => n(`d${i}`, { kind: "depth" }));
    const g = { nodes: [n("plate", { root: true }), ...kids, n("r", { kind: "render" })],
                edges: [...kids.map((k) => e("plate", k.id, "depth")), e("plate", "r", "render")] };
    const folded = foldGraph(g);
    const fid = foldId("plate", "depth");
    assert.ok(folded.nodes.has(fid));
    assert.equal(folded.nodes.get(fid).count, FOLD_AT + 2);
    assert.ok(folded.nodes.has("r"), "a lone render stays");
    assert.equal(folded.edges.filter((x) => x.to === fid).length, 1);
    const open = layout(g, { open: new Set([fid]) });
    assert.equal(open.nodes.length, FOLD_AT + 4);
});

test("a pass that something was made from never folds", () => {
    const kids = Array.from({ length: FOLD_AT + 2 }, (_, i) => n(`m${i}`, { kind: "mask" }));
    const g = { nodes: [n("plate"), ...kids, n("comp")],
                edges: [...kids.map((k) => e("plate", k.id, "mask")), e("m0", "comp")] };
    const L = layout(g);
    assert.ok(L.nodes.some((x) => x.id === "m0"));
    assert.ok(L.nodes.some((x) => x.fold && x.count === FOLD_AT + 1), "the other leaves still fold");
});

test("an edge to a missing node and a cycle do not break it", () => {
    const g = { nodes: [n("a"), n("b")], edges: [e("a", "b"), e("b", "a"), e("a", "ghost")] };
    const L = layout(g);
    assert.equal(L.nodes.length, 2);
});

test("a file's prompts are text boxes right above it, wired into it", () => {
    const g = { nodes: [n("plate", { kind: "source" }), n("depth", { kind: "depth", root: true }),
                        n("render", { kind: "render", prompts: [{ role: "positive", text: "a kitchen at dawn" },
                                                                 { role: "negative", text: "blurry" }] }),
                        n("t2i", { kind: "render", prompts: [{ role: "positive", text: "a castle" }] })],
                edges: [e("plate", "depth", "depth"), e("depth", "render", "render")] };
    const L = layout(g);
    const by = Object.fromEntries(L.nodes.map((x) => [x.id, x]));
    const boxes = L.nodes.filter((x) => x.prompt);
    assert.equal(boxes.length, 3);
    const pos = boxes.find((x) => x.text === "a kitchen at dawn");
    assert.equal(pos.role, "positive");
    assert.equal(pos.row, by.render.row - 1, "one row above the render, not up with the plate");
    assert.ok(L.edges.some((x) => x.from === pos.id && x.to === "render" && x.kind === "prompt"));
    // A render made from nothing but its prompt: the prompt goes on top and the rest moves down.
    const castle = boxes.find((x) => x.text === "a castle");
    assert.equal(castle.row, 0);
    assert.equal(by.t2i.row, 1);
    assert.ok(by.plate.row >= 0);
    // Switched off, there are none.
    assert.equal(layout(g, { prompts: false }).nodes.filter((x) => x.prompt).length, 0);
});

test("an empty graph (an error answer) lays out at once instead of spinning", () => {
    const L = layout({ nodes: [], edges: [] });
    assert.equal(L.nodes.length, 0);
    assert.equal(L.edges.length, 0);
    const one = layout({ nodes: [n("a", { root: true })], edges: [] });
    assert.equal(one.nodes.length, 1);
});
