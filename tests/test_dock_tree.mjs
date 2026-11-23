// The panel layout as a tree of splits (js/imageViewer_dockTree.js). Run: node --test tests/test_dock_tree.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as T from "../js/imageViewer_dockTree.js";

const RAILS = {
    left: { width: 88, panels: [{ id: "history", size: 1, hidden: false }] },
    right: { width: 320, panels: [{ id: "browser", size: 1, hidden: true }, { id: "params", size: 2, hidden: false }] },
    bottom: { height: 240, panels: [{ id: "curves", size: 1, hidden: false, tab: "c", behind: false },
                                    { id: "dopeSheet", size: 1, hidden: false, tab: "c", behind: true }] },
};
const shape = (n) => T.isView(n) ? "V" : T.isPanel(n) ? n.id : `${n.split}(${n.children.map(shape).join(",")})`;

test("the three rails become splits around the picture, where they stood", () => {
    const L = T.fromRails(RAILS);
    const root = T.tidy(L.root);
    assert.equal(shape(root), "col(row(col(history),V,col(browser,params)),row(curves,dopeSheet))");
    assert.equal(T.railNode(root, "right").px, 320);
    assert.equal(T.railNode(root, "bottom").px, 240);
    assert.equal(T.sideOf(root, "params"), "right");
    assert.equal(T.sideOf(root, "dopeSheet"), "bottom");
    assert.equal(T.locate(root, "dopeSheet").node.behind, true);
});

test("a panel dropped beside the picture takes a fixed room, beside a panel a share", () => {
    let root = T.tidy(T.fromRails(RAILS).root);
    const p = T.detach(root, "params");
    root = T.tidy(root);
    root = T.tidy(T.insertBeside(root, T.findView(root).node, "top", p, 250));
    assert.equal(shape(root), "col(row(col(history),col(params,V),col(browser)),row(curves,dopeSheet))");
    assert.equal(T.locate(root, "params").node.px, 250);
    // Beside the history strip, side by side: the rail splits in two.
    const b = T.detach(root, "browser");
    root = T.tidy(root);
    root = T.tidy(T.insertBeside(root, T.locate(root, "history").node, "right", b));
    assert.equal(shape(root), "col(row(row(history,browser),col(params,V)),row(curves,dopeSheet))");
    const rail = T.railNode(root, "left");
    assert.equal(rail.split, "row");
    assert.equal(T.locate(root, "browser").node.size, 1);
    assert.equal(rail.px, 88, "the rail keeps its width");
});

test("a tab group is split and moved as one", () => {
    let root = T.tidy(T.fromRails(RAILS).root);
    const h = T.detach(root, "history");
    root = T.tidy(root);
    root = T.tidy(T.insertBeside(root, T.locate(root, "dopeSheet").node, "top", h));
    assert.equal(shape(root), "col(row(V,col(browser,params)),col(history,curves,dopeSheet))");
    // The group stays one piece, the front one in front.
    assert.equal(T.locate(root, "curves").node.behind, false);
});

test("taking the front tab out brings the next one to the front", () => {
    const root = T.tidy(T.fromRails(RAILS).root);
    T.detach(root, "curves");
    const d = T.locate(T.tidy(root), "dopeSheet").node;
    assert.equal(d.behind, false);
    assert.equal(d.tab, undefined, "alone in its group, it is a panel");
});

test("tidy keeps one view, drops unknown and doubled panels, and never fixes the picture's size", () => {
    const root = T.tidy({ split: "row", children: [{ view: true, px: 40 }, { id: "a" }, { id: "a" }, { id: "zz" },
                                                  { split: "col", px: 99, children: [{ view: true }] }] },
                        (id) => id !== "zz");
    assert.equal(shape(root), "row(V,a)");
    assert.equal(T.findView(root).node.px, undefined);
    const none = T.tidy({ split: "col", children: [{ id: "a" }] });
    assert.equal(shape(none), "col(a,V)", "a layout without the picture gets it back");
});

test("flex: fixed rooms stay fixed while something grows, shares under 1 are scaled up", () => {
    const s = { split: "row", children: [{ id: "a", px: 200 }, { view: true }, { id: "b", px: 300, hidden: true }] };
    assert.deepEqual(T.flexOf(s).map((f) => [f.grow, f.basis]), [[0, 200], [1, 0]]);
    const c = { split: "col", children: [{ id: "a", size: 0.3 }, { id: "b", size: 0.2, collapsed: true }] };
    assert.deepEqual(T.flexOf(c).map((f) => [f.grow, f.basis]), [[1, 0], [0, "auto"]]);
    const fixed = { split: "row", children: [{ id: "a", px: 100 }, { id: "b", px: 300 }] };
    assert.deepEqual(T.flexOf(fixed).map((f) => [f.grow, f.basis]), [[100, 0], [300, 0]], "nothing to grow: by their sizes");
});

