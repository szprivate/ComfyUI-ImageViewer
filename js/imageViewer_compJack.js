// imageViewer_compJack.js
// The handles a Comp node draws over the picture, as a compositor's viewer has them (Sebastian 2026-11-10:
// "the in-viewer overlays ... need to work the same way as they do in Nuke" - written from how those handles
// behave, no code of anybody's):
//   * Transform: a jack at the centre plus the translate. Drag the middle (or anywhere inside the ring) to
//     move, Shift keeps to the axis it starts along, Ctrl drags the centre alone (the picture stays where it
//     is); the ring scales evenly, its four squares scale one axis; the bar to the right turns it; the bar at
//     the top skews it.
//   * Crop: a box; its edges and corners move those sides, inside it moves the box.
// Pure geometry, in comp pixels (y down), so node can test it. `z` is the picture's zoom (screen px per comp
// px): the jack keeps its size on screen.
const JACK_PX = 70;          // the ring's radius on screen at scale 1
const ROT_OUT = 1.45;        // the turning bar's end, in ring radii
const SKEW_OUT = 1.35;       // the skew bar's end
const DEG = 180 / Math.PI;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

/** The 2 x 2 part of a Transform (rotate, scale, skew: the comp's transformMatrix without translate), [a, b, c, d]. */
export function linearPart(rotate, scale, skew) {
    const r = rotate / DEG, c = Math.cos(r), s = Math.sin(r);
    const [sx, sy] = scale, [kx, ky] = skew;
    // R·S·K, K = [[1, kx], [ky, kx ky + 1]] - column-major as the comp's mat: x' = a x + c y, y' = b x + d y.
    const k = [1, ky, kx, kx * ky + 1];
    const rs = [c * sx, s * sx, -s * sy, c * sy];
    return [rs[0] * k[0] + rs[2] * k[1], rs[1] * k[0] + rs[3] * k[1], rs[0] * k[2] + rs[2] * k[3], rs[1] * k[2] + rs[3] * k[3]];
}
const apply = (A, v) => [A[0] * v[0] + A[2] * v[1], A[1] * v[0] + A[3] * v[1]];
function invert(A) {
    const det = A[0] * A[3] - A[1] * A[2] || 1e-12;
    return [A[3] / det, -A[1] / det, -A[2] / det, A[0] / det];
}

/** A Transform's values at a frame: {t, r, s, k, c} (c the centre, the comp's middle when empty). */
export function transformValues(get, fmt) {
    return {
        t: (get("translate") || [0, 0]).slice(), r: +get("rotate") || 0, s: (get("scale") || [1, 1]).slice(),
        k: (get("skew") || [0, 0]).slice(), c: (get("center") || [fmt.width / 2, fmt.height / 2]).slice(),
    };
}

/** Where the jack's parts lie: {O, R0, ring: [[x, y]...], e, w, n, s, rot, skew, ux}. */
export function jackGeom(v, z) {
    const O = [v.c[0] + v.t[0], v.c[1] + v.t[1]];
    const R0 = JACK_PX / (z || 1);
    const A = linearPart(v.r, v.s, v.k);
    const at = (x, y) => { const p = apply(A, [x * R0, y * R0]); return [O[0] + p[0], O[1] + p[1]]; };
    const ring = [];
    for (let i = 0; i < 48; i++) { const a = (i / 48) * 2 * Math.PI; ring.push(at(Math.cos(a), Math.sin(a))); }
    const r = v.r / DEG, ux = [Math.cos(r), Math.sin(r)];
    const reach = R0 * Math.max(0.2, Math.abs(v.s[0])) * ROT_OUT;
    return { O, R0, A, ring, e: at(1, 0), w: at(-1, 0), n: at(0, -1), s: at(0, 1), skew: at(0, -SKEW_OUT),
        rot: [O[0] + ux[0] * reach, O[1] + ux[1] * reach], ux };
}

/**
 * A drag of one of the jack's parts from p0 to p (comp pixels): the values it gives, from those at the press
 * `v`. part: move | centre | ring | e | w | n | s | rot | skew. mods: {shift}. Returns {translate?, rotate?,
 * scale?, skew?, center?}.
 */
export function jackDrag(part, v, p0, p, z, mods = {}) {
    const g = jackGeom(v, z);
    let d = sub(p, p0);
    if (part === "move") {
        if (mods.shift) d = Math.abs(d[0]) >= Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
        return { translate: [v.t[0] + d[0], v.t[1] + d[1]] };
    }
    if (part === "centre") {
        // The centre moves and the picture stays: c' = c + A^-1 d, t' = t + d - A^-1 d.
        const q = apply(invert(g.A), d);
        return { center: [v.c[0] + q[0], v.c[1] + q[1]], translate: [v.t[0] + d[0] - q[0], v.t[1] + d[1] - q[1]] };
    }
    const a0 = sub(p0, g.O), a1 = sub(p, g.O);
    if (part === "rot") {
        let da = (Math.atan2(a1[1], a1[0]) - Math.atan2(a0[1], a0[0])) * DEG;
        while (da > 180) da -= 360;
        while (da < -180) da += 360;
        let r = v.r + da;
        if (mods.shift) r = Math.round(r / 15) * 15;
        return { rotate: r };
    }
    if (part === "ring") {
        const l0 = Math.hypot(a0[0], a0[1]);
        if (l0 < 1e-6) return {};
        const f = Math.hypot(a1[0], a1[1]) / l0;
        return { scale: [v.s[0] * f, v.s[1] * f] };
    }
    const r = v.r / DEG, ux = [Math.cos(r), Math.sin(r)], uy = [-Math.sin(r), Math.cos(r)];
    if (part === "e" || part === "w") {
        const q0 = dot(a0, ux);
        if (Math.abs(q0) < 1e-6) return {};
        const f = dot(a1, ux) / q0;
        return { scale: mods.shift ? [v.s[0] * f, v.s[1] * f] : [v.s[0] * f, v.s[1]] };
    }
    if (part === "n" || part === "s") {
        const q0 = dot(a0, uy);
        if (Math.abs(q0) < 1e-6) return {};
        const f = dot(a1, uy) / q0;
        return { scale: mods.shift ? [v.s[0] * f, v.s[1] * f] : [v.s[0], v.s[1] * f] };
    }
    if (part === "skew") {
        // Sideways along the turned, scaled x axis: the top of the skew bar moves by -kx * its height.
        const sx = v.s[0] || 1e-6;
        const along = dot(d, ux) / sx;
        return { skew: [v.k[0] - along / (g.R0 * SKEW_OUT), v.k[1]] };
    }
    return {};
}

/** A Crop's box dragged: part = inside | l | r | t | b | tl | tr | bl | br; tl, br at the press; d the move. */
export function cropDrag(part, tl, br, d) {
    const a = tl.slice(), b = br.slice();
    if (part === "inside") return { topleft: [a[0] + d[0], a[1] + d[1]], bottomright: [b[0] + d[0], b[1] + d[1]] };
    if (part.includes("l")) a[0] += d[0];
    if (part.includes("r")) b[0] += d[0];
    if (part.includes("t")) a[1] += d[1];
    if (part.includes("b")) b[1] += d[1];
    return { topleft: a, bottomright: b };
}
