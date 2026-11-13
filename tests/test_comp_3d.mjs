// node --test tests/test_comp_3d.mjs
// Comp's 3D, deep and view nodes: what can be said without the Python twin (tests/test_comp_parity.py compares
// the pixels with it), and the camera import from the 3D space and from camera files.
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/imageViewer_compModel.js";
import * as G from "../js/imageViewer_comp3d.js";
import * as D from "../js/imageViewer_compDeep.js";
import * as CI from "../js/imageViewer_compCamImport.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearAll = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps)); };

function comp(nodes, out, extra = {}) {
    return { comp: 1, format: { width: 64, height: 48, fps: 24, frames: 4, ...extra }, nodes, output: out };
}
const N = (type, id, inputs, params = {}) => {
    const n = C.makeNode({ nodes: [] }, type, params);
    return Object.assign(n, { id, inputs });
};

test("views: two or more distinct names, a Read per view, split settings", () => {
    assert.deepEqual(C.cleanViews(["left"]), []);
    assert.deepEqual(C.cleanViews(["left", "right", "left", "bad name"]), ["left", "right"]);
    const r = { id: "Read1", type: "read", file: "plate_%V.%v.exr", inputs: [] };
    const v = C.viewNode(r, "right");
    assert.equal(v.file, "plate_right.r.exr");
    assert.equal(C.srcKey(v, 3), "Read1@3#right");
    assert.equal(C.viewNode(r, null), r);
    const g = { id: "Grade1", type: "grade", gain: 1, split: { right: { gain: 2 } }, inputs: [] };
    assert.equal(C.viewNode(g, "right").gain, 2);
    assert.equal(C.viewNode(g, "left"), g);
    const c = comp([], null, { views: ["left", "right"] });
    near(C.eyeOffset(c, "left", 0.06), -0.03);
    near(C.eyeOffset(c, "right", 0.06), 0.03);
    assert.equal(C.eyeOffset(comp([], null), "left", 0.06), 0);
});

test("sourceNeeds asks for each view a stereo node reads", () => {
    const c = comp([{ id: "Read1", type: "read", file: "p_%V.png", inputs: [] },
        { id: "anaglyph1", type: "anaglyph", mode: "colour", inputs: ["Read1"] }], "anaglyph1", { views: ["left", "right"] });
    const needs = C.sourceNeeds(c, "anaglyph1", 0);
    assert.deepEqual(needs.map((x) => C.srcKey(x.node, x.frame)).sort(), ["Read1@0#left", "Read1@0#right"]);
    assert.deepEqual(needs.map((x) => x.node.file).sort(), ["p_left.png", "p_right.png"]);
    const d = comp([{ id: "deepread1", type: "deepread", file: "a.exr", offset: 0, inputs: [] }], "deepread1");
    assert.equal(C.sourceNeeds(d, "deepread1", 2)[0].deep, true);
});

test("a camera's matrix looks down -Z and a card in front of it fills the middle", () => {
    const cam = G.cameraAt({ translate: [0, 0, 2], rotate: [0, 0, 0], focal: 35, haperture: 36, near: 0.01, far: 1e5 }, 0, 64, 48);
    const p = G.apply(cam.view, 0, 0, 0);
    nearAll(p, [0, 0, -2]);
    const c = comp([N("constant", "Constant1", [], { color: [1, 0.5, 0.25, 1] }),
        N("card3d", "card3d1", ["Constant1"]), N("camera3d", "camera3d1", [], { translate: [0, 0, 2] }),
        N("render3d", "render3d1", ["card3d1", "camera3d1", null], { samples: 1 })], "render3d1");
    const img = C.renderNode(c, "render3d1", 0, {});
    const at = (x, y) => img.data[(y * img.w + x) * 4 + 3];
    near(at(32, 24), 1);
    near(at(1, 1), 0);
    // The card is 1 wide at 2 away: k = 35 / 18, so it spans k * 0.25 of the half width either side of the middle.
    const half = (35 / 18) * 0.25 * 32;
    near(at(Math.floor(32 + half - 2), 24), 1);
    near(at(Math.ceil(32 + half + 2), 24), 0);
    assert.ok(img.ch && img.ch["depth.z"], "render3d writes depth.z");
    near(img.ch["depth.z"][24 * img.w + 32], 2, 1e-4);
});

