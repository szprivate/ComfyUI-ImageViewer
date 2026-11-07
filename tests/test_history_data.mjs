// The one History, as data (js/bEpicViewer_historyData.js).
// Run: node --test tests/test_history_data.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    HISTORY_KEY, snapshotTab, stampSnapshot, snapshotGroup, setSnapshotGroup, historyGroups,
    liveIndexOf, historySections, historyDisplayOrder, mergeTabHistories, isMediaTabKey, foldIntoTab, isFeedTabKey, groupFromLabel, snapshotNode,
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

test("Send node and agent tabs are groups of the Viewer tab", () => {
    assert.ok(isFeedTabKey("named:agentY"));
    assert.ok(!isFeedTabKey("send_12"), "a send_ key is only a Send node's when the graph says so");
    assert.ok(isFeedTabKey("send_12", (k) => k === "send_12"));
    assert.ok(!isFeedTabKey("send_13", (k) => k === "send_12"));
    for (const k of ["folder_history", "edit:D:/c.otio", "paint:new-1", "previz:3", "world:x", ""]) assert.ok(!isFeedTabKey(k, () => true), k);
    assert.equal(groupFromLabel("\u{1F5BC} KSampler"), "KSampler");
    assert.equal(groupFromLabel("agentY"), "agentY");
});

test("folding a tab puts its snapshots in its group, keeping groups they had", () => {
    const stack = [
        [{ filename: "a.png", fromTab: "send_3" }],
        [{ filename: "b.png", fromTab: "send_3", group: "Characters" }],
        [{ filename: "c.png", fromTab: "paint:x" }],
    ];
    const out = foldIntoTab(stack, ["send_3"], "folder_history", { send_3: "VAE Decode" });
    assert.equal(snapshotTab(out[0]), "folder_history");
    assert.equal(snapshotGroup(out[0]), "VAE Decode");
    assert.equal(snapshotGroup(out[1]), "Characters");
    assert.equal(snapshotTab(out[2]), "paint:x");
    assert.equal(snapshotGroup(stack[0]), "", "the stack itself is not changed");
});

test("a node's own tab, folded, names the node its snapshots came from", () => {
    const out = foldIntoTab([[{ filename: "r.png", fromTab: "send_7" }], [{ filename: "q.png", fromTab: "send_label_x" }]],
                            ["send_7", "send_label_x"], "folder_history", {});
    assert.equal(snapshotNode(out[0]), "7");
    assert.equal(snapshotNode(out[1]), null);
});

test("a sequence is saved as its first frame and the differences, and comes back exactly", async () => {
    const { packSnapshot, unpackSnapshot } = await import("../js/bEpicViewer_historyData.js");
    const seq = Array.from({ length: 81 }, (_, f) => ({
        path: `D:/AI/out/run_7/frame_${1001 + f}.png`, filename: `frame_${1001 + f}.png`, subfolder: "agent/run_7",
        type: "output", group: "agentY", label: "render", ...(f === 5 ? { extra: 1 } : {}), ...(f === 9 ? { n: [1, 2] } : {}) }));
    seq[0].fromTab = "folder_history";
    const packed = JSON.parse(JSON.stringify(packSnapshot(seq)));
    assert.equal(packed.length, 1, "one frame saved");
    assert.equal(packed[0].path, seq[0].path, "an older viewer sees the first frame");
    assert.equal(packed[0].fromTab, "folder_history");
    assert.ok(JSON.stringify(packed).length < JSON.stringify(seq).length / 3);
    assert.deepEqual(unpackSnapshot(packed), seq);
    assert.equal(JSON.stringify(unpackSnapshot(packed)), JSON.stringify(seq), "keys in their order");
    // One frame, an old save and anything that is not a snapshot pass as they are.
    const one = [{ path: "D:/a.png" }];
    assert.equal(packSnapshot(one), one);
    assert.equal(unpackSnapshot(one), one);
    assert.deepEqual(unpackSnapshot(seq), seq);
    assert.equal(packSnapshot(null), null);
    // Shorter and longer strings, a path that changes folder.
    const odd = [{ p: "a/frame_9.png" }, { p: "a/frame_10.png" }, { p: "b/x.png" }, { p: "" }, { p: "a/frame_9.png" }];
    assert.deepEqual(unpackSnapshot(JSON.parse(JSON.stringify(packSnapshot(odd)))), odd);
});
