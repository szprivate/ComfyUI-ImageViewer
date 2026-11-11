// node --test tests/test_atlas_orient.mjs
// Auto-orient an Atlas world (imageViewer_atlasOrient.js): a world whose mesh lies in a pitched / rolled first
// camera's frame stands upright with its floor at y = 0 after orientWorld + placeWorld.
import test from "node:test";
import assert from "node:assert/strict";
import * as O from "../js/imageViewer_atlasOrient.js";

const rad = (d) => d * Math.PI / 180;
const mulv = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const tr = (m) => [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]);

// A camera's rotation (columns: right, up, back) from yaw, pitch, roll in degrees (RUB, as Atlas stores them).
function camRot(yaw, pitch, roll = 0) {
    return mul(mul(O.matrixXYZ([0, yaw, 0]), O.matrixXYZ([pitch, 0, 0])), O.matrixXYZ([0, 0, roll]));
}
function mul(a, b) { return a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j])); }

// A room in the true frame: floor y = 0 (6 x 6 m), a back wall at z = -3, a table top at y = 0.75.
function room() {
    const pts = [];
    let s = 1;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 3000; i++) pts.push([r() * 6 - 3, (r() - 0.5) * 0.004, r() * 6 - 3]);
    for (let i = 0; i < 1500; i++) pts.push([r() * 6 - 3, r() * 2.6, -3]);
    for (let i = 0; i < 500; i++) pts.push([r() * 1.2 - 0.6, 0.75, r() * 0.8 - 1.4]);
    return pts;
}

// The same world as Atlas meshes it: in the first camera's frame.
function asMesh(trueCams, truePts) {
    const R0 = trueCams[0].R, t0 = trueCams[0].t;
    const toMesh = (p) => mulv(tr(R0), [p[0] - t0[0], p[1] - t0[1], p[2] - t0[2]]);
    const cams = trueCams.map((c) => {
        const Rm = mul(tr(R0), c.R);
        return { right: [Rm[0][0], Rm[1][0], Rm[2][0]], up: [Rm[0][1], Rm[1][1], Rm[2][1]],
                 fwd: [-Rm[0][2], -Rm[1][2], -Rm[2][2]], pos: toMesh(c.t) };
    });
    return { cams, points: truePts.flatMap(toMesh) };
}

function placed(orient, points, item = {}) {
    const pl = O.placeWorld(orient, item);
    const R = O.matrixXYZ(pl.rotation);
    const out = [];
    const s = item.scale || [1, 1, 1];
    for (let i = 0; i < points.length; i += 3) {
        const q = mulv(R, [points[i] * s[0], points[i + 1] * s[1], points[i + 2] * s[2]]);
        out.push([q[0] + pl.position[0], q[1] + pl.position[1], q[2] + pl.position[2]]);
    }
    return { pl, out };
}

test("one photo looking down 30 degrees: the floor comes out level at y = 0", () => {
    const cams = [{ R: camRot(20, -30), t: [0.4, 1.6, 1.5] }];
    const { cams: mc, points } = asMesh(cams, room());
    const o = O.orientWorld(mc, points);
    assert.equal(o.floor, true);
    assert.ok(Math.abs(o.tilt - 30) < 1.5, `tilt ${o.tilt}`);
    const { out } = placed(o, points);
    const floor = out.slice(0, 3000).map((p) => p[1]);
    assert.ok(Math.max(...floor.map(Math.abs)) < 0.03, "every floor point near y = 0");
    // The table top stands 0.75 above it, level.
    const table = out.slice(4500).map((p) => p[1]);
    assert.ok(table.every((y) => Math.abs(y - 0.75) < 0.03));
    // The first camera is at the origin's x / z, 1.6 m up, looking level down -Z.
    const fwd = mulv(O.matrixXYZ(O.placeWorld(o).rotation), mc[0].fwd);
    assert.ok(Math.abs(fwd[1] + Math.sin(rad(30))) < 0.03 && fwd[2] < -0.8, `fwd ${fwd}`);
});

test("several cameras with no floor in the sample: up comes from their level right axes", () => {
    const cams = [{ R: camRot(0, -20), t: [0, 1.6, 2] }, { R: camRot(70, 10), t: [1, 1.5, 1] },
                  { R: camRot(-60, -35), t: [-1, 1.7, 0] }];
    const pts = room().slice(3000, 4500);          // the wall only
    const { cams: mc, points } = asMesh(cams, pts);
    const g = O.cameraUp(mc);
    assert.equal(g.how, "cameras");
    const o = O.orientWorld(mc, points);
    const up = mulv(O.matrixXYZ(O.placeWorld(o).rotation), o.up);
    assert.ok(up[1] > 0.999, `up ${up}`);
    // The wall stands vertical: its points' x and y spread, z is one value.
    const { out } = placed(o, points);
    const zs = out.map((p) => p[2]);
    assert.ok(Math.max(...zs) - Math.min(...zs) < 0.05);
});

test("a world already upright is left upright, and its scale is kept", () => {
    const cams = [{ R: camRot(0, 0), t: [0, 1.6, 0] }];
    const { cams: mc, points } = asMesh(cams, room());
    const o = O.orientWorld(mc, points);
    assert.ok(o.tilt < 1);
    const { pl, out } = placed(o, points, { scale: [2, 2, 2] });
    assert.ok(pl.rotation.every((a) => Math.abs(a) < 1.5), `rot ${pl.rotation}`);
    assert.ok(out.slice(0, 3000).every((p) => Math.abs(p[1]) < 0.05));
});

test("a camera is carried along with the world", () => {
    const from = { rotation: [0, 0, 0], position: [0, 0, 0] };
    const to = { rotation: [30, 0, 0], position: [0, -1, 0] };
    const d = O.worldDelta(from, to);
    const c = O.carry(d, { rotation: [0, 0, 0], position: [0, 0, -2] });
    // A point 2 m in front (-Z), turned 30 degrees about X (it rises), then lowered by 1.
    assert.ok(Math.abs(c.position[1] - (2 * Math.sin(rad(30)) - 1)) < 1e-9);
    assert.ok(Math.abs(c.rotation[0] - 30) < 1e-9);
});

test("eulerXYZ is the inverse of matrixXYZ", () => {
    for (const e of [[10, 20, 30], [-45, 5, 170], [80, -60, -20]]) {
        const back = O.eulerXYZ(O.matrixXYZ(e));
        assert.ok(back.every((v, i) => Math.abs(v - e[i]) < 1e-9), `${e} -> ${back}`);
    }
});
