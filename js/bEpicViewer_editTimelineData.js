// bEpicViewer_editTimelineData.js
// The arithmetic of the Edit panel (bEpicViewer_editTimeline.js): where each shot,
// dissolve and text sits, and what every edit does to the cut. Plain functions of
// the data - no page, no panel, no ComfyUI - so they run under node.
//
// A cut, as the panel works on it (timeline_io.editable on the server):
//
//   { name, fps,
//     clips: [{ ref, name, file, in, length, transition }],   // seconds
//     texts: [{ ref, text, start, length, preset }],
//     sound: [{ name, file }] }
//
// A clip is at its FULL length; `transition` is the dissolve from the clip before
// it, and is taken out of both - so a dissolve shortens the film by its length.
// `ref` is the item's place in the file it came from and is never touched here.
//
// Every edit returns a NEW cut and leaves the one it was given alone: the panel
// keeps the saved cut beside the working one to know what has changed.

export const MIN_CLIP = 0.1;
export const MIN_TEXT = 0.2;
// A dissolve leaves at least this much of each clip it joins outside itself.
const MIX_MARGIN = 0.05;

const pct = (v) => Math.max(0, Math.min(100, v));
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round = (v) => Math.round(v * 10000) / 10000;
const copy = (cut) => ({
    ...cut,
    clips: (cut.clips || []).map((c) => ({ ...c })),
    texts: (cut.texts || []).map((t) => ({ ...t })),
    sound: (cut.sound || []).map((s) => ({ ...s })),
});

/** A length in seconds, as a person writes it on a shot: 0.5s, 3.2s, 1:04. */
export function lengthLabel(seconds) {
    const s = Math.max(0, num(seconds));
    if (s < 60) return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + "s";
    return Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
}

/** A moment moved onto a frame of the film. */
export function toFrame(seconds, fps) {
    const rate = num(fps) > 0 ? num(fps) : 24;
    return Math.round(num(seconds) * rate) / rate;
}

/** How long the film of a cut is: the clips, less what the dissolves take. */
export function filmLength(cut) {
    const clips = (cut && cut.clips) || [];
    const total = clips.reduce((sum, c) => sum + num(c.length), 0);
    return Math.max(0, total - clips.slice(1).reduce((sum, c) => sum + num(c.transition), 0));
}

/** Where each clip begins in the film. */
export function clipStarts(cut) {
    const out = [];
    let at = 0;
    ((cut && cut.clips) || []).forEach((c, i) => {
        if (i) at -= num(c.transition);
        out.push(round(at));
        at += num(c.length);
    });
    return out;
}

/** The clip on screen at `seconds` (-1 for none). In a dissolve it is the one coming in. */
export function clipAt(cut, seconds) {
    const starts = clipStarts(cut);
    let found = -1;
    starts.forEach((s, i) => {
        if (seconds >= s - 1e-6 && seconds < s + num(cut.clips[i].length) - 1e-6) found = i;
    });
    return found;
}

// Keep a cut one that can be rendered: nothing shorter than it may be, the first
// clip with nothing to dissolve from, no dissolve as long as a clip it joins, no
// text before the start. Called at the end of every edit, so an edit can be
// written as what the user did and not as everything that follows from it.
function settle(cut) {
    cut.clips.forEach((c, i) => {
        c.in = round(Math.max(0, num(c.in)));
        c.length = round(Math.max(MIN_CLIP, num(c.length)));
        c.transition = i ? Math.max(0, num(c.transition)) : 0;
    });
    cut.clips.forEach((c, i) => {
        if (!i || !c.transition) return;
        const room = Math.min(c.length, cut.clips[i - 1].length) - MIX_MARGIN;
        c.transition = round(Math.max(0, Math.min(c.transition, room)));
    });
    cut.texts.forEach((t) => {
        t.start = round(Math.max(0, num(t.start)));
        t.length = round(Math.max(MIN_TEXT, num(t.length)));
    });
    return cut;
}

// ── edits ────────────────────────────────────────────────────────────────────

