// imageViewer_constraints.js
// The constraint solver of the 3D space: where every constrained item is at a
// frame. Pure maths on the scene data (imageViewer_scene3d.js) - no three.js,
// no DOM - so it runs under plain node, the view (imageViewer_model3d.js)
// writes its answer into the objects it draws, and baking uses the same code.
// The data is imageViewer_constraintData.js. Clean-room: written from the
// definitions of the operations, not from any program's code.
//
// THE TRANSFORMS (the same chain the view builds, see scene3d's header):
//     root  = P · T(position + pivot) · R · S        P = the parent's inner · rest
//     inner = root · T(-pivot) · offset              (what children hang under)
// `rest` is a rig control's matrix above its channels; R is Euler XYZ in
// degrees (three's "XYZ": R = Rx · Ry · Rz). A constraint works on ROOT
// matrices: a target is "where its root is" (its pivot point, turned and
// scaled as it is), and what a constraint decides is the driven item's root.
// That is then taken back into the item's own channels (position, rotation,
// scale), the axes a constraint skips keep their own values, and its weight
// blends the result with what came in. Several constraints on one item apply
// in their order, each on what the one before left.
//
// Matrices are 16 numbers, column-major (three's order); quaternions [x, y, z, w].
import * as S from "./imageViewer_scene3d.js";
import { AXES, constrainedChannels, envelopeProp, isConstrained, weightProp } from "./imageViewer_constraintData.js";

const DEG = Math.PI / 180;

// ── 4x4 matrices ───────────────────────────────────────────────────────────

export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return o;
}

