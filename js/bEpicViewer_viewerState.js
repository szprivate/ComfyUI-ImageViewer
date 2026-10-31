// bEpicViewer_viewerState.js
// What the viewer is showing, and the marks on it, as agentY reads them.
//
// agentY (agentY-comfyuiConnect) asks the page through
//   window.bEpicViewerApi.viewerState()        - which tab, which item, the frame,
//                                                the range, compare, view, camera
//   window.bEpicViewerApi.annotations(opts)    - the Annotation tool's marks on
//                                                the item on screen, in words and
//                                                normalised coordinates
// with each chat message (viewerState, only while the viewer is open) and when the
// agent calls get_viewer_state / get_viewer_annotations mid-turn.
//
// The panel gathers a plain snapshot of its JS state (bEpicViewer_agentState.js);
// the functions here only shape it, so node --test can load them
// (tests/test_viewer_state.mjs). Nothing reads the DOM: the answer is the same
// docked, full screen or popped out.

import { describeItem, timecode, whereIs } from "./bEpicViewer_annotateReport.js";
import { frameKind } from "./bEpicViewer_historySelection.js";

/** Most tabs one answer lists; tabs_total says how many there are. */
export const TABS_CAP = 20;
/** Most marks one annotations answer carries; count says how many there were. */
export const MARKS_CAP = 200;
/** Longest text of one mark kept in an answer. */
export const TEXT_CAP = 500;

const r4 = (v) => Math.round(Number(v) * 10000) / 10000;
const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const pt = (p) => ({ x: r4(p && p.x), y: r4(p && p.y) });

function put(out, k, v) {
    if (v !== undefined && v !== null && v !== "" && !(typeof v === "number" && !Number.isFinite(v))) out[k] = v;
}

/** One frame (an entry of a tab or a history snapshot) as the agent reads it. */
export function describeFrame(fr, extra) {
    if (!fr || typeof fr !== "object") return null;
    const out = {};
    Object.assign(out, extra || {});
    out.kind = frameKind(fr);
    put(out, "path", typeof fr.path === "string" ? fr.path : "");
    if (!out.path) {
        put(out, "filename", fr.filename || fr.name || "");
        put(out, "subfolder", fr.subfolder || "");
        put(out, "type", fr.type || "");
    }
    put(out, "label", fr.label || "");
    put(out, "group", fr.group || "");
    put(out, "prompt_id", fr.prompt_id || "");
    if (fr.dropped) out.dropped = true;
    return out;
}

/** One mark as the agent reads it: what it is, where, and its words. */
export function describeMark(it, w, h, fps) {
    if (!it || typeof it !== "object") return null;
    const m = { type: it.type === "rect" ? "box" : it.type === "pen" ? "stroke" : it.type };
    put(m, "color", it.color || "");
    if (it.f !== undefined) {
        m.frame = Math.round(it.f);
        m.end = Math.round(it.fe === undefined ? it.f : it.fe);
    }
    if (it.type === "text") {
        m.text = String(it.text || "").slice(0, TEXT_CAP);
        m.at = pt(it);
        m.where = whereIs(it.x, it.y);
    } else if (it.type === "arrow" && it.a && it.b) {
        m.from = pt(it.a);
        m.to = pt(it.b);
        m.where = whereIs(it.b.x, it.b.y);
    } else if (it.type === "rect" && it.a && it.b) {
        const x1 = Math.min(it.a.x, it.b.x), x2 = Math.max(it.a.x, it.b.x);
        const y1 = Math.min(it.a.y, it.b.y), y2 = Math.max(it.a.y, it.b.y);
        m.box = { x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2) };
        m.where = whereIs((x1 + x2) / 2, (y1 + y2) / 2);
    } else if (it.type === "pen" && Array.isArray(it.pts) && it.pts.length) {
        const xs = it.pts.map((p) => p.x), ys = it.pts.map((p) => p.y);
        const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
        m.box = { x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2) };
        m.points = it.pts.length;
        m.where = whereIs((x1 + x2) / 2, (y1 + y2) / 2);
    } else {
        return null;
    }
    if (finite(it.width) && it.type !== "text") m.width = Math.round(it.width);
    m.description = describeItem(it, w || 0, h || 0);
    if (m.frame !== undefined && fps > 0) m.timecode = timecode(m.frame, fps);
    return m;
}

/**
 * The marks on one item, gathered per frame range (a video) or as one set (a
 * picture).
 *   kind      "image" | "video"
 *   source    the file the marks are about (path), or ""
 *   w, h      the picture's size in pixels (0 when not known)
 *   fps, frames  the video's rate and length (video only)
 *   items     the marks as the Annotation tool stores them (normalised 0..1)
 *   frame     only the marks shown on this frame (video), when given
 *   raw       also hand back the stored marks themselves (for a mask)
 */
