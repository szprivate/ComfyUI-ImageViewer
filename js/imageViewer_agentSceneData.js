// imageViewer_agentSceneData.js
// The arithmetic behind the agent's scene actions (imageViewer_previzAgentScene.js):
// which frames a clip of the Clip Sequencer covers, where a turntable camera
// stands for a range, and the short description of a 3D scene the agent reads.
// Pure - no DOM, no three.js - so it runs under plain node
// (tests/test_agent_scene_data.mjs).
//
// A turntable is one rig for the whole shot: a group (the pivot) standing on
// the subject, turned about Y, and a camera under it that stands back and up
// and looks at the subject. Each range gets its own keys on that rig - the
// pivot's place and turn, the camera's distance and height - held between
// ranges, so every clip's frames show its own full turn and nothing
// interpolates from one clip's turn into the next.
//
// Clean-room: the ideas are the common ones of a camera orbit; nothing here
// comes from any program's code.

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r4 = (x) => Math.round(x * 1e4) / 1e4 + 0;   // + 0: never -0

/**
 * The frames a clip lies over on the shot's timeline: { from, to } (both shown).
 * A clip's keys run 0..length (clipSeqData), so a take keyed on 0..48 is a
 * clip of length 48 that shows frames 0 to 48.
 */
export function clipFrames(clip) {
    const from = Math.max(0, Math.round(num(clip.start, 0)));
    const end = num(clip.start, 0) + Math.max(0, num(clip.length, 0));
    const to = Math.max(from, Math.floor(end + 1e-6));
    return { from, to };
}

/**
 * The clips `which` names, in timeline order: "all" (or empty) = every clip of
 * every unmuted track; else a list of clip ids or names (a name matches the
 * clip's own name or its source's, case ignored). Answers
 * [{ id, name, track, from, to, model }] and the names it did not find.
 */
export function pickClips(q, which = "all") {
    const out = [];
    const tracks = (q && q.tracks) || [];
    const srcName = (c) => {
        const s = ((q && q.sources) || []).find((x) => x.id === c.source);
        return s ? s.name : "";
    };
    for (const t of tracks) {
        for (const c of t.clips || []) {
            const name = c.name || srcName(c) || "clip";
            const s = ((q && q.sources) || []).find((x) => x.id === c.source);
            out.push({ id: c.id, name, source: srcName(c), track: t.name, trackMuted: !!t.mute, mute: !!c.mute,
                       model: c.target || (s && s.model) || null, ...clipFrames(c) });
        }
    }
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    const all = which === "all" || which === "" || which === null || which === undefined
        || (Array.isArray(which) && !which.length);
    if (all) return { clips: out.filter((c) => !c.mute && !c.trackMuted), missing: [] };
    const want = Array.isArray(which) ? which : [which];
    const picked = [], missing = [];
    for (const w of want) {
        const s = String(w).toLowerCase();
        const c = out.find((x) => x.id === w) || out.find((x) => x.name.toLowerCase() === s)
            || out.find((x) => x.source.toLowerCase() === s);
        if (c) { if (!picked.includes(c)) picked.push(c); } else missing.push(String(w));
    }
    picked.sort((a, b) => a.from - b.from);
    return { clips: picked, missing };
}

/** How far back a camera with vertical field of view `fov` (degrees) stands to see a sphere of `radius` whole. */
export function fitDistance(radius, fov = 35, aspect = 16 / 9, margin = 1.15) {
    const v = (Math.max(1, Math.min(170, num(fov, 35))) * Math.PI) / 180;
    const h = 2 * Math.atan(Math.tan(v / 2) * Math.max(0.1, num(aspect, 16 / 9)));
    const fit = Math.min(v, h);
    return (Math.max(1e-3, num(radius, 1)) / Math.sin(fit / 2)) * margin;
}

/**
 * One range of a turntable. `subject` = { center: [x,y,z], radius } (the
 * subject's box over the range). Options: degrees (360; positive turns the
 * camera to its left, seen from above), start_yaw (0 = in front of a
 * character facing +Z), distance (metres; 0 = fit the subject), height
 * (metres the camera stands above the look point; default a fifth of the
 * distance), look_height (metres above the box's centre the camera aims at),
 * fov, aspect. Answers the keys: { pivot: {position, rotation}, cam: {position,
 * rotation}, distance, height, center } - each a list of {f, v, ease}.
 */
export function turntableRange(subject, from, to, opts = {}) {
    const fov = num(opts.fov, 35);
    const deg = num(opts.degrees, 360);
    const yaw0 = num(opts.start_yaw, 0);
    const c = (subject && subject.center) || [0, 1, 0];
    const look = [c[0], c[1] + num(opts.look_height, 0), c[2]];
    const dist = num(opts.distance, 0) > 0 ? num(opts.distance, 0) : fitDistance(subject && subject.radius, fov, opts.aspect);
    const height = opts.height === undefined || opts.height === null ? dist * 0.2 : num(opts.height, 0);
    const n = Math.max(1, to - from + 1);
    // The last frame shown is one step short of the full turn, so a 360 loops without a repeated frame.
    const end = yaw0 + (deg * (n - 1)) / n;
    const pitch = (Math.atan2(-height, dist) * 180) / Math.PI;
    const hold = (v) => ({ f: from, v, ease: "hold" });
    return {
        pivot: {
            position: [hold(look.map(r4))],
            rotation: turnKeys(from, to, yaw0, end),
        },
        cam: { position: [hold([0, r4(height), r4(dist)])], rotation: [hold([r4(pitch), 0, 0])] },
        distance: r4(dist), height: r4(height), center: look.map(r4), from, to,
    };
}