/** A clip ends earlier or later; what follows moves with it. */
export function trimEnd(cut, i, length) {
    const next = copy(cut);
    if (!next.clips[i]) return next;
    next.clips[i].length = num(length, next.clips[i].length);
    return settle(next);
}

/** A clip starts later (or earlier) in its source: its end stays where it was in the source. */
export function trimStart(cut, i, delta) {
    const next = copy(cut);
    const c = next.clips[i];
    if (!c) return next;
    // Not past the start of the source, and not past the clip's own end.
    const d = Math.max(-num(c.in), Math.min(num(delta), num(c.length) - MIN_CLIP));
    c.in = num(c.in) + d;
    c.length = num(c.length) - d;
    return settle(next);
}

/** A clip goes to another place in the order. Its dissolve stays with the join it lands on. */
export function moveClip(cut, from, to) {
    const next = copy(cut);
    const n = next.clips.length;
    if (!(from >= 0 && from < n)) return next;
    const target = Math.max(0, Math.min(n - 1, to));
    if (target === from) return next;
    const [clip] = next.clips.splice(from, 1);
    next.clips.splice(target, 0, clip);
    return settle(next);
}

/** A cut with nothing in it yet: what dropping the first clip starts. */
export function emptyCut(name = "cut", fps = 24) {
    return { name, fps, clips: [], texts: [], sound: [] };
}

/**
 * New material goes into the cut at position `index` (at the end without one).
 * `clip` is { file, name, length } - a clip the file did not hold has no `ref`,
 * which is how the server knows it is new.
 */
export function insertClip(cut, clip, index) {
    const next = copy(cut);
    const n = next.clips.length;
    const at = Number.isInteger(index) ? Math.max(0, Math.min(n, index)) : n;
    next.clips.splice(at, 0, {
        file: String(clip.file || ""), name: String(clip.name || ""), in: Math.max(0, num(clip.in)),
        length: num(clip.length, 3), transition: 0,
    });
    return settle(next);
}

/** The place in the order a clip dropped at `seconds` goes to: before the first clip whose middle is later. */
export function dropIndex(cut, seconds) {
    const starts = clipStarts(cut);
    for (let i = 0; i < starts.length; i++) {
        if (seconds < starts[i] + num(cut.clips[i].length) / 2) return i;
    }
    return starts.length;
}

export function removeClip(cut, i) {
    const next = copy(cut);
    if (next.clips.length <= 1 || !next.clips[i]) return next;       // a cut needs a clip
    next.clips.splice(i, 1);
    return settle(next);
}

/** The dissolve from the clip before into clip `i`; 0 makes it a cut. */
export function setTransition(cut, i, seconds) {
    const next = copy(cut);
    if (!next.clips[i] || i === 0) return next;
    next.clips[i].transition = Math.max(0, num(seconds));
    return settle(next);
}

export function renameClip(cut, i, name) {
    const next = copy(cut);
    if (next.clips[i]) next.clips[i].name = String(name == null ? "" : name).slice(0, 200);
    return next;
}

export function setClipIn(cut, i, seconds) {
    const c = cut.clips[i];
    return c ? trimStart(cut, i, num(seconds, c.in) - num(c.in)) : copy(cut);
}

export function moveText(cut, i, start) {
    const next = copy(cut);
    if (next.texts[i]) next.texts[i].start = num(start, next.texts[i].start);
    return settle(next);
}

export function resizeText(cut, i, length) {
    const next = copy(cut);
    if (next.texts[i]) next.texts[i].length = num(length, next.texts[i].length);
    return settle(next);
}

/** A text begins later or earlier; its end stays where it was. */
export function trimTextStart(cut, i, start) {
    const next = copy(cut);
    const t = next.texts[i];
    if (!t) return next;
    const end = num(t.start) + num(t.length);
    t.start = Math.max(0, Math.min(num(start, t.start), end - MIN_TEXT));
    t.length = end - t.start;
    return settle(next);
}

export function setText(cut, i, text) {
    const next = copy(cut);
    if (next.texts[i]) next.texts[i].text = String(text == null ? "" : text).slice(0, 2000);
    return next;
}

export function removeText(cut, i) {
    const next = copy(cut);
    if (next.texts[i]) next.texts.splice(i, 1);
    return next;
}

