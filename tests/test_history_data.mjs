// The one History, as data (js/bEpicViewer_historyData.js).
// Run: node --test tests/test_history_data.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    HISTORY_KEY, snapshotTab, stampSnapshot, snapshotGroup, setSnapshotGroup, historyGroups,
    liveIndexOf, historySections, historyDisplayOrder, mergeTabHistories, isMediaTabKey, foldIntoTab,
} from "../js/bEpicViewer_historyData.js";

const snap = (name, extra = {}) => [{ filename: name, type: "output", ...extra }];

test("a stamped snapshot is a copy that names its tab", () => {
    const s = snap("a.png");
    const t = stampSnapshot(s, "12");
    assert.equal(snapshotTab(t), "12");
    assert.equal(snapshotTab(s), "", "the original is not changed");
    assert.equal(snapshotTab([]), "");
});

test("a group is on every frame, and comes off again", () => {
    const s = [{ filename: "1.png" }, { filename: "2.png", group: "Old" }];
    setSnapshotGroup(s, " Places ");
    assert.deepEqual(s.map((f) => f.group), ["Places", "Places"]);
    assert.equal(snapshotGroup(s), "Places");
    setSnapshotGroup(s, "");
    assert.deepEqual(s.map((f) => "group" in f), [false, false]);
    assert.equal(snapshotGroup(s), "");
});

test("groups come most recently used first, and a tab's live snapshot is its newest", () => {
    const stack = [snap("c", { group: "B", fromTab: "x" }), snap("b", { fromTab: "y" }), snap("a", { group: "A", fromTab: "x" }), snap("z", { group: "B" })];
    assert.deepEqual(historyGroups(stack), ["B", "A"]);
    assert.equal(liveIndexOf(stack, "x"), 0);
    assert.equal(liveIndexOf(stack, "y"), 1);
    assert.equal(liveIndexOf(stack, "nope"), -1);
    assert.equal(liveIndexOf(stack, ""), -1);
});

test("the strip is drawn by group, newest group first, newest first inside", () => {
    const stack = [snap("0", { group: "B" }), snap("1"), snap("2", { group: "A" }), snap("3", { group: "B" }), snap("4")];
    const secs = historySections(stack);
    assert.deepEqual(secs.map((s) => [s.group, s.indices]), [["B", [0, 3]], ["", [1, 4]], ["A", [2]]]);
    assert.deepEqual(historyDisplayOrder(stack), [0, 3, 1, 4, 2]);
});

test("the filter and folded groups leave snapshots out, and a folded group keeps its count", () => {
    const stack = [snap("0", { group: "B" }), snap("1"), snap("2", { group: "A" }), snap("3", { group: "B" })];
    const visible = (s) => s[0].filename !== "3";
    const secs = historySections(stack, visible, new Set(["A"]));
    assert.deepEqual(secs.map((s) => [s.group, s.indices, s.count]), [["B", [0], 1], ["", [1], 1], ["A", [], 1]]);
    assert.deepEqual(historyDisplayOrder(stack, visible, new Set(["A"])), [0, 1]);
});

test("per-tab histories merge in turns, in tab order, each snapshot naming its tab", () => {
    const old = {
        b: [snap("b0"), snap("b1")],
        a: [snap("a0"), snap("a1"), snap("a2")],
        orphan: [snap("o0")],
    };
    const merged = mergeTabHistories(old, ["a", "b"]);
    assert.deepEqual(merged.map((s) => s[0].filename), ["a0", "b0", "o0", "a1", "b1", "a2"]);
    assert.deepEqual(merged.map(snapshotTab), ["a", "b", "orphan", "a", "b", "a"]);
    assert.equal(snapshotTab(old.a[0]), "", "the old history is not changed");
});

test("a merge keeps a history already unified in front, drops repeats in a tab and keeps the limit", () => {
    const old = {
        [HISTORY_KEY]: [stampSnapshot(snap("n"), "a")],
        a: [snap("a0"), snap("a0"), [], snap("a1")],
        b: [snap("b0")],
    };
    const merged = mergeTabHistories(old, [], 3);
    assert.deepEqual(merged.map((s) => s[0].filename), ["n", "a0", "b0"]);
    assert.deepEqual(mergeTabHistories(null), []);
    assert.deepEqual(mergeTabHistories(old, []).map((s) => s[0].filename), ["n", "a0", "b0", "a1"]);
});

test("media-only tabs are told from documents and live tabs", () => {
    for (const k of ["loader_12", "loader_12_1", "folder_1730000000000_1", "dropped_17_2", "folder_exports"]) assert.ok(isMediaTabKey(k), k);
    for (const k of ["folder_history", "edit:D:/c.otio", "paint:new-1", "previz:3", "named:shots", "12", "sink_4", ""]) assert.ok(!isMediaTabKey(k), k);
});

test("folding tabs into the Viewer tab re-stamps only their snapshots", () => {
    const stack = [stampSnapshot(snap("a"), "loader_1"), stampSnapshot(snap("b"), "edit:x"), stampSnapshot(snap("c"), "folder_1_1")];
    const out = foldIntoTab(stack, ["loader_1", "folder_1_1"], "folder_history");
    assert.deepEqual(out.map(snapshotTab), ["folder_history", "edit:x", "folder_history"]);
    assert.equal(snapshotTab(stack[0]), "loader_1", "the stack is not changed");
});
