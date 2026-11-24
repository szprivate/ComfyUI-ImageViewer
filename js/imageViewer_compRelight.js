// imageViewer_compRelight.js
// Comp's Relight: a picture lit again in 2.5D from its surface directions (normals) and the comp's Light nodes.
// Plain ES module, imports nothing; the numpy twin is src/comp_relight.py (tests/test_comp_parity.py renders
// the same comps with both - keep the order of the arithmetic the same in the two).
//
// Written from the published shading model (Lambert's cosine law, a wrapped diffuse, Blinn's half-vector
// highlight) and the comp's own 3D conventions (imageViewer_comp3d.js: y up, a camera looks down its -Z), not
// from any program's relight node.
//
// WHERE EACH PIXEL IS: through the camera (cameraAt's, made at the picture's size) at the distance its depth
// gives (`distance`: the depth is the distance along the view, `inverse`: 1 / it, times `multiply`); a pixel
// with no depth (0, not a number) stands `multiply` units away, so a picture without depth is a flat card.
//
// ITS NORMAL: from the depth (the positions' differences across and down, after an optional `smooth` box blur
// of the depth), from a layer of the picture, or from the "normals" input's colour - a normal map in the
// camera's space (x right, y up, z towards the camera: what AI Normals makes) or the world's, stored 0..1 or
// -1..1, green up or down.
//
// THE LIGHTS: the Light nodes wired into "lights" (directly or through a Scene), as the 3D space's renderer
// takes them - no fall-off with distance, a spot's cone with a soft tenth at its edge, ambient everywhere; with
// none wired the node's own key light (a direction in the camera's space). A light of intensity 1 square on to a
// surface gives the picture's own colour back.
//
// THE RESULT: "add light" lays the light on top of the picture (picture + picture x light), "relight" takes the
// picture as the surface's colour and lights it with these lights alone (picture x light). The highlight is
// added in either. Alpha stays as it came in.

export const RELIGHT_NORMALS = ["from depth", "from a layer", "normals input"];
export const RELIGHT_SPACES = ["camera", "world"];
export const RELIGHT_ENCODINGS = ["0..1", "-1..1"];
export const RELIGHT_GREEN = ["up", "down"];
export const RELIGHT_MODES = ["add light", "relight"];
export const RELIGHT_OUTPUTS = ["result", "light only", "normals"];
export const RELIGHT_PENUMBRA = 0.1;   // a spot's soft edge, as a share of its cone (the 3D space's spot lights)

const D2R = Math.PI / 180;

/** The depth as distances along the view: w*h numbers, 0 where there is none (the caller puts in `multiply`). */
function distances(depth, n, mode, mul) {
    const d = new Float64Array(n);
    if (!depth) return d;
    for (let i = 0; i < n; i++) {
        const v = depth[i];
        const z = mode === "inverse" ? (v > 0 ? mul / v : 0) : v * mul;
        d[i] = z > 0 && Number.isFinite(z) ? z : 0;
    }
    return d;
}

/** A box blur of radius r (whole pixels) along rows then columns, the edge repeated; 0: the numbers as they are. */
export function boxBlur(a, w, h, r) {
    if (!(r >= 1)) return a;
    const tmp = new Float64Array(w * h), out = new Float64Array(w * h), k = 2 * r + 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) { const xx = x + j < 0 ? 0 : x + j > w - 1 ? w - 1 : x + j; s += a[y * w + xx]; }
        tmp[y * w + x] = s / k;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) { const yy = y + j < 0 ? 0 : y + j > h - 1 ? h - 1 : y + j; s += tmp[yy * w + x]; }
        out[y * w + x] = s / k;
    }
    return out;
}

/**
 * Each pixel's place in the camera's space ([x, y, z] x w*h, z < 0 in front): through `cam` (cameraAt's, made
 * at w x h) at distance `d` (Float64Array; 0: `fallback`).
 */
