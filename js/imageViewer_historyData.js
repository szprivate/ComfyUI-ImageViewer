// imageViewer_historyData.js
// The one History of the viewer, as data: which tab a snapshot came from, its
// group, the order the strip shows it in, and the old per-tab histories merged
// into one.
//
// The viewer once kept a history per tab (`history[tabKey]`). There is ONE now,
// `history[HISTORY_KEY]`, newest first, for every tab; groups and labels sort it.
// A snapshot remembers the tab it was made in (`fromTab` on its first frame), so
// a click can show it there, and its group is the `group` its frames carry -
// what ImageViewerSend stamped, or what the user moved it to later.
//
// No imports, so node --test can load it (tests/test_history_data.mjs).

/** The key of the one history in `panel.history`. */
export const HISTORY_KEY = "all";

/** The tab a snapshot was made in ("" when nobody knows: an old orphan). */
export function snapshotTab(snapshot) {
    const fr = Array.isArray(snapshot) ? snapshot[0] : null;
    return fr && typeof fr.fromTab === "string" ? fr.fromTab : "";
}

/** A copy of `snapshot` that says it was made in tab `tab`. */
export function stampSnapshot(snapshot, tab) {
    const copy = JSON.parse(JSON.stringify(Array.isArray(snapshot) ? snapshot : [snapshot]));
    if (copy[0] && typeof copy[0] === "object" && tab) copy[0].fromTab = String(tab);
    return copy;
}

/** The graph node a snapshot came from (`fromNode` on its first frame), or null. */
export function snapshotNode(snapshot) {
    const fr = Array.isArray(snapshot) ? snapshot[0] : null;
    return fr && fr.fromNode != null && fr.fromNode !== "" ? String(fr.fromNode) : null;
}

/** The group a snapshot is in ("" for none). */
export function snapshotGroup(snapshot) {
    const fr = Array.isArray(snapshot) ? snapshot[0] : null;
    return String((fr && fr.group) || "").trim();
}

/** Put a snapshot into `group` ("" or null takes it out of every group):
 *  every frame of it, as ImageViewerSend stamps them. */
export function setSnapshotGroup(snapshot, group) {
    const g = String(group || "").trim();
    for (const fr of Array.isArray(snapshot) ? snapshot : []) {
        if (!fr || typeof fr !== "object") continue;
        if (g) fr.group = g;
        else delete fr.group;
    }
}

/** The groups the stack holds, the most recently used first. */
export function historyGroups(stack) {
    const out = [];
    for (const s of stack || []) {
        const g = snapshotGroup(s);
        if (g && !out.includes(g)) out.push(g);
    }
    return out;
}

/** The newest snapshot made in tab `tab`: what that tab shows when it is not
 *  looking at an older one. -1 when it has none. */
export function liveIndexOf(stack, tab) {
    if (!tab) return -1;
    return (stack || []).findIndex((s) => snapshotTab(s) === tab);
}

/**
 * The strip, in the order it is drawn: one section per group, the group used
 * most recently first, newest first inside each - so the newest render is
 * always at the top. Ungrouped snapshots are a section of their own (group "").
 * `visible(snapshot)` is the filter; a section `collapsed` (a Set of group
 * names) lists no indices but is still there, so its heading can open it.
 * -> [{ group, indices: [stackIndex...], count }]
 */
export function historySections(stack, visible = null, collapsed = null) {
    const sections = new Map();
    (stack || []).forEach((s, i) => {
        if (visible && !visible(s)) return;
        const g = snapshotGroup(s);
        if (!sections.has(g)) sections.set(g, { group: g, indices: [], count: 0 });
        const sec = sections.get(g);
        sec.count++;
        if (!(collapsed && collapsed.has(g))) sec.indices.push(i);
    });
    return [...sections.values()];
}