export function annotationReport({ kind, source, w, h, fps, frames, items, frame, raw, cap = MARKS_CAP }) {
    const video = kind === "video";
    let list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it === "object");
    if (video && Number.isInteger(frame)) {
        list = list.filter((it) => it.f === undefined
            || (it.f <= frame && frame <= (it.fe === undefined ? it.f : it.fe)));
    }
    const out = { kind: video ? "video" : "image", count: list.length };
    put(out, "source", source || "");
    if (w > 0 && h > 0) { out.width = Math.round(w); out.height = Math.round(h); }
    if (video) {
        if (fps > 0) out.fps = r3(fps);
        if (frames > 0) out.frames = Math.round(frames);
        if (Number.isInteger(frame)) out.frame = frame;
    }
    const groups = new Map();
    let kept = 0;
    for (const it of list) {
        if (kept >= cap) break;
        const m = describeMark(it, w, h, video ? fps : 0);
        if (!m) continue;
        kept += 1;
        const f = video && it.f !== undefined ? Math.round(it.f) : 0;
        const e = video && it.f !== undefined ? Math.round(it.fe === undefined ? it.f : it.fe) : 0;
        const k = `${f}:${e}`;
        if (!groups.has(k)) {
            const g = video ? { frame: f, end: e } : {};
            if (video && fps > 0) {
                g.timecode = timecode(f, fps);
                if (e > f) g.end_timecode = timecode(e, fps);
            }
            g.notes = [];
            g.marks = [];
            groups.set(k, g);
        }
        const g = groups.get(k);
        delete m.frame; delete m.end; delete m.timecode;   // said once, on the group
        if (m.type === "text" && m.text.trim()) g.notes.push(m.text.trim());
        g.marks.push(m);
    }
    out.annotations = [...groups.values()].sort((a, b) => (a.frame || 0) - (b.frame || 0) || (a.end || 0) - (b.end || 0));
    for (const g of out.annotations) if (!g.notes.length) delete g.notes;
    if (list.length > kept) out.truncated = true;
    if (raw) out.items = list.slice(0, cap).map(rawMark).filter(Boolean);
    return out;
}

/** A stored mark without the tool's own bookkeeping (id, editing flags). */
export function rawMark(it) {
    if (!it || typeof it !== "object") return null;
    const out = { type: it.type, color: it.color || "" };
    for (const k of ["f", "fe", "x", "y", "size", "text", "width"]) if (it[k] !== undefined) out[k] = it[k];
    if (it.a) out.a = pt(it.a);
    if (it.b) out.b = pt(it.b);
    if (Array.isArray(it.pts)) out.pts = it.pts.map(pt);
    return out;
}

/** A tab as the tab list names it. */
function tabEntry(t) {
    const out = { key: String(t.key || "") };
    put(out, "label", t.label || "");
    if (Number.isInteger(t.frames)) out.frames = t.frames;
    if (Number.isInteger(t.history) && t.history > 0) out.history = t.history;
    return out;
}

/**
 * The whole answer, from the snapshot the panel gathers (bEpicViewer_agentState.js).
 * Every part is optional; what is not known is left out rather than guessed, so
 * the answer stays small.
 */
