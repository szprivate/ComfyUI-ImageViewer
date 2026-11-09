// imageViewer_editAudio.js
// The Edit panel's sound beyond playing: SCRUBBING (short grains of the mixed
// cut at the playhead while it is dragged or jogged, pitched with the speed of
// the drag, as Resolve and Premiere scrub) and the two switches of the bar,
// as Resolve has them: audio playback on / off (Ctrl+Shift+M) and audio
// scrubbing on / off (Shift+M). Off, playback is silent too: every element of
// the player is at volume 0 (imageViewer_editPlay.js asks _editAudioGain).
// The export is not touched by either.
//
// How a grain is made: each file's sound is read ONCE - from the server, mono
// at SR already (/imageviewer/timeline_pcm, 16-bit: a minute is 2.6 MB, where
// a film's own bytes were fetched whole before, for its sound) or, from an
// older server, fetched whole and decoded here (the browser's decodeAudioData,
// off the main thread, mixed down to mono at SR on an OfflineAudioContext) - kept in a cache capped at
// CACHE_BYTES (the least recently used go first). A grain is GRAIN seconds of
// wall time: its samples are the cut's mix at the playhead - every source heard
// there (scrubSources: the picture on top and, in a dissolve, the one going
// out, the bed, the sound-track clips; volumes, mutes, solos, switched-off
// tracks, retime and loop as the player has them), read forwards or backwards,
// over GRAIN x rate seconds of the timeline - played at `rate` = the speed of
// the drag (clamped MIN_RATE .. MAX_RATE). Its ends fade over FADE and the next
// one starts FADE before this one ends, so the grains cross-fade without a
// click. A grain is only made when the pointer (or the key) moved: still, the
// last one runs out within GRAIN and it is silent. No grain while the cut plays.
// The AudioContext is made at the first scrub, which is a user's gesture.
//
// The arithmetic (scrubRate, planGrain, scrubSources, fillGrain) is pure and
// tested under node (tests/test_edit_insert_zoom_scrub.mjs).
import * as D from "./imageViewer_editTimelineData.js";
import { setEditIcon } from "./imageViewer_editIcons.js";

export const SCRUB = {
    grain: 0.05,        // seconds of wall time per grain
    fade: 0.012,        // its fade in / out, and the overlap of two grains
    minRate: 0.25,
    maxRate: 4,
    fresh: 0.2,         // seconds: a feed later than this after the last one is a new start (a step: rate 1)
    sr: 22050,          // the rate the sources are kept at (mono)
};
export const CACHE_BYTES = 300 * 1024 * 1024;
const STORE = "imageviewer.viewer.editAudio";

/**
 * The rate of a grain from two looks at the playhead, `prev` and `cur` ({ t
 * seconds of the film, ms wall clock }): the speed of the move, clamped, and
 * its direction - or null when it did not move (silence). With no look before
 * it (or one too long ago) a move is a STEP: a grain at rate 1.
 */
export function scrubRate(prev, cur, opt = SCRUB) {
    if (!cur) return null;
    const fresh = !prev || !(cur.ms - prev.ms > 0) || (cur.ms - prev.ms) / 1000 > opt.fresh;
    const dt = prev ? cur.t - prev.t : 0;
    if (fresh) return prev && Math.abs(dt) < 1e-9 && cur.ms - prev.ms <= opt.fresh * 1000 ? null
        : { rate: 1, dir: dt < 0 ? -1 : 1, step: true };
    if (Math.abs(dt) < 1e-9) return null;
    const v = Math.abs(dt) / ((cur.ms - prev.ms) / 1000);
    return { rate: Math.round(Math.max(opt.minRate, Math.min(opt.maxRate, v)) * 1000) / 1000, dir: dt < 0 ? -1 : 1, step: false };
}

/**
 * Whether to make a grain now and when it starts: `until` is when the sound
 * queued so far ends, `clock` the audio clock (both seconds). A grain waits
 * while the one before has more than its fade to run (the pointer moves faster
 * than grains last); else it begins as that one fades. { rate, dir, start,
 * samples } or { wait: true } or null (no move: silence).
 */
