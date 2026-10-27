// node --test tests/test_atlas_render.mjs
// The "Render with Atlas" button: the pure helpers, then the whole click flow (dialog -> camera capture ->
// POST /bepic/atlas_render -> poll -> push to a tab) against a fake DOM and a fake viewer, with the
// viewer's real js copied beside stubbed ComfyUI scripts (the same trick tests/harness uses).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const jsDir = path.join(here, "..", "js");

// ── a sandbox: <tmp>/ext/js (the real files) and <tmp>/scripts (stubs) so "../../scripts/api.js" resolves ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-js-"));
fs.mkdirSync(path.join(tmp, "ext", "js"), { recursive: true });
fs.mkdirSync(path.join(tmp, "scripts"));
for (const f of fs.readdirSync(jsDir)) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(jsDir, f), path.join(tmp, "ext", "js", f));
}
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
fs.writeFileSync(path.join(tmp, "scripts", "api.js"), `
export const calls = [];
export const script = { fetch: async () => ({ ok: true, json: async () => ({}) }) };
export const api = {
  apiURL: (p) => p, fileURL: (p) => p, addEventListener() {}, removeEventListener() {},
  async fetchApi(p, o) { calls.push([p, o && o.body ? JSON.parse(o.body) : null, (o && o.method) || "GET"]); return script.fetch(p, o); },
};
`);
fs.writeFileSync(path.join(tmp, "scripts", "app.js"), `
export const toasts = [];
export const app = { graph: { setDirtyCanvas() {} }, extensionManager: { toast: { add: (t) => toasts.push(t) } },
  registerExtension() {}, canvas: {} };
`);
const A = await import(url.pathToFileURL(path.join(tmp, "ext", "js", "bEpicViewer_atlasRender.js")).href);
const apiStub = await import(url.pathToFileURL(path.join(tmp, "scripts", "api.js")).href);
const appStub = await import(url.pathToFileURL(path.join(tmp, "scripts", "app.js")).href);
const Mixin = await import(url.pathToFileURL(path.join(tmp, "ext", "js", "bEpicViewer_previzAtlas.js")).href);

const World = await import(url.pathToFileURL(path.join(tmp, "ext", "js", "bEpicViewer_previzWorld.js")).href);

const M16 = Array.from({ length: 16 }, (_, i) => i);
const mat = (elements) => ({ elements: Float32Array.from(elements) });

function fakeView({ through = true, item = { id: "m1" } } = {}) {
    const free = { fov: 35, aspect: 1.25, matrixWorld: mat(M16), updateMatrixWorld() { this.updated = true; } };
    const gate = { fov: 35, aspect: 99, matrixWorld: mat(M16.map((v) => v + 100)), updateMatrixWorld() {} };
    const body = { matrixWorld: mat(M16.map((v) => v + 200)), updateWorldMatrix() { this.updated = true; } };
    return {
        _walk: false, camera: free, scene3d: { activeCamera: through ? "cam1" : null },
        _entries: new Map([["cam1", { camera: gate, item: { name: "Atlas camera", fov: 50, resolution: [1280, 720] } }], ["m1", { item }]]),
        activeCameraObject() { return through ? gate : free; },
        _bodyOf() { return body; },
        body, free, gate,
    };
}

test("the world is the model called world.glb", () => {
    const scene = { items: [{ kind: "model", src: { path: "C:/o/chair.glb" } },
                            { kind: "camera" }, { id: "w", kind: "model", src: { path: "D:\\out\\3d_scenes\\atlas\\court\\world.glb" } }] };
    assert.equal(A.atlasWorldItem(scene).id, "w");
    assert.equal(A.atlasWorldName(A.atlasWorldItem(scene).src.path), "court");
    assert.equal(A.atlasWorldItem({ items: [{ kind: "model", src: { path: "x/myworld.glb" } }] }), null);
    assert.equal(A.atlasWorldItem(null), null);
});