export function describeViewerState(s) {
    const snap = s || {};
    const out = { source: "viewer", open: !!snap.open, visible: !!snap.visible };
    out.display = snap.display || (snap.open ? "floating" : "closed");
    if (!snap.open) return out;
    put(out, "dock_side", snap.dockSide || "");
    if (snap.tab && snap.tab.key) {
        out.tab = { key: String(snap.tab.key) };
        put(out.tab, "label", snap.tab.label || "");
        put(out.tab, "mode", snap.tab.mode || "");
    }
    const tabs = Array.isArray(snap.tabs) ? snap.tabs : [];
    out.tabs = tabs.slice(0, TABS_CAP).map(tabEntry);
    if (tabs.length > TABS_CAP) out.tabs_total = tabs.length;

    if (snap.item) {
        const it = describeFrame(snap.item.frame, { index: snap.item.index });
        if (it) {
            if (Number.isInteger(snap.item.of) && snap.item.of > 1) it.of = snap.item.of;
            if (Number.isInteger(snap.item.historyIndex)) it.history_index = snap.item.historyIndex;
            put(it, "agent_tag", snap.item.agentTag || "");
            put(it, "color_tag", snap.item.colorTag || "");
            out.item = it;
        }
    }

    const t = snap.timeline;
    if (t && (t.frames > 1 || t.video)) {
        const tl = { frames: Math.round(t.frames || 0), current: Math.round(t.current || 0) };
        if (t.fps > 0) {
            tl.fps = r3(t.fps);
            tl.time = r3(tl.current / t.fps);
            tl.timecode = timecode(tl.current, t.fps);
        }
        if (t.range && finite(t.range.start) && finite(t.range.end)) {
            const a = Math.round(Math.min(t.range.start, t.range.end));
            const b = Math.round(Math.max(t.range.start, t.range.end));
            tl.range = { start: a, end: b, frames: b - a + 1 };
            if (t.fps > 0) { tl.range.start_tc = timecode(a, t.fps); tl.range.end_tc = timecode(b, t.fps); }
            if (t.rangeLocked) tl.range.locked = true;
        }
        put(tl, "loop", t.loop || "");
        tl.playing = !!t.playing;
        out.timeline = tl;
    }

    if (snap.edit && snap.edit.open) {
        const e = { open: true };
        put(e, "tab", snap.edit.tab || "");
        put(e, "cut", snap.edit.cut || "");
        if (Number.isInteger(snap.edit.clips)) e.clips = snap.edit.clips;
        if (snap.edit.fps > 0) e.fps = r3(snap.edit.fps);
        if (snap.edit.selected) {
            const sel = { kind: snap.edit.selected.kind };
            if (Number.isInteger(snap.edit.selected.index)) sel.index = snap.edit.selected.index;
            put(sel, "track", snap.edit.selected.track || "");
            put(sel, "name", snap.edit.selected.name || "");
            put(sel, "file", snap.edit.selected.file || "");
            if (finite(snap.edit.selected.in)) sel.in = r3(snap.edit.selected.in);
            if (finite(snap.edit.selected.length)) sel.length = r3(snap.edit.selected.length);
            put(sel, "text", snap.edit.selected.text ? String(snap.edit.selected.text).slice(0, TEXT_CAP) : "");
            e.selected = sel;
        }
        out.edit = e;
    }

    if (snap.compare) {
        const c = { mode: snap.compare.mode || "tab" };
        const a = describeFrame(snap.compare.a && snap.compare.a.frame,
                                snap.compare.a && Number.isInteger(snap.compare.a.index) ? { index: snap.compare.a.index } : null);
        const b = describeFrame(snap.compare.b && snap.compare.b.frame,
                                snap.compare.b && Number.isInteger(snap.compare.b.index) ? { index: snap.compare.b.index } : null);
        if (a) c.a = a;
        if (b) c.b = b;
        put(c, "tab_b", snap.compare.tabB || "");
        // A multi-item compare: the count, and for the Contact Sheet grid the
        // strip indices it shows (capped, so the answer stays small).
        if (Number.isInteger(snap.compare.items) && snap.compare.items > 1) c.items = snap.compare.items;
        if (Number.isInteger(snap.compare.shown)) c.shown = snap.compare.shown;
        if (Array.isArray(snap.compare.indices)) c.indices = snap.compare.indices.filter(Number.isInteger).slice(0, 16);
        if (Array.isArray(snap.compare.grid)) c.grid = snap.compare.grid.slice(0, 2);
        if (snap.compare.wipe) {
            c.wipe = {};
            put(c.wipe, "mode", snap.compare.wipe.mode || "");
            if (finite(snap.compare.wipe.position)) c.wipe.position = r3(snap.compare.wipe.position / 100);
        }
        out.compare = c;
    }

    if (snap.view) {
        const v = {};
        if (finite(snap.view.zoom)) v.zoom = r3(snap.view.zoom);
        if (finite(snap.view.panX) && finite(snap.view.panY) && (snap.view.panX || snap.view.panY)) {
            v.pan = [Math.round(snap.view.panX), Math.round(snap.view.panY)];
        }
        put(v, "channel", snap.view.channel || "");
        if (finite(snap.view.exposure)) v.exposure = r3(snap.view.exposure);
        out.view = v;
    }

    if (snap.camera) {
        const c = {};
        put(c, "name", snap.camera.name || "");
        if (finite(snap.camera.fov)) c.fov = r3(snap.camera.fov);
        if (finite(snap.camera.aspect)) c.aspect = r3(snap.camera.aspect);
        if (Array.isArray(snap.camera.position)) c.position = snap.camera.position.map(r4);
        if (Array.isArray(snap.camera.cameraWorld) && snap.camera.cameraWorld.length === 16) {
            c.camera_world = snap.camera.cameraWorld.map(r4);
        }
        if (Object.keys(c).length) out.camera = c;
    }

    const an = snap.annotations;
    if (an && an.count > 0) {
        out.annotations = { count: an.count };
        if (Number.isInteger(an.ranges) && an.ranges > 0) out.annotations.ranges = an.ranges;
        if (Number.isInteger(an.onFrame)) out.annotations.on_frame = an.onFrame;
    }
    return out;
}
