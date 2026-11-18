// imageViewer_matchmoveData.js
// The 3D space's matchmove, as data: the steps of the guide, a matchmove's state and its edits (tracks, keys,
// masks), the camera's numbers (focal length in mm and pixels, the field of view), and turning the solve's
// cameras and points (a camera looking down +Z, y down - the server's) into the 3D space's items (Y up, a camera
// looking down -Z), with the orientation tools (ground, origin, axis, scale) and planes fitted to points.
//
// Pure: no DOM, no three.js, so it runs under node (tests/test_matchmove_data.mjs). The panels are
// imageViewer_previzMatchmove.js; the maths of tracking and solving is the server's (src/matchmove*.py).
// Written from scratch, clean-room.

export const MM_VERSION = 1;

// The guide's steps, in order. `tips` are what to watch out for; the panel shows them under the step.
export const MM_STEPS = [
    { id: "plate", label: "Plate", title: "1 · The plate",
      help: "Pick the shot to track. Its camera facts (focal length, sensor) are read from the file where it keeps them; check them, they make the solve faster and surer.",
      tips: ["Track the original plate, not a graded or reformatted copy: the lens and the frame size must be the camera's.",
             "A focal length you know beats one the solve finds; a wrong one is worse than none (leave it unknown).",
             "The sensor size is the part of the sensor that was recorded (the camera's format), not the whole chip."] },
    { id: "lens", label: "Lens", title: "2 · The lens",
      help: "Take the lens distortion out first, or straight lines will not stay straight. Best: a lens grid shot with the same lens and focus. Without one: draw lines along things that are straight in the world.",
      tips: ["The grid chart must fill the frame: the distortion is strongest in the corners.",
             "A zoom or a focus pull changes the distortion; shoot the grid at the setting the shot used.",
             "Already undistorted plates (or CG) need none: pick No distortion.",
             "The numbers are the Comp LensDistortion node's: Open in Comp undistorts or redistorts with exactly them."] },
    { id: "masks", label: "Masks", title: "3 · Masks",
      help: "Mask out what does not belong to the background: people, cars, water, sky, reflections, screens. Masks for a moving object can instead give its features to that object.",
      tips: ["Anything that moves on its own misleads the camera solve.",
             "Reflections and highlights slide over surfaces: mask them.",
             "Key a mask on a few frames; it moves straight in between."] },
    { id: "track", label: "Track", title: "4 · Tracking",
      help: "Find features and follow them through the shot. Then look at the result: every frame needs at least 8 good tracks, spread over the picture and in depth.",
      tips: ["Long tracks are worth more than many short ones.",
             "Tracks near and far, left and right, top and bottom: a solve needs depth to see the camera move.",
             "Delete tracks that slide (on edges, crossings of things at different depths, reflections).",
             "Motion blur and low light shorten tracks: lower the quality threshold a little, or add manual tracks."] },
    { id: "solve", label: "Solve", title: "5 · Solve the camera",
      help: "Find the camera of every frame and a 3D point for every track. Below 0.5 pixels of error is very good, below 1 is usable.",
      tips: ["A camera that only pans and tilts (a tripod) has no depth: the solve finds that itself, or pick Tripod.",
             "A high error: delete the worst tracks (listed by error) and solve again.",
             "Jumps in the per-frame error show frames with too few tracks: add tracks there."] },
    { id: "objects", label: "Objects", title: "6 · Objects (optional)",
      help: "Something that moves in the shot - a car, a head, a prop - gets its own motion from its own tracks, through the solved camera.",
      tips: ["An object needs 6 or more tracks that stay on it, and it has to turn or move in depth.",
             "Give the object a mask, track inside it, then solve it.",
             "Its size is a guess from the scene's points around it: set its scale if you know it."] },
    { id: "scene", label: "Scene", title: "7 · Into the scene",
      help: "Put the camera, the undistorted plate on it and the tracked points into the 3D space. Then set the ground, the origin and the scale from points, and add geometry to check the track.",
      tips: ["Set the ground from three or more points on the floor; the origin from one; the scale from two whose distance you know.",
             "Look through the camera and play: geometry placed on tracked points must stick to the plate.",
             "Save the scene: it is USD, with the camera keyed on every frame."] },
];

export const STEP_IDS = MM_STEPS.map((s) => s.id);

const num = (v, d, lo = -Infinity, hi = Infinity) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// ── the state ────────────────────────────────────────────────────────────────

