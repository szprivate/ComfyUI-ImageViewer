// imageViewer_meshModel.js
// Modeling, part 3: subdivision surfaces, mirror / symmetrize, booleans and
// UV projections, on the working mesh of imageViewer_meshData.js.
//
// Pure: no three.js, no DOM (tests/test_mesh_model.mjs). Clean-room, written
// from the published geometry: Catmull and Clark's 1978 subdivision rules
// (with the usual crease rule on open borders), and set operations on solids
// through binary space partitioning trees (Thibault and Naylor, 1987).

import { copyMesh, faceNormalRaw, faceCentroid, edgeKey, edgeEnds, meshEdges, compact, convertSel, allOf, pruneSel } from "./imageViewer_meshData.js";
import { selectLoops } from "./imageViewer_meshOps.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const MAX_SUBDIV = 3;
export const AXES = ["x", "y", "z"];
export const UV_TYPES = ["none", "box", "planar", "cylinder", "sphere"];
export const BOOLEAN_OPS = ["union", "subtract", "intersect"];

/** The display subdivision level an item may keep: 0..MAX_SUBDIV. */
export function cleanSubdiv(v) {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.min(MAX_SUBDIV, Math.max(0, n)) : 0;
}

/** An item's UV projection: {type, axis, scale, checker}, or null for none. */
export function cleanUv(raw) {
    if (!raw || typeof raw !== "object" || !UV_TYPES.includes(raw.type) || raw.type === "none") return null;
    const s = Number(raw.scale);
    return {
        type: raw.type,
        axis: AXES.includes(raw.axis) ? raw.axis : "y",
        scale: Number.isFinite(s) && s > 0 ? Math.min(1000, s) : 1,
        checker: raw.checker === true,
    };
}

// ── Subdivision ─────────────────────────────────────────────────────────────

/**
 * One or more rounds of Catmull-Clark subdivision. Every face becomes as many
 * quads as it has corners; an open border is kept as a curve of its own (its
 * points move only along it), so a plane stays flat and its edge stays put.
 */
export function subdivide(mesh, levels = 1) {
    let m = mesh;
    const n = Math.max(0, Math.min(MAX_SUBDIV + 2, Math.trunc(levels) || 0));
    for (let k = 0; k < n; k++) m = subdivideOnce(m);
    return m === mesh ? copyMesh(mesh) : m;
}

function subdivideOnce(mesh) {
    const V = mesh.v, F = mesh.f;
    const facePt = F.map((face) => {
        const c = [0, 0, 0];
        for (const i of face) { c[0] += V[i][0]; c[1] += V[i][1]; c[2] += V[i][2]; }
        return mul(c, 1 / face.length);
    });
    // Edges and the faces either side of them.
    const edgeFacesOf = new Map();
    F.forEach((face, fi) => {
        for (let k = 0; k < face.length; k++) {
            const key = edgeKey(face[k], face[(k + 1) % face.length]);
            let l = edgeFacesOf.get(key);
            if (!l) edgeFacesOf.set(key, (l = []));
            l.push(fi);
        }
    });
    const out = { v: [], f: [] };
    // New vertex points first: same indices as the old ones.
    const vFaces = V.map(() => []), vEdges = V.map(() => []);
    F.forEach((face, fi) => { for (const i of face) vFaces[i].push(fi); });
    for (const key of edgeFacesOf.keys()) { const [a, b] = edgeEnds(key); vEdges[a].push(key); vEdges[b].push(key); }
    const border = (key) => edgeFacesOf.get(key).length !== 2;
    for (let i = 0; i < V.length; i++) {
        const P = V[i];
        const edges = vEdges[i];
        if (!edges.length) { out.v.push(P.slice()); continue; }
        const open = edges.filter(border);
        if (open.length >= 2) {
            // On a border: 3/4 of itself and 1/8 of each of its two border neighbours.
            // A corner where borders meet, or of a single face (a plane's corner): stays.
            if (open.length > 2 || edges.length === 2) { out.v.push(P.slice()); continue; }
            const [a, b] = open.map((k) => { const [x, y] = edgeEnds(k); return V[x === i ? y : x]; });
            out.v.push(add(mul(P, 0.75), mul(add(a, b), 0.125)));
            continue;
        }
        const nF = vFaces[i].length;
        const Fm = mul(vFaces[i].reduce((s, fi) => add(s, facePt[fi]), [0, 0, 0]), 1 / nF);
        const Rm = mul(edges.reduce((s, k) => { const [a, b] = edgeEnds(k); return add(s, mul(add(V[a], V[b]), 0.5)); }, [0, 0, 0]), 1 / edges.length);
        const nE = edges.length;
        out.v.push(mul(add(add(Fm, mul(Rm, 2)), mul(P, nE - 3)), 1 / nE));
    }
    const facePtIdx = facePt.map((p) => { out.v.push(p); return out.v.length - 1; });
    const edgePtIdx = new Map();
    for (const [key, fs] of edgeFacesOf) {
        const [a, b] = edgeEnds(key);
        const mid = mul(add(V[a], V[b]), 0.5);
        const p = fs.length === 2 ? mul(add(add(V[a], V[b]), add(facePt[fs[0]], facePt[fs[1]])), 0.25) : mid;
        out.v.push(p);
        edgePtIdx.set(key, out.v.length - 1);
    }
    F.forEach((face, fi) => {
        const n = face.length;
        for (let k = 0; k < n; k++) {
            const prev = face[(k + n - 1) % n], cur = face[k], next = face[(k + 1) % n];
            out.f.push([cur, edgePtIdx.get(edgeKey(cur, next)), facePtIdx[fi], edgePtIdx.get(edgeKey(prev, cur))]);
        }
    });
    return out;
}

