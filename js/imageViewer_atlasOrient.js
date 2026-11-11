// imageViewer_atlasOrient.js
// Auto-orient an Atlas world: stand it upright with its floor at y = 0, so a walk (or a fly) through it has
// a level ground and a vertical up. DOM-free and three.js-free, so it runs under node
// (tests/test_atlas_orient.mjs). The wiring is in imageViewer_previzAtlasOrient.js.
//
// An Atlas world's mesh lies in its FIRST picture's camera frame (core's build_world_mesh): that camera at
// the origin, looking down -Z, its own up as +Y. A photo taken looking down at a table therefore gives a
// world whose floor is tilted by the photo's pitch. Two things tell where up really is:
//   * the cameras. People and Atlas roll a camera rarely, so every camera's RIGHT axis is level: up is the
//     direction square to all of them (the smallest eigenvector of sum r r^T) - as soon as two cameras point
//     different ways. One camera alone leaves its pitch open, and its own up is the guess.
//   * the floor. A plane among the lowest points, its normal near that guess (RANSAC, then a least-squares
//     fit of its points), below the cameras. When there is one it decides: a level floor is what a walk needs.
// The world is then turned so up is +Y, the first camera's view (made level) looks down -Z, the first
// camera stands at x = z = 0 and the floor at y = 0.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a); return n > 1e-12 ? scale(a, 1 / n) : null; };
const deg = (r) => r * 180 / Math.PI;
const rad = (d) => d * Math.PI / 180;

/** Eigen decomposition of a symmetric 3x3 (Jacobi). Answers [{value, vector}] sorted by value, smallest first. */
export function eigenSym3(m) {
    const a = m.map((r) => r.slice());
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
        if (off < 1e-14) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(a[p][q]) < 1e-18) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k][p], vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    return [0, 1, 2].map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] }))
        .sort((x, y) => x.value - y.value);
}

/** Up from the cameras alone: {up, how}. `cams` are {up, right} unit vectors in the mesh frame. */
export function cameraUp(cams) {
    const ups = cams.map((c) => unit(c.up)).filter(Boolean);
    const mean = unit(ups.reduce((s, u) => [s[0] + u[0], s[1] + u[1], s[2] + u[2]], [0, 0, 0])) || [0, 1, 0];
    const rights = cams.map((c) => unit(c.right)).filter(Boolean);
    if (rights.length >= 2) {
        const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (const r of rights) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += r[i] * r[j];
        const e = eigenSym3(M);
        // The rights must span a plane (two directions at least), or square to them is not one direction.
        if (e[1].value > 0.02 * e[2].value) {
            let g = unit(e[0].vector);
            if (dot(g, mean) < 0) g = scale(g, -1);
            if (dot(g, mean) > Math.cos(rad(60))) return { up: g, how: "cameras" };
        }
    }
    return { up: mean, how: rights.length >= 2 ? "camera ups" : "first camera" };
}

function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[i];
}

/** A small seeded random (mulberry32), so a world orients the same way every time. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The floor: a plane among the lowest points whose normal is within `maxTilt` degrees of `guess`, and which
 * lies below every camera position. `points` is a flat [x, y, z, ...] list in the mesh frame.
 * Answers {normal, height (along normal), inliers, share} or null.
 */
export function findFloor(points, guess, { maxTilt = 35, cams = [], iterations = 400, seed = 7 } = {}) {
    const n = Math.floor(points.length / 3);
    if (n < 30) return null;
    const P = (i) => [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
    const hs = [];
    for (let i = 0; i < n; i++) hs.push(points[3 * i] * guess[0] + points[3 * i + 1] * guess[1] + points[3 * i + 2] * guess[2]);
    const sorted = hs.slice().sort((a, b) => a - b);
    const span = Math.max(1e-6, percentile(sorted, 0.95) - percentile(sorted, 0.05));
    const cut = percentile(sorted, 0.35);
    const low = [];
    for (let i = 0; i < n; i++) if (hs[i] <= cut) low.push(i);
    if (low.length < 30) return null;
    const eps = Math.max(0.01 * span, 1e-4);
    const cosTilt = Math.cos(rad(maxTilt));
    const rand = rng(seed);
    let best = null;
    for (let it = 0; it < iterations; it++) {
        const a = P(low[Math.floor(rand() * low.length)]);
        const b = P(low[Math.floor(rand() * low.length)]);
        const c = P(low[Math.floor(rand() * low.length)]);
        let nrm = unit(cross(sub(b, a), sub(c, a)));
        if (!nrm) continue;
        if (dot(nrm, guess) < 0) nrm = scale(nrm, -1);
        if (dot(nrm, guess) < cosTilt) continue;
        const d = dot(nrm, a);
        let count = 0;
        for (const i of low) if (Math.abs(dot(nrm, P(i)) - d) < eps) count++;
        if (!best || count > best.count) best = { nrm, d, count };
    }
    if (!best || best.count < Math.max(30, 0.15 * low.length)) return null;
    // Least squares on its points: the plane through their centre, square to their flattest direction.
    const ins = low.filter((i) => Math.abs(dot(best.nrm, P(i)) - best.d) < eps).map(P);
    const c = ins.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / ins.length);
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of ins) {
        const q = sub(p, c);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += q[i] * q[j];
    }
    let normal = unit(eigenSym3(C)[0].vector) || best.nrm;
    if (dot(normal, guess) < 0) normal = scale(normal, -1);
    if (dot(normal, guess) < cosTilt) normal = best.nrm;
    const height = dot(normal, c);
    // A floor lies under the cameras.
    for (const cam of cams) if (cam.pos && dot(normal, cam.pos) <= height + eps) return null;
    return { normal, height, inliers: ins.length, share: ins.length / low.length };
}