export function planGrain(prev, cur, until, clock, opt = SCRUB) {
    const r = scrubRate(prev, cur, opt);
    if (!r) return null;
    if (until - clock > opt.fade + 0.01) return { wait: true, ...r };
    const start = Math.max(clock + 0.005, until - opt.fade);
    return { ...r, start, samples: Math.max(1, Math.round(opt.grain * r.rate * opt.sr)) };
}

/** The moment of a clip's source `u` seconds into it - srcLocal without its rounding (a grain reads samples). */
export function srcAt(c, u) {
    const q = Math.max(0, Number(u) || 0) * D.speedOf(c);
    const mode = D.loopOf(c), span = Number(c && c.span) || 0;
    const base = Number(c && c.in) || 0;
    const motion = D.motionOf(c);
    if (motion === "freeze") return base;
    if (motion === "reverse") return Math.max(0, base - q);
    if (D.rampOf(c).length) return base + D.rampAdvance(D.rampOf(c), u);
    if (!mode) return base + q;
    if (mode === "loop") return base + (q % span);
    const p = q % (2 * span);
    return base + (p < span ? p : 2 * span - p);
}

// (Frozen and reversed clips are silent, as in playback.)
const audible = (c) => { const sp = D.speedOf(c); return sp >= 0.25 && sp <= 4 && !D.motionOf(c) && !D.rampOf(c).length; };

/**
 * Every source heard at `seconds` of the cut, as the player hears it: the
 * picture on top (pictureAt; a still has none, a muted clip is at 0), the clip
 * going out of a dissolve, the bed (A1) and the clips of the live sound tracks.
 * [{ file, gain, clip, origin, start, end }] - the source's moment at the film's
 * moment τ is srcAt(clip, τ - origin), heard while start <= τ < end.
 */
export function scrubSources(cut, seconds, live) {
    const out = [];
    if (!cut) return out;
    const t = Number(seconds) || 0;
    const pic = D.pictureAt(cut, t, live);
    if (pic && pic.clip && !D.isStill(pic.clip.file)) {
        const a = pic.under && !pic.over ? Math.max(0, Math.min(1, Number(pic.mix) || 0)) : 1;
        const g = D.clipVolume(pic.clip) * a * (audible(pic.clip) ? 1 : 0);
        if (g > 0) out.push({ file: pic.clip.file, gain: g, clip: pic.clip, origin: pic.origin, start: pic.origin, end: pic.origin + Number(pic.clip.length || 0), key: pic.key });
        const u = pic.under;
        if (u && u.clip && !pic.over && !D.isStill(u.clip.file)) {
            const gu = D.clipVolume(u.clip) * (1 - a) * (audible(u.clip) ? 1 : 0);
            if (gu > 0) out.push({ file: u.clip.file, gain: gu, clip: u.clip, origin: u.origin, start: u.origin, end: u.origin + Number(u.clip.length || 0), key: u.key });
        }
    }
    for (const s of D.soundItems(cut, live)) {
        if (!(t >= s.at - 1e-6 && t < s.at + s.length - 1e-6)) continue;
        const clip = s.clip || { file: s.file, in: s.in, length: s.length };
        const g = (s.clip ? D.clipVolume(s.clip) : Math.max(0, Math.min(1, Number(s.volume) || 0))) * (audible(clip) ? 1 : 0);
        if (g > 0) out.push({ file: s.file, gain: g, clip, origin: s.at, start: s.at, end: s.at + s.length, key: "snd:" + s.file + "@" + s.at });
    }
    return out;
}

/**
 * The samples of one grain: `n` of them at `sr`, the film read from `t` on in
 * direction `dir` (one sample = 1/sr seconds of the film), each source at its
 * gain; `sampleOf(file)` gives { data (Float32Array), rate } or null (not decoded
 * yet: left out). The first and last `fade` samples ramp, the sum is held to -1..1.
 */