/** Has anything the panel can change been changed? */
export function sameCut(a, b) {
    const key = (cut) => JSON.stringify({
        clips: ((cut && cut.clips) || []).map((c) => [Number.isInteger(c.ref) ? c.ref : c.file, c.name, round(num(c.in)), round(num(c.length)), round(num(c.transition))]),
        texts: ((cut && cut.texts) || []).map((t) => [t.ref, t.text, round(num(t.start)), round(num(t.length))]),
    });
    return key(a) === key(b);
}

/** What is sent back to be saved: the cut, and nothing the server did not send. */
export function toSave(cut) {
    return {
        // A clip with no `ref` is new material and is named by its file instead.
        clips: cut.clips.map((c) => ({
            ...(Number.isInteger(c.ref) ? { ref: c.ref } : { file: c.file }),
            name: c.name, in: c.in, length: c.length, transition: c.transition,
        })),
        texts: cut.texts.map((t) => ({ ref: t.ref, text: t.text, start: t.start, length: t.length })),
    };
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** Where everything sits, as percentages of the film's length. */
export function layoutCut(cut) {
    const total = filmLength(cut);
    const empty = { total, shots: [], mixes: [], texts: [], sound: [], ticks: [] };
    if (!cut || !(total > 0)) return empty;
    const starts = clipStarts(cut);
    const place = (start, length) => ({
        left: pct((start / total) * 100),
        width: pct(((Math.min(start + length, total) - Math.max(0, start)) / total) * 100),
    });
    const base = (file) => String(file || "").split(/[\\/]/).pop();
    const shots = cut.clips.map((c, i) => {
        const file = base(c.file);
        return {
            ...place(starts[i], num(c.length)), i, start: starts[i], length: num(c.length),
            name: c.name || file || "shot " + (i + 1),
            title: `${i + 1}. ${c.name || file} — ${lengthLabel(c.length)}, from ${lengthLabel(c.in)} of the source`
                + (file && file !== c.name ? `\n${c.file}` : ""),
        };
    });
    const mixes = cut.clips.map((c, i) => (i && num(c.transition) > 0
        ? { ...place(starts[i], num(c.transition)), i, title: `dissolve, ${lengthLabel(c.transition)}` }
        : null)).filter(Boolean);
    const texts = cut.texts.map((t, i) => ({
        ...place(num(t.start), num(t.length)), i, start: num(t.start), length: num(t.length),
        name: String(t.text || "").split("\n")[0] || "text",
        title: `"${String(t.text || "").replace(/\n/g, " / ")}"${t.preset ? " — " + t.preset : ""}, `
            + `${lengthLabel(t.length)} from ${lengthLabel(t.start)}`,
        late: num(t.start) + num(t.length) > total + 0.02,          // runs past the end of the film
    }));
    const sound = (cut.sound || []).map((s) => ({ left: 0, width: 100, name: s.name || base(s.file),
                                                  title: `sound under the film: ${s.name || s.file}` }));
    return { total, shots, mixes, texts, sound, ticks: ticks(total) };
}

/** The marks of the ruler: a round number of seconds apart, about ten of them. */
export function ticks(total) {
    if (!(total > 0)) return [];
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => total / s <= 12) || 600;
    const out = [];
    for (let t = 0; t <= total + 1e-6; t += step) {
        out.push({ left: pct((t / total) * 100), label: lengthLabel(t).replace(/\.0s$/, "s") });
    }
    return out;
}

/** What identifies the film a timeline belongs to, as the fields the server reads. */
export function timelineTarget(obj) {
    if (!obj || obj.url) return null;                 // a dropped file has no folder to look in
    if (obj.path) return obj.external ? { path: obj.path, external: 1 } : { path: obj.path };
    if (!obj.filename) return null;
    const out = { filename: obj.filename };
    if (obj.type) out.type = obj.type;
    if (obj.subfolder) out.subfolder = obj.subfolder;
    return out;
}

export function timelineQuery(obj) {
    const target = timelineTarget(obj);
    if (!target) return "";
    return "?" + Object.entries(target).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}
