// node --test tests/test_euler_filter.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { eulerFilter } from "../js/bEpicViewer_eulerFilter.js";

const rad = (d) => (d * Math.PI) / 180;
// three.js Euler XYZ -> matrix, R = Rx * Ry * Rz
function mat([x, y, z]) {
    const [a, b, c] = [x, y, z].map(rad);
    const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
    return [cb * cc, -cb * sc, sb,
            ca * sc + cc * sa * sb, ca * cc - sa * sb * sc, -cb * sa,
            sa * sc - ca * cc * sb, cc * sa + ca * sb * sc, ca * cb];
}

test("flipped sequence becomes continuous, poses unchanged", () => {
    const keys = [[-106.514, -69.045, -107.613], [-148.845, 47.18, -203.914], [-30.276, 45.672, -337.334]]
        .map((v, i) => ({ f: i * 10, v, ease: "smooth" }));
    const { keys: out, changed } = eulerFilter(keys);
    assert.ok(changed >= 1);
    for (let i = 0; i < out.length; i++) {
        const a = mat(keys[i].v), b = mat(out[i].v);
        a.forEach((n, j) => assert.ok(Math.abs(n - b[j]) < 1e-6, `matrix ${i}`));
        if (i) for (let c = 0; c < 3; c++) assert.ok(Math.abs(out[i].v[c] - out[i - 1].v[c]) <= 180, `step ${i}.${c}`);
    }
    assert.deepEqual(out[0].v, keys[0].v);
});

test("already smooth keys are untouched; flipped keys lose their slopes", () => {
    const smooth = [{ f: 0, v: [0, 10, 0] }, { f: 5, v: [5, 12, 1] }];
    assert.equal(eulerFilter(smooth).changed, 0);
    const keys = [{ f: 0, v: [10, 20, 30] }, { f: 5, v: [190, 160, 210], ti: [1, 1, 1], to: [1, 1, 1] }];
    const { keys: out, changed } = eulerFilter(keys);
    assert.equal(changed, 1);
    assert.deepEqual(out[1].v, [10, 20, 30]);
    assert.equal(out[1].ti, undefined);
});

test("whole-turn unwrap keeps slopes", () => {
    const keys = [{ f: 0, v: [0, 0, 0] }, { f: 5, v: [0, 0, 350], ti: [0, 0, 2] }];
    const { keys: out } = eulerFilter(keys);
    assert.deepEqual(out[1].v, [0, 0, -10]);
    assert.deepEqual(out[1].ti, [0, 0, 2]);
});
