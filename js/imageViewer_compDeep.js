// imageViewer_compDeep.js
// Comp's deep pictures: per pixel any number of samples, each a premultiplied colour at a depth. Plain ES module,
// imports nothing; the numpy twin is src/comp_deep.py (tests/test_comp_parity.py compares them).
//
// A DEEP picture is {w, h, n, s}: n = Uint32Array(w*h), the samples of each pixel; s = Float32Array, six numbers a
// sample (r, g, b, a, z, zback), pixel after pixel top-left first, each pixel's samples front first (z ascending;
// at one depth they keep the order they came in). A sample with zback > z is a slab; the nodes here treat every
// sample as lying at its front z (a slab is not split where another sample falls inside it).

export const SAMPLE = 6;

export const emptyDeep = (w, h) => ({ w, h, n: new Uint32Array(w * h), s: new Float32Array(0) });

/** Where each pixel's samples start in s (in samples), with the total at the end. */
export function offsets(d) {
    const o = new Uint32Array(d.w * d.h + 1);
    for (let i = 0; i < d.w * d.h; i++) o[i + 1] = o[i] + d.n[i];
    return o;
}

/** Lists of samples per pixel -> a deep picture (each list already front first). */
function pack(w, h, lists) {
    const n = new Uint32Array(w * h);
    let tot = 0;
    for (let i = 0; i < w * h; i++) { n[i] = lists[i].length; tot += lists[i].length; }
    const s = new Float32Array(tot * SAMPLE);
    let k = 0;
    for (let i = 0; i < w * h; i++) for (const p of lists[i]) { for (let c = 0; c < SAMPLE; c++) s[k * SAMPLE + c] = p[c]; k++; }
    return { w, h, n, s };
}

function unpack(d) {
    const o = offsets(d), lists = new Array(d.w * d.h);
    for (let i = 0; i < d.w * d.h; i++) {
        const l = [];
        for (let k = o[i]; k < o[i + 1]; k++) l.push(Array.from(d.s.subarray(k * SAMPLE, (k + 1) * SAMPLE)));
        lists[i] = l;
    }
    return lists;
}

const sortSamples = (l) => {
    // stable: at one depth the earlier sample stays first
    for (let i = 1; i < l.length; i++) { const p = l[i]; let j = i; while (j > 0 && l[j - 1][4] > p[4]) { l[j] = l[j - 1]; j--; } l[j] = p; }
    return l;
};

/** A deep picture from a flat one: one sample a pixel that holds anything, at its depth (> 0) or at `z`. */
export function deepFromImage(img, depth, z) {
    const lists = new Array(img.w * img.h), d = img.data;
    for (let i = 0; i < img.w * img.h; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
        if (r === 0 && g === 0 && b === 0 && a === 0) { lists[i] = []; continue; }
        const zz = depth && depth[i] > 0 ? depth[i] : z;
        lists[i] = [[r, g, b, a, zz, zz]];
    }
    return pack(img.w, img.h, lists);
}

/** Every sample of every input, per pixel, front first (the inputs all w x h). */
export function deepMerge(list) {
    const d0 = list[0], ls = list.map(unpack), out = new Array(d0.w * d0.h);
    for (let i = 0; i < d0.w * d0.h; i++) out[i] = sortSamples([].concat(...ls.map((l) => l[i])));
    return pack(d0.w, d0.h, out);
}

/** `src`'s samples dimmed by what of `hold` lies in front of each (hold's own samples are not kept). */
export function deepHoldout(src, hold) {
    const a = unpack(src), b = unpack(hold), out = new Array(src.w * src.h);
    for (let i = 0; i < src.w * src.h; i++) {
        out[i] = a[i].map((p) => {
            let t = 1;
            for (const q of b[i]) { if (q[4] < p[4]) t = t * (1 - q[3]); else break; }
            return [p[0] * t, p[1] * t, p[2] * t, p[3] * t, p[4], p[5]];
        });
    }
    return pack(src.w, src.h, out);
}

/** The samples with znear <= z <= zfar (zfar <= 0: no far limit); `outside` keeps the others instead. */
export function deepCrop(d, znear, zfar, outside) {
    const ls = unpack(d);
    return pack(d.w, d.h, ls.map((l) => l.filter((p) => ((p[4] >= znear && (zfar <= 0 || p[4] <= zfar)) !== !!outside))));
}

/** Every pixel's samples laid front to back with "over": {img, depth} (depth: the front sample with alpha, 0: none). */
export function deepFlatten(d) {
    const o = offsets(d), W = d.w, H = d.h;
    const img = { w: W, h: H, data: new Float32Array(W * H * 4) }, depth = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        let r = 0, g = 0, b = 0, a = 0, t = 1, z = 0;
        for (let k = o[i]; k < o[i + 1]; k++) {
            const s = d.s, q = k * SAMPLE;
            r += t * s[q]; g += t * s[q + 1]; b += t * s[q + 2]; a += t * s[q + 3];
            if (z === 0 && s[q + 3] > 0) z = s[q + 4];
            t = t * (1 - s[q + 3]);
        }
        img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
        depth[i] = z;
    }
    return { img, depth };
}

/**
 * A deep file's picture (sw x sh, its own size) laid into the comp's (cw x ch) with its bottom left on the bottom
 * left, as `scale` x the comp: each pixel takes the samples of the file's pixel under its middle.
 */
export function deepPlace(src, cw, ch, scale) {
    const W = Math.max(1, Math.round(cw * scale)), H = Math.max(1, Math.round(ch * scale));
    const o = offsets(src), lists = new Array(W * H);
    for (let y = 0; y < H; y++) {
        const sy = Math.floor((y + 0.5) / scale) - (ch - src.h);
        for (let x = 0; x < W; x++) {
            const sx = Math.floor((x + 0.5) / scale), l = [];
            if (sx >= 0 && sy >= 0 && sx < src.w && sy < src.h) {
                const i = sy * src.w + sx;
                for (let k = o[i]; k < o[i + 1]; k++) l.push(Array.from(src.s.subarray(k * SAMPLE, (k + 1) * SAMPLE)));
            }
            lists[y * W + x] = l;
        }
    }
    return pack(W, H, lists);
}

/** A deep picture as the routes send it: counts (uint32 w*h) then the samples (float32, six each), little endian. */
export function decodeDeep(buf, w, h) {
    const n = new Uint32Array(buf.slice(0, w * h * 4));
    return { w, h, n, s: new Float32Array(buf.slice(w * h * 4)) };
}