test("the camera is captured raw: matrices, the gate's lens, 16:9 detection", () => {
    const view = fakeView({ through: true });
    const c = A.captureCamera(view, { id: "m1" });
    assert.deepEqual(c.camera_world, M16.map((v) => v + 100));
    assert.deepEqual(c.model_world, M16.map((v) => v + 200));
    assert.equal(c.fov, 50);                                   // the item's lens, not the overscanned viewport's
    assert.ok(Math.abs(c.aspect - 16 / 9) < 1e-9);
    assert.equal(c.gated, true);
    assert.equal(c.label, "Atlas camera");
    assert.ok(view.body.updated);
    const f = A.captureCamera(fakeView({ through: false }), { id: "m1" });
    assert.equal((f.fov, f.aspect, f.gated), false);
    assert.deepEqual([f.fov, f.aspect], [35, 1.25]);           // the viewport's
    const wide = fakeView({ through: true });
    wide._entries.get("cam1").item.resolution = [2390, 1000];  // a 2.39 gate is not what Atlas renders
    assert.equal(A.captureCamera(wide, { id: "m1" }).gated, false);
});

test("the request carries the path, the camera and the options, no label", () => {
    const req = A.buildRequest({ src: { path: "C:/w/court/world.glb" } },
        { camera_world: M16, model_world: M16, fov: 50, aspect: 1.7, gated: true, label: "x" }, { upscale: "2", addToWorld: true });
    assert.deepEqual(Object.keys(req).sort(), ["add_to_world", "camera", "upscale", "world_path"]);
    assert.equal(req.upscale, 2);
    assert.equal(req.camera.label, undefined);
});

test("runAtlasRender follows the job to the end, and reports errors", async () => {
    const states = [{ state: "running", elapsed: 1 }, { state: "done", path: "C:/r.png" }];
    const seen = [];
    const done = await A.runAtlasRender({ post: async () => ({ id: "j1" }), get: async () => states.shift(), request: {},
                                          onState: (s) => seen.push(s.state), sleep: async () => {} });
    assert.equal(done.path, "C:/r.png");
    assert.deepEqual(seen, ["running", "done"]);
    await assert.rejects(A.runAtlasRender({ post: async () => ({ id: "j" }), sleep: async () => {},
        get: async () => ({ state: "error", message: "out of credits", error_kind: "balance" }), request: {} }),
        (e) => e.kind === "balance" && /credits/.test(A.explainError(e)));
    await assert.rejects(A.runAtlasRender({ post: async () => ({ error: "nope" }), get: async () => ({}), request: {} }), /nope/);
    await assert.rejects(A.runAtlasRender({ post: async () => ({ id: "j" }), get: async () => ({ state: "running" }),
        request: {}, sleep: async () => {}, pollMs: 1000, timeoutMs: 3000 }), (e) => e.kind === "timeout");
    assert.equal(A.clock(65), "1:05");
});

// ── the button flow, against a fake DOM ─────────────────────────────────────────────────────────────────
class El {
    constructor(tag, doc) {
        this.tagName = tag; this.ownerDocument = doc; this.children = []; this.parent = null; this.style = {};
        this.attrs = {}; this.className = ""; this.textContent = ""; this.value = ""; this.checked = false; this.disabled = false;
        const self = this;
        this.classList = {
            _s() { return new Set(self.className.split(/\s+/).filter(Boolean)); },
            add(c) { const s = this._s(); s.add(c); self.className = [...s].join(" "); },
            remove(c) { const s = this._s(); s.delete(c); self.className = [...s].join(" "); },
            contains(c) { return this._s().has(c); },
        };
    }
    append(...kids) { for (const k of kids) { if (typeof k === "string") { this.textContent += k; continue; } k.parent = this; this.children.push(k); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.ownerDocument.body; }
    find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c.find(pred); if (r) return r; } return null; }
}
const makeDoc = () => { const doc = { createElement: (t) => new El(t, doc) }; doc.body = new El("body", doc); return doc; };

