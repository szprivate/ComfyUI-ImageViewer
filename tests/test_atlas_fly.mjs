// node --test tests/test_atlas_fly.mjs
// Flying through an Atlas world: the real walkEnter/walkExit/_flyStep from bEpicViewer_world3d.js and the
// real Model3DView.reloadModel, on a stand-in view with the vendored three.js (no DOM, no renderer).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-fly-"));
fs.mkdirSync(path.join(tmp, "ext", "js"), { recursive: true });
fs.mkdirSync(path.join(tmp, "scripts"));
for (const f of fs.readdirSync(path.join(root, "js"))) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(root, "js", f), path.join(tmp, "ext", "js", f));
}
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
fs.writeFileSync(path.join(tmp, "scripts", "api.js"), "export const api = { apiURL: (p) => p, fetchApi: async () => ({ ok: true, json: async () => ({}) }), addEventListener() {}, removeEventListener() {} };");
fs.writeFileSync(path.join(tmp, "scripts", "app.js"), "export const app = { registerExtension() {}, extensionManager: { toast: { add() {} } }, canvas: {} };");
const mod = (n) => import(url.pathToFileURL(path.join(tmp, "ext", "js", n)).href);
const THREE = await import(url.pathToFileURL(path.join(root, "vendor", "three", "three.module.js")).href);
const { WorldViewMixin } = await mod("bEpicViewer_world3d.js");
const { Model3DView } = await mod("bEpicViewer_model3d.js");

/** A listener table standing in for window / document / canvas. */
const target = () => ({
    on: new Map(), pointerLockElement: null,
    addEventListener(k, f) { this.on.set(k, f); }, removeEventListener(k) { this.on.delete(k); },
    requestPointerLock() {}, exitPointerLock() {},
});

function makeView({ activeCamera = "cam1" } = {}) {
    const shot = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
    shot.position.set(1, 2, 3);
    shot.rotation.set(0.2, 0.5, 0);
    shot.updateMatrixWorld(true);
    const free = new THREE.PerspectiveCamera(35, 1.25, 0.1, 1000);
    free.position.set(9, 9, 9);
    const canvas = target(), doc = target(), win = target();
    const status = [];
    const view = Object.assign(Object.create(WorldViewMixin), {
        libs: { THREE }, canvas, doc, win, camera: free, controls: null, gizmo: null, root: { classList: { add() {}, remove() {} } },
        hooks: {}, scene3d: { activeCamera, items: [] },
        _entries: new Map([["cam1", { camera: shot, item: { fov: 40, name: "atlascam" } }]]),
        _setStatus: (t) => status.push(t), _syncGate() {}, requestRender() {},
        activeCameraObject() { return this._walk ? this.camera : (this._entries.get(this.scene3d.activeCamera) || {}).camera || this.camera; },
        groundAt() { throw new Error("flying has no ground"); },
    });
    return { view, shot, free, canvas, doc, win, status };
}

const key = (type, k) => ({ type, key: k, preventDefault() {}, stopPropagation() {} });
const wheel = (deltaY) => ({ deltaY, preventDefault() {}, stopPropagation() {} });

test("flying starts at the shot camera's exact pose and lens, and never touches the shot camera", () => {
    const { view, shot, free, status } = makeView();
    const q = shot.quaternion.clone(), p = shot.position.clone(), fov = shot.fov;
    assert.equal(view.flyEnter(), true);
    assert.equal(view.walking, true);
    assert.equal(view.scene3d.activeCamera, null, "the free camera is looked through");
    assert.ok(free.position.distanceTo(p) < 1e-9);
    assert.ok(free.quaternion.angleTo(q) < 1e-6);
    assert.equal(free.fov, 40, "the shot camera item's lens");
    assert.ok(shot.position.equals(p) && shot.quaternion.equals(q) && shot.fov === fov);
    assert.match(status.at(-1), /^Flying — click to look · W A S D move/);
});