/** The stack indices as the strip shows them, top to bottom. */
export function historyDisplayOrder(stack, visible = null, collapsed = null) {
    return historySections(stack, visible, collapsed).flatMap((s) => s.indices);
}

/**
 * The per-tab histories of an older viewer, merged into one (newest first).
 * Their snapshots carry no time, so they are taken in turns - every tab's
 * newest, then every tab's second, ... - in tab order (`order`, then whatever
 * else there is), which keeps each tab's newest work at the top of the strip.
 * Each snapshot is stamped with the tab it came from. Repeats of one snapshot
 * in one tab collapse; `limit` keeps the newest that many.
 * -> the merged stack (a new array; `history` is not changed).
 */
export function mergeTabHistories(history, order = [], limit = Infinity) {
    const src = history && typeof history === "object" ? history : {};
    const keys = [...(order || []).filter((k) => k !== HISTORY_KEY && Array.isArray(src[k])),
                  ...Object.keys(src).filter((k) => k !== HISTORY_KEY && Array.isArray(src[k]) && !(order || []).includes(k))];
    const out = [];
    // A unified history already there (a half-done merge) stays in front.
    for (const s of Array.isArray(src[HISTORY_KEY]) ? src[HISTORY_KEY] : []) {
        if (Array.isArray(s) && s.length) out.push(JSON.parse(JSON.stringify(s)));
    }
    const stacks = keys.map((k) => ({ k, stack: src[k].filter((s) => Array.isArray(s) && s.length > 0), seen: new Set() }));
    const longest = Math.max(0, ...stacks.map((t) => t.stack.length));
    for (let i = 0; i < longest; i++) {
        for (const t of stacks) {
            const s = t.stack[i];
            if (!s) continue;
            const sig = JSON.stringify(s);
            if (t.seen.has(sig)) continue;
            t.seen.add(sig);
            const stamped = stampSnapshot(s, snapshotTab(s) || t.k);
            out.push(stamped);
        }
    }
    const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : out.length;
    return out.slice(0, cap);
}

/**
 * The tabs that only showed media - a loader node sent to the viewer
 * (`loader_<id>`), files opened from the browser (`folder_<time>_<n>`), files
 * dropped in (`dropped_...`), the exports (`folder_exports`) - which are all
 * the one Viewer tab now. Documents (cuts, Paint, 3D, Motion, code), the live
 * tabs of Send to Viewer nodes and agentY's named tabs keep their own.
 */
export function isMediaTabKey(key) {
    const k = String(key || "");
    return /^loader_/.test(k) || /^dropped_/.test(k) || /^folder_\d+_\d+$/.test(k) || k === "folder_exports";
}

/**
 * The tabs that showed what a node or the agent sent - a Send to Viewer node
 * (`send_<id>`, `send_label_<name>`) and agentY's named tabs (`named:<name>`) -
 * which are groups of the one Viewer tab now, and so are the Roto / SAM3
 * nodes' tabs (same `send_` keys). A `send_` key is only known for one when
 * `isSendNode(key)` says so (asked of the graph: a 3D Scene node's tab keeps
 * its tab; without a graph only `named:` tabs are known).
 */
export function isFeedTabKey(key, isSendNode = null) {
    const k = String(key || "");
    if (/^named:/.test(k)) return true;
    return /^send_/.test(k) && !!(isSendNode && isSendNode(k));
}

/** A tab's label as a group name: without the icon in front of it. */
export function groupFromLabel(label) {
    return String(label || "").replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 60);
}

/** The stack with every snapshot made in one of `tabs` re-stamped as made in
 *  `viewer` (a new array; `stack` is not changed). `groups` ({tab: name}): a
 *  snapshot of that tab in no group yet goes into that group - so what a
 *  tab held stays together, under its old name. */