export function cameraPoints(d, w, h, cam, fallback) {
    const C = new Float64Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, z = d[i] > 0 ? d[i] : fallback;
        const nx = ((x + 0.5) / w) * 2 - 1 - cam.sx, ny = 1 - ((y + 0.5) / h) * 2;
        C[i * 3] = (nx * z) / cam.k; C[i * 3 + 1] = (ny * z) / cam.ky; C[i * 3 + 2] = -z;
    }
    return C;
}

/** Normals in the camera's space from its points C: across x down y (one-sided at the edges), facing the camera. */
export function normalsFromPoints(C, w, h) {
    const N = new Float64Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = (y * w + (x > 0 ? x - 1 : x)) * 3, r = (y * w + (x < w - 1 ? x + 1 : x)) * 3;
        const u = ((y > 0 ? y - 1 : y) * w + x) * 3, dn = ((y < h - 1 ? y + 1 : y) * w + x) * 3;
        const ax = C[r] - C[l], ay = C[r + 1] - C[l + 1], az = C[r + 2] - C[l + 2];        // along x (right)
        const bx = C[dn] - C[u], by = C[dn + 1] - C[u + 1], bz = C[dn + 2] - C[u + 2];     // along y (down the rows)
        // down x right: towards the camera (+z) for a surface square on to it
        let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(len > 1e-12)) { nx = 0; ny = 0; nz = 1; } else { nx /= len; ny /= len; nz /= len; }
        // facing the camera: the view from the point back to it is -C
        if (nx * -C[i * 3] + ny * -C[i * 3 + 1] + nz * -C[i * 3 + 2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
        N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz;
    }
    return N;
}

/**
 * Normals read from colours (`rgb`: Float32Array / Float64Array of w*h*3, or a picture's data with `stride` 4):
 * decoded (0..1 or -1..1, green down flipped), made unit length (none: facing the camera) and brought into the
 * camera's space (`space` world: turned by the camera's inverse rotation `Rt`, 9 numbers row major).
 */
export function normalsFromColours(rgb, n, stride, p, Rt) {
    const N = new Float64Array(n * 3), packed = p.encoding !== "-1..1", flip = p.green === "down", world = p.space === "world";
    for (let i = 0; i < n; i++) {
        let x = rgb[i * stride], y = rgb[i * stride + 1], z = rgb[i * stride + 2];
        if (packed) { x = x * 2 - 1; y = y * 2 - 1; z = z * 2 - 1; }
        if (flip) y = -y;
        if (world) {
            const cx = Rt[0] * x + Rt[1] * y + Rt[2] * z, cy = Rt[3] * x + Rt[4] * y + Rt[5] * z, cz = Rt[6] * x + Rt[7] * y + Rt[8] * z;
            x = cx; y = cy; z = cz;
        }
        const len = Math.sqrt(x * x + y * y + z * z);
        if (!(len > 1e-12)) { x = 0; y = 0; z = 1; } else { x /= len; y /= len; z /= len; }
        N[i * 3] = x; N[i * 3 + 1] = y; N[i * 3 + 2] = z;
    }
    return N;
}

/** A layer's three channels for normals: its .x .y .z, else .r .g .b, else its first three; null without three. */
export function normalChannels(ex, layer) {
    if (!ex || !layer || layer === "rgba") return null;
    const names = Object.keys(ex).filter((k) => k.slice(0, k.indexOf(".")) === layer && k.indexOf(".") > 0);
    for (const set of [["x", "y", "z"], ["r", "g", "b"]]) {
        const got = set.map((c) => ex[`${layer}.${c}`]);
        if (got.every(Boolean)) return got;
    }
    return names.length >= 3 ? names.slice(0, 3).map((k) => ex[k]) : null;
}

/** The camera's rotation (cam.world's 3 x 3) and its transpose, row major. */
export function rotationOf(cam) {
    const m = cam.world;
    const R = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    return { R, Rt: [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]] };
}

