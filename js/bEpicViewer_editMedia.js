// bEpicViewer_editMedia.js
// What is drawn INSIDE the clips of the Edit panel, as an editor draws it: a
// filmstrip along a film clip - frames tiled to the clip's width, more of them
// the further the timeline is zoomed in - and a waveform on a sound clip and on
// the lower part of a film clip that has sound. A still shows its picture
// repeated. Each strip shows the clip's in..out of its file, not the file.
//
// The server reads the files (timeline_media.py, PyAV in its own process, in
// worker threads, cached on disk by path, mtime and size):
//   GET /bepic/timeline_strip?path&n&h   n frames side by side on one JPEG; the
//                                        sheet's layout in X-Strip-* headers
//   GET /bepic/timeline_peaks?path       min / max per bucket at a few
//                                        resolutions, as signed bytes
// Here, only what is in view is drawn and asked for: one canvas per visible
// clip, as wide as the part of it that is on screen (a clip zoomed to 30 000
// px is not a 30 000 px canvas). At most MAX_LOADS readings are in the air (one
// while the cut plays, so the picture being played is never kept waiting), a
// reading no visible clip wants any more is aborted at the next draw - after a
// scroll or a zoom - and while the right number of frames is on its way the
// strip is drawn from the nearest one that is already here.
//
// A clip that is a PART of its file - a piece of a longer film after the blade,
// two clips of one file with different ins and outs, a slipped clip - asks for
// a sheet of ITS part (start / end on the strip route: a window around its
// source in..out, on a grid of a power-of-two seconds so that a small slip or
// trim does not ask again), with as many frames as its tiles need there; each
// tile is then the frame of its own source moment (srcLocal: retime, loop and
// slip counted). The whole-file sheet stands in while it comes, and during a drag
// nothing new is asked for: the nearest sheet covering the part is drawn, and the
// right one is asked for once the drag is let go. The waveform needs nothing of
// the kind: the peaks are of the whole file at up to 400 buckets a second, and
// each clip reads the buckets of its own source moments.
import { api } from "../../scripts/api.js";
import * as D from "./bEpicViewer_editTimelineData.js";

// The sheet sizes the server keeps (timeline_media.STRIP_COUNTS / STRIP_HEIGHTS).
const STRIP_COUNTS = [1, 8, 16, 32, 64, 128, 256];
const MAX_LOADS = 3;
const MAX_ENTRIES = 400;
const SOUND_RE = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;

/**
 * The part of its file a clip's strip is asked for: the source it shows
 * (`lo`..`hi`: in to out at its speed, one turn of a loop) widened to a grid of
 * `q` seconds, a power of two about half its length (so a small slip or trim
 * stays on the same sheet), held to the file's length `dur` when known.
 * `whole`: the window is (nearly) the whole file - asked for without one.
 */
export function stripWindow(m, dur) {
    const c = m.clip || { in: m.in, length: m.length };
    const lo = Math.max(0, Number(c.in) || 0);
    const hi = lo + Math.max(0.001, D.srcUse(c));
    const q = Math.max(0.25, Math.pow(2, Math.ceil(Math.log2(Math.max(0.01, (hi - lo) / 2)))));
    let start = Math.floor(lo / q + 1e-9) * q, end = Math.ceil(hi / q - 1e-9) * q;
    if (dur > 0) end = Math.min(end, Math.ceil(dur * 1000) / 1000);
    if (end <= start) end = start + q;
    const r = (v) => Math.round(v * 1000) / 1000;
    const whole = dur > 0 && start <= 0 && end >= dur - 1e-3;
    return { lo, hi, start: r(start), end: r(end), q, whole };
}

function decodePeaks(b64) {
    const bin = atob(b64 || "");
    const out = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
    return out;
}

