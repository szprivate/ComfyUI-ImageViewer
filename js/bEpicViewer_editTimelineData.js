// bEpicViewer_editTimelineData.js
// The arithmetic of the Edit panel (bEpicViewer_editTimeline.js): where each shot,
// dissolve and text sits, and what every edit does to the cut. Plain functions of
// the data - no page, no panel, no ComfyUI - so they run under node.
//
// A cut, as the panel works on it (timeline_io.editable on the server):
//
//   { name, fps,
//     clips: [{ ref, name, file, in, length, transition, color, volume }],   // seconds
//     texts: [{ ref, text, start, length, preset, size, x, y, color }],   // its look: see TEXT_LOOK
//     sound: [{ name, file }],
//     tracks: [{ id, kind, name, off, clips: [{ ref, name, file, in, length, at, color, volume }] }],
//     off: { V1, A1, T } }
//
// `clips` is the cut itself - track V1: one clip after the other, each at its
// FULL length; `transition` is the dissolve from the clip before it, and is taken
// out of both - so a dissolve shortens the film by its length. `sound` is the bed
// under the whole film (A1). `tracks` are the tracks beyond those two, lowest
// first: a clip there is PLACED (`at`, where it begins in the film) and nothing
// moves when it does. The picture of a higher video track covers what is under
// it, and takes its sound's place too; the clips of a sound track lie under
// everything. `ref` is an item's place in the file it came from and is never
// touched here; an item without one is new.
//
// Every edit returns a NEW cut and leaves the one it was given alone: the panel
// keeps the saved cut beside the working one to know what has changed.

// How a text is drawn where nothing says otherwise (timeline_io.TEXT_LOOK, kept
// in step): `size` is a percentage of the picture's height, `x` / `y` where its
// middle is (0..1 of the picture).
export const TEXT_LOOK = { size: 6, x: 0.5, y: 0.85, color: "#ffffff" };

/** A text's look, every part of it present. */
export function textLook(t) {
    const hold = (v, low, high, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.max(low, Math.min(high, Number(v))) : fallback);
    return {
        size: hold(t && t.size, 1, 40, TEXT_LOOK.size), x: hold(t && t.x, 0, 1, TEXT_LOOK.x), y: hold(t && t.y, 0, 1, TEXT_LOOK.y),
        color: /^#[0-9a-f]{6}$/i.test(String((t && t.color) || "")) ? String(t.color).toLowerCase() : TEXT_LOOK.color,
    };
}

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
    tracks: (cut.tracks || []).map((k) => ({ ...k, clips: (k.clips || []).map((c) => ({ ...c })) })),
    off: { ...(cut.off || {}) },
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

/** How long the cut itself (V1) is: the clips, less what the dissolves take. */
export function mainLength(cut) {
    const clips = (cut && cut.clips) || [];
    const total = clips.reduce((sum, c) => sum + num(c.length), 0);
    return Math.max(0, total - clips.slice(1).reduce((sum, c) => sum + num(c.transition), 0));
}

/** How long the film is: the cut, or as far as the last clip on a higher video track reaches. */
export function filmLength(cut) {
    let total = mainLength(cut);
    for (const k of (cut && cut.tracks) || []) {
        if (k.kind === "audio") continue;
        for (const c of k.clips || []) total = Math.max(total, num(c.at) + num(c.length));
    }
    return round(total);
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
    for (const k of cut.tracks || []) {
        for (const c of k.clips) {
            c.at = round(Math.max(0, num(c.at)));
            c.in = round(Math.max(0, num(c.in)));
            c.length = round(Math.max(MIN_CLIP, num(c.length)));
        }
    }
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
    return { name, fps, clips: [], texts: [], sound: [], tracks: [], off: {} };
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
        length: num(clip.length, 3), transition: 0, color: String(clip.color || ""), volume: 1,
    });
    return settle(next);
}

// ── tracks ───────────────────────────────────────────────────────────────────

/** A track of the cut by its id (not V1 / A1, which are the cut and its bed). */
export function trackOf(cut, id) {
    return ((cut && cut.tracks) || []).find((k) => k.id === id) || null;
}