test("a pane of folded panels keeps its width across a row, and folds only down a column", () => {
    const pane = { split: "col", px: 300, children: [{ id: "a", collapsed: true }, { id: "b", collapsed: true }] };
    const row = { split: "row", children: [{ view: true }, pane] };
    assert.deepEqual(T.flexOf(row).map((f) => [f.grow, f.basis]), [[1, 0], [0, 300]], "the pane keeps its 300 px");
    assert.deepEqual(T.flexOf(pane).map((f) => f.basis), ["auto", "auto"], "the panels are their title bars");
    const shares = { split: "row", children: [{ id: "a", size: 1, collapsed: true }, { id: "b", size: 1 }] };
    assert.deepEqual(T.flexOf(shares).map((f) => f.grow), [1, 1], "a folded panel beside another in a row keeps its share");
    assert.equal(T.minSize({ id: "a", collapsed: true }, "w", () => ({ w: 80, h: 60 })), 80, "no wider folded than open");
});

test("minimum sizes add up along a split and take the largest across it", () => {
    const minOf = (id) => ({ a: { w: 200, h: 100 }, b: { w: 150, h: 300 } })[id];
    const s = { split: "row", children: [{ id: "a" }, { id: "b" }] };
    assert.equal(T.minSize(s, "w", minOf), 355);
    assert.equal(T.minSize(s, "h", minOf), 300);
});

test("the root can be split at its edge", () => {
    let root = T.tidy(T.fromRails(RAILS).root);
    const p = T.detach(root, "params");
    root = T.tidy(root);
    root = T.tidy(T.insertBeside(root, root, "left", p, 280));
    assert.equal(shape(root), "row(params,col(row(col(history),V,col(browser)),row(curves,dopeSheet)))");
    assert.equal(T.locate(root, "params").node.px, 280);
});

test("a clean copy keeps only what a layout is made of", () => {
    const root = T.tidy(T.fromRails(RAILS).root);
    T.locate(root, "params").node.junk = 1;
    const copy = T.cleanCopy(root);
    assert.equal(JSON.stringify(copy).includes("junk"), false);
    assert.equal(shape(T.tidy(copy)), shape(root));
    assert.ok(T.isTreeLayout({ v: 2, root: copy }));
    assert.ok(T.isRailLayout(RAILS));
});

test("a panel dropped on the main view becomes a tab of it, and leaves it again", () => {
    let root = T.tidy(T.fromRails(RAILS).root);
    const p = T.detach(root, "params");
    root = T.tidy(root);
    root = T.tidy(T.insertAsTab(root, "view", p));
    const v = T.findView(root);
    assert.equal(shape(root), "col(row(col(history),V,params,col(browser)),row(curves,dopeSheet))");
    assert.ok(v.node.tab && v.node.tab === T.locate(root, "params").node.tab);
    assert.equal(v.node.behind, true);
    assert.equal(T.locate(root, "params").node.behind, false);
    assert.equal(T.locate(root, "params").node.px, undefined);      // it takes the view's room
    assert.deepEqual(T.shownChildren(v.parent).map(shape), ["col(history)", "params"]);
    // Kept in a saved copy.
    const copy = T.tidy(T.cleanCopy(root));
    assert.equal(T.findView(copy).node.behind, true);
    // The panel moved away: the view is alone again, in front, no tab left.
    const back = T.detach(root, "params");
    root = T.tidy(root);
    const v2 = T.findView(root).node;
    assert.equal(v2.tab, undefined);
    assert.equal(!!v2.behind, false);
    root = T.tidy(T.insertBeside(root, T.findView(root).node, "left", back, 300));
    assert.equal(T.locate(root, "params").node.px, 300);
});

test("a panel hidden in front of the main view gives the place back to the view", () => {
    let root = T.tidy(T.fromRails(RAILS).root);
    const p = T.detach(root, "params");
    root = T.tidy(T.insertAsTab(T.tidy(root), "view", p));
    T.locate(root, "params").node.hidden = true;
    root = T.tidy(root);
    const v = T.findView(root).node;
    assert.equal(v.behind, false);
});
