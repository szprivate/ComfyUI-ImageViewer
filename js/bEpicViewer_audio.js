// bEpicViewer_audio.js
// Sound files in the Viewer: a .wav / .mp3 / .flac / .ogg / .m4a / .aac / .opus
// is a frame like a clip is, and plays through the same <video> element and the
// same transport (play, loop, the timeline, the frame counter). A <video> plays
// a file that has only sound in it perfectly well; what it does not do is show
// anything, so while a sound is on screen the viewport shows its waveform
// instead: the file's name, the whole sound drawn once, a playhead that follows
// the transport, and a click or drag on the waveform to seek.
//
// The waveform is decoded in the page (fetch + decodeAudioData) and only its
// peaks are kept, a few KB per file, so stepping back to a sound already seen
// draws at once. Very large files are not decoded: they still play, with a
// plain bar where the waveform would be.

export const AUDIO_RE = /\.(wav|mp3|flac|ogg|oga|m4a|aac|opus|weba)$/i;

/** True for a frame that is a sound file. */
export function isAudioFrame(o) {
    if (!o) return false;
    if (o.kind === "audio") return true;
    if (o.kind && o.kind !== "video") return false;
    return AUDIO_RE.test(String(o.path || o.filename || o.name || ""));
}

// History tile for a sound: a speaker over a waveform.
export const AUDIO_TILE = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" fill="#24262b"/>' +
    '<g fill="none" stroke="#6fb7ff" stroke-width="2.4" stroke-linecap="round">' +
    '<path d="M8 32h3M14 26v12M20 20v24M26 28v8M32 14v36M38 22v20M44 27v10M50 18v28M56 30v4"/>' +
    '</g></svg>');

// Past this a file plays without its waveform: decoding it would hold the whole
// sound as float samples in memory, which for an hour of WAV is gigabytes.
const MAX_DECODE_BYTES = 150 * 1024 * 1024;
const PEAK_BUCKETS = 2000;
const PEAK_CACHE = 24;

const CSS = `
.bepic-audio-view { position:absolute; inset:0; display:none; flex-direction:column;
    align-items:center; justify-content:center; gap:10px; padding:24px; box-sizing:border-box;
    pointer-events:none; z-index:3; color:#d8dbe0; font:13px system-ui,sans-serif; }
.bepic-audio-view.on { display:flex; }
.bepic-audio-name { max-width:90%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font-weight:600; font-size:14px; }
.bepic-audio-wave { position:relative; width:min(92%, 1400px); height:min(40%, 220px); min-height:80px;
    background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:6px;
    pointer-events:auto; cursor:pointer; touch-action:none; }
.bepic-audio-wave canvas { position:absolute; inset:0; width:100%; height:100%; }
.bepic-audio-time { font-family:ui-monospace,SFMono-Regular,monospace; font-size:12px; color:#9aa3ad;
    font-variant-numeric:tabular-nums; }
.bepic-audio-note { font-size:11px; color:#7d858f; }
`;