/** A new, empty track of `kind` ("video" / "audio"), above the others of its kind. */
export function addTrack(cut, kind) {
    const next = copy(cut);
    const audio = kind === "audio";
    const letter = audio ? "A" : "V";
    const taken = new Set(next.tracks.map((k) => k.id));
    let n = 2;
    while (taken.has(letter + n)) n += 1;
    next.tracks.push({ id: letter + n, kind: audio ? "audio" : "video", name: letter + n, off: false, clips: [] });
    return next;
}

export function removeTrack(cut, id) {
    const next = copy(cut);
    next.tracks = next.tracks.filter((k) => k.id !== id);
    return next;
}

/** Switch a track off or on. "V1" is the cut itself, "A1" its bed. */
export function setTrackOff(cut, id, off) {
    const next = copy(cut);
    if (id === "V1" || id === "A1" || id === "T") next.off[id] = !!off;
    else { const k = trackOf(next, id); if (k) k.off = !!off; }
    return next;
}

/** A clip put on a track at `at` seconds. `clip` is { file, name, length, in }. */
export function placeClip(cut, id, clip, at) {
    const next = copy(cut);
    const k = trackOf(next, id);
    if (!k) return next;
    k.clips.push({ file: String(clip.file || ""), name: String(clip.name || ""), in: Math.max(0, num(clip.in)),
                   length: num(clip.length, 3), at: Math.max(0, num(at)), color: String(clip.color || ""), volume: 1 });
    return settle(next);
}

/** A placed clip goes to another moment; nothing else moves. */
export function moveTrackClip(cut, id, i, at) {
    const next = copy(cut);
    const c = (trackOf(next, id) || { clips: [] }).clips[i];
    if (c) c.at = num(at, c.at);
    return settle(next);
}

export function trimTrackClipEnd(cut, id, i, length) {
    const next = copy(cut);
    const c = (trackOf(next, id) || { clips: [] }).clips[i];
    if (c) c.length = num(length, c.length);
    return settle(next);
}

/** A placed clip begins later (or earlier): its end stays where it is in the film. */
export function trimTrackClipStart(cut, id, i, delta) {
    const next = copy(cut);
    const c = (trackOf(next, id) || { clips: [] }).clips[i];
    if (!c) return next;
    const d = Math.max(-Math.min(num(c.in), num(c.at)), Math.min(num(delta), num(c.length) - MIN_CLIP));
    c.in = num(c.in) + d;
    c.at = num(c.at) + d;
    c.length = num(c.length) - d;
    return settle(next);
}

export function removeTrackClip(cut, id, i) {
    const next = copy(cut);
    const k = trackOf(next, id);
    if (k && k.clips[i]) k.clips.splice(i, 1);
    return next;
}

/** The clip a selection names: { kind: "clip", i } on the cut, { kind: "tclip", track, i } on a track. */
export function clipOf(cut, sel) {
    if (!cut || !sel) return null;
    if (sel.kind === "clip") return cut.clips[sel.i] || null;
    if (sel.kind === "tclip") return (trackOf(cut, sel.track) || { clips: [] }).clips[sel.i] || null;
    return null;
}

/** Change what a clip carries besides its place: its name, colour, volume. */
export function setClipProps(cut, sel, props) {
    const next = copy(cut);
    const c = clipOf(next, sel);
    if (!c) return next;
    if (props.name !== undefined) c.name = String(props.name == null ? "" : props.name).slice(0, 200);
    if (props.color !== undefined) c.color = /^#[0-9a-f]{6}$/i.test(String(props.color)) ? String(props.color).toLowerCase() : "";
    if (props.volume !== undefined) c.volume = round(Math.max(0, Math.min(1, num(props.volume, 1))));
    return next;
}

/** A text of its own, written here. */
export function addText(cut, text, start, length = 2) {
    const next = copy(cut);
    next.texts.push({ text: String(text || "Text").slice(0, 2000), start: Math.max(0, num(start)), length: num(length, 2),
                      preset: "", ...TEXT_LOOK });
    return settle(next);
}

/** Change how a text is drawn: its size, where it stands, its colour. */
export function setTextLook(cut, i, look) {
    const next = copy(cut);
    if (next.texts[i]) Object.assign(next.texts[i], textLook({ ...next.texts[i], ...look }));
    return next;
}