test("W flies along the view including pitch, with no ground; E and Q climb; Shift is faster", () => {
    const { view, free, win, canvas, doc } = makeView({ activeCamera: null });
    free.position.set(0, 0, 0);
    free.rotation.set(0, 0, 0);
    free.updateMatrixWorld(true);
    view.flyEnter();
    const onKey = win.on.get("keydown");
    onKey(key("keydown", "w"));
    view._walkStep(1);
    assert.ok(Math.abs(free.position.z + 1.5) < 1e-9, "1.5 m/s down -Z");
    onKey(key("keyup", "w"));
    onKey(key("keydown", "e"));
    view._walkStep(2);
    assert.ok(Math.abs(free.position.y - 3) < 1e-9);
    onKey(key("keyup", "e"));
    onKey(key("keydown", " "));
    onKey(key("keydown", "Shift"));
    view._walkStep(1);
    assert.ok(Math.abs(free.position.y - (3 + 1.5 * 3)) < 1e-9);
    // look up by dragging (no pointer lock needed), then W climbs as well as advances
    for (const k of [" ", "Shift"]) onKey(key("keyup", k));
    canvas.on.get("mousedown")({ clientX: 100, clientY: 100 });
    doc.on.get("mousemove")({ clientX: 100, clientY: 100 - 0.7854 / 0.0022 });
    const y0 = free.position.y;
    onKey(key("keydown", "w"));
    view._walkStep(1);
    assert.ok(free.position.y - y0 > 1, "W follows the pitch");
});

test("the wheel scales the speed while flying and the status line shows it", () => {
    const { view, canvas, status } = makeView();
    view.flyEnter();
    canvas.on.get("wheel")(wheel(-100));
    assert.ok(view._walk.speed > 1.5);
    assert.match(status.at(-1), /wheel speed 1\.\d+ m\/s/);
    for (let i = 0; i < 300; i++) canvas.on.get("wheel")(wheel(-100));
    assert.equal(view._walk.speed, 200);
});

test("Esc leaves the free camera where it flew to, with the same lens; the shot camera is not made active again", () => {
    const { view, free, win } = makeView();
    view.flyEnter();
    win.on.get("keydown")(key("keydown", "w"));
    view._walkStep(2);
    const at = free.position.clone(), q = free.quaternion.clone();
    win.on.get("keydown")(key("keydown", "Escape"));
    assert.equal(view.walking, false);
    assert.ok(free.position.equals(at) && free.quaternion.equals(q), "no snap back");
    assert.equal(free.fov, 40);
    assert.equal(view.scene3d.activeCamera, null, "still looking through the free camera: that is what Render with Atlas sends");
    assert.equal(win.on.size, 0, "listeners are gone");
});

test("walking a viewer world still gives the lens and the shot camera back on exit", () => {
    const { view, free } = makeView();
    view.groundAt = () => null;
    view.walkEnter();
    assert.equal(free.fov, 60);
    view.walkExit();
    assert.equal(view.scene3d.activeCamera, "cam1");
    assert.equal(free.fov, 35);
});

test("reloadModel re-reads the model's file under a cache-busting URL and leaves the rest alone", async () => {
    const item = { id: "w", kind: "model", name: "world", src: { path: "D:/o/atlas/court/world.glb" } };
    const urls = [];
    const entry = { item, object: { old: true } };
    const other = { item: { id: "x", kind: "primitive" }, object: {} };
    const self = Object.assign(Object.create(Model3DView.prototype), {
        hooks: { srcUrl: (s) => `/bepic/view_file?path=${encodeURIComponent(s.path)}` },
        _entries: new Map([["w", entry], ["x", other]]), sceneFrame: 0,
        _disposeEntry(e) { e.object = null; }, applyFrame() {}, _updateSceneStats() {}, requestRender() { this.rendered = true; },
        async _loadEntry(e, it) { urls.push(this._srcUrlFor(it)); e.object = { fresh: true }; return e; },
    });
    assert.equal(await self.reloadModel("w"), true);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^\/bepic\/view_file\?path=D%3A%2Fo%2Fatlas%2Fcourt%2Fworld\.glb&_=\d+$/);
    assert.deepEqual(entry.object, { fresh: true });
    assert.deepEqual(other.object, {}, "other items untouched");
    assert.equal(await self.reloadModel("x"), false, "only a model item");
    assert.equal(await self.reloadModel("nope"), false);
});
