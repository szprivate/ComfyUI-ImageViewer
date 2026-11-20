// Modeling, part 2: the operations that work along a mesh's topology - loops
// and rings, loop cut, bevel (chamfer), bridge, fill hole, connect, merge by
// distance - and soft selection's weights. Pure: no DOM, no three.js; meshes
// in imageViewer_meshData.js's working form {v: [[x, y, z]], f: [[i...]]}.
// Every operation returns a new mesh and what is selected after it; nothing is
// changed in place. Written from the geometry itself (clean-room).

import {
    copyMesh, edgeKey, edgeEnds, edgeFaces, vertexFaces, compact, meshEdges, selVertices,
} from "./imageViewer_meshData.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dist = (a, b) => len(sub(a, b));

/** Where the directed edge a -> b is in a face: the index of a, or -1. */
function edgeAt(face, a, b) {
    for (let k = 0; k < face.length; k++) if (face[k] === a && face[(k + 1) % face.length] === b) return k;
    return -1;
}

/** Directed edges that only one face has: the holes' borders. */
function boundaryEdges(mesh) {
    const have = new Set();
    for (const face of mesh.f) for (let k = 0; k < face.length; k++) have.add(`${face[k]}>${face[(k + 1) % face.length]}`);
    const out = [];
    for (const face of mesh.f) {
        for (let k = 0; k < face.length; k++) {
            const a = face[k], b = face[(k + 1) % face.length];
            if (!have.has(`${b}>${a}`)) out.push([a, b]);
        }
    }
    return out;
}

/** The holes as loops of vertices, in the order their faces run along them. */
export function boundaryLoops(mesh) {
    const next = new Map();
    for (const [a, b] of boundaryEdges(mesh)) if (!next.has(a)) next.set(a, b);
    const seen = new Set(), loops = [];
    for (const start of next.keys()) {
        if (seen.has(start)) continue;
        const loop = [];
        let v = start;
        while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
        if (v === start && loop.length >= 3) loops.push(loop);
    }
    return loops;
}

// ── Loops and rings ─────────────────────────────────────────────────────────

/** The quad faces around a vertex and its four neighbours, when it is an ordinary grid vertex. */
function gridVertex(mesh, vf, v) {
    const faces = vf[v];
    if (faces.length !== 4 || faces.some((fi) => mesh.f[fi].length !== 4)) return null;
    const nb = new Set();
    for (const fi of faces) {
        const f = mesh.f[fi], k = f.indexOf(v);
        nb.add(f[(k + 1) % 4]);
        nb.add(f[(k + 3) % 4]);
    }
    return nb.size === 4 ? { faces, nb } : null;
}

/**
 * An edge loop: from an edge, on through every ordinary (four quads) vertex to
 * the edge across from it, both ways, until it closes or meets a pole or a border.
 */
export function edgeLoop(mesh, key) {
    const [a0, b0] = edgeEnds(key);
    const vf = vertexFaces(mesh);
    const out = new Set([edgeKey(a0, b0)]);
    const walk = (from, at) => {
        for (let guard = 0; guard < mesh.v.length + 1; guard++) {
            const g = gridVertex(mesh, vf, at);
            if (!g) return;
            const touching = new Set([from]);
            for (const fi of g.faces) {
                const f = mesh.f[fi];
                if (!f.includes(from)) continue;
                for (const i of f) if (g.nb.has(i)) touching.add(i);
            }
            const nxt = [...g.nb].find((i) => !touching.has(i));
            if (nxt === undefined) return;
            const k = edgeKey(at, nxt);
            if (out.has(k)) return;
            out.add(k);
            from = at;
            at = nxt;
        }
    };
    walk(a0, b0);
    walk(b0, a0);
    return [...out];
}

/**
 * An edge ring: from an edge, across each quad to the edge opposite, both
 * ways. Returned with the quads crossed, each as [face, the directed edge in
 * by which it was entered] - what a loop cut needs.
 */
