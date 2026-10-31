// node --test tests/test_history_agent_tags.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    buildAgentTagIndex, agentTagsOfSnapshot, agentTagIndexSig, agentFilterValue, agentFilterName, normPath,
} from "../js/bEpicViewer_historyAgentTags.js";

const list = [
    { tag: "hero_face", path: String.raw`D:\out\Hero.png`, source: "canvas" },
    { tag: "set", path: "D:/out/set.png", source: "memory" },
    { tag: "loader", path: "refs/a.png [input]", source: "canvas" },
    { tag: "nofile", path: "" },
];

test("filter values round-trip and a colour id is not an agentY one", () => {
    assert.equal(agentFilterValue("hero_face"), "agent:hero_face");
    assert.equal(agentFilterName("agent:hero_face"), "hero_face");
    assert.equal(agentFilterName("red"), "");
    assert.equal(agentFilterName("any"), "");
});

test("the index lists every name sorted, with or without a file", () => {
    const ix = buildAgentTagIndex(list, { "D:/out/viewer.png": "#mine" });
    assert.deepEqual(ix.names, ["hero_face", "loader", "mine", "nofile", "set"]);
});

test("a snapshot is found by its path whatever the slashes or drive-letter case", () => {
    const ix = buildAgentTagIndex(list, null);
    assert.deepEqual(agentTagsOfSnapshot(ix, [{ path: "d:/out/Hero.png" }]), ["hero_face"]);
    assert.deepEqual(agentTagsOfSnapshot(ix, [{ path: "D:/out/set.png" }, { path: "D:/out/other.png" }]), ["set"]);
    assert.deepEqual(agentTagsOfSnapshot(ix, [{ path: "D:/out/none.png" }]), []);
});

test("a frame with no path matches a loader's relative file by subfolder and name", () => {
    const ix = buildAgentTagIndex(list, null);
    assert.deepEqual(agentTagsOfSnapshot(ix, [{ filename: "a.png", subfolder: "refs", type: "input" }]), ["loader"]);
    assert.deepEqual(agentTagsOfSnapshot(ix, [{ filename: "b.png", subfolder: "refs" }]), []);
});

test("tags the viewer gave a picture join the list, and two names on one file both show", () => {
    const ix = buildAgentTagIndex(list, { "D:/out/set.png": "backdrop" });
    assert.deepEqual(agentTagsOfSnapshot(ix, [{ path: "D:/out/set.png" }]).sort(), ["backdrop", "set"]);
});

test("the signature changes when a tag is renamed or moved to another file", () => {
    const a = agentTagIndexSig(buildAgentTagIndex(list, null));
    const renamed = list.map((e) => (e.tag === "set" ? { ...e, tag: "stage" } : e));
    const moved = list.map((e) => (e.tag === "set" ? { ...e, path: "D:/out/b.png" } : e));
    assert.notEqual(a, agentTagIndexSig(buildAgentTagIndex(renamed, null)));
    assert.notEqual(a, agentTagIndexSig(buildAgentTagIndex(moved, null)));
    assert.equal(a, agentTagIndexSig(buildAgentTagIndex(list, null)));
});

test("bad input gives an empty index", () => {
    const ix = buildAgentTagIndex(null, null);
    assert.deepEqual(ix.names, []);
    assert.deepEqual(agentTagsOfSnapshot(ix, [{ path: "x" }]), []);
    assert.deepEqual(agentTagsOfSnapshot(null, [{ path: "x" }]), []);
    assert.equal(normPath(undefined), "");
});

test("one tag whatever its spelling: the store files hero_face and Hero-Face alike", async () => {
    const { buildAgentTagIndex, agentTagKey, agentTagsOfSnapshot } = await import("../js/bEpicViewer_historyAgentTags.js");
    assert.equal(agentTagKey("#Hero Face"), "hero-face");
    assert.equal(agentTagKey("hero_face"), agentTagKey("Hero-Face"));
    const index = buildAgentTagIndex([{ tag: "hero_face", path: "D:/out/a.png" }, { tag: "Hero-Face", path: "D:/out/b.png" }],
                                     { "D:/out/c.png": "HERO_FACE" });
    assert.deepEqual(index.names, ["hero_face"]);
    assert.deepEqual(agentTagsOfSnapshot(index, [{ path: "D:/out/b.png" }]), ["hero_face"]);
    assert.deepEqual(agentTagsOfSnapshot(index, [{ path: "D:/out/c.png" }]), ["hero_face"]);
});
