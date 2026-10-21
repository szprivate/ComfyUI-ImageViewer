// bEpicViewer_eulerFilter.js
// The Euler filter for a rotation track (XYZ degrees, three.js order R = Rx*Ry*Rz).
//
// An orientation has two Euler solutions that make the same matrix:
//     (x, y, z)   and   (x + 180, 180 - y, z + 180)
// and each channel can also be shifted by whole turns. Keys that picked
// different ones of these look the same on screen but interpolate through a
// wild swing. Walking the keys in time order, each key after the first takes
// whichever solution — with every channel unwrapped to within 180 degrees of
// the previous (already filtered) key — lies closest to that key. No pose
// changes; only the numbers do.
//
// TANGENTS: slopes (`ti` / `to`) belong to a particular numbering of the angle.
// A key that only moved by whole turns keeps its slopes unchanged (a constant
// shift does not change a slope). A key that flipped to the other solution has
// slopes that no longer mean anything, so they are dropped and the key falls
// back to what its `ease` implies.

function unwrap(a, ref) {
    while (a - ref > 180) a -= 360;
    while (a - ref < -180) a += 360;
    return a;
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

/**
 * @param {Array<{f:number, v:number[]}>} keys  rotation keys (any order)
 * @returns {{keys: Array, changed: number}}  new keys sorted by frame; `changed`
 *          counts keys whose numbers differ from the input.
 */
export function eulerFilter(keys) {
    const sorted = (keys || []).slice().sort((a, b) => a.f - b.f);
    const out = [];
    let changed = 0;
    let prev = null;
    for (const key of sorted) {
        const k = { ...key, v: key.v.slice() };
        if (key.ti !== undefined) k.ti = Array.isArray(key.ti) ? key.ti.slice() : key.ti;
        if (key.to !== undefined) k.to = Array.isArray(key.to) ? key.to.slice() : key.to;
        if (prev && Array.isArray(k.v) && k.v.length === 3) {
            const [x, y, z] = key.v;
            const dist = (c) => c.reduce((s, a, i) => s + (a - prev[i]) ** 2, 0);
            const cands = [[x, y, z], [x + 180, 180 - y, z + 180]]
                .map((c) => c.map((a, i) => unwrap(a, prev[i])));
            const flipped = dist(cands[1]) < dist(cands[0]);
            k.v = flipped ? cands[1] : cands[0];
            if (flipped) { delete k.ti; delete k.to; }
        }
        if (!key.v.every((a, i) => close(a, k.v[i]))) changed++;   // dropped slopes imply a changed v
        prev = k.v;
        out.push(k);
    }
    return { keys: out, changed };
}
