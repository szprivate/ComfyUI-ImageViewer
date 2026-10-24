// node --test tests/test_mg_model.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as Mo from "../js/bEpicViewer_mgModel.js";
import { valueAt, validateScene } from "../js/bEpicViewer_mgScene.js";

const scene = () => ({ mgscene: 1, comp: { width: 1920, height: 1080, fps: 30, duration: 90, background: "#000" }, assets: {}, layers: [] });

test("new layers validate and get unique ids", () => {
    const s = scene();
    Mo.addLayer(s, Mo.makeLayer(s, "text"));
    Mo.addLayer(s, Mo.makeLayer(s, "text"));
    Mo.addLayer(s, Mo.makeLayer(s, "shape"));
    Mo.addLayer(s, Mo.makeLayer(s, "group"));
    assert.deepEqual(s.layers.map((l) => l.id), ["text", "text2", "shape", "group"]);
    assert.equal(validateScene(s).ok, true, JSON.stringify(validateScene(s).errors));
});

test("setProp: static until animated, then a key at the frame", () => {
    const s = scene(); const l = Mo.addLayer(s, Mo.makeLayer(s, "shape"));
    Mo.setProp(s, l, "opacity", 40, 10);
    assert.equal(l.opacity, 40);
    assert.equal(Mo.toggleAnimated(s, l, "opacity", 10), true);      // stopwatch on: key holds 40
    assert.deepEqual(l.tracks.opacity, [{ f: 10, v: 40, ease: "smooth" }]);
    Mo.setProp(s, l, "opacity", 100, 30);
    assert.deepEqual(l.tracks.opacity.map((k) => [k.f, k.v]), [[10, 40], [30, 100]]);
    assert.equal(valueAt(l, "opacity", 20), 70);                       // smooth is symmetric
    Mo.setProp(s, l, "opacity", 0, 10);                                // editing at a key replaces it
    assert.equal(l.tracks.opacity[0].v, 0);
    assert.equal(Mo.toggleAnimated(s, l, "opacity", 30), false);       // stopwatch off: frozen at the value there
    assert.equal(l.opacity, 100); assert.equal(l.tracks, undefined);
    assert.equal(validateScene(s).ok, true);
});

test("vec2 component edits keep the other axis, also on keys", () => {
    const s = scene(); const l = Mo.addLayer(s, Mo.makeLayer(s, "shape"));
    Mo.toggleAnimated(s, l, "position", 0);
    Mo.setComponent(s, l, "position", 0, 100, 20);
    assert.deepEqual(l.tracks.position.map((k) => k.v), [[960, 540], [100, 540]]);
});

test("moveKeys shifts, clamps at 0 and replaces what it lands on", () => {
    const s = scene(); const l = Mo.addLayer(s, Mo.makeLayer(s, "shape"));
    l.tracks = { opacity: [{ f: 0, v: 0 }, { f: 10, v: 50 }, { f: 20, v: 100 }] };
    const sel = Mo.moveKeys(l, [{ prop: "opacity", f: 10 }], 10);
    assert.deepEqual(sel, [{ prop: "opacity", f: 20 }]);
    assert.deepEqual(l.tracks.opacity.map((k) => [k.f, k.v]), [[0, 0], [20, 50]]);
    Mo.moveKeys(l, [{ prop: "opacity", f: 20 }], -50);
    assert.deepEqual(l.tracks.opacity.map((k) => k.f), [0]);          // landed on 0, replaced that key
});

test("copy and paste keys across layers", () => {
    const s = scene();
    const a = Mo.addLayer(s, Mo.makeLayer(s, "shape")), b = Mo.addLayer(s, Mo.makeLayer(s, "group"));
    a.tracks = { opacity: [{ f: 5, v: 0, ease: "linear" }, { f: 15, v: 100 }], fill: [{ f: 5, v: "#f00" }] };
    const clip = Mo.copyKeys(a, [{ prop: "opacity", f: 5 }, { prop: "opacity", f: 15 }, { prop: "fill", f: 5 }]);
    const sel = Mo.pasteKeys(b, clip, 40);                             // a group has no fill: skipped
    assert.deepEqual(sel, [{ prop: "opacity", f: 40 }, { prop: "opacity", f: 50 }]);
    assert.equal(b.tracks.opacity[0].ease, "linear");
    assert.equal(validateScene(s).ok, true);
});

test("tangents: writing one side writes both unless broken; ease clears them", () => {
    const s = scene(); const l = Mo.addLayer(s, Mo.makeLayer(s, "shape"));
    l.tracks = { rotation: [{ f: 0, v: 0, ease: "linear" }, { f: 10, v: 100 }] };
    Mo.setTangent(l, "rotation", 0, 0, 25);
    assert.equal(l.tracks.rotation[0].to, 25); assert.equal(l.tracks.rotation[0].ti, 25);
    assert.equal(l.tracks.rotation[1].ti, undefined);
    Mo.setTangent(l, "rotation", 10, 0, 0, { side: "in", broken: true });
    assert.equal(l.tracks.rotation[1].ti, 0); assert.equal(l.tracks.rotation[1].to, 0);
    assert.ok(valueAt(l, "rotation", 5) > 50);                         // leaves steeply (25/frame), lands flat
    Mo.setEase(l, "rotation", 0, "linear");
    assert.equal(l.tracks.rotation[0].to, undefined);
});

test("reorder, parent loops, remove frees children, history", () => {
    const s = scene();
    const a = Mo.addLayer(s, Mo.makeLayer(s, "group")), b = Mo.addLayer(s, Mo.makeLayer(s, "shape"));
    b.parent = a.id;
    assert.equal(Mo.canParent(s, a.id, b.id), false);
    assert.equal(Mo.canParent(s, b.id, a.id), true);
    assert.equal(Mo.moveLayer(s, a.id, 1), true);
    assert.deepEqual(s.layers.map((l) => l.id), [b.id, a.id]);
    const h = new Mo.History();
    h.push(s);
    Mo.removeLayer(s, a.id);
    assert.equal(s.layers[0].parent, undefined);
    const back = h.undo(s);
    assert.equal(back.layers.length, 2);
    assert.equal(h.redo(back).layers.length, 1);
});
