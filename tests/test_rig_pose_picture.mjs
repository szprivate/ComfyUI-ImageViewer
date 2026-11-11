// A pose read off a picture (js/imageViewer_rigPoseSpec.js solvePicturePose): MediaPipe's
// landmarks, made here from a known pose, solved back onto the motion model's joints.
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "../js/imageViewer_rigPoseFix.js";
import * as P from "../js/imageViewer_rigPoseSpec.js";
import { LM } from "../js/imageViewer_rigVideo.js";
import { headingOf } from "../js/imageViewer_rigMotion.js";
import { quat, v3 } from "../js/imageViewer_rigData.js";

const DEG = Math.PI / 180;

/** Joint points (canonical, Y up, facing +Z) -> 33 MediaPipe world landmarks (y down, z away). */
function landmarksOf(at, { hidden = [] } = {}) {
    const L = Array.from({ length: 33 }, () => [0, 0, 0, 0]);
    const put = (i, p, vis = 1) => { L[i] = [p[0], -p[1], -p[2], hidden.includes(i) ? 0 : vis]; };
    const hips = v3.scale(v3.add(at.LeftLeg, at.RightLeg), 0.5);
    const rel = (p) => v3.sub(p, hips);
    const side = v3.norm(v3.sub(at.LeftArm, at.RightArm));
    const head = rel(at.Head);
    const fwd = v3.norm(v3.cross(side, [0, 1, 0]));
    put(LM.nose, v3.add(head, v3.add(v3.scale(fwd, 0.1), [0, 0.03, 0])));
    put(LM.earL, v3.add(head, v3.add(v3.scale(side, 0.07), [0, 0.05, 0])));
    put(LM.earR, v3.add(head, v3.add(v3.scale(side, -0.07), [0, 0.05, 0])));
    for (const [S, s] of [["Left", "L"], ["Right", "R"]]) {
        put(LM[`shoulder${s}`], rel(at[`${S}Arm`]));
        put(LM[`elbow${s}`], rel(at[`${S}ForeArm`]));
        put(LM[`wrist${s}`], rel(at[`${S}Hand`]));
        const hand = v3.norm(v3.sub(at[`${S}Hand`], at[`${S}ForeArm`]));
        put(LM[`index${s}`], v3.add(rel(at[`${S}Hand`]), v3.add(v3.scale(hand, 0.08), v3.scale(fwd, 0.02))));
        put(LM[`pinky${s}`], v3.add(rel(at[`${S}Hand`]), v3.add(v3.scale(hand, 0.08), v3.scale(fwd, -0.02))));
        put(LM[`hip${s}`], rel(at[`${S}Leg`]));
        put(LM[`knee${s}`], rel(at[`${S}Shin`]));
        put(LM[`ankle${s}`], rel(at[`${S}Foot`]));
        put(LM[`heel${s}`], v3.add(rel(at[`${S}Foot`]), [0, -0.05, 0]));
        put(LM[`toe${s}`], rel(at[`${S}ToeEnd`]));
    }
    return L;
}

const bonePoints = (g) => F.jointPoints(g);
const dir = (at, a, b) => v3.norm(v3.sub(at[b], at[a]));

test("a pose seen in a picture comes back as the same pose", () => {
    const spec = P.resolvePose({ preset: ["sit", "wave"] });
    const want = P.solvePoseSpec(spec.parts, { heading: 0 });
    const got = P.solvePicturePose(landmarksOf(want.points), { heading: 0 });
    const a = bonePoints(want.joints), b = bonePoints(got.joints);
    for (const [from, to] of [["LeftArm", "LeftForeArm"], ["LeftForeArm", "LeftHand"], ["RightArm", "RightForeArm"],
                              ["RightForeArm", "RightHand"], ["LeftLeg", "LeftShin"], ["LeftShin", "LeftFoot"],
                              ["RightLeg", "RightShin"], ["RightShin", "RightFoot"]]) {
        const d = Math.acos(Math.min(1, v3.dot(dir(a, from, to), dir(b, from, to)))) / DEG;
        assert.ok(d < 6, `${from} -> ${to} off by ${d.toFixed(1)} degrees`);
    }
    // Sitting on nothing: the body is lowered onto the floor.
    const low = Math.min(...Object.values(got.points).map((p) => p[1])) + got.root[1];
    assert.ok(Math.abs(low) < 0.02, `lowest joint at ${low}`);
});

test("the character keeps facing where it faced, unless the picture's turn is asked for", () => {
    const spec = P.resolvePose({ preset: "stand" });
    const turned = P.solvePoseSpec(spec.parts, { heading: 60 * DEG });
    const L = landmarksOf(turned.points);
    const keep = P.solvePicturePose(L, { heading: 10 * DEG });
    assert.ok(Math.abs(headingOf({ joints: { Hips: keep.joints.Hips } }) - 10 * DEG) < 1e-3);
    const pic = P.solvePicturePose(L, { heading: 10 * DEG, facing: "picture" });
    const ph = headingOf({ joints: { Hips: pic.joints.Hips } }) / DEG;
    assert.ok(Math.abs(ph - 70) < 2, `faces ${ph}`);
});

test("a knee seen bent backwards in the picture is held to a knee's range", () => {
    const spec = P.resolvePose({ preset: "stand" });
    const want = P.solvePoseSpec(spec.parts, { heading: 0 });
    const at = JSON.parse(JSON.stringify(want.points));
    // Push the left ankle forward of the knee: a backwards knee.
    at.LeftFoot = v3.add(at.LeftShin, [0, -0.3, 0.3]);
    at.LeftToeEnd = v3.add(at.LeftFoot, [0, -0.05, 0.12]);
    const got = P.solvePicturePose(landmarksOf(at), { heading: 0 });
    const local = quat.mul(quat.conj(got.joints.LeftLeg), got.joints.LeftShin);
    const bend = F.twistOf(local, F.HINGES.LeftShin.axis).angle / DEG;
    assert.ok(bend >= F.HINGES.LeftShin.min - 1e-6, `knee bent ${bend}`);
    const off = P.solvePicturePose(landmarksOf(at), { heading: 0, limits: false });
    assert.ok(off.joints.LeftShin.some((v, i) => Math.abs(v - got.joints.LeftShin[i]) > 1e-3), "without limits it stays as seen");
});

test("a picture without the person's body says so", () => {
    const L = Array.from({ length: 33 }, () => [0, 0, 0, 0]);
    assert.throws(() => P.solvePicturePose(L), /hips and shoulders/);
    assert.throws(() => P.solvePicturePose([]), /33 points/);
});
