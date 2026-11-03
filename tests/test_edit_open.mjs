import test from "node:test";
import assert from "node:assert/strict";
import { recentWith, RECENT_MAX } from "../js/bEpicViewer_editRecent.js";

test("recentWith puts the newest first, drops a twin and caps the list", () => {
    assert.deepEqual(recentWith(["D:/a.otio", "d:/B.otio"], "D:/b.otio"), ["D:/b.otio", "D:/a.otio"]);
    const many = Array.from({ length: 15 }, (_, i) => `D:/c${i}.otio`);
    assert.equal(recentWith(many, "D:/new.otio").length, RECENT_MAX);
    assert.deepEqual(recentWith(["D:/a.otio"], "D:/x.mp4"), ["D:/a.otio"]);
    assert.deepEqual(recentWith(null, "D:/a.otio"), ["D:/a.otio"]);
});
