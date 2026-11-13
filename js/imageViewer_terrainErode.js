// imageViewer_terrainErode.js
// Terrain erosion, the reference: hydraulic (rain, water flowing downhill through "pipes"
// between neighbouring cells, sediment picked up where water runs fast and steep and dropped
// where it slows) and thermal (material sliding off slopes steeper than a talus angle).
//
// Written from the published descriptions of the methods (the virtual-pipe shallow-water model
// of Mei, Decaudin and Hu, 2007, and the classic talus-angle thermal weathering), not from any
// existing code. Clean-room.
//
// The simulation runs in grid units: a cell is 1 wide, heights are metres / cell size, so the
// same settings behave the same on a small and a large terrain. Every step is a fixed list of
// passes over the whole grid, each reading only what the passes before it wrote - exactly what
// the GPU version (imageViewer_terrainErodeGpu.js) runs as one shader per pass, so the two can be
// compared cell by cell. Pure: no DOM, no three.js; tests in tests/test_terrain_erode.mjs.
//
// Boundaries: the rim drains. Outside the grid the ground is as high as the rim cell and dry,
// so water at the rim runs off and takes its sediment with it.

export const ERODE_DEFAULTS = {
    mode: "both",            // "hydraulic" | "thermal" | "both"
    iterations: 1000,
    dt: 0.05,
    rain: 0.012,             // water added per cell per unit time
    evaporation: 0.5,        // share of the water gone per unit time
    capacity: 0.5,           // sediment the water can carry, per unit speed and slope
    dissolve: 0.15,          // how fast it picks sediment up
    deposit: 0.15,           // how fast it drops it
    minSlope: 0.05,          // even flat ground erodes a little where water runs
    talus: 35,               // degrees: steeper than this slides (thermal)
    thermal: 0.5,            // how fast it slides
};

export const ERODE_MODES = ["hydraulic", "thermal", "both"];
// Every hydraulic step ends with banks steeper than this caving in.
export const BANK_ANGLE = 55;
export const BANK_RATE = 2;
export const GRAVITY = 9.81;

const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** Settings held to their ranges. */
export function cleanErode(o = {}) {
    const d = ERODE_DEFAULTS;
    return {
        mode: ERODE_MODES.includes(o.mode) ? o.mode : d.mode,
        iterations: Math.round(num(o.iterations, d.iterations, 1, 100000)),
        dt: num(o.dt, d.dt, 0.001, 0.2),
        rain: num(o.rain, d.rain, 0, 1),
        evaporation: num(o.evaporation, d.evaporation, 0, 10),
        capacity: num(o.capacity, d.capacity, 0, 20),
        dissolve: num(o.dissolve, d.dissolve, 0, 5),
        deposit: num(o.deposit, d.deposit, 0, 5),
        minSlope: num(o.minSlope, d.minSlope, 0, 1),
        talus: num(o.talus, d.talus, 1, 89),
        thermal: num(o.thermal, d.thermal, 0, 5),
    };
}

/**
 * A simulation's state for an n x n grid of heights `b` (grid units). Arrays per field:
 * b ground, d water, s sediment, f outflow (4 per cell: left, right, up = y-1, down = y+1),
 * u / v water velocity, and the masks: flow (water speed x depth, summed), dep (deposited),
 * ero (eroded), wet (deepest water seen).
 */
export function makeState(n, b) {
    const N = n * n;
    return {
        n, b: Float32Array.from(b), d: new Float32Array(N), s: new Float32Array(N), f: new Float32Array(N * 4),
        u: new Float32Array(N), v: new Float32Array(N),
        flow: new Float32Array(N), dep: new Float32Array(N), ero: new Float32Array(N), wet: new Float32Array(N),
        steps: 0,
    };
}

const at = (a, n, x, y) => a[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];

/** One step of the simulation (hydraulic, then thermal, as `opts.mode` says). */
export function erodeStep(st, opts) {
    const o = opts;
    if (o.mode !== "thermal") {
        hydraulicStep(st, o);
        // Banks too steep to stand cave in, so cut channels stay channels and not slots.
        thermalStep(st, { dt: o.dt, thermal: BANK_RATE, talus: BANK_ANGLE });
    }
    if (o.mode !== "hydraulic") thermalStep(st, o);
    st.steps += 1;
}

