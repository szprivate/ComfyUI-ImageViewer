// imageViewer_rigLive.js
// A character's rig carried inside an exported FBX / USD, and motion brought back
// from one. Pure: no DOM, no three.js, so it runs under plain node
// (tests/test_rig_live.mjs).
//
// Every application reads the BAKED motion of an export (src/rig_export.py). The
// viewer's own rig - the controls, their keys, and whatever else hangs on it
// (animation layers, constraints) - travels beside it as one JSON object
// (`collectRigLive`), packed into the file by the server. Brought back
// (`restoreRigLive`), it replaces the character's rig as it was, ids and all.
// The file's motion is compared with a fingerprint taken at export
// (`fingerprint` / `sameFingerprint`), so a file that was changed in another
// application since is noticed: its motion is then baked onto the controls
// instead (`retarget`), which is also what a file from elsewhere gets.
//
// What is carried, without anyone having to say so:
//   - the rig group of the character and everything under it,
//   - every control of the character,
//   - every other scene item whose JSON names one of those ids (a constraint
//     item pointing at a control, a layer listing controls). An item that names
//     only the model (a prop constrained to the character's hand) is not the
//     rig: it stays in the scene as it is.
// State kept OUTSIDE scene.items is carried by registering a part:
//   registerRigLivePart(name, { save(panel, modelId) -> JSON | null,
//                               load(panel, modelId, json, remapId) })
// `remapId(id)` answers the id an item has in the scene now (ids are kept,
// except where they would collide with another character's, and the model's id
// is always the model's in this scene).
//
// The retargeting is textbook: each matched bone takes the source bone's
// rotation from its rest, in model space (D = Q · Qrest⁻¹ onto the target's
// rest), the top bone also its move from rest, scaled by the characters'
// heights; the other bones keep their own lengths. Written for this file.

import { mat4, quat, v3 } from "./imageViewer_rigData.js";

export const LIVE_VERSION = 1;

const _parts = new Map();

/** Carry some state of a character's rig that is not in scene.items (see the header). */
export function registerRigLivePart(name, part) {
    if (!name || !part || typeof part.save !== "function" || typeof part.load !== "function") {
        throw new Error("registerRigLivePart(name, { save, load })");
    }
    _parts.set(String(name), part);
}

export function rigLiveParts() {
    return new Map(_parts);
}

// ── Which items are the rig ──────────────────────────────────────────────────

function _mentions(value, ids) {
    if (typeof value === "string") return ids.has(value);
    if (Array.isArray(value)) return value.some((v) => _mentions(v, ids));
    if (value && typeof value === "object") return Object.values(value).some((v) => _mentions(v, ids));
    return false;
}

/** The scene items that make up a character's rig (see the header), in scene order. */
export function rigItems(scene, modelId) {
    const items = (scene && scene.items) || [];
    const ids = new Set();
    const group = items.find((it) => it.kind === "group" && it.rig && it.rig.model === modelId);
    if (group) ids.add(group.id);
    let grew = true;
    while (grew) {                                     // the group's descendants
        grew = false;
        for (const it of items) if (!ids.has(it.id) && it.parent && ids.has(it.parent)) { ids.add(it.id); grew = true; }
    }
    for (const it of items) if (it.kind === "control" && it.control && it.control.model === modelId) ids.add(it.id);
    if (!ids.size) return [];
    const named = new Set(ids);
    for (const it of items) {
        if (ids.has(it.id) || it.id === modelId) continue;
        const { id, ...rest } = it;
        if (_mentions(rest, named)) ids.add(it.id);
    }
    return items.filter((it) => ids.has(it.id));
}

// ── Out ──────────────────────────────────────────────────────────────────────

const _round = (v, k = 1e5) => Math.round(v * k) / k;

/**
 * Where a few bones are on a few frames: what the file's motion is checked against
 * when it comes back. `poses`: [{ f, pose: Map name -> model-space 4x4 }].
 */
export function fingerprint(poses, { bones = 8, frames = 12 } = {}) {
    if (!poses || !poses.length) return null;
    const names = [...poses[0].pose.keys()];
    const pickN = (n, k) => (n <= k ? [...Array(n).keys()] : [...Array(k).keys()].map((i) => Math.round((i * (n - 1)) / (k - 1))));
    const bi = [...new Set(pickN(names.length, bones))].map((i) => names[i]);
    const fi = [...new Set(pickN(poses.length, frames))];
    return {
        bones: bi,
        frames: fi.map((i) => poses[i].f),
        pos: fi.map((i) => bi.map((n) => { const m = poses[i].pose.get(n); return [_round(m[12]), _round(m[13]), _round(m[14])]; })),
    };
}

/**
 * Two fingerprints the same, to `tol` (scene units; a little: the file's numbers went through
 * floats, Euler angles and another program's resampling). `poses` as for `fingerprint`, at
 * the same frames; false when a bone or a frame is missing.
 */
