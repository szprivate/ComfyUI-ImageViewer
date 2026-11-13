// imageViewer_compCamImport.js
// A Camera node's keys from somewhere else: a camera of the viewer's 3D space (a shot open in a 3D tab) or a
// camera text file (GET /imageviewer/comp_camera reads it into {f, t, r, vfov?} lines). Pure: no DOM.
//
// Both become the same samples, {f, t: [x, y, z], r: [x, y, z] (degrees, X then Y then Z), vfov?}, and
// cameraKeys turns those into the node's tracks: translate, rotate and - where a vertical field of view is known -
// focal, worked out from the node's film back and the comp's shape. One key a frame, linear.
import { evaluateIn, itemById, offsetOf } from "./imageViewer_scene3d.js";
import { m4mul, m4t, eulerXYZ, m4s } from "./imageViewer_comp3d.js";

const R2D = 180 / Math.PI;

/** A rotation part (row major 4 x 4, any scale taken out) as X-then-Y-then-Z degrees. */
export function eulerOf(m) {
    const col = (c) => Math.hypot(m[c], m[4 + c], m[8 + c]) || 1;
    const sx = col(0), sy = col(1), sz = col(2);
    const r00 = m[0] / sx, r01 = m[1] / sy, r02 = m[2] / sz;
    const r11 = m[5] / sy, r12 = m[6] / sz, r21 = m[9] / sy, r22 = m[10] / sz;
    const y = Math.asin(Math.max(-1, Math.min(1, r02)));
    let x, z;
    if (Math.abs(r02) < 0.9999999) { x = Math.atan2(-r12, r22); z = Math.atan2(-r01, r00); } else { x = Math.atan2(r21, r11); z = 0; }
    return [x * R2D, y * R2D, z * R2D];
}

// A three.js-style column-major 16 as row major.
const rowMajor = (e) => [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]];

/** An item's own matrix at a frame: T(position + pivot) . R . S, then (for a parent) T(-pivot) . offset. */
function localOf(scene, item, frame, asParent) {
    const at = evaluateIn(scene, item, frame);
    const p = at.position || [0, 0, 0], pv = at.pivot || [0, 0, 0], s = at.scale || [1, 1, 1];
    let m = m4mul(m4t(p[0] + pv[0], p[1] + pv[1], p[2] + pv[2]), m4mul(eulerXYZ(at.rotation || [0, 0, 0]), m4s(s[0], s[1], s[2])));
    if (asParent) {
        m = m4mul(m, m4t(-pv[0], -pv[1], -pv[2]));
        const off = offsetOf(item);
        if (off) m = m4mul(m, rowMajor(off));
    }
    return { m, fov: at.fov };
}

/** The 3D space's cameras: [{id, name}]. */
export const sceneCameras = (scene) => ((scene && scene.items) || []).filter((i) => i.kind === "camera").map((i) => ({ id: i.id, name: i.name || i.id, aimed: !!(i.aim && i.aim.on) }));

/** A 3D-space camera's samples at scene frames first..last (comp frame 0 is scene frame `first`). */
export function sceneCameraSamples(scene, id, first, last) {
    const cam = itemById(scene, id);
    if (!cam) return [];
    const out = [];
    for (let f = first; f <= last; f++) {
        let { m, fov } = localOf(scene, cam, f, false);
        for (let p = cam.parent && itemById(scene, cam.parent), guard = 0; p && guard < 64; p = p.parent && itemById(scene, p.parent), guard++) {
            m = m4mul(localOf(scene, p, f, true).m, m);
        }
        out.push({ f: f - first, t: [m[3], m[7], m[11]], r: eulerOf(m), vfov: fov || 35 });
    }
    return out;
}

/** The focal length that gives a vertical field of view `vfov` (degrees) on a film back `hap` wide, picture w x h. */
export const focalFor = (vfov, hap, w, h) => (hap * h / w / 2) / Math.tan((vfov * Math.PI) / 360);

/** Samples -> {translate, rotate, focal?} tracks (Motion's keys: {f, v, ease}). */
export function cameraKeys(samples, hap, w, h) {
    const k = (f, v) => ({ f, v, ease: "linear" });
    const tracks = { translate: samples.map((s) => k(s.f, s.t.slice())), rotate: samples.map((s) => k(s.f, s.r.slice())) };
    const lens = samples.filter((s) => s.vfov > 0 && s.vfov < 180);
    if (lens.length) tracks.focal = lens.map((s) => k(s.f, Math.round(focalFor(s.vfov, hap, w, h) * 1e4) / 1e4));
    return tracks;
}

/** A Camera node given those tracks (in place): one key on a frame keeps the value as it is instead. */
export function applyCameraKeys(node, tracks) {
    node.tracks = node.tracks || {};
    for (const [p, keys] of Object.entries(tracks)) {
        if (!keys.length) continue;
        node[p] = keys[0].v;
        if (keys.length > 1) node.tracks[p] = keys; else delete node.tracks[p];
    }
    if (!Object.keys(node.tracks).length) delete node.tracks;
    return node;
}
