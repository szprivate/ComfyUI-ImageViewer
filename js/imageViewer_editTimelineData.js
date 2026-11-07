// imageViewer_editTimelineData.js
// The arithmetic of the Edit panel (imageViewer_editTimeline.js): where each shot,
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
// out of both - so a dissolve shortens the film by its length. `gap` (seconds,
// where a clip has one) is EMPTY time before the clip: nothing of the cut plays
// there - black, or what a higher track shows - and no dissolve leads into or out
// of a gap (a clip after one has no `transition`; the OTIO file has a Gap item
// there). So V1 holds gaps as Resolve's tracks do: a move or a delete in the
// Selection mode leaves one (liftClip, moveShot), a ripple closes it
// (rippleDelete, closeGap, the Trim mode). `sound` is the bed
// under the whole film (A1). `tracks` are the tracks beyond those two, lowest
// first: a clip there is PLACED (`at`, where it begins in the film) and nothing
// moves when it does. The picture of a higher video track covers what is under
// it, and takes its sound's place too; the clips of a sound track lie under
// everything. `ref` is an item's place in the file it came from and is never
// touched here; an item without one is new.
//
// A film's picture and sound can be split apart ("Unlink", unlinkClip): a clip
// of the same file on a sound track then carries the sound (the video clip has
// `mute`), at its own place - a J or L cut. The two share a link group (`link`);
// `unlinked` lets them be moved and trimmed apart, else what is done to one is
// done to the other (followLink). In the file: metadata.imageviewer.link / unlinked / mute.
//
// Every edit returns a NEW cut and leaves the one it was given alone: the panel
// keeps the saved cut beside the working one to know what has changed.
//
// A TITLE is a clip like any other on a video track (V2 and up), with `title`
// (its words and its look, imageViewer_editTitles.js) and no file: it has no
// time of its own (isStillClip, like a picture), and its picture is the words
// over what is under it - never a cover (pictureAt leaves it out; the player and
// the render lay it over the picture, titlesAt). Texts of older cuts (`texts`,
// markers in the file) come in as titles (textsToTitles; timeline_io does the
// same when it reads a cut).

import { TITLE_KEYS, TITLE_NUM, cleanTitle, titleFromText } from "./imageViewer_editTitles.js";

import { cleanAfx, afxActive } from "./imageViewer_audioFxData.js";

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

// What the Inspector's Video tab sets on a clip (timeline_io.FX, kept in step):
// each key with its neutral value and the range it is held to. Zoom is a factor;
// position and anchor point are fractions of the frame (x of its width to the
// right, y of its height UP); rotation is degrees, clockwise; a crop is the
// fraction of the picture taken off that side; opacity is 0..1. `toff` / `coff`
// / `ooff` switch a whole section off without losing its numbers.
export const FX = { zx: [1, 0.01, 20], zy: [1, 0.01, 20], x: [0, -5, 5], y: [0, -5, 5], rot: [0, -3600, 3600],
                    ax: [0, -5, 5], ay: [0, -5, 5], cl: [0, 0, 1], cr: [0, 0, 1], ct: [0, 0, 1], cb: [0, 0, 1], op: [1, 0, 1] };
export const FX_FLAGS = ["fh", "fv", "toff", "coff", "ooff"];
export const FX_SECTIONS = { transform: ["zx", "zy", "x", "y", "rot", "ax", "ay", "fh", "fv"], crop: ["cl", "cr", "ct", "cb"], composite: ["op"] };
const FX_OFF = { transform: "toff", crop: "coff", composite: "ooff" };

/** `given` held to what an effect may be, with only what differs from neutral kept. */
export function cleanFx(given) {
    const out = {};
    if (!given || typeof given !== "object") return out;
    for (const [key, [neutral, low, high]] of Object.entries(FX)) {
        const v = Number(given[key]);
        if (given[key] === undefined || given[key] === null || !Number.isFinite(v)) continue;
        const held = Math.round(Math.max(low, Math.min(high, v)) * 100000) / 100000;
        if (held !== neutral) out[key] = held;
    }
    for (const key of FX_FLAGS) if (given[key]) out[key] = true;
    const keys = cleanKeys(given.keys);
    if (Object.keys(keys).length) out.keys = keys;
    return out;
}

// ── keyframes ────────────────────────────────────────────────────────────────
//
// Every number of the Inspector can be animated: the FX keys and the volume
// ("vol"). `fx.keys = { param: [{ t, v, i }] }` - `t` seconds into the CLIP (clip
// time: from the clip's first frame on the timeline, whatever its speed, loop or
// slip - so a slip keeps them where they are on the timeline, and a retime or a
// loop does not stretch them), `v` the value there, `i` how it goes on to the
// next key: absent "linear", "in" (ease in), "out" (ease out), "inout", "hold".
// A param with keys ignores its static number. The flips are switches and are
// not keyed; the speed is one number per clip and is not keyed either.
// timeline_io.clean_fx / timeline_render.key_value are the same in Python - a
// change to one is a change to the other (tests/test_edit_disabled_keys.py).

export const KEY_PARAMS = [...Object.keys(FX), "vol", ...Object.keys(TITLE_KEYS)];
export const INTERPS = ["linear", "in", "out", "inout", "hold"];
const KEY_RANGE = (p) => (p === "vol" ? [0, 1] : TITLE_KEYS[p] ? TITLE_NUM[TITLE_KEYS[p]].slice(1) : [FX[p][1], FX[p][2]]);

/** Keys held to what they may be: known params, finite, sorted, one per moment (the last wins), at most 1000 each. */
export function cleanKeys(given) {
    const out = {};
    if (!given || typeof given !== "object") return out;
    for (const p of KEY_PARAMS) {
        const list = Array.isArray(given[p]) ? given[p] : null;
        if (!list) continue;
        const [lo, hi] = KEY_RANGE(p);
        const by = new Map();
        for (const k of list) {
            const t = Number(k && k.t), v = Number(k && k.v);
            if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0) continue;
            const key = { t: Math.round(t * 10000) / 10000, v: Math.round(Math.max(lo, Math.min(hi, v)) * 100000) / 100000 };
            if (INTERPS.includes(k.i) && k.i !== "linear") key.i = k.i;
            by.set(key.t, key);
        }
        const keys = [...by.values()].sort((a, b) => a.t - b.t).slice(0, 1000);
        if (keys.length) out[p] = keys;
    }
    return out;
}

/** How far along from one key to the next a share `p` (0..1) is, by the first key's way of going on. */
export function easeShare(p, how) {
    const x = Math.max(0, Math.min(1, p));
    if (how === "hold") return 0;
    if (how === "in") return x * x;
    if (how === "out") return 1 - (1 - x) * (1 - x);
    if (how === "inout") return x * x * (3 - 2 * x);
    return x;
}

/** The value of keys `list` at clip time `u`: before the first its value, after the last its value. */
export function keyValue(list, u) {
    if (!list || !list.length) return undefined;
    const t = num(u);
    if (t <= list[0].t) return list[0].v;
    const last = list[list.length - 1];
    if (t >= last.t) return last.v;
    let k = 0;
    while (k + 1 < list.length && list[k + 1].t <= t) k += 1;
    const a = list[k], b = list[k + 1];
    const f = easeShare((t - a.t) / Math.max(1e-9, b.t - a.t), a.i);
    return a.v + (b.v - a.v) * f;
}

/** The keys of a clip's param (an empty list for none). */
export function keysOf(c, p) {
    const k = c && c.fx && c.fx.keys;
    return (k && Array.isArray(k[p]) && k[p]) || [];
}

/** Has the clip any keys? */
export function hasKeys(c) {
    const k = c && c.fx && c.fx.keys;
    return !!k && Object.keys(k).some((p) => Array.isArray(k[p]) && k[p].length);
}

/** A param's value at clip time `u`: from its keys, else its static number (vol: the clip's volume). */
export function paramAt(c, p, u) {
    const list = keysOf(c, p);
    if (list.length) return keyValue(list, u);
    if (p === "vol") return Math.max(0, Math.min(1, c && c.volume != null ? num(c.volume, 1) : 1));
    if (TITLE_KEYS[p]) return cleanTitle(c && c.title)[TITLE_KEYS[p]];
    const fx = cleanFx(c && c.fx);
    return fx[p] === undefined ? FX[p][0] : fx[p];
}

/** A clip's effect with every key present, as its numbers stand at clip time `u` (sections that are off included). */
export function rawFx(clip, u = 0) {
    const fx = cleanFx(clip && clip.fx);
    const out = {};
    for (const [key, [neutral]] of Object.entries(FX)) {
        const list = fx.keys && fx.keys[key];
        out[key] = list ? keyValue(list, u) : (fx[key] === undefined ? neutral : fx[key]);
    }
    for (const key of FX_FLAGS) out[key] = !!fx[key];
    return out;
}

/** A clip's effect as it is DRAWN at clip time `u` - sections that are switched off at neutral - or null for a clip drawn as it comes. */
export function clipFx(clip, u = 0) {
    const fx = rawFx(clip, u);
    for (const [section, keys] of Object.entries(FX_SECTIONS)) {
        if (!fx[FX_OFF[section]]) continue;
        for (const key of keys) fx[key] = FX[key] ? FX[key][0] : false;
    }
    const plain = Object.entries(FX).every(([key, [neutral]]) => fx[key] === neutral) && !fx.fh && !fx.fv;
    return plain ? null : fx;
}

/**
 * How a layer draws a clip with effect `fx` (clipFx): the CSS transform to put
 * AFTER the viewer's own, and the clip-path that keeps the picture inside the
 * frame and inside its crop. `box` is where the untransformed picture lies in
 * the layer, in the layer's own pixels: { x, y, w, h }; the layer turns about
 * its middle, which is the picture's. The same arithmetic as the render's
 * (timeline_render.lay): cropped, scaled and turned about the anchor point, moved.
 */
export function fxPlace(fx, box) {
    const sx = fx.zx * (fx.fh ? -1 : 1), sy = fx.zy * (fx.fv ? -1 : 1);
    const px = fx.x * box.w, py = -fx.y * box.h, ax = fx.ax * box.w, ay = -fx.ay * box.h;
    const r = (v) => Math.round(v * 1000) / 1000;
    const moved = sx !== 1 || sy !== 1 || fx.rot % 360 !== 0 || px !== 0 || py !== 0;
    const transform = moved
        ? `translate(${r(px + ax)}px, ${r(py + ay)}px) rotate(${r(fx.rot)}deg) scale(${r(sx)}, ${r(sy)}) translate(${r(-ax)}px, ${r(-ay)}px)`
        : "";
    const cropped = fx.cl > 0 || fx.cr > 0 || fx.ct > 0 || fx.cb > 0;
    if (!moved && !cropped) return { transform, clip: "", opacity: fx.op };
    // The frame, seen from the picture's own space: its corners taken back
    // through the transform. What is drawn is the part of that inside the crop.
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const cos = Math.cos(fx.rot * Math.PI / 180), sin = Math.sin(fx.rot * Math.PI / 180);
    const back = ([X, Y]) => {
        const dx = X - cx - px - ax, dy = Y - cy - py - ay;
        return [cx + ax + (cos * dx + sin * dy) / sx, cy + ay + (-sin * dx + cos * dy) / sy];
    };
    let poly = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]].map(back);
    const sides = [
        [(q) => q[0] >= box.x + fx.cl * box.w, 0, box.x + fx.cl * box.w],
        [(q) => q[0] <= box.x + box.w - fx.cr * box.w, 0, box.x + box.w - fx.cr * box.w],
        [(q) => q[1] >= box.y + fx.ct * box.h, 1, box.y + fx.ct * box.h],
        [(q) => q[1] <= box.y + box.h - fx.cb * box.h, 1, box.y + box.h - fx.cb * box.h],
    ];
    for (const [inside, axis, at] of sides) {          // one side of the crop at a time (Sutherland-Hodgman)
        const next = [];
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const ia = inside(a), ib = inside(b);
            if (ia) next.push(a);
            if (ia !== ib) {
                const f = (at - a[axis]) / (b[axis] - a[axis]);
                next.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
            }
        }
        poly = next;
        if (!poly.length) break;
    }
    const clip = poly.length ? "polygon(" + poly.map(([X, Y]) => `${r(X)}px ${r(Y)}px`).join(", ") + ")" : "polygon(0px 0px, 0px 0px, 0px 0px)";
    return { transform, clip, opacity: fx.op };
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
    lock: { ...(cut.lock || {}) },
    auto: { ...(cut.auto || {}) },
    // Track effects of the bed (A1); the other tracks carry theirs (k.afx). Chains are replaced, never changed in place.
    afx: { ...(cut.afx || {}) },
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
    if (!clips.length) return 0;
    const starts = clipStarts(cut);
    return Math.max(0, ...clips.map((c, i) => starts[i] + num(c.length)));
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
        at += num(c.gap);                       // empty time before it
        if (i) at -= num(c.transition);
        out.push(round(at));
        at += num(c.length);
    });
    return out;
}

/** The gaps of V1: [{ i, start, length }] - the empty time before clip i. */
export function v1Gaps(cut) {
    const starts = clipStarts(cut);
    return ((cut && cut.clips) || []).map((c, i) => (num(c.gap) > 0 ? { i, start: round(starts[i] - num(c.gap)), length: num(c.gap) } : null))
        .filter(Boolean);
}

/** The gap of V1 that `seconds` lies in: the index of the clip it is before, or -1. */
export function gapAt(cut, seconds) {
    const t = num(seconds);
    const g = v1Gaps(cut).find((x) => t >= x.start - 1e-6 && t < x.start + x.length - 1e-6);
    return g ? g.i : -1;
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
        const gap = round(Math.max(0, num(c.gap)));
        if (gap > 1e-4) c.gap = gap; else delete c.gap;
        // No dissolve into a gap: the clip after one comes in with a cut.
        c.transition = i && !c.gap ? Math.max(0, num(c.transition)) : 0;
        tidyTime(c);
        tidyLink(c);
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
            delete c.gap;
            if (c.title) { c.title = cleanTitle(c.title); c.in = 0; c.file = ""; }
            tidyTime(c);
            tidyLink(c);
        }
    }
    tidyAudio(cut);
    return cut;
}

// A clip's link group and mute, held to what they may be.
function tidyLink(c) {
    if (typeof c.link !== "string" || !/^[A-Za-z0-9_.:-]{1,40}$/.test(c.link)) { delete c.link; delete c.unlinked; }
    else if (c.unlinked !== true) delete c.unlinked;
    if (c.mute !== true) delete c.mute;
    if (c.disabled !== true) delete c.disabled;
}

// A clip's speed and loop, held to what they may be: a speed of 1, a still's
// speed or loop, and a loop no longer than one turn are no speed and no loop.
function tidyTime(c) {
    const sp = num(c.speed, 1);
    if (!(sp > 0) || Math.abs(sp - 1) < 1e-4 || isStillClip(c)) delete c.speed;
    else c.speed = round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, sp)));
    const looped = (c.loop === "loop" || c.loop === "pingpong") && num(c.span) > 0 && !isStillClip(c);
    if (looped && num(c.length) * speedOf(c) > num(c.span) + 1e-4) c.span = round(num(c.span));
    else { delete c.loop; delete c.span; }
}

// ── edits ────────────────────────────────────────────────────────────────────

/**
 * A clip ends earlier or later; what follows moves with it. With `durations`
 * ({ file: seconds }) a film ends no later than its file does; a still has no
 * end, and neither has a clip that loops.
 */
export function trimEnd(cut, i, length, durations) {
    const next = copy(cut);
    const c = next.clips[i];
    if (!c) return next;
    c.length = Math.min(num(length, c.length), num(c.length) + outRoom(c, durations));
    return settle(next);
}

/**
 * A clip starts later (or earlier): its end stays where it was in the source.
 * `delta` is in seconds of the film. Not before the start of the source - but a
 * still has no start, so it grows as far as it is pulled.
 */
export function trimStart(cut, i, delta) {
    const next = copy(cut);
    const c = next.clips[i];
    if (!c) return next;
    headTrim(c, Math.max(-inRoom(c), Math.min(num(delta), headSpare(c))));
    return settle(next);
}

// How far (seconds of the film) a clip's end may go later: to the end of its
// source when that is known; without end for a still or a loop.
export function outRoom(c, durations) {
    if (!c || isStillClip(c) || loopOf(c)) return Infinity;
    const room = srcRoom(c, durations);
    return Number.isFinite(room) ? Math.max(0, room / speedOf(c) - num(c.length)) : Infinity;
}

// How far (seconds of the film) a clip's start may go earlier: to its source's start.
export function inRoom(c) {
    if (!c || isStillClip(c)) return Infinity;
    return num(c.in) / speedOf(c);
}

// How far a clip's start may go later: the clip keeps MIN_CLIP (and a loop one turn of it).
function headSpare(c) {
    const len = num(c.length) - MIN_CLIP;
    return loopOf(c) ? Math.min(len, num(c.span) / speedOf(c) - MIN_CLIP) : len;
}

// The start of a clip moved by `d` seconds of the film: the source moves with
// it (at its speed); a loop's turn loses what its head lost.
function headTrim(c, d) {
    if (!isStillClip(c)) {
        c.in = num(c.in) + d * speedOf(c);
        if (loopOf(c)) c.span = num(c.span) - d * speedOf(c);
    }
    c.length = num(c.length) - d;
}

/** A clip goes to another place in the order. Its dissolve stays with the join it lands on. */
export function moveClip(cut, from, to) {
    const next = copy(cut);
    const n = next.clips.length;
    if (!(from >= 0 && from < n)) return next;
    const target = Math.max(0, Math.min(n - 1, to));
    if (target === from) return next;
    const [clip] = next.clips.splice(from, 1);
    // The gap it had stays where it was (before what followed it); at its new
    // place it goes after the gap there, as an insert does.
    if (num(clip.gap) > 0 && next.clips[from]) next.clips[from].gap = num(next.clips[from].gap) + num(clip.gap);
    clip.gap = 0;
    const after = next.clips[target];
    if (after && num(after.gap) > 0) { clip.gap = after.gap; after.gap = 0; }
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
    // Before a clip that has a gap: the new one goes after the gap, where that clip began.
    const after = next.clips[at];
    const gap = after ? num(after.gap) : 0;
    if (after) after.gap = 0;
    next.clips.splice(at, 0, {
        file: String(clip.file || ""), name: String(clip.name || ""), in: Math.max(0, num(clip.in)),
        length: num(clip.length, 3), transition: 0, color: String(clip.color || ""), volume: 1, gap,
    });
    return settle(next);
}

/**
 * Where a drop at `seconds` lands on V1: inside a gap it is placed at that
 * moment (`gap`: the index of the clip after it); anywhere else it goes into the
 * order at dropIndex. { index, moment, inGap }.
 */
export function v1DropAt(cut, seconds) {
    const g = gapAt(cut, seconds);
    if (g >= 0) return { index: g, moment: round(Math.max(0, num(seconds))), inGap: true };
    const main = mainLength(cut);
    // Past the end of V1 (zoomed out, there is timeline there): at that moment, with a gap before it.
    if (num(seconds) > main + 1e-6 && (cut.clips || []).length) return { index: cut.clips.length, moment: round(num(seconds)), inGap: false, past: true };
    const index = dropIndex(cut, seconds);
    const starts = clipStarts(cut);
    return { index, moment: index < starts.length ? starts[index] : main, inGap: false };
}

/**
 * New material dropped on V1 at `seconds`: in a gap it fills the gap from that
 * moment (what does not fit pushes the clips after it on), elsewhere it is an
 * insert (insertClip). Returns { cut, i }.
 */
export function insertAt(cut, clip, seconds) {
    const place = v1DropAt(cut, seconds);
    if (place.past) {
        const next = insertClip(cut, clip, place.index);
        next.clips[place.index].gap = round(place.moment - mainLength(cut));
        return { cut: settle(next), i: place.index };
    }
    if (!place.inGap) return { cut: insertClip(cut, clip, place.index), i: place.index };
    const i = place.index;
    const gapStart = clipStarts(cut)[i] - num(cut.clips[i].gap);
    const lead = round(Math.max(0, place.moment - gapStart));
    const next = insertClip(cut, clip, i);          // after the gap, where clip i began
    const len = num(next.clips[i].length);
    next.clips[i].gap = lead;
    next.clips[i + 1].gap = round(Math.max(0, num(cut.clips[i].gap) - lead - len));
    return { cut: settle(next), i };
}

// ── tracks ───────────────────────────────────────────────────────────────────

/** A track of the cut by its id (not V1 / A1, which are the cut and its bed). */
export function trackOf(cut, id) {
    return ((cut && cut.tracks) || []).find((k) => k.id === id) || null;
}

/** A new, empty track of `kind` ("video" / "audio"), above the others of its kind. */
export function addTrack(cut, kind) {
    const next = copy(cut);
    const id = nextTrackId(next, kind);
    next.tracks.push({ id, kind: kind === "audio" ? "audio" : "video", name: id, off: false, clips: [] });
    return next;
}

/** The id the next new track of `kind` will get: V3, A2 ... */
export function nextTrackId(cut, kind) {
    const letter = kind === "audio" ? "A" : "V";
    const taken = new Set(((cut && cut.tracks) || []).map((k) => k.id));
    let n = 2;
    while (taken.has(letter + n)) n += 1;
    return letter + n;
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
                   length: num(clip.length, 3), at: Math.max(0, num(at)), color: String(clip.color || ""), volume: 1,
                   ...(clip.title ? { title: cleanTitle(clip.title) } : {}) });
    return settle(next);
}

/** A placed clip goes to another moment; nothing else moves. */
export function moveTrackClip(cut, id, i, at) {
    const next = copy(cut);
    const c = (trackOf(next, id) || { clips: [] }).clips[i];
    if (c) c.at = num(at, c.at);
    return settle(next);
}

export function trimTrackClipEnd(cut, id, i, length, durations) {
    const next = copy(cut);
    const c = (trackOf(next, id) || { clips: [] }).clips[i];
    if (c) c.length = Math.min(num(length, c.length), num(c.length) + outRoom(c, durations));
    return settle(next);
}

/** A placed clip begins later (or earlier): its end stays where it is in the film. */
export function trimTrackClipStart(cut, id, i, delta) {
    const next = copy(cut);
    const c = (trackOf(next, id) || { clips: [] }).clips[i];
    if (!c) return next;
    const d = Math.max(-Math.min(inRoom(c), num(c.at)), Math.min(num(delta), headSpare(c)));
    headTrim(c, d);
    c.at = num(c.at) + d;
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
    if (props.fx !== undefined) c.fx = cleanFx(props.fx);
    if (props.mute !== undefined) { if (props.mute) c.mute = true; else delete c.mute; }
    return next;
}

/** Change some of a clip's effect numbers ({ zx: 0.5, fh: true, ... }); the rest stay. */
export function setClipFx(cut, sel, patch) {
    const c = clipOf(cut, sel);
    return c ? setClipProps(cut, sel, { fx: { ...cleanFx(c.fx), ...patch } }) : copy(cut);
}

