// imageViewer_comp3d.js
// Comp's 3D compositing: cameras, cards and simple shapes, projection of a picture onto them, point clouds from
// depth, and a renderer that brings it back to a 2D picture. Plain ES module, imports nothing; the numpy twin is
// src/comp_3d.py, and tests/test_comp_parity.py renders the same scenes with both.
//
// SPACE: y up, right handed, a camera looks down its -Z (as the viewer's 3D space). Units are the scene's.
// A turn is in degrees, applied X then Y then Z about the object's own axes: R = Rx . Ry . Rz.
// Matrices are 4 x 4, row major ([r * 4 + c]), points are columns: p' = M p.
//
// A CAMERA (cameraAt) has a focal length and a horizontal film back (both mm); the picture it takes is the
// comp's (or the projected picture's) size, so the vertical angle follows from its shape. For stereo an eye is
// moved along the camera's own x by `eye` scene units and its picture shifted so that the two eyes meet at the
// convergence distance (an off-axis pair, not toed in).
//
// THE RENDERER (renderScene) rasterises triangles and points on a grid of n x n samples per pixel, perspective
// correct, each object into its own depth-tested buffer; per sample the objects are then laid front to back with
// "over", so a card's transparent parts show what is behind it. Unlit: a surface shows its picture as it is.
// Triangles are cut at the near plane. Points are squares `size` pixels wide, facing the camera.

export const SHAPES = ["cube", "sphere", "cylinder"];
export const PROJECT_FACES = ["both", "front"];
export const DEPTH_MODES = ["distance", "inverse"];
export const DEPTH_OUT = ["depth.z", "none"];

const D2R = Math.PI / 180;

// ── matrices ────────────────────────────────────────────────────────────────

export function m4mul(a, b) {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
    return o;
}
export const m4t = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
export const m4s = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
export function m4rx(deg) { const a = deg * D2R, c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; }
export function m4ry(deg) { const a = deg * D2R, c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; }
export function m4rz(deg) { const a = deg * D2R, c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
export const eulerXYZ = (r) => m4mul(m4rx(r[0]), m4mul(m4ry(r[1]), m4rz(r[2])));
/** Translate . Rotate . Scale. */
export const trs = (t, r, s) => m4mul(m4t(t[0], t[1], t[2]), m4mul(eulerXYZ(r), m4s(s[0], s[1], s[2])));
export const apply = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];

// ── cameras ─────────────────────────────────────────────────────────────────

/**
 * A camera from its settings ({translate, rotate, focal, haperture, near, far, convergence}) taking a W x H picture,
 * moved by `eye` along its own x: {world, view, k, ky, sx, near, far, W, H, pos}. The projection of a point in the
 * camera's space (x, y, z), d = -z in front: px = (k x / d + sx + 1) W / 2, py = (1 - ky y / d) H / 2.
 */
export function cameraAt(p, eye, W, H) {
    const t = p.translate || [0, 0, 0], R = eulerXYZ(p.rotate || [0, 0, 0]);
    const Rt = [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0, 0, 0, 0, 1];
    const view = m4mul(m4t(-eye, 0, 0), m4mul(Rt, m4t(-t[0], -t[1], -t[2])));
    const world = m4mul(m4t(t[0], t[1], t[2]), m4mul(R, m4t(eye, 0, 0)));
    const k = p.focal / (p.haperture / 2);
    const conv = p.convergence > 0 ? p.convergence : 1;
    return { world, view, k, ky: (k * W) / H, sx: (k * eye) / conv, near: p.near, far: p.far, W, H, pos: [world[3], world[7], world[11]] };
}

/** Where a world point lands in the camera's picture: [px, py, d] (d <= 0: behind it). */
export function project(cam, x, y, z) {
    const c = apply(cam.view, x, y, z), d = -c[2];
    return [((cam.k * c[0]) / d + cam.sx + 1) * 0.5 * cam.W, (1 - (cam.ky * c[1]) / d) * 0.5 * cam.H, d];
}

// ── geometry ────────────────────────────────────────────────────────────────
// A mesh is {pos: [x, y, z, ...], uv: [u, v, ...], tri: [i, j, k, ...]}, v up from the picture's bottom.

/** A card one unit wide, `aspect` (height / width) high, in the XY plane facing +Z, centred. */
export function cardMesh(aspect) {
    const h = aspect / 2;
    return { pos: [-0.5, -h, 0, 0.5, -h, 0, 0.5, h, 0, -0.5, h, 0], uv: [0, 0, 1, 0, 1, 1, 0, 1], tri: [0, 1, 2, 0, 2, 3] };
}

