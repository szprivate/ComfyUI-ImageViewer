// imageViewer_editPlay.js
// Playing a cut before it is a film: the Edit tab.
//
// A cut being worked on in the Edit panel (imageViewer_editTimeline.js) has a tab
// of its own - key "edit:…", no media frames - and in that tab the viewport shows
// the CUT: the clip that is on screen at the frame, from its own file, with the
// transport (play, scrub, step, loop, the ctrl-dragged range, the fps field)
// working on the film's frames as it does on any clip. Nothing is rendered for
// it; a change to the cut is on screen with the next frame.
//
// How it is hooked in: like previz, by a question asked first in the playback
// mixin - isEditTab() - in getImgCount, setFrame, play and stop, and in
// switchTab. Everything else (zoom, pan, fit, exposure, the frame export) keeps
// reading `this.videoBase` / `this.imgBase`, so the player shows a clip through
// those: a picture in the <img>, a film in a <video>.
//
// Two <video>s, taking turns. The one on screen is `this.videoBase`; the other
// is given the NEXT clip, sought to its in point, and waits. At the cut they
// change places, so the cut costs no loading. (The viewer's own element is one
// of the two and is handed back on the way out.) A clip that was not made ready
// - after a scrub - is loaded behind the picture that is up and shown when its
// frame is there, so nothing flashes black.
//
// Tracks: the picture is the clip of the highest video track that has one at
// the moment (pictureAt), and only that clip is heard; the bed and the clips of
// the sound tracks play under it from <audio> elements kept beside the film's
// clock. A track that is switched off, or left out by another one's solo, is
// neither seen nor heard (liveTracks). The render follows the same rules, save
// for solo, which is a way of listening and is not rendered.
//
// A dissolve is played as one: for its length the clip going out keeps running
// in one layer (`under`) and the clip coming in lies over it at a rising
// opacity, their sound crossing the same way. Which layers those are depends on
// what the two clips are - two films take the two <video>s, a picture the
// <img>, two pictures the <img> and a second one kept for this.
//
// A clip's transform, cropping and opacity (the Inspector's Video tab; clipFx)
// are drawn by the layer the clip is in: a CSS transform put after the viewer's
// own zoom and pan, a clip-path that keeps the picture inside the frame and its
// crop, an opacity (fxPlace - the render's arithmetic, timeline_render.lay). A
// clip on a higher track that no longer covers the frame has what is beneath it
// in the second layer, the way a dissolve has the clip going out.
//
// Titles (clips of the video tracks whose picture is words, titlesAt) are drawn
// as the render draws them (title_render): each on a canvas of its own laid over
// the picture's rectangle, the words in the frame there (imageViewer_editTitles /
// paintTitle, the font the server's list names), and the canvas takes the clip's
// transform, crop and opacity as a picture's layer does. Above the picture when
// its track is; below it - under a picture of a higher track that does not cover
// the frame - when it is not, and not at all under one that does.
import * as D from "./imageViewer_editTimelineData.js";
import { fontList, fontsKnown, paintTitle } from "./imageViewer_editFonts.js";

const PREFIX = "edit:";
// Play around edit (the Trim mode, an edit point selected): this many seconds before and after the cut.
export const PLAY_AROUND = 1;

// How the film's elements are kept beside its clock while it plays (seconds,
// of the source at speed 1). The clock is ONE clock, run from the wall clock
// and set again only where the film jumps (a seek, a loop going round): a
// <video> or <audio> that is a little off has its rate nudged (`nudge` at most,
// in steps of `step`) until it is within `ok`; one further off than `seek` is
// sought - and is then left to settle for `settle` ms before it is looked at
// again, since a sought element's position runs late while it buffers and
// starts. A clip run into at a cut is sought only when its frame is further off
// than `cut`; it is started `lag` before the cut at first, then as early as the
// player turned out to need.
export const FOLLOW = { ok: 0.03, seek: 0.25, cut: 0.05, nudge: 0.05, step: 0.01, settle: 400, lag: 0.05 };

/**
 * The rate an element runs at to come back to the clock: `rate` nudged by its
 * drift `d` (seconds of source, + ahead), at most FOLLOW.nudge either way, in
 * steps of FOLLOW.step (a rate change is not free); `rate` itself within `ok`.
 */
export function followRate(rate, d, opt = FOLLOW) {
    if (!(Math.abs(d) > opt.ok)) return rate;
    const k = Math.max(-opt.nudge, Math.min(opt.nudge, -d * 2));
    return rate * (1 + Math.round(k / opt.step) * opt.step);
}

/**
 * What to do with an element that should be at `want` and is at `cur`: "seek",
 * or the rate to run at. `since` ms since it was last sought (Infinity: never),
 * `scale` the source seconds per film second (a retimed clip's speed).
 */
export function followPlan(cur, want, rate, since, scale = 1, opt = FOLLOW) {
    if (since < opt.settle) return { rate };
    const d = cur - want;
    if (Math.abs(d) > opt.seek * Math.max(1, scale)) return { seek: true, rate };
    return { rate: followRate(rate, d / Math.max(1e-6, scale), opt) };
}

