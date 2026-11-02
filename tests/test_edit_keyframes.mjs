// node --test tests/test_edit_keyframes.mjs
// Keyframes on a clip's Inspector numbers (bEpicViewer_editTimelineData.js): values, ways of going on,
// auto-key, the diamond, a split dividing them, slip / take / retime leaving them in clip time, undo.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/bEpicViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} != ${b}`);
const keyed = (keys, extra = {}) => ({ ...D.emptyCut("k"), clips: [shot("a.mp4", 4, { fx: { keys }, ...extra }), shot("b.mp4", 2)] });
const V = { kind: "clip", i: 0 };

test("a value between keys, per way of going on; held before the first and after the last", () => {
    const list = (i) => D.cleanKeys({ op: [{ t: 1, v: 0, i }, { t: 3, v: 1 }] }).op;
    near(D.keyValue(list(), 0), 0, "before the first");
    near(D.keyValue(list(), 4), 1, "after the last");
    near(D.keyValue(list(), 2), 0.5, "linear");
    near(D.keyValue(list("in"), 2), 0.25, "ease in");
    near(D.keyValue(list("out"), 2), 0.75, "ease out");
    near(D.keyValue(list("inout"), 1.5), 0.15625, "ease in-out");
    near(D.keyValue(list("hold"), 2.99), 0, "hold: a step");
    near(D.keyValue(list("hold"), 3), 1);
});

test("keys are cleaned: known params, held to their ranges, sorted, one per moment", () => {
    const k = D.cleanKeys({ op: [{ t: 2, v: 3 }, { t: 1, v: 0.5, i: "nope" }, { t: 2, v: 0.2 }], bogus: [{ t: 0, v: 1 }], vol: [{ t: -1, v: 1 }] });
    assert.deepEqual(k, { op: [{ t: 1, v: 0.5 }, { t: 2, v: 0.2 }] });
    assert.deepEqual(D.cleanFx({ op: 0.5, keys: {} }), { op: 0.5 }, "an old cut without keys is unchanged");
});

test("a keyed param ignores its static number; the drawn effect and the volume follow the keys", () => {
    const cut = keyed({ op: [{ t: 0, v: 0 }, { t: 2, v: 1 }], vol: [{ t: 0, v: 1 }, { t: 4, v: 0 }] }, { fx: undefined });
    cut.clips[0].fx = { op: 0.3, keys: { op: [{ t: 0, v: 0 }, { t: 2, v: 1 }], vol: [{ t: 0, v: 1 }, { t: 4, v: 0 }] } };
    near(D.clipFx(cut.clips[0], 1).op, 0.5);
    assert.equal(D.clipFx(cut.clips[0], 2.5), null, "at its keyed 1 the clip is drawn as it comes");
    near(D.clipVolume(cut.clips[0], 3), 0.25);
    near(D.paramAt(cut.clips[0], "zx", 1), 1, "an unkeyed param: its number");
});

test("the diamond adds a key with the value there and takes it away again; auto-key once animated", () => {
    const cut = { ...D.emptyCut("k"), clips: [shot("a.mp4", 4, { fx: { op: 0.4 } })] };
    let next = D.toggleKeys(cut, V, ["op"], 1);
    assert.deepEqual(D.keysOf(next.clips[0], "op"), [{ t: 1, v: 0.4 }]);
    assert.deepEqual(D.keysOf(cut.clips[0], "op"), [], "a new cut: the old one is the undo step");
    // Animated: a change at another moment makes a key there; a change of an unkeyed param sets its number.
    next = D.autoKey(next, V, { op: 0.9, zx: 2 }, 3);
    assert.deepEqual(D.keysOf(next.clips[0], "op"), [{ t: 1, v: 0.4 }, { t: 3, v: 0.9 }]);
    assert.equal(D.cleanFx(next.clips[0].fx).zx, 2);
    // A change on a key changes it (its way of going on kept).
    next = D.setKeyInterp(next, V, ["op"], 1, "inout");
    next = D.autoKey(next, V, { op: 0.1 }, 1);
    assert.deepEqual(D.keysOf(next.clips[0], "op")[0], { t: 1, v: 0.1, i: "inout" });
    assert.equal(D.keyInterpAt(next.clips[0], ["op"], 1), "inout");
    // Both of a row: one key each; the diamond again takes both away.
    let two = D.toggleKeys(next, V, ["x", "y"], 2);
    assert.equal(D.keyedAt(two.clips[0], ["x", "y"], 2), true);
    two = D.toggleKeys(two, V, ["x", "y"], 2);
    assert.equal(D.keyTimes(two.clips[0], ["x", "y"]).length, 0);
    // Previous / next key; moving one moment's keys; a row's reset takes keys and number.
    assert.equal(D.nextKeyTime(next.clips[0], ["op"], 1, 1), 3);
    assert.equal(D.nextKeyTime(next.clips[0], ["op"], 1, -1), null);
    const moved = D.moveKeysAt(next, V, 3, 2.5);
    assert.deepEqual(D.keyTimes(moved.clips[0]), [1, 2.5]);
    const reset = D.clearKeys(moved, V, ["op"]);
    assert.equal(D.hasKeys(reset.clips[0]), false);
    assert.equal(D.cleanFx(reset.clips[0].fx).op, undefined);
    // Volume: a key, then auto-key, then the reset back to 1.
    let vol = D.toggleKeys(cut, V, ["vol"], 0);
    vol = D.autoKey(vol, V, { vol: 0.2 }, 2);
    near(D.clipVolume(vol.clips[0], 1), 0.6);
    assert.equal(D.clearKeys(vol, V, ["vol"]).clips[0].volume, 1);
});