export function sameFingerprint(fp, poses, tol) {
    if (!fp || !poses) return false;
    const at = new Map(poses.map((p) => [p.f, p.pose]));
    for (let i = 0; i < fp.frames.length; i++) {
        const pose = at.get(fp.frames[i]);
        if (!pose) return false;
        for (let j = 0; j < fp.bones.length; j++) {
            const m = pose.get(fp.bones[j]);
            if (!m) return false;
            if (v3.dist([m[12], m[13], m[14]], fp.pos[i][j]) > tol) return false;
        }
    }
    return true;
}

/**
 * The rig as JSON for the file. `bones`: the skeleton's names (a rig only comes back onto
 * the same skeleton). `extra` is `{ panel }` for the registered parts, `fingerprint` and
 * `range` [first, last] / `fps` of the export.
 */
export function collectRigLive(scene, modelId, { bones = [], panel = null, fingerprint: fp = null, range = null, fps = null } = {}) {
    const items = rigItems(scene, modelId);
    if (!items.length) return null;
    const model = ((scene && scene.items) || []).find((it) => it.id === modelId);
    const parts = {};
    for (const [name, part] of _parts) {
        try {
            const v = part.save(panel, modelId);
            if (v !== null && v !== undefined) parts[name] = v;
        } catch (e) {
            console.warn(`[ImageViewer] rig part ${name} was not saved:`, e);
        }
    }
    return {
        v: LIVE_VERSION, kind: "imageviewer.rig",
        model: { id: modelId, name: model ? model.name : "", bones: [...bones] },
        items: JSON.parse(JSON.stringify(items)), parts, fingerprint: fp, range, fps,
    };
}

// ── Back ─────────────────────────────────────────────────────────────────────

/** Is `live` a rig this character can take back? { ok, why }. */
export function canRestore(live, bones) {
    if (!live || live.kind !== "imageviewer.rig" || !Array.isArray(live.items)) return { ok: false, why: "the file carries no viewer rig" };
    if (live.v > LIVE_VERSION) return { ok: false, why: "the rig was saved by a newer viewer" };
    const want = (live.model && live.model.bones) || [];
    const have = new Set(bones || []);
    const missing = want.filter((n) => !have.has(n));
    if (!want.length || missing.length) {
        return { ok: false, why: `the rig was made for another skeleton (${missing.length || want.length} bones not found here)` };
    }
    return { ok: true, why: "" };
}

function _remapDeep(value, map) {
    if (typeof value === "string") return map.has(value) ? map.get(value) : value;
    if (Array.isArray(value)) return value.map((v) => _remapDeep(v, map));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = _remapDeep(v, map);
        return out;
    }
    return value;
}

/**
 * The rig in `live` back onto character `modelId` of `scene`, replacing the rig it has.
 * `newId()` makes an id where a kept one would collide with an item that is not this
 * character's. Changes `scene.items`; answers { items, remap } (the items added, and
 * remap(oldId) -> id now). `clean(items)` may pass them through the scene's own reader.
 */
export function restoreRigLive(scene, modelId, live, { newId, clean = null, panel = null } = {}) {
    const mine = new Set(rigItems(scene, modelId).map((it) => it.id));
    const taken = new Set((scene.items || []).filter((it) => !mine.has(it.id)).map((it) => it.id));
    const map = new Map();
    const oldModel = live.model && live.model.id;
    if (oldModel && oldModel !== modelId) map.set(oldModel, modelId);
    for (const it of live.items) {
        if (it.id === modelId || it.id === oldModel) continue;
        if (taken.has(it.id)) map.set(it.id, newId());
    }
    let items = live.items.filter((it) => it.id !== oldModel && it.id !== modelId).map((it) => _remapDeep(it, map));
    if (clean) items = clean(items);
    const incoming = new Set(items.map((it) => it.id));
    scene.items = (scene.items || []).filter((it) => !mine.has(it.id) && !incoming.has(it.id));
    scene.items.push(...items);
    const remap = (id) => (map.has(id) ? map.get(id) : id);
    for (const [name, data] of Object.entries(live.parts || {})) {
        const part = _parts.get(name);
        if (!part) continue;
        try {
            part.load(panel, modelId, _remapDeep(data, map), remap);
        } catch (e) {
            console.warn(`[ImageViewer] rig part ${name} was not restored:`, e);
        }
    }
    return { items, remap };
}

// ── Motion from another skeleton ─────────────────────────────────────────────

