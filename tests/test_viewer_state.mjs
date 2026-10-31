// node --test tests/test_viewer_state.mjs
// What the viewer tells agentY it is showing (viewerState) and the marks on it
// (annotations): bEpicViewer_viewerState.js shapes the snapshot the panel gathers.
import test from "node:test";
import assert from "node:assert/strict";
import {
    describeViewerState, annotationReport, describeMark, rawMark, TABS_CAP, MARKS_CAP,
} from "../js/bEpicViewer_viewerState.js";

const fr = (name, extra = {}) => ({ path: `D:/out/${name}`, filename: name, type: "output", ...extra });

test("a closed viewer says only that it is closed", () => {
    assert.deepEqual(describeViewerState({ open: false, display: "closed" }),
                     { source: "viewer", open: false, visible: false, display: "closed" });
});

test("tab, item, frame range, loop and playing state of a clip", () => {
    const s = describeViewerState({
        open: true, visible: true, display: "docked", dockSide: "right",
        tab: { key: "named:agentY", label: "agentY", mode: "video" },
        tabs: [{ key: "named:agentY", label: "agentY", frames: 1, history: 12 }, { key: "7", label: "Save", frames: 4, history: 0 }],
        item: { frame: fr("cut.mp4", { prompt_id: "p1", label: "Hero", kind: "video" }), index: 0, of: 1,
                historyIndex: 3, agentTag: "hero", colorTag: "green" },
        timeline: { video: true, frames: 96, fps: 24, current: 50, range: { start: 72, end: 48 }, loop: "pingpong", playing: true },
        view: { zoom: 2, panX: 0, panY: 0, channel: "all", exposure: 0.5 },
        annotations: { count: 3, ranges: 2, onFrame: 1 },
    });
    assert.equal(s.display, "docked");
    assert.equal(s.dock_side, "right");
    assert.deepEqual(s.tab, { key: "named:agentY", label: "agentY", mode: "video" });
    assert.deepEqual(s.tabs[0], { key: "named:agentY", label: "agentY", frames: 1, history: 12 });
    assert.deepEqual(s.tabs[1], { key: "7", label: "Save", frames: 4 });
    assert.equal(s.item.path, "D:/out/cut.mp4");
    assert.equal(s.item.filename, undefined);              // a path says it all
    assert.equal(s.item.kind, "video");
    assert.equal(s.item.prompt_id, "p1");
    assert.equal(s.item.history_index, 3);
    assert.equal(s.item.agent_tag, "hero");
    assert.equal(s.item.color_tag, "green");
    assert.equal(s.timeline.current, 50);
    assert.equal(s.timeline.timecode, "00:00:02.02");
    assert.deepEqual(s.timeline.range, { start: 48, end: 72, frames: 25, start_tc: "00:00:02.00", end_tc: "00:00:03.00" });
    assert.equal(s.timeline.loop, "pingpong");
    assert.equal(s.timeline.playing, true);
    assert.deepEqual(s.view, { zoom: 2, channel: "all", exposure: 0.5 });
    assert.deepEqual(s.annotations, { count: 3, ranges: 2, on_frame: 1 });
});

test("a single picture has no timeline, and the list of tabs is capped", () => {
    const tabs = Array.from({ length: TABS_CAP + 5 }, (_, i) => ({ key: `t${i}`, label: `T${i}`, frames: 1 }));
    const s = describeViewerState({ open: true, display: "popout", tabs, tab: { key: "t0" },
                                    item: { frame: fr("a.png"), index: 0, of: 1 },
                                    timeline: { video: false, frames: 1, fps: 25, current: 0 } });
    assert.equal(s.display, "popout");
    assert.equal(s.timeline, undefined);
    assert.equal(s.tabs.length, TABS_CAP);
    assert.equal(s.tabs_total, TABS_CAP + 5);
    assert.equal(s.annotations, undefined);                // none: not mentioned
});

test("compare, the Edit panel's selection and the 3D camera", () => {
    const s = describeViewerState({
        open: true, display: "fullscreen",
        compare: { mode: "history", a: { index: 0, frame: fr("a.png") }, b: { index: 4, frame: fr("b.png") },
                   wipe: { mode: "vertical", position: 37.5 } },
        edit: { open: true, tab: "edit:cut", cut: "cut", clips: 3, fps: 24,
                selected: { kind: "clip", index: 1, name: "shot 2", file: "D:/out/s2.mp4", in: 0.5, length: 2 } },
        camera: { name: "cam1", fov: 35, aspect: 1.7777, position: [1, 2, 3], cameraWorld: Array(16).fill(0) },
    });
    assert.deepEqual(s.compare.a, { index: 0, kind: "image", path: "D:/out/a.png" });
    assert.equal(s.compare.b.index, 4);
    assert.deepEqual(s.compare.wipe, { mode: "vertical", position: 0.375 });
    assert.deepEqual(s.edit.selected, { kind: "clip", index: 1, name: "shot 2", file: "D:/out/s2.mp4", in: 0.5, length: 2 });
    assert.equal(s.camera.name, "cam1");
    assert.deepEqual(s.camera.position, [1, 2, 3]);
    assert.equal(s.camera.camera_world.length, 16);
});