export function newMatchmove(plate = null) {
    return {
        v: MM_VERSION,
        step: "plate",
        plate: plate ? cleanPlate(plate) : null,
        camera: { focalMm: null, sensor: [36, 24], focalKnown: false, model: "", lens: "" },
        lens: { k1: 0, k2: 0, center: null, source: "none", error: null, coverage: null, lines: [], notes: [] },
        masks: [],
        tracks: [],
        objects: [],
        settings: { n: 200, minDist: 0, minNcc: 0.75, from: 0, to: null, mode: "auto", refine: "auto" },
        solve: null,
        objectSolves: {},
        orient: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 },
        scene: {},
        nextId: 1,
    };
}

export function cleanPlate(p) {
    if (!p || typeof p !== "object" || !p.path) return null;
    return {
        path: String(p.path), name: String(p.name || String(p.path).split(/[\\/]/).pop()),
        frames: Math.max(1, Math.round(num(p.frames, 1))), width: Math.round(num(p.width, 0)),
        height: Math.round(num(p.height, 0)), fps: num(p.fps, 24, 1, 1000), first: Math.round(num(p.first, 0)),
        start: Math.round(num(p.start, 0)), kind: String(p.kind || ""),
    };
}

function cleanKeys(keys) {
    const out = [];
    for (const k of Array.isArray(keys) ? keys : []) {
        if (!Array.isArray(k) || k.length < 3) continue;
        const f = Math.round(Number(k[0])), x = Number(k[1]), y = Number(k[2]);
        if (!Number.isFinite(f) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        out.push([f, x, y, num(k[3], 1, 0, 1)]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.filter((k, i) => i === out.length - 1 || out[i + 1][0] !== k[0]);
}

export function cleanTrack(t) {
    if (!t || typeof t !== "object") return null;
    const keys = cleanKeys(t.keys);
    if (!keys.length) return null;
    return { id: String(t.id || ""), name: String(t.name || t.id || ""), group: String(t.group || "camera"),
             on: t.on !== false, keys, ...(t.manual ? { manual: true } : {}) };
}

export function cleanMask(m) {
    if (!m || typeof m !== "object") return null;
    const keys = [];
    for (const k of Array.isArray(m.keys) ? m.keys : []) {
        const pts = (Array.isArray(k && k.pts) ? k.pts : []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
            .map((p) => [Number(p[0]), Number(p[1])]);
        if (pts.length >= 3 && Number.isFinite(Number(k.f))) keys.push({ f: Math.round(Number(k.f)), pts });
    }
    keys.sort((a, b) => a.f - b.f);
    if (!keys.length) return null;
    const mode = m.mode === "object" ? "object" : "exclude";
    return { id: String(m.id || ""), name: String(m.name || "Mask"), mode, object: mode === "object" ? String(m.object || "") : "",
             on: m.on !== false, keys };
}

/** A matchmove as read from its file, every field there and sane. */
export function cleanMatchmove(raw) {
    const mm = newMatchmove();
    if (!raw || typeof raw !== "object") return mm;
    mm.step = STEP_IDS.includes(raw.step) ? raw.step : "plate";
    mm.plate = cleanPlate(raw.plate);
    const c = raw.camera || {};
    mm.camera = { focalMm: Number.isFinite(Number(c.focalMm)) && Number(c.focalMm) > 0 ? Number(c.focalMm) : null,
                  sensor: Array.isArray(c.sensor) && c.sensor.length === 2 ? [num(c.sensor[0], 36, 1, 100), num(c.sensor[1], 24, 1, 100)] : [36, 24],
                  focalKnown: !!c.focalKnown, model: String(c.model || ""), lens: String(c.lens || "") };
    const l = raw.lens || {};
    mm.lens = { k1: num(l.k1, 0, -5, 5), k2: num(l.k2, 0, -5, 5),
                center: Array.isArray(l.center) && l.center.length === 2 ? [num(l.center[0], 0), num(l.center[1], 0)] : null,
                source: ["none", "grid", "lines", "comp", "typed"].includes(l.source) ? l.source : "none",
                error: Number.isFinite(Number(l.error)) && l.error !== null ? Number(l.error) : null,
                coverage: Number.isFinite(Number(l.coverage)) && l.coverage !== null ? Number(l.coverage) : null,
                lines: Array.isArray(l.lines) ? l.lines.filter((x) => Array.isArray(x) && x.length >= 2) : [],
                notes: Array.isArray(l.notes) ? l.notes.map(String) : [] };
    if (l.grid) mm.lens.grid = l.grid;
    mm.masks = (raw.masks || []).map(cleanMask).filter(Boolean);
    mm.tracks = (raw.tracks || []).map(cleanTrack).filter(Boolean);
    mm.objects = (raw.objects || []).filter((o) => o && o.id).map((o) => ({ id: String(o.id), name: String(o.name || o.id) }));
    const s = raw.settings || {};
    mm.settings = { n: Math.round(num(s.n, 200, 8, 1000)), minDist: Math.round(num(s.minDist, 0, 0, 500)),
                    minNcc: num(s.minNcc, 0.75, 0.3, 0.99), from: Math.round(num(s.from, 0, 0)),
                    to: s.to === null || s.to === undefined ? null : Math.round(num(s.to, 0, 0)),
                    mode: ["auto", "free", "tripod"].includes(s.mode) ? s.mode : "auto",
                    refine: ["auto", "on", "off"].includes(s.refine) ? s.refine : "auto" };
    mm.solve = raw.solve && raw.solve.frames ? raw.solve : null;
    mm.objectSolves = raw.objectSolves && typeof raw.objectSolves === "object" ? raw.objectSolves : {};
    const o = raw.orient || {};
    mm.orient = { R: Array.isArray(o.R) && o.R.length === 9 ? o.R.map((v) => num(v, 0)) : [1, 0, 0, 0, 1, 0, 0, 0, 1],
                  t: Array.isArray(o.t) && o.t.length === 3 ? o.t.map((v) => num(v, 0)) : [0, 0, 0], s: num(o.s, 1, 1e-9) };
    mm.scene = raw.scene && typeof raw.scene === "object" ? { ...raw.scene } : {};
    mm.nextId = Math.max(1, Math.round(num(raw.nextId, 1)), ...mm.tracks.map((t) => (Number(String(t.id).replace(/\D/g, "")) || 0) + 1));
    if (raw.file) mm.file = String(raw.file);
    return mm;
}

export function newId(mm, prefix) {
    const id = `${prefix}${mm.nextId}`;
    mm.nextId += 1;
    return id;
}

// ── the camera ───────────────────────────────────────────────────────────────

/** The focal length in pixels of the plate, from millimetres and the sensor's width; null when not known. */
export function focalPx(mm) {
    const c = mm && mm.camera, p = mm && mm.plate;
    if (!c || !p || !c.focalMm || !p.width || !c.sensor) return null;
    return c.focalMm * p.width / c.sensor[0];
}

export function focalMmOf(fpx, mm) {
    const p = mm && mm.plate;
    if (!fpx || !p || !p.width) return null;
    return fpx * mm.camera.sensor[0] / p.width;
}

/** The vertical field of view (degrees) of a focal length in pixels on a picture h pixels tall. */
export function fovV(fpx, h) {
    return 2 * Math.atan(h / 2 / fpx) * 180 / Math.PI;
}

// ── tracks ───────────────────────────────────────────────────────────────────

export function keyAt(track, f) {
    if (!track) return null;
    const k = track.keys;
    let lo = 0, hi = k.length - 1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (k[m][0] === f) return k[m];
        if (k[m][0] < f) lo = m + 1; else hi = m - 1;
    }
    return null;
}

export function setKey(track, f, x, y, score = 1) {
    const k = [Math.round(f), x, y, score];
    const at = track.keys.findIndex((q) => q[0] >= k[0]);
    if (at < 0) track.keys.push(k);
    else if (track.keys[at][0] === k[0]) track.keys[at] = k;
    else track.keys.splice(at, 0, k);
    return track;
}

export function deleteKey(track, f) {
    track.keys = track.keys.filter((k) => k[0] !== f);
    return track;
}

/** Cut a track before ("before": keeps f and after) or after ("after": keeps f and before) frame f. */
export function trimTrack(track, f, side) {
    track.keys = track.keys.filter((k) => (side === "before" ? k[0] >= f : k[0] <= f));
    return track;
}

export function trackSpan(track) {
    return track.keys.length ? [track.keys[0][0], track.keys[track.keys.length - 1][0]] : null;
}

/** Per frame (0 .. frames-1): how many live camera tracks have a key there. */
export function frameCounts(mm, group = "camera") {
    const n = (mm.plate && mm.plate.frames) || 0;
    const out = new Array(n).fill(0);
    for (const t of mm.tracks) {
        if (!t.on || t.group !== group) continue;
        for (const k of t.keys) if (k[0] >= 0 && k[0] < n) out[k[0]] += 1;
    }
    return out;
}

/** The frames with fewer than `least` tracks, as runs [[a, b], ...]. */
export function thinRuns(counts, least = 8) {
    const runs = [];
    let a = -1;
    counts.forEach((c, f) => {
        if (c < least) { if (a < 0) a = f; }
        else if (a >= 0) { runs.push([a, f - 1]); a = -1; }
    });
    if (a >= 0) runs.push([a, counts.length - 1]);
    return runs;
}

export function trackStats(mm) {
    const cam = mm.tracks.filter((t) => t.group === "camera");
    const lens = cam.map((t) => t.keys.length).sort((a, b) => a - b);
    const counts = frameCounts(mm);
    return {
        tracks: mm.tracks.length, camera: cam.length, on: cam.filter((t) => t.on).length,
        medianLength: lens.length ? lens[lens.length >> 1] : 0,
        thin: thinRuns(counts), counts,
        leastPerFrame: counts.length ? Math.min(...counts) : 0,
    };
}

/** The ids of tracks shorter than `frames` keys. */
export function shortTracks(mm, frames) {
    return mm.tracks.filter((t) => t.keys.length < frames).map((t) => t.id);
}

/** The worst tracks of a solve, by their error, at least `share` of them (0..1) or those above `px`. */
export function worstTracks(solve, { share = 0, px = Infinity } = {}) {
    if (!solve || !Array.isArray(solve.points)) return [];
    const pts = solve.points.slice().sort((a, b) => b.error - a.error);
    const n = Math.ceil(pts.length * share);
    return pts.filter((p, i) => i < n || p.error > px).map((p) => p.id);
}

export function removeTracks(mm, ids) {
    const gone = new Set(ids);
    mm.tracks = mm.tracks.filter((t) => !gone.has(t.id));
    return mm;
}

/** Tracks from the server added in, with ids that do not clash (the server numbers from start_id). */
export function addTracks(mm, tracks) {
    for (const t of tracks) {
        const c = cleanTrack(t);
        if (!c) continue;
        if (mm.tracks.some((q) => q.id === c.id)) c.id = newId(mm, "t");
        mm.tracks.push(c);
    }
    mm.nextId = Math.max(mm.nextId, ...mm.tracks.map((t) => (Number(String(t.id).replace(/\D/g, "")) || 0) + 1));
    return mm;
}

/** The track nearest (x, y) at frame f within `radius` (plate pixels), or null. */
export function trackNear(mm, f, x, y, radius) {
    let best = null, bd = radius * radius;
    for (const t of mm.tracks) {
        const k = keyAt(t, f);
        if (!k) continue;
        const d = (k[1] - x) ** 2 + (k[2] - y) ** 2;
        if (d <= bd) { bd = d; best = t; }
    }
    return best;
}

export function tracksInRect(mm, f, x0, y0, x1, y1) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    return mm.tracks.filter((t) => { const k = keyAt(t, f); return k && k[1] >= ax && k[1] <= bx && k[2] >= ay && k[2] <= by; })
        .map((t) => t.id);
}

// ── masks ────────────────────────────────────────────────────────────────────

/** A mask's polygon at frame f: held outside its keys, straight in between (the server's mask_at). */
export function maskAt(mask, f) {
    const ks = mask.keys;
    if (!ks.length) return [];
    if (f <= ks[0].f) return ks[0].pts;
    if (f >= ks[ks.length - 1].f) return ks[ks.length - 1].pts;
    for (let i = 0; i + 1 < ks.length; i++) {
        const a = ks[i], b = ks[i + 1];
        if (a.f <= f && f <= b.f) {
            if (a.pts.length !== b.pts.length) return a.pts;
            const t = (f - a.f) / Math.max(1, b.f - a.f);
            return a.pts.map((p, j) => [p[0] + (b.pts[j][0] - p[0]) * t, p[1] + (b.pts[j][1] - p[1]) * t]);
        }
    }
    return ks[ks.length - 1].pts;
}

/** Put the mask's shape at frame f as a key (a vertex dragged at f keys it there). */
export function setMaskKey(mask, f, pts) {
    const key = { f: Math.round(f), pts: pts.map((p) => [p[0], p[1]]) };
    const at = mask.keys.findIndex((k) => k.f >= key.f);
    if (at < 0) mask.keys.push(key);
    else if (mask.keys[at].f === key.f) mask.keys[at] = key;
    else mask.keys.splice(at, 0, key);
    return mask;
}

export function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
}

// ── small matrix helpers (3x3 row-major arrays) ──────────────────────────────

export const mat3 = {
    mul(a, b) {
        const o = new Array(9);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
        return o;
    },
    tr(a) { return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]; },
    vec(a, v) { return [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]]; },
    flat(R) { return Array.isArray(R[0]) ? [...R[0], ...R[1], ...R[2]] : R.slice(); },
    axisAngle(axis, ang) {
        const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
        return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x,
                t * x * z - s * y, t * y * z + s * x, t * z * z + c];
    },
};