export function fillGrain(n, sources, t, dir, sr, sampleOf, fade = 0) {
    const out = new Float32Array(Math.max(0, n | 0));
    for (const s of sources || []) {
        const d = sampleOf(s.file);
        if (!d || !d.data || !(s.gain > 0)) continue;
        const data = d.data, rate = d.rate, len = data.length;
        for (let k = 0; k < out.length; k++) {
            const tau = t + dir * k / sr;
            if (tau < s.start - 1e-9 || tau >= s.end - 1e-9) continue;
            const x = srcAt(s.clip, tau - s.origin) * rate;
            const i = Math.floor(x);
            if (i < 0 || i >= len) continue;
            const f = x - i;
            out[k] += s.gain * (data[i] * (1 - f) + (i + 1 < len ? data[i + 1] : 0) * f);
        }
    }
    const m = Math.min(Math.floor(out.length / 2), Math.max(0, fade | 0));
    for (let k = 0; k < m; k++) { const w = k / m; out[k] *= w; out[out.length - 1 - k] *= w; }
    for (let k = 0; k < out.length; k++) out[k] = Math.max(-1, Math.min(1, out[k]));
    return out;
}

export const EditAudioMixin = {

    /** { play, scrub }: the two switches, kept per viewer in localStorage. */
    _editAudio() {
        if (this._eaState) return this._eaState;
        let kept = null;
        try { kept = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (_) { kept = null; }
        this._eaState = { play: !(kept && kept.play === false), scrub: !(kept && kept.scrub === false) };
        return this._eaState;
    },

    /** 1 while the cut's sound is on, 0 while the bar's speaker is off. */
    _editAudioGain() { return this._editAudio().play ? 1 : 0; },

    /** The bar's switches: "play" (Ctrl+Shift+M) or "scrub" (Shift+M); `on` forces. */
    editAudioToggle(which, on) {
        const st = this._editAudio();
        const key = which === "scrub" ? "scrub" : "play";
        st[key] = on === undefined ? !st[key] : !!on;
        try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (_) {}
        if (!st.play || !st.scrub) this._eaSilence();
        // What is playing now is heard (or not) at once.
        const ep = this._ep;
        if (ep && ep.at && this._editPlayMix) this._editPlayMix(ep.at);
        if (ep && this._editPlaySounds) this._editPlaySounds(ep.t || 0, !!this.isPlaying);
        this._editTlSay?.(key === "play" ? (st.play ? "audio on" : "audio off: playback and scrubbing are silent")
                                         : (st.scrub ? "audio scrubbing on" : "audio scrubbing off"));
        this.editTlRefresh?.();
    },

    /** The bar's two buttons drawn as the switches stand. */
    _editAudioButtons(ui) {
        if (!ui || !ui.audio) return;
        const st = this._editAudio();
        const icon = st.play ? "volume" : "volumeOff";
        if (ui.audio.dataset.icon !== icon) setEditIcon(ui.audio, icon);
        ui.audio.classList.toggle("on", st.play);
        ui.audio.setAttribute("aria-pressed", st.play ? "true" : "false");
        ui.audio.title = st.play ? "Audio playback is on: click (Ctrl+Shift+M) to switch all sound of the cut off - playing and scrubbing"
                                 : "Audio playback is OFF: the cut plays and scrubs silently. Click (Ctrl+Shift+M) to hear it";
        ui.scrubAudio.classList.toggle("on", st.scrub && st.play);
        ui.scrubAudio.disabled = !st.play;
        ui.scrubAudio.setAttribute("aria-pressed", st.scrub ? "true" : "false");
        ui.scrubAudio.title = st.scrub ? "Audio scrubbing is on (Shift+M): dragging the playhead or jogging plays the sound under it, pitched with the speed"
                                       : "Audio scrubbing is off (Shift+M): scrubbing is silent";
    },

    // ── scrubbing ────────────────────────────────────────────────────────────

    /**
     * The playhead was moved by hand to `seconds` (a ruler or line drag, a jog
     * key): a grain of what is heard there, if scrubbing is on.
     */
    editScrubAt(seconds) {
        const st = this._editAudio();
        if (!st.play || !st.scrub || this.isPlaying || !this._editTlCut || !this._editTlOnScreen?.()) return;
        const ctx = this._eaContext();
        if (!ctx) return;
        const cur = { t: Number(seconds) || 0, ms: this._editPlayNow ? this._editPlayNow() : performance.now() };
        const prev = this._eaLast;
        this._eaLast = cur;
        const sources = scrubSources(this._editTlCut, cur.t, this._editTlLive ? this._editTlLive() : null);
        for (const s of sources) this._eaWant(s.file);
        const plan = planGrain(prev, cur, this._eaUntil || 0, ctx.currentTime);
        if (!plan || plan.wait) return;
        const ready = sources.filter((s) => this._eaHave(s.file));
        if (!ready.length) return;
        const sr = SCRUB.sr;
        const fade = Math.round(SCRUB.fade * plan.rate * sr);
        const data = fillGrain(plan.samples, ready, cur.t, plan.dir, sr, (f) => this._eaHave(f), fade);
        try {
            const buf = ctx.createBuffer(1, data.length, sr);
            if (buf.copyToChannel) buf.copyToChannel(data, 0); else buf.getChannelData(0).set(data);
            const node = ctx.createBufferSource();
            node.buffer = buf;
            node.playbackRate.value = plan.rate;
            node.connect(ctx.destination);
            node.start(plan.start);
            this._eaUntil = plan.start + data.length / (sr * plan.rate);
            (this._eaNodes ||= []).push(node);
            if (this._eaNodes.length > 8) this._eaNodes.shift();
            // What was played, for the tests and for anyone looking: the last few grains.
            (this._eaGrains ||= []).push({ t: cur.t, rate: plan.rate, dir: plan.dir, start: plan.start, samples: data.length,
                                           files: ready.map((s) => s.file), gains: ready.map((s) => s.gain) });
            if (this._eaGrains.length > 64) this._eaGrains.shift();
        } catch (_) {}
    },

    /** Stop what is queued: a switch went off, or the cut began to play. */
    _eaSilence() {
        for (const n of this._eaNodes || []) { try { n.stop(); } catch (_) {} }
        this._eaNodes = [];
        this._eaUntil = 0;
        this._eaLast = null;
    },

    // The audio context, made in the viewer's own window (popped out, the
    // pop-out's) at the first scrub - a user's gesture - and woken if the
    // browser had it suspended.
    _eaContext() {
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        if (this._eaCtx && this._eaWin === win && this._eaCtx.state !== "closed") {
            if (this._eaCtx.state === "suspended" && this._eaCtx.resume) { try { this._eaCtx.resume(); } catch (_) {} }
            return this._eaCtx;
        }
        const Ctor = win.AudioContext || win.webkitAudioContext;
        if (!Ctor) return null;
        try {
            if (this._eaCtx && this._eaCtx.close) { try { this._eaCtx.close(); } catch (_) {} }
            this._eaCtx = new Ctor();
            this._eaWin = win;
            this._eaUntil = 0;
            if (this._eaCtx.state === "suspended" && this._eaCtx.resume) { try { this._eaCtx.resume(); } catch (_) {} }
        } catch (_) { this._eaCtx = null; }
        return this._eaCtx;
    },

    // ── the decoded sources ──────────────────────────────────────────────────

    _eaCache() { return (this._eaDecoded ||= new Map()); },

    /** The decoded mono samples of `file` ({ data, rate }), or null while they are not there. */
    _eaHave(file) {
        const e = this._eaCache().get(file);
        if (!e || !e.data) return null;
        e.used = performance.now();
        return e;
    },

    /** Ask for `file`'s sound to be decoded, once (at most 2 at a time). */
    _eaWant(file) {
        const cache = this._eaCache();
        if (!file || cache.has(file)) return;
        const e = { data: null, rate: SCRUB.sr, bytes: 0, used: performance.now(), failed: false };
        cache.set(file, e);
        (this._eaQueue ||= []).push(file);
        this._eaPump();
    },

    _eaPump() {
        this._eaBusy = this._eaBusy || 0;
        while (this._eaBusy < 2 && this._eaQueue && this._eaQueue.length) {
            const file = this._eaQueue.shift();
            this._eaBusy += 1;
            this._eaDecode(file).catch(() => null).then((got) => {
                this._eaBusy -= 1;
                const e = this._eaCache().get(file);
                if (e) {
                    if (got) { e.data = got.data; e.rate = got.rate; e.bytes = got.data.byteLength; } else e.failed = true;
                }
                this._eaTrim();
                this._eaPump();
            });
        }
    },

    /** The file's bytes (a film's too: its sound track is what is decoded). Null where it cannot be read. */
    async _eaFetch(file) {
        const url = this.buildImgUrl({ path: file, external: true }, { noColor: true });
        const res = await fetch(url);
        if (!res.ok) return null;
        const size = Number(res.headers.get("content-length") || 0);
        if (size > 1024 * 1024 * 1024) return null;            // more than a GB is not fetched for a scrub
        return await res.arrayBuffer();
    },

    /**
     * The file's sound as the server reads it: { data, rate } (mono, at SR), null
     * when it has none, undefined when the server cannot say (an older one).
     */
    async _eaServerPcm(file) {
        let res;
        try {
            // Imported here, not at the top: the pure part of this file is tested under node, with no ComfyUI.
            const { api } = await import("../../scripts/api.js");
            res = await api.fetchApi("/imageviewer/timeline_pcm?path=" + encodeURIComponent(file));
        } catch (_) { return undefined; }
        if (!res) return undefined;
        if (res.status === 204) return null;
        const rate = Number(res.headers && res.headers.get && res.headers.get("X-Pcm-Rate")) || 0;
        if (!res.ok || !rate || !res.arrayBuffer) return undefined;
        const bytes = await res.arrayBuffer();
        const pcm = new Int16Array(bytes, 0, bytes.byteLength >> 1);
        const data = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32767;
        return { data, rate };
    },

    // From the server; else decoded by the browser (off the main thread), mixed
    // down to mono at SR on an OfflineAudioContext (rendered off the main thread too).
    async _eaDecode(file) {
        const ctx = this._eaCtx;
        if (!ctx) return null;
        const served = await this._eaServerPcm(file);
        if (served !== undefined) return served;
        const bytes = await this._eaFetch(file);
        if (!bytes) return null;
        const buf = await new Promise((resolve, reject) => {
            try {
                const p = ctx.decodeAudioData(bytes, resolve, reject);
                if (p && p.then) p.then(resolve, reject);
            } catch (e) { reject(e); }
        });
        if (!buf) return null;
        if (buf.numberOfChannels === 1 && buf.sampleRate <= SCRUB.sr * 1.01) return { data: buf.getChannelData(0), rate: buf.sampleRate };
        const win = this._eaWin || window;
        const Off = win.OfflineAudioContext || win.webkitOfflineAudioContext;
        if (Off) {
            try {
                const off = new Off(1, Math.max(1, Math.ceil(buf.duration * SCRUB.sr)), SCRUB.sr);
                const src = off.createBufferSource();
                src.buffer = buf;
                src.connect(off.destination);
                src.start(0);
                const done = await off.startRendering();
                return { data: done.getChannelData(0), rate: SCRUB.sr };
            } catch (_) {}
        }
        // No offline context: mixed down here, every channel averaged, at the rate it came in.
        const n = buf.length, ch = buf.numberOfChannels, data = new Float32Array(n);
        for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) data[i] += d[i] / ch; }
        return { data, rate: buf.sampleRate };
    },

    /** The cache held under CACHE_BYTES: the least recently used sources go first. */
    _eaTrim() {
        const cache = this._eaCache();
        let total = 0;
        for (const e of cache.values()) total += e.bytes || 0;
        if (total <= CACHE_BYTES) return;
        const old = [...cache.entries()].filter(([, e]) => e.data).sort((a, b) => a[1].used - b[1].used);
        for (const [f, e] of old) {
            if (total <= CACHE_BYTES) break;
            total -= e.bytes;
            cache.delete(f);
        }
    },
};