/** The rotation (rows: new X, Y, Z in mesh coordinates) taking `up` to +Y and `fwd` (made level) to -Z. */
export function levelRotation(up, fwd, right) {
    const g = unit(up);
    let f = unit(sub(fwd, scale(g, dot(fwd, g))));
    if (!f) f = unit(cross(g, right || [1, 0, 0])) || [0, 0, -1];
    const z = scale(f, -1);
    const x = unit(cross(g, z));
    return [x, g, z];
}

/** Euler angles in degrees, XYZ order (three.js's), of a rotation matrix given by rows. */
export function eulerXYZ(m) {
    const m13 = Math.max(-1, Math.min(1, m[0][2]));
    const y = Math.asin(m13);
    let x, z;
    if (Math.abs(m13) < 0.9999999) {
        x = Math.atan2(-m[1][2], m[2][2]);
        z = Math.atan2(-m[0][1], m[0][0]);
    } else {
        x = Math.atan2(m[2][1], m[1][1]);
        z = 0;
    }
    return [deg(x), deg(y), deg(z)];
}

/** The rotation matrix (rows) of Euler angles in degrees, XYZ order: Rx * Ry * Rz. */
export function matrixXYZ(e) {
    const [a, b, c] = e.map(rad);
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    return [
        [cb * cc, -cb * sc, sb],
        [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
        [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
    ];
}

const mul3 = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const mulv = (m, v) => m.map((r) => dot(r, v));
const tr3 = (m) => [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]);

/**
 * Where to put the world. `cams`: [{up, right, fwd, pos}] in the mesh frame, the first being the one the mesh is
 * built in; `points`: a sample of the mesh's vertices (flat), mesh frame. Answers
 * {R (rows), floorHeight, up, how, floor (bool), tilt (degrees the world was off upright)}.
 */
export function orientWorld(cams, points, opts = {}) {
    if (!cams || !cams.length) cams = [{ up: [0, 1, 0], right: [1, 0, 0], fwd: [0, 0, -1], pos: [0, 0, 0] }];
    const guess = cameraUp(cams);
    const tol = guess.how === "cameras" ? 20 : 40;
    const floor = points && points.length ? findFloor(points, guess.up, { maxTilt: tol, cams, ...opts }) : null;
    const up = floor ? floor.normal : guess.up;
    let floorHeight;
    if (floor) floorHeight = floor.height;
    else if (points && points.length >= 3) {
        const hs = [];
        for (let i = 0; i + 2 < points.length; i += 3) hs.push(points[i] * up[0] + points[i + 1] * up[1] + points[i + 2] * up[2]);
        hs.sort((a, b) => a - b);
        floorHeight = percentile(hs, 0.02);
    } else floorHeight = dot(up, cams[0].pos || [0, 0, 0]) - 1.6;
    const first = cams[0];
    const R = levelRotation(up, first.fwd || [0, 0, -1], first.right);
    return { R, floorHeight, up, how: floor ? "floor" : guess.how, floor: !!floor,
             tilt: deg(Math.acos(Math.max(-1, Math.min(1, up[1])))) };
}

/**
 * The world item's transform for an orientation: rotation (degrees, XYZ) and position, keeping its scale and
 * pivot, so that a mesh point p lands at R (s p) - floor, with the first camera (the mesh origin) at x = z = 0.
 */
export function placeWorld(orient, { scale: s = [1, 1, 1], pivot = [0, 0, 0] } = {}) {
    const R = orient.R;
    const sy = Number(s[1]) || 1;
    const o = [0, -orient.floorHeight * sy, 0];
    const RSpv = mulv(R, [pivot[0] * s[0], pivot[1] * s[1], pivot[2] * s[2]]);
    const position = [o[0] + RSpv[0] - pivot[0], o[1] + RSpv[1] - pivot[1], o[2] + RSpv[2] - pivot[2]];
    return { rotation: eulerXYZ(R), position };
}

/** A rigid move {R, t}: what took the world from where it stood (`from`) to where it stands now (`to`).
 *  `from` / `to` are {rotation (deg XYZ), position}. p_new = R p_old + t. */
export function worldDelta(from, to) {
    const A = matrixXYZ(from.rotation), B = matrixXYZ(to.rotation);
    const R = mul3(B, tr3(A));
    const Ra = mulv(R, from.position);
    return { R, t: [to.position[0] - Ra[0], to.position[1] - Ra[1], to.position[2] - Ra[2]] };
}

/** A camera ({rotation, position}) carried along by a rigid move. */
export function carry(delta, cam) {
    const pos = mulv(delta.R, cam.position);
    return { position: [pos[0] + delta.t[0], pos[1] + delta.t[1], pos[2] + delta.t[2]],
             rotation: eulerXYZ(mul3(delta.R, matrixXYZ(cam.rotation))) };
}
