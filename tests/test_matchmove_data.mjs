// The matchmove's data (js/imageViewer_matchmoveData.js): state, tracks, masks, the solve's axes, orientation.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_matchmoveData.js";

const near = (a, b, eps = 1e-9) => {
    if (Array.isArray(a)) { assert.equal(a.length, b.length); a.forEach((x, i) => near(x, b[i], eps)); return; }
    assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
};

test("a matchmove read back from JSON is the same, and junk is tidied away", () => {
    const mm = D.newMatchmove({ path: "/p/shot.####.exr", frames: 50, width: 1920, height: 1080, fps: 25 });
    mm.tracks.push({ id: "t1", name: "t1", group: "camera", on: true, keys: [[0, 1, 2, 1], [1, 2, 3, 0.9]] });
    mm.masks.push({ id: "m1", name: "Car", mode: "object", object: "o1", on: true, keys: [{ f: 0, pts: [[0, 0], [10, 0], [10, 10]] }] });
    const back = D.cleanMatchmove(JSON.parse(JSON.stringify(mm)));
    assert.deepEqual(back.tracks, mm.tracks);
    assert.deepEqual(back.masks, mm.masks);
    assert.equal(back.plate.fps, 25);
    assert.equal(back.nextId, 2);
    const junk = D.cleanMatchmove({ step: "nope", tracks: [{ keys: [[0, "x", 1]] }, null], lens: { k1: 99 } });
    assert.equal(junk.step, "plate");
    assert.equal(junk.tracks.length, 0);
    assert.equal(junk.lens.k1, 5);
});

test("keys are kept in order, one a frame; trims and stats", () => {
    const t = { id: "t1", keys: [] };
    D.setKey(t, 5, 1, 1); D.setKey(t, 2, 0, 0); D.setKey(t, 5, 9, 9); D.setKey(t, 3, 4, 4);
    assert.deepEqual(t.keys.map((k) => k[0]), [2, 3, 5]);
    assert.equal(D.keyAt(t, 5)[1], 9);
    assert.equal(D.keyAt(t, 4), null);
    D.trimTrack(t, 3, "before");
    assert.deepEqual(D.trackSpan(t), [3, 5]);
    const mm = D.newMatchmove({ path: "a.mp4", frames: 4, width: 100, height: 100 });
    mm.tracks = [{ id: "a", group: "camera", on: true, keys: [[0, 0, 0, 1], [1, 0, 0, 1]] },
                 { id: "b", group: "camera", on: true, keys: [[1, 0, 0, 1], [2, 0, 0, 1]] }];
    assert.deepEqual(D.frameCounts(mm), [1, 2, 1, 0]);
    assert.deepEqual(D.thinRuns(D.frameCounts(mm), 2), [[0, 0], [2, 3]]);
    assert.deepEqual(D.tracksInRect(mm, 1, -1, -1, 1, 1).sort(), ["a", "b"]);
    D.addTracks(mm, [{ id: "a", keys: [[0, 5, 5]] }]);
    assert.equal(mm.tracks.length, 3);
    assert.notEqual(mm.tracks[2].id, "a");
});

test("a mask moves straight between its keys and holds outside them", () => {
    const m = { keys: [] };
    D.setMaskKey(m, 10, [[0, 0], [10, 0], [10, 10]]);
    D.setMaskKey(m, 0, [[0, 0], [20, 0], [20, 20]]);
    near(D.maskAt(m, 5), [[0, 0], [15, 0], [15, 15]]);
    near(D.maskAt(m, -3), [[0, 0], [20, 0], [20, 20]]);
    assert.ok(D.pointInPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 5, 5));
    assert.ok(!D.pointInPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 15, 5));
});

test("Euler XYZ and the matrix agree both ways", () => {
    for (const e of [[10, 20, 30], [-80, 45, 170], [0, 0, 0], [5, -60, -100]]) near(D.eulerXYZ(D.matrixXYZ(e)), e, 1e-9);
    near(D.unwrapEuler([179, 0, -179], [-179, 0, 179]), [-181, 0, 181]);
});

