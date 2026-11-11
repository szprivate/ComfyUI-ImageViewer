// node --test tests/test_atlas_create.mjs
// "New Atlas world" (imageViewer_atlasCreate.js): the pure helpers, then the dialog's flow (prompt / pictures
// -> POST /imageviewer/atlas_create -> poll -> close) against a fake DOM, with the viewer's real js copied
// beside stubbed ComfyUI scripts (the same sandbox as test_atlas_render.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const jsDir = path.join(here, "..", "js");

// ── a sandbox: <tmp>/ext/js (the real files) and <tmp>/scripts (stubs) so "../../scripts/api.js" resolves ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-create-js-"));
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
const A = await import(url.pathToFileURL(path.join(tmp, "ext", "js", "imageViewer_atlasRender.js")).href);
const apiStub = await import(url.pathToFileURL(path.join(tmp, "scripts", "api.js")).href);
const appStub = await import(url.pathToFileURL(path.join(tmp, "scripts", "app.js")).href);
const C = await import(url.pathToFileURL(path.join(tmp, "ext", "js", "imageViewer_atlasCreate.js")).href);

test("a world name comes from the words, else the first picture", () => {
    assert.equal(A.worldNameFrom("A sunlit stone courtyard with ivy and a well"), "sunlit_stone_courtyard_ivy");
    assert.equal(A.worldNameFrom("", [{ path: "D:/in/My Room.PNG" }]), "my_room");
    assert.equal(A.worldNameFrom("", []), "world");
});

test("the request names pictures by path or ComfyUI ref, never by URL", () => {
    assert.ok(A.buildCreateRequest({ prompt: " " }).error);
    const r = A.buildCreateRequest({ prompt: "a hall", images: [{ path: "D:/a.png", name: "a", _obj: {} },
        { filename: "b.jpg", subfolder: "s", type: "output" }, { url: "http://x/c.png" }], aspect: "9:16", detail: "8" });
    assert.deepEqual(r.images, [{ path: "D:/a.png" }, { filename: "b.jpg", type: "output", subfolder: "s" }]);
    assert.equal(r.name, "hall");
    assert.equal(r.aspect_ratio, "9:16");
    assert.equal(r.mesh_detail, 8);
    assert.equal(A.buildCreateRequest({ prompt: "x", aspect: "2:1", detail: 3 }).aspect_ratio, "16:9");
    assert.ok(A.buildCreateRequest({ images: Array(9).fill({ path: "p.png" }) }).error);
    assert.ok(A.isAtlasPicture({ filename: "x.webp" }) && !A.isAtlasPicture({ path: "x.mp4" }));
});

// ── the dialog, against a fake DOM ──────────────────────────────────────────────────────────────────────
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
    addEventListener(k, f) { (this.listeners ||= {})[k] = f; }
    focus() {}
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.ownerDocument.body; }
    find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c.find(pred); if (r) return r; } return null; }
}
const makeDoc = () => { const doc = { createElement: (t) => new El(t, doc) }; doc.body = new El("body", doc); return doc; };

function makeViewer(selected = []) {
    const doc = makeDoc();
    const keys = new Map();
    const win = { addEventListener: (k, f) => keys.set(k, f), removeEventListener: (k) => keys.delete(k) };
    const ctx = Object.assign({
        container: doc.body, _viewerWindow: () => win, thumbUrl: (o) => "thumb:" + (o.path || o.filename),
        selectedHistorySnapshots: () => selected.map((f) => ({ imgObj: f, snapshot: [f] })),
    }, C.AtlasCreateMixin);
    return { ctx, doc, keys };
}
const flush = () => new Promise((r) => setImmediate(r));