// ── Mirror ──────────────────────────────────────────────────────────────────

/**
 * The mesh and its reflection across the plane through the origin square to
 * `axis`, as one mesh, the vertices that lie on the plane (within `tol`)
 * shared. `symmetrize` first throws away the half on the other side of
 * `side` (faces reaching across are taken out) and lays what touches the plane
 * on it, so the two halves meet exactly.
 */
export function mirrorMesh(mesh, axis = "x", { symmetrize = false, side = 1, tol = 1e-4 } = {}) {
    const ax = Math.max(0, AXES.indexOf(axis));
    let m = copyMesh(mesh);
    if (symmetrize) {
        const s = side < 0 ? -1 : 1;
        m.f = m.f.filter((face) => face.every((i) => m.v[i][ax] * s >= -tol));
        m = compact(m).mesh;
    }
    const n = m.v.length;
    const onPlane = m.v.map((p) => Math.abs(p[ax]) <= tol);
    for (let i = 0; i < n; i++) if (onPlane[i]) m.v[i][ax] = 0;
    const twin = m.v.map((p, i) => {
        if (onPlane[i]) return i;
        const q = p.slice(); q[ax] = -q[ax];
        m.v.push(q);
        return m.v.length - 1;
    });
    const faces = m.f.length;
    for (let fi = 0; fi < faces; fi++) {
        const face = m.f[fi];
        // Reflected, its corners in the other order so it still faces out.
        const mirrored = face.map((i) => twin[i]).reverse();
        if (face.every((i) => onPlane[i])) continue;          // lying on the plane: once is enough
        m.f.push(mirrored);
    }
    return m;
}

// ── Booleans through BSP trees ──────────────────────────────────────────────

const EPS = 1e-6;

