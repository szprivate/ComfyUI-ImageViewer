// node --test tests/test_mg_refs.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mgRefQuery, mgMayHaveScene, mgIsSceneFile, mgRefName } from "../js/bEpicViewer_mgRefs.js";

test("a path is named by path, a history item by filename + type + subfolder", () => {
    assert.equal(mgRefQuery("D:/out/a b.mp4"), "path=D%3A%2Fout%2Fa%20b.mp4");
    assert.equal(mgRefQuery({ path: "/x/a.png", filename: "ignored" }), "path=%2Fx%2Fa.png");
    assert.equal(mgRefQuery({ filename: "t.mp4", subfolder: "mg/one" }), "filename=t.mp4&type=output&subfolder=mg%2Fone");
    assert.equal(mgRefQuery({ filename: "t.mp4", type: "temp" }), "filename=t.mp4&type=temp");
    assert.equal(mgRefQuery(null), "");
});

test("which files can have a motion scene: scene files, poster PNGs and films (mp4 on macOS too)", () => {
    for (const ok of ["a.mgscene.json", "A.MGSCENE.JSON", "t.mp4", "t.MOV", "t.webm", "poster.png", { filename: "t.mp4" }, { path: "/Users/me/t.m4v" }]) {
        assert.equal(mgMayHaveScene(ok), true, JSON.stringify(ok));
    }
    for (const no of ["a.json", "a.jpg", "a.exr", "", null, {}, { filename: "a.glb" }]) assert.equal(mgMayHaveScene(no), false, JSON.stringify(no));
});

test("a scene file needs no question to the server", () => {
    assert.equal(mgIsSceneFile("x/y.mgscene.json"), true);
    assert.equal(mgIsSceneFile({ filename: "y.mgscene.json" }), true);
    assert.equal(mgIsSceneFile("x/y.png"), false);
    assert.equal(mgRefName({ filename: "q.png" }), "q.png");
});
