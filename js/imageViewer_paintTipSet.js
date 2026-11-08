// Paint's built-in brush tips: drawn here, from numbers, when Paint starts - no picture files are shipped,
// so there is nothing of anybody else's in them and nothing to license (they are the viewer's own, under its
// licence). Each is a grey tip like an .abr's: { id, name, w, h, a (255 paints), spacing, builtin: true }.
// The same seed always gives the same tip, so a tip looks the same on every machine and in every session.

const SIDE = 128;

function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Value noise on a grid of `cells` (0..1, smooth), for grain. */
function noise(rand, w, h, cells) {
    const gw = cells + 2, g = new Float32Array(gw * gw);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const fx = (x / w) * cells, fy = (y / h) * cells, ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = smooth(0, 1, fx - ix), ty = smooth(0, 1, fy - iy);
        const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
        out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
    return out;
}

function fbm(rand, w, h, octaves = 4, base = 4) {
    const out = new Float32Array(w * h);
    let amp = 1, sum = 0;
    for (let o = 0; o < octaves; o++) {
        const n = noise(rand, w, h, base << o);
        for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
        sum += amp; amp /= 2;
    }
    for (let i = 0; i < out.length; i++) out[i] /= sum;
    return out;
}

/** A soft disc of radius r at (cx, cy) added (max) into a. */
function disc(a, w, h, cx, cy, r, v = 255, soft = 1) {
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const k = 1 - smooth(r - soft, r + soft * 0.5, d);
        if (k > 0) a[y * w + x] = Math.max(a[y * w + x], clamp(v * k));
    }
}

/** A thick line from (x0, y0) to (x1, y1), width wd, its ends round. */
function line(a, w, h, x0, y0, x1, y1, wd, v = 255) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) disc(a, w, h, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, wd / 2, v, 0.8);
}

/** A filled polygon (even-odd), antialiased 4 x 4 per pixel: each sub-row's crossings found once. */
function polygon(a, w, h, pts, v = 255) {
    const ys = pts.map((p) => p[1]);
    const Y0 = Math.max(0, Math.floor(Math.min(...ys))), Y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    const cover = new Float32Array(w);
    for (let y = Y0; y <= Y1; y++) {
        cover.fill(0);
        for (let sy = 0; sy < 4; sy++) {
            const py = y + (sy + 0.5) / 4, xs = [];
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                const [xi, yi] = pts[i], [xj, yj] = pts[j];
                if ((yi > py) !== (yj > py)) xs.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
            }
            xs.sort((p, q) => p - q);
            for (let k = 0; k + 1 < xs.length; k += 2) {
                for (let sx = 0; sx < w * 4; sx++) {
                    const px = (sx + 0.5) / 4;
                    if (px >= xs[k] && px < xs[k + 1]) cover[sx >> 2] += 1;
                }
            }
        }
        for (let x = 0; x < w; x++) if (cover[x]) a[y * w + x] = Math.max(a[y * w + x], clamp((v * cover[x]) / 16));
    }
}

const radial = (x, y, w, h) => Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / (Math.min(w, h) / 2);

// ── the set ─────────────────────────────────────────────────────────────────