/** Put a section of a clip's effect ("transform" / "crop" / "composite"), or single keys, back to neutral. */
export function resetClipFx(cut, sel, what) {
    const keys = Array.isArray(what) ? what : (FX_SECTIONS[what] || []);
    const patch = {};
    for (const key of keys) patch[key] = FX[key] ? FX[key][0] : false;
    return setClipFx(cut, sel, patch);
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

// ── titles ───────────────────────────────────────────────────────────────────

export const TITLE_SECONDS = 3;

// Is track `id` empty from `at` for `length` seconds?
function trackFree(cut, id, at, length) {
    const k = trackOf(cut, id);
    if (!k || k.kind === "audio") return false;
    const a = num(at), b = a + num(length);
    return !k.clips.some((c) => num(c.at) < b - 1e-6 && num(c.at) + num(c.length) > a + 1e-6);
}

/**
 * A title of its own at `at` seconds, `length` long: on the video track `track`
 * where it is free there, else on the top video track if that is free, else on a
 * new one above it - the top layer, as a title added in an editor lands. `title`
 * is its look and words (cleanTitle). Returns { cut, sel }.
 */
export function addTitle(cut, title, at, length = TITLE_SECONDS, track = "") {
    let next = copy(cut);
    const start = round(Math.max(0, num(at)));
    const len = round(Math.max(MIN_CLIP, num(length, TITLE_SECONDS)));
    const vids = next.tracks.filter((k) => k.kind !== "audio");
    let id = track && track !== "V1" && trackFree(next, track, start, len) ? track
        : vids.length && trackFree(next, vids[vids.length - 1].id, start, len) ? vids[vids.length - 1].id : "";
    if (!id) { next = addTrack(next, "video"); id = next.tracks[next.tracks.length - 1].id; }
    const t = cleanTitle(title);
    const k = trackOf(next, id);
    k.clips.push({ file: "", name: titleName(t), in: 0, length: len, at: start, color: "", volume: 1, title: t });
    return { cut: settle(next), sel: { kind: "tclip", track: id, i: k.clips.length - 1 } };
}

/** The name a title clip shows: its first line of words. */
export function titleName(t) {
    return String((t && t.text) || "").split("\n").find((x) => x.trim()) || "Title";
}

/** Is a selection a title clip? */
export function isTitleSel(cut, s) {
    const c = s && s.kind === "tclip" ? clipOf(cut, s) : null;
    return !!(c && c.title);
}

/**
 * Change the titles of `list` (selections; the ones that are not titles are
 * left alone): `patch` is part of a title ({ bold: true }, { text }, ...). A
 * title whose name was its words takes the new first line as its name.
 */
export function setTitle(cut, list, patch) {
    const next = copy(cut);
    for (const s of [].concat(list || [])) {
        const c = s && s.kind === "tclip" ? clipOf(next, s) : null;
        if (!c || !c.title) continue;
        const was = c.title;
        c.title = cleanTitle({ ...was, ...patch });
        if (patch.text !== undefined && (!c.name || c.name === titleName(was))) c.name = titleName(c.title);
    }
    return next;
}

/** A title clip's look at clip time `u`: its keyed numbers (size, tracking, line spacing, outline) at their value there. */
export function titleAt(c, u = 0) {
    const t = cleanTitle(c && c.title);
    for (const [k, p] of Object.entries(TITLE_KEYS)) {
        const list = keysOf(c, k);
        if (list.length) { const [lo, hi] = TITLE_NUM[p].slice(1); t[p] = Math.max(lo, Math.min(hi, keyValue(list, u))); }
    }
    return t;
}

/**
 * The titles on screen at `seconds` (live tracks, not switched off), lowest
 * first: [{ clip, sel, key, origin, u, rank }] - `u` the clip's own time, `rank`
 * its track's place (V1 0, the video tracks above 1, 2, ...), the order they are
 * laid in. Two of one track at one moment: the later is on top, as for clips.
 */
export function titlesAt(cut, seconds, live) {
    const out = [];
    const t = num(seconds);
    const on = (id) => !live || live.has(id);
    const vids = ((cut && cut.tracks) || []).filter((k) => k.kind !== "audio");
    vids.forEach((k, n) => {
        if (!on(k.id)) return;
        const here = k.clips.map((c, i) => ({ c, i })).filter(({ c }) => c.title && !c.disabled
            && t >= num(c.at) - 1e-6 && t < num(c.at) + num(c.length) - 1e-6);
        here.sort((x, y) => num(x.c.at) - num(y.c.at));
        for (const { c, i } of here) {
            out.push({ clip: c, sel: { kind: "tclip", track: k.id, i }, key: `${k.id}:${i}`, origin: num(c.at), u: round(t - num(c.at)), rank: n + 1 });
        }
    });
    return out;
}

/** Where the picture pictureAt found lies in the stack of tracks (V1 0, a video track n), -1 for none. */
export function pictureRank(cut, at) {
    if (!at || !at.clip || !at.sel) return -1;
    if (at.sel.kind === "clip") return 0;
    return ((cut && cut.tracks) || []).filter((k) => k.kind !== "audio").findIndex((k) => k.id === at.sel.track) + 1;
}

/**
 * The texts of an older cut (`texts`, markers in the file) as titles: each a
 * title clip that looks as the text did, on video tracks of their own above the
 * others (as many as texts overlap); `mark` names the marker it came from, so
 * what was written into it (agentY's preset) goes with it into the file. The
 * texts' switch (off.T) is the new tracks' switch. timeline_io.editable does the
 * same when it reads a cut.
 */
export function textsToTitles(cut) {
    if (!cut || !(cut.texts || []).length) return cut;
    let next = copy(cut);
    const made = [];
    const texts = next.texts.map((t, n) => ({ t, n })).sort((a, b) => num(a.t.start) - num(b.t.start) || a.n - b.n);
    for (const { t } of texts) {
        const start = round(Math.max(0, num(t.start))), len = round(Math.max(MIN_TEXT, num(t.length)));
        let k = made.find((m) => m.end <= start + 1e-6);
        if (!k) {
            next = addTrack(next, "video");
            k = { id: next.tracks[next.tracks.length - 1].id, end: 0 };
            made.push(k);
            if (next.off && next.off.T) trackOf(next, k.id).off = true;
        }
        const title = titleFromText(t);
        trackOf(next, k.id).clips.push({ file: "", name: titleName(title), in: 0, length: len, at: start, color: "", volume: 1, title,
                                         ...(Number.isInteger(t.ref) ? { mark: t.ref } : {}) });
        k.end = start + len;
    }
    next.texts = [];
    if (next.off) delete next.off.T;
    return settle(next);
}

/**
 * Move a clip to another track (`to`: "V1" or a track's id), to the moment `at`.
 * On the cut itself it goes between the shots there; on any other track it is
 * placed at `at`. Returns { cut, sel } - the new cut and where the clip is now -
 * or null when it cannot go there (the cut's only shot cannot leave it).
 */
export function transferClip(cut, sel, to, at, opts = {}) {
    const c = clipOf(cut, sel);
    if (!c) return null;
    const from = sel.kind === "clip" ? "V1" : sel.track;
    if (from === to) return null;
    if (sel.kind === "clip" && cut.clips.length <= 1) return null;
    if (c.title && to === "V1") return null;                  // a title is laid over the cut: V2 and up
    // Off V1 a gap stays where it was (the clips after it do not move), unless
    // it is a ripple (`opts.ripple`): then they close up.
    let next = sel.kind === "clip" ? (opts.ripple ? removeClip(cut, sel.i) : liftV1(cut, sel.i))
                                   : removeTrackClip(cut, sel.track, sel.i);
    const keep = { file: c.file, name: c.name, in: c.in, length: c.length, color: c.color || "" };
    const carry = (clip) => {
        clip.volume = num(c.volume, 1); clip.fx = cleanFx(c.fx);
        if (c.speed) clip.speed = c.speed;
        if (loopOf(c)) { clip.loop = c.loop; clip.span = c.span; }
        for (const k of ["link", "unlinked", "mute", "disabled", "title", "mark"]) if (c[k] !== undefined) clip[k] = c[k];
    };
    if (to === "V1") {
        if (!opts.ripple && next.clips.length) {
            // Onto V1 it lies over what is there (an overwrite), as in Resolve.
            const clip = { ...keep, volume: 1 };
            carry(clip);
            const got = overwriteV1(next, clip, num(at));
            return { cut: got.cut, sel: { kind: "clip", i: got.i } };
        }
        const index = next.clips.length ? dropIndex(next, num(at)) : 0;
        next = insertClip(next, keep, index);
        carry(next.clips[index]);
        return { cut: settle(next), sel: { kind: "clip", i: index } };
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
    const [gone] = next.clips.splice(i, 1);
    // What follows closes up by the clip's length; a gap that was before it stays.
    if (num(gone.gap) > 0 && next.clips[i]) next.clips[i].gap = num(next.clips[i].gap) + num(gone.gap);
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

/** The source in point of a shot set, its length kept: a slip (slipClip). */
export function setClipIn(cut, i, seconds, durations) {
    const c = cut.clips[i];
    return c ? slipClip(cut, { kind: "clip", i }, num(seconds, c.in) - num(c.in), durations) : copy(cut);
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
    const dress = (c) => [String(c.color || ""), round(num(c.volume, 1)), JSON.stringify(Object.entries(cleanFx(c.fx)).sort()),
                         round(speedOf(c)), loopOf(c), loopOf(c) ? round(num(c.span)) : 0,
                         takesOf(c).length ? JSON.stringify([c.file, takesOf(c).map((t) => [t.version, !!t.active, t.file])]) : "",
                         String(c.link || ""), !!c.unlinked, !!c.mute, !!c.disabled, c.title ? JSON.stringify(cleanTitle(c.title)) : "", ...audioDress(c),
                         c.afx && c.afx.length ? JSON.stringify(cleanAfx(c.afx)) : ""];
    const key = (cut) => JSON.stringify({
        clips: ((cut && cut.clips) || []).map((c) => [Number.isInteger(c.ref) ? c.ref : c.file, c.name, round(num(c.in)), round(num(c.length)), round(num(c.transition)), round(num(c.gap)), ...dress(c)]),
        texts: ((cut && cut.texts) || []).map((t) => [Number.isInteger(t.ref) ? t.ref : "new", t.text, round(num(t.start)), round(num(t.length)), JSON.stringify(textLook(t))]),
        tracks: ((cut && cut.tracks) || []).map((k) => [k.kind, k.name, !!k.off, !!k.lock, k.auto !== false, JSON.stringify(cleanAfx(k.afx)), (k.clips || []).map((c) =>
            [Array.isArray(c.ref) ? c.ref.join(":") : c.title ? "title" : c.file, c.name, round(num(c.at)), round(num(c.in)), round(num(c.length)), ...dress(c)])]),
        sound: ((cut && cut.sound) || []).map((s) => [String(s.file || s.name || ""), round(num(s.fadeIn)), round(num(s.fadeOut))]),
        off: [!!(cut && cut.off && cut.off.V1), !!(cut && cut.off && cut.off.A1), !!(cut && cut.off && cut.off.T)],
        flags: ["V1", "A1", "T"].map((id) => [!!(cut && cut.lock && cut.lock[id]), !(cut && cut.auto && cut.auto[id] === false)]),
        afx: JSON.stringify(cleanAfx(cut && cut.afx && cut.afx.A1)),
    });
    return key(a) === key(b);
}

// A clip's speed and loop as they are saved: always stated, so that a speed or
// a loop taken off is taken off in the file too.
function timeOf(c) {
    return { speed: round(speedOf(c)), loop: loopOf(c), span: loopOf(c) ? round(num(c.span)) : 0,
             link: c.link || "", unlinked: !!(c.link && c.unlinked), mute: !!c.mute, disabled: !!c.disabled,
             fadeIn: round(num(c.fadeIn)), fadeOut: round(num(c.fadeOut)), xfade: c.xfade ? cleanXfade(c.xfade) : null,
             afx: cleanAfx(c.afx) };
}

/** What is sent back to be saved: the cut, and nothing the server did not send. */
export function toSave(cut) {
    return {
        // A clip with no `ref` is new material and is named by its file instead.
        clips: cut.clips.map((c) => ({
            ...(Number.isInteger(c.ref) ? { ref: c.ref } : { file: c.file }),
            name: c.name, in: c.in, length: c.length, transition: c.transition, gap: round(num(c.gap)),
            color: c.color || "", volume: num(c.volume, 1), fx: cleanFx(c.fx), ...timeOf(c),
            ...(takesOf(c).length ? { takes: cleanTakes(c.takes) } : {}),
        })),
        // A text with no `ref` was written here.
        texts: cut.texts.map((t) => ({ ...(Number.isInteger(t.ref) ? { ref: t.ref } : {}),
                                       text: t.text, start: t.start, length: t.length, ...textLook(t) })),
        tracks: (cut.tracks || []).map((k) => ({
            id: k.id, kind: k.kind, name: k.name, off: !!k.off, lock: !!k.lock, auto: k.auto !== false, afx: cleanAfx(k.afx),
            clips: (k.clips || []).map((c) => ({
                // A title has no file: a new one is named by its words, and by the marker it came from (`mark`).
                ...(Array.isArray(c.ref) ? { ref: c.ref } : c.title ? (Number.isInteger(c.mark) ? { mark: c.mark } : {}) : { file: c.file }),
                ...(c.title ? { title: cleanTitle(c.title) } : {}),
                name: c.name, at: c.at, in: c.in, length: c.length, color: c.color || "", volume: num(c.volume, 1),
                fx: cleanFx(c.fx), ...timeOf(c), ...(takesOf(c).length ? { takes: cleanTakes(c.takes) } : {}),
            })),
        })),
        // The bed's clips that are left (one deleted in the panel goes from the file too).
        sound: (cut.sound || []).map((s) => ({ name: s.name || "", file: s.file || "", fadeIn: round(num(s.fadeIn)), fadeOut: round(num(s.fadeOut)) })),
        off: { V1: !!(cut.off && cut.off.V1), A1: !!(cut.off && cut.off.A1), T: !!(cut.off && cut.off.T) },
        lock: Object.fromEntries(["V1", "A1", "T"].map((id) => [id, !!(cut.lock && cut.lock[id])])),
        auto: Object.fromEntries(["V1", "A1", "T"].map((id) => [id, !(cut.auto && cut.auto[id] === false)])),
        afx: { A1: cleanAfx(cut.afx && cut.afx.A1) },
    };
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** Where everything sits, as percentages of the film's length. */
export function layoutCut(cut, density = 1, span = 0) {
    // `span`: the seconds the whole width stands for (viewSpan: past the film's end when zoomed out). `film`: the film's own length.
    const film = filmLength(cut);
    const total = num(span) > 0 ? num(span) : film;
    const empty = { total, film, shots: [], mixes: [], gaps: [], texts: [], sound: [], tracks: [], ticks: [] };
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
        late: num(t.start) + num(t.length) > film + 0.02,          // runs past the end of the film
    }));
    const sound = (cut.sound || []).map((s) => ({ left: 0, width: pct((film / total) * 100), name: s.name || base(s.file),
                                                  title: `sound under the film: ${s.name || s.file}` }));
    const tracks = (cut.tracks || []).map((k) => ({
        id: k.id, kind: k.kind, name: k.name || k.id, off: !!k.off,
        items: (k.clips || []).map((c, i) => {
            const file = base(c.file);
            if (c.title) {
                return { ...place(num(c.at), num(c.length)), i, start: num(c.at), length: num(c.length), color: c.color || "", isTitle: true,
                         name: c.name || titleName(c.title),
                         title: `Title "${String(c.title.text || "").replace(/\n/g, " / ")}" (${c.title.font}), ${lengthLabel(c.length)} at ${lengthLabel(c.at)}` };
            }
            return { ...place(num(c.at), num(c.length)), i, start: num(c.at), length: num(c.length), color: c.color || "",
                     name: c.name || file || "clip " + (i + 1),
                     title: `${c.name || file} — ${lengthLabel(c.length)} at ${lengthLabel(c.at)}, from ${lengthLabel(c.in)} of the source`
                         + (file && file !== c.name ? `\n${c.file}` : "") };
        }),
    }));
    const gaps = v1Gaps(cut).map((g) => ({ ...place(g.start, g.length), ...g,
        title: `Gap, ${lengthLabel(g.length)} - nothing of the cut plays here. Del or Shift+Del closes it (the clips after it move up)` }));
    return { total, film, shots, mixes, gaps, texts, sound, tracks, ticks: ticks(total, density) };
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
    let i = -1;
    for (let k = 0; k < starts.length; k++) if (t >= starts[k] - 1e-6) i = k;
    if (i < 0) return null;                                       // a gap before the first clip
    const own = starts[i] + num(clips[i].length);
    if (t >= own - 1e-6) return null;                             // a gap after clip i
    const end = i + 1 < starts.length ? Math.min(starts[i + 1], own) : own;
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
 *
 * A clip on a higher track that does not cover the frame as it comes - scaled,
 * moved, cropped, translucent (clipFx) - has what is beneath it as `under` too,
 * with `over: true` and no `mix`: the picture is `under` with `clip` over it.
 * (One picture beneath is all the player draws; the render draws them all.)
 */
export function pictureAt(cut, seconds, live) {
    const total = filmLength(cut);
    if (!cut || !(total > 0)) return null;
    const t = Math.max(0, Math.min(num(seconds), Math.max(0, total - 1e-4)));
    const on = (id) => !live || live.has(id);
    let found = null;
    let next = total;                       // the first moment after t at which something may change
    const tracks = (cut.tracks || []).filter((k) => k.kind !== "audio" && on(k.id));
    const stack = [];                       // what has a picture here, from the top down
    for (let n = tracks.length - 1; n >= 0; n--) {
        const k = tracks[n];
        k.clips.forEach((c, i) => {
            const a = num(c.at), b = a + num(c.length);
            if (c.disabled || c.title) return;      // a disabled clip is not there: what is under it shows; a title is laid over (titlesAt)
            if (a > t + 1e-6) next = Math.min(next, a);
            if (!(t >= a - 1e-6 && t < b - 1e-6)) return;
            next = Math.min(next, b);
            // Two clips of one track at one moment: the one that begins later is on top.
            const later = k.clips.some((o, j) => j !== i && !o.disabled && !o.title && num(o.at) > a && t >= num(o.at) - 1e-6 && t < num(o.at) + num(o.length) - 1e-6);
            if (later) return;
            stack.push({ clip: c, key: `${k.id}:${i}`, sel: { kind: "tclip", track: k.id, i }, origin: a, end: b });
        });
    }
    let main = null;
    if (on("V1") && t < mainLength(cut) - 1e-6) {
        const at = playAt(cut, t);
        // In a gap of V1 nothing of the cut is there until the next clip begins.
        if (!at) for (const s of clipStarts(cut)) if (s > t + 1e-6) { next = Math.min(next, s); break; }
        if (at) {
            main = { clip: cut.clips[at.i], key: `V1:${at.i}`, sel: { kind: "clip", i: at.i }, origin: at.start, end: at.end };
            const mixLen = at.i > 0 ? num(cut.clips[at.i].transition) : 0;
            if (mixLen > 0 && t < at.start + mixLen - 1e-6) {
                const before = cut.clips[at.i - 1];
                const began = clipStarts(cut)[at.i - 1];
                main.under = { clip: before, key: `V1:${at.i - 1}`, origin: began, local: srcLocal(before, t - began) };
                main.mix = Math.max(0, Math.min(1, (t - at.start) / mixLen));
                main.mixStart = at.start;
                main.mixLen = mixLen;
                main.dissolveEnd = at.start + mixLen;
            }
            // A disabled shot is a gap (timeline_render.read_cut makes it a blank): in its dissolve the shot going
            // out is shown on its own; a dissolve out of a disabled shot is the shot coming in, on its own.
            const before = main.under ? main.under.clip : null;
            if (cut.clips[at.i].disabled) {
                if (main.under && !before.disabled) {
                    const began = clipStarts(cut)[at.i - 1];
                    main = { clip: before, key: `V1:${at.i - 1}`, sel: { kind: "clip", i: at.i - 1 }, origin: began, end: main.dissolveEnd };
                } else {
                    next = Math.min(next, main.dissolveEnd || at.end);
                    main = null;
                }
            } else if (main.under && before.disabled) {
                delete main.under; delete main.mix; delete main.mixStart; delete main.mixLen;
            }
            if (main) stack.push(main);
        }
    }
    found = stack[0] || null;
    if (found === main && main && main.dissolveEnd) next = Math.min(next, main.dissolveEnd);   // the moment the dissolve is over
    if (found && found !== main && clipFx(found.clip, t - found.origin) && stack[1]) {
        // It does not cover the frame: what is beneath it shows.
        const b = stack[1];
        found.under = { clip: b.clip, key: b.key, origin: b.origin, local: srcLocal(b.clip, t - b.origin) };
        found.over = true;
        next = Math.min(next, b.end);
    }
    if (!found) found = { clip: null, key: "", sel: null, origin: t, end: total };
    found.t = t;
    found.end = Math.max(t + 1e-4, Math.min(found.end, next));
    found.local = found.clip ? srcLocal(found.clip, t - found.origin) : 0;
    // The stretch the player runs without a jump: to the end of a loop's turn,
    // at the clip's speed (`segAt` the moment it began, `base` its source then).
    const seg = found.clip ? clipSegment(found.clip, t - found.origin) : null;
    if (seg) {
        found.segAt = found.origin + seg.u0;
        found.base = seg.base;
        found.rev = seg.rev;
        found.speed = seg.speed;
        found.end = Math.max(t + 1e-4, Math.min(found.end, found.origin + seg.u1));
    }
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
    // `origin`: the moment of the film at which the clip's own time is 0 (a crossfade's handle starts before it);
    // `env`: its fades and crossfades (audioEnv / envGain).
    if (on("A1")) for (const s of (cut && cut.sound) || []) {
        if (s && s.file) out.push({ file: s.file, at: 0, origin: 0, in: 0, length: total, volume: 1, track: "A1",
                                    env: { len: total, fi: num(s.fadeIn), fo: num(s.fadeOut), xin: null, xout: null } });
    }
    for (const k of (cut && cut.tracks) || []) {
        if (k.kind !== "audio" || !on(k.id)) continue;
        (k.clips || []).forEach((c, i) => {
            if (!c.file || c.disabled) return;
            const env = audioEnv(cut, { kind: "tclip", track: k.id, i });
            const pre = env.xin ? env.xin.b : 0, post = env.xout ? env.xout.a : 0;
            out.push({ file: c.file, at: round(num(c.at) - pre), origin: num(c.at), in: num(c.in), length: round(num(c.length) + pre + post),
                       volume: num(c.volume, 1), clip: c, env, track: k.id });
        });
    }
    // The handles of V1's crossfades: the film's sound before its cut (coming in) and after it (going out),
    // which its <video> does not play - the picture cuts there.
    if (on("V1")) {
        const starts = clipStarts(cut);
        ((cut && cut.clips) || []).forEach((c, i) => {
            if (!c.xfade || !xfadeFrom(cut, { kind: "clip", i })) return;
            const o = cut.clips[i - 1];
            const s = xfadeSides(c.xfade);
            if (s.b > 0 && v1Sounds(c)) {
                out.push({ file: c.file, at: round(starts[i] - s.b), origin: starts[i], in: num(c.in), length: s.b, volume: num(c.volume, 1),
                           clip: c, env: audioEnv(cut, { kind: "clip", i }), track: "V1", handle: "in" });
            }
            if (s.a > 0 && v1Sounds(o)) {
                out.push({ file: o.file, at: round(starts[i - 1] + num(o.length)), origin: starts[i - 1], in: num(o.in), length: s.a,
                           volume: num(o.volume, 1), clip: o, env: audioEnv(cut, { kind: "clip", i: i - 1 }), track: "V1", handle: "out" });
            }
        });
    }
    return out;
}

// A shot of V1 that sounds: a film, not switched off, its sound not split off.
function v1Sounds(c) {
    return !!c && !c.disabled && !c.mute && !isStillImage(c.file) && !isStill(c.file) && num(c.volume, 1) + (hasKeys(c) ? 1 : 0) > 0;
}

/** Is a clip's file a picture (shown for the clip's length) rather than a film? */
export function isStill(file) {
    return !/\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(String(file || ""));
}

// ── cutting ──────────────────────────────────────────────────────────────────

/**
 * Cut one clip in two at `seconds` (a moment of the FILM): the blade. On the cut
 * itself (V1) the halves stay where the clip was, one after the other, and no
 * dissolve is made between them; on another track both halves stay placed.
 * Each half keeps everything the clip carried - its `ref` too, so what another
 * program wrote into the clip survives in both (timeline_io.rebuild copies the
 * item it names). Returns { cut, sel } - `sel` the second half - or null where
 * no cut can be made: too near an end, or inside a dissolve.
 */
export function splitClip(cut, sel, seconds) {
    const c = clipOf(cut, sel);
    if (!c) return null;
    const t = num(seconds);
    const next = copy(cut);
    if (sel.kind === "clip") {
        const i = sel.i;
        const start = clipStarts(cut)[i];
        if (loopOf(c)) return null;                  // a loop is not cut: take its loop off first
        const local = round(t - start);
        const own = num(c.transition);
        const following = next.clips[i + 1] ? num(next.clips[i + 1].transition) : 0;
        const low = own > 0 ? own + MIX_MARGIN : MIN_CLIP;
        const high = num(c.length) - (following > 0 ? following + MIX_MARGIN : MIN_CLIP);
        if (local < low - 1e-6 || local > high + 1e-6) return null;
        const a = next.clips[i];
        const b = { ...a, in: round(num(a.in) + local * speedOf(a)), length: round(num(a.length) - local), transition: 0 };
        delete b.gap;
        delete b.uid;                                // a piece of its own (undo finds each by its uid)
        delete b.link; delete b.unlinked;            // splitWithLink pairs it again
        if (a.fx) [a.fx, b.fx] = splitFx(a.fx, local);
        if (a.afx) b.afx = shiftAfx(a.afx, -local);
        a.length = local;
        next.clips.splice(i + 1, 0, b);
        return { cut: settle(next), sel: { kind: "clip", i: i + 1 } };
    }
    if (sel.kind === "tclip") {
        const k = trackOf(next, sel.track);
        const a = k.clips[sel.i];
        if (loopOf(a)) return null;
        const local = round(t - num(a.at));
        if (local < MIN_CLIP - 1e-6 || local > num(a.length) - MIN_CLIP + 1e-6) return null;
        const b = { ...a, at: round(num(a.at) + local), in: round(num(a.in) + local * speedOf(a)), length: round(num(a.length) - local) };
        delete b.uid;
        delete b.link; delete b.unlinked;
        if (a.fx) [a.fx, b.fx] = splitFx(a.fx, local);
        if (a.afx) b.afx = shiftAfx(a.afx, -local);
        a.length = local;
        k.clips.splice(sel.i + 1, 0, b);
        return { cut: settle(next), sel: { kind: "tclip", track: sel.track, i: sel.i + 1 } };
    }
    return null;
}

/** Every clip (V1 and the tracks) that has the moment `seconds` inside it, as selections. */
export function clipsAt(cut, seconds) {
    const t = num(seconds);
    const out = [];
    const starts = clipStarts(cut);
    ((cut && cut.clips) || []).forEach((c, i) => {
        if (t > starts[i] + 1e-6 && t < starts[i] + num(c.length) - 1e-6) out.push({ kind: "clip", i });
    });
    for (const k of (cut && cut.tracks) || []) {
        (k.clips || []).forEach((c, i) => {
            if (t > num(c.at) + 1e-6 && t < num(c.at) + num(c.length) - 1e-6) out.push({ kind: "tclip", track: k.id, i });
        });
    }
    return out;
}

/**
 * "Split at playhead": the selected clip when the playhead is on it; with no
 * such selection, every clip there - the shot of the cut and the clips of the
 * other tracks, as an editor cuts every track under the playhead. In a
 * dissolve the shot coming in is the one cut. Returns { cut, sel, count } or
 * null when nothing could be cut.
 */
export function splitAt(cut, seconds, sel, mask) {
    // `mask` (editMask): with no selected clip there, only the tracks whose Auto Track Selector is on (and unlocked).
    let here = clipsAt(cut, seconds).filter((s) => !mask || mask.has(s.kind === "clip" ? "V1" : s.track) || sameSel(s, sel));
    // Inside a dissolve two shots of V1 share the moment: the one coming in is cut.
    const shots = here.filter((s) => s.kind === "clip");
    if (shots.length > 1) here = here.filter((s) => s.kind !== "clip" || s.i === shots[shots.length - 1].i);
    const same = (a, b) => a && b && a.kind === b.kind && a.i === b.i && (a.kind !== "tclip" || a.track === b.track);
    let targets = here;
    if (sel && here.some((s) => same(s, sel))) targets = [sel];
    let next = cut, last = null, count = 0;
    // Later clips first, so the indices of the earlier ones do not move.
    for (const s of [...targets].sort((a, b) => b.i - a.i)) {
        const got = splitWithLink(next, s, seconds);
        if (!got) continue;
        next = got.cut;
        count += 1;
        if (!last || s.kind === "clip") last = got.sel;
    }
    return count ? { cut: next, sel: last, count } : null;
}

/**
 * Delete, leaving the place empty (Resolve's Delete, a "lift"): a gap stays
 * where the clip was and nothing moves - on V1 as on every other track. A gap
 * selected ({ kind: "gap", i }) is closed.
 */
export function liftClip(cut, sel) {
    if (!sel) return copy(cut);
    if (sel.kind === "tclip") return removeTrackClip(cut, sel.track, sel.i);
    if (sel.kind === "text") return removeText(cut, sel.i);
    if (sel.kind === "mix") return setTransition(cut, sel.i, 0);
    if (sel.kind === "gap") return closeGap(cut, sel.i);
    return liftV1(cut, sel.i);
}

// The time of the end of V1's clip j, as the cut stands.
function clipEnd(cut, j) {
    return clipStarts(cut)[j] + num(cut.clips[j].length);
}

// Clip j of V1 made to begin at the moment `at`: the time between it and the
// clip before becomes its gap - or, where they would overlap, its dissolve.
// What follows clip j is placed relative to its end, so it moves only if that
// end moves.
function restart(cut, j, at) {
    const c = cut.clips[j];
    if (!c) return;
    const d = round(num(at) - (j ? clipEnd(cut, j - 1) : 0));
    if (d >= 0) { c.gap = d; c.transition = 0; } else { c.gap = 0; c.transition = -d; }
}

/** V1's clip i taken out, its place left empty: the clips after it stay where they are. The last clip stays. */
export function liftV1(cut, i) {
    const next = copy(cut);
    if (next.clips.length <= 1 || !next.clips[i]) return next;
    const starts = clipStarts(cut);
    next.clips.splice(i, 1);
    if (next.clips[i]) restart(next, i, starts[i + 1]);
    return settle(next);
}

/** The gap before V1's clip i closed: it and everything after it move up (a ripple delete of the gap). */
export function closeGap(cut, i) {
    const next = copy(cut);
    if (next.clips[i]) next.clips[i].gap = 0;
    return settle(next);
}

/** Delete and close the gap (Shift+Del): on V1 what follows moves up (and on the tracks in `mask`); on a track the clips after it move up by its length. */
export function rippleDelete(cut, sel, mask) {
    if (sel && sel.kind === "clip") return rippleV1Remove(cut, sel.i, mask);
    if (!sel || sel.kind !== "tclip") return liftClip(cut, sel);
    const next = copy(cut);
    const k = trackOf(next, sel.track);
    const gone = k && k.clips[sel.i];
    if (!gone) return next;
    const end = num(gone.at) + num(gone.length);
    k.clips.splice(sel.i, 1);
    for (const c of k.clips) if (num(c.at) >= end - 1e-6) c.at = round(num(c.at) - num(gone.length));
    return settle(next);
}

/** The moments where something begins or ends: the edit points (for snapping and Up / Down). */
export function editPoints(cut, mask) {
    // `mask`: only the tracks whose Auto Track Selector is on (Up / Down, as Resolve's).
    const on = (id) => !mask || mask.has(id);
    const out = new Set([0]);
    const starts = clipStarts(cut);
    if (on("V1")) ((cut && cut.clips) || []).forEach((c, i) => { out.add(round(starts[i])); out.add(round(starts[i] + num(c.length))); });
    for (const k of (cut && cut.tracks) || []) {
        if (on(k.id)) for (const c of k.clips || []) { out.add(round(num(c.at))); out.add(round(num(c.at) + num(c.length))); }
    }
    if (on("T")) for (const t of (cut && cut.texts) || []) { out.add(round(num(t.start))); out.add(round(num(t.start) + num(t.length))); }
    return [...out].sort((a, b) => a - b);
}

/** `seconds` moved onto the nearest of `points` when one is within `tolerance`; else as it is. */
export function snapTime(seconds, points, tolerance) {
    const t = num(seconds);
    let best = t, gap = num(tolerance);
    for (const p of points || []) {
        const d = Math.abs(num(p) - t);
        if (d <= gap) { best = num(p); gap = d; }
    }
    return best;
}

// ── undo ─────────────────────────────────────────────────────────────────────
//
// A history of cuts: { past: [cut...], future: [cut...] }. Every edit returns a
// new cut and leaves the old one alone, so keeping the old ones IS the undo.

export const UNDO_DEPTH = 200;

export function emptyHistory() { return { past: [], future: [] }; }

/** `before` was the cut until an edit made another: it goes on the stack, and redo is gone. */
export function historyPush(h, before, depth = UNDO_DEPTH) {
    const past = [...((h && h.past) || []), before];
    return { past: past.slice(Math.max(0, past.length - depth)), future: [] };
}

/** { history, cut }: one step back from `now`; null when there is nothing to undo. */
export function historyUndo(h, now) {
    if (!h || !h.past.length) return null;
    return { history: { past: h.past.slice(0, -1), future: [now, ...h.future] }, cut: h.past[h.past.length - 1] };
}

/** { history, cut }: the step undone last, again; null when there is none. */
export function historyRedo(h, now) {
    if (!h || !h.future.length) return null;
    return { history: { past: [...h.past, now], future: h.future.slice(1) }, cut: h.future[0] };
}

// ── auto edit ────────────────────────────────────────────────────────────────
//
// The deterministic modes of the Auto edit dialog. Each works on the shots of
// the cut itself (V1) - all of them, or those in `opts.indices` - and returns a
// new cut, which the panel applies as one step. `opts.durations` is
// { file: seconds } where a file's length is known: a shot is never made longer
// than its file has from its in point (a still has no end). agentY's
// edit_timeline `rhythm` / `snap` / `fit` are the same arithmetic.

const inScope = (cut, opts) => {
    const n = ((cut && cut.clips) || []).length;
    const want = opts && Array.isArray(opts.indices) && opts.indices.length ? new Set(opts.indices) : null;
    return (i) => i >= 0 && i < n && (!want || want.has(i));
};

/** How long a clip could be from its in point: to the end of its file, when that is known. */
export function room(clip, durations) {
    if (isStill(clip && clip.file)) return Infinity;
    const known = num(durations && durations[clip.file], 0);
    return known > 0 ? Math.max(MIN_CLIP, known - num(clip.in)) : Infinity;
}

/** The beats of a sound as moments of the FILM: `source` is where the sound lies ({ at, in, length }). */
export function beatsInFilm(beats, source = {}) {
    const at = num(source.at), from = num(source.in), len = source.length == null ? Infinity : num(source.length);
    return (beats || []).map((b) => round(at + num(b) - from)).filter((t) => t >= at - 1e-6 && t <= at + len + 1e-6);
}

/** Every `every`-th of `beats`, from the first. */
export function everyNth(beats, every = 1) {
    const n = Math.max(1, Math.round(num(every, 1)));
    return (beats || []).filter((_, i) => i % n === 0);
}

/**
 * Move each cut to the nearest beat within `within` seconds (agentY's `snap`):
 * from the first cut to the last, by making the shot before the cut longer or
 * shorter, so later cuts are measured from where the earlier ones ended up. A
 * cut with no beat near it stays. With `indices`, only the cuts after those shots.
 */
export function snapCutsToBeats(cut, beats, opts = {}) {
    const marks = [...(beats || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const next = copy(cut);
    if (!marks.length) return next;
    const within = num(opts.within, 0.5);
    const mine = inScope(cut, opts);
    let at = 0;
    next.clips.forEach((c, i) => {
        at += num(c.gap);
        if (i) at -= num(c.transition);
        let end = at + num(c.length);
        if (i + 1 < next.clips.length && mine(i)) {
            const near = marks.reduce((best, m) => (Math.abs(m - end) < Math.abs(best - end) ? m : best), marks[0]);
            const length = near - at;
            const spare = num(next.clips[i + 1].transition) + MIX_MARGIN;
            if (Math.abs(near - end) <= within + 1e-9 && length >= Math.max(MIN_CLIP, spare)
                && length <= room(c, opts.durations) + 1e-9) {
                c.length = round(length);
                end = near;
            }
        }
        at = end;
    });
    return settle(next);
}

/**
 * Cut on the beat: each shot lasts `every` beats, so every cut lands on one.
 * A shot whose file is too short for that many ends on the last beat it can
 * reach; past the last beat, or with none in reach, a shot keeps its length.
 */
export function cutOnBeats(cut, beats, opts = {}) {
    const marks = [...(beats || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const next = copy(cut);
    if (!marks.length) return next;
    const every = Math.max(1, Math.round(num(opts.every, 1)));
    const mine = inScope(cut, opts);
    let at = 0;
    next.clips.forEach((c, i) => {
        at += num(c.gap);
        if (i) at -= num(c.transition);
        if (mine(i)) {
            const spare = Math.max(MIN_CLIP, num(c.transition) + MIX_MARGIN,
                                   next.clips[i + 1] ? num(next.clips[i + 1].transition) + MIX_MARGIN : 0);
            const ahead = marks.filter((m) => m >= at + spare - 1e-6);
            const reach = room(c, opts.durations);
            let pick = ahead[every - 1];
            if (pick === undefined || pick - at > reach + 1e-9) {
                const fits = ahead.slice(0, every).filter((m) => m - at <= reach + 1e-9);
                pick = fits.length ? fits[fits.length - 1] : undefined;
            }
            if (pick !== undefined) c.length = round(pick - at);
        }
        at += num(c.length);
    });
    return settle(next);
}

/** An even rhythm: every shot `seconds` long (or as long as its file allows). */
export function evenRhythm(cut, seconds, opts = {}) {
    const next = copy(cut);
    const len = Math.max(MIN_CLIP, num(seconds, 2));
    const mine = inScope(cut, opts);
    next.clips.forEach((c, i) => { if (mine(i)) c.length = round(Math.min(len, room(c, opts.durations))); });
    return settle(next);
}

/**
 * The cut made `seconds` long by giving the shots in scope one share of their
 * length each (agentY's `fit`), as far as their files and MIN_CLIP allow; the
 * shots out of scope and the dissolves stay as they are.
 */
export function fitLength(cut, seconds, opts = {}) {
    let next = copy(cut);
    const mine = inScope(cut, opts);
    const target = Math.max(MIN_CLIP, num(seconds));
    for (let pass = 0; pass < 8; pass++) {
        const total = mainLength(next);
        if (Math.abs(total - target) < 1e-3) break;
        const free = next.clips.filter((c, i) => mine(i) && (total > target ? num(c.length) > MIN_CLIP + 1e-6
                                                                            : num(c.length) < room(c, opts.durations) - 1e-6));
        const flexible = free.reduce((s, c) => s + num(c.length), 0);
        if (!(flexible > 0)) break;
        const share = (flexible + (target - total)) / flexible;
        for (const c of free) c.length = Math.max(MIN_CLIP, Math.min(room(c, opts.durations), num(c.length) * share));
        next = settle(next);
    }
    return next;
}

/**
 * The shot lengths of another film (agentY's `rhythm`): the shots in scope
 * take them in order, the pattern repeating; a shot too short for its slot
 * keeps all it has.
 */
export function rhythmFrom(cut, lengths, opts = {}) {
    const pattern = (lengths || []).map(Number).filter((v) => Number.isFinite(v) && v >= MIN_CLIP);
    const next = copy(cut);
    if (!pattern.length) return next;
    const mine = inScope(cut, opts);
    let k = 0;
    next.clips.forEach((c, i) => {
        if (!mine(i)) return;
        c.length = round(Math.min(pattern[k % pattern.length], room(c, opts.durations)));
        k += 1;
    });
    return settle(next);
}

/**
 * Each shot trimmed to its middle: `head` and `tail` (fractions, 0..0.45) of
 * its length taken off its start and its end - the first and last moments of a
 * generated clip are the ones most often wrong. Stills are left alone.
 */
export function bestPart(cut, opts = {}) {
    const head = Math.max(0, Math.min(0.45, num(opts.head, 0.1)));
    const tail = Math.max(0, Math.min(0.45, num(opts.tail, 0.1)));
    const next = copy(cut);
    const mine = inScope(cut, opts);
    next.clips.forEach((c, i) => {
        if (!mine(i) || isStill(c.file)) return;
        const len = num(c.length);
        const keep = Math.max(MIN_CLIP, len * (1 - head - tail));
        if (keep >= len - 1e-6) return;
        c.in = round(num(c.in) + len * head);
        c.length = round(keep);
    });
    return settle(next);
}

/** What an edit changed, in a few words: { lines: [...], changed } (changed: how many shots). */
export function describeChanges(before, after) {
    const a = (before && before.clips) || [], b = (after && after.clips) || [];
    const lines = [];
    let changed = 0, moved = 0;
    if (a.length === b.length) {
        const sa = clipStarts(before), sb = clipStarts(after);
        for (let i = 0; i < a.length; i++) {
            if (Math.abs(num(a[i].length) - num(b[i].length)) > 1e-3 || Math.abs(num(a[i].in) - num(b[i].in)) > 1e-3
                || String(a[i].file || "") !== String(b[i].file || "")) changed += 1;
            if (i + 1 < a.length && Math.abs(sa[i + 1] - sb[i + 1]) > 1e-3) moved += 1;
        }
        if (changed) lines.push(`${changed} shot${changed === 1 ? "" : "s"} changed`);
        if (moved) lines.push(`${moved} cut${moved === 1 ? "" : "s"} moved`);
    } else {
        lines.push(`${a.length} shot${a.length === 1 ? "" : "s"} became ${b.length}`);
        changed = Math.abs(a.length - b.length);
    }
    const ta = ((before && before.texts) || []).length, tb = ((after && after.texts) || []).length;
    if (ta !== tb) lines.push(`${ta} text${ta === 1 ? "" : "s"} became ${tb}`);
    const la = mainLength(before), lb = mainLength(after);
    if (Math.abs(la - lb) > 1e-3) lines.push(`the film ${lengthLabel(la)} → ${lengthLabel(lb)}`);
    if (!lines.length) lines.push("nothing changed");
    return { lines, changed };
}

/**
 * A cut read from another file, made one this file can hold: no item names a
 * place in the file it came from (`ref`), so each is saved by its `file`.
 */
export function detach(cut) {
    const next = copy(cut);
    for (const c of next.clips) delete c.ref;
    for (const t of next.texts) delete t.ref;
    for (const k of next.tracks) for (const c of k.clips) delete c.ref;
    return next;
}

/** What a cut holds that agentY's edit stage does not read back: the warning of "Ask agentY". */
export function agentLoses(cut) {
    const out = [];
    if (((cut && cut.tracks) || []).some((k) => (k.clips || []).length)) out.push("the clips on tracks other than V1 and A1");
    if (((cut && cut.clips) || []).some((c) => num(c.gap) > 0)) out.push("the gaps on V1 (closed up: the clips after one move up)");
    if (((cut && cut.clips) || []).some((c) => c.mute)) out.push("sound split off its picture (heard with its picture again, J/L offsets lost)");
    if (((cut && cut.clips) || []).some((c) => c.disabled)) out.push("disabled clips (agentY plays them)");
    const anyKeys = [...((cut && cut.clips) || []), ...(((cut && cut.tracks) || []).flatMap((k) => k.clips || []))].some((c) => hasKeys(c));
    if (anyKeys) out.push("keyframes (agentY plays the clips without them)");
    const all = [...((cut && cut.clips) || []), ...((cut && cut.tracks) || []).flatMap((k) => k.clips || [])];
    if (all.some((c) => Object.keys(cleanFx(c.fx)).length)) out.push("transforms, crops and opacity (the Inspector's Video tab)");
    if (all.some((c) => speedOf(c) !== 1)) out.push("speed changes (retimed clips come back at 100 %)");
    if (all.some((c) => loopOf(c))) out.push("loops (a looped clip comes back played once)");
    const plain = JSON.stringify(textLook({}));
    if (((cut && cut.texts) || []).some((t) => JSON.stringify(textLook(t)) !== plain)) out.push("how the texts look (size, place, colour)");
    if (all.some((c) => c.title)) out.push("how the titles look (font, style, alignment, outline, shadow, box: agentY draws them as captions or by their preset)");
    if (all.some((c) => c.xfade || num(c.fadeIn) > 0 || num(c.fadeOut) > 0)) out.push("audio crossfades and fades");
    if (cutHasAfx(cut)) out.push("sound effects (EQ, compressor, reverb ... of clips and tracks)");
    return out;
}

// ── scene cut detection ──────────────────────────────────────────────────────

/**
 * The detected cuts of a clip's file (/imageviewer/timeline_cuts) that the clip
 * shows: inside its in..out (a frame from either end, so no sliver is left),
 * and kept at `sensitivity` (0..1: higher finds softer cuts). Each as
 * { t (the moment of the FILM), src (of the file), kind, score }. `start` is
 * where the clip begins in the film.
 */
export function cutMarks(cuts, clip, start, sensitivity = 0.5, fps = 24) {
    const from = num(clip && clip.in), len = srcUse(clip), sp = speedOf(clip);
    const edge = Math.max(MIN_CLIP, 1 / (num(fps) > 0 ? num(fps) : 24));
    const need = cutThreshold(sensitivity);
    return (cuts || [])
        .filter((c) => num(c.ratio) >= 2.5 && num(c.score) >= need)
        .filter((c) => num(c.t) > from + edge - 1e-6 && num(c.t) < from + len - edge + 1e-6)
        .map((c) => ({ t: toFrame(num(start) + (num(c.t) - from) / sp, fps), src: num(c.t), kind: c.kind || "cut", score: num(c.score) }));
}

/** The scene score a cut must reach at `sensitivity` (0..1): 0 asks 0.4, 0.5 asks 0.1, 1 asks 0.025. */
export function cutThreshold(sensitivity) {
    const s = Math.max(0, Math.min(1, num(sensitivity, 0.5)));
    return round(0.4 * Math.pow(0.25, s * 2));
}

/**
 * One clip cut at several moments of the film at once ("Split at all"):
 * from the last moment to the first, so the clip that is cut is always the
 * same one. Moments it cannot be cut at (too near an end, in a dissolve) are
 * passed over. Returns { cut, count }.
 */
export function splitAtMany(cut, sel, moments) {
    let next = cut, count = 0;
    for (const t of [...new Set((moments || []).map(Number))].sort((a, b) => b - a)) {
        const got = splitWithLink(next, sel, t);
        if (!got) continue;
        next = got.cut;
        count += 1;
    }
    return { cut: next, count };
}

// ── time: speed and loops ────────────────────────────────────────────────────
//
// A clip may play at a SPEED other than its own (`speed`, 0.1 .. 10; "trim to
// fill" / retime): its source in and out stay, and on the timeline it lasts the
// source it uses divided by the speed. And it may LOOP (`loop`: "loop" or
// "pingpong", `span`: the seconds of source one turn takes): past one turn the
// source starts again from the in point - or, ping-pong, runs back to it. A
// looped clip that is retimed loops the retimed clip: the speed applies to the
// source first, then the turns. In the file both sit in the clip's
// metadata.imageviewer (and the speed in an OTIO LinearTimeWarp as well); a reader
// that knows neither plays the plain clip from its in point for its length.

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;
const STILL_IMAGE = /\.(png|jpe?g|webp|tiff?|gif|bmp|avif|exr)$/i;

/** Is a clip's file a picture (no time of its own: no speed, no loop, no source length)? */
export function isStillImage(file) { return STILL_IMAGE.test(String(file || "")); }

/** Has a clip no time of its own - a picture, or a title (no source length, no speed, no loop)? */
export function isStillClip(c) { return !!(c && c.title) || isStillImage(c && c.file); }

/** A clip's speed: 1 where it has none. */
export function speedOf(c) {
    const s = num(c && c.speed, 1);
    return s > 0 && !isStillClip(c) ? Math.max(MIN_SPEED, Math.min(MAX_SPEED, s)) : 1;
}

/** How a clip loops: "loop", "pingpong" - or "" for not at all. */
export function loopOf(c) {
    return c && (c.loop === "loop" || c.loop === "pingpong") && num(c.span) > 0 && !isStillClip(c) ? c.loop : "";
}

/** How many seconds of its source a clip uses: one turn of a loop, else its length at its speed. */
export function srcUse(c) {
    return loopOf(c) ? num(c.span) : num(c && c.length) * speedOf(c);
}

/** How much source there is from a clip's in point (Infinity for a still, or where its length is not known). */
export function srcRoom(c, durations) {
    if (!c || isStillClip(c)) return Infinity;
    const known = num(durations && durations[c.file], 0);
    return known > 0 ? Math.max(0, known - num(c.in)) : Infinity;
}

/** The moment of a clip's source shown `u` seconds into the clip. */
export function srcLocal(c, u) {
    const q = Math.max(0, num(u)) * speedOf(c);
    const mode = loopOf(c), span = num(c && c.span);
    if (!mode) return round(num(c && c.in) + q);
    if (mode === "loop") return round(num(c.in) + (q % span));
    const p = q % (2 * span);
    return round(num(c.in) + (p < span ? p : 2 * span - p));
}

/**
 * The stretch of a clip the player can run without a jump, around `u` seconds
 * into it: { u0, u1, base, rev, speed } - from u0 to u1 the source runs from
 * `base`, forwards (or backwards: `rev`, a ping-pong's way back) at `speed`.
 */
export function clipSegment(c, u) {
    const speed = speedOf(c), mode = loopOf(c);
    if (!mode) return { u0: 0, u1: Infinity, base: num(c && c.in), rev: false, speed };
    const turn = num(c.span) / speed;
    const k = Math.max(0, Math.floor(num(u) / turn + 1e-9));
    const rev = mode === "pingpong" && k % 2 === 1;
    return { u0: k * turn, u1: (k + 1) * turn, base: num(c.in) + (rev ? num(c.span) : 0), rev, speed };
}

/** Where a looped clip's turns meet, in seconds into the clip (none for a plain one). */
export function loopSeams(c) {
    if (!loopOf(c)) return [];
    const turn = num(c.span) / speedOf(c), out = [];
    for (let u = turn; u < num(c.length) - 1e-6 && out.length < 500; u += turn) out.push(round(u));
    return out;
}

function clipRef(cut, sel) { return sel && (sel.kind === "clip" || sel.kind === "tclip") ? clipOf(cut, sel) : null; }

/**
 * Retime: the clip made `length` seconds long by its speed, its source in and
 * out kept (a looped clip keeps its number of turns). A still simply takes
 * the length. Held to MIN_SPEED .. MAX_SPEED. `fromStart`: the clip was pulled
 * by its start, so on a track of placed clips its end stays where it is.
 */
export function retimeClip(cut, sel, length, fromStart) {
    const next = copy(cut);
    const c = clipRef(next, sel);
    if (!c) return next;
    const was = num(c.length), sp = speedOf(c);
    let len = Math.max(MIN_CLIP, num(length, was));
    if (!isStillClip(c)) {
        const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, sp * was / len));
        len = was * sp / speed;
        c.speed = speed;
    }
    if (fromStart && sel.kind === "tclip") c.at = Math.max(0, num(c.at) + was - len);
    c.length = len;
    return settle(next);
}

/** A clip's speed set (1 = its own), its source kept: its length follows. */
export function setSpeed(cut, sel, speed) {
    const c = clipRef(cut, sel);
    if (!c || isStillClip(c)) return copy(cut);
    const s = Math.max(MIN_SPEED, Math.min(MAX_SPEED, num(speed, 1)));
    return retimeClip(cut, sel, num(c.length) * speedOf(c) / s);
}

/**
 * Loop extend: the clip made `length` long by playing its source again (mode
 * "loop") or back and forth ("pingpong"). A plain clip's turn is the source it
 * uses now; a still just takes the length. Shorter than one turn, it is a
 * plain clip again.
 */
export function loopExtend(cut, sel, length, mode, durations) {
    const next = copy(cut);
    const c = clipRef(next, sel);
    if (!c) return next;
    if (!isStillClip(c)) {
        if (!loopOf(c)) c.span = Math.min(srcUse(c), srcRoom(c, durations));
        c.loop = mode === "pingpong" ? "pingpong" : (mode === "loop" ? "loop" : (c.loop || "loop"));
    }
    c.length = Math.max(MIN_CLIP, num(length, c.length));
    return settle(next);
}

/** One more turn of a clip's loop (a still: its length once more). */
export function loopOnce(cut, sel, mode, durations) {
    const c = clipRef(cut, sel);
    if (!c) return copy(cut);
    const turn = isStillClip(c) ? num(c.length)
        : (loopOf(c) ? num(c.span) : Math.min(srcUse(c), srcRoom(c, durations))) / speedOf(c);
    return loopExtend(cut, sel, num(c.length) + turn, mode, durations);
}

/** A clip's loop set ("loop" / "pingpong"), or taken off (""): then it is one turn long. */
export function setLoop(cut, sel, mode) {
    const c = clipRef(cut, sel);
    if (!c) return copy(cut);
    if (!mode) {
        const next = copy(cut);
        const d = clipRef(next, sel);
        if (loopOf(d)) d.length = Math.min(num(d.length), num(d.span) / speedOf(d));
        delete d.loop; delete d.span;
        return settle(next);
    }
    if (loopOf(c)) { const next = copy(cut); clipRef(next, sel).loop = mode; return settle(next); }
    return loopOnce(cut, sel, mode);
}

// ── trimming like an editor: roll, slip, slide ───────────────────────────────

// How short a shot of the cut may become: MIN_CLIP, and long enough for the
// dissolves at either end of it (settle would shorten them otherwise).
function minShot(cut, i) {
    const c = cut.clips[i], after = cut.clips[i + 1];
    return Math.max(MIN_CLIP, i ? num(c.transition) + MIX_MARGIN : 0, after ? num(after.transition) + MIX_MARGIN : 0);
}

/**
 * Roll: the cut between shot i-1 and shot i moves by `delta` seconds; the shot
 * before ends later (or earlier), the one after begins later in its source by
 * as much - so nothing else moves and the film keeps its length. Held where
 * either shot would run out of source or become too short.
 */
export function rollEdit(cut, i, delta, durations) {
    const a = cut.clips[i - 1], b = cut.clips[i];
    if (!a || !b || num(b.gap) > 0) return copy(cut);           // a gap between them: no cut to roll
    const lo = Math.max(minShot(cut, i - 1) - num(a.length), -inRoom(b));
    const hi = Math.min(outRoom(a, durations), num(b.length) - minShot(cut, i), headSpare(b));
    const d = Math.max(Math.min(lo, 0), Math.min(Math.max(hi, 0), num(delta)));
    const next = copy(cut);
    next.clips[i - 1].length = num(a.length) + d;
    headTrim(next.clips[i], d);
    return settle(next);
}

/**
 * Slip: the clip stays where it is and as long as it is; which part of its
 * source plays moves by `delta` SECONDS OF SOURCE (in and out together). Held
 * to the source: not before its start, not past its end (when known). A still
 * has nothing to slip and comes back as it was.
 */
export function slipClip(cut, sel, delta, durations) {
    const next = copy(cut);
    const c = clipRef(next, sel);
    if (!c || isStillClip(c)) return next;
    const known = num(durations && durations[c.file], 0);
    const top = known > 0 ? Math.max(0, known - srcUse(c)) : Infinity;
    c.in = Math.max(0, Math.min(top, num(c.in) + num(delta)));
    return settle(next);
}

/**
 * Slide (V1): shot i keeps its source and its length and moves along the film
 * by `delta`; the shot before it ends later (or earlier) and the one after
 * begins later (or earlier) in its source by as much, so the film keeps its
 * length. Needs a shot on each side; null where there is none.
 */
export function slideClip(cut, i, delta, durations) {
    const c = cut.clips[i], a = cut.clips[i - 1], b = cut.clips[i + 1];
    if (!c || !b) return null;
    // The side before it: its gap gives and takes, else the shot before does.
    const leftGap = num(c.gap) > 0;
    if (!leftGap && !a) return null;
    const rightGap = num(b.gap) > 0;
    const lo = Math.max(leftGap ? -num(c.gap) : minShot(cut, i - 1) - num(a.length),
                        rightGap ? -Infinity : -inRoom(b));
    const hi = Math.min(leftGap ? Infinity : outRoom(a, durations),
                        rightGap ? num(b.gap) : Math.min(num(b.length) - minShot(cut, i + 1), headSpare(b)));
    const d = Math.max(Math.min(lo, 0), Math.min(Math.max(hi, 0), num(delta)));
    const next = copy(cut);
    if (leftGap) next.clips[i].gap = num(c.gap) + d; else next.clips[i - 1].length = num(a.length) + d;
    if (rightGap) next.clips[i + 1].gap = num(b.gap) - d; else headTrim(next.clips[i + 1], d);
    return settle(next);
}

// ── the in and out of the range played ───────────────────────────────────────
//
// Frames, as the transport's own playbackRange: { start, end }, both shown.

/** A timecode: HH:MM:SS:FF at `fps`. */
export function timecode(seconds, fps = 24) {
    const rate = Math.max(1, Math.round(num(fps, 24)));
    const total = Math.max(0, Math.round(num(seconds) * num(fps, 24)));
    const ff = total % rate, s = Math.floor(total / rate);
    const two = (v) => String(v).padStart(2, "0");
    return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(ff)}`;
}

// ── the timeline's own layout: the playhead readout, track heights, the splitter ──

/** The readout left of the ruler: frame `frame` as a timecode at `fps` (mode "tc"), or its number (mode "frames"). */
export function playheadLabel(frame, fps, mode) {
    const f = Math.max(0, Math.round(num(frame)));
    if (mode === "frames") return String(f);
    const rate = num(fps, 24) > 0 ? num(fps, 24) : 24;
    return timecode(f / rate, rate);
}

/**
 * What is typed into the readout, as a frame: a timecode (HH:MM:SS:FF; fewer
 * parts count from the right, ":" ";" "." all separate) or a frame number; a
 * leading "+" / "-" goes on / back from frame `from`. null when it is neither.
 */
export function parsePlayhead(text, fps, from = 0) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return null;
    const rate = Math.max(1, Math.round(num(fps, 24)));
    const rel = /^[+-]/.test(s) ? s[0] : "";
    const body = rel ? s.slice(1).trim() : s;
    let f;
    if (/^\d+$/.test(body)) f = parseInt(body, 10);
    else if (/^\d+([:;.]\d+){1,3}$/.test(body)) {
        const parts = body.split(/[:;.]/).map(Number);
        while (parts.length < 4) parts.unshift(0);
        const [h, m, sec, ff] = parts;
        f = ((h * 60 + m) * 60 + sec) * rate + ff;
    } else return null;
    if (rel === "+") f = num(from) + f;
    else if (rel === "-") f = num(from) - f;
    return Math.max(0, Math.round(f));
}

/** How low and how tall a track's row may be, in pixels (the header's grip, Shift + wheel). */
export const TRACK_MIN_PX = 12;
export const TRACK_MAX_PX = 160;

/** A row's height one Shift + wheel notch taller (`dir` > 0) or lower: an eighth, at least a pixel, within TRACK_MIN_PX..TRACK_MAX_PX. */
export function stepTrackHeight(h, dir) {
    const now = Math.max(TRACK_MIN_PX, Math.min(TRACK_MAX_PX, Math.round(num(h, TRACK_MIN_PX))));
    const next = dir > 0 ? Math.max(now + 1, Math.round(now * 1.125)) : Math.min(now - 1, Math.round(now / 1.125));
    return Math.max(TRACK_MIN_PX, Math.min(TRACK_MAX_PX, next));
}

/**
 * The video section's height (where the splitter stands) in `room` pixels shared
 * with the sound section: `want` when the splitter was dragged (a number), else
 * the video tracks' own height `contentV` - when both sections' tracks fit, all
 * of it; when not, up to 70 % of the room (the pictures are what is cut), more
 * where the sound needs less. Each section
 * keeps at least `min` pixels.
 */
export function splitHeight(want, room, contentV, contentA, min = 24) {
    const avail = Math.max(0, num(room));
    let h;
    if (Number.isFinite(want)) h = want;
    else if (num(contentV) + num(contentA) <= avail) h = num(contentV);
    else h = Math.min(num(contentV), Math.max(avail * 0.7, avail - num(contentA)));
    const lo = Math.min(min, avail / 2), hi = Math.max(lo, avail - min);
    return Math.round(Math.max(lo, Math.min(hi, h)));
}

/** The range with its in (or out) at `frame`, the other end pushed along where they would cross. */
export function setMark(range, which, frame, last) {
    const top = Math.max(0, Math.round(num(last)));
    const f = Math.max(0, Math.min(top, Math.round(num(frame))));
    const r = range && Number.isFinite(range.start) && Number.isFinite(range.end) ? range : { start: 0, end: top };
    return which === "in" ? { start: f, end: Math.max(f, Math.min(top, r.end)) }
                          : { start: Math.min(f, Math.max(0, r.start)), end: f };
}

/** A frame snapped to the nearest of `frames` within `tolerance` frames. */
export function snapFrame(frame, frames, tolerance) {
    let best = Math.round(num(frame)), gap = num(tolerance);
    for (const f of frames || []) {
        const d = Math.abs(num(f) - num(frame));
        if (d <= gap) { best = Math.round(num(f)); gap = d; }
    }
    return best;
}

/** "Mark clip" (X): the range of a clip - its first frame to its last. */
export function clipRange(cut, sel, fps) {
    const c = clipRef(cut, sel);
    if (!c) return null;
    const rate = num(fps) > 0 ? num(fps) : 24;
    const start = sel.kind === "clip" ? clipStarts(cut)[sel.i] : num(c.at);
    const a = Math.round(start * rate), b = Math.round((start + num(c.length)) * rate) - 1;
    return { start: a, end: Math.max(a, b) };
}

/** The range in seconds of the film: [from, to). */
export function rangeSeconds(range, fps) {
    const rate = num(fps) > 0 ? num(fps) : 24;
    return range ? [num(range.start) / rate, (num(range.end) + 1) / rate] : null;
}

/** The shots of the cut (V1) that lie in [from, to), at least partly. */
export function shotsIn(cut, from, to) {
    const starts = clipStarts(cut);
    return ((cut && cut.clips) || []).map((c, i) => i)
        .filter((i) => starts[i] < num(to) - 1e-6 && starts[i] + num(cut.clips[i].length) > num(from) + 1e-6);
}

// ── several clips selected ───────────────────────────────────────────────────
//
// The panel's selection is ONE item (`{ kind: "clip", i }` / `{ kind: "tclip",
// track, i }`); several clips are a list of those, the last one clicked being the
// single selection every other part of the panel reads. These are the arithmetic
// of the list. A list is held to a cut by its signature: an edit that adds,
// takes out or reorders clips changes it, and the list is then let go.

/** The id of a selected clip: "V1:3" on the cut itself, "<track id>:<i>" on a higher track. */
export function selId(sel) {
    if (!sel) return "";
    if (sel.kind === "xfade") return "xf" + String(sel.track) + ":" + sel.i;
    if (sel.kind === "track") return "trk:" + String(sel.track);
    const where = { clip: "V1", text: "T", gap: "gap", sound: "A1", mix: "mix" }[sel.kind];
    return (where || String(sel.track)) + ":" + sel.i;
}

/** Do two selections name the same clip? */
export function sameSel(a, b) {
    return !!a && !!b && selId(a) === selId(b) && (a.kind === "clip") === (b.kind === "clip");
}

/** Is it a clip (on V1 or a placed track)? */
export const isClipSel = (s) => !!s && (s.kind === "clip" || s.kind === "tclip");
/** Can it be one of several selected: a clip, a text, a clip of the music bed, a gap of V1. */
export const isItemSel = (s) => isClipSel(s) || (!!s && (s.kind === "text" || s.kind === "sound" || s.kind === "gap"));

/** What a selection names in the cut, of any kind that can be one of several (else null). */
export function itemOf(cut, s) {
    if (!cut || !s) return null;
    if (isClipSel(s)) return clipOf(cut, s);
    if (s.kind === "text") return (cut.texts || [])[s.i] || null;
    if (s.kind === "sound") return (cut.sound || [])[s.i] || null;
    if (s.kind === "gap") { const c = (cut.clips || [])[s.i]; return c && num(c.gap) > 0 ? c : null; }
    return null;
}

/** `list` with `sel` toggled: put in at the end, or taken out. */
export function toggleSel(list, sel) {
    const have = (list || []).filter(isItemSel);
    if (!isItemSel(sel)) return have;
    return have.some((s) => sameSel(s, sel)) ? have.filter((s) => !sameSel(s, sel)) : [...have, sel];
}

/** The clips from `anchor` to `sel` on one track, both included - or just `sel` where they are on different tracks. */
export function rangeSel(cut, anchor, sel) {
    if (!isClipSel(sel)) return isItemSel(sel) ? [sel] : [];
    if (!isClipSel(anchor) || (anchor.kind === "clip") !== (sel.kind === "clip") || (sel.kind === "tclip" && anchor.track !== sel.track)) return [sel];
    const from = Math.min(anchor.i, sel.i), to = Math.max(anchor.i, sel.i);
    const out = [];
    for (let i = from; i <= to; i++) out.push(sel.kind === "clip" ? { kind: "clip", i } : { kind: "tclip", track: sel.track, i });
    return out;
}

/** Only the selections that still name a clip of the cut, in the cut's order (V1, then the tracks bottom to top). */
export function pruneSel(cut, list) {
    const rank = (s) => (s.kind === "clip" || s.kind === "gap" ? -1 : s.kind === "text" ? -2 : s.kind === "sound" ? 1e6
        : ((cut && cut.tracks) || []).findIndex((k) => k.id === s.track));
    const seen = new Set();
    return (list || []).filter((s) => isItemSel(s) && itemOf(cut, s) && !seen.has(selId(s)) && seen.add(selId(s)))
        .sort((a, b) => rank(a) - rank(b) || a.i - b.i);
}

/** What ties a list to the cut it was made on: which clips there are, in which order (by `ref`; a new clip by its place). */
export function selSignature(cut) {
    const id = (c) => (c.ref !== undefined && c.ref !== null ? JSON.stringify(c.ref) : "f");
    return JSON.stringify([(cut.clips || []).map(id), ((cut && cut.tracks) || []).map((k) => [k.id, (k.clips || []).map(id)]),
                           (cut.texts || []).length, (cut.sound || []).length]);
}

// ── stable identity, for the selection across undo / redo ────────────────────
//
// A selection names an item by its place (kind + index), which an undo changes.
// Every item the panel has shown carries a `uid` (never saved: toSave, sameCut
// and the .otio writers name their fields), copied along with the item by every
// edit, so the item that comes back from an undo is the one that went.

let uidSeq = 0;

/** Give every item of `cut` that has none a `uid` (in place; the cut is the panel's own). Returns the cut. */
export function stampIds(cut) {
    if (!cut) return cut;
    const one = (o) => { if (o && typeof o === "object" && !o.uid) o.uid = "u" + (++uidSeq) + "_" + Math.random().toString(36).slice(2, 7); };
    for (const c of cut.clips || []) one(c);
    for (const t of cut.texts || []) one(t);
    for (const m of cut.sound || []) one(m);
    for (const k of cut.tracks || []) for (const c of k.clips || []) one(c);
    return cut;
}

/** { kind, uid, track } for a selection of `cut` (null when it names nothing, or an item without a uid). */
export function identOf(cut, sel) {
    const it = itemOf(cut, sel);
    return it && it.uid ? { kind: sel.kind, uid: it.uid, track: sel.track } : null;
}

/** The selection of `cut` that names the item with this uid (null when the cut no longer has it). */
export function locateIdent(cut, id) {
    if (!cut || !id) return null;
    if (id.kind === "clip" || id.kind === "gap") {
        const i = (cut.clips || []).findIndex((c) => c.uid === id.uid);
        if (i < 0 || (id.kind === "gap" && !(num((cut.clips[i]).gap) > 0))) return null;
        return { kind: id.kind, i };
    }
    if (id.kind === "text") { const i = (cut.texts || []).findIndex((t) => t.uid === id.uid); return i < 0 ? null : { kind: "text", i }; }
    if (id.kind === "sound") { const i = (cut.sound || []).findIndex((m) => m.uid === id.uid); return i < 0 ? null : { kind: "sound", i }; }
    if (id.kind === "tclip") {
        for (const k of cut.tracks || []) {
            const i = (k.clips || []).findIndex((c) => c.uid === id.uid);
            if (i >= 0) return { kind: "tclip", track: k.id, i };
        }
    }
    return null;
}

export const SELECTED_CAP = 50;

/** The selected clips as agentY reads them: [{ name, file, in, out (seconds of the source), track, id }]. */
export function selectedClips(cut, list) {
    return pruneSel(cut, list).filter(isClipSel).slice(0, SELECTED_CAP).map((s) => {
        const c = clipOf(cut, s);
        const from = round(num(c.in));
        return { name: String(c.name || ""), file: String(c.file || ""), in: from, out: round(from + srcUse(c)),
                 track: s.kind === "clip" ? "V1" : s.track, id: selId(s) };
    });
}

// ── takes ────────────────────────────────────────────────────────────────────
//
// A clip may carry `takes: [{ file, version, created, note, active }]` - the
// same shot made again with changes. Exactly one is active, and the clip's own
// `file` is that take's file. The first time a clip gets a take, the file it
// had becomes the take "original". An active take that made the clip shorter
// (its source is shorter than the clip used) remembers the length the clip had
// as `len`, which "Retime to fit" fills instead.

export const MAX_TAKES = 50;

/** A path as two spellings of it compare: slashes forward, and - for a drive or share path - no case. */
export function normFile(file) {
    const s = String(file || "").replace(/\\/g, "/");
    return /^([a-z]:\/|\/\/)/i.test(s) ? s.toLowerCase() : s;
}

/** The version a file's name says ("shot_03_v002.mp4" -> 2); 1 where it says none. */
export function versionOf(file) {
    const name = String(file || "").split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
    const all = [...name.matchAll(/(?:^|[^a-z0-9])v(\d{1,5})(?![0-9])/gi)];
    return all.length ? Math.max(1, parseInt(all[all.length - 1][1], 10)) : 1;
}

function durationFor(durations, file) {
    if (!durations) return 0;
    if (num(durations[file]) > 0) return num(durations[file]);
    const want = normFile(file);
    for (const [k, v] of Object.entries(durations)) if (normFile(k) === want && num(v) > 0) return num(v);
    return 0;
}

/** A clip's takes, as a list (empty for a clip with none). */
export function takesOf(c) { return Array.isArray(c && c.takes) ? c.takes : []; }

/** The active take of a clip, or null. */
export function activeTake(c) { return takesOf(c).find((t) => t && t.active) || null; }

/**
 * `c` (a copy) made to fit its file, which has just changed: a source that ends
 * before the clip does shortens the clip - or, with `retime`, slows it down so
 * what there is fills the length. Returns the length the clip had when it was
 * shortened (0 when it was not).
 */
function fitSource(c, durations, retime) {
    if (isStillClip(c)) return 0;
    const known = durationFor(durations, c.file);
    if (!(known > 0)) return 0;
    const sp = speedOf(c);
    if (num(c.in) + srcUse(c) <= known + 1e-3) return 0;
    const was = num(c.length);
    if (known - num(c.in) < MIN_CLIP * sp) c.in = round(Math.max(0, known - MIN_CLIP * sp));
    const usable = known - num(c.in);
    if (loopOf(c)) { c.span = round(Math.min(num(c.span), usable)); return 0; }
    if (retime) {
        const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, usable / was));
        c.speed = speed;
        c.length = round(Math.min(was, usable / speed));
    } else {
        c.length = round(Math.max(MIN_CLIP, usable / sp));
    }
    return c.length < was - 1e-4 ? round(was) : 0;
}

function everyClip(cut, fn) {
    cut.clips.forEach((c, i) => fn(c, { kind: "clip", i }));
    for (const k of cut.tracks || []) k.clips.forEach((c, i) => fn(c, { kind: "tclip", track: k.id, i }));
}

// Make `take` (one of c.takes, c a copy) the clip's active one.
function takeFile(c, take, durations, retime) {
    c.takes = c.takes.map((t) => ({ ...t, active: t === take }));
    const active = c.takes.find((t) => t.active);
    delete active.len;
    c.file = active.file;
    const len = fitSource(c, durations, retime);
    if (len) active.len = len;
}

/**
 * A new take of every clip whose file is `fromFile` (V1 and the tracks): it
 * becomes the clip's file and its active take, and the clip keeps its in point,
 * its place, its effects, its speed, its colour - everything but the file. A
 * source shorter than the clip used shortens the clip (`retime`: slows it down
 * to fill the length). `take`: { file, version, created, note }. A cut with no
 * such clip comes back unchanged.
 */
export function addTake(cut, fromFile, take, opts = {}) {
    const next = copy(cut);
    const want = normFile(fromFile);
    if (!take || !take.file || !want) return next;
    everyClip(next, (c) => {
        if (normFile(c.file) !== want) return;
        let list = takesOf(c).length ? takesOf(c).map((t) => ({ ...t, active: false }))
            : [{ file: c.file, version: versionOf(c.file), created: "", note: "original", active: false }];
        let mine = list.find((t) => normFile(t.file) === normFile(take.file));
        if (!mine) {
            if (list.length >= MAX_TAKES) list = list.slice(list.length - MAX_TAKES + 1);
            const top = Math.max(0, ...list.map((t) => num(t.version)));
            let version = Math.round(num(take.version, 0));
            if (!(version > 0) || list.some((t) => num(t.version) === version)) version = top + 1;
            mine = { file: String(take.file), version, created: String(take.created || ""), note: String(take.note || "").slice(0, 200), active: false };
            list.push(mine);
        }
        c.takes = list;
        takeFile(c, mine, opts.durations, !!opts.retime);
    });
    return settle(next);
}

/** The clip `sel` shows its take `version` (the same fit as addTake). Not a clip with that take: unchanged. */
export function switchTake(cut, sel, version, opts = {}) {
    const next = copy(cut);
    const c = clipRef(next, sel);
    const take = c && takesOf(c).find((t) => num(t.version) === num(version));
    if (!take || take.active) return next;
    c.takes = takesOf(c).map((t) => ({ ...t }));
    takeFile(c, c.takes.find((t) => num(t.version) === num(version)), opts.durations, !!opts.retime);
    return settle(next);
}

/** "Retime to fit": the active take slowed down to fill the length the clip had before it made it shorter. */
export function retimeToFit(cut, sel, durations) {
    const next = copy(cut);
    const c = clipRef(next, sel);
    const act = c && activeTake(c);
    if (!act || !(num(act.len) > 0)) return next;
    const known = durationFor(durations, c.file);
    const usable = known > 0 ? Math.max(MIN_CLIP, known - num(c.in)) : srcUse(c);
    const len = num(act.len);
    const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, usable / len));
    c.takes = c.takes.map((t) => { const o = { ...t }; if (o.active) delete o.len; return o; });
    c.speed = speed;
    c.length = round(Math.min(len, usable / speed));
    return settle(next);
}

/** Takes as they are written into a file: only what is a take, at most MAX_TAKES, one active. */
export function cleanTakes(list) {
    if (!Array.isArray(list)) return [];
    const out = list.filter((t) => t && typeof t === "object" && typeof t.file === "string" && t.file).slice(0, MAX_TAKES).map((t) => {
        const o = { file: t.file, version: Math.round(num(t.version, 1)), created: String(t.created || ""),
                    note: String(t.note || "").slice(0, 200), active: !!t.active };
        if (num(t.len) > 0) o.len = round(num(t.len));
        return o;
    });
    let seen = false;
    for (const t of out) { if (t.active && seen) t.active = false; if (t.active) seen = true; }
    if (out.length && !seen) out[out.length - 1].active = true;
    return out;
}

/** Does any clip of the cut (V1 or a track) play `file`? (compared by meaning: slashes, case on a drive path) */
export function usesFile(cut, file) {
    const want = normFile(file);
    if (!want || !cut) return false;
    return [...(cut.clips || []), ...(cut.tracks || []).flatMap((k) => k.clips || [])].some((c) => normFile(c.file) === want);
}

// ── V1 with gaps: overwrite, move, trims that leave or fill a gap ────────────
//
// The Selection mode (A) edits as Resolve's does: nothing else on the track
// moves. A clip moved on V1 lies over what is at its new place (an overwrite)
// and leaves a gap where it was; an edge dragged leaves a gap or fills one, and
// never pushes a neighbour. The Trim mode (T) ripples instead: trimEnd /
// trimStart on V1 (what follows moves with the edge), rippleTrackEnd / Start on
// the other tracks.

// The source moment `d` seconds into a clip, as the start of a piece cut out of
// it: a looped clip's piece is played on from there, plainly.
function headCut(c, d) {
    if (d <= 0) return;
    if (loopOf(c)) {
        c.in = srcLocal(c, d);
        delete c.loop; delete c.span;
        c.length = num(c.length) - d;
        return;
    }
    headTrim(c, d);
}

/**
 * `clip` laid onto V1 from the moment `at` (an overwrite edit): what was there
 * is cut away under it - a clip it covers goes, one it overlaps is trimmed, one
 * it falls inside is cut in two around it - and nothing else moves. Empty time
 * around it becomes gaps. Returns { cut, i } - `i` where the clip now is.
 */
export function overwriteV1(cut, clip, at) {
    const a = round(Math.max(0, num(at)));
    const b = round(a + Math.max(MIN_CLIP, num(clip.length)));
    const starts = clipStarts(cut);
    const placed = [];
    (cut.clips || []).forEach((c0, k) => {
        const s0 = starts[k], e0 = round(s0 + num(c0.length));
        if (e0 <= a + 1e-6 || s0 >= b - 1e-6) { placed.push({ c: { ...c0 }, s: s0 }); return; }
        if (s0 < a - 1e-6 && a - s0 >= MIN_CLIP - 1e-6) {            // its head stays, up to the clip
            const head = { ...c0, length: round(a - s0) };
            placed.push({ c: head, s: s0 });
        }
        if (e0 > b + 1e-6 && e0 - b >= MIN_CLIP - 1e-6) {            // its tail stays, from the clip's end
            const tail = { ...c0 };
            delete tail.uid;
            headCut(tail, b - s0);
            tail.length = round(e0 - b);
            if (s0 < a - 1e-6) { delete tail.link; delete tail.unlinked; }   // a piece of a clip cut in two has no partner
            if (c0.fx) tail.fx = splitFx(c0.fx, b - s0)[1];
            placed.push({ c: tail, s: b });
        }
    });
    const mine = { ...clip, transition: 0 };
    delete mine.gap; delete mine.at;
    placed.push({ c: mine, s: a, mine: true });
    placed.sort((x, y) => x.s - y.s || (x.mine ? -1 : y.mine ? 1 : 0));
    const next = copy(cut);
    next.clips = [];
    let end = 0;
    placed.forEach((p, k) => {
        const c = p.c;
        const d = round(p.s - end);
        if (d >= 0 || !k) { c.gap = Math.max(0, d); c.transition = 0; } else { c.gap = 0; c.transition = -d; }
        next.clips.push(c);
        end = Math.max(end, round(p.s + num(c.length)));
    });
    return { cut: settle(next), i: placed.findIndex((p) => p.mine) };
}

/**
 * Selection mode: V1's clip i dragged to begin at `at` - lifted out (its place
 * becomes a gap) and laid over what is at its new place. Nothing else moves.
 * `change` ({ in, length }) also changes its source in and length on the way
 * (a linked partner following a trim). Returns { cut, i }.
 */
export function moveShot(cut, i, at, change = {}) {
    const c = cut.clips[i];
    if (!c) return null;
    const keep = { ...c, transition: 0 };
    delete keep.gap;
    if (change.in !== undefined) keep.in = Math.max(0, num(change.in));
    if (change.length !== undefined) keep.length = Math.max(MIN_CLIP, num(change.length));
    for (const k of ["speed", "loop", "span"]) if (change[k] !== undefined) keep[k] = change[k];
    if (cut.clips.length === 1) {
        const next = copy(cut);
        next.clips[0] = { ...keep, gap: round(Math.max(0, num(at))) };
        return { cut: settle(next), i: 0 };
    }
    return overwriteV1(liftV1(cut, i), keep, at);
}

/**
 * Selection mode: V1's clip i ends earlier or later and nothing else moves - a
 * gap opens after it, or the one there is filled. It cannot run on into the
 * clip after it (nor past the end of its source).
 */
export function liftTrimEnd(cut, i, length, durations) {
    const c = cut.clips[i];
    if (!c) return copy(cut);
    const after = cut.clips[i + 1];
    const starts = clipStarts(cut);
    const room = after ? (num(after.transition) > 0 ? 0 : num(after.gap)) : Infinity;
    const low = Math.max(MIN_CLIP, i ? num(c.transition) + MIX_MARGIN : 0);
    const len = Math.max(low, Math.min(num(length, c.length), num(c.length) + Math.min(room, outRoom(c, durations))));
    const next = copy(cut);
    next.clips[i].length = len;
    if (after) restart(next, i + 1, starts[i + 1]);
    return settle(next);
}

/**
 * Selection mode: V1's clip i begins later (or earlier) by `delta` seconds of
 * the film, its end where it was - the gap before it grows, or is filled. Not
 * into the clip before it, nor before its source's start.
 */
export function liftTrimStart(cut, i, delta) {
    const c = cut.clips[i];
    if (!c) return copy(cut);
    const starts = clipStarts(cut);
    const after = cut.clips[i + 1];
    const gapRoom = num(c.transition) > 0 ? 0 : num(c.gap);
    const spare = Math.min(headSpare(c), num(c.length) - Math.max(MIN_CLIP, after ? num(after.transition) + MIX_MARGIN : 0));
    const d = Math.max(-Math.min(inRoom(c), gapRoom), Math.min(num(delta), Math.max(0, spare)));
    const next = copy(cut);
    headTrim(next.clips[i], d);
    restart(next, i, starts[i] + d);
    return settle(next);
}

// ── the other tracks: ripple, roll, slide ────────────────────────────────────

/** Trim mode: a placed clip ends earlier or later, and the clips after it on its track move with the edge. */
export function rippleTrackEnd(cut, id, i, length, durations) {
    const next = copy(cut);
    const k = trackOf(next, id);
    const c = k && k.clips[i];
    if (!c) return next;
    const end0 = num(c.at) + num(c.length);
    const len = Math.max(MIN_CLIP, Math.min(num(length, c.length), num(c.length) + outRoom(c, durations)));
    const d = round(len - num(c.length));
    c.length = len;
    k.clips.forEach((o, j) => { if (j !== i && num(o.at) >= end0 - 1e-6) o.at = round(num(o.at) + d); });
    return settle(next);
}

/**
 * Trim mode: a placed clip's start trimmed by `delta` - its in point moves, the
 * clip keeps its place, and the clips after it on its track move up (or on).
 */
export function rippleTrackStart(cut, id, i, delta) {
    const next = copy(cut);
    const k = trackOf(next, id);
    const c = k && k.clips[i];
    if (!c) return next;
    const end0 = num(c.at) + num(c.length);
    const d = Math.max(-inRoom(c), Math.min(num(delta), headSpare(c)));
    headTrim(c, d);
    k.clips.forEach((o, j) => { if (j !== i && num(o.at) >= end0 - 1e-6) o.at = round(Math.max(0, num(o.at) - d)); });
    return settle(next);
}

/** The clips of a track next to clip i that TOUCH it: { before, after } (indices, -1 for none). */
export function touching(cut, id, i) {
    const k = trackOf(cut, id);
    const c = k && k.clips[i];
    const out = { before: -1, after: -1 };
    if (!c) return out;
    const a = num(c.at), b = a + num(c.length);
    k.clips.forEach((o, j) => {
        if (j === i) return;
        if (Math.abs(num(o.at) + num(o.length) - a) < 1e-3) out.before = j;
        if (Math.abs(num(o.at) - b) < 1e-3) out.after = j;
    });
    return out;
}

/** Roll the cut between two touching clips of a track (`a` ends where `b` begins) by `delta`. */
export function rollTrack(cut, id, a, b, delta, durations) {
    const k = trackOf(cut, id);
    const A = k && k.clips[a], B = k && k.clips[b];
    if (!A || !B) return copy(cut);
    const lo = Math.max(MIN_CLIP - num(A.length), -inRoom(B));
    const hi = Math.min(outRoom(A, durations), num(B.length) - MIN_CLIP, headSpare(B));
    const d = Math.max(Math.min(lo, 0), Math.min(Math.max(hi, 0), num(delta)));
    const next = copy(cut);
    const n = trackOf(next, id);
    n.clips[a].length = num(A.length) + d;
    headTrim(n.clips[b], d);
    n.clips[b].at = num(B.at) + d;
    return settle(next);
}

/**
 * Slide a placed clip by `delta`: its source and length kept, it moves along
 * its track; a clip that touches it gives or takes (the one before ends later
 * or earlier, the one after begins later or earlier in its source), and where
 * none touches, the empty time does - up to the next clip.
 */
export function slideTrackClip(cut, id, i, delta, durations) {
    const k = trackOf(cut, id);
    const c = k && k.clips[i];
    if (!c) return null;
    const t = touching(cut, id, i);
    const a = num(c.at), b = a + num(c.length);
    let lo = -a, hi = Infinity;
    for (const [j, o] of k.clips.entries()) {
        if (j === i || j === t.before || j === t.after) continue;
        const oe = num(o.at) + num(o.length);
        if (oe <= a + 1e-6) lo = Math.max(lo, oe - a);
        if (num(o.at) >= b - 1e-6) hi = Math.min(hi, num(o.at) - b);
    }
    if (t.before >= 0) {
        const A = k.clips[t.before];
        lo = Math.max(lo, MIN_CLIP - num(A.length));
        hi = Math.min(hi, outRoom(A, durations));
    }
    if (t.after >= 0) {
        const B = k.clips[t.after];
        lo = Math.max(lo, -inRoom(B));
        hi = Math.min(hi, num(B.length) - MIN_CLIP, headSpare(B));
    }
    const d = Math.max(Math.min(lo, 0), Math.min(Math.max(hi, 0), num(delta)));
    const next = copy(cut);
    const n = trackOf(next, id);
    n.clips[i].at = a + d;
    if (t.before >= 0) n.clips[t.before].length = num(n.clips[t.before].length) + d;
    if (t.after >= 0) { headTrim(n.clips[t.after], d); n.clips[t.after].at = num(n.clips[t.after].at) + d; }
    return settle(next);
}

// ── picture and sound apart: link groups ─────────────────────────────────────

/** What kind of track a selected clip is on: "video" (V1 and the video tracks) or "audio". */
export function selKind(cut, sel) {
    if (!sel) return "";
    if (sel.kind === "clip") return "video";
    const k = trackOf(cut, sel.track);
    return k ? k.kind : "";
}

/** Where a selected clip lies in the film: { start, end } (seconds). */
export function selSpan(cut, sel) {
    const c = clipOf(cut, sel);
    if (!c) return null;
    const start = sel.kind === "clip" ? clipStarts(cut)[sel.i] : num(c.at);
    return { start, end: round(start + num(c.length)) };
}

/** Every clip of the cut in the link group `link`, as selections. */
export function linkMembers(cut, link) {
    const out = [];
    if (!link) return out;
    everyClip(cut, (c, sel) => { if (c.link === link) out.push(sel); });
    return out;
}

/** The other clip of a selected clip's link group (its picture or its sound), or null. `linkedOnly`: only while they are linked. */
export function linkPartner(cut, sel, linkedOnly = true) {
    const c = clipOf(cut, sel);
    if (!c || !c.link || (linkedOnly && c.unlinked)) return null;
    const kind = selKind(cut, sel);
    return linkMembers(cut, c.link).find((s) => !sameSel(s, sel) && selKind(cut, s) !== kind) || null;
}

/** A clip's loudness as it is heard: 0 when its sound was split off it (`mute`). */
export function clipVolume(c, u = 0) {
    if (!c || c.mute) return 0;
    if (keysOf(c, "vol").length) return Math.max(0, Math.min(1, keyValue(keysOf(c, "vol"), u)));
    return Math.max(0, Math.min(1, c.volume != null ? num(c.volume, 1) : 1));
}

/** A link group's name not taken in the cut: "L1", "L2", ... */
export function newLinkId(cut) {
    let top = 0;
    everyClip(cut, (c) => { const m = /^L(\d+)$/.exec(String(c.link || "")); if (m) top = Math.max(top, Number(m[1])); });
    return "L" + (top + 1);
}

/**
 * "Unlink audio / video" (Ctrl+Alt+L): a film's sound becomes a clip of its own.
 * The video clip stays where it is with its own sound muted; a clip of the same
 * file, the same source in and out, lies on a sound track at the same moment -
 * the first one (not A1, the bed) free there, else a new one. The two are a link
 * group, unlinked: each can be moved, trimmed and deleted on its own.
 * A pair that is LINKED is just unlinked. Returns { cut, sel (the sound clip) } or null
 * (a still, a sound clip, a clip already unlinked).
 */
export function unlinkClip(cut, sel) {
    const c = clipOf(cut, sel);
    if (!c || selKind(cut, sel) !== "video" || isStillClip(c)) return null;
    if (c.link) {
        const partner = linkPartner(cut, sel, false);
        if (!partner || c.unlinked) return null;
        const next = copy(cut);
        for (const s of linkMembers(next, c.link)) clipOf(next, s).unlinked = true;
        return { cut: next, sel: partner };
    }
    const span = selSpan(cut, sel);
    let next = copy(cut);
    let track = (next.tracks || []).find((k) => k.kind === "audio"
        && !(k.clips || []).some((o) => num(o.at) < span.end - 1e-6 && num(o.at) + num(o.length) > span.start + 1e-6));
    if (!track) {
        next = addTrack(next, "audio");
        track = next.tracks[next.tracks.length - 1];
    }
    const id = newLinkId(cut);
    const v = clipOf(next, sel);
    const sound = { file: v.file, name: v.name, in: v.in, length: v.length, at: span.start, color: v.color || "",
                    volume: num(v.volume, 1), link: id, unlinked: true };
    if (v.speed) sound.speed = v.speed;
    if (loopOf(v)) { sound.loop = v.loop; sound.span = v.span; }
    // Volume keys belong to the sound: they go with it (the picture is muted now).
    if (keysOf(v, "vol").length) {
        sound.fx = { keys: { vol: keysOf(v, "vol").map((k) => ({ ...k })) } };
        const fx = cleanFx(v.fx);
        delete fx.keys.vol;
        if (!Object.keys(fx.keys).length) delete fx.keys;
        v.fx = fx;
    }
    track.clips.push(sound);
    Object.assign(v, { link: id, unlinked: true, mute: true });
    return { cut: settle(next), sel: { kind: "tclip", track: track.id, i: track.clips.length - 1 } };
}

/**
 * How far a clip's linked sound is off its picture, in seconds of the film: 0 in
 * sync; positive, the sound is late. Measured by the source, so a pair trimmed
 * differently but on the same moments is in sync. 0 with no partner.
 */
export function syncOffset(cut, sel) {
    const partner = linkPartner(cut, sel, false);
    if (!partner) return 0;
    const video = selKind(cut, sel) === "video" ? sel : partner, sound = video === sel ? partner : sel;
    const zero = (s) => { const c = clipOf(cut, s); return selSpan(cut, s).start - num(c.in) / speedOf(c); };
    const d = round(zero(sound) - zero(video));
    return Math.abs(d) < 1e-3 ? 0 : d;
}

/**
 * Relink from either part of a split pair: the partner is found by the link
 * group. As in Resolve the offset stays: they go together from there, out of sync
 * (syncOffset, resyncAudio puts it right). The picture stays silent and the
 * sound clip keeps its track and its waveform. Null where there is no pair to relink.
 */
export function relinkAudio(cut, sel) {
    const c = clipOf(cut, sel);
    if (!c || !c.link || !c.unlinked || !linkPartner(cut, sel, false)) return null;
    const next = copy(cut);
    for (const s of linkMembers(next, c.link)) delete clipOf(next, s).unlinked;
    return settle(next);
}

/**
 * The sound clip of a pair moved back onto its picture (the picture stays).
 * Before the start of the film it loses its head. Null where it is in sync.
 */
export function resyncAudio(cut, sel) {
    const d = syncOffset(cut, sel);
    if (!d) return null;
    const partner = linkPartner(cut, sel, false);
    const sound = selKind(cut, sel) === "video" ? partner : sel;
    if (sound.kind !== "tclip") return null;
    const next = copy(cut);
    const c = clipOf(next, sound);
    const at = num(c.at) - d;
    if (at < 0) headTrim(c, -at);
    c.at = round(Math.max(0, at));
    return settle(next);
}

/**
 * Merge audio back into the clip, from either part: the sound clip goes, the
 * picture plays its own sound again, the link group is over. A picture whose
 * sound clip was deleted just gets its sound back. A clip never has both.
 * { cut, sel (the picture) }, or null where there is nothing to merge.
 */
export function mergeAudio(cut, sel) {
    const c = clipOf(cut, sel);
    if (!c) return null;
    const partner = linkPartner(cut, sel, false);
    const video = selKind(cut, sel) === "video" ? sel : partner;
    if (!video) return null;
    const v0 = clipOf(cut, video);
    if (!v0.link && !v0.mute) return null;
    const sounds = v0.link ? linkMembers(cut, v0.link).filter((s) => selKind(cut, s) !== "video") : [];
    const next = copy(cut);
    for (const s of sounds.sort((a, b) => b.i - a.i)) trackOf(next, s.track).clips.splice(s.i, 1);
    const v = clipOf(next, video);
    delete v.link; delete v.unlinked; delete v.mute;
    return { cut: settle(next), sel: video };
}

/**
 * "Link clips": a video clip and a sound clip of the same file become one link
 * group again - moved, trimmed, cut and deleted together. The video's own sound
 * stays muted (the sound clip carries it). Null when they are not such a pair.
 */
export function linkClips(cut, a, b) {
    const ca = clipOf(cut, a), cb = clipOf(cut, b);
    if (!ca || !cb || normFile(ca.file) !== normFile(cb.file)) return null;
    const ka = selKind(cut, a), kb = selKind(cut, b);
    if (ka === kb || !ka || !kb) return null;
    const next = copy(cut);
    const v = clipOf(next, ka === "video" ? a : b), s = clipOf(next, ka === "video" ? b : a);
    // Each leaves a group it was in with another clip.
    for (const c of [v, s]) {
        if (c.link && c.link !== (ca.link === cb.link ? ca.link : null)) {
            for (const m of linkMembers(next, c.link)) { const o = clipOf(next, m); if (o !== v && o !== s) { delete o.link; delete o.unlinked; } }
        }
    }
    const id = ca.link && ca.link === cb.link ? ca.link : newLinkId(cut);
    for (const c of [v, s]) { c.link = id; delete c.unlinked; }
    v.mute = true;
    return { cut: settle(next) };
}

/**
 * What an edit did to a linked clip, done to its partner: `before` was the cut,
 * `after` the cut with the clip `sel` (in `before`) edited. The partner's start,
 * end and source in move by as much as the clip's did, its speed and loop follow
 * the clip's. `ripple`: the clips after the partner on its track move with its end
 * (a ripple trim). Unlinked or unpaired clips come back as `after`.
 */
export function followLink(before, after, sel, opts = {}) {
    const c0 = clipOf(before, sel);
    if (!c0 || !c0.link || c0.unlinked) return after;
    const kind = selKind(before, sel);
    const mine = linkMembers(after, c0.link).filter((s) => selKind(after, s) === kind);
    const theirs = linkMembers(after, c0.link).filter((s) => selKind(after, s) !== kind);
    if (mine.length !== 1 || theirs.length !== 1) return after;
    const me0 = selSpan(before, sel), me1 = selSpan(after, mine[0]), c1 = clipOf(after, mine[0]);
    const pSel = theirs[0];
    const p = clipOf(after, pSel), pSpan = selSpan(after, pSel);
    const dS = round(me1.start - me0.start), dE = round(me1.end - me0.end), dIn = round(num(c1.in) - num(c0.in));
    const timed = speedOf(c1) !== speedOf(c0) || loopOf(c1) !== loopOf(c0) || num(c1.span) !== num(c0.span);
    if (!dS && !dE && !dIn && !timed) return after;
    const change = { in: Math.max(0, num(p.in) + dIn), length: Math.max(MIN_CLIP, num(p.length) + dE - dS) };
    if (timed) Object.assign(change, { speed: c1.speed, loop: c1.loop, span: c1.span });
    if (pSel.kind === "clip") {
        const got = moveShot(after, pSel.i, pSpan.start + dS, change);
        return got ? got.cut : after;
    }
    const next = copy(after);
    const k = trackOf(next, pSel.track);
    const q = k.clips[pSel.i];
    const end0 = num(q.at) + num(q.length);
    q.at = Math.max(0, num(q.at) + dS);
    q.in = change.in;
    q.length = change.length;
    if (timed) { if (c1.speed) q.speed = c1.speed; else delete q.speed; if (loopOf(c1)) { q.loop = c1.loop; q.span = c1.span; } else { delete q.loop; delete q.span; } }
    if (opts.ripple && dE - dS) k.clips.forEach((o, j) => { if (j !== pSel.i && num(o.at) >= end0 - 1e-6) o.at = round(Math.max(0, num(o.at) + dE - dS)); });
    return settle(next);
}

/**
 * The blade on a clip of a linked pair cuts both, at the same moment, and each
 * pair of halves is a link group of its own. Otherwise splitClip. { cut, sel } or null.
 */
export function splitWithLink(cut, sel, seconds) {
    const c = clipOf(cut, sel);
    const got = splitClip(cut, sel, seconds);
    if (!got || !c || !c.link || c.unlinked) return got;
    const partner = linkPartner(cut, sel);
    if (!partner) return got;
    const both = splitClip(got.cut, partner, seconds);
    if (!both) return got;
    const id = newLinkId(both.cut);
    // The partner's track is not the clip's, so the clip's halves kept their places.
    clipOf(both.cut, got.sel).link = id;
    clipOf(both.cut, both.sel).link = id;
    return { cut: both.cut, sel: got.sel };
}

/**
 * Delete a clip with its linked partner: `ripple` closes up the clip's own
 * track (Shift+Del); the partner is lifted from its track, or rippled there too.
 */
export function deleteWithLink(cut, sel, ripple) {
    const partner = linkPartner(cut, sel);
    let next = cut;
    if (partner && partner.kind !== "clip") next = ripple ? rippleDelete(next, partner) : liftClip(next, partner);
    if (partner && partner.kind === "clip" && next.clips.length > 1) next = ripple ? removeClip(next, partner.i) : liftV1(next, partner.i);
    // The partner was on another track, so `sel` still names the clip.
    return ripple ? rippleDelete(next, sel) : liftClip(next, sel);
}

// ── snapping ─────────────────────────────────────────────────────────────────
//
// As Resolve snaps: while something is dragged, the moment it would land on
// goes to the nearest TARGET within SNAP_PX pixels on screen - so the same
// distance at every zoom. Targets: the start of the film, the edges of every
// clip on every track (sound clips too), the edges of V1's gaps, the texts, the
// playhead, the in and out, and (a switch of its own) the beats of the music.

/** Pixels on screen within which a moment snaps (the panel turns them into seconds at its zoom). */
export const SNAP_PX = 9;

/** `px` pixels on screen in seconds of the film, at a timeline `widthPx` wide showing `total` seconds. */
export function snapSeconds(px, total, widthPx) {
    return widthPx > 0 && total > 0 ? num(px) * num(total) / num(widthPx) : 0;
}

/**
 * Everything a dragged moment can snap to: [{ t, kind, owner, label }].
 * `kind`: "start", "clip", "gap", "text", "playhead", "in", "out", "beat";
 * `owner`: the clip's selection id ("V1:2", "A2:0") where it is a clip's edge,
 * so a drag can leave out the clip being dragged. `opts`: { playhead (seconds),
 * range ([from, to) seconds), beats (seconds of the film), exclude ([ids]) }.
 */
export function snapTargets(cut, opts = {}) {
    const out = [{ t: 0, kind: "start", owner: "", label: "start" }];
    if (!cut) return out;
    const skip = new Set(opts.exclude || []);
    const add = (t, kind, owner, label) => { if (!skip.has(owner) && Number.isFinite(num(t, NaN))) out.push({ t: round(num(t)), kind, owner, label }); };
    const starts = clipStarts(cut);
    (cut.clips || []).forEach((c, i) => {
        const id = "V1:" + i, name = c.name || "clip";
        add(starts[i], "clip", id, name + " in");
        add(starts[i] + num(c.length), "clip", id, name + " out");
    });
    for (const g of v1Gaps(cut)) {
        add(g.start, "gap", "gap:" + g.i, "gap");
        add(g.start + g.length, "gap", "gap:" + g.i, "gap end");
    }
    for (const k of cut.tracks || []) {
        (k.clips || []).forEach((c, i) => {
            const id = k.id + ":" + i, name = c.name || "clip";
            add(c.at, "clip", id, name + " in");
            add(num(c.at) + num(c.length), "clip", id, name + " out");
        });
    }
    (cut.texts || []).forEach((t, i) => {
        add(t.start, "text", "T:" + i, "text");
        add(num(t.start) + num(t.length), "text", "T:" + i, "text end");
    });
    if (opts.playhead != null) add(opts.playhead, "playhead", "", "playhead");
    if (opts.range) { add(opts.range[0], "in", "", "in"); add(opts.range[1], "out", "", "out"); }
    for (const b of opts.beats || []) add(b, "beat", "", "beat");
    return out;
}

/** `seconds` snapped to the nearest of `targets` within `tolerance`: { t, target } (target null: not snapped). */
export function snapResolve(seconds, targets, tolerance) {
    const t = num(seconds);
    let best = null, gap = num(tolerance);
    for (const g of targets || []) {
        const d = Math.abs(num(g.t) - t);
        if (d <= gap + 1e-9 && (!best || d < gap - 1e-9 || (d <= gap + 1e-9 && rank(g) < rank(best)))) { best = g; gap = d; }
    }
    return best ? { t: num(best.t), target: best } : { t, target: null };
}
// Between two targets at one distance: an edit point before the playhead, before a beat.
const RANK = { clip: 0, gap: 1, start: 1, text: 2, in: 3, out: 3, playhead: 4, beat: 5 };
const rank = (g) => (RANK[g.kind] === undefined ? 9 : RANK[g.kind]);

/** A span `length` long beginning at `at`: its start or its end snapped, whichever is nearer. { at, target, edge }. */
export function snapSpan(at, length, targets, tolerance) {
    const a = snapResolve(at, targets, tolerance), b = snapResolve(num(at) + num(length), targets, tolerance);
    const da = a.target ? Math.abs(a.t - at) : Infinity, db = b.target ? Math.abs(b.t - (num(at) + num(length))) : Infinity;
    if (da === Infinity && db === Infinity) return { at: num(at), target: null, edge: "" };
    return da <= db ? { at: a.t, target: a.target, edge: "start", t: a.t } : { at: b.t - num(length), target: b.target, edge: "end", t: b.t };
}

// The scale of the timeline. `zoom` 1 is the whole film across the width; above
// it the strip is wider than the panel and scrolls; below it the film takes that
// share of the width and the rest is empty timeline, to move or drop clips onto.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 64;

/** A zoom within its limits (a hair off 1 is 1: stepping out and back in lands on Fit). */
export function clampZoom(zoom) {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, num(zoom, 1) || 1));
    return Math.abs(z - 1) < 0.02 ? 1 : z;
}

