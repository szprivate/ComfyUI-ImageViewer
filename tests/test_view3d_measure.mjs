// The measure tool's numbers and words (js/imageViewer_view3dMeasure.js).
// Run: node --test tests/test_view3d_measure.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { formatLength, formatAngle, angleAt, measureReadout, readoutLines } from "../js/imageViewer_view3dMeasure.js";

test("lengths read in the unit that suits them", () => {
    assert.equal(formatLength(1.23456), "1.235 m");
    assert.equal(formatLength(12.3456), "12.35 m");
    assert.equal(formatLength(0.254), "25.4 cm");
    assert.equal(formatLength(0.0042), "4.2 mm");
    assert.equal(formatLength(2500), "2.5 km");
    assert.equal(formatLength(-0.5), "-50 cm");
    assert.equal(formatLength(0), "0 m");
    assert.equal(formatAngle(90.04), "90°");
});

test("the angle between two stretches", () => {
    assert.equal(Math.round(angleAt([1, 0, 0], [0, 0, 0], [0, 0, 1])), 90);
    assert.equal(Math.round(angleAt([1, 0, 0], [0, 0, 0], [-1, 0, 0])), 180);
    assert.equal(angleAt([0, 0, 0], [0, 0, 0], [1, 0, 0]), null);
});

test("a chain: lengths, angles, total, rise", () => {
    const r = measureReadout([[0, 0, 0], [3, 0, 0], [3, 4, 0]]);
    assert.equal(r.segments.length, 2);
    assert.equal(r.segments[0].length, 3);
    assert.equal(r.segments[1].length, 4);
    assert.equal(r.total, 7);
    assert.equal(Math.round(r.angles[0].deg), 90);
    assert.equal(r.rise, 4);
    assert.equal(r.flat, 3);
    assert.equal(Math.round(r.slope * 100) / 100, Math.round(Math.atan2(4, 3) * 180 / Math.PI * 100) / 100);
    const one = readoutLines([[0, 0, 0], [0.3, 0, 0.4]]);
    assert.equal(one[0], "Distance 50 cm");
    assert.equal(readoutLines([[0, 0, 0]])[0], "Click the next point");
    assert.deepEqual(readoutLines([]), []);
    const two = readoutLines([[0, 0, 0], [3, 0, 0], [3, 4, 0]]);
    assert.ok(two.includes("Angle at point 2: 90°"));
    assert.ok(two[0].startsWith("Total 7 m"));
});
