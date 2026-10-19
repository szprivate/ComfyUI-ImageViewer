// bEpicViewer_annotateReport.js
// What the Annotation tool says about its marks, as words. Pure functions, no DOM:
// the same marks that are drawn into the picture the agent is sent are also
// written out here - the text with its position, the arrows and boxes with
// where they point - so the agent does not have to read pixels to know what a
// note says. The viewer sends both (bEpicViewer_annotateVideo.js).

/** Line height of a text mark, as a multiple of its size. */
export const LINE_H = 1.2;

/** The lines of a text mark. */
export function textLines(text) {
    return String(text || "").split(/\r?\n/);
}

/** hh:mm:ss.ff - the frame within the second, as film people read it. */
export function timecode(frame, fps) {
    const rate = fps > 0 ? fps : 24;
    const n = Math.max(0, Math.round(frame));
    const whole = Math.max(1, Math.round(rate));
    const secs = Math.floor(n / whole), fr = n % whole;
    const p = (v) => String(v).padStart(2, "0");
    return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}.${p(fr)}`;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const px = (v, n) => Math.round(v * n);

/** Where on the picture, in words: "top left", "centre", "bottom right"... */
export function whereIs(x, y) {
    const col = x < 1 / 3 ? "left" : x > 2 / 3 ? "right" : "";
    const row = y < 1 / 3 ? "top" : y > 2 / 3 ? "bottom" : "";
    return [row, col].filter(Boolean).join(" ") || "centre";
}

/** One mark as a line of text. w / h are the picture's size in pixels. */
export function describeItem(it, w, h) {
    if (!it) return "";
    if (it.type === "text") {
        return `text at ${pct(it.x)},${pct(it.y)} (${px(it.x, w)},${px(it.y, h)} px, ${whereIs(it.x, it.y)}): `
            + JSON.stringify(String(it.text || ""));
    }
    if (it.type === "arrow") {
        return `arrow from ${pct(it.a.x)},${pct(it.a.y)} (${whereIs(it.a.x, it.a.y)}) `
            + `to ${pct(it.b.x)},${pct(it.b.y)} (${whereIs(it.b.x, it.b.y)})`;
    }
    if (it.type === "rect") {
        const x1 = Math.min(it.a.x, it.b.x), x2 = Math.max(it.a.x, it.b.x);
        const y1 = Math.min(it.a.y, it.b.y), y2 = Math.max(it.a.y, it.b.y);
        return `box from ${pct(x1)},${pct(y1)} to ${pct(x2)},${pct(y2)} `
            + `(${whereIs((x1 + x2) / 2, (y1 + y2) / 2)})`;
    }
    if (it.type === "pen" && it.pts && it.pts.length) {
        const xs = it.pts.map((p) => p.x), ys = it.pts.map((p) => p.y);
        const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
        return `freehand mark around ${pct(x1)},${pct(y1)} to ${pct(x2)},${pct(y2)} `
            + `(${whereIs((x1 + x2) / 2, (y1 + y2) / 2)})`;
    }
    return "";
}

/** The marks of one annotation, most readable first: the words, then the shapes. */
export function describeItems(items, w, h) {
    const order = { text: 0, arrow: 1, rect: 1, pen: 2 };
    return [...items].sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3))
        .map((it) => describeItem(it, w, h)).filter(Boolean);
}

/**
 * The message the agent is sent.
 *   kind     "image" | "video"
 *   source   the file the marks are about (path), or ""
 *   w, h     the picture's size in pixels
 *   fps      the video's rate (video only)
 *   frames   the video's length in frames (video only)
 *   groups   [{ frame, end, items, image }]   image = path of the flattened picture
 *   halted   a review stop is waiting: this is the answer "change this"
 */
export function buildFeedback({ kind, source, w, h, fps, frames, groups, halted }) {
    const out = [];
    const n = groups.length;
    out.push(halted
        ? "Review feedback from the viewer's annotation tool. The run is stopped for review: "
          + "apply these changes and re-run the stage - do not just continue."
        : "Feedback from the viewer's annotation tool.");
    if (source) out.push(`${kind === "video" ? "Video" : "Image"}: ${source}`);
    if (kind === "video") {
        out.push(`${w}x${h}, ${fps || 24} fps${frames ? `, ${frames} frames` : ""}.`);
    } else if (w && h) {
        out.push(`${w}x${h} px.`);
    }
    out.push(`${n} annotation${n === 1 ? "" : "s"}. Each has the picture with the marks drawn in `
        + "(attached, in this order) and the same marks written out below.");
    groups.forEach((g, i) => {
        out.push("");
        if (kind === "video") {
            const range = g.end > g.frame
                ? `frames ${g.frame}-${g.end} (${timecode(g.frame, fps)} to ${timecode(g.end, fps)}); `
                  + `the picture is frame ${g.frame}`
                : `frame ${g.frame} (${timecode(g.frame, fps)})`;
            out.push(`${i + 1}. ${range}`);
        } else {
            out.push(`${i + 1}. the picture`);
        }
        if (g.image) out.push(`   marked picture: ${g.image}`);
        const notes = g.items.filter((it) => it.type === "text").map((it) => String(it.text || "").trim());
        if (notes.length) out.push(`   notes: ${notes.map((t) => JSON.stringify(t)).join("; ")}`);
        for (const line of describeItems(g.items, w, h)) out.push(`   - ${line}`);
    });
    return out.join("\n");
}
