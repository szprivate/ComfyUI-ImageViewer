// imageViewer_meshData.js
// An editable polygon mesh, as plain data, and what modeling does to it.
//
// No three.js and no DOM, so all of it runs under plain node
// (tests/test_mesh_data.mjs). Clean-room: written from the geometry itself
// (Newell's normal, ear clipping, region boundaries), not from any program.
//
// Two shapes of the same mesh:
//   packed  {v: [x, y, z, x, y, z, ...], f: [n, i, j, k, ..., n, ...]}
//           what a scene item keeps (`item.mesh`) and saves: flat numbers,
//           rounded to a millionth, so the scene's JSON stays short;
//   working {v: [[x, y, z], ...], f: [[i, j, k, ...], ...]}
//           what every operation here reads and returns.
// A face lists its corners counter-clockwise seen from outside (its front),
// as three.js winds a triangle. Faces may have any number of corners (n-gons).
//
// A selection is a mode and a list of ids: vertices and faces by index, edges
// by `edgeKey(a, b)` ("a-b", the smaller index first), so it survives the
// edge list being made again.

export const MESH_MODES = ["vertex", "edge", "face"];
export const MAX_VERTS = 200000;
export const MAX_FACES = 200000;

const R = 1e6;
const round = (x) => Math.round(x * R) / R;

// ── Packed <-> working ───────────────────────────────────────────────────────

/** A working copy of a packed mesh (or of a working one). */
export function unpack(raw) {
    if (!raw || typeof raw !== "object") return { v: [], f: [] };
    let v = [], f = [];
    if (Array.isArray(raw.v) && raw.v.length && Array.isArray(raw.v[0])) {
        v = raw.v.map((p) => [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0]);
    } else if (Array.isArray(raw.v)) {
        for (let i = 0; i + 2 < raw.v.length; i += 3) {
            v.push([Number(raw.v[i]) || 0, Number(raw.v[i + 1]) || 0, Number(raw.v[i + 2]) || 0]);
        }
    }
    if (Array.isArray(raw.f) && raw.f.length && Array.isArray(raw.f[0])) {
        f = raw.f.map((face) => face.map((i) => Math.trunc(Number(i))));
    } else if (Array.isArray(raw.f)) {
        for (let i = 0; i < raw.f.length;) {
            const n = Math.trunc(Number(raw.f[i]));
            if (!(n >= 1) || i + n >= raw.f.length) break;
            f.push(raw.f.slice(i + 1, i + 1 + n).map((x) => Math.trunc(Number(x))));
            i += n + 1;
        }
    }
    return { v, f };
}

/** The packed form of a working mesh, rounded to a millionth. */
export function pack(mesh) {
    const v = [], f = [];
    for (const p of mesh.v) v.push(round(p[0]), round(p[1]), round(p[2]));
    for (const face of mesh.f) { f.push(face.length); for (const i of face) f.push(i); }
    return { v, f };
}

/**
 * A mesh as it may be kept: indices in range, no face with fewer than three
 * different corners, no corner twice in a row, within MAX_VERTS / MAX_FACES.
 * Returns the PACKED mesh, or null when nothing usable is there.
 */
export function cleanMesh(raw) {
    const m = unpack(raw);
    if (m.v.length > MAX_VERTS) return null;
    const n = m.v.length;
    const faces = [];
    for (const face of m.f) {
        // A corner that names no vertex spoils the whole face.
        const out = face.every((i) => Number.isInteger(i) && i >= 0 && i < n) ? tidyFace(face) : null;
        if (out) faces.push(out);
        if (faces.length >= MAX_FACES) break;
    }
    if (!n) return null;
    return pack({ v: m.v, f: faces });
}

/** A face without a corner repeated in a row (the last against the first too); null under 3. */
function tidyFace(face) {
    const out = [];
    for (const i of face) if (out[out.length - 1] !== i) out.push(i);
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    if (new Set(out).size < 3) return null;
    return out;
}

export function copyMesh(mesh) {
    return { v: mesh.v.map((p) => p.slice()), f: mesh.f.map((face) => face.slice()) };
}

// ── Vectors ──────────────────────────────────────────────────────────────────

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };

// ── Faces and edges ─────────────────────────────────────────────────────────