/**
 * The lights brought into the camera's space: [{type, rgb [3] (colour x intensity), pos [3], dir [3] (where it
 * shines, unit), cosOuter, cosInner}]. `lights`: the scene's light objects ({type, color, intensity, cone, world});
 * `key`: the node's own light ({dir (towards the light, camera space), color, intensity}) when there are none.
 */
export function cameraLights(lights, key, cam) {
    const v = cam.view, out = [];
    const toCam = (x, y, z) => [v[0] * x + v[1] * y + v[2] * z + v[3], v[4] * x + v[5] * y + v[6] * z + v[7], v[8] * x + v[9] * y + v[10] * z + v[11]];
    const turn = (x, y, z) => [v[0] * x + v[1] * y + v[2] * z, v[4] * x + v[5] * y + v[6] * z, v[8] * x + v[9] * y + v[10] * z];
    const unit = (a) => { const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1]; };
    if (!lights.length) {
        const c = key.color || [1, 1, 1, 1], I = key.intensity;
        const towards = unit(key.dir || [0, 0, 1]);
        out.push({ type: "directional", rgb: [c[0] * I, c[1] * I, c[2] * I], pos: [0, 0, 0], dir: [-towards[0], -towards[1], -towards[2]], cosOuter: -1, cosInner: -1 });
        return out;
    }
    for (const l of lights) {
        const c = l.color || [1, 1, 1, 1], I = l.intensity, m = l.world;
        const cone = Math.max(1, Math.min(89, l.cone || 30)) * D2R;
        out.push({
            type: l.type, rgb: [c[0] * I, c[1] * I, c[2] * I],
            pos: toCam(m[3], m[7], m[11]),
            dir: unit(turn(-m[2], -m[6], -m[10])),          // its own -Z, in the world, then the camera's space
            cosOuter: Math.cos(cone), cosInner: Math.cos(cone * (1 - RELIGHT_PENUMBRA)),
        });
    }
    return out;
}

