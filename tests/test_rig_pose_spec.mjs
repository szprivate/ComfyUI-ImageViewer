// A pose from words (js/imageViewer_rigPoseSpec.js): parts and moves read, the named
// poses where they should put the hands and feet, mirrored sides, the floor.
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../js/imageViewer_rigPoseSpec.js";
import { quat } from "../js/imageViewer_rigData.js";

const solve = (spec, opts = {}) => {
    const r = P.resolvePose(spec);
    const s = P.solvePoseSpec(r.parts, { hips: r.hips, ...opts });
    const at = (j) => s.points[j].map((v, i) => v + s.root[i]);
    return { ...s, at, unknown: r.unknown };
};
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} not within ${tol} of ${b}`);
const lowest = (s) => Math.min(...Object.keys(s.points).map((j) => s.at(j)[1]));

test("parts and moves are read in the ways people name them", () => {
    assert.deepEqual(P.readPart("upperArm.L"), ["upperArm", "L"]);
    assert.deepEqual(P.readPart("left elbow"), ["lowerArm", "L"]);
    assert.deepEqual(P.readPart("Right_Thigh"), ["upperLeg", "R"]);
    assert.deepEqual(P.readPart("knees"), ["lowerLeg", null]);
    assert.deepEqual(P.readPart("head"), ["head", null]);
    assert.equal(P.readPart("tail"), null);
    const r = P.resolvePose({ joints: { "left arm": { up: 30 }, knees: { bend: 40 }, head: { turn: 20 }, tail: { wag: 1 }, hips: { wiggle: 2 } } });
    assert.deepEqual(r.parts["upperArm.L"], { down: -30 });
    assert.deepEqual(r.parts["lowerLeg.L"], { bend: 40 });
    assert.deepEqual(r.parts["lowerLeg.R"], { bend: 40 });
    assert.deepEqual(r.parts.head, { twist: 20 });
    assert.deepEqual(r.unknown.sort(), ["hips.wiggle", "tail"]);
});

test("the T-pose is the model's own and stands on the floor", () => {
    const s = solve({});
    for (const q of Object.values(s.joints)) assert.deepEqual(q.map((v) => Math.round(v * 1e5) / 1e5), [0, 0, 0, 1]);
    near(lowest(s), 0, 1e-9, "lowest joint");
    assert.equal(P.poseMotion(s).samples[0].rot[0].length, P.POSE_JOINTS.length);
});

test("both sides of a sideless part are mirror images", () => {
    for (const name of Object.keys(P.PRESETS)) {
        const pr = P.PRESETS[name].parts;
        if (Object.keys(pr).some((k) => /\.[LR]$/.test(k))) continue;          // one-sided on purpose
        const s = solve({ preset: name });
        for (const [l, r] of [["LeftHand", "RightHand"], ["LeftForeArm", "RightForeArm"], ["LeftShin", "RightShin"], ["LeftToeEnd", "RightToeEnd"]]) {
            const a = s.at(l), b = s.at(r);
            near(a[0], -b[0], 0.02, `${name} ${l} x`); near(a[1], b[1], 0.02, `${name} ${l} y`); near(a[2], b[2], 0.02, `${name} ${l} z`);
        }
    }
});

test("named poses put the body where their names say", () => {
    const t = solve({});
    const sit = solve({ preset: "sit" });
    assert.ok(sit.root[1] < t.root[1] * 0.65 && sit.root[1] > t.root[1] * 0.45, "sitting hips about knee high");
    assert.ok(sit.at("LeftShin")[2] > 0.35, "the knees ahead");
    near(sit.at("LeftToeEnd")[1], 0, 0.02, "the feet on the floor");

    const crossed = solve({ preset: "arms_crossed" });
    assert.ok(crossed.at("LeftHand")[0] < 0 && crossed.at("RightHand")[0] > 0, "each hand past the middle");
    assert.ok(crossed.at("LeftHand")[2] > 0.1, "in front of the chest");
    assert.ok(crossed.at("LeftHand")[1] > 1.1 && crossed.at("LeftHand")[1] < 1.4, "at chest height");

    const both = solve({ preset: ["sit", "arms_crossed"] });
    near(both.root[1], sit.root[1], 1e-6, "sit + arms crossed keeps the sitting hips");
    assert.ok(both.at("LeftHand")[0] < 0, "and crosses the arms");
    assert.equal(solve({ preset: "sit+arms crossed" }).unknown.length, 0, "presets given as one string");

    const hips = solve({ preset: "hands_on_hips" });
    near(hips.at("LeftHand")[1], hips.root[1], 0.1, "hands at the hips");
    assert.ok(hips.at("LeftForeArm")[0] > 0.3, "elbows out");

    const wave = solve({ preset: "wave" });
    assert.ok(wave.at("RightHand")[1] > wave.at("Head")[1], "the waving hand above the head");
    assert.ok(wave.at("LeftHand")[1] < wave.root[1], "the other arm down");

    const kneel = solve({ preset: "kneel" });
    near(kneel.at("RightShin")[1], 0, 0.1, "the right knee on the floor");
    near(kneel.at("LeftFoot")[1], 0.07, 0.05, "the left foot standing");

    const floor = solve({ preset: "sit_floor" });
    assert.ok(floor.root[1] < 0.2, "on the floor");
    assert.ok(lowest(floor) > -0.05, "nothing much under the floor");

    const lie = solve({ preset: "lie_back" });
    assert.ok(lie.at("Head")[1] < 0.2 && Math.abs(lie.at("Head")[2]) > 0.4, "lying, the head along the floor");
});

test("bent knees keep the soles on the floor unless the foot is pointed", () => {
    const s = solve({ joints: { knees: { bend: 30 } } });
    const f = s.at("LeftFoot"), toe = s.at("LeftToeEnd");
    near(f[1] - toe[1], P.solvePoseSpec({}).points.LeftFoot[1] - P.solvePoseSpec({}).points.LeftToeEnd[1], 1e-6, "ankle over toes as at rest");
    const p = solve({ joints: { knees: { bend: 30 }, feet: { point: 30 } } });
    assert.ok(p.at("LeftFoot")[1] - p.at("LeftToeEnd")[1] > f[1] - toe[1] + 0.02, "a pointed foot is pointed");
});

test("the heading and the hips' height and offset", () => {
    const turned = solve({ preset: "arms_forward" }, { heading: Math.PI / 2 });
    assert.ok(turned.at("LeftHand")[0] > 0.4, "facing +X the arms point along +X");
    const lower = solve({ hips: { height: 0.5 } });
    near(lower.root[1], P.solvePoseSpec({}).root[1] * 0.5, 1e-9, "height as a share of standing");
    const moved = solve({ hips: { offset: [0, 0, 1] } }, { heading: Math.PI / 2 });
    near(moved.root[0], 1, 1e-9, "the offset forward in the character's own directions");
    const q = solve({ joints: { hips: { turn: 90 } } }).joints.Hips;
    const fw = quat.rotate(q, [0, 0, 1]);
    near(fw[0], 1, 1e-6, "hips turn 90 faces its left (+X)");
});

test("mirror copies one side onto the other", () => {
    const s = solve({ preset: "wave", mirror: "R" });
    near(s.at("LeftHand")[1], s.at("RightHand")[1], 0.005, "both hands up");
    near(s.at("LeftHand")[0], -s.at("RightHand")[0], 0.005, "mirrored");
});