test("a solved camera becomes a 3D-space camera looking where the server's looked", () => {
    // Server axes: x right, y down, looking down +Z. A camera at C turned by Rc: x_cam = R (X - C).
    const Rc = D.matrixXYZ([12, -30, 7]);           // any rotation
    const C = [1, -2, 3];
    const R = D.mat3.tr(Rc);                        // world -> camera
    const t = D.mat3.vec(R, C).map((v) => -v);
    const cam = D.cameraToItem([R.slice(0, 3), R.slice(3, 6), R.slice(6, 9)], t);
    near(cam.position, [1, 2, -3], 1e-12);
    // A point straight ahead of the server's camera (its +Z) is straight ahead of the scene camera (its -Z).
    const ahead = D.mat3.vec(Rc, [0, 0, 5]).map((v, i) => v + C[i]);
    const P = D.pointToScene(ahead);
    const d = P.map((v, i) => v - cam.position[i]);
    const local = D.mat3.vec(D.mat3.tr(D.matrixXYZ(cam.rotation)), d);
    near(local, [0, 0, -5], 1e-9);
    // And a point below the picture's middle (server +y) is below in the scene (-y).
    const below = D.mat3.vec(Rc, [0, 1, 5]).map((v, i) => v + C[i]);
    const lb = D.mat3.vec(D.mat3.tr(D.matrixXYZ(cam.rotation)), D.pointToScene(below).map((v, i) => v - cam.position[i]));
    near(lb, [0, -1, -5], 1e-9);
});

test("ground, origin, axis and scale orient the solve", () => {
    // Points on a tilted plane, camera above it.
    const tilt = D.matrixXYZ([25, 10, -15]);
    const pts = [[0, 0, 0], [4, 0, 0], [0, 0, 4], [4, 0, 4], [2, 0, 1]].map((p) => D.mat3.vec(tilt, p).map((v, i) => v + [3, 1, -2][i]));
    const up = D.mat3.vec(tilt, [2, 5, 2]).map((v, i) => v + [3, 1, -2][i]);
    let o = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 };
    o = D.orientGround(o, pts, up);
    for (const p of pts) near(D.orientApply(o, p)[1], 0, 1e-6);
    assert.ok(D.orientApply(o, up)[1] > 0);
    o = D.orientOrigin(o, pts[0]);
    near(D.orientApply(o, pts[0]), [0, 0, 0], 1e-9);
    o = D.orientAxis(o, pts[0], pts[1], "x");
    const b = D.orientApply(o, pts[1]);
    near(b[2], 0, 1e-9); assert.ok(b[0] > 0); near(b[1], 0, 1e-6);
    o = D.orientScale(o, pts[0], pts[1], 2);
    near(D.orientApply(o, pts[1]), [2, 0, 0], 1e-6);
    // The group's transform is the same mapping.
    const it = D.orientToItem(o);
    const q = D.mat3.vec(D.matrixXYZ(it.rotation), pts[3]).map((v, i) => v * it.scale[0] + it.position[i]);
    near(q, D.orientApply(o, pts[3]), 1e-9);
    assert.ok(D.orientGround(o, [[0, 0, 0]]).error);
});

test("a plane fitted to points lies in their plane", () => {
    const tilt = D.matrixXYZ([0, 0, 30]);
    const pts = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]].map((p) => D.mat3.vec(tilt, p));
    const g = D.geometryOnPoints("plane", pts);
    const n = D.mat3.vec(D.matrixXYZ(g.rotation), [0, 1, 0]);
    const want = D.mat3.vec(tilt, [0, 1, 0]);
    near(Math.abs(n[0] * want[0] + n[1] * want[1] + n[2] * want[2]), 1, 1e-6);
    near(g.position, [0, 0, 0], 1e-12);
    assert.deepEqual(D.geometryOnPoints("locator", pts).scale, [1, 1, 1]);
});

test("focal length in pixels and millimetres, and the vertical field of view", () => {
    const mm = D.newMatchmove({ path: "a.mp4", width: 1920, height: 1080 });
    mm.camera.focalMm = 35; mm.camera.sensor = [36, 24];
    near(D.focalPx(mm), 35 * 1920 / 36);
    near(D.focalMmOf(D.focalPx(mm), mm), 35);
    near(D.fovV(540, 1080), 90, 1e-9);
});

test("the lens point goes both ways, as the Comp node's", () => {
    const lens = { k1: -0.08, k2: 0.01, center: null };
    for (const [x, y] of [[10, 10], [1900, 1000], [960, 540], [100, 900]]) {
        const d = D.lensPoint(x, y, "distort", lens, 1920, 1080);
        near(D.lensPoint(d[0], d[1], "undistort", lens, 1920, 1080), [x, y], 1e-6);
    }
    // barrel (k1 < 0): a corner comes in towards the middle
    const c = D.lensPoint(0, 0, "distort", lens, 1920, 1080);
    assert.ok(c[0] > 0 && c[1] > 0);
});