function makeViewer({ through = true } = {}) {
    const doc = makeDoc();
    const item = { id: "m1", kind: "model", src: { path: "D:/out/3d_scenes/atlas/court/world.glb" } };
    const view = fakeView({ through, item });
    const keys = new Map();
    const win = { addEventListener: (k, f) => keys.set(k, f), removeEventListener: (k) => keys.delete(k) };
    const ctx = Object.assign({
        container: doc.body, activeTab: "previz:atlas_court", isPrevizTab: () => true,
        previzScene: () => ({ items: [item] }), _modelView: () => view, _viewerWindow: () => win,
    }, Mixin.PrevizAtlasMixin);
    return { ctx, doc, view, win, keys };
}

const flush = () => new Promise((r) => setImmediate(r));

test("clicking Render sends the current camera, follows the job and shows the picture in a tab", async () => {
    apiStub.calls.length = 0;
    appStub.toasts.length = 0;
    let polls = 0;
    apiStub.script.fetch = async (p, o) => {
        const ok = (body) => ({ ok: true, status: 200, json: async () => body });
        if (p === "/bepic/atlas_render" && o && o.method === "POST") return ok({ ok: true, id: "job1", state: "running" });
        if (p.startsWith("/bepic/atlas_render?id=")) {
            polls += 1;
            return ok(polls < 2 ? { id: "job1", state: "running", phase: "Atlas is painting the view", elapsed: 3 }
                : { id: "job1", state: "done", path: "D:/out/3d_scenes/atlas/court/renders/render_000_x2.png", added_to_world: true });
        }
        if (p === "/bepic/push") return ok({ ok: true, shown: 1, refused: [] });
        throw new Error("unexpected " + p);
    };
    const { ctx, doc, keys, view } = makeViewer({ through: true });
    const reloaded = [];
    view.reloadModel = async (id) => { reloaded.push(id); return true; };
    ctx.previzAtlasDialog();
    const dlg = doc.body.find((e) => e.className.includes("atlas-dlg"));
    assert.ok(dlg, "the dialog is up");
    assert.ok(keys.has("keydown"));
    const hasText = (re) => (e) => re.test(e.textContent);
    assert.ok(doc.body.find(hasText(/16:9/)), "it says which camera it will use");
    const select = dlg.find((e) => e.tagName === "select");
    const choices = select.children.map((o) => o.value);
    assert.deepEqual(choices, ["0", "2", "4"]);
    select.value = "2";
    const check = dlg.find((e) => e.tagName === "input");
    check.checked = true;
    const go = dlg.find((e) => e.className.includes("rd-go"));
    const done = go.onclick();
    await flush();
    assert.ok(go.disabled && ctx._atlasBusy, "busy while it runs");
    await done;                                                  // ~2.5 s of polling
    const post = apiStub.calls.find((c) => c[0] === "/bepic/atlas_render" && c[2] === "POST");
    assert.equal(post[1].world_path, "D:/out/3d_scenes/atlas/court/world.glb");
    assert.equal(post[1].upscale, 2);
    assert.equal(post[1].add_to_world, true);
    assert.deepEqual(post[1].camera.camera_world, M16.map((v) => v + 100));
    assert.deepEqual(post[1].camera.model_world, M16.map((v) => v + 200));
    assert.equal(post[1].camera.gated, true);
    const push = apiStub.calls.find((c) => c[0] === "/bepic/push");
    assert.deepEqual(push[1].paths, ["D:/out/3d_scenes/atlas/court/renders/render_000_x2.png"]);
    assert.equal(push[1].tab_name, "Atlas: court");
    assert.equal(push[1].focus, true);
    assert.equal(ctx._atlasBusy, false);
    assert.equal(doc.body.find((e) => e.className.includes("atlas-dlg")), null, "the dialog closes when done");
    assert.ok(appStub.toasts.some((t) => /Atlas render ready/.test(t.summary)));
    assert.deepEqual(reloaded, ["m1"], "the world's mesh is reloaded in place");
    assert.ok(appStub.toasts.some((t) => /World updated/.test(t.summary)), "and the notice says so");
    assert.ok(!appStub.toasts.some((t) => /Re-open/.test(t.detail || "")));
    assert.ok(!keys.has("keydown"), "the key handler is gone");
});

