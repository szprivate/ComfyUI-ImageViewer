// imageViewer_clipVfxData.js
// The arithmetic of the History's VFX actions on a clip (imageViewer_clipVfx.js): which frames are films, how
// one is named to the server, what group the result goes into, how far a run is. Pure, tested under node
// (tests/test_clip_vfx.mjs).

export const CLIP_EXTS = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];

export const ACTION_ORDER = ["alpha", "hdr", "reframe", "upscale"];
export const ACTION_ICONS = { alpha: "◐", hdr: "☀", reframe: "⬚", upscale: "↗" };

function nameOf(fr) {
    return String((fr && (fr.path || fr.filename)) || "");
}

/** Whether a History frame is a film the actions can take. */
export function isClip(fr) {
    if (!fr || typeof fr !== "object") return false;
    const m = /\.([A-Za-z0-9]+)$/.exec(nameOf(fr).split("?")[0]);
    return !!m && CLIP_EXTS.includes(m[1].toLowerCase());
}

/** The frame as the route takes it: {path} or ComfyUI's {filename, type, subfolder}. */
export function clipRef(fr) {
    if (!fr) return null;
    if (fr.path) return { path: String(fr.path) };
    if (fr.filename) return { filename: String(fr.filename), type: fr.type || "output", subfolder: fr.subfolder || "" };
    return null;
}

/** The file's name without its folder and extension. */
export function clipStem(fr) {
    const base = nameOf(fr).split(/[\\/]/).pop() || "clip";
    return base.replace(/\.[^.]+$/, "") || "clip";
}

/** The group a result goes into: the source's own, so the two lie side by side; an ungrouped source gets
 *  one named after it, "VFX: <name>". */
export function resultGroup(sourceGroup, fr) {
    const g = String(sourceGroup || "").trim();
    return g || `VFX: ${clipStem(fr)}`;
}

/** The label of a result's first frame: "<name> · Alpha matte". */
export function resultLabel(fr, actionLabel) {
    return `${clipStem(fr)} · ${actionLabel}`;
}

/** The reframe preset that matches w x h, else "custom". */
export function presetOf(presets, w, h) {
    const p = (presets || []).find((x) => x.width === w && x.height === h);
    return p ? p.label : "custom";
}

/** A side as the reframe workflow takes it: a multiple of 64 within 256..1920. */
export function snapSide(v) {
    const n = Math.round((Number(v) || 0) / 64) * 64;
    return Math.max(256, Math.min(1920, n));
}

/** How far all runs are, 0..1, or null while nothing says (waiting in the queue, a node with no steps). */
export function share(runs) {
    if (!runs.length) return null;
    let sum = 0, known = false;
    for (const r of runs) {
        if (r.done) { sum += 1; known = true; } else if (r.max) { sum += Math.min(1, r.value / r.max); known = true; }
    }
    return known ? sum / runs.length : null;
}
