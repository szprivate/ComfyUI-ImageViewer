// A terrain's hand edits as data (imageViewer_terrainSculpt.js): sculpt offsets and layer paint.
// Run: node --test tests/test_terrain_sculpt.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    cleanSculpt, decodeSculpt, encodeSculpt, sculptDab, sculptEmpty, vertexAt, resampleVertexGrid,
    cleanLayerPaint, decodeLayerPaint, encodeLayerPaint, layerDab, layerAt, mixLayers, layerPaintEmpty, SCULPT_UNIT,
} from "../js/imageViewer_terrainSculpt.js";
import { terrainSettings, makeTerrainItem } from "../js/imageViewer_worldData.js";

const grid = (n, v = 0) => ({ res: n, cells: new Float32Array(n * n).fill(v) });

test("a sculpt goes round to the centimetre and a broken one reads as none", () => {
    const g = grid(9);
    g.cells[40] = 3.456; g.cells[0] = -12.3;
    const p = encodeSculpt(g);
    assert.deepEqual(cleanSculpt(p), p);
    const back = decodeSculpt(p);
    assert.ok(Math.abs(back.cells[40] - 3.46) < 1e-6);
    assert.ok(Math.abs(back.cells[0] + 12.3) < 1e-6);
    assert.equal(cleanSculpt({ res: 9, data: "AAAA" }), null);
    assert.equal(cleanSculpt(null), null);
    assert.ok(sculptEmpty(grid(5)));
    assert.ok(!sculptEmpty(back));
    // terrainSettings keeps both edits; a new terrain has neither.
    const t = makeTerrainItem("t");
    assert.equal(terrainSettings(t).sculpt, null);
    assert.equal(terrainSettings(t).layerPaint, null);
    assert.deepEqual(terrainSettings({ terrain: { sculpt: p } }).sculpt, p);
});

test("a sculpt read onto another grid keeps its shape", () => {
    const g = grid(5);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) g.cells[y * 5 + x] = x * 2;     // a ramp 0..8
    const r = resampleVertexGrid(g, 9);
    assert.equal(r.res, 9);
    assert.ok(Math.abs(vertexAt(r, 0.5, 0.3) - 4) < 1e-5);
    assert.ok(Math.abs(r.cells[8] - 8) < 1e-5);
    const d = decodeSculpt(encodeSculpt(g), 9);
    assert.ok(Math.abs(vertexAt(d, 0.25, 0.9) - 2) < 1e-3);
});

test("raise and lower move the ground under the brush only", () => {
    const g = grid(33), base = new Float32Array(33 * 33);
    const box = sculptDab(g, base, 0.5, 0.5, 0.1, 0.1, { tool: "raise", amount: 2, hardness: 0.5 });
    assert.ok(box);
    assert.ok(Math.abs(vertexAt(g, 0.5, 0.5) - 2) < 1e-6);
    assert.equal(vertexAt(g, 0.1, 0.1), 0);
    sculptDab(g, base, 0.5, 0.5, 0.1, 0.1, { tool: "lower", amount: 2, hardness: 0.5 });
    assert.ok(sculptEmpty(g, SCULPT_UNIT));
});

test("smooth pulls a spike down, flatten levels, restore takes the sculpt away", () => {
    const n = 33, base = new Float32Array(n * n);
    const g = grid(n);
    g.cells[16 * n + 16] = 10;
    sculptDab(g, base, 0.5, 0.5, 0.2, 0.2, { tool: "smooth", strength: 1, hardness: 0.9 });
    assert.ok(g.cells[16 * n + 16] < 2, `spike ${g.cells[16 * n + 16]}`);
    assert.ok(g.cells[16 * n + 17] > 0);
    // Flatten on a slope toward the height at its middle.
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) base[y * n + x] = x;
    const f = grid(n);
    for (let i = 0; i < 20; i++) sculptDab(f, base, 0.5, 0.5, 0.2, 0.2, { tool: "flatten", strength: 1, hardness: 0.9, to: 16 });
    assert.ok(Math.abs(base[16 * n + 14] + f.cells[16 * n + 14] - 16) < 0.01);
    const r = grid(n, 5);
    for (let i = 0; i < 20; i++) sculptDab(r, base, 0.5, 0.5, 0.3, 0.3, { tool: "restore", strength: 1, hardness: 0.9 });
    assert.ok(Math.abs(vertexAt(r, 0.5, 0.5)) < 0.01);
    assert.equal(vertexAt(r, 0.02, 0.02), 5);
});

test("layer paint lays one layer down, never past full, and erases back to the rules", () => {
    const g = decodeLayerPaint(null, 32);
    assert.ok(layerPaintEmpty(g));
    for (let i = 0; i < 10; i++) layerDab(g, 0.5, 0.5, 0.2, 0.2, { layer: 1, strength: 0.5, hardness: 0.8 });
    let p = layerAt(g, 0.5, 0.5);
    assert.ok(p[1] > 0.99 && p[0] === 0);
    layerDab(g, 0.5, 0.5, 0.2, 0.2, { layer: 2, strength: 0.6, hardness: 0.8 });
    p = layerAt(g, 0.5, 0.5);
    assert.ok(p[0] + p[1] + p[2] + p[3] <= 1 + 1e-6);
    assert.ok(Math.abs(p[2] - 0.6) < 0.01 && Math.abs(p[1] - 0.4) < 0.01);
    // The shown weights: paint over rules.
    const shown = mixLayers([1, 0, 0, 0], [0, 0.5, 0, 0]);
    assert.deepEqual(shown, [0.5, 0.5, 0, 0]);
    const back = decodeLayerPaint(encodeLayerPaint(g));
    assert.deepEqual(cleanLayerPaint(encodeLayerPaint(g)), encodeLayerPaint(g));
    assert.ok(Math.abs(layerAt(back, 0.5, 0.5)[2] - 0.6) < 0.01);
    for (let i = 0; i < 30; i++) layerDab(g, 0.5, 0.5, 0.3, 0.3, { strength: 1, hardness: 0.9, erase: true });
    assert.ok(layerPaintEmpty(g));
});
