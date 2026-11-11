// imageViewer_atlasRender.js
// "Render with Atlas": the parts of the button that need neither the DOM nor ComfyUI, so they can be
// run on their own (tests/test_atlas_render.mjs). The dialog and the wiring are in
// imageViewer_previzAtlas.js; the server side is atlas_render.py (a relay to the agentY host, which
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

// ── Flying through the world (imageViewer_world3d.js flyEnter) ───────────────────────────────────────────
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

export const flyStatus = (speed) => "Flying — hold the left mouse button to look · W A S D move · E/Q up/down · Shift fast · wheel speed "
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
        over_cap: "The plan is above the price cap; pick a lower quality or a shorter move.",
        confirm_cost: "The price was not confirmed.",
    };
    const kind = err && err.kind;
    return hints[kind] && !msg.includes(hints[kind]) ? `${hints[kind]} (${msg})` : msg;
}

/** "1:05" for the progress line. */
export function clock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── "Render camera with Atlas": the previz camera's animation as a move painted by Atlas ─────────────────────
// The camera is sampled from the timeline frame by frame (so the server renders exactly the path shown), sent
// with a dry run first (the plan and the price), and followed as a job (tasks done / total).

export const MOVE_QUALITIES = [
    ["draft", "Draft — a painted view every 1 s (fewest tasks)"],
    ["standard", "Standard — a painted view every 0.5 s"],
    ["high", "High — a painted view every 0.25 s (most faithful)"],
];
export const MOVE_MAX_KEYS = 800;

/**
 * The animated camera of a previz scene and its range: {camera, start, end, fps, seconds, frames} or {error}.
 * `S` is imageViewer_scene3d (itemById, keyframeFrames, isAnimated) - passed in so this stays DOM- and three-free.
 */
export function describeMove(scene, S) {
    if (!scene || !Array.isArray(scene.items)) return { error: "no scene" };
    const cams = scene.items.filter((i) => i && i.kind === "camera");
    const active = scene.activeCamera ? S.itemById(scene, scene.activeCamera) : null;
    const animated = (c) => c && (S.isAnimated(c, "position") || S.isAnimated(c, "rotation"));
    const camera = animated(active) ? active : cams.find(animated);
    if (!camera) {
        return { error: "The scene has no camera animation: key a camera on the timeline (two keyframes at least) "
            + "and look through it." };
    }
    const frames = S.allKeyframeFrames(camera);
    const start = frames[0], end = frames[frames.length - 1];
    if (!(end > start)) return { error: "The camera needs keyframes at two different frames." };
    const fps = Number(scene.fps) || 24;
    return { camera, start, end, fps, seconds: (end - start) / fps, frames: end - start + 1 };
}

/**
 * Sample the camera at every frame of the range. `applyFrame(f)` places the scene at frame f, `cameraObject()`
 * returns the three.js camera, `fovAt(f)` its lens. The scene is put back at `restoreFrame` afterwards.
 * Returns [{t (s), camera_world (16), fov, aspect, gated}].
 */
export function sampleMove({ start, end, fps, applyFrame, cameraObject, fovAt, restoreFrame = 0, maxKeys = MOVE_MAX_KEYS }) {
    const step = Math.max(1, Math.ceil((end - start + 1) / maxKeys));
    const picks = [];
    for (let f = start; f < end; f += step) picks.push(f);
    picks.push(end);
    const out = [];
    try {
        for (const f of picks) {
            applyFrame(f);
            const cam = cameraObject();
            if (!cam) throw new Error("no camera to sample");
            cam.updateMatrixWorld(true);
            out.push({ t: (f - start) / fps, camera_world: elements(cam.matrixWorld), fov: fovAt(f),
                       aspect: ATLAS_ASPECT, gated: true });
        }
    } finally {
        applyFrame(restoreFrame);
    }
    return out;
}

export function buildMoveRequest(item, keys, modelWorld, { quality = "standard", fps = 24, name = "move", dryRun = false,
                                                           confirmCost = false } = {}) {
    return { world_path: item.src.path, keys, model_world: modelWorld, quality, fps, name,
             dry_run: !!dryRun, confirm_cost: !!confirmCost };
}

const usd = (v) => "$" + Number(v).toFixed(2);

