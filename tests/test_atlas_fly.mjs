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
    assert.match(status.at(-1), /^Flying — hold the left mouse button to look · W A S D move/);
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
    // look up by dragging (the left button held), then W climbs as well as advances
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

// A Gaussian splat scene is flown like an Atlas world: Shift+J and the Walk button used to exist only for
// worlds and world.glb, so on a splat the key did nothing.
test("a splat scene can be flown (previzCanMove / previzWalkToggle)", async () => {
    const { PrevizWorldMixin } = await mod("bEpicViewer_previzWorld.js");
    const mk = (items, entries) => {
        const calls = [];
        const view = { walking: false, _entries: new Map(entries || []),
                       flyEnter() { calls.push("fly"); return true; }, walkEnter() { calls.push("walk"); return true; } };
        const p = Object.assign({ activeTab: "t", _model3d: view, calls,
            previzScene: () => ({ items }), previzAtlasItem: () => null,
            isPrevizTab: () => true, _modelView: () => view }, PrevizWorldMixin);
        return p;
    };
    const model = (path, id = "m1") => ({ id, kind: "model", src: { path } });
    for (const ext of ["spz", "splat", "ksplat", "sog"]) {
        const p = mk([model(`/x/scene.${ext}`)]);
        assert.equal(p.previzCanMove(), true, ext);
        assert.equal(p.previzWalkToggle(), true);
        assert.deepEqual(p.calls, ["fly"]);
    }
    // A .ply is a splat only once the view has seen its header.
    assert.equal(mk([model("/x/a.ply")]).previzCanMove(), false);
    const ply = mk([model("/x/a.ply")], [["m1", { stats: { splats: 5 } }]]);
    assert.equal(ply.previzCanMove(), true);
    // Meshes: unchanged.
    assert.equal(mk([model("/x/a.glb")]).previzCanMove(), false);
    assert.equal(mk([model("/x/a.glb")], [["m1", { stats: { splats: 0 } }]]).previzCanMove(), false);
    const w = mk([{ id: "e", kind: "environment" }]);
    assert.equal(w.previzWalkToggle(), true);
    assert.deepEqual(w.calls, ["walk"]);
});

test("walk mode looks only while the left button is held; plain mouse moves turn nothing", () => {
    const { view, canvas, doc } = makeView();
    let locks = 0, unlocks = 0;
    canvas.requestPointerLock = () => { locks++; doc.pointerLockElement = canvas; };
    doc.exitPointerLock = () => { unlocks++; doc.pointerLockElement = null; };
    view.flyEnter();
    assert.equal(locks, 0, "entering takes no pointer lock");
    const yaw0 = view._walk.yaw, pitch0 = view._walk.pitch;
    doc.on.get("mousemove")({ clientX: 300, clientY: 200, movementX: 300, movementY: 200 });
    assert.equal(view._walk.yaw, yaw0);
    assert.equal(view._walk.pitch, pitch0);
    // a right-button press does not start a look
    canvas.on.get("mousedown")({ button: 2, clientX: 10, clientY: 10 });
    doc.on.get("mousemove")({ clientX: 50, clientY: 50, movementX: 40, movementY: 40 });
    assert.equal(view._walk.yaw, yaw0);
    // left button held: look, with the pointer locked for the drag
    canvas.on.get("mousedown")({ button: 0, clientX: 10, clientY: 10 });
    assert.equal(locks, 1);
    doc.on.get("mousemove")({ clientX: 10, clientY: 10, movementX: 100, movementY: 0 });
    assert.ok(Math.abs(view._walk.yaw - (yaw0 - 100 * 0.0022)) < 1e-9);
    // released: the lock goes and moves are ignored again
    doc.on.get("mouseup")({ button: 0 });
    assert.equal(unlocks, 1);
    const yaw1 = view._walk.yaw;
    doc.on.get("mousemove")({ clientX: 99, clientY: 99, movementX: 90, movementY: 90 });
    assert.equal(view._walk.yaw, yaw1);
});

test("the toolbar's walk button is lit while walking, whoever started it", () => {
    const { view } = makeView();
    const cls = new Set();
    const walkBtn = { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, style: {}, title: "" };
    const m = Model3DView.prototype;
    const sync = () => m._syncToolbar.call({
        ui: { walkBtn, modeSel: {}, gridBtn: { classList: { toggle() {} } }, toolBtns: {}, spaceBtn: null, pivotBtn: null },
        hooks: { canWalk: () => true }, _walk: view._walk, materialMode: "", showGrid: false,
    });
    sync();
    assert.ok(!cls.has("active"));
    view.flyEnter();
    sync();
    assert.ok(cls.has("active"));
    assert.match(walkBtn.title, /left mouse button/);
});

// A refused model path (a typo) left its error on the item's entry; the next job's scene reused the entry
// and the stale error was reported as that job's own failure ("the server answered 403") although its file loaded.
test("a model load clears the error an earlier file left on the entry", async () => {
    const item = { id: "scene", kind: "model", name: "Scene model", src: { path: "W:/x/ok.ply" } };
    const entry = { item, object: null, error: "the server answered 403", key: "W:/x/bad.py" };
    const self = Object.assign(Object.create(Model3DView.prototype), {
        hooks: { srcUrl: (s) => s.path }, _entries: new Map([["scene", entry]]), sceneFrame: 0,
        _isCache: () => false, _bodyOf: () => ({ add() {} }), _statsOf: () => ({}), _originals: new Map(),
        setMaterialMode() {}, materialMode: "original",
        async _load() { return { object: { traverse() {} }, animations: [] }; },
    });
    await self._loadEntry(entry, item);
    assert.equal(entry.error, null);
    assert.ok(entry.object);
});