function polyOf(points) {
    // The plane of a convex polygon: the normal from Newell's sum (robust to a
    // nearly-straight first three corners), the offset from its centroid.
    const n = [0, 0, 0];
    for (let k = 0; k < points.length; k++) {
        const a = points[k], b = points[(k + 1) % points.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const nn = norm(n);
    const c = mul(points.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / points.length);
    return { pts: points, n: nn, w: dot(nn, c) };
}

function flipPoly(p) { return { pts: p.pts.slice().reverse(), n: mul(p.n, -1), w: -p.w }; }

/** Sort one polygon against a plane into the four lists. */
function splitBy(plane, poly, cofront, coback, front, back) {
    const types = [];
    let all = 0;
    for (const p of poly.pts) {
        const d = dot(plane.n, p) - plane.w;
        const t = d < -EPS ? 2 : d > EPS ? 1 : 0;           // 1 front, 2 back, 0 on
        all |= t;
        types.push(t);
    }
    if (all === 0) { (dot(plane.n, poly.n) > 0 ? cofront : coback).push(poly); return; }
    if (all === 1) { front.push(poly); return; }
    if (all === 2) { back.push(poly); return; }
    const f = [], b = [];
    const n = poly.pts.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ti = types[i], tj = types[j], vi = poly.pts[i], vj = poly.pts[j];
        if (ti !== 2) f.push(vi);
        if (ti !== 1) b.push(ti !== 2 ? vi.slice() : vi);
        if ((ti | tj) === 3) {
            const t = (plane.w - dot(plane.n, vi)) / dot(plane.n, sub(vj, vi));
            const v = lerp(vi, vj, t);
            f.push(v); b.push(v.slice());
        }
    }
    if (f.length >= 3) front.push({ pts: f, n: poly.n, w: poly.w });
    if (b.length >= 3) back.push({ pts: b, n: poly.n, w: poly.w });
}

class Bsp {
    constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }

    /** Every node of the tree, without recursion (a big mesh makes a deep tree). */
    nodes() {
        const out = [], stack = [this];
        while (stack.length) { const n = stack.pop(); out.push(n); if (n.front) stack.push(n.front); if (n.back) stack.push(n.back); }
        return out;
    }

    invert() {
        for (const n of this.nodes()) {
            n.polys = n.polys.map(flipPoly);
            if (n.plane) n.plane = { n: mul(n.plane.n, -1), w: -n.plane.w };
            const t = n.front; n.front = n.back; n.back = t;
        }
    }

    /** What of `polys` lies outside the solid this tree bounds. */
    clipPolys(polys) {
        let out = [];
        const stack = [[this, polys]];
        while (stack.length) {
            const [node, list] = stack.pop();
            if (!node.plane) { out = out.concat(list); continue; }
            const f = [], b = [];
            for (const p of list) splitBy(node.plane, p, f, b, f, b);
            if (node.front) stack.push([node.front, f]); else out = out.concat(f);
            if (node.back) stack.push([node.back, b]);
            // Behind a leaf is inside: dropped.
        }
        return out;
    }

    clipTo(tree) { for (const n of this.nodes()) n.polys = tree.clipPolys(n.polys); }

    all() { let out = []; for (const n of this.nodes()) out = out.concat(n.polys); return out; }

    build(polys) {
        const stack = [[this, polys]];
        while (stack.length) {
            const [node, list] = stack.pop();
            if (!list.length) continue;
            if (!node.plane) node.plane = { n: list[0].n, w: list[0].w };
            const f = [], b = [];
            for (const p of list) splitBy(node.plane, p, node.polys, node.polys, f, b);
            if (f.length) { if (!node.front) node.front = new Bsp(); stack.push([node.front, f]); }
            if (b.length) { if (!node.back) node.back = new Bsp(); stack.push([node.back, b]); }
        }
    }
}

function meshPolys(mesh) {
    const out = [];
    for (const face of mesh.f) {
        // Split into triangles where a face is not flat or not convex: a BSP wants flat convex polygons.
        const pts = face.map((i) => mesh.v[i].slice());
        if (pts.length === 3 || flatConvex(pts)) out.push(polyOf(pts));
        else for (let k = 1; k + 1 < pts.length; k++) out.push(polyOf([pts[0].slice(), pts[k].slice(), pts[k + 1].slice()]));
    }
    return out.filter((p) => len(p.n) > 0.5);
}

function flatConvex(pts) {
    const pl = polyOf(pts);
    if (pts.some((p) => Math.abs(dot(pl.n, p) - pl.w) > 1e-6)) return false;
    for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length], c = pts[(k + 2) % pts.length];
        if (dot(cross(sub(b, a), sub(c, b)), pl.n) < -1e-12) return false;
    }
    return true;
}