export const EditPlayMixin = {

    isEditTab(key = this.activeTab) {
        return typeof key === "string" && key.startsWith(PREFIX);
    },

    /** The cut the tab on screen plays; null on any other tab. */
    _editPlayCut() {
        return (this._editPlayOn && this._editTlTab === this.activeTab && this._editTlCut) || null;
    },

    editPlayFps() {
        const cut = this._editPlayCut();
        return cut && cut.fps > 0 ? cut.fps : 24;
    },

    editPlayFrameCount() {
        const cut = this._editPlayCut();
        return cut ? D.filmFrames(cut) : 1;
    },

    // ── the two players ──────────────────────────────────────────────────────

    _editPlaySlots() {
        if (this._epSlots && this._epSlots[1].isConnected) return this._epSlots;
        const home = this._epHome || this.videoBase;
        if (!home) return null;
        this._epHome = home;
        const other = home.ownerDocument.createElement("video");
        other.className = home.className;
        other.playsInline = true;
        other.style.display = "none";
        home.parentNode.insertBefore(other, home.nextSibling);
        for (const v of [home, other]) {
            if (v._epBound) continue;
            v._epBound = true;
            const sized = () => {
                if (!this._editPlayOn || v !== this.videoBase) return;
                if (this.updateImageFrame) this.updateImageFrame();
                if (this.updateToolOverlay) this.updateToolOverlay();
                this.updateShapeInfo();
                this._editPlayFitOnce();
            };
            v.addEventListener("loadedmetadata", sized);
            v.addEventListener("resize", sized);
            v.addEventListener("error", () => {
                if (!this._editPlayOn || v !== this.videoBase || !v.getAttribute("src")) return;
                this._editTlSay?.("this clip cannot be played here: " + String(v._epName || ""));
            });
        }
        this._epSlots = [home, other];
        // A second <img>, for the picture going out when one picture dissolves
        // into another. (The titles' canvases are made as they are needed.)
        const doc = home.ownerDocument;
        this._epImgB = doc.createElement("img");
        this._epImgB.className = home.className;
        this._epImgB.style.display = "none";
        this._epImgB.draggable = false;
        home.parentNode.insertBefore(this._epImgB, home);
        return this._epSlots;
    },

    /** Every layer the player may draw a picture in. */
    _editPlayLayers() {
        return [...(this._epSlots || []), this._epImgB, this.imgBase].filter(Boolean);
    },

    // The viewer zooms and pans by a transform on its own two layers
    // (`_epViewerT`, noted each time it changes). Every layer the player draws in
    // takes that one, and after it the transform of the clip it shows; the
    // texts follow the picture. Called whenever the viewer's transform changes
    // (updateTransform) and after a show.
    _editPlayMirror(viewerChanged) {
        if (!this._editPlayOn) return;
        if (viewerChanged || this._epViewerT == null) {
            // updateTransform has just written the plain transform into both of its layers.
            this._epViewerT = (this._videoMode && this.videoBase ? this.videoBase : this.imgBase).style.transform || "";
        }
        const base = this._epViewerT;
        const live = this._editFxLive;
        for (const el of this._editPlayLayers()) {
            const clip = el._epClip;
            // Keyframes: the clip's look at this moment of its own time (clipFx(clip, u)).
            const fx = clip ? D.clipFx(live && live.clip === clip ? { fx: live.fx } : clip, this._editPlayU(el)) : null;
            let transform = base, clipPath = "";
            if (fx) {
                const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
                const W = el.clientWidth, H = el.clientHeight;
                if (w && h && W && H) {
                    // Where the picture lies in its layer: fitted, in the middle.
                    const s = Math.min(W / w, H / h);
                    const place = D.fxPlace(fx, { x: (W - w * s) / 2, y: (H - h * s) / 2, w: w * s, h: h * s });
                    transform = (base + " " + place.transform).trim();
                    clipPath = place.clip;
                }
            }
            if (el.style.transform !== transform) el.style.transform = transform;
            if (el.style.clipPath !== clipPath) el.style.clipPath = clipPath;
        }
        if (this._ep && this._ep.at) this._editPlayMix(this._ep.at);
        this._editPlayTitles();
    },

    /** A clip's opacity as it is drawn at clip time `u` (1 for a clip as it comes), a live Inspector drag included. */
    _editPlayOpacity(clip, u = 0) {
        const live = this._editFxLive;
        const fx = clip ? D.clipFx(live && live.clip === clip ? { fx: live.fx } : clip, u) : null;
        return fx ? fx.op : 1;
    },

    /** The moment of the film on screen (the clock while playing, else the frame's middle). */
    _editPlayT() {
        const ep = this._ep;
        return ep && ep.tNow != null ? ep.tNow : ((this.currentFrame || 0) + 0.5) / this.editPlayFps();
    },

    /** How far into its clip the layer `el` is now (its keyframes' time). */
    _editPlayU(el) {
        return Math.max(0, this._editPlayT() - (el && el._epOrigin != null ? el._epOrigin : 0));
    },

    /**
     * The Inspector is dragging a slider: draw `clip` with `fx` for now, without
     * changing the cut (which would redraw the slider under the pointer). null
     * ends it.
     */
    editPlayFxLive(clip, fx) {
        this._editFxLive = clip ? { clip, fx } : null;
        this._editPlayMirror();
    },

    /** The Inspector is dragging a title's slider: draw `clip` with the look `look` for now (null ends it). */
    editPlayTitleLive(clip, look) {
        this._editTitleLive = clip ? { clip, look } : null;
        this._editPlayTitles();
    },

    // The first picture of a tab is fitted to the viewport; after that the zoom
    // is the user's, whatever size the next clip has.
    _editPlayFitOnce() {
        const ep = this._ep;
        if (!ep || ep.fitted) return;
        const size = this._displayedMediaSize();
        if (!size) return;
        ep.fitted = true;
        this.fitView();
    },

    // ── coming and going ─────────────────────────────────────────────────────

    /** The tab `key` came up (switchTab). Safe to call again for the tab that is up. */
    editPlayEnter(key) {
        if (this.editTlUse) this.editTlUse(key);
        // The cut's in and out come back with it: switching tabs clears the transport's range.
        const kept = this._editTlView && this._editTlView.range;
        if (kept && !this.isInputRangeLocked) this.playbackRange = { start: kept.start, end: kept.end };
        const fresh = !this._editPlayOn;
        if (fresh) {
            if (this._exitModelMode) this._exitModelMode();
            this._exitVideoMode();
            this._editPlayOn = true;
            this._epSavedFps = this.fps;
            this._ep = { fitted: false };
        }
        this._epCutShown = this._editTlCut;
        this._setFpsUi(this.editPlayFps());
        if (this.editTlTabShown) this.editTlTabShown(key, fresh);
    },

    /** Another tab is coming up, or this one is closing: hand the viewport back. */
    editPlayLeave() {
        if (!this._editPlayOn) return;
        this.stop();
        this._editPlayOn = false;
        for (const v of this._epSlots || []) {
            v._epUrl = null;
            v._epWait = (v._epWait || 0) + 1;
            try { v.pause(); } catch (_) {}
            v.removeAttribute("src");
            try { v.load(); } catch (_) {}
            v.style.display = "none";
        }
        if (this._epHome) this.videoBase = this._epHome;
        this._editPlayLook(null, null);                   // no wipe's mask, no dip's colour left behind
        for (const a of (this._ep && this._ep.bed) || []) { try { a.pause(); } catch (_) {} }
        for (const el of this._editPlayLayers()) {
            el.style.opacity = "";
            el.style.zIndex = "";
            el.style.clipPath = "";
            el._epClip = null;
            if (this._epViewerT != null) el.style.transform = this._epViewerT;
        }
        this._epViewerT = null;
        this._editFxLive = null;
        if (this._epImgB) { this._epImgB.style.display = "none"; this._epImgB.removeAttribute("src"); }
        for (const el of this._epTitleEls || []) { el.style.display = "none"; el._sig = ""; }
        this._editTitleLive = null;
        this._ep = null;
        this._epCutShown = null;
        this._videoMode = false;
        this._videoKey = null;
        this._videoFrames = 0;
        if (this.imgBase) { this.imgBase.style.display = ""; this.imgBase.removeAttribute("src"); }
        if (this._epSavedFps != null) { this._setFpsUi(this._epSavedFps); this._epSavedFps = null; }
        this._editTlPlayhead?.();
    },

    /** A solo switch was pressed: the same cut, shown and heard differently. */
    editPlayLiveChanged() {
        this._epCutShown = null;
        this.editPlayCutChanged();
    },

    /** The cut was changed in the panel: its length, and what is at this frame. */
    editPlayCutChanged() {
        if (!this._editPlayOn || this._editTlTab !== this.activeTab) return;
        if (this._epCutShown === this._editTlCut) return;
        this._epCutShown = this._editTlCut;
        const bounds = this.applyTimelineBounds();
        const playing = this.isPlaying;
        this.editPlaySetFrame(Math.max(bounds.min, Math.min(this.currentFrame || 0, bounds.max)));
        const cut = this._editPlayCut();
        if (playing && !(cut && cut.clips.length)) this.stop();
    },

    // ── a frame ──────────────────────────────────────────────────────────────

    _editPlayReadout(frame) {
        if (this.timeline) this.timeline.value = frame;
        const cur = this.container && this.container.querySelector("#cur-f");
        if (cur) cur.innerText = frame;
    },

    editPlaySetFrame(idx) {
        const bounds = this.getTimelineBounds();
        const frame = Math.max(bounds.min, Math.min(Math.round(Number(idx) || 0), bounds.max));
        this.currentFrame = frame;
        this._editPlayReadout(frame);
        this._editPlayShow((frame + 0.5) / this.editPlayFps(), true);
        this._updateCompareFrame(frame);
        this._toolsFrameChanged();
        if (this.editTwoUpRest) this.editTwoUpRest();          // Trim mode: a cut under the playhead shows its two-up
    },

    _editPlayBlank() {
        for (const v of this._epSlots || []) {
            v._epWait = (v._epWait || 0) + 1;
            try { v.pause(); } catch (_) {}
            v.style.display = "none";
        }
        for (const el of this._editPlayLayers()) { el.style.opacity = ""; el.style.zIndex = ""; }
        if (this._epImgB) this._epImgB.style.display = "none";
        if (this._ep) this._ep.underEl = null;
        this._videoMode = false;
        if (this.imgBase) { this.imgBase.style.display = ""; this.imgBase.removeAttribute("src"); }
        if (this.imgFrame) this.imgFrame.style.display = "none";
        this._updatePathBar(null);
        this.updateShapeInfo();
    },

    /** The tracks that are seen and heard now (EditTimelineMixin keeps the solo switches). */
    _editPlayLive() {
        return this._editTlLive ? this._editTlLive() : null;
    },

    // Put the moment `t` (seconds of the film) on screen. `seek`: the moment was
    // asked for (a scrub, a step, a loop); without it the film ran into it.
    _editPlayShow(t, seek) {
        const cut = this._editPlayCut();
        const ep = this._ep;
        if (!ep) return;
        const at = cut && D.pictureAt(cut, t, this._editPlayLive());
        if (!at) { ep.at = null; ep.key = ""; this._editPlayBlank(); this._editPlayTitles(); return; }
        const clip = at.clip;
        ep.t = at.t;
        ep.tNow = at.t;
        ep.wall = this._editPlayNow();
        const slots = this._editPlaySlots();
        if (!slots) return;

        if (!clip) {
            // Nothing has a picture here (a gap, a track switched off): black,
            // for as long as that lasts, on the wall clock.
            ep.at = at;
            ep.key = "";
            ep.url = "";
            ep.still = true;
            this._editPlayBlank();
            this._editPlayReady(cut, at, slots[1]);
            this._editPlaySounds(at.t, this.isPlaying, seek);
            this._editPlayTitles();
            return;
        }
        const obj = { path: clip.file, external: true, name: clip.name };
        const url = this._editPlayUrl ? this._editPlayUrl(clip.file) : this.buildImgUrl(obj, { noColor: true });   // its proxy, when it has one
        const same = !!ep.at && ep.key === at.key && ep.url === url;
        ep.at = at;
        ep.in = Number(clip.in) || 0;
        ep.key = at.key;
        ep.url = url;
        this._updatePathBar(obj);

        if (D.isStill(clip.file)) {
            ep.still = true;
            // The picture going out, when it is one too, moves to the second
            // <img> before this one takes the first.
            const under = this._editPlayUnder(at, this.imgBase);
            this.imgBase._epClip = clip;
            this.imgBase._epOrigin = at.origin;
            for (const v of slots) {
                v._epWait = (v._epWait || 0) + 1;
                if (v !== under) { try { v.pause(); } catch (_) {} }
            }
            this._videoMode = false;
            this._setImgSrcCached(this.imgBase, url, () => {
                if (!this._editPlayOn || !this._ep || !this._ep.still || this._ep.url !== url) return;
                for (const v of slots) if (v !== this._ep.underEl) v.style.display = "none";
                this.imgBase.style.display = "";
                if (this.updateImageFrame) this.updateImageFrame();
                this.updateShapeInfo();
                this._editPlayFitOnce();
                this._editPlayMirror();
            });
            this._editPlayMix(at);
            if (!under) this._editPlayReady(cut, at, this.videoBase === slots[0] ? slots[1] : slots[0]);
            this._editPlaySounds(at.t, this.isPlaying, seek);
            this._editPlayMirror();
            return;
        }

        ep.still = false;
        // A ping-pong's way back, or a speed the browser will not play at: shown
        // frame by frame on the wall clock, the film sought to each (stepped).
        const rate = this._editPlayRate(at);
        ep.stepped = !!at.rev || rate < 0.0625 || rate > 16;
        const mine = this.videoBase === slots[1] ? slots[1] : slots[0];
        const other = mine === slots[0] ? slots[1] : slots[0];
        let v;
        if (same && this._videoMode && mine._epUrl === url) v = mine;      // the clip that is up
        else if (other._epUrl === url && other !== ep.underEl) v = other;   // made ready beforehand
        else if (mine._epUrl === url) v = mine;
        else { v = other; this._editPlayLoad(v, url); }
        v._epName = clip.name || String(clip.file || "").split(/[\\/]/).pop();
        v._epNext = null;
        // Asked for (a scrub, a loop round): to the frame. Run into the next
        // clip (made ready at its in point): the few ms the clock is past the
        // cut are the follower's to take up (_editPlayFollow) - a seek there
        // would throw the ready-made frame away. The clip that is up: the
        // follower's altogether.
        const off = Math.abs((v.currentTime || 0) - at.local);
        if (off > (seek ? 1e-3 : !same ? FOLLOW.cut : FOLLOW.seek)) {
            try { v.currentTime = at.local; v._epSought = this._editPlayNow(); v._epPreroll = false; } catch (_) {}
        }
        const under = this._editPlayUnder(at, v);
        v._epClip = clip;
        v._epOrigin = at.origin;
        this._editPlayFront(v, v === mine ? other : mine);
        this._editPlayMix(at);
        if (this.isPlaying && !ep.stepped) {
            this._editPlaySpeed(v, at);
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
        } else if (ep.stepped) {
            try { v.pause(); } catch (_) {}
        }
        this._editPlaySounds(at.t, this.isPlaying, seek);
        if (!under) this._editPlayReady(cut, at, v === mine ? other : mine);
        this._editPlayMirror();
    },

    // The <video> on screen kept beside the film's clock `t` (followPlan):
    // nudged, sought only when far off, started again if something paused it
    // (a pop-out moves it). Every frame: a look at its position costs nothing.
    _editPlayFollow(v, at, t) {
        if (!v || v.ended || !at || !at.clip) return;
        const speed = at.speed > 0 ? at.speed : 1;
        const seg = at.segAt != null ? at.segAt : at.origin;
        const base = at.base != null ? at.base : (Number(at.clip.in) || 0);
        const want = base + Math.max(0, t - seg) * speed;
        if (v.duration > 0 && want >= v.duration - 0.05) return;  // a film shorter than its clip: its last frame holds
        const nominal = Math.max(0.0625, Math.min(16, this._editPlayRate(at)));
        const now = this._editPlayNow();
        const settling = v.seeking || v.readyState < 3;
        const since = settling ? 0 : v._epSought != null ? now - v._epSought : Infinity;
        if (v._epPreroll && since >= FOLLOW.settle) {
            // Started before the cut: how far off it came in is how much earlier (or later) to start the next time.
            v._epPreroll = false;
            const d = ((v.currentTime || 0) - want) / speed;
            v._epLag = Math.max(0, Math.min(0.25, (v._epLag != null ? v._epLag : FOLLOW.lag) - d));
        }
        const plan = followPlan(v.currentTime || 0, want, nominal, since, speed);
        try {
            if (plan.seek) { v.currentTime = want; v._epSought = now; }
            if (Math.abs(v.playbackRate - plan.rate) > 1e-6) v.playbackRate = plan.rate;
            if (v.paused && !(now - (v._epPlayTry || 0) < 500)) {
                v._epPlayTry = now;
                const p = v.play(); if (p && p.catch) p.catch(() => {});
            }
        } catch (_) {}
    },

    /** The rate a film plays at for the moment `at`: the fps field's, times the clip's speed. */
    _editPlayRate(at) {
        const fps = this.editPlayFps();
        return ((this.fps || fps) / fps) * (at && at.speed > 0 ? at.speed : 1);
    },

    // A retimed clip plays at its speed like tape: the sound is pitched with it
    // (as the render makes it, timeline_render.clip_sound), and silent beyond
    // 0.25x .. 4x, where the render leaves it out too.
    _editPlaySpeed(v, at) {
        const rate = Math.max(0.0625, Math.min(16, this._editPlayRate(at)));
        const speed = at && at.speed > 0 ? at.speed : 1;
        try {
            v.playbackRate = rate;
            if ("preservesPitch" in v) v.preservesPitch = speed === 1;
            v.muted = speed < 0.25 || speed > 4;
        } catch (_) {}
    },

    // The clip going out of a dissolve, kept running beneath the one coming in
    // (`main` is the layer that one is in). Returns the layer it is in, or null
    // outside a dissolve - and puts away a layer that was one and no longer is.
    _editPlayUnder(at, main) {
        const ep = this._ep;
        const u = at && at.under;
        const slots = this._epSlots;
        let el = null;
        if (u && u.clip) {
            const url = this._editPlayUrl ? this._editPlayUrl(u.clip.file) : this.buildImgUrl({ path: u.clip.file, external: true }, { noColor: true });
            if (D.isStill(u.clip.file)) {
                el = main === this.imgBase ? this._epImgB : this.imgBase;
                if (el._epShown !== url) { el._epShown = url; el.src = url; }
                el.style.display = "block";
            } else {
                el = slots.find((s) => s !== main && s._epUrl === url) || slots.find((s) => s !== main);
                el._epNext = null;
                if (el._epUrl !== url) this._editPlayLoad(el, url);
                if (Math.abs((el.currentTime || 0) - u.local) > 0.12) { try { el.currentTime = u.local; } catch (_) {} }
                el._epWait = (el._epWait || 0) + 1;                 // it is not waiting to become the picture
                el.style.display = "block";
                try {
                    if (this.isPlaying) {
                        el.playbackRate = Math.max(0.0625, Math.min(16, (this.fps || this.editPlayFps()) / this.editPlayFps() * D.speedOf(u.clip)));
                        const p = el.play();
                        if (p && p.catch) p.catch(() => {});
                    } else {
                        el.pause();
                    }
                } catch (_) {}
            }
            el._epClip = u.clip;
            el._epOrigin = u.origin;
            el.style.opacity = "1";
            el.style.zIndex = "1";
            main.style.zIndex = "2";
        } else {
            main.style.zIndex = "";
            main.style.opacity = "";
        }
        const was = ep.underEl;
        ep.underEl = el;
        if (was && was !== el && was !== main) {
            was.style.zIndex = "";
            was.style.opacity = "";
            was.style.display = "none";
            if (was.tagName === "VIDEO") { try { was.pause(); } catch (_) {} }
        }
        return el;
    },

    // The layers' opacity and loudness. In a dissolve the clip coming in lies
    // over the one going out at the dissolve's share, their sound crossing with
    // it; a clip that merely has something beneath it (`over`) lies there at its
    // own opacity, and is the one that is heard.
    _editPlayMix(at) {
        const ep = this._ep;
        if (!ep || !at) return;
        const main = ep.still ? this.imgBase : this.videoBase;
        const under = ep.underEl;
        const a = under && !at.over ? Math.max(0, Math.min(1, Number(at.mix) || 0)) : 1;
        const now = this._editPlayT();
        const u = Math.max(0, now - (at.origin || 0)), uu = at.under ? Math.max(0, now - (at.under.origin || 0)) : 0;
        const own = this._editPlayOpacity(at.clip, u);
        // What the transition is (a cross dissolve, a dip to a colour, a wipe): D.transitionLook, as the render's transition_frame.
        const look = under && !at.over ? D.transitionLook(at.clip && at.clip.tfx, a) : { inn: a, out: 1 };
        const show = Math.round(look.inn * own * 1000) / 1000;
        if (main) main.style.opacity = show === 1 && !under ? "" : String(show);
        if (under) under.style.opacity = String(Math.round(look.out * this._editPlayOpacity(at.under.clip, uu) * 1000) / 1000);
        this._editPlayLook(main, look);
        // A clip whose sound was split off (`mute`) is silent: its sound clip plays, at its own place.
        // The bar's speaker off (EditAudioMixin): everything at 0.
        const gain = this._editAudioGain ? this._editAudioGain() : 1;
        const loud = (clip, t) => D.clipVolume(clip, t) * gain;
        // Fades and audio crossfades (envGain): the film's own sound rises and falls with them; a crossfade's
        // sound beyond the cut is played by the sound items (soundItems' handles), not by this element.
        const cut = this._editPlayCut();
        const envOf = (sel) => (cut && sel ? D.audioEnv(cut, sel) : null);
        const env = envOf(at.sel);
        const underSel = at.under && /^V1:\d+$/.test(at.under.key || "") ? { kind: "clip", i: Number(at.under.key.slice(3)) } : null;
        const uenv = envOf(underSel);
        ep.envOn = D.envActive(env) || D.envActive(uenv);
        // Sound effects: the element goes through its clip's (and track's) WebAudio graph (imageViewer_editAfxPlay.js).
        try {
            if (!ep.still && this.videoBase) {
                if (this._editAfxEnsure) this._editAfxEnsure(this.videoBase, at.clip, D.selTrack(at.sel), at.origin);
                this._epVol(this.videoBase, loud(at.clip, u) * a * D.envGain(env, u));
            }
        } catch (_) {}
        try {
            if (under && under.tagName === "VIDEO") {
                if (this._editAfxEnsure && !at.over) this._editAfxEnsure(under, at.under.clip, "V1", at.under.origin);
                this._epVol(under, at.over ? 0 : loud(at.under.clip, uu) * (1 - a) * D.envGain(uenv, uu));
            }
        } catch (_) {}
    },

    // A wipe's edge (a mask on the layer coming in) and a dip's colour (the viewport's ground under both
    // layers); either is put away again on the next frame that has none, and on leaving (editPlayLeave).
    _editPlayLook(main, look) {
        const ep = this._ep;
        if (!ep) return;
        const wipe = look && look.wipe && main ? look.wipe : null;
        const clear = (el) => { if (el) { el.style.maskImage = el.style.webkitMaskImage = ""; } };
        if (ep.masked && ep.masked !== (wipe ? main : null)) { clear(ep.masked); ep.masked = null; }
        if (wipe) {
            const to = { right: "right", left: "left", down: "bottom", up: "top" }[wipe.dir] || "right";
            const p = Math.round(wipe.share * 10000) / 100;
            main.style.maskImage = main.style.webkitMaskImage = `linear-gradient(to ${to}, #000 ${p}%, transparent ${p}%)`;
            main.style.maskSize = main.style.webkitMaskSize = "100% 100%";
            ep.masked = main;
        }
        const host = main && main.parentNode;
        const color = look && look.color ? look.color : "";
        if (ep.dipHost && (ep.dipHost !== host || !color)) { ep.dipHost.style.backgroundColor = ep.dipWas || ""; ep.dipHost = null; }
        if (color && host) {
            if (!ep.dipHost) { ep.dipHost = host; ep.dipWas = host.style.backgroundColor; }
            host.style.backgroundColor = color;
        }
    },

    // The titles on screen now (titlesAt), each on a canvas of its own laid where
    // the picture's layer is - before the viewer's zoom and pan, which it then
    // takes - with the words drawn in the frame's rectangle and the clip's own
    // transform, crop and opacity after the viewer's (fxPlace, as for a picture).
    // Redrawn only when its look, size or font changed. With no `t` the moment is
    // the one on screen (the picture moved, not the film).
    _editPlayTitles(t) {
        const ep = this._ep;
        const pool = this._epTitleEls || (this._epTitleEls = []);
        const cut = this._editPlayCut();
        const moment = t != null ? t : (ep ? ((this.currentFrame || 0) + 0.5) / this.editPlayFps() : 0);
        const items = cut && ep ? D.titlesAt(cut, moment, this._editPlayLive()) : [];
        const main = this._videoMode ? this.videoBase : this.imgBase;
        let n = 0, low = false;
        if (items.length && main && main.parentNode) {
            if (!fontsKnown()) fontList().then(() => { for (const el of pool) el._sig = ""; this._editPlayTitles(); });
            // The frame: the picture's own size, else the last one seen (titles over black), else 1920 x 1080.
            let size = this._displayedMediaSize && this._displayedMediaSize();
            if (size && size.w > 0 && size.h > 0) this._epFrameSize = size; else size = this._epFrameSize || { w: 1920, h: 1080 };
            const host = main.parentNode;
            const doc = host.ownerDocument;
            let W = main.clientWidth, H = main.clientHeight, at = [main.offsetLeft, main.offsetTop];
            if (!W || !H || main.style.display === "none") { W = host.clientWidth; H = host.clientHeight; at = [0, 0]; }
            const s = Math.min(W / size.w, H / size.h);
            const w = size.w * s, h = size.h * s;
            const box = { x: (W - w) / 2, y: (H - h) / 2, w, h };
            const dpr = (doc.defaultView && doc.defaultView.devicePixelRatio) || 1;
            // The picture on screen and where its track is: a title of a lower track lies under it, if it lets anything show.
            const pic = ep && ep.at && ep.at.clip ? ep.at : null;
            const rank = D.pictureRank(cut, pic);
            const covers = !!pic && !pic.over && !D.clipFx(pic.clip, Math.max(0, moment - (pic.origin || 0)));
            for (const item of items) {
                const below = item.rank < rank;
                if (below && covers) continue;
                let el = pool[n];
                if (!el || el.ownerDocument !== doc) {
                    el = doc.createElement("canvas");
                    el.className = "edit-title-layer";
                    pool[n] = el;
                }
                n += 1;
                if (el.parentNode !== host) host.appendChild(el);
                const st = el.style;
                st.display = "block";
                st.left = at[0] + "px";
                st.top = at[1] + "px";
                st.width = W + "px";
                st.height = H + "px";
                st.zIndex = below ? "2" : "4";
                low = low || below;
                const clip = item.clip;
                const live = this._editTitleLive;
                const look = live && live.clip === clip ? live.look : D.titleAt(clip, item.u);
                const bw = Math.max(1, Math.round(W * dpr)), bh = Math.max(1, Math.round(H * dpr));
                const sig = JSON.stringify([look, bw, bh, Math.round(w * dpr), Math.round(h * dpr)]);
                if (el._sig !== sig) {
                    if (el.width !== bw) el.width = bw;
                    if (el.height !== bh) el.height = bh;
                    el._sig = sig;
                    el._epFont = paintTitle(el, look, { x: box.x * dpr, y: box.y * dpr, w: w * dpr, h: h * dpr },
                                            () => { el._sig = ""; this._editPlayTitles(); });
                }
                el.dataset.key = item.key;
                el.dataset.font = el._epFont ? el._epFont.family : "";
                // The clip's transform, crop and opacity, as a picture's layer has them.
                const fxLive = this._editFxLive;
                const fx = D.clipFx(fxLive && fxLive.clip === clip ? { fx: fxLive.fx } : clip, item.u);
                let transform = this._epViewerT || "", clipPath = "", op = "";
                if (fx) {
                    const place = D.fxPlace(fx, box);
                    transform = (transform + " " + place.transform).trim();
                    clipPath = place.clip;
                    op = fx.op === 1 ? "" : String(fx.op);
                }
                if (st.transform !== transform) st.transform = transform;
                if (st.clipPath !== clipPath) st.clipPath = clipPath;
                if (st.opacity !== op) st.opacity = op;
            }
        }
        for (let k = n; k < pool.length; k++) if (pool[k].style.display !== "none") { pool[k].style.display = "none"; pool[k]._sig = ""; }
        // A title under the picture: the picture's layer goes above it (put back when there is none).
        if (main && low) { main.style.zIndex = "3"; main._epZTitle = true; }
        for (const el of this._editPlayLayers()) {
            if (!el._epZTitle || (low && el === main)) continue;
            el._epZTitle = false;
            const under = ep && ep.underEl;
            el.style.zIndex = under === el ? "1" : under ? "2" : "";          // as _editPlayUnder has them
        }
    },

    // The film's clock reads this. One window's clock, whichever window the
    // viewer is in: a pop-out's own performance.now() begins at its opening,
    // and a clock that jumped back there would stand still.
    _editPlayNow() {
        return performance.now();
    },

    _editPlayLoad(v, url) {
        v._epUrl = url;
        v._epNext = null;
        // Unlike a clip that is merely looked at (_setVideoSrc), this one is
        // about to be played from a known place: let it buffer.
        v.preload = "auto";
        v.muted = false;
        v.src = url;
    },

    // `v` becomes the picture: at once if its frame is there, else when it is -
    // until then what was up stays up (stopped).
    _editPlayFront(v, old) {
        const keep = () => (this._ep ? this._ep.underEl : null);
        const fps = this.editPlayFps();
        this.videoBase = v;
        this._videoMode = true;
        this._videoKey = null;
        this._videoFps = fps;
        this._videoFrames = 0;
        v.loop = false;
        if (old && old !== v && old !== keep()) { try { old.pause(); } catch (_) {} }
        const wait = (v._epWait = (v._epWait || 0) + 1);
        const reveal = () => {
            if (v._epWait !== wait || !this._editPlayOn || this.videoBase !== v) return true;
            if (v.readyState < 2 || v.seeking) return false;
            v._epWait += 1;
            v.style.display = "block";
            if (old && old !== v && old !== keep()) old.style.display = "none";
            if (this.imgBase && this.imgBase !== keep()) this.imgBase.style.display = "none";
            if (this._epImgB && this._epImgB !== keep()) this._epImgB.style.display = "none";
            if (this.imgFrame) this.imgFrame.style.display = "none";
            if (this.imgCompare) this.imgCompare.style.display = this.isComparing ? "block" : "none";
            this.updateTransform();
            if (this.setImageFilter) this.setImageFilter();
            if (this.applyExposure) this.applyExposure();
            if (this.updateImageFrame) this.updateImageFrame();
            this.updateShapeInfo();
            this._editPlayFitOnce();
            this._editPlayMirror();
            return true;
        };
        if (reveal()) return;
        const again = () => {
            if (!reveal()) return;
            for (const name of ["loadeddata", "seeked", "canplay"]) v.removeEventListener(name, again);
        };
        for (const name of ["loadeddata", "seeked", "canplay"]) v.addEventListener(name, again);
    },

    // What comes after the picture on screen, loaded and sought, in the player
    // that is not showing. A picture is fetched so that it is in the browser's cache.
    _editPlayReady(cut, at, v) {
        if (!v || (v === this.videoBase && this._videoMode)) return;
        if (!(at.end < D.filmLength(cut) - 1e-3)) return;
        const next = D.pictureAt(cut, at.end + 1e-3, this._editPlayLive());
        const clip = next && next.clip;
        if (!clip || next.key === at.key) return;
        const url = this._editPlayUrl ? this._editPlayUrl(clip.file) : this.buildImgUrl({ path: clip.file, external: true }, { noColor: true });
        if (D.isStill(clip.file)) {
            const img = new ((v.ownerDocument.defaultView || window).Image)();
            img.src = url;
            return;
        }
        if (v._epUrl !== url) this._editPlayLoad(v, url);
        const to = Math.max(0, next.local - 1e-3);
        if (Math.abs((v.currentTime || 0) - to) > 1e-3) { try { v.currentTime = to; } catch (_) {} }
        // Started a little before the cut (_editPlayPreroll), as long before as
        // a <video> takes to get going, so that it is at its in point AT the cut.
        const rate = this._editPlayRate(next);
        v._epNext = { key: next.key, end: at.end, stepped: !!next.rev || rate < 0.0625 || rate > 16, rate: Math.max(0.0625, Math.min(16, rate)) };
        if (this._ep) this._ep.nextEl = v;
    },

    // The clip after the cut, made ready in the player that is not showing, is
    // started (silent, unseen) its start-up time before the cut: a <video> runs
    // some 50 ms late after play(), and the clock does not wait for it. How
    // long that is, is learnt per player from the last cut (_epLag).
    _editPlayPreroll(at, t) {
        const ep = this._ep;
        const v = ep && ep.nextEl;
        const n = v && v._epNext;
        if (!n || v === this.videoBase || v === ep.underEl || n.stepped || Math.abs(n.end - at.end) > 1e-6) return;
        if (!v.paused || v.seeking || v.readyState < 3) return;
        const lag = v._epLag != null ? v._epLag : FOLLOW.lag;
        if (t < at.end - lag / Math.max(1e-6, n.rate)) return;
        try {
            v.muted = true;
            v.playbackRate = n.rate;
            v._epPreroll = true;
            const p = v.play(); if (p && p.catch) p.catch(() => {});
        } catch (_) {}
    },

    // What is heard under the picture: the bed and the clips of the sound
    // tracks, each from an <audio> of its own, kept beside the film's clock
    // (followPlan): sought where a clip starts or the film jumps (`jump`), else
    // only nudged - a seek for a little drift plays a stretch twice, on every
    // track at once. Run every 200 ms, every frame with keyed volumes.
    _editPlaySounds(t, playing, jump) {
        const ep = this._ep;
        const cut = this._editPlayCut();
        if (!ep) return;
        if (!ep.bed) ep.bed = [];
        ep.sndAt = this._editPlayNow();
        const items = cut ? D.soundItems(cut, this._editPlayLive()) : [];
        // Volume keys, fades and crossfades: their loudness set every frame.
        ep.keyedSound = items.some((it) => (it.clip && D.keysOf(it.clip, "vol").length) || D.envActive(it.env));
        const doc = (this.container && this.container.ownerDocument) || document;
        const fps = this.editPlayFps();
        const rate = Math.max(0.0625, Math.min(16, (this.fps || fps) / fps));
        items.forEach((item, k) => {
            let a = ep.bed[k];
            if (!a) { a = ep.bed[k] = doc.createElement("audio"); a.preload = "auto"; }
            // A compressed sound from its WAV copy once there is one (imageViewer_editProxy.js).
            const src = this._editPlayUrl ? this._editPlayUrl(item.file) : this.buildImgUrl({ path: item.file, external: true }, { noColor: true });
            if (a._epFile !== item.file || a._epSrc !== src) {
                const at = a._epFile === item.file ? a.currentTime : null;
                a._epFile = item.file;
                a._epSrc = src;
                a.src = src;
                if (at != null) { try { a.currentTime = at; } catch (_) {} }
            }
            try {
                const inside = t >= item.at - 1e-3 && t < item.at + item.length - 1e-3;
                if (!playing || !inside) { a.pause(); return; }
                const clip = item.clip;
                // The clip's own time: from where it begins (`origin`) - a crossfade's handle before it is u < 0.
                const u = t - (item.origin != null ? item.origin : item.at);
                // A retimed or looped sound clip: its source moment, at its speed; a ping-pong's way back is silent.
                if (clip && u >= 0 && D.clipSegment(clip, u).rev) { a.pause(); return; }
                const want = clip ? D.srcAt(clip, u) : item.in + u;
                const speed = clip ? D.speedOf(clip) : 1;
                const nominal = Math.max(0.0625, Math.min(16, rate * speed));
                // Beside the film's clock: sought when it starts or is far off,
                // else its rate nudged - never sought for a little drift, which
                // would play the same stretch twice on every track at once.
                // (A file shorter than its clip has run out: silent till the clip ends, not started again.)
                if (a.ended && a.duration > 0 && want >= a.duration - 0.05) return;
                const now = this._editPlayNow();
                const settling = a.seeking || a.readyState < 3;           // a seek still under way, or waiting for data
                // The film jumped (a seek, a loop going round): to the moment, unless it is there.
                const plan = a.paused || (jump && Math.abs((a.currentTime || 0) - want) > FOLLOW.cut) ? { seek: true, rate: nominal }
                    : followPlan(a.currentTime || 0, want, nominal, settling ? 0 : a._epSought != null ? now - a._epSought : Infinity, speed);
                if (plan.seek) { a.currentTime = want; a._epSought = now; }
                // Volume keys: the sound clip's own time (clipVolume(clip, u)).
                // Fades and crossfades on top (envGain, the render's env_gain).
                const level = clip ? D.clipVolume(clip, Math.max(0, Math.min(Number(clip.length) || 0, u))) : item.volume;
                const vol = Math.max(0, Math.min(1, level * D.envGain(item.env, u))) * (this._editAudioGain ? this._editAudioGain() : 1);
                // Its effects and its track's (WebAudio, imageViewer_editAfxPlay.js), then its loudness.
                if (this._editAfxEnsure) this._editAfxEnsure(a, clip, item.track || "", item.origin != null ? item.origin : item.at);
                this._epVol(a, vol);
                if (Math.abs(a.playbackRate - plan.rate) > 1e-6) a.playbackRate = plan.rate;
                if ("preservesPitch" in a && a.preservesPitch !== (speed === 1)) a.preservesPitch = speed === 1;
                const mute = speed < 0.25 || speed > 4;
                if (a.muted !== mute) a.muted = mute;
                if (a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
            } catch (_) {}
        });
        for (let k = items.length; k < ep.bed.length; k++) { try { ep.bed[k].pause(); } catch (_) {} }
    },

    // ── playing ──────────────────────────────────────────────────────────────

    /**
     * The frames played. In the Trim mode with an edit point selected, the cut is
     * played AROUND (Resolve's play around edit): PLAY_AROUND seconds before it
     * to as many after it, looped - asked anew every frame, so a nudge with , / .
     * while it plays moves the loop with the cut. Held to the film; leaving the
     * Trim mode or the edit point gives the in / out back.
     */
    _editPlayAround() {
        const info = this._editTlTrimMode && this._editTlEditPoint ? this._editTlEditPoint() : null;
        const cut = this._editPlayCut();
        if (!info || !cut) return null;
        const fps = this.editPlayFps();
        const at = Math.round(this._editTlEditTime(info, cut) * fps);
        const bounds = this.getTimelineBounds();
        const pad = Math.round(PLAY_AROUND * fps);
        return { min: Math.max(bounds.min, at - pad), max: Math.min(bounds.max, at + pad - 1), at };
    },

    _editPlayRange() {
        const around = this._editPlayAround();
        if (around) return { min: around.min, max: around.max, around: true };
        const bounds = this.getTimelineBounds();
        let min = bounds.min, max = bounds.max;
        if (this.playbackRange) {
            min = Math.max(min, Math.min(max, this.playbackRange.start));
            max = Math.max(min, Math.min(max, this.playbackRange.end));
        }
        return { min, max };
    },

    /** play() on an Edit tab. */
    editPlayStart() {
        const cut = this._editPlayCut();
        if (!cut || !cut.clips.length || !this._ep) return;
        this.isPlaying = true;
        if (this._eaSilence) this._eaSilence();               // no scrub grains under playback
        this._setIcon(this.playBtn, "icon-pause");
        const { min, max, around } = this._editPlayRange();
        // Outside the range, or standing on its last frame: from its start. Around an edit: from its pre-roll.
        const from = (around || this.currentFrame < min || this.currentFrame >= max) ? min : this.currentFrame;
        if (this.editTwoUpHide) this.editTwoUpHide();          // playing shows the film, not the two-up
        this.editPlaySetFrame(from);
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        const tick = () => {
            if (!this.isPlaying || !this._editPlayOn) return;
            this._editPlayTick();
            if (this.isPlaying && this._ep) this._ep.raf = win.requestAnimationFrame(tick);
        };
        this._ep.win = win;
        this._ep.raf = win.requestAnimationFrame(tick);
    },

    /** stop() on an Edit tab (called for every stop; cheap when nothing plays). */
    editPlayStop() {
        const ep = this._ep;
        if (!ep) return;
        if (ep.raf && ep.win) ep.win.cancelAnimationFrame(ep.raf);
        ep.raf = 0;
        for (const v of this._epSlots || []) { try { v.pause(); } catch (_) {} }
        for (const a of ep.bed || []) { try { a.pause(); } catch (_) {} }
        if (this.editTwoUpRest) this.editTwoUpRest();          // stopped on a cut: its two-up is back
    },

    // One look at the clock while playing: where the film is, whether the clip
    // on screen has run out, whether the range has.
    _editPlayTick() {
        const cut = this._editPlayCut();
        const ep = this._ep;
        if (!cut || !ep || !ep.at) { this.stop(); return; }
        const fps = this.editPlayFps();
        const at = ep.at;
        // The film's clock: the wall clock since the film last jumped (ep.t at
        // ep.wall, set by _editPlayShow), for a film as for a still. Not the
        // clip's own currentTime: that stands still while the next clip starts
        // at a cut, or while a <video> waits for data, and every sound track
        // would be pulled back with it - the same stretch heard twice.
        const now = this._editPlayNow();
        ep.t += Math.max(0, now - ep.wall) / 1000 * ((this.fps || fps) / fps);
        ep.wall = now;
        let t = ep.t;
        if (ep.stepped && !ep.still && this.videoBase && at.clip) {
            // Frame by frame: the film sought to the source moment of each new frame.
            const f = Math.floor(t * fps + 1e-6);
            if (f !== ep.stepFrame) {
                ep.stepFrame = f;
                const local = D.srcLocal(at.clip, (f + 0.5) / fps - at.origin);
                try { this.videoBase.currentTime = local; } catch (_) {}
            }
        } else if (!ep.still && this.videoBase) {
            this._editPlayFollow(this.videoBase, at, t);   // the picture (and its sound) kept beside it
        }
        if (!ep.stepped || ep.still) this._editPlayPreroll(at, t);
        const { min, max, around } = this._editPlayRange();
        const endT = (max + 1) / fps;
        // (The last clip running out is the film running out, whatever the
        // frame count was rounded to.)
        if (t >= endT - 1e-4 || (t >= at.end - 1e-4 && at.end >= D.filmLength(cut) - 1e-3)) {
            if (this.loopMode === "once" && !around) { this.stop(); this.editPlaySetFrame(max); return; }
            t = min / fps;                               // loop and ping-pong both go round
            this._editPlayShow(t, true);
        } else if (t >= at.end - 1e-4) {
            t = Math.max(t, at.end);
            this._editPlayShow(t, false);                // the next clip's turn (the clock runs on: what it is past the cut is kept)
        } else if (this._editPlayNow() - (ep.sndAt || 0) > 200 || ep.keyedSound) {
            this._editPlaySounds(t, true);               // a sound clip whose moment has come (keyed volumes: every frame)
        }
        ep.tNow = t;
        if (this._editAfxTick) this._editAfxTick(t);              // keyed effect params (mix, gain, pan)
        if (ep.at && ep.at.under && !ep.at.over) {
            const now = ep.at;
            this._editPlayMix({ ...now, mix: (t - now.mixStart) / now.mixLen });
        } else if (ep.at && (D.hasKeys(ep.at.clip) || (ep.at.under && D.hasKeys(ep.at.under.clip)))) {
            this._editPlayMirror();                       // keyframes: the look and the loudness of this moment
        } else if (ep.at && ep.envOn) {
            this._editPlayMix(ep.at);                     // a fade or a crossfade: the loudness of this moment
        }
        const frame = Math.max(min, Math.min(max, Math.floor(t * fps + 1e-6)));
        if (frame === this.currentFrame) return;
        this.currentFrame = frame;
        this._editPlayReadout(frame);
        this._editPlayTitles(t);
        this._updateCompareFrame(frame);
        this._toolsFrameChanged();
    },
};