const FLIP = [1, 0, 0, 0, -1, 0, 0, 0, -1];      // the server's axes (y down, looking down +Z) <-> the 3D space's

/** Euler XYZ (degrees, three.js's order: R = Rx Ry Rz) of a rotation matrix (row-major 9). */
export function eulerXYZ(m) {
    const m13 = Math.max(-1, Math.min(1, m[2]));
    const y = Math.asin(m13);
    let x, z;
    if (Math.abs(m13) < 0.9999999) { x = Math.atan2(-m[5], m[8]); z = Math.atan2(-m[1], m[0]); }
    else { x = Math.atan2(m[7], m[4]); z = 0; }
    const d = 180 / Math.PI;
    return [x * d, y * d, z * d];
}

/** The rotation matrix of Euler XYZ degrees. */
export function matrixXYZ(e) {
    const r = Math.PI / 180;
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(e[0] * r), Math.sin(e[0] * r), Math.cos(e[1] * r), Math.sin(e[1] * r), Math.cos(e[2] * r), Math.sin(e[2] * r)];
    const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
    return mat3.mul(mat3.mul(Rx, Ry), Rz);
}

/** Each angle moved by whole turns to lie nearest the one before (no flips when keyed frame by frame). */
export function unwrapEuler(e, prev) {
    if (!prev) return e;
    return e.map((a, i) => a + 360 * Math.round((prev[i] - a) / 360));
}