const MAKERS = {
    /** A round tip whose edge is torn: a dry, hard pencil-like round. */
    rough(rand, w, h) {
        const a = new Uint8Array(w * h), n = fbm(rand, w, h, 4, 6);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const r = radial(x, y, w, h) + (n[y * w + x] - 0.5) * 0.35;
            a[y * w + x] = clamp(255 * (1 - smooth(0.78, 0.84, r)));
        }
        return a;
    },
    /** Chalk: a round full of holes that grow towards the edge. */
    chalk(rand, w, h) {
        const a = new Uint8Array(w * h), n = fbm(rand, w, h, 3, 16), g = noise(rand, w, h, 48);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x, r = radial(x, y, w, h);
            const keep = (n[i] * 0.6 + g[i] * 0.4) - r * 0.45;
            a[i] = r < 0.95 ? clamp(255 * smooth(0.12, 0.3, keep)) : 0;
        }
        return a;
    },
    /** Charcoal: grain stretched one way, soft at the ends. */
    charcoal(rand, w, h) {
        const a = new Uint8Array(w * h), n = fbm(rand, w, h, 4, 8), rows = new Float32Array(h);
        for (let y = 0; y < h; y += 2) rows[y] = rows[Math.min(h - 1, y + 1)] = rand();
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x, u = (x + 0.5) / w - 0.5, v = (y + 0.5) / h - 0.5;
            const streak = rows[y];
            const shape = 1 - smooth(0.32, 0.5, Math.abs(u)), edge = 1 - smooth(0.28, 0.48, Math.abs(v));
            a[i] = clamp(255 * shape * edge * smooth(0.3, 0.75, n[i] * 0.7 + streak * 0.3));
        }
        return a;
    },
    /** A sea sponge: blobs and holes, its outline uneven. */
    sponge(rand, w, h) {
        const a = new Uint8Array(w * h), n = fbm(rand, w, h, 3, 10), m = fbm(rand, w, h, 2, 3);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x, r = radial(x, y, w, h) + (m[i] - 0.5) * 0.5;
            a[i] = clamp(255 * smooth(0.45, 0.6, n[i]) * (1 - smooth(0.7, 0.85, r)));
        }
        return a;
    },
    /** Splatter: drops of every size, bigger ones near the middle. */
    splatter(rand, w, h) {
        const a = new Uint8Array(w * h);
        disc(a, w, h, w / 2, h / 2, w * 0.16, 255, 1.5);
        for (let k = 0; k < 70; k++) {
            const ang = rand() * Math.PI * 2, d = Math.pow(rand(), 0.7) * w * 0.46;
            const r = Math.max(0.7, (1 - d / (w * 0.5)) * w * 0.07 * rand() + 0.6);
            disc(a, w, h, w / 2 + Math.cos(ang) * d, h / 2 + Math.sin(ang) * d, r, 255, 1);
        }
        return a;
    },
    /** An airbrush's spray: many fine dots, densest in the middle. */
    spray(rand, w, h) {
        const a = new Uint8Array(w * h);
        for (let k = 0; k < 900; k++) {
            const ang = rand() * Math.PI * 2, d = Math.sqrt(-2 * Math.log(1 - rand() * 0.999)) * w * 0.15;
            if (d > w * 0.48) continue;
            disc(a, w, h, w / 2 + Math.cos(ang) * d, h / 2 + Math.sin(ang) * d, 0.6 + rand() * 0.9, 150 + rand() * 105, 0.7);
        }
        return a;
    },
    /** A flat bristle brush: hairs side by side, each its own length and strength. */
    bristle(rand, w, h) {
        const a = new Uint8Array(w * h), hairs = 26;
        for (let k = 0; k < hairs; k++) {
            const x = w * (0.12 + (0.76 * (k + rand() * 0.6)) / hairs), len = h * (0.55 + rand() * 0.35), v = 140 + rand() * 115;
            line(a, w, h, x, h / 2 - len / 2, x + (rand() - 0.5) * 3, h / 2 + len / 2, 2 + rand() * 2.5, v);
        }
        return a;
    },
    /** Hatching: parallel strokes at an angle. */
    hatch(rand, w, h) {
        const a = new Uint8Array(w * h);
        for (let k = -6; k <= 6; k++) {
            const o = k * w * 0.075, len = w * (0.62 - Math.abs(k) * 0.035) * (0.85 + rand() * 0.3);
            const cx = w / 2 + o * 0.7071, cy = h / 2 - o * 0.7071, dx = 0.7071 * len / 2, dy = 0.7071 * len / 2;
            line(a, w, h, cx - dx, cy - dy, cx + dx, cy + dy, 2.2, 230);
        }
        return a;
    },
    /** Grass: blades from the bottom, curving. */
    grass(rand, w, h) {
        const a = new Uint8Array(w * h);
        for (let k = 0; k < 22; k++) {
            const x0 = w * (0.15 + rand() * 0.7), tall = h * (0.4 + rand() * 0.5), bend = (rand() - 0.5) * w * 0.35;
            const n = 24;
            for (let i = 0; i < n; i++) {
                const t0 = i / n, t1 = (i + 1) / n;
                const p = (t) => [x0 + bend * t * t, h * 0.95 - tall * t];
                const [ax, ay] = p(t0), [bx, by] = p(t1);
                line(a, w, h, ax, ay, bx, by, Math.max(0.8, 4.5 * (1 - t0)), 255);
            }
        }
        return a;
    },
    /** Leaves: almond shapes turned every way, for foliage. */
    leaves(rand, w, h) {
        const a = new Uint8Array(w * h);
        for (let k = 0; k < 9; k++) {
            const cx = w * (0.22 + rand() * 0.56), cy = h * (0.22 + rand() * 0.56), L = w * (0.14 + rand() * 0.1);
            const ang = rand() * Math.PI * 2, pts = [];
            for (let i = 0; i < 32; i++) {
                const t = (i / 32) * Math.PI * 2, x = Math.cos(t) * L, y = Math.sin(t) * Math.pow(Math.abs(Math.sin(t)), 0.6) * L * 0.4;
                pts.push([cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]);
            }
            polygon(a, w, h, pts, 200 + rand() * 55);
        }
        return a;
    },
    /** A five-pointed star. */
    star(rand, w, h) {
        const a = new Uint8Array(w * h), pts = [];
        for (let i = 0; i < 10; i++) {
            const t = -Math.PI / 2 + (i * Math.PI) / 5, r = (i % 2 ? 0.2 : 0.47) * w;
            pts.push([w / 2 + Math.cos(t) * r, h / 2 + Math.sin(t) * r]);
        }
        polygon(a, w, h, pts);
        return a;
    },
    /** A hard square, for pixel-like and block work. */
    square(rand, w, h) {
        const a = new Uint8Array(w * h);
        polygon(a, w, h, [[w * 0.1, h * 0.1], [w * 0.9, h * 0.1], [w * 0.9, h * 0.9], [w * 0.1, h * 0.9]]);
        return a;
    },
    /** Clouds: soft billows, for skies and smoke. */
    clouds(rand, w, h) {
        const a = new Uint8Array(w * h), n = fbm(rand, w, h, 5, 3);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x, r = radial(x, y, w, h);
            a[i] = clamp(255 * smooth(0.35, 0.7, n[i] + 0.35 - r * 0.55) * (1 - smooth(0.85, 1, r)));
        }
        return a;
    },
    /** Canvas texture: a woven grain, for a dry brush on canvas. */
    canvas(rand, w, h) {
        const a = new Uint8Array(w * h), n = noise(rand, w, h, 20);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x, r = radial(x, y, w, h);
            const weave = (Math.sin((x / w) * Math.PI * 28) * Math.sin((y / h) * Math.PI * 28) + 1) / 2;
            a[i] = clamp(255 * smooth(0.3, 0.65, weave * 0.6 + n[i] * 0.4) * (1 - smooth(0.82, 0.95, r)));
        }
        return a;
    },
};

