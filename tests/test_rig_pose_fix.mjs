// Poses a body could hold (js/imageViewer_rigPoseFix.js): limits, hinges, contacts on the floor.
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "../js/imageViewer_rigPoseFix.js";
import * as P from "../js/imageViewer_rigPoseSpec.js";
import { quat, v3 } from "../js/imageViewer_rigData.js";

const DEG = Math.PI / 180;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} not within ${tol} of ${b}`);
const tpose = () => Object.fromEntries(Object.keys(F.PARENT).map((j) => [j, [0, 0, 0, 1]]));
const localOf = (g, j) => quat.mul(quat.conj(g[F.PARENT[j]]), g[j]);

test("a knee bent backwards and an elbow bent the wrong way come back straight", () => {
    const g = tpose();
    g.LeftShin = quat.axisAngle([1, 0, 0], -40 * DEG);          // backwards
    g.LeftFoot = g.LeftShin; g.LeftToeBase = g.LeftShin; g.LeftToeEnd = g.LeftShin;
    g.LeftForeArm = quat.axisAngle([0, 1, 0], 60 * DEG);        // the left elbow bends about -Y: this is backwards
    g.LeftHand = g.LeftForeArm;
    const out = F.limitJoints(g);
    near(2 * Math.acos(Math.min(1, Math.abs(localOf(out, "LeftShin")[3]))), 0, 1e-6, "knee");
    near(2 * Math.acos(Math.min(1, Math.abs(localOf(out, "LeftForeArm")[3]))), 0, 1e-6, "elbow");
    // The child keeps its turn from its parent.
    near(quat.mul(quat.conj(out.LeftForeArm), out.LeftHand)[3], 1, 1e-9, "hand stays with the forearm");
});

test("a knee bent too far and a head turned too far are held at their limits", () => {
    const g = tpose();
    g.LeftShin = quat.axisAngle([1, 0, 0], 175 * DEG);
    g.Neck1 = [0, 0, 0, 1];
    g.Head = quat.axisAngle([0, 1, 0], 120 * DEG);
    const out = F.limitJoints(g);
    near(F.twistOf(localOf(out, "LeftShin"), [1, 0, 0]).angle / DEG, F.HINGES.LeftShin.max, 1e-6, "knee");
    near(2 * Math.acos(localOf(out, "Head")[3]) / DEG, F.CONES.Head, 1e-6, "head");
});

test("a sideways knee read from a picture becomes a bend about the hinge", () => {
    const g = tpose();
    // The shin pointing out to the side and back, the thigh straight down with no roll.
    const shinDir = v3.norm([0.6, -0.5, -0.6]);
    g.LeftShin = quat.between([0, -1, 0], shinDir);
    const fixed = F.alignHinges(g);
    const at0 = F.jointPoints(g), at1 = F.jointPoints(fixed);
    // The bones point where they did ...
    for (const j of ["LeftShin", "LeftFoot"]) near(v3.dist(at0[j], at1[j]), 0, 1e-4, j);
    // ... and the knee's turn is (almost) only about its hinge.
    const local = localOf(fixed, "LeftShin");
    const bend = F.twistOf(local, [1, 0, 0]);
    assert.ok(bend.angle > 0, "the knee bends forwards");
    const limited = F.limitJoints(fixed);
    near(v3.dist(F.jointPoints(limited).LeftFoot, at0.LeftFoot), 0, 0.02, "the limits keep the foot where the picture had it");
});

test("contacts put a hand and a foot on the floor, the hand under its shoulder", () => {
    // A side plank: lying on the side, the right hand down.
    const r = P.resolvePose({ joints: { hips: { side: -70 }, "upperArm.R": { down: -20 }, "upperArm.L": { down: -80 } },
                              contacts: [{ part: "right hand", under: true }, "left foot"] });
    const s = P.solvePoseSpec(r.parts, { hips: r.hips, contacts: r.contacts });
    const world = (j) => v3.add(s.points[j], s.root);
    near(world("RightHand")[1], F.CONTACT_LIMBS["hand.R"].lift, 1e-3, "hand on the floor");
    near(world("RightHand")[0], world("RightArm")[0], 1e-3, "under the shoulder (x)");
    near(world("RightHand")[2], world("RightArm")[2], 1e-3, "under the shoulder (z)");
    near(world("LeftFoot")[1], F.CONTACT_LIMBS["foot.L"].lift, 0.02, "foot on the floor");
    assert.deepEqual(s.contacts, ["hand.R", "foot.L"]);
    // The elbow still bends the right way.
    const g = s.joints;
    const bend = F.twistOf(F.limitLocal("RightForeArm", quat.mul(quat.conj(g.RightArm), g.RightForeArm)), [0, 1, 0]).angle;
    assert.ok(bend >= -1e-6, `elbow bend ${bend}`);
});

test("contacts are read the ways people name them", () => {
    assert.deepEqual(F.readContact("left hand"), { key: "hand.L", under: false });
    assert.deepEqual(F.readContact("foot.R"), { key: "foot.R", under: false });
    assert.deepEqual(F.readContact({ part: "Right_Knee", under: true }), { key: "knee.R", under: true });
    assert.equal(F.readContact("nose"), null);
    assert.equal(F.readContact("hand"), null);
});