test("a solved point projects onto the plate where the server's camera sees it", () => {
    const solve = { focal_px: 1000, center: [960, 540], frames: { 3: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 5] } } };
    near(D.projectPoint(solve, 3, [1, 0.5, 5], null, 1920, 1080), [960 + 100, 540 + 50]);
    assert.equal(D.projectPoint(solve, 3, [0, 0, -10], null, 1920, 1080), null);
    assert.equal(D.projectPoint(solve, 4, [0, 0, 5], null, 1920, 1080), null);
    const bp = D.backplatePlace(90, 10);
    near(bp.scale[0], 20, 1e-9);
});

test("the ground is found among the solved points: the floor, not the wall beside it or a table on it", () => {
    // A room in the solve's own (tilted) frame: a floor at y = 0, a wall with MORE points at x = 4, a table top at
    // y = 0.8, a few strays; cameras at eye height looking 40 degrees down, panning.
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const W = D.matrixXYZ([25, 70, -15]);
    const at = (p) => D.mat3.vec(W, p).map((v, i) => v + [2, -1, 3][i]);
    const pts = [];
    const add = (id, p) => pts.push({ id, p: at(p) });
    for (let i = 0; i < 70; i++) add(`f${i}`, [rnd() * 8 - 4, (rnd() - 0.5) * 0.02, rnd() * 8 - 8]);
    for (let i = 0; i < 110; i++) add(`w${i}`, [4 + (rnd() - 0.5) * 0.02, rnd() * 3, rnd() * 8 - 8]);
    for (let i = 0; i < 30; i++) add(`t${i}`, [rnd() - 0.5, 0.8 + (rnd() - 0.5) * 0.01, rnd() - 3.5]);
    for (let i = 0; i < 10; i++) add(`s${i}`, [rnd() * 8 - 4, rnd() * 3, rnd() * 8 - 8]);
    const cams = [];
    for (let i = 0; i < 20; i++) {
        const m = D.mat3.mul(W, D.mat3.mul(D.matrixXYZ([0, -30 + i * 3, 0]), D.matrixXYZ([-40, 0, 0])));
        cams.push({ c: at([i * 0.1 - 1, 1.6, 2]), right: [m[0], m[3], m[6]], up: [m[1], m[4], m[7]] });
    }
    const g = D.findGround(pts, cams);
    assert.ok(!g.error, g.error);
    const want = D.mat3.vec(W, [0, 1, 0]);
    assert.ok(g.normal[0] * want[0] + g.normal[1] * want[1] + g.normal[2] * want[2] > 0.999, `normal ${g.normal}`);
    const floor = g.ids.filter((id) => id[0] === "f").length;
    assert.ok(floor >= 65 && g.ids.length - floor <= 5, `${floor} of ${g.ids.length} on the floor`);
    assert.ok(g.tilt < 2, `tilt ${g.tilt}`);
    const o = D.orientFound({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 }, g, pts);
    for (const q of pts.filter((x) => x.id[0] === "f")) near(D.orientApply(o, q.p)[1], 0, 0.03);
    assert.ok(D.orientApply(o, cams[0].c)[1] > 1.5, "the cameras are above it");
    // only the table's points: the table is found (a region the user drew)
    const tb = D.findGround(pts.filter((q) => q.id[0] === "t"), cams);
    near(D.orientApply(D.orientFound(o, tb, pts), pts.find((q) => q.id === "t3").p)[1], 0, 0.02);
    // lift and flip
    const l = D.orientLift(o, 0.5);
    near(D.orientApply(l, cams[0].c)[1] - D.orientApply(o, cams[0].c)[1], 0.5, 1e-9);
    assert.ok(D.orientApply(D.orientFlip(o), cams[0].c)[1] < 0);
    assert.ok(D.findGround(pts.slice(0, 2), cams).error);
});