test("a split divides the keys: re-based on the second piece, a key at the cut on both so the look does not jump", () => {
    const cut = keyed({ op: [{ t: 0, v: 0 }, { t: 4, v: 1, i: "hold" }], x: [{ t: 3, v: 0.5 }] });
    const got = D.splitClip(cut, V, 1);
    const [a, b] = [got.cut.clips[0], got.cut.clips[1]];
    assert.deepEqual(D.keysOf(a, "op"), [{ t: 0, v: 0 }, { t: 1, v: 0.25 }]);
    assert.deepEqual(D.keysOf(b, "op"), [{ t: 0, v: 0.25 }, { t: 3, v: 1, i: "hold" }]);
    assert.deepEqual(D.keysOf(b, "x"), [{ t: 0, v: 0.5 }, { t: 2, v: 0.5 }]);
    for (const u of [0, 0.5, 0.99]) near(D.paramAt(a, "op", u), D.paramAt(cut.clips[0], "op", u));
    for (const u of [0, 1.5, 2.9]) near(D.paramAt(b, "op", u), D.paramAt(cut.clips[0], "op", u + 1));
    // The blade at the playhead and on a placed track divide them the same way.
    const placed = { ...D.emptyCut("p"), clips: [shot("a.mp4", 2)], tracks: [{ id: "V2", kind: "video", name: "V2", off: false,
        clips: [{ ...shot("o.mp4", 4, { fx: { keys: { rot: [{ t: 0, v: 0 }, { t: 4, v: 90 }] } } }), at: 1 }] }] };
    const cutP = D.splitClip(placed, { kind: "tclip", track: "V2", i: 0 }, 3).cut;
    assert.deepEqual(D.keysOf(cutP.tracks[0].clips[1], "rot"), [{ t: 0, v: 45 }, { t: 2, v: 90 }]);
});

test("keys live in clip time: a slip, a retime, a loop and a take leave them where they are", () => {
    const keys = { op: [{ t: 0, v: 0 }, { t: 2, v: 1 }] };
    const cut = keyed(keys, { in: 1 });
    const slipped = D.slipClip(cut, V, 0.5, {});
    assert.deepEqual(D.keysOf(slipped.clips[0], "op"), keys.op);
    const fast = D.setSpeed(cut, V, 2);
    assert.deepEqual(D.keysOf(fast.clips[0], "op"), keys.op);
    const taken = D.addTake(cut, "a.mp4", { file: "a_v2.mp4", version: 2 });
    const c = D.clipOf(taken.cut || taken, V);
    assert.equal(c.file, "a_v2.mp4", "the take is the clip's media now");
    assert.deepEqual(D.keysOf(c, "op"), keys.op, "a take swaps the media, not the keys");
    assert.equal(D.sameCut(cut, D.toggleKeys(cut, V, ["zx"], 1)), false, "a key is a change to save");
    assert.deepEqual(D.toSave(cut).clips[0].fx.keys, keys);
});

test("unlinking a film with volume keys hands them to its sound clip", () => {
    const cut = { ...D.emptyCut("u"), clips: [shot("a.mp4", 4, { fx: { op: 0.5, keys: { vol: [{ t: 0, v: 1 }, { t: 4, v: 0 }], op: [{ t: 0, v: 1 }] } } })], tracks: [] };
    const got = D.unlinkClip(cut, V);
    const sound = got.cut.tracks[0].clips[0];
    assert.deepEqual(D.keysOf(sound, "vol"), [{ t: 0, v: 1 }, { t: 4, v: 0 }]);
    assert.deepEqual(D.keysOf(got.cut.clips[0], "vol"), []);
    assert.deepEqual(D.keysOf(got.cut.clips[0], "op"), [{ t: 0, v: 1 }]);
});
