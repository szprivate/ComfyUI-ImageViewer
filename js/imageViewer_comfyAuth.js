/**
 * The sign-in a workflow queued by the viewer itself carries, so that API ("partner") nodes run.
 *
 * ComfyUI's own Run (`app.queuePrompt`) puts the user's Comfy account token and API key on `api` just
 * around its `api.queuePrompt` call (`api.authToken` / `api.apiKey`, sent as `extra_data.auth_token_comfy_org`
 * / `api_key_comfy_org`) and takes them away after. A graph queued straight through `api.queuePrompt` -
 * Paint's Generate, a node sent on its own - carried neither, and every API node failed as not signed in.
 * `app.queuePrompt` itself cannot be borrowed: it queues the canvas, and runs every widget's
 * "control after generate" on it.
 *
 * The frontend keeps both in its Pinia stores, which an extension has no import for; they are found on the
 * Vue app mounted on `#vue-app` (`__vue_app__`), by what they can do rather than by id (the auth store was
 * `firebaseAuth`, is `auth` now). The API key is also in localStorage (`comfy_api_key`), which is read when
 * its store has not been made. Nothing is kept: both are asked for at every queue, as the frontend does.
 */

const API_KEY_STORAGE = "comfy_api_key";

function stores(doc) {
    try {
        const host = (doc || document).getElementById("vue-app");
        const pinia = host && host.__vue_app__ && host.__vue_app__.config.globalProperties.$pinia;
        return pinia && pinia._s ? [...pinia._s.values()] : [];
    } catch (_) { return []; }
}

/** { token, apiKey } as ComfyUI's Run would send them now (either may be undefined). */
export async function comfyAuth(doc) {
    const all = stores(doc);
    let token, apiKey;
    // The account's token: the workspace one where the frontend has workspaces, else the plain ID token.
    const auth = all.find((s) => typeof s.getWorkspaceAuthToken === "function")
        || all.find((s) => typeof s.getIdToken === "function" && typeof s.getApiKey !== "function");
    if (auth) {
        try {
            token = typeof auth.getWorkspaceAuthToken === "function" ? await auth.getWorkspaceAuthToken() : undefined;
            if (!token && typeof auth.getIdToken === "function") token = await auth.getIdToken();
        } catch (_) { token = undefined; }
    }
    const keys = all.find((s) => typeof s.getApiKey === "function");
    try { apiKey = keys ? keys.getApiKey() : undefined; } catch (_) { apiKey = undefined; }
    if (!apiKey) {
        try { apiKey = localStorage.getItem(API_KEY_STORAGE) || undefined; } catch (_) { apiKey = undefined; }
    }
    return { token: token || undefined, apiKey: apiKey || undefined };
}

/** `api.queuePrompt(number, prompt)` with the sign-in on it, as ComfyUI's own Run sends it. */
export async function queueWithAuth(api, number, prompt) {
    const { token, apiKey } = await comfyAuth();
    const had = { t: api.authToken, k: api.apiKey };
    api.authToken = token;
    api.apiKey = apiKey;
    try {
        return await api.queuePrompt(number, prompt);
    } finally {
        // As the frontend leaves it: nothing on `api` between two runs.
        if (had.t === undefined) delete api.authToken; else api.authToken = had.t;
        if (had.k === undefined) delete api.apiKey; else api.apiKey = had.k;
    }
}
