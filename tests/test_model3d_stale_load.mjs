// node --test tests/test_model3d_stale_load.mjs
// A model whose file changes while the first file is still loading: only the newest load may land.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const jsDir = path.join(here, "..", "js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model3d-stale-"));
fs.mkdirSync(path.join(tmp, "ext", "js"), { recursive: true });
fs.mkdirSync(path.join(tmp, "scripts"));
for (const f of fs.readdirSync(jsDir)) if (f.endsWith(".js")) fs.copyFileSync(path.join(jsDir, f), path.join(tmp, "ext", "js", f));
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
fs.writeFileSync(path.join(tmp, "scripts", "api.js"), "export const api={apiURL:(p)=>p,fileURL:(p)=>p,addEventListener(){},removeEventListener(){}};export const script={};");
fs.writeFileSync(path.join(tmp, "scripts", "app.js"), "export const app={registerExtension(){}};");
let M;
try { M = await import(url.pathToFileURL(path.join(tmp, "ext", "js", "bEpicViewer_model3d.js")).href); }
catch (e) { M = null; console.warn("model3d import failed:", e.message); }

function fakeView(loads) {
    const bodyKids = [];
    const view = {
        _entries: new Map(), sceneFrame: 0, hooks: { srcUrl: (s) => s.path },
        libs: { THREE: { AnimationMixer: class {} } },
        _originals: new Map(), scene3d: { fps: 24 },
        _srcKey: M.Model3DView.prototype._srcKey,
        _srcUrlFor: M.Model3DView.prototype._srcUrlFor,
        _isCache: () => false,
        _bodyOf: () => ({ add: (o) => bodyKids.push(o) }),
        _statsOf: () => ({}), _disposeObject: (o) => { o.disposed = true; },
        setMaterialMode() {}, materialMode: "x",
        _load: (src, u) => loads[u](),
    };
    view.bodyKids = bodyKids;
    return view;
}
const obj = (name) => ({ name, traverse() {} });

test("an older, slower load never lands on top of the newer one", { skip: !M }, async () => {
    let releaseOld;
    const oldObj = obj("old"), newObj = obj("new");
    const view = fakeView({
        "old.ply": () => new Promise((r) => { releaseOld = () => r({ object: oldObj }); }),
        "new.ply": async () => ({ object: newObj }),
    });
    const entry = { item: null, key: "" };
    view._entries.set("scene", entry);
    const itemOld = { id: "scene", kind: "model", name: "old", src: { path: "old.ply" } };
    const itemNew = { id: "scene", kind: "model", name: "new", src: { path: "new.ply" } };
    const first = M.Model3DView.prototype._loadEntry.call(view, entry, itemOld);
    await M.Model3DView.prototype._loadEntry.call(view, entry, itemNew);
    releaseOld();
    await first;
    assert.equal(entry.object, newObj);
    assert.equal(entry.key, "new.ply");
    assert.deepEqual(view.bodyKids, [newObj]);
    assert.equal(oldObj.disposed, true);
    assert.equal(entry.error, null);
});

test("a superseded load's failure is not the entry's error", { skip: !M }, async () => {
    let failOld;
    const newObj = obj("new");
    const view = fakeView({
        "old.ply": () => new Promise((_, rej) => { failOld = () => rej(new Error("boom")); }),
        "new.ply": async () => ({ object: newObj }),
    });
    const entry = { item: null, key: "" };
    view._entries.set("scene", entry);
    const first = M.Model3DView.prototype._loadEntry.call(view, entry, { id: "scene", kind: "model", name: "o", src: { path: "old.ply" } });
    await M.Model3DView.prototype._loadEntry.call(view, entry, { id: "scene", kind: "model", name: "n", src: { path: "new.ply" } });
    failOld(); await first;
    assert.equal(entry.error, null);
    assert.equal(entry.object, newObj);
});

test("a failed load of the current file is the entry's error and leaves no model", { skip: !M }, async () => {
    const view = fakeView({ "bad.ply": async () => { throw new Error("too big"); } });
    const entry = { item: null, key: "" };
    view._entries.set("scene", entry);
    await M.Model3DView.prototype._loadEntry.call(view, entry, { id: "scene", kind: "model", name: "b", src: { path: "bad.ply" } });
    assert.equal(entry.error, "too big");
    assert.ok(!entry.object);
});