/** The texts that stand on the picture at `seconds`, each with its look. */
export function textsAt(cut, seconds) {
    if (!cut || (cut.off && cut.off.T)) return [];
    return (cut.texts || []).filter((t) => seconds >= num(t.start) - 1e-6 && seconds < num(t.start) + num(t.length) - 1e-6
        && String(t.text || "").trim()).map((t) => ({ text: String(t.text), ...textLook(t) }));
}

/**
 * Move a clip to another track (`to`: "V1" or a track's id), to the moment `at`.
 * On the cut itself it goes between the shots there; on any other track it is
 * placed at `at`. Returns { cut, sel } - the new cut and where the clip is now -
 * or null when it cannot go there (the cut's only shot cannot leave it).
 */
export function transferClip(cut, sel, to, at) {
    const c = clipOf(cut, sel);
    if (!c) return null;
    const from = sel.kind === "clip" ? "V1" : sel.track;
    if (from === to) return null;
    if (sel.kind === "clip" && cut.clips.length <= 1) return null;
    let next = sel.kind === "clip" ? removeClip(cut, sel.i) : removeTrackClip(cut, sel.track, sel.i);
    const keep = { file: c.file, name: c.name, in: c.in, length: c.length, color: c.color || "" };
    const carry = (clip) => { clip.volume = num(c.volume, 1); };
    if (to === "V1") {
        const index = next.clips.length ? dropIndex(next, num(at)) : 0;
        next = insertClip(next, keep, index);
        carry(next.clips[index]);
        return { cut: next, sel: { kind: "clip", i: index } };
    }
    if (!trackOf(next, to)) return null;
    next = placeClip(next, to, keep, at);
    const k = trackOf(next, to);
    carry(k.clips[k.clips.length - 1]);
    return { cut: next, sel: { kind: "tclip", track: to, i: k.clips.length - 1 } };
}

/**
 * Which tracks are seen and heard: every one that is not switched off - or,
 * while any track of a kind is soloed, only the soloed ones of that kind.
 * `solo` is { id: true }; the answer is a Set of ids, "V1" and "A1" among them.
 */
