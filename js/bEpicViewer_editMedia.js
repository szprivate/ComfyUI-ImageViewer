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
import { api } from "../../scripts/api.js";
import * as D from "./bEpicViewer_editTimelineData.js";

// The sheet sizes the server keeps (timeline_media.STRIP_COUNTS / STRIP_HEIGHTS).
const STRIP_COUNTS = [1, 8, 16, 32, 64, 128, 256];
const MAX_LOADS = 3;
const MAX_ENTRIES = 400;
const SOUND_RE = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;

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
        const box = ui.main.getBoundingClientRect();
        const left = view.left, right = view.right;
        const top = Math.max(view.top, box.top), bottom = Math.min(view.bottom, box.bottom);
        const wanted = new Set();
        let pending = 0, drawn = 0;
        for (const b of ui.rows.querySelectorAll(".edit-shot, .edit-snd")) {
            const m = b._media;
            if (!m || !m.file) continue;
            const r = b.getBoundingClientRect();
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
        if (!still) peaks = this._emGet("peaks", m.file, wanted);
        const waveH = peaks && peaks.audio && H >= 22 ? Math.round(H * 0.36) : 0;
        let done = this._emStrip(ctx, m, W, x0, x1, H - waveH, wanted, still);
        if (waveH) this._emWave(ctx, m, W, x0, x1, H - waveH, waveH, wanted, peaks, false);
        if (!still && peaks === null) done = false;
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
        let n = 1;
        if (!still) {
            const dur = (any && any.duration) || (info && info.duration) || (m.in + m.length);
            const needed = Math.ceil((dur / Math.max(0.01, m.length * D.speedOf(m.clip))) * W / tile);
            n = STRIP_COUNTS.find((c) => c >= needed) || STRIP_COUNTS[STRIP_COUNTS.length - 1];
        }
        const exact = this._emGet("strip", m.file, wanted, n + "x" + hreq);
        if (exact === false) return true;                   // it cannot be read: the block stays plain
        const sheet = exact || this._emNearest(m.file, n, hreq);
        const b = ctx.canvas.parentNode;
        if (b) b._emHasStrip = !!sheet;
        if (!sheet) return false;
        const tw = h * sheet.tw / sheet.th;
        for (let k = Math.floor(x0 / tw); k * tw < x1; k++) {
            const x = k * tw;
            let idx = 0;
            if (sheet.n > 1 && sheet.duration > 0) {
                // The source moment of the tile: at the clip's speed, through its loop.
                const u = ((x + tw / 2) / W) * m.length;
                const t = m.clip ? D.srcLocal(m.clip, u) : m.in + u;
                idx = Math.max(0, Math.min(sheet.n - 1, Math.floor((t / sheet.duration) * sheet.n)));
            }
            try { ctx.drawImage(sheet.img, idx * sheet.tw, 0, sheet.tw, sheet.th, x - x0, 0, tw + 0.5, h); } catch (_) {}
        }
        this._emSeams(ctx, m, W, x0, x1, h);
        return !!exact;
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
        for (let px = Math.floor(x0); px < x1; px++) {
            const u0 = (px / W) * m.length;
            const t0 = m.clip ? D.srcLocal(m.clip, u0) : m.in + u0;
            const t1 = t0 + (m.length / W) * (m.clip ? D.speedOf(m.clip) : 1);
            const b0 = Math.floor(t0 * bps);
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

    /** The strip of `file` already here whose count is nearest `n` (more frames before fewer). */
    _emNearest(file, n, h) {
        let best = null, score = Infinity;
        for (const [key, e] of this._em().cache) {
            if (e.state !== "ok" || e.kind !== "strip" || e.file !== file) continue;
            const [en, eh] = e.extra.split("x").map(Number);
            const s = Math.abs(Math.log2(Math.max(1, en) / Math.max(1, n))) + (en < n ? 0.25 : 0) + (eh === h ? 0 : 0.1);
            if (s < score) { score = s; best = e.data; }
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
        const [n, h] = e.extra.split("x");
        const res = await api.fetchApi(`/bepic/timeline_strip?${q}&n=${n}&h=${h}`, { signal });
        if (!res.ok) throw new Error(String(res.status));
        const head = (k) => Number(res.headers.get(k));
        const blob = await res.blob();
        const img = await this._emPicture(blob);
        return { img, n: head("X-Strip-N") || 1, tw: head("X-Strip-Tw") || img.width, th: head("X-Strip-Th") || img.height,
                 duration: head("X-Strip-Duration") || 0 };
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
