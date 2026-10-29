// bEpicViewer_historySelection.js
// What the user has picked in the history strip, as agentY reads it.
//
// agentY (agentY-comfyuiConnect) asks the page through
// window.bEpicViewerApi.historySelection(), with each chat message and when the
// agent calls get_history_selection mid-turn. The answer is plain data: the
// snapshots' files and what the viewer knows about them, nothing to draw.
//
// A pick is something the user DID, never what the viewer did on its own:
//   multi    - two or more thumbnails Ctrl/Ctrl+Shift-selected
//   compare  - two snapshots pinned against each other (Shift+click)
//   open     - one older snapshot clicked open (or stepped to with the arrows)
// The newest render landing in the strip highlights itself too, but nobody
// chose it, so a strip nobody touched reports nothing. Nor does a closed viewer:
// what cannot be seen is not "the one I have selected".
//
// No imports, so node --test can load it (tests/test_history_selection.mjs).

/** Most items one answer lists; the count says how many there were. */
export const HISTORY_SELECTION_CAP = 50;
/** Most frame paths listed for one snapshot (a batch, a sequence). */
export const FRAME_PATHS_CAP = 16;

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|gif)$/i;
const MODEL_EXT = /\.(glb|gltf|obj|fbx|ply|spz|splat|usd|usda|usdc|usdz|stl)$/i;

function fileName(fr) {
    return String((fr && (fr.filename || fr.name || fr.path)) || "");
}

/** "image" | "video" | "model": the frame's own word when it has one. */
export function frameKind(fr) {
    if (!fr) return "image";
    const k = String(fr.kind || "").toLowerCase();
    if (k === "video" || k === "model" || k === "image") return k;
    const name = fileName(fr);
    if (MODEL_EXT.test(name)) return "model";
    if (VIDEO_EXT.test(name) || String(fr.format || "").startsWith("video/")) return "video";
    return "image";
}

/** One snapshot as the agent reads it. `agentTags` maps a path to its #name. */
export function snapshotItem(snapshot, index, agentTags) {
    const frames = (Array.isArray(snapshot) ? snapshot : [snapshot]).filter((f) => f && typeof f === "object");
    const fr = frames[0];
    if (!fr) return null;
    const item = { index, kind: frameKind(fr) };
    const put = (k, v) => { if (v !== undefined && v !== null && v !== "") item[k] = v; };
    put("path", typeof fr.path === "string" ? fr.path : "");
    put("filename", fr.filename || fr.name || "");
    put("subfolder", fr.subfolder || "");
    put("type", fr.type || "");
    put("format", fr.format || "");
    put("label", fr.label || "");
    put("group", fr.group || "");
    put("prompt_id", fr.prompt_id || "");
    const tag = item.path && agentTags ? agentTags[item.path] : "";
    put("agent_tag", tag || "");
    if (frames.length > 1) {
        item.frames = frames.length;
        const paths = frames.map((f) => (typeof f.path === "string" ? f.path : "")).filter(Boolean);
        if (paths.length > 1) item.frame_paths = paths.slice(0, FRAME_PATHS_CAP);
    }
    return item;
}

/**
 * Which snapshots count as picked, and how.
 * `state`: { multi: [idx...], viewing: bool, viewingKey, viewingIndex,
 *            compare: { key, baseIdx, otherIdx } | null, key }
 */
export function pickedIndices(state) {
    const s = state || {};
    const multi = Array.isArray(s.multi) ? s.multi.filter(Number.isInteger) : [];
    if (multi.length > 1) return { mode: "multi", indices: multi };
    const c = s.compare;
    if (c && c.key === s.key && Number.isInteger(c.baseIdx) && Number.isInteger(c.otherIdx)) {
        return { mode: "compare", indices: [c.baseIdx, c.otherIdx] };
    }
    if (s.viewing && s.viewingKey === s.key && Number.isInteger(s.viewingIndex)) {
        return { mode: "open", indices: [s.viewingIndex] };
    }
    return { mode: "", indices: [] };
}

/** The whole answer: `{ source, tab, tab_label, mode, count, items, truncated? }`. */
export function describeHistorySelection({ stack, state, tab, tabLabel, agentTags, cap = HISTORY_SELECTION_CAP }) {
    const out = { source: "viewer", tab: String(tab || ""), tab_label: String(tabLabel || ""), mode: "", count: 0, items: [] };
    const { mode, indices } = pickedIndices(state);
    const items = [];
    for (const i of indices) {
        const it = snapshotItem((stack || [])[i], i, agentTags);
        if (it) items.push(it);
    }
    if (!items.length) return out;
    out.mode = mode;
    out.count = items.length;
    out.items = items.slice(0, Math.max(1, cap));
    if (items.length > out.items.length) out.truncated = true;
    return out;
}