export function foldIntoTab(stack, tabs, viewer, groups = null) {
    const from = new Set(tabs || []);
    return (stack || []).map((s) => {
        const tab = snapshotTab(s);
        if (!from.has(tab)) return s;
        const out = stampSnapshot(s, viewer);
        const g = groups && groups[tab] ? String(groups[tab]).trim() : "";
        if (g && !snapshotGroup(out)) setSnapshotGroup(out, g);
        // A node's own tab ("send_<id>") names the node the snapshot came from.
        const m = /^send_(\d+)$/.exec(tab);
        if (m && out[0] && typeof out[0] === "object" && out[0].fromNode == null) out[0].fromNode = m[1];
        return out;
    });
}

// ── The saved form of a snapshot ─────────────────────────────────────────────
//
// A sequence is a snapshot of many frames that differ only in a few characters
// (frame_1001.png, frame_1002.png ...), and the saved state (localStorage, which
// ComfyUI's page shares, about 5 MB in all) held every frame in full: 500
// snapshots with a few 81-frame sequences among them were over 2 MB, written out
// on every change. Saved, a snapshot of several frames is ONE frame - its first,
// as it is - carrying the others as differences from the frame before
// (`_imageViewerSeq`): a string by what changed between a shared start and end
// ([start, middle, end]), any other value whole ([value]), a key gone as [].
// An older viewer reading it sees the first frame. A snapshot of one frame is
// saved as it is.

const SEQ_KEY = "_imageViewerSeq";
const OLD_SEQ_KEY = "_bepicSeq";        // saved while the viewer was called "bEpic"

function stringDelta(a, b) {
    let p = 0;
    const n = Math.min(a.length, b.length);
    while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    let s = 0;
    while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return [p, b.slice(p, b.length - s), s];
}

const plainFrame = (fr) => !!fr && typeof fr === "object" && !Array.isArray(fr);

/** The saved form of a snapshot (see above). Not a sequence: itself. */
export function packSnapshot(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length < 2 || !snapshot.every(plainFrame)) return snapshot;
    if (Object.prototype.hasOwnProperty.call(snapshot[0], SEQ_KEY)
        || Object.prototype.hasOwnProperty.call(snapshot[0], OLD_SEQ_KEY)) return snapshot;
    const diffs = [];
    for (let i = 1; i < snapshot.length; i++) {
        const prev = snapshot[i - 1], fr = snapshot[i], d = {};
        for (const k of Object.keys(fr)) {
            const a = prev[k], b = fr[k];
            if (a === b && (a !== undefined || Object.prototype.hasOwnProperty.call(prev, k))) continue;
            if (a && b && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b)) continue;
            d[k] = typeof a === "string" && typeof b === "string" ? stringDelta(a, b) : [b];
        }
        for (const k of Object.keys(prev)) if (!Object.prototype.hasOwnProperty.call(fr, k)) d[k] = [];
        diffs.push(d);
    }
    return [{ ...snapshot[0], [SEQ_KEY]: diffs }];
}

/** A snapshot back from its saved form; anything else as it is. */
export function unpackSnapshot(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length !== 1 || !plainFrame(snapshot[0])) return snapshot;
    const key = Array.isArray(snapshot[0][SEQ_KEY]) ? SEQ_KEY : OLD_SEQ_KEY;
    const diffs = snapshot[0][key];
    if (!Array.isArray(diffs)) return snapshot;
    const first = { ...snapshot[0] };
    delete first[key];
    const out = [first];
    for (const d of diffs) {
        const prev = out[out.length - 1];
        const fr = { ...prev };
        for (const [k, v] of Object.entries(d && typeof d === "object" ? d : {})) {
            if (!Array.isArray(v) || v.length === 0) delete fr[k];
            else if (v.length === 1) fr[k] = v[0];
            else {
                const a = typeof prev[k] === "string" ? prev[k] : "";
                const [p, mid, s] = v;
                fr[k] = a.slice(0, p) + String(mid) + (s > 0 ? a.slice(a.length - s) : "");
            }
        }
        out.push(fr);
    }
    return out;
}