/** Where the last thing on any track ends: the film, or a sound running on past it. */
export function contentEnd(cut) {
    let end = filmLength(cut);
    for (const k of (cut && cut.tracks) || []) {
        if (k.kind === "audio") for (const c of k.clips || []) end = Math.max(end, num(c.at) + num(c.length));
    }
    return round(end);
}

/** The seconds the strip's whole width stands for at `zoom`. */
export function viewSpan(end, zoom) {
    return num(end) / Math.min(1, clampZoom(zoom));
}

/** The strip's width in per cent of the panel at `zoom`. */
export function areaPercent(zoom) {
    return Math.max(1, clampZoom(zoom)) * 100;
}

/** The zoom that keeps the seconds per pixel when the content's end goes from `was` to `now`; Fit stays Fit. */
export function keepScale(zoom, was, now) {
    if (zoom === 1 || !(num(was) > 0) || !(num(now) > 0) || num(was) === num(now)) return zoom;
    return clampZoom(zoom * num(now) / num(was));
}

// ── snapping that lands on frames ────────────────────────────────────────────

/** One moving edge: where it lands, ON A FRAME, snapped or not. { t, target }. */
export function snapPoint(seconds, targets, tolerance, fps) {
    const got = snapResolve(seconds, targets, tolerance);
    return { t: toFrame(got.t, fps), target: got.target };
}