test("an error keeps the dialog open with the reason, and the button works again", async () => {
    apiStub.calls.length = 0;
    apiStub.script.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "the agentY host is not running" }) });
    const { ctx, doc } = makeViewer({ through: false });
    ctx.previzAtlasDialog();
    const dlg = doc.body.find((e) => e.className.includes("atlas-dlg"));
    assert.ok(doc.body.find((e) => /free camera/.test(e.textContent)));
    const go = dlg.find((e) => e.className.includes("rd-go"));
    await go.onclick();
    const msg = dlg.find((e) => e.className.includes("rd-message"));
    assert.match(msg.textContent, /agentY host is not running/);
    assert.ok(msg.className.includes("error"));
    assert.equal(go.disabled, false);
    assert.equal(ctx._atlasBusy, false);
    const post = apiStub.calls.find((c) => c[0] === "/bepic/atlas_render");
    assert.equal(post[1].camera.gated, false);
    assert.equal(post[1].camera.fov, 35);                        // the free camera's lens and shape go along
    assert.equal(post[1].camera.aspect, 1.25);
});

test("no world, no dialog", () => {
    const { ctx, doc } = makeViewer();
    ctx.previzScene = () => ({ items: [{ id: "x", kind: "model", src: { path: "C:/a/duck.glb" } }] });
    ctx.previzAtlasDialog();
    assert.equal(doc.body.find((e) => e.className.includes("atlas-dlg")), null);
    assert.equal(ctx.previzAtlasItem(), null);
});

