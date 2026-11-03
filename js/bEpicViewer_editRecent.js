// The list behind Open recent (bEpicViewer_editOpen.js): pure, so node can test it.
export const RECENT_KEY = "bepic.edit.recent";
export const RECENT_MAX = 10;

export const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
/** `list` with `path` first, no twin of it, at most RECENT_MAX long (pure, for the tests). */
export function recentWith(list, path) {
    const p = String(path || "");
    if (!/\.otio$/i.test(p)) return Array.isArray(list) ? list.slice(0, RECENT_MAX) : [];
    const rest = (Array.isArray(list) ? list : []).filter((x) => typeof x === "string" && norm(x) !== norm(p));
    return [p, ...rest].slice(0, RECENT_MAX);
}

