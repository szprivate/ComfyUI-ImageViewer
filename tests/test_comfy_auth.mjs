// The sign-in a workflow queued by the viewer carries (imageViewer_comfyAuth.js): found in the frontend's
// Pinia stores on #vue-app, put on `api` only around the queue call, as ComfyUI's own Run does.
import test from "node:test";
import assert from "node:assert/strict";
import { comfyAuth, queueWithAuth } from "../js/imageViewer_comfyAuth.js";

function page(storesList, stored) {
    const pinia = { _s: new Map(storesList.map((s, i) => [String(i), s])) };
    globalThis.document = { getElementById: (id) => (id === "vue-app" ? { __vue_app__: { config: { globalProperties: { $pinia: pinia } } } } : null) };
    globalThis.localStorage = { getItem: (k) => (k === "comfy_api_key" ? stored ?? null : null) };
}

test("the workspace token and the API key from the stores", async () => {
    page([{ getWorkspaceAuthToken: async () => "ws-token", getIdToken: async () => "id-token" }, { getApiKey: () => "key-1" }]);
    assert.deepEqual(await comfyAuth(), { token: "ws-token", apiKey: "key-1" });
});

test("an older frontend: the ID token, and the key from localStorage when its store is not made", async () => {
    page([{ getIdToken: async () => "id-token" }], "key-2");
    assert.deepEqual(await comfyAuth(), { token: "id-token", apiKey: "key-2" });
});

test("not signed in: nothing, and no error", async () => {
    page([{ getWorkspaceAuthToken: async () => null, getIdToken: async () => { throw new Error("no user"); } }]);
    assert.deepEqual(await comfyAuth(), { token: undefined, apiKey: undefined });
    delete globalThis.document;
    assert.deepEqual(await comfyAuth(), { token: undefined, apiKey: undefined });
});

test("on api only while it queues, and gone afterwards (also when it throws)", async () => {
    page([{ getIdToken: async () => "tok" }, { getApiKey: () => "key" }]);
    const seen = [];
    const api = { queuePrompt: async (n, p) => { seen.push([api.authToken, api.apiKey, p.output.x]); return { prompt_id: "p1" }; } };
    assert.deepEqual(await queueWithAuth(api, 0, { output: { x: 1 } }), { prompt_id: "p1" });
    assert.deepEqual(seen, [["tok", "key", 1]]);
    assert.ok(!("authToken" in api) && !("apiKey" in api));
    api.queuePrompt = async () => { throw new Error("refused"); };
    await assert.rejects(queueWithAuth(api, 0, { output: {} }), /refused/);
    assert.ok(!("authToken" in api) && !("apiKey" in api));
});