/** A unit cube, a sphere or an open cylinder with caps (both 1 across), `div` segments around. */
export function shapeMesh(shape, div) {
    const pos = [], uv = [], tri = [];
    const quad = (a, b, c, d) => { tri.push(a, b, c, a, c, d); };
    if (shape === "sphere") {
        const lon = Math.max(3, div), lat = Math.max(2, Math.floor(div / 2));
        for (let j = 0; j <= lat; j++) {
            const ph = (Math.PI * j) / lat, y = Math.cos(ph) * 0.5, r = Math.sin(ph) * 0.5;
            for (let i = 0; i <= lon; i++) {
                const th = (2 * Math.PI * i) / lon;
                pos.push(r * Math.sin(th), y, r * Math.cos(th));
                uv.push(i / lon, 1 - j / lat);
            }
        }
        for (let j = 0; j < lat; j++) for (let i = 0; i < lon; i++) {
            const a = j * (lon + 1) + i;
            quad(a + lon + 1, a + lon + 2, a + 1, a);
        }
    } else if (shape === "cylinder") {
        const n = Math.max(3, div);
        for (let i = 0; i <= n; i++) {
            const th = (2 * Math.PI * i) / n, x = Math.sin(th) * 0.5, z = Math.cos(th) * 0.5;
            pos.push(x, -0.5, z, x, 0.5, z);
            uv.push(i / n, 0, i / n, 1);
        }
        for (let i = 0; i < n; i++) quad(2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1);
        for (const y of [0.5, -0.5]) {
            const c = pos.length / 3;
            pos.push(0, y, 0); uv.push(0.5, 0.5);
            for (let i = 0; i <= n; i++) {
                const th = (2 * Math.PI * i) / n, x = Math.sin(th) * 0.5, z = Math.cos(th) * 0.5;
                pos.push(x, y, z); uv.push(0.5 + x, 0.5 - z);
            }
            for (let i = 0; i < n; i++) { if (y > 0) tri.push(c, c + 1 + i, c + 2 + i); else tri.push(c, c + 2 + i, c + 1 + i); }
        }
    } else {
        // cube: six faces, each the whole picture, seen from outside the right way up
        const F = [[[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
            [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]];
        for (const [nm, u, v] of F) {
            const b = pos.length / 3;
            for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                pos.push((nm[0] + u[0] * su + v[0] * sv) * 0.5, (nm[1] + u[1] * su + v[1] * sv) * 0.5, (nm[2] + u[2] * su + v[2] * sv) * 0.5);
                uv.push((su + 1) / 2, (sv + 1) / 2);
            }
            quad(b, b + 1, b + 2, b + 3);
        }
    }
    return { pos, uv, tri };
}

/** A mesh's points through m (in place on a copy). */
export function placeMesh(mesh, m) {
    const pos = new Array(mesh.pos.length);
    for (let i = 0; i < mesh.pos.length; i += 3) {
        const p = apply(m, mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]);
        pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2];
    }
    return { pos, uv: mesh.uv, tri: mesh.tri };
}

/**
 * A point per `step`-th pixel of a picture whose depth is `depth` (w*h numbers; distance from the camera along its
 * view, or its inverse), through camera `cam` made at the picture's size; transparent pixels and depths <= 0 left
 * out. {pos, col} (col premultiplied rgba).
 */
export function pointsFromDepth(img, depth, cam, mode, mul, step) {
    const pos = [], col = [], w = img.w, h = img.h, d0 = img.data;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        if (!(d0[i * 4 + 3] > 0)) continue;
        const v = depth ? depth[i] : 0;
        const d = mode === "inverse" ? (v > 0 ? mul / v : 0) : v * mul;
        if (!(d > 0)) continue;
        const nx = ((x + 0.5) / w) * 2 - 1 - cam.sx, ny = 1 - ((y + 0.5) / h) * 2;
        const p = apply(cam.world, (nx * d) / cam.k, (ny * d) / cam.ky, -d);
        pos.push(p[0], p[1], p[2]);
        col.push(d0[i * 4], d0[i * 4 + 1], d0[i * 4 + 2], d0[i * 4 + 3]);
    }
    return { pos, col };
}

// ── sampling ────────────────────────────────────────────────────────────────

/** Bilinear at (u, v) in pixel units (0 = the first pixel's centre), transparent outside: into out[0..3]. */
function sample(img, u, v, out) {
    out[0] = out[1] = out[2] = out[3] = 0;
    const x0 = Math.floor(u), y0 = Math.floor(v), sw = img.w, sh = img.h, s = img.data;
    if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) return;
    const fx = u - x0, fy = v - y0;
    for (let j = 0; j < 4; j++) {
        const yy = y0 + (j >> 1), xx = x0 + (j & 1);
        if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
        const wgt = ((j & 1) ? fx : 1 - fx) * ((j >> 1) ? fy : 1 - fy);
        const si = (yy * sw + xx) * 4;
        out[0] += s[si] * wgt; out[1] += s[si + 1] * wgt; out[2] += s[si + 2] * wgt; out[3] += s[si + 3] * wgt;
    }
}

