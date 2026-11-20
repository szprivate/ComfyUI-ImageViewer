// The matchmove's pins to geometry (survey points; js/imageViewer_matchmoveData.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_matchmoveData.js";

const plate = { path: "/p/shot.mov", frames: 50, width: 1920, height: 1080, fps: 24 };
const withTracks = (ids) => {
    const mm = D.newMatchmove(plate);
    for (const id of ids) mm.tracks.push({ id, name: id, group: "camera", on: true, keys: [[0, 1, 2, 1]] });
    return mm;
};

test("a pin is one per track, three finite numbers, and remembers where it came from", () => {
    const mm = withTracks(["t1", "t2"]);
    assert.match(D.setPin(mm, "nope", [0, 0, 0]).error, /no track/);
    assert.match(D.setPin(mm, "t1", [0, "x", 0]).error, /three numbers/);
    const r = D.setPin(mm, "t1", [1, 2, 3], { item: "box1", name: "Box", kind: "point" });
    assert.deepEqual(r.pin, { id: "t1", X: [1, 2, 3], on: true, from: { item: "box1", name: "Box", kind: "point" } });
    D.setPin(mm, "t1", [4, 5, 6]);
    assert.equal(mm.survey.length, 1);
    assert.deepEqual(mm.survey[0].X, [4, 5, 6]);
    assert.equal(D.cleanPin({ id: "a", X: [1, 2, 3], from: { kind: "weird" } }).from.kind, "surface");
    assert.equal(D.cleanPin({ id: "a", X: [1, 2, Infinity] }), null);
});

test("the solve is sent the pins only with three or more on and the geometry used", () => {
    const mm = withTracks(["t1", "t2", "t3", "t4"]);
    assert.equal(mm.settings.geometry, "hold");
    D.setPin(mm, "t1", [0, 0, 0]); D.setPin(mm, "t2", [1, 0, 0]);
    assert.equal(D.surveyRequest(mm), null);
    D.setPin(mm, "t3", [0, 1, 0]);
    assert.deepEqual(D.surveyRequest(mm), { survey: [{ id: "t1", X: [0, 0, 0] }, { id: "t2", X: [1, 0, 0] }, { id: "t3", X: [0, 1, 0] }], survey_mode: "hold" });
    mm.survey[0].on = false;
    assert.equal(D.surveyRequest(mm), null);
    D.setPin(mm, "t4", [0, 0, 1]);
    mm.settings.geometry = "align";
    assert.equal(D.surveyRequest(mm).survey_mode, "align");
    mm.settings.geometry = "off";
    assert.equal(D.surveyRequest(mm), null);
});

test("pins go with their tracks, survive a clean, and are removed", () => {
    const mm = withTracks(["t1", "t2", "t3"]);
    for (const [i, id] of ["t1", "t2", "t3"].entries()) D.setPin(mm, id, [i, 0, 0]);
    mm.settings.geometry = "align";
    const back = D.cleanMatchmove(JSON.parse(JSON.stringify({ ...mm, survey: [...mm.survey, { id: "ghost", X: [0, 0, 0] }, { id: "t1", X: [9, 9, 9] }] })));
    assert.deepEqual(back.survey.map((p) => p.id), ["t1", "t2", "t3"]);
    assert.deepEqual(back.survey[0].X, [0, 0, 0]);
    assert.equal(back.settings.geometry, "align");
    assert.equal(D.cleanMatchmove({ ...mm, settings: { ...mm.settings, geometry: "x" } }).settings.geometry, "hold");
    D.removeTracks(back, ["t2"]);
    assert.deepEqual(back.survey.map((p) => p.id), ["t1", "t3"]);
    D.removePins(back, ["t1"]);
    assert.deepEqual(back.survey.map((p) => p.id), ["t3"]);
    D.removePins(back);
    assert.deepEqual(back.survey, []);
});

test("a pin's result is read from the solve by track", () => {
    const solve = { survey: { pins: [{ id: "t1", ok: true, text: "0.4 cm off" }, { id: "t2", used: false }] } };
    assert.equal(D.pinResult(solve, "t1").text, "0.4 cm off");
    assert.equal(D.pinResult(solve, "t2").used, false);
    assert.equal(D.pinResult(solve, "t3"), null);
    assert.equal(D.pinResult(null, "t1"), null);
});
