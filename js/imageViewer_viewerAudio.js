// imageViewer_viewerAudio.js
// The Viewer's own sound switches, the Edit page's pair in the same look (a
// speaker and a caret menu, imageViewer_editAudio.js), on the lower bar right
// of Toggle Overlays: audio playback on / off - a film or a sound in the viewer
// is heard or not - and, in the menu, audio scrubbing: short grains of the
// sound at the frame while the timeline is dragged or stepped, pitched with the
// speed of the drag (the Edit page's grains, _eaPlayGrain). Off, playback is
// muted and scrubbing silent.
//
// Kept apart from the Edit page's switches (Sebastian 2026-11-11: "switched on /
// off independently in the viewer and the edit page"), per viewer in
// localStorage STORE. A cut's tab plays through the Edit page's player and
// follows the Edit page's switches; this one is the rest of the viewer.
import { setEditIcon } from "./imageViewer_editIcons.js";
import { planGrain } from "./imageViewer_editAudio.js";

const STORE = "imageviewer.viewer.viewerAudio";
const WHOLE = 1e9;      // a viewer frame is one whole file: its source runs from 0 for as long as it lasts

export const ViewerAudioMixin = {

    /** { play, scrub }: the Viewer's switches (both on unless switched off). */
    _viewerAudio() {
        if (this._vaState) return this._vaState;
        let kept = null;
        try { kept = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (_) { kept = null; }
        this._vaState = { play: !(kept && kept.play === false), scrub: !(kept && kept.scrub === false) };
        return this._vaState;
    },

    /** The speaker and its caret, right of Toggle Overlays (made here, not in the markup, like the full screen button). */
    _initViewerAudio() {
        const sr = this.shadowRoot;
        if (!sr) return;
        let btn = sr.getElementById("audio-btn");
        let more = sr.getElementById("audio-more-btn");
        if (!btn) {
            btn = document.createElement("button");
            btn.id = "audio-btn";
            btn.className = "sprite-icon";
            more = document.createElement("button");
            more.id = "audio-more-btn";
            more.className = "audio-caret";
            more.textContent = "▾";
            more.title = "Sound options";
            const after = this.overlaysBtn || sr.getElementById("layout-btn");
            if (after && after.parentNode) {
                after.parentNode.insertBefore(btn, after.nextSibling);
                btn.parentNode.insertBefore(more, btn.nextSibling);
            } else if (this.refreshBtn && this.refreshBtn.parentNode) {
                this.refreshBtn.parentNode.insertBefore(btn, this.refreshBtn);
                this.refreshBtn.parentNode.insertBefore(more, this.refreshBtn);
            }
        }
        btn.onclick = () => this.viewerAudioToggle("play");
        more.onclick = () => {
            const st = this._viewerAudio();
            const tick = (on, label) => (on ? "✓ " : "  ") + label;
            const r = more.getBoundingClientRect();
            const rows = [{ label: tick(st.play, "Audio playback"), run: () => this.viewerAudioToggle("play") },
                          { label: tick(st.scrub, "Audio scrubbing"), disabled: !st.play, run: () => this.viewerAudioToggle("scrub") }];
            // Below the caret; the menu turns upwards itself where the viewer ends.
            this._previzOpenMenu?.(rows, r.left, r.bottom + 2, more);
        };
        this.audioBtn = btn;
        this.audioMoreBtn = more;
        this._viewerAudioDraw();
    },

    /** "play" or "scrub" switched (or set to `on`); what is playing is heard, or not, at once. */
    viewerAudioToggle(which, on) {
        const st = this._viewerAudio();
        const key = which === "scrub" ? "scrub" : "play";
        st[key] = on === undefined ? !st[key] : !!on;
        try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (_) {}
        if (!st.play || !st.scrub) this._vaSilence();
        this._viewerAudioApply();
        this._viewerAudioDraw();
    },

    /** The viewer's <video> (films and sounds) muted while playback is off. A cut's tab is the Edit page's. */
    _viewerAudioApply() {
        if (this._editPlayOn) return;
        const v = this.videoBase;
        if (!v) return;
        v.muted = !this._viewerAudio().play;
        // The Edit page's player sets loudness by volume (its own switch at 0): handed back, it is the viewer's again.
        if (v.volume !== 1) { try { v.volume = 1; } catch (_) {} }
    },

    _viewerAudioDraw() {
        const btn = this.audioBtn;
        if (!btn) return;
        const st = this._viewerAudio();
        const icon = st.play ? "volume" : "volumeOff";
        if (btn.dataset.icon !== icon) setEditIcon(btn, icon);
        btn.classList.toggle("on", st.play);
        btn.setAttribute("aria-pressed", st.play ? "true" : "false");
        btn.title = st.play
            ? "Audio playback is on: click to switch the viewer's sound off - playing and scrubbing (the Edit page has its own switch)"
            : "Audio playback is OFF: films and sounds play silently in the viewer. Click to hear them";
        if (this.audioMoreBtn) {
            this.audioMoreBtn.title = "Sound options: audio scrubbing is " + (st.scrub ? "on" : "off");
        }
    },

    // ── scrubbing ────────────────────────────────────────────────────────────

    /**
     * The viewer showed frame `seconds` of the film or sound `obj` without
     * playing (the timeline dragged, a step, a jump): a grain of its sound there.
     * The first look at a file is silent (opening a tab is no scrub), but starts
     * reading its sound.
     */
    viewerScrubAt(obj, seconds) {
        const st = this._viewerAudio();
        if (!obj || !st.play || !st.scrub || this.isPlaying || this._editPlayOn) return;
        const key = obj.url || obj.path || ("?" + (obj.type || "output") + "/" + (obj.subfolder || "") + "/" + (obj.filename || ""));
        (this._eaRefs ||= new Map()).set(key, obj);
        const now = performance.now();
        const cur = { t: Math.max(0, Number(seconds) || 0), ms: now };
        const prev = this._vaLast;
        if (!prev || prev.key !== key) {
            // A file just opened: no sound now; the next move is heard as a step (ms 0 is long ago).
            this._vaLast = { key, t: cur.t, ms: 0 };
            if (this._eaCtx) this._eaWant(key);
            return;
        }
        const ctx = this._eaContext && this._eaContext();
        if (!ctx) return;
        this._eaWant(key);
        this._vaLast = { key, t: cur.t, ms: now };
        const plan = planGrain(prev.ms ? prev : null, cur, this._eaUntil || 0, ctx.currentTime);
        if (!plan || plan.wait) return;
        if (!this._eaHave(key)) return;
        this._eaPlayGrain(ctx, plan, [{ file: key, gain: 1, clip: { in: 0, length: WHOLE }, origin: 0, start: 0, end: WHOLE }], cur.t);
    },

    /** Stop what is queued and forget the last look (switched off, or playing began). */
    _vaSilence() {
        this._eaSilence?.();
        if (this._vaLast) this._vaLast = { ...this._vaLast, ms: 0 };
    },
};