test("deep: merge sorts front first, holdout dims what is behind, flatten lays it with over", () => {
    const a = D.deepFromImage({ w: 1, h: 1, data: new Float32Array([0.5, 0, 0, 0.5]) }, null, 3);
    const b = D.deepFromImage({ w: 1, h: 1, data: new Float32Array([0, 0.5, 0, 0.5]) }, null, 1);
    const m = D.deepMerge([a, b]);
    assert.equal(m.n[0], 2);
    near(m.s[4], 1);
    near(m.s[6 + 4], 3);
    const { img, depth } = D.deepFlatten(m);
    nearAll(Array.from(img.data), [0.25, 0.5, 0, 0.75]);
    near(depth[0], 1);
    const h = D.deepHoldout(a, b);
    nearAll(Array.from(h.s.subarray(0, 4)), [0.25, 0, 0, 0.25]);
    assert.equal(D.deepCrop(m, 2, 0, false).n[0], 1);
    assert.equal(D.deepCrop(m, 2, 0, true).n[0], 1);
    const buf = new Uint8Array(4 + 12 * 4);
    new Uint32Array(buf.buffer, 0, 1)[0] = 2;
    const dec = D.decodeDeep(buf.buffer, 1, 1);
    assert.equal(dec.n[0], 2);
    assert.equal(dec.s.length, 12);
});

test("Euler angles survive the matrix and back", () => {
    for (const r of [[10, 20, 30], [-45, 5, 170], [0, 89, 0], [33, -60, -12]]) {
        nearAll(CI.eulerOf(G.eulerXYZ(r)), r, 1e-6);
    }
});

test("a 3D shot's camera becomes keys: place, turn (with its parent) and lens", () => {
    const scene = { items: [
        { id: "grp", kind: "group", position: [5, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] },
        { id: "cam", kind: "camera", name: "Shot cam", parent: "grp", position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1], fov: 40,
            tracks: { position: [{ f: 10, v: [1, 2, 3] }, { f: 12, v: [1, 2, 5] }] } },
    ] };
    assert.deepEqual(CI.sceneCameras(scene).map((c) => c.name), ["Shot cam"]);
    const s = CI.sceneCameraSamples(scene, "cam", 10, 12);
    assert.deepEqual(s.map((x) => x.f), [0, 1, 2]);
    // Turned 90 about Y by the parent: local (1, 2, 3) is world (5 + 3, 2, -1).
    nearAll(s[0].t, [8, 2, -1], 1e-9);
    nearAll(s[0].r, [0, 90, 0], 1e-6);
    near(s[0].vfov, 40);
    const tracks = CI.cameraKeys(s, 36, 1920, 1080);
    assert.equal(tracks.translate.length, 3);
    // A 40 degree vertical view on a 36 wide back at 16:9.
    near(tracks.focal[0].v, (36 * 1080 / 1920 / 2) / Math.tan((20 * Math.PI) / 180), 1e-3);
    const node = { id: "camera3d1", type: "camera3d", translate: [0, 0, 2] };
    CI.applyCameraKeys(node, tracks);
    nearAll(node.translate, [8, 2, -1], 1e-9);
    assert.equal(node.tracks.translate.length, 3);
    assert.equal(node.tracks.rotate.length, 3);
    // One key a frame: a still camera keeps its value and gets no track.
    const one = { id: "c", type: "camera3d" };
    CI.applyCameraKeys(one, CI.cameraKeys(s.slice(0, 1), 36, 16, 9));
    assert.equal(one.tracks, undefined);
});
