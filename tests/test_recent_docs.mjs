import { test } from "node:test";
import assert from "node:assert/strict";
import { recentDocsWith, RECENT_DOCS_MAX } from "../js/bEpicViewer_recentDocs.js";

test("the newest file is first, once, and the list is capped", () => {
    assert.deepEqual(recentDocsWith([], "D:/a.ora"), ["D:/a.ora"]);
    assert.deepEqual(recentDocsWith(["D:/b.ora", "d:\\a.ora"], "D:/a.ora"), ["D:/a.ora", "D:/b.ora"]);
    const many = Array.from({ length: 20 }, (_, i) => `D:/${i}.ora`);
    assert.equal(recentDocsWith(many, "D:/new.ora").length, RECENT_DOCS_MAX);
    assert.deepEqual(recentDocsWith(["D:/b.ora"], ""), ["D:/b.ora"]);
});