test("a Contact Sheet of several history items: the count and the indices, small", () => {
    const s = describeViewerState({
        open: true, display: "docked",
        compare: { mode: "contact", items: 20, shown: 16, indices: Array.from({ length: 20 }, (_, i) => i),
                   grid: [4, 4], a: { index: 3, frame: fr("a.png") }, b: { index: 1, frame: fr("b.png") },
                   wipe: { mode: "contact", position: 50 } },
    });
    assert.equal(s.compare.mode, "contact");
    assert.equal(s.compare.items, 20);
    assert.equal(s.compare.shown, 16);
    assert.equal(s.compare.indices.length, 16);
    assert.deepEqual(s.compare.grid, [4, 4]);
    assert.equal(s.compare.a.index, 3);
    // A plain pair says nothing of items.
    const p = describeViewerState({ open: true, display: "docked", compare: { mode: "history", a: { index: 0 }, b: { index: 1 } } });
    assert.equal(p.compare.items, undefined);
});

const NOTE = { id: "a1", type: "text", x: 0.1, y: 0.1, size: 40, color: "#ff0", text: "logo too small", _editing: true };
const BOX = { id: "a2", type: "rect", a: { x: 0.5, y: 0.5 }, b: { x: 0.25, y: 0.25 }, color: "#f00", width: 6 };
const PEN = { id: "a3", type: "pen", pts: [{ x: 0.7, y: 0.7 }, { x: 0.8, y: 0.9 }], color: "#0f0", width: 4 };
const ARROW = { id: "a4", type: "arrow", a: { x: 0.9, y: 0.1 }, b: { x: 0.6, y: 0.4 }, color: "#fff", width: 6 };

test("a picture's marks: one set, notes first-class, normalised coordinates and words", () => {
    const r = annotationReport({ kind: "image", source: "D:/out/a.png", w: 1000, h: 500, items: [BOX, NOTE, PEN, ARROW] });
    assert.equal(r.kind, "image");
    assert.equal(r.count, 4);
    assert.equal(r.width, 1000);
    assert.equal(r.annotations.length, 1);
    const g = r.annotations[0];
    assert.equal(g.frame, undefined);
    assert.deepEqual(g.notes, ["logo too small"]);
    const box = g.marks.find((m) => m.type === "box");
    assert.deepEqual(box.box, { x1: 0.25, y1: 0.25, x2: 0.5, y2: 0.5 });
    assert.match(box.description, /^box from 25%,25% to 50%,50%/);
    const text = g.marks.find((m) => m.type === "text");
    assert.deepEqual(text.at, { x: 0.1, y: 0.1 });
    assert.match(text.description, /\(100,50 px, top left\)/);
    assert.equal(g.marks.find((m) => m.type === "stroke").points, 2);
    assert.deepEqual(g.marks.find((m) => m.type === "arrow").to, { x: 0.6, y: 0.4 });
    assert.equal(r.items, undefined);                    // the raw marks only when asked
});

test("a clip's marks: grouped per frame range with timecodes, one frame on request", () => {
    const items = [{ ...NOTE, f: 72, fe: 80 }, { ...BOX, f: 72, fe: 80 }, { ...PEN, f: 10, fe: 10 }];
    const r = annotationReport({ kind: "video", source: "D:/out/cut.mp4", w: 640, h: 360, fps: 24, frames: 96, items });
    assert.deepEqual(r.annotations.map((g) => [g.frame, g.end]), [[10, 10], [72, 80]]);
    assert.equal(r.annotations[1].timecode, "00:00:03.00");
    assert.equal(r.annotations[1].end_timecode, "00:00:03.08");
    assert.equal(r.annotations[0].end_timecode, undefined);
    const one = annotationReport({ kind: "video", fps: 24, items, frame: 75 });
    assert.equal(one.count, 2);
    assert.equal(one.frame, 75);
});

test("raw marks for a mask lose the tool's bookkeeping; the answer is capped", () => {
    const r = annotationReport({ kind: "image", items: [NOTE, BOX], raw: true });
    assert.deepEqual(r.items[0], { type: "text", color: "#ff0", x: 0.1, y: 0.1, size: 40, text: "logo too small" });
    assert.equal(rawMark(BOX).id, undefined);
    const many = Array.from({ length: MARKS_CAP + 3 }, () => BOX);
    const big = annotationReport({ kind: "image", items: many });
    assert.equal(big.count, MARKS_CAP + 3);
    assert.equal(big.annotations[0].marks.length, MARKS_CAP);
    assert.equal(big.truncated, true);
});

test("something that is not a mark is skipped", () => {
    assert.equal(describeMark({ type: "evil" }, 1, 1, 0), null);
    assert.equal(describeMark(null), null);
    assert.equal(annotationReport({ kind: "image", items: [null, { type: "evil" }] }).annotations.length, 0);
});
