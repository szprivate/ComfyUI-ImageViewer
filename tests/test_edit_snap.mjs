// node --test tests/test_edit_snap.mjs
// Snapping as Resolve's (imageViewer_editTimelineData.js): what a dragged moment can snap to, and where it lands.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../js/imageViewer_editTimelineData.js";

const shot = (file, length, extra = {}) => ({ file, name: file, in: 0, length, transition: 0, color: "", volume: 1, ...extra });
const CUT = { ...D.emptyCut("t"), clips: [shot("a.mp4", 2), shot("b.mp4", 3, { gap: 1 })],
              texts: [{ text: "hi", start: 4.4, length: 1 }],
              tracks: [{ id: "V2", kind: "video", name: "V2", off: false, clips: [{ file: "c.mp4", name: "c", in: 0, length: 1, at: 7.25 }] },
                       { id: "A2", kind: "audio", name: "A2", off: false, clips: [{ file: "a.mp4", name: "a", in: 0, length: 2, at: 0.6, link: "L1", unlinked: true }] }] };

test("the targets: the start, every clip's edges on every track (sound too), the gap's, texts, playhead, in / out, beats", () => {
    const all = D.snapTargets(CUT, { playhead: 5.5, range: [1.2, 8], beats: [0.5, 1] });
    const at = (kind) => all.filter((g) => g.kind === kind).map((g) => g.t).sort((a, b) => a - b);
    assert.deepEqual(at("start"), [0]);
    assert.deepEqual(at("clip"), [0, 0.6, 2, 2.6, 3, 6, 7.25, 8.25]);
    assert.deepEqual(at("gap"), [2, 3]);
    assert.deepEqual(at("text"), [4.4, 5.4]);
    assert.deepEqual(at("playhead"), [5.5]);
    assert.deepEqual([...at("in"), ...at("out")], [1.2, 8]);
    assert.deepEqual(at("beat"), [0.5, 1]);
    // What is dragged leaves itself out.
    const mine = D.snapTargets(CUT, { exclude: ["V1:1", "A2:0"] });
    assert.ok(!mine.some((g) => g.owner === "V1:1" || g.owner === "A2:0"));
    assert.ok(!D.snapTargets(CUT).some((g) => g.kind === "beat"));            // beats only when asked for
});

test("snapping within the same pixels at every zoom", () => {
    const targets = D.snapTargets(CUT);
    for (const zoom of [1, 4, 32]) {
        const width = 1000 * zoom, total = 10;                                // 100 px a second at zoom 1
        const tol = D.snapSeconds(D.SNAP_PX, total, width);
        const px = (s) => s * width / total;
        // 7 px away from 6: snaps; 12 px away: does not.
        const close = 6 + 7 / (width / total), far = 6 + 12 / (width / total);
        assert.equal(D.snapResolve(close, targets, tol).t, 6, `zoom ${zoom}`);
        assert.equal(D.snapResolve(far, targets, tol).target, null, `zoom ${zoom}`);
        assert.ok(Math.abs(px(tol) - D.SNAP_PX) < 1e-9);
    }
});

test("the nearest target wins; at one distance an edit point before the playhead", () => {
    const targets = [{ t: 1, kind: "playhead", owner: "" }, { t: 1, kind: "clip", owner: "V1:0" }, { t: 1.05, kind: "clip", owner: "V1:1" }];
    assert.equal(D.snapResolve(1.04, targets, 0.1).t, 1.05);
    assert.equal(D.snapResolve(0.98, targets, 0.1).target.kind, "clip");
    assert.equal(D.snapResolve(0.5, targets, 0.1).target, null);
    assert.equal(D.snapResolve(0.5, targets, 0.1).t, 0.5);
});

test("a span snaps by whichever of its edges is nearer", () => {
    const targets = D.snapTargets(CUT);
    const byEnd = D.snapSpan(4.92, 1, targets, 0.1);                        // its end 5.92 -> 6
    assert.equal(byEnd.edge, "end");
    assert.ok(Math.abs(byEnd.at - 5) < 1e-9);
    const byStart = D.snapSpan(2.97, 0.5, targets, 0.1);                    // its start -> 3 (gap end, clip start)
    assert.equal(byStart.edge, "start");
    assert.equal(byStart.at, 3);
    assert.equal(D.snapSpan(4.5, 0.3, targets, 0.05).target, null);
});
