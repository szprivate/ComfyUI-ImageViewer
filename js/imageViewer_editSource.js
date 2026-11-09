// imageViewer_editSource.js
// The Edit tab's Source viewer (dock id `editSource`, the bar's Timeline group), as
// Resolve's source monitor beside the timeline's: a file loaded on its own - a
// film, a still or a sound - with its own playhead and its own in / out, and the
// edits that bring the marked part into the cut: three-point editing.
//
//   F9  Insert          Shift+F9   -
//   F10 Overwrite       Shift+F10  Ripple overwrite
//   F11 Replace         Shift+F11  Fit to fill
//   F12 Place on top    Shift+F12  Append at end
//
// The three points (`D.threePoint`): the source's in / out and the timeline's in /
// out (the transport's range, `_editTlRangeSeconds`), the timeline's playhead
// standing in for its in; the fourth follows. The edit itself is `D.sourceEdit`,
// one undo step through `_editTlApply`; the destination (Resolve's track
// patching) is the panel's track menu: a picture goes to a video track (V1 the
// default, else the selected clip's), a sound to a sound track.
//
// Loaded by a drop (the History's thumbnails, the file browser's rows, files
// from the desktop - the same items a drop on the timeline takes, through
// `_editTlResolve`), by the clip menu's "Open in Source viewer", and by Match
// frame (F) while this panel is up. Shift+F is the way back: the playhead to
// where the cut shows the source's frame (`D.findSource`).
//
// The source's time is counted in the cut's frames: its playhead and marks land
// on 1/fps of the cut. Kept per viewer in localStorage (`imageviewer.viewer.editSource`).
import * as D from "./imageViewer_editTimelineData.js";

export const SOURCE_ID = "editSource";
const STORE = "imageviewer.viewer.editSource";
const DRAG_TYPE = "application/x-imageviewer-history";
const STILL_SECONDS = 3;
const SOUND = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;
const STILL = /\.(png|jpe?g|webp|tiff?|gif|bmp|avif|exr)$/i;

/** The edit buttons, in their order: [kind, label, key, shift]. */
export const SOURCE_BUTTONS = [
    ["insert", "Insert", "F9", false],
    ["overwrite", "Overwrite", "F10", false],
    ["replace", "Replace", "F11", false],
    ["place", "Place on top", "F12", false],
    ["ripple", "Ripple overwrite", "F10", true],
    ["fit", "Fit to fill", "F11", true],
    ["append", "Append at end", "F12", true],
];

/** The edit a function key stands for: (key, shift) -> kind, or "". */
export function sourceEditKey(key, shift) {
    const hit = SOURCE_BUTTONS.find((b) => b[2] === key && b[3] === !!shift);
    return hit ? hit[0] : "";
}

