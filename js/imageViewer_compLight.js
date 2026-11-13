// Comp's light: Glow and LensFlare. Pure; imports only compOps. The numpy twins are `glow_image`,
// `flare_image` and `mulberry32` in src/comp_model.py: the same operations in the same order (no `**`) -
// change one, change the other (tests/test_comp_parity.py). Written from the optics of the thing (a bright
// source spread by scatter, rays from the aperture's blades, reflections between lens elements along the
// axis through the frame's centre, dust on the front glass), not from any program's flare.

import { blank, blurImage, scanBox, withBox } from "./imageViewer_compOps.js";

const LUM = [0.2126, 0.7152, 0.0722];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => { if (!(e1 > e0)) return x < e0 ? 0 : 1; const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** A seeded generator of numbers in [0, 1) (mulberry32): the same sequence in both twins. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
        t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── Glow ─────────────────────────────────────────────────────────────────────

export const GLOW_SOURCES = ["luminance", "max"];

/**
 * What is brighter than `threshold` (over `softness`), tinted, blurred at `steps` sizes halving from `size`
 * and averaged, times `intensity`, added to the picture (or alone, `effect_only`).
 */
export function glowImage(img, p) {
    const w = img.w, h = img.h, s = img.data, N = w * h;
    const hi = blank(w, h), q = hi.data, tint = p.tint || [1, 1, 1, 1];
    for (let i = 0; i < N * 4; i += 4) {
        const L = p.source === "max" ? Math.max(s[i], s[i + 1], s[i + 2]) : LUM[0] * s[i] + LUM[1] * s[i + 1] + LUM[2] * s[i + 2];
        const k = p.softness > 0 ? clamp01((L - p.threshold) / p.softness) : L > p.threshold ? 1 : 0;
        q[i] = s[i] * k * tint[0]; q[i + 1] = s[i + 1] * k * tint[1]; q[i + 2] = s[i + 2] * k * tint[2];
    }
    // Usually only a little of the picture is bright enough: its box is all the blurs go through (the same
    // numbers - outside it everything is 0 either way).
    withBox(hi, scanBox(hi));
    const steps = Math.max(1, Math.round(p.steps));
    const acc = new Float64Array(N * 4);
    let size = p.size;
    for (let k = 0; k < steps; k++) {
        const b = blurImage(hi, size).data;
        for (let i = 0; i < N * 4; i++) acc[i] += b[i];
        size = size / 2;
    }
    const out = blank(w, h), o = out.data, g = p.intensity / steps;
    for (let i = 0; i < N * 4; i += 4) {
        const r = acc[i] * g, gg = acc[i + 1] * g, b = acc[i + 2] * g;
        if (p.effect_only === "on") {
            o[i] = r; o[i + 1] = gg; o[i + 2] = b; o[i + 3] = clamp01(LUM[0] * r + LUM[1] * gg + LUM[2] * b);
        } else {
            o[i] = s[i] + r; o[i + 1] = s[i + 1] + gg; o[i + 2] = s[i + 2] + b; o[i + 3] = s[i + 3];
        }
    }
    return out;
}

// ── LensFlare ────────────────────────────────────────────────────────────────

export const GHOST_SHAPES = ["disc", "polygon"];

/** The ghosts along the axis, from the seed: [{t, r, c: [r, g, b], k}] (t: 0 the light, 1 its mirror). */
export function flareGhosts(p) {
    const rnd = mulberry32(Math.round(p.seed) * 7919 + 17);
    const tint = p.color || [1, 1, 1, 1], out = [];
    for (let j = 0; j < Math.round(p.ghost_count); j++) {
        const t = (rnd() * 1.6 - 0.3) * p.ghost_spread;
        const r = 0.3 + rnd() * 1.4;
        const c = [tint[0] * (0.5 + 0.5 * rnd()), tint[1] * (0.5 + 0.5 * rnd()), tint[2] * (0.5 + 0.5 * rnd())];
        const k = 0.3 + 0.7 * rnd();
        out.push({ t, r, c, k });
    }
    return out;
}
/** Dust on the glass from the seed: [{x, y, r, k}] as shares of the frame (x, y) and of its diagonal (r). */
export function dirtSpots(p) {
    const rnd = mulberry32(Math.round(p.seed) * 104729 + 3);
    const out = [];
    for (let j = 0; j < Math.round(p.dirt_spots); j++) out.push({ x: rnd(), y: rnd(), r: 0.002 + rnd() * 0.018, k: 0.2 + 0.8 * rnd() });
    return out;
}
/** Where a regular polygon of n sides (a corner up, turned by rot) has its edge, as a share of its radius, at angle a. */
function polyEdge(n, rot, a) {
    const seg = (2 * Math.PI) / n;
    let x = (a - rot + Math.PI / 2) % seg;
    if (x < 0) x += seg;
    return Math.cos(Math.PI / n) / Math.cos(x - Math.PI / n);
}

/**
 * A lens flare from a light at `position` (comp pixels; `scale` = this picture's share of the comp): a glow,
 * `streak_count` rays, a halo ring split into its colours, ghosts along the axis through the frame's centre,
 * and dirt (the `dirt` input's luminance, or `dirt_spots` from the seed) lit by the light's falloff. Added to
 * `src` (its alpha kept); without one, the flare alone with its luminance as alpha.
 */
export function flareImage(src, dirt, p, W, H, scale) {
    const out = blank(W, H), o = out.data;
    const D = Math.hypot(W, H) * p.size;
    const pos = p.position || [W / scale / 2, H / scale / 2];
    const lx = pos[0] * scale, ly = pos[1] * scale, cx = W / 2, cy = H / 2;
    const tint = p.color || [1, 1, 1, 1], I = p.intensity;
    const Rg = p.glow_size * D, Rg2 = Rg * Rg;
    const nS = Math.round(p.streak_count), Ls = p.streak_length * D, Ws = Math.max(1e-3, p.streak_width * scale);
    const rays = [];
    for (let i = 0; i < nS; i++) { const a = ((p.streak_angle + (360 * i) / Math.max(1, nS)) * Math.PI) / 180; rays.push([Math.cos(a), Math.sin(a)]); }
    const Rh = p.halo_radius * D, Wh = Math.max(1e-3, p.halo_width * D);
    const ghosts = flareGhosts(p).map((g) => ({ ...g, x: lx + g.t * 2 * (cx - lx), y: ly + g.t * 2 * (cy - ly), R: Math.max(1e-3, g.r * p.ghost_size * D) }));
    const poly = p.ghost_shape === "polygon", nB = Math.max(3, Math.round(p.blades)), rot = (p.ghost_rotation * Math.PI) / 180;
    const soft = clamp01(p.ghost_softness);
    // The dirt map: the input's luminance, or the seed's spots stamped.
    let dm = null;
    if (p.dirt_amount > 0) {
        dm = new Float64Array(W * H);
        if (dirt) {
            const d = dirt.data;
            for (let i = 0; i < W * H; i++) dm[i] = LUM[0] * d[i * 4] + LUM[1] * d[i * 4 + 1] + LUM[2] * d[i * 4 + 2];
        } else {
            const diag = Math.hypot(W, H);
            for (const sp of dirtSpots(p)) {
                const sx = sp.x * W, sy = sp.y * H, r = sp.r * diag;
                const x0 = Math.max(0, Math.floor(sx - r)), x1 = Math.min(W - 1, Math.ceil(sx + r)), y0 = Math.max(0, Math.floor(sy - r)), y1 = Math.min(H - 1, Math.ceil(sy + r));
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const e = Math.hypot(x + 0.5 - sx, y + 0.5 - sy) / r;
                    dm[y * W + x] += sp.k * (1 - smooth(0.3, 1, e));
                }
            }
        }
    }
    const Rd = p.dirt_reach * D, Rd2 = Rd * Rd;
    const s = src ? src.data : null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - lx, dy = y + 0.5 - ly, r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
        let core = 0;
        if (p.glow_amount > 0) { const g = Rg2 / (Rg2 + r2); core += p.glow_amount * g * g; }
        if (p.streak_amount > 0) {
            for (const [ux, uy] of rays) {
                const along = dx * ux + dy * uy;
                if (along <= 0 || along >= Ls) continue;
                const perp = (-dx * uy + dy * ux) / Ws, f = 1 - along / Ls;
                core += p.streak_amount * Math.exp(-(perp * perp)) * f * f;
            }
        }
        const c = [core * tint[0], core * tint[1], core * tint[2]];
        if (p.halo_amount > 0) {
            for (let k = 0; k < 3; k++) {
                const e = (r - Rh * (1 + (k - 1) * 0.03)) / Wh;
                c[k] += p.halo_amount * tint[k] * Math.exp(-(e * e));
            }
        }
        if (p.ghost_amount > 0) {
            for (const g of ghosts) {
                const qx = x + 0.5 - g.x, qy = y + 0.5 - g.y;
                let rho = Math.sqrt(qx * qx + qy * qy) / g.R;
                if (rho >= 1.5) continue;
                if (poly) rho = rho / polyEdge(nB, rot, Math.atan2(qy, qx));
                const cover = (1 - smooth(1 - soft, 1, rho)) * (0.7 + 0.3 * (rho < 1 ? rho : 1));
                if (cover <= 0) continue;
                const k = p.ghost_amount * g.k * cover;
                c[0] += k * g.c[0]; c[1] += k * g.c[1]; c[2] += k * g.c[2];
            }
        }
        if (dm) {
            const lit = p.dirt_amount * dm[y * W + x] * (Rd2 / (Rd2 + r2));
            c[0] += lit * tint[0]; c[1] += lit * tint[1]; c[2] += lit * tint[2];
        }
        const i = (y * W + x) * 4;
        const fr = c[0] * I, fg = c[1] * I, fb = c[2] * I;
        if (s) { o[i] = s[i] + fr; o[i + 1] = s[i + 1] + fg; o[i + 2] = s[i + 2] + fb; o[i + 3] = s[i + 3]; }
        else { o[i] = fr; o[i + 1] = fg; o[i + 2] = fb; o[i + 3] = clamp01(LUM[0] * fr + LUM[1] * fg + LUM[2] * fb); }
    }
    return out;
}
