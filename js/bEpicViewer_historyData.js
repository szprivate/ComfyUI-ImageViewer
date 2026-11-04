// bEpicViewer_historyData.js
// The one History of the viewer, as data: which tab a snapshot came from, its
// group, the order the strip shows it in, and the old per-tab histories merged
// into one.
//
// The viewer once kept a history per tab (`history[tabKey]`). There is ONE now,
// `history[HISTORY_KEY]`, newest first, for every tab; groups and labels sort it.
// A snapshot remembers the tab it was made in (`fromTab` on its first frame), so
// a click can show it there, and its group is the `group` its frames carry -
// what bEpicSendToViewer stamped, or what the user moved it to later.
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

/** The group a snapshot is in ("" for none). */
export function snapshotGroup(snapshot) {
    const fr = Array.isArray(snapshot) ? snapshot[0] : null;
    return String((fr && fr.group) || "").trim();
}

/** Put a snapshot into `group` ("" or null takes it out of every group):
 *  every frame of it, as bEpicSendToViewer stamps them. */
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
