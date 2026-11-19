// The matchmove's measurements, camera list and pixel aspect (js/imageViewer_matchmoveData.js) and the lens
// chart's layout (js/imageViewer_lensChart.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_matchmoveData.js";
import { chartLayout, chartDark, CHART_COLUMNS } from "../js/imageViewer_lensChart.js";

const plate = { path: "/p/IMG_0001.mov", frames: 50, width: 1920, height: 1080, fps: 30 };
const withTracks = (ids) => {
    const mm = D.newMatchmove(plate);
    for (const id of ids) mm.tracks.push({ id, name: id, group: "camera", on: true, keys: [[0, 1, 2, 1]] });
    return mm;
};

test("measurements need the right number of tracks, and a distance its metres", () => {
    const mm = withTracks(["t1", "t2", "t3", "t4"]);
    assert.match(D.addConstraint(mm, "distance", ["t1"], 2).error, /exactly 2/);
    assert.match(D.addConstraint(mm, "distance", ["t1", "t2"], null).error, /metres/);
    assert.match(D.addConstraint(mm, "plane", ["t1", "t2"]).error, /3 or more/);
    assert.match(D.addConstraint(mm, "right", ["t1", "t2", "t3", "t4"]).error, /exactly 3/);
    const d = D.addConstraint(mm, "distance", ["t1", "t2"], 1.5).constraint;
    const r = D.addConstraint(mm, "right", ["t3", "t1", "t2"]).constraint;
    assert.deepEqual(r.ids, ["t3", "t1", "t2"]);          // the order picked: end, corner, end
    D.addConstraint(mm, "plane", ["t1", "t2", "t3", "t4"]);
    const back = D.cleanMatchmove(JSON.parse(JSON.stringify(mm)));
    assert.deepEqual(back.constraints, mm.constraints);
    assert.equal(back.constraints[0].value, 1.5);
    // a track deleted: the plane keeps three, the distance and the right angle go
    D.removeTracks(mm, ["t2"]);
    assert.deepEqual(mm.constraints.map((c) => c.kind), ["plane"]);
    assert.deepEqual(mm.constraints[0].ids, ["t1", "t3", "t4"]);
    assert.ok(d.id && r.id && d.id !== r.id);
});

test("the clean-up buttons leave measured tracks alone", () => {
    const mm = withTracks(["t1", "t2", "t3"]);
    D.addConstraint(mm, "distance", ["t1", "t2"], 3);
    assert.deepEqual(D.withoutMeasured(mm, ["t1", "t3"]), ["t3"]);
});

test("a camera preset sets the sensor, a phone its 35 mm equivalent on the plate's shape", () => {
    const mm = D.newMatchmove(plate);
    D.applyCameraPreset(mm, "iphone14-wide");
    assert.equal(mm.camera.focalMm, 26);
    assert.ok(mm.camera.focalKnown);
    const diag = Math.hypot(mm.camera.sensor[0], mm.camera.sensor[1]);
    assert.ok(Math.abs(diag - Math.hypot(36, 24)) < 0.01, String(diag));
    assert.ok(Math.abs(mm.camera.sensor[0] / mm.camera.sensor[1] - 16 / 9) < 0.01);
    // 26 mm eq. on a 16:9 picture: about 72 degrees across
    const fh = 2 * Math.atan(1920 / 2 / D.focalPx(mm)) * 180 / Math.PI;
    assert.ok(Math.abs(fh - 71.9) < 0.3, String(fh));
    D.applyCameraPreset(mm, "anamorphic2");
    assert.equal(D.pixelAspect(mm), 2);
    assert.deepEqual(mm.camera.sensor, [24.89, 18.66]);
    D.applyCameraPreset(mm, "s35");
    assert.equal(D.pixelAspect(mm), 1);
    assert.equal(D.cleanMatchmove(JSON.parse(JSON.stringify(mm))).camera.preset, "s35");
    assert.equal(D.cleanMatchmove({ camera: { pixelAspect: 99 } }).camera.pixelAspect, 5);
    assert.equal(D.cleanMatchmove({ camera: {} }).camera.pixelAspect, 1);
});

test("a solve's points project back through a pixel aspect", () => {
    const solve = { focal_px: 1000, center: [960, 540], pixel_aspect: 2, frames: { 0: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } } };
    const [u, v] = D.projectPoint(solve, 0, [1, 1, 10], null, 1920, 1080);
    assert.ok(Math.abs(u - (960 + 50)) < 1e-9 && Math.abs(v - (540 + 100)) < 1e-9, `${u} ${v}`);
});

test("the plate goes behind the points, whatever the solve's units", () => {
    const frames = { 0: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } };
    const pts = (z) => [1, 2, 3, 4, 5].map((k) => ({ id: `t${k}`, X: [0, 0, z * k / 3] }));
    assert.equal(D.backplateDistance({ frames, points: pts(10) }), 50);
    assert.equal(D.backplateDistance({ frames, points: pts(40) }), 200);
    assert.equal(D.backplateDistance(null), 50);
});

test("the lens chart is whole squares inside a white margin, whatever the screen", () => {
    for (const [W, H] of [[1920, 1080], [2560, 1600], [1366, 768], [2048, 1536], [1080, 1920]]) {
        for (const cols of CHART_COLUMNS) {
            const L = chartLayout(W, H, cols);
            assert.equal(L.cols, cols);
            assert.ok(L.x0 >= L.cell - 1 && L.y0 >= L.cell - 1, JSON.stringify({ W, H, L }));
            assert.ok(L.x0 + L.cols * L.cell <= W - L.cell + 1 && L.y0 + L.rows * L.cell <= H - L.cell + 1);
            assert.ok(L.rows >= 3);
        }
    }
    assert.equal(chartDark(0, 0), true);
    assert.equal(chartDark(1, 0), false);
});