/**
 * A span moved: where its start lands. Not snapped, the start goes on a frame.
 * Snapped, the SNAPPED edge goes on the target's frame - by its end that is the
 * target less the length, which is left alone even if it is no whole number of frames.
 */
export function snapMove(at, length, targets, tolerance, fps) {
    const got = snapSpan(at, length, targets, tolerance);
    if (!got.target) return { at: toFrame(at, fps), target: null, edge: "" };
    const t = toFrame(got.t, fps);
    return { at: got.edge === "end" ? round(t - num(length)) : t, target: got.target, edge: got.edge };
}

/** The target ids a drag of `sel` leaves out: it, its linked partner, and the gaps beside them (their near edges are its own). */
export function snapExclude(cut, sel) {
    const out = [];
    const add = (s) => {
        out.push(selId(s));
        if (s.kind === "clip") out.push("gap:" + s.i, "gap:" + (s.i + 1));
    };
    if (isItemSel(sel)) add(sel);
    const partner = isClipSel(sel) ? linkPartner(cut, sel) : null;
    if (partner) add(partner);
    return out;
}

// ── several things at once ───────────────────────────────────────────────────

// The list with the linked partners of its clips.
function withPartners(cut, list) {
    const all = pruneSel(cut, list);
    for (const s of all.filter(isClipSel)) { const p = linkPartner(cut, s); if (p) all.push(p); }
    return pruneSel(cut, all);
}

