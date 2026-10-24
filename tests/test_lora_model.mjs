// node --test tests/test_lora_model.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../js/bEpicViewer_loraModel.js";

const mk = () => ({
  version: 1, name: "cat", trigger_word: "ohwx", model: "flux", status: "review",
  summary: { count: 3, included: 3, removed: 0, warnings: ["small set"] },
  items: [
    { id: "i1", file: "items/i1.png", kind: "image", caption: "ohwx a cat on a sofa", included: true, crop: null },
    { id: "i2", file: "items/i2.png", kind: "image", caption: "a Cat outside", included: true, crop: null },
    { id: "i3", file: "items/i3.png", kind: "image", caption: "ohwx cat cat", included: true, crop: null },
  ],
});

test("summary counts and recount keep warnings", () => {
  const m = mk();
  assert.deepEqual(L.summary(m), { count: 3, included: 3, removed: 0, warnings: ["small set"] });
  m.items[1].included = false;
  L.recount(m);
  assert.deepEqual(m.summary, { count: 3, included: 2, removed: 1, warnings: ["small set"] });
});

test("toggle excludes as the user, restore brings it back and clears the mark", () => {
  const m = mk();
  assert.equal(L.toggleItem(m, "i2", "blurry"), false);
  const it = L.itemById(m, "i2");
  assert.equal(it.included, false); assert.equal(it.removed_by, "user"); assert.equal(it.note, "blurry");
  assert.equal(m.summary.included, 2);
  assert.equal(L.toggleItem(m, "i2"), true);
  assert.equal(it.included, true); assert.equal(it.removed_by, null);
  assert.equal(L.toggleItem(m, "nope"), null);
});

test("remove many and restore", () => {
  const m = mk();
  assert.equal(L.removeItems(m, ["i1", "i3", "zz"], "dupes"), 2);
  assert.equal(L.removeItems(m, ["i1"]), 0);
  assert.deepEqual(L.split(m).removed.map((i) => i.id), ["i1", "i3"]);
  assert.equal(L.restoreItem(m, "i1"), true);
  assert.equal(L.restoreItem(m, "i1"), false);
  assert.deepEqual(m.summary, { count: 3, included: 2, removed: 1, warnings: ["small set"] });
});

test("caption edit", () => {
  const m = mk();
  assert.equal(L.setCaption(m, "i1", "new"), true);
  assert.equal(m.items[0].caption, "new");
  assert.equal(L.setCaption(m, "x", "n"), false);
});

test("bulk replace: case, ids, removed items, regex, whole word", () => {
  const m = mk();
  assert.equal(L.bulkReplace(m, "cat", "dog"), 3);
  assert.deepEqual(m.items.map((i) => i.caption), ["ohwx a dog on a sofa", "a dog outside", "ohwx dog dog"]);
  const m2 = mk();
  assert.equal(L.bulkReplace(m2, "Cat", "dog", { caseSensitive: true }), 1);
  assert.equal(m2.items[1].caption, "a dog outside");
  const m3 = mk(); L.removeItem(m3, "i2");
  assert.equal(L.bulkReplace(m3, "cat", "x"), 2);                       // the removed one is left alone
  assert.equal(m3.items[1].caption, "a Cat outside");
  assert.equal(L.bulkReplace(m3, "cat", "x", { ids: ["i2"] }), 1);      // unless asked for by id
  const m4 = mk();
  assert.equal(L.bulkReplace(m4, "([a-z]+) cat", "$1 kitten", { regex: true }), 3);
  assert.equal(m4.items[0].caption, "ohwx a kitten on a sofa");
  const m5 = mk();
  assert.equal(L.bulkReplace(m5, "a", "X", { wholeWord: true }), 2);
  assert.equal(L.bulkReplace(m5, "$&", "y"), 0);                         // special chars are literal
  assert.throws(() => L.bulkReplace(mk(), "(", "x", { regex: true }));
  assert.equal(L.bulkReplace(mk(), "", "x"), 0);
});

test("replacement text is literal when not a regex", () => {
  const m = mk();
  L.bulkReplace(m, "sofa", "$& couch");
  assert.equal(m.items[0].caption, "ohwx a cat on a $& couch");
});