/** One line for the dialog from a dry run's plan: what will be painted and what it may cost. */
export function describePlan(plan) {
    if (!plan || !plan.estimate) return "";
    const e = plan.estimate;
    const range = Math.abs(e.max_usd - e.min_usd) < 0.005 ? usd(e.max_usd) : `${usd(e.min_usd)}–${usd(e.max_usd)}`;
    return `${plan.frames} frames (${plan.seconds}s) · Atlas paints ${plan.keyframes} views in ${plan.tasks} task`
        + `${plan.tasks === 1 ? "" : "s"} · about ${range} of World Labs credits`;
}

/** The progress line while a move runs. */
export function moveProgress(s) {
    const n = s.tasks_total ? ` (${s.tasks_done || 0}/${s.tasks_total} tasks)` : "";
    return `${s.phase || "Working"}${n}… ${clock(s.elapsed)}`;
}

/** What a dry run answered: {plan} or throws an Error with the reason (no host, no key, a bad path ...). */
export function planOrThrow(answer) {
    if (answer && answer.plan && answer.status === "dry_run") return answer.plan;
    const e = new Error((answer && answer.error) || "the agentY host gave no plan");
    e.kind = (answer && answer.error_kind) || "";
    throw e;
}

// ── "New Atlas world": a world from a prompt or pictures, from the 3D space ─────────────────────────────

export const CREATE_ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1"];
export const CREATE_DETAILS = [[2, "Fine (big file)"], [4, "Standard"], [8, "Light"]];
export const CREATE_MAX_IMAGES = 8;
const PICTURE_EXT = /\.(png|jpe?g|webp)$/i;

/** A world name from what the user typed: the first few words, made safe for a folder. */
export function worldNameFrom(prompt, images = []) {
    const words = String(prompt || "").toLowerCase().replace(/[^a-z0-9\s_-]+/g, " ").split(/\s+/)
        .filter((w) => w && !["a", "an", "the", "of", "with", "in", "on", "and", "at"].includes(w)).slice(0, 4);
    let name = words.join("_");
    if (!name && images.length) {
        const first = String(images[0].name || images[0].filename || images[0].path || "").split(/[\\/]/).pop();
        name = first.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    }
    return (name || "world").slice(0, 40).replace(/^_+|_+$/g, "") || "world";
}

/** Whether a picture item (a {path} or ComfyUI's {filename, type, subfolder}) is one Atlas reads. */
export function isAtlasPicture(item) {
    const n = String((item && (item.path || item.filename || item.name)) || "");
    return PICTURE_EXT.test(n);
}

/** One picture item as the route takes it (no URLs, no blobs: the server finds the file). */
export function pictureRef(item) {
    if (!item) return null;
    if (item.path) return { path: String(item.path) };
    if (item.filename) return { filename: String(item.filename), type: String(item.type || "output"), subfolder: String(item.subfolder || "") };
    return null;
}

/** The POST body for /imageviewer/atlas_create, or { error }. */
export function buildCreateRequest({ name, prompt, images = [], aspect = "16:9", detail = 4 }) {
    const refs = images.map(pictureRef).filter(Boolean);
    const p = String(prompt || "").trim();
    if (!refs.length && !p) return { error: "Describe the place, or add a picture of it." };
    if (refs.length > CREATE_MAX_IMAGES) return { error: `At most ${CREATE_MAX_IMAGES} pictures for one world.` };
    const n = String(name || "").trim() || worldNameFrom(p, images);
    return { name: n, prompt: p, images: refs, aspect_ratio: CREATE_ASPECTS.includes(aspect) ? aspect : "16:9",
             mesh_detail: [2, 4, 8].includes(Number(detail)) ? Number(detail) : 4 };
}

/** What the dialog says while a world is being made. */
export function createProgress(s) {
    return `${(s && s.phase) || "Atlas is making the world"}… ${clock((s && s.elapsed) || 0)}`;
}

// ── "Chisel this view": an Atlas Chisel picture at the camera the viewer looks through ───────────────────

export const CHISEL_W = 1280, CHISEL_H = 720;   // Atlas Chisel paints 1280 x 720 only

/** The camera of a picture rendered here at 1280 x 720: the same lens, the 16:9 frame (what the picture shows). */
export function chiselCamera(camera) {
    const { label, ...cam } = camera || {};
    return { ...cam, aspect: ATLAS_ASPECT, gated: true };
}

