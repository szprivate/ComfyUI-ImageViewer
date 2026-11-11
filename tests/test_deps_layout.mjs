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

test("a moved / resized node keeps its box and its edges follow", async () => {
    const { applyPlacement, MIN_W, MIN_H } = await import("../js/imageViewer_depsLayout.js");
    const g = { nodes: [n("plate"), n("mask", { root: true })], edges: [e("plate", "mask", "mask")] };
    const L = layout(g);
    assert.equal(applyPlacement(L, {}), L, "nothing moved: the layout as it is");
    const P = applyPlacement(L, { mask: { x: 500, y: 400, w: 300, h: 200 }, gone: { x: 1, y: 1 } });
    const m = P.nodes.find((x) => x.id === "mask");
    assert.deepEqual([m.x, m.y, m.w, m.h, m.placed], [500, 400, 300, 200, true]);
    const edge = P.edges[0];
    assert.deepEqual([edge.x2, edge.y2], [650, 400], "the edge ends at the top middle of the moved node");
    assert.ok(P.width >= 800 && P.height >= 600, "the stage grows to hold it");
    assert.equal(L.nodes.find((x) => x.id === "mask").x === 500, false, "the input layout is not changed");
    const S = applyPlacement(L, { plate: { x: -50, y: -9, w: 10, h: 10 } });
    const p = S.nodes.find((x) => x.id === "plate");
    assert.deepEqual([p.x, p.y, p.w, p.h], [-50, -9, MIN_W, MIN_H], "no bound on the place, a minimum size");
    assert.deepEqual([S.x0, S.y0], [-50, -9], "the drawing begins where the moved node does");
});

test("a node's frame: still or film by its extension, the main models as its caption", async () => {
    const { depsMediaOf, depsModelCaption } = await import("../js/imageViewer_depsLayout.js");
    assert.equal(depsMediaOf("C:\\out\\a.MP4"), "video");
    assert.equal(depsMediaOf("/out/a.png"), "image");
    assert.equal(depsMediaOf("/out/a.exr"), "image");
    assert.equal(depsMediaOf("/out/a.wav"), "");
    assert.equal(depsMediaOf("/out/a.glb"), "");
    const m = (name, role) => ({ name, role, value: name });
    assert.equal(depsModelCaption([m("flux1-dev", "model"), m("ae", "aux"), m("a", "lora"), m("b", "lora")]), "flux1-dev + 2 LoRA");
    assert.equal(depsModelCaption([m("veo-3.0", "partner")]), "veo-3.0");
    assert.equal(depsModelCaption([m("4x-UltraSharp", "upscale"), m("vae", "aux")]), "4x-UltraSharp");
    assert.equal(depsModelCaption([m("x", "model"), m("y", "model"), m("z", "model")]), "x + y +1");
    assert.equal(depsModelCaption([m("vae", "aux")]), "");
    assert.equal(depsModelCaption(undefined), "");
});

test("a file's tags are its caption: the service that made it, then its model", async () => {
    const { depsCaption } = await import("../js/imageViewer_depsLayout.js");
    assert.equal(depsCaption([{ name: "dreamina-seedance-2-5", role: "partner" }], ["magnific", "dreamina-seedance-2-5"]),
        "magnific · dreamina-seedance-2-5");
    assert.equal(depsCaption([{ name: "flux1-dev", role: "model" }], []), "flux1-dev");
    assert.equal(depsCaption(undefined, undefined), "");
});

test("a box picks the nodes it touches, drawn either way round", async () => {
    const { nodesInBox } = await import("../js/imageViewer_depsLayout.js");
    const L = { nodes: [{ id: "a", x: 0, y: 0, w: 100, h: 50 }, { id: "b", x: 300, y: 0, w: 100, h: 50 }] };
    assert.deepEqual(nodesInBox(L, { x0: -10, y0: -10, x1: 20, y1: 20 }), ["a"]);
    assert.deepEqual(nodesInBox(L, { x0: 350, y0: 40, x1: 50, y1: 10 }), ["a", "b"]);
    assert.deepEqual(nodesInBox(L, { x0: 150, y0: 0, x1: 250, y1: 60 }), []);
    assert.deepEqual(nodesInBox(null, { x0: 0, y0: 0, x1: 1, y1: 1 }), []);
});
