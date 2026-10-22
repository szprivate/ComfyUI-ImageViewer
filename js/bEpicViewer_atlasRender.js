// bEpicViewer_atlasRender.js
// "Render with Atlas": the parts of the button that need neither the DOM nor ComfyUI, so they can be
// run on their own (tests/test_atlas_render.mjs). The dialog and the wiring are in
// bEpicViewer_previzAtlas.js; the server side is atlas_render.py (a relay to the agentY host, which
// holds the World Labs key and does the camera maths in Python - nothing here converts a pose).

export const ATLAS_ASPECT = 16 / 9;          // Atlas renders 1280 x 720

/** The scene item that holds an Atlas world's mesh: a model file called world.glb (the folder has a world.json). */
export function atlasWorldItem(scene) {
    if (!scene || !Array.isArray(scene.items)) return null;
    for (const item of scene.items) {
        const p = item && item.kind === "model" && item.src && item.src.path;
        if (typeof p === "string" && /(^|[\\/])world\.glb$/i.test(p)) return item;
    }
    return null;
}

export function atlasWorldName(path) {
    const parts = String(path || "").split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : "world";
}

// ── Flying through the world (bEpicViewer_world3d.js flyEnter) ───────────────────────────────────────────
// Atlas worlds are metric, Y up, cameras looking down -Z, and have no ground to follow: the free camera
// flies. The maths is here, DOM-free, so it can be tested.
export const FLY_SPEED = 1.5;                // metres per second
export const FLY_SPEED_MIN = 0.05, FLY_SPEED_MAX = 200;
export const FLY_FAST = 3;                   // Shift

export const clampFlySpeed = (v) => Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, Number(v) || FLY_SPEED));

/** The speed after one wheel notch (deltaY < 0 is away from the user: faster). 12% a notch of 100. */
export function flyWheel(speed, deltaY) {
    return clampFlySpeed(speed * Math.exp(-Math.max(-400, Math.min(400, Number(deltaY) || 0)) * 0.0012));
}

/**
 * How far one step moves the camera, [x, y, z] in metres. `keys` is a Set of key names: W/S along the
 * whole view direction (pitch included), A/D sideways, E/Space up and Q/C down along world Y, Shift faster.
 */
export function flyDelta({ yaw, pitch, keys, speed, dt }) {
    const has = (...names) => names.some((n) => keys.has(n));
    const f = (has("w", "ArrowUp") ? 1 : 0) - (has("s", "ArrowDown") ? 1 : 0);
    const r = (has("d", "ArrowRight") ? 1 : 0) - (has("a", "ArrowLeft") ? 1 : 0);
    const u = (has("e", " ") ? 1 : 0) - (has("q", "c") ? 1 : 0);
    const step = clampFlySpeed(speed) * (keys.has("Shift") ? FLY_FAST : 1) * dt;
    const cp = Math.cos(pitch);
    return [
        (-Math.sin(yaw) * cp * f + Math.cos(yaw) * r) * step,
        (Math.sin(pitch) * f + u) * step,
        (-Math.cos(yaw) * cp * f - Math.sin(yaw) * r) * step,
    ];
}

export const flyStatus = (speed) => "Flying — click to look · W A S D move · E/Q up/down · Shift fast · wheel speed "
    + `${Number(speed.toFixed(speed < 10 ? 2 : 1))} m/s · Esc stop`;

/** The same file under a new URL, so a rewritten one is fetched again rather than served from the cache. */
export function bustUrl(url, stamp) {
    const u = String(url || "");
    if (!u || /^(blob|data):/i.test(u)) return u;
    return u + (u.includes("?") ? "&" : "?") + "_=" + encodeURIComponent(String(stamp));
}

const elements = (m) => (m && m.elements ? Array.from(m.elements) : null);

/**
 * The camera the user is looking through, as raw numbers for the server to convert.
 *   camera_world  the camera's matrixWorld (three.js, column-major)
 *   model_world   the matrixWorld of the node the world's mesh hangs under
 *   fov, aspect   its vertical field of view and picture shape: a scene camera's own (the gate), or the free
 *                 camera's (the viewport)
 *   gated         the picture is 16:9, so it is exactly what Atlas will render
 */
export function captureCamera(view, item) {
    const cam = view.activeCameraObject();
    if (!cam) throw new Error("no camera to render from");
    cam.updateMatrixWorld(true);
    const active = view.scene3d && view.scene3d.activeCamera;
    const entry = active ? view._entries.get(active) : null;
    const through = !!(entry && entry.camera === cam && !view._walk);
    let fov = cam.fov, aspect = cam.aspect;
    if (through && entry.item) {
        const res = entry.item.resolution;
        if (Array.isArray(res) && res[0] > 0 && res[1] > 0) aspect = res[0] / res[1];
        if (entry.item.fov) fov = entry.item.fov;       // the gate's lens, not the viewport's overscanned one
    }
    const body = view._bodyOf(view._entries.get(item.id));
    if (!body) throw new Error("the Atlas world is not loaded yet");
    body.updateWorldMatrix(true, false);
    return {
        camera_world: elements(cam.matrixWorld), model_world: elements(body.matrixWorld),
        fov, aspect, gated: through && Math.abs(aspect - ATLAS_ASPECT) < 0.02,
        label: through && entry.item ? entry.item.name : "",
    };
}

export function buildRequest(item, camera, { upscale = 0, addToWorld = false } = {}) {
    const { label, ...cam } = camera;
    return { world_path: item.src.path, camera: cam, upscale: Number(upscale) || 0, add_to_world: !!addToWorld };
}

export const UPSCALE_CHOICES = [[0, "None (1280 × 720)"], [2, "2× (2560 × 1440)"], [4, "4× (5120 × 2880)"]];

/**
 * Start a render and follow it. `post(body)` and `get(id)` return the parsed JSON (or throw an Error whose
 * message is what to tell the user). `onState(state)` is called on every poll. Resolves to the final state
 * ({state: "done", path, ...}); throws on an error state or a timeout.
 */
export async function runAtlasRender({ post, get, request, onState, sleep, pollMs = 2500, timeoutMs = 20 * 60 * 1000 }) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const started = await post(request);
    if (!started || !started.id) throw new Error((started && started.error) || "the render did not start");
    let waited = 0;
    for (;;) {
        const state = await get(started.id);
        if (onState) onState(state);
        if (state.state === "done") return state;
        if (state.state === "error") throw Object.assign(new Error(state.message || "the render failed"),
                                                         { kind: state.error_kind || "", operationId: state.operation_id || "" });
        if (waited >= timeoutMs) {
            throw Object.assign(new Error("still running after " + Math.round(timeoutMs / 60000) + " minutes; it carries on "
                + "in agentY - atlas_fetch collects it" + (started.id ? "" : "")), { kind: "timeout" });
        }
        await wait(pollMs);
        waited += pollMs;
    }
}

/** What to say for a failed render: the cause, and what the user can do about it. */
export function explainError(err) {
    const msg = (err && err.message) || String(err);
    const hints = {
        balance: "The World Labs account is out of credits.",
        spend_limit: "The World Labs monthly spend limit is reached.",
        auth: "The World Labs key is missing or wrong (WORLDLABS_API_KEY in agentY's .env).",
        content_refusal: "World Labs declined this view; try another camera.",
        dependency: "The upscale needs ComfyUI and an upscale model; the 1280 × 720 view may still have been saved.",
    };
    const kind = err && err.kind;
    return hints[kind] && !msg.includes(hints[kind]) ? `${hints[kind]} (${msg})` : msg;
}

/** "1:05" for the progress line. */
export function clock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