export function hydraulicStep(st, o) {
    const { n, b, f } = st;
    const N = n * n, dt = o.dt;
    // 1. Rain.
    const d1 = new Float32Array(N);
    for (let i = 0; i < N; i++) d1[i] = st.d[i] + dt * o.rain;
    // 2. Outflow through the four pipes, from the difference in water level; scaled so a cell
    //    never sends more than it holds. Off the grid: the rim cell's own ground, dry.
    const f2 = new Float32Array(N * 4);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x, H = b[i] + d1[i];
            const lvl = (xx, yy) => (xx < 0 || yy < 0 || xx >= n || yy >= n ? b[i] : b[yy * n + xx] + d1[yy * n + xx]);
            const fl = Math.max(0, f[i * 4] + dt * GRAVITY * (H - lvl(x - 1, y)));
            const fr = Math.max(0, f[i * 4 + 1] + dt * GRAVITY * (H - lvl(x + 1, y)));
            const fu = Math.max(0, f[i * 4 + 2] + dt * GRAVITY * (H - lvl(x, y - 1)));
            const fd = Math.max(0, f[i * 4 + 3] + dt * GRAVITY * (H - lvl(x, y + 1)));
            const sum = fl + fr + fu + fd;
            const k = sum > 0 ? Math.min(1, d1[i] / (sum * dt)) : 0;
            f2[i * 4] = fl * k; f2[i * 4 + 1] = fr * k; f2[i * 4 + 2] = fu * k; f2[i * 4 + 3] = fd * k;
        }
    }
    // 3. Water moved; velocity from the water passing through.
    const fin = (xx, yy, k) => (xx < 0 || yy < 0 || xx >= n || yy >= n ? 0 : f2[(yy * n + xx) * 4 + k]);
    const d2 = new Float32Array(N);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x;
            const inflow = fin(x - 1, y, 1) + fin(x + 1, y, 0) + fin(x, y - 1, 3) + fin(x, y + 1, 2);
            const out = f2[i * 4] + f2[i * 4 + 1] + f2[i * 4 + 2] + f2[i * 4 + 3];
            d2[i] = Math.max(0, d1[i] + dt * (inflow - out));
            const wx = (fin(x - 1, y, 1) - f2[i * 4] + f2[i * 4 + 1] - fin(x + 1, y, 0)) / 2;
            const wy = (fin(x, y - 1, 3) - f2[i * 4 + 2] + f2[i * 4 + 3] - fin(x, y + 1, 2)) / 2;
            const dm = (d1[i] + d2[i]) / 2;
            st.u[i] = dm > 1e-4 ? wx / dm : 0;
            st.v[i] = dm > 1e-4 ? wy / dm : 0;
        }
    }
    st.f = f2;
    // 4. Erosion and deposition: what the water could carry, from its speed and the slope.
    const b2 = new Float32Array(N), s2 = new Float32Array(N);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x;
            const gx = (at(b, n, x + 1, y) - at(b, n, x - 1, y)) / 2, gy = (at(b, n, x, y + 1) - at(b, n, x, y - 1)) / 2;
            const g2 = gx * gx + gy * gy;
            const sin = Math.sqrt(g2 / (1 + g2));
            const speed = Math.hypot(st.u[i], st.v[i]);
            const cap = o.capacity * Math.max(sin, o.minSlope) * speed * Math.min(1, d2[i] * 4);
            let bb = b[i], ss = st.s[i];
            if (cap > ss) {
                // Never below the lowest neighbour: water cuts channels, it does not dig pits.
                let lo = bb;
                for (const [dx, dy] of NB) lo = Math.min(lo, at(b, n, x + dx, y + dy));
                const a = Math.min(dt * o.dissolve * (cap - ss), Math.max(0, bb - lo));
                bb -= a; ss += a; st.ero[i] += a;
            } else {
                const a = dt * o.deposit * (ss - cap);
                bb += a; ss -= a; st.dep[i] += a;
            }
            b2[i] = bb; s2[i] = ss;
            st.flow[i] += speed * d2[i] * dt;
            if (d2[i] > st.wet[i]) st.wet[i] = d2[i];
        }
    }
    // 5. The sediment travels with the water (read back along the velocity, between cells);
    //    the water evaporates.
    const s3 = new Float32Array(N);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x;
            st.d[i] = d2[i] * Math.max(0, 1 - o.evaporation * dt);
            const px = x - st.u[i] * dt, py = y - st.v[i] * dt;
            if (px < 0 || py < 0 || px > n - 1 || py > n - 1) { s3[i] = 0; continue; }       // from off the grid: clear water
            const x0 = Math.min(n - 2, Math.floor(px)), y0 = Math.min(n - 2, Math.floor(py));
            const tx = px - x0, ty = py - y0;
            s3[i] = (s2[y0 * n + x0] * (1 - tx) + s2[y0 * n + x0 + 1] * tx) * (1 - ty)
                  + (s2[(y0 + 1) * n + x0] * (1 - tx) + s2[(y0 + 1) * n + x0 + 1] * tx) * ty;
        }
    }
    st.b = b2;
    st.s = s3;
}

const NB = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2]];

/**
 * Thermal weathering: between every two neighbours, the part of their difference above the
 * talus slope moves from the higher to the lower, half of it a unit of time. Pairwise and
 * symmetric, so nothing is made or lost.
 */