export function invert(m) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det || !Number.isFinite(det)) return identity();
    const d = 1 / det;
    return [
        (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
        (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
        (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
        (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
        (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
        (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
        (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
        (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
    ];
}

export function translation(t) {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

/** T · R(q) · S as one matrix. */
export function compose(t, q, s) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
        (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
        (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
        (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
        t[0], t[1], t[2], 1,
    ];
}

/** { t, q, s } of a matrix; a mirrored one gets its negative scale on X. */
export function decompose(m) {
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    if (det3(m) < 0) sx = -sx;
    const r = m.slice();
    const ix = sx ? 1 / sx : 0, iy = sy ? 1 / sy : 0, iz = sz ? 1 / sz : 0;
    r[0] *= ix; r[1] *= ix; r[2] *= ix;
    r[4] *= iy; r[5] *= iy; r[6] *= iy;
    r[8] *= iz; r[9] *= iz; r[10] *= iz;
    return { t: [m[12], m[13], m[14]], q: quatFromMatrix(r), s: [sx, sy, sz] };
}

function det3(m) {
    return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

export function transformPoint(m, p) {
    return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
}

// ── Quaternions and Euler XYZ (degrees) ────────────────────────────────────

export function quatFromMatrix(m) {
    const m11 = m[0], m12 = m[4], m13 = m[8], m21 = m[1], m22 = m[5], m23 = m[9], m31 = m[2], m32 = m[6], m33 = m[10];
    const tr = m11 + m22 + m33;
    let x, y, z, w;
    if (tr > 0) {
        const s = 0.5 / Math.sqrt(tr + 1);
        w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
        const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
    } else if (m22 > m33) {
        const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
    }
    return quatNormalize([x, y, z, w]);
}

export function quatNormalize(q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    return n > 1e-12 ? q.map((v) => v / n) : [0, 0, 0, 1];
}

export function quatMultiply(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
        ax * bw + aw * bx + ay * bz - az * by,
        ay * bw + aw * by + az * bx - ax * bz,
        az * bw + aw * bz + ax * by - ay * bx,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

export const quatInvert = (q) => [-q[0], -q[1], -q[2], q[3]];

export function quatFromEuler(deg) {
    const [x, y, z] = deg.map((d) => d * DEG / 2);
    const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
    const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
    return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ];
}

export function rotateVector(q, v) {
    const m = compose([0, 0, 0], q, [1, 1, 1]);
    return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}

/**
 * Euler XYZ (degrees) of a rotation, of its two solutions the one nearest
 * `near` (and each angle unwrapped to it), so a constrained channel does not
 * flip or jump a turn from one frame to the next.
 */
export function eulerFromQuat(q, near = [0, 0, 0]) {
    const m = compose([0, 0, 0], q, [1, 1, 1]);
    const m11 = m[0], m12 = m[4], m13 = m[8], m22 = m[5], m23 = m[9], m32 = m[6], m33 = m[10];
    const y = Math.asin(Math.max(-1, Math.min(1, m13)));
    let x, z;
    if (Math.abs(m13) < 0.9999999) {
        x = Math.atan2(-m23, m33);
        z = Math.atan2(-m12, m11);
    } else {
        x = Math.atan2(m32, m22);
        z = 0;
    }
    const a = [x / DEG, y / DEG, z / DEG];
    const b = [a[0] + 180, 180 - a[1], a[2] + 180];
    const wrap = (v, n) => v + 360 * Math.round((n - v) / 360);
    const fit = (e) => e.map((v, i) => wrap(v, near[i] || 0));
    const fa = fit(a), fb = fit(b);
    const dist = (e) => e.reduce((s, v, i) => s + Math.abs(v - (near[i] || 0)), 0);
    return dist(fb) + 1e-9 < dist(fa) ? fb : fa;
}

/** Weighted blend of rotations (each turned to the first one's half of the sphere). */
export function quatBlend(qs, ws) {
    const out = [0, 0, 0, 0];
    const first = qs[0];
    for (let i = 0; i < qs.length; i++) {
        const q = qs[i];
        const sign = (q[0] * first[0] + q[1] * first[1] + q[2] * first[2] + q[3] * first[3]) < 0 ? -1 : 1;
        for (let k = 0; k < 4; k++) out[k] += ws[i] * sign * q[k];
    }
    return quatNormalize(out);
}

export function quatSlerp(a, b, t) {
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (cos < 0) { cos = -cos; bb = b.map((v) => -v); }
    if (cos > 0.9995) return quatNormalize(a.map((v, i) => v + (bb[i] - v) * t));
    const th = Math.acos(cos), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return a.map((v, i) => v * wa + bb[i] * wb);
}

/** The rotation that takes axis `from` (unit) onto `to` (unit) by the shortest way. */
function quatBetween(from, to) {
    const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
    if (d < -0.999999) {
        // Opposite: any axis across `from` will do.
        let ax = cross([1, 0, 0], from);
        if (Math.hypot(...ax) < 1e-6) ax = cross([0, 1, 0], from);
        ax = norm(ax);
        return [ax[0], ax[1], ax[2], 0];
    }
    const c = cross(from, to);
    return quatNormalize([c[0], c[1], c[2], 1 + d]);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function norm(v) {
    const n = Math.hypot(v[0], v[1], v[2]);
    return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** The rotation matrix whose columns are x, y, z (an orthonormal basis). */
function basis(x, y, z) {
    return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

/**
 * The rotation that points `aimAxis` along `aim` and turns `upAxis` as close
 * to `up` as it can go while doing so. Null when there is no direction.
 */
export function aimRotation(aimAxis, upAxis, aim, up) {
    const a = norm(aim);
    if (!a) return null;
    // Local frame: the aim axis, the up axis made square to it, and the third.
    const la = norm(aimAxis);
    const lu = norm(sub(upAxis, la.map((v) => v * dot(upAxis, la))));
    if (!lu) return null;
    const lw = cross(la, lu);
    let u = up ? norm(sub(up, a.map((v) => v * dot(up, a)))) : null;
    if (!u) return null;
    const w = cross(a, u);
    // R · [la lu lw] = [a u w]  =>  R = [a u w] · [la lu lw]^T
    const target = basis(a, u, w);
    const local = basis(la, lu, lw);
    const localT = [local[0], local[4], local[8], 0, local[1], local[5], local[9], 0,
                    local[2], local[6], local[10], 0, 0, 0, 0, 1];
    return quatFromMatrix(multiply(target, localT));
}

// ── The scene ──────────────────────────────────────────────────────────────

/** The item's own channels at `frame` as a root matrix (without its parent). */
function localMatrix(ch) {
    const pv = ch.pivot || [0, 0, 0];
    return compose([ch.position[0] + pv[0], ch.position[1] + pv[1], ch.position[2] + pv[2]],
                   quatFromEuler(ch.rotation), ch.scale);
}

function innerOf(item, root, pivot) {
    const pv = pivot || [0, 0, 0];
    let m = multiply(root, translation([-pv[0], -pv[1], -pv[2]]));
    const off = S.offsetOf(item);
    if (off) m = multiply(m, off);
    return m;
}

/**
 * A solver for one frame of a scene: `world(id)` is { root, inner, local } of
 * an item - its root and inner matrices in the world, and `local`, its
 * channels as the constraints leave them ({ position, rotation, scale, pivot }).
 * Items are worked out on demand and remembered; a constraint loop (which
 * the menu refuses to make) is broken by taking the item as unconstrained.
 */
export function solver(scene, frame) {
    const byId = new Map((scene.items || []).map((it) => [it.id, it]));
    const memo = new Map();
    const busy = new Set();
    const loops = new Set();

    const parentFrame = (item, viaConstraints) => {
        const parent = item.parent ? byId.get(item.parent) : null;
        let p = parent ? (viaConstraints ? world(parent.id).inner : raw(parent.id).inner) : identity();
        if (Array.isArray(item.rest) && item.rest.length === 16) p = multiply(p, item.rest.map(Number));
        return p;
    };

    // Unconstrained, all the way up: what a loop falls back to.
    const rawMemo = new Map();
    function raw(id) {
        if (rawMemo.has(id)) return rawMemo.get(id);
        const item = byId.get(id);
        const ch = S.evaluate(item, frame);
        const root = multiply(parentFrame(item, false), localMatrix(ch));
        const out = { root, inner: innerOf(item, root, ch.pivot), local: ch };
        rawMemo.set(id, out);
        return out;
    }

    function world(id) {
        if (memo.has(id)) return memo.get(id);
        const item = byId.get(id);
        if (!item) return null;
        if (busy.has(id)) { loops.add(id); return raw(id); }
        busy.add(id);
        const P = parentFrame(item, true);
        let ch = S.evaluate(item, frame);
        if (isConstrained(item)) ch = applyConstraints(item, ch, P, frame, world, byId);
        const root = multiply(P, localMatrix(ch));
        const out = { root, inner: innerOf(item, root, ch.pivot), local: ch };
        busy.delete(id);
        memo.set(id, out);
        return out;
    }

    return { world, loops, byId };
}

/** The channels of every constrained item at `frame`: Map id -> { position, rotation, scale }. */
export function constrainedLocals(scene, frame) {
    const out = new Map();
    const items = (scene && scene.items) || [];
    if (!items.some(isConstrained)) return out;
    const sv = solver(scene, frame);
    for (const item of items) {
        if (!isConstrained(item)) continue;
        const w = sv.world(item.id);
        if (w) out.set(item.id, { ...w.local, root: w.root });
    }
    return out;
}

function weightAt(item, c, t, frame) {
    return Math.max(0, Number(S.valueAt(item, weightProp(c.id, t.id), frame)) || 0);
}

/** The shares of a constraint's live targets at `frame`: [{ t, w (normalised), world }]. */
function shares(item, c, frame, world, byId) {
    const live = [];
    let sum = 0;
    for (const t of c.targets) {
        if (!byId.has(t.id) || t.id === item.id) continue;
        const w = weightAt(item, c, t, frame);
        if (w <= 0) continue;
        const tw = world(t.id);
        if (!tw) continue;
        live.push({ t, w, world: tw });
        sum += w;
    }
    if (sum <= 0) return [];
    for (const l of live) l.w /= sum;
    return live;
}

/**
 * Apply an item's constraints, in order, to its channels `ch` (P = its
 * parent frame). Returns the new channels.
 */
export function applyConstraints(item, ch, P, frame, world, byId) {
    let cur = { position: ch.position.slice(), rotation: ch.rotation.slice(), scale: ch.scale.slice(),
                pivot: (ch.pivot || [0, 0, 0]).slice(), fov: ch.fov, ikfk: ch.ikfk };
    const Pinv = invert(P);
    for (const c of item.constraints || []) {
        if (!c.on) continue;
        const env = Math.max(0, Math.min(1, Number(S.valueAt(item, envelopeProp(c.id), frame))));
        if (env <= 0) continue;
        const live = shares(item, c, frame, world, byId);
        if (!live.length) continue;
        const W = multiply(P, localMatrix(cur));
        const want = solveOne(c, W, live, world, byId);
        if (!want) continue;
        const next = toChannels(Pinv, want, cur);
        cur = mix(cur, next, c, env);
    }
    return cur;
}

/** The root matrix a constraint wants, given the incoming root W and its targets. */
function solveOne(c, W, live, world, byId) {
    const d = decompose(W);
    const ws = live.map((l) => l.w);
    if (c.type === "point") {
        const p = [0, 0, 0];
        for (const l of live) {
            const t = decompose(l.world.root).t;
            const o = l.t.offset || [0, 0, 0];
            for (let k = 0; k < 3; k++) p[k] += l.w * (t[k] + o[k]);
        }
        return compose(p, d.q, d.s);
    }
    if (c.type === "orient") {
        const qs = live.map((l) => {
            const q = decompose(l.world.root).q;
            return l.t.offset ? quatMultiply(q, l.t.offset) : q;
        });
        return compose(d.t, quatBlend(qs, ws), d.s);
    }
    if (c.type === "scale") {
        const s = [0, 0, 0];
        for (const l of live) {
            const ts = decompose(l.world.root).s;
            const o = l.t.offset || [1, 1, 1];
            for (let k = 0; k < 3; k++) s[k] += l.w * ts[k] * o[k];
        }
        return compose(d.t, d.q, s);
    }
    if (c.type === "parent") {
        const p = [0, 0, 0];
        const qs = [];
        for (const l of live) {
            const M = l.t.offset ? multiply(l.world.root, l.t.offset) : l.world.root;
            const md = decompose(M);
            for (let k = 0; k < 3; k++) p[k] += l.w * md.t[k];
            qs.push(md.q);
        }
        return compose(p, quatBlend(qs, ws), d.s);
    }
    if (c.type === "aim") {
        const q = aimWorld(c, d, live, world, byId);
        if (!q) return null;
        return compose(d.t, c.offset ? quatMultiply(q, c.offset) : q, d.s);
    }
    return null;
}

/** The world rotation an aim constraint gives an item standing as `d` ({t, q, s}). */
function aimWorld(c, d, live, world, byId) {
    const a = c.aim;
    const goal = [0, 0, 0];
    for (const l of live) {
        const t = decompose(l.world.root).t;
        for (let k = 0; k < 3; k++) goal[k] += l.w * t[k];
    }
    const dir = sub(goal, d.t);
    if (!norm(dir)) return null;
    let up = null;
    const upObj = a.upObject && byId.has(a.upObject) ? world(a.upObject) : null;
    if (a.upType === "scene") up = [0, 1, 0];
    else if (a.upType === "vector") up = a.upVector;
    else if (a.upType === "object") up = upObj ? sub(decompose(upObj.root).t, d.t) : [0, 1, 0];
    else if (a.upType === "objectrotation") up = upObj ? rotateVector(decompose(upObj.root).q, a.upVector) : a.upVector;
    if (a.upType === "none") {
        // No up: the smallest turn that brings the aim axis round onto the target.
        const now = rotateVector(d.q, a.aimAxis);
        return quatMultiply(quatBetween(norm(now), norm(dir)), d.q);
    }
    const q = aimRotation(a.aimAxis, a.upAxis, dir, up);
    if (q) return q;
    // Up along the aim: fall back to the smallest turn.
    const now = rotateVector(d.q, a.aimAxis);
    return quatMultiply(quatBetween(norm(now), norm(dir)), d.q);
}

/** A root matrix in the world back into channels, the rotation kept near the old one. */
function toChannels(Pinv, W, cur) {
    const L = decompose(multiply(Pinv, W));
    const pv = cur.pivot || [0, 0, 0];
    return {
        position: [L.t[0] - pv[0], L.t[1] - pv[1], L.t[2] - pv[2]],
        rotation: eulerFromQuat(L.q, cur.rotation),
        scale: L.s,
        pivot: pv.slice(),
        fov: cur.fov,
        ikfk: cur.ikfk,
    };
}

/** What the constraint leaves: its skipped axes kept, then blended by its weight. */
function mix(cur, next, c, env) {
    const out = { ...cur, position: cur.position.slice(), rotation: cur.rotation.slice(), scale: cur.scale.slice() };
    const writes = { t: "position", r: "rotation", s: "scale" };
    const channels = {
        parent: ["t", "r"], point: ["t"], orient: ["r"], scale: ["s"], aim: ["r"],
    }[c.type] || [];
    for (const k of channels) {
        const prop = writes[k];
        const skip = c.skip[k];
        if (k === "r") {
            const n = next.rotation.map((v, i) => (skip.includes(i) ? cur.rotation[i] : v));
            if (env >= 1) out.rotation = n;
            else out.rotation = eulerFromQuat(quatSlerp(quatFromEuler(cur.rotation), quatFromEuler(n), env), cur.rotation);
        } else {
            out[prop] = cur[prop].map((v, i) => (skip.includes(i) ? v : v + (next[prop][i] - v) * env));
        }
    }
    return out;
}

// ── Making a constraint: offsets, and loops ────────────────────────────────

/**
 * Fill `c`'s offsets so that, at `frame`, applying it changes nothing: the
 * driven item stays where it is. (Without maintain offset they are cleared,
 * and it snaps onto the targets.) `c` must already be on `item`, in its place
 * in the list: the offsets are taken against what the constraints before it
 * leave.
 */
export function captureOffsets(scene, item, c, frame) {
    for (const t of c.targets) t.offset = null;
    if (c.type === "aim") c.offset = null;
    if (!c.maintainOffset) return c;
    const sv = solver(scene, frame);
    const byId = sv.byId;
    // What comes into this constraint: the item with only the ones before it.
    const idx = item.constraints.indexOf(c);
    const before = { ...item, constraints: item.constraints.slice(0, Math.max(0, idx)) };
    const parent = item.parent ? sv.world(item.parent) : null;
    let P = parent ? parent.inner : identity();
    if (Array.isArray(item.rest) && item.rest.length === 16) P = multiply(P, item.rest.map(Number));
    let ch = S.evaluate(item, frame);
    if (before.constraints.length) ch = applyConstraints(before, ch, P, frame, sv.world, byId);
    const W = multiply(P, localMatrix(ch));
    const d = decompose(W);
    for (const t of c.targets) {
        const tw = byId.has(t.id) ? sv.world(t.id) : null;
        if (!tw) continue;
        const td = decompose(tw.root);
        if (c.type === "point") t.offset = sub(d.t, td.t);
        else if (c.type === "orient") t.offset = quatMultiply(quatInvert(td.q), d.q);
        else if (c.type === "scale") t.offset = d.s.map((v, i) => (Math.abs(td.s[i]) > 1e-9 ? v / td.s[i] : 1));
        else if (c.type === "parent") t.offset = multiply(invert(tw.root), W);
    }
    if (c.type === "aim") {
        const live = shares(item, c, frame, sv.world, byId);
        const q = live.length ? aimWorld(c, d, live, sv.world, byId) : null;
        c.offset = q ? quatMultiply(quatInvert(q), d.q) : null;
    }
    return c;
}

/**
 * Whether item `a`'s place depends on item `b`: through its parents, or a
 * constraint's targets (or an aim's up object), all the way down.
 */
export function dependsOn(scene, a, b) {
    const byId = new Map((scene.items || []).map((it) => [it.id, it]));
    const seen = new Set();
    const stack = [a];
    while (stack.length) {
        const id = stack.pop();
        if (id === b) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        const it = byId.get(id);
        if (!it) continue;
        if (it.parent) stack.push(it.parent);
        for (const c of it.constraints || []) {
            for (const t of c.targets) stack.push(t.id);
            if (c.aim && c.aim.upObject) stack.push(c.aim.upObject);
        }
    }
    return false;
}

/**
 * Why `targetId` cannot drive `drivenId`, or "" when it can: itself, one of
 * its own children (which it carries), or something that already follows it.
 */
export function cannotConstrain(scene, drivenId, targetId) {
    if (drivenId === targetId) return "an item cannot follow itself";
    if (dependsOn(scene, targetId, drivenId)) return "it already follows the item (or hangs under it)";
    return "";
}

// ── Baking ──────────────────────────────────────────────────────────────────

/**
 * The constrained channels of `ids` on every frame first..last:
 * Map id -> [{ f, position, rotation, scale }]. Rotations are kept continuous
 * from frame to frame. Only the channels a constraint that is on writes are
 * meant to be keyed (constrainedChannels).
 */
export function bakeFrames(scene, ids, first, last) {
    const out = new Map(ids.map((id) => [id, []]));
    const prev = new Map();
    for (let f = first; f <= last; f++) {
        const sv = solver(scene, f);
        for (const id of ids) {
            const item = sv.byId.get(id);
            if (!item || !isConstrained(item)) continue;
            const w = sv.world(id);
            let rot = w.local.rotation;
            const p = prev.get(id);
            if (p) rot = eulerFromQuat(quatFromEuler(rot), p);
            prev.set(id, rot);
            out.get(id).push({ f, position: w.local.position.slice(), rotation: rot.slice(), scale: w.local.scale.slice() });
        }
    }
    return out;
}

/** Which whole channels (position / rotation / scale) a bake keys on this item. */
export function bakedProps(item) {
    const ch = constrainedChannels(item);
    const out = [];
    if ([0, 1, 2].some((a) => ch.has(`t${a}`))) out.push("position");
    if ([0, 1, 2].some((a) => ch.has(`r${a}`))) out.push("rotation");
    if ([0, 1, 2].some((a) => ch.has(`s${a}`)) && item.kind !== "control" && item.kind !== "camera") out.push("scale");
    return out;
}

/**
 * Bake `ids` (every constrained item when null) into keys on frames
 * first..last, in place: the constrained channels get a linear key a frame
 * (a skipped axis keeps its own values), and with `remove` the constraints
 * and their weight channels go. Returns { items, keys }.
 */
export function bakeScene(scene, ids = null, first = 0, last = null, { remove = true } = {}) {
    const items = (ids ? ids.map((id) => S.itemById(scene, id)) : scene.items || [])
        .filter((it) => it && isConstrained(it));
    const f0 = Math.round(first || 0);
    const f1 = Math.max(f0, Math.round(last ?? Math.max(0, (scene.length || 1) - 1)));
    const frames = bakeFrames(scene, items.map((it) => it.id), f0, f1);
    let keys = 0;
    // Every item's keys are worked out before any is written: a constrained
    // item may follow another one being baked.
    const writes = [];
    for (const item of items) {
        const ch = constrainedChannels(item);
        for (const prop of bakedProps(item)) {
            const k = { position: "t", rotation: "r", scale: "s" }[prop];
            const list = (frames.get(item.id) || []).map((fr) => {
                const own = S.valueAt(item, prop, fr.f);
                return { f: fr.f, v: fr[prop].map((v, a) => (ch.has(`${k}${a}`) ? v : own[a])), ease: "linear" };
            });
            writes.push([item, prop, list]);
            keys += list.length;
        }
    }
    for (const [item, prop, list] of writes) (item.tracks || (item.tracks = {}))[prop] = list;
    if (remove) {
        for (const item of items) {
            delete item.constraints;
            for (const prop of Object.keys(item.tracks || {})) if (/^c[we]:/.test(prop)) delete item.tracks[prop];
        }
    }
    return { items, keys, first: f0, last: f1 };
}

/** A copy of the scene with every constraint baked into keys: for an export that reads keys only. */
export function bakedCopy(scene) {
    if (!(scene && (scene.items || []).some(isConstrained))) return scene;
    const copy = S.parseScene(S.serializeScene(scene));
    bakeScene(copy);
    return copy;
}

export { AXES };