/** The built-in set, in the order shown: [key, name, spacing %]. */
export const BUILTIN_TIPS = [
    ["rough", "Rough round", 10], ["chalk", "Chalk", 15], ["charcoal", "Charcoal", 12], ["sponge", "Sponge", 30],
    ["splatter", "Splatter", 60], ["spray", "Spray", 25], ["bristle", "Flat bristle", 6], ["hatch", "Hatching", 70],
    ["grass", "Grass", 45], ["leaves", "Leaves", 55], ["star", "Star", 110], ["square", "Square", 25],
    ["clouds", "Clouds", 30], ["canvas", "Canvas grain", 20],
];

/** One built-in tip by its key (an id `builtin:<key>`), drawn now. */
export function makeBuiltinTip(key, side = SIDE) {
    const row = BUILTIN_TIPS.find((r) => r[0] === key);
    if (!row) return null;
    let seed = 0;
    for (const ch of key) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
    const a = MAKERS[key](rng(seed), side, side);
    return { id: "builtin:" + key, name: row[1], w: side, h: side, a, spacing: row[2], builtin: true };
}

/** The whole set, drawn now (about 40 ms). */
export function builtinTips(side = SIDE) {
    return BUILTIN_TIPS.map(([k]) => makeBuiltinTip(k, side));
}