/**
 * Everything in `list` taken out, its linked partners too, as one edit. Lift:
 * gaps stay, nothing else moves. `ripple`: what follows on each clip's own track
 * closes up. A gap is closed; a text and a clip of the bed go. V1 keeps its last
 * shot: { cut, kept } says it had to (an empty cut has no film).
 */
export function deleteSelection(cut, list, ripple, mask) {
    // A clip on a locked track is not taken (nor a partner there); `mask` the tracks a ripple of V1 moves too.
    const locked = lockedTracks(cut);
    const items = withPartners(cut, list).filter((s) => !locked.has(selTrack(s)));
    const next = copy(cut);
    const gone = new Set(items.map(selId));
    for (const k of next.tracks) {
        const out = k.clips.map((c, i) => ({ c, drop: gone.has(k.id + ":" + i) }));
        const dropped = out.filter((o) => o.drop).map((o) => o.c);
        k.clips = out.filter((o) => !o.drop).map((o) => o.c);
        if (ripple) {
            for (const c of k.clips) {
                const before = dropped.filter((d) => num(d.at) + num(d.length) <= num(c.at) + 1e-6);
                c.at = round(num(c.at) - before.reduce((sum, d) => sum + num(d.length), 0));
            }
        }
    }
    next.texts = next.texts.filter((_, i) => !gone.has("T:" + i));
    next.sound = next.sound.filter((_, i) => !gone.has("A1:" + i));
    // V1 from the end: what is done there does not change the places before it. A gap before the clip it lies before.
    let cutNow = settle(next);
    let kept = false;
    const v1 = items.filter((s) => s.kind === "clip" || s.kind === "gap")
        .sort((a, b) => b.i - a.i || (a.kind === "gap" ? -1 : 1));
    for (const s of v1) {
        if (s.kind === "gap") { cutNow = closeGap(cutNow, s.i); continue; }
        if (cutNow.clips.length <= 1) { kept = true; continue; }
        cutNow = ripple ? rippleV1Remove(cutNow, s.i, mask) : liftV1(cutNow, s.i);
    }
    return { cut: cutNow, kept };
}