function fmtTime(t) {
    if (!Number.isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** Peaks of an AudioBuffer: [min, max] pairs over `buckets` columns, all channels mixed. */
export function audioPeaks(buffer, buckets = PEAK_BUCKETS) {
    const n = buffer.length;
    const cols = Math.max(1, Math.min(buckets, n));
    const out = new Float32Array(cols * 2);
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const per = n / cols;
    for (let i = 0; i < cols; i++) {
        const a = Math.floor(i * per), b = Math.max(a + 1, Math.floor((i + 1) * per));
        let lo = 0, hi = 0;
        // A long column is sampled, not read whole: the drawing cannot show more.
        const step = Math.max(1, Math.floor((b - a) / 512));
        for (const d of chans) {
            for (let j = a; j < b && j < n; j += step) {
                const v = d[j];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
        out[i * 2] = lo;
        out[i * 2 + 1] = hi;
    }
    return out;
}

export const AudioViewMixin = {

    _frameIsAudio(o) {
        return isAudioFrame(o);
    },

    _audioViewEl() {
        if (this._audioView) return this._audioView;
        const vp = this.viewport;
        if (!vp) return null;
        const root = this.shadowRoot || document;
        if (!root.getElementById || !root.getElementById("bepic-audio-css")) {
            const st = document.createElement("style");
            st.id = "bepic-audio-css";
            st.textContent = CSS;
            (this.shadowRoot || document.head).appendChild(st);
        }
        const view = document.createElement("div");
        view.className = "bepic-audio-view";
        const name = document.createElement("div");
        name.className = "bepic-audio-name";
        const wave = document.createElement("div");
        wave.className = "bepic-audio-wave";
        wave.title = "Click or drag to seek";
        const canvas = document.createElement("canvas");
        wave.appendChild(canvas);
        const time = document.createElement("div");
        time.className = "bepic-audio-time";
        const note = document.createElement("div");
        note.className = "bepic-audio-note";
        view.append(name, wave, time, note);
        vp.appendChild(view);

        // Seek from the waveform. The viewport pans on a drag; this one is ours.
        const seekAt = (e) => {
            const r = wave.getBoundingClientRect();
            const f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
            this._audioSeekFraction(f);
        };
        wave.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            try { wave.setPointerCapture(e.pointerId); } catch (_) {}
            this._audioDragging = true;
            seekAt(e);
        });
        wave.addEventListener("pointermove", (e) => { if (this._audioDragging) { e.stopPropagation(); seekAt(e); } });
        const end = (e) => {
            if (!this._audioDragging) return;
            this._audioDragging = false;
            try { wave.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        wave.addEventListener("pointerup", end);
        wave.addEventListener("pointercancel", end);
        for (const t of ["mousedown", "wheel", "dblclick"]) wave.addEventListener(t, (e) => e.stopPropagation());

        try {
            this._audioResizeObs = new ResizeObserver(() => this._audioDraw());
            this._audioResizeObs.observe(wave);
        } catch (_) {}

        this._audioView = { view, name, wave, canvas, time, note };
        return this._audioView;
    },

    /** Show the waveform for `imgObj` (called as the <video> is pointed at it). */
    _audioShow(imgObj, url) {
        const ui = this._audioViewEl();
        if (!ui) return;
        const key = imgObj.path || imgObj.filename || url || "";
        ui.view.classList.add("on");
        ui.name.textContent = imgObj.name || String(key).split(/[\\/]/).pop() || "sound";
        ui.name.title = imgObj.path || ui.name.textContent;
        if (this._audioKey !== key) {
            this._audioKey = key;
            this._audioPeaksNow = null;
            ui.note.textContent = "";
            this._audioLoadPeaks(key, url);
        }
        this._audioDraw();
        this._audioTick();
    },

    _audioHide() {
        if (this._audioRaf) { cancelAnimationFrame(this._audioRaf); this._audioRaf = 0; }
        this._audioKey = null;
        this._audioPeaksNow = null;
        if (this._audioView) this._audioView.view.classList.remove("on");
    },

    _audioOn() {
        return !!(this._audioView && this._audioView.view.classList.contains("on"));
    },

    async _audioLoadPeaks(key, url) {
        const cache = this._audioPeakCache || (this._audioPeakCache = new Map());
        if (cache.has(key)) {
            this._audioPeaksNow = cache.get(key);
            this._audioDraw();
            return;
        }
        const ui = this._audioView;
        let peaks = null;
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const size = Number(resp.headers.get("content-length") || 0);
            if (size > MAX_DECODE_BYTES) {
                try { resp.body && resp.body.cancel(); } catch (_) {}
                if (this._audioKey === key && ui) ui.note.textContent = "Large file: playing without its waveform.";
                return;
            }
            const bytes = await resp.arrayBuffer();
            if (this._audioKey !== key) return;          // moved on while it loaded
            const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            if (!Ctx) return;
            // A one-sample context is enough to decode with; it is never rendered.
            const ctx = new Ctx(1, 1, 44100);
            const buf = await ctx.decodeAudioData(bytes);
            peaks = audioPeaks(buf);
        } catch (e) {
            if (this._audioKey === key && ui) ui.note.textContent = "No waveform for this file (the browser could not decode it).";
            return;
        }
        cache.set(key, peaks);
        while (cache.size > PEAK_CACHE) cache.delete(cache.keys().next().value);
        if (this._audioKey !== key) return;
        this._audioPeaksNow = peaks;
        this._audioDraw();
    },

    _audioFraction() {
        const v = this.videoBase;
        const d = v && v.duration;
        return (v && Number.isFinite(d) && d > 0) ? Math.max(0, Math.min(1, v.currentTime / d)) : 0;
    },

    _audioSeekFraction(f) {
        const v = this.videoBase;
        if (!v) return;
        const d = v.duration;
        if (!Number.isFinite(d) || d <= 0) return;
        const t = f * d;
        // Through the transport, so the frame counter and the timeline follow.
        if (this._videoFrameAtTime && this.setFrame && v.paused) {
            this.setFrame(Math.min(this._videoFrameAtTime(t), Math.max(0, (this._videoFrames || 1) - 1)));
        }
        try { v.currentTime = t; } catch (_) {}
        this._audioDraw();
    },

    // Keep the playhead moving while the sound plays; timeupdate alone is ~4 a second.
    _audioTick() {
        if (this._audioRaf) return;
        const step = () => {
            this._audioRaf = 0;
            if (!this._audioOn()) return;
            this._audioDraw();
            const v = this.videoBase;
            if (v && !v.paused) this._audioRaf = requestAnimationFrame(step);
        };
        this._audioRaf = requestAnimationFrame(step);
    },

    _audioDraw() {
        const ui = this._audioView;
        if (!ui || !this._audioOn()) return;
        const c = ui.canvas;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(c.clientWidth * dpr));
        const h = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const g = c.getContext("2d");
        if (!g) return;
        g.clearRect(0, 0, w, h);
        const mid = h / 2;
        const frac = this._audioFraction();
        const px = Math.round(frac * w);
        const peaks = this._audioPeaksNow;
        if (peaks && peaks.length >= 2) {
            const cols = peaks.length / 2;
            let top = 0;
            for (let i = 0; i < cols; i++) top = Math.max(top, -peaks[i * 2], peaks[i * 2 + 1]);
            const gain = top > 0 ? 0.92 / top : 1;      // a quiet file still fills the box
            for (let x = 0; x < w; x++) {
                const i = Math.min(cols - 1, Math.floor((x / w) * cols));
                const lo = peaks[i * 2] * gain, hi = peaks[i * 2 + 1] * gain;
                const y0 = mid - hi * mid, y1 = mid - lo * mid;
                g.fillStyle = x < px ? "#6fb7ff" : "#4a5563";
                g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
            }
        } else {
            g.fillStyle = "#3a414b";
            g.fillRect(0, mid - dpr, w, 2 * dpr);
            g.fillStyle = "#6fb7ff";
            g.fillRect(0, mid - dpr, px, 2 * dpr);
        }
        g.fillStyle = "#ff8a3d";
        g.fillRect(Math.min(w - 2 * dpr, px), 0, 2 * dpr, h);

        const v = this.videoBase;
        const d = v && Number.isFinite(v.duration) ? v.duration : 0;
        ui.time.textContent = `${fmtTime(v ? v.currentTime : 0)} / ${fmtTime(d)}`;
    },
};
