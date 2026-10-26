// node --test tests/test_atlas_move.mjs
// "Render camera with Atlas": the timeline camera sampled per frame, the dry run that prices it, the
// confirm, the progress by tasks, and the failure when agentY is not there - against a fake DOM and a
// fake viewer, with the viewer's real js copied beside stubbed ComfyUI scripts (as test_atlas_render.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const jsDir = path.join(here, "..", "js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-move-js-"));
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
const imp = (f) => import(url.pathToFileURL(path.join(tmp, "ext", "js", f)).href);
const A = await imp("bEpicViewer_atlasRender.js");
const S = await imp("bEpicViewer_scene3d.js");
const Mixin = await imp("bEpicViewer_previzAtlas.js");
const apiStub = await import(url.pathToFileURL(path.join(tmp, "scripts", "api.js")).href);
const appStub = await import(url.pathToFileURL(path.join(tmp, "scripts", "app.js")).href);

const M16 = Array.from({ length: 16 }, (_, i) => i);

// a camera keyed at frames 0 and 48 (2 s at 24 fps), moving 3 m along -Z
const camItem = () => ({
    id: "cam1", kind: "camera", name: "Shot camera", fov: 40, position: [0, 0, 0], rotation: [0, 0, 0],
    tracks: { position: [{ f: 0, v: [0, 0, 0], ease: "linear" }, { f: 48, v: [0, 0, -3], ease: "linear" }] },
});
const worldItem = () => ({ id: "m1", kind: "model", src: { path: "D:/out/3d_scenes/atlas/court/world.glb" } });

function fakeView(cam) {
    const camera = { matrixWorld: { elements: new Float32Array(16) }, updateMatrixWorld() {} };
    const view = {
        sceneFrame: 5, applied: [],
        applyFrame(f) {
            view.applied.push(f); view.sceneFrame = f;
            const z = S.valueAt(cam, "position", f)[2];
            camera.matrixWorld.elements = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]);
        },
        _entries: new Map([["cam1", { camera, item: cam }], ["m1", { item: worldItem() }]]),
        _bodyOf: () => ({ matrixWorld: { elements: M16.map((v) => v + 200) }, updateWorldMatrix() {} }),
    };
    return view;
}

test("describeMove finds the keyframed camera and its range; a static scene is explained", () => {
    const scene = { fps: 24, activeCamera: "cam1", items: [worldItem(), camItem()] };
    const mv = A.describeMove(scene, S);
    assert.deepEqual([mv.start, mv.end, mv.frames, mv.seconds], [0, 48, 49, 2]);
    assert.match(A.describeMove({ fps: 24, items: [worldItem(), { id: "c", kind: "camera", position: [0, 0, 0], rotation: [0, 0, 0] }] }, S).error, /no camera animation/);
    const one = camItem();
    one.tracks.position = [{ f: 3, v: [0, 0, 0] }];
    assert.match(A.describeMove({ fps: 24, items: [one] }, S).error, /two different frames/);
});

test("sampleMove reads the camera's matrix at every frame and puts the scene back", () => {
    const cam = camItem();
    const view = fakeView(cam);
    const keys = A.sampleMove({ start: 0, end: 48, fps: 24, applyFrame: (f) => view.applyFrame(f),
        cameraObject: () => view._entries.get("cam1").camera, fovAt: (f) => S.valueAt(cam, "fov", f), restoreFrame: 5 });
    assert.equal(keys.length, 49);
    assert.deepEqual([keys[0].t, keys[48].t], [0, 2]);
    assert.equal(keys[24].camera_world[14], -1.5);               // half way along the path
    assert.equal(keys[0].fov, 40);
    assert.ok(Math.abs(keys[0].aspect - 16 / 9) < 1e-9);
    assert.equal(view.sceneFrame, 5, "the timeline is back where the user left it");
    const thin = A.sampleMove({ start: 0, end: 48, fps: 24, maxKeys: 10, applyFrame: (f) => view.applyFrame(f),
        cameraObject: () => view._entries.get("cam1").camera, fovAt: () => 40 });
    assert.ok(thin.length <= 11 && thin[thin.length - 1].t === 2, "long paths are thinned but keep the end");
});