/** A solved camera (x_cam = R X + t, the server's axes) as the 3D space's position and rotation. */
export function cameraToItem(R, t) {
    const Rm = mat3.flat(R);
    const Rt = mat3.tr(Rm);
    const C = mat3.vec(Rt, t).map((v) => -v);
    const pos = mat3.vec(FLIP, C);
    const rot = mat3.mul(mat3.mul(FLIP, Rt), FLIP);
    return { position: pos, rotation: eulerXYZ(rot), matrix: rot };
}

/** A solved object (X_world = R X_obj + t, the server's axes) as the 3D space's transform. */
export function objectToItem(R, t) {
    const Rm = mat3.flat(R);
    const rot = mat3.mul(mat3.mul(FLIP, Rm), FLIP);
    return { position: mat3.vec(FLIP, t), rotation: eulerXYZ(rot), matrix: rot };
}

/** A solved point (server axes) in the 3D space's axes. */
export function pointToScene(X) {
    return mat3.vec(FLIP, X);
}

// ── orienting the solve: the Matchmove group's transform ─────────────────────

/** Where a point of the solve (3D-space axes, inside the group) lands in the world. */
export function orientApply(o, p) {
    const q = mat3.vec(o.R, p);
    return [q[0] * o.s + o.t[0], q[1] * o.s + o.t[1], q[2] * o.s + o.t[2]];
}

