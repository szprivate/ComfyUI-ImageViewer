// bEpicViewer_historyAgentTags.js
// agentY's tags as entries of the history filter.
//
// The viewer has no tag source of its own. agentY (agentY-comfyuiConnect) puts
// window.agentYViewerBridge.tags() on the page: the SAME list the `#` menu of an
// `agentY hook` prompt offers - the `agentY add tag` nodes on the canvas plus the
// references remembered for the project (/agent/pm_names) - as
// [{ tag, path, role, source }]. This file turns that list, and the tags the user
// gave pictures from this viewer (a path -> name map), into an index: which names
// exist, and which path wears which.
//
// A filter value for one is "agent:<name>". No imports, so node --test can load it
// (tests/test_history_agent_tags.mjs).

export const AGENT_FILTER_PREFIX = "agent:";

/** The filter value for a tag name. */
export function agentFilterValue(name) { return AGENT_FILTER_PREFIX + String(name || ""); }

/** The tag name behind a filter value, or "" when it is not an agentY one. */
export function agentFilterName(value) {
    const v = String(value || "");
    return v.startsWith(AGENT_FILTER_PREFIX) ? v.slice(AGENT_FILTER_PREFIX.length) : "";
}

/** A file in the one spelling both sides compare: forward slashes, a drive letter
 *  in lower case, ComfyUI's " [output]" suffix dropped. */
export function normPath(p) {
    let s = String(p || "").trim().replace(/\s*\[(output|input|temp)\]\s*$/i, "").replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1);
    return s;
}

/**
 * The index of a tag list. `list`: [{ tag, path }]; `viewerTags`: { path: name }.
 * -> { names: sorted unique, byPath: Map(normPath -> [names]), relative: [[path, name]] }
 * `relative` holds the tags whose path is not absolute (a canvas loader's
 * "sub/name.png"), which only a frame known by filename can match.
 */
export function buildAgentTagIndex(list, viewerTags) {
    const names = new Set();
    const byPath = new Map();
    const relative = [];
    const add = (name, path) => {
        const n = String(name || "").trim().replace(/^#+/, "");
        if (!n) return;
        names.add(n);
        const p = normPath(path);
        if (!p) return;
        if (/^([a-z]:)?\//.test(p)) {
            const a = byPath.get(p) || [];
            if (!a.includes(n)) a.push(n);
            byPath.set(p, a);
        } else relative.push([p, n]);
    };
    for (const e of Array.isArray(list) ? list : []) if (e) add(e.tag, e.path);
    for (const [path, name] of Object.entries(viewerTags || {})) add(name, path);
    return { names: [...names].sort((a, b) => a.localeCompare(b)), byPath, relative };
}

/** The tag names a snapshot's frames wear. */
export function agentTagsOfSnapshot(index, snapshot) {
    if (!index) return [];
    const out = [];
    const put = (n) => { if (!out.includes(n)) out.push(n); };
    for (const fr of Array.isArray(snapshot) ? snapshot : [snapshot]) {
        if (!fr || typeof fr !== "object") continue;
        const p = typeof fr.path === "string" && fr.path ? normPath(fr.path) : "";
        if (p) (index.byPath.get(p) || []).forEach(put);
        const file = fr.filename || fr.name || "";
        if (file && index.relative.length) {
            const key = normPath((fr.subfolder ? fr.subfolder + "/" : "") + file);
            for (const [rp, n] of index.relative) {
                if (rp === key || key.endsWith("/" + rp) || (!fr.subfolder && rp.endsWith("/" + key))) put(n);
            }
        }
    }
    return out;
}

/** A short text that changes when the index does (the strip's repaint signature). */
export function agentTagIndexSig(index) {
    if (!index) return "";
    const paths = [...index.byPath.entries()].map(([p, a]) => `${p}=${a.join("+")}`).sort().join(";");
    return `${index.names.join(",")}|${paths}|${index.relative.map((r) => r.join("=")).sort().join(";")}`;
}