test("flying: W follows the whole view direction (pitch included), A/D strafe, E/Q go up and down", () => {
    const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} vs ${b}`));
    const go = (keys, o = {}) => A.flyDelta({ yaw: 0, pitch: 0, keys: new Set(keys), speed: 1.5, dt: 1, ...o });
    near(go(["w"]), [0, 0, -1.5]);                                  // looking down -Z
    near(go(["s"]), [0, 0, 1.5]);
    near(go(["d"]), [1.5, 0, 0]);
    near(go(["a"]), [-1.5, 0, 0]);
    near(go(["e"]), [0, 1.5, 0]);
    near(go([" "]), [0, 1.5, 0]);
    near(go(["q"]), [0, -1.5, 0]);
    near(go(["c"]), [0, -1.5, 0]);
    near(go(["w", "s"]), [0, 0, 0]);
    near(go(["w"], { pitch: Math.PI / 2 }), [0, 1.5, 0]);           // looking straight up: W climbs
    near(go(["w"], { pitch: Math.PI / 6 }), [0, 0.75, -1.5 * Math.cos(Math.PI / 6)]);
    near(go(["w"], { yaw: Math.PI / 2 }), [-1.5, 0, 0]);            // turned left: forward is -X
    near(go(["w", "Shift"]), [0, 0, -1.5 * A.FLY_FAST]);
    near(go(["w"], { dt: 0.5, speed: 4 }), [0, 0, -2]);
    assert.equal(A.FLY_SPEED, 1.5);
});

test("the wheel scales the speed, clamped, and the status line shows it", () => {
    assert.ok(A.flyWheel(1.5, -100) > 1.5);
    assert.ok(A.flyWheel(1.5, 100) < 1.5);
    assert.ok(Math.abs(A.flyWheel(A.flyWheel(1.5, -100), 100) - 1.5) < 1e-9);
    assert.equal(A.flyWheel(1, -1e9), A.flyWheel(1, -400));             // one notch is capped
    let v = 1.5;
    for (let i = 0; i < 500; i++) v = A.flyWheel(v, -100);
    assert.equal(v, A.FLY_SPEED_MAX);
    for (let i = 0; i < 1000; i++) v = A.flyWheel(v, 100);
    assert.equal(v, A.FLY_SPEED_MIN);
    assert.equal(A.flyWheel(1.5, 0), 1.5);
    assert.match(A.flyStatus(1.5), /^Flying — hold the left mouse button to look · W A S D move · E\/Q up\/down · Shift fast · wheel speed 1\.5 m\/s · Esc stop$/);
    assert.match(A.flyStatus(12.345), /12\.3 m\/s/);
});

test("after flying, the free camera at the flown pose is what Render with Atlas sends", () => {
    // flying leaves the scene's active camera empty: the free camera, not the shot camera, is looked through
    const view = fakeView({ through: false });
    view.free.fov = 50;                                            // the shot camera's lens, kept
    const c = A.captureCamera(view, { id: "m1" });
    assert.deepEqual(c.camera_world, M16);                         // the free camera's matrix
    assert.deepEqual([c.fov, c.gated], [50, false]);
    // still flying: the walk flag changes nothing about which camera it is
    view._walk = {};
    assert.deepEqual(A.captureCamera(view, { id: "m1" }).camera_world, M16);
    // while a shot camera is active and not flying, it is the shot camera, as before
    assert.equal(A.captureCamera(fakeView({ through: true }), { id: "m1" }).gated, true);
});

test("Walk / Shift+J apply to an Atlas world as well as to a viewer world", () => {
    const atlas = { items: [{ id: "w", kind: "model", src: { path: "D:/o/atlas/court/world.glb" } }, { kind: "camera" }] };
    const plain = { items: [{ id: "d", kind: "model", src: { path: "C:/a/duck.glb" } }] };
    const viewerWorld = { items: [{ id: "t", kind: "terrain" }] };
    const mk = (scene) => Object.assign({ activeTab: "k", previzScene: () => scene }, World.PrevizWorldMixin, Mixin.PrevizAtlasMixin);
    assert.equal(mk(atlas).previzHasWorld(), false);               // not a viewer world ...
    assert.equal(mk(atlas).previzCanMove(), true);                 // ... but it can be flown
    assert.equal(mk(viewerWorld).previzCanMove(), true);
    assert.equal(mk(plain).previzCanMove(), false);
});

test("the Walk toggle flies an Atlas world, walks a viewer world, and stops either", () => {
    const calls = [];
    const view = { walking: false, flyEnter() { calls.push("fly"); this.walking = true; return true; },
                   walkEnter() { calls.push("walk"); this.walking = true; return true; },
                   walkExit() { calls.push("exit"); this.walking = false; } };
    const atlas = { items: [{ id: "w", kind: "model", src: { path: "D:/o/atlas/court/world.glb" } }] };
    const world = { items: [{ id: "t", kind: "terrain" }] };
    const mk = (scene) => Object.assign({ activeTab: "k", isPrevizTab: () => true, previzScene: () => scene, _modelView: () => view },
                                        World.PrevizWorldMixin, Mixin.PrevizAtlasMixin);
    const a = mk(atlas);
    assert.equal(a.previzWalkToggle(), true);
    assert.equal(a.previzWalkToggle(), false);
    view.walking = false;
    const w = mk(world);
    assert.equal(w.previzWalkToggle(), true);
    assert.deepEqual(calls, ["fly", "exit", "walk"]);
});

test("a reload asks for the same file under a new URL, and a blob stays as it is", () => {
    assert.equal(A.bustUrl("/bepic/view_file?path=a%2Fworld.glb", 7), "/bepic/view_file?path=a%2Fworld.glb&_=7");
    assert.equal(A.bustUrl("/x/world.glb", 7), "/x/world.glb?_=7");
    assert.equal(A.bustUrl("blob:http://h/abc", 7), "blob:http://h/abc");
    assert.equal(A.bustUrl("", 7), "");
});