/** Newell's normal of a face: its direction is the face's front, its length twice its area. */
export function faceNormalRaw(mesh, face) {
    const n = [0, 0, 0];
    for (let k = 0; k < face.length; k++) {
        const a = mesh.v[face[k]], b = mesh.v[face[(k + 1) % face.length]];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return n;
}

export function faceNormal(mesh, face) { return norm(faceNormalRaw(mesh, face)); }

export function faceCentroid(mesh, face) {
    const c = [0, 0, 0];
    for (const i of face) { c[0] += mesh.v[i][0]; c[1] += mesh.v[i][1]; c[2] += mesh.v[i][2]; }
    return mul(c, 1 / face.length);
}

export function edgeKey(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
export function edgeEnds(key) { const [a, b] = String(key).split("-").map(Number); return [a, b]; }

/** Every edge once, in the order the faces first name them: [[a, b], ...] with a < b. */
export function meshEdges(mesh) {
    const seen = new Set(), out = [];
    for (const face of mesh.f) {
        for (let k = 0; k < face.length; k++) {
            const a = face[k], b = face[(k + 1) % face.length];
            const key = edgeKey(a, b);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(a < b ? [a, b] : [b, a]);
        }
    }
    return out;
}

/** edge key -> the faces that have it. */
export function edgeFaces(mesh) {
    const map = new Map();
    mesh.f.forEach((face, fi) => {
        for (let k = 0; k < face.length; k++) {
            const key = edgeKey(face[k], face[(k + 1) % face.length]);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(fi);
        }
    });
    return map;
}

/** vertex -> the faces that use it. */
export function vertexFaces(mesh) {
    const out = mesh.v.map(() => []);
    mesh.f.forEach((face, fi) => { for (const i of face) out[i].push(fi); });
    return out;
}

export function meshStats(packedOrWorking) {
    const m = packedOrWorking && Array.isArray(packedOrWorking.f) && packedOrWorking.f.length
        && !Array.isArray(packedOrWorking.f[0]) ? unpack(packedOrWorking) : (packedOrWorking || { v: [], f: [] });
    let tris = 0;
    for (const face of m.f) tris += face.length - 2;
    return { verts: m.v.length, faces: m.f.length, edges: meshEdges(m).length, tris };
}

// ── Triangles for drawing ────────────────────────────────────────────────────

/**
 * A face as triangles of its own corners: a fan when it is convex, ear
 * clipping in its own plane when it is not. Always face.length - 2 triangles.
 */
export function triangulateFace(mesh, face) {
    const n = face.length;
    if (n === 3) return [[face[0], face[1], face[2]]];
    const nrm = faceNormalRaw(mesh, face);
    // Drop the normal's largest axis: the face seen flat.
    const ax = Math.abs(nrm[0]), ay = Math.abs(nrm[1]), az = Math.abs(nrm[2]);
    const [u, w] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
    const sign = (az >= ax && az >= ay ? nrm[2] : ax >= ay ? nrm[0] : nrm[1]) >= 0 ? 1 : -1;
    const P = face.map((i) => [mesh.v[i][u], mesh.v[i][w]]);
    const area2 = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sign;
    let convex = true;
    for (let k = 0; k < n && convex; k++) {
        if (area2(P[k], P[(k + 1) % n], P[(k + 2) % n]) < -1e-12) convex = false;
    }
    if (convex) {
        const out = [];
        for (let k = 1; k + 1 < n; k++) out.push([face[0], face[k], face[k + 1]]);
        return out;
    }
    const idx = [...Array(n).keys()];
    const out = [];
    const inside = (p, a, b, c) => area2(a, b, p) >= -1e-12 && area2(b, c, p) >= -1e-12 && area2(c, a, p) >= -1e-12;
    let guard = n * n;
    while (idx.length > 3 && guard-- > 0) {
        let cut = -1;
        for (let k = 0; k < idx.length; k++) {
            const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
            if (area2(P[a], P[b], P[c]) <= 1e-12) continue;
            let ear = true;
            for (const o of idx) {
                if (o === a || o === b || o === c) continue;
                if (inside(P[o], P[a], P[b], P[c])) { ear = false; break; }
            }
            if (ear) { cut = k; break; }
        }
        if (cut < 0) cut = 0;          // nothing clean to cut (a twisted face): cut anyway
        const a = idx[(cut + idx.length - 1) % idx.length], b = idx[cut], c = idx[(cut + 1) % idx.length];
        out.push([face[a], face[b], face[c]]);
        idx.splice(cut, 1);
    }
    out.push([face[idx[0]], face[idx[1]], face[idx[2]]]);
    return out;
}

/**
 * Everything three.js needs to draw a mesh: positions and normals per
 * triangle corner (no index: a flat face is flat, a smooth one takes its
 * vertices' normals), and which face each triangle belongs to.
 */
export function meshTriangles(mesh, smooth = false) {
    const tris = [], triFace = [];
    mesh.f.forEach((face, fi) => {
        for (const t of triangulateFace(mesh, face)) { tris.push(t); triFace.push(fi); }
    });
    const fn = mesh.f.map((face) => faceNormalRaw(mesh, face));
    let vn = null;
    if (smooth) {
        vn = mesh.v.map(() => [0, 0, 0]);
        mesh.f.forEach((face, fi) => { for (const i of face) { const n = vn[i]; n[0] += fn[fi][0]; n[1] += fn[fi][1]; n[2] += fn[fi][2]; } });
        vn = vn.map(norm);
    }
    const position = new Float32Array(tris.length * 9);
    const normal = new Float32Array(tris.length * 9);
    tris.forEach((t, ti) => {
        const fN = norm(fn[triFace[ti]]);
        for (let c = 0; c < 3; c++) {
            const p = mesh.v[t[c]], n = vn ? vn[t[c]] : fN;
            const o = ti * 9 + c * 3;
            position[o] = p[0]; position[o + 1] = p[1]; position[o + 2] = p[2];
            normal[o] = n[0]; normal[o + 1] = n[1]; normal[o + 2] = n[2];
        }
    });
    return { position, normal, triFace: Int32Array.from(triFace), tris };
}

// ── Selections ──────────────────────────────────────────────────────────────

/** The vertices a selection moves. */
export function selVertices(mesh, mode, ids) {
    const out = new Set();
    if (mode === "vertex") { for (const i of ids) if (i >= 0 && i < mesh.v.length) out.add(i); }
    else if (mode === "edge") { for (const k of ids) for (const i of edgeEnds(k)) if (i >= 0 && i < mesh.v.length) out.add(i); }
    else if (mode === "face") { for (const fi of ids) if (mesh.f[fi]) for (const i of mesh.f[fi]) out.add(i); }
    return out;
}

/** The ids of a selection that are still there in `mesh`. */
export function pruneSel(mesh, mode, ids) {
    if (mode === "vertex") return [...new Set(ids)].filter((i) => Number.isInteger(i) && i >= 0 && i < mesh.v.length);
    if (mode === "face") return [...new Set(ids)].filter((i) => Number.isInteger(i) && i >= 0 && i < mesh.f.length);
    const have = new Set(meshEdges(mesh).map(([a, b]) => edgeKey(a, b)));
    return [...new Set(ids)].filter((k) => have.has(k));
}

/** Everything of a kind. */
export function allOf(mesh, mode) {
    if (mode === "vertex") return mesh.v.map((_, i) => i);
    if (mode === "face") return mesh.f.map((_, i) => i);
    return meshEdges(mesh).map(([a, b]) => edgeKey(a, b));
}

/** What is not selected. */
export function invertSel(mesh, mode, ids) {
    const have = new Set(ids);
    return allOf(mesh, mode).filter((x) => !have.has(x));
}

/**
 * A selection taken into another mode: going down (face -> edge -> vertex)
 * takes all the parts; going up takes what is wholly selected.
 */
export function convertSel(mesh, from, to, ids) {
    if (from === to) return pruneSel(mesh, to, ids);
    const verts = selVertices(mesh, from, ids);
    if (to === "vertex") return [...verts].sort((a, b) => a - b);
    if (to === "edge") {
        if (from === "face") {
            const out = new Set();
            for (const fi of ids) {
                const face = mesh.f[fi];
                if (!face) continue;
                for (let k = 0; k < face.length; k++) out.add(edgeKey(face[k], face[(k + 1) % face.length]));
            }
            return [...out];
        }
        return meshEdges(mesh).filter(([a, b]) => verts.has(a) && verts.has(b)).map(([a, b]) => edgeKey(a, b));
    }
    // to face
    if (from === "edge") {
        const keys = new Set(ids);
        return mesh.f.map((face, fi) => [face, fi]).filter(([face]) => face.every((_, k) =>
            keys.has(edgeKey(face[k], face[(k + 1) % face.length])))).map(([, fi]) => fi);
    }
    return mesh.f.map((face, fi) => [face, fi]).filter(([face]) => face.every((i) => verts.has(i))).map(([, fi]) => fi);
}

/** One more ring of neighbours (through the faces). */
export function growSel(mesh, mode, ids) {
    const verts = selVertices(mesh, mode, ids);
    const grown = new Set(verts);
    for (const face of mesh.f) if (face.some((i) => verts.has(i))) for (const i of face) grown.add(i);
    if (mode === "vertex") return [...grown].sort((a, b) => a - b);
    if (mode === "face") return mesh.f.map((face, fi) => [face, fi]).filter(([face]) => face.some((i) => verts.has(i))).map(([, fi]) => fi);
    return meshEdges(mesh).filter(([a, b]) => grown.has(a) && grown.has(b)).map(([a, b]) => edgeKey(a, b));
}

/** The middle of what a selection moves (the mean of its vertices). */
export function selCentroid(mesh, mode, ids) {
    const verts = selVertices(mesh, mode, ids);
    if (!verts.size) return null;
    const c = [0, 0, 0];
    for (const i of verts) { c[0] += mesh.v[i][0]; c[1] += mesh.v[i][1]; c[2] += mesh.v[i][2]; }
    return mul(c, 1 / verts.size);
}

/** The faces a selection stands for, when an operation works on faces. */
export function selFaces(mesh, mode, ids) {
    return mode === "face" ? pruneSel(mesh, "face", ids) : convertSel(mesh, mode, "face", ids);
}

/**
 * The averaged normal of a selection, in the mesh's own space (a unit [x, y, z]),
 * or null when it has none — nothing selected, or the normals cancel out. A face
 * uses its own normal; an edge or a vertex the mean of the faces around it,
 * area-weighted as faceNormalRaw is. This is a component's normal: what a gizmo
 * turned to the selection points along.
 */
export function selNormal(mesh, mode, ids) {
    const n = [0, 0, 0];
    let any = false;
    const add = (fi) => {
        const face = mesh.f[fi];
        if (!face) return;
        const r = faceNormalRaw(mesh, face);
        n[0] += r[0]; n[1] += r[1]; n[2] += r[2];
        any = true;
    };
    if (mode === "face") for (const fi of ids) add(fi);
    else if (mode === "edge") { const ef = edgeFaces(mesh); for (const key of ids) for (const fi of ef.get(key) || []) add(fi); }
    else { const vf = vertexFaces(mesh); for (const i of ids) for (const fi of vf[i] || []) add(fi); }
    if (!any) return null;
    const out = norm(n);
    return out[0] || out[1] || out[2] ? out : null;
}

// ── Taking things away ──────────────────────────────────────────────────────

/** Vertices no face uses are dropped, and the faces renumbered. Returns the old -> new map too. */
export function compact(mesh) {
    const used = new Array(mesh.v.length).fill(false);
    for (const face of mesh.f) for (const i of face) used[i] = true;
    const map = new Array(mesh.v.length).fill(-1);
    const v = [];
    mesh.v.forEach((p, i) => { if (used[i]) { map[i] = v.length; v.push(p.slice()); } });
    const f = mesh.f.map((face) => face.map((i) => map[i]));
    return { mesh: { v, f }, map };
}

/**
 * Delete the selection: vertices take every face that uses them, edges every
 * face that has them, faces themselves. Vertices left with no face go too.
 * Returns {mesh, ids: []} (nothing selected after).
 */
export function deleteSel(mesh, mode, ids) {
    let drop;
    if (mode === "vertex") {
        const vs = new Set(ids);
        drop = (face) => face.some((i) => vs.has(i));
    } else if (mode === "edge") {
        const keys = new Set(ids);
        drop = (face) => face.some((_, k) => keys.has(edgeKey(face[k], face[(k + 1) % face.length])));
    } else {
        const fs = new Set(ids);
        drop = (_, fi) => fs.has(fi);
    }
    // compact() then takes the vertices no face uses any more, a selected one with them.
    const kept = { v: mesh.v, f: mesh.f.filter((face, fi) => !drop(face, fi)) };
    return { mesh: compact(kept).mesh, ids: [] };
}

// ── Moving ──────────────────────────────────────────────────────────────────

/** A copy with the vertices `idx` (iterable) put through `fn(p, i)`. */
export function moveVertices(mesh, idx, fn) {
    const out = copyMesh(mesh);
    for (const i of idx) if (out.v[i]) out.v[i] = fn(out.v[i].slice(), i);
    return out;
}

/** Weld the selected vertices into one at their middle. */
export function mergeVertices(mesh, mode, ids) {
    const verts = [...selVertices(mesh, mode, ids)];
    if (verts.length < 2) return { mesh: copyMesh(mesh), ids: verts };
    const at = selCentroid(mesh, "vertex", verts);
    const keep = Math.min(...verts);
    const into = new Set(verts);
    const out = copyMesh(mesh);
    out.v[keep] = at;
    out.f = out.f.map((face) => tidyFace(face.map((i) => (into.has(i) ? keep : i)))).filter(Boolean);
    const { mesh: m, map } = compact(out);
    return { mesh: m, ids: map[keep] >= 0 ? [map[keep]] : [] };
}

/** Faces turned round: what was their back is their front. */
export function flipFaces(mesh, faces) {
    const fs = new Set(faces);
    const out = copyMesh(mesh);
    out.f = out.f.map((face, fi) => (fs.has(fi) ? [face[0], ...face.slice(1).reverse()] : face));
    return out;
}

// ── Regions: extrude and inset ──────────────────────────────────────────────

/** The faces of `region` split into groups that touch (share an edge). */
function regionsOf(mesh, region, individual) {
    if (individual) return region.map((fi) => [fi]);
    const inR = new Set(region);
    const ef = edgeFaces(mesh);
    const seen = new Set(), groups = [];
    for (const start of region) {
        if (seen.has(start)) continue;
        const group = [], stack = [start];
        seen.add(start);
        while (stack.length) {
            const fi = stack.pop();
            group.push(fi);
            const face = mesh.f[fi];
            for (let k = 0; k < face.length; k++) {
                for (const o of ef.get(edgeKey(face[k], face[(k + 1) % face.length])) || []) {
                    if (inR.has(o) && !seen.has(o)) { seen.add(o); stack.push(o); }
                }
            }
        }
        groups.push(group);
    }
    return groups;
}

/** A region's boundary as directed edges [a, b, face], as the region's faces wind them. */
function regionBoundary(mesh, group) {
    const count = new Map();
    for (const fi of group) {
        const face = mesh.f[fi];
        for (let k = 0; k < face.length; k++) {
            const key = edgeKey(face[k], face[(k + 1) % face.length]);
            count.set(key, (count.get(key) || 0) + 1);
        }
    }
    const out = [];
    for (const fi of group) {
        const face = mesh.f[fi];
        for (let k = 0; k < face.length; k++) {
            const a = face[k], b = face[(k + 1) % face.length];
            if (count.get(edgeKey(a, b)) === 1) out.push([a, b, fi]);
        }
    }
    return out;
}

/**
 * Extrude faces: each region (faces that touch, or every face on its own with
 * `individual`) is lifted `distance` along its vertices' averaged normals, and
 * walls join its old border to the new one. The extruded faces keep their
 * indices (so they stay selected); the walls are added at the end.
 * Returns {mesh, ids: the faces, walls: [new face indices]}.
 */
export function extrudeFaces(mesh, faces, distance = 0, { individual = false } = {}) {
    const out = copyMesh(mesh);
    const region = [...new Set(faces)].filter((fi) => mesh.f[fi]);
    const walls = [];
    for (const group of regionsOf(mesh, region, individual)) {
        // The direction each vertex goes: the mean of its region faces' normals.
        const dir = new Map();
        for (const fi of group) {
            const n = faceNormal(mesh, mesh.f[fi]);
            for (const i of mesh.f[fi]) dir.set(i, add(dir.get(i) || [0, 0, 0], n));
        }
        const boundary = regionBoundary(mesh, group);
        const onBorder = new Set();
        for (const [a, b] of boundary) { onBorder.add(a); onBorder.add(b); }
        const moved = new Map();          // old vertex -> its vertex on the extruded faces
        for (const [i, d] of dir) {
            // Keep the walls straight: a corner shared by faces at an angle goes out by the
            // distance along each of them, not less (distance / cos of the spread).
            const n = norm(d);
            let k = 1;
            for (const fi of group) if (mesh.f[fi].includes(i)) k = Math.min(k, Math.max(0.25, dot(n, faceNormal(mesh, mesh.f[fi]))));
            const p = add(mesh.v[i], mul(n, distance / k));
            // With `individual`, a vertex shared by two of the faces is a border
            // vertex of each, so it gets a copy per face (dir is per group).
            if (onBorder.has(i)) { moved.set(i, out.v.length); out.v.push(p); }
            else { out.v[i] = p; moved.set(i, i); }
        }
        for (const fi of group) out.f[fi] = mesh.f[fi].map((i) => moved.get(i));
        for (const [a, b] of boundary) {
            walls.push(out.f.length);
            out.f.push([a, b, moved.get(b), moved.get(a)]);
        }
    }
    return { mesh: out, ids: region, walls };
}

/**
 * Inset faces: each region's border is drawn in by `amount` (a distance, in
 * the faces' own planes), and the ring between old and new border becomes
 * faces of its own. The inset faces keep their indices.
 */
export function insetFaces(mesh, faces, amount = 0.1, { individual = false } = {}) {
    const out = copyMesh(mesh);
    const region = [...new Set(faces)].filter((fi) => mesh.f[fi]);
    const ring = [];
    for (const group of regionsOf(mesh, region, individual)) {
        const boundary = regionBoundary(mesh, group);
        // Each border vertex goes inwards along the bisector of its two border edges.
        const inward = new Map();          // vertex -> [sum of inward unit vectors, list]
        for (const [a, b, fi] of boundary) {
            const n = faceNormal(mesh, mesh.f[fi]);
            const e = norm(sub(mesh.v[b], mesh.v[a]));
            const inn = norm(cross(n, e));
            for (const i of [a, b]) {
                const s = inward.get(i) || { sum: [0, 0, 0], list: [] };
                s.sum = add(s.sum, inn);
                s.list.push(inn);
                inward.set(i, s);
            }
        }
        const moved = new Map();
        for (const [i, s] of inward) {
            const m = norm(s.sum);
            // A corner moves further than an edge so the new border stays parallel to the old.
            let c = 1;
            for (const inn of s.list) c = Math.min(c, Math.max(0.2, dot(m, inn)));
            moved.set(i, out.v.length);
            out.v.push(add(mesh.v[i], mul(m, amount / c)));
        }
        for (const fi of group) out.f[fi] = mesh.f[fi].map((i) => (moved.has(i) ? moved.get(i) : i));
        for (const [a, b] of boundary) {
            ring.push(out.f.length);
            out.f.push([a, b, moved.get(b), moved.get(a)]);
        }
    }
    return { mesh: out, ids: region, ring };
}

// ── Shapes to start from ────────────────────────────────────────────────────

/**
 * The editable mesh of a built-in shape, the same size and the same way up as
 * the shape the viewer draws (imageViewer_model3d.js _primitiveGeometry): a
 * one-unit box, a half-unit radius, a 1 x 1 plane lying flat, the torus in the
 * XY plane. Fewer sides than the drawn shape: a mesh to model from, not to
 * look smooth.
 */
export function meshFromPrimitive(type, opts = {}) {
    const v = [], f = [];
    const P = (x, y, z) => { v.push([x, y, z]); return v.length - 1; };
    const h = 0.5;
    switch (type) {
        case "plane": {
            const n = Math.max(1, Math.trunc(opts.divisions || 1));
            const id = [];
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) id.push(P(-h + i / n, 0, -h + j / n));
            const at = (i, j) => id[j * (n + 1) + i];
            // Front is +Y: (x, -z) counter-clockwise seen from above.
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) f.push([at(i, j + 1), at(i + 1, j + 1), at(i + 1, j), at(i, j)]);
            break;
        }
        case "cylinder":
        case "cone": {
            const n = Math.max(3, Math.trunc(opts.sides || 16));
            const cone = type === "cone";
            const bottom = [], top = [];
            for (let k = 0; k < n; k++) {
                const a = (k / n) * Math.PI * 2;
                // three.js starts its circle at +Z and goes towards +X.
                bottom.push(P(Math.sin(a) * h, -h, Math.cos(a) * h));
            }
            if (cone) {
                const apex = P(0, h, 0);
                for (let k = 0; k < n; k++) f.push([bottom[k], bottom[(k + 1) % n], apex]);
            } else {
                for (let k = 0; k < n; k++) {
                    const a = (k / n) * Math.PI * 2;
                    top.push(P(Math.sin(a) * h, h, Math.cos(a) * h));
                }
                for (let k = 0; k < n; k++) f.push([bottom[k], bottom[(k + 1) % n], top[(k + 1) % n], top[k]]);
                f.push(top.slice());
            }
            f.push(bottom.slice().reverse());
            break;
        }
        case "sphere": {
            const seg = Math.max(3, Math.trunc(opts.sides || 16));
            const rings = Math.max(2, Math.trunc(opts.rings || 8));
            const north = P(0, h, 0);
            const rows = [];
            for (let r = 1; r < rings; r++) {
                const t = (r / rings) * Math.PI;
                const row = [];
                for (let k = 0; k < seg; k++) {
                    const a = (k / seg) * Math.PI * 2;
                    row.push(P(Math.sin(t) * Math.sin(a) * h, Math.cos(t) * h, Math.sin(t) * Math.cos(a) * h));
                }
                rows.push(row);
            }
            const south = P(0, -h, 0);
            const first = rows[0], last = rows[rows.length - 1];
            for (let k = 0; k < seg; k++) f.push([north, first[k], first[(k + 1) % seg]]);
            for (let r = 0; r + 1 < rows.length; r++) {
                const a = rows[r], b = rows[r + 1];
                for (let k = 0; k < seg; k++) f.push([a[k], b[k], b[(k + 1) % seg], a[(k + 1) % seg]]);
            }
            for (let k = 0; k < seg; k++) f.push([last[(k + 1) % seg], last[k], south]);
            break;
        }
        case "torus": {
            const R0 = 0.35, r0 = 0.15;
            const seg = Math.max(3, Math.trunc(opts.sides || 24));
            const tube = Math.max(3, Math.trunc(opts.rings || 12));
            const id = [];
            for (let j = 0; j < seg; j++) {
                const u = (j / seg) * Math.PI * 2;
                for (let i = 0; i < tube; i++) {
                    const w = (i / tube) * Math.PI * 2;
                    id.push(P((R0 + r0 * Math.cos(w)) * Math.cos(u), (R0 + r0 * Math.cos(w)) * Math.sin(u), r0 * Math.sin(w)));
                }
            }
            const at = (j, i) => id[(j % seg) * tube + (i % tube)];
            for (let j = 0; j < seg; j++) for (let i = 0; i < tube; i++) f.push([at(j, i), at(j + 1, i), at(j + 1, i + 1), at(j, i + 1)]);
            break;
        }
        default: {
            // box: eight corners, six quads facing out
            const c = [];
            for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) c.push(P(x, y, z));
            const at = (x, y, z) => c[(x ? 4 : 0) + (y ? 2 : 0) + (z ? 1 : 0)];
            f.push([at(1, 0, 0), at(1, 1, 0), at(1, 1, 1), at(1, 0, 1)]);     // +X
            f.push([at(0, 0, 0), at(0, 0, 1), at(0, 1, 1), at(0, 1, 0)]);     // -X
            f.push([at(0, 1, 0), at(0, 1, 1), at(1, 1, 1), at(1, 1, 0)]);     // +Y
            f.push([at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1)]);     // -Y
            f.push([at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1)]);     // +Z
            f.push([at(0, 0, 0), at(0, 1, 0), at(1, 1, 0), at(1, 0, 0)]);     // -Z
        }
    }
    return { v, f };
}

/**
 * Triangles (a flat list of positions, three numbers a corner, three corners
 * a triangle - what a three.js geometry holds) as a mesh, with corners that
 * lie on one another welded (within `tol`), so it can be edited as one piece.
 */
export function meshFromTriangles(positions, tol = 1e-5) {
    const v = [], f = [];
    const at = new Map();
    const key = (x, y, z) => `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
    const corner = (o) => {
        const x = positions[o], y = positions[o + 1], z = positions[o + 2];
        const k = key(x, y, z);
        let i = at.get(k);
        if (i === undefined) { i = v.length; at.set(k, i); v.push([x, y, z]); }
        return i;
    };
    for (let o = 0; o + 8 < positions.length; o += 9) {
        const face = tidyFace([corner(o), corner(o + 3), corner(o + 6)]);
        if (face) f.push(face);
    }
    return { v, f };
}
