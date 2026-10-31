// bEpicViewer_editPlay.js
// Playing a cut before it is a film: the Edit tab.
//
// A cut being worked on in the Edit panel (bEpicViewer_editTimeline.js) has a tab
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
// Texts stand on the picture as the render draws them (timeline_render.draw_texts):
// a layer of its own, laid exactly over the picture's rectangle, each text at
// its place and size.
import * as D from "./bEpicViewer_editTimelineData.js";

const PREFIX = "edit:";

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
        // into another; and the layer the texts are written on.
        const doc = home.ownerDocument;
        this._epImgB = doc.createElement("img");
        this._epImgB.className = home.className;
        this._epImgB.style.display = "none";
        this._epImgB.draggable = false;
        home.parentNode.insertBefore(this._epImgB, home);
        this._epTitles = doc.createElement("div");
        this._epTitles.className = "edit-titles";
        this._epTitles.style.display = "none";
        home.parentNode.appendChild(this._epTitles);
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
            const fx = clip ? D.clipFx(live && live.clip === clip ? { fx: live.fx } : clip) : null;
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

    /** A clip's opacity as it is drawn (1 for a clip as it comes), a live Inspector drag included. */
    _editPlayOpacity(clip) {
        const live = this._editFxLive;
        const fx = clip ? D.clipFx(live && live.clip === clip ? { fx: live.fx } : clip) : null;
        return fx ? fx.op : 1;
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
        if (this._epTitles) this._epTitles.style.display = "none";
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
            this._editPlaySounds(at.t, this.isPlaying);
            this._editPlayTitles();
            return;
        }
        const obj = { path: clip.file, external: true, name: clip.name };
        const url = this.buildImgUrl(obj, { noColor: true });
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
            this._editPlaySounds(at.t, this.isPlaying);
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
        if (seek || v !== mine || !same || Math.abs((v.currentTime || 0) - at.local) > 0.08) {
            if (Math.abs((v.currentTime || 0) - at.local) > 1e-3) { try { v.currentTime = at.local; } catch (_) {} }
        }
        const under = this._editPlayUnder(at, v);
        v._epClip = clip;
        this._editPlayFront(v, v === mine ? other : mine);
        this._editPlayMix(at);
        if (this.isPlaying && !ep.stepped) {
            this._editPlaySpeed(v, at);
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
        } else if (ep.stepped) {
            try { v.pause(); } catch (_) {}
        }
        this._editPlaySounds(at.t, this.isPlaying);
        if (!under) this._editPlayReady(cut, at, v === mine ? other : mine);
        this._editPlayMirror();
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
            const url = this.buildImgUrl({ path: u.clip.file, external: true }, { noColor: true });
            if (D.isStill(u.clip.file)) {
                el = main === this.imgBase ? this._epImgB : this.imgBase;
                if (el._epShown !== url) { el._epShown = url; el.src = url; }
                el.style.display = "block";
            } else {
                el = slots.find((s) => s !== main && s._epUrl === url) || slots.find((s) => s !== main);
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
        const own = this._editPlayOpacity(at.clip);
        const show = Math.round(a * own * 1000) / 1000;
        if (main) main.style.opacity = show === 1 && !under ? "" : String(show);
        if (under) under.style.opacity = String(Math.round(this._editPlayOpacity(at.under.clip) * 1000) / 1000);
        const loud = (clip) => Math.max(0, Math.min(1, clip && clip.volume != null ? Number(clip.volume) || 0 : 1));
        try { if (!ep.still && this.videoBase) this.videoBase.volume = loud(at.clip) * a; } catch (_) {}
        try { if (under && under.tagName === "VIDEO") under.volume = at.over ? 0 : loud(at.under.clip) * (1 - a); } catch (_) {}
    },

    // The texts that stand on the picture now. Their layer is laid over the
    // picture's own - it takes the viewer's zoom and pan as the pictures do - and
    // in it a box lies where the untransformed picture does: the frame. With no
    // `t` the moment is the one on screen (the picture moved, not the film).
    _editPlayTitles(t) {
        const box = this._epTitles;
        const ep = this._ep;
        if (!box) return;
        const cut = this._editPlayCut();
        const moment = t != null ? t : (ep ? ((this.currentFrame || 0) + 0.5) / this.editPlayFps() : 0);
        const items = cut && ep ? D.textsAt(cut, moment) : [];
        const main = this._videoMode ? this.videoBase : this.imgBase;
        const size = items.length ? this._displayedMediaSize() : null;
        if (!items.length || !size || !main) {
            if (box.style.display !== "none") { box.style.display = "none"; box._sig = ""; }
            return;
        }
        const W = main.clientWidth, H = main.clientHeight;
        const s = Math.min(W / size.w, H / size.h);
        const w = size.w * s, h = size.h * s;
        // The layer of the texts lies exactly where the picture's layer does (a
        // layer is as large as the viewer lays its picture out, not as large as
        // the viewport), before the viewer's zoom and pan - which it then takes.
        const at = [main.offsetLeft, main.offsetTop];
        const sig = JSON.stringify([items, Math.round(w), Math.round(h), W, H, at, this._epViewerT]);
        if (box._sig === sig) return;
        box._sig = sig;
        box.style.display = "block";
        box.style.left = at[0] + "px";
        box.style.top = at[1] + "px";
        box.style.width = W + "px";
        box.style.height = H + "px";
        box.style.transform = this._epViewerT || "";
        let frame = box.firstChild;
        if (!frame) { frame = box.ownerDocument.createElement("div"); frame.className = "edit-titles-frame"; box.append(frame); }
        frame.style.left = ((W - w) / 2) + "px";
        frame.style.top = ((H - h) / 2) + "px";
        frame.style.width = w + "px";
        frame.style.height = h + "px";
        const doc = box.ownerDocument;
        frame.replaceChildren(...items.map((item) => {
            const d = doc.createElement("div");
            d.className = "edit-title";
            const px = Math.max(2, h * item.size / 100);
            d.style.left = (item.x * 100) + "%";
            d.style.top = (item.y * 100) + "%";
            d.style.fontSize = px + "px";
            d.style.color = item.color;
            d.style.webkitTextStroke = Math.max(0.5, px / 7) + "px #000";
            d.textContent = item.text;
            return d;
        }));
    },

    _editPlayNow() {
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        return win.performance.now();
    },

    _editPlayLoad(v, url) {
        v._epUrl = url;
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
        const url = this.buildImgUrl({ path: clip.file, external: true }, { noColor: true });
        if (D.isStill(clip.file)) {
            const img = new ((v.ownerDocument.defaultView || window).Image)();
            img.src = url;
            return;
        }
        if (v._epUrl !== url) this._editPlayLoad(v, url);
        const to = Math.max(0, next.local - 1e-3);
        if (Math.abs((v.currentTime || 0) - to) > 1e-3) { try { v.currentTime = to; } catch (_) {} }
    },

    // What is heard under the picture: the bed and the clips of the sound
    // tracks, each from an <audio> of its own. They are kept beside the film's
    // clock loosely - an ear forgives a tenth of a second, and seeking on every
    // frame would click.
    _editPlaySounds(t, playing) {
        const ep = this._ep;
        const cut = this._editPlayCut();
        if (!ep) return;
        if (!ep.bed) ep.bed = [];
        ep.sndAt = this._editPlayNow();
        const items = cut ? D.soundItems(cut, this._editPlayLive()) : [];
        const doc = (this.container && this.container.ownerDocument) || document;
        const fps = this.editPlayFps();
        const rate = Math.max(0.0625, Math.min(16, (this.fps || fps) / fps));
        items.forEach((item, k) => {
            let a = ep.bed[k];
            if (!a) { a = ep.bed[k] = doc.createElement("audio"); a.preload = "auto"; }
            if (a._epFile !== item.file) {
                a._epFile = item.file;
                a.src = this.buildImgUrl({ path: item.file, external: true }, { noColor: true });
            }
            try {
                const inside = t >= item.at - 1e-3 && t < item.at + item.length - 1e-3;
                if (!playing || !inside) { a.pause(); return; }
                const clip = item.clip;
                const u = t - item.at;
                // A retimed or looped sound clip: its source moment, at its speed; a ping-pong's way back is silent.
                if (clip && D.clipSegment(clip, u).rev) { a.pause(); return; }
                const want = clip ? D.srcLocal(clip, u) : item.in + u;
                const speed = clip ? D.speedOf(clip) : 1;
                if (a.paused || Math.abs((a.currentTime || 0) - want) > 0.15 * Math.max(1, speed)) a.currentTime = want;
                a.volume = Math.max(0, Math.min(1, item.volume));
                a.playbackRate = Math.max(0.0625, Math.min(16, rate * speed));
                if ("preservesPitch" in a) a.preservesPitch = speed === 1;
                a.muted = speed < 0.25 || speed > 4;
                if (a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
            } catch (_) {}
        });
        for (let k = items.length; k < ep.bed.length; k++) { try { ep.bed[k].pause(); } catch (_) {} }
    },

    // ── playing ──────────────────────────────────────────────────────────────

    _editPlayRange() {
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
        this._setIcon(this.playBtn, "icon-pause");
        const { min, max } = this._editPlayRange();
        // Outside the range, or standing on its last frame: from its start.
        const from = (this.currentFrame < min || this.currentFrame >= max) ? min : this.currentFrame;
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
    },

    // One look at the clock while playing: where the film is, whether the clip
    // on screen has run out, whether the range has.
    _editPlayTick() {
        const cut = this._editPlayCut();
        const ep = this._ep;
        if (!cut || !ep || !ep.at) { this.stop(); return; }
        const fps = this.editPlayFps();
        const at = ep.at;
        let t;
        if (ep.still || ep.stepped) {
            const now = this._editPlayNow();
            ep.t += Math.max(0, now - ep.wall) / 1000 * ((this.fps || fps) / fps);
            ep.wall = now;
            t = ep.t;
            if (ep.stepped && !ep.still && this.videoBase && at.clip) {
                // Frame by frame: the film sought to the source moment of each new frame.
                const f = Math.floor(t * fps + 1e-6);
                if (f !== ep.stepFrame) {
                    ep.stepFrame = f;
                    const local = D.srcLocal(at.clip, (f + 0.5) / fps - at.origin);
                    try { this.videoBase.currentTime = local; } catch (_) {}
                }
            }
        } else {
            const v = this.videoBase;
            // The film's clock is the clip's own: sound and picture cannot part.
            // A retimed clip's runs at its speed; a loop's turn began at segAt.
            const seg = at.segAt != null ? at.segAt : at.origin;
            const base = at.base != null ? at.base : ep.in;
            t = v.ended ? at.end : seg + Math.max(0, (v.currentTime || 0) - base) / (at.speed > 0 ? at.speed : 1);
        }
        const { min, max } = this._editPlayRange();
        const endT = (max + 1) / fps;
        // (The last clip running out is the film running out, whatever the
        // frame count was rounded to.)
        if (t >= endT - 1e-4 || (t >= at.end - 1e-4 && at.end >= D.filmLength(cut) - 1e-3)) {
            if (this.loopMode === "once") { this.stop(); this.editPlaySetFrame(max); return; }
            t = min / fps;                               // loop and ping-pong both go round
            this._editPlayShow(t, true);
        } else if (t >= at.end - 1e-4) {
            t = at.end;
            this._editPlayShow(t, false);                // the next clip's turn
        } else if (this._editPlayNow() - (ep.sndAt || 0) > 200) {
            this._editPlaySounds(t, true);               // a sound clip whose moment has come
        }
        if (ep.at && ep.at.under && !ep.at.over) {
            const now = ep.at;
            this._editPlayMix({ ...now, mix: (t - now.mixStart) / now.mixLen });
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