/**
 * Everything in `list` (with its linked partners) moved along the film by `delta`
 * seconds, together, nothing else moving: on V1 into the gaps beside it and no
 * further - it stops at a clip that is not moving, and at the start. Clips, texts;
 * the bed lies under the whole film and a gap is no thing to move, so they stay.
 * { cut, delta }: `delta` is how far it went, 0 where it is held.
 */
export function moveSelection(cut, list, delta) {
    const items = withPartners(cut, list);
    const starts = clipStarts(cut);
    const end = (j) => starts[j] + num(cut.clips[j].length);
    const v1 = items.filter((s) => s.kind === "clip").map((s) => s.i).sort((a, b) => a - b);
    let low = -Infinity, high = Infinity;
    const runs = [];
    for (const i of v1) {
        const run = runs[runs.length - 1];
        if (run && run[1] === i - 1) run[1] = i; else runs.push([i, i]);
    }
    for (const [a, b] of runs) {
        low = Math.max(low, -Math.max(0, starts[a] - (a ? end(a - 1) : 0)));
        if (cut.clips[b + 1]) high = Math.min(high, Math.max(0, starts[b + 1] - end(b)));
    }
    for (const s of items) {
        if (s.kind === "tclip") low = Math.max(low, -num(clipOf(cut, s).at));
        if (s.kind === "text") low = Math.max(low, -num(cut.texts[s.i].start));
    }
    const d = Math.max(low, Math.min(high, num(delta)));
    if (!d || !items.some((s) => s.kind === "clip" || s.kind === "tclip" || s.kind === "text")) return { cut, delta: 0 };
    const next = copy(cut);
    for (const [a, b] of runs) {
        for (let j = a; j <= b; j++) restart(next, j, starts[j] + d);
        if (next.clips[b + 1]) restart(next, b + 1, starts[b + 1]);
    }
    for (const s of items) {
        if (s.kind === "tclip") { const c = clipOf(next, s); c.at = round(num(c.at) + d); }
        if (s.kind === "text") next.texts[s.i].start = round(num(next.texts[s.i].start) + d);
    }
    return { cut: settle(next), delta: d };
}

/**
 * `clip` laid onto the placed track `id` from `at` (an overwrite): what was there
 * is cut away under it - covered clips go, one it overlaps is trimmed, one it
 * falls inside is cut in two - and nothing else moves. The clip is pushed last.
 */
export function overwriteTrack(cut, id, clip, at) {
    const next = copy(cut);
    const k = trackOf(next, id);
    if (!k) return next;
    const a = round(Math.max(0, num(at)));
    const b = round(a + Math.max(MIN_CLIP, num(clip.length)));
    const kept = [];
    for (const c0 of k.clips) {
        const s0 = num(c0.at), e0 = round(s0 + num(c0.length));
        if (e0 <= a + 1e-6 || s0 >= b - 1e-6) { kept.push(c0); continue; }
        if (s0 < a - 1e-6 && a - s0 >= MIN_CLIP - 1e-6) kept.push({ ...c0, length: round(a - s0) });
        if (e0 > b + 1e-6 && e0 - b >= MIN_CLIP - 1e-6) {
            const tail = { ...c0 };
            delete tail.uid;
            headCut(tail, b - s0);
            tail.length = round(e0 - b);
            tail.at = b;
            if (s0 < a - 1e-6) { delete tail.link; delete tail.unlinked; }
            if (c0.fx) tail.fx = splitFx(c0.fx, b - s0)[1];
            kept.push(tail);
        }
    }
    const mine = { ...clip, at: a };
    delete mine.gap; delete mine.transition;
    kept.push(mine);
    k.clips = kept;
    return settle(next);
}

/**
 * Several selected clips moved together, as Resolve's Selection mode moves them:
 * every one by the same `delta` seconds (held only at the start of the film) and
 * the same number of track `rows` on screen (positive: down - a picture towards
 * V1, a sound further down; a picture stays on a video track, a sound on a sound
 * track; past the top video or the bottom sound track a new track is made). They
 * are lifted first - gaps stay where they were - then laid down OVER what is at
 * their new place (overwriteV1 / overwriteTrack: covered clips go, overlapped ones
 * are trimmed, one a clip falls inside is split). A linked partner that was not
 * selected itself goes along in time, on its own track. Texts move in time.
 * Returns { cut, sel (the moved items' new selections), moved ({ oldId: sel }),
 * delta, rows } - or null when it would leave V1 without a shot.
 */
export function moveGroup(cut, list, delta, rows = 0) {
    const chosen = pruneSel(cut, list).filter((s) => isClipSel(s) || s.kind === "text");
    const items = withPartners(cut, chosen).filter((s) => isClipSel(s) || s.kind === "text");
    if (!items.length) return null;
    const own = new Set(chosen.map(selId));
    const vids = ["V1", ...((cut.tracks || []).filter((k) => k.kind !== "audio").map((k) => k.id))];   // bottom up
    const auds = (cut.tracks || []).filter((k) => k.kind === "audio").map((k) => k.id);                 // top down
    const starts = clipStarts(cut);
    const startOf = (s) => (s.kind === "clip" ? starts[s.i] : s.kind === "text" ? num(cut.texts[s.i].start) : num(clipOf(cut, s).at));
    const trackId = (s) => (s.kind === "clip" ? "V1" : s.track);
    const d = round(Math.max(num(delta), -Math.min(...items.map(startOf))));
    // The rows held per kind: no picture below V1, no sound above the first sound track. A
    // mixed group moved up takes its pictures up and leaves its sounds on the top sound track.
    const r0 = Math.round(num(rows));
    let rv = r0, ra = r0;
    for (const s of items) {
        if (!own.has(selId(s)) || s.kind === "text") continue;
        const v = vids.indexOf(trackId(s)), u = auds.indexOf(trackId(s));
        if (v >= 0) rv = Math.min(rv, v - (isTitleSel(cut, s) ? 1 : 0));        // a title stays above V1
        if (u >= 0) ra = Math.max(ra, -u) || 0;
    }
    // Lifted: V1 from the end (what follows stays where it is), the tracks from the end.
    let next = copy(cut);
    const v1 = items.filter((s) => s.kind === "clip").map((s) => s.i).sort((a, b) => b - a);
    const moving = items.filter((s) => s.kind !== "text").map((s, k) => ({ s, k, c: { ...clipOf(cut, s), __mv: k }, at: round(startOf(s) + d) }));
    // What stays on V1 stays where it was: each one's gap (or dissolve) from where the one before it now ends.
    const gone = new Set(v1);
    const stay = cut.clips.map((_, j) => j).filter((j) => !gone.has(j));
    next.clips = stay.map((j) => ({ ...cut.clips[j] }));
    let end = 0;
    stay.forEach((j, k) => {
        const c = next.clips[k];
        const g = round(starts[j] - end);
        if (g >= 0 || !k) { c.gap = Math.max(0, g); c.transition = 0; } else { c.gap = 0; c.transition = -g; }
        end = Math.max(end, round(starts[j] + num(c.length)));
    });
    for (const k of next.tracks) {
        const gone = new Set(items.filter((s) => s.kind === "tclip" && s.track === k.id).map((s) => s.i));
        k.clips = k.clips.filter((_, j) => !gone.has(j));
    }
    for (const s of items) if (s.kind === "text") next.texts[s.i].start = round(num(next.texts[s.i].start) + d);
    // Where each goes: the same rows down (or up) on its own kind of track; a partner on its own track.
    const dest = (m) => {
        const id = trackId(m.s);
        if (!own.has(selId(m.s))) return id;
        const v = vids.indexOf(id);
        if (v >= 0) return rv ? v - rv : id;            // an index past the top: a new video track
        const u = auds.indexOf(id);
        return u >= 0 && ra ? { audio: u + ra } : id;
    };
    const want = moving.map((m) => ({ ...m, to: dest(m) }));
    const topV = Math.max(-1, ...want.filter((m) => typeof m.to === "number").map((m) => m.to));
    const lowA = Math.max(-1, ...want.filter((m) => m.to && m.to.audio !== undefined).map((m) => m.to.audio));
    const vlist = [...vids], alist = [...auds];
    while (vlist.length <= topV) { next = addTrack(next, "video"); vlist.push(next.tracks[next.tracks.length - 1].id); }
    while (alist.length <= lowA) { next = addTrack(next, "audio"); alist.push(next.tracks[next.tracks.length - 1].id); }
    // Laid down from the earliest: over what is there.
    want.sort((x, y) => x.at - y.at);
    for (const m of want) {
        const id = typeof m.to === "number" ? vlist[m.to] : m.to && m.to.audio !== undefined ? alist[m.to.audio] : m.to;
        if (id === "V1") next = overwriteV1(next, m.c, m.at).cut;
        else next = overwriteTrack(next, id, m.c, m.at);
    }
    if (!next.clips.length) return null;
    // Find them again, and take the marks off.
    const moved = {}, sel = [];
    const found = (c, s) => {
        if (c.__mv === undefined) return;
        const m = moving[c.__mv];
        delete c.__mv;
        moved[selId(m.s)] = s;
        if (own.has(selId(m.s))) sel.push(s);
    };
    next.clips.forEach((c, i) => found(c, { kind: "clip", i }));
    for (const k of next.tracks) k.clips.forEach((c, i) => found(c, { kind: "tclip", track: k.id, i }));
    for (const s of items) if (s.kind === "text") { moved[selId(s)] = s; if (own.has(selId(s))) sel.push(s); }
    const hasV = want.some((m) => own.has(selId(m.s)) && vids.includes(trackId(m.s)));
    const hasA = want.some((m) => own.has(selId(m.s)) && auds.includes(trackId(m.s)));
    const rowsOut = hasV && hasA ? (r0 > 0 ? Math.max(rv, ra) : Math.min(rv, ra)) : hasV ? rv : hasA ? ra : 0;
    return { cut: settle(next), sel, moved, delta: d, rows: rowsOut, rowsVideo: hasV ? rv : 0, rowsAudio: hasA ? ra : 0 };
}

/**
 * What a marquee over `rows` (track ids, "V1", "T", "A1" among them) from `from`
 * to `to` seconds touches, as a selection list: clips, texts and the bed.
 */
export function marqueeSel(cut, rows, from, to) {
    const a = Math.min(num(from), num(to)), b = Math.max(num(from), num(to));
    const on = new Set(rows || []);
    const hits = (s, e) => s <= b + 1e-6 && e >= a - 1e-6;
    const out = [];
    if (on.has("V1")) clipStarts(cut).forEach((s, i) => { if (hits(s, s + num(cut.clips[i].length))) out.push({ kind: "clip", i }); });
    for (const k of (cut && cut.tracks) || []) {
        if (on.has(k.id)) k.clips.forEach((c, i) => { if (hits(num(c.at), num(c.at) + num(c.length))) out.push({ kind: "tclip", track: k.id, i }); });
    }
    if (on.has("T")) ((cut && cut.texts) || []).forEach((t, i) => { if (hits(num(t.start), num(t.start) + num(t.length))) out.push({ kind: "text", i }); });
    if (on.has("A1") && hits(0, filmLength(cut))) ((cut && cut.sound) || []).forEach((_, i) => out.push({ kind: "sound", i }));
    return out;
}

/**
 * A clip dragged into the empty room above the top video track (`kind` "video")
 * or below the bottom sound track ("audio"): a new track of that kind, with the
 * clip on it at `at`. Picture goes up, sound goes down. { cut, sel } or null.
 */
export function transferToNewTrack(cut, sel, kind, at, opts = {}) {
    if (selKind(cut, sel) !== kind) return null;
    const next = addTrack(cut, kind);
    return transferClip(next, sel, next.tracks[next.tracks.length - 1].id, at, opts);
}

// ── edit points ──────────────────────────────────────────────────────────────
//
// An edit point is what a press on a clip's edge, or Shift+A / Shift+S, selects:
// { act, sel, side, a, b }. `side` "end" is the outgoing edge, "start" the
// incoming; a roll names both clips of its cut and moves both edges.

/** The edit points of a track in time order: [{ t, a, b }], `a` the clip ending there, `b` the one beginning there. */
export function editStops(cut, track = "V1") {
    const items = [];
    if (track === "V1") clipStarts(cut).forEach((s, i) => items.push({ s, e: s + num(cut.clips[i].length), sel: { kind: "clip", i } }));
    else ((trackOf(cut, track) || { clips: [] }).clips).forEach((c, i) => items.push({ s: num(c.at), e: num(c.at) + num(c.length), sel: { kind: "tclip", track, i } }));
    const stops = [];
    const at = (t) => {
        let g = stops.find((o) => Math.abs(o.t - t) < 1e-3);
        if (!g) { g = { t: round(t), a: null, b: null }; stops.push(g); }
        return g;
    };
    for (const it of items) { at(it.s).b = it.sel; at(it.e).a = it.sel; }
    return stops.sort((x, y) => x.t - y.t);
}

/** The next stop from frame `from` in direction `dir` (-1 / 1), by frames; null at the end. */
export function nextStop(stops, from, dir, fps) {
    const f = (o) => Math.round(num(o.t) * (num(fps) > 0 ? num(fps) : 24));
    const list = stops || [];
    if (dir < 0) { const before = list.filter((o) => f(o) < from); return before[before.length - 1] || null; }
    return list.find((o) => f(o) > from) || null;
}

/** A stop as a selected edit point: both clips there, it is a roll; one, that clip's edge. */
export function stopPoint(stop) {
    if (stop.a && stop.b) return { act: "roll", sel: stop.b, side: "start", a: stop.a, b: stop.b };
    return stop.b ? { act: "trim-in", sel: stop.b, side: "start" } : { act: "trim-out", sel: stop.a, side: "end" };
}

/** What moving a selected edit point does in a mode: a roll stays one; an edge ripples in the Trim mode, and only trims in Selection. */
export function pointAct(point, trim) {
    if (point.act === "roll") return "roll";
    return (trim ? "ripple-" : "trim-") + (point.side === "end" ? "out" : "in");
}

// ── an insert at the playhead ────────────────────────────────────────────────

/**
 * Resolve's INSERT edit: `clips` ([{ file, name, length, in?, color? }], in
 * their order) go into the cut at the moment `seconds`, and what follows makes
 * room for them. On V1 ("V1", the default): a shot under the playhead is split
 * there (with its linked sound, splitWithLink) and the clips go between the
 * halves; at a cut they go in at that cut; in a gap they begin at that moment
 * (the rest of the gap stays after them); past the end, with a gap before them.
 * Everything that begins at or after the playhead on the OTHER tracks - placed
 * clips, sound clips, texts - moves on by the inserted length too, so the film
 * after the playhead stays together (the bed, under the whole film, stays).
 * A split refused (a frame from an end, inside a dissolve, a loop) puts them in
 * at the nearer end of that shot. On a placed video track `track`: its clip under
 * the playhead is split, the clips of that track from the playhead on move up,
 * the new ones are placed one after the other from the playhead; the other
 * tracks stay. Returns { cut, sel (the last clip put in), end (where the clips
 * put in end), split }.
 */
export function insertEdit(cut, clips, seconds, track = "V1", mask) {
    const follows = (id) => !mask || mask.has(id);
    const fps = num(cut && cut.fps) > 0 ? num(cut.fps) : 24;
    const t = toFrame(Math.max(0, num(seconds)), fps);
    const list = (clips || []).filter((c) => c && c.file && num(c.length) > 0);
    let next = copy(cut);
    if (!list.length) return { cut: next, sel: null, end: t, split: false };
    const fresh = list.map((c) => ({ file: String(c.file), name: String(c.name || ""), in: Math.max(0, num(c.in)),
                                     length: round(num(c.length)), transition: 0, color: String(c.color || ""), volume: 1 }));
    const total = round(fresh.reduce((s, c) => s + c.length, 0));
    let split = false;
    const k = track && track !== "V1" ? trackOf(next, track) : null;
    if (k && k.kind !== "audio") {
        const j = k.clips.findIndex((c) => t > num(c.at) + 1e-6 && t < num(c.at) + num(c.length) - 1e-6);
        if (j >= 0) {
            const got = splitWithLink(next, { kind: "tclip", track: k.id, i: j }, t);
            if (got) { next = got.cut; split = true; }
        }
        const kk = trackOf(next, k.id);
        // A clip the split refused stays where it is; everything from the playhead on moves up.
        for (const c of kk.clips) if (num(c.at) >= t - 1e-6) c.at = round(num(c.at) + total);
        let at = t;
        for (const c of fresh) { delete c.transition; kk.clips.push({ ...c, at }); at = round(at + c.length); }
        const done = settle(next);
        return { cut: done, sel: { kind: "tclip", track: k.id, i: trackOf(done, k.id).clips.length - 1 }, end: at, split };
    }
    // V1.
    const n = next.clips.length;
    const starts = clipStarts(next);
    const main = mainLength(next);
    let index = n, lead = 0;
    if (!n) { index = 0; lead = t; }
    else if (t >= main - 1e-6) { index = n; lead = round(Math.max(0, t - main)); }
    else {
        const g = gapAt(next, t);
        if (g >= 0) { index = g; lead = round(t - (starts[g] - num(next.clips[g].gap))); }
        else {
            const i = clipAt(next, t);
            if (i < 0) index = dropIndex(next, t);
            else if (Math.abs(t - starts[i]) < 1e-6) { index = i; lead = num(next.clips[i].gap); }
            else {
                const got = splitWithLink(next, { kind: "clip", i }, t);
                if (got) { next = got.cut; index = i + 1; split = true; }
                else if (t - starts[i] < num(next.clips[i].length) / 2) { index = i; lead = num(next.clips[i].gap); }
                else index = i + 1;
            }
        }
    }
    // Everything after the playhead on the other tracks moves on with the cut.
    for (const kk of next.tracks || []) if (follows(kk.id)) for (const c of kk.clips) if (num(c.at) >= t - 1e-6) c.at = round(num(c.at) + total);
    if (follows("T")) for (const x of next.texts || []) if (num(x.start) >= t - 1e-6) x.start = round(num(x.start) + total);
    const after = next.clips[index];
    if (after) after.gap = round(Math.max(0, num(after.gap) - lead));
    fresh[0].gap = lead;
    next.clips.splice(index, 0, ...fresh);
    const done = settle(next);
    const last = index + fresh.length - 1;
    return { cut: done, sel: { kind: "clip", i: last }, end: round(clipStarts(done)[last] + num(done.clips[last].length)), split };
}

/** Canvas nodes in the order an insert takes them: left to right by their place on the canvas, then top to bottom. */
export function canvasOrder(nodes) {
    const x = (n) => num(n && n.pos && n.pos[0]), y = (n) => num(n && n.pos && n.pos[1]);
    return [...(nodes || [])].filter(Boolean).sort((a, b) => x(a) - x(b) || y(a) - y(b));
}

// ── zoom about the playhead ──────────────────────────────────────────────────

/**
 * Where the strip scrolls to after a zoom so that the moment `t` keeps its x on
 * screen: `before` / `after` are { span (seconds the strip stands for), width
 * (its pixels), scroll (scrollLeft, before only) }, `view` the pixels visible.
 * A moment that was off screen is centred instead. { scroll, centred, x }.
 */
export function zoomScroll(t, before, after, view) {
    const x0 = before.span > 0 ? (num(t) / before.span) * num(before.width) - num(before.scroll) : 0;
    const xa = after.span > 0 ? (num(t) / after.span) * num(after.width) : 0;
    const on = x0 >= -0.5 && x0 <= num(view) + 0.5;
    const want = on ? xa - x0 : xa - num(view) / 2;
    const scroll = Math.max(0, Math.min(Math.max(0, num(after.width) - num(view)), want));
    return { scroll, centred: !on, x: xa - scroll };
}

// ── the two-up of a trim ─────────────────────────────────────────────────────

// The clip before / after `sel` on its track: V1 by the order, a placed track by time.
function neighbourOf(cut, sel, dir) {
    if (!sel) return null;
    if (sel.kind === "clip") { const j = sel.i + dir; return cut.clips[j] ? { kind: "clip", i: j } : null; }
    const k = trackOf(cut, sel.track);
    const c = k && k.clips[sel.i];
    if (!c) return null;
    const a = num(c.at), b = a + num(c.length);
    let best = -1, bestAt = dir < 0 ? -Infinity : Infinity;
    k.clips.forEach((o, j) => {
        if (j === sel.i) return;
        const s = num(o.at), e = s + num(o.length);
        if (dir < 0 && e <= a + 1e-3 && e > bestAt) { best = j; bestAt = e; }
        if (dir > 0 && s >= b - 1e-3 && s < bestAt) { best = j; bestAt = s; }
    });
    return best >= 0 ? { kind: "tclip", track: sel.track, i: best } : null;
}

/**
 * One frame at an edge of a clip: its FIRST or LAST frame on the timeline, and
 * the moment of its source shown there (retime and loop counted, srcLocal):
 * { sel, clip, frame (of the film), t, src (seconds of the source), srcFrame, still }.
 */
export function edgeFrame(cut, sel, which, fps) {
    const c = clipOf(cut, sel), span = c && selSpan(cut, sel);
    if (!c || !span) return null;
    const rate = num(fps) > 0 ? num(fps) : 24;
    const first = Math.round(span.start * rate);
    const frame = which === "last" ? Math.max(first, Math.round(span.end * rate) - 1) : first;
    const t = (frame + 0.5) / rate;
    const src = srcLocal(c, Math.max(0, t - span.start));
    return { sel, clip: c, frame, t: round(t), src, srcFrame: Math.floor(src * rate + 1e-6), still: isStillClip(c) };
}

/**
 * What the viewer shows side by side while an edit point is trimmed (Resolve's
 * trim view): `info` is the edit ({ act, sel, a, b, side }), `cut` the cut as it
 * now stands. A roll, a trim or ripple: the outgoing clip's LAST frame on the
 * left, the incoming one's FIRST on the right; a slip: the slipped clip's new
 * first and last frames; a slide: the clip before it (its last) and the one
 * after it (its first). { act, left, right } - a side with no clip is null.
 */
export function twoUpFrames(cut, info, fps) {
    if (!cut || !info || !info.sel) return null;
    const act = info.act;
    const at = (sel, which) => (sel ? edgeFrame(cut, sel, which, fps) : null);
    let left = null, right = null;
    if (act === "roll") { left = at(info.a, "last"); right = at(info.b, "first"); }
    else if (act === "slip") { left = at(info.sel, "first"); right = at(info.sel, "last"); }
    else if (act === "slide") { left = at(neighbourOf(cut, info.sel, -1), "last"); right = at(neighbourOf(cut, info.sel, 1), "first"); }
    else {
        const atIn = act === "ripple-in" || act === "trim-in" || (act === "retime" && info.side === "start");
        if (atIn) { left = at(neighbourOf(cut, info.sel, -1), "last"); right = at(info.sel, "first"); }
        else { left = at(info.sel, "last"); right = at(neighbourOf(cut, info.sel, 1), "first"); }
    }
    if (!left && !right) return null;
    return { act, left, right };
}