function ringWalk(mesh, key) {
    const [a0, b0] = edgeEnds(key);
    const ef = edgeFaces(mesh);
    const edges = [[a0, b0]];
    const crossed = [];
    const seenF = new Set();
    let closed = false;
    // `rev`: whether the ring's own direction (the first edge's) runs against
    // the faces' way round: true for the walk the other way from the first edge.
    const go = (a, b, rev) => {
        // (a, b) directed: find a quad with it as a -> b.
        for (let guard = 0; guard < mesh.f.length + 1; guard++) {
            const fi = (ef.get(edgeKey(a, b)) || []).find((x) => !seenF.has(x) && edgeAt(mesh.f[x], a, b) >= 0);
            if (fi === undefined) return;
            const f = mesh.f[fi];
            if (f.length !== 4) return;
            seenF.add(fi);
            const k = edgeAt(f, a, b);
            const c = f[(k + 2) % 4], d = f[(k + 3) % 4];
            crossed.push([fi, a, b]);
            if (edgeKey(c, d) === edgeKey(a0, b0)) { closed = true; return; }
            // Across the quad: d -> c runs the same way round as a -> b.
            edges.push(rev ? [c, d] : [d, c]);
            a = d; b = c;            // the quad beyond has the edge the other way round, as d -> c
        }
    };
    go(a0, b0, false);
    if (!closed) go(b0, a0, true);
    return { edges, crossed, closed };
}

export function edgeRing(mesh, key) {
    return [...new Set(ringWalk(mesh, key).edges.map(([a, b]) => edgeKey(a, b)))];
}

/** Loops (or rings) through every selected edge. */
export function selectLoops(mesh, keys, ring = false) {
    const out = new Set();
    for (const k of keys) for (const e of (ring ? edgeRing(mesh, k) : edgeLoop(mesh, k))) out.add(e);
    return [...out];
}

// ── Loop cut ────────────────────────────────────────────────────────────────

/**
 * Cut a new edge loop across the ring of quads through `key`, at `t` (0..1)
 * along the edges as the first one runs. A face at the ring's ends that is not
 * a quad gets the new vertex on its edge, so the mesh stays closed.
 * Returns {mesh, ids: the new loop's edges}.
 */
export function loopCut(mesh, key, t = 0.5) {
    const out = copyMesh(mesh);
    const { edges, crossed } = ringWalk(mesh, key);
    if (!crossed.length) return { mesh: out, ids: [] };
    const tt = Math.min(0.99, Math.max(0.01, t));
    // A new vertex per ring edge, placed by the ring's own direction.
    const mid = new Map();
    for (const [a, b] of edges) {
        const k = edgeKey(a, b);
        if (mid.has(k)) continue;
        mid.set(k, out.v.length);
        out.v.push(lerp(mesh.v[a], mesh.v[b], tt));
    }
    const cut = new Set(crossed.map(([fi]) => fi));
    const ids = [];
    const newFaces = [];
    for (const [fi, a, b] of crossed) {
        const f = mesh.f[fi], k = edgeAt(f, a, b);
        const c = f[(k + 2) % 4], d = f[(k + 3) % 4];
        const m1 = mid.get(edgeKey(a, b)), m2 = mid.get(edgeKey(c, d));
        if (m1 === undefined || m2 === undefined) continue;
        out.f[fi] = [a, m1, m2, d];
        newFaces.push([m1, b, c, m2]);
        ids.push(edgeKey(m1, m2));
    }
    // Faces beside the ring that share a split edge take the new vertex into their side.
    out.f = out.f.map((face, fi) => {
        if (cut.has(fi)) return face;
        const res = [];
        for (let k = 0; k < face.length; k++) {
            const u = face[k], w = face[(k + 1) % face.length];
            res.push(u);
            const m = mid.get(edgeKey(u, w));
            if (m !== undefined) res.push(m);
        }
        return res;
    });
    out.f.push(...newFaces);
    return { mesh: out, ids: [...new Set(ids)] };
}

// ── Bevel (a chamfer of edges) ──────────────────────────────────────────────