/** Polygons back into a mesh, corners that coincide (within `tol`) welded. */
function polysToMesh(polys, tol = 1e-5) {
    const v = [], f = [];
    const at = new Map();
    const id = (p) => {
        const k = `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
        let i = at.get(k);
        if (i === undefined) { i = v.length; at.set(k, i); v.push(p.slice()); }
        return i;
    };
    for (const p of polys) {
        const face = [];
        for (const q of p.pts) { const i = id(q); if (face[face.length - 1] !== i) face.push(i); }
        while (face.length > 1 && face[0] === face[face.length - 1]) face.pop();
        if (new Set(face).size >= 3) f.push(face);
    }
    return { v, f };
}

/**
 * Union, subtract (a less b) or intersect of two closed meshes in one space.
 * Faces come back as the pieces the cut leaves (flat, convex); the mesh is
 * welded where pieces meet. Meshes that are not closed give what the cut
 * makes of them, which may be open.
 */
export function booleanMesh(a, b, op = "union") {
    const A = new Bsp(meshPolys(a)), B = new Bsp(meshPolys(b));
    if (op === "subtract") {
        A.invert(); A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.all()); A.invert();
    } else if (op === "intersect") {
        A.invert(); B.clipTo(A); B.invert(); A.clipTo(B); B.clipTo(A); A.build(B.all()); A.invert();
    } else {
        A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.all());
    }
    return closeTJunctions(polysToMesh(A.all()));
}

/**
 * Where one face's edge runs past a corner of its neighbours (a T-junction,
 * which a cut leaves where it split one side and not the other), put that
 * corner into the edge too, so the mesh is closed again.
 */
export function closeTJunctions(mesh, tol = 1e-7) {
    const m = copyMesh(mesh);
    for (let round = 0; round < 4; round++) {
        const dir = new Set();
        m.f.forEach((face) => { for (let k = 0; k < face.length; k++) dir.add(`${face[k]}>${face[(k + 1) % face.length]}`); });
        const open = [];
        m.f.forEach((face, fi) => {
            for (let k = 0; k < face.length; k++) {
                const a = face[k], b = face[(k + 1) % face.length];
                if (!dir.has(`${b}>${a}`)) open.push([fi, a, b]);
            }
        });
        if (!open.length) break;
        const cand = [...new Set(open.flatMap(([, a, b]) => [a, b]))];
        let changed = false;
        const inserts = new Map();          // "fi:a" -> sorted corners to put after a
        for (const [fi, a, b] of open) {
            const A = m.v[a], B = m.v[b], d = sub(B, A), L2 = dot(d, d);
            if (L2 < 1e-24) continue;
            const on = [];
            for (const c of cand) {
                if (c === a || c === b) continue;
                const t = dot(sub(m.v[c], A), d) / L2;
                if (t <= 1e-9 || t >= 1 - 1e-9) continue;
                const q = add(A, mul(d, t));
                if (len(sub(q, m.v[c])) <= tol * Math.max(1, Math.sqrt(L2))) on.push([t, c]);
            }
            if (on.length) { on.sort((x, y) => x[0] - y[0]); inserts.set(`${fi}:${a}`, on.map((x) => x[1])); changed = true; }
        }
        if (!changed) break;
        m.f = m.f.map((face, fi) => {
            const out = [];
            for (const i of face) { out.push(i); const add2 = inserts.get(`${fi}:${i}`); if (add2) out.push(...add2); }
            return out;
        });
    }
    return m;
}

/** A mesh with every vertex put through a column-major 4x4 matrix (three.js's `elements`). */
export function transformMesh(mesh, m) {
    const out = copyMesh(mesh);
    out.v = mesh.v.map(([x, y, z]) => {
        const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
        return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
    });
    // A matrix that turns the mesh inside out (a negative scale) flips its faces back.
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (det < 0) out.f = out.f.map((face) => face.slice().reverse());
    return out;
}

/** Merge touching coplanar faces that a boolean left in pieces back into one face where that gives a simple ring. */
export function dissolveCoplanar(mesh, angleDeg = 0.5) {
    const cosT = Math.cos((angleDeg * Math.PI) / 180);
    const m = copyMesh(mesh);
    const normals = m.f.map((face) => norm(faceNormalRaw(m, face)));
    // Group faces by flood fill across edges whose two faces are coplanar.
    const edgeFacesOf = new Map();
    m.f.forEach((face, fi) => {
        for (let k = 0; k < face.length; k++) {
            const key = edgeKey(face[k], face[(k + 1) % face.length]);
            let l = edgeFacesOf.get(key); if (!l) edgeFacesOf.set(key, (l = [])); l.push(fi);
        }
    });
    const group = new Array(m.f.length).fill(-1);
    let g = 0;
    for (let s = 0; s < m.f.length; s++) {
        if (group[s] >= 0) continue;
        const stack = [s]; group[s] = g;
        const off = dot(normals[s], m.v[m.f[s][0]]);
        while (stack.length) {
            const fi = stack.pop(), face = m.f[fi];
            for (let k = 0; k < face.length; k++) {
                const l = edgeFacesOf.get(edgeKey(face[k], face[(k + 1) % face.length]));
                if (!l || l.length !== 2) continue;
                const o = l[0] === fi ? l[1] : l[0];
                if (group[o] >= 0 || dot(normals[o], normals[s]) < cosT) continue;
                if (Math.abs(dot(normals[s], m.v[m.f[o][0]]) - off) > 1e-5) continue;
                group[o] = g; stack.push(o);
            }
        }
        g++;
    }
    const out = [];
    for (let gi = 0; gi < g; gi++) {
        const faces = [];
        group.forEach((x, fi) => { if (x === gi) faces.push(fi); });
        if (faces.length === 1) { out.push(m.f[faces[0]]); continue; }
        // The group's outline: its directed edges whose reverse is not in the group.
        const dir = new Map();
        for (const fi of faces) {
            const face = m.f[fi];
            for (let k = 0; k < face.length; k++) dir.set(`${face[k]}>${face[(k + 1) % face.length]}`, [face[k], face[(k + 1) % face.length]]);
        }
        const next = new Map();
        let ok = true;
        for (const [key, [a, b]] of dir) {
            if (dir.has(`${b}>${a}`)) continue;
            if (next.has(a)) { ok = false; break; }
            next.set(a, b);
        }
        let ring = null;
        if (ok && next.size >= 3) {
            const start = next.keys().next().value;
            ring = [start];
            let cur = next.get(start), guard = next.size + 1;
            while (cur !== start && cur !== undefined && guard-- > 0) { ring.push(cur); cur = next.get(cur); }
            if (cur !== start || ring.length !== next.size) ring = null;
        }
        if (ring) {
            // Drop corners that lie straight between their neighbours (the cut's extra points on an edge).
            const keep = ring.filter((i, k) => {
                const a = m.v[ring[(k + ring.length - 1) % ring.length]], b = m.v[i], c = m.v[ring[(k + 1) % ring.length]];
                return len(cross(sub(b, a), sub(c, b))) > 1e-9 * Math.max(1, len(sub(c, a)) ** 2);
            });
            out.push(keep.length >= 3 ? keep : ring);
        } else {
            for (const fi of faces) out.push(m.f[fi]);
        }
    }
    m.f = out;
    // A corner dropped from one face may still be named by a neighbour across a coplanar join: keep only what faces use.
    return compact(m).mesh;
}

// ── UVs ─────────────────────────────────────────────────────────────────────

/**
 * Texture coordinates for every triangle corner of `tris` (meshTriangles'
 * answer), by projection: box (each face from the axis it faces most),
 * planar (along `axis`), cylinder and sphere (round `axis`). `scale` is
 * scene units per repeat. A seam of the cylinder and sphere is mended per
 * triangle, so no triangle stretches across the whole texture.
 */
export function projectUVs(mesh, tris, uv) {
    const o = cleanUv(uv);
    const n = tris.tris.length;
    const out = new Float32Array(n * 6);
    if (!o) return out;
    const ax = AXES.indexOf(o.axis);
    const [u0, v0] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
    const s = 1 / o.scale;
    const fn = mesh.f.map((face) => faceNormalRaw(mesh, face));
    for (let ti = 0; ti < n; ti++) {
        const t = tris.tris[ti];
        const corners = [];
        for (let c = 0; c < 3; c++) {
            const p = mesh.v[t[c]];
            let u = 0, v = 0;
            if (o.type === "planar") { u = p[u0] * s + 0.5; v = p[v0] * s + 0.5; }
            else if (o.type === "box") {
                const nn = fn[tris.triFace[ti]];
                const a = Math.abs(nn[0]), b = Math.abs(nn[1]), d = Math.abs(nn[2]);
                if (a >= b && a >= d) { u = (nn[0] > 0 ? -p[2] : p[2]) * s + 0.5; v = p[1] * s + 0.5; }
                else if (b >= d) { u = p[0] * s + 0.5; v = (nn[1] > 0 ? -p[2] : p[2]) * s + 0.5; }
                else { u = (nn[2] > 0 ? p[0] : -p[0]) * s + 0.5; v = p[1] * s + 0.5; }
            } else if (o.type === "cylinder") {
                u = Math.atan2(p[u0], p[v0]) / (2 * Math.PI) + 0.5;
                v = p[ax] * s + 0.5;
            } else {
                const r = Math.hypot(p[0], p[1], p[2]) || 1;
                u = Math.atan2(p[u0], p[v0]) / (2 * Math.PI) + 0.5;
                v = Math.acos(Math.max(-1, Math.min(1, p[ax] / r))) / Math.PI;
                v = 1 - v;
            }
            corners.push([u, v, Math.hypot(p[u0], p[v0]) < 1e-9]);
        }
        if (o.type === "cylinder" || o.type === "sphere") {
            // Mend the seam: corners more than half a turn from the first off the axis come round.
            const ref = corners.find((c) => !c[2]) || corners[0];
            for (const c of corners) {
                if (c === ref || c[2]) continue;
                if (c[0] - ref[0] > 0.5) c[0] -= 1;
                else if (ref[0] - c[0] > 0.5) c[0] += 1;
            }
            // A corner on the axis (a pole) has no turn of its own: it takes its neighbours' middle.
            const off = corners.filter((c) => !c[2]);
            for (const c of corners) if (c[2] && off.length) c[0] = off.reduce((t, q) => t + q[0], 0) / off.length;
        }
        for (let c = 0; c < 3; c++) { out[ti * 6 + c * 2] = corners[c][0]; out[ti * 6 + c * 2 + 1] = corners[c][1]; }
    }
    return out;
}

/** Edges of a mesh, for tests and callers that want a count. */
export function edgeCount(mesh) { return meshEdges(mesh).length; }

// ── Selections by description (the agent's) ────────────────────────────────

const SIDES = { "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1] };

/**
 * A selection described in words and numbers, as ids of `mode`:
 *   "all" (or nothing)            everything
 *   [ids]                         vertex / face indices, or edge keys "a-b"
 *   {side: "+y", within: 30}      faces whose normal is within `within` degrees of a direction (or [x, y, z])
 *   {along: "y", within: 10}      edges running within `within` degrees of an axis
 *   {box: [[x0, y0, z0], [x1, y1, z1]]}   vertices inside a box of the mesh's own space
 * plus `expand: "loop" | "ring"` (edges) and `grow` (rings of neighbours), on any of them.
 * What is described in one kind is carried into `mode` (convertSel).
 */
export function resolveSelection(mesh, mode, spec) {
    if (spec === undefined || spec === null || spec === "all") return allOf(mesh, mode);
    if (Array.isArray(spec)) {
        const ids = mode === "edge" ? spec.map(String) : spec.map((x) => Math.trunc(Number(x)));
        return pruneSel(mesh, mode, ids);
    }
    if (typeof spec !== "object") return [];
    let from = "vertex", ids = [];
    if (spec.side !== undefined) {
        const d = Array.isArray(spec.side) ? normOf(spec.side) : SIDES[String(spec.side).toLowerCase()];
        if (!d) return [];
        const c = Math.cos(((Number.isFinite(Number(spec.within)) ? Number(spec.within) : 30) * Math.PI) / 180);
        from = "face";
        mesh.f.forEach((face, fi) => { if (dot(norm(faceNormalRaw(mesh, face)), d) >= c - 1e-9) ids.push(fi); });
    } else if (spec.along !== undefined) {
        const d = Array.isArray(spec.along) ? normOf(spec.along) : SIDES[`+${String(spec.along).toLowerCase().replace(/^[+-]/, "")}`];
        if (!d) return [];
        const c = Math.cos(((Number.isFinite(Number(spec.within)) ? Number(spec.within) : 10) * Math.PI) / 180);
        from = "edge";
        for (const [a, b] of meshEdges(mesh)) if (Math.abs(dot(norm(sub(mesh.v[b], mesh.v[a])), d)) >= c - 1e-9) ids.push(edgeKey(a, b));
    } else if (Array.isArray(spec.box) && spec.box.length === 2) {
        const [lo, hi] = spec.box.map((p) => [0, 1, 2].map((k) => Number(p[k]) || 0));
        const mn = lo.map((x, k) => Math.min(x, hi[k])), mx = lo.map((x, k) => Math.max(x, hi[k]));
        mesh.v.forEach((p, i) => { if (p.every((x, k) => x >= mn[k] - 1e-9 && x <= mx[k] + 1e-9)) ids.push(i); });
    } else if (Array.isArray(spec.ids)) {
        return resolveSelection(mesh, mode, spec.ids);
    } else {
        return [];
    }
    if (spec.expand === "loop" || spec.expand === "ring") {
        ids = selectLoops(mesh, convertSel(mesh, from, "edge", ids), spec.expand === "ring");
        from = "edge";
    }
    let out = convertSel(mesh, from, mode, ids);
    for (let g = 0; g < Math.min(20, Math.trunc(Number(spec.grow) || 0)); g++) {
        const verts = new Set(convertSel(mesh, mode, "vertex", out));
        for (const face of mesh.f) if (face.some((i) => verts.has(i))) for (const i of face) verts.add(i);
        out = convertSel(mesh, "vertex", mode, [...verts]);
    }
    return out;
}

const normOf = (v) => { const a = [0, 1, 2].map((k) => Number(v[k]) || 0); return len(a) > 1e-12 ? norm(a) : null; };

/** A mesh in a few numbers: counts, box, whether it is closed, how many faces look each way. */
export function describeMesh(mesh) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.v) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const r = (x) => Math.round(x * 1e4) / 1e4;
    const facing = {};
    for (const [name, d] of Object.entries(SIDES)) facing[name] = 0;
    const edges = new Map();
    for (const face of mesh.f) {
        const n = norm(faceNormalRaw(mesh, face));
        let best = null, bd = -2;
        for (const [name, d] of Object.entries(SIDES)) { const x = dot(n, d); if (x > bd) { bd = x; best = name; } }
        if (best) facing[best]++;
        for (let k = 0; k < face.length; k++) { const key = edgeKey(face[k], face[(k + 1) % face.length]); edges.set(key, (edges.get(key) || 0) + 1); }
    }
    let open = 0;
    for (const c of edges.values()) if (c === 1) open++;
    const sides = {};
    for (const face of mesh.f) sides[face.length] = (sides[face.length] || 0) + 1;
    return {
        vertices: mesh.v.length, faces: mesh.f.length, edges: edges.size,
        box: mesh.v.length ? { min: lo.map(r), max: hi.map(r) } : null,
        closed: open === 0, open_edges: open, facing,
        face_sizes: { triangles: sides[3] || 0, quads: sides[4] || 0, ngons: mesh.f.length - (sides[3] || 0) - (sides[4] || 0) },
    };
}

/** The centre of a selection's faces / vertices (mesh space), for moving it. */
export function selectionCentre(mesh, mode, ids) {
    const verts = convertSel(mesh, mode, "vertex", ids);
    if (!verts.length) return null;
    const c = [0, 0, 0];
    for (const i of verts) for (let k = 0; k < 3; k++) c[k] += mesh.v[i][k];
    return c.map((x) => x / verts.length);
}