test("trigger word: ensure, change with and without rewrite", () => {
  const m = mk();
  assert.equal(L.ensureTrigger(m), 1);
  assert.equal(m.items[1].caption, "ohwx, a Cat outside");
  assert.equal(L.ensureTrigger(m), 0);
  const r = L.setTrigger(m, "zzy", true);
  assert.equal(r.changed, 3);
  assert.deepEqual(m.items.map((i) => i.caption), ["zzy a cat on a sofa", "zzy, a Cat outside", "zzy cat cat"]);
  assert.equal(m.trigger_word, "zzy");
  const m2 = mk();
  assert.deepEqual(L.setTrigger(m2, "abc", false), { changed: 0 });
  assert.equal(m2.items[0].caption, "ohwx a cat on a sofa");
  const m3 = mk(); m3.trigger_word = "";
  L.setTrigger(m3, "new", true);
  assert.equal(m3.items.every((i) => L.hasTrigger(i.caption, "new")), true);
  assert.equal(L.hasTrigger("ohwxy thing", "ohwx"), false);
});

test("crop: clamp, drag, set, clear", () => {
  assert.deepEqual(L.clampCrop([-0.2, 0.5, 2, 0.2]), [0, 0.5, 1, 0.2]);
  assert.deepEqual(L.clampCrop([0.9, 0.9, 0.5, 0.5]), [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(L.clampCrop([0.1, 0.1, 0, 0]), [0.1, 0.1, L.MIN_CROP, L.MIN_CROP]);
  assert.equal(L.clampCrop([1, 2]), null);
  assert.equal(L.clampCrop(["a", 0, 1, 1]), null);
  assert.deepEqual(L.cropFromDrag([0.6, 0.7], [0.2, 0.1]), [0.2, 0.1, 0.4, 0.6]);
  assert.deepEqual(L.cropFromDrag([-1, -1], [2, 2]), [0, 0, 1, 1]);
  const m = mk();
  assert.deepEqual(L.setCrop(m, "i1", [0.1, 0.1, 0.5, 0.5]), [0.1, 0.1, 0.5, 0.5]);
  assert.deepEqual(m.items[0].crop, [0.1, 0.1, 0.5, 0.5]);
  assert.equal(L.setCrop(m, "i1", [0, 0, 1, 1]), null);                  // the whole picture is no crop
  assert.equal(m.items[0].crop, null);
  assert.equal(L.setCrop(m, "zz", [0, 0, 0.5, 0.5]), undefined);
});

test("dirty, issues, history", () => {
  const m = mk(); const saved = L.clone(m);
  assert.equal(L.isDirty(saved, m), false);
  const h = new L.History();
  h.push(m); L.setCaption(m, "i1", "changed");
  assert.equal(L.isDirty(saved, m), true);
  assert.equal(L.captionIssues(m).length, 2 /* i1 lost trigger, i2 never had it */);
  const back = h.undo(m);
  assert.equal(back.items[0].caption, "ohwx a cat on a sofa");
  assert.equal(L.isDirty(saved, back), false);
  assert.deepEqual(h.redo(back).items[0].caption, "changed");
});

test("training helpers: smoothing, sparkline, durations, events, polling", () => {
  const s = L.smoothLoss([[1, 1], [2, 0], [3, "x"], [4, 0]], 0.5);
  assert.deepEqual(s, [[1, 1], [2, 0.5], [4, 0.25]]);
  assert.equal(L.sparkPath([[1, 1]], 100, 20), "");
  const d = L.sparkPath([[0, 0], [10, 1]], 100, 20, 0);
  assert.equal(d, "M0.0 20.0 L100.0 0.0");
  assert.ok(L.sparkPath([[0, 5], [1, 5]], 100, 20).startsWith("M"));   // flat series does not divide by zero
  assert.equal(L.fmtDuration(null), "-"); assert.equal(L.fmtDuration(12), "12s");
  assert.equal(L.fmtDuration(245), "4m 05s"); assert.equal(L.fmtDuration(3720), "1h 02m");
  const ev = [{ id: 3 }, { id: 1 }, { id: 2 }];
  assert.deepEqual(L.eventsAfter(ev, 1).map((e) => e.id), [2, 3]);
  assert.equal(L.maxEventId(ev), 3); assert.equal(L.maxEventId([]), 0);
  assert.equal(L.pollDelay("running", true), 3000);
  assert.ok(L.pollDelay("done", true) > 3000);
  assert.ok(L.pollDelay("running", false) > 3000);
  assert.deepEqual(L.sampleSteps([{ step: 5, files: [] }, { step: 1, files: [] }, { nope: 1 }]).map((x) => x.step), [1, 5]);
});

test("two curves can share one scale", () => {
  const raw = [[0, 0], [10, 10]];
  const r = L.seriesRange(raw);
  assert.deepEqual(r, { x0: 0, x1: 10, y0: 0, y1: 10 });
  assert.equal(L.sparkPath([[0, 5], [10, 5]], 100, 20, 0, r), "M0.0 10.0 L100.0 10.0");
  assert.equal(L.seriesRange([]), null);
});