/**
 * Bevel the selected edges by `width`: each edge becomes a face of its own,
 * the faces beside it drawn back along their other edges, the corners where
 * bevelled edges meet closed with a face. One segment (a chamfer).
 * Returns {mesh, ids: the new faces}.
 */
export function bevelEdges(mesh, keys, width = 0.1) {
    const sel = new Set(keys);
    const ef = edgeFaces(mesh);
    // Only edges with a face on each side can be bevelled.
    for (const k of [...sel]) if ((ef.get(k) || []).length !== 2) sel.delete(k);
    if (!sel.size || !(width > 0)) return { mesh: copyMesh(mesh), ids: [] };
    const out = { v: mesh.v.map((p) => p.slice()), f: [] };
    const touched = new Set();
    for (const k of sel) for (const i of edgeEnds(k)) touched.add(i);
    // The corner of face fi at vertex v, as the new vertex index (or v when it stays).
    const corner = new Map();
    // A moved corner lies on an edge (v, toward) of the old mesh: other faces with that edge take it in.
    const onEdge = new Map();     // edgeKey(v, toward) -> [{v, at}]
    const cornerKey = (fi, v) => `${fi}:${v}`;
    mesh.f.forEach((face, fi) => {
        const n = face.length;
        for (let k = 0; k < n; k++) {
            const v = face[k], p = face[(k + n - 1) % n], q = face[(k + 1) % n];
            if (!touched.has(v)) continue;
            const inSel = sel.has(edgeKey(p, v)), outSel = sel.has(edgeKey(v, q));
            if (!inSel && !outSel) continue;
            let at = mesh.v[v].slice();
            // Drawn back along each edge that is not bevelled, never past its middle.
            const along = (to) => { const d = sub(mesh.v[to], mesh.v[v]); return mul(norm(d), Math.min(width, len(d) * 0.49)); };
            if (outSel && !inSel) at = add(at, along(p));
            else if (inSel && !outSel) at = add(at, along(q));
            else at = add(add(at, along(p)), along(q));
            const idx = out.v.length;
            out.v.push(at);
            corner.set(cornerKey(fi, v), idx);
            if (outSel !== inSel) {
                const toward = outSel ? p : q;
                const ek = edgeKey(v, toward);
                if (!sel.has(ek)) {
                    if (!onEdge.has(ek)) onEdge.set(ek, []);
                    onEdge.get(ek).push({ v, at: idx });
                }
            }
        }
    });
    const cornerOf = (fi, v) => (corner.has(cornerKey(fi, v)) ? corner.get(cornerKey(fi, v)) : v);
    // The old faces with their corners moved; on an unbevelled edge another face drew back, the point goes in.
    mesh.f.forEach((face, fi) => {
        const n = face.length, res = [];
        for (let k = 0; k < n; k++) {
            const v = face[k], w = face[(k + 1) % n];
            res.push(cornerOf(fi, v));
            const ins = onEdge.get(edgeKey(v, w));
            if (!ins || sel.has(edgeKey(v, w))) continue;
            // The points other faces put on this edge, unless this face's own corners already are them.
            const mine = new Set([cornerOf(fi, v), cornerOf(fi, w)]);
            const pts = ins.filter((x) => !mine.has(x.at));
            pts.sort((x, y) => (x.v === v ? 0 : 1) - (y.v === v ? 0 : 1));
            for (const x of pts) res.push(x.at);
        }
        out.f.push(dedupe(res));
    });
    const ids = [];
    // A face per bevelled edge: between its two faces' moved corners.
    for (const k of sel) {
        const [f1, f2] = ef.get(k);
        const [x, y] = edgeEnds(k);
        const a = edgeAt(mesh.f[f1], x, y) >= 0 ? x : y, b = a === x ? y : x;    // f1 has a -> b
        const quad = dedupe([cornerOf(f1, b), cornerOf(f1, a), cornerOf(f2, a), cornerOf(f2, b)]);
        if (quad.length >= 3) { ids.push(out.f.length); out.f.push(quad); }
    }
    // The corners left open where bevelled edges end or meet.
    const was = new Set(boundaryLoops(mesh).flat());
    const loops = boundaryLoops(out).filter((loop) => {
        return loop.every((i) => i >= mesh.v.length || (touched.has(i) && !was.has(i)));
    });
    for (const loop of loops) { ids.push(out.f.length); out.f.push(loop.slice().reverse()); }
    // compact only drops vertices no face uses any more; the faces keep their places.
    return { mesh: compact(out).mesh, ids };
}