export const EditMediaMixin = {

    _em() {
        if (!this._emState) this._emState = { cache: new Map(), queue: [], live: new Map(), requests: 0 };
        return this._emState;
    },

    /** Draw the clips' insides at the next frame (after a redraw, a scroll, a zoom, a reading arriving). */
    editMediaSchedule() {
        const ui = this._editTlUi;
        if (!ui || this._emRaf) return;
        const win = ui.body.ownerDocument.defaultView || window;
        this._emRaf = win.requestAnimationFrame(() => { this._emRaf = 0; this._editMediaDraw(); });
    },

    _editMediaDraw() {
        const ui = this._editTlUi;
        if (!ui || !ui.body.isConnected || !this._editTlOpen() || !this._editTlLay) { this._emPending = 0; return; }
        const view = ui.scroll.getBoundingClientRect();
        const left = view.left, right = view.right;
        // Up and down, each section shows its own part of its tracks (bEpicViewer_editSections.js).
        const secs = new Map();
        const shown = (b) => {
            const sec = b.closest(".edit-sec") || ui.rows;
            if (!secs.has(sec)) {
                const s = sec.getBoundingClientRect();
                secs.set(sec, [Math.max(view.top, s.top), Math.min(view.bottom, s.bottom)]);
            }
            return secs.get(sec);
        };
        const wanted = new Set();
        let pending = 0, drawn = 0;
        for (const b of ui.rows.querySelectorAll(".edit-shot, .edit-snd")) {
            const m = b._media;
            if (!m || !m.file) continue;
            const r = b.getBoundingClientRect();
            const [top, bottom] = shown(b);
            if (r.right <= left || r.left >= right || r.bottom <= top || r.top >= bottom || r.width < 2) continue;
            if (!this._editMediaClip(b, m, r, left, right, wanted)) pending += 1;
            drawn += 1;
        }
        this._editMediaPrune(wanted);
        // For the tests and for looking: how many clips in view still wait for a reading.
        this._emPending = pending;
        this._emDrawn = drawn;
    },

    // One clip: its canvas over the part of it in view, and what goes in it.
    // True when everything it wants was here (nothing is still on its way).
    _editMediaClip(b, m, r, left, right, wanted) {
        const doc = b.ownerDocument;
        const win = doc.defaultView || window;
        const dpr = win.devicePixelRatio || 1;
        const W = r.width;
        const x0 = Math.max(r.left, left) - r.left, x1 = Math.min(r.right, right) - r.left;
        const H = Math.max(1, b.clientHeight);
        let cv = b._emCanvas;
        if (!cv || cv.parentNode !== b) {
            cv = doc.createElement("canvas");
            cv.className = "edit-media";
            b.prepend(cv);
            b._emCanvas = cv;
        }
        cv.style.left = (x0 - b.clientLeft) + "px";
        cv.style.width = (x1 - x0) + "px";
        cv.style.height = H + "px";
        const pw = Math.max(1, Math.round((x1 - x0) * dpr)), ph = Math.max(1, Math.round(H * dpr));
        if (cv.width !== pw) cv.width = pw;
        if (cv.height !== ph) cv.height = ph;
        const ctx = cv.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pw, ph);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const sound = m.row === "audio" || SOUND_RE.test(m.file);
        if (sound) {
            const done = this._emWave(ctx, m, W, x0, x1, 0, H, wanted, null, true);
            this._emSeams(ctx, m, W, x0, x1, H);
            return done;
        }
        const still = D.isStill(m.file);
        let peaks;
        // A clip whose sound is split off, or muted, draws no waveform: the strip takes its whole height.
        const silent = m.row === "video" && m.clip && m.clip.mute;
        if (!still && !silent) peaks = this._emGet("peaks", m.file, wanted);
        const waveH = peaks && peaks.audio && H >= 22 ? Math.round(H * 0.36) : 0;
        let done = this._emStrip(ctx, m, W, x0, x1, H - waveH, wanted, still);
        if (waveH) this._emWave(ctx, m, W, x0, x1, H - waveH, waveH, wanted, peaks, false);
        if (!still && !silent && peaks === null) done = false;
        b.classList.toggle("has-strip", !!b._emHasStrip);
        return done;
    },

    // The filmstrip: tiles at a fixed place along the clip (they do not swim
    // when it scrolls), each the frame of its moment of the in..out.
    _emStrip(ctx, m, W, x0, x1, h, wanted, still) {
        if (h < 6) return true;
        const hreq = h > 56 ? 96 : 48;
        const info = this._editTlInfo && this._editTlInfo.get(m.file);
        const any = this._emNearest(m.file, 16, hreq);
        const aspect = any ? any.tw / any.th : (info && info.width > 0 && info.height > 0 ? info.width / info.height : 16 / 9);
        const tile = Math.max(8, h * aspect);
        let n = 1, extra = "1x" + hreq, part = null;
        const b = ctx.canvas.parentNode;
        if (!still) {
            const dur = (any && any.duration) || (info && info.duration) || 0;
            part = stripWindow(m, dur);
            const span = Math.max(0.01, part.hi - part.lo);
            // As many frames over the window as the clip's tiles need there.
            const needed = Math.ceil(((part.end - part.start) / span) * W / tile);
            n = STRIP_COUNTS.find((c) => c >= needed) || STRIP_COUNTS[STRIP_COUNTS.length - 1];
            extra = n + "x" + hreq + (part.whole ? "" : `@${part.start}-${part.end}`);
        }
        // During a drag, or while Shift + wheel changes the heights, nothing new is asked for: what covers
        // the part is drawn, the right sheet comes on release (once the wheel rests).
        const cached = this._em().cache.get("strip|" + extra + "|" + m.file);
        const asking = !(this._editTlDragging || this._editTlSizing) || (cached && cached.state === "ok");
        const exact = asking ? this._emGet("strip", m.file, wanted, extra) : null;
        if (exact === false) return true;                   // it cannot be read: the block stays plain
        const sheet = exact || this._emNearest(m.file, n, hreq, part);
        if (b) b._emHasStrip = !!sheet;
        if (!sheet) return false;
        const tw = h * sheet.tw / sheet.th;
        const tiles = [];
        for (let k = Math.floor(x0 / tw); k * tw < x1; k++) {
            const x = k * tw;
            let idx = 0;
            const s0 = sheet.start || 0, s1 = sheet.end > s0 ? sheet.end : sheet.duration;
            // The source moment of the tile: at the clip's speed, through its loop, from its own in.
            const u = ((x + tw / 2) / W) * m.length;
            const t = m.clip ? D.srcLocal(m.clip, u) : m.in + u;
            if (sheet.n > 1 && s1 > s0) idx = Math.max(0, Math.min(sheet.n - 1, Math.floor(((t - s0) / (s1 - s0)) * sheet.n)));
            if (tiles.length < 64) tiles.push(Math.round(t * 1000) / 1000);
            try { ctx.drawImage(sheet.img, idx * sheet.tw, 0, sheet.tw, sheet.th, x - x0, 0, tw + 0.5, h); } catch (_) {}
        }
        // For the tests and for looking: the source moments of the tiles drawn, and the sheet's part.
        if (b) { b._emTiles = tiles; b._emSheet = { start: sheet.start || 0, end: sheet.end || sheet.duration, n: sheet.n, exact: !!exact }; }
        this._emSeams(ctx, m, W, x0, x1, h);
        return !!exact || (!asking && !!sheet);
    },

    // Where a looped clip's turns meet: a dashed line and a loop mark at each.
    _emSeams(ctx, m, W, x0, x1, h) {
        const seams = m.clip ? D.loopSeams(m.clip) : [];
        if (!seams.length) return;
        const pp = D.loopOf(m.clip) === "pingpong";
        ctx.save();
        ctx.strokeStyle = "rgba(77, 225, 255, 0.95)";
        ctx.fillStyle = "rgba(77, 225, 255, 0.95)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.font = "bold 11px sans-serif";
        ctx.textBaseline = "top";
        seams.forEach((u, k) => {
            const x = (u / Math.max(0.001, m.length)) * W;
            if (x < x0 - 14 || x > x1 + 2) return;
            ctx.beginPath();
            ctx.moveTo(x - x0 + 0.5, 0);
            ctx.lineTo(x - x0 + 0.5, h);
            ctx.stroke();
            ctx.fillText(pp && k % 2 === 0 ? "⇄" : "↻", x - x0 + 3, 2);
        });
        ctx.restore();
    },

    // The waveform: per screen pixel the lowest and the highest of the buckets
    // under it, from the resolution that has at least one bucket per pixel.
    _emWave(ctx, m, W, x0, x1, y, h, wanted, peaks, full) {
        const p = peaks || this._emGet("peaks", m.file, wanted);
        if (!p) return p === false;
        if (!p.audio || !p.levels || !p.levels.length) return true;
        const pps = W / Math.max(0.001, m.length);
        const level = p.levels.find((l) => l.bps >= pps) || p.levels[p.levels.length - 1];
        const arr = level.arr, n = level.n, bps = level.bps;
        if (!arr || !n) return true;
        const vol = Math.max(0, Math.min(1, Number.isFinite(Number(m.volume)) ? Number(m.volume) : 1));
        const mid = y + h / 2, amp = (h / 2 - 1) * (0.15 + 0.85 * vol);
        ctx.fillStyle = full ? "rgba(178, 236, 204, 0.85)" : "rgba(210, 230, 255, 0.75)";
        if (!full) { ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, y, x1 - x0, h); ctx.fillStyle = "rgba(210, 230, 255, 0.8)"; }
        const b = ctx.canvas.parentNode;
        let first = null, last = null;
        for (let px = Math.floor(x0); px < x1; px++) {
            const u0 = (px / W) * m.length;
            const t0 = m.clip ? D.srcLocal(m.clip, u0) : m.in + u0;
            const t1 = t0 + (m.length / W) * (m.clip ? D.speedOf(m.clip) : 1);
            const b0 = Math.floor(t0 * bps);
            if (first === null) first = t0;
            last = t0;
            if (b0 >= n) break;
            const b1 = Math.min(n, Math.max(b0 + 1, Math.ceil(t1 * bps)));
            let lo = 127, hi = -127;
            for (let k = Math.max(0, b0); k < b1; k++) {
                const a = arr[2 * k], c = arr[2 * k + 1];
                if (a < lo) lo = a;
                if (c > hi) hi = c;
            }
            if (hi < lo) continue;
            const top = mid - (hi / 127) * amp, len = Math.max(1, ((hi - lo) / 127) * amp);
            ctx.fillRect(px - x0, top, 1, len);
        }
        // For the tests: the source moments the waveform drawn reads, first and last pixel.
        if (b) b._emWaveRange = first === null ? null : [Math.round(first * 1000) / 1000, Math.round(last * 1000) / 1000];
        return true;
    },

    // ── the readings: asked for, kept, given up ──────────────────────────────

    /** A reading if it is here; null while it is on its way (it is asked for); false if it cannot be had. */
    _emGet(kind, file, wanted, extra = "") {
        const key = kind + "|" + extra + "|" + file;
        wanted.add(key);
        const st = this._em();
        const hit = st.cache.get(key);
        if (hit) return hit.state === "ok" ? hit.data : (hit.state === "err" ? false : null);
        st.cache.set(key, { state: "queued", kind, file, extra });
        st.queue.push(key);
        this._emPump();
        return null;
    },

    /**
     * The strip of `file` already here that stands in best: one that covers the
     * clip's `part` ({ lo, hi } of its source) before one that does not, then
     * the nearest density of frames there, then the height.
     */
    _emNearest(file, n, h, part) {
        let best = null, score = Infinity;
        for (const [key, e] of this._em().cache) {
            if (e.state !== "ok" || e.kind !== "strip" || e.file !== file) continue;
            const [en, eh] = e.extra.split("@")[0].split("x").map(Number);
            const d = e.data;
            const s0 = d.start || 0, s1 = d.end > s0 ? d.end : (d.duration || 0);
            let s = Math.abs(Math.log2(Math.max(1, en) / Math.max(1, n))) + (en < n ? 0.25 : 0) + (eh === h ? 0 : 0.1);
            if (part && s1 > s0) {
                const covers = s0 <= part.lo + 1e-3 && s1 >= Math.min(part.hi, d.duration || part.hi) - 1e-3;
                const want = n / Math.max(0.01, part.end - part.start), have = d.n / (s1 - s0);
                s = (covers ? 0 : 10) + Math.abs(Math.log2(Math.max(1e-3, have) / Math.max(1e-3, want))) + (eh === h ? 0 : 0.1);
            }
            if (s < score) { score = s; best = d; }
            void key;
        }
        return best;
    },

    _emPump() {
        const st = this._em();
        const max = this.isPlaying ? 1 : MAX_LOADS;
        while (st.live.size < max && st.queue.length) {
            const key = st.queue.shift();
            const e = st.cache.get(key);
            if (!e || e.state !== "queued") continue;
            e.state = "loading";
            const ctrl = new AbortController();
            st.live.set(key, ctrl);
            st.requests += 1;
            this._emLoad(e, ctrl.signal).then((data) => {
                if (ctrl.signal.aborted) { st.cache.delete(key); return; }
                e.state = "ok";
                e.data = data;
            }, () => {
                if (ctrl.signal.aborted) st.cache.delete(key);       // asked again when it is in view again
                else e.state = "err";
            }).finally(() => {
                st.live.delete(key);
                this._emPump();
                this.editMediaSchedule();
            });
        }
    },

    // What no clip in view wants: the queued ones forgotten, the ones on their
    // way aborted (the server still keeps what it made), the oldest kept ones
    // let go once there are too many.
    _editMediaPrune(wanted) {
        const st = this._em();
        st.queue = st.queue.filter((k) => {
            if (wanted.has(k)) return true;
            st.cache.delete(k);
            return false;
        });
        for (const [k, ctrl] of st.live) if (!wanted.has(k)) ctrl.abort();
        if (st.cache.size > MAX_ENTRIES) {
            for (const [k, e] of st.cache) {
                if (st.cache.size <= MAX_ENTRIES) break;
                if (!wanted.has(k) && e.state !== "loading") {
                    if (e.data && e.data.img && e.data.img.close) { try { e.data.img.close(); } catch (_) {} }
                    st.cache.delete(k);
                }
            }
        }
    },

    async _emLoad(e, signal) {
        const q = "path=" + encodeURIComponent(e.file);
        if (e.kind === "peaks") {
            const res = await api.fetchApi("/bepic/timeline_peaks?" + q, { signal });
            if (!res.ok) throw new Error(String(res.status));
            const j = await res.json();
            for (const lv of j.levels || []) { lv.arr = decodePeaks(lv.data); delete lv.data; }
            return j;
        }
        const [size, win] = e.extra.split("@");
        const [n, h] = size.split("x");
        const [ws, we] = win ? win.split("-") : [];
        const res = await api.fetchApi(`/bepic/timeline_strip?${q}&n=${n}&h=${h}` + (win ? `&start=${ws}&end=${we}` : ""), { signal });
        if (!res.ok) throw new Error(String(res.status));
        const head = (k) => Number(res.headers.get(k));
        const blob = await res.blob();
        const img = await this._emPicture(blob);
        const duration = head("X-Strip-Duration") || 0;
        // An older server says nothing of a part: its sheet is of the whole file.
        const start = res.headers.get("X-Strip-Start") != null ? head("X-Strip-Start") : 0;
        const end = res.headers.get("X-Strip-End") != null ? head("X-Strip-End") : duration;
        return { img, n: head("X-Strip-N") || 1, tw: head("X-Strip-Tw") || img.width, th: head("X-Strip-Th") || img.height,
                 duration, start: win ? start : 0, end: win ? end : duration };
    },

    async _emPicture(blob) {
        if (typeof createImageBitmap === "function") return createImageBitmap(blob);
        const url = URL.createObjectURL(blob);
        try {
            const img = new Image();
            img.src = url;
            await img.decode();
            return img;
        } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    },
};