// ── the renderer ────────────────────────────────────────────────────────────

/** A camera-space polygon cut at d = near: vertices [x, y, z, u, v, wx, wy, wz]. */
function clipNear(poly, near) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const da = -a[2], db = -b[2], ina = da >= near, inb = db >= near;
        if (ina) out.push(a);
        if (ina !== inb) {
            const t = (near - da) / (db - da);
            out.push(a.map((v, k) => v + (b[k] - v) * t));
        }
    }
    return out;
}

/**
 * The objects drawn by camera `cam` into a W x H picture with n x n samples a pixel:
 * {img: {w, h, data}, depth: Float32Array (the nearest surface with any alpha, 0 where none), deep: {w, h, n, s}}.
 * Objects: {kind: "mesh", pos, uv, tri, tex: picture | null, proj: {img, cam} | null, faces} |
 *          {kind: "points", pos, col, size} (size in pixels of this picture).
 * `deep`: per pixel, per object that covers it, one sample [r, g, b, a, z] (the object's mean over the pixel's
 * samples, z its nearest), front first: `n` = Uint32Array of counts, `s` = the samples flat.
 */
export function renderScene(objs, cam, W, H, n) {
    n = Math.max(1, Math.min(4, Math.round(n) || 1));
    const GW = W * n, GH = H * n, S = GW * GH, K = objs.length;
    const zs = [], cs = [];
    const tmp = [0, 0, 0, 0];
    for (const ob of objs) {
        const zb = new Float64Array(S).fill(Infinity), cb = new Float64Array(S * 4);
        zs.push(zb); cs.push(cb);
        if (ob.kind === "points") {
            const half = (ob.size * n) / 2;
            for (let i = 0; i < ob.pos.length / 3; i++) {
                const [px, py, d] = project(cam, ob.pos[i * 3], ob.pos[i * 3 + 1], ob.pos[i * 3 + 2]);
                if (!(d >= cam.near) || d > cam.far) continue;
                const gx = px * n, gy = py * n;
                let x0 = Math.ceil(gx - half - 0.5), x1 = Math.ceil(gx + half - 0.5) - 1;
                let y0 = Math.ceil(gy - half - 0.5), y1 = Math.ceil(gy + half - 0.5) - 1;
                if (x1 < x0) x0 = x1 = Math.floor(gx);
                if (y1 < y0) y0 = y1 = Math.floor(gy);
                for (let Y = Math.max(0, y0); Y <= Math.min(GH - 1, y1); Y++) for (let X = Math.max(0, x0); X <= Math.min(GW - 1, x1); X++) {
                    const s = Y * GW + X;
                    if (d < zb[s]) {
                        zb[s] = d;
                        for (let c = 0; c < 4; c++) cb[s * 4 + c] = ob.col[i * 4 + c];
                    }
                }
            }
            continue;
        }
        const P = ob.pos, U = ob.uv, T = ob.tri;
        for (let t = 0; t < T.length; t += 3) {
            const ids = [T[t], T[t + 1], T[t + 2]];
            const wv = ids.map((q) => [P[q * 3], P[q * 3 + 1], P[q * 3 + 2]]);
            if (ob.proj && ob.faces === "front") {
                const e1 = [wv[1][0] - wv[0][0], wv[1][1] - wv[0][1], wv[1][2] - wv[0][2]];
                const e2 = [wv[2][0] - wv[0][0], wv[2][1] - wv[0][1], wv[2][2] - wv[0][2]];
                const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
                const pc = ob.proj.cam.pos;
                if (!(nx * (pc[0] - wv[0][0]) + ny * (pc[1] - wv[0][1]) + nz * (pc[2] - wv[0][2]) > 0)) continue;
            }
            let poly = ids.map((q, k) => {
                const c = apply(cam.view, wv[k][0], wv[k][1], wv[k][2]);
                return [c[0], c[1], c[2], U[q * 2], U[q * 2 + 1], wv[k][0], wv[k][1], wv[k][2]];
            });
            poly = clipNear(poly, cam.near);
            if (poly.length < 3) continue;
            const pv = poly.map((v) => {
                const d = -v[2];
                return [(((cam.k * v[0]) / d + cam.sx + 1) * 0.5 * W) * n, ((1 - (cam.ky * v[1]) / d) * 0.5 * H) * n, 1 / d, v];
            });
            for (let f = 1; f + 1 < pv.length; f++) {
                const a = pv[0], b = pv[f], c = pv[f + 1];
                const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
                if (!(Math.abs(area) > 1e-12)) continue;
                const X0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) - 0.5)), X1 = Math.min(GW - 1, Math.ceil(Math.max(a[0], b[0], c[0]) - 0.5));
                const Y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) - 0.5)), Y1 = Math.min(GH - 1, Math.ceil(Math.max(a[1], b[1], c[1]) - 0.5));
                for (let Y = Y0; Y <= Y1; Y++) {
                    const sy = Y + 0.5;
                    for (let X = X0; X <= X1; X++) {
                        const sx = X + 0.5;
                        const w0 = ((c[0] - b[0]) * (sy - b[1]) - (c[1] - b[1]) * (sx - b[0])) / area;
                        const w1 = ((a[0] - c[0]) * (sy - c[1]) - (a[1] - c[1]) * (sx - c[0])) / area;
                        const w2 = ((b[0] - a[0]) * (sy - a[1]) - (b[1] - a[1]) * (sx - a[0])) / area;
                        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                        const iz = w0 * a[2] + w1 * b[2] + w2 * c[2];
                        const d = 1 / iz;
                        const s = Y * GW + X;
                        if (!(d < zb[s]) || d > cam.far) continue;
                        const at = (k) => (w0 * a[3][k] * a[2] + w1 * b[3][k] * b[2] + w2 * c[3][k] * c[2]) / iz;
                        if (ob.proj) {
                            const q = project(ob.proj.cam, at(5), at(6), at(7));
                            if (q[2] > 0) sample(ob.proj.img, q[0] - 0.5, q[1] - 0.5, tmp); else tmp[0] = tmp[1] = tmp[2] = tmp[3] = 0;
                        } else if (ob.tex) sample(ob.tex, at(3) * ob.tex.w - 0.5, (1 - at(4)) * ob.tex.h - 0.5, tmp);
                        else { tmp[0] = tmp[1] = tmp[2] = tmp[3] = 1; }
                        zb[s] = d;
                        cb[s * 4] = tmp[0]; cb[s * 4 + 1] = tmp[1]; cb[s * 4 + 2] = tmp[2]; cb[s * 4 + 3] = tmp[3];
                    }
                }
            }
        }
    }
    // Per sample: the objects front to back (the earlier object first at one depth), laid with "over".
    const acc = new Float64Array(S * 4), first = new Float64Array(S).fill(Infinity);
    const order = new Array(K);
    for (let s = 0; s < S; s++) {
        let m = 0;
        for (let k = 0; k < K; k++) if (zs[k][s] < Infinity) {
            let j = m++;
            while (j > 0 && zs[order[j - 1]][s] > zs[k][s]) { order[j] = order[j - 1]; j--; }
            order[j] = k;
        }
        let tr = 1;
        for (let q = 0; q < m; q++) {
            const cb = cs[order[q]], o = s * 4;
            acc[o] += tr * cb[o]; acc[o + 1] += tr * cb[o + 1]; acc[o + 2] += tr * cb[o + 2]; acc[o + 3] += tr * cb[o + 3];
            if (first[s] === Infinity && cb[o + 3] > 0) first[s] = zs[order[q]][s];
            tr = tr * (1 - cb[o + 3]);
        }
    }
    const img = { w: W, h: H, data: new Float32Array(W * H * 4) }, depth = new Float32Array(W * H);
    const counts = new Uint32Array(W * H), samples = [];
    const nn = n * n;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        let r = 0, g = 0, b = 0, al = 0, near = Infinity;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const s = (y * n + j) * GW + x * n + i;
            r += acc[s * 4]; g += acc[s * 4 + 1]; b += acc[s * 4 + 2]; al += acc[s * 4 + 3];
            if (first[s] < near) near = first[s];
        }
        img.data[o] = r / nn; img.data[o + 1] = g / nn; img.data[o + 2] = b / nn; img.data[o + 3] = al / nn;
        depth[y * W + x] = near < Infinity ? near : 0;
        // deep: one sample per object covering the pixel
        const px = [];
        for (let k = 0; k < K; k++) {
            let sr = 0, sg = 0, sb = 0, sa = 0, z = Infinity;
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
                const s = (y * n + j) * GW + x * n + i;
                if (zs[k][s] === Infinity) continue;
                const cb = cs[k];
                sr += cb[s * 4]; sg += cb[s * 4 + 1]; sb += cb[s * 4 + 2]; sa += cb[s * 4 + 3];
                if (cb[s * 4 + 3] > 0 && zs[k][s] < z) z = zs[k][s];
            }
            if (z < Infinity) px.push([sr / nn, sg / nn, sb / nn, sa / nn, z, k]);
        }
        px.sort((p, q) => p[4] - q[4] || p[5] - q[5]);
        counts[y * W + x] = px.length;
        for (const p of px) samples.push(p[0], p[1], p[2], p[3], p[4], p[4]);
    }
    return { img, depth, deep: { w: W, h: H, n: counts, s: Float32Array.from(samples) } };
}