export function thermalStep(st, o) {
    const { n, b } = st;
    const T = Math.tan(o.talus * Math.PI / 180);
    const k = Math.min(1, o.dt * o.thermal) / 8;
    const b2 = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x, h = b[i];
            let delta = 0;
            for (const [dx, dy, dist] of NB) {
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
                const hn = b[yy * n + xx], lim = T * dist;
                delta += Math.max(0, hn - h - lim) - Math.max(0, h - hn - lim);
            }
            b2[i] = h + delta * k * 0.5;
        }
    }
    st.b = b2;
}

/** Run `count` steps. */
export function erode(st, opts, count) {
    const o = cleanErode(opts);
    for (let i = 0; i < count; i++) erodeStep(st, o);
    return st;
}

/**
 * The masks, each 0..1 over the grid: flow (where water ran, a log scale so the small
 * gullies show beside the rivers), deposit, erosion and wetness, plus "dry" (1 - wetness).
 */
export function erodeMasks(st) {
    const N = st.n * st.n;
    const norm = (a, log = false) => {
        const out = new Float32Array(N);
        let hi = 0;
        for (let i = 0; i < N; i++) { const v = log ? Math.log1p(a[i] * 50) : a[i]; out[i] = v; if (v > hi) hi = v; }
        if (hi > 0) for (let i = 0; i < N; i++) out[i] = Math.min(1, out[i] / hi);
        return out;
    };
    const wet = norm(st.wet, true);
    return { flow: norm(st.flow, true), deposit: norm(st.dep, true), erosion: norm(st.ero, true), wetness: wet,
             dry: wet.map((w) => 1 - w) };
}

export const MASK_KINDS = ["flow", "deposit", "erosion", "wetness", "dry"];

/** A vertex-aligned mask (n x n) onto a cell-centred grid of `res` (a scatter's paint). */
export function maskToCells(mask, n, res) {
    const out = new Float32Array(res * res);
    for (let y = 0; y < res; y++) {
        const fy = ((y + 0.5) / res) * (n - 1), y0 = Math.min(n - 2, Math.floor(fy)), ty = fy - y0;
        for (let x = 0; x < res; x++) {
            const fx = ((x + 0.5) / res) * (n - 1), x0 = Math.min(n - 2, Math.floor(fx)), tx = fx - x0;
            out[y * res + x] = (mask[y0 * n + x0] * (1 - tx) + mask[y0 * n + x0 + 1] * tx) * (1 - ty)
                             + (mask[(y0 + 1) * n + x0] * (1 - tx) + mask[(y0 + 1) * n + x0 + 1] * tx) * ty;
        }
    }
    return out;
}

/** Total ground plus sediment (what hydraulic erosion keeps, but for what the rim lets run off). */
export function material(st) {
    let t = 0;
    for (let i = 0; i < st.b.length; i++) t += st.b[i] + st.s[i];
    return t;
}

// ── Into the terrain ─────────────────────────────────────────────────────

/**
 * The sculpt that makes a terrain's generated heights `base` (n x n, as shares of `height`
 * metres) into `heights` (metres): {res, cells} in metres, and the unit to store it in (the
 * sculpt's 1 cm, larger only where 16 bits of centimetres would not reach).
 */
export function erodedSculpt(heights, base, height, n) {
    const cells = new Float32Array(n * n);
    let hi = 0;
    for (let i = 0; i < cells.length; i++) {
        cells[i] = heights[i] - base[i] * height;
        hi = Math.max(hi, Math.abs(cells[i]));
    }
    const unit = Math.max(0.01, Math.ceil((hi / 32000) * 1000) / 1000);
    return { grid: { res: n, cells }, unit };
}

/**
 * Layer paint (4 weights a cell, cell centres, `res` a side) with rock laid where the water
 * wore the ground away and ground where it laid sediment down, `strength` 0..1, over the
 * paint there was (`prev`, the same shape, or null). Layers: 0 ground, 1 rock.
 */
export function erodedLayerPaint(masks, n, res, strength = 1, prev = null) {
    const ero = maskToCells(masks.erosion, n, res), dep = maskToCells(masks.deposit, n, res);
    const out = new Float32Array(res * res * 4);
    const s = Math.min(1, Math.max(0, strength));
    for (let i = 0; i < res * res; i++) {
        // A soft knee: the faint traces stay with the rules, the clear ones take over.
        const r = smooth(ero[i]) * s, g = smooth(dep[i]) * s;
        const add = Math.min(1, r + g), k = r + g > 1 ? 1 / (r + g) : 1;
        for (let c = 0; c < 4; c++) out[i * 4 + c] = prev ? prev[i * 4 + c] * (1 - add) : 0;
        out[i * 4] += g * k;
        out[i * 4 + 1] += r * k;
    }
    return out;
}

const smooth = (x) => { const t = Math.min(1, Math.max(0, (x - 0.15) / 0.6)); return t * t * (3 - 2 * t); };