test("the request and the plan line", () => {
    const req = A.buildMoveRequest({ src: { path: "C:/w/court/world.glb" } }, [{ t: 0 }], M16,
        { quality: "high", fps: 24, name: "push", dryRun: true });
    assert.deepEqual([req.world_path, req.quality, req.dry_run, req.confirm_cost, req.model_world.length],
        ["C:/w/court/world.glb", "high", true, false, 16]);
    const plan = { frames: 49, seconds: 2, keyframes: 5, tasks: 2, estimate: { min_usd: 0.2, max_usd: 0.5 } };
    assert.equal(A.describePlan(plan), "49 frames (2s) · Atlas paints 5 views in 2 tasks · about $0.20–$0.50 of World Labs credits");
    assert.equal(A.planOrThrow({ status: "dry_run", plan }), plan);
    assert.throws(() => A.planOrThrow({ error: "WLT_API_KEY missing", error_kind: "auth" }), /WLT_API_KEY/);
    assert.match(A.moveProgress({ phase: "Atlas is painting views 1 of 2", tasks_done: 0, tasks_total: 2, elapsed: 65 }), /\(0\/2 tasks\)… 1:05/);
});

// ── the dialog against a fake DOM ────────────────────────────────────────────────────────────────────────
class El {
    constructor(tag, doc) {
        this.tagName = tag; this.ownerDocument = doc; this.children = []; this.parent = null; this.style = {};
        this.attrs = {}; this.className = ""; this.textContent = ""; this.value = ""; this.disabled = false;
        const self = this;
        this.classList = {
            _s() { return new Set(self.className.split(/\s+/).filter(Boolean)); },
            add(c) { const s = this._s(); s.add(c); self.className = [...s].join(" "); },
            remove(c) { const s = this._s(); s.delete(c); self.className = [...s].join(" "); },
        };
    }
    append(...kids) { for (const k of kids) { if (typeof k === "string") { this.textContent += k; continue; } k.parent = this; this.children.push(k); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.ownerDocument.body; }
    find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c.find(pred); if (r) return r; } return null; }
}

function makeViewer(cam = camItem()) {
    const doc = { createElement: (t) => new El(t, doc) };
    doc.body = new El("body", doc);
    const scene = { fps: 24, activeCamera: "cam1", items: [worldItem(), cam] };
    const view = fakeView(cam);
    const win = { addEventListener() {}, removeEventListener() {} };
    return Object.assign({ container: doc.body, activeTab: "previz:x", isPrevizTab: () => true, previzScene: () => scene,
        _modelView: () => view, _viewerWindow: () => win }, Mixin.PrevizAtlasMixin);
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 20));
const PLAN = { status: "dry_run", dry_run: true, plan: { frames: 49, seconds: 2, keyframes: 5, tasks: 2, estimate: { min_usd: 0.2, max_usd: 0.5 } } };

