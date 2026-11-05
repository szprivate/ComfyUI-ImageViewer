// bEpicViewer_recentDocs.js
// The last files each kind of document was opened from or saved to (Paint, Motion),
// newest first, kept in the browser's localStorage. "Open Paint…" / "Open Motion…"
// in the bar's menus take the newest of them up again when no tab of that kind is
// open (bEpicViewer_barGroups.js). Cuts keep their own list (bEpicViewer_editRecent.js).
//
// The list arithmetic is pure, for node --test (tests/test_recent_docs.mjs).

export const RECENT_DOCS_MAX = 10;
const KEY = (kind) => `bepic.${kind}.recent`;
const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();

/** `list` with `path` first, no twin of it, at most RECENT_DOCS_MAX long. */
export function recentDocsWith(list, path) {
    const p = String(path || "").trim();
    const rest = (Array.isArray(list) ? list : []).filter((x) => typeof x === "string" && x && norm(x) !== norm(p));
    return (p ? [p, ...rest] : rest).slice(0, RECENT_DOCS_MAX);
}

/** The recent files of `kind` ("paint", "motion"), newest first ([] with no storage). */
export function recentDocs(kind) {
    try {
        const raw = JSON.parse(window.localStorage.getItem(KEY(kind)) || "[]");
        return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x).slice(0, RECENT_DOCS_MAX) : [];
    } catch (_) { return []; }
}

/** Put `path` on top of `kind`'s list. */
export function addRecentDoc(kind, path) {
    if (!path) return;
    try { window.localStorage.setItem(KEY(kind), JSON.stringify(recentDocsWith(recentDocs(kind), path))); } catch (_) { /* no storage: no list */ }
}
