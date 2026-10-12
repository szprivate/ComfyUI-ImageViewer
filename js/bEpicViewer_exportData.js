// bEpicViewer_exportData.js
// The parts of exporting that need no page (bEpicViewer_exportUI.js is the page
// side): reading which sequence and shot a graph names, and what a format menu
// offers. Plain functions, so they run under node.

const _pick = (d) => (d && typeof d === "object" ? (d.folderPath || d.folder_path || "") : "");

/** The folder path in a parsed AYON context, in either shape seen in the wild. */
export function ayonFolderPath(ctx) {
    if (!ctx || typeof ctx !== "object") return "";
    const inst = Array.isArray(ctx.instances) ? ctx.instances.filter((i) => _pick(i)) : [];
    const active = inst.find((i) => i.active);
    if (active) return _pick(active);
    if (inst.length) return _pick(inst[0]);
    return _pick(ctx) || _pick(ctx.context);
}

/** '/03_sequences/spec/spec_0210' -> { sequence: 'spec', shot: 'spec_0210' }. */
export function splitFolderPath(path) {
    const segs = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
    if (segs.length >= 2) return { sequence: segs[segs.length - 2], shot: segs[segs.length - 1] };
    if (segs.length === 1) return { sequence: "", shot: segs[0] };
    return null;
}

/**
 * The sequence and shot a list of nodes names, or null: an AYON context node (it
 * wins), else a bEpic Set Path node. `nodes` is `[{ type, widgets: {name: value} }]`.
 */
export function contextFromNodes(nodes) {
    let fallback = null;
    for (const n of nodes || []) {
        const type = String(n.type || "").toLowerCase();
        for (const value of Object.values(n.widgets || {})) {
            if (typeof value !== "string" || value.indexOf("{") < 0) continue;
            let parsed = null;
            try { parsed = JSON.parse(value); } catch (_) { continue; }
            const found = splitFolderPath(ayonFolderPath(parsed));
            if (!found || !found.shot) continue;
            if (type.includes("ayon") || type.includes("context")) return { ...found, source: "AYON context" };
            fallback = fallback || { ...found, source: "AYON context" };
        }
    }
    if (fallback) return fallback;
    for (const n of nodes || []) {
        if (String(n.type || "") !== "bepicSetPath") continue;
        const shot = String((n.widgets || {}).ShotName || "").trim();
        if (shot) return { sequence: String((n.widgets || {}).SequenceName || "").trim(), shot, source: "Set Path" };
    }
    return null;
}

export const FALLBACK_OPTIONS = {
    video: [
        { format: "mp4", label: "MP4", codecs: [{ codec: "h264", label: "H.264" }], default_codec: "h264" },
        { format: "mov", label: "MOV", codecs: [{ codec: "prores", label: "ProRes 422" }, { codec: "h264", label: "H.264" }], default_codec: "prores" },
        { format: "webm", label: "WebM", codecs: [{ codec: "vp9", label: "VP9" }], default_codec: "vp9" },
    ],
    qualities: ["high", "medium", "low"],
};

/** The video formats a feature offers, in its order, with their codecs. */
export function videoChoices(options, formats) {
    const table = (options && options.video) || FALLBACK_OPTIONS.video;
    const wanted = formats && formats.length ? formats : table.map((f) => f.format);
    return wanted.map((f) => table.find((t) => t.format === f)).filter(Boolean);
}

/** The codec a format ends up with: the one asked for when it can hold it, else its default. */
export function codecFor(choice, asked) {
    if (!choice) return "";
    return choice.codecs.some((c) => c.codec === asked) ? asked : choice.default_codec;
}

/** A name as it will appear in the file name (the server's own cleaning, mirrored for the preview). */
export function cleanName(text, fallback = "export") {
    const s = String(text || "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return s.slice(0, 80) || fallback;
}