test("a matte mask keeps its sequence and names the frame that stands for another", () => {
    const m = D.cleanMask({ id: "k1", name: "People", mode: "exclude", matte: { pattern: "/in/mm/matte.####.png", frames: [4, 0, 8, 8], grow: 3, engine: "objects", prompt: "person" } });
    assert.deepEqual(m.keys, []);
    assert.deepEqual(m.matte.frames, [0, 4, 8]);
    assert.equal(D.matteFrameAt(m.matte, 6), 4);
    assert.equal(D.matteFrameAt(m.matte, 20), 8);
    assert.equal(D.mattePath(m.matte.pattern, 7), "/in/mm/matte.0007.png");
    assert.equal(D.cleanMask({ matte: { pattern: "no-hashes.png", frames: [1] } }), null);
    assert.deepEqual(D.groundVotes({ a: [3, 4], b: [1, 4], c: [0, 0] }), ["a"]);
});

test("a hard shot's tracking: range and start, thin frames to look again on, keys found past a track's ends", () => {
    const mm = D.newMatchmove({ path: "/p/shot.####.exr", frames: 40, width: 1920, height: 1080, fps: 25 });
    assert.deepEqual(D.trackRange(mm), { from: 0, to: 39, start: 0, direction: "both" });
    mm.settings.direction = "backward";
    assert.equal(D.trackRange(mm).start, 39);                             // backwards starts at the end
    mm.settings.start = 99; mm.settings.from = 5; mm.settings.to = 20;
    assert.deepEqual(D.trackRange(mm), { from: 5, to: 20, start: 20, direction: "backward" });
    const back = D.cleanMatchmove(JSON.parse(JSON.stringify(mm)));
    assert.equal(back.settings.direction, "backward");
    assert.equal(back.settings.start, 99);
    assert.equal(D.cleanMatchmove({ settings: { direction: "sideways" } }).settings.direction, "both");
    // ten tracks on frames 0..9 and 30..39: 10..29 is thin
    for (let i = 0; i < 10; i++) {
        const keys = [];
        for (let f = 0; f < 40; f++) if (f < 10 || f >= 30) keys.push([f, i, i, 1]);
        mm.tracks.push({ id: `t${i}`, name: `t${i}`, group: "camera", on: true, keys });
    }
    assert.deepEqual(D.thinSeeds(mm, 8), [20]);
    assert.deepEqual(D.thinSeeds(mm, 8, 25, 39), [27]);
    assert.deepEqual(D.tracksForServer(mm)[0].keys[0], [0, 0, 0]);
    const n = D.addExtended(mm, { t0: [[10, 5, 5, 0.9], [11, 6, 6, 0.8], [0, 99, 99, 1]], nope: [[1, 1, 1, 1]] });
    assert.equal(n, 2);                                                   // a frame it has already is left alone
    assert.deepEqual(D.keyAt(mm.tracks[0], 11), [11, 6, 6, 0.8]);
    assert.equal(D.keyAt(mm.tracks[0], 0)[1], 0);
    assert.deepEqual(mm.tracks[0].keys.map((k) => k[0]).slice(8, 13), [8, 9, 10, 11, 30]);
});

test("depth for the solve: the source, its strength and an AI run are kept, and become the request's depth", () => {
    const mm = D.newMatchmove({ path: "/p/clip.mov", frames: 40, width: 1920, height: 1080, fps: 30 });
    assert.equal(mm.settings.depth, "off");
    assert.equal(D.depthRequest(mm), null);
    assert.deepEqual(D.depthRequest(mm, "phone"), { source: "phone", plate: "/p/clip.mov", strength: 1 });
    assert.equal(D.depthRequest(mm, "ai"), null);                                     // no run yet
    const back = D.cleanMatchmove(JSON.parse(JSON.stringify({
        ...mm, settings: { ...mm.settings, depth: "ai", depthStrength: 40 },
        depthRun: { workflow: "comp_da3", images: { 4: { filename: "d_4.exr", subfolder: "matchmove/depth/r1", type: "output" },
                                                    x: { filename: "bad.exr" }, 7: { subfolder: "no name" } } },
    })));
    assert.equal(back.settings.depth, "ai");
    assert.equal(back.settings.depthStrength, 10);                                    // held to 10
    assert.deepEqual(Object.keys(back.depthRun.images), ["4"]);
    assert.deepEqual(D.depthRequest(back), { source: "ai", images: back.depthRun.images, strength: 10 });
    assert.equal(D.cleanMatchmove({ settings: { depth: "lidar" } }).settings.depth, "off");
    assert.equal(D.cleanDepthRun({ images: {} }), null);
});
