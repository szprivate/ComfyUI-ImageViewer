// node --test tests/test_history_selection.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    describeHistorySelection, pickedIndices, snapshotItem, frameKind, HISTORY_SELECTION_CAP,
} from "../js/bEpicViewer_historySelection.js";

const snap = (name, extra = {}) => [{ path: `D:/out/${name}`, filename: name, ...extra }];

test("an untouched strip reports nothing, though the newest render is highlighted", () => {
    const r = pickedIndices({ key: "t", multi: [0], viewing: false, viewingKey: "t", viewingIndex: 0 });
    assert.deepEqual(r, { mode: "", indices: [] });
});

test("two or more Ctrl-selected snapshots win over the one that is open", () => {
    const r = pickedIndices({ key: "t", multi: [1, 3], viewing: true, viewingKey: "t", viewingIndex: 2 });
    assert.deepEqual(r, { mode: "multi", indices: [1, 3] });
});

test("a compare pin reports both sides; an opened snapshot reports itself", () => {
    assert.deepEqual(pickedIndices({ key: "t", compare: { key: "t", baseIdx: 0, otherIdx: 4 } }),
                     { mode: "compare", indices: [0, 4] });
    assert.deepEqual(pickedIndices({ key: "t", multi: [2], viewing: true, viewingKey: "t", viewingIndex: 2 }),
                     { mode: "open", indices: [2] });
    // open in another tab is not this tab's pick
    assert.deepEqual(pickedIndices({ key: "t", viewing: true, viewingKey: "u", viewingIndex: 2 }).indices, []);
});

test("an item carries its file, kind, label, prompt id and agentY tag", () => {
    const it = snapshotItem(snap("hero.png", { label: "Hero", group: "Characters", prompt_id: "abc" }), 3,
                            { "D:/out/hero.png": "hero_face" });
    assert.deepEqual(it, { index: 3, kind: "image", path: "D:/out/hero.png", filename: "hero.png",
                           label: "Hero", group: "Characters", prompt_id: "abc", agent_tag: "hero_face" });
    const ref = snapshotItem([{ filename: "c.mp4", subfolder: "x", type: "output" }], 0, null);
    assert.equal(ref.kind, "video");
    assert.equal(ref.path, undefined);
    assert.equal(ref.type, "output");
    assert.equal(frameKind({ filename: "m.glb" }), "model");
    assert.equal(frameKind({ filename: "m.png", kind: "video" }), "video");
});

test("a batch lists its frames", () => {
    const it = snapshotItem([{ path: "a/1.png" }, { path: "a/2.png" }, { path: "a/3.png" }], 0, null);
    assert.equal(it.frames, 3);
    assert.deepEqual(it.frame_paths, ["a/1.png", "a/2.png", "a/3.png"]);
});

test("the answer is capped, with the full count kept", () => {
    const stack = Array.from({ length: 70 }, (_, i) => snap(`f${i}.png`));
    const multi = stack.map((_, i) => i);
    const r = describeHistorySelection({ stack, state: { key: "t", multi }, tab: "t", tabLabel: "Out" });
    assert.equal(r.mode, "multi");
    assert.equal(r.count, 70);
    assert.equal(r.items.length, HISTORY_SELECTION_CAP);
    assert.equal(r.truncated, true);
    assert.equal(r.tab_label, "Out");
});

test("indices that point past the stack are dropped", () => {
    const r = describeHistorySelection({ stack: [snap("a.png")], state: { key: "t", multi: [0, 9] }, tab: "t" });
    assert.equal(r.count, 1);
});