export function liveTracks(cut, solo) {
    const all = [{ id: "V1", kind: "video", off: !!(cut && cut.off && cut.off.V1) },
                 { id: "A1", kind: "audio", off: !!(cut && cut.off && cut.off.A1) },
                 ...((cut && cut.tracks) || [])];
    const live = new Set();
    for (const kind of ["video", "audio"]) {
        const mine = all.filter((k) => k.kind === kind);
        const soloed = mine.filter((k) => solo && solo[k.id]);
        for (const k of (soloed.length ? soloed : mine.filter((k) => !k.off))) live.add(k.id);
    }
    return live;
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
    const dress = (c) => [String(c.color || ""), round(num(c.volume, 1))];
    const key = (cut) => JSON.stringify({
        clips: ((cut && cut.clips) || []).map((c) => [Number.isInteger(c.ref) ? c.ref : c.file, c.name, round(num(c.in)), round(num(c.length)), round(num(c.transition)), ...dress(c)]),
        texts: ((cut && cut.texts) || []).map((t) => [Number.isInteger(t.ref) ? t.ref : "new", t.text, round(num(t.start)), round(num(t.length)), JSON.stringify(textLook(t))]),
        tracks: ((cut && cut.tracks) || []).map((k) => [k.kind, k.name, !!k.off, (k.clips || []).map((c) =>
            [Array.isArray(c.ref) ? c.ref.join(":") : c.file, c.name, round(num(c.at)), round(num(c.in)), round(num(c.length)), ...dress(c)])]),
        off: [!!(cut && cut.off && cut.off.V1), !!(cut && cut.off && cut.off.A1), !!(cut && cut.off && cut.off.T)],
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
            color: c.color || "", volume: num(c.volume, 1),
        })),
        // A text with no `ref` was written here.
        texts: cut.texts.map((t) => ({ ...(Number.isInteger(t.ref) ? { ref: t.ref } : {}),
                                       text: t.text, start: t.start, length: t.length, ...textLook(t) })),
        tracks: (cut.tracks || []).map((k) => ({
            id: k.id, kind: k.kind, name: k.name, off: !!k.off,
            clips: (k.clips || []).map((c) => ({
                ...(Array.isArray(c.ref) ? { ref: c.ref } : { file: c.file }),
                name: c.name, at: c.at, in: c.in, length: c.length, color: c.color || "", volume: num(c.volume, 1),
            })),
        })),
        off: { V1: !!(cut.off && cut.off.V1), A1: !!(cut.off && cut.off.A1), T: !!(cut.off && cut.off.T) },
    };
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** Where everything sits, as percentages of the film's length. */
export function layoutCut(cut, density = 1) {
    const total = filmLength(cut);
    const empty = { total, shots: [], mixes: [], texts: [], sound: [], tracks: [], ticks: [] };
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
            ...place(starts[i], num(c.length)), i, start: starts[i], length: num(c.length), color: c.color || "",
            name: c.name || file || "shot " + (i + 1),
            title: `${i + 1}. ${c.name || file} — ${lengthLabel(c.length)}, from ${lengthLabel(c.in)} of the source`
                + (file && file !== c.name ? `\n${c.file}` : ""),
        };
    });
    const mixes = cut.clips.map((c, i) => (i && num(c.transition) > 0
        ? { ...place(starts[i], num(c.transition)), i, start: starts[i], length: num(c.transition),
            title: `Cross Dissolve, ${lengthLabel(c.transition)} - drag an edge to make it longer or shorter` }
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
    const tracks = (cut.tracks || []).map((k) => ({
        id: k.id, kind: k.kind, name: k.name || k.id, off: !!k.off,
        items: (k.clips || []).map((c, i) => {
            const file = base(c.file);
            return { ...place(num(c.at), num(c.length)), i, start: num(c.at), length: num(c.length), color: c.color || "",
                     name: c.name || file || "clip " + (i + 1),
                     title: `${c.name || file} — ${lengthLabel(c.length)} at ${lengthLabel(c.at)}, from ${lengthLabel(c.in)} of the source`
                         + (file && file !== c.name ? `\n${c.file}` : "") };
        }),
    }));
    return { total, shots, mixes, texts, sound, tracks, ticks: ticks(total, density) };
}

/** The marks of the ruler: a round number of seconds apart, about ten of them. */
export function ticks(total, density = 1) {
    if (!(total > 0)) return [];
    // `density`: how far the timeline is zoomed in - more marks, closer together.
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => total / s <= 12 * Math.max(1, density)) || 600;
    const out = [];
    for (let t = 0; t <= total + 1e-6; t += step) {
        out.push({ left: pct((t / total) * 100),
                   label: (step < 0.5 && t < 60 ? (Math.round(t * 100) / 100) + "s" : lengthLabel(t)).replace(/\.0s$/, "s") });
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

// ── playing ──────────────────────────────────────────────────────────────────

/** How many frames the film of a cut has (one for a cut with nothing in it). */
export function filmFrames(cut) {
    const rate = cut && num(cut.fps) > 0 ? num(cut.fps) : 24;
    return Math.max(1, Math.round(filmLength(cut) * rate));
}

/**
 * What the cut itself (V1) shows at `seconds`: clip `i`, shown from `start`
 * until `end` (where the next clip takes over - in a dissolve that is the
 * dissolve's beginning, as clipAt has it), and `local`, the moment of the clip's
 * own file. `seconds` is held inside the cut; null for no clips.
 */
export function playAt(cut, seconds) {
    const clips = (cut && cut.clips) || [];
    if (!clips.length) return null;
    const starts = clipStarts(cut);
    const total = mainLength(cut);
    const t = Math.max(0, Math.min(num(seconds), Math.max(0, total - 1e-4)));
    let i = 0;
    for (let k = 0; k < starts.length; k++) if (t >= starts[k] - 1e-6) i = k;
    const end = i + 1 < starts.length ? starts[i + 1] : total;
    return { i, t, start: starts[i], end, local: round(num(clips[i].in) + Math.max(0, t - starts[i])) };
}

/**
 * The picture of the film at `seconds`, every track counted: the clip of the
 * highest live video track that has one there, else the cut's own.
 *
 *   { clip, key, sel, t, end, origin, local, under, mix }
 *
 * `clip` is null where nothing has a picture (black). `key` names the clip
 * ("V1:2", "V3:0") and changes exactly when the picture's source does; `sel` is
 * the same as a selection. The picture stays until `end`. `origin` is the moment
 * of the film at which the clip's file is at its in point, so the file's time
 * is `clip.in + (t - origin)` - which is `local`. `live` is liveTracks().
 *
 * In a dissolve of the cut the picture is the clip coming IN, and `under` is the
 * one going out - { clip, key, origin, local } - still running beneath it, with
 * `mix` (0..1) how far the dissolve has got: the picture is `under` with `clip`
 * laid over it at that opacity.
 */
export function pictureAt(cut, seconds, live) {
    const total = filmLength(cut);
    if (!cut || !(total > 0)) return null;
    const t = Math.max(0, Math.min(num(seconds), Math.max(0, total - 1e-4)));
    const on = (id) => !live || live.has(id);
    let found = null;
    let next = total;                       // the first moment after t at which something may change
    const tracks = (cut.tracks || []).filter((k) => k.kind !== "audio" && on(k.id));
    for (let n = tracks.length - 1; n >= 0; n--) {
        const k = tracks[n];
        k.clips.forEach((c, i) => {
            const a = num(c.at), b = a + num(c.length);
            if (a > t + 1e-6) next = Math.min(next, a);
            if (found || !(t >= a - 1e-6 && t < b - 1e-6)) return;
            // Two clips of one track at one moment: the one that begins later is on top.
            const later = k.clips.some((o, j) => j !== i && num(o.at) > a && t >= num(o.at) - 1e-6 && t < num(o.at) + num(o.length) - 1e-6);
            if (later) return;
            found = { clip: c, key: `${k.id}:${i}`, sel: { kind: "tclip", track: k.id, i }, origin: a, end: b };
        });
        if (found) break;
    }
    if (!found && on("V1") && t < mainLength(cut) - 1e-6) {
        const at = playAt(cut, t);
        if (at) {
            found = { clip: cut.clips[at.i], key: `V1:${at.i}`, sel: { kind: "clip", i: at.i }, origin: at.start, end: at.end };
            const mixLen = at.i > 0 ? num(cut.clips[at.i].transition) : 0;
            if (mixLen > 0 && t < at.start + mixLen - 1e-6) {
                const before = cut.clips[at.i - 1];
                const began = clipStarts(cut)[at.i - 1];
                found.under = { clip: before, key: `V1:${at.i - 1}`, origin: began, local: round(num(before.in) + Math.max(0, t - began)) };
                found.mix = Math.max(0, Math.min(1, (t - at.start) / mixLen));
                found.mixStart = at.start;
                found.mixLen = mixLen;
                next = Math.min(next, at.start + mixLen);          // the moment the dissolve is over
            }
        }
    }
    if (!found) found = { clip: null, key: "", sel: null, origin: t, end: total };
    found.t = t;
    found.end = Math.max(t + 1e-4, Math.min(found.end, next));
    found.local = found.clip ? round(num(found.clip.in) + Math.max(0, t - found.origin)) : 0;
    return found;
}

/**
 * Everything that is heard under the picture: the bed (A1, under the whole
 * film) and the clips of the live sound tracks, as { file, at, in, length, volume }.
 */
export function soundItems(cut, live) {
    const on = (id) => !live || live.has(id);
    const out = [];
    const total = filmLength(cut);
    if (on("A1")) for (const s of (cut && cut.sound) || []) if (s && s.file) out.push({ file: s.file, at: 0, in: 0, length: total, volume: 1 });
    for (const k of (cut && cut.tracks) || []) {
        if (k.kind !== "audio" || !on(k.id)) continue;
        for (const c of k.clips || []) if (c.file) out.push({ file: c.file, at: num(c.at), in: num(c.in), length: num(c.length), volume: num(c.volume, 1) });
    }
    return out;
}

/** Is a clip's file a picture (shown for the clip's length) rather than a film? */
export function isStill(file) {
    return !/\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(String(file || ""));
}