export const EditSourceMixin = {

    _editSrcUp() {
        return !!(this.isPanelDocked && this.isPanelDocked(SOURCE_ID));
    },

    _editSrcFps() {
        return (this._editTlCut && this._editTlCut.fps) || 24;
    },

    /** The loaded source: { file, name, still, sound, dur, in, out, head } or null. */
    _editSrcState() {
        if (this._editSrc !== undefined) return this._editSrc;
        let kept = null;
        try { kept = JSON.parse(window.localStorage.getItem(STORE) || "null"); } catch (_) {}
        this._editSrc = kept && kept.file ? kept : null;
        return this._editSrc;
    },

    _editSrcKeep() {
        try { window.localStorage.setItem(STORE, JSON.stringify(this._editSrc || null)); } catch (_) {}
    },

    /**
     * Load `item` ({ path, name }) into the Source viewer at `src` seconds of it,
     * opening the panel if it is not up. -> the source state.
     */
    async editSrcLoad(item, src = 0) {
        const file = item && (item.path || item.file);
        if (!file) return null;
        const still = STILL.test(file), sound = SOUND.test(file);
        let dur = still ? Infinity : 0;
        if (!still && this._editTlProbe) {
            const info = (await this._editTlProbe([file]))[file];
            if (info && info.duration > 0) dur = info.duration;
        }
        const fps = this._editSrcFps();
        const name = item.name || String(file).split(/[\\/]/).pop();
        this._editSrc = { file, name, still, sound, dur: dur || null, in: null, out: null,
                          head: still ? 0 : Math.max(0, Math.floor((Number(src) || 0) * fps + 1e-6) / fps) };
        this._editSrcKeep();
        if (!this._editSrcUp() && this.editTlPanelToggle) this.editTlPanelToggle(SOURCE_ID);
        this._editSrcEl = null;
        this.editSrcRender();
        return this._editSrc;
    },

    /** The panel drawn: the picture, the scrub bar, the marks and the edit buttons. */
    editSrcRender() {
        const host = this.editSourcePanel;
        if (!host || !this._editSrcUp()) return;
        const s = this._editSrcState();
        const cut = this._editTlCut;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        let body = host.querySelector(":scope > .src-body");
        const key = s ? s.file : "";
        if (!body || body.dataset.file !== key) {
            body = el("div", "src-body");
            body.dataset.file = key;
            body.tabIndex = 0;
            body.addEventListener("keydown", (e) => this._editSrcKey(e));
            body.addEventListener("pointerdown", () => { try { body.focus({ preventScroll: true }); } catch (_) {} });
            const carries = (e) => { try { const t = Array.from(e.dataTransfer.types || []); return t.includes(DRAG_TYPE) || t.includes("Files"); } catch (_) { return false; } };
            body.addEventListener("dragover", (e) => { if (!carries(e)) return; e.preventDefault(); body.classList.add("landing"); });
            body.addEventListener("dragleave", (e) => { if (!e.relatedTarget || !body.contains(e.relatedTarget)) body.classList.remove("landing"); });
            body.addEventListener("drop", (e) => {
                if (!carries(e)) return;
                e.preventDefault();
                e.stopPropagation();
                body.classList.remove("landing");
                this._editSrcDrop(e.dataTransfer);
            });
            const name = el("div", "src-name");
            const view = el("div", "src-view");
            const scrub = el("div", "src-scrub");
            scrub.append(el("div", "src-range"), el("div", "src-line"));
            scrub.addEventListener("pointerdown", (e) => this._editSrcScrubDown(e, scrub));
            const row = el("div", "src-row");
            const tc = el("div", "src-tc");
            const btn = (label, title, fn, cls = "") => {
                const b = el("button", "edit-btn src-btn" + (cls ? " " + cls : ""), label);
                b.title = title;
                b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
                return b;
            };
            row.append(
                btn("▶", "Play / stop the source (Space, with the Source viewer focused)", () => this.editSrcPlay(), "src-play"),
                btn("I", "Mark the source's in at its playhead (I)", () => this.editSrcMark("in")),
                btn("O", "Mark the source's out at its playhead (O)", () => this.editSrcMark("out")),
                btn("×", "Clear the source's in and out (Alt+X / Shift+X)", () => this.editSrcMark(null)),
                tc);
            const edits = el("div", "src-edits");
            const dest = el("select", "src-dest");
            dest.title = "Where the source goes (track patching): a picture to a video track, a sound to a sound track";
            dest.addEventListener("change", () => {
                const v = this._editTlView;
                if (v) { v[this._editSrc && this._editSrc.sound ? "srcAudio" : "srcTrack"] = dest.value; }
            });
            edits.append(dest);
            for (const [kind, label, k, shift] of SOURCE_BUTTONS) {
                const b = btn(label, `${label} (${shift ? "Shift+" : ""}${k})`, () => this.editSrcEdit(kind), "src-edit");
                b.dataset.edit = kind;
                edits.append(b);
            }
            body.append(name, view, scrub, row, edits);
            host.replaceChildren(body);
            this._editSrcEl = null;
        }
        const name = body.querySelector(".src-name");
        const view = body.querySelector(".src-view");
        name.textContent = s ? s.name : "Source: drop a clip here, or press F on the timeline";
        name.title = s ? s.file : "";
        body.classList.toggle("empty", !s);
        // The picture.
        if (s && !this._editSrcEl) {
            const obj = { path: s.file, external: true, name: s.name };
            const url = this._editPlayUrl && !s.still ? this._editPlayUrl(s.file) : this.buildImgUrl(obj, { noColor: true });
            const media = s.still ? el("img", "src-media") : el(s.sound ? "audio" : "video", "src-media");
            media.src = url;
            if (!s.still) {
                media.preload = "auto";
                media.addEventListener("loadedmetadata", () => {
                    if (!(s.dur > 0) && media.duration > 0 && Number.isFinite(media.duration)) { s.dur = media.duration; this._editSrcKeep(); }
                    try { media.currentTime = s.head + 0.5 / this._editSrcFps(); } catch (_) {}
                    this._editSrcDraw();
                });
                media.addEventListener("ended", () => this._editSrcStopped());
            }
            if (s.sound) { const note = el("div", "src-sound", "♪ " + s.name); view.replaceChildren(note, media); }
            else view.replaceChildren(media);
            this._editSrcEl = media;
        } else if (!s) view.replaceChildren();
        // The destination menu.
        const dest = body.querySelector(".src-dest");
        const opts = this._editSrcTracks(cut, s && s.sound);
        const want = this._editSrcDest(cut, s && s.sound);
        dest.replaceChildren(...opts.map((id) => { const o = el("option", "", id); o.value = id; return o; }));
        dest.value = want;
        for (const b of body.querySelectorAll(".src-edit")) {
            b.disabled = !s || !cut || (s.sound && b.dataset.edit === "place");
        }
        this._editSrcDraw();
    },

    /** The scrub bar, the marks and the timecode as they stand. */
    _editSrcDraw() {
        const host = this.editSourcePanel;
        const body = host && host.querySelector(":scope > .src-body");
        if (!body) return;
        const s = this._editSrcState();
        const fps = this._editSrcFps();
        const len = s ? (s.still ? STILL_SECONDS : s.dur || 0) : 0;
        const share = (t) => (len > 0 ? Math.max(0, Math.min(1, t / len)) * 100 : 0);
        const range = body.querySelector(".src-range"), line = body.querySelector(".src-line");
        const has = (v) => v !== null && v !== undefined;
        if (s && (has(s.in) || has(s.out))) {
            const a = has(s.in) ? s.in : 0, b = has(s.out) ? s.out : len;
            range.style.display = "";
            range.style.left = share(a) + "%";
            range.style.width = Math.max(0, share(b) - share(a)) + "%";
        } else range.style.display = "none";
        line.style.left = share(s ? s.head : 0) + "%";
        line.style.display = s && !s.still ? "" : "none";
        const tc = body.querySelector(".src-tc");
        if (!s) { tc.textContent = ""; return; }
        const T = (t) => D.timecode(t, fps);
        let text = s.still ? "still" : T(s.head);
        if (has(s.in)) text += `  in ${T(s.in)}`;
        if (has(s.out)) text += `  out ${T(s.out)}`;
        if (has(s.in) && has(s.out)) text += `  (${Math.round((s.out - s.in) * fps)} fr)`;
        tc.textContent = text;
        body.dataset.head = String(Math.round(s.head * fps));
        const play = body.querySelector(".src-play");
        if (play) play.textContent = this._editSrcPlaying ? "■" : "▶";
    },

    // ── the source's own transport ───────────────────────────────────────────

    /** The source's playhead to `t` seconds (on the cut's frames, held to the source). */
    editSrcSeek(t) {
        const s = this._editSrcState();
        if (!s || s.still) return;
        const fps = this._editSrcFps();
        const end = s.dur > 0 ? s.dur - 1 / fps : Infinity;
        s.head = Math.max(0, Math.min(end, Math.floor((Number(t) || 0) * fps + 1e-6) / fps));
        const m = this._editSrcEl;
        if (m && !this._editSrcPlaying) { try { m.currentTime = s.head + 0.5 / fps; } catch (_) {} }
        this._editSrcKeep();
        this._editSrcDraw();
    },

    editSrcStep(frames) {
        const s = this._editSrcState();
        if (!s) return;
        this.editSrcSeek(s.head + frames / this._editSrcFps());
    },

    editSrcPlay(on) {
        const s = this._editSrcState(), m = this._editSrcEl;
        if (!s || s.still || !m) return;
        const go = on === undefined ? !this._editSrcPlaying : !!on;
        if (!go) { try { m.pause(); } catch (_) {} this._editSrcStopped(); return; }
        if (this.isPlaying && this.stop) this.stop();          // one thing plays at a time
        this._editSrcPlaying = true;
        try { const p = m.play(); if (p && p.catch) p.catch(() => this._editSrcStopped()); } catch (_) {}
        const win = this.editSourcePanel.ownerDocument.defaultView || window;
        const tick = () => {
            if (!this._editSrcPlaying) return;
            const fps = this._editSrcFps();
            s.head = Math.max(0, Math.floor(m.currentTime * fps + 1e-6) / fps);
            this._editSrcDraw();
            win.requestAnimationFrame(tick);
        };
        win.requestAnimationFrame(tick);
        this._editSrcDraw();
    },

    _editSrcStopped() {
        if (!this._editSrcPlaying) return;
        this._editSrcPlaying = false;
        this._editSrcKeep();
        this._editSrcDraw();
    },

    /** Mark the source's in or out at its playhead ("in" / "out"), or clear both (null). */
    editSrcMark(which) {
        const s = this._editSrcState();
        if (!s) return;
        const fps = this._editSrcFps();
        if (!which) { s.in = null; s.out = null; }
        else if (s.still) {
            // A still has no time of its own: its marks are a length from 0.
            if (which === "out") { s.in = 0; s.out = Math.max(1 / fps, s.out || STILL_SECONDS); }
        } else if (which === "in") {
            s.in = s.head;
            if (s.out !== null && s.out !== undefined && s.out <= s.in) s.out = null;
        } else {
            s.out = Math.round((s.head + 1 / fps) * 1e4) / 1e4;   // the out frame is in the range
            if (s.in !== null && s.in !== undefined && s.in >= s.out) s.in = null;
        }
        this._editSrcKeep();
        this._editSrcDraw();
    },

    _editSrcScrubDown(e, scrub) {
        const s = this._editSrcState();
        if (!s || s.still || !(s.dur > 0)) return;
        e.preventDefault();
        const at = (ev) => {
            const r = scrub.getBoundingClientRect();
            return Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width))) * s.dur;
        };
        if (this._editSrcPlaying) this.editSrcPlay(false);
        this.editSrcSeek(at(e));
        const win = scrub.ownerDocument.defaultView || window;
        const move = (ev) => this.editSrcSeek(at(ev));
        const up = () => { win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
    },

    _editSrcKey(e) {
        if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
        const low = String(e.key).toLowerCase();
        const fps = this._editSrcFps();
        let done = true;
        const kind = sourceEditKey(e.key, e.shiftKey);
        if (kind) this.editSrcEdit(kind);
        else if (e.key === " ") this.editSrcPlay();
        else if (low === "i" && !e.altKey) this.editSrcMark("in");
        else if (low === "o" && !e.altKey) this.editSrcMark("out");
        else if (low === "x" && (e.altKey || e.shiftKey)) this.editSrcMark(null);
        else if (low === "f" && e.shiftKey) this.editSrcMatchBack();
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") this.editSrcStep((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? Math.round(fps) : 1));
        else if (e.key === "Home") this.editSrcSeek(0);
        else if (e.key === "End") this.editSrcSeek(Infinity);
        else done = false;
        if (done) { e.preventDefault(); e.stopPropagation(); }
    },

    async _editSrcDrop(dt) {
        let items = [];
        try {
            const raw = dt.getData(DRAG_TYPE);
            if (raw) items = (JSON.parse(raw).items) || [];
        } catch (_) {}
        if (!items.length && dt.files && dt.files.length && this._editTlOsItems) items = this._editTlOsItems(dt.files);
        if (!items.length) return;
        const got = this._editTlResolve ? await this._editTlResolve(items.slice(0, 1)) : { items };
        const it = got.items && got.items[0];
        if (!it || !it.path) { this._editTlSay("cannot load that into the Source viewer"); return; }
        await this.editSrcLoad({ path: it.path, name: it.name || it.filename }, 0);
    },

    // ── where it goes, and the edit ─────────────────────────────────────────

    /** The tracks a source can go to: video tracks for a picture, sound tracks (not the bed) for a sound. */
    _editSrcTracks(cut, sound) {
        if (!cut) return [];
        const tracks = (cut.tracks || []).filter((k) => (sound ? k.kind === "audio" : k.kind === "video"));
        return sound ? tracks.map((k) => k.id) : ["V1", ...tracks.map((k) => k.id)];
    },

    /** The destination: the one picked in the menu, else the selected clip's track, else V1 (a sound: the first sound track). */
    _editSrcDest(cut, sound) {
        const list = this._editSrcTracks(cut, sound);
        const v = this._editTlView || {};
        const picked = sound ? v.srcAudio : v.srcTrack;
        if (picked && list.includes(picked)) return picked;
        if (!sound && this._editTlInsertTrack) return this._editTlInsertTrack();
        return list[0] || "";
    },

    /**
     * One of the source edits (SOURCE_BUTTONS) with what is marked: one undo step,
     * the new clip selected, the playhead after it. -> true when the cut changed.
     */
    editSrcEdit(kind) {
        const s = this._editSrcState();
        let cut = this._editTlCut;
        if (!s) { this._editTlSay("load a source first: drop a clip on the Source viewer, or F on the timeline"); return false; }
        if (!cut) return false;
        const fps = cut.fps || 24;
        const r = this._editTlRangeSeconds ? this._editTlRangeSeconds() : null;
        const head = (Number(this.currentFrame) || 0) / fps;
        const tl = { in: r ? r.a : null, out: r ? r.b : null, head };
        const has = (v) => v !== null && v !== undefined;
        let tp;
        if (s.still) {
            const length = has(s.in) && has(s.out) ? s.out - s.in : r ? r.b - r.a : STILL_SECONDS;
            tp = { in: 0, length, at: r ? r.a : head };
        } else {
            tp = D.threePoint({ in: s.in, out: s.out, head: s.head, dur: s.dur > 0 ? s.dur : Infinity }, tl);
        }
        if (kind === "fit" && !s.still) {
            const a = has(s.in) ? s.in : s.head;
            const b = has(s.out) ? s.out : s.dur;
            tp = b > a ? { in: a, length: b - a, at: tl.in } : { error: "mark the source's range first" };
        }
        if (tp.error) { this._editTlSay(tp.error); return false; }
        let track = this._editSrcDest(cut, s.sound);
        if (s.sound && !track) {
            cut = D.addTrack(cut, "audio");
            track = cut.tracks[cut.tracks.length - 1].id;
        }
        const res = D.sourceEdit(cut, kind, { file: s.file, name: s.name, in: tp.in, length: tp.length }, tp.at, {
            track: s.sound ? undefined : track, audio: s.sound ? track : undefined, mask: D.editMask(cut),
            head, srcHead: s.head, dur: s.dur > 0 ? s.dur : null, tlIn: tl.in, tlOut: tl.out,
        });
        if (res.error) { this._editTlSay(res.error); return false; }
        if (this._editTlApply(res.cut) === false) return false;
        this._editTlSel = res.sel;
        this._editTlMulti = null;
        const span = res.sel && D.selSpan(res.cut, res.sel);
        if (span && kind !== "replace" && this._editTlSeek) this._editTlSeek(span.end);
        this.editTlRefresh();
        const label = (SOURCE_BUTTONS.find((b) => b[0] === kind) || [kind, kind])[1];
        this._editTlSay(`${label}: ${s.name}, ${Math.round(tp.length * fps)} frames on ${res.sel && res.sel.track ? res.sel.track : "V1"}`);
        return true;
    },

    /** Shift+F, reverse match frame: the timeline's playhead to where the cut shows the source's frame. */
    editSrcMatchBack() {
        const s = this._editSrcState(), cut = this._editTlCut;
        if (!s || !cut) { this._editTlSay("load a source first"); return null; }
        const fps = cut.fps || 24;
        const hit = D.findSource(cut, s.file, s.still ? 0 : s.head + 0.5 / fps);
        if (!hit) { this._editTlSay(`the cut does not show ${s.name} at ${D.timecode(s.head, fps)}`); return null; }
        this._editTlSel = hit.sel;
        this._editTlMulti = null;
        if (this._editTlSeek) this._editTlSeek(Math.floor(hit.t * fps + 1e-6) / fps);
        this.editTlRefresh();
        return hit;
    },
};