test("the dialog prices first (a dry run), spends only on the button, shows tasks done, then the clip", async () => {
    apiStub.calls.length = 0;
    appStub.toasts.length = 0;
    let polls = 0;
    apiStub.script.fetch = async (p, o) => {
        const body = o && o.body ? JSON.parse(o.body) : null;
        if (p === "/bepic/atlas_camera_move" && o.method === "POST") return ok(body.dry_run ? PLAN : { ok: true, id: "mv1", state: "running" });
        if (p.startsWith("/bepic/atlas_camera_move?id=")) {
            polls += 1;
            return ok(polls < 2 ? { id: "mv1", state: "running", phase: "Atlas is painting views 1 of 2", tasks_done: 1, tasks_total: 2, elapsed: 4 }
                : { id: "mv1", state: "done", path: "D:/out/previz/court_move.mp4", tasks_done: 2, tasks_total: 2 });
        }
        if (p === "/bepic/push") return ok({ ok: true, shown: 1, refused: [] });
        throw new Error("unexpected " + p);
    };
    const ctx = makeViewer();
    ctx.previzAtlasMoveDialog();
    await flush();
    const dlg = ctx.container.find((e) => e.className.includes("atlas-dlg"));
    assert.ok(dlg, "the dialog is up");
    const price = dlg.find((e) => e.className.includes("atlas-price"));
    assert.match(price.textContent, /Atlas paints 5 views in 2 tasks · about \$0\.20–\$0\.50/);
    const dry = apiStub.calls.filter((c) => c[0] === "/bepic/atlas_camera_move");
    assert.equal(dry.length, 1);
    assert.equal(dry[0][1].dry_run, true);
    assert.equal(dry[0][1].confirm_cost, false, "the quote spends nothing");
    assert.equal(dry[0][1].keys.length, 49);
    assert.deepEqual(dry[0][1].model_world, M16.map((v) => v + 200));
    const go = dlg.find((e) => e.className.includes("rd-go"));
    assert.equal(go.disabled, false);
    assert.match(go.textContent, /up to \$0\.50/);
    // changing the quality asks again
    const sel = dlg.find((e) => e.tagName === "select");
    sel.value = "high";
    sel.onchange();
    await flush();
    assert.equal(apiStub.calls.filter((c) => c[0] === "/bepic/atlas_camera_move").length, 2);
    await go.onclick();
    const real = apiStub.calls.filter((c) => c[0] === "/bepic/atlas_camera_move" && c[2] === "POST").pop();
    assert.equal(real[1].dry_run, false);
    assert.equal(real[1].confirm_cost, true);
    assert.equal(real[1].quality, "high");
    const push = apiStub.calls.find((c) => c[0] === "/bepic/push");
    assert.deepEqual(push[1].paths, ["D:/out/previz/court_move.mp4"]);
    assert.equal(push[1].tab_name, "Atlas move: court");
    assert.ok(appStub.toasts.some((t) => /camera move ready/.test(t.summary)));
    assert.equal(ctx._atlasBusy, false);
    assert.equal(ctx.container.find((e) => e.className.includes("atlas-dlg")), null);
});

test("without agentY the quote fails with the reason and the button stays disabled", async () => {
    apiStub.calls.length = 0;
    apiStub.script.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "the agentY host is not running (start it, then press the button again)" }) });
    const ctx = makeViewer();
    ctx.previzAtlasMoveDialog();
    await flush();
    const dlg = ctx.container.find((e) => e.className.includes("atlas-dlg"));
    const price = dlg.find((e) => e.className.includes("atlas-price"));
    assert.match(price.textContent, /agentY host is not running.*needs agentY running/);
    assert.ok(price.className.includes("error"));
    assert.equal(dlg.find((e) => e.className.includes("rd-go")).disabled, true);
    assert.equal(apiStub.calls.length, 1, "only the quote went out");
});

test("an over-cap or unconfirmed answer ends the run with the reason, and the dialog stays", async () => {
    apiStub.calls.length = 0;
    apiStub.script.fetch = async (p, o) => {
        const body = o && o.body ? JSON.parse(o.body) : null;
        if (body && body.dry_run) return ok(PLAN);
        if (p === "/bepic/atlas_camera_move") return ok({ ok: true, id: "mv2", state: "running" });
        return ok({ id: "mv2", state: "error", error_kind: "over_cap", message: "above the cap of $5.00" });
    };
    const ctx = makeViewer();
    ctx.previzAtlasMoveDialog();
    await flush();
    const dlg = ctx.container.find((e) => e.className.includes("atlas-dlg"));
    await dlg.find((e) => e.className.includes("rd-go")).onclick();
    const msg = dlg.find((e) => e.className.includes("rd-message"));
    assert.match(msg.textContent, /price cap.*above the cap of \$5\.00/);
    assert.ok(msg.className.includes("error"));
    assert.equal(ctx._atlasBusy, false);
});

test("no keyframed camera: a notice, no dialog", () => {
    appStub.toasts.length = 0;
    const flat = camItem();
    flat.tracks = {};
    const ctx = makeViewer(flat);
    ctx.previzAtlasMoveDialog();
    assert.equal(ctx.container.find((e) => e.className.includes("atlas-dlg")), null);
    assert.ok(appStub.toasts.some((t) => /no camera animation/.test(t.detail || "")));
});
