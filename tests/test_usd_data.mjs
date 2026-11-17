// The scene as USD, as data (imageViewer_usdData.js): the edits kept inside a model's
// asset, the prim paths of the saved scene (the server's naming), the Contents rows.
// Run: node --test tests/test_usd_data.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as U from "../js/imageViewer_usdData.js";
import * as S from "../js/imageViewer_scene3d.js";

test("a USD src is known by its file or its format", () => {
    assert.ok(U.isUsdSrc({ path: "D:/a/chair.usda" }));
    assert.ok(U.isUsdSrc({ filename: "x.USDC" }));
    assert.ok(U.isUsdSrc({ path: "/a/b.bin", format: "usd" }));
    assert.ok(!U.isUsdSrc({ path: "/a/hero.glb" }));
    assert.ok(!U.isUsdSrc(null));
});

test("edits are kept clean and take themselves off when they say nothing", () => {
    const it = { id: "m", kind: "model" };
    U.setOver(it, "/Body/Head/", { visible: false });
    assert.deepEqual(it.usd, { overs: { "Body/Head": { visible: false } } });
    U.setVariant(it, "", "look", "metal");
    assert.deepEqual(it.usd.variants, { "": { look: "metal" } });
    assert.ok(U.hiddenByOvers(it, "Body/Head/Eye"));
    assert.ok(!U.hiddenByOvers(it, "Body"));
    U.setOver(it, "Body/Head", { visible: true });
    U.setVariant(it, "", "look", null);
    assert.equal(it.usd, undefined);
    U.setUnloaded(it, true);
    assert.ok(U.isUnloaded(it));
    assert.equal(U.usdEdits(it), null);
    assert.equal(U.readUsdFields({ overs: { a: { visible: true } }, variants: { b: { s: 3 } } }), null);
});

test("the same edits are always spelled the same way", () => {
    const a = U.editsKey({ variants: { "": { b: "1", a: "2" } }, overs: { x: { visible: false } } });
    const b = U.editsKey({ overs: { x: { visible: false } }, variants: { "": { a: "2", b: "1" } } });
    assert.equal(a, b);
});

test("a scene keeps a model's edits", () => {
    const sc = S.parseScene({ items: [{ id: "m", kind: "model", name: "Chair", src: { path: "/c.usda" },
                                        usd: { overs: { Back: { visible: false } }, junk: 1 } }] });
    assert.deepEqual(sc.items[0].usd, { overs: { Back: { visible: false } } });
});

test("prim paths follow the server's naming: legal, unique across the stage, under their parents", () => {
    const scene = { items: [
        { id: "c", name: "Chair", parent: "g" },
        { id: "g", name: "Set dressing", parent: null },
        { id: "c2", name: "Chair", parent: null },
        { id: "n", name: "3d cam", parent: null },
    ] };
    const p = U.primPaths(scene);
    assert.equal(p.get("g"), "/previz/Set_dressing");
    assert.equal(p.get("c"), "/previz/Set_dressing/Chair");
    assert.equal(p.get("c2"), "/previz/Chair_2");
    assert.equal(p.get("n"), "/previz/_3d_cam");
});

test("contents rows fold and search like the bone rows", () => {
    const prims = [
        { rel: "Body", name: "Body", parent: "" },
        { rel: "Body/Head", name: "Head", parent: "Body" },
        { rel: "Body/Arm", name: "Arm", parent: "Body" },
        { rel: "Lamp", name: "Lamp", parent: "" },
    ];
    let rows = U.contentRows(prims);
    assert.deepEqual(rows.map((r) => [r.prim.rel, r.depth]), [["Body", 0], ["Body/Head", 1], ["Body/Arm", 1], ["Lamp", 0]]);
    rows = U.contentRows(prims, { isClosed: (rel) => rel === "Body" });
    assert.deepEqual(rows.map((r) => r.prim.rel), ["Body", "Lamp"]);
    assert.equal(rows[0].hasKids, true);
    assert.equal(rows[0].open, false);
    rows = U.contentRows(prims, { needle: "head", isClosed: () => true });
    assert.deepEqual(rows.map((r) => [r.prim.rel, r.context]), [["Body", true], ["Body/Head", false]]);
});