// ── Shift+A / Shift+S: each cut in three steps ───────────────────────────────

/**
 * The steps Shift+S walks through, in order: at every edit stop of a track, its
 * LEFT side (the outgoing clip's out), then BOTH (a roll, where two clips meet),
 * then its RIGHT side (the incoming clip's in) - only the ones that are there.
 * [{ t, stop, state: "left" | "both" | "right" }].
 */
export function editSteps(stops) {
    const out = [];
    for (const st of stops || []) {
        if (st.a) out.push({ t: st.t, stop: st, state: "left" });
        if (st.a && st.b) out.push({ t: st.t, stop: st, state: "both" });
        if (st.b) out.push({ t: st.t, stop: st, state: "right" });
    }
    return out;
}

/** A step as a selected edit point: left - the outgoing edge, right - the incoming one, both - a roll. */
export function stepPoint(step) {
    const st = step.stop;
    if (step.state === "both") return { act: "roll", sel: st.b, side: "start", a: st.a, b: st.b };
    if (step.state === "left") return { act: "trim-out", sel: st.a, side: "end" };
    return { act: "trim-in", sel: st.b, side: "start" };
}

/** The state of a selected edit point: "both" for a roll, "left" for an out-edge, "right" for an in-edge. */
export function pointState(point) {
    if (!point) return "";
    return point.act === "roll" ? "both" : point.side === "end" ? "left" : "right";
}

/**
 * The next step from where things stand (`dir` 1: Shift+S, -1: Shift+A). With a
 * selected edit point `point` at one of the steps, the one after (before) it;
 * without one, from the playhead's frame `from`: forwards the first step at or
 * after it (a cut the playhead stands on starts at its LEFT), backwards the last
 * at or before it (its RIGHT). Null at either end.
 */
export function nextEditStep(steps, point, from, dir, fps) {
    const rate = num(fps) > 0 ? num(fps) : 24;
    const f = (s) => Math.round(num(s.t) * rate);
    const state = pointState(point);
    let k = -1;
    if (point) {
        const ids = [point.sel, point.a, point.b].filter(Boolean).map(selId);
        k = steps.findIndex((s) => s.state === state && [s.stop.a, s.stop.b].filter(Boolean).some((x) => ids.includes(selId(x))) && (
            (state === "left" && sameSel(s.stop.a, point.sel)) || (state === "right" && sameSel(s.stop.b, point.sel)) ||
            (state === "both" && sameSel(s.stop.a, point.a) && sameSel(s.stop.b, point.b))));
    }
    if (k >= 0) return steps[k + (dir < 0 ? -1 : 1)] || null;
    if (dir < 0) { const before = steps.filter((s) => f(s) <= from); return before[before.length - 1] || null; }
    return steps.find((s) => f(s) >= from) || null;
}

// ── clips switched off (Resolve's Clip Enable, D) ────────────────────────────

/**
 * D: every clip of `list` switched off - or on again, when all of them were off
 * - with its linked partner (unless they are unlinked). A disabled clip stays
 * where it is and is drawn dimmed; it is neither seen nor heard: on V1 it is a
 * gap (pictureAt; the render's read_cut makes it a blank), on a track what is
 * under it shows, a sound clip is silent. In the file: metadata.imageviewer.disabled
 * and OTIO's own `enabled: false`. { cut, off (what it is now), count }.
 */
export function toggleDisabled(cut, list) {
    const items = withPartners(cut, list).filter(isClipSel);
    if (!items.length) return null;
    const off = !items.every((s) => clipOf(cut, s).disabled);
    const next = copy(cut);
    for (const s of items) { const c = clipOf(next, s); if (off) c.disabled = true; else delete c.disabled; }
    return { cut: settle(next), off, count: items.length };
}

// ── keyframe edits (each returns a new cut: one undo step) ───────────────────

/**
 * A clip's effect `fx` cut in two at clip time `at`: [the first piece's, the
 * second's], keys divided - the second's moved to its own clip time - with a key
 * at the cut on each side where a param is animated (its value there), so the
 * look does not jump.
 */
export function splitFx(fx, at) {
    const clean = cleanFx(fx);
    const a = { ...clean }, b = { ...clean };
    delete a.keys; delete b.keys;
    if (clean.keys) {
        const ka = {}, kb = {};
        const cut = round(num(at));
        for (const [p, list] of Object.entries(clean.keys)) {
            const v = keyValue(list, cut);
            const before = list.filter((k) => k.t < cut - 1e-6).map((k) => ({ ...k }));
            const after = list.filter((k) => k.t > cut + 1e-6).map((k) => ({ ...k, t: round(k.t - cut) }));
            const on = list.find((k) => Math.abs(k.t - cut) <= 1e-6);
            const prev = before.length ? before[before.length - 1] : null;
            const how = on && on.i ? on.i : prev && prev.i ? prev.i : "";
            ka[p] = [...before, { t: cut, v }];
            kb[p] = [{ t: 0, v, ...(how ? { i: how } : {}) }, ...after];
        }
        a.keys = cleanKeys(ka);
        b.keys = cleanKeys(kb);
    }
    return [a, b];
}

function withKeys(cut, sel, change) {
    const next = copy(cut);
    const c = clipOf(next, sel);
    if (!c) return next;
    const fx = cleanFx(c.fx);
    const keys = fx.keys ? JSON.parse(JSON.stringify(fx.keys)) : {};
    change(keys, c);
    fx.keys = keys;
    c.fx = cleanFx(fx);
    return next;
}

/** Keys at clip time `u` for the params of `values` ({ param: value }): added, or their values changed. */
export function setKeys(cut, sel, values, u) {
    const t = round(Math.max(0, num(u)));
    return withKeys(cut, sel, (keys) => {
        for (const [p, v] of Object.entries(values)) {
            if (!KEY_PARAMS.includes(p)) continue;
            const was = (keys[p] || []).find((k) => Math.abs(k.t - t) <= 1e-6);
            const list = (keys[p] || []).filter((k) => Math.abs(k.t - t) > 1e-6);
            list.push({ t, v: num(v), ...(was && was.i ? { i: was.i } : {}) });
            keys[p] = list;
        }
    });
}

/** The keys of `params` at clip time `u` taken out. */
export function removeKeys(cut, sel, params, u) {
    return withKeys(cut, sel, (keys) => {
        for (const p of params) if (keys[p]) keys[p] = keys[p].filter((k) => Math.abs(k.t - num(u)) > 1e-6);
    });
}

/** Does every one of `params` have a key at clip time `u`? */
export function keyedAt(c, params, u) {
    return params.every((p) => keysOf(c, p).some((k) => Math.abs(k.t - num(u)) <= 1e-6));
}

/**
 * The Inspector's diamond: every param of the row keyed at `u` - their keys go;
 * else a key for each at `u`, with the value it has there.
 */
export function toggleKeys(cut, sel, params, u) {
    const c = clipOf(cut, sel);
    if (!c) return copy(cut);
    if (keyedAt(c, params, u)) return removeKeys(cut, sel, params, u);
    const values = {};
    for (const p of params) values[p] = paramAt(c, p, u);
    return setKeys(cut, sel, values, u);
}

/**
 * A value changed in the Inspector, as Resolve's auto-key once a param is
 * animated: a param with keys gets a key at the playhead's clip time `u` (made
 * or changed), one without keys its static number. `patch` is { param: value }
 * (FX keys and flips; "vol" for the volume).
 */
export function autoKey(cut, sel, patch, u) {
    const c = clipOf(cut, sel);
    if (!c) return copy(cut);
    const keyed = {}, plain = {};
    for (const [p, v] of Object.entries(patch)) (KEY_PARAMS.includes(p) && keysOf(c, p).length ? keyed : plain)[p] = v;
    let next = cut;
    if (Object.keys(keyed).length) next = setKeys(next, sel, keyed, u);
    const vol = plain.vol;
    delete plain.vol;
    if (Object.keys(plain).length) next = setClipFx(next, sel, plain);
    if (vol !== undefined) next = setClipProps(next, sel, { volume: vol });
    return next === cut ? copy(cut) : next;
}

/** A row's reset: its keys gone, its static numbers neutral. */
export function clearKeys(cut, sel, params) {
    let next = withKeys(cut, sel, (keys) => { for (const p of params) delete keys[p]; });
    const fxs = params.filter((p) => FX[p]);
    if (fxs.length) next = resetClipFx(next, sel, fxs);
    if (params.includes("vol")) next = setClipProps(next, sel, { volume: 1 });
    return next;
}

/** Every moment the clip has a key at (any param, or only `params`), in order. */
export function keyTimes(c, params) {
    const set = new Set();
    for (const p of params || KEY_PARAMS) for (const k of keysOf(c, p)) set.add(k.t);
    return [...set].sort((a, b) => a - b);
}

/** The key moment before (`dir` -1) or after (1) clip time `u`, for `params`; null for none. */
export function nextKeyTime(c, params, u, dir) {
    const times = keyTimes(c, params);
    if (dir < 0) { const b = times.filter((t) => t < num(u) - 1e-6); return b.length ? b[b.length - 1] : null; }
    const a = times.find((t) => t > num(u) + 1e-6);
    return a === undefined ? null : a;
}

/** Every key at clip time `from` (of every param) moved to `to` - over a key there. */
export function moveKeysAt(cut, sel, from, to) {
    const t = round(Math.max(0, num(to)));
    return withKeys(cut, sel, (keys) => {
        for (const p of Object.keys(keys)) {
            const mine = keys[p].filter((k) => Math.abs(k.t - num(from)) <= 1e-6);
            if (!mine.length) continue;
            keys[p] = [...keys[p].filter((k) => Math.abs(k.t - num(from)) > 1e-6 && Math.abs(k.t - t) > 1e-6), ...mine.map((k) => ({ ...k, t }))];
        }
    });
}

/** How the keys at clip time `u` (of `params`, or all) go on to the next: "linear", "in", "out", "inout", "hold". */
export function setKeyInterp(cut, sel, params, u, how) {
    return withKeys(cut, sel, (keys) => {
        for (const p of params || Object.keys(keys)) {
            for (const k of keys[p] || []) if (Math.abs(k.t - num(u)) <= 1e-6) { if (how && how !== "linear") k.i = how; else delete k.i; }
        }
    });
}

/** The key's way of going on at clip time `u` (of `params`, or any): "linear" when they differ or none. */
export function keyInterpAt(c, params, u) {
    const hows = new Set();
    for (const p of params || KEY_PARAMS) for (const k of keysOf(c, p)) if (Math.abs(k.t - num(u)) <= 1e-6) hows.add(k.i || "linear");
    return hows.size === 1 ? [...hows][0] : "linear";
}

// ── Paste Attributes (Resolve's Alt+V) ───────────────────────────────────────
//
// A clip copied (Ctrl+C) is held as a SOURCE: the clip (or text) itself and what
// kind of thing it is. Its attributes - the ones checked - then go onto every
// selected target that can take them, as one new cut (one undo step). Keys are in
// clip time already (from the clip's first frame), so pasted they stand where they
// stood in the source, relative to the clip's start; keys past the target's end
// are cut off there, with a key at its end holding the value it had there.

export const PASTE_ATTRS = [
    { id: "zoom", group: "video", label: "Zoom", params: ["zx", "zy"], off: "toff" },
    { id: "position", group: "video", label: "Position", params: ["x", "y"], off: "toff" },
    { id: "anchor", group: "video", label: "Anchor Point", params: ["ax", "ay"], off: "toff" },
    { id: "rotation", group: "video", label: "Rotation Angle", params: ["rot"], off: "toff" },
    { id: "flip", group: "video", label: "Flip", flags: ["fh", "fv"], off: "toff" },
    { id: "crop", group: "video", label: "Cropping", params: ["cl", "cr", "ct", "cb"], off: "coff" },
    { id: "opacity", group: "video", label: "Opacity", params: ["op"], off: "ooff" },
    { id: "volume", group: "audio", label: "Volume", params: ["vol"] },
    { id: "fades", group: "audio", label: "Fade in / out" },
    { id: "afx", group: "afx", label: "Audio effects (the whole chain, in place of the target's)" },
    { id: "keys", group: "keys", label: "Include keyframes" },
    { id: "speed", group: "timing", label: "Speed" },
    { id: "name", group: "clip", label: "Name" },
    { id: "color", group: "clip", label: "Colour" },
    { id: "textlook", group: "text", label: "Text look (font, style, size, alignment, colours, box)" },
];
export const PASTE_GROUPS = [["video", "Video"], ["audio", "Audio"], ["afx", "Audio FX"], ["keys", "Keyframes"], ["timing", "Timing"], ["clip", "Clip"], ["text", "Text"]];

/** What a selected item is, for pasting: { clip, text, picture, sound, timed, bed }. */
export function pasteCaps(cut, sel) {
    if (sel && sel.kind === "text") return (cut.texts || [])[sel.i] ? { text: true } : null;
    // A clip of the music bed (A1): its fades, and the bed's effects (the track's chain); no volume, name or colour of its own.
    if (sel && sel.kind === "sound") return (cut.sound || [])[sel.i] ? { clip: false, picture: false, sound: true, timed: false, bed: true } : null;
    const c = clipOf(cut, sel);
    if (!c) return null;
    const picture = sel.kind === "clip" || (trackOf(cut, sel.track) || {}).kind !== "audio";
    if (c.title) return { clip: true, picture: true, sound: false, timed: false, text: true, title: true };
    const sound = (!picture) || (!isStill(c.file) && !c.mute);
    return { clip: true, picture, sound, timed: !isStillClip(c) };
}

/** The clipboard's entry for a selected clip or text: a copy of it and its caps (null for anything else). */
export function pasteSource(cut, sel) {
    const caps = pasteCaps(cut, sel);
    if (!caps) return null;
    let item = sel.kind === "text" ? cut.texts[sel.i] : sel.kind === "sound" ? { ...cut.sound[sel.i], afx: trackAfx(cut, "A1") } : clipOf(cut, sel);
    return { caps, item: JSON.parse(JSON.stringify(item)),
             name: String(item.name || item.text || (item.title && item.title.text) || String(item.file || "").split(/[\/]/).pop() || "clip").split("\n")[0] };
}

/** Can an item of caps `caps` have attribute `id`? */
export function pasteTakes(caps, id) {
    if (!caps) return false;
    const a = PASTE_ATTRS.find((x) => x.id === id);
    if (!a) return false;
    if (a.group === "video") return !!caps.picture;
    if (a.id === "volume" && caps.bed) return false;                // the bed has no volume of its own
    if (a.group === "audio" || a.group === "afx") return !!caps.sound;
    if (a.group === "timing") return !!caps.timed;
    if (a.group === "clip") return !!caps.clip;
    if (a.group === "text") return !!caps.text;
    return !!(caps.clip || caps.bed);                        // keys (the bed's are its effects')
}

/**
 * Which attributes the dialog offers: { id: { source, targets } } - does the
 * source have it, can any of the targets take it. "keys" needs keys on the source.
 */
export function pasteOffer(cut, source, targets) {
    const caps = targets.map((s) => pasteCaps(cut, s)).filter(Boolean);
    const out = {};
    for (const a of PASTE_ATTRS) {
        const has = !!source && pasteTakes(source.caps, a.id) && (a.id !== "keys" || hasKeys(source.item))
            && (a.id !== "afx" || cleanAfx(source.item.afx).length > 0);
        out[a.id] = { source: has, targets: caps.some((c) => pasteTakes(c, a.id)) };
    }
    return out;
}

/** Keys held to a clip `length` seconds long: those past it go, with one at its end holding the value there. */
export function clipKeysTo(list, length) {
    const len = round(Math.max(0, num(length)));
    const kept = (list || []).filter((k) => k.t <= len + 1e-6).map((k) => ({ ...k }));
    if ((list || []).some((k) => k.t > len + 1e-6) && !(kept.length && Math.abs(kept[kept.length - 1].t - len) <= 1e-6)) {
        kept.push({ t: len, v: keyValue(list, len) });
    }
    return kept;
}

/**
 * The attributes `picks` ({ id: true }) of `source` (pasteSource) set on every
 * target selection that can take them - one new cut. Without "keys", an
 * animated param is pasted as its value at the source's first frame, and the
 * target's own keys of that param go (else they would hide the number).
 */
export function pasteAttributes(cut, source, targets, picks) {
    let next = copy(cut);
    if (!source) return next;
    const src = source.item;
    const withKeys = !!picks.keys && hasKeys(src);
    for (const t of targets) {
        const caps = pasteCaps(next, t);
        if (!caps) continue;
        const want = (id) => !!picks[id] && pasteTakes(source.caps, id) && pasteTakes(caps, id);
        // A clip of the bed: its fades, and the bed's effects (one chain for the whole track).
        if (caps.bed) {
            if (want("fades")) { next = setFade(next, t, "in", num(src.fadeIn)); next = setFade(next, t, "out", num(src.fadeOut)); }
            if (want("afx")) next = setTrackAfx(next, "A1", cleanAfx(src.afx).map((fx) => (picks.keys ? fx : { ...fx, keys: {} })));
            continue;
        }
        if (caps.text && !caps.title) {
            if (want("textlook")) next = setTextLook(next, t.i, src.title ? { ...TEXT_LOOK, size: src.title.size, x: src.title.x, y: src.title.y, color: src.title.color } : textLook(src));
            continue;
        }
        // A title's look: everything but its words (from a title, or from a text of an older cut).
        if (caps.title && want("textlook")) {
            const { text: _words, ...look } = src.title ? cleanTitle(src.title) : titleFromText(src);
            next = setTitle(next, [t], look);
        }
        // The audio effects: the source's chain in place of the target's (their keys only with "keys").
        if (want("afx")) next = setClipAfx(next, t, cleanAfx(src.afx).map((fx) => (picks.keys ? fx : { ...fx, keys: {} })));
        if (want("fades")) { next = setFade(next, t, "in", num(src.fadeIn)); next = setFade(next, t, "out", num(src.fadeOut)); }
        // The speed first: it sets the length the keys are held to.
        if (want("speed") && Math.abs(speedOf(clipOf(next, t)) - speedOf(src)) > 1e-9) next = setSpeed(next, t, speedOf(src));
        const props = {};
        if (want("name")) props.name = src.name || "";
        if (want("color")) props.color = src.color || "";
        if (Object.keys(props).length) next = setClipProps(next, t, props);
        const c = clipOf(next, t);
        if (!c) continue;
        const fx = cleanFx(c.fx), sfx = cleanFx(src.fx);
        const keys = fx.keys ? JSON.parse(JSON.stringify(fx.keys)) : {};
        let volume;
        let touched = false;
        for (const a of PASTE_ATTRS) {
            if (!want(a.id) || (!a.params && !a.flags)) continue;
            touched = true;
            for (const p of a.params || []) {
                const list = keysOf(src, p);
                const value = list.length && !withKeys ? paramAt(src, p, 0) : (p === "vol" ? paramAt({ volume: src.volume }, "vol", 0) : (sfx[p] === undefined ? FX[p][0] : sfx[p]));
                if (p === "vol") volume = value; else fx[p] = value;
                if (withKeys && list.length) keys[p] = clipKeysTo(list, c.length);
                else delete keys[p];
            }
            for (const f of a.flags || []) fx[f] = !!sfx[f];
            if (a.off) fx[a.off] = !!sfx[a.off];
        }
        // The keys of a title's numbers go with its look.
        const tpatch = {};
        if (caps.title && want("textlook")) {
            for (const p of Object.keys(TITLE_KEYS)) {
                const list = keysOf(src, p);
                if (withKeys && list.length) keys[p] = clipKeysTo(list, c.length); else delete keys[p];
                if (list.length && !withKeys) tpatch[TITLE_KEYS[p]] = keyValue(list, 0);
                touched = true;
            }
        }
        if (!touched) continue;
        fx.keys = keys;
        const cleaned = cleanFx(fx);
        if (Object.keys(cleaned).length || c.fx) c.fx = cleaned;
        if (volume !== undefined) c.volume = round(Math.max(0, Math.min(1, num(volume, 1))));
        if (Object.keys(tpatch).length) next = setTitle(next, [t], tpatch);
    }
    return next;
}

// ── tracks for editing: Lock and the Auto Track Selector ────────────────────
//
// Resolve's two header controls beside the switch (off: not seen, not heard) and
// solo. LOCK: nothing on the track can be edited - not selected, dragged,
// trimmed, cut, deleted, landed on; played and rendered as ever. AUTO TRACK
// SELECTOR (on by default): the track takes part in the edits that reach beyond
// the clip they are made on - a ripple of V1 (Shift+Del, a ripple trim in the
// Trim mode) moves what follows on it too, an insert at the playhead makes room
// on it, the blade at the playhead (Ctrl+B / S, nothing selected there) cuts it,
// Paste Attributes reaches clips on it, Shift+A / S and Up / Down step through
// its edits. Off, it keeps its clips where they are. "V1", "A1" (the bed) and
// "T" (texts) keep them in cut.lock / cut.auto, the other tracks on themselves
// (k.lock, k.auto === false). In the file metadata.imageviewer.lock / auto_select.

/** The ids of the cut's tracks, "T", "V1" and "A1" among them. */
export function trackIds(cut) {
    return ["T", "V1", "A1", ...(((cut && cut.tracks) || []).map((k) => k.id))];
}

/** { lock, auto } of a track. */
export function trackFlags(cut, id) {
    if (id === "V1" || id === "A1" || id === "T") {
        return { lock: !!(cut && cut.lock && cut.lock[id]), auto: !(cut && cut.auto && cut.auto[id] === false) };
    }
    const k = trackOf(cut, id);
    return { lock: !!(k && k.lock), auto: !(k && k.auto === false) };
}

/** A track locked / unlocked (`flag` "lock") or its Auto Track Selector on / off ("auto"). */
export function setTrackFlag(cut, id, flag, on) {
    const next = copy(cut);
    if (flag !== "lock" && flag !== "auto") return next;
    if (id === "V1" || id === "A1" || id === "T") {
        if (flag === "lock") { if (on) next.lock[id] = true; else delete next.lock[id]; }
        else if (on) delete next.auto[id]; else next.auto[id] = false;
    } else {
        const k = trackOf(next, id);
        if (!k) return next;
        if (flag === "lock") { if (on) k.lock = true; else delete k.lock; }
        else if (on) delete k.auto; else k.auto = false;
    }
    return next;
}

/** The locked tracks' ids. */
export function lockedTracks(cut) {
    return new Set(trackIds(cut).filter((id) => trackFlags(cut, id).lock));
}

/** The tracks an edit that reaches beyond its own clip may change: Auto Track Selector on, not locked. */
export function editMask(cut) {
    return new Set(trackIds(cut).filter((id) => { const f = trackFlags(cut, id); return f.auto && !f.lock; }));
}

/** The track a selection is on ("V1", "T", "A1", a track id). */
export function selTrack(s) {
    if (!s) return "";
    if (s.kind === "clip" || s.kind === "gap" || s.kind === "mix") return "V1";
    if (s.kind === "text") return "T";
    if (s.kind === "sound") return "A1";
    return String(s.track || "");
}

// What a track holds, as a string: two cuts whose locked tracks give the same one left them alone.
function trackSig(cut, id) {
    const strip = (c) => { const o = { ...c }; delete o.uid; delete o.ref; return o; };
    if (id === "V1") { const st = clipStarts(cut); return JSON.stringify((cut.clips || []).map((c, i) => [st[i], strip(c)])); }
    if (id === "T") return JSON.stringify((cut.texts || []).map(strip));
    if (id === "A1") return JSON.stringify((cut.sound || []).map(strip));
    const k = trackOf(cut, id);
    return k ? JSON.stringify((k.clips || []).map(strip)) : "";
}

/** The first locked track (of `before`) that `after` changes - "" when the edit leaves every locked track alone. */
export function lockViolation(before, after) {
    if (!before || !after || before === after) return "";
    for (const id of lockedTracks(before)) {
        if (id !== "V1" && id !== "A1" && id !== "T" && !trackOf(after, id)) return id;    // a locked track is not removed
        if (trackSig(before, id) !== trackSig(after, id)) return id;
    }
    return "";
}

/** Only the selections that are not on a locked track. */
export function unlockedSel(cut, list) {
    const locked = lockedTracks(cut);
    return (list || []).filter((s) => !locked.has(selTrack(s)));
}

/**
 * What follows `from` on the tracks in `mask` (not V1, not the bed - which lies
 * under the whole film) moves by `delta` seconds, as a ripple of V1 takes the
 * film after it along: placed clips that begin at or after `from`, and texts. A
 * move back stops at a clip of the same track that stays (the track loses sync
 * there rather than have two clips on one moment), and at the film's start.
 */
export function rippleTracks(cut, from, delta, mask) {
    const next = copy(cut);
    const d0 = num(delta);
    if (!d0) return next;
    const on = (id) => !mask || mask.has(id);
    for (const k of next.tracks) {
        if (!on(k.id)) continue;
        const moving = k.clips.filter((c) => num(c.at) >= from - 1e-6);
        if (!moving.length) continue;
        let d = d0;
        if (d < 0) {
            const first = Math.min(...moving.map((c) => num(c.at)));
            const stays = k.clips.filter((c) => num(c.at) < from - 1e-6).map((c) => num(c.at) + num(c.length));
            const floor = Math.max(0, ...stays);
            d = Math.min(0, Math.max(d, floor - first));
        }
        for (const c of moving) c.at = round(num(c.at) + d);
    }
    if (on("T")) for (const t of next.texts) if (num(t.start) >= from - 1e-6) t.start = round(Math.max(0, num(t.start) + d0));
    return settle(next);
}