/** What the request will do, in the words the dialog shows: "none" when there is nothing to build on. */
export function chiselMode({ image, mask, depth } = {}) {
    if (image && mask) return "edit";
    if (image) return "restyle";
    return depth ? "paint" : "none";
}

// ── Depth from the 3D space: what Chisel builds the picture on ──

/** How many scene units one unit of the world mesh is: the length of model_world's first axis. */
export function modelScale(modelWorld) {
    if (!Array.isArray(modelWorld) || modelWorld.length !== 16) return 1;
    const s = Math.hypot(modelWorld[0], modelWorld[1], modelWorld[2]);
    return Number.isFinite(s) && s > 1e-9 ? s : 1;
}

/**
 * The view's planar depth ({w, h, data: Float32Array}, scene units, 0 = nothing) in the world mesh's units,
 * with how much of the picture it covers. Null when nothing solid is in front of the camera.
 */
export function depthInMeshUnits(depth, modelWorld) {
    if (!depth || !depth.data || !depth.w || !depth.h) return null;
    const s = modelScale(modelWorld);
    const out = new Float32Array(depth.data.length);
    let hit = 0, zmin = Infinity, zmax = 0;
    for (let i = 0; i < out.length; i++) {
        const z = depth.data[i];
        if (!(z > 0) || !Number.isFinite(z)) continue;
        const m = z / s;
        out[i] = m;
        hit++;
        if (m < zmin) zmin = m;
        if (m > zmax) zmax = m;
    }
    if (hit < 16) return null;
    return { w: depth.w, h: depth.h, data: out, coverage: hit / out.length, zmin, zmax };
}

/** A Float32Array as base64 (little-endian float32: what the viewer route decodes). */
export function floatsToBase64(data) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** The depth map as grey RGBA pixels to look at: near is light, far dark, nothing black (the PNG Atlas gets, in 8 bits). */
export function depthPreviewPixels(depth) {
    const px = new Uint8ClampedArray(depth.w * depth.h * 4);
    const lo = Math.log(Math.max(depth.zmin, 1e-6)), hi = Math.log(Math.max(depth.zmax, depth.zmin * 1.01, 1e-6));
    for (let i = 0; i < depth.data.length; i++) {
        const z = depth.data[i];
        const v = z > 0 ? Math.round(40 + 215 * (hi - Math.log(z)) / Math.max(hi - lo, 1e-9)) : 0;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
        px[i * 4 + 3] = 255;
    }
    return px;
}

/** The POST body for /imageviewer/atlas_chisel, or { error }. `image` / `mask` / `style` are picture items. */
export function buildChiselRequest({ item, camera, prompt, image = null, mask = null, style = null, context = true,
                                     seed = "", enhance = true, depth = null, voxel = 0 }) {
    const p = String(prompt || "").trim();
    if (!item || !item.src || !item.src.path) return { error: "Open an Atlas world first." };
    if (!camera || !Array.isArray(camera.camera_world)) return { error: "There is no camera to chisel from." };
    if (!p) return { error: "Say what Atlas should paint or change." };
    if (mask && !image) return { error: "A mask needs the picture it was painted on." };
    if (!image && !depth) return { error: "Chisel needs something to build on: the scene's geometry in front of the camera, or a picture." };
    const s = String(seed ?? "").trim();
    if (s && !/^\d+$/.test(s)) return { error: "The seed is a whole number (or empty for a random one)." };
    const { label, ...cam } = camera;
    const body = { world_path: item.src.path, camera: cam, prompt: p, context: context !== false,
                   enhance_prompt: enhance !== false, seed: s ? Number(s) : -1 };
    for (const [k, v] of [["image", image], ["mask", mask], ["style", style]]) {
        const ref = v ? pictureRef(v) : null;
        if (ref) body[k] = ref;
    }
    if (depth) {
        body.depth = { w: depth.w, h: depth.h, data: floatsToBase64(depth.data) };
        body.voxel_size = Math.min(0.4, Math.max(0, Number(voxel) || 0));
    }
    return body;
}

/** What the dialog says while Atlas works. */
export function chiselProgress(s) {
    return `${(s && s.phase) || "Atlas is painting"}… ${clock((s && s.elapsed) || 0)}`;
}