/** The group's position / rotation / scale for an orientation. */
export function orientToItem(o) {
    return { position: o.t.slice(), rotation: eulerXYZ(o.R), scale: [o.s, o.s, o.s] };
}

/** The best plane through points: {centre, normal} (normal = the smallest spread's direction). */
export function fitPlane(pts) {
    const n = pts.length;
    const c = [0, 0, 0];
    for (const p of pts) for (let i = 0; i < 3; i++) c[i] += p[i] / n;
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) {
        const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
    }
    // the smallest eigenvector: inverse iteration on C + tiny
    let v = [0.31, 0.83, 0.47];
    const A = C.map((x, i) => x + (i % 4 === 0 ? 1e-9 * (C[0] + C[4] + C[8] + 1e-12) : 0));
    for (let it = 0; it < 60; it++) {
        const w = solve3(A, v);
        if (!w) break;
        const l = Math.hypot(...w) || 1;
        v = w.map((x) => x / l);
    }
    return { centre: c, normal: v };
}

function solve3(A, b) {
    const [a, bb, c, d, e, f, g, h, i] = A;
    const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-300) return null;
    const inv = [(e * i - f * h), -(bb * i - c * h), (bb * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d),
                 (d * h - e * g), -(a * h - bb * g), (a * e - bb * d)].map((x) => x / det);
    return mat3.vec(inv, b);
}