function dedupe(face) {
    const out = [];
    for (const i of face) if (out[out.length - 1] !== i) out.push(i);
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
}

// ── Holes: fill and bridge ──────────────────────────────────────────────────

/** Fill the holes the selection touches (every hole with nothing selected). Returns {mesh, ids: new faces}. */
export function fillHoles(mesh, mode = "vertex", ids = []) {
    const out = copyMesh(mesh);
    const verts = selVertices(mesh, mode, ids);
    const loops = boundaryLoops(mesh).filter((loop) => !verts.size || loop.some((i) => verts.has(i)));
    const made = [];
    for (const loop of loops) { made.push(out.f.length); out.f.push(loop.slice().reverse()); }
    return { mesh: out, ids: made };
}

/**
 * Bridge two holes (or two selected face regions, which are taken out first)
 * with a band of quads. The two must have as many edges each. The pairing
 * that keeps the band least twisted wins. Returns {mesh, ids: new faces} or
 * {error}.
 */
export function bridge(mesh, mode, ids) {
    let work = copyMesh(mesh);
    let verts;
    if (mode === "face") {
        const drop = new Set(ids);
        const v = selVertices(mesh, "face", ids);
        work = { v: work.v, f: work.f.filter((_, fi) => !drop.has(fi)) };
        verts = v;
    } else {
        verts = selVertices(mesh, mode, ids);
    }
    const loops = boundaryLoops(work).filter((loop) => loop.every((i) => verts.has(i)));
    if (loops.length !== 2) return { error: "Select the borders of two holes (or two groups of faces) to bridge." };
    const [A, B] = loops;
    if (A.length !== B.length) return { error: `The two borders have ${A.length} and ${B.length} edges; they need as many.` };
    const n = A.length;
    let best = 0, bd = Infinity;
    for (let s = 0; s < n; s++) {
        let d = 0;
        for (let i = 0; i < n; i++) d += dist(work.v[A[i]], work.v[B[((s - i) % n + n) % n]]);
        if (d < bd) { bd = d; best = s; }
    }
    const made = [];
    for (let i = 0; i < n; i++) {
        const a0 = A[i], a1 = A[(i + 1) % n];
        const b0 = B[((best - i) % n + n) % n], b1 = B[((best - i - 1) % n + n) % n];
        made.push(work.f.length);
        work.f.push([a1, a0, b0, b1]);
    }
    const { mesh: m } = compact(work);
    // compact keeps face order, so the new faces are the last n.
    return { mesh: m, ids: m.f.map((_, i) => i).slice(m.f.length - n) };
}

// ── Connect ─────────────────────────────────────────────────────────────────

/**
 * Connect: selected vertices that share a face (and are not already
 * neighbours) are joined by a new edge across it. With edges selected, each is
 * split at its middle first and the middles are joined. Returns {mesh, ids: new edges}.
 */