test("Create sends the prompt and the History's pictures, follows the job and closes", async () => {
    apiStub.calls.length = 0;
    appStub.toasts.length = 0;
    let polls = 0;
    apiStub.script.fetch = async (p, o) => {
        const ok = (body) => ({ ok: true, status: 200, json: async () => body });
        if (p === "/imageviewer/atlas_create" && o && o.method === "POST") return ok({ ok: true, id: "j1", state: "running" });
        if (p.startsWith("/imageviewer/atlas_create?id=")) {
            polls += 1;
            return ok(polls < 2 ? { id: "j1", state: "running", phase: "Atlas is placing the pictures in 3D", elapsed: 4 }
                : { id: "j1", state: "done", name: "room", glb: "D:/o/room/world.glb", tab: "previz:atlas_room" });
        }
        throw new Error("unexpected " + p);
    };
    const { ctx, doc, keys } = makeViewer([{ filename: "room.png", subfolder: "", type: "output" },
                                           { filename: "clip.mp4", type: "output" }]);
    ctx.atlasCreateDialog();
    const dlg = doc.body.find((e) => e.className.includes("atlas-create"));
    assert.ok(dlg, "the dialog is up");
    const chips = dlg.find((e) => e.className === "atlas-pics").children;
    assert.equal(chips.length, 1, "the History's picture is there, the film is not");
    const aspect = dlg.find((e) => e.className.includes("atlas-aspect"));
    assert.ok(aspect.disabled, "no aspect ratio to pick when pictures place the world");
    const name = dlg.find((e) => e.className.includes("atlas-name"));
    assert.equal(name.value, "room");
    const prompt = dlg.find((e) => e.tagName === "textarea");
    prompt.value = "a cosy living room";
    prompt.oninput();
    assert.equal(name.value, "cosy_living_room", "the name follows the words until typed in");
    const go = dlg.find((e) => e.className.includes("rd-go"));
    assert.equal(go.disabled, false);
    const done = go.onclick();
    await flush();
    assert.ok(ctx._atlasCreateBusy && go.disabled);
    await done;
    const post = apiStub.calls.find((c) => c[0] === "/imageviewer/atlas_create" && c[2] === "POST");
    assert.deepEqual(post[1].images, [{ filename: "room.png", type: "output", subfolder: "" }]);
    assert.equal(post[1].prompt, "a cosy living room");
    assert.equal(post[1].name, "cosy_living_room");
    assert.equal(post[1].mesh_detail, 4);
    assert.equal(doc.body.find((e) => e.className.includes("atlas-create")), null, "closed when done");
    assert.ok(appStub.toasts.some((t) => /Atlas world ready/.test(t.summary)));
    assert.ok(!keys.has("keydown"));
});

test("an error stays in the dialog and it can be tried again", async () => {
    apiStub.script.fetch = async (p) => ({ ok: false, status: 503, json: async () => ({ error: "the agentY host is not running" }) });
    const { ctx, doc } = makeViewer();
    ctx.atlasCreateDialog({ prompt: "a beach" });
    const dlg = doc.body.find((e) => e.className.includes("atlas-create"));
    const go = dlg.find((e) => e.className.includes("rd-go"));
    await go.onclick();
    const msg = dlg.find((e) => e.className.includes("rd-message"));
    assert.match(msg.textContent, /not running/);
    assert.ok(msg.className.includes("error"));
    assert.equal(ctx._atlasCreateBusy, false);
    assert.equal(go.disabled, false);
    assert.ok(doc.body.find((e) => e.className.includes("atlas-create")), "still up");
});

// ── Chisel this view (imageViewer_atlasChisel.js): the pure helpers ──
test("a chisel picture made here carries the 16:9 camera of exactly that picture", () => {
    const cam = { camera_world: Array(16).fill(0), model_world: Array(16).fill(1), fov: 40, aspect: 0.8, gated: false, label: "" };
    const c = A.chiselCamera(cam);
    assert.equal(c.aspect, A.ATLAS_ASPECT);
    assert.equal(c.gated, true);
    assert.equal(c.fov, 40);
    assert.equal("label" in c, false);
});

test("the chisel request: modes, refs only, and what it refuses", () => {
    const item = { src: { path: "D:/o/court/world.glb" } };
    const camera = { camera_world: Array(16).fill(0), fov: 50, aspect: 16 / 9, gated: true, label: "shot" };
    assert.equal(A.chiselMode({}), "paint");
    assert.equal(A.chiselMode({ image: {} }), "restyle");
    assert.equal(A.chiselMode({ image: {}, mask: {} }), "edit");
    const b = A.buildChiselRequest({ item, camera, prompt: " a fountain ",
        image: { path: "D:/in/edits/v.png", url: "blob:x", _obj: {} }, mask: { path: "D:/in/edits/m.png" },
        style: { filename: "s.png", type: "input" }, context: false, seed: "12", enhance: false });
    assert.deepEqual(b, { world_path: "D:/o/court/world.glb", camera: { camera_world: Array(16).fill(0), fov: 50, aspect: 16 / 9, gated: true },
        prompt: "a fountain", context: false, enhance_prompt: false, seed: 12,
        image: { path: "D:/in/edits/v.png" }, mask: { path: "D:/in/edits/m.png" },
        style: { filename: "s.png", type: "input", subfolder: "" } });
    assert.equal(A.buildChiselRequest({ item, camera, prompt: "x" }).seed, -1);
    assert.ok(A.buildChiselRequest({ item, camera, prompt: "" }).error);
    assert.ok(A.buildChiselRequest({ item, camera, prompt: "x", mask: { path: "m.png" } }).error);
    assert.ok(A.buildChiselRequest({ item, camera, prompt: "x", seed: "1.5" }).error);
    assert.ok(A.buildChiselRequest({ item: null, camera, prompt: "x" }).error);
});