/** The rotation turning unit vector a onto unit vector b (the shortest way). */
export function rotationBetween(a, b) {
    const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const s = Math.hypot(...v), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (s < 1e-12) {
        if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const p = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
        const l = Math.hypot(...p);
        return mat3.axisAngle(p.map((x) => x / l), Math.PI);
    }
    return mat3.axisAngle(v.map((x) => x / s), Math.atan2(s, c));
}

/**
 * The ground through `pts` (the solve's points, inside the group): turned so their plane is level, moved so it is
 * at height 0. `up` (inside the group) says which side is up - where the camera is.
 */
export function orientGround(o, pts, up) {
    if (pts.length < 3) return { error: "Pick three or more points on the ground." };
    const { centre, normal } = fitPlane(pts);
    let n = normal;
    if (up && (n[0] * (up[0] - centre[0]) + n[1] * (up[1] - centre[1]) + n[2] * (up[2] - centre[2])) < 0) n = n.map((x) => -x);
    const R = rotationBetween(n, [0, 1, 0]);
    const out = { R, s: o.s, t: [0, 0, 0] };
    const c = orientApply(out, centre);
    out.t = [-c[0], -c[1], -c[2]];
    return out;
}

/** The origin at point p: everything moved so p is at (0, 0, 0), keeping the turn and the scale. */
export function orientOrigin(o, p) {
    const w = orientApply(o, p);
    return { R: o.R.slice(), s: o.s, t: [o.t[0] - w[0], o.t[1] - w[1], o.t[2] - w[2]] };
}

/** Turn about the up axis so the line from a to b (seen from above) runs along +X (axis "x") or +Z. */
export function orientAxis(o, a, b, axis = "x") {
    const A = orientApply(o, a), B = orientApply(o, b);
    const dx = B[0] - A[0], dz = B[2] - A[2];
    if (Math.hypot(dx, dz) < 1e-12) return { error: "The two points are above each other: pick two apart." };
    const cur = Math.atan2(-dz, dx);                      // the angle about +Y from +X
    const want = axis === "z" ? -Math.PI / 2 : 0;
    const Ry = mat3.axisAngle([0, 1, 0], want - cur);
    // about the world origin: rotation and position both turn
    return { R: mat3.mul(Ry, o.R), s: o.s, t: mat3.vec(Ry, o.t) };
}

/** Scale so a and b are `dist` apart, about the world origin. */
export function orientScale(o, a, b, dist) {
    const A = orientApply(o, a), B = orientApply(o, b);
    const now = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    if (!(now > 1e-12) || !(dist > 0)) return { error: "Pick two points apart and give their distance." };
    const k = dist / now;
    return { R: o.R.slice(), s: o.s * k, t: o.t.map((v) => v * k) };
}

/**
 * A primitive's transform on points (inside the group): a "plane" lies in their best plane, centred, sized to
 * them; a "box" sits on them; a "locator" at their middle. Returns {position, rotation, scale} inside the group.
 */
export function geometryOnPoints(kind, pts) {
    if (!pts.length) return null;
    const n = pts.length;
    const c = [0, 0, 0];
    for (const p of pts) for (let i = 0; i < 3; i++) c[i] += p[i] / n;
    if (kind === "locator" || n < 3) return { position: c, rotation: [0, 0, 0], scale: [1, 1, 1] };
    const { normal } = fitPlane(pts);
    const R = rotationBetween([0, 1, 0], normal);
    // its size: the points' spread in the plane
    const Rt = mat3.tr(R);
    let sx = 0, sz = 0;
    for (const p of pts) {
        const q = mat3.vec(Rt, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
        sx = Math.max(sx, Math.abs(q[0]));
        sz = Math.max(sz, Math.abs(q[2]));
    }
    const size = Math.max(sx, sz, 1e-3) * 2.2;
    if (kind === "plane") return { position: c, rotation: eulerXYZ(R), scale: [size / 1, 1, size / 1] };
    return { position: c, rotation: eulerXYZ(R), scale: [size / 2, size / 2, size / 2] };
}