/** V1's clip i ripple-deleted (removeClip), the tracks in `mask` following: what began after it moves up by as much as V1 did. */
export function rippleV1Remove(cut, i, mask) {
    const c = cut && cut.clips && cut.clips[i];
    const next = removeClip(cut, i);
    if (!c || next.clips.length === cut.clips.length || !mask) return next;
    const end = clipStarts(cut)[i] + num(c.length);
    // How far what followed moved: the start of the clip after it, before and after.
    const was = cut.clips[i + 1] ? clipStarts(cut)[i + 1] : end;
    const now = next.clips[i] ? clipStarts(next)[i] : mainLength(next);
    return rippleTracks(next, round(Math.min(end, was)), round(now - was), mask);
}

/** After a ripple of V1's clip i (`before` -> `after`, its end moved), the tracks in `mask` follow by as much. */
export function rippleV1Follow(before, after, i, mask) {
    if (!mask || !before.clips[i] || !after.clips[i]) return after;
    const end0 = clipStarts(before)[i] + num(before.clips[i].length);
    const end1 = clipStarts(after)[i] + num(after.clips[i].length);
    const d = round(end1 - end0);
    return d ? rippleTracks(after, round(end0), d, mask) : after;
}

// ── audio transitions and fades ─────────────────────────────────────────────
//
// As Resolve's: a CROSSFADE between two sound clips that meet on one track - the
// cut of two films on V1 (their own sound: the picture still cuts; with a video
// dissolve there the dissolve already crosses the sound, so there is no
// crossfade), or two clips of a sound track - and FADES at a clip's start and end
// (the corner handles), on V1's films, on sound-track clips and on the bed.
//
// A crossfade lies on the clip coming IN: `xfade: { len, curve, align }`. It
// moves nothing - unlike V1's dissolve, which overlaps the clips and shortens the
// film - and takes its sound from beyond the cut, from the media the clips do not
// use (handles): `align` "centre" (half before the cut, half after), "start"
// (from the cut on: the clip going out plays on past its end) or "end" (up to
// the cut: the clip coming in begins before its start). Where there is not
// enough media the crossfade is made shorter, or put on the side that has it
// (fitXfade); none on either side, and there is none. `curve` "0" (Cross Fade
// 0 dB: straight lines, the two add up to the same level for the same sound),
// "+3" (the default: equal power, sin / cos - +3 dB in the middle against "0")
// and "-3" (x^1.5: -3 dB in the middle against "0"). `fadeIn` / `fadeOut` are
// seconds of the clip, straight lines of gain; a crossfade on a side takes the
// place of the fade there. A clip's gain at clip time u is envGain(audioEnv):
// the fades and crossfades, times its volume (keys and all). The render's
// timeline_io.env_gain is the same arithmetic (tests/test_edit_audio_xfade.py).

export const XF_CURVES = { "+3": "Cross Fade +3 dB", "0": "Cross Fade 0 dB", "-3": "Cross Fade -3 dB" };
export const XF_ALIGNS = { centre: "Centre on edit", start: "Start on edit", end: "End on edit" };
export const XF_DEFAULT = { len: 1, curve: "+3", align: "centre" };
export const MIN_XFADE = 0.02;

/** The gain of a fade coming in, `p` (0..1) of the way through, for a curve ("0", "+3", "-3"). */
export function curveGain(curve, p) {
    const x = Math.max(0, Math.min(1, num(p)));
    if (curve === "0") return x;
    if (curve === "-3") return Math.pow(x, 1.5);
    return Math.sin(x * Math.PI / 2);
}

/** A crossfade held to what one may be (null for none). */
export function cleanXfade(x) {
    if (!x || typeof x !== "object") return null;
    const len = round(num(x.len));
    if (!(len >= MIN_XFADE - 1e-9)) return null;
    return { len: Math.min(len, 60), curve: XF_CURVES[x.curve] ? String(x.curve) : "+3",
             align: XF_ALIGNS[x.align] ? String(x.align) : "centre" };
}

/** How much of a crossfade lies before the cut (`b`) and after it (`a`), in seconds. */
export function xfadeSides(x) {
    const L = num(x && x.len);
    if (x && x.align === "start") return { b: 0, a: L };
    if (x && x.align === "end") return { b: L, a: 0 };
    return { b: round(L / 2), a: round(L - round(L / 2)) };
}

// May this clip carry a crossfade or have one on its side (a sound that can run on: no loop, no picture)?
function xfadeable(c, v1) {
    return !!c && !loopOf(c) && !isStillImage(c.file) && !(v1 && (isStill(c.file) || c.mute));
}

/** The clip a crossfade into `sel` comes from: the one that ends where it begins on its track (a selection), or null. */
export function xfadeFrom(cut, sel) {
    if (!cut || !sel) return null;
    if (sel.kind === "clip") {
        const c = (cut.clips || [])[sel.i];
        if (!c || !sel.i || num(c.gap) > 0 || num(c.transition) > 0) return null;
        return xfadeable(c, true) && xfadeable(cut.clips[sel.i - 1], true) ? { kind: "clip", i: sel.i - 1 } : null;
    }
    if (sel.kind === "tclip") {
        const k = trackOf(cut, sel.track);
        const c = k && k.kind === "audio" ? k.clips[sel.i] : null;
        if (!xfadeable(c)) return null;
        const j = k.clips.findIndex((o, n) => n !== sel.i && Math.abs(num(o.at) + num(o.length) - num(c.at)) < 1e-3);
        return j >= 0 && xfadeable(k.clips[j]) ? { kind: "tclip", track: sel.track, i: j } : null;
    }
    return null;
}

/** The clip a crossfade out of `sel` goes into (one whose xfadeFrom is `sel`), or null. */
export function xfadeInto(cut, sel) {
    if (!cut || !sel) return null;
    if (sel.kind === "clip") {
        const n = { kind: "clip", i: sel.i + 1 };
        return (cut.clips || [])[sel.i + 1] && xfadeFrom(cut, n) ? n : null;
    }
    if (sel.kind === "tclip") {
        const k = trackOf(cut, sel.track);
        const c = k && k.clips[sel.i];
        if (!c) return null;
        const j = k.clips.findIndex((o, n) => n !== sel.i && Math.abs(num(c.at) + num(c.length) - num(o.at)) < 1e-3);
        if (j < 0) return null;
        const got = xfadeFrom(cut, { kind: "tclip", track: sel.track, i: j });
        return got && got.i === sel.i ? { kind: "tclip", track: sel.track, i: j } : null;
    }
    return null;
}

/** The clip a crossfade selection ({ kind: "xfade", track, i }) lies on. */
export function xfadeClipSel(x) {
    if (!x) return null;
    return x.track === "V1" ? { kind: "clip", i: x.i } : { kind: "tclip", track: x.track, i: x.i };
}

/** The crossfade selection of a clip coming in. */
export function xfadeSelOf(sel) {
    return sel && sel.kind === "clip" ? { kind: "xfade", track: "V1", i: sel.i }
        : sel && sel.kind === "tclip" ? { kind: "xfade", track: sel.track, i: sel.i } : null;
}

/** The crossfade a selection names, held to what it may be - or null. */
export function xfadeOf(cut, x) {
    const s = xfadeClipSel(x);
    const c = s && clipOf(cut, s);
    return c && c.xfade && xfadeFrom(cut, s) ? cleanXfade(c.xfade) : null;
}

/** Where a crossfade into `sel` can take its sound from: { before, after } seconds (the handles). */
export function xfadeRoom(cut, sel, durations) {
    const from = xfadeFrom(cut, sel);
    if (!from) return null;
    const inn = clipOf(cut, sel), out = clipOf(cut, from);
    const outIn = out.xfade && xfadeFrom(cut, from) ? xfadeSides(out.xfade).a : 0;
    const nx = xfadeInto(cut, sel);
    const inNext = nx && clipOf(cut, nx).xfade ? xfadeSides(clipOf(cut, nx).xfade).b : 0;
    return { before: Math.max(0, Math.min(inRoom(inn), num(out.length) - outIn)),
             after: Math.max(0, Math.min(outRoom(out, durations), num(inn.length) - inNext)) };
}

/**
 * A crossfade of `want` ({ len, curve, align }) as it fits `room` (xfadeRoom):
 * as long as asked where there is media for it, shorter where there is less, on
 * the side that has some where its own side has none - null where neither has.
 */
export function fitXfade(want, room) {
    const x = cleanXfade({ ...XF_DEFAULT, ...want }) || cleanXfade({ ...XF_DEFAULT, ...want, len: MIN_XFADE });
    if (!x || !room) return null;
    const most = (al) => (al === "start" ? room.after : al === "end" ? room.before : 2 * Math.min(room.before, room.after));
    let align = x.align;
    if (most(align) < MIN_XFADE - 1e-9) {
        const best = ["centre", "end", "start"].sort((p, q) => most(q) - most(p))[0];
        if (most(best) < MIN_XFADE - 1e-9) return null;
        align = best;
    }
    return { len: round(Math.max(MIN_XFADE, Math.min(x.len, most(align)))), curve: x.curve, align };
}

/**
 * An audio crossfade added at the cut into clip `sel` (or changed: `opts` the
 * parts that change). { cut, sel (the crossfade's selection), fitted (it was made
 * shorter or moved) } - or { error } where there can be none.
 */
export function addAudioXfade(cut, sel, opts = {}, durations) {
    const c = clipOf(cut, sel);
    if (!c) return { error: "no clip" };
    if (!xfadeFrom(cut, sel)) {
        return { error: sel.kind === "clip" && num(c.transition) > 0 ? "the dissolve there already crosses the sound"
            : sel.kind === "clip" && num(c.gap) > 0 ? "there is a gap before it: no clip to cross from"
            : "no sound clip ends where this one begins" };
    }
    const want = { ...XF_DEFAULT, ...(c.xfade ? cleanXfade(c.xfade) : {}), ...opts };
    const got = fitXfade(want, xfadeRoom(cut, sel, durations));
    if (!got) return { error: "not enough media beyond the cut for a crossfade (the clips use all of their files there)" };
    const next = copy(cut);
    clipOf(next, sel).xfade = got;
    const done = settle(next);
    return { cut: done, sel: xfadeSelOf(sel), fitted: got.len < num(want.len) - 1e-6 || got.align !== want.align };
}

/** The crossfade a selection names taken away (the cut is a plain cut again). */
export function removeAudioXfade(cut, x) {
    const next = copy(cut);
    const c = clipOf(next, xfadeClipSel(x));
    if (c) delete c.xfade;
    return settle(next);
}

/** A clip's (or the bed's: { kind: "sound", i }) fade in or out, `which` "in" / "out", in seconds of the clip. */
export function setFade(cut, sel, which, seconds) {
    const next = copy(cut);
    const c = sel && sel.kind === "sound" ? (next.sound || [])[sel.i] : clipOf(next, sel);
    if (!c) return next;
    const key = which === "out" ? "fadeOut" : "fadeIn";
    const v = round(Math.max(0, num(seconds)));
    if (v > 0) c[key] = v; else delete c[key];
    // A crossfade on that side takes the fade's place: putting a fade there takes the crossfade away.
    if (v > 0 && sel.kind !== "sound") {
        if (which === "in" && c.xfade) delete c.xfade;
        if (which === "out") { const n = xfadeInto(cut, sel); if (n) delete clipOf(next, n).xfade; }
    }
    if (sel.kind === "sound") {
        const len = filmLength(next);
        let fi = num(c.fadeIn), fo = num(c.fadeOut);
        if (fi + fo > len && len > 0) { const k = len / (fi + fo); fi = round(fi * k); fo = round(fo * k); }
        if (fi > 0) c.fadeIn = fi; else delete c.fadeIn;
        if (fo > 0) c.fadeOut = fo; else delete c.fadeOut;
    }
    return settle(next);
}

// Fades and crossfades held to their clips (from settle): a fade no longer than the clip, the two no
// longer than it together; a crossfade only where two sound clips still meet, no longer than they
// allow; a fade on a crossfade's side gone.
function tidyAudio(cut) {
    const fades = (c, len) => {
        let fi = round(Math.max(0, num(c.fadeIn))), fo = round(Math.max(0, num(c.fadeOut)));
        if (fi + fo > len) { const k = len / (fi + fo); fi = round(fi * k); fo = round(fo * k); }
        if (fi > 0) c.fadeIn = fi; else delete c.fadeIn;
        if (fo > 0) c.fadeOut = fo; else delete c.fadeOut;
    };
    const each = (c, sel) => {
        if (!c.xfade) return;
        const x = cleanXfade(c.xfade);
        const from = x && xfadeFrom(cut, sel);
        if (!from) { delete c.xfade; return; }
        const out = clipOf(cut, from);
        const s = xfadeSides(x);
        const scale = Math.min(1, s.b > 0 ? num(out.length) / s.b : 1, s.a > 0 ? num(c.length) / s.a : 1);
        x.len = round(Math.max(MIN_XFADE, x.len * scale));
        c.xfade = x;
        delete c.fadeIn;
        delete out.fadeOut;
    };
    cut.clips.forEach((c) => fades(c, num(c.length)));
    for (const k of cut.tracks || []) for (const c of k.clips) fades(c, num(c.length));
    for (const s of cut.sound || []) {
        for (const key of ["fadeIn", "fadeOut"]) { const v = round(Math.max(0, num(s[key]))); if (v > 0) s[key] = v; else delete s[key]; }
    }
    cut.clips.forEach((c, i) => each(c, { kind: "clip", i }));
    for (const k of cut.tracks || []) k.clips.forEach((c, i) => each(c, { kind: "tclip", track: k.id, i }));
}

// What of a clip's sound the cut's comparison (sameCut) looks at.
function audioDress(c) {
    return [round(num(c.fadeIn)), round(num(c.fadeOut)), c.xfade ? JSON.stringify(cleanXfade(c.xfade)) : ""];
}

/**
 * A clip's fades and crossfades as its gain is worked out (envGain): { len, fi, fo,
 * xin, xout }, `xin` / `xout` the crossfades into and out of it ({ b, a, curve }).
 * `sel` a clip's selection, or { kind: "sound", i } for the bed.
 */
export function audioEnv(cut, sel) {
    if (sel && sel.kind === "sound") {
        const s = ((cut && cut.sound) || [])[sel.i];
        return { len: filmLength(cut), fi: num(s && s.fadeIn), fo: num(s && s.fadeOut), xin: null, xout: null };
    }
    const c = clipOf(cut, sel);
    if (!c) return null;
    const env = { len: num(c.length), fi: num(c.fadeIn), fo: num(c.fadeOut), xin: null, xout: null };
    if (c.xfade && xfadeFrom(cut, sel)) { const x = cleanXfade(c.xfade); if (x) { env.xin = { ...xfadeSides(x), curve: x.curve }; env.fi = 0; } }
    const nx = xfadeInto(cut, sel);
    const n = nx && clipOf(cut, nx);
    if (n && n.xfade) { const x = cleanXfade(n.xfade); if (x) { env.xout = { ...xfadeSides(x), curve: x.curve }; env.fo = 0; } }
    return env;
}

/** Does a clip's sound rise or fall anywhere (a fade or a crossfade)? */
export function envActive(env) {
    return !!env && (env.fi > 0 || env.fo > 0 || !!env.xin || !!env.xout);
}

/**
 * The gain of the fades and crossfades at clip time `u` (from -xin.b, the handle
 * before a crossfade coming in, to len + xout.a): 0 outside, 1 where nothing fades.
 */
export function envGain(env, u) {
    if (!env) return 1;
    const t = num(u), len = num(env.len);
    const lo = env.xin ? -num(env.xin.b) : 0, hi = env.xout ? len + num(env.xout.a) : len;
    if (t < lo - 1e-9 || t > hi + 1e-9) return 0;
    let g = 1;
    if (env.xin) {
        const L = num(env.xin.b) + num(env.xin.a);
        if (L > 0 && t < num(env.xin.a)) g *= curveGain(env.xin.curve, (t + num(env.xin.b)) / L);
    } else if (env.fi > 0 && t < env.fi) g *= Math.max(0, t) / env.fi;
    if (env.xout) {
        const L = num(env.xout.b) + num(env.xout.a), s = len - num(env.xout.b);
        if (L > 0 && t > s) g *= curveGain(env.xout.curve, 1 - (t - s) / L);
    } else if (env.fo > 0 && t > len - env.fo) g *= Math.max(0, len - t) / env.fo;
    return Math.max(0, Math.min(1, g));
}

/** The moment of a clip's source at clip time `u`, a crossfade's handle before it included (u < 0). */
export function srcAt(c, u) {
    return num(u) < 0 ? round(num(c && c.in) + num(u) * speedOf(c)) : srcLocal(c, u);
}

/** The crossfades of the cut, for drawing: [{ sel, track, cutAt, start, len, b, a, curve, align, left, width, title }] (% of `total`). */
export function xfadeBars(cut, total) {
    const out = [];
    const T = num(total) > 0 ? num(total) : filmLength(cut);
    const add = (sel, at, c) => {
        if (!c.xfade || !xfadeFrom(cut, sel)) return;
        const x = cleanXfade(c.xfade);
        if (!x) return;
        const s = xfadeSides(x);
        const start = round(at - s.b);
        out.push({ sel: xfadeSelOf(sel), track: sel.kind === "clip" ? "V1" : sel.track, cutAt: at, start, len: x.len, ...s,
                   curve: x.curve, align: x.align, left: pct(start / T * 100), width: pct(x.len / T * 100),
                   title: `${XF_CURVES[x.curve]}, ${lengthLabel(x.len)} (${XF_ALIGNS[x.align].toLowerCase()}) - drag an edge to make it longer or shorter, Del takes it away` });
    };
    const starts = clipStarts(cut);
    ((cut && cut.clips) || []).forEach((c, i) => add({ kind: "clip", i }, starts[i], c));
    for (const k of (cut && cut.tracks) || []) (k.clips || []).forEach((c, i) => add({ kind: "tclip", track: k.id, i }, num(c.at), c));
    return out;
}

/** The cut nearest `seconds` on a track where a crossfade can go: the clip coming in (a selection), or null. */
export function xfadeCutNear(cut, track, seconds, within = Infinity) {
    let best = null, gap = within;
    const t = num(seconds);
    const look = (sel, at) => { const d = Math.abs(at - t); if (d <= gap && xfadeFrom(cut, sel)) { best = sel; gap = d; } };
    if (track === "V1") { const st = clipStarts(cut); (cut.clips || []).forEach((_, i) => look({ kind: "clip", i }, st[i])); }
    else { const k = trackOf(cut, track); if (k) k.clips.forEach((c, i) => look({ kind: "tclip", track, i }, num(c.at))); }
    return best;
}

// ── the volume line (Media Composer's / Resolve's rubber band) ──────────────
//
// One line across a sound clip at its level: its points ARE the volume keys of
// the Inspector (fx.keys.vol, clip time, eases and all) - no second model. A
// clip without keys has a flat line at its volume. The line is drawn on a dB
// scale (VOL_DB_FLOOR .. 0 dB, 0 at the top), as editors draw it.

export const VOL_DB_FLOOR = -60;

/** A gain (0..1) as dB; -Infinity for silence. */
export function volDb(v) { return num(v) > 0 ? 20 * Math.log10(num(v)) : -Infinity; }

/** dB as a gain (0..1). */
export function dbVol(db) { return num(db) <= VOL_DB_FLOOR ? 0 : Math.min(1, Math.pow(10, num(db) / 20)); }

/** Where a gain lies on the line's height: 0 at the top (0 dB), 1 at the bottom (VOL_DB_FLOOR and below). */
export function volY(v) { const db = volDb(v); return db <= VOL_DB_FLOOR ? 1 : Math.max(0, Math.min(1, db / VOL_DB_FLOOR)); }

/** The gain a height on the line stands for (volY the other way round). */
export function yVol(y) { const s = Math.max(0, Math.min(1, num(y))); return s >= 1 ? 0 : dbVol(s * VOL_DB_FLOOR); }

/** A dB readout: "-6.0 dB", "-inf dB". */
export function dbLabel(v) { const db = volDb(v); return Number.isFinite(db) ? `${db >= 0 ? "" : ""}${db.toFixed(1)} dB` : "-inf dB"; }

/**
 * The line of a clip `length` long, sampled for drawing: [{ u, v }] - the keys
 * and, between them, `steps` points per stretch (an ease is a curve); flat at
 * the clip's volume without keys.
 */
export function volLine(c, length, steps = 8) {
    const keys = keysOf(c, "vol");
    const len = Math.max(0, num(length, num(c && c.length)));
    if (!keys.length) { const v = num(c && c.volume, 1); return [{ u: 0, v }, { u: len, v }]; }
    const out = [{ u: 0, v: paramAt(c, "vol", 0) }];
    const stops = [...keys.map((k) => k.t).filter((t) => t > 0 && t < len), len];
    let from = 0;
    for (const t of stops) {
        for (let k = 1; k <= steps; k++) { const u = from + (t - from) * k / steps; out.push({ u: round(u), v: paramAt(c, "vol", u) }); }
        from = t;
    }
    return out;
}

/** The volume keys of a clip, for its points: [{ t, v, i }]. */
export function volPoints(c) { return keysOf(c, "vol").map((k) => ({ ...k })); }

/** The line dragged up or down (no point under it): flat - the clip's volume; with keys, every point by the same dB. */
export function setVolLine(cut, sel, v, at) {
    const c = clipOf(cut, sel);
    if (!c) return copy(cut);
    const keys = keysOf(c, "vol");
    if (!keys.length) return setClipProps(cut, sel, { volume: Math.max(0, Math.min(1, num(v))) });
    const was = paramAt(c, "vol", num(at));
    const ddb = (num(v) > 0 ? volDb(num(v)) : VOL_DB_FLOOR) - (was > 0 ? volDb(was) : VOL_DB_FLOOR);
    return withKeys(cut, sel, (k) => {
        k.vol = (k.vol || []).map((p) => ({ ...p, v: round(Math.max(0, Math.min(1, p.v > 0 ? dbVol(volDb(p.v) + ddb) : dbVol(VOL_DB_FLOOR + ddb)))) }));
    });
}

/** A point added on the line at clip time `u` (Alt-click), at the line's level there. */
export function addVolPoint(cut, sel, u) {
    const c = clipOf(cut, sel);
    if (!c) return copy(cut);
    return setKeys(cut, sel, { vol: paramAt(c, "vol", u) }, u);
}

/** The point at clip time `from` moved to `to`, at gain `v` (its ease kept); `to` held between its neighbours. */
export function moveVolPoint(cut, sel, from, to, v) {
    const c = clipOf(cut, sel);
    if (!c) return copy(cut);
    const keys = keysOf(c, "vol");
    const i = keys.findIndex((k) => Math.abs(k.t - num(from)) <= 1e-6);
    if (i < 0) return copy(cut);
    const lo = i > 0 ? keys[i - 1].t + 1e-3 : 0, hi = i + 1 < keys.length ? keys[i + 1].t - 1e-3 : num(c.length);
    const t = round(Math.max(lo, Math.min(hi, num(to))));
    return withKeys(cut, sel, (k) => {
        const list = (k.vol || []).filter((p) => Math.abs(p.t - num(from)) > 1e-6);
        list.push({ t, v: round(Math.max(0, Math.min(1, num(v)))), ...(keys[i].i ? { i: keys[i].i } : {}) });
        k.vol = list.sort((a, b) => a.t - b.t);
    });
}

/** The point at clip time `u` taken away (Delete, or Alt-click on it). */
export function removeVolPoint(cut, sel, u) { return removeKeys(cut, sel, ["vol"], u); }

// ── sound effects on clips and tracks (imageViewer_audioFxData.js is what an effect is) ──

/** Can a selection carry sound effects: a clip of a sound track, or a film of V1 / a video track that sounds. */
export function afxTakes(cut, sel) {
    const c = clipOf(cut, sel);
    if (!c || c.title) return false;
    if (sel.kind === "tclip" && (trackOf(cut, sel.track) || {}).kind === "audio") return true;
    return !isStill(c.file) && !c.mute;
}

/** A clip's effects (a clean chain). */
export function clipAfx(cut, sel) { const c = clipOf(cut, sel); return c ? cleanAfx(c.afx) : []; }

/** A clip's effects replaced by `list`. */
export function setClipAfx(cut, sel, list) {
    const next = copy(cut);
    const c = clipOf(next, sel);
    if (!c) return next;
    const chain = cleanAfx(list);
    if (chain.length) c.afx = chain; else delete c.afx;
    return next;
}

/** May track `id` carry effects: a sound track, or the bed (A1). */
export function afxTrack(cut, id) {
    return id === "A1" || (trackOf(cut, id) || {}).kind === "audio";
}

/** A track's effects ("A1": the bed's). */
export function trackAfx(cut, id) {
    if (id === "A1") return cleanAfx(cut && cut.afx && cut.afx.A1);
    return cleanAfx((trackOf(cut, id) || {}).afx);
}

/** A track's effects replaced by `list`. */
export function setTrackAfx(cut, id, list) {
    const next = copy(cut);
    const chain = cleanAfx(list);
    if (id === "A1") { if (chain.length) next.afx.A1 = chain; else delete next.afx.A1; return next; }
    const k = trackOf(next, id);
    if (!k || k.kind !== "audio") return next;
    if (chain.length) k.afx = chain; else delete k.afx;
    return next;
}

/** A chain's keys moved by `d` seconds (a clip's keys after a split: the second piece's own time). */
export function shiftAfx(list, d) {
    return cleanAfx((list || []).map((fx) => ({ ...fx, keys: Object.fromEntries(Object.entries((fx && fx.keys) || {})
        .map(([k, ks]) => [k, (ks || []).map((x) => ({ ...x, t: x.t + num(d) })).filter((x) => x.t >= 0)])) })));
}

/** Does anything in the cut have effects that are on? */
export function cutHasAfx(cut) {
    if (!cut) return false;
    if (afxActive(cleanAfx(cut.afx && cut.afx.A1))) return true;
    if ((cut.clips || []).some((c) => afxActive(cleanAfx(c.afx)))) return true;
    return (cut.tracks || []).some((k) => afxActive(cleanAfx(k.afx)) || (k.clips || []).some((c) => afxActive(cleanAfx(c.afx))));
}