export function connect(mesh, mode, ids) {
    let work = copyMesh(mesh);
    let verts;
    if (mode === "edge") {
        const mid = new Map();
        for (const k of ids) {
            const [a, b] = edgeEnds(k);
            if (!work.v[a] || !work.v[b]) continue;
            mid.set(edgeKey(a, b), work.v.length);
            work.v.push(lerp(work.v[a], work.v[b], 0.5));
        }
        work.f = work.f.map((face) => {
            const res = [];
            for (let k = 0; k < face.length; k++) {
                const u = face[k], w = face[(k + 1) % face.length];
                res.push(u);
                const m = mid.get(edgeKey(u, w));
                if (m !== undefined) res.push(m);
            }
            return res;
        });
        verts = new Set(mid.values());
    } else {
        verts = selVertices(mesh, mode, ids);
    }
    const made = [];
    const faces = [];
    for (const face of work.f) {
        let pieces = [face];
        // Split the face along each pair of selected corners in turn (in order round the face).
        let again = true;
        while (again) {
            again = false;
            const next = [];
            for (const p of pieces) {
                const at = p.map((i, k) => (verts.has(i) ? k : -1)).filter((k) => k >= 0);
                let split = null;
                for (let x = 0; x < at.length && !split; x++) {
                    for (let y = x + 1; y < at.length && !split; y++) {
                        const i = at[x], j = at[y];
                        if (j - i < 2 || (i === 0 && j === p.length - 1)) continue;
                        split = [i, j];
                    }
                }
                if (!split) { next.push(p); continue; }
                const [i, j] = split;
                next.push(p.slice(i, j + 1), [...p.slice(j), ...p.slice(0, i + 1)]);
                made.push(edgeKey(p[i], p[j]));
                again = true;
            }
            pieces = next;
        }
        faces.push(...pieces);
    }
    work.f = faces;
    return { mesh: work, ids: [...new Set(made)] };
}

// ── Merge by distance ───────────────────────────────────────────────────────

/** Weld vertices closer than `tol` (the selected ones, or all). Returns {mesh, ids: [], merged: count}. */
export function mergeByDistance(mesh, tol = 1e-4, mode = "vertex", ids = null) {
    const only = ids && ids.length ? selVertices(mesh, mode, ids) : null;
    const into = mesh.v.map((_, i) => i);
    const cell = Math.max(tol, 1e-9);
    const grid = new Map();
    const keyOf = (p) => p.map((x) => Math.floor(x / cell));
    let merged = 0;
    mesh.v.forEach((p, i) => {
        if (only && !only.has(i)) return;
        const [cx, cy, cz] = keyOf(p);
        let hit = -1;
        for (let dx = -1; dx <= 1 && hit < 0; dx++) for (let dy = -1; dy <= 1 && hit < 0; dy++) for (let dz = -1; dz <= 1 && hit < 0; dz++) {
            for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
                if (dist(mesh.v[j], p) <= tol) { hit = j; break; }
            }
        }
        if (hit >= 0) { into[i] = hit; merged++; return; }
        const k = `${cx},${cy},${cz}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
    });
    const out = { v: mesh.v.map((p) => p.slice()), f: [] };
    for (const face of mesh.f) {
        const f = dedupe(face.map((i) => into[i]));
        if (f.length >= 3 && new Set(f).size === f.length) out.f.push(f);
    }
    return { mesh: compact(out).mesh, ids: [], merged };
}

// ── Soft selection ──────────────────────────────────────────────────────────

/** How much a vertex at distance d follows (1 at the selection, 0 at the radius): a smooth fall. */
export function softFalloff(d, radius) {
    if (!(radius > 0)) return d <= 0 ? 1 : 0;
    const x = Math.min(1, Math.max(0, d / radius));
    const s = 1 - x;
    return s * s * (3 - 2 * s);
}

/**
 * The weight of every vertex a soft move takes along: the selected ones 1, the
 * rest by their straight distance to the nearest selected one. Map vertex -> weight (> 0).
 */
export function softWeights(mesh, selected, radius) {
    const sel = [...selected];
    const out = new Map(sel.map((i) => [i, 1]));
    if (!(radius > 0) || !sel.length) return out;
    mesh.v.forEach((p, i) => {
        if (out.has(i)) return;
        let d = Infinity;
        for (const j of sel) { const e = dist(p, mesh.v[j]); if (e < d) d = e; }
        const w = softFalloff(d, radius);
        if (w > 1e-4) out.set(i, w);
    });
    return out;
}

/** The edges of a mesh as keys (for tests). */
export function edgeKeys(mesh) { return meshEdges(mesh).map(([a, b]) => edgeKey(a, b)); }