/**
 * The pivot's turn from `a` (at frame `from`) to `b` (at `to`) at an even speed.
 * A rotation key runs to the next the short way round (scene3d's rule), so the
 * keys are never more than 90 degrees apart: on frames where the straight line
 * lies, linear between them, held at the end.
 */
export function turnKeys(from, to, a, b) {
    if (to <= from) return [{ f: from, v: [0, r4(a), 0], ease: "hold" }];
    const perFrame = (b - a) / (to - from);
    const every = Math.max(1, Math.floor(90 / Math.max(1e-9, Math.abs(perFrame))));
    const out = [];
    for (let f = from; f < to; f += every) out.push({ f, v: [0, r4(a + perFrame * (f - from)), 0], ease: "linear" });
    out.push({ f: to, v: [0, r4(b), 0], ease: "hold" });
    return out;
}

/** Put one range's keys into a list of keys (a key on the same frame is replaced). */
export function mergeKeys(list, keys) {
    const out = (Array.isArray(list) ? list : []).filter((k) => !keys.some((n) => n.f === k.f));
    out.push(...keys.map((k) => ({ ...k, v: Array.isArray(k.v) ? k.v.slice() : k.v })));
    return out.sort((a, b) => a.f - b.f);
}

/** A sphere around a list of boxes ({min, max} each), or null. */
export function sphereOf(boxes) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes || []) {
        if (!b) continue;
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.min[i]); hi[i] = Math.max(hi[i], b.max[i]); }
    }
    if (!(hi[0] >= lo[0])) return null;
    const center = lo.map((v, i) => (v + hi[i]) / 2);
    const radius = Math.max(0.05, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    return { center, radius, min: lo, max: hi };
}

/** Frames to look at for a range's box: both ends and up to `n` between. */
export function sampleFrames(from, to, n = 9) {
    const out = new Set([from, to]);
    const k = Math.max(1, n - 1);
    for (let i = 1; i < k; i++) out.add(Math.round(from + ((to - from) * i) / k));
    return [...out].sort((a, b) => a - b);
}

/**
 * A short description of a 3D scene for the agent: the shot, the items worth
 * naming (cameras, models, groups, primitives; controls only counted), the
 * clip sequencer, the animation layers and the display layers.
 */
export function describeScene(scene, { activeCamera = null, max = 60 } = {}) {
    if (!scene || !Array.isArray(scene.items)) return null;
    const items = scene.items;
    const keyed = (it) => {
        const fs = new Set();
        for (const keys of Object.values(it.tracks || {})) for (const k of keys || []) fs.add(k.f);
        for (const lt of Object.values(it.layerTracks || {})) for (const keys of Object.values(lt || {})) for (const k of keys || []) fs.add(k.f);
        const l = [...fs].sort((a, b) => a - b);
        return l.length ? { count: l.length, first: l[0], last: l[l.length - 1] } : null;
    };
    const named = items.filter((it) => it.kind !== "control").slice(0, max).map((it) => {
        const o = { id: it.id, name: it.name, kind: it.kind || (it.primitive ? "primitive" : "group") };
        if (it.parent) {
            const p = items.find((x) => x.id === it.parent);
            o.parent = p ? p.name : it.parent;
        }
        const k = keyed(it);
        if (k) o.keys = k;
        if (it.kind === "camera") { o.fov = r4(num(it.fov, 35)); if (Array.isArray(it.resolution)) o.resolution = it.resolution.slice(0, 2); }
        return o;
    });
    const controls = items.filter((it) => it.kind === "control").length;
    const q = scene.sequencer;
    const seq = q && Array.isArray(q.tracks) ? {
        sources: (q.sources || []).map((s) => ({ id: s.id, name: s.name, length: s.length, made: s.made })),
        tracks: q.tracks.map((t) => ({ id: t.id, name: t.name, mute: !!t.mute, solo: !!t.solo, lock: !!t.lock,
            weight: t.weight, mode: t.mode,
            clips: (t.clips || []).map((c) => {
                const s = (q.sources || []).find((x) => x.id === c.source);
                return { id: c.id, name: c.name || (s ? s.name : "clip"), ...clipFrames(c), speed: c.speed, loop: c.loop || "",
                         weight: c.weight, mute: !!c.mute };
            }) })),
    } : null;
    const layers = Array.isArray(scene.animLayers) ? scene.animLayers.map((l) => ({ id: l.id, name: l.name, mode: l.mode,
        weight: l.weight, mute: !!l.mute, solo: !!l.solo, lock: !!l.lock })) : [];
    const dl = Array.isArray(scene.displayLayers) ? scene.displayLayers.map((l) => ({ id: l.id, name: l.name,
        visible: l.visible !== false, mode: l.mode || "normal", members: (l.members || []).length })) : [];
    const cam = activeCamera || scene.activeCamera || null;
    const camItem = cam && items.find((x) => x.id === cam);
    return {
        fps: scene.fps || 24, length: scene.length || 0,
        active_camera: camItem ? camItem.name : null,
        items: named, more_items: Math.max(0, items.filter((it) => it.kind !== "control").length - named.length), controls,
        clips: seq, anim_layers: layers, active_layer: scene.activeLayer || null, display_layers: dl,
    };
}