const smooth = (e0, e1, x) => { if (!(e1 > e0)) return x < e0 ? 0 : 1; let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

/**
 * The picture lit: `img` (premultiplied rgba), C / N (camera-space points and unit normals, w*h*3), `lights`
 * (cameraLights'), p {mode, output, gain, wrap, specular, shininess}. A new picture.
 */
export function shade(img, C, N, lights, p) {
    const w = img.w, h = img.h, n = w * h, s = img.data, out = { w, h, data: new Float32Array(n * 4) }, o = out.data;
    const gain = p.gain, wrap = Math.max(0, p.wrap || 0), spec = Math.max(0, p.specular || 0), shin = Math.max(1, p.shininess || 1);
    const relight = p.mode === "relight", only = p.output === "light only";
    for (let i = 0; i < n; i++) {
        const a = s[i * 4 + 3];
        const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
        if (p.output === "normals") {
            o[i * 4] = (nx * 0.5 + 0.5) * a; o[i * 4 + 1] = (ny * 0.5 + 0.5) * a; o[i * 4 + 2] = (nz * 0.5 + 0.5) * a; o[i * 4 + 3] = a;
            continue;
        }
        const px = C[i * 3], py = C[i * 3 + 1], pz = C[i * 3 + 2];
        let vx = -px, vy = -py, vz = -pz;
        const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (vl > 1e-12) { vx /= vl; vy /= vl; vz /= vl; } else { vx = 0; vy = 0; vz = 1; }
        let dr = 0, dg = 0, db = 0, sr = 0, sg = 0, sb = 0;
        for (const L of lights) {
            if (L.type === "ambient") { dr += L.rgb[0]; dg += L.rgb[1]; db += L.rgb[2]; continue; }
            let lx, ly, lz, k = 1;
            if (L.type === "directional") { lx = -L.dir[0]; ly = -L.dir[1]; lz = -L.dir[2]; }
            else {
                lx = L.pos[0] - px; ly = L.pos[1] - py; lz = L.pos[2] - pz;
                const ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
                if (!(ll > 1e-12)) continue;
                lx /= ll; ly /= ll; lz /= ll;
                if (L.type === "spot") k = smooth(L.cosOuter, L.cosInner, -(lx * L.dir[0] + ly * L.dir[1] + lz * L.dir[2]));
            }
            if (!(k > 0)) continue;
            const ndl = nx * lx + ny * ly + nz * lz;
            const d = wrap > 0 ? (ndl + wrap) / (1 + wrap) : ndl;
            if (d > 0) { dr += L.rgb[0] * d * k; dg += L.rgb[1] * d * k; db += L.rgb[2] * d * k; }
            if (spec > 0 && ndl > 0) {
                let hx = lx + vx, hy = ly + vy, hz = lz + vz;
                const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
                if (hl > 1e-12) {
                    hx /= hl; hy /= hl; hz /= hl;
                    const ndh = nx * hx + ny * hy + nz * hz;
                    if (ndh > 0) { const q = Math.pow(ndh, shin) * k; sr += L.rgb[0] * q; sg += L.rgb[1] * q; sb += L.rgb[2] * q; }
                }
            }
        }
        const r = s[i * 4], g = s[i * 4 + 1], b = s[i * 4 + 2];
        const lr = r * dr * gain + sr * spec * gain * a, lg = g * dg * gain + sg * spec * gain * a, lb = b * db * gain + sb * spec * gain * a;
        if (only || relight) { o[i * 4] = lr; o[i * 4 + 1] = lg; o[i * 4 + 2] = lb; }
        else { o[i * 4] = r + lr; o[i * 4 + 1] = g + lg; o[i * 4 + 2] = b + lb; }
        o[i * 4 + 3] = a;
    }
    return out;
}

/**
 * The Relight node: `img` with its extras `ex`; g {cam (cameraAt at the picture's size), lights (the scene's light
 * objects), depth (the depth channel's numbers or null), normals (the normals input conformed to the picture, or
 * null), scale}; p the node's parameters.
 */
export function relightImage(img, ex, g, p) {
    const w = img.w, h = img.h, n = w * h;
    const mul = p.multiply > 0 ? p.multiply : 1;
    let d = distances(g.depth, n, p.depth_mode, mul);
    const r = Math.round((p.smooth || 0) * (g.scale || 1));
    if (g.depth && r >= 1) {
        // Blur only where there is depth: the holes keep none (the fallback distance), the rest its neighbours'.
        const has = new Float64Array(n);
        for (let i = 0; i < n; i++) has[i] = d[i] > 0 ? 1 : 0;
        const bd = boxBlur(d, w, h, r), bh = boxBlur(has, w, h, r);
        const nd = new Float64Array(n);
        for (let i = 0; i < n; i++) nd[i] = has[i] > 0 && bh[i] > 0 ? bd[i] / bh[i] : 0;
        d = nd;
    }
    const C = cameraPoints(d, w, h, g.cam, mul);
    const { Rt } = rotationOf(g.cam);
    let N = null;
    if (p.normals === "from a layer") {
        if (p.layer === "rgba") N = normalsFromColours(img.data, n, 4, p, Rt);
        else {
            const ch = normalChannels(ex, p.layer);
            if (ch) {
                const rgb = new Float64Array(n * 3);
                for (let i = 0; i < n; i++) { rgb[i * 3] = ch[0][i]; rgb[i * 3 + 1] = ch[1][i]; rgb[i * 3 + 2] = ch[2][i]; }
                N = normalsFromColours(rgb, n, 3, p, Rt);
            }
        }
    } else if (p.normals === "normals input" && g.normals) N = normalsFromColours(g.normals.data, n, 4, p, Rt);
    if (!N) N = normalsFromPoints(C, w, h);
    const lights = cameraLights(g.lights || [], { dir: p.key_direction, color: p.key_color, intensity: p.key_intensity }, g.cam);
    return shade(img, C, N, lights, p);
}
