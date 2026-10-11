// bEpicViewer_editTimelineData.js
// The arithmetic of the edit strip (bEpicViewer_editTimeline.js): where each shot,
// dissolve, text and sound sits, as percentages of the film. Plain functions of
// the data - no page, no panel, no ComfyUI - so they run under node.

const pct = (v) => Math.max(0, Math.min(100, v));

/** A length in seconds, as a person writes it on a shot: 0.5s, 3.2s, 1:04. */
export function lengthLabel(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    if (s < 60) return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + "s";
    return Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
}

/**
 * Where everything sits, as percentages of the film.
 *
 * `duration` is the FILM's length when it is known (the video's own), else the
 * timeline's: a timeline and its render can differ by a frame, and the strip has
 * to agree with the scrub bar under it, not with itself.
 */
export function layoutTimeline(data, duration) {
    const total = Number(duration) > 0 ? Number(duration) : Number(data && data.duration) || 0;
    const empty = { total, shots: [], transitions: [], texts: [], audio: [] };
    if (!data || !(total > 0)) return empty;
    const place = (item) => ({
        left: pct((item.start / total) * 100),
        width: pct(((Math.min(item.start + item.length, total) - item.start) / total) * 100),
    });
    let n = 0;
    const shots = (data.video || []).filter((c) => c.start < total).map((c) => {
        const gap = c.kind === "gap";
        if (!gap) n += 1;
        const file = String(c.file || "").split(/[\\/]/).pop();
        return {
            ...place(c), gap, n: gap ? 0 : n, start: c.start, length: c.length,
            name: c.name || file || (gap ? "" : "shot " + n),
            title: gap ? "gap, " + lengthLabel(c.length)
                : `${n}. ${c.name || file} — ${lengthLabel(c.length)}, from ${lengthLabel(c.start)}`
                  + (file && file !== c.name ? `\n${c.file}` : "") + "\nClick to go to its first frame.",
        };
    });
    const transitions = (data.transitions || []).filter((t) => t.start < total).map((t) => ({
        ...place(t), at: t.at, title: `${t.name || "transition"}, ${lengthLabel(t.length)}`,
    }));
    const texts = (data.texts || []).filter((t) => t.start < total).map((t) => ({
        ...place(t), start: t.start, name: t.name || "text",
        title: `"${t.name}"${t.preset ? " — " + t.preset : ""}, ${lengthLabel(t.length)} from ${lengthLabel(t.start)}`,
    }));
    const audio = (data.audio || []).filter((a) => a.kind !== "gap" && a.start < total).map((a) => ({
        ...place(a), name: a.name || String(a.file || "").split(/[\\/]/).pop(),
        title: `sound: ${a.name || a.file}`,
    }));
    return { total, shots, transitions, texts, audio };
}

/** The shot on screen at `seconds` (its index in `shots`, -1 for none). */
export function shotAt(shots, seconds) {
    for (let i = 0; i < shots.length; i++) {
        if (!shots[i].gap && seconds >= shots[i].start - 1e-6 && seconds < shots[i].start + shots[i].length - 1e-6) return i;
    }
    return -1;
}

/** What identifies the film a timeline belongs to, and how the server is asked for it. */
export function timelineQuery(obj) {
    if (!obj || obj.url) return "";                 // a dropped file has no folder to look in
    if (obj.path) {
        return `?path=${encodeURIComponent(obj.path)}` + (obj.external ? "&external=1" : "");
    }
    if (!obj.filename) return "";
    return `?filename=${encodeURIComponent(obj.filename)}`
        + (obj.type ? `&type=${encodeURIComponent(obj.type)}` : "")
        + (obj.subfolder ? `&subfolder=${encodeURIComponent(obj.subfolder)}` : "");
}