/** A bone name reduced to what is compared: no namespace, no Mixamo prefix, lower case, letters and digits. */
export function boneKey(name) {
    let s = String(name || "");
    s = s.replace(/^.*[:|]/, "");
    s = s.replace(/^mixamorig/i, "");
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Which source bone each target bone follows: Map target name -> source name. The same
 * name first (after `boneKey`), then the same humanoid role when both are humanoids
 * (`roles`: { src: {role: name}, dst: {role: name} }, from rigData.matchHumanoid).
 */
export function matchBones(srcNames, dstNames, roles = null) {
    const out = new Map();
    const byKey = new Map();
    for (const n of srcNames) if (!byKey.has(boneKey(n))) byKey.set(boneKey(n), n);
    for (const n of dstNames) if (byKey.has(boneKey(n))) out.set(n, byKey.get(boneKey(n)));
    if (roles && roles.src && roles.dst) {
        const used = new Set(out.values());
        for (const [role, dn] of Object.entries(roles.dst)) {
            const sn = roles.src[role];
            if (sn && !out.has(dn) && !used.has(sn)) { out.set(dn, sn); used.add(sn); }
        }
    }
    return out;
}

/** Parents before children: the bones' order for walking down a skeleton. */
export function topoOrder(bones) {
    const byName = new Map(bones.map((b) => [b.name, b]));
    const out = [], seen = new Set();
    const visit = (b, depth = 0) => {
        if (seen.has(b.name) || depth > 4096) return;
        if (b.parent && byName.has(b.parent)) visit(byName.get(b.parent), depth + 1);
        if (!seen.has(b.name)) { seen.add(b.name); out.push(b); }
    };
    for (const b of bones) visit(b);
    return out;
}

/** Model-space worlds from local matrices: `bones` [{ name, parent }], `locals` Map name -> 4x4. */
export function worldsFromLocals(bones, locals) {
    const out = new Map();
    for (const b of topoOrder(bones)) {
        const l = locals.get(b.name) || mat4.identity();
        out.set(b.name, b.parent && out.has(b.parent) ? mat4.mul(out.get(b.parent), l) : l);
    }
    return out;
}

/** How tall a skeleton stands: the spread of its joints' heights at rest (scene units). */
export function skeletonHeight(bones) {
    let lo = Infinity, hi = -Infinity;
    for (const b of bones) { lo = Math.min(lo, b.world[13]); hi = Math.max(hi, b.world[13]); }
    return Number.isFinite(hi - lo) && hi - lo > 1e-9 ? hi - lo : 1;
}

/** Z up -> Y up (the viewer's), as a matrix to put in front of a Z-up file's model space. */
export const Z_UP_TO_Y_UP = mat4.compose([0, 0, 0], quat.axisAngle([1, 0, 0], -Math.PI / 2), [1, 1, 1]);

/**
 * Motion of a source skeleton put on the target's.
 *   src: { bones: [{ name, parent, world }] (rest, model space), frames: [{ f, worlds: Map name -> 4x4 }] }
 *   dst: { bones: [{ name, parent, world }] (rest, model space) }
 *   match: Map dst name -> src name (`matchBones`)
 * Answers [{ f, pose: Map dst name -> model-space 4x4 }], every target bone on every frame.
 */
export function retarget(src, dst, match, { alignRest = true } = {}) {
    const sRest = new Map(src.bones.map((b) => [b.name, b.world]));
    const order = topoOrder(dst.bones);
    const dRest = new Map(dst.bones.map((b) => [b.name, b.world]));
    const ratio = skeletonHeight(dst.bones) / skeletonHeight(src.bones);
    const parentOf = new Map(dst.bones.map((b) => [b.name, b.parent && dRest.has(b.parent) ? b.parent : null]));
    const localRest = new Map(order.map((b) => {
        const p = parentOf.get(b.name);
        return [b.name, p ? mat4.mul(mat4.invert(dRest.get(p)), dRest.get(b.name)) : dRest.get(b.name)];
    }));
    // A bone whose matched ancestors are none: it takes the source's move too (the hips).
    const top = new Set();
    for (const b of order) {
        if (!match.has(b.name)) continue;
        let p = parentOf.get(b.name), under = false;
        while (p) { if (match.has(p)) { under = true; break; } p = parentOf.get(p); }
        if (!under) top.add(b.name);
    }
    // The same skeleton (a round trip): a matched bone whose length is the source's keeps the
    // source's own local offset, so bones that were moved (not only turned) come back as they were.
    const sParent = new Map(src.bones.map((b) => [b.name, b.parent]));
    const sameLen = new Map();
    const hD = skeletonHeight(dst.bones);
    for (const b of order) {
        const sn = match.get(b.name);
        if (!sn) continue;
        const sp = sParent.get(sn), dp = parentOf.get(b.name);
        if (!sp || !dp || match.get(dp) !== sp) continue;
        const sl = mat4.mul(mat4.invert(sRest.get(sp)), sRest.get(sn));
        const dl = localRest.get(b.name);
        sameLen.set(b.name, v3.dist([sl[12], sl[13], sl[14]], [dl[12], dl[13], dl[14]]) < 1e-4 * hD && Math.abs(ratio - 1) < 1e-3);
    }
    const sRestD = new Map([...sRest].map(([n, m]) => [n, mat4.decompose(m)]));
    const dRestD = new Map([...dRest].map(([n, m]) => [n, mat4.decompose(m)]));
    const align = alignRest ? restAlignment(src, dst, match) : new Map();
    return src.frames.map((fr) => {
        const pose = new Map();
        for (const b of order) {
            const p = parentOf.get(b.name);
            const pw = p ? pose.get(p) : null;
            const sn = match.get(b.name);
            const sw = sn && fr.worlds.get(sn);
            const rd = dRestD.get(b.name);
            if (!sw || !sRestD.has(sn)) {
                pose.set(b.name, pw ? mat4.mul(pw, localRest.get(b.name)) : dRest.get(b.name));
                continue;
            }
            const now = mat4.decompose(sw), was = sRestD.get(sn);
            // The source's turn from its rest, put on the target's rest turned to stand as the source's does.
            const rq = align.has(b.name) ? quat.mul(align.get(b.name), rd.q) : rd.q;
            const q = quat.norm(quat.mul(quat.mul(now.q, quat.conj(was.q)), rq));
            let pos;
            if (top.has(b.name) || !pw) {
                pos = v3.add(rd.p, v3.scale(v3.sub(now.p, was.p), ratio));
            } else if (sameLen.get(b.name)) {
                const sp = fr.worlds.get(sParent.get(sn));
                const sl = mat4.mul(mat4.invert(sp), sw);
                pos = mat4.point(pw, [sl[12], sl[13], sl[14]]);
            } else {
                const lr = localRest.get(b.name);
                pos = mat4.point(pw, [lr[12], lr[13], lr[14]]);
            }
            pose.set(b.name, mat4.compose(pos, q, rd.s));
        }
        return { f: fr.f, pose };
    });
}

/**
 * The turn (model space) that makes each target bone point at rest the way its source bone
 * does: a T-pose file onto an A-pose character turns the arms up first, so that the file's
 * rest is the character's rest and the motion lands as it looks in the file. A bone points
 * from its head to the middle of its matched children (compared bone for bone, so the two
 * skeletons' proportions do not matter); a bone with no matched child takes the turn of its
 * nearest bone above that has one (a hand keeps lying along its forearm). Swing only: the
 * smallest turn between the two directions. Answers Map dst name -> quaternion; bones that
 * already agree (the same skeleton coming back) are left out.
 */
export function restAlignment(src, dst, match) {
    const sRest = new Map(src.bones.map((b) => [b.name, b.world]));
    const dRest = new Map(dst.bones.map((b) => [b.name, b.world]));
    const head = (m) => [m[12], m[13], m[14]];
    const parentOf = new Map(dst.bones.map((b) => [b.name, b.parent && dRest.has(b.parent) ? b.parent : null]));
    const kids = new Map();
    for (const b of dst.bones) {
        const p = parentOf.get(b.name);
        if (p && match.has(b.name) && sRest.has(match.get(b.name))) {
            if (!kids.has(p)) kids.set(p, []);
            kids.get(p).push(b.name);
        }
    }
    const mid = (names, rest, map) => {
        const sum = names.reduce((a, n) => v3.add(a, head(rest.get(map ? map.get(n) : n))), [0, 0, 0]);
        return v3.scale(sum, 1 / names.length);
    };
    const out = new Map();
    const own = new Map();
    for (const b of topoOrder(dst.bones)) {
        const sn = match.get(b.name);
        const ch = kids.get(b.name);
        if (sn && sRest.has(sn) && ch && ch.length) {
            const dDir = v3.sub(mid(ch, dRest, null), head(dRest.get(b.name)));
            const sDir = v3.sub(mid(ch, sRest, match), head(sRest.get(sn)));
            if (v3.len(dDir) > 1e-9 && v3.len(sDir) > 1e-9) {
                const q = quat.between(dDir, sDir);
                own.set(b.name, q);
                continue;
            }
        }
        // No direction of its own: the nearest bone above with one.
        let p = parentOf.get(b.name);
        while (p && !own.has(p)) p = parentOf.get(p);
        if (p) own.set(b.name, own.get(p));
    }
    for (const [n, q] of own) if (Math.abs(q[3]) < 1 - 1e-9) out.set(n, q);
    return out;
}

/**
 * Scene frames for a file's motion: its times (seconds) onto the scene's frame grid, from
 * `start`. Answers [{ f, t }]: one per scene frame over the motion's length.
 */
export function framesFor(duration, sceneFps, start = 0) {
    const n = Math.max(1, Math.round(Math.max(0, duration) * sceneFps) + 1);
    return Array.from({ length: n }, (_, i) => ({ f: start + i, t: i / sceneFps }));
}
